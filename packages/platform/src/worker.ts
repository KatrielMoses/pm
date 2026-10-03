import { randomBytes } from 'node:crypto';
import {
  newPublicId,
  newUuidV7,
  uuidToTraceId,
  type ActorRef,
  type EffectDestinationClass,
  type ExecState,
  type JobErrorClass,
  type TerminalReason,
} from '@pm/contracts';
import {
  sql,
  type InstrumentedPool,
  type JobTable,
  type PlatformDiscovery,
  type Selectable,
  type TenantDatabase,
  type WorkspaceTransaction,
} from '@pm/db';
import {
  contextFromTraceparent,
  errorFields,
  SpanKind,
  withSpan,
  type ErrorReporter,
  type Logger,
  type Metrics,
  type Tracer,
} from '@pm/observability';
import {
  cancelOpenEffects,
  decideEffect,
  EffectOutcomeUnknownError,
  markEffectAttempt,
  markEffectOutcome,
  recordEffect,
} from './effects.ts';
import { contextFromRow } from './execution-context.ts';
import {
  classifyError,
  JobContractError,
  JobError,
  retryDelayMs,
  RETRYABLE_CLASSES,
  type JobHandler,
  type JobHandlerContext,
  type JobResult,
} from './jobs.ts';
import { isTerminalState, transitionOperation } from './operations.ts';
import { toInternalEvent, type OutboxConsumer } from './outbox.ts';

/** Abort reasons. Each maps to one finalization path. */
export class LeaseLostError extends Error {
  constructor() {
    super('job lease lost');
    this.name = 'LeaseLostError';
  }
}
export class CancelRequestedError extends Error {
  constructor() {
    super('cancellation requested');
    this.name = 'CancelRequestedError';
  }
}
export class WorkerShutdownError extends Error {
  constructor() {
    super('worker shutting down');
    this.name = 'WorkerShutdownError';
  }
}
export class AwaitReconciliationError extends Error {
  constructor() {
    super('external effect awaits reconciliation');
    this.name = 'AwaitReconciliationError';
  }
}
class WorkerKilledError extends Error {
  constructor() {
    super('worker killed');
    this.name = 'WorkerKilledError';
  }
}

export interface WorkerParams {
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  maxAttempts: number;
  timeoutMs: number;
  workspaceConcurrencyCap: number;
  pollIntervalMs: number;
  claimBatchSize: number;
  shutdownGraceMs: number;
  outboxReplayWindowMs: number;
  maintenanceIntervalMs?: number;
  statsIntervalMs?: number;
}

export interface WorkerRuntimeOptions {
  db: TenantDatabase;
  discovery: PlatformDiscovery;
  handlers: readonly JobHandler[];
  consumers: readonly OutboxConsumer[];
  params: WorkerParams;
  buildId: string;
  logger: Logger;
  metrics: Metrics;
  tracer: Tracer;
  errors: ErrorReporter;
  pools?: readonly InstrumentedPool[];
  /** Injected randomness for deterministic backoff tests. */
  random?: () => number;
}

const SYSTEM_ACTOR: ActorRef = { type: 'system' };

type JobRow = Selectable<JobTable>;

interface Started {
  job: JobRow;
  attemptId: string | undefined;
  attemptNumber: number;
}

export interface CycleResult {
  claimed: number;
  reaped: number;
  dispatched: number;
}

/**
 * Durable job and outbox worker (0D §7-§8, 0C §12.4). Discovery runs through payload-free definer
 * functions; every job and event is then processed in its own fail-closed workspace transaction.
 * Delivery is at least once; correctness comes from lease fencing, step checkpoints, inbox
 * receipts, and the effect ledger - never from assuming single execution.
 */
export class WorkerRuntime {
  readonly workerId = `wrk_${randomBytes(8).toString('hex')}`;
  readonly #o: WorkerRuntimeOptions;
  readonly #handlers: ReadonlyMap<string, JobHandler>;
  readonly #queues: readonly string[];
  readonly #inflight = new Map<string, { abort: AbortController; done: Promise<void> }>();
  #state: 'idle' | 'running' | 'stopping' | 'stopped' | 'killed' = 'idle';
  #timer: NodeJS.Timeout | undefined;
  #lastMaintenance = 0;
  #lastStats = 0;

