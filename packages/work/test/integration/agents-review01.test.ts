import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startAgentConnectorFixture, type AgentConnectorFixture } from '@pm/test-support';
import type { WorkerRuntime } from '@pm/platform';
import type { Caller } from '@pm/tenancy';
import { agentConnectorTestHandler } from '@pm/work';
import { internalIdOf, mutation, workEnv, type WorkEnv } from './fixture.ts';
import { automationWorker, settle } from './automation-support.ts';
import {
  agentWorld,
  code,
  config,
  grantBrand,
  revokeBrand,
  type AgentWorld,
} from './agents-support.ts';

const SECRET = 'agent-credential-0123456789abcdef';

/**
 * Phase 8B corrective review 01.
 *
 * R1: an assignment's stored scope and context render only the items the viewer can open; hidden
 * items are omitted completely (no count, total, flag, or placeholder), so assignments that differ
 * only in hidden items look the same to a narrower reader.
 *
 * R2: one eligibility decision for preview, save, edit, readiness, and the 8C handoff: the task is
 * loaded as the original assigner now, needs their current `agent.assign` (no shares) and an
 * active task, and the live ceiling is the stored ceiling ∩ the pinned and current profile grants
 * ∩ the assigner's and the owner's current access. Readable is not assignable.
 */
describe('agents (8B review 01): hidden scope is omitted; assignment eligibility is decided now', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let fx: AgentConnectorFixture;
  let w: AgentWorld;
  let worker: WorkerRuntime;
  let other: string;
  const projects: string[] = [];
  let otherTask: string;

  const external = async (name: string, scope: Record<string, string[]>, as: Caller = w.owner) => {
    const a = (
      await env.svc.createAgentProfile(
        as,
        w.ws,
        { name, kind: 'external', draft: config({ kind: 'external', model_key: null, scope }) },
        mutation(),
      )
    ).data as Record<string, any>;
    const peer = `peer-${a.id.slice(4, 14).toLowerCase()}`;
    fx.peer(peer, { kind: 'api', secret: SECRET });
    await env.svc.configureAgentConnector(
      as,
      w.ws,
      a.id,
      { kind: 'api', endpoint_url: fx.endpoint(peer), secret: SECRET },
      mutation(),
    );
    await env.svc.activateAgentProfile(as, w.ws, a.id, mutation());
    await env.svc.testAgentConnector(as, w.ws, a.id, { confirm: true }, mutation());
    await settle(db, worker);
    return a.id as string;
  };
  const list = async (as: Caller, task: string) =>
    ((await env.svc.listTaskAgentAssignments(as, w.ws, task)) as Record<string, any>).data as Array<
      Record<string, any>
    >;
  const one = async (as: Caller, task: string, agt: string) =>
    (await list(as, task)).find((x) => x.profile.id === agt)!;
  /** The 8C handoff decision for one stored assignment (the shared eligibility logic). */
  const handoff = async (task: string, agt: string) => {
    const svc = env.svc as unknown as {
      inWorkspace: (
        c: Caller,
        ws: string,
        o: unknown,
        fn: (tx: unknown, p: unknown) => unknown,
      ) => Promise<unknown>;
      agentAssignmentEligibility: (
        tx: unknown,
        task: string,
        profile: string,
      ) => Promise<Record<string, any>>;
    };
    return (await svc.inWorkspace(w.owner, w.ws, { readOnly: true }, (tx) =>
      svc.agentAssignmentEligibility(tx, task, agt),
    )) as Record<string, any>;
  };

  beforeAll(async () => {
    fx = await startAgentConnectorFixture();
    db = await createTestDatabase();
    env = workEnv(db, { agents: { transport: 'fixture', productOrigin: null } });
    w = await agentWorld(env, db, {
      member: { kind: 'member', role: 'member' },
      limited: { kind: 'member', role: 'limited_member' },
      reader: { kind: 'member', role: 'read_only' },
    });
    worker = await automationWorker(env, {
      handlers: [agentConnectorTestHandler({ service: env.workerSvc() })],
    });
    other = (await env.svc.createBrand(w.owner, w.ws, { name: 'Other' }, mutation())).data
      .id as string;
    for (const name of ['Other one', 'Other two', 'Other three'])
      projects.push(
        (await env.svc.createProject(w.owner, w.ws, { brand: other, name }, mutation())).data
          .id as string,
      );
    otherTask = (
      await env.svc.createTask(w.owner, w.ws, { brand: other, title: 'Other context' }, mutation())
    ).data.id as string;
    await grantBrand(env, db, w, w.people.reader!, w.brands.Harbor!, 'view');
    await grantBrand(env, db, w, w.people.member!, w.brands.Harbor!, 'edit');
    await grantBrand(env, db, w, w.people.limited!, w.brands.Harbor!, 'edit');
  });
  afterAll(async () => {
    await worker.stop();
    await env.h.close();
    await db.drop();
    await fx.close();
  });

  it('AT-634 R1: assignments that differ only in hidden scope items render identically to a narrower reader; nothing counts or flags what is hidden', async () => {
    const task = w.tasks['Write launch notes']!;
    const scopes = [[], [projects[0]!], [projects[0]!, projects[1]!, projects[2]!]];
    const agents: string[] = [];
    for (const [i, extra] of scopes.entries()) {
      const agt = await external(`Equivalent ${i}`, { brands: [w.brands.Harbor!, other] });
      agents.push(agt);
      await env.svc.assignAgent(
        w.owner,
        w.ws,
        task,
        { profile: agt, goal: 'Same brief.', scope: { records: [task], projects: extra } },
        mutation(),
      );
    }
    const reader = w.people.reader!;
    const rendered = [];
    for (const agt of agents) {
      const a = await one(reader, task, agt);
      const { id: _id, profile: _profile, version: _v, assigned_at: _at, ...rest } = a;
      rendered.push(JSON.stringify(rest));
    }
    // Zero, one, and three hidden items: the reader cannot tell them apart.
    expect(rendered[1]).toBe(rendered[0]);
    expect(rendered[2]).toBe(rendered[0]);
    for (const r of rendered) {
      expect(r).not.toMatch(/not_shown|hidden|omitted/);
      for (const p of projects) expect(r).not.toContain(p);
    }
    const seen = await one(reader, task, agents[2]!);
    expect(seen.scope.items.map((x: { name: string }) => x.name)).toEqual(['Write launch notes']);
    expect(Object.keys(seen.scope)).toEqual(['items']);
  });

  it('AT-635 R1: a broad configurer sees every selected item; a reader revoked after a first read gets the opaque answer', async () => {
    const task = w.tasks['Write launch notes']!;
    const all = await list(w.owner, task);
    const wide = all.find((x) => x.profile.name === 'Equivalent 2')!;
    expect(wide.scope.items.map((x: { name: string }) => x.name).sort()).toEqual(
      ['Other one', 'Other three', 'Other two', 'Write launch notes'].sort(),
    );
    const reader = w.people.reader!;
    expect((await list(reader, task)).length).toBe(all.length);
    await revokeBrand(env, db, w, reader, w.brands.Harbor!);
    await expect(env.svc.listTaskAgentAssignments(reader, w.ws, task)).rejects.toEqual(
      code('not_found'),
    );
    await grantBrand(env, db, w, reader, w.brands.Harbor!, 'view');
  });

  it('AT-636 R2: an assigner downgraded to view keeps reading the task, but the assignment is blocked and they can no longer assign, edit, or replay', async () => {
    const task = w.tasks['Plan launch party']!;
    const member = w.people.member!;
    const theirs = await external('Downgrade', { brands: [w.brands.Harbor!] });
    const control = await external('Control', { brands: [w.brands.Harbor!] });
    const req = mutation();
    await env.svc.assignAgent(member, w.ws, task, { profile: theirs, goal: 'By the member.' }, req);
    await env.svc.assignAgent(
      w.owner,
      w.ws,
      task,
      { profile: control, goal: 'By the owner.' },
      mutation(),
    );
    expect((await one(w.owner, task, theirs)).state).toBe('assigned');
    // Downgrade: the member still reads Harbor and stays an active member.
    await revokeBrand(env, db, w, member, w.brands.Harbor!);
    await grantBrand(env, db, w, member, w.brands.Harbor!, 'view');
    const seen = await one(w.owner, task, theirs);
    expect(seen.state).toBe('blocked');
    expect(seen.blocked_reasons).toContain('assigner_authority');
    expect((await one(member, task, theirs)).state).toBe('blocked');
    const h = await handoff(task, theirs);
    expect(h).toMatchObject({ eligible: false });
    expect(h.reasons).toContain('assigner_authority');
    // Unchanged authority: the owner's assignment on the same task stays assigned.
    expect((await one(w.owner, task, control)).state).toBe('assigned');
    expect((await handoff(task, control)).eligible).toBe(true);
    // The downgraded assigner cannot assign, edit, withdraw, or replay their completed key.
    await expect(
      env.svc.assignAgent(member, w.ws, task, { profile: control, goal: 'Again.' }, mutation()),
    ).rejects.toEqual(code('forbidden'));
    await expect(
      env.svc.updateAgentAssignment(
        member,
        w.ws,
        task,
        theirs,
        { goal: 'Edited.' },
        mutation({ ifMatch: '"0"' }),
      ),
    ).rejects.toEqual(code('forbidden'));
    await expect(
      env.svc.assignAgent(member, w.ws, task, { profile: theirs, goal: 'By the member.' }, req),
    ).rejects.toEqual(
      expect.objectContaining({ code: expect.stringMatching(/^(forbidden|not_found)$/) }),
    );
    // Restoring edit makes it eligible again (readiness is decided now, never stored).
    await revokeBrand(env, db, w, member, w.brands.Harbor!);
    await grantBrand(env, db, w, member, w.brands.Harbor!, 'edit');
    expect((await one(w.owner, task, theirs)).state).toBe('assigned');
  });

  it('AT-637 R2: losing the workspace policy that let a limited member assign blocks their assignment', async () => {
    const task = w.tasks['Loose harbor task']!;
    const limited = w.people.limited!;
    await env.svc.updatePolicy(
      w.owner,
      w.ws,
      { changes: { limited_members_agents: true }, confirm_exposure: true },
      mutation(),
    );
    const agt = await external('Policy', { brands: [w.brands.Harbor!] });
    await env.svc.assignAgent(
      limited,
      w.ws,
      task,
      { profile: agt, goal: 'By policy.' },
      mutation(),
    );
    expect((await one(w.owner, task, agt)).state).toBe('assigned');
    await env.svc.updatePolicy(
      w.owner,
      w.ws,
      { changes: { limited_members_agents: false }, confirm_exposure: true },
      mutation(),
    );
    const seen = await one(w.owner, task, agt);
    expect(seen.state).toBe('blocked');
    expect(seen.blocked_reasons).toContain('assigner_authority');
    expect((await handoff(task, agt)).reasons).toContain('assigner_authority');
  });

  it('AT-638 R2: an archived or trashed task makes its assignments ineligible; restoring it makes them eligible again', async () => {
    const task = (
      await env.svc.createTask(
        w.owner,
        w.ws,
        { brand: w.brands.Harbor!, title: 'Lifecycle target' },
        mutation(),
      )
    ).data.id as string;
    const agt = await external('Lifecycle', { brands: [w.brands.Harbor!] });
    await env.svc.assignAgent(
      w.owner,
      w.ws,
      task,
      { profile: agt, goal: 'Lifecycle.' },
      mutation(),
    );
    expect((await one(w.owner, task, agt)).state).toBe('assigned');
    await env.svc.taskLifecycle(w.owner, w.ws, task, 'archive', {}, mutation());
    const archived = await one(w.owner, task, agt);
    expect(archived.state).toBe('blocked');
    expect(archived.blocked_reasons).toContain('task_ineligible');
    expect((await handoff(task, agt)).reasons).toContain('task_ineligible');
    await env.svc.taskLifecycle(w.owner, w.ws, task, 'unarchive', {}, mutation());
    expect((await one(w.owner, task, agt)).state).toBe('assigned');
    await env.svc.taskLifecycle(w.owner, w.ws, task, 'trash', {}, mutation());
    expect((await handoff(task, agt)).reasons).toContain('task_ineligible');
    await env.svc.taskLifecycle(w.owner, w.ws, task, 'restore', {}, mutation());
    expect((await handoff(task, agt)).eligible).toBe(true);
  });

  it('AT-639 R2: a context item the viewer can read but the assigner no longer can is history, not usable scope', async () => {
    const task = w.tasks['Write launch notes']!;
    const member = w.people.member!;
    await grantBrand(env, db, w, member, other, 'view');
    const agt = await external('Context', { brands: [w.brands.Harbor!, other] });
    await env.svc.assignAgent(
      member,
      w.ws,
      task,
      { profile: agt, goal: 'With context.', context: [otherTask] },
      mutation(),
    );
    let seen = await one(w.owner, task, agt);
    expect(seen.effective_scope.items.map((x: { name: string }) => x.name).sort()).toEqual(
      ['Other context', 'Write launch notes'].sort(),
    );
    expect(seen.context).toEqual([{ id: otherTask, name: 'Other context', usable: true }]);
    await revokeBrand(env, db, w, member, other);
    seen = await one(w.owner, task, agt);
    // The task itself is still eligible, so the assignment stays assigned, narrower.
    expect(seen.state).toBe('assigned');
    expect(seen.scope.items.map((x: { name: string }) => x.name).sort()).toEqual(
      ['Other context', 'Write launch notes'].sort(),
    );
    expect(seen.effective_scope.items.map((x: { name: string }) => x.name)).toEqual([
      'Write launch notes',
    ]);
    expect(seen.context).toEqual([{ id: otherTask, name: 'Other context', usable: false }]);
    const h = await handoff(task, agt);
    expect(h.eligible).toBe(true);
    expect(h.ceiling.record).toContain(await internalIdOf(db, task));
    expect(h.ceiling.record).not.toContain(await internalIdOf(db, otherTask));
  });
});
