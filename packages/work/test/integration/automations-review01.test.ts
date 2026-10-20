import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import type { EffectBarriers, WorkerRuntime } from '@pm/platform';
import type { WebhookTransport } from '@pm/work';
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
import { automationWorker, runsOf, settle, stepsOf } from './automation-support.ts';

const v = (n: number, extra: Record<string, unknown> = {}) =>
  mutation({ ifMatch: `"${n}"`, ...extra });
const never = () => new Promise<void>(() => undefined);
const code = (c: string) => expect.objectContaining({ code: c });
const issueOf = (c: string) =>
  expect.objectContaining({
    issues: expect.arrayContaining([expect.objectContaining({ code: c })]),
  });

/**
 * Phase 8A corrective review 01.
 *
 * R1: a configured webhook's non-success answer is not proof that it did not act. The controlled
 * receiver below applies (counts) every request it receives and then answers 400, 408, or 429:
 * the effect stays unknown, the run waits for reconciliation, and nothing is sent again.
 *
 * R2: a checkpoint holds references only, and authority is decided again immediately before the
 * request leaves. Barriers stop the worker after the preparation committed and the claim was
 * taken; owner authority, the target, the approval, or the destination then change while the
 * subscription stays active, and the stale payload must never leave. A real worker restart
 * reusing the stored checkpoint gets the same guard. Unique content sentinels prove nothing of
 * the payload stays in execution metadata or logs, before and after purge.
 *
 * R3: a completed lifecycle key replays only through the caller's current authority.
 */
