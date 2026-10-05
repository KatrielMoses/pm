import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { migratedDatabase, type DbTestDatabase } from './databases.ts';

const TENANT_TABLES = [
  'operation',
  'attempt',
  'job',
  'outbox_event',
  'inbox_receipt',
  'idempotency_key',
  'external_effect',
] as const;

/** Documented purge order (docs/engineering/database.md): children before parents, workspace last. */
const PURGE_ORDER = [
  'exec.inbox_receipt',
  'exec.external_effect',
  'exec.idempotency_key',
  'exec.outbox_event',
  'exec.attempt',
  'exec.job',
  'exec.operation',
] as const;

const CTX = `'member', $P, 'member', $P, '[{"type":"member","id":"00000000-0000-7000-8000-000000000000"}]'::jsonb, 0, 0, 'C2', $C`;

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

/** Inserts one row into every tenant execution table for `ws` (superuser; bypasses RLS, not FKs). */
async function seedRow(
  q: Q,
  table: (typeof TENANT_TABLES)[number],
  ws: string,
  operationId?: string,
): Promise<void> {
  const p = newUuidV7();
  const c = newUuidV7();
  const ctx = CTX.replaceAll('$P', `'${p}'`).replaceAll('$C', `'${c}'`);
  const ctxCols = `authenticated_principal_type, authenticated_principal_id, effective_principal_type, effective_principal_id, delegation_chain, workspace_epoch_at_enqueue, principal_epoch_at_enqueue, data_class_limit, correlation_id`;
  switch (table) {
    case 'operation':
      await q(
        `INSERT INTO exec.operation (id, workspace_id, public_id, kind, initiated_by_actor_type, ${ctxCols}) VALUES ($1, $2, $3, 'report_run', 'system', ${ctx})`,
        [operationId ?? newUuidV7(), ws, newPublicId('op')],
      );
      return;
    case 'attempt':
      await q(
        `INSERT INTO exec.attempt (id, workspace_id, public_id, operation_id, attempt_number) VALUES ($1, $2, $3, $4, 1)`,
        [newUuidV7(), ws, newPublicId('att'), operationId ?? newUuidV7()],
      );
      return;
    case 'job':
      await q(
        `INSERT INTO exec.job (id, workspace_id, queue, kind, max_attempts, timeout_seconds, ${ctxCols}) VALUES ($1, $2, 'default', 'test.noop', 1, 5, ${ctx})`,
        [newUuidV7(), ws],
      );
      return;
    case 'outbox_event':
      await q(
        `INSERT INTO exec.outbox_event (id, workspace_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_sequence, payload, max_class, actor_type, workspace_epoch, correlation_id, occurred_at)
         VALUES ($1, $2, 'execution.operation.state_changed', 1, 'execution.operation', $3, 0, '{}', 'C1', 'system', 0, $4, now())`,
        [newUuidV7(), ws, newUuidV7(), c],
      );
      return;
    case 'inbox_receipt':
      await q(
        `INSERT INTO exec.inbox_receipt (consumer_name, event_id, workspace_id) VALUES ('test.consumer', $1, $2)`,
        [newUuidV7(), ws],
      );
      return;
    case 'idempotency_key':
      await q(
        `INSERT INTO exec.idempotency_key (id, workspace_id, principal_type, principal_id, key, request_fingerprint, expires_at) VALUES ($1, $2, 'member', $3, $4, $5, now() + interval '1 day')`,
        [newUuidV7(), ws, p, `key-${newUuidV7()}`, Buffer.alloc(32, 7)],
      );
      return;
    case 'external_effect':
      await q(
        `INSERT INTO exec.external_effect (id, workspace_id, operation_id, effect_key, destination_class) VALUES ($1, $2, $3, 'probe', 'unsafe')`,
        [newUuidV7(), ws, operationId ?? newUuidV7()],
      );
      return;
  }
}

async function createWorkspace(q: Q): Promise<string> {
  const id = newUuidV7();
  await q(
    `INSERT INTO tenancy.workspace (id, public_id, name, timezone, locale, currency, week_start, created_by_actor_type, updated_by_actor_type)
     VALUES ($1, $2, 'Synthetic Workspace', 'UTC', 'en', 'USD', 1, 'system', 'system')`,
    [id, newPublicId('ws')],
  );
  return id;
}

