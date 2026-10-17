import { createHash } from 'node:crypto';
import { change } from '@pm/audit';
import type { SecretVault } from '@pm/config';
import { API_VERSION, newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type TenantDatabase, type WorkspaceTransaction } from '@pm/db';
import type { AuthContext } from '@pm/identity';
import { writeOutboxEvent, type InternalEvent } from '@pm/platform';
import {
  brandFacts,
  brandLevel,
  compileVisibility,
  decideBrand,
  decideWorkspace,
  findBrand,
  invalid,
  issue,
  loadPrincipal,
  parseIfMatch,
  TenancyError,
  type BrandFacts,
  type Caller,
  type Mutation,
  type Principal,
  type TokenDelegation,
} from '@pm/tenancy';
import { IntegrationService } from './service.ts';
import { WEBHOOK_TOMBSTONES, webhookSource } from './webhook-sources.ts';
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
export class PublicApiService extends IntegrationService {
  readonly #deliver: WebhookTransport;

  constructor(
    deps: ConstructorParameters<typeof IntegrationService>[0] & {
      vault?: SecretVault | null;
      deliver?: WebhookTransport;
    },
  ) {
    if (!deps.vault) throw new Error('Secret vault is required for integrations');
    super({ ...deps, vault: deps.vault });
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
        const row = await this.#renderSubscription(tx, caller, p, ref.id);
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
      this.#delegated(caller);
      // Someone who manages webhooks nowhere is refused, as before; a brand manager lists only
      // the subscriptions they manage.
      if (
        !decideWorkspace(p, 'webhooks.manage').allowed &&
        !(await brandFacts(tx)).some(
          (b) => b.lifecycleState === 'active' && decideBrand(p, 'webhooks.manage', b).allowed,
        )
      )
        throw new TenancyError('forbidden');
      const rows = await tx.db
        .selectFrom('integrations.webhook_subscription as s')
        .innerJoin('core.record as r', 'r.id', 's.id')
        .leftJoin('tenancy.brand as b', 'b.id', 's.brand_id')
        .select([
          'r.public_id as public_id',
          's.destination_url',
          's.event_types',
          's.state',
          's.version',
          's.consecutive_failures',
          's.api_version',
          's.brand_id',
          's.paused_at',
          's.stopped_at',
          's.suspended_reason',
          'b.is_sensitive',
          'b.lifecycle_state as brand_state',
        ])
        .where('s.lifecycle_state', '=', 'active')
        .orderBy('s.created_at', 'desc')
        .limit(this.ws.webhookSubscriptionsMax)
        .execute();
      return {
        subscriptions: rows
          .filter((r) => subscriptionVisible(p, r) && managesSubscription(p, r))
          .map((r) => ({
            id: r.public_id,
            type: 'webhook_subscription' as const,
            version: Number(r.version),
            destination_url: r.destination_url,
            event_types: r.event_types,
            state: r.state,
            api_version: r.api_version,
            consecutive_failures: r.consecutive_failures,
            paused_at: r.paused_at ? new Date(r.paused_at).toISOString() : null,
            stopped_at: r.stopped_at ? new Date(r.stopped_at).toISOString() : null,
            suspended_reason: r.suspended_reason,
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
        this.#delegated(caller);
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
      async (tx, p, ref) => {
        const row = await this.#renderSubscription(tx, caller, p, ref.id);
        // The new secret was shown once; a repeated key never shows it again.
        return {
          id: row.publicId,
          type: 'webhook_subscription' as const,
          version: Number(row.version),
        };
      },
    );
  }

  async listDeliveries(caller: Caller, ws: unknown, id: string) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      this.#delegated(caller);
      const sub = await this.#subscription(tx, p, id);
      const rows = await tx.db
        .selectFrom('integrations.webhook_delivery')
        .select([
          'public_id',
          'event_public_id',
          'event_type',
          'state',
          'attempt',
          'cycle',
          'total_attempts',
          'response_status',
          'duration_ms',
          'next_attempt_at',
          'created_at',
          'event_created_at',
          'replayed_at',
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
          cycle: r.cycle,
          total_attempts: r.total_attempts,
          replayable: REPLAYABLE.has(r.state),
          response_status: r.response_status,
          duration_ms: r.duration_ms,
          next_attempt_at: r.next_attempt_at?.toISOString() ?? null,
          created_at: r.created_at.toISOString(),
          event_created_at: new Date(r.event_created_at).toISOString(),
          replayed_at: r.replayed_at ? new Date(r.replayed_at).toISOString() : null,
          detail: r.detail,
        })),
      };
    });
  }

  /**
   * Replays a dead-lettered delivery (ADR-0037 W3): only `failed` and `disabled_endpoint`
   * deliveries are eligible. The subscription is locked before the delivery (the worker's order),
   * so a replay waits for a send in progress and then re-checks the state it finds. A new cycle
   * starts; lifetime attempts, the event id, its original time, and the last outcome are kept.
   */
  async replayDelivery(caller: Caller, ws: unknown, id: string, req: Mutation) {
    return this.mutate(
      caller,
      'webhook_delivery.replay',
      ws,
      req,
      async (tx, p) => {
        this.#delegated(caller);
        const ref = await tx.db
          .selectFrom('integrations.webhook_delivery')
          .select(['id', 'subscription_id'])
          .where('public_id', '=', id)
          .executeTakeFirst();
        if (!ref) throw new TenancyError('not_found');
        await this.#waitForSend(tx);
        const sub = await this.#lockSubscription(tx, ref.subscription_id, 'share');
        if (!sub || !subscriptionVisible(p, sub)) throw new TenancyError('not_found');
        this.#requireManager(p, sub);
        const row = await tx.db
          .selectFrom('integrations.webhook_delivery')
          .selectAll()
          .where('id', '=', ref.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (!REPLAYABLE.has(row.state) || row.object_kind === 'synthetic')
          throw notReplayable('Only a delivery that failed or was dead-lettered can be retried.');
        if (row.claimed_until && new Date(row.claimed_until) > new Date())
          throw notReplayable('This delivery is being sent now.');
        if (sub.state !== 'active' || sub.lifecycle_state !== 'active')
          throw notReplayable('Resume this endpoint before retrying its deliveries.');
        if (row.cycle >= 100) throw notReplayable('This delivery has been retried too many times.');
        const gate = await this.#deliveryGate(tx, sub, row);
        if (!gate.ok) throw notReplayable('This event can no longer be sent from this endpoint.');
        const now = new Date();
        await tx.db
          .updateTable('integrations.webhook_delivery')
          .set({
            state: 'pending',
            cycle: row.cycle + 1,
            attempt: 0,
            next_attempt_at: now,
            replayed_at: now,
            replayed_by_membership_id: p.membershipId,
            updated_at: now,
          })
          .where('id', '=', row.id)
          .where('state', '=', row.state)
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'webhook_delivery.replayed',
          { recordId: sub.id, type: 'webhook_subscription', publicId: sub.public_id },
          [
            change.plain('delivery_state', row.state, 'pending'),
            change.plain('cycle', String(row.cycle), String(row.cycle + 1)),
            change.plain('total_attempts', null, String(row.total_attempts)),
          ],
          sub.brand_id,
        );
        return {
          status: 202,
          ref: { id: row.public_id, type: 'webhook_delivery' },
          data: {
            id: row.public_id,
            type: 'webhook_delivery' as const,
            version: row.cycle + 1,
            state: 'pending',
            cycle: row.cycle + 1,
            total_attempts: row.total_attempts,
          },
        };
      },
      async (tx, p, ref) => {
        const row = await this.#renderDelivery(tx, caller, p, ref.id);
        return {
          id: row.public_id,
          type: 'webhook_delivery' as const,
          version: row.cycle,
          state: row.state,
          cycle: row.cycle,
          total_attempts: row.total_attempts,
        };
      },
    );
  }

  /**
   * Pauses a subscription (ADR-0037 W4): no event is projected and no queued delivery is sent
   * after this commits. A send already handed to the network cannot be recalled; the pause waits
   * for it (the worker holds the subscription while sending) and records it as it ends. Queued
   * deliveries are recorded as skipped, not kept as a backlog. History stays.
   */
  async pauseSubscription(caller: Caller, ws: unknown, id: string, req: Mutation) {
    return this.mutate(
      caller,
      'webhook_subscription.pause',
      ws,
      req,
      async (tx, p) => {
        this.#delegated(caller);
        const expected = parseIfMatch(req.ifMatch);
        const found = await this.#subscription(tx, p, id);
        await this.#waitForSend(tx);
        const sub = (await this.#lockSubscription(tx, found.id, 'update'))!;
        this.#requireManager(p, sub);
        if (Number(sub.version) !== expected)
          throw new TenancyError('conflict', {
            issues: [issue('/version', 'version_conflict', 'This endpoint changed. Reload it.')],
          });
        if (sub.state === 'suspended')
          throw new TenancyError('conflict', {
            issues: [
              issue('/state', 'suspended', 'This endpoint is suspended; its owner lost access.'),
            ],
          });
        if (sub.state !== 'paused') {
          const now = new Date();
          await tx.db
            .updateTable('integrations.webhook_subscription')
            .set({
              state: 'paused',
              paused_at: now,
              paused_by_membership_id: p.membershipId,
              stopped_at: sub.stopped_at ?? now,
              version: Number(sub.version) + 1,
              updated_at: now,
              updated_by_membership_id: p.membershipId,
            })
            .where('id', '=', sub.id)
            .execute();
          const skipped = await tx.db
            .updateTable('integrations.webhook_delivery')
            .set({ state: 'skipped', detail: 'paused', next_attempt_at: null, updated_at: now })
            .where('subscription_id', '=', sub.id)
            .where('state', 'in', ['pending', 'retry_scheduled', 'unknown'])
            .where('object_kind', '<>', 'synthetic')
            .executeTakeFirst();
          await this.workAudit(
            tx,
            caller,
            p,
            'webhook_subscription.paused',
            { recordId: sub.id, type: 'webhook_subscription', publicId: sub.public_id },
            [
              change.plain('state', sub.state, 'paused'),
              change.plain('skipped_deliveries', null, String(Number(skipped.numUpdatedRows))),
            ],
            sub.brand_id,
          );
        }
        return {
          status: 200,
          ref: { id: sub.public_id, type: 'webhook_subscription' },
          data: await this.#subState(tx, sub.id),
        };
      },
      async (tx, p, ref) =>
        this.#subState(tx, (await this.#renderSubscription(tx, caller, p, ref.id)).id),
    );
  }

  /**
   * Resumes a paused or automatically disabled subscription (ADR-0037 W5) after a test event,
   * sent after it stopped, was delivered (0D §9.1). Nothing queued before the stop is replayed.
   */
  async resumeSubscription(caller: Caller, ws: unknown, id: string, req: Mutation) {
    return this.mutate(
      caller,
      'webhook_subscription.resume',
      ws,
      req,
      async (tx, p) => {
        this.#delegated(caller);
        const expected = parseIfMatch(req.ifMatch);
        const found = await this.#subscription(tx, p, id);
        await this.#waitForSend(tx);
        const sub = (await this.#lockSubscription(tx, found.id, 'update'))!;
        this.#requireManager(p, sub);
        if (Number(sub.version) !== expected)
          throw new TenancyError('conflict', {
            issues: [issue('/version', 'version_conflict', 'This endpoint changed. Reload it.')],
          });
        if (sub.state === 'active')
          return {
            status: 200,
            ref: { id: sub.public_id, type: 'webhook_subscription' },
            data: await this.#subState(tx, sub.id),
          };
        if (sub.state !== 'paused' && sub.state !== 'disabled_endpoint')
          throw new TenancyError('conflict', {
            issues: [
              issue('/state', 'suspended', 'This endpoint is suspended; its owner lost access.'),
            ],
          });
        const tested = await tx.db
          .selectFrom('integrations.webhook_delivery')
          .select('id')
          .where('subscription_id', '=', sub.id)
          .where('object_kind', '=', 'synthetic')
          .where('state', '=', 'delivered')
          .where('created_at', '>=', sub.stopped_at!)
          .executeTakeFirst();
        if (!tested)
          throw new TenancyError('conflict', {
            issues: [
              issue(
                '/state',
                'test_required',
                'Send a test event and wait until it is delivered, then resume.',
              ),
            ],
          });
        const now = new Date();
        await tx.db
          .updateTable('integrations.webhook_subscription')
          .set({
            state: 'active',
            paused_at: null,
            paused_by_membership_id: null,
            stopped_at: null,
            consecutive_failures: 0,
            version: Number(sub.version) + 1,
            updated_at: now,
            updated_by_membership_id: p.membershipId,
          })
          .where('id', '=', sub.id)
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'webhook_subscription.resumed',
          { recordId: sub.id, type: 'webhook_subscription', publicId: sub.public_id },
          [change.plain('state', sub.state, 'active')],
          sub.brand_id,
        );
        return {
          status: 200,
          ref: { id: sub.public_id, type: 'webhook_subscription' },
          data: await this.#subState(tx, sub.id),
        };
      },
      async (tx, p, ref) =>
        this.#subState(tx, (await this.#renderSubscription(tx, caller, p, ref.id)).id),
    );
  }

  async testSubscription(caller: Caller, ws: unknown, id: string, req: Mutation) {
    return this.mutate(
      caller,
      'webhook_subscription.test',
      ws,
      req,
      async (tx, p) => {
        this.#delegated(caller);
        const sub = await this.#subscription(tx, p, id, 'webhook.test_send');
        const state = await this.#lockSubscription(tx, sub.id, 'share');
        if (!state || state.lifecycle_state !== 'active' || state.state === 'suspended')
          throw new TenancyError('conflict', {
            issues: [issue('/state', 'suspended', 'This endpoint cannot send test events now.')],
          });
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
            event_created_at: new Date(),
            object_kind: 'synthetic',
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
      async (tx, p, ref) => {
        const row = await this.#renderDelivery(tx, caller, p, ref.id, 'webhook.test_send');
        return {
          id: row.public_id,
          type: 'webhook_delivery' as const,
          version: 1,
          state: row.state,
          event_id: row.event_public_id,
        };
      },
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
    const matching = subs.filter(
      (sub) =>
        sub.event_types.includes(name) &&
        // A brand subscription matches exactly its brand; a workspace-level event (no brand)
        // never matches a brand subscription. Workspace subscriptions see every event, each
        // still authorized at send.
        (sub.brand_id === null || sub.brand_id === (event.brand_id ?? null)),
    );
    if (!matching.length) return 0;
    const source = await webhookSource(tx, name, event);
    const facts = publicFacts(event.data as Record<string, unknown>);
    let n = 0;
    // A redelivered internal event maps to the same public event id, so the per-subscription
    // uniqueness (webhook_delivery_event_once) keeps it to one delivery row.
    const eventPublicId = publicEventId(event.event_id);
    for (const sub of matching) {
      const inserted = await tx.db
        .insertInto('integrations.webhook_delivery')
        .values({
          id: newUuidV7(),
          workspace_id: tx.workspaceId,
          subscription_id: sub.id,
          public_id: newPublicId('whd'),
          event_public_id: eventPublicId,
          event_type: name,
          aggregate_id: event.aggregate.id,
          facts: JSON.stringify(facts) as never,
          state: 'pending',
          next_attempt_at: new Date(),
          event_created_at: new Date(event.occurred_at),
          object_kind: source.kind,
          object_id: source.objectId,
          source_record_id: source.sourceId,
        })
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'subscription_id', 'event_public_id']).doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      if (inserted) n += 1;
    }
    return n;
  }

  async sweepWorkspace(workspaceId: string, now = new Date()): Promise<void> {
    await this.runWebhookSweep(this.d.tenant, workspaceId, now);
  }

  /**
   * The delivery sweep (ADR-0037 W2). Due deliveries are listed in a short transaction; each is
   * then sent in its own transaction that holds the subscription (shared) and the delivery (for
   * update) while it sends. That bounds every wait on a send to one request, lets overlapping
   * workers skip each other's deliveries, and makes a pause or replay wait for the send in progress
   * and then see its outcome.
   */
  async runWebhookSweep(
    tenant: TenantDatabase,
    workspaceId: string,
    now = new Date(),
  ): Promise<void> {
    const due = await tenant.withWorkspace(workspaceId, { module: 'integrations' }, async (tx) => {
      const cutoff = new Date(now.getTime() - this.ws.webhookDeliveryRetentionDays * 86_400_000);
      await tx.db
        .deleteFrom('integrations.webhook_delivery')
        .where('created_at', '<', cutoff)
        .execute();
      return tx.db
        .selectFrom('integrations.webhook_delivery')
        .select(['id', 'subscription_id'])
        .where('state', 'in', ['pending', 'retry_scheduled', 'unknown'])
        .where((eb) => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now)]))
        .where((eb) => eb.or([eb('claimed_until', 'is', null), eb('claimed_until', '<=', now)]))
        .orderBy('created_at')
        .orderBy('id')
        .limit(this.ws.webhookSweepBatchMax)
        .execute();
    });
    for (const row of due) {
      const after = await tenant.withWorkspace(workspaceId, { module: 'integrations' }, (tx) =>
        this.#deliverOne(tx, row.id, row.subscription_id, now),
      );
      // The delivery transaction only shares the subscription; its counters and state change in
      // a short transaction afterwards, so overlapping workers never upgrade the same lock.
      if (after)
        await tenant.withWorkspace(workspaceId, { module: 'integrations' }, (tx) =>
          this.#afterDelivery(tx, row.subscription_id, after),
        );
    }
  }

  async #afterDelivery(tx: WorkspaceTransaction, subscriptionId: string, after: AfterDelivery) {
    if (after.kind === 'suspend') {
      await tx.db
        .updateTable('integrations.webhook_subscription')
        .set({
          state: 'suspended',
          suspended_reason:
            after.reason === 'owner_departed' ? 'owner_departed' : 'owner_authority',
          suspended_at: new Date(),
          paused_at: null,
          paused_by_membership_id: null,
          stopped_at: null,
          version: sql`version + 1` as never,
          updated_at: new Date(),
        })
        .where('id', '=', subscriptionId)
        .where('state', '<>', 'suspended')
        .execute();
      return;
    }
    if (after.kind === 'delivered') {
      await tx.db
        .updateTable('integrations.webhook_subscription')
        .set({ consecutive_failures: 0 })
        .where('id', '=', subscriptionId)
        .execute();
      return;
    }
    const bumped = await tx.db
      .updateTable('integrations.webhook_subscription')
      .set({ consecutive_failures: sql`least(consecutive_failures + 1, 1000)` as never })
      .where('id', '=', subscriptionId)
      .returning(['consecutive_failures'])
      .executeTakeFirst();
    if (after.counts && bumped)
      await this.#maybeDisable(tx, subscriptionId, bumped.consecutive_failures);
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
      async (tx, p, ref) => {
        this.#delegated(caller);
        const row = await tx.db
          .selectFrom('integrations.inbound_endpoint as e')
          .leftJoin('tenancy.brand as b', 'b.id', 'e.brand_id')
          .select([
            'e.public_id',
            'e.version',
            'e.action',
            'e.brand_id',
            'b.is_sensitive',
            'b.lifecycle_state as brand_state',
          ])
          .where('e.public_id', '=', ref.id)
          .executeTakeFirst();
        // The same current authority as creating it: hidden is unknown; visible without the
        // action is forbidden. The path token and secret were shown once and never again.
        if (!row || !subscriptionVisible(p, row)) throw new TenancyError('not_found');
        if (!managesSubscription(p, row)) throw new TenancyError('forbidden');
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

  async #deliverOne(
    tx: WorkspaceTransaction,
    id: string,
    subscriptionId: string,
    now: Date,
  ): Promise<AfterDelivery | null> {
    // Lock order: the subscription (shared) and then the delivery. A pause, resume, or replay
    // takes the same order, so they wait for this send instead of deadlocking with it.
    const sub = await this.#lockSubscription(tx, subscriptionId, 'share');
    if (!sub) return null;
    const row = await tx.db
      .selectFrom('integrations.webhook_delivery')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (
      !row ||
      !['pending', 'retry_scheduled', 'unknown'].includes(row.state) ||
      (row.next_attempt_at && new Date(row.next_attempt_at) > now) ||
      (row.claimed_until && new Date(row.claimed_until) > now)
    )
      return null;
    const synthetic = row.object_kind === 'synthetic';
    if (sub.lifecycle_state !== 'active') return this.#skip(tx, row, 'subscription_inactive');
    if (!synthetic && sub.state === 'paused') return this.#skip(tx, row, 'paused');
    if (!synthetic && sub.state === 'disabled_endpoint')
      return this.#skip(tx, row, 'endpoint_disabled', 'disabled_endpoint');
    if (sub.state === 'suspended') return this.#skip(tx, row, 'suspended');
    const gate = await this.#deliveryGate(tx, sub, row);
    if (!gate.ok) {
      await this.#skip(tx, row, gate.reason);
      return gate.suspend ? { kind: 'suspend', reason: gate.reason } : null;
    }
    const host = new URL(sub.destination_url).host;
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
      return null;
    }
    const secrets = await this.#secrets(
      tx,
      sub.signing_secret_ref,
      sub.previous_secret_ref,
      sub.previous_secret_until,
    );
    const body = JSON.stringify(gate.envelope);
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const signatures = secrets.map((x) => signPayload(x, row.event_public_id, timestamp, body));
    const started = Date.now();
    let result: WebhookTransportResult;
    try {
      await assertPublicHttps(sub.destination_url, this.ws.webhookAllowLoopback);
      result = await this.#deliver({
        url: sub.destination_url,
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
    const attempt = row.attempt + 1;
    const counted = { attempt, total_attempts: row.total_attempts + 1 };
    const target = { id: row.id, subscription_id: sub.id };
    if (result.kind === 'status' && result.status >= 200 && result.status < 300) {
      await this.#finish(tx, target, 'delivered', result.status, duration, null, counted);
      this.d.metrics.count('webhook.deliveries', 1, { outcome: 'delivered', status_class: '2xx' });
      return { kind: 'delivered' };
    }
    const retry = result.kind !== 'status' || retryableStatus(result.status);
    if (!retry || attempt >= this.ws.webhookMaxAttempts) {
      await this.#finish(
        tx,
        target,
        'failed',
        result.kind === 'status' ? result.status : null,
        duration,
        result.kind,
        counted,
      );
      // A failed test never disables an endpoint; a failed event counts towards disablement.
      return { kind: 'failed', counts: !synthetic };
    }
    await tx.db
      .updateTable('integrations.webhook_delivery')
      .set({
        state: result.kind === 'network' ? 'unknown' : 'retry_scheduled',
        ...counted,
        response_status: result.kind === 'status' ? result.status : null,
        duration_ms: duration,
        next_attempt_at: new Date(Date.now() + webhookDelayMs(attempt, 1000, 60_000)),
        claimed_until: null,
        updated_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
    this.d.metrics.count('webhook.deliveries', 1, { outcome: 'retry', status_class: result.kind });
    return null;
  }

  /**
   * Whether a delivery may be sent now, and its payload (0D §9.1, ADR-0037 W1). Built at send as
   * the subscription's accountable owner: the owner must still manage webhooks at the
   * subscription's placement, and must still read the governing record through the canonical
   * visibility predicate (restricted projects, sensitive brands, record shares, lifecycle),
   * intersected with the subscription's brand. Anything unresolvable fails closed.
   */
  async #deliveryGate(
    tx: WorkspaceTransaction,
    sub: LockedSubscription,
    row: {
      event_public_id: string;
      event_type: string;
      object_kind: string;
      object_id: string | null;
      source_record_id: string | null;
      facts: unknown;
      event_created_at: Date | string;
    },
  ): Promise<
    { ok: true; envelope: OutboundEnvelope } | { ok: false; reason: string; suspend?: boolean }
  > {
    const ws = await tx.db
      .selectFrom('tenancy.workspace')
      .select('public_id')
      .where('id', '=', tx.workspaceId)
      .executeTakeFirstOrThrow();
    const created = new Date(row.event_created_at).toISOString();
    if (row.object_kind === 'synthetic')
      // A synthetic test event: a fresh id-shaped object and no tenant records or fields.
      return {
        ok: true,
        envelope: {
          id: row.event_public_id,
          type: 'webhook.test',
          api_version: 'v1',
          created_at: created,
          workspace: ws.public_id,
          data: {
            object: { id: row.event_public_id, type: 'webhook_test' },
            fields: {},
            changes: [],
          },
        },
      };
    if (sub.brand_id && sub.brand_state !== 'active')
      return { ok: false, reason: 'brand_inactive' };
    const owner = await tx.db
      .selectFrom('tenancy.membership')
      .select(['id', 'account_id', 'state', 'kind'])
      .where('id', '=', sub.accountable_owner_membership_id)
      .executeTakeFirst();
    if (!owner || owner.state !== 'active' || owner.kind !== 'member')
      return { ok: false, reason: 'owner_departed', suspend: true };
    const principal = await loadPrincipal(tx, owner.account_id, owner.id);
    const manages = sub.brand_id
      ? decideBrand(principal, 'webhooks.manage', {
          id: sub.brand_id,
          isSensitive: sub.is_sensitive === true,
          lifecycleState: 'active',
        }).allowed
      : decideWorkspace(principal, 'webhooks.manage').allowed;
    if (!manages) return { ok: false, reason: 'owner_authority', suspend: true };
    if (row.object_kind === 'unsupported' || !row.source_record_id || !row.object_id)
      return { ok: false, reason: 'unsupported_source' };
    const source = await tx.db
      .selectFrom('core.record')
      .select(['id', 'public_id', 'record_type', 'brand_id', 'lifecycle_state', 'version'])
      .where('id', '=', row.source_record_id)
      .executeTakeFirst();
    if (!source || source.lifecycle_state === 'purged')
      return { ok: false, reason: 'source_unavailable' };
    if (sub.brand_id && source.brand_id !== sub.brand_id)
      return { ok: false, reason: 'out_of_scope' };
    const vis = await compileVisibility(tx, principal, {
      need: 'view',
      includeArchived: true,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const readable = WEBHOOK_TOMBSTONES.has(row.event_type)
      ? // The tombstone contract: a lifecycle event is authorized against the record's placement
        // as if it were active (the record itself has left active use).
        await sql<{ ok: number }>`SELECT 1 AS ok FROM (
            SELECT x.id, x.workspace_id, x.brand_id, x.record_type,
                   'active'::core.lifecycle_state AS lifecycle_state
              FROM core.record x WHERE x.id = ${source.id}) r
           WHERE ${vis.where('r')}`.execute(tx.db)
      : await sql<{ ok: number }>`SELECT 1 AS ok FROM core.record r
           WHERE r.id = ${source.id} AND ${vis.where('r')}`.execute(tx.db);
    if (!readable.rows.length) return { ok: false, reason: 'not_readable' };
    let object: { id: string; type: string; version?: number };
    if (row.object_kind === 'record') {
      const rec =
        row.object_id === source.id
          ? source
          : await tx.db
              .selectFrom('core.record')
              .select(['public_id', 'record_type', 'version'])
              .where('id', '=', row.object_id)
              .executeTakeFirst();
      if (!rec) return { ok: false, reason: 'source_unavailable' };
      object = { id: rec.public_id, type: rec.record_type, version: Number(rec.version) };
    } else if (row.object_kind === 'comment') {
      const c = await tx.db
        .selectFrom('collab.comment')
        .select(['public_id', 'host_record_id', 'deleted_at'])
        .where('id', '=', row.object_id)
        .executeTakeFirst();
      if (!c || c.deleted_at || c.host_record_id !== source.id)
        return { ok: false, reason: 'source_unavailable' };
      object = { id: c.public_id, type: 'comment' };
    } else {
      const r = await tx.db
        .selectFrom('collab.review_request')
        .select(['public_id', 'subject_record_id'])
        .where('id', '=', row.object_id)
        .executeTakeFirst();
      if (!r || r.subject_record_id !== source.id)
        return { ok: false, reason: 'source_unavailable' };
      object = { id: r.public_id, type: 'review_request' };
    }
    const brand = source.brand_id
      ? await tx.db
          .selectFrom('core.record')
          .select('public_id')
          .where('id', '=', source.brand_id)
          .executeTakeFirst()
      : undefined;
    // Queued facts are not authority: the version 1 allow-list is applied again at send.
    const facts = publicFacts(
      (typeof row.facts === 'string' ? JSON.parse(row.facts) : (row.facts ?? {})) as Record<
        string,
        unknown
      >,
    );
    const changes =
      typeof facts.changed_fields === 'string'
        ? facts.changed_fields.split(',').filter((f) => /^[a-z_]{1,40}$/.test(f))
        : [];
    return {
      ok: true,
      envelope: {
        id: row.event_public_id,
        type: row.event_type,
        api_version: 'v1',
        created_at: created,
        workspace: ws.public_id,
        ...(brand ? { brand: brand.public_id } : {}),
        data: { object, fields: facts, changes },
      },
    };
  }

  async #skip(
    tx: WorkspaceTransaction,
    row: { id: string },
    reason: string,
    state: 'skipped' | 'disabled_endpoint' = 'skipped',
  ): Promise<null> {
    await tx.db
      .updateTable('integrations.webhook_delivery')
      .set({
        state,
        detail: reason,
        next_attempt_at: null,
        claimed_until: null,
        updated_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
    this.d.metrics.count('webhook.deliveries', 1, { outcome: 'skipped', status_class: 'none' });
    return null;
  }

  async #lockSubscription(
    tx: WorkspaceTransaction,
    id: string,
    mode: 'share' | 'update',
  ): Promise<LockedSubscription | undefined> {
    const base = tx.db
      .selectFrom('integrations.webhook_subscription')
      .select(['id', 'version'])
      .where('id', '=', id);
    const locked = await (mode === 'share' ? base.forShare() : base.forUpdate()).executeTakeFirst();
    if (!locked) return undefined;
    return tx.db
      .selectFrom('integrations.webhook_subscription as s')
      .innerJoin('core.record as r', 'r.id', 's.id')
      .leftJoin('tenancy.brand as b', 'b.id', 's.brand_id')
      .select([
        's.id',
        'r.public_id',
        's.state',
        's.lifecycle_state',
        's.version',
        's.brand_id',
        'b.is_sensitive',
        'b.lifecycle_state as brand_state',
        's.destination_url',
        's.signing_secret_ref',
        's.previous_secret_ref',
        's.previous_secret_until',
        's.consecutive_failures',
        's.accountable_owner_membership_id',
        's.stopped_at',
      ])
      .where('s.id', '=', id)
      .executeTakeFirst();
  }

  /** Commands that wait for a send in progress may wait up to one request (plus margin). */
  async #waitForSend(tx: WorkspaceTransaction): Promise<void> {
    const ms = Math.min(this.ws.webhookResponseTimeoutMs + 2000, 60_000);
    await sql.raw(`SET LOCAL lock_timeout = '${Math.floor(ms)}ms'`).execute(tx.db);
  }

  /** `webhooks.manage` at the subscription's own placement (workspace or its brand). */
  #requireManager(p: Principal, sub: LockedSubscription) {
    if (!subscriptionVisible(p, sub)) throw new TenancyError('not_found');
    if (!managesSubscription(p, sub)) throw new TenancyError('forbidden');
  }

  async #subState(tx: WorkspaceTransaction, id: string) {
    const r = await tx.db
      .selectFrom('integrations.webhook_subscription as s')
      .innerJoin('core.record as c', 'c.id', 's.id')
      .select(['c.public_id', 's.state', 's.version', 's.paused_at', 's.stopped_at'])
      .where('s.id', '=', id)
      .executeTakeFirstOrThrow();
    return {
      id: r.public_id,
      type: 'webhook_subscription' as const,
      version: Number(r.version),
      state: r.state,
      paused_at: r.paused_at ? new Date(r.paused_at).toISOString() : null,
      stopped_at: r.stopped_at ? new Date(r.stopped_at).toISOString() : null,
    };
  }

  protected override mapFailure(command: string, err: unknown): unknown {
    // A pause, resume, or replay that could not obtain its lock within one request's time.
    const code = (err as { code?: unknown } | null)?.code;
    if (command.startsWith('webhook') && code === '55P03')
      return new TenancyError('conflict', {
        issues: [issue('/state', 'in_progress', 'A delivery is being sent now. Try again.')],
      });
    return super.mapFailure(command, err);
  }

  async #finish(
    tx: WorkspaceTransaction,
    row: { id: string; subscription_id: string },
    state: 'delivered' | 'failed',
    status: number | null,
    duration: number | null,
    detail: string | null,
    counted: { attempt: number; total_attempts: number },
  ) {
    await tx.db
      .updateTable('integrations.webhook_delivery')
      .set({
        state,
        ...counted,
        response_status: status,
        duration_ms: duration,
        detail,
        claimed_until: null,
        next_attempt_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
  }

  async #maybeDisable(tx: WorkspaceTransaction, subscriptionId: string, failures: number) {
    if (failures < this.ws.webhookDisableThreshold) return;
    const disabled = await tx.db
      .updateTable('integrations.webhook_subscription')
      .set({ state: 'disabled_endpoint', stopped_at: new Date(), updated_at: new Date() })
      .where('id', '=', subscriptionId)
      // Only an active endpoint is disabled automatically; a deliberate pause stays a pause.
      .where('state', '=', 'active')
      .executeTakeFirst();
    if (Number(disabled.numUpdatedRows) !== 1) return;
    const pub = await tx.db
      .selectFrom('core.record')
      .select('public_id')
      .where('id', '=', subscriptionId)
      .executeTakeFirstOrThrow();
    await writeOutboxEvent(tx, {
      type: 'integrations.webhook.delivery_failed',
      aggregate: { type: 'integrations.webhook_delivery', id: subscriptionId, sequence: failures },
      data: { subscription_id: pub.public_id, attempt: failures },
      actor: { type: 'system' },
      context: {
        workspaceId: tx.workspaceId,
        correlationId: '0'.repeat(32),
        authenticatedPrincipal: { type: 'system_job', id: subscriptionId },
        effectivePrincipal: { type: 'system_job', id: subscriptionId },
        delegationChain: [{ type: 'system_job', id: subscriptionId }],
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
    const vault = this.integrationVault();
    const secrets: string[] = [];
    const a = await vault.get(current, { scope: tx });
    if (a) secrets.push(a);
    if (previous && until && until.getTime() > Date.now()) {
      const b = await vault.get(previous, { scope: tx });
      if (b) secrets.push(b);
    }
    return secrets;
  }

  async #putSecret(tx: WorkspaceTransaction, purpose: string, secret: string): Promise<string> {
    return this.integrationVault().put(purpose, secret, { scope: tx });
  }

  /** A token must carry `webhooks:manage`; it only ever narrows the member's own authority. */
  #delegated(caller: Caller) {
    if (caller.delegation && !scopeAllows(caller.delegation.scopes, 'webhooks:manage'))
      throw new TenancyError('forbidden');
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

  async #subscription(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: string,
    action: 'webhooks.manage' | 'webhook.test_send' = 'webhooks.manage',
  ) {
    const row = await tx.db
      .selectFrom('integrations.webhook_subscription as s')
      .innerJoin('core.record as r', 'r.id', 's.id')
      .leftJoin('tenancy.brand as b', 'b.id', 's.brand_id')
      .select([
        's.id',
        'r.public_id as publicId',
        's.destination_url',
        's.event_types',
        's.version',
        's.signing_secret_ref',
        's.brand_id',
        'b.is_sensitive',
        'b.lifecycle_state as brand_state',
      ])
      .where('r.public_id', '=', publicId)
      // Archived, trashed, and purged subscriptions are not managed (or rendered) at all.
      .where('s.lifecycle_state', '=', 'active')
      .executeTakeFirst();
    if (!row || !subscriptionVisible(p, row)) throw new TenancyError('not_found');
    // Managing a subscription needs the action at its own placement (a brand manager manages
    // the brand's subscriptions; workspace subscriptions need workspace authority).
    if (!managesSubscription(p, row, action)) throw new TenancyError('forbidden');
    return row;
  }

  /**
   * A completed idempotency key re-renders its response through the caller's current authority
   * (0D §5.2), never the authority it had when the command ran: delegated scope, subscription
   * visibility (opaque `not_found` when hidden), placement-level authority (`forbidden`), and
   * lifecycle are checked before any state is read. Nothing is re-executed.
   */
  async #renderSubscription(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    publicId: string,
    action: 'webhooks.manage' | 'webhook.test_send' = 'webhooks.manage',
  ) {
    this.#delegated(caller);
    return this.#subscription(tx, p, publicId, action);
  }

  /** A delivery's completed-key response, authorized through its subscription first. */
  async #renderDelivery(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    deliveryPublicId: string,
    action: 'webhooks.manage' | 'webhook.test_send' = 'webhooks.manage',
  ) {
    this.#delegated(caller);
    const ref = await tx.db
      .selectFrom('integrations.webhook_delivery as d')
      .innerJoin('core.record as r', 'r.id', 'd.subscription_id')
      .select(['d.id', 'r.public_id as subscription_public_id'])
      .where('d.public_id', '=', deliveryPublicId)
      .executeTakeFirst();
    // A delivery removed by retention, or one whose subscription was purged, is unknown.
    if (!ref) throw new TenancyError('not_found');
    await this.#subscription(tx, p, ref.subscription_public_id, action);
    return tx.db
      .selectFrom('integrations.webhook_delivery')
      .select(['public_id', 'state', 'cycle', 'total_attempts', 'event_public_id'])
      .where('id', '=', ref.id)
      .executeTakeFirstOrThrow();
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

/** Terminal deliveries a manager may retry (dead-lettered); nothing else is replayable. */
const REPLAYABLE: ReadonlySet<string> = new Set(['failed', 'disabled_endpoint']);

function notReplayable(message: string) {
  return new TenancyError('conflict', { issues: [issue('/state', 'not_replayable', message)] });
}

type AfterDelivery =
  { kind: 'delivered' } | { kind: 'failed'; counts: boolean } | { kind: 'suspend'; reason: string };

interface LockedSubscription {
  id: string;
  public_id: string;
  state: string;
  lifecycle_state: string;
  version: number | string;
  brand_id: string | null;
  is_sensitive: boolean | null;
  brand_state: string | null;
  destination_url: string;
  signing_secret_ref: string;
  previous_secret_ref: string | null;
  previous_secret_until: Date | null;
  consecutive_failures: number;
  accountable_owner_membership_id: string;
  stopped_at: Date | null;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A stable `evt_` identifier derived from the internal event id (never the id itself). */
function publicEventId(eventId: string): string {
  let value = 0n;
  for (const b of createHash('sha256').update(`webhook-event:${eventId}`).digest().subarray(0, 16))
    value = (value << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return `evt_${out}`;
}

/** A brand-scoped subscription is as unknown as its brand to someone who cannot read it. */
function subscriptionVisible(
  p: Principal,
  row: { brand_id: string | null; is_sensitive: boolean | null; brand_state: string | null },
): boolean {
  if (!row.brand_id) return true;
  return (
    brandLevel(p, {
      id: row.brand_id,
      isSensitive: row.is_sensitive === true,
      lifecycleState: (row.brand_state ?? 'active') as BrandFacts['lifecycleState'],
    }) !== null
  );
}

function managesSubscription(
  p: Principal,
  row: { brand_id: string | null; is_sensitive: boolean | null },
  action: 'webhooks.manage' | 'webhook.test_send' = 'webhooks.manage',
): boolean {
  return row.brand_id
    ? decideBrand(p, action, {
        id: row.brand_id,
        isSensitive: row.is_sensitive === true,
        lifecycleState: 'active',
      }).allowed
    : decideWorkspace(p, action).allowed;
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
