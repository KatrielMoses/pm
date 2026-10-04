import { sql, type WorkspaceTransaction } from '@pm/db';

/**
 * Ownership and departure hooks (0C §11.5, PERM-014). Every module with an accountable owner
 * registers how it reassigns or suspends that membership's owned resources. Departure runs every
 * hook in the removal transaction: when any hook needs a new owner and none was chosen, removal
 * fails with an actionable plan, so required ownership never becomes null.
 */
export interface OwnershipPlanItem {
  /** Stable hook key (also the bounded `hook` metric label). */
  hook: string;
  /** Owned items this membership is accountable for (counts only; never titles or IDs). */
  owned: number;
  /** True when the items must move to another member before departure can complete. */
  requiresAssignee: boolean;
}

export interface OwnershipHook {
  readonly key: string;
  plan(tx: WorkspaceTransaction, membershipId: string): Promise<OwnershipPlanItem>;
  /**
   * Reassigns (to an active internal member) or suspends/closes the departing member's items.
   * `to` is null only when `plan` reported `requiresAssignee: false`.
   */
  apply(tx: WorkspaceTransaction, from: string, to: string | null): Promise<number>;
}

export class OwnershipRegistry {
  readonly #hooks = new Map<string, OwnershipHook>();

  register(hook: OwnershipHook): this {
    if (this.#hooks.has(hook.key))
      throw new Error(`ownership hook ${hook.key} is already registered`);
    this.#hooks.set(hook.key, hook);
    return this;
  }

  all(): OwnershipHook[] {
    return [...this.#hooks.values()];
  }

  async plan(tx: WorkspaceTransaction, membershipId: string): Promise<OwnershipPlanItem[]> {
    const out: OwnershipPlanItem[] = [];
    for (const h of this.#hooks.values()) out.push(await h.plan(tx, membershipId));
    return out;
  }
}

/** Accountable record owners (`core.record.owner_membership_id`): reassigned to a chosen member. */
export const recordOwnerHook: OwnershipHook = {
  key: 'record_owner',
  async plan(tx, membershipId) {
    const r = await tx.db
      .selectFrom('core.record')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('owner_membership_id', '=', membershipId)
      .where('lifecycle_state', '<>', 'purged')
      .executeTakeFirstOrThrow();
    const owned = Number(r.n);
    return { hook: 'record_owner', owned, requiresAssignee: owned > 0 };
  },
  async apply(tx, from, to) {
    if (to === null) return 0;
    const res = await tx.db
      .updateTable('core.record')
      .set({ owner_membership_id: to, version: sql`version + 1` })
      .where('owner_membership_id', '=', from)
      .where('lifecycle_state', '<>', 'purged')
      .executeTakeFirst();
    return Number(res.numUpdatedRows);
  },
};

/** Pending invitations the departing member sent: revoked (an inviter's departure ends them). */
export const pendingInvitationsHook: OwnershipHook = {
  key: 'pending_invitations',
  async plan(tx, membershipId) {
    const r = await tx.db
      .selectFrom('tenancy.invitation')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('invited_by_membership_id', '=', membershipId)
      .where('state', '=', 'pending')
      .executeTakeFirstOrThrow();
    return { hook: 'pending_invitations', owned: Number(r.n), requiresAssignee: false };
  },
  async apply(tx, from) {
    // The command revokes the matching identity tokens; here the rows close.
    const res = await tx.db
      .updateTable('tenancy.invitation')
      .set({
        state: 'revoked',
        revoked_by_membership_id: from,
        decided_at: new Date(),
        updated_at: new Date(),
        version: sql`version + 1`,
      })
      .where('invited_by_membership_id', '=', from)
      .where('state', '=', 'pending')
      .executeTakeFirst();
    return Number(res.numUpdatedRows);
  },
};

/** Pending ownership transfers to or from the departing member: cancelled. */
export const pendingTransfersHook: OwnershipHook = {
  key: 'pending_transfers',
  async plan(tx, membershipId) {
    const r = await tx.db
      .selectFrom('tenancy.ownership_transfer')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('state', '=', 'pending')
      .where((eb) =>
        eb.or([
          eb('from_membership_id', '=', membershipId),
          eb('to_membership_id', '=', membershipId),
        ]),
      )
      .executeTakeFirstOrThrow();
    return { hook: 'pending_transfers', owned: Number(r.n), requiresAssignee: false };
  },
  async apply(tx, from) {
    const res = await tx.db
      .updateTable('tenancy.ownership_transfer')
      .set({
        state: 'cancelled',
        decided_at: new Date(),
        decided_by_membership_id: from,
        version: sql`version + 1`,
      })
      .where('state', '=', 'pending')
      .where((eb) =>
        eb.or([eb('from_membership_id', '=', from), eb('to_membership_id', '=', from)]),
      )
      .executeTakeFirst();
    return Number(res.numUpdatedRows);
  },
};

/** The 1D registry: every owner-bearing foundation that exists today. Later modules add theirs. */
export function defaultOwnershipRegistry(): OwnershipRegistry {
  return new OwnershipRegistry()
    .register(recordOwnerHook)
    .register(pendingInvitationsHook)
    .register(pendingTransfersHook);
}
