import { createHash } from 'node:crypto';
import {
  newUuidV7,
  type ActorRef,
  type EffectDestinationClass,
  type EffectState,
} from '@pm/contracts';
import { sql, type ExternalEffectTable, type Selectable, type WorkspaceTransaction } from '@pm/db';
import { contextFromRow } from './execution-context.ts';
import { transitionOperation } from './operations.ts';

export type EffectRow = Selectable<ExternalEffectTable>;

/**
 * External effect ledger (0D §5.4, ADR-0045). One row per logical effect (operation, effect key),
 * recorded before any attempt. States:
 *
 * | State         | Meaning                                                                       |
 * |---------------|-------------------------------------------------------------------------------|
 * | `pending`     | Not dispatched in the current cycle (never attempted, or an explicit retry)   |
 * | `dispatching` | One claimant owns an in-flight attempt; the claim is durable before any I/O   |
 * | `sent`        | The destination acknowledged it                                               |
 * | `confirmed`   | Sent and confirmed (by the destination or an authorized reconciliation)       |
 * | `unknown`     | It may have left and the outcome is not known (the default after possible dispatch) |
 * | `failed`      | Typed proof that it was not sent (never inferred from an arbitrary error)     |
 * | `cancelled`   | Stopped before dispatch, or abandoned by an authorized decision (an abandoned |
 * |               | possibly-sent effect keeps its attempts and decision; it is never "not sent") |
 *
 * A claim is taken under the row lock, with a token, before the caller performs any I/O. Outcome
 * writes are fenced to that token and the `dispatching` state: a stale claimant can only record
 * late evidence. Recovery of an abandoned claim records `unknown`; unsafe destinations then wait
 * for an authorized reconciliation and are never resent automatically. Exactly-once delivery to an
 * unsafe destination is never claimed.
 */
export const SAFE_RETRY_CLASSES: ReadonlySet<EffectDestinationClass> = new Set([
  'idempotent_by_provider',
  'naturally_idempotent',
  'deduplicated_by_receiver',
]);

/**
 * A destination registered in code with its retry capability. Handlers name a destination, never
 * a bare class, so no caller can relabel an unsafe destination as safe; the ledger stores a
 * fingerprint of the destination and its contract, and a key reused with another fingerprint is
 * refused.
 */
export interface EffectDestination {
  readonly id: string;
  readonly class: EffectDestinationClass;
  /** The parameters the effect key promises (endpoint kind, message template, contract version). */
  readonly contract: string;
}

const DESTINATIONS = new Map<string, EffectDestination>();

export function defineEffectDestination(
  id: string,
  destinationClass: EffectDestinationClass,
  contract = 'v1',
): EffectDestination {
  if (!/^[a-z][a-z0-9_.]{1,63}$/.test(id)) throw new Error('effect destination id');
  const existing = DESTINATIONS.get(id);
  if (existing) {
    if (existing.class !== destinationClass || existing.contract !== contract)
      throw new Error(`effect destination ${id} is already registered with another contract`);
    return existing;
  }
  const d = Object.freeze({ id, class: destinationClass, contract });
  DESTINATIONS.set(id, d);
  return d;
}

/** The stored fingerprint of a destination and its contract (no payload, no secret). */
export function destinationFingerprint(d: EffectDestination): string {
  return createHash('sha256').update(`${d.id}\n${d.class}\n${d.contract}`).digest('hex');
}

export type EffectDecision =
  'attempt' | 'already_sent' | 'await_reconciliation' | 'cancelled' | 'in_flight';

