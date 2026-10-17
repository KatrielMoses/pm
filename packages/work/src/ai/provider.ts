import { MESSAGES_PROTOCOL, validTokens } from './registry.ts';

/**
 * The AI provider boundary (ADR-0038 D1, D3; corrective review 01 §3). An adapter speaks one
 * provider protocol and nothing else: it never sees tenants, principals, records, or the database.
 * The Messages adapter is a plain HTTPS client over the documented `POST /v1/messages` streaming
 * endpoint (API version 2023-06-01), configured per deployment; automated acceptance points the
 * same adapter at the deterministic protocol fixture.
 *
 * The stream is untrusted input. Every event is size-bounded, the whole response is
 * byte-bounded, events must arrive in protocol order, usage must be finite non-negative safe
 * integers, and only the stop reasons the gateway understands count as an answer. Text the
 * gateway discards locally makes the answer truncated, whatever the provider's stop reason. Errors
 * carry a kind, a status, whether the call may have been charged, and any usage known so far;
 * never a response body, a key, or prompt content.
 */

export type AiErrorKind =
  | 'config' // model unknown or request rejected for configuration (never retried)
  | 'auth' // the key is not accepted (never retried)
  | 'rate' // provider rate limit (retried only when the error cannot have been charged)
  | 'transient' // outage or overload answered before any stream
  | 'invalid' // the provider refused the request shape (never retried)
  | 'not_sent' // the connection was refused before the request left: nothing was sent
  | 'outcome_unknown' // sent, but no complete answer: timeout or reset before the stream
  | 'stream_interrupted' // the stream started and ended without its final event
  | 'protocol' // the stream violated the protocol (shape, order, usage, or stop reason)
  | 'stream_overflow' // an event or the whole response exceeded its byte bound
  | 'cancelled'; // closed by the caller; the provider may still bill what it generated

export interface KnownUsage {
  /** Null where the provider gave no valid figure (an unknown remainder). */
  inputTokens: number | null;
  outputTokens: number | null;
}

