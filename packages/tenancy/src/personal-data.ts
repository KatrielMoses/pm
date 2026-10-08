import { sql, type PlatformTransaction, type WorkspaceTransaction } from '@pm/db';
import { erasePreferences } from '@pm/identity';
import type { PurgeHooks, RecordTypeAdapter } from '@pm/lifecycle';
import type { Metrics } from '@pm/observability';

/**
 * Personal navigation data hooks (1E): purge, departure retention (R-PERSONAL), and account
 * deletion. Personal rows are hints; removing them never changes authority or workspace content.
 */

/** Removes favorites and recents that point at records being purged (any record type). */
export async function removePersonalReferences(
  tx: WorkspaceTransaction,
  recordIds: readonly string[],
): Promise<number> {
  if (!recordIds.length) return 0;
  const f = await tx.db
    .deleteFrom('views.favorite')
    .where('record_id', 'in', [...recordIds])
    .executeTakeFirst();
  const r = await tx.db
    .deleteFrom('views.recent_item')
    .where('record_id', 'in', [...recordIds])
    .executeTakeFirst();
  return Number(f.numDeletedRows) + Number(r.numDeletedRows);
}

/**
 * Wraps a record type's purge hooks so personal references to purged records are removed in the
 * same step as the type's own projections. Types without purge hooks stay unpurgeable.
 */
export function withPersonalReferenceCleanup(adapter: RecordTypeAdapter): RecordTypeAdapter {
  if (!adapter.purge) return adapter;
  const purge: PurgeHooks = {
    ...adapter.purge,
    async removeProjections(tx, recordIds) {
      await adapter.purge!.removeProjections?.(tx, recordIds);
      await removePersonalReferences(tx, recordIds);
    },
  };
  return { ...adapter, purge };
}

/**
 * Personal rows keyed by `owner_membership_id`: 1E navigation; 2D reminders, snoozes, and the
 * member's short-lived bulk and undo rows; 3C plans (blocks before their series) and daily records;
 * 5A recent searches.
 */
const OWNED_PERSONAL_TABLES = [
  'views.favorite',
  'views.recent_item',
  'views.view_state',
  'planning.task_reminder',
  'planning.task_snooze',
  'planning.work_block',
  'planning.block_series',
  'planning.today_commitment',
  'planning.daily_record',
  'work.bulk_operation',
  'work.undo_entry',
  'search.recent_query',
] as const;

/**
 * Rows about the person keyed by `membership_id`: 3E time off, reservations, then the profile; 4A
 * follows and reactions (a person's subscriptions and reactions leave with them; the comments
 * they wrote stay, as content of the records they were written on).
 */
const MEMBERSHIP_PERSONAL_TABLES = [
  'planning.time_off',
  'planning.capacity_reservation',
  'planning.capacity_profile',
  'relations.follower',
  'collab.reaction',
] as const;

/** Membership personal-data eraser (departure retention and account deletion). */
export async function eraseMembershipNavigation(
  tx: WorkspaceTransaction,
  membershipId: string,
): Promise<number> {
  let n = 0;
  for (const table of OWNED_PERSONAL_TABLES) {
    const r = await tx.db
      .deleteFrom(table)
      .where('owner_membership_id', '=', membershipId)
      .executeTakeFirst();
    n += Number(r.numDeletedRows);
  }
  // 3E: the person's time off and the reservations about them, then the profile (its working
  // windows cascade). Holidays and reservations they set for others stay (brand settings).
  for (const table of MEMBERSHIP_PERSONAL_TABLES) {
    const r = await tx.db
      .deleteFrom(table)
      .where('membership_id', '=', membershipId)
      .executeTakeFirst();
    n += Number(r.numDeletedRows);
  }
  // 4B: a person's notifications, deliveries, digests, preferences, and profile leave with them
  // (deliveries and digests reference notifications, so they go first).
  for (const table of ['notify.delivery', 'notify.notification', 'notify.digest'] as const) {
    const r = await tx.db
      .deleteFrom(table)
      .where('recipient_membership_id', '=', membershipId)
      .executeTakeFirst();
    n += Number(r.numDeletedRows);
  }
  // 4C: mentions of the person in documents leave with them (the documents stay).
  n += Number(
    (
      await tx.db
        .deleteFrom('knowledge.document_reference')
        .where('target_membership_id', '=', membershipId)
        .executeTakeFirst()
    ).numDeletedRows,
  );
  for (const table of ['notify.preference', 'notify.profile'] as const) {
    const r = await tx.db
      .deleteFrom(table)
      .where('membership_id', '=', membershipId)
      .executeTakeFirst();
    n += Number(r.numDeletedRows);
  }
  return n;
}

