import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { NavigationService } from '@pm/tenancy';
import { routeKit } from '../route-kit.ts';

export interface TenancyRouteDeps {
  tenancy: NavigationService;
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

  const { m, fail, caller, header, mutation, wrap, resource, split, device } = routeKit();

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
      const ctx = await tenancy.selectContext(caller(request), t.id, request.body ?? {}, {
        device: device(request),
      });
      return nonResourceEnvelope('workspace_context', { ...ctx }, m(request));
    }),
  );

  app.get(
    '/v1/workspaces/:ws/context',
    wrap(async (request) => {
      const ctx = await tenancy.getContext(caller(request), params(request).ws, {
        includeArchived: q(request).include_archived === 'true',
        // The URL scope token (validated and normalized server-side, never trusted).
        scope: q(request).scope,
        device: device(request),
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

  // ---- External effect reconciliation (ADR-0045) ---------------------------------------------
  // Session-only (bearer tokens are refused at the gate and in the service); owners and
  // administrators; the decision needs step-up and the version that was reviewed.
  app.get(
    '/v1/workspaces/:ws/operations/effects',
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'external_effects',
            await tenancy.listUncertainEffects(caller(request), params(request).ws),
            m(request),
          ),
        ),
    ),
  );

  // `…/operations/{op}/effects/{effect key}:reconcile` (the key may itself contain colons).
  app.post(
    '/v1/workspaces/:ws/operations/:op/effects/:effect',
    wrap(async (request, reply) => {
      const p = request.params as { ws: string; op: string; effect: string };
      const t = split(p.effect);
      if (!t || t.verb !== 'reconcile') return fail(request, reply, 'not_found');
      const r = await tenancy.reconcileExternalEffect(
        caller(request),
        p.ws,
        p.op,
        t.id,
        request.body,
        mutation(request),
      );
      const { id: _id, type: _type, ...rest } = r.data;
      if (r.replayed) reply.header('idempotent-replayed', 'true');
      return reply
        .code(r.status)
        .header('cache-control', 'private, no-store')
        .send(nonResourceEnvelope('external_effect_reconciliation', rest, m(request)));
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

  // ---- Personal navigation (1E): favorites, recently viewed, view state, palette records ------
  type PT = { target?: string; view?: string };
  const pt = (request: FastifyRequest) => request.params as PT;
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'private, no-store');

  app.get(
    '/v1/workspaces/:ws/favorites',
    wrap(async (request, reply) => {
      noStore(reply);
      return list(request, await tenancy.listFavorites(caller(request), ws(request)));
    }),
  );
  app.put(
    '/v1/workspaces/:ws/favorites/:target',
    wrap(async (request, reply) => {
      const r = await tenancy.addFavorite(caller(request), ws(request), pt(request).target);
      return reply
        .code(r.created ? 201 : 200)
        .send(nonResourceEnvelope('favorite', { target: r.target }, m(request)));
    }),
  );
  app.delete(
    '/v1/workspaces/:ws/favorites/:target',
    wrap(async (request, reply) => {
      await tenancy.removeFavorite(caller(request), ws(request), pt(request).target);
      return reply.code(204).send();
    }),
  );
  app.post(
    '/v1/workspaces/:ws/favorites/:target',
    wrap(async (request, reply) => {
      const t = split(pt(request).target);
      if (t?.verb !== 'move') return fail(request, reply, 'not_found');
      return list(
        request,
        await tenancy.moveFavorite(caller(request), ws(request), t.id, request.body ?? {}),
      );
    }),
  );

  app.get(
    '/v1/workspaces/:ws/recent',
    wrap(async (request, reply) => {
      noStore(reply);
      const qq = q(request);
      return list(
        request,
        await tenancy.listRecent(caller(request), ws(request), {
          limit: qq.limit,
          type: qq.type,
          brand: qq.brand,
        }),
      );
    }),
  );
  app.post(
    '/v1/workspaces/:ws/recent',
    wrap(async (request, reply) => {
      const b = (request.body ?? {}) as Record<string, unknown>;
      const r = await tenancy.recordVisit(caller(request), ws(request), b.target);
      return reply.code(202).send(nonResourceEnvelope('recent_item', r, m(request)));
    }),
  );
  app.post(
    '/v1/workspaces/:ws/recent::clear',
    wrap(async (request) => {
      const r = await tenancy.clearRecent(caller(request), ws(request));
      return nonResourceEnvelope('recent_item', r, m(request));
    }),
  );
  app.delete(
    '/v1/workspaces/:ws/recent/:target',
    wrap(async (request, reply) => {
      await tenancy.clearRecent(caller(request), ws(request), pt(request).target);
      return reply.code(204).send();
    }),
  );

  const viewStateBody = (
    request: FastifyRequest,
    reply: FastifyReply,
    v: { key: string; schema_version: number; state: object; version: number },
  ) => {
    noStore(reply).header('etag', `"${v.version}"`);
    return nonResourceEnvelope('view_state', { ...v }, m(request));
  };
  app.get(
    '/v1/workspaces/:ws/view-state/:view',
    wrap(async (request, reply) =>
      viewStateBody(
        request,
        reply,
        await tenancy.getViewState(caller(request), ws(request), pt(request).view, device(request)),
      ),
    ),
  );
  app.put(
    '/v1/workspaces/:ws/view-state/:view',
    wrap(async (request, reply) => {
      const raw = header(request, 'if-match');
      let ifMatch: number | undefined;
      if (raw !== undefined) {
        const mm = /^"(\d{1,15})"$/.exec(raw.trim());
        if (!mm) return fail(request, reply, 'precondition_required');
        ifMatch = Number(mm[1]);
      }
      return viewStateBody(
        request,
        reply,
        await tenancy.putViewState(
          caller(request),
          ws(request),
          pt(request).view,
          device(request),
          request.body,
          ifMatch,
        ),
      );
    }),
  );
  app.delete(
    '/v1/workspaces/:ws/view-state/:view',
    wrap(async (request, reply) => {
      await tenancy.deleteViewState(
        caller(request),
        ws(request),
        pt(request).view,
        device(request),
      );
      return reply.code(204).send();
    }),
  );

  app.get(
    '/v1/workspaces/:ws/navigation/targets',
    wrap(async (request, reply) => {
      noStore(reply);
      return list(request, await tenancy.searchTargets(caller(request), ws(request), q(request).q));
    }),
  );
  app.get(
    '/v1/workspaces/:ws/navigation/pins',
    wrap(async (request, reply) => {
      noStore(reply);
      return list(request, await tenancy.listPins(caller(request), ws(request)));
    }),
  );
}