  constructor(options: WorkerRuntimeOptions) {
    this.#o = options;
    const map = new Map<string, JobHandler>();
    for (const h of options.handlers) {
      if (map.has(h.kind)) throw new JobContractError(`duplicate handler ${h.kind}`);
      map.set(h.kind, h);
    }
    this.#handlers = map;
    this.#queues = [...new Set(options.handlers.map((h) => h.queue))].sort();
  }

  get state(): string {
    return this.#state;
  }

  get activeJobs(): number {
    return this.#inflight.size;
  }

  /** Registers liveness and, unless `loop` is false (deterministic tests), starts polling. */
  async start(options: { loop?: boolean } = {}): Promise<void> {
    if (this.#state !== 'idle') throw new Error('worker already started');
    this.#state = 'running';
    await this.#o.discovery.heartbeat(this.workerId, this.#o.buildId);
    this.#o.metrics.gauge('worker.up', 1, { role: 'worker' });
    this.#o.logger.info('worker.started', { worker_id: this.workerId, count: this.#queues.length });
    if (options.loop !== false) this.#schedule(0);
  }

  #schedule(delay: number): void {
    if (this.#state !== 'running') return;
    this.#timer = setTimeout(() => {
      void this.runCycle()
        .catch((err: unknown) => {
          this.#o.errors.capture(err, { component: 'worker.cycle' });
        })
        .finally(() => this.#schedule(this.#o.params.pollIntervalMs));
    }, delay);
  }

  /**
   * One scheduling cycle: liveness, lease recovery, claims, outbox dispatch, and periodic
   * maintenance/metrics. With `wait`, resolves after claimed jobs finish (tests).
   */
  async runCycle(options: { wait?: boolean } = {}): Promise<CycleResult> {
    if (this.#state !== 'running') return { claimed: 0, reaped: 0, dispatched: 0 };
    const p = this.#o.params;
    await this.#o.discovery.heartbeat(this.workerId, this.#o.buildId);
    const reaped = await this.reapExpiredLeases();
    let claimed = 0;
    const started: Promise<void>[] = [];
    for (const queue of this.#queues) {
      const capacity = p.claimBatchSize - this.#inflight.size;
      if (capacity <= 0 || this.#state !== 'running') break;
      const claims = await this.#o.discovery.claimJobs({
        queue,
        workerId: this.workerId,
        limit: capacity,
        workspaceCap: p.workspaceConcurrencyCap,
        leaseMs: p.leaseDurationMs,
      });
      claimed += claims.length;
      for (const claim of claims) started.push(this.#track(claim));
    }
    const dispatched = await this.dispatchOutbox();
    const now = Date.now();
    if (now - this.#lastMaintenance >= (p.maintenanceIntervalMs ?? 60_000)) {
      this.#lastMaintenance = now;
      await this.runMaintenance();
    }
    if (now - this.#lastStats >= (p.statsIntervalMs ?? 15_000)) {
      this.#lastStats = now;
      await this.recordStats();
    }
    if (options.wait) await Promise.allSettled(started);
    return { claimed, reaped, dispatched };
  }

  #track(claim: { jobId: string; workspaceId: string; leaseToken: string }): Promise<void> {
    const abort = new AbortController();
    const done = this.#processJob(claim, abort)
      .catch((err: unknown) => {
        if (!(err instanceof WorkerKilledError))
          this.#o.errors.capture(err, { component: 'worker.job', job_id: claim.jobId });
      })
      .finally(() => {
        this.#inflight.delete(claim.jobId);
      });
    this.#inflight.set(claim.jobId, { abort, done });
    return done;
  }

  #tx<T>(
    workspaceId: string,
    fn: (tx: WorkspaceTransaction) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    if (this.#state === 'killed') return Promise.reject(new WorkerKilledError());
    return this.#o.db.withWorkspace(workspaceId, { module: 'exec', readOnly }, fn);
  }

