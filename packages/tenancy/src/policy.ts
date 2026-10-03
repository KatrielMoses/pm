import { ACTIONS, type ActionKey } from '@pm/contracts';

/**
 * The 1C authorization compiler (0C §4-§6), designed so 1D extends it rather than replacing it.
 *
 * Inputs are canonical: the caller's active `tenancy.membership`, its single workspace role
 * assignment, and its brand-scope grants (`access.role_assignment`, scope level roles). Nothing is
 * inferred from who created a row, a browser claim, an email address, or a session flag.
 *
 * Rules (0C):
 *   - The workspace role's matrix cell decides: `implicit`, `deny`, or `grant:<level>`.
 *   - Owners and administrators hold implicit `manage` on the workspace and on every
 *     non-sensitive brand. Sensitive brands remove implicit access: only explicit grants count.
 *   - Effective brand level = max(explicit grant, implicit level). No level → the brand does not
 *     exist for the caller (`not_found`); `forbidden` only when the brand is readable.
 *   - All-brands is the union of the brands the caller may view, never a wildcard.
 */

export const LEVELS = ['view', 'comment', 'edit', 'manage'] as const;
export type Level = (typeof LEVELS)[number];
export const WORKSPACE_ROLES = [
  'owner',
  'administrator',
  'member',
  'limited_member',
  'read_only',
  'guest',
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Roles with implicit manage on the workspace and non-sensitive brands (0C §5.2). */
const IMPLICIT_MANAGERS: ReadonlySet<WorkspaceRole> = new Set(['owner', 'administrator']);

export function levelRank(l: Level | null): number {
  return l === null ? -1 : LEVELS.indexOf(l);
}
export function maxLevel(a: Level | null, b: Level | null): Level | null {
  return levelRank(a) >= levelRank(b) ? a : b;
}

/** The compiled principal for one request (never sent to clients). */
export interface Principal {
  readonly workspaceId: string;
  readonly membershipId: string;
  readonly accountId: string;
  readonly role: WorkspaceRole | null;
  /** Explicit brand-scope grants: brand id → highest granted level. */
  readonly grants: ReadonlyMap<string, Level>;
  readonly epochs: { readonly workspace: number; readonly principal: number };
}

export interface BrandFacts {
  id: string;
  isSensitive: boolean;
  lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
}

export type Cell = { kind: 'implicit' } | { kind: 'deny' } | { kind: 'grant'; level: Level };

const ACTION_INDEX = new Map<string, (typeof ACTIONS)[number]>(ACTIONS.map((a) => [a.key, a]));

export function actionDef(action: ActionKey): (typeof ACTIONS)[number] {
  const def = ACTION_INDEX.get(action);
  if (!def) throw new Error(`unknown action ${action}`);
  return def;
}

export function cell(action: ActionKey, role: WorkspaceRole | null): Cell {
  if (role === null) return { kind: 'deny' };
  const raw = (actionDef(action).roles as Record<string, string>)[role] ?? 'deny';
  if (raw === 'implicit') return { kind: 'implicit' };
  const m = /^grant:(view|comment|edit|manage)$/.exec(raw);
  return m ? { kind: 'grant', level: m[1] as Level } : { kind: 'deny' };
}

/** Effective level on a brand; null = the brand does not exist for this principal. */
export function brandLevel(p: Principal, brand: BrandFacts): Level | null {
  if (brand.lifecycleState === 'trashed' || brand.lifecycleState === 'purged') return null;
  const explicit = p.grants.get(brand.id) ?? null;
  const implicit: Level | null =
    p.role !== null && IMPLICIT_MANAGERS.has(p.role) && !brand.isSensitive ? 'manage' : null;
  return maxLevel(explicit, implicit);
}

export type Outcome = { allowed: true } | { allowed: false; code: 'not_found' | 'forbidden' };
const ALLOW: Outcome = { allowed: true };
const NOT_FOUND: Outcome = { allowed: false, code: 'not_found' };
const FORBIDDEN: Outcome = { allowed: false, code: 'forbidden' };

/** Workspace-scope actions (`workspace.*`, `brand.create`): the member can see the workspace. */
export function decideWorkspace(p: Principal, action: ActionKey): Outcome {
  if (!(actionDef(action).scopes as readonly string[]).includes('workspace'))
    throw new Error('not a workspace action');
  const c = cell(action, p.role);
  return c.kind === 'implicit' ? ALLOW : FORBIDDEN;
}

/**
 * Brand-scope actions. `implicit` cells apply through the role only on non-sensitive brands; on a
 * sensitive brand the same cell needs an explicit `manage` grant (the creator grant, 0C §6.3).
 */
export function decideBrand(p: Principal, action: ActionKey, brand: BrandFacts): Outcome {
  if (!(actionDef(action).scopes as readonly string[]).includes('brand'))
    throw new Error('not a brand action');
  const level = brandLevel(p, brand);
  if (level === null) return NOT_FOUND;
  const c = cell(action, p.role);
  if (c.kind === 'deny') return FORBIDDEN;
  if (c.kind === 'grant') return levelRank(level) >= levelRank(c.level) ? ALLOW : FORBIDDEN;
  // implicit: the role grants it, but a sensitive brand demands explicit manage.
  if (!brand.isSensitive) return ALLOW;
  return p.grants.get(brand.id) === 'manage' ? ALLOW : FORBIDDEN;
}

/** Visibility predicate inputs for SQL (filter before pagination and counts, 0C §4.5). */
export function brandVisibility(p: Principal): {
  implicitNonSensitive: boolean;
  grantedIds: string[];
} {
  return {
    implicitNonSensitive: p.role !== null && IMPLICIT_MANAGERS.has(p.role),
    grantedIds: [...p.grants.keys()].sort(),
  };
}

/** Client-facing capability flags (booleans only; no grants, roles, or compiler internals). */
export function brandCapabilities(p: Principal, brand: BrandFacts) {
  const allowed = (a: ActionKey) => decideBrand(p, a, brand).allowed;
  const active = brand.lifecycleState === 'active';
  return {
    configure: active && allowed('brand.configure'),
    archive: active && allowed('brand.archive'),
    restore: brand.lifecycleState === 'archived' && allowed('brand.archive'),
    mark_sensitive: active && allowed('brand.mark_sensitive'),
  };
}

export function workspaceCapabilities(p: Principal) {
  return {
    configure: decideWorkspace(p, 'workspace.configure').allowed,
    create_brand: decideWorkspace(p, 'brand.create').allowed,
  };
}
