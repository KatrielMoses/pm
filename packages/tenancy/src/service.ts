import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import {
  change,
  CommandContext,
  type AuditSecurityEventSink,
  type AuditWriter,
  type CommandSource,
} from '@pm/audit';
import { newPublicId, newUuidV7, type ActionKey, type ExecutionContext } from '@pm/contracts';
import {
  sql,
  TenantContextError,
  type StoredChange,
  type PlatformDatabase,
  type TenantDatabase,
  type WorkspaceTransaction,
} from '@pm/db';
import type {
  AuthContext,
  IdentityService,
  RateLimiter,
  ProtectedRequest,
  RequestMeta,
  StepUpChallengeView,
} from '@pm/identity';
import {
  createRecord,
  LifecycleError,
  PolicyDecisionError,
  type LifecycleService,
} from '@pm/lifecycle';
import { issueLifecycleDecision } from '@pm/lifecycle/policy-issuer';
import type { Logger, Metrics } from '@pm/observability';
import { canonicalJson, completeIdempotencyKey, reserveIdempotencyKey } from '@pm/platform';
import {
  authorizedActiveBrands,
  brandSummary,
  brandView,
  countBrands,
  facts,
  findBrand,
  listBrands,
  loadSettings,
  settingsView,
  type BrandRow,
  type BrandSettingsView,
  type BrandStates,
  type BrandView,
} from './brands.ts';
import { authorizeAccountCommand } from './account-commands.ts';
import { invalid, issue, TenancyError } from './errors.ts';
import {
  decideBrand,
  decideWorkspace,
  workspaceCapabilities,
  type Level,
  type Principal,
} from './policy.ts';
import {
  accountSelectedWorkspace,
  accountWorkspaces,
  bumpEpoch,
  loadPrincipal,
  resolveMembership,
} from './principal.ts';
import {
  BRAND_ICONS,
  calendar as parseCalendar,
  color,
  currency,
  DEFAULT_CALENDAR,
  DEFAULT_PRIORITIES,
  DEFAULT_WORKING_HOURS,
  Issues,
  locale,
  logoRef,
  NOTIFICATION_CONTENT_MODES,
  oneOf,
  OPERATIONAL_STATUSES,
  priorities as parsePriorities,
  text,
  timezone,
  weekday,
  workingHours as parseWorkingHours,
} from './validation.ts';

/** Step-up capabilities borrowed from identity (1B): challenge issue and in-transaction consume. */
export type StepUpPort = Pick<IdentityService, 'consumeWorkspaceStepUp' | 'createStepUpChallenge'>;

export interface TenancyDeps {
  tenant: TenantDatabase;
  platform: PlatformDatabase;
  writer: AuditWriter;
  security: AuditSecurityEventSink;
  lifecycle: LifecycleService;
  stepUp: StepUpPort;
  /** Per-account rate limits for account commands (shared identity limiter, policy `workspace.create`). */
  limiter: RateLimiter;
  /** Key material for opaque list cursors (derived from AUTH_SIGNING_KEY). */
  signingKey: Buffer;
  metrics: Metrics;
  logger: Logger;
}

/** The authenticated person and request metadata (never request-body claims). */
export interface Caller {
  auth: AuthContext;
  meta: RequestMeta;
}

/** Unsafe-request controls taken from headers by the API layer. */
export interface Mutation extends ProtectedRequest {
  /** Raw `If-Match` header value. */
  ifMatch?: string | undefined;
}

export interface Result<T> {
  status: number;
  data: T;
  replayed: boolean;
}

export interface WorkspaceView {
  id: string;
  type: 'workspace';
  name: string;
  logo_file_ref: string | null;
  timezone: string;
  locale: string;
  currency: string;
  week_start: number;
  state: string;
  version: number;
  created_at: string;
  updated_at: string;
  capabilities: { configure: boolean; create_brand: boolean };
}

export type ScopeSelection = { kind: 'brand'; brand_id: string } | { kind: 'all' };

export interface ContextView {
  workspace: { id: string; name: string; capabilities: WorkspaceView['capabilities'] };
  scope:
    { kind: 'brand'; brand_id: string } | { kind: 'all'; brand_ids: string[] } | { kind: 'none' };
  fallback: null | 'no_selection' | 'stale_selection';
  brands: ReturnType<typeof brandSummary>[];
  archived_brands?: ReturnType<typeof brandSummary>[];
}

const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,128}$/;
const BRAND_PATCH_FIELDS = [
  'name',
  'short_name',
  'logo_file_ref',
  'color',
  'icon',
  'description',
  'operational_status',
  'timezone',
  'notification_content_mode',
] as const;
const WORKSPACE_PATCH_FIELDS = [
  'name',
  'logo_file_ref',
  'timezone',
  'locale',
  'currency',
  'week_start',
] as const;
const SETTINGS_NAMESPACES = ['working_hours', 'calendar', 'priorities'] as const;
export type SettingsNamespace = (typeof SETTINGS_NAMESPACES)[number];

class StepUpNeeded extends Error {
  readonly membershipId: string;
  readonly workspaceId: string;
  readonly actionKey: ActionKey;
  readonly target: { type: string; id: string };
  constructor(
    membershipId: string,
    workspaceId: string,
    actionKey: ActionKey,
    target: { type: string; id: string },
  ) {
    super('step-up needed');
    this.membershipId = membershipId;
    this.workspaceId = workspaceId;
    this.actionKey = actionKey;
    this.target = target;
  }
}

const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest();
const contentHash = (v: unknown) =>
  `sha256:${createHash('sha256').update(canonicalJson(v), 'utf8').digest('hex')}`;
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function pgError(err: unknown): { code?: string; constraint?: string } {
  return typeof err === 'object' && err !== null
    ? (err as { code?: string; constraint?: string })
    : {};
}

/**
 * Workspace, brand, settings, and context commands (Phase 1C). Every tenant request resolves the
 * path workspace to the caller's canonical active membership, then runs in exactly one workspace
 * transaction: authorization, idempotency, the change, its audit and security events, and epoch
 * bumps commit together.
 */
export class TenancyService {
  protected readonly d: TenancyDeps;
  readonly #cursorKey: Buffer;

  constructor(deps: TenancyDeps) {
    this.d = deps;
    this.#cursorKey = createHmac('sha256', deps.signingKey)
      .update('cursor:tenancy-brands')
      .digest();
  }

  // ---------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------

  protected count(command: string, outcome: string): void {
    this.d.metrics.count('tenancy.commands', 1, { command, outcome });
  }

  protected decision(action: ActionKey, outcome: { allowed: boolean; code?: string }): void {
    this.d.metrics.count('tenancy.authz_decisions', 1, {
      action_key: action,
      outcome: outcome.allowed ? 'allow' : (outcome.code ?? 'deny'),
    });
  }

