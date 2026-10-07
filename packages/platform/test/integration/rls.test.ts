import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Secret } from '@pm/config';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { assertApplicationIdentity, createPool, TenantContextError, TenantDatabase } from '@pm/db';
import {
  createHarness,
  executionContext,
  seedTwoWorkspaces,
  type Harness,
  type TenantFixture,
} from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { enqueueJob, startOperation, DeferredAuditSink, writeOutboxEvent } from '@pm/platform';

const TENANT_TABLES = [
  'exec.operation',
  'exec.attempt',
  'exec.job',
  'exec.outbox_event',
  'exec.inbox_receipt',
  'exec.idempotency_key',
  'exec.external_effect',
] as const;

/** Phase 1F tenant tables (audit, core, governance); behavior covered in their own suites. */
const PHASE_1F_TENANT_TABLES = [
  'audit.audit_event',
  'audit.audit_redaction',
  'audit.security_event',
  'audit.chain_checkpoint',
  'audit.activity_item',
  'core.record',
  'core.archive_batch',
  'core.archive_batch_member',
  'core.deletion_batch',
  'core.deletion_batch_member',
  'governance.retention_policy',
] as const;
const PHASE_1C_TENANT_TABLES = [
  'tenancy.membership',
  'access.role',
  'access.role_assignment',
  'access.permission_epoch',
  'tenancy.brand',
  'tenancy.brand_setting',
  'tenancy.scope_preference',
  // Phase 1D
  'tenancy.team',
  'tenancy.team_member',
  'access.workspace_policy',
  'tenancy.invitation',
  'access.share_group',
  'access.record_grant',
  'tenancy.ownership_transfer',
  // Phase 1E
  'views.favorite',
  'views.recent_item',
  'views.view_state',
  'views.view_pin',
  'views.saved_view',
  'views.view_default',
  // Phase 2A
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
  // Phase 2B
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
  // Phase 2D reminders, snoozes, bulk operations, and undo entries.
  'planning.task_reminder',
  'planning.task_snooze',
  'work.bulk_operation',
  'work.undo_entry',
  // Phase 2E Inbox items, notes, conversion lineage, intake forms, and submissions.
  'capture.inbox_item',
  'capture.note',
  'capture.capture_conversion',
  'capture.intake_form',
  'capture.intake_submission',
  // Phase 3D time entries, segments, timesheets, lines, approvals, and period locks.
  'timetrack.time_entry',
  'timetrack.time_segment',
  'timetrack.timesheet',
  'timetrack.timesheet_line',
  'timetrack.timesheet_approval',
  'timetrack.period_lock',
] as const;

/** Seeds one row in every tenant execution table for a workspace. */
async function seedExecutionRows(
  h: Harness,
  workspaceId: string,
  principal: TenantFixture['principals']['alphaMember'],
) {
  const ctx = executionContext(workspaceId, principal);
  const op = await h.worker.withWorkspace(workspaceId, { module: 'test' }, async (tx) => {
    const started = await startOperation(
      tx,
      {
        kind: 'report_run',
        context: ctx,
        initiatedBy: { type: 'human', id: principal.id },
        queue: 'default',
        jobKind: 'test.noop',
        maxAttempts: 3,
        timeoutSeconds: 30,
        auditActionKey: 'report.run',
      },
      new DeferredAuditSink(),
    );
    await tx.db
      .insertInto('exec.attempt')
      .values({
        id: newUuidV7(),
        workspace_id: workspaceId,
        public_id: newPublicId('att'),
        operation_id: started.id,
        attempt_number: 1,
      })
      .execute();
    await tx.db
      .insertInto('exec.inbox_receipt')
      .values({ consumer_name: 'test.consumer', event_id: newUuidV7(), workspace_id: workspaceId })
      .execute();
    await tx.db
      .insertInto('exec.external_effect')
      .values({
        id: newUuidV7(),
        workspace_id: workspaceId,
        operation_id: started.id,
        effect_key: 'probe',
        destination_class: 'unsafe',
      })
      .execute();
    return started;
  });
  await h.app.withWorkspace(workspaceId, { module: 'test' }, (tx) =>
    tx.db
      .insertInto('exec.idempotency_key')
      .values({
        id: newUuidV7(),
        workspace_id: workspaceId,
        principal_type: 'member',
        principal_id: principal.id,
        key: `key-${newUuidV7()}`,
        request_fingerprint: Buffer.alloc(32, 1),
        expires_at: new Date(Date.now() + 60_000),
      })
      .execute(),
  );
  return op;
}

