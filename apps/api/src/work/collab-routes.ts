import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { ReviewService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; rec?: string; cmt?: string; reaction?: string; rvw?: string };

/**
 * Comments, mentions, reactions, following, reviews, and assignment history (4A, ADR-0023; 0D
 * PL-33). Every route names a host record or a comment or review by public ID, and every read and
 * write is decided by the service through that host's own authority. The caller is the session and
 * the workspace the path; unsafe requests carry Idempotency-Key, with If-Match on versioned edits.
 */
export function registerCollaboration(app: FastifyInstance, work: ReviewService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const done = <T extends { id: string; type: string }>(
    request: FastifyRequest,
    reply: FastifyReply,
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);
  const summary = (
    request: FastifyRequest,
    reply: FastifyReply,
    data: { id?: string; type?: string } & Record<string, unknown>,
    r?: { status: number; replayed: boolean },
  ) => {
    const { id: _id, type: _type, ...rest } = data;
    if (r?.replayed) reply.header('idempotent-replayed', 'true');
    return reply
      .code(r?.status ?? 200)
      .send(nonResourceEnvelope('collaboration_summary', rest, m(request)));
  };

  // ---- Comments ------------------------------------------------------------------------------
  app.get(
    `${ws}/records/:rec/comments`,
    wrap(async (request) => {
      const r = await work.listComments(caller(request), p(request).ws, p(request).rec, q(request));
      return { data: r.data, page: { ...r.page, total: r.total }, meta: m(request) };
    }),
  );
  app.post(
    `${ws}/records/:rec/comments`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createComment(
          caller(request),
          p(request).ws,
          p(request).rec,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/records/:rec/mention-candidates`,
    wrap(async (request) => {
      const r = await work.mentionCandidates(
        caller(request),
        p(request).ws,
        p(request).rec,
        q(request),
      );
      return {
        data: r.data,
        page: { limit: r.data.length, has_more: false },
        meta: m(request),
      };
    }),
  );
  app.get(
    `${ws}/comments/:cmt`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getComment(caller(request), p(request).ws, p(request).cmt),
      ),
    ),
  );
  app.patch(
    `${ws}/comments/:cmt`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.editComment(
          caller(request),
          p(request).ws,
          p(request).cmt,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/comments/:cmt`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.deleteComment(caller(request), p(request).ws, p(request).cmt, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/comments/:cmt/replies`,
    wrap(async (request) => {
      const r = await work.listReplies(caller(request), p(request).ws, p(request).cmt, q(request));
      return { data: r.data, page: r.page, meta: m(request) };
    }),
  );
  app.get(
    `${ws}/comments/:cmt/revisions`,
    wrap(async (request) => {
      const data = await work.commentRevisions(caller(request), p(request).ws, p(request).cmt);
      return { data, page: { limit: data.length, has_more: false }, meta: m(request) };
    }),
  );
  for (const on of [true, false])
    app.route({
      method: on ? 'PUT' : 'DELETE',
      url: `${ws}/comments/:cmt/reactions/:reaction`,
      handler: wrap(async (request, reply) =>
        done(
          request,
          reply,
          await work.setReaction(
            caller(request),
            p(request).ws,
            p(request).cmt,
            p(request).reaction,
            on,
            mutation(request),
          ),
        ),
      ),
    });

  // ---- Following --------------------------------------------------------------------------------
  app.get(
    `${ws}/records/:rec/collaboration`,
    wrap(async (request, reply) =>
      summary(
        request,
        reply,
        await work.collaborationSummary(caller(request), p(request).ws, p(request).rec),
      ),
    ),
  );
  for (const on of [true, false])
    app.route({
      method: on ? 'PUT' : 'DELETE',
      url: `${ws}/records/:rec/follow`,
      handler: wrap(async (request, reply) => {
        const r = await work.follow(
          caller(request),
          p(request).ws,
          p(request).rec,
          on,
          mutation(request),
        );
        return summary(request, reply, r.data, r);
      }),
    });
  app.get(
    `${ws}/records/:rec/followers`,
    wrap(async (request) => {
      const r = await work.followers(caller(request), p(request).ws, p(request).rec);
      return { data: r.data, page: { limit: r.data.length, has_more: false }, meta: m(request) };
    }),
  );
  app.get(
    `${ws}/me/following`,
    wrap(async (request) => {
      const r = await work.following(caller(request), p(request).ws, q(request));
      return { data: r.data, page: r.page, meta: m(request) };
    }),
  );

  // ---- Reviews ------------------------------------------------------------------------------------
  app.get(
    `${ws}/records/:rec/reviews`,
    wrap(async (request) => {
      const r = await work.listReviews(caller(request), p(request).ws, p(request).rec, q(request));
      return { data: r.data, page: r.page, meta: m(request) };
    }),
  );
  app.post(
    `${ws}/records/:rec/reviews`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.requestReview(
          caller(request),
          p(request).ws,
          p(request).rec,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/reviews/:rvw`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getReview(caller(request), p(request).ws, p(request).rvw),
      ),
    ),
  );
  app.post(
    `${ws}/reviews/:rvw`,
    wrap(async (request, reply) => {
      const t = split(p(request).rvw);
      if (!t) return fail(request, reply, 'not_found');
      const c = caller(request);
      const w = p(request).ws;
      const req = mutation(request);
      switch (t.verb) {
        case 'decide':
          return done(request, reply, await work.decideReview(c, w, t.id, request.body, req));
        case 'withdraw':
          return done(request, reply, await work.withdrawReview(c, w, t.id, request.body, req));
        case 'refresh':
          return done(request, reply, await work.refreshReview(c, w, t.id, request.body, req));
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );
  app.get(
    `${ws}/me/reviews`,
    wrap(async (request) => {
      const r = await work.myReviews(caller(request), p(request).ws, q(request));
      return { data: r.data, page: r.page, meta: m(request) };
    }),
  );

  // ---- Assignment history ---------------------------------------------------------------------
  app.get(
    `${ws}/tasks/:tsk/assignment-history`,
    wrap(async (request) => {
      const r = await work.assignmentHistory(
        caller(request),
        p(request).ws,
        (request.params as { tsk?: string }).tsk,
        q(request),
      );
      return { data: r.data, page: r.page, meta: m(request) };
    }),
  );
}
