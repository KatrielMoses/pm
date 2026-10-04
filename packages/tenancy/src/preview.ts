import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { canonicalJson } from '@pm/platform';
import {
  brandLevel,
  decideBrand,
  levelRank,
  roleCap,
  workspaceCapabilities,
  workspaceLevel,
  type BrandFacts,
  type Level,
  type Principal,
} from './policy.ts';

/**
 * One explanation engine (0C §13.1-§13.2) for the effective-permission preview, the pre-change
 * exposure warning, and the enforcement tests. Everything is restricted to scopes the previewer
 * may inspect (`access.preview`): hidden brands are omitted, never shown as denied, and record
 * counts come only from brands the previewer can see.
 */

export interface BrandRef extends BrandFacts {
  publicId: string;
  name: string;
}

export interface BrandExplanation {
  brand: { id: string; name: string; is_sensitive: boolean };
  level: Level | null;
  sources: Array<{
    via: 'implicit' | 'direct' | 'team';
    level: Level;
    team: string | null;
    expires_at: string | null;
  }>;
}

export interface Explanation {
  kind: 'member' | 'guest';
  role: string | null;
  role_cap: Level | null;
  workspace_level: Level | null;
  brands: BrandExplanation[];
  capabilities: Record<string, boolean>;
}

/** Brands the previewer may inspect, in a stable order. */
export function inspectable(viewer: Principal, brands: readonly BrandRef[]): BrandRef[] {
  return brands
    .filter((b) => b.lifecycleState === 'active' || b.lifecycleState === 'archived')
    .filter(
      (b) => decideBrand(viewer, 'access.preview', { ...b, lifecycleState: 'active' }).allowed,
    )
    .sort(
      (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.id < b.id ? -1 : 1),
    );
}

export function explain(
  viewer: Principal,
  target: Principal | null,
  brands: readonly BrandRef[],
  teamNames: ReadonlyMap<string, string>,
): Explanation {
  const visible = inspectable(viewer, brands);
  if (target === null)
    return {
      kind: 'member',
      role: null,
      role_cap: null,
      workspace_level: null,
      brands: visible.map((b) => ({
        brand: { id: b.publicId, name: b.name, is_sensitive: b.isSensitive },
        level: null,
        sources: [],
      })),
      capabilities: {},
    };
  return {
    kind: target.kind,
    role: target.role,
    role_cap:
      target.role === null ? null : roleCap(target.role) === 'manage' ? null : roleCap(target.role),
    workspace_level: workspaceLevel(target),
    brands: visible.map((b) => {
      const facts = { ...b, lifecycleState: 'active' as const };
      const sources: BrandExplanation['sources'] = [];
      if (
        target.kind === 'member' &&
        (target.role === 'owner' || target.role === 'administrator') &&
        !b.isSensitive
      )
        sources.push({ via: 'implicit', level: 'manage', team: null, expires_at: null });
      for (const s of target.grantSources.filter((g) => g.brandId === b.id))
        sources.push({
          via: s.via,
          level: s.level,
          // Team names are shown only for teams in this workspace; never team IDs.
          team: s.teamId ? (teamNames.get(s.teamId) ?? null) : null,
          expires_at: s.expiresAt ? s.expiresAt.toISOString() : null,
        });
      return {
        brand: { id: b.publicId, name: b.name, is_sensitive: b.isSensitive },
        level: brandLevel(target, facts),
        sources,
      };
    }),
    capabilities: workspaceCapabilities(target),
  };
}

export interface ExposureDiff {
  /** Brands (inspectable by the previewer) whose effective level changes. */
  brands: Array<{ brand: { id: string; name: string }; before: Level | null; after: Level | null }>;
  /** Records newly readable / no longer readable, by record type, within those brands only. */
  records_gained: Record<string, number>;
  records_lost: Record<string, number>;
  capabilities_gained: string[];
  capabilities_lost: string[];
  /** Internal members affected (team changes affect every member of the team). */
  affected_members: number;
  increases_access: boolean;
}

async function countByType(
  tx: WorkspaceTransaction,
  brandIds: readonly string[],
): Promise<Record<string, number>> {
  if (!brandIds.length) return {};
  const rows = await tx.db
    .selectFrom('core.record')
    .select(['record_type', (eb) => eb.fn.countAll<string>().as('n')])
    .where('brand_id', 'in', [...brandIds])
    .where('lifecycle_state', '=', 'active')
    .where('record_type', '<>', 'brand')
    .groupBy('record_type')
    .orderBy('record_type')
    .execute();
  return Object.fromEntries(rows.map((r) => [r.record_type, Number(r.n)]));
}

