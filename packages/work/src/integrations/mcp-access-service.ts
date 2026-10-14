import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  decideWorkspace,
  invalid,
  issue,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
  type TokenDelegation,
} from '@pm/tenancy';
import { CalendarService } from './calendar-service.ts';
import {
  hashEqual,
  newOAuthAccessSecret,
  newOAuthClientSecret,
  PERSONAL_SCOPES,
  tokenHash,
} from './semantics.ts';
import {
  MCP_PROTOCOL_VERSION,
  MCP_REGISTRY_VERSION,
  MCP_RESOURCES,
  MCP_TOOLS,
  resourceByUri,
  scopesAllowResource,
  scopesAllowTool,
  toolByName,
} from './mcp/registry.ts';
import { syntheticCaller } from './public-api-service.ts';

const OAUTH_ACCESS_TTL_MS = 60 * 60 * 1000;

interface OAuthAccessRow {
  workspace_id: string;
  workspace_public_id: string;
  token_id: string;
  client_id: string;
  client_public_id: string;
  consent_id: string;
  scopes: string[];
  brand_ids: string[] | null;
  expires_at: Date;
  membership_id: string;
  account_id: string;
  state: string;
}

export interface McpRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

export type McpRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

/**
 * MCP-compatible access (Phase 6E). JSON-RPC tools delegate to the same authorization paths as the
 * public API. OAuth access tokens act as `oauth_client` principals narrowed by consent.
 */
export class McpAccessService extends CalendarService {
  protected override async inWorkspace<T>(
    caller: Caller,
    workspacePublicId: unknown,
    options: { readOnly?: boolean },
    fn: (tx: WorkspaceTransaction, p: Principal & { workspaceState: string }) => Promise<T>,
  ): Promise<T> {
    return super.inWorkspace(caller, workspacePublicId, options, async (tx, principal) => {
      const delegation = caller.delegation;
      if (delegation?.principalType !== 'oauth_client' || !delegation.consentId)
        return fn(tx, principal);

      let liveQuery = tx.db
        .selectFrom('integrations.oauth_access_token as token')
        .innerJoin('integrations.oauth_consent as consent', 'consent.id', 'token.consent_id')
        .innerJoin('integrations.oauth_client as client', 'client.id', 'token.client_id')
        .select(['consent.scopes', 'consent.brand_ids'])
        .where('token.id', '=', delegation.tokenId)
        .where('token.consent_id', '=', delegation.consentId)
        .where('token.state', '=', 'active')
        .where('token.expires_at', '>', new Date())
        .where('consent.state', '=', 'active')
        .where('client.state', '=', 'active');
      if (!options.readOnly) liveQuery = liveQuery.forUpdate();
      const live = await liveQuery.executeTakeFirst();
      if (
        !live ||
        live.scopes.length !== delegation.scopes.length ||
        live.scopes.some((scope) => !delegation.scopes.includes(scope))
      )
        throw new TenancyError('not_found');

      // Consent changes can only narrow an already authenticated principal for this request.
      let narrowed = principal;
      if (live.brand_ids !== null) {
        const allow = new Set(live.brand_ids);
        if (principal.brandAllowlist !== null && principal.brandAllowlist !== undefined)
          for (const id of allow) if (!principal.brandAllowlist.has(id)) allow.delete(id);
        const projects = allow.size
          ? await tx.db
              .selectFrom('work.project')
              .select(['id'])
              .where('brand_id', 'in', [...allow])
              .execute()
          : [];
        const projectIds = new Set(projects.map((row) => row.id));
        narrowed = {
          ...principal,
          brandAllowlist: allow,
          grants: new Map([...principal.grants].filter(([id]) => allow.has(id))),
          grantSources: principal.grantSources.filter((source) => allow.has(source.brandId)),
          projectGrants: new Map([...principal.projectGrants].filter(([id]) => projectIds.has(id))),
          projectGrantSources: principal.projectGrantSources.filter((source) =>
            projectIds.has(source.projectId),
          ),
        };
      }
      return fn(tx, narrowed);
    });
  }

  mcpEnabled(): boolean {
    return this.ws.mcpEnabled;
  }

  async limitMcp(
    tokenId: string,
    write: boolean,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    return this.d.limiter.consume(write ? 'mcp.write' : 'mcp.read', tokenId);
  }

