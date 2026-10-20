import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import type { WorkerRuntime } from '@pm/platform';
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

const v = (n: number) => mutation({ ifMatch: `"${n}"` });

/**
 * Phase 8A actions (AUTO-005): every supported task and project verb runs through its canonical
 * command as the automation for its owner (actor `automation`, on behalf of the owner, causation
 * the run), and every domain rule still applies: custom workflows and required fields, versions,
 * cross-brand rules, lifecycle, and rollback-safe failed steps.
 */
describe('automations (8A): canonical actions and domain rules', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let worker: WorkerRuntime;
  let assignee: Caller;
  let assigneeMem: string;

  const automate = async (name: string, definition: Record<string, unknown>, scope: Record<string, unknown> = { kind: 'brand', brand: brands.Harbor }) => {
    const a = (await env.svc.createAutomation(owner, ws, { name, scope, definition }, mutation())).data;
    return (await env.svc.activateAutomation(owner, ws, a.id, {}, v(a.version))).data;
  };
  const disableAll = async () => {
    for (const a of (await env.svc.listAutomations(owner, ws)).data)
      if (a.enabled) await env.svc.disableAutomation(owner, ws, a.id, mutation());
  };
  const idOf = async (publicId: string) =>
    (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [publicId])).rows[0].id as string;
  const task = async (id: string) =>
    (await db.admin(`SELECT t.*, t.start_date::text AS start_text, t.due_date::text AS due_text, r.lifecycle_state, (SELECT s.public_id FROM workflow.workflow_status s WHERE s.id = t.status_id) AS status_key FROM work.task t JOIN core.record r ON r.id = t.id WHERE r.public_id = $1`, [id])).rows[0];

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    assignee = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    assigneeMem = (await membershipOf(db, wsId, assignee.auth.account.id))!.public_id;
    await apply(env, owner, ws, { kind: 'brand_grant', brand: brands.Harbor, principal: assigneeMem, level: 'edit' });
    worker = await automationWorker(env);
  });
  afterAll(async () => {
    await worker.stop();
    await env.h.close();
    await db.drop();
  });

  it('AT-561 every supported task action runs its canonical command, attributed to the automation', async () => {
    const label = (await env.svc.createLabel(owner, ws, brands.Harbor, { name: 'Auto' }, mutation())).data;
    const home = (await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Home' }, mutation())).data;
    const away = (await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Away' }, mutation())).data;
    const peer = (await env.svc.createTask(owner, ws, { project: home.id, title: 'Peer' }, mutation())).data;
    const a = await automate('Everything', {
      schema_version: 1,
      trigger: { kind: 'record.created', record: 'task' },
      conditions: { all: [{ field: 'title', op: 'contains', value: 'matrix' }] },
      steps: [
        { id: 'update', type: 'action', action: 'task.update', params: { fields: { priority: 'high', title: 'Matrix (updated)' } } },
        { id: 'assign', type: 'action', action: 'task.assign', params: { mode: 'add', assignees: [assigneeMem] } },
        { id: 'label', type: 'action', action: 'task.label', params: { mode: 'add', label: label.id } },
        { id: 'schedule', type: 'action', action: 'task.schedule', params: { start: { days: 0 }, due: { days: 3 } } },
        { id: 'relate', type: 'action', action: 'task.relate', params: { kind: 'related', to: peer.id } },
        { id: 'create', type: 'action', action: 'task.create', params: { title: 'Child of matrix', parent: 'trigger' } },
        { id: 'notify', type: 'action', action: 'task.notify', params: { recipients: ['assignees'], message: 'Automation touched this.' } },
        { id: 'move', type: 'action', action: 'task.move', params: { project: away.id } },
        { id: 'archive', type: 'action', action: 'task.archive', params: {} },
      ],
    });
    const t = (await env.svc.createTask(owner, ws, { project: home.id, title: 'matrix task' }, mutation())).data;
    await settle(db, worker);
    const [run] = await runsOf(db, a.id);
    const steps = await stepsOf(db, run!.id as string);
    expect(steps.map((s) => [s.node_id, s.state, s.code])).toEqual([
      ['_conditions', 'succeeded', null],
      ...['update', 'assign', 'label', 'schedule', 'relate', 'create', 'notify', 'move', 'archive'].map((n) => [n, 'succeeded', null]),
    ]);
    expect(run!.status).toBe('succeeded');
    const row = await task(t.id);
    const day = (await db.admin(`SELECT run_day::text AS d FROM automation.automation_run WHERE id = $1`, [run!.id])).rows[0].d as string;
    expect({
      title: row.title,
      priority: row.priority,
      start: row.start_text === day,
      project: row.project_id === (await idOf(away.id)),
      archived: row.lifecycle_state,
    }).toEqual({ title: 'Matrix (updated)', priority: 'high', start: true, project: true, archived: 'archived' });
    const tid = await idOf(t.id);
    expect((await db.admin(`SELECT count(*)::int AS n FROM work.task_assignee WHERE task_id = $1`, [tid])).rows[0].n).toBe(1);
    expect((await db.admin(`SELECT count(*)::int AS n FROM work.task_label WHERE task_id = $1`, [tid])).rows[0].n).toBe(1);
    expect((await db.admin(`SELECT count(*)::int AS n FROM relations.record_relationship WHERE from_record_id = $1 OR to_record_id = $1`, [tid])).rows[0].n).toBe(1);
    const child = (await db.admin(`SELECT r.source_kind, r.created_by_actor_type FROM work.task c JOIN core.record r ON r.id = c.id WHERE c.parent_task_id = $1`, [tid])).rows;
    expect(child).toEqual([{ source_kind: 'automation', created_by_actor_type: 'automation' }]);
    // The notice reached the assignee (who can read the task); the canonical assignment also
    // notified them, attributed to no member (the automation acted).
    const notes = await db.admin(
      `SELECT n.type, n.actor_membership_id FROM notify.notification n WHERE n.record_id = $1 ORDER BY n.type`,
      [tid],
    );
    expect(notes.rows).toEqual([
      { type: 'assignment', actor_membership_id: null },
      { type: 'automation_notice', actor_membership_id: null },
    ]);
    // Attribution: audit actor and outbox actor are the automation, on behalf of its owner, and
    // every event caused by the run carries its operation as causation.
    const ownerMem = (await membershipOf(db, wsId, owner.auth.account.id))!;
    const autoId = await idOf(a.id);
    const audit = await db.admin(
      `SELECT DISTINCT actor_type, actor_id, on_behalf_of_membership_id FROM audit.audit_event WHERE operation_id = $1`,
      [run!.current_operation_id],
    );
    expect(audit.rows).toEqual([{ actor_type: 'automation', actor_id: autoId, on_behalf_of_membership_id: ownerMem.id }]);
    const events = await db.admin(
      `SELECT DISTINCT actor_type, causation_id FROM exec.outbox_event WHERE operation_id = $1 AND event_type LIKE 'work.%'`,
      [run!.current_operation_id],
    );
    expect(events.rows).toEqual([{ actor_type: 'automation', causation_id: run!.current_operation_id }]);
  });

  it('AT-562 project actions: update, schedule, notify, archive; access-changing project verbs are refused', async () => {
    await disableAll();
    const a = await automate('Projects', {
      schema_version: 1,
      trigger: { kind: 'record.created', record: 'project' },
      conditions: null,
      steps: [
        { id: 'up', type: 'action', action: 'project.update', params: { fields: { priority: 'urgent' } } },
        { id: 'sched', type: 'action', action: 'project.schedule', params: { target: { days: 30 } } },
        { id: 'tell', type: 'action', action: 'project.notify', params: { recipients: ['owner'], message: 'New project.' } },
        { id: 'arch', type: 'action', action: 'project.archive', params: {} },
      ],
    });
    const p = (await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Spawned' }, mutation())).data;
    await settle(db, worker);
    const [run] = await runsOf(db, a.id);
    expect(run!.status).toBe('succeeded');
    const row = (await db.admin(`SELECT w.priority, w.target_date, r.lifecycle_state FROM work.project w JOIN core.record r ON r.id = w.id WHERE r.public_id = $1`, [p.id])).rows[0];
    expect({ priority: row.priority, target: !!row.target_date, state: row.lifecycle_state }).toEqual({ priority: 'urgent', target: true, state: 'archived' });
    for (const action of ['project.create', 'project.assign', 'project.move', 'project.label', 'project.relate']) {
      const d = (await env.svc.createAutomation(owner, ws, { name: action, scope: { kind: 'brand', brand: brands.Harbor }, definition: { schema_version: 1, trigger: { kind: 'record.created', record: 'project' }, conditions: null, steps: [{ id: 'x', type: 'action', action, params: {} }] } }, mutation())).data;
      expect(d.draft_status).toMatchObject({ valid: false, issues: [expect.objectContaining({ code: 'action_unsupported' })] });
      await expect(env.svc.activateAutomation(owner, ws, d.id, {}, v(d.version))).rejects.toEqual(expect.objectContaining({ code: 'validation_failed' }));
    }
  });

  it('AT-563 custom workflows, required fields, cross-brand rules, lifecycle, and concurrent edits are preserved; failed steps roll back alone', async () => {
    await disableAll();
    const prj = (await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Gated' }, mutation())).data;
    let wf = (await env.svc.createWorkflow(owner, ws, { scope: `project:${prj.id}`, record_kind: 'task', name: 'Gated flow', statuses: [{ name: 'Queued', category: 'planned' }, { name: 'Doing', category: 'active' }, { name: 'Shipped', category: 'done' }] }, mutation())).data;
    const key = (n: string) => wf.statuses.find((s: { name: string }) => s.name === n)!.id as string;
    wf = (await env.svc.addTransition(owner, ws, wf.id, { transition: { from: key('Queued'), to: key('Doing'), requirements: [{ builtin: 'due_date' }] } }, v(wf.version))).data;
    const other = (await env.svc.createProject(owner, ws, { brand: brands.Summit, name: 'Other brand' }, mutation())).data;
    const a = await automate(
      'Rules',
      {
        schema_version: 1,
        trigger: { kind: 'record.field_changed', record: 'task', fields: ['title'] },
        conditions: null,
        steps: [
          { id: 'first', type: 'action', action: 'task.update', params: { fields: { priority: 'low' } } },
          // The workflow requires a due date for Queued -> Doing: the canonical gate refuses.
          { id: 'gate', type: 'action', action: 'task.update', params: { fields: { status: key('Doing') } }, fallback: { on: ['validation_failed'], next: 'cross' } },
          { id: 'never', type: 'action', action: 'task.update', params: { fields: { priority: 'urgent' } }, next: null },
          // Moving into another brand's project is a cross-brand move: refused (a person's preview).
          { id: 'cross', type: 'action', action: 'task.move', params: { project: other.id }, next: null },
        ],
      },
      { kind: 'workspace', brands: [brands.Harbor, brands.Summit] },
    );
    const t = (await env.svc.createTask(owner, ws, { project: prj.id, title: 'Gated task' }, mutation())).data;
    const cur = (await env.svc.getTask(owner, ws, t.id)) as { version: number; title: string };
    await env.svc.updateTask(owner, ws, t.id, { version: cur.version, changes: { title: { base: cur.title, value: 'Gated task!' } } }, v(cur.version));
    // A person edits the same task before the run executes: the automation merges per field on
    // the locked current version; nothing the person wrote is lost.
    const mid = (await env.svc.getTask(owner, ws, t.id)) as { version: number; start_date: string | null };
    await env.svc.updateTask(owner, ws, t.id, { version: mid.version, changes: { start_date: { base: mid.start_date, value: '2026-11-02' } } }, v(mid.version));
    await settle(db, worker);
    const [run] = await runsOf(db, a.id);
    const steps = await stepsOf(db, run!.id as string);
    expect(steps.map((s) => [s.node_id, s.state, s.failure_class, s.code])).toEqual([
      ['_conditions', 'succeeded', null, null],
      ['first', 'succeeded', null, null],
      ['gate', 'failed', 'validation_failed', 'required'],
      ['cross', 'failed', 'validation_failed', 'cross_brand_move'],
    ]);
    expect({ status: run!.status, op: run!.execution_state }).toEqual({ status: 'failed', op: 'failed' });
    // The committed first step stays; the refused steps changed nothing.
    const row = await task(t.id);
    expect({ priority: row.priority, status: row.status_key === key('Queued'), start: row.start_text, project: row.project_id === (await idOf(prj.id)) }).toEqual({
      priority: 'low',
      status: true,
      start: '2026-11-02',
      project: true,
    });
    // An archived target is no longer available to the automation: the retried step is refused
    // opaquely (no silent write, no hint of why).
    await env.svc.taskLifecycle(owner, ws, t.id, 'archive', {}, mutation());
    const retry = await env.svc.retryAutomationRun(owner, ws, run!.op_public_id, mutation());
    expect(retry.data.status).toBe('queued');
    await settle(db, worker);
    const after = (await runsOf(db, a.id)).find((r) => r.id === run!.id)!;
    const last = (await stepsOf(db, run!.id as string)).at(-1)!;
    expect({ status: after.status, node: last.node_id, cls: last.failure_class, code: last.code }).toEqual({
      status: 'policy_rejected',
      node: 'cross',
      cls: 'policy_rejected',
      code: 'not_permitted',
    });
    // Retry resumed at the failed step: the successful first step ran exactly once.
    expect((await stepsOf(db, run!.id as string)).filter((s) => s.node_id === 'first')).toHaveLength(1);
  });
});
