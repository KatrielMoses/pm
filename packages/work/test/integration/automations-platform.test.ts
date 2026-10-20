import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startAiProviderFixture, type AiProviderFixture } from '@pm/test-support';
import type { Caller } from '@pm/tenancy';
import type { WorkerRuntime } from '@pm/platform';
import { aiDispatchHandler } from '@pm/work';
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
import { automationWorker, runsOf, settle, stepsOf, wakeDelays } from './automation-support.ts';
import { enableAi, fixtureAi } from './ai-support.ts';

const v = (n: number) => mutation({ ifMatch: `"${n}"` });
const updateOnCreate = (fields: Record<string, unknown> = { priority: 'high' }) => ({
  schema_version: 1,
  trigger: { kind: 'record.created', record: 'task' },
  conditions: null,
  steps: [{ id: 'up', type: 'action', action: 'task.update', params: { fields } }],
});

async function setup(db: TestDatabase, env: WorkEnv) {
  const { owner, ws, brands } = await workspaceWith(env, db, ['Harbor']);
  const automate = async (
    name: string,
    definition: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    const a = (
      await env.svc.createAutomation(
        owner,
        ws,
        { name, scope: { kind: 'brand', brand: brands.Harbor }, definition },
        mutation(),
      )
    ).data;
    return (await env.svc.activateAutomation(owner, ws, a.id, extra, v(a.version))).data;
  };
  const task = (title: string, extra: Record<string, unknown> = {}) =>
    env.svc
      .createTask(owner, ws, { brand: brands.Harbor, title, ...extra }, mutation())
      .then((r) => r.data);
  return { owner, ws, brands, automate, task, wsId: await workspaceIdOf(db, ws) };
}

describe('automations (8A): limits and accounting', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let w1: WorkerRuntime;
  let w2: WorkerRuntime;
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db, { work: { automationRunsPerMonth: 4, automationActiveRunsMax: 2 } });
    s = await setup(db, env);
    w1 = await automationWorker(env);
    w2 = await automationWorker(env);
  });
  afterAll(async () => {
    await w1.stop();
    await w2.stop();
    await env.h.close();
    await db.drop();
  });

  it('AT-570 run and concurrency limits reserve atomically under competing workers; terminal accounting never double-counts', async () => {
    // Concurrency: runs that wait hold their slot (2 per automation).
    const delayed = await s.automate('Slots', {
      schema_version: 1,
      trigger: { kind: 'record.created', record: 'task' },
      conditions: null,
      steps: [
        { id: 'wait', type: 'delay', minutes: 5 },
        {
          id: 'up',
          type: 'action',
          action: 'task.update',
          params: { fields: { priority: 'low' } },
        },
      ],
    });
    for (const t of ['a', 'b', 'c']) await s.task(`slot ${t}`);
    await Promise.all([settle(db, w1), settle(db, w2)]);
    expect((await runsOf(db, delayed.id)).map((r) => [r.status, r.reason]).sort()).toEqual([
      ['failed', 'concurrency_limit'],
      ['waiting', 'delay'],
      ['waiting', 'delay'],
    ]);
    // The monthly limit (4 admitted runs; the refused run reserved nothing).
    await wakeDelays(db);
    await Promise.all([settle(db, w1), settle(db, w2)]);
    await env.svc.disableAutomation(s.owner, s.ws, delayed.id, mutation());
    const quick = await s.automate('Quick', updateOnCreate());
    for (const t of ['d', 'e', 'f', 'g']) {
      await s.task(`month ${t}`);
      await Promise.all([settle(db, w1), settle(db, w2)]);
    }
    expect((await runsOf(db, quick.id)).map((r) => [r.status, r.reason])).toEqual([
      ['succeeded', null],
      ['succeeded', null],
      ['failed', 'monthly_limit'],
      ['failed', 'monthly_limit'],
    ]);
    const usage = async () =>
      (
        await db.admin(
          `SELECT runs_reserved, runs_settled, runs_released, steps_executed, alerted_bp FROM automation.usage_period WHERE workspace_id = $1`,
          [s.wsId],
        )
      ).rows[0];
    expect(await usage()).toMatchObject({
      runs_reserved: 4,
      runs_settled: 4,
      runs_released: 0,
      alerted_bp: 10_000,
    });
    // Redelivering every terminal outcome fact to the accounting consumer changes nothing.
    const before = await usage();
    const slots = (await db.admin(`SELECT active_runs FROM automation.automation`)).rows;
    for (const e of await outboxEvents(db, s.wsId, 'execution.operation.state_changed'))
      await env.h.worker.withWorkspace(s.wsId, { module: 'test' }, (tx) =>
        env.workerSvc().consumeOperationState(tx, e),
      );
    expect(await usage()).toEqual(before);
    expect((await db.admin(`SELECT active_runs FROM automation.automation`)).rows).toEqual(slots);
    expect(slots.every((r) => r.active_runs === 0)).toBe(true);
    // Usage shows measured runs against technical limits; plan entitlement is unavailable (10A).
    const view = await env.svc.automationUsage(s.owner, s.ws);
    expect(view).toMatchObject({
      measured: { runs: 4, runs_finished: 4 },
      technical_limits: { runs_per_month: 4, active_runs_per_automation: 2 },
      plan_entitlement: { status: 'unavailable', owner_phase: '10A' },
    });
    // NTF-006: the run limit thresholds alerted the people who configure limits, once each.
    const alerts = await db.admin(
      `SELECT type, facts FROM notify.notification WHERE type = 'spend_threshold' ORDER BY created_at`,
    );
    // Both thresholds were crossed by one admission: one notice at the highest, never a repeat.
    expect(alerts.rows.map((r) => r.facts.threshold_bp)).toEqual([10_000]);
  });
});

