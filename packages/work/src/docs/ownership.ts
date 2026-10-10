import { sql } from '@pm/db';
import type { OwnershipHook } from '@pm/tenancy';

/**
 * Departure (ADR-0025 D4): a departing member's documents move to the member chosen in the
 * departure plan, so no document is left without an owner who can act on it. Versions, suggestions,
 * and approvals the person made are history and stay under their name.
 */
export const documentOwnerHook: OwnershipHook = {
  key: 'document_owner',
  async plan(tx, membershipId) {
    const r = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM knowledge.document d
        JOIN core.record r ON r.workspace_id = d.workspace_id AND r.id = d.id
       WHERE d.owner_membership_id = ${membershipId} AND r.lifecycle_state <> 'purged'`.execute(tx.db);
    const owned = Number(r.rows[0]?.n ?? 0);
    return { hook: 'document_owner', owned, requiresAssignee: owned > 0 };
  },
  async apply(tx, from, to) {
    if (to === null) return 0;
    const r = await tx.db
      .updateTable('knowledge.document')
      .set({ owner_membership_id: to, version: sql`version + 1` })
      .where('owner_membership_id', '=', from)
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  },
};