export class AiProviderError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number;
  readonly retryAfterMs: number | null;
  /** `no`: the provider cannot have billed it. `unknown`: it may have. */
  readonly charged: 'no' | 'unknown';
  readonly partialText: string;
  readonly requestId: string | null;
  /** Valid usage the provider reported before the failure (each part may be unknown). */
  readonly knownUsage: KnownUsage;
  /** The stop reason the provider gave, when the failure is an unsupported one. */
  readonly stopReason: string | null;
  /** For a protocol failure: whether a usage figure was invalid (negative, fractional, unsafe). */
  readonly usageInvalid: boolean;
  constructor(
    kind: AiErrorKind,
    status: number,
    options: {
      retryAfterMs?: number | null;
      charged: 'no' | 'unknown';
      partialText?: string;
      requestId?: string | null;
      knownUsage?: KnownUsage;
      stopReason?: string | null;
      usageInvalid?: boolean;
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
    this.knownUsage = options.knownUsage ?? { inputTokens: null, outputTokens: null };
    this.stopReason = options.stopReason ?? null;
    this.usageInvalid = options.usageInvalid ?? false;
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
  /** Called with each retained text delta (the gateway stops publishing after a cancel). */
  onText?: (delta: string) => void;
}

/** The stop reasons that make an answer; any other one is a protocol failure for this gateway. */
export const SUPPORTED_STOP_REASONS = [
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
] as const;

export interface AiCompletion {
  /**
   * `complete` (end_turn/stop_sequence and nothing discarded locally), `truncated` (max_tokens,
   * or any text discarded locally), or `refused` (refusal).
   */
  outcome: 'complete' | 'truncated' | 'refused';
  text: string;
  stopReason: (typeof SUPPORTED_STOP_REASONS)[number];
  /** True when the gateway kept less text than the provider sent. */
  clipped: boolean;
  usage: { inputTokens: number; outputTokens: number };
  requestId: string | null;
}

export interface AiProvider {
  readonly protocol: typeof MESSAGES_PROTOCOL;
  /** Whether an HTTP error response can be billed (from the attempt's capability snapshot). */
  complete(
    request: AiCompletionRequest,
    errorResponsesChargeable: false | 'unknown',
  ): Promise<AiCompletion>;
}

/** The named stream bounds (0D parameters AI_STREAM_EVENT_MAX_BYTES and siblings). */
export interface MessagesProviderConfig {
  baseUrl: string;
  timeoutMs: number;
  /** Bound on locally retained output text (characters); AI_OUTPUT_MAX_CHARS. */
  maxTextChars: number;
  /** Bound on one buffered server-sent event (bytes); AI_STREAM_EVENT_MAX_BYTES. */
  maxEventBytes: number;
  /** Bound on the whole response body (bytes); AI_STREAM_MAX_BYTES. */
  maxWireBytes: number;
}

type Fetch = typeof fetch;
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']);
const SEPARATOR = /\r?\n\r?\n/;

/** Anthropic Messages API over HTTPS with server-sent events. */
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
    let wireBytes = 0;
    let text = '';
    let clipped = false;
    let started = false;
    let stopped = false;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    /** Only the final (message_delta) output figure is liability; message_start's is preliminary. */
    let finalOutput: number | null = null;
    let stopReason: string | null = null;
    let finished = false;
    const known = (): KnownUsage => ({ inputTokens, outputTokens: finalOutput });
    const fail = (kind: AiErrorKind, usageInvalid = false) =>
      new AiProviderError(kind, res.status, {
        charged: 'unknown',
        partialText: text,
        requestId,
        knownUsage: known(),
        stopReason,
        usageInvalid,
      });
    const onAbort = () => void reader.cancel().catch(() => undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    const handle = (event: Record<string, unknown>) => {
      if (stopped) throw fail('protocol'); // nothing may follow message_stop
      switch (event.type) {
        case 'message_start': {
          if (started) throw fail('protocol');
          const message = asObj(event.message);
          if (typeof message.id !== 'string' || !message.id) throw fail('protocol');
          const usage = asObj(message.usage);
          if (!validTokens(usage.input_tokens)) throw fail('protocol', true);
          inputTokens = usage.input_tokens;
          if (usage.output_tokens !== undefined) {
            if (!validTokens(usage.output_tokens)) throw fail('protocol', true);
            outputTokens = usage.output_tokens;
          }
          started = true;
          return;
        }
        case 'content_block_delta': {
          if (!started) throw fail('protocol');
          const delta = asObj(event.delta);
          if (delta.type !== 'text_delta') return; // thinking and signature deltas carry no answer text
          if (typeof delta.text !== 'string') throw fail('protocol');
          const room = this.#c.maxTextChars - text.length;
          const piece = room > 0 ? delta.text.slice(0, room) : '';
          if (piece.length < delta.text.length) clipped = true;
          if (piece) {
            text += piece;
            req.onText?.(piece);
          }
          return;
        }
        case 'message_delta': {
          if (!started) throw fail('protocol');
          const delta = asObj(event.delta);
          // Usage is validated before the stop reason is accepted: a stop with invalid usage
          // leaves the liability unknown, never "known" from an earlier preliminary figure.
          const usage = asObj(event.usage);
          if (usage.output_tokens !== undefined) {
            if (!validTokens(usage.output_tokens)) throw fail('protocol', true);
            // Cumulative: a smaller figure contradicts an earlier one.
            if (outputTokens !== null && usage.output_tokens < outputTokens)
              throw fail('protocol', true);
            outputTokens = usage.output_tokens;
            finalOutput = usage.output_tokens;
          }
          if (usage.input_tokens !== undefined && usage.input_tokens !== null) {
            if (!validTokens(usage.input_tokens)) throw fail('protocol', true);
            inputTokens = usage.input_tokens;
          }
          if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
            if (typeof delta.stop_reason !== 'string' || stopReason !== null)
              throw fail('protocol');
            stopReason = delta.stop_reason;
          }
          return;
        }
        case 'message_stop':
          if (!started || stopReason === null) throw fail('protocol');
          stopped = true;
          return;
        case 'error':
          // An error after the stream began: the request was accepted; usage is unknown.
          throw fail('stream_interrupted');
        default:
          // ping, content_block_start/stop, and event types added later carry nothing we keep.
          if (!started && event.type !== 'ping') throw fail('protocol');
          return;
      }
    };
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          throw fail(req.signal.aborted ? 'cancelled' : 'stream_interrupted');
        }
        if (req.signal.aborted) throw fail('cancelled');
        if (chunk.done) break;
        wireBytes += chunk.value.byteLength;
        if (wireBytes > this.#c.maxWireBytes) throw fail('stream_overflow');
        buffer += decoder.decode(chunk.value, { stream: true });
        let sep: RegExpExecArray | null;
        while ((sep = SEPARATOR.exec(buffer))) {
          const raw = buffer.slice(0, sep.index);
          buffer = buffer.slice(sep.index + sep[0].length);
          if (Buffer.byteLength(raw, 'utf8') > this.#c.maxEventBytes) throw fail('stream_overflow');
          const data = raw
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          let event: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(data);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
            event = parsed as Record<string, unknown>;
          } catch {
            throw fail('protocol');
          }
          handle(event);
        }
        // An unterminated event may not grow without bound while waiting for its separator.
        if (Buffer.byteLength(buffer, 'utf8') > this.#c.maxEventBytes)
          throw fail('stream_overflow');
      }
      if (buffer.trim()) throw fail('protocol'); // a trailing event without its separator
      if (!stopped || stopReason === null)
        throw fail(req.signal.aborted ? 'cancelled' : 'stream_interrupted');
      if (inputTokens === null || finalOutput === null) throw fail('protocol'); // no final usage
      if (!(SUPPORTED_STOP_REASONS as readonly string[]).includes(stopReason))
        throw fail('protocol');
      finished = true;
      const reason = stopReason as AiCompletion['stopReason'];
      const outcome =
        reason === 'refusal'
          ? 'refused'
          : reason === 'max_tokens' || clipped
            ? 'truncated'
            : 'complete';
      return {
        outcome,
        text,
        stopReason: reason,
        clipped,
        usage: { inputTokens, outputTokens: finalOutput },
        requestId,
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
      // Close the transport on every path that did not read the stream to its end.
      if (!finished) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function safeRequestId(v: string | null): string | null {
  return v && /^[A-Za-z0-9_.:-]{1,200}$/.test(v) ? v : null;
}

/**
 * Maps an HTTP error status to a retry class. Bodies are never read into the error. Whether the
 * error can have been charged comes from the attempt's capability snapshot: `unknown` unless
 * there is specific reviewed evidence (or the synthetic fixture).
 */
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
