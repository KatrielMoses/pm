import { change } from '@pm/audit';
import type { SecretVault } from '@pm/config';
import { API_VERSION, newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type TenantDatabase, type WorkspaceTransaction } from '@pm/db';
import type { AuthContext } from '@pm/identity';
import { writeOutboxEvent, type InternalEvent } from '@pm/platform';
import {
  brandLevel,
  decideBrand,
  decideWorkspace,
  findBrand,
  invalid,
  issue,
  loadPrincipal,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
  type TokenDelegation,
} from '@pm/tenancy';
import { ReportService } from '../insights/report-service.ts';
import {
  assertPublicHttps,
  hashEqual,
  newApiSecret,
  newHookSecret,
  PERSONAL_SCOPES,
  PUBLIC_WEBHOOK_NAMES,
  PUBLIC_WEBHOOKS,
  publicFacts,
  READ_SCOPES,
  retryableStatus,
  scopeAllows,
  SERVICE_SCOPES,
  signPayload,
  signatureHeader,
  signaturesMatch,
  tokenHash,
  webhookDelayMs,
  writesNeedStepUp,
  type OutboundEnvelope,
} from './semantics.ts';

const SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000;

export interface WebhookTransportRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}
export type WebhookTransportResult =
  { kind: 'status'; status: number } | { kind: 'timeout' } | { kind: 'network' };
export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResult>;

