import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Disposable PostgreSQL for integration tests. Real PostgreSQL only - never an in-memory stand-in.
 *   container: Testcontainers (CI default; requires a Docker-compatible runtime)
 *   embedded:  real PostgreSQL binaries from `embedded-postgres` in a temp directory (no Docker)
 *   external:  PM_TEST_PG_ADMIN_URL (an administrative URL to a throwaway cluster)
 *   auto:      container when a Docker socket is reachable, otherwise embedded
 */
export type PostgresMode = 'container' | 'embedded' | 'external';

/** Pinned image for CI and compose parity (PostgreSQL 18). */
export const POSTGRES_IMAGE =
  'postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650';

export interface PostgresServer {
  readonly mode: PostgresMode;
  readonly host: string;
  readonly port: number;
  adminUrl(database?: string): string;
  stop(): Promise<void>;
}

function dockerAvailable(): boolean {
  return Boolean(process.env.DOCKER_HOST) || existsSync('/var/run/docker.sock');
}

export function resolveMode(): PostgresMode {
  const requested = process.env.PM_TEST_PG ?? 'auto';
  if (requested === 'container' || requested === 'embedded' || requested === 'external')
    return requested;
  if (requested !== 'auto')
    throw new Error('PM_TEST_PG must be auto, container, embedded, or external');
  if (process.env.PM_TEST_PG_ADMIN_URL) return 'external';
  return dockerAvailable() ? 'container' : 'embedded';
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

function makeUrl(
  user: string,
  password: string,
  host: string,
  port: number,
  database: string,
): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

export interface StartOptions {
  mode?: PostgresMode;
  /** Embedded only: keep data in this directory across runs (local development). */
  dataDir?: string;
  port?: number;
  adminPassword?: string;
}

export async function startPostgres(options: StartOptions = {}): Promise<PostgresServer> {
  const mode = options.mode ?? resolveMode();
  const adminUser = 'pm_admin';
  const adminPassword = options.adminPassword ?? randomBytes(18).toString('base64url');

  if (mode === 'external') {
    const url = process.env.PM_TEST_PG_ADMIN_URL;
    if (!url) throw new Error('PM_TEST_PG_ADMIN_URL is required for external mode');
    const parsed = new URL(url);
    return {
      mode,
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      adminUrl: (database = 'postgres') => {
        const u = new URL(url);
        u.pathname = `/${database}`;
        return u.toString();
      },
      stop: async () => {},
    };
  }

  if (mode === 'container') {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withUsername(adminUser)
      .withPassword(adminPassword)
      .withDatabase('postgres')
      .start();
    const host = container.getHost();
    const port = container.getPort();
    return {
      mode,
      host,
      port,
      adminUrl: (database = 'postgres') => makeUrl(adminUser, adminPassword, host, port, database),
      stop: async () => {
        await container.stop();
      },
    };
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  keepFailureExitCode();
  const port = options.port ?? (await freePort());
  const persistent = options.dataDir !== undefined;
  const databaseDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'pm-pg-')));
  const server = new EmbeddedPostgres({
    databaseDir,
    port,
    user: adminUser,
    password: adminPassword,
    authMethod: 'scram-sha-256',
    persistent,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: () => {},
  });
  if (!persistent || !existsSync(join(databaseDir, 'PG_VERSION'))) await server.initialise();
  await server.start();
  return {
    mode,
    host: '127.0.0.1',
    port,
    adminUrl: (database = 'postgres') =>
      makeUrl(adminUser, adminPassword, '127.0.0.1', port, database),
    stop: async () => {
      await server.stop();
    },
  };
}

export async function adminQuery(
  server: PostgresServer,
  sql: string,
  params: unknown[] = [],
  database?: string,
): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: server.adminUrl(database) });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

export { makeUrl };

let exitCodeGuarded = false;
/**
 * `embedded-postgres` installs `async-exit-hook`, which answers `beforeExit` with an explicit
 * `process.exit(0)` and so discards the failing exit code a test runner has already set: a run
 * with failed tests would exit 0. Remember the code at `beforeExit` and restore it on `exit`.
 */
export function keepFailureExitCode(): void {
  if (exitCodeGuarded) return;
  exitCodeGuarded = true;
  let pending: number | undefined;
  process.on('beforeExit', () => {
    const code = Number(process.exitCode ?? 0);
    if (code) pending = code;
  });
  process.on('exit', (code) => {
    if (code === 0 && pending) process.exitCode = pending;
  });
}
