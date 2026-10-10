import { createHash, timingSafeEqual } from 'node:crypto';

/** Providers the framework knows. Only `loopback` can be configured in this phase. */
export const PROVIDER_IDS = ['loopback', 'google_calendar', 'github', 'email_inbound'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderDef {
  id: ProviderId;
  label: string;
  /** Phase that configures a real adapter. Loopback is the in-process test double. */
  phase: string;
  scopes: readonly string[];
  /** Why a provider that is not loopback cannot be connected yet. */
  unavailable: string | null;
}

export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: 'loopback',
    label: 'Loopback',
    phase: '6A',
    scopes: ['read', 'write'],
    unavailable: null,
  },
  {
    id: 'google_calendar',
    label: 'Google Calendar',
    phase: '6C',
    scopes: ['calendar.read', 'calendar.write'],
    unavailable: 'Google Calendar is connected in a later phase.',
  },
  {
    id: 'github',
    label: 'GitHub',
    phase: '9A',
    scopes: ['repo.read'],
    unavailable: 'GitHub is connected in a later phase.',
  },
  {
    id: 'email_inbound',
    label: 'Email forwarding',
    phase: '6A',
    scopes: ['inbox.write'],
    unavailable: 'Email forwarding is not decided yet (OD-29).',
  },
];

export const providerById = (id: string): ProviderDef | undefined =>
  PROVIDERS.find((p) => p.id === id);

export type SecretMode = 'ok' | 'degraded' | 'error';
export type SecretKind = 'api_key' | 'oauth' | 'oauth_pending';

/** What the vault holds. Callers must not log, return, or index this value. */
export interface CredentialSecret {
  v: 1;
  kind: SecretKind;
  token: string;
  mode: SecretMode;
  remote: Array<{ type: string; id: string; version: string; title: string }>;
}

const REMOTE_DEFAULT: CredentialSecret['remote'] = [
  { type: 'item', id: 'loopback-1', version: '1', title: 'Loopback item' },
];

export function sealCredential(input: {
  kind: SecretKind;
  token: string;
  mode?: SecretMode;
  remote?: CredentialSecret['remote'];
}): string {
  const body: CredentialSecret = {
    v: 1,
    kind: input.kind,
    token: input.token,
    mode: input.mode ?? 'ok',
    remote: input.remote ?? REMOTE_DEFAULT,
  };
  return JSON.stringify(body);
}

export function openCredential(raw: string | undefined): CredentialSecret | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CredentialSecret>;
    if (v.v !== 1 || (v.kind !== 'api_key' && v.kind !== 'oauth' && v.kind !== 'oauth_pending'))
      return null;
    if (typeof v.token !== 'string' || v.token.length < 8) return null;
    const mode: SecretMode = v.mode === 'degraded' || v.mode === 'error' ? v.mode : 'ok';
    const remote = Array.isArray(v.remote)
      ? v.remote.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const row = item as Record<string, unknown>;
          if (
            typeof row.type !== 'string' ||
            typeof row.id !== 'string' ||
            typeof row.version !== 'string' ||
            typeof row.title !== 'string'
          )
            return [];
          return [{ type: row.type, id: row.id, version: row.version, title: row.title }];
        })
      : REMOTE_DEFAULT;
    return { v: 1, kind: v.kind, token: v.token, mode, remote };
  } catch {
    return null;
  }
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenMatches(stored: string, presented: string): boolean {
  const a = Buffer.from(tokenHash(stored));
  const b = Buffer.from(tokenHash(presented));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Exponential backoff in milliseconds, capped so a retry cannot wait for days. */
export function syncBackoffMs(attempt: number, baseSeconds: number): number {
  const step = Math.min(Math.max(attempt, 1), 8);
  return baseSeconds * 1000 * 2 ** (step - 1);
}

export function scopesAllowed(provider: ProviderDef, requested: readonly string[]): boolean {
  const allowed = new Set(provider.scopes);
  return requested.every((s) => allowed.has(s));
}

export function payloadHash(parts: readonly string[]): string {
  return `sha256:${createHash('sha256').update(parts.join('\n')).digest('hex')}`;
}
