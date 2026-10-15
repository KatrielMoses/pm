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
    `${base}/imports/mappings`,
    wrap(async (request, reply) => {
      const data = await work.listImportMappings(caller(request), p(request).ws);
      return reply
        .code(200)
        .header('cache-control', 'private, no-store')
        .send(nonResourceEnvelope('portability_import_mappings', { mappings: data }, m(request)));
    }),
  );
  app.post(
    `${base}/imports/mappings`,
    wrap(async (request, reply) => {
      const data = await work.saveImportMapping(caller(request), p(request).ws, request.body);
      return reply
        .code(201)
        .header('cache-control', 'private, no-store')
        .send(nonResourceEnvelope('portability_import_mapping', { mapping: data }, m(request)));
    }),
  );
  app.delete(
    `${base}/imports/mappings/:mapping`,
    wrap(async (request, reply) => {
      const mapping = (request.params as { mapping?: string }).mapping;
      const data = await work.deleteImportMapping(caller(request), p(request).ws, mapping);
      return reply
        .code(200)
        .header('cache-control', 'private, no-store')
        .send(nonResourceEnvelope('portability_import_mapping', data, m(request)));
    }),
  );
  app.get(
    `${base}/exports/:entity.csv`,
    wrap(async (request, reply) => {
      const entity = (request.params as { entity?: string }).entity ?? '';
      const result = ['comments', 'time', 'task_activity', 'project_activity'].includes(entity)
        ? await work.exportPortabilityHistory(caller(request), p(request).ws, entity, request.query)
        : await work.exportPortabilityCsv(caller(request), p(request).ws, entity);
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
    { bodyLimit: 5 * 1024 * 1024 },
    wrap(async (request, reply) => {
      const data = await work.previewPortabilityImportFor(
        caller(request),
        p(request).ws,
        request.body,
      );
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
    { bodyLimit: 5 * 1024 * 1024 },
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
  app.post(
    `${base}/imports/:job/rollback`,
    wrap(async (request, reply) => {
      const job = (request.params as { job?: string }).job;
      const result = await work.rollbackPortabilityImport(
        caller(request),
        p(request).ws,
        job,
        mutation(request),
      );
      return reply
        .code(200)
        .header('cache-control', 'private, no-store')
        .send(nonResourceEnvelope('portability_import', result, m(request)));
    }),
  );
}
