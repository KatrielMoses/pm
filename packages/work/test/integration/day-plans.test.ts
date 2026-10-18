import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { addDays, isoWeekday, localDay } from '@pm/work';
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

const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));
const ifMatch = (v: number) => mutation({ ifMatch: `"${v}"` });
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; issues?: Array<{ code: string; pointer?: string }> };
    return { code: err.code, issues: err.issues ?? [] };
  }
  throw new Error('expected a refusal');
};
const codes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code);

type AnyView = Awaited<ReturnType<WorkEnv['svc']['getAiProposal']>>;
type View = Extract<AnyView, { trust_note: string }>;
type Change = View['changes'][number];

/**
 * Phase 7F capacity-aware daily plans (ADR-0043; PLAN-010–PLAN-013, AI-021; AT-481–AT-492) on
 * real PostgreSQL: a deterministic plan from working hours, time off, meetings, blocks, Today,
 * estimates, and dependencies; plans become 7D change proposals (origin `planner`) with the new
 * canonical planning operations; atomic Apply with version locks and a constraint snapshot; stale
 * refusal and rebase; races on two connections; three workspaces; roles; evidence rechecks;
 * departure erasure. Task dates never change.
 */
describe('Phase 7F daily plans', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let ws: string;
  let wsId: string;
  let day: string;
  let brands: Record<string, string>;
  const P = {} as Record<'owner' | 'member' | 'read_only' | 'leaver', Caller>;
  const t: Record<string, string> = {};
  const sql = async (text: string, params: unknown[] = []) => (await db.admin(text, params)).rows;
  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const memId = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.id;

  const task = async (key: string, body: Record<string, unknown>, assignee?: Caller) => {
    const created = (
      await env.svc.createTask(P.owner, ws, { brand: brands.Harbor, ...body }, mutation())
    ).data;
    if (assignee)
      await env.svc.setAssignees(
        P.owner,
        ws,
        created.id,
        { assignees: [await mem(assignee)], version: created.version },
        mutation(),
      );
    t[key] = created.id;
    return created.id;
  };
  const setHours = async (who: Caller) => {
    const prof = await env.svc.myCapacityProfile(who, ws);
    await env.svc.setMyCapacityProfile(who, ws, { windows: WEEKDAYS }, ifMatch(prof.version));
  };
  const preview = (who: Caller, body: Record<string, unknown> = {}) =>
    env.svc.previewDayPlan(who, ws, { day, ...body });
  const propose = async (who: Caller, body: Record<string, unknown> = {}) =>
    (await env.svc.createDayPlanProposal(who, ws, { day, ...body }, mutation())).data as View;
  const get = async (who: Caller, id: string) => (await env.svc.getAiProposal(who, ws, id)) as View;
  const bind = (v: View) => ({ revision: v.revision, fingerprint: v.fingerprint });
  const approve = (who: Caller, v: View) =>
    env.svc.approveAiProposal(who, ws, v.id, bind(v), mutation());
  const applyIt = (who: Caller, v: View, req = mutation()) =>
    env.svc.applyAiProposal(who, ws, v.id, bind(v), req);
  const approveAndApply = async (who: Caller, v: View, req = mutation()) => {
    const approved = (await approve(who, v)).data as View;
    return (await applyIt(who, approved, req)).data as View;
  };
  const blocksOf = async (who: Caller) =>
    sql(
      `SELECT w.public_id, w.source, w.starts_at, w.ends_at, r.public_id AS task FROM planning.work_block w
         LEFT JOIN core.record r ON r.id = w.task_id
        WHERE w.owner_membership_id = $1 AND w.starts_at >= $2::date AND w.starts_at < $2::date + 1
        ORDER BY w.starts_at`,
      [await memId(who), day],
    );
  const commitmentsOf = async (who: Caller) =>
    sql(
      `SELECT r.public_id AS task, c.source, c.locked FROM planning.today_commitment c
         JOIN core.record r ON r.id = c.task_id
        WHERE c.owner_membership_id = $1 AND c.day = $2::date ORDER BY r.public_id`,
      [await memId(who), day],
    );
  const clearDay = async (who: Caller) => {
    const id = await memId(who);
    await sql(
      `DELETE FROM planning.work_block WHERE owner_membership_id = $1 AND starts_at >= $2::date AND starts_at < $2::date + 1`,
      [id, day],
    );
    await sql(`DELETE FROM planning.today_commitment WHERE owner_membership_id = $1 AND day = $2`, [
      id,
      day,
    ]);
  };
  const keysOf = (v: View, op: string) =>
    v.changes.filter((c: Change) => c.op === op).map((c: Change) => c.key);

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    const w = await workspaceWith(env, db, ['Harbor', 'Vault']);
    P.owner = w.owner;
    ws = w.ws;
    brands = w.brands;
    wsId = await workspaceIdOf(db, ws);
    P.member = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    P.read_only = await join(env, db, P.owner, ws, { kind: 'member', role: 'read_only' });
    P.leaver = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    for (const who of [P.member, P.read_only, P.leaver])
      await apply(env, P.owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: await mem(who),
        level: who === P.read_only ? 'view' : 'edit',
      });
    const today = localDay(new Date(), 'UTC');
    // A Monday 7–13 days ahead (seeded accounts use UTC): inside the 14-day planning horizon.
    day = addDays(today, 7 + ((8 - isoWeekday(today)) % 7));
    await task('A', { title: 'Write brief', priority: 'urgent', estimate_minutes: 120, due_date: day }, P.owner);
    await task('B', { title: 'Review deck', priority: 'high', estimate_minutes: 60 }, P.owner);
    await task('C', { title: 'Unestimated' }, P.owner);
    await task('D', { title: 'Blocked work', estimate_minutes: 30 }, P.owner);
    await task('E', { title: 'Blocker' });
    await env.svc.addRelationship(P.owner, ws, t.E!, { kind: 'blocks', target: t.D! }, mutation());
    await task('M', { title: 'Member task', estimate_minutes: 90, priority: 'medium' }, P.member);
    await task('L', { title: 'Leaver task', estimate_minutes: 45 }, P.leaver);
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('AT-481 without working hours nothing is claimed to fit; the preview writes nothing', async () => {
    const before = await sql(`SELECT count(*)::int AS n FROM ai.change_proposal`);
    const v = await preview(P.owner);
    expect(v).toMatchObject({ day, mode: 'rule_based', generated: false, feasible: false });
    expect(v.scheduled).toEqual([]);
    expect(v.conflicts.map((c) => c.code)).toContain('no_free_time');
    expect(await sql(`SELECT count(*)::int AS n FROM ai.change_proposal`)).toEqual(before);
    expect(await blocksOf(P.owner)).toEqual([]);
  });

  it('AT-482 plans from capacity with explained ranks; unknown estimates are questions and blockers hold work back', async () => {
    await setHours(P.owner);
    const v = await preview(P.owner);
    expect(v.totals).toMatchObject({ capacity_minutes: 480, scheduled_minutes: 180 });
    expect(v.scheduled.map((s) => [s.task.title, s.slots.map((x) => x.local)])).toEqual([
      ['Write brief', ['09:00–11:00']],
      ['Review deck', ['11:00–12:00']],
    ]);
    expect(v.scheduled[0]!.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['due_today', 'priority']),
    );
    const un = Object.fromEntries(v.unscheduled.map((u) => [u.task.title, u]));
    expect(un['Unestimated']).toMatchObject({ code: 'missing_estimate', minutes: null });
    expect(un['Blocked work']).toMatchObject({ code: 'blocked' });
    expect(un['Blocked work']!.blocked_by!.map((b) => b.id)).toEqual([t.E]);
    expect(v.totals.unknown_estimates).toBe(1);
    expect(v.feasible).toBe(false);
    // Another person's work is never a candidate.
    expect(JSON.stringify(v)).not.toContain('Member task');
    // An entered assumption is used and labelled; the task itself is unchanged.
    const before = await env.svc.getTask(P.owner, ws, t.C);
    const a = await preview(P.owner, { assumptions: { [t.C!]: 30 } });
    const c = a.scheduled.find((s) => s.task.id === t.C)!;
    expect(c).toMatchObject({ minutes: 30 });
    expect(c.reasons.map((r) => r.code)).toContain('assumed_estimate');
    expect((await env.svc.getTask(P.owner, ws, t.C)).version).toBe(before.version);
  });

  it('AT-483 validates requests: unknown fields, past days, the horizon, and bounded assumptions', async () => {
    for (const [body, code] of [
      [{ day, extra: 1 }, 'unknown_field'],
      [{ day: '2020-01-01' }, 'past_day'],
      [{ day: addDays(day, 30) }, 'too_far'],
      [{ day, assumptions: { [t.C!]: 0 } }, 'invalid_value'],
      [{ day, brands: ['nope'] }, 'invalid_value'],
    ] as const)
      expect(codes(await refusal(env.svc.previewDayPlan(P.owner, ws, body)))).toContain(code);
  });

  it('AT-484 a plan becomes a planner proposal: reviewed, edited, re-checked, approved, and applied atomically; task dates never change', async () => {
    const before = await Promise.all(['A', 'B'].map((k) => env.svc.getTask(P.owner, ws, t[k])));
    const v = await propose(P.owner);
    expect(v).toMatchObject({ origin: 'planner', synthetic: false, state: 'open' });
    expect(v.trust_note).toMatch(/rule-based planner, not AI/);
    expect(v.plan).toMatchObject({ day, mode: 'rule_based', generated: false });
    expect(v.plan!.current.state).toBe('current');
    expect(v.changes.map((c: Change) => c.op)).toEqual([
      'commitment.add',
      'block.create',
      'commitment.add',
      'block.create',
    ]);
    // The plan's evidence names every candidate and blocker; nothing is applied yet.
    const ev = await sql(
      `SELECT count(*)::int AS n FROM ai.briefing_evidence e JOIN ai.change_proposal p ON p.id = e.proposal_id WHERE p.public_id = $1`,
      [v.id],
    );
    expect(ev[0]!.n).toBeGreaterThanOrEqual(5);
    expect(await blocksOf(P.owner)).toEqual([]);
    // Edit the second block to overlap the first: approval refuses with the conflict.
    const [b1, b2] = keysOf(v, 'block.create') as [string, string];
    const edited = (
      await env.svc.updateAiProposal(
        P.owner,
        ws,
        v.id,
        {
          revision: v.revision,
          changes: { [b2]: { fields: { starts_at: `${day}T10:00:00Z`, ends_at: `${day}T11:00:00Z` } } },
        },
        mutation(),
      )
    ).data as View;
    expect(edited.plan!.current.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ block: b2, code: 'overlaps_plan' })]),
    );
    expect(codes(await refusal(approve(P.owner, edited)))).toContain('overlaps_plan');
    // Edit times are normalized and validated like any field.
    expect(
      codes(
        await refusal(
          env.svc.updateAiProposal(
            P.owner,
            ws,
            v.id,
            { revision: edited.revision, changes: { [b2]: { fields: { starts_at: 'soon' } } } },
            mutation(),
          ),
        ),
      ),
    ).toContain('invalid_instant');
    const fixed = (
      await env.svc.updateAiProposal(
        P.owner,
        ws,
        v.id,
        {
          revision: edited.revision,
          changes: { [b2]: { fields: { starts_at: `${day}T13:00:00Z`, ends_at: `${day}T14:00:00Z` } } },
        },
        mutation(),
      )
    ).data as View;
    const req = mutation();
    const out = await approveAndApply(P.owner, fixed, req);
    expect(out).toMatchObject({ state: 'applied', application: { outcome: 'applied', applied_count: 4 } });
    expect((await blocksOf(P.owner)).map((b) => [b.task, b.source, new Date(b.starts_at).toISOString()])).toEqual([
      [t.A, 'plan', `${day}T09:00:00.000Z`],
      [t.B, 'plan', `${day}T13:00:00.000Z`],
    ]);
    expect(await commitmentsOf(P.owner)).toEqual(
      [t.A, t.B].sort().map((task) => ({ task, source: 'plan', locked: false })),
    );
    // No task date or version changed.
    const after = await Promise.all(['A', 'B'].map((k) => env.svc.getTask(P.owner, ws, t[k])));
    for (const [i, a] of after.entries())
      expect(a).toMatchObject({
        due_date: before[i]!.due_date,
        start_date: before[i]!.start_date,
        version: before[i]!.version,
      });
    // The changes are the person's own (source `ui`), referencing the plan proposal, never AI.
    const audits = await sql(
      `SELECT DISTINCT source_kind, source_ref FROM audit.audit_event WHERE workspace_id = $1 AND action IN ('work_block.created', 'today.committed') AND source_ref = $2`,
      [wsId, v.id],
    );
    expect(audits).toEqual([{ source_kind: 'ui', source_ref: v.id }]);
    // A replay re-renders and never applies again; applying again is refused.
    const blocks = (await blocksOf(P.owner)).length;
    const approved = await get(P.owner, v.id);
    expect((await applyIt(P.owner, approved, req)).replayed).toBe(true);
    expect((await blocksOf(P.owner)).length).toBe(blocks);
    expect(codes(await refusal(applyIt(P.owner, approved)))).toContain('proposal_already_applied');
  });

  it('AT-485 a changed day refuses as stale (time off, estimates, blocks); rebase rebinds the reviewed day explicitly', async () => {
    await clearDay(P.owner);
    const v = await propose(P.owner);
    const approved = (await approve(P.owner, v)).data as View;
    // Time off on that day changes availability after approval.
    const off = (
      await env.svc.createTimeOff(
        P.owner,
        ws,
        { kind: 'personal', all_day: false, starts_at: `${day}T15:00:00Z`, ends_at: `${day}T17:00:00Z` },
        mutation(),
      )
    ).data;
    expect(codes(await refusal(applyIt(P.owner, approved)))).toContain('plan_changed');
    expect(await blocksOf(P.owner)).toEqual([]);
    const now = await get(P.owner, v.id);
    expect(now.plan!.current.state).toBe('changed');
    expect(now.can.rebase).toBe(true);
    // A rebase must name the day snapshot the person reviewed.
    expect(
      codes(
        await refusal(
          env.svc.rebaseAiProposal(
            P.owner,
            ws,
            v.id,
            { revision: now.revision, reviewed: {}, snapshot: 'a'.repeat(64) },
            mutation(),
          ),
        ),
      ),
    ).toContain('plan_changed');
    const rebased = (
      await env.svc.rebaseAiProposal(
        P.owner,
        ws,
        v.id,
        { revision: now.revision, reviewed: {}, snapshot: now.plan!.current.snapshot },
        mutation(),
      )
    ).data as View;
    expect(rebased).toMatchObject({ revision: now.revision + 1, state: 'open' });
    expect(rebased.plan!.current.state).toBe('current');
    expect(rebased.plan!.totals).toMatchObject({ capacity_minutes: 360 });
    // A changed estimate is also a change to the day.
    const b = await env.svc.getTask(P.owner, ws, t.B);
    await env.svc.updateTask(
      P.owner,
      ws,
      t.B,
      { version: b.version, changes: { estimate_minutes: { base: 60, value: 45 } } },
      ifMatch(b.version),
    );
    expect(codes(await refusal(approve(P.owner, rebased)))).toContain('plan_changed');
    await env.svc.deleteTimeOff(P.owner, ws, off.id, mutation());
  });

  it('AT-486 two connections: a capacity change committed while Apply waits refuses the plan; one taken after Apply locks waits for it', async () => {
    await clearDay(P.owner);
    const ownerId = await memId(P.owner);
    const hold = async (key: string) => {
      const c = new pg.Client({ connectionString: db.app });
      await c.connect();
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [wsId]);
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
      return c;
    };
    const waiting = async (n: number) => {
      for (let i = 0; i < 1000; i++) {
        const w = await sql(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (w[0]!.n >= n) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('commands did not reach the barrier');
    };
    // 1. The other connection holds the profile lock and changes an estimate before releasing.
    let v = (await approve(P.owner, await propose(P.owner))).data as View;
    let c = await hold(`capacity.profile:${ownerId}`);
    try {
      const applying = applyIt(P.owner, v).then(
        () => 'ok',
        (e: { issues?: Array<{ code: string }> }) => e.issues?.[0]?.code ?? 'error',
      );
      await waiting(1);
      await c.query(
        `UPDATE work.task SET estimate_minutes = 50, version = version + 1 WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [t.B],
      );
      await c.query('COMMIT');
      expect(await applying).toBe('plan_changed');
    } finally {
      await c.end();
    }
    expect(await blocksOf(P.owner)).toEqual([]);
    // 2. Apply holds the profile lock first; time off created meanwhile waits and lands after.
    v = (await approve(P.owner, await propose(P.owner))).data as View;
    c = await hold(`planning.blocks:${wsId}:${ownerId}`);
    let off: { id: string } | null = null;
    try {
      const applying = applyIt(P.owner, v);
      await waiting(1);
      const timeOff = env.svc.createTimeOff(
        P.owner,
        ws,
        { kind: 'personal', all_day: false, starts_at: `${day}T16:00:00Z`, ends_at: `${day}T17:00:00Z` },
        mutation(),
      );
      await waiting(2);
      await c.query('COMMIT');
      expect(((await applying).data as View).state).toBe('applied');
      off = (await timeOff).data;
    } finally {
      await c.end();
    }
    expect((await blocksOf(P.owner)).length).toBe(2);
    await env.svc.deleteTimeOff(P.owner, ws, off!.id, mutation());
  });

  it('AT-487 no duplicates: of two approved plans for one day, concurrent Applies let exactly one through', async () => {
    await clearDay(P.owner);
    const a = (await approve(P.owner, await propose(P.owner))).data as View;
    const b = (await approve(P.owner, await propose(P.owner))).data as View;
    const results = await Promise.allSettled([applyIt(P.owner, a), applyIt(P.owner, b)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBe(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(codes(failed.reason)).toContain('plan_changed');
    expect((await blocksOf(P.owner)).length).toBe(2);
    expect((await commitmentsOf(P.owner)).length).toBe(2);
  });

  it('AT-488 locks are hard constraints: locked work is never targeted; postponements are unselected suggestions', async () => {
    await clearDay(P.owner);
    // A locked focus block fills the morning; an overloaded day recommends postponing.
    await env.svc.createBlock(
      P.owner,
      ws,
      { tz: 'UTC', title: 'Focus', starts_at: `${day}T09:00:00Z`, ends_at: `${day}T15:00:00Z`, focus: true, locked: true },
      mutation(),
    );
    await env.svc.commit(P.owner, ws, day, { task: t.B }, mutation());
    const v = await propose(P.owner);
    expect(v.changes.every((c: Change) => !(c.target && 'id' in c.target && c.target.title === 'Focus'))).toBe(true);
    const removal = v.changes.find((c: Change) => c.op === 'commitment.remove');
    if (removal) expect(removal.selected).toBe(false);
    expect(v.plan!.postpone.length + v.plan!.unscheduled.length).toBeGreaterThan(0);
    // A locked commitment is never proposed for removal.
    const view = await env.svc.todayView(P.owner, ws, day);
    const cm = view.committed.find((x) => x.task.id === t.B)!;
    await env.svc.updateCommitment(P.owner, ws, day, t.B, { locked: true }, ifMatch(cm.version));
    const again = await propose(P.owner);
    expect(again.changes.some((c: Change) => c.op === 'commitment.remove')).toBe(false);
    // The focus block is unchanged and still locked.
    const focus = await sql(
      `SELECT locked, focus FROM planning.work_block WHERE owner_membership_id = $1 AND title = 'Focus'`,
      [await memId(P.owner)],
    );
    expect(focus).toEqual([{ locked: true, focus: true }]);
  });

  it('AT-489 roles and workspaces: read-only members preview but never apply; proposals are their person’s alone; other workspaces see nothing', async () => {
    await setHours(P.read_only);
    expect((await preview(P.read_only)).day).toBe(day);
    expect(await refusal(propose(P.read_only))).toMatchObject({ code: 'forbidden' });
    await setHours(P.member);
    const mine = await propose(P.member);
    expect(mine.plan!.scope).toEqual({ brands: [], projects: [] });
    expect(await refusal(env.svc.getAiProposal(P.owner, ws, mine.id))).toMatchObject({
      code: 'not_found',
    });
    expect(await refusal(approve(P.owner, mine))).toMatchObject({ code: 'not_found' });
    const other = await workspaceWith(env, db, ['Elsewhere']);
    const third = await workspaceWith(env, db, ['Third']);
    expect(
      await refusal(env.svc.getAiProposal(other.owner, other.ws, mine.id)),
    ).toMatchObject({ code: 'not_found' });
    expect(
      (await env.svc.listAiProposals(third.owner, third.ws)).items,
    ).toEqual([]);
    // A scope brand the person cannot read is indistinguishable from an unknown one.
    expect(
      await refusal(env.svc.previewDayPlan(P.member, ws, { day, brands: [brands.Vault] })),
    ).toEqual(
      await refusal(
        env.svc.previewDayPlan(P.member, ws, { day, brands: ['br_00000000000000000000000000'] }),
      ),
    );
  });

  it('AT-490 evidence is rechecked: losing access to a task the plan rests on withholds it; departure erases plan content', async () => {
    await clearDay(P.member);
    const v = await propose(P.member);
    expect(v.content.state).toBe('present');
    // The member loses the Harbor grant: the plan's candidate is no longer readable.
    await apply(env, P.owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Harbor,
      principal: await mem(P.member),
    });
    const withheld = await env.svc.getAiProposal(P.member, ws, v.id);
    expect(withheld.content.state).toBe('withheld');
    expect(JSON.stringify(withheld)).not.toContain('Member task');
    expect(codes(await refusal(approve(P.member, v)))).toContain('proposal_sources_unavailable');
    // Departure (and retention) erase planner proposals; applied blocks stay.
    await setHours(P.leaver);
    const lv = await approveAndApply(P.leaver, await propose(P.leaver));
    expect(lv.state).toBe('applied');
    const leaverId = await memId(P.leaver);
    const erased = await env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      env.svc.eraseAiContent(tx, { membershipId: leaverId }),
    );
    expect(erased).toBeGreaterThan(0);
    const row = await sql(
      `SELECT content_state, title, plan FROM ai.change_proposal WHERE public_id = $1`,
      [lv.id],
    );
    expect(row).toEqual([{ content_state: 'erased', title: null, plan: null }]);
    expect((await env.svc.getAiProposal(P.leaver, ws, lv.id)).content.state).toBe('erased');
    expect((await blocksOf(P.leaver)).length).toBe(1);
  });

  it('AT-491 a plan never targets another person’s blocks and never proposes outside its kinds', async () => {
    const other = await sql(
      `SELECT count(*)::int AS n FROM ai.proposed_change c JOIN ai.change_proposal p ON p.id = c.proposal_id
        WHERE p.origin = 'planner' AND c.op NOT IN ('block.create', 'block.update', 'block.delete', 'commitment.add', 'commitment.remove')`,
    );
    expect(other).toEqual([{ n: 0 }]);
    const foreign = await sql(
      `SELECT count(*)::int AS n FROM ai.proposed_change c JOIN ai.change_proposal p ON p.id = c.proposal_id
         JOIN planning.work_block w ON w.public_id = c.target_public_id
        WHERE w.owner_membership_id <> p.initiating_membership_id`,
    );
    expect(foreign).toEqual([{ n: 0 }]);
  });
});
