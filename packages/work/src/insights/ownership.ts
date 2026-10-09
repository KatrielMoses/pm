import { sql } from '@pm/db';
import type { OwnershipHook } from '@pm/tenancy';

/**
 * Departure (ADR-0030 D13): a departing member's shared dashboards and reports move to the member
 * chosen in the departure plan. A scheduled report stops (suspended as `owner_departed`) instead of
 * passing to someone who never agreed to answer for what it sends; they resume it when they choose.
 * Their reports' recipient rows, report shares, and personal dashboards are theirs and stay as
 * they are; a personal dashboard is unreadable to everyone else.
 */
export const insightsOwnerHook: OwnershipHook = {
  key: 'insights_owner',
  async plan(tx, membershipId) {
    const r = await sql<{ n: string }>`
      SELECT (
        (SELECT count(*) FROM insights.dashboard WHERE owner_membership_id = ${membershipId}
           AND kind <> 'personal' AND lifecycle_state <> 'purged')
      + (SELECT count(*) FROM insights.report_definition WHERE owner_membership_id = ${membershipId}
           AND lifecycle_state <> 'purged')
      )::text AS n`.execute(tx.db);
    const owned = Number(r.rows[0]?.n ?? 0);
    return { hook: 'insights_owner', owned, requiresAssignee: owned > 0 };
  },
  async apply(tx, from, to) {
    if (to === null) return 0;
    let n = 0;
    const d = await tx.db
      .updateTable('insights.dashboard')
      .set({ owner_membership_id: to, version: sql`version + 1` } as never)
      .where('owner_membership_id', '=', from)
      .where('kind', '<>', 'personal')
      .executeTakeFirst();
    n += Number(d.numUpdatedRows);
    const r = await sql`UPDATE insights.report_definition
        SET suspended_reason = CASE WHEN schedule_frequency IS NOT NULL THEN 'owner_departed' END,
            suspended_at = CASE WHEN schedule_frequency IS NOT NULL THEN now() END,
            next_run_at = NULL, claimed_until = NULL, owner_membership_id = ${to}, version = version + 1
      WHERE owner_membership_id = ${from}`.execute(tx.db);
    n += Number(r.numAffectedRows ?? 0);
    // The departing member no longer receives reports.
    await sql`DELETE FROM insights.report_recipient WHERE membership_id = ${from}`.execute(tx.db);
    return n;
  },
};