export async function defaultWebhookTransport(
  req: WebhookTransportRequest,
): Promise<WebhookTransportResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      redirect: 'manual',
      headers: req.headers,
      body: req.body,
      signal: ctrl.signal,
    });
    if (res.status >= 300 && res.status < 400) return { kind: 'network' };
    return { kind: 'status', status: res.status };
  } catch (err) {
    return ctrl.signal.aborted || (err as { name?: string }).name === 'AbortError'
      ? { kind: 'timeout' }
      : { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

interface TokenRow {
  workspace_id: string;
  token_id: string;
  public_id: string;
  kind: string;
  principal_type: string;
  scopes: string[];
  brand_ids: string[] | null;
  expires_at: Date | null;
  membership_id: string;
  account_id: string;
  state: string;
}

export interface AuthenticatedToken {
  delegation: TokenDelegation;
  accountId: string;
  workspaceId: string;
}

/**
 * Public API tokens and webhooks (Phase 6B). Every later read still goes through the compiled
 * principal and row-level security. A token only narrows that principal.
 */
export class PublicApiService extends ReportService {
  readonly #vault: SecretVault | null;
  readonly #deliver: WebhookTransport;

  constructor(
    deps: ConstructorParameters<typeof ReportService>[0] & {
      vault?: SecretVault | null;
      deliver?: WebhookTransport;
    },
  ) {
    super(deps);
    this.#vault = deps.vault ?? null;
    this.#deliver = deps.deliver ?? defaultWebhookTransport;
  }

  async limitApi(
    tokenId: string,
    write: boolean,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const decision = await this.d.limiter.consume(write ? 'api.write' : 'api.read', tokenId);
    return decision;
  }

  async authenticateApiToken(secret: string): Promise<AuthenticatedToken | null> {
    if (!secret.startsWith('pm_') || secret.length < 20) return null;
    const prefix = secret.slice(0, 11);
    const hash = tokenHash(secret);
    const row = await this.d.platform.withPlatform(
      { module: 'integrations', readOnly: true },
      async (tx) => {
        const res = await sql<TokenRow>`
        SELECT workspace_id, token_id, public_id, kind, principal_type, scopes, brand_ids, expires_at,
               membership_id, account_id, state
          FROM integrations.resolve_api_token(${prefix}, ${hash})`.execute(tx.db);
        return res.rows[0] ?? null;
      },
    );
    if (!row || !hashEqual(hash, hash)) return null;
    return {
      accountId: row.account_id,
      workspaceId: row.workspace_id,
      delegation: {
        tokenId: row.token_id,
        tokenPublicId: row.public_id,
        kind: row.kind === 'service' ? 'service' : 'personal',
        principalType: row.kind === 'service' ? 'service_principal' : 'api_token_personal',
        scopes: row.scopes,
        brandIds: row.brand_ids,
        membershipId: row.membership_id,
        accountId: row.account_id,
        sourceKind: 'api',
      },
    };
  }

  async createToken(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = this.#tokenInput(body);
    return this.mutate(
      caller,
      'api_token.create',
      ws,
      req,
      async (tx, p) => {
        if (caller.delegation) throw new TenancyError('forbidden');
        if (input.kind === 'service') this.requireWorkspace(p, 'api_tokens.service.manage');
        else this.requirePersonal(p, 'api_tokens.personal');
        this.#tokenPolicy(p, input);
        if (writesNeedStepUp(input.scopes)) {
          await this.stepUp(
            tx,
            caller,
            p,
            req,
            input.kind === 'service' ? 'api_tokens.service.manage' : 'api_tokens.personal',
            { type: 'workspace', id: String(ws) },
          );
        }
        await this.#tokenRoom(tx, p, input.kind);
        const minted = await this.#insertToken(tx, caller, p, input);
        await this.workEvent(
          tx,
          caller,
          p,
          'integrations.api_token.created',
          { type: 'integrations.api_token', id: minted.id, sequence: 1 },
          { kind: input.kind, scope_count: input.scopes.length },
          null,
        );
        return { status: 201, ref: { id: minted.publicId, type: 'api_token' }, data: minted.view };
      },
      (tx, p, ref) => this.#tokenView(tx, p, ref.id, null),
    );
  }

  async listTokens(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      if (caller.delegation) throw new TenancyError('forbidden');
      const rows = await tx.db
        .selectFrom('integrations.api_token')
        .select([
          'public_id',
          'kind',
          'name',
          'token_prefix',
          'scopes',
          'expires_at',
          'last_used_at',
          'state',
          'version',
          'accountable_owner_membership_id',
        ])
        .where((eb) =>
          eb.or([
            eb('accountable_owner_membership_id', '=', p.membershipId),
            eb.and([
              eb('kind', '=', 'service'),
              eb.or([eb.val(p.role === 'owner'), eb.val(p.role === 'administrator')]),
            ]),
          ]),
        )
        .orderBy('created_at', 'desc')
        .limit(this.ws.apiTokensPersonalMax + this.ws.apiTokensServiceMax)
        .execute();
      return { tokens: rows.map((r) => this.#tokenJson(r, null)) };
    });
  }

  async revokeToken(caller: Caller, ws: unknown, id: string, req: Mutation) {
    return this.mutate(
      caller,
      'api_token.revoke',
      ws,
      req,
      async (tx, p) => {
        if (caller.delegation) throw new TenancyError('forbidden');
        const row = await this.#ownToken(tx, p, id);
        if (row.kind === 'service') this.requireWorkspace(p, 'api_tokens.service.manage');
        else this.requirePersonal(p, 'api_tokens.personal');
        if (row.state === 'active') {
          await tx.db
            .updateTable('integrations.api_token')
            .set({ state: 'revoked', revoked_at: new Date(), version: sql`version + 1` as never })
            .where('id', '=', row.id)
            .execute();
          await this.workEvent(
            tx,
            caller,
            p,
            'integrations.api_token.revoked',
            { type: 'integrations.api_token', id: row.id, sequence: Number(row.version) + 1 },
            { kind: row.kind },
            null,
          );
        }
        return {
          status: 200,
          ref: { id: row.public_id, type: 'api_token' },
          data: await this.#tokenView(tx, p, row.public_id, null),
        };
      },
      (tx, p, ref) => this.#tokenView(tx, p, ref.id, null),
    );
  }

  async rotateToken(caller: Caller, ws: unknown, id: string, req: Mutation) {
    return this.mutate(
      caller,
      'api_token.rotate',
      ws,
      req,
      async (tx, p) => {
        if (caller.delegation) throw new TenancyError('forbidden');
        const row = await this.#ownToken(tx, p, id);
        if (row.state !== 'active') throw new TenancyError('conflict');
        if (row.kind === 'service') this.requireWorkspace(p, 'api_tokens.service.manage');
        else this.requirePersonal(p, 'api_tokens.personal');
        if (writesNeedStepUp(row.scopes)) {
          await this.stepUp(
            tx,
            caller,
            p,
            req,
            row.kind === 'service' ? 'api_tokens.service.manage' : 'api_tokens.personal',
            { type: 'api_token', id },
          );
        }
        const minted = newApiSecret();
        await tx.db
          .updateTable('integrations.api_token')
          .set({
            token_prefix: minted.prefix,
            token_hash: tokenHash(minted.secret),
            version: sql`version + 1` as never,
            updated_at: new Date(),
          })
          .where('id', '=', row.id)
          .execute();
        await this.workEvent(
          tx,
          caller,
          p,
          'integrations.api_token.rotated',
          { type: 'integrations.api_token', id: row.id, sequence: Number(row.version) + 1 },
          { kind: row.kind },
          null,
        );
        return {
          status: 200,
          ref: { id: row.public_id, type: 'api_token' },
          data: await this.#tokenView(tx, p, row.public_id, minted.secret),
        };
      },
      (tx, p, ref) => this.#tokenView(tx, p, ref.id, null),
    );
  }

  async createSubscription(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = await this.#subscriptionInput(body);
    return this.mutate(
      caller,
      'webhook_subscription.create',
      ws,
      req,
      async (tx, p) => {
        const brand = await this.#webhookBrand(tx, caller, p, input.brand);
        await this.#subscriptionRoom(tx, brand?.id ?? null);
        const id = newUuidV7();
        const publicId = newPublicId('whk');
        const cmd = this.cmd(caller, p, brand?.id ?? null);
        const secret = newApiSecret().secret;
        const ref = await this.#putSecret(tx, 'webhook_sign', secret);
        await tx.db
          .insertInto('core.record')
          .values({
            id,
            public_id: publicId,
            record_type: 'webhook_subscription',
            workspace_id: tx.workspaceId,
            brand_id: brand?.id ?? null,
            source_kind: cmd.source.kind,
            source_ref: cmd.source.ref ?? null,
            created_by_actor_type: cmd.actor.type,
            created_by_actor_id: cmd.actor.id,
          })
          .execute();
        await tx.db
          .insertInto('integrations.webhook_subscription')
          .values({
            id,
            workspace_id: tx.workspaceId,
            brand_id: brand?.id ?? null,
            scope_key: brand?.id ?? tx.workspaceId,
            api_version: API_VERSION,
            event_types: input.events,
            field_allowlist_version: 1,
            destination_url: input.url,
            state: 'active',
            signing_secret_ref: ref,
            accountable_owner_membership_id: p.membershipId,
            created_by_membership_id: p.membershipId,
          })
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'webhook_subscription.created',
          { recordId: id, type: 'webhook_subscription', publicId },
          [change.plain('destination', null, 'set')],
          brand?.id ?? null,
        );
        return {
          status: 201,
          ref: { id: publicId, type: 'webhook_subscription' },
          data: this.#subJson(publicId, input, secret, 0),
        };
      },
      async (tx, p, ref) => {
        const row = await this.#subscription(tx, p, ref.id);
        return this.#subJson(
          row.publicId,
          { url: row.destination_url, events: row.event_types },
          null,
          Number(row.version),
        );
      },
    );
  }

  async listSubscriptions(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      this.#canList(caller, p);
      const rows = await tx.db
        .selectFrom('integrations.webhook_subscription as s')
        .innerJoin('core.record as r', 'r.id', 's.id')
        .select([
          'r.public_id as public_id',
          's.destination_url',
          's.event_types',
          's.state',
          's.version',
          's.consecutive_failures',
          's.api_version',
        ])
        .where('s.lifecycle_state', '=', 'active')
        .orderBy('s.created_at', 'desc')
        .limit(this.ws.webhookSubscriptionsMax)
        .execute();
      return {
        subscriptions: rows.map((r) => ({
          id: r.public_id,
          type: 'webhook_subscription' as const,
          version: Number(r.version),
          destination_url: r.destination_url,
          event_types: r.event_types,
          state: r.state,
          api_version: r.api_version,
          consecutive_failures: r.consecutive_failures,
        })),
      };
    });
  }

  async rotateSubscriptionSecret(caller: Caller, ws: unknown, id: string, req: Mutation) {
    return this.mutate(
      caller,
      'webhook_subscription.rotate',
      ws,
      req,
      async (tx, p) => {
        this.#canList(caller, p);
        const row = await this.#subscription(tx, p, id);
        const secret = newApiSecret().secret;
        const ref = await this.#putSecret(tx, 'webhook_sign', secret);
        await tx.db
          .updateTable('integrations.webhook_subscription')
          .set({
            previous_secret_ref: row.signing_secret_ref,
            previous_secret_until: new Date(Date.now() + SECRET_OVERLAP_MS),
            signing_secret_ref: ref,
            version: sql`version + 1` as never,
            updated_at: new Date(),
            updated_by_membership_id: p.membershipId,
          })
          .where('id', '=', row.id)
          .execute();
        return {
          status: 200,
          ref: { id, type: 'webhook_subscription' },
          data: {
            id,
            type: 'webhook_subscription' as const,
            version: Number(row.version) + 1,
            secret,
          },
        };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'webhook_subscription' as const, version: 0 }),
    );
  }

  async listDeliveries(caller: Caller, ws: unknown, id: string) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      this.#canList(caller, p);
      const sub = await this.#subscription(tx, p, id);
      const rows = await tx.db
        .selectFrom('integrations.webhook_delivery')
        .select([
          'public_id',
          'event_public_id',
          'event_type',
          'state',
          'attempt',
          'response_status',
          'duration_ms',
          'next_attempt_at',
          'created_at',
          'detail',
        ])
        .where('subscription_id', '=', sub.id)
        .orderBy('created_at', 'desc')
        .limit(this.ws.pageLimitMax)
        .execute();
      return {
        deliveries: rows.map((r) => ({
          id: r.public_id,
          type: 'webhook_delivery' as const,
          event_id: r.event_public_id,
          event_type: r.event_type,
          state: r.state,
          attempt: r.attempt,
          response_status: r.response_status,
          duration_ms: r.duration_ms,
          next_attempt_at: r.next_attempt_at?.toISOString() ?? null,
          created_at: r.created_at.toISOString(),
          detail: r.detail,
        })),
      };
    });
  }

  async replayDelivery(caller: Caller, ws: unknown, id: string, req: Mutation) {
    return this.mutate(
      caller,
      'webhook_delivery.replay',
      ws,
      req,
      async (tx, p) => {
        this.#canList(caller, p);
        const row = await tx.db
          .selectFrom('integrations.webhook_delivery')
          .select(['id', 'public_id'])
          .where('public_id', '=', id)
          .executeTakeFirst();
        if (!row) throw new TenancyError('not_found');
        await tx.db
          .updateTable('integrations.webhook_delivery')
          .set({
            state: 'pending',
            attempt: 0,
            next_attempt_at: new Date(),
            claimed_until: null,
            detail: 'replay',
            updated_at: new Date(),
          })
          .where('id', '=', row.id)
          .execute();
        return {
          status: 202,
          ref: { id: row.public_id, type: 'webhook_delivery' },
          data: {
            id: row.public_id,
            type: 'webhook_delivery' as const,
            version: 1,
            state: 'pending',
          },
        };
      },
      async (_tx, _p, ref) => ({
        id: ref.id,
        type: 'webhook_delivery' as const,
        version: 1,
        state: 'pending',
      }),
    );
  }

  async testSubscription(caller: Caller, ws: unknown, id: string, req: Mutation) {
    return this.mutate(
      caller,
      'webhook_subscription.test',
      ws,
      req,
      async (tx, p) => {
        this.#canList(caller, p);
        this.requireWorkspace(p, 'webhook.test_send');
        const sub = await this.#subscription(tx, p, id);
        const eventId = newPublicId('evt');
        const publicId = newPublicId('whd');
        await tx.db
          .insertInto('integrations.webhook_delivery')
          .values({
            id: newUuidV7(),
            workspace_id: tx.workspaceId,
            subscription_id: sub.id,
            public_id: publicId,
            event_public_id: eventId,
            event_type: 'webhook.test',
            facts: JSON.stringify({}) as never,
            state: 'pending',
            next_attempt_at: new Date(),
          })
          .execute();
        return {
          status: 202,
          ref: { id: publicId, type: 'webhook_delivery' },
          data: {
            id: publicId,
            type: 'webhook_delivery' as const,
            version: 1,
            state: 'pending',
            event_id: eventId,
          },
        };
      },
      async (_tx, _p, ref) => ({
        id: ref.id,
        type: 'webhook_delivery' as const,
        version: 1,
        state: 'pending',
      }),
    );
  }

  async projectForWorkspace(workspaceId: string, event: InternalEvent): Promise<number> {
    return this.d.tenant.withWorkspace(workspaceId, { module: 'integrations' }, (tx) =>
      this.projectWebhook(tx, event),
    );
  }

  /** Projects one internal event into pending deliveries for matching subscriptions. */
  async projectWebhook(tx: WorkspaceTransaction, event: InternalEvent): Promise<number> {
    const name = PUBLIC_WEBHOOKS[event.type];
    if (!name) return 0;
    const subs = await tx.db
      .selectFrom('integrations.webhook_subscription')
      .select(['id', 'brand_id', 'event_types'])
      .where('state', '=', 'active')
      .where('lifecycle_state', '=', 'active')
      .execute();
    const facts = publicFacts(event.data as Record<string, unknown>);
    let n = 0;
    for (const sub of subs) {
      if (!sub.event_types.includes(name)) continue;
      if (sub.brand_id && event.brand_id && sub.brand_id !== event.brand_id) continue;
      await tx.db
        .insertInto('integrations.webhook_delivery')
        .values({
          id: newUuidV7(),
          workspace_id: tx.workspaceId,
          subscription_id: sub.id,
          public_id: newPublicId('whd'),
          event_public_id: newPublicId('evt'),
          event_type: name,
          aggregate_id: event.aggregate.id,
          facts: JSON.stringify(facts) as never,
          state: 'pending',
          next_attempt_at: new Date(),
        })
        .execute();
      n += 1;
    }
    return n;
  }

  async sweepWorkspace(workspaceId: string, now = new Date()): Promise<void> {
    await this.runWebhookSweep(this.d.tenant, workspaceId, now);
  }

  async runWebhookSweep(
    tenant: TenantDatabase,
    workspaceId: string,
    now = new Date(),
  ): Promise<void> {
    await tenant.withWorkspace(workspaceId, { module: 'integrations' }, async (tx) => {
      const due = await tx.db
        .selectFrom('integrations.webhook_delivery')
        .select(['id'])
        .where('state', 'in', ['pending', 'retry_scheduled', 'unknown'])
        .where((eb) => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now)]))
        .where((eb) => eb.or([eb('claimed_until', 'is', null), eb('claimed_until', '<=', now)]))
        .orderBy('created_at')
        .limit(this.ws.webhookSweepBatchMax)
        .execute();
      for (const row of due) await this.#deliverOne(tx, row.id, now);
      const cutoff = new Date(now.getTime() - this.ws.webhookDeliveryRetentionDays * 86_400_000);
      await tx.db
        .deleteFrom('integrations.webhook_delivery')
        .where('created_at', '<', cutoff)
        .execute();
    });
  }

  async createInbound(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const brandRef = isObj(body) && typeof body.brand === 'string' ? body.brand : null;
    type InboundView = {
      id: string;
      type: 'inbound_endpoint';
      version: number;
      action: string;
      path_token?: string;
      secret?: string;
    };
    return this.mutate<InboundView>(
      caller,
      'inbound_endpoint.create',
      ws,
      req,
      async (tx, p) => {
        const brand = await this.#webhookBrand(tx, caller, p, brandRef);
        const count = await tx.db
          .selectFrom('integrations.inbound_endpoint')
          .select(sql<number>`count(*)::int`.as('n'))
          .executeTakeFirstOrThrow();
        if (Number(count.n) >= this.ws.webhookInboundMax) {
          throw invalid(
            issue(
              '/action',
              'too_many',
              'This workspace has the maximum number of inbound endpoints.',
            ),
          );
        }
        const minted = newHookSecret();
        const secret = newApiSecret().secret;
        const ref = await this.#putSecret(tx, 'webhook_in', secret);
        const publicId = newPublicId('whk');
        await tx.db
          .insertInto('integrations.inbound_endpoint')
          .values({
            id: newUuidV7(),
            workspace_id: tx.workspaceId,
            brand_id: brand?.id ?? null,
            public_id: publicId,
            path_prefix: minted.prefix,
            path_hash: tokenHash(minted.token),
            action: 'capture.task',
            signing_secret_ref: ref,
            state: 'active',
            accountable_owner_membership_id: p.membershipId,
            created_by_membership_id: p.membershipId,
          })
          .execute();
        return {
          status: 201,
          ref: { id: publicId, type: 'inbound_endpoint' },
          data: {
            id: publicId,
            type: 'inbound_endpoint' as const,
            version: 0,
            path_token: minted.token,
            secret,
            action: 'capture.task' as const,
          },
        };
      },
      async (tx, _p, ref) => {
        const row = await tx.db
          .selectFrom('integrations.inbound_endpoint')
          .select(['public_id', 'version', 'action'])
          .where('public_id', '=', ref.id)
          .executeTakeFirst();
        if (!row) throw new TenancyError('not_found');
        return {
          id: row.public_id,
          type: 'inbound_endpoint' as const,
          version: Number(row.version),
          action: row.action,
        };
      },
    );
  }

  /**
   * Verifies a signed inbound webhook before any tenant detail is returned. Unknown endpoints,
   * bad signatures, and stale timestamps all answer the same way.
   */
  async receiveInbound(
    pathToken: string,
    header: { signature?: string; timestamp?: string; contentType?: string },
    raw: string,
    meta: { requestId?: string; correlationId: string },
  ): Promise<'accepted' | 'unauthenticated'> {
    if (raw.length > this.ws.webhookBodyMaxBytes) return 'unauthenticated';
    if (header.contentType && !header.contentType.startsWith('application/json'))
      return 'unauthenticated';
    if (!pathToken.startsWith('hk_') || pathToken.length < 20) return 'unauthenticated';
    const prefix = pathToken.slice(0, 11);
    const found = await this.d.platform.withPlatform(
      { module: 'integrations', readOnly: true },
      async (tx) => {
        const res = await sql<{
          workspace_id: string;
          endpoint_id: string;
          brand_id: string | null;
          signing_secret_ref: string;
          previous_secret_ref: string | null;
          previous_secret_until: Date | null;
          membership_id: string;
          account_id: string;
          state: string;
        }>`SELECT workspace_id, endpoint_id, brand_id, signing_secret_ref, previous_secret_ref,
                previous_secret_until, membership_id, account_id, state
           FROM integrations.resolve_inbound_endpoint(${prefix}, ${tokenHash(pathToken)})`.execute(
          tx.db,
        );
        return res.rows[0] ?? null;
      },
    );
    if (!found || found.state !== 'active') {
      this.d.metrics.count('webhook.inbound.rejected', 1, { reason: 'unauthenticated' });
      return 'unauthenticated';
    }
    const ts = header.timestamp ?? '';
    const skew = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(skew) || skew > this.ws.webhookTimestampToleranceSeconds) {
      this.d.metrics.count('webhook.inbound.rejected', 1, { reason: 'unauthenticated' });
      return 'unauthenticated';
    }
    return this.d.tenant.withWorkspace(
      found.workspace_id,
      { module: 'integrations' },
      async (tx) => {
        const secrets = await this.#secrets(
          tx,
          found.signing_secret_ref,
          found.previous_secret_ref,
          found.previous_secret_until,
        );
        if (!signaturesMatch(secrets, pathToken, ts, raw, header.signature ?? '')) {
          this.d.metrics.count('webhook.inbound.rejected', 1, { reason: 'unauthenticated' });
          return 'unauthenticated' as const;
        }
        let parsed: Record<string, unknown>;
        try {
          const value = JSON.parse(raw) as unknown;
          if (!isObj(value)) throw new Error('shape');
          parsed = value;
        } catch {
          await this.#message(tx, found.endpoint_id, `bad:${ts}`, 'schema');
          return 'accepted' as const;
        }
        const eventId = typeof parsed.event_id === 'string' ? parsed.event_id.slice(0, 200) : '';
        if (!eventId) {
          await this.#message(tx, found.endpoint_id, `missing:${ts}:${raw.length}`, 'schema');
          return 'accepted' as const;
        }
        const inserted = await tx.db
          .insertInto('integrations.inbound_message')
          .values({
            id: newUuidV7(),
            workspace_id: tx.workspaceId,
            endpoint_id: found.endpoint_id,
            provider_event_id: eventId,
            state: 'accepted',
          })
          .onConflict((oc) => oc.columns(['endpoint_id', 'provider_event_id']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!inserted) return 'accepted' as const;
        const data = isObj(parsed.data) ? parsed.data : null;
        const text = data && typeof data.text === 'string' ? data.text.trim() : '';
        if (parsed.type !== 'task.capture' || !text || text.length > this.ws.captureTextMax) {
          await tx.db
            .updateTable('integrations.inbound_message')
            .set({ state: 'quarantined', detail: 'schema' })
            .where('id', '=', inserted.id)
            .execute();
          return 'accepted' as const;
        }
        const caller = syntheticCaller(
          found.account_id,
          {
            tokenId: found.endpoint_id,
            tokenPublicId: prefix,
            kind: 'inbound',
            principalType: 'inbound_webhook',
            scopes: ['capture:write'],
            brandIds: found.brand_id ? [found.brand_id] : null,
            membershipId: found.membership_id,
            accountId: found.account_id,
            sourceKind: 'webhook',
          },
          meta,
        );
        let brandPublic: string | null = null;
        if (found.brand_id) {
          brandPublic =
            (
              await tx.db
                .selectFrom('core.record')
                .select('public_id')
                .where('id', '=', found.brand_id)
                .executeTakeFirst()
            )?.public_id ?? null;
        }
        if (data && typeof data.brand === 'string' && brandPublic && data.brand !== brandPublic) {
          await tx.db
            .updateTable('integrations.inbound_message')
            .set({ state: 'quarantined', detail: 'brand_mismatch' })
            .where('id', '=', inserted.id)
            .execute();
          return 'accepted' as const;
        }
        const ws = await tx.db
          .selectFrom('tenancy.workspace')
          .select('public_id')
          .where('id', '=', tx.workspaceId)
          .executeTakeFirstOrThrow();
        try {
          await this.capture(
            caller,
            ws.public_id,
            { intent: 'task', text, ...(brandPublic ? { brand: brandPublic } : {}) },
            {
              idempotencyKey: `webhook.${eventId}`.slice(0, 128).padEnd(16, '0'),
              fingerprint: tokenHash(raw),
            },
          );
          await tx.db
            .updateTable('integrations.inbound_message')
            .set({ state: 'processed' })
            .where('id', '=', inserted.id)
            .execute();
        } catch {
          await tx.db
            .updateTable('integrations.inbound_message')
            .set({ state: 'rejected', detail: 'capture_failed' })
            .where('id', '=', inserted.id)
            .execute();
        }
        return 'accepted' as const;
      },
    );
  }

  async #deliverOne(tx: WorkspaceTransaction, id: string, now: Date): Promise<void> {
    const row = await tx.db
      .selectFrom('integrations.webhook_delivery as d')
      .innerJoin('integrations.webhook_subscription as s', 's.id', 'd.subscription_id')
      .innerJoin('core.record as r', 'r.id', 's.id')
      .select([
        'd.id',
        'd.event_public_id',
        'd.event_type',
        'd.attempt',
        'd.facts',
        'd.aggregate_id',
        's.id as subscription_id',
        's.destination_url',
        's.state as subscription_state',
        's.signing_secret_ref',
        's.previous_secret_ref',
        's.previous_secret_until',
        's.consecutive_failures',
        's.accountable_owner_membership_id',
        'r.public_id as subscription_public_id',
        'r.version as record_version',
      ])
      .where('d.id', '=', id)
      .executeTakeFirst();
    if (!row || row.subscription_state !== 'active') return;
    const host = new URL(row.destination_url).host;
    const inflight = await tx.db
      .selectFrom('integrations.webhook_delivery as d')
      .innerJoin('integrations.webhook_subscription as s', 's.id', 'd.subscription_id')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('s.destination_url', 'like', `%://${host}%`)
      .where('d.claimed_until', '>', now)
      .executeTakeFirst();
    if (Number(inflight?.n ?? 0) >= this.ws.webhookConcurrencyPerDestination) {
      await tx.db
        .updateTable('integrations.webhook_delivery')
        .set({ state: 'retry_scheduled', next_attempt_at: new Date(now.getTime() + 1000) })
        .where('id', '=', id)
        .execute();
      return;
    }
    await tx.db
      .updateTable('integrations.webhook_delivery')
      .set({ claimed_until: new Date(now.getTime() + this.ws.webhookResponseTimeoutMs) })
      .where('id', '=', id)
      .execute();
    const owner = await tx.db
      .selectFrom('tenancy.membership')
      .select(['id', 'account_id', 'state'])
      .where('id', '=', row.accountable_owner_membership_id)
      .executeTakeFirst();
    if (!owner || owner.state !== 'active') {
      await this.#finish(tx, row, 'failed', null, null, 'owner_departed', false);
      return;
    }
    if (row.aggregate_id) {
      const principal = await loadPrincipal(tx, owner.account_id, owner.id);
      const visible = await tx.db
        .selectFrom('core.record')
        .select(['brand_id', 'lifecycle_state'])
        .where('id', '=', row.aggregate_id)
        .executeTakeFirst();
      if (visible?.brand_id && visible.lifecycle_state !== 'purged') {
        const brand = await tx.db
          .selectFrom('tenancy.brand')
          .select(['id', 'is_sensitive', 'lifecycle_state'])
          .where('id', '=', visible.brand_id)
          .executeTakeFirst();
        if (
          brand &&
          brandLevel(principal, {
            id: brand.id,
            isSensitive: brand.is_sensitive,
            lifecycleState: brand.lifecycle_state,
          }) === null
        ) {
          await this.#finish(tx, row, 'failed', null, null, 'owner_cannot_read', false);
          return;
        }
      }
    }
    const secrets = await this.#secrets(
      tx,
      row.signing_secret_ref,
      row.previous_secret_ref,
      row.previous_secret_until,
    );
    const ws = await tx.db
      .selectFrom('tenancy.workspace')
      .select('public_id')
      .where('id', '=', tx.workspaceId)
      .executeTakeFirstOrThrow();
    const envelope: OutboundEnvelope = {
      id: row.event_public_id,
      type: row.event_type,
      api_version: 'v1',
      created_at: now.toISOString(),
      workspace: { id: ws.public_id },
      data: {
        object: {
          id: row.subscription_public_id,
          type: row.event_type,
          version: Number(row.record_version),
        },
        fields: (typeof row.facts === 'string' ? JSON.parse(row.facts) : row.facts) as Record<
          string,
          string | number | boolean | null
        >,
        changes: [],
      },
    };
    const body = JSON.stringify(envelope);
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const signatures = secrets.map((s) => signPayload(s, row.event_public_id, timestamp, body));
    const started = Date.now();
    let result: WebhookTransportResult;
    try {
      await assertPublicHttps(row.destination_url, this.ws.webhookAllowLoopback);
      result = await this.#deliver({
        url: row.destination_url,
        body,
        timeoutMs: this.ws.webhookResponseTimeoutMs,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'pm-webhooks/1',
          'webhook-id': row.event_public_id,
          'webhook-timestamp': timestamp,
          'webhook-signature': signatureHeader(signatures),
        },
      });
    } catch {
      result = { kind: 'network' };
    }
    const duration = Date.now() - started;
    this.d.metrics.record('webhook.delivery.duration', duration, {
      outcome: result.kind === 'status' ? 'status' : result.kind,
    });
    if (result.kind === 'status' && result.status >= 200 && result.status < 300) {
      await this.#finish(tx, row, 'delivered', result.status, duration, null, true);
      this.d.metrics.count('webhook.deliveries', 1, { outcome: 'delivered', status_class: '2xx' });
      return;
    }
    const retry = result.kind !== 'status' || retryableStatus(result.status);
    const attempt = row.attempt + 1;
    if (!retry || attempt >= this.ws.webhookMaxAttempts) {
      await this.#finish(
        tx,
        row,
        'failed',
        result.kind === 'status' ? result.status : null,
        duration,
        result.kind,
        false,
      );
      await this.#maybeDisable(tx, row);
      return;
    }
    await tx.db
      .updateTable('integrations.webhook_delivery')
      .set({
        state: result.kind === 'network' ? 'unknown' : 'retry_scheduled',
        attempt,
        response_status: result.kind === 'status' ? result.status : null,
        duration_ms: duration,
        next_attempt_at: new Date(Date.now() + webhookDelayMs(attempt, 1000, 60_000)),
        claimed_until: null,
        updated_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
    this.d.metrics.count('webhook.deliveries', 1, { outcome: 'retry', status_class: result.kind });
  }

  async #finish(
    tx: WorkspaceTransaction,
    row: { id: string; subscription_id: string },
    state: 'delivered' | 'failed',
    status: number | null,
    duration: number | null,
    detail: string | null,
    resetFailures: boolean,
  ) {
    await tx.db
      .updateTable('integrations.webhook_delivery')
      .set({
        state,
        response_status: status,
        duration_ms: duration,
        detail,
        claimed_until: null,
        next_attempt_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
    await tx.db
      .updateTable('integrations.webhook_subscription')
      .set({ consecutive_failures: resetFailures ? 0 : (sql`consecutive_failures + 1` as never) })
      .where('id', '=', row.subscription_id)
      .execute();
  }

  async #maybeDisable(
    tx: WorkspaceTransaction,
    row: { subscription_id: string; consecutive_failures: number; subscription_public_id: string },
  ) {
    if (row.consecutive_failures + 1 < this.ws.webhookDisableThreshold) return;
    await tx.db
      .updateTable('integrations.webhook_subscription')
      .set({ state: 'disabled_endpoint', updated_at: new Date() })
      .where('id', '=', row.subscription_id)
      .execute();
    await writeOutboxEvent(tx, {
      type: 'integrations.webhook.delivery_failed',
      aggregate: {
        type: 'integrations.webhook_delivery',
        id: row.subscription_id,
        sequence: row.consecutive_failures + 1,
      },
      data: { subscription_id: row.subscription_public_id, attempt: row.consecutive_failures + 1 },
      actor: { type: 'system' },
      context: {
        workspaceId: tx.workspaceId,
        correlationId: '0'.repeat(32),
        authenticatedPrincipal: { type: 'system_job', id: row.subscription_id },
        effectivePrincipal: { type: 'system_job', id: row.subscription_id },
        delegationChain: [{ type: 'system_job', id: row.subscription_id }],
        epochs: { workspace: 0, principal: 0 },
        dataClassLimit: 'C1',
      },
    });
    this.d.metrics.count('webhook.endpoints_disabled', 1, {});
  }

  async #secrets(
    tx: WorkspaceTransaction,
    current: string,
    previous: string | null,
    until: Date | null,
  ): Promise<string[]> {
    if (!this.#vault) return [];
    const secrets: string[] = [];
    const a = await this.#vault.get(current, { scope: tx });
    if (a) secrets.push(a);
    if (previous && until && until.getTime() > Date.now()) {
      const b = await this.#vault.get(previous, { scope: tx });
      if (b) secrets.push(b);
    }
    return secrets;
  }

  async #putSecret(tx: WorkspaceTransaction, purpose: string, secret: string): Promise<string> {
    if (!this.#vault) throw new TenancyError('dependency_unavailable');
    return this.#vault.put(purpose, secret, { scope: tx });
  }

  #canList(caller: Caller, p: Principal) {
    if (caller.delegation && !scopeAllows(caller.delegation.scopes, 'webhooks:manage'))
      throw new TenancyError('forbidden');
    if (!decideWorkspace(p, 'webhooks.manage').allowed) throw new TenancyError('forbidden');
  }

  async #webhookBrand(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    brand: string | null,
  ) {
    if (caller.delegation && !scopeAllows(caller.delegation.scopes, 'webhooks:manage'))
      throw new TenancyError('forbidden');
    if (!brand) {
      this.requireWorkspace(p, 'webhooks.manage');
      return null;
    }
    const row = await findBrand(tx, p, brand);
    if (
      !decideBrand(p, 'webhooks.manage', {
        id: row.id,
        isSensitive: row.is_sensitive,
        lifecycleState: 'active',
      }).allowed
    )
      throw new TenancyError('not_found');
    return row;
  }

  async #subscription(tx: WorkspaceTransaction, _p: Principal, publicId: string) {
    const row = await tx.db
      .selectFrom('integrations.webhook_subscription as s')
      .innerJoin('core.record as r', 'r.id', 's.id')
      .select([
        's.id',
        'r.public_id as publicId',
        's.destination_url',
        's.event_types',
        's.version',
        's.signing_secret_ref',
      ])
      .where('r.public_id', '=', publicId)
      .executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    return row;
  }

  async #subscriptionRoom(tx: WorkspaceTransaction, brandId: string | null) {
    const n = await tx.db
      .selectFrom('integrations.webhook_subscription')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('brand_id', brandId === null ? 'is' : '=', brandId)
      .executeTakeFirstOrThrow();
    if (Number(n.n) >= this.ws.webhookSubscriptionsMax) {
      throw invalid(
        issue('/destination_url', 'too_many', 'This scope has the maximum number of webhooks.'),
      );
    }
  }

  async #subscriptionInput(
    body: unknown,
  ): Promise<{ url: string; events: string[]; brand: string | null }> {
    if (
      !isObj(body) ||
      typeof body.destination_url !== 'string' ||
      !Array.isArray(body.event_types)
    )
      throw invalid(issue('/destination_url', 'required', 'Name the destination and the events.'));
    const events = body.event_types.filter((e): e is string => typeof e === 'string');
    if (!events.length || events.length > this.ws.webhookEventTypesMax)
      throw invalid(issue('/event_types', 'too_many', 'Choose at least one public event.'));
    if (events.some((e) => e !== 'webhook.test' && !PUBLIC_WEBHOOK_NAMES.has(e)))
      throw invalid(issue('/event_types', 'invalid_option', 'Choose a public webhook event.'));
    try {
      await assertPublicHttps(body.destination_url, this.ws.webhookAllowLoopback);
    } catch (err) {
      const code = (err as Error).message === 'private_address' ? 'private_address' : 'invalid_url';
      throw invalid(issue('/destination_url', code, 'Use a public https address.'));
    }
    return {
      url: body.destination_url,
      events,
      brand: typeof body.brand === 'string' ? body.brand : null,
    };
  }

  #subJson(
    id: string,
    input: { url: string; events: string[] },
    secret: string | null,
    version: number,
  ) {
    return {
      id,
      type: 'webhook_subscription' as const,
      version,
      destination_url: input.url,
      event_types: input.events,
      api_version: API_VERSION,
      ...(secret ? { secret } : {}),
    };
  }

  #tokenInput(body: unknown) {
    if (!isObj(body) || typeof body.name !== 'string')
      throw invalid(issue('/name', 'required', 'Name this token.'));
    const kind = body.kind === 'service' ? 'service' : 'personal';
    const allowed = kind === 'service' ? SERVICE_SCOPES : PERSONAL_SCOPES;
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((s): s is string => typeof s === 'string')
      : [];
    if (!scopes.length || scopes.some((s) => !(allowed as readonly string[]).includes(s)))
      throw invalid(
        issue('/scopes', 'invalid_option', 'Choose scopes this token is allowed to hold.'),
      );
    const brands = Array.isArray(body.brands)
      ? body.brands.filter((s): s is string => typeof s === 'string')
      : null;
    let expires: Date | null = null;
    if (typeof body.expires_at === 'string') {
      expires = new Date(body.expires_at);
      if (Number.isNaN(expires.getTime()))
        throw invalid(issue('/expires_at', 'invalid_date', 'Use a time.'));
    }
    if (kind === 'service' && !expires)
      throw invalid(issue('/expires_at', 'required', 'A service token needs an expiry.'));
    return { kind, name: body.name.trim(), scopes, brands, expires };
  }

  #tokenPolicy(p: Principal, input: { scopes: string[]; expires: Date | null }) {
    if (p.kind === 'guest') throw new TenancyError('forbidden');
    if (p.role === 'limited_member' && !p.policy.limited_members_tokens)
      throw new TenancyError('forbidden');
    if (p.role === 'read_only' && input.scopes.some((s) => !READ_SCOPES.has(s)))
      throw invalid(
        issue('/scopes', 'invalid_option', 'A read-only member can only create read scopes.'),
      );
    const cap = lifetimeMs(p.policy.token_max_lifetime);
    if (cap !== null && input.expires && input.expires.getTime() - Date.now() > cap)
      throw invalid(
        issue('/expires_at', 'too_far', 'That expiry is longer than this workspace allows.'),
      );
  }

  async #tokenRoom(tx: WorkspaceTransaction, p: Principal, kind: string) {
    const n = await tx.db
      .selectFrom('integrations.api_token')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('kind', '=', kind as 'personal' | 'service')
      .where('accountable_owner_membership_id', '=', p.membershipId)
      .where('state', '=', 'active')
      .executeTakeFirstOrThrow();
    const max = kind === 'service' ? this.ws.apiTokensServiceMax : this.ws.apiTokensPersonalMax;
    if (Number(n.n) >= max)
      throw invalid(issue('/name', 'too_many', 'Retire a token before creating another.'));
  }

  async #insertToken(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    input: {
      kind: string;
      name: string;
      scopes: string[];
      brands: string[] | null;
      expires: Date | null;
    },
  ) {
    const minted = newApiSecret();
    const id = newUuidV7();
    const publicId = newPublicId('tok');
    let brandIds: string[] | null = null;
    if (input.brands?.length) {
      brandIds = [];
      for (const b of input.brands) brandIds.push((await findBrand(tx, p, b)).id);
    }
    await tx.db
      .insertInto('integrations.api_token')
      .values({
        id,
        workspace_id: tx.workspaceId,
        public_id: publicId,
        kind: input.kind as 'personal' | 'service',
        principal_type: input.kind === 'service' ? 'service_principal' : 'membership',
        principal_id: input.kind === 'service' ? id : p.membershipId,
        accountable_owner_membership_id: p.membershipId,
        name: input.name,
        token_prefix: minted.prefix,
        token_hash: tokenHash(minted.secret),
        scopes: input.scopes,
        brand_ids: brandIds,
        expires_at: input.expires,
        state: 'active',
        created_by_membership_id: p.membershipId,
      })
      .execute();
    await this.security(tx, caller, p, 'api_token.created', { type: 'api_token', id });
    return {
      id,
      publicId,
      view: this.#tokenJson(
        {
          public_id: publicId,
          kind: input.kind,
          name: input.name,
          token_prefix: minted.prefix,
          scopes: input.scopes,
          expires_at: input.expires,
          last_used_at: null,
          state: 'active',
          version: 0,
        },
        minted.secret,
      ),
    };
  }

  async #tokenView(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: string,
    secret: string | null,
  ) {
    return this.#tokenJson(await this.#ownToken(tx, p, publicId), secret);
  }

  async #ownToken(tx: WorkspaceTransaction, p: Principal, publicId: string) {
    const row = await tx.db
      .selectFrom('integrations.api_token')
      .select([
        'id',
        'public_id',
        'kind',
        'name',
        'token_prefix',
        'scopes',
        'expires_at',
        'last_used_at',
        'state',
        'version',
        'accountable_owner_membership_id',
      ])
      .where('public_id', '=', publicId)
      .executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    const serviceAdmin =
      row.kind === 'service' && (p.role === 'owner' || p.role === 'administrator');
    if (row.accountable_owner_membership_id !== p.membershipId && !serviceAdmin)
      throw new TenancyError('not_found');
    return row;
  }

  #tokenJson(
    row: {
      public_id: string;
      kind: string;
      name: string;
      token_prefix: string;
      scopes: string[];
      expires_at: Date | null;
      last_used_at: Date | null;
      state: string;
      version: number | string;
    },
    secret: string | null,
  ) {
    return {
      id: row.public_id,
      type: 'api_token' as const,
      version: Number(row.version),
      kind: row.kind,
      name: row.name,
      token_prefix: row.token_prefix,
      scopes: row.scopes,
      expires_at: row.expires_at?.toISOString() ?? null,
      last_used_at: row.last_used_at?.toISOString() ?? null,
      state: row.state,
      ...(secret ? { secret } : {}),
    };
  }

  async #message(tx: WorkspaceTransaction, endpointId: string, eventId: string, detail: string) {
    await tx.db
      .insertInto('integrations.inbound_message')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        endpoint_id: endpointId,
        provider_event_id: eventId.slice(0, 200),
        state: 'quarantined',
        detail,
      })
      .onConflict((oc) => oc.columns(['endpoint_id', 'provider_event_id']).doNothing())
      .execute();
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lifetimeMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && v && 'days' in v) {
    const o = v as { days?: number; hours?: number; minutes?: number; seconds?: number };
    return (
      (((o.days ?? 0) * 24 + (o.hours ?? 0)) * 60 + (o.minutes ?? 0)) * 60_000 +
      (o.seconds ?? 0) * 1000
    );
  }
  if (typeof v === 'string') {
    const days = /^(\d+)\s+day/.exec(v);
    if (days) return Number(days[1]) * 86_400_000;
  }
  return null;
}

export function syntheticCaller(
  accountId: string,
  delegation: TokenDelegation,
  meta: { requestId?: string; correlationId: string },
): Caller {
  const auth: AuthContext = {
    principal: 'account',
    account: {
      id: accountId,
      publicId: 'acc_00000000000000000000000000',
      email: 'token@invalid',
      displayName: 'API token',
      locale: 'en',
      timezone: 'UTC',
      emailVerified: true,
    },
    session: {
      id: delegation.tokenId,
      publicId: delegation.tokenPublicId,
      assurance: 'single_factor',
      authMethods: [],
      createdAt: new Date(),
      idleExpiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 60_000),
      mfaVerifiedAt: null,
    },
  };
  return {
    auth,
    delegation,
    meta: {
      correlationId: meta.correlationId,
      ...(meta.requestId ? { requestId: meta.requestId } : {}),
    },
  };
}
