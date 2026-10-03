import {
  newPublicId,
  newUuidV7,
  OPERATION_KINDS,
  type ActorRef,
  type ExecState,
  type ExecutionContext,
  type OperationKind,
  type TerminalReason,
  type WaitingReason,
} from '@pm/contracts';
import type { OperationTable, Selectable, WorkspaceTransaction } from '@pm/db';
import type { AuditSink } from './audit.ts';
import { contextColumns } from './execution-context.ts';
import { enqueueJob } from './jobs.ts';
import { writeOutboxEvent } from './outbox.ts';

const KINDS: ReadonlySet<string> = new Set(OPERATION_KINDS.map((k) => k.kind));
const TERMINAL: ReadonlySet<ExecState> = new Set([
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'skipped',
]);
export const NON_TERMINAL_STATES: readonly ExecState[] = ['queued', 'running', 'waiting', 'paused'];

export function isTerminalState(state: ExecState): boolean {
  return TERMINAL.has(state);
}

export class OperationError extends Error {
  readonly reason:
    'unregistered_kind' | 'context_mismatch' | 'not_found' | 'illegal_transition' | 'duplicate';

  constructor(reason: OperationError['reason']) {
    super(`operation rejected: ${reason}`);
    this.name = 'OperationError';
    this.reason = reason;
  }
}

export interface CreateOperationInput {
  kind: OperationKind;
  context: ExecutionContext;
  initiatedBy: ActorRef;
  dedupeKey?: string;
  rerunOfOperationId?: string;
  progressUnit?: string;
}

export interface CreatedOperation {
  id: string;
  publicId: string;
}

export async function createOperation(
  tx: WorkspaceTransaction,
  input: CreateOperationInput,
): Promise<CreatedOperation> {
  if (!KINDS.has(input.kind)) throw new OperationError('unregistered_kind');
  if (input.context.workspaceId !== tx.workspaceId) throw new OperationError('context_mismatch');
  const id = newUuidV7();
  const publicId = newPublicId('op');
  const inserted = await tx.db
    .insertInto('exec.operation')
    .values({
      id,
      workspace_id: tx.workspaceId,
      public_id: publicId,
      kind: input.kind,
      dedupe_key: input.dedupeKey ?? null,
      rerun_of_operation_id: input.rerunOfOperationId ?? null,
      progress_unit: input.progressUnit ?? null,
      initiated_by_actor_type: input.initiatedBy.type,
      initiated_by_id: input.initiatedBy.id ?? null,
      ...contextColumns(input.context),
    })
    // Partial unique index on non-terminal (workspace, kind, dedupe_key): duplicates are absorbed.
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!inserted) throw new OperationError('duplicate');
  return { id, publicId };
}

export interface TransitionInput {
  operationId: string;
  to: ExecState;
  terminalReason?: TerminalReason;
  waitingReason?: WaitingReason;
  outcomeDetail?: Record<string, unknown>;
  actor: ActorRef;
  context: ExecutionContext;
  attemptId?: string;
}

/**
 * Moves an operation to a new state, enforcing terminal finality, and writes the
 * `execution.operation.state_changed` fact in the same transaction.
 */
export async function transitionOperation(
  tx: WorkspaceTransaction,
  input: TransitionInput,
): Promise<void> {
  const current = await tx.db
    .selectFrom('exec.operation')
    .select(['id', 'kind', 'execution_state', 'version', 'started_at'])
    .where('id', '=', input.operationId)
    .forUpdate()
    .executeTakeFirst();
  if (!current) throw new OperationError('not_found');
  if (isTerminalState(current.execution_state)) throw new OperationError('illegal_transition');
  const terminal = isTerminalState(input.to);
  const version = current.version + 1;
  await tx.db
    .updateTable('exec.operation')
    .set({
      execution_state: input.to,
      terminal_reason: input.terminalReason ?? null,
      waiting_reason: input.to === 'waiting' ? (input.waitingReason ?? null) : null,
      outcome_detail:
        input.outcomeDetail !== undefined ? JSON.stringify(input.outcomeDetail) : null,
      started_at: current.started_at ?? (input.to === 'queued' ? null : new Date()),
      ended_at: terminal ? new Date() : null,
      updated_at: new Date(),
      version,
    })
    .where('id', '=', input.operationId)
    .execute();
  if (current.execution_state !== input.to || input.to === 'waiting') {
    await writeOutboxEvent(tx, {
      type: 'execution.operation.state_changed',
      aggregate: { type: 'execution.operation', id: input.operationId, sequence: version },
      data: {
        kind: current.kind,
        state: input.to,
        terminal_reason: input.terminalReason ?? null,
        waiting_reason: input.to === 'waiting' ? (input.waitingReason ?? null) : null,
      },
      actor: input.actor,
      context: input.context,
      operationId: input.operationId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    });
  }
}

