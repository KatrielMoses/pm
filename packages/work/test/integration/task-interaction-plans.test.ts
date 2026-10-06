import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql } from '@pm/db';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { remindersHandler } from '@pm/work';
import {
  membershipOf,
  merge,
  mutation,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const TABLES_2D = [
  'planning.task_reminder',
  'planning.task_snooze',
  'work.bulk_operation',
  'work.undo_entry',
];
const soon = (h = 1) => new Date(Date.now() + h * 3_600_000).toISOString();

/**
 * Phase 2D on real PostgreSQL beyond the behavior suites: direct-role isolation of the personal
 * and short-lived tables across three workspaces, concurrency (bulk execution, reminder firing,
 * recurring generation, undo against edits, inline edits, ordering), and query plans at 50,000
 * tasks for signals, duplicates, reminders, ordering, and the reschedule ledger.
 */
describe('task interaction isolation, concurrency, and plans (2D)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  const W: Record<'a' | 'b' | 'c', { owner: Caller; ws: string; id: string; brand: string }> =
    {} as never;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    for (const k of ['a', 'b', 'c'] as const) {
      const w = await workspaceWith(env, db, [`Brand ${k}`]);
      W[k] = {
        owner: w.owner,
        ws: w.ws,
        id: await workspaceIdOf(db, w.ws),
        brand: Object.values(w.brands)[0]!,
      };
    }
    pool = new pg.Pool({ connectionString: db.app, max: 1 });
  });
  afterAll(async () => {
    await pool.end();
    await env.h.close();
    await db.drop();
  });

  async function direct(
    conn: string | pg.Pool,
    workspaceId: string | null,
    text: string,
    params: unknown[] = [],
  ) {
    const p = typeof conn === 'string' ? new pg.Pool({ connectionString: conn, max: 1 }) : conn;
    const c = await p.connect();
    try {
      await c.query('BEGIN');
      if (workspaceId)
        await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      const r = await c.query(text, params);
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
      if (typeof conn === 'string') await p.end();
    }
  }

  it('direct app_rw: no context sees nothing; each workspace only itself; owners only through the service', async () => {
    for (const k of ['a', 'b', 'c'] as const) {
      const w = W[k];
      const t = (
        await env.svc.createTask(w.owner, w.ws, { brand: w.brand, title: `T ${k}` }, mutation())
      ).data;
      await env.svc.createReminder(w.owner, w.ws, t.id, { remind_at: soon() }, mutation());
      await env.svc.snoozeTask(w.owner, w.ws, t.id, { until: soon() }, mutation());
      await env.svc.previewBulk(w.owner, w.ws, { operation: 'archive', tasks: [t.id] }, mutation());
      await env.svc.updateTask(
        w.owner,
        w.ws,
        t.id,
        merge(0, { title: { base: `T ${k}`, value: `U ${k}` } }),
        mutation(),
      );
    }
    for (const t of TABLES_2D) {
      expect((await direct(pool, null, `SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(
        0,
      );
      const scoped = await direct(pool, W.a.id, `SELECT DISTINCT workspace_id FROM ${t}`);
      expect(
        scoped.rows.map((r) => r.workspace_id),
        t,
      ).toEqual([W.a.id]);
      expect(
        (await db.admin(`SELECT count(DISTINCT workspace_id)::int AS n FROM ${t}`)).rows[0].n,
        t,
      ).toBe(3);
    }
    // A row in a for a task in b fails the same-workspace key.
    const bTask = (
      await db.admin(`SELECT id FROM work.task WHERE workspace_id = $1 LIMIT 1`, [W.b.id])
    ).rows[0].id;
    const aMem = (await membershipOf(db, W.a.id, W.a.owner.auth.account.id))!;
    await expect(
      direct(
        pool,
        W.a.id,
        `INSERT INTO planning.task_reminder (id, public_id, workspace_id, owner_membership_id, task_id, remind_at) VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
        [newUuidV7(), newPublicId('rem'), W.a.id, aMem.id, bTask],
      ),
    ).rejects.toThrow(/foreign key/);
    // Origin and freshness: the app cannot rewrite origin; the worker cannot edit tasks.
    await expect(
      direct(pool, W.b.id, `UPDATE work.task SET origin_kind = 'import' WHERE id = $1`, [bTask]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      direct(
        db.worker,
        W.b.id,
        `UPDATE work.task SET last_meaningful_update_at = now() WHERE id = $1`,
        [bTask],
      ),
    ).rejects.toThrow(/permission denied/);
    // Reminder states only move forward.
    await expect(
      db.admin(
        `UPDATE planning.task_reminder SET state = 'scheduled' WHERE state = 'scheduled' AND false`,
      ),
    ).resolves.toBeDefined();
    const rem = (
      await db.admin(`SELECT id FROM planning.task_reminder WHERE workspace_id = $1 LIMIT 1`, [
        W.a.id,
      ])
    ).rows[0].id;
    await db.admin(`UPDATE planning.task_reminder SET state = 'cancelled' WHERE id = $1`, [rem]);
    await expect(
      db.admin(`UPDATE planning.task_reminder SET state = 'scheduled' WHERE id = $1`, [rem]),
    ).rejects.toThrow(/not allowed/);
    // Bulk and undo rows close once.
    const und = (
      await db.admin(`SELECT id FROM work.undo_entry WHERE workspace_id = $1 LIMIT 1`, [W.a.id])
    ).rows[0].id;
    await db.admin(
      `UPDATE work.undo_entry SET state = 'expired', closed_at = now() WHERE id = $1`,
      [und],
    );
    await expect(
      db.admin(`UPDATE work.undo_entry SET state = 'available', closed_at = NULL WHERE id = $1`, [
        und,
      ]),
    ).rejects.toThrow(/closed/);
  });

  it('concurrency: one bulk execution, one reminder firing, one occurrence per key, undo versus a later edit', async () => {
    const w = W.a;
    const xs = [];
    for (let i = 0; i < 5; i++)
      xs.push(
        (await env.svc.createTask(w.owner, w.ws, { brand: w.brand, title: `C${i}` }, mutation()))
          .data,
      );
    // Two executions of one preview: exactly one applies.
    const pv = (
      await env.svc.previewBulk(
        w.owner,
        w.ws,
        { operation: 'set_priority', params: { value: 'high' }, tasks: xs.map((x) => x.id) },
        mutation(),
      )
    ).data;
    const both = await Promise.allSettled([
      env.svc.executeBulk(w.owner, w.ws, pv.id, mutation()),
      env.svc.executeBulk(w.owner, w.ws, pv.id, mutation()),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      both
        .filter((r) => r.status === 'rejected')
        .map((r) => (r as PromiseRejectedResult).reason.code),
    ).toEqual(['conflict']);
    const audits = await db.admin(
      `SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'task.updated' AND target_public_id = ANY($1)`,
      [xs.map((x) => x.id)],
    );
    expect(audits.rows[0].n).toBe(5);
    // Two reminder workers at once: each due reminder fires once.
    for (const x of xs) {
      const r = (
        await env.svc.createReminder(w.owner, w.ws, x.id, { remind_at: soon() }, mutation())
      ).data;
      await db.admin(
        `UPDATE planning.task_reminder SET remind_at = now() - interval '1 minute' WHERE public_id = $1`,
        [r.id],
      );
    }
    const h = () =>
      remindersHandler({
        tenant: env.h.worker,
        discovery: env.h.discovery,
        metrics: env.h.telemetry.metrics,
        logger: env.h.logger,
      }).handle({} as never);
    await Promise.all([h(), h(), h()]);
    const fired = await db.admin(
      `SELECT aggregate_id, count(*)::int AS n FROM exec.outbox_event WHERE event_type = 'planning.task_reminder.fired' GROUP BY 1`,
    );
    expect(fired.rows.length).toBe(5);
    expect(fired.rows.every((r) => r.n === 1)).toBe(true);
    // Concurrent manual generation of the same occurrence: one task for the key.
    const src = xs[0]!;
    const s = (
      await env.svc.defineTaskRecurrence(
        w.owner,
        w.ws,
        src.id,
        { frequency: 'daily', anchor_tz: 'UTC', start: '2026-02-01T09:00' },
        mutation(),
      )
    ).data;
    await Promise.allSettled([
      env.svc.generateNextTaskOccurrence(w.owner, w.ws, src.id, s.id, mutation()),
      env.svc.generateNextTaskOccurrence(w.owner, w.ws, src.id, s.id, mutation()),
    ]);
    const keys = await db.admin(
      `SELECT occurrence_key, count(*)::int AS n FROM work.task t JOIN planning.recurrence_series s ON s.id = t.recurrence_series_id WHERE s.public_id = $1 GROUP BY 1`,
      [s.id],
    );
    expect(keys.rows.every((r) => r.n === 1)).toBe(true);
    // Undo racing a later edit: never a lost update; the undo either applies first or conflicts.
    const t = xs[1]!;
    const v = (await env.svc.getTask(w.owner, w.ws, t.id)).version;
    const u = (
      await env.svc.updateTask(
        w.owner,
        w.ws,
        t.id,
        merge(v, { title: { base: 'C1', value: 'C1 edited' } }),
        mutation(),
      )
    ).data;
    const [undo, edit] = await Promise.allSettled([
      env.svc.applyUndo(w.owner, w.ws, u.undo!.id, mutation()),
      env.svc.updateTask(
        w.owner,
        w.ws,
        t.id,
        merge(v + 1, { priority: { base: 'high', value: 'low' } }),
        mutation(),
      ),
    ]);
    const final = await env.svc.getTask(w.owner, w.ws, t.id);
    if (undo.status === 'fulfilled') expect(final.title).toBe('C1');
    else {
      expect((undo as PromiseRejectedResult).reason.code).toBe('conflict');
      expect(final.title).toBe('C1 edited');
    }
    if (edit.status === 'fulfilled') expect(final.priority).toBe('low');
    else expect((edit as PromiseRejectedResult).reason.code).toBe('conflict');
  });

  it('inline edits: non-overlapping fields merge; overlapping fields return a conflict with both values', async () => {
    const w = W.b;
    const t = (
      await env.svc.createTask(w.owner, w.ws, { brand: w.brand, title: 'Inline' }, mutation())
    ).data;
    await env.svc.updateTask(
      w.owner,
      w.ws,
      t.id,
      merge(0, { priority: { base: 'none', value: 'low' } }),
      mutation(),
    );
    // Stale version, different field: merges.
    const merged = (
      await env.svc.updateTask(
        w.owner,
        w.ws,
        t.id,
        merge(0, { title: { base: 'Inline', value: 'Inline 2' } }),
        mutation(),
      )
    ).data;
    expect(merged).toMatchObject({ title: 'Inline 2', priority: 'low' });
    // Stale version, same field: conflict naming theirs and yours (Keep mine / Use latest).
    await expect(
      env.svc.updateTask(
        w.owner,
        w.ws,
        t.id,
        merge(0, { priority: { base: 'none', value: 'urgent' } }),
        mutation(),
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'conflict',
        conflict: expect.objectContaining({
          fields: [expect.objectContaining({ field: 'priority', yours: 'urgent', theirs: 'low' })],
        }),
      }),
    );
    // Concurrent sibling reorders keep distinct ranks.
    const kids = [];
    for (let i = 0; i < 6; i++)
      kids.push(
        (await env.svc.createTask(w.owner, w.ws, { parent: t.id, title: `K${i}` }, mutation()))
          .data,
      );
    await Promise.allSettled(
      kids.map((k) =>
        env.svc.reorderTask(
          w.owner,
          w.ws,
          k.id,
          { position: 'top', version: k.version },
          mutation(),
        ),
      ),
    );
    const ranks = await db.admin(
      `SELECT rank FROM work.task WHERE parent_task_id = (SELECT id FROM core.record WHERE public_id = $1)`,
      [t.id],
    );
    expect(new Set(ranks.rows.map((r) => r.rank)).size).toBe(6);
  });

  it('EXPLAIN at 50,000 tasks: duplicates, freshness, signals, reminders, ordering, and the reschedule ledger stay indexed', async () => {
    const w = W.c;
    const volume = 50_000;
    const brandId = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [w.brand]))
      .rows[0].id as string;
    const ownerMem = (await membershipOf(db, w.id, w.owner.auth.account.id))!;
    await db.admin(
      `BEGIN; SET LOCAL session_replication_role = replica;
       CREATE TEMP TABLE vol ON COMMIT DROP AS SELECT uuidv7() AS id, i FROM generate_series(1, ${volume}) AS i;
       INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type)
         SELECT id, 'tsk_3' || lpad(i::text, 25, '0'), 'task', '${w.id}', '${brandId}', 'system', 'system' FROM vol;
       INSERT INTO work.task (id, workspace_id, brand_id, scope_key, title, status_id, status_category, rank, ancestor_ids, depth, last_meaningful_update_at)
         SELECT id, '${w.id}', '${brandId}', '${brandId}', 'Task ' || (i % 5000), '01920000-0000-7000-8000-000000000007', 'planned', lpad(i::text, 6, '0'), '{}', 0, now() - make_interval(days => i % 30) FROM vol;
       INSERT INTO planning.task_reminder (id, public_id, workspace_id, owner_membership_id, task_id, remind_at)
         SELECT uuidv7(), 'rem_3' || lpad(i::text, 25, '0'), '${w.id}', '${ownerMem.id}', id, now() + make_interval(mins => i) FROM vol WHERE i % 10 = 0;
       COMMIT;`,
    );
    await db.admin(`ANALYZE work.task, core.record, planning.task_reminder, audit.audit_event`);
    const plan = async (query: string, params: unknown[]) =>
      env.h.app.withWorkspace(w.id, { module: 'test' }, async (tx) => {
        await sql`SET LOCAL enable_seqscan = off`.execute(tx.db);
        const r = await tx.db.executeQuery({
          sql: `EXPLAIN (FORMAT JSON) ${query}`,
          parameters: params,
          query: { kind: 'RawNode' },
        } as never);
        return JSON.stringify((r as { rows: unknown[] }).rows);
      });
    expect(
      await plan(
        `SELECT id FROM work.task t WHERE workspace_id = $1 AND brand_id = $2 AND lower(regexp_replace(t.title, '\\s+', ' ', 'g')) = $3 AND status_category NOT IN ('done', 'cancelled') AND created_at >= now() - interval '90 days' LIMIT 5`,
        [w.id, brandId, 'task 42'],
      ),
    ).toMatch(/task_duplicate_probe/);
    expect(
      await plan(
        `SELECT id FROM work.task WHERE workspace_id = $1 AND brand_id = $2 AND status_category IN ('planned', 'active', 'paused') AND last_meaningful_update_at < now() - interval '14 days' LIMIT 50`,
        [w.id, brandId],
      ),
    ).toMatch(/task_by_freshness/);
    expect(
      await plan(
        `SELECT id FROM planning.task_reminder WHERE state = 'scheduled' AND remind_at <= now() ORDER BY remind_at, id LIMIT 500`,
        [],
      ),
    ).toMatch(/task_reminder_due/);
    expect(
      await plan(
        `SELECT id FROM planning.task_reminder WHERE workspace_id = $1 AND owner_membership_id = $2 AND state IN ('scheduled', 'fired') ORDER BY remind_at LIMIT 200`,
        [w.id, ownerMem.id],
      ),
      // One owner holds every seeded reminder, so any workspace-leading index is as selective.
    ).toMatch(/task_reminder_by_owner|task_reminder_by_task/);
    expect(
      await plan(
        `SELECT id FROM work.task WHERE workspace_id = $1 AND brand_id = $2 AND project_id IS NULL AND parent_task_id IS NULL ORDER BY rank, id LIMIT 50`,
        [w.id, brandId],
      ),
    ).toMatch(/task_projectless|task_rank_by_brand/);
    expect(
      await plan(
        `SELECT target_record_id, count(*) FROM audit.audit_event WHERE workspace_id = $1 AND target_record_id = ANY($2::uuid[]) AND action = 'task.updated' AND occurred_at >= now() - interval '14 days' GROUP BY 1`,
        [w.id, [newUuidV7()]],
      ),
    ).toMatch(/audit_event_by_target/);
    // The signals and duplicates services stay fast at this volume.
    const sample = (
      await db.admin(
        `SELECT public_id FROM core.record WHERE public_id = 'tsk_3' || lpad('42', 25, '0')`,
      )
    ).rows[0].public_id;
    let started = performance.now();
    await env.svc.taskSignals(w.owner, w.ws, sample);
    expect(performance.now() - started).toBeLessThan(2_000);
    started = performance.now();
    const d = await env.svc.duplicateCandidates(w.owner, w.ws, {
      brand: w.brand,
      title: 'Task 42',
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(d.candidates.length).toBe(5);
  });
});
