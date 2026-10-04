import { createHash } from 'node:crypto';
import {
  decodeViewState,
  evenRanks,
  isViewKey,
  NAVIGABLE_RECORD_TYPES,
  rankBetween,
  VIEW_STATE_SCHEMAS,
  type NavigableRecordType,
  type ViewKey,
  type ViewStateValue,
} from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { brandMarker, readableBrandsByIds, searchBrands, type BrandMarkerView } from './brands.ts';
import { CollaborationService, type CollaborationDeps } from './collaboration.ts';
import { invalid, issue, TenancyError } from './errors.ts';
import type { Principal } from './policy.ts';
import type { Caller, ContextView } from './service.ts';

/**
 * Personal navigation (Phase 1E, 0B `views`, 0C AZ-20): favorites, recently viewed items, per-device
 * view state, shared-view pins (read path only), and permission-safe palette records.
 *
 * Every stored entry is an identifier, never authority. Lists re-authorize each target through the
 * owning module's adapter (the same predicates as the target's own read) at display time, omit
 * unreadable targets silently, and remove them opportunistically. Writes resolve the target the
 * same way first, so a forged, foreign, or hidden identifier is `not_found` (AT-109).
 */

// -----------------------------------------------------------------------------------------------
// Targets
// -----------------------------------------------------------------------------------------------

/** A readable navigation target: only fields the viewer may see, with its brand marker. */
export interface NavTarget {
  id: string;
  type: NavigableRecordType;
  label: string;
  brand: BrandMarkerView;
  lifecycle_state: 'active' | 'archived';
}

/**
 * How a module makes its record type navigable. `resolve` returns only targets the principal can
 * read now (unreadable ids are simply absent); `search` is a bounded, permission-safe label search.
 */
export interface NavigationTargetAdapter {
  readonly recordType: NavigableRecordType;
  resolve(
    tx: WorkspaceTransaction,
    p: Principal,
    recordIds: readonly string[],
  ): Promise<Map<string, NavTarget>>;
  search?(
    tx: WorkspaceTransaction,
    p: Principal,
    term: string,
    limit: number,
  ): Promise<NavTarget[]>;
}

export class NavigationTargetRegistry {
  readonly #adapters = new Map<string, NavigationTargetAdapter>();

  register(adapter: NavigationTargetAdapter): this {
    if (this.#adapters.has(adapter.recordType))
      throw new Error(`navigation target ${adapter.recordType} is already registered`);
    this.#adapters.set(adapter.recordType, adapter);
    return this;
  }

  get(recordType: string): NavigationTargetAdapter | undefined {
    return this.#adapters.get(recordType);
  }

  all(): NavigationTargetAdapter[] {
    return [...this.#adapters.values()];
  }
}

/** Brands: readable through the 1C brand visibility predicate (active, or archived when visible). */
export const brandTargets: NavigationTargetAdapter = {
  recordType: 'brand',
  async resolve(tx, p, ids) {
    const out = new Map<string, NavTarget>();
    for (const row of await readableBrandsByIds(tx, p, ids))
      out.set(row.id, {
        id: row.public_id,
        type: 'brand',
        label: row.name,
        brand: brandMarker(row),
        lifecycle_state: row.lifecycle_state as 'active' | 'archived',
      });
    return out;
  },
  async search(tx, p, term, limit) {
    return (await searchBrands(tx, p, term, limit)).map((row) => ({
      id: row.public_id,
      type: 'brand' as const,
      label: row.name,
      brand: brandMarker(row),
      lifecycle_state: 'active' as const,
    }));
  },
};

/** Teams (1D): workspace-scoped, visible to internal members only; archived teams are omitted. */
export const teamTargets: NavigationTargetAdapter = {
  recordType: 'team',
  async resolve(tx, p, ids) {
    const out = new Map<string, NavTarget>();
    if (p.kind !== 'member' || !ids.length) return out;
    const rows = await tx.db
      .selectFrom('tenancy.team as t')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
      )
      .select(['t.id', 'r.public_id', 't.name'])
      .where('t.id', 'in', [...ids])
      .where('t.lifecycle_state', '=', 'active')
      .execute();
    for (const r of rows)
      out.set(r.id, {
        id: r.public_id,
        type: 'team',
        label: r.name,
        brand: { kind: 'workspace' },
        lifecycle_state: 'active',
      });
    return out;
  },
  async search(tx, p, term, limit) {
    if (p.kind !== 'member') return [];
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await tx.db
      .selectFrom('tenancy.team as t')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
      )
      .select(['r.public_id', 't.name'])
      .where('t.lifecycle_state', '=', 'active')
      .where('t.name', 'ilike', like)
      .orderBy(sql`lower(t.name)`)
      .orderBy('t.id')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      id: r.public_id,
      type: 'team' as const,
      label: r.name,
      brand: { kind: 'workspace' as const },
      lifecycle_state: 'active' as const,
    }));
  },
};

