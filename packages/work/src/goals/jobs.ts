import { AuditWriter } from '@pm/audit';
import { sql, type PlatformDiscovery, type TenantDatabase } from '@pm/db';
import { errorFields, type Logger, type Metrics } from '@pm/observability';
import type { JobHandler, RecurringJob } from '@pm/platform';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from '../validation.ts';
import { recalcGoal } from './recalc.ts';

export const GOAL_QUEUE = 'goals';
export const GOAL_JOB_KINDS = { recalculate: 'goals.recalculate' } as const;

/** Every minute: goals whose derived state is due (changed, never computed, or past its recheck). */
export const GOAL_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: GOAL_JOB_KINDS.recalculate,
    queue: GOAL_QUEUE,
    intervalMs: 60_000,
    maxAttempts: 3,
    timeoutSeconds: 240,
  },
];

export interface GoalJobDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  metrics: Metrics;
  logger: Logger;
  settings?: WorkSettings;
}

/** Retry delay after a failed recalculation: doubles each attempt, never beyond the recheck interval. */
export function recalcBackoffMs(attempts: number, intervalMinutes: number): number {
  return Math.min(2 ** Math.max(attempts, 1) * 60_000, intervalMinutes * 60_000);
}

/**
 * The recalculation sweep (ADR-0028 G11). Discovery is payload-free and bounded; each workspace
 * claims at most `GOALS_RECALC_BATCH_MAX` due goals with a lease (`FOR UPDATE SKIP LOCKED`), then
 * recomputes each in its own transaction. A crashed worker's goals come back when the lease lapses;
 * a failing goal backs off, is reported as failing once it reaches `GOALS_RECALC_MAX_ATTEMPTS`, and
 * never blocks the others. Recomputing is idempotent, so a repeat or an overlap changes nothing.
 */
export function goalRecalcHandler(d: GoalJobDeps): JobHandler {
  const s = d.settings ?? DEFAULT_WORK_SETTINGS;
  const writer = new AuditWriter({ module: 'work', logger: d.logger, metrics: d.metrics });
  return {
    kind: GOAL_JOB_KINDS.recalculate,
    queue: GOAL_QUEUE,
    maxAttempts: 3,
    timeoutMs: 240_000,
    async handle() {
      const now = new Date();
      const workspaces = await d.discovery.discoverGoalWork(now, 100);
      for (const ws of workspaces) {
        const claimed = await d.tenant.withWorkspace(ws, { module: 'goals' }, async (tx) => {
          const rows = (
            await sql<{ goal_id: string }>`
              SELECT goal_id FROM goals.goal_state
               WHERE workspace_id = ${ws} AND next_check_at <= ${now}
                 AND (claimed_until IS NULL OR claimed_until <= ${now})
               ORDER BY next_check_at, goal_id LIMIT ${s.goalsRecalcBatchMax} FOR UPDATE SKIP LOCKED`.execute(
              tx.db,
            )
          ).rows.map((r) => r.goal_id);
          if (rows.length)
            await sql`UPDATE goals.goal_state SET claimed_until = ${new Date(now.getTime() + s.goalsRecalcLeaseSeconds * 1000)},
                attempts = attempts + 1 WHERE workspace_id = ${ws} AND goal_id = ANY(${rows}::uuid[])`.execute(
              tx.db,
            );
          return rows;
        });
        for (const goalId of claimed) {
          try {
            await d.tenant.withWorkspace(ws, { module: 'goals' }, (tx) =>
              recalcGoal(
                tx,
                writer,
                goalId,
                {
                  goalUpdateStaleDays: s.goalUpdateStaleDays,
                  goalsRecalcIntervalMinutes: s.goalsRecalcIntervalMinutes,
                },
                new Date(),
              ),
            );
            d.metrics.count('goals.jobs', 1, { kind: 'recalculate', outcome: 'ok' });
          } catch (err) {
            d.logger.warn('goals.recalc_failed', errorFields(err));
            d.metrics.count('goals.jobs', 1, { kind: 'recalculate', outcome: 'failed' });
            await d.tenant
              .withWorkspace(ws, { module: 'goals' }, async (tx) => {
                const row = (
                  await sql<{ attempts: number }>`SELECT attempts FROM goals.goal_state
                     WHERE workspace_id = ${ws} AND goal_id = ${goalId}`.execute(tx.db)
                ).rows[0];
                const attempts = Number(row?.attempts ?? 1);
                await sql`UPDATE goals.goal_state SET claimed_until = NULL, last_error = 'recalc_failed',
                    next_check_at = ${new Date(Date.now() + recalcBackoffMs(attempts, s.goalsRecalcIntervalMinutes))}
                  WHERE workspace_id = ${ws} AND goal_id = ${goalId}`.execute(tx.db);
              })
              .catch(() => undefined);
          }
        }
      }
    },
  };
}
