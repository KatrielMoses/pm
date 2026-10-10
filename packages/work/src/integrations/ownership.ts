import { sql } from '@pm/db';
import type { OwnershipHook } from '@pm/tenancy';

/**
 * Departure (ADR-0032): a connection moves to the chosen member, its secret is destroyed
 * immediately, and the successor must reauthorize. The secret is never handed on.
 */
export const connectionOwnerHook: OwnershipHook = {
  key: 'connection_owner',
  async plan(tx, membershipId) {
    const r = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM integrations.connection
       WHERE owner_membership_id = ${membershipId} AND lifecycle_state <> 'purged'
         AND health <> 'disconnected'`.execute(tx.db);
    const owned = Number(r.rows[0]?.n ?? 0);
    return { hook: 'connection_owner', owned, requiresAssignee: owned > 0 };
  },
  async apply(tx, from, to) {
    if (to === null) return 0;
    await sql`
      DELETE FROM ops.dev_secret_vault v
       USING integrations.connection c
       WHERE c.owner_membership_id = ${from}
         AND c.health <> 'disconnected'
         AND c.credential_secret_ref = v.ref`.execute(tx.db);
    const r = await sql`
      UPDATE integrations.connection
         SET credential_secret_ref = NULL,
             health = 'needs_reauthorization',
             outbound_paused = true,
             suspended_reason = 'owner_departed',
             suspended_at = now(),
             disconnected_at = NULL,
             retention_choice = NULL,
             owner_membership_id = ${to},
             version = version + 1
       WHERE owner_membership_id = ${from} AND lifecycle_state <> 'purged'
         AND health <> 'disconnected'`.execute(tx.db);
    return Number(r.numAffectedRows ?? 0);
  },
};
