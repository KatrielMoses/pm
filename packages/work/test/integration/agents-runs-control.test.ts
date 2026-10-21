import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startAgentConnectorFixture, type AgentConnectorFixture } from '@pm/test-support';
import type { WorkerRuntime } from '@pm/platform';
import { mutation, workEnv, type WorkEnv } from './fixture.ts';
import { settle } from './automation-support.ts';
import { agentWorld, code, grantBrand, revokeBrand, type AgentWorld } from './agents-support.ts';
import {
  credentialCaller,
  externalAgent,
  PRODUCT,
  runRow,
  runWorker,
} from './agents-runs-support.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Phase 8C run controls and live authority (AGT-009, AGT-011, AGT-022–AGT-025): pause stops new
 * work and credentials at once, resume re-checks and issues fresh ones, cancel is terminal and
 * reports what may already have left, retry links a new operation without resetting the logical
 * budget, authority loss before or after dispatch stops work without disclosing anything new,
 * an unknown dispatch is never sent again automatically, the emergency stop pauses everything,
 * and limits hold under concurrency.
 */
describe('agent runs (8C): controls, live authority, emergency stop, limits', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let fx: AgentConnectorFixture;
  let w: AgentWorld;
  let worker: WorkerRuntime;
  let n = 0;

  const view = async (run: string) =>
    (await env.svc.getAgentRun(w.owner, w.ws, run)) as Record<string, any>;
  const control = (run: string, verb: 'pause' | 'resume' | 'cancel' | 'retry', as = w.owner) =>
    env.svc.controlAgentRun(as, w.ws, run, verb, mutation());
  const task = async (title: string) =>
    (await env.svc.createTask(w.owner, w.ws, { brand: w.brands.Harbor!, title }, mutation())).data
      .id as string;
  /** A fresh task with an assigned external agent and a started run, dispatched. */
  const started = async (
    opts: { run?: 'ack' | 'reject' | 'error'; as?: typeof w.owner; settleNow?: boolean } = {},
  ) => {
    n += 1;
    const t = await task(`Run task ${n}`);
    const agent = await externalAgent(
      env,
      db,
      fx,
      worker,
      w,
      `Agent ${n}`,
      { brands: [w.brands.Harbor!] },
      { run: opts.run ?? 'ack' },
    );
    const as = opts.as ?? w.owner;
    await env.svc.assignAgent(as, w.ws, t, { profile: agent.id, goal: 'Do the work.' }, mutation());
    const run = (await env.svc.startAgentRun(as, w.ws, t, agent.id, {}, mutation())).data as Record<
      string,
      any
    >;
    if (opts.settleNow !== false) await settle(db, worker);
    return { task: t, agent, run: run.id as string, peer: agent.peer };
  };
  const tokenOf = (peer: string) =>
    (
      fx
        .dispatches()
        .filter((d) => d.peer === peer)
        .at(-1)!.body.credential as { token: string }
    ).token;
  const dispatchCount = (peer: string) => fx.dispatches().filter((d) => d.peer === peer).length;

  beforeAll(async () => {
    fx = await startAgentConnectorFixture();
    db = await createTestDatabase();
    env = workEnv(db, {
      agents: { transport: 'fixture', productOrigin: PRODUCT },
      work: { agentRunsActiveMax: 6, agentRunRetriesMax: 1 },
    });
    w = await agentWorld(env, db, {
      member: { kind: 'member', role: 'member' },
      reader: { kind: 'member', role: 'read_only' },
    });
    worker = await runWorker(env);
    await grantBrand(env, db, w, w.people.member!, w.brands.Harbor!, 'edit');
    await grantBrand(env, db, w, w.people.reader!, w.brands.Harbor!, 'view');
  });
  afterAll(async () => {
    await worker.stop();
    await env.h.close();
    await db.drop();
    await fx.close();
  });

  it('AT-645 pause revokes the credential at once; resume re-checks and sends a fresh dispatch with a new credential', async () => {
    const r = await started();
    const first = tokenOf(r.peer);
    expect((await view(r.run)).state).toBe('running');
    const paused = (await control(r.run, 'pause')).data as Record<string, any>;
    expect(paused).toMatchObject({ state: 'waiting', waiting: 'paused', paused_by: 'human' });
    expect(await credentialCaller(env, first)).toBeNull();
    // A reader may watch but never control.
    await expect(control(r.run, 'resume', w.people.reader!)).rejects.toEqual(code('forbidden'));
    const resumed = (await control(r.run, 'resume')).data as Record<string, any>;
    expect(resumed.state).toBe('queued');
    await settle(db, worker);
    expect(dispatchCount(r.peer)).toBe(2);
    const second = tokenOf(r.peer);
    expect(second).not.toBe(first);
    expect(await credentialCaller(env, second)).not.toBeNull();
    expect((await view(r.run)).state).toBe('running');
  });

  it('AT-646 cancel is terminal for future actions, reports a dispatch already sent, and refuses late callbacks', async () => {
    const r = await started();
    const token = tokenOf(r.peer);
    const out = (await control(r.run, 'cancel')).data as Record<string, any>;
    expect(out.state).toBe('cancelled');
    expect(out.report).toMatchObject({ cancelled: true, sent_before_cancel: 1 });
    expect(out.failure).toMatchObject({ terminal_reason: 'user_cancelled' });
    expect(await credentialCaller(env, token)).toBeNull();
    await expect(control(r.run, 'resume')).rejects.toEqual(code('conflict'));
    await expect(control(r.run, 'retry')).rejects.toEqual(code('conflict'));
  });

  it('AT-647 retry links a new operation, keeps the logical counters and deadline, and stops at the retry limit', async () => {
    const r = await started();
    const agent = (await credentialCaller(env, tokenOf(r.peer)))!;
    await env.svc.agentRunCallTool(agent, w.ws, r.run, {
      key: 'r1',
      tool: 'pm.tasks.get',
      version: '1',
      arguments: { task: r.task },
    });
    await env.svc.agentRunPostResult(agent, w.ws, r.run, {
      key: 'f1',
      attempt: 1,
      status: 'failed',
      summary: 'Could not finish.',
    });
    await settle(db, worker);
    const failed = await view(r.run);
    expect(failed).toMatchObject({ state: 'failed', capabilities: { retry: true } });
    const before = await runRow(db, r.run);
    const retried = (await control(r.run, 'retry')).data as Record<string, any>;
    expect(retried).toMatchObject({ state: 'queued', attempt: 2 });
    await settle(db, worker);
    const after = await runRow(db, r.run);
    expect(after.current_operation_id).not.toBe(before.current_operation_id);
    expect(after.tool_calls_used).toBe(before.tool_calls_used);
    expect(new Date(after.deadline_at).getTime()).toBe(new Date(before.deadline_at).getTime());
    const linked = await db.admin(
      `SELECT rerun_of_operation_id FROM exec.operation WHERE id = $1`,
      [after.current_operation_id],
    );
    expect(linked.rows[0].rerun_of_operation_id).toBe(before.current_operation_id);
    expect(dispatchCount(r.peer)).toBe(2);
    // The new attempt's credential answers for attempt 2 only: an attempt-1 result is late.
    const agent2 = (await credentialCaller(env, tokenOf(r.peer)))!;
    await expect(
      env.svc.agentRunPostResult(agent2, w.ws, r.run, {
        key: 'f2',
        attempt: 1,
        status: 'completed',
        summary: 'Old.',
      }),
    ).rejects.toEqual(
      expect.objectContaining({ issues: [expect.objectContaining({ code: 'run_closed' })] }),
    );
    await env.svc.agentRunPostResult(agent2, w.ws, r.run, {
      key: 'f3',
      attempt: 2,
      status: 'failed',
      summary: 'Again.',
    });
    await settle(db, worker);
    await expect(control(r.run, 'retry')).rejects.toEqual(
      expect.objectContaining({ issues: [expect.objectContaining({ code: 'limit_reached' })] }),
    );
  });

  it('AT-648 an assigner downgraded after admission and before dispatch: nothing is sent; the run waits for authority; restored authority resumes it', async () => {
    const member = w.people.member!;
    const r = await started({ as: member, settleNow: false });
    await revokeBrand(env, db, w, member, w.brands.Harbor!);
    await grantBrand(env, db, w, member, w.brands.Harbor!, 'view');
    await settle(db, worker);
    expect(dispatchCount(r.peer)).toBe(0);
    expect(await view(r.run)).toMatchObject({ state: 'waiting', waiting: 'authorization_changed' });
    await expect(control(r.run, 'resume')).rejects.toEqual(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: 'assigner_authority' })],
      }),
    );
    await revokeBrand(env, db, w, member, w.brands.Harbor!);
    await grantBrand(env, db, w, member, w.brands.Harbor!, 'edit');
    await control(r.run, 'resume');
    await settle(db, worker);
    expect(dispatchCount(r.peer)).toBe(1);
  });

  it('AT-649 authority lost after dispatch: the next call is refused, the run waits, the credential stops; an archived task does the same', async () => {
    const member = w.people.member!;
    const r = await started({ as: member });
    const agent = (await credentialCaller(env, tokenOf(r.peer)))!;
    await env.svc.agentRunCallTool(agent, w.ws, r.run, {
      key: 'ok',
      tool: 'pm.tasks.get',
      version: '1',
      arguments: { task: r.task },
    });
    await revokeBrand(env, db, w, member, w.brands.Harbor!);
    await grantBrand(env, db, w, member, w.brands.Harbor!, 'view');
    await expect(
      env.svc.agentRunCallTool(agent, w.ws, r.run, {
        key: 'after',
        tool: 'pm.tasks.get',
        version: '1',
        arguments: { task: r.task },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ issues: [expect.objectContaining({ code: 'run_unavailable' })] }),
    );
    expect(await view(r.run)).toMatchObject({ state: 'waiting', waiting: 'authorization_changed' });
    expect(await credentialCaller(env, tokenOf(r.peer))).toBeNull();
    const calls = (await view(r.run)).tool_calls as Array<{
      decision: string;
      code: string | null;
    }>;
    expect(calls.some((c) => c.decision === 'refused' && c.code === 'authorization_changed')).toBe(
      true,
    );
    await revokeBrand(env, db, w, member, w.brands.Harbor!);
    await grantBrand(env, db, w, member, w.brands.Harbor!, 'edit');
    // Archived target: the run cannot resume while the task is archived.
    const r2 = await started();
    await env.svc.taskLifecycle(w.owner, w.ws, r2.task, 'archive', {}, mutation());
    const agent2 = (await credentialCaller(env, tokenOf(r2.peer)))!;
    await expect(
      env.svc.agentRunPostEvent(agent2, w.ws, r2.run, { key: 'p', kind: 'progress', text: 'x' }),
    ).resolves.toBeTruthy();
    await expect(
      env.svc.agentRunCallTool(agent2, w.ws, r2.run, {
        key: 't',
        tool: 'pm.tasks.get',
        version: '1',
        arguments: { task: r2.task },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ issues: [expect.objectContaining({ code: 'run_unavailable' })] }),
    );
    // Run controls follow the task's own rule: an archived task refuses them.
    await expect(control(r2.run, 'resume')).rejects.toEqual(code('forbidden'));
  });

  it('AT-650 an unknown dispatch outcome is never sent again automatically: the run waits for reconciliation; cancel is refused until then', async () => {
    const r = await started({ run: 'error' });
    await settle(db, worker);
    await settle(db, worker);
    expect(dispatchCount(r.peer)).toBe(1);
    expect(await view(r.run)).toMatchObject({
      state: 'waiting',
      waiting: 'reconciliation_required',
    });
    await expect(control(r.run, 'cancel')).rejects.toEqual(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: 'reconciliation_required' })],
      }),
    );
    const row = await runRow(db, r.run);
    const effect = (
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
        effect.effect_key,
        { decision: 'abandon', version: effect.version },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
    await settle(db, worker);
    expect((await view(r.run)).state).toBe('cancelled');
    expect(dispatchCount(r.peer)).toBe(1);
  });

  it('AT-651 the emergency stop pauses every run, revokes every credential, refuses admissions and calls; restart leaves runs paused until each is resumed', async () => {
    const a = await started();
    const b = await started({ settleNow: false });
    const tokenA = tokenOf(a.peer);
    await expect(
      env.svc.triggerAgentEmergencyStop(w.people.member!, w.ws, {}, mutation()),
    ).rejects.toEqual(code('forbidden'));
    const stop = (
      await env.svc.triggerAgentEmergencyStop(w.owner, w.ws, { reason: 'Drill' }, mutation())
    ).data as Record<string, any>;
    expect(stop).toMatchObject({ stopped: true });
    expect(
      stop.report.paused + stop.report.finishing + stop.report.already + stop.report.not_stoppable,
    ).toBeGreaterThanOrEqual(2);
    expect(await credentialCaller(env, tokenA)).toBeNull();
    expect(await view(a.run)).toMatchObject({
      state: 'waiting',
      waiting: 'paused',
      paused_by: 'emergency_stop',
    });
    await settle(db, worker);
    expect(await view(b.run)).toMatchObject({ state: 'waiting', waiting: 'paused' });
    expect(dispatchCount(b.peer)).toBe(0);
    const t = await task('After the stop');
    await env.svc.assignAgent(w.owner, w.ws, t, { profile: a.agent.id, goal: 'x' }, mutation());
    await expect(
      env.svc.startAgentRun(w.owner, w.ws, t, a.agent.id, {}, mutation()),
    ).rejects.toEqual(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'emergency_stop' })]),
      }),
    );
    await expect(control(a.run, 'resume')).rejects.toEqual(
      expect.objectContaining({ issues: [expect.objectContaining({ code: 'emergency_stop' })] }),
    );
    await env.svc.restartAgentExecution(w.owner, w.ws, {}, mutation());
    await settle(db, worker);
    expect((await view(a.run)).waiting).toBe('paused');
    await control(a.run, 'resume');
    await settle(db, worker);
    expect((await view(a.run)).state).toBe('running');
    const health = (await env.svc.agentHealth(w.owner, w.ws)) as Record<string, any>;
    expect(health.emergency_stop).toMatchObject({ stopped: false, can_trigger: true });
  });

  it('AT-652 limits: tool calls, artifacts, and the per-workspace open-run limit hold (the last under concurrency)', async () => {
    await db.admin(`UPDATE agents.agent_run SET ended_at = now() WHERE ended_at IS NULL`);
    const r = await started();
    await db.admin(
      `UPDATE agents.agent_run SET limits = limits || '{"max_tool_calls": 1, "max_artifacts": 1}' WHERE id = (SELECT r.id FROM agents.agent_run r JOIN exec.operation o ON o.id = r.operation_id WHERE o.public_id = $1)`,
      [r.run],
    );
    const agent = (await credentialCaller(env, tokenOf(r.peer)))!;
    await env.svc.agentRunCallTool(agent, w.ws, r.run, {
      key: 'a',
      tool: 'pm.tasks.get',
      version: '1',
      arguments: { task: r.task },
    });
    await expect(
      env.svc.agentRunCallTool(agent, w.ws, r.run, {
        key: 'b',
        tool: 'pm.tasks.get',
        version: '1',
        arguments: { task: r.task },
      }),
    ).rejects.toEqual(code('limit_exceeded'));
    await env.svc.agentRunPostArtifact(agent, w.ws, r.run, {
      key: 'one',
      title: 'One',
      media_type: 'text/plain',
      content: '1',
      sha256: sha('1'),
    });
    await expect(
      env.svc.agentRunPostArtifact(agent, w.ws, r.run, {
        key: 'two',
        title: 'Two',
        media_type: 'text/plain',
        content: '2',
        sha256: sha('2'),
      }),
    ).rejects.toEqual(code('limit_exceeded'));
    // A new version of the same artifact is appended (never replaced) and is not a new artifact.
    const v2 = await env.svc.agentRunPostArtifact(agent, w.ws, r.run, {
      key: 'one',
      title: 'One',
      media_type: 'text/plain',
      content: '1b',
      sha256: sha('1b'),
    });
    expect(v2).toMatchObject({ version: 2, duplicate: false });
    const same = await env.svc.agentRunPostArtifact(agent, w.ws, r.run, {
      key: 'one',
      title: 'One',
      media_type: 'text/plain',
      content: '1b',
      sha256: sha('1b'),
    });
    expect(same).toMatchObject({ version: 2, duplicate: true });
    // Workspace open-run limit under concurrency.
    await db.admin(`UPDATE agents.agent_run SET ended_at = now() WHERE ended_at IS NULL`);
    const tasks = [];
    for (let i = 0; i < 9; i++) {
      const t = await task(`Burst ${i}`);
      await env.svc.assignAgent(
        w.owner,
        w.ws,
        t,
        { profile: r.agent.id, goal: 'Burst.' },
        mutation(),
      );
      tasks.push(t);
    }
    const results = await Promise.allSettled(
      tasks.map((t) => env.svc.startAgentRun(w.owner, w.ws, t, r.agent.id, {}, mutation())),
    );
    expect(results.filter((x) => x.status === 'fulfilled').length).toBe(6);
    for (const x of results)
      if (x.status === 'rejected')
        expect(x.reason).toEqual(
          expect.objectContaining({ issues: [expect.objectContaining({ code: 'limit_reached' })] }),
        );
  });

  it('AT-653 duplicates: a replayed start key, duplicate event, tool, and result keys change nothing twice', async () => {
    const t = await task('Duplicates');
    const agent = await externalAgent(env, db, fx, worker, w, 'Dup agent', {
      brands: [w.brands.Harbor!],
    });
    await db.admin(`UPDATE agents.agent_run SET ended_at = now() WHERE ended_at IS NULL`);
    await env.svc.assignAgent(w.owner, w.ws, t, { profile: agent.id, goal: 'x' }, mutation());
    const req = mutation();
    const one = await env.svc.startAgentRun(w.owner, w.ws, t, agent.id, {}, req);
    const two = await env.svc.startAgentRun(w.owner, w.ws, t, agent.id, {}, req);
    expect(two.replayed).toBe(true);
    expect((two.data as { id: string }).id).toBe((one.data as { id: string }).id);
    await settle(db, worker);
    const run = (one.data as { id: string }).id;
    const caller = (await credentialCaller(env, tokenOf(agent.peer)))!;
    const e1 = await env.svc.agentRunPostEvent(caller, w.ws, run, {
      key: 'same',
      kind: 'progress',
      text: 'once',
    });
    const e2 = await env.svc.agentRunPostEvent(caller, w.ws, run, {
      key: 'same',
      kind: 'progress',
      text: 'twice',
    });
    expect(e2).toMatchObject({ seq: e1.seq, duplicate: true });
    await env.svc.agentRunCallTool(caller, w.ws, run, {
      key: 'k',
      tool: 'pm.tasks.get',
      version: '1',
      arguments: { task: t },
    });
    await env.svc.agentRunCallTool(caller, w.ws, run, {
      key: 'k',
      tool: 'pm.tasks.get',
      version: '1',
      arguments: { task: t },
    });
    const calls = await db.admin(
      `SELECT count(*)::int AS n FROM agents.agent_tool_call c JOIN agents.agent_run r ON r.id = c.run_id JOIN exec.operation o ON o.id = r.operation_id WHERE o.public_id = $1 AND c.call_key = 'k'`,
      [run],
    );
    expect(calls.rows[0].n).toBe(1);
    expect((await runRow(db, run)).tool_calls_used).toBe(1);
    await env.svc.agentRunPostResult(caller, w.ws, run, {
      key: 'r',
      attempt: 1,
      status: 'completed',
      summary: 'Done.',
    });
    await expect(
      env.svc.agentRunPostResult(caller, w.ws, run, {
        key: 'r',
        attempt: 1,
        status: 'completed',
        summary: 'Done.',
      }),
    ).rejects.toEqual(code('not_found'));
    await settle(db, worker);
    expect((await view(run)).state).toBe('ready_for_review');
  });
});
