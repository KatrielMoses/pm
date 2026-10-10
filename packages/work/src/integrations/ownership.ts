import { sql } from '@pm/db';
import type { OwnershipHook } from '@pm/tenancy';

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
