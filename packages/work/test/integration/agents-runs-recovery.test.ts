import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  startAgentConnectorFixture,
  startAiProviderFixture,
  type AgentConnectorFixture,
  type AiProviderFixture,
} from '@pm/test-support';
import type { EffectBarriers, WorkerRuntime } from '@pm/platform';
import { mutation, workEnv, type WorkEnv } from './fixture.ts';
import { settle } from './automation-support.ts';
import { agentWorld, config, type AgentWorld } from './agents-support.ts';
import { enableAi, fixtureAi } from './ai-support.ts';
import {
  credentialCaller,
  externalAgent,
  PRODUCT,
  runRow,
  runWorker,
} from './agents-runs-support.ts';

const never = () => new Promise<void>(() => undefined);

/**
 * Phase 8C crash and duplicate safety (AGT-023): a worker that dies after claiming or after
 * sending a dispatch leaves an unknown outcome that is never sent again automatically; only an
 * owner's reconciliation decides, and a confirmed send continues the same run with the same
 * credential. Redelivered jobs never start a second model turn; overlapping results settle once.
 */
describe('agent runs (8C): crashes, reconciliation, and duplicates', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let fx: AgentConnectorFixture;
  let ai: AiProviderFixture;
  let w: AgentWorld;
  let barriers: EffectBarriers = {};
  const workers: WorkerRuntime[] = [];
  let worker: WorkerRuntime;
  let n = 0;

  const spawn = async () => {
    const x = await runWorker(env, {
      ai: true,
      effectBarriers: {
        afterClaim: (k) => barriers.afterClaim?.(k) ?? Promise.resolve(),
        afterPerform: (k) => barriers.afterPerform?.(k) ?? Promise.resolve(),
      },
    });
    workers.push(x);
    return x;
  };
  const view = async (run: string) =>
    (await env.svc.getAgentRun(w.owner, w.ws, run)) as Record<string, any>;
  const dispatches = (peer: string) => fx.dispatches().filter((d) => d.peer === peer);

  /** Starts a run and lets a worker die at the barrier; a new worker takes over after the lease. */
  const crashAt = async (where: keyof EffectBarriers) => {
    n += 1;
    const t = (
      await env.svc.createTask(
        w.owner,
        w.ws,
        { brand: w.brands.Harbor!, title: `Crash ${n}` },
        mutation(),
      )
    ).data.id as string;
    const agent = await externalAgent(env, db, fx, worker, w, `Crash agent ${n}`, {
      brands: [w.brands.Harbor!],
    });
    await env.svc.assignAgent(w.owner, w.ws, t, { profile: agent.id, goal: 'Work.' }, mutation());
    const run = (
      (await env.svc.startAgentRun(w.owner, w.ws, t, agent.id, {}, mutation())).data as {
        id: string;
      }
    ).id;
    const reached = new Promise<void>((resolve) => {
      barriers = { [where]: () => (resolve(), never()) };
    });
    const doomed = await spawn();
    void doomed.runCycle().catch(() => undefined);
    await reached;
    doomed.kill();
    barriers = {};
    await db.admin(
      `UPDATE exec.job SET lease_until = now() - interval '1 second' WHERE state = 'leased'`,
    );
    worker = await spawn();
    await settle(db, worker);
    return { run, task: t, agent };
  };
  const reconcile = async (run: string, decision: 'sent' | 'retry' | 'abandon') => {
    const row = await runRow(db, run);
    const e = (
      await db.admin(
        `SELECT effect_key, version::int AS version FROM exec.external_effect WHERE operation_id = $1`,
        [row.current_operation_id],
      )
    ).rows[0];
    const op = (
      await db.admin(`SELECT public_id FROM exec.operation WHERE id = $1`, [
        row.current_operation_id,
      ])
    ).rows[0].public_id;
    env.stepUp.allow = true;
    try {
      await env.svc.reconcileExternalEffect(
        w.owner,
        w.ws,
        op,
        e.effect_key,
        { decision, version: e.version },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
    await settle(db, worker);
  };

  beforeAll(async () => {
    fx = await startAgentConnectorFixture();
    ai = await startAiProviderFixture();
    db = await createTestDatabase();
    env = workEnv(db, {
      agents: { transport: 'fixture', productOrigin: PRODUCT },
      ai: fixtureAi(ai),
    });
    w = await agentWorld(env, db);
    worker = await spawn();
  });
  afterAll(async () => {
    for (const x of workers) await x.stop().catch(() => undefined);
    await env.h.close();
    await db.drop();
    await fx.close();
    await ai.close();
  });

  it('AT-654 a worker that dies after claiming (before any request) leaves an unknown outcome; nothing was sent and nothing is sent automatically', async () => {
    const r = await crashAt('afterClaim');
    expect(dispatches(r.agent.peer)).toHaveLength(0);
    expect(await view(r.run)).toMatchObject({
      state: 'waiting',
      waiting: 'reconciliation_required',
    });
    await settle(db, worker);
    expect(dispatches(r.agent.peer)).toHaveLength(0);
    // The owner decides: retry sends once, with a fresh credential.
    await reconcile(r.run, 'retry');
    expect(dispatches(r.agent.peer)).toHaveLength(1);
    expect((await view(r.run)).state).toBe('running');
  });

  it('AT-655 a worker that dies after sending leaves an unknown outcome; it is never re-sent; a confirmed send continues the same run with the credential already sent', async () => {
    const r = await crashAt('afterPerform');
    expect(dispatches(r.agent.peer)).toHaveLength(1);
    expect(await view(r.run)).toMatchObject({
      state: 'waiting',
      waiting: 'reconciliation_required',
    });
    await settle(db, worker);
    expect(dispatches(r.agent.peer)).toHaveLength(1);
    // While the outcome is unknown, the credential the agent may hold is refused everywhere.
    const held = (dispatches(r.agent.peer)[0]!.body.credential as { token: string }).token;
    const early = (await credentialCaller(env, held))!;
    await expect(
      env.svc.agentRunPostEvent(early, w.ws, r.run, {
        key: 'e0',
        kind: 'progress',
        text: 'Working.',
      }),
    ).rejects.toEqual(
      expect.objectContaining({ issues: [expect.objectContaining({ code: 'run_unavailable' })] }),
    );
    await reconcile(r.run, 'sent');
    expect(dispatches(r.agent.peer)).toHaveLength(1);
    expect((await view(r.run)).state).toBe('running');
    const token = (dispatches(r.agent.peer)[0]!.body.credential as { token: string }).token;
    const agent = (await credentialCaller(env, token))!;
    expect(agent).not.toBeNull();
    // Two overlapping results settle once.
    const [a, b] = await Promise.allSettled([
      env.svc.agentRunPostResult(agent, w.ws, r.run, {
        key: 'x1',
        attempt: 1,
        status: 'completed',
        summary: 'One.',
      }),
      env.svc.agentRunPostResult(agent, w.ws, r.run, {
        key: 'x2',
        attempt: 1,
        status: 'failed',
        summary: 'Two.',
      }),
    ]);
    expect([a!.status, b!.status].sort()).toEqual(['fulfilled', 'rejected']);
    await settle(db, worker);
    expect(['ready_for_review', 'failed']).toContain((await view(r.run)).state);
    const ended = await db.admin(
      `SELECT count(*)::int AS n FROM agents.agent_run_event e JOIN agents.agent_run r ON r.id = e.run_id JOIN exec.operation o ON o.id = r.operation_id WHERE o.public_id = $1 AND e.kind = 'result'`,
      [r.run],
    );
    expect(ended.rows[0].n).toBe(1);
  });

  it('AT-656 a redelivered internal job never starts a second model turn', async () => {
    await enableAi(env, w.owner, w.ws);
    const t = (
      await env.svc.createTask(
        w.owner,
        w.ws,
        { brand: w.brands.Harbor!, title: 'Internal twice' },
        mutation(),
      )
    ).data.id as string;
    const p = (
      await env.svc.createAgentProfile(
        w.owner,
        w.ws,
        {
          name: 'Twice',
          kind: 'internal',
          draft: config({ scope: { brands: [w.brands.Harbor!] } }),
        },
        mutation(),
      )
    ).data as Record<string, any>;
    await env.svc.activateAgentProfile(w.owner, w.ws, p.id, mutation());
    await env.svc.assignAgent(w.owner, w.ws, t, { profile: p.id, goal: 'Draft.' }, mutation());
    const run = (
      (await env.svc.startAgentRun(w.owner, w.ws, t, p.id, { confirm: true }, mutation())).data as {
        id: string;
      }
    ).id;
    // Process only the run job (not the model turn), then duplicate its continuation.
    await worker.runCycle({ wait: true });
    const row = await runRow(db, run);
    await db.admin(
      `INSERT INTO exec.job (id, workspace_id, queue, kind, operation_id, payload_ref, state, run_at, max_attempts, timeout_seconds,
         authenticated_principal_type, authenticated_principal_id, effective_principal_type, effective_principal_id, delegation_chain,
         workspace_epoch_at_enqueue, principal_epoch_at_enqueue, data_class_limit, correlation_id)
       SELECT uuidv7(), workspace_id, queue, kind, operation_id, payload_ref, 'queued', now(), max_attempts, timeout_seconds,
         authenticated_principal_type, authenticated_principal_id, effective_principal_type, effective_principal_id, delegation_chain,
         workspace_epoch_at_enqueue, principal_epoch_at_enqueue, data_class_limit, correlation_id
         FROM exec.job WHERE operation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [row.current_operation_id],
    );
    await settle(db, worker);
    await settle(db, worker);
    const turns = await db.admin(
      `SELECT count(*)::int AS n FROM ai.ai_action WHERE caller_kind = 'agent' AND initiating_membership_id = $1 AND operation_id IN (SELECT model_operation_id FROM agents.agent_run WHERE id = $2)`,
      [row.assigner_membership_id, row.id],
    );
    expect(turns.rows[0].n).toBe(1);
    const all = await db
      .admin(
        `SELECT count(*)::int AS n FROM ai.ai_action a JOIN exec.operation o ON o.id = a.operation_id WHERE a.caller_kind = 'agent' AND (o.context->'effective_principal'->>'id')::uuid = $1`,
        [row.id],
      )
      .catch(() => null);
    if (all) expect(all.rows[0].n).toBeLessThanOrEqual(1);
    expect((await view(run)).state).toBe('ready_for_review');
  });
});
