import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { SearchService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; handle?: string };

/**
 * Permission-aware search (5A, ADR-0028; 0D PL-38). Every response is computed for the person who
 * asked, from the live authority at that moment, and is never cached or shared (`private,
 * no-store`). A record the person cannot read is the same absence as one that does not exist: it
 * is never counted, ranked, excerpted, or faceted, and opening it is `not_found`. Searching and
 * opening carry no `Idempotency-Key` (they change nothing); remembering a search is the person's
 * own hint, like the 1E recents.
 */
export function registerSearch(app: FastifyInstance, work: SearchService): void {
  const { m, caller, wrap } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws/search';

  app.get(
    ws,
    wrap(async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return nonResourceEnvelope(
        'search_results',
        await work.search(caller(request), p(request).ws, q(request)),
        m(request),
      );
    }),
  );
  app.get(
    `${ws}/status`,
    wrap(async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return nonResourceEnvelope(
        'search_status',
        await work.searchStatus(caller(request), p(request).ws),
        m(request),
      );
    }),
  );
  app.post(
    `${ws}/open`,
    wrap(async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return nonResourceEnvelope(
        'search_open',
        await work.openResult(caller(request), p(request).ws, request.body),
        m(request),
      );
    }),
  );
  app.get(
    `${ws}/recent`,
    wrap(async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return nonResourceEnvelope(
        'search_recent',
        { data: await work.listRecentSearches(caller(request), p(request).ws) },
        m(request),
      );
    }),
  );
  app.post(
    `${ws}/recent`,
    wrap(async (request, reply) => {
      const r = await work.recordRecentSearch(caller(request), p(request).ws, request.body);
      return reply
        .code(202)
        .header('cache-control', 'private, no-store')
        .send(nonResourceEnvelope('search_recent', r, m(request)));
    }),
  );
  app.delete(
    `${ws}/recent`,
    wrap(async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return nonResourceEnvelope(
        'search_recent',
        await work.clearRecentSearches(caller(request), p(request).ws),
        m(request),
      );
    }),
  );
  app.delete(
    `${ws}/recent/:handle`,
    wrap(async (request, reply) => {
      await work.clearRecentSearches(caller(request), p(request).ws, p(request).handle);
      return reply.code(204).send();
    }),
  );
}
