import type { InstrumentedPool } from './pool.ts';

/**
 * Platform-only, payload-free scheduling discovery (0C §12.3-12.4). Runs as the `dispatcher`
 * identity, which can execute only the `exec_dispatch` definer functions. Every method returns
 * identifiers, queue names, timestamps, or counts - never payloads, context, or customer rows.
 */
export class PlatformDiscovery {
  readonly #pool: InstrumentedPool;

  constructor(pool: InstrumentedPool) {
    if (pool.identity !== 'dispatcher')
      throw new Error('PlatformDiscovery requires the dispatcher identity');
    this.#pool = pool;
  }

  async claimJobs(args: {
    queue: string;
    workerId: string;
    limit: number;
    workspaceCap: number;
    leaseMs: number;
  }): Promise<Array<{ jobId: string; workspaceId: string | null; leaseToken: string }>> {
    const { rows } = await this.#pool.query<{
      job_id: string;
      workspace_id: string | null;
      lease_token: string;
    }>(
      'SELECT job_id, workspace_id, lease_token FROM exec_dispatch.claim_jobs($1, $2, $3, $4, $5)',
      [args.queue, args.workerId, args.limit, args.workspaceCap, args.leaseMs],
    );
    return rows.map((r) => ({
      jobId: r.job_id,
      workspaceId: r.workspace_id,
      leaseToken: r.lease_token,
    }));
  }

  async discoverExpiredLeases(
    limit: number,
  ): Promise<Array<{ jobId: string; workspaceId: string | null }>> {
    const { rows } = await this.#pool.query<{ job_id: string; workspace_id: string | null }>(
      'SELECT job_id, workspace_id FROM exec_dispatch.discover_expired_leases($1)',
      [limit],
    );
    return rows.map((r) => ({ jobId: r.job_id, workspaceId: r.workspace_id }));
  }

  async jobQueueStats(): Promise<
    Array<{ queue: string; state: string; jobs: number; oldestDueAgeMs: number }>
  > {
    const { rows } = await this.#pool.query<{
      queue: string;
      state: string;
      jobs: number;
      oldest_due_age_ms: number;
    }>('SELECT queue, state, jobs, oldest_due_age_ms FROM exec_dispatch.job_queue_stats()');
    return rows.map((r) => ({
      queue: r.queue,
      state: r.state,
      jobs: r.jobs,
      oldestDueAgeMs: r.oldest_due_age_ms,
    }));
  }

  async claimOutboxEvents(
    limit: number,
    leaseMs: number,
  ): Promise<Array<{ eventId: string; workspaceId: string }>> {
    const { rows } = await this.#pool.query<{ event_id: string; workspace_id: string }>(
      'SELECT event_id, workspace_id FROM exec_dispatch.claim_outbox_events($1, $2)',
      [limit, leaseMs],
    );
    return rows.map((r) => ({ eventId: r.event_id, workspaceId: r.workspace_id }));
  }

  async outboxBacklog(): Promise<{ pending: number; oldestAgeMs: number }> {
    const { rows } = await this.#pool.query<{ pending: number; oldest_age_ms: number }>(
      'SELECT pending, oldest_age_ms FROM exec_dispatch.outbox_backlog()',
    );
    return { pending: rows[0]?.pending ?? 0, oldestAgeMs: rows[0]?.oldest_age_ms ?? 0 };
  }

  async discoverMaintenanceWorkspaces(cutoff: Date, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_maintenance_workspaces($1, $2)',
      [cutoff, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /**
   * Trashed deletion batches whose recovery period (R-LIVE) has passed (1F). `platformPeriodMs`
   * is the platform default; NULL there and no workspace value means nothing is ever due.
   */
  async discoverPurgeDue(
    platformPeriodMs: number | null,
    limit: number,
  ): Promise<Array<{ workspaceId: string; batchId: string }>> {
    const { rows } = await this.#pool.query<{ workspace_id: string; batch_id: string }>(
      `SELECT workspace_id, batch_id FROM exec_dispatch.discover_purge_due(
         CASE WHEN $1::bigint IS NULL THEN NULL ELSE make_interval(secs => $1::bigint / 1000.0) END, $2)`,
      [platformPeriodMs, limit],
    );
    return rows.map((r) => ({ workspaceId: r.workspace_id, batchId: r.batch_id }));
  }

  async purgeBacklog(): Promise<Array<{ state: string; batches: number }>> {
    const { rows } = await this.#pool.query<{ state: string; batches: string }>(
      'SELECT state, batches FROM exec_dispatch.purge_backlog()',
    );
    return rows.map((r) => ({ state: r.state, batches: Number(r.batches) }));
  }

  /** Workspaces with audit history after `after` (keyset), for chain verification fan-out. */
  async discoverAuditWorkspaces(after: string | null, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_audit_workspaces($1, $2)',
      [after, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /**
   * Workspaces with expired view state, or with personal navigation rows of memberships removed
   * before `departedBefore` (1E). NULL `departedBefore` (undecided R-PERSONAL period) selects only
   * expired view state.
   */
  async discoverViewsCleanup(departedBefore: Date | null, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_views_cleanup($1, $2)',
      [departedBefore, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /** Workspaces with active recurrence series whose next occurrence is due (2A, ids only). */
  async discoverRecurrenceDue(now: Date, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_recurrence_due($1, $2)',
      [now, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /** Workspaces with scheduled task reminders that are due (2D, ids only). */
  async discoverRemindersDue(now: Date, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_reminders_due($1, $2)',
      [now, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /** Workspaces with a running timer whose total has reached `maxSeconds` (3D, ids only). */
  async discoverRunawayTimers(now: Date, maxSeconds: number, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_runaway_timers($1, $2, $3)',
      [now, maxSeconds, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /** Workspaces with open Today commitments on days before `before` and no record yet (3C). */
  async discoverDaysToClose(before: string, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_days_to_close($1, $2)',
      [before, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /** Workspaces with active block series generated short of `through` (3C, ids only). */
  async discoverBlockSeriesDue(through: string, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_block_series_due($1, $2)',
      [through, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /**
   * Workspaces with notification work: deliveries due (or leases expired), digests waiting,
   * notifications past retention, or open tasks near their due date (4B, ids only).
   */
  async discoverNotificationWork(
    now: Date,
    retentionBefore: Date,
    limit: number,
  ): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_notification_work($1, $2, $3)',
      [now, retentionBefore, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /** Workspaces with expired upload sessions or object deletions to perform (4E). */
  async discoverFileWork(now: Date, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_file_work($1, $2)',
      [now, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /**
   * Workspaces with search keys due to be indexed, or recent searches past retention
   * (5A, ids only).
   */
  async discoverSearchWork(now: Date, retentionBefore: Date, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_search_work($1, $2, $3)',
      [now, retentionBefore, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /** Workspaces with goals whose derived state is due for recalculation (5B). */
  async discoverGoalWork(now: Date, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_goal_work($1, $2)',
      [now, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /** Workspaces whose metrics ledger reconciliation pass is due and not leased (5C, ids only). */
  async discoverMetricsWork(now: Date, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_metrics_work($1, $2)',
      [now, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /** Workspaces with a sync delivery due or sync history past retention (6A, ids only). */
  async discoverIntegrationWork(
    now: Date,
    retentionBefore: Date,
    limit: number,
  ): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_integration_work($1, $2, $3)',
      [now, retentionBefore, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /** Workspaces with a report schedule due or runs past retention (5D, ids only). */
  async discoverWebhookWork(now: Date, retentionBefore: Date, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_webhook_work($1, $2, $3)',
      [now, retentionBefore, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /** Workspaces holding AI content older than the technical retention cut-off (7A). */
  async discoverAiRetentionWork(before: Date, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_ai_retention_work($1, $2)',
      [before, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  async discoverReportWork(now: Date, retentionBefore: Date, limit: number): Promise<string[]> {
    const { rows } = await this.#pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM exec_dispatch.discover_report_work($1, $2, $3)',
      [now, retentionBefore, limit],
    );
    return rows.map((r) => r.workspace_id);
  }

  /** Worker liveness (platform table, no tenant data). */
  async heartbeat(workerId: string, buildId: string, stopping = false): Promise<void> {
    await this.#pool.query(
      `INSERT INTO ops.worker_heartbeat (worker_id, role, build_id, stopping)
       VALUES ($1, 'worker', $2, $3)
       ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now(), stopping = EXCLUDED.stopping`,
      [workerId, buildId, stopping],
    );
  }

  async removeWorker(workerId: string): Promise<void> {
    await this.#pool.query('DELETE FROM ops.worker_heartbeat WHERE worker_id = $1', [workerId]);
  }
}
