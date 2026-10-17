import { MESSAGES_PROTOCOL } from './registry.ts';

/**
 * The AI provider boundary (ADR-0038 A1, A3). An adapter speaks one provider protocol and nothing
 * else: it never sees tenants, principals, records, or the database. The Messages adapter is a
 * plain HTTPS client over the documented `POST /v1/messages` streaming endpoint (API version
 * 2023-06-01), configured per deployment; automated acceptance points the same adapter at the
 * deterministic protocol fixture. Errors carry a kind, a status, and whether the call may have
 * been charged; never a response body, a key, or prompt content.
 */

export type AiErrorKind =
  | 'config' // model unknown or request rejected for configuration (never retried)
  | 'auth' // the key is not accepted (never retried)
  | 'rate' // provider rate limit (retry later)
  | 'transient' // outage or overload answered before any stream (retry with backoff)
  | 'invalid' // the provider refused the request shape (never retried)
  | 'not_sent' // the connection was refused before the request left: nothing was sent
  | 'outcome_unknown' // sent, but no complete answer: timeout or reset before the stream
  | 'stream_interrupted' // the stream started and ended without its final event
  | 'cancelled'; // closed by the caller; the provider may still bill what it generated

export class AiProviderError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number;
  readonly retryAfterMs: number | null;
  /** `no`: the provider cannot have billed it. `unknown`: it may have. */
  readonly charged: 'no' | 'unknown';
  readonly partialText: string;
  readonly requestId: string | null;
  constructor(
    kind: AiErrorKind,
    status: number,
    options: {
      retryAfterMs?: number | null;
      charged: 'no' | 'unknown';
      partialText?: string;
      requestId?: string | null;
    },
  ) {
    super(`ai provider ${kind} (${status})`);
    this.name = 'AiProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.charged = options.charged;
    this.partialText = options.partialText ?? '';
    this.requestId = options.requestId ?? null;
  }
}

export interface AiCompletionRequest {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  /** Read lazily so the key is never copied into a long-lived object graph. */
  apiKey: () => string;
  signal: AbortSignal;
  /** Called with each text delta (the gateway stops publishing after a cancel). */
  onText?: (delta: string) => void;
}

export interface AiCompletion {
  /** `complete` (end_turn/stop_sequence), `truncated` (max_tokens), or `refused` (refusal). */
  outcome: 'complete' | 'truncated' | 'refused';
  text: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
  requestId: string | null;
}

export interface AiProvider {
  readonly protocol: typeof MESSAGES_PROTOCOL;
  /** Whether an HTTP error response can be billed (from the model's registered capability). */
  complete(
    request: AiCompletionRequest,
    errorResponsesChargeable: false | 'unknown',
  ): Promise<AiCompletion>;
}

export interface MessagesProviderConfig {
  baseUrl: string;
  timeoutMs: number;
  /** Bound on locally retained output text (characters). */
  maxTextChars: number;
}

type Fetch = typeof fetch;
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']);

/** Anthropic Messages API over HTTPS with server-sent events (ADR-0038 A3). */
export class MessagesProvider implements AiProvider {
  readonly protocol = MESSAGES_PROTOCOL;
  readonly #c: MessagesProviderConfig;
  readonly #fetch: Fetch;

  constructor(config: MessagesProviderConfig, fetchImpl: Fetch = fetch) {
    this.#c = config;
    this.#fetch = fetchImpl;
  }

