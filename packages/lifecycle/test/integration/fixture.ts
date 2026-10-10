import { LogErrorReporter } from '@pm/observability';
import { AuditWriter } from '@pm/audit';
import { newUuidV7, type ExecutionContext } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  createRecord,
  LifecycleRegistry,
  LIFECYCLE_SCHEDULES,
  LifecycleService,
  LocalFilePurgeLedger,
  purgeJobHandler,
  purgeSchedulerHandler,
  PurgeExecutor,
  RetentionPolicy,
  tombstoneSweepHandler,
  type HoldPort,
  type PurgeLedger,
  type RecordTypeAdapter,
} from '@pm/lifecycle';
import type { RetentionClassKey } from '@pm/config';
import { ActivityProjector, CommandContext } from '@pm/audit';
import { SYSTEM_PRINCIPAL, WorkerRuntime } from '@pm/platform';
import { executionContext, syntheticPrincipal, type Harness } from '@pm/test-support';
import type { TestDatabase } from '@pm/test-support/vitest';

/**
 * Test-only schema: a synthetic contained record type (`foundation_fixture`, registered only in
 * this test database), its typed table mirroring the envelope through the deferrable composite
 * foreign key, and an association table that lifecycle must never cascade through.
 */
export async function installFixtureSchema(db: TestDatabase): Promise<void> {
  await db.admin(`
    INSERT INTO core.record_type (record_type, public_id_prefix, owner_module, test_only)
      VALUES ('foundation_fixture', 'fxt', 'fixture', true);
    CREATE SCHEMA fixture;
    CREATE TABLE fixture.item (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id),
      scope_key uuid NOT NULL,
      lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
      parent_id uuid,
      title text NOT NULL,
      evidence_locked boolean NOT NULL DEFAULT false,
      FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
        REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
        ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE fixture.link (
      workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id),
      a_id uuid NOT NULL,
      b_id uuid NOT NULL,
      PRIMARY KEY (a_id, b_id)
    );
    ALTER TABLE fixture.item ENABLE ROW LEVEL SECURITY;
    ALTER TABLE fixture.item FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON fixture.item USING (workspace_id = exec.current_workspace_id())
      WITH CHECK (workspace_id = exec.current_workspace_id());
    ALTER TABLE fixture.link ENABLE ROW LEVEL SECURITY;
    ALTER TABLE fixture.link FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON fixture.link USING (workspace_id = exec.current_workspace_id())
      WITH CHECK (workspace_id = exec.current_workspace_id());
    GRANT USAGE ON SCHEMA fixture TO app_rw, app_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON fixture.item, fixture.link TO app_rw, app_worker;
  `);
}

export interface FixtureControls {
  /** Hooks fail this many times before succeeding (interruption/resume tests). */
  failContent: number;
  failProjections: number;
  /** The evidence-lock check fails this many times (crash before the split). */
  failEvidence: number;
  contentCalls: number;
  projectionCalls: number;
  withPurgeHooks: boolean;
}

export function fixtureAdapter(c: FixtureControls): RecordTypeAdapter {
  return {
    recordType: 'foundation_fixture',
    async children(tx, parentIds) {
      const r = await sql<{
        id: string;
      }>`SELECT id FROM fixture.item WHERE parent_id = ANY(${parentIds}::uuid[]) ORDER BY id`.execute(
        tx.db,
      );
      return r.rows.map((x) => ({ id: x.id, recordType: 'foundation_fixture' }));
    },
    async containerOf(tx, recordId) {
      const r = await sql<{
        parent_id: string | null;
      }>`SELECT parent_id FROM fixture.item WHERE id = ${recordId}`.execute(tx.db);
      const p = r.rows[0]?.parent_id;
      return p ? { id: p, recordType: 'foundation_fixture' } : null;
    },
    async evidenceLocked(tx, ids) {
      if (c.failEvidence > 0) {
        c.failEvidence -= 1;
        throw new Error('evidence check interrupted');
      }
      const r = await sql<{
        id: string;
      }>`SELECT id FROM fixture.item WHERE id = ANY(${ids}::uuid[]) AND evidence_locked`.execute(
        tx.db,
      );
      return r.rows.map((x) => x.id);
    },
    get purge() {
      if (!c.withPurgeHooks) return undefined;
      return {
        async deleteContent(tx: WorkspaceTransaction, ids: readonly string[]) {
          c.contentCalls += 1;
          if (c.failContent > 0) {
            c.failContent -= 1;
            throw new Error('content hook interrupted');
          }
          await sql`DELETE FROM fixture.item WHERE id = ANY(${[...ids]}::uuid[])`.execute(tx.db);
        },
        async removeAssociations(tx: WorkspaceTransaction, ids: readonly string[]) {
          const r =
            await sql`DELETE FROM fixture.link WHERE a_id = ANY(${[...ids]}::uuid[]) OR b_id = ANY(${[...ids]}::uuid[])`.execute(
              tx.db,
            );
          return Number(r.numAffectedRows ?? 0n);
        },
        async objectKeys(_tx: WorkspaceTransaction, ids: readonly string[]) {
          return ids.map((id) => `obj-${id}`);
        },
        async removeProjections() {
          c.projectionCalls += 1;
          if (c.failProjections > 0) {
            c.failProjections -= 1;
            throw new Error('projection hook interrupted');
          }
        },
      };
    },
  };
}

