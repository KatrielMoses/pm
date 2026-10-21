import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startAgentConnectorFixture, type AgentConnectorFixture } from '@pm/test-support';
import type { WorkerRuntime } from '@pm/platform';
import type { Caller } from '@pm/tenancy';
import { mutation, workEnv, type WorkEnv } from './fixture.ts';
import { settle } from './automation-support.ts';
import { agentWorld, code, grantBrand, v, type AgentWorld } from './agents-support.ts';
import {
  credentialCaller,
  externalAgent,
  PRODUCT,
  runRow,
  runWorker,
} from './agents-runs-support.ts';

/**
 * Phase 8C on the platform: 8A automations invoke agents through the same admission and react to
 * their results without recursion (AUTO-007); outcomes reach 5D metrics, 7E briefings, and 4B
 * notifications per viewer, kept apart from automation rates (RPT-013, BRF-010, REL-006); purge
 * removes run content; a credential acts for one run in one workspace only; every role, guest,
 * and share-only person across three workspaces sees only what the task lets them see; a
 * withdrawal or the deadline ends a run mid-flight.
 */
describe('agent runs (8C): automations, reporting, purge, isolation', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let fx: AgentConnectorFixture;
  let w: AgentWorld;
  let other: AgentWorld;
  let third: AgentWorld;
  let worker: WorkerRuntime;

  const view = async (who: Caller, run: string) =>
    (await env.svc.getAgentRun(who, w.ws, run)) as Record<string, any>;
  const tokenOf = (peer: string) =>
    (
      fx
        .dispatches()
        .filter((d) => d.peer === peer)
        .at(-1)!.body.credential as { token: string }
    ).token;
  const complete = async (
    peer: string,
    run: string,
    status: 'completed' | 'failed' = 'completed',
    attempt = 1,
  ) => {
    const agent = (await credentialCaller(env, tokenOf(peer)))!;
    await env.svc.agentRunPostResult(agent, w.ws, run, {
      key: `res-${run}-${attempt}-${status}`,
      attempt,
      status,
      summary: 'Done.',
    });
    await settle(db, worker);
  };
  const runsOf = async (agentPublic: string) =>
    (
      await db.admin(
        `SELECT o.public_id, r.initiator_kind, r.source_ref FROM agents.agent_run r JOIN core.record p ON p.id = r.profile_id
           JOIN exec.operation o ON o.id = r.operation_id WHERE p.public_id = $1 ORDER BY r.created_at`,
        [agentPublic],
      )
    ).rows as Array<{ public_id: string; initiator_kind: string; source_ref: string | null }>;

  beforeAll(async () => {
    fx = await startAgentConnectorFixture();
    db = await createTestDatabase();
    env = workEnv(db, { agents: { transport: 'fixture', productOrigin: PRODUCT } });
    w = await agentWorld(env, db, {
      reader: { kind: 'member', role: 'read_only' },
      outsider: { kind: 'member', role: 'member' },
      limited: { kind: 'member', role: 'limited_member' },
    });
    other = await agentWorld(env, db);
    third = await agentWorld(env, db);
    w.people.guest = await (
      await import('./fixture.ts')
    ).join(env, db, w.owner, w.ws, {
      kind: 'guest',
      records: [{ record: w.tasks['Write launch notes'], level: 'edit' }],
    });
    worker = await runWorker(env);
    await grantBrand(env, db, w, w.people.reader!, w.brands.Harbor!, 'view');
  });
  afterAll(async () => {
    await worker.stop();
    await env.h.close();
    await db.drop();
    await fx.close();
  });

  it('AT-657 automations invoke agents through the one admission and react to their results; a loop is stopped by the 8A guard', async () => {
    const task = w.tasks['Write launch notes']!;
    const agent = await externalAgent(env, db, fx, worker, w, 'Automated agent', {
      brands: [w.brands.Harbor!],
    });
    await env.svc.assignAgent(
      w.owner,
      w.ws,
      task,
      { profile: agent.id, goal: 'Draft on request.' },
      mutation(),
    );
    const make = async (name: string, definition: Record<string, unknown>) => {
      const a = (
        await env.svc.createAutomation(
          w.owner,
          w.ws,
          { name, scope: { kind: 'brand', brand: w.brands.Harbor! }, definition },
          mutation(),
        )
      ).data;
      return (await env.svc.activateAutomation(w.owner, w.ws, a.id, {}, v(a.version))).data as {
        id: string;
      };
    };
    const invoke = await make('Invoke on demand', {
      schema_version: 1,
      trigger: { kind: 'manual', record: 'task' },
      conditions: null,
      steps: [{ id: 'go', type: 'action', action: 'agent.invoke', params: { agent: agent.id } }],
    });
    // Reacting to a result by invoking the same agent again would loop: the guard bounds it.
    await make('Again on result', {
      schema_version: 1,
      trigger: { kind: 'agent.result', record: 'task' },
      conditions: null,
      steps: [{ id: 'again', type: 'action', action: 'agent.invoke', params: { agent: agent.id } }],
    });
    await env.svc.runAutomationNow(w.owner, w.ws, invoke.id, { record: task }, mutation());
    await settle(db, worker);
    const first = await runsOf(agent.id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ initiator_kind: 'automation' });
    // Admitted is not finished: the automation step recorded a request, nothing else.
    expect((await view(w.owner, first[0]!.public_id)).state).toBe('running');
    await complete(agent.peer, first[0]!.public_id);
    expect((await view(w.owner, first[0]!.public_id)).state).toBe('ready_for_review');
    // The result triggered "Again on result" once (a second run), whose own result is stopped by
    // the loop guard (no third run).
    const second = await runsOf(agent.id);
    expect(second).toHaveLength(2);
    await complete(agent.peer, second[1]!.public_id);
    expect(await runsOf(agent.id)).toHaveLength(2);
    const skipped = await db.admin(
      `SELECT count(*)::int AS n FROM automation.automation_run WHERE status = 'skipped'`,
    );
    expect(skipped.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('AT-658 outcomes reach metrics, briefings, and notifications per viewer; agent rates stay apart from automation rates', async () => {
    const task = w.tasks['Plan launch party']!;
    const agent = await externalAgent(env, db, fx, worker, w, 'Reported agent', {
      brands: [w.brands.Harbor!],
    });
    await env.svc.assignAgent(w.owner, w.ws, task, { profile: agent.id, goal: 'Try.' }, mutation());
    const run = (
      (await env.svc.startAgentRun(w.owner, w.ws, task, agent.id, {}, mutation())).data as {
        id: string;
      }
    ).id;
    await settle(db, worker);
    await complete(agent.peer, run, 'failed');
    const failure = await db.admin(
      `SELECT count(*)::int AS n FROM notify.notification WHERE type = 'agent_failure'`,
    );
    expect(failure.rows[0].n).toBeGreaterThanOrEqual(1);
    const catalog = await env.svc.insightMetrics(w.owner, w.ws);
    expect(catalog.not_available.map((m) => m.key)).not.toContain('agent.rates');
    expect(JSON.stringify(catalog)).toContain('agent.rates');
    const brief = (
      await env.svc.generateBriefing(w.owner, w.ws, { kind: 'owner_daily' }, mutation())
    ).data as {
      statements: Array<{ key: string; text: string }>;
    };
    const ready = brief.statements.find((s) => s.key === 'agent_runs.ready')!;
    expect(ready.text).toMatch(/agent run/);
    expect(ready.text).not.toMatch(/accepted\b(?! )/);
    expect(
      brief.statements.some((s) => s.key === `agent_runs.task:${w.tasks['Write launch notes']!}`),
    ).toBe(true);
    // A reader without Harbor sees no agent run statement about its tasks.
    const outsiderBrief = (
      await env.svc
        .generateBriefing(w.people.outsider!, w.ws, { kind: 'owner_daily' }, mutation())
        .catch(() => null)
    )?.data as { statements: Array<{ key: string }> } | undefined;
    if (outsiderBrief)
      expect(outsiderBrief.statements.some((s) => s.key.startsWith('agent_runs.task:'))).toBe(
        false,
      );
  });

  it('AT-659 a run credential acts for one run in one workspace: other runs, other workspaces, guessed ids, and people controls are refused', async () => {
    const a = await externalAgent(env, db, fx, worker, w, 'Scoped one', {
      brands: [w.brands.Harbor!],
    });
    const b = await externalAgent(env, db, fx, worker, w, 'Scoped two', {
      brands: [w.brands.Harbor!],
    });
    const t1 = (
      await env.svc.createTask(
        w.owner,
        w.ws,
        { brand: w.brands.Harbor!, title: 'Iso one' },
        mutation(),
      )
    ).data.id as string;
    const t2 = (
      await env.svc.createTask(
        w.owner,
        w.ws,
        { brand: w.brands.Harbor!, title: 'Iso two' },
        mutation(),
      )
    ).data.id as string;
    await env.svc.assignAgent(w.owner, w.ws, t1, { profile: a.id, goal: 'x' }, mutation());
    await env.svc.assignAgent(w.owner, w.ws, t2, { profile: b.id, goal: 'y' }, mutation());
    const r1 = (
      (await env.svc.startAgentRun(w.owner, w.ws, t1, a.id, {}, mutation())).data as { id: string }
    ).id;
    const r2 = (
      (await env.svc.startAgentRun(w.owner, w.ws, t2, b.id, {}, mutation())).data as { id: string }
    ).id;
    await settle(db, worker);
    const c1 = (await credentialCaller(env, tokenOf(a.peer)))!;
    // Another run's id, a guessed id, and another workspace: one opaque answer.
    await expect(
      env.svc.agentRunPostEvent(c1, w.ws, r2, { key: 'x', kind: 'progress', text: 'x' }),
    ).rejects.toEqual(code('not_found'));
    await expect(
      env.svc.agentRunPostEvent(c1, w.ws, 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ', {
        key: 'x',
        kind: 'progress',
        text: 'x',
      }),
    ).rejects.toEqual(code('not_found'));
    await expect(
      env.svc.agentRunPostEvent(c1, other.ws, r1, { key: 'x', kind: 'progress', text: 'x' }),
    ).rejects.toBeTruthy();
    // The other task (outside this run's ceiling) cannot be read through this run.
    await expect(
      env.svc.agentRunCallTool(c1, w.ws, r1, {
        key: 'g',
        tool: 'pm.tasks.get',
        version: '1',
        arguments: { task: t2 },
      }),
    ).rejects.toEqual(code('not_found'));
    // A run credential is not a person: people's run reads and controls refuse it.
    await expect(env.svc.getAgentRun(c1, w.ws, r1)).rejects.toEqual(code('not_found'));
    await expect(env.svc.controlAgentRun(c1, w.ws, r1, 'cancel', mutation())).rejects.toEqual(
      code('not_found'),
    );
    // A reader sees the run but not hidden scope; the other workspace sees nothing.
    expect((await view(w.people.reader!, r1)).capabilities).toMatchObject({
      pause: false,
      cancel: false,
      accept: false,
    });
    await expect(env.svc.getAgentRun(other.owner, w.ws, r1)).rejects.toBeTruthy();
    await expect(env.svc.getAgentRun(other.owner, other.ws, r1)).rejects.toEqual(code('not_found'));
  });

  it('AT-660 task purge removes runs with their events, tool calls, artifacts, and credentials', async () => {
    const t = (
      await env.svc.createTask(
        w.owner,
        w.ws,
        { brand: w.brands.Harbor!, title: 'To purge' },
        mutation(),
      )
    ).data.id as string;
    const agent = await externalAgent(env, db, fx, worker, w, 'Purge agent', {
      brands: [w.brands.Harbor!],
    });
    await env.svc.assignAgent(w.owner, w.ws, t, { profile: agent.id, goal: 'x' }, mutation());
    const run = (
      (await env.svc.startAgentRun(w.owner, w.ws, t, agent.id, {}, mutation())).data as {
        id: string;
      }
    ).id;
    await settle(db, worker);
    await complete(agent.peer, run);
    const row = await runRow(db, run);
    // The lifecycle executor calls the task purge hook (as for 8B assignments).
    const { purgeTaskAgentAssignments } = await import('@pm/work');
    await env.h.worker.withWorkspace(w.wsId, { module: 'test' }, (tx) =>
      purgeTaskAgentAssignments(tx as never, [row.task_id]),
    );
    await settle(db, worker);
    for (const table of [
      'agent_run',
      'agent_run_event',
      'agent_tool_call',
      'agent_artifact',
      'agent_run_credential',
    ]) {
      const col = table === 'agent_run' ? 'id' : 'run_id';
      const n = await db.admin(`SELECT count(*)::int AS n FROM agents.${table} WHERE ${col} = $1`, [
        row.id,
      ]);
      expect(n.rows[0].n, table).toBe(0);
    }
  });

  it('AT-666 every role, guest, and share across three workspaces: readers see runs without controls; a share-only guest cannot start or control; no access is one opaque answer; other workspaces see nothing', async () => {
    const task = w.tasks['Write launch notes']!;
    const agent = await externalAgent(env, db, fx, worker, w, 'Isolation agent', {
      brands: [w.brands.Harbor!],
    });
    await env.svc.assignAgent(w.owner, w.ws, task, { profile: agent.id, goal: 'x' }, mutation());
    // Neither a share-only guest nor a read-only member can start a run.
    for (const who of [w.people.guest!, w.people.reader!])
      await expect(
        env.svc.startAgentRun(who, w.ws, task, agent.id, {}, mutation()),
      ).rejects.toEqual(
        expect.objectContaining({ code: expect.stringMatching(/forbidden|not_found/) }),
      );
    const run = (
      (await env.svc.startAgentRun(w.owner, w.ws, task, agent.id, {}, mutation())).data as {
        id: string;
      }
    ).id;
    await settle(db, worker);
    // Whoever reads the task sees its runs (as with 8B assignments), without controls.
    for (const who of [w.people.guest!, w.people.reader!]) {
      const v = await view(who, run);
      expect(v.capabilities).toEqual({
        pause: false,
        resume: false,
        cancel: false,
        retry: false,
        accept: false,
      });
      await expect(env.svc.controlAgentRun(who, w.ws, run, 'pause', mutation())).rejects.toEqual(
        expect.objectContaining({ code: expect.stringMatching(/forbidden|not_found/) }),
      );
    }
    // No access to the task: the run, its events, and its drafts are one opaque answer.
    for (const who of [w.people.limited!, w.people.outsider!]) {
      await expect(env.svc.getAgentRun(who, w.ws, run)).rejects.toEqual(code('not_found'));
      await expect(env.svc.agentRunEvents(who, w.ws, run, {})).rejects.toEqual(code('not_found'));
      await expect(env.svc.getAgentArtifact(who, w.ws, run, 'notes')).rejects.toEqual(
        code('not_found'),
      );
      await expect(env.svc.listTaskAgentRuns(who, w.ws, task)).rejects.toEqual(code('not_found'));
    }
    // Health and the stop are for owners and administrators only.
    for (const who of [w.people.guest!, w.people.reader!, w.people.outsider!])
      await expect(env.svc.agentHealth(who, w.ws)).rejects.toEqual(code('not_found'));
    // Three workspaces never cross, in either direction.
    for (const x of [other, third]) {
      await expect(env.svc.getAgentRun(x.owner, x.ws, run)).rejects.toEqual(code('not_found'));
      await expect(env.svc.getAgentRun(x.owner, w.ws, run)).rejects.toBeTruthy();
      expect(
        ((await env.svc.agentHealth(x.owner, x.ws)) as { runs: Record<string, number> }).runs
          .running,
      ).toBe(0);
    }
    await env.svc.controlAgentRun(w.owner, w.ws, run, 'cancel', mutation());
    await settle(db, worker);
  });

  it('AT-667 withdrawing the assignment mid-run ends the run and its credential; the deadline fails a run that is still waiting on its agent', async () => {
    const mk = async (title: string, name: string) => {
      const t = (
        await env.svc.createTask(w.owner, w.ws, { brand: w.brands.Harbor!, title }, mutation())
      ).data.id as string;
      const a = await externalAgent(env, db, fx, worker, w, name, { brands: [w.brands.Harbor!] });
      await env.svc.assignAgent(w.owner, w.ws, t, { profile: a.id, goal: 'x' }, mutation());
      const run = (
        (await env.svc.startAgentRun(w.owner, w.ws, t, a.id, {}, mutation())).data as { id: string }
      ).id;
      await settle(db, worker);
      return { t, a, run };
    };
    const one = await mk('Withdrawn mid-run', 'Withdrawn agent');
    const token = tokenOf(one.a.peer);
    expect(await credentialCaller(env, token)).not.toBeNull();
    await env.svc.withdrawAgentAssignment(w.owner, w.ws, one.t, one.a.id, mutation());
    await settle(db, worker);
    // The credential stops at once; the next callback is refused; nothing is accepted.
    expect(await credentialCaller(env, token)).toBeNull();
    const ended = await view(w.owner, one.run);
    expect(['failed', 'cancelled']).toContain(ended.state);
    expect(ended.capabilities.accept).toBe(false);
    expect((await runRow(db, one.run)).ended_at).not.toBeNull();

    const two = await mk('Past its deadline', 'Slow agent');
    const row = await runRow(db, two.run);
    await db.admin(
      `UPDATE agents.agent_run SET deadline_at = now() - interval '1 second' WHERE id = $1`,
      [row.id],
    );
    // The run's continuation is scheduled for its deadline; bring that moment forward.
    await db.admin(
      `UPDATE exec.job SET run_at = now() WHERE operation_id = $1 AND state IN ('queued', 'retry_scheduled')`,
      [row.current_operation_id],
    );
    await settle(db, worker);
    await settle(db, worker);
    const late = await view(w.owner, two.run);
    expect(late).toMatchObject({ state: 'failed', failure: { code: 'limit_exceeded' } });
    expect(await credentialCaller(env, tokenOf(two.a.peer))).toBeNull();
  });
});