describe('automations (8A): corrective review 01', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let manager: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  /** Every request the receiver accepted and applied, by path. */
  const applied: Array<{ path: string; body: Record<string, unknown> }> = [];
  let answer: number | 'network' = 200;
  let barriers: EffectBarriers = {};
  const workers: WorkerRuntime[] = [];
  let w: WorkerRuntime;

  const transport: WebhookTransport = async (req) => {
    applied.push({ path: new URL(req.url).pathname, body: JSON.parse(req.body) });
    return answer === 'network' ? { kind: 'network' } : { kind: 'status', status: answer };
  };
  const at = (path: string) => applied.filter((x) => x.path === `/hooks/${path}`).length;
  const worker = async () => {
    const x = await automationWorker(env, {
      effectBarriers: {
        afterClaim: (k) => barriers.afterClaim?.(k) ?? Promise.resolve(),
        afterPerform: (k) => barriers.afterPerform?.(k) ?? Promise.resolve(),
        duringOutcome: (k) => barriers.duringOutcome?.(k) ?? Promise.resolve(),
      },
    });
    workers.push(x);
    return x;
  };
  const mem = async (who: Caller) => (await membershipOf(db, wsId, who.auth.account.id))!.public_id;
  const hook = async (as: Caller, path: string) =>
    (
      await env.svc.createSubscription(
        as,
        ws,
        {
          destination_url: `https://127.0.0.1/hooks/${path}`,
          event_types: ['task.updated'],
          brand: brands.Harbor,
        },
        mutation(),
      )
    ).data;
  const automate = async (as: Caller, name: string, sub: string, title: string) => {
    const a = (
      await env.svc.createAutomation(
        as,
        ws,
        {
          name,
          scope: { kind: 'brand', brand: brands.Harbor },
          definition: {
            schema_version: 1,
            trigger: { kind: 'record.created', record: 'task' },
            conditions: { all: [{ field: 'title', op: 'contains', value: title }] },
            steps: [
              {
                id: 'send',
                type: 'action',
                action: 'webhook.send',
                params: { subscription: sub, fields: ['priority', 'due_date'] },
              },
            ],
          },
        },
        mutation(),
      )
    ).data;
    env.stepUp.allow = true;
    try {
      return (
        await env.svc.activateAutomation(
          as,
          ws,
          a.id,
          { approvals: [{ node: 'send', webhook: sub, fields: ['priority', 'due_date'] }] },
          v(a.version, { stepUpToken: 't' }),
        )
      ).data;
    } finally {
      env.stepUp.allow = false;
    }
  };
  const effects = async (opId: string) =>
    (
      await db.admin(
        `SELECT state::text AS state, attempt_count, uncertainty_reason, not_sent_code, version::int AS version, effect_key
           FROM exec.external_effect WHERE operation_id = $1 ORDER BY created_at`,
        [opId],
      )
    ).rows;
  const decide = async (opPublic: string, key: string, decision: string, version: number) => {
    env.stepUp.allow = true;
    try {
      return await env.svc.reconcileExternalEffect(
        owner,
        ws,
        opPublic,
        key,
        { decision, version },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
  };
  /** Rows of automation execution metadata (jobs, attempts, operations, effects) as text. */
  const metadata = async () =>
    (
      await db.admin(
        `SELECT j::text AS t FROM exec.job j WHERE j.workspace_id = $1 AND j.kind LIKE 'automation.%'
         UNION ALL SELECT o::text FROM exec.operation o WHERE o.workspace_id = $1 AND o.kind = 'automation_run'
         UNION ALL SELECT a::text FROM exec.attempt a JOIN exec.operation o ON o.id = a.operation_id
                    WHERE o.workspace_id = $1 AND o.kind = 'automation_run'
         UNION ALL SELECT e::text FROM exec.external_effect e WHERE e.workspace_id = $1
         UNION ALL SELECT r::text FROM automation.automation_run r WHERE r.workspace_id = $1
         UNION ALL SELECT s::text FROM automation.automation_step_run s WHERE s.workspace_id = $1`,
        [wsId],
      )
    ).rows.map((r) => r.t as string);
  const sentinel = (n: number) => `2041-0${(n % 9) + 1}-1${n % 10}`;
  let serial = 0;
  /** A trigger task with a unique due date (the disclosed content sentinel). */
  const trigger = async (title: string) => {
    const due = sentinel(++serial);
    await env.svc.createTask(
      owner,
      ws,
      { brand: brands.Harbor, title, priority: 'high', due_date: due },
      mutation(),
    );
    return due;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db, { deliver: transport });
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor']));
    wsId = await workspaceIdOf(db, ws);
    manager = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(manager),
      level: 'manage',
    });
    w = await worker();
  });
  // Each case starts from the same state, whatever an earlier case left behind.
  beforeEach(async () => {
    barriers = {};
    answer = 200;
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(manager),
      level: 'manage',
    }).catch(() => undefined);
    for (const a of (await env.svc.listAutomations(owner, ws)).data)
      if (a.enabled) await env.svc.disableAutomation(owner, ws, a.id, mutation());
  });
  afterAll(async () => {
    for (const x of workers) await x.stop().catch(() => undefined);
    await env.h.close();
    await db.drop();
  });

  it('AT-589 R1: a receiver that applies and then answers 400, 408, or 429 leaves an unknown outcome, never proof of non-application; a pre-dispatch refusal stays proven not sent', async () => {
    const sub = await hook(owner, 'statuses');
    const a = await automate(owner, 'Statuses', sub.id, 'status-case');
    for (const status of [400, 408, 429]) {
      answer = status;
      const before = at('statuses');
      await trigger(`status-case ${status}`);
      await settle(db, w);
      const runs = await runsOf(db, a.id);
      const run = runs.at(-1)!;
      // One dispatch, one application by the receiver; its answer is not an acknowledgment.
      expect({ status, applied: at('statuses') - before }).toEqual({ status, applied: 1 });
      expect(await effects(run.current_operation_id as string)).toEqual([
        expect.objectContaining({
          state: 'unknown',
          attempt_count: 1,
          uncertainty_reason: 'outcome_unknown',
          not_sent_code: null,
        }),
      ]);
      expect({ status: run.status, reason: run.reason }).toEqual({
        status: 'waiting',
        reason: 'reconciliation_required',
      });
      // No autonomous resend, no fallback success, and no ordinary retry while it is unknown.
      await settle(db, w);
      expect(at('statuses') - before).toBe(1);
      await expect(
        env.svc.retryAutomationRun(owner, ws, run.op_public_id, mutation()),
      ).rejects.toEqual(issueOf('not_retryable'));
      const [e] = await effects(run.current_operation_id as string);
      await decide(run.op_public_id, e!.effect_key as string, 'sent', e!.version as number);
      await settle(db, w);
      expect((await runsOf(db, a.id)).at(-1)!.status).toBe('succeeded');
      expect(at('statuses') - before).toBe(1);
    }
    answer = 200;
    // A refusal before any request (the destination is turned off after the claim): proven not
    // sent, nothing reached the receiver, and the run ends refused rather than waiting.
    barriers = {
      afterClaim: async () => {
        await db.admin(
          `UPDATE integrations.webhook_subscription SET state = 'disabled_endpoint', stopped_at = now()
            WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
          [sub.id],
        );
      },
    };
    const before = at('statuses');
    await trigger('status-case refused');
    await settle(db, w);
    barriers = {};
    const run = (await runsOf(db, a.id)).at(-1)!;
    expect(at('statuses')).toBe(before);
    expect(await effects(run.current_operation_id as string)).toEqual([
      expect.objectContaining({ state: 'failed', not_sent_code: 'precondition_failed' }),
    ]);
    expect({ status: run.status, reason: run.reason }).toEqual({
      status: 'policy_rejected',
      reason: 'approval_invalid',
    });
  });

  it('AT-590 R2: authority is decided again after preparation and before the request leaves (owner, target, approval, destination); unchanged authority still sends once', async () => {
    const cases: Array<{
      name: string;
      as: () => Caller;
      change: (ctx: { sub: string; auto: string }) => Promise<void>;
      reason: string;
    }> = [
      {
        name: 'owner',
        as: () => manager,
        change: async () => {
          await apply(env, owner, ws, {
            kind: 'brand_revoke',
            brand: brands.Harbor,
            principal: await mem(manager),
          });
        },
        reason: 'owner_authority',
      },
      {
        name: 'target',
        as: () => owner,
        change: async () => {
          const t = (
            await db.admin(
              `SELECT r.public_id FROM core.record r JOIN work.task t ON t.id = r.id
                WHERE t.title = 'barrier target target' AND r.lifecycle_state = 'active'`,
            )
          ).rows[0]!.public_id as string;
          await env.svc.taskLifecycle(owner, ws, t, 'trash', {}, mutation());
        },
        reason: 'not_permitted',
      },
      {
        name: 'approval',
        as: () => owner,
        change: async ({ auto }) => {
          await db.admin(
            `UPDATE automation.standing_approval SET state = 'revoked', ended_at = now()
              WHERE automation_id = (SELECT id FROM core.record WHERE public_id = $1)`,
            [auto],
          );
        },
        reason: 'approval_invalid',
      },
      {
        name: 'destination',
        as: () => owner,
        change: async ({ sub }) => {
          await db.admin(
            `UPDATE integrations.webhook_subscription SET destination_url = 'https://127.0.0.1/hooks/moved'
              WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
            [sub],
          );
        },
        reason: 'approval_invalid',
      },
    ];
    for (const c of cases) {
      const as = c.as();
      const sub = await hook(as, `barrier-${c.name}`);
      const a = await automate(as, `Barrier ${c.name}`, sub.id, 'barrier target');
      barriers = { afterClaim: () => c.change({ sub: sub.id, auto: a.id }) };
      const due = await trigger(`barrier target ${c.name}`);
      await settle(db, w);
      barriers = {};
      const run = (await runsOf(db, a.id)).at(-1)!;
      // The prepared payload never left: nothing reached any receiver with this sentinel.
      expect({
        case: c.name,
        applied: applied.filter((x) => JSON.stringify(x.body).includes(due)),
      }).toEqual({
        case: c.name,
        applied: [],
      });
      expect(await effects(run.current_operation_id as string), c.name).toEqual([
        expect.objectContaining({ state: 'failed', not_sent_code: 'precondition_failed' }),
      ]);
      expect({ case: c.name, status: run.status, reason: run.reason }).toEqual({
        case: c.name,
        status: 'policy_rejected',
        reason: c.reason,
      });
      expect(
        (await stepsOf(db, run.id as string))
          .filter((s) => s.node_id === 'send')
          .map((s) => [s.state, s.code]),
      ).toEqual([['refused', c.reason]]);
      await env.svc.disableAutomation(owner, ws, a.id, mutation()).catch(() => undefined);
    }
    // Restore the manager for the following cases.
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(manager),
      level: 'manage',
    });
    // Unchanged authority: the same barrier changes nothing; the request leaves once.
    const sub = await hook(owner, 'barrier-unchanged');
    const a = await automate(owner, 'Barrier unchanged', sub.id, 'unchanged target');
    barriers = { afterClaim: async () => undefined };
    const due = await trigger('unchanged target');
    await settle(db, w);
    barriers = {};
    const mine = applied.filter((x) => x.path === '/hooks/barrier-unchanged');
    expect(mine).toHaveLength(1);
    expect((mine[0]!.body as { data: { fields: Record<string, unknown> } }).data.fields).toEqual({
      priority: 'high',
      due_date: due,
    });
    expect((await runsOf(db, a.id)).at(-1)!.status).toBe('succeeded');
    await env.svc.disableAutomation(owner, ws, a.id, mutation());
  });

  it('AT-591 R2: a real worker restart reusing the stored checkpoint re-decides authority; a target lost meanwhile is never disclosed, an unchanged one is sent once', async () => {
    const sub = await hook(owner, 'restart');
    const a = await automate(owner, 'Restart', sub.id, 'restart target');
    const crash = async (title: string) => {
      const reached = new Promise<void>((resolve) => {
        barriers = { afterClaim: () => (resolve(), never()) };
      });
      const due = await trigger(title);
      const doomed = await worker();
      await doomed.runCycle({ wait: true });
      void doomed.runCycle().catch(() => undefined);
      await reached;
      doomed.kill();
      barriers = {};
      await db.admin(
        `UPDATE exec.job SET lease_until = now() - interval '1 second' WHERE state = 'leased'`,
      );
      w = await worker();
      await settle(db, w);
      return due;
    };
    // 1. Lost meanwhile: the abandoned claim is unknown; the target is trashed; the owner chooses
    //    to send again. The resumed job reuses the checkpoint and must refuse before sending.
    let due = await crash('restart target lost');
    let run = (await runsOf(db, a.id)).at(-1)!;
    expect({ status: run.status, reason: run.reason }).toEqual({
      status: 'waiting',
      reason: 'reconciliation_required',
    });
    const reused = (
      await db.admin(`SELECT checkpoint FROM exec.job WHERE operation_id = $1`, [
        run.current_operation_id,
      ])
    ).rows;
    expect(reused.some((r) => r.checkpoint && Object.keys(r.checkpoint as object).length)).toBe(
      true,
    );
    const t = (
      await db.admin(
        `SELECT r.public_id FROM core.record r JOIN work.task t ON t.id = r.id WHERE t.title = 'restart target lost'`,
      )
    ).rows[0]!.public_id as string;
    await env.svc.taskLifecycle(owner, ws, t, 'trash', {}, mutation());
    let [e] = await effects(run.current_operation_id as string);
    expect(e).toMatchObject({ state: 'unknown', uncertainty_reason: 'abandoned_claim' });
    await decide(run.op_public_id, e!.effect_key as string, 'retry', e!.version as number);
    await settle(db, w);
    run = (await runsOf(db, a.id)).at(-1)!;
    expect(applied.filter((x) => JSON.stringify(x.body).includes(due))).toEqual([]);
    expect({ status: run.status, reason: run.reason }).toEqual({
      status: 'policy_rejected',
      reason: 'not_permitted',
    });
    [e] = await effects(run.current_operation_id as string);
    // The same logical effect: refused locally before any request (distinct from the abandoned
    // claim, which kept its attempt and decision).
    expect(e).toMatchObject({
      state: 'failed',
      not_sent_code: 'precondition_failed',
      attempt_count: 2,
    });
    // 2. Unchanged: the resumed job re-decides, builds the payload in memory, and sends once.
    due = await crash('restart target kept');
    run = (await runsOf(db, a.id)).at(-1)!;
    [e] = await effects(run.current_operation_id as string);
    await decide(run.op_public_id, e!.effect_key as string, 'retry', e!.version as number);
    await settle(db, w);
    run = (await runsOf(db, a.id)).at(-1)!;
    expect(applied.filter((x) => JSON.stringify(x.body).includes(due))).toHaveLength(1);
    expect(run.status).toBe('succeeded');
    await env.svc.disableAutomation(owner, ws, a.id, mutation());
  });

  it('AT-592 R2: no payload content stays in execution metadata or logs, before or after purge; references and liability facts remain', async () => {
    const sub = await hook(owner, 'metadata');
    const a = await automate(owner, 'Metadata', sub.id, 'metadata target');
    env.h.sink.clear();
    const due = await trigger('metadata target');
    await settle(db, w);
    expect(applied.filter((x) => JSON.stringify(x.body).includes(due))).toHaveLength(1);
    const run = (await runsOf(db, a.id)).at(-1)!;
    expect(run.status).toBe('succeeded');
    // The disclosed value appears nowhere in automation execution metadata or the logs.
    expect((await metadata()).filter((t) => t.includes(due))).toEqual([]);
    expect(env.h.sink.lines.filter((l) => l.includes(due))).toEqual([]);
    // Every checkpoint of every automation job holds references and bounded facts only.
    for (const r of (
      await db.admin(
        `SELECT checkpoint FROM exec.job WHERE workspace_id = $1 AND kind LIKE 'automation.%' AND checkpoint IS NOT NULL`,
        [wsId],
      )
    ).rows)
      expect(JSON.stringify(r.checkpoint)).not.toMatch(/envelope|"fields"|due_date|"title"/);
    // Liability facts stay: the effect is recorded sent under its logical key.
    expect(await effects(run.current_operation_id as string)).toEqual([
      expect.objectContaining({ state: 'sent', attempt_count: 1 }),
    ]);
    // Purge aftermath: nothing of the payload survives anywhere in execution metadata.
    await env.svc.disableAutomation(owner, ws, a.id, mutation());
    await env.svc.automationLifecycle(owner, ws, a.id, 'trash', mutation());
    const id = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [a.id])).rows[0]!
      .id;
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      const { purgeAutomations } = await import('@pm/work');
      await purgeAutomations(tx, [id]);
    });
    expect(
      (
        await db.admin(
          `SELECT j::text AS t FROM exec.job j WHERE j.workspace_id = $1
           UNION ALL SELECT o::text FROM exec.operation o WHERE o.workspace_id = $1
           UNION ALL SELECT e::text FROM exec.external_effect e WHERE e.workspace_id = $1`,
          [wsId],
        )
      ).rows.filter((r) => (r.t as string).includes(due)),
    ).toEqual([]);
  });

  it('AT-593 R3: a completed lifecycle key replays only through current authority; a former configurer, a purged record, and another workspace get the opaque answer', async () => {
    const auto = async (as: Caller, name: string) =>
      (
        await env.svc.createAutomation(
          as,
          ws,
          {
            name,
            scope: { kind: 'brand', brand: brands.Harbor },
            definition: {
              schema_version: 1,
              trigger: { kind: 'record.created', record: 'task' },
              conditions: null,
              steps: [
                {
                  id: 'up',
                  type: 'action',
                  action: 'task.update',
                  params: { fields: { priority: 'high' } },
                },
              ],
            },
          },
          mutation(),
        )
      ).data;
    const counts = async () =>
      (
        await db.admin(
          `SELECT (SELECT count(*)::int FROM audit.audit_event WHERE workspace_id = $1) AS audit,
                  (SELECT count(*)::int FROM exec.outbox_event WHERE workspace_id = $1) AS events,
                  (SELECT count(*)::int FROM core.record WHERE workspace_id = $1 AND record_type = 'automation' AND lifecycle_state = 'archived') AS archived`,
          [wsId],
        )
      ).rows[0];
    // An authorized manager archives; the same key replays the completed result, changing nothing.
    const a = await auto(manager, 'Replay archive');
    const archive = mutation();
    const first = await env.svc.automationLifecycle(manager, ws, a.id, 'archive', archive);
    expect(first.data).toEqual({ id: a.id, type: 'automation', lifecycle_state: 'archived' });
    const settled = await counts();
    const again = await env.svc.automationLifecycle(manager, ws, a.id, 'archive', archive);
    expect({ replayed: again.replayed, data: again.data }).toEqual({
      replayed: true,
      data: first.data,
    });
    expect(await counts()).toEqual(settled);
    // Brand access is revoked while the membership stays active: the same key is opaque.
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Harbor,
      principal: await mem(manager),
    });
    const before = await counts();
    await expect(
      env.svc.automationLifecycle(manager, ws, a.id, 'archive', archive),
    ).rejects.toEqual(code('not_found'));
    expect(await counts()).toEqual(before);
    // The owner still replays an authorized trash with its trashed state (legitimate replay).
    const b = await auto(owner, 'Replay trash');
    const trash = mutation();
    await env.svc.automationLifecycle(owner, ws, b.id, 'trash', trash);
    expect((await env.svc.automationLifecycle(owner, ws, b.id, 'trash', trash)).data).toEqual({
      id: b.id,
      type: 'automation',
      lifecycle_state: 'trashed',
    });
    // Purged: the completed key is opaque, never a raw database error.
    const id = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [b.id])).rows[0]!
      .id;
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      const { purgeAutomations } = await import('@pm/work');
      await purgeAutomations(tx, [id]);
    });
    await expect(env.svc.automationLifecycle(owner, ws, b.id, 'trash', trash)).rejects.toEqual(
      code('not_found'),
    );
    // Another workspace: the identifier is unknown there.
    const other = await workspaceWith(env, db, ['Elsewhere']);
    await expect(
      env.svc.automationLifecycle(other.owner, other.ws, a.id, 'archive', mutation()),
    ).rejects.toEqual(code('not_found'));
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(manager),
      level: 'manage',
    });
  });
});
