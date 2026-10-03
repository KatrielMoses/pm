import type { ActorType } from '@pm/contracts';
import type { WorkspaceTransaction } from '@pm/db';

/**
 * Audit-ready metadata emitted by the execution foundation inside the domain transaction. Phase 1F
 * supplies the durable `audit.audit_event` writer; 1A only defines the hook so operations, jobs,
 * and outbox events already carry the references the audit record needs (0B §9.5).
 */
export interface AuditMetadata {
  actionKey: string;
  actorType: ActorType;
  actorId: string | undefined;
  workspaceId: string;
  operationId: string | undefined;
  correlationId: string;
  occurredAt: Date;
  /** Record references only (type + internal id); never values or content. */
  targets: ReadonlyArray<{ type: string; id: string }>;
}

export interface AuditSink {
  record(tx: WorkspaceTransaction, metadata: AuditMetadata): Promise<void>;
}

/** Default until 1F: accepts metadata without persisting it. */
export class DeferredAuditSink implements AuditSink {
  record(): Promise<void> {
    return Promise.resolve();
  }
}

/** Test sink proving the hook fires inside the same transaction as the change. */
export class CollectingAuditSink implements AuditSink {
  readonly records: AuditMetadata[] = [];

  record(_tx: WorkspaceTransaction, metadata: AuditMetadata): Promise<void> {
    this.records.push(metadata);
    return Promise.resolve();
  }
}
