import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { SearchService } from '@pm/work';
import { routeKit } from '../route-kit.ts';
import { registerFiles } from './files-routes.ts';
import { registerSearch } from './search-routes.ts';
import { registerCapture } from './capture-routes.ts';
import { registerTaskInteraction } from './interaction-routes.ts';
import { registerTasks } from './task-routes.ts';
import { registerPlanning } from './planning-routes.ts';
import { registerTime } from './time-routes.ts';
import { registerLayouts } from './layout-routes.ts';
import { registerCapacity } from './capacity-routes.ts';
import { registerCollaboration } from './collab-routes.ts';
import { registerNotifications } from './notify-routes.ts';
import { registerDocuments } from './document-routes.ts';
import { registerViews } from './view-routes.ts';
import { registerWorkflows } from './workflow-routes.ts';

export interface WorkRouteDeps {
  work: SearchService;
}

type Params = {
  ws?: string;
  prj?: string;
  phs?: string;
  ms?: string;
  cri?: string;
  sco?: string;
  pup?: string;
  dec?: string;
  dep?: string;
  rcs?: string;
};

/**
 * Projects and project structures (2A). The workspace is the path segment, the person is the
 * session, and every identifier is a public ID. Lifecycle and other commands use `{id}:{verb}`
 * action segments (0D), resolved here and decided in the service through the tenancy-exported
 * lifecycle issuer; this module never touches lifecycle machinery directly.
 */