export interface LifecycleEnv {
  controls: FixtureControls;
  registry: LifecycleRegistry;
  svc: LifecycleService;
  executor: PurgeExecutor;
  ledger: PurgeLedger;
  worker: WorkerRuntime;
  principal: { type: 'member'; id: string };
  exec(ws: string): ExecutionContext;
  cmd(ws: string): CommandContext;
  /** Creates a fixture record (envelope + typed row) under an optional parent. */
  create(
    ws: string,
    title: string,
    parent?: string,
    options?: { evidenceLocked?: boolean; brandId?: string },
  ): Promise<string>;
  link(ws: string, a: string, b: string): Promise<void>;
  /** Runs worker cycles until no job is claimed. */
  drain(): Promise<void>;
}

export function lifecycleEnv(
  h: Harness,
  options: {
    ledger: PurgeLedger;
    retention?: Partial<Record<RetentionClassKey, number>>;
    holds?: HoldPort;
    brands?: { isActive(tx: WorkspaceTransaction, brandId: string): Promise<boolean> };
    withPurgeHooks?: boolean;
  },
): LifecycleEnv {
  const controls: FixtureControls = {
    failContent: 0,
    failProjections: 0,
    failEvidence: 0,
    contentCalls: 0,
    projectionCalls: 0,
    withPurgeHooks: options.withPurgeHooks ?? true,
  };
  const registry = new LifecycleRegistry().register(fixtureAdapter(controls));
  const writer = new AuditWriter({
    module: 'lifecycle',
    logger: h.logger,
    metrics: h.telemetry.metrics,
  });
  const svc = new LifecycleService({
    registry,
    writer,
    retention: new RetentionPolicy({ retentionPeriodsMs: options.retention ?? {} }),
    ...(options.holds ? { holds: options.holds } : {}),
    ...(options.brands ? { brands: options.brands } : {}),
    metrics: h.telemetry.metrics,
    logger: h.logger,
  });
  const executor = new PurgeExecutor(svc, options.ledger);
  const scheduler = {
    svc,
    tenant: h.worker,
    discovery: h.discovery,
    systemPrincipalId: SYSTEM_PRINCIPAL.id,
  };
  const j = h.config.jobs;
  const worker = new WorkerRuntime({
    db: h.worker,
    platformDb: h.platformWorker,
    discovery: h.discovery,
    handlers: [
      purgeJobHandler(executor),
      purgeSchedulerHandler(scheduler),
      tombstoneSweepHandler(scheduler),
    ],
    consumers: [new ActivityProjector()],
    schedules: LIFECYCLE_SCHEDULES,
    params: {
      ...j,
      backoffBaseMs: 1,
      backoffCapMs: 1,
      shutdownGraceMs: 200,
      outboxReplayWindowMs: h.config.retention.outboxReplayWindowMs,
      maintenanceIntervalMs: 3_600_000,
      statsIntervalMs: 3_600_000,
    },
    buildId: 'test',
    logger: h.logger,
    metrics: h.telemetry.metrics,
    tracer: h.telemetry.tracer,
    errors: new LogErrorReporter(h.logger),
  });
  const principal = syntheticPrincipal('member') as { type: 'member'; id: string };
  const exec = (ws: string) => executionContext(ws, principal);
  return {
    controls,
    registry,
    svc,
    executor,
    ledger: options.ledger,
    worker,
    principal,
    exec,
    cmd: (ws) => CommandContext.fromExecution(exec(ws), { kind: 'ui' }),
    async create(ws, title, parent, o = {}) {
      return h.app.withWorkspace(ws, { module: 'test' }, async (tx) => {
        const env = await createRecord(
          tx,
          writer,
          CommandContext.fromExecution(exec(ws), { kind: 'ui' }, { brandId: o.brandId ?? null }),
          {
            recordType: 'foundation_fixture',
            brandId: o.brandId ?? null,
          },
        );
        await sql`INSERT INTO fixture.item (id, workspace_id, scope_key, parent_id, title, evidence_locked)
                  VALUES (${env.id}, ${ws}, ${o.brandId ?? ws}, ${parent ?? null}, ${title}, ${o.evidenceLocked ?? false})`.execute(
          tx.db,
        );
        return env.id;
      });
    },
    async link(ws, a, b) {
      await h.app.withWorkspace(ws, { module: 'test' }, (tx) =>
        sql`INSERT INTO fixture.link (workspace_id, a_id, b_id) VALUES (${ws}, ${a}, ${b})`.execute(
          tx.db,
        ),
      );
    },
    async drain() {
      if (worker.state !== 'running') await worker.start({ loop: false });
      for (let i = 0; i < 30; i++) {
        const r = await worker.runCycle({ wait: true });
        if (r.claimed === 0 && r.dispatched === 0) {
          // Retries are scheduled 1 ms out: give them one more pass.
          await new Promise((res) => setTimeout(res, 5));
          const again = await worker.runCycle({ wait: true });
          if (again.claimed === 0 && again.dispatched === 0) break;
        }
      }
    },
  };
}

export function newLedgerDir(): string {
  return `${process.env.TMPDIR ?? '/tmp'}/pm-ledger-${newUuidV7()}`;
}

export { LocalFilePurgeLedger };
