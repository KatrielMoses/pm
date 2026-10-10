import type { LifecycleConfig, RetentionClassKey } from '@pm/config';
import { sql, type WorkspaceTransaction } from '@pm/db';

/**
 * Retention values (0B §8, ADR-11). Every period is a named, nullable policy value; nothing here
 * chooses a duration. Resolution: the workspace's most specific `governance.retention_policy` row
 * in force wins (even when its period is NULL); otherwise the platform default from configuration.
 * NULL means "not decided": the dependent purge or sweep does nothing.
 *
 *   R-LIVE   trash recovery period (TRASH_RECOVERY_PERIOD, OD-34): trashed → purge eligibility
 *   R-AUDIT  audit retention (OD-36): also the tombstone final-sweep horizon (0B §8.7)
 */
export class RetentionPolicy {
  readonly #platform: Readonly<Partial<Record<RetentionClassKey, number>>>;

  constructor(config: Pick<LifecycleConfig, 'retentionPeriodsMs'>) {
    this.#platform = Object.freeze({ ...config.retentionPeriodsMs });
  }

  platformPeriodMs(cls: RetentionClassKey): number | null {
    return this.#platform[cls] ?? null;
  }

  async periodMs(tx: WorkspaceTransaction, cls: RetentionClassKey): Promise<number | null> {
    const row = await sql<{ ms: string | null }>`
      SELECT (extract(epoch FROM p.period) * 1000)::bigint::text AS ms
      FROM governance.retention_policy p
      WHERE p.workspace_id = ${tx.workspaceId} AND p.retention_class = ${cls} AND p.effective_from <= now()
      ORDER BY p.effective_from DESC LIMIT 1`.execute(tx.db);
    if (row.rows.length) return row.rows[0]!.ms === null ? null : Number(row.rows[0]!.ms);
    return this.platformPeriodMs(cls);
  }
}
