import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUuidV7 } from '@pm/contracts';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import type { WorkerRuntime } from '@pm/platform';
import { mutation, workEnv, workspaceWith, type WorkEnv } from './fixture.ts';
import { automationWorker, runsOf, settle, stepsOf, wakeDelays } from './automation-support.ts';
import { outboxEvents, workspaceIdOf } from './fixture.ts';

const v = (n: number) => mutation({ ifMatch: `"${n}"` });

describe('automations (8A): engine end to end', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let brands: Record<string, string>;
  let worker: WorkerRuntime;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    worker = await automationWorker(env);
  });
  /** Creates and activates a brand automation (the owner configures and owns it). */
  const automate = async (
    name: string,
    definition: Record<string, unknown>,
    brand = brands.Harbor!,
    as: Caller = owner,
  ) => {
    const a = (
      await env.svc.createAutomation(
        as,
        ws,
        { name, scope: { kind: 'brand', brand }, definition },
        mutation(),
      )
    ).data;
    return (await env.svc.activateAutomation(as, ws, a.id, {}, v(a.version))).data;
  };
  const newTask = async (title: string, extra: Record<string, unknown> = {}) =>
    (await env.svc.createTask(owner, ws, { brand: brands.Harbor, title, ...extra }, mutation()))
      .data;
  const setPriority = async (id: string, value: string) => {
    const t = (await env.svc.getTask(owner, ws, id)) as { version: number; priority: string };
    return env.svc.updateTask(
      owner,
      ws,
      id,
      { version: t.version, changes: { priority: { base: t.priority, value } } },
      v(t.version),
    );
  };
  const disableAll = async () => {
    const list = await env.svc.listAutomations(owner, ws);
    for (const a of list.data)
      if (a.enabled) await env.svc.disableAutomation(owner, ws, a.id, mutation());
    await settle(db, worker);
  };

  afterAll(async () => {
    await worker.stop();
    await env.h.close();
    await db.drop();
  });

  it('AT-552 a field-change trigger runs its pinned revision through the canonical command', async () => {
    const prj = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Site' }, mutation())
    ).data;
    const t = (
      await env.svc.createTask(owner, ws, { project: prj.id, title: 'Fix the gate' }, mutation())
    ).data;
    const a = (
      await env.svc.createAutomation(
        owner,
        ws,
        {
          name: 'Start urgent work',
          scope: { kind: 'brand', brand: brands.Harbor },
          definition: {
            schema_version: 1,
            trigger: { kind: 'record.field_changed', record: 'task', fields: ['priority'] },
            conditions: { all: [{ field: 'priority', op: 'eq', value: 'urgent' }] },
            steps: [
              {
                id: 'start',
                type: 'action',
                action: 'task.update',
                params: { fields: { status: 'in_progress' } },
              },
            ],
          },
        },
        mutation(),
      )
    ).data;
    const active = (await env.svc.activateAutomation(owner, ws, a.id, {}, v(a.version))).data;
    expect(active).toMatchObject({ state: 'active', active_revision: 1 });
    await env.svc.updateTask(
      owner,
      ws,
      t.id,
      { version: t.version, changes: { priority: { base: 'none', value: 'urgent' } } },
      v(t.version),
    );
    await settle(db, worker);
    const runs = await runsOf(db, a.id);
    expect(runs).toHaveLength(1);
    const steps = await stepsOf(db, runs[0]!.id as string);
    expect({
      status: runs[0]!.status,
      op: runs[0]!.execution_state,
      steps: steps.map((s) => [s.node_id, s.state, s.code]),
    }).toEqual({
      status: 'succeeded',
      op: 'succeeded',
      steps: [
        ['_conditions', 'succeeded', null],
        ['start', 'succeeded', null],
      ],
    });
    const after = (await env.svc.getTask(owner, ws, t.id)) as { status: { key: string } };
    expect(after.status.key).toBe('in_progress');
  });

  it('AT-553 a run pins the revision of its first consumption; redelivery and competing workers converge', async () => {
    await disableAll();
    const t = await newTask('Pinned');
    const a = await automate('Pin', {
      schema_version: 1,
      trigger: { kind: 'record.field_changed', record: 'task', fields: ['priority'] },
      conditions: null,
      steps: [
        {
          id: 'one',
          type: 'action',
          action: 'task.update',
          params: { fields: { title: 'Revision one' } },
        },
      ],
    });
    await setPriority(t.id, 'low');
    // Two workers race for the same events: one run, one step.
    const second = await automationWorker(env);
    await Promise.all([settle(db, worker), settle(db, second)]);
    await second.stop();
    // The draft changes and a new revision is activated: the past run keeps revision 1.
    const fresh = await env.svc.getAutomation(owner, ws, a.id);
    await env.svc.updateAutomation(
      owner,
      ws,
      a.id,
      {
        definition: {
          ...(fresh.draft.definition as object),
          steps: [
            {
              id: 'one',
              type: 'action',
              action: 'task.update',
              params: { fields: { title: 'Revision two' } },
            },
          ],
        },
      },
      v(fresh.version),
    );
    const re = await env.svc.getAutomation(owner, ws, a.id);
    expect(re).toMatchObject({ active_revision: 1, draft_status: { matches_active: false } });
    await env.svc.disableAutomation(owner, ws, a.id, mutation());
    const act = await env.svc.getAutomation(owner, ws, a.id);
    expect(
      (await env.svc.activateAutomation(owner, ws, a.id, {}, v(act.version))).data.active_revision,
    ).toBe(2);
    // Duplicate delivery of the original event after the activation change: still one run, on 1.
    const wsId = await workspaceIdOf(db, ws);
    const [event] = (await outboxEvents(db, wsId, 'work.task.updated'))
      .filter((e) => (e.data as { changed_fields: string }).changed_fields === 'priority')
      .slice(-1);
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
      env.workerSvc().consumeTriggerEvent(tx, event!),
    );
    const runs = await runsOf(db, a.id);
    expect(runs).toHaveLength(1);
    const rev = await db.admin(
      `SELECT revision_number FROM automation.automation_revision WHERE id = $1`,
      [runs[0]!.revision_id],
    );
    expect(rev.rows[0].revision_number).toBe(1);
    expect(((await env.svc.getTask(owner, ws, t.id)) as { title: string }).title).toBe(
      'Revision one',
    );
    expect(Number(runs[0]!.steps_executed)).toBe(1);
  });

  it('AT-554 branches, explicit fallbacks, and a delay that survives a worker restart', async () => {
    await disableAll();
    const label = (
      await env.svc.createLabel(owner, ws, brands.Harbor, { name: 'Escalated' }, mutation())
    ).data;
    const other = await newTask('Link target');
    const a = await automate('Flow', {
      schema_version: 1,
      trigger: { kind: 'record.created', record: 'task' },
      conditions: {
        any: [
          { field: 'priority', op: 'eq', value: 'high' },
          { field: 'title', op: 'contains', value: 'flow' },
        ],
      },
      steps: [
        {
          id: 'pick',
          type: 'branch',
          when: { field: 'priority', op: 'eq', value: 'high' },
          then: 'tag',
          else: 'wait',
        },
        {
          id: 'tag',
          type: 'action',
          action: 'task.label',
          params: { mode: 'add', label: label.id },
        },
        { id: 'wait', type: 'delay', minutes: 10 },
        // The link target is trashed while the run waits: the step is refused and the fallback runs.
        {
          id: 'link',
          type: 'action',
          action: 'task.relate',
          params: { kind: 'related', to: other.id },
          fallback: { on: ['policy_rejected', 'validation_failed'], next: 'tell' },
        },
        {
          id: 'done',
          type: 'action',
          action: 'task.update',
          params: { fields: { title: 'never' } },
          next: null,
        },
        {
          id: 'tell',
          type: 'action',
          action: 'task.notify',
          params: { recipients: ['owner'], message: 'Could not link.' },
          next: null,
        },
      ],
    });
    const t = await newTask('Flow check', { priority: 'high' });
    await settle(db, worker);
    const tId = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [t.id])).rows[0]
      .id;
    const forTask = async () => (await runsOf(db, a.id)).filter((r) => r.trigger_record_id === tId);
    // The link target was created before activation: its event never starts a run.
    expect((await runsOf(db, a.id)).filter((r) => r.trigger_record_id !== tId)).toEqual([]);
    // A task created now that misses the conditions is skipped (recorded, nothing ran).
    await newTask('Unrelated');
    await settle(db, worker);
    const others = (await runsOf(db, a.id)).filter((r) => r.trigger_record_id !== tId);
    expect(others.map((r) => [r.status, r.reason, r.execution_state, r.terminal_reason])).toEqual([
      ['skipped', 'conditions_not_met', 'skipped', 'policy_rejected'],
    ]);
    let [run] = await forTask();
    expect({
      status: run!.status,
      reason: run!.reason,
      op: run!.execution_state,
      waiting: run!.waiting_reason,
    }).toEqual({ status: 'waiting', reason: 'delay', op: 'waiting', waiting: 'delay' });
    await env.svc.taskLifecycle(owner, ws, other.id, 'trash', {}, mutation());
    // The worker that started the run stops; a new worker continues after the wake.
    worker.kill();
    worker = await automationWorker(env);
    await wakeDelays(db);
    await settle(db, worker);
    [run] = await forTask();
    const steps = await stepsOf(db, run!.id as string);
    expect(steps.map((x) => [x.node_id, x.state, x.failure_class])).toEqual([
      ['_conditions', 'succeeded', null],
      ['pick', 'succeeded', null],
      ['tag', 'succeeded', null],
      ['wait', 'succeeded', null],
      ['link', 'refused', 'policy_rejected'],
      ['tell', 'succeeded', null],
    ]);
    // A fallback after a failed step is partial, never an unqualified success.
    expect({ status: run!.status, op: run!.execution_state }).toEqual({
      status: 'partial',
      op: 'partial',
    });
    const labels = await db.admin(
      `SELECT l.public_id FROM work.task_label tl JOIN work.label l ON l.id = tl.label_id WHERE tl.task_id = $1`,
      [tId],
    );
    expect(labels.rows.map((r) => r.public_id)).toEqual([label.id]);
  });

  it('AT-555 self and multi-rule cycles stop at the loop guard; chain depth is bounded; replays spend nothing', async () => {
    await disableAll();
    const self = await automate('Self', {
      schema_version: 1,
      trigger: { kind: 'record.field_changed', record: 'task', fields: ['priority'] },
      conditions: null,
      steps: [
        {
          id: 'bump',
          type: 'action',
          action: 'task.update',
          params: { fields: { priority: 'urgent' } },
        },
      ],
    });
    const t = await newTask('Loop');
    await setPriority(t.id, 'low');
    await settle(db, worker);
    if (process.env.DEBUG_8A)
      console.log(
        env.h.sink.lines
          .filter((l) => l.includes('consumer_failed') || l.includes('attempt_failed'))
          .slice(-3)
          .join('\n'),
      );
    expect((await runsOf(db, self.id)).map((r) => [r.status, r.reason])).toEqual([
      ['succeeded', null],
      ['skipped', 'loop_guard'],
    ]);
    await env.svc.disableAutomation(owner, ws, self.id, mutation());
    // Two rules feeding each other: priority -> title -> priority -> stop.
    const r1 = await automate('R1', {
      schema_version: 1,
      trigger: { kind: 'record.field_changed', record: 'task', fields: ['priority'] },
      conditions: null,
      steps: [
        {
          id: 'title',
          type: 'action',
          action: 'task.update',
          params: { fields: { title: 'From R1' } },
        },
      ],
    });
    const r2 = await automate('R2', {
      schema_version: 1,
      trigger: { kind: 'record.field_changed', record: 'task', fields: ['title'] },
      conditions: null,
      steps: [
        {
          id: 'prio',
          type: 'action',
          action: 'task.update',
          params: { fields: { priority: 'medium' } },
        },
      ],
    });
    const u = await newTask('Pair');
    await setPriority(u.id, 'high');
    await settle(db, worker);
    expect(
      (await runsOf(db, r1.id)).map((r) => [r.status, r.reason, Number(r.chain_depth)]),
    ).toEqual([
      ['succeeded', null, 0],
      ['skipped', 'loop_guard', 2],
    ]);
    expect((await runsOf(db, r2.id)).map((r) => [r.status, Number(r.chain_depth)])).toEqual([
      ['succeeded', 1],
    ]);
    // A redelivered job of a finished run changes nothing and spends no step.
    const usage = async () =>
      (
        await db.admin(
          `SELECT steps_executed, runs_reserved, runs_settled, runs_released FROM automation.usage_period`,
        )
      ).rows[0];
    const before = await usage();
    const finished = (await runsOf(db, r2.id))[0]!;
    await db.admin(
      `INSERT INTO exec.job (id, workspace_id, queue, kind, operation_id, payload_ref, max_attempts, timeout_seconds, authenticated_principal_type, authenticated_principal_id, effective_principal_type, effective_principal_id, initiating_membership_id, delegation_chain, selected_scope, workspace_epoch_at_enqueue, principal_epoch_at_enqueue, data_class_limit, correlation_id)
       SELECT $2::uuid, workspace_id, queue, kind, operation_id, payload_ref, max_attempts, timeout_seconds, authenticated_principal_type, authenticated_principal_id, effective_principal_type, effective_principal_id, initiating_membership_id, delegation_chain, selected_scope, workspace_epoch_at_enqueue, principal_epoch_at_enqueue, data_class_limit, correlation_id
         FROM exec.job WHERE operation_id = $1 LIMIT 1`,
      [finished.current_operation_id, newUuidV7()],
    );
    await settle(db, worker);
    expect(await usage()).toEqual(before);
  });
});
