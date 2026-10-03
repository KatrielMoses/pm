import { createHash } from 'node:crypto';
import { newUuidV7 } from '@pm/contracts';
import type { ActorType } from '@pm/contracts';
import type { SourceKind, StoredChange, WorkspaceTransaction } from '@pm/db';
import { canonicalJson } from '@pm/platform';
import { changeDigest } from './changes.ts';

/**
 * Per-workspace hash chain over audit events (0B §7.6).
 *
 *   hash(n) = sha256( hash(n-1) || utf8( RFC 8785 canonical JSON of payload(n) ) ),  hash(0) = 32 zero bytes
 *
 * payload(n) holds every structural field plus, per change entry, only {field, class, digest}. The
 * digest fingerprints the entry's original values, so an explicit redaction (which replaces values
 * but keeps the digest) leaves the chain intact while an undeclared value edit does not.
 *
 * What verification detects: an altered structural field or unredacted value, a deleted or
 * inserted row in the middle (sequence gap or broken link), reordering, forks, a redacted entry
 * with no `audit_redaction` record, and tail truncation below the last recorded checkpoint.
 * What it does NOT detect: a privileged actor who rewrites the whole chain and its checkpoints
 * (the chain lives in the same database), events never written (the application must write them),
 * or truncation of events newer than the last checkpoint. It is tamper evidence, not
 * cryptographic non-repudiation.
 */

export const GENESIS_HASH: Buffer = Buffer.alloc(32);
export const CHAIN_PAYLOAD_VERSION = 1;

export interface ChainedEvent {
  id: string;
  occurred_at: Date;
  workspace_id: string;
  brand_id: string | null;
  action: string;
  actor_type: ActorType;
  actor_id: string | null;
  on_behalf_of_membership_id: string | null;
  delegation_chain: ReadonlyArray<{ type: string; id: string }>;
  target_record_id: string | null;
  target_type: string;
  target_public_id: string | null;
  changes: ReadonlyArray<StoredChange>;
  operation_id: string | null;
  attempt_id: string | null;
  correlation_id: string;
  causation_id: string | null;
  source_kind: SourceKind;
  source_ref: string | null;
  workflow_revision_id: string | null;
  retention_class: string;
  chain_seq: string | number | bigint;
}

/** Deterministic serialization: the same logical event always yields the same bytes. */
export function canonicalEventPayload(e: ChainedEvent): string {
  return canonicalJson({
    v: CHAIN_PAYLOAD_VERSION,
    id: e.id,
    occurred_at: e.occurred_at.toISOString(),
    workspace_id: e.workspace_id,
    brand_id: e.brand_id,
    action: e.action,
    actor: {
      type: e.actor_type,
      id: e.actor_id,
      on_behalf_of: e.on_behalf_of_membership_id,
      delegation_chain: e.delegation_chain.map((d) => ({ type: d.type, id: d.id })),
    },
    target: { record_id: e.target_record_id, type: e.target_type, public_id: e.target_public_id },
    changes: e.changes.map((c) => ({ field: c.field, class: c.class, digest: c.digest })),
    operation_id: e.operation_id,
    attempt_id: e.attempt_id,
    correlation_id: e.correlation_id,
    causation_id: e.causation_id,
    source: { kind: e.source_kind, ref: e.source_ref },
    workflow_revision_id: e.workflow_revision_id,
    retention_class: e.retention_class,
    chain_seq: String(e.chain_seq),
  });
}

export function chainHash(prevHash: Buffer, e: ChainedEvent): Buffer {
  return createHash('sha256').update(prevHash).update(canonicalEventPayload(e), 'utf8').digest();
}

export type ChainProblemKind =
  | 'gap'
  | 'broken_link'
  | 'hash_mismatch'
  | 'value_digest_mismatch'
  | 'unrecorded_redaction'
  | 'truncated_below_checkpoint'
  | 'checkpoint_mismatch';

export interface ChainProblem {
  kind: ChainProblemKind;
  /** Chain position only: never values or identifiers of people. */
  seq: string;
}

export interface ChainVerification {
  checked: number;
  headSeq: string | null;
  problems: ChainProblem[];
  checkpointed: boolean;
}

const BATCH = 500;

/**
 * Verifies one workspace's chain inside a workspace transaction. On a clean result it appends a
 * checkpoint of the head so later tail truncation below it becomes detectable.
 */
