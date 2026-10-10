import { createHash, createHmac } from 'node:crypto';
import { change } from '@pm/audit';
import {
  ACTIONS,
  newPublicId,
  newUuidV7,
  WORKSPACE_POLICY_FIELDS,
  type ActionKey,
} from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { EmailFormatError, normalizeEmail, type IdentityService } from '@pm/identity';
import { createRecord, LifecycleError } from '@pm/lifecycle';
import { issueLifecycleDecision } from '@pm/lifecycle/policy-issuer';
import { requestJobCancel, writeOutboxEvent } from '@pm/platform';
import { authorizeAccountCommand } from './account-commands.ts';
import { brandMarker } from './brands.ts';
import { invalid, issue, TenancyError } from './errors.ts';
import { defaultOwnershipRegistry, type OwnershipRegistry } from './ownership.ts';
import {
  brandLevel,
  canAssignRole,
  canGrantBrand,
  canGrantProject,
  canManageMember,
  decideBrand,
  decideProject,
  decideRecord,
  decideWorkspace,
  levelRank,
  LEVELS,
  maxLevel,
  recordLevel,
  roleCap,
  shareToLevel,
  WORKSPACE_ROLES,
  type Level,
  type Principal,
  type ProjectChain,
  type ShareLevel,
  type WorkspaceRole,
} from './policy.ts';
import {
  brandRefs,
  explain,
  exposureDiff,
  inspectable,
  previewToken,
  verifyPreviewToken,
  visibleDelta,
  type BrandRef,
  type ExposureDiff,
} from './preview.ts';
import { bumpEpoch, compilePrincipal } from './principal.ts';
import {
  TenancyService,
  type Caller,
  type Mutation,
  type Result,
  type TenancyDeps,
} from './service.ts';
import { Issues, text } from './validation.ts';
import { governingProjectId, projectChainOf } from './projects.ts';
import { shareableLevels, sharesChildren } from './sharing.ts';
import { compileVisibility } from './visibility.ts';

/** Identity capabilities the collaboration commands borrow (1B tokens, mail, sessions, step-up). */
export type CollaborationIdentityPort = Pick<
  IdentityService,
  | 'issueInvitationToken'
  | 'revokeInvitationToken'
  | 'lookupInvitationToken'
  | 'consumeInvitationToken'
  | 'revokeSessionsForDeparture'
  | 'consumeWorkspaceStepUp'
  | 'createStepUpChallenge'
>;

/**
 * Seat/entitlement hook (OD-44 unset): consulted before any mutation that adds a person. The
 * default allows; a billing module may deny without this module inventing plan numbers.
 */
export interface SeatPort {
  canAdd(tx: WorkspaceTransaction, kind: 'member' | 'guest'): Promise<boolean>;
}
export const UNLIMITED_SEATS: SeatPort = { canAdd: () => Promise.resolve(true) };

export interface CollaborationSettings {
  invitationLifetimeMs: number;
  ownershipTransferLifetimeMs: number;
  principalContextArrayMax: number;
  /** Preview fingerprints are short-lived (minutes). */
  previewTtlMs: number;
}

export interface CollaborationDeps extends TenancyDeps {
  identity: CollaborationIdentityPort;
  ownership?: OwnershipRegistry;
  seats?: SeatPort;
  settings: CollaborationSettings;
}

const MEMBER_ROLES = ['owner', 'administrator', 'member', 'limited_member', 'read_only'] as const;
type MemberRole = (typeof MEMBER_ROLES)[number];
const SHARE_LEVELS = ['read', 'comment', 'edit'] as const;
const PUBLIC = (prefix: string) => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface MemberRow {
  id: string;
  public_id: string;
  account_id: string;
  kind: 'member' | 'guest';
  state: 'invited' | 'active' | 'suspended' | 'removed';
  version: string | number;
  joined_at: Date | null;
  display_name: string;
  display_name_override: string | null;
  email: string;
  role: WorkspaceRole | null;
}

/** A proposed permission change, previewed and then applied with the same description. */
export type ProposedChange =
  | { kind: 'role'; member: string; role: MemberRole }
  | { kind: 'suspend' | 'remove'; member: string }
  | {
      kind: 'brand_grant';
      brand: string;
      principal: string;
      level: Level;
      expires_at: string | null;
    }
  | { kind: 'brand_revoke'; brand: string; principal: string }
  | { kind: 'team_add' | 'team_remove'; team: string; member: string }
  | { kind: 'project_grant'; project: string; principal: string; level: Level }
  | { kind: 'project_revoke'; project: string; principal: string }
  | {
      kind: 'record_share';
      record: string;
      grantee: string;
      level: ShareLevel;
      expires_at: string | null;
    };

/** One reviewed change: target principals before/after, the epochs it was computed under, and its apply step. */
interface Proposal {
  change: ProposedChange;
  pairs: Array<{ before: Principal | null; after: Principal | null }>;
  epochs: unknown;
  /** Project scope changes: the exact delta and the project's level change are previewed. */
  project?: ProjectRef;
  /** Shares: the exact record the grantees gain. */
  sharedRecord?: { id: string; type: string };
  apply: (caller: Caller) => Promise<{ ref: { id: string; type: string } }>;
}

/** A project as a scope target (public id, brand facts, governing chain). */
interface ProjectRef {
  id: string;
  publicId: string;
  name: string;
  brand: BrandRef;
  lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
  chain: ProjectChain;
}

interface TeamRef {
  id: string;
  publicId: string;
  name: string;
  description: string | null;
  lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
  version: number;
}

interface Grantee {
  type: 'membership' | 'team';
  id: string;
  publicId: string;
  currentBrandLevel(brandId: string): Level | null;
  members(): Promise<Array<{ id: string; account_id: string; kind: 'member' | 'guest' }>>;
}

interface ShareTarget {
  id: string;
  publicId: string;
  recordType: string;
  brandId: string | null;
  levels: readonly ShareLevel[];
  sharesChildren: boolean;
}

/** Share target resolution (0C AZ-21): unreadable → not_found; readable but not shareable → forbidden. */
type ShareResolution =
  | { kind: 'ok'; target: ShareTarget }
  | { kind: 'not_found' }
  | {
      kind: 'forbidden';
      reason: 'not_shareable_type' | 'not_permitted' | 'record_shares_disallowed';
    };

const SHARE_REFUSAL = {
  not_shareable_type: "This kind of item can't be shared.",
  not_permitted: "You don't have permission to share this item.",
  record_shares_disallowed: 'This restricted project does not allow sharing individual items.',
} as const;

function pg(err: unknown): { code?: string; constraint?: string; message?: string } {
  return typeof err === 'object' && err !== null
    ? (err as { code?: string; constraint?: string; message?: string })
    : {};
}

/**
 * Phase 1D collaboration commands on the canonical 1C tables: people, invitations, teams, brand
 * access, explicit record shares, permission preview, workspace policy, ownership transfer, and
 * departure. Every permission-changing command: loads the target through current visibility,
 * checks grantable authority and last-owner rules, verifies the reviewed exposure preview under
 * lock, mutates canonical rows, bumps epochs, and writes audit, security, and outbox events in the
 * same transaction.
 */
export class CollaborationService extends TenancyService {
  protected readonly c: CollaborationDeps;
  readonly #ownership: OwnershipRegistry;
  readonly #seats: SeatPort;
  readonly #previewKey: Buffer;

  constructor(deps: CollaborationDeps) {
    super(deps);
    this.c = deps;
    this.#ownership = deps.ownership ?? defaultOwnershipRegistry();
    this.#seats = deps.seats ?? UNLIMITED_SEATS;
    this.#previewKey = createHmac('sha256', deps.signingKey).update('preview:tenancy').digest();
  }

  get ownership(): OwnershipRegistry {
    return this.#ownership;
  }

  // ---------------------------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------------------------

