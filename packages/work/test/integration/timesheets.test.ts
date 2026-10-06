import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@pm/db';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { entriesHash, localDay, periodOf } from '@pm/work';
import {
  apply,
  join,
  membershipOf,
  mutation,
  seedAccount,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  WORKSPACE_INPUT,
  type WorkEnv,
} from './fixture.ts';

const reason = (code: string) => expect.objectContaining({ code });
const issueOf = (code: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });
const ifMatch = (v: number, more: Record<string, unknown> = {}) =>
  mutation({ ifMatch: `"${v}"`, ...more });
const WEEK = '2026-09-07'; // a Monday (WORKSPACE_INPUT week_start = 1)

/**
 * Phase 3D timesheets on real PostgreSQL (ADR-0019 T9–T12; TIME-012, TIME-013, OD-20, OD-26):
 * weekly periods, submission per brand line, editing closed while submitted, withdraw, per-brand
 * approve and reject by people who manage that brand now, evidence that never changes, period
 * locks, admin-only unlock with step-up and a reason that requires re-approval, self-approval only
 * when policy allows it (labelled), approvers who cannot see all of a line cannot decide it,
 * decisions racing withdrawals, task moves blocked by locked time, and purge by the worker only.
 */
describe('timesheets, approvals, and period locks (3D)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let admin: Caller;
  let worker: Caller;
  let approver: Caller;
  let outsider: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let harborTask: string;
  let summitTask: string;
  let hiddenTask: string;
  let quietProject: string;
  const ids: Record<string, string> = {};

  const log = (as: Caller, target: string, day: string, minutes: number, extra = {}) =>
    env.svc
      .createEntry(
        as,
        ws,
        { target, work_date: day, duration_minutes: minutes, ...extra },
        mutation(),
      )
      .then((r) => r.data);
  const period = (as: Caller, date = WEEK) => env.svc.timesheetPeriod(as, ws, { date });
  const submit = (as: Caller, start = WEEK) =>
    env.svc.submitTimesheet(as, ws, { period_start: start }, mutation()).then((r) => r.data);
  const sheet = (as: Caller, id: string) => env.svc.getTimesheet(as, ws, id);
  const decide = (
    as: Caller,
    id: string,
    brand: string,
    decision: 'approve' | 'reject',
    v: number,
    note?: string,
  ) =>
    env.svc
      .decideTimesheet(as, ws, id, { brand, decision, ...(note ? { note } : {}) }, ifMatch(v))
      .then((r) => r.data);

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    admin = await join(env, db, owner, ws, { kind: 'member', role: 'administrator' });
    worker = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    approver = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    outsider = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    for (const [k, c] of Object.entries({ worker, approver, outsider }))
      ids[k] = (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
    const grant = (brand: string, who: string, level: string) =>
      apply(env, owner, ws, { kind: 'brand_grant', brand, principal: ids[who], level });
    await grant(brands.Harbor!, 'worker', 'edit');
    await grant(brands.Summit!, 'worker', 'edit');
    await grant(brands.Harbor!, 'approver', 'manage');
    await grant(brands.Summit!, 'outsider', 'edit');
    harborTask = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Harbor, title: 'Harbor work' },
        mutation(),
      )
    ).data.id;
    summitTask = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Summit, title: 'Summit work' },
        mutation(),
      )
    ).data.id;
    // A restricted Harbor project the worker can reach and the Harbor approver cannot.
    const prj = (
      await env.svc.createProject(
        owner,
        ws,
        { brand: brands.Harbor, name: 'Quiet project' },
        mutation(),
      )
    ).data;
    quietProject = prj.id;
    hiddenTask = (
      await env.svc.createTask(owner, ws, { project: prj.id, title: 'Quiet task' }, mutation())
    ).data.id;
    await env.svc.setAccess(owner, ws, prj.id, { access_mode: 'restricted' }, mutation());
    await apply(env, owner, ws, {
      kind: 'project_grant',
      project: prj.id,
      principal: ids.worker,
      level: 'edit',
    });
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('shows the person’s period with day and brand totals; submission rules', async () => {
    await log(worker, harborTask, '2026-09-07', 120, { billable: true });
    await log(worker, harborTask, '2026-09-08', 60);
    await log(worker, summitTask, '2026-09-09', 90, { billable: true });
    const v = await period(worker, '2026-09-10');
    expect(v.period).toEqual({ start: WEEK, end: '2026-09-13' });
    expect(v.timesheet).toBeNull();
    expect(v.days.map((d) => d.seconds)).toEqual([7200, 3600, 5400, 0, 0, 0, 0]);
    expect(v.totals).toMatchObject({
      seconds: 16200,
      billable_seconds: 12600,
      non_billable_seconds: 3600,
      hours: 4.5,
    });
    expect(v.lines.map((l) => [l.brand.name, l.state]).sort()).toEqual([
      ['Harbor', null],
      ['Summit', null],
    ]);
    expect(v.can_submit).toBe(true);
    await expect(submit(worker, '2026-09-08')).rejects.toEqual(issueOf('not_period_start'));
    await expect(submit(worker, '2026-08-31')).rejects.toEqual(issueOf('nothing_to_submit'));
    // A running timer in the week must be stopped first (this week, in the person's zone: UTC).
    const t = (await env.svc.startTimer(worker, ws, { target: harborTask }, mutation())).data;
    const thisWeek = periodOf(localDay(new Date(), 'UTC'), 1).start;
    await expect(submit(worker, thisWeek)).rejects.toEqual(issueOf('timer_live'));
    const stopped = (await env.svc.timerAction(worker, ws, t.id, 'stop', {}, mutation())).data;
    await env.svc.deleteEntry(worker, ws, t.id, ifMatch(stopped.version));
  });

  it('closes the whole period for the person while submitted; withdraw reopens it', async () => {
    const before = await period(worker);
    const e = before.entries.find((x) => x.work_date === '2026-09-08')!;
    const s = await submit(worker);
    expect(s).toMatchObject({
      type: 'timesheet',
      state: 'submitted',
      own: true,
      period: { start: WEEK },
    });
    expect(s.lines.map((l) => [l.brand.name, l.state, l.submitted?.seconds]).sort()).toEqual([
      [
        'Harbor',
        'pending',
        before.entries
          .filter((x) => x.brand.name === 'Harbor')
          .reduce((a, x) => a + x.duration_seconds, 0),
      ],
      ['Summit', 'pending', 5400],
    ]);
    ids.sheet = s.id;
    for (const attempt of [
      () => env.svc.updateEntry(worker, ws, e.id, { billable: true }, ifMatch(e.version)),
      () => env.svc.deleteEntry(worker, ws, e.id, ifMatch(e.version)),
      () => log(worker, summitTask, '2026-09-11', 15),
    ])
      await expect(attempt()).rejects.toEqual(issueOf('period_submitted'));
    // The database guard repeats the rule for any write path.
    await expect(
      db.admin(`UPDATE timetrack.time_entry SET note = 'x' WHERE public_id = $1`, [e.id]),
    ).rejects.toThrow(/time_submitted/);
    // Other weeks stay open.
    await log(worker, harborTask, '2026-09-14', 10);
    await expect(submit(worker)).rejects.toEqual(issueOf('already_submitted'));
    // Withdraw needs the current version, then the period is editable again.
    await expect(
      env.svc.withdrawTimesheet(worker, ws, s.id, ifMatch(s.version + 5)),
    ).rejects.toEqual(reason('conflict'));
    const w = (await env.svc.withdrawTimesheet(worker, ws, s.id, ifMatch(s.version))).data;
    expect(w.state).toBe('open');
    expect(w.lines.every((l) => l.state === 'withdrawn')).toBe(true);
    await env.svc.updateEntry(worker, ws, e.id, { note: 'fixed' }, ifMatch(e.version));
    const again = await submit(worker);
    expect(again.lines.every((l) => l.state === 'pending')).toBe(true);
  });

  it('lets only people who manage a brand now decide its line, and never their own unless allowed', async () => {
    // The Harbor approver sees exactly the Harbor line; the outsider sees nothing.
    const q = await env.svc.listTimesheetApprovals(approver, ws, {});
    expect(q.data.map((s) => s.id)).toEqual([ids.sheet]);
    expect(q.data[0]!.lines.map((l) => l.brand.name)).toEqual(['Harbor']);
    expect(q.data[0]!.entries.every((x) => x.brand.name === 'Harbor')).toBe(true);
    expect((await env.svc.listTimesheetApprovals(outsider, ws, {})).data).toEqual([]);
    await expect(sheet(outsider, ids.sheet!)).rejects.toEqual(reason('not_found'));
    const s = await sheet(worker, ids.sheet!);
    // Not their brand → not_found; a stale version → conflict; a reject needs a note.
    await expect(decide(approver, s.id, brands.Summit!, 'approve', s.version)).rejects.toEqual(
      reason('not_found'),
    );
    await expect(decide(approver, s.id, brands.Harbor!, 'approve', s.version + 1)).rejects.toEqual(
      reason('conflict'),
    );
    await expect(decide(approver, s.id, brands.Harbor!, 'reject', s.version)).rejects.toEqual(
      issueOf('required'),
    );
    // A worker may not decide their own line in a workspace with other approvers (OD-20 auto).
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Summit!,
      principal: ids.worker,
      level: 'manage',
    });
    await expect(decide(worker, s.id, brands.Summit!, 'approve', s.version)).rejects.toEqual(
      issueOf('self_approval'),
    );
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Summit!,
      principal: ids.worker,
      level: 'edit',
    });
    const approved = await decide(approver, s.id, brands.Harbor!, 'approve', s.version);
    expect(approved.state).toBe('submitted'); // Summit is still pending
    const rejected = await decide(
      admin,
      s.id,
      brands.Summit!,
      'reject',
      approved.version,
      'Split by task',
    );
    expect(rejected.state).toBe('open');
    const mine = await sheet(worker, s.id);
    expect(Object.fromEntries(mine.lines.map((l) => [l.brand.name, l.state]))).toEqual({
      Harbor: 'approved',
      Summit: 'rejected',
    });
    const harbor = mine.lines.find((l) => l.brand.name === 'Harbor')!;
    expect(harbor).toMatchObject({ locked: true });
    expect(harbor.decisions[0]).toMatchObject({
      decision: 'approve',
      self_approval: false,
      by: { id: ids.approver },
    });
    // Evidence: the approval names the exact entries and never changes.
    const row = await db.admin(
      `SELECT entries_hash, total_seconds FROM timetrack.timesheet_approval a JOIN tenancy.brand b ON b.id = a.brand_id
        WHERE a.decision = 'approve' AND b.name = 'Harbor'`,
    );
    const harborEntries = mine.entries.filter((e) => e.brand.name === 'Harbor');
    expect(row.rows[0].entries_hash).toBe(
      entriesHash(
        harborEntries.map((e) => ({
          public_id: e.id,
          duration_seconds: e.duration_seconds,
          billable: e.billable,
          version: e.version,
        })),
      ),
    );
    await expect(
      db.admin(`UPDATE timetrack.timesheet_approval SET total_seconds = 0`),
    ).rejects.toThrow(/append-only/);
    await expect(db.admin(`DELETE FROM timetrack.period_lock`)).rejects.toThrow(/append-only/);
    // Harbor is locked for the worker; Summit (rejected) is editable; resubmitting sends Summit only.
    const h = mine.entries.find((e) => e.brand.name === 'Harbor')!;
    await expect(
      env.svc.updateEntry(worker, ws, h.id, { billable: false }, ifMatch(h.version)),
    ).rejects.toEqual(issueOf('period_locked'));
    await expect(log(worker, harborTask, '2026-09-12', 5)).rejects.toEqual(
      issueOf('period_locked'),
    );
    const sm = mine.entries.find((e) => e.brand.name === 'Summit')!;
    await env.svc.updateEntry(worker, ws, sm.id, { duration_minutes: 80 }, ifMatch(sm.version));
    const re = await submit(worker);
    expect(Object.fromEntries(re.lines.map((l) => [l.brand.name, l.state]))).toEqual({
      Harbor: 'approved',
      Summit: 'pending',
    });
    const done = await decide(admin, re.id, brands.Summit!, 'approve', re.version);
    expect(done.state).toBe('approved');
    const audit = await db.admin(
      `SELECT action FROM audit.audit_event WHERE target_public_id = $1 ORDER BY occurred_at`,
      [re.id],
    );
    expect(audit.rows.map((a) => a.action)).toEqual([
      'timesheet.submitted',
      'timesheet.withdrawn',
      'timesheet.submitted',
      'timesheet.approved',
      'timesheet.rejected',
      'timesheet.submitted',
      'timesheet.approved',
    ]);
  });

  it('unlocks an approved line only for admins, with step-up and a reason, and requires re-approval', async () => {
    const s = await sheet(worker, ids.sheet!);
    const body = { brand: brands.Harbor, reason: 'Client asked for a correction' };
    await expect(
      env.svc.unlockTimesheet(approver, ws, s.id, body, ifMatch(s.version)),
    ).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.unlockTimesheet(admin, ws, s.id, { brand: brands.Harbor }, ifMatch(s.version)),
    ).rejects.toEqual(issueOf('required'));
    await expect(
      env.svc.unlockTimesheet(admin, ws, s.id, body, ifMatch(s.version)),
    ).rejects.toEqual(reason('step_up_required'));
    env.stepUp.allow = true;
    const u = (
      await env.svc.unlockTimesheet(admin, ws, s.id, body, ifMatch(s.version, { stepUpToken: 't' }))
    ).data;
    env.stepUp.allow = false;
    expect(u.state).toBe('open');
    const line = u.lines.find((l) => l.brand.name === 'Harbor')!;
    expect(line).toMatchObject({ state: 'unlocked', locked: false });
    expect(line.locks.map((l) => [l.action, l.reason])).toEqual([
      ['lock', undefined],
      ['unlock', 'Client asked for a correction'],
    ]);
    // The approver sees the history but not the unlock reason.
    const seen = await sheet(approver, s.id);
    expect(seen.lines[0]!.locks.map((l) => l.reason)).toEqual([undefined, undefined]);
    const sec = await db.admin(
      `SELECT count(*)::int AS n FROM audit.security_event WHERE action = 'timesheet.unlock'`,
    );
    expect(sec.rows[0].n).toBe(1);
    // The correction is possible again, and the line must be approved again.
    const h = u.entries.find((e) => e.brand.name === 'Harbor')!;
    await env.svc.updateEntry(worker, ws, h.id, { duration_minutes: 100 }, ifMatch(h.version));
    const re = await submit(worker);
    expect(Object.fromEntries(re.lines.map((l) => [l.brand.name, l.state]))).toEqual({
      Harbor: 'pending',
      Summit: 'approved',
    });
    const after = await decide(approver, re.id, brands.Harbor!, 'approve', re.version);
    expect(after.state).toBe('approved');
    expect(after.lines[0]!.locks.map((l) => l.action)).toEqual(['lock', 'unlock', 'lock']);
  });

  it('refuses a decision by an approver who cannot read every entry in the line', async () => {
    const week = '2026-09-21';
    const quiet = await log(worker, hiddenTask, week, 30);
    await log(worker, harborTask, week, 30);
    const s = await submit(worker, week);
    expect(quiet.target?.id).toBe(hiddenTask);
    // The Harbor approver sees only the time they can read, and cannot decide the line.
    const seen = await sheet(approver, s.id);
    expect(seen.entries.map((e) => e.id)).not.toContain(quiet.id);
    await expect(decide(approver, s.id, brands.Harbor!, 'approve', s.version)).rejects.toEqual(
      issueOf('incomplete_visibility'),
    );
    // A restricted project hides its time even from workspace admins; once the approver may read
    // the project, they see all of the line and may decide it.
    await expect(decide(admin, s.id, brands.Harbor!, 'approve', s.version)).rejects.toEqual(
      issueOf('incomplete_visibility'),
    );
    await apply(env, owner, ws, {
      kind: 'project_grant',
      project: quietProject,
      principal: ids.approver,
      level: 'view',
    });
    expect((await sheet(approver, s.id)).entries.map((e) => e.id)).toContain(quiet.id);
    expect((await decide(approver, s.id, brands.Harbor!, 'approve', s.version)).state).toBe(
      'approved',
    );
  });

  it('labels self-approval where policy allows it (a one-person workspace)', async () => {
    const solo = await seedAccount(db);
    const created = await env.svc.createWorkspace(
      solo,
      { ...WORKSPACE_INPUT, name: 'Solo', first_brand: { name: 'Only' } },
      mutation(),
    );
    const sws = created.data.workspace.id;
    const t = (
      await env.svc.createTask(
        solo,
        sws,
        { brand: created.data.first_brand!.id, title: 'Mine' },
        mutation(),
      )
    ).data;
    await env.svc.createEntry(
      solo,
      sws,
      { target: t.id, work_date: WEEK, duration_minutes: 60 },
      mutation(),
    );
    const s = (await env.svc.submitTimesheet(solo, sws, { period_start: WEEK }, mutation())).data;
    expect(s.lines[0]).toMatchObject({ can_approve: true, self_approval: true });
    const d = (
      await env.svc.decideTimesheet(
        solo,
        sws,
        s.id,
        { brand: created.data.first_brand!.id, decision: 'approve' },
        ifMatch(s.version),
      )
    ).data;
    expect(d.state).toBe('approved');
    expect(d.lines[0]!.decisions[0]).toMatchObject({ self_approval: true });
  });

  it('serializes a decision against a withdrawal: exactly one wins, and evidence matches the result', async () => {
    const week = '2026-09-28';
    await log(worker, harborTask, week, 45);
    for (let round = 0; round < 3; round++) {
      const s = await submit(worker, week);
      const before = (await sheet(worker, s.id)).lines[0]!.decisions.length;
      const results = await Promise.allSettled([
        env.svc.withdrawTimesheet(worker, ws, s.id, ifMatch(s.version)),
        env.svc.decideTimesheet(
          approver,
          ws,
          s.id,
          { brand: brands.Harbor, decision: 'reject', note: 'Too vague' },
          ifMatch(s.version),
        ),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results)
        if (r.status === 'rejected') expect(r.reason).toEqual(reason('conflict'));
      // Whichever won, the result and its evidence agree: a decision exists exactly when the
      // rejection won, and the line says so.
      const now = await sheet(worker, s.id);
      const rejectWon = results[1]!.status === 'fulfilled';
      expect(now.state).toBe('open');
      expect(now.lines[0]!.decisions.length).toBe(before + (rejectWon ? 1 : 0));
      expect(now.lines[0]!.state).toBe(rejectWon ? 'rejected' : 'withdrawn');
    }
  });

  it('blocks moving a task with locked time to another brand; open time follows the task', async () => {
    const locked = await sheet(worker, ids.sheet!);
    expect(locked.state).toBe('approved');
    const pv = await env.svc.previewTaskBrandMove(owner, ws, harborTask, { brand: brands.Summit });
    await expect(
      env.svc.moveTaskBrand(
        owner,
        ws,
        harborTask,
        { brand: brands.Summit, preview_token: pv.preview_token },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('time_locked'));
    const mover = (
      await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'Mover' }, mutation())
    ).data.id;
    const e = await log(worker, mover, '2026-10-05', 20);
    const pv2 = await env.svc.previewTaskBrandMove(owner, ws, mover, { brand: brands.Summit });
    await env.svc.moveTaskBrand(
      owner,
      ws,
      mover,
      { brand: brands.Summit, preview_token: pv2.preview_token },
      mutation(),
    );
    expect((await env.svc.getEntry(worker, ws, e.id)).brand.id).toBe(brands.Summit);
  });

  it('lets only the worker role delete locked entries (purge), never the application role', async () => {
    const locked = (await sheet(worker, ids.sheet!)).entries[0]!;
    const del = (h: typeof env.h.app) =>
      h.withWorkspace(wsId, { module: 'test' }, (tx) =>
        sql`DELETE FROM timetrack.time_entry WHERE public_id = ${locked.id}`.execute(tx.db),
      );
    await expect(del(env.h.app)).rejects.toThrow(/time_locked/);
    await del(env.h.worker);
    await expect(env.svc.getEntry(worker, ws, locked.id)).rejects.toEqual(reason('not_found'));
  });
});
