import { sql, type WorkspaceTransaction, type LifecycleState } from '@pm/db';
import { TenancyError } from './errors.ts';
import {
  brandCapabilities,
  brandLevel,
  brandVisibility,
  type BrandFacts,
  type Principal,
} from './policy.ts';
import type {
  CalendarSettings,
  NotificationContentMode,
  OperationalStatus,
  Priorities,
  WorkingHours,
} from './validation.ts';

/**
 * Brand reads. Visibility is a SQL predicate built from the compiled principal and applied before
 * ordering, pagination, and counts (0C §4.5). Single reads use the same predicate, so a hidden
 * brand and a nonexistent one take the same path and give the same `not_found`.
 */

const PUBLIC_ID = /^br_[0-9A-HJKMNP-TV-Z]{26}$/;

export interface BrandRow {
  id: string;
  public_id: string;
  name: string;
  short_name: string | null;
  logo_file_ref: string | null;
  color: string;
  icon: string;
  description: string | null;
  operational_status: OperationalStatus;
  timezone: string;
  is_sensitive: boolean;
  notification_content_mode: NotificationContentMode;
  lifecycle_state: LifecycleState;
  version: string | number;
  created_at: Date;
  updated_at: Date;
}

export type BrandStates = 'active' | 'archived' | 'active_or_archived';
const STATES: Record<BrandStates, LifecycleState[]> = {
  active: ['active'],
  archived: ['archived'],
  active_or_archived: ['active', 'archived'],
};

export function facts(row: Pick<BrandRow, 'id' | 'is_sensitive' | 'lifecycle_state'>): BrandFacts {
  return { id: row.id, isSensitive: row.is_sensitive, lifecycleState: row.lifecycle_state };
}

function visibleBrands(tx: WorkspaceTransaction, p: Principal, states: BrandStates) {
  const v = brandVisibility(p);
  return tx.db
    .selectFrom('tenancy.brand as b')
    .innerJoin('core.record as r', (j) =>
      j.onRef('r.workspace_id', '=', 'b.workspace_id').onRef('r.id', '=', 'b.id'),
    )
    .where('b.lifecycle_state', 'in', STATES[states])
    .where((eb) => {
      const ors = [];
      if (v.implicitNonSensitive) ors.push(eb('b.is_sensitive', '=', false));
      if (v.grantedIds.length) ors.push(eb('b.id', 'in', v.grantedIds));
      return ors.length ? eb.or(ors) : sql<boolean>`false`;
    });
}

const COLUMNS = [
  'b.id',
  'r.public_id',
  'b.name',
  'b.short_name',
  'b.logo_file_ref',
  'b.color',
  'b.icon',
  'b.description',
  'b.operational_status',
  'b.timezone',
  'b.is_sensitive',
  'b.notification_content_mode',
  'b.lifecycle_state',
  'b.version',
  'b.created_at',
  'b.updated_at',
] as const;

/** One brand by public ID through the visibility predicate; anything else is `not_found`. */
export async function findBrand(
  tx: WorkspaceTransaction,
  p: Principal,
  publicId: unknown,
  options: { states?: BrandStates; forUpdate?: boolean } = {},
): Promise<BrandRow> {
  if (typeof publicId !== 'string' || !PUBLIC_ID.test(publicId))
    throw new TenancyError('not_found');
  let q = visibleBrands(tx, p, options.states ?? 'active_or_archived')
    .select(COLUMNS)
    .where('r.public_id', '=', publicId);
  if (options.forUpdate) q = q.forUpdate('b');
  const row = (await q.executeTakeFirst()) as BrandRow | undefined;
  // Defense in depth: the compiled level must agree with the SQL predicate.
  if (!row || brandLevel(p, facts(row)) === null) throw new TenancyError('not_found');
  return row;
}

export interface BrandPageOptions {
  states: BrandStates;
  limit: number;
  after?: { n: string; i: string } | undefined;
}

/** Keyset page ordered by (lower(name), id); the cursor position is opaque to clients. */
export async function listBrands(
  tx: WorkspaceTransaction,
  p: Principal,
  o: BrandPageOptions,
): Promise<{ rows: BrandRow[]; hasMore: boolean }> {
  const rows = (await visibleBrands(tx, p, o.states)
    .select(COLUMNS)
    .$if(o.after !== undefined, (q) =>
      q.where(
        (eb) =>
          sql<boolean>`(lower(${eb.ref('b.name')}), ${eb.ref('b.id')}) > (${o.after!.n}, ${o.after!.i}::uuid)`,
      ),
    )
    .orderBy(sql`lower(b.name)`)
    .orderBy('b.id')
    .limit(o.limit + 1)
    .execute()) as BrandRow[];
  return { rows: rows.slice(0, o.limit), hasMore: rows.length > o.limit };
}

/** Total under the identical predicate (never counts hidden rows). */
export async function countBrands(
  tx: WorkspaceTransaction,
  p: Principal,
  states: BrandStates,
): Promise<number> {
  const r = await visibleBrands(tx, p, states)
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/** Every authorized active brand (the all-brands union), ordered like the switcher. */
export async function authorizedActiveBrands(
  tx: WorkspaceTransaction,
  p: Principal,
): Promise<BrandRow[]> {
  return (await visibleBrands(tx, p, 'active')
    .select(COLUMNS)
    .orderBy(sql`lower(b.name)`)
    .orderBy('b.id')
    .limit(500)
    .execute()) as BrandRow[];
}

export function brandView(p: Principal, row: BrandRow) {
  return {
    id: row.public_id,
    type: 'brand' as const,
    name: row.name,
    short_name: row.short_name,
    logo_file_ref: row.logo_file_ref,
    color: row.color,
    icon: row.icon,
    description: row.description,
    operational_status: row.operational_status,
    timezone: row.timezone,
    is_sensitive: row.is_sensitive,
    notification_content_mode: row.notification_content_mode,
    lifecycle_state: row.lifecycle_state as 'active' | 'archived',
    version: Number(row.version),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    capabilities: brandCapabilities(p, facts(row)),
  };
}
export type BrandView = ReturnType<typeof brandView>;

export function brandSummary(row: BrandRow) {
  return {
    id: row.public_id,
    name: row.name,
    short_name: row.short_name,
    color: row.color,
    icon: row.icon,
    is_sensitive: row.is_sensitive,
  };
}

export interface SettingsRow {
  working_hours: WorkingHours;
  calendar: CalendarSettings;
  priorities: Priorities;
  version: string;
  updated_at: Date;
}

export async function loadSettings(
  tx: WorkspaceTransaction,
  brandId: string,
  forUpdate = false,
): Promise<SettingsRow> {
  let q = tx.db
    .selectFrom('tenancy.brand_setting')
    .select(['working_hours', 'calendar', 'priorities', 'version', 'updated_at'])
    .where('brand_id', '=', brandId);
  if (forUpdate) q = q.forUpdate();
  return (await q.executeTakeFirstOrThrow()) as unknown as SettingsRow;
}

export function settingsView(brand: BrandRow, s: SettingsRow) {
  return {
    id: brand.public_id,
    type: 'brand_settings' as const,
    timezone: brand.timezone,
    working_hours: s.working_hours,
    calendar: s.calendar,
    priorities: s.priorities,
    version: Number(s.version),
    updated_at: s.updated_at.toISOString(),
  };
}
export type BrandSettingsView = ReturnType<typeof settingsView>;
