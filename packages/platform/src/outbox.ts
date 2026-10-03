import {
  INTERNAL_EVENTS,
  newUuidV7,
  traceIdToUuid,
  uuidToTraceId,
  type ActorRef,
  type ExecutionContext,
  type InternalEventType,
} from '@pm/contracts';
import type { Selectable, WorkspaceTransaction, OutboxEventTable } from '@pm/db';
import { currentTraceparent } from '@pm/observability';

type EventDef = (typeof INTERNAL_EVENTS)[number];
const EVENTS: ReadonlyMap<string, EventDef> = new Map(INTERNAL_EVENTS.map((e) => [e.type, e]));

export class OutboxContractError extends Error {
  constructor(reason: string) {
    super(`outbox event rejected: ${reason}`);
    this.name = 'OutboxContractError';
  }
}

export interface OutboxEventInput {
  type: InternalEventType;
  aggregate: { type: string; id: string; sequence: number };
  /** Minimal facts: only the registry's declared field names (0D §8.2). */
  data: Readonly<Record<string, string | number | boolean | null>>;
  actor: ActorRef;
  context: ExecutionContext;
  brandId?: string;
  operationId?: string;
  attemptId?: string;
  occurredAt?: Date;
}

/**
 * Writes an internal event in the caller's domain transaction (0B §9.5: the change, its audit
 * event, and its outbox event commit together or not at all). Only registered event types and
 * declared fields are accepted, so payloads cannot accumulate content.
 */
export async function writeOutboxEvent(
  tx: WorkspaceTransaction,
  input: OutboxEventInput,
): Promise<string> {
  const def = EVENTS.get(input.type);
  if (!def) throw new OutboxContractError('unregistered event type');
  for (const key of Object.keys(input.data)) {
    if (!(def.fields as readonly string[]).includes(key))
      throw new OutboxContractError(`undeclared field ${key}`);
  }
  if (input.context.workspaceId !== tx.workspaceId)
    throw new OutboxContractError('context workspace mismatch');
  const id = newUuidV7();
  await tx.db
    .insertInto('exec.outbox_event')
    .values({
      id,
      workspace_id: tx.workspaceId,
      brand_id: input.brandId ?? null,
      event_type: def.type,
      schema_version: def.schemaVersion,
      aggregate_type: input.aggregate.type,
      aggregate_id: input.aggregate.id,
      aggregate_sequence: input.aggregate.sequence,
      payload: JSON.stringify(input.data),
      max_class: def.maxClass,
      operation_id: input.operationId ?? null,
      attempt_id: input.attemptId ?? null,
      actor_type: input.actor.type,
      actor_id: input.actor.id ?? null,
      on_behalf_of_membership_id: input.actor.onBehalfOfMembershipId ?? null,
      workspace_epoch: input.context.epochs.workspace,
      delegation_depth: Math.max(input.context.delegationChain.length - 1, 0),
      correlation_id: traceIdToUuid(input.context.correlationId),
      causation_id: input.context.causationId ?? null,
      traceparent: currentTraceparent() ?? input.context.traceparent ?? null,
      occurred_at: input.occurredAt ?? new Date(),
    })
    .execute();
  return id;
}

/** 0D internal-event envelope (snake_case contract shape) built from an outbox row. */
export interface InternalEvent {
  event_id: string;
  type: string;
  schema_version: number;
  occurred_at: string;
  recorded_at: string;
  workspace_id: string;
  brand_id?: string;
  aggregate: { type: string; id: string; sequence: number };
  actor: { type: string; id?: string; on_behalf_of?: string };
  auth: { workspace_epoch: number; delegation_depth?: number };
  correlation_id: string;
  causation_id?: string;
  operation_id?: string;
  attempt_id?: string;
  data: Record<string, unknown>;
  max_class: string;
}

export function toInternalEvent(row: Selectable<OutboxEventTable>): InternalEvent {
  const event: InternalEvent = {
    event_id: row.id,
    type: row.event_type,
    schema_version: row.schema_version,
    occurred_at: row.occurred_at.toISOString(),
    recorded_at: row.recorded_at.toISOString(),
    workspace_id: row.workspace_id,
    aggregate: { type: row.aggregate_type, id: row.aggregate_id, sequence: row.aggregate_sequence },
    actor: {
      type: row.actor_type,
      ...(row.actor_id ? { id: row.actor_id } : {}),
      ...(row.on_behalf_of_membership_id ? { on_behalf_of: row.on_behalf_of_membership_id } : {}),
    },
    auth: {
      workspace_epoch: row.workspace_epoch,
      ...(row.delegation_depth !== null ? { delegation_depth: row.delegation_depth } : {}),
    },
    correlation_id: uuidToTraceId(row.correlation_id),
    data: row.payload,
    max_class: row.max_class,
  };
  if (row.brand_id) event.brand_id = row.brand_id;
  if (row.causation_id) event.causation_id = row.causation_id;
  if (row.operation_id) event.operation_id = row.operation_id;
  if (row.attempt_id) event.attempt_id = row.attempt_id;
  return event;
}

/**
 * In-process outbox consumer. `handle` runs in the same workspace transaction as the consumer's
 * inbox receipt, so a redelivered event is a no-op (0D §8.3). Consumers re-apply authorization at
 * their own read or delivery time and must ignore unknown fields.
 */
export interface OutboxConsumer {
  readonly name: string;
  readonly eventTypes: readonly InternalEventType[];
  handle(tx: WorkspaceTransaction, event: InternalEvent): Promise<void>;
}
