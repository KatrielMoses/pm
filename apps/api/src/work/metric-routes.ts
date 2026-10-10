import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { MetricService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; metric?: string };

/**
 * The metrics model (5C, ADR-0030; 0D PL-40). Every response is computed for the person who asked,
 * from the live records and the one visibility predicate at that moment, and is never cached or
 * shared (`private, no-store`). A record the person cannot read is the same absence as one that
 * does not exist: it is never counted, labelled, ranked, or timed. Reading a metric, its records,
 * or its export changes nothing and carries no `Idempotency-Key`; asking for a reconciliation pass
 * only moves its schedule, and is for workspace administrators.
 */
export function registerMetrics(app: FastifyInstance, work: MetricService): void {
  const { m, caller, wrap } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const base = '/v1/workspaces/:ws/metrics';

  app.get(
    base,
    wrap(async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return nonResourceEnvelope(
        'metric_catalog',
        await work.listMetrics(caller(request), p(request).ws),
        m(request),
      );
    }),
  );
  app.get(
    `${base}/:metric`,
    wrap(async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return nonResourceEnvelope(
        'metric_result',
        await work.getMetric(caller(request), p(request).ws, p(request).metric, q(request)),
        m(request),
      );
    }),
  );
  app.get(
    `${base}/:metric/records`,
    wrap(async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return nonResourceEnvelope(
        'metric_records',
        await work.getMetricRecords(caller(request), p(request).ws, p(request).metric, q(request)),
        m(request),
      );
    }),
  );
  app.get(
    `${base}/:metric/export`,
    wrap(async (request, reply) => {
      const out = await work.exportMetric(
        caller(request),
        p(request).ws,
        p(request).metric,
        q(request),
      );
      return reply
        .header('cache-control', 'private, no-store')
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${out.filename}"`)
        .header('x-content-type-options', 'nosniff')
        .send(out.body);
    }),
  );
  app.post(
    `${base}:reconcile`,
    wrap(async (request, reply) => {
      const r = await work.requestReconcile(caller(request), p(request).ws);
      return reply
        .code(202)
        .header('cache-control', 'private, no-store')
        .send(nonResourceEnvelope('metric_reconcile', r, m(request)));
    }),
  );
}
