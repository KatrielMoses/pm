import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope, type NonResourceType } from '@pm/contracts';
import type { NotificationService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; ntf?: string; ndl?: string; rec?: string };

/**
 * The notification platform (4B, ADR-0024; 0D PL-34). Everything under `/me` is the caller's own:
 * their notifications, profile, preferences, browser deliveries, and delivery history. Delivery
 * health and defaults for a brand or project belong to the people who administer them. The service
 * decides every read and write at the time of the request, so a route never reveals more than the
 * caller may see now. Unsafe requests carry `Idempotency-Key`; the profile and each notification's
 * state carry `If-Match`.
 */
export function registerNotifications(app: FastifyInstance, work: NotificationService): void {
  const { m, caller, mutation, wrap, resource } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const page = <T>(request: FastifyRequest, r: { data: T[]; page: Record<string, unknown> }) => ({
    data: r.data,
    page: r.page,
    meta: m(request),
  });
  const flat = (
    request: FastifyRequest,
    reply: FastifyReply,
    type: NonResourceType,
    data: Record<string, unknown>,
    r?: { status: number; replayed: boolean },
  ) => {
    const { id: _id, type: _type, ...rest } = data;
    if (typeof rest.version === 'number') reply.header('etag', `"${rest.version}"`);
    if (r?.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(r?.status ?? 200).send(nonResourceEnvelope(type, rest, m(request)));
  };

  // ---- The caller's notifications ---------------------------------------------------------------
  app.get(
    `${ws}/me/notifications`,
    wrap(async (request) =>
      page(request, await work.listNotifications(caller(request), p(request).ws, q(request))),
    ),
  );
  app.get(
    `${ws}/me/notifications/counts`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'notification_counts',
        await work.notificationCounts(caller(request), p(request).ws),
      ),
    ),
  );
  app.get(
    `${ws}/me/notifications/browser-pending`,
    wrap(async (request) => {
      const r = await work.browserPending(caller(request), p(request).ws);
      return { data: r.data, page: { limit: r.data.length, has_more: false }, meta: m(request) };
    }),
  );
  app.get(
    `${ws}/me/notifications/:ntf`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getNotification(caller(request), p(request).ws, p(request).ntf),
      ),
    ),
  );
  app.patch(
    `${ws}/me/notifications/:ntf`,
    wrap(async (request, reply) => {
      const r = await work.setNotificationState(
        caller(request),
        p(request).ws,
        p(request).ntf,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
  app.post(
    `${ws}/me/notification-bulk`,
    wrap(async (request, reply) => {
      const r = await work.bulkNotificationState(
        caller(request),
        p(request).ws,
        request.body,
        mutation(request),
      );
      return flat(request, reply, 'notification_update', r.data, r);
    }),
  );

  // ---- Profile and preferences --------------------------------------------------------------------
  app.get(
    `${ws}/me/notification-profile`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'notification_profile',
        await work.notificationProfile(caller(request), p(request).ws),
      ),
    ),
  );
  app.put(
    `${ws}/me/notification-profile`,
    wrap(async (request, reply) => {
      const r = await work.setNotificationProfile(
        caller(request),
        p(request).ws,
        request.body,
        mutation(request),
      );
      return flat(request, reply, 'notification_profile', r.data, r);
    }),
  );
  app.get(
    `${ws}/me/notification-preferences`,
    wrap(async (request, reply) => {
      const r = await work.notificationPreferences(caller(request), p(request).ws);
      const { data, ...rest } = r;
      return reply.send({ data, ...rest, meta: m(request) });
    }),
  );
  app.put(
    `${ws}/me/notification-preferences`,
    wrap(async (request, reply) => {
      const r = await work.setNotificationPreference(
        caller(request),
        p(request).ws,
        request.body,
        mutation(request),
      );
      return flat(request, reply, 'notification_preference', r.data, r);
    }),
  );
  app.delete(
    `${ws}/me/notification-preferences`,
    wrap(async (request, reply) => {
      const r = await work.removeNotificationPreference(
        caller(request),
        p(request).ws,
        q(request),
        mutation(request),
      );
      return flat(request, reply, 'notification_preference', r.data, r);
    }),
  );

  // ---- Deliveries: the caller's, the browser's acknowledgement, and administration ------------------
  app.get(
    `${ws}/me/notification-deliveries`,
    wrap(async (request) =>
      page(request, await work.myDeliveries(caller(request), p(request).ws, q(request))),
    ),
  );
  app.post(
    `${ws}/me/notification-deliveries/:ndl/ack`,
    wrap(async (request, reply) => {
      const r = await work.acknowledgeBrowser(
        caller(request),
        p(request).ws,
        p(request).ndl,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
  app.get(
    `${ws}/notification-deliveries`,
    wrap(async (request, reply) => {
      const r = await work.deliveryProblems(caller(request), p(request).ws, q(request));
      return reply.send({ data: r.data, page: r.page, email: r.email, meta: m(request) });
    }),
  );
  app.post(
    `${ws}/notification-deliveries/:ndl/retry`,
    wrap(async (request, reply) => {
      const r = await work.retryDelivery(
        caller(request),
        p(request).ws,
        p(request).ndl,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );

  // ---- Brand and project defaults -----------------------------------------------------------------------
  for (const kind of ['brands', 'projects'] as const) {
    const base = `${ws}/${kind}/:rec/notification-defaults`;
    app.get(
      base,
      wrap(async (request) => {
        const r = await work.scopeDefaults(caller(request), p(request).ws, p(request).rec);
        return { data: r.data, page: { limit: r.data.length, has_more: false }, meta: m(request) };
      }),
    );
    app.put(
      base,
      wrap(async (request, reply) => {
        const r = await work.setScopeDefault(
          caller(request),
          p(request).ws,
          p(request).rec,
          request.body,
          mutation(request),
        );
        return flat(request, reply, 'notification_default', r.data, r);
      }),
    );
    app.delete(
      base,
      wrap(async (request, reply) => {
        const r = await work.removeScopeDefault(
          caller(request),
          p(request).ws,
          p(request).rec,
          q(request),
          mutation(request),
        );
        return flat(request, reply, 'notification_default', r.data, r);
      }),
    );
  }
}
