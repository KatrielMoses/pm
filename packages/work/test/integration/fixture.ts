import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { AuditSecurityEventSink, AuditWriter } from '@pm/audit';
import {
  createIdentityService,
  createVault,
  NoopRateLimiter,
  PostgresRateLimiter,
} from '@pm/identity';
import { LifecycleService, RetentionPolicy } from '@pm/lifecycle';
import {
  DEFAULT_VIEWS_SETTINGS,
  defaultNavigationTargets,
  defaultOwnershipRegistry,
  tenancyBrandPort,
  type Caller,
  type CollaborationIdentityPort,
} from '@pm/tenancy';
import { createHarness, type Harness } from '@pm/test-support';
import type { TestDatabase } from '@pm/test-support/vitest';
import {
  DEFAULT_WORK_SETTINGS,
  productLifecycleRegistry,
  projectOwnerHook,
  projectTargets,
  taskAssigneeHook,
  taskTargets,
  savedViewTargets,
  ReportService,
  type SearchSourceRegistry,
  documentOwnerHook,
  goalOwnerHook,
  insightsOwnerHook,
  LocalObjectStorage,
  SignatureTestScanner,
  type FileDeps,
  reviewDepartureHook,
  departureTimerHook,
  type WorkSettings,
} from '@pm/work';
import {
  mutation,
  seedAccount,
  StubStepUp,
  WORKSPACE_INPUT,
} from '../../../tenancy/test/integration/fixture.ts';

export {
  membershipOf,
  mutation,
  seedAccount,
  seedRecord,
  workspaceIdOf,
  WORKSPACE_INPUT,
} from '../../../tenancy/test/integration/fixture.ts';

export interface WorkEnv {
  h: Harness;
  svc: ReportService;
  /** The test storage and scanner the service uses (null when a test disables them). */
  files: FileDeps;
  stepUp: StubStepUp;
  lifecycle: LifecycleService;
  tokenFor(email: string): Promise<string>;
}

/** The full 1C–2A service exactly as the factory wires it (work adapters, targets, hook). */
export function workEnv(
  db: TestDatabase,
  options: {
    arrayMax?: number;
    work?: Partial<WorkSettings>;
    captureRate?: number;
    intakeRate?: number;
    commentRate?: number;
    documentRate?: number;
    liveRate?: number;
    searchRate?: number;
    /** 5A: the registered search sources (default: the 5A registrations). */
    searchSources?: SearchSourceRegistry;
    goalRate?: number;
    emailState?: 'configured' | 'capture' | 'unconfigured';
    /** 4E: defaults to local storage in a temp directory and the signature scanner. */
    files?: Partial<FileDeps>;
  } = {},
): WorkEnv {
  const h = createHarness(db);
  const metrics = h.telemetry.metrics;
  const stepUp = new StubStepUp();
  const { service: identity } = createIdentityService({
    db: h.platform,
    config: h.config.identity,
    appName: 'PM',
    logger: h.logger,
    metrics,
    limiter: new NoopRateLimiter(),
  });
  const writer = new AuditWriter({ module: 'tenancy', logger: h.logger, metrics });
  const lifecycle = new LifecycleService({
    registry: productLifecycleRegistry(),
    writer,
    retention: new RetentionPolicy(h.config.lifecycle),
    brands: tenancyBrandPort,
    metrics,
    logger: h.logger,
  });
  const port: CollaborationIdentityPort = {
    issueInvitationToken: identity.issueInvitationToken.bind(identity),
    revokeInvitationToken: identity.revokeInvitationToken.bind(identity),
    lookupInvitationToken: identity.lookupInvitationToken.bind(identity),
    consumeInvitationToken: identity.consumeInvitationToken.bind(identity),
    revokeSessionsForDeparture: identity.revokeSessionsForDeparture.bind(identity),
    consumeWorkspaceStepUp: stepUp.consumeWorkspaceStepUp,
    createStepUpChallenge: stepUp.createStepUpChallenge,
  };
  const arrayMax = options.arrayMax ?? 10_000;
  const files: FileDeps = {
    storage:
      options.files?.storage !== undefined
        ? options.files.storage
        : new LocalObjectStorage({
            dir: mkdtempSync(pathJoin(tmpdir(), 'pm-files-')),
            secret: randomBytes(32).toString('base64url'),
            publicBaseUrl: 'http://127.0.0.1:1',
          }),
    scanner:
      options.files?.scanner !== undefined ? options.files.scanner : new SignatureTestScanner(),
  };
  const svc = new ReportService({
    files,
    ...(options.searchSources ? { search: { sources: options.searchSources } } : {}),
    notify: { emailState: options.emailState ?? 'capture' },
    tenant: h.app,
    platform: h.platform,
    writer,
    security: new AuditSecurityEventSink(metrics),
    lifecycle,
    stepUp: port,
    identity: port,
    ownership: defaultOwnershipRegistry()
      .register(projectOwnerHook)
      .register(taskAssigneeHook)
      .register(documentOwnerHook)
      .register(goalOwnerHook)
      .register(insightsOwnerHook)
      .register(reviewDepartureHook(writer))
      .register(departureTimerHook(writer)),
    limiter: new PostgresRateLimiter(h.platform, randomBytes(32), {
      'workspace.create': { limit: 1000, windowMs: 3_600_000 },
      'invitation.accept': { limit: 1000, windowMs: 3_600_000 },
      'invitation.send': { limit: 1000, windowMs: 3_600_000 },
      'capture.member': { limit: options.captureRate ?? 10_000, windowMs: 60_000 },
      'intake.submit': { limit: options.intakeRate ?? 10_000, windowMs: 3_600_000 },
      'comment.member': { limit: options.commentRate ?? 10_000, windowMs: 60_000 },
      'document.save': { limit: options.documentRate ?? 10_000, windowMs: 60_000 },
      'document.live': { limit: options.liveRate ?? 100_000, windowMs: 60_000 },
      'search.member': { limit: options.searchRate ?? 100_000, windowMs: 60_000 },
      'goal.checkin': { limit: options.goalRate ?? 100_000, windowMs: 60_000 },
      'report.export': { limit: 100_000, windowMs: 60_000 },
    }),
    signingKey: randomBytes(32),
    settings: {
      invitationLifetimeMs: 3_600_000,
      ownershipTransferLifetimeMs: 3_600_000,
      principalContextArrayMax: arrayMax,
      previewTtlMs: 600_000,
    },
    views: DEFAULT_VIEWS_SETTINGS,
    targets: defaultNavigationTargets()
      .register(projectTargets(arrayMax))
      .register(taskTargets(arrayMax))
      .register(savedViewTargets(arrayMax)),
    work: { ...DEFAULT_WORK_SETTINGS, ...options.work },
    metrics,
    logger: h.logger,
  });
  const vault = createVault(h.config.identity);
  return {
    h,
    svc,
    files,
    stepUp,
    lifecycle,
    async tokenFor(email: string) {
      return h.platformWorker.withPlatform({ module: 'test', readOnly: true }, async (tx) => {
        const row = await tx.db
          .selectFrom('identity.mail_delivery')
          .select('sealed_ref')
          .where('recipient', '=', email)
          .where('template', '=', 'workspace_invitation')
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirstOrThrow();
        const token = await vault.get(row.sealed_ref!, { scope: tx });
        if (!token) throw new Error('no sealed invitation token');
        return token;
      });
    },
  };
}

