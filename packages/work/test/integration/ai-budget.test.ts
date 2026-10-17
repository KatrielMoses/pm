import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startAiProviderFixture, type AiProviderFixture } from '@pm/test-support';
import type { Caller } from '@pm/tenancy';
import { DEFAULT_WORK_SETTINGS, NotificationFanOut } from '@pm/work';
import { settle } from '../../src/ai/budget.ts';
import { aiWorker, drain, enableAi, fixtureAi, ledger, stepped, stepUp } from './ai-support.ts';
import {
  join,
  membershipOf,
  mutation,
  outboxEvents,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; issues?: unknown };
    return { code: err.code, issues: err.issues ?? null };
  }
  throw new Error('expected a refusal');
};
const micros = (v: string) => Number(v);

/**
 * Phase 7A hard budgets: reservations are taken atomically before any chargeable attempt, so
 * overlapping dispatchers cannot spend the same allowance; retries, duplicate settlements, worker
 * loss, unknown usage, reconciliation, limit changes, and period rollover all preserve ledger
 * conservation (balances equal open reservations and usage events) and never dispatch unreserved.
 */
describe('Phase 7A AI budgets', () => {
  let db: TestDatabase;
  let fx: AiProviderFixture;
  let env: WorkEnv;
  let owner: Caller;
  let admin: Caller;
  let member: Caller;
  let ws: string;
  let wsId: string;
  const run = (body: Record<string, unknown>, who = owner) =>
    env.svc.startAiTestRun(who, ws, { confirm_cost: true, ...body }, mutation());
  const setLimit = (meter: string, allowance: string, hard: string) =>
    stepped(env, () =>
      env.svc.updateAiLimits(
        owner,
        ws,
        { limits: [{ meter, monthly_allowance: allowance, hard_limit: hard }] },
        stepUp(),
      ),
    );
  const sentFor = (marker: string) =>
    fx.control.received().filter((r) => r.user.includes(marker)).length;
  const opState = async (id: string) =>
    (
      await db.admin(
        `SELECT execution_state, terminal_reason, waiting_reason FROM exec.operation WHERE public_id = $1`,
        [id],
      )
    ).rows[0];
  const dispatchesOf = async (id: string) =>
    (
      await db.admin(
        `SELECT d.id, d.state, d.reserved_micros::text AS reserved, d.settled_micros::text AS settled
           FROM ai.ai_dispatch d JOIN exec.operation o ON o.id = d.operation_id WHERE o.public_id = $1 ORDER BY d.dispatch_number`,
        [id],
      )
    ).rows as Array<{ id: string; state: string; reserved: string; settled: string | null }>;
  /** Every dispatch that reached the provider holds (or held) a reservation on every meter. */
  const noUnreservedDispatch = async () => {
    const r = await db.admin(
      `SELECT d.id FROM ai.ai_dispatch d
        WHERE d.workspace_id = $1 AND d.state <> 'refused'
          AND (SELECT count(*) FROM metering.usage_reservation r WHERE r.dispatch_id = d.id) <> 3`,
      [wsId],
    );
    expect(r.rows).toEqual([]);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startAiProviderFixture();
    env = workEnv(db, { ai: fixtureAi(fx, { maxOutputTokens: 64 }) });
    const w = await workspaceWith(env, db, ['Harbor']);
    owner = w.owner;
    ws = w.ws;
    wsId = await workspaceIdOf(db, ws);
    admin = await join(env, db, owner, ws, { kind: 'member', role: 'administrator' });
    member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await enableAi(env, owner, ws);
  }, 120_000);

  // Each test starts from generous limits, so one failure never cascades into the next.
  beforeEach(async () => {
    await stepped(env, () =>
      env.svc.updateAiLimits(
        owner,
        ws,
        {
          limits: [
            { meter: 'ai.cost', monthly_allowance: '1000000', hard_limit: '1000000' },
            { meter: 'ai.input_tokens', monthly_allowance: '2000000', hard_limit: '2000000' },
            { meter: 'ai.output_tokens', monthly_allowance: '500000', hard_limit: '500000' },
          ],
        },
        stepUp(),
      ),
    );
  });

  afterAll(async () => {
    await fx?.close();
    await env?.h.close();
    await db?.drop();
  });

  it('AT-372 overlapping dispatchers never spend the same allowance; the last available unit fits exactly once', async () => {
    const body = { prompt: 'Budget probe #fixture:slow', max_output_tokens: 64 };
    const est = await env.svc.estimateAiRun(owner, ws, body);
    const one = micros(est.max_cost.micros);
    // Exactly three reservations fit; the hard limit equals three bounds (the last unit included).
    await setLimit('ai.cost', (one * 3).toFixed(6), (one * 3).toFixed(6));
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await run(body)).data.id);
    const [w1, w2] = [await aiWorker(env), await aiWorker(env)];
    await Promise.all([
      w1.runCycle({ wait: true }),
      w2.runCycle({ wait: true }),
      w1.runCycle({ wait: true }),
    ]);
    for (const id of ids) await drain(db, w1, id);
    const states = await Promise.all(ids.map(opState));
    const done = states.filter((s) => s.execution_state === 'succeeded').length;
    const stopped = states.filter((s) => s.terminal_reason === 'limit_exceeded').length;
    expect(states, JSON.stringify(states)).toHaveLength(6);
    expect(done + stopped, JSON.stringify(states)).toBe(6);
    // All six were claimed together and each slow stream outlives the denials, so exactly the
    // three reservations that fit were taken and the other three were refused before sending.
    expect(done).toBe(3);
    expect(stopped).toBe(3);
    // Nothing was sent for a run that could not reserve.
    expect(sentFor('Budget probe')).toBe(done);
    await noUnreservedDispatch();
    const l = await ledger(db, wsId);
    expect(l.reserved).toBe(0);
    expect(l.consumed).toBeLessThanOrEqual(one * 3);
    // A limit-stopped run never shows zero cost as a success; it says the limit stopped it.
    const stoppedId = ids[states.findIndex((s) => s.terminal_reason === 'limit_exceeded')]!;
    const view = await env.svc.getAiRun(owner, ws, stoppedId);
    expect(view.status).toBe('Stopped: spending limit reached');
    expect((await outboxEvents(db, wsId, 'metering.usage.limit_reached')).length).toBeGreaterThan(
      0,
    );
    await setLimit('ai.cost', '1000000', '1000000');
  });

  it('AT-373 retries are reserved and settled per attempt; a duplicate settlement changes nothing', async () => {
    const r = await run({ prompt: 'Retry probe #fixture:rate_limit_once' });
    const w = await aiWorker(env);
    expect(await drain(db, w, r.data.id)).toMatchObject({ execution_state: 'succeeded' });
    const d = await dispatchesOf(r.data.id);
    expect(d.map((x) => [x.state, x.settled === '0.000000'])).toEqual([
      ['failed', true],
      ['succeeded', false],
    ]);
    const reservations = await db.admin(
      `SELECT state, count(*)::int AS n FROM metering.usage_reservation r JOIN exec.operation o ON o.id = r.operation_id
        WHERE o.public_id = $1 GROUP BY state`,
      [r.data.id],
    );
    expect(reservations.rows).toEqual([{ state: 'settled', n: 6 }]);
    const before = await ledger(db, wsId);
    // A redelivered settlement (duplicate callback) finds nothing open.
    const opId = (await db.admin(`SELECT id FROM exec.operation WHERE public_id = $1`, [r.data.id]))
      .rows[0].id;
    const again = await env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      settle(tx, {
        operationId: opId,
        dispatchId: d[1]!.id,
        settlement: {
          kind: 'actual',
          basis: 'measured',
          amounts: { 'ai.cost': 999_000_000n, 'ai.input_tokens': 0n, 'ai.output_tokens': 0n },
        },
        funding: 'synthetic',
        brandId: null,
        now: new Date(),
        currentPeriod: { start: before.balances[0]!.period, end: '2999-01-01' },
      }),
    );
    expect(again).toEqual({ settled: 0, markedUnknown: 0 });
    expect(await ledger(db, wsId)).toEqual(before);
  });

  it('AT-374 a worker lost mid-call never resends: the outcome stays unknown and reserved until reconciled once', async () => {
    const r = await run({ prompt: 'Crash probe #fixture:hang' });
    const w1 = await aiWorker(env);
    const inflight = w1.runCycle({ wait: true });
    for (let i = 0; i < 60 && sentFor('Crash probe') === 0; i++)
      await new Promise((x) => setTimeout(x, 50));
    expect(sentFor('Crash probe')).toBe(1);
    // The worker is lost: its lease expires and another worker recovers the job.
    await db.admin(
      `UPDATE exec.job SET lease_until = now() - interval '1 minute'
        WHERE operation_id = (SELECT id FROM exec.operation WHERE public_id = $1)`,
      [r.data.id],
    );
    const w2 = await aiWorker(env);
    expect(await w2.reapExpiredLeases()).toBe(1);
    expect(await drain(db, w2, r.data.id)).toMatchObject({
      execution_state: 'waiting',
      waiting_reason: 'reconciliation_required',
    });
    fx.control.releaseHung();
    await inflight;
    expect(sentFor('Crash probe')).toBe(1);
    const [d] = await dispatchesOf(r.data.id);
    expect(d).toMatchObject({ state: 'unknown', settled: null });
    const held = await ledger(db, wsId);
    expect(held.reserved).toBe(micros(d!.reserved));
    // Retry is refused until the unknown cost is reconciled.
    expect(
      (await refusal(env.svc.retryAiRun(owner, ws, r.data.id, {}, mutation()))).issues,
    ).toEqual([expect.objectContaining({ code: 'reconciliation_required' })]);
    const done = await stepped(env, () =>
      env.svc.reconcileAiDispatch(admin, ws, r.data.id, '1', { basis: 'reserved_bound' }, stepUp()),
    );
    expect(done.data).toMatchObject({ state: 'failed' });
    expect(done.data.attempts[0]).toMatchObject({
      state: 'reconciled',
      usage_basis: 'reserved_bound',
    });
    const after = await ledger(db, wsId);
    expect(after.reserved).toBe(0);
    expect(after.consumed).toBeCloseTo(held.consumed + micros(d!.reserved), 6);
    expect(
      (
        await refusal(
          stepped(env, () =>
            env.svc.reconcileAiDispatch(
              admin,
              ws,
              r.data.id,
              '1',
              { basis: 'not_charged' },
              stepUp(),
            ),
          ),
        )
      ).code,
    ).toBe('conflict');
    expect(await ledger(db, wsId)).toEqual(after);
  });

  it('AT-375 the authoritative current limit applies at estimate, start, and dispatch; lowering it never erases usage', async () => {
    const consumedBefore = (await ledger(db, wsId)).consumed;
    await setLimit('ai.cost', '0', '0.000001');
    expect((await refusal(run({ prompt: 'Too dear' }))).code).toBe('usage_limit_reached');
    expect((await env.svc.estimateAiRun(owner, ws, { prompt: 'Too dear' })).within_limits).toBe(
      false,
    );
    await setLimit('ai.cost', '1000000', '1000000');
    const queued = await run({ prompt: 'Lowered after start' });
    await setLimit('ai.cost', '0', '0.000001');
    const w = await aiWorker(env);
    await drain(db, w, queued.data.id);
    expect(await opState(queued.data.id)).toMatchObject({
      execution_state: 'failed',
      terminal_reason: 'limit_exceeded',
    });
    expect(sentFor('Lowered after start')).toBe(0);
    expect((await dispatchesOf(queued.data.id)).map((x) => x.state)).toEqual(['refused']);
    expect((await ledger(db, wsId)).consumed).toBe(consumedBefore);
    // Token limits are hard limits too.
    await setLimit('ai.cost', '1000000', '1000000');
    await setLimit('ai.output_tokens', '10', '10');
    expect((await env.svc.estimateAiRun(owner, ws, { prompt: 'Tokens' })).blocked_meter).toBe(
      'ai.output_tokens',
    );
    await setLimit('ai.output_tokens', '500000', '500000');
    // Only owners and administrators configure limits, with step-up.
    expect(
      (
        await refusal(
          stepped(env, () =>
            env.svc.updateAiLimits(
              member,
              ws,
              { limits: [{ meter: 'ai.cost', monthly_allowance: '1', hard_limit: '1' }] },
              stepUp(),
            ),
          ),
        )
      ).code,
    ).toBe('forbidden');
    expect(
      (
        await refusal(
          env.svc.updateAiLimits(
            admin,
            ws,
            { limits: [{ meter: 'ai.cost', monthly_allowance: '1', hard_limit: '1' }] },
            mutation(),
          ),
        )
      ).code,
    ).toBe('step_up_required');
    expect(
      (
        await refusal(
          stepped(env, () =>
            env.svc.updateAiLimits(
              owner,
              ws,
              { limits: [{ meter: 'ai.cost', monthly_allowance: '5', hard_limit: '1' }] },
              stepUp(),
            ),
          ),
        )
      ).code,
    ).toBe('validation_failed');
    await ledger(db, wsId);
  });

  it('AT-376 period rollover: a reservation from a closed period still counts, and settles into the current one', async () => {
    const r = await run({ prompt: 'Rollover probe #fixture:interrupt' });
    const w = await aiWorker(env);
    await drain(db, w, r.data.id);
    const [d] = await dispatchesOf(r.data.id);
    expect(d!.state).toBe('unknown');
    const current = (
      await db.admin(`SELECT period_start::text AS p FROM ai.ai_dispatch WHERE id = $1`, [d!.id])
    ).rows[0].p as string;
    const prev = (
      await db.admin(`SELECT ($1::date - interval '1 month')::date::text AS p`, [current])
    ).rows[0].p as string;
    // Move the open reservation (and its share of the balance) into the previous month.
    await db.admin(
      `INSERT INTO metering.usage_balance (id, workspace_id, scope_key, meter, period_start, period_end)
       SELECT gen_random_uuid(), workspace_id, scope_key, meter, $2::date, $3::date FROM metering.usage_balance
        WHERE workspace_id = $1 AND period_start = $3::date ON CONFLICT DO NOTHING`,
      [wsId, prev, current],
    );
    await db.admin(
      `UPDATE metering.usage_balance b SET reserved = b.reserved + r.amount FROM metering.usage_reservation r
        WHERE r.dispatch_id = $1 AND b.meter = r.meter AND b.workspace_id = r.workspace_id AND b.period_start = $2::date`,
      [d!.id, prev],
    );
    await db.admin(
      `UPDATE metering.usage_balance b SET reserved = b.reserved - r.amount FROM metering.usage_reservation r
        WHERE r.dispatch_id = $1 AND b.meter = r.meter AND b.workspace_id = r.workspace_id AND b.period_start = $2::date`,
      [d!.id, current],
    );
    await db.admin(
      `UPDATE metering.usage_reservation SET period_start = $2::date WHERE dispatch_id = $1`,
      [d!.id, prev],
    );
    const carried = await ledger(db, wsId);
    // The carried reservation still counts against the current period's hard limit.
    const est = await env.svc.estimateAiRun(owner, ws, { prompt: 'After rollover' });
    expect(micros(est.usage.reserved.micros)).toBeGreaterThanOrEqual(micros(d!.reserved));
    const consumedNow = micros(est.usage.consumed.micros);
    const room = (consumedNow + micros(d!.reserved) + micros(est.max_cost.micros) / 2).toFixed(6);
    await setLimit('ai.cost', '0', room);
    expect(
      (await env.svc.estimateAiRun(owner, ws, { prompt: 'After rollover' })).within_limits,
    ).toBe(false);
    await setLimit('ai.cost', '1000000', '1000000');
    // Late usage settles once, into the current period (a correction), and the closed period's hold is released.
    await stepped(env, () =>
      env.svc.reconcileAiDispatch(
        owner,
        ws,
        r.data.id,
        '1',
        { basis: 'reported', input_tokens: 5, output_tokens: 1 },
        stepUp(),
      ),
    );
    const events = await db.admin(
      `SELECT period_start::text AS p, cost_basis FROM metering.usage_event WHERE dispatch_id = $1 AND meter = 'ai.cost'`,
      [d!.id],
    );
    expect(events.rows).toEqual([{ p: current, cost_basis: 'reported' }]);
    const after = await ledger(db, wsId);
    expect(after.reserved).toBe(carried.reserved - micros(d!.reserved));
    expect(after.balances.find((b) => b.meter === 'ai.cost' && b.period === prev)!.reserved).toBe(
      '0.000000',
    );
  });

  it('AT-377 crossing a spend threshold tells owners and administrators once, never members or the content', async () => {
    const r0 = await run({ prompt: 'Threshold baseline' });
    const w = await aiWorker(env);
    await drain(db, w, r0.data.id);
    const l = await ledger(db, wsId);
    const est = await env.svc.estimateAiRun(owner, ws, { prompt: 'Threshold crossing' });
    // A hard limit at which the next reservation crosses 80 percent but not 100.
    const hard = ((l.consumed + micros(est.max_cost.micros)) / 0.85).toFixed(6);
    await setLimit('ai.cost', '0', hard);
    const beforeEvents = (await outboxEvents(db, wsId, 'metering.usage.threshold_reached')).length;
    const r = await run({ prompt: 'Threshold crossing' });
    await drain(db, w, r.data.id);
    const events = (await outboxEvents(db, wsId, 'metering.usage.threshold_reached')).slice(
      beforeEvents,
    );
    expect(events.map((e) => e.data)).toEqual([{ meter: 'ai.cost', threshold_bp: 8000 }]);
    const fan = new NotificationFanOut({
      notifyFanoutRecipientsMax: DEFAULT_WORK_SETTINGS.notifyFanoutRecipientsMax,
      notifyDedupeWindowMinutes: DEFAULT_WORK_SETTINGS.notifyDedupeWindowMinutes,
      notifyEmailPerHourMax: DEFAULT_WORK_SETTINGS.notifyEmailPerHourMax,
      notifyFactsMaxBytes: DEFAULT_WORK_SETTINGS.notifyFactsMaxBytes,
      principalContextArrayMax: 10_000,
    });
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) => fan.handle(tx, events[0]!));
    const rows = await db.admin(
      `SELECT recipient_membership_id AS m, facts::text AS facts FROM notify.notification WHERE workspace_id = $1 AND type = 'spend_threshold'`,
      [wsId],
    );
    const ids = await Promise.all(
      [owner, admin, member].map(
        async (c) => (await membershipOf(db, wsId, c.auth.account.id))!.id,
      ),
    );
    expect(rows.rows.map((x) => x.m).sort()).toEqual([ids[0], ids[1]].sort());
    expect(rows.rows[0]!.facts).not.toContain('Threshold crossing');
    // The same threshold is not announced again in this period.
    const r2 = await run({ prompt: 'Threshold again' });
    await drain(db, w, r2.data.id);
    expect(
      (await outboxEvents(db, wsId, 'metering.usage.threshold_reached')).slice(beforeEvents),
    ).toHaveLength(1);
    await setLimit('ai.cost', '1000000', '1000000');
    await ledger(db, wsId);
  });
});