describe('tenant RLS foundation (0C §12.7)', () => {
  let db: TestDatabase;
  let h: Harness;
  let f: TenantFixture;
  let betaOp: { id: string; jobId: string };

  beforeAll(async () => {
    db = await createTestDatabase();
    h = createHarness(db);
    f = await seedTwoWorkspaces(h.app);
    await seedExecutionRows(h, f.alpha.id, f.principals.alphaMember);
    betaOp = await seedExecutionRows(h, f.beta.id, f.principals.betaMember);
  });
  afterAll(async () => {
    await h.close();
    await db.drop();
  });

  it('catalog: every table with workspace_id (and the tenant root) has RLS enabled and forced', async () => {
    const res = await db.admin(`
      SELECT n.nspname || '.' || c.relname AS t, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')::int AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND (EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped)
             OR (n.nspname = 'tenancy' AND c.relname = 'workspace'))
      ORDER BY 1`);
    // Platform-scoped tables (0B scope "platform") keep workspace_id only as a plain reference and
    // carry no tenant RLS by design. The list is exact: any new table must be classified here.
    const PLATFORM_SCOPED = ['identity.security_event_buffer', 'identity.step_up_challenge'];
    expect(res.rows.map((r) => r.t).sort()).toEqual(
      [
        ...TENANT_TABLES,
        ...PHASE_1F_TENANT_TABLES,
        ...PHASE_1C_TENANT_TABLES,
        'tenancy.workspace',
        ...PLATFORM_SCOPED,
      ].sort(),
    );
    res.rows = res.rows.filter((r) => !PLATFORM_SCOPED.includes(r.t));
    for (const row of res.rows) {
      expect(row, row.t).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: 1,
      });
    }
  });

  it('catalog: no foundation role is superuser or bypasses RLS; application roles own nothing', async () => {
    const roles =
      await db.admin(`SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles
      WHERE rolname IN ('app_rw', 'app_worker', 'dispatcher', 'migrator', 'restore_operator', 'pm_owner', 'pm_scheduler') ORDER BY 1`);
    expect(roles.rows).toHaveLength(7);
    for (const r of roles.rows)
      expect(r, r.rolname).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      });
    const owned = await db.admin(`SELECT count(*)::int AS n FROM pg_class WHERE relowner IN
      (SELECT oid FROM pg_roles WHERE rolname IN ('app_rw', 'app_worker', 'dispatcher'))`);
    expect(owned.rows[0].n).toBe(0);
  });

  for (const identity of ['app', 'worker'] as const) {
    it(`${identity}: a workspace transaction sees and changes only its own rows`, async () => {
      const tdb = identity === 'app' ? h.app : h.worker;
      for (const table of TENANT_TABLES) {
        const rows = await tdb
          .withWorkspace(f.alpha.id, { module: 'test', readOnly: true }, (tx) =>
            tx.db.selectFrom(table).select('workspace_id').execute(),
          )
          .catch((e: { code?: string }) => (e.code === '42501' ? 'no_grant' : Promise.reject(e)));
        if (rows === 'no_grant') continue; // identity has no read grant on this table (stricter)
        expect(rows.length, table).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.workspace_id)), table).toEqual(new Set([f.alpha.id]));
      }
      const visible = await tdb.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
        tx.db.selectFrom('exec.operation').select('id').where('id', '=', betaOp.id).execute(),
      );
      expect(visible).toEqual([]);
      const updated = await tdb.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
        tx.db
          .updateTable('exec.operation')
          .set({ cancel_requested_at: new Date() })
          .where('id', '=', betaOp.id)
          .executeTakeFirst(),
      );
      expect(Number(updated.numUpdatedRows)).toBe(0);
      const ws = await tdb.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
        tx.db.selectFrom('tenancy.workspace').select('id').execute(),
      );
      expect(ws).toEqual([{ id: f.alpha.id }]);
    });
  }

  it('unset context: every tenant table returns zero rows and writes fail (AT-073)', async () => {
    const client = new pg.Client({ connectionString: db.worker });
    await client.connect();
    try {
      for (const table of [...TENANT_TABLES, 'tenancy.workspace']) {
        const res = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(res.rows[0].n, table).toBe(0);
      }
      await expect(
        client.query(
          `INSERT INTO exec.inbox_receipt (consumer_name, event_id, workspace_id) VALUES ('x', $1, $2)`,
          [newUuidV7(), f.alpha.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  });

  it('pooled connection reuse cannot leak a previous transaction context (AT-073)', async () => {
    const config = h.config.database;
    const pool = createPool(
      h.config.database.connections.worker!,
      { ...config, poolMax: 1 },
      { logger: h.logger, metrics: h.telemetry.metrics, tracer: h.telemetry.tracer },
      { applicationName: 'pm-test-leak', max: 1 },
    );
    const tdb = new TenantDatabase(pool, {
      logger: h.logger,
      metrics: h.telemetry.metrics,
      tracer: h.telemetry.tracer,
    });
    try {
      const pidA = await tdb.withWorkspace(f.alpha.id, { module: 'test' }, async (tx) => {
        const r = await tx.db.selectFrom('exec.job').select('id').execute();
        expect(r.length).toBeGreaterThan(0);
        return (
          await (
            await import('@pm/db')
          ).sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx.db)
        ).rows[0]!.pid;
      });
      // Same physical connection (pool max 1), next unit of work without a context:
      const samePid = await pool.raw.query('SELECT pg_backend_pid() AS pid');
      expect(samePid.rows[0].pid).toBe(pidA);
      const after = await pool.raw.query(
        `SELECT current_setting('app.workspace_id', true) AS ctx, (SELECT count(*)::int FROM exec.job) AS n`,
      );
      expect(after.rows[0].n).toBe(0);
      expect(after.rows[0].ctx ?? '').toBe('');
      const beta = await tdb.withWorkspace(f.beta.id, { module: 'test' }, (tx) =>
        tx.db.selectFrom('exec.job').select('workspace_id').execute(),
      );
      expect(new Set(beta.map((r) => r.workspace_id))).toEqual(new Set([f.beta.id]));
    } finally {
      await pool.end();
    }
  });

  it('rejects inserts whose workspace_id differs from the context (AT-074)', async () => {
    await expect(
      h.worker.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
        tx.db
          .insertInto('exec.inbox_receipt')
          .values({ consumer_name: 'x', event_id: newUuidV7(), workspace_id: f.beta.id })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const ctx = executionContext(f.alpha.id, f.principals.alphaMember);
    await expect(
      h.worker.withWorkspace(f.beta.id, { module: 'test' }, (tx) =>
        enqueueJob(tx, {
          queue: 'default',
          kind: 'test.noop',
          context: ctx,
          maxAttempts: 1,
          timeoutSeconds: 5,
        }),
      ),
    ).rejects.toThrow(/context workspace mismatch/);
    await expect(
      h.worker.withWorkspace(f.beta.id, { module: 'test' }, (tx) =>
        writeOutboxEvent(tx, {
          type: 'execution.operation.state_changed',
          aggregate: { type: 'x', id: newUuidV7(), sequence: 1 },
          data: {},
          actor: { type: 'system' },
          context: ctx,
        }),
      ),
    ).rejects.toThrow(/mismatch/);
  });

  it('fails closed on malformed or unknown workspace context before running caller code', async () => {
    let ran = false;
    await expect(
      h.app.withWorkspace('not-a-uuid', { module: 'test' }, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(TenantContextError);
    await expect(
      h.app.withWorkspace(newUuidV7(), { module: 'test' }, async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ reason: 'workspace_unknown' });
    expect(ran).toBe(false);
  });

  it('worker cross-tenant scan returns only the current context (AT-075)', async () => {
    const rows = await h.worker.withWorkspace(f.beta.id, { module: 'test', readOnly: true }, (tx) =>
      tx.db
        .selectFrom('exec.job')
        .select(['workspace_id'])
        .where('workspace_id', '=', f.alpha.id)
        .execute(),
    );
    expect(rows).toEqual([]);
  });

  it('dispatcher reaches tenant data only through payload-free definer functions', async () => {
    const client = new pg.Client({ connectionString: db.dispatcher });
    await client.connect();
    try {
      for (const table of [...TENANT_TABLES, 'tenancy.workspace']) {
        await expect(client.query(`SELECT * FROM ${table} LIMIT 1`), table).rejects.toMatchObject({
          code: '42501',
        });
      }
    } finally {
      await client.end();
    }
    const fns = await db.admin(`
      SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner,
             pg_get_function_result(p.oid) AS result,
             has_function_privilege('dispatcher', p.oid, 'EXECUTE') AS dispatcher_exec,
             has_function_privilege('app_rw', p.oid, 'EXECUTE') AS app_exec,
             has_function_privilege('app_worker', p.oid, 'EXECUTE') AS worker_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'exec_dispatch' ORDER BY 1`);
    // 1A–1F: 9 functions; 1E adds discover_views_cleanup and 2A discover_recurrence_due
    // (workspace ids only); 2D discover_reminders_due; 3D discover_runaway_timers.
    expect(fns.rows.length).toBe(13);
    const allowed = new Set([
      'job_id',
      'workspace_id',
      'lease_token',
      'queue',
      'state',
      'jobs',
      'oldest_due_age_ms',
      'event_id',
      'pending',
      'oldest_age_ms',
      'batch_id',
      'batches',
    ]);
    for (const fn of fns.rows) {
      expect(fn, fn.proname).toMatchObject({
        prosecdef: true,
        owner: 'pm_scheduler',
        dispatcher_exec: true,
        app_exec: false,
        worker_exec: false,
      });
      const cols = [...fn.result.matchAll(/(\w+) [a-z.]+/g)].map((m) => m[1]);
      for (const c of cols) expect(allowed.has(c), `${fn.proname}.${c}`).toBe(true);
    }
    const priv = await db.admin(`SELECT column_name FROM information_schema.columns c
      WHERE table_schema = 'exec' AND table_name IN ('job', 'outbox_event', 'idempotency_key', 'inbox_receipt')
        AND has_column_privilege('pm_scheduler', table_schema || '.' || table_name, column_name, 'SELECT')
      ORDER BY 1`);
    const visible = new Set(priv.rows.map((r) => r.column_name));
    for (const forbidden of [
      'payload',
      'payload_ref',
      'delegation_chain',
      'selected_scope',
      'checkpoint',
      'last_error',
      'request_fingerprint',
      'response_ref',
      'key',
      'principal_id',
    ]) {
      expect(visible.has(forbidden), forbidden).toBe(false);
    }
  });

  it('discovery reveals only claimable job references (no payload or context)', async () => {
    const claims = await h.discovery.claimJobs({
      queue: 'default',
      workerId: 'wrk_0123456789abcdef',
      limit: 10,
      workspaceCap: 5,
      leaseMs: 60_000,
    });
    expect(claims.length).toBe(2);
    for (const c of claims)
      expect(Object.keys(c).sort()).toEqual(['jobId', 'leaseToken', 'workspaceId']);
    expect(new Set(claims.map((c) => c.workspaceId))).toEqual(new Set([f.alpha.id, f.beta.id]));
  });

  it('application identity guard accepts app_rw and rejects operational identities', async () => {
    await expect(assertApplicationIdentity(h.pools.app, 'test')).resolves.toBeUndefined();
    await expect(assertApplicationIdentity(h.pools.app, 'production')).rejects.toThrow(
      /different environment/,
    );
    const conn = {
      ...h.config.database.connections.worker!,
      identity: 'app' as const,
      role: 'app_rw',
      url: new Secret(db.migrator),
    };
    const pool = createPool(
      conn,
      h.config.database,
      { logger: h.logger, metrics: h.telemetry.metrics, tracer: h.telemetry.tracer },
      { applicationName: 'pm-test-guard', max: 1 },
    );
    try {
      await expect(assertApplicationIdentity(pool, 'test')).rejects.toThrow(/unexpected role/);
    } finally {
      await pool.end();
    }
  });
});
