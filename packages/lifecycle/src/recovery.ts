import { CommandContext } from '@pm/audit';
import type { ExecutionContext } from '@pm/contracts';
import type { PlatformDatabase, TenantDatabase, WorkspaceTransaction } from '@pm/db';
import { createOperation, transitionOperation } from '@pm/platform';
import type { LifecycleService } from './commands.ts';
import type { PurgeLedgerEntry } from './ledger.ts';
import type { PurgeExecutor } from './purge.ts';

/**
 * Post-restore purge-ledger replay (0B §8.11). A restored database does not contain purges that
 * completed after its backup point. The restore runbook (11C) therefore:
 *
 *   1. `markRestored(owner, backupPoint)`   → ops.recovery_gate = replay_required (readiness fails)
 *   2. `replayPurgeLedger(...)`             → re-applies every ledger entry newer than the point
 *   3. `reopen(owner)`                      → gate open only if no entry newer than the point
 *                                             remains unapplied
 *
 * Steps 1 and 3 run as restore_operator (SET ROLE pm_owner); step 2 uses the worker identity in
 * one workspace transaction per entry. Provider restore automation itself is Phase 11C.
 */

export interface GateState {
  state: 'open' | 'replay_required';
  backupPoint: Date | null;
}

export async function readRecoveryGate(db: PlatformDatabase): Promise<GateState> {
  return db.withPlatform({ module: 'lifecycle', readOnly: true }, async (tx) => {
    const row = await tx.db
      .selectFrom('ops.recovery_gate')
      .select(['state', 'backup_point'])
      .where('id', '=', 1)
      .executeTakeFirst();
    return { state: row?.state ?? 'replay_required', backupPoint: row?.backup_point ?? null };
  });
}

/** Minimal client for the restore identity (pg.Client compatible). */
export interface OwnerClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export async function markRestored(owner: OwnerClient, backupPoint: Date): Promise<void> {
  await owner.query('BEGIN');
  try {
    await owner.query('SET LOCAL ROLE pm_owner');
    await owner.query(
      `UPDATE ops.recovery_gate SET state = 'replay_required', backup_point = $1, replayed_through = NULL, updated_at = now() WHERE id = 1`,
      [backupPoint],
    );
    await owner.query('COMMIT');
  } catch (err) {
    await owner.query('ROLLBACK');
    throw err;
  }
}

/** Opens the gate; refuses while entries newer than the backup point are not applied. */
export async function reopen(
  owner: OwnerClient,
  pendingEntries: number,
  replayedThrough: Date | null,
): Promise<void> {
  if (pendingEntries > 0)
    throw new Error('purge ledger replay incomplete; environment stays closed');
  await owner.query('BEGIN');
  try {
    await owner.query('SET LOCAL ROLE pm_owner');
    await owner.query(
      `UPDATE ops.recovery_gate SET state = 'open', replayed_through = $1, updated_at = now() WHERE id = 1`,
      [replayedThrough],
    );
    await owner.query('COMMIT');
  } catch (err) {
    await owner.query('ROLLBACK');
    throw err;
  }
}

export interface ReplayDeps {
  tenant: TenantDatabase;
  svc: LifecycleService;
  executor: PurgeExecutor;
  /** System execution context template (the workspace is substituted per entry). */
  systemContext: ExecutionContext;
}

export interface ReplayResult {
  applied: number;
  skipped: number;
  pending: number;
  replayedThrough: Date | null;
}

