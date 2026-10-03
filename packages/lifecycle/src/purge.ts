import { change, CommandContext, removeActivity } from '@pm/audit';
import { newUuidV7 } from '@pm/contracts';
import type { ExecutionContext } from '@pm/contracts';
import {
  sql,
  type DeletionBatchTable,
  type DeletionBlockResult,
  type Selectable,
  type PlatformDiscovery,
  type TenantDatabase,
  type WorkspaceTransaction,
} from '@pm/db';
import { recordEffect, writeOutboxEvent, type JobHandler, type RecurringJob } from '@pm/platform';
import { PURGE_JOB_KIND, PURGE_QUEUE, type LifecycleService } from './commands.ts';
import { systemDecision } from './decision.ts';
import {
  validateLedgerEntry,
  type LedgerAck,
  type PurgeLedger,
  type PurgeLedgerEntry,
} from './ledger.ts';
import { LifecycleError, type RecordRef } from './registry.ts';

interface ResidualGroup {
  root: string;
  members: string[];
  container: RecordRef | null;
}

/**
 * Durable purge (0B §8.8). A `purge` operation drives checkpointed steps, each idempotent:
 *
 *   begin        trashed → purging (guarded) after checking the ledger, purge hooks, holds, and
 *                evidence locks; any block is recorded on the batch and nothing is deleted
 *   content      typed rows and hosted children bottom-up, then associations (module hooks)
 *   effects      object deletions ENQUEUED as external effects (stable keys), never performed here
 *   projections  module projection hooks + the activity projection
 *   redact       protected audit values of purged targets, via the guarded audit_maintainer procedure
 *   ledger       durable append to the purge ledger outside the database backup set (ack required)
 *   tombstone    content-free envelopes; batch → purged with the ledger acknowledgement
 */

export type BeginResult =
  | { status: 'proceed'; excluded: number }
  | { status: 'done' }
  | { status: 'blocked'; reason: DeletionBlockResult | 'not_purgeable' };

const OBJECT_KEY = /^[A-Za-z0-9_.:-]{1,180}$/;

export class PurgeExecutor {
  readonly #svc: LifecycleService;
  readonly #ledger: PurgeLedger;

  constructor(svc: LifecycleService, ledger: PurgeLedger) {
    this.#svc = svc;
    this.#ledger = ledger;
  }

  get ledger(): PurgeLedger {
    return this.#ledger;
  }