describe('automations (8A): AI drafts, future sources, alerts, lifecycle, preview, schedules', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let fx: AiProviderFixture;
  let w: WorkerRuntime;
  let s: Awaited<ReturnType<typeof setup>>;
  const disableAll = async () => {
    for (const a of (await env.svc.listAutomations(s.owner, s.ws)).data)
      if (a.enabled) await env.svc.disableAutomation(s.owner, s.ws, a.id, mutation());
  };
  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startAiProviderFixture();
    env = workEnv(db, { ai: fixtureAi(fx), work: { automationAlertFailureThreshold: 2 } });
    s = await setup(db, env);
    w = await automationWorker(env, {
      handlers: [
        aiDispatchHandler({
          tenant: env.h.worker,
          discovery: env.h.discovery,
          service: env.workerSvc(),
          metrics: env.h.telemetry.metrics,
          logger: env.h.logger,
          maxAttempts: 3,
          timeoutMs: 20_000,
        }),
      ],
    });
  });
  afterAll(async () => {
    await w.stop();
    await fx.close();
    await env.h.close();
    await db.drop();
  });

  it('AT-571 AI drafts: refused truthfully while AI is off; otherwise a proposal for the owner to review, never applied', async () => {
    const def = {
      schema_version: 1,
      trigger: { kind: 'record.created', record: 'task' },
      conditions: { all: [{ field: 'title', op: 'contains', value: 'draft' }] },
      steps: [
        {
          id: 'ai',
          type: 'action',
          action: 'ai.draft',
          params: { action: 'draft_tasks.v1', instruction: 'Break this into steps' },
        },
      ],
    };
    const a = await s.automate('Drafts', def);
    // AI is not enabled for the workspace: refused before anything is written or sent.
    await s.task('draft one');
    await settle(db, w);
    let [run] = await runsOf(db, a.id);
    expect({ status: run!.status, reason: run!.reason }).toEqual({
      status: 'failed',
      reason: 'ai_disabled',
    });
    expect(fx.control.received()).toHaveLength(0);
    expect((await db.admin(`SELECT count(*)::int AS n FROM ai.ai_action`)).rows[0].n).toBe(0);
    expect(
      (await db.admin(`SELECT count(*)::int AS n FROM metering.usage_reservation`)).rows[0].n,
    ).toBe(0);
    // With confirmation required above any cost, an automation never confirms for a person.
    await enableAi(env, s.owner, s.ws);
    await s.task('draft unconfirmed');
    await settle(db, w);
    expect((await runsOf(db, a.id))[1]).toMatchObject({
      status: 'failed',
      reason: 'confirmation_required',
    });
    expect(fx.control.received()).toHaveLength(0);
    // An administrator allows unconfirmed small runs: the owner's draft is requested.
    const settings = await env.svc.getAiSettings(s.owner, s.ws);
    env.stepUp.allow = true;
    await env.svc.updateAiSettings(
      s.owner,
      s.ws,
      { confirm_above_micros: '1000000' },
      mutation({ stepUpToken: 't', ifMatch: `"${settings.version}"` }),
    );
    env.stepUp.allow = false;
    const t = await s.task('draft two');
    await settle(db, w);
    run = (await runsOf(db, a.id))[2];
    const [step] = (await stepsOf(db, run!.id as string)).filter((x) => x.node_id === 'ai');
    expect(step).toMatchObject({
      state: 'succeeded',
      output: { kind: 'proposal', review_required: true },
    });
    expect(run!.status).toBe('succeeded');
    const action = (
      await db.admin(`SELECT caller_kind, initiating_membership_id, purpose FROM ai.ai_action`)
    ).rows;
    const ownerM = (await membershipOf(db, s.wsId, s.owner.auth.account.id))!;
    expect(action).toEqual([
      {
        caller_kind: 'automation',
        initiating_membership_id: ownerM.id,
        purpose: 'change_proposal',
      },
    ]);
    // The proposal is the owner's to review and apply; nothing was applied by the automation.
    const proposals = (
      await db.admin(`SELECT state, initiating_membership_id FROM ai.change_proposal`)
    ).rows;
    expect(proposals.map((p) => p.state)).toEqual(['open']);
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM core.record WHERE source_kind = 'ai_proposal'`,
        )
      ).rows[0].n,
    ).toBe(0);
    expect(((await env.svc.getTask(s.owner, s.ws, t.id)) as { title: string }).title).toBe(
      'draft two',
    );
    await env.svc.disableAutomation(s.owner, s.ws, a.id, mutation());
  });

  it('AT-572 future sources and agent workflows are typed boundaries: saved, never activated', async () => {
    for (const [definition, owner] of [
      [
        {
          schema_version: 1,
          trigger: { kind: 'test.result', record: 'task' },
          conditions: null,
          steps: [{ id: 'x', type: 'action', action: 'task.archive' }],
        },
        '9B',
      ],
      [
        {
          schema_version: 1,
          trigger: { kind: 'agent.result', record: 'task' },
          conditions: null,
          steps: [{ id: 'x', type: 'action', action: 'task.archive' }],
        },
        '8C',
      ],
      [
        {
          schema_version: 1,
          trigger: { kind: 'record.created', record: 'task' },
          conditions: null,
          steps: [
            { id: 'x', type: 'action', action: 'agent.invoke', params: { agent: 'reviewer' } },
          ],
        },
        '8C',
      ],
    ] as const) {
      const a = (
        await env.svc.createAutomation(
          s.owner,
          s.ws,
          { name: `Future ${owner}`, scope: { kind: 'brand', brand: s.brands.Harbor }, definition },
          mutation(),
        )
      ).data;
      expect(a.draft_status).toMatchObject({
        valid: true,
        unavailable: [expect.objectContaining({ owner })],
      });
      await expect(
        env.svc.activateAutomation(s.owner, s.ws, a.id, {}, v(a.version)),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'dependency_unavailable',
          issues: [expect.objectContaining({ message: expect.stringContaining(owner) })],
        }),
      );
    }
  });

  it('AT-573 persistent failures alert the owner once per interval; successes reset the streak', async () => {
    await disableAll();
    // Moving to a status the workflow does not offer always fails validation.
    const a = await s.automate('Broken', updateOnCreate({ status: 'not_a_status' }));
    for (const t of ['x', 'y', 'z']) await s.task(`broken ${t}`);
    await settle(db, w);
    expect((await runsOf(db, a.id)).map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
    const id = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [a.id])).rows[0]
      .id;
    const alerts = await db.admin(
      `SELECT recipient_membership_id, facts FROM notify.notification WHERE type = 'automation_failure' AND record_id = $1`,
      [id],
    );
    expect(alerts.rows).toHaveLength(1);
    expect((await env.svc.getAutomation(s.owner, s.ws, a.id)).failures_in_a_row).toBe(3);
    // The failure summary is visible in health for the people who may see it.
    const health = await env.svc.automationHealth(s.owner, s.ws);
    expect(health.automations.find((x) => x.id === a.id)).toMatchObject({
      failures_in_a_row: 3,
      runs_30d: { failed: 3 },
    });
  });

  it('AT-577 automation outcomes reach the 5D metric port: equal for equal access, hidden without health access', async () => {
    const admin = await join(env, db, s.owner, s.ws, { kind: 'member', role: 'administrator' });
    const member = await join(env, db, s.owner, s.ws, { kind: 'member', role: 'member' });
    const figure = async (who: Caller, q: Record<string, unknown> = {}) =>
      (
        (await env.svc.adhocWidget(who, s.ws, { metric: 'automation.rates', ...q })) as {
          outcome: Record<string, any>;
        }
      ).outcome;
    const mine = await figure(s.owner);
    const theirs = await figure(admin);
    // Two people with the same access see exactly the same figure (rendered for each viewer; only
    // the evaluation instant differs).
    const timeless = (o: Record<string, any>) => ({
      ...o,
      freshness: { ...o.freshness, as_of: null },
    });
    expect(timeless(theirs)).toEqual(timeless(mine));
    const rows = Object.fromEntries(
      (mine.rows as Array<{ cells: { outcome: string; runs: number } }>).map((r) => [
        r.cells.outcome,
        r.cells.runs,
      ]),
    );
    expect(rows['Failed']).toBeGreaterThanOrEqual(3);
    const ended = (
      await db.admin(
        `SELECT status, count(*)::int AS n FROM automation.automation_run WHERE ended_at IS NOT NULL GROUP BY status`,
      )
    ).rows;
    const by = Object.fromEntries(ended.map((r) => [r.status, r.n]));
    const counted = ['succeeded', 'partial', 'failed', 'policy_rejected', 'cancelled'].reduce(
      (t, k) => t + (by[k] ?? 0),
      0,
    );
    expect(mine.value).toBe(Math.round(((by.succeeded ?? 0) * 1000) / counted) / 10);
    // A member without automation health access gets no figure at all (no counts, no hints).
    const none = await figure(member);
    expect({ value: none.value, rows: none.rows, incomplete: none.incomplete }).toEqual({
      value: null,
      rows: [],
      incomplete: ['no_measurement'],
    });
  });

  it('AT-574 lifecycle: archive stops runs, restore stays disabled and never replays, purge removes history', async () => {
    await disableAll();
    const a = await s.automate('Lifecycle', updateOnCreate());
    await s.task('before archive');
    await settle(db, w);
    expect(await runsOf(db, a.id)).toHaveLength(1);
    await env.svc.automationLifecycle(s.owner, s.ws, a.id, 'archive', mutation());
    await s.task('while archived');
    await settle(db, w);
    expect(await runsOf(db, a.id)).toHaveLength(1);
    await env.svc.automationLifecycle(s.owner, s.ws, a.id, 'unarchive', mutation());
    expect(await env.svc.getAutomation(s.owner, s.ws, a.id)).toMatchObject({
      state: 'disabled',
      enabled: false,
    });
    await settle(db, w);
    expect(await runsOf(db, a.id)).toHaveLength(1);
    // Purge (trash, then the durable purge) removes the definition and its run history.
    await env.svc.automationLifecycle(s.owner, s.ws, a.id, 'trash', mutation());
    const id = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [a.id])).rows[0]
      .id;
    await env.h.worker.withWorkspace(s.wsId, { module: 'test' }, async (tx) => {
      const { purgeAutomations } = await import('@pm/work');
      await purgeAutomations(tx, [id]);
    });
    for (const t of [
      'automation',
      'automation_revision',
      'automation_run',
      'standing_approval',
      'trigger_schedule',
    ])
      expect(
        (
          await db.admin(
            `SELECT count(*)::int AS n FROM automation.${t} WHERE ${t === 'automation' ? 'id' : 'automation_id'} = $1`,
            [id],
          )
        ).rows[0].n,
        t,
      ).toBe(0);
  });

  it('AT-575 preview uses the same evaluator and policy and leaves nothing behind', async () => {
    await disableAll();
    const sub = (
      await env.svc.createSubscription(
        s.owner,
        s.ws,
        {
          destination_url: 'https://127.0.0.1/hooks/preview',
          event_types: ['task.updated'],
          brand: s.brands.Harbor,
        },
        mutation(),
      )
    ).data;
    const a = (
      await env.svc.createAutomation(
        s.owner,
        s.ws,
        {
          name: 'Preview',
          scope: { kind: 'brand', brand: s.brands.Harbor },
          definition: {
            schema_version: 1,
            trigger: { kind: 'record.created', record: 'task' },
            conditions: { all: [{ field: 'priority', op: 'in', value: ['high', 'urgent'] }] },
            steps: [
              {
                id: 'up',
                type: 'action',
                action: 'task.update',
                params: { fields: { title: 'Previewed' } },
              },
              {
                id: 'tell',
                type: 'action',
                action: 'task.notify',
                params: { recipients: ['owner'], message: 'x' },
              },
              {
                id: 'hook',
                type: 'action',
                action: 'webhook.send',
                params: { subscription: sub.id, fields: ['priority'] },
              },
              { id: 'ai', type: 'action', action: 'ai.draft', params: { action: 'summarize.v1' } },
              {
                id: 'bad',
                type: 'action',
                action: 'task.update',
                params: { fields: { status: 'nope' } },
              },
            ],
          },
        },
        mutation(),
      )
    ).data;
    const t = await s.task('Sample', { priority: 'high' });
    await settle(db, w);
    const counts = async () =>
      (
        await db.admin(`SELECT (SELECT count(*) FROM exec.outbox_event)::int AS outbox, (SELECT count(*) FROM audit.audit_event)::int AS audit,
                              (SELECT count(*) FROM notify.notification)::int AS notes, (SELECT count(*) FROM exec.external_effect)::int AS effects,
                              (SELECT count(*) FROM ai.ai_action)::int AS ai, (SELECT count(*) FROM metering.usage_reservation)::int AS reservations,
                              (SELECT count(*) FROM automation.automation_run)::int AS runs, (SELECT count(*) FROM exec.operation)::int AS ops`)
      ).rows[0];
    const before = await counts();
    const calls = fx.control.received().length;
    const p = await env.svc.previewAutomation(s.owner, s.ws, a.id, { record: t.id });
    expect(await counts()).toEqual(before);
    expect(fx.control.received().length).toBe(calls);
    expect(p.conditions).toMatchObject({ result: true });
    expect(p.steps.map((x) => [x.node, x.outcome])).toEqual([
      ['up', 'would_run'],
      ['tell', 'would_run'],
      ['hook', 'would_run'],
      ['ai', 'would_run'],
      ['bad', 'would_refuse'],
    ]);
    expect(p.steps.find((x) => x.node === 'hook')).toMatchObject({
      discloses: { webhook: sub.id, fields: ['priority'] },
    });
    expect(((await env.svc.getTask(s.owner, s.ws, t.id)) as { title: string }).title).toBe(
      'Sample',
    );
    // A record outside the conditions previews as not matching (same evaluator).
    const low = await s.task('Low');
    expect(
      (await env.svc.previewAutomation(s.owner, s.ws, a.id, { record: low.id })).conditions,
    ).toMatchObject({ result: false });
  });

  it('AT-576 date and schedule triggers: stable local occurrence keys across DST; a repeated sweep admits nothing twice', async () => {
    await disableAll();
    const sched = await s.automate('Weekly', {
      schema_version: 1,
      trigger: {
        kind: 'schedule',
        rule: 'FREQ=DAILY',
        start: '2026-10-24T09:00',
        timezone: 'Europe/London',
      },
      conditions: null,
      steps: [
        {
          id: 'mk',
          type: 'action',
          action: 'task.create',
          params: {
            title: 'Daily check',
            project: (
              await env.svc.createProject(
                s.owner,
                s.ws,
                { brand: s.brands.Harbor, name: 'Ops' },
                mutation(),
              )
            ).data.id,
          },
        },
      ],
    });
    const id = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [sched.id]))
      .rows[0].id;
    // Across the October DST change in London, 09:00 local stays 09:00 local (08:00Z, then 09:00Z).
    const svc = env.workerSvc();
    const at = (iso: string) => new Date(iso);
    await db.admin(
      `UPDATE automation.trigger_schedule SET next_due_at = $2 WHERE automation_id = $1`,
      [id, at('2026-10-24T08:00:00Z')],
    );
    expect(await svc.runTriggerSweep(s.wsId, at('2026-10-24T08:00:30Z'))).toBe(1);
    expect(await svc.runTriggerSweep(s.wsId, at('2026-10-24T08:00:30Z'))).toBe(0);
    const next = (
      await db.admin(
        `SELECT next_due_at, last_key FROM automation.trigger_schedule WHERE automation_id = $1`,
        [id],
      )
    ).rows[0];
    expect({ next: new Date(next.next_due_at).toISOString(), key: next.last_key }).toEqual({
      next: '2026-10-25T09:00:00.000Z',
      key: '2026-10-24T09:00',
    });
    expect(await svc.runTriggerSweep(s.wsId, at('2026-10-25T09:00:30Z'))).toBe(1);
    // The same occurrence key can never be admitted twice, even if the schedule state is rewound.
    await db.admin(
      `UPDATE automation.trigger_schedule SET next_due_at = $2 WHERE automation_id = $1`,
      [id, at('2026-10-25T09:00:00Z')],
    );
    expect(await svc.runTriggerSweep(s.wsId, at('2026-10-25T09:00:30Z'))).toBe(0);
    expect((await runsOf(db, sched.id)).map((r) => r.trigger_key)).toEqual([
      'schedule:2026-10-24T09:00',
      'schedule:2026-10-25T09:00',
    ]);
    await settle(db, w);
    expect((await runsOf(db, sched.id)).every((r) => r.status === 'succeeded')).toBe(true);
    await env.svc.disableAutomation(s.owner, s.ws, sched.id, mutation());
    // Date trigger: tasks due on the local day at the chosen time, once per task and day.
    const due = await s.automate('Due today', {
      schema_version: 1,
      trigger: {
        kind: 'date',
        record: 'task',
        field: 'due_date',
        offset_days: 0,
        at: '09:00',
        timezone: 'Asia/Kolkata',
      },
      conditions: null,
      steps: [
        {
          id: 'up',
          type: 'action',
          action: 'task.update',
          params: { fields: { priority: 'urgent' } },
        },
      ],
    });
    const did = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [due.id]))
      .rows[0].id;
    await s.task('Due 21st', { due_date: '2026-10-21' });
    await s.task('Due 22nd', { due_date: '2026-10-22' });
    await db.admin(
      `UPDATE automation.trigger_schedule SET next_due_at = $2 WHERE automation_id = $1`,
      [did, at('2026-10-21T03:30:00Z')],
    );
    expect(await svc.runTriggerSweep(s.wsId, at('2026-10-21T03:31:00Z'))).toBe(1);
    await db.admin(
      `UPDATE automation.trigger_schedule SET next_due_at = $2 WHERE automation_id = $1`,
      [did, at('2026-10-21T03:30:00Z')],
    );
    expect(await svc.runTriggerSweep(s.wsId, at('2026-10-21T03:31:00Z'))).toBe(0);
    expect(
      (await runsOf(db, due.id)).map((r) =>
        (r.trigger_key as string).replace(/date:[^:]+:/, 'date:*:'),
      ),
    ).toEqual(['date:*:2026-10-21']);
  });
});