/** Re-applies one ledger entry inside a workspace transaction. Idempotent. */
export async function replayEntry(
  tx: WorkspaceTransaction,
  d: ReplayDeps,
  entry: PurgeLedgerEntry & { acknowledgedAt: string },
): Promise<'applied' | 'skipped'> {
  const exec: ExecutionContext = { ...d.systemContext, workspaceId: tx.workspaceId };
  const batch = await tx.db
    .selectFrom('core.deletion_batch')
    .select(['id', 'state', 'version'])
    .where('id', '=', entry.batchId)
    .forUpdate()
    .executeTakeFirst();
  if (batch?.state === 'purged') return 'skipped';
  const ids = entry.records.map((r) => r.id);
  const present = await tx.db
    .selectFrom('core.record')
    .select(['id', 'record_type', 'lifecycle_state', 'deletion_batch_id', 'version'])
    .where('id', 'in', ids)
    .orderBy('id')
    .forUpdate()
    .execute();
  const live = present.filter((r) => r.lifecycle_state !== 'purged');
  if (!live.length) return 'skipped';
  const cmd = CommandContext.fromExecution(exec, { kind: 'system', ref: 'ledger_replay' });
  const op = await createOperation(tx, {
    kind: 'purge',
    context: exec,
    initiatedBy: { type: 'system' },
    dedupeKey: `purge-replay:${entry.batchId}`,
  });
  await transitionOperation(tx, {
    operationId: op.id,
    to: 'running',
    actor: { type: 'system' },
    context: exec,
  });
  const version = batch ? Number(batch.version) : 0;
  if (!batch) {
    // The trash itself happened after the backup point: rebuild the batch from the ledger facts.
    await tx.db
      .insertInto('core.deletion_batch')
      .values({
        id: entry.batchId,
        workspace_id: tx.workspaceId,
        root_record_id: live.some((r) => r.id === entry.rootRecordId)
          ? entry.rootRecordId
          : live[0]!.id,
        trashed_at: entry.trashedAt,
        trashed_by_type: 'system',
        trashed_by_id: null,
        restore_location: JSON.stringify({}),
        member_count: live.length,
        correlation_id: cmd.correlationId,
      })
      .execute();
    for (const r of live) {
      if (r.lifecycle_state !== 'trashed')
        await tx.db
          .updateTable('core.record')
          .set({
            lifecycle_state: 'trashed',
            prior_lifecycle_state: r.lifecycle_state,
            deletion_batch_id: entry.batchId,
            trashed_at: entry.trashedAt,
            trashed_by_type: 'system',
            trashed_by_id: null,
            version: String(Number(r.version) + 1),
          })
          .where('id', '=', r.id)
          .execute();
      else {
        // Trashed in another (restored-database) batch: that membership moves to this one.
        if (r.deletion_batch_id)
          await tx.db
            .updateTable('core.deletion_batch_member')
            .set({ outcome: 'moved_to_successor', successor_batch_id: entry.batchId })
            .where('batch_id', '=', r.deletion_batch_id)
            .where('record_id', '=', r.id)
            .where('outcome', '=', 'pending')
            .execute();
        await tx.db
          .updateTable('core.record')
          .set({ deletion_batch_id: entry.batchId, version: String(Number(r.version) + 1) })
          .where('id', '=', r.id)
          .execute();
      }
      await tx.db
        .insertInto('core.deletion_batch_member')
        .values({
          workspace_id: tx.workspaceId,
          batch_id: entry.batchId,
          record_id: r.id,
          record_type: r.record_type,
          prior_lifecycle_state: r.lifecycle_state === 'archived' ? 'archived' : 'active',
          depth: 0,
        })
        .execute();
    }
  }
  await tx.db
    .updateTable('core.deletion_batch')
    .set({
      state: 'purging',
      operation_id: op.id,
      purge_started_at: new Date(),
      version: String(version + 1),
    })
    .where('id', '=', entry.batchId)
    .where('state', 'in', ['trashed', 'purging'])
    .execute();
  const opCmd = cmd.withOperation(op.id, null);
  await d.executor.content(tx, entry.batchId);
  await d.executor.effects(tx, op.id, entry.batchId);
  await d.executor.projections(tx, entry.batchId);
  await d.executor.redact(tx, op.id, entry.batchId, opCmd);
  await d.executor.tombstone(tx, opCmd, exec, entry.batchId, {
    entryId: entry.entryId,
    acknowledgedAt: new Date(entry.acknowledgedAt),
  });
  await transitionOperation(tx, {
    operationId: op.id,
    to: 'succeeded',
    actor: { type: 'system' },
    context: exec,
  });
  d.svc.deps.metrics.count('lifecycle.transitions', 1, {
    transition: 'ledger_replay',
    outcome: 'ok',
  });
  return 'applied';
}

export async function replayPurgeLedger(d: ReplayDeps, backupPoint: Date): Promise<ReplayResult> {
  const entries = await d.executor.ledger.entriesAfter(backupPoint);
  let applied = 0;
  let skipped = 0;
  let replayedThrough: Date | null = null;
  for (const entry of entries) {
    const outcome = await d.tenant.withWorkspace(entry.workspaceId, { module: 'lifecycle' }, (tx) =>
      replayEntry(tx, d, entry),
    );
    if (outcome === 'applied') applied += 1;
    else skipped += 1;
    replayedThrough = new Date(entry.purgedAt);
  }
  return { applied, skipped, pending: 0, replayedThrough };
}
