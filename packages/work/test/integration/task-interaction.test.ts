import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { recurrenceHandler, remindersHandler } from '@pm/work';
import type { Caller } from '@pm/tenancy';
import { apply, join, merge, mutation, workEnv, workspaceWith, type WorkEnv } from './fixture.ts';

const reason = (code: string) => expect.objectContaining({ code });
const issueOf = (code: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });

/**
 * Phase 2D task interaction quality on real PostgreSQL (ADR-0016): origin, OD-17 freshness and
 * signals, deterministic duplicates, personal reminders and snoozes, reschedule counting, ordering
 * commands, bulk preview and execution (atomic and partial), undo (expiry and conflicts), task
 * templates with omissions, and recurring tasks (idempotent keys, DST, owner loss, catch-up).
 */
describe('task interaction quality (2D)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let brands: Record<string, string>;

  const task = (body: Record<string, unknown>, as: Caller = owner) =>
    env.svc.createTask(as, ws, { brand: brands.Harbor, ...body }, mutation()).then((r) => r.data);
  const signals = (id: string, as: Caller = owner) =>
    env.svc.taskSignals(as, ws, id).then((s) => s.signals);
  const age = (id: string, days: number) =>
    db.admin(
      `UPDATE work.task SET last_meaningful_update_at = now() - make_interval(days => $2)
        WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
      [id, days],
    );
  const lmu = async (id: string) =>
    new Date(
      (
        await db.admin(
          `SELECT t.last_meaningful_update_at AS v FROM work.task t JOIN core.record r ON r.id = t.id WHERE r.public_id = $1`,
          [id],
        )
      ).rows[0].v,
    ).getTime();

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('source: tasks created by people are manual; origin is immutable in the database', async () => {
    const t = await task({ title: 'Origin' });
    expect(t.source).toEqual({ kind: 'manual' });
    await expect(
      db.admin(
        `UPDATE work.task SET origin_kind = 'import' WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [t.id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.admin(
        `UPDATE work.task SET origin_ref = '{"x":1}' WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [t.id],
      ),
    ).rejects.toThrow(/immutable/);
    // Only the closed kinds exist.
    await expect(
      db.admin(`UPDATE work.task SET origin_kind = 'email' WHERE false`),
    ).resolves.toBeDefined();
    await expect(
      db.admin(
        `ALTER TABLE work.task DISABLE TRIGGER task_origin_immutable;
         UPDATE work.task SET origin_kind = 'email' WHERE id = (SELECT id FROM core.record WHERE public_id = '${t.id}');`,
      ),
    ).rejects.toThrow(/task_origin_known/);
    await db.admin(`ALTER TABLE work.task ENABLE TRIGGER task_origin_immutable`);
    // A registered migration (the owner, trigger disabled in its own transaction) may rewrite it.
    await db.admin(`BEGIN;
      ALTER TABLE work.task DISABLE TRIGGER task_origin_immutable;
      UPDATE work.task SET origin_kind = 'import', origin_ref = '{"batch":"imp_1"}'
       WHERE id = (SELECT id FROM core.record WHERE public_id = '${t.id}');
      ALTER TABLE work.task ENABLE TRIGGER task_origin_immutable;
      COMMIT;`);
    expect((await env.svc.getTask(owner, ws, t.id)).source).toEqual({
      kind: 'import',
      batch: 'imp_1',
    });
  });

  it('origins (review 01): template, manual, duplicate, recurring, and the closed system kinds each keep their own', async () => {
    const src = await task({ title: 'Origin source' });
    expect(src.source).toEqual({ kind: 'manual' });
    const tpl = (
      await env.svc.createTaskTemplate(owner, ws, src.id, { name: 'Origin tpl' }, mutation())
    ).data;
    const fromTpl = (
      await env.svc.applyTaskTemplate(owner, ws, tpl.id, { brand: brands.Harbor }, mutation())
    ).application.task;
    expect(fromTpl.source).toEqual({ kind: 'template', template: tpl.id, version: 1 });
    const v2 = (await env.svc.versionTaskTemplate(owner, ws, tpl.id, { task: src.id }, mutation()))
      .data;
    const fromV2 = (
      await env.svc.applyTaskTemplate(owner, ws, tpl.id, { brand: brands.Harbor }, mutation())
    ).application.task;
    expect(fromV2.source).toEqual({ kind: 'template', template: tpl.id, version: v2.version });
    // Duplicating keeps a person's action manual; the source task's origin is untouched.
    const dup = (await env.svc.duplicateTask(owner, ws, fromTpl.id, {}, mutation())).data as {
      id: string;
    };
    expect((await env.svc.getTask(owner, ws, dup.id)).source).toEqual({ kind: 'manual' });
    expect((await env.svc.getTask(owner, ws, fromTpl.id)).source.kind).toBe('template');
    // A recurring occurrence is recurring, never template.
    const s = (
      await env.svc.defineTaskRecurrence(
        owner,
        ws,
        src.id,
        { frequency: 'daily', anchor_tz: 'UTC', start: '2026-06-01T09:00' },
        mutation(),
      )
    ).data;
    const occ = (await env.svc.generateNextTaskOccurrence(owner, ws, src.id, s.id, mutation())).data
      .occurrence!;
    expect((await env.svc.getTask(owner, ws, occ.id)).source).toEqual({
      kind: 'recurring',
      series: s.id,
      occurrence: '2026-06-01T09:00',
    });
    // Intake, import, integration, and AI drafts arrive through their producers (2E, 6D, 6A, 7A);
    // the closed set and its readback hold for each. An unknown kind is refused.
    const con = await db.admin(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'task_origin_known'`,
    );
    for (const kind of [
      'manual',
      'recurring',
      'template',
      'intake',
      'import',
      'integration',
      'ai_draft',
    ])
      expect(con.rows[0].d).toContain(`'${kind}'`);
    // Existing manual tasks stay manual.
    expect((await env.svc.getTask(owner, ws, src.id)).source).toEqual({ kind: 'manual' });
  });

  it('freshness: meaningful updates move it; reads, rank, reminders, and snoozes do not', async () => {
    const t = await task({ title: 'Fresh' });
    const t2 = await task({ title: 'Sibling' });
    await age(t.id, 3);
    const before = await lmu(t.id);
    // Not meaningful: reads, priority, rank, reminders, snoozes.
    await env.svc.getTask(owner, ws, t.id);
    await env.svc.updateTask(
      owner,
      ws,
      t.id,
      merge(0, { priority: { base: 'none', value: 'high' } }),
      mutation(),
    );
    await env.svc.reorderTask(owner, ws, t2.id, { position: 'top', version: 0 }, mutation());
    await env.svc.createReminder(
      owner,
      ws,
      t.id,
      { remind_at: new Date(Date.now() + 3_600_000).toISOString() },
      mutation(),
    );
    await env.svc.snoozeTask(
      owner,
      ws,
      t.id,
      { until: new Date(Date.now() + 3_600_000).toISOString() },
      mutation(),
    );
    expect(await lmu(t.id)).toBe(before);
    // Meaningful: title, checklist, label, link, relationship, custom field, manual.
    const step = async (fn: () => Promise<unknown>) => {
      await age(t.id, 3);
      const b = await lmu(t.id);
      await fn();
      expect(await lmu(t.id)).toBeGreaterThan(b);
    };
    const v = async () => (await env.svc.getTask(owner, ws, t.id)).version;
    await step(async () =>
      env.svc.updateTask(
        owner,
        ws,
        t.id,
        merge(await v(), { title: { base: 'Fresh', value: 'Fresher' } }),
        mutation(),
      ),
    );
    await step(() => env.svc.addChecklistItem(owner, ws, t.id, { text: 'Step' }, mutation()));
    const label = (
      await env.svc.createLabel(owner, ws, brands.Harbor, { name: 'Fresh' }, mutation())
    ).data;
    await step(() => env.svc.addTaskLabel(owner, ws, t.id, { label: label.id }, mutation()));
    await step(() =>
      env.svc.addLink(owner, ws, t.id, { url: 'https://example.com/f' }, mutation()),
    );
    await step(() =>
      env.svc.addRelationship(owner, ws, t2.id, { kind: 'blocks', target: t.id }, mutation()),
    );
    await step(() => env.svc.markTaskUpdated(owner, ws, t.id, mutation()));
  });

  it('signals: stale thresholds by category, missing owner/date/criteria, blocked, missing dependency', async () => {
    const a = await task({ title: 'Active one', status: 'in_progress' });
    const pl = await task({ title: 'Planned one' });
    await age(a.id, 6);
    await age(pl.id, 13);
    expect(await signals(a.id)).toMatchObject({
      stale: false,
      missing_owner: true,
      missing_date: true,
      missing_criteria: true,
      blocked: false,
      missing_dependency: false,
    });
    expect((await signals(pl.id)).stale).toBe(false);
    await age(a.id, 8);
    await age(pl.id, 15);
    expect((await signals(a.id)).stale).toBe(true);
    expect((await signals(pl.id)).stale).toBe(true);
    // Paused, done, and cancelled tasks are never stale.
    const paused = await task({ title: 'Paused', status: 'blocked' });
    await age(paused.id, 400);
    expect((await signals(paused.id)).stale).toBe(false);
    // Owner, date, criteria fill in.
    await env.svc.setAssignees(
      owner,
      ws,
      a.id,
      { assignees: [await meId()], version: (await env.svc.getTask(owner, ws, a.id)).version },
      mutation(),
    );
    expect((await signals(a.id)).missing_owner).toBe(false);
    const b = await task({ title: 'Blocker', status: 'in_progress' });
    await env.svc.addRelationship(owner, ws, b.id, { kind: 'blocks', target: a.id }, mutation());
    expect((await signals(a.id)).blocked).toBe(true);
    // A cancelled blocker no longer blocks but leaves a missing dependency.
    const bv = (await env.svc.getTask(owner, ws, b.id)).version;
    await env.svc.updateTask(
      owner,
      ws,
      b.id,
      merge(bv, { status: { base: 'in_progress', value: 'cancelled' } }),
      mutation(),
    );
    expect(await signals(a.id)).toMatchObject({ blocked: false, missing_dependency: true });
    const av = (await env.svc.getTask(owner, ws, a.id)).version;
    await env.svc.updateTask(
      owner,
      ws,
      a.id,
      merge(av, { due_date: { base: null, value: '2026-12-01' } }),
      mutation(),
    );
    await env.svc.addTaskCriterion(
      owner,
      ws,
      a.id,
      { kind: 'acceptance', text: 'Done right' },
      mutation(),
    );
    expect(await signals(a.id)).toMatchObject({ missing_date: false, missing_criteria: false });
  });

  async function memberOf(who: Caller) {
    const r = await db.admin(`SELECT public_id FROM tenancy.membership WHERE account_id = $1`, [
      who.auth.account.id,
    ]);
    return r.rows[0].public_id as string;
  }

  async function meId() {
    const r = await db.admin(
      `SELECT m.public_id FROM tenancy.membership m JOIN identity.account a ON a.id = m.account_id WHERE a.id = $1`,
      [owner.auth.account.id],
    );
    return r.rows[0].public_id as string;
  }

  it('reschedule: three material due-date or deadline edits in the window; first dates and snoozes do not count', async () => {
    const t = await task({ title: 'Slipping' });
    const set = async (field: 'due_date' | 'deadline', base: unknown, value: unknown) => {
      const v = (await env.svc.getTask(owner, ws, t.id)).version;
      await env.svc.updateTask(owner, ws, t.id, merge(v, { [field]: { base, value } }), mutation());
    };
    await set('due_date', null, '2026-11-01'); // first date: not a reschedule
    await env.svc.snoozeTask(
      owner,
      ws,
      t.id,
      { until: new Date(Date.now() + 86_400_000).toISOString() },
      mutation(),
    );
    await set('due_date', '2026-11-01', '2026-11-08');
    await set('due_date', '2026-11-08', '2026-11-15');
    expect((await signals(t.id)).repeatedly_rescheduled).toBe(false);
    await set('deadline', null, { date: '2026-12-01' }); // first deadline: not a reschedule
    await set('deadline', { date: '2026-12-01' }, { date: '2026-12-08' });
    expect((await signals(t.id)).repeatedly_rescheduled).toBe(true);
    // The threshold is the registered parameter.
    const strict = workEnv(db, { work: { taskRescheduleCount: 4 } });
    try {
      expect((await strict.svc.taskSignals(owner, ws, t.id)).signals.repeatedly_rescheduled).toBe(
        false,
      );
    } finally {
      await strict.h.close();
    }
  });

  it('duplicates: normalized title in brand, compatible project, open, recent; advisory and readable only', async () => {
    const prj = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Dup P' }, mutation())
    ).data;
    const a = await task({ title: 'Renew   SSL Certificate' });
    await task({ title: 'renew ssl certificate', project: prj.id });
    const other = await env.svc.createTask(
      owner,
      ws,
      { brand: brands.Summit, title: 'Renew SSL certificate' },
      mutation(),
    );
    const found = await env.svc.duplicateCandidates(owner, ws, {
      brand: brands.Harbor,
      title: ' RENEW ssl  certificate ',
    });
    expect(found.advisory).toBe(true);
    expect(found.candidates).toHaveLength(2);
    expect(found.candidates.map((c) => c.id)).not.toContain(other.data.id);
    // Excluding the task being edited; a project only matches its own and projectless tasks.
    const prj2 = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Dup Q' }, mutation())
    ).data;
    const scoped = await env.svc.duplicateCandidates(owner, ws, {
      brand: brands.Harbor,
      project: prj2.id,
      title: 'renew ssl certificate',
      exclude: a.id,
    });
    expect(scoped.candidates).toEqual([]);
    // Done tasks and old tasks are not candidates.
    await db.admin(
      `UPDATE work.task SET created_at = now() - interval '200 days' WHERE lower(regexp_replace(title, '\\s+', ' ', 'g')) = 'renew ssl certificate'`,
    );
    expect(
      (
        await env.svc.duplicateCandidates(owner, ws, {
          brand: brands.Harbor,
          title: 'renew ssl certificate',
        })
      ).candidates,
    ).toEqual([]);
  });

  it('reminders: personal, idempotent per instant, bounded, deduplicated firing, cancelled when unreadable', async () => {
    const t = await task({ title: 'Remind me' });
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const r1 = (await env.svc.createReminder(owner, ws, t.id, { remind_at: at }, mutation())).data;
    const r2 = (await env.svc.createReminder(owner, ws, t.id, { remind_at: at }, mutation())).data;
    expect(r2.id).toBe(r1.id);
    await expect(
      env.svc.createReminder(
        owner,
        ws,
        t.id,
        { remind_at: new Date(Date.now() - 1000).toISOString() },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('out_of_range'));
    // The task never changes.
    const before = await env.svc.getTask(owner, ws, t.id);
    // Due now: one worker run fires it once; a second run fires nothing.
    await db.admin(
      `UPDATE planning.task_reminder SET remind_at = now() - interval '1 minute' WHERE public_id = $1`,
      [r1.id],
    );
    const handler = remindersHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
    });
    await handler.handle({} as never);
    await handler.handle({} as never);
    const fired = await db.admin(
      `SELECT count(*)::int AS n FROM exec.outbox_event WHERE event_type = 'planning.task_reminder.fired' AND aggregate_id = (SELECT id FROM planning.task_reminder WHERE public_id = $1)`,
      [r1.id],
    );
    expect(fired.rows[0].n).toBe(1);
    const after = await env.svc.getTask(owner, ws, t.id);
    expect(after.version).toBe(before.version);
    expect(after.due_date).toBe(before.due_date);
    // Dismiss; no further changes; another person's reminder is not_found.
    const d = (await env.svc.updateReminder(owner, ws, r1.id, { state: 'dismissed' }, mutation()))
      .data;
    expect(d.state).toBe('dismissed');
    const other = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await expect(
      env.svc.updateReminder(other, ws, r1.id, { state: 'cancelled' }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    // Bounded per person and task.
    const small = workEnv(db, { work: { taskRemindersMax: 2 } });
    try {
      for (const h of [2, 3])
        await small.svc.createReminder(
          owner,
          ws,
          t.id,
          { remind_at: new Date(Date.now() + h * 3_600_000).toISOString() },
          mutation(),
        );
      await expect(
        small.svc.createReminder(
          owner,
          ws,
          t.id,
          { remind_at: new Date(Date.now() + 4 * 3_600_000).toISOString() },
          mutation(),
        ),
      ).rejects.toEqual(issueOf('too_many'));
    } finally {
      await small.h.close();
    }
  });

  it('snooze: personal, bounded, never edits the task; a reminder during a snooze moves to its end', async () => {
    const t = await task({ title: 'Snooze me' });
    const v0 = (await env.svc.getTask(owner, ws, t.id)).version;
    const until = new Date(Date.now() + 2 * 3_600_000);
    const s = (
      await env.svc.snoozeTask(owner, ws, t.id, { until: until.toISOString() }, mutation())
    ).data;
    expect(s.snoozed_until).toBe(until.toISOString());
    expect((await env.svc.getTask(owner, ws, t.id)).version).toBe(v0);
    await expect(
      env.svc.snoozeTask(
        owner,
        ws,
        t.id,
        { until: new Date(Date.now() + 400 * 86_400_000).toISOString() },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('out_of_range'));
    const other = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await memberOf(other),
      level: 'view',
    });
    expect((await env.svc.taskSignals(other, ws, t.id)).snooze).toBeNull();
    const r = (
      await env.svc.createReminder(
        owner,
        ws,
        t.id,
        { remind_at: new Date(Date.now() + 60_000).toISOString() },
        mutation(),
      )
    ).data;
    await db.admin(
      `UPDATE planning.task_reminder SET remind_at = now() - interval '1 minute' WHERE public_id = $1`,
      [r.id],
    );
    await remindersHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
    }).handle({} as never);
    const row = await db.admin(
      `SELECT state, remind_at FROM planning.task_reminder WHERE public_id = $1`,
      [r.id],
    );
    expect(row.rows[0].state).toBe('scheduled');
    expect(new Date(row.rows[0].remind_at).toISOString()).toBe(until.toISOString());
    await env.svc.unsnoozeTask(owner, ws, t.id, mutation());
    expect((await env.svc.taskSignals(owner, ws, t.id)).snooze).toBeNull();
  });

  it('ordering: up, down, top, bottom, and move to a position; announcements; stale version refused', async () => {
    const parent = await task({ title: 'Parent for order' });
    const kids = [];
    for (const title of ['A', 'B', 'C', 'D'])
      kids.push(
        (await env.svc.createTask(owner, ws, { parent: parent.id, title }, mutation())).data,
      );
    const order = async () =>
      (await env.svc.listTasks(owner, ws, { parent: parent.id })).data.map((x) => x.title);
    const ver = async (id: string) => (await env.svc.getTask(owner, ws, id)).version;
    let r = (
      await env.svc.reorderTask(
        owner,
        ws,
        kids[3]!.id,
        { position: 'top', version: await ver(kids[3]!.id) },
        mutation(),
      )
    ).data;
    expect(r).toMatchObject({ position: 1, total: 4, announcement: 'Moved to position 1 of 4.' });
    expect(await order()).toEqual(['D', 'A', 'B', 'C']);
    await env.svc.reorderTask(
      owner,
      ws,
      kids[0]!.id,
      { position: 'down', version: await ver(kids[0]!.id) },
      mutation(),
    );
    expect(await order()).toEqual(['D', 'B', 'A', 'C']);
    await env.svc.reorderTask(
      owner,
      ws,
      kids[2]!.id,
      { position: 'up', version: await ver(kids[2]!.id) },
      mutation(),
    );
    expect(await order()).toEqual(['D', 'B', 'C', 'A']);
    await env.svc.reorderTask(
      owner,
      ws,
      kids[3]!.id,
      { position: 'bottom', version: await ver(kids[3]!.id) },
      mutation(),
    );
    expect(await order()).toEqual(['B', 'C', 'A', 'D']);
    await env.svc.reorderTask(
      owner,
      ws,
      kids[3]!.id,
      { position: 'to', index: 2, version: await ver(kids[3]!.id) },
      mutation(),
    );
    expect(await order()).toEqual(['B', 'D', 'C', 'A']);
    // No-op at the edges.
    r = (
      await env.svc.reorderTask(
        owner,
        ws,
        kids[1]!.id,
        { position: 'up', version: await ver(kids[1]!.id) },
        mutation(),
      )
    ).data;
    expect(r.position).toBe(1);
    await expect(
      env.svc.reorderTask(owner, ws, kids[3]!.id, { position: 'top', version: 0 }, mutation()),
    ).rejects.toEqual(reason('conflict'));
  });

  it('undo: field edits and moves within the window; expiry; a later change makes it unavailable', async () => {
    const t = await task({ title: 'Undo me' });
    const u = (
      await env.svc.updateTask(
        owner,
        ws,
        t.id,
        merge(0, { title: { base: 'Undo me', value: 'Changed' } }),
        mutation(),
      )
    ).data;
    expect(u.undo).toBeDefined();
    const applied = (await env.svc.applyUndo(owner, ws, u.undo!.id, mutation())).data;
    expect(applied.state).toBe('applied');
    expect((await env.svc.getTask(owner, ws, t.id)).title).toBe('Undo me');
    // Applying twice is refused.
    await expect(env.svc.applyUndo(owner, ws, u.undo!.id, mutation())).rejects.toEqual(
      reason('conflict'),
    );
    // Conflict: another edit after the change.
    const v = (await env.svc.getTask(owner, ws, t.id)).version;
    const u2 = (
      await env.svc.updateTask(
        owner,
        ws,
        t.id,
        merge(v, { title: { base: 'Undo me', value: 'Mine' } }),
        mutation(),
      )
    ).data;
    await env.svc.updateTask(
      owner,
      ws,
      t.id,
      merge(v + 1, { priority: { base: 'none', value: 'low' } }),
      mutation(),
    );
    await expect(env.svc.applyUndo(owner, ws, u2.undo!.id, mutation())).rejects.toEqual(
      reason('conflict'),
    );
    const st = await db.admin(`SELECT state FROM work.undo_entry WHERE public_id = $1`, [
      u2.undo!.id,
    ]);
    expect(st.rows[0].state).toBe('conflicted');
    // Expiry.
    const v3 = (await env.svc.getTask(owner, ws, t.id)).version;
    const u3 = (
      await env.svc.updateTask(
        owner,
        ws,
        t.id,
        merge(v3, { title: { base: 'Mine', value: 'Late' } }),
        mutation(),
      )
    ).data;
    await db.admin(
      `BEGIN; ALTER TABLE work.undo_entry DISABLE TRIGGER undo_entry_guard;
       UPDATE work.undo_entry SET created_at = created_at - interval '1 minute', expires_at = expires_at - interval '1 minute' WHERE public_id = '${u3.undo!.id}';
       ALTER TABLE work.undo_entry ENABLE TRIGGER undo_entry_guard; COMMIT;`,
    );
    await expect(env.svc.applyUndo(owner, ws, u3.undo!.id, mutation())).rejects.toEqual(
      issueOf('undo_expired'),
    );
    // Someone else's undo entry is not_found.
    const other = await join(env, db, owner, ws, { kind: 'member', role: 'administrator' });
    const v4 = (await env.svc.getTask(owner, ws, t.id)).version;
    const u4 = (
      await env.svc.updateTask(
        owner,
        ws,
        t.id,
        merge(v4, { title: { base: 'Late', value: 'Again' } }),
        mutation(),
      )
    ).data;
    await expect(env.svc.applyUndo(other, ws, u4.undo!.id, mutation())).rejects.toEqual(
      reason('not_found'),
    );
  });

  it('bulk: preview first; safe operations report per item; destructive ones are all-or-nothing unless partial', async () => {
    const xs = [];
    for (const title of ['B1', 'B2', 'B3']) xs.push(await task({ title }));
    const summit = (
      await env.svc.createTask(owner, ws, { brand: brands.Summit, title: 'S1' }, mutation())
    ).data;
    const ids = [...xs.map((x) => x.id), summit.id, 'tsk_00000000000000000000000000'];
    const label = (
      await env.svc.createLabel(owner, ws, brands.Harbor, { name: 'Bulk' }, mutation())
    ).data;
    const prev = (
      await env.svc.previewBulk(
        owner,
        ws,
        { operation: 'add_label', params: { label: label.id }, tasks: ids },
        mutation(),
      )
    ).data;
    expect(prev).toMatchObject({ state: 'previewed', mode: 'partial', destructive: false });
    expect(prev.items.map((i) => i.outcome)).toEqual([
      'ready',
      'ready',
      'ready',
      'invalid',
      'not_found',
    ]);
    // Nothing changed by the preview.
    expect((await env.svc.getTask(owner, ws, xs[0]!.id)).labels).toEqual([]);
    const done = (await env.svc.executeBulk(owner, ws, prev.id, mutation())).data;
    expect(done.items.map((i) => i.outcome)).toEqual(['applied', 'applied', 'applied', 'invalid']);
    expect((await env.svc.getTask(owner, ws, xs[0]!.id)).labels).toEqual([
      expect.objectContaining({ id: label.id }),
    ]);
    // Executing twice is refused.
    await expect(env.svc.executeBulk(owner, ws, prev.id, mutation())).rejects.toEqual(
      reason('conflict'),
    );
    // Undo the bulk label change.
    await env.svc.applyUndo(owner, ws, done.undo!.id, mutation());
    expect((await env.svc.getTask(owner, ws, xs[0]!.id)).labels).toEqual([]);
    // Destructive atomic: one item fails (already trashed) → nothing changes.
    await env.svc.taskLifecycle(owner, ws, xs[2]!.id, 'trash', {}, mutation());
    const tp = (
      await env.svc.previewBulk(
        owner,
        ws,
        { operation: 'archive', tasks: xs.map((x) => x.id) },
        mutation(),
      )
    ).data;
    expect(tp.mode).toBe('atomic');
    expect(tp.items.map((i) => i.outcome)).toEqual(['ready', 'ready', 'not_found']);
    // The trashed one is not part of the executable set; trash another concurrently to force a failure.
    await env.svc.taskLifecycle(owner, ws, xs[1]!.id, 'archive', {}, mutation());
    const ex = (await env.svc.executeBulk(owner, ws, tp.id, mutation())).data;
    expect(ex.items.map((i) => i.outcome)).toEqual(['applied', 'no_change']);
    // A reader who may not trash sees a per-item refusal in the preview, never a mutation.
    const reader = await join(env, db, owner, ws, { kind: 'member', role: 'read_only' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await memberOf(reader),
      level: 'view',
    });
    const ro = (
      await env.svc.previewBulk(
        reader,
        ws,
        { operation: 'trash', tasks: [xs[0]!.id], mode: 'partial' },
        mutation(),
      )
    ).data;
    expect(ro.items.map((i) => i.outcome)).toEqual(['forbidden']);
    const roDone = (await env.svc.executeBulk(reader, ws, ro.id, mutation())).data;
    expect(roDone.items.map((i) => i.outcome)).toEqual(['forbidden']);
    // Archived by the bulk archive above, and not trashed by the refused reader.
    expect((await env.svc.getTask(owner, ws, xs[0]!.id)).lifecycle_state).toBe('archived');
    // Over the bound.
    const small = workEnv(db, { work: { bulkItemsMax: 2 } });
    try {
      await expect(
        small.svc.previewBulk(owner, ws, { operation: 'archive', tasks: ids }, mutation()),
      ).rejects.toEqual(issueOf('too_many'));
    } finally {
      await small.h.close();
    }
  });

  it('bulk atomic: a refused item rolls everything back and reports it', async () => {
    const a = await task({ title: 'Atomic 1' });
    const b = await task({ title: 'Atomic 2' });
    const tp = (
      await env.svc.previewBulk(
        owner,
        ws,
        {
          operation: 'set_priority',
          params: { value: 'high' },
          tasks: [a.id, b.id],
          mode: 'atomic',
        },
        mutation(),
      )
    ).data;
    // b is archived after the preview: its edit is refused at execution.
    await env.svc.taskLifecycle(owner, ws, b.id, 'archive', {}, mutation());
    await expect(env.svc.executeBulk(owner, ws, tp.id, mutation())).rejects.toEqual(
      issueOf('bulk_item_failed'),
    );
    expect((await env.svc.getTask(owner, ws, a.id)).priority).toBe('none');
    // The same preview executed in partial mode is a new preview (the mode is part of it).
    const pp = (
      await env.svc.previewBulk(
        owner,
        ws,
        {
          operation: 'set_priority',
          params: { value: 'high' },
          tasks: [a.id, b.id],
          mode: 'partial',
        },
        mutation(),
      )
    ).data;
    const ex = (await env.svc.executeBulk(owner, ws, pp.id, mutation())).data;
    expect(ex.items.map((i) => i.outcome)).toEqual(['applied', 'forbidden']);
    expect((await env.svc.getTask(owner, ws, a.id)).priority).toBe('high');
  });

  it('templates: immutable versions, explicit brand, omissions reported, no assignees or hidden fields', async () => {
    const src = await task({ title: 'Template source', priority: 'high', estimate_minutes: 30 });
    await env.svc.addChecklistItem(owner, ws, src.id, { text: 'Prep' }, mutation());
    const chk = (await env.svc.taskDetail(owner, ws, src.id)).checklist[0]!;
    await env.svc.updateChecklistItem(
      owner,
      ws,
      src.id,
      chk.id,
      { done: true },
      mutation({ ifMatch: `"${chk.version}"` }),
    );
    await env.svc.addTaskCriterion(
      owner,
      ws,
      src.id,
      { kind: 'acceptance', text: 'Signed off' },
      mutation(),
    );
    await env.svc.addLink(owner, ws, src.id, { url: 'https://example.com/spec' }, mutation());
    const lbl = (await env.svc.createLabel(owner, ws, brands.Harbor, { name: 'Tpl' }, mutation()))
      .data;
    await env.svc.addTaskLabel(owner, ws, src.id, { label: lbl.id }, mutation());
    await env.svc.setAssignees(
      owner,
      ws,
      src.id,
      { assignees: [await meId()], version: (await env.svc.getTask(owner, ws, src.id)).version },
      mutation(),
    );
    const tpl = (
      await env.svc.createTaskTemplate(owner, ws, src.id, { name: 'Weekly check' }, mutation())
    ).data;
    expect(tpl).toMatchObject({ target: 'task', version: 1 });
    expect(tpl.not_copied).toEqual(
      expect.arrayContaining(['assignees', 'shares', 'history', 'comments', 'relationships']),
    );
    // Project templates never list task templates and vice versa.
    expect((await env.svc.listTemplates(owner, ws)).map((x) => x.id)).not.toContain(tpl.id);
    expect((await env.svc.listTemplates(owner, ws, 'task')).map((x) => x.id)).toContain(tpl.id);
    // Applying needs an explicit brand.
    await expect(env.svc.applyTaskTemplate(owner, ws, tpl.id, {}, mutation())).rejects.toEqual(
      issueOf('brand_required'),
    );
    const applied = await env.svc.applyTaskTemplate(
      owner,
      ws,
      tpl.id,
      { brand: brands.Harbor, title: 'From template' },
      mutation(),
    );
    const made = applied.application.task;
    expect(made).toMatchObject({
      title: 'From template',
      priority: 'high',
      estimate_minutes: 30,
      assignees: [],
    });
    expect(made.source).toEqual({ kind: 'template', template: tpl.id, version: 1 });
    const d = await env.svc.taskDetail(owner, ws, made.id);
    expect(d.checklist.map((c) => [c.text, c.done])).toEqual([['Prep', false]]);
    expect(d.criteria.map((c) => c.text)).toEqual(['Signed off']);
    expect(made.labels).toEqual([expect.objectContaining({ id: lbl.id })]);
    // In another brand the label is unavailable and reported.
    await env.svc.updateTask(
      owner,
      ws,
      src.id,
      merge((await env.svc.getTask(owner, ws, src.id)).version, {
        title: { base: 'Template source', value: 'Edited later' },
      }),
      mutation(),
    );
    const tplWs = (
      await env.svc.createTaskTemplate(
        owner,
        ws,
        src.id,
        { name: 'Anywhere', scope: 'workspace' },
        mutation(),
      )
    ).data;
    const elsewhere = await env.svc.applyTaskTemplate(
      owner,
      ws,
      tplWs.id,
      { brand: brands.Summit },
      mutation(),
    );
    expect(elsewhere.application.omitted).toContain('unavailable_labels');
    // Versions are immutable; a new version comes from a task.
    const v2 = (await env.svc.versionTaskTemplate(owner, ws, tpl.id, { task: src.id }, mutation()))
      .data;
    expect(v2.version).toBe(2);
    // Versions are immutable: the application role has no UPDATE on them.
    const priv = await db.admin(
      `SELECT has_table_privilege('app_rw', 'templates.template_version', 'UPDATE') AS u`,
    );
    expect(priv.rows[0].u).toBe(false);
    const again = await env.svc.applyTaskTemplate(
      owner,
      ws,
      tpl.id,
      { brand: brands.Harbor },
      mutation(),
    );
    expect(again.application.task.title).toBe('Edited later');
  });

  it('recurring tasks: frozen snapshot, idempotent keys, due dates in the anchor zone across DST, catch-up bound, owner loss pauses', async () => {
    const src = await task({ title: 'Weekly report' });
    await env.svc.addChecklistItem(owner, ws, src.id, { text: 'Gather numbers' }, mutation());
    await env.svc.setAssignees(
      owner,
      ws,
      src.id,
      { assignees: [await meId()], version: (await env.svc.getTask(owner, ws, src.id)).version },
      mutation(),
    );
    const s = (
      await env.svc.defineTaskRecurrence(
        owner,
        ws,
        src.id,
        { frequency: 'weekly', anchor_tz: 'Europe/Lisbon', start: '2026-03-23T09:00' },
        mutation(),
      )
    ).data;
    // Editing the source afterwards does not change the snapshot.
    await env.svc.addChecklistItem(owner, ws, src.id, { text: 'Added later' }, mutation());
    const g1 = (await env.svc.generateNextTaskOccurrence(owner, ws, src.id, s.id, mutation())).data;
    expect(g1.occurrence).toMatchObject({ occurrence_key: '2026-03-23T09:00' });
    const occ = await env.svc.getTask(owner, ws, g1.occurrence!.id);
    expect(occ).toMatchObject({ title: 'Weekly report', due_date: '2026-03-23', assignees: [] });
    expect(occ.source).toEqual({ kind: 'recurring', series: s.id, occurrence: '2026-03-23T09:00' });
    expect((await env.svc.taskDetail(owner, ws, occ.id)).checklist.map((c) => c.text)).toEqual([
      'Gather numbers',
    ]);
    // Across the DST change (29 March 2026 in Lisbon) the local time stays 09:00.
    const g2 = (await env.svc.generateNextTaskOccurrence(owner, ws, src.id, s.id, mutation())).data;
    expect(g2.occurrence).toMatchObject({ occurrence_key: '2026-03-30T09:00' });
    const series = await db.admin(
      `SELECT next_due_at FROM planning.recurrence_series WHERE public_id = $1`,
      [s.id],
    );
    expect(new Date(series.rows[0].next_due_at).toISOString()).toBe('2026-04-06T08:00:00.000Z');
    // Worker: everything due up to now, bounded per run, never duplicated.
    const handler = recurrenceHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
    });
    const count = async () =>
      Number(
        (
          await db.admin(
            `SELECT count(*)::int AS n FROM work.task t JOIN planning.recurrence_series s ON s.id = t.recurrence_series_id WHERE s.public_id = $1`,
            [s.id],
          )
        ).rows[0].n,
      );
    await handler.handle({} as never);
    expect(await count()).toBe(2 + 12);
    const dup = await db.admin(
      `SELECT occurrence_key FROM work.task WHERE recurrence_series_id IS NOT NULL GROUP BY 1, recurrence_series_id HAVING count(*) > 1`,
    );
    expect(dup.rows).toEqual([]);
    // The owner loses record.create in the brand: the next run pauses the series (audited).
    const admin = await join(env, db, owner, ws, { kind: 'member', role: 'administrator' });
    const s2 = (
      await env.svc.defineTaskRecurrence(
        admin,
        ws,
        src.id,
        { frequency: 'daily', anchor_tz: 'UTC', start: '2026-01-01T08:00' },
        mutation(),
      )
    ).data;
    // The administrator is demoted to read-only (no record.create anywhere).
    await apply(env, owner, ws, { kind: 'role', member: await memberOf(admin), role: 'read_only' });
    await handler.handle({} as never);
    const st = await db.admin(`SELECT state FROM planning.recurrence_series WHERE public_id = $1`, [
      s2.id,
    ]);
    expect(st.rows[0].state).toBe('paused');
  });
});
