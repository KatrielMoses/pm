import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGoogleCalendarFixture, type GoogleCalendarFixture } from '@pm/test-support';
import {
  Browser,
  idemKey,
  identityEnv,
  registerAndVerify,
  signIn,
  type IdentityEnv,
} from './identity-helpers.ts';

const CALLBACK = '/v1/integrations/oauth/google_calendar/callback';

/**
 * 6A/6C HTTP surface (ADR-0032, ADR-0037): sync results and conflict resolution answer with valid
 * envelopes, the calendar reads are the caller's own, and the Google Calendar OAuth callback
 * completes a live authorization through the real adapter against the provider contract fixture,
 * redirecting with an outcome only.
 */
describe('integrations and calendar API (6A, 6C)', () => {
  let fx: GoogleCalendarFixture;
  let env: IdentityEnv;
  let owner: Browser;
  let stranger: Browser;
  let ws: string;
  const key = () => ({ 'idempotency-key': idemKey() });
  const base = () => `/v1/workspaces/${ws}`;

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }

  beforeAll(async () => {
    fx = await startGoogleCalendarFixture();
    env = await identityEnv(fx.env(`http://127.0.0.1${CALLBACK}`));
    owner = await person('int-owner@example.test', '203.0.113.150');
    stranger = await person('int-stranger@example.test', '203.0.113.151');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Integrations',
        timezone: 'UTC',
        locale: 'en',
        currency: 'USD',
        week_start: 1,
        first_brand: { name: 'Main' },
      },
      { headers: key() },
    );
    ws = created.json().data.id;
    fx.control.setCalendars([
      { id: 'me@example.test', summary: 'Me', timeZone: 'UTC', accessRole: 'owner', primary: true },
    ]);
  });
  afterAll(async () => {
    await env.close();
    await fx.close();
  });

  it('answers a sync with a run summary and a conflict resolution with the conflict resource', async () => {
    const body = {
      provider: 'loopback',
      auth_kind: 'api_key',
      display_name: 'Loopback',
      scopes: ['read', 'write'],
      api_key: 'loopback-http-fixture', // gitleaks:allow (synthetic loopback credential)
    };
    const made = await owner.post(`${base()}/integrations/connections`, body, { headers: key() });
    expect(made.statusCode, made.body).toBe(201);
    const conn = made.json().data.id as string;
    const synced = await owner.post(
      `${base()}/integrations/connections/${conn}/sync`,
      {},
      { headers: key() },
    );
    expect(synced.statusCode, synced.body).toBe(200);
    expect(synced.json().data).toMatchObject({
      type: 'sync_runs',
      connection: conn,
      state: 'succeeded',
    });
    expect(synced.json().data.id).toBeUndefined();
    // Both sides change: an open conflict, resolved once over HTTP.
    const ident = await env.db.admin(
      `SELECT e.public_id FROM integrations.external_identity e JOIN core.record r ON r.id = e.connection_id
        WHERE r.public_id = $1`,
      [conn],
    );
    await owner.post(
      `${base()}/integrations/connections/${conn}/identities/${ident.rows[0].public_id}/local`,
      { version: 'local-2' },
      { headers: key() },
    );
    await owner.post(
      `${base()}/integrations/connections/${conn}/reauthorize`,
      { ...body, remote_version: '2' },
      { headers: key() },
    );
    const run = await owner.post(
      `${base()}/integrations/connections/${conn}/sync`,
      {},
      { headers: key() },
    );
    expect(run.json().data).toMatchObject({ state: 'partial', conflict_count: 1 });
    const open = await owner.get(`${base()}/integrations/connections/${conn}/conflicts`);
    const cnf = open.json().data.conflicts[0].id as string;
    const resolved = await owner.post(
      `${base()}/integrations/connections/${conn}/conflicts/${cnf}/resolve`,
      { resolution: 'kept_local' },
      { headers: key() },
    );
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json().data).toMatchObject({
      id: cnf,
      type: 'sync_conflict',
      state: 'kept_local',
    });
    // A stranger cannot see the connection at all.
    const hidden = await stranger.post(
      `${base()}/integrations/connections/${conn}/sync`,
      {},
      { headers: key() },
    );
    expect(hidden.statusCode).toBe(404);
  });

  it('completes a live Google Calendar authorization through the callback and redirects with an outcome only', async () => {
    const made = await owner.post(
      `${base()}/integrations/connections`,
      {
        provider: 'google_calendar',
        auth_kind: 'oauth',
        display_name: 'Calendar',
        scopes: ['calendar.read'],
      },
      { headers: key() },
    );
    expect(made.statusCode, made.body).toBe(201);
    const conn = made.json().data.id as string;
    expect(made.json().data).toMatchObject({
      provider_mode: 'live',
      health: 'needs_reauthorization',
    });
    // The browser follows the authorization URL to the provider, which redirects back.
    const consent = await fetch(made.json().data.authorization_url as string, {
      redirect: 'manual',
    });
    const back = new URL(consent.headers.get('location')!);
    expect(back.pathname).toBe(CALLBACK);
    // Without a session the callback asks for sign-in and completes nothing.
    const anonymous = await new Browser(env.app).get(`${CALLBACK}${back.search}`);
    expect(anonymous.statusCode).toBe(303);
    expect(anonymous.headers.location).toBe('/sign-in?calendar=signin_required');
    // A tampered state is refused before any code is exchanged.
    const tampered = new URLSearchParams(back.search);
    tampered.set('state', `${tampered.get('state')!.slice(0, -2)}xx`);
    const refused = await owner.get(`${CALLBACK}?${tampered.toString()}`);
    expect(refused.headers.location).toBe(
      `/workspaces/${ws}/settings/integrations?connection=${conn}&calendar=invalid`,
    );
    // The stranger cannot complete the owner's authorization.
    const theirs = await stranger.get(`${CALLBACK}${back.search}`);
    expect(theirs.headers.location).toContain('calendar=not_found');
    const done = await owner.get(`${CALLBACK}${back.search}`);
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe(
      `/workspaces/${ws}/settings/integrations?connection=${conn}&calendar=connected`,
    );
    expect(done.headers['referrer-policy']).toBe('no-referrer');
    expect(done.body).not.toMatch(/ya29\.|1\/\//);
    const cals = await owner.get(`${base()}/integrations/connections/${conn}/calendars`);
    expect(cals.statusCode, cals.body).toBe(200);
    expect(cals.json().data).toMatchObject({
      type: 'calendar_sources',
      calendars: [expect.objectContaining({ label: 'Me', selected: true, primary: true })],
    });
    expect(cals.headers['cache-control']).toBe('private, no-store');
    expect(
      (await stranger.get(`${base()}/integrations/connections/${conn}/calendars`)).statusCode,
    ).toBe(404);
    const events = await owner.get(
      `${base()}/calendar-events?from=2030-01-01T00:00:00.000Z&to=2030-01-08T00:00:00.000Z`,
    );
    expect(events.json().data).toMatchObject({
      type: 'calendar_events',
      events: [],
      connected: true,
    });
    expect(
      (
        await owner.get(
          `${base()}/calendar-events?from=2030-01-01T00:00:00.000Z&to=2030-06-01T00:00:00.000Z`,
        )
      ).statusCode,
    ).toBe(422);
    expect((await owner.get(`${base()}/calendar-conflicts`)).json().data).toMatchObject({
      type: 'calendar_conflicts',
      conflicts: [],
    });
    // A provider refusal on consent comes back as an outcome, never as provider text.
    const denied = await owner.get(
      `${CALLBACK}?state=${encodeURIComponent(back.searchParams.get('state')!)}&error=access_denied`,
    );
    expect(denied.headers.location).toContain('calendar=denied');
    expect((await owner.get(`${CALLBACK}?state=nonsense&code=x`)).headers.location).toBe(
      '/?calendar=invalid',
    );
  });
});