  #require(
    p: Principal,
    action: ActionKey,
    ok: boolean,
    code: 'forbidden' | 'not_found' = 'forbidden',
  ): void {
    this.decision(action, ok ? { allowed: true } : { allowed: false, code });
    if (!ok) throw new TenancyError(code);
  }

  /** People surfaces are internal-only: guests have no directory (0C §6.1). */
  #directory(p: Principal): void {
    if (p.kind === 'guest') throw new TenancyError('not_found');
  }

  async #member(tx: WorkspaceTransaction, publicId: unknown, lock = false): Promise<MemberRow> {
    if (typeof publicId !== 'string' || !PUBLIC('mem').test(publicId))
      throw new TenancyError('not_found');
    let q = tx.db
      .selectFrom('tenancy.membership as m')
      .innerJoin('identity.account as a', 'a.id', 'm.account_id')
      .leftJoin('access.role_assignment as ra', (j) =>
        j
          .onRef('ra.workspace_id', '=', 'm.workspace_id')
          .onRef('ra.membership_principal_id', '=', 'm.id')
          .on('ra.scope_type', '=', 'workspace'),
      )
      .leftJoin('access.role as r', (j) =>
        j.onRef('r.workspace_id', '=', 'ra.workspace_id').onRef('r.id', '=', 'ra.role_id'),
      )
      .select([
        'm.id',
        'm.public_id',
        'm.account_id',
        'm.kind',
        'm.state',
        'm.version',
        'm.joined_at',
        'm.display_name_override',
        'a.display_name',
        'a.primary_email as email',
        'r.key as role',
      ])
      .where('m.public_id', '=', publicId);
    if (lock) q = q.forUpdate('m');
    const row = (await q.executeTakeFirst()) as MemberRow | undefined;
    if (!row) throw new TenancyError('not_found');
    if (row.kind === 'guest') row.role = 'guest';
    return row;
  }

  #memberView(p: Principal, m: MemberRow, teams: string[] = []) {
    const managesPeople = decideWorkspace(p, 'membership.manage').allowed;
    const role = (m.role ?? (m.kind === 'guest' ? 'guest' : null)) as WorkspaceRole | null;
    const self = m.id === p.membershipId;
    const can = (to: WorkspaceRole | null) =>
      role !== null && role !== 'guest' && canManageMember(p, role, to);
    return {
      id: m.public_id,
      type: 'membership' as const,
      display_name: m.display_name_override ?? m.display_name,
      // Email is shown to people managers and inviters only; never to guests (no directory).
      email:
        managesPeople || decideWorkspace(p, 'membership.invite_member').allowed ? m.email : null,
      kind: m.kind,
      role,
      state: m.state,
      joined_at: m.joined_at ? new Date(m.joined_at).toISOString() : null,
      is_you: self,
      version: Number(m.version),
      teams: managesPeople ? teams : [],
      capabilities: {
        change_role: !self && m.state === 'active' && m.kind === 'member' && can(role),
        suspend: !self && m.state === 'active' && (m.kind === 'guest' ? managesPeople : can(null)),
        reactivate:
          !self && m.state === 'suspended' && (m.kind === 'guest' ? managesPeople : can(null)),
        remove:
          !self &&
          (m.state === 'active' || m.state === 'suspended') &&
          (m.kind === 'guest' ? managesPeople : can(null)),
      },
    };
  }

  async #teamNames(tx: WorkspaceTransaction): Promise<Map<string, string>> {
    const rows = await tx.db.selectFrom('tenancy.team').select(['id', 'name']).execute();
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async #event(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    type:
      | 'tenancy.membership.activated'
      | 'tenancy.membership.suspended'
      | 'tenancy.membership.removed'
      | 'access.role.assigned'
      | 'access.role.revoked'
      | 'access.grant.created'
      | 'access.grant.revoked'
      | 'tenancy.team.membership_changed'
      | 'tenancy.ownership.transferred',
    aggregate: { type: string; id: string; sequence: number },
    data: Record<string, string | boolean | null>,
  ): Promise<void> {
    await writeOutboxEvent(tx, {
      type,
      aggregate,
      data,
      actor: { type: 'human', id: p.membershipId },
      context: this.exec(caller, p),
    });
  }

  async #audit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    target: { recordId: string | null; type: string; publicId: string | null },
    changes: ReturnType<typeof change.plain>[] = [],
    brandId: string | null = null,
  ): Promise<void> {
    await this.d.writer.write(tx, this.cmd(caller, p, brandId), { action, target, changes });
  }

  // ---------------------------------------------------------------------------------------------
  // People (COL-001/002, PERM-013/014)
  // ---------------------------------------------------------------------------------------------

  async listMembers(
    caller: Caller,
    workspacePublicId: unknown,
    query: { state?: unknown; kind?: unknown; q?: unknown },
  ) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      this.#directory(p);
      const managers = decideWorkspace(p, 'membership.manage').allowed;
      const states =
        query.state === 'removed' && managers
          ? ['removed']
          : query.state === 'suspended'
            ? ['suspended']
            : query.state === 'active'
              ? ['active']
              : managers
                ? ['active', 'suspended']
                : ['active'];
      if (
        query.state !== undefined &&
        !['active', 'suspended', 'removed', 'all'].includes(String(query.state))
      )
        throw invalid(
          issue('/query/state', 'invalid_option', 'Use active, suspended, or removed.'),
        );
      const term = typeof query.q === 'string' ? query.q.trim().toLowerCase().slice(0, 80) : '';
      let q = tx.db
        .selectFrom('tenancy.membership as m')
        .innerJoin('identity.account as a', 'a.id', 'm.account_id')
        .leftJoin('access.role_assignment as ra', (j) =>
          j
            .onRef('ra.workspace_id', '=', 'm.workspace_id')
            .onRef('ra.membership_principal_id', '=', 'm.id')
            .on('ra.scope_type', '=', 'workspace'),
        )
        .leftJoin('access.role as r', (j) =>
          j.onRef('r.workspace_id', '=', 'ra.workspace_id').onRef('r.id', '=', 'ra.role_id'),
        )
        .select([
          'm.id',
          'm.public_id',
          'm.account_id',
          'm.kind',
          'm.state',
          'm.version',
          'm.joined_at',
          'm.display_name_override',
          'a.display_name',
          'a.primary_email as email',
          'r.key as role',
        ])
        .where('m.state', 'in', states as never)
        .orderBy(sql`lower(coalesce(m.display_name_override, a.display_name))`)
        .orderBy('m.id')
        .limit(500);
      if (query.kind === 'member' || query.kind === 'guest') q = q.where('m.kind', '=', query.kind);
      if (term)
        q = q.where((eb) =>
          managers
            ? eb.or([
                eb(
                  sql`lower(coalesce(m.display_name_override, a.display_name))`,
                  'like',
                  `%${term}%`,
                ),
                eb(sql`lower(a.primary_email)`, 'like', `%${term}%`),
              ])
            : eb(
                sql`lower(coalesce(m.display_name_override, a.display_name))`,
                'like',
                `%${term}%`,
              ),
        );
      const rows = (await q.execute()) as MemberRow[];
      const teamRows = managers
        ? await tx.db
            .selectFrom('tenancy.team_member as tm')
            .innerJoin('tenancy.team as t', (j) =>
              j.onRef('t.workspace_id', '=', 'tm.workspace_id').onRef('t.id', '=', 'tm.team_id'),
            )
            .select(['tm.membership_id', 't.name'])
            .where('t.lifecycle_state', '=', 'active')
            .execute()
        : [];
      const teams = new Map<string, string[]>();
      for (const t of teamRows)
        teams.set(t.membership_id, [...(teams.get(t.membership_id) ?? []), t.name]);
      return rows.map((m) =>
        this.#memberView(
          p,
          m.kind === 'guest' ? { ...m, role: 'guest' } : m,
          (teams.get(m.id) ?? []).sort(),
        ),
      );
    });
  }

  async getMember(caller: Caller, workspacePublicId: unknown, memberPublicId: unknown) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      this.#directory(p);
      const m = await this.#member(tx, memberPublicId);
      if (m.state === 'removed' && !decideWorkspace(p, 'membership.manage').allowed)
        throw new TenancyError('not_found');
      return this.#memberView(p, m);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Preview (PERM-011, PERM-012)
  // ---------------------------------------------------------------------------------------------

  /** Effective permissions of one member within the scopes the previewer may inspect. */
  async previewMember(caller: Caller, workspacePublicId: unknown, memberPublicId: unknown) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      this.#directory(p);
      this.#require(
        p,
        'access.preview',
        decideWorkspace(p, 'access.preview').allowed || p.grants.size > 0,
      );
      const m = await this.#member(tx, memberPublicId);
      const brands = await brandRefs(tx);
      if (!inspectable(p, brands).length && !decideWorkspace(p, 'access.preview').allowed)
        throw new TenancyError('forbidden');
      const target =
        m.state === 'active' ? await compilePrincipal(tx, m.id, m.account_id, m.kind) : null;
      const shares = target ? await this.#sharesFor(tx, p, target) : [];
      return {
        member: this.#memberView(p, m),
        explanation: explain(p, target, brands, await this.#teamNames(tx)),
        shares,
      };
    });
  }

  /** Record shares that apply to `target`, limited to records the previewer can read. */
  async #sharesFor(tx: WorkspaceTransaction, viewer: Principal, target: Principal) {
    const vis = await compileVisibility(tx, viewer, {
      need: 'view',
      includeArchived: true,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const subjects = [target.membershipId, ...target.teams];
    const rows = await tx.db
      .selectFrom('access.record_grant as g')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'g.workspace_id').onRef('r.id', '=', 'g.record_id'),
      )
      .select(['r.public_id', 'r.record_type', 'g.level', 'g.expires_at', 'g.grantee_type'])
      .where('g.grantee_key', 'in', subjects)
      .where('g.state', '=', 'active')
      .where((eb) => eb.or([eb('g.expires_at', 'is', null), eb('g.expires_at', '>', new Date())]))
      .where(vis.where('r'))
      .orderBy('r.public_id')
      .limit(200)
      .execute();
    return rows.map((r) => ({
      record: { id: r.public_id, type: r.record_type },
      level: r.level,
      via: r.grantee_type === 'team' ? 'team' : 'direct',
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    }));
  }

  /** Validates a proposed change and returns the target principals before and after it. */
  async #proposal(
    tx: WorkspaceTransaction,
    p: Principal,
    raw: unknown,
    lock: boolean,
  ): Promise<Proposal> {
    const c = parseChange(raw);
    const epochsOf = async (ids: string[]) =>
      (
        await tx.db
          .selectFrom('access.permission_epoch')
          .select(['epoch_kind', 'subject_id', 'epoch'])
          .where((eb) =>
            eb.or([
              eb('epoch_kind', '=', 'workspace'),
              ...(ids.length
                ? [eb.and([eb('epoch_kind', '=', 'principal'), eb('subject_id', 'in', ids)])]
                : []),
            ]),
          )
          .orderBy('epoch_kind')
          .orderBy('subject_id')
          .execute()
      ).map((e) => [e.epoch_kind, e.subject_id, Number(e.epoch)]);
    const compile = (m: { id: string; account_id: string; kind: 'member' | 'guest' }) =>
      compilePrincipal(tx, m.id, m.account_id, m.kind);
    switch (c.kind) {
      case 'role':
      case 'suspend':
      case 'remove': {
        const m = await this.#member(tx, c.member, lock);
        if (m.id === p.membershipId)
          throw invalid(issue('/member', 'self', 'Use "Leave workspace" for your own membership.'));
        if (c.kind === 'role') {
          if (m.kind !== 'member' || m.state !== 'active')
            throw new TenancyError('conflict', {
              issues: [
                issue('/member', 'not_active', 'Only active members have a role to change.'),
              ],
            });
          this.#require(
            p,
            'membership.manage',
            canManageMember(p, m.role as WorkspaceRole, c.role),
          );
        } else if (m.kind === 'guest') {
          this.#require(p, 'membership.manage', decideWorkspace(p, 'membership.manage').allowed);
        } else {
          this.#require(p, 'membership.manage', canManageMember(p, m.role as WorkspaceRole, null));
        }
        const before = m.state === 'active' ? await compile(m) : null;
        let after: Principal | null = null;
        if (c.kind === 'role' && before) after = { ...before, role: c.role };
        return {
          change: c,
          pairs: [{ before, after }],
          epochs: await epochsOf([m.id]),
          apply: async (caller) => {
            if (c.kind === 'role') await this.#applyRole(tx, caller, p, m, c.role);
            else await this.#applySuspendOrRemove(tx, caller, p, m, c.kind, null);
            return { ref: { id: m.public_id, type: 'membership' } };
          },
        };
      }
      case 'brand_grant':
      case 'brand_revoke': {
        const brand = await this.#brandByPublic(tx, c.brand, lock);
        const principal = await this.#grantee(tx, c.principal);
        const level = c.kind === 'brand_grant' ? c.level : 'manage';
        this.#require(
          p,
          'access.grant_scope',
          c.kind === 'brand_grant'
            ? canGrantBrand(p, brand, level)
            : decideBrand(p, 'access.grant_scope', brand).allowed &&
                levelRank(brandLevel(p, brand)) >= levelRank(principal.currentBrandLevel(brand.id)),
          decideBrand(p, 'access.grant_scope', brand).allowed || brandLevel(p, brand) !== null
            ? 'forbidden'
            : 'not_found',
        );
        const members = await principal.members();
        const pairs = [];
        for (const m of members) {
          const before = await compile(m);
          const grants = new Map(before.grants);
          const sources = before.grantSources.filter(
            (s) =>
              !(
                s.brandId === brand.id &&
                (principal.type === 'team' ? s.teamId === principal.id : s.via === 'direct')
              ),
          );
          if (c.kind === 'brand_grant')
            sources.push({
              brandId: brand.id,
              level: c.level,
              via: principal.type === 'team' ? 'team' : 'direct',
              teamId: principal.type === 'team' ? principal.id : null,
              expiresAt: c.expires_at ? new Date(c.expires_at) : null,
            });
          grants.delete(brand.id);
          for (const s of sources.filter((x) => x.brandId === brand.id))
            if (levelRank(s.level) > levelRank(grants.get(brand.id) ?? null))
              grants.set(brand.id, s.level);
          pairs.push({ before, after: { ...before, grants, grantSources: sources } });
        }
        return {
          change: c,
          pairs,
          epochs: await epochsOf(members.map((m) => m.id)),
          apply: async (caller) => {
            if (c.kind === 'brand_grant')
              await this.#applyBrandGrant(tx, caller, p, brand, principal, c.level, c.expires_at);
            else await this.#applyBrandRevoke(tx, caller, p, brand, principal);
            return { ref: { id: brand.publicId, type: 'brand' } };
          },
        };
      }
      case 'project_grant':
      case 'project_revoke': {
        const project = await this.#projectByPublic(tx, p, c.project, lock);
        const principal = await this.#grantee(tx, c.principal);
        const facts = {
          brand: project.brand,
          lifecycleState: project.lifecycleState,
          chain: project.chain,
        };
        const current = await this.#projectGrantLevel(tx, project.id, principal);
        this.#require(
          p,
          'access.grant_scope',
          c.kind === 'project_grant'
            ? project.lifecycleState === 'active' && canGrantProject(p, facts, c.level)
            : decideProject(p, 'access.grant_scope', facts).allowed &&
                levelRank(
                  recordLevel(p, {
                    brand: project.brand,
                    lifecycleState: 'active',
                    shareLevel: null,
                    projectChain: project.chain,
                  }),
                ) >= levelRank(current),
        );
        const members = await principal.members();
        const pairs = [];
        for (const m of members) {
          const before = await compile(m);
          const sources = before.projectGrantSources.filter(
            (s) =>
              !(
                s.projectId === project.id &&
                (principal.type === 'team' ? s.teamId === principal.id : s.via === 'direct')
              ),
          );
          if (c.kind === 'project_grant')
            sources.push({
              projectId: project.id,
              level: c.level,
              via: principal.type === 'team' ? 'team' : 'direct',
              teamId: principal.type === 'team' ? principal.id : null,
              expiresAt: null,
            });
          const projectGrants = new Map<string, Level>();
          for (const s of sources)
            if (levelRank(s.level) > levelRank(projectGrants.get(s.projectId) ?? null))
              projectGrants.set(s.projectId, s.level);
          pairs.push({ before, after: { ...before, projectGrants, projectGrantSources: sources } });
        }
        return {
          change: c,
          pairs,
          epochs: await epochsOf(members.map((m) => m.id)),
          project,
          apply: async (caller) => {
            if (c.kind === 'project_grant')
              await this.#applyProjectGrant(tx, caller, p, project, principal, c.level);
            else await this.#applyProjectRevoke(tx, caller, p, project, principal);
            return { ref: { id: project.publicId, type: 'project' } };
          },
        };
      }
      case 'record_share': {
        const target = await this.#shareTarget(tx, p, c.record, '/change/record');
        const principal = await this.#grantee(tx, c.grantee, true);
        const members = await principal.members();
        const pairs = [];
        for (const m of members) {
          const before = await compile(m);
          pairs.push({ before, after: before });
        }
        return {
          change: c,
          pairs,
          epochs: await epochsOf(members.map((m) => m.id)),
          sharedRecord: { id: target.id, type: target.recordType },
          apply: async (caller) => {
            const id = await this.#createShareTx(tx, caller, p, {
              record: c.record,
              children: [],
              grantee: c.grantee,
              level: c.level,
              expires_at: c.expires_at ? new Date(c.expires_at) : null,
            });
            return { ref: { id, type: 'share_group' } };
          },
        };
      }
      case 'team_add':
      case 'team_remove': {
        const team = await this.#team(tx, c.team, lock);
        const m = await this.#member(tx, c.member, lock);
        this.#require(p, 'team.manage', decideWorkspace(p, 'team.manage').allowed);
        if (m.kind !== 'member' || m.state !== 'active')
          throw invalid(
            issue('/member', 'not_internal', 'Only active internal members can join teams.'),
          );
        // The actor needs grantable authority over every scope the team holds grants in (AT-039).
        const teamGrants = await this.#teamGrants(tx, team.id);
        const brands = await brandRefs(tx);
        for (const g of teamGrants) {
          const b = brands.find((x) => x.id === g.brandId);
          if (!b || !canGrantBrand(p, b, g.level)) throw new TenancyError('forbidden');
        }
        const before = await compile(m);
        const teams =
          c.kind === 'team_add'
            ? [...new Set([...before.teams, team.id])]
            : before.teams.filter((t) => t !== team.id);
        const sources = before.grantSources.filter((s) => s.teamId !== team.id);
        if (c.kind === 'team_add')
          for (const g of teamGrants)
            sources.push({
              brandId: g.brandId,
              level: g.level,
              via: 'team',
              teamId: team.id,
              expiresAt: g.expiresAt,
            });
        const grants = new Map<string, Level>();
        for (const s of sources)
          if (levelRank(s.level) > levelRank(grants.get(s.brandId) ?? null))
            grants.set(s.brandId, s.level);
        return {
          change: c,
          pairs: [{ before, after: { ...before, teams, grants, grantSources: sources } }],
          epochs: await epochsOf([m.id]),
          apply: async (caller) => {
            await this.#applyTeamMember(tx, caller, p, team, m, c.kind === 'team_add');
            return { ref: { id: team.publicId, type: 'team' } };
          },
        };
      }
    }
  }

  /** The one exposure diff: brand levels and capabilities, plus exact deltas for projects and shares. */
  async #diff(tx: WorkspaceTransaction, p: Principal, prop: Proposal): Promise<ExposureDiff> {
    const diff = await exposureDiff(tx, p, prop.pairs, await brandRefs(tx));
    if (!prop.project && !prop.sharedRecord) return diff;
    const delta = await visibleDelta(tx, p, prop.pairs, this.c.settings.principalContextArrayMax, {
      gainedRecord: prop.sharedRecord ?? null,
    });
    const projects: ExposureDiff['projects'] = [];
    if (prop.project) {
      const facts = {
        brand: prop.project.brand,
        lifecycleState: 'active' as const,
        shareLevel: null,
        projectChain: prop.project.chain,
      };
      let before: Level | null = null;
      let after: Level | null = null;
      for (const pair of prop.pairs) {
        before = maxLevel(before, pair.before ? recordLevel(pair.before, facts) : null);
        after = maxLevel(after, pair.after ? recordLevel(pair.after, facts) : null);
      }
      if (before !== after)
        projects.push({
          project: { id: prop.project.publicId, name: prop.project.name },
          before,
          after,
        });
    }
    const increases =
      projects.some((x) => levelRank(x.after) > levelRank(x.before)) ||
      Object.keys(delta.gained).length > 0;
    return {
      ...diff,
      projects,
      records_gained: delta.gained,
      records_lost: delta.lost,
      increases_access: diff.increases_access || increases,
    };
  }

  /** Returns the exposure diff and a short-lived fingerprint the apply step must present. */
  async previewChange(caller: Caller, workspacePublicId: unknown, body: unknown) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      this.#directory(p);
      const prop = await this.#proposal(tx, p, body, false);
      const diff = await this.#diff(tx, p, prop);
      return {
        change: prop.change,
        diff,
        preview_token: previewToken(
          this.#previewKey,
          { viewer: p.membershipId, change: prop.change, epochs: prop.epochs, diff },
          this.c.settings.previewTtlMs,
        ),
      };
    });
  }

  /**
   * Applies a reviewed change: recomputes the preview under row locks; a different diff, changed
   * epochs, or an expired fingerprint is a conflict (review again). High-risk changes need step-up.
   */
  async applyChange(caller: Caller, workspacePublicId: unknown, body: unknown, req: Mutation) {
    const b = isObject(body) ? body : {};
    const token = b.preview_token;
    const changeBody = b.change;
    return this.mutate(
      caller,
      'access.apply_change',
      workspacePublicId,
      req,
      async (tx, p) => {
        this.#directory(p);
        const prop = await this.#proposal(tx, p, changeBody, true);
        const diff = await this.#diff(tx, p, prop);
        if (
          !verifyPreviewToken(this.#previewKey, token, {
            viewer: p.membershipId,
            change: prop.change,
            epochs: prop.epochs,
            diff,
          })
        )
          throw new TenancyError('conflict', {
            issues: [
              issue(
                '/preview_token',
                'preview_stale',
                'Access changed since you reviewed it. Review the change again.',
              ),
            ],
          });
        const stepAction: ActionKey | null =
          prop.change.kind === 'role' ||
          prop.change.kind === 'suspend' ||
          prop.change.kind === 'remove'
            ? 'membership.manage'
            : null;
        if (stepAction)
          await this.stepUp(tx, caller, p, req, stepAction, {
            type: 'membership',
            id: (prop.change as { member: string }).member,
          });
        const done = await prop.apply(caller);
        return {
          status: 200,
          ref: done.ref,
          data: {
            id: done.ref.id,
            type: done.ref.type,
            applied: prop.change.kind as string,
            diff: diff as ExposureDiff | null,
          },
        };
      },
      async (_tx, _p, ref) => ({
        id: ref.id,
        type: ref.type,
        applied: 'replayed' as string,
        diff: null as ExposureDiff | null,
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Change implementations (called only from applyChange, inside its transaction)
  // ---------------------------------------------------------------------------------------------

  async #roleId(tx: WorkspaceTransaction, key: string): Promise<string> {
    return (
      await tx.db
        .selectFrom('access.role')
        .select('id')
        .where('key', '=', key)
        .where('builtin', '=', true)
        .executeTakeFirstOrThrow()
    ).id;
  }

  async #applyRole(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    m: MemberRow,
    role: MemberRole,
  ) {
    if (m.role === role) return;
    const res = await tx.db
      .updateTable('access.role_assignment')
      .set({ role_id: await this.#roleId(tx, role), version: sql`version + 1` })
      .where('membership_principal_id', '=', m.id)
      .where('scope_type', '=', 'workspace')
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
    await bumpEpoch(tx, 'principal', m.id);
    await bumpEpoch(tx, 'workspace', null);
    await this.#audit(
      tx,
      caller,
      p,
      'role_assignment.changed',
      { recordId: res.id, type: 'role_assignment', publicId: null },
      [change.plain('member', null, m.public_id), change.plain('role', m.role, role)],
    );
    await this.security(tx, caller, p, 'role_assignment.changed', { type: 'membership', id: m.id });
    await this.#event(
      tx,
      caller,
      p,
      'access.role.assigned',
      { type: 'access.role_assignment', id: res.id, sequence: Number(res.version) },
      {
        scope_type: 'workspace',
        role_id: null,
      },
    );
  }

  async #revokeHeldSolely(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    membershipId: string,
  ): Promise<number> {
    const now = new Date();
    const grants = await tx.db
      .updateTable('access.record_grant')
      .set({
        state: 'revoked',
        revoked_at: now,
        revoked_by_membership_id: p.membershipId,
        version: sql`version + 1`,
      })
      .where('grantee_membership_id', '=', membershipId)
      .where('state', '=', 'active')
      .returning(['id', 'record_id', 'version'])
      .execute();
    for (const g of grants)
      await this.#event(
        tx,
        caller,
        p,
        'access.grant.revoked',
        { type: 'access.record_grant', id: g.id, sequence: Number(g.version) },
        {
          record_id: g.record_id,
          grantee_type: 'membership',
        },
      );
    await tx.db
      .updateTable('access.share_group')
      .set({
        state: 'revoked',
        revoked_at: now,
        revoked_by_membership_id: p.membershipId,
        version: sql`version + 1`,
      })
      .where('grantee_membership_id', '=', membershipId)
      .where('state', '=', 'active')
      .execute();
    return grants.length;
  }

  /** Cancels queued work acting as the membership (0C §11.5 step 4); running jobs observe it. */
  async #cancelJobsOf(tx: WorkspaceTransaction, membershipId: string): Promise<number> {
    const jobs = await tx.db
      .selectFrom('exec.job')
      .select('id')
      .where('effective_principal_id', '=', membershipId)
      .where('state', 'in', ['queued', 'retry_scheduled', 'leased'])
      .execute();
    let n = 0;
    for (const j of jobs) if ((await requestJobCancel(tx, j.id)) !== 'not_cancellable') n++;
    return n;
  }

  async #applySuspendOrRemove(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    m: MemberRow,
    kind: 'suspend' | 'remove' | 'leave',
    reassignTo: string | null,
  ) {
    const now = new Date();
    if (kind === 'suspend') {
      if (m.state !== 'active') throw new TenancyError('conflict');
      await tx.db
        .updateTable('tenancy.membership')
        .set({
          state: 'suspended',
          suspended_at: now,
          state_changed_by_membership_id: p.membershipId,
          updated_at: now,
          version: sql`version + 1`,
        })
        .where('id', '=', m.id)
        .execute();
    } else {
      if (m.state !== 'active' && m.state !== 'suspended') throw new TenancyError('conflict');
      // Ownership plan first: never leave a required owner null (PERM-014).
      const plan = await this.#ownership.plan(tx, m.id);
      const blocking = plan.filter((x) => x.requiresAssignee && x.owned > 0);
      let assignee: string | null = null;
      if (blocking.length) {
        if (!reassignTo)
          throw new TenancyError('conflict', {
            issues: blocking.map((x) =>
              issue(
                '/reassign_to',
                'ownership_reassignment_required',
                `${x.owned} owned item${x.owned === 1 ? '' : 's'} (${x.hook.replace(/_/g, ' ')}) need a new owner before removal.`,
              ),
            ),
          });
        const to = await this.#member(tx, reassignTo);
        if (to.state !== 'active' || to.kind !== 'member' || to.id === m.id)
          throw invalid(
            issue(
              '/reassign_to',
              'invalid_assignee',
              'Choose an active internal member as the new owner.',
            ),
          );
        assignee = to.id;
      }
      const tokens = await tx.db
        .selectFrom('tenancy.invitation')
        .select('token_id')
        .where('invited_by_membership_id', '=', m.id)
        .where('state', '=', 'pending')
        .execute();
      for (const h of this.#ownership.all()) {
        try {
          await h.apply(tx, m.id, assignee);
        } catch (err) {
          this.d.metrics.count('tenancy.ownership_hook_failures', 1, { hook: h.key });
          throw err;
        }
      }
      for (const t of tokens) await this.c.identity.revokeInvitationToken(tx, t.token_id);
      await tx.db
        .deleteFrom('access.role_assignment')
        .where('membership_principal_id', '=', m.id)
        .execute();
      await tx.db.deleteFrom('tenancy.team_member').where('membership_id', '=', m.id).execute();
      await this.#revokeHeldSolely(tx, caller, p, m.id);
      await tx.db
        .updateTable('tenancy.membership')
        .set({
          state: 'removed',
          removed_at: now,
          suspended_at: null,
          departure_reason: kind === 'leave' ? 'left' : 'removed',
          state_changed_by_membership_id: p.membershipId,
          updated_at: now,
          version: sql`version + 1`,
        })
        .where('id', '=', m.id)
        .execute();
      // Departure contract (0C §11.5): every session of the departed account is revoked.
      const sessions = await this.c.identity.revokeSessionsForDeparture(
        tx,
        m.account_id,
        p.membershipId,
        caller.meta,
      );
      this.d.metrics.count('tenancy.revocations', 1, {
        kind: 'sessions',
        outcome: sessions > 0 ? 'revoked' : 'none',
      });
    }
    const jobs = await this.#cancelJobsOf(tx, m.id);
    this.d.metrics.count('tenancy.revocations', 1, {
      kind: 'jobs',
      outcome: jobs > 0 ? 'cancelled' : 'none',
    });
    this.d.metrics.count('tenancy.revocations', 1, { kind, outcome: 'applied' });
    await bumpEpoch(tx, 'principal', m.id);
    await bumpEpoch(tx, 'workspace', null);
    const action =
      kind === 'suspend'
        ? 'membership.suspended'
        : kind === 'leave'
          ? 'membership.left'
          : 'membership.removed';
    await this.#audit(
      tx,
      caller,
      p,
      action,
      { recordId: m.id, type: 'membership', publicId: m.public_id },
      [change.plain('state', m.state, kind === 'suspend' ? 'suspended' : 'removed')],
    );
    await this.security(tx, caller, p, action, { type: 'membership', id: m.id });
    await this.#event(
      tx,
      caller,
      p,
      kind === 'suspend' ? 'tenancy.membership.suspended' : 'tenancy.membership.removed',
      { type: 'tenancy.membership', id: m.id, sequence: Number(m.version) + 1 },
      { reason: kind === 'leave' ? 'left' : kind === 'suspend' ? 'suspended' : 'removed' },
    );
  }

  /** Suspend/remove are previewed changes; this applies the reactivation and removal options. */
  async reactivateMember(
    caller: Caller,
    workspacePublicId: unknown,
    memberPublicId: unknown,
    req: Mutation,
  ) {
    return this.mutate(
      caller,
      'membership.reactivate',
      workspacePublicId,
      req,
      async (tx, p) => {
        this.#directory(p);
        const m = await this.#member(tx, memberPublicId, true);
        if (m.kind === 'guest')
          this.#require(p, 'membership.manage', decideWorkspace(p, 'membership.manage').allowed);
        else
          this.#require(p, 'membership.manage', canManageMember(p, m.role as WorkspaceRole, null));
        if (m.state !== 'suspended') throw new TenancyError('conflict');
        await this.stepUp(tx, caller, p, req, 'membership.manage', {
          type: 'membership',
          id: m.public_id,
        });
        if (!(await this.#seats.canAdd(tx, m.kind)))
          throw new TenancyError('forbidden', {
            issues: [issue('/', 'seat_limit', 'Your plan has no seats left.')],
          });
        await tx.db
          .updateTable('tenancy.membership')
          .set({
            state: 'active',
            suspended_at: null,
            state_changed_by_membership_id: p.membershipId,
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('id', '=', m.id)
          .execute();
        await bumpEpoch(tx, 'principal', m.id);
        await bumpEpoch(tx, 'workspace', null);
        await this.#audit(
          tx,
          caller,
          p,
          'membership.reactivated',
          { recordId: m.id, type: 'membership', publicId: m.public_id },
          [change.plain('state', 'suspended', 'active')],
        );
        await this.security(tx, caller, p, 'membership.reactivated', {
          type: 'membership',
          id: m.id,
        });
        await this.#event(
          tx,
          caller,
          p,
          'tenancy.membership.activated',
          { type: 'tenancy.membership', id: m.id, sequence: Number(m.version) + 1 },
          {
            kind: m.kind,
            reason: 'reactivated',
          },
        );
        const data = this.#memberView(p, await this.#member(tx, m.public_id));
        return { status: 200, ref: { id: data.id, type: 'membership' }, data };
      },
      async (tx, p, ref) => this.#memberView(p, await this.#member(tx, ref.id)),
    );
  }

  /**
   * Removal with an ownership plan (PERM-014): the reviewed preview (`preview_token`) plus the
   * chosen assignee for owned resources. Removal itself is the `remove` change kind.
   */
  async removeMember(
    caller: Caller,
    workspacePublicId: unknown,
    memberPublicId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const b = isObject(body) ? body : {};
    const change = { kind: 'remove', member: memberPublicId };
    return this.mutate(
      caller,
      'membership.remove',
      workspacePublicId,
      req,
      async (tx, p) => {
        this.#directory(p);
        const prop = await this.#proposal(tx, p, change, true);
        const diff = await exposureDiff(tx, p, prop.pairs, await brandRefs(tx));
        if (
          !verifyPreviewToken(this.#previewKey, b.preview_token, {
            viewer: p.membershipId,
            change: prop.change,
            epochs: prop.epochs,
            diff,
          })
        )
          throw new TenancyError('conflict', {
            issues: [
              issue(
                '/preview_token',
                'preview_stale',
                'Access changed since you reviewed it. Review the change again.',
              ),
            ],
          });
        await this.stepUp(tx, caller, p, req, 'membership.manage', {
          type: 'membership',
          id: String(memberPublicId),
        });
        const m = await this.#member(tx, memberPublicId, true);
        await this.#applySuspendOrRemove(
          tx,
          caller,
          p,
          m,
          'remove',
          typeof b.reassign_to === 'string' ? b.reassign_to : null,
        );
        const data = this.#memberView(p, await this.#member(tx, m.public_id));
        return { status: 200, ref: { id: data.id, type: 'membership' }, data };
      },
      async (tx, p, ref) => this.#memberView(p, await this.#member(tx, ref.id)),
    );
  }

  /** Ownership plan for a member's departure (counts per registered hook; no titles). */
  async departurePlan(caller: Caller, workspacePublicId: unknown, memberPublicId: unknown) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      this.#directory(p);
      const m = await this.#member(tx, memberPublicId);
      const self = m.id === p.membershipId;
      if (!self)
        this.#require(p, 'membership.manage', decideWorkspace(p, 'membership.manage').allowed);
      return { items: await this.#ownership.plan(tx, m.id) };
    });
  }

  /** Leave a workspace (0C AZ-19 `membership.leave`): own membership; last-owner safe. */
  async leave(caller: Caller, workspacePublicId: unknown, body: unknown, req: Mutation) {
    const b = isObject(body) ? body : {};
    return this.mutate(
      caller,
      'membership.leave',
      workspacePublicId,
      req,
      async (tx, p) => {
        const m = await this.#member(
          tx,
          (
            await tx.db
              .selectFrom('tenancy.membership')
              .select('public_id')
              .where('id', '=', p.membershipId)
              .executeTakeFirstOrThrow()
          ).public_id,
          true,
        );
        this.decision('membership.leave', { allowed: true });
        await this.#applySuspendOrRemove(
          tx,
          caller,
          p,
          m,
          'leave',
          typeof b.reassign_to === 'string' ? b.reassign_to : null,
        );
        return {
          status: 200,
          ref: { id: m.public_id, type: 'membership' },
          data: { id: m.public_id, type: 'membership', state: 'removed' as const },
        };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'membership', state: 'removed' as const }),
    ).catch((err: unknown) => {
      if (pg(err).message?.includes('active owner'))
        throw new TenancyError('conflict', {
          issues: [
            issue('/', 'last_owner', "You're the only owner. Transfer ownership before leaving."),
          ],
        });
      throw err;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Invitations (COL-001, COL-002; 0C AZ-19)
  // ---------------------------------------------------------------------------------------------

  #invitationView(
    row: {
      public_id: string;
      email_key: string;
      kind: string;
      role_key: string | null;
      state: string;
      expires_at: Date;
      send_count: number;
      last_sent_at: Date;
      created_at: Date;
      version: string | number;
      scope_proposal: unknown;
    },
    brandNames: Map<string, string>,
  ) {
    const expired = row.state === 'pending' && new Date(row.expires_at).getTime() <= Date.now();
    const proposal = (row.scope_proposal ?? {}) as {
      brands?: Array<{ brand: string; level: string }>;
      records?: Array<{ record: string; level: string }>;
    };
    return {
      id: row.public_id,
      type: 'invitation' as const,
      email: row.email_key,
      kind: row.kind,
      role: row.role_key,
      state: expired ? 'expired' : row.state,
      expires_at: new Date(row.expires_at).toISOString(),
      send_count: row.send_count,
      last_sent_at: new Date(row.last_sent_at).toISOString(),
      created_at: new Date(row.created_at).toISOString(),
      version: Number(row.version),
      brands: (proposal.brands ?? []).map((x) => ({
        id: x.brand,
        name: brandNames.get(x.brand) ?? null,
        level: x.level,
      })),
      records: (proposal.records ?? []).map((x) => ({ id: x.record, level: x.level })),
    };
  }

  async #brandNames(tx: WorkspaceTransaction): Promise<Map<string, string>> {
    return new Map((await brandRefs(tx)).map((b) => [b.publicId, b.name]));
  }

  /** Who may see an invitation: people managers/inviters see all; members see their own sends. */
  #canSeeInvitations(p: Principal): 'all' | 'own' | 'none' {
    if (p.kind === 'guest') return 'none';
    if (
      decideWorkspace(p, 'membership.invite_member').allowed ||
      decideWorkspace(p, 'membership.manage').allowed
    )
      return 'all';
    return 'own';
  }

  async listInvitations(caller: Caller, workspacePublicId: unknown, query: { state?: unknown }) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      const scope = this.#canSeeInvitations(p);
      if (scope === 'none') throw new TenancyError('not_found');
      let q = tx.db
        .selectFrom('tenancy.invitation')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(200);
      if (scope === 'own') q = q.where('invited_by_membership_id', '=', p.membershipId);
      if (query.state === 'pending')
        q = q.where('state', '=', 'pending').where('expires_at', '>', new Date());
      const names = await this.#brandNames(tx);
      return (await q.execute()).map((r) => this.#invitationView(r as never, names));
    });
  }

  /**
   * Creates (or, for an equal pending invitation, returns) an invitation. Owners invite any
   * role; administrators never owners; members only guests when policy allows (0C §3.1).
   * Outcomes never reveal whether an account exists for the email.
   */
  async invite(caller: Caller, workspacePublicId: unknown, body: unknown, req: Mutation) {
    const input = parseInvitation(body);
    return this.mutate(
      caller,
      'invitation.create',
      workspacePublicId,
      req,
      async (tx, p) => {
        this.#directory(p);
        const brands = await brandRefs(tx);
        if (input.kind === 'member') {
          this.#require(
            p,
            'membership.invite_member',
            decideWorkspace(p, 'membership.invite_member').allowed,
          );
          if (!canAssignRole(p.role, input.role!))
            throw new TenancyError('forbidden', {
              issues: [
                issue('/role', 'role_not_grantable', "You can't invite someone with this role."),
              ],
            });
          for (const [i, g] of input.brands.entries()) {
            const b = brands.find((x) => x.publicId === g.brand);
            if (!b || brandLevel(p, b) === null)
              throw invalid(
                issue(`/brands/${i}/brand`, 'not_found', 'That brand is not available.'),
              );
            if (!canGrantBrand(p, b, g.level))
              throw new TenancyError('forbidden', {
                issues: [
                  issue(
                    `/brands/${i}/level`,
                    'level_not_grantable',
                    "You can't grant this level on this brand.",
                  ),
                ],
              });
          }
        } else {
          const cl = this.#guestInviteAllowed(p);
          this.decision(
            'membership.invite_guest',
            cl ? { allowed: true } : { allowed: false, code: 'forbidden' },
          );
          if (!cl) throw new TenancyError('forbidden');
          await this.#validateShareTargets(tx, p, input.records, '/records');
        }
        // Lazy expiry: a stale pending invitation for the same email closes before a new one.
        await tx.db
          .updateTable('tenancy.invitation')
          .set({
            state: 'expired',
            decided_at: new Date(),
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('email_key', '=', input.email.key)
          .where('state', '=', 'pending')
          .where('expires_at', '<=', new Date())
          .execute();
        const existingMember = await tx.db
          .selectFrom('tenancy.membership as m')
          .innerJoin('identity.account as a', 'a.id', 'm.account_id')
          .select(['m.state'])
          .where('a.email_key', '=', input.email.key)
          .where('m.state', 'in', ['active', 'suspended'])
          .executeTakeFirst();
        // Inviters can see the internal directory, so naming an existing member reveals nothing new.
        if (existingMember)
          throw invalid(
            issue('/email', 'already_member', 'This person is already in the workspace.'),
          );
        const pending = await tx.db
          .selectFrom('tenancy.invitation')
          .select('public_id')
          .where('email_key', '=', input.email.key)
          .where('state', '=', 'pending')
          .executeTakeFirst();
        if (pending)
          throw invalid(
            issue(
              '/email',
              'already_invited',
              'There is already a pending invitation for this email. Resend it instead.',
            ),
          );
        if (!(await this.#seats.canAdd(tx, input.kind)))
          throw new TenancyError('forbidden', {
            issues: [issue('/', 'seat_limit', 'Your plan has no seats left.')],
          });
        const limited = await this.d.limiter.consume('invitation.send', p.membershipId);
        if (!limited.allowed)
          throw new TenancyError('rate_limited', { retryAfterSeconds: limited.retryAfterSeconds });
        const id = newUuidV7();
        const publicId = newPublicId('inv');
        const expiresAt = new Date(Date.now() + this.c.settings.invitationLifetimeMs);
        const proposal =
          input.kind === 'member'
            ? { brands: input.brands.map((g) => ({ brand: g.brand, level: g.level })) }
            : { records: input.records.map((r) => ({ record: r.record, level: r.level })) };
        const { tokenId } = await this.c.identity.issueInvitationToken(tx, {
          email: input.email.display,
          locale: input.locale,
          invitationId: id,
          expiresAt,
          supersedesTokenId: null,
          exec: this.exec(caller, p),
          meta: caller.meta,
        });
        const row = await tx.db
          .insertInto('tenancy.invitation')
          .values({
            id,
            public_id: publicId,
            workspace_id: tx.workspaceId,
            email_key: input.email.key,
            kind: input.kind,
            role_key: input.kind === 'member' ? input.role : null,
            scope_proposal: JSON.stringify(proposal),
            invited_by_membership_id: p.membershipId,
            expires_at: expiresAt,
            token_id: tokenId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.#audit(
          tx,
          caller,
          p,
          'invitation.created',
          { recordId: id, type: 'invitation', publicId },
          [
            change.personal('email', null, input.email.key),
            change.plain('kind', null, input.kind),
            change.plain('role', null, input.kind === 'member' ? input.role : null),
          ],
        );
        await this.security(tx, caller, p, 'invitation.created', { type: 'invitation', id });
        this.d.metrics.count('tenancy.invitation_outcomes', 1, {
          stage: 'created',
          outcome: input.kind,
        });
        const data = this.#invitationView(row as never, await this.#brandNames(tx));
        return { status: 201, ref: { id: publicId, type: 'invitation' }, data };
      },
      async (tx, _p, ref) =>
        this.#invitationView(
          (await this.#invitation(tx, ref.id)) as never,
          await this.#brandNames(tx),
        ),
    );
  }

  #guestInviteAllowed(p: Principal): boolean {
    if (p.kind === 'guest' || !p.policy.guest_invitations_enabled) return false;
    const raw = ((ACTIONS_ROLES.get('membership.invite_guest') ?? {}) as Record<string, string>)[
      p.role ?? ''
    ];
    if (raw === 'implicit') return true;
    if (raw === 'policy:members_invite_guests') return p.policy.members_invite_guests === true;
    return false;
  }

  async #invitation(tx: WorkspaceTransaction, publicId: unknown, lock = false) {
    if (typeof publicId !== 'string' || !PUBLIC('inv').test(publicId))
      throw new TenancyError('not_found');
    let q = tx.db.selectFrom('tenancy.invitation').selectAll().where('public_id', '=', publicId);
    if (lock) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    return row;
  }

  async #invitationForActor(tx: WorkspaceTransaction, p: Principal, publicId: unknown) {
    const scope = this.#canSeeInvitations(p);
    if (scope === 'none') throw new TenancyError('not_found');
    const row = await this.#invitation(tx, publicId, true);
    if (scope === 'own' && row.invited_by_membership_id !== p.membershipId)
      throw new TenancyError('not_found');
    return row;
  }

  async resendInvitation(
    caller: Caller,
    workspacePublicId: unknown,
    invitationPublicId: unknown,
    req: Mutation,
  ) {
    return this.mutate(
      caller,
      'invitation.resend',
      workspacePublicId,
      req,
      async (tx, p) => {
        const row = await this.#invitationForActor(tx, p, invitationPublicId);
        if (row.state !== 'pending')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'not_pending', 'This invitation is no longer pending.')],
          });
        const limited = await this.d.limiter.consume('invitation.send', p.membershipId);
        if (!limited.allowed)
          throw new TenancyError('rate_limited', { retryAfterSeconds: limited.retryAfterSeconds });
        const expiresAt = new Date(Date.now() + this.c.settings.invitationLifetimeMs);
        const { tokenId } = await this.c.identity.issueInvitationToken(tx, {
          email: row.email_key,
          locale: 'en',
          invitationId: row.id,
          expiresAt,
          supersedesTokenId: row.token_id,
          exec: this.exec(caller, p),
          meta: caller.meta,
        });
        const updated = await tx.db
          .updateTable('tenancy.invitation')
          .set({
            token_id: tokenId,
            expires_at: expiresAt,
            send_count: sql`send_count + 1`,
            last_sent_at: new Date(),
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.#audit(tx, caller, p, 'invitation.resent', {
          recordId: row.id,
          type: 'invitation',
          publicId: row.public_id,
        });
        this.d.metrics.count('tenancy.invitation_outcomes', 1, { stage: 'resent', outcome: 'ok' });
        const data = this.#invitationView(updated as never, await this.#brandNames(tx));
        return { status: 200, ref: { id: data.id, type: 'invitation' }, data };
      },
      async (tx, _p, ref) =>
        this.#invitationView(
          (await this.#invitation(tx, ref.id)) as never,
          await this.#brandNames(tx),
        ),
    );
  }

  async revokeInvitation(
    caller: Caller,
    workspacePublicId: unknown,
    invitationPublicId: unknown,
    req: Mutation,
  ) {
    return this.mutate(
      caller,
      'invitation.revoke',
      workspacePublicId,
      req,
      async (tx, p) => {
        const row = await this.#invitationForActor(tx, p, invitationPublicId);
        if (row.state === 'pending') {
          await this.c.identity.revokeInvitationToken(tx, row.token_id);
          await tx.db
            .updateTable('tenancy.invitation')
            .set({
              state: 'revoked',
              revoked_by_membership_id: p.membershipId,
              decided_at: new Date(),
              updated_at: new Date(),
              version: sql`version + 1`,
            })
            .where('id', '=', row.id)
            .execute();
          await this.#audit(tx, caller, p, 'invitation.revoked', {
            recordId: row.id,
            type: 'invitation',
            publicId: row.public_id,
          });
          await this.security(tx, caller, p, 'invitation.revoked', {
            type: 'invitation',
            id: row.id,
          });
          this.d.metrics.count('tenancy.invitation_outcomes', 1, {
            stage: 'revoked',
            outcome: 'ok',
          });
        }
        const data = this.#invitationView(
          (await this.#invitation(tx, row.public_id)) as never,
          await this.#brandNames(tx),
        );
        return { status: 200, ref: { id: data.id, type: 'invitation' }, data };
      },
      async (tx, _p, ref) =>
        this.#invitationView(
          (await this.#invitation(tx, ref.id)) as never,
          await this.#brandNames(tx),
        ),
    );
  }

  /**
   * What the recipient sees before accepting. Only for the authenticated account whose verified
   * email equals the invitation's; otherwise a mismatch state without any workspace detail.
   */
  async inspectInvitation(caller: Caller, body: unknown) {
    const auth = authorizeAccountCommand('invitation.accept', caller.auth);
    const token = isObject(body) ? body.token : undefined;
    const found = await this.c.identity.lookupInvitationToken(token);
    if (!found) throw new TenancyError('not_found');
    return this.d.tenant.withWorkspace(
      found.workspaceId,
      { module: 'tenancy', readOnly: true },
      async (tx) => {
        const row = await tx.db
          .selectFrom('tenancy.invitation as i')
          .innerJoin('tenancy.workspace as w', 'w.id', 'i.workspace_id')
          .innerJoin('tenancy.membership as m', (j) =>
            j
              .onRef('m.workspace_id', '=', 'i.workspace_id')
              .onRef('m.id', '=', 'i.invited_by_membership_id'),
          )
          .innerJoin('identity.account as a', 'a.id', 'm.account_id')
          .select([
            'i.email_key',
            'i.kind',
            'i.role_key',
            'i.state',
            'i.expires_at',
            'i.token_id',
            'w.name as workspace_name',
            'a.display_name as inviter',
          ])
          .where('i.id', '=', found.invitationId)
          .executeTakeFirst();
        if (
          !row ||
          row.token_id !== found.tokenId ||
          row.state !== 'pending' ||
          row.expires_at.getTime() <= Date.now()
        )
          throw new TenancyError('not_found');
        const account = await tx.db
          .selectFrom('identity.account')
          .select('email_key')
          .where('id', '=', auth.account.id)
          .executeTakeFirst();
        if (!account || account.email_key !== row.email_key)
          return { status: 'email_mismatch' as const };
        return {
          status: 'ready' as const,
          workspace_name: row.workspace_name,
          inviter: row.inviter,
          kind: row.kind,
          role: row.role_key,
          expires_at: row.expires_at.toISOString(),
        };
      },
    );
  }

  /**
   * Accepts an invitation (account command, 0C AZ-19): verified active account whose email equals
   * the invitation, single-use token, rate limit, Idempotency-Key. Atomically activates the
   * membership and exactly the proposed assignment or record grants. A repeat by the same account
   * after success returns the same workspace (concurrent acceptances converge, AT-097).
   */
  async acceptInvitation(caller: Caller, body: unknown, req: Mutation) {
    if (!/^[A-Za-z0-9_.:-]{16,128}$/.test(req.idempotencyKey))
      throw invalid(
        issue(
          '/headers/idempotency-key',
          'idempotency_key_required',
          'An Idempotency-Key header (16-128 characters) is required.',
        ),
      );
    let auth;
    try {
      auth = authorizeAccountCommand('invitation.accept', caller.auth);
      this.decision('invitation.accept', { allowed: true });
    } catch (err) {
      if (err instanceof TenancyError)
        this.decision('invitation.accept', { allowed: false, code: err.code });
      throw err;
    }
    const token = isObject(body) ? body.token : undefined;
    const found = await this.c.identity.lookupInvitationToken(token, { includeConsumed: true });
    const outcome = async (o: string) =>
      this.d.metrics.count('tenancy.invitation_outcomes', 1, { stage: 'accept', outcome: o });
    if (!found) {
      await outcome('not_found');
      throw new TenancyError('not_found');
    }
    await this.accountCommandGates(auth, 'invitation.accept');
    const result = await this.d.tenant
      .withWorkspace(found.workspaceId, { module: 'tenancy' }, async (tx) => {
        const inv = await tx.db
          .selectFrom('tenancy.invitation')
          .selectAll()
          .where('id', '=', found.invitationId)
          .forUpdate()
          .executeTakeFirst();
        const ws = await tx.db
          .selectFrom('tenancy.workspace')
          .select(['public_id', 'name', 'state'])
          .where('id', '=', tx.workspaceId)
          .executeTakeFirstOrThrow();
        if (!inv) return null;
        if (inv.state === 'accepted' && inv.accepted_account_id === auth.account.id)
          return { workspace: { id: ws.public_id, name: ws.name }, replayed: true };
        if (
          inv.state !== 'pending' ||
          inv.token_id !== found.tokenId ||
          inv.expires_at.getTime() <= Date.now() ||
          ws.state !== 'active'
        )
          return null;
        const account = await tx.db
          .selectFrom('identity.account')
          .select(['email_key', 'email_verified_at', 'deleted_at'])
          .where('id', '=', auth.account.id)
          .executeTakeFirstOrThrow();
        if (account.email_key !== inv.email_key || !account.email_verified_at || account.deleted_at)
          return null;
        if (!(await this.c.identity.consumeInvitationToken(tx, found.tokenId))) return null;
        // The inviter's authority is re-checked at acceptance: a departed or demoted inviter
        // cannot confer access they no longer hold.
        const inviter = await tx.db
          .selectFrom('tenancy.membership')
          .select(['id', 'account_id', 'kind', 'state'])
          .where('id', '=', inv.invited_by_membership_id)
          .executeTakeFirstOrThrow();
        if (inviter.state !== 'active') return null;
        const ip = await compilePrincipal(tx, inviter.id, inviter.account_id, inviter.kind);
        const existing = await tx.db
          .selectFrom('tenancy.membership')
          .selectAll()
          .where('account_id', '=', auth.account.id)
          .forUpdate()
          .executeTakeFirst();
        if (existing && (existing.state === 'active' || existing.state === 'suspended')) {
          throw new TenancyError('conflict', {
            issues: [issue('/', 'already_member', "You're already in this workspace.")],
          });
        }
        if (!(await this.#seats.canAdd(tx, inv.kind as 'member' | 'guest')))
          throw new TenancyError('forbidden', {
            issues: [issue('/', 'seat_limit', 'This workspace has no seats left.')],
          });
        const now = new Date();
        let membershipId: string;
        let membershipPublicId: string;
        let version = 0;
        if (existing) {
          membershipId = existing.id;
          membershipPublicId = existing.public_id;
          version = Number(existing.version) + 1;
          await tx.db
            .updateTable('tenancy.membership')
            .set({
              state: 'active',
              kind: inv.kind as 'member' | 'guest',
              joined_at: now,
              removed_at: null,
              departure_reason: null,
              state_changed_by_membership_id: null,
              updated_at: now,
              version: sql`version + 1`,
            })
            .where('id', '=', existing.id)
            .execute();
        } else {
          membershipId = newUuidV7();
          membershipPublicId = newPublicId('mem');
          await tx.db
            .insertInto('tenancy.membership')
            .values({
              id: membershipId,
              public_id: membershipPublicId,
              workspace_id: tx.workspaceId,
              account_id: auth.account.id,
              kind: inv.kind as 'member' | 'guest',
              state: 'active',
              invited_at: inv.created_at,
              joined_at: now,
            })
            .execute();
        }
        const acceptCaller: Caller = caller;
        const proposal = inv.scope_proposal as {
          brands?: Array<{ brand: string; level: Level }>;
          records?: Array<{ record: string; level: ShareLevel }>;
        };
        if (inv.kind === 'member') {
          if (!canAssignRole(ip.role, inv.role_key as WorkspaceRole)) return null;
          await tx.db
            .insertInto('access.role_assignment')
            .values({
              id: newUuidV7(),
              workspace_id: tx.workspaceId,
              principal_type: 'membership',
              principal_id: membershipId,
              scope_type: 'workspace',
              scope_id: tx.workspaceId,
              role_id: await this.#roleId(tx, inv.role_key!),
              role_kind: 'workspace_role',
              grant_source: 'assigned',
              granted_by_membership_id: ip.membershipId,
            })
            .execute();
          const brands = await brandRefs(tx);
          for (const g of proposal.brands ?? []) {
            const b = brands.find((x) => x.publicId === g.brand);
            if (!b || b.lifecycleState !== 'active' || !canGrantBrand(ip, b, g.level)) continue;
            await tx.db
              .insertInto('access.role_assignment')
              .values({
                id: newUuidV7(),
                workspace_id: tx.workspaceId,
                principal_type: 'membership',
                principal_id: membershipId,
                scope_type: 'brand',
                scope_id: b.id,
                role_id: await this.#roleId(tx, `scope_${g.level}`),
                role_kind: 'scope_level',
                grant_source: 'assigned',
                granted_by_membership_id: ip.membershipId,
              })
              .execute();
          }
        } else {
          for (const r of proposal.records ?? []) {
            const res = await this.#resolveShare(tx, ip, r.record);
            if (res.kind !== 'ok' || !res.target.levels.includes(r.level)) continue;
            const rec = res.target;
            await this.#insertShare(
              tx,
              acceptCaller,
              ip,
              rec,
              [rec],
              { type: 'membership', id: membershipId },
              r.level,
              null,
            );
          }
        }
        await tx.db
          .updateTable('tenancy.invitation')
          .set({
            state: 'accepted',
            accepted_account_id: auth.account.id,
            accepted_membership_id: membershipId,
            decided_at: now,
            updated_at: now,
            version: sql`version + 1`,
          })
          .where('id', '=', inv.id)
          .execute();
        await bumpEpoch(tx, 'principal', membershipId);
        await bumpEpoch(tx, 'workspace', null);
        const newP = await compilePrincipal(
          tx,
          membershipId,
          auth.account.id,
          inv.kind as 'member' | 'guest',
        );
        await this.d.writer.write(tx, this.cmd(caller, newP), {
          action: 'invitation.accepted',
          target: { recordId: inv.id, type: 'invitation', publicId: inv.public_id },
          changes: [
            change.plain('member', null, membershipPublicId),
            change.plain('kind', null, inv.kind),
          ],
        });
        await this.security(tx, caller, newP, 'invitation.accepted', {
          type: 'membership',
          id: membershipId,
        });
        await writeOutboxEvent(tx, {
          type: 'tenancy.membership.activated',
          aggregate: { type: 'tenancy.membership', id: membershipId, sequence: version },
          data: { kind: inv.kind, reason: 'invitation' },
          actor: { type: 'human', id: membershipId },
          context: this.exec(caller, newP),
        });
        return { workspace: { id: ws.public_id, name: ws.name }, replayed: false };
      })
      .catch((err: unknown) => {
        throw this.mapFailure('invitation.accept', err);
      });
    if (!result) {
      await outcome('not_found');
      throw new TenancyError('not_found');
    }
    await outcome(result.replayed ? 'replayed' : 'accepted');
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // Teams (COL-003)
  // ---------------------------------------------------------------------------------------------

  async #team(tx: WorkspaceTransaction, publicId: unknown, lock = false): Promise<TeamRef> {
    if (typeof publicId !== 'string' || !PUBLIC('team').test(publicId))
      throw new TenancyError('not_found');
    let q = tx.db
      .selectFrom('tenancy.team as t')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
      )
      .select(['t.id', 'r.public_id', 't.name', 't.description', 't.lifecycle_state', 't.version'])
      .where('r.public_id', '=', publicId)
      .where('t.lifecycle_state', 'in', ['active', 'archived']);
    if (lock) q = q.forUpdate('t');
    const t = await q.executeTakeFirst();
    if (!t) throw new TenancyError('not_found');
    return {
      id: t.id,
      publicId: t.public_id,
      name: t.name,
      description: t.description,
      lifecycleState: t.lifecycle_state,
      version: Number(t.version),
    };
  }

  async #teamGrants(tx: WorkspaceTransaction, teamId: string) {
    const rows = await tx.db
      .selectFrom('access.role_assignment as a')
      .innerJoin('access.role as r', (j) =>
        j.onRef('r.workspace_id', '=', 'a.workspace_id').onRef('r.id', '=', 'a.role_id'),
      )
      .select(['a.brand_scope_id', 'r.level', 'a.expires_at'])
      .where('a.team_principal_id', '=', teamId)
      .where('a.scope_type', '=', 'brand')
      .execute();
    return rows
      .filter((r) => r.brand_scope_id && r.level)
      .map((r) => ({
        brandId: r.brand_scope_id!,
        level: r.level as Level,
        expiresAt: r.expires_at ? new Date(r.expires_at) : null,
      }));
  }

  async #teamView(tx: WorkspaceTransaction, p: Principal, team: TeamRef) {
    const members = await tx.db
      .selectFrom('tenancy.team_member as tm')
      .innerJoin('tenancy.membership as m', (j) =>
        j.onRef('m.workspace_id', '=', 'tm.workspace_id').onRef('m.id', '=', 'tm.membership_id'),
      )
      .innerJoin('identity.account as a', 'a.id', 'm.account_id')
      .select(['m.public_id', 'm.display_name_override', 'a.display_name'])
      .where('tm.team_id', '=', team.id)
      .orderBy(sql`lower(coalesce(m.display_name_override, a.display_name))`)
      .execute();
    const brands = await brandRefs(tx);
    const visible = new Set(inspectable(p, brands).map((b) => b.id));
    const grants = (await this.#teamGrants(tx, team.id))
      .filter((g) => visible.has(g.brandId))
      .map((g) => {
        const b = brands.find((x) => x.id === g.brandId)!;
        return {
          brand: { id: b.publicId, name: b.name },
          level: g.level,
          expires_at: g.expiresAt?.toISOString() ?? null,
        };
      });
    return {
      id: team.publicId,
      type: 'team' as const,
      name: team.name,
      description: team.description,
      lifecycle_state: team.lifecycleState,
      version: team.version,
      members: members.map((m) => ({
        id: m.public_id,
        display_name: m.display_name_override ?? m.display_name,
      })),
      brand_access: grants,
      capabilities: { manage: decideWorkspace(p, 'team.manage').allowed },
    };
  }

  async listTeams(caller: Caller, workspacePublicId: unknown, query: { state?: unknown }) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      this.#directory(p);
      const states = query.state === 'archived' ? (['archived'] as const) : (['active'] as const);
      const rows = await tx.db
        .selectFrom('tenancy.team as t')
        .innerJoin('core.record as r', (j) =>
          j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
        )
        .select(['r.public_id'])
        .where('t.lifecycle_state', 'in', [...states])
        .orderBy(sql`lower(t.name)`)
        .orderBy('t.id')
        .limit(500)
        .execute();
      const out = [];
      for (const r of rows)
        out.push(await this.#teamView(tx, p, await this.#team(tx, r.public_id)));
      return out;
    });
  }

  async getTeam(caller: Caller, workspacePublicId: unknown, teamPublicId: unknown) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      this.#directory(p);
      return this.#teamView(tx, p, await this.#team(tx, teamPublicId));
    });
  }

  async createTeam(caller: Caller, workspacePublicId: unknown, body: unknown, req: Mutation) {
    const issues = new Issues();
    const b = isObject(body) ? body : {};
    for (const k of Object.keys(b))
      if (k !== 'name' && k !== 'description')
        issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
    const name = text(b.name, '/name', issues, { max: 80, required: true, label: 'Team name' });
    const description = text(b.description, '/description', issues, {
      max: 2000,
      required: false,
      label: 'Description',
    });
    issues.throwIfAny();
    return this.mutate(
      caller,
      'team.create',
      workspacePublicId,
      req,
      async (tx, p) => {
        this.#directory(p);
        this.#require(p, 'team.manage', decideWorkspace(p, 'team.manage').allowed);
        const env = await createRecord(tx, this.d.writer, this.cmd(caller, p), {
          recordType: 'team',
        });
        await tx.db
          .insertInto('tenancy.team')
          .values({
            id: env.id,
            workspace_id: tx.workspaceId,
            scope_key: tx.workspaceId,
            name: name!,
            description: description ?? null,
            created_by_membership_id: p.membershipId,
            updated_by_membership_id: p.membershipId,
          })
          .execute();
        await this.#audit(
          tx,
          caller,
          p,
          'team.created',
          { recordId: env.id, type: 'team', publicId: env.publicId },
          [change.plain('name', null, name!)],
        );
        const data = await this.#teamView(tx, p, await this.#team(tx, env.publicId));
        return { status: 201, ref: { id: data.id, type: 'team' }, data };
      },
      async (tx, p, ref) => this.#teamView(tx, p, await this.#team(tx, ref.id)),
    ).catch((err: unknown) => {
      if (pg(err).constraint === 'team_name_unique')
        throw invalid(issue('/name', 'name_taken', 'That team name is already used.'));
      throw err;
    });
  }

  async updateTeam(
    caller: Caller,
    workspacePublicId: unknown,
    teamPublicId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const issues = new Issues();
    const b = isObject(body) ? body : {};
    for (const k of Object.keys(b))
      if (k !== 'name' && k !== 'description' && k !== 'version')
        issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
    const name =
      b.name === undefined
        ? undefined
        : text(b.name, '/name', issues, { max: 80, required: true, label: 'Team name' });
    const description =
      b.description === undefined
        ? undefined
        : text(b.description, '/description', issues, {
            max: 2000,
            required: false,
            label: 'Description',
          });
    issues.throwIfAny();
    return this.mutate(
      caller,
      'team.update',
      workspacePublicId,
      req,
      async (tx, p) => {
        this.#require(p, 'team.manage', decideWorkspace(p, 'team.manage').allowed);
        const t = await this.#team(tx, teamPublicId, true);
        if (t.lifecycleState !== 'active') throw new TenancyError('conflict');
        if (typeof b.version === 'number' && b.version !== t.version)
          throw new TenancyError('conflict', { conflict: { current_version: t.version } });
        const changes = [];
        if (name !== undefined && name !== t.name) changes.push(change.plain('name', t.name, name));
        if (description !== undefined && (description ?? null) !== t.description)
          changes.push(
            change.content('description', {
              hash: `sha256:${createHash('sha256')
                .update(String(description ?? ''))
                .digest('hex')}`,
            }),
          );
        if (changes.length) {
          await tx.db
            .updateTable('tenancy.team')
            .set({
              ...(name !== undefined ? { name: name! } : {}),
              ...(description !== undefined ? { description: description ?? null } : {}),
              updated_at: new Date(),
              updated_by_membership_id: p.membershipId,
              version: sql`version + 1`,
            })
            .where('id', '=', t.id)
            .execute();
          await this.#audit(
            tx,
            caller,
            p,
            'team.updated',
            { recordId: t.id, type: 'team', publicId: t.publicId },
            changes,
          );
        }
        const data = await this.#teamView(tx, p, await this.#team(tx, t.publicId));
        return { status: 200, ref: { id: data.id, type: 'team' }, data };
      },
      async (tx, p, ref) => this.#teamView(tx, p, await this.#team(tx, ref.id)),
    ).catch((err: unknown) => {
      if (pg(err).constraint === 'team_name_unique')
        throw invalid(issue('/name', 'name_taken', 'That team name is already used.'));
      throw err;
    });
  }

  /** Archive/restore a team through the 1F lifecycle; archived teams confer no grants. */
  async setTeamArchived(
    caller: Caller,
    workspacePublicId: unknown,
    teamPublicId: unknown,
    archived: boolean,
    req: Mutation,
  ) {
    return this.mutate(
      caller,
      archived ? 'team.archive' : 'team.restore',
      workspacePublicId,
      req,
      async (tx, p) => {
        this.#require(p, 'team.manage', decideWorkspace(p, 'team.manage').allowed);
        const t = await this.#team(tx, teamPublicId, true);
        const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
        if (archived && t.lifecycleState === 'active') {
          await this.d.lifecycle.archive(
            tx,
            issueLifecycleDecision('record.archive', tx.workspaceId, [t.id], p.membershipId),
            input,
            t.id,
          );
        } else if (!archived && t.lifecycleState === 'archived') {
          await this.d.lifecycle.unarchive(
            tx,
            issueLifecycleDecision('record.restore', tx.workspaceId, [t.id], p.membershipId),
            input,
            t.id,
          );
        }
        await bumpEpoch(tx, 'workspace', null);
        const data = await this.#teamView(tx, p, await this.#team(tx, t.publicId));
        return { status: 200, ref: { id: data.id, type: 'team' }, data };
      },
      async (tx, p, ref) => this.#teamView(tx, p, await this.#team(tx, ref.id)),
    ).catch((err: unknown) => {
      if (err instanceof LifecycleError) throw new TenancyError('conflict');
      throw err;
    });
  }

  async #applyTeamMember(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    team: TeamRef,
    m: MemberRow,
    add: boolean,
  ) {
    if (team.lifecycleState !== 'active') throw new TenancyError('conflict');
    if (add)
      await tx.db
        .insertInto('tenancy.team_member')
        .values({
          workspace_id: tx.workspaceId,
          team_id: team.id,
          membership_id: m.id,
          added_by_membership_id: p.membershipId,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    else
      await tx.db
        .deleteFrom('tenancy.team_member')
        .where('team_id', '=', team.id)
        .where('membership_id', '=', m.id)
        .execute();
    await bumpEpoch(tx, 'principal', m.id);
    await this.#audit(
      tx,
      caller,
      p,
      add ? 'team.member_added' : 'team.member_removed',
      { recordId: team.id, type: 'team', publicId: team.publicId },
      [change.plain('member', add ? null : m.public_id, add ? m.public_id : null)],
    );
    await this.security(tx, caller, p, add ? 'team.member_added' : 'team.member_removed', {
      type: 'membership',
      id: m.id,
    });
    await this.#event(
      tx,
      caller,
      p,
      'tenancy.team.membership_changed',
      { type: 'tenancy.team_member', id: team.id, sequence: team.version },
      {
        change: add ? 'added' : 'removed',
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Brand access (COL-004, PERM-003, PERM-006)
  // ---------------------------------------------------------------------------------------------

  async #brandByPublic(
    tx: WorkspaceTransaction,
    publicId: unknown,
    lock = false,
  ): Promise<BrandRef> {
    if (typeof publicId !== 'string' || !PUBLIC('br').test(publicId))
      throw new TenancyError('not_found');
    const refs = await brandRefs(tx);
    const b = refs.find((x) => x.publicId === publicId);
    if (!b || (b.lifecycleState !== 'active' && b.lifecycleState !== 'archived'))
      throw new TenancyError('not_found');
    if (lock)
      await tx.db
        .selectFrom('tenancy.brand')
        .select('id')
        .where('id', '=', b.id)
        .forUpdate()
        .execute();
    return b;
  }

  /** A grantee: an active internal membership or an active team (never a guest). */
  async #grantee(
    tx: WorkspaceTransaction,
    publicId: unknown,
    allowGuest = false,
  ): Promise<Grantee> {
    if (typeof publicId === 'string' && PUBLIC('team').test(publicId)) {
      const t = await this.#team(tx, publicId);
      if (t.lifecycleState !== 'active') throw new TenancyError('conflict');
      const grants = await this.#teamGrants(tx, t.id);
      return {
        type: 'team' as const,
        id: t.id,
        publicId: t.publicId,
        currentBrandLevel: (brandId: string) =>
          grants.find((g) => g.brandId === brandId)?.level ?? null,
        members: async () =>
          tx.db
            .selectFrom('tenancy.team_member as tm')
            .innerJoin('tenancy.membership as m', (j) =>
              j
                .onRef('m.workspace_id', '=', 'tm.workspace_id')
                .onRef('m.id', '=', 'tm.membership_id'),
            )
            .select(['m.id', 'm.account_id', 'm.kind'])
            .where('tm.team_id', '=', t.id)
            .where('m.state', '=', 'active')
            .orderBy('m.id')
            .execute(),
      };
    }
    const m = await this.#member(tx, publicId);
    if (allowGuest && m.state === 'active' && m.kind === 'guest')
      return {
        type: 'membership' as const,
        id: m.id,
        publicId: m.public_id,
        currentBrandLevel: () => null,
        members: async () => [{ id: m.id, account_id: m.account_id, kind: m.kind }],
      };
    if (m.kind !== 'member' || m.state !== 'active')
      throw invalid(
        issue(
          '/principal',
          'not_internal',
          'Brand access is only for active internal members and teams. Share records with guests instead.',
        ),
      );
    const direct = await tx.db
      .selectFrom('access.role_assignment as a')
      .innerJoin('access.role as r', (j) =>
        j.onRef('r.workspace_id', '=', 'a.workspace_id').onRef('r.id', '=', 'a.role_id'),
      )
      .select(['a.brand_scope_id', 'r.level'])
      .where('a.membership_principal_id', '=', m.id)
      .where('a.scope_type', '=', 'brand')
      .execute();
    return {
      type: 'membership' as const,
      id: m.id,
      publicId: m.public_id,
      currentBrandLevel: (brandId: string) =>
        (direct.find((d) => d.brand_scope_id === brandId)?.level as Level | undefined) ?? null,
      members: async () => [{ id: m.id, account_id: m.account_id, kind: m.kind }],
    };
  }

  /** A readable project by public id; unknown, foreign, and unreadable are the same not_found. */
  async #projectByPublic(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    lock = false,
  ): Promise<ProjectRef> {
    if (typeof publicId !== 'string' || !PUBLIC('prj').test(publicId))
      throw new TenancyError('not_found');
    let q = tx.db
      .selectFrom('core.record as r')
      .innerJoin('work.project as w', (j) =>
        j.onRef('w.workspace_id', '=', 'r.workspace_id').onRef('w.id', '=', 'r.id'),
      )
      .select(['r.id', 'r.public_id', 'w.name', 'w.brand_id', 'r.lifecycle_state'])
      .where('r.public_id', '=', publicId)
      .where('r.record_type', '=', 'project');
    if (lock) q = q.forUpdate('w');
    const row = await q.executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    const brand = (await brandRefs(tx)).find((b) => b.id === row.brand_id);
    const scope = await projectChainOf(tx, row.id);
    if (!brand || !scope) throw new TenancyError('not_found');
    const ref: ProjectRef = {
      id: row.id,
      publicId: row.public_id,
      name: row.name,
      brand,
      lifecycleState: row.lifecycle_state,
      chain: scope.chain,
    };
    const lv = recordLevel(p, {
      brand,
      lifecycleState: row.lifecycle_state,
      shareLevel: null,
      projectChain: scope.chain,
    });
    if (lv === null) throw new TenancyError('not_found');
    return ref;
  }

  /** The principal's current direct (or team) project-scope level. */
  async #projectGrantLevel(
    tx: WorkspaceTransaction,
    projectId: string,
    principal: Grantee,
  ): Promise<Level | null> {
    const row = await tx.db
      .selectFrom('access.role_assignment as a')
      .innerJoin('access.role as r', (j) =>
        j.onRef('r.workspace_id', '=', 'a.workspace_id').onRef('r.id', '=', 'a.role_id'),
      )
      .select('r.level')
      .where('a.principal_type', '=', principal.type)
      .where('a.principal_id', '=', principal.id)
      .where('a.project_scope_id', '=', projectId)
      .executeTakeFirst();
    return (row?.level as Level | undefined) ?? null;
  }

  async #applyProjectGrant(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    project: ProjectRef,
    principal: Grantee,
    level: Level,
  ) {
    const roleId = await this.#roleId(tx, `scope_${level}`);
    const existing = await tx.db
      .selectFrom('access.role_assignment')
      .select(['id', 'version'])
      .where('principal_type', '=', principal.type)
      .where('principal_id', '=', principal.id)
      .where('project_scope_id', '=', project.id)
      .forUpdate()
      .executeTakeFirst();
    let id: string;
    if (existing) {
      id = existing.id;
      await tx.db
        .updateTable('access.role_assignment')
        .set({ role_id: roleId, version: sql`version + 1` })
        .where('id', '=', existing.id)
        .execute();
    } else {
      id = newUuidV7();
      await tx.db
        .insertInto('access.role_assignment')
        .values({
          id,
          workspace_id: tx.workspaceId,
          principal_type: principal.type,
          principal_id: principal.id,
          scope_type: 'project',
          scope_id: project.id,
          role_id: roleId,
          role_kind: 'scope_level',
          grant_source: 'assigned',
          granted_by_membership_id: p.membershipId,
        })
        .execute();
    }
    for (const m of await principal.members()) await bumpEpoch(tx, 'principal', m.id);
    await bumpEpoch(tx, 'workspace', null);
    await this.#audit(
      tx,
      caller,
      p,
      'role_assignment.granted',
      { recordId: project.id, type: 'project', publicId: project.publicId },
      [change.plain('principal', null, principal.publicId), change.plain('level', null, level)],
      project.brand.id,
    );
    await this.security(tx, caller, p, 'role_assignment.granted', {
      type: principal.type,
      id: principal.id,
    });
    await this.#event(
      tx,
      caller,
      p,
      'access.role.assigned',
      { type: 'access.role_assignment', id, sequence: existing ? Number(existing.version) + 1 : 0 },
      { scope_type: 'project', role_id: roleId },
    );
  }

  async #applyProjectRevoke(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    project: ProjectRef,
    principal: Grantee,
  ) {
    const row = await tx.db
      .selectFrom('access.role_assignment')
      .select(['id', 'version'])
      .where('principal_type', '=', principal.type)
      .where('principal_id', '=', principal.id)
      .where('project_scope_id', '=', project.id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return;
    await tx.db.deleteFrom('access.role_assignment').where('id', '=', row.id).execute();
    // The last eligible manager of an active project cannot be removed (deferred database guard).
    try {
      await sql`SET CONSTRAINTS access.project_manager_on_assignment IMMEDIATE`.execute(tx.db);
    } catch (err) {
      if (pg(err).code === '23514')
        throw new TenancyError('conflict', {
          issues: [
            issue(
              '/',
              'last_project_manager',
              'A project needs at least one person with manage access.',
            ),
          ],
        });
      throw err;
    }
    await sql`SET CONSTRAINTS access.project_manager_on_assignment DEFERRED`.execute(tx.db);
    for (const m of await principal.members()) await bumpEpoch(tx, 'principal', m.id);
    await bumpEpoch(tx, 'workspace', null);
    await this.#audit(
      tx,
      caller,
      p,
      'role_assignment.revoked',
      { recordId: project.id, type: 'project', publicId: project.publicId },
      [change.plain('principal', principal.publicId, null)],
      project.brand.id,
    );
    await this.security(tx, caller, p, 'role_assignment.revoked', {
      type: principal.type,
      id: principal.id,
    });
    await this.#event(
      tx,
      caller,
      p,
      'access.role.revoked',
      { type: 'access.role_assignment', id: row.id, sequence: Number(row.version) + 1 },
      { scope_type: 'project' },
    );
  }

  async listBrandAccess(caller: Caller, workspacePublicId: unknown, brandPublicId: unknown) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      this.#directory(p);
      const b = await this.#brandByPublic(tx, brandPublicId);
      if (brandLevel(p, b) === null) throw new TenancyError('not_found');
      this.#require(p, 'access.grant_scope', decideBrand(p, 'access.grant_scope', b).allowed);
      const rows = await tx.db
        .selectFrom('access.role_assignment as a')
        .innerJoin('access.role as r', (j) =>
          j.onRef('r.workspace_id', '=', 'a.workspace_id').onRef('r.id', '=', 'a.role_id'),
        )
        .leftJoin('tenancy.membership as m', (j) =>
          j
            .onRef('m.workspace_id', '=', 'a.workspace_id')
            .onRef('m.id', '=', 'a.membership_principal_id'),
        )
        .leftJoin('identity.account as acc', 'acc.id', 'm.account_id')
        .leftJoin('tenancy.team as t', (j) =>
          j
            .onRef('t.workspace_id', '=', 'a.workspace_id')
            .onRef('t.id', '=', 'a.team_principal_id'),
        )
        .leftJoin('core.record as tr', (j) =>
          j.onRef('tr.workspace_id', '=', 't.workspace_id').onRef('tr.id', '=', 't.id'),
        )
        .select([
          'a.principal_type',
          'm.public_id as member_id',
          'acc.display_name',
          'm.display_name_override',
          'tr.public_id as team_id',
          't.name as team_name',
          'r.level',
          'a.expires_at',
          'a.grant_source',
        ])
        .where('a.brand_scope_id', '=', b.id)
        .orderBy('a.principal_type')
        .orderBy('a.created_at')
        .execute();
      return {
        brand: { id: b.publicId, name: b.name, is_sensitive: b.isSensitive },
        implicit: b.isSensitive ? 'none' : 'owners_and_administrators',
        grants: rows.map((r) => ({
          principal:
            r.principal_type === 'team'
              ? { type: 'team', id: r.team_id, name: r.team_name }
              : {
                  type: 'membership',
                  id: r.member_id,
                  name: r.display_name_override ?? r.display_name,
                },
          level: r.level,
          expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
          source: r.grant_source,
        })),
      };
    });
  }

  async #applyBrandGrant(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    brand: BrandRef,
    principal: Grantee,
    level: Level,
    expiresAt: string | null,
  ) {
    if (brand.lifecycleState !== 'active') throw new TenancyError('conflict');
    const roleId = await this.#roleId(tx, `scope_${level}`);
    const existing = await tx.db
      .selectFrom('access.role_assignment')
      .select(['id', 'version'])
      .where('principal_type', '=', principal.type)
      .where('principal_id', '=', principal.id)
      .where('brand_scope_id', '=', brand.id)
      .forUpdate()
      .executeTakeFirst();
    let id: string;
    if (existing) {
      id = existing.id;
      await tx.db
        .updateTable('access.role_assignment')
        .set({
          role_id: roleId,
          expires_at: expiresAt ? new Date(expiresAt) : null,
          version: sql`version + 1`,
        })
        .where('id', '=', existing.id)
        .execute();
    } else {
      id = newUuidV7();
      await tx.db
        .insertInto('access.role_assignment')
        .values({
          id,
          workspace_id: tx.workspaceId,
          principal_type: principal.type,
          principal_id: principal.id,
          scope_type: 'brand',
          scope_id: brand.id,
          role_id: roleId,
          role_kind: 'scope_level',
          grant_source: 'assigned',
          granted_by_membership_id: p.membershipId,
          expires_at: expiresAt ? new Date(expiresAt) : null,
        })
        .execute();
    }
    for (const m of await principal.members()) await bumpEpoch(tx, 'principal', m.id);
    await bumpEpoch(tx, 'workspace', null);
    await this.#audit(
      tx,
      caller,
      p,
      'role_assignment.granted',
      { recordId: id, type: 'role_assignment', publicId: null },
      [
        change.plain('principal', null, principal.publicId),
        change.plain('brand', null, brand.publicId),
        change.plain('level', null, level),
      ],
      brand.id,
    );
    await this.security(tx, caller, p, 'role_assignment.granted', {
      type: principal.type,
      id: principal.id,
    });
    await this.#event(
      tx,
      caller,
      p,
      'access.role.assigned',
      { type: 'access.role_assignment', id, sequence: existing ? Number(existing.version) + 1 : 0 },
      {
        scope_type: 'brand',
        role_id: roleId,
      },
    );
  }

  async #applyBrandRevoke(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    brand: BrandRef,
    principal: Grantee,
  ) {
    const row = await tx.db
      .selectFrom('access.role_assignment')
      .select(['id', 'version'])
      .where('principal_type', '=', principal.type)
      .where('principal_id', '=', principal.id)
      .where('brand_scope_id', '=', brand.id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return;
    if (brand.isSensitive) {
      // A sensitive brand must keep at least one explicit manager (nobody has implicit access).
      const managers = await tx.db
        .selectFrom('access.role_assignment as a')
        .innerJoin('access.role as r', (j) =>
          j.onRef('r.workspace_id', '=', 'a.workspace_id').onRef('r.id', '=', 'a.role_id'),
        )
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('a.brand_scope_id', '=', brand.id)
        .where('r.level', '=', 'manage')
        .where('a.id', '<>', row.id)
        .executeTakeFirstOrThrow();
      if (Number(managers.n) === 0)
        throw new TenancyError('conflict', {
          issues: [
            issue(
              '/',
              'last_brand_manager',
              'A sensitive brand needs at least one person with manage access.',
            ),
          ],
        });
    }
    await tx.db.deleteFrom('access.role_assignment').where('id', '=', row.id).execute();
    for (const m of await principal.members()) await bumpEpoch(tx, 'principal', m.id);
    await bumpEpoch(tx, 'workspace', null);
    await this.#audit(
      tx,
      caller,
      p,
      'role_assignment.revoked',
      { recordId: row.id, type: 'role_assignment', publicId: null },
      [
        change.plain('principal', principal.publicId, null),
        change.plain('brand', brand.publicId, null),
      ],
      brand.id,
    );
    await this.security(tx, caller, p, 'role_assignment.revoked', {
      type: principal.type,
      id: principal.id,
    });
    await this.#event(
      tx,
      caller,
      p,
      'access.role.revoked',
      { type: 'access.role_assignment', id: row.id, sequence: Number(row.version) + 1 },
      {
        scope_type: 'brand',
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Explicit record shares (WSB-008, PERM-005): generic primitives over core.record targets
  // ---------------------------------------------------------------------------------------------

  async #resolveShare(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
  ): Promise<ShareResolution> {
    if (typeof publicId !== 'string' || !/^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/.test(publicId))
      return { kind: 'not_found' };
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const r = await tx.db
      .selectFrom('core.record as r')
      .innerJoin('core.record_type as t', 't.record_type', 'r.record_type')
      .select([
        'r.id',
        'r.public_id',
        'r.record_type',
        'r.brand_id',
        'r.lifecycle_state',
        't.test_only',
      ])
      .where('r.public_id', '=', publicId)
      .where('r.record_type', 'not in', ['brand', 'team'])
      .where(vis.where('r'))
      .executeTakeFirst();
    if (!r) return { kind: 'not_found' };
    const levels = shareableLevels(r.record_type, r.test_only);
    if (!levels) return { kind: 'forbidden', reason: 'not_shareable_type' };
    const brand = r.brand_id ? (vis.ctx.brands.find((b) => b.id === r.brand_id) ?? null) : null;
    // The governing project (a project itself, or a task's project) decides chain and restriction.
    const governing = await governingProjectId(tx, { id: r.id, recordType: r.record_type });
    const project = governing ? await projectChainOf(tx, governing) : null;
    // Onward sharing is never derived from shares (AT-050): ownership-derived level only.
    const d = decideRecord(p, 'record.share', {
      brand,
      lifecycleState: r.lifecycle_state,
      shareLevel: null,
      projectChain: project?.chain ?? null,
    });
    if (!d.allowed) return { kind: 'forbidden', reason: 'not_permitted' };
    // Restricted projects take new shares only when the project allows them (0C §4.3).
    if (project && project.chain.some((n) => n.restricted) && !project.allowRecordShares)
      return { kind: 'forbidden', reason: 'record_shares_disallowed' };
    return {
      kind: 'ok',
      target: {
        id: r.id,
        publicId: r.public_id,
        recordType: r.record_type,
        brandId: r.brand_id,
        levels,
        sharesChildren: sharesChildren(r.record_type, r.test_only),
      },
    };
  }

  /** The resolved target, or the safe refusal (not_found / forbidden with a reason issue). */
  async #shareTarget(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    pointer: string,
  ): Promise<ShareTarget> {
    const res = await this.#resolveShare(tx, p, publicId);
    if (res.kind === 'ok') return res.target;
    if (res.kind === 'not_found') throw new TenancyError('not_found');
    throw new TenancyError('forbidden', {
      issues: [issue(pointer, res.reason, SHARE_REFUSAL[res.reason])],
    });
  }

  async #validateShareTargets(
    tx: WorkspaceTransaction,
    p: Principal,
    records: ReadonlyArray<{ record: string; level: ShareLevel }>,
    pointer: string,
  ) {
    for (const [i, r] of records.entries()) {
      const target = await this.#shareTarget(tx, p, r.record, `${pointer}/${i}/record`);
      if (!target.levels.includes(r.level))
        throw invalid(
          issue(
            `${pointer}/${i}/level`,
            'level_not_supported',
            "That access level isn't available for this item.",
          ),
        );
    }
  }

  async #insertShare(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    source: ShareTarget,
    records: ReadonlyArray<ShareTarget>,
    grantee: { type: 'membership' | 'team' | 'brand'; id: string },
    level: ShareLevel,
    expiresAt: Date | null,
  ) {
    const groupId = newUuidV7();
    const groupPublic = newPublicId('shr');
    await tx.db
      .insertInto('access.share_group')
      .values({
        id: groupId,
        public_id: groupPublic,
        workspace_id: tx.workspaceId,
        source_record_id: source.id,
        source_brand_id: source.brandId,
        grantee_type: grantee.type,
        grantee_id: grantee.id,
        level,
        expires_at: expiresAt,
        created_by_membership_id: p.membershipId,
        record_count: records.length,
      })
      .execute();
    for (const r of records) {
      const gid = newUuidV7();
      await tx.db
        .insertInto('access.record_grant')
        .values({
          id: gid,
          public_id: newPublicId('grt'),
          workspace_id: tx.workspaceId,
          share_group_id: groupId,
          record_id: r.id,
          source_brand_id: r.brandId,
          grantee_type: grantee.type,
          grantee_id: grantee.id,
          level,
          expires_at: expiresAt,
          created_by_membership_id: p.membershipId,
        })
        .execute();
      await this.#event(
        tx,
        caller,
        p,
        'access.grant.created',
        { type: 'access.record_grant', id: gid, sequence: 0 },
        {
          record_id: r.id,
          grantee_type: grantee.type,
          level,
          expires_at: expiresAt ? expiresAt.toISOString() : null,
        },
      );
    }
    if (grantee.type === 'membership') await bumpEpoch(tx, 'principal', grantee.id);
    await this.#audit(
      tx,
      caller,
      p,
      'grant.created',
      { recordId: groupId, type: 'share_group', publicId: groupPublic },
      [
        change.plain('records', null, records.length),
        change.plain('grantee_type', null, grantee.type),
        change.plain('level', null, level),
      ],
      source.brandId,
    );
    await this.security(tx, caller, p, 'grant.created', { type: 'share_group', id: groupId });
    return groupPublic;
  }

  /**
   * Creates one share group with one fixed grant row per selected record (no descendants, no
   * future children). Guests receive membership grants only, capped at edit; cross-brand shares
   * follow `cross_brand_sharing_enabled`; expiry is capped by `share_max_expiry`.
   */
  async createShare(caller: Caller, workspacePublicId: unknown, body: unknown, req: Mutation) {
    const input = parseShare(body);
    return this.mutate(
      caller,
      'grant.create',
      workspacePublicId,
      req,
      async (tx, p) => {
        const id = await this.#createShareTx(tx, caller, p, input);
        const data = await this.#shareView(tx, id);
        return { status: 201, ref: { id, type: 'share_group' }, data };
      },
      async (tx, _p, ref) => this.#shareView(tx, ref.id),
    );
  }

  /** One share inside the caller's transaction (direct command or a reviewed `record_share`). */
  async #createShareTx(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    input: ReturnType<typeof parseShare>,
  ): Promise<string> {
    const source = await this.#shareTarget(tx, p, input.record, '/record');
    this.decision('record.share', { allowed: true });
    if (!source.levels.includes(input.level))
      throw invalid(
        issue('/level', 'level_not_supported', "That access level isn't available for this item."),
      );
    if (input.children.length && !source.sharesChildren)
      throw invalid(
        issue(
          '/children',
          'children_not_shareable',
          'This item is shared on its own; contained items are never included.',
        ),
      );
    const records = [source];
    for (const [i, id] of input.children.entries()) {
      const res = await this.#resolveShare(tx, p, id);
      if (res.kind !== 'ok' || !res.target.levels.includes(input.level))
        throw invalid(
          issue(`/children/${i}`, 'not_shareable', "That item isn't available to share."),
        );
      records.push(res.target);
    }
    let grantee: { type: 'membership' | 'team' | 'brand'; id: string };
    let granteeBrandId: string | null = null;
    if (PUBLIC('mem').test(input.grantee)) {
      const m = await this.#member(tx, input.grantee);
      if (m.state !== 'active')
        throw invalid(issue('/grantee', 'not_active', 'Choose an active person.'));
      grantee = { type: 'membership', id: m.id };
    } else if (PUBLIC('team').test(input.grantee)) {
      const t = await this.#team(tx, input.grantee);
      if (t.lifecycleState !== 'active')
        throw invalid(issue('/grantee', 'not_active', 'Choose an active team.'));
      grantee = { type: 'team', id: t.id };
    } else {
      const b = await this.#brandByPublic(tx, input.grantee);
      if (b.lifecycleState !== 'active' || brandLevel(p, b) === null)
        throw new TenancyError('not_found');
      grantee = { type: 'brand', id: b.id };
      granteeBrandId = b.id;
    }
    const crossBrand =
      (granteeBrandId !== null && granteeBrandId !== source.brandId) ||
      records.some((r) => r.brandId !== source.brandId);
    if (crossBrand && !p.policy.cross_brand_sharing_enabled)
      throw new TenancyError('forbidden', {
        issues: [
          issue(
            '/grantee',
            'cross_brand_sharing_disabled',
            'Sharing across brands is turned off for this workspace.',
          ),
        ],
      });
    let expiresAt = input.expires_at;
    if (p.policy.share_max_expiry) {
      const max = await sql<{
        t: Date;
      }>`SELECT now() + ${p.policy.share_max_expiry}::interval AS t`.execute(tx.db);
      const cap = max.rows[0]!.t;
      if (!expiresAt || expiresAt > cap) expiresAt = cap;
    }
    const id = await this.#insertShare(
      tx,
      caller,
      p,
      source,
      records,
      grantee,
      input.level,
      expiresAt,
    );
    return id;
  }

  async #shareView(tx: WorkspaceTransaction, publicId: string) {
    const g = await tx.db
      .selectFrom('access.share_group as g')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'g.workspace_id').onRef('r.id', '=', 'g.source_record_id'),
      )
      .select([
        'g.public_id',
        'g.level',
        'g.state',
        'g.expires_at',
        'g.record_count',
        'g.grantee_type',
        'r.public_id as record',
      ])
      .where('g.public_id', '=', publicId)
      .executeTakeFirstOrThrow();
    return {
      id: g.public_id,
      type: 'share_group' as const,
      record: g.record,
      grantee_type: g.grantee_type,
      level: g.level,
      state: g.state,
      expires_at: g.expires_at ? new Date(g.expires_at).toISOString() : null,
      record_count: g.record_count,
    };
  }

  async revokeShare(
    caller: Caller,
    workspacePublicId: unknown,
    sharePublicId: unknown,
    req: Mutation,
  ) {
    return this.mutate(
      caller,
      'grant.revoke',
      workspacePublicId,
      req,
      async (tx, p) => {
        if (typeof sharePublicId !== 'string' || !PUBLIC('shr').test(sharePublicId))
          throw new TenancyError('not_found');
        const g = await tx.db
          .selectFrom('access.share_group')
          .selectAll()
          .where('public_id', '=', sharePublicId)
          .forUpdate()
          .executeTakeFirst();
        if (!g) throw new TenancyError('not_found');
        const src = await tx.db
          .selectFrom('core.record')
          .select('public_id')
          .where('id', '=', g.source_record_id)
          .executeTakeFirstOrThrow();
        const res = await this.#resolveShare(tx, p, src.public_id);
        const allowed = g.created_by_membership_id === p.membershipId || res.kind === 'ok';
        // Readable source without share authority: forbidden; otherwise nothing is disclosed.
        if (!allowed) throw new TenancyError(res.kind === 'forbidden' ? 'forbidden' : 'not_found');
        this.decision('record.share_revoke', { allowed: true });
        if (g.state === 'active') {
          const now = new Date();
          await tx.db
            .updateTable('access.share_group')
            .set({
              state: 'revoked',
              revoked_at: now,
              revoked_by_membership_id: p.membershipId,
              version: sql`version + 1`,
            })
            .where('id', '=', g.id)
            .execute();
          const grants = await tx.db
            .updateTable('access.record_grant')
            .set({
              state: 'revoked',
              revoked_at: now,
              revoked_by_membership_id: p.membershipId,
              version: sql`version + 1`,
            })
            .where('share_group_id', '=', g.id)
            .where('state', '=', 'active')
            .returning(['id', 'record_id', 'version'])
            .execute();
          for (const x of grants)
            await this.#event(
              tx,
              caller,
              p,
              'access.grant.revoked',
              { type: 'access.record_grant', id: x.id, sequence: Number(x.version) },
              {
                record_id: x.record_id,
                grantee_type: g.grantee_type,
              },
            );
          if (g.grantee_membership_id) await bumpEpoch(tx, 'principal', g.grantee_membership_id);
          await this.#audit(
            tx,
            caller,
            p,
            'grant.revoked',
            { recordId: g.id, type: 'share_group', publicId: g.public_id },
            [change.plain('state', 'active', 'revoked')],
            g.source_brand_id,
          );
          await this.security(tx, caller, p, 'grant.revoked', { type: 'share_group', id: g.id });
        }
        const data = await this.#shareView(tx, g.public_id);
        return { status: 200, ref: { id: data.id, type: 'share_group' }, data };
      },
      async (tx, _p, ref) => this.#shareView(tx, ref.id),
    );
  }

  /** Records the caller can read (all branches of the visibility predicate); guests: shares only. */
  async listReadableRecords(caller: Caller, workspacePublicId: unknown) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      const vis = await compileVisibility(tx, p, {
        need: 'view',
        arrayMax: this.c.settings.principalContextArrayMax,
      });
      this.d.metrics.count('tenancy.context_strategy', 1, { strategy: vis.ctx.strategy });
      const rows = await tx.db
        .selectFrom('core.record as r')
        .leftJoin('tenancy.brand as b', (j) =>
          j.onRef('b.workspace_id', '=', 'r.workspace_id').onRef('b.id', '=', 'r.brand_id'),
        )
        .leftJoin('core.record as br', (j) =>
          j.onRef('br.workspace_id', '=', 'b.workspace_id').onRef('br.id', '=', 'b.id'),
        )
        .select([
          'r.public_id',
          'r.record_type',
          'r.lifecycle_state',
          'br.public_id as brand_public_id',
          'b.name as brand_name',
          'b.short_name as brand_short_name',
          'b.icon as brand_icon',
          'b.color as brand_color',
          'b.lifecycle_state as brand_state',
        ])
        .where('r.record_type', 'not in', ['brand', 'team'])
        .where(vis.where('r'))
        .orderBy('r.id')
        .limit(200)
        .execute();
      return rows.map((r) => ({
        id: r.public_id,
        type: r.record_type,
        lifecycle_state: r.lifecycle_state,
        // The owning brand marker only (UXD-06, WSB-015); never other brands, parents, or
        // relationships. Workspace-scoped records carry the neutral workspace marker.
        brand:
          r.brand_name && r.brand_public_id
            ? brandMarker({
                public_id: r.brand_public_id,
                name: r.brand_name,
                short_name: r.brand_short_name,
                color: r.brand_color!,
                icon: r.brand_icon!,
                lifecycle_state: r.brand_state!,
              })
            : ({ kind: 'workspace' } as const),
      }));
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Workspace policy (ADM-014; 0C AZ-19)
  // ---------------------------------------------------------------------------------------------

  async getPolicy(caller: Caller, workspacePublicId: unknown) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      this.#require(
        p,
        'workspace.view_settings',
        decideWorkspace(p, 'workspace.view_settings').allowed,
      );
      return policyView(p);
    });
  }

  /**
   * Field-merge update of policy fields. Each field needs its governing action (sharing fields:
   * `sharing.policy.configure` with step-up; others: `workspace.configure`; `admins_manage_billing`:
   * owner-only). Loosening a field requires `confirm_exposure: true`.
   */
  async updatePolicy(caller: Caller, workspacePublicId: unknown, body: unknown, req: Mutation) {
    const b = isObject(body) ? body : {};
    const changesIn = isObject(b.changes) ? b.changes : {};
    return this.mutate(
      caller,
      'workspace_policy.update',
      workspacePublicId,
      req,
      async (tx, p) => {
        const issues = new Issues();
        const next: Record<string, unknown> = {};
        const loosened: string[] = [];
        let needsStepUp = false;
        for (const [field, value] of Object.entries(changesIn)) {
          const def = POLICY_FIELDS.get(field);
          if (!def || field === 'public_links_enabled') {
            issues.add(`/changes/${field}`, 'unsupported_field', 'This setting cannot be changed.');
            continue;
          }
          const v = isObject(value) && 'value' in value ? value.value : value;
          const parsed = parsePolicyValue(field, v, issues);
          if (parsed === undefined) continue;
          const gov = def.governedBy as ActionKey;
          const ok = def.ownerOnly ? p.role === 'owner' : decideWorkspace(p, gov).allowed;
          this.#require(p, gov, ok);
          if (gov === 'sharing.policy.configure') needsStepUp = true;
          if (isLoosening(field, (p.policy as Record<string, unknown>)[field], parsed))
            loosened.push(field);
          next[field] = parsed;
        }
        issues.throwIfAny();
        if (!Object.keys(next).length)
          throw invalid(issue('/changes', 'required', 'Send at least one changed setting.'));
        if (loosened.length && b.confirm_exposure !== true)
          throw new TenancyError('conflict', {
            issues: loosened.map((f) =>
              issue(
                `/changes/${f}`,
                'exposure_confirmation_required',
                'This change gives people more access. Confirm to continue.',
              ),
            ),
          });
        if (needsStepUp)
          await this.stepUp(tx, caller, p, req, 'sharing.policy.configure', {
            type: 'workspace',
            id: tx.workspaceId,
          });
        const now = new Date();
        await tx.db
          .insertInto('access.workspace_policy')
          .values({
            workspace_id: tx.workspaceId,
            ...(next as object),
            updated_at: now,
            updated_by_membership_id: p.membershipId,
          })
          .onConflict((oc) =>
            oc.column('workspace_id').doUpdateSet({
              ...(next as object),
              updated_at: now,
              updated_by_membership_id: p.membershipId,
              version: sql`access.workspace_policy.version + 1`,
            }),
          )
          .execute();
        await bumpEpoch(tx, 'workspace', null);
        const ws = await tx.db
          .selectFrom('tenancy.workspace')
          .select('public_id')
          .where('id', '=', tx.workspaceId)
          .executeTakeFirstOrThrow();
        await this.#audit(
          tx,
          caller,
          p,
          'workspace_policy.updated',
          { recordId: tx.workspaceId, type: 'workspace', publicId: ws.public_id },
          Object.entries(next).map(([f, v]) =>
            change.plain(
              f,
              normalizeAudit((p.policy as Record<string, unknown>)[f]),
              normalizeAudit(v),
            ),
          ),
        );
        await this.security(tx, caller, p, 'workspace_policy.updated', {
          type: 'workspace',
          id: tx.workspaceId,
        });
        const after = await compilePrincipal(tx, p.membershipId, p.accountId, p.kind);
        const data = { id: ws.public_id, type: 'workspace_policy', ...policyView(after) };
        return { status: 200, ref: { id: ws.public_id, type: 'workspace' }, data };
      },
      async (tx, p, ref) => ({
        id: ref.id,
        type: 'workspace_policy',
        ...policyView(await compilePrincipal(tx, p.membershipId, p.accountId, p.kind)),
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Ownership transfer (ADM-013)
  // ---------------------------------------------------------------------------------------------

  async #transferView(tx: WorkspaceTransaction, p: Principal) {
    await tx.db
      .updateTable('tenancy.ownership_transfer')
      .set({ state: 'expired', decided_at: new Date(), version: sql`version + 1` })
      .where('state', '=', 'pending')
      .where('expires_at', '<=', new Date())
      .execute()
      .catch(() => undefined);
    const t = await tx.db
      .selectFrom('tenancy.ownership_transfer as o')
      .innerJoin('tenancy.membership as f', (j) =>
        j.onRef('f.workspace_id', '=', 'o.workspace_id').onRef('f.id', '=', 'o.from_membership_id'),
      )
      .innerJoin('tenancy.membership as t', (j) =>
        j.onRef('t.workspace_id', '=', 'o.workspace_id').onRef('t.id', '=', 'o.to_membership_id'),
      )
      .innerJoin('identity.account as fa', 'fa.id', 'f.account_id')
      .innerJoin('identity.account as ta', 'ta.id', 't.account_id')
      .select([
        'o.public_id',
        'o.state',
        'o.expires_at',
        'o.demote_previous',
        'o.from_membership_id',
        'o.to_membership_id',
        'o.version',
        'f.public_id as from_id',
        'fa.display_name as from_name',
        't.public_id as to_id',
        'ta.display_name as to_name',
      ])
      .where('o.state', '=', 'pending')
      .executeTakeFirst();
    if (!t) return null;
    const involved =
      t.from_membership_id === p.membershipId || t.to_membership_id === p.membershipId;
    if (!involved && p.role !== 'owner') return null;
    return {
      id: t.public_id,
      type: 'ownership_transfer' as const,
      state: t.state,
      from: { id: t.from_id, display_name: t.from_name },
      to: { id: t.to_id, display_name: t.to_name },
      demote_previous: t.demote_previous,
      expires_at: new Date(t.expires_at).toISOString(),
      version: Number(t.version),
      capabilities: {
        accept: t.to_membership_id === p.membershipId,
        cancel: involved || p.role === 'owner',
      },
    };
  }

  async getOwnershipTransfer(caller: Caller, workspacePublicId: unknown) {
    return this.inWorkspace(caller, workspacePublicId, {}, async (tx, p) => {
      this.#directory(p);
      return this.#transferView(tx, p);
    });
  }

  async requestOwnershipTransfer(
    caller: Caller,
    workspacePublicId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const b = isObject(body) ? body : {};
    for (const k of Object.keys(b))
      if (k !== 'to' && k !== 'demote_previous')
        throw invalid(issue(`/${k}`, 'unsupported_field', 'This field is not supported.'));
    if (typeof b.demote_previous !== 'boolean')
      throw invalid(issue('/demote_previous', 'invalid_type', 'Choose whether you stay an owner.'));
    return this.mutate(
      caller,
      'ownership.request',
      workspacePublicId,
      req,
      async (tx, p) => {
        this.#require(p, 'ownership.transfer', decideWorkspace(p, 'ownership.transfer').allowed);
        const to = await this.#member(tx, b.to);
        if (to.kind !== 'member' || to.state !== 'active' || to.id === p.membershipId)
          throw invalid(
            issue('/to', 'invalid_recipient', 'Choose another active internal member.'),
          );
        if (to.role === 'owner')
          throw invalid(issue('/to', 'already_owner', 'This person is already an owner.'));
        const stepUpId = await this.stepUp(tx, caller, p, req, 'ownership.transfer', {
          type: 'membership',
          id: to.public_id,
        });
        await tx.db
          .updateTable('tenancy.ownership_transfer')
          .set({ state: 'expired', decided_at: new Date(), version: sql`version + 1` })
          .where('state', '=', 'pending')
          .where('expires_at', '<=', new Date())
          .execute();
        const id = newUuidV7();
        const publicId = newPublicId('otr');
        await tx.db
          .insertInto('tenancy.ownership_transfer')
          .values({
            id,
            public_id: publicId,
            workspace_id: tx.workspaceId,
            from_membership_id: p.membershipId,
            to_membership_id: to.id,
            demote_previous: b.demote_previous as boolean,
            expires_at: new Date(Date.now() + this.c.settings.ownershipTransferLifetimeMs),
            requested_step_up_id: stepUpId,
          })
          .execute()
          .catch((err: unknown) => {
            if (pg(err).constraint === 'ownership_transfer_one_pending')
              throw new TenancyError('conflict', {
                issues: [
                  issue(
                    '/',
                    'transfer_pending',
                    'An ownership transfer is already waiting for a response.',
                  ),
                ],
              });
            throw err;
          });
        await this.#audit(
          tx,
          caller,
          p,
          'ownership_transfer.requested',
          { recordId: id, type: 'ownership_transfer', publicId },
          [
            change.plain('to', null, to.public_id),
            change.plain('demote_previous', null, b.demote_previous as boolean),
          ],
        );
        await this.security(tx, caller, p, 'ownership_transfer.requested', {
          type: 'membership',
          id: to.id,
        });
        const data = (await this.#transferView(tx, p))!;
        return { status: 201, ref: { id: publicId, type: 'ownership_transfer' }, data };
      },
      async (tx, p) => (await this.#transferView(tx, p))!,
    );
  }

  async acceptOwnershipTransfer(
    caller: Caller,
    workspacePublicId: unknown,
    transferPublicId: unknown,
    req: Mutation,
  ) {
    return this.mutate(
      caller,
      'ownership.accept',
      workspacePublicId,
      req,
      async (tx, p) => {
        if (typeof transferPublicId !== 'string' || !PUBLIC('otr').test(transferPublicId))
          throw new TenancyError('not_found');
        const t = await tx.db
          .selectFrom('tenancy.ownership_transfer')
          .selectAll()
          .where('public_id', '=', transferPublicId)
          .forUpdate()
          .executeTakeFirst();
        // Only the recipient sees it (0C AZ-19 `own`); everyone else gets not_found (AT-104).
        if (
          !t ||
          t.to_membership_id !== p.membershipId ||
          t.state !== 'pending' ||
          t.expires_at.getTime() <= Date.now()
        ) {
          this.decision('ownership.accept', { allowed: false, code: 'not_found' });
          throw new TenancyError('not_found');
        }
        this.#require(
          p,
          'ownership.accept',
          decideWorkspace(p, 'ownership.accept').allowed && p.kind === 'member',
        );
        const stepUpId = await this.stepUp(tx, caller, p, req, 'ownership.accept', {
          type: 'ownership_transfer',
          id: t.public_id,
        });
        const owner = await this.#roleId(tx, 'owner');
        await tx.db
          .updateTable('access.role_assignment')
          .set({ role_id: owner, version: sql`version + 1` })
          .where('membership_principal_id', '=', p.membershipId)
          .where('scope_type', '=', 'workspace')
          .execute();
        let demoted = false;
        if (t.demote_previous) {
          const from = await tx.db
            .selectFrom('tenancy.membership')
            .select('state')
            .where('id', '=', t.from_membership_id)
            .executeTakeFirst();
          if (from?.state === 'active') {
            await tx.db
              .updateTable('access.role_assignment')
              .set({ role_id: await this.#roleId(tx, 'administrator'), version: sql`version + 1` })
              .where('membership_principal_id', '=', t.from_membership_id)
              .where('scope_type', '=', 'workspace')
              .execute();
            demoted = true;
            await bumpEpoch(tx, 'principal', t.from_membership_id);
          }
        }
        await tx.db
          .updateTable('tenancy.ownership_transfer')
          .set({
            state: 'accepted',
            accepted_step_up_id: stepUpId,
            decided_at: new Date(),
            decided_by_membership_id: p.membershipId,
            version: sql`version + 1`,
          })
          .where('id', '=', t.id)
          .execute();
        await bumpEpoch(tx, 'principal', p.membershipId);
        await bumpEpoch(tx, 'workspace', null);
        await this.#audit(
          tx,
          caller,
          p,
          'ownership_transfer.accepted',
          { recordId: t.id, type: 'ownership_transfer', publicId: t.public_id },
          [change.plain('demoted_previous', null, demoted)],
        );
        await this.security(tx, caller, p, 'ownership_transfer.accepted', {
          type: 'membership',
          id: p.membershipId,
        });
        await this.#event(
          tx,
          caller,
          p,
          'tenancy.ownership.transferred',
          { type: 'tenancy.ownership_transfer', id: t.id, sequence: Number(t.version) + 1 },
          {
            demoted_previous: demoted,
          },
        );
        return {
          status: 200,
          ref: { id: t.public_id, type: 'ownership_transfer' },
          data: {
            id: t.public_id,
            type: 'ownership_transfer',
            state: 'accepted' as const,
            demoted_previous: demoted as boolean | null,
          },
        };
      },
      async (_tx, _p, ref) => ({
        id: ref.id,
        type: 'ownership_transfer',
        state: 'accepted' as const,
        demoted_previous: null,
      }),
    );
  }

  async cancelOwnershipTransfer(
    caller: Caller,
    workspacePublicId: unknown,
    transferPublicId: unknown,
    req: Mutation,
  ) {
    return this.mutate(
      caller,
      'ownership.cancel',
      workspacePublicId,
      req,
      async (tx, p) => {
        if (typeof transferPublicId !== 'string' || !PUBLIC('otr').test(transferPublicId))
          throw new TenancyError('not_found');
        const t = await tx.db
          .selectFrom('tenancy.ownership_transfer')
          .selectAll()
          .where('public_id', '=', transferPublicId)
          .forUpdate()
          .executeTakeFirst();
        const involved =
          t &&
          (t.from_membership_id === p.membershipId ||
            t.to_membership_id === p.membershipId ||
            p.role === 'owner');
        if (!t || !involved) throw new TenancyError('not_found');
        if (t.state === 'pending') {
          await tx.db
            .updateTable('tenancy.ownership_transfer')
            .set({
              state: 'cancelled',
              decided_at: new Date(),
              decided_by_membership_id: p.membershipId,
              version: sql`version + 1`,
            })
            .where('id', '=', t.id)
            .execute();
          await this.#audit(tx, caller, p, 'ownership_transfer.cancelled', {
            recordId: t.id,
            type: 'ownership_transfer',
            publicId: t.public_id,
          });
          await this.security(tx, caller, p, 'ownership_transfer.cancelled', {
            type: 'membership',
            id: p.membershipId,
          });
        }
        return {
          status: 200,
          ref: { id: t.public_id, type: 'ownership_transfer' },
          data: { id: t.public_id, type: 'ownership_transfer', state: 'cancelled' as const },
        };
      },
      async (_tx, _p, ref) => ({
        id: ref.id,
        type: 'ownership_transfer',
        state: 'cancelled' as const,
      }),
    );
  }
}

