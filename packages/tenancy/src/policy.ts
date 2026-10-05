import {
  ACTIONS,
  ROLE_DEFINITIONS,
  WORKSPACE_POLICY_FIELDS,
  type ActionKey,
  type WorkspacePolicyField,
} from '@pm/contracts';

/**
 * The authorization compiler (0C §4-§6): built in 1C, extended in 1D. One compiler serves every
 * consumer (API, worker, future search/AI/agents) through decisions and SQL predicate inputs.
 *
 * Inputs are canonical: the caller's active `tenancy.membership`, its single workspace role, its
 * brand-scope grants (direct and through teams), its record grants, the workspace policy, and the
 * permission epochs. Nothing is inferred from who created a row, a browser claim, an email
 * address, or a session flag, and there is no generic "is admin" bypass.
 *
 * Rules (0C §4.2-§4.3):
 *   - Tenant isolation first (RLS + the transaction context); then the role's matrix cell.
 *   - Workspace access never flows into brands. Owners and administrators hold implicit `manage`
 *     on the workspace and on every non-sensitive brand; sensitive brands need explicit grants.
 *   - Brand grants (direct or via team) flow to the brand's records; record grants apply to that
 *     exact record only; the maximum counting level wins; the role cap applies last
 *     (`read_only` → view, `guest` → the share level, at most edit).
 *   - Guests have no workspace, brand, team, directory, aggregation, or trash access.
 *   - No level → `not_found`; `forbidden` only when the target is readable.
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
export type ShareLevel = 'read' | 'comment' | 'edit';

/** Roles with implicit manage on the workspace and non-sensitive brands (0C §3.1). */
const IMPLICIT_MANAGERS: ReadonlySet<WorkspaceRole> = new Set(['owner', 'administrator']);
const ROLE_INDEX = new Map(ROLE_DEFINITIONS.map((r) => [r.id as WorkspaceRole, r]));

export function levelRank(l: Level | null): number {
  return l === null ? -1 : LEVELS.indexOf(l);
}
export function maxLevel(a: Level | null, b: Level | null): Level | null {
  return levelRank(a) >= levelRank(b) ? a : b;
}
export function minLevel(a: Level | null, b: Level | null): Level | null {
  if (a === null || b === null) return null;
  return levelRank(a) <= levelRank(b) ? a : b;
}
export function shareToLevel(s: ShareLevel): Level {
  return s === 'read' ? 'view' : s;
}

// -------------------------------------------------------------------------------------------
// Workspace policy (0C AZ-19): generated defaults, typed values
// -------------------------------------------------------------------------------------------

export type WorkspacePolicyValues = {
  [K in WorkspacePolicyField]: unknown;
} & {
  members_invite_guests: boolean;
  comment_on_archived: boolean;
  workspace_records_default_level: 'none' | 'view' | 'comment' | 'edit';
  cross_brand_sharing_enabled: boolean;
  guest_invitations_enabled: boolean;
  public_links_enabled: boolean;
  share_max_expiry: string | null;
};

export const DEFAULT_POLICY: WorkspacePolicyValues = Object.freeze(
  Object.fromEntries(WORKSPACE_POLICY_FIELDS.map((f) => [f.field, f.default])),
) as WorkspacePolicyValues;

// -------------------------------------------------------------------------------------------
// The compiled principal
// -------------------------------------------------------------------------------------------

/** Where a brand level came from (preview explanations; never sent with internal IDs). */
export interface GrantSource {
  brandId: string;
  level: Level;
  via: 'direct' | 'team';
  teamId: string | null;
  expiresAt: Date | null;
}

/** Where a project level came from (preview explanations). */
export interface ProjectGrantSource {
  projectId: string;
  level: Level;
  via: 'direct' | 'team';
  teamId: string | null;
  expiresAt: Date | null;
}

/** The compiled principal for one request (never sent to clients). */
export interface Principal {
  readonly workspaceId: string;
  readonly membershipId: string;
  readonly accountId: string;
  readonly kind: 'member' | 'guest';
  readonly role: WorkspaceRole | null;
  /** Explicit brand-scope grants (direct ∪ team): brand id → highest granted level. */
  readonly grants: ReadonlyMap<string, Level>;
  readonly grantSources: readonly GrantSource[];
  /**
   * Explicit project-scope grants (direct ∪ team, 0C AZ-21): project id → highest granted level.
   * The only collaborator authority; empty for guests (no scope assignments, AZ-06).
   */
  readonly projectGrants: ReadonlyMap<string, Level>;
  readonly projectGrantSources: readonly ProjectGrantSource[];
  /** Active team memberships (internal members only). */
  readonly teams: readonly string[];
  readonly policy: WorkspacePolicyValues;
  readonly epochs: { readonly workspace: number; readonly principal: number };
}

