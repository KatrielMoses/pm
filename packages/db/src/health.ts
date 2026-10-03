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
}
