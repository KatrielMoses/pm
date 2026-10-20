import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startAgentConnectorFixture, type AgentConnectorFixture } from '@pm/test-support';
import type { WorkerRuntime } from '@pm/platform';
import type { Caller } from '@pm/tenancy';
import { agentConnectorTestHandler } from '@pm/work';
import { apply, mutation, workEnv, type WorkEnv } from './fixture.ts';
import { automationWorker, settle } from './automation-support.ts';
import {
  agentWorld,
  code,
  config,
  grantBrand,
  issueOf,
  memberId,
  revokeBrand,
  v,
  type AgentWorld,
} from './agents-support.ts';

const SECRET = 'agent-credential-0123456789abcdef';

/**
 * Phase 8B structured task assignment (AGT-003/004/005, TSK-008, PERM-008): a real relationship
 * to tasks, separate from human assignees, requiring `agent.assign` and the profile's
 * eligibility. Effective scope is the pinned profile grants ∩ the assigner's access ∩ the
 * explicit assignment scope, bounded by the owner's authority, stored as a ceiling that only
 * narrows. Assignment states describe the assignment; nothing is dispatched and no run exists.
 */
describe('agents (8B): task assignments', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let fx: AgentConnectorFixture;
  let w: AgentWorld;
  let worker: WorkerRuntime;
  let agent: string;

  const external = async (name: string, scope: Record<string, string[]>, as: Caller = w.owner) => {
    const a = (
      await env.svc.createAgentProfile(
        as,
        w.ws,
        { name, kind: 'external', draft: config({ kind: 'external', model_key: null, scope }) },
        mutation(),
      )
    ).data as Record<string, any>;
    fx.peer(`peer-${a.id.slice(4, 14).toLowerCase()}`, { kind: 'api', secret: SECRET });
    await env.svc.configureAgentConnector(
      as,
      w.ws,
      a.id,
      {
        kind: 'api',
        endpoint_url: fx.endpoint(`peer-${a.id.slice(4, 14).toLowerCase()}`),
        secret: SECRET,
      },
      mutation(),
    );
    await env.svc.activateAgentProfile(as, w.ws, a.id, mutation());
    await env.svc.testAgentConnector(as, w.ws, a.id, { confirm: true }, mutation());
    await settle(db, worker);
    return a.id as string;
  };
  const brief = (over: Record<string, unknown> = {}) => ({
    profile: agent,
    goal: 'Draft the launch notes from the brief.',
    constraints: 'Keep it under one page.',
    deliverable: 'A draft document.',
    criteria: ['Mentions the launch date', 'Lists owners'],
    ...over,
  });
  const assignments = async (as: Caller, task: string) =>
    (await env.svc.listTaskAgentAssignments(as, w.ws, task)) as Record<string, any>;

  beforeAll(async () => {
    fx = await startAgentConnectorFixture();
    db = await createTestDatabase();
    env = workEnv(db, {
      agents: { transport: 'fixture', productOrigin: null },
      work: { agentAssignmentsPerTaskMax: 2 },
    });
    w = await agentWorld(env, db, {
      member: { kind: 'member', role: 'member' },
      reader: { kind: 'member', role: 'read_only' },
      shared: { kind: 'member', role: 'member' },
    });
    worker = await automationWorker(env, {
      handlers: [agentConnectorTestHandler({ service: env.workerSvc() })],
    });
    agent = await external('Launch writer', { brands: [w.brands.Harbor!] });
    await grantBrand(env, db, w, w.people.member!, w.brands.Harbor!, 'edit');
    await grantBrand(env, db, w, w.people.reader!, w.brands.Harbor!, 'view');
  });
  afterAll(async () => {
    await worker.stop();
    await env.h.close();
    await db.drop();
    await fx.close();
  });

  it("AT-608 the preview is structured: readable context and scope are shown, everything else is a named refusal of the caller's own input; nothing is saved", async () => {
    const task = w.tasks['Write launch notes']!;
    const p = (await env.svc.previewAgentAssignment(
      w.owner,
      w.ws,
      task,
      brief({ context: [w.tasks['Plan launch party']!, w.tasks['Vault plan']!] }),
    )) as Record<string, any>;
    expect(p.context.map((c: { name: string }) => c.name)).toEqual(['Plan launch party']);
    expect(p.refusals).toEqual([
      expect.objectContaining({ pointer: '/scope/records/2', code: 'outside_profile_scope' }),
      expect.objectContaining({ pointer: '/context/1', code: 'outside_assignment_scope' }),
    ]);
    expect(p).toMatchObject({
      can_save: false,
      readiness: { state: 'ready', synthetic: true },
      execution: { available: false, owner: '8C' },
    });
    expect(
      (await db.admin(`SELECT count(*)::int AS n FROM agents.agent_assignment`)).rows[0]!.n,
    ).toBe(0);
    // A hidden and an unknown identifier read the same.
    const m = w.people.member!;
    const hidden = (await env.svc.previewAgentAssignment(
      m,
      w.ws,
      task,
      brief({ context: [w.tasks['Vault plan']!, 'tsk_01HZZZZZZZZZZZZZZZZZZZZZZZ'] }),
    )) as Record<string, any>;
    expect(
      hidden.refusals
        .filter((r: { pointer: string }) => r.pointer.startsWith('/context'))
        .map((r: { code: string }) => r.code),
    ).toEqual(['not_available', 'not_available']);
    expect(JSON.stringify(hidden)).not.toContain('Vault plan');
  });

  it('AT-609 an assignment is a working relationship: it carries the brief, pins the profile revision, changes no task state, sends nothing, and execution is refused until 8C', async () => {
    const task = w.tasks['Write launch notes']!;
    const before = fx.received().length;
    const status = (await env.svc.getTask(w.owner, w.ws, task)) as Record<string, any>;
    const made = (
      await env.svc.assignAgent(
        w.owner,
        w.ws,
        task,
        brief({ context: [w.tasks['Plan launch party']!] }),
        mutation(),
      )
    ).data as Record<string, any>;
    expect(made).toMatchObject({
      type: 'agent_assignment',
      state: 'assigned',
      revision: 1,
      goal: 'Draft the launch notes from the brief.',
      criteria: ['Mentions the launch date', 'Lists owners'],
      context: [{ name: 'Plan launch party' }],
      profile: { id: agent, name: 'Launch writer', kind: 'external' },
      execution: { available: false, owner: '8C' },
    });
    expect(fx.received().length).toBe(before);
    const after = (await env.svc.getTask(w.owner, w.ws, task)) as Record<string, any>;
    expect({ status: after.status, version: after.version, assignees: after.assignees }).toEqual({
      status: status.status,
      version: status.version,
      assignees: status.assignees,
    });
    await expect(env.svc.startAgentRun(w.owner, w.ws, task, agent)).rejects.toEqual(
      issueOf('execution_unavailable'),
    );
    const rev = (
      await db.admin(
        `SELECT r.goal, r.context_refs, p.public_id AS profile_revision FROM agents.agent_assignment_revision r JOIN agents.agent_profile_revision pr ON pr.id = r.profile_revision_id JOIN core.record p ON p.id = pr.profile_id`,
      )
    ).rows[0]!;
    expect(rev).toMatchObject({
      goal: 'Draft the launch notes from the brief.',
      profile_revision: agent,
    });
    // No content of the task or the context record is copied anywhere in the assignment.
    expect(JSON.stringify(rev)).not.toContain('Plan launch party');
  });

  it('AT-610 one active assignment per task and agent; a replayed key changes nothing; the per-task limit holds under concurrency; withdraw then assign again', async () => {
    const task = w.tasks['Plan launch party']!;
    const req = mutation();
    const first = await env.svc.assignAgent(w.owner, w.ws, task, brief(), req);
    const again = await env.svc.assignAgent(w.owner, w.ws, task, brief(), req);
    expect(again.replayed).toBe(true);
    await expect(env.svc.assignAgent(w.owner, w.ws, task, brief(), mutation())).rejects.toEqual(
      issueOf('already_assigned'),
    );
    const second = await external('Second', { brands: [w.brands.Harbor!] });
    const third = await external('Third', { brands: [w.brands.Harbor!] });
    const results = await Promise.allSettled([
      env.svc.assignAgent(w.owner, w.ws, task, brief({ profile: second }), mutation()),
      env.svc.assignAgent(w.owner, w.ws, task, brief({ profile: third }), mutation()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: issueOf('limit_reached'),
    });
    const withdrawReq = mutation();
    const out = (await env.svc.withdrawAgentAssignment(w.owner, w.ws, task, agent, withdrawReq))
      .data as Record<string, any>;
    expect(out.state).toBe('withdrawn');
    expect(
      (await env.svc.withdrawAgentAssignment(w.owner, w.ws, task, agent, withdrawReq)).replayed,
    ).toBe(true);
    await expect(
      env.svc.withdrawAgentAssignment(w.owner, w.ws, task, agent, mutation()),
    ).rejects.toEqual(code('not_found'));
    const back = (
      await env.svc.assignAgent(w.owner, w.ws, task, brief({ goal: 'Second attempt.' }), mutation())
    ).data as Record<string, any>;
    expect(back).toMatchObject({ state: 'assigned', goal: 'Second attempt.' });
    const list = await assignments(w.owner, task);
    expect(list.data.map((a: { state: string }) => a.state).sort()).toEqual([
      'assigned',
      'assigned',
      'withdrawn',
    ]);
    void first;
  });

  it('AT-611 no confused deputy: a powerful agent never lends access; assigners need agent.assign on the task; shares, guests, and read-only members cannot assign', async () => {
    const wide = await external('Wide agent', { brands: [w.brands.Harbor!, w.brands.Vault!] });
    const m = w.people.member!;
    // The member cannot reach Vault through the wide agent: its items are refused like unknown ones.
    const p = (await env.svc.previewAgentAssignment(
      m,
      w.ws,
      w.tasks['Loose harbor task']!,
      brief({ profile: wide, scope: { brands: [w.brands.Harbor!, w.brands.Vault!] } }),
    )) as Record<string, any>;
    expect(p.refusals).toEqual([
      expect.objectContaining({ pointer: '/scope/brands/1', code: 'not_available' }),
    ]);
    expect(JSON.stringify(p.scope)).not.toContain(w.brands.Vault!);
    await expect(
      env.svc.assignAgent(
        m,
        w.ws,
        w.tasks['Loose harbor task']!,
        brief({ profile: wide, scope: { brands: [w.brands.Harbor!, w.brands.Vault!] } }),
        mutation(),
      ),
    ).rejects.toEqual(issueOf('not_available'));
    const ok = (
      await env.svc.assignAgent(
        m,
        w.ws,
        w.tasks['Loose harbor task']!,
        brief({ profile: wide, scope: { brands: [w.brands.Harbor!] } }),
        mutation(),
      )
    ).data as Record<string, any>;
    expect(ok.scope.items.map((i: { id: string }) => i.id)).toEqual([w.brands.Harbor!]);
    // Read-only members and record shares cannot assign agents.
    await expect(
      env.svc.assignAgent(
        w.people.reader!,
        w.ws,
        w.tasks['Write launch notes']!,
        brief(),
        mutation(),
      ),
    ).rejects.toEqual(code('forbidden'));
    const shared = w.people.shared!;
    await env.svc.createShare(
      w.owner,
      w.ws,
      {
        record: w.tasks['Write launch notes']!,
        grantee: await memberId(db, w, shared),
        level: 'edit',
      },
      mutation(),
    );
    await expect(
      env.svc.assignAgent(shared, w.ws, w.tasks['Write launch notes']!, brief(), mutation()),
    ).rejects.toEqual(code('forbidden'));
    // An agent that does not exist and one that is not turned on are refused.
    await expect(
      env.svc.assignAgent(
        w.owner,
        w.ws,
        w.tasks['Write launch notes']!,
        brief({ profile: 'agt_01HZZZZZZZZZZZZZZZZZZZZZZZ' }),
        mutation(),
      ),
    ).rejects.toEqual(code('not_found'));
    const off = (
      await env.svc.createAgentProfile(w.owner, w.ws, { name: 'Off', kind: 'internal' }, mutation())
    ).data as Record<string, any>;
    await expect(
      env.svc.assignAgent(
        w.owner,
        w.ws,
        w.tasks['Write launch notes']!,
        brief({ profile: off.id }),
        mutation(),
      ),
    ).rejects.toEqual(issueOf('profile_not_active'));
  });

  it('AT-612 the ceiling never grows: profile widening keeps it; narrowing, the assigner losing access, and the owner departing block it truthfully', async () => {
    const owner2 = w.people.member!;
    await env.svc.updatePolicy(
      w.owner,
      w.ws,
      { changes: { members_configure_agents: true }, confirm_exposure: true },
      mutation(),
    );
    const ag = await external('Ceiling', { projects: [w.projects.Launch!] }, owner2);
    const task = w.tasks['Write launch notes']!;
    const a = (await env.svc.assignAgent(w.owner, w.ws, task, brief({ profile: ag }), mutation()))
      .data as Record<string, any>;
    expect(a.state).toBe('assigned');
    // Widen the profile to the whole brand: the stored assignment keeps its ceiling (the task only).
    let prof = (await env.svc.getAgentProfile(owner2, w.ws, ag)) as Record<string, any>;
    await env.svc.updateAgentProfile(
      owner2,
      w.ws,
      ag,
      { draft: { ...prof.draft, scope: { brands: [w.brands.Harbor!] } } },
      v(prof.version),
    );
    await env.svc.activateAgentProfile(owner2, w.ws, ag, mutation());
    await env.svc.testAgentConnector(owner2, w.ws, ag, { confirm: true }, mutation());
    await settle(db, worker);
    let now = (await assignments(w.owner, task)).data.find(
      (x: { profile: { id: string } }) => x.profile.id === ag,
    );
    expect(now).toMatchObject({ state: 'assigned', revision: 1 });
    expect(now.scope.items.map((i: { name: string }) => i.name)).toEqual(['Write launch notes']);
    // Narrow the profile to another project: the task leaves its grants; the assignment is blocked.
    prof = (await env.svc.getAgentProfile(owner2, w.ws, ag)) as Record<string, any>;
    const other = (
      await env.svc.createProject(
        w.owner,
        w.ws,
        { brand: w.brands.Harbor!, name: 'Elsewhere' },
        mutation(),
      )
    ).data.id as string;
    await env.svc.updateAgentProfile(
      owner2,
      w.ws,
      ag,
      { draft: { ...prof.draft, scope: { projects: [other] } } },
      v(prof.version),
    );
    await env.svc.activateAgentProfile(owner2, w.ws, ag, mutation());
    await env.svc.testAgentConnector(owner2, w.ws, ag, { confirm: true }, mutation());
    await settle(db, worker);
    now = (await assignments(w.owner, task)).data.find(
      (x: { profile: { id: string } }) => x.profile.id === ag,
    );
    expect(now).toMatchObject({ state: 'blocked', blocked_reasons: ['scope_lost'] });
    // The owner loses Harbor: the profile cannot work there and the assignment says why.
    prof = (await env.svc.getAgentProfile(owner2, w.ws, ag)) as Record<string, any>;
    await env.svc.updateAgentProfile(
      owner2,
      w.ws,
      ag,
      { draft: { ...prof.draft, scope: { projects: [w.projects.Launch!] } } },
      v(prof.version),
    );
    await env.svc.activateAgentProfile(owner2, w.ws, ag, mutation());
    await env.svc.testAgentConnector(owner2, w.ws, ag, { confirm: true }, mutation());
    await settle(db, worker);
    expect(
      (await assignments(w.owner, task)).data.find(
        (x: { profile: { id: string } }) => x.profile.id === ag,
      ).state,
    ).toBe('assigned');
    await revokeBrand(env, db, w, owner2, w.brands.Harbor!);
    now = (await assignments(w.owner, task)).data.find(
      (x: { profile: { id: string } }) => x.profile.id === ag,
    );
    expect(now.state).toBe('blocked');
    expect(now.blocked_reasons).toEqual(expect.arrayContaining(['owner_authority', 'scope_lost']));
    // The profile itself says its owner can no longer grant its scope (decided now, no sweep).
    const viewed = (await env.svc.getAgentProfile(w.owner, w.ws, ag)) as Record<string, any>;
    expect(viewed.readiness.reasons).toContain('owner_authority');
    // The owner departs: the profile is suspended and the assignment blocked (nothing reassigned).
    const pv = await env.svc.previewChange(w.owner, w.ws, {
      kind: 'remove',
      member: await memberId(db, w, owner2),
    });
    env.stepUp.allow = true;
    await env.svc.removeMember(
      w.owner,
      w.ws,
      await memberId(db, w, owner2),
      { preview_token: pv.preview_token, reassign_to: await memberId(db, w, w.owner) },
      mutation({ stepUpToken: 't' }),
    );
    env.stepUp.allow = false;
    now = (await assignments(w.owner, task)).data.find(
      (x: { profile: { id: string } }) => x.profile.id === ag,
    );
    expect(now.state).toBe('blocked');
    expect(now.blocked_reasons).toEqual(expect.arrayContaining(['owner_departed']));
    await env.svc.updatePolicy(
      w.owner,
      w.ws,
      { changes: { members_configure_agents: false } },
      mutation(),
    );
    void apply;
  });

  it('AT-613 editing an assignment is a new revision decided now; a stale version never overwrites; widening needs a new authorized revision', async () => {
    const task = w.tasks['Write launch notes']!;
    const list = await assignments(w.owner, task);
    const a = list.data.find(
      (x: { profile: { id: string }; state: string }) =>
        x.profile.id === agent && x.state === 'assigned',
    );
    const next = (
      await env.svc.updateAgentAssignment(
        w.owner,
        w.ws,
        task,
        agent,
        { goal: 'Revise the launch notes.', scope: { brands: [w.brands.Harbor!] } },
        v(a.version),
      )
    ).data as Record<string, any>;
    expect(next).toMatchObject({ revision: 2, goal: 'Revise the launch notes.' });
    expect(next.scope.items.map((i: { id: string }) => i.id)).toEqual([w.brands.Harbor!]);
    await expect(
      env.svc.updateAgentAssignment(w.owner, w.ws, task, agent, { goal: 'Stale.' }, v(a.version)),
    ).rejects.toEqual(code('conflict'));
    // Revision 1 is unchanged (immutable history).
    const revs = (
      await db.admin(
        `SELECT r.revision_number, r.goal FROM agents.agent_assignment_revision r JOIN agents.agent_assignment a ON a.id = r.assignment_id JOIN core.record c ON c.id = a.task_id JOIN core.record pc ON pc.id = a.profile_id WHERE c.public_id = $1 AND pc.public_id = $2 AND a.state = 'assigned' ORDER BY r.revision_number`,
        [task, agent],
      )
    ).rows;
    expect(revs.slice(0, 2)).toEqual([
      { revision_number: 1, goal: 'Draft the launch notes from the brief.' },
      { revision_number: 2, goal: 'Revise the launch notes.' },
    ]);
  });

  it('AT-614 a reader of the task sees the brief and the agent by name only; never instructions, grants, connector, or unreadable context', async () => {
    const reader = w.people.reader!;
    const list = await assignments(reader, w.tasks['Write launch notes']!);
    const text = JSON.stringify(list);
    expect(list.capabilities.assign).toBe(false);
    expect(text).toContain('Revise the launch notes.');
    for (const hidden of [
      'Summarize the assigned task',
      'endpoint',
      SECRET,
      'pm.tasks.get',
      'Vault',
    ])
      expect(text).not.toContain(hidden);
    // Someone who cannot read the task sees nothing at all.
    await expect(assignments(w.people.shared!, w.tasks['Vault plan']!)).rejects.toEqual(
      code('not_found'),
    );
  });
});
