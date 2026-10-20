import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import type { EffectBarriers, WorkerRuntime } from '@pm/platform';
import type { WebhookTransport } from '@pm/work';
import { mutation, workEnv, workspaceWith, type WorkEnv } from './fixture.ts';
import { automationWorker, runsOf, settle, stepsOf } from './automation-support.ts';

const v = (n: number, extra: Record<string, unknown> = {}) => mutation({ ifMatch: `"${n}"`, ...extra });
const never = () => new Promise<void>(() => undefined);
const issueOf = (c: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code: c })]) });

/**
 * Phase 8A outbound actions (AUTO-008) on the P8-W0 effect ledger: an exact standing approval
 * (revision, destination, fields, scope) recorded under step-up, payloads with only the approved
 * structural fields, one counted claim before any request, and conservative unknown handling:
 * an ambiguous send to this unsafe destination is never repeated automatically; only the owner
 * or an administrator's step-up reconciliation (sent, retry, abandon) moves it on.
 */
describe('automations (8A): outbound effects', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let brands: Record<string, string>;
  const sent: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  let answer: number | 'network' = 200;
  let barriers: EffectBarriers = {};
  const workers: WorkerRuntime[] = [];

  const transport: WebhookTransport = async (req) => {
    sent.push({ url: req.url, body: JSON.parse(req.body), headers: req.headers });
    return answer === 'network' ? { kind: 'network' } : { kind: 'status', status: answer };
  };
  const worker = async () => {
    const w = await automationWorker(env, {
      effectBarriers: {
        afterClaim: (k) => barriers.afterClaim?.(k) ?? Promise.resolve(),
        afterPerform: (k) => barriers.afterPerform?.(k) ?? Promise.resolve(),
        duringOutcome: (k) => barriers.duringOutcome?.(k) ?? Promise.resolve(),
      },
    });
    workers.push(w);
    return w;
  };
  let w: WorkerRuntime;

  const hook = async (path: string) =>
    (await env.svc.createSubscription(owner, ws, { destination_url: `https://127.0.0.1/hooks/${path}`, event_types: ['task.updated'], brand: brands.Harbor }, mutation())).data;
  const definition = (subscription: string) => ({
    schema_version: 1,
    trigger: { kind: 'record.created', record: 'task' },
    conditions: { all: [{ field: 'title', op: 'contains', value: 'hook' }] },
    steps: [
      { id: 'send', type: 'action', action: 'webhook.send', params: { subscription, fields: ['priority', 'status'] } },
      { id: 'after', type: 'action', action: 'task.update', params: { fields: { priority: 'low' } } },
    ],
  });
  const automate = async (name: string, sub: string) => {
    const a = (await env.svc.createAutomation(owner, ws, { name, scope: { kind: 'brand', brand: brands.Harbor }, definition: definition(sub) }, mutation())).data;
    env.stepUp.allow = true;
    try {
      return (await env.svc.activateAutomation(owner, ws, a.id, { approvals: [{ node: 'send', webhook: sub, fields: ['priority', 'status'] }] }, v(a.version, { stepUpToken: 't' }))).data;
    } finally {
      env.stepUp.allow = false;
    }
  };
  const disableAll = async () => {
    for (const a of (await env.svc.listAutomations(owner, ws)).data)
      if (a.enabled) await env.svc.disableAutomation(owner, ws, a.id, mutation());
  };
  const effect = async (opId: string) =>
    (await db.admin(`SELECT state::text AS state, destination_class::text AS class, attempt_count, uncertainty_reason, late_outcome, version::int AS version, effect_key FROM exec.external_effect WHERE operation_id = $1`, [opId])).rows;
  const decide = async (opPublic: string, key: string, decision: string, version: number) => {
    env.stepUp.allow = true;
    try {
      return await env.svc.reconcileExternalEffect(owner, ws, opPublic, key, { decision, version }, mutation({ stepUpToken: 't' }));
    } finally {
      env.stepUp.allow = false;
    }
  };
  /** Starts a run whose worker stops for good at `where`, then recovers it on a new worker. */
  const crashAt = async (where: keyof EffectBarriers, title: string) => {
    const reached = new Promise<void>((resolve) => {
      barriers = { [where]: () => (resolve(), never()) };
    });
    await env.svc.createTask(owner, ws, { brand: brands.Harbor, title }, mutation());
    const doomed = await worker();
    // Dispatch the trigger, then run the job until the barrier stops the process.
    await doomed.runCycle({ wait: true });
    void doomed.runCycle().catch(() => undefined);
    await reached;
    doomed.kill();
    barriers = {};
    await db.admin(`UPDATE exec.job SET lease_until = now() - interval '1 second' WHERE state = 'leased'`);
    w = await worker();
    await settle(db, w);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db, { deliver: transport });
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor']));
    w = await worker();
  });
  afterAll(async () => {
    for (const x of workers) await x.stop().catch(() => undefined);
    await env.h.close();
    await db.drop();
  });

  it('AT-567 a webhook step needs an exact standing approval under step-up and sends only its approved fields, once', async () => {
    const sub = await hook('approved');
    const a = (await env.svc.createAutomation(owner, ws, { name: 'Hook', scope: { kind: 'brand', brand: brands.Harbor }, definition: definition(sub.id) }, mutation())).data;
    await expect(env.svc.activateAutomation(owner, ws, a.id, {}, v(a.version))).rejects.toEqual(issueOf('approval_required'));
    await expect(env.svc.activateAutomation(owner, ws, a.id, { approvals: [{ node: 'send', webhook: sub.id, fields: ['priority'] }] }, v(a.version))).rejects.toEqual(issueOf('approval_required'));
    await expect(env.svc.activateAutomation(owner, ws, a.id, { approvals: [{ node: 'send', webhook: sub.id, fields: ['priority', 'status'] }] }, v(a.version))).rejects.toEqual(expect.objectContaining({ code: 'step_up_required' }));
    env.stepUp.allow = true;
    await env.svc.activateAutomation(owner, ws, a.id, { approvals: [{ node: 'send', webhook: sub.id, fields: ['status', 'priority'] }] }, v(a.version, { stepUpToken: 't' }));
    env.stepUp.allow = false;
    const t = (await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'hook once', priority: 'high' }, mutation())).data;
    await settle(db, w);
    const [run] = await runsOf(db, a.id);
    expect(run!.status).toBe('succeeded');
    const mine = sent.filter((s) => s.url.endsWith('/hooks/approved'));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toMatchObject({ type: 'automation.action', data: { object: { id: t.id, type: 'task' }, fields: { priority: 'high', status: 'todo' } } });
    expect(Object.keys((mine[0]!.body as { data: { fields: object } }).data.fields).sort()).toEqual(['priority', 'status']);
    expect(JSON.stringify(mine[0]!.body)).not.toContain('hook once');
    expect(mine[0]!.headers['webhook-signature']).toMatch(/^v1,/);
    expect(await effect(run!.current_operation_id as string)).toEqual([expect.objectContaining({ state: 'sent', class: 'unsafe', attempt_count: 1 })]);
    // The destination changes: the approval no longer matches; nothing is sent.
    // (Destinations are replaced, not edited, through the 6B API; the stored URL is changed here to
    // prove the fingerprint check at send time.)
    await db.admin(`UPDATE integrations.webhook_subscription SET destination_url = 'https://127.0.0.1/hooks/elsewhere' WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`, [sub.id]);
    await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'hook moved' }, mutation());
    await settle(db, w);
    const runs = await runsOf(db, a.id);
    expect(runs.map((r) => [r.status, r.reason])).toEqual([
      ['succeeded', null],
      ['policy_rejected', 'approval_invalid'],
    ]);
    expect(sent.filter((s) => s.url.endsWith('/hooks/elsewhere'))).toHaveLength(0);
    await env.svc.disableAutomation(owner, ws, a.id, mutation());
  });

  it('AT-568 crashes around the external dispatch never resend; reconciliation resumes the run', async () => {
    await disableAll();
    const sub = await hook('crash');
    const a = await automate('Crashy', sub.id);
    const count = () => sent.filter((s) => s.url.endsWith('/hooks/crash')).length;
    // 1. The process dies after the claim, before any request: nothing left, but it is unknown
    //    (an abandoned claim); this unsafe destination waits for a person, never auto-retried.
    await crashAt('afterClaim', 'hook claim');
    let [run] = await runsOf(db, a.id);
    expect({ status: run!.status, reason: run!.reason, op: run!.execution_state }).toEqual({ status: 'waiting', reason: 'reconciliation_required', op: 'waiting' });
    expect(count()).toBe(0);
    let [e] = await effect(run!.current_operation_id as string);
    expect(e).toMatchObject({ state: 'unknown', uncertainty_reason: 'abandoned_claim' });
    await decide(run!.op_public_id, e!.effect_key as string, 'retry', e!.version as number);
    await settle(db, w);
    [run] = await runsOf(db, a.id);
    expect({ status: run!.status, sends: count() }).toEqual({ status: 'succeeded', sends: 1 });
    // 2. The process dies after the request left, before its outcome was recorded: unknown; the
    //    owner confirms it was sent; the run continues without sending again.
    await crashAt('afterPerform', 'hook perform');
    let runs = await runsOf(db, a.id);
    run = runs[1]!;
    expect({ status: run.status, reason: run.reason }).toEqual({ status: 'waiting', reason: 'reconciliation_required' });
    expect(count()).toBe(2);
    [e] = await effect(run.current_operation_id as string);
    await decide(run.op_public_id, e!.effect_key as string, 'sent', e!.version as number);
    await settle(db, w);
    runs = await runsOf(db, a.id);
    expect({ status: runs[1]!.status, sends: count() }).toEqual({ status: 'succeeded', sends: 2 });
    expect((await stepsOf(db, runs[1]!.id as string)).filter((s) => s.node_id === 'send').map((s) => s.state)).toEqual(['unknown', 'succeeded']);
    // 3. The receiver answers 5xx (it may have acted): unknown, no resend; abandon ends the run as
    //    cancelled with its liability, never "not sent" and never success.
    answer = 503;
    await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'hook ambiguous' }, mutation());
    await settle(db, w);
    runs = await runsOf(db, a.id);
    run = runs[2]!;
    expect({ status: run.status, reason: run.reason, sends: count() }).toEqual({ status: 'waiting', reason: 'reconciliation_required', sends: 3 });
    // A retry of the run is refused while the effect is uncertain.
    await expect(env.svc.retryAutomationRun(owner, ws, run.op_public_id, mutation())).rejects.toEqual(issueOf('not_retryable'));
    answer = 200;
    [e] = await effect(run.current_operation_id as string);
    await decide(run.op_public_id, e!.effect_key as string, 'abandon', e!.version as number);
    await settle(db, w);
    runs = await runsOf(db, a.id);
    expect({ status: runs[2]!.status, op: runs[2]!.execution_state, sends: count() }).toEqual({ status: 'cancelled', op: 'cancelled', sends: 3 });
    // Disabling never relabels a possibly-sent effect: a run waiting for reconciliation keeps waiting.
    answer = 'network';
    await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'hook reset' }, mutation());
    await settle(db, w);
    await env.svc.disableAutomation(owner, ws, a.id, mutation());
    await settle(db, w);
    runs = await runsOf(db, a.id);
    expect({ status: runs[3]!.status, reason: runs[3]!.reason, sends: count() }).toEqual({ status: 'waiting', reason: 'reconciliation_required', sends: 4 });
    answer = 200;
  });

  it('AT-569 a stale claimant after lease loss records late evidence only (fenced), and the run waits', async () => {
    await disableAll();
    const sub = await hook('late');
    const a = await automate('Late', sub.id);
    let releaseOutcome!: () => void;
    const reached = new Promise<void>((resolve) => {
      barriers = { afterPerform: () => (resolve(), new Promise<void>((r) => (releaseOutcome = r))) };
    });
    await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'hook late' }, mutation());
    const slow = await worker();
    await slow.runCycle({ wait: true });
    const pending = slow.runCycle({ wait: true });
    await reached;
    barriers = {};
    // The lease expires and another worker recovers the attempt: the claim becomes unknown.
    await db.admin(`UPDATE exec.job SET lease_until = now() - interval '1 second' WHERE state = 'leased'`);
    await w.reapExpiredLeases();
    releaseOutcome();
    await pending;
    await settle(db, w);
    const [run] = await runsOf(db, a.id);
    const [e] = await effect(run!.current_operation_id as string);
    expect(e).toMatchObject({ state: 'unknown' });
    expect(e!.late_outcome).toBe('sent');
    expect({ status: run!.status, reason: run!.reason }).toEqual({ status: 'waiting', reason: 'reconciliation_required' });
    expect(sent.filter((s) => s.url.endsWith('/hooks/late'))).toHaveLength(1);
    await slow.stop();
  });
});