/** Cooperative cancellation (0D §6.2): sets cancel_requested_at; handlers stop at a step boundary. */
export async function requestOperationCancel(
  tx: WorkspaceTransaction,
  operationId: string,
): Promise<boolean> {
  const res = await tx.db
    .updateTable('exec.operation')
    .set({ cancel_requested_at: new Date(), updated_at: new Date() })
    .where('id', '=', operationId)
    .where('cancel_requested_at', 'is', null)
    .where('execution_state', 'in', NON_TERMINAL_STATES)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

export interface StartOperationInput extends CreateOperationInput {
  queue: string;
  jobKind: string;
  payloadRef?: string;
  maxAttempts: number;
  timeoutSeconds: number;
  runAt?: Date;
  /** Audit action key for the initiating action (0C action key). */
  auditActionKey: string;
}

/**
 * Transactional creation of a logical operation, its job, the audit-ready metadata reference, and
 * the initial outbox event (0B §9.5). Commits atomically with the caller's transaction.
 */
export async function startOperation(
  tx: WorkspaceTransaction,
  input: StartOperationInput,
  audit: AuditSink,
): Promise<CreatedOperation & { jobId: string }> {
  const op = await createOperation(tx, input);
  const job = await enqueueJob(tx, {
    queue: input.queue,
    kind: input.jobKind,
    context: input.context,
    operationId: op.id,
    maxAttempts: input.maxAttempts,
    timeoutSeconds: input.timeoutSeconds,
    ...(input.payloadRef !== undefined ? { payloadRef: input.payloadRef } : {}),
    ...(input.runAt !== undefined ? { runAt: input.runAt } : {}),
  });
  await writeOutboxEvent(tx, {
    type: 'execution.operation.state_changed',
    aggregate: { type: 'execution.operation', id: op.id, sequence: 0 },
    data: { kind: input.kind, state: 'queued', terminal_reason: null, waiting_reason: null },
    actor: input.initiatedBy,
    context: input.context,
    operationId: op.id,
  });
  await audit.record(tx, {
    actionKey: input.auditActionKey,
    actorType: input.initiatedBy.type,
    actorId: input.initiatedBy.id,
    workspaceId: tx.workspaceId,
    operationId: op.id,
    correlationId: input.context.correlationId,
    occurredAt: new Date(),
    targets: [{ type: 'execution.operation', id: op.id }],
  });
  return { ...op, jobId: job.id };
}

export interface PublicOperationOptions {
  /** Public workspace ID used in links (never the internal key). */
  workspacePublicId: string;
  attemptCount: number;
  /** Maps an internal actor key to a public ID; omitted when unavailable (no internal key leaks). */
  resolveActorPublicId?: (type: string, internalId: string) => string | undefined;
}

/** Serializes to the public 0D `operation` resource. Internal UUIDs never appear. */
export function toPublicOperation(
  row: Selectable<OperationTable>,
  options: PublicOperationOptions,
): Record<string, unknown> {
  const self = `/v1/workspaces/${options.workspacePublicId}/operations/${row.public_id}`;
  const actorId = row.initiated_by_id
    ? options.resolveActorPublicId?.(row.initiated_by_actor_type, row.initiated_by_id)
    : undefined;
  const out: Record<string, unknown> = {
    id: row.public_id,
    type: 'operation',
    kind: row.kind,
    state: row.execution_state,
    attempt_count: options.attemptCount,
    initiated_by: { type: row.initiated_by_actor_type, ...(actorId ? { id: actorId } : {}) },
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    links: {
      self,
      events: `/v1/workspaces/${options.workspacePublicId}/live?topic=${row.public_id}`,
    },
  };
  if (row.terminal_reason) out.terminal_reason = row.terminal_reason;
  if (row.waiting_reason) out.waiting_reason = row.waiting_reason;
  if (row.cancel_requested_at) out.cancel_requested_at = row.cancel_requested_at.toISOString();
  if (row.started_at) out.started_at = row.started_at.toISOString();
  if (row.ended_at) out.ended_at = row.ended_at.toISOString();
  if (row.progress_unit) {
    out.progress = {
      completed: row.progress_completed,
      unit: row.progress_unit,
      estimated: row.progress_estimated,
      ...(row.progress_phase ? { phase: row.progress_phase } : {}),
      ...(row.progress_total !== null ? { total: row.progress_total } : {}),
    };
  }
  return out;
}