export function registerWork(app: FastifyInstance, deps: WorkRouteDeps): void {
  const { work } = deps;
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const list = <T>(request: FastifyRequest, data: T[], total?: unknown) => ({
    data,
    page: { limit: work.pageLimitMax, has_more: false, ...(total ? { total } : {}) },
    meta: m(request),
  });
  const base = '/v1/workspaces/:ws/projects';
  registerTasks(app, work);
  registerTaskInteraction(app, work);
  registerCapture(app, work);
  registerWorkflows(app, work);
  registerViews(app, work);
  registerTime(app, work);
  registerLayouts(app, work);
  registerPlanning(app, work);
  registerCapacity(app, work);
  registerCollaboration(app, work);
  registerNotifications(app, work);
  registerDocuments(app, work);
  registerFiles(app, work);
  registerSearch(app, work);

  app.get(
    base,
    wrap(async (request) => {
      const r = await work.listProjects(caller(request), p(request).ws, q(request));
      return list(request, r.data, r.total);
    }),
  );
  app.post(
    base,
    wrap(async (request, reply) => {
      const r = await work.createProject(
        caller(request),
        p(request).ws,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
  app.get(
    `${base}/:prj`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getProject(caller(request), p(request).ws, p(request).prj),
      ),
    ),
  );
  app.get(
    `${base}/:prj/overview`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'project_overview',
        { ...(await work.overview(caller(request), p(request).ws, p(request).prj)) },
        m(request),
      ),
    ),
  );
  app.patch(
    `${base}/:prj`,
    wrap(async (request, reply) => {
      const r = await work.updateProject(
        caller(request),
        p(request).ws,
        p(request).prj,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
  app.post(
    `${base}/:prj`,
    wrap(async (request, reply) => {
      const t = split(p(request).prj);
      if (!t) return fail(request, reply, 'not_found');
      const c = caller(request);
      const w = p(request).ws;
      const req = mutation(request);
      switch (t.verb) {
        case 'move': {
          const r = await work.moveProject(c, w, t.id, request.body, req);
          return resource(request, reply, r.data, r);
        }
        case 'owner': {
          const r = await work.setOwner(c, w, t.id, request.body, req);
          return resource(request, reply, r.data, r);
        }
        case 'access': {
          const r = await work.setAccess(c, w, t.id, request.body, req);
          return resource(request, reply, r.data, r);
        }
        case 'duplicate': {
          const r = await work.duplicateProject(c, w, t.id, request.body, req);
          return resource(request, reply, r.data, r);
        }
        case 'template': {
          const r = await work.createTemplateFromProject(c, w, t.id, request.body, req);
          return resource(request, reply, r.data, r);
        }
        case 'archive':
        case 'unarchive':
        case 'trash':
        case 'restore':
        case 'purge': {
          const r = await work.projectLifecycle(c, w, t.id, t.verb, req);
          return resource(request, reply, r.data, r);
        }
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );

  // ---- Phases and milestones ------------------------------------------------------------------
  for (const [segment, type, key] of [
    ['phases', 'phase', 'phs'],
    ['milestones', 'milestone', 'ms'],
  ] as const) {
    app.post(
      `${base}/:prj/${segment}`,
      wrap(async (request, reply) => {
        const r =
          type === 'phase'
            ? await work.createPhase(
                caller(request),
                p(request).ws,
                p(request).prj,
                request.body,
                mutation(request),
              )
            : await work.createMilestone(
                caller(request),
                p(request).ws,
                p(request).prj,
                request.body,
                mutation(request),
              );
        return resource(request, reply, r.data, { ...r, status: 201 });
      }),
    );
    app.patch(
      `${base}/:prj/${segment}/:${key}`,
      wrap(async (request, reply) => {
        const id = p(request)[key];
        const r =
          type === 'phase'
            ? await work.updatePhase(
                caller(request),
                p(request).ws,
                p(request).prj,
                id,
                request.body,
                mutation(request),
              )
            : await work.updateMilestone(
                caller(request),
                p(request).ws,
                p(request).prj,
                id,
                request.body,
                mutation(request),
              );
        return resource(request, reply, r.data, r);
      }),
    );
    app.post(
      `${base}/:prj/${segment}/:${key}`,
      wrap(async (request, reply) => {
        const t = split(p(request)[key]);
        if (!t) return fail(request, reply, 'not_found');
        if (t.verb === 'move') {
          const r = await work.moveChild(
            caller(request),
            p(request).ws,
            p(request).prj,
            type,
            t.id,
            request.body,
            mutation(request),
          );
          return resource(request, reply, r.data, r);
        }
        const allowed =
          type === 'phase'
            ? ['archive', 'unarchive']
            : ['archive', 'unarchive', 'trash', 'restore'];
        if (!allowed.includes(t.verb)) return fail(request, reply, 'not_found');
        const r = await work.childLifecycle(
          caller(request),
          p(request).ws,
          p(request).prj,
          type,
          t.id,
          t.verb as 'archive' | 'unarchive' | 'trash' | 'restore',
          mutation(request),
        );
        return resource(request, reply, r.data, r);
      }),
    );
  }

  // ---- Criteria and scope entries ---------------------------------------------------------------
  for (const [segment, table, key] of [
    ['criteria', 'criteria', 'cri'],
    ['scope-items', 'scope', 'sco'],
  ] as const) {
    app.post(
      `${base}/:prj/${segment}`,
      wrap(async (request, reply) => {
        const r = await work.addItem(
          caller(request),
          p(request).ws,
          p(request).prj,
          table,
          request.body,
          mutation(request),
        );
        return resource(request, reply, r.data, { ...r, status: 201 });
      }),
    );
    app.patch(
      `${base}/:prj/${segment}/:${key}`,
      wrap(async (request, reply) => {
        const r = await work.updateItem(
          caller(request),
          p(request).ws,
          p(request).prj,
          table,
          p(request)[key],
          request.body,
          mutation(request),
        );
        return resource(request, reply, r.data, r);
      }),
    );
    app.delete(
      `${base}/:prj/${segment}/:${key}`,
      wrap(async (request, reply) => {
        const r = await work.removeItem(
          caller(request),
          p(request).ws,
          p(request).prj,
          table,
          p(request)[key],
          mutation(request),
        );
        return resource(request, reply, r.data, r);
      }),
    );
    app.post(
      `${base}/:prj/${segment}/:${key}`,
      wrap(async (request, reply) => {
        const t = split(p(request)[key]);
        if (!t || t.verb !== 'move') return fail(request, reply, 'not_found');
        const r = await work.moveItem(
          caller(request),
          p(request).ws,
          p(request).prj,
          table,
          t.id,
          request.body,
          mutation(request),
        );
        return resource(request, reply, r.data, r);
      }),
    );
  }

  // ---- Updates, decisions, dependencies -------------------------------------------------------
  app.post(
    `${base}/:prj/updates`,
    wrap(async (request, reply) => {
      const r = await work.postUpdate(
        caller(request),
        p(request).ws,
        p(request).prj,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, { ...r, status: 201 });
    }),
  );
  app.post(
    `${base}/:prj/updates/:pup`,
    wrap(async (request, reply) => {
      const t = split(p(request).pup);
      if (!t || t.verb !== 'verify') return fail(request, reply, 'not_found');
      const r = await work.verifyUpdate(
        caller(request),
        p(request).ws,
        p(request).prj,
        t.id,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
  app.post(
    `${base}/:prj/decisions`,
    wrap(async (request, reply) => {
      const r = await work.createDecision(
        caller(request),
        p(request).ws,
        p(request).prj,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, { ...r, status: 201 });
    }),
  );
  app.patch(
    `${base}/:prj/decisions/:dec`,
    wrap(async (request, reply) => {
      const r = await work.updateDecision(
        caller(request),
        p(request).ws,
        p(request).prj,
        p(request).dec,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
  app.post(
    `${base}/:prj/dependencies`,
    wrap(async (request, reply) => {
      const r = await work.addDependency(
        caller(request),
        p(request).ws,
        p(request).prj,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, { ...r, status: 201 });
    }),
  );
  app.delete(
    `${base}/:prj/dependencies/:dep`,
    wrap(async (request, reply) => {
      const r = await work.removeDependency(
        caller(request),
        p(request).ws,
        p(request).prj,
        p(request).dep,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );

  // ---- Recurrence and templates ---------------------------------------------------------------
  app.get(
    `${base}/:prj/recurrences`,
    wrap(async (request) =>
      list(request, await work.listRecurrences(caller(request), p(request).ws, p(request).prj)),
    ),
  );
  app.post(
    `${base}/:prj/recurrences`,
    wrap(async (request, reply) => {
      const r = await work.defineRecurrence(
        caller(request),
        p(request).ws,
        p(request).prj,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
  app.post(
    `${base}/:prj/recurrences/:rcs`,
    wrap(async (request, reply) => {
      const t = split(p(request).rcs);
      if (!t) return fail(request, reply, 'not_found');
      const c = caller(request);
      if (t.verb === 'generate') {
        const r = await work.generateNextOccurrence(
          c,
          p(request).ws,
          p(request).prj,
          t.id,
          mutation(request),
        );
        return resource(request, reply, r.data, r);
      }
      if (t.verb !== 'pause' && t.verb !== 'resume') return fail(request, reply, 'not_found');
      const r = await work.setRecurrenceState(
        c,
        p(request).ws,
        p(request).prj,
        t.id,
        { state: t.verb === 'pause' ? 'paused' : 'active' },
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
  app.get(
    '/v1/workspaces/:ws/templates',
    wrap(async (request) =>
      list(request, await work.listTemplates(caller(request), p(request).ws)),
    ),
  );
}
