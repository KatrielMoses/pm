import { sql, type PlatformTransaction, type WorkspaceTransaction } from '@pm/db';
import type { Metrics } from '@pm/observability';
import { TenancyError } from './errors.ts';
import {
  DEFAULT_POLICY,
  LEVELS,
  WORKSPACE_ROLES,
  type GrantSource,
  type Level,
  type Principal,
  type WorkspacePolicyValues,
  type WorkspaceRole,
} from './policy.ts';

/**
 * Trusted principal resolution (0C §12). The workspace comes from the URL path; the account comes
 * from the authenticated session. Request bodies, query strings, and headers never name a
 * workspace, membership, role, or brand list that the server trusts.
 */

const PUBLIC_ID = /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/;

export interface DirectoryEntry {
  workspaceId: string;
  workspacePublicId: string;
  name: string;
  membershipId: string;
}

/** The account's own active memberships (definer function; platform scope only). */
export async function accountWorkspaces(
  tx: PlatformTransaction,
  accountId: string,
): Promise<DirectoryEntry[]> {
  const res = await sql<{
    workspace_id: string;
    workspace_public_id: string;
    name: string;
    membership_id: string;
  }>`SELECT workspace_id, workspace_public_id, name, membership_id
       FROM tenancy.account_workspaces(${accountId}::uuid)`.execute(tx.db);
  return res.rows.map((r) => ({
    workspaceId: r.workspace_id,
    workspacePublicId: r.workspace_public_id,
    name: r.name,
    membershipId: r.membership_id,
  }));
}

/** The public ID of the account's most recently selected workspace, if any. */
export async function accountSelectedWorkspace(
  tx: PlatformTransaction,
  accountId: string,
): Promise<string | null> {
  const res = await sql<{ workspace_public_id: string }>`
    SELECT workspace_public_id FROM tenancy.account_selected_workspace(${accountId}::uuid)`.execute(
    tx.db,
  );
  return res.rows[0]?.workspace_public_id ?? null;
}

/**
 * Path workspace → (workspace, membership) for this account. Malformed, unknown, and
 * not-a-member all give the same `not_found` (no existence oracle).
 */
export async function resolveMembership(
  tx: PlatformTransaction,
  accountId: string,
  workspacePublicId: unknown,
): Promise<{ workspaceId: string; membershipId: string }> {
  if (typeof workspacePublicId !== 'string' || !PUBLIC_ID.test(workspacePublicId))
    throw new TenancyError('not_found');
  const res = await sql<{ workspace_id: string; membership_id: string }>`
    SELECT workspace_id, membership_id
      FROM tenancy.resolve_membership(${accountId}::uuid, ${workspacePublicId})`.execute(tx.db);
  const row = res.rows[0];
  if (!row) throw new TenancyError('not_found');
  return { workspaceId: row.workspace_id, membershipId: row.membership_id };
}

/**
 * Loads the canonical principal inside the workspace transaction (RLS context set): the active
 * membership, its workspace role, its unexpired brand grants, and the permission epochs. Re-checks
 * membership state and account binding here, so a membership removed between the directory lookup
 * and this transaction is refused.
 */
export async function loadPrincipal(
  tx: WorkspaceTransaction,
  accountId: string,
  membershipId: string,
): Promise<Principal & { workspaceState: string }> {
  const m = await tx.db
    .selectFrom('tenancy.membership as m')
    .innerJoin('tenancy.workspace as w', 'w.id', 'm.workspace_id')
    .select(['m.id', 'm.kind', 'w.state as workspace_state'])
    .where('m.id', '=', membershipId)
    .where('m.account_id', '=', accountId)
    .where('m.state', '=', 'active')
    .executeTakeFirst();
  if (!m) throw new TenancyError('not_found');
  return {
    ...(await compilePrincipal(tx, membershipId, accountId, m.kind)),
    workspaceState: m.workspace_state,
  };
}

/**
 * Compiles any membership's principal (the caller's, or a preview target's) from canonical rows:
 * workspace role, unexpired brand grants held directly or through active teams, active team
 * memberships, the workspace policy (defaults when no row exists), and the epochs. Guests never
 * hold assignments or teams (database role-shape check), so their grants and teams are empty.
 */
