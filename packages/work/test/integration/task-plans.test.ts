import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql } from '@pm/db';
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

const TASK_TABLES = [
  'work.task',
  'work.task_assignee',
  'work.checklist_item',
  'work.task_inherited_criterion',
  'work.label',
  'work.task_label',
  'relations.record_link',
];

/**
 * Phase 2B on real PostgreSQL beyond the behavior suites: direct-role and pooled-connection
 * isolation for every task table across three workspaces, the worker's read-only reach, and query
 * plans and timings at 5,000 and 50,000 tasks including restricted projects and a grant-heavy
 * principal.
 */
describe('task isolation and query plans (2B)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  const W: Record<
    'a' | 'b' | 'c',
    { owner: Caller; ws: string; id: string; brands: Record<string, string> }
  > = {} as never;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    for (const [k, names] of [
      ['a', ['Harbor']],
      ['b', ['Harbor']],
      ['c', ['Delta']],
    ] as const) {
      const w = await workspaceWith(env, db, [...names]);
      W[k] = { ...w, id: await workspaceIdOf(db, w.ws) };
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

  it('direct app_rw on a pooled connection: no context sees nothing; each workspace only itself', async () => {
    for (const k of ['a', 'b'] as const) {
      const w = W[k];
      const brand = Object.values(w.brands)[0]!;
      const t = (await env.svc.createTask(w.owner, w.ws, { brand, title: `T ${k}` }, mutation()))
        .data;
      const m = (await membershipOf(db, w.id, w.owner.auth.account.id))!;
      await env.svc.setAssignees(
        w.owner,
        w.ws,
        t.id,
        { assignees: [m.public_id], version: t.version },
        mutation(),
      );
      await env.svc.addChecklistItem(w.owner, w.ws, t.id, { text: 'Step' }, mutation());
      const l = (await env.svc.createLabel(w.owner, w.ws, brand, { name: 'L' }, mutation())).data;
      await env.svc.addTaskLabel(w.owner, w.ws, t.id, { label: l.id }, mutation());
      await env.svc.addLink(w.owner, w.ws, t.id, { url: 'https://example.com' }, mutation());
      const prj = (await env.svc.createProject(w.owner, w.ws, { brand, name: 'P' }, mutation()))
        .data;
      await env.svc.addItem(
        w.owner,
        w.ws,
        prj.id,
        'criteria',
        { kind: 'definition_of_done', text: 'D' },
        mutation(),
      );
      const pt = (
        await env.svc.createTask(w.owner, w.ws, { project: prj.id, title: 'PT' }, mutation())
      ).data;
      const inh = (await env.svc.taskDetail(w.owner, w.ws, pt.id)).inherited_criteria[0]!;
      await env.svc.setInheritedCriterion(
        w.owner,
        w.ws,
        pt.id,
        inh.id,
        { state: 'met' },
        mutation(),
      );
    }
    for (const t of TASK_TABLES) {
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
      ).toBeGreaterThan(1);
    }
    expect(
      (await direct(pool, null, `SELECT exec.current_workspace_id() AS w`)).rows[0].w,
    ).toBeNull();
    const bTask = (
      await db.admin(`SELECT id, brand_id FROM work.task WHERE workspace_id = $1 LIMIT 1`, [W.b.id])
    ).rows[0];
    await expect(
      direct(pool, W.a.id, `UPDATE work.task SET title = 'pwned' WHERE id = $1`, [bTask.id]),
    ).resolves.toMatchObject({ rowCount: 0 });
    // A row in a whose task lives in b fails the same-workspace composite key.
    const aBrand = (
      await db.admin(`SELECT id FROM tenancy.brand WHERE workspace_id = $1 LIMIT 1`, [W.a.id])
    ).rows[0].id;
    await expect(
      direct(
        pool,
        W.a.id,
        `INSERT INTO work.checklist_item (id, public_id, workspace_id, brand_id, task_id, text, rank) VALUES ($1, $2, $3, $4, $5, 'x', 'a')`,
        [newUuidV7(), newPublicId('chk'), W.a.id, aBrand, bTask.id],
      ),
    ).rejects.toThrow(/foreign key/);
    // The application role cannot move a record's brand directly (only work.move_task_brand can).
    const aTask = (
      await db.admin(`SELECT id FROM work.task WHERE workspace_id = $1 LIMIT 1`, [W.a.id])
    ).rows[0].id;
    const aBrand2 = (await env.svc.createBrand(W.a.owner, W.a.ws, { name: 'Second' }, mutation()))
      .data.id;
    await expect(
      direct(
        pool,
        W.a.id,
        `UPDATE core.record SET brand_id = (SELECT id FROM core.record WHERE public_id = $2), version = version + 1 WHERE id = $1`,
        [aTask, aBrand2],
      ),
    ).rejects.toThrow(/immutable/);
    // The definer refuses a foreign or inconsistent move.
    await expect(
      direct(pool, W.a.id, `SELECT work.move_task_brand(ARRAY[$1::uuid], $2::uuid)`, [
        bTask.id,
        bTask.brand_id,
      ]),
    ).rejects.toThrow(/move the task rows/);
  });

  it('direct app_worker reads tasks only within one workspace and never edits them', async () => {
    const aTask = (
      await db.admin(`SELECT id FROM work.task WHERE workspace_id = $1 LIMIT 1`, [W.a.id])
    ).rows[0].id;
    expect(
      (await direct(db.worker, W.b.id, `SELECT id FROM work.task WHERE id = $1`, [aTask])).rows,
    ).toEqual([]);
    await expect(direct(db.worker, W.a.id, `UPDATE work.task SET title = 'x'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      direct(
        db.worker,
        W.a.id,
        `INSERT INTO work.task_assignee SELECT * FROM work.task_assignee LIMIT 0`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  for (const volume of [5_000, 50_000] as const)
    it(`EXPLAIN at ${volume.toLocaleString('en-US')} tasks: lists, children, assignees, labels, items, relationships, history; restricted and grant-heavy`, async () => {
      const big = await workspaceWith(env, db, [`Volume ${volume}`]);
      const bid = await workspaceIdOf(db, big.ws);
      const brandId = (
        await db.admin(`SELECT id FROM tenancy.brand WHERE workspace_id = $1`, [bid])
      ).rows[0].id;
      // Ten projects (three restricted); tasks spread over them, a third projectless; one level of
      // subtasks; assignees, labels, checklist items, and blocks edges on a fraction.
      const prjIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const prj = (
          await env.svc.createProject(
            big.owner,
            big.ws,
            { brand: Object.values(big.brands)[0], name: `P${i}` },
            mutation(),
          )
        ).data;
        if (i < 3)
          await env.svc.setAccess(
            big.owner,
            big.ws,
            prj.id,
            { access_mode: 'restricted' },
            mutation(),
          );
        prjIds.push(
          (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [prj.id])).rows[0].id,
        );
      }
      const member = await join(env, db, big.owner, big.ws, { kind: 'member', role: 'member' });
      const mem = (await membershipOf(db, bid, member.auth.account.id))!;
      // Grant-heavy principal: explicit grants on every project.
      for (const prjId of prjIds) {
        const pub = (await db.admin(`SELECT public_id FROM core.record WHERE id = $1`, [prjId]))
          .rows[0].public_id;
        await apply(env, big.owner, big.ws, {
          kind: 'project_grant',
          project: pub,
          principal: mem.public_id,
          level: 'edit',
        });
      }
      const ownerMem = (await membershipOf(db, bid, big.owner.auth.account.id))!;
      await db.admin(
        `BEGIN; SET LOCAL session_replication_role = replica;
         CREATE TEMP TABLE vol ON COMMIT DROP AS
           SELECT uuidv7() AS id, i, CASE WHEN i % 3 = 0 THEN NULL ELSE (ARRAY[${prjIds.map((x) => `'${x}'`).join(',')}]::uuid[])[(i % 10) + 1] END AS project_id
             FROM generate_series(1, ${volume}) AS i;
         INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type)
           SELECT id, 'tsk_${volume === 5000 ? '1' : '2'}' || lpad(i::text, 25, '0'), 'task', '${bid}', '${brandId}', 'system', 'system' FROM vol;
         INSERT INTO work.task (id, workspace_id, brand_id, scope_key, project_id, title, status_id, status_category, rank, ancestor_ids, depth)
           SELECT id, '${bid}', '${brandId}', '${brandId}', project_id, 'Task ' || i, '01920000-0000-7000-8000-000000000007', 'planned', lpad(i::text, 6, '0'), '{}', 0 FROM vol;
         -- Every 10th task becomes a child of the task before it (same project identity).
         UPDATE work.task c SET parent_task_id = p.id, ancestor_ids = ARRAY[p.id], depth = 1
           FROM vol cv JOIN vol pv ON pv.i = cv.i - 3 JOIN work.task p ON p.id = pv.id
          WHERE c.id = cv.id AND cv.i % 10 = 4;
         INSERT INTO work.task_assignee (workspace_id, brand_id, task_id, membership_id, is_primary, rank)
           SELECT '${bid}', '${brandId}', id, '${ownerMem.id}', true, '1' FROM vol WHERE i % 4 = 0;
         INSERT INTO work.label (id, public_id, workspace_id, brand_id, name, normalized_name, color, rank)
           SELECT uuidv7(), 'lbl_${volume === 5000 ? '1' : '2'}' || lpad(g::text, 25, '0'), '${bid}', '${brandId}', 'L' || g, 'l' || g, '#6b7280', lpad(g::text, 4, '0')
             FROM generate_series(1, 40) AS g;
         INSERT INTO work.task_label (workspace_id, brand_id, task_id, label_id)
           SELECT '${bid}', '${brandId}', v.id, l.id FROM vol v JOIN work.label l ON l.workspace_id = '${bid}' AND l.name = 'L' || ((v.i % 40) + 1) WHERE v.i % 6 = 0;
         INSERT INTO work.checklist_item (id, public_id, workspace_id, brand_id, task_id, text, rank)
           SELECT uuidv7(), 'chk_${volume === 5000 ? '1' : '2'}' || lpad(i::text, 25, '0'), '${bid}', '${brandId}', id, 'Step', '1' FROM vol WHERE i % 5 = 0;
         INSERT INTO relations.record_relationship (id, workspace_id, kind, from_record_id, to_record_id, from_brand_id, to_brand_id)
           SELECT uuidv7(), '${bid}', 'blocks', a.id, b.id, '${brandId}', '${brandId}' FROM vol a JOIN vol b ON b.i = a.i + 1 WHERE a.i % 7 = 0;
         COMMIT;`,
      );
      await db.admin(
        `ANALYZE ${TASK_TABLES.join(', ')}, relations.record_relationship, core.record, access.role_assignment, audit.audit_event`,
      );
      const plan = async (query: string, params: unknown[]) =>
        env.h.app.withWorkspace(bid, { module: 'test' }, async (tx) => {
          await sql`SET LOCAL enable_seqscan = off`.execute(tx.db);
          const r = await tx.db.executeQuery({
            sql: `EXPLAIN (FORMAT JSON) ${query}`,
            parameters: params,
            query: { kind: 'RawNode' },
          } as never);
          return JSON.stringify((r as { rows: unknown[] }).rows);
        });
      const sample = (
        await db.admin(
          `SELECT id, project_id FROM work.task WHERE workspace_id = $1 AND project_id IS NOT NULL AND depth = 0 LIMIT 1`,
          [bid],
        )
      ).rows[0];
      expect(
        await plan(
          `SELECT id FROM work.task WHERE workspace_id = $1 AND project_id = $2 AND parent_task_id IS NULL ORDER BY rank, id LIMIT 50`,
          [bid, sample.project_id],
        ),
      ).toMatch(/task_by_project|task_by_brand_project/);
      expect(
        await plan(
          `SELECT id FROM work.task WHERE workspace_id = $1 AND parent_task_id = $2 ORDER BY rank, id`,
          [bid, sample.id],
        ),
      ).toMatch(/task_children/);
      expect(
        await plan(
          `SELECT id FROM work.task WHERE workspace_id = $1 AND brand_id = $2 AND project_id IS NULL ORDER BY rank, id LIMIT 50`,
          [bid, brandId],
        ),
      ).toMatch(/task_projectless/);
      expect(
        await plan(
          // A person's assignments (My Work, 3B): selective for a typical member.
          `SELECT task_id FROM work.task_assignee WHERE workspace_id = $1 AND membership_id = $2`,
          [bid, mem.id],
        ),
      ).toMatch(/task_assignee_by_membership/);
      expect(
        await plan(
          `SELECT membership_id FROM work.task_assignee WHERE workspace_id = $1 AND task_id = $2 ORDER BY rank`,
          [bid, sample.id],
        ),
      ).toMatch(/task_assignee_by_task|task_assignee_pkey/);
      expect(
        await plan(
          `SELECT id FROM work.checklist_item WHERE workspace_id = $1 AND task_id = $2 ORDER BY rank, id`,
          [bid, sample.id],
        ),
      ).toMatch(/checklist_item_by_task/);
      expect(
        await plan(
          `SELECT label_id FROM work.task_label WHERE workspace_id = $1 AND task_id = $2`,
          [bid, sample.id],
        ),
      ).toMatch(/task_label_by_task|task_label_pkey/);
      expect(
        await plan(
          `SELECT id FROM work.criteria_item WHERE workspace_id = $1 AND task_id = $2 ORDER BY kind, rank, id`,
          [bid, sample.id],
        ),
      ).toMatch(/criteria_item_by_task/);
      expect(
        await plan(
          `SELECT id FROM relations.record_link WHERE workspace_id = $1 AND source_record_id = $2 ORDER BY rank, id`,
          [bid, sample.id],
        ),
      ).toMatch(/record_link_by_source/);
      expect(
        await plan(
          `SELECT to_record_id FROM relations.record_relationship WHERE workspace_id = $1 AND from_record_id = $2 AND kind = 'blocks'`,
          [bid, sample.id],
        ),
      ).toMatch(/record_relationship_by_from/);
      expect(
        await plan(
          `SELECT from_record_id FROM relations.record_relationship WHERE workspace_id = $1 AND to_record_id = $2 AND kind = 'blocks'`,
          [bid, sample.id],
        ),
      ).toMatch(/record_relationship_by_to/);
      expect(
        await plan(
          `SELECT id FROM audit.audit_event WHERE workspace_id = $1 AND target_record_id = $2 ORDER BY occurred_at DESC LIMIT 50`,
          [bid, sample.id],
        ),
      ).toMatch(/audit_event_by_target/);
      // The real list commands end to end: the grant-heavy member and the owner (restricted projects).
      const timed = async (who: Caller, query: Record<string, unknown>) => {
        const t0 = performance.now();
        const r = await env.svc.listTasks(who, big.ws, query);
        return { r, ms: performance.now() - t0 };
      };
      const memberList = await timed(member, { limit: '50' });
      const ownerList = await timed(big.owner, { limit: '50' });
      const projectList = await timed(member, {
        project: (await db.admin(`SELECT public_id FROM core.record WHERE id = $1`, [prjIds[0]]))
          .rows[0].public_id,
        parent: 'root',
        limit: '50',
      });
      expect(memberList.r.data).toHaveLength(50);
      expect(memberList.r.total.value).toBe(volume - Math.floor(volume / 3));
      expect(ownerList.r.total.value).toBe(volume);
      console.info(
        `[2B plans] ${volume} tasks: member list ${memberList.ms.toFixed(1)} ms, owner list ${ownerList.ms.toFixed(1)} ms, restricted project page ${projectList.ms.toFixed(1)} ms`,
      );
      // Sanity bound only (evidence, not a performance target).
      for (const x of [memberList, ownerList, projectList]) expect(x.ms).toBeLessThan(5000);
      await db.admin(
        `BEGIN; SET LOCAL session_replication_role = replica;
         DELETE FROM relations.record_relationship WHERE workspace_id = '${bid}';
         DELETE FROM work.checklist_item WHERE workspace_id = '${bid}';
         DELETE FROM work.task_assignee WHERE workspace_id = '${bid}';
         DELETE FROM work.task_label WHERE workspace_id = '${bid}';
         DELETE FROM work.label WHERE workspace_id = '${bid}';
         DELETE FROM work.task WHERE workspace_id = '${bid}' AND title LIKE 'Task %';
         COMMIT;`,
      );
    });
});