  protected requireWorkspace(p: Principal, action: ActionKey): void {
    const o = decideWorkspace(p, action);
    this.decision(action, o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  protected requireBrand(p: Principal, action: ActionKey, row: BrandRow): void {
    const o = decideBrand(p, action, facts(row));
    this.decision(action, o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  protected exec(caller: Caller, p: Principal): ExecutionContext {
    const m = caller.meta;
    const principal = { type: 'member' as const, id: p.membershipId };
    return {
      workspaceId: p.workspaceId,
      ...(m.requestId ? { requestId: m.requestId } : {}),
      correlationId: m.correlationId,
      ...(m.traceparent ? { traceparent: m.traceparent } : {}),
      authenticatedPrincipal: principal,
      effectivePrincipal: principal,
      initiatingMembershipId: p.membershipId,
      delegationChain: [{ type: 'member', id: p.membershipId }],
      epochs: { workspace: p.epochs.workspace, principal: p.epochs.principal },
      dataClassLimit: 'C3',
    };
  }

  protected cmd(caller: Caller, p: Principal, brandId: string | null = null): CommandContext {
    const source: CommandSource = { kind: 'ui' };
    return CommandContext.fromExecution(this.exec(caller, p), source, { brandId });
  }

  protected async security(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    subject: { type: string; id: string },
  ): Promise<void> {
    await this.d.security.record(tx, {
      category: 'permission',
      action,
      outcome: 'success',
      actor: { type: 'human', id: p.membershipId },
      subject,
      correlationId: caller.meta.correlationId,
    });
  }

  /** Path workspace → membership (platform directory), then one workspace transaction. */
  protected async inWorkspace<T>(
    caller: Caller,
    workspacePublicId: unknown,
    options: { readOnly?: boolean },
    fn: (tx: WorkspaceTransaction, p: Principal & { workspaceState: string }) => Promise<T>,
  ): Promise<T> {
    const accountId = caller.auth.account.id;
    let resolved: { workspaceId: string; membershipId: string };
    try {
      resolved = await this.d.platform.withPlatform({ module: 'tenancy', readOnly: true }, (tx) =>
        resolveMembership(tx, accountId, workspacePublicId),
      );
    } catch (err) {
      if (err instanceof TenancyError)
        this.d.metrics.count('tenancy.context_failures', 1, { reason: 'no_membership' });
      throw err;
    }
    try {
      return await this.d.tenant.withWorkspace(
        resolved.workspaceId,
        { module: 'tenancy', ...(options.readOnly ? { readOnly: true } : {}) },
        async (tx) => fn(tx, await loadPrincipal(tx, accountId, resolved.membershipId)),
      );
    } catch (err) {
      if (err instanceof TenantContextError) {
        this.d.metrics.count('tenancy.context_failures', 1, { reason: err.reason });
        throw new TenancyError('not_found');
      }
      if (pgError(err).code === '42501')
        this.d.metrics.count('tenancy.rls_denials', 1, { module: 'tenancy' });
      throw err;
    }
  }

  /**
   * A mutating command: membership → authorization (inside `fn`) → idempotency reservation →
   * change + audit → completion, all in one workspace transaction. A replay re-renders the stored
   * reference through the caller's current authorization (0D §8, PC-02).
   */
  protected async mutate<T extends { id: string; type: string }>(
    caller: Caller,
    command: string,
    workspacePublicId: unknown,
    req: Mutation,
    fn: (
      tx: WorkspaceTransaction,
      p: Principal,
    ) => Promise<{ status: number; ref: { id: string; type: string }; data: T }>,
    render: (
      tx: WorkspaceTransaction,
      p: Principal,
      ref: { id: string; type: string },
    ) => Promise<T>,
  ): Promise<Result<T>> {
    requireKey(req.idempotencyKey);
    try {
      const out = await this.inWorkspace(caller, workspacePublicId, {}, async (tx, p) => {
        if (p.workspaceState !== 'active') throw new TenancyError('workspace_read_only');
        const principal = { type: 'member' as const, id: p.membershipId };
        const reserved = await reserveIdempotencyKey(tx, {
          principal,
          key: req.idempotencyKey,
          fingerprint: req.fingerprint,
          retentionMs: IDEMPOTENCY_RETENTION_MS,
        });
        if (reserved.outcome === 'in_progress')
          throw new TenancyError('idempotency_in_progress', { retryAfterSeconds: 1 });
        if (reserved.outcome === 'key_reuse') throw new TenancyError('idempotency_key_reuse');
        if (reserved.outcome === 'replay') {
          const ref = reserved.response.resource_refs?.[0];
          if (!ref) throw new TenancyError('not_found');
          return {
            status: reserved.response.status,
            data: await render(tx, p, ref),
            replayed: true,
          };
        }
        const done = await fn(tx, p);
        await completeIdempotencyKey(tx, principal, req.idempotencyKey, {
          status: done.status,
          resource_refs: [done.ref],
        });
        return { status: done.status, data: done.data, replayed: false };
      });
      this.count(command, out.replayed ? 'replayed' : 'ok');
      return out;
    } catch (err) {
      if (err instanceof StepUpNeeded) {
        this.count(command, 'step_up_required');
        const challenge: StepUpChallengeView = await this.d.stepUp.createStepUpChallenge(
          caller.auth,
          {
            actionKey: err.actionKey,
            target: err.target,
            idempotencyKey: req.idempotencyKey,
            membershipId: err.membershipId,
            workspaceId: err.workspaceId,
          },
          caller.meta,
        );
        throw new TenancyError('step_up_required', {
          stepUp: challenge as unknown as Record<string, unknown>,
        });
      }
      throw this.mapFailure(command, err);
    }
  }

  protected mapFailure(command: string, err: unknown): unknown {
    const pg = pgError(err);
    if (pg.code === '23505' && pg.constraint === 'brand_name_unique') {
      this.count(command, 'validation_failed');
      return invalid(issue('/name', 'name_taken', 'That name is not available. Choose another.'));
    }
    if (err instanceof LifecycleError) {
      this.count(command, `lifecycle_${err.reason}`);
      return err.reason === 'not_found'
        ? new TenancyError('not_found')
        : new TenancyError('conflict');
    }
    if (err instanceof PolicyDecisionError) {
      this.count(command, 'policy_rejected');
      return new TenancyError('forbidden');
    }
    if (err instanceof TenancyError) this.count(command, err.code);
    else this.count(command, 'error');
    return err;
  }

  /** Inside a transaction: a verified, bound, single-use step-up or a challenge round trip. */
  protected async stepUp(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    req: Mutation,
    actionKey: ActionKey,
    target: { type: string; id: string },
  ): Promise<string> {
    const id = await this.d.stepUp.consumeWorkspaceStepUp(
      tx,
      caller.auth,
      { actionKey, target, membershipId: p.membershipId },
      req,
      caller.meta,
    );
    if (!id) throw new StepUpNeeded(p.membershipId, p.workspaceId, actionKey, target);
    return id;
  }

  /**
   * Account-command gates beyond the session (0C AZ-18): the account is re-read from the database
   * (still present, email still verified), then the per-account rate limit applies. Replays of an
   * already-completed key return before this, so retries never consume quota.
   */
  protected async accountCommandGates(
    auth: AuthContext,
    policy: 'workspace.create' | 'invitation.accept',
  ): Promise<void> {
    const account = await this.d.platform.withPlatform(
      { module: 'tenancy', readOnly: true },
      (tx) =>
        tx.db
          .selectFrom('identity.account')
          .select(['deleted_at', 'email_verified_at'])
          .where('id', '=', auth.account.id)
          .executeTakeFirst(),
    );
    if (!account || account.deleted_at) throw new TenancyError('unauthenticated');
    if (!account.email_verified_at)
      throw new TenancyError('forbidden', {
        issues: [issue('/', 'email_unverified', 'Verify your email address to continue.')],
      });
    const decision = await this.d.limiter.consume(policy, auth.account.id);
    if (!decision.allowed) {
      this.count(policy, 'rate_limited');
      throw new TenancyError('rate_limited', { retryAfterSeconds: decision.retryAfterSeconds });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Workspaces
  // ---------------------------------------------------------------------------------------------

  async listWorkspaces(
    caller: Caller,
  ): Promise<Array<{ id: string; type: 'workspace'; name: string; selected: boolean }>> {
    const { entries, selected } = await this.d.platform.withPlatform(
      { module: 'tenancy', readOnly: true },
      async (tx) => ({
        entries: await accountWorkspaces(tx, caller.auth.account.id),
        selected: await accountSelectedWorkspace(tx, caller.auth.account.id),
      }),
    );
    return entries.map((e) => ({
      id: e.workspacePublicId,
      type: 'workspace' as const,
      name: e.name,
      selected: e.workspacePublicId === selected,
    }));
  }

  protected async workspaceView(tx: WorkspaceTransaction, p: Principal): Promise<WorkspaceView> {
    const w = await tx.db
      .selectFrom('tenancy.workspace')
      .select([
        'public_id',
        'name',
        'logo_file_ref',
        'timezone',
        'locale',
        'currency',
        'week_start',
        'state',
        'version',
        'created_at',
        'updated_at',
      ])
      .where('id', '=', tx.workspaceId)
      .executeTakeFirstOrThrow();
    return {
      id: w.public_id,
      type: 'workspace',
      name: w.name,
      logo_file_ref: w.logo_file_ref,
      timezone: w.timezone,
      locale: w.locale,
      currency: w.currency,
      week_start: Number(w.week_start),
      state: w.state,
      version: Number(w.version),
      created_at: new Date(w.created_at).toISOString(),
      updated_at: new Date(w.updated_at).toISOString(),
      capabilities: workspaceCapabilities(p),
    };
  }

  async getWorkspace(caller: Caller, workspacePublicId: unknown): Promise<WorkspaceView> {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      this.requireWorkspace(p, 'workspace.view_settings');
      return this.workspaceView(tx, p);
    });
  }

  /**
   * Account-level command (no workspace action exists before the workspace does; ADR-0010): only
   * verified accounts. One transaction creates the workspace, the canonical active membership,
   * built-in roles, the bootstrap owner assignment, permission epochs, audit and security events,
   * and the optional first brand. A retry with the same Idempotency-Key returns the original.
   */
  async createWorkspace(
    caller: Caller,
    body: unknown,
    req: Mutation,
  ): Promise<Result<{ workspace: WorkspaceView; first_brand: BrandView | null }>> {
    requireKey(req.idempotencyKey);
    let auth: AuthContext;
    try {
      // 0C AZ-18: an account command, never a tenant decision (no membership exists yet).
      auth = authorizeAccountCommand('workspace.create', caller.auth);
      this.decision('workspace.create', { allowed: true });
    } catch (err) {
      if (err instanceof TenancyError) {
        this.decision('workspace.create', { allowed: false, code: err.code });
        this.count('workspace.create', err.code);
      }
      throw err;
    }
    const input = parseWorkspaceCreate(body);
    const keyHash = sha256(`${auth.account.id}:${req.idempotencyKey}`);
    const replay = async () => {
      const existing = await this.d.platform.withPlatform(
        { module: 'tenancy', readOnly: true },
        async (tx) =>
          (
            await sql<{ workspace_public_id: string; request_hash: Buffer }>`
            SELECT workspace_public_id, request_hash
              FROM tenancy.workspace_by_creation_key(${auth.account.id}::uuid, ${keyHash})`.execute(
              tx.db,
            )
          ).rows[0],
      );
      if (!existing) return null;
      if (!Buffer.from(existing.request_hash).equals(req.fingerprint))
        throw new TenancyError('idempotency_key_reuse');
      const workspace = await this.getWorkspace(caller, existing.workspace_public_id);
      return { status: 201, data: { workspace, first_brand: null }, replayed: true };
    };
    try {
      const prior = await replay();
      if (prior) {
        this.count('workspace.create', 'replayed');
        return prior;
      }
      await this.accountCommandGates(auth, 'workspace.create');
      const workspaceId = newUuidV7();
      const membershipId = newUuidV7();
      const out = await this.d.tenant.withWorkspace(
        workspaceId,
        { module: 'tenancy', creatingWorkspace: true },
        async (tx) => {
          const publicId = newPublicId('ws');
          await tx.db
            .insertInto('tenancy.workspace')
            .values({
              id: workspaceId,
              public_id: publicId,
              name: input.name,
              timezone: input.timezone,
              locale: input.locale,
              currency: input.currency,
              week_start: input.week_start,
              created_by_actor_type: 'human',
              created_by_actor_id: membershipId,
              updated_by_actor_type: 'human',
              updated_by_actor_id: membershipId,
              creation_key_hash: keyHash,
              creation_request_hash: req.fingerprint,
              bootstrap_account_id: auth.account.id,
              bootstrap_membership_id: membershipId,
            })
            .execute();
          const membershipPublicId = newPublicId('mem');
          await tx.db
            .insertInto('tenancy.membership')
            .values({
              id: membershipId,
              public_id: membershipPublicId,
              workspace_id: workspaceId,
              account_id: auth.account.id,
              kind: 'member',
              state: 'active',
              joined_at: new Date(),
            })
            .execute();
          await sql`SELECT access.seed_builtin_roles(${workspaceId}::uuid)`.execute(tx.db);
          const owner = await roleId(tx, 'owner');
          const assignmentId = newUuidV7();
          await tx.db
            .insertInto('access.role_assignment')
            .values({
              id: assignmentId,
              workspace_id: workspaceId,
              principal_type: 'membership',
              principal_id: membershipId,
              scope_type: 'workspace',
              scope_id: workspaceId,
              role_id: owner,
              role_kind: 'workspace_role',
              grant_source: 'bootstrap_owner',
            })
            .execute();
          await tx.db
            .insertInto('access.permission_epoch')
            .values([
              { workspace_id: workspaceId, epoch_kind: 'workspace', subject_id: null },
              { workspace_id: workspaceId, epoch_kind: 'principal', subject_id: membershipId },
            ])
            .execute();
          const p = await loadPrincipal(tx, auth.account.id, membershipId);
          const cmd = this.cmd(caller, p);
          await this.d.writer.write(tx, cmd, {
            action: 'workspace.created',
            target: { recordId: workspaceId, type: 'workspace', publicId },
            changes: [
              change.plain('name', null, input.name),
              change.plain('timezone', null, input.timezone),
              change.plain('locale', null, input.locale),
              change.plain('currency', null, input.currency),
              change.plain('week_start', null, input.week_start),
            ],
          });
          await this.d.writer.write(tx, cmd, {
            action: 'membership.created',
            target: { recordId: membershipId, type: 'membership', publicId: membershipPublicId },
            changes: [change.plain('kind', null, 'member'), change.plain('state', null, 'active')],
          });
          await this.d.writer.write(tx, cmd, {
            action: 'role_assignment.created',
            target: { recordId: assignmentId, type: 'role_assignment', publicId: null },
            changes: [
              change.plain('role', null, 'owner'),
              change.plain('scope_type', null, 'workspace'),
              change.plain('grant_source', null, 'bootstrap_owner'),
            ],
          });
          await this.security(tx, caller, p, 'role_assignment.created', {
            type: 'membership',
            id: membershipId,
          });
          let firstBrand: BrandView | null = null;
          if (input.first_brand) {
            const created = await this.#createBrandIn(tx, caller, p, input.first_brand);
            firstBrand = brandView(created.principal, created.row);
          }
          return { workspace: await this.workspaceView(tx, p), first_brand: firstBrand };
        },
      );
      this.count('workspace.create', 'ok');
      return { status: 201, data: out, replayed: false };
    } catch (err) {
      // A concurrent duplicate with the same key lost the unique race: return the winner.
      if (
        pgError(err).code === '23505' &&
        pgError(err).constraint === 'workspace_creation_key_unique'
      ) {
        const prior = await replay();
        if (prior) {
          this.count('workspace.create', 'replayed');
          return prior;
        }
      }
      throw this.mapFailure('workspace.create', err);
    }
  }

  /** Field-merge update of workspace defaults (0D §4.2); per-field audit changes. */
  async updateWorkspace(
    caller: Caller,
    workspacePublicId: unknown,
    body: unknown,
    req: Mutation,
  ): Promise<Result<WorkspaceView>> {
    const merge = parseMerge(body, WORKSPACE_PATCH_FIELDS);
    return this.mutate(
      caller,
      'workspace.update',
      workspacePublicId,
      req,
      async (tx, p) => {
        this.requireWorkspace(p, 'workspace.configure');
        const w = await tx.db
          .selectFrom('tenancy.workspace')
          .select([
            'public_id',
            'name',
            'logo_file_ref',
            'timezone',
            'locale',
            'currency',
            'week_start',
            'version',
          ])
          .where('id', '=', tx.workspaceId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const current: Record<string, unknown> = {
          name: w.name,
          logo_file_ref: w.logo_file_ref,
          timezone: w.timezone,
          locale: w.locale,
          currency: w.currency,
          week_start: Number(w.week_start),
        };
        const next = applyMerge(merge, current, Number(w.version), (field, value, issues) => {
          const ptr = `/changes/${field}/value`;
          switch (field) {
            case 'name':
              return text(value, ptr, issues, { max: 80, required: true, label: 'Name' });
            case 'logo_file_ref':
              return logoRef(value, ptr, issues);
            case 'timezone':
              return timezone(value, ptr, issues);
            case 'locale':
              return locale(value, ptr, issues);
            case 'currency':
              return currency(value, ptr, issues);
            default:
              return weekday(value, ptr, issues);
          }
        });
        const changes = diff(current, next, {});
        if (changes.length) {
          await tx.db
            .updateTable('tenancy.workspace')
            .set({
              ...(next as Record<string, never>),
              updated_at: new Date(),
              updated_by_actor_type: 'human',
              updated_by_actor_id: p.membershipId,
              version: sql`version + 1`,
            })
            .where('id', '=', tx.workspaceId)
            .execute();
          await this.d.writer.write(tx, this.cmd(caller, p), {
            action: 'workspace.updated',
            target: { recordId: tx.workspaceId, type: 'workspace', publicId: w.public_id },
            changes,
          });
        }
        const data = await this.workspaceView(tx, p);
        return { status: 200, ref: { id: data.id, type: 'workspace' }, data };
      },
      (tx, p) => this.workspaceView(tx, p),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Brands
  // ---------------------------------------------------------------------------------------------

  async listBrands(
    caller: Caller,
    workspacePublicId: unknown,
    query: { state?: unknown; limit?: unknown; cursor?: unknown; include_total?: unknown },
  ): Promise<{
    data: BrandView[];
    page: {
      limit: number;
      has_more: boolean;
      next_cursor?: string;
      total?: { value: number; estimated: false; capped: false };
    };
  }> {
    const states: BrandStates =
      query.state === 'archived'
        ? 'archived'
        : query.state === 'all'
          ? 'active_or_archived'
          : 'active';
    if (query.state !== undefined && !['active', 'archived', 'all'].includes(String(query.state)))
      throw invalid(issue('/query/state', 'invalid_option', 'Use active, archived, or all.'));
    const limitRaw = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 200)
      throw invalid(issue('/query/limit', 'invalid_limit', 'Use a page size from 1 to 200.'));
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      const fingerprint = `${states}`;
      const after =
        typeof query.cursor === 'string'
          ? this.#openCursor(query.cursor, p, fingerprint)
          : query.cursor === undefined
            ? undefined
            : null;
      if (after === null) throw new TenancyError('cursor_invalid');
      const page = await listBrands(tx, p, { states, limit: limitRaw, after });
      const last = page.rows[page.rows.length - 1];
      const total = query.include_total === 'true' ? await countBrands(tx, p, states) : undefined;
      return {
        data: page.rows.map((r) => brandView(p, r)),
        page: {
          limit: limitRaw,
          has_more: page.hasMore,
          ...(page.hasMore && last
            ? {
                next_cursor: this.#sealCursor(
                  { n: last.name.toLowerCase(), i: last.id },
                  p,
                  fingerprint,
                ),
              }
            : {}),
          ...(total !== undefined
            ? { total: { value: total, estimated: false as const, capped: false as const } }
            : {}),
        },
      };
    });
  }

  async getBrand(
    caller: Caller,
    workspacePublicId: unknown,
    brandPublicId: unknown,
  ): Promise<BrandView> {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) =>
      brandView(p, await findBrand(tx, p, brandPublicId)),
    );
  }

  async createBrand(
    caller: Caller,
    workspacePublicId: unknown,
    body: unknown,
    req: Mutation,
  ): Promise<Result<BrandView>> {
    return this.mutate(
      caller,
      'brand.create',
      workspacePublicId,
      req,
      async (tx, p) => {
        this.requireWorkspace(p, 'brand.create');
        const ws = await tx.db
          .selectFrom('tenancy.workspace')
          .select('timezone')
          .where('id', '=', tx.workspaceId)
          .executeTakeFirstOrThrow();
        const input = parseBrandCreate(body, ws.timezone);
        const created = await this.#createBrandIn(tx, caller, p, input);
        const data = brandView(created.principal, created.row);
        return { status: 201, ref: { id: data.id, type: 'brand' }, data };
      },
      async (tx, p, ref) => brandView(p, await findBrand(tx, p, ref.id)),
    );
  }

  /**
   * Envelope + typed row + default settings + explicit creator manage grant, in the caller's
   * transaction. The creator grant is what lets the brand become sensitive without locking its
   * creator out (0C §6.3).
   */
  async #createBrandIn(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    input: BrandCreateInput,
  ): Promise<{ row: BrandRow; principal: Principal }> {
    const taken = await tx.db
      .selectFrom('tenancy.brand')
      .select('id')
      .where(sql<boolean>`lower(name) = lower(${input.name})`)
      .where('lifecycle_state', '<>', 'purged')
      .executeTakeFirst();
    if (taken)
      throw invalid(issue('/name', 'name_taken', 'That name is not available. Choose another.'));
    const cmd = this.cmd(caller, p);
    const envelope = await createRecord(tx, this.d.writer, cmd, {
      recordType: 'brand',
      ownerMembershipId: p.membershipId,
    });
    await tx.db
      .insertInto('tenancy.brand')
      .values({
        id: envelope.id,
        workspace_id: tx.workspaceId,
        scope_key: envelope.id,
        name: input.name,
        short_name: input.short_name,
        logo_file_ref: null,
        color: input.color,
        icon: input.icon,
        description: input.description,
        operational_status: input.operational_status,
        timezone: input.timezone,
        notification_content_mode: input.notification_content_mode,
        created_by_membership_id: p.membershipId,
        updated_by_membership_id: p.membershipId,
      })
      .execute();
    await tx.db
      .insertInto('tenancy.brand_setting')
      .values({
        workspace_id: tx.workspaceId,
        brand_id: envelope.id,
        working_hours: JSON.stringify(DEFAULT_WORKING_HOURS),
        calendar: JSON.stringify(DEFAULT_CALENDAR),
        priorities: JSON.stringify(DEFAULT_PRIORITIES),
        updated_by_membership_id: p.membershipId,
      })
      .execute();
    const brandCmd = this.cmd(caller, p, envelope.id);
    const target = { recordId: envelope.id, type: 'brand', publicId: envelope.publicId };
    await this.d.writer.write(tx, brandCmd, {
      action: 'brand.created',
      target,
      changes: [
        change.plain('name', null, input.name),
        change.plain('short_name', null, input.short_name),
        change.plain('color', null, input.color),
        change.plain('icon', null, input.icon),
        change.plain('operational_status', null, input.operational_status),
        change.plain('timezone', null, input.timezone),
        change.plain('notification_content_mode', null, input.notification_content_mode),
        ...(input.description !== null
          ? [change.content('description', { hash: contentHash(input.description) })]
          : []),
      ],
    });
    const next = await this.grantManage(
      tx,
      caller,
      p,
      envelope.id,
      envelope.publicId,
      'brand_creator',
    );
    const row = await findBrand(tx, next, envelope.publicId);
    return { row, principal: next };
  }

