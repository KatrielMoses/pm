import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MCP_PROTOCOL_VERSION } from '../integrations/mcp/registry.ts';
import {
  isPrivateAddress,
  signatureHeader,
  signaturesMatch,
  signPayload,
} from '../integrations/semantics.ts';
import type { ConnectorKind } from './config.ts';
import { AGENT_PROTOCOL } from './tool-registry.ts';

/**
 * Phase 8B connector protocol (ADR-0047 D6–D8; 0D PL-54). One handshake, three transports:
 *
 * - `api`: `POST {endpoint}/pm-agent/handshake` with the connector's bearer credential;
 * - `webhook`: a signed `POST {endpoint}` (the 6B signature scheme); the answer must be signed
 *   with the same secret, which proves the peer holds it;
 * - `mcp`: an MCP JSON-RPC `initialize` at the agreed MCP protocol version, carrying the
 *   `pm-agent` manifest in its experimental capabilities.
 *
 * Each sends only protocol metadata and a one-time nonce (never task context, instructions,
 * scope, or assignment data) and expects a bounded `pm-agent/1` manifest that echoes the nonce,
 * names the agent, and lists the registered tools it would call. A handshake proves protocol
 * compatibility only: capabilities are metadata, intersected with the tool registry and the
 * profile's grants by the caller, never authority.
 */
export const SUPPORTED_VERSIONS = ['1'] as const;
export const USER_AGENT = 'pm-agents/1';

export type HandshakeCode =
  | 'invalid_url'
  | 'private_address'
  | 'own_endpoint'
  | 'redirect_refused'
  | 'timeout'
  | 'network'
  | 'unauthorized'
  | 'http_status'
  | 'response_too_large'
  | 'malformed_response'
  | 'protocol_unsupported'
  | 'version_unsupported'
  | 'nonce_mismatch'
  | 'signature_invalid';

export interface Manifest {
  protocol: string;
  version: string;
  agent: { name: string; version: string };
  tools: Array<{ name: string; version: string }>;
}

export type HandshakeResult =
  | { ok: true; manifest: Manifest; status: number }
  | { ok: false; code: HandshakeCode; sent: boolean };

export type ConnectorFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HandshakeOptions {
  nonce: string;
  timeoutMs: number;
  maxBytes: number;
  /** Local and test only: the deterministic fixture peer on a loopback address over HTTP. */
  allowLoopback: boolean;
  /** The product's own public origin: its inbound API and MCP endpoints are never a connector. */
  productOrigin: string | null;
  fetchImpl?: ConnectorFetch;
  now?: () => Date;
}

const LOOPBACK = (a: string) => a === '::1' || a.startsWith('127.');

/**
 * The connector endpoint guard: https (http only to a loopback fixture when allowed), no
 * credentials or unusual ports in the URL, not the product's own origin, and every resolved
 * address public (a loopback fixture only when allowed; private ranges never).
 */
export async function checkEndpoint(
  raw: string,
  opts: Pick<HandshakeOptions, 'allowLoopback' | 'productOrigin'>,
): Promise<
  { ok: true; url: URL } | { ok: false; code: 'invalid_url' | 'private_address' | 'own_endpoint' }
> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'invalid_url' };
  }
  if (url.username || url.password || url.hash) return { ok: false, code: 'invalid_url' };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (opts.productOrigin) {
    try {
      if (new URL(opts.productOrigin).host.toLowerCase() === url.host.toLowerCase())
        return { ok: false, code: 'own_endpoint' };
    } catch {
      // A malformed configured origin matches nothing.
    }
  }
  const loopbackName = host === 'localhost' || host.endsWith('.localhost');
  let addresses: string[];
  try {
    addresses = isIP(host)
      ? [host]
      : loopbackName
        ? ['127.0.0.1']
        : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return { ok: false, code: 'invalid_url' };
  }
  if (!addresses.length) return { ok: false, code: 'invalid_url' };
  const loopback = addresses.every(LOOPBACK);
  for (const a of addresses) {
    if (LOOPBACK(a)) {
      if (!opts.allowLoopback) return { ok: false, code: 'private_address' };
    } else if (isPrivateAddress(a)) return { ok: false, code: 'private_address' };
  }
  if (url.protocol === 'https:') {
    if (url.port && url.port !== '443' && !(loopback && opts.allowLoopback))
      return { ok: false, code: 'invalid_url' };
    return { ok: true, url };
  }
  if (url.protocol === 'http:' && loopback && opts.allowLoopback) return { ok: true, url };
  return { ok: false, code: 'invalid_url' };
}

/** Reads at most `max` bytes of a response body; more is a refusal, never a truncation. */
async function boundedText(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) return null;
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const str = (v: unknown, max: number) => typeof v === 'string' && v.length >= 1 && v.length <= max;

