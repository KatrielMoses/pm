import {
  newPublicId,
  newTraceId,
  newUuidV7,
  type ExecutionContext,
  type PrincipalRef,
  type PrincipalType,
} from '@pm/contracts';
import type { TenantDatabase } from '@pm/db';

// Synthetic fixtures only: no real names, emails, or customer content (brief §9, §7).

export interface SyntheticWorkspace {
  id: string;
  publicId: string;
  name: string;
}

export function syntheticPrincipal(type: PrincipalType = 'member'): PrincipalRef {
  return { type, id: newUuidV7() };
}

export async function createWorkspace(
  db: TenantDatabase,
  name: string,
): Promise<SyntheticWorkspace> {
  const id = newUuidV7();
  const publicId = newPublicId('ws');
  await db.withWorkspace(id, { module: 'tenancy', creatingWorkspace: true }, (tx) =>
    tx.db
      .insertInto('tenancy.workspace')
      .values({
        id,
        public_id: publicId,
        name,
        timezone: 'UTC',
        locale: 'en',
        currency: 'USD',
        week_start: 1,
        created_by_actor_type: 'system',
        updated_by_actor_type: 'system',
      })
      .execute(),
  );
  return { id, publicId, name };
}

export function executionContext(
  workspaceId: string,
  principal: PrincipalRef,
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  return {
    workspaceId,
    correlationId: newTraceId(),
    authenticatedPrincipal: principal,
    effectivePrincipal: principal,
    delegationChain: [{ type: principal.type, id: principal.id }],
    epochs: { workspace: 0, principal: 0 },
    dataClassLimit: 'C2',
    locale: 'en',
    timezone: 'UTC',
    ...overrides,
  };
}

export interface TenantFixture {
  alpha: SyntheticWorkspace;
  beta: SyntheticWorkspace;
  principals: {
    alphaMember: PrincipalRef;
    alphaSecondMember: PrincipalRef;
    alphaGuest: PrincipalRef;
    betaMember: PrincipalRef;
    systemJob: PrincipalRef;
  };
}

/** Two isolated workspaces and several principals (0C §12.7 foundation fixtures). */
export async function seedTwoWorkspaces(db: TenantDatabase): Promise<TenantFixture> {
  const alpha = await createWorkspace(db, 'Synthetic Workspace Alpha');
  const beta = await createWorkspace(db, 'Synthetic Workspace Beta');
  return {
    alpha,
    beta,
    principals: {
      alphaMember: syntheticPrincipal('member'),
      alphaSecondMember: syntheticPrincipal('member'),
      alphaGuest: syntheticPrincipal('guest'),
      betaMember: syntheticPrincipal('member'),
      systemJob: syntheticPrincipal('system_job'),
    },
  };
}

type AdminQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface SyntheticBrand {
  id: string;
  publicId: string;
  membershipId: string;
}

/**
 * Seeds a brand directly with admin SQL (envelope, typed row, default settings) plus a synthetic
 * creator account and membership. Bypasses the tenancy services on purpose: lower-layer tests
 * only need a real brand row for the 1C foreign keys.
 */
export async function seedBrand(
  admin: AdminQuery,
  workspaceId: string,
  options: { name?: string; sensitive?: boolean } = {},
): Promise<SyntheticBrand> {
  const account = newUuidV7();
  const membershipId = newUuidV7();
  const id = newUuidV7();
  const publicId = newPublicId('br');
  const email = `${newPublicId('acct').toLowerCase()}@example.test`;
  await admin(
    `INSERT INTO identity.account (id, public_id, primary_email, email_key, display_name, timezone, locale, terms_version, privacy_version, legal_acknowledged_at)
     VALUES ($1, $2, $3, $3, 'Synthetic', 'UTC', 'en', 't1', 'p1', now())`,
    [account, newPublicId('acct'), email],
  );
  await admin(
    `INSERT INTO tenancy.membership (id, public_id, workspace_id, account_id, kind, state, joined_at)
     VALUES ($1, $2, $3, $4, 'member', 'active', now())`,
    [membershipId, newPublicId('mem'), workspaceId, account],
  );
  await admin(
    `BEGIN;
     INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type)
       VALUES ('${id}', '${publicId}', 'brand', '${workspaceId}', '${id}', 'system', 'system');
     INSERT INTO tenancy.brand (id, workspace_id, scope_key, name, color, icon, timezone, is_sensitive, created_by_membership_id)
       VALUES ('${id}', '${workspaceId}', '${id}', '${options.name ?? `Synthetic Brand ${publicId.slice(-6)}`}',
               '#336699', 'circle', 'UTC', ${options.sensitive === true}, '${membershipId}');
     INSERT INTO tenancy.brand_setting (workspace_id, brand_id, working_hours, calendar, priorities)
       VALUES ('${workspaceId}', '${id}', '{"schema_version":1,"days":[]}',
               '{"schema_version":1,"week_start":null,"show_weekends":false,"default_view":"week","label":null}',
               '{"schema_version":1,"entries":[]}');
     COMMIT;`,
  );
  return { id, publicId, membershipId };
}
