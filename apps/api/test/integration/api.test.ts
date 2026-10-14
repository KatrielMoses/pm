import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { latestMigrationVersion } from '@pm/db';
import { LogErrorReporter } from '@pm/observability';
import { contractErrors, createHarness, type Harness } from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { buildApp } from '../../src/app.ts';
import { checkReadiness } from '../../src/readiness.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('web/API process', () => {
  let db: TestDatabase;
  let h: Harness;
  let app: FastifyInstance;
  let expectedVersion = latestMigrationVersion();
  let draining = false;

  beforeAll(async () => {
    db = await createTestDatabase();
    h = createHarness(db);
    app = await buildApp({
      config: {
        env: 'test',
        build: { version: '0.1.0', id: 'abc1234' },
        http: { ...h.config.http, bodyLimitBytes: 1024 },
      },
      logger: h.logger,
      metrics: h.telemetry.metrics,
      tracer: h.telemetry.tracer,
      errors: new LogErrorReporter(h.logger),
      statusCacheMs: 0,
      readiness: () =>
        checkReadiness({
          health: h.health,
          expectedMigrationVersion: expectedVersion,
          config: h.config.readiness,
          logger: h.logger,
          metrics: h.telemetry.metrics,
          isDraining: () => draining,
          emailTransport: 'none',
          mcpEnabled: false,
        }),
    });
    // Test-only routes to exercise body parsing and unexpected failures.
    app.post('/v1/test-echo', async (request) => ({
      data: {
        id: 'op_0J8ZK3Q5B8V2N4M6P7R9S0T1HA',
        type: 'operation',
        received: typeof request.body,
      },
    }));
    app.get('/v1/test-crash', async () => {
      throw new Error(
        'db failed at postgres://app_rw:hunter2@db.internal:5432/pm_test with password=hunter2',
      );
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await h.close();
    await db.drop();
  });

  it('GET /healthz reports liveness only', async () => {
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('GET /readyz is actionable but minimal: not ready without a live dispatcher, ready with one', async () => {
    const before = await app.inject('/readyz');
    expect(before.statusCode).toBe(503);
    expect(before.json()).toEqual({
      status: 'not_ready',
      checks: {
        database: 'ok',
        migrations: 'ok',
        dispatcher: 'fail',
        object_storage: 'not_configured',
        email_delivery: 'not_configured',
        recovery_gate: 'ok',
        tenant_isolation: 'ok',
        mcp_access: 'not_configured',
      },
      build: 'abc1234',
    });
    expect(
      h.sink.lines.some(
        (l) => l.includes('"readiness.check_failed"') && l.includes('no running worker'),
      ),
    ).toBe(true);

    await h.discovery.heartbeat('wrk_00000000000000aa', 'test');
    const after = await app.inject('/readyz');
    expect(after.statusCode).toBe(200);
    expect(after.json().status).toBe('ready');
    const text = after.body;
    for (const leak of [
      db.database,
      '127.0.0.1',
      'localhost',
      'postgres',
      String(new URL(db.app).port),
      'stack',
      '/Users/',
      'app_rw',
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it('reports not ready when the database is behind the artifact or the process is draining', async () => {
    expectedVersion = latestMigrationVersion() + 1;
    expect((await app.inject('/readyz')).json().checks.migrations).toBe('fail');
    expectedVersion = latestMigrationVersion();
    draining = true;
    expect((await app.inject('/readyz')).statusCode).toBe(503);
    draining = false;
  });

  it('GET /v1/status returns build info and availability inside the meta envelope', async () => {
    await h.discovery.heartbeat('wrk_00000000000000aa', 'test');
    const res = await app.inject('/v1/status');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual({
      type: 'platform_status',
      status: 'available',
      build: { version: '0.1.0', build: 'abc1234' },
    });
    expect(contractErrors('meta', body.meta)).toEqual([]);
    expect(body.meta.request_id).toBe(res.headers['x-request-id']);
  });

  it('unknown API routes return the uniform not_found envelope', async () => {
    const a = await app.inject('/v1/workspaces/ws_0J8ZK3Q5B8V2N4M6P7R9S0T1HA/tasks');
    const b = await app.inject({ method: 'DELETE', url: '/v1/nothing-here' });
    for (const res of [a, b]) {
      expect(res.statusCode).toBe(404);
      expect(contractErrors('error-envelope', res.json())).toEqual([]);
      expect(res.headers['cache-control']).toBe('private, no-store');
    }
    const strip = (r: typeof a) => ({ ...r.json().error, request_id: '', correlation_id: '' });
    expect(strip(a)).toEqual(strip(b));
    expect(strip(a)).toEqual({
      code: 'not_found',
      status: 404,
      message: 'The requested resource was not found.',
      retryable: false,
      request_id: '',
      correlation_id: '',
    });
  });

  it('maps body parsing failures to registry codes', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/test-echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken"',
    });
    const media = await app.inject({
      method: 'POST',
      url: '/v1/test-echo',
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    const large = await app.inject({
      method: 'POST',
      url: '/v1/test-echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ x: 'y'.repeat(4096) }),
    });
    expect([malformed.json().error.code, media.json().error.code, large.json().error.code]).toEqual(
      ['malformed_request', 'unsupported_media_type', 'payload_too_large'],
    );
    for (const r of [malformed, media, large])
      expect(contractErrors('error-envelope', r.json())).toEqual([]);
  });

  it('never exposes stack traces, SQL, hosts, or secrets on internal errors', async () => {
    const res = await app.inject('/v1/test-crash');
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({
      code: 'internal_error',
      retryable: true,
      message: expect.any(String),
    });
    expect(contractErrors('error-envelope', res.json())).toEqual([]);
    for (const leak of ['hunter2', 'db.internal', 'postgres://', 'at ', 'Error:'])
      expect(res.body).not.toContain(leak);
    const logs = h.sink.lines.join('\n');
    expect(logs).toContain('"error.captured"');
    expect(logs).not.toContain('hunter2');
    expect(logs).not.toContain('db.internal');
  });

  it('continues an incoming W3C trace and uses its trace ID as the correlation ID', async () => {
    h.telemetry.spans!.reset();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const res = await app.inject({
      url: '/readyz',
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    expect(res.headers['x-correlation-id']).toBe(traceId);
    const spans = h.telemetry.spans!.getFinishedSpans();
    const server = spans.find((s) => s.name === 'GET /readyz');
    expect(server?.spanContext().traceId).toBe(traceId);
    const dbSpans = spans.filter(
      (s) => s.name.startsWith('db.') && s.spanContext().traceId === traceId,
    );
    expect(dbSpans.length).toBeGreaterThan(0);
    for (const s of dbSpans) {
      expect(Object.keys(s.attributes).sort()).toEqual([
        'db.operation.name',
        'db.system.name',
        'pm.db.identity',
      ]);
    }
    const log = h.sink
      .records()
      .find((r) => r.event === 'http.request' && r.correlation_id === traceId);
    expect(log).toMatchObject({ route: '/readyz', method: 'GET', status: 200, trace_id: traceId });
  });

  it('keeps headers, cookies, query strings, and bodies out of logs', async () => {
    h.sink.clear();
    await app.inject({
      method: 'POST',
      url: '/v1/test-echo?email=person%40example.com&token=tok_SECRET123', // gitleaks:allow (synthetic JWT fixture)
      headers: {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
        cookie: 'session=COOKIE_SECRET',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ title: 'Customer launch plan', password: 'pw-SECRET' }),
    });
    const logs = h.sink.lines.join('\n');
    expect(logs).toContain('"route":"/v1/test-echo"');
    for (const leak of [
      'person@example.com',
      'person%40example.com',
      'tok_SECRET123',
      'eyJhbGci',
      'COOKIE_SECRET',
      'Customer launch plan',
      'pw-SECRET',
    ]) {
      expect(logs).not.toContain(leak);
    }
  });

  it('responses never contain internal UUIDv7 keys', async () => {
    for (const url of ['/healthz', '/readyz', '/v1/status', '/v1/missing', '/v1/test-crash']) {
      const res = await app.inject(url);
      expect(res.body, url).not.toMatch(UUID);
    }
  });

  it('records HTTP metrics with bounded labels only', async () => {
    const { resourceMetrics } = await h.telemetry.metricReader!.collect();
    const points = resourceMetrics.scopeMetrics
      .flatMap((s) => s.metrics)
      .filter((m) => m.descriptor.name.startsWith('http.'));
    expect(points.length).toBeGreaterThan(0);
    const routes = new Set<string>();
    for (const m of points) {
      for (const dp of m.dataPoints) {
        expect(
          Object.keys(dp.attributes).every((k) =>
            ['route', 'method', 'status_class', 'principal_class'].includes(k),
          ),
        ).toBe(true);
        routes.add(String(dp.attributes.route));
      }
    }
    expect([...routes].every((r) => !r.includes('ws_') && !UUID.test(r))).toBe(true);
  });
});