  async #timed<T>(hook: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const r = await fn();
      this.#svc.deps.metrics.record('purge.hook.duration', performance.now() - started, {
        hook,
        outcome: 'ok',
      });
      return r;
    } catch (err) {
      this.#svc.deps.metrics.record('purge.hook.duration', performance.now() - started, {
        hook,
        outcome: 'error',
      });
      this.#svc.deps.metrics.count('purge.hook.failures', 1, { hook });
      throw err;
    }
  }

  async #pending(tx: WorkspaceTransaction, batchId: string) {
    return tx.db
      .selectFrom('core.deletion_batch_member')
      .select(['record_id', 'record_type', 'depth'])
      .where('batch_id', '=', batchId)
      .where('outcome', '=', 'pending')
      .orderBy('depth', 'desc')
      .orderBy('record_id')
      .execute();
  }

  async #block(
    tx: WorkspaceTransaction,
    batch: { id: string; version: string },
    reason: DeletionBlockResult,
  ): Promise<BeginResult> {
    await tx.db
      .updateTable('core.deletion_batch')
      .set({
        block_result: reason,
        hold: reason === 'hold',
        version: String(Number(batch.version) + 1),
      })
      .where('id', '=', batch.id)
      .where('state', '=', 'trashed')
      .execute();
    this.#svc.deps.metrics.count('purge.blocked', 1, { reason });
    this.#svc.deps.logger.warn('purge.blocked', {
      component: 'lifecycle',
      workspace_id: tx.workspaceId,
      batch_id: batch.id,
      reason,
    });
    return { status: 'blocked', reason };
  }

  async begin(
    tx: WorkspaceTransaction,
    operationId: string,
    batchId: string,
    cmd: CommandContext,
  ): Promise<BeginResult> {
    const batch = await tx.db
      .selectFrom('core.deletion_batch')
      .selectAll()
      .where('id', '=', batchId)
      .forUpdate()
      .executeTakeFirst();
    if (!batch) return { status: 'blocked', reason: 'not_purgeable' };
    if (batch.state === 'purged') return { status: 'done' };
    if (batch.state === 'purging')
      return batch.operation_id === operationId
        ? { status: 'proceed', excluded: batch.evidence_locked_count }
        : { status: 'blocked', reason: 'not_purgeable' };
    if (batch.state !== 'trashed') return { status: 'blocked', reason: 'not_purgeable' };
    // Every check happens before anything destructive.
    if (!this.#ledger.available) return this.#block(tx, batch, 'ledger_unavailable');
    const members = await this.#pending(tx, batchId);
    const registry = this.#svc.deps.registry;
    if (registry.missingPurgeHooks(members.map((m) => m.record_type)).length)
      return this.#block(tx, batch, 'missing_purge_hook');
    if (
      await this.#svc.holds.isHeld(tx, {
        workspaceId: tx.workspaceId,
        recordIds: members.map((m) => m.record_id),
      })
    )
      return this.#block(tx, batch, 'hold');
    const locked = new Set<string>();
    const byType = new Map<string, string[]>();
    for (const m of members)
      byType.set(m.record_type, [...(byType.get(m.record_type) ?? []), m.record_id]);
    for (const [type, ids] of byType)
      for (const id of (await registry.get(type)?.evidenceLocked?.(tx, ids)) ?? []) locked.add(id);
    let excluded = 0;
    if (locked.size) {
      const plan = await this.#residualPlan(tx, members, locked, batch.root_record_id);
      // Nothing would be left to purge (or the root itself is held back): the whole batch waits.
      if (!plan) return this.#block(tx, batch, 'evidence_lock_all');
      excluded = await this.#split(tx, batch, plan, operationId, cmd);
    }
    const moved = await tx.db
      .updateTable('core.deletion_batch')
      .set({
        state: 'purging',
        operation_id: operationId,
        purge_started_at: new Date(),
        hold: false,
        evidence_locked_count: excluded,
        block_result: excluded ? 'evidence_lock_partial' : null,
        version: String(Number(batch.version) + 1),
      })
      .where('id', '=', batchId)
      .where('state', '=', 'trashed')
      .executeTakeFirst();
    if (Number(moved.numUpdatedRows) !== 1) throw new LifecycleError('concurrent_change');
    this.#svc.deps.metrics.count('lifecycle.transitions', 1, {
      transition: 'purge_start',
      outcome: 'ok',
    });
    return { status: 'proceed', excluded };
  }

  /**
   * Residual grouping. It is deterministic: it depends only on batch membership, containment, and
   * the current locks, so every retry computes the same groups.
   *   1. A member is excluded if it is evidence-locked or contained (within this batch) in an
   *      excluded member: a held record keeps its in-batch subtree, so restore stays coherent.
   *   2. Each excluded member whose in-batch container is not excluded is a residual root; every
   *      other excluded member joins the group of its nearest excluded ancestor.
   *   3. Groups are ordered by (root depth, root id); members by (depth, id).
   * Returns null when nothing would remain to purge or the original root itself is held back: the
   * original batch's root is never handed to a residual batch, and the whole batch waits instead.
   */
  async #residualPlan(
    tx: WorkspaceTransaction,
    members: Array<{ record_id: string; record_type: string; depth: number }>,
    locked: ReadonlySet<string>,
    rootRecordId: string,
  ): Promise<ResidualGroup[] | null> {
    const inBatch = new Set(members.map((m) => m.record_id));
    const container = new Map<string, RecordRef | null>();
    for (const m of members)
      container.set(
        m.record_id,
        (await this.#svc.deps.registry.get(m.record_type)?.containerOf?.(tx, m.record_id)) ?? null,
      );
    const parent = (id: string): string | null => {
      const c = container.get(id);
      return c && inBatch.has(c.id) ? c.id : null;
    };
    const order = [...members].sort(
      (a, b) => a.depth - b.depth || (a.record_id < b.record_id ? -1 : 1),
    );
    const excluded = new Set<string>();
    for (const m of order) {
      const p = parent(m.record_id);
      if (locked.has(m.record_id) || (p !== null && excluded.has(p))) excluded.add(m.record_id);
    }
    if (excluded.size >= members.length || excluded.has(rootRecordId)) return null;
    const rootOf = (id: string): string => {
      let cur = id;
      for (let p = parent(cur); p !== null && excluded.has(p); p = parent(cur)) cur = p;
      return cur;
    };
    const groups = new Map<string, string[]>();
    for (const m of order.filter((x) => excluded.has(x.record_id))) {
      const root = rootOf(m.record_id);
      groups.set(root, [...(groups.get(root) ?? []), m.record_id]);
    }
    return [...groups].map(([root, ids]) => ({
      root,
      members: ids,
      container: container.get(root) ?? null,
    }));
  }

  /**
   * Moves each residual group into a successor `trashed` batch inside the begin transaction,
   * before anything destructive: lineage on the successor, `moved_to_successor` history on the
   * original, fresh pending memberships, re-pointed envelopes, and audit events. Returns the
   * number of moved records.
   */
  async #split(
    tx: WorkspaceTransaction,
    batch: Selectable<DeletionBatchTable>,
    plan: ResidualGroup[],
    operationId: string,
    cmd: CommandContext,
  ): Promise<number> {
    const original = await tx.db
      .selectFrom('core.deletion_batch_member as m')
      .innerJoin('core.record as r', 'r.id', 'm.record_id')
      .select([
        'm.record_id',
        'm.record_type',
        'm.prior_lifecycle_state',
        'm.depth',
        'r.public_id',
        'r.version',
      ])
      .where('m.batch_id', '=', batch.id)
      .where('m.outcome', '=', 'pending')
      .execute();
    const byId = new Map(original.map((m) => [m.record_id, m]));
    const successors: string[] = [];
    let moved = 0;
    for (const group of plan) {
      const successor = newUuidV7();
      successors.push(successor);
      await tx.db
        .insertInto('core.deletion_batch')
        .values({
          id: successor,
          workspace_id: tx.workspaceId,
          brand_id: batch.brand_id,
          root_record_id: group.root,
          trashed_at: batch.trashed_at,
          trashed_by_type: batch.trashed_by_type,
          trashed_by_id: batch.trashed_by_id,
          restore_location: JSON.stringify(
            group.container
              ? {
                  container_record_id: group.container.id,
                  container_type: group.container.recordType,
                }
              : {},
          ),
          member_count: group.members.length,
          correlation_id: cmd.correlationId,
          split_from_batch_id: batch.id,
          split_operation_id: operationId,
        })
        .execute();
      // History first (frees the active-membership slot), then the successor's membership.
      const updated = await tx.db
        .updateTable('core.deletion_batch_member')
        .set({ outcome: 'moved_to_successor', successor_batch_id: successor })
        .where('batch_id', '=', batch.id)
        .where('record_id', 'in', group.members)
        .where('outcome', '=', 'pending')
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== group.members.length)
        throw new LifecycleError('concurrent_change');
      for (const id of group.members) {
        const m = byId.get(id)!;
        await tx.db
          .insertInto('core.deletion_batch_member')
          .values({
            workspace_id: tx.workspaceId,
            batch_id: successor,
            record_id: id,
            record_type: m.record_type,
            prior_lifecycle_state: m.prior_lifecycle_state,
            depth: m.depth,
          })
          .execute();
        const res = await tx.db
          .updateTable('core.record')
          .set({ deletion_batch_id: successor, version: String(Number(m.version) + 1) })
          .where('id', '=', id)
          .where('lifecycle_state', '=', 'trashed')
          .where('deletion_batch_id', '=', batch.id)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) !== 1) throw new LifecycleError('concurrent_change');
      }
      // Batch-level facts target the batch (not a record), so purging a record never redacts them.
      await this.#svc.deps.writer.write(tx, cmd, {
        action: 'record.residual_batch_created',
        target: { recordId: successor, type: 'deletion_batch', publicId: null },
        changes: [
          change.plain('root_record_id', null, group.root),
          change.plain('original_batch_id', null, batch.id),
          change.plain('successor_batch_id', null, successor),
          change.plain('excluded_count', null, group.members.length),
        ],
      });
      moved += group.members.length;
    }
    await this.#svc.deps.writer.write(tx, cmd, {
      action: 'record.partial_purge_split',
      target: { recordId: batch.id, type: 'deletion_batch', publicId: null },
      changes: [
        change.plain('original_batch_id', null, batch.id),
        change.plain('successor_batch_ids', null, successors),
        change.plain('excluded_count', null, moved),
      ],
    });
    this.#svc.deps.metrics.count('lifecycle.transitions', plan.length, {
      transition: 'purge_split',
      outcome: 'ok',
    });
    return moved;
  }

  /** Bottom-up typed content, then associations, per record type (module hooks). */
  async content(
    tx: WorkspaceTransaction,
    batchId: string,
  ): Promise<{ records: number; associations: number }> {
    const members = await this.#pending(tx, batchId);
    let associations = 0;
    const levels = [...new Set(members.map((m) => m.depth))].sort((a, b) => b - a);
    for (const depth of levels) {
      const byType = new Map<string, string[]>();
      for (const m of members.filter((x) => x.depth === depth))
        byType.set(m.record_type, [...(byType.get(m.record_type) ?? []), m.record_id]);
      for (const [type, ids] of byType) {
        const hooks = this.#svc.deps.registry.get(type)?.purge;
        if (!hooks) throw new LifecycleError('missing_purge_hook');
        await this.#timed('content', () => hooks.deleteContent(tx, ids));
        if (hooks.removeAssociations)
          associations += await this.#timed('associations', () =>
            hooks.removeAssociations!(tx, ids),
          );
      }
    }
    return { records: members.length, associations };
  }

  /** Enqueues object deletions as external effects keyed by object key (performed elsewhere). */
  async effects(
    tx: WorkspaceTransaction,
    operationId: string,
    batchId: string,
  ): Promise<{ effects: number }> {
    const members = await this.#pending(tx, batchId);
    const byType = new Map<string, string[]>();
    for (const m of members)
      byType.set(m.record_type, [...(byType.get(m.record_type) ?? []), m.record_id]);
    let n = 0;
    for (const [type, ids] of byType) {
      const hooks = this.#svc.deps.registry.get(type)?.purge;
      const keys = (
        await this.#timed('objects', async () => (await hooks?.objectKeys?.(tx, ids)) ?? [])
      ).sort();
      for (const key of keys) {
        if (!OBJECT_KEY.test(key)) throw new Error('object keys must be effect-key safe');
        await recordEffect(tx, {
          operationId,
          effectKey: `object:${key}`,
          destinationClass: 'naturally_idempotent',
        });
        n += 1;
      }
    }
    return { effects: n };
  }

  async projections(tx: WorkspaceTransaction, batchId: string): Promise<{ activity: number }> {
    const members = await this.#pending(tx, batchId);
    const byType = new Map<string, string[]>();
    for (const m of members)
      byType.set(m.record_type, [...(byType.get(m.record_type) ?? []), m.record_id]);
    for (const [type, ids] of byType) {
      const hooks = this.#svc.deps.registry.get(type)?.purge;
      if (hooks?.removeProjections)
        await this.#timed('projections', () => hooks.removeProjections!(tx, ids));
    }
    const activity = await this.#timed('activity', () =>
      removeActivity(
        tx,
        members.map((m) => m.record_id),
      ),
    );
    return { activity };
  }

  /** Explicit redaction of protected audit values (0B §7.7) through the guarded procedure. */
  async redact(
    tx: WorkspaceTransaction,
    operationId: string,
    batchId: string,
    cmd: CommandContext,
  ): Promise<{ events: number }> {
    await sql`SELECT set_config('app.redaction_operation_id', ${operationId}, true)`.execute(tx.db);
    const r = await this.#timed('redaction', () =>
      sql<{ n: number }>`SELECT audit.redact_purged_values(${operationId}::uuid, ${batchId}::uuid,
        ${cmd.actor.type}::exec.actor_type, ${cmd.actor.id}::uuid, ${cmd.correlationId}::uuid) AS n`.execute(
        tx.db,
      ),
    );
    await sql`SELECT set_config('app.redaction_operation_id', '', true)`.execute(tx.db);
    const events = r.rows[0]?.n ?? 0;
    if (events) this.#svc.deps.metrics.count('audit.redactions', events, { reason: 'purge' });
    return { events };
  }

  /** Durable ledger append; the purge cannot complete without this acknowledgement. */
  async appendLedger(entry: PurgeLedgerEntry): Promise<LedgerAck> {
    try {
      const ack = await this.#ledger.append(entry);
      this.#svc.deps.metrics.count('purge.ledger.acknowledgements', 1, { outcome: 'ok' });
      return ack;
    } catch (err) {
      this.#svc.deps.metrics.count('purge.ledger.acknowledgements', 1, { outcome: 'error' });
      throw err;
    }
  }

  async ledgerEntry(
    tx: WorkspaceTransaction,
    operationId: string,
    batchId: string,
  ): Promise<PurgeLedgerEntry> {
    const batch = await tx.db
      .selectFrom('core.deletion_batch')
      .select(['id', 'root_record_id', 'trashed_at'])
      .where('id', '=', batchId)
      .executeTakeFirstOrThrow();
    const members = await this.#pending(tx, batchId);
    return validateLedgerEntry({
      entryId: `purge:${batchId}`,
      workspaceId: tx.workspaceId,
      batchId,
      rootRecordId: batch.root_record_id,
      operationId,
      records: members.map((m) => ({ id: m.record_id, recordType: m.record_type })),
      trashedAt: batch.trashed_at.toISOString(),
      purgedAt: new Date().toISOString(),
    });
  }

  /** Converts envelopes to tombstones and completes the batch with the ledger acknowledgement. */
  async tombstone(
    tx: WorkspaceTransaction,
    cmd: CommandContext,
    exec: ExecutionContext,
    batchId: string,
    ack: LedgerAck,
  ): Promise<{ purged: number }> {
    const batch = await tx.db
      .selectFrom('core.deletion_batch')
      .select(['id', 'state', 'version', 'evidence_locked_count'])
      .where('id', '=', batchId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (batch.state === 'purged') return { purged: 0 };
    if (batch.state !== 'purging') throw new LifecycleError('concurrent_change');
    const members = await tx.db
      .selectFrom('core.deletion_batch_member as m')
      .innerJoin('core.record as r', 'r.id', 'm.record_id')
      .select([
        'r.id',
        'r.public_id',
        'r.record_type',
        'r.brand_id',
        'r.lifecycle_state',
        'r.version',
      ])
      .where('m.batch_id', '=', batchId)
      .where('m.outcome', '=', 'pending')
      .orderBy('r.id')
      .forUpdate()
      .execute();
    const now = new Date();
    for (const m of members) {
      if (m.lifecycle_state !== 'trashed') throw new LifecycleError('concurrent_change');
      const version = Number(m.version) + 1;
      await tx.db
        .updateTable('core.record')
        .set({
          lifecycle_state: 'purged',
          purged_at: now,
          prior_lifecycle_state: null,
          owner_membership_id: null,
          source_ref: null,
          template_installation_id: null,
          archive_cause: null,
          archive_batch_id: null,
          archived_at: null,
          archived_by_type: null,
          archived_by_id: null,
          version: String(version),
        })
        .where('id', '=', m.id)
        .execute();
      await tx.db
        .updateTable('core.deletion_batch_member')
        .set({ outcome: 'purged' })
        .where('batch_id', '=', batchId)
        .where('record_id', '=', m.id)
        .execute();
      await this.#svc.deps.writer.write(tx, cmd, {
        action: 'record.purged',
        target: { recordId: m.id, type: m.record_type, publicId: m.public_id },
        changes: [change.plain('lifecycle_state', 'trashed', 'purged')],
      });
      await writeOutboxEvent(tx, {
        type: 'core.record.purged',
        aggregate: { type: 'core.record', id: m.id, sequence: version },
        data: { record_type: m.record_type },
        actor: { type: cmd.actor.type, ...(cmd.actor.id ? { id: cmd.actor.id } : {}) },
        context: exec,
        ...(m.brand_id ? { brandId: m.brand_id } : {}),
      });
    }
    await tx.db
      .updateTable('core.deletion_batch')
      .set({
        state: 'purged',
        purged_at: now,
        ledger_entry_id: ack.entryId,
        ledger_acknowledged_at: ack.acknowledgedAt,
        terminal_outcome: batch.evidence_locked_count > 0 ? 'purged_with_exclusions' : 'purged',
        version: String(Number(batch.version) + 1),
      })
      .where('id', '=', batchId)
      .execute();
    this.#svc.deps.metrics.count('lifecycle.transitions', members.length, {
      transition: 'purge',
      outcome: 'ok',
    });
    return { purged: members.length };
  }
}

