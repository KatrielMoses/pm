import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope, type NonResourceType } from '@pm/contracts';
import type { AutomationService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; aut?: string; run?: string };

/**
 * Automations (8A, ADR-0046; 0D PL-53). Everything is addressed by public identifiers under the
 * workspace: `auto_` definitions and their runs by the run operation's `op_` identifier (a run is
 * returned as `{ run }` in an `automation_run` envelope). The caller
 * is the session (activation and reassignment refuse delegated callers in the service); commands
 * use `{id}:{verb}` action segments; unsafe requests carry `Idempotency-Key`; edits carry
 * `If-Match`. Every read is decided now, for this person, in the service.
 */
export function registerAutomations(app: FastifyInstance, work: AutomationService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const flat = (
    request: FastifyRequest,
    reply: FastifyReply,
    type: NonResourceType,
    data: Record<string, unknown>,
    status = 200,
    replayed = false,
  ) => {
    if (replayed) reply.header('idempotent-replayed', 'true');
    return reply
      .code(status)
      .header('cache-control', 'private, no-store')
      .send(nonResourceEnvelope(type, data, m(request)));
  };
  const done = <T extends { id: string; type: string; version?: number }>(
    request: FastifyRequest,
    reply: FastifyReply,
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);

  app.get(
    `${ws}/automations`,
    wrap(async (request) => {
      const r = await work.listAutomations(caller(request), p(request).ws, q(request));
      return { data: r.data, page: r.page, capabilities: r.capabilities, meta: m(request) };
    }),
  );
  app.post(
    `${ws}/automations`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createAutomation(
          caller(request),
          p(request).ws,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/automation-templates`,
    wrap(async (request, reply) => {
      // Templates are static; the workspace path still requires a member (decided by the list).
      await work.listAutomations(caller(request), p(request).ws, {});
      return flat(request, reply, 'automation_templates', work.listAutomationTemplates());
    }),
  );
  app.get(
    `${ws}/automation-usage`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'automation_usage',
        await work.automationUsage(caller(request), p(request).ws),
      ),
    ),
  );
  app.get(
    `${ws}/automation-health`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'automation_health',
        await work.automationHealth(caller(request), p(request).ws),
      ),
    ),
  );
  app.get(
    `${ws}/automations/:aut`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getAutomation(caller(request), p(request).ws, p(request).aut),
      ),
    ),
  );
  app.patch(
    `${ws}/automations/:aut`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateAutomation(
          caller(request),
          p(request).ws,
          p(request).aut,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/automations/:aut/revisions`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'automation_revisions',
        await work.listAutomationRevisions(caller(request), p(request).ws, p(request).aut),
      ),
    ),
  );
  app.get(
    `${ws}/automations/:aut/runs`,
    wrap(async (request) => {
      const r = await work.listAutomationRuns(
        caller(request),
        p(request).ws,
        p(request).aut,
        q(request),
      );
      return { data: r.data, page: r.page, meta: m(request) };
    }),
  );
  app.post(
    `${ws}/automations/:aut`,
    wrap(async (request, reply) => {
      const t = split(p(request).aut);
      if (!t) return fail(request, reply, 'not_found');
      const c = caller(request);
      const w = p(request).ws;
      const req = mutation(request);
      switch (t.verb) {
        case 'activate':
          return done(request, reply, await work.activateAutomation(c, w, t.id, request.body, req));
        case 'enable':
          return done(request, reply, await work.enableAutomation(c, w, t.id, request.body, req));
        case 'disable':
          return done(request, reply, await work.disableAutomation(c, w, t.id, req));
        case 'duplicate':
          return done(request, reply, await work.duplicateAutomation(c, w, t.id, req));
        case 'reassign':
          return done(request, reply, await work.reassignAutomation(c, w, t.id, request.body, req));
        case 'archive':
        case 'unarchive':
        case 'trash':
          return done(request, reply, await work.automationLifecycle(c, w, t.id, t.verb, req));
        case 'preview':
          return flat(
            request,
            reply,
            'automation_preview',
            await work.previewAutomation(c, w, t.id, request.body),
          );
        case 'run': {
          const r = await work.runAutomationNow(c, w, t.id, request.body, req);
          return flat(request, reply, 'automation_run', { run: r.data }, r.status, r.replayed);
        }
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );
  app.get(
    `${ws}/automation-runs/:run`,
    wrap(async (request, reply) =>
      flat(request, reply, 'automation_run', {
        run: await work.getAutomationRun(caller(request), p(request).ws, p(request).run),
      }),
    ),
  );
  app.post(
    `${ws}/automation-runs/:run`,
    wrap(async (request, reply) => {
      const t = split(p(request).run);
      if (!t) return fail(request, reply, 'not_found');
      const c = caller(request);
      const w = p(request).ws;
      const req = mutation(request);
      const r =
        t.verb === 'retry'
          ? await work.retryAutomationRun(c, w, t.id, req)
          : t.verb === 'cancel'
            ? await work.cancelAutomationRun(c, w, t.id, req)
            : null;
      if (!r) return fail(request, reply, 'not_found');
      return flat(request, reply, 'automation_run', { run: r.data }, r.status, r.replayed);
    }),
  );
}
