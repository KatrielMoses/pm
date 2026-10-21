import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Phase 8B deterministic agent connector peers (synthetic; never a real agent). One local HTTP
 * server hosts named peers at `/peer/{name}` for each connector kind:
 *
 * - `api`: `POST /peer/{name}/pm-agent/handshake` with `Authorization: Bearer {secret}`;
 * - `webhook`: `POST /peer/{name}` signed with the 6B scheme; the answer is signed back;
 * - `mcp`: JSON-RPC `initialize` at MCP protocol `2025-11-25`, the manifest in experimental
 *   capabilities.
 *
 * A peer checks the caller's credential or signature for real and answers a `pm-agent/1`
 * manifest echoing the nonce, or misbehaves on purpose (`behaviour`). Every request is recorded so
 * tests prove what reached the peer (only protocol metadata and a nonce). Tests in other
 * processes (the browser suite) configure peers through `POST /control/peers` with the token.
 */
export type ConnectorFixtureBehaviour =
  | 'ok'
  | 'bad_signature'
  | 'old_version'
  | 'unknown_protocol'
  | 'nonce_mismatch'
  | 'huge'
  | 'redirect'
  | 'malformed'
  | 'status_500'
  | 'slow'
  | 'mcp_old_protocol';

export interface ConnectorFixturePeer {
  kind: 'api' | 'webhook' | 'mcp';
  secret: string;
  behaviour?: ConnectorFixtureBehaviour;
  tools?: Array<{ name: string; version: string }>;
  /**
   * 8C run dispatch: `ack` only acknowledges (the test drives callbacks itself); `complete` and
   * `fail` acknowledge, then work through the product's callbacks with the run credential
   * (progress, a scoped read, a draft artifact, the final result); `mutate` also attempts a
   * write tool; `reject` answers 400 and `error` 500 after receipt (an unknown outcome).
   */
  run?: 'ack' | 'complete' | 'fail' | 'mutate' | 'reject' | 'error';
}

/** One dispatch the fixture received, and what its scripted agent got back from the product. */
export interface FixtureDispatch {
  peer: string;
  body: Record<string, unknown>;
  calls: Array<{ step: string; status: number; body: unknown }>;
}

