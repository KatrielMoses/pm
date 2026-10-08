import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope, type NonResourceType } from '@pm/contracts';
import type { LiveService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; doc?: string; dsg?: string; n?: string; rec?: string };

/**
 * Documents and knowledge (4C, ADR-0025; 0D PL-35). Documents, versions, suggestions, and
 * approvals are addressed by public identifiers under the workspace. The caller is the session; the
 * service decides every read and write through the document's own placement at the time of the
 * request, so a route never reveals more than the caller may see now. Unsafe requests carry
 * `Idempotency-Key`; metadata edits carry `If-Match`, content saves carry the version they loaded.
 */
export function registerDocuments(app: FastifyInstance, work: LiveService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const flat = (
    request: FastifyRequest,
    reply: FastifyReply,
    type: NonResourceType,
    data: Record<string, unknown>,
    r?: { status: number; replayed: boolean },
  ) => {
    const { id: _id, type: _type, ...rest } = data;
    if (r?.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(r?.status ?? 200).send(nonResourceEnvelope(type, rest, m(request)));
  };
  const page = <T>(request: FastifyRequest, r: { data: T[]; page: Record<string, unknown> }) => ({
    data: r.data,
    page: r.page,
    meta: m(request),
  });
  const done = <T extends { id: string; type: string; version?: number }>(
    request: FastifyRequest,
    reply: FastifyReply,
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);

  // ---- Documents ------------------------------------------------------------------------------
  app.get(
    `${ws}/documents`,
    wrap(async (request) =>
      page(request, await work.listDocuments(caller(request), p(request).ws, q(request))),
    ),
  );
  app.post(
    `${ws}/documents`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createDocument(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/documents/:doc`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getDocument(caller(request), p(request).ws, p(request).doc),
      ),
    ),
  );
  app.patch(
    `${ws}/documents/:doc`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateDocument(
          caller(request),
          p(request).ws,
          p(request).doc,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  // Verbs: `{doc}:archive`, `:unarchive`, `:trash`, `:restore`, `:purge`, `:export`, `:approve_source`, `:revoke_source`.
  app.post(
    `${ws}/documents/:doc`,
    wrap(async (request, reply) => {
      const t = split(p(request).doc);
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
          return done(request, reply, await work.documentLifecycle(c, w, t.id, t.verb, req));
        case 'export': {
          const r = await work.exportDocument(c, w, t.id, request.body ?? {}, req);
          return flat(request, reply, 'document_export', r.data, r);
        }
        case 'approve_source':
          return done(request, reply, await work.approveSource(c, w, t.id, request.body, req));
        case 'revoke_source':
          return done(request, reply, await work.revokeSource(c, w, t.id, request.body, req));
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );
  app.put(
    `${ws}/documents/:doc/content`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.saveContent(
          caller(request),
          p(request).ws,
          p(request).doc,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/documents/:doc/restore-version`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.restoreVersion(
          caller(request),
          p(request).ws,
          p(request).doc,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.put(
    `${ws}/documents/:doc/location`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.moveDocument(
          caller(request),
          p(request).ws,
          p(request).doc,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.put(
    `${ws}/documents/:doc/links`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.setLinks(
          caller(request),
          p(request).ws,
          p(request).doc,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );

  // ---- Live editing (4D, ADR-0027): commands and an ordered long poll, each re-authorized -----
  app.post(
    `${ws}/documents/:doc/live/session`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'live_session',
        await work.liveJoin(caller(request), p(request).ws, p(request).doc, request.body ?? {}),
        { status: 201, replayed: false },
      ),
    ),
  );
  app.post(
    `${ws}/documents/:doc/live/operations`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'live_update',
        await work.liveOps(caller(request), p(request).ws, p(request).doc, request.body),
      ),
    ),
  );
  app.get(
    `${ws}/documents/:doc/live/events`,
    wrap(async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return flat(
        request,
        reply,
        'live_update',
        await work.liveEvents(caller(request), p(request).ws, p(request).doc, q(request)),
      );
    }),
  );
  app.post(
    `${ws}/documents/:doc/live/heartbeat`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'live_update',
        await work.liveHeartbeat(
          caller(request),
          p(request).ws,
          p(request).doc,
          request.body ?? {},
        ),
      ),
    ),
  );
  app.post(
    `${ws}/documents/:doc/live/checkpoint`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'live_update',
        await work.liveCheckpoint(
          caller(request),
          p(request).ws,
          p(request).doc,
          request.body ?? {},
        ),
      ),
    ),
  );
  app.post(
    `${ws}/documents/:doc/live/leave`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'live_update',
        await work.liveLeave(caller(request), p(request).ws, p(request).doc, request.body ?? {}),
      ),
    ),
  );

  // ---- Versions ----------------------------------------------------------------------------------
  app.get(
    `${ws}/documents/:doc/versions`,
    wrap(async (request) =>
      page(
        request,
        await work.listVersions(caller(request), p(request).ws, p(request).doc, q(request)),
      ),
    ),
  );
  app.get(
    `${ws}/documents/:doc/versions/:n`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getVersion(caller(request), p(request).ws, p(request).doc, p(request).n),
      ),
    ),
  );

  // ---- Suggestions -------------------------------------------------------------------------------
  app.get(
    `${ws}/documents/:doc/suggestions`,
    wrap(async (request) =>
      page(
        request,
        await work.listSuggestions(caller(request), p(request).ws, p(request).doc, q(request)),
      ),
    ),
  );
  app.post(
    `${ws}/documents/:doc/suggestions`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createSuggestion(
          caller(request),
          p(request).ws,
          p(request).doc,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/suggestions/:dsg`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getSuggestion(caller(request), p(request).ws, p(request).dsg),
      ),
    ),
  );
  // Verbs: `{dsg}:decide` (accept or reject) and `{dsg}:withdraw`.
  app.post(
    `${ws}/suggestions/:dsg`,
    wrap(async (request, reply) => {
      const t = split(p(request).dsg);
      if (!t) return fail(request, reply, 'not_found');
      const c = caller(request);
      const w = p(request).ws;
      const req = mutation(request);
      if (t.verb === 'decide')
        return done(request, reply, await work.decideSuggestion(c, w, t.id, request.body, req));
      if (t.verb === 'withdraw')
        return done(request, reply, await work.withdrawSuggestion(c, w, t.id, req));
      return fail(request, reply, 'not_found');
    }),
  );

  // ---- Backlinks -----------------------------------------------------------------------------------
  app.get(
    `${ws}/records/:rec/documents`,
    wrap(async (request) =>
      page(
        request,
        await work.backlinks(caller(request), p(request).ws, p(request).rec, q(request)),
      ),
    ),
  );
}
