import type { PrincipalRef } from '@pm/contracts';
import {
  DeferredAuditSink,
  startOperation,
  WorkerRuntime,
  type JobHandler,
  type OutboxConsumer,
  type WorkerParams,
} from '@pm/platform';
import { executionContext, type Harness } from '@pm/test-support';
import { LogErrorReporter } from '@pm/observability';

export function workerParams(h: Harness, overrides: Partial<WorkerParams> = {}): WorkerParams {
  const j = h.config.jobs;
  return {
    leaseDurationMs: j.leaseDurationMs,
    heartbeatIntervalMs: j.heartbeatIntervalMs,
    backoffBaseMs: j.backoffBaseMs,
    backoffCapMs: j.backoffCapMs,
    maxAttempts: j.maxAttempts,
    timeoutMs: j.timeoutMs,
    workspaceConcurrencyCap: j.workspaceConcurrencyCap,
    pollIntervalMs: j.pollIntervalMs,
    claimBatchSize: j.claimBatchSize,
    shutdownGraceMs: 200,
    outboxReplayWindowMs: h.config.retention.outboxReplayWindowMs,
    maintenanceIntervalMs: 3_600_000,
    statsIntervalMs: 3_600_000,
    ...overrides,
  };
}

export async function makeWorker(
  h: Harness,
  handlers: JobHandler[],
  consumers: OutboxConsumer[] = [],
  overrides: Partial<WorkerParams> = {},
): Promise<WorkerRuntime> {
  const w = new WorkerRuntime({
    db: h.worker,
    discovery: h.discovery,
    handlers,
    consumers,
    params: workerParams(h, overrides),
    buildId: 'test',
    logger: h.logger,
    metrics: h.telemetry.metrics,
    tracer: h.telemetry.tracer,
    errors: new LogErrorReporter(h.logger),
    random: () => 0.5,
  });
  await w.start({ loop: false });
  return w;
}

export async function start(
  h: Harness,
  workspaceId: string,
  principal: PrincipalRef,
  jobKind: string,
  opts: {
    maxAttempts?: number;
    queue?: string;
    timeoutSeconds?: number;
    payloadRef?: string;
    traceparent?: string;
  } = {},
): Promise<{ id: string; publicId: string; jobId: string; correlationId: string }> {
  const ctx = executionContext(
    workspaceId,
    principal,
    opts.traceparent ? { traceparent: opts.traceparent } : {},
  );
  const op = await h.app.withWorkspace(workspaceId, { module: 'test' }, (tx) =>
    startOperation(
      tx,
      {
        kind: 'report_run',
        context: ctx,
        initiatedBy: { type: 'human', id: principal.id },
        queue: opts.queue ?? 'default',
        jobKind,
        maxAttempts: opts.maxAttempts ?? 3,
        timeoutSeconds: opts.timeoutSeconds ?? 30,
        auditActionKey: 'report.run',
        ...(opts.payloadRef ? { payloadRef: opts.payloadRef } : {}),
      },
      new DeferredAuditSink(),
    ),
  );
  return { ...op, correlationId: ctx.correlationId };
}

export async function opState(h: Harness, workspaceId: string, operationId: string) {
  return h.worker.withWorkspace(workspaceId, { module: 'test', readOnly: true }, async (tx) => {
    const op = await tx.db
      .selectFrom('exec.operation')
      .selectAll()
      .where('id', '=', operationId)
      .executeTakeFirstOrThrow();
    const attempts = await tx.db
      .selectFrom('exec.attempt')
      .selectAll()
      .where('operation_id', '=', operationId)
      .orderBy('attempt_number')
      .execute();
    const job = await tx.db
      .selectFrom('exec.job')
      .selectAll()
      .where('operation_id', '=', operationId)
      .executeTakeFirstOrThrow();
    return { op, attempts, job };
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A gate the test opens to let a blocked handler continue. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}
