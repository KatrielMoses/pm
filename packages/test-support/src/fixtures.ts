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
