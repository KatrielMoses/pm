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
import { TenancyError, type Caller, type CollaborationService, type Mutation } from '@pm/tenancy';

export interface TenancyRouteDeps {
  tenancy: CollaborationService;
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
      if (t?.verb === 'leave') {
        const r = await tenancy.leave(caller(request), t.id, request.body ?? {}, mutation(request));
        return resource(request, reply, r.data, r);
      }
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

  // ---- People, invitations, teams, access, shares, policy, ownership (1D) ---------------------
  type Q = Record<string, unknown>;
  const list = <T>(request: FastifyRequest, data: T[]) => ({
    data,
    page: { limit: 500, has_more: false },
    meta: m(request),
  });
  const ws = (request: FastifyRequest) => params(request).ws;
  type P1 = {
    mem?: string;
    inv?: string;
    team?: string;
    shr?: string;
    otr?: string;
    brand?: string;
  };
  const p1 = (request: FastifyRequest) => request.params as P1;

  app.get(
    '/v1/workspaces/:ws/people',
    wrap(async (request) =>
      list(request, await tenancy.listMembers(caller(request), ws(request), q(request) as Q)),
    ),
  );
  app.get(
    '/v1/workspaces/:ws/people/:mem',
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await tenancy.getMember(caller(request), ws(request), p1(request).mem),
      ),
    ),
  );
  app.get(
    '/v1/workspaces/:ws/people/:mem/access',
    wrap(async (request) =>
      nonResourceEnvelope(
        'access_explanation',
        { ...(await tenancy.previewMember(caller(request), ws(request), p1(request).mem)) },
        m(request),
      ),
    ),
  );
  app.get(
    '/v1/workspaces/:ws/people/:mem/departure-plan',
    wrap(async (request) =>
      nonResourceEnvelope(
        'departure_plan',
        { ...(await tenancy.departurePlan(caller(request), ws(request), p1(request).mem)) },
        m(request),
      ),
    ),
  );
  app.post(
    '/v1/workspaces/:ws/people/:mem',
    wrap(async (request, reply) => {
      const t = split(p1(request).mem);
      const c = caller(request);
      const r =
        t?.verb === 'reactivate'
          ? await tenancy.reactivateMember(c, ws(request), t.id, mutation(request))
          : t?.verb === 'remove'
            ? await tenancy.removeMember(
                c,
                ws(request),
                t.id,
                request.body ?? {},
                mutation(request),
              )
            : undefined;
      if (!r) return fail(request, reply, 'not_found');
      return resource(request, reply, r.data, r);
    }),
  );

  // Proposed permission changes: preview (diff + fingerprint), then apply (step-up where needed).
  app.post(
    '/v1/workspaces/:ws/access::preview',
    wrap(async (request) =>
      nonResourceEnvelope(
        'permission_preview',
        {
          ...(await tenancy.previewChange(
            caller(request),
            ws(request),
            (request.body as Q)?.change,
          )),
        },
        m(request),
      ),
    ),
  );
  app.post(
    '/v1/workspaces/:ws/access::apply',
    wrap(async (request, reply) => {
      const r = await tenancy.applyChange(
        caller(request),
        ws(request),
        request.body ?? {},
        mutation(request),
      );
      if (r.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(r.status).send(
        nonResourceEnvelope(
          'permission_change',
          {
            applied: r.data.applied,
            diff: r.data.diff,
            target: { id: r.data.id, type: r.data.type },
          },
          m(request),
        ),
      );
    }),
  );
  app.get(
    '/v1/workspaces/:ws/brands/:brand/access',
    wrap(async (request) =>
      nonResourceEnvelope(
        'brand_access',
        { ...(await tenancy.listBrandAccess(caller(request), ws(request), p1(request).brand)) },
        m(request),
      ),
    ),
  );

  app.get(
    '/v1/workspaces/:ws/invitations',
    wrap(async (request) =>
      list(request, await tenancy.listInvitations(caller(request), ws(request), q(request) as Q)),
    ),
  );
  app.post(
    '/v1/workspaces/:ws/invitations',
    wrap(async (request, reply) => {
      const r = await tenancy.invite(caller(request), ws(request), request.body, mutation(request));
      return resource(request, reply, r.data, r);
    }),
  );
  app.post(
    '/v1/workspaces/:ws/invitations/:inv',
    wrap(async (request, reply) => {
      const t = split(p1(request).inv);
      const c = caller(request);
      const r =
        t?.verb === 'resend'
          ? await tenancy.resendInvitation(c, ws(request), t.id, mutation(request))
          : t?.verb === 'revoke'
            ? await tenancy.revokeInvitation(c, ws(request), t.id, mutation(request))
            : undefined;
      if (!r) return fail(request, reply, 'not_found');
      return resource(request, reply, r.data, r);
    }),
  );
  // Recipient side: no workspace in the path (the token names it); the account is the session.
  app.post(
    '/v1/invitations::inspect',
    wrap(async (request) =>
      nonResourceEnvelope(
        'invitation_preview',
        { ...(await tenancy.inspectInvitation(caller(request), request.body ?? {})) },
        m(request),
      ),
    ),
  );
  app.post(
    '/v1/invitations::accept',
    wrap(async (request) => {
      const r = await tenancy.acceptInvitation(
        caller(request),
        request.body ?? {},
        mutation(request),
      );
      return nonResourceEnvelope(
        'invitation_acceptance',
        { workspace: r.workspace, status: r.replayed ? 'already_accepted' : 'accepted' },
        m(request),
      );
    }),
  );

  app.get(
    '/v1/workspaces/:ws/teams',
    wrap(async (request) =>
      list(request, await tenancy.listTeams(caller(request), ws(request), q(request) as Q)),
    ),
  );
  app.post(
    '/v1/workspaces/:ws/teams',
    wrap(async (request, reply) => {
      const r = await tenancy.createTeam(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
  app.get(
    '/v1/workspaces/:ws/teams/:team',
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await tenancy.getTeam(caller(request), ws(request), p1(request).team),
      ),
    ),
  );
  app.patch(
    '/v1/workspaces/:ws/teams/:team',
    wrap(async (request, reply) => {
      const r = await tenancy.updateTeam(
        caller(request),
        ws(request),
        p1(request).team,
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
  app.post(
    '/v1/workspaces/:ws/teams/:team',
    wrap(async (request, reply) => {
      const t = split(p1(request).team);
      if (t?.verb !== 'archive' && t?.verb !== 'restore') return fail(request, reply, 'not_found');
      const r = await tenancy.setTeamArchived(
        caller(request),
        ws(request),
        t.id,
        t.verb === 'archive',
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );

  app.get(
    '/v1/workspaces/:ws/shared',
    wrap(async (request) =>
      list(request, await tenancy.listReadableRecords(caller(request), ws(request))),
    ),
  );
  app.post(
    '/v1/workspaces/:ws/shares',
    wrap(async (request, reply) => {
      const r = await tenancy.createShare(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
  app.post(
    '/v1/workspaces/:ws/shares/:shr',
    wrap(async (request, reply) => {
      const t = split(p1(request).shr);
      if (t?.verb !== 'revoke') return fail(request, reply, 'not_found');
      const r = await tenancy.revokeShare(caller(request), ws(request), t.id, mutation(request));
      return resource(request, reply, r.data, r);
    }),
  );

  app.get(
    '/v1/workspaces/:ws/policy',
    wrap(async (request) =>
      nonResourceEnvelope(
        'workspace_policy',
        { ...(await tenancy.getPolicy(caller(request), ws(request))) },
        m(request),
      ),
    ),
  );
  app.patch(
    '/v1/workspaces/:ws/policy',
    wrap(async (request, reply) => {
      const r = await tenancy.updatePolicy(
        caller(request),
        ws(request),
        request.body ?? {},
        mutation(request),
      );
      if (r.replayed) reply.header('idempotent-replayed', 'true');
      const { id: _id, type: _type, ...rest } = r.data as Record<string, unknown>;
      return nonResourceEnvelope('workspace_policy', rest, m(request));
    }),
  );

  app.get(
    '/v1/workspaces/:ws/ownership-transfer',
    wrap(async (request) =>
      nonResourceEnvelope(
        'ownership_transfer_status',
        { transfer: await tenancy.getOwnershipTransfer(caller(request), ws(request)) },
        m(request),
      ),
    ),
  );
  app.post(
    '/v1/workspaces/:ws/ownership-transfer',
    wrap(async (request, reply) => {
      const r = await tenancy.requestOwnershipTransfer(
        caller(request),
        ws(request),
        request.body ?? {},
        mutation(request),
      );
      return resource(request, reply, r.data, r);
    }),
  );
  app.post(
    '/v1/workspaces/:ws/ownership-transfer/:otr',
    wrap(async (request, reply) => {
      const t = split(p1(request).otr);
      const c = caller(request);
      const r =
        t?.verb === 'accept'
          ? await tenancy.acceptOwnershipTransfer(c, ws(request), t.id, mutation(request))
          : t?.verb === 'cancel'
            ? await tenancy.cancelOwnershipTransfer(c, ws(request), t.id, mutation(request))
            : undefined;
      if (!r) return fail(request, reply, 'not_found');
      return resource(request, reply, r.data, r);
    }),
  );
}