/** What a new claimant may do with an effect row (an abandoned claim is recovered first). */
export function decideEffect(row: Pick<EffectRow, 'state' | 'destination_class'>): EffectDecision {
  switch (row.state) {
    case 'sent':
    case 'confirmed':
      return 'already_sent';
    case 'cancelled':
      return 'cancelled';
    case 'dispatching':
      return 'in_flight';
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

/** Codes a destination adapter may use to prove an effect was not sent. */
export const NOT_SENT_CODES = [
  'refused_before_send', // the connection was refused or the request was never written
  'rejected_by_receiver', // the receiver answered that it did not accept or apply it
  'precondition_failed', // a local precondition failed before any request was made
] as const;
export type NotSentCode = (typeof NOT_SENT_CODES)[number];

/**
 * Typed proof that an effect was not sent. Only an adapter that knows the request never left (or
 * that the receiver refused it without applying it) throws this; it is the only path to `failed`.
 * Timeouts, resets, cancellation after send, and a failed outcome write are not proof.
 */
export class EffectNotSentError extends Error {
  readonly code: NotSentCode;
  constructor(code: NotSentCode, options?: { cause?: unknown }) {
    super(`external effect not sent: ${code}`, options);
    this.name = 'EffectNotSentError';
    this.code = code;
  }
}

/** A key reused for another destination, class, or contract. */
export class EffectKeyConflictError extends Error {
  constructor() {
    super('effect key reused with another destination or contract');
    this.name = 'EffectKeyConflictError';
  }
}

/** A stale claimant's outcome: it was recorded as late evidence and changed nothing. */
export class StaleEffectClaimError extends Error {
  constructor() {
    super('external effect claim is no longer current');
    this.name = 'StaleEffectClaimError';
  }
}

/** Records the effect with its stable key before any attempt (idempotent per operation + key). */
export async function recordEffect(
  tx: WorkspaceTransaction,
  input: { operationId: string; effectKey: string; destination: EffectDestination },
): Promise<EffectRow> {
  const fingerprint = destinationFingerprint(input.destination);
  await tx.db
    .insertInto('exec.external_effect')
    .values({
      id: newUuidV7(),
      workspace_id: tx.workspaceId,
      operation_id: input.operationId,
      effect_key: input.effectKey,
      destination_class: input.destination.class,
      destination_fingerprint: fingerprint,
      // The provider idempotency key is stable across attempts.
      provider_idempotency_key: `${input.operationId}:${input.effectKey}`,
    })
    .onConflict((oc) => oc.columns(['operation_id', 'effect_key']).doNothing())
    .execute();
  const row = await tx.db
    .selectFrom('exec.external_effect')
    .selectAll()
    .where('operation_id', '=', input.operationId)
    .where('effect_key', '=', input.effectKey)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (row.destination_class !== input.destination.class) throw new EffectKeyConflictError();
  if (row.destination_fingerprint === null) {
    // A row recorded before fingerprints existed adopts this destination once (class unchanged).
    await tx.db
      .updateTable('exec.external_effect')
      .set({ destination_fingerprint: fingerprint })
      .where('id', '=', row.id)
      .execute();
    return { ...row, destination_fingerprint: fingerprint };
  }
  if (row.destination_fingerprint !== fingerprint) throw new EffectKeyConflictError();
  return row;
}

export interface EffectClaim {
  effectId: string;
  token: string;
  providerKey: string;
}

/**
 * Whether a dispatching row's claimant is still alive. A worker's claim lives exactly as long as
 * its attempt runs under a current (heartbeat-extended) job lease; a claim without an attempt (a
 * sweep) lives until its own `claim_until`.
 */
async function claimAlive(tx: WorkspaceTransaction, row: EffectRow): Promise<boolean> {
  if (!row.last_attempt_id) return !!row.claim_until && row.claim_until.getTime() > Date.now();
  const live = await tx.db
    .selectFrom('exec.attempt as a')
    .innerJoin('exec.job as j', 'j.id', 'a.job_id')
    .select(
      sql<boolean>`a.execution_state = 'running' AND j.state = 'leased' AND j.lease_until > now()`.as(
        'alive',
      ),
    )
    .where('a.id', '=', row.last_attempt_id)
    .executeTakeFirst();
  return !!live?.alive;
}

/**
 * Records that a claimant vanished after a durable claim: the effect may have left. It becomes
 * `unknown`; nothing about it is retried here.
 */
export async function abandonClaim(
  tx: WorkspaceTransaction,
  row: Pick<EffectRow, 'id' | 'version'>,
): Promise<void> {
  await tx.db
    .updateTable('exec.external_effect')
    .set({
      state: 'unknown',
      uncertainty_reason: 'abandoned_claim',
      claim_token: null,
      claim_until: null,
      updated_at: new Date(),
      version: Number(row.version) + 1,
    })
    .where('id', '=', row.id)
    .where('state', '=', 'dispatching')
    .execute();
}

async function lockedRow(tx: WorkspaceTransaction, effectId: string): Promise<EffectRow> {
  return tx.db
    .selectFrom('exec.external_effect')
    .selectAll()
    .where('id', '=', effectId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

/**
 * The one way to start an attempt (under the row lock): decides, recovers an abandoned claim as
 * `unknown`, and takes a fresh claim before any I/O. `claimUntil` bounds the claim (the job lease).
 */
export async function claimEffect(
  tx: WorkspaceTransaction,
  effectId: string,
  input: { attemptId: string | null; claimUntil: Date },
): Promise<{ decision: EffectDecision; row: EffectRow; claim?: EffectClaim }> {
  let row = await lockedRow(tx, effectId);
  if (row.state === 'dispatching') {
    if (await claimAlive(tx, row)) return { decision: 'in_flight', row };
    await abandonClaim(tx, row);
    row = await lockedRow(tx, effectId);
  }
  const decision = decideEffect(row);
  if (decision !== 'attempt') return { decision, row };
  const token = newUuidV7();
  const now = new Date();
  await tx.db
    .updateTable('exec.external_effect')
    .set({
      state: 'dispatching',
      attempt_count: row.attempt_count + 1,
      last_attempt_id: input.attemptId,
      claim_token: token,
      claimed_at: now,
      claim_until: input.claimUntil,
      updated_at: now,
      version: Number(row.version) + 1,
    })
    .where('id', '=', effectId)
    .execute();
  const claimed = await lockedRow(tx, effectId);
  return {
    decision,
    row: claimed,
    claim: {
      effectId,
      token,
      providerKey:
        claimed.provider_idempotency_key ?? `${claimed.operation_id}:${claimed.effect_key}`,
    },
  };
}

export type EffectOutcome =
  | { state: 'sent'; externalRef?: string }
  | { state: 'unknown'; reason: 'outcome_unknown' | 'unproven_failure' }
  | { state: 'failed'; notSent: NotSentCode };

/**
 * Records the outcome of the claim it belongs to. Fenced to the claim token and `dispatching`: a
 * stale claimant (recovered, reconciled, or cancelled since) records late evidence only and gets
 * `'stale'` (the caller commits that evidence, then stops); it never overwrites a newer state or
 * causes another send.
 */
export async function recordEffectOutcome(
  tx: WorkspaceTransaction,
  claim: EffectClaim,
  outcome: EffectOutcome,
): Promise<'recorded' | 'stale'> {
  const row = await lockedRow(tx, claim.effectId);
  const now = new Date();
  if (row.state !== 'dispatching' || row.claim_token !== claim.token) {
    await tx.db
      .updateTable('exec.external_effect')
      .set({
        late_outcome: outcome.state,
        late_outcome_at: now,
        updated_at: now,
        version: Number(row.version) + 1,
      })
      .where('id', '=', claim.effectId)
      .execute();
    return 'stale';
  }
  await tx.db
    .updateTable('exec.external_effect')
    .set({
      state: outcome.state,
      external_ref: outcome.state === 'sent' ? (outcome.externalRef ?? null) : null,
      not_sent_code: outcome.state === 'failed' ? outcome.notSent : null,
      uncertainty_reason: outcome.state === 'unknown' ? outcome.reason : null,
      claim_token: null,
      claim_until: null,
      updated_at: now,
      version: Number(row.version) + 1,
    })
    .where('id', '=', claim.effectId)
    .execute();
  return 'recorded';
}

/** A sent effect the destination later confirmed (sent → confirmed; no claim involved). */
export async function confirmEffect(tx: WorkspaceTransaction, effectId: string): Promise<void> {
  await tx.db
    .updateTable('exec.external_effect')
    .set({ state: 'confirmed', updated_at: new Date(), version: sql`version + 1` })
    .where('id', '=', effectId)
    .where('state', '=', 'sent')
    .execute();
}

export type ReconciliationDecision = 'sent' | 'retry' | 'abandon';

export class EffectReconciliationError extends Error {
  readonly reason: 'not_unknown' | 'version_mismatch';
  constructor(reason: EffectReconciliationError['reason']) {
    super(`effect reconciliation refused: ${reason}`);
    this.name = 'EffectReconciliationError';
    this.reason = reason;
  }
}

/**
 * Authorized reconciliation of an unknown outcome (0D §5.4): "sent" (confirmed, never resent),
 * "retry" (the person chose to send it again: one fresh attempt with the same stable key), or
 * "abandon" (no further attempts; whether it was sent stays unknown). Version-bound; the caller
 * authorizes, audits, and makes it idempotent. A human decision is recorded as a decision, not as
 * external proof.
 */
export async function reconcileEffect(
  tx: WorkspaceTransaction,
  effectId: string,
  decision: ReconciliationDecision,
  actor: ActorRef,
  expectedVersion?: number,
): Promise<EffectRow> {
  const row = await lockedRow(tx, effectId);
  if (row.state !== 'unknown') throw new EffectReconciliationError('not_unknown');
  if (expectedVersion !== undefined && Number(row.version) !== expectedVersion)
    throw new EffectReconciliationError('version_mismatch');
  const state: EffectState =
    decision === 'sent' ? 'confirmed' : decision === 'retry' ? 'pending' : 'cancelled';
  const now = new Date();
  await tx.db
    .updateTable('exec.external_effect')
    .set({
      state,
      reconciliation_decision: decision,
      reconciled_by_actor_type: actor.type,
      reconciled_by: actor.id ?? null,
      reconciled_at: now,
      updated_at: now,
      version: Number(row.version) + 1,
    })
    .where('id', '=', effectId)
    .execute();
  return lockedRow(tx, effectId);
}

export type EffectLiability = 'sent' | 'unknown' | 'in_flight';

/**
 * Cancellation (0D §6.2): undispatched work (pending) and proven-not-sent effects (failed) are
 * cancelled. Nothing that may have left is relabelled: a live claim is reported in flight, an
 * abandoned claim becomes unknown, and sent, confirmed, and unknown effects are reported.
 */
export async function cancelOpenEffects(
  tx: WorkspaceTransaction,
  operationId: string,
): Promise<{
  cancelled: number;
  reported: Array<{ effectKey: string; liability: EffectLiability }>;
}> {
  const dispatching = await tx.db
    .selectFrom('exec.external_effect')
    .selectAll()
    .where('operation_id', '=', operationId)
    .where('state', '=', 'dispatching')
    .forUpdate()
    .execute();
  for (const row of dispatching) if (!(await claimAlive(tx, row))) await abandonClaim(tx, row);
  const cancelled = await tx.db
    .updateTable('exec.external_effect')
    .set({ state: 'cancelled', updated_at: new Date(), version: sql`version + 1` })
    .where('operation_id', '=', operationId)
    .where('state', 'in', ['pending', 'failed'])
    .executeTakeFirst();
  const reported = await tx.db
    .selectFrom('exec.external_effect')
    .select(['effect_key', 'state'])
    .where('operation_id', '=', operationId)
    .where('state', 'in', ['sent', 'unknown', 'confirmed', 'dispatching'])
    .orderBy('effect_key')
    .execute();
  return {
    cancelled: Number(cancelled.numUpdatedRows),
    reported: reported.map((r) => ({
      effectKey: r.effect_key,
      liability:
        r.state === 'dispatching' ? 'in_flight' : r.state === 'unknown' ? 'unknown' : 'sent',
    })),
  };
}

/** Effects of an operation that may have left without a known outcome (they block success). */
export async function uncertainEffects(
  tx: WorkspaceTransaction,
  operationId: string,
): Promise<
  Array<{ effectKey: string; destinationClass: EffectDestinationClass; state: EffectState }>
> {
  const rows = await tx.db
    .selectFrom('exec.external_effect')
    .select(['effect_key', 'destination_class', 'state'])
    .where('operation_id', '=', operationId)
    .where('state', 'in', ['unknown', 'dispatching'])
    .orderBy('effect_key')
    .execute();
  return rows.map((r) => ({
    effectKey: r.effect_key,
    destinationClass: r.destination_class,
    state: r.state,
  }));
}

/** The worker lost these attempts: every claim they held is recorded as possibly sent. */
export async function abandonAttemptClaims(
  tx: WorkspaceTransaction,
  attemptIds: readonly string[],
): Promise<number> {
  if (!attemptIds.length) return 0;
  const rows = await tx.db
    .selectFrom('exec.external_effect')
    .select(['id', 'version'])
    .where('state', '=', 'dispatching')
    .where('last_attempt_id', 'in', attemptIds)
    .forUpdate()
    .execute();
  for (const r of rows) await abandonClaim(tx, r);
  return rows.length;
}

const JOB_COPY_COLUMNS = [
  'queue',
  'kind',
  'operation_id',
  'payload_ref',
  'max_attempts',
  'timeout_seconds',
  'completed_steps',
  'checkpoint',
  'authenticated_principal_type',
  'authenticated_principal_id',
  'effective_principal_type',
  'effective_principal_id',
  'initiating_membership_id',
  'delegation_chain',
  'selected_scope',
  'workspace_epoch_at_enqueue',
  'principal_epoch_at_enqueue',
  'agent_class_epoch_at_enqueue',
  'risk_action_key',
  'risk_class',
  'approval_class',
  'approval_id',
  'step_up_id',
  'data_class_limit',
  'locale',
  'timezone',
  'request_id',
  'traceparent',
  'correlation_id',
  'causation_id',
] as const;

/**
 * After an authorized reconciliation decision, an operation that was waiting for it resumes only
 * when no effect of it is still uncertain: "abandon" ends it (cancelled, with the abandoned count;
 * nothing claims the effect was not sent), "sent" and "retry" queue one fresh job that continues
 * from the completed steps with the operation's original execution context (no authority is
 * gained from the person who reconciled). Returns what happened.
 */
export async function resumeAfterReconciliation(
  tx: WorkspaceTransaction,
  operationId: string,
  actor: ActorRef,
): Promise<'still_waiting' | 'resumed' | 'abandoned' | 'not_waiting'> {
  const op = await tx.db
    .selectFrom('exec.operation')
    .select(['id', 'execution_state', 'waiting_reason'])
    .where('id', '=', operationId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (op.execution_state !== 'waiting' || op.waiting_reason !== 'reconciliation_required')
    return 'not_waiting';
  if ((await uncertainEffects(tx, operationId)).length) return 'still_waiting';
  const last = await tx.db
    .selectFrom('exec.job')
    .selectAll()
    .where('operation_id', '=', operationId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  // An operation with no job to continue (work performed outside the job runtime) stays waiting.
  if (!last) return 'still_waiting';
  const context = contextFromRow(last);
  const abandoned = await tx.db
    .selectFrom('exec.external_effect')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('operation_id', '=', operationId)
    .where('reconciliation_decision', '=', 'abandon')
    .executeTakeFirstOrThrow();
  if (Number(abandoned.n) > 0) {
    await transitionOperation(tx, {
      operationId,
      to: 'cancelled',
      terminalReason: 'user_cancelled',
      outcomeDetail: { abandoned_effects: Number(abandoned.n) },
      actor,
      context,
    });
    return 'abandoned';
  }
  const cols = JOB_COPY_COLUMNS.map((c) => sql.ref(c));
  await sql`INSERT INTO exec.job (id, workspace_id, run_at, ${sql.join(cols)})
    SELECT ${newUuidV7()}::uuid, workspace_id, now(), ${sql.join(cols)}
      FROM exec.job WHERE id = ${last.id}`.execute(tx.db);
  await transitionOperation(tx, { operationId, to: 'queued', actor, context });
  return 'resumed';
}
