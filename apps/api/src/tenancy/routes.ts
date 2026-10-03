import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  errorEnvelope,
  meta,
  nonResourceEnvelope,
  successEnvelope,
  type ErrorCode,
} from '@pm/contracts';
import { currentTraceparent } from '@pm/observability';
import { requestFingerprint } from '@pm/platform';
import { IdentityError } from '@pm/identity';
import { TenancyError, type Caller, type Mutation, type TenancyService } from '@pm/tenancy';

export interface TenancyRouteDeps {
  tenancy: TenancyService;
}

/** URL settings segments → service namespaces. */
const SETTINGS: Record<string, string> = {
  'working-hours': 'working_hours',
  calendar: 'calendar',
  priorities: 'priorities',
};

/**
 * Workspace, brand, settings, and context routes (1C). The workspace is always the path segment;
 * the person is always the session. Body, query, and header claims about workspaces, memberships,
 * roles, or brand lists are never read. Every identifier in a response is a public ID.
 */
export function registerTenancy(app: FastifyInstance, deps: TenancyRouteDeps): void {
  const { tenancy } = deps;

  const m = (request: FastifyRequest) => meta(request.pm.requestId, request.pm.correlationId);

  const fail = (
    request: FastifyRequest,
    reply: FastifyReply,
    code: ErrorCode,
    extra: Parameters<typeof errorEnvelope>[2] = {},
  ) => {
    const body = errorEnvelope(
      code,
      { requestId: request.pm.requestId, correlationId: request.pm.correlationId },
      extra,
    );
    if (extra.retryAfterSeconds !== undefined)
      reply.header('retry-after', String(extra.retryAfterSeconds));
    return reply.code(body.error.status).header('cache-control', 'private, no-store').send(body);
  };

  const caller = (request: FastifyRequest): Caller => {
    if (!request.auth) throw new IdentityError('unauthenticated');
    return {
      auth: request.auth,
      meta: {
        ip: request.ip,
        userAgent:
          typeof request.headers['user-agent'] === 'string'
            ? request.headers['user-agent']
            : undefined,
        requestId: request.pm.requestId,
        correlationId: request.pm.correlationId,
        traceparent: currentTraceparent(),
      },
    };
  };

  const header = (request: FastifyRequest, name: string): string | undefined => {
    const v = request.headers[name];
    return typeof v === 'string' ? v : undefined;
  };

  const mutation = (request: FastifyRequest): Mutation => {
    const ifMatch = header(request, 'if-match');
    return {
      idempotencyKey: header(request, 'idempotency-key') ?? '',
      fingerprint: requestFingerprint({
        method: request.method,
        route: request.routeOptions.url ?? '',
        pathParams: (request.params ?? {}) as Record<string, string>,
        query: (request.query ?? {}) as Record<string, string>,
        body: request.body ?? null,
        ...(ifMatch !== undefined ? { ifMatch } : {}),
      }),
      stepUpToken: header(request, 'step-up'),
      ifMatch,
    };
  };

  const wrap =
    <T>(fn: (request: FastifyRequest, reply: FastifyReply) => Promise<T>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(request, reply);
      } catch (err) {
        if (err instanceof TenancyError)
          return fail(request, reply, err.code, {
            ...(err.issues.length ? { issues: err.issues } : {}),
            ...(err.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: err.retryAfterSeconds }
              : {}),
            ...(err.stepUp ? { stepUp: err.stepUp } : {}),
            ...(err.conflict
              ? { conflict: err.conflict as unknown as Record<string, unknown> }
              : {}),
          });
        if (err instanceof IdentityError)
          return fail(request, reply, err.code, {
            ...(err.issues.length ? { issues: err.issues } : {}),
            ...(err.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: err.retryAfterSeconds }
              : {}),
          });
        throw err;
      }
    };

  /** A versioned resource response: `ETag: "<version>"` (0D §2.6) and the replay marker. */
  const resource = <T extends { id: string; type: string; version?: number }>(
    request: FastifyRequest,
    reply: FastifyReply,
    data: T,
    result?: { status: number; replayed: boolean },
  ) => {
    if (data.version !== undefined) reply.header('etag', `"${data.version}"`);
    if (result?.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(result?.status ?? 200).send(successEnvelope(data, m(request)));
  };

  /** `{id}:{verb}` action segments (0D); any other verb is `not_found`, like an unknown route. */
  const split = (raw: string | undefined): { id: string; verb: string } | undefined => {
    const i = (raw ?? '').lastIndexOf(':');
    return i > 0 ? { id: raw!.slice(0, i), verb: raw!.slice(i + 1) } : undefined;
  };

  type P = { ws?: string; brand?: string; ns?: string };
  const params = (request: FastifyRequest) => request.params as P;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;

  // ---- Workspaces -----------------------------------------------------------------------------
  app.get(
    '/v1/workspaces',
    wrap(async (request) => {
      const rows = await tenancy.listWorkspaces(caller(request));
      return { data: rows, page: { limit: 200, has_more: false }, meta: m(request) };
    }),
  );

  app.post(
    '/v1/workspaces',
    wrap(async (request, reply) => {
      const r = await tenancy.createWorkspace(caller(request), request.body, mutation(request));
      return resource(request, reply, { ...r.data.workspace, first_brand: r.data.first_brand }, r);
    }),
  );

  app.get(
    '/v1/workspaces/:ws',
    wrap(async (request, reply) =>
      resource(request, reply, await tenancy.getWorkspace(caller(request), params(request).ws)),
    ),
  );

  app.patch(
    '/v1/workspaces/:ws',
    wrap(async (request, reply) => {
      const r = await tenancy.updateWorkspace(
        caller(request),
        params(request).ws,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );

  // `POST /v1/workspaces/{ws}:select` — select the workspace and optionally a brand/all scope.
  app.post(
    '/v1/workspaces/:ws',
    wrap(async (request, reply) => {
      const t = split(params(request).ws);
      if (!t || t.verb !== 'select') return fail(request, reply, 'not_found');
      const ctx = await tenancy.selectContext(caller(request), t.id, request.body ?? {});
      return nonResourceEnvelope('workspace_context', { ...ctx }, m(request));
    }),
  );

  app.get(
    '/v1/workspaces/:ws/context',
    wrap(async (request) => {
      const ctx = await tenancy.getContext(caller(request), params(request).ws, {
        includeArchived: q(request).include_archived === 'true',
      });
      return nonResourceEnvelope('workspace_context', { ...ctx }, m(request));
    }),
  );

  // ---- Brands ---------------------------------------------------------------------------------
  app.get(
    '/v1/workspaces/:ws/brands',
    wrap(async (request) => {
      const page = await tenancy.listBrands(caller(request), params(request).ws, q(request));
      return { ...page, meta: m(request) };
    }),
  );

  app.post(
    '/v1/workspaces/:ws/brands',
    wrap(async (request, reply) => {
      const r = await tenancy.createBrand(
        caller(request),
        params(request).ws,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );

  app.get(
    '/v1/workspaces/:ws/brands/:brand',
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await tenancy.getBrand(caller(request), params(request).ws, params(request).brand),
      ),
    ),
  );

  app.patch(
    '/v1/workspaces/:ws/brands/:brand',
    wrap(async (request, reply) => {
      const r = await tenancy.updateBrand(
        caller(request),
        params(request).ws,
        params(request).brand,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );

  // Brand actions: `…/brands/{br}:archive`, `:restore` (If-Match), `:set-sensitivity` (step-up).
  app.post(
    '/v1/workspaces/:ws/brands/:brand',
    wrap(async (request, reply) => {
      const t = split(params(request).brand);
      const ws = params(request).ws;
      const c = caller(request);
      const r =
        t?.verb === 'archive'
          ? await tenancy.archiveBrand(c, ws, t.id, mutation(request))
          : t?.verb === 'restore'
            ? await tenancy.restoreBrand(c, ws, t.id, mutation(request))
            : t?.verb === 'set-sensitivity'
              ? await tenancy.setSensitivity(c, ws, t.id, request.body, mutation(request))
              : undefined;
      if (!r) return fail(request, reply, 'not_found');
      return resource(request, reply, r.data, r);
    }),
  );

  // ---- Brand settings -------------------------------------------------------------------------
  app.get(
    '/v1/workspaces/:ws/brands/:brand/settings',
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await tenancy.getBrandSettings(caller(request), params(request).ws, params(request).brand),
      ),
    ),
  );

  app.put(
    '/v1/workspaces/:ws/brands/:brand/settings/:ns',
    wrap(async (request, reply) => {
      const ns = SETTINGS[params(request).ns ?? ''];
      if (!ns) return fail(request, reply, 'not_found');
      const r = await tenancy.updateBrandSettings(
        caller(request),
        params(request).ws,
        params(request).brand,
        ns,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
}
