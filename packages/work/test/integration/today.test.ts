import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { addDays, dayCloseHandler, generateSeries, localDay } from '@pm/work';
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
const ifMatch = (v: number) => mutation({ ifMatch: `"${v}"` });

/**
 * Phase 3C Today and manual planning on real PostgreSQL (ADR-0021; OD-18): Today in the viewer's
 * zone with commitments, scheduled blocks, and separate overdue, due-today, and upcoming-deadline
 * sections (3A queries, viewer predicate); commitments and blocks never change task dates; manual
 * order and locks; focus protection, preparation and buffer time, blocks from estimates, deadline
 * warnings; recurring blocks across DST, generated once; shutdown with carry, pick a day, return,
 * and leave; append-only daily records and the day-close job; isolation, revocation, concurrency.
 */
describe('Today and manual planning (3C)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let wsId: string;
  let me: string;
  let brands: Record<string, string>;
  let today: string;
  const t: Record<string, string> = {};

  const task = async (key: string, body: Record<string, unknown>, assign = true) => {
    const created = (
      await env.svc.createTask(owner, ws, { brand: brands.Harbor, ...body }, mutation())
    ).data;
    if (assign)
      await env.svc.setAssignees(
        owner,
        ws,
        created.id,
        { assignees: [me], version: created.version },
        mutation(),
      );
    t[key] = created.id;
    return created.id;
  };
  const view = (day = today, as: Caller = owner) => env.svc.todayView(as, ws, day);
  const commit = (taskId: string, day = today, as: Caller = owner) =>
    env.svc.commit(as, ws, day, { task: taskId }, mutation()).then((r) => r.data);
  const block = (body: Record<string, unknown>, as: Caller = owner) =>
    env.svc.createBlock(as, ws, { tz: 'UTC', ...body }, mutation()).then((r) => r.data);
  const at = (day: string, hhmm: string) => `${day}T${hhmm}:00Z`;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    me = (await membershipOf(db, wsId, owner.auth.account.id))!.public_id;
    today = localDay(new Date(), 'UTC'); // seeded accounts use UTC (the viewer's zone, OD-18)
    await task('late', {
      title: 'Late report',
      due_date: addDays(today, -2),
      estimate_minutes: 30,
    });
    await task('dueNow', { title: 'Due now', due_date: today, estimate_minutes: 60 });
    await task('deadline', {
      title: 'Ship it',
      due_date: addDays(today, 5),
      deadline: { date: addDays(today, 3) },
      estimate_minutes: 120,
      remaining_estimate_minutes: 90,
    });
    await task('plain', { title: 'Plain task' });
    await task('other', { title: 'Someone else', due_date: addDays(today, -1) }, false);
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('shows Today in the viewer zone with separate overdue, due-today, and deadline sections', async () => {
    const v = await view('today');
    expect(v).toMatchObject({ day: today, tz: 'UTC', closed: false, can_shutdown: true });
    expect(v.overdue.items.map((i) => i.title)).toEqual(['Late report']);
    expect(v.due_today.items.map((i) => i.title)).toEqual(['Due now']);
    expect(v.upcoming_deadlines.items.map((i) => i.title)).toEqual(['Ship it']);
    expect(v.committed).toEqual([]);
    // Capacity needs working hours first (3E); meetings need a connected calendar (6C).
    expect(v).toMatchObject({
      available_minutes: null,
      capacity: { available: false, reason: 'no_working_hours' },
      meetings: { available: false, reason: 'not_connected' },
    });
  });

  it('commits tasks without changing any date, keeps manual order, and respects locks', async () => {
    const before = await env.svc.getTask(owner, ws, t.late);
    const c1 = await commit(t.late!);
    const c2 = await commit(t.deadline!);
    const c3 = await commit(t.plain!);
    expect(c1).toMatchObject({ day: today, outcome: 'open', locked: false, source: 'manual' });
    const after = await env.svc.getTask(owner, ws, t.late);
    expect(after).toMatchObject({
      due_date: before.due_date,
      deadline: before.deadline,
      version: before.version,
    });
    let v = await view();
    expect(v.committed.map((c) => c.task.title)).toEqual(['Late report', 'Ship it', 'Plain task']);
    expect(v.overdue.items[0]).toMatchObject({ title: 'Late report', committed: true });
    expect(v.totals).toMatchObject({ committed: 3, estimate_minutes: 30 + 90, unestimated: 1 });
    // Reorder: Plain task to the top, then lock it.
    await env.svc.updateCommitment(owner, ws, today, t.plain, { after: null }, ifMatch(c3.version));
    v = await view();
    expect(v.committed.map((c) => c.task.title)).toEqual(['Plain task', 'Late report', 'Ship it']);
    const plain = v.committed[0]!;
    await env.svc.updateCommitment(
      owner,
      ws,
      today,
      t.plain,
      { locked: true },
      ifMatch(plain.version),
    );
    const locked = (await view()).committed[0]!;
    for (const body of [{ after: t.deadline }, { move_to: addDays(today, 1) }])
      await expect(
        env.svc.updateCommitment(owner, ws, today, t.plain, body, ifMatch(locked.version)),
      ).rejects.toEqual(issueOf('locked'));
    await expect(
      env.svc.uncommit(owner, ws, today, t.plain, ifMatch(locked.version)),
    ).rejects.toEqual(issueOf('locked'));
    await expect(
      env.svc.updateCommitment(owner, ws, today, t.late, { after: null }, ifMatch(c1.version + 7)),
    ).rejects.toEqual(reason('conflict'));
    // Refusals: the past, twice, unreadable or unknown tasks.
    await expect(commit(t.dueNow!, addDays(today, -1))).rejects.toEqual(issueOf('past_day'));
    await expect(commit(t.late!)).rejects.toEqual(issueOf('already_committed'));
    await expect(commit('tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV')).rejects.toEqual(reason('not_found'));
    expect(c2.task.title).toBe('Ship it');
  });

  it('reschedules a commitment to a later day with an audit, never touching the task', async () => {
    const c = await commit(t.dueNow!);
    const moved = (
      await env.svc.updateCommitment(
        owner,
        ws,
        today,
        t.dueNow,
        { move_to: addDays(today, 2) },
        ifMatch(c.version),
      )
    ).data;
    expect(moved).toMatchObject({ day: addDays(today, 2), source: 'carry', outcome: 'open' });
    const old = (await view()).committed.find((x) => x.task.id === t.dueNow)!;
    expect(old).toMatchObject({ outcome: 'carried', carried_to: addDays(today, 2) });
    expect((await env.svc.getTask(owner, ws, t.dueNow)).due_date).toBe(today);
    const audit = await db.admin(
      `SELECT action FROM audit.audit_event WHERE action LIKE 'today.%' AND workspace_id = $1 ORDER BY occurred_at`,
      [wsId],
    );
    expect(audit.rows.map((a) => a.action)).toContain('today.rescheduled');
  });

  it('schedules blocks distinct from dates: focus protection, buffers, estimates, and warnings', async () => {
    const day = addDays(today, 7);
    const focus = await block({
      task: t.deadline,
      starts_at: at(day, '09:00'),
      ends_at: at(day, '11:00'),
      focus: true,
      buffer_minutes: 15,
    });
    expect(focus).toMatchObject({
      focus: true,
      minutes: 120,
      buffer_minutes: 15,
      task: { id: t.deadline },
      warnings: ['after_due_date', 'after_deadline'],
    });
    // Nothing overlaps a focus block, including its buffer (service, then the database guard).
    await expect(
      block({ title: 'Call', starts_at: at(day, '11:10'), duration_minutes: 30 }),
    ).rejects.toEqual(issueOf('focus_protected'));
    await expect(
      block({ title: 'Call', starts_at: at(day, '08:30'), duration_minutes: 45 }),
    ).rejects.toEqual(issueOf('focus_protected'));
    const call = await block({
      title: 'Call',
      starts_at: at(day, '11:15'),
      duration_minutes: 30,
      prep_minutes: 0,
    });
    await expect(
      db.admin(`UPDATE planning.work_block SET starts_at = $2::timestamptz WHERE public_id = $1`, [
        call.id,
        at(day, '10:00'),
      ]),
    ).rejects.toThrow(/focus_protected/);
    // Non-focus blocks may overlap each other.
    await block({ title: 'Overlap ok', starts_at: at(day, '11:20'), duration_minutes: 10 });
    // Moving a block never changes the task's dates; warnings are reported instead.
    const before = await env.svc.getTask(owner, ws, t.deadline);
    const moved = (
      await env.svc.updateBlock(
        owner,
        ws,
        focus.id,
        { starts_at: at(addDays(today, 1), '09:00'), duration_minutes: 60 },
        ifMatch(focus.version),
      )
    ).data;
    expect(moved.warnings).toEqual([]);
    const afterTask = await env.svc.getTask(owner, ws, t.deadline);
    expect(afterTask).toMatchObject({
      due_date: before.due_date,
      deadline: before.deadline,
      version: before.version,
    });
    // Locked blocks only accept unlocking.
    const locked = (
      await env.svc.updateBlock(owner, ws, call.id, { locked: true }, ifMatch(call.version))
    ).data;
    await expect(
      env.svc.updateBlock(
        owner,
        ws,
        call.id,
        { starts_at: at(day, '15:00') },
        ifMatch(locked.version),
      ),
    ).rejects.toEqual(issueOf('locked'));
    await expect(env.svc.deleteBlock(owner, ws, call.id, ifMatch(locked.version))).rejects.toEqual(
      issueOf('locked'),
    );
    const unlocked = (
      await env.svc.updateBlock(owner, ws, call.id, { locked: false }, ifMatch(locked.version))
    ).data;
    await env.svc.deleteBlock(owner, ws, call.id, ifMatch(unlocked.version));
    // A focus block from the estimate: the remaining estimate wins.
    const est = (
      await env.svc.blockFromEstimate(
        owner,
        ws,
        { task: t.deadline, starts_at: at(addDays(today, 8), '13:00'), tz: 'UTC' },
        mutation(),
      )
    ).data;
    expect(est).toMatchObject({ focus: true, minutes: 90, source: 'estimate' });
    await expect(
      env.svc.blockFromEstimate(
        owner,
        ws,
        { task: t.plain, starts_at: at(addDays(today, 8), '16:00') },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('no_estimate'));
    const list = await env.svc.listBlocks(owner, ws, { from: today, to: addDays(today, 8) });
    expect(list.data.length).toBeGreaterThanOrEqual(3);
    await expect(
      env.svc.listBlocks(owner, ws, { from: today, to: addDays(today, 100) }),
    ).rejects.toEqual(issueOf('too_wide'));
  });

  it('measures days and blocks in local time across daylight saving', async () => {
    // A Lisbon day that falls back is 25 hours; a block entered there keeps its zone.
    const b = (
      await env.svc.createBlock(
        owner,
        ws,
        {
          title: 'Night shift',
          starts_at: '2025-10-26T00:30:00+01:00',
          ends_at: '2025-10-26T02:30:00Z',
          tz: 'Europe/Lisbon',
        },
        mutation(),
      )
    ).data;
    expect(b).toMatchObject({ minutes: 180, source_tz: 'Europe/Lisbon' });
    const { dayBounds } = await import('@pm/work');
    const lisbon = dayBounds('2025-10-26', 'Europe/Lisbon');
    expect((lisbon.end.getTime() - lisbon.start.getTime()) / 3_600_000).toBe(25);
    const berlin = dayBounds('2026-03-29', 'Europe/Berlin');
    expect((berlin.end.getTime() - berlin.start.getTime()) / 3_600_000).toBe(23);
  });

  it('generates recurring blocks at a stable local time across DST, once, and skips focus clashes', async () => {
    const s = (
      await env.svc.createSeries(
        owner,
        ws,
        {
          title: 'Deep work',
          rule: {
            frequency: 'weekly',
            interval: 1,
            weekdays: ['MO'],
            ends: { type: 'after', count: 4 },
          },
          start_date: '2026-10-19',
          start_time: '09:00',
          duration_minutes: 90,
          tz: 'Europe/Lisbon',
          focus: true,
        },
        mutation(),
      )
    ).data;
    expect(s).toMatchObject({ type: 'block_series', skipped: 0 });
    // The worker extends the series as its horizon moves (here: a fixed later clock).
    const sid = (
      await db.admin(`SELECT id FROM planning.block_series WHERE public_id = $1`, [s.id])
    ).rows[0].id;
    const later = await env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
      generateSeries(tx, sid, new Date('2026-11-05T00:00:00Z'), 28),
    );
    expect(s.generated + later.created).toBe(4);
    const blocks = await env.svc.listBlocks(owner, ws, { from: '2026-10-19', to: '2026-11-09' });
    const mine = blocks.data.filter((x) => x.series === s.id);
    // 09:00 Lisbon is 08:00 UTC before 25 October and 09:00 UTC after.
    expect(mine.map((x) => x.starts_at)).toEqual([
      '2026-10-19T08:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
      '2026-11-09T09:00:00.000Z',
    ]);
    // A retried generation creates nothing (and the counted series has ended).
    const again = await env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      generateSeries(tx, sid, new Date(), 400),
    );
    expect(again).toEqual({ created: 0, skipped: 0 });
    // A series over an existing focus block skips that occurrence.
    const clash = (
      await env.svc.createSeries(
        owner,
        ws,
        {
          title: 'Standup',
          rule: { frequency: 'weekly', weekdays: ['MO'], ends: { type: 'after', count: 2 } },
          start_date: '2026-10-19',
          start_time: '09:30',
          duration_minutes: 15,
          tz: 'Europe/Lisbon',
        },
        mutation(),
      )
    ).data;
    expect(clash).toMatchObject({ generated: 0, skipped: 2 });
    await expect(
      env.svc.createSeries(
        owner,
        ws,
        {
          title: 'x',
          rule: { frequency: 'hourly' },
          start_date: today,
          start_time: '09:00',
          duration_minutes: 30,
        },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('invalid'));
    // A counted series ends by itself once every occurrence exists; an open one is ended by hand,
    // removing future occurrences nobody changed or locked.
    expect((await env.svc.listSeries(owner, ws)).data.find((x) => x.id === clash.id)!.state).toBe(
      'ended',
    );
    const open = (
      await env.svc.createSeries(
        owner,
        ws,
        {
          title: 'Review',
          rule: { frequency: 'daily' },
          start_date: addDays(today, 1),
          start_time: '17:00',
          duration_minutes: 30,
          tz: 'UTC',
        },
        mutation(),
      )
    ).data;
    expect(open.generated).toBeGreaterThan(0);
    const ended = (await env.svc.endSeries(owner, ws, open.id, ifMatch(open.version))).data;
    expect(ended.state).toBe('ended');
    const left = await db.admin(
      `SELECT count(*)::int AS n FROM planning.work_block w JOIN planning.block_series s ON s.id = w.series_id WHERE s.public_id = $1`,
      [open.id],
    );
    expect(left.rows[0].n).toBe(0);
  });

  it('shuts down a day: carry, pick a day, return, leave; done is recorded; locked only stays', async () => {
    const day = addDays(today, 3);
    const extra = await task('extra', { title: 'Extra' });
    await env.svc.commit(
      owner,
      ws,
      day,
      { tasks: [t.late, t.plain, extra, t.deadline] },
      mutation(),
    );
    // The future cannot be shut down.
    await expect(env.svc.shutdown(owner, ws, day, {}, mutation())).rejects.toEqual(
      issueOf('future_day'),
    );
    // Shut down today instead: the locked Plain task can only be left.
    const v = await view();
    await expect(
      env.svc.shutdown(
        owner,
        ws,
        today,
        { items: [{ task: t.plain, action: 'carry' }] },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('locked'));
    await env.svc.completeTask(owner, ws, t.deadline!, {}, mutation());
    const r = (
      await env.svc.shutdown(
        owner,
        ws,
        today,
        {
          items: [
            { task: t.late, action: 'pick_day', day: addDays(today, 4) },
            { task: t.plain, action: 'leave' },
          ],
        },
        mutation(),
      )
    ).data;
    expect(v.committed.length).toBe(4);
    expect(r).toMatchObject({
      closed_by: 'shutdown',
      committed: 4,
      completed: 1,
      carried: 2,
      dropped: 1,
      returned: 0,
    });
    expect(r.items.map((i) => i.outcome).sort()).toEqual(['carried', 'carried', 'done', 'dropped']);
    expect((await view(addDays(today, 4))).committed.map((c) => [c.task.title, c.source])).toEqual([
      ['Late report', 'carry'],
    ]);
    // The day is final: no second shutdown, no new commitments, and the record never changes.
    await expect(env.svc.shutdown(owner, ws, today, {}, mutation())).rejects.toEqual(
      issueOf('day_closed'),
    );
    await expect(commit(extra, today)).rejects.toEqual(issueOf('day_closed'));
    await expect(
      db.admin(`UPDATE planning.daily_record SET completed = 0 WHERE workspace_id = $1`, [wsId]),
    ).rejects.toThrow(/never rewritten/);
    expect((await env.svc.getTask(owner, ws, t.late)).due_date).toBe(addDays(today, -2));
    const records = await env.svc.dailyRecords(owner, ws, {});
    expect(records.records.map((x) => x.day)).toEqual([today]);
  });

  it('closes ended days automatically, once, with done and dropped outcomes', async () => {
    const yesterday = addDays(today, -1);
    const memId = (await db.admin(`SELECT id FROM tenancy.membership WHERE public_id = $1`, [me]))
      .rows[0].id;
    for (const [i, key] of (['dueNow', 'extra'] as const).entries())
      await db.admin(
        `INSERT INTO planning.today_commitment (id, workspace_id, owner_membership_id, day, task_id, brand_id, rank)
         SELECT gen_random_uuid(), t.workspace_id, $2::uuid, $3::date, t.id, t.brand_id, $4
           FROM work.task t JOIN core.record r ON r.id = t.id WHERE r.public_id = $1`,
        [t[key], memId, yesterday, `a${i}`],
      );
    await env.svc.completeTask(owner, ws, t.extra!, {}, mutation());
    const deps = {
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
    };
    await dayCloseHandler(deps).handle({} as never);
    await dayCloseHandler(deps).handle({} as never);
    const rec = await env.svc.dailyRecord(owner, ws, yesterday);
    expect(rec).toMatchObject({ closed_by: 'auto', committed: 2, completed: 1, dropped: 1 });
    const n = await db.admin(
      `SELECT count(*)::int AS n FROM planning.daily_record WHERE day = $1`,
      [yesterday],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('keeps plans personal, omits unreadable work, and survives revocation without leaking it', async () => {
    const mate = await join(env, db, owner, ws, { kind: 'member', role: 'administrator' });
    const blocks = await env.svc.listBlocks(owner, ws, { from: today, to: addDays(today, 8) });
    const mine = blocks.data[0]!;
    await expect(
      env.svc.updateBlock(mate, ws, mine.id, { locked: true }, ifMatch(mine.version)),
    ).rejects.toEqual(reason('not_found'));
    expect(
      (await env.svc.listBlocks(mate, ws, { from: today, to: addDays(today, 8) })).data,
    ).toEqual([]);
    expect((await view(today, mate)).committed).toEqual([]);
    // A member plans a Summit task, then loses access to Summit.
    const member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const memId = (await membershipOf(db, wsId, member.auth.account.id))!.public_id;
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Summit,
      principal: memId,
      level: 'edit',
    });
    const secret = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Summit, title: 'Secret launch' },
        mutation(),
      )
    ).data;
    await env.svc.commit(member, ws, today, { task: secret.id }, mutation());
    await env.svc.createBlock(
      member,
      ws,
      {
        task: secret.id,
        starts_at: at(addDays(today, 1), '14:00'),
        duration_minutes: 60,
        tz: 'UTC',
      },
      mutation(),
    );
    await apply(env, owner, ws, { kind: 'brand_revoke', brand: brands.Summit, principal: memId });
    const v = await view(today, member);
    expect(v.committed).toEqual([]);
    const b = (await env.svc.listBlocks(member, ws, { from: today, to: addDays(today, 2) })).data;
    expect(b).toEqual([expect.objectContaining({ task: null, unavailable: true, title: null })]);
    expect(JSON.stringify([v, b])).not.toContain('Secret');
    await expect(
      env.svc.commit(member, ws, today, { task: secret.id }, mutation()),
    ).rejects.toEqual(reason('not_found'));
  });

  it('serializes concurrent commits of the same task: one wins', async () => {
    const day = addDays(today, 10);
    const results = await Promise.allSettled([1, 2, 3].map(() => commit(t.plain!, day)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toEqual(issueOf('already_committed'));
  });
});
