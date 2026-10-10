import { change, CommandContext, type AuditWriter, type CommandSource } from '@pm/audit';
import { newUuidV7, type ExecutionContext } from '@pm/contracts';
import type { LifecycleState, WorkspaceTransaction } from '@pm/db';
import type { Logger, Metrics } from '@pm/observability';
import {
  OperationError,
  startOperation,
  writeOutboxEvent,
  type AuditMetadata,
  type AuditSink,
} from '@pm/platform';
import { PolicyDecisionError, requireDecision, type PolicyDecision } from './decision.ts';
import { lockSubtree, type LockedNode } from './records.ts';
import {
  BRANDS_UNTIL_1C,
  LifecycleError,
  NO_HOLDS,
  type BrandPort,
  type HoldPort,
  type LifecycleRegistry,
} from './registry.ts';
import type { RetentionPolicy } from './retention.ts';

export interface LifecycleDeps {
  registry: LifecycleRegistry;
  writer: AuditWriter;
  retention: RetentionPolicy;
  holds?: HoldPort;
  brands?: BrandPort;
  metrics: Metrics;
  logger: Logger;
}

export interface CommandInput {
  /** Trusted server-side execution context (never request data). */
  exec: ExecutionContext;
  source: CommandSource;
}

export const PURGE_JOB_KIND = 'lifecycle.purge';

/**
 * Brand archive and restore are authorized by `brand.archive` (0C, R3), never by the generic record
 * actions; any other root needs the record action.
 */
function requireRootKind(action: string, recordType: string): void {
  if ((recordType === 'brand') !== (action === 'brand.archive'))
    throw new PolicyDecisionError('wrong action');
}
export const PURGE_QUEUE = 'lifecycle';

/**
 * Reusable lifecycle commands (0B §8.3-§8.5). Each runs inside the caller's workspace transaction
 * with a policy decision; state changes, audit events, and outbox events commit together. Repeated
 * or concurrent requests are idempotent: a second caller waits on the subtree lock and then sees
 * the first caller's result.
 */
export class LifecycleService {
  readonly #d: LifecycleDeps;
  readonly #holds: HoldPort;
  readonly #brands: BrandPort;

  constructor(deps: LifecycleDeps) {
    this.#d = deps;
    this.#holds = deps.holds ?? NO_HOLDS;
    this.#brands = deps.brands ?? BRANDS_UNTIL_1C;
  }

  get deps(): LifecycleDeps {
    return this.#d;
  }

  get holds(): HoldPort {
    return this.#holds;
  }