/** Validates a manifest strictly (unknown protocol or version, a wrong nonce, or bad shape). */
export function parseManifest(
  v: unknown,
  nonce: string,
): { ok: true; manifest: Manifest } | { ok: false; code: HandshakeCode } {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    return { ok: false, code: 'malformed_response' };
  const m = v as Record<string, unknown>;
  if (m.protocol !== AGENT_PROTOCOL) return { ok: false, code: 'protocol_unsupported' };
  if (
    typeof m.version !== 'string' ||
    !(SUPPORTED_VERSIONS as readonly string[]).includes(m.version)
  )
    return { ok: false, code: 'version_unsupported' };
  if (m.nonce !== nonce) return { ok: false, code: 'nonce_mismatch' };
  const agent = m.agent as Record<string, unknown> | undefined;
  if (!agent || !str(agent.name, 120) || !str(agent.version, 40))
    return { ok: false, code: 'malformed_response' };
  if (!Array.isArray(m.tools) || m.tools.length > 100)
    return { ok: false, code: 'malformed_response' };
  const tools: Manifest['tools'] = [];
  for (const t of m.tools) {
    const x = t as Record<string, unknown>;
    if (typeof t !== 'object' || t === null || !str(x.name, 80) || !str(x.version, 8))
      return { ok: false, code: 'malformed_response' };
    tools.push({ name: x.name as string, version: x.version as string });
  }
  return {
    ok: true,
    manifest: {
      protocol: m.protocol,
      version: m.version,
      agent: { name: agent.name as string, version: agent.version as string },
      tools,
    },
  };
}

/** Performs one handshake. Never retried here; the caller records the result for one version. */
export async function handshake(
  target: { kind: ConnectorKind; endpoint: string; secret: string },
  opts: HandshakeOptions,
): Promise<HandshakeResult> {
  const guard = await checkEndpoint(target.endpoint, opts);
  if (!guard.ok) return { ok: false, code: guard.code, sent: false };
  const doFetch: ConnectorFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? (() => new Date());
  const issuedAt = now().toISOString();
  let url = guard.url.toString();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
  let body: string;
  let id = '';
  if (target.kind === 'api') {
    url = `${url.replace(/\/+$/, '')}/pm-agent/handshake`;
    headers.authorization = `Bearer ${target.secret}`;
    body = JSON.stringify({
      type: 'handshake',
      protocol: AGENT_PROTOCOL,
      versions: SUPPORTED_VERSIONS,
      nonce: opts.nonce,
      issued_at: issuedAt,
    });
  } else if (target.kind === 'webhook') {
    id = `hs_${opts.nonce}`;
    const ts = String(Math.floor(now().getTime() / 1000));
    body = JSON.stringify({
      type: 'agent.connector.handshake',
      protocol: AGENT_PROTOCOL,
      versions: SUPPORTED_VERSIONS,
      nonce: opts.nonce,
      issued_at: issuedAt,
    });
    headers['webhook-id'] = id;
    headers['webhook-timestamp'] = ts;
    headers['webhook-signature'] = signatureHeader([signPayload(target.secret, id, ts, body)]);
  } else {
    headers.authorization = `Bearer ${target.secret}`;
    body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          experimental: {
            'pm-agent': {
              protocol: AGENT_PROTOCOL,
              versions: SUPPORTED_VERSIONS,
              nonce: opts.nonce,
            },
          },
        },
        clientInfo: { name: 'pm', version: '1' },
      },
    });
  }
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    return {
      ok: false,
      code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      sent: true,
    };
  }
  if (res.status >= 300 && res.status < 400)
    return { ok: false, code: 'redirect_refused', sent: true };
  if (res.status === 401 || res.status === 403)
    return { ok: false, code: 'unauthorized', sent: true };
  if (res.status < 200 || res.status >= 300) return { ok: false, code: 'http_status', sent: true };
  let text: string | null;
  try {
    text = await boundedText(res, opts.maxBytes);
  } catch {
    return { ok: false, code: 'network', sent: true };
  }
  if (text === null) return { ok: false, code: 'response_too_large', sent: true };
  if (target.kind === 'webhook') {
    const sig = res.headers.get('webhook-signature') ?? '';
    const ts = res.headers.get('webhook-timestamp') ?? '';
    const tsN = Number(ts);
    if (
      res.headers.get('webhook-id') !== id ||
      !Number.isInteger(tsN) ||
      Math.abs(now().getTime() / 1000 - tsN) > 300 ||
      !signaturesMatch([target.secret], id, ts, text, sig)
    )
      return { ok: false, code: 'signature_invalid', sent: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'malformed_response', sent: true };
  }
  if (target.kind === 'mcp') {
    const rpc = parsed as Record<string, unknown>;
    const result = rpc?.result as Record<string, unknown> | undefined;
    if (rpc?.jsonrpc !== '2.0' || rpc.id !== 1 || !result)
      return { ok: false, code: 'malformed_response', sent: true };
    if (result.protocolVersion !== MCP_PROTOCOL_VERSION)
      return { ok: false, code: 'version_unsupported', sent: true };
    const exp = (result.capabilities as Record<string, unknown> | undefined)?.experimental as
      Record<string, unknown> | undefined;
    parsed = exp?.['pm-agent'];
    if (parsed === undefined) return { ok: false, code: 'protocol_unsupported', sent: true };
  }
  const m = parseManifest(parsed, opts.nonce);
  return m.ok
    ? { ok: true, manifest: m.manifest, status: res.status }
    : { ok: false, code: m.code, sent: true };
}

