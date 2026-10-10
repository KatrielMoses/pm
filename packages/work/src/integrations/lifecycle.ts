import type { WorkspaceTransaction } from '@pm/db';
import type { RecordRef, RecordTypeAdapter } from '@pm/lifecycle';

const refs = (rows: Array<{ id: string }>): RecordRef[] =>
  rows.map((r) => ({ id: r.id, recordType: 'webhook_subscription' }));

/** Outbound subscriptions placed on a brand leave with that brand. */
export const webhookSubscriptionAdapter: RecordTypeAdapter = {
  recordType: 'webhook_subscription',
  children: () => Promise.resolve([]),
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('integrations.webhook_subscription')
      .select('id')
      .where('brand_id', 'in', [...brandIds])
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return refs(rows);
  },
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('integrations.webhook_subscription')
      .select('brand_id')
      .where('id', '=', recordId)
      .executeTakeFirst();
    return r?.brand_id ? { id: r.brand_id, recordType: 'brand' } : null;
  },
  purge: {
    async deleteContent(tx: WorkspaceTransaction, recordIds) {
      const ids = [...recordIds];
      await tx.db
        .deleteFrom('integrations.webhook_delivery')
        .where('subscription_id', 'in', ids)
        .execute();
      await tx.db.deleteFrom('integrations.webhook_subscription').where('id', 'in', ids).execute();
    },
  },
};
