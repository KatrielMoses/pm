import { registerLocalStorage, type LocalStorageRouteDeps } from './storage-routes.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import {
  errorEnvelope,
  meta,
  nonResourceEnvelope,
  newRequestId,
  parseTraceparent,
  type ErrorCode,
  type ErrorIssue,
} from '@pm/contracts';
import type { ServerConfig } from '@pm/config';
import {
  context as otelContext,
  contextFromTraceparent,
  errorFields,
  SpanKind,
  SpanStatusCode,
  trace,
  type ErrorReporter,
  type Logger,
  type Metrics,
  type Span,
  type Tracer,
} from '@pm/observability';
import type { Readiness } from './readiness.ts';
import { registerAuth, type AuthRouteDeps } from './auth/routes.ts';
import { registerShell } from './shell/routes.ts';
import { registerTenancy, type TenancyRouteDeps } from './tenancy/routes.ts';
import { registerWork, type WorkRouteDeps } from './work/routes.ts';

declare module 'fastify' {
  interface FastifyRequest {
    pm: { requestId: string; correlationId: string; span: Span; startedAt: number };
  }
}

export interface AppDeps {
  config: Pick<ServerConfig, 'env' | 'build' | 'http'>;
  logger: Logger;
  metrics: Metrics;
  tracer: Tracer;
  errors: ErrorReporter;
  readiness: () => Promise<Readiness>;
  /** Built browser application to serve same-origin; omitted in API-only tests. */
  webDistDir?: string | undefined;
  /** Public status is cached briefly so the unauthenticated endpoint cannot hammer the database. */
  statusCacheMs?: number;
  /** Identity routes and request authentication (1B). */
  auth?: Omit<AuthRouteDeps, 'logger'> | undefined;
  /** Workspace, brand, settings, and context routes (1C); require `auth`. */
  tenancy?: TenancyRouteDeps | undefined;
  /** Projects and project structures (2A); require `auth`. */
  work?: WorkRouteDeps | undefined;
  /** The dev/test object store's signed URLs (4E); only with `OBJECT_STORAGE=local`. */
  localStorage?: LocalStorageRouteDeps | undefined;
}

const STATUS_CLASS = (status: number) => `${Math.floor(status / 100)}xx`;

