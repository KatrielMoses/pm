import type { WorkspaceTransaction } from '@pm/db';
import type { InternalEvent } from '@pm/platform';

/**
 * Which canonical record governs a public webhook event (ADR-0037 W1). A delivery is authorized at
 * send against this record as the subscription's accountable owner; the object it names is the
 * public domain object the event is about. Event types whose source has no canonical contract in
 * this phase are `unsupported`: they are recorded and skipped at send, never delivered on brand
 * access alone.
 */
export type WebhookObjectKind = 'record' | 'comment' | 'review_request' | 'unsupported';

export interface WebhookSource {
  kind: WebhookObjectKind;
  /** The object's internal id (record, comment, or review request), or null when unsupported. */
  objectId: string | null;
  /** The record whose visibility governs the delivery, or null when unsupported. */
  sourceId: string | null;
}

/**
 * Lifecycle events about a record leaving active use. They describe a record that may no longer
 * be readable as active, so they are authorized against the record's placement (workspace, brand,
 * project, and shares) as if it were active: the type-specific tombstone contract. Purge has no
 * public event.
 */
export const WEBHOOK_TOMBSTONES: ReadonlySet<string> = new Set([
  'record.archived',
  'record.trashed',
]);

const RECORD_EVENTS = new Set([
  'record.archived',
  'record.trashed',
  'record.restored',
  'task.created',
  'task.updated',
  'task.status_changed',
  'task.completed',
  'task.assigned',
  'project.created',
  'project.status_changed',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOf = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

const unsupported: WebhookSource = { kind: 'unsupported', objectId: null, sourceId: null };

export async function webhookSource(
  tx: WorkspaceTransaction,
  publicType: string,
  event: InternalEvent,
): Promise<WebhookSource> {
  const data = event.data ?? {};
  if (RECORD_EVENTS.has(publicType)) {
    const id = uuidOf(event.aggregate.id);
    return id ? { kind: 'record', objectId: id, sourceId: id } : unsupported;
  }
  switch (publicType) {
    case 'deliverable.submitted': {
      const id = uuidOf(data.deliverable_id);
      return id ? { kind: 'record', objectId: id, sourceId: id } : unsupported;
    }
    case 'comment.created': {
      const comment = uuidOf(event.aggregate.id);
      const host = uuidOf(data.host_record_id);
      return comment && host ? { kind: 'comment', objectId: comment, sourceId: host } : unsupported;
    }
    case 'review.requested': {
      const request = uuidOf(event.aggregate.id);
      const subject = uuidOf(data.subject_ref);
      return request && subject
        ? { kind: 'review_request', objectId: request, sourceId: subject }
        : unsupported;
    }
    case 'review.decided': {
      const decision = uuidOf(event.aggregate.id);
      const subject = uuidOf(data.subject_ref);
      if (!decision || !subject) return unsupported;
      const row = await tx.db
        .selectFrom('collab.review_decision')
        .select('review_request_id')
        .where('id', '=', decision)
        .executeTakeFirst();
      return row
        ? { kind: 'review_request', objectId: row.review_request_id, sourceId: subject }
        : unsupported;
    }
    default:
      // operation.finished, agent_run.output_returned, test_result.recorded, defect.verified,
      // release.decided, deployment.recorded: their canonical sources arrive with their phases.
      return unsupported;
  }
}