const BATCH_REF = /^deletion_batch:([0-9a-f-]{36})$/;

/** The purge job: one checkpointed step per phase; the ledger append is an effect (never repeated). */
export function purgeJobHandler(executor: PurgeExecutor): JobHandler {
  return {
    kind: PURGE_JOB_KIND,
    queue: PURGE_QUEUE,
    maxAttempts: 10,
    timeoutMs: 600_000,
    async handle(ctx) {
      const m = BATCH_REF.exec(ctx.job.payloadRef ?? '');
      const operationId = ctx.job.operationId;
      if (!m || !operationId) throw new Error('purge job needs a batch reference and an operation');
      const batchId = m[1]!;
      const cmd = CommandContext.fromExecution(ctx.context, {
        kind: 'system',
        ref: 'purge',
      }).withOperation(operationId, ctx.job.attemptId ?? null);
      const tx = (t: unknown) => t as WorkspaceTransaction;
      const begin = await ctx.step('begin', async (t) => ({
        result: await executor.begin(tx(t), operationId, batchId, cmd),
      }));
      if (begin.result.status === 'done') return { state: 'succeeded' };
      if (begin.result.status === 'blocked')
        return { state: 'partial', result: { blocked: begin.result.reason } };
      await ctx.step('content', (t) => executor.content(tx(t), batchId));
      await ctx.step('effects', (t) => executor.effects(tx(t), operationId, batchId));
      await ctx.step('projections', (t) => executor.projections(tx(t), batchId));
      await ctx.step('redact', (t) => executor.redact(tx(t), operationId, batchId, cmd));
      const { entry } = await ctx.step('ledger_entry', async (t) => ({
        entry: await executor.ledgerEntry(tx(t), operationId, batchId),
      }));
      const sent = await ctx.effect(
        `purge-ledger:${batchId}`,
        'idempotent_by_provider',
        async () => {
          const ack = await executor.appendLedger(entry);
          return { externalRef: ack.acknowledgedAt.toISOString() };
        },
      );
      const ack: LedgerAck = {
        entryId: entry.entryId,
        acknowledgedAt: new Date(sent.externalRef!),
      };
      await ctx.step('tombstone', (t) => executor.tombstone(tx(t), cmd, ctx.context, batchId, ack));
      const excluded = begin.result.excluded;
      return excluded > 0 ? { state: 'partial', result: { excluded } } : { state: 'succeeded' };
    },
  };
}

