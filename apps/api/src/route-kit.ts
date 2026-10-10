import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorEnvelope, meta, successEnvelope, type ErrorCode } from '@pm/contracts';
import { currentTraceparent } from '@pm/observability';
import { requestFingerprint } from '@pm/platform';
import { IdentityError } from '@pm/identity';
import { deviceKeyHash, TenancyError, type Caller, type Mutation } from '@pm/tenancy';

/**
 * The tenant HTTP edge shared by the tenancy (1C–1E) and work (2A) route modules: the caller is
 * always the session, the workspace always the path; unsafe requests carry Idempotency-Key,
 * If-Match, and Step-Up headers; failures map to registry envelopes; versioned resources carry an
 * ETag. One implementation, so every module behaves identically at the boundary.
 */
export function routeKit() {
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
      ...(request.delegation ? { delegation: request.delegation } : {}),
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

  /** The hashed per-device key (`X-Device-Key`), or null when absent or malformed. */
  const device = (request: FastifyRequest) => deviceKeyHash(header(request, 'x-device-key'));

  return { m, fail, caller, header, mutation, wrap, resource, split, device };
}