  mcpCallWrites(params: unknown): boolean {
    const name = (params as { name?: unknown } | null)?.name;
    const tool = typeof name === 'string' ? toolByName(name) : undefined;
    return tool?.mutating === true;
  }

  async authenticateOAuthAccessToken(secret: string): Promise<{
    delegation: TokenDelegation;
    accountId: string;
    workspaceId: string;
    workspacePublicId: string;
  } | null> {
    if (!secret.startsWith('pma_') || secret.length < 20) return null;
    const prefix = secret.slice(0, 12);
    const hash = tokenHash(secret);
    const row = await this.d.platform.withPlatform(
      { module: 'integrations', readOnly: true },
      async (tx) => {
        const res = await sql<OAuthAccessRow>`
        SELECT workspace_id, workspace_public_id, token_id, client_id, client_public_id, consent_id, scopes, brand_ids,
               expires_at, membership_id, account_id, state
          FROM integrations.resolve_oauth_access_token(${prefix}, ${hash})`.execute(tx.db);
        return res.rows[0] ?? null;
      },
    );
    if (!row || row.state !== 'active') return null;
    return {
      accountId: row.account_id,
      workspaceId: row.workspace_id,
      workspacePublicId: row.workspace_public_id,
      delegation: {
        tokenId: row.token_id,
        tokenPublicId: row.client_public_id,
        kind: 'oauth',
        principalType: 'oauth_client',
        scopes: row.scopes,
        brandIds: row.brand_ids,
        membershipId: row.membership_id,
        accountId: row.account_id,
        sourceKind: 'mcp',
        consentId: row.consent_id,
      },
    };
  }

