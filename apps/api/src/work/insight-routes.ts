import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope, type NonResourceType } from '@pm/contracts';
import type { ReportService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; dash?: string; rpt?: string; wdg?: string; rsh?: string };
type Verb = 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge';
const VERBS: readonly string[] = ['archive', 'unarchive', 'trash', 'restore', 'purge'];

/**
 * Dashboards, saved reports, shares, schedules, and exports (5D, ADR-0030; 0D PL-40). Everything is
 * addressed by public identifiers under the workspace. The caller is the session; the service
 * decides every read and write through the record's own placement (or a share) at the time of the
 * request, and computes every figure for the caller, so a route never reveals more than the caller
 * may see now. Unsafe requests carry `Idempotency-Key`; edits carry `If-Match`. Every response is
 * `private, no-store`: a figure computed for one person is never cached for another.
 */
export function registerInsights(app: FastifyInstance, work: ReportService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const page = (
    request: FastifyRequest,
    r: { data: unknown[]; page: Record<string, unknown> },
  ) => ({ ...r, meta: m(request) });
  const done = <T extends { id: string; type: string; version?: number }>(
    request: FastifyRequest,
    reply: FastifyReply,
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);
  const flat = (
    request: FastifyRequest,
    reply: FastifyReply,
    type: NonResourceType,
    data: Record<string, unknown>,
  ) =>
    reply
      .code(200)
      .header('cache-control', 'private, no-store')
      .send(nonResourceEnvelope(type, data, m(request)));
  const file = (
    reply: FastifyReply,
    r: { filename: string; contentType: string; body: string | Buffer },
  ) =>
    reply
      .code(200)
      .header('content-type', r.contentType)
      .header('content-disposition', `attachment; filename="${r.filename}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(r.body);

  app.get(
    `${ws}/insights/metrics`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'insight_metrics',
        await work.insightMetrics(caller(request), p(request).ws),
      ),
    ),
  );
  app.get(
    `${ws}/insights/trash`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'insight_metrics',
        await work.listTrashedInsights(caller(request), p(request).ws),
      ),
    ),
  );

  // ---- Dashboards --------------------------------------------------------------------------------
  app.get(
    `${ws}/dashboards`,
    wrap(async (request) =>
      page(request, await work.listDashboards(caller(request), p(request).ws, q(request))),
    ),
  );
  app.post(
    `${ws}/dashboards`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createDashboard(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/dashboards/:dash`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getDashboard(caller(request), p(request).ws, p(request).dash),
      ),
    ),
  );
  app.patch(
    `${ws}/dashboards/:dash`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateDashboard(
          caller(request),
          p(request).ws,
          p(request).dash,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  // Verbs: `{dash}:archive`, `:unarchive`, `:trash`, `:restore`, `:purge`.
  app.post(
    `${ws}/dashboards/:dash`,
    wrap(async (request, reply) => {
      const t = split(p(request).dash);
      if (!t || !VERBS.includes(t.verb)) return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.dashboardLifecycle(
          caller(request),
          p(request).ws,
          t.id,
          t.verb as Verb,
          mutation(request),
        ),
      );
    }),
  );
  app.get(
    `${ws}/dashboards/:dash/widgets/:wdg`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'widget_result',
        await work.dashboardWidget(
          caller(request),
          p(request).ws,
          p(request).dash,
          p(request).wdg,
          q(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/dashboards/:dash/widgets/:wdg/records`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'widget_records',
        await work.dashboardDrill(
          caller(request),
          p(request).ws,
          p(request).dash,
          p(request).wdg,
          q(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/dashboards/:dash/export`,
    wrap(async (request, reply) =>
      file(
        reply,
        await work.exportDashboard(caller(request), p(request).ws, p(request).dash, q(request)),
      ),
    ),
  );

  // ---- Reports -----------------------------------------------------------------------------------
  app.get(
    `${ws}/reports`,
    wrap(async (request) =>
      page(request, await work.listReports(caller(request), p(request).ws, q(request))),
    ),
  );
  app.post(
    `${ws}/reports`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createReport(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/reports/:rpt`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getReport(caller(request), p(request).ws, p(request).rpt),
      ),
    ),
  );
  app.patch(
    `${ws}/reports/:rpt`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateReport(
          caller(request),
          p(request).ws,
          p(request).rpt,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  // Verbs: `{rpt}:archive`, `:unarchive`, `:trash`, `:restore`, `:purge`, `:resume`, `:leave`.
  app.post(
    `${ws}/reports/:rpt`,
    wrap(async (request, reply) => {
      const t = split(p(request).rpt);
      if (!t) return fail(request, reply, 'not_found');
      const c = caller(request);
      const w = p(request).ws;
      const req = mutation(request);
      if (VERBS.includes(t.verb))
        return done(request, reply, await work.reportLifecycle(c, w, t.id, t.verb as Verb, req));
      if (t.verb === 'resume')
        return done(request, reply, await work.resumeReport(c, w, t.id, req));
      if (t.verb === 'leave') return done(request, reply, await work.leaveReport(c, w, t.id, req));
      return fail(request, reply, 'not_found');
    }),
  );
  app.put(
    `${ws}/reports/:rpt/schedule`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.setReportSchedule(
          caller(request),
          p(request).ws,
          p(request).rpt,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/reports/:rpt/recipients`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'report_recipients',
        await work.listReportRecipients(caller(request), p(request).ws, p(request).rpt),
      ),
    ),
  );
  app.put(
    `${ws}/reports/:rpt/recipients`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.setReportRecipients(
          caller(request),
          p(request).ws,
          p(request).rpt,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/reports/:rpt/runs`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'report_runs',
        await work.listReportRuns(caller(request), p(request).ws, p(request).rpt),
      ),
    ),
  );
  app.get(
    `${ws}/reports/:rpt/shares`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'report_shares',
        await work.listReportShares(caller(request), p(request).ws, p(request).rpt),
      ),
    ),
  );
  app.post(
    `${ws}/reports/:rpt/shares`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.shareReport(
          caller(request),
          p(request).ws,
          p(request).rpt,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/reports/:rpt/shares/:rsh`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.revokeReportShare(
          caller(request),
          p(request).ws,
          p(request).rpt,
          p(request).rsh,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/reports/:rpt/widgets/:wdg`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'widget_result',
        await work.reportWidget(
          caller(request),
          p(request).ws,
          p(request).rpt,
          p(request).wdg,
          q(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/reports/:rpt/widgets/:wdg/records`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'widget_records',
        await work.reportDrill(
          caller(request),
          p(request).ws,
          p(request).rpt,
          p(request).wdg,
          q(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/reports/:rpt/export`,
    wrap(async (request, reply) =>
      file(
        reply,
        await work.exportReport(caller(request), p(request).ws, p(request).rpt, q(request)),
      ),
    ),
  );
}
