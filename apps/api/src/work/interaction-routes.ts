import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { TaskInteractionService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = {
  ws?: string;
  tsk?: string;
  rem?: string;
  rcs?: string;
  bop?: string;
  und?: string;
  tpl?: string;
};

/**
 * Task interaction quality (2D, ADR-0016): signals and duplicates (computed, non-resource),
 * personal reminders and snoozes, ordering commands, bulk preview and execution, undo, task
 * templates, and recurring tasks. Public IDs only; `{id}:{verb}` action segments for commands.
 */
export function registerTaskInteraction(app: FastifyInstance, work: TaskInteractionService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const done = <T extends { id: string; type: string }>(
    request: FastifyRequest,
    reply: Parameters<typeof resource>[1],
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);
  const list = <T>(request: FastifyRequest, data: T[]) => ({
    data,
    page: { limit: work.pageLimitMax, has_more: false },
    meta: m(request),
  });

  // ---- Signals, freshness, duplicates -----------------------------------------------------------
  app.get(
    `${ws}/tasks/:tsk/signals`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'task_signals',
        await work.taskSignals(caller(request), p(request).ws, p(request).tsk),
        m(request),
      ),
    ),
  );
  app.get(
    `${ws}/task-signals`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'task_signals',
        await work.listTaskSignals(caller(request), p(request).ws, q(request)),
        m(request),
      ),
    ),
  );
  app.get(
    `${ws}/task-duplicates`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'duplicate_candidates',
        await work.duplicateCandidates(caller(request), p(request).ws, q(request)),
        m(request),
      ),
    ),
  );

  // ---- Personal reminders -----------------------------------------------------------------------
  app.get(
    `${ws}/reminders`,
    wrap(async (request) =>
      list(request, await work.listReminders(caller(request), p(request).ws)),
    ),
  );
  app.post(
    `${ws}/tasks/:tsk/reminders`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createReminder(
          caller(request),
          p(request).ws,
          p(request).tsk,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.patch(
    `${ws}/reminders/:rem`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateReminder(
          caller(request),
          p(request).ws,
          p(request).rem,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );

  // ---- Recurring tasks --------------------------------------------------------------------------
  app.get(
    `${ws}/tasks/:tsk/recurrences`,
    wrap(async (request) =>
      list(request, await work.listTaskRecurrences(caller(request), p(request).ws, p(request).tsk)),
    ),
  );
  app.post(
    `${ws}/tasks/:tsk/recurrences`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.defineTaskRecurrence(
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
    `${ws}/tasks/:tsk/recurrences/:rcs`,
    wrap(async (request, reply) => {
      const t = split(p(request).rcs);
      if (!t) return fail(request, reply, 'not_found');
      const c = caller(request);
      if (t.verb === 'generate')
        return done(
          request,
          reply,
          await work.generateNextTaskOccurrence(
            c,
            p(request).ws,
            p(request).tsk,
            t.id,
            mutation(request),
          ),
        );
      if (t.verb !== 'pause' && t.verb !== 'resume') return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.setTaskRecurrenceState(
          c,
          p(request).ws,
          p(request).tsk,
          t.id,
          { state: t.verb === 'pause' ? 'paused' : 'active' },
          mutation(request),
        ),
      );
    }),
  );

  // ---- Bulk -------------------------------------------------------------------------------------
  app.post(
    `${ws}/task-bulk`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.previewBulk(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/task-bulk/:bop`,
    wrap(async (request, reply) =>
      resource(request, reply, await work.getBulk(caller(request), p(request).ws, p(request).bop)),
    ),
  );
  app.post(
    `${ws}/task-bulk/:bop`,
    wrap(async (request, reply) => {
      const t = split(p(request).bop);
      if (!t || t.verb !== 'execute') return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.executeBulk(caller(request), p(request).ws, t.id, mutation(request)),
      );
    }),
  );

  // ---- Undo -------------------------------------------------------------------------------------
  app.post(
    `${ws}/undo/:und`,
    wrap(async (request, reply) => {
      const t = split(p(request).und);
      if (!t || t.verb !== 'apply') return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.applyUndo(caller(request), p(request).ws, t.id, mutation(request)),
      );
    }),
  );

  // ---- Task templates ---------------------------------------------------------------------------
  app.get(
    `${ws}/task-templates`,
    wrap(async (request) =>
      list(request, await work.listTemplates(caller(request), p(request).ws, 'task')),
    ),
  );
  app.post(
    `${ws}/task-templates/:tpl`,
    wrap(async (request, reply) => {
      const t = split(p(request).tpl);
      if (!t) return fail(request, reply, 'not_found');
      const c = caller(request);
      const req = mutation(request);
      if (t.verb === 'version')
        return done(
          request,
          reply,
          await work.versionTaskTemplate(c, p(request).ws, t.id, request.body, req),
        );
      if (t.verb !== 'apply') return fail(request, reply, 'not_found');
      const r = await work.applyTaskTemplate(c, p(request).ws, t.id, request.body, req);
      reply.status(r.status);
      if (r.replayed) reply.header('Idempotent-Replayed', 'true');
      return nonResourceEnvelope(
        'template_application',
        {
          task: r.application.task,
          copied: r.application.copied,
          omitted: r.application.omitted,
        },
        m(request),
      );
    }),
  );
}

/** The 2D task verbs handled by the task command route (`POST /tasks/{id}:{verb}`). */
export const TASK_INTERACTION_VERBS = [
  'reorder',
  'snooze',
  'unsnooze',
  'mark_updated',
  'save_as_template',
] as const;

export async function taskInteractionVerb(
  work: TaskInteractionService,
  verb: string,
  c: Parameters<TaskInteractionService['reorderTask']>[0],
  w: unknown,
  id: string,
  body: unknown,
  req: Parameters<TaskInteractionService['reorderTask']>[4],
): Promise<{ data: { id: string; type: string }; status: number; replayed: boolean } | null> {
  switch (verb) {
    case 'reorder':
      return work.reorderTask(c, w, id, body, req);
    case 'snooze':
      return work.snoozeTask(c, w, id, body, req);
    case 'unsnooze':
      return work.unsnoozeTask(c, w, id, req);
    case 'mark_updated':
      return work.markTaskUpdated(c, w, id, req);
    case 'save_as_template':
      return work.createTaskTemplate(c, w, id, body, req);
    default:
      return null;
  }
}