  /** Explicit brand-scope manage grant for the acting membership (idempotent per source). */
  protected async grantManage(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    brandId: string,
    brandPublicId: string,
    source: 'brand_creator' | 'sensitivity_creator',
  ): Promise<Principal> {
    if (p.grants.get(brandId) === 'manage') return p;
    const assignmentId = newUuidV7();
    await tx.db
      .insertInto('access.role_assignment')
      .values({
        id: assignmentId,
        workspace_id: tx.workspaceId,
        principal_type: 'membership',
        principal_id: p.membershipId,
        scope_type: 'brand',
        scope_id: brandId,
        role_id: await roleId(tx, 'scope_manage'),
        role_kind: 'scope_level',
        grant_source: source,
        granted_by_membership_id: p.membershipId,
      })
      .execute();
    await bumpEpoch(tx, 'principal', p.membershipId);
    await this.d.writer.write(tx, this.cmd(caller, p, brandId), {
      action: 'role_assignment.created',
      target: { recordId: assignmentId, type: 'role_assignment', publicId: null },
      changes: [
        change.plain('role', null, 'scope_manage'),
        change.plain('scope_type', null, 'brand'),
        change.plain('brand', null, brandPublicId),
        change.plain('grant_source', null, source),
      ],
    });
    await this.security(tx, caller, p, 'role_assignment.created', {
      type: 'membership',
      id: p.membershipId,
    });
    const grants = new Map<string, Level>(p.grants);
    grants.set(brandId, 'manage');
    return { ...p, grants, epochs: { ...p.epochs, principal: p.epochs.principal + 1 } };
  }