/** Workspace with an owner and named brands (owner holds implicit manage on non-sensitive brands). */
export async function workspaceWith(env: WorkEnv, db: TestDatabase, brands: string[]) {
  const owner = await seedAccount(db);
  const created = await env.svc.createWorkspace(
    owner,
    { ...WORKSPACE_INPUT, name: 'Projects Co', first_brand: { name: brands[0]! } },
    mutation(),
  );
  const ws = created.data.workspace.id;
  const brandIds: Record<string, string> = { [brands[0]!]: created.data.first_brand!.id };
  for (const b of brands.slice(1))
    brandIds[b] = (await env.svc.createBrand(owner, ws, { name: b }, mutation())).data.id;
  return { owner, ws, brands: brandIds };
}

/** Invites and accepts a member with a workspace role (or a guest with record shares). */
export async function join(
  env: WorkEnv,
  db: TestDatabase,
  owner: Caller,
  ws: string,
  body: Record<string, unknown>,
): Promise<Caller> {
  const who = await seedAccount(db);
  await env.svc.invite(owner, ws, { email: who.auth.account.email, ...body }, mutation());
  await env.svc.acceptInvitation(
    who,
    { token: await env.tokenFor(who.auth.account.email) },
    mutation(),
  );
  return who;
}

/** Applies a reviewed change (preview, then apply with the fingerprint and a step-up). */
export async function apply(env: WorkEnv, as: Caller, ws: string, change: Record<string, unknown>) {
  const preview = await env.svc.previewChange(as, ws, change);
  env.stepUp.allow = true;
  try {
    return {
      preview,
      result: await env.svc.applyChange(
        as,
        ws,
        { change, preview_token: preview.preview_token },
        mutation({ stepUpToken: 't' }),
      ),
    };
  } finally {
    env.stepUp.allow = false;
  }
}

/** A field-merge request with the version the client loaded. */
export function merge(version: number, changes: Record<string, { base: unknown; value: unknown }>) {
  return { version, changes };
}