export interface ConnectorFixtureRequest {
  peer: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface AgentConnectorFixture {
  baseUrl: string;
  controlToken: string;
  /** The endpoint URL to configure for a peer (its kind decides the path the client appends). */
  endpoint(name: string): string;
  peer(name: string, peer: ConnectorFixturePeer): void;
  received(): ConnectorFixtureRequest[];
  /** 8C: dispatches received (with the credential) and the scripted agent's call results. */
  dispatches(): FixtureDispatch[];
  /** Resolves when every scripted agent started so far has finished its callbacks. */
  settled(): Promise<void>;
  reset(): void;
  close(): Promise<void>;
}

const MCP_VERSION = '2025-11-25';

const sign = (secret: string, id: string, ts: string, body: string) =>
  createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64');

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function startAgentConnectorFixture(
  options: {
    port?: number;
    /** In-process tests: how the scripted agent reaches the product (default: global fetch). */
    callback?: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; body: unknown }>;
  } = {},
): Promise<AgentConnectorFixture> {
  const controlToken = randomBytes(24).toString('base64url');
  const peers = new Map<string, ConnectorFixturePeer>();
  let received: ConnectorFixtureRequest[] = [];
  let dispatches: FixtureDispatch[] = [];
  const pending = new Set<Promise<void>>();
  const call =
    options.callback ??
    (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      const r = await fetch(url, init);
      let out: unknown = null;
      try {
        out = await r.json();
      } catch {
        out = null;
      }
      return { status: r.status, body: out };
    });

  /** The scripted agent: works only through the callbacks and the credential it was sent. */
  const work = async (d: FixtureDispatch, peer: ConnectorFixturePeer) => {
    const cb = d.body.callback as Record<string, string>;
    const token = (d.body.credential as { token: string }).token;
    const run = d.body.run as { id: string; attempt: number };
    const task = d.body.task as { id: string; title: string };
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' };
    const post = async (step: string, url: string, body: unknown) => {
      const r = await call(url, { method: 'POST', headers, body: JSON.stringify(body) });
      d.calls.push({ step, status: r.status, body: r.body });
      return r;
    };
    await post('progress', cb.events!, { key: `p-${run.attempt}`, kind: 'progress', text: 'Started reading the task.', percent: 10 });
    await post('commentary', cb.events!, { key: `c-${run.attempt}`, kind: 'commentary', text: 'Done! The task is complete.' });
    if (peer.kind === 'mcp') {
      const r = await call(cb.mcp!, {
        method: 'POST',
        headers: { ...headers, accept: 'application/json, text/event-stream', 'mcp-protocol-version': MCP_VERSION },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pm.tasks.get', arguments: { task: task.id }, _meta: { idempotencyKey: `read-${run.attempt}-0001` } } }),
      });
      d.calls.push({ step: 'read', status: r.status, body: r.body });
    } else await post('read', cb.tools!, { key: `read-${run.attempt}`, tool: 'pm.tasks.get', version: '1', arguments: { task: task.id } });
    if (peer.run === 'mutate')
      await post('write', cb.tools!, { key: `write-${run.attempt}`, tool: 'pm.tasks.update', version: '1', arguments: { task: task.id, fields: { title: 'Changed by the agent' } } });
    const content = `# Notes for ${task.title}\n\nDrafted by the synthetic fixture agent.`;
    const sha = createHash('sha256').update(content).digest('hex');
    await post('artifact', cb.artifacts!, { key: 'notes', title: 'Notes', media_type: 'text/markdown', content, sha256: sha });
    await post('result', cb.result!, {
      key: `result-${run.attempt}`,
      attempt: run.attempt,
      status: peer.run === 'fail' ? 'failed' : 'completed',
      summary: peer.run === 'fail' ? 'The fixture agent could not finish.' : 'Notes drafted for review.',
      artifacts: ['notes'],
      reported_cost: { amount_micros: 1200, currency: 'USD' },
    });
  };

  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 1_048_576) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  const send = (
    res: ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body);
  };

  const manifest = (peer: ConnectorFixturePeer, nonce: string) => ({
    protocol: peer.behaviour === 'unknown_protocol' ? 'other-agent/9' : 'pm-agent/1',
    version: peer.behaviour === 'old_version' ? '0' : '1',
    nonce: peer.behaviour === 'nonce_mismatch' ? `${nonce}x` : nonce,
    agent: { name: 'Synthetic fixture agent', version: '1' },
    tools: peer.tools ?? [{ name: 'pm.tasks.get', version: '1' }],
  });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = await read(req);
      if (url.pathname === '/control/peers' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${controlToken}`) return send(res, 401, '{}');
        const { name, peer } = JSON.parse(body) as { name: string; peer: ConnectorFixturePeer };
        peers.set(name, peer);
        return send(res, 204, '');
      }
      if (url.pathname === '/control/received' && req.method === 'GET') {
        if (req.headers.authorization !== `Bearer ${controlToken}`) return send(res, 401, '{}');
        return send(res, 200, JSON.stringify(received));
      }
      if (url.pathname === '/control/dispatches' && req.method === 'GET') {
        if (req.headers.authorization !== `Bearer ${controlToken}`) return send(res, 401, '{}');
        return send(res, 200, JSON.stringify(dispatches));
      }
      const m = /^\/peer\/([a-z0-9-]{1,64})(\/pm-agent\/handshake|\/pm-agent\/runs)?$/.exec(url.pathname);
      const name = m?.[1];
      const peer = name ? peers.get(name) : undefined;
      if (!peer || !name || req.method !== 'POST') return send(res, 404, '{}');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      received.push({ peer: name, path: url.pathname, headers, body });
      if (peer.behaviour === 'slow') await new Promise((r) => setTimeout(r, 30_000));
      if (peer.behaviour === 'redirect')
        return send(res, 302, '', { location: 'http://127.0.0.1:1/elsewhere' });
      if (peer.behaviour === 'status_500') return send(res, 500, '{"error":"synthetic"}');
      if (peer.behaviour === 'malformed') return send(res, 200, 'not json at all');
      if (peer.behaviour === 'huge')
        return send(res, 200, JSON.stringify({ padding: 'x'.repeat(2_000_000) }));
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return send(res, 400, '{}');
      }
      // 8C: an assignment dispatch (api path, signed webhook type, or MCP method).
      const isDispatch =
        (peer.kind === 'api' && m?.[2] === '/pm-agent/runs') ||
        (peer.kind === 'webhook' && parsed.type === 'agent.run.dispatch') ||
        (peer.kind === 'mcp' && parsed.method === 'pm-agent/run');
      if (isDispatch) {
        if (peer.kind === 'webhook') {
          const offered = (headers['webhook-signature'] ?? '').split(' ').map((s) => s.replace(/^v1,/, ''));
          if (!offered.some((s) => sameSecret(s, sign(peer.secret, headers['webhook-id'] ?? '', headers['webhook-timestamp'] ?? '', body))))
            return send(res, 401, '{}');
        } else if (!sameSecret(headers.authorization ?? '', `Bearer ${peer.secret}`)) return send(res, 401, '{}');
        const payload = (peer.kind === 'mcp' ? parsed.params : parsed) as Record<string, unknown>;
        const d: FixtureDispatch = { peer: name, body: payload, calls: [] };
        dispatches.push(d);
        if (peer.run === 'reject') return send(res, 400, '{"error":"synthetic rejection"}');
        if (peer.run === 'error') return send(res, 500, '{"error":"synthetic"}');
        const ack = JSON.stringify({ type: 'agent.run.ack', dispatch_id: payload.dispatch_id, accepted: true });
        const out = peer.kind === 'mcp' ? JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: JSON.parse(ack) }) : ack;
        if (peer.kind === 'webhook') {
          const rts = String(Math.floor(Date.now() / 1000));
          const id = headers['webhook-id'] ?? '';
          send(res, 200, out, { 'webhook-id': id, 'webhook-timestamp': rts, 'webhook-signature': `v1,${sign(peer.secret, id, rts, out)}` });
        } else send(res, 200, out);
        if (peer.run && peer.run !== 'ack') {
          const job = new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => work(d, peer)).catch(() => undefined);
          pending.add(job);
          void job.finally(() => pending.delete(job));
        }
        return;
      }
      if (peer.kind === 'api') {
        if (m?.[2] !== '/pm-agent/handshake') return send(res, 404, '{}');
        if (!sameSecret(headers.authorization ?? '', `Bearer ${peer.secret}`))
          return send(res, 401, '{}');
        return send(res, 200, JSON.stringify(manifest(peer, String(parsed.nonce))));
      }
      if (peer.kind === 'webhook') {
        const id = headers['webhook-id'] ?? '';
        const ts = headers['webhook-timestamp'] ?? '';
        const offered = (headers['webhook-signature'] ?? '')
          .split(' ')
          .map((s) => s.replace(/^v1,/, ''));
        if (!offered.some((s) => sameSecret(s, sign(peer.secret, id, ts, body))))
          return send(res, 401, '{}');
        const out = JSON.stringify(manifest(peer, String(parsed.nonce)));
        const rts = String(Math.floor(Date.now() / 1000));
        const signature =
          peer.behaviour === 'bad_signature'
            ? sign('wrong-secret', id, rts, out)
            : sign(peer.secret, id, rts, out);
        return send(res, 200, out, {
          'webhook-id': id,
          'webhook-timestamp': rts,
          'webhook-signature': `v1,${signature}`,
        });
      }
      // MCP JSON-RPC initialize.
      if (!sameSecret(headers.authorization ?? '', `Bearer ${peer.secret}`))
        return send(res, 401, '{}');
      if (parsed.method !== 'initialize')
        return send(
          res,
          200,
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id ?? null,
            error: { code: -32601, message: 'method not found' },
          }),
        );
      const params = parsed.params as
        { capabilities?: { experimental?: Record<string, { nonce?: string }> } } | undefined;
      const nonce = String(params?.capabilities?.experimental?.['pm-agent']?.nonce ?? '');
      return send(
        res,
        200,
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: {
            protocolVersion: peer.behaviour === 'mcp_old_protocol' ? '2024-11-05' : MCP_VERSION,
            serverInfo: { name: 'synthetic-mcp-agent', version: '1' },
            capabilities: { experimental: { 'pm-agent': manifest(peer, nonce) } },
          },
        }),
      );
    })().catch(() => {
      if (!res.headersSent) send(res, 500, '{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    controlToken,
    endpoint: (name) => `${baseUrl}/peer/${name}`,
    peer: (name, peer) => peers.set(name, peer),
    received: () => received.map((r) => ({ ...r, headers: { ...r.headers } })),
    dispatches: () => dispatches.map((d) => ({ ...d, calls: [...d.calls] })),
    settled: async () => {
      while (pending.size) await Promise.all([...pending]);
    },
    reset() {
      received = [];
      dispatches = [];
      peers.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