  /** Field-merge edit of brand identity (0D §4.2). Archived brands are read-only. */
  async updateBrand(
    caller: Caller,
    workspacePublicId: unknown,
    brandPublicId: unknown,
    body: unknown,
    req: Mutation,
  ): Promise<Result<BrandView>> {
    const merge = parseMerge(body, BRAND_PATCH_FIELDS);
    return this.mutate(
      caller,
      'brand.update',
      workspacePublicId,
      req,
      async (tx, p) => {
        const row = await findBrand(tx, p, brandPublicId, { forUpdate: true });
        this.requireBrand(p, 'brand.configure', row);
        requireActive(row);
        const current: Record<string, unknown> = Object.fromEntries(
          BRAND_PATCH_FIELDS.map((f) => [f, row[f]]),
        );
        const next = applyMerge(merge, current, Number(row.version), (field, value, issues) => {
          const ptr = `/changes/${field}/value`;
          switch (field) {
            case 'name':
              return text(value, ptr, issues, { max: 80, required: true, label: 'Name' });
            case 'short_name':
              return text(value, ptr, issues, { max: 12, required: false, label: 'Short name' });
            case 'logo_file_ref':
              return logoRef(value, ptr, issues);
            case 'color':
              return color(value, ptr, issues);
            case 'icon':
              return oneOf(value, BRAND_ICONS, ptr, issues, 'icon');
            case 'description':
              return text(value, ptr, issues, { max: 2000, required: false, label: 'Description' });
            case 'operational_status':
              return oneOf(value, OPERATIONAL_STATUSES, ptr, issues, 'status');
            case 'timezone':
              return timezone(value, ptr, issues);
            default:
              return oneOf(value, NOTIFICATION_CONTENT_MODES, ptr, issues, 'notification mode');
          }
        });
        if (
          next.name !== undefined &&
          String(next.name).toLowerCase() !== row.name.toLowerCase() &&
          (await tx.db
            .selectFrom('tenancy.brand')
            .select('id')
            .where(sql<boolean>`lower(name) = lower(${String(next.name)})`)
            .where('lifecycle_state', '<>', 'purged')
            .where('id', '<>', row.id)
            .executeTakeFirst())
        )
          throw invalid(
            issue(
              '/changes/name/value',
              'name_taken',
              'That name is not available. Choose another.',
            ),
          );
        const changes = diff(current, next, { description: 'content' });
        if (changes.length) {
          await tx.db
            .updateTable('tenancy.brand')
            .set({
              ...(next as Record<string, never>),
              updated_at: new Date(),
              updated_by_membership_id: p.membershipId,
              version: sql`version + 1`,
            })
            .where('id', '=', row.id)
            .execute();
          await this.d.writer.write(tx, this.cmd(caller, p, row.id), {
            action: 'brand.updated',
            target: { recordId: row.id, type: 'brand', publicId: row.public_id },
            changes,
          });
        }
        const data = brandView(p, await findBrand(tx, p, row.public_id));
        return { status: 200, ref: { id: data.id, type: 'brand' }, data };
      },
      async (tx, p, ref) => brandView(p, await findBrand(tx, p, ref.id)),
    );
  }

