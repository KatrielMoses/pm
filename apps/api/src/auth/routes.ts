import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  errorEnvelope,
  meta,
  nonResourceEnvelope,
  successEnvelope,
  type ErrorCode,
} from '@pm/contracts';
import { currentTraceparent, type Logger } from '@pm/observability';
import { requestFingerprint } from '@pm/platform';
import { LOCAL_STORAGE_ROUTE_PREFIX } from '@pm/work';
import {
  IdentityError,
  InvalidCursorError,
  safeEqual,
  type AuthContext,
  type IdentityService,
  type IssuedSession,
  type LocalOAuthProvider,
  type ProtectedRequest,
  type ReplayResult,
  type RequestMeta,
} from '@pm/identity';
import { cookieNames, parseCookies, serializeCookie } from './cookies.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | undefined;
    /** Present when the request authenticated with an API token. */
    delegation?: import('@pm/tenancy').TokenDelegation;
  }
}

export interface AuthRouteDeps {
  identity: IdentityService;
  logger: Logger;
  /** Resolves a `pm_` bearer token. Absent in processes that do not serve the public API. */
  resolveBearer?: (secret: string) => Promise<{
    auth: AuthContext;
    delegation: import('@pm/tenancy').TokenDelegation;
    workspacePublicId?: string;
  } | null>;
  /** Per-token rate limit. A refusal carries retry-after seconds. */
  limitBearer?: (
    tokenId: string,
    write: boolean,
  ) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  limitMcp?: (
    tokenId: string,
    write: boolean,
  ) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  /** Present only when the local/test OAuth provider is configured (never in deployed envs). */
  localOAuth?: LocalOAuthProvider | undefined;
  /** Local/test-only component harness flag (configuration refuses it when deployed). */
  componentHarness?: boolean;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ISO = (d: Date) => d.toISOString();

/**
 * Identity routes and request authentication (1B). Authentication establishes who the person is;
 * it grants no workspace authority, so nothing here reads or infers memberships.
 */
export function registerAuth(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { identity } = deps;
  const cfg = identity.config;
  const names = cookieNames(cfg.cookieSecure);
  const allowed = new Set(cfg.allowedOrigins);

  const sessionCookie = (token: string) =>
    serializeCookie(names.session, token, {
      path: '/v1',
      secure: cfg.cookieSecure,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: Math.floor(cfg.sessionAbsoluteMs / 1000),
    });
  const clearSession = () =>
    serializeCookie(names.session, '', {
      path: '/v1',
      secure: cfg.cookieSecure,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 0,
    });
  const continuationCookie = (token: string) =>
    serializeCookie(names.continuation, token, {
      path: '/v1/auth',
      secure: cfg.cookieSecure,
      httpOnly: true,
      sameSite: 'Strict',
      maxAge: Math.floor(cfg.signInContinuationMs / 1000),
    });
  const clearContinuation = () =>
    serializeCookie(names.continuation, '', {
      path: '/v1/auth',
      secure: cfg.cookieSecure,
      httpOnly: true,
      sameSite: 'Strict',
      maxAge: 0,
    });

  const metaOf = (request: FastifyRequest): RequestMeta => ({
    ip: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
    requestId: request.pm.requestId,
    correlationId: request.pm.correlationId,
    traceparent: currentTraceparent(),
  });

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

  const sendIdentityError = (request: FastifyRequest, reply: FastifyReply, err: IdentityError) => {
    if (err.code === 'unauthenticated') reply.header('set-cookie', [clearSession()]);
    return fail(request, reply, err.code, {
      ...(err.issues.length ? { issues: err.issues } : {}),
      ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
      ...(err.challenge ? { stepUp: err.challenge as unknown as Record<string, unknown> } : {}),
    });
  };

  const m = (request: FastifyRequest) => meta(request.pm.requestId, request.pm.correlationId);
  const ack = (request: FastifyRequest, status: string) =>
    nonResourceEnvelope('acknowledgement', { status }, m(request));

  const requireAuth = (request: FastifyRequest): AuthContext => {
    if (!request.auth) throw new IdentityError('unauthenticated');
    return request.auth;
  };

  const protectedRequest = (request: FastifyRequest): ProtectedRequest => {
    const key = request.headers['idempotency-key'];
    const stepUp = request.headers['step-up'];
    return {
      idempotencyKey: typeof key === 'string' ? key : '',
      fingerprint: requestFingerprint({
        method: request.method,
        route: request.routeOptions.url ?? '',
        pathParams: (request.params ?? {}) as Record<string, string>,
        query: (request.query ?? {}) as Record<string, string>,
        body: request.body ?? null,
      }),
      stepUpToken: typeof stepUp === 'string' ? stepUp : undefined,
    };
  };

  const isReplay = (v: unknown): v is ReplayResult =>
    typeof v === 'object' && v !== null && 'replayed' in v;

  const replay = (request: FastifyRequest, reply: FastifyReply, r: ReplayResult) =>
    reply
      .code(r.status)
      .header('idempotent-replayed', 'true')
      .send(nonResourceEnvelope('acknowledgement', { status: 'already_completed' }, m(request)));

  const setSession = (reply: FastifyReply, issued: IssuedSession) =>
    reply.header('set-cookie', [sessionCookie(issued.token), clearContinuation()]);

  const sessionResource = (ctx: AuthContext) => ({
    id: ctx.account.publicId,
    type: 'account',
    email: ctx.account.email,
    display_name: ctx.account.displayName,
    locale: ctx.account.locale,
    timezone: ctx.account.timezone,
    email_verified: ctx.account.emailVerified,
    session: {
      id: ctx.session.publicId,
      assurance: ctx.session.assurance,
      auth_methods: ctx.session.authMethods,
      created_at: ISO(ctx.session.createdAt),
      idle_expires_at: ISO(ctx.session.idleExpiresAt),
      absolute_expires_at: ISO(ctx.session.absoluteExpiresAt),
    },
  });

  // ---- Request pipeline: origin/CSRF checks and session resolution ---------------------------
  app.decorateRequest('auth', undefined);

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    // 4E dev/test object store: the URL signature is the whole authorization (as for a provider's
    // presigned URL). It reads no session, so an ambient cookie must not demand a CSRF token.
    if (request.url.startsWith(LOCAL_STORAGE_ROUTE_PREFIX)) return;
    const authorization = request.headers.authorization;
    if (request.url.includes('/mcp')) {
      const originHeader = request.headers.origin;
      if (typeof originHeader === 'string' && !allowed.has(originHeader))
        return fail(request, reply, 'forbidden');
    }
    if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
      if (request.url.startsWith('/v1/hooks/')) return;
      const cookies = parseCookies(request.headers.cookie);
      if (cookies.get(names.session) !== undefined) return fail(request, reply, 'forbidden');
      const secret = authorization.slice(authorization.indexOf(' ') + 1).trim();
      const resolved = await deps.resolveBearer?.(secret);
      if (!resolved) return fail(request, reply, 'unauthenticated');
      const path = request.url.split('?')[0] ?? '';
      if (resolved.workspacePublicId) {
        const workspacePath = /^\/v1\/workspaces\/([^/]+)\//.exec(path)?.[1];
        if (workspacePath !== resolved.workspacePublicId)
          return fail(request, reply, 'unauthenticated');
      }
      if (
        path.includes('/api-tokens') ||
        path.includes('/webhook-subscriptions') ||
        path.includes('/inbound-endpoints') ||
        path.includes('/oauth-clients') ||
        path.startsWith('/v1/auth') ||
        path.startsWith('/v1/account')
      ) {
        return fail(request, reply, 'forbidden');
      }
      const write = !['GET', 'HEAD'].includes(request.method);
      const mcpPath = path.includes('/mcp');
      if (path.includes('/export')) {
        const exportLimit = await deps.limitBearer?.(resolved.delegation.tokenId, true);
        if (exportLimit && !exportLimit.allowed)
          return fail(request, reply, 'rate_limited', {
            retryAfterSeconds: exportLimit.retryAfterSeconds,
          });
      }
      // MCP routes classify JSON-RPC operations after parsing; rate-limit exactly once there.
      const limited = mcpPath
        ? undefined
        : await deps.limitBearer?.(resolved.delegation.tokenId, write);
      if (limited && !limited.allowed)
        return fail(request, reply, 'rate_limited', {
          retryAfterSeconds: limited.retryAfterSeconds,
        });
      const held = resolved.delegation.scopes;
      // 7A: AI configuration, keys, limits, brand profiles changes, and cost reconciliation are
      // session-only (step-up); runs and one's own history need `ai:execute`, usage `usage:read`.
      // 7D: change proposals (generation, review, approval, Apply) are session-only.
      // 7E: briefings, schedules, and correction notes are session-only.
      // 7F: daily plans (preview and plan proposals) and voice capture are session-only.
      // P8-W0: external effect listing and reconciliation are session-only (step-up).
      const aiPath = /^\/v1\/workspaces\/[^/]+\/ai(\/|$)/.test(path);
      // 8B: agent profiles, templates, tools, and connectors are session-only (configuration and
      // grant authority never come from a token); task assignments need `agents:execute`.
      if (/^\/v1\/workspaces\/[^/]+\/agent(s|-templates|-tools)(\/|$)/.test(path))
        return fail(request, reply, 'forbidden');
      if (/^\/v1\/workspaces\/[^/]+\/tasks\/[^/]+\/agent/.test(path) && write) {
        if (!held.includes('agents:execute')) return fail(request, reply, 'forbidden');
        request.auth = resolved.auth;
        request.delegation = resolved.delegation;
        return;
      }
      if (
        /^\/v1\/workspaces\/[^/]+\/operations\//.test(path) ||
        path.includes('/planning/day-plan') ||
        path.includes('/capture/voice') ||
        path.includes('/capture/interpretations')
      )
        return fail(request, reply, 'forbidden');
      if (
        (aiPath &&
          (path.includes('/ai/settings') ||
            path.includes('/ai/limits') ||
            path.includes('/ai/proposal') ||
            path.includes('/ai/briefing') ||
            path.includes('/attempts/'))) ||
        (path.includes('/ai-profile') && write)
      )
        return fail(request, reply, 'forbidden');
      if (aiPath) {
        const aiNeed = path.endsWith('/ai/usage') ? 'usage:read' : 'ai:execute';
        if (!held.includes(aiNeed)) return fail(request, reply, 'forbidden');
        request.auth = resolved.auth;
        request.delegation = resolved.delegation;
        return;
      }
      if (!mcpPath) {
        const need = path.includes('/capture')
          ? write
            ? 'capture:write'
            : 'records:read'
          : path.includes('/export')
            ? 'exports:create'
            : write
              ? 'records:write'
              : 'records:read';
        const ok =
          held.includes(need) ||
          (need === 'records:read' &&
            (held.includes('records:write') || held.includes('views:read'))) ||
          (need === 'capture:write' && held.includes('records:write'));
        if (!ok) return fail(request, reply, 'forbidden');
      } else if (!held.length) {
        return fail(request, reply, 'forbidden');
      }
      request.auth = resolved.auth;
      request.delegation = resolved.delegation;
      return;
    }
    const cookies = parseCookies(request.headers.cookie);
    const raw = cookies.get(names.session);
    const origin = request.headers.origin;
    if (UNSAFE.has(request.method)) {
      // Origin check (all unsafe requests): browsers always send Origin on these; a cross-site
      // origin is refused, and an ambient session cookie without an Origin is refused too.
      if (typeof origin === 'string' ? !allowed.has(origin) : raw !== undefined) {
        deps.logger.warn('auth.csrf_rejected', {
          reason: 'origin',
          route: request.routeOptions.url ?? 'unmatched',
        });
        return fail(request, reply, 'forbidden', {
          issues: [
            {
              code: 'csrf_origin',
              message: 'This request was blocked for your safety. Reload the page and try again.',
            },
          ],
        });
      }
    }
    if (raw === undefined) return;
    const resolved = await identity.resolveSession(raw);
    if (resolved.status !== 'ok') {
      // Revoked or expired: clear the cookie; protected routes answer `unauthenticated`.
      reply.header('set-cookie', [clearSession()]);
      return;
    }
    request.auth = resolved.ctx;
    if (UNSAFE.has(request.method)) {
      const presented = request.headers['x-csrf-token'];
      const expected = Buffer.from(identity.csrfToken(resolved.ctx.session.id));
      if (typeof presented !== 'string' || !safeEqual(Buffer.from(presented), expected)) {
        deps.logger.warn('auth.csrf_rejected', {
          reason: 'token',
          route: request.routeOptions.url ?? 'unmatched',
        });
        return fail(request, reply, 'forbidden', {
          issues: [
            {
              code: 'csrf_token',
              message: 'This request was blocked for your safety. Reload the page and try again.',
            },
          ],
        });
      }
    }
  });

  // Identity failures become registry envelopes; everything else stays with the app handler.
  const wrap =
    <T>(fn: (request: FastifyRequest, reply: FastifyReply) => Promise<T>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(request, reply);
      } catch (err) {
        if (err instanceof IdentityError) return sendIdentityError(request, reply, err);
        throw err;
      }
    };

  /**
   * 0D action URLs put the verb after the ID in one segment (`…/{id}:{verb}`). The router cannot
   * express a parameter followed by a literal colon, so the segment is split here; any other verb
   * is `not_found`, exactly like an unknown route.
   */
  const target = (request: FastifyRequest, verb: string): string | undefined => {
    const raw = (request.params as { target?: string }).target ?? '';
    const i = raw.lastIndexOf(':');
    return i > 0 && raw.slice(i + 1) === verb ? raw.slice(0, i) : undefined;
  };
  const actions = (
    path: string,
    handlers: Record<
      string,
      (request: FastifyRequest, reply: FastifyReply, id: string) => Promise<unknown>
    >,
  ) => {
    app.post(
      path,
      wrap(async (request, reply) => {
        for (const [verb, handler] of Object.entries(handlers)) {
          const id = target(request, verb);
          if (id !== undefined) return handler(request, reply, id);
        }
        return fail(request, reply, 'not_found');
      }),
    );
  };

  const body = (request: FastifyRequest): Record<string, unknown> =>
    request.body && typeof request.body === 'object'
      ? (request.body as Record<string, unknown>)
      : {};

  // ---- Registration and email verification ----------------------------------------------------
  app.get('/v1/auth/config', async (request) =>
    nonResourceEnvelope(
      'acknowledgement',
      {
        status: 'ok',
        terms_version: cfg.legal.termsVersion,
        privacy_version: cfg.legal.privacyVersion,
        bot_protection: cfg.botProtection,
        oauth_providers: identity.oauthProviders().map((p) => ({ id: p.id, name: p.displayName })),
        password_min_length: 12,
        component_harness: deps.componentHarness === true,
      },
      m(request),
    ),
  );

  app.post(
    '/v1/auth/register',
    wrap(async (request, reply) => {
      const b = body(request);
      await identity.register(
        {
          email: b.email,
          password: b.password,
          displayName: b.display_name,
          locale: b.locale,
          timezone: b.timezone,
          termsVersion: b.terms_version,
          privacyVersion: b.privacy_version,
          botProof: b.bot_proof,
        },
        metaOf(request),
      );
      return reply.code(202).send(ack(request, 'check_email'));
    }),
  );

  app.post(
    '/v1/auth/email::verify',
    wrap(async (request) => {
      await identity.verifyEmail(body(request).token, metaOf(request));
      return ack(request, 'verified');
    }),
  );

  app.post(
    '/v1/auth/email::resend',
    wrap(async (request, reply) => {
      await identity.resendVerification(body(request).email, metaOf(request));
      return reply.code(202).send(ack(request, 'check_email'));
    }),
  );

  // ---- Sign-in, MFA continuation, sign-out ---------------------------------------------------
  app.post(
    '/v1/auth/sign-in',
    wrap(async (request, reply) => {
      const b = body(request);
      const presented = parseCookies(request.headers.cookie).get(names.session);
      const r = await identity.signIn(
        { email: b.email, password: b.password },
        metaOf(request),
        presented,
      );
      if (r.kind === 'mfa_required') {
        reply.header('set-cookie', [continuationCookie(r.continuation)]);
        return nonResourceEnvelope(
          'sign_in_result',
          { state: 'mfa_required', methods: r.methods },
          m(request),
        );
      }
      setSession(reply, r.issued);
      reply.header('x-csrf-token', identity.csrfToken(r.issued.session.id));
      return nonResourceEnvelope('sign_in_result', { state: 'signed_in' }, m(request));
    }),
  );

  app.post(
    '/v1/auth/sign-in::mfa',
    wrap(async (request, reply) => {
      const cookies = parseCookies(request.headers.cookie);
      const b = body(request);
      const issued = await identity.completeSignIn(
        { continuation: cookies.get(names.continuation), method: b.method, code: b.code },
        metaOf(request),
        cookies.get(names.session),
      );
      setSession(reply, issued);
      reply.header('x-csrf-token', identity.csrfToken(issued.session.id));
      return nonResourceEnvelope('sign_in_result', { state: 'signed_in' }, m(request));
    }),
  );

  app.post(
    '/v1/auth/sign-out',
    wrap(async (request, reply) => {
      if (request.auth) await identity.signOut(request.auth, metaOf(request));
      return reply.code(204).header('set-cookie', [clearSession(), clearContinuation()]).send();
    }),
  );

  app.get(
    '/v1/auth/me',
    wrap(async (request, reply) => {
      const ctx = requireAuth(request);
      const me = await identity.me(ctx);
      reply.header('x-csrf-token', identity.csrfToken(ctx.session.id));
      return successEnvelope(
        {
          ...sessionResource(ctx),
          mfa: { totp: me.mfa.totp, recovery_codes_remaining: me.mfa.recoveryCodesRemaining },
        },
        m(request),
      );
    }),
  );

  // ---- Personal preferences (1E) --------------------------------------------------------------
  const preferencesBody = (request: FastifyRequest, v: { preferences: object; version: number }) =>
    nonResourceEnvelope('preferences', { ...v.preferences, version: v.version }, m(request));
  app.get(
    '/v1/auth/preferences',
    wrap(async (request, reply) => {
      const ctx = requireAuth(request);
      const v = await identity.getPreferences(ctx);
      reply.header('etag', `"${v.version}"`).header('cache-control', 'no-store');
      return preferencesBody(request, v);
    }),
  );
  app.patch(
    '/v1/auth/preferences',
    wrap(async (request, reply) => {
      const ctx = requireAuth(request);
      const raw = request.headers['if-match'];
      let ifMatch: number | undefined;
      if (typeof raw === 'string') {
        const mm = /^"(\d{1,15})"$/.exec(raw.trim());
        if (!mm) throw new IdentityError('precondition_required');
        ifMatch = Number(mm[1]);
      }
      const v = await identity.updatePreferences(ctx, request.body, ifMatch);
      reply.header('etag', `"${v.version}"`).header('cache-control', 'no-store');
      return preferencesBody(request, v);
    }),
  );

  // ---- Sessions ---------------------------------------------------------------------------
  app.get(
    '/v1/auth/sessions',
    wrap(async (request) => {
      const ctx = requireAuth(request);
      const rows = await identity.listSessions(ctx);
      return {
        data: rows.map((s) => ({
          id: s.publicId,
          type: 'session',
          device: s.deviceLabel ?? 'Unknown device',
          created_at: ISO(s.createdAt),
          last_seen_at: ISO(s.lastSeenAt),
          current: s.current,
          state: s.state,
        })),
        page: { limit: 50, has_more: false },
        meta: m(request),
      };
    }),
  );

  // Own-account security activity (1F): this account's account-level events only, display-safe.
  app.get(
    '/v1/auth/security-activity',
    wrap(async (request, reply) => {
      const ctx = requireAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const limit = q.limit === undefined ? 25 : Number(q.limit);
      const cursor = typeof q.cursor === 'string' ? q.cursor : undefined;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (q.cursor !== undefined && !cursor)
      )
        return fail(request, reply, 'validation_failed', {
          issues: [
            { pointer: '/query', code: 'invalid_page', message: 'Check the page parameters.' },
          ],
        });
      try {
        const page = await identity.listSecurityActivity(ctx, { limit, cursor });
        return nonResourceEnvelope(
          'security_activity',
          {
            items: page.items.map((e) => ({
              occurred_at: e.occurredAt,
              category: e.category,
              action: e.action,
              outcome: e.outcome,
              this_session: e.thisSession,
              device: e.device,
              network: e.network,
              client: e.client,
            })),
            next_cursor: page.nextCursor,
          },
          m(request),
        );
      } catch (err) {
        if (err instanceof InvalidCursorError)
          return fail(request, reply, 'validation_failed', {
            issues: [
              {
                pointer: '/query/cursor',
                code: 'invalid_cursor',
                message: 'Start again from the first page.',
              },
            ],
          });
        throw err;
      }
    }),
  );

  actions('/v1/auth/sessions/:target', {
    revoke: async (request, _reply, id) => {
      const ctx = requireAuth(request);
      await identity.revokeSession(ctx, id, metaOf(request));
      return ack(request, 'revoked');
    },
  });

  app.post(
    '/v1/auth/sessions::revoke-others',
    wrap(async (request) => {
      const ctx = requireAuth(request);
      await identity.revokeOtherSessions(ctx, metaOf(request));
      return ack(request, 'revoked');
    }),
  );

  app.post(
    '/v1/auth/sessions::revoke-all',
    wrap(async (request, reply) => {
      const ctx = requireAuth(request);
      await identity.revokeOtherSessions(ctx, metaOf(request), true);
      reply.header('set-cookie', [clearSession()]);
      return ack(request, 'signed_out_everywhere');
    }),
  );

  // ---- Password recovery and change -----------------------------------------------------------
  app.post(
    '/v1/auth/password::forgot',
    wrap(async (request, reply) => {
      await identity.requestPasswordReset(body(request).email, metaOf(request));
      return reply.code(202).send(ack(request, 'check_email'));
    }),
  );

  app.post(
    '/v1/auth/password::reset',
    wrap(async (request, reply) => {
      const b = body(request);
      await identity.resetPassword({ token: b.token, password: b.password }, metaOf(request));
      reply.header('set-cookie', [clearSession(), clearContinuation()]);
      return ack(request, 'password_reset');
    }),
  );

  app.post(
    '/v1/auth/password::change',
    wrap(async (request, reply) => {
      const ctx = requireAuth(request);
      const b = body(request);
      const issued = await identity.changePassword(
        ctx,
        { currentPassword: b.current_password, newPassword: b.new_password },
        metaOf(request),
      );
      setSession(reply, issued);
      reply.header('x-csrf-token', identity.csrfToken(issued.session.id));
      return ack(request, 'password_changed');
    }),
  );

  // ---- MFA --------------------------------------------------------------------------------------
  app.get(
    '/v1/auth/mfa',
    wrap(async (request) => {
      const ctx = requireAuth(request);
      const s = await identity.mfaStatus(ctx);
      return successEnvelope(
        {
          id: ctx.account.publicId,
          type: 'mfa_status',
          totp: s.totp
            ? {
                id: s.totp.publicId,
                state: s.totp.state,
                verified_at: s.totp.verifiedAt ? ISO(s.totp.verifiedAt) : null,
              }
            : null,
          recovery_codes_remaining: s.recoveryCodesRemaining,
        },
        m(request),
      );
    }),
  );

  app.post(
    '/v1/auth/mfa/totp::enroll',
    wrap(async (request, reply) => {
      const ctx = requireAuth(request);
      const r = await identity.beginTotpEnrollment(ctx, protectedRequest(request), metaOf(request));
      if (isReplay(r)) return replay(request, reply, r);
      return reply.code(201).send(
        successEnvelope(
          {
            id: r.factorPublicId,
            type: 'mfa_factor',
            state: 'pending',
            secret: r.secret,
            otpauth_uri: r.otpauthUri,
          },
          m(request),
        ),
      );
    }),
  );

  app.post(
    '/v1/auth/mfa/totp::confirm',
    wrap(async (request, reply) => {
      const ctx = requireAuth(request);
      const b = body(request);
      const r = await identity.confirmTotpEnrollment(
        ctx,
        { factor: b.factor, code: b.code },
        protectedRequest(request),
        metaOf(request),
      );
      if (isReplay(r)) return replay(request, reply, r);
      setSession(reply, r.issued);
      reply.header('x-csrf-token', identity.csrfToken(r.issued.session.id));
      return nonResourceEnvelope('recovery_code_set', { codes: r.recoveryCodes }, m(request));
    }),
  );

  app.post(
    '/v1/auth/mfa/totp::disable',
    wrap(async (request, reply) => {
      const r = await identity.disableTotp(
        requireAuth(request),
        protectedRequest(request),
        metaOf(request),
      );
      if (isReplay(r)) return replay(request, reply, r);
      return ack(request, 'mfa_disabled');
    }),
  );

  app.post(
    '/v1/auth/mfa/recovery-codes::regenerate',
    wrap(async (request, reply) => {
      const r = await identity.regenerateRecoveryCodes(
        requireAuth(request),
        protectedRequest(request),
        metaOf(request),
      );
      if (isReplay(r)) return replay(request, reply, r);
      return nonResourceEnvelope('recovery_code_set', { codes: r.recoveryCodes }, m(request));
    }),
  );

  // ---- Step-up (0D §11.2) --------------------------------------------------------------------
  actions('/v1/auth/step-up/:target', {
    verify: async (request, _reply, id) => {
      const ctx = requireAuth(request);
      const b = body(request);
      const r = await identity.verifyStepUp(
        ctx,
        id,
        { method: b.method, proof: b.proof },
        metaOf(request),
      );
      return nonResourceEnvelope(
        'step_up_token',
        { token: r.token, expires_at: ISO(r.expiresAt), challenge: r.challenge },
        m(request),
      );
    },
    cancel: async (request, _reply, id) => {
      const ctx = requireAuth(request);
      const ch = await identity.cancelStepUp(ctx, id, metaOf(request));
      return successEnvelope({ ...ch }, m(request));
    },
  });

  // ---- OAuth (provider-neutral; local/test provider only) -------------------------------------
  actions('/v1/auth/oauth/:target', {
    start: async (request, _reply, provider) => {
      const b = body(request);
      const intent = b.intent === 'link' ? 'link' : 'sign_in';
      const url = await identity.startOAuth(
        provider,
        intent,
        request.auth,
        b.return_to,
        metaOf(request),
      );
      return nonResourceEnvelope('oauth_authorization', { url }, m(request));
    },
  });

  app.get(
    '/v1/auth/oauth/:provider/callback',
    wrap(async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const presented = parseCookies(request.headers.cookie).get(names.session);
      const r = await identity.completeOAuth(
        (request.params as { provider: string }).provider,
        { state: q.state, code: q.code, error: q.error },
        metaOf(request),
        request.auth,
        presented,
      );
      reply.header('cache-control', 'private, no-store').header('referrer-policy', 'no-referrer');
      switch (r.kind) {
        case 'session':
          return reply
            .header('set-cookie', [sessionCookie(r.issued.token), clearContinuation()])
            .redirect(r.returnPath, 303);
        case 'mfa_required':
          return reply
            .header('set-cookie', [continuationCookie(r.continuation)])
            .redirect('/sign-in/verify', 303);
        case 'linked':
          return reply.redirect(
            `${r.returnPath}${r.returnPath.includes('?') ? '&' : '?'}linked=1`,
            303,
          );
        case 'error':
          return reply.redirect(
            `${request.auth ? '/account/security' : '/sign-in'}?oauth_error=${r.reason}`,
            303,
          );
      }
    }),
  );

  app.get(
    '/v1/auth/oauth/identities',
    wrap(async (request) => {
      const ctx = requireAuth(request);
      const rows = await identity.listOAuthIdentities(ctx);
      return {
        data: rows.map((r) => ({
          id: r.publicId,
          type: 'oauth_identity',
          provider: r.provider,
          provider_email: r.providerEmail,
          linked_at: ISO(r.linkedAt),
        })),
        page: { limit: 50, has_more: false },
        meta: m(request),
      };
    }),
  );

  actions('/v1/auth/oauth/identities/:target', {
    unlink: async (request, _reply, id) => {
      const ctx = requireAuth(request);
      await identity.unlinkOAuthIdentity(ctx, id, metaOf(request));
      return ack(request, 'unlinked');
    },
  });

  // ---- Local/test OAuth provider consent page (development only) ------------------------------
  const local = deps.localOAuth;
  if (local) {
    app.get('/v1/dev/oauth/local/authorize', async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, string | undefined>;
      const redirectUri = q.redirect_uri ?? '';
      const expectedRedirect = `${cfg.publicOrigin}/v1/auth/oauth/local/callback`;
      if (
        redirectUri !== expectedRedirect ||
        !q.state ||
        !q.nonce ||
        !q.code_challenge ||
        q.code_challenge_method !== 'S256'
      ) {
        return fail(request, reply, 'validation_failed', {
          issues: [{ code: 'invalid_request', message: 'Invalid authorization request.' }],
        });
      }
      if (q.decision === 'deny')
        return reply.redirect(
          `${redirectUri}?error=access_denied&state=${encodeURIComponent(q.state)}`,
          303,
        );
      if (q.decision === 'approve' && q.login_hint) {
        const code = local.approve({
          loginHint: q.login_hint,
          nonce: q.nonce,
          codeChallenge: q.code_challenge,
          redirectUri,
        });
        return reply.redirect(
          `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(q.state)}`,
          303,
        );
      }
      const hidden = [
        'response_type',
        'client_id',
        'state',
        'nonce',
        'code_challenge',
        'code_challenge_method',
        'redirect_uri',
        'scope',
      ]
        .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(q[k] ?? '')}">`)
        .join('');
      return reply
        .type('text/html; charset=utf-8')
        .header(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        )
        .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local test sign-in</title></head>
<body style="font-family:system-ui;max-width:28rem;margin:3rem auto">
<main><h1>Local test identity provider</h1><p>Development only. Choose a test user name.</p>
<form method="get">${hidden}
<label for="login_hint">Test user name</label><br><input id="login_hint" name="login_hint" value="alice" pattern="[a-z0-9][a-z0-9_-]{0,31}" required>
<p><button name="decision" value="approve">Approve</button> <button name="decision" value="deny" formnovalidate>Deny</button></p>
</form></main></body></html>`);
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