/**
 * One workspace's views cleanup (worker): expired view state, and personal navigation rows of
 * memberships removed before `departedBefore` (null: the R-PERSONAL period is undecided, so
 * departed members' rows are kept). Bounded per call.
 */
export async function cleanupWorkspaceViews(
  tx: WorkspaceTransaction,
  metrics: Metrics,
  options: { departedBefore: Date | null; batch?: number },
): Promise<{ expired: number; departed: number }> {
  const batch = options.batch ?? 200;
  const expired = await tx.db
    .deleteFrom('views.view_state')
    .where('expires_at', '<=', new Date())
    .executeTakeFirst();
  let departed = 0;
  if (options.departedBefore) {
    // Only removed memberships that still own personal rows of any kind the eraser removes
    // (bounded per run): a person with plans or time off but no favorites is swept too.
    const owns = (table: string, column: string) =>
      sql<boolean>`EXISTS (SELECT 1 FROM ${sql.table(table)} x WHERE x.${sql.ref(column)} = m.id)`;
    const gone = await tx.db
      .selectFrom('tenancy.membership as m')
      .select('m.id')
      .where('m.state', '=', 'removed')
      .where('m.removed_at', '<', options.departedBefore)
      .where(
        () =>
          sql<boolean>`(${sql.join(
            [
              ...OWNED_PERSONAL_TABLES.map((t) => owns(t, 'owner_membership_id')),
              ...MEMBERSHIP_PERSONAL_TABLES.map((t) => owns(t, 'membership_id')),
            ],
            sql` OR `,
          )})`,
      )
      .orderBy('m.id')
      .limit(batch)
      .execute();
    for (const m of gone) departed += await eraseMembershipNavigation(tx, m.id);
  }
  if (Number(expired.numDeletedRows))
    metrics.count('views.cleanup', Number(expired.numDeletedRows), { kind: 'expired_state' });
  if (departed) metrics.count('views.cleanup', departed, { kind: 'departed_member' });
  return { expired: Number(expired.numDeletedRows), departed };
}

/**
 * Erasers for personal data a module keeps about a person. The account-deletion command (a later
 * phase) and the departure retention sweep call every registered eraser; a module that stores
 * personal rows registers here instead of being remembered by the caller.
 */
export interface PersonalDataEraser {
  readonly module: string;
  /** One membership's personal rows in its workspace (departure retention, account deletion). */
  eraseMembership?(tx: WorkspaceTransaction, membershipId: string): Promise<number>;
  /** Account-scoped personal rows (account deletion). */
  eraseAccount?(tx: PlatformTransaction, accountId: string): Promise<number>;
}

export class PersonalDataRegistry {
  readonly #erasers = new Map<string, PersonalDataEraser>();

  register(eraser: PersonalDataEraser): this {
    if (this.#erasers.has(eraser.module))
      throw new Error(`personal data eraser ${eraser.module} is already registered`);
    this.#erasers.set(eraser.module, eraser);
    return this;
  }

  all(): PersonalDataEraser[] {
    return [...this.#erasers.values()];
  }

  async eraseMembership(tx: WorkspaceTransaction, membershipId: string): Promise<number> {
    let n = 0;
    for (const e of this.#erasers.values()) n += (await e.eraseMembership?.(tx, membershipId)) ?? 0;
    return n;
  }

  async eraseAccount(tx: PlatformTransaction, accountId: string): Promise<number> {
    let n = 0;
    for (const e of this.#erasers.values()) n += (await e.eraseAccount?.(tx, accountId)) ?? 0;
    return n;
  }
}

/** 1E registrations: views (favorites, recents, view state) and identity (preferences). */
export function defaultPersonalDataRegistry(): PersonalDataRegistry {
  return new PersonalDataRegistry()
    .register({ module: 'views', eraseMembership: eraseMembershipNavigation })
    .register({ module: 'identity', eraseAccount: erasePreferences });
}
