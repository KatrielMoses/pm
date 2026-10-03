import { newPublicId, newUuidV7, isUuidV7, type IdPrefix } from '@pm/contracts';
import { sql, type LifecycleState, type WorkspaceTransaction } from '@pm/db';
import type { AuditWriter, CommandContext } from '@pm/audit';
import { requireDecision, type PolicyDecision } from './decision.ts';
import { LifecycleError, type LifecycleRegistry } from './registry.ts';

/**
 * The record envelope and lifecycle-aware reads (0B §2.3, §8.6). Lifecycle filtering lives here,
 * not in RLS: default reads see `active` only; archived needs an explicit option; trash is reachable
 * only through the trash repository with a `trash.manage` decision; tombstones never expose content.
 */

export interface RecordEnvelope {
  id: string;
  publicId: string;
  recordType: string;
  workspaceId: string;
  brandId: string | null;
  lifecycleState: LifecycleState;
  archiveCause: 'self' | 'cascade' | null;
  archiveBatchId: string | null;
  deletionBatchId: string | null;
  version: number;
}

type EnvelopeRow = {
  id: string;
  public_id: string;
  record_type: string;
  workspace_id: string;
  brand_id: string | null;
  lifecycle_state: LifecycleState;
  archive_cause: 'self' | 'cascade' | null;
  archive_batch_id: string | null;
  deletion_batch_id: string | null;
  version: string;
};

const ENVELOPE = [
  'id',
  'public_id',
  'record_type',
  'workspace_id',
  'brand_id',
  'lifecycle_state',
  'archive_cause',
  'archive_batch_id',
  'deletion_batch_id',
  'version',
] as const;

function toEnvelope(r: EnvelopeRow): RecordEnvelope {
  return {
    id: r.id,
    publicId: r.public_id,
    recordType: r.record_type,
    workspaceId: r.workspace_id,
    brandId: r.brand_id,
    lifecycleState: r.lifecycle_state,
    archiveCause: r.archive_cause,
    archiveBatchId: r.archive_batch_id,
    deletionBatchId: r.deletion_batch_id,
    version: Number(r.version),
  };
}

export interface CreateRecordInput {
  recordType: string;
  /** Server-resolved, authorized brand of the same workspace (ignored for brands themselves). */
  brandId?: string | null;
  ownerMembershipId?: string | null;
  templateInstallationId?: string | null;
}

/** Creates an envelope and its `record.created` audit event in the caller's transaction. */
export async function createRecord(
  tx: WorkspaceTransaction,
  writer: AuditWriter,
  cmd: CommandContext,
  input: CreateRecordInput,
): Promise<RecordEnvelope> {
  const type = await tx.db
    .selectFrom('core.record_type')
    .select(['record_type', 'public_id_prefix'])
    .where('record_type', '=', input.recordType)
    .executeTakeFirst();
  if (!type) throw new LifecycleError('unregistered_type');
  for (const ref of [input.brandId, input.ownerMembershipId, input.templateInstallationId])
    if (ref !== undefined && ref !== null && !isUuidV7(ref)) throw new LifecycleError('not_found');
  const id = newUuidV7();
  const publicId = newPublicId(type.public_id_prefix as IdPrefix);
  // A brand envelope is its own brand (brand_id = id); every other record names an existing brand.
  const isBrand = type.record_type === 'brand';
  if (isBrand && input.brandId) throw new LifecycleError('not_found');
  const row = await tx.db
    .insertInto('core.record')
    .values({
      id,
      public_id: publicId,
      record_type: type.record_type,
      workspace_id: tx.workspaceId,
      brand_id: isBrand ? id : (input.brandId ?? null),
      owner_membership_id: input.ownerMembershipId ?? null,
      source_kind: cmd.source.kind,
      source_ref: cmd.source.ref ?? null,
      template_installation_id: input.templateInstallationId ?? null,
      created_by_actor_type: cmd.actor.type,
      created_by_actor_id: cmd.actor.id,
    })
    .returning(ENVELOPE)
    .executeTakeFirstOrThrow();
  await writer.write(tx, cmd, {
    action: 'record.created',
    target: { recordId: id, type: type.record_type, publicId },
  });
  return toEnvelope(row);
}