export function defaultNavigationTargets(): NavigationTargetRegistry {
  return new NavigationTargetRegistry().register(brandTargets).register(teamTargets);
}

// -----------------------------------------------------------------------------------------------
// Device keys
// -----------------------------------------------------------------------------------------------

const DEVICE_KEY = /^[A-Za-z0-9_-]{43}$/;

/**
 * The opaque per-device key (32 random bytes, base64url, generated and kept by the browser) is
 * hashed before use; only the SHA-256 is stored. Anything malformed is null (no device).
 */
export function deviceKeyHash(raw: unknown): Buffer | null {
  if (typeof raw !== 'string' || !DEVICE_KEY.test(raw)) return null;
  return createHash('sha256').update(`pm-device:${raw}`, 'utf8').digest();
}

// -----------------------------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------------------------

export interface ViewsSettings {
  favoritesMax: number;
  recentItemsMax: number;
  recentVisitCoalesceMs: number;
  viewStateMaxBytes: number;
  viewStateTtlMs: number;
}

export const DEFAULT_VIEWS_SETTINGS: ViewsSettings = {
  favoritesMax: 200,
  recentItemsMax: 50,
  recentVisitCoalesceMs: 30_000,
  viewStateMaxBytes: 8192,
  viewStateTtlMs: 90 * 86_400_000,
};

export interface NavigationDeps extends CollaborationDeps {
  views?: ViewsSettings;
  targets?: NavigationTargetRegistry;
}

export interface RecentItemView extends NavTarget {
  visited_at: string;
}

export interface ViewStateView {
  key: ViewKey;
  schema_version: number;
  state: ViewStateValue;
  /** Row version for `If-Match`; 0 when nothing is stored for this device. */
  version: number;
}

const PUBLIC_RECORD_ID = /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/;
const SIDEBAR_RECENT = 5;

interface StoredTarget {
  record_id: string;
  record_type: string;
}

export class NavigationService extends CollaborationService {
  protected readonly v: ViewsSettings;
  readonly #targets: NavigationTargetRegistry;

  constructor(deps: NavigationDeps) {
    super(deps);
    this.v = deps.views ?? DEFAULT_VIEWS_SETTINGS;
    this.#targets = deps.targets ?? defaultNavigationTargets();
  }

  get targets(): NavigationTargetRegistry {
    return this.#targets;
  }

