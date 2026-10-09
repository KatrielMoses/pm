import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Migrator, sql as ksql } from '@pm/db';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  DEFAULT_WORK_SETTINGS,
  metricsReconcileHandler,
  reconcileBackoffMs,
  reconcileWorkspace,
  type MetricsJobDeps,
  type WorkSettings,
} from '@pm/work';
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

/**
 * The task status ledger and its reconciliation (ADR-0030 M10–M11): history is written in the
 * task's own transaction, a bounded resumable job proves it against the tasks and repairs drift,
 * and every state of that job (due, leased, failing, recovered) is visible and never hidden.
 */
describe('Metrics status ledger and reconciliation (5C)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let project: string;
  const tsk: Record<string, string> = {};
  const sql = async (text: string, params: unknown[] = []) =>
    (await db.admin(text, params)).rows as Array<Record<string, any>>;
  const getMetric = (...a: Parameters<WorkEnv['svc']['getMetric']>) =>
    env.svc.getMetric(...a) as Promise<any>;
  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const idOf = async (key: string) =>
    (await sql(`SELECT id FROM core.record WHERE public_id = $1`, [tsk[key]]))[0]!.id as string;
  const warnings: unknown[] = [];
  const jobDeps = (settings: Partial<WorkSettings> = {}): MetricsJobDeps => ({
    tenant: env.h.worker,
    discovery: env.h.discovery,
    metrics: env.h.telemetry.metrics,
    logger: { ...env.h.logger, warn: (...a: unknown[]) => warnings.push(a) } as never,
    settings: { ...DEFAULT_WORK_SETTINGS, ...settings },
  });
  const step = (settings: Partial<WorkSettings> = {}, now = new Date()) =>
    reconcileWorkspace(jobDeps(settings), wsId, now);
  const due = () =>
    sql(
      `UPDATE metrics.reconcile_state SET next_run_at = now() - interval '1 minute', lease_until = NULL WHERE workspace_id = $1`,
      [wsId],
    );
  const state = async () =>
    (await sql(`SELECT * FROM metrics.reconcile_state WHERE workspace_id = $1`, [wsId]))[0]!;
  const mk = async (key: string, body: Record<string, unknown> = {}) =>
    (tsk[key] = (
      await env.svc.createTask(owner, ws, { project, title: key, ...body }, mutation())
    ).data.id);
  const setStatus = async (key: string, value: string, as: Caller = owner) => {
    const cur = await env.svc.getTask(as, ws, tsk[key]!);
    await env.svc.updateTask(
      as,
      ws,
      tsk[key]!,
      { version: cur.version, changes: { status: { base: cur.status.key, value } } },
      mutation({ ifMatch: `"${cur.version}"` }),
    );
  };
  const done = async (key: string, as: Caller = owner) => {
    const v = (await env.svc.getTask(as, ws, tsk[key]!)).version;
    await env.svc.completeTask(as, ws, tsk[key]!, {}, mutation({ ifMatch: `"${v}"` }));
  };
  const history = async (
    key: string,
  ): Promise<
    Array<{ seq: number; cat: string; basis: string; entered_at: string; left_at: string | null }>
  > =>
    (
      await sql(
        `SELECT seq, status_category AS cat, basis, entered_at, left_at FROM metrics.task_status_span WHERE task_id = $1 ORDER BY seq`,
        [await idOf(key)],
      )
    ).map((r) => ({ ...r, seq: Number(r.seq) })) as never;
  /** Every task has exactly one open span, in the task's own status, and spans never overlap or leave gaps. */
  const invariant = async () => {
    const bad = await sql(`
      SELECT t.id FROM work.task t JOIN core.record cr ON cr.id = t.id AND cr.lifecycle_state <> 'purged'
       WHERE (SELECT count(*) FROM metrics.task_status_span s WHERE s.task_id = t.id AND s.left_at IS NULL) <> 1
          OR NOT EXISTS (SELECT 1 FROM metrics.task_status_span s WHERE s.task_id = t.id AND s.left_at IS NULL
                           AND s.status_id = t.status_id AND s.status_category = t.status_category)
          OR EXISTS (SELECT 1 FROM metrics.task_status_span a JOIN metrics.task_status_span b
                       ON b.task_id = a.task_id AND b.seq = a.seq + 1 AND b.entered_at <> a.left_at
                     WHERE a.task_id = t.id)`);
    expect(bad).toEqual([]);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db, { work: { metricsReconcileMaxAttempts: 2, metricsReconcileBatchMax: 50 } });
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor']));
    wsId = await workspaceIdOf(db, ws);
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(editor),
      level: 'edit',
    });
    project = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Ledger' }, mutation())
    ).data.id;
  }, 240_000);
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('records a task’s status history in its own transaction as it is created, moved, finished, and reopened', async () => {
    await mk('l1');
    expect((await history('l1')).map((h) => [h.seq, h.cat, h.basis, h.left_at === null])).toEqual([
      [1, 'planned', 'recorded', true],
    ]);
    await setStatus('l1', 'in_progress');
    await done('l1');
    await env.svc.reopenTask(owner, ws, tsk.l1!, mutation());
    const h = await history('l1');
    expect(h.map((x) => [x.seq, x.cat, x.basis])).toEqual([
      [1, 'planned', 'recorded'],
      [2, 'active', 'recorded'],
      [3, 'done', 'recorded'],
      [4, 'active', 'recorded'],
    ]);
    expect(
      h
        .slice(0, -1)
        .every(
          (x, i) => new Date(x.left_at!).getTime() === new Date(h[i + 1]!.entered_at).getTime(),
        ),
    ).toBe(true);
    expect(h.at(-1)!.left_at).toBeNull();
    await invariant();
    // A change that is not a status change writes nothing; an edit that fails writes nothing.
    const cur = await env.svc.getTask(owner, ws, tsk.l1!);
    await env.svc.updateTask(
      owner,
      ws,
      tsk.l1!,
      { version: cur.version, changes: { title: { base: cur.title, value: 'renamed' } } },
      mutation({ ifMatch: `"${cur.version}"` }),
    );
    expect((await history('l1')).length).toBe(4);
    await expect(
      env.svc.updateTask(
        owner,
        ws,
        tsk.l1!,
        { version: cur.version, changes: { status: { base: 'wrong', value: 'done' } } },
        mutation({ ifMatch: `"${cur.version}"` }),
      ),
    ).rejects.toBeDefined();
    expect((await history('l1')).length).toBe(4);
  });

  it('measures a real task’s cycle time from the history it wrote', async () => {
    await mk('l2');
    await setStatus('l2', 'in_progress');
    await new Promise((r) => setTimeout(r, 1100));
    await done('l2');
    const r = await getMetric(owner, ws, 'work.cycle_time', { project });
    expect(r.value.measured).toBeGreaterThanOrEqual(1);
    expect(r.value.max_seconds).toBeGreaterThanOrEqual(1);
    const ids = (
      await env.svc.getMetricRecords(owner, ws, 'work.cycle_time', { project, member: 'included' })
    ).items.map((i: { title: string }) => i.title);
    expect(ids).toContain('l2');
  });

  it('removes a task’s history with the task, and keeps it through trash and restore', async () => {
    await mk('l3');
    await setStatus('l3', 'in_progress');
    expect((await history('l3')).length).toBe(2);
    const open = async () => (await getMetric(owner, ws, 'work.age', { project })).value.open;
    const before = await open();
    await env.svc.taskLifecycle(owner, ws, tsk.l3!, 'trash', {}, mutation());
    expect(await open()).toBe(before - 1);
    expect((await history('l3')).length).toBe(2);
    await env.svc.taskLifecycle(owner, ws, tsk.l3!, 'restore', {}, mutation());
    expect(await open()).toBe(before);
    expect((await history('l3')).length).toBe(2);
    // Tombstoning (the last step of a purge) removes the history in the same statement.
    await env.svc.taskLifecycle(owner, ws, tsk.l3!, 'trash', {}, mutation());
    await env.svc.taskLifecycle(owner, ws, tsk.l3!, 'purge', {}, mutation());
    const id = await idOf('l3');
    expect((await history('l3')).length).toBe(2);
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      await ksql`UPDATE core.record SET lifecycle_state = 'purged', purged_at = now(), prior_lifecycle_state = NULL,
          owner_membership_id = NULL, source_ref = NULL, template_installation_id = NULL, archive_cause = NULL,
          archive_batch_id = NULL, archived_at = NULL, archived_by_type = NULL, archived_by_id = NULL, version = version + 1
        WHERE id = ${id}`.execute(tx.db);
    });
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM metrics.task_status_span WHERE task_id = $1`, [
          id,
        ])
      )[0]!.n,
    ).toBe(0);
    // Deleting the source row (the content hook of a purge) removes the history the same way.
    await mk('l4');
    const id4 = await idOf('l4');
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      await ksql`DELETE FROM work.task WHERE id = ${id4}`.execute(tx.db);
    });
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM metrics.task_status_span WHERE task_id = $1`, [
          id4,
        ])
      )[0]!.n,
    ).toBe(0);
  });

  it('repairs a task whose history disagrees with its status, once, without backdating, and repeats change nothing', async () => {
    await mk('d1');
    await mk('d2');
    await mk('d3');
    await done('d3');
    const doneStatus = (
      await sql(`SELECT status_id, status_category FROM work.task WHERE id = $1`, [
        await idOf('d3'),
      ])
    )[0]!;
    await due();
    // A write path that bypassed the trigger: the task changed, the history did not.
    await sql(`ALTER TABLE work.task DISABLE TRIGGER metrics_status`);
    try {
      await sql(
        `UPDATE work.task SET status_id = $2, status_category = $3, completed_at = now() WHERE id = $1`,
        [await idOf('d1'), doneStatus.status_id, doneStatus.status_category],
      );
      await sql(`DELETE FROM metrics.task_status_span WHERE task_id = $1`, [await idOf('d2')]);
    } finally {
      await sql(`ALTER TABLE work.task ENABLE TRIGGER metrics_status`);
    }
    expect((await history('d1')).map((h) => h.cat)).toEqual(['planned']);
    const started = new Date();
    const r = await step({ metricsReconcileBatchMax: 500 }, started);
    expect(warnings).toEqual([]);
    expect(r).toMatchObject({ claimed: true, repaired: 2, passComplete: true });
    expect((await history('d1')).map((h) => [h.cat, h.basis])).toEqual([
      ['planned', 'recorded'],
      ['done', 'repaired'],
    ]);
    expect((await history('d2')).map((h) => [h.cat, h.basis])).toEqual([['planned', 'repaired']]);
    // The repair starts at the moment it was found, never earlier.
    expect(new Date((await history('d1'))[1]!.entered_at).getTime()).toBeGreaterThanOrEqual(
      started.getTime() - 1000,
    );
    await invariant();
    const st = await state();
    expect(Number(st.repaired_total)).toBe(2);
    expect(st.failure_code).toBeNull();
    expect(Number(st.attempts)).toBe(0);
    expect(st.last_success_at).not.toBeNull();
    // Not due again until the interval passes: another worker finds nothing to take.
    expect(await step()).toMatchObject({ claimed: false });
    await due();
    expect(await step()).toMatchObject({ claimed: true, repaired: 0, passComplete: true });
    expect((await history('d1')).length).toBe(2);
    // The repaired task is labelled in the figures that depend on history.
    const f = await getMetric(owner, ws, 'data.freshness', {});
    const h = f.value.sources.find((s: { source: string }) => s.source === 'status_history');
    expect(h.detail).toMatchObject({ reconciliation: 'current' });
    expect(h.pending).toBeGreaterThanOrEqual(2);
    const cvc = await getMetric(owner, ws, 'work.created_vs_completed', { project });
    expect(cvc.freshness.ledger).toMatchObject({ reconciliation: 'current' });
    expect(cvc.freshness.ledger.tasks_with_repaired_history).toBeGreaterThanOrEqual(2);
  });

  it('takes a large workspace in bounded steps that resume where they stopped', async () => {
    for (const k of ['b1', 'b2', 'b3', 'b4', 'b5']) await mk(k);
    await sql(
      `DELETE FROM metrics.task_status_span WHERE task_id IN (SELECT id FROM work.task WHERE title IN ('b1','b2','b3','b4','b5'))`,
    );
    await due();
    const total = Number((await sql(`SELECT count(*) AS n FROM work.task`))[0]!.n);
    const small = { metricsReconcileBatchMax: 50 };
    // Walk with a batch smaller than the workspace: each step checks at most the batch, then resumes.
    let checked = 0;
    let repaired = 0;
    let steps = 0;
    for (let i = 0; i < 40; i++) {
      const r = await step({ metricsReconcileBatchMax: 50 }, new Date());
      void small;
      if (!r.claimed) break;
      checked += r.checked;
      repaired += r.repaired;
      steps++;
      if (r.passComplete) break;
    }
    expect(repaired).toBe(5);
    expect(checked).toBe(total);
    expect(steps).toBeGreaterThanOrEqual(1);
    await invariant();
    // The same, in steps of two: the position is saved between steps, and a pass finishes once.
    await sql(
      `DELETE FROM metrics.task_status_span WHERE task_id IN (SELECT id FROM work.task WHERE title IN ('b1','b2','b3'))`,
    );
    await due();
    const seen: number[] = [];
    let last = await step({ metricsReconcileBatchMax: 2 });
    seen.push(last.checked);
    expect(last.passComplete).toBe(false);
    expect((await state()).scan_after).not.toBeNull();
    while (!last.passComplete) {
      last = await step({ metricsReconcileBatchMax: 2 });
      seen.push(last.checked);
      expect(seen.length).toBeLessThan(40);
    }
    expect(seen.every((n) => n <= 2)).toBe(true);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(total);
    expect((await state()).scan_after).toBeNull();
    await invariant();
    expect((await history('b1'))[0]).toMatchObject({ basis: 'repaired' });
  });

  it('does not let two workers hold one workspace, and recovers one that was lost', async () => {
    await due();
    const [a, b] = await Promise.all([step(), step()]);
    expect([a.claimed, b.claimed].filter(Boolean).length).toBe(1);
    // A held lease keeps others out; a lapsed one (a crashed worker) is taken over.
    await sql(
      `UPDATE metrics.reconcile_state SET next_run_at = now() - interval '1 minute', lease_until = now() + interval '10 minutes' WHERE workspace_id = $1`,
      [wsId],
    );
    expect(await step()).toMatchObject({ claimed: false });
    expect(await env.h.discovery.discoverMetricsWork(new Date(), 10)).toEqual([]);
    await sql(
      `UPDATE metrics.reconcile_state SET lease_until = now() - interval '1 second' WHERE workspace_id = $1`,
      [wsId],
    );
    expect(await env.h.discovery.discoverMetricsWork(new Date(), 10)).toEqual([wsId]);
    expect(await step()).toMatchObject({ claimed: true, passComplete: true });
    // The worker handler discovers and processes the same way.
    await due();
    await metricsReconcileHandler(jobDeps()).handle({} as never);
    expect((await state()).lease_until).toBeNull();
    expect(new Date((await state()).next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('backs off a failing pass, reports it as failing, and recovers when asked after the fault is gone', async () => {
    const maxAttempts = 2;
    expect(reconcileBackoffMs(1, 60, 360)).toBe(60_000);
    expect(reconcileBackoffMs(3, 60, 360)).toBe(240_000);
    expect(reconcileBackoffMs(20, 60, 360)).toBe(360 * 60_000);
    await due();
    await sql(`ALTER TABLE metrics.task_status_span RENAME TO task_status_span_gone`);
    try {
      for (let i = 1; i <= maxAttempts; i++) {
        const r = await step();
        expect(r).toMatchObject({ claimed: true, checked: 0, repaired: 0 });
        const st = await state();
        expect(Number(st.attempts)).toBe(i);
        expect(st.failure_code).toBe('source_error');
        expect(st.lease_until).toBeNull();
        expect(new Date(st.next_run_at).getTime()).toBeGreaterThan(Date.now());
        await due();
      }
    } finally {
      await sql(`ALTER TABLE metrics.task_status_span_gone RENAME TO task_status_span`);
    }
    const f = await getMetric(owner, ws, 'data.freshness', {});
    const h = f.value.sources.find((s: { source: string }) => s.source === 'status_history');
    expect(h).toMatchObject({
      state: 'degraded',
      failed: 1,
      detail: { reconciliation: 'failing' },
    });
    expect(f.value.overall).toBe('degraded');
    expect(f.state).toBe('partial');
    // Every ledger figure carries the same warning, and a person who cannot configure cannot clear it.
    const cvc = await getMetric(editor, ws, 'work.cycle_time', { project });
    expect(cvc.freshness).toMatchObject({
      state: 'degraded',
      basis: 'ledger',
      ledger: { reconciliation: 'failing' },
    });
    await expect(env.svc.requestReconcile(editor, ws)).rejects.toEqual(reason('forbidden'));
    expect(await env.svc.requestReconcile(owner, ws)).toEqual({ requested: true });
    expect(await env.h.discovery.discoverMetricsWork(new Date(), 10)).toEqual([wsId]);
    expect(await step()).toMatchObject({ claimed: true, passComplete: true });
    const ok = await state();
    expect(Number(ok.attempts)).toBe(0);
    expect(ok.failure_code).toBeNull();
    const after = await getMetric(owner, ws, 'data.freshness', {});
    expect(
      after.value.sources.find((s: { source: string }) => s.source === 'status_history'),
    ).toMatchObject({ state: 'current' });
    // A pass that has not completed for a long time is reported as overdue, not as current.
    await sql(
      `UPDATE metrics.reconcile_state SET last_success_at = now() - interval '3 days' WHERE workspace_id = $1`,
      [wsId],
    );
    const late = await getMetric(owner, ws, 'data.freshness', {});
    expect(
      late.value.sources.find((s: { source: string }) => s.source === 'status_history'),
    ).toMatchObject({ state: 'catching_up', detail: { reconciliation: 'overdue' } });
  });

  it('converges when status changes, reconciliation, and reads overlap', async () => {
    const keys = ['k1', 'k2', 'k3', 'k4'];
    for (const k of keys) await mk(k);
    await due();
    await Promise.all([
      ...keys.map(async (k, i) => {
        await setStatus(k, 'in_progress', i % 2 ? owner : editor);
        await done(k);
      }),
      step(),
      getMetric(owner, ws, 'work.created_vs_completed', { project }),
      step(),
      getMetric(editor, ws, 'work.cycle_time', { project }),
    ]);
    await invariant();
    for (const k of keys) expect((await history(k)).map((h) => h.cat).slice(-1)[0]).toBe('done');
    const r = await getMetric(owner, ws, 'work.cycle_time', { project });
    expect(r.value.measured).toBeGreaterThanOrEqual(keys.length);
  });
});

/**
 * Migration 0043 on data that already exists: rolling it down and applying it again gives every
 * task one assumed span in its status (a finished task keeps its completion time) and one
 * reconciliation row per workspace; later changes are recorded exactly, and the figures that need
 * the time spent earlier say they cannot have it.
 */
describe('Metrics ledger backfill (5C migration 0043)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let wsId: string;
  let project: string;
  const tsk: Record<string, string> = {};
  const getMetric = (...a: Parameters<WorkEnv['svc']['getMetric']>) =>
    env.svc.getMetric(...a) as Promise<any>;
  const sql = async (text: string, params: unknown[] = []) =>
    (await db.admin(text, params)).rows as Array<Record<string, any>>;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    let brands: Record<string, string>;
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor']));
    wsId = await workspaceIdOf(db, ws);
    project = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Old' }, mutation())
    ).data.id;
    for (const k of ['open', 'active', 'finished'])
      tsk[k] = (await env.svc.createTask(owner, ws, { project, title: k }, mutation())).data.id;
    const cur = await env.svc.getTask(owner, ws, tsk.active!);
    await env.svc.updateTask(
      owner,
      ws,
      tsk.active!,
      { version: cur.version, changes: { status: { base: cur.status.key, value: 'in_progress' } } },
      mutation({ ifMatch: `"${cur.version}"` }),
    );
    const v = (await env.svc.getTask(owner, ws, tsk.finished!)).version;
    await env.svc.completeTask(owner, ws, tsk.finished!, {}, mutation({ ifMatch: `"${v}"` }));
  }, 240_000);
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('rolls down and up again over existing tasks, assuming history it never saw and labelling it', async () => {
    const m = new Migrator({ connectionString: db.migrator, environment: 'test' });
    const before = (await sql(`SELECT count(*)::int AS n FROM metrics.task_status_span`))[0]!.n;
    expect(before).toBeGreaterThanOrEqual(3);
    await m.down(42);
    expect((await sql(`SELECT to_regclass('metrics.task_status_span') AS t`))[0]!.t).toBeNull();
    await m.up();
    expect((await m.status()).report.problems).toEqual([]);
    const rows = await sql(`
      SELECT r.public_id, s.seq, s.status_category AS cat, s.basis, s.entered_at, s.left_at, t.created_at, t.completed_at
        FROM metrics.task_status_span s JOIN work.task t ON t.id = s.task_id JOIN core.record r ON r.id = t.id
       ORDER BY r.public_id`);
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(Number(r.seq)).toBe(1);
      expect(r.basis).toBe('assumed');
      expect(r.left_at).toBeNull();
    }
    const by = Object.fromEntries(rows.map((r) => [r.public_id, r]));
    expect(by[tsk.open!]).toMatchObject({ cat: 'planned' });
    expect(new Date(by[tsk.open!]!.entered_at).getTime()).toBe(
      new Date(by[tsk.open!]!.created_at).getTime(),
    );
    expect(by[tsk.active!]).toMatchObject({ cat: 'active' });
    expect(by[tsk.finished!]).toMatchObject({ cat: 'done' });
    expect(new Date(by[tsk.finished!]!.entered_at).getTime()).toBe(
      new Date(by[tsk.finished!]!.completed_at).getTime(),
    );
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM metrics.reconcile_state WHERE workspace_id = $1`,
          [wsId],
        )
      )[0]!.n,
    ).toBe(1);
    // Figures that need earlier history exclude and name those tasks instead of guessing.
    const q = { project };
    const cyc = await getMetric(owner, ws, 'work.cycle_time', q);
    expect(cyc.value).toMatchObject({ completions: 1, measured: 0 });
    expect(cyc.incomplete).toEqual([
      expect.objectContaining({ code: 'history_unavailable', count: 1 }),
    ]);
    expect((await getMetric(owner, ws, 'work.created_vs_completed', q)).incomplete).toEqual([
      expect.objectContaining({ code: 'assumed_history', count: 1 }),
    ]);
    expect(
      (await getMetric(owner, ws, 'work.cycle_time', q)).freshness.ledger
        .tasks_with_assumed_history,
    ).toBe(3);
    // From here on history is recorded exactly.
    const cur = await env.svc.getTask(owner, ws, tsk.open!);
    await env.svc.updateTask(
      owner,
      ws,
      tsk.open!,
      { version: cur.version, changes: { status: { base: cur.status.key, value: 'in_progress' } } },
      mutation({ ifMatch: `"${cur.version}"` }),
    );
    const after = await sql(
      `SELECT seq, status_category AS cat, basis FROM metrics.task_status_span WHERE task_id = (SELECT id FROM core.record WHERE public_id = $1) ORDER BY seq`,
      [tsk.open],
    );
    expect(after.map((r) => [Number(r.seq), r.cat, r.basis])).toEqual([
      [1, 'planned', 'assumed'],
      [2, 'active', 'recorded'],
    ]);
    // The rolled-back and re-applied schema is the one the migration test compares.
    await m.down(42);
    await m.up();
    expect((await sql(`SELECT count(*)::int AS n FROM metrics.task_status_span`))[0]!.n).toBe(3);
  });
});
