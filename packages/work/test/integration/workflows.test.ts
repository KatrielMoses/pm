import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
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

const reason = (code: string) => expect.objectContaining({ code });
const issueOf = (code: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });
const v = (n: number) => mutation({ ifMatch: `"${n}"` });

/**
 * Phase 2C workflows on real PostgreSQL (ADR-0015): resolution and precedence, custom statuses
 * with fixed categories, transitions that generic edits cannot bypass, required fields checked
 * atomically, approvals bound to the record version (stale, rejected, applied once, no
 * self-approval), status lifecycle and migration, and tenant isolation.
 */
describe('workflows (2C)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let member: Caller;
  let manager: Caller;
  let viewer: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;

  const task = (body: Record<string, unknown>, as: Caller = owner) =>
    env.svc.createTask(as, ws, body, mutation()).then((r) => r.data);
  const get = (id: string, as: Caller = owner) => env.svc.getTask(as, ws, id);
  const workflow = (body: Record<string, unknown>) =>
    env.svc.createWorkflow(owner, ws, body, mutation()).then((r) => r.data);
  const statuses = (names: Array<[string, string]>) =>
    names.map(([name, category]) => ({ name, category }));
  const keyOf = (wf: { statuses: Array<{ id: string; name: string }> }, name: string) =>
    wf.statuses.find((s) => s.name === name)!.id;
  const patch = (
    id: string,
    version: number,
    changes: Record<string, { base: unknown; value: unknown }>,
    as: Caller = owner,
  ) => env.svc.updateTask(as, ws, id, { version, changes }, mutation());
  const transition = async (
    as: Caller,
    id: string,
    to: string,
    extra: Record<string, unknown> = {},
  ) => {
    const t = await get(id, as);
    const pv = await env.svc.previewTransition(as, ws, id, {
      to,
      ...(extra.override_reason ? { override_reason: extra.override_reason } : {}),
    });
    return env.svc.applyTransition(
      as,
      ws,
      id,
      { to, version: t.version, preview_token: pv.preview_token, ...extra },
      mutation(),
    );
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    manager = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    viewer = await join(env, db, owner, ws, { kind: 'member', role: 'limited_member' });
    for (const [who, level] of [
      [member, 'edit'],
      [manager, 'manage'],
      [viewer, 'view'],
    ] as const) {
      const m = (await membershipOf(db, wsId, who.auth.account.id))!;
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: m.public_id,
        level,
      });
    }
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('defaults stay; resolution is project → brand → workspace → default; workflows never leak across workspaces', async () => {
    const before = await task({ brand: brands.Summit, title: 'Default' });
    expect(before.status).toEqual({ key: 'todo', name: 'To do', category: 'planned' });
    const wsWf = await workflow({
      scope: 'workspace',
      record_kind: 'task',
      name: 'Company',
      statuses: statuses([
        ['Inbox', 'planned'],
        ['Doing', 'active'],
        ['Shipped', 'done'],
        ['Dropped', 'cancelled'],
      ]),
    });
    expect(wsWf).toMatchObject({
      type: 'workflow',
      record_kind: 'task',
      scope: { kind: 'workspace' },
    });
    const fresh = await task({ brand: brands.Summit, title: 'Workspace flow' });
    expect(fresh.status).toMatchObject({
      key: keyOf(wsWf, 'Inbox'),
      category: 'planned',
      custom: true,
    });
    // An existing record keeps its platform status; new choices come from the applicable workflow.
    expect((await get(before.id)).status.key).toBe('todo');
    await expect(
      patch(before.id, before.version, { status: { base: 'todo', value: 'in_progress' } }),
    ).rejects.toEqual(issueOf('invalid_status'));
    const moved = await patch(before.id, before.version, {
      status: { base: 'todo', value: keyOf(wsWf, 'Doing') },
    });
    expect(moved.data.status.category).toBe('active');
    // Brand beats workspace; project beats brand; projectless tasks use the brand.
    const brandWf = await workflow({
      scope: `brand:${brands.Harbor}`,
      record_kind: 'task',
      name: 'Harbor',
      statuses: statuses([
        ['Triage', 'planned'],
        ['Work', 'active'],
        ['Finished', 'done'],
      ]),
    });
    const prj = (
      await env.svc.createProject(owner, ws, { name: 'Launch', brand: brands.Harbor }, mutation())
    ).data;
    const prjWf = await workflow({
      scope: `project:${prj.id}`,
      record_kind: 'task',
      name: 'Launch flow',
      statuses: statuses([
        ['Queued', 'planned'],
        ['Live', 'done'],
      ]),
    });
    expect((await task({ brand: brands.Harbor, title: 'Harbor loose' })).status.key).toBe(
      keyOf(brandWf, 'Triage'),
    );
    expect((await task({ project: prj.id, title: 'In project' })).status.key).toBe(
      keyOf(prjWf, 'Queued'),
    );
    expect((await task({ brand: brands.Summit, title: 'Summit' })).status.key).toBe(
      keyOf(wsWf, 'Inbox'),
    );
    const listed = await env.svc.listWorkflows(owner, ws, { scope: `brand:${brands.Harbor}` });
    expect(listed.applies.task).toMatchObject({ id: brandWf.id, scope_kind: 'brand' });
    // Only one active workflow per scope and kind.
    await expect(
      workflow({
        scope: `brand:${brands.Harbor}`,
        record_kind: 'task',
        name: 'Second',
        statuses: statuses([
          ['A', 'planned'],
          ['B', 'done'],
        ]),
      }),
    ).rejects.toEqual(issueOf('workflow_exists'));
    // Another workspace cannot read or resolve this workflow.
    const other = await workspaceWith(env, db, ['Elsewhere']);
    await expect(env.svc.getWorkflow(other.owner, other.ws, brandWf.id)).rejects.toEqual(
      reason('not_found'),
    );
    const there = (
      await env.svc.createTask(
        other.owner,
        other.ws,
        { brand: other.brands.Elsewhere, title: 'X' },
        mutation(),
      )
    ).data;
    expect(there.status.key).toBe('todo');
    // A member without manage at the brand cannot configure it; a restricted project needs explicit manage.
    await expect(
      env.svc.listWorkflows(member, ws, { scope: `brand:${brands.Harbor}` }),
    ).rejects.toEqual(reason('forbidden'));
    await expect(
      env.svc.listWorkflows(viewer, ws, { scope: `brand:${brands.Summit}` }),
    ).rejects.toEqual(reason('not_found'));
    expect(
      (await env.svc.listWorkflows(manager, ws, { scope: `brand:${brands.Harbor}` })).data.map(
        (w) => w.id,
      ),
    ).toEqual([brandWf.id]);
  });

  it('categories are fixed in the database; a status in use is archived, never deleted; migration keeps the category', async () => {
    const wf = (await env.svc.listWorkflows(owner, ws, { scope: `brand:${brands.Harbor}` }))
      .data[0]!;
    const triage = wf.statuses.find((s) => s.name === 'Triage')!;
    await expect(
      db.admin(
        `UPDATE workflow.workflow_status SET category = 'done' WHERE public_id = '${triage.id}'`,
      ),
    ).rejects.toThrow(/keeps its workflow and category/);
    await expect(
      db.admin(`DELETE FROM workflow.workflow_status WHERE public_id = '${triage.id}'`),
    ).rejects.toThrow(/status in use/);
    await expect(
      env.svc.updateStatus(
        owner,
        ws,
        wf.id,
        triage.id,
        { status: { category: 'done' } },
        v(wf.version),
      ),
    ).rejects.toEqual(issueOf('immutable'));
    // Rename and recolor keep identity.
    const renamed = (
      await env.svc.updateStatus(
        owner,
        ws,
        wf.id,
        triage.id,
        { status: { name: 'Intake', color: '#336699' } },
        v(wf.version),
      )
    ).data;
    const intake = renamed.statuses.find((s) => s.id === triage.id)!;
    expect(intake).toMatchObject({
      name: 'Intake',
      color: '#336699',
      category: 'planned',
      in_use: true,
    });
    await expect(
      env.svc.deleteStatus(owner, ws, wf.id, triage.id, {}, v(renamed.version)),
    ).rejects.toEqual(issueOf('in_use'));
    // A second planned status, then archive the first: records keep it; new tasks start in the other.
    const added = (
      await env.svc.addStatus(
        owner,
        ws,
        wf.id,
        { status: { name: 'Backlog', category: 'planned' } },
        v(renamed.version),
      )
    ).data;
    const archived = (
      await env.svc.setStatusState(owner, ws, wf.id, triage.id, {}, v(added.version), 'archived')
    ).data;
    const kept = (
      await env.svc.listTasks(owner, ws, { brands: brands.Harbor, limit: '200' })
    ).data.find((t) => t.status.key === triage.id);
    expect(kept?.status).toMatchObject({ archived: true });
    expect((await task({ brand: brands.Harbor, title: 'After archive' })).status.name).toBe(
      'Backlog',
    );
    // Migration moves records to a status of the same category, in a bounded batch.
    const backlog = archived.statuses.find((s) => s.name === 'Backlog')!.id;
    await expect(
      env.svc.migrateStatus(
        owner,
        ws,
        wf.id,
        triage.id,
        { to: archived.statuses.find((s) => s.name === 'Work')!.id },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('category_mismatch'));
    const m = (
      await env.svc.migrateStatus(owner, ws, wf.id, triage.id, { to: backlog }, mutation())
    ).data;
    expect(m).toMatchObject({ remaining: 0 });
    expect(m.migrated).toBeGreaterThan(0);
    const after = (await env.svc.getWorkflow(owner, ws, wf.id)).statuses.find(
      (s) => s.id === triage.id,
    )!;
    expect(after.in_use).toBe(false);
    await env.svc.deleteStatus(
      owner,
      ws,
      wf.id,
      triage.id,
      {},
      v((await env.svc.getWorkflow(owner, ws, wf.id)).version),
    );
    expect((await env.svc.getWorkflow(owner, ws, wf.id)).statuses.map((s) => s.name)).not.toContain(
      'Intake',
    );
  });

  it('registered transitions restrict edges; edits, Complete, and Reopen cannot bypass them; required fields are atomic', async () => {
    let wf = (await env.svc.listWorkflows(owner, ws, { scope: `brand:${brands.Harbor}` })).data[0]!;
    const [backlog, work, finished] = ['Backlog', 'Work', 'Finished'].map((n) => keyOf(wf, n)) as [
      string,
      string,
      string,
    ];
    for (const t of [
      { from: backlog, to: work, requirements: [{ builtin: 'due_date' }] },
      { from: work, to: backlog },
      { from: work, to: finished },
      { from: finished, to: work },
    ])
      wf = (await env.svc.addTransition(owner, ws, wf.id, { transition: t }, v(wf.version))).data;
    expect(wf.transitions).toHaveLength(4);
    const t = await task({ brand: brands.Harbor, title: 'Gated' }, member);
    // Backlog → Finished has no edge: Complete is refused, and an edit cannot complete.
    await expect(env.svc.completeTask(member, ws, t.id, {}, mutation())).rejects.toEqual(
      issueOf('transition_not_allowed'),
    );
    await expect(
      patch(t.id, t.version, { status: { base: backlog, value: finished } }, member),
    ).rejects.toEqual(issueOf('use_complete'));
    // A missing required field refuses the change and leaves the record unchanged.
    await expect(
      patch(t.id, t.version, { status: { base: backlog, value: work } }, member),
    ).rejects.toEqual(issueOf('required'));
    expect((await get(t.id)).version).toBe(t.version);
    // The same command with the field set passes (validated on the final merged record).
    const ok = await patch(
      t.id,
      t.version,
      { status: { base: backlog, value: work }, due_date: { base: null, value: '2026-12-01' } },
      member,
    );
    expect(ok.data.status.key).toBe(work);
    const done = await env.svc.completeTask(member, ws, t.id, {}, mutation());
    expect(done.data.status).toMatchObject({ key: finished, category: 'done' });
    // Reopen uses the registered edge back to Work (the prior status).
    expect((await env.svc.reopenTask(member, ws, t.id, mutation())).data.status.key).toBe(work);
    // Preview equals enforcement: the options list shows the same requirement as the refusal.
    const opts = await env.svc.recordTransitions(
      member,
      ws,
      (await task({ brand: brands.Harbor, title: 'Opts' }, member)).id,
    );
    expect(opts.options.find((o) => o.status.key === work)).toMatchObject({
      allowed: false,
      required_fields: [expect.objectContaining({ label: 'Due date', satisfied: false })],
    });
    expect(opts.options.find((o) => o.status.key === finished)).toMatchObject({ allowed: false });
  });

  it('approvals: bound to the record version, stale on change, no self-approval, rejected or applied once', async () => {
    let wf = (await env.svc.listWorkflows(owner, ws, { scope: `brand:${brands.Harbor}` })).data[0]!;
    const [work, finished] = ['Work', 'Finished'].map((n) => keyOf(wf, n)) as [string, string];
    const edge = wf.transitions.find((x) => x.from === work && x.to === finished)!;
    wf = (
      await env.svc.updateTransition(
        owner,
        ws,
        wf.id,
        edge.id,
        { transition: { approval_policy: 'one_manager' } },
        v(wf.version),
      )
    ).data;
    const t0 = await task(
      { brand: brands.Harbor, title: 'Needs approval', due_date: '2026-12-01' },
      member,
    );
    const t = (
      await patch(t0.id, t0.version, { status: { base: t0.status.key, value: work } }, member)
    ).data;
    // Outside the apply command a gated change needs review; apply without approval is refused.
    await expect(env.svc.completeTask(member, ws, t.id, {}, mutation())).rejects.toEqual(
      issueOf('transition_requires_review'),
    );
    await expect(transition(member, t.id, finished)).rejects.toEqual(reason('approval_required'));
    const req1 = (
      await env.svc.requestApproval(
        member,
        ws,
        t.id,
        { to: finished, version: t.version },
        mutation(),
      )
    ).data;
    expect(req1).toMatchObject({
      type: 'workflow_approval',
      state: 'pending',
      policy: 'one_manager',
      can_apply: false,
    });
    await expect(
      env.svc.requestApproval(member, ws, t.id, { to: finished, version: t.version }, mutation()),
    ).rejects.toEqual(issueOf('approval_open'));
    // No self-approval (the transition does not allow it); a viewer is not eligible and sees nothing.
    await expect(
      env.svc.decideApproval(member, ws, req1.id, { decision: 'approve' }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    await expect(
      env.svc.decideApproval(viewer, ws, req1.id, { decision: 'approve' }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    expect((await env.svc.listApprovals(viewer, ws, {})).data).toEqual([]);
    expect((await env.svc.listApprovals(manager, ws, {})).data.map((a) => a.id)).toContain(req1.id);
    // Any change to the record makes the request stale; it cannot be approved or applied.
    const edited = (
      await patch(
        t.id,
        t.version,
        { title: { base: 'Needs approval', value: 'Needs approval v2' } },
        member,
      )
    ).data;
    expect((await env.svc.getApproval(manager, ws, req1.id)).state).toBe('stale');
    await expect(
      env.svc.decideApproval(manager, ws, req1.id, { decision: 'approve' }, mutation()),
    ).rejects.toEqual(issueOf('stale'));
    // A fresh request, approved by a manager, applied once by the requester.
    const req2 = (
      await env.svc.requestApproval(
        member,
        ws,
        t.id,
        { to: finished, version: edited.version },
        mutation(),
      )
    ).data;
    expect(
      (
        await env.svc.decideApproval(
          manager,
          ws,
          req2.id,
          { decision: 'approve', note: 'Looks right' },
          mutation(),
        )
      ).data.state,
    ).toBe('approved');
    await expect(transition(manager, t.id, finished, { approval: req2.id })).rejects.toEqual(
      reason('forbidden'),
    );
    const applied = await transition(member, t.id, finished, { approval: req2.id });
    expect(applied.data.status).toMatchObject({ key: finished, category: 'done' });
    expect((await env.svc.getApproval(member, ws, req2.id)).state).toBe('applied');
    await env.svc.reopenTask(member, ws, t.id, mutation());
    await expect(transition(member, t.id, finished, { approval: req2.id })).rejects.toEqual(
      issueOf('stale'),
    );
    // Rejection blocks the apply.
    const cur = await get(t.id, member);
    const req3 = (
      await env.svc.requestApproval(
        member,
        ws,
        t.id,
        { to: finished, version: cur.version },
        mutation(),
      )
    ).data;
    expect(
      (await env.svc.decideApproval(manager, ws, req3.id, { decision: 'reject' }, mutation())).data
        .state,
    ).toBe('rejected');
    await expect(transition(member, t.id, finished, { approval: req3.id })).rejects.toEqual(
      issueOf('stale'),
    );
    // The facts are append-only in the database.
    await expect(
      db.admin(
        `UPDATE workflow.approval_request SET record_version = 99 WHERE public_id = '${req3.id}'`,
      ),
    ).rejects.toThrow(/immutable/);
    // Self-approval: only with the transition flag and the workspace policy (OD-20).
    wf = (
      await env.svc.updateTransition(
        owner,
        ws,
        wf.id,
        edge.id,
        { transition: { allow_self_approval: true } },
        v((await env.svc.getWorkflow(owner, ws, wf.id)).version),
      )
    ).data;
    const fresh = await get(t.id, owner);
    const own = (
      await env.svc.requestApproval(
        owner,
        ws,
        t.id,
        { to: finished, version: fresh.version },
        mutation(),
      )
    ).data;
    await expect(
      env.svc.decideApproval(owner, ws, own.id, { decision: 'approve' }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    await db.admin(
      `INSERT INTO access.workspace_policy (workspace_id, self_approval_mode) VALUES ('${wsId}', 'allowed')
       ON CONFLICT (workspace_id) DO UPDATE SET self_approval_mode = 'allowed'`,
    );
    expect(
      (await env.svc.decideApproval(owner, ws, own.id, { decision: 'approve' }, mutation())).data,
    ).toMatchObject({ state: 'approved', self_requested: true });
  });

  it('a workflow-required custom field gates completion; only an allowed manager override with a reason passes (TSK-031)', async () => {
    const scope = `brand:${brands.Summit}`;
    const fld = (
      await env.svc.createFieldDefinition(
        owner,
        ws,
        { scope, name: 'Release notes', field_type: 'text', applies_to: ['task'] },
        mutation(),
      )
    ).data;
    let wf = await workflow({
      scope,
      record_kind: 'task',
      name: 'Summit',
      statuses: statuses([
        ['Open', 'planned'],
        ['Closed', 'done'],
      ]),
    });
    const [open, closed] = ['Open', 'Closed'].map((n) => keyOf(wf, n)) as [string, string];
    wf = (
      await env.svc.addTransition(
        owner,
        ws,
        wf.id,
        {
          transition: {
            from: open,
            to: closed,
            requirements: [{ field: fld.id, allow_manager_override: true }],
          },
        },
        v(wf.version),
      )
    ).data;
    const t = await task({ brand: brands.Summit, title: 'Ship it' });
    await expect(env.svc.completeTask(owner, ws, t.id, {}, mutation())).rejects.toEqual(
      issueOf('required'),
    );
    // The criteria override reason does not satisfy workflow-required fields; the apply override does.
    await expect(
      env.svc.completeTask(owner, ws, t.id, { override_reason: 'skip' }, mutation()),
    ).rejects.toEqual(issueOf('required'));
    const r = await transition(owner, t.id, closed, { override_reason: 'Notes come later' });
    expect(r.data.status.key).toBe(closed);
    // With the value present, completion passes without an override.
    const t2 = await task({ brand: brands.Summit, title: 'Ship again' });
    await env.svc.updateRecordFields(
      owner,
      ws,
      t2.id,
      { version: t2.version, changes: { [fld.id]: { value: 'Fixed the thing' } } },
      mutation(),
    );
    expect((await env.svc.completeTask(owner, ws, t2.id, {}, mutation())).data.status.key).toBe(
      closed,
    );
  });
});
