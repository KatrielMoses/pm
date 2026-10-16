import { createHash, randomBytes } from 'node:crypto';

/**
 * The calendar provider boundary (ADR-0037 G1–G4). A provider adapter speaks the provider's own
 * protocol and nothing else: it never sees tenants, principals, records, or the database. The
 * Google adapter is a plain HTTPS client over the documented OAuth 2.0 and Calendar v3 endpoints,
 * configured per deployment. Automated acceptance points the same adapter at a deterministic HTTP
 * fixture; nothing here simulates success.
 *
 * Errors carry only a kind and an HTTP status. Response bodies, tokens, and event content never
 * reach an error message, a log line, or an audit change.
 */

/** Internal connection scopes and the provider scopes they need (least privilege). */
export const GOOGLE_SCOPES: Readonly<Record<string, string>> = {
  'calendar.read': 'https://www.googleapis.com/auth/calendar.readonly',
  'calendar.write': 'https://www.googleapis.com/auth/calendar.events',
};

/** The internal scopes a provider grant actually covers (a declined scope narrows the connection). */
export function grantedInternalScopes(requested: readonly string[], provider: readonly string[]) {
  const have = new Set(provider);
  return requested.filter((s) => GOOGLE_SCOPES[s] !== undefined && have.has(GOOGLE_SCOPES[s]!));
}

export type ProviderErrorKind =
  | 'auth' // the access token is not accepted (refresh, then reauthorize)
  | 'invalid_grant' // the refresh token or code is revoked or expired: reauthorize
  | 'gone' // the incremental checkpoint is no longer valid: full resynchronization
  | 'rate' // provider rate limit: retry later
  | 'transient' // outage, timeout, or 5xx: retry with backoff
  | 'permanent' // refused for good (forbidden, malformed)
  | 'precondition' // the remote copy changed since our version (If-Match)
  | 'not_found';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  constructor(kind: ProviderErrorKind, status: number, retryAfterSeconds: number | null = null) {
    super(`calendar provider ${kind} (${status})`);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ProviderTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Provider scope strings actually granted. */
  scope: string[];
}

export interface ProviderCalendar {
  id: string;
  summary: string;
  timeZone: string;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  primary: boolean;
}

export interface ProviderTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface ProviderEvent {
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  etag: string;
  summary?: string;
  start?: ProviderTime;
  end?: ProviderTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: ProviderTime;
  transparency?: 'opaque' | 'transparent';
}

export interface EventPage {
  items: ProviderEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

export interface CalendarProvider {
  readonly id: 'google';
  authorizationUrl(input: { state: string; codeChallenge: string; scopes: string[] }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<ProviderTokens>;
  refresh(refreshToken: string): Promise<ProviderTokens>;
  revoke(token: string): Promise<void>;
  listCalendars(
    access: string,
    pageToken: string | null,
  ): Promise<{ items: ProviderCalendar[]; nextPageToken: string | null }>;
  listEvents(
    access: string,
    calendarId: string,
    query: { syncToken?: string; pageToken?: string; timeMin?: string },
  ): Promise<EventPage>;
  listInstances(
    access: string,
    calendarId: string,
    eventId: string,
    query: { timeMin: string; timeMax: string; pageToken?: string },
  ): Promise<EventPage>;
  patchEvent(
    access: string,
    calendarId: string,
    eventId: string,
    body: { start: ProviderTime; end: ProviderTime },
    etag: string | null,
  ): Promise<ProviderEvent>;
  insertEvent(
    access: string,
    calendarId: string,
    body: { summary: string; start: ProviderTime; end: ProviderTime },
  ): Promise<ProviderEvent>;
}

/** PKCE pair (RFC 7636, S256). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface GoogleCalendarConfig {
  clientId: string;
  /** Read lazily so the secret is never copied into a long-lived object graph. */
  clientSecret: () => string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  apiBase: string;
  timeoutMs: number;
}

type Fetch = typeof fetch;

/** Google Calendar v3 over HTTPS (OAuth 2.0 authorization code with PKCE and offline access). */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly id = 'google' as const;
  readonly #c: GoogleCalendarConfig;
  readonly #fetch: Fetch;

