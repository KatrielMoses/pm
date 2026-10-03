// Local PostgreSQL without Docker: real PostgreSQL 18 binaries (embedded-postgres) with data in
// .local/pg. Bootstraps roles, migrates as `migrator`, writes .env on first run, and keeps running.
// With Docker, `docker compose up db migrate` is the equivalent.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { bootstrapRoles, LOGIN_ROLES, Migrator } from '../packages/db/src/index.ts';
import { adminQuery, startPostgres } from '../packages/test-support/src/postgres.ts';

const PORT = 54329;
const DB = 'pm_local';
mkdirSync('.local', { recursive: true });
if (existsSync('.env')) process.loadEnvFile('.env');

const passwordFrom = (envVar: string) => {
  const v = process.env[envVar];
  return v ? decodeURIComponent(new URL(v).password) : undefined;
};
const passwords = {
  app_rw: passwordFrom('DATABASE_APP_URL'),
  app_worker: passwordFrom('DATABASE_WORKER_URL'),
  dispatcher: passwordFrom('DATABASE_DISPATCHER_URL'),
  migrator: passwordFrom('DATABASE_MIGRATOR_URL'),
  restore_operator: undefined as string | undefined,
};
const fresh = Object.values(passwords)
  .slice(0, 4)
  .some((p) => !p || p.startsWith('CHANGE_ME'));
const pw = Object.fromEntries(
  LOGIN_ROLES.map((r) => [r, (!fresh && passwords[r]) || randomBytes(18).toString('base64url')]),
) as Record<(typeof LOGIN_ROLES)[number], string>;
// The cluster's admin password lives beside its data directory (gitignored, owner-only).
const ADMIN_FILE = '.local/admin.env';
if (!existsSync(ADMIN_FILE))
  writeFileSync(ADMIN_FILE, `PM_LOCAL_ADMIN_PASSWORD=${randomBytes(18).toString('base64url')}\n`, {
    mode: 0o600,
  });
process.loadEnvFile(ADMIN_FILE);
const server = await startPostgres({
  mode: 'embedded',
  dataDir: '.local/pg',
  port: PORT,
  adminPassword: process.env.PM_LOCAL_ADMIN_PASSWORD!,
});

const exists = await adminQuery(server, 'SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
if (!exists.rowCount) await adminQuery(server, `CREATE DATABASE ${DB}`);
await bootstrapRoles(server.adminUrl(DB), DB, pw);
const url = (role: string) =>
  `postgres://${role}:${pw[role as keyof typeof pw]}@127.0.0.1:${PORT}/${DB}`;
if (fresh) {
  writeFileSync(
    '.env',
    `APP_ENV=local\nDATABASE_APP_URL=${url('app_rw')}\nDATABASE_WORKER_URL=${url('app_worker')}\nDATABASE_DISPATCHER_URL=${url('dispatcher')}\nDATABASE_MIGRATOR_URL=${url('migrator')}\nHTTP_HOST=127.0.0.1\nHTTP_PORT=3000\nLOG_LEVEL=info\n`,
    { mode: 0o600 },
  );
  console.log('wrote .env with generated local credentials');
}
const result = await new Migrator({ connectionString: url('migrator'), environment: 'local' }).up();
console.log(
  `PostgreSQL ${server.mode} on 127.0.0.1:${PORT}/${DB}; applied ${result.applied.length} migration(s). Ctrl-C to stop.`,
);
const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
