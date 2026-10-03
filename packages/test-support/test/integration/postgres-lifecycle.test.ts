import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { resolveMode, startPostgres } from '@pm/test-infra';
import { generatePasswords, provisionDatabase } from '@pm/test-support';

// Exercises the configured disposable-PostgreSQL path (PM_TEST_PG; `container` in CI) end to end,
// independently of the shared server used by the other suites.

const canConnect = async (url: string) => {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
};

describe(`disposable PostgreSQL lifecycle (${resolveMode()})`, () => {
  it('starts empty, bootstraps and migrates with the intended identities, and is removed on stop', async () => {
    const server = await startPostgres();
    try {
      const fresh = new pg.Client({ connectionString: server.adminUrl() });
      await fresh.connect();
      const dbs = await fresh.query(
        "SELECT datname FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1') ORDER BY 1",
      );
      const roles = await fresh.query(
        "SELECT rolname FROM pg_roles WHERE rolname IN ('app_rw', 'app_worker', 'dispatcher', 'migrator', 'restore_operator', 'pm_owner', 'pm_scheduler')",
      );
      await fresh.end();
      expect(dbs.rows).toEqual([]);
      expect(roles.rows).toEqual([]);

      const urls = await provisionDatabase(server, 'pm_lifecycle', generatePasswords());
      const admin = new pg.Client({ connectionString: server.adminUrl('pm_lifecycle') });
      await admin.connect();
      const history = await admin.query('SELECT DISTINCT applied_by FROM ops.schema_migration');
      const owners = await admin.query(
        `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('exec', 'tenancy') AND c.relkind = 'r'`,
      );
      await admin.end();
      expect(history.rows).toEqual([{ applied_by: 'migrator' }]);
      expect(owners.rows).toEqual([{ owner: 'pm_owner' }]);
      expect(await canConnect(urls.app)).toBe(true);
    } finally {
      await server.stop();
    }
    expect(await canConnect(server.adminUrl())).toBe(false);
  });

  it('cleans up when provisioning fails', async () => {
    const server = await startPostgres();
    try {
      await expect(provisionDatabase(server, 'Invalid-Name', generatePasswords())).rejects.toThrow(
        /invalid database name/,
      );
    } finally {
      await server.stop();
    }
    expect(await canConnect(server.adminUrl())).toBe(false);
  });
});