  async complete(
    req: AiCompletionRequest,
    errorResponsesChargeable: false | 'unknown',
  ): Promise<AiCompletion> {
    const timeout = AbortSignal.timeout(this.#c.timeoutMs);
    const signal = AbortSignal.any([req.signal, timeout]);
    const body = JSON.stringify({
      model: req.model,
      max_tokens: req.maxOutputTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      stream: true,
    });
    let res: Response;
    try {
      res = await this.#fetch(`${this.#c.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': req.apiKey(),
        },
        body,
        redirect: 'error',
        signal,
      });
    } catch (err) {
      if (req.signal.aborted) throw new AiProviderError('cancelled', 0, { charged: 'unknown' });
      const code = (err as { cause?: { code?: unknown } }).cause?.code;
      if (typeof code === 'string' && NOT_SENT_CODES.has(code))
        throw new AiProviderError('not_sent', 0, { charged: 'no' });
      // A timeout or reset after the request may have left: the outcome is unknown.
      throw new AiProviderError('outcome_unknown', 0, { charged: 'unknown' });
    }
    const requestId = safeRequestId(res.headers.get('request-id'));
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw classifyStatus(res.status, res.headers, requestId, errorResponsesChargeable);
    }
    return this.#readStream(res, req, signal, requestId);
  }

  async #readStream(
    res: Response,
    req: AiCompletionRequest,
    signal: AbortSignal,
    requestId: string | null,
  ): Promise<AiCompletion> {
    const reader = res.body?.getReader();
    if (!reader)
      throw new AiProviderError('stream_interrupted', res.status, {
        charged: 'unknown',
        requestId,
      });
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let stopReason: string | null = null;
    let stopped = false;
    const fail = (kind: AiErrorKind) =>
      new AiProviderError(kind, res.status, { charged: 'unknown', partialText: text, requestId });
    const onAbort = () => void reader.cancel().catch(() => undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!stopped) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          throw fail(req.signal.aborted ? 'cancelled' : 'stream_interrupted');
        }
        if (req.signal.aborted) throw fail('cancelled');
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        // Events are separated by a blank line; a partial event stays buffered.
        let sep: number;
        while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
          const data = raw
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          let event: Record<string, unknown>;
          try {
            event = asObj(JSON.parse(data));
          } catch {
            throw fail('stream_interrupted');
          }
          switch (event.type) {
            case 'message_start': {
              const usage = asObj(asObj(event.message).usage);
              if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
              if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
              break;
            }
            case 'content_block_delta': {
              const delta = asObj(event.delta);
              if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                const room = this.#c.maxTextChars - text.length;
                const piece = room > 0 ? delta.text.slice(0, room) : '';
                if (piece) {
                  text += piece;
                  req.onText?.(piece);
                }
              }
              break;
            }
            case 'message_delta': {
              const delta = asObj(event.delta);
              if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
              const usage = asObj(event.usage);
              // Usage on message_delta is cumulative.
              if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
              if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
              break;
            }
            case 'message_stop':
              stopped = true;
              break;
            case 'error':
              // An error after the stream began: the request was accepted; usage is unknown.
              throw fail('stream_interrupted');
            default:
              // ping, content_block_start/stop, thinking deltas: nothing to keep.
              break;
          }
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (!stopped || stopReason === null || inputTokens === null || outputTokens === null)
      throw fail(req.signal.aborted ? 'cancelled' : 'stream_interrupted');
    const outcome =
      stopReason === 'max_tokens' ? 'truncated' : stopReason === 'refusal' ? 'refused' : 'complete';
    return {
      outcome,
      text,
      stopReason,
      usage: { inputTokens, outputTokens },
      requestId,
    };
  }
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function safeRequestId(v: string | null): string | null {
  return v && /^[A-Za-z0-9_.:-]{1,200}$/.test(v) ? v : null;
}

/** Maps an HTTP error status to a retry class. Bodies are never read into the error. */
export function classifyStatus(
  status: number,
  headers: Headers,
  requestId: string | null,
  errorResponsesChargeable: false | 'unknown',
): AiProviderError {
  const retry = Number(headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) * 1000 : null;
  const charged = errorResponsesChargeable === false ? 'no' : 'unknown';
  const o = { charged, requestId } as const;
  if (status === 401 || status === 403) return new AiProviderError('auth', status, o);
  if (status === 404) return new AiProviderError('config', status, o);
  if (status === 429) return new AiProviderError('rate', status, { ...o, retryAfterMs });
  if (status === 408 || status >= 500)
    return new AiProviderError('transient', status, { ...o, retryAfterMs });
  return new AiProviderError('invalid', status, o);
}