export interface BrandFacts {
  id: string;
  isSensitive: boolean;
  lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
}

/** The role cap (0C §4.2 step 5): read-only → view; guest → the share level (at most edit). */
export function roleCap(role: WorkspaceRole | null): Level | null {
  if (role === null) return null;
  const cap = ROLE_INDEX.get(role)?.levelCap as Level | null | undefined;
  return cap ?? 'manage';
}

/** Level on workspace-scoped records (`brand_id IS NULL`); never flows into brands. */
export function workspaceLevel(p: Principal): Level | null {
  if (p.kind === 'guest' || p.role === null) return null;
  if (IMPLICIT_MANAGERS.has(p.role)) return 'manage';
  if (p.role === 'limited_member') return null;
  const d = p.policy.workspace_records_default_level;
  return minLevel(d === 'none' ? null : d, roleCap(p.role));
}

/** Effective level on a brand; null = the brand does not exist for this principal. */
export function brandLevel(p: Principal, brand: BrandFacts): Level | null {
  if (brand.lifecycleState === 'trashed' || brand.lifecycleState === 'purged') return null;
  if (p.kind === 'guest') return null;
  const explicit = p.grants.get(brand.id) ?? null;
  const implicit: Level | null =
    p.role !== null && IMPLICIT_MANAGERS.has(p.role) && !brand.isSensitive ? 'manage' : null;
  return minLevel(maxLevel(explicit, implicit), roleCap(p.role));
}

/**
 * The governing project chain of a record (0C §4.3, AZ-21): the project itself (or the project
 * containing the record) first, then each ancestor up to the root. `restricted` is the project's
 * own access mode; restriction is inherited by descendants for the purpose of stopping broader
 * grants (DQ-02).
 */
export type ProjectChain = ReadonlyArray<{ readonly id: string; readonly restricted: boolean }>;

/**
 * Project-derived authority over a chain: explicit project grants flow down to descendants until a
 * restricted project; brand, workspace, and implicit role access count only when no project on the
 * chain is restricted. Ownership is never authority (I-10).
 */
export function projectChainLevel(
  p: Principal,
  chain: ProjectChain,
): { explicit: Level | null; brandAllowed: boolean } {
  let explicit: Level | null = null;
  let flowing = true;
  for (const node of chain) {
    if (flowing) explicit = maxLevel(explicit, p.projectGrants.get(node.id) ?? null);
    if (node.restricted) flowing = false;
  }
  return { explicit, brandAllowed: !chain.some((n) => n.restricted) };
}

/**
 * Effective level on a record (0C §4.3): workspace-scoped or brand-scoped envelopes, project
 * scope (restriction and explicit project grants, AZ-21), plus exact-record shares.
 */
export function recordLevel(
  p: Principal,
  record: {
    brand: BrandFacts | null;
    lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
    shareLevel: ShareLevel | null;
    projectChain?: ProjectChain | null;
  },
): Level | null {
  if (record.lifecycleState === 'purged' || record.lifecycleState === 'trashed') return null;
  const chain = record.projectChain ?? [];
  const project = chain.length ? projectChainLevel(p, chain) : null;
  let lv: Level | null = null;
  if (record.brand === null) lv = workspaceLevel(p);
  else if (
    record.brand.lifecycleState !== 'trashed' &&
    record.brand.lifecycleState !== 'purged' &&
    (project === null || project.brandAllowed)
  )
    lv = brandLevel(p, { ...record.brand, lifecycleState: 'active' });
  if (project && p.kind !== 'guest' && record.brand?.lifecycleState !== 'trashed')
    lv = maxLevel(lv, project.explicit);
  if (record.shareLevel) lv = maxLevel(lv, shareToLevel(record.shareLevel));
  lv = minLevel(lv, roleCap(p.role));
  if (lv !== null && p.kind === 'guest') lv = minLevel(lv, 'edit');
  if (lv !== null && record.lifecycleState === 'archived')
    lv = minLevel(lv, p.policy.comment_on_archived ? 'comment' : 'view');
  return lv;
}

// -------------------------------------------------------------------------------------------
// Matrix cells and decisions
// -------------------------------------------------------------------------------------------

export type Cell =
  | { kind: 'implicit' }
  | { kind: 'deny' }
  | { kind: 'own' }
  | { kind: 'policy'; key: string }
  | { kind: 'grant'; level: Level };

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
  if (raw === 'own') return { kind: 'own' };
  const pol = /^policy:([a-z_]+)$/.exec(raw);
  if (pol) return { kind: 'policy', key: pol[1]! };
  const m = /^grant:(view|comment|edit|manage)$/.exec(raw);
  return m ? { kind: 'grant', level: m[1] as Level } : { kind: 'deny' };
}

function policyAllows(p: Principal, key: string): boolean {
  return (p.policy as Record<string, unknown>)[key] === true;
}

