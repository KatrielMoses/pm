import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  DEFAULT_WORK_SETTINGS,
  goalRecalcHandler,
  recalcBackoffMs,
  type WorkSettings,
} from '@pm/work';
import type { Caller } from '@pm/tenancy';
import { mutation, workEnv, workspaceIdOf, workspaceWith, type WorkEnv } from './fixture.ts';

const Q = { kind: 'year', year: 2026 };

/**
 * 5B background recalculation (ADR-0028 G11): bounded discovery, leased claims, idempotent
 * recomputation, backoff and truthful failure state, and recovery of a crashed worker's claims.
 */
describe('Goal recalculation job (5B)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const sql = async (text: string, params: unknown[] = []) =>
    (await db.admin(text, params)).rows as Array<Record<string, any>>;
  const stateOf = async (publicId: string) =>
    (
      await sql(
        `SELECT s.* FROM goals.goal_state s JOIN core.record r ON r.id = s.goal_id WHERE r.public_id = $1`,
        [publicId],
      )
    )[0]!;
  const sweep = (settings: Partial<WorkSettings> = {}) =>
    goalRecalcHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
      settings: { ...DEFAULT_WORK_SETTINGS, ...settings },
    }).handle({} as never);
  const due = (publicId: string) =>
    sql(
      `UPDATE goals.goal_state SET next_check_at = now() - interval '1 minute', claimed_until = NULL
          WHERE goal_id = (SELECT id FROM core.record WHERE public_id = $1)`,
      [publicId],
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor']));
    wsId = await workspaceIdOf(db, ws);
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  const keyResultGoal = async (title: string) => {
    const g = (
      await env.svc.createGoal(
        owner,
        ws,
        { title, period: Q, basis: 'key_results', brand: brands.Harbor },
        mutation(),
      )
    ).data;
    const kr = (
      await env.svc.createKeyResult(
        owner,
        ws,
        g.id,
        { title: 'KR', metric: { baseline: 0, target: 10 } },
        mutation(),
      )
    ).data;
    await env.svc.recordCheckin(owner, ws, g.id, { key_result: kr.id, value: 5 }, mutation());
    return { g, kr };
  };

  it('computes due goals once, appends one rollup, and leaves nothing due', async () => {
    const { g } = await keyResultGoal('Sweep me');
    expect((await stateOf(g.id)).dirty).toBe(true);
    await sweep();
    const s = await stateOf(g.id);
    expect(s).toMatchObject({
      dirty: false,
      rollup_basis: 'key_results',
      claimed_until: null,
      attempts: 0,
      last_error: null,
    });
    expect(Number(s.rollup_percent)).toBe(50);
    expect(Date.parse(s.next_check_at)).toBeGreaterThan(Date.now() + 60 * 60_000);
    const rollups = () =>
      sql(
        `SELECT progress_percent::float AS p FROM goals.goal_checkin c JOIN core.record r ON r.id = c.goal_id WHERE r.public_id = $1 AND c.source = 'computed'`,
        [g.id],
      );
    expect(await rollups()).toEqual([{ p: 50 }]);
    // Nothing is due, so a second sweep changes nothing; forcing it due recomputes to the same row.
    await sweep();
    await due(g.id);
    await sweep();
    expect(await rollups()).toEqual([{ p: 50 }]);
    expect((await env.svc.getGoal(owner, ws, g.id)).freshness.recalculation.state).toBe('current');
  });

  it('does not double-append when two sweeps overlap', async () => {
    const { g } = await keyResultGoal('Overlap');
    await Promise.all([sweep(), sweep(), sweep()]);
    const n = await sql(
      `SELECT count(*)::int AS n FROM goals.goal_checkin c JOIN core.record r ON r.id = c.goal_id WHERE r.public_id = $1 AND c.source = 'computed'`,
      [g.id],
    );
    expect(n[0]!.n).toBe(1);
    const events = await sql(
      `SELECT count(*)::int AS n FROM exec.outbox_event WHERE event_type = 'goals.goal.checkin_recorded' AND payload::text LIKE '%computed%'`,
    );
    expect(events[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it('announces a stale update once, and only for an active goal', async () => {
    const g = (
      await env.svc.createGoal(
        owner,
        ws,
        { title: 'Quiet', period: Q, brand: brands.Harbor },
        mutation(),
      )
    ).data;
    await env.svc.recordCheckin(owner, ws, g.id, { percent: 10 }, mutation());
    await sweep();
    expect((await stateOf(g.id)).update_state).toBe('fresh');
    await sql(
      `UPDATE goals.goal SET latest_checkin_at = now() - interval '30 days' WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
      [g.id],
    );
    const count = () =>
      sql(
        `SELECT count(*)::int AS n FROM exec.outbox_event WHERE event_type = 'goals.goal.update_stale' AND aggregate_id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [g.id],
      );
    await due(g.id);
    await sweep();
    expect((await stateOf(g.id)).update_state).toBe('stale');
    expect((await count())[0]!.n).toBe(1);
    await due(g.id);
    await sweep();
    expect((await count())[0]!.n).toBe(1);
    // A closed goal does not nag.
    const closed = (
      await env.svc.createGoal(
        owner,
        ws,
        { title: 'Closed quiet', period: Q, brand: brands.Harbor },
        mutation(),
      )
    ).data;
    await env.svc.recordCheckin(owner, ws, closed.id, { percent: 10 }, mutation());
    await env.svc.updateGoal(
      owner,
      ws,
      closed.id,
      { status: 'achieved', version: (await env.svc.getGoal(owner, ws, closed.id)).version },
      mutation(),
    );
    await sql(
      `UPDATE goals.goal SET latest_checkin_at = now() - interval '30 days' WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
      [closed.id],
    );
    await due(closed.id);
    await sweep();
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM exec.outbox_event WHERE event_type = 'goals.goal.update_stale' AND aggregate_id = (SELECT id FROM core.record WHERE public_id = $1)`,
          [closed.id],
        )
      )[0]!.n,
    ).toBe(0);
  });

  it('skips archived goals and gives them a later look instead of working on them', async () => {
    const { g } = await keyResultGoal('Archived');
    await env.svc.goalLifecycle(owner, ws, g.id, 'archive', mutation());
    await due(g.id);
    await sweep();
    const s = await stateOf(g.id);
    expect(s.dirty).toBe(false);
    expect(Date.parse(s.next_check_at)).toBeGreaterThan(Date.now());
    const n = await sql(
      `SELECT count(*)::int AS n FROM goals.goal_checkin c JOIN core.record r ON r.id = c.goal_id WHERE r.public_id = $1 AND c.source = 'computed'`,
      [g.id],
    );
    expect(n[0]!.n).toBe(0);
  });

  it('leaves a leased goal alone and reclaims it once the lease lapses (a crashed worker)', async () => {
    const { g } = await keyResultGoal('Leased');
    await sql(
      `UPDATE goals.goal_state SET claimed_until = now() + interval '10 minutes' WHERE goal_id = (SELECT id FROM core.record WHERE public_id = $1)`,
      [g.id],
    );
    await sweep();
    expect((await stateOf(g.id)).dirty).toBe(true);
    await sql(
      `UPDATE goals.goal_state SET claimed_until = now() - interval '1 second' WHERE goal_id = (SELECT id FROM core.record WHERE public_id = $1)`,
      [g.id],
    );
    await sweep();
    expect(await stateOf(g.id)).toMatchObject({ dirty: false, claimed_until: null });
  });

  it('backs a failing goal off, reports it failing, never blocks the others, and recovers', async () => {
    const bad = await keyResultGoal('Fails');
    const good = await keyResultGoal('Fine');
    await sql(`CREATE FUNCTION public.goal_job_sabotage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.progress_percent = 50 AND NEW.goal_id = (SELECT id FROM core.record WHERE public_id = '${bad.g.id}') THEN RAISE EXCEPTION 'sabotage'; END IF; RETURN NEW; END $$`);
    await sql(
      `CREATE TRIGGER goal_job_sabotage BEFORE INSERT ON goals.goal_checkin FOR EACH ROW EXECUTE FUNCTION public.goal_job_sabotage()`,
    );
    try {
      const small = { goalsRecalcMaxAttempts: 1 };
      await sweep(small);
      expect((await stateOf(good.g.id)).dirty).toBe(false);
      const s = await stateOf(bad.g.id);
      expect(s).toMatchObject({
        dirty: true,
        last_error: 'recalc_failed',
        claimed_until: null,
        attempts: 1,
      });
      expect(Date.parse(s.next_check_at)).toBeGreaterThan(Date.now());
      // The viewer is told the truth: recalculation is failing, and progress is still live.
      const view = await env.svc.getGoal(owner, ws, bad.g.id);
      expect(view.freshness.recalculation.state).toBe('pending');
      expect(view.progress.percent).toBe(50);
      await sql(
        `UPDATE goals.goal_state SET attempts = 5 WHERE goal_id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [bad.g.id],
      );
      expect((await env.svc.getGoal(owner, ws, bad.g.id)).freshness.recalculation.state).toBe(
        'failing',
      );
    } finally {
      await sql('DROP TRIGGER goal_job_sabotage ON goals.goal_checkin');
      await sql('DROP FUNCTION public.goal_job_sabotage()');
    }
    await due(bad.g.id);
    await sweep();
    expect(await stateOf(bad.g.id)).toMatchObject({ dirty: false, last_error: null, attempts: 0 });
    expect((await env.svc.getGoal(owner, ws, bad.g.id)).freshness.recalculation.state).toBe(
      'current',
    );
  });

  it('bounds each sweep and caps the retry delay at the recheck interval', async () => {
    for (let i = 0; i < 3; i++) await keyResultGoal(`Batch ${i}`);
    await sql(
      `UPDATE goals.goal_state SET next_check_at = now() - interval '1 minute' WHERE workspace_id = '${wsId}'`,
    );
    const before = (
      await sql(
        `SELECT count(*)::int AS n FROM goals.goal_state WHERE workspace_id = $1 AND next_check_at <= now()`,
        [wsId],
      )
    )[0]!.n;
    await sweep({ goalsRecalcBatchMax: 2 });
    const after = (
      await sql(
        `SELECT count(*)::int AS n FROM goals.goal_state WHERE workspace_id = $1 AND next_check_at <= now()`,
        [wsId],
      )
    )[0]!.n;
    expect(before - after).toBe(2);
    await sweep({ goalsRecalcBatchMax: 2 });
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM goals.goal_state WHERE workspace_id = $1 AND next_check_at <= now()`,
          [wsId],
        )
      )[0]!.n,
    ).toBe(Math.max(after - 2, 0));
    expect(recalcBackoffMs(1, 360)).toBe(120_000);
    expect(recalcBackoffMs(3, 360)).toBe(480_000);
    expect(recalcBackoffMs(20, 360)).toBe(360 * 60_000);
  });

  it("is invisible across workspaces: a sweep never reads or writes another workspace's goals", async () => {
    const other = await workspaceWith(env, db, ['Elsewhere']);
    const g = (
      await env.svc.createGoal(other.owner, other.ws, { title: 'Theirs', period: Q }, mutation())
    ).data;
    await sweep();
    const s = (
      await sql(
        `SELECT s.workspace_id, s.dirty FROM goals.goal_state s JOIN core.record r ON r.id = s.goal_id WHERE r.public_id = $1`,
        [g.id],
      )
    )[0]!;
    expect(s.dirty).toBe(false);
    expect(s.workspace_id).not.toBe(wsId);
  });
});
