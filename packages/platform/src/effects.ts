import {
  newUuidV7,
  type ActorRef,
  type EffectDestinationClass,
  type EffectState,
} from '@pm/contracts';
import type { ExternalEffectTable, Selectable, WorkspaceTransaction } from '@pm/db';

export type EffectRow = Selectable<ExternalEffectTable>;

export const SAFE_RETRY_CLASSES: ReadonlySet<EffectDestinationClass> = new Set([
  'idempotent_by_provider',
  'naturally_idempotent',
  'deduplicated_by_receiver',
]);

export type EffectDecision = 'attempt' | 'already_sent' | 'await_reconciliation' | 'cancelled';

/** Decides what an attempt may do with an effect (0D §5.4). */
export function decideEffect(row: Pick<EffectRow, 'state' | 'destination_class'>): EffectDecision {
  switch (row.state) {
    case 'sent':
    case 'confirmed':
      return 'already_sent';
    case 'cancelled':
      return 'cancelled';
    case 'unknown':
      return SAFE_RETRY_CLASSES.has(row.destination_class) ? 'attempt' : 'await_reconciliation';
    case 'pending':
    case 'failed':
      return 'attempt';
  }
}

/** Thrown when an external call's outcome is unknown (timeout after send, connection reset). */
export class EffectOutcomeUnknownError extends Error {
  constructor() {
    super('external effect outcome unknown');
    this.name = 'EffectOutcomeUnknownError';
  }
}

/** Records the effect with its stable key before any attempt (idempotent per operation + key). */
export async function recordEffect(
  tx: WorkspaceTransaction,
  input: { operationId: string; effectKey: string; destinationClass: EffectDestinationClass },
): Promise<EffectRow> {
  await tx.db
    .insertInto('exec.external_effect')
    .values({
      id: newUuidV7(),
      workspace_id: tx.workspaceId,
      operation_id: input.operationId,
      effect_key: input.effectKey,
      destination_class: input.destinationClass,
      // The provider idempotency key is stable across attempts.
      provider_idempotency_key: `${input.operationId}:${input.effectKey}`,
    })
    .onConflict((oc) => oc.columns(['operation_id', 'effect_key']).doNothing())
    .execute();
  return tx.db
    .selectFrom('exec.external_effect')
    .selectAll()
    .where('operation_id', '=', input.operationId)
    .where('effect_key', '=', input.effectKey)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

export async function markEffectAttempt(
  tx: WorkspaceTransaction,
  effectId: string,
  attemptId: string | undefined,
): Promise<void> {
  const row = await tx.db
    .selectFrom('exec.external_effect')
    .select(['attempt_count', 'version'])
    .where('id', '=', effectId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  await tx.db
    .updateTable('exec.external_effect')
    .set({
      // A retry of a failed or (safe-class) unknown effect moves it back to pending first; the
      // transition guard rejects this for unsafe unknown effects without a reconciliation decision.
      state: 'pending',
      attempt_count: row.attempt_count + 1,
      last_attempt_id: attemptId ?? null,
      updated_at: new Date(),
      version: row.version + 1,
    })
    .where('id', '=', effectId)
    .execute();
}

export async function markEffectOutcome(
  tx: WorkspaceTransaction,
  effectId: string,
  state: Extract<EffectState, 'sent' | 'unknown' | 'failed' | 'confirmed'>,
  externalRef?: string,
): Promise<void> {
  const row = await tx.db
    .selectFrom('exec.external_effect')
    .select(['version'])
    .where('id', '=', effectId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  await tx.db
    .updateTable('exec.external_effect')
    .set({
      state,
      external_ref: externalRef ?? null,
      updated_at: new Date(),
      version: row.version + 1,
    })
    .where('id', '=', effectId)
    .execute();
}

/**
 * Human reconciliation of an unknown outcome (0D §5.4): "sent", "not sent - retry", or "abandon".
 * The decision and actor are recorded on the ledger row; 1F adds the audit event.
 */
export async function reconcileEffect(
  tx: WorkspaceTransaction,
  effectId: string,
  decision: 'sent' | 'retry' | 'abandon',
  actor: ActorRef,
): Promise<void> {
  const row = await tx.db
    .selectFrom('exec.external_effect')
    .select(['state', 'version'])
    .where('id', '=', effectId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (row.state !== 'unknown') throw new Error('only unknown effects are reconciled');
  const state: EffectState =
    decision === 'sent' ? 'confirmed' : decision === 'retry' ? 'pending' : 'cancelled';
  await tx.db
    .updateTable('exec.external_effect')
    .set({
      state,
      reconciliation_decision: decision,
      reconciled_by_actor_type: actor.type,
      reconciled_by: actor.id ?? null,
      reconciled_at: new Date(),
      updated_at: new Date(),
      version: row.version + 1,
    })
    .where('id', '=', effectId)
    .execute();
}

/**
 * Cancellation (0D §6.2): pending and failed effects are cancelled; effects already sent or
 * unknown are reported, never silently dropped.
 */
export async function cancelOpenEffects(
  tx: WorkspaceTransaction,
  operationId: string,
): Promise<{ cancelled: number; reported: Array<{ effectKey: string; state: EffectState }> }> {
  const cancelled = await tx.db
    .updateTable('exec.external_effect')
    .set({ state: 'cancelled', updated_at: new Date() })
    .where('operation_id', '=', operationId)
    .where('state', 'in', ['pending', 'failed'])
    .executeTakeFirst();
  const reported = await tx.db
    .selectFrom('exec.external_effect')
    .select(['effect_key', 'state'])
    .where('operation_id', '=', operationId)
    .where('state', 'in', ['sent', 'unknown', 'confirmed'])
    .execute();
  return {
    cancelled: Number(cancelled.numUpdatedRows),
    reported: reported.map((r) => ({ effectKey: r.effect_key, state: r.state })),
  };
}