export type Outcome = { allowed: true } | { allowed: false; code: 'not_found' | 'forbidden' };
const ALLOW: Outcome = { allowed: true };
const NOT_FOUND: Outcome = { allowed: false, code: 'not_found' };
const FORBIDDEN: Outcome = { allowed: false, code: 'forbidden' };

function scoped(action: ActionKey, scope: string): void {
  if (!(actionDef(action).scopes as readonly string[]).includes(scope))
    throw new Error(`${action} is not a ${scope}-scope action`);
}

/**
 * Workspace-scope actions. `implicit` → allowed; `policy:x` → the workspace policy decides;
 * `grant:<level>` → the workspace level; `own` → the caller acts on their own target only (the
 * command checks ownership). Account commands never reach here (0C AZ-18/19).
 */
export function decideWorkspace(p: Principal, action: ActionKey): Outcome {
  scoped(action, 'workspace');
  const c = cell(action, p.role);
  switch (c.kind) {
    case 'implicit':
    case 'own':
      return ALLOW;
    case 'policy':
      return policyAllows(p, c.key) ? ALLOW : FORBIDDEN;
    case 'grant':
      return levelRank(workspaceLevel(p)) >= levelRank(c.level) ? ALLOW : FORBIDDEN;
    default:
      return FORBIDDEN;
  }
}

/**
 * Personal-scope actions (0C kind `personal`): `own` means the caller acts on their own personal
 * data in this workspace (favorites, recents, view state); anything else is denied. Account
 * commands never reach here (they have no membership yet).
 */
export function decidePersonal(p: Principal, action: ActionKey): Outcome {
  scoped(action, 'personal');
  return cell(action, p.role).kind === 'own' ? ALLOW : FORBIDDEN;
}

/**
 * Brand-scope actions. `implicit` cells apply through the role only on non-sensitive brands; on a
 * sensitive brand the same cell needs an explicit `manage` grant (the creator grant, 0C §4.4).
 */
export function decideBrand(p: Principal, action: ActionKey, brand: BrandFacts): Outcome {
  scoped(action, 'brand');
  const level = brandLevel(p, brand);
  if (level === null) return NOT_FOUND;
  const c = cell(action, p.role);
  switch (c.kind) {
    case 'deny':
    case 'own':
      return FORBIDDEN;
    case 'policy':
      return policyAllows(p, c.key) ? ALLOW : FORBIDDEN;
    case 'grant':
      return levelRank(level) >= levelRank(c.level) ? ALLOW : FORBIDDEN;
    default:
      if (!brand.isSensitive) return ALLOW;
      return p.grants.get(brand.id) === 'manage' ? ALLOW : FORBIDDEN;
  }
}

/**
 * Record-scope actions (0C §4.3 `authorize`): the role cell first, then the effective level.
 * Share-derived access never authorizes onward sharing (`ownershipLevel` excludes shares, AT-050).
 */
export function decideRecord(
  p: Principal,
  action: ActionKey,
  record: Parameters<typeof recordLevel>[1],
): Outcome {
  scoped(action, 'record');
  const def = actionDef(action);
  const lv = recordLevel(p, record);
  if (lv === null) return NOT_FOUND;
  const c = cell(action, p.role);
  if (c.kind === 'deny') return FORBIDDEN;
  if (c.kind === 'policy' && !policyAllows(p, c.key)) return FORBIDDEN;
  const need =
    (def.requiredLevel as Level | null) ?? (c.kind === 'grant' ? c.level : null) ?? 'view';
  const sharing = action === 'record.share' || action === 'record.share_revoke';
  const effective = sharing ? recordLevel(p, { ...record, shareLevel: null }) : lv;
  if (c.kind === 'implicit' && !sharing)
    return levelRank(lv) >= levelRank(need) ? ALLOW : FORBIDDEN;
  return levelRank(effective) >= levelRank(need) ? ALLOW : FORBIDDEN;
}

// -------------------------------------------------------------------------------------------
// Grantable authority (0C §3.1, I-11)
// -------------------------------------------------------------------------------------------

export function canAssignRole(assigner: WorkspaceRole | null, target: WorkspaceRole): boolean {
  if (assigner === null) return false;
  return ((ROLE_INDEX.get(assigner)?.canAssign ?? []) as readonly string[]).includes(target);
}

/**
 * May `p` change a membership from `from` to `to` (or remove/suspend it when `to` is null)?
 * Owners are managed only by owners, and nobody grants a role they cannot assign.
 */
export function canManageMember(
  p: Principal,
  from: WorkspaceRole,
  to: WorkspaceRole | null,
): boolean {
  if (!decideWorkspace(p, 'membership.manage').allowed) return false;
  if (!canAssignRole(p.role, from)) return false;
  return to === null || canAssignRole(p.role, to);
}

