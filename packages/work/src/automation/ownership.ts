import { sql } from '@pm/db';
import type { OwnershipHook } from '@pm/tenancy';

/**
 * Departure (0C §9.4, AT-060): a departing owner's automations are suspended (`owner_departed`)
 * and stop listening; open runs stop at their next step (a run waiting for a reconciliation keeps
 * its liability). Nothing is reassigned silently: a person with authority reassigns and activates.
 */
export const automationOwnerHook: OwnershipHook = {
  key: 'automation.owner',
  async plan(tx, membershipId) {
    const r = await tx.db
      .selectFrom('automation.automation')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('owner_membership_id', '=', membershipId)
      .where('lifecycle_state', '<>', 'purged')
      .executeTakeFirstOrThrow();
    return { hook: 'automation.owner', owned: Number(r.n), requiresAssignee: false };
  },
  async apply(tx, from) {
    const r = await tx.db
      .updateTable('automation.automation')
      .set({
        enabled: false,
        trigger_event: null,
        suspended_reason: 'owner_departed',
        suspended_at: new Date(),
        updated_at: new Date(),
        version: sql`version + 1`,
      })
      .where('owner_membership_id', '=', from)
      .where('suspended_reason', 'is', null)
      .returning('id')
      .execute();
    if (r.length)
      await tx.db
        .deleteFrom('automation.trigger_schedule')
        .where('automation_id', 'in', r.map((x) => x.id))
        .execute();
    return r.length;
  },
};