// -----------------------------------------------------------------------------------------------
// Parsing and policy helpers
// -----------------------------------------------------------------------------------------------

const ACTIONS_ROLES = new Map(ACTIONS.map((a) => [a.key, a.roles]));
const POLICY_FIELDS = new Map(WORKSPACE_POLICY_FIELDS.map((f) => [f.field as string, f]));

function policyView(p: Principal) {
  const out: Record<string, unknown> = {};
  for (const f of WORKSPACE_POLICY_FIELDS) {
    const ok = f.ownerOnly
      ? p.role === 'owner'
      : decideWorkspace(p, f.governedBy as ActionKey).allowed;
    out[f.field] = {
      value: (p.policy as Record<string, unknown>)[f.field] ?? null,
      editable: ok && f.field !== 'public_links_enabled',
    };
  }
  return { settings: out };
}

function normalizeAudit(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  return JSON.stringify(v);
}

const LEVEL_ORDER = ['none', 'view', 'comment', 'edit'];

function isLoosening(field: string, before: unknown, after: unknown): boolean {
  if (typeof before === 'boolean' && typeof after === 'boolean') {
    // Every boolean policy enables a capability when true.
    return !before && after;
  }
  if (field === 'workspace_records_default_level')
    return LEVEL_ORDER.indexOf(String(after)) > LEVEL_ORDER.indexOf(String(before));
  if (field === 'self_approval_mode') return after === 'allowed' && before !== 'allowed';
  if (field === 'share_max_expiry' || field === 'token_max_lifetime')
    return before !== null && after === null;
  return false;
}