/** Builds the web/API process: `/v1` JSON API, health endpoints, and the browser application. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // structured, allow-listed logging only (0D §17.1)
    bodyLimit: deps.config.http.bodyLimitBytes,
    trustProxy: deps.config.http.trustProxy,
    genReqId: () => newRequestId(),
    requestIdHeader: false, // never trust a client-supplied request ID
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
  });

  app.decorateRequest('pm', null as never);
  // JSON only (0D §2.3): any other request media type is unsupported_media_type.
  app.removeContentTypeParser('text/plain');

  app.addHook('onRequest', (request, reply, done) => {
    // Continue a W3C trace from the load balancer when present; the trace ID is the correlation ID.
    const incoming = parseTraceparent(request.headers.traceparent as string | undefined);
    const parent = incoming
      ? contextFromTraceparent(`00-${incoming.traceId}-${incoming.spanId}-${incoming.flags}`)
      : otelContext.active();
    const span = deps.tracer.startSpan(
      'http.server',
      { kind: SpanKind.SERVER, attributes: { 'http.request.method': request.method } },
      parent,
    );
    const correlationId = span.spanContext().traceId;
    request.pm = { requestId: request.id, correlationId, span, startedAt: performance.now() };
    reply.header('x-request-id', request.id);
    reply.header('x-correlation-id', correlationId);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (deps.config.env !== 'local' && deps.config.env !== 'test') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    if (
      request.url.startsWith('/v1') ||
      request.url.startsWith('/healthz') ||
      request.url.startsWith('/readyz')
    ) {
      reply.header('cache-control', 'private, no-store');
    }
    otelContext.with(trace.setSpan(parent, span), done);
  });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const status = reply.statusCode;
    const durationMs = performance.now() - request.pm.startedAt;
    const { span } = request.pm;
    span.setAttribute('http.route', route);
    span.setAttribute('http.response.status_code', status);
    if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.updateName(`${request.method} ${route}`);
    span.end();
    const labels = { route, method: request.method, status_class: STATUS_CLASS(status) };
    deps.metrics.record('http.server.request.duration', durationMs, {
      ...labels,
      principal_class: 'anonymous',
    });
    deps.metrics.count('http.server.requests', 1, labels);
    if (route !== '/healthz') {
      deps.logger.info('http.request', {
        request_id: request.pm.requestId,
        correlation_id: request.pm.correlationId,
        route,
        method: request.method,
        status,
        duration_ms: Math.round(durationMs),
      });
    }
    done();
  });

  const sendError = (
    request: FastifyRequest,
    reply: FastifyReply,
    code: ErrorCode,
    extra: { issues?: ErrorIssue[] } = {},
  ) => {
    const body = errorEnvelope(
      code,
      { requestId: request.pm.requestId, correlationId: request.pm.correlationId },
      extra,
    );
    return reply
      .code(body.error.status)
      .header('cache-control', 'private, no-store')
      .type('application/json; charset=utf-8')
      .send(body);
  };

  // Every failure path returns a registry error envelope: no stack traces, SQL, hosts, or input echoes.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const map: Record<string, ErrorCode> = {
      FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
      FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
      FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'malformed_request',
      FST_ERR_CTP_EMPTY_JSON_BODY: 'malformed_request',
      FST_ERR_CTP_INVALID_JSON_BODY: 'malformed_request',
    };
    let code: ErrorCode | undefined = err.code ? map[err.code] : undefined;
    if (!code && err.validation) code = 'validation_failed';
    if (!code && err.statusCode === 400) code = 'malformed_request';
    if (!code) {
      code = 'internal_error';
      deps.errors.capture(err, {
        request_id: request.pm.requestId,
        correlation_id: request.pm.correlationId,
        route: request.routeOptions.url ?? 'unmatched',
      });
    } else {
      deps.logger.info('http.request_rejected', {
        request_id: request.pm.requestId,
        error_code: code,
        ...errorFields(err),
      });
    }
    return sendError(request, reply, code);
  });

  const webDir =
    deps.webDistDir && existsSync(join(deps.webDistDir, 'index.html'))
      ? deps.webDistDir
      : undefined;

  app.setNotFoundHandler((request, reply) => {
    const isApi =
      request.url.startsWith('/v1') || request.url === '/healthz' || request.url === '/readyz';
    if (!isApi && webDir && (request.method === 'GET' || request.method === 'HEAD')) {
      // Client-side routes resolve to the application shell.
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return sendError(request, reply, 'not_found');
  });

  if (webDir) {
    await app.register(fastifyStatic, {
      root: webDir,
      wildcard: true,
      index: false,
      dotfiles: 'deny',
      setHeaders(res, path) {
        res.header(
          'cache-control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
        res.header(
          'content-security-policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
      },
    });
    app.get('/', (_request, reply) =>
      reply.header('cache-control', 'no-cache').sendFile('index.html'),
    );
  }

  if (deps.auth) registerAuth(app, { ...deps.auth, logger: deps.logger });
  if (deps.auth && deps.tenancy) registerTenancy(app, deps.tenancy);
  if (deps.auth && deps.work) registerWork(app, deps.work);
  if (deps.auth) registerShell(app, { metrics: deps.metrics });
  if (deps.localStorage) registerLocalStorage(app, deps.localStorage);

  // Liveness: the process responds. Nothing else (0D §17.4).
  app.get('/healthz', () => ({ status: 'ok' }));

  // Readiness: dependency checks for the load balancer. Names and states only; reasons are logged.
  app.get('/readyz', async (_request, reply) => {
    const r = await deps.readiness();
    return reply.code(r.ready ? 200 : 503).send({
      status: r.ready ? 'ready' : 'not_ready',
      checks: r.checks,
      build: deps.config.build.id,
    });
  });

  let cached: { at: number; available: boolean } | undefined;
  const statusCacheMs = deps.statusCacheMs ?? 5_000;
  // Public platform status for the browser shell (no check names, no internals).
  app.get('/v1/status', async (request) => {
    if (!cached || performance.now() - cached.at > statusCacheMs) {
      cached = { at: performance.now(), available: (await deps.readiness()).ready };
    }
    // Non-resource response (ADR-0007 D6, ADR-0008 B3): no `data.id`.
    return nonResourceEnvelope(
      'platform_status',
      {
        status: cached.available ? 'available' : 'degraded',
        build: { version: deps.config.build.version, build: deps.config.build.id },
      },
      meta(request.pm.requestId, request.pm.correlationId),
    );
  });

  return app;
}
