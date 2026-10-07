import type { FastifyInstance } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { LayoutService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

/**
 * Core view layout reads (3B, ADR-0020; 0D PL-30). Each one takes the view's query AST and adds
 * layout facts only for records the caller's own compiled query returns: workload totals, Gantt
 * dependencies, milestones, portfolio progress, the caller's own time, and activity. POST keeps
 * the AST out of URLs and logs.
 */
export function registerLayouts(app: FastifyInstance, work: LayoutService): void {
  const { m, caller, wrap } = routeKit();
  const ws = '/v1/workspaces/:ws';
  const p = (request: { params: unknown }) => request.params as { ws?: string };
  app.post(
    `${ws}/tasks::workload`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'view_workload',
        await work.workload(caller(request), p(request).ws, request.body),
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/tasks::dependencies`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'view_dependencies',
        await work.dependencies(caller(request), p(request).ws, request.body),
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/tasks::my_time`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'view_time',
        await work.myTime(caller(request), p(request).ws, request.body),
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/projects::milestones`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'view_milestones',
        await work.milestones(caller(request), p(request).ws, request.body),
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/projects::progress`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'view_progress',
        await work.progress(caller(request), p(request).ws, request.body),
        m(request),
      ),
    ),
  );
  for (const entity of ['task', 'project'] as const)
    app.post(
      `${ws}/${entity}s::activity`,
      wrap(async (request) => {
        const r = await work.activity(caller(request), p(request).ws, entity, request.body);
        return nonResourceEnvelope(
          'view_activity',
          { items: r.data, page: r.page, records_truncated: r.records_truncated },
          m(request),
        );
      }),
    );
}