export interface SchedulerDeps {
  svc: LifecycleService;
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  /** The worker's system principal id (scheduled purges run as the system). */
  systemPrincipalId: string;
}

export const LIFECYCLE_JOB_KINDS = {
  purge: PURGE_JOB_KIND,
  purgeScheduler: 'lifecycle.purge_scheduler',
  tombstoneSweep: 'lifecycle.tombstone_sweep',
} as const;

/**
 * Retention purge scheduler (platform job). Selects only batches whose recovery period has passed;
 * with no decided period (platform default and workspace value both unset) it enqueues nothing.
 */
export function purgeSchedulerHandler(d: SchedulerDeps): JobHandler {
  return {
    kind: LIFECYCLE_JOB_KINDS.purgeScheduler,
    queue: 'maintenance',
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle(ctx) {
      const platform = d.svc.deps.retention.platformPeriodMs('R-LIVE');
      const due = await d.discovery.discoverPurgeDue(platform, 200);
      for (const s of await d.discovery.purgeBacklog())
        d.svc.deps.metrics.gauge('purge.backlog', s.batches, { state: s.state });
      d.svc.deps.metrics.count('retention.scheduler.runs', 1, {
        policy: 'R-LIVE',
        outcome: due.length ? 'enqueued' : platform === null ? 'disabled' : 'idle',
      });
      for (const item of due) {
        const exec: ExecutionContext = { ...ctx.context, workspaceId: item.workspaceId };
        await d.tenant.withWorkspace(item.workspaceId, { module: 'lifecycle' }, (tx) =>
          d.svc.requestPurge(
            tx,
            systemDecision('record.purge', item.workspaceId, d.systemPrincipalId),
            { exec, source: { kind: 'system', ref: 'retention' } },
            item.batchId,
          ),
        );
      }
    },
  };
}

