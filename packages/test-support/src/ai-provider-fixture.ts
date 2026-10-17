import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A deterministic Anthropic Messages API contract fixture (ADR-0038 A9). It is a real HTTP server
 * speaking the subset of the documented protocol the gateway uses: `POST /v1/messages` with
 * `x-api-key` and `anthropic-version: 2023-06-01`, answered as server-sent events (`message_start`
 * with input usage, text deltas, `message_delta` with the stop reason and cumulative output usage,
 * `message_stop`) or as an HTTP error with a `request-id` header.
 *
 * Usage it reports is synthetic. Scenarios are chosen per request by a marker in the user text
 * (`#fixture:<scenario>`), so concurrent tests never share injected failures, or explicitly
 * through the control interface. It exists for automated acceptance only: configuration refuses
 * the fixture provider in deployed environments, and nothing it returns is presented as a real
 * provider result.
 */

export type FixtureScenario =
  | 'ok'
  | 'rate_limit_once'
  | 'overloaded'
  | 'auth'
  | 'not_found'
  | 'slow'
  | 'interrupt'
  | 'truncate'
  | 'refuse'
  | 'hang'
  | 'error_event';

export interface ReceivedRequest {
  model: string;
  maxTokens: number;
  system: string;
  user: string;
  /** sha256 of the key (never the key). */
  keyFingerprint: string;
  scenario: FixtureScenario;
  requestId: string;
}

export interface AiFixtureControl {
  /** The next `count` requests answer `status` before any stream (429 adds Retry-After). */
  failNext(count: number, status: number, retryAfterSeconds?: number): void;
  /** Requests received so far, in order (test inspection of what left the gateway). */
  received(): ReceivedRequest[];
  /** Keys the fixture accepts (fingerprints are reported per request). */
  acceptKeys(keys: string[]): void;
  /** Releases every request parked by the `hang` scenario by destroying its socket. */
  releaseHung(): number;
  reset(): void;
}

export interface AiProviderFixture {
  baseUrl: string;
  /** The deployment key the fixture accepts by default. */
  apiKey: string;
  controlToken: string;
  control: AiFixtureControl;
  /** Environment for a process using the fixture transport. */
  env(): Record<string, string>;
  close(): Promise<void>;
}

export const FIXTURE_MODEL_KEY = 'fixture/synthetic-messages@2026-10-17';

const SCENARIOS: readonly FixtureScenario[] = [
  'ok',
  'rate_limit_once',
  'overloaded',
  'auth',
  'not_found',
  'slow',
  'interrupt',
  'truncate',
  'refuse',
  'hang',
  'error_event',
];

export function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Synthetic token counts: never above the gateway's one-token-per-byte bound. */
function syntheticTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

