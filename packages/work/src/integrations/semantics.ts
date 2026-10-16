import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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
    unavailable: 'Google Calendar is not configured in this environment.',
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
export interface CalendarEventSecret {
  calendar_id: string;
  external_event_id: string;
  version: string;
  title: string;
  starts_at: string;
  ends_at: string;
  event_tz: string;
  all_day?: boolean;
  busy?: boolean;
}

/** Live provider tokens (ADR-0037 G2). Held only inside the vault. */
export interface OAuthGrant {
  access: string;
  refresh: string | null;
  /** Epoch milliseconds. */
  expires_at: number;
  /** Provider scope strings actually granted. */
  scopes: string[];
}

export interface CredentialSecret {
  v: 1;
  kind: SecretKind;
  /** API key, loopback authorization code, or the live OAuth state while pending. */
  token: string;
  mode: SecretMode;
  remote: Array<{ type: string; id: string; version: string; title: string }>;
  events?: CalendarEventSecret[];
  /** PKCE verifier of a pending live authorization. */
  pkce?: string;
  /** Live provider tokens once authorized. */
  oauth?: OAuthGrant;
}

const REMOTE_DEFAULT: CredentialSecret['remote'] = [
  { type: 'item', id: 'loopback-1', version: '1', title: 'Loopback item' },
];

export function sealCredential(input: {
  kind: SecretKind;
  token: string;
  mode?: SecretMode;
  remote?: CredentialSecret['remote'];
  events?: CalendarEventSecret[];
  pkce?: string;
  oauth?: OAuthGrant;
}): string {
  const body: CredentialSecret = {
    v: 1,
    kind: input.kind,
    token: input.token,
    mode: input.mode ?? 'ok',
    remote: input.remote ?? REMOTE_DEFAULT,
    ...(input.events?.length ? { events: input.events } : {}),
    ...(input.pkce ? { pkce: input.pkce } : {}),
    ...(input.oauth ? { oauth: input.oauth } : {}),
  };
  return JSON.stringify(body);
}

const DEFAULT_CALENDAR_EVENTS: CalendarEventSecret[] = [
  {
    calendar_id: 'primary',
    external_event_id: 'gcal-demo-1',
    version: '1',
    title: 'Focus time',
    starts_at: '2030-01-15T14:00:00.000Z',
    ends_at: '2030-01-15T15:00:00.000Z',
    event_tz: 'UTC',
    busy: true,
  },
];

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
          const row = item as unknown as Record<string, unknown>;
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
    const events = Array.isArray(v.events)
      ? v.events.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const row = item as unknown as Record<string, unknown>;
          if (
            typeof row.calendar_id !== 'string' ||
            typeof row.external_event_id !== 'string' ||
            typeof row.version !== 'string' ||
            typeof row.title !== 'string' ||
            typeof row.starts_at !== 'string' ||
            typeof row.ends_at !== 'string' ||
            typeof row.event_tz !== 'string'
          )
            return [];
          return [
            {
              calendar_id: row.calendar_id,
              external_event_id: row.external_event_id,
              version: row.version,
              title: row.title,
              starts_at: row.starts_at,
              ends_at: row.ends_at,
              event_tz: row.event_tz,
              all_day: row.all_day === true,
              busy: row.busy !== false,
            },
          ];
        })
      : undefined;
    const pkce = typeof v.pkce === 'string' && v.pkce.length >= 43 ? v.pkce : undefined;
    const o = v.oauth as Partial<OAuthGrant> | undefined;
    const oauth =
      o &&
      typeof o.access === 'string' &&
      o.access.length > 0 &&
      typeof o.expires_at === 'number' &&
      Array.isArray(o.scopes)
        ? {
            access: o.access,
            refresh: typeof o.refresh === 'string' ? o.refresh : null,
            expires_at: o.expires_at,
            scopes: o.scopes.filter((x): x is string => typeof x === 'string'),
          }
        : undefined;
    return {
      v: 1,
      kind: v.kind,
      token: v.token,
      mode,
      remote,
      events,
      ...(pkce ? { pkce } : {}),
      ...(oauth ? { oauth } : {}),
    };
  } catch {
    return null;
  }
}

export { DEFAULT_CALENDAR_EVENTS };

