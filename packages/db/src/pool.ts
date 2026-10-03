import pg from 'pg';
import { SpanKind, type Tracer } from '@opentelemetry/api';
import type { DbConnectionConfig, ServerConfig } from '@pm/config';
import { errorFields, type Logger, type Metrics } from '@pm/observability';

const { Pool, types: pgTypes } = pg;

/** int8 values are counts, versions, and epochs; refuse silently-lossy conversions. */
function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError('int8 value exceeds the safe integer range');
  return n;
}

const typeParsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === 20 && format !== 'binary') return parseInt8;
    return pgTypes.getTypeParser(oid, format);
  },
};

export interface PoolDeps {
  logger: Logger;
  metrics: Metrics;
  tracer: Tracer;
}

export interface InstrumentedPool {
  readonly identity: DbConnectionConfig['identity'];
  readonly role: string;
  readonly raw: pg.Pool;
  /** Instrumented, content-free query on a pooled connection (no tenant context: platform tables only). */
  query<R extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
  /** Kysely-compatible pool whose clients emit content-free query spans. */
  readonly kyselyPool: {
    connect(): Promise<pg.PoolClient>;
    end(): Promise<void>;
    options: object;
  };
  end(): Promise<void>;
  recordSaturation(): void;
}

/** First SQL keyword only: never statement text or bind values (0D §17.1). */
export function sqlOperationName(sql: unknown): string {
  const text =
    typeof sql === 'string'
      ? sql
      : typeof sql === 'object' && sql && 'text' in sql
        ? String((sql as { text: unknown }).text)
        : '';
  const m = /^\s*(?:with\b[\s\S]*?\)\s*)?([a-z]+)/i.exec(text);
  const op = (m?.[1] ?? 'unknown').toUpperCase();
  return /^(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE|CALL|WITH|VALUES)$/.test(
    op,
  )
    ? op
    : 'OTHER';
}

export function createPool(
  conn: DbConnectionConfig,
  db: ServerConfig['database'],
  deps: PoolDeps,
  options: { applicationName: string; max?: number },
): InstrumentedPool {
  const pool = new Pool({
    connectionString: conn.url.reveal(),
    max: options.max ?? db.poolMax,
    connectionTimeoutMillis: db.connectTimeoutMs,
    idleTimeoutMillis: 30_000,
    statement_timeout: db.statementTimeoutMs,
    lock_timeout: db.lockTimeoutMs,
    idle_in_transaction_session_timeout: db.idleInTransactionTimeoutMs,
    application_name: options.applicationName,
    types: typeParsers,
  });
  // Driver error messages can contain values; log the class and SQLSTATE only.
  pool.on('error', (err) => {
    deps.logger.error('db.pool.client_error', { identity: conn.identity, ...errorFields(err) });
  });

  const instrumentClient = (client: pg.PoolClient): pg.PoolClient => {
    const originalQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    const query = (...args: unknown[]): Promise<unknown> => {
      const op = sqlOperationName(args[0]);
      const span = deps.tracer.startSpan(`db.${op.toLowerCase()}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          'db.system.name': 'postgresql',
          'db.operation.name': op,
          'pm.db.identity': conn.identity,
        },
      });
      const result = originalQuery(...args);
      return result.then(
        (r) => {
          span.end();
          return r;
        },
        (err: unknown) => {
          span.setAttribute('error.type', (err as { code?: string }).code ?? 'unknown');
          span.end();
          throw err;
        },
      );
    };
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'query') return query;
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  };

  return {
    identity: conn.identity,
    role: conn.role,
    raw: pool,
    async query<R extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
      const client = instrumentClient(await pool.connect());
      try {
        return (await client.query<R>(text, params)) as pg.QueryResult<R>;
      } finally {
        client.release();
      }
    },
    kyselyPool: {
      connect: async () => instrumentClient(await pool.connect()),
      // The owner of InstrumentedPool ends the underlying pool exactly once.
      end: () => Promise.resolve(),
      options: pool.options,
    },
    end: () => pool.end(),
    recordSaturation() {
      deps.metrics.gauge('db.pool.connections', pool.totalCount, {
        identity: conn.identity,
        state: 'total',
      });
      deps.metrics.gauge('db.pool.connections', pool.idleCount, {
        identity: conn.identity,
        state: 'idle',
      });
      deps.metrics.gauge('db.pool.connections', pool.waitingCount, {
        identity: conn.identity,
        state: 'waiting',
      });
    },
  };
}

export class IdentityError extends Error {
  constructor(reason: string) {
    super(`database identity check failed: ${reason}`);
    this.name = 'IdentityError';
  }
}

/**
 * Startup guard (0C §12.3, §12.6): an application identity must be the expected login role, must not
 * be a superuser, must not bypass RLS, must not own or be able to act as the owner of any object,
 * and the database must be bound to the same deployment environment.
 */
export async function assertApplicationIdentity(
  pool: InstrumentedPool,
  expectedEnvironment: string,
): Promise<void> {
  const { rows } = await pool.query<{
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    owner_member: boolean;
    owned_objects: number;
  }>(`
    SELECT current_user,
           r.rolsuper,
           r.rolbypassrls,
           pg_has_role(current_user, 'pm_owner', 'MEMBER') AS owner_member,
           (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid)::int AS owned_objects
    FROM pg_roles r
    WHERE r.rolname = current_user`);
  const row = rows[0];
  if (!row) throw new IdentityError('role not found');
  if (row.current_user !== pool.role)
    throw new IdentityError(`connected as an unexpected role (expected ${pool.role})`);
  if (row.rolsuper) throw new IdentityError('superuser connections are not allowed');
  if (row.rolbypassrls) throw new IdentityError('roles with BYPASSRLS are not allowed');
  if (row.owner_member) throw new IdentityError('application identities must not act as the owner');
  if (row.owned_objects > 0) throw new IdentityError('application identities must not own tables');
  const env = await pool.query<{ environment: string }>(
    'SELECT environment FROM ops.environment_binding',
  );
  const environment = env.rows[0]?.environment;
  if (environment === undefined)
    throw new IdentityError('database has no environment binding (run migrations)');
  if (environment !== expectedEnvironment) {
    throw new IdentityError(
      `database is bound to a different environment than ${expectedEnvironment}`,
    );
  }
}
