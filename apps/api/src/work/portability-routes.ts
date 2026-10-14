import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { PortabilityService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string };

export function registerPortability(app: FastifyInstance, work: PortabilityService): void {
  const { m, caller, mutation, wrap } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const base = '/v1/workspaces/:ws/portability';
  app.get(
    `${base}/exports/:entity.csv`,
    wrap(async (request, reply) => {
      const entity = (request.params as { entity?: string }).entity ?? '';
      const result = await work.exportPortabilityCsv(caller(request), p(request).ws, entity);
      return reply
        .code(200)
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${result.filename}"`)
        .header('cache-control', 'private, no-store')
        .send(result.csv);
    }),
  );
  app.post(
    `${base}/imports/preview`,
    wrap(async (request, reply) => {
      const data = work.previewPortabilityImport(request.body);
      return reply
        .code(200)
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'portability_import_preview',
            data as unknown as Record<string, unknown>,
            m(request),
          ),
        );
    }),
  );
  app.post(
    `${base}/imports`,
    wrap(async (request, reply) => {
      const data = await work.applyPortabilityImport(
        caller(request),
        p(request).ws,
        request.body,
        mutation(request),
      );
      return reply
        .code(200)
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'portability_import',
            data as unknown as Record<string, unknown>,
            m(request),
          ),
        );
    }),
  );
}
