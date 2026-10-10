import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { PublicApiService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

/**
 * Session routes for tokens and webhooks, plus the unauthenticated inbound hook. Bearer calls to
 * the existing record routes are authenticated in the session pipeline and still use canonical
 * authorization.
 */
export function registerPublicApi(app: FastifyInstance, work: PublicApiService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();

  app.addHook('preParsing', (request, _reply, payload, done) => {
    if (!request.url.startsWith('/v1/hooks/')) {
      done(null, payload);
      return;
    }
    const chunks: Buffer[] = [];
    payload.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    payload.on('end', () => {
      const raw = Buffer.concat(chunks);
      (request as FastifyRequest & { rawBody?: string }).rawBody = raw.toString('utf8');
      done(null, Readable.from([raw]));
    });
    payload.on('error', (err) => done(err));
  });

  const ws = (request: FastifyRequest) => (request.params as { ws?: string }).ws;
  const target = (request: FastifyRequest, key: string) =>
    (request.params as Record<string, string | undefined>)[key];

  app.get(
    '/v1/workspaces/:ws/api-tokens',
    wrap(async (request) =>
      nonResourceEnvelope(
        'api_tokens',
        await work.listTokens(caller(request), ws(request)),
        m(request),
      ),
    ),
  );
  app.post(
    '/v1/workspaces/:ws/api-tokens',
    wrap(async (request, reply) => {
      const result = await work.createToken(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    '/v1/workspaces/:ws/api-tokens/:token',
    wrap(async (request, reply) => {
      const t = split(target(request, 'token'));
      if (!t || (t.verb !== 'revoke' && t.verb !== 'rotate'))
        return fail(request, reply, 'not_found');
      const result =
        t.verb === 'revoke'
          ? await work.revokeToken(caller(request), ws(request), t.id, mutation(request))
          : await work.rotateToken(caller(request), ws(request), t.id, mutation(request));
      return resource(request, reply, result.data, result);
    }),
  );

  app.get(
    '/v1/workspaces/:ws/webhook-subscriptions',
    wrap(async (request) =>
      nonResourceEnvelope(
        'webhook_subscriptions',
        await work.listSubscriptions(caller(request), ws(request)),
        m(request),
      ),
    ),
  );
  app.post(
    '/v1/workspaces/:ws/webhook-subscriptions',
    wrap(async (request, reply) => {
      const result = await work.createSubscription(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    '/v1/workspaces/:ws/webhook-subscriptions/:sub',
    wrap(async (request, reply) => {
      const t = split(target(request, 'sub'));
      if (!t || (t.verb !== 'rotate-secret' && t.verb !== 'test'))
        return fail(request, reply, 'not_found');
      const result =
        t.verb === 'test'
          ? await work.testSubscription(caller(request), ws(request), t.id, mutation(request))
          : await work.rotateSubscriptionSecret(
              caller(request),
              ws(request),
              t.id,
              mutation(request),
            );
      return resource(request, reply, result.data, result);
    }),
  );
  app.get(
    '/v1/workspaces/:ws/webhook-subscriptions/:sub/deliveries',
    wrap(async (request, reply) => {
      const sub = target(request, 'sub') ?? '';
      if (sub.includes(':')) return fail(request, reply, 'not_found');
      return nonResourceEnvelope(
        'webhook_deliveries',
        await work.listDeliveries(caller(request), ws(request), sub),
        m(request),
      );
    }),
  );
  app.post(
    '/v1/workspaces/:ws/webhook-deliveries/:delivery',
    wrap(async (request, reply) => {
      const t = split(target(request, 'delivery'));
      if (!t || t.verb !== 'replay') return fail(request, reply, 'not_found');
      const result = await work.replayDelivery(
        caller(request),
        ws(request),
        t.id,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    '/v1/workspaces/:ws/inbound-endpoints',
    wrap(async (request, reply) => {
      const result = await work.createInbound(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );

  app.post('/v1/hooks/:token', async (request, reply) => {
    const token = target(request, 'token') ?? '';
    const raw = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const outcome = await work.receiveInbound(
      token,
      {
        signature: header(request, 'webhook-signature'),
        timestamp: header(request, 'webhook-timestamp'),
        contentType: header(request, 'content-type'),
      },
      raw,
      { requestId: request.pm.requestId, correlationId: request.pm.correlationId },
    );
    if (outcome === 'unauthenticated') {
      return reply.code(401).send({
        error: {
          code: 'unauthenticated',
          status: 401,
          message: 'Sign in to continue.',
          retryable: false,
          request_id: request.pm.requestId,
          correlation_id: request.pm.correlationId,
        },
      });
    }
    return reply.code(202).send();
  });
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}
