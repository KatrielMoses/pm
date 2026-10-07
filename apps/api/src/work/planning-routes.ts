import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { PlanningService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; day?: string; tsk?: string; blk?: string; bls?: string };

/**
 * Today and manual planning (3C, ADR-0020): the Today view and day plan, commitments addressed by
 * day and task (non-resource envelopes with the version as ETag), `{day}:shutdown`, daily records,
 * work blocks and block series (resources with public IDs; `from-estimate`, `:end`).
 */
export function registerPlanning(app: FastifyInstance, work: PlanningService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const done = <T extends { id: string; type: string }>(
    request: FastifyRequest,
    reply: FastifyReply,
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);
  /** A command on a non-resource subject: the same success shape without id/type; ETag = version. */
  const plain = <T extends { id: string; type: string; version?: number }>(
    request: FastifyRequest,
    reply: FastifyReply,
    kind: 'today_commitment' | 'daily_record',
    r: { data: T; status: number; replayed: boolean },
  ) => {
    const { id: _id, type: _type, ...rest } = r.data;
    if (r.data.version !== undefined) reply.header('etag', `"${r.data.version}"`);
    if (r.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(r.status).send(nonResourceEnvelope(kind, rest, m(request)));
  };

  // ---- Today ---------------------------------------------------------------------------------------
  app.get(
    `${ws}/today/:day`,
    wrap(async (request, reply) => {
      const t = split(p(request).day);
      if (t) return fail(request, reply, 'not_found');
      return nonResourceEnvelope(
        'today_view',
        await work.todayView(caller(request), p(request).ws, p(request).day),
        m(request),
      );
    }),
  );
  app.post(
    `${ws}/today/:day`,
    wrap(async (request, reply) => {
      const t = split(p(request).day);
      if (!t || t.verb !== 'shutdown') return fail(request, reply, 'not_found');
      return plain(
        request,
        reply,
        'daily_record',
        await work.shutdown(caller(request), p(request).ws, t.id, request.body, mutation(request)),
      );
    }),
  );
  app.get(
    `${ws}/today/:day/plan`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'day_plan',
        await work.dayPlan(caller(request), p(request).ws, p(request).day),
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/today/:day/items`,
    wrap(async (request, reply) =>
      plain(
        request,
        reply,
        'today_commitment',
        await work.commit(
          caller(request),
          p(request).ws,
          p(request).day,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.patch(
    `${ws}/today/:day/items/:tsk`,
    wrap(async (request, reply) =>
      plain(
        request,
        reply,
        'today_commitment',
        await work.updateCommitment(
          caller(request),
          p(request).ws,
          p(request).day,
          p(request).tsk,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/today/:day/items/:tsk`,
    wrap(async (request, reply) =>
      plain(
        request,
        reply,
        'today_commitment',
        await work.uncommit(
          caller(request),
          p(request).ws,
          p(request).day,
          p(request).tsk,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/daily-records`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'daily_records',
        await work.dailyRecords(caller(request), p(request).ws, q(request)),
        m(request),
      ),
    ),
  );
  app.get(
    `${ws}/daily-records/:day`,
    wrap(async (request) => {
      const {
        id: _id,
        type: _type,
        ...rest
      } = await work.dailyRecord(caller(request), p(request).ws, p(request).day);
      return nonResourceEnvelope('daily_record', rest, m(request));
    }),
  );

  // ---- Work blocks -------------------------------------------------------------------------------
  app.get(
    `${ws}/work-blocks`,
    wrap(async (request) => {
      const r = await work.listBlocks(caller(request), p(request).ws, q(request));
      return { data: r.data, page: { limit: r.data.length, has_more: false }, meta: m(request) };
    }),
  );
  app.post(
    `${ws}/work-blocks`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createBlock(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.post(
    `${ws}/work-blocks/from-estimate`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.blockFromEstimate(
          caller(request),
          p(request).ws,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.patch(
    `${ws}/work-blocks/:blk`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateBlock(
          caller(request),
          p(request).ws,
          p(request).blk,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/work-blocks/:blk`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.deleteBlock(caller(request), p(request).ws, p(request).blk, mutation(request)),
      ),
    ),
  );

  // ---- Block series ------------------------------------------------------------------------------
  app.get(
    `${ws}/block-series`,
    wrap(async (request) => {
      const r = await work.listSeries(caller(request), p(request).ws);
      return { data: r.data, page: { limit: r.data.length, has_more: false }, meta: m(request) };
    }),
  );
  app.post(
    `${ws}/block-series`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createSeries(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.post(
    `${ws}/block-series/:bls`,
    wrap(async (request, reply) => {
      const t = split(p(request).bls);
      if (!t || t.verb !== 'end') return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.endSeries(caller(request), p(request).ws, t.id, mutation(request)),
      );
    }),
  );
}