  /** Lease fence: the row is ours only while state = leased and the token matches. */
  async #fence(
    tx: WorkspaceTransaction,
    jobId: string,
    leaseToken: string,
  ): Promise<JobRow | undefined> {
    return tx.db
      .selectFrom('exec.job')
      .selectAll()
      .where('id', '=', jobId)
      .where('lease_token', '=', leaseToken)
      .where('state', '=', 'leased')
      .forNoKeyUpdate()
      .executeTakeFirst();
  }

  async #cancelRequested(tx: WorkspaceTransaction, job: JobRow): Promise<boolean> {
    if (job.cancel_requested_at) return true;
    if (!job.operation_id) return false;
    const op = await tx.db
      .selectFrom('exec.operation')
      .select('cancel_requested_at')
      .where('id', '=', job.operation_id)
      .executeTakeFirst();
    return Boolean(op?.cancel_requested_at);
  }

  async #processJob(
    claim: { jobId: string; workspaceId: string; leaseToken: string },
    abort: AbortController,
  ): Promise<void> {
    const { jobId, workspaceId: ws, leaseToken } = claim;
    const startedAt = performance.now();

    const started = await this.#tx(ws, async (tx): Promise<Started | 'cancelled' | undefined> => {
      const job = await this.#fence(tx, jobId, leaseToken);
      if (!job) return undefined;
      const context = contextFromRow(job);
      if (job.operation_id) {
        const op = await tx.db
          .selectFrom('exec.operation')
          .select(['execution_state', 'cancel_requested_at'])
          .where('id', '=', job.operation_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (
          isTerminalState(op.execution_state) ||
          op.cancel_requested_at ||
          job.cancel_requested_at
        ) {
          await this.#finishJob(tx, job, 'cancelled', {
            class: 'policy',
            code: 'cancelled_before_start',
          });
          if (!isTerminalState(op.execution_state)) {
            await transitionOperation(tx, {
              operationId: job.operation_id,
              to: 'cancelled',
              terminalReason: 'user_cancelled',
              actor: SYSTEM_ACTOR,
              context,
            });
          }
          return 'cancelled';
        }
        const last = await tx.db
          .selectFrom('exec.attempt')
          .select((eb) => eb.fn.max('attempt_number').as('n'))
          .where('operation_id', '=', job.operation_id)
          .executeTakeFirst();
        const attemptNumber = Number(last?.n ?? 0) + 1;
        const attemptId = newUuidV7();
        await tx.db
          .insertInto('exec.attempt')
          .values({
            id: attemptId,
            workspace_id: ws,
            public_id: newPublicId('att'),
            operation_id: job.operation_id,
            job_id: job.id,
            attempt_number: attemptNumber,
          })
          .execute();
        if (op.execution_state !== 'running') {
          await transitionOperation(tx, {
            operationId: job.operation_id,
            to: 'running',
            actor: SYSTEM_ACTOR,
            context,
            attemptId,
          });
        }
        return { job, attemptId, attemptNumber };
      }
      if (job.cancel_requested_at) {
        await this.#finishJob(tx, job, 'cancelled', {
          class: 'policy',
          code: 'cancelled_before_start',
        });
        return 'cancelled';
      }
      return { job, attemptId: undefined, attemptNumber: job.attempts };
    });
    if (started === undefined) {
      this.#o.logger.warn('job.lease_lost_before_start', { job_id: jobId });
      return;
    }
    if (started === 'cancelled') {
      this.#o.metrics.count('job.attempts', 1, { queue: 'any', outcome: 'cancelled' });
      return;
    }

    const { job, attemptId, attemptNumber } = started;
    const handler = this.#handlers.get(job.kind);
    const context = {
      ...contextFromRow(job),
      ...(job.operation_id ? { operationId: job.operation_id } : {}),
      ...(attemptId ? { attemptId } : {}),
    };
    const log = this.#o.logger.child({
      job_id: job.id,
      job_kind: job.kind,
      queue: job.queue,
      workspace_id: ws,
      correlation_id: context.correlationId,
      attempt_number: attemptNumber,
      ...(job.operation_id ? { operation_id: job.operation_id } : {}),
      ...(attemptId ? { attempt_id: attemptId } : {}),
      ...(context.requestId ? { request_id: context.requestId } : {}),
    });

    await withSpan(
      this.#o.tracer,
      'job.run',
      { 'pm.job.kind': job.kind, 'pm.job.queue': job.queue, 'pm.job.attempt': attemptNumber },
      async () => {
        log.info('job.attempt_started');
        const timeoutMs =
          handler?.timeoutMs ?? Math.min(this.#o.params.timeoutMs, job.timeout_seconds * 1000);
        const timeout = setTimeout(
          () => abort.abort(new JobError('timeout', 'job_timeout')),
          timeoutMs,
        );
        const heartbeat = setInterval(() => {
          void this.#heartbeat(ws, job.id, leaseToken).then(
            (held) => {
              if (!held) abort.abort(new LeaseLostError());
            },
            () => undefined,
          );
        }, this.#o.params.heartbeatIntervalMs);
        let outcome: JobResult | Error;
        try {
          if (!handler) throw new JobError('deterministic', 'no_handler');
          const ctx = this.#handlerContext(
            job,
            leaseToken,
            attemptId,
            attemptNumber,
            context,
            log,
            abort.signal,
          );
          const aborted = new Promise<never>((_, reject) => {
            if (abort.signal.aborted) reject(abort.signal.reason as Error);
            abort.signal.addEventListener('abort', () => reject(abort.signal.reason as Error), {
              once: true,
            });
          });
          outcome = (await Promise.race([handler.handle(ctx), aborted])) ?? { state: 'succeeded' };
        } catch (err) {
          outcome = err instanceof Error ? err : new Error('non-error thrown');
        } finally {
          clearTimeout(timeout);
          clearInterval(heartbeat);
        }
        const finalOutcome = await this.#finalize(
          job,
          leaseToken,
          attemptId,
          context,
          outcome,
          log,
        );
        const durationMs = performance.now() - startedAt;
        this.#o.metrics.count('job.attempts', 1, { queue: job.queue, outcome: finalOutcome });
        this.#o.metrics.record('job.attempt.duration', durationMs, {
          queue: job.queue,
          outcome: finalOutcome,
        });
        log.info('job.attempt_finished', {
          outcome: finalOutcome,
          duration_ms: Math.round(durationMs),
        });
      },
      { parent: contextFromTraceparent(job.traceparent), kind: SpanKind.CONSUMER },
    );
  }

  async #heartbeat(ws: string, jobId: string, leaseToken: string): Promise<boolean> {
    return this.#tx(ws, async (tx) => {
      const res = await tx.db
        .updateTable('exec.job')
        .set({
          lease_until: sql`now() + make_interval(secs => ${this.#o.params.leaseDurationMs / 1000})`,
          heartbeat_at: sql`now()`,
          updated_at: new Date(),
        })
        .where('id', '=', jobId)
        .where('lease_token', '=', leaseToken)
        .where('state', '=', 'leased')
        .executeTakeFirst();
      return Number(res.numUpdatedRows) === 1;
    });
  }

  #handlerContext(
    job: JobRow,
    leaseToken: string,
    attemptId: string | undefined,
    attemptNumber: number,
    context: JobHandlerContext['context'],
    log: Logger,
    signal: AbortSignal,
  ): JobHandlerContext {
    const ws = job.workspace_id;
    const guard = async (tx: WorkspaceTransaction): Promise<JobRow> => {
      if (signal.aborted) throw signal.reason as Error;
      const fenced = await this.#fence(tx, job.id, leaseToken);
      if (!fenced) throw new LeaseLostError();
      if (await this.#cancelRequested(tx, fenced)) throw new CancelRequestedError();
      return fenced;
    };
    return {
      job: {
        id: job.id,
        kind: job.kind,
        queue: job.queue,
        workspaceId: ws,
        operationId: job.operation_id ?? undefined,
        attemptId,
        attemptNumber,
        payloadRef: job.payload_ref ?? undefined,
      },
      context,
      logger: log,
      signal,
      step: async <T extends Record<string, unknown> | void>(
        name: string,
        fn: (tx: WorkspaceTransaction) => Promise<T>,
      ): Promise<T> => {
        if (!/^[a-z0-9_.]{1,64}$/.test(name)) throw new JobContractError('step name');
        return this.#tx(ws, async (tx) => {
          const fenced = await guard(tx);
          if (fenced.completed_steps.includes(name)) {
            log.info('job.step_skipped', { state: name });
            return (fenced.checkpoint?.[name] ?? undefined) as T;
          }
          const value = await fn(tx);
          await tx.db
            .updateTable('exec.job')
            .set({
              completed_steps: sql`array_append(completed_steps, ${name}::text)`,
              checkpoint: sql`coalesce(checkpoint, '{}'::jsonb) || jsonb_build_object(${name}::text, ${JSON.stringify(value ?? null)}::jsonb)`,
              heartbeat_at: sql`now()`,
              lease_until: sql`now() + make_interval(secs => ${this.#o.params.leaseDurationMs / 1000})`,
              updated_at: new Date(),
            })
            .where('id', '=', job.id)
            .execute();
          return value;
        });
      },
      effect: async (effectKey: string, destinationClass: EffectDestinationClass, perform) => {
        const operationId = job.operation_id;
        if (!operationId) throw new JobContractError('external effects require an operation');
        const prepared = await this.#tx(ws, async (tx) => {
          await guard(tx);
          const row = await recordEffect(tx, { operationId, effectKey, destinationClass });
          const decision = decideEffect(row);
          if (decision === 'attempt') await markEffectAttempt(tx, row.id, attemptId);
          return { row, decision };
        });
        const { row, decision } = prepared;
        if (decision === 'already_sent') {
          log.info('effect.skipped_already_sent', {
            effect_state: row.state,
            destination_class: row.destination_class,
          });
          return {
            state: row.state as 'sent' | 'confirmed',
            externalRef: row.external_ref ?? undefined,
          };
        }
        if (decision === 'cancelled') throw new CancelRequestedError();
        if (decision === 'await_reconciliation') throw new AwaitReconciliationError();
        try {
          const result = await perform(
            row.provider_idempotency_key ?? `${operationId}:${effectKey}`,
          );
          await this.#tx(ws, (tx) => markEffectOutcome(tx, row.id, 'sent', result.externalRef));
          return { state: 'sent', externalRef: result.externalRef };
        } catch (err) {
          if (err instanceof EffectOutcomeUnknownError) {
            await this.#tx(ws, (tx) => markEffectOutcome(tx, row.id, 'unknown'));
            log.warn('effect.outcome_unknown', { destination_class: destinationClass });
            if (destinationClass === 'unsafe') throw new AwaitReconciliationError();
            throw new JobError('transient', 'effect_outcome_unknown');
          }
          await this.#tx(ws, (tx) => markEffectOutcome(tx, row.id, 'failed'));
          throw err;
        }
      },
    };
  }

  async #finishJob(
    tx: WorkspaceTransaction,
    job: JobRow,
    state: 'succeeded' | 'dead' | 'cancelled',
    lastError?: { class: JobErrorClass; code: string },
  ): Promise<void> {
    await tx.db
      .updateTable('exec.job')
      .set({
        state,
        finished_at: new Date(),
        lease_token: null,
        lease_owner: null,
        lease_until: null,
        last_error: lastError ? JSON.stringify(lastError) : null,
        last_error_class: lastError?.class ?? null,
        updated_at: new Date(),
      })
      .where('id', '=', job.id)
      .execute();
  }

  async #endAttempt(
    tx: WorkspaceTransaction,
    attemptId: string | undefined,
    state: ExecState,
    extra: {
      terminalReason?: TerminalReason;
      errorClass?: JobErrorClass;
      code?: string;
      workerLost?: boolean;
    } = {},
  ): Promise<void> {
    if (!attemptId) return;
    await tx.db
      .updateTable('exec.attempt')
      .set({
        execution_state: state,
        terminal_reason: extra.terminalReason ?? null,
        error_class: extra.errorClass ?? null,
        error_detail: extra.code ? JSON.stringify({ code: extra.code }) : null,
        worker_lost: extra.workerLost ?? false,
        ended_at: new Date(),
      })
      .where('id', '=', attemptId)
      .execute();
  }

  /** Writes the attempt outcome under the lease fence. Returns a bounded outcome label. */
  async #finalize(
    job: JobRow,
    leaseToken: string,
    attemptId: string | undefined,
    context: JobHandlerContext['context'],
    outcome: JobResult | Error,
    log: Logger,
  ): Promise<string> {
    if (outcome instanceof WorkerKilledError) throw outcome;
    if (outcome instanceof LeaseLostError) {
      log.warn('job.lease_lost');
      return 'lease_lost';
    }
    const ws = job.workspace_id;
    const op = job.operation_id;
    const transition = (
      tx: WorkspaceTransaction,
      to: ExecState,
      extra: {
        terminalReason?: TerminalReason;
        waitingReason?: import('@pm/contracts').WaitingReason;
        outcomeDetail?: Record<string, unknown>;
      } = {},
    ) =>
      op
        ? transitionOperation(tx, {
            operationId: op,
            to,
            actor: SYSTEM_ACTOR,
            context,
            ...(attemptId ? { attemptId } : {}),
            ...extra,
          })
        : Promise.resolve();

    return this.#tx(ws, async (tx) => {
      const fenced = await this.#fence(tx, job.id, leaseToken);
      if (!fenced) {
        log.warn('job.lease_lost');
        return 'lease_lost';
      }
      if (!(outcome instanceof Error)) {
        await this.#finishJob(tx, fenced, 'succeeded');
        await this.#endAttempt(tx, attemptId, outcome.state);
        await transition(
          tx,
          outcome.state,
          outcome.state === 'partial' ? { outcomeDetail: outcome.result } : {},
        );
        return outcome.state;
      }
      if (outcome instanceof CancelRequestedError) {
        await this.#finishJob(tx, fenced, 'cancelled', { class: 'policy', code: 'cancelled' });
        await this.#endAttempt(tx, attemptId, 'cancelled', { terminalReason: 'user_cancelled' });
        if (op) {
          const effects = await cancelOpenEffects(tx, op);
          if (effects.reported.length)
            log.warn('job.cancelled_with_sent_effects', { count: effects.reported.length });
        }
        await transition(tx, 'cancelled', { terminalReason: 'user_cancelled' });
        return 'cancelled';
      }
      if (outcome instanceof AwaitReconciliationError) {
        await this.#finishJob(tx, fenced, 'dead', {
          class: 'deterministic',
          code: 'reconciliation_required',
        });
        await this.#endAttempt(tx, attemptId, 'waiting');
        await transition(tx, 'waiting', { waitingReason: 'reconciliation_required' });
        return 'waiting';
      }
      if (outcome instanceof WorkerShutdownError) {
        // Release: the job returns to the queue immediately; the attempt is closed as worker_lost.
        await tx.db
          .updateTable('exec.job')
          .set({
            state: 'retry_scheduled',
            run_at: new Date(),
            lease_token: null,
            lease_owner: null,
            lease_until: null,
            last_error: JSON.stringify({ class: 'worker_lost', code: 'worker_shutdown' }),
            last_error_class: 'worker_lost',
            updated_at: new Date(),
          })
          .where('id', '=', job.id)
          .execute();
        await this.#endAttempt(tx, attemptId, 'failed', {
          terminalReason: 'error',
          errorClass: 'worker_lost',
          code: 'worker_shutdown',
          workerLost: true,
        });
        return 'released';
      }

      const { errorClass, code, retryAfterMs } = classifyError(outcome);
      const waitingReason =
        outcome instanceof JobError ? outcome.operationWaitingReason : undefined;
      const terminalReason: TerminalReason =
        errorClass === 'timeout'
          ? 'timed_out'
          : errorClass === 'policy' || errorClass === 'authorization'
            ? code === 'limit_exceeded'
              ? 'limit_exceeded'
              : 'policy_rejected'
            : 'error';
      log.warn('job.attempt_failed', {
        error_class: errorClass,
        error_code: code,
        ...errorFields(outcome),
      });
      await this.#endAttempt(tx, attemptId, 'failed', { terminalReason, errorClass, code });

      if (RETRYABLE_CLASSES.has(errorClass) && fenced.attempts < fenced.max_attempts) {
        const delay = retryDelayMs(
          fenced.attempts,
          { baseMs: this.#o.params.backoffBaseMs, capMs: this.#o.params.backoffCapMs },
          retryAfterMs,
          this.#o.random,
        );
        await tx.db
          .updateTable('exec.job')
          .set({
            state: 'retry_scheduled',
            run_at: new Date(Date.now() + delay),
            lease_token: null,
            lease_owner: null,
            lease_until: null,
            last_error: JSON.stringify({ class: errorClass, code }),
            last_error_class: errorClass,
            updated_at: new Date(),
          })
          .where('id', '=', job.id)
          .execute();
        if (waitingReason === 'rate_limit' || waitingReason === 'dependency_unavailable') {
          await transition(tx, 'waiting', { waitingReason });
        }
        this.#o.metrics.count('job.retries', 1, { queue: job.queue, error_class: errorClass });
        log.info('job.retry_scheduled', { delay_ms: delay, error_class: errorClass });
        return 'retry_scheduled';
      }

      await this.#finishJob(tx, fenced, 'dead', { class: errorClass, code });
      if (waitingReason) await transition(tx, 'waiting', { waitingReason });
      else await transition(tx, 'failed', { terminalReason });
      this.#o.metrics.count('job.dead', 1, { queue: job.queue });
      log.error('job.dead_lettered', { error_class: errorClass, error_code: code });
      return 'dead';
    });
  }

  /** Worker-loss recovery (0D §7.3): expired leases return to the queue; the lost attempt is closed. */
  async reapExpiredLeases(): Promise<number> {
    const expired = await this.#o.discovery.discoverExpiredLeases(100);
    let reaped = 0;
    for (const { jobId, workspaceId } of expired) {
      const done = await this.#tx(workspaceId, async (tx) => {
        const job = await tx.db
          .selectFrom('exec.job')
          .selectAll()
          .where('id', '=', jobId)
          .where('state', '=', 'leased')
          .where('lease_until', '<', sql<Date>`now()`)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!job) return false;
        await tx.db
          .updateTable('exec.attempt')
          .set({
            execution_state: 'failed',
            terminal_reason: 'error',
            error_class: 'worker_lost',
            worker_lost: true,
            ended_at: new Date(),
          })
          .where('job_id', '=', job.id)
          .where('ended_at', 'is', null)
          .execute();
        const context = contextFromRow(job);
        if (job.attempts >= job.max_attempts) {
          await this.#finishJob(tx, job, 'dead', { class: 'worker_lost', code: 'lease_expired' });
          if (job.operation_id) {
            await transitionOperation(tx, {
              operationId: job.operation_id,
              to: 'failed',
              terminalReason: 'error',
              actor: SYSTEM_ACTOR,
              context,
            });
          }
          this.#o.metrics.count('job.dead', 1, { queue: job.queue });
        } else {
          await tx.db
            .updateTable('exec.job')
            .set({
              state: 'queued',
              run_at: new Date(),
              lease_token: null,
              lease_owner: null,
              lease_until: null,
              last_error: JSON.stringify({ class: 'worker_lost', code: 'lease_expired' }),
              last_error_class: 'worker_lost',
              updated_at: new Date(),
            })
            .where('id', '=', job.id)
            .execute();
        }
        this.#o.metrics.count('job.lease_expired', 1, { queue: job.queue });
        this.#o.logger.warn('job.lease_expired', {
          job_id: job.id,
          queue: job.queue,
          workspace_id: workspaceId,
          correlation_id: uuidToTraceId(job.correlation_id),
        });
        return true;
      });
      if (done) reaped++;
    }
    return reaped;
  }

  /** At-least-once outbox dispatch with per-consumer inbox receipts (0D §8.3). */
  async dispatchOutbox(): Promise<number> {
    const claims = await this.#o.discovery.claimOutboxEvents(
      this.#o.params.claimBatchSize,
      this.#o.params.leaseDurationMs,
    );
    let dispatched = 0;
    for (const { eventId, workspaceId } of claims) {
      const row = await this.#tx(
        workspaceId,
        (tx) =>
          tx.db
            .selectFrom('exec.outbox_event')
            .selectAll()
            .where('id', '=', eventId)
            .where('dispatched_at', 'is', null)
            .executeTakeFirst(),
        true,
      );
      if (!row) continue;
      const event = toInternalEvent(row);
      const consumers = this.#o.consumers.filter((c) =>
        (c.eventTypes as readonly string[]).includes(event.type),
      );
      const ok = await withSpan(
        this.#o.tracer,
        'outbox.dispatch',
        { 'pm.event.type': event.type, 'pm.outbox.consumers': consumers.length },
        async () => {
          for (const consumer of consumers) {
            try {
              await this.#tx(workspaceId, async (tx) => {
                const receipt = await tx.db
                  .insertInto('exec.inbox_receipt')
                  .values({
                    consumer_name: consumer.name,
                    event_id: event.event_id,
                    workspace_id: workspaceId,
                  })
                  .onConflict((oc) => oc.columns(['consumer_name', 'event_id']).doNothing())
                  .returning('event_id')
                  .executeTakeFirst();
                if (!receipt) {
                  this.#o.metrics.count('inbox.duplicates_skipped', 1, { consumer: consumer.name });
                  return;
                }
                await withSpan(
                  this.#o.tracer,
                  'outbox.consume',
                  { 'pm.consumer': consumer.name },
                  () => consumer.handle(tx, event),
                );
              });
            } catch (err) {
              this.#o.logger.warn('outbox.consumer_failed', {
                consumer: consumer.name,
                event_id: event.event_id,
                event_type: event.type,
                correlation_id: event.correlation_id,
                ...errorFields(err),
              });
              return false;
            }
          }
          return true;
        },
        { parent: contextFromTraceparent(row.traceparent), kind: SpanKind.CONSUMER },
      );
      if (!ok) {
        this.#o.metrics.count('outbox.dispatched', 1, { outcome: 'retry' });
        continue;
      }
      await this.#tx(workspaceId, (tx) =>
        tx.db
          .updateTable('exec.outbox_event')
          .set({ dispatched_at: new Date(), dispatch_lease_until: null })
          .where('id', '=', eventId)
          .where('dispatched_at', 'is', null)
          .execute(),
      );
      this.#o.metrics.gauge('outbox.dispatch.lag', Date.now() - row.recorded_at.getTime());
      this.#o.metrics.count('outbox.dispatched', 1, { outcome: 'dispatched' });
      this.#o.logger.debug('outbox.dispatched', {
        event_id: event.event_id,
        event_type: event.type,
        correlation_id: event.correlation_id,
      });
      dispatched++;
    }
    return dispatched;
  }

  /** Retention sweeps, one transaction per explicit workspace (0C §12.4 step 3). */
  async runMaintenance(): Promise<number> {
    const cutoff = new Date(Date.now() - this.#o.params.outboxReplayWindowMs);
    const workspaces = await this.#o.discovery.discoverMaintenanceWorkspaces(cutoff, 100);
    for (const ws of workspaces) {
      await this.#tx(ws, async (tx) => {
        await tx.db.deleteFrom('exec.outbox_event').where('dispatched_at', '<', cutoff).execute();
        await tx.db
          .deleteFrom('exec.idempotency_key')
          .where('expires_at', '<', sql<Date>`now()`)
          .execute();
        // Receipts are kept while their event can still be redelivered.
        await tx.db
          .deleteFrom('exec.inbox_receipt')
          .where('processed_at', '<', cutoff)
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom('exec.outbox_event')
                  .select('id')
                  .whereRef('exec.outbox_event.id', '=', 'exec.inbox_receipt.event_id'),
              ),
            ),
          )
          .execute();
        await tx.db.deleteFrom('exec.job').where('finished_at', '<', cutoff).execute();
      });
    }
    return workspaces.length;
  }

  async recordStats(): Promise<void> {
    const stats = await this.#o.discovery.jobQueueStats();
    const lag = new Map<string, number>();
    for (const s of stats) {
      this.#o.metrics.gauge('job.states', s.jobs, { queue: s.queue, state: s.state });
      lag.set(s.queue, Math.max(lag.get(s.queue) ?? 0, s.oldestDueAgeMs));
    }
    for (const [queue, ms] of lag) this.#o.metrics.gauge('job.queue.lag', ms, { queue });
    const backlog = await this.#o.discovery.outboxBacklog();
    this.#o.metrics.gauge('outbox.backlog', backlog.pending);
    this.#o.metrics.gauge('outbox.dispatch.lag', backlog.oldestAgeMs);
    this.#o.metrics.gauge('worker.active_jobs', this.#inflight.size);
    for (const pool of this.#o.pools ?? []) pool.recordSaturation();
  }

  /**
   * Graceful shutdown: stop claiming, let in-flight jobs finish within the grace period, then
   * abort the rest so they release their leases at the next step boundary.
   */
  async stop(): Promise<void> {
    if (this.#state !== 'running') return;
    this.#state = 'stopping';
    if (this.#timer) clearTimeout(this.#timer);
    this.#o.logger.info('worker.stopping', {
      worker_id: this.workerId,
      count: this.#inflight.size,
    });
    await this.#o.discovery.heartbeat(this.workerId, this.#o.buildId, true).catch(() => undefined);
    const all = () => Promise.allSettled([...this.#inflight.values()].map((j) => j.done));
    let graceTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      all(),
      new Promise((r) => (graceTimer = setTimeout(r, this.#o.params.shutdownGraceMs))),
    ]);
    clearTimeout(graceTimer);
    if (this.#inflight.size > 0) {
      for (const job of this.#inflight.values()) job.abort.abort(new WorkerShutdownError());
      await all();
    }
    await this.#o.discovery.removeWorker(this.workerId).catch(() => undefined);
    this.#o.metrics.gauge('worker.up', 0, { role: 'worker' });
    this.#state = 'stopped';
    this.#o.logger.info('worker.stopped', { worker_id: this.workerId });
  }

  /**
   * Simulates abrupt process death (tests): timers stop and no further database writes happen.
   * Leases are left to expire, exactly as after a crash.
   */
  kill(): void {
    this.#state = 'killed';
    if (this.#timer) clearTimeout(this.#timer);
    for (const job of this.#inflight.values()) job.abort.abort(new WorkerKilledError());
  }
}
