import { sql, type PlatformDiscovery, type TenantDatabase } from '@pm/db';
import { errorFields, type Logger, type Metrics } from '@pm/observability';
import type { JobHandler, RecurringJob } from '@pm/platform';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from '../validation.ts';

export const METRICS_QUEUE = 'metrics';
export const METRICS_JOB_KINDS = { reconcile: 'metrics.reconcile' } as const;

/** Every five minutes: workspaces whose status-history reconciliation is due take one bounded step (5C). */
export const METRICS_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: METRICS_JOB_KINDS.reconcile,
    queue: METRICS_QUEUE,
    intervalMs: 300_000,
    maxAttempts: 3,
    timeoutSeconds: 240,
  },
];

export interface MetricsJobDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  metrics: Metrics;
  logger: Logger;
  settings?: WorkSettings;
}

/** Retry delay after a failed pass: doubles each attempt, never beyond the pass interval. */
export function reconcileBackoffMs(
  attempts: number,
  firstSeconds: number,
  intervalMinutes: number,
): number {
  return Math.min(firstSeconds * 1000 * 2 ** Math.max(attempts - 1, 0), intervalMinutes * 60_000);
}

export interface ReconcileStep {
  /** `claimed` is false when another worker holds the workspace or nothing is due. */
  claimed: boolean;
  checked: number;
  repaired: number;
  /** True when this step finished the pass (the next pass is then an interval away). */
  passComplete: boolean;
}

/**
 * One bounded reconciliation step for a workspace (ADR-0030 M11). The status ledger is written by a
 * trigger in each task's own transaction, so it cannot normally disagree with the tasks; this step
 * is the check that proves it and the repair if it ever does (a write path that bypassed the
 * trigger, a restore). It claims the workspace with a lease (so two workers never overlap),
 * examines at most `METRICS_RECONCILE_BATCH_MAX` tasks after its saved position, and repairs any
 * task whose open span disagrees with its status by closing that span and opening a `repaired` one
 * starting now (history is never backdated). Progress and repairs commit together, so a crash
 * loses nothing and a repeat repairs nothing twice; a failure backs off and is reported, never
 * hidden, and a crashed worker's workspace returns when its lease lapses.
 */