  /**
   * Mark or unmark sensitive (R3, step-up). Marking first ensures the actor holds an explicit
   * manage grant, so the change can never lock the acting owner out; every other implicit
   * viewer loses access, hence a workspace epoch bump.
   */
  async setSensitivity(
    caller: Caller,
    workspacePublicId: unknown,
    brandPublicId: unknown,
    body: unknown,
    req: Mutation,
  ): Promise<Result<BrandView>> {
    const b = isObject(body) ? body : {};
    const extra = Object.keys(b).filter((k) => k !== 'is_sensitive');
    if (typeof b.is_sensitive !== 'boolean' || extra.length)
      throw invalid(
        ...(typeof b.is_sensitive !== 'boolean'
          ? [issue('/is_sensitive', 'invalid_type', 'Choose yes or no.')]
          : []),
        ...extra.map((k) => issue(`/${k}`, 'unsupported_field', 'This field is not supported.')),
      );
    const wanted = b.is_sensitive;
    const expected = parseIfMatch(req.ifMatch);
    return this.mutate(
      caller,
      'brand.set_sensitivity',
      workspacePublicId,
      req,
      async (tx, p) => {
        const row = await findBrand(tx, p, brandPublicId, { forUpdate: true });
        this.requireBrand(p, 'brand.mark_sensitive', row);
        requireActive(row);
        requireVersion(expected, Number(row.version));
        if (row.is_sensitive === wanted) {
          const data = brandView(p, row);
          return { status: 200, ref: { id: data.id, type: 'brand' }, data };
        }
        await this.stepUp(tx, caller, p, req, 'brand.mark_sensitive', {
          type: 'brand',
          id: row.public_id,
        });
        let next = p;
        if (wanted)
          next = await this.grantManage(
            tx,
            caller,
            p,
            row.id,
            row.public_id,
            'sensitivity_creator',
          );
        await tx.db
          .updateTable('tenancy.brand')
          .set({
            is_sensitive: wanted,
            updated_at: new Date(),
            updated_by_membership_id: p.membershipId,
            version: sql`version + 1`,
          })
          .where('id', '=', row.id)
          .execute();
        await bumpEpoch(tx, 'workspace', null);
        await this.d.writer.write(tx, this.cmd(caller, next, row.id), {
          action: 'brand.sensitivity_changed',
          target: { recordId: row.id, type: 'brand', publicId: row.public_id },
          changes: [change.plain('is_sensitive', row.is_sensitive, wanted)],
        });
        await this.security(tx, caller, next, 'brand.sensitivity_changed', {
          type: 'brand',
          id: row.id,
        });
        const data = brandView(next, await findBrand(tx, next, row.public_id));
        return { status: 200, ref: { id: data.id, type: 'brand' }, data };
      },
      async (tx, p, ref) => brandView(p, await findBrand(tx, p, ref.id)),
    );
  }

