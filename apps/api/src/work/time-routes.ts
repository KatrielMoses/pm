import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { TimeService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; te?: string; tsh?: string; target?: string };

/**
 * Time tracking and timesheets (3D, ADR-0019): entries and timers, the person's period, the
 * approval queue, per-brand decisions and admin unlock, planned-versus-actual reports, work
 * summaries, and bounded direct exports. Timer and timesheet commands are `{id}:{verb}` action
 * segments (0D); computed views are non-resource envelopes; everything else is a resource.
 */
export function registerTime(app: FastifyInstance, work: TimeService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const done = <T extends { id: string; type: string }>(
    request: FastifyRequest,
    reply: Parameters<typeof resource>[1],
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);

  // ---- Entries -----------------------------------------------------------------------------------
  app.get(
    `${ws}/time-entries`,
    wrap(async (request) => {
      const r = await work.listEntries(caller(request), p(request).ws, q(request));
      return { data: r.data, page: r.page, meta: m(request) };
    }),
  );
  app.post(
    `${ws}/time-entries`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createEntry(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/time-entries/:te`,
    wrap(async (request, reply) =>
      resource(request, reply, await work.getEntry(caller(request), p(request).ws, p(request).te)),
    ),
  );
  app.patch(
    `${ws}/time-entries/:te`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateEntry(
          caller(request),
          p(request).ws,
          p(request).te,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/time-entries/:te`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.deleteEntry(caller(request), p(request).ws, p(request).te, mutation(request)),
      ),
    ),
  );
  app.post(
    `${ws}/time-entries/:te`,
    wrap(async (request, reply) => {
      const t = split(p(request).te);
      if (!t || (t.verb !== 'pause' && t.verb !== 'resume' && t.verb !== 'stop'))
        return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.timerAction(
          caller(request),
          p(request).ws,
          t.id,
          t.verb,
          request.body,
          mutation(request),
        ),
      );
    }),
  );

  // ---- The live timer ----------------------------------------------------------------------------
  app.get(
    `${ws}/timer`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'timer_status',
        await work.getTimer(caller(request), p(request).ws),
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/timer`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.startTimer(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );

  // ---- Timesheets --------------------------------------------------------------------------------
  app.get(
    `${ws}/timesheet-period`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'timesheet_period',
        await work.timesheetPeriod(caller(request), p(request).ws, q(request)),
        m(request),
      ),
    ),
  );
  app.get(
    `${ws}/timesheets`,
    wrap(async (request) => {
      const r = await work.listTimesheetApprovals(caller(request), p(request).ws, q(request));
      return {
        data: r.data,
        page: { limit: work.pageLimitMax, has_more: false },
        meta: m(request),
      };
    }),
  );
  app.post(
    `${ws}/timesheets`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.submitTimesheet(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/timesheets/:tsh`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getTimesheet(caller(request), p(request).ws, p(request).tsh),
      ),
    ),
  );
  app.post(
    `${ws}/timesheets/:tsh`,
    wrap(async (request, reply) => {
      const t = split(p(request).tsh);
      const c = caller(request);
      const w = p(request).ws;
      const req = mutation(request);
      if (t?.verb === 'withdraw')
        return done(request, reply, await work.withdrawTimesheet(c, w, t.id, req));
      if (t?.verb === 'decide')
        return done(request, reply, await work.decideTimesheet(c, w, t.id, request.body, req));
      if (t?.verb === 'unlock')
        return done(request, reply, await work.unlockTimesheet(c, w, t.id, request.body, req));
      return fail(request, reply, 'not_found');
    }),
  );

  // ---- Reports, summaries, export ----------------------------------------------------------------
  app.get(
    `${ws}/time-report`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'time_report',
        await work.timeReport(caller(request), p(request).ws, q(request)),
        m(request),
      ),
    ),
  );
  app.get(
    `${ws}/time-summary/:target`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'time_summary',
        await work.workSummary(caller(request), p(request).ws, p(request).target),
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/time-export`,
    wrap(async (request, reply) => {
      const r = await work.exportTime(caller(request), p(request).ws, request.body);
      return reply
        .code(200)
        .header('content-type', `${r.contentType}; charset=utf-8`)
        .header('content-disposition', `attachment; filename="${r.filename}"`)
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(r.body);
    }),
  );
}
