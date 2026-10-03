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
  }): Promise<Array<{ jobId: string; workspaceId: string; leaseToken: string }>> {
    const { rows } = await this.#pool.query<{
      job_id: string;
      workspace_id: string;
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
  ): Promise<Array<{ jobId: string; workspaceId: string }>> {
    const { rows } = await this.#pool.query<{ job_id: string; workspace_id: string }>(
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
