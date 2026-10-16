import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startGoogleCalendarFixture, type GoogleCalendarFixture } from '@pm/test-support';
import type { Caller } from '@pm/tenancy';
import { addDays, GoogleCalendarProvider, isoWeekday, localDay, utcToLocal } from '@pm/work';
import {
  apply,
  join,
  membershipOf,
  mutation,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const code = (c: string) => expect.objectContaining({ code: c });
const issueOf = (c: string) =>
  expect.objectContaining({
    issues: expect.arrayContaining([expect.objectContaining({ code: c })]),
  });
const ifMatch = (v: number) => mutation({ ifMatch: `"${v}"` });

/**
 * Google Calendar on the real adapter (ADR-0037; CAL-005..CAL-015, INT-026, PLAN-004): the
 * production HTTP client talks to a deterministic Google OAuth + Calendar v3 contract fixture over
 * real HTTP, against real PostgreSQL. No application authorization or success is stubbed.
 */
describe('Google Calendar live adapter (Phase 6 integration review)', () => {
  let db: TestDatabase;
  let fx: GoogleCalendarFixture;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let week: string;
  let me: string;

  const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;
  const sync = (conn: string, as: Caller = owner) => env.svc.syncNow(as, ws, conn, mutation());

  /** The full browser-shaped OAuth round trip, through the fixture's authorization endpoint. */
  const connect = async (
    as: Caller = owner,
    scopes = ['calendar.read', 'calendar.write'],
    name = 'Work calendar',
    brand?: string,
  ) => {
    const made = await env.svc.createConnection(
      as,
      ws,
      {
        provider: 'google_calendar',
        auth_kind: 'oauth',
        display_name: name,
        scopes,
        ...(brand ? { brand } : {}),
      },
      mutation(),
    );
    const url = (made.data as { authorization_url?: string }).authorization_url!;
    expect(url).toContain('code_challenge_method=S256');
    const res = await fetch(url, { redirect: 'manual' });
    const back = new URL(res.headers.get('location')!);
    return {
      id: made.data.id,
      code: back.searchParams.get('code'),
      state: back.searchParams.get('state')!,
      error: back.searchParams.get('error'),
    };
  };
  const connected = async (as: Caller = owner, scopes?: string[]) => {
    const c = await connect(as, scopes);
    await env.svc.completeOauth(as, ws, c.id, { code: c.code, state: c.state }, mutation());
    return c.id;
  };
  const calendars = (conn: string, as: Caller = owner) =>
    env.svc.listCalendars(as, ws, conn).then((r) => r.calendars);
  const choose = async (conn: string, body: Array<Record<string, unknown>>, as: Caller = owner) =>
    (await env.svc.updateCalendars(as, ws, conn, { calendars: body }, mutation())).data;
  const events = (from: string, to: string, as: Caller = owner) =>
    env.svc.listCalendarEvents(as, ws, { from, to }).then((r) => r.events);
  const health = async (conn: string) => (await env.svc.getConnection(owner, ws, conn)).health;
  /** Removes the owner's earlier calendar connections so a test sees only its own events. */
  const cleanSlate = async () => {
    for (const c of (await env.svc.listConnections(owner, ws)).connections)
      if (c.provider === 'google_calendar' && c.health !== 'disconnected')
        await env.svc.disconnect(owner, ws, c.id, { retention: 'remove' }, mutation());
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startGoogleCalendarFixture();
    const provider = new GoogleCalendarProvider({
      clientId: fx.clientId,
      clientSecret: () => fx.clientSecret,
      redirectUri: 'http://127.0.0.1:9/v1/integrations/oauth/google_calendar/callback',
      authorizeUrl: `${fx.baseUrl}/o/oauth2/v2/auth`,
      tokenUrl: `${fx.baseUrl}/token`,
      revokeUrl: `${fx.baseUrl}/revoke`,
      apiBase: `${fx.baseUrl}/calendar/v3`,
      timeoutMs: 5000,
    });
    env = workEnv(db, {
      calendarProvider: provider,
      work: { calendarSyncHorizonDays: 400, calendarOccurrencesMax: 120, syncBackoffSeconds: 1 },
    });
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    me = (await membershipOf(db, wsId, owner.auth.account.id))!.public_id;
    const today = localDay(new Date(), 'UTC');
    week = addDays(today, 7 + ((8 - isoWeekday(today)) % 7));
  }, 120_000);

  afterAll(async () => {
    await fx.close();
    await env.h.close();
    await db.drop();
  });

  beforeEach(() => {
    fx.control.reset();
    fx.control.setCalendars([
      { id: 'me@example.test', summary: 'Me', timeZone: 'UTC', accessRole: 'owner', primary: true },
      {
        id: 'team@group.example.test',
        summary: 'Team',
        timeZone: 'Europe/Lisbon',
        accessRole: 'reader',
      },
      {
        id: 'side@group.example.test',
        summary: 'Side project',
        timeZone: 'UTC',
        accessRole: 'writer',
      },
    ]);
  });

  it('AT-317 connects with OAuth, PKCE and a bound state; lists calendars; narrows declined scopes', async () => {
    // A mismatched state is refused before any code is exchanged.
    const bad = await connect();
    await expect(
      env.svc.completeOauth(
        owner,
        ws,
        bad.id,
        { code: bad.code, state: `${bad.state}x` },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('invalid'));
    // Only the person who started the authorization can complete it.
    const other = await join(env, db, owner, ws, { kind: 'member', role: 'administrator' });
    const second = await connect();
    await expect(
      env.svc.completeOauth(
        other,
        ws,
        second.id,
        { code: second.code, state: second.state },
        mutation(),
      ),
    ).rejects.toEqual(code('not_found'));
    // The real completion: tokens stay in the vault; the view says live, never a secret.
    const done = await env.svc.completeOauth(
      owner,
      ws,
      second.id,
      { code: second.code, state: second.state },
      mutation(),
    );
    expect(done.data).toMatchObject({
      health: 'connected',
      provider_mode: 'live',
      credential_configured: true,
    });
    expect(JSON.stringify(done)).not.toMatch(/ya29\.|1\/\/|refresh/);
    const listed = await calendars(second.id);
    expect(listed.map((c) => [c.label, c.selected, c.direction, c.two_way_available])).toEqual([
      ['Me', true, 'read', true],
      ['Side project', false, 'read', true],
      ['Team', false, 'read', false],
    ]);
    // Calendars are personal: an administrator who can see the connection still cannot list them.
    await expect(env.svc.listCalendars(other, ws, second.id)).rejects.toEqual(code('not_found'));
    // A person who grants read only at the provider ends with a read-only connection.
    fx.control.consent('read_only');
    const narrow = await connected();
    expect((await env.svc.getConnection(owner, ws, narrow)).scopes).toEqual(['calendar.read']);
    await expect(
      choose(narrow, [
        { id: (await calendars(narrow))[0]!.id, selected: true, direction: 'two_way' },
      ]),
    ).rejects.toEqual(issueOf('read_only_calendar'));
    // A denied consent never completes.
    fx.control.consent('deny');
    const denied = await connect();
    expect(denied.error).toBe('access_denied');
    expect(await health(denied.id)).toBe('needs_reauthorization');
  });

  it('AT-318 selects multiple calendars, maps a brand, and refuses hidden brands and read-only two-way', async () => {
    const conn = await connected();
    const [mine, side, team] = await calendars(conn);
    await expect(
      choose(conn, [{ id: team!.id, selected: true, direction: 'two_way' }]),
    ).rejects.toEqual(issueOf('read_only_calendar'));
    const out = await choose(conn, [
      { id: mine!.id, selected: true, direction: 'two_way', brand: brands.Harbor },
      { id: side!.id, selected: true, brand: brands.Summit },
      { id: team!.id, selected: true },
    ]);
    expect(
      out.calendars.map(
        (c: { label: string; selected: boolean; brand: { name: string } | null }) => [
          c.label,
          c.selected,
          c.brand?.name ?? null,
        ],
      ),
    ).toEqual([
      ['Me', true, 'Harbor'],
      ['Side project', true, 'Summit'],
      ['Team', true, null],
    ]);
    fx.control.putEvent('me@example.test', {
      id: 'a1',
      summary: 'Standup',
      start: { dateTime: at(week, '09:00') },
      end: { dateTime: at(week, '09:15') },
    });
    fx.control.putEvent('team@group.example.test', {
      id: 't1',
      summary: 'Team review',
      start: { dateTime: at(week, '11:00'), timeZone: 'Europe/Lisbon' },
      end: { dateTime: at(week, '12:00'), timeZone: 'Europe/Lisbon' },
    });
    await sync(conn);
    const seen = await events(at(week, '00:00'), at(addDays(week, 1), '00:00'));
    expect(seen.map((e) => [e.title, e.calendar.label])).toEqual([
      ['Standup', 'Me'],
      ['Team review', 'Team'],
    ]);
    // Deselecting a calendar removes its mirror at once.
    await choose(conn, [{ id: team!.id, selected: false }]);
    expect(
      (await events(at(week, '00:00'), at(addDays(week, 1), '00:00'))).map((e) => e.title),
    ).toEqual(['Standup']);
    // A brand manager who connects on their brand cannot map a calendar to a brand they cannot
    // read: it is as unknown as a brand that does not exist.
    const manager = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: (await membershipOf(db, wsId, manager.auth.account.id))!.public_id,
      level: 'manage',
    });
    const theirs = await connect(manager, ['calendar.read'], 'Manager calendar', brands.Harbor);
    await env.svc.completeOauth(
      manager,
      ws,
      theirs.id,
      { code: theirs.code, state: theirs.state },
      mutation(),
    );
    const [theirPrimary] = await calendars(theirs.id, manager);
    await expect(
      choose(theirs.id, [{ id: theirPrimary!.id, selected: true, brand: brands.Summit }], manager),
    ).rejects.toEqual(code('not_found'));
    await expect(
      choose(
        theirs.id,
        [{ id: theirPrimary!.id, selected: true, brand: 'br_00000000000000000000000000' }],
        manager,
      ),
    ).rejects.toEqual(code('not_found'));
  });

  it('AT-319 pages, keeps incremental checkpoints, and recovers from an invalidated sync token', async () => {
    const conn = await connected();
    fx.control.pageSize(2);
    for (let i = 0; i < 5; i++)
      fx.control.putEvent('me@example.test', {
        id: `p${i}`,
        summary: `Event ${i}`,
        start: { dateTime: at(addDays(week, 1), `1${i}:00`) },
        end: { dateTime: at(addDays(week, 1), `1${i}:30`) },
      });
    const first = await sync(conn);
    expect(first.data).toMatchObject({ state: 'succeeded' });
    const day = [at(addDays(week, 1), '00:00'), at(addDays(week, 2), '00:00')] as const;
    expect((await events(...day)).length).toBe(5);
    // Incremental: only the change is listed (one request with the stored sync token).
    fx.control.putEvent('me@example.test', {
      id: 'p1',
      summary: 'Event 1 (renamed)',
      start: { dateTime: at(addDays(week, 1), '11:00') },
      end: { dateTime: at(addDays(week, 1), '11:45') },
    });
    fx.control.cancelEvent('me@example.test', 'p4');
    const before = fx.control.requests().length;
    await sync(conn);
    const listed = fx.control
      .requests()
      .slice(before)
      .filter((r) => r.path.endsWith('/events'));
    expect(listed).toHaveLength(1);
    const after = await events(...day);
    expect(after.map((e) => e.title)).toEqual([
      'Event 0',
      'Event 1 (renamed)',
      'Event 2',
      'Event 3',
    ]);
    // The provider invalidates the token: 410, then a full resynchronization that also removes
    // what the provider deleted while we were not listening.
    fx.control.invalidateSyncTokens();
    fx.control.cancelEvent('me@example.test', 'p3');
    const recovered = await sync(conn);
    expect(recovered.data).toMatchObject({ state: 'succeeded' });
    expect((await events(...day)).map((e) => e.title)).toEqual([
      'Event 0',
      'Event 1 (renamed)',
      'Event 2',
    ]);
    expect(await health(conn)).toBe('connected');
  });

  it('AT-320 refreshes expired access, and a revoked grant needs reauthorization (never retried)', async () => {
    const conn = await connected();
    fx.control.expireAccessTokens();
    expect((await sync(conn)).data).toMatchObject({ state: 'succeeded' });
    fx.control.revokeGrants();
    const failed = await sync(conn);
    expect(failed.data).toMatchObject({ state: 'failed', error_code: 'needs_reauthorization' });
    expect(await health(conn)).toBe('needs_reauthorization');
    const dead = await db.admin(
      `SELECT d.state FROM integrations.sync_delivery d JOIN core.record r ON r.id = d.connection_id
        WHERE r.public_id = $1 ORDER BY d.created_at DESC LIMIT 1`,
      [conn],
    );
    expect(dead.rows[0].state).toBe('dead');
    // Reauthorization replaces the grant and synchronization resumes.
    const again = await env.svc.reauthorize(
      owner,
      ws,
      conn,
      {
        provider: 'google_calendar',
        auth_kind: 'oauth',
        display_name: 'Work calendar',
        scopes: ['calendar.read', 'calendar.write'],
      },
      mutation(),
    );
    const url = (again.data as { authorization_url?: string }).authorization_url!;
    const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
    await env.svc.completeOauth(
      owner,
      ws,
      conn,
      { code: back.searchParams.get('code'), state: back.searchParams.get('state') },
      mutation(),
    );
    expect((await sync(conn)).data).toMatchObject({ state: 'succeeded' });
  });

  it('AT-321 an outage retries with bounded backoff, shows degraded, and recovers truthfully', async () => {
    const conn = await connected();
    fx.control.failNext(1, 503);
    const failed = await sync(conn);
    expect(failed.data).toMatchObject({ state: 'failed', error_code: 'provider_unavailable' });
    expect(await health(conn)).toBe('degraded');
    const due = await db.admin(
      `SELECT d.state, d.next_attempt_at > now() AS later FROM integrations.sync_delivery d
         JOIN core.record r ON r.id = d.connection_id WHERE r.public_id = $1
        ORDER BY d.created_at DESC LIMIT 1`,
      [conn],
    );
    expect(due.rows[0]).toMatchObject({ state: 'retry_scheduled', later: true });
    // A rate limit honours the provider's Retry-After.
    fx.control.failNext(1, 429, 120);
    await sync(conn);
    const limited = await db.admin(
      `SELECT d.next_attempt_at - now() > interval '100 seconds' AS honoured FROM integrations.sync_delivery d
         JOIN core.record r ON r.id = d.connection_id WHERE r.public_id = $1
        ORDER BY d.created_at DESC LIMIT 1`,
      [conn],
    );
    expect(limited.rows[0].honoured).toBe(true);
    // The worker sweep retries the first delivery after its backoff and the connection recovers.
    const swept = await env.svc.runSyncSweep(env.h.app, wsId, new Date(Date.now() + 60_000));
    expect(swept.applied).toBeGreaterThan(0);
    expect(await health(conn)).toBe('connected');
  });

  it('AT-322 expands recurrence in its anchor zone across DST with EXDATE, moved, cancelled and all-day occurrences', async () => {
    const conn = await connected();
    const fridays = (n: number) => {
      const d0 = addDays(localDay(new Date(), 'UTC'), -14);
      const first = addDays(d0, (5 - isoWeekday(d0) + 7) % 7);
      return Array.from({ length: n }, (_, i) => addDays(first, i * 7));
    };
    const f = fridays(6);
    fx.control.putEvent('me@example.test', {
      id: 'weekly',
      summary: 'Weekly review',
      start: { dateTime: `${f[0]}T16:00:00`, timeZone: 'Europe/Lisbon' },
      end: { dateTime: `${f[0]}T17:00:00`, timeZone: 'Europe/Lisbon' },
      recurrence: [
        'RRULE:FREQ=WEEKLY;BYDAY=FR',
        `EXDATE;TZID=Europe/Lisbon:${f[2]!.replace(/-/g, '')}T160000`,
      ],
    });
    // The provider fixture needs proper start/end offsets for the master's first instance.
    fx.control.putEvent('me@example.test', {
      id: `weekly_${f[3]!.replace(/-/g, '')}`,
      recurringEventId: 'weekly',
      originalStartTime: {
        dateTime: new Date(`${f[3]}T12:00:00Z`).toISOString(),
        timeZone: 'Europe/Lisbon',
      },
      status: 'cancelled',
    });
    fx.control.putEvent('me@example.test', {
      id: 'allday',
      summary: 'Holiday duty',
      start: { date: f[1]! },
      end: { date: addDays(f[1]!, 1) },
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=2'],
      transparency: 'transparent',
    });
    fx.control.putEvent('me@example.test', {
      id: 'monthly',
      summary: 'Board call',
      start: { dateTime: at(f[0]!, '08:00') },
      end: { dateTime: at(f[0]!, '09:00') },
      recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=2TU'],
      instances: [
        {
          id: 'monthly_x1',
          recurringEventId: 'monthly',
          originalStartTime: { dateTime: at(f[1]!, '08:00') },
          start: { dateTime: at(f[1]!, '08:00') },
          end: { dateTime: at(f[1]!, '09:00') },
        },
      ],
    });
    await sync(conn);
    const from = `${f[0]}T00:00:00.000Z`;
    const list = await env.svc.listCalendarEvents(owner, ws, {
      from,
      to: `${addDays(f[0]!, 62)}T00:00:00.000Z`,
    });
    const weekly = list.events.filter((e) => e.title === 'Weekly review');
    // Every occurrence is Friday 16:00 in Lisbon, whatever the UTC offset that day.
    for (const e of weekly)
      expect(utcToLocal(new Date(e.starts_at), 'Europe/Lisbon').slice(11)).toBe('16:00');
    const keys = weekly.map((e) => utcToLocal(new Date(e.starts_at), 'Europe/Lisbon').slice(0, 10));
    expect(keys).not.toContain(f[2]); // EXDATE
    expect(keys).toContain(f[1]);
    expect(weekly.every((e) => e.recurring)).toBe(true);
    // The all-day series covers whole local days and is free time (transparent).
    const allDay = list.events.filter((e) => e.title === 'Holiday duty');
    expect(allDay).toHaveLength(2);
    expect(allDay.every((e) => e.all_day && !e.busy)).toBe(true);
    // An unsupported rule comes from the provider's own instance expansion, never approximated.
    expect(list.events.filter((e) => e.title === 'Board call').map((e) => e.starts_at)).toEqual([
      at(f[1]!, '08:00'),
    ]);
    // A moved occurrence keeps its new time and is not regenerated over.
    fx.control.putEvent('me@example.test', {
      id: `weekly_moved`,
      recurringEventId: 'weekly',
      originalStartTime: { dateTime: `${f[4]}T16:00:00`, timeZone: 'Europe/Lisbon' },
      summary: 'Weekly review (moved)',
      start: { dateTime: `${f[4]}T18:00:00`, timeZone: 'Europe/Lisbon' },
      end: { dateTime: `${f[4]}T19:00:00`, timeZone: 'Europe/Lisbon' },
    });
    await sync(conn);
    const moved = (
      await env.svc.listCalendarEvents(owner, ws, {
        from,
        to: `${addDays(f[0]!, 62)}T00:00:00.000Z`,
      })
    ).events.filter(
      (e) => utcToLocal(new Date(e.starts_at), 'Europe/Lisbon').slice(0, 10) === f[4],
    );
    expect(
      moved.map((e) => [
        e.title,
        utcToLocal(new Date(e.starts_at), 'Europe/Lisbon').slice(11),
        e.moved_occurrence,
      ]),
    ).toEqual([['Weekly review (moved)', '18:00', true]]);
    // Cancelling the whole series removes every occurrence.
    fx.control.cancelEvent('me@example.test', 'weekly');
    await sync(conn);
    expect(
      (
        await env.svc.listCalendarEvents(owner, ws, {
          from,
          to: `${addDays(f[0]!, 62)}T00:00:00.000Z`,
        })
      ).events.filter((e) => e.title.startsWith('Weekly review')),
    ).toEqual([]);
  });

  it('AT-322b keeps the Lisbon local time across a DST change over a long horizon', async () => {
    const conn = await connected();
    const start = addDays(localDay(new Date(), 'UTC'), -7);
    fx.control.putEvent('me@example.test', {
      id: 'daily',
      summary: 'Morning plan',
      start: { dateTime: `${start}T09:00:00`, timeZone: 'Europe/Lisbon' },
      end: { dateTime: `${start}T09:30:00`, timeZone: 'Europe/Lisbon' },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
    });
    await sync(conn);
    const seen: string[] = [];
    for (let w = 0; w < 7; w++) {
      const from = `${addDays(start, w * 60)}T00:00:00.000Z`;
      const to = `${addDays(start, w * 60 + 60)}T00:00:00.000Z`;
      const got = (await env.svc.listCalendarEvents(owner, ws, { from, to })).events.filter(
        (e) => e.title === 'Morning plan',
      );
      for (const e of got) {
        expect(utcToLocal(new Date(e.starts_at), 'Europe/Lisbon').slice(11)).toBe('09:00');
        seen.push(e.starts_at.slice(11, 13));
      }
    }
    // Over a year, Lisbon's offset changes, so the same local time falls on two UTC hours.
    expect(new Set(seen)).toEqual(new Set(['08', '09']));
  });

  it('AT-323 moves linked blocks both ways without loops or date changes, and makes conflicts visible', async () => {
    await cleanSlate();
    const conn = await connected();
    const [mine] = await calendars(conn);
    await choose(conn, [{ id: mine!.id, selected: true, direction: 'two_way' }]);
    const taskId = (
      await env.svc.createTask(
        owner,
        ws,
        {
          brand: brands.Harbor,
          title: 'Write launch notes',
          due_date: addDays(week, 1),
          deadline: { date: addDays(week, 2) },
        },
        mutation(),
      )
    ).data.id;
    await env.svc.setAssignees(owner, ws, taskId, { assignees: [me], version: 0 }, mutation());
    const blk = (
      await env.svc.createBlock(
        owner,
        ws,
        { task: taskId, starts_at: at(week, '10:00'), ends_at: at(week, '11:00'), tz: 'UTC' },
        mutation(),
      )
    ).data;
    // Publishing creates the provider event and the link.
    const pub = await env.svc.publishBlock(owner, ws, blk.id, { calendar: mine!.id }, mutation());
    expect(pub.data).toMatchObject({
      title: 'Write launch notes',
      link: { block: blk.id, pending: false },
    });
    await sync(conn);
    const ext = (
      await db.admin(
        `SELECT external_event_id FROM integrations.calendar_event WHERE public_id = $1`,
        [pub.data.id],
      )
    ).rows[0].external_event_id as string;
    const taskBefore = await env.svc.getTask(owner, ws, taskId);

    // Provider move → the linked block moves through the planning command (CAL-012).
    const cur = fx.control.getEvent('me@example.test', ext)!;
    fx.control.putEvent('me@example.test', {
      ...cur,
      start: { dateTime: at(addDays(week, 3), '14:00') },
      end: { dateTime: at(addDays(week, 3), '15:00') },
    });
    await sync(conn);
    const blocks = async () =>
      (await env.svc.listBlocks(owner, ws, { from: week, to: addDays(week, 6) })).data;
    let b = (await blocks()).find((x) => x.id === blk.id)!;
    expect([b.starts_at, b.ends_at]).toEqual([
      at(addDays(week, 3), '14:00'),
      at(addDays(week, 3), '15:00'),
    ]);
    expect(b.warnings).toEqual(expect.arrayContaining(['after_due_date', 'after_deadline']));
    // CAL-013: the task's due date and deadline did not move.
    const taskAfter = await env.svc.getTask(owner, ws, taskId);
    expect([taskAfter.due_date, taskAfter.deadline]).toEqual([
      taskBefore.due_date,
      taskBefore.deadline,
    ]);
    const moveAudit = await db.admin(
      `SELECT actor_type FROM audit.audit_event WHERE action = 'work_block.moved' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(moveAudit.rows[0].actor_type).toBe('integration');

    // Local move → pushed with If-Match; the echo of our own write moves nothing (no loop).
    const v = b.version;
    await env.svc.updateBlock(
      owner,
      ws,
      blk.id,
      { starts_at: at(addDays(week, 1), '08:00'), ends_at: at(addDays(week, 1), '09:00') },
      ifMatch(v),
    );
    const pushReq = fx.control.requests().length;
    await sync(conn);
    const patches = fx.control
      .requests()
      .slice(pushReq)
      .filter((r) => r.method === 'PATCH');
    expect(patches).toEqual([expect.objectContaining({ ifMatch: true })]);
    expect(fx.control.getEvent('me@example.test', ext)!.start).toEqual({
      dateTime: at(addDays(week, 1), '08:00'),
      timeZone: 'UTC',
    });
    b = (await blocks()).find((x) => x.id === blk.id)!;
    const settled = b.version;
    await sync(conn);
    await sync(conn);
    b = (await blocks()).find((x) => x.id === blk.id)!;
    expect(b.version).toBe(settled);
    expect(await env.svc.listCalendarConflicts(owner, ws)).toEqual({ conflicts: [] });

    // Both sides change → a visible conflict; neither side is overwritten.
    const remote = fx.control.getEvent('me@example.test', ext)!;
    fx.control.putEvent('me@example.test', {
      ...remote,
      start: { dateTime: at(addDays(week, 4), '16:00') },
      end: { dateTime: at(addDays(week, 4), '17:00') },
    });
    await env.svc.updateBlock(
      owner,
      ws,
      blk.id,
      { starts_at: at(addDays(week, 1), '13:00'), ends_at: at(addDays(week, 1), '14:00') },
      ifMatch(b.version),
    );
    await sync(conn);
    const open = (await env.svc.listCalendarConflicts(owner, ws)).conflicts;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      can_keep_local: true,
      event: { starts_at: at(addDays(week, 4), '16:00') },
      block: { id: blk.id, starts_at: at(addDays(week, 1), '13:00') },
    });
    expect(fx.control.getEvent('me@example.test', ext)!.start!.dateTime).toBe(
      at(addDays(week, 4), '16:00'),
    );
    // Someone else never sees or resolves it.
    const admin = await join(env, db, owner, ws, { kind: 'member', role: 'administrator' });
    expect((await env.svc.listCalendarConflicts(admin, ws)).conflicts).toEqual([]);
    await expect(
      env.svc.resolveConflict(
        admin,
        ws,
        conn,
        open[0]!.id,
        { resolution: 'kept_local' },
        mutation(),
      ),
    ).rejects.toEqual(code('not_found'));
    // Keep mine: the provider copy is overwritten deliberately, on the next run.
    await env.svc.resolveConflict(
      owner,
      ws,
      conn,
      open[0]!.id,
      { resolution: 'kept_local' },
      mutation(),
    );
    await sync(conn);
    expect(fx.control.getEvent('me@example.test', ext)!.start!.dateTime).toBe(
      at(addDays(week, 1), '13:00'),
    );
    expect((await env.svc.listCalendarConflicts(owner, ws)).conflicts).toEqual([]);

    // A locked block is never moved by the provider: a conflict instead; keep the calendar's
    // time after unlocking applies it through the same command.
    b = (await blocks()).find((x) => x.id === blk.id)!;
    const locked = await env.svc.updateBlock(
      owner,
      ws,
      blk.id,
      { locked: true },
      ifMatch(b.version),
    );
    const r2 = fx.control.getEvent('me@example.test', ext)!;
    fx.control.putEvent('me@example.test', {
      ...r2,
      start: { dateTime: at(addDays(week, 2), '07:00') },
      end: { dateTime: at(addDays(week, 2), '08:00') },
    });
    await sync(conn);
    b = (await blocks()).find((x) => x.id === blk.id)!;
    expect(b.starts_at).toBe(at(addDays(week, 1), '13:00'));
    const lockedConflict = (await env.svc.listCalendarConflicts(owner, ws)).conflicts[0]!;
    await expect(
      env.svc.resolveConflict(
        owner,
        ws,
        conn,
        lockedConflict.id,
        { resolution: 'kept_remote' },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('locked'));
    await env.svc.updateBlock(owner, ws, blk.id, { locked: false }, ifMatch(locked.data.version));
    await env.svc.resolveConflict(
      owner,
      ws,
      conn,
      lockedConflict.id,
      { resolution: 'kept_remote' },
      mutation(),
    );
    b = (await blocks()).find((x) => x.id === blk.id)!;
    expect(b.starts_at).toBe(at(addDays(week, 2), '07:00'));
    // Dismissing a later conflict ends the link; both keep their own time.
    await env.svc.unlinkBlock(owner, ws, blk.id, mutation());
    expect(
      (
        await env.svc.listCalendarEvents(owner, ws, {
          from: at(week, '00:00'),
          to: at(addDays(week, 6), '00:00'),
        })
      ).events.find((e) => e.calendar.label === 'Me' && e.link),
    ).toBeUndefined();
  });

  it('AT-324 feeds Today, calendar reads and capacity for the owner only (no anonymous free/busy)', async () => {
    await cleanSlate();
    const conn = await connected();
    const [mine] = await calendars(conn);
    await choose(conn, [{ id: mine!.id, selected: true, brand: brands.Summit }]);
    await env.svc.setMyCapacityProfile(
      owner,
      ws,
      { windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })) },
      ifMatch((await env.svc.myCapacityProfile(owner, ws)).version),
    );
    fx.control.putEvent('me@example.test', {
      id: 'c1',
      summary: 'Investor call',
      start: { dateTime: at(week, '10:00') },
      end: { dateTime: at(week, '11:00') },
    });
    await sync(conn);
    const harborTask = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Harbor, title: 'Harbor copy' },
        mutation(),
      )
    ).data.id;
    await env.svc.createBlock(
      owner,
      ws,
      { task: harborTask, starts_at: at(week, '10:30'), ends_at: at(week, '11:30'), tz: 'UTC' },
      mutation(),
    );
    const today = await env.svc.todayView(owner, ws, week);
    expect(today.meetings).toMatchObject({
      available: true,
      busy_minutes: 60,
      events: [expect.objectContaining({ title: 'Investor call' })],
    });
    const cap = await env.svc.personCapacity(owner, ws, { from: week, to: week });
    expect(cap.days[0]).toMatchObject({ working_minutes: 480, unavailable_minutes: 60 });
    expect(cap.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'calendar_overlap', minutes: 30 }),
        expect.objectContaining({
          kind: 'overlap',
          brands: expect.arrayContaining(['Harbor', 'Summit']),
        }),
      ]),
    );
    // An administrator with capacity.view sees the person's capacity without any calendar-derived
    // minutes, conflicts, or counts (DQ-06).
    const admin = await join(env, db, owner, ws, { kind: 'member', role: 'administrator' });
    const seen = await env.svc.personCapacity(admin, ws, { member: me, from: week, to: week });
    expect(seen.days[0]).toMatchObject({ unavailable_minutes: 0 });
    expect(JSON.stringify(seen)).not.toMatch(/calendar_overlap|Investor|cev_/);
    expect(
      await env.svc.listCalendarEvents(admin, ws, {
        from: at(week, '00:00'),
        to: at(addDays(week, 1), '00:00'),
      }),
    ).toMatchObject({ events: [], connected: false });
    const theirToday = await env.svc.todayView(admin, ws, week);
    expect(theirToday.meetings).toEqual({ available: false, reason: 'not_connected' });
  });

  it('AT-325 disconnecting while work is queued stops it, revokes at the provider, and applies retention', async () => {
    await cleanSlate();
    const conn = await connected();
    fx.control.putEvent('me@example.test', {
      id: 'q1',
      summary: 'Kept',
      start: { dateTime: at(week, '13:00') },
      end: { dateTime: at(week, '14:00') },
    });
    await sync(conn);
    // Queue a sweep delivery, then disconnect (retain) before the worker runs.
    await db.admin(
      `INSERT INTO integrations.sync_delivery (id, workspace_id, connection_id, dedupe_key)
       SELECT gen_random_uuid(), c.workspace_id, c.id, 'queued-before-revoke' FROM integrations.connection c
         JOIN core.record r ON r.id = c.id WHERE r.public_id = $1`,
      [conn],
    );
    const revokedBefore = fx.control.revoked();
    await env.svc.disconnect(owner, ws, conn, { retention: 'retain' }, mutation());
    expect(fx.control.revoked()).toBe(revokedBefore + 1);
    // The queued work re-checks the connection when it runs: it is skipped, never executed.
    await env.svc.runSyncSweep(env.h.app, wsId, new Date(Date.now() + 60_000));
    const q = await db.admin(
      `SELECT state, error_code FROM integrations.sync_delivery WHERE dedupe_key = 'queued-before-revoke'`,
    );
    expect(q.rows[0]).toMatchObject({ state: 'dead', error_code: 'disconnected' });
    const run = await db.admin(
      `SELECT state, error_code FROM integrations.sync_run WHERE idempotency_key = 'queued-before-revoke'`,
    );
    expect(run.rows[0]).toMatchObject({ state: 'skipped', error_code: 'disconnected' });
    // Retained events stay readable to their owner, marked as no longer synchronized, and no
    // longer count as busy time.
    const kept = await events(at(week, '00:00'), at(addDays(week, 1), '00:00'));
    expect(kept.find((e) => e.title === 'Kept')).toMatchObject({ synchronized: false });
    // Removal deletes every mirrored row of a connection.
    const gone = await connected();
    fx.control.putEvent('me@example.test', {
      id: 'q2',
      summary: 'Removed',
      start: { dateTime: at(week, '15:00') },
      end: { dateTime: at(week, '16:00') },
    });
    await sync(gone);
    await env.svc.disconnect(owner, ws, gone, { retention: 'remove' }, mutation());
    const left = await db.admin(
      `SELECT (SELECT count(*) FROM integrations.calendar_event e JOIN core.record r ON r.id = e.connection_id WHERE r.public_id = $1)
            + (SELECT count(*) FROM integrations.calendar_source s JOIN core.record r ON r.id = s.connection_id WHERE r.public_id = $1)
            + (SELECT count(*) FROM integrations.calendar_series s JOIN core.record r ON r.id = s.connection_id WHERE r.public_id = $1) AS n`,
      [gone],
    );
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it('AT-326 reports unconfigured and test-double states honestly', async () => {
    const plain = workEnv(db);
    const { owner: o, ws: w } = await workspaceWith(plain, db, ['Solo']);
    const providers = await plain.svc.listProviders(o, w);
    expect(providers.providers.find((p) => p.id === 'google_calendar')).toMatchObject({
      configured: false,
      unavailable: 'Google Calendar is not configured in this environment.',
    });
    await expect(
      plain.svc.createConnection(
        o,
        w,
        {
          provider: 'google_calendar',
          auth_kind: 'oauth',
          display_name: 'X',
          scopes: ['calendar.read'],
        },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('provider_unconfigured'));
    const double = workEnv(db, { work: { googleCalendarLoopbackEnabled: true } });
    const made = await double.svc.createConnection(
      o,
      w,
      {
        provider: 'google_calendar',
        auth_kind: 'api_key',
        display_name: 'Double',
        scopes: ['calendar.read'],
        api_key: 'gcal-loopback-fixture-c',
      }, // gitleaks:allow (synthetic loopback credential)
      mutation(),
    );
    expect(made.data).toMatchObject({ provider_mode: 'test_double' });
    await plain.h.close();
    await double.h.close();
  });
});