export type Visibility = 'active' | 'active_or_archived';

/** Default read: active only (archived on request). Trashed and purged rows are never returned. */
export async function getRecord(
  tx: WorkspaceTransaction,
  id: string,
  visibility: Visibility = 'active',
): Promise<RecordEnvelope | null> {
  if (!isUuidV7(id)) return null;
  const row = await tx.db
    .selectFrom('core.record')
    .select(ENVELOPE)
    .where('id', '=', id)
    .where('lifecycle_state', 'in', visibility === 'active' ? ['active'] : ['active', 'archived'])
    .executeTakeFirst();
  return row ? toEnvelope(row) : null;
}

export async function listRecords(
  tx: WorkspaceTransaction,
  options: { recordType?: string; visibility?: Visibility; limit?: number; after?: string } = {},
): Promise<RecordEnvelope[]> {
  const states: LifecycleState[] =
    (options.visibility ?? 'active') === 'active' ? ['active'] : ['active', 'archived'];
  const rows = await tx.db
    .selectFrom('core.record')
    .select(ENVELOPE)
    .where('lifecycle_state', 'in', states)
    .$if(options.recordType !== undefined, (q) => q.where('record_type', '=', options.recordType!))
    .$if(options.after !== undefined, (q) => q.where('id', '>', options.after!))
    .orderBy('id')
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 200))
    .execute();
  return rows.map(toEnvelope);
}

/** Write guard for domain commands: archived and trashed records are read-only (0B §8.3). */
export async function assertWritable(
  tx: WorkspaceTransaction,
  id: string,
): Promise<RecordEnvelope> {
  const row = await tx.db
    .selectFrom('core.record')
    .select(ENVELOPE)
    .where('id', '=', id)
    .forShare()
    .executeTakeFirst();
  if (!row || row.lifecycle_state === 'purged') throw new LifecycleError('not_found');
  if (row.lifecycle_state !== 'active') throw new LifecycleError('not_active');
  return toEnvelope(row);
}

/** Generic representation for anything that is not readable: no title, type, scope, or hint. */
export const DELETED_ITEM = Object.freeze({ kind: 'deleted_item' as const });
export type LinkResolution = { kind: 'record'; record: RecordEnvelope } | typeof DELETED_ITEM;

/**
 * Resolves a public-ID link. Purged, trashed, missing, and malformed IDs all yield the same
 * DELETED_ITEM, so a link reveals neither content nor whether something ever existed (ST-41).
 * Field-level and record-level read policy (1D) still applies to the returned envelope.
 */
export async function resolveRecordLink(
  tx: WorkspaceTransaction,
  publicId: string,
): Promise<LinkResolution> {
  if (!/^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/.test(publicId)) return DELETED_ITEM;
  const row = await tx.db
    .selectFrom('core.record')
    .select(ENVELOPE)
    .where('public_id', '=', publicId)
    .where('lifecycle_state', 'in', ['active', 'archived'])
    .executeTakeFirst();
  return row ? { kind: 'record', record: toEnvelope(row) } : DELETED_ITEM;
}

export interface TrashBatchView {
  batchId: string;
  rootRecordId: string;
  rootPublicId: string;
  rootRecordType: string;
  memberCount: number;
  trashedAt: Date;
  trashedBy: { type: string; id: string | null };
  /** When the batch becomes purge-eligible; null while the recovery period is undecided. */
  purgeEligibleAt: Date | null;
}

/**
 * The only way to enumerate trash (0B §8.6). Requires a `trash.manage` decision (owner/admin, 1D);
 * per-record trash visibility for editors arrives with 1D's effective-permission evaluation.
 */