export async function verifyAuditChain(
  tx: WorkspaceTransaction,
  options: { recordCheckpoint?: boolean } = {},
): Promise<ChainVerification> {
  const problems: ChainProblem[] = [];
  let expected = 1n;
  let prev: Buffer = GENESIS_HASH;
  let checked = 0;
  let lastSeq: bigint | null = null;
  const hashesAt = new Map<string, Buffer>();
  const checkpoint = await tx.db
    .selectFrom('audit.chain_checkpoint')
    .select(['chain_seq', 'hash'])
    .where('workspace_id', '=', tx.workspaceId)
    .orderBy('chain_seq', 'desc')
    .limit(1)
    .executeTakeFirst();

  for (;;) {
    const after: string = lastSeq === null ? '0' : String(lastSeq);
    const rows = await tx.db
      .selectFrom('audit.audit_event')
      .selectAll()
      .where('workspace_id', '=', tx.workspaceId)
      .where('chain_seq', '>', after)
      .orderBy('chain_seq')
      .limit(BATCH)
      .execute();
    if (!rows.length) break;
    const redactions = await tx.db
      .selectFrom('audit.audit_redaction')
      .select(['audit_event_id', 'fields'])
      .where('workspace_id', '=', tx.workspaceId)
      .where(
        'audit_event_id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();
    const redacted = new Map<string, Set<string>>();
    for (const r of redactions) {
      const set = redacted.get(r.audit_event_id) ?? new Set<string>();
      for (const f of r.fields) set.add(f);
      redacted.set(r.audit_event_id, set);
    }
    for (const row of rows) {
      const seq = BigInt(row.chain_seq);
      if (seq !== expected) problems.push({ kind: 'gap', seq: String(expected) });
      if (!row.prev_hash.equals(prev)) problems.push({ kind: 'broken_link', seq: String(seq) });
      const recomputed = chainHash(row.prev_hash, { ...row, changes: row.changes });
      if (!recomputed.equals(row.hash)) problems.push({ kind: 'hash_mismatch', seq: String(seq) });
      for (const c of row.changes) {
        if (c.redacted) {
          if (!redacted.get(row.id)?.has(c.field))
            problems.push({ kind: 'unrecorded_redaction', seq: String(seq) });
        } else {
          const { digest, ...rest } = c;
          if (digest !== changeDigest(rest))
            problems.push({ kind: 'value_digest_mismatch', seq: String(seq) });
        }
      }
      if (checkpoint && String(seq) === String(checkpoint.chain_seq))
        hashesAt.set(String(seq), row.hash);
      prev = row.hash;
      expected = seq + 1n;
      lastSeq = seq;
      checked += 1;
    }
  }

  if (checkpoint) {
    const cpSeq = BigInt(checkpoint.chain_seq);
    if (lastSeq === null || lastSeq < cpSeq)
      problems.push({ kind: 'truncated_below_checkpoint', seq: String(cpSeq) });
    else if (!hashesAt.get(String(cpSeq))?.equals(checkpoint.hash))
      problems.push({ kind: 'checkpoint_mismatch', seq: String(cpSeq) });
  }

  let checkpointed = false;
  if (!problems.length && lastSeq !== null && options.recordCheckpoint !== false) {
    if (!checkpoint || BigInt(checkpoint.chain_seq) < lastSeq) {
      await tx.db
        .insertInto('audit.chain_checkpoint')
        .values({
          id: newUuidV7(),
          workspace_id: tx.workspaceId,
          chain_seq: String(lastSeq),
          hash: prev,
        })
        .execute();
      checkpointed = true;
    }
  }
  return { checked, headSeq: lastSeq === null ? null : String(lastSeq), problems, checkpointed };
}

/** Maps a stored row to the 0D `audit-event` contract shape (internal; exports/views build on it). */
export function toAuditEventContract(e: ChainedEvent): Record<string, unknown> {
  const opt = <K extends string>(k: K, v: unknown) =>
    v === null || v === undefined ? {} : { [k]: v };
  return {
    id: e.id,
    occurred_at: e.occurred_at.toISOString(),
    workspace_id: e.workspace_id,
    ...opt('brand_id', e.brand_id),
    action: e.action,
    actor: {
      type: e.actor_type,
      ...opt('id', e.actor_id),
      ...opt('on_behalf_of', e.on_behalf_of_membership_id),
      ...(e.delegation_chain.length
        ? { delegation_chain: e.delegation_chain.map((d) => ({ type: d.type, id: d.id })) }
        : {}),
    },
    target: {
      type: e.target_type,
      ...opt('record_id', e.target_record_id),
      ...opt('public_id', e.target_public_id),
    },
    changes: e.changes.map((c) => ({ ...c })),
    ...opt('operation_id', e.operation_id),
    ...opt('attempt_id', e.attempt_id),
    correlation_id: e.correlation_id.replace(/-/g, ''),
    ...opt('causation_id', e.causation_id),
    source: { kind: e.source_kind, ...opt('ref', e.source_ref) },
    ...opt('workflow_revision_id', e.workflow_revision_id),
    retention_class: 'R-AUDIT',
  };
}
