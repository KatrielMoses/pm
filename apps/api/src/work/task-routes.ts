import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { TaskInteractionService } from '@pm/work';
import { routeKit } from '../route-kit.ts';
import { taskInteractionVerb } from './interaction-routes.ts';

type Params = {
  ws?: string;
  tsk?: string;
  chk?: string;
  cri?: string;
  lnk?: string;
  lbl?: string;
  brand?: string;
  kind?: string;
  target?: string;
};

/**
 * Tasks and task relationships (2B). Public IDs only; `{id}:{verb}` action segments for commands
 * (0D); lifecycle decisions come from the service through the tenancy-exported issuer. History is
 * a permission-filtered projection of the audit ledger for the task's own readers (TSK-039).
 */
export function registerTasks(app: FastifyInstance, work: TaskInteractionService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const base = '/v1/workspaces/:ws/tasks';
  const done = <T extends { id: string; type: string }>(
    request: FastifyRequest,
    reply: Parameters<typeof resource>[1],
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);

  app.get(
    base,
    wrap(async (request) => {
      const r = await work.listTasks(caller(request), p(request).ws, q(request));
      return { data: r.data, page: { ...r.page, total: r.total }, meta: m(request) };
    }),
  );
  app.post(
    base,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createTask(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${base}/:tsk`,
    wrap(async (request, reply) => {
      const d = await work.taskDetail(caller(request), p(request).ws, p(request).tsk);
      return resource(request, reply, { ...d.task, detail: { ...d, task: undefined } });
    }),
  );
  app.get(
    `${base}/:tsk/history`,
    wrap(async (request) => {
      const r = await work.taskHistory(caller(request), p(request).ws, p(request).tsk, q(request));
      return { data: r.data, page: r.page, meta: m(request) };
    }),
  );
  app.patch(
    `${base}/:tsk`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateTask(
          caller(request),
          p(request).ws,
          p(request).tsk,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${base}/:tsk`,
    wrap(async (request, reply) => {
      const t = split(p(request).tsk);
      if (!t) return fail(request, reply, 'not_found');
      const c = caller(request);
      const w = p(request).ws;
      const req = mutation(request);
      switch (t.verb) {
        case 'complete':
          return done(request, reply, await work.completeTask(c, w, t.id, request.body, req));
        case 'reopen':
          return done(request, reply, await work.reopenTask(c, w, t.id, req));
        case 'move':
          return done(request, reply, await work.moveTask(c, w, t.id, request.body, req));
        case 'preview_move_brand':
          // A computed exposure preview (no record): the closed non-resource type for previews.
          return nonResourceEnvelope(
            'permission_preview',
            { ...(await work.previewTaskBrandMove(c, w, t.id, request.body)) },
            m(request),
          );
        case 'move_brand':
          return done(request, reply, await work.moveTaskBrand(c, w, t.id, request.body, req));
        case 'duplicate':
          return done(request, reply, await work.duplicateTask(c, w, t.id, request.body, req));
        case 'assign':
          return done(request, reply, await work.setAssignees(c, w, t.id, request.body, req));
        case 'archive':
        case 'unarchive':
        case 'trash':
        case 'restore':
        case 'purge':
          return done(
            request,
            reply,
            await work.taskLifecycle(c, w, t.id, t.verb, request.body, req),
          );
        default: {
          // 2D commands: ordering, snooze, manual freshness, save as template (ADR-0016).
          const r = await taskInteractionVerb(work, t.verb, c, w, t.id, request.body, req);
          return r ? done(request, reply, r) : fail(request, reply, 'not_found');
        }
      }
    }),
  );

  // ---- Checklist, criteria, links (ordered task items) ----------------------------------------
  for (const [segment, kind, key] of [
    ['checklist', 'checklist', 'chk'],
    ['criteria', 'criteria', 'cri'],
    ['links', 'links', 'lnk'],
  ] as const) {
    app.post(
      `${base}/:tsk/${segment}`,
      wrap(async (request, reply) => {
        const c = caller(request);
        const w = p(request).ws;
        const req = mutation(request);
        const r =
          kind === 'checklist'
            ? await work.addChecklistItem(c, w, p(request).tsk, request.body, req)
            : kind === 'criteria'
              ? await work.addTaskCriterion(c, w, p(request).tsk, request.body, req)
              : await work.addLink(c, w, p(request).tsk, request.body, req);
        return resource(request, reply, r.data, { ...r, status: 201 });
      }),
    );
    app.patch(
      `${base}/:tsk/${segment}/:${key}`,
      wrap(async (request, reply) => {
        const c = caller(request);
        const w = p(request).ws;
        const id = (p(request) as Record<string, string>)[key];
        const req = mutation(request);
        const r =
          kind === 'checklist'
            ? await work.updateChecklistItem(c, w, p(request).tsk, id, request.body, req)
            : kind === 'criteria'
              ? await work.updateTaskCriterion(c, w, p(request).tsk, id, request.body, req)
              : await work.updateLink(c, w, p(request).tsk, id, request.body, req);
        return done(request, reply, r);
      }),
    );
    app.delete(
      `${base}/:tsk/${segment}/:${key}`,
      wrap(async (request, reply) => {
        const id = (p(request) as Record<string, string>)[key];
        return done(
          request,
          reply,
          await work.removeTaskItem(
            caller(request),
            p(request).ws,
            p(request).tsk,
            kind,
            id,
            mutation(request),
          ),
        );
      }),
    );
    app.post(
      `${base}/:tsk/${segment}/:${key}`,
      wrap(async (request, reply) => {
        const t = split((p(request) as Record<string, string>)[key]);
        if (!t || t.verb !== 'move') return fail(request, reply, 'not_found');
        return done(
          request,
          reply,
          await work.moveTaskItem(
            caller(request),
            p(request).ws,
            p(request).tsk,
            kind,
            t.id,
            request.body,
            mutation(request),
          ),
        );
      }),
    );
  }
  app.post(
    `${base}/:tsk/inherited-criteria/:cri`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.setInheritedCriterion(
          caller(request),
          p(request).ws,
          p(request).tsk,
          p(request).cri,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );

  // ---- Labels ---------------------------------------------------------------------------------
  app.post(
    `${base}/:tsk/labels`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.addTaskLabel(
          caller(request),
          p(request).ws,
          p(request).tsk,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${base}/:tsk/labels/:lbl`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.removeTaskLabel(
          caller(request),
          p(request).ws,
          p(request).tsk,
          p(request).lbl,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    '/v1/workspaces/:ws/brands/:brand/labels',
    wrap(async (request) => ({
      data: await work.listLabels(caller(request), p(request).ws, p(request).brand, q(request)),
      page: { has_more: false },
      meta: m(request),
    })),
  );
  app.post(
    '/v1/workspaces/:ws/brands/:brand/labels',
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createLabel(
          caller(request),
          p(request).ws,
          p(request).brand,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.patch(
    '/v1/workspaces/:ws/labels/:lbl',
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateLabel(
          caller(request),
          p(request).ws,
          p(request).lbl,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );

  // ---- Relationships --------------------------------------------------------------------------
  app.post(
    `${base}/:tsk/relationships`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.addRelationship(
          caller(request),
          p(request).ws,
          p(request).tsk,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${base}/:tsk/relationships/:kind/:target`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.removeRelationship(
          caller(request),
          p(request).ws,
          p(request).tsk,
          p(request).kind,
          p(request).target,
          mutation(request),
        ),
      ),
    ),
  );
}
