import { sql } from '@pm/db';
import type { OwnershipHook } from '@pm/tenancy';

/**
 * Departure (ADR-0028 G10): a departing member's goals, key results, and portfolios move to the
 * member chosen in the departure plan, so none is left without an owner who can act on it.
 * Check-ins the person wrote are history and stay under their name.
 */
export const goalOwnerHook: OwnershipHook = {
  key: 'goal_owner',
  async plan(tx, membershipId) {
    const r = await sql<{ n: string }>`
      SELECT (
        (SELECT count(*) FROM goals.goal WHERE owner_membership_id = ${membershipId} AND lifecycle_state <> 'purged')
      + (SELECT count(*) FROM goals.key_result WHERE owner_membership_id = ${membershipId} AND lifecycle_state <> 'purged')
      + (SELECT count(*) FROM goals.portfolio WHERE owner_membership_id = ${membershipId} AND lifecycle_state <> 'purged')
      )::text AS n`.execute(tx.db);
    const owned = Number(r.rows[0]?.n ?? 0);
    return { hook: 'goal_owner', owned, requiresAssignee: owned > 0 };
  },
  async apply(tx, from, to) {
    if (to === null) return 0;
    let n = 0;
    for (const table of ['goals.goal', 'goals.key_result', 'goals.portfolio'] as const) {
      const r = await tx.db
        .updateTable(table)
        .set({ owner_membership_id: to, version: sql`version + 1` } as never)
        .where('owner_membership_id', '=', from)
        .executeTakeFirst();
      n += Number(r.numUpdatedRows);
    }
    return n;
  },
};
