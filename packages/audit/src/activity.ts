import { newUuidV7, UUID_ANY_PATTERN, type InternalEventType } from '@pm/contracts';
import type { StoredChange, WorkspaceTransaction } from '@pm/db';
import type { InternalEvent, OutboxConsumer } from '@pm/platform';

/**
 * Activity projection foundation (0B §7.2): a rebuildable, display-safe projection of audit
 * events, written by an outbox consumer after the fact. Audit truth is already committed with the
 * mutation; the projection may lag and can be rebuilt from `audit.audit_event` at any time.
 *
 * Display safety: only `plain` values that are short scalars (and not internal UUIDs) are projected. `personal`, `content`,
 * `secret`, `credential_ref`, and redacted entries never appear. Field-level read policy is still
 * applied when items are read (1D); this is not the final Activity product view.
 */

const KEY = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_DISPLAY = 500;

export function displayValues(
  changes: ReadonlyArray<StoredChange>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const c of changes) {
    if (c.class !== 'plain' || c.redacted) continue;
    const v = c.new;
    const key = c.field.replace(/\./g, '_');
    if (!KEY.test(key)) continue;
    if (v === null || typeof v === 'boolean' || typeof v === 'number') out[key] = v as never;
    // Internal identifiers are structural facts for audit, never display values.
    else if (typeof v === 'string' && v.length <= MAX_DISPLAY && !UUID_ANY_PATTERN.test(v))
      out[key] = v;
  }
  return out;
}

/** Projects every not-yet-projected audit event of one target (idempotent). */
export async function projectActivity(
  tx: WorkspaceTransaction,
  targetRecordId: string,
): Promise<number> {
  const events = await tx.db
    .selectFrom('audit.audit_event as a')
    .select(['a.id', 'a.occurred_at', 'a.brand_id', 'a.action', 'a.changes', 'a.target_record_id'])
    .where('a.workspace_id', '=', tx.workspaceId)
    .where('a.target_record_id', '=', targetRecordId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('audit.activity_item as i')
            .select('i.id')
            .whereRef('i.audit_event_id', '=', 'a.id'),
        ),
      ),
    )
    .orderBy('a.chain_seq')
    .execute();
  let n = 0;
  for (const e of events) {
    const inserted = await tx.db
      .insertInto('audit.activity_item')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        brand_id: e.brand_id,
        project_id: null,
        target_record_id: targetRecordId,
        related_record_id: null,
        audit_event_id: e.id,
        occurred_at: e.occurred_at,
        summary_key: `activity.${e.action}`,
        display_values: JSON.stringify(displayValues(e.changes)),
        group_key: null,
      })
      .onConflict((oc) => oc.column('audit_event_id').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) n += 1;
  }
  return n;
}

/** Drops a target's projection (purge) or rebuilds it from audit truth. */
export async function removeActivity(
  tx: WorkspaceTransaction,
  targetRecordIds: readonly string[],
): Promise<number> {
  if (!targetRecordIds.length) return 0;
  const r = await tx.db
    .deleteFrom('audit.activity_item')
    .where('workspace_id', '=', tx.workspaceId)
    .where('target_record_id', 'in', targetRecordIds)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}

export async function rebuildActivity(
  tx: WorkspaceTransaction,
  targetRecordId: string,
): Promise<number> {
  await removeActivity(tx, [targetRecordId]);
  return projectActivity(tx, targetRecordId);
}

const LIFECYCLE_EVENTS: readonly InternalEventType[] = [
  'core.record.archived',
  'core.record.trashed',
  'core.record.restored',
  'core.record.purged',
];

/** Outbox consumer hook: lifecycle events trigger projection (purge removes it). */
export class ActivityProjector implements OutboxConsumer {
  readonly name = 'audit.activity_projector';
  readonly eventTypes = LIFECYCLE_EVENTS;

  async handle(tx: WorkspaceTransaction, event: InternalEvent): Promise<void> {
    if (event.type === 'core.record.purged') {
      await removeActivity(tx, [event.aggregate.id]);
      return;
    }
    await projectActivity(tx, event.aggregate.id);
  }
}
