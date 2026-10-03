import { isUuidV7, newUuidV7 } from '@pm/contracts';
import type { StoredChange, WorkspaceTransaction } from '@pm/db';
import type { Logger, Metrics } from '@pm/observability';
import { sql } from '@pm/db';
import { chainHash, GENESIS_HASH, type ChainedEvent } from './chain.ts';
import { validateChanges } from './changes.ts';
import type { CommandContext } from './command.ts';

/**
 * Same-transaction audit writer (0D §12.2). The event is written in the caller's workspace
 * transaction through the chain head lock; if anything fails, the error propagates and the
 * caller's mutation rolls back with it. Failures emit `audit.write_failures` (alert) and a
 * content-free log line.
 */

export class AuditWriteError extends Error {
  readonly code = 'internal_error';
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`audit write failed: ${reason}`, options);
    this.name = 'AuditWriteError';
  }
}

export interface AuditTarget {
  /** Internal record id (no foreign key: survives purge). */
  recordId: string | null;
  type: string;
  publicId: string | null;
}

export interface AuditEventInput {
  /** `<resource>.<verb>`, e.g. `record.trashed`. */
  action: string;
  target: AuditTarget;
  /** Classified, digested entries from `diffChanges`/`change.*`; empty for non-field events. */
  changes?: StoredChange[];
  workflowRevisionId?: string;
}

const ACTION = /^[a-z_]+\.[a-z_]+$/;
const TARGET_TYPE = /^[a-z_]{1,64}$/;
/** Format only, like the database check: record-type prefixes live in core.record_type. */
const PUBLIC_ID = /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/;

export interface AuditWriterDeps {
  /** Owning module, used as the only metric label. */
  module: string;
  logger: Logger;
  metrics: Metrics;
  /**
   * Operational threshold for waiting on the workspace chain lock (AUDIT_CHAIN_LOCK_WAIT_WARN_MS).
   * Above it a write counts `audit.chain.lock_wait_exceeded` and logs a content-free warning.
   * Not a product promise.
   */
  lockWaitWarnMs?: number;
}

/** Default chain-lock wait threshold (ms); configuration overrides it. */
export const DEFAULT_CHAIN_LOCK_WAIT_WARN_MS = 250;

export class AuditWriter {
  readonly #d: AuditWriterDeps;

  constructor(deps: AuditWriterDeps) {
    if (!/^[a-z_]{1,40}$/.test(deps.module)) throw new Error('audit writer module name');
    this.#d = deps;
  }

  /** Writes one event in `tx`. Returns its id. Throws AuditWriteError (caller's tx must fail). */
  async write(
    tx: WorkspaceTransaction,
    cmd: CommandContext,
    input: AuditEventInput,
  ): Promise<string> {
    const started = performance.now();
    let outcome: 'ok' | 'error' = 'error';
    try {
      if (cmd.workspaceId !== tx.workspaceId)
        throw new AuditWriteError('command workspace mismatch');
      if (!ACTION.test(input.action) || input.action.length > 80)
        throw new AuditWriteError('action');
      if (!TARGET_TYPE.test(input.target.type)) throw new AuditWriteError('target type');
      if (input.target.recordId !== null && !isUuidV7(input.target.recordId))
        throw new AuditWriteError('target record');
      if (input.target.publicId !== null && !PUBLIC_ID.test(input.target.publicId))
        throw new AuditWriteError('target public id');
      const changes = validateChanges(input.changes ?? []);

      // Serialize the workspace chain until commit, then read the head and the statement clock.
      // The wait is measured on its own: it is the per-workspace serialization cost (ADR-0009 G2).
      const waitStart = performance.now();
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'audit.chain:' + tx.workspaceId}, 0))`.execute(
        tx.db,
      );
      this.#recordLockWait(tx.workspaceId, performance.now() - waitStart);
      const head = await sql<{ chain_seq: string | null; hash: Buffer | null; now: Date }>`
        SELECT (SELECT e.chain_seq FROM audit.audit_event e WHERE e.workspace_id = ${tx.workspaceId}
                ORDER BY e.chain_seq DESC LIMIT 1) AS chain_seq,
               (SELECT e.hash FROM audit.audit_event e WHERE e.workspace_id = ${tx.workspaceId}
                ORDER BY e.chain_seq DESC LIMIT 1) AS hash,
               clock_timestamp() AS now`.execute(tx.db);
      const h = head.rows[0]!;
      const prev = h.hash ?? GENESIS_HASH;
      const event: ChainedEvent = {
        id: newUuidV7(),
        // Millisecond precision so the stored value and the hashed value are identical.
        occurred_at: new Date(h.now.getTime()),
        workspace_id: tx.workspaceId,
        brand_id: cmd.brandId,
        action: input.action,
        actor_type: cmd.actor.type,
        actor_id: cmd.actor.id,
        on_behalf_of_membership_id: cmd.actor.onBehalfOfMembershipId,
        delegation_chain: cmd.delegationChain,
        target_record_id: input.target.recordId,
        target_type: input.target.type,
        target_public_id: input.target.publicId,
        changes,
        operation_id: cmd.operationId,
        attempt_id: cmd.attemptId,
        correlation_id: cmd.correlationId,
        causation_id: cmd.causationId,
        source_kind: cmd.source.kind,
        source_ref: cmd.source.ref ?? null,
        workflow_revision_id: input.workflowRevisionId ?? null,
        retention_class: 'R-AUDIT',
        chain_seq: String(BigInt(h.chain_seq ?? '0') + 1n),
      };
      const hash = chainHash(prev, event);
      await tx.db
        .insertInto('audit.audit_event')
        .values({
          ...event,
          retention_class: 'R-AUDIT',
          delegation_chain: JSON.stringify(event.delegation_chain),
          changes: JSON.stringify(changes),
          chain_seq: String(event.chain_seq),
          prev_hash: prev,
          hash,
        })
        .execute();
      this.#d.metrics.count('audit.writes', 1, { module: this.#d.module });
      outcome = 'ok';
      return event.id;
    } catch (err) {
      this.#d.metrics.count('audit.write_failures', 1, { module: this.#d.module });
      this.#d.logger.error('audit.write_failed', {
        component: 'audit',
        workspace_id: tx.workspaceId,
        error_class: err instanceof Error ? err.name : 'unknown',
        ...(cmd.operationId ? { operation_id: cmd.operationId } : {}),
      });
      throw err instanceof AuditWriteError ? err : new AuditWriteError('insert', { cause: err });
    } finally {
      this.#d.metrics.record('audit.write.duration', performance.now() - started, {
        module: this.#d.module,
        outcome,
      });
    }
  }

  #recordLockWait(workspaceId: string, waitedMs: number): void {
    this.#d.metrics.record('audit.chain.lock_wait', waitedMs, { module: this.#d.module });
    const threshold = this.#d.lockWaitWarnMs ?? DEFAULT_CHAIN_LOCK_WAIT_WARN_MS;
    if (waitedMs <= threshold) return;
    this.#d.metrics.count('audit.chain.lock_wait_exceeded', 1, { module: this.#d.module });
    // Content-free: which workspace waited and how long; never actions, targets, or values.
    this.#d.logger.warn('audit.chain_lock_wait_high', {
      component: 'audit',
      workspace_id: workspaceId,
      duration_ms: Math.round(waitedMs),
    });
  }
}
