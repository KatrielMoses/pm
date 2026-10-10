import { sql, type WorkspaceTransaction } from '@pm/db';
import type { RecordRef, RecordTypeAdapter } from '@pm/lifecycle';

const refs = (rows: Array<{ id: string }>, recordType: string): RecordRef[] =>
  rows.map((r) => ({ id: r.id, recordType }));

/** Brand-scoped connections are brand roots. Workspace connections belong to no brand. */
export const connectionAdapter: RecordTypeAdapter = {
  recordType: 'connection',
  children: () => Promise.resolve([]),
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('integrations.connection')
      .select('id')
      .where('brand_id', 'in', [...brandIds])
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return refs(rows, 'connection');
  },
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('integrations.connection')
      .select('brand_id')
      .where('id', '=', recordId)
      .executeTakeFirst();
    if (!r) return null;
    return r.brand_id ? { id: r.brand_id, recordType: 'brand' } : null;
  },
  purge: {
    async deleteContent(tx, recordIds) {
      const ids = [...recordIds];
      const refs = await tx.db
        .selectFrom('integrations.connection')
        .select('credential_secret_ref')
        .where('id', 'in', ids)
        .execute();
      await tx.db
        .deleteFrom('integrations.sync_conflict')
        .where('connection_id', 'in', ids)
        .execute();
      await tx.db
        .deleteFrom('integrations.sync_delivery')
        .where('connection_id', 'in', ids)
        .execute();
      await tx.db.deleteFrom('integrations.sync_run').where('connection_id', 'in', ids).execute();
      await tx.db
        .deleteFrom('integrations.external_identity')
        .where('connection_id', 'in', ids)
        .execute();
      await tx.db
        .deleteFrom('integrations.sync_checkpoint')
        .where('connection_id', 'in', ids)
        .execute();
      await tx.db.deleteFrom('integrations.connection').where('id', 'in', ids).execute();
      for (const row of refs) {
        if (!row.credential_secret_ref) continue;
        await sql`DELETE FROM ops.dev_secret_vault WHERE ref = ${row.credential_secret_ref}`.execute(
          tx.db,
        );
      }
    },
  },
};

export async function purgeConnectionSecrets(
  tx: WorkspaceTransaction,
  recordIds: readonly string[],
): Promise<void> {
  await connectionAdapter.purge!.deleteContent(tx, recordIds);
}