  /** Archive through the Phase 1F lifecycle (one batch over registered containment). */
  async archiveBrand(
    caller: Caller,
    workspacePublicId: unknown,
    brandPublicId: unknown,
    req: Mutation,
  ): Promise<Result<BrandView>> {
    return this.#brandLifecycle(
      caller,
      'brand.archive',
      workspacePublicId,
      brandPublicId,
      req,
      'archive',
    );
  }

  /** Restore reverses exactly the brand's archive batch; IDs and settings are unchanged. */
  async restoreBrand(
    caller: Caller,
    workspacePublicId: unknown,
    brandPublicId: unknown,
    req: Mutation,
  ): Promise<Result<BrandView>> {
    return this.#brandLifecycle(
      caller,
      'brand.restore',
      workspacePublicId,
      brandPublicId,
      req,
      'restore',
    );
  }

  async #brandLifecycle(
    caller: Caller,
    command: string,
    workspacePublicId: unknown,
    brandPublicId: unknown,
    req: Mutation,
    kind: 'archive' | 'restore',
  ): Promise<Result<BrandView>> {
    const expected = parseIfMatch(req.ifMatch);
    return this.mutate(
      caller,
      command,
      workspacePublicId,
      req,
      async (tx, p) => {
        const row = await findBrand(tx, p, brandPublicId, { forUpdate: true });
        this.requireBrand(p, 'brand.archive', row);
        requireVersion(expected, Number(row.version));
        const target = kind === 'archive' ? 'archived' : 'active';
        if (row.lifecycle_state !== target) {
          const decision = issueLifecycleDecision(
            'brand.archive',
            tx.workspaceId,
            [row.id],
            p.membershipId,
          );
          const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
          if (kind === 'archive') await this.d.lifecycle.archive(tx, decision, input, row.id);
          else await this.d.lifecycle.unarchive(tx, decision, input, row.id);
          await tx.db
            .updateTable('tenancy.brand')
            .set({
              updated_at: new Date(),
              updated_by_membership_id: p.membershipId,
              version: sql`version + 1`,
            })
            .where('id', '=', row.id)
            .execute();
          await bumpEpoch(tx, 'workspace', null);
        }
        const data = brandView(p, await findBrand(tx, p, row.public_id));
        return { status: 200, ref: { id: data.id, type: 'brand' }, data };
      },
      async (tx, p, ref) => brandView(p, await findBrand(tx, p, ref.id)),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Brand settings (working hours, calendar foundation, goals/priorities)
  // ---------------------------------------------------------------------------------------------

  async getBrandSettings(
    caller: Caller,
    workspacePublicId: unknown,
    brandPublicId: unknown,
  ): Promise<BrandSettingsView> {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      const row = await findBrand(tx, p, brandPublicId);
      return settingsView(row, await loadSettings(tx, row.id));
    });
  }

  /** Replaces one settings namespace (whole-record operation: `If-Match` required, 0D §4.1). */
  async updateBrandSettings(
    caller: Caller,
    workspacePublicId: unknown,
    brandPublicId: unknown,
    namespace: unknown,
    body: unknown,
    req: Mutation,
  ): Promise<Result<BrandSettingsView>> {
    if (!(SETTINGS_NAMESPACES as readonly unknown[]).includes(namespace))
      throw new TenancyError('not_found');
    const ns = namespace as SettingsNamespace;
    const issues = new Issues();
    const value =
      ns === 'working_hours'
        ? parseWorkingHours(body, issues)
        : ns === 'calendar'
          ? parseCalendar(body, issues)
          : parsePriorities(body, issues);
    issues.throwIfAny();
    const expected = parseIfMatch(req.ifMatch);
    return this.mutate(
      caller,
      `brand_settings.${ns}`,
      workspacePublicId,
      req,
      async (tx, p) => {
        const row = await findBrand(tx, p, brandPublicId, { forUpdate: true });
        this.requireBrand(p, 'brand.configure', row);
        requireActive(row);
        const settings = await loadSettings(tx, row.id, true);
        requireVersion(expected, Number(settings.version));
        const before = settings[ns];
        if (!same(before, value)) {
          await tx.db
            .updateTable('tenancy.brand_setting')
            .set({
              [ns]: JSON.stringify(value),
              updated_at: new Date(),
              updated_by_membership_id: p.membershipId,
              version: sql`version + 1`,
            })
            .where('brand_id', '=', row.id)
            .execute();
          await this.d.writer.write(tx, this.cmd(caller, p, row.id), {
            action: 'brand_setting.updated',
            target: { recordId: row.id, type: 'brand', publicId: row.public_id },
            // Structured settings are recorded by canonical content hash (audit values are scalars).
            changes: [change.content(ns, { hash: contentHash(value) })],
          });
        }
        const data = settingsView(row, await loadSettings(tx, row.id));
        return { status: 200, ref: { id: row.public_id, type: 'brand' }, data };
      },
      async (tx, p, ref) => {
        const row = await findBrand(tx, p, ref.id);
        return settingsView(row, await loadSettings(tx, row.id));
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Context (server-derived scope; personal preference validated on every use)
  // ---------------------------------------------------------------------------------------------

  protected async context(
    tx: WorkspaceTransaction,
    p: Principal,
    includeArchived: boolean,
  ): Promise<ContextView> {
    const w = await tx.db
      .selectFrom('tenancy.workspace')
      .select(['public_id', 'name'])
      .where('id', '=', tx.workspaceId)
      .executeTakeFirstOrThrow();
    const brands = await authorizedActiveBrands(tx, p);
    const pref = await tx.db
      .selectFrom('tenancy.scope_preference')
      .select(['scope_kind', 'brand_id'])
      .where('owner_membership_id', '=', p.membershipId)
      .executeTakeFirst();
    let scope: ContextView['scope'];
    let fallback: ContextView['fallback'] = null;
    const chosen =
      pref?.scope_kind === 'brand' ? brands.find((b) => b.id === pref.brand_id) : undefined;
    if (pref?.scope_kind === 'all') {
      // The union of currently authorized active brands: explicit IDs, never a wildcard.
      scope = { kind: 'all', brand_ids: brands.map((b) => b.public_id) };
    } else if (chosen) {
      scope = { kind: 'brand', brand_id: chosen.public_id };
    } else {
      // Missing, stale, archived, revoked, or now-sensitive selection: narrow to the first
      // authorized active brand (or require selection), never broaden to all brands.
      fallback = pref ? 'stale_selection' : 'no_selection';
      this.d.metrics.count('tenancy.context_fallbacks', 1, { reason: fallback });
      scope = brands[0] ? { kind: 'brand', brand_id: brands[0].public_id } : { kind: 'none' };
    }
    const view: ContextView = {
      workspace: { id: w.public_id, name: w.name, capabilities: workspaceCapabilities(p) },
      scope,
      fallback,
      brands: brands.map(brandSummary),
    };
    if (includeArchived) {
      const archived = await listBrands(tx, p, { states: 'archived', limit: 200 });
      view.archived_brands = archived.rows.map(brandSummary);
    }
    return view;
  }

  async getContext(
    caller: Caller,
    workspacePublicId: unknown,
    options: { includeArchived?: boolean } = {},
  ): Promise<ContextView> {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, (tx, p) =>
      this.context(tx, p, options.includeArchived === true),
    );
  }

  /**
   * Selects the workspace (and optionally a brand or all-brands scope) as the caller's personal
   * preference. A brand must be authorized and active; anything else is the same `not_found`.
   */
  async selectContext(
    caller: Caller,
    workspacePublicId: unknown,
    body: unknown,
  ): Promise<ContextView> {
    const b = isObject(body) ? body : {};
    for (const k of Object.keys(b))
      if (k !== 'scope' && k !== 'brand_id')
        throw invalid(issue(`/${k}`, 'unsupported_field', 'This field is not supported.'));
    if (b.scope !== undefined && b.scope !== 'brand' && b.scope !== 'all')
      throw invalid(issue('/scope', 'invalid_option', 'Choose one brand or all brands.'));
    try {
      const out = await this.inWorkspace(caller, workspacePublicId, {}, async (tx, p) => {
        let selection: { scope_kind: 'brand' | 'all'; brand_id: string | null } | null = null;
        if (b.scope === 'all') selection = { scope_kind: 'all', brand_id: null };
        else if (b.scope === 'brand') {
          const row = await findBrand(tx, p, b.brand_id, { states: 'active' });
          selection = { scope_kind: 'brand', brand_id: row.id };
        } else {
          const existing = await tx.db
            .selectFrom('tenancy.scope_preference')
            .select(['scope_kind', 'brand_id'])
            .where('owner_membership_id', '=', p.membershipId)
            .executeTakeFirst();
          selection = existing
            ? { scope_kind: existing.scope_kind, brand_id: existing.brand_id }
            : null;
        }
        if (selection) {
          await tx.db
            .insertInto('tenancy.scope_preference')
            .values({
              workspace_id: tx.workspaceId,
              owner_membership_id: p.membershipId,
              ...selection,
              updated_at: new Date(),
            })
            .onConflict((oc) =>
              oc.columns(['workspace_id', 'owner_membership_id']).doUpdateSet({
                scope_kind: selection.scope_kind,
                brand_id: selection.brand_id,
                updated_at: new Date(),
              }),
            )
            .execute();
        }
        return this.context(tx, p, false);
      });
      this.count('context.select', 'ok');
      return out;
    } catch (err) {
      throw this.mapFailure('context.select', err);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Cursors: AES-GCM sealed, bound to (workspace, membership, query) via AAD (0D §2.5)
  // ---------------------------------------------------------------------------------------------

  #sealCursor(pos: { n: string; i: string }, p: Principal, query: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#cursorKey, iv);
    c.setAAD(Buffer.from(`${p.workspaceId}|${p.membershipId}|${query}`));
    const body = Buffer.concat([c.update(JSON.stringify(pos), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
  }

  #openCursor(cursor: string, p: Principal, query: string): { n: string; i: string } | null {
    try {
      const raw = Buffer.from(cursor, 'base64url');
      if (raw.length < 29 || raw.length > 1536) return null;
      const d = createDecipheriv('aes-256-gcm', this.#cursorKey, raw.subarray(0, 12));
      d.setAAD(Buffer.from(`${p.workspaceId}|${p.membershipId}|${query}`));
      d.setAuthTag(raw.subarray(12, 28));
      const pos = JSON.parse(
        Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'),
      ) as {
        n: unknown;
        i: unknown;
      };
      if (typeof pos.n !== 'string' || typeof pos.i !== 'string') return null;
      if (!/^[0-9a-f-]{36}$/.test(pos.i)) return null;
      return { n: pos.n, i: pos.i };
    } catch {
      return null;
    }
  }
}

// -----------------------------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------------------------

function requireKey(key: string): void {
  if (!KEY_PATTERN.test(key))
    throw invalid(
      issue(
        '/headers/idempotency-key',
        'idempotency_key_required',
        'An Idempotency-Key header (16-128 characters) is required.',
      ),
    );
}

async function roleId(tx: WorkspaceTransaction, key: string): Promise<string> {
  const r = await tx.db
    .selectFrom('access.role')
    .select('id')
    .where('key', '=', key)
    .where('builtin', '=', true)
    .executeTakeFirstOrThrow();
  return r.id;
}

function requireActive(row: BrandRow): void {
  if (row.lifecycle_state !== 'active')
    throw new TenancyError('conflict', {
      issues: [issue('/', 'brand_archived', 'This brand is archived. Restore it to make changes.')],
    });
}

/** `If-Match: "<version>"` (0D §2.6): missing → precondition_required; mismatch → conflict. */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined || header === '') throw new TenancyError('precondition_required');
  const m = /^"(\d{1,18})"$/.exec(header.trim());
  if (!m) throw new TenancyError('precondition_required');
  return Number(m[1]);
}

function requireVersion(expected: number, current: number): void {
  if (expected !== current)
    throw new TenancyError('conflict', { conflict: { current_version: current } });
}

interface MergeRequest {
  version: number | undefined;
  changes: Map<string, { base: unknown; value: unknown }>;
}

/** Parses a 0D `field-merge-request`; unknown fields are `unsupported_field`. */
export function parseMerge(body: unknown, allowed: readonly string[]): MergeRequest {
  const issues = new Issues();
  if (!isObject(body) || !isObject(body.changes)) {
    issues.add('/changes', 'required', 'Send the changed fields.');
    issues.throwIfAny();
  }
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b))
    if (k !== 'version' && k !== 'changes')
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  if (b.version !== undefined && (typeof b.version !== 'number' || !Number.isInteger(b.version)))
    issues.add('/version', 'invalid_type', 'Version must be a whole number.');
  const changes = new Map<string, { base: unknown; value: unknown }>();
  for (const [field, c] of Object.entries(b.changes as Record<string, unknown>)) {
    if (!allowed.includes(field)) {
      issues.add(`/changes/${field}`, 'unsupported_field', 'This field is not supported.');
      continue;
    }
    if (!isObject(c) || !('base' in c) || !('value' in c)) {
      issues.add(`/changes/${field}`, 'invalid_type', 'Send the base and new value.');
      continue;
    }
    changes.set(field, { base: c.base, value: c.value });
  }
  if (!changes.size) issues.add('/changes', 'required', 'Send at least one changed field.');
  issues.throwIfAny();
  return { version: b.version as number | undefined, changes };
}

/**
 * 0D §4.2: per field, current = base → apply; current = new value → no-op; otherwise conflict.
 * The request is atomic. Returns validated new values for changed fields only.
 */
function applyMerge(
  merge: MergeRequest,
  current: Record<string, unknown>,
  version: number,
  validate: (field: string, value: unknown, issues: Issues) => unknown,
): Record<string, unknown> {
  const issues = new Issues();
  const next: Record<string, unknown> = {};
  const conflicts: string[] = [];
  const clean: string[] = [];
  for (const [field, c] of merge.changes) {
    const v = validate(field, c.value, issues);
    if (v === undefined) continue;
    if (same(current[field], v)) continue;
    if (merge.version === version || same(current[field], c.base)) {
      next[field] = v;
      clean.push(field);
    } else conflicts.push(field);
  }
  issues.throwIfAny();
  if (conflicts.length)
    throw new TenancyError('conflict', {
      conflict: {
        current_version: version,
        would_merge: clean.sort(),
        fields: conflicts.sort().map((field) => ({
          field,
          yours: merge.changes.get(field)!.value,
          theirs: current[field] ?? null,
          theirs_readable: true as const,
        })),
      },
    });
  return next;
}

function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  classes: Record<string, 'content'>,
): StoredChange[] {
  return Object.keys(after)
    .sort()
    .filter((f) => !same(before[f], after[f]))
    .map((f) =>
      classes[f] === 'content'
        ? change.content(f, { hash: contentHash(after[f] ?? null) })
        : change.plain(f, before[f] ?? null, after[f] ?? null),
    );
}