  async getMcpCapabilities(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async () => ({
      protocol_version: MCP_PROTOCOL_VERSION,
      registry_version: MCP_REGISTRY_VERSION,
      mcp_enabled: this.mcpEnabled(),
      tools: MCP_TOOLS.map((t) => ({ name: t.name, version: t.version })),
      resources: MCP_RESOURCES.map((r) => ({ uri: r.uri, name: r.name })),
    }));
  }

  async listOAuthClients(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      if (caller.delegation) throw new TenancyError('forbidden');
      const configure = decideWorkspace(p, 'integrations.configure');
      this.decision('integrations.configure', configure);
      let query = tx.db
        .selectFrom('integrations.oauth_client')
        .select(['public_id as id', 'name', 'allowed_scopes', 'state', 'redirect_uris'])
        .where('state', '=', 'active')
        .orderBy('created_at', 'desc')
        .limit(this.ws.oauthClientsMax);
      if (!configure.allowed) {
        query = query
          .innerJoin('integrations.oauth_consent', (join) =>
            join
              .onRef('integrations.oauth_consent.client_id', '=', 'integrations.oauth_client.id')
              .on('integrations.oauth_consent.membership_id', '=', p.membershipId)
              .on('integrations.oauth_consent.state', '=', 'active'),
          )
          .select([
            'integrations.oauth_client.public_id as id',
            'integrations.oauth_client.name',
            'integrations.oauth_client.allowed_scopes',
            'integrations.oauth_client.state',
            'integrations.oauth_client.redirect_uris',
          ]);
      }
      const rows = await query.execute();
      const grants = await tx.db
        .selectFrom('integrations.oauth_consent as g')
        .innerJoin('integrations.oauth_client as c', 'c.id', 'g.client_id')
        .select(['c.public_id as client_id', 'g.scopes', 'g.state'])
        .where('g.membership_id', '=', p.membershipId)
        .where(
          'c.public_id',
          'in',
          rows.map((row) => row.id),
        )
        .execute();
      return {
        can_configure: configure.allowed,
        clients: rows.map((row) => {
          const grant = grants.find((item) => item.client_id === row.id);
          return { ...row, consent: grant ? { scopes: grant.scopes, state: grant.state } : null };
        }),
      };
    });
  }

  async createOAuthClient(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = this.#clientInput(body);
    return this.mutate(
      caller,
      'oauth_client.create',
      ws,
      req,
      async (tx, p) => {
        if (caller.delegation) throw new TenancyError('forbidden');
        this.#requireConfigure(p);
        await tx.db
          .selectFrom('tenancy.workspace')
          .select('id')
          .where('id', '=', p.workspaceId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const count = await tx.db
          .selectFrom('integrations.oauth_client')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('state', '=', 'active')
          .executeTakeFirstOrThrow();
        if (Number(count.count) >= this.ws.oauthClientsMax)
          throw new TenancyError('limit_exceeded');
        const minted = newOAuthClientSecret();
        const id = newUuidV7();
        const publicId = newPublicId('oac');
        await tx.db
          .insertInto('integrations.oauth_client')
          .values({
            id,
            workspace_id: p.workspaceId,
            public_id: publicId,
            name: input.name,
            client_prefix: minted.prefix,
            client_hash: tokenHash(minted.secret),
            redirect_uris: input.redirectUris,
            allowed_scopes: input.scopes,
            state: 'active',
            created_by_membership_id: p.membershipId,
          })
          .execute();
        await this.workEvent(
          tx,
          caller,
          p,
          'integrations.oauth_client.created',
          { type: 'oauth_client', id, sequence: 1 },
          { scope_count: input.scopes.length },
          null,
        );
        return {
          status: 201,
          ref: { id: publicId, type: 'oauth_client' },
          data: {
            id: publicId,
            type: 'oauth_client',
            name: input.name,
            allowed_scopes: input.scopes,
            redirect_uris: input.redirectUris,
            client_secret: minted.secret,
            state: 'active',
          },
        };
      },
      async (tx, p, ref) => {
        const row = await tx.db
          .selectFrom('integrations.oauth_client')
          .select(['public_id as id', 'name', 'allowed_scopes', 'state', 'redirect_uris'])
          .where('public_id', '=', ref.id)
          .executeTakeFirstOrThrow();
        return { ...row, type: 'oauth_client', client_secret: '' };
      },
    );
  }

  async revokeOAuthClient(caller: Caller, ws: unknown, clientId: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'oauth_client.revoke',
      ws,
      req,
      async (tx, p) => {
        if (caller.delegation) throw new TenancyError('forbidden');
        this.#requireConfigure(p);
        const row = await this.#loadClient(tx, p, clientId);
        if (row.state === 'revoked') throw new TenancyError('conflict');
        await tx.db
          .updateTable('integrations.oauth_client')
          .set({
            state: 'revoked',
            revoked_at: new Date(),
            updated_at: new Date(),
            version: sql`integrations.oauth_client.version + 1`,
          })
          .where('id', '=', row.id)
          .execute();
        const revokedConsents = await tx.db
          .updateTable('integrations.oauth_consent')
          .set({
            state: 'revoked',
            revoked_at: new Date(),
            updated_at: new Date(),
            version: sql`integrations.oauth_consent.version + 1`,
          })
          .where('client_id', '=', row.id)
          .where('state', '=', 'active')
          .returning(['id', 'public_id', 'version'])
          .execute();
        for (const consent of revokedConsents)
          await this.workEvent(
            tx,
            caller,
            p,
            'integrations.oauth_consent.revoked',
            { type: 'oauth_consent', id: consent.id, sequence: Number(consent.version) },
            {},
            null,
          );
        await this.workEvent(
          tx,
          caller,
          p,
          'integrations.oauth_client.revoked',
          { type: 'oauth_client', id: row.id, sequence: row.version + 1 },
          {},
          null,
        );
        return {
          status: 200,
          ref: { id: row.public_id, type: 'oauth_client' },
          data: { id: row.public_id, type: 'oauth_client', state: 'revoked' },
        };
      },
      async (tx, p, ref) => {
        const row = await tx.db
          .selectFrom('integrations.oauth_client')
          .select(['public_id as id', 'state'])
          .where('public_id', '=', ref.id)
          .executeTakeFirstOrThrow();
        return { ...row, type: 'oauth_client', client_secret: '' };
      },
    );
  }

  async grantOAuthConsent(
    caller: Caller,
    ws: unknown,
    clientId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = this.#consentInput(body);
    return this.mutate(
      caller,
      'oauth_consent.grant',
      ws,
      req,
      async (tx, p) => {
        if (caller.delegation) throw new TenancyError('forbidden');
        const client = await this.#loadClient(tx, p, clientId);
        if (client.state !== 'active') throw new TenancyError('not_found');
        for (const s of input.scopes) {
          if (!client.allowed_scopes.includes(s)) throw new TenancyError('forbidden');
          if (!(PERSONAL_SCOPES as readonly string[]).includes(s))
            throw invalid(issue('/scopes', 'invalid_option', 'Unknown scope.'));
        }
        let brandIds: string[] | null = null;
        if (input.brands !== null) {
          const brands = await tx.db
            .selectFrom('core.record')
            .select(['id', 'public_id'])
            .where('record_type', '=', 'brand')
            .where('public_id', 'in', input.brands)
            .execute();
          if (brands.length !== input.brands.length) throw new TenancyError('not_found');
          brandIds = brands.map((brand) => brand.id);
        }
        const id = newUuidV7();
        const consent = await tx.db
          .insertInto('integrations.oauth_consent')
          .values({
            id,
            workspace_id: p.workspaceId,
            public_id: newPublicId('ocs'),
            client_id: client.id,
            membership_id: p.membershipId,
            scopes: input.scopes,
            brand_ids: brandIds,
            state: 'active',
          })
          .onConflict((oc) =>
            oc.columns(['workspace_id', 'client_id', 'membership_id']).doUpdateSet({
              scopes: input.scopes,
              brand_ids: brandIds,
              state: 'active',
              revoked_at: null,
              updated_at: new Date(),
              version: sql`integrations.oauth_consent.version + 1`,
            }),
          )
          .returning(['id', 'public_id', 'version'])
          .executeTakeFirstOrThrow();
        await this.workEvent(
          tx,
          caller,
          p,
          'integrations.oauth_consent.granted',
          { type: 'oauth_consent', id: consent.id, sequence: Number(consent.version) },
          { scope_count: input.scopes.length, brand_count: brandIds?.length ?? 0 },
          null,
        );
        return {
          status: 200,
          ref: { id: client.public_id, type: 'oauth_client' },
          data: {
            id: client.public_id,
            type: 'oauth_consent',
            client_id: client.public_id,
            scopes: input.scopes,
            state: 'active',
          },
        };
      },
      async (tx, p, ref) => {
        const client = await this.#loadClient(tx, p, ref.id);
        const consent = await tx.db
          .selectFrom('integrations.oauth_consent')
          .select(['state', 'scopes'])
          .where('client_id', '=', client.id)
          .where('membership_id', '=', p.membershipId)
          .executeTakeFirstOrThrow();
        return {
          id: ref.id,
          type: 'oauth_consent',
          client_id: ref.id,
          scopes: consent.scopes,
          state: consent.state,
        };
      },
    );
  }

  async issueOAuthAccessToken(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const clientPublicId =
      typeof (body as { client_id?: unknown }).client_id === 'string'
        ? (body as { client_id: string }).client_id
        : '';
    const secret =
      typeof (body as { client_secret?: unknown }).client_secret === 'string'
        ? (body as { client_secret: string }).client_secret
        : '';
    if (!clientPublicId || !secret) throw new TenancyError('validation_failed');
    return this.mutate(
      caller,
      'oauth_access_token.issue',
      ws,
      req,
      async (tx, p) => {
        if (caller.delegation) throw new TenancyError('forbidden');
        const client = await this.#loadClient(tx, p, clientPublicId);
        if (!secret.startsWith('oac_')) throw new TenancyError('unauthenticated');
        const prefix = secret.slice(0, 12);
        if (prefix !== client.client_prefix || !hashEqual(tokenHash(secret), client.client_hash))
          throw new TenancyError('unauthenticated');
        const consent = await tx.db
          .selectFrom('integrations.oauth_consent')
          .selectAll()
          .where('client_id', '=', client.id)
          .where('membership_id', '=', p.membershipId)
          .where('state', '=', 'active')
          .executeTakeFirst();
        if (!consent) throw new TenancyError('forbidden');
        const minted = newOAuthAccessSecret();
        const tokenId = newUuidV7();
        const publicId = newPublicId('oat');
        await tx.db
          .insertInto('integrations.oauth_access_token')
          .values({
            id: tokenId,
            workspace_id: p.workspaceId,
            public_id: publicId,
            consent_id: consent.id,
            client_id: client.id,
            token_prefix: minted.prefix,
            token_hash: tokenHash(minted.secret),
            expires_at: new Date(Date.now() + OAUTH_ACCESS_TTL_MS),
            state: 'active',
          })
          .execute();
        await this.workEvent(
          tx,
          caller,
          p,
          'integrations.oauth_access_token.issued',
          { type: 'oauth_access_token', id: tokenId, sequence: 1 },
          { expires_in: Math.floor(OAUTH_ACCESS_TTL_MS / 1000) },
          null,
        );
        return {
          status: 201,
          ref: { id: publicId, type: 'oauth_access_token' },
          data: {
            id: publicId,
            type: 'oauth_access_token',
            access_token: minted.secret as string | null,
            token_type: 'Bearer' as const,
            expires_in: Math.floor(OAUTH_ACCESS_TTL_MS / 1000),
            state: 'active' as 'active' | 'revoked',
          },
        };
      },
      async (tx, _p, ref) => {
        const row = await tx.db
          .selectFrom('integrations.oauth_access_token')
          .select('state')
          .where('public_id', '=', ref.id)
          .executeTakeFirstOrThrow();
        return {
          id: ref.id,
          type: 'oauth_access_token',
          access_token: null,
          token_type: 'Bearer' as const,
          expires_in: 0,
          state: row.state,
        };
      },
    );
  }

  async revokeOAuthConsent(caller: Caller, ws: unknown, clientId: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'oauth_consent.revoke',
      ws,
      req,
      async (tx, p) => {
        if (caller.delegation) throw new TenancyError('forbidden');
        const client = await this.#loadClient(tx, p, clientId);
        const consent = await tx.db
          .selectFrom('integrations.oauth_consent')
          .select(['id', 'public_id', 'version'])
          .where('client_id', '=', client.id)
          .where('membership_id', '=', p.membershipId)
          .where('state', '=', 'active')
          .executeTakeFirst();
        if (!consent) throw new TenancyError('not_found');
        const revoked = await tx.db
          .updateTable('integrations.oauth_consent')
          .set({
            state: 'revoked',
            revoked_at: new Date(),
            updated_at: new Date(),
            version: sql`integrations.oauth_consent.version + 1`,
          })
          .where('id', '=', consent.id)
          .returning('version')
          .executeTakeFirstOrThrow();
        await this.workEvent(
          tx,
          caller,
          p,
          'integrations.oauth_consent.revoked',
          { type: 'oauth_consent', id: consent.id, sequence: Number(revoked.version) },
          {},
          null,
        );
        return {
          status: 200,
          ref: { id: client.public_id, type: 'oauth_consent' },
          data: {
            id: client.public_id,
            type: 'oauth_consent',
            client_id: client.public_id,
            state: 'revoked',
          },
        };
      },
      async (tx, p, ref) => {
        const client = await this.#loadClient(tx, p, ref.id);
        const consent = await tx.db
          .selectFrom('integrations.oauth_consent')
          .select('state')
          .where('client_id', '=', client.id)
          .where('membership_id', '=', p.membershipId)
          .executeTakeFirstOrThrow();
        return {
          id: ref.id,
          type: 'oauth_consent',
          client_id: ref.id,
          state: consent.state,
        };
      },
    );
  }

  async handleMcpRpc(
    caller: Caller,
    ws: unknown,
    req: McpRpcRequest,
    mutationReq: Mutation,
  ): Promise<McpRpcResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<McpRpcResponse>((resolve) => {
      timer = setTimeout(
        () => resolve(rpcError(req.id, -32003, 'Request timed out.')),
        this.ws.mcpToolCallTimeoutMs,
      );
      timer.unref?.();
    });
    try {
      const response = await Promise.race([
        this.#dispatchMcpRpc(caller, ws, req, mutationReq),
        timeout,
      ]);
      if ('error' in response && response.error.code === -32003)
        await this.#logInvocation(caller, ws, req, 'timeout', this.ws.mcpToolCallTimeoutMs);
      return response;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #dispatchMcpRpc(
    caller: Caller,
    ws: unknown,
    req: McpRpcRequest,
    mutationReq: Mutation,
  ): Promise<McpRpcResponse> {
    if (!this.mcpEnabled()) {
      await this.#logInvocation(caller, ws, req, 'denied', 0, 'not_configured');
      return rpcError(req.id, -32000, 'MCP access is not configured.');
    }
    const started = Date.now();
    try {
      await this.inWorkspace(caller, ws, { readOnly: true }, async () => undefined);
      switch (req.method) {
        case 'initialize': {
          const requested = (req.params as { protocolVersion?: unknown } | undefined)
            ?.protocolVersion;
          if (requested !== MCP_PROTOCOL_VERSION && requested !== '2025-03-26')
            return rpcError(req.id, -32602, 'Unsupported protocol version.');
          return this.#loggedOk(caller, ws, req, started, {
            protocolVersion: requested,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'pm', version: MCP_REGISTRY_VERSION },
          });
        }
        case 'tools/list':
          return this.#loggedOk(caller, ws, req, started, { tools: this.#visibleTools(caller) });
        case 'resources/list':
          return this.#loggedOk(caller, ws, req, started, {
            resources: this.#visibleResources(caller),
          });
        case 'resources/read':
          return this.#loggedOk(
            caller,
            ws,
            req,
            started,
            await this.#readResource(caller, ws, req.params),
          );
        case 'tools/call':
          return rpcOk(req.id, await this.#callTool(caller, ws, req.params, mutationReq));
        case 'ping':
          return this.#loggedOk(caller, ws, req, started, {});
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return this.#loggedOk(caller, ws, req, started, {});
        default:
          return rpcError(req.id, -32601, 'Method not found.');
      }
    } catch (err) {
      const message =
        err instanceof TenancyError
          ? err.code === 'not_found'
            ? 'Not found.'
            : err.code === 'forbidden'
              ? 'Forbidden.'
              : 'Request failed.'
          : 'Request failed.';
      await this.#logInvocation(caller, ws, req, 'error', Date.now() - started, message);
      if (err instanceof TenancyError && err.code === 'validation_failed')
        return rpcError(req.id, -32602, 'Invalid parameters.');
      if (err instanceof TenancyError && err.code === 'limit_exceeded')
        return rpcError(req.id, -32004, 'Result or request limit exceeded.');
      if (err instanceof TenancyError && err.code === 'not_found')
        return rpcError(req.id, -32001, 'Not found.');
      if (err instanceof TenancyError && err.code === 'forbidden')
        return rpcError(req.id, -32002, 'Forbidden.');
      return rpcError(req.id, -32603, message);
    }
  }

  async #callTool(caller: Caller, ws: unknown, params: unknown, mutationReq: Mutation) {
    const p = params as {
      name?: string;
      arguments?: Record<string, unknown>;
      _meta?: { idempotencyKey?: string };
    };
    const tool = toolByName(String(p.name ?? ''));
    if (!tool) throw new TenancyError('not_found');
    validateToolArguments(tool.inputSchema, p.arguments);
    const held = caller.delegation?.scopes ?? [];
    if (!scopesAllowTool(held, tool)) throw new TenancyError('forbidden');
    const idem = p._meta?.idempotencyKey;
    const mutating = tool.mutating;
    if (mutating && (typeof idem !== 'string' || idem.length < 16 || idem.length > 128))
      throw invalid(
        issue('/_meta/idempotencyKey', 'required', 'A valid idempotency key is required.'),
      );
    if (tool.destructive && p.arguments?.confirm !== true)
      throw new TenancyError('validation_failed');
    const mut: Mutation = idem ? { ...mutationReq, idempotencyKey: idem } : mutationReq;
    const started = Date.now();
    let result: unknown;
    switch (tool.name) {
      case 'pm.tasks.list': {
        const q: Record<string, unknown> = {};
        if (typeof p.arguments?.limit === 'number') q.limit = p.arguments.limit;
        if (typeof p.arguments?.cursor === 'string') q.cursor = p.arguments.cursor;
        if (typeof p.arguments?.brand === 'string') q.brand = p.arguments.brand;
        const page = await this.listTasks(caller, ws, q);
        result = { tasks: page.data, page: page.page };
        break;
      }
      case 'pm.tasks.get': {
        const task = await this.getTask(caller, ws, p.arguments?.task_id);
        result = { task };
        break;
      }
      case 'pm.tasks.create': {
        const created = await this.createTask(caller, ws, p.arguments ?? {}, mut);
        result = { task: created.data };
        break;
      }
      case 'pm.tasks.complete': {
        const done = await this.completeTask(
          caller,
          ws,
          p.arguments?.task_id,
          { confirm: true },
          mut,
        );
        result = { task: done.data };
        break;
      }
      default:
        throw new TenancyError('not_found');
    }
    await this.#logInvocation(
      caller,
      ws,
      { method: 'tools/call', params },
      'ok',
      Date.now() - started,
    );
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text, 'utf8') > this.ws.mcpToolResultMaxBytes)
      throw new TenancyError('limit_exceeded');
    return {
      content: [{ type: 'text', text }],
      isError: false,
      _meta: { actor_type: caller.delegation?.principalType ?? 'membership', source: 'mcp' },
    };
  }

  async #readResource(caller: Caller, ws: unknown, params: unknown) {
    const uri = String((params as { uri?: string }).uri ?? '');
    const resource = resourceByUri(uri);
    if (!resource) throw new TenancyError('not_found');
    const held = caller.delegation?.scopes ?? [];
    if (!scopesAllowResource(held, resource)) throw new TenancyError('forbidden');
    let text = '';
    if (uri === 'pm://workspace/mcp/capabilities') {
      const caps = await this.getMcpCapabilities(caller, ws);
      text = JSON.stringify(caps);
    } else if (uri === 'pm://workspace/mcp/help') {
      text = [
        '# MCP access',
        '',
        'Connect with a workspace OAuth client and a member consent grant.',
        'Send JSON-RPC to `POST /v1/workspaces/{workspace}/mcp` with `Authorization: Bearer pma_…`.',
        'Mutating tools accept `_meta.idempotencyKey` in tool arguments.',
        'Destructive tools require `confirm: true`.',
      ].join('\n');
    }
    if (Buffer.byteLength(text, 'utf8') > this.ws.mcpToolResultMaxBytes)
      throw new TenancyError('limit_exceeded');
    return { contents: [{ uri, mimeType: resource.mimeType, text }] };
  }

  #visibleTools(caller: Caller) {
    const held = caller.delegation?.scopes ?? [];
    return MCP_TOOLS.filter((t) => scopesAllowTool(held, t)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  #visibleResources(caller: Caller) {
    const held = caller.delegation?.scopes ?? [];
    return MCP_RESOURCES.filter((r) => scopesAllowResource(held, r)).map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  async #loggedOk(
    caller: Caller,
    ws: unknown,
    req: McpRpcRequest,
    started: number,
    result: unknown,
  ): Promise<McpRpcResponse> {
    await this.#logInvocation(caller, ws, req, 'ok', Date.now() - started);
    return rpcOk(req.id, result);
  }

  async #logInvocation(
    caller: Caller,
    ws: unknown,
    req: { method: string; params?: unknown },
    outcome: 'ok' | 'error' | 'timeout' | 'denied',
    durationMs: number,
    detail?: string,
  ) {
    const toolName =
      req.method === 'tools/call' && typeof (req.params as { name?: string }).name === 'string'
        ? (req.params as { name: string }).name
        : req.method;
    await super.inWorkspace(caller, ws, {}, async (tx, p) => {
      const member = await tx.db
        .selectFrom('tenancy.membership')
        .select('public_id')
        .where('id', '=', p.membershipId)
        .executeTakeFirstOrThrow();
      await tx.db
        .insertInto('integrations.mcp_invocation')
        .values({
          id: newUuidV7(),
          workspace_id: tx.workspaceId,
          public_id: newPublicId('mci'),
          consent_id: caller.delegation?.consentId ?? null,
          token_id: caller.delegation?.tokenId ?? null,
          actor_membership_id: p.membershipId,
          actor_principal: caller.delegation?.principalType ?? 'member',
          actor_public_id: caller.delegation?.tokenPublicId ?? member.public_id,
          tool_name: toolName.slice(0, 80),
          tool_version: toolByName(toolName)?.version ?? MCP_REGISTRY_VERSION,
          outcome,
          duration_ms: durationMs,
          detail: detail?.slice(0, 80) ?? null,
        })
        .execute();
    });
  }

  #requireConfigure(p: Principal) {
    const o = decideWorkspace(p, 'integrations.configure');
    this.decision('integrations.configure', o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  #clientInput(body: unknown) {
    if (!body || typeof body !== 'object') throw invalid(issue('/', 'required', 'Body required.'));
    const b = body as Record<string, unknown>;
    if (typeof b.name !== 'string' || !b.name.trim())
      throw invalid(issue('/name', 'required', 'Name is required.'));
    if (b.name.trim().length > 80) throw invalid(issue('/name', 'max_length', 'Name is too long.'));
    const rawRedirects = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    const redirectUris = rawRedirects.filter((u): u is string => {
      if (typeof u !== 'string') return false;
      try {
        return new URL(u).protocol === 'https:';
      } catch {
        return false;
      }
    });
    if (
      !redirectUris.length ||
      redirectUris.length !== rawRedirects.length ||
      redirectUris.length > 8
    )
      throw invalid(issue('/redirect_uris', 'required', 'At least one HTTPS redirect URI.'));
    const scopes = Array.isArray(b.scopes) ? b.scopes : [];
    if (
      !scopes.length ||
      scopes.length > 19 ||
      scopes.length > 19 ||
      scopes.some(
        (s) => typeof s !== 'string' || !(PERSONAL_SCOPES as readonly string[]).includes(s),
      ) ||
      new Set(scopes).size !== scopes.length
    )
      throw invalid(issue('/scopes', 'invalid_option', 'Choose allowed scopes.'));
    return {
      name: b.name.trim(),
      redirectUris,
      scopes: scopes as string[],
    };
  }

  #consentInput(body: unknown) {
    if (!body || typeof body !== 'object') throw invalid(issue('/', 'required', 'Body required.'));
    const b = body as Record<string, unknown>;
    const scopes = Array.isArray(b.scopes) ? b.scopes : [];
    if (
      !scopes.length ||
      scopes.some((s) => typeof s !== 'string') ||
      new Set(scopes).size !== scopes.length
    )
      throw invalid(issue('/scopes', 'required', 'Choose unique scopes.'));
    let brands: string[] | null = null;
    if (b.brands !== undefined) {
      if (
        !Array.isArray(b.brands) ||
        b.brands.length === 0 ||
        b.brands.length > 100 ||
        b.brands.some((brand) => typeof brand !== 'string') ||
        new Set(b.brands).size !== b.brands.length
      )
        throw invalid(issue('/brands', 'invalid_type', 'Choose valid brands.'));
      brands = b.brands as string[];
    }
    return { scopes: scopes as string[], brands };
  }

  async #loadClient(tx: WorkspaceTransaction, p: Principal, clientId: unknown) {
    const id = String(clientId ?? '');
    const row = await tx.db
      .selectFrom('integrations.oauth_client')
      .selectAll()
      .where('public_id', '=', id)
      .executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    return row;
  }
}

