import pg from 'pg';
import { sql } from '@pm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson, newPublicId, newUuidV7, richTextFromPlain } from '@pm/contracts';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { DEFAULT_WORK_SETTINGS, recurrenceHandler } from '@pm/work';
import type { Caller } from '@pm/tenancy';
import { merge, mutation, workEnv, workspaceIdOf, workspaceWith, type WorkEnv } from './fixture.ts';

const issueOf = (code: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });

const WORK_TABLES = [
  'work.project',
  'work.phase',
  'work.milestone',
  'work.criteria_item',
  'work.scope_item',
  'work.project_update',
  'work.project_update_verification',
  'work.decision_record',
  'relations.record_relationship',
  'templates.template',
  'templates.template_version',
  'planning.recurrence_series',
];

/**
 * Phase 2A contracts on real PostgreSQL that the behavior suites do not already pin: planning and
 * budget fields, the status-based completion basis, intake provenance (PRJ-017 contribution),
 * concurrent hierarchy commands, query plans, and direct-role, pooled-connection, and worker
 * isolation across three workspaces.
 */
describe('project contracts, concurrency, plans, and isolation (2A)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  const W: Record<
    'a' | 'b' | 'c',
    { owner: Caller; ws: string; id: string; brands: Record<string, string> }
  > = {} as never;
  let pool: pg.Pool;

  const create = (body: Record<string, unknown>, k: 'a' | 'b' | 'c' = 'a') =>
    env.svc.createProject(W[k].owner, W[k].ws, body, mutation()).then((r) => r.data);

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    for (const [k, names] of [
      ['a', ['Harbor', 'Summit']],
      ['b', ['Harbor']],
      ['c', ['Delta']],
    ] as const) {
      const w = await workspaceWith(env, db, [...names]);
      W[k] = { ...w, id: await workspaceIdOf(db, w.ws) };
    }
    // One connection reused for every direct statement: transaction-local context must not leak.
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

  it('planning fields: dates, deadline, manual health, budgets, and the status-based completion basis', async () => {
    const p = await create({
      brand: W.a.brands.Harbor,
      name: 'Budgeted',
      start_date: '2026-11-01',
      target_date: '2026-12-15',
      deadline_date: '2026-12-31',
      budget_amount: '12500.50',
      budget_currency: 'EUR',
      time_budget_minutes: 6000,
      ai_budget_micros: 25_000_000,
    });
    expect(p).toMatchObject({
      start_date: '2026-11-01',
      target_date: '2026-12-15',
      deadline_date: '2026-12-31',
      budget: { amount: '12500.50', currency: 'EUR' },
      time_budget_minutes: 6000,
      ai_budget_micros: '25000000',
      health: null,
      completion: { percent: 0, basis: 'status' },
    });
    await expect(
      create({ brand: W.a.brands.Harbor, name: 'Bad', budget_amount: '-1' }),
    ).rejects.toEqual(issueOf('invalid_number'));
    await expect(
      create({ brand: W.a.brands.Harbor, name: 'Bad', start_date: '2026-13-40' }),
    ).rejects.toEqual(issueOf('invalid_date'));
    // Completing the project is the only thing that moves status-based completion (OD-13).
    const done = await env.svc.updateProject(
      W.a.owner,
      W.a.ws,
      p.id,
      merge(p.version, {
        status: { base: 'planned', value: 'completed' },
        health: { base: null, value: 'on_track' },
      }),
      mutation({ ifMatch: `"${p.version}"` }),
    );
    expect(done.data).toMatchObject({
      status: { key: 'completed', category: 'done' },
      health: { value: 'on_track', source: 'manual' },
      completion: { percent: 100, basis: 'status' },
    });
    // Budgets are content-class: audit records that they changed, never their values.
    const audit = await db.admin(
      `SELECT changes::text AS c FROM audit.audit_event e JOIN core.record r ON r.id = e.target_record_id
        WHERE r.public_id = $1`,
      [p.id],
    );
    expect(audit.rows.map((r) => r.c).join(' ')).not.toContain('12500');
  });

  it('intake provenance: a readable form in the brand is recorded; unknown and foreign sources are one refusal', async () => {
    const formId = newUuidV7();
    const formPublic = newPublicId('form');
    await db.admin(
      `INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type)
       VALUES ($1, $2, 'intake_form', $3, (SELECT id FROM core.record WHERE public_id = $4), 'system', 'system')`,
      [formId, formPublic, W.a.id, W.a.brands.Harbor],
    );
    const p = await create({
      brand: W.a.brands.Harbor,
      name: 'From a request',
      intake_source: formPublic,
    });
    const row = await db.admin(
      `SELECT w.intake_source_id, r.source_kind FROM work.project w JOIN core.record r ON r.id = w.id WHERE r.public_id = $1`,
      [p.id],
    );
    expect(row.rows[0]).toEqual({ intake_source_id: formId, source_kind: 'form' });
    // A form in another workspace and a guessed identifier fail identically.
    const foreignPublic = newPublicId('form');
    await db.admin(
      `INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type)
       VALUES ($1, $2, 'intake_form', $3, (SELECT id FROM core.record WHERE public_id = $4), 'system', 'system')`,
      [newUuidV7(), foreignPublic, W.b.id, W.b.brands.Harbor],
    );
    const refusals = await Promise.all(
      [foreignPublic, newPublicId('form')].map((src) =>
        create({ brand: W.a.brands.Harbor, name: 'x', intake_source: src }).catch(
          (e: unknown) => e,
        ),
      ),
    );
    expect(refusals[0]).toEqual(issueOf('invalid_reference'));
    expect(JSON.stringify(refusals[0])).toEqual(JSON.stringify(refusals[1]));
  });

  it('concurrent reparenting cannot create a cycle; concurrent reorders keep distinct ranks', async () => {
    for (let round = 0; round < 3; round++) {
      const x = await create({ brand: W.a.brands.Summit, name: `X${round}` });
      const y = await create({ brand: W.a.brands.Summit, name: `Y${round}` });
      const results = await Promise.allSettled([
        env.svc.moveProject(W.a.owner, W.a.ws, x.id, { parent: y.id }, mutation()),
        env.svc.moveProject(W.a.owner, W.a.ws, y.id, { parent: x.id }, mutation()),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toEqual(issueOf('cycle'));
    }
    // No row is its own ancestor, and every depth matches its ancestry (stale ancestry never commits).
    const bad = await db.admin(
      `SELECT id FROM work.project WHERE id = ANY(ancestor_ids) OR depth <> cardinality(ancestor_ids)`,
    );
    expect(bad.rows).toEqual([]);
    const parent = await create({ brand: W.a.brands.Summit, name: 'Siblings' });
    const kids = [];
    for (const n of ['k1', 'k2', 'k3', 'k4'])
      kids.push(await create({ parent: parent.id, name: n }));
    await Promise.allSettled([
      env.svc.moveProject(
        W.a.owner,
        W.a.ws,
        kids[0]!.id,
        { parent: parent.id, after: kids[3]!.id },
        mutation(),
      ),
      env.svc.moveProject(
        W.a.owner,
        W.a.ws,
        kids[1]!.id,
        { parent: parent.id, after: kids[3]!.id },
        mutation(),
      ),
      env.svc.moveProject(
        W.a.owner,
        W.a.ws,
        kids[2]!.id,
        { parent: parent.id, after: null },
        mutation(),
      ),
    ]);
    const ranks = await db.admin(
      `SELECT rank FROM work.project WHERE parent_project_id = (SELECT id FROM core.record WHERE public_id = $1)`,
      [parent.id],
    );
    expect(new Set(ranks.rows.map((r) => r.rank)).size).toBe(4);
  });

  it('EXPLAIN: lists, children, subtrees, scope, structures, dependencies, project assignments, and recurrence use their indexes', async () => {
    // Plans are judged at a realistic volume in a scratch workspace: 5,000 projects across the
    // five statuses, 100 roots with 49 children each, three of each structure row for 2,000 of them
    // (bulk fixture rows written with triggers off, then removed), analyzed.
    const scratch = await workspaceWith(env, db, ['Volume']);
    const sid = await workspaceIdOf(db, scratch.ws);
    const seeded = await db.admin(
      `BEGIN; SET LOCAL session_replication_role = replica;
       INSERT INTO work.project (id, workspace_id, brand_id, scope_key, name, status_id, status_category,
                                 owner_membership_id, rank, parent_project_id, ancestor_ids, depth, completed_at)
       SELECT gen_random_uuid(), w.id, b.id, b.id, 'P' || i, s.id, s.category, m.id, lpad(i::text, 6, '0'), NULL, '{}', 0,
              CASE WHEN s.category = 'done' THEN now() END
         FROM generate_series(1, 5000) AS i
         JOIN tenancy.workspace w ON w.id = '${sid}'
         JOIN tenancy.brand b ON b.workspace_id = w.id
         JOIN LATERAL (SELECT id FROM tenancy.membership WHERE workspace_id = w.id LIMIT 1) m ON true
         JOIN LATERAL (SELECT id, category FROM workflow.platform_status ORDER BY id OFFSET (i % 5) LIMIT 1) s ON true;
       -- Projects 101..5000 become children of the first 100 (one level of real ancestry).
       WITH roots AS (SELECT id, row_number() OVER (ORDER BY rank) AS n FROM work.project
                       WHERE workspace_id = '${sid}' AND name LIKE 'P%' AND rank <= '000100')
       UPDATE work.project c SET parent_project_id = r.id, ancestor_ids = ARRAY[r.id], depth = 1
         FROM roots r
        WHERE c.workspace_id = '${sid}' AND c.name LIKE 'P%' AND c.rank > '000100'
          AND r.n = (substring(c.rank from 4)::int % 100) + 1;
       -- Three of each structure row for 2,000 of the projects.
       CREATE TEMP TABLE vol ON COMMIT DROP AS
         SELECT p.id AS project_id, p.brand_id, k, row_number() OVER () AS n
           FROM (SELECT id, brand_id FROM work.project WHERE workspace_id = '${sid}' ORDER BY rank LIMIT 2000) p
          CROSS JOIN generate_series(1, 3) AS k;
       INSERT INTO work.phase (id, workspace_id, brand_id, scope_key, project_id, name, rank)
         SELECT gen_random_uuid(), '${sid}', brand_id, brand_id, project_id, 'Phase ' || k, k::text FROM vol;
       INSERT INTO work.milestone (id, workspace_id, brand_id, scope_key, project_id, name, rank)
         SELECT gen_random_uuid(), '${sid}', brand_id, brand_id, project_id, 'Milestone ' || k, k::text FROM vol;
       INSERT INTO work.criteria_item (id, public_id, workspace_id, brand_id, project_id, kind, text, rank)
         SELECT gen_random_uuid(), 'cri_' || lpad(n::text, 26, '0'), '${sid}', brand_id, project_id, 'success', 'Done', k::text FROM vol;
       INSERT INTO work.scope_item (id, public_id, workspace_id, brand_id, project_id, kind, text, rank)
         SELECT gen_random_uuid(), 'sco_' || lpad(n::text, 26, '0'), '${sid}', brand_id, project_id, 'risk', 'Risk', k::text FROM vol;
       INSERT INTO work.project_update (id, public_id, workspace_id, brand_id, project_id, body, source_kind)
         SELECT gen_random_uuid(), 'pup_' || lpad(n::text, 26, '0'), '${sid}', brand_id, project_id, 'Update', 'system' FROM vol;
       INSERT INTO work.decision_record (id, workspace_id, brand_id, scope_key, project_id, kind, state, statement)
         SELECT gen_random_uuid(), '${sid}', brand_id, brand_id, project_id, 'open_question', 'open', 'Q' FROM vol;
       -- Each project blocks the next one; every project has an explicit manager assignment.
       INSERT INTO relations.record_relationship (id, workspace_id, kind, from_record_id, to_record_id, from_brand_id, to_brand_id)
         SELECT gen_random_uuid(), '${sid}', 'blocks', a.id, b.id, a.brand_id, b.brand_id
           FROM work.project a JOIN work.project b ON b.workspace_id = a.workspace_id AND b.rank = lpad((a.rank::int + 1)::text, 6, '0')
          WHERE a.workspace_id = '${sid}';
       INSERT INTO access.role_assignment (id, workspace_id, principal_type, principal_id, scope_type, scope_id,
                                           role_id, role_kind, grant_source)
         SELECT uuidv7(), '${sid}', 'membership', p.owner_membership_id, 'project', p.id, t.role_id, t.role_kind, 'project_manager'
           FROM work.project p
           CROSS JOIN (SELECT role_id, role_kind FROM access.role_assignment WHERE grant_source = 'project_manager' LIMIT 1) t
          WHERE p.workspace_id = '${sid}';
       COMMIT;`,
    );
    expect(seeded).toBeDefined();
    const plan = async (query: string, params: unknown[]) =>
      env.h.app.withWorkspace(sid, { module: 'test' }, async (tx) => {
        await sql`SET LOCAL enable_seqscan = off`.execute(tx.db);
        const r = await tx.db.executeQuery({
          sql: `EXPLAIN (FORMAT JSON) ${query}`,
          parameters: params,
          query: { kind: 'RawNode' },
        } as never);
        return JSON.stringify((r as { rows: unknown[] }).rows);
      });
    await db.admin(
      `ANALYZE ${WORK_TABLES.join(', ')}, access.role_assignment, access.record_grant`,
    );
    const brandId = (await db.admin(`SELECT id FROM tenancy.brand WHERE workspace_id = $1`, [sid]))
      .rows[0].id;
    const id = newUuidV7();
    const root = (
      await db.admin(`SELECT id FROM work.project WHERE workspace_id = $1 AND depth = 0 LIMIT 1`, [
        sid,
      ])
    ).rows[0].id;
    expect(
      await plan(
        `SELECT id FROM work.project WHERE workspace_id = $1 AND brand_id = $2 AND lifecycle_state = 'active'
          AND status_category = 'active' ORDER BY rank, id LIMIT 200`,
        [sid, brandId],
      ),
    ).toMatch(/project_list/);
    expect(
      await plan(
        `SELECT id FROM work.project WHERE workspace_id = $1 AND parent_project_id = $2 ORDER BY rank, id`,
        [sid, root],
      ),
    ).toMatch(/project_children/);
    // Subtree walks (move depth and ancestry rewrite) and the principal's project scope seed from
    // indexes (project_children; the restricted partial index and the key) and descend by parent.
    // Array predicates are not leakproof, so under RLS they could never use an index. The recursive
    // join method (index loop or one hash of the workspace's projects) stays the planner's choice
    // by volume; with no restrictions or grants the recursion has nothing to join.
    const walk = await plan(
      `WITH RECURSIVE sub AS (
         SELECT id, depth FROM work.project WHERE parent_project_id = $1
         UNION ALL SELECT c.id, c.depth FROM work.project c JOIN sub ON c.parent_project_id = sub.id)
       SELECT max(depth) FROM sub`,
      [root],
    );
    expect(walk).toMatch(/project_children/);
    const scope = await plan(
      `WITH RECURSIVE sub AS (
         SELECT d.id, d.parent_project_id FROM work.project d WHERE d.access_mode = 'restricted' OR d.id = ANY($1::uuid[])
         UNION ALL SELECT c.id, c.parent_project_id FROM work.project c JOIN sub ON c.parent_project_id = sub.id)
       SELECT DISTINCT id FROM sub`,
      [[root]],
    );
    expect(scope).toMatch(/project_restricted/);
    expect(scope).toMatch(/project_pkey/);
    const pid = (
      await db.admin(`SELECT project_id FROM work.phase WHERE workspace_id = $1 LIMIT 1`, [sid])
    ).rows[0].project_id;
    for (const [query, index] of [
      [
        `SELECT id FROM work.phase WHERE workspace_id = $1 AND project_id = $2 ORDER BY rank, id`,
        'phase_by_project',
      ],
      [
        `SELECT id FROM work.milestone WHERE workspace_id = $1 AND project_id = $2 ORDER BY rank, id`,
        'milestone_by_project',
      ],
      [
        `SELECT id FROM work.criteria_item WHERE workspace_id = $1 AND project_id = $2 ORDER BY kind, rank, id`,
        'criteria_item_by_project',
      ],
      [
        `SELECT id FROM work.scope_item WHERE workspace_id = $1 AND project_id = $2 ORDER BY kind, rank, id`,
        'scope_item_by_project',
      ],
      [
        `SELECT id FROM work.decision_record WHERE workspace_id = $1 AND project_id = $2 ORDER BY kind, state, created_at DESC`,
        'decision_record_by_project',
      ],
      [
        `SELECT id FROM work.project_update WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at DESC, id LIMIT 20`,
        'project_update_by_project',
      ],
    ] as const)
      expect(await plan(query, [sid, pid]), index).toContain(index);
    expect(
      await plan(
        `SELECT to_record_id FROM relations.record_relationship WHERE workspace_id = $1 AND from_record_id = $2 AND kind = 'blocks'`,
        [sid, root],
      ),
    ).toMatch(/record_relationship_by_from/);
    expect(
      await plan(
        `SELECT from_record_id FROM relations.record_relationship WHERE workspace_id = $1 AND to_record_id = $2 AND kind = 'blocks'`,
        [sid, root],
      ),
    ).toMatch(/record_relationship_by_to/);
    expect(
      await plan(
        `SELECT id FROM access.role_assignment WHERE workspace_id = $1 AND project_scope_id = $2`,
        [sid, id],
      ),
    ).toMatch(/role_assignment_by_project/);
    expect(
      await plan(
        `SELECT id FROM work.project WHERE workspace_id = $1 AND recurrence_series_id = $2 AND occurrence_key = $3`,
        [sid, id, '2026-01-01T09:00'],
      ),
    ).toMatch(/project_occurrence_unique|project_by_recurrence/);
    // The dispatcher's cross-workspace due-work discovery uses the partial due index.
    const discovery = (await db.admin(
      `BEGIN; SET LOCAL enable_seqscan = off;
       EXPLAIN (FORMAT JSON) SELECT workspace_id FROM planning.recurrence_series WHERE state = 'active' AND next_due_at <= now();
       COMMIT;`,
    )) as unknown as Array<{ rows: unknown[] }>;
    expect(JSON.stringify(discovery[2]!.rows)).toMatch(/recurrence_series_(due|fair)/);
    await db.admin(
      `BEGIN; SET LOCAL session_replication_role = replica;
       ${WORK_TABLES.filter((t) => t.startsWith('work.'))
         .map((t) => `DELETE FROM ${t} WHERE workspace_id = '${sid}';`)
         .join('\n')}
       COMMIT;`,
    );
  });

  it('direct app_rw on a pooled connection: no context sees nothing; each workspace sees only itself', async () => {
    // Give every Phase 2A table at least one row in two workspaces.
    for (const k of ['a', 'b'] as const) {
      const brand = Object.values(W[k].brands)[0]!;
      const p = await create({ brand, name: `Full ${k}` }, k);
      const dep = await create({ brand, name: `Dep ${k}` }, k);
      const as = W[k].owner;
      await env.svc.createPhase(as, W[k].ws, p.id, { name: 'Phase' }, mutation());
      await env.svc.createMilestone(as, W[k].ws, p.id, { name: 'Milestone' }, mutation());
      await env.svc.addItem(
        as,
        W[k].ws,
        p.id,
        'criteria',
        { kind: 'success', text: 'Done' },
        mutation(),
      );
      await env.svc.addItem(as, W[k].ws, p.id, 'scope', { kind: 'risk', text: 'Risk' }, mutation());
      const u = await env.svc.postUpdate(as, W[k].ws, p.id, { body: 'Update' }, mutation());
      await env.svc.verifyUpdate(as, W[k].ws, p.id, u.data.id, mutation());
      await env.svc.createDecision(
        as,
        W[k].ws,
        p.id,
        { kind: 'decision', statement: 'S' },
        mutation(),
      );
      await env.svc.addDependency(as, W[k].ws, p.id, { target: dep.id }, mutation());
      await env.svc.createTemplateFromProject(as, W[k].ws, p.id, { name: `T ${k}` }, mutation());
      await env.svc.defineRecurrence(
        as,
        W[k].ws,
        p.id,
        { frequency: 'yearly', anchor_tz: 'UTC', start: '2030-01-01T09:00' },
        mutation(),
      );
    }
    for (const t of WORK_TABLES) {
      expect((await direct(pool, null, `SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(
        0,
      );
      const scoped = await direct(pool, W.a.id, `SELECT DISTINCT workspace_id FROM ${t}`);
      expect(
        scoped.rows.map((r) => r.workspace_id),
        t,
      ).toEqual([W.a.id]);
      const total = (await db.admin(`SELECT count(DISTINCT workspace_id)::int AS n FROM ${t}`))
        .rows[0].n;
      expect(total, t).toBeGreaterThan(1);
    }
    expect(
      (await direct(pool, null, `SELECT exec.current_workspace_id() AS w`)).rows[0].w,
    ).toBeNull();
    // Writes into another workspace's rows affect nothing; forged inserts are refused.
    const bProject = (
      await db.admin(`SELECT id, brand_id FROM work.project WHERE workspace_id = $1 LIMIT 1`, [
        W.b.id,
      ])
    ).rows[0];
    await expect(
      direct(pool, W.a.id, `UPDATE work.project SET name = 'pwned' WHERE id = $1`, [bProject.id]),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      direct(
        pool,
        W.a.id,
        `INSERT INTO work.scope_item (id, public_id, workspace_id, brand_id, project_id, kind, text, rank)
         VALUES ($1, $2, $3, $4, $5, 'risk', 'x', 'a')`,
        [newUuidV7(), newPublicId('sco'), W.b.id, bProject.brand_id, bProject.id],
      ),
    ).rejects.toThrow(/row-level security|violates/);
    // A row in a whose project lives in b fails the same-workspace composite key.
    const aBrand = (
      await db.admin(`SELECT id FROM tenancy.brand WHERE workspace_id = $1 LIMIT 1`, [W.a.id])
    ).rows[0].id;
    await expect(
      direct(
        pool,
        W.a.id,
        `INSERT INTO work.scope_item (id, public_id, workspace_id, brand_id, project_id, kind, text, rank)
         VALUES ($1, $2, $3, $4, $5, 'risk', 'x', 'a')`,
        [newUuidV7(), newPublicId('sco'), W.a.id, aBrand, bProject.id],
      ),
    ).rejects.toThrow(/foreign key/);
    // Append-only facts stay append-only even for the application role.
    await expect(
      direct(pool, W.a.id, `UPDATE work.project_update SET body = 'edited'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      direct(pool, W.a.id, `DELETE FROM work.project_update_verification`),
    ).rejects.toThrow(/permission denied/);
  });

  it('direct app_worker and the recurrence job: scoped to one workspace; foreign series are invisible', async () => {
    const aSeries = (
      await db.admin(`SELECT id FROM planning.recurrence_series WHERE workspace_id = $1 LIMIT 1`, [
        W.a.id,
      ])
    ).rows[0].id;
    // The worker role in workspace b cannot see or advance a's series (forged payload ids).
    expect(
      (
        await direct(db.worker, W.b.id, `SELECT id FROM planning.recurrence_series WHERE id = $1`, [
          aSeries,
        ])
      ).rows,
    ).toEqual([]);
    await expect(
      direct(
        db.worker,
        W.b.id,
        `UPDATE planning.recurrence_series SET next_due_at = now() WHERE id = $1`,
        [aSeries],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    // The worker never edits project authority, ownership, placement, or budgets directly; 8A
    // automation steps may write only the canonical update columns, inside one workspace.
    for (const column of [
      'owner_membership_id',
      'access_mode',
      'parent_project_id',
      'budget_amount',
      'description_rich',
    ])
      await expect(
        direct(db.worker, W.a.id, `UPDATE work.project SET ${column} = ${column}`),
        column,
      ).rejects.toThrow(/permission denied/);
    const aProject = (
      await db.admin(`SELECT id FROM work.project WHERE workspace_id = $1 LIMIT 1`, [W.a.id])
    ).rows[0].id;
    await expect(
      direct(db.worker, W.b.id, `UPDATE work.project SET name = 'x' WHERE id = $1`, [aProject]),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(direct(db.worker, W.a.id, `DELETE FROM access.role_assignment`)).rejects.toThrow(
      /permission denied/,
    );
    // Due work in a and c: one handler run generates only inside each series' own workspace.
    const c = await create({ brand: W.c.brands.Delta, name: 'Weekly c' }, 'c');
    await env.svc.defineRecurrence(
      W.c.owner,
      W.c.ws,
      c.id,
      { frequency: 'weekly', weekdays: ['TU'], anchor_tz: 'UTC', start: '2026-09-01T09:00' },
      mutation(),
    );
    const before = await db.admin(
      `SELECT workspace_id, count(*)::int AS n FROM work.project GROUP BY 1`,
    );
    await recurrenceHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
    }).handle({} as never);
    const after = await db.admin(
      `SELECT workspace_id, count(*)::int AS n FROM work.project GROUP BY 1`,
    );
    const n = (rows: Array<{ workspace_id: string; n: number }>, w: string) =>
      rows.find((r) => r.workspace_id === w)?.n ?? 0;
    expect(n(after.rows, W.c.id)).toBeGreaterThan(n(before.rows, W.c.id));
    expect(n(after.rows, W.b.id)).toBe(n(before.rows, W.b.id));
    // Every generated occurrence stays in its series' brand and workspace.
    const strays = await db.admin(
      `SELECT w.id FROM work.project w JOIN planning.recurrence_series s ON s.id = w.recurrence_series_id
        WHERE w.workspace_id <> s.workspace_id OR w.brand_id <> s.brand_id`,
    );
    expect(strays.rows).toEqual([]);
  });

  it('rich descriptions (0D PL-23): round trip, base_hash merges, validation, database check, copies', async () => {
    const hash = (v: unknown) =>
      `sha256:${createHash('sha256')
        .update(canonicalJson(v ?? null))
        .digest('hex')}`;
    const d1 = richTextFromPlain('Relaunch the site\n\nOut of scope: blog')!;
    const p = await create({ brand: W.a.brands.Harbor, name: 'Described', description: d1 });
    expect(p.description).toEqual(d1);
    const d2 = richTextFromPlain('Relaunch the site and the shop')!;
    const upd = await env.svc.updateProject(
      W.a.owner,
      W.a.ws,
      p.id,
      { version: p.version, changes: { description: { base_hash: hash(d1), value: d2 } } },
      mutation({ ifMatch: `"${p.version}"` }),
    );
    expect(upd.data.description).toEqual(d2);
    // A stale base hash conflicts with the current document as "theirs"; nothing is applied.
    await expect(
      env.svc.updateProject(
        W.a.owner,
        W.a.ws,
        p.id,
        { version: p.version, changes: { description: { base_hash: hash(d1), value: d1 } } },
        mutation({ ifMatch: `"${p.version}"` }),
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
      conflict: { fields: [expect.objectContaining({ field: 'description', theirs: d2 })] },
    });
    const v = upd.data.version;
    const bad = (value: unknown, extra: Record<string, unknown> = { base_hash: hash(d2) }) =>
      env.svc
        .updateProject(
          W.a.owner,
          W.a.ws,
          p.id,
          { version: v, changes: { description: { ...extra, value } } },
          mutation({ ifMatch: `"${v}"` }),
        )
        .catch((e: { issues?: Array<{ pointer: string; code: string }> }) =>
          e.issues?.map((i) => `${i.code}@${i.pointer}`),
        );
    expect(await bad(d1, { base: d2, base_hash: hash(d2) })).toContain(
      'invalid_type@/changes/description',
    );
    expect(
      await bad({
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }] },
        ],
      }),
    ).toEqual(['unsupported_mark@/changes/description/content/0/content/0/marks']);
    expect(await bad({ ...d1, version: 2 })).toEqual([
      'unsupported_version@/changes/description/version',
    ]);
    expect(
      await bad({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [] }] }),
    ).toEqual(['empty_document@/changes/description']);
    expect(await bad(richTextFromPlain('x'.repeat(20_001)))).toEqual([
      'too_long@/changes/description',
    ]);
    expect(await bad('plain string')).toEqual(['invalid_type@/changes/description']);
    // 20,000 code points of astral text fit (the limit is extracted text, not JSON bytes).
    const astral = richTextFromPlain('😀'.repeat(20_000))!;
    const big = await env.svc.updateProject(
      W.a.owner,
      W.a.ws,
      p.id,
      { version: v, changes: { description: { base_hash: hash(d2), value: astral } } },
      mutation({ ifMatch: `"${v}"` }),
    );
    expect(big.data.description).toEqual(astral);
    // Audit records a hash, never the text.
    const audit = await db.admin(
      `SELECT changes::text AS c FROM audit.audit_event e JOIN core.record r ON r.id = e.target_record_id WHERE r.public_id = $1`,
      [p.id],
    );
    expect(audit.rows.map((r) => r.c).join(' ')).not.toMatch(/Relaunch|😀/);
    // The database refuses anything outside version 1, whoever writes it.
    for (const doc of [
      '{"type":"doc","version":1,"content":[{"type":"heading","content":[]}]}',
      '{"type":"doc","version":2,"content":[{"type":"paragraph","content":[{"type":"text","text":"x"}]}]}',
      '{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[]}]}]}',
      '{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"a\\nb"}]}]}',
      '{"type":"doc","version":1,"content":[{"type":"paragraph","content":[]}]}',
      '"just text"',
    ])
      await expect(
        db.admin(
          `UPDATE work.project SET description_rich = $1::jsonb WHERE id = (SELECT id FROM core.record WHERE public_id = $2)`,
          [doc, p.id],
        ),
        doc,
      ).rejects.toThrow(/project_description_rich/);
    // null clears the description.
    const cleared = await env.svc.updateProject(
      W.a.owner,
      W.a.ws,
      p.id,
      {
        version: big.data.version,
        changes: { description: { base_hash: hash(astral), value: null } },
      },
      mutation({ ifMatch: `"${big.data.version}"` }),
    );
    expect(cleared.data.description).toBeNull();
    // Templates, duplicates, and recurrence snapshots carry the rich field.
    const q = await create({ brand: W.a.brands.Harbor, name: 'Copied', description: d1 });
    const dup = await env.svc.duplicateProject(W.a.owner, W.a.ws, q.id, {}, mutation());
    expect((await env.svc.getProject(W.a.owner, W.a.ws, dup.data.project.id)).description).toEqual(
      d1,
    );
    const tpl = await env.svc.createTemplateFromProject(
      W.a.owner,
      W.a.ws,
      q.id,
      { name: 'With text' },
      mutation(),
    );
    const fromTpl = await create({
      brand: W.a.brands.Harbor,
      template: tpl.data.id,
      name: 'From template',
    });
    expect(fromTpl.description).toEqual(d1);
    const series = (
      await env.svc.defineRecurrence(
        W.a.owner,
        W.a.ws,
        q.id,
        { frequency: 'monthly', start: '2031-01-15T09:00', anchor_tz: 'UTC' },
        mutation(),
      )
    ).data;
    const occ = await env.svc.generateNextOccurrence(
      W.a.owner,
      W.a.ws,
      q.id,
      series.id,
      mutation(),
    );
    expect(
      (await env.svc.getProject(W.a.owner, W.a.ws, occ.data.occurrence!.id)).description,
    ).toEqual(d1);
  });

  it('recurrence discovery uses the injected registered bounds, oldest-waiting first, without starvation', async () => {
    const x = await workspaceWith(env, db, ['Batch X']);
    const y = await workspaceWith(env, db, ['Batch Y']);
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const define = async (w: typeof x, body: Record<string, unknown>) => {
      const p = (
        await env.svc.createProject(
          w.owner,
          w.ws,
          { brand: Object.values(w.brands)[0]!, name: 'Batch' },
          mutation(),
        )
      ).data;
      return (
        await env.svc.defineRecurrence(
          w.owner,
          w.ws,
          p.id,
          { anchor_tz: 'UTC', ...body },
          mutation(),
        )
      ).data.id;
    };
    // S1 is far behind (stays due for many runs); S2 catches up in one run; S3 weekly; S4 in Y.
    const s1 = await define(x, { frequency: 'daily', start: '2025-01-01T09:00' });
    const s2 = await define(x, { frequency: 'daily', start: `${day(-2)}T00:00` });
    const s3 = await define(x, {
      frequency: 'weekly',
      weekdays: ['MO'],
      start: `${day(-30)}T09:00`,
    });
    const s4 = await define(y, { frequency: 'daily', start: `${day(-1)}T00:00` });
    // Make the waiting order explicit: X's series waited longest, then Y's.
    const wait = async (id: string, at: string) =>
      db.admin(`UPDATE planning.recurrence_series SET last_run_at = $2 WHERE public_id = $1`, [
        id,
        at,
      ]);
    await wait(s1, '2000-01-01T00:00:00Z');
    await wait(s2, '2000-01-01T00:01:00Z');
    await wait(s3, '2000-01-01T00:02:00Z');
    await wait(s4, '2000-01-02T00:00:00Z');
    const runAt = async (id: string) =>
      (
        await db.admin(
          `SELECT last_run_at > '2001-01-01' AS ran FROM planning.recurrence_series WHERE public_id = $1`,
          [id],
        )
      ).rows[0].ran as boolean;
    const handler = recurrenceHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
      settings: {
        ...DEFAULT_WORK_SETTINGS,
        recurrenceWorkspaceDiscoveryMax: 1,
        recurrenceSeriesDiscoveryMax: 2,
      },
    });
    // Run 1: one workspace (X), two series (the two that waited longest).
    await handler.handle({} as never);
    expect([await runAt(s1), await runAt(s2), await runAt(s3), await runAt(s4)]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    // Run 2: X again (S3 waited longest overall); S1 is still behind and takes the second slot.
    await handler.handle({} as never);
    expect(await runAt(s3)).toBe(true);
    expect(await runAt(s4)).toBe(false);
    // Run 3: Y's series is now the oldest-waiting work, even though X's S1 is still due.
    await handler.handle({} as never);
    expect(await runAt(s4)).toBe(true);
    const due = await db.admin(
      `SELECT next_due_at <= now() AS due FROM planning.recurrence_series WHERE public_id = $1`,
      [s1],
    );
    expect(due.rows[0].due).toBe(true);
    // Every series generated its own occurrences; none was skipped by the batching.
    const made = await db.admin(
      `SELECT s.public_id, count(w.id)::int AS n FROM planning.recurrence_series s
         LEFT JOIN work.project w ON w.recurrence_series_id = s.id
        WHERE s.public_id = ANY($1) GROUP BY 1`,
      [[s1, s2, s3, s4]],
    );
    for (const r of made.rows) expect(r.n, r.public_id).toBeGreaterThan(0);
    // The far-behind series is bounded per run by RECURRENCE_CATCHUP_MAX (12 per run, two runs).
    expect(made.rows.find((r) => r.public_id === s1)!.n).toBe(24);
  });

  it('G4 evidence at 50,000 projects: scope and subtree walks stay indexed; list and walk timings are recorded', async () => {
    const big = await workspaceWith(env, db, ['Fifty thousand']);
    const bid = await workspaceIdOf(db, big.ws);
    await db.admin(
      `BEGIN; SET LOCAL session_replication_role = replica;
       CREATE TEMP TABLE big ON COMMIT DROP AS
         SELECT uuidv7() AS id, i, 'prj_' || lpad(i::text, 26, '0') AS public_id FROM generate_series(1, 50000) AS i;
       INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type)
         SELECT g.id, g.public_id, 'project', w.id, b.id, 'system', 'system'
           FROM big g JOIN tenancy.workspace w ON w.id = '${bid}' JOIN tenancy.brand b ON b.workspace_id = w.id;
       INSERT INTO work.project (id, workspace_id, brand_id, scope_key, name, status_id, status_category,
                                 owner_membership_id, rank, ancestor_ids, depth)
       SELECT g.id, w.id, b.id, b.id, 'Q' || g.i, '01920000-0000-7000-8000-000000000001', 'planned',
              m.id, lpad(g.i::text, 6, '0'), '{}', 0
         FROM big g
         JOIN tenancy.workspace w ON w.id = '${bid}'
         JOIN tenancy.brand b ON b.workspace_id = w.id
         JOIN LATERAL (SELECT id FROM tenancy.membership WHERE workspace_id = w.id LIMIT 1) m ON true;
       WITH roots AS (SELECT id, row_number() OVER (ORDER BY rank) AS n FROM work.project
                       WHERE workspace_id = '${bid}' AND rank <= '001000')
       UPDATE work.project c SET parent_project_id = r.id, ancestor_ids = ARRAY[r.id], depth = 1
         FROM roots r WHERE c.workspace_id = '${bid}' AND c.rank > '001000'
          AND r.n = (substring(c.rank from 4)::int % 1000) + 1;
       COMMIT; ANALYZE work.project; ANALYZE core.record;`,
    );
    const root = (
      await db.admin(`SELECT id FROM work.project WHERE workspace_id = $1 AND depth = 0 LIMIT 1`, [
        bid,
      ])
    ).rows[0].id;
    const analyze = async (query: string, params: unknown[]) =>
      env.h.app.withWorkspace(bid, { module: 'test' }, async (tx) => {
        const r = await tx.db.executeQuery({
          sql: `EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
          parameters: params,
          query: { kind: 'RawNode' },
        } as never);
        const plan = (r as { rows: Array<{ 'QUERY PLAN': Array<{ 'Execution Time': number }> }> })
          .rows[0]!['QUERY PLAN'][0]!;
        return { text: JSON.stringify(plan), ms: plan['Execution Time'] };
      });
    // The real list command (visibility predicate, brand-name/rank order, first page of 200).
    const t0 = performance.now();
    const page = await env.svc.listProjects(big.owner, big.ws, {
      brands: Object.values(big.brands)[0],
    });
    const listMs = performance.now() - t0;
    expect(page.data).toHaveLength(200);
    expect(page.total).toMatchObject({ value: 50_000, capped: true });
    const scope = await analyze(
      `WITH RECURSIVE sub AS (
         SELECT d.id FROM work.project d WHERE d.access_mode = 'restricted' OR d.id = ANY($1::uuid[])
         UNION ALL SELECT c.id FROM work.project c JOIN sub ON c.parent_project_id = sub.id)
       SELECT count(*) FROM sub`,
      [[root]],
    );
    const subtree = await analyze(
      `WITH RECURSIVE sub AS (
         SELECT id, depth FROM work.project WHERE parent_project_id = $1
         UNION ALL SELECT c.id, c.depth FROM work.project c JOIN sub ON c.parent_project_id = sub.id)
       SELECT max(depth) FROM sub`,
      [root],
    );
    expect(scope.text).toMatch(/project_restricted/);
    expect(scope.text).toMatch(/project_pkey/);
    expect(subtree.text).toMatch(/project_children/);
    // Recorded for the review (G4); the bound is a sanity check, not a performance target.
    console.info(
      `[G4] 50,000 projects: list command ${listMs.toFixed(1)} ms (end to end), scope walk ${scope.ms.toFixed(2)} ms, subtree walk ${subtree.ms.toFixed(2)} ms`,
    );
    for (const ms of [listMs, scope.ms, subtree.ms]) expect(ms).toBeLessThan(2000);
    await db.admin(
      `BEGIN; SET LOCAL session_replication_role = replica;
       DELETE FROM work.project WHERE workspace_id = '${bid}' AND name LIKE 'Q%';
       DELETE FROM core.record WHERE workspace_id = '${bid}' AND record_type = 'project'
         AND public_id LIKE 'prj\\_0000%'; COMMIT;`,
    );
  });
});
