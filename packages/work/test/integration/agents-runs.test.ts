import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  startAgentConnectorFixture,
  startAiProviderFixture,
  type AgentConnectorFixture,
  type AiProviderFixture,
} from '@pm/test-support';
import type { WorkerRuntime } from '@pm/platform';
import { mutation, workEnv, type WorkEnv } from './fixture.ts';
import { settle } from './automation-support.ts';
import { agentWorld, code, config, grantBrand, type AgentWorld } from './agents-support.ts';
import { enableAi, fixtureAi } from './ai-support.ts';
import {
  credentialCaller,
  externalAgent,
  PRODUCT,
  runRow,
  runWorker,
} from './agents-runs-support.ts';

/**
 * Phase 8C durable agent runs end to end (AGT-009–013, AGT-022, LA-008): an assigned agent is
 * admitted, reads an allowed record through a scoped registered tool, emits non-terminal
 * progress, returns a validated draft artifact, and reaches ready for review, while the task's
 * status stays unchanged and nothing is accepted. External agents work through the real
 * dispatch transport and their run-bound credential; internal agents through the AI gateway.
 */
describe('agent runs (8C): end to end', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let fx: AgentConnectorFixture;
  let ai: AiProviderFixture;
  let w: AgentWorld;
  let worker: WorkerRuntime;

  const assign = (agent: string, task: string, extra: Record<string, unknown> = {}) =>
    env.svc.assignAgent(
      w.owner,
      w.ws,
      task,
      { profile: agent, goal: 'Draft the launch notes.', ...extra },
      mutation(),
    );
  const start = async (agent: string, task: string) =>
    (await env.svc.startAgentRun(w.owner, w.ws, task, agent, {}, mutation())).data as Record<
      string,
      any
    >;
  const view = async (run: string) =>
    (await env.svc.getAgentRun(w.owner, w.ws, run)) as Record<string, any>;
  const taskStatus = async (task: string) =>
    (
      await db.admin(
        `SELECT t.status_id FROM work.task t JOIN core.record r ON r.id = t.id WHERE r.public_id = $1`,
        [task],
      )
    ).rows[0].status_id;

  beforeAll(async () => {
    fx = await startAgentConnectorFixture();
    ai = await startAiProviderFixture();
    db = await createTestDatabase();
    env = workEnv(db, {
      agents: { transport: 'fixture', productOrigin: PRODUCT },
      ai: fixtureAi(ai),
    });
    w = await agentWorld(env, db, { member: { kind: 'member', role: 'member' } });
    worker = await runWorker(env, { ai: true });
    await grantBrand(env, db, w, w.people.member!, w.brands.Harbor!, 'edit');
  });
  afterAll(async () => {
    await worker.stop();
    await env.h.close();
    await db.drop();
    await fx.close();
    await ai.close();
  });

  it('AT-643 external run: admit, dispatch with a run-bound credential, scoped read, refused write, progress, draft artifact, ready for review; the task is unchanged', async () => {
    const task = w.tasks['Write launch notes']!;
    const agent = await externalAgent(env, db, fx, worker, w, 'Notes agent', {
      brands: [w.brands.Harbor!],
    });
    await assign(agent.id, task, { deliverable: 'Launch notes as a draft.' });
    const before = await taskStatus(task);
    const run = await start(agent.id, task);
    expect(run).toMatchObject({
      type: 'agent_run',
      state: 'queued',
      review: null,
      capabilities: { accept: false },
    });
    // A second start while one is open is refused (one open run per task and agent).
    await expect(
      env.svc.startAgentRun(w.owner, w.ws, task, agent.id, {}, mutation()),
    ).rejects.toEqual(
      expect.objectContaining({ issues: [expect.objectContaining({ code: 'run_in_progress' })] }),
    );
    await settle(db, worker);
    const dispatch = fx.dispatches().at(-1)!;
    expect(dispatch.body).toMatchObject({
      type: 'agent.run.dispatch',
      protocol: 'pm-agent/1',
      run: { id: run.id, attempt: 1 },
      task: { id: task },
      brief: { goal: 'Draft the launch notes.', deliverable: 'Launch notes as a draft.' },
      tools: [{ name: 'pm.tasks.get', version: '1' }],
    });
    const token = (dispatch.body.credential as { token: string }).token;
    expect(token).toMatch(/^par_/);
    // Only the hash is stored; the token is never in the job checkpoint.
    const stored = await db.admin(
      `SELECT token_prefix, token_hash FROM agents.agent_run_credential`,
    );
    expect(stored.rows.some((r) => r.token_prefix === token.slice(0, 12))).toBe(true);
    const ck = await db.admin(
      `SELECT checkpoint::text AS c FROM exec.job WHERE kind = 'agents.run'`,
    );
    for (const r of ck.rows) expect(r.c ?? '').not.toContain(token);
    expect((await view(run.id)).state).toBe('running');

    const agentCaller = (await credentialCaller(env, token))!;
    await env.svc.agentRunPostEvent(agentCaller, w.ws, run.id, {
      key: 'p1',
      kind: 'progress',
      text: 'Reading the task.',
      percent: 20,
    });
    await env.svc.agentRunPostEvent(agentCaller, w.ws, run.id, {
      key: 'c1',
      kind: 'commentary',
      text: 'Done! Everything is complete.',
    });
    // Commentary never completes anything.
    expect((await view(run.id)).state).toBe('running');
    const read = await env.svc.agentRunCallTool(agentCaller, w.ws, run.id, {
      key: 'r1',
      tool: 'pm.tasks.get',
      version: '1',
      arguments: { task },
    });
    expect(read).toMatchObject({
      decision: 'executed',
      result: { id: task, title: 'Write launch notes' },
    });
    await expect(
      env.svc.agentRunCallTool(agentCaller, w.ws, run.id, {
        key: 'u1',
        tool: 'pm.tasks.update',
        version: '1',
        arguments: { task, fields: { title: 'Changed' } },
      }),
    ).rejects.toEqual(code('approval_required'));
    // Outside the ceiling (another brand's task) is the same answer as unknown.
    await expect(
      env.svc.agentRunCallTool(agentCaller, w.ws, run.id, {
        key: 'r2',
        tool: 'pm.tasks.get',
        version: '1',
        arguments: { task: w.tasks['Vault plan']! },
      }),
    ).rejects.toEqual(code('not_found'));
    await expect(
      env.svc.agentRunCallTool(agentCaller, w.ws, run.id, {
        key: 'r3',
        tool: 'shell.exec',
        version: '1',
        arguments: {},
      }),
    ).rejects.toEqual(code('not_found'));
    // A result naming no artifact while the assignment expects a deliverable is refused.
    await expect(
      env.svc.agentRunPostResult(agentCaller, w.ws, run.id, {
        key: 'x',
        attempt: 1,
        status: 'completed',
        summary: 'Done.',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: 'deliverable_missing' })],
      }),
    );
    const content = '# Launch notes\n\nDraft.';
    const sha = (await import('node:crypto')).createHash('sha256').update(content).digest('hex');
    await env.svc.agentRunPostArtifact(agentCaller, w.ws, run.id, {
      key: 'notes',
      title: 'Launch notes',
      media_type: 'text/markdown',
      content,
      sha256: sha,
    });
    await expect(
      env.svc.agentRunPostArtifact(agentCaller, w.ws, run.id, {
        key: 'bin',
        title: 'Binary',
        media_type: 'application/octet-stream',
        content: 'x',
        sha256: sha,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'unsupported_media_type' }),
        ]),
      }),
    );
    const res = await env.svc.agentRunPostResult(agentCaller, w.ws, run.id, {
      key: 'res1',
      attempt: 1,
      status: 'completed',
      summary: 'Notes drafted.',
      artifacts: ['notes'],
      reported_cost: { amount_micros: 1500, currency: 'USD' },
    });
    expect(res).toMatchObject({ status: 'ready_for_review' });
    await settle(db, worker);
    const done = await view(run.id);
    expect(done).toMatchObject({
      state: 'ready_for_review',
      review: { required: true, owner: '8D' },
      capabilities: { accept: false, retry: false },
      costs: {
        measured: null,
        reported: { micros: 1500, currency: 'USD', label: 'reported by Notes agent' },
      },
      artifacts: [
        expect.objectContaining({
          key: 'notes',
          version: 1,
          media_type: 'text/markdown',
          sha256: sha,
        }),
      ],
    });
    expect(
      done.tool_calls.map((c: { tool: string; decision: string }) => `${c.tool}:${c.decision}`),
    ).toEqual(
      expect.arrayContaining([
        'pm.tasks.get:executed',
        'pm.tasks.update:approval_required',
        'pm.tasks.get:refused',
      ]),
    );
    // The task's own status never changed; the credential stopped working.
    expect(await taskStatus(task)).toBe(before);
    expect(await credentialCaller(env, token)).toBeNull();
    const row = await runRow(db, run.id);
    expect(row).toMatchObject({ execution_state: 'succeeded', result_status: 'completed' });
    expect(row.ended_at).not.toBeNull();
    // A late duplicate result changes nothing.
    await expect(
      env.svc.agentRunPostResult(agentCaller, w.ws, run.id, {
        key: 'res2',
        attempt: 1,
        status: 'failed',
        summary: 'Late.',
      }),
    ).rejects.toEqual(code('not_found'));
    // People are told the output is ready (never that the task is done).
    const notes = await db.admin(
      `SELECT type FROM notify.notification WHERE type = 'agent_output_ready'`,
    );
    expect(notes.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('AT-644 internal run: a gateway model turn under the run principal returns a draft artifact; measured usage is recorded; AI off is a refusal, never a success', async () => {
    const task = w.tasks['Plan launch party']!;
    const internal = (
      await env.svc.createAgentProfile(
        w.owner,
        w.ws,
        {
          name: 'Writer',
          kind: 'internal',
          draft: config({ scope: { brands: [w.brands.Harbor!] } }),
        },
        mutation(),
      )
    ).data as Record<string, any>;
    await env.svc.activateAgentProfile(w.owner, w.ws, internal.id, mutation());
    await assign(internal.id, task);
    // AI is not configured: admission refuses truthfully (a manual path stays open).
    await expect(
      env.svc.startAgentRun(w.owner, w.ws, task, internal.id, {}, mutation()),
    ).rejects.toEqual(expect.objectContaining({ code: 'conflict' }));
    await enableAi(env, w.owner, w.ws);
    const before = await taskStatus(task);
    const run = (
      await env.svc.startAgentRun(w.owner, w.ws, task, internal.id, { confirm: true }, mutation())
    ).data as Record<string, any>;
    await settle(db, worker);
    await settle(db, worker);
    const v = await view(run.id);
    expect(v).toMatchObject({ state: 'ready_for_review', review: { required: true, owner: '8D' } });
    expect(v.artifacts).toEqual([
      expect.objectContaining({ key: 'draft', producer: 'internal', media_type: 'text/markdown' }),
    ]);
    expect(v.tool_calls).toEqual([
      expect.objectContaining({ tool: 'pm.tasks.get', decision: 'executed' }),
    ]);
    expect(v.costs.reported).toBeNull();
    const art = (await env.svc.getAgentArtifact(w.owner, w.ws, run.id, 'draft')) as Record<
      string,
      any
    >;
    expect(art.versions[0].content).toContain('Agent draft');
    const turn = await db.admin(
      `SELECT a.caller_kind FROM ai.ai_action a JOIN agents.agent_run r ON r.model_operation_id = a.operation_id`,
    );
    expect(turn.rows).toEqual([{ caller_kind: 'agent' }]);
    expect(await taskStatus(task)).toBe(before);
  });
});
