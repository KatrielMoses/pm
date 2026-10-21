import {
  newUuidV7,
  type ExecutionContext,
  type JobErrorClass,
  type TerminalReason,
  type WaitingReason,
} from '@pm/contracts';
import { sql, type ScopedTransaction } from '@pm/db';
import type { Logger } from '@pm/observability';
import { contextColumns } from './execution-context.ts';

const QUEUE = /^[a-z_]{1,64}$/;
const KIND = /^[a-z_.]{1,128}$/;

export class JobContractError extends Error {
  constructor(reason: string) {
    super(`job rejected: ${reason}`);
    this.name = 'JobContractError';
  }
}

export interface EnqueueJobInput {
  queue: string;
  kind: string;
  context: ExecutionContext;
  operationId?: string;
  /** Reference to the operation detail row; jobs never carry large payloads (0D §7.6). */
  payloadRef?: string;
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts: number;
  timeoutSeconds: number;
}

/** Enqueues in the caller's transaction. An active duplicate (same dedupe key) is absorbed. */
export async function enqueueJob(
  tx: ScopedTransaction,
  input: EnqueueJobInput,
): Promise<{ id: string; deduplicated: boolean }> {
  if (!QUEUE.test(input.queue)) throw new JobContractError('queue');
  if (!KIND.test(input.kind)) throw new JobContractError('kind');
  if (input.context.workspaceId !== tx.workspaceId)
    throw new JobContractError('context workspace mismatch');
  const id = newUuidV7();
  const inserted = await tx.db
    .insertInto('exec.job')
    .values({
      id,
      workspace_id: tx.workspaceId,
      queue: input.queue,
      kind: input.kind,
      operation_id: input.operationId ?? null,
      payload_ref: input.payloadRef ?? null,
      dedupe_key: input.dedupeKey ?? null,
      run_at: input.runAt ?? new Date(),
      max_attempts: input.maxAttempts,
      timeout_seconds: input.timeoutSeconds,
      ...contextColumns(input.context),
    })
    .onConflict((oc) =>
      oc
        .columns(['workspace_id', 'queue', 'dedupe_key'])
        .where('dedupe_key', 'is not', null)
        .where('state', 'in', ['queued', 'leased', 'retry_scheduled'])
        .doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  if (inserted) return { id, deduplicated: false };
  const existing = await tx.db
    .selectFrom('exec.job')
    .select('id')
    .where('queue', '=', input.queue)
    .where('dedupe_key', '=', input.dedupeKey ?? '')
    .where('state', 'in', ['queued', 'leased', 'retry_scheduled'])
    .executeTakeFirstOrThrow();
  return { id: existing.id, deduplicated: true };
}

/** Cancels a job that has not started; started jobs observe cancellation at step boundaries. */
export async function requestJobCancel(
  tx: ScopedTransaction,
  jobId: string,
): Promise<'cancelled' | 'requested' | 'not_cancellable'> {
  const queued = await tx.db
    .updateTable('exec.job')
    .set({
      state: 'cancelled',
      finished_at: new Date(),
      cancel_requested_at: new Date(),
      updated_at: new Date(),
    })
    .where('id', '=', jobId)
    .where('state', 'in', ['queued', 'retry_scheduled'])
    .executeTakeFirst();
  if (Number(queued.numUpdatedRows) > 0) return 'cancelled';
  const leased = await tx.db
    .updateTable('exec.job')
    .set({ cancel_requested_at: sql`coalesce(cancel_requested_at, now())`, updated_at: new Date() })
    .where('id', '=', jobId)
    .where('state', '=', 'leased')
    .executeTakeFirst();
  return Number(leased.numUpdatedRows) > 0 ? 'requested' : 'not_cancellable';
}

/**
 * A handler failure with a registered error class (0D §7.4). `code` is a static, content-free
 * identifier. Unclassified exceptions are treated as `transient` (bounded by the attempt cap).
 */
export class JobError extends Error {
  readonly errorClass: JobErrorClass;
  readonly code: string;
  readonly retryAfterMs: number | undefined;
  readonly operationWaitingReason: WaitingReason | undefined;

  constructor(
    errorClass: JobErrorClass,
    code: string,
    options: { retryAfterMs?: number; operationWaitingReason?: WaitingReason } = {},
  ) {
    super(`job failed: ${errorClass}/${code}`);
    this.name = 'JobError';
    if (!/^[a-z0-9_.]{1,64}$/.test(code))
      throw new Error('JobError code must be a static identifier');
    this.errorClass = errorClass;
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
    this.operationWaitingReason = options.operationWaitingReason;
  }
}

export const RETRYABLE_CLASSES: ReadonlySet<JobErrorClass> = new Set([
  'transient',
  'timeout',
  'worker_lost',
]);

export function classifyError(err: unknown): {
  errorClass: JobErrorClass;
  code: string;
  retryAfterMs: number | undefined;
} {
  if (err instanceof JobError)
    return { errorClass: err.errorClass, code: err.code, retryAfterMs: err.retryAfterMs };
  return { errorClass: 'transient', code: 'unhandled', retryAfterMs: undefined };
}

/**
 * Full-jitter exponential backoff (0D §7.4):
 *   delay = random(0, min(JOB_BACKOFF_CAP, JOB_BACKOFF_BASE * 2^attempt)),
 * and a provider Retry-After takes precedence when longer.
 */
export function retryDelayMs(
  attempt: number,
  params: { baseMs: number; capMs: number },
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(params.capMs, params.baseMs * 2 ** Math.max(attempt, 0));
  const jittered = Math.floor(random() * exp);
  return retryAfterMs !== undefined && retryAfterMs > jittered ? retryAfterMs : jittered;
}

export interface JobInfo {
  id: string;
  kind: string;
  queue: string;
  /** null for platform-scoped jobs. */
  workspaceId: string | null;
  operationId: string | undefined;
  attemptId: string | undefined;
  attemptNumber: number;
  payloadRef: string | undefined;
}

export interface JobHandlerContext {
  readonly job: JobInfo;
  readonly context: ExecutionContext;
  readonly logger: Logger;
  /** Aborted on timeout, lease loss, or shutdown. */
  readonly signal: AbortSignal;
  /**
   * Runs one checkpointed step in its own workspace transaction, fenced by the lease. A step that
   * already completed (before a crash or retry) is skipped and its stored result returned.
   */
  step<T extends Record<string, unknown> | void>(
    name: string,
    fn: (tx: ScopedTransaction) => Promise<T>,
  ): Promise<T>;
  /**
   * Performs an external effect through the effect ledger (ADR-0045): the stable key is recorded
   * before the attempt and a durable claim is taken before any I/O; sent effects are never
   * repeated; any error is an unknown outcome unless `perform` throws `EffectNotSentError` (typed
   * proof); unknown outcomes on unsafe destinations wait for reconciliation and are never resent.
   * The destination is a registered one (`defineEffectDestination`), never a bare class.
   */
  effect(
    effectKey: string,
    destination: import('./effects.ts').EffectDestination,
    perform: (providerIdempotencyKey: string) => Promise<{ externalRef?: string }>,
  ): Promise<{ state: 'sent' | 'confirmed'; externalRef: string | undefined }>;
}

export type JobResult =
  | { state: 'succeeded' }
  | { state: 'partial'; result: Record<string, unknown> }
  /**
   * Nothing ran (8A: conditions not met, out of scope, loop guard); a terminal outcome with its
   * registered terminal reason and the precise reason in the outcome detail.
   */
  | { state: 'skipped'; terminalReason: TerminalReason; result?: Record<string, unknown> }
  /**
   * The work continues later (8A delays): the job ends, the operation waits with the reason, and
   * one continuation job is queued for `resumeAt` in the same fenced transaction. No worker sleeps
   * and no transaction is held while it waits.
   */
  | {
      state: 'waiting';
      reason: 'delay' | 'external_confirmation';
      resumeAt: Date;
      result?: Record<string, unknown>;
    }
  /**
   * 8C: the work waits for a person (current authority changed, or an approval only a human can
   * give). The job ends and the operation waits with the reason; no continuation is queued, so
   * nothing resumes on its own: an authorized resume re-checks everything and enqueues a new job.
   */
  | {
      state: 'waiting';
      reason: 'authorization_changed' | 'approval';
      resumeAt?: undefined;
      result?: Record<string, unknown>;
    }
  /** 8C: paused by a person or the emergency stop; the operation is `paused`, nothing continues. */
  | { state: 'paused'; result?: Record<string, unknown> };

export interface JobHandler {
  readonly kind: string;
  readonly queue: string;
  /** Per-kind overrides of JOB_MAX_ATTEMPTS / JOB_TIMEOUT. */
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  handle(ctx: JobHandlerContext): Promise<JobResult | void>;
}
