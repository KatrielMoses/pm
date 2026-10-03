import type { InstrumentedPool } from './pool.ts';

/**
 * Health queries for the ordinary identities. They read only platform metadata (no tenant tables)
 * and run outside tenant context by design.
 */
export class PlatformHealth {
  readonly #pool: InstrumentedPool;

  constructor(pool: InstrumentedPool) {
    this.#pool = pool;
  }

  async ping(): Promise<void> {
    await this.#pool.query('SELECT 1');
  }

  async appliedMigrationVersion(): Promise<number> {
    const { rows } = await this.#pool.query<{ version: number | null }>(
      'SELECT max(version) AS version FROM ops.schema_migration',
    );
    return rows[0]?.version ?? 0;
  }

  /** Age of the freshest heartbeat from a running (not stopping) worker, or null when none. */
  async freshestWorkerHeartbeatAgeMs(): Promise<number | null> {
    const { rows } = await this.#pool.query<{ age_ms: number | null }>(
      `SELECT (extract(epoch FROM now() - max(last_seen_at)) * 1000)::bigint AS age_ms
       FROM ops.worker_heartbeat WHERE NOT stopping`,
    );
    return rows[0]?.age_ms ?? null;
  }

  /**
   * Tenant-isolation policy state required by 1C, read from the catalog only (no tenant rows):
   * every tenancy/access table with `workspace_id` has RLS enabled and forced with exactly one
   * `tenant_isolation` policy, and the account directory functions are security-definer functions
   * owned by `pm_directory`. A drifted or partially restored schema fails readiness.
   */
  async tenantIsolationIntact(): Promise<boolean> {
    const { rows } = await this.#pool.query<{ ok: boolean }>(
      `SELECT
         NOT EXISTS (
           SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind = 'r' AND n.nspname IN ('tenancy', 'access')
             AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped)
             AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
                  OR (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') <> 1))
         AND (SELECT count(*) FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace
              WHERE n.nspname = 'tenancy' AND f.prosecdef
                AND pg_get_userbyid(f.proowner) = 'pm_directory'
                AND f.proname IN ('account_workspaces', 'resolve_membership', 'workspace_by_creation_key',
                                  'account_selected_workspace')) = 4
         AS ok`,
    );
    return rows[0]?.ok === true;
  }

  /** False while a restored environment awaits purge-ledger replay (ops.recovery_gate, 1F). */
  async recoveryGateOpen(): Promise<boolean> {
    const { rows } = await this.#pool.query<{ state: string }>(
      'SELECT state FROM ops.recovery_gate WHERE id = 1',
    );
    return rows[0]?.state === 'open';
  }
}
