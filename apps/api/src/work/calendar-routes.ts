import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope, type NonResourceType } from '@pm/contracts';
import { requestFingerprint } from '@pm/platform';
import { TenancyError } from '@pm/tenancy';
import type { CalendarService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; conn?: string; blk?: string; cev?: string };

const STATE = /^(ws_[0-9A-HJKMNP-TV-Z]{26})\.(conn_[0-9A-HJKMNP-TV-Z]{26})\.[A-Za-z0-9_-]{16,64}$/;

/**
 * Connected calendars (6C, completed in the Phase 6 integration review; ADR-0037). Every read is
 * the person's own (calendars, events, conflicts); every response is private and uncached. The
 * OAuth callback finishes a live authorization in the browser and returns to the integrations
 * settings page with an outcome only, never a token or provider message.
 */
export function registerCalendar(app: FastifyInstance, work: CalendarService): void {
  const { m, caller, mutation, wrap, resource } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
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
  const done = (
    request: FastifyRequest,
    reply: FastifyReply,
    r: { data: { id: string; type: string; version?: number }; status: number; replayed: boolean },
  ) => resource(request, reply.header('cache-control', 'private, no-store'), r.data, r);

  app.get(
    `${ws}/calendar-events`,
    wrap(async (request, reply) => {
      const query = q(request);
      return flat(
        request,
        reply,
        'calendar_events',
        await work.listCalendarEvents(caller(request), p(request).ws, {
          ...(typeof query.from === 'string' ? { from: query.from } : {}),
          ...(typeof query.to === 'string' ? { to: query.to } : {}),
        }),
      );
    }),
  );
  app.get(
    `${ws}/calendar-conflicts`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'calendar_conflicts',
        await work.listCalendarConflicts(caller(request), p(request).ws),
      ),
    ),
  );
  app.get(
    `${ws}/integrations/connections/:conn/calendars`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'calendar_sources',
        await work.listCalendars(caller(request), p(request).ws, p(request).conn),
      ),
    ),
  );
  app.put(
    `${ws}/integrations/connections/:conn/calendars`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateCalendars(
          caller(request),
          p(request).ws,
          p(request).conn,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/work-blocks/:blk/calendar`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.publishBlock(
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
    `${ws}/work-blocks/:blk/calendar`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.unlinkBlock(caller(request), p(request).ws, p(request).blk, mutation(request)),
      ),
    ),
  );
  app.post(
    `${ws}/calendar-events/:cev/link`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.linkEvent(
          caller(request),
          p(request).ws,
          p(request).cev,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );

  // The provider redirects the browser here. The session is the caller; the state names the
  // workspace and connection and is matched against the pending authorization before anything
  // is exchanged. A repeat of the same redirect replays the first outcome (idempotency by state).
  app.get('/v1/integrations/oauth/google_calendar/callback', async (request, reply) => {
    reply.header('cache-control', 'private, no-store').header('referrer-policy', 'no-referrer');
    const query = q(request);
    const state = typeof query.state === 'string' ? query.state : '';
    const parts = STATE.exec(state);
    if (!parts) return reply.redirect('/?calendar=invalid', 303);
    const [, wsId, connId] = parts;
    const back = (outcome: string) =>
      reply.redirect(
        `/workspaces/${wsId}/settings/integrations?connection=${connId}&calendar=${outcome}`,
        303,
      );
    if (!request.auth) return reply.redirect(`/sign-in?calendar=signin_required`, 303);
    if (typeof query.error === 'string') return back('denied');
    if (typeof query.code !== 'string' || !query.code) return back('invalid');
    try {
      await work.completeOauth(
        caller(request),
        wsId,
        connId,
        { code: query.code, state },
        {
          idempotencyKey: `oauth-${createHash('sha256').update(state).digest('hex').slice(0, 40)}`,
          fingerprint: requestFingerprint({
            method: 'GET',
            route: '/v1/integrations/oauth/google_calendar/callback',
            pathParams: {},
            query: { state },
            body: null,
          }),
          stepUpToken: undefined,
          ifMatch: undefined,
        },
      );
      return back('connected');
    } catch (err) {
      if (!(err instanceof TenancyError)) throw err;
      const code = err.issues[0]?.code;
      return back(
        code === 'provider_unavailable'
          ? 'unavailable'
          : code === 'insufficient_scope'
            ? 'scope_declined'
            : err.code === 'not_found'
              ? 'not_found'
              : 'invalid',
      );
    }
  });
}