function parsePolicyValue(field: string, v: unknown, issues: Issues): unknown {
  const ptr = `/changes/${field}/value`;
  const def = POLICY_FIELDS.get(field)!;
  if (typeof def.default === 'boolean') {
    if (typeof v !== 'boolean') return issues.add(ptr, 'invalid_type', 'Choose on or off.');
    return v;
  }
  if (field === 'workspace_records_default_level') {
    if (!['none', 'view', 'comment', 'edit'].includes(String(v)))
      return issues.add(ptr, 'invalid_option', 'Choose a level.');
    return v;
  }
  if (field === 'self_approval_mode') {
    if (!['auto', 'allowed', 'forbidden'].includes(String(v)))
      return issues.add(ptr, 'invalid_option', 'Choose a mode.');
    return v;
  }
  if (field === 'share_max_expiry' || field === 'token_max_lifetime') {
    if (v === null) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 3650)
      return issues.add(ptr, 'invalid_duration', 'Use a number of days from 1 to 3650.');
    return `${v} days`;
  }
  if (
    Array.isArray(v) &&
    v.length <= 64 &&
    v.every((x) => typeof x === 'string' && /^[a-z_.0-9]{1,64}$/.test(x))
  )
    return v;
  return issues.add(ptr, 'invalid_type', 'Choose valid values.');
}

