import type { WorkspaceTransaction } from '@pm/db';

/**
 * A purged record's notification facts (ADR-0024 D9): notifications about it with their deliveries,
 * and preferences or defaults scoped to it. A digest keeps only counts, so nothing about the
 * record remains.
 */
export async function purgeNotifyFacts(
  tx: WorkspaceTransaction,
  recordIds: readonly string[],
): Promise<void> {
  const ids = [...recordIds];
  if (!ids.length) return;
  const rows = await tx.db
    .selectFrom('notify.notification')
    .select('id')
    .where('record_id', 'in', ids)
    .execute();
  const notifications = rows.map((r) => r.id);
  if (notifications.length) {
    await tx.db
      .deleteFrom('notify.delivery')
      .where('notification_id', 'in', notifications)
      .execute();
    await tx.db.deleteFrom('notify.notification').where('id', 'in', notifications).execute();
  }
  await tx.db.deleteFrom('notify.preference').where('scope_record_id', 'in', ids).execute();
  await tx.db.deleteFrom('notify.scope_default').where('scope_record_id', 'in', ids).execute();
}
