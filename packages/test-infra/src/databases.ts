import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import './provided-context.ts';
import { adminQuery, makeUrl, type PostgresServer } from './postgres.ts';

const NAME = /^[a-z][a-z0-9_]{0,62}$/;

export async function createDatabase(
  server: PostgresServer,
  name: string,
  template?: string,
): Promise<void> {
  if (!NAME.test(name) || (template !== undefined && !NAME.test(template)))
    throw new Error('invalid database name');
  await adminQuery(
    server,
    template ? `CREATE DATABASE ${name} TEMPLATE ${template}` : `CREATE DATABASE ${name}`,
  );
}

/** How long teardown waits for a database's sessions to finish closing before forcing the drop. */
const DRAIN_WAIT_MS = 5_000;

export async function dropDatabase(server: PostgresServer, name: string): Promise<void> {
  if (!NAME.test(name)) throw new Error('invalid database name');
  // Ordered teardown: pools ended by a test may still be sending their termination messages.
  // Waiting until those sessions are gone means FORCE only ends sessions that truly linger, so a
  // closing client never sees 57P01 as an unhandled pool error. Bounded; never a retry.
  const deadline = Date.now() + DRAIN_WAIT_MS;
  for (;;) {
    const r = await adminQuery(
      server,
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    if (r.rows[0].n === 0 || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await adminQuery(server, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

/** The disposable server started by the integration global setup, seen from a test worker. */
export function sharedServer(): PostgresServer & {
  passwords: Readonly<Record<string, string>>;
  template: string;
} {
  const p = inject('pmPostgres');
  return {
    mode: p.mode as PostgresServer['mode'],
    host: p.host,
    port: p.port,
    adminUrl: (database = 'postgres') => {
      const u = new URL(p.adminUrl);
      u.pathname = `/${database}`;
      return u.toString();
    },
    stop: async () => {},
    passwords: p.passwords,
    template: p.template,
  };
}

export interface DisposableDatabase {
  readonly name: string;
  readonly server: PostgresServer;
  /** Login URL for a role whose password the global setup generated. */
  loginUrl(role: string): string;
  /** Superuser access for assertions that must look past RLS (catalog checks, crash simulation). */
  admin(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
  drop(): Promise<void>;
}

/**
 * A uniquely named database on the shared disposable server, optionally cloned from a template.
 * `prepare` is injected by the caller (dependency inversion): this package knows nothing about the
 * application's roles, bootstrap, or migrations.
 */
export async function createDisposableDatabase(options: {
  prefix: string;
  template?: string;
  prepare?: (adminUrl: string, name: string) => Promise<void>;
}): Promise<DisposableDatabase> {
  const server = sharedServer();
  const name = `${options.prefix}_${randomBytes(6).toString('hex')}`;
  await createDatabase(server, name, options.template);
  try {
    await options.prepare?.(server.adminUrl(name), name);
  } catch (err) {
    await dropDatabase(server, name);
    throw err;
  }
  const adminPool = new pg.Pool({ connectionString: server.adminUrl(name), max: 2 });
  // Teardown drops the database WITH (FORCE), which terminates any admin connection still open
  // (57P01). That termination is expected only while dropping; any other pool error still fails
  // the run as an unhandled error.
  let dropping = false;
  adminPool.on('error', (err: Error & { code?: string }) => {
    if (dropping && err.code === '57P01') return;
    throw err;
  });
  return {
    name,
    server,
    loginUrl: (role) => {
      const password = server.passwords[role];
      if (!password) throw new Error(`no generated password for role ${role}`);
      return makeUrl(role, password, server.host, server.port, name);
    },
    admin: (sql, params = []) => adminPool.query(sql, params),
    drop: async () => {
      dropping = true;
      await adminPool.end();
      await dropDatabase(server, name);
    },
  };
}
