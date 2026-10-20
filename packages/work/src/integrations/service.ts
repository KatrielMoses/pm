import { randomBytes } from 'node:crypto';
import { lockPlanConstraints } from '../planning/constraints.ts';
import { change, CommandContext } from '@pm/audit';
import type { SecretVault } from '@pm/config';
import { newPublicId, newUuidV7, type ActionKey, type ExecutionContext } from '@pm/contracts';
import { sql, type ConnectionHealth, type TenantDatabase, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import {
  brandLevel,
  cell,
  compilePrincipal,
  decideBrand,
  decideWorkspace,
  findBrand,
  invalid,
  issue,
  levelRank,
  TenancyError,
  workspaceLevel,
  type BrandFacts,
  type Caller,
  type Mutation,
  type Outcome,
  type Principal,
} from '@pm/tenancy';
import { ReportService } from '../insights/report-service.ts';
import {
  openCredential,
  payloadHash,
  providerById,
  PROVIDERS,
  scopesAllowed,
  syncScopeAllowsRead,
  syncScopeAllowsWrite,
  sealCredential,
  syncBackoffMs,
  connectionTokenMatches,
  DEFAULT_CALENDAR_EVENTS,
  type CredentialSecret,
  type ProviderId,
} from './semantics.ts';
import {
  deleteCalendarEventsForConnection,
  ProviderFailure,
  upsertCalendarEvents,
} from './calendar-sync.ts';
import {
  parseComplete,
  parseConnect,
  parseDisconnect,
  parseLocalEdit,
  parseResolve,
} from './validation.ts';

const ALLOW: Outcome = { allowed: true };

function allowAtPlacement(p: Principal, action: ActionKey, brand: BrandFacts | null): Outcome {
  const c = cell(action, p.role);
  if (!brand) {
    if (p.kind === 'guest') return { allowed: false, code: 'forbidden' };
    if (c.kind === 'implicit' || c.kind === 'own') return ALLOW;
    if (c.kind === 'grant')
      return levelRank(workspaceLevel(p)) >= levelRank(c.level)
        ? ALLOW
        : { allowed: false, code: 'forbidden' };
    return { allowed: false, code: 'forbidden' };
  }
  const level = brandLevel(p, brand);
  if (level === null) return { allowed: false, code: 'not_found' };
  if (c.kind === 'deny' || c.kind === 'own') return { allowed: false, code: 'forbidden' };
  if (c.kind === 'grant')
    return levelRank(level) >= levelRank(c.level) ? ALLOW : { allowed: false, code: 'forbidden' };
  if (c.kind === 'implicit') {
    if (!brand.isSensitive) return ALLOW;
    return p.grants.get(brand.id) === 'manage' ? ALLOW : { allowed: false, code: 'forbidden' };
  }
  return { allowed: false, code: 'forbidden' };
}

function canView(p: Principal, brand: BrandFacts | null): boolean {
  if (p.kind !== 'member') return false;
  if (!brand) return workspaceLevel(p) !== null;
  return brandLevel(p, brand) !== null;
}

function integrationExec(
  workspaceId: string,
  connectionId: string,
  ownerId: string,
): ExecutionContext {
  return {
    workspaceId,
    correlationId: newUuidV7().replace(/-/g, ''),
    authenticatedPrincipal: { type: 'integration_connection', id: connectionId },
    effectivePrincipal: { type: 'integration_connection', id: connectionId },
    initiatingMembershipId: ownerId,
    delegationChain: [
      { type: 'member', id: ownerId },
      { type: 'integration_connection', id: connectionId },
    ],
    epochs: { workspace: 0, principal: 0 },
    dataClassLimit: 'C2',
  };
}

/** A connection as the service chain sees it (never the credential itself). */
export interface Loaded {
  id: string;
  publicId: string;
  version: number;
  brandId: string | null;
  provider: ProviderId;
  authKind: 'oauth' | 'api_key';
  displayName: string;
  ownerId: string;
  ownerPublicId: string;
  ownerName: string;
  scopes: string[];
  health: string;
  secretRef: string | null;
  keyVersion: number;
  lastSuccessAt: Date | null;
  lastError: string | null;
  suspendedReason: string | null;
  outboundPaused: boolean;
  retention: string | null;
  disconnectedAt: Date | null;
  lifecycle: string;
  facts: BrandFacts | null;
  sensitive: boolean;
}

/**
 * Phase 6A connection authority (ADR-0032). A credential is written only to the vault. Views,
 * events, audit changes, logs, and the search index never receive it.
 * A departing owner is suspended as owner_departed and must reauthorize.
 */
export class IntegrationService extends ReportService {
  readonly #vault: SecretVault;

  constructor(deps: ConstructorParameters<typeof ReportService>[0] & { vault: SecretVault }) {
    super(deps);
    this.#vault = deps.vault;
  }

  protected integrationVault(): SecretVault {
    return this.#vault;
  }

  async listProviders(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      this.#member(p);
      return {
        providers: PROVIDERS.map((def) => ({
          id: def.id,
          label: def.label,
          phase: def.phase,
          scopes: [...def.scopes],
          configured: this.configured(def.id),
          unavailable: this.configured(def.id) ? null : def.unavailable,
        })),
      };
    });
  }

  async listConnections(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      this.#member(p);
      const rows = await this.#loadAll(tx);
      return {
        connections: rows.filter((r) => canView(p, r.facts)).map((r) => this.#view(r)),
      };
    });
  }

  async getConnection(caller: Caller, ws: unknown, id: unknown) {
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      this.#member(p);
      return this.#view(await this.#visible(tx, p, id));
    });
  }

  async createConnection(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = parseConnect(body, this.ws.connectionScopesMax);
    return this.mutate(
      caller,
      'connection.create',
      ws,
      req,
      async (tx, p) => {
        this.#member(p);
        await this.#limit(p);
        const def = providerById(input.provider);
        if (!def || !this.configured(def.id))
          throw invalid(
            issue(
              '/provider',
              'provider_unconfigured',
              def?.unavailable ?? 'This provider is not configured.',
            ),
          );
        if (!scopesAllowed(def, input.scopes))
          throw invalid(
            issue('/scopes', 'insufficient_scope', 'Ask only for scopes this provider offers.'),
          );
        if (
          (input.mode || input.remoteVersion) &&
          input.provider !== 'loopback' &&
          input.provider !== 'google_calendar'
        )
          throw invalid(
            issue(
              '/mode',
              'invalid_option',
              'Only the loopback and Google Calendar test providers accept a mode.',
            ),
          );
        const place = await this.#placement(tx, p, input.brand);
        this.#require(p, 'integrations.configure', place.facts);
        await this.#room(tx, place.scopeKey);
        const id = newUuidV7();
        const publicId = newPublicId('conn');
        const live =
          input.authKind === 'oauth'
            ? this.oauthStart(input.provider, input.scopes, {
                workspace: String(ws),
                connection: publicId,
              })
            : null;
        const code =
          input.authKind === 'oauth' && !live ? randomBytes(24).toString('base64url') : null;
        const token = input.apiKey ?? live?.state ?? code;
        if (!token) throw invalid(issue('/api_key', 'required', 'An API key is required.'));
        const secret = sealCredential({
          kind: input.authKind === 'oauth' ? 'oauth_pending' : 'api_key',
          token,
          ...(live ? { pkce: live.verifier, remote: [] } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.remoteVersion
            ? {
                remote: [
                  {
                    type: 'item',
                    id: 'loopback-1',
                    version: input.remoteVersion,
                    title: 'Loopback item',
                  },
                ],
              }
            : {}),
          ...(input.provider === 'google_calendar' && !live && input.authKind === 'api_key'
            ? { events: DEFAULT_CALENDAR_EVENTS }
            : {}),
        });
        const ref = await this.#vault.put('integration_credential', secret, { scope: tx });
        const health = this.#healthFor(
          input.authKind === 'oauth' ? 'oauth_pending' : 'api_key',
          input.mode ?? 'ok',
        );
        const cmd = this.cmd(caller, p, place.brandId);
        await tx.db
          .insertInto('core.record')
          .values({
            id,
            public_id: publicId,
            record_type: 'connection',
            workspace_id: tx.workspaceId,
            brand_id: place.brandId,
            source_kind: 'ui',
            source_ref: null,
            created_by_actor_type: cmd.actor.type,
            created_by_actor_id: cmd.actor.id,
          })
          .execute();
        await tx.db
          .insertInto('integrations.connection')
          .values({
            id,
            workspace_id: tx.workspaceId,
            brand_id: place.brandId,
            scope_key: place.scopeKey,
            provider: input.provider,
            auth_kind: input.authKind,
            display_name: input.displayName,
            owner_membership_id: p.membershipId,
            granted_scopes: input.scopes,
            health,
            credential_secret_ref: ref,
            credential_key_version: this.#vaultKey(),
            last_error: health === 'error' ? 'provider_rejected' : null,
            created_by_membership_id: p.membershipId,
            updated_by_membership_id: p.membershipId,
          })
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'connection.created',
          { recordId: id, type: 'connection', publicId },
          [
            change.plain('provider', null, input.provider),
            change.plain('auth_kind', null, input.authKind),
            change.plain('scopes', null, String(input.scopes.length)),
            change.plain('configured', null, 'yes'),
          ],
          place.brandId,
        );
        await this.#event(
          tx,
          caller,
          p,
          'integrations.connection.created',
          id,
          {
            provider: input.provider,
            auth_kind: input.authKind,
            scope: place.brandId ? 'brand' : 'workspace',
          },
          place.brandId,
        );
        const loaded = await this.#visible(tx, p, publicId);
        const data = this.#view(loaded);
        return {
          status: 201,
          ref: { id: publicId, type: 'connection' },
          data: live
            ? { ...data, authorization_url: live.url }
            : code
              ? { ...data, authorization_code: code }
              : data,
        };
      },
      async (tx, p, ref) => this.#view(await this.#visible(tx, p, ref.id)),
    );
  }

  async completeOauth(caller: Caller, ws: unknown, id: unknown, body: unknown, req: Mutation) {
    const input = parseComplete(body);
    return this.mutate(
      caller,
      'connection.reauthorize',
      ws,
      req,
      async (tx, p) => {
        this.#member(p);
        const row = await this.#locked(tx, p, id);
        this.#require(p, 'integrations.configure', row.facts);
        const secret = await this.#readSecret(tx, row);
        if (!secret || secret.kind !== 'oauth_pending')
          throw invalid(issue('/code', 'invalid', 'The authorization code is not usable.'));
        if (secret.pkce) {
          // A live provider: only the person who started the authorization completes it, and the
          // state must match before the code is exchanged (CSRF, mix-up).
          if (p.membershipId !== row.ownerId) throw new TenancyError('not_found');
          if (!input.state || !connectionTokenMatches(secret.token, input.state))
            throw invalid(
              issue('/state', 'invalid', 'This authorization is not for this connection.'),
            );
          const granted = await this.oauthExchange(row, secret, input.code);
          await this.#replaceSecret(tx, row, granted.secret);
          // A scope the person declined at the provider narrows the connection; it never widens.
          const scopes = row.scopes.filter((s) => granted.scopes.includes(s));
          if (!scopes.length) {
            await this.#setHealth(tx, row, 'needs_reauthorization', 'insufficient_scope');
            throw invalid(
              issue('/scopes', 'insufficient_scope', 'Calendar access was not granted.'),
            );
          }
          await tx.db
            .updateTable('integrations.connection')
            .set({ granted_scopes: scopes })
            .where('id', '=', row.id)
            .execute();
          row.scopes = scopes;
        } else if (!connectionTokenMatches(secret.token, input.code))
          throw invalid(issue('/code', 'invalid', 'The authorization code is not usable.'));
        else await this.#replaceSecret(tx, row, { ...secret, kind: 'oauth' });
        await this.#setHealth(tx, row, 'connected', null);
        await this.afterAuthorized(tx, row);
        await this.workAudit(
          tx,
          caller,
          p,
          'connection.reauthorized',
          this.#target(row),
          [change.plain('configured', 'pending', 'yes')],
          row.brandId,
        );
        await this.#event(
          tx,
          caller,
          p,
          'integrations.connection.reauthorized',
          row.id,
          { auth_kind: 'oauth' },
          row.brandId,
        );
        return {
          status: 200,
          ref: { id: row.publicId, type: 'connection' },
          data: this.#view(await this.#visible(tx, p, row.publicId)),
        };
      },
      async (tx, p, ref) => this.#view(await this.#visible(tx, p, ref.id)),
    );
  }

  async testConnection(caller: Caller, ws: unknown, id: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'connection.test',
      ws,
      req,
      async (tx, p) => {
        this.#member(p);
        const row = await this.#locked(tx, p, id);
        this.#require(p, 'integration.sync_now', row.facts);
        const result = await this.#probe(tx, row);
        await this.#setHealth(tx, row, result.health, result.error);
        if (result.health === 'connected' || result.health === 'degraded')
          await tx.db
            .updateTable('integrations.connection')
            .set({ last_success_at: new Date() })
            .where('id', '=', row.id)
            .execute();
        await this.#runRow(
          tx,
          row,
          'test',
          result.health === 'error' ? 'failed' : 'succeeded',
          result.error,
          0,
          0,
          0,
        );
        await this.#event(
          tx,
          caller,
          p,
          'integrations.connection.health_changed',
          row.id,
          { health: result.health },
          row.brandId,
        );
        return {
          status: 200,
          ref: { id: row.publicId, type: 'connection' },
          data: this.#view(await this.#visible(tx, p, row.publicId)),
        };
      },
      async (tx, p, ref) => this.#view(await this.#visible(tx, p, ref.id)),
    );
  }

  async reauthorize(caller: Caller, ws: unknown, id: unknown, body: unknown, req: Mutation) {
    const input = parseConnect(body, this.ws.connectionScopesMax);
    return this.mutate(
      caller,
      'connection.reauthorize',
      ws,
      req,
      async (tx, p) => {
        this.#member(p);
        const row = await this.#locked(tx, p, id);
        this.#require(p, 'integrations.configure', row.facts);
        if (input.provider !== row.provider)
          throw invalid(
            issue('/provider', 'invalid_option', 'Reauthorization stays on the same provider.'),
          );
        if ((input.mode || input.remoteVersion) && row.provider !== 'loopback')
          throw invalid(
            issue('/mode', 'invalid_option', 'Only the loopback provider accepts a mode.'),
          );
        if (!scopesAllowed(providerById(row.provider)!, input.scopes))
          throw invalid(
            issue('/scopes', 'insufficient_scope', 'Ask only for scopes this provider offers.'),
          );
        const live =
          input.authKind === 'oauth'
            ? this.oauthStart(row.provider, input.scopes, {
                workspace: String(ws),
                connection: row.publicId,
              })
            : null;
        const token = input.apiKey ?? live?.state ?? randomBytes(24).toString('base64url');
        const prior = await this.#readSecret(tx, row);
        await this.revokeAtProvider(row, prior);
        await this.#destroyRef(tx, row.secretRef);
        const ref = await this.#vault.put(
          'integration_credential',
          sealCredential({
            kind: input.authKind === 'oauth' ? 'oauth_pending' : 'api_key',
            token,
            ...(live ? { pkce: live.verifier, remote: [] } : {}),
            ...(input.mode ? { mode: input.mode } : {}),
            ...(input.remoteVersion
              ? {
                  remote: [
                    {
                      type: 'item',
                      id: 'loopback-1',
                      version: input.remoteVersion,
                      title: 'Loopback item',
                    },
                  ],
                }
              : {}),
          }),
          { scope: tx },
        );
        const health = this.#healthFor(
          input.authKind === 'oauth' ? 'oauth_pending' : 'api_key',
          input.mode ?? 'ok',
        );
        await tx.db
          .updateTable('integrations.connection')
          .set({
            auth_kind: input.authKind,
            granted_scopes: input.scopes,
            credential_secret_ref: ref,
            credential_key_version: row.keyVersion + 1,
            health,
            last_error: health === 'error' ? 'provider_rejected' : null,
            suspended_reason: null,
            suspended_at: null,
            outbound_paused: false,
            retention_choice: null,
            disconnected_at: null,
            owner_membership_id: p.membershipId,
            updated_at: new Date(),
            updated_by_membership_id: p.membershipId,
            version: row.version + 1,
          } as never)
          .where('id', '=', row.id)
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'connection.reauthorized',
          this.#target(row),
          [
            change.plain('configured', 'replaced', 'yes'),
            change.plain('key_version', String(row.keyVersion), String(row.keyVersion + 1)),
          ],
          row.brandId,
        );
        await this.#event(
          tx,
          caller,
          p,
          'integrations.connection.reauthorized',
          row.id,
          { auth_kind: input.authKind },
          row.brandId,
        );
        const data = this.#view(await this.#visible(tx, p, row.publicId));
        return {
          status: 200,
          ref: { id: row.publicId, type: 'connection' },
          data: live
            ? { ...data, authorization_url: live.url }
            : input.authKind === 'oauth'
              ? { ...data, authorization_code: token }
              : data,
        };
      },
      async (tx, p, ref) => this.#view(await this.#visible(tx, p, ref.id)),
    );
  }

  async disconnect(caller: Caller, ws: unknown, id: unknown, body: unknown, req: Mutation) {
    const input = parseDisconnect(body);
    return this.mutate(
      caller,
      'connection.disconnect',
      ws,
      req,
      async (tx, p) => {
        this.#member(p);
        const row = await this.#locked(tx, p, id);
        this.#require(p, 'integrations.configure', row.facts);
        await this.revokeAtProvider(row, await this.#readSecret(tx, row));
        await this.#destroyRef(tx, row.secretRef);
        await tx.db
          .updateTable('integrations.connection')
          .set({
            credential_secret_ref: null,
            health: 'disconnected',
            last_error: null,
            outbound_paused: true,
            retention_choice: input.retention,
            disconnected_at: new Date(),
            updated_at: new Date(),
            updated_by_membership_id: p.membershipId,
            version: row.version + 1,
          } as never)
          .where('id', '=', row.id)
          .execute();
        if (input.retention === 'remove') {
          if (row.ownerId) await lockPlanConstraints(tx, row.ownerId);
          await this.#removeSynced(tx, row.id);
        } else await this.afterDisconnectRetained(tx, row);
        await this.workAudit(
          tx,
          caller,
          p,
          'connection.disconnected',
          this.#target(row),
          [
            change.plain('retention', null, input.retention),
            change.plain('configured', 'yes', 'revoked'),
          ],
          row.brandId,
        );
        await this.#event(
          tx,
          caller,
          p,
          'integrations.connection.disconnected',
          row.id,
          { retention: input.retention },
          row.brandId,
        );
        return {
          status: 200,
          ref: { id: row.publicId, type: 'connection' },
          data: this.#view(await this.#visible(tx, p, row.publicId)),
        };
      },
      async (tx, p, ref) => this.#view(await this.#visible(tx, p, ref.id)),
    );
  }

  async syncNow(caller: Caller, ws: unknown, id: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'connection.sync',
      ws,
      req,
      async (tx, p) => {
        this.#member(p);
        await this.#limit(p);
        const row = await this.#locked(tx, p, id);
        this.#require(p, 'integration.sync_now', row.facts);
        const run = await this.#enqueueAndApply(tx, row, req.idempotencyKey, false);
        return {
          status: 200,
          ref: { id: row.publicId, type: 'connection' },
          data: { id: row.publicId, type: 'connection', ...run },
        };
      },
      async (tx, p, ref) => {
        const row = await this.#visible(tx, p, ref.id);
        const prior = await tx.db
          .selectFrom('integrations.sync_run')
          .select(['state', 'read_count', 'write_count', 'conflict_count', 'error_code'])
          .where('connection_id', '=', row.id)
          .orderBy('started_at', 'desc')
          .executeTakeFirst();
        return { id: ref.id, type: 'connection', ...(prior ? this.#runView(prior) : {}) };
      },
    );
  }

  async listRuns(caller: Caller, ws: unknown, id: unknown) {
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      this.#member(p);
      const row = await this.#visible(tx, p, id);
      const runs = await tx.db
        .selectFrom('integrations.sync_run')
        .select([
          'state',
          'direction',
          'attempt',
          'error_code',
          'read_count',
          'write_count',
          'conflict_count',
          'started_at',
          'finished_at',
        ])
        .where('connection_id', '=', row.id)
        .orderBy('started_at', 'desc')
        .limit(50)
        .execute();
      return { runs: runs.map((r) => this.#runView(r)) };
    });
  }

  async listConflicts(caller: Caller, ws: unknown, id: unknown) {
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      this.#member(p);
      const row = await this.#visible(tx, p, id);
      const rows = await tx.db
        .selectFrom('integrations.sync_conflict')
        .select(['public_id', 'field_key', 'local_version', 'remote_version', 'state'])
        .where('connection_id', '=', row.id)
        .where('state', '=', 'open')
        .orderBy('created_at')
        .execute();
      return {
        conflicts: rows.map((c) => ({
          id: c.public_id,
          field: c.field_key,
          local_version: c.local_version,
          remote_version: c.remote_version,
          state: c.state,
        })),
      };
    });
  }

  async resolveConflict(
    caller: Caller,
    ws: unknown,
    id: unknown,
    conflict: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseResolve(body);
    return this.mutate(
      caller,
      'connection.resolve',
      ws,
      req,
      async (tx, p) => {
        this.#member(p);
        const row = await this.#locked(tx, p, id);
        this.#require(p, 'integrations.configure', row.facts);
        const found = await tx.db
          .selectFrom('integrations.sync_conflict')
          .select([
            'id',
            'public_id',
            'external_identity_id',
            'field_key',
            'local_version',
            'remote_version',
            'state',
            'version',
          ])
          .where('connection_id', '=', row.id)
          .where('public_id', '=', String(conflict))
          .executeTakeFirst();
        if (!found || found.state !== 'open') throw new TenancyError('not_found');
        const handled = await this.resolveFieldConflict(tx, p, row, found, input.resolution);
        const nextLocal =
          input.resolution === 'kept_remote' ? found.remote_version : found.local_version;
        const nextBase = input.resolution === 'dismissed' ? found.local_version : nextLocal;
        if (!handled)
          await tx.db
            .updateTable('integrations.external_identity')
            .set({
              local_version: nextLocal,
              base_version: nextBase,
              remote_version:
                input.resolution === 'kept_local' ? found.local_version : found.remote_version,
              updated_at: new Date(),
            })
            .where('id', '=', found.external_identity_id)
            .execute();
        await tx.db
          .updateTable('integrations.sync_conflict')
          .set({
            state: input.resolution,
            resolved_by_membership_id: p.membershipId,
            resolved_at: new Date(),
            version: found.version + 1,
          })
          .where('id', '=', found.id)
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'connection.conflict_resolved',
          this.#target(row),
          [change.plain('resolution', 'open', input.resolution)],
          row.brandId,
        );
        await this.#event(
          tx,
          caller,
          p,
          'integrations.conflict.resolved',
          row.id,
          { resolution: input.resolution },
          row.brandId,
        );
        return {
          status: 200,
          ref: { id: row.publicId, type: 'connection' },
          data: { id: found.public_id, type: 'sync_conflict', state: input.resolution },
        };
      },
      async () => ({ id: String(conflict), type: 'sync_conflict', state: input.resolution }),
    );
  }

  async editLocal(
    caller: Caller,
    ws: unknown,
    id: unknown,
    identity: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseLocalEdit(body);
    return this.mutate(
      caller,
      'connection.local_edit',
      ws,
      req,
      async (tx, p) => {
        this.#member(p);
        const row = await this.#locked(tx, p, id);
        this.#require(p, 'integrations.configure', row.facts);
        if (!syncScopeAllowsWrite(row.scopes))
          throw invalid(issue('/scopes', 'insufficient_scope', 'This connection cannot write.'));
        const ident = await tx.db
          .selectFrom('integrations.external_identity')
          .select(['id', 'public_id'])
          .where('connection_id', '=', row.id)
          .where('public_id', '=', String(identity))
          .executeTakeFirst();
        if (!ident) throw new TenancyError('not_found');
        await tx.db
          .updateTable('integrations.external_identity')
          .set({ local_version: input.version, updated_at: new Date() })
          .where('id', '=', ident.id)
          .execute();
        return {
          status: 200,
          ref: { id: row.publicId, type: 'connection' },
          data: { id: ident.public_id, type: 'external_identity', local_version: input.version },
        };
      },
      async () => ({
        id: String(identity),
        type: 'external_identity',
        local_version: input.version,
      }),
    );
  }

  async rotateCredentials(caller: Caller, ws: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'connection.rotate',
      ws,
      req,
      async (tx, p) => {
        this.#member(p);
        const o = decideWorkspace(p, 'integrations.configure');
        this.decision('integrations.configure', o);
        if (!o.allowed) throw new TenancyError(o.code);
        const rows = await tx.db
          .selectFrom('integrations.connection')
          .select(['id', 'credential_secret_ref', 'credential_key_version', 'brand_id'])
          .where('credential_secret_ref', 'is not', null)
          .execute();
        let rotated = 0;
        for (const row of rows) {
          const plain = await this.#vault.get(row.credential_secret_ref!, { scope: tx });
          if (!plain) continue;
          const next = await this.#vault.put('integration_credential', plain, { scope: tx });
          await this.#vault.destroy(row.credential_secret_ref!, { scope: tx });
          await tx.db
            .updateTable('integrations.connection')
            .set({
              credential_secret_ref: next,
              credential_key_version: row.credential_key_version + 1,
              version: sql`version + 1`,
            } as never)
            .where('id', '=', row.id)
            .execute();
          await this.#event(
            tx,
            caller,
            p,
            'integrations.credential.rotated',
            row.id,
            {
              key_version: row.credential_key_version + 1,
            },
            row.brand_id,
          );
          rotated += 1;
        }
        return {
          status: 200,
          ref: { id: tx.workspaceId, type: 'workspace' },
          data: { id: tx.workspaceId, type: 'workspace', rotated },
        };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: ref.type, rotated: 0 }),
    );
  }

  async runSyncSweep(
    tenant: TenantDatabase,
    workspaceId: string,
    now: Date,
  ): Promise<{ applied: number; dead: number }> {
    const dueBefore = new Date(now.getTime() - this.ws.syncHistoryRetentionDays * 86_400_000);
    await tenant.withWorkspace(workspaceId, { module: 'integrations' }, async (tx) => {
      await sql`DELETE FROM integrations.sync_run WHERE started_at < ${dueBefore}`.execute(tx.db);
    });
    return tenant.withWorkspace(workspaceId, { module: 'integrations' }, async (tx) => {
      const due = await sql<{ id: string }>`
        SELECT id FROM integrations.sync_delivery
         WHERE state IN ('pending', 'retry_scheduled') AND next_attempt_at <= ${now}
           AND (claimed_until IS NULL OR claimed_until <= ${now})
         ORDER BY next_attempt_at LIMIT ${this.ws.syncBatchMax}
         FOR UPDATE SKIP LOCKED`.execute(tx.db);
      let applied = 0;
      let dead = 0;
      for (const item of due.rows) {
        const delivery = await tx.db
          .selectFrom('integrations.sync_delivery')
          .selectAll()
          .where('id', '=', item.id)
          .executeTakeFirst();
        if (!delivery) continue;
        const row = await this.#byId(tx, delivery.connection_id);
        if (!row) continue;
        const outcome = await this.#applyDelivery(tx, row, delivery, true);
        if (outcome === 'dead') dead += 1;
        else applied += 1;
      }
      return { applied, dead };
    });
  }

  // ---------------------------------------------------------------------------------------------

  protected configured(id: ProviderId): boolean {
    return id === 'loopback' && this.ws.integrationLoopbackEnabled;
  }

  // Provider hooks (ADR-0037 G1). The framework owns authority, credentials, deliveries, retries,
  // and history; a provider extension supplies only its protocol. Defaults are the 6A behavior.

  /** Whether a connection talks to a live provider or to the in-process test double. */
  protected connectionMode(
    row: Pick<Loaded, 'provider' | 'authKind'>,
  ): 'live' | 'test_double' | null {
    return row.provider === 'loopback' ? 'test_double' : null;
  }

  /** Starts a live OAuth authorization; null keeps the 6A loopback code flow. */
  protected oauthStart(
    _provider: ProviderId,
    _scopes: string[],
    _ctx: { workspace: string; connection: string },
  ): { state: string; verifier: string; url: string } | null {
    return null;
  }

  /** Exchanges a live authorization code (state already verified). */
  protected oauthExchange(
    _row: Loaded,
    _secret: CredentialSecret,
    _code: string,
  ): Promise<{ secret: CredentialSecret; scopes: string[] }> {
    return Promise.reject(new TenancyError('conflict'));
  }

  /** Runs after a connection is (re)authorized, inside the same transaction. */
  protected async afterAuthorized(_tx: WorkspaceTransaction, _row: Loaded): Promise<void> {}

  /** Runs after a disconnect that keeps synchronized data. */
  protected async afterDisconnectRetained(_tx: WorkspaceTransaction, _row: Loaded): Promise<void> {}

  /** Best-effort provider-side revocation before the credential is destroyed. */
  protected async revokeAtProvider(_row: Loaded, _secret: CredentialSecret | null): Promise<void> {}

  /** Provider data for one inbound sync, after authority, scope, and health checks passed. */
  protected async syncProviderData(
    tx: WorkspaceTransaction,
    row: Loaded,
    secret: CredentialSecret,
    canWrite: boolean,
  ): Promise<{ reads: number; writes: number; conflicts: number; partial?: boolean }> {
    if (row.provider === 'google_calendar' && secret.events?.length) {
      // 7F review 01 R1: calendar mirrors are plan inputs (the owner's constraint lock first).
      if (row.ownerId) await lockPlanConstraints(tx, row.ownerId);
      const cal = await upsertCalendarEvents(tx, {
        connectionId: row.id,
        ownerMembershipId: row.ownerId,
        events: secret.events,
        canWrite,
      });
      return { ...cal, conflicts: 0 };
    }
    return { reads: 0, writes: 0, conflicts: 0 };
  }

  /** Resolves a provider-specific conflict field; false leaves the generic identity resolution. */
  protected async resolveFieldConflict(
    _tx: WorkspaceTransaction,
    _p: Principal,
    _row: Loaded,
    _conflict: { id: string; field_key: string; external_identity_id: string },
    _resolution: 'kept_local' | 'kept_remote' | 'dismissed',
  ): Promise<boolean> {
    return false;
  }

  protected readConnectionSecret(tx: WorkspaceTransaction, row: Loaded) {
    return this.#readSecret(tx, row);
  }

  /** Replaces the credential (for example after a token refresh); `row.secretRef` follows. */
  protected async storeConnectionSecret(
    tx: WorkspaceTransaction,
    row: Loaded,
    secret: CredentialSecret,
  ): Promise<void> {
    await this.#replaceSecret(tx, row, secret);
  }

  /** Marks a connection as needing reauthorization (provider refused its grant). */
  protected async markNeedsReauthorization(
    tx: WorkspaceTransaction,
    row: Loaded,
    error: string,
  ): Promise<void> {
    await this.#setHealth(tx, row, 'needs_reauthorization', error);
  }

  /** Records a provider-specific conflict against an external identity (one open per field). */
  protected async recordConflict(
    tx: WorkspaceTransaction,
    row: Loaded,
    input: { type: string; externalId: string; field: string; local: string; remote: string },
  ): Promise<'created' | 'open'> {
    let ident = await tx.db
      .selectFrom('integrations.external_identity')
      .select(['id'])
      .where('connection_id', '=', row.id)
      .where('external_type', '=', input.type)
      .where('external_id', '=', input.externalId)
      .executeTakeFirst();
    if (!ident) {
      const id = newUuidV7();
      await tx.db
        .insertInto('integrations.external_identity')
        .values({
          id,
          public_id: newPublicId('ext'),
          workspace_id: tx.workspaceId,
          connection_id: row.id,
          external_type: input.type,
          external_id: input.externalId,
          label: input.type,
          remote_version: input.remote.slice(0, 80),
          local_version: input.local.slice(0, 80),
          base_version: input.local.slice(0, 80),
          last_synced_at: new Date(),
        })
        .execute();
      ident = { id };
    }
    const open = await tx.db
      .selectFrom('integrations.sync_conflict')
      .select('id')
      .where('external_identity_id', '=', ident.id)
      .where('field_key', '=', input.field)
      .where('state', '=', 'open')
      .executeTakeFirst();
    if (open) return 'open';
    await tx.db
      .insertInto('integrations.sync_conflict')
      .values({
        id: newUuidV7(),
        public_id: newPublicId('cnf'),
        workspace_id: tx.workspaceId,
        connection_id: row.id,
        external_identity_id: ident.id,
        field_key: input.field,
        local_version: input.local.slice(0, 80),
        remote_version: input.remote.slice(0, 80),
      })
      .execute();
    await this.#integrationEvent(tx, row, 'integrations.conflict.detected', { field: input.field });
    return 'created';
  }

  /** An audit entry written as the connection (delegated from its owner), never as a person. */
  protected async integrationAuditAs(
    tx: WorkspaceTransaction,
    row: Loaded,
    action: string,
    changes: ReturnType<typeof change.plain>[],
    target?: { recordId: string; type: string; publicId: string | null },
    brandId?: string | null,
  ): Promise<void> {
    const ctx = integrationExec(tx.workspaceId, row.id, row.ownerId);
    await this.workWriter.write(
      tx,
      CommandContext.fromExecution(
        ctx,
        { kind: 'integration', ref: row.publicId },
        { brandId: brandId === undefined ? row.brandId : brandId },
      ),
      { action, target: target ?? this.#target(row), changes },
    );
  }

  /** The execution context of work done by a connection on its owner's behalf. */
  protected integrationContext(tx: WorkspaceTransaction, row: Loaded): ExecutionContext {
    return integrationExec(tx.workspaceId, row.id, row.ownerId);
  }

  /** Re-checks that the connection's owner still holds sync authority (queued work, AZ-40). */
  protected ownerStillAuthorized(tx: WorkspaceTransaction, row: Loaded): Promise<boolean> {
    return this.#ownerStillAuthorized(tx, row);
  }

  /** Loads a connection by its public identifier for a principal who can see it. */
  protected visibleConnection(
    tx: WorkspaceTransaction,
    p: Principal,
    id: unknown,
  ): Promise<Loaded> {
    return this.#visible(tx, p, id);
  }

  /** Same, locked for update. */
  protected lockedConnection(tx: WorkspaceTransaction, p: Principal, id: unknown): Promise<Loaded> {
    return this.#locked(tx, p, id);
  }

  /** Queues (or reuses) a sync delivery so the worker sweep picks it up. */
  protected async queueSync(tx: WorkspaceTransaction, row: Loaded, dedupe: string): Promise<void> {
    const key = dedupe.slice(0, 200);
    await tx.db
      .insertInto('integrations.sync_delivery')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        connection_id: row.id,
        dedupe_key: key.length >= 8 ? key : `sync-${key}`,
        payload_hash: payloadHash([row.id, key]),
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'connection_id', 'dedupe_key']).doNothing())
      .execute();
  }

  #healthFor(kind: string, mode: string): ConnectionHealth {
    if (kind === 'oauth_pending') return 'needs_reauthorization';
    if (mode === 'error') return 'error';
    if (mode === 'degraded') return 'degraded';
    return 'connected';
  }

  #vaultKey(): number {
    return 'currentKeyId' in this.#vault && typeof this.#vault.currentKeyId === 'number'
      ? this.#vault.currentKeyId
      : 1;
  }

  #member(p: Principal): void {
    if (p.kind !== 'member') throw new TenancyError('forbidden');
  }

  #require(p: Principal, action: ActionKey, brand: BrandFacts | null): void {
    const o = allowAtPlacement(p, action, brand);
    this.decision(action, o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  async #limit(p: Principal): Promise<void> {
    const rl = await this.c.limiter.consume('integration.member' as never, p.membershipId);
    if (!rl.allowed)
      throw new TenancyError('rate_limited', { retryAfterSeconds: rl.retryAfterSeconds });
  }

  async #placement(tx: WorkspaceTransaction, p: Principal, brand: string | null) {
    if (!brand) {
      const o = decideWorkspace(p, 'integrations.configure');
      this.decision('integrations.configure', o);
      if (!o.allowed) throw new TenancyError(o.code);
      return {
        brandId: null as string | null,
        scopeKey: tx.workspaceId,
        facts: null as BrandFacts | null,
      };
    }
    const b = await findBrand(tx, p, brand);
    const facts: BrandFacts = { id: b.id, isSensitive: b.is_sensitive, lifecycleState: 'active' };
    if (b.lifecycle_state !== 'active')
      throw new TenancyError('conflict', {
        issues: [issue('/brand', 'brand_archived', 'This brand is archived.')],
      });
    const o = decideBrand(p, 'integrations.configure', facts);
    this.decision('integrations.configure', o);
    if (!o.allowed) throw new TenancyError(o.code);
    return { brandId: b.id, scopeKey: b.id, facts };
  }

  async #room(tx: WorkspaceTransaction, scopeKey: string): Promise<void> {
    const n = await tx.db
      .selectFrom('integrations.connection')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('scope_key', '=', scopeKey)
      .where('lifecycle_state', '<>', 'purged')
      .executeTakeFirstOrThrow();
    if (Number(n.n) >= this.ws.connectionsPerScopeMax)
      throw invalid(
        issue('/display_name', 'too_many', 'This scope has as many connections as it can hold.'),
      );
  }

  async #loadAll(tx: WorkspaceTransaction): Promise<Loaded[]> {
    const rows = await tx.db
      .selectFrom('integrations.connection as c')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'c.workspace_id').onRef('r.id', '=', 'c.id'),
      )
      .innerJoin('tenancy.membership as m', (j) =>
        j
          .onRef('m.workspace_id', '=', 'c.workspace_id')
          .onRef('m.id', '=', 'c.owner_membership_id'),
      )
      .innerJoin('identity.account as a', 'a.id', 'm.account_id')
      .leftJoin('tenancy.brand as b', (j) =>
        j.onRef('b.workspace_id', '=', 'c.workspace_id').onRef('b.id', '=', 'c.brand_id'),
      )
      .select([
        'c.id',
        'r.public_id',
        'c.version',
        'c.brand_id',
        'c.provider',
        'c.auth_kind',
        'c.display_name',
        'c.owner_membership_id',
        'm.public_id as owner_public_id',
        'a.display_name as owner_name',
        'c.granted_scopes',
        'c.health',
        'c.credential_secret_ref',
        'c.credential_key_version',
        'c.last_success_at',
        'c.last_error',
        'c.suspended_reason',
        'c.outbound_paused',
        'c.retention_choice',
        'c.disconnected_at',
        'c.lifecycle_state',
        'b.is_sensitive',
        'b.lifecycle_state as brand_state',
      ])
      .where('c.lifecycle_state', '<>', 'purged')
      .orderBy('c.created_at')
      .execute();
    return rows.map((r) => this.#loaded(r));
  }

  /**
   * 8B: whether a person can see a connection now (an agent integration grant needs it). A
   * visible connection grants nothing behind it: its records keep their own authorization.
   */
  protected async connectionVisibleTo(
    tx: WorkspaceTransaction,
    p: Principal,
    id: string,
  ): Promise<{ id: string; publicId: string; name: string } | null> {
    const row = await this.#byId(tx, id);
    if (!row || row.disconnectedAt || !canView(p, row.facts)) return null;
    return { id: row.id, publicId: row.publicId, name: row.displayName };
  }

  /** 8B: a connection's internal id by its public id (null when absent). */
  protected async connectionIdOf(
    tx: WorkspaceTransaction,
    publicId: string,
  ): Promise<string | null> {
    const rows = await this.#loadAll(tx);
    return rows.find((r) => r.publicId === publicId)?.id ?? null;
  }

  async #byId(tx: WorkspaceTransaction, id: string): Promise<Loaded | null> {
    const rows = await this.#loadAll(tx);
    return rows.find((r) => r.id === id) ?? null;
  }

  async #visible(tx: WorkspaceTransaction, p: Principal, id: unknown): Promise<Loaded> {
    const want = typeof id === 'string' ? id : '';
    const rows = await this.#loadAll(tx);
    const row = rows.find((r) => r.publicId === want);
    if (!row || !canView(p, row.facts)) throw new TenancyError('not_found');
    return row;
  }

  async #locked(tx: WorkspaceTransaction, p: Principal, id: unknown): Promise<Loaded> {
    const row = await this.#visible(tx, p, id);
    await tx.db
      .selectFrom('integrations.connection')
      .select('id')
      .where('id', '=', row.id)
      .forUpdate()
      .executeTakeFirst();
    return row;
  }

  #loaded(r: {
    id: string;
    public_id: string;
    version: number;
    brand_id: string | null;
    provider: ProviderId;
    auth_kind: 'oauth' | 'api_key';
    display_name: string;
    owner_membership_id: string;
    owner_public_id: string;
    owner_name: string;
    granted_scopes: string[];
    health: string;
    credential_secret_ref: string | null;
    credential_key_version: number;
    last_success_at: Date | null;
    last_error: string | null;
    suspended_reason: string | null;
    outbound_paused: boolean;
    retention_choice: string | null;
    disconnected_at: Date | null;
    lifecycle_state: string;
    is_sensitive: boolean | null;
    brand_state: string | null;
  }): Loaded {
    const facts = r.brand_id
      ? {
          id: r.brand_id,
          isSensitive: r.is_sensitive === true,
          lifecycleState: (r.brand_state ?? 'active') as BrandFacts['lifecycleState'],
        }
      : null;
    return {
      id: r.id,
      publicId: r.public_id,
      version: r.version,
      brandId: r.brand_id,
      provider: r.provider,
      authKind: r.auth_kind,
      displayName: r.display_name,
      ownerId: r.owner_membership_id,
      ownerPublicId: r.owner_public_id,
      ownerName: r.owner_name,
      scopes: r.granted_scopes,
      health: r.health,
      secretRef: r.credential_secret_ref,
      keyVersion: r.credential_key_version,
      lastSuccessAt: r.last_success_at,
      lastError: r.last_error,
      suspendedReason: r.suspended_reason,
      outboundPaused: r.outbound_paused,
      retention: r.retention_choice,
      disconnectedAt: r.disconnected_at,
      lifecycle: r.lifecycle_state,
      facts,
      sensitive: r.is_sensitive === true,
    };
  }

  #view(row: Loaded) {
    return {
      id: row.publicId,
      type: 'connection' as const,
      version: row.version,
      provider: row.provider,
      auth_kind: row.authKind,
      display_name: row.displayName,
      owner: { id: row.ownerPublicId, name: row.ownerName },
      scopes: row.scopes,
      health: row.health,
      credential_configured: row.secretRef !== null,
      key_version: row.keyVersion,
      last_success_at: row.lastSuccessAt ? new Date(row.lastSuccessAt).toISOString() : null,
      last_error: row.lastError,
      suspended_reason: row.suspendedReason,
      outbound_paused: row.outboundPaused,
      retention_choice: row.retention,
      provider_configured: this.configured(row.provider),
      provider_mode: this.connectionMode(row),
    };
  }

  #target(row: Loaded) {
    return { recordId: row.id, type: 'connection', publicId: row.publicId };
  }

  #runView(r: {
    state: string;
    direction?: string;
    attempt?: number;
    error_code: string | null;
    read_count: number;
    write_count: number;
    conflict_count: number;
    started_at?: Date;
    finished_at?: Date | null;
  }) {
    return {
      state: r.state,
      ...(r.direction ? { direction: r.direction } : {}),
      ...(r.attempt !== undefined ? { attempt: r.attempt } : {}),
      error_code: r.error_code,
      read_count: r.read_count,
      write_count: r.write_count,
      conflict_count: r.conflict_count,
      ...(r.started_at ? { started_at: new Date(r.started_at).toISOString() } : {}),
      ...(r.finished_at !== undefined
        ? { finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null }
        : {}),
    };
  }

  async #readSecret(tx: WorkspaceTransaction, row: Loaded): Promise<CredentialSecret | null> {
    if (!row.secretRef) return null;
    const raw = await this.#vault.get(row.secretRef, { scope: tx });
    return openCredential(raw);
  }

  async #destroyRef(tx: WorkspaceTransaction, ref: string | null): Promise<void> {
    if (ref) await this.#vault.destroy(ref, { scope: tx });
  }

  async #replaceSecret(
    tx: WorkspaceTransaction,
    row: Loaded,
    secret: CredentialSecret,
  ): Promise<void> {
    await this.#destroyRef(tx, row.secretRef);
    const ref = await this.#vault.put('integration_credential', JSON.stringify(secret), {
      scope: tx,
    });
    await tx.db
      .updateTable('integrations.connection')
      .set({
        credential_secret_ref: ref,
        credential_key_version: row.keyVersion + 1,
        updated_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
    // The loaded row follows, so a later read or replacement in this transaction uses the new one.
    row.secretRef = ref;
    row.keyVersion += 1;
  }

  async #setHealth(
    tx: WorkspaceTransaction,
    row: Loaded,
    health: string,
    error: string | null,
  ): Promise<void> {
    await tx.db
      .updateTable('integrations.connection')
      .set({
        health,
        last_error: error,
        updated_at: new Date(),
        version: row.version + 1,
      } as never)
      .where('id', '=', row.id)
      .execute();
  }

  async #probe(
    tx: WorkspaceTransaction,
    row: Loaded,
  ): Promise<{ health: string; error: string | null }> {
    if (!this.configured(row.provider))
      return { health: 'provider_unconfigured', error: 'provider_unconfigured' };
    const secret = await this.#readSecret(tx, row);
    if (!secret || secret.kind === 'oauth_pending')
      return { health: 'needs_reauthorization', error: 'needs_reauthorization' };
    if (secret.mode === 'error') return { health: 'error', error: 'provider_rejected' };
    if (secret.mode === 'degraded') return { health: 'degraded', error: null };
    return { health: 'connected', error: null };
  }

  async #removeSynced(tx: WorkspaceTransaction, connectionId: string): Promise<void> {
    await tx.db
      .deleteFrom('integrations.sync_conflict')
      .where('connection_id', '=', connectionId)
      .execute();
    await tx.db
      .deleteFrom('integrations.sync_delivery')
      .where('connection_id', '=', connectionId)
      .execute();
    await tx.db
      .deleteFrom('integrations.external_identity')
      .where('connection_id', '=', connectionId)
      .execute();
    await tx.db
      .deleteFrom('integrations.sync_checkpoint')
      .where('connection_id', '=', connectionId)
      .execute();
    await deleteCalendarEventsForConnection(tx, connectionId);
  }

  async #runRow(
    tx: WorkspaceTransaction,
    row: Loaded,
    direction: 'inbound' | 'outbound' | 'test',
    state: 'succeeded' | 'failed' | 'dead' | 'partial' | 'skipped',
    error: string | null,
    read: number,
    write: number,
    conflicts: number,
    idempotency?: string,
  ): Promise<void> {
    await tx.db
      .insertInto('integrations.sync_run')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        connection_id: row.id,
        idempotency_key: idempotency ?? null,
        direction,
        state,
        attempt: 1,
        failure_class:
          error === 'provider_rejected'
            ? 'permanent'
            : error === 'provider_degraded'
              ? 'degraded'
              : error
                ? 'transient'
                : null,
        error_code: error,
        read_count: read,
        write_count: write,
        conflict_count: conflicts,
        finished_at: new Date(),
      })
      // A retried delivery is one run whose attempt count grows; its latest outcome is current.
      .onConflict((oc) =>
        oc
          .columns(['workspace_id', 'connection_id', 'idempotency_key'])
          .where('idempotency_key', 'is not', null)
          .doUpdateSet((eb) => ({
            state: eb.ref('excluded.state'),
            attempt: sql<number>`integrations.sync_run.attempt + 1`,
            failure_class: eb.ref('excluded.failure_class'),
            error_code: eb.ref('excluded.error_code'),
            read_count: eb.ref('excluded.read_count'),
            write_count: eb.ref('excluded.write_count'),
            conflict_count: eb.ref('excluded.conflict_count'),
            finished_at: eb.ref('excluded.finished_at'),
          })),
      )
      .execute();
  }

  async #enqueueAndApply(tx: WorkspaceTransaction, row: Loaded, dedupe: string, fromJob: boolean) {
    const key = dedupe.length >= 8 ? dedupe.slice(0, 200) : `sync-${dedupe}`;
    const existing = await tx.db
      .selectFrom('integrations.sync_delivery')
      .selectAll()
      .where('connection_id', '=', row.id)
      .where('dedupe_key', '=', key)
      .executeTakeFirst();
    if (existing?.state === 'delivered') {
      const prior = await tx.db
        .selectFrom('integrations.sync_run')
        .select(['state', 'error_code', 'read_count', 'write_count', 'conflict_count'])
        .where('connection_id', '=', row.id)
        .where('idempotency_key', '=', key)
        .executeTakeFirst();
      return this.#runView(
        prior ?? {
          state: 'succeeded',
          error_code: null,
          read_count: 0,
          write_count: 0,
          conflict_count: 0,
        },
      );
    }
    const delivery =
      existing ??
      (await (async () => {
        const id = newUuidV7();
        await tx.db
          .insertInto('integrations.sync_delivery')
          .values({
            id,
            workspace_id: tx.workspaceId,
            connection_id: row.id,
            dedupe_key: key,
            payload_hash: payloadHash([row.id, key]),
          })
          .execute();
        return tx.db
          .selectFrom('integrations.sync_delivery')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
      })());
    await this.#applyDelivery(tx, row, delivery, fromJob);
    const run = await tx.db
      .selectFrom('integrations.sync_run')
      .select([
        'state',
        'direction',
        'attempt',
        'error_code',
        'read_count',
        'write_count',
        'conflict_count',
        'started_at',
        'finished_at',
      ])
      .where('connection_id', '=', row.id)
      .where('idempotency_key', '=', key)
      .orderBy('started_at', 'desc')
      .executeTakeFirst();
    return this.#runView(
      run ?? {
        state: 'failed',
        error_code: 'sync_failed',
        read_count: 0,
        write_count: 0,
        conflict_count: 0,
      },
    );
  }

  async #applyDelivery(
    tx: WorkspaceTransaction,
    row: Loaded,
    delivery: { id: string; dedupe_key: string; attempts: number; state: string },
    fromJob: boolean,
  ): Promise<'applied' | 'dead' | 'retry'> {
    if (row.health === 'disconnected' || row.outboundPaused) {
      await this.#finishDelivery(tx, delivery, 'dead', 'permanent', 'disconnected');
      await this.#runRow(
        tx,
        row,
        'inbound',
        'skipped',
        'disconnected',
        0,
        0,
        0,
        delivery.dedupe_key,
      );
      return 'dead';
    }
    const ownerOk = await this.#ownerStillAuthorized(tx, row);
    if (!ownerOk) {
      await this.#destroyRef(tx, row.secretRef);
      await tx.db
        .updateTable('integrations.connection')
        .set({
          credential_secret_ref: null,
          health: 'needs_reauthorization',
          outbound_paused: true,
          suspended_reason: 'owner_authority',
          suspended_at: new Date(),
          version: sql`version + 1`,
        } as never)
        .where('id', '=', row.id)
        .execute();
      await this.#finishDelivery(tx, delivery, 'dead', 'permanent', 'owner_authority');
      await this.#integrationAudit(tx, row, 'connection.suspended', [
        change.plain('configured', 'yes', 'revoked'),
      ]);
      return 'dead';
    }
    const secret = await this.#readSecret(tx, row);
    if (!secret || secret.kind === 'oauth_pending') {
      await this.#finishDelivery(tx, delivery, 'dead', 'permanent', 'needs_reauthorization');
      await this.#runRow(
        tx,
        row,
        'inbound',
        'failed',
        'needs_reauthorization',
        0,
        0,
        0,
        delivery.dedupe_key,
      );
      return 'dead';
    }
    if (!this.configured(row.provider)) {
      await this.#setHealth(tx, row, 'provider_unconfigured', 'provider_unconfigured');
      await this.#finishDelivery(tx, delivery, 'dead', 'unconfigured', 'provider_unconfigured');
      await this.#runRow(
        tx,
        row,
        'inbound',
        'failed',
        'provider_unconfigured',
        0,
        0,
        0,
        delivery.dedupe_key,
      );
      await this.#failed(tx, row, 'provider_unconfigured');
      return 'dead';
    }
    if (secret.mode === 'error') {
      const attempts = delivery.attempts + 1;
      const dead = attempts >= this.ws.syncMaxAttempts;
      await this.#setHealth(tx, row, 'error', 'provider_rejected');
      await this.#finishDelivery(
        tx,
        delivery,
        dead ? 'dead' : 'retry_scheduled',
        'transient',
        'provider_rejected',
        attempts,
      );
      await this.#runRow(
        tx,
        row,
        'inbound',
        dead ? 'dead' : 'failed',
        'provider_rejected',
        0,
        0,
        0,
        delivery.dedupe_key,
      );
      if (dead) await this.#failed(tx, row, 'provider_rejected');
      return dead ? 'dead' : 'retry';
    }
    if (!syncScopeAllowsRead(row.scopes)) {
      await this.#finishDelivery(tx, delivery, 'dead', 'permanent', 'insufficient_scope');
      await this.#runRow(
        tx,
        row,
        'inbound',
        'failed',
        'insufficient_scope',
        0,
        0,
        0,
        delivery.dedupe_key,
      );
      return 'dead';
    }
    const degraded = secret.mode === 'degraded';
    const canWrite = syncScopeAllowsWrite(row.scopes) && !degraded;
    let reads = 0;
    let writes = 0;
    let conflicts = 0;
    for (const item of secret.remote) {
      reads += 1;
      const outcome = await this.#upsertIdentity(tx, row, item, canWrite);
      if (outcome === 'write') writes += 1;
      if (outcome === 'conflict') conflicts += 1;
    }
    let partial: boolean;
    try {
      const data = await this.syncProviderData(tx, row, secret, canWrite);
      reads += data.reads;
      writes += data.writes;
      conflicts += data.conflicts;
      partial = data.partial === true;
    } catch (err) {
      if (!(err instanceof ProviderFailure)) throw err;
      return this.#providerFailed(tx, row, delivery, err);
    }
    await this.#advanceCheckpoint(
      tx,
      row.id,
      secret.remote
        .map((i) => i.version)
        .sort()
        .at(-1) ?? '0',
    );
    const health = degraded ? 'degraded' : 'connected';
    await tx.db
      .updateTable('integrations.connection')
      .set({
        health,
        last_error: degraded ? 'provider_degraded' : null,
        last_success_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
    await this.#finishDelivery(tx, delivery, 'delivered', null, null, delivery.attempts + 1);
    await this.#runRow(
      tx,
      row,
      'inbound',
      conflicts || partial ? 'partial' : 'succeeded',
      degraded ? 'provider_degraded' : null,
      reads,
      writes,
      conflicts,
      delivery.dedupe_key,
    );
    await this.#integrationEvent(tx, row, 'integrations.sync.completed', {
      outcome: conflicts || partial ? 'partial' : 'succeeded',
      conflicts,
    });
    if (!fromJob && health !== row.health)
      await this.#integrationEvent(tx, row, 'integrations.connection.health_changed', { health });
    return 'applied';
  }

  /**
   * A provider failure during sync: refused grants need reauthorization (dead, never retried);
   * outages and rate limits retry with bounded backoff and show as degraded; permanent refusals
   * dead-letter. Each attempt is recorded truthfully; nothing is reported as synchronized.
   */
  async #providerFailed(
    tx: WorkspaceTransaction,
    row: Loaded,
    delivery: { id: string; dedupe_key: string; attempts: number },
    err: ProviderFailure,
  ): Promise<'dead' | 'retry'> {
    const attempts = delivery.attempts + 1;
    if (err.kind === 'reauthorize') {
      await this.#setHealth(tx, row, 'needs_reauthorization', 'needs_reauthorization');
      await this.#finishDelivery(
        tx,
        delivery,
        'dead',
        'permanent',
        'needs_reauthorization',
        attempts,
      );
      await this.#runRow(
        tx,
        row,
        'inbound',
        'failed',
        'needs_reauthorization',
        0,
        0,
        0,
        delivery.dedupe_key,
      );
      await this.#failed(tx, row, 'needs_reauthorization');
      return 'dead';
    }
    const retryable = err.kind === 'transient';
    const dead = !retryable || attempts >= this.ws.syncMaxAttempts;
    await this.#setHealth(tx, row, dead && !retryable ? 'error' : 'degraded', err.code);
    await this.#finishDelivery(
      tx,
      delivery,
      dead ? 'dead' : 'retry_scheduled',
      retryable ? 'transient' : 'permanent',
      err.code,
      attempts,
      err.retryAfterSeconds,
    );
    await this.#runRow(
      tx,
      row,
      'inbound',
      dead ? 'dead' : 'failed',
      err.code,
      0,
      0,
      0,
      delivery.dedupe_key,
    );
    if (dead) await this.#failed(tx, row, err.code);
    return dead ? 'dead' : 'retry';
  }

  async #upsertIdentity(
    tx: WorkspaceTransaction,
    row: Loaded,
    item: { type: string; id: string; version: string; title: string },
    canWrite: boolean,
  ): Promise<'write' | 'conflict' | 'read'> {
    const current = await tx.db
      .selectFrom('integrations.external_identity')
      .select(['id', 'remote_version', 'local_version', 'base_version'])
      .where('connection_id', '=', row.id)
      .where('external_type', '=', item.type)
      .where('external_id', '=', item.id)
      .executeTakeFirst();
    if (!current) {
      if (!canWrite) return 'read';
      await tx.db
        .insertInto('integrations.external_identity')
        .values({
          id: newUuidV7(),
          public_id: newPublicId('ext'),
          workspace_id: tx.workspaceId,
          connection_id: row.id,
          external_type: item.type,
          external_id: item.id,
          label: item.title.slice(0, 200),
          remote_version: item.version,
          local_version: item.version,
          base_version: item.version,
          last_synced_at: new Date(),
        })
        .execute();
      await this.#integrationAudit(tx, row, 'connection.record_synced', [
        change.plain('external_type', null, item.type),
        change.plain('source', null, 'integration'),
      ]);
      return 'write';
    }
    const remoteChanged = current.remote_version !== item.version;
    const localChanged = current.local_version !== current.base_version;
    if (remoteChanged && localChanged) {
      const open = await tx.db
        .selectFrom('integrations.sync_conflict')
        .select('id')
        .where('external_identity_id', '=', current.id)
        .where('field_key', '=', 'version')
        .where('state', '=', 'open')
        .executeTakeFirst();
      if (!open) {
        await tx.db
          .insertInto('integrations.sync_conflict')
          .values({
            id: newUuidV7(),
            public_id: newPublicId('cnf'),
            workspace_id: tx.workspaceId,
            connection_id: row.id,
            external_identity_id: current.id,
            field_key: 'version',
            local_version: current.local_version,
            remote_version: item.version,
          })
          .execute();
        await this.#integrationEvent(tx, row, 'integrations.conflict.detected', {
          field: 'version',
        });
      }
      return 'conflict';
    }
    if (remoteChanged && canWrite) {
      await tx.db
        .updateTable('integrations.external_identity')
        .set({
          remote_version: item.version,
          local_version: item.version,
          base_version: item.version,
          label: item.title.slice(0, 200),
          last_synced_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', current.id)
        .execute();
      await this.#integrationAudit(tx, row, 'connection.record_synced', [
        change.plain('source', null, 'integration'),
      ]);
      return 'write';
    }
    return 'read';
  }

  async #advanceCheckpoint(
    tx: WorkspaceTransaction,
    connectionId: string,
    cursor: string,
  ): Promise<void> {
    const current = await tx.db
      .selectFrom('integrations.sync_checkpoint')
      .select(['version', 'cursor'])
      .where('connection_id', '=', connectionId)
      .where('resource_key', '=', 'items')
      .forUpdate()
      .executeTakeFirst();
    if (!current) {
      await tx.db
        .insertInto('integrations.sync_checkpoint')
        .values({
          workspace_id: tx.workspaceId,
          connection_id: connectionId,
          resource_key: 'items',
          cursor,
        })
        .execute();
      return;
    }
    if (current.cursor === cursor) return;
    const updated = await tx.db
      .updateTable('integrations.sync_checkpoint')
      .set({
        cursor,
        version: current.version + 1,
        updated_at: new Date(),
      })
      .where('connection_id', '=', connectionId)
      .where('resource_key', '=', 'items')
      .where('version', '=', current.version)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1)
      throw new TenancyError('conflict', {
        issues: [issue('/cursor', 'version_conflict', 'The checkpoint changed.')],
      });
  }

  async #finishDelivery(
    tx: WorkspaceTransaction,
    delivery: { id: string; attempts: number },
    state: 'delivered' | 'retry_scheduled' | 'dead',
    failure: 'transient' | 'permanent' | 'unconfigured' | null,
    error: string | null,
    attempts = delivery.attempts,
    retryAfterSeconds: number | null = null,
  ): Promise<void> {
    const next =
      state === 'retry_scheduled'
        ? new Date(
            Date.now() +
              Math.max(
                syncBackoffMs(attempts, this.ws.syncBackoffSeconds),
                (retryAfterSeconds ?? 0) * 1000,
              ),
          )
        : new Date();
    await tx.db
      .updateTable('integrations.sync_delivery')
      .set({
        state,
        attempts,
        next_attempt_at: next,
        failure_class: failure,
        error_code: error,
        claimed_until: null,
        updated_at: new Date(),
      })
      .where('id', '=', delivery.id)
      .execute();
  }

  async #ownerStillAuthorized(tx: WorkspaceTransaction, row: Loaded): Promise<boolean> {
    const m = await tx.db
      .selectFrom('tenancy.membership')
      .select(['id', 'account_id', 'kind', 'state'])
      .where('id', '=', row.ownerId)
      .executeTakeFirst();
    if (!m || m.state !== 'active' || m.kind !== 'member') return false;
    const principal = await compilePrincipal(tx, m.id, m.account_id, 'member');
    return allowAtPlacement(principal, 'integration.sync_now', row.facts).allowed;
  }

  async #event(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    type: Parameters<IntegrationService['workEvent']>[3],
    id: string,
    data: Record<string, string | number | boolean | null>,
    brandId: string | null,
  ): Promise<void> {
    await this.workEvent(
      tx,
      caller,
      p,
      type,
      { type: 'integrations.connection', id, sequence: 1 },
      data,
      brandId,
    );
  }

  async #integrationEvent(
    tx: WorkspaceTransaction,
    row: Loaded,
    type: Parameters<typeof writeOutboxEvent>[1]['type'],
    data: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await writeOutboxEvent(tx, {
      type,
      aggregate: { type: 'integrations.connection', id: row.id, sequence: row.version + 1 },
      data,
      actor: { type: 'integration', id: row.id, onBehalfOfMembershipId: row.ownerId },
      context: integrationExec(tx.workspaceId, row.id, row.ownerId),
      ...(row.brandId ? { brandId: row.brandId } : {}),
    });
  }

  async #failed(tx: WorkspaceTransaction, row: Loaded, reason: string): Promise<void> {
    await this.#integrationEvent(tx, row, 'integrations.sync.failed', {
      connection_id: row.id,
      terminal_reason: reason,
    });
  }

  async #integrationAudit(
    tx: WorkspaceTransaction,
    row: Loaded,
    action: string,
    changes: ReturnType<typeof change.plain>[],
  ): Promise<void> {
    const ctx = integrationExec(tx.workspaceId, row.id, row.ownerId);
    await this.workWriter.write(
      tx,
      CommandContext.fromExecution(
        ctx,
        { kind: 'integration', ref: row.publicId },
        { brandId: row.brandId },
      ),
      {
        action,
        target: this.#target(row),
        changes,
      },
    );
  }
}
