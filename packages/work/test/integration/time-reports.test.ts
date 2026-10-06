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
const RANGE = { from: '2026-09-07', to: '2026-09-20' };

/**
 * Phase 3D planned versus actual, remaining effort, and exports on real PostgreSQL (ADR-0019
 * T13–T16; TIME-003, TIME-005, TIME-006, TIME-011, TIME-014, PRJ-022): every total uses the
 * viewer's own predicate, hidden work is never named or counted, planned and actual say which
 * measure they use, and exports are bounded, neutralized, and audited.
 */
describe('planned versus actual, remaining effort, and exports (3D)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let viewer: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const t: Record<string, string> = {};
  let launch: string;
  let quiet: string;

  const log = (target: string, day: string, minutes: number, extra = {}) =>
    env.svc.createEntry(
      owner,
      ws,
      { target, work_date: day, duration_minutes: minutes, ...extra },
      mutation(),
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db, { work: { timeExportRowsMax: 20, timeReportRowsMax: 3 } });
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    launch = (
      await env.svc.createProject(
        owner,
        ws,
        { brand: brands.Harbor, name: 'Launch', time_budget_minutes: 600 },
        mutation(),
      )
    ).data.id;
    const task = async (key: string, body: Record<string, unknown>) =>
      (t[key] = (await env.svc.createTask(owner, ws, body, mutation())).data.id);
    await task('a', { project: launch, title: 'A', estimate_minutes: 120, due_date: '2026-09-10' });
    await task('b', {
      project: launch,
      title: 'B',
      estimate_minutes: 60,
      remaining_estimate_minutes: 30,
      due_date: '2026-09-16',
    });
    await task('c', { brand: brands.Summit, title: 'C', estimate_minutes: 90 });
    await task('d', { project: launch, title: 'D' });
    await task('done', { project: launch, title: 'Done', estimate_minutes: 500 });
    quiet = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Quiet' }, mutation())
    ).data.id;
    await task('q', {
      project: quiet,
      title: 'Quiet task',
      estimate_minutes: 300,
      due_date: '2026-09-09',
    });
    await log(t.a!, '2026-09-08', 90, { billable: true });
    await log(t.a!, '2026-09-15', 15);
    await log(t.b!, '2026-09-09', 50, { billable: true });
    await log(t.c!, '2026-09-10', 45);
    await log(launch, '2026-09-11', 30, { note: '=HYPERLINK("http://x")' });
    await log(t.q!, '2026-09-09', 200, { billable: true });
    await log(t.done!, '2026-09-12', 10);
    await env.svc.completeTask(owner, ws, t.done!, {}, mutation());
    await env.svc.setAccess(owner, ws, quiet, { access_mode: 'restricted' }, mutation());
    await apply(env, owner, ws, {
      kind: 'project_grant',
      project: quiet,
      principal: (await membershipOf(db, wsId, owner.auth.account.id))!.public_id,
      level: 'manage',
    });
    viewer = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: (await membershipOf(db, wsId, viewer.auth.account.id))!.public_id,
      level: 'view',
    });
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('reports planned versus actual by brand with billable split and exact totals', async () => {
    const r = await env.svc.timeReport(owner, ws, { ...RANGE, group: 'brand' });
    expect(r.planned_measure).toBe('task_estimate');
    const byName = Object.fromEntries(r.rows.map((x) => [x.key.label, x]));
    // Harbor actual: A 105 + B 50 + Launch 30 + Quiet 200 + Done 10 = 395 min.
    expect(byName.Harbor).toMatchObject({
      actual_seconds: 395 * 60,
      billable_seconds: 340 * 60,
      non_billable_seconds: 55 * 60,
      // Planned: A 120 + B 60 + Quiet 300 + Done 500 (tasks due in range or with time in it).
      planned_minutes: 980,
      estimated_tasks: 4,
      entries: 6,
      key: { type: 'brand', id: brands.Harbor },
    });
    expect(byName.Summit).toMatchObject({ actual_seconds: 2700, planned_minutes: 90 });
    expect(r.totals).toMatchObject({ actual_seconds: 440 * 60, entries: 7, actual_hours: 7.33 });
    const billable = await env.svc.timeReport(owner, ws, {
      ...RANGE,
      group: 'brand',
      billable: 'billable',
    });
    expect(billable.totals.actual_seconds).toBe(340 * 60);
  });

  it('never names or counts work the viewer cannot read', async () => {
    const r = await env.svc.timeReport(viewer, ws, { ...RANGE, group: 'project' });
    expect(JSON.stringify(r)).not.toMatch(/Quiet|Summit/);
    const launchRow = r.rows.find((x) => x.key.id === launch)!;
    expect(launchRow).toMatchObject({
      actual_seconds: (105 + 50 + 30 + 10) * 60,
      budget_minutes: 600,
    });
    expect(r.totals.actual_seconds).toBe(195 * 60);
    const owners = await env.svc.timeReport(owner, ws, { ...RANGE, group: 'project' });
    expect(owners.rows.map((x) => x.key.label)).toEqual(
      expect.arrayContaining(['Launch', 'Quiet', 'No project']),
    );
    const tasks = await env.svc.timeReport(viewer, ws, { ...RANGE, group: 'task' });
    // Four readable task rows (A, B, Done, project-level time), bounded to the three largest here.
    expect(tasks.rows.map((x) => x.key.label).sort()).toEqual(['A', 'B', 'Project-level time']);
    expect(tasks.truncated).toBe(true);
    expect(tasks.totals.actual_seconds).toBe(195 * 60);
  });

  it('groups by member and by calendar period, and bounds rows and ranges', async () => {
    const m = await env.svc.timeReport(owner, ws, { ...RANGE, group: 'member' });
    // Actual time is the person's; planned effort belongs to each task's primary assignee, and
    // nobody is assigned here, so the estimates sit in an Unassigned row.
    expect(m.rows.map((x) => [x.key.label, x.actual_seconds, x.planned_minutes])).toEqual([
      ['Synthetic Person', 440 * 60, null],
      ['Unassigned', 0, 980 + 90],
    ]);
    const weeks = await env.svc.timeReport(owner, ws, { ...RANGE, group: 'week' });
    expect(weeks.planned_measure).toBe('task_estimate_by_due_date');
    expect(weeks.rows.map((x) => [x.key.label, x.actual_seconds, x.planned_minutes])).toEqual([
      ['2026-09-07', (90 + 50 + 45 + 30 + 200 + 10) * 60, 120 + 300],
      ['2026-09-14', 15 * 60, 60],
    ]);
    const days = await env.svc.timeReport(owner, ws, { ...RANGE, group: 'day' });
    expect(days.rows.length).toBe(3); // bounded by TIME_REPORT_ROWS_MAX = 3 in this suite
    expect(days.truncated).toBe(true);
    expect(days.totals.actual_seconds).toBe(440 * 60); // totals always cover every row
    await expect(
      env.svc.timeReport(owner, ws, { from: '2020-01-01', to: '2026-01-01' }),
    ).rejects.toEqual(issueOf('too_wide'));
    await expect(env.svc.timeReport(owner, ws, { ...RANGE, group: 'nope' })).rejects.toEqual(
      issueOf('invalid'),
    );
  });

  it('summarises a task and a project: planned, actual, and remaining effort', async () => {
    const a = await env.svc.workSummary(owner, ws, t.a);
    expect(a).toMatchObject({
      planned: { estimate_minutes: 120, remaining_estimate_minutes: null },
      actual: { seconds: 105 * 60, billable_seconds: 90 * 60, mine_seconds: 105 * 60 },
      remaining: { minutes: 15, open_tasks: 1, unestimated_open_tasks: 0 },
    });
    const b = await env.svc.workSummary(owner, ws, t.b);
    expect(b.remaining.minutes).toBe(30); // the remaining estimate wins over estimate − actual
    const p = await env.svc.workSummary(owner, ws, launch);
    expect(p).toMatchObject({
      planned: { budget_minutes: 600, task_estimate_minutes: 680, estimated_tasks: 3, tasks: 4 },
      // A, B, Done, and project-level time.
      actual: { seconds: (105 + 50 + 10 + 30) * 60 },
      // Open tasks: A (15) + B (30) + D (unestimated); Done is excluded.
      remaining: { minutes: 45, open_tasks: 3, unestimated_open_tasks: 1 },
    });
    await expect(env.svc.workSummary(viewer, ws, quiet)).rejects.toEqual(reason('not_found'));
    await expect(env.svc.workSummary(viewer, ws, t.q)).rejects.toEqual(reason('not_found'));
  });

  it('exports readable entries as CSV or JSON, neutralizes formulas, bounds rows, and audits', async () => {
    const csv = await env.svc.exportTime(owner, ws, { ...RANGE });
    const lines = csv.body.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Entry ID,Date,Time zone,Start (UTC),End (UTC),Seconds,Hours,Billable,Brand,Project,Task,Person,Status,Source,Note',
    );
    expect(lines).toHaveLength(8);
    expect(csv.body).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv.body).toContain(',1.50,yes,Harbor,Launch,A,');
    const json = JSON.parse(
      (await env.svc.exportTime(viewer, ws, { ...RANGE, format: 'json' })).body,
    );
    expect(json.rounding).toBe('half_up_0.01h');
    expect(json.data.map((d: { task: string | null }) => d.task).sort()).toEqual([
      'A',
      'A',
      'B',
      'Done',
      null,
    ]);
    expect(JSON.stringify(json)).not.toMatch(/Quiet|Summit/);
    for (let i = 0; i < 14; i++) await log(t.c!, '2026-09-19', 5 + i);
    await expect(env.svc.exportTime(owner, ws, { ...RANGE })).rejects.toEqual(issueOf('too_many'));
    await expect(env.svc.exportTime(owner, ws, { ...RANGE, format: 'xml' })).rejects.toEqual(
      issueOf('invalid'),
    );
    const audit = await db.admin(
      `SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'time.exported' AND workspace_id = $1`,
      [wsId],
    );
    expect(audit.rows[0].n).toBe(2);
    const sec = await db.admin(
      `SELECT count(*)::int AS n FROM audit.security_event WHERE action = 'time.export'`,
    );
    expect(sec.rows[0].n).toBe(2);
  });
});