export function connectionTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function connectionTokenMatches(stored: string, presented: string): boolean {
  const a = Buffer.from(connectionTokenDigest(stored));
  const b = Buffer.from(connectionTokenDigest(presented));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Exponential backoff in milliseconds, capped so a retry cannot wait for days. */
export function syncBackoffMs(attempt: number, baseSeconds: number): number {
  const step = Math.min(Math.max(attempt, 1), 8);
  return baseSeconds * 1000 * 2 ** (step - 1);
}

export function syncScopeAllowsRead(scopes: readonly string[]): boolean {
  return scopes.includes('read') || scopes.includes('calendar.read');
}

export function syncScopeAllowsWrite(scopes: readonly string[]): boolean {
  return scopes.includes('write') || scopes.includes('calendar.write');
}

export function scopesAllowed(provider: ProviderDef, requested: readonly string[]): boolean {
  const allowed = new Set(provider.scopes);
  return requested.every((s) => allowed.has(s));
}

export function payloadHash(parts: readonly string[]): string {
  return `sha256:${createHash('sha256').update(parts.join('\n')).digest('hex')}`;
}

/** Scopes a personal token may carry (0D scope registry, principal `api_token_personal`). */
export const PERSONAL_SCOPES = [
  'records:read',
  'records:write',
  'records:archive',
  'comments:write',
  'shares:manage',
  'time:write',
  'views:read',
  'exports:create',
  'imports:create',
  'tests:ingest',
  'ai:execute',
  'agents:execute',
  'automations:execute',
  'integrations:sync',
  'webhooks:manage',
  'capture:write',
  'audit:read',
  'usage:read',
  'admin:read',
] as const;

/** Scopes a service token may carry (principal `service_principal`). */
export const SERVICE_SCOPES = [
  'records:read',
  'records:write',
  'records:archive',
  'comments:write',
  'views:read',
  'exports:create',
  'imports:create',
  'tests:ingest',
  'automations:execute',
  'integrations:sync',
  'webhooks:manage',
  'audit:read',
  'usage:read',
  'admin:read',
] as const;

export const READ_SCOPES = new Set([
  'records:read',
  'views:read',
  'audit:read',
  'usage:read',
  'admin:read',
]);

/** Internal events that have a public webhook name, and that name. */
export const PUBLIC_WEBHOOKS: Readonly<Record<string, string>> = {
  'core.record.archived': 'record.archived',
  'core.record.trashed': 'record.trashed',
  'core.record.restored': 'record.restored',
  'work.task.created': 'task.created',
  'work.task.updated': 'task.updated',
  'work.task.status_changed': 'task.status_changed',
  'work.task.completed': 'task.completed',
  'work.task.assigned': 'task.assigned',
  'work.project.created': 'project.created',
  'work.project.status_changed': 'project.status_changed',
  'collab.comment.created': 'comment.created',
  'collab.review.requested': 'review.requested',
  'collab.review.decided': 'review.decided',
  'files.deliverable.version_submitted': 'deliverable.submitted',
  'execution.operation.state_changed': 'operation.finished',
  'agents.agent_run.output_returned': 'agent_run.output_returned',
  'quality.test_result.recorded': 'test_result.recorded',
  'quality.defect.verified': 'defect.verified',
  'delivery.release.decided': 'release.decided',
  'delivery.deployment.recorded': 'deployment.recorded',
};

export const PUBLIC_WEBHOOK_NAMES = new Set(Object.values(PUBLIC_WEBHOOKS));

/**
 * Version 1 public field allow-list. Only enums, counts, and categories. Internal identifiers
 * never leave, even when the internal event carries them.
 */
export const ALLOWED_PUBLIC_FIELDS = new Set([
  'record_type',
  'archive_cause',
  'source_kind',
  'to_category',
  'status_category',
  'health',
  'decision',
  'outcome',
  'subject_kind',
  'request_kind',
  'review_state',
  'self_approval',
  'version_number',
  'terminal_reason',
  'waiting_reason',
  'kind',
  'state',
  'method',
  'changed_fields',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Drops anything that is not on the allow-list or that looks like an internal identifier. */
export function publicFacts(
  data: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_PUBLIC_FIELDS.has(key)) continue;
    if (typeof value === 'string') {
      if (UUID.test(value) || value.length > 200) continue;
      out[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (value === null) out[key] = null;
  }
  return out;
}

export function scopeAllows(held: readonly string[], need: string): boolean {
  if (held.includes(need)) return true;
  if (
    need === 'records:read' &&
    (held.includes('records:write') || held.includes('records:archive'))
  )
    return true;
  if (need === 'views:read' && held.includes('records:read')) return true;
  return false;
}

export function writesNeedStepUp(scopes: readonly string[]): boolean {
  return scopes.some((s) => !READ_SCOPES.has(s));
}

/** SHA-256 of the full high-entropy secret. The prefix is not a substitute for the hash. */
export function tokenHash(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/** Compares two hashes without leaking which bytes differed. */
export function hashEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newApiSecret(): { secret: string; prefix: string } {
  const bytes = randomBytes(32);
  let body = '';
  for (const b of bytes) body += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  const secret = `pm_${body}`;
  return { secret, prefix: secret.slice(0, 11) };
}

export function newHookSecret(): { token: string; prefix: string } {
  const bytes = randomBytes(32);
  let body = '';
  for (const b of bytes) body += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  const token = `hk_${body}`;
  return { token, prefix: token.slice(0, 11) };
}

export function newOAuthClientSecret(): { secret: string; prefix: string } {
  const bytes = randomBytes(32);
  let body = '';
  for (const b of bytes) body += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  const secret = `oac_${body}`;
  return { secret, prefix: secret.slice(0, 12) };
}

export function newOAuthAccessSecret(): { secret: string; prefix: string } {
  const bytes = randomBytes(32);
  let body = '';
  for (const b of bytes) body += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  const secret = `pma_${body}`;
  return { secret, prefix: secret.slice(0, 12) };
}

export function signPayload(secret: string, id: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64');
}

export function signatureHeader(signatures: string[]): string {
  return signatures.map((s) => `v1,${s}`).join(' ');
}

/** True when any offered secret produced one of the `v1,` signatures. */
export function signaturesMatch(
  secrets: readonly string[],
  id: string,
  timestamp: string,
  body: string,
  header: string,
): boolean {
  const presented = header
    .split(/\s+/)
    .filter((p) => p.startsWith('v1,'))
    .map((p) => p.slice(3));
  if (!presented.length || !secrets.length) return false;
  const expected = secrets.map((s) => signPayload(s, id, timestamp, body));
  return presented.some((p) => expected.some((e) => safeEqualString(p, e)));
}

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const PRIVATE_V4: Array<[number, number]> = [
  [ip4('0.0.0.0'), 8],
  [ip4('10.0.0.0'), 8],
  [ip4('127.0.0.0'), 8],
  [ip4('169.254.0.0'), 16],
  [ip4('172.16.0.0'), 12],
  [ip4('192.168.0.0'), 16],
  [ip4('100.64.0.0'), 10],
];

function ip4(s: string): number {
  return s.split('.').reduce((a, p) => (a << 8) + Number(p), 0) >>> 0;
}

export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const n = ip4(address);
    return PRIVATE_V4.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  }
  return false;
}

/** HTTPS only. Rejects loopback, link-local, and private answers at configuration and connect time. */
export async function assertPublicHttps(raw: string, allowLoopback: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid_url');
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid_url');
  if (url.port && url.port !== '443') throw new Error('invalid_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    if (!allowLoopback) throw new Error('private_address');
    return url;
  }
  const literal = isIP(host);
  const addresses = literal ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length) throw new Error('invalid_url');
  for (const address of addresses) {
    if (isPrivateAddress(address) && !allowLoopback) throw new Error('private_address');
  }
  return url;
}

export function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Full-jitter exponential backoff capped like jobs (0D). */
export function webhookDelayMs(attempt: number, baseMs: number, capMs: number): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exp);
}

export interface OutboundEnvelope {
  id: string;
  type: string;
  api_version: 'v1';
  created_at: string;
  workspace: { id: string };
  brand?: { id: string };
  data: {
    object: { id: string; type: string; version: number };
    fields: Record<string, string | number | boolean | null>;
    changes: string[];
  };
}
