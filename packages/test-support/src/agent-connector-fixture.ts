import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
  options: { port?: number } = {},
): Promise<AgentConnectorFixture> {
  const controlToken = randomBytes(24).toString('base64url');
  const peers = new Map<string, ConnectorFixturePeer>();
  let received: ConnectorFixtureRequest[] = [];

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
      const m = /^\/peer\/([a-z0-9-]{1,64})(\/pm-agent\/handshake)?$/.exec(url.pathname);
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
    reset() {
      received = [];
      peers.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
