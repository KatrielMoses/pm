import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startGoogleCalendarFixture, type GoogleCalendarFixture } from '@pm/test-support';
import type { Caller } from '@pm/tenancy';
import { addDays, GoogleCalendarProvider, isoWeekday, localDay } from '@pm/work';
import {
  membershipOf,
  mutation,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));
const ifMatch = (v: number) => mutation({ ifMatch: `"${v}"` });
const codes = (e: unknown) =>
  ((e as { issues?: Array<{ code: string }> }).issues ?? []).map((i) => i.code);

type AnyView = Awaited<ReturnType<WorkEnv['svc']['getAiProposal']>>;
type View = Extract<AnyView, { trust_note: string }>;

/**
 * Phase 7F corrective review 01 R1 (AT-515–AT-520): every input that controls a person's plan
 * serializes with plan Apply on one constraint lock, including rows that did not exist when the
 * plan was checked. Calendar mirrors change only through the canonical sync (the real Google
 * adapter against its contract fixture) and reservations only through the canonical capacity
 * commands. Apply is paused after it recomputed the day (a second connection holds the
 * proposal's change rows, which Apply updates only after every planning change ran); a writer
 * started then must wait for Apply to commit. A writer that commits first makes Apply refuse
 * (`plan_changed`, nothing applied) until an explicit rebase and fresh approval.
 */
