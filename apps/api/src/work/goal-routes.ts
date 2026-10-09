import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope, type NonResourceType } from '@pm/contracts';
import type { PortfolioService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; goal?: string; kr?: string; pf?: string; prj?: string };

/**
 * Goals, key results, links, check-ins, and portfolios (5B, ADR-0029; 0D PL-39). Everything is
 * addressed by public identifiers under the workspace. The caller is the session; the service
 * decides every read and write through the record's own placement at the time of the request, and
 * computes every figure that depends on linked work for the caller, so a route never reveals more
 * than the caller may see now. Unsafe requests carry `Idempotency-Key`; edits carry `If-Match`.
 */
export function registerGoals(app: FastifyInstance, work: PortfolioService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const page = (
    request: FastifyRequest,
    r: { data: unknown[]; page: Record<string, unknown> },
  ) => ({
    ...r,
    meta: m(request),
  });
  const done = <T extends { id: string; type: string; version?: number }>(
    request: FastifyRequest,
    reply: FastifyReply,
    r: { data: T; status: number; replayed: boolean },
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
  const file = (reply: FastifyReply, r: { format: string; filename: string; body: string }) =>
    reply
      .code(200)
      .header(
        'content-type',
        `${r.format === 'csv' ? 'text/csv' : 'application/json'}; charset=utf-8`,
      )
      .header('content-disposition', `attachment; filename="${r.filename}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(r.body);

  // ---- Goals -------------------------------------------------------------------------------------
  app.get(
    `${ws}/goals`,
    wrap(async (request) =>
      page(
        request,
        q(request).trashed === 'true'
          ? await work.listTrashedGoals(caller(request), p(request).ws)
          : await work.listGoals(caller(request), p(request).ws, q(request)),
      ),
    ),
  );
  app.post(
    `${ws}/goals`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createGoal(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/goals/export`,
    wrap(async (request, reply) =>
      file(reply, await work.exportGoals(caller(request), p(request).ws, q(request))),
    ),
  );
  app.get(
    `${ws}/goals/:goal`,
    wrap(async (request, reply) =>
      resource(request, reply, await work.getGoal(caller(request), p(request).ws, p(request).goal)),
    ),
  );
  app.patch(
    `${ws}/goals/:goal`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateGoal(
          caller(request),
          p(request).ws,
          p(request).goal,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  // Verbs: `{goal}:archive`, `:unarchive`, `:trash`, `:restore`, `:purge`, `:recalculate`.
  app.post(
    `${ws}/goals/:goal`,
    wrap(async (request, reply) => {
      const t = split(p(request).goal);
      if (!t) return fail(request, reply, 'not_found');
      const c = caller(request);
      const w = p(request).ws;
      const req = mutation(request);
      switch (t.verb) {
        case 'archive':
        case 'unarchive':
        case 'trash':
        case 'restore':
        case 'purge':
          return done(request, reply, await work.goalLifecycle(c, w, t.id, t.verb, req));
        case 'recalculate':
          return done(request, reply, await work.recalculateGoal(c, w, t.id, req));
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );
  app.get(
    `${ws}/goals/:goal/work`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'goal_work',
        await work.goalWork(caller(request), p(request).ws, p(request).goal, q(request)),
      ),
    ),
  );
  app.get(
    `${ws}/goals/:goal/check-ins`,
    wrap(async (request) =>
      page(
        request,
        await work.listCheckins(caller(request), p(request).ws, p(request).goal, q(request)),
      ),
    ),
  );
  app.post(
    `${ws}/goals/:goal/check-ins`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.recordCheckin(
          caller(request),
          p(request).ws,
          p(request).goal,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/goals/:goal/key-results`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createKeyResult(
          caller(request),
          p(request).ws,
          p(request).goal,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.patch(
    `${ws}/goals/:goal/key-results/:kr`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateKeyResult(
          caller(request),
          p(request).ws,
          p(request).goal,
          p(request).kr,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  // Verbs: `{kr}:archive`, `:unarchive`.
  app.post(
    `${ws}/goals/:goal/key-results/:kr`,
    wrap(async (request, reply) => {
      const t = split(p(request).kr);
      if (!t || (t.verb !== 'archive' && t.verb !== 'unarchive'))
        return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.keyResultLifecycle(
          caller(request),
          p(request).ws,
          p(request).goal,
          t.id,
          t.verb,
          mutation(request),
        ),
      );
    }),
  );
  app.post(
    `${ws}/goals/:goal/links`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.addGoalLink(
          caller(request),
          p(request).ws,
          p(request).goal,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/goals/:goal/links`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.removeGoalLink(
          caller(request),
          p(request).ws,
          p(request).goal,
          q(request),
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/projects/:prj/goals`,
    wrap(async (request) =>
      page(request, await work.goalsOfProject(caller(request), p(request).ws, p(request).prj)),
    ),
  );

  // ---- Portfolios --------------------------------------------------------------------------------
  app.get(
    `${ws}/portfolios`,
    wrap(async (request) =>
      page(request, await work.listPortfolios(caller(request), p(request).ws, q(request))),
    ),
  );
  app.post(
    `${ws}/portfolios`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createPortfolio(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/portfolios/:pf`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getPortfolio(caller(request), p(request).ws, p(request).pf),
      ),
    ),
  );
  app.patch(
    `${ws}/portfolios/:pf`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updatePortfolio(
          caller(request),
          p(request).ws,
          p(request).pf,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  // Verbs: `{pf}:archive`, `:unarchive`, `:trash`, `:restore`, `:purge`.
  app.post(
    `${ws}/portfolios/:pf`,
    wrap(async (request, reply) => {
      const t = split(p(request).pf);
      if (!t || !['archive', 'unarchive', 'trash', 'restore', 'purge'].includes(t.verb))
        return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.portfolioLifecycle(
          caller(request),
          p(request).ws,
          t.id,
          t.verb as 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge',
          mutation(request),
        ),
      );
    }),
  );
  app.put(
    `${ws}/portfolios/:pf/projects`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.setPortfolioProjects(
          caller(request),
          p(request).ws,
          p(request).pf,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/portfolios/:pf/overview`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'portfolio_overview',
        await work.portfolioDetail(caller(request), p(request).ws, p(request).pf, q(request)),
      ),
    ),
  );
  app.get(
    `${ws}/portfolio/overview`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'portfolio_overview',
        await work.portfolioOverview(caller(request), p(request).ws, q(request)),
      ),
    ),
  );
  app.get(
    `${ws}/portfolio/dependencies`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'portfolio_dependencies',
        await work.portfolioDependencies(caller(request), p(request).ws, q(request)),
      ),
    ),
  );
  app.get(
    `${ws}/portfolio/orphans`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'portfolio_orphans',
        await work.portfolioOrphans(caller(request), p(request).ws, q(request)),
      ),
    ),
  );
  app.get(
    `${ws}/portfolio/export`,
    wrap(async (request, reply) =>
      file(reply, await work.exportPortfolio(caller(request), p(request).ws, q(request))),
    ),
  );
}
