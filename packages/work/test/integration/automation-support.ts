import { LogErrorReporter } from '@pm/observability';
import {
  WorkerRuntime,
  type EffectBarriers,
  type JobHandler,
  type OutboxConsumer,
} from '@pm/platform';
import type { TestDatabase } from '@pm/test-support/vitest';
import {
  automationRunHandler,
  automationSweepHandler,
  AutomationOutcomeConsumer,
  AutomationTriggerConsumer,
  NotificationFanOut,
} from '@pm/work';
import type { WorkEnv } from './fixture.ts';

/**
 * An in-process worker on the worker pool (`app_worker`) with the 8A handlers and consumers and
 * the 4B fan-out, driven cycle by cycle (no timers), exactly as the worker process registers them.
 */
export async function automationWorker(
  env: WorkEnv,
  options: {
    effectBarriers?: EffectBarriers;
    maxAttempts?: number;
    handlers?: JobHandler[];
    consumers?: OutboxConsumer[];
  } = {},
) {
  const h = env.h;
  const svc = env.workerSvc();
  const deps = {
    discovery: h.discovery,
    service: svc,
    metrics: h.telemetry.metrics,
    logger: h.logger,
  };
  const j = h.config.jobs;
  const worker = new WorkerRuntime({
    db: h.worker,
    discovery: h.discovery,
    handlers: [
      automationRunHandler(deps),
      automationSweepHandler(deps),
      ...(options.handlers ?? []),
    ],
    consumers: [
      new AutomationTriggerConsumer(svc),
      new AutomationOutcomeConsumer(svc),
      ...(options.consumers ?? []),
      new NotificationFanOut(
        {
          notifyFanoutRecipientsMax: 500,
          notifyDedupeWindowMinutes: 60,
          notifyEmailPerHourMax: 20,
          notifyFactsMaxBytes: 2048,
          principalContextArrayMax: 10_000,
        },
        h.telemetry.metrics,
      ),
    ],
    params: {
      leaseDurationMs: j.leaseDurationMs,
      heartbeatIntervalMs: j.heartbeatIntervalMs,
      backoffBaseMs: 10,
      backoffCapMs: 20,
      maxAttempts: options.maxAttempts ?? 5,
      timeoutMs: 20_000,
      workspaceConcurrencyCap: 8,
      pollIntervalMs: 50,
      claimBatchSize: 10,
      shutdownGraceMs: 200,
      outboxReplayWindowMs: h.config.retention.outboxReplayWindowMs,
      maintenanceIntervalMs: 3_600_000,
      statsIntervalMs: 3_600_000,
    },
    buildId: 'test',
    logger: h.logger,
    metrics: h.telemetry.metrics,
    tracer: h.telemetry.tracer,
    errors: new LogErrorReporter(h.logger),
    random: () => 0,
    ...(options.effectBarriers ? { effectBarriers: options.effectBarriers } : {}),
  });
  await worker.start({ loop: false });
  return worker;
}

/** Runs cycles until nothing is claimed or dispatched (retry delays pulled forward). */
export async function settle(db: TestDatabase, worker: WorkerRuntime, max = 30) {
  for (let i = 0; i < max; i++) {
    const r = await worker.runCycle({ wait: true });
    await db.admin(`UPDATE exec.job SET run_at = now() WHERE state = 'retry_scheduled'`);
    if (!r.claimed && !r.dispatched) {
      const more = await db.admin(
        `SELECT count(*)::int AS n FROM exec.job WHERE state IN ('queued','retry_scheduled') AND run_at <= now()`,
      );
      const pending = await db.admin(
        `SELECT count(*)::int AS n FROM exec.outbox_event WHERE dispatched_at IS NULL`,
      );
      if (!more.rows[0].n && !pending.rows[0].n) return i;
    }
  }
  return max;
}

/** Moves every automation delay (and its continuation job) to now. */
export async function wakeDelays(db: TestDatabase) {
  await db.admin(
    `UPDATE automation.automation_run SET wake_at = now() - interval '1 second' WHERE wake_at IS NOT NULL`,
  );
  await db.admin(
    `UPDATE exec.job SET run_at = now() WHERE kind = 'automation.run' AND state = 'queued'`,
  );
}

/** Runs of an automation with their steps, as stored (internal view for assertions). */
export async function runsOf(db: TestDatabase, automationPublicId: string) {
  const r = await db.admin(
    `SELECT r.*, o.public_id AS op_public_id, o.execution_state, o.terminal_reason, o.waiting_reason
       FROM automation.automation_run r
       JOIN core.record c ON c.id = r.automation_id
       JOIN exec.operation o ON o.id = r.current_operation_id
      WHERE c.public_id = $1 ORDER BY r.created_at, r.id`,
    [automationPublicId],
  );
  return r.rows as Array<
    Record<string, unknown> & {
      status: string;
      reason: string | null;
      op_public_id: string;
      execution_state: string;
    }
  >;
}

export async function stepsOf(db: TestDatabase, runId: string) {
  const r = await db.admin(
    `SELECT node_id, attempt, kind, action_key, state, failure_class, code, decision, output
       FROM automation.automation_step_run WHERE run_id = $1 ORDER BY started_at, id`,
    [runId],
  );
  return r.rows as Array<Record<string, unknown>>;
}