  /** Personal lists belong to the caller only (`own` for every role, including guests). */
  #personal(p: Principal): void {
    this.requirePersonal(p, 'personal.manage_own');
  }

  /** Re-authorizes stored targets per type; returns readable targets keyed by internal id. */
  async #readable(
    tx: WorkspaceTransaction,
    p: Principal,
    stored: readonly StoredTarget[],
  ): Promise<Map<string, NavTarget>> {
    const byType = new Map<string, string[]>();
    for (const s of stored) {
      const list = byType.get(s.record_type) ?? [];
      list.push(s.record_id);
      byType.set(s.record_type, list);
    }
    const out = new Map<string, NavTarget>();
    for (const [type, ids] of byType) {
      const adapter = this.#targets.get(type);
      if (!adapter) continue;
      for (const [id, t] of await adapter.resolve(tx, p, ids)) out.set(id, t);
    }
    return out;
  }

  /** A target by public ID, readable by the caller now; anything else is `not_found`. */
  async #target(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
  ): Promise<{ recordId: string; target: NavTarget }> {
    if (typeof publicId !== 'string' || !PUBLIC_RECORD_ID.test(publicId))
      throw new TenancyError('not_found');
    const row = await tx.db
      .selectFrom('core.record')
      .select(['id', 'record_type'])
      .where('public_id', '=', publicId)
      .executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    const target = (
      await this.#readable(tx, p, [{ record_id: row.id, record_type: row.record_type }])
    ).get(row.id);
    if (!target) throw new TenancyError('not_found');
    return { recordId: row.id, target };
  }

  /** Removes entries that are no longer readable (opportunistic; never reported to the caller). */
  async #drop(
    tx: WorkspaceTransaction,
    p: Principal,
    table: 'views.favorite' | 'views.recent_item',
    ids: string[],
  ): Promise<void> {
    if (!ids.length) return;
    this.d.metrics.count('views.omitted_targets', ids.length, {
      list: table === 'views.favorite' ? 'favorites' : 'recent',
    });
    await tx.db
      .deleteFrom(table)
      .where('owner_membership_id', '=', p.membershipId)
      .where('record_id', 'in', ids)
      .execute();
    this.d.metrics.count('views.cleanup', ids.length, { kind: 'unreadable_target' });
  }

  // ---------------------------------------------------------------------------------------------
  // Scope (1C canonical context, extended: URL token and per-device default)
  // ---------------------------------------------------------------------------------------------

  override async selectContext(
    caller: Caller,
    workspacePublicId: unknown,
    body: unknown,
    options: { device?: Buffer | null } = {},
  ): Promise<ContextView> {
    return super.selectContext(caller, workspacePublicId, body, {
      device: options.device ?? null,
      viewStateTtlMs: this.v.viewStateTtlMs,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Favorites (NAV-008)
  // ---------------------------------------------------------------------------------------------

  async listFavorites(caller: Caller, workspacePublicId: unknown): Promise<NavTarget[]> {
    return this.inWorkspace(caller, workspacePublicId, {}, async (tx, p) => {
      this.#personal(p);
      const rows = await tx.db
        .selectFrom('views.favorite as f')
        .innerJoin('core.record as r', (j) =>
          j.onRef('r.workspace_id', '=', 'f.workspace_id').onRef('r.id', '=', 'f.record_id'),
        )
        .select(['f.record_id', 'r.record_type'])
        .where('f.owner_membership_id', '=', p.membershipId)
        .orderBy('f.rank')
        .orderBy('f.record_id')
        .limit(this.v.favoritesMax)
        .execute();
      const readable = await this.#readable(tx, p, rows);
      await this.#drop(
        tx,
        p,
        'views.favorite',
        rows.filter((r) => !readable.has(r.record_id)).map((r) => r.record_id),
      );
      return rows.flatMap((r) => {
        const t = readable.get(r.record_id);
        return t ? [t] : [];
      });
    });
  }

  /** Serializes one person's favorite changes (insert, limit check, reorder) per workspace. */
  async #lockFavorites(tx: WorkspaceTransaction, p: Principal): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`views.favorite:${p.membershipId}`}, 0))`.execute(
      tx.db,
    );
  }

  /** Idempotent: favoriting an existing favorite returns it unchanged (`created: false`). */
  async addFavorite(
    caller: Caller,
    workspacePublicId: unknown,
    targetPublicId: unknown,
  ): Promise<{ target: NavTarget; created: boolean }> {
    try {
      const out = await this.inWorkspace(caller, workspacePublicId, {}, async (tx, p) => {
        this.#personal(p);
        const { recordId, target } = await this.#target(tx, p, targetPublicId);
        await this.#lockFavorites(tx, p);
        const existing = await tx.db
          .selectFrom('views.favorite')
          .select('rank')
          .where('owner_membership_id', '=', p.membershipId)
          .where('record_id', '=', recordId)
          .executeTakeFirst();
        if (existing) return { target, created: false };
        const stats = await tx.db
          .selectFrom('views.favorite')
          .select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.max('rank').as('last')])
          .where('owner_membership_id', '=', p.membershipId)
          .executeTakeFirstOrThrow();
        if (Number(stats.n) >= this.v.favoritesMax)
          throw new TenancyError('limit_exceeded', {
            issues: [
              issue(
                '/target',
                'favorites_full',
                `You can keep up to ${this.v.favoritesMax} favorites. Remove one to add another.`,
              ),
            ],
          });
        let rank = rankBetween((stats.last as string | null) ?? null, null);
        if (rank === null) {
          await this.#rebalance(tx, p);
          const last = await tx.db
            .selectFrom('views.favorite')
            .select((eb) => eb.fn.max('rank').as('last'))
            .where('owner_membership_id', '=', p.membershipId)
            .executeTakeFirstOrThrow();
          rank = rankBetween((last.last as string | null) ?? null, null)!;
        }
        await tx.db
          .insertInto('views.favorite')
          .values({
            workspace_id: tx.workspaceId,
            owner_membership_id: p.membershipId,
            record_id: recordId,
            rank,
          })
          .execute();
        return { target, created: true };
      });
      this.d.metrics.count('views.favorite_changes', 1, { op: 'add', outcome: 'ok' });
      return out;
    } catch (err) {
      this.#countFavorite('add', err);
      throw err;
    }
  }

  /** Idempotent: removing a missing or unreadable favorite is the same `not_found`. */
  async removeFavorite(
    caller: Caller,
    workspacePublicId: unknown,
    targetPublicId: unknown,
  ): Promise<void> {
    try {
      await this.inWorkspace(caller, workspacePublicId, {}, async (tx, p) => {
        this.#personal(p);
        // Removing does not require the target to be readable (a person may always forget a
        // hint), but a foreign or unknown identifier is indistinguishable from a missing entry.
        if (typeof targetPublicId !== 'string' || !PUBLIC_RECORD_ID.test(targetPublicId))
          throw new TenancyError('not_found');
        const r = await tx.db
          .deleteFrom('views.favorite')
          .where('owner_membership_id', '=', p.membershipId)
          .where(
            'record_id',
            '=',
            tx.db.selectFrom('core.record').select('id').where('public_id', '=', targetPublicId),
          )
          .executeTakeFirst();
        if (Number(r.numDeletedRows) === 0) throw new TenancyError('not_found');
      });
      this.d.metrics.count('views.favorite_changes', 1, { op: 'remove', outcome: 'ok' });
    } catch (err) {
      this.#countFavorite('remove', err);
      throw err;
    }
  }

  /**
   * Moves one favorite directly after `after` (null: to the top). Deterministic under concurrency:
   * moves serialize per person, and each computes its rank from the committed neighbours.
   */
  async moveFavorite(
    caller: Caller,
    workspacePublicId: unknown,
    targetPublicId: unknown,
    body: unknown,
  ): Promise<NavTarget[]> {
    const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {};
    const after = (b as Record<string, unknown>).after;
    for (const k of Object.keys(b))
      if (k !== 'after')
        throw invalid(issue(`/${k}`, 'unsupported_field', 'This field is not supported.'));
    if (after !== null && (typeof after !== 'string' || !PUBLIC_RECORD_ID.test(after)))
      throw invalid(
        issue(
          '/after',
          'invalid_option',
          'Name the favorite to place it after, or null for the top.',
        ),
      );
    try {
      await this.inWorkspace(caller, workspacePublicId, {}, async (tx, p) => {
        this.#personal(p);
        const { recordId } = await this.#target(tx, p, targetPublicId);
        await this.#lockFavorites(tx, p);
        const placeAfter = async (): Promise<string | null> => {
          const list = await tx.db
            .selectFrom('views.favorite as f')
            .innerJoin('core.record as r', (j) =>
              j.onRef('r.workspace_id', '=', 'f.workspace_id').onRef('r.id', '=', 'f.record_id'),
            )
            .select(['f.record_id', 'f.rank', 'r.public_id'])
            .where('f.owner_membership_id', '=', p.membershipId)
            .orderBy('f.rank')
            .orderBy('f.record_id')
            .execute();
          if (!list.some((x) => x.record_id === recordId)) throw new TenancyError('not_found');
          const others = list.filter((x) => x.record_id !== recordId);
          let i = -1;
          if (after !== null) {
            i = others.findIndex((x) => x.public_id === after);
            if (i < 0) throw new TenancyError('not_found');
          }
          return rankBetween(others[i]?.rank ?? null, others[i + 1]?.rank ?? null);
        };
        let rank = await placeAfter();
        if (rank === null) {
          await this.#rebalance(tx, p);
          rank = await placeAfter();
        }
        await tx.db
          .updateTable('views.favorite')
          .set({ rank: rank! })
          .where('owner_membership_id', '=', p.membershipId)
          .where('record_id', '=', recordId)
          .execute();
      });
      this.d.metrics.count('views.favorite_changes', 1, { op: 'reorder', outcome: 'ok' });
    } catch (err) {
      this.#countFavorite('reorder', err);
      throw err;
    }
    return this.listFavorites(caller, workspacePublicId);
  }

  /** Rewrites a person's ranks evenly (same order); bounded by FAVORITES_MAX rows. */
  async #rebalance(tx: WorkspaceTransaction, p: Principal): Promise<void> {
    const rows = await tx.db
      .selectFrom('views.favorite')
      .select('record_id')
      .where('owner_membership_id', '=', p.membershipId)
      .orderBy('rank')
      .orderBy('record_id')
      .execute();
    const ranks = evenRanks(rows.length);
    for (const [i, r] of rows.entries())
      await tx.db
        .updateTable('views.favorite')
        .set({ rank: ranks[i]! })
        .where('owner_membership_id', '=', p.membershipId)
        .where('record_id', '=', r.record_id)
        .execute();
  }

  #countFavorite(op: 'add' | 'remove' | 'reorder', err: unknown): void {
    const code = err instanceof TenancyError ? err.code : 'error';
    const outcome =
      code === 'not_found' || code === 'limit_exceeded'
        ? code
        : code === 'validation_failed'
          ? 'invalid'
          : 'error';
    this.d.metrics.count('views.favorite_changes', 1, { op, outcome });
  }

  // ---------------------------------------------------------------------------------------------
  // Recently viewed (NAV-007)
  // ---------------------------------------------------------------------------------------------

  async listRecent(
    caller: Caller,
    workspacePublicId: unknown,
    query: { limit?: unknown; type?: unknown; brand?: unknown } = {},
  ): Promise<RecentItemView[]> {
    const limit =
      query.limit === undefined
        ? this.v.recentItemsMax
        : query.limit === 'sidebar'
          ? Math.min(SIDEBAR_RECENT, this.v.recentItemsMax)
          : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > this.v.recentItemsMax)
      throw invalid(
        issue('/query/limit', 'invalid_option', `Use a limit from 1 to ${this.v.recentItemsMax}.`),
      );
    if (
      query.type !== undefined &&
      !(NAVIGABLE_RECORD_TYPES as readonly unknown[]).includes(query.type)
    )
      throw invalid(issue('/query/type', 'invalid_option', 'Choose a record type to show.'));
    if (
      query.brand !== undefined &&
      (typeof query.brand !== 'string' || !/^br_[0-9A-HJKMNP-TV-Z]{26}$/.test(query.brand))
    )
      throw invalid(issue('/query/brand', 'invalid_option', 'Choose a brand to show.'));
    return this.inWorkspace(caller, workspacePublicId, {}, async (tx, p) => {
      this.#personal(p);
      const rows = await tx.db
        .selectFrom('views.recent_item as i')
        .innerJoin('core.record as r', (j) =>
          j.onRef('r.workspace_id', '=', 'i.workspace_id').onRef('r.id', '=', 'i.record_id'),
        )
        .select(['i.record_id', 'i.visited_at', 'r.record_type'])
        .where('i.owner_membership_id', '=', p.membershipId)
        .orderBy('i.visited_at', 'desc')
        .orderBy('i.record_id', 'desc')
        .limit(this.v.recentItemsMax)
        .execute();
      const readable = await this.#readable(tx, p, rows);
      await this.#drop(
        tx,
        p,
        'views.recent_item',
        rows.filter((r) => !readable.has(r.record_id)).map((r) => r.record_id),
      );
      const out: RecentItemView[] = [];
      for (const r of rows) {
        const t = readable.get(r.record_id);
        if (!t) continue;
        if (query.type !== undefined && t.type !== query.type) continue;
        if (query.brand !== undefined && (t.brand.kind !== 'brand' || t.brand.id !== query.brand))
          continue;
        out.push({ ...t, visited_at: r.visited_at.toISOString() });
        if (out.length >= limit) break;
      }
      return out;
    });
  }

  /**
   * Records a visit after a successful authorized render (the client calls this; reads never
   * record). Coalesced within RECENT_VISIT_COALESCE and trimmed to RECENT_ITEMS_MAX in the same
   * transaction. Hidden or foreign targets are `not_found` and write nothing.
   */
  async recordVisit(
    caller: Caller,
    workspacePublicId: unknown,
    targetPublicId: unknown,
  ): Promise<{ outcome: 'recorded' | 'coalesced' }> {
    try {
      const out = await this.inWorkspace(caller, workspacePublicId, {}, async (tx, p) => {
        this.#personal(p);
        const { recordId } = await this.#target(tx, p, targetPublicId);
        const cutoff = new Date(Date.now() - this.v.recentVisitCoalesceMs);
        const written = await tx.db
          .insertInto('views.recent_item')
          .values({
            workspace_id: tx.workspaceId,
            owner_membership_id: p.membershipId,
            record_id: recordId,
            visited_at: new Date(),
          })
          .onConflict((oc) =>
            oc
              .columns(['workspace_id', 'owner_membership_id', 'record_id'])
              .doUpdateSet((eb) => ({
                visited_at: new Date(),
                visit_count: eb('views.recent_item.visit_count', '+', 1),
              }))
              .where('views.recent_item.visited_at', '<', cutoff),
          )
          .returning('record_id')
          .executeTakeFirst();
        if (!written) return { outcome: 'coalesced' as const };
        const trimmed = await tx.db
          .deleteFrom('views.recent_item')
          .where('owner_membership_id', '=', p.membershipId)
          .where(
            'record_id',
            'in',
            tx.db
              .selectFrom('views.recent_item')
              .select('record_id')
              .where('owner_membership_id', '=', p.membershipId)
              .orderBy('visited_at', 'desc')
              .orderBy('record_id', 'desc')
              .offset(this.v.recentItemsMax),
          )
          .executeTakeFirst();
        if (Number(trimmed.numDeletedRows))
          this.d.metrics.count('views.cleanup', Number(trimmed.numDeletedRows), {
            kind: 'trimmed_recent',
          });
        return { outcome: 'recorded' as const };
      });
      this.d.metrics.count('views.recent_writes', 1, { outcome: out.outcome });
      return out;
    } catch (err) {
      this.d.metrics.count('views.recent_writes', 1, {
        outcome: err instanceof TenancyError && err.code === 'not_found' ? 'not_found' : 'failed',
      });
      throw err;
    }
  }

  /** Clears all recent items, or one entry (`target`). Clearing nothing is not an error. */
  async clearRecent(caller: Caller, workspacePublicId: unknown, targetPublicId?: unknown) {
    return this.inWorkspace(caller, workspacePublicId, {}, async (tx, p) => {
      this.#personal(p);
      let q = tx.db
        .deleteFrom('views.recent_item')
        .where('owner_membership_id', '=', p.membershipId);
      if (targetPublicId !== undefined) {
        if (typeof targetPublicId !== 'string' || !PUBLIC_RECORD_ID.test(targetPublicId))
          throw new TenancyError('not_found');
        q = q.where(
          'record_id',
          '=',
          tx.db.selectFrom('core.record').select('id').where('public_id', '=', targetPublicId),
        );
      }
      const r = await q.executeTakeFirst();
      return { cleared: Number(r.numDeletedRows) };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // View state (NAV-011, RS-20): per person, device, and registered view
  // ---------------------------------------------------------------------------------------------

  #viewKey(key: unknown): ViewKey {
    if (!isViewKey(key)) throw new TenancyError('not_found');
    return key;
  }

  async getViewState(
    caller: Caller,
    workspacePublicId: unknown,
    key: unknown,
    device: Buffer | null,
  ): Promise<ViewStateView> {
    const k = this.#viewKey(key);
    const schema = VIEW_STATE_SCHEMAS[k];
    const empty: ViewStateView = { key: k, schema_version: schema.version, state: {}, version: 0 };
    if (!device) return empty;
    const out = await this.inWorkspace(
      caller,
      workspacePublicId,
      { readOnly: true },
      async (tx, p) => {
        this.#personal(p);
        const row = await tx.db
          .selectFrom('views.view_state')
          .select(['state', 'schema_version', 'expires_at', 'version'])
          .where('owner_membership_id', '=', p.membershipId)
          .where('device_key_hash', '=', device)
          .where('view_key', '=', k)
          .executeTakeFirst();
        if (!row || row.expires_at <= new Date()) return empty;
        const decoded = decodeViewState(k, row.state, {
          store: 'device',
          version: row.schema_version,
          maxBytes: this.v.viewStateMaxBytes,
        });
        if (!decoded.ok) {
          // Corrupt or older state degrades to defaults; the next write replaces it.
          this.d.metrics.count('views.state_decode_failures', 1, {
            source: 'server',
            reason: decoded.reason,
          });
          return { ...empty, version: Number(row.version) };
        }
        return { ...empty, state: decoded.state, version: Number(row.version) };
      },
    );
    this.d.metrics.count('views.state_ops', 1, { op: 'read', outcome: 'ok' });
    return out;
  }

  /**
   * Upserts this device's state for one view. The body is decoded against the view's schema:
   * unknown keys and invalid values are rejected (never stored). `ifMatch` makes the write
   * conditional; otherwise the last write wins for this device only.
   */
  async putViewState(
    caller: Caller,
    workspacePublicId: unknown,
    key: unknown,
    device: Buffer | null,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<ViewStateView> {
    const k = this.#viewKey(key);
    const schema = VIEW_STATE_SCHEMAS[k];
    const fail = (outcome: string, err: TenancyError): never => {
      this.d.metrics.count('views.state_ops', 1, { op: 'write', outcome });
      throw err;
    };
    if (!device)
      fail(
        'invalid',
        invalid(issue('/headers/x-device-key', 'invalid_option', 'This device is not identified.')),
      );
    const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? body : null;
    if (!b || Object.keys(b).some((x) => x !== 'schema_version' && x !== 'state'))
      fail('invalid', invalid(issue('', 'invalid_type', 'Send schema_version and state.')));
    const decoded = decodeViewState(k, (b as Record<string, unknown>).state, {
      store: 'device',
      version: Number((b as Record<string, unknown>).schema_version),
      maxBytes: this.v.viewStateMaxBytes,
    });
    if (!decoded.ok)
      fail(
        decoded.reason === 'too_large' ? 'too_large' : 'invalid',
        invalid(issue('/state', decoded.reason, 'This view state cannot be stored.')),
      );
    if (decoded.ok && decoded.dropped > 0)
      fail('invalid', invalid(issue('/state', 'field', 'This view state has unsupported fields.')));
    const state = decoded.ok ? decoded.state : {};
    try {
      const out = await this.inWorkspace(caller, workspacePublicId, {}, async (tx, p) => {
        this.#personal(p);
        const now = new Date();
        const expires = new Date(now.getTime() + this.v.viewStateTtlMs);
        // Expired rows for this person and device go first (bounded by the registered views).
        const expired = await tx.db
          .deleteFrom('views.view_state')
          .where('owner_membership_id', '=', p.membershipId)
          .where('device_key_hash', '=', device!)
          .where('expires_at', '<=', now)
          .executeTakeFirst();
        if (Number(expired.numDeletedRows))
          this.d.metrics.count('views.cleanup', Number(expired.numDeletedRows), {
            kind: 'expired_state',
          });
        const current = await tx.db
          .selectFrom('views.view_state')
          .select('version')
          .where('owner_membership_id', '=', p.membershipId)
          .where('device_key_hash', '=', device!)
          .where('view_key', '=', k)
          .forUpdate()
          .executeTakeFirst();
        const currentVersion = current ? Number(current.version) : 0;
        if (ifMatch !== undefined && ifMatch !== currentVersion)
          throw new TenancyError('conflict', { conflict: { current_version: currentVersion } });
        const json = JSON.stringify(state);
        if (current) {
          await tx.db
            .updateTable('views.view_state')
            .set({
              schema_version: schema.version,
              state: json,
              updated_at: now,
              expires_at: expires,
              version: currentVersion + 1,
            })
            .where('owner_membership_id', '=', p.membershipId)
            .where('device_key_hash', '=', device!)
            .where('view_key', '=', k)
            .execute();
        } else {
          await tx.db
            .insertInto('views.view_state')
            .values({
              workspace_id: tx.workspaceId,
              owner_membership_id: p.membershipId,
              device_key_hash: device!,
              view_key: k,
              schema_version: schema.version,
              state: json,
              updated_at: now,
              expires_at: expires,
              version: 1,
            })
            // A concurrent first write for the same device: last write wins.
            .onConflict((oc) =>
              oc
                .columns(['workspace_id', 'owner_membership_id', 'device_key_hash', 'view_key'])
                .doUpdateSet((eb) => ({
                  schema_version: schema.version,
                  state: json,
                  updated_at: now,
                  expires_at: expires,
                  version: eb('views.view_state.version', '+', 1),
                })),
            )
            .execute();
        }
        const after = await tx.db
          .selectFrom('views.view_state')
          .select('version')
          .where('owner_membership_id', '=', p.membershipId)
          .where('device_key_hash', '=', device!)
          .where('view_key', '=', k)
          .executeTakeFirstOrThrow();
        return { key: k, schema_version: schema.version, state, version: Number(after.version) };
      });
      this.d.metrics.count('views.state_ops', 1, { op: 'write', outcome: 'ok' });
      return out;
    } catch (err) {
      this.d.metrics.count('views.state_ops', 1, {
        op: 'write',
        outcome: err instanceof TenancyError && err.code === 'conflict' ? 'conflict' : 'error',
      });
      throw err;
    }
  }

  async deleteViewState(
    caller: Caller,
    workspacePublicId: unknown,
    key: unknown,
    device: Buffer | null,
  ): Promise<void> {
    const k = this.#viewKey(key);
    if (!device) return;
    await this.inWorkspace(caller, workspacePublicId, {}, async (tx, p) => {
      this.#personal(p);
      await tx.db
        .deleteFrom('views.view_state')
        .where('owner_membership_id', '=', p.membershipId)
        .where('device_key_hash', '=', device)
        .where('view_key', '=', k)
        .execute();
    });
    this.d.metrics.count('views.state_ops', 1, { op: 'clear', outcome: 'ok' });
  }

  // ---------------------------------------------------------------------------------------------
  // Palette records (NAV-009 foundation; full search is 5A) and shared-view pins
  // ---------------------------------------------------------------------------------------------

  /**
   * Permission-safe record lookup for the command palette: each registered adapter searches only
   * what the caller can read now. The term is used for matching only (never logged or stored).
   */
  async searchTargets(
    caller: Caller,
    workspacePublicId: unknown,
    term: unknown,
  ): Promise<NavTarget[]> {
    const t = typeof term === 'string' ? term.trim().slice(0, 80) : '';
    if (t.length < 1) return [];
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      this.#personal(p);
      const out: NavTarget[] = [];
      for (const a of this.#targets.all()) if (a.search) out.push(...(await a.search(tx, p, t, 8)));
      return out.slice(0, 20);
    });
  }

  /**
   * Shared saved views pinned into navigation (IA-09). Foundation only: no view type is
   * registered as a navigation target yet, so every pin is omitted until the view engine
   * registers `saved_view` (and with it the write path under `views.configure`).
   */
  async listPins(caller: Caller, workspacePublicId: unknown): Promise<NavTarget[]> {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      this.#personal(p);
      const rows = await tx.db
        .selectFrom('views.view_pin as v')
        .innerJoin('core.record as r', (j) =>
          j.onRef('r.workspace_id', '=', 'v.workspace_id').onRef('r.id', '=', 'v.saved_view_id'),
        )
        .select(['v.saved_view_id as record_id', 'r.record_type'])
        .orderBy('v.rank')
        .orderBy('v.saved_view_id')
        .limit(100)
        .execute();
      const readable = await this.#readable(tx, p, rows);
      return rows.flatMap((r) => {
        const t = readable.get(r.record_id);
        return t ? [t] : [];
      });
    });
  }
}
