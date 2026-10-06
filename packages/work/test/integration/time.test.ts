import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { DEFAULT_WORK_SETTINGS, stopRunaway, timerGuardHandler } from '@pm/work';
import { AuditWriter } from '@pm/audit';
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
 * Phase 3D entries and timers on real PostgreSQL (ADR-0019): manual timed and duration-only
 * entries, DST-safe durations in the entry's zone, no negative, future, oversized, or overlapping
 * time (service and database), billable state, timers with idempotent pause/resume/stop and
 * recovery after refresh, one live timer per person under concurrency, the timer guard, and
 * revocation (entries on work a person can no longer read disappear; a live timer can still stop).
 */
describe('time entries and timers (3D)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let task: string;
  let other: string;
  let project: string;

  const entry = (body: Record<string, unknown>, as: Caller = owner) =>
    env.svc.createEntry(as, ws, body, mutation()).then((r) => r.data);

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    project = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Launch' }, mutation())
    ).data.id;
    task = (
      await env.svc.createTask(
        owner,
        ws,
        { project, title: 'Write copy', estimate_minutes: 240 },
        mutation(),
      )
    ).data.id;
    other = (
      await env.svc.createTask(owner, ws, { brand: brands.Summit, title: 'Fix login' }, mutation())
    ).data.id;
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('records timed and duration-only entries with UTC instants, the zone, and the local day', async () => {
    const timed = await entry({
      target: task,
      started_at: '2026-09-14T09:00:00Z',
      ended_at: '2026-09-14T10:30:15.900Z',
      tz: 'Europe/Berlin',
      billable: true,
      note: 'Draft one',
    });
    expect(timed).toMatchObject({
      type: 'time_entry',
      source: 'manual',
      state: 'stopped',
      started_at: '2026-09-14T09:00:00.000Z',
      // Instants are whole seconds: sub-second input is truncated, never rounded up.
      ended_at: '2026-09-14T10:30:15.000Z',
      work_date: '2026-09-14',
      tz: 'Europe/Berlin',
      duration_seconds: 5415,
      hours: 1.5,
      billable: true,
      note: 'Draft one',
      status: 'open',
      own: true,
      editable: true,
      target: { type: 'task', id: task, title: 'Write copy' },
      brand: { id: brands.Harbor },
    });
    expect(timed.segments).toEqual([
      { started_at: '2026-09-14T09:00:00.000Z', ended_at: '2026-09-14T10:30:15.000Z' },
    ]);
    const plain = await entry({ target: project, work_date: '2026-09-15', duration_minutes: 45 });
    expect(plain).toMatchObject({
      started_at: null,
      ended_at: null,
      duration_seconds: 2700,
      billable: false,
      target: { type: 'project', id: project },
      segments: [],
    });
    // Notes are audited as hashes only.
    const audit = await db.admin(
      `SELECT action, changes FROM audit.audit_event WHERE target_public_id = $1`,
      [timed.id],
    );
    expect(audit.rows.map((a) => a.action)).toEqual(['time.entry_created']);
    expect(JSON.stringify(audit.rows[0].changes)).not.toContain('Draft one');
    const ev = await db.admin(
      `SELECT payload FROM exec.outbox_event WHERE event_type = 'time.time_entry.recorded' ORDER BY occurred_at LIMIT 1`,
    );
    expect(ev.rows[0].payload).toEqual({
      duration_seconds: 5415,
      billable: true,
      source: 'manual',
    });
  });

  it('computes durations across daylight-saving changes from UTC instants, in the entry zone', async () => {
    // Berlin springs forward on 2026-03-29 at 02:00 → 03:00: 01:30–03:30 local is one hour.
    const spring = await entry({
      target: task,
      started_at: '2026-03-29T01:30:00+01:00',
      ended_at: '2026-03-29T03:30:00+02:00',
      tz: 'Europe/Berlin',
    });
    expect(spring).toMatchObject({ duration_seconds: 3600, work_date: '2026-03-29' });
    // Lisbon falls back on 2025-10-26 at 02:00 → 01:00: 00:30–02:30 local is three hours, and the
    // entry counts towards the local day it started (UTC still says 25 October).
    const fall = await entry({
      target: task,
      started_at: '2025-10-26T00:30:00+01:00',
      ended_at: '2025-10-26T02:30:00Z',
      tz: 'Europe/Lisbon',
    });
    expect(fall).toMatchObject({
      duration_seconds: 10800,
      work_date: '2025-10-26',
      started_at: '2025-10-25T23:30:00.000Z',
    });
    // A work date that disagrees with the start's local day is refused.
    await expect(
      entry({
        target: task,
        started_at: '2025-10-25T23:30:00Z',
        ended_at: '2025-10-25T23:45:00Z',
        tz: 'Europe/Lisbon',
        work_date: '2025-10-25',
      }),
    ).rejects.toEqual(issueOf('mismatch'));
  });

  it('refuses negative, empty, oversized, future, malformed, and day-overflowing time', async () => {
    const bad = async (body: Record<string, unknown>, code: string) =>
      expect(entry({ target: task, ...body })).rejects.toEqual(issueOf(code));
    await bad(
      { started_at: '2026-09-01T10:00:00Z', ended_at: '2026-09-01T09:00:00Z' },
      'before_start',
    );
    await bad(
      { started_at: '2026-09-01T10:00:00Z', ended_at: '2026-09-01T10:00:00Z' },
      'before_start',
    );
    await bad({ started_at: '2026-09-01T00:00:00Z', ended_at: '2026-09-02T00:00:01Z' }, 'too_long');
    const later = new Date(Date.now() + 3600_000).toISOString();
    await bad({ started_at: new Date().toISOString(), ended_at: later }, 'future');
    await bad({ work_date: '2999-01-01', duration_minutes: 30 }, 'future');
    await bad({ work_date: '2026-02-30', duration_minutes: 30 }, 'invalid');
    await bad({ work_date: '2026-09-01', duration_minutes: -5 }, 'invalid');
    await bad({ work_date: '2026-09-01', duration_minutes: 1.5 }, 'invalid');
    await bad({ started_at: '2026-09-01 10:00', ended_at: '2026-09-01T11:00:00Z' }, 'invalid');
    await bad({ work_date: '2026-09-01', duration_minutes: 30, tz: 'Mars/Olympus' }, 'invalid');
    await bad(
      { work_date: '2026-09-01', duration_minutes: 30, note: 'x'.repeat(1001) },
      'too_long',
    );
    await entry({ target: task, work_date: '2026-08-03', duration_minutes: 1200 });
    await bad({ work_date: '2026-08-03', duration_minutes: 241 }, 'day_full');
    await expect(
      entry({
        target: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        work_date: '2026-08-03',
        duration_minutes: 5,
      }),
    ).rejects.toEqual(reason('not_found'));
    await expect(entry({ work_date: '2026-08-03', duration_minutes: 5 })).rejects.toEqual(
      issueOf('required'),
    );
    // The database repeats the range rules.
    await expect(
      db.admin(`UPDATE timetrack.time_entry SET duration_seconds = -1 WHERE workspace_id = $1`, [
        wsId,
      ]),
    ).rejects.toThrow(/duration_range/);
  });

  it('never lets one person’s time overlap (service check and database guard)', async () => {
    await entry({
      target: task,
      started_at: '2026-07-06T09:00:00Z',
      ended_at: '2026-07-06T10:00:00Z',
    });
    await expect(
      entry({
        target: other,
        started_at: '2026-07-06T09:59:59Z',
        ended_at: '2026-07-06T10:30:00Z',
      }),
    ).rejects.toEqual(issueOf('overlap'));
    // Touching intervals are not overlaps.
    await entry({
      target: other,
      started_at: '2026-07-06T10:00:00Z',
      ended_at: '2026-07-06T10:30:00Z',
    });
    // The guard rejects a direct overlapping segment.
    const seg = await db.admin(
      `SELECT s.workspace_id, s.entry_id, s.membership_id FROM timetrack.time_segment s
         JOIN timetrack.time_entry e ON e.id = s.entry_id WHERE e.workspace_id = $1 AND e.work_date = '2026-07-06' LIMIT 1`,
      [wsId],
    );
    const s = seg.rows[0];
    await expect(
      db.admin(
        `INSERT INTO timetrack.time_segment (id, workspace_id, entry_id, membership_id, started_at, ended_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '2026-07-06T09:30:00Z', '2026-07-06T09:45:00Z')`,
        [s.workspace_id, s.entry_id, s.membership_id],
      ),
    ).rejects.toThrow(/time_overlap/);
    // Another person may log the same hours.
    const mem = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: (await membershipOf(db, wsId, mem.auth.account.id))!.public_id,
      level: 'edit',
    });
    await entry(
      { target: task, started_at: '2026-07-06T09:00:00Z', ended_at: '2026-07-06T10:00:00Z' },
      mem,
    );
  });

  it('edits own entries with If-Match, moves them between targets and brands, and deletes them', async () => {
    const e = await entry({ target: task, work_date: '2026-06-01', duration_minutes: 30 });
    await expect(
      env.svc.updateEntry(owner, ws, e.id, { billable: true }, mutation()),
    ).rejects.toEqual(reason('precondition_required'));
    await expect(
      env.svc.updateEntry(owner, ws, e.id, { billable: true }, ifMatch(9)),
    ).rejects.toEqual(reason('conflict'));
    const u = (
      await env.svc.updateEntry(
        owner,
        ws,
        e.id,
        { billable: true, duration_minutes: 50, target: other, note: 'moved' },
        ifMatch(e.version),
      )
    ).data;
    expect(u).toMatchObject({
      billable: true,
      duration_seconds: 3000,
      target: { id: other },
      brand: { id: brands.Summit },
      version: e.version + 1,
      note: 'moved',
    });
    // Switching to clock times re-derives the day in the entry's zone.
    const t = (
      await env.svc.updateEntry(
        owner,
        ws,
        e.id,
        {
          started_at: '2026-06-02T22:30:00Z',
          ended_at: '2026-06-02T23:00:00Z',
          tz: 'Asia/Singapore',
        },
        ifMatch(u.version),
      )
    ).data;
    expect(t).toMatchObject({
      work_date: '2026-06-03',
      duration_seconds: 1800,
      tz: 'Asia/Singapore',
    });
    const mem = await join(env, db, owner, ws, { kind: 'member', role: 'administrator' });
    // Nobody else changes my entry; it is not_found for them.
    await expect(
      env.svc.updateEntry(mem, ws, e.id, { billable: false }, ifMatch(t.version)),
    ).rejects.toEqual(reason('not_found'));
    await env.svc.deleteEntry(owner, ws, e.id, ifMatch(t.version));
    await expect(env.svc.getEntry(owner, ws, e.id)).rejects.toEqual(reason('not_found'));
    const audit = await db.admin(
      `SELECT action FROM audit.audit_event WHERE target_public_id = $1 ORDER BY occurred_at`,
      [e.id],
    );
    expect(audit.rows.map((a) => a.action)).toEqual([
      'time.entry_created',
      'time.entry_updated',
      'time.entry_updated',
      'time.entry_deleted',
    ]);
  });

  it('runs one timer per person: start, pause, resume, stop, idempotent by state, recoverable', async () => {
    const t0 = new Date(Date.now() - 3600_000);
    const started = (
      await env.svc.startTimer(
        owner,
        ws,
        { target: task, at: t0.toISOString(), billable: true },
        mutation(),
      )
    ).data;
    expect(started).toMatchObject({ source: 'timer', state: 'running', duration_seconds: 0 });
    expect(started.running_since).toBe(
      new Date(Math.floor(t0.getTime() / 1000) * 1000).toISOString(),
    );
    // A refresh recovers the live timer and the server clock.
    const live = await env.svc.getTimer(owner, ws);
    expect(live.timer).toMatchObject({ id: started.id, state: 'running' });
    expect(Date.parse(live.server_now)).toBeGreaterThan(t0.getTime());
    // A second timer is a conflict unless it replaces the first.
    await expect(env.svc.startTimer(owner, ws, { target: other }, mutation())).rejects.toEqual(
      issueOf('timer_running'),
    );
    const pause = (at: Date) =>
      env.svc.timerAction(owner, ws, started.id, 'pause', { at: at.toISOString() }, mutation());
    const p1 = (await pause(new Date(t0.getTime() + 600_000))).data;
    expect(p1).toMatchObject({ state: 'paused', duration_seconds: 600 });
    // Pausing again (a retried offline action) changes nothing.
    const p2 = (await pause(new Date(t0.getTime() + 900_000))).data;
    expect(p2).toMatchObject({ state: 'paused', duration_seconds: 600, version: p1.version });
    // Logging into the paused gap is allowed (the timer covered no time there).
    await entry({
      target: other,
      started_at: new Date(t0.getTime() + 700_000).toISOString(),
      ended_at: new Date(t0.getTime() + 800_000).toISOString(),
    });
    const r1 = (
      await env.svc.timerAction(
        owner,
        ws,
        started.id,
        'resume',
        { at: new Date(t0.getTime() + 1200_000).toISOString() },
        mutation(),
      )
    ).data;
    expect(r1).toMatchObject({ state: 'running', duration_seconds: 600 });
    expect(r1.segments).toHaveLength(2);
    const stop = () =>
      env.svc.timerAction(
        owner,
        ws,
        started.id,
        'stop',
        { at: new Date(t0.getTime() + 1500_000).toISOString() },
        mutation(),
      );
    const s1 = (await stop()).data;
    expect(s1).toMatchObject({ state: 'stopped', duration_seconds: 900, billable: true });
    const s2 = (await stop()).data;
    expect(s2).toMatchObject({ state: 'stopped', duration_seconds: 900, version: s1.version });
    await expect(
      env.svc.timerAction(owner, ws, started.id, 'resume', {}, mutation()),
    ).rejects.toEqual(issueOf('timer_stopped'));
    expect((await env.svc.getTimer(owner, ws)).timer).toBeNull();
    // An idempotency-key replay renders the same entry.
    const key = mutation();
    const a = await env.svc.startTimer(owner, ws, { target: task }, key);
    const b = await env.svc.startTimer(owner, ws, { target: task }, key);
    expect(b.replayed).toBe(true);
    expect(b.data.id).toBe(a.data.id);
    const replaced = (
      await env.svc.startTimer(owner, ws, { target: other, replace: true }, mutation())
    ).data;
    expect((await env.svc.getEntry(owner, ws, a.data.id)).state).toBe('stopped');
    await env.svc.timerAction(owner, ws, replaced.id, 'stop', {}, mutation());
    // Instants a client sends must be recent and not in the future.
    await expect(
      env.svc.startTimer(
        owner,
        ws,
        { target: task, at: new Date(Date.now() + 3600_000).toISOString() },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('future'));
    await expect(
      env.svc.startTimer(owner, ws, { target: task, at: '2020-01-01T00:00:00Z' }, mutation()),
    ).rejects.toEqual(issueOf('too_old'));
  });

  it('keeps one live timer per person when starts race', async () => {
    const results = await Promise.allSettled(
      [task, other, task, other].map((target) =>
        env.svc.startTimer(owner, ws, { target }, mutation()),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toEqual(issueOf('timer_running'));
    const live = await db.admin(
      `SELECT count(*)::int AS n FROM timetrack.time_entry WHERE workspace_id = $1 AND state <> 'stopped'`,
      [wsId],
    );
    expect(live.rows[0].n).toBe(1);
    const t = (await env.svc.getTimer(owner, ws)).timer!;
    await env.svc.timerAction(owner, ws, t.id, 'stop', {}, mutation());
  });

  it('keeps entries consistent with their segments at commit', async () => {
    const e = await entry({
      target: task,
      started_at: '2026-05-04T08:00:00Z',
      ended_at: '2026-05-04T09:00:00Z',
    });
    await expect(
      db.admin(`UPDATE timetrack.time_entry SET duration_seconds = 100 WHERE public_id = $1`, [
        e.id,
      ]),
    ).rejects.toThrow(/does not match its segments/);
    await expect(
      db.admin(
        `UPDATE timetrack.time_entry SET membership_id = membership_id, source = 'timer' WHERE public_id = $1`,
        [e.id],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('stops runaway timers once, at exactly the limit, and marks them for review', async () => {
    const guarded = workEnv(db, { work: { timeTimerMaxHours: 1, timeEntryMaxHours: 2 } });
    const mem = await join(guarded, db, owner, ws, { kind: 'member', role: 'administrator' });
    const t0 = new Date(Date.now() - 90 * 60_000);
    const t = (
      await guarded.svc.startTimer(mem, ws, { target: task, at: t0.toISOString() }, mutation())
    ).data;
    const deps = {
      tenant: guarded.h.worker,
      discovery: guarded.h.discovery,
      metrics: guarded.h.telemetry.metrics,
      logger: guarded.h.logger,
      settings: { ...DEFAULT_WORK_SETTINGS, timeTimerMaxHours: 1 },
    };
    await timerGuardHandler(deps).handle({} as never);
    await timerGuardHandler(deps).handle({} as never);
    const after = await guarded.svc.getEntry(mem, ws, t.id);
    expect(after).toMatchObject({ state: 'stopped', duration_seconds: 3600, auto_stopped: true });
    expect(Date.parse(after.ended_at!) - Date.parse(after.started_at!)).toBe(3600_000);
    const ev = await db.admin(
      `SELECT count(*)::int AS n FROM exec.outbox_event WHERE event_type = 'time.timer.auto_stopped'`,
    );
    expect(ev.rows[0].n).toBe(1);
    // A person's own stop after the guard is a no-op; a timer below the limit is left alone.
    expect(
      (await guarded.svc.timerAction(mem, ws, t.id, 'stop', {}, mutation())).data.version,
    ).toBe(after.version);
    const fresh = (await guarded.svc.startTimer(mem, ws, { target: task }, mutation())).data;
    const n = await guarded.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
      stopRunaway(
        tx,
        new AuditWriter({
          module: 'work',
          logger: guarded.h.logger,
          metrics: guarded.h.telemetry.metrics,
        }),
        guarded.h.telemetry.metrics,
        deps.settings,
        new Date(),
        3600,
      ),
    );
    expect(n).toBe(0);
    expect((await guarded.svc.getEntry(mem, ws, fresh.id)).state).toBe('running');
    await guarded.svc.timerAction(mem, ws, fresh.id, 'stop', {}, mutation());
    // A person stopping a timer past the entry limit records exactly the limit.
    const solo = await join(guarded, db, owner, ws, { kind: 'member', role: 'administrator' });
    const fresh2 = (await guarded.svc.startTimer(solo, ws, { target: task }, mutation())).data;
    await db.admin(
      `UPDATE timetrack.time_segment SET started_at = date_trunc('second', now()) - interval '3 hours'
        WHERE entry_id = (SELECT id FROM timetrack.time_entry WHERE public_id = $1)`,
      [fresh2.id],
    );
    await db.admin(
      `UPDATE timetrack.time_entry SET started_at = date_trunc('second', now()) - interval '3 hours' WHERE public_id = $1`,
      [fresh2.id],
    );
    const capped = (await guarded.svc.timerAction(solo, ws, fresh2.id, 'stop', {}, mutation()))
      .data;
    expect(capped.duration_seconds).toBe(7200);
    await guarded.h.close();
  });

  it('keeps entries readable but read-only when logging rights are downgraded', async () => {
    const mem = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const memId = (await membershipOf(db, wsId, mem.auth.account.id))!.public_id;
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Summit,
      principal: memId,
      level: 'edit',
    });
    const e = await entry({ target: other, work_date: '2026-04-13', duration_minutes: 25 }, mem);
    expect(e.editable).toBe(true);
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Summit,
      principal: memId,
      level: 'view',
    });
    const seen = await env.svc.getEntry(mem, ws, e.id);
    expect(seen).toMatchObject({ editable: false, target: { id: other } });
    await expect(
      env.svc.updateEntry(mem, ws, e.id, { billable: true }, ifMatch(e.version)),
    ).rejects.toEqual(reason('forbidden'));
    await expect(
      entry({ target: other, work_date: '2026-04-14', duration_minutes: 5 }, mem),
    ).rejects.toEqual(reason('forbidden'));
  });

  it('hides entries on work a person can no longer read, but lets them stop their live timer', async () => {
    const mem = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const memId = (await membershipOf(db, wsId, mem.auth.account.id))!.public_id;
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Summit,
      principal: memId,
      level: 'edit',
    });
    const e = await entry({ target: other, work_date: '2026-04-06', duration_minutes: 60 }, mem);
    const t = (await env.svc.startTimer(mem, ws, { target: other }, mutation())).data;
    expect((await env.svc.listEntries(mem, ws, { member: 'me' })).data.map((x) => x.id)).toContain(
      e.id,
    );
    await apply(env, owner, ws, { kind: 'brand_revoke', brand: brands.Summit, principal: memId });
    // Gone everywhere for them: lists, reads, edits, summaries, reports, and exports.
    expect(
      (await env.svc.listEntries(mem, ws, { member: 'me' })).data.map((x) => x.id),
    ).not.toContain(e.id);
    await expect(env.svc.getEntry(mem, ws, e.id)).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.updateEntry(mem, ws, e.id, { billable: true }, ifMatch(e.version)),
    ).rejects.toEqual(reason('not_found'));
    const report = await env.svc.timeReport(mem, ws, {
      from: '2026-04-06',
      to: '2026-04-06',
      group: 'brand',
    });
    expect(report.totals.actual_seconds).toBe(0);
    const exported = await env.svc.exportTime(mem, ws, { from: '2026-04-06', to: '2026-04-06' });
    expect(exported.rows).toBe(0);
    // The live timer stays visible without its target, and can be stopped but not resumed.
    const live = (await env.svc.getTimer(mem, ws)).timer!;
    expect(live).toMatchObject({ id: t.id, target: null, note: '' });
    await env.svc.timerAction(mem, ws, t.id, 'pause', {}, mutation());
    await expect(env.svc.timerAction(mem, ws, t.id, 'resume', {}, mutation())).rejects.toEqual(
      reason('not_found'),
    );
    await env.svc.timerAction(mem, ws, t.id, 'stop', {}, mutation());
    expect((await env.svc.getTimer(mem, ws)).timer).toBeNull();
    // The owner still sees the person's time on readable work.
    expect((await env.svc.getEntry(owner, ws, e.id)).person.id).toBe(memId);
  });
});
