import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { ViewService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; view?: string; entity?: string };

/**
 * Reusable query and saved-view engine (3A, ADR-0018; 0D §2.4 and PL-28). `POST …/tasks:query`
 * and `…/projects:query` run an ad hoc or saved query AST for the caller; `:export` returns the
 * current filtered view directly (bounded); saved views, defaults, and pins are resources. Every
 * response is computed with the caller's own authorization: a view never widens access.
 */
export function registerViews(app: FastifyInstance, work: ViewService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const done = <T extends { id: string; type: string }>(
    request: FastifyRequest,
    reply: Parameters<typeof resource>[1],
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);

  // ---- Queries and exports (POST, so the AST never lands in URLs or logs) ------------------------
  for (const entity of ['task', 'project'] as const) {
    const plural = `${entity}s`;
    app.post(
      `${ws}/${plural}::query`,
      wrap(async (request) => {
        const r = await work.query(caller(request), p(request).ws, entity, request.body);
        return {
          data: r.data,
          page: r.page,
          view: {
            columns: r.columns,
            refs: r.refs,
            ...(r.groups ? { groups: r.groups } : {}),
            ...(r.groups_truncated ? { groups_truncated: true } : {}),
          },
          meta: m(request),
        };
      }),
    );
    app.post(
      `${ws}/${plural}::export`,
      wrap(async (request, reply) => {
        const r = await work.exportView(caller(request), p(request).ws, entity, request.body);
        return reply
          .code(200)
          .header('content-type', `${r.contentType}; charset=utf-8`)
          .header('content-disposition', `attachment; filename="${r.filename}"`)
          .header('cache-control', 'private, no-store')
          .header('x-content-type-options', 'nosniff')
          .send(r.body);
      }),
    );
    app.get(
      `${ws}/views/options/${entity}/:field`,
      wrap(async (request) =>
        nonResourceEnvelope(
          'view_field_options',
          await work.fieldOptions(
            caller(request),
            p(request).ws,
            entity,
            (request.params as { field?: string }).field,
            q(request),
          ),
          m(request),
        ),
      ),
    );
    app.get(
      `${ws}/views/catalog/${entity}`,
      wrap(async (request) =>
        nonResourceEnvelope(
          'view_catalog',
          await work.catalog(caller(request), p(request).ws, entity),
          m(request),
        ),
      ),
    );
  }

  // ---- Saved views -------------------------------------------------------------------------------
  app.get(
    `${ws}/views`,
    wrap(async (request) => {
      const r = await work.listViews(caller(request), p(request).ws, q(request));
      return { data: r.data, page: { limit: 200, has_more: r.hasMore }, meta: m(request) };
    }),
  );
  app.post(
    `${ws}/views`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createView(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/views/defaults`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'view_default_resolution',
        await work.defaultView(caller(request), p(request).ws, q(request)),
        m(request),
      ),
    ),
  );
  app.put(
    `${ws}/views/defaults`,
    wrap(async (request) => {
      const r = await work.setDefault(
        caller(request),
        p(request).ws,
        request.body,
        mutation(request),
      );
      const { id: _id, type: _type, ...data } = r.data as Record<string, unknown>;
      return nonResourceEnvelope('view_default', data, m(request));
    }),
  );
  app.get(
    `${ws}/views/:view`,
    wrap(async (request, reply) =>
      resource(request, reply, await work.getView(caller(request), p(request).ws, p(request).view)),
    ),
  );
  app.patch(
    `${ws}/views/:view`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateView(
          caller(request),
          p(request).ws,
          p(request).view,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/views/:view`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.deleteView(caller(request), p(request).ws, p(request).view, mutation(request)),
      ),
    ),
  );
  // Verbs: `:share`, `:unshare`, `:pin`, `:unpin` (0D §2.2 custom methods).
  app.post(
    `${ws}/views/:view`,
    wrap(async (request, reply) => {
      const t = split(p(request).view);
      const c = caller(request);
      const w = p(request).ws;
      const req = mutation(request);
      switch (t?.verb) {
        case 'share':
          return done(request, reply, await work.shareView(c, w, t.id, request.body, req));
        case 'unshare':
          return done(request, reply, await work.unshareView(c, w, t.id, request.body, req));
        case 'pin':
          return done(request, reply, await work.pinView(c, w, t.id, request.body, req));
        case 'unpin':
          return done(request, reply, await work.unpinView(c, w, t.id, request.body, req));
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );
}