function rpcOk(id: McpRpcRequest['id'], result: unknown): McpRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function validateToolArguments(
  schema: Record<string, unknown>,
  input: unknown,
): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw invalid(issue('/arguments', 'invalid_type', 'Arguments must be an object.'));
  const values = input as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const key of required) {
    if (typeof key === 'string' && !(key in values))
      throw invalid(issue(`/arguments/${key}`, 'required', 'A required argument is missing.'));
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(values)) {
      if (!(key in properties))
        throw invalid(issue(`/arguments/${key}`, 'unknown', 'Unknown argument.'));
    }
  }
  for (const [key, value] of Object.entries(values)) {
    const def = properties[key];
    if (!def) continue;
    const type = def.type;
    const valid =
      type === 'string'
        ? typeof value === 'string'
        : type === 'integer'
          ? Number.isInteger(value)
          : type === 'number'
            ? typeof value === 'number' && Number.isFinite(value)
            : type === 'boolean'
              ? typeof value === 'boolean'
              : true;
    if (!valid)
      throw invalid(issue(`/arguments/${key}`, 'invalid_type', 'Argument has the wrong type.'));
    if (typeof value === 'number') {
      if (typeof def.minimum === 'number' && value < def.minimum)
        throw invalid(issue(`/arguments/${key}`, 'min_value', 'Argument is below its minimum.'));
      if (typeof def.maximum === 'number' && value > def.maximum)
        throw invalid(issue(`/arguments/${key}`, 'max_value', 'Argument exceeds its maximum.'));
    }
    if (
      typeof value === 'string' &&
      typeof def.maxLength === 'number' &&
      value.length > def.maxLength
    )
      throw invalid(issue(`/arguments/${key}`, 'max_length', 'Argument is too long.'));
  }
}

function rpcError(id: McpRpcRequest['id'], code: number, message: string): McpRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function oauthSyntheticCaller(
  accountId: string,
  delegation: TokenDelegation,
  meta: { correlationId: string },
): Caller {
  return syntheticCaller(accountId, delegation, meta);
}
