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

/**
 * A departing member's outbound subscriptions and inbound endpoints stop. They are not handed to
 * someone who never agreed to sign what they send. Service tokens they answer for are suspended.
 */
export const webhookOwnerHook: OwnershipHook = {
  key: 'webhook_owner',
  async plan(tx, membershipId) {
    const r = await sql<{ n: string }>`
      SELECT (
        (SELECT count(*) FROM integrations.webhook_subscription
          WHERE accountable_owner_membership_id = ${membershipId} AND lifecycle_state <> 'purged')
        + (SELECT count(*) FROM integrations.inbound_endpoint
          WHERE accountable_owner_membership_id = ${membershipId} AND state = 'active')
      )::text AS n`.execute(tx.db);
    return { hook: 'webhook_owner', owned: Number(r.rows[0]?.n ?? 0), requiresAssignee: false };
  },
  async apply(tx, from, _to) {
    const subs = await sql`UPDATE integrations.webhook_subscription
      SET state = 'suspended', suspended_reason = 'owner_departed', suspended_at = now(), version = version + 1
      WHERE accountable_owner_membership_id = ${from} AND state = 'active'`.execute(tx.db);
    const ends = await sql`UPDATE integrations.inbound_endpoint
      SET state = 'suspended', suspended_reason = 'owner_departed', suspended_at = now(), version = version + 1
      WHERE accountable_owner_membership_id = ${from} AND state = 'active'`.execute(tx.db);
    await sql`UPDATE integrations.api_token
      SET state = 'suspended', version = version + 1
      WHERE accountable_owner_membership_id = ${from} AND kind = 'service' AND state = 'active'`.execute(
      tx.db,
    );
    return Number(subs.numAffectedRows ?? 0) + Number(ends.numAffectedRows ?? 0);
  },
};