/**
 * Final tombstone sweep (0B §8.7): a retention hook that stays disabled until the audit retention
 * period (R-AUDIT, OD-36) is decided. Its deletion rules (with batch history) belong to the phase
 * that sets that period, so a configured value is reported, not acted on.
 */
export function tombstoneSweepHandler(d: SchedulerDeps): JobHandler {
  return {
    kind: LIFECYCLE_JOB_KINDS.tombstoneSweep,
    queue: 'maintenance',
    maxAttempts: 1,
    timeoutMs: 60_000,
    handle(ctx) {
      const period = d.svc.deps.retention.platformPeriodMs('R-AUDIT');
      d.svc.deps.metrics.count('retention.scheduler.runs', 1, {
        policy: 'R-AUDIT',
        outcome: period === null ? 'disabled' : 'not_enabled',
      });
      if (period !== null)
        ctx.logger.warn('tombstone_sweep.not_enabled', {
          component: 'lifecycle',
          reason: 'sweep_rules_pending',
        });
      return Promise.resolve();
    },
  };
}

export const LIFECYCLE_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: LIFECYCLE_JOB_KINDS.purgeScheduler,
    queue: 'maintenance',
    intervalMs: 15 * 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
  {
    kind: LIFECYCLE_JOB_KINDS.tombstoneSweep,
    queue: 'maintenance',
    intervalMs: 24 * 60 * 60_000,
    maxAttempts: 1,
    timeoutSeconds: 60,
  },
];