  constructor(config: GoogleCalendarConfig, fetchImpl: Fetch = fetch) {
    this.#c = config;
    this.#fetch = fetchImpl;
  }

  authorizationUrl(input: { state: string; codeChallenge: string; scopes: string[] }): string {
    const url = new URL(this.#c.authorizeUrl);
    url.searchParams.set('client_id', this.#c.clientId);
    url.searchParams.set('redirect_uri', this.#c.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'false');
    url.searchParams.set(
      'scope',
      input.scopes
        .map((s) => GOOGLE_SCOPES[s])
        .filter(Boolean)
        .join(' '),
    );
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<ProviderTokens> {
    return this.#token({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.#c.redirectUri,
    });
  }

  async refresh(refreshToken: string): Promise<ProviderTokens> {
    const t = await this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    // Google omits the refresh token on refresh: the existing one stays valid.
    return { ...t, refreshToken: t.refreshToken ?? refreshToken };
  }

  async revoke(token: string): Promise<void> {
    const res = await this.#send(this.#c.revokeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    // An already-revoked token is a successful revocation.
    if (!res.ok && res.status !== 400) throw classify(res.status, res.headers);
  }

  async listCalendars(access: string, pageToken: string | null) {
    const url = new URL(`${this.#c.apiBase}/users/me/calendarList`);
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = await this.#json(url, access, { method: 'GET' });
    const items = Array.isArray(body.items) ? body.items : [];
    return {
      items: items.flatMap((raw: unknown) => {
        const c = asObj(raw);
        if (typeof c.id !== 'string' || !c.id) return [];
        const role = c.accessRole;
        return [
          {
            id: c.id,
            summary: typeof c.summary === 'string' && c.summary.trim() ? c.summary : c.id,
            timeZone: typeof c.timeZone === 'string' ? c.timeZone : 'UTC',
            accessRole:
              role === 'owner' ||
              role === 'writer' ||
              role === 'reader' ||
              role === 'freeBusyReader'
                ? role
                : 'freeBusyReader',
            primary: c.primary === true,
          } satisfies ProviderCalendar,
        ];
      }),
      nextPageToken: typeof body.nextPageToken === 'string' ? body.nextPageToken : null,
    };
  }

  async listEvents(
    access: string,
    calendarId: string,
    query: { syncToken?: string; pageToken?: string; timeMin?: string },
  ): Promise<EventPage> {
    const url = new URL(`${this.#c.apiBase}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set('maxResults', '250');
    url.searchParams.set('singleEvents', 'false');
    if (query.syncToken) url.searchParams.set('syncToken', query.syncToken);
    else {
      url.searchParams.set('showDeleted', 'true');
      if (query.timeMin) url.searchParams.set('timeMin', query.timeMin);
    }
    if (query.pageToken) url.searchParams.set('pageToken', query.pageToken);
    return page(await this.#json(url, access, { method: 'GET' }));
  }

  async listInstances(
    access: string,
    calendarId: string,
    eventId: string,
    query: { timeMin: string; timeMax: string; pageToken?: string },
  ): Promise<EventPage> {
    const url = new URL(
      `${this.#c.apiBase}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}/instances`,
    );
    url.searchParams.set('maxResults', '250');
    url.searchParams.set('timeMin', query.timeMin);
    url.searchParams.set('timeMax', query.timeMax);
    if (query.pageToken) url.searchParams.set('pageToken', query.pageToken);
    return page(await this.#json(url, access, { method: 'GET' }));
  }

  async patchEvent(
    access: string,
    calendarId: string,
    eventId: string,
    body: { start: ProviderTime; end: ProviderTime },
    etag: string | null,
  ): Promise<ProviderEvent> {
    const url = new URL(
      `${this.#c.apiBase}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (etag) headers['if-match'] = etag;
    const raw = await this.#json(url, access, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    const ev = toEvent(raw);
    if (!ev) throw new ProviderError('permanent', 502);
    return ev;
  }

  async insertEvent(
    access: string,
    calendarId: string,
    body: { summary: string; start: ProviderTime; end: ProviderTime },
  ): Promise<ProviderEvent> {
    const url = new URL(`${this.#c.apiBase}/calendars/${encodeURIComponent(calendarId)}/events`);
    const raw = await this.#json(url, access, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, transparency: 'opaque' }),
    });
    const ev = toEvent(raw);
    if (!ev) throw new ProviderError('permanent', 502);
    return ev;
  }

  // -------------------------------------------------------------------------------------------

  async #token(form: Record<string, string>): Promise<ProviderTokens> {
    const res = await this.#send(this.#c.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...form,
        client_id: this.#c.clientId,
        client_secret: this.#c.clientSecret(),
      }).toString(),
    });
    const body = asObj(await res.json().catch(() => ({})));
    if (!res.ok) {
      if (
        res.status === 400 &&
        (body.error === 'invalid_grant' || body.error === 'invalid_request')
      )
        throw new ProviderError('invalid_grant', res.status);
      throw classify(res.status, res.headers);
    }
    if (typeof body.access_token !== 'string' || !body.access_token)
      throw new ProviderError('permanent', 502);
    const expires = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      expiresAt: Date.now() + expires * 1000,
      scope: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [],
    };
  }

  async #json(url: URL, access: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await this.#send(url.toString(), {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${access}` },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw classify(res.status, res.headers);
    }
    return asObj(await res.json().catch(() => ({})));
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#c.timeoutMs),
      });
    } catch {
      // Network failure, refused connection, or timeout: an outage, never a success.
      throw new ProviderError('transient', 0);
    }
  }
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function time(v: unknown): ProviderTime | undefined {
  const o = asObj(v);
  const out: ProviderTime = {};
  if (typeof o.dateTime === 'string') out.dateTime = o.dateTime;
  if (typeof o.date === 'string') out.date = o.date;
  if (typeof o.timeZone === 'string') out.timeZone = o.timeZone;
  return out.dateTime || out.date ? out : undefined;
}