/** Refuses a credential that is one of the product's own (a token is not a connector secret). */
export function isOwnCredential(secret: string): boolean {
  return /^(pm|hk|oac|pma|par)_/.test(secret);
}

/**
 * The outcome of one run dispatch (8C, ADR-0048 D7). `sent: false` only when nothing left the
 * product (the guard refused before any request): typed proof of non-dispatch. Once a request
 * may have left, anything but a valid 2xx acknowledgment is `unknown`: a receiver may have acted.
 */
export type DispatchResult =
  | { ok: true; status: number }
  | { ok: false; sent: false; code: HandshakeCode }
  | { ok: false; sent: true; code: HandshakeCode | 'ack_invalid' };

/**
 * Sends one assignment dispatch over the connector's registered transport, under the same guards
 * as the handshake: `POST {endpoint}/pm-agent/runs` (api, bearer), a signed `POST {endpoint}`
 * (webhook; the answer must be signed back), or JSON-RPC `pm-agent/run` (mcp, bearer). The body
 * is built by the caller in memory at send time and never stored.
 */
export async function dispatchRun(
  target: { kind: ConnectorKind; endpoint: string; secret: string },
  dispatch: { id: string; body: Record<string, unknown> },
  opts: Omit<HandshakeOptions, 'nonce'>,
  isAck: (parsed: unknown) => boolean,
): Promise<DispatchResult> {
  const guard = await checkEndpoint(target.endpoint, opts);
  if (!guard.ok) return { ok: false, sent: false, code: guard.code };
  const doFetch: ConnectorFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? (() => new Date());
  let url = guard.url.toString();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
  let body: string;
  const id = `run_${dispatch.id}`;
  if (target.kind === 'api') {
    url = `${url.replace(/\/+$/, '')}/pm-agent/runs`;
    headers.authorization = `Bearer ${target.secret}`;
    body = JSON.stringify(dispatch.body);
  } else if (target.kind === 'webhook') {
    const ts = String(Math.floor(now().getTime() / 1000));
    body = JSON.stringify(dispatch.body);
    headers['webhook-id'] = id;
    headers['webhook-timestamp'] = ts;
    headers['webhook-signature'] = signatureHeader([signPayload(target.secret, id, ts, body)]);
  } else {
    headers.authorization = `Bearer ${target.secret}`;
    body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'pm-agent/run', params: dispatch.body });
  }
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    return {
      ok: false,
      sent: true,
      code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
    };
  }
  if (res.status >= 300 && res.status < 400) return { ok: false, sent: true, code: 'redirect_refused' };
  if (res.status === 401 || res.status === 403) return { ok: false, sent: true, code: 'unauthorized' };
  if (res.status < 200 || res.status >= 300) return { ok: false, sent: true, code: 'http_status' };
  let text: string | null;
  try {
    text = await boundedText(res, opts.maxBytes);
  } catch {
    return { ok: false, sent: true, code: 'network' };
  }
  if (text === null) return { ok: false, sent: true, code: 'response_too_large' };
  if (target.kind === 'webhook') {
    const sig = res.headers.get('webhook-signature') ?? '';
    const ts = res.headers.get('webhook-timestamp') ?? '';
    const tsN = Number(ts);
    if (
      res.headers.get('webhook-id') !== id ||
      !Number.isInteger(tsN) ||
      Math.abs(now().getTime() / 1000 - tsN) > 300 ||
      !signaturesMatch([target.secret], id, ts, text, sig)
    )
      return { ok: false, sent: true, code: 'signature_invalid' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, sent: true, code: 'malformed_response' };
  }
  if (target.kind === 'mcp') {
    const rpc = parsed as Record<string, unknown>;
    if (rpc?.jsonrpc !== '2.0' || rpc.id !== 1) return { ok: false, sent: true, code: 'malformed_response' };
    parsed = rpc.result;
  }
  return isAck(parsed) ? { ok: true, status: res.status } : { ok: false, sent: true, code: 'ack_invalid' };
}