export interface BrandCreateInput {
  name: string;
  short_name: string | null;
  color: string;
  icon: string;
  description: string | null;
  operational_status: (typeof OPERATIONAL_STATUSES)[number];
  timezone: string;
  notification_content_mode: (typeof NOTIFICATION_CONTENT_MODES)[number];
}

const BRAND_CREATE_FIELDS = [
  'name',
  'short_name',
  'color',
  'icon',
  'description',
  'operational_status',
  'timezone',
  'notification_content_mode',
];

export function parseBrandCreate(
  body: unknown,
  defaultTimezone: string,
  prefix = '',
): BrandCreateInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!BRAND_CREATE_FIELDS.includes(k))
      issues.add(`${prefix}/${k}`, 'unsupported_field', 'This field is not supported.');
  const name = text(b.name, `${prefix}/name`, issues, { max: 80, required: true, label: 'Name' });
  const shortName = text(b.short_name, `${prefix}/short_name`, issues, {
    max: 12,
    required: false,
    label: 'Short name',
  });
  const c = color(b.color ?? '#336699', `${prefix}/color`, issues);
  const icon = oneOf(b.icon ?? 'circle', BRAND_ICONS, `${prefix}/icon`, issues, 'icon');
  const description = text(b.description, `${prefix}/description`, issues, {
    max: 2000,
    required: false,
    label: 'Description',
  });
  const status = oneOf(
    b.operational_status ?? 'operating',
    OPERATIONAL_STATUSES,
    `${prefix}/operational_status`,
    issues,
    'status',
  );
  const tz = timezone(b.timezone ?? defaultTimezone, `${prefix}/timezone`, issues);
  const mode = oneOf(
    b.notification_content_mode ?? 'standard',
    NOTIFICATION_CONTENT_MODES,
    `${prefix}/notification_content_mode`,
    issues,
    'notification mode',
  );
  issues.throwIfAny();
  return {
    name: name!,
    short_name: shortName ?? null,
    color: c!,
    icon: icon!,
    description: description ?? null,
    operational_status: status!,
    timezone: tz!,
    notification_content_mode: mode!,
  };
}

export interface WorkspaceCreateInput {
  name: string;
  timezone: string;
  locale: string;
  currency: string;
  week_start: number;
  first_brand: BrandCreateInput | null;
}

export function parseWorkspaceCreate(body: unknown): WorkspaceCreateInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['name', 'timezone', 'locale', 'currency', 'week_start', 'first_brand'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const name = text(b.name, '/name', issues, { max: 80, required: true, label: 'Workspace name' });
  const tz = timezone(b.timezone, '/timezone', issues);
  const loc = locale(b.locale, '/locale', issues);
  const cur = currency(b.currency, '/currency', issues);
  const ws = weekday(b.week_start, '/week_start', issues);
  issues.throwIfAny();
  let firstBrand: BrandCreateInput | null = null;
  if (b.first_brand !== undefined && b.first_brand !== null) {
    if (!isObject(b.first_brand))
      throw invalid(
        issue('/first_brand', 'invalid_type', 'The first brand is not in a supported format.'),
      );
    firstBrand = parseBrandCreate(b.first_brand, tz!, '/first_brand');
  }
  return {
    name: name!,
    timezone: tz!,
    locale: loc!,
    currency: cur!,
    week_start: ws!,
    first_brand: firstBrand,
  };
}
