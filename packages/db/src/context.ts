import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import type { Tracer } from '@opentelemetry/api';
import { isUuidV7 } from '@pm/contracts';
import type { Logger, Metrics } from '@pm/observability';
import type { InstrumentedPool } from './pool.ts';
import type { Database } from './schema.ts';

export class TenantContextError extends Error {
  readonly reason: 'invalid_workspace_id' | 'context_mismatch' | 'workspace_unknown';

  constructor(reason: TenantContextError['reason']) {
    super(`tenant context rejected: ${reason}`);
    this.name = 'TenantContextError';
    this.reason = reason;
  }
}

export interface WorkspaceTransaction {
  /** Internal workspace UUIDv7 set as the transaction-local RLS context. */
  readonly workspaceId: string;
  readonly db: Transaction<Database>;
}

export interface WorkspaceTxOptions {
  /** Bounded label for `db.transaction.duration` (module name). */
  module: string;
  readOnly?: boolean;
  /**
   * Only for creating the tenant root itself (1C) and synthetic fixtures: skips the check that
   * the workspace row exists. The RLS context is still set and asserted.
   */
  creatingWorkspace?: boolean;
}

/**
 * Tenant-scoped database access for the ordinary application identities (`app_rw`, `app_worker`).
 * The only way to run SQL is `withWorkspace`, which opens an explicit transaction, sets
 * `app.workspace_id` transaction-locally, and asserts it before the first query (0C §12.5).
 */
export class TenantDatabase {
  readonly #kysely: Kysely<Database>;
  readonly #pool: InstrumentedPool;
  readonly #metrics: Metrics;
  readonly #logger: Logger;

  constructor(pool: InstrumentedPool, deps: { metrics: Metrics; logger: Logger; tracer: Tracer }) {
    if (pool.identity !== 'app' && pool.identity !== 'worker') {
      throw new Error('TenantDatabase requires the app or worker identity');
    }
    this.#pool = pool;
    this.#metrics = deps.metrics;
    this.#logger = deps.logger;
    this.#kysely = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: pool.kyselyPool }),
    });
  }

  get identity(): 'app' | 'worker' {
    return this.#pool.identity as 'app' | 'worker';
  }

  async withWorkspace<T>(
    workspaceId: string,
    options: WorkspaceTxOptions,
    fn: (tx: WorkspaceTransaction) => Promise<T>,
  ): Promise<T> {
    // Fail closed before touching the database: the context must be a well-formed internal key.
    if (typeof workspaceId !== 'string' || !isUuidV7(workspaceId)) {
      throw new TenantContextError('invalid_workspace_id');
    }
    const started = performance.now();
    let builder = this.#kysely.transaction();
    if (options.readOnly) builder = builder.setAccessMode('read only');
    try {
      return await builder.execute(async (trx) => {
        await sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`.execute(trx);
        const check = await sql<{ matches: boolean; known: boolean }>`
          SELECT exec.current_workspace_id() = ${workspaceId}::uuid AS matches,
                 EXISTS (SELECT 1 FROM tenancy.workspace WHERE id = ${workspaceId}::uuid) AS known`.execute(
          trx,
        );
        const row = check.rows[0];
        if (!row?.matches) {
          this.#metrics.count('db.rls_context_assertion_failures', 1, { module: options.module });
          this.#logger.error('db.rls_context_assertion_failed', {
            identity: this.identity,
            component: options.module,
          });
          throw new TenantContextError('context_mismatch');
        }
        if (!row.known && !options.creatingWorkspace)
          throw new TenantContextError('workspace_unknown');
        return fn({ workspaceId, db: trx });
      });
    } finally {
      this.#metrics.record('db.transaction.duration', performance.now() - started, {
        module: options.module,
        kind: options.readOnly ? 'read' : 'write',
      });
    }
  }

  async destroy(): Promise<void> {
    await this.#kysely.destroy();
  }
}

export interface PlatformTransaction {
  /** Always null: platform transactions never carry a tenant context. */
  readonly workspaceId: null;
  readonly db: Transaction<Database>;
}

/** A transaction in exactly one scope: one workspace, or the platform (never both, never neither). */
export type ScopedTransaction = WorkspaceTransaction | PlatformTransaction;

export class PlatformContextError extends Error {
  constructor() {
    super('platform context rejected');
    this.name = 'PlatformContextError';
  }
}

/**
 * Explicit platform-scope access (identity, platform jobs, account-level idempotency). Opens a
 * transaction with `app.platform_scope = 'platform'` set transaction-locally and asserts that no
 * workspace context is present, so tenant rows stay invisible (migration 0010). Platform-scoped
 * tables without tenant RLS (identity, ops) are protected by column grants and repository checks.
 */
export class PlatformDatabase {
  readonly #kysely: Kysely<Database>;
  readonly #pool: InstrumentedPool;
  readonly #metrics: Metrics;
  readonly #logger: Logger;

  constructor(pool: InstrumentedPool, deps: { metrics: Metrics; logger: Logger; tracer: Tracer }) {
    if (pool.identity !== 'app' && pool.identity !== 'worker') {
      throw new Error('PlatformDatabase requires the app or worker identity');
    }
    this.#pool = pool;
    this.#metrics = deps.metrics;
    this.#logger = deps.logger;
    this.#kysely = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: pool.kyselyPool }),
    });
  }

  get identity(): 'app' | 'worker' {
    return this.#pool.identity as 'app' | 'worker';
  }

  async withPlatform<T>(
    options: {
      module: string;
      readOnly?: boolean;
      isolation?: 'read committed' | 'repeatable read' | 'serializable';
    },
    fn: (tx: PlatformTransaction) => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    let builder = this.#kysely.transaction();
    if (options.readOnly) builder = builder.setAccessMode('read only');
    if (options.isolation) builder = builder.setIsolationLevel(options.isolation);
    try {
      return await builder.execute(async (trx) => {
        await sql`SELECT set_config('app.platform_scope', 'platform', true)`.execute(trx);
        const check = await sql<{ ok: boolean }>`SELECT exec.in_platform_scope() AS ok`.execute(
          trx,
        );
        if (!check.rows[0]?.ok) {
          this.#metrics.count('db.rls_context_assertion_failures', 1, { module: options.module });
          this.#logger.error('db.platform_context_assertion_failed', {
            identity: this.identity,
            component: options.module,
          });
          throw new PlatformContextError();
        }
        return fn({ workspaceId: null, db: trx });
      });
    } finally {
      this.#metrics.record('db.transaction.duration', performance.now() - started, {
        module: options.module,
        kind: options.readOnly ? 'read' : 'write',
      });
    }
  }
}
