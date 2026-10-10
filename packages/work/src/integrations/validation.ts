import { invalid, issue } from '@pm/tenancy';
import { PROVIDER_IDS, type ProviderId, type SecretMode } from './semantics.ts';

const NAME = /^.{1,120}$/;
const SCOPE = /^[a-z][a-z0-9._]{0,40}$/;
const KEY = /^[A-Za-z0-9._~+/-]{8,200}$/;

function object(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw invalid(issue('', 'invalid_type', 'Expected an object.'));
  return body as Record<string, unknown>;
}

function providerOf(raw: unknown): ProviderId {
  if (typeof raw !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(raw))
    throw invalid(issue('/provider', 'invalid_option', 'Choose a known provider.'));
  return raw as ProviderId;
}

function scopesOf(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max)
    throw invalid(
      issue('/scopes', 'too_many', 'Choose at least one scope, and no more than the limit.'),
    );
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !SCOPE.test(s) || out.includes(s))
      throw invalid(issue('/scopes', 'invalid_option', 'Scopes must be the provider’s own names.'));
    out.push(s);
  }
  return out;
}

function modeOf(raw: unknown): SecretMode | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'ok' || raw === 'degraded' || raw === 'error') return raw;
  throw invalid(issue('/mode', 'invalid_option', 'Mode must be ok, degraded, or error.'));
}

export interface ConnectInput {
  provider: ProviderId;
  authKind: 'oauth' | 'api_key';
  displayName: string;
  scopes: string[];
  brand: string | null;
  apiKey: string | null;
  mode: SecretMode | undefined;
  remoteVersion: string | null;
}

export function parseConnect(body: unknown, scopeMax: number): ConnectInput {
  const o = object(body);
  const auth = o.auth_kind;
  if (auth !== 'oauth' && auth !== 'api_key')
    throw invalid(issue('/auth_kind', 'invalid_option', 'Choose OAuth or an API key.'));
  const name = o.display_name;
  if (typeof name !== 'string' || !NAME.test(name.trim()) || name !== name.trim())
    throw invalid(issue('/display_name', 'invalid', 'Name the connection in plain text.'));
  const brand = o.brand === undefined || o.brand === null ? null : o.brand;
  if (brand !== null && (typeof brand !== 'string' || brand.length < 3))
    throw invalid(
      issue('/brand', 'invalid', 'Name a brand, or leave the connection on the workspace.'),
    );
  const remoteVersion =
    o.remote_version === undefined || o.remote_version === null ? null : o.remote_version;
  if (
    remoteVersion !== null &&
    (typeof remoteVersion !== 'string' || !/^[A-Za-z0-9._~-]{1,80}$/.test(remoteVersion))
  )
    throw invalid(issue('/remote_version', 'invalid', 'The remote version is not usable.'));
  const apiKey = o.api_key === undefined || o.api_key === null ? null : o.api_key;
  if (auth === 'api_key') {
    if (typeof apiKey !== 'string' || !KEY.test(apiKey))
      throw invalid(issue('/api_key', 'invalid', 'The API key is not usable.'));
  } else if (apiKey !== null) {
    throw invalid(issue('/api_key', 'invalid', 'OAuth does not take an API key.'));
  }
  return {
    provider: providerOf(o.provider),
    authKind: auth,
    displayName: name.trim(),
    scopes: scopesOf(o.scopes, scopeMax),
    brand: brand as string | null,
    apiKey: typeof apiKey === 'string' ? apiKey : null,
    mode: modeOf(o.mode),
    remoteVersion: remoteVersion as string | null,
  };
}

export function parseComplete(body: unknown): { code: string } {
  const o = object(body);
  const code = o.code;
  if (typeof code !== 'string' || !KEY.test(code))
    throw invalid(issue('/code', 'invalid', 'The authorization code is not usable.'));
  return { code };
}

export function parseDisconnect(body: unknown): { retention: 'retain' | 'remove' } {
  const o = object(body);
  const retention = o.retention === undefined ? 'retain' : o.retention;
  if (retention !== 'retain' && retention !== 'remove')
    throw invalid(
      issue('/retention', 'invalid_option', 'Choose whether to keep or remove synchronized data.'),
    );
  return { retention };
}

export function parseResolve(body: unknown): {
  resolution: 'kept_local' | 'kept_remote' | 'dismissed';
} {
  const o = object(body);
  const resolution = o.resolution;
  if (resolution !== 'kept_local' && resolution !== 'kept_remote' && resolution !== 'dismissed')
    throw invalid(
      issue(
        '/resolution',
        'invalid_option',
        'Keep the local version, the remote version, or dismiss the conflict.',
      ),
    );
  return { resolution };
}

export function parseLocalEdit(body: unknown): { version: string } {
  const o = object(body);
  const version = o.version;
  if (typeof version !== 'string' || !/^[A-Za-z0-9._~-]{1,80}$/.test(version))
    throw invalid(issue('/version', 'invalid', 'The local version is not usable.'));
  return { version };
}