export function toEvent(raw: unknown): ProviderEvent | null {
  const e = asObj(raw);
  if (typeof e.id !== 'string' || !e.id) return null;
  const status =
    e.status === 'cancelled' || e.status === 'tentative' ? e.status : ('confirmed' as const);
  const start = time(e.start);
  const end = time(e.end);
  const original = time(e.originalStartTime);
  return {
    id: e.id,
    status,
    etag: typeof e.etag === 'string' && e.etag ? e.etag : `"${e.id}"`,
    ...(typeof e.summary === 'string' ? { summary: e.summary } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(Array.isArray(e.recurrence)
      ? { recurrence: e.recurrence.filter((r): r is string => typeof r === 'string') }
      : {}),
    ...(typeof e.recurringEventId === 'string' ? { recurringEventId: e.recurringEventId } : {}),
    ...(original ? { originalStartTime: original } : {}),
    ...(e.transparency === 'transparent' || e.transparency === 'opaque'
      ? { transparency: e.transparency }
      : {}),
  };
}

function page(body: Record<string, unknown>): EventPage {
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    items: items.map(toEvent).filter((e): e is ProviderEvent => e !== null),
    nextPageToken: typeof body.nextPageToken === 'string' ? body.nextPageToken : null,
    nextSyncToken: typeof body.nextSyncToken === 'string' ? body.nextSyncToken : null,
  };
}

/** Maps a provider HTTP status to a retry class. Bodies are never read into the error. */
export function classify(status: number, headers: Headers): ProviderError {
  const retry = Number(headers.get('retry-after'));
  const after = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : null;
  if (status === 401) return new ProviderError('auth', status);
  if (status === 404) return new ProviderError('not_found', status);
  if (status === 410) return new ProviderError('gone', status);
  if (status === 412) return new ProviderError('precondition', status);
  if (status === 429) return new ProviderError('rate', status, after);
  // Google reports quota exhaustion as 403 with a Retry-After; plain 403 is a refusal.
  if (status === 403) return new ProviderError(after ? 'rate' : 'permanent', status, after);
  if (status === 408 || status >= 500) return new ProviderError('transient', status, after);
  return new ProviderError('permanent', status);
}
