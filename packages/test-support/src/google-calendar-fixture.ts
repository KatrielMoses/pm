import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A deterministic Google OAuth 2.0 + Calendar v3 contract fixture (ADR-0037 G7). It is a real HTTP
 * server speaking the subset of the documented protocol the calendar adapter uses: authorization
 * with PKCE (S256), code exchange, refresh, revocation, the calendar list, incremental event
 * listing with sync tokens (and 410 when a token is invalidated), recurring-event instances,
 * conditional PATCH (If-Match, 412), and inserts. Failures (outages, rate limits, expired access
 * tokens, revoked grants) are injected explicitly through the control interface.
 *
 * It exists for automated acceptance only. It is never configured in a deployed environment
 * (configuration refuses non-https provider endpoints outside local and test), and nothing it
 * returns is ever presented as live synchronization with Google.
 */

export interface FixtureTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface FixtureEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  start?: FixtureTime;
  end?: FixtureTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: FixtureTime;
  transparency?: 'opaque' | 'transparent';
  /** Precomputed instances served by `/instances` (for rules the client cannot expand). */
  instances?: FixtureEvent[];
}

interface Stored extends FixtureEvent {
  etag: string;
  seq: number;
}

export interface FixtureCalendar {
  id: string;
  summary: string;
  timeZone: string;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  primary?: boolean;
}

export interface FixtureControl {
  /** The consent outcome for the next authorizations: grant, deny, or grant read only. */
  consent(mode: 'grant' | 'deny' | 'read_only'): void;
  setCalendars(calendars: FixtureCalendar[]): void;
  /** Creates or replaces an event (a new etag and change sequence). */
  putEvent(calendarId: string, event: FixtureEvent): string;
  /** Marks an event cancelled (as Google reports deletions). */
  cancelEvent(calendarId: string, eventId: string): void;
  getEvent(calendarId: string, eventId: string): (FixtureEvent & { etag: string }) | null;
  /** Every outstanding sync token becomes invalid (the next incremental list answers 410). */
  invalidateSyncTokens(): void;
  /** The next `count` API calls answer `status` (503 outage, 429 with Retry-After). */
  failNext(count: number, status: number, retryAfterSeconds?: number): void;
  /** Access tokens issued so far stop working (401) until refreshed. */
  expireAccessTokens(): void;
  /** Refresh tokens issued so far are revoked (invalid_grant). */
  revokeGrants(): void;
  /** Events per page (default 250). */
  pageSize(n: number): void;
  /** Requests seen (method, path, if-match presence); never tokens or bodies. */
  requests(): Array<{ method: string; path: string; ifMatch: boolean }>;
  revoked(): number;
  reset(): void;
}

export interface GoogleCalendarFixture {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** The env a server needs to use this fixture as its Google Calendar provider. */
  env(redirectUri: string): Record<string, string>;
  control: FixtureControl;
  /** HTTP control endpoint token (for other processes, such as browser tests). */
  controlToken: string;
  close(): Promise<void>;
}

