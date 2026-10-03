import { createHash, randomBytes } from 'node:crypto';
import { AuditSecurityEventSink, AuditWriter } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { PostgresRateLimiter, type AuthContext, type StepUpChallengeView } from '@pm/identity';
import {
  LifecycleRegistry,
  LifecycleService,
  RetentionPolicy,
  type RecordTypeAdapter,
} from '@pm/lifecycle';
import {
  registerTenancyLifecycle,
  tenancyBrandPort,
  TenancyService,
  type Caller,
  type Mutation,
  type StepUpPort,
} from '@pm/tenancy';
import { createHarness, type Harness } from '@pm/test-support';
import type { TestDatabase } from '@pm/test-support/vitest';

/** Controllable step-up port: tests decide whether a presented token is valid. */
export class StubStepUp implements StepUpPort {
  allow = false;
  consumed: Array<{ actionKey: string; target?: unknown; membershipId: string }> = [];
  challenges: Array<{ actionKey: string; workspaceId?: string; membershipId?: string }> = [];

  consumeWorkspaceStepUp: StepUpPort['consumeWorkspaceStepUp'] = async (
    _tx,
    _ctx,
    binding,
    req,
  ) => {
    if (!this.allow || !req.stepUpToken) return null;
    this.consumed.push(binding);
    return newUuidV7();
  };

  createStepUpChallenge: StepUpPort['createStepUpChallenge'] = async (_ctx, request) => {
    this.challenges.push(request);
    return {
      id: newPublicId('stp'),
      type: 'step_up_challenge',
      action_key: request.actionKey,
      methods: ['password'],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      state: 'pending',
    } as unknown as StepUpChallengeView;
  };
}

export interface TenancyEnv {
  h: Harness;
  svc: TenancyService;
  stepUp: StubStepUp;
  registry: LifecycleRegistry;
  lifecycle: LifecycleService;
}

export function tenancyEnv(
  db: TestDatabase,
  extra: RecordTypeAdapter[] = [],
  limits: Record<string, { limit: number; windowMs: number }> = {
    'workspace.create': { limit: 1000, windowMs: 3_600_000 },
  },
): TenancyEnv {
  const h = createHarness(db);
  const metrics = h.telemetry.metrics;
  const registry = registerTenancyLifecycle(new LifecycleRegistry());
  for (const a of extra) registry.register(a);
  const writer = new AuditWriter({ module: 'tenancy', logger: h.logger, metrics });
  const lifecycle = new LifecycleService({
    registry,
    writer,
    retention: new RetentionPolicy(h.config.lifecycle),
    brands: tenancyBrandPort,
    metrics,
    logger: h.logger,
  });
  const stepUp = new StubStepUp();
  const svc = new TenancyService({
    tenant: h.app,
    platform: h.platform,
    writer,
    security: new AuditSecurityEventSink(metrics),
    lifecycle,
    stepUp,
    limiter: new PostgresRateLimiter(h.platform, randomBytes(32), limits),
    signingKey: randomBytes(32),
    metrics,
    logger: h.logger,
  });
  return { h, svc, stepUp, registry, lifecycle };
}

/** A synthetic account and session (no real names or emails). */
export async function seedAccount(
  db: TestDatabase,
  options: { verified?: boolean } = {},
): Promise<Caller> {
  const id = newUuidV7();
  const sessionId = newUuidV7();
  const publicId = newPublicId('acct');
  const email = `${publicId.toLowerCase()}@example.test`;
  await db.admin(
    `INSERT INTO identity.account (id, public_id, primary_email, email_key, display_name, timezone, locale,
       terms_version, privacy_version, legal_acknowledged_at, email_verified_at)
     VALUES ($1, $2, $3, $3, 'Synthetic Person', 'UTC', 'en', 't1', 'p1', now(), $4)`,
    [id, publicId, email, options.verified === false ? null : new Date()],
  );
  const auth: AuthContext = {
    principal: 'account',
    account: {
      id,
      publicId,
      email,
      displayName: 'Synthetic Person',
      locale: 'en',
      timezone: 'UTC',
      emailVerified: options.verified !== false,
    },
    session: {
      id: sessionId,
      publicId: newPublicId('ses'),
      assurance: 'single_factor',
      authMethods: ['password'],
      createdAt: new Date(),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
      mfaVerifiedAt: null,
    },
  };
  return { auth, meta: { correlationId: randomBytes(16).toString('hex'), requestId: 'req_test' } };
}

/** A fresh Idempotency-Key and fingerprint (the API derives the fingerprint from the request). */
export function mutation(overrides: Partial<Mutation> & { body?: unknown } = {}): Mutation {
  const { body, ...rest } = overrides;
  return {
    idempotencyKey: `k_${randomBytes(12).toString('hex')}`,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(body ?? randomBytes(8).toString('hex')))
      .digest(),
    ...rest,
  };
}

export const WORKSPACE_INPUT = {
  name: 'Synthetic Studio',
  timezone: 'Europe/Berlin',
  locale: 'en-GB',
  currency: 'EUR',
  week_start: 1,
};

/** Adds a second active owner to a workspace with admin SQL (1C exposes no membership routes). */
export async function seedSecondOwner(
  db: TestDatabase,
  workspaceId: string,
): Promise<{ caller: Caller; membershipId: string }> {
  const caller = await seedAccount(db);
  const membershipId = newUuidV7();
  await db.admin(
    `INSERT INTO tenancy.membership (id, public_id, workspace_id, account_id, kind, state, joined_at)
     VALUES ($1, $2, $3, $4, 'member', 'active', now());
     `.trim(),
    [membershipId, newPublicId('mem'), workspaceId, caller.auth.account.id],
  );
  await db.admin(
    `INSERT INTO access.role_assignment (id, workspace_id, principal_type, principal_id, scope_type, scope_id,
       role_id, role_kind, grant_source)
     SELECT $1, $2, 'membership', $3, 'workspace', $2, r.id, 'workspace_role', 'assigned'
       FROM access.role r WHERE r.workspace_id = $2 AND r.key = 'owner'`,
    [newUuidV7(), workspaceId, membershipId],
  );
  return { caller, membershipId };
}

export async function workspaceIdOf(db: TestDatabase, publicId: string): Promise<string> {
  return (await db.admin(`SELECT id FROM tenancy.workspace WHERE public_id = $1`, [publicId]))
    .rows[0].id as string;
}