/**
 * Before/after comparison through the same compiler (0C §13.2). Applies to one or more target
 * principals (a team change affects every member); results aggregate within previewer scope.
 */
export async function exposureDiff(
  tx: WorkspaceTransaction,
  viewer: Principal,
  pairs: ReadonlyArray<{ before: Principal | null; after: Principal | null }>,
  brands: readonly BrandRef[],
): Promise<ExposureDiff> {
  const visible = inspectable(viewer, brands);
  const changed = new Map<string, { brand: BrandRef; before: Level | null; after: Level | null }>();
  const gainedBrands = new Set<string>();
  const lostBrands = new Set<string>();
  const capsGained = new Set<string>();
  const capsLost = new Set<string>();
  for (const { before, after } of pairs) {
    for (const b of visible) {
      const facts = { ...b, lifecycleState: 'active' as const };
      const lb = before ? brandLevel(before, facts) : null;
      const la = after ? brandLevel(after, facts) : null;
      if (lb === la) continue;
      const prev = changed.get(b.id);
      changed.set(b.id, {
        brand: b,
        before: prev ? (levelRank(prev.before) >= levelRank(lb) ? prev.before : lb) : lb,
        after: prev ? (levelRank(prev.after) >= levelRank(la) ? prev.after : la) : la,
      });
      if (lb === null && la !== null) gainedBrands.add(b.id);
      if (lb !== null && la === null) lostBrands.add(b.id);
    }
    const cb = before ? workspaceCapabilities(before) : {};
    const ca = after ? workspaceCapabilities(after) : {};
    for (const k of new Set([...Object.keys(cb), ...Object.keys(ca)])) {
      const x = (cb as Record<string, boolean>)[k] === true;
      const y = (ca as Record<string, boolean>)[k] === true;
      if (!x && y) capsGained.add(k);
      if (x && !y) capsLost.add(k);
    }
  }
  const brandsOut = [...changed.values()].map((c) => ({
    brand: { id: c.brand.publicId, name: c.brand.name },
    before: c.before,
    after: c.after,
  }));
  return {
    brands: brandsOut,
    records_gained: await countByType(tx, [...gainedBrands]),
    records_lost: await countByType(tx, [...lostBrands]),
    capabilities_gained: [...capsGained].sort(),
    capabilities_lost: [...capsLost].sort(),
    affected_members: pairs.length,
    increases_access:
      [...changed.values()].some((c) => levelRank(c.after) > levelRank(c.before)) ||
      capsGained.size > 0,
  };
}

/**
 * Signed preview fingerprint: binds the previewer, the exact proposed change, the epochs it was
 * computed under, and the diff it showed. Applying recomputes under lock; any difference (or an
 * expired token) is a conflict that requires review again.
 */
export function previewToken(
  key: Buffer,
  input: { viewer: string; change: unknown; epochs: unknown; diff: ExposureDiff },
  ttlMs: number,
  now = Date.now(),
): string {
  const exp = now + ttlMs;
  return `${exp.toString(36)}.${mac(key, exp, input)}`;
}

export function verifyPreviewToken(
  key: Buffer,
  token: unknown,
  input: { viewer: string; change: unknown; epochs: unknown; diff: ExposureDiff },
  now = Date.now(),
): boolean {
  if (typeof token !== 'string' || token.length > 200) return false;
  const [e, m] = token.split('.');
  if (!e || !m) return false;
  const exp = parseInt(e, 36);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = Buffer.from(mac(key, exp, input));
  const got = Buffer.from(m);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

function mac(key: Buffer, exp: number, input: unknown): string {
  return createHmac('sha256', key)
    .update(`preview:${exp}:${canonicalJson(input)}`)
    .digest('base64url');
}

/** Brand references (public IDs and names) for previews and explanations. */
export async function brandRefs(tx: WorkspaceTransaction): Promise<BrandRef[]> {
  const rows = await tx.db
    .selectFrom('tenancy.brand as b')
    .innerJoin('core.record as r', (j) =>
      j.onRef('r.workspace_id', '=', 'b.workspace_id').onRef('r.id', '=', 'b.id'),
    )
    .select(['b.id', 'r.public_id', 'b.name', 'b.is_sensitive', 'b.lifecycle_state'])
    .orderBy(sql`lower(b.name)`)
    .orderBy('b.id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    publicId: r.public_id,
    name: r.name,
    isSensitive: r.is_sensitive,
    lifecycleState: r.lifecycle_state,
  }));
}