export async function listTrash(
  tx: WorkspaceTransaction,
  decision: PolicyDecision,
  options: { recoveryPeriodMs: number | null; limit?: number },
): Promise<TrashBatchView[]> {
  requireDecision(decision, 'trash.manage', tx.workspaceId);
  const rows = await tx.db
    .selectFrom('core.deletion_batch as b')
    .innerJoin('core.record as r', 'r.id', 'b.root_record_id')
    .select([
      'b.id',
      'b.root_record_id',
      'r.public_id',
      'r.record_type',
      'b.member_count',
      'b.trashed_at',
      'b.trashed_by_type',
      'b.trashed_by_id',
    ])
    .where('b.state', '=', 'trashed')
    .orderBy('b.trashed_at', 'desc')
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 200))
    .execute();
  return rows.map((r) => ({
    batchId: r.id,
    rootRecordId: r.root_record_id,
    rootPublicId: r.public_id,
    rootRecordType: r.record_type,
    memberCount: r.member_count,
    trashedAt: r.trashed_at,
    trashedBy: { type: r.trashed_by_type, id: r.trashed_by_id },
    purgeEligibleAt:
      options.recoveryPeriodMs === null
        ? null
        : new Date(r.trashed_at.getTime() + options.recoveryPeriodMs),
  }));
}

export interface LockedNode {
  id: string;
  publicId: string;
  recordType: string;
  brandId: string | null;
  state: LifecycleState;
  depth: number;
  archiveBatchId: string | null;
  archiveCause: 'self' | 'cascade' | null;
  deletionBatchId: string | null;
  version: number;
}

/**
 * Locks a containment subtree deterministically: a tree advisory lock on the root, then envelopes
 * level by level in id order (`FOR UPDATE`). Descendants are discovered through registered
 * containment adapters only; traversal continues below nodes for which `descend(state)` holds.
 */
export async function lockSubtree(
  tx: WorkspaceTransaction,
  registry: LifecycleRegistry,
  rootId: string,
  descend: (state: LifecycleState) => boolean,
): Promise<LockedNode[]> {
  if (!isUuidV7(rootId)) throw new LifecycleError('not_found');
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'core.tree:' + rootId}, 0))`.execute(
    tx.db,
  );
  const select = (ids: readonly string[]) =>
    tx.db
      .selectFrom('core.record')
      .select([
        'id',
        'public_id',
        'record_type',
        'brand_id',
        'lifecycle_state',
        'archive_batch_id',
        'archive_cause',
        'deletion_batch_id',
        'version',
      ])
      .where('id', 'in', ids)
      .orderBy('id')
      .forUpdate()
      .execute();
  const toNode = (r: Awaited<ReturnType<typeof select>>[number], depth: number): LockedNode => ({
    id: r.id,
    publicId: r.public_id,
    recordType: r.record_type,
    brandId: r.brand_id,
    state: r.lifecycle_state,
    depth,
    archiveBatchId: r.archive_batch_id,
    archiveCause: r.archive_cause,
    deletionBatchId: r.deletion_batch_id,
    version: Number(r.version),
  });
  const [root] = await select([rootId]);
  if (!root || root.lifecycle_state === 'purged') throw new LifecycleError('not_found');
  if (!registry.get(root.record_type)) throw new LifecycleError('unregistered_type');
  const nodes: LockedNode[] = [toNode(root, 0)];
  const seen = new Set([root.id]);
  let frontier = descend(root.lifecycle_state) ? [nodes[0]!] : [];
  let depth = 0;
  while (frontier.length) {
    depth += 1;
    const byType = new Map<string, string[]>();
    for (const n of frontier) byType.set(n.recordType, [...(byType.get(n.recordType) ?? []), n.id]);
    const childIds: string[] = [];
    for (const [type, ids] of byType) {
      const adapter = registry.get(type);
      if (!adapter) throw new LifecycleError('unregistered_type');
      for (const c of (await adapter.children?.(tx, ids)) ?? [])
        if (!seen.has(c.id)) {
          seen.add(c.id);
          childIds.push(c.id);
        }
    }
    if (!childIds.length) break;
    const rows = await select([...childIds].sort());
    const level = rows.map((r) => toNode(r, depth));
    for (const n of level)
      if (!registry.get(n.recordType)) throw new LifecycleError('unregistered_type');
    nodes.push(...level);
    frontier = level.filter((n) => descend(n.state));
  }
  return nodes;
}