const json = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startGoogleCalendarFixture(
  options: { port?: number; host?: string } = {},
): Promise<GoogleCalendarFixture> {
  const clientId = 'fixture-client.apps.example';
  const clientSecret = randomBytes(24).toString('base64url');
  const controlToken = randomBytes(24).toString('base64url');
  let consent: 'grant' | 'deny' | 'read_only' = 'grant';
  let calendars: FixtureCalendar[] = [];
  let events = new Map<string, Map<string, Stored>>();
  let seq = 0;
  let generation = 1;
  let failures: Array<{ status: number; retryAfter?: number }> = [];
  let size = 250;
  let log: Array<{ method: string; path: string; ifMatch: boolean }> = [];
  let revokedCount = 0;
  const codes = new Map<string, { challenge: string; redirect: string; scope: string }>();
  const access = new Map<string, { expired: boolean; scope: string }>();
  const refresh = new Map<string, { revoked: boolean; scope: string }>();

  const READ = 'https://www.googleapis.com/auth/calendar.readonly';
  const EVENTS = 'https://www.googleapis.com/auth/calendar.events';

  const store = (cal: string) => {
    let m = events.get(cal);
    if (!m) events.set(cal, (m = new Map()));
    return m;
  };
  const put = (cal: string, e: FixtureEvent): Stored => {
    seq += 1;
    const s: Stored = {
      ...e,
      status: e.status ?? 'confirmed',
      etag: `"${seq}-${randomBytes(3).toString('hex')}"`,
      seq,
    };
    store(cal).set(e.id, s);
    return s;
  };
  const view = (s: Stored) => {
    const { seq: _seq, instances: _i, ...rest } = s;
    return { kind: 'calendar#event', ...rest };
  };

  const control: FixtureControl = {
    consent: (mode) => {
      consent = mode;
    },
    setCalendars: (c) => {
      calendars = c.map((x) => ({ ...x }));
    },
    putEvent: (cal, e) => put(cal, e).etag,
    cancelEvent: (cal, id) => {
      const cur = store(cal).get(id);
      put(cal, { ...(cur ?? { id }), id, status: 'cancelled' });
    },
    getEvent: (cal, id) => {
      const s = store(cal).get(id);
      return s ? { ...view(s), etag: s.etag } : null;
    },
    invalidateSyncTokens: () => {
      generation += 1;
    },
    failNext: (count, status, retryAfter) => {
      for (let i = 0; i < count; i++)
        failures.push({ status, ...(retryAfter ? { retryAfter } : {}) });
    },
    expireAccessTokens: () => {
      for (const v of access.values()) v.expired = true;
    },
    revokeGrants: () => {
      for (const v of refresh.values()) v.revoked = true;
      for (const v of access.values()) v.expired = true;
    },
    pageSize: (n) => {
      size = n;
    },
    requests: () => [...log],
    revoked: () => revokedCount,
    reset: () => {
      consent = 'grant';
      calendars = [];
      events = new Map();
      failures = [];
      size = 250;
      log = [];
      revokedCount = 0;
      generation += 1;
    },
  };

  const bearer = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    const a = access.get(t);
    return a && !a.expired ? a : null;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const path = url.pathname;
    // ---- control (other processes) -------------------------------------------------------
    if (path.startsWith('/__control/')) {
      if (req.headers['x-control-token'] !== controlToken) return json(res, 403, {});
      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      const op = path.slice('/__control/'.length);
      const args = (body.args ?? []) as unknown[];
      const fn = (control as unknown as Record<string, (...a: unknown[]) => unknown>)[op];
      if (typeof fn !== 'function') return json(res, 404, {});
      return json(res, 200, { result: fn(...args) ?? null });
    }
    // ---- OAuth -----------------------------------------------------------------------------
    if (path === '/o/oauth2/v2/auth' && req.method === 'GET') {
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      if (
        url.searchParams.get('client_id') !== clientId ||
        url.searchParams.get('code_challenge_method') !== 'S256' ||
        !url.searchParams.get('code_challenge') ||
        !redirect ||
        !state
      )
        return json(res, 400, { error: 'invalid_request' });
      const back = new URL(redirect);
      back.searchParams.set('state', state);
      if (consent === 'deny') back.searchParams.set('error', 'access_denied');
      else {
        const code = `4/${randomBytes(18).toString('base64url')}`;
        const asked = (url.searchParams.get('scope') ?? '').split(' ');
        const scope = (consent === 'read_only' ? asked.filter((s) => s === READ) : asked).join(' ');
        codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect, scope });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (path === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret)
        return json(res, 401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const c = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (
          !c ||
          c.redirect !== form.get('redirect_uri') ||
          createHash('sha256').update(verifier).digest('base64url') !== c.challenge
        )
          return json(res, 400, { error: 'invalid_grant' });
        const at = `ya29.${randomBytes(18).toString('base64url')}`;
        const rt = `1//${randomBytes(18).toString('base64url')}`;
        access.set(at, { expired: false, scope: c.scope });
        refresh.set(rt, { revoked: false, scope: c.scope });
        return json(res, 200, {
          access_token: at,
          refresh_token: rt,
          expires_in: 3599,
          scope: c.scope,
          token_type: 'Bearer',
        });
      }
      if (form.get('grant_type') === 'refresh_token') {
        const r = refresh.get(form.get('refresh_token') ?? '');
        if (!r || r.revoked) return json(res, 400, { error: 'invalid_grant' });
        if (failures.length) {
          const f = failures.shift()!;
          return json(
            res,
            f.status,
            { error: 'backend' },
            f.retryAfter ? { 'retry-after': String(f.retryAfter) } : {},
          );
        }
        const at = `ya29.${randomBytes(18).toString('base64url')}`;
        access.set(at, { expired: false, scope: r.scope });
        return json(res, 200, {
          access_token: at,
          expires_in: 3599,
          scope: r.scope,
          token_type: 'Bearer',
        });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (path === '/revoke' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const t = form.get('token') ?? '';
      const r = refresh.get(t);
      if (r) r.revoked = true;
      const a = access.get(t);
      if (a) a.expired = true;
      revokedCount += 1;
      return json(res, 200, {});
    }
    // ---- Calendar v3 ----------------------------------------------------------------------
    if (!path.startsWith('/calendar/v3/')) return json(res, 404, {});
    log.push({
      method: req.method ?? 'GET',
      path,
      ifMatch: typeof req.headers['if-match'] === 'string',
    });
    if (failures.length) {
      const f = failures.shift()!;
      return json(
        res,
        f.status,
        { error: { code: f.status } },
        f.retryAfter ? { 'retry-after': String(f.retryAfter) } : {},
      );
    }
    const who = bearer(req);
    if (!who) return json(res, 401, { error: { code: 401 } });
    const writes = who.scope.split(' ').includes(EVENTS);
    const reads = who.scope.split(' ').includes(READ);
    const rest = path.slice('/calendar/v3/'.length).split('/').map(decodeURIComponent);
    if (rest[0] === 'users' && rest[2] === 'calendarList') {
      if (!reads) return json(res, 403, { error: { code: 403 } });
      const off = Number(url.searchParams.get('pageToken') ?? '0');
      const page = calendars.slice(off, off + size);
      return json(res, 200, {
        items: page,
        ...(off + size < calendars.length ? { nextPageToken: String(off + size) } : {}),
      });
    }
    if (rest[0] !== 'calendars' || !rest[1] || rest[2] !== 'events') return json(res, 404, {});
    const cal = rest[1];
    if (!calendars.some((c) => c.id === cal)) return json(res, 404, { error: { code: 404 } });
    const m = store(cal);
    if (req.method === 'GET' && rest.length === 3) {
      if (!reads) return json(res, 403, { error: { code: 403 } });
      const sync = url.searchParams.get('syncToken');
      const pageToken = url.searchParams.get('pageToken');
      let since = 0;
      let off = 0;
      let gen = generation;
      if (pageToken) {
        const [g, s, o] = pageToken.split('.').map(Number);
        gen = g!;
        since = s!;
        off = o!;
      } else if (sync) {
        const [g, s] = sync.split('.').map(Number);
        gen = g!;
        since = s!;
      }
      if (gen !== generation)
        return json(res, 410, { error: { code: 410, message: 'fullSyncRequired' } });
      const timeMin = url.searchParams.get('timeMin');
      const all = [...m.values()]
        .filter((e) => e.seq > since)
        .filter((e) => since > 0 || e.status !== 'cancelled' || !!e.recurringEventId)
        .filter((e) => {
          if (since > 0 || !timeMin || e.recurrence) return true;
          const end = e.end?.dateTime ?? e.end?.date;
          return !end || end >= timeMin.slice(0, end.length);
        })
        .sort((a, b) => a.seq - b.seq);
      const page = all.slice(off, off + size);
      const more = off + size < all.length;
      return json(res, 200, {
        items: page.map(view),
        ...(more
          ? { nextPageToken: `${generation}.${since}.${off + size}` }
          : { nextSyncToken: `${generation}.${seq}` }),
      });
    }
    const id = rest[3];
    if (req.method === 'GET' && id && rest[4] === 'instances') {
      const master = m.get(id);
      if (!master) return json(res, 404, {});
      const min = url.searchParams.get('timeMin') ?? '';
      const max = url.searchParams.get('timeMax') ?? '￿';
      const items = (master.instances ?? []).filter((i) => {
        const s = i.start?.dateTime ?? i.start?.date ?? '';
        return s >= min.slice(0, s.length) && s < max.slice(0, s.length);
      });
      return json(res, 200, { items: items.map((i) => ({ etag: master.etag, ...i })) });
    }
    if (req.method === 'POST' && rest.length === 3) {
      if (!writes) return json(res, 403, { error: { code: 403 } });
      const body = JSON.parse(await readBody(req)) as FixtureEvent;
      const s = put(cal, { ...body, id: `evt${seq + 1}${randomBytes(4).toString('hex')}` });
      return json(res, 200, view(s));
    }
    if (req.method === 'PATCH' && id) {
      if (!writes) return json(res, 403, { error: { code: 403 } });
      const body = JSON.parse(await readBody(req)) as FixtureEvent;
      let cur = m.get(id);
      if (!cur) {
        // An instance of a recurring event: the first change creates its exception.
        const under = id.lastIndexOf('_');
        const master = under > 0 ? m.get(id.slice(0, under)) : undefined;
        if (!master) return json(res, 404, {});
        const stamp = id.slice(under + 1);
        const original =
          stamp.length === 8
            ? { date: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` }
            : {
                dateTime: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
              };
        cur = put(cal, {
          id,
          summary: master.summary,
          recurringEventId: master.id,
          originalStartTime: original,
          start: body.start ?? {},
          end: body.end ?? {},
        });
        return json(res, 200, view(cur));
      }
      const ifMatch = req.headers['if-match'];
      if (typeof ifMatch === 'string' && ifMatch !== cur.etag)
        return json(res, 412, { error: { code: 412 } });
      const next = put(cal, {
        ...cur,
        ...(body.start ? { start: body.start } : {}),
        ...(body.end ? { end: body.end } : {}),
      });
      return json(res, 200, view(next));
    }
    return json(res, 404, {});
  };

  const server = createServer((req, res) => {
    handler(req, res).catch(() => json(res, 500, {}));
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve),
  );
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    clientId,
    clientSecret,
    controlToken,
    control,
    env: (redirectUri: string) => ({
      GOOGLE_CALENDAR_CLIENT_ID: clientId,
      GOOGLE_CALENDAR_CLIENT_SECRET: clientSecret,
      GOOGLE_CALENDAR_REDIRECT_URI: redirectUri,
      GOOGLE_CALENDAR_AUTHORIZE_URL: `${baseUrl}/o/oauth2/v2/auth`,
      GOOGLE_CALENDAR_TOKEN_URL: `${baseUrl}/token`,
      GOOGLE_CALENDAR_REVOKE_URL: `${baseUrl}/revoke`,
      GOOGLE_CALENDAR_API_BASE: `${baseUrl}/calendar/v3`,
    }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Drives a fixture's control interface from another process (for example a browser test). */
export function fixtureClient(baseUrl: string, token: string) {
  const call = async (op: keyof FixtureControl, ...args: unknown[]) => {
    const r = await fetch(`${baseUrl}/__control/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-control-token': token },
      body: JSON.stringify({ args }),
    });
    if (!r.ok) throw new Error(`fixture control ${op} failed (${r.status})`);
    return ((await r.json()) as { result: unknown }).result;
  };
  return call;
}