describe('Phase 7F review 01: plan constraints serialize with Apply', () => {
  let db: TestDatabase;
  let fx: GoogleCalendarFixture;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let wsId: string;
  let me: string;
  let meId: string;
  let brands: Record<string, string>;
  let day: string;
  let conn: string;
  const sql = async (text: string, params: unknown[] = []) => (await db.admin(text, params)).rows;
  const at = (hhmm: string) => `${day}T${hhmm}:00.000Z`;

  const propose = async () =>
    (await env.svc.createDayPlanProposal(owner, ws, { day }, mutation())).data as View;
  const bind = (v: View) => ({ revision: v.revision, fingerprint: v.fingerprint });
  const approve = async (v: View) =>
    (await env.svc.approveAiProposal(owner, ws, v.id, bind(v), mutation())).data as View;
  const applyIt = (v: View, req = mutation()) =>
    env.svc.applyAiProposal(owner, ws, v.id, bind(v), req);
  const sync = () => env.svc.syncNow(owner, ws, conn, mutation());
  const planning = async () =>
    (
      await sql(
        `SELECT (SELECT count(*)::int FROM planning.work_block WHERE owner_membership_id = $1 AND source = 'plan') AS blocks,
                (SELECT count(*)::int FROM planning.today_commitment WHERE owner_membership_id = $1 AND source = 'plan') AS commitments,
                (SELECT count(*)::int FROM exec.outbox_event WHERE workspace_id = $2 AND event_type = 'ai.proposal.applied') AS applied`,
        [meId, wsId],
      )
    )[0]!;
  const clearDay = async () => {
    await sql(
      `DELETE FROM planning.work_block WHERE owner_membership_id = $1 AND source = 'plan'`,
      [meId],
    );
    await sql(`DELETE FROM planning.today_commitment WHERE owner_membership_id = $1`, [meId]);
  };
  const lockWaiters = async () =>
    (
      await sql(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      )
    )[0]!.n as number;

  /**
   * Apply paused after its recompute (a second connection holds the proposal's change rows);
   * then `writer` (a canonical command) is started. Returns whether the writer was still waiting
   * when the pause ended, and both outcomes.
   */
  const raceAfterRecompute = async (v: View, writer: () => Promise<unknown>) => {
    const c = new pg.Client({ connectionString: db.app });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [wsId]);
      await c.query(
        `SELECT c.id FROM ai.proposed_change c JOIN ai.change_proposal p ON p.id = c.proposal_id WHERE p.public_id = $1 FOR UPDATE OF c`,
        [v.id],
      );
      const applying = applyIt(v).then(
        () => 'ok',
        (e: unknown) => codes(e)[0] ?? 'error',
      );
      for (let i = 0; i < 1000 && (await lockWaiters()) < 1; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(await lockWaiters(), 'Apply waits at the pause').toBeGreaterThanOrEqual(1);
      let settled = false;
      const writing = writer().then(
        (r) => {
          settled = true;
          return r;
        },
        (e: unknown) => {
          settled = true;
          throw e;
        },
      );
      // Either the writer finishes on its own (no serialization) or it is seen waiting behind Apply.
      for (let i = 0; i < 1000 && !settled && (await lockWaiters()) < 2; i++)
        await new Promise((r) => setTimeout(r, 10));
      const waitedBehindApply = !settled;
      await c.query('COMMIT');
      return { waitedBehindApply, applied: await applying, written: await writing };
    } finally {
      await c.end().catch(() => undefined);
    }
  };

  /**
   * The writer is already in flight (its row written, its transaction held open at the workspace
   * audit lock, which a second connection holds) when Apply starts. Apply must not decide on a
   * day the writer is about to change: it waits, sees the committed change, and refuses
   * (`plan_changed`) with nothing applied.
   */
  const raceWriterInFlight = async (v: View, writer: () => Promise<unknown>) => {
    const c = new pg.Client({ connectionString: db.app });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `audit.chain:${wsId}`,
      ]);
      const writing = writer();
      for (let i = 0; i < 1000 && (await lockWaiters()) < 1; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(await lockWaiters(), 'the writer is held mid-transaction').toBeGreaterThanOrEqual(1);
      const before = await planning();
      const applying = applyIt(v).then(
        () => 'ok',
        (e: unknown) => codes(e)[0] ?? 'error',
      );
      for (let i = 0; i < 1000 && (await lockWaiters()) < 2; i++)
        await new Promise((r) => setTimeout(r, 10));
      await c.query('COMMIT');
      await writing;
      const applied = await applying;
      return { applied, unchanged: JSON.stringify(await planning()) === JSON.stringify(before) };
    } finally {
      await c.end().catch(() => undefined);
    }
  };

  /** The writer commits first: Apply refuses with nothing applied, then rebase, approve, apply once. */
  const writerFirstThenRecover = async (writer: () => Promise<unknown>) => {
    await clearDay();
    const v = await approve(await propose());
    const before = await planning();
    await writer();
    const refused = await applyIt(v).then(
      () => null,
      (e: unknown) => e,
    );
    expect(codes(refused)).toContain('plan_changed');
    expect(await planning()).toEqual(before);
    const now = (await env.svc.getAiProposal(owner, ws, v.id)) as View;
    expect(now.plan!.current.state).toBe('changed');
    const rebased = (
      await env.svc.rebaseAiProposal(
        owner,
        ws,
        v.id,
        { revision: now.revision, reviewed: {}, snapshot: now.plan!.current.snapshot },
        mutation(),
      )
    ).data as View;
    const fresh = await approve(rebased);
    const req = mutation();
    expect(((await applyIt(fresh, req)).data as View).state).toBe('applied');
    expect((await applyIt(fresh, req)).replayed).toBe(true);
    const after = await planning();
    expect(after.applied).toBe(before.applied + 1);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startGoogleCalendarFixture();
    env = workEnv(db, {
      calendarProvider: new GoogleCalendarProvider({
        clientId: fx.clientId,
        clientSecret: () => fx.clientSecret,
        redirectUri: 'http://127.0.0.1:9/v1/integrations/oauth/google_calendar/callback',
        authorizeUrl: `${fx.baseUrl}/o/oauth2/v2/auth`,
        tokenUrl: `${fx.baseUrl}/token`,
        revokeUrl: `${fx.baseUrl}/revoke`,
        apiBase: `${fx.baseUrl}/calendar/v3`,
        timeoutMs: 5000,
      }),
      work: { calendarSyncHorizonDays: 60 },
    });
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Vault']));
    wsId = await workspaceIdOf(db, ws);
    const m = (await membershipOf(db, wsId, owner.auth.account.id))!;
    me = m.public_id;
    meId = m.id;
    const today = localDay(new Date(), 'UTC');
    day = addDays(today, 7 + ((8 - isoWeekday(today)) % 7));
    const prof = await env.svc.myCapacityProfile(owner, ws);
    await env.svc.setMyCapacityProfile(owner, ws, { windows: WEEKDAYS }, ifMatch(prof.version));
    for (const [title, minutes] of [
      ['Write the brief', 120],
      ['Review quotes', 60],
    ] as const) {
      const t = (
        await env.svc.createTask(
          owner,
          ws,
          { brand: brands.Harbor, title, estimate_minutes: minutes },
          mutation(),
        )
      ).data;
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [me], version: t.version },
        mutation(),
      );
    }
    fx.control.setCalendars([
      { id: 'me@example.test', summary: 'Me', timeZone: 'UTC', accessRole: 'owner', primary: true },
    ]);
    const made = await env.svc.createConnection(
      owner,
      ws,
      {
        provider: 'google_calendar',
        auth_kind: 'oauth',
        display_name: 'Work',
        scopes: ['calendar.read'],
      },
      mutation(),
    );
    const res = await fetch((made.data as { authorization_url?: string }).authorization_url!, {
      redirect: 'manual',
    });
    const back = new URL(res.headers.get('location')!);
    await env.svc.completeOauth(
      owner,
      ws,
      made.data.id,
      { code: back.searchParams.get('code'), state: back.searchParams.get('state') },
      mutation(),
    );
    conn = made.data.id;
    // A holiday in the Vault brand on the plan day: it removes the day only for someone holding a
    // Vault reservation, so a new reservation there changes the person's availability.
    await env.svc.createHoliday(
      owner,
      ws,
      brands.Vault,
      { day, name: 'Vault day off' },
      mutation(),
    );
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
    ]);
  });

  it('AT-515 a new meeting synced while Apply runs waits for it; synced first, it refuses the plan until rebased', async () => {
    await clearDay();
    await sync();
    const v = await approve(await propose());
    fx.control.putEvent('me@example.test', {
      id: 'race-new',
      summary: 'Surprise review',
      start: { dateTime: at('09:30') },
      end: { dateTime: at('10:30') },
    });
    const r = await raceAfterRecompute(v, sync);
    expect(r.waitedBehindApply).toBe(true);
    expect(r.applied).toBe('ok');
    // The sync committed after the plan: the meeting is a later change, visible now.
    expect(
      await sql(
        `SELECT count(*)::int AS n FROM integrations.calendar_event WHERE owner_membership_id = $1 AND external_event_id = 'race-new'`,
        [meId],
      ),
    ).toEqual([{ n: 1 }]);
    fx.control.putEvent('me@example.test', {
      id: 'first-new',
      summary: 'Planning sync',
      start: { dateTime: at('16:30') },
      end: { dateTime: at('17:00') },
    });
    await writerFirstThenRecover(sync);
  });

  it('AT-516 a moved or deleted meeting serializes the same way', async () => {
    await clearDay();
    fx.control.putEvent('me@example.test', {
      id: 'movable',
      summary: 'Standup',
      start: { dateTime: at('15:00') },
      end: { dateTime: at('15:30') },
    });
    await sync();
    let v = await approve(await propose());
    fx.control.putEvent('me@example.test', {
      id: 'movable',
      summary: 'Standup',
      start: { dateTime: at('09:00') },
      end: { dateTime: at('10:00') },
    });
    let r = await raceAfterRecompute(v, sync);
    expect(r).toMatchObject({ waitedBehindApply: true, applied: 'ok' });
    await clearDay();
    v = await approve(await propose());
    fx.control.cancelEvent('me@example.test', 'movable');
    r = await raceAfterRecompute(v, sync);
    expect(r).toMatchObject({ waitedBehindApply: true, applied: 'ok' });
    fx.control.putEvent('me@example.test', {
      id: 'movable-2',
      summary: 'Moved',
      start: { dateTime: at('16:30') },
      end: { dateTime: at('17:00') },
    });
    await writerFirstThenRecover(sync);
  });

  it('AT-517 a reservation in a brand the person had none in (a phantom) waits for Apply; committed first, it refuses the plan', async () => {
    await clearDay();
    expect(
      await sql(
        `SELECT count(*)::int AS n FROM planning.capacity_reservation WHERE membership_id = $1`,
        [meId],
      ),
    ).toEqual([{ n: 0 }]);
    const v = await approve(await propose());
    const reserve = (from: string) =>
      env.svc.setReservation(
        owner,
        ws,
        { brand: brands.Vault, member: me, minutes_per_week: 600, effective_from: from },
        mutation(),
      );
    const r = await raceAfterRecompute(v, () => reserve(addDays(day, -7)));
    expect(r).toMatchObject({ waitedBehindApply: true, applied: 'ok' });
    // That reservation now removes the plan day (the Vault holiday); a new plan sees no time.
    expect((await env.svc.previewDayPlan(owner, ws, { day })).totals.capacity_minutes).toBe(0);
    const rsv = (
      await sql(
        `SELECT public_id, version FROM planning.capacity_reservation WHERE membership_id = $1`,
        [meId],
      )
    )[0]!;
    await env.svc.deleteReservation(owner, ws, rsv.public_id, mutation());
    // A reservation in flight when Apply starts: Apply waits for it and refuses the stale plan.
    await clearDay();
    const w = await approve(await propose());
    expect(await raceWriterInFlight(w, () => reserve(addDays(day, -5)))).toEqual({
      applied: 'plan_changed',
      unchanged: true,
    });
    for (const x of await sql(
      `SELECT public_id FROM planning.capacity_reservation WHERE membership_id = $1`,
      [meId],
    ))
      await env.svc.deleteReservation(owner, ws, x.public_id, mutation());
    await writerFirstThenRecover(() => reserve(addDays(day, -3)));
  });

  it('AT-518 a reservation change serializes with Apply and invalidates a stale approval', async () => {
    await clearDay();
    for (const x of await sql(
      `SELECT public_id FROM planning.capacity_reservation WHERE membership_id = $1`,
      [meId],
    ))
      await env.svc.deleteReservation(owner, ws, x.public_id, mutation());
    const from = addDays(day, -1);
    // One Vault reservation; its end decides whether the Vault holiday removes the plan day.
    const set = async (to: string | null) => {
      const cur = (
        await sql(
          `SELECT version FROM planning.capacity_reservation WHERE membership_id = $1 AND effective_from = $2::date`,
          [meId, from],
        )
      )[0];
      return env.svc.setReservation(
        owner,
        ws,
        {
          brand: brands.Vault,
          member: me,
          minutes_per_week: 600,
          effective_from: from,
          effective_to: to,
        },
        cur ? ifMatch(Number(cur.version)) : mutation(),
      );
    };
    await set(from);
    const v = await approve(await propose());
    // Extending it over the plan day while Apply runs (the canonical update path) waits for Apply.
    const r = await raceAfterRecompute(v, () => set(null));
    expect(r).toMatchObject({ waitedBehindApply: true, applied: 'ok' });
    expect((await env.svc.previewDayPlan(owner, ws, { day })).totals.capacity_minutes).toBe(0);
    await set(from);
    // The same change in flight when Apply starts: Apply waits and refuses the stale plan.
    await clearDay();
    const w = await approve(await propose());
    expect(await raceWriterInFlight(w, () => set(null))).toEqual({
      applied: 'plan_changed',
      unchanged: true,
    });
    await set(from);
    await writerFirstThenRecover(() => set(null));
  });

  it('AT-519 a non-canonical writer of a controlling table waits too (the database trigger)', async () => {
    await clearDay();
    for (const x of await sql(
      `SELECT public_id FROM planning.capacity_reservation WHERE membership_id = $1`,
      [meId],
    ))
      await env.svc.deleteReservation(owner, ws, x.public_id, mutation());
    const v = await approve(await propose());
    const brandId = (
      await sql(`SELECT id FROM core.record WHERE public_id = $1`, [brands.Vault])
    )[0]!.id;
    const raw = async (text: string, params: unknown[]) => {
      const c = new pg.Client({ connectionString: db.app });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [wsId]);
        await c.query(text, params);
        await c.query('COMMIT');
      } finally {
        await c.end();
      }
    };
    const r = await raceAfterRecompute(v, () =>
      raw(
        `INSERT INTO planning.capacity_reservation (id, public_id, workspace_id, brand_id, membership_id, minutes_per_week, effective_from, set_by_membership_id)
         VALUES (uuidv7(), $1, $2, $3, $4, 60, $5::date, $4)`,
        ['rsv_01ARZ3NDEKTSV4RRFFQ69G5FAV', wsId, brandId, meId, addDays(day, -2)],
      ),
    );
    expect(r).toMatchObject({ waitedBehindApply: true, applied: 'ok' });
    await sql(
      `DELETE FROM planning.capacity_reservation WHERE public_id = 'rsv_01ARZ3NDEKTSV4RRFFQ69G5FAV'`,
    );
  });

  it('AT-520 locked work, dates, and dependency-complete selection still hold under the new lock order (no deadlock with block and Today writers)', async () => {
    await clearDay();
    const v = await approve(await propose());
    const [a, b] = await Promise.allSettled([
      applyIt(v),
      env.svc.createBlock(
        owner,
        ws,
        { tz: 'UTC', title: 'Concurrent block', starts_at: at('16:00'), ends_at: at('16:30') },
        mutation(),
      ),
    ]);
    expect(b.status).toBe('fulfilled');
    // Either Apply ran first (and the block came after) or the block came first (stale plan).
    if (a.status === 'rejected') expect(codes(a.reason)).toContain('plan_changed');
    else expect((a.value.data as View).state).toBe('applied');
    await sql(
      `DELETE FROM planning.work_block WHERE owner_membership_id = $1 AND title = 'Concurrent block'`,
      [meId],
    );
  });
});
