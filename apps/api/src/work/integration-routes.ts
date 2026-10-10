import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope, type NonResourceType } from '@pm/contracts';
import type { IntegrationService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; conn?: string; cnf?: string; ext?: string };

/**
 * Integration connections (6A, ADR-0032). Credentials never appear in a response. Unsafe requests
 * carry Idempotency-Key. Every response is private and uncached.
 */
export function registerIntegrations(app: FastifyInstance, work: IntegrationService): void {
  const { m, caller, mutation, wrap, resource } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const ws = '/v1/workspaces/:ws';
  const done = (
    request: FastifyRequest,
    reply: FastifyReply,
    r: { data: { id: string; type: string; version?: number }; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);
  const flat = (
    request: FastifyRequest,
    reply: FastifyReply,
    type: NonResourceType,
    data: Record<string, unknown>,
  ) =>
    reply
      .code(200)
      .header('cache-control', 'private, no-store')
      .send(nonResourceEnvelope(type, data, m(request)));

  app.get(
    `${ws}/integrations/providers`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'integration_providers',
        (await work.listProviders(caller(request), p(request).ws)) as unknown as Record<
          string,
          unknown
        >,
      ),
    ),
  );
  app.get(
    `${ws}/integrations/connections`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'integration_connections',
        (await work.listConnections(caller(request), p(request).ws)) as unknown as Record<
          string,
          unknown
        >,
      ),
    ),
  );
  app.post(
    `${ws}/integrations/connections`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createConnection(
          caller(request),
          p(request).ws,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/integrations/connections:rotate`,
    wrap(async (request, reply) => {
      const r = await work.rotateCredentials(caller(request), p(request).ws, mutation(request));
      return flat(request, reply, 'integration_rotation', r.data as Record<string, unknown>);
    }),
  );
  app.get(
    `${ws}/integrations/connections/:conn`,
    wrap(async (request, reply) =>
      done(request, reply, {
        data: await work.getConnection(caller(request), p(request).ws, p(request).conn),
        status: 200,
        replayed: false,
      }),
    ),
  );
  app.post(
    `${ws}/integrations/connections/:conn/oauth:complete`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.completeOauth(
          caller(request),
          p(request).ws,
          p(request).conn,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/integrations/connections/:conn:test`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.testConnection(
          caller(request),
          p(request).ws,
          p(request).conn,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/integrations/connections/:conn:reauthorize`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.reauthorize(
          caller(request),
          p(request).ws,
          p(request).conn,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/integrations/connections/:conn:disconnect`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.disconnect(
          caller(request),
          p(request).ws,
          p(request).conn,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/integrations/connections/:conn:sync`,
    wrap(async (request, reply) => {
      const r = await work.syncNow(
        caller(request),
        p(request).ws,
        p(request).conn,
        mutation(request),
      );
      return flat(request, reply, 'sync_runs', r.data as Record<string, unknown>);
    }),
  );
  app.get(
    `${ws}/integrations/connections/:conn/runs`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'sync_runs',
        (await work.listRuns(caller(request), p(request).ws, p(request).conn)) as unknown as Record<
          string,
          unknown
        >,
      ),
    ),
  );
  app.get(
    `${ws}/integrations/connections/:conn/conflicts`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'sync_conflicts',
        (await work.listConflicts(
          caller(request),
          p(request).ws,
          p(request).conn,
        )) as unknown as Record<string, unknown>,
      ),
    ),
  );
  app.post(
    `${ws}/integrations/connections/:conn/conflicts/:cnf:resolve`,
    wrap(async (request, reply) => {
      const r = await work.resolveConflict(
        caller(request),
        p(request).ws,
        p(request).conn,
        p(request).cnf,
        request.body,
        mutation(request),
      );
      return flat(request, reply, 'sync_conflicts', r.data as Record<string, unknown>);
    }),
  );
  app.post(
    `${ws}/integrations/connections/:conn/identities/:ext:local`,
    wrap(async (request, reply) => {
      const r = await work.editLocal(
        caller(request),
        p(request).ws,
        p(request).conn,
        p(request).ext,
        request.body,
        mutation(request),
      );
      return flat(request, reply, 'sync_conflicts', r.data as Record<string, unknown>);
    }),
  );
}