export async function reconcileWorkspace(
  d: MetricsJobDeps,
  workspaceId: string,
  now = new Date(),
): Promise<ReconcileStep> {
  const s = d.settings ?? DEFAULT_WORK_SETTINGS;
  const claim = await d.tenant.withWorkspace(workspaceId, { module: 'metrics' }, async (tx) => {
    const r = await sql<{ scan_after: string | null }>`
      UPDATE metrics.reconcile_state
         SET lease_until = ${new Date(now.getTime() + s.metricsReconcileLeaseSeconds * 1000)},
             pass_started_at = COALESCE(pass_started_at, ${now})
       WHERE workspace_id = ${workspaceId} AND next_run_at <= ${now}
         AND (lease_until IS NULL OR lease_until <= ${now})
       RETURNING scan_after`.execute(tx.db);
    return r.rows[0] ?? null;
  });
  if (!claim) return { claimed: false, checked: 0, repaired: 0, passComplete: false };
  try {
    return await d.tenant.withWorkspace(workspaceId, { module: 'metrics' }, async (tx) => {
      const batch = (
        await sql<{ id: string }>`
          SELECT t.id FROM work.task t
           WHERE t.workspace_id = ${workspaceId} AND (${claim.scan_after}::uuid IS NULL OR t.id > ${claim.scan_after}::uuid)
           ORDER BY t.id LIMIT ${s.metricsReconcileBatchMax}`.execute(tx.db)
      ).rows.map((r) => r.id);
      let repaired = 0;
      if (batch.length) {
        const drift = (ids: readonly string[]) => sql`
          SELECT t.id FROM work.task t
            JOIN core.record cr ON cr.workspace_id = t.workspace_id AND cr.id = t.id AND cr.lifecycle_state <> 'purged'
            LEFT JOIN metrics.task_status_span o
              ON o.workspace_id = t.workspace_id AND o.task_id = t.id AND o.left_at IS NULL
           WHERE t.workspace_id = ${workspaceId} AND t.id = ANY(${[...ids]}::uuid[])
             AND (o.task_id IS NULL OR o.status_id <> t.status_id OR o.status_category <> t.status_category)`;
        const candidates = (await drift(batch).execute(tx.db)).rows.map(
          (x) => (x as { id: string }).id,
        );
        let drifted: string[] = [];
        if (candidates.length) {
          // Lock the candidates' open spans (a status change takes the same lock until it commits,
          // its new span included), then look again with a fresh view: a task that moved while this
          // step was running is no longer in disagreement, and its new span must not be closed by
          // a repair. A task with no span at all has nothing to lock; if a writer gives it one
          // first, the insert below collides on the sequence, the step fails once, and the next
          // pass finds the task already in agreement.
          await sql`SELECT s.task_id FROM metrics.task_status_span s WHERE s.workspace_id = ${workspaceId}
                     AND s.task_id = ANY(${candidates}::uuid[]) AND s.left_at IS NULL
                     ORDER BY s.task_id FOR UPDATE`.execute(tx.db);
          drifted = (await drift(candidates).execute(tx.db)).rows.map(
            (x) => (x as { id: string }).id,
          );
        }
        // Two statements, not one: the unique index allows a single open span per task, and a
        // data-modifying CTE does not promise that the close lands before the insert.
        if (drifted.length) {
          await sql`
            UPDATE metrics.task_status_span s SET left_at = greatest(${now}::timestamptz, s.entered_at)
             WHERE s.workspace_id = ${workspaceId} AND s.task_id = ANY(${drifted}::uuid[]) AND s.left_at IS NULL`.execute(
            tx.db,
          );
          await sql`
            INSERT INTO metrics.task_status_span (workspace_id, task_id, seq, status_id, status_category, entered_at, basis)
            SELECT ${workspaceId}, t.id,
                   COALESCE((SELECT max(x.seq) FROM metrics.task_status_span x
                              WHERE x.workspace_id = ${workspaceId} AND x.task_id = t.id), 0) + 1,
                   t.status_id, t.status_category,
                   greatest(${now}::timestamptz, COALESCE((SELECT max(x.left_at) FROM metrics.task_status_span x
                              WHERE x.workspace_id = ${workspaceId} AND x.task_id = t.id), ${now}::timestamptz)),
                   'repaired'
              FROM work.task t WHERE t.workspace_id = ${workspaceId} AND t.id = ANY(${drifted}::uuid[])`.execute(
            tx.db,
          );
        }
        repaired = drifted.length;
      }
      const complete = batch.length < s.metricsReconcileBatchMax;
      if (complete)
        await sql`
          UPDATE metrics.reconcile_state
             SET scan_after = NULL, pass_started_at = NULL, pass_repaired = 0,
                 repaired_total = repaired_total + pass_repaired + ${repaired},
                 last_success_at = ${now}, attempts = 0, failure_code = NULL, lease_until = NULL,
                 next_run_at = ${new Date(now.getTime() + s.metricsReconcileIntervalMinutes * 60_000)}
           WHERE workspace_id = ${workspaceId}`.execute(tx.db);
      else
        await sql`
          UPDATE metrics.reconcile_state
             SET scan_after = ${batch.at(-1)!}, pass_repaired = pass_repaired + ${repaired},
                 lease_until = NULL, next_run_at = ${now}
           WHERE workspace_id = ${workspaceId}`.execute(tx.db);
      d.metrics.count('metrics.reconcile.jobs', 1, { outcome: repaired > 0 ? 'repaired' : 'ok' });
      return { claimed: true, checked: batch.length, repaired, passComplete: complete };
    });
  } catch (err) {
    d.logger.warn('metrics.reconcile_failed', errorFields(err));
    d.metrics.count('metrics.reconcile.jobs', 1, { outcome: 'failed' });
    await d.tenant
      .withWorkspace(workspaceId, { module: 'metrics' }, async (tx) => {
        const row = (
          await sql<{ attempts: number }>`
            SELECT attempts FROM metrics.reconcile_state WHERE workspace_id = ${workspaceId}`.execute(
            tx.db,
          )
        ).rows[0];
        const attempts = Number(row?.attempts ?? 0) + 1;
        const timeout = /timeout|canceling statement/i.test(
          err instanceof Error ? err.message : '',
        );
        await sql`
          UPDATE metrics.reconcile_state
             SET attempts = ${attempts}, last_failure_at = ${now}, lease_until = NULL,
                 failure_code = ${timeout ? 'timeout' : 'source_error'},
                 next_run_at = ${new Date(
                   now.getTime() +
                     reconcileBackoffMs(
                       attempts,
                       s.metricsReconcileBackoffSeconds,
                       s.metricsReconcileIntervalMinutes,
                     ),
                 )}
           WHERE workspace_id = ${workspaceId}`.execute(tx.db);
      })
      .catch(() => undefined);
    return { claimed: true, checked: 0, repaired: 0, passComplete: false };
  }
}

/** The worker handler: discovery is payload-free and bounded; each workspace takes one step. */
export function metricsReconcileHandler(d: MetricsJobDeps): JobHandler {
  const s = d.settings ?? DEFAULT_WORK_SETTINGS;
  return {
    kind: METRICS_JOB_KINDS.reconcile,
    queue: METRICS_QUEUE,
    maxAttempts: 3,
    timeoutMs: 240_000,
    async handle() {
      const workspaces = await d.discovery.discoverMetricsWork(
        new Date(),
        s.metricsReconcileDiscoveryMax,
      );
      for (const ws of workspaces) await reconcileWorkspace(d, ws);
    },
  };
}
