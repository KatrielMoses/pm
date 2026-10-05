import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@pm/db';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import {
  join,
  membershipOf,
  mutation,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const TABLES = [
  'workflow.workflow',
  'workflow.workflow_status',
  'workflow.transition',
  'workflow.transition_requirement',
  'workflow.transition_approver',
  'workflow.approval_request',
  'workflow.approval_decision',
  'workflow.field_definition',
  'workflow.field_option',
  'workflow.formula_dependency',
  'workflow.field_value',
  'workflow.field_set',
  'workflow.field_set_version',
  'workflow.field_set_attachment',
  'access.field_policy',
];

/**
 * Phase 2C on real PostgreSQL beyond the behavior suites: direct-role and pooled-connection
 * isolation for every workflow and field table across workspaces, the worker's read-only reach,
 * and query plans at 5,000 records × 10 fields (50,000 values) for workflow resolution,
 * transitions, values, options, formula dependencies, approval queues, and set attachments.
 */
describe('workflow and field isolation and query plans (2C)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  const W: Record<
    'a' | 'b',
    { owner: Caller; ws: string; id: string; brands: Record<string, string> }
  > = {} as never;
  let pool: pg.Pool;

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

  /** One of everything in a workspace, through the services. */
  async function seed(w: (typeof W)['a']) {
    const brand = Object.values(w.brands)[0]!;
    const scope = `brand:${brand}`;
    const mgr = await join(env, db, w.owner, w.ws, { kind: 'member', role: 'administrator' });
    const mm = (await membershipOf(db, w.id, mgr.auth.account.id))!;
    const wf = (
      await env.svc.createWorkflow(
        w.owner,
        w.ws,
        {
          scope,
          record_kind: 'task',
          name: 'Flow',
          statuses: [
            { name: 'Open', category: 'planned' },
            { name: 'Shut', category: 'done' },
          ],
        },
        mutation(),
      )
    ).data;
    const [open, shut] = wf.statuses.map((s) => s.id);
    const sel = (
      await env.svc.createFieldDefinition(
        w.owner,
        w.ws,
        { scope, name: 'Tier', field_type: 'select', applies_to: ['task'] },
        mutation(),
      )
    ).data;
    await env.svc.addOption(
      w.owner,
      w.ws,
      sel.id,
      { label: 'Gold' },
      mutation({ ifMatch: `"${sel.version}"` }),
    );
    const num = (
      await env.svc.createFieldDefinition(
        w.owner,
        w.ws,
        {
          scope,
          name: 'Points',
          field_type: 'number',
          applies_to: ['task'],
          applicability: 'via_set',
        },
        mutation(),
      )
    ).data;
    await env.svc.createFieldDefinition(
      w.owner,
      w.ws,
      {
        scope,
        name: 'Double',
        field_type: 'formula',
        applies_to: ['task'],
        config: { source: `{${num.id}} * 2` },
      },
      mutation(),
    );
    await env.svc.addTransition(
      w.owner,
      w.ws,
      wf.id,
      {
        transition: {
          from: open,
          to: shut,
          approval_policy: 'all_named_approvers',
          approvers: [mm.public_id],
          requirements: [{ field: num.id }],
        },
      },
      mutation({ ifMatch: `"${wf.version}"` }),
    );
    const fs = (
      await env.svc.createFieldSet(
        w.owner,
        w.ws,
        { scope, name: 'Bug', applies_to: ['task'], items: [{ field: num.id }] },
        mutation(),
      )
    ).data;
    const t = (await env.svc.createTask(w.owner, w.ws, { brand, title: 'Seed' }, mutation())).data;
    await env.svc.applyFieldSet(
      w.owner,
      w.ws,
      t.id,
      { set: fs.id, version: t.version },
      mutation(),
    );
    const f = await env.svc.recordFields(w.owner, w.ws, t.id);
    await env.svc.updateRecordFields(
      w.owner,
      w.ws,
      t.id,
      { version: f.version, changes: { [num.id]: { value: '3' } } },
      mutation(),
    );
    const cur = await env.svc.getTask(w.owner, w.ws, t.id);
    const req = (
      await env.svc.requestApproval(
        w.owner,
        w.ws,
        t.id,
        { to: shut, version: cur.version },
        mutation(),
      )
    ).data;
    await env.svc.decideApproval(mgr, w.ws, req.id, { decision: 'approve' }, mutation());
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    for (const k of ['a', 'b'] as const) {
      const w = await workspaceWith(env, db, [`Brand ${k}`]);
      W[k] = { ...w, id: await workspaceIdOf(db, w.ws) };
      await seed(W[k]);
    }
    pool = new pg.Pool({ connectionString: db.app, max: 1 });
  });
  afterAll(async () => {
    await pool.end();
    await env.h.close();
    await db.drop();
  });

  it('direct app_rw on a pooled connection: no context sees nothing; each workspace only itself; approvals are append-only', async () => {
    for (const t of TABLES) {
      expect((await direct(pool, null, `SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(
        0,
      );
      expect(
        (await direct(pool, W.a.id, `SELECT DISTINCT workspace_id FROM ${t}`)).rows.map(
          (r) => r.workspace_id,
        ),
        t,
      ).toEqual([W.a.id]);
      expect(
        (await db.admin(`SELECT count(DISTINCT workspace_id)::int AS n FROM ${t}`)).rows[0].n,
        t,
      ).toBe(2);
    }
    const bReq = (
      await db.admin(`SELECT id FROM workflow.approval_request WHERE workspace_id = $1`, [W.b.id])
    ).rows[0].id;
    await expect(
      direct(
        pool,
        W.a.id,
        `UPDATE workflow.approval_request SET closed_at = now(), closed_reason = 'withdrawn' WHERE id = $1`,
        [bReq],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(direct(pool, W.a.id, `DELETE FROM workflow.approval_decision`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      direct(pool, W.a.id, `UPDATE workflow.approval_decision SET decision = 'reject'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      direct(pool, W.a.id, `UPDATE workflow.approval_request SET record_version = 0`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      direct(pool, W.a.id, `UPDATE workflow.field_set_version SET items = '[]'`),
    ).rejects.toThrow(/permission denied/);
    // A value cannot reference a definition of another workspace.
    const bDef = (
      await db.admin(
        `SELECT id FROM workflow.field_definition WHERE workspace_id = $1 AND field_type = 'number'`,
        [W.b.id],
      )
    ).rows[0].id;
    const aRec = (
      await db.admin(
        `SELECT id, brand_id FROM core.record WHERE workspace_id = $1 AND record_type = 'task' LIMIT 1`,
        [W.a.id],
      )
    ).rows[0];
    await expect(
      direct(
        pool,
        W.a.id,
        `INSERT INTO workflow.field_value (workspace_id, brand_id, definition_id, record_id, value) VALUES ($1, $2, $3, $4, '"1"')`,
        [W.a.id, aRec.brand_id, bDef, aRec.id],
      ),
    ).rejects.toThrow(/foreign key|unknown field/);
  });

  it('direct app_worker reads within one workspace and never edits configuration or values', async () => {
    expect(
      (
        await direct(db.worker, W.b.id, `SELECT DISTINCT workspace_id FROM workflow.field_value`)
      ).rows.map((r) => r.workspace_id),
    ).toEqual([W.b.id]);
    await expect(
      direct(db.worker, W.a.id, `UPDATE workflow.field_value SET value = '"9"'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      direct(db.worker, W.a.id, `UPDATE workflow.workflow SET name = 'x'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      direct(
        db.worker,
        W.a.id,
        `INSERT INTO workflow.approval_decision SELECT * FROM workflow.approval_decision LIMIT 0`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('EXPLAIN at 5,000 records × 10 fields: resolution, transitions, values, options, dependencies, approvals, attachments', async () => {
    const big = await workspaceWith(env, db, ['Volume']);
    const bid = await workspaceIdOf(db, big.ws);
    const brandId = (await db.admin(`SELECT id FROM tenancy.brand WHERE workspace_id = $1`, [bid]))
      .rows[0].id;
    const scope = `brand:${big.brands.Volume}`;
    for (let i = 0; i < 10; i++)
      await env.svc.createFieldDefinition(
        big.owner,
        big.ws,
        { scope, name: `F${i}`, field_type: 'number', applies_to: ['task'] },
        mutation(),
      );
    const defIds = (
      await db.admin(
        `SELECT id FROM workflow.field_definition WHERE workspace_id = $1 ORDER BY rank`,
        [bid],
      )
    ).rows.map((r) => r.id as string);
    const wf = (
      await env.svc.createWorkflow(
        big.owner,
        big.ws,
        {
          scope,
          record_kind: 'task',
          name: 'Big',
          statuses: [
            { name: 'A', category: 'planned' },
            { name: 'B', category: 'done' },
          ],
        },
        mutation(),
      )
    ).data;
    const bigSet = (
      await env.svc.createFieldSet(
        big.owner,
        big.ws,
        {
          scope,
          name: 'All',
          applies_to: ['task'],
          items: [
            {
              field: (
                await db.admin(
                  `SELECT public_id FROM workflow.field_definition WHERE workspace_id = $1 LIMIT 1`,
                  [bid],
                )
              ).rows[0].public_id,
            },
          ],
        },
        mutation(),
      )
    ).data;
    const setId = (
      await db.admin(`SELECT id FROM workflow.field_set WHERE public_id = $1`, [bigSet.id])
    ).rows[0].id;
    const stsA = (
      await db.admin(`SELECT id FROM workflow.workflow_status WHERE public_id = $1`, [
        wf.statuses[0]!.id,
      ])
    ).rows[0].id;
    await db.admin(
      `BEGIN; SET LOCAL session_replication_role = replica;
       CREATE TEMP TABLE vol ON COMMIT DROP AS SELECT uuidv7() AS id, i FROM generate_series(1, 5000) AS i;
       INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type)
         SELECT id, 'tsk_3' || lpad(i::text, 25, '0'), 'task', '${bid}', '${brandId}', 'system', 'system' FROM vol;
       INSERT INTO work.task (id, workspace_id, brand_id, scope_key, title, status_id, status_category, rank, ancestor_ids, depth)
         SELECT id, '${bid}', '${brandId}', '${brandId}', 'Task ' || i, '${stsA}', 'planned', lpad(i::text, 6, '0'), '{}', 0 FROM vol;
       INSERT INTO workflow.field_value (workspace_id, brand_id, definition_id, record_id, value, value_numeric)
         SELECT '${bid}', '${brandId}', d, v.id, to_jsonb((v.i % 97)::text), v.i % 97 FROM vol v, unnest(ARRAY[${defIds.map((x) => `'${x}'::uuid`).join(',')}]) AS d;
       INSERT INTO workflow.field_set_attachment (workspace_id, brand_id, record_id, field_set_id, version)
         SELECT '${bid}', '${brandId}', id, '${setId}', 1 FROM vol;
       COMMIT;`,
    );
    await db.admin(`ANALYZE ${TABLES.join(', ')}, work.task, core.record`);
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
    const rec = (await db.admin(`SELECT id FROM work.task WHERE workspace_id = $1 LIMIT 1`, [bid]))
      .rows[0].id;
    const wfId = (await db.admin(`SELECT id FROM workflow.workflow WHERE public_id = $1`, [wf.id]))
      .rows[0].id;
    expect(
      await plan(
        `SELECT definition_id, value FROM workflow.field_value WHERE workspace_id = $1 AND record_id = $2`,
        [bid, rec],
      ),
    ).toMatch(/field_value_by_record|field_value_pkey/);
    expect(
      await plan(
        `SELECT record_id FROM workflow.field_value WHERE workspace_id = $1 AND definition_id = $2 AND value_numeric > 50 ORDER BY value_numeric LIMIT 50`,
        [bid, defIds[0]],
      ),
    ).toMatch(/field_value_numeric/);
    expect(
      await plan(
        `SELECT id FROM workflow.workflow WHERE workspace_id = $1 AND record_kind = 'task' AND state = 'active' AND (scope_kind = 'workspace' OR brand_id = $2)`,
        [bid, brandId],
      ),
    ).toMatch(/workflow_by_scope|workflow_one_active|workflow_by_brand/);
    expect(
      await plan(
        `SELECT id FROM workflow.transition WHERE workspace_id = $1 AND workflow_id = $2 AND state = 'active' ORDER BY rank`,
        [bid, wfId],
      ),
    ).toMatch(/transition_by_workflow|transition_active_edge/);
    expect(
      await plan(
        `SELECT id FROM workflow.workflow_status WHERE workspace_id = $1 AND workflow_id = $2 AND state = 'active' ORDER BY rank`,
        [bid, wfId],
      ),
    ).toMatch(
      /workflow_status_by_workflow|workflow_status_active_name|workflow_status_workflow_key/,
    );
    expect(
      await plan(
        `SELECT id FROM workflow.field_definition WHERE workspace_id = $1 AND state = 'active' AND scope_kind = 'brand' AND brand_id = $2 ORDER BY rank`,
        [bid, brandId],
      ),
    ).toMatch(/field_definition_by_(scope|project|brand)|field_definition_active_name/);
    expect(
      await plan(
        `SELECT id FROM workflow.field_option WHERE workspace_id = $1 AND definition_id = $2 AND state = 'active' ORDER BY rank`,
        [bid, defIds[0]],
      ),
    ).toMatch(/field_option_by_definition|field_option_active_label|field_option_definition_key/);
    expect(
      await plan(
        `SELECT definition_id FROM workflow.formula_dependency WHERE workspace_id = $1 AND depends_on_definition_id = $2`,
        [bid, defIds[0]],
      ),
    ).toMatch(/"Index (Only )?Scan"/);
    expect(
      await plan(
        `SELECT id FROM workflow.approval_request WHERE workspace_id = $1 AND closed_at IS NULL AND expires_at > now() ORDER BY expires_at`,
        [bid],
      ),
    ).toMatch(/approval_request_open/);
    expect(
      await plan(
        `SELECT id FROM workflow.approval_request WHERE workspace_id = $1 AND record_id = $2 ORDER BY created_at DESC`,
        [bid, rec],
      ),
    ).toMatch(/approval_request_by_record/);
    expect(
      await plan(
        `SELECT field_set_id FROM workflow.field_set_attachment WHERE workspace_id = $1 AND record_id = $2`,
        [bid, rec],
      ),
    ).toMatch(/field_set_attachment_by_record|field_set_attachment_pkey/);
    expect(await plan(`SELECT count(*) FROM work.task WHERE status_id = $1`, [stsA])).toMatch(
      /task_by_status/,
    );
    // The record fields read path stays fast at this volume (10 values, one formula pass).
    const recPub = (await db.admin(`SELECT public_id FROM core.record WHERE id = $1`, [rec]))
      .rows[0].public_id;
    const t0 = performance.now();
    const f = await env.svc.recordFields(big.owner, big.ws, recPub);
    const ms = performance.now() - t0;
    expect(f.fields).toHaveLength(10);
    expect(ms).toBeLessThan(2000);
  });
});