export function parseChange(raw: unknown): ProposedChange {
  const issues = new Issues();
  const b = isObject(raw) ? raw : {};
  const kind = b.kind;
  const str = (k: string, prefix: string) => {
    const v = b[k];
    if (typeof v !== 'string' || !PUBLIC(prefix).test(v))
      issues.add(`/change/${k}`, 'invalid_reference', 'Choose an item from the list.');
    return v as string;
  };
  let out: ProposedChange | undefined;
  switch (kind) {
    case 'role': {
      const member = str('member', 'mem');
      if (!(MEMBER_ROLES as readonly unknown[]).includes(b.role))
        issues.add('/change/role', 'invalid_option', 'Choose a role.');
      out = { kind, member, role: b.role as MemberRole };
      break;
    }
    case 'suspend':
    case 'remove':
      out = { kind, member: str('member', 'mem') };
      break;
    case 'brand_grant':
    case 'brand_revoke': {
      const brand = str('brand', 'br');
      const principal = b.principal;
      if (
        typeof principal !== 'string' ||
        !(PUBLIC('mem').test(principal) || PUBLIC('team').test(principal))
      )
        issues.add('/change/principal', 'invalid_reference', 'Choose a person or team.');
      if (kind === 'brand_grant') {
        if (!(LEVELS as readonly unknown[]).includes(b.level))
          issues.add('/change/level', 'invalid_option', 'Choose a level.');
        const exp = b.expires_at ?? null;
        if (
          exp !== null &&
          (typeof exp !== 'string' ||
            Number.isNaN(Date.parse(exp)) ||
            Date.parse(exp) <= Date.now())
        )
          issues.add('/change/expires_at', 'invalid_date', 'Choose a future date.');
        out = {
          kind,
          brand,
          principal: principal as string,
          level: b.level as Level,
          expires_at: exp as string | null,
        };
      } else out = { kind, brand, principal: principal as string };
      break;
    }
    case 'team_add':
    case 'team_remove':
      out = { kind, team: str('team', 'team'), member: str('member', 'mem') };
      break;
    case 'project_grant':
    case 'project_revoke': {
      const project = str('project', 'prj');
      const principal = b.principal;
      if (
        typeof principal !== 'string' ||
        !(PUBLIC('mem').test(principal) || PUBLIC('team').test(principal))
      )
        issues.add('/change/principal', 'invalid_reference', 'Choose a person or team.');
      if (kind === 'project_grant') {
        if (!(LEVELS as readonly unknown[]).includes(b.level))
          issues.add('/change/level', 'invalid_option', 'Choose a level.');
        out = { kind, project, principal: principal as string, level: b.level as Level };
      } else out = { kind, project, principal: principal as string };
      break;
    }
    case 'record_share': {
      const record = b.record;
      if (typeof record !== 'string' || !/^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/.test(record))
        issues.add('/change/record', 'invalid_reference', 'Choose an item to share.');
      const grantee = b.grantee;
      if (
        typeof grantee !== 'string' ||
        !(PUBLIC('mem').test(grantee) || PUBLIC('team').test(grantee))
      )
        issues.add('/change/grantee', 'invalid_reference', 'Choose a person or team.');
      // The API's `view` is the stored `read` level (0C AZ-21); no fourth level exists.
      const raw = b.level ?? 'view';
      const level = raw === 'view' ? 'read' : raw;
      if (!['read', 'comment', 'edit'].includes(level as string))
        issues.add('/change/level', 'invalid_option', 'Choose view, comment, or edit.');
      const exp = b.expires_at ?? null;
      if (
        exp !== null &&
        (typeof exp !== 'string' || Number.isNaN(Date.parse(exp)) || Date.parse(exp) <= Date.now())
      )
        issues.add('/change/expires_at', 'invalid_date', 'Choose a future date.');
      out = {
        kind,
        record: record as string,
        grantee: grantee as string,
        level: level as ShareLevel,
        expires_at: exp as string | null,
      };
      break;
    }
    default:
      issues.add('/change/kind', 'invalid_option', 'Choose a change.');
  }
  issues.throwIfAny();
  return out!;
}