/**
 * Project-scope admin actions (`access.grant_scope`, `access.restrict_scope`, `access.preview`,
 * `record.create` inside a project): the role cell, then the caller's project level computed like
 * a record level without shares. `implicit` reaches non-restricted projects in non-sensitive brands
 * only; restricted chains and sensitive brands need an explicit project manage grant.
 */
export function decideProject(
  p: Principal,
  action: ActionKey,
  project: {
    brand: BrandFacts;
    lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
    chain: ProjectChain;
  },
): Outcome {
  scoped(action, 'project');
  const lv = recordLevel(p, {
    brand: project.brand,
    lifecycleState: project.lifecycleState,
    shareLevel: null,
    projectChain: project.chain,
  });
  if (lv === null) return NOT_FOUND;
  const c = cell(action, p.role);
  switch (c.kind) {
    case 'deny':
    case 'own':
      return FORBIDDEN;
    case 'policy':
      return policyAllows(p, c.key) ? ALLOW : FORBIDDEN;
    case 'grant':
      return levelRank(lv) >= levelRank(c.level) ? ALLOW : FORBIDDEN;
    default: {
      const need = (actionDef(action).requiredLevel as Level | null) ?? 'manage';
      return levelRank(lv) >= levelRank(need) ? ALLOW : FORBIDDEN;
    }
  }
}

/** May `p` grant `level` on a project? Never above the granter's own project level. */
export function canGrantProject(
  p: Principal,
  project: Parameters<typeof decideProject>[2],
  level: Level,
): boolean {
  if (!decideProject(p, 'access.grant_scope', project).allowed) return false;
  return (
    levelRank(
      recordLevel(p, {
        brand: project.brand,
        lifecycleState: project.lifecycleState,
        shareLevel: null,
        projectChain: project.chain,
      }),
    ) >= levelRank(level)
  );
}

/** May `p` grant `level` on `brand`? Never above the granter's own level (0C §3.2 manage). */
export function canGrantBrand(p: Principal, brand: BrandFacts, level: Level): boolean {
  if (!decideBrand(p, 'access.grant_scope', brand).allowed) return false;
  return levelRank(brandLevel(p, brand)) >= levelRank(level);
}

// -------------------------------------------------------------------------------------------
// SQL predicate inputs (filter before pagination and counts, 0C §4.5)
// -------------------------------------------------------------------------------------------

export function brandVisibility(p: Principal): {
  implicitNonSensitive: boolean;
  grantedIds: string[];
} {
  return {
    implicitNonSensitive: p.kind === 'member' && p.role !== null && IMPLICIT_MANAGERS.has(p.role),
    grantedIds: p.kind === 'guest' ? [] : [...p.grants.keys()].sort(),
  };
}

/**
 * Record-grant subject keys (0C §4.3): membership ∪ active teams ∪ brands viewable through a
 * non-restricted path. Brand contexts are never included for guests.
 */
export function subjectKeys(p: Principal, viewableBrandIds: readonly string[]): string[] {
  const keys = [p.membershipId, ...p.teams];
  if (p.kind !== 'guest') keys.push(...viewableBrandIds);
  return [...new Set(keys)].sort();
}

// -------------------------------------------------------------------------------------------
// Client-facing capability flags (booleans only; no grants, roles, or compiler internals)
// -------------------------------------------------------------------------------------------

export function brandCapabilities(p: Principal, brand: BrandFacts) {
  const allowed = (a: ActionKey) => decideBrand(p, a, brand).allowed;
  const active = brand.lifecycleState === 'active';
  return {
    configure: active && allowed('brand.configure'),
    archive: active && allowed('brand.archive'),
    restore: brand.lifecycleState === 'archived' && allowed('brand.archive'),
    mark_sensitive: active && allowed('brand.mark_sensitive'),
    grant_access: active && allowed('access.grant_scope'),
    /** `record.create` in the brand (projects today), the same decision the create command makes. */
    create_records: active && allowed('record.create'),
  };
}

export function workspaceCapabilities(p: Principal) {
  const ok = (a: ActionKey) => decideWorkspace(p, a).allowed;
  return {
    configure: ok('workspace.configure'),
    create_brand: ok('brand.create'),
    manage_people: ok('membership.manage'),
    invite_members: ok('membership.invite_member'),
    invite_guests:
      p.policy.guest_invitations_enabled &&
      (cell('membership.invite_guest', p.role).kind === 'implicit' ||
        (cell('membership.invite_guest', p.role).kind === 'policy' &&
          p.policy.members_invite_guests)),
    manage_teams: ok('team.manage'),
    preview_access: ok('access.preview'),
    configure_sharing: ok('sharing.policy.configure'),
    transfer_ownership: ok('ownership.transfer'),
    view_directory: p.kind === 'member',
  };
}
