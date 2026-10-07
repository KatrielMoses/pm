import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { CapacityService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; brand?: string; tof?: string; hol?: string; rsv?: string };

/**
 * Capacity and cross-brand conflicts (3E, ADR-0022; 0D PL-32): the caller's own working hours
 * (`/me/capacity-profile`, a non-resource subject with the version as ETag) and time off; brand
 * holidays; per-brand reservations; and the computed reads — one person's capacity, the team's,
 * and the caller's capacity-aware rescheduling inputs.
 */
export function registerCapacity(app: FastifyInstance, work: CapacityService): void {
  const { m, caller, mutation, wrap, resource } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const done = <T extends { id: string; type: string }>(
    request: FastifyRequest,
    reply: FastifyReply,
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);
  const list = <T>(request: FastifyRequest, data: T[]) => ({
    data,
    page: { limit: data.length, has_more: false },
    meta: m(request),
  });

  // ---- Working hours (personal) ------------------------------------------------------------------
  app.get(
    `${ws}/me/capacity-profile`,
    wrap(async (request, reply) => {
      const r = await work.myCapacityProfile(caller(request), p(request).ws);
      reply.header('etag', `"${r.version}"`);
      return nonResourceEnvelope('capacity_profile', r, m(request));
    }),
  );
  app.put(
    `${ws}/me/capacity-profile`,
    wrap(async (request, reply) => {
      const r = await work.setMyCapacityProfile(
        caller(request),
        p(request).ws,
        request.body,
        mutation(request),
      );
      const { id: _id, type: _type, ...rest } = r.data;
      reply.header('etag', `"${rest.version}"`);
      if (r.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(r.status).send(nonResourceEnvelope('capacity_profile', rest, m(request)));
    }),
  );

  // ---- Time off (personal) -----------------------------------------------------------------------
  app.get(
    `${ws}/me/time-off`,
    wrap(async (request) => {
      const r = await work.listTimeOff(caller(request), p(request).ws, q(request));
      return list(request, r.data);
    }),
  );
  app.post(
    `${ws}/me/time-off`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createTimeOff(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.patch(
    `${ws}/me/time-off/:tof`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateTimeOff(
          caller(request),
          p(request).ws,
          p(request).tof,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/me/time-off/:tof`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.deleteTimeOff(caller(request), p(request).ws, p(request).tof, mutation(request)),
      ),
    ),
  );

  // ---- Brand holidays (brand.configure) ----------------------------------------------------------
  app.get(
    `${ws}/brands/:brand/holidays`,
    wrap(async (request) => {
      const r = await work.listHolidays(
        caller(request),
        p(request).ws,
        p(request).brand,
        q(request),
      );
      return { ...list(request, r.data), can_configure: r.can_configure };
    }),
  );
  app.post(
    `${ws}/brands/:brand/holidays`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createHoliday(
          caller(request),
          p(request).ws,
          p(request).brand,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/brands/:brand/holidays/:hol`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.deleteHoliday(
          caller(request),
          p(request).ws,
          p(request).brand,
          p(request).hol,
          mutation(request),
        ),
      ),
    ),
  );

  // ---- Reservations (capacity.reserve) -----------------------------------------------------------
  app.get(
    `${ws}/capacity-reservations`,
    wrap(async (request) => {
      const r = await work.listReservations(caller(request), p(request).ws, q(request));
      return list(request, r.data);
    }),
  );
  app.post(
    `${ws}/capacity-reservations`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.setReservation(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.delete(
    `${ws}/capacity-reservations/:rsv`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.deleteReservation(
          caller(request),
          p(request).ws,
          p(request).rsv,
          mutation(request),
        ),
      ),
    ),
  );

  // ---- Computed reads ----------------------------------------------------------------------------
  app.get(
    `${ws}/capacity`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'capacity',
        await work.personCapacity(caller(request), p(request).ws, q(request)),
        m(request),
      ),
    ),
  );
  app.get(
    `${ws}/capacity/team`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'team_capacity',
        await work.teamCapacity(caller(request), p(request).ws, q(request)),
        m(request),
      ),
    ),
  );
  app.get(
    `${ws}/me/rescheduling-inputs`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'rescheduling_inputs',
        await work.reschedulingInputs(caller(request), p(request).ws, q(request)),
        m(request),
      ),
    ),
  );
}
