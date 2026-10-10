import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureClasses, statementShape } from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import {
  apply,
  join,
  membershipOf,
  merge,
  mutation,
  seedAccount,
  workEnv,
  workspaceIdOf,
  WORKSPACE_INPUT,
  type WorkEnv,
} from './fixture.ts';

const reason = (code: string) => expect.objectContaining({ code });
const issueOf = (code: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });
const ROLES = ['administrator', 'member', 'limited_member', 'read_only'] as const;
type Who = 'owner' | (typeof ROLES)[number] | 'guest';
const soon = (h = 1) => new Date(Date.now() + h * 3_600_000).toISOString();

/**
 * Phase 2D authority and privacy (0C AZ-24, T-42, AT-130–AT-137) across three workspaces, all
 * roles, a guest with a share, a sensitive brand, a restricted project, hidden fields, and a custom
 * workflow. Personal state stays personal; signals, duplicates, bulk previews, and template
 * applications reveal nothing a person cannot read, by content, count, error, statements, or time.
 */
describe('task interaction authority and privacy (2D)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  const W: Array<{
    ws: string;
    id: string;
    people: Record<Who, Caller>;
    brands: Record<string, string>;
    shared: string;
  }> = [];
  const mem = async (i: number, who: Caller) =>
    (await membershipOf(db, W[i]!.id, who.auth.account.id))!.public_id;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    for (const k of ['a', 'b', 'c']) {
      const o = await seedAccount(db);
      const created = await env.svc.createWorkspace(
        o,
        { ...WORKSPACE_INPUT, name: `I ${k}`, first_brand: { name: `Main ${k}` } },
        mutation(),
      );
      const ws = created.data.workspace.id;
      const brands: Record<string, string> = { main: created.data.first_brand!.id };
      brands.secret = (
        await env.svc.createBrand(o, ws, { name: `Secret ${k}` }, mutation())
      ).data.id;
      env.stepUp.allow = true;
      await env.svc.setSensitivity(
        o,
        ws,
        brands.secret,
        { is_sensitive: true },
        mutation({ ifMatch: '"0"', stepUpToken: 't' }),
      );
      env.stepUp.allow = false;
      const people = { owner: o } as Record<Who, Caller>;
      for (const role of ROLES) people[role] = await join(env, db, o, ws, { kind: 'member', role });
      const id = await workspaceIdOf(db, ws);
      for (const role of ['member', 'limited_member', 'read_only'] as const)
        await apply(env, o, ws, {
          kind: 'brand_grant',
          brand: brands.main,
          principal: (await membershipOf(db, id, people[role].auth.account.id))!.public_id,
          level: role === 'read_only' ? 'view' : 'edit',
        });
      const shared = (
        await env.svc.createTask(o, ws, { brand: brands.main, title: `Shared ${k}` }, mutation())
      ).data.id;
      people.guest = await join(env, db, o, ws, {
        kind: 'guest',
        records: [{ record: shared, level: 'comment' }],
      });
      W.push({ ws, id, people, brands, shared });
    }
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  const spans = () => env.h.telemetry.spans!;
  async function sameShapeAndTime(classes: Record<string, () => Promise<unknown>>) {
    const shapes = new Map<string, string[]>();
    for (const [name, fn] of Object.entries(classes))
      shapes.set(name, await statementShape(spans(), fn));
    const [first, ...rest] = [...shapes.entries()];
    for (const [name, shape] of rest) expect(shape, `${name} vs ${first![0]}`).toEqual(first![1]);
    expect(first![1].length, 'the requests reach the database').toBeGreaterThan(2);
    const t = await measureClasses(classes);
    expect(t.maxDelta, JSON.stringify(t.medians)).toBeLessThanOrEqual(t.threshold);
  }

  it('isolation: another workspace’s tasks, reminders, undo entries, bulk operations, and templates are not_found', async () => {
    const [a, b] = [W[0]!, W[1]!];
    const t = (
      await env.svc.createTask(
        a.people.owner,
        a.ws,
        { brand: a.brands.main, title: 'Only in A' },
        mutation(),
      )
    ).data;
    const rem = (
      await env.svc.createReminder(a.people.owner, a.ws, t.id, { remind_at: soon() }, mutation())
    ).data;
    const u = (
      await env.svc.updateTask(
        a.people.owner,
        a.ws,
        t.id,
        merge(0, { title: { base: 'Only in A', value: 'A2' } }),
        mutation(),
      )
    ).data;
    const bop = (
      await env.svc.previewBulk(
        a.people.owner,
        a.ws,
        { operation: 'archive', tasks: [t.id] },
        mutation(),
      )
    ).data;
    const tpl = (
      await env.svc.createTaskTemplate(a.people.owner, a.ws, t.id, { name: 'A tpl' }, mutation())
    ).data;
    const bo = b.people.owner;
    for (const call of [
      () => env.svc.taskSignals(bo, b.ws, t.id),
      () => env.svc.createReminder(bo, b.ws, t.id, { remind_at: soon() }, mutation()),
      () => env.svc.updateReminder(bo, b.ws, rem.id, { state: 'cancelled' }, mutation()),
      () => env.svc.snoozeTask(bo, b.ws, t.id, { until: soon() }, mutation()),
      () => env.svc.reorderTask(bo, b.ws, t.id, { position: 'top', version: 1 }, mutation()),
      () => env.svc.applyUndo(bo, b.ws, u.undo!.id, mutation()),
      () => env.svc.executeBulk(bo, b.ws, bop.id, mutation()),
      () => env.svc.getBulk(bo, b.ws, bop.id),
      () => env.svc.applyTaskTemplate(bo, b.ws, tpl.id, { brand: b.brands.main }, mutation()),
      () =>
        env.svc.defineTaskRecurrence(
          bo,
          b.ws,
          t.id,
          { frequency: 'daily', anchor_tz: 'UTC', start: '2026-01-01T09:00' },
          mutation(),
        ),
      () => env.svc.duplicateCandidates(bo, b.ws, { brand: a.brands.main, title: 'A2' }),
    ])
      await expect(call()).rejects.toEqual(reason('not_found'));
    // A bulk preview in B reports A's task exactly like an unknown identifier.
    await expect(
      env.svc.previewBulk(bo, b.ws, { operation: 'archive', tasks: [t.id] }, mutation()),
    ).rejects.toEqual(issueOf('nothing_to_apply'));
    // Personal rows never cross workspaces at the database (RLS).
    const leaked = await env.h.app.withWorkspace(b.id, { module: 'test', readOnly: true }, (tx) =>
      tx.db
        .selectFrom('planning.task_reminder')
        .select('id')
        .where('public_id', '=', rem.id)
        .execute(),
    );
    expect(leaked).toEqual([]);
  });

  it('roles: reminders and snoozes need read; ordering needs owned edit; recurrence needs manage; bulk items decide per item', async () => {
    const w = W[2]!;
    const t = (
      await env.svc.createTask(
        w.people.owner,
        w.ws,
        { brand: w.brands.main, title: 'Role task' },
        mutation(),
      )
    ).data;
    for (const who of [
      'owner',
      'administrator',
      'member',
      'limited_member',
      'read_only',
      'guest',
    ] as const) {
      const c = w.people[who];
      const target = who === 'guest' ? w.shared : t.id;
      const view = await env.svc.getTask(c, w.ws, target);
      // Personal state: allowed exactly when the task is readable.
      const r = await env.svc.createReminder(c, w.ws, target, { remind_at: soon(2) }, mutation());
      expect(r.data.state, who).toBe('scheduled');
      await env.svc.snoozeTask(c, w.ws, target, { until: soon(3) }, mutation());
      // Ordering agrees with the edit-context capability.
      const reorder = await env.svc
        .reorderTask(
          c,
          w.ws,
          target,
          { position: 'top', version: (await env.svc.getTask(c, w.ws, target)).version },
          mutation(),
        )
        .then(
          () => true,
          (e) => {
            expect(['forbidden', 'not_found']).toContain(e.code);
            return false;
          },
        );
      expect(reorder, who).toBe(view.capabilities.edit_context);
      // Bulk preview outcome agrees with the edit capability.
      const pv = (
        await env.svc.previewBulk(
          c,
          w.ws,
          { operation: 'set_priority', params: { value: 'urgent' }, tasks: [target] },
          mutation(),
        )
      ).data;
      expect(pv.items[0]!.outcome === 'ready', who).toBe(view.capabilities.edit);
      // Recurrence: only managers (owner and administrator implicitly).
      const rec = await env.svc
        .defineTaskRecurrence(
          c,
          w.ws,
          target,
          { frequency: 'weekly', anchor_tz: 'UTC', start: '2026-02-02T09:00' },
          mutation(),
        )
        .then(
          () => true,
          () => false,
        );
      expect(rec, who).toBe(who === 'owner' || who === 'administrator');
    }
    // Every person sees only their own reminders and snooze.
    const mine = await env.svc.taskSignals(w.people.member, w.ws, t.id);
    expect(mine.reminders).toHaveLength(1);
    expect(mine.snooze).not.toBeNull();
    const reminders = await env.svc.listReminders(w.people.read_only, w.ws);
    expect(reminders.every((r) => r.task.id === t.id)).toBe(true);
    expect(reminders).toHaveLength(1);
    // Guests: only the shared task; nothing about owners or relationships.
    const g = await env.svc.taskSignals(w.people.guest, w.ws, w.shared);
    expect(g.signals).toMatchObject({
      missing_owner: null,
      blocked: null,
      missing_dependency: null,
      missing_criteria: null,
    });
    await expect(env.svc.taskSignals(w.people.guest, w.ws, t.id)).rejects.toEqual(
      reason('not_found'),
    );
    await expect(
      env.svc.createReminder(w.people.guest, w.ws, t.id, { remind_at: soon() }, mutation()),
    ).rejects.toEqual(reason('not_found'));
  });

  it('signals hide unreadable blockers: no flag, no count, same statements and time (AT-131)', async () => {
    const w = W[0]!;
    const o = w.people.owner;
    const reader = w.people.member;
    const x = (
      await env.svc.createTask(
        o,
        w.ws,
        { brand: w.brands.main, title: 'Blocked by secret' },
        mutation(),
      )
    ).data;
    const y = (
      await env.svc.createTask(o, w.ws, { brand: w.brands.main, title: 'Not blocked' }, mutation())
    ).data;
    // The owner needs an explicit grant on the sensitive brand to relate across it.
    await apply(env, o, w.ws, {
      kind: 'brand_grant',
      brand: w.brands.secret,
      principal: await mem(0, o),
      level: 'manage',
    });
    const hidden = (
      await env.svc.createTask(
        o,
        w.ws,
        { brand: w.brands.secret, title: 'Secret blocker' },
        mutation(),
      )
    ).data;
    await env.svc.addRelationship(o, w.ws, hidden.id, { kind: 'blocks', target: x.id }, mutation());
    expect((await env.svc.taskSignals(o, w.ws, x.id)).signals.blocked).toBe(true);
    const seen = await env.svc.taskSignals(reader, w.ws, x.id);
    expect(seen.signals).toMatchObject({ blocked: false, missing_dependency: false });
    expect(JSON.stringify(seen)).not.toContain(hidden.id);
    await sameShapeAndTime({
      hiddenBlocker: () => env.svc.taskSignals(reader, w.ws, x.id),
      noBlocker: () => env.svc.taskSignals(reader, w.ws, y.id),
    });
    const batch = await env.svc.listTaskSignals(reader, w.ws, { tasks: `${x.id},${hidden.id}` });
    expect(batch.items.map((i) => i.task)).toEqual([x.id]);
  });

  it('duplicates show readable candidates only; a hidden match costs the same as none (AT-130)', async () => {
    const w = W[1]!;
    const o = w.people.owner;
    const prj = (
      await env.svc.createProject(o, w.ws, { brand: w.brands.main, name: 'Restricted' }, mutation())
    ).data;
    await env.svc.setAccess(
      o,
      w.ws,
      prj.id,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    await env.svc.createTask(
      o,
      w.ws,
      { brand: w.brands.main, project: prj.id, title: 'Rotate signing keys' },
      mutation(),
    );
    expect(
      (
        await env.svc.duplicateCandidates(o, w.ws, {
          brand: w.brands.main,
          title: 'rotate signing keys',
        })
      ).candidates,
    ).toHaveLength(1);
    const m = w.people.member;
    expect(
      (
        await env.svc.duplicateCandidates(m, w.ws, {
          brand: w.brands.main,
          title: 'rotate signing keys',
        })
      ).candidates,
    ).toEqual([]);
    await sameShapeAndTime({
      hiddenMatch: () =>
        env.svc.duplicateCandidates(m, w.ws, {
          brand: w.brands.main,
          title: 'rotate signing keys',
        }),
      noMatch: () =>
        env.svc.duplicateCandidates(m, w.ws, { brand: w.brands.main, title: 'nothing like it' }),
    });
  });

  it('bulk: an unreadable task is reported exactly like an unknown one (AT-132)', async () => {
    const w = W[1]!;
    const o = w.people.owner;
    const m = w.people.member;
    await apply(env, o, w.ws, {
      kind: 'brand_grant',
      brand: w.brands.secret,
      principal: await mem(1, o),
      level: 'manage',
    });
    const hidden = (
      await env.svc.createTask(o, w.ws, { brand: w.brands.secret, title: 'Hidden' }, mutation())
    ).data;
    const visible = (
      await env.svc.createTask(o, w.ws, { brand: w.brands.main, title: 'Visible' }, mutation())
    ).data;
    const unknown = 'tsk_00000000000000000000000000';
    const pv = (
      await env.svc.previewBulk(
        m,
        w.ws,
        {
          operation: 'set_priority',
          params: { value: 'low' },
          tasks: [visible.id, hidden.id, unknown],
        },
        mutation(),
      )
    ).data;
    expect(pv.items).toEqual([
      { task: visible.id, outcome: 'ready' },
      { task: hidden.id, outcome: 'not_found' },
      { task: unknown, outcome: 'not_found' },
    ]);
    await sameShapeAndTime({
      unreadable: () =>
        env.svc.previewBulk(m, w.ws, { operation: 'archive', tasks: [hidden.id] }, mutation()),
      unknown: () =>
        env.svc.previewBulk(m, w.ws, { operation: 'archive', tasks: [unknown] }, mutation()),
    });
    // Execution changes only the readable task.
    await env.svc.executeBulk(m, w.ws, pv.id, mutation());
    expect((await env.svc.getTask(o, w.ws, hidden.id)).priority).toBe('none');
    expect((await env.svc.getTask(o, w.ws, visible.id)).priority).toBe('low');
  });

  it('templates omit hidden and unavailable fields by kind, never by value (AT-137)', async () => {
    const w = W[2]!;
    const o = w.people.owner;
    const scope = `brand:${w.brands.main}`;
    const def = (body: Record<string, unknown>) =>
      env.svc
        .createFieldDefinition(o, w.ws, { scope, applies_to: ['task'], ...body }, mutation())
        .then((r) => r.data);
    const notes = await def({ name: 'Notes', field_type: 'text' });
    const margin = await def({
      name: 'Margin',
      field_type: 'number',
      visibility: { read: 'min_level', read_min_level: 'manage' },
    });
    const t = (
      await env.svc.createTask(o, w.ws, { brand: w.brands.main, title: 'Priced work' }, mutation())
    ).data;
    const f = await env.svc.recordFields(o, w.ws, t.id);
    await env.svc.updateRecordFields(
      o,
      w.ws,
      t.id,
      {
        version: f.version,
        changes: { [notes.id]: { value: 'hello' }, [margin.id]: { value: '987654321' } },
      },
      mutation(),
    );
    // The owner's template carries both values.
    const tpl = (await env.svc.createTaskTemplate(o, w.ws, t.id, { name: 'Priced' }, mutation()))
      .data;
    // A member with edit applies it: the hidden field is left out and reported by kind.
    const m = w.people.member;
    const made = await env.svc.applyTaskTemplate(
      m,
      w.ws,
      tpl.id,
      { brand: w.brands.main },
      mutation(),
    );
    expect(made.application.omitted).toContain('unavailable_fields');
    const body = JSON.stringify(made);
    expect(body).not.toContain('987654321');
    expect(body).not.toContain('Margin');
    const mf = await env.svc.recordFields(o, w.ws, made.application.task.id);
    expect(mf.fields.find((x) => x.id === notes.id)?.value).toBe('hello');
    expect(mf.fields.find((x) => x.id === margin.id)?.value ?? null).toBeNull();
  });

  it('custom workflows: bulk status changes run the transition evaluator per item', async () => {
    const w = W[0]!;
    const o = w.people.owner;
    const wf = (
      await env.svc.createWorkflow(
        o,
        w.ws,
        {
          scope: `brand:${w.brands.main}`,
          record_kind: 'task',
          name: 'Gated',
          statuses: [
            { name: 'Open', category: 'planned' },
            { name: 'Doing', category: 'active' },
            { name: 'Done', category: 'done' },
          ],
        },
        mutation(),
      )
    ).data;
    const doing = wf.statuses[1]!.id;
    const a = (
      await env.svc.createTask(o, w.ws, { brand: w.brands.main, title: 'WF a' }, mutation())
    ).data;
    const pv = (
      await env.svc.previewBulk(
        o,
        w.ws,
        { operation: 'set_status', params: { value: doing }, tasks: [a.id] },
        mutation(),
      )
    ).data;
    const ex = (await env.svc.executeBulk(o, w.ws, pv.id, mutation())).data;
    // A new workflow without explicit transitions allows moves between open statuses (2C W5);
    // the per-item evaluator still runs (and refuses done-category targets).
    expect(ex.items[0]!.outcome).toBe('applied');
    expect((await env.svc.getTask(o, w.ws, a.id)).status).toMatchObject({
      key: doing,
      custom: true,
    });
    // Done-category statuses are never set in bulk.
    await expect(
      env.svc.previewBulk(
        o,
        w.ws,
        { operation: 'set_status', params: { value: 'done' }, tasks: [a.id] },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('use_complete'));
  });

  it('bulk status (review 01): custom statuses, mixed workflows, refusals per item, stale and revoked items', async () => {
    const w = W[1]!;
    const o = w.people.owner;
    const prj = async (name: string) =>
      (await env.svc.createProject(o, w.ws, { brand: w.brands.main, name }, mutation())).data.id;
    const [p1, p2] = [await prj('Flow one'), await prj('Flow two')];
    const notes = (
      await env.svc.createFieldDefinition(
        o,
        w.ws,
        { scope: `project:${p1}`, applies_to: ['task'], name: 'Notes', field_type: 'text' },
        mutation(),
      )
    ).data;
    const wf = async (scope: string, names: string[]) =>
      (
        await env.svc.createWorkflow(
          o,
          w.ws,
          {
            scope,
            record_kind: 'task',
            name: names.join('/'),
            statuses: [
              { name: names[0], category: 'planned' },
              { name: names[1], category: 'active' },
              { name: names[2], category: 'done' },
            ],
          },
          mutation(),
        )
      ).data;
    const wf1 = await wf(`project:${p1}`, ['Open', 'Review', 'Closed']);
    const wf2 = await wf(`project:${p2}`, ['Queued', 'Doing', 'Shipped']);
    const [open1, review] = [wf1.statuses[0]!.id, wf1.statuses[1]!.id];
    const [queued, doing] = [wf2.statuses[0]!.id, wf2.statuses[1]!.id];
    await env.svc.addTransition(
      o,
      w.ws,
      wf1.id,
      { transition: { from: open1, to: review, requirements: [{ field: notes.id }] } },
      mutation({ ifMatch: `"${wf1.version}"` }),
    );
    await env.svc.addTransition(
      o,
      w.ws,
      wf2.id,
      { transition: { from: queued, to: doing, approval_policy: 'one_manager' } },
      mutation({ ifMatch: `"${wf2.version}"` }),
    );
    const mk = async (project: string, title: string) =>
      (await env.svc.createTask(o, w.ws, { project, title }, mutation())).data.id;
    const a1 = await mk(p1, 'Needs notes');
    const a2 = await mk(p1, 'Has notes');
    const b1 = await mk(p2, 'Other workflow');
    const f = await env.svc.recordFields(o, w.ws, a2);
    await env.svc.updateRecordFields(
      o,
      w.ws,
      a2,
      { version: f.version, changes: { [notes.id]: { value: 'ok' } } },
      mutation(),
    );
    // Options for a mixed selection: each workflow's custom statuses, with how many tasks offer them.
    const opts = await env.svc.bulkStatusOptions(o, w.ws, { tasks: [a1, a2, b1].join(',') });
    expect(opts).toMatchObject({ tasks: 3, editable: 3, mixed_workflows: true });
    expect(opts.options.find((x) => x.status.key === review)).toMatchObject({
      available_for: 2,
      all: false,
      status: { name: 'Review', custom: true },
    });
    expect(opts.options.find((x) => x.status.key === doing)).toMatchObject({
      available_for: 1,
      all: false,
    });
    expect(opts.options.some((x) => x.status.key === 'in_progress')).toBe(false);
    // Preview: target per task, required fields named, unavailable status refused, never mapped.
    const pv = (
      await env.svc.previewBulk(
        o,
        w.ws,
        { operation: 'set_status', params: { value: review }, tasks: [a1, a2, b1] },
        mutation(),
      )
    ).data;
    expect(pv.items).toEqual([
      expect.objectContaining({
        task: a1,
        outcome: 'invalid',
        required_fields: ['Notes'],
        target: expect.objectContaining({ key: review }),
      }),
      expect.objectContaining({
        task: a2,
        outcome: 'ready',
        target: expect.objectContaining({ key: review, name: 'Review' }),
      }),
      expect.objectContaining({ task: b1, outcome: 'invalid', code: 'status_unavailable' }),
    ]);
    const ap = (
      await env.svc.previewBulk(
        o,
        w.ws,
        { operation: 'set_status', params: { value: doing }, tasks: [b1] },
        mutation(),
      )
    ).data;
    expect(ap.items[0]).toMatchObject({ outcome: 'invalid', code: 'approval_required' });
    // Apply: only a2 changes, through the evaluator; the others report the same refusals.
    const ex = (await env.svc.executeBulk(o, w.ws, pv.id, mutation())).data;
    expect(ex.items.map((i) => i.outcome)).toEqual(['invalid', 'applied', 'invalid']);
    expect((await env.svc.getTask(o, w.ws, a2)).status).toMatchObject({
      key: review,
      custom: true,
    });
    expect((await env.svc.getTask(o, w.ws, b1)).status.key).toBe(queued);
    // Stale: a change after the preview makes the item a conflict at apply.
    const a3 = await mk(p1, 'Stale one');
    const f3 = await env.svc.recordFields(o, w.ws, a3);
    await env.svc.updateRecordFields(
      o,
      w.ws,
      a3,
      { version: f3.version, changes: { [notes.id]: { value: 'ok' } } },
      mutation(),
    );
    const sp = (
      await env.svc.previewBulk(
        o,
        w.ws,
        { operation: 'set_status', params: { value: review }, tasks: [a3] },
        mutation(),
      )
    ).data;
    expect(sp.items[0]!.outcome).toBe('ready');
    const v3 = (await env.svc.getTask(o, w.ws, a3)).version;
    await env.svc.updateTask(
      o,
      w.ws,
      a3,
      merge(v3, { title: { base: 'Stale one', value: 'Renamed' } }),
      mutation(),
    );
    const sx = (await env.svc.executeBulk(o, w.ws, sp.id, mutation())).data;
    expect(sx.items[0]).toMatchObject({ outcome: 'conflict', code: 'stale' });
    expect((await env.svc.getTask(o, w.ws, a3)).status.key).toBe(open1);
    // Permission loss between preview and apply: the item is not_found and unchanged.
    const lim = w.people.limited_member;
    const limMem = await mem(1, lim);
    await apply(env, o, w.ws, {
      kind: 'project_grant',
      project: p1,
      principal: limMem,
      level: 'edit',
    });
    const lp = (
      await env.svc.previewBulk(
        lim,
        w.ws,
        { operation: 'set_status', params: { value: review }, tasks: [a3] },
        mutation(),
      )
    ).data;
    expect(lp.items[0]!.outcome).toBe('ready');
    await env.svc.setAccess(
      o,
      w.ws,
      p1,
      { access_mode: 'restricted', allow_record_shares: true },
      mutation(),
    );
    await apply(env, o, w.ws, { kind: 'project_revoke', project: p1, principal: limMem });
    const lx = (await env.svc.executeBulk(lim, w.ws, lp.id, mutation())).data;
    expect(lx.items[0]!.outcome).toBe('not_found');
    expect((await env.svc.getTask(o, w.ws, a3)).status.key).toBe(open1);
    // Share-only readers (a comment share) are refused per item.
    const g = (
      await env.svc.previewBulk(
        w.people.guest,
        w.ws,
        { operation: 'set_status', params: { value: 'in_progress' }, tasks: [w.shared] },
        mutation(),
      )
    ).data;
    expect(g.items[0]!.outcome).toBe('forbidden');
  });

  it('a series pauses when its owner loses authority; resuming requires current manage (AT-136)', async () => {
    const w = W[1]!;
    const o = w.people.owner;
    const admin = w.people.administrator;
    const t = (
      await env.svc.createTask(o, w.ws, { brand: w.brands.main, title: 'Recurring' }, mutation())
    ).data;
    const s = (
      await env.svc.defineTaskRecurrence(
        admin,
        w.ws,
        t.id,
        { frequency: 'daily', anchor_tz: 'UTC', start: '2026-01-01T09:00' },
        mutation(),
      )
    ).data;
    await apply(env, o, w.ws, { kind: 'role', member: await mem(1, admin), role: 'read_only' });
    const { recurrenceHandler } = await import('@pm/work');
    await recurrenceHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
    }).handle({} as never);
    const st = await db.admin(`SELECT state FROM planning.recurrence_series WHERE public_id = $1`, [
      s.id,
    ]);
    expect(st.rows[0].state).toBe('paused');
    const made = await db.admin(
      `SELECT count(*)::int AS n FROM work.task t JOIN planning.recurrence_series s ON s.id = t.recurrence_series_id WHERE s.public_id = $1`,
      [s.id],
    );
    expect(made.rows[0].n).toBe(0);
    // The demoted administrator cannot resume; the owner can and becomes the series owner.
    await expect(
      env.svc.setTaskRecurrenceState(admin, w.ws, t.id, s.id, { state: 'active' }, mutation()),
    ).rejects.toEqual(
      expect.objectContaining({ code: expect.stringMatching(/forbidden|not_found/) }),
    );
    const resumed = (
      await env.svc.setTaskRecurrenceState(o, w.ws, t.id, s.id, { state: 'active' }, mutation())
    ).data;
    expect(resumed.state).toBe('active');
  });
});
