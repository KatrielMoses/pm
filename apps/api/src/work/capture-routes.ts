import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { CaptureService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; inb?: string; note?: string; form?: string };

/**
 * Inbox and universal capture (2E, ADR-0017): one capture command for every surface, the personal
 * Inbox (owner only), triage and merge with previews, notes, and brand intake forms. Previews are
 * non-resource envelopes; everything else is a resource with its public ID.
 */
export function registerCapture(app: FastifyInstance, work: CaptureService): void {
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

  // ---- Capture -----------------------------------------------------------------------------------
  app.post(
    `${ws}/capture/preview`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'capture_preview',
        await work.previewCapture(caller(request), p(request).ws, request.body),
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/capture`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.capture(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );

  // ---- Inbox -------------------------------------------------------------------------------------
  app.get(
    `${ws}/inbox`,
    wrap(async (request) => {
      const r = await work.listInbox(caller(request), p(request).ws, q(request));
      return { data: r.data, page: r.page, meta: m(request) };
    }),
  );
  app.get(
    `${ws}/inbox/:inb`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getInboxItem(caller(request), p(request).ws, p(request).inb),
      ),
    ),
  );
  app.post(
    `${ws}/inbox/:inb`,
    wrap(async (request, reply) => {
      const t = split(p(request).inb);
      if (!t || t.verb !== 'restore') return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.restoreInboxItem(caller(request), p(request).ws, t.id, mutation(request)),
      );
    }),
  );
  app.post(
    `${ws}/inbox-triage/preview`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'triage_preview',
        await work.previewTriage(caller(request), p(request).ws, request.body),
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/inbox-triage`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.triage(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.post(
    `${ws}/inbox-merge/preview`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'merge_preview',
        await work.previewMerge(caller(request), p(request).ws, request.body),
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/inbox-merge`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.merge(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );

  // ---- Notes -------------------------------------------------------------------------------------
  app.get(
    `${ws}/notes`,
    wrap(async (request) => list(request, await work.listNotes(caller(request), p(request).ws))),
  );
  app.get(
    `${ws}/notes/:note`,
    wrap(async (request, reply) =>
      resource(request, reply, await work.getNote(caller(request), p(request).ws, p(request).note)),
    ),
  );
  app.patch(
    `${ws}/notes/:note`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateNote(
          caller(request),
          p(request).ws,
          p(request).note,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/notes/:note`,
    wrap(async (request, reply) => {
      const t = split(p(request).note);
      if (!t || t.verb !== 'convert') return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.convertNote(
          caller(request),
          p(request).ws,
          t.id,
          request.body,
          mutation(request),
        ),
      );
    }),
  );

  // ---- Intake forms ------------------------------------------------------------------------------
  app.get(
    `${ws}/intake-forms`,
    wrap(async (request) =>
      list(request, await work.listForms(caller(request), p(request).ws, q(request))),
    ),
  );
  app.post(
    `${ws}/intake-forms`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createForm(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/intake-forms/:form`,
    wrap(async (request, reply) =>
      resource(request, reply, await work.getForm(caller(request), p(request).ws, p(request).form)),
    ),
  );
  app.patch(
    `${ws}/intake-forms/:form`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateForm(
          caller(request),
          p(request).ws,
          p(request).form,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/intake-forms/:form`,
    wrap(async (request, reply) => {
      const t = split(p(request).form);
      if (!t || t.verb !== 'submit') return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.submitForm(
          caller(request),
          p(request).ws,
          t.id,
          request.body,
          mutation(request),
        ),
      );
    }),
  );
}
