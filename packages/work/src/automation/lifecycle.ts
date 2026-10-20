import type { WorkspaceTransaction } from '@pm/db';
import type { RecordRef, RecordTypeAdapter } from '@pm/lifecycle';

/** Purge content of automations: step runs, runs, approvals, schedules, revisions, the row. */
export async function purgeAutomations(tx: WorkspaceTransaction, ids: readonly string[]) {
  if (!ids.length) return;
  const runs = await tx.db
    .selectFrom('automation.automation_run')
    .select('id')
    .where('automation_id', 'in', ids)
    .execute();
  if (runs.length)
    await tx.db
      .deleteFrom('automation.automation_step_run')
      .where('run_id', 'in', runs.map((r) => r.id))
      .execute();
  await tx.db.deleteFrom('automation.automation_run').where('automation_id', 'in', ids).execute();
  await tx.db.deleteFrom('automation.standing_approval').where('automation_id', 'in', ids).execute();
  await tx.db.deleteFrom('automation.trigger_schedule').where('automation_id', 'in', ids).execute();
  await tx.db
    .updateTable('automation.automation')
    .set({ active_revision_id: null, enabled: false, trigger_event: null })
    .where('id', 'in', ids)
    .execute();
  await tx.db.deleteFrom('automation.automation_revision').where('automation_id', 'in', ids).execute();
  await tx.db.deleteFrom('automation.automation').where('id', 'in', ids).execute();
}

const refs = (rows: Array<{ id: string }>): RecordRef[] =>
  rows.map((r) => ({ id: r.id, recordType: 'automation' }));

/**
 * Automations (8A) are brand roots when brand-scoped; workspace automations belong to no brand.
 * Purge removes run history, approvals, schedules, and revisions before the definition; the
 * operations of past runs stay in the execution history like any other operation.
 */
export const automationAdapter: RecordTypeAdapter = {
  recordType: 'automation',
  children: () => Promise.resolve([]),
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('automation.automation')
      .select('id')
      .where('brand_id', 'in', [...brandIds])
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return refs(rows);
  },
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('automation.automation')
      .select('brand_id')
      .where('id', '=', recordId)
      .executeTakeFirst();
    if (!r) return null;
    return r.brand_id ? { id: r.brand_id, recordType: 'brand' } : null;
  },
  purge: {
    async deleteContent(tx, recordIds) {
      await purgeAutomations(tx, [...recordIds]);
    },
  },
};