  #transition(name: string, outcome: string, n = 1): void {
    this.#d.metrics.count('lifecycle.transitions', n, { transition: name, outcome });
  }

  async #record(
    tx: WorkspaceTransaction,
    cmd: CommandContext,
    input: CommandInput,
    node: LockedNode,
    action: 'record.archived' | 'record.unarchived' | 'record.trashed' | 'record.restored',
    from: LifecycleState,
    to: LifecycleState,
    version: number,
    batchId: string,
    archiveCause?: 'self' | 'cascade',
  ): Promise<void> {
    await this.#d.writer.write(tx, cmd, {
      action,
      target: { recordId: node.id, type: node.recordType, publicId: node.publicId },
      changes: [change.plain('lifecycle_state', from, to)],
    });
    const event: {
      type: 'core.record.archived' | 'core.record.trashed' | 'core.record.restored';
      data: Record<string, string>;
    } =
      action === 'record.archived'
        ? {
            type: 'core.record.archived' as const,
            data: {
              record_type: node.recordType,
              archive_cause: archiveCause ?? 'self',
              batch_id: batchId,
            },
          }
        : action === 'record.trashed'
          ? {
              type: 'core.record.trashed' as const,
              data: { record_type: node.recordType, deletion_batch_id: batchId },
            }
          : {
              type: 'core.record.restored' as const,
              data: { record_type: node.recordType, batch_id: batchId },
            };
    await writeOutboxEvent(tx, {
      type: event.type,
      aggregate: { type: 'core.record', id: node.id, sequence: version },
      data: event.data,
      actor: { type: cmd.actor.type, ...(cmd.actor.id ? { id: cmd.actor.id } : {}) },
      context: input.exec,
      ...(node.brandId ? { brandId: node.brandId } : {}),
    });
  }

  #cmd(input: CommandInput, brandId: string | null): CommandContext {
    return CommandContext.fromExecution(input.exec, input.source, { brandId });
  }

  /** Archive a record and its active contained subtree as one batch (0B §8.3). */
  async archive(
    tx: WorkspaceTransaction,
    decision: PolicyDecision,
    input: CommandInput,
    recordId: string,
  ): Promise<{ batchId: string; members: number; alreadyArchived: boolean }> {
    const action = decision?.action === 'brand.archive' ? 'brand.archive' : 'record.archive';
    requireDecision(decision, action, tx.workspaceId, recordId);
    const nodes = await lockSubtree(tx, this.#d.registry, recordId, (s) => s === 'active');
    const root = nodes[0]!;
    requireRootKind(action, root.recordType);
    if (root.state === 'archived')
      return { batchId: root.archiveBatchId!, members: 0, alreadyArchived: true };
    if (root.state === 'trashed') throw new LifecycleError('in_trash');
    const cmd = this.#cmd(input, root.brandId);
    const targets = nodes.filter((n) => n.state === 'active');
    const batchId = newUuidV7();
    await tx.db
      .insertInto('core.archive_batch')
      .values({
        id: batchId,
        workspace_id: tx.workspaceId,
        brand_id: root.brandId,
        root_record_id: root.id,
        member_count: targets.length,
        archived_by_type: cmd.actor.type,
        archived_by_id: cmd.actor.id,
        operation_id: cmd.operationId,
        correlation_id: cmd.correlationId,
      })
      .execute();
    const now = new Date();
    for (const n of targets) {
      const cause = n.id === root.id ? 'self' : 'cascade';
      const res = await tx.db
        .updateTable('core.record')
        .set({
          lifecycle_state: 'archived',
          archive_cause: cause,
          archive_batch_id: batchId,
          archived_at: now,
          archived_by_type: cmd.actor.type,
          archived_by_id: cmd.actor.id,
          version: String(n.version + 1),
        })
        .where('id', '=', n.id)
        .where('lifecycle_state', '=', 'active')
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw new LifecycleError('concurrent_change');
      await tx.db
        .insertInto('core.archive_batch_member')
        .values({ workspace_id: tx.workspaceId, batch_id: batchId, record_id: n.id, cause })
        .execute();
      await this.#record(
        tx,
        cmd,
        input,
        n,
        'record.archived',
        'active',
        'archived',
        n.version + 1,
        batchId,
        cause,
      );
    }
    this.#transition('archive', 'ok', targets.length);
    return { batchId, members: targets.length, alreadyArchived: false };
  }

  /** Reverses exactly one archive batch: the root plus rows that batch cascaded (0B §8.3). */
  async unarchive(
    tx: WorkspaceTransaction,
    decision: PolicyDecision,
    input: CommandInput,
    recordId: string,
  ): Promise<{ batchId: string | null; members: number; alreadyActive: boolean }> {
    const action = decision?.action === 'brand.archive' ? 'brand.archive' : 'record.restore';
    requireDecision(decision, action, tx.workspaceId, recordId);
    const nodes = await lockSubtree(tx, this.#d.registry, recordId, (s) => s === 'archived');
    const root = nodes[0]!;
    requireRootKind(action, root.recordType);
    if (root.state === 'active') return { batchId: null, members: 0, alreadyActive: true };
    if (root.state !== 'archived') throw new LifecycleError('in_trash');
    if (root.archiveCause === 'cascade') throw new LifecycleError('archived_by_container');
    const container = await this.#d.registry.get(root.recordType)?.containerOf?.(tx, root.id);
    if (container) await this.#requireActiveContainer(tx, container.id);
    const batchId = root.archiveBatchId!;
    const cmd = this.#cmd(input, root.brandId);
    const members = new Set(
      (
        await tx.db
          .selectFrom('core.archive_batch_member')
          .select(['record_id'])
          .where('batch_id', '=', batchId)
          .execute()
      ).map((m) => m.record_id),
    );
    const targets = nodes.filter(
      (n) =>
        n.state === 'archived' &&
        n.archiveBatchId === batchId &&
        members.has(n.id) &&
        (n.id === root.id || n.archiveCause === 'cascade'),
    );
    for (const n of targets) {
      const res = await tx.db
        .updateTable('core.record')
        .set({
          lifecycle_state: 'active',
          archive_cause: null,
          archive_batch_id: null,
          archived_at: null,
          archived_by_type: null,
          archived_by_id: null,
          version: String(n.version + 1),
        })
        .where('id', '=', n.id)
        .where('lifecycle_state', '=', 'archived')
        .where('archive_batch_id', '=', batchId)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw new LifecycleError('concurrent_change');
      await this.#record(
        tx,
        cmd,
        input,
        n,
        'record.unarchived',
        'archived',
        'active',
        n.version + 1,
        batchId,
      );
    }
    const batch = await tx.db
      .selectFrom('core.archive_batch')
      .select('version')
      .where('id', '=', batchId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await tx.db
      .updateTable('core.archive_batch')
      .set({
        state: 'restored',
        restored_at: new Date(),
        restored_by_type: cmd.actor.type,
        restored_by_id: cmd.actor.id,
        version: String(Number(batch.version) + 1),
      })
      .where('id', '=', batchId)
      .where('state', '=', 'archived')
      .execute();
    this.#transition('unarchive', 'ok', targets.length);
    return { batchId, members: targets.length, alreadyActive: false };
  }

  async #requireActiveContainer(tx: WorkspaceTransaction, containerId: string): Promise<void> {
    const c = await tx.db
      .selectFrom('core.record')
      .select('lifecycle_state')
      .where('id', '=', containerId)
      .forShare()
      .executeTakeFirst();
    if (!c || c.lifecycle_state === 'purged') throw new LifecycleError('container_missing');
    if (c.lifecycle_state === 'trashed') throw new LifecycleError('container_trashed');
    if (c.lifecycle_state !== 'active') throw new LifecycleError('container_inactive');
  }

  /**
   * Moves a record and its contained subtree (active or archived members) to trash as one batch,
   * preserving each member's prior state. Members already in another batch are untouched;
   * associations are never followed (0B §8.4).
   */
  async trash(
    tx: WorkspaceTransaction,
    decision: PolicyDecision,
    input: CommandInput,
    recordId: string,
  ): Promise<{ batchId: string; members: number; alreadyTrashed: boolean }> {
    requireDecision(decision, 'record.trash', tx.workspaceId, recordId);
    const nodes = await lockSubtree(
      tx,
      this.#d.registry,
      recordId,
      (s) => s === 'active' || s === 'archived',
    );
    const root = nodes[0]!;
    if (root.state === 'trashed') {
      const own = await tx.db
        .selectFrom('core.deletion_batch')
        .select(['id'])
        .where('id', '=', root.deletionBatchId!)
        .where('root_record_id', '=', root.id)
        .executeTakeFirst();
      if (own) return { batchId: own.id, members: 0, alreadyTrashed: true };
      throw new LifecycleError('in_trash');
    }
    const cmd = this.#cmd(input, root.brandId);
    const targets = nodes.filter((n) => n.state === 'active' || n.state === 'archived');
    const container = await this.#d.registry.get(root.recordType)?.containerOf?.(tx, root.id);
    const batchId = newUuidV7();
    await tx.db
      .insertInto('core.deletion_batch')
      .values({
        id: batchId,
        workspace_id: tx.workspaceId,
        brand_id: root.brandId,
        root_record_id: root.id,
        trashed_by_type: cmd.actor.type,
        trashed_by_id: cmd.actor.id,
        restore_location: JSON.stringify(
          container
            ? { container_record_id: container.id, container_type: container.recordType }
            : {},
        ),
        member_count: targets.length,
        correlation_id: cmd.correlationId,
      })
      .execute();
    const now = new Date();
    for (const n of targets) {
      const res = await tx.db
        .updateTable('core.record')
        .set({
          lifecycle_state: 'trashed',
          prior_lifecycle_state: n.state,
          deletion_batch_id: batchId,
          trashed_at: now,
          trashed_by_type: cmd.actor.type,
          trashed_by_id: cmd.actor.id,
          version: String(n.version + 1),
        })
        .where('id', '=', n.id)
        .where('lifecycle_state', '=', n.state)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw new LifecycleError('concurrent_change');
      await tx.db
        .insertInto('core.deletion_batch_member')
        .values({
          workspace_id: tx.workspaceId,
          batch_id: batchId,
          record_id: n.id,
          record_type: n.recordType,
          prior_lifecycle_state: n.state,
          depth: n.depth,
        })
        .execute();
      await this.#record(
        tx,
        cmd,
        input,
        n,
        'record.trashed',
        n.state,
        'trashed',
        n.version + 1,
        batchId,
      );
    }
    this.#transition('trash', 'ok', targets.length);
    return { batchId, members: targets.length, alreadyTrashed: false };
  }

  /**
   * Restores a deletion batch: trashed → restoring → restored under guarded updates. IDs are kept,
   * prior lifecycle states return, and nothing from the original history is replayed; a distinct
   * `record.restored` event is emitted (0B §8.5). Preconditions fail with typed reasons.
   */
  async restore(
    tx: WorkspaceTransaction,
    decision: PolicyDecision,
    input: CommandInput,
    batchId: string,
  ): Promise<{ members: number; alreadyRestored: boolean }> {
    const batch = await tx.db
      .selectFrom('core.deletion_batch')
      .selectAll()
      .where('id', '=', batchId)
      .forUpdate()
      .executeTakeFirst();
    if (!batch) throw new LifecycleError('not_found');
    requireDecision(decision, 'record.restore', tx.workspaceId, batch.root_record_id);
    if (batch.state === 'restored') return { members: 0, alreadyRestored: true };
    if (batch.state !== 'trashed') throw new LifecycleError('not_restorable');
    const period = await this.#d.retention.periodMs(tx, 'R-LIVE');
    if (period !== null && batch.trashed_at.getTime() + period <= Date.now())
      throw new LifecycleError('recovery_expired');
    const loc = batch.restore_location;
    if (loc.container_record_id) await this.#requireActiveContainer(tx, loc.container_record_id);
    if (batch.brand_id && !(await this.#brands.isActive(tx, batch.brand_id)))
      throw new LifecycleError('brand_inactive');
    const moved = await tx.db
      .updateTable('core.deletion_batch')
      .set({ state: 'restoring', version: String(Number(batch.version) + 1) })
      .where('id', '=', batchId)
      .where('state', '=', 'trashed')
      .executeTakeFirst();
    if (Number(moved.numUpdatedRows) !== 1) throw new LifecycleError('concurrent_change');
    const cmd = this.#cmd(input, batch.brand_id);
    const members = await tx.db
      .selectFrom('core.deletion_batch_member as m')
      .innerJoin('core.record as r', 'r.id', 'm.record_id')
      .select([
        'r.id',
        'r.public_id',
        'r.record_type',
        'r.brand_id',
        'r.lifecycle_state',
        'r.deletion_batch_id',
        'r.version',
        'm.prior_lifecycle_state',
        'm.depth',
      ])
      .where('m.batch_id', '=', batchId)
      .where('m.outcome', '=', 'pending')
      .orderBy('r.id')
      .forUpdate()
      .execute();
    for (const m of members) {
      if (m.lifecycle_state !== 'trashed' || m.deletion_batch_id !== batchId)
        throw new LifecycleError('concurrent_change');
      const version = Number(m.version) + 1;
      await tx.db
        .updateTable('core.record')
        .set({
          lifecycle_state: m.prior_lifecycle_state,
          prior_lifecycle_state: null,
          deletion_batch_id: null,
          trashed_at: null,
          trashed_by_type: null,
          trashed_by_id: null,
          version: String(version),
        })
        .where('id', '=', m.id)
        .execute();
      await tx.db
        .updateTable('core.deletion_batch_member')
        .set({ outcome: 'restored' })
        .where('batch_id', '=', batchId)
        .where('record_id', '=', m.id)
        .execute();
      const node: LockedNode = {
        id: m.id,
        publicId: m.public_id,
        recordType: m.record_type,
        brandId: m.brand_id,
        state: 'trashed',
        depth: m.depth,
        archiveBatchId: null,
        archiveCause: null,
        deletionBatchId: batchId,
        version,
      };
      await this.#record(
        tx,
        cmd,
        input,
        node,
        'record.restored',
        'trashed',
        m.prior_lifecycle_state,
        version,
        batchId,
      );
    }
    await tx.db
      .updateTable('core.deletion_batch')
      .set({
        state: 'restored',
        terminal_outcome: 'restored',
        restored_at: new Date(),
        restored_by_type: cmd.actor.type,
        restored_by_id: cmd.actor.id,
        version: String(Number(batch.version) + 2),
      })
      .where('id', '=', batchId)
      .where('state', '=', 'restoring')
      .execute();
    this.#transition('restore', 'ok', members.length);
    return { members: members.length, alreadyRestored: false };
  }

  /**
   * Requests a purge (manual "delete permanently", or the retention scheduler as system). Creates
   * the durable `purge` operation and its job; idempotent per batch while one is in flight.
   */
  async requestPurge(
    tx: WorkspaceTransaction,
    decision: PolicyDecision,
    input: CommandInput,
    batchId: string,
  ): Promise<{ operationId: string; deduplicated: boolean }> {
    const batch = await tx.db
      .selectFrom('core.deletion_batch as b')
      .innerJoin('core.record as r', 'r.id', 'b.root_record_id')
      .select(['b.id', 'b.state', 'b.root_record_id', 'b.brand_id', 'r.public_id', 'r.record_type'])
      .where('b.id', '=', batchId)
      .forUpdate(['b'])
      .executeTakeFirst();
    if (!batch) throw new LifecycleError('not_found');
    requireDecision(decision, 'record.purge', tx.workspaceId, batch.root_record_id);
    if (batch.state !== 'trashed' && batch.state !== 'purging')
      throw new LifecycleError('not_restorable');
    const cmd = this.#cmd(input, batch.brand_id);
    const sink: AuditSink = {
      record: async (atx, metadata: AuditMetadata) => {
        await this.#d.writer.write(atx, cmd.withOperation(metadata.operationId!, null), {
          action: 'record.purge_requested',
          target: {
            recordId: batch.root_record_id,
            type: batch.record_type,
            publicId: batch.public_id,
          },
        });
      },
    };
    try {
      const op = await startOperation(
        tx,
        {
          kind: 'purge',
          context: input.exec,
          initiatedBy: { type: cmd.actor.type, ...(cmd.actor.id ? { id: cmd.actor.id } : {}) },
          dedupeKey: `purge:${batchId}`,
          queue: PURGE_QUEUE,
          jobKind: PURGE_JOB_KIND,
          payloadRef: `deletion_batch:${batchId}`,
          maxAttempts: 10,
          timeoutSeconds: 600,
          auditActionKey: 'record.purge',
        },
        sink,
      );
      return { operationId: op.id, deduplicated: false };
    } catch (err) {
      if (!(err instanceof OperationError) || err.reason !== 'duplicate') throw err;
      const existing = await tx.db
        .selectFrom('exec.operation')
        .select('id')
        .where('kind', '=', 'purge')
        .where('dedupe_key', '=', `purge:${batchId}`)
        .where('execution_state', 'not in', [
          'succeeded',
          'partial',
          'failed',
          'cancelled',
          'skipped',
        ])
        .executeTakeFirstOrThrow();
      return { operationId: existing.id, deduplicated: true };
    }
  }
}