function parseInvitation(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['email', 'kind', 'role', 'brands', 'records', 'locale'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  let email: { display: string; key: string } = { display: '', key: '' };
  try {
    email = normalizeEmail(b.email);
  } catch (err) {
    if (err instanceof EmailFormatError)
      issues.add('/email', 'invalid_email', 'Enter an email address like name@example.com.');
    else throw err;
  }
  const kind = b.kind === 'guest' ? 'guest' : b.kind === 'member' ? 'member' : null;
  if (!kind) issues.add('/kind', 'invalid_option', 'Choose member or guest.');
  const role = b.role;
  if (kind === 'member' && !(MEMBER_ROLES as readonly unknown[]).includes(role))
    issues.add('/role', 'invalid_option', 'Choose a role.');
  if (kind === 'guest' && role !== undefined && role !== null)
    issues.add('/role', 'unsupported_field', 'Guests have no workspace role.');
  const brands: Array<{ brand: string; level: Level }> = [];
  if (b.brands !== undefined) {
    if (kind === 'guest')
      issues.add(
        '/brands',
        'unsupported_field',
        'Guests never receive brand access. Share specific items instead.',
      );
    else if (!Array.isArray(b.brands) || b.brands.length > 50)
      issues.add('/brands', 'invalid_type', 'Choose up to 50 brands.');
    else
      b.brands.forEach((g: unknown, i: number) => {
        const o = isObject(g) ? g : {};
        if (typeof o.brand !== 'string' || !PUBLIC('br').test(o.brand))
          issues.add(`/brands/${i}/brand`, 'invalid_reference', 'Choose a brand.');
        if (!(LEVELS as readonly unknown[]).includes(o.level))
          issues.add(`/brands/${i}/level`, 'invalid_option', 'Choose a level.');
        brands.push({ brand: o.brand as string, level: o.level as Level });
      });
  }
  const records: Array<{ record: string; level: ShareLevel }> = [];
  if (kind === 'guest') {
    if (!Array.isArray(b.records) || b.records.length < 1 || b.records.length > 50)
      issues.add(
        '/records',
        'records_required',
        'Guests need at least one specific item to be shared with them.',
      );
    else
      b.records.forEach((r: unknown, i: number) => {
        const o = isObject(r) ? r : {};
        if (typeof o.record !== 'string' || !/^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/.test(o.record))
          issues.add(`/records/${i}/record`, 'invalid_reference', 'Choose an item.');
        const level = o.level ?? 'read';
        if (!(SHARE_LEVELS as readonly unknown[]).includes(level))
          issues.add(`/records/${i}/level`, 'invalid_option', 'Choose read, comment, or edit.');
        records.push({ record: o.record as string, level: level as ShareLevel });
      });
  } else if (b.records !== undefined)
    issues.add(
      '/records',
      'unsupported_field',
      'Members get access through roles and brand access.',
    );
  const locale =
    typeof b.locale === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(b.locale)
      ? b.locale
      : 'en';
  issues.throwIfAny();
  return {
    email,
    kind: kind as 'member' | 'guest',
    role: role as MemberRole | undefined,
    brands,
    records,
    locale,
  };
}

function parseShare(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['record', 'children', 'grantee', 'level', 'expires_at'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  if (typeof b.record !== 'string') issues.add('/record', 'required', 'Choose an item to share.');
  const children = Array.isArray(b.children) ? b.children : [];
  if (
    b.children !== undefined &&
    (!Array.isArray(b.children) ||
      b.children.length > 100 ||
      b.children.some((c) => typeof c !== 'string'))
  )
    issues.add('/children', 'invalid_type', 'Choose up to 100 contained items.');
  if (
    typeof b.grantee !== 'string' ||
    !(
      PUBLIC('mem').test(b.grantee) ||
      PUBLIC('team').test(b.grantee) ||
      PUBLIC('br').test(b.grantee)
    )
  )
    issues.add('/grantee', 'invalid_reference', 'Choose a person, team, or brand.');
  const level = b.level ?? 'read';
  if (!(SHARE_LEVELS as readonly unknown[]).includes(level))
    issues.add('/level', 'invalid_option', 'Choose read, comment, or edit.');
  let expires: Date | null = null;
  if (b.expires_at !== undefined && b.expires_at !== null) {
    if (
      typeof b.expires_at !== 'string' ||
      Number.isNaN(Date.parse(b.expires_at)) ||
      Date.parse(b.expires_at) <= Date.now()
    )
      issues.add('/expires_at', 'invalid_date', 'Choose a future date.');
    else expires = new Date(b.expires_at);
  }
  issues.throwIfAny();
  return {
    record: b.record as string,
    children: children as string[],
    grantee: b.grantee as string,
    level: level as ShareLevel,
    expires_at: expires,
  };
}

export { shareToLevel, roleCap, WORKSPACE_ROLES, type Result, type ExposureDiff };