export async function startAiProviderFixture(
  options: { port?: number } = {},
): Promise<AiProviderFixture> {
  const apiKey = `fixture-${randomBytes(18).toString('base64url')}`;
  const controlToken = randomBytes(24).toString('base64url');
  let accepted = new Set([apiKey]);
  let failQueue: Array<{ status: number; retryAfter?: number }> = [];
  let received: ReceivedRequest[] = [];
  const rateLimited = new Set<string>();
  const hung = new Set<Socket>();
  let seq = 0;

  const control: AiFixtureControl = {
    failNext(count, status, retryAfterSeconds) {
      for (let i = 0; i < count; i++)
        failQueue.push({ status, ...(retryAfterSeconds ? { retryAfter: retryAfterSeconds } : {}) });
    },
    received: () => received.map((r) => ({ ...r })),
    acceptKeys(keys) {
      accepted = new Set([apiKey, ...keys]);
    },
    releaseHung() {
      const n = hung.size;
      for (const s of hung) s.destroy();
      hung.clear();
      return n;
    },
    reset() {
      failQueue = [];
      received = [];
      rateLimited.clear();
      accepted = new Set([apiKey]);
      control.releaseHung();
    },
  };

  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    if (url.pathname.startsWith('/__control/')) {
      if (req.headers['x-control-token'] !== controlToken) return json(res, 403, {});
      const op = url.pathname.slice('/__control/'.length);
      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      if (op === 'fail_next') {
        control.failNext(
          Number(body.count ?? 1),
          Number(body.status ?? 503),
          body.retry_after as number | undefined,
        );
        return json(res, 200, {});
      }
      if (op === 'received') return json(res, 200, { received: control.received() });
      if (op === 'release_hung') return json(res, 200, { released: control.releaseHung() });
      if (op === 'reset') {
        control.reset();
        return json(res, 200, {});
      }
      return json(res, 404, {});
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/messages')
      return json(res, 404, {
        type: 'error',
        error: { type: 'not_found_error', message: 'Not found' },
      });
    seq += 1;
    const requestId = `req_fixture_${String(seq).padStart(8, '0')}`;
    const rid = { 'request-id': requestId };
    const raw = await readBody(req);
    if (req.headers['anthropic-version'] !== '2023-06-01')
      return json(
        res,
        400,
        { type: 'error', error: { type: 'invalid_request_error', message: 'version' } },
        rid,
      );
    const key = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json(
        res,
        400,
        { type: 'error', error: { type: 'invalid_request_error', message: 'json' } },
        rid,
      );
    }
    const messages = Array.isArray(body.messages)
      ? (body.messages as Array<Record<string, unknown>>)
      : [];
    const user = typeof messages[0]?.content === 'string' ? (messages[0].content as string) : '';
    const system = typeof body.system === 'string' ? body.system : '';
    const marker = /#fixture:([a-z_]+)/.exec(user)?.[1] as FixtureScenario | undefined;
    const scenario: FixtureScenario = marker && SCENARIOS.includes(marker) ? marker : 'ok';
    const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 0;
    received.push({
      model: String(body.model ?? ''),
      maxTokens,
      system,
      user,
      keyFingerprint: fingerprint(key),
      scenario,
      requestId,
    });
    if (!accepted.has(key) || scenario === 'auth')
      return json(
        res,
        401,
        { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        rid,
      );
    if (body.model !== 'synthetic-messages' || scenario === 'not_found')
      return json(
        res,
        404,
        { type: 'error', error: { type: 'not_found_error', message: 'model' } },
        rid,
      );
    if (body.stream !== true || maxTokens < 1 || messages.length !== 1)
      return json(
        res,
        400,
        { type: 'error', error: { type: 'invalid_request_error', message: 'shape' } },
        rid,
      );
    const injected = failQueue.shift();
    if (injected)
      return json(
        res,
        injected.status,
        {
          type: 'error',
          error: {
            type: injected.status === 429 ? 'rate_limit_error' : 'api_error',
            message: 'injected',
          },
        },
        {
          ...rid,
          ...(injected.retryAfter ? { 'retry-after': String(injected.retryAfter) } : {}),
        },
      );
    const promptKey = createHash('sha256').update(user).digest('hex');
    if (scenario === 'rate_limit_once' && !rateLimited.has(promptKey)) {
      rateLimited.add(promptKey);
      return json(
        res,
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
        { ...rid, 'retry-after': '1' },
      );
    }
    if (scenario === 'overloaded')
      return json(
        res,
        529,
        { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } },
        rid,
      );
    if (scenario === 'hang') {
      hung.add(req.socket);
      req.socket.on('close', () => hung.delete(req.socket));
      return; // never answers
    }

    const inputTokens = syntheticTokens(system) + syntheticTokens(user) + 8;
    const reply = `Synthetic fixture reply (no provider was called) to a ${user.length}-character prompt.`;
    const words =
      scenario === 'slow'
        ? Array.from({ length: 40 }, (_, i) => `part ${i + 1}. `)
        : reply.split(/(?<= )/);
    const outputLimit = scenario === 'truncate' ? Math.min(maxTokens, 3) : maxTokens;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      ...rid,
    });
    const send = (type: string, data: Record<string, unknown>) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', {
      message: {
        id: `msg_fixture_${seq}`,
        type: 'message',
        role: 'assistant',
        model: 'synthetic-messages',
        content: [],
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      },
    });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    let out = 0;
    let closed = false;
    res.on('close', () => (closed = true));
    for (const [i, w] of words.entries()) {
      if (closed) return;
      if (out >= outputLimit) break;
      if (scenario === 'interrupt' && i === 2) {
        // Let the deltas already written reach the client, then cut the connection mid-stream.
        await sleep(100);
        req.socket.destroy();
        return;
      }
      if (scenario === 'error_event' && i === 1) {
        send('error', { error: { type: 'overloaded_error', message: 'Overloaded' } });
        res.end();
        return;
      }
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: w } });
      out += syntheticTokens(w);
      if (scenario === 'slow') await sleep(250);
    }
    if (closed) return;
    send('content_block_stop', { index: 0 });
    const stop =
      scenario === 'truncate' ? 'max_tokens' : scenario === 'refuse' ? 'refusal' : 'end_turn';
    send('message_delta', {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: Math.min(out, maxTokens) },
    });
    send('message_stop', {});
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    apiKey,
    controlToken,
    control,
    env: () => ({
      AI_PROVIDER: 'fixture',
      AI_PROVIDER_BASE_URL: baseUrl,
      AI_PROVIDER_API_KEY: apiKey,
      AI_PROVIDER_TIMEOUT_MS: '5000',
    }),
    close: () =>
      new Promise<void>((resolve) => {
        control.releaseHung();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Drives an AI fixture's control interface from another process (a browser test). */
export function aiFixtureClient(baseUrl: string, token: string) {
  const call = async (op: string, body: Record<string, unknown> = {}) => {
    const r = await fetch(`${baseUrl}/__control/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-control-token': token },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`ai fixture control ${op} failed (${r.status})`);
    return (await r.json()) as Record<string, unknown>;
  };
  return {
    failNext: (count: number, status: number, retryAfter?: number) =>
      call('fail_next', { count, status, ...(retryAfter ? { retry_after: retryAfter } : {}) }),
    received: async () => (await call('received')).received as ReceivedRequest[],
    releaseHung: () => call('release_hung'),
    reset: () => call('reset'),
  };
}
