import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { McpAccessService, McpRpcRequest } from '@pm/work';
import { routeKit } from '../route-kit.ts';

export function registerMcp(app: FastifyInstance, work: McpAccessService): void {
  const { m, wrap, caller, mutation, fail, resource, split } = routeKit();
  const ws = (request: FastifyRequest) => (request.params as { ws?: string }).ws;
  const target = (request: FastifyRequest, key: string) =>
    (request.params as Record<string, string | undefined>)[key];

  app.get(
    '/v1/workspaces/:ws/oauth-clients',
    wrap(async (request) =>
      nonResourceEnvelope(
        'oauth_clients',
        await work.listOAuthClients(caller(request), ws(request)),
        m(request),
      ),
    ),
  );

  app.get('/v1/workspaces/:ws/mcp', async (_request, reply) =>
    reply.header('allow', 'POST').code(405).send(),
  );
  app.delete('/v1/workspaces/:ws/mcp', async (_request, reply) =>
    reply.header('allow', 'POST').code(405).send(),
  );
  app.post(
    '/v1/workspaces/:ws/oauth-clients',
    wrap(async (request, reply) => {
      const result = await work.createOAuthClient(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    '/v1/workspaces/:ws/oauth-clients/:client',
    wrap(async (request, reply) => {
      const t = split(target(request, 'client'));
      if (!t || t.verb !== 'revoke') return fail(request, reply, 'not_found');
      const result = await work.revokeOAuthClient(
        caller(request),
        ws(request),
        t.id,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    '/v1/workspaces/:ws/oauth-clients/:client/consent',
    wrap(async (request, reply) => {
      const client = target(request, 'client') ?? '';
      if (client.includes(':')) return fail(request, reply, 'not_found');
      const result = await work.grantOAuthConsent(
        caller(request),
        ws(request),
        client,
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    '/v1/workspaces/:ws/oauth-clients/:client/consent/revoke',
    wrap(async (request, reply) => {
      const client = target(request, 'client') ?? '';
      if (client.includes(':')) return fail(request, reply, 'not_found');
      const result = await work.revokeOAuthConsent(
        caller(request),
        ws(request),
        client,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    '/v1/workspaces/:ws/oauth-clients/:client/token',
    wrap(async (request, reply) => {
      const client = target(request, 'client') ?? '';
      if (client.includes(':')) return fail(request, reply, 'not_found');
      const body = request.body as { client_id?: unknown } | null;
      if (!body || body.client_id !== client) return fail(request, reply, 'not_found');
      const issued = await work.issueOAuthAccessToken(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return { ...issued.data, replayed: issued.replayed };
    }),
  );

  app.get(
    '/v1/workspaces/:ws/mcp/capabilities',
    wrap(async (request, reply) => {
      const accountId = request.auth?.account?.id;
      if (!request.delegation && !accountId) return fail(request, reply, 'unauthenticated');
      const limited = await work.limitMcp(
        request.delegation?.tokenId ?? `session:${accountId}`,
        false,
      );
      if (!limited.allowed)
        return fail(request, reply, 'rate_limited', {
          retryAfterSeconds: limited.retryAfterSeconds,
        });
      return nonResourceEnvelope(
        'mcp_capabilities',
        await work.getMcpCapabilities(caller(request), ws(request)),
        m(request),
      );
    }),
  );

  app.post(
    '/v1/workspaces/:ws/mcp',
    wrap(async (request, reply) => {
      if (!request.delegation) return fail(request, reply, 'unauthenticated');
      const accepts = request.headers.accept?.split(',').map((v) => v.trim().split(';')[0]);
      if (!accepts?.includes('application/json') || !accepts.includes('text/event-stream'))
        return reply.code(406).send();
      const body = request.body;
      const rpc: McpRpcRequest =
        body && typeof body === 'object' && !Array.isArray(body)
          ? (body as McpRpcRequest)
          : { jsonrpc: '2.0', id: null, method: '' };
      if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
        return reply.status(400).send({
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          error: { code: -32600, message: 'Invalid Request.' },
        });
      }
      const notification = !Object.prototype.hasOwnProperty.call(body, 'id');
      if (notification && !rpc.method.startsWith('notifications/')) return reply.code(202).send();
      const protocolVersion = request.headers['mcp-protocol-version'];
      if (
        protocolVersion !== undefined &&
        protocolVersion !== '2025-11-25' &&
        protocolVersion !== '2025-03-26'
      )
        return reply.code(400).send({
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          error: { code: -32600, message: 'Unsupported protocol version.' },
        });
      const write = rpc.method === 'tools/call' && work.mcpCallWrites(rpc.params);
      const limited = await work.limitMcp(request.delegation.tokenId, write);
      if (!limited.allowed)
        return fail(request, reply, 'rate_limited', {
          retryAfterSeconds: limited.retryAfterSeconds,
        });
      const out = await work.handleMcpRpc(caller(request), ws(request), rpc, mutation(request));
      if (notification) return reply.code(202).send();
      return reply.header('content-type', 'application/json').status(200).send(out);
    }),
  );
}