export async function compilePrincipal(
  tx: WorkspaceTransaction,
  membershipId: string,
  accountId: string,
  kind: 'member' | 'guest',
): Promise<Principal> {
  const now = new Date();
  const teams =
    kind === 'guest'
      ? []
      : (
          await tx.db
            .selectFrom('tenancy.team_member as tm')
            .innerJoin('tenancy.team as t', (j) =>
              j.onRef('t.workspace_id', '=', 'tm.workspace_id').onRef('t.id', '=', 'tm.team_id'),
            )
            .select('t.id')
            .where('tm.membership_id', '=', membershipId)
            .where('t.lifecycle_state', '=', 'active')
            .orderBy('t.id')
            .execute()
        ).map((t) => t.id);
  const assignments = await tx.db
    .selectFrom('access.role_assignment as a')
    .innerJoin('access.role as r', (j) =>
      j.onRef('r.workspace_id', '=', 'a.workspace_id').onRef('r.id', '=', 'a.role_id'),
    )
    .select([
      'a.scope_type',
      'a.brand_scope_id',
      'a.team_principal_id',
      'a.expires_at',
      'r.key',
      'r.level',
    ])
    .where((eb) =>
      eb.or([
        eb('a.membership_principal_id', '=', membershipId),
        ...(teams.length ? [eb('a.team_principal_id', 'in', teams)] : []),
      ]),
    )
    .where((eb) => eb.or([eb('a.expires_at', 'is', null), eb('a.expires_at', '>', now)]))
    .execute();
  let role: WorkspaceRole | null = null;
  const grants = new Map<string, Level>();
  const grantSources: GrantSource[] = [];
  for (const a of assignments) {
    if (a.scope_type === 'workspace' && !a.team_principal_id) {
      if ((WORKSPACE_ROLES as readonly string[]).includes(a.key)) role = a.key as WorkspaceRole;
    } else if (a.scope_type === 'brand' && a.brand_scope_id && a.level) {
      const level = a.level as Level;
      if (!(LEVELS as readonly string[]).includes(level)) continue;
      grantSources.push({
        brandId: a.brand_scope_id,
        level,
        via: a.team_principal_id ? 'team' : 'direct',
        teamId: a.team_principal_id,
        expiresAt: a.expires_at ? new Date(a.expires_at) : null,
      });
      const prev = grants.get(a.brand_scope_id);
      if (!prev || LEVELS.indexOf(level) > LEVELS.indexOf(prev))
        grants.set(a.brand_scope_id, level);
    }
  }
  if (kind === 'guest') {
    role = 'guest';
    grants.clear();
    grantSources.length = 0;
  }
  const policyRow = await tx.db
    .selectFrom('access.workspace_policy')
    .selectAll()
    .where('workspace_id', '=', tx.workspaceId)
    .executeTakeFirst();
  const policy = { ...DEFAULT_POLICY } as WorkspacePolicyValues;
  if (policyRow)
    for (const k of Object.keys(DEFAULT_POLICY))
      (policy as Record<string, unknown>)[k] = (policyRow as Record<string, unknown>)[k];
  const epochs = await tx.db
    .selectFrom('access.permission_epoch')
    .select(['epoch_kind', 'epoch'])
    .where((eb) =>
      eb.or([
        eb('epoch_kind', '=', 'workspace'),
        eb.and([eb('epoch_kind', '=', 'principal'), eb('subject_id', '=', membershipId)]),
      ]),
    )
    .execute();
  return {
    workspaceId: tx.workspaceId,
    membershipId,
    accountId,
    kind,
    role,
    grants,
    grantSources,
    teams,
    policy,
    epochs: {
      workspace: Number(epochs.find((e) => e.epoch_kind === 'workspace')?.epoch ?? 0),
      principal: Number(epochs.find((e) => e.epoch_kind === 'principal')?.epoch ?? 0),
    },
  };
}

/** Bumps a permission epoch (0C §13.5): cached decisions and queued work re-evaluate. */
export async function bumpEpoch(
  tx: WorkspaceTransaction,
  kind: 'workspace' | 'principal',
  subjectId: string | null,
): Promise<void> {
  await tx.db
    .insertInto('access.permission_epoch')
    .values({
      workspace_id: tx.workspaceId,
      epoch_kind: kind,
      subject_id: kind === 'workspace' ? null : subjectId,
      epoch: 1,
    })
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'epoch_kind', 'subject_id']).doUpdateSet({
        epoch: sql`access.permission_epoch.epoch + 1`,
        bumped_at: sql`now()`,
      }),
    )
    .execute();
}

/**
 * Re-checks a deferred consumer's principal at execution time (0C §13.3, §13.5): jobs, streams,
 * and later agent steps carry the epochs they were authorized under. `revoked` (membership no
 * longer active) means stop; `changed` (an epoch advanced) means rebuild the context before
 * acting. Counted as `tenancy.epoch_stale{consumer}` with a bounded consumer label.
 */
export async function principalFreshness(
  tx: WorkspaceTransaction,
  metrics: Metrics,
  input: {
    membershipId: string;
    workspaceEpochAtEnqueue: number;
    principalEpochAtEnqueue: number;
    consumer: 'job' | 'stream' | 'agent_step';
  },
): Promise<'current' | 'changed' | 'revoked'> {
  const m = await tx.db
    .selectFrom('tenancy.membership')
    .select('state')
    .where('id', '=', input.membershipId)
    .executeTakeFirst();
  if (!m || m.state !== 'active') {
    metrics.count('tenancy.epoch_stale', 1, { consumer: input.consumer });
    return 'revoked';
  }
  const epochs = await tx.db
    .selectFrom('access.permission_epoch')
    .select(['epoch_kind', 'epoch'])
    .where((eb) =>
      eb.or([
        eb('epoch_kind', '=', 'workspace'),
        eb.and([eb('epoch_kind', '=', 'principal'), eb('subject_id', '=', input.membershipId)]),
      ]),
    )
    .execute();
  const ws = Number(epochs.find((e) => e.epoch_kind === 'workspace')?.epoch ?? 0);
  const pr = Number(epochs.find((e) => e.epoch_kind === 'principal')?.epoch ?? 0);
  if (ws > input.workspaceEpochAtEnqueue || pr > input.principalEpochAtEnqueue) {
    metrics.count('tenancy.epoch_stale', 1, { consumer: input.consumer });
    return 'changed';
  }
  return 'current';
}