async function seedAll(q: Q, ws: string): Promise<void> {
  const op = newUuidV7();
  await seedRow(q, 'operation', ws, op);
  for (const t of TENANT_TABLES.filter((t) => t !== 'operation')) await seedRow(q, t, ws, op);
}

describe('database-enforced workspace existence (1A review 01, correction 2)', () => {
  let db: DbTestDatabase;
  const q: Q = (sql, params) => db.admin(sql, params);

  beforeAll(async () => {
    db = await migratedDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('catalog: every tenant execution table has a validated RESTRICT foreign key to tenancy.workspace(id)', async () => {
    const res = await q(`
      SELECT c.conrelid::regclass::text AS tbl, c.confdeltype, c.convalidated,
             array(SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = ANY (c.conkey))::text[] AS cols,
             array(SELECT attname FROM pg_attribute WHERE attrelid = c.confrelid AND attnum = ANY (c.confkey))::text[] AS ref_cols
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid = 'tenancy.workspace'::regclass
      ORDER BY 1`);
    // Phase 1F tenant tables (audit, core, governance) carry the same database-enforced root key.
    const phase1f = [
      'audit.activity_item',
      'audit.audit_event',
      'audit.audit_redaction',
      'audit.chain_checkpoint',
      'audit.security_event',
      'core.archive_batch',
      'core.archive_batch_member',
      'core.deletion_batch',
      'core.deletion_batch_member',
      'core.record',
      'governance.retention_policy',
    ];
    // Phase 1C tenancy and access tables.
    const phase1c = [
      'access.permission_epoch',
      'access.role',
      'access.role_assignment',
      'tenancy.brand',
      'tenancy.brand_setting',
      'tenancy.membership',
      'tenancy.scope_preference',
      // Phase 1D collaboration tables.
      'access.record_grant',
      'access.share_group',
      'access.workspace_policy',
      'tenancy.invitation',
      'tenancy.ownership_transfer',
      'tenancy.team',
      'tenancy.team_member',
      // Phase 1E personal navigation tables.
      'views.favorite',
      'views.recent_item',
      'views.view_pin',
      'views.view_state',
      // Phase 2A projects, relationships, templates, and recurrence.
      'planning.recurrence_series',
      'relations.record_relationship',
      'templates.template',
      'templates.template_version',
      'work.criteria_item',
      'work.decision_record',
      'work.milestone',
      'work.phase',
      'work.project',
      'work.project_update',
      'work.project_update_verification',
      'work.scope_item',
      // Phase 2B tasks, labels, and record links.
      'relations.record_link',
      'work.checklist_item',
      'work.label',
      'work.task',
      'work.task_assignee',
      'work.task_inherited_criterion',
      'work.task_label',
      // Phase 2C workflows, approvals, custom fields, field sets, and field policy.
      'access.field_policy',
      'workflow.approval_decision',
      'workflow.approval_request',
      'workflow.field_definition',
      'workflow.field_option',
      'workflow.field_set',
      'workflow.field_set_attachment',
      'workflow.field_set_version',
      'workflow.field_value',
      'workflow.formula_dependency',
      'workflow.transition',
      'workflow.transition_approver',
      'workflow.transition_requirement',
      'workflow.workflow',
      'workflow.workflow_status',
    ];
    expect(res.rows.map((r) => r.tbl).sort()).toEqual(
      [...TENANT_TABLES.map((t) => `exec.${t}`), ...phase1f, ...phase1c].sort(),
    );
    for (const r of res.rows) {
      expect(r, r.tbl).toMatchObject({
        confdeltype: 'r',
        convalidated: true,
        cols: ['workspace_id'],
        ref_cols: ['id'],
      });
    }
  });

  it('every foreign key has a full index on its referencing columns and a unique key on its referenced columns', async () => {
    const res = await q(`
      SELECT c.conname, c.conrelid::regclass::text AS tbl,
        EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid AND i.indpred IS NULL
            AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
            AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey
        ) AS referencing_indexed,
        EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.confrelid AND i.indisunique AND i.indpred IS NULL
            AND i.indkey::int2[] @> c.confkey AND i.indkey::int2[] <@ c.confkey
        ) AS referenced_unique
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname IN ('exec', 'tenancy', 'access', 'ops', 'views', 'workflow', 'work', 'relations', 'templates', 'planning')
      ORDER BY 1`);
    // exec: 7 workspace keys + 6 composite same-workspace keys; 1C tenancy/access: 20 keys;
    // 1D collaboration (teams, invitations, policy, shares, ownership transfer): 38 keys;
    // 1E personal navigation (favorites, recents, view state, view pins): 12 keys;
    // 2A projects, structures, relationships, templates, recurrence, project role scope: 60 keys;
    // 2B tasks, assignees, checklists, task criteria, inherited criteria, labels, links: 33 keys;
    // 2C workflows, statuses, transitions, approvals (24) and fields, values, sets, field policy (30),
    // less the three platform-status keys that became trigger-checked status references: +51.
    expect(res.rows.length).toBe(227);
    for (const r of res.rows)
      expect(r, `${r.tbl}.${r.conname}`).toMatchObject({
        referencing_indexed: true,
        referenced_unique: true,
      });
  });

  it('rejects execution rows for a nonexistent workspace even for a superuser (RLS bypassed, FK still enforced)', async () => {
    const ghost = newUuidV7();
    for (const table of TENANT_TABLES) {
      await expect(seedRow(q, table, ghost), table).rejects.toMatchObject({ code: '23503' });
    }
    // Tables without a mandatory operation reference fail specifically on the workspace key.
    for (const table of [
      'operation',
      'job',
      'outbox_event',
      'inbox_receipt',
      'idempotency_key',
    ] as const) {
      await expect(seedRow(q, table, ghost), table).rejects.toMatchObject({
        constraint: `${table}_workspace_fkey`,
      });
    }
  });

  it('rejects them for the migrator acting as owner, even with a matching RLS context', async () => {
    const client = new pg.Client({ connectionString: db.migrator });
    await client.connect();
    try {
      const ghost = newUuidV7();
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE pm_owner');
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [ghost]);
      await expect(seedRow((s, p) => client.query(s, p), 'operation', ghost)).rejects.toMatchObject(
        { code: '23503', constraint: 'operation_workspace_fkey' },
      );
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('refuses to delete a workspace while execution rows remain', async () => {
    const ws = await createWorkspace(q);
    await seedAll(q, ws);
    // ON DELETE RESTRICT -> restrict_violation (23001), raised immediately (not deferrable).
    await expect(q('DELETE FROM tenancy.workspace WHERE id = $1', [ws])).rejects.toMatchObject({
      code: '23001',
    });
    for (const table of TENANT_TABLES) {
      const left = await q(`SELECT count(*)::int AS n FROM exec.${table} WHERE workspace_id = $1`, [
        ws,
      ]);
      expect(left.rows[0].n, table).toBeGreaterThan(0);
    }
  });

  it('the documented purge order deletes child rows and then the workspace; nothing else is touched', async () => {
    const victim = await createWorkspace(q);
    const bystander = await createWorkspace(q);
    await seedAll(q, victim);
    await seedAll(q, bystander);
    const client = new pg.Client({ connectionString: db.server.adminUrl(db.name) });
    await client.connect();
    try {
      // Without the purge marker, append-only attempts cannot be deleted.
      await client.query('BEGIN');
      await expect(
        client.query('DELETE FROM exec.attempt WHERE workspace_id = $1', [victim]),
      ).rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.purge_workspace_id', $1, true)", [victim]);
      for (const table of PURGE_ORDER)
        await client.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [victim]);
      await client.query('DELETE FROM tenancy.workspace WHERE id = $1', [victim]);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
    const gone = await q('SELECT count(*)::int AS n FROM tenancy.workspace WHERE id = $1', [
      victim,
    ]);
    expect(gone.rows[0].n).toBe(0);
    for (const table of TENANT_TABLES) {
      const kept = await q(`SELECT count(*)::int AS n FROM exec.${table} WHERE workspace_id = $1`, [
        bystander,
      ]);
      expect(kept.rows[0].n, table).toBe(1);
    }
  });

  it('the purge marker for one workspace cannot delete another workspace’s attempts', async () => {
    const a = await createWorkspace(q);
    const b = await createWorkspace(q);
    await seedAll(q, b);
    const client = new pg.Client({ connectionString: db.server.adminUrl(db.name) });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.purge_workspace_id', $1, true)", [a]);
      await expect(
        client.query('DELETE FROM exec.attempt WHERE workspace_id = $1', [b]),
      ).rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });
});
