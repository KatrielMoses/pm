import { describe, expect, it } from 'vitest';
import { FORBIDDEN_METRIC_LABELS } from '@pm/contracts';
import {
  ALL_SIGNALS,
  createLogger,
  errorFields,
  initTelemetry,
  MemorySink,
  MetricLabelError,
  redactString,
  redactValue,
} from '@pm/observability';

describe('redaction', () => {
  it.each([
    ['postgres://app_rw:hunter2@db.internal:5432/pm', 'hunter2'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', 'eyJhbGci'],
    ['token=abc123secret&x=1', 'abc123secret'],
    ['api_key: "k-live-123"', 'k-live-123'],
    ['contact person@example.com', 'person@example.com'],
    ['-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----', 'MIIE'], // gitleaks:allow (synthetic)
  ])('scrubs %s', (input, secret) => {
    expect(redactString(input)).not.toContain(secret);
  });

  it('replaces sensitive keys whole in diagnostic objects', () => {
    const out = JSON.stringify(
      redactValue({
        headers: { authorization: 'Basic abc', cookie: 'sid=1', 'x-request-id': 'req_1' },
        database_url: 'postgres://u:p@h/d',
        body: { title: 'Customer plan' },
        params: ['value'],
        filename: 'board-minutes.pdf',
        prompt: 'summarize',
        ok: 'kept',
      }),
    );
    for (const leak of [
      'Basic abc',
      'sid=1',
      'u:p@',
      'Customer plan',
      '"value"',
      'board-minutes',
      'summarize',
    ])
      expect(out).not.toContain(leak);
    expect(out).toContain('kept');
    expect(out).toContain('req_1');
  });
});

describe('structured logger', () => {
  it('emits JSON with static event names and only allow-listed fields', () => {
    const sink = new MemorySink();
    const log = createLogger({ service: 't', sink }).child({ request_id: 'req_1' });
    log.info('http.request', {
      route: '/v1/status',
      status: 200,
      duration_ms: 3,
      ...({
        body: 'secret body',
        sql_params: ['x'],
        email: 'a@b.co',
        url: '/v1/ws/123?token=1',
      } as object),
    });
    const [record] = sink.records();
    expect(record).toMatchObject({
      level: 'info',
      service: 't',
      event: 'http.request',
      msg: 'http.request',
      request_id: 'req_1',
      route: '/v1/status',
      status: 200,
    });
    expect(Object.keys(record!)).not.toEqual(expect.arrayContaining(['body']));
    expect(sink.lines[0]).not.toMatch(/secret body|a@b\.co|token=1/);
    expect(log.droppedFields).toBe(4);
  });

  it('redacts secrets inside allow-listed string fields and rejects dynamic event names', () => {
    const sink = new MemorySink();
    createLogger({ service: 't', sink }).warn('user typed: hello', { reason: 'password=hunter2' });
    expect(sink.records()[0]).toMatchObject({
      event: 'log.invalid_event_name',
      reason: 'password=[REDACTED]',
    });
  });

  it('logs error class and code, never the message', () => {
    const err = Object.assign(new Error('duplicate key value (email)=(a@b.co)'), { code: '23505' });
    const fields = errorFields(err);
    expect(fields).toMatchObject({ error_class: 'Error', error_code: '23505' });
    expect(JSON.stringify(fields)).not.toContain('a@b.co');
  });
});

describe('metrics cardinality (0D §17.3)', () => {
  it('declares no forbidden or identifier labels on any signal', () => {
    for (const s of ALL_SIGNALS) {
      for (const label of s.labels)
        expect(FORBIDDEN_METRIC_LABELS as readonly string[], `${s.name}.${label}`).not.toContain(
          label,
        );
    }
  });

  it('rejects forbidden labels, undeclared labels, and identifier-like values', async () => {
    const t = initTelemetry({
      serviceName: 't',
      serviceVersion: '0',
      environment: 'test',
      traceSampleRatio: 1,
      strictMetrics: true,
      inMemory: true,
    });
    try {
      expect(() => t.metrics.count('job.dead', 1, { queue: 'default', workspace_id: 'x' })).toThrow(
        MetricLabelError,
      );
      expect(() => t.metrics.count('job.dead', 1, { queue: 'default', kind: 'x' })).toThrow(
        /not declared/,
      );
      expect(() =>
        t.metrics.count('job.dead', 1, { queue: '0192f0e4-1a2b-7c3d-8e4f-123456789abc' }),
      ).toThrow(/identifier-like/);
      expect(() =>
        t.metrics.count('http.server.requests', 1, {
          route: '/v1/workspaces/ws_0J8ZK3Q5B8V2N4M6P7R9S0T1HA',
          method: 'GET',
          status_class: '2xx',
        }),
      ).toThrow(/identifier-like/);
      expect(() => t.metrics.count('job.dead', 1, { queue: 'person@example.com' })).toThrow();
      t.metrics.count('job.dead', 1, { queue: 'default' });
      const { resourceMetrics } = await t.metricReader!.collect();
      const names = resourceMetrics.scopeMetrics.flatMap((s) =>
        s.metrics.map((m) => m.descriptor.name),
      );
      expect(names).toContain('job.dead');
    } finally {
      await t.shutdown();
    }
  });

  it('drops and counts violations in non-strict environments instead of exporting them', () => {
    const t = initTelemetry({
      serviceName: 't',
      serviceVersion: '0',
      environment: 'production',
      traceSampleRatio: 1,
      strictMetrics: false,
      inMemory: true,
    });
    t.metrics.count('job.dead', 1, { queue: 'default', workspace_id: 'x' });
    expect(t.metrics.rejectedSamples).toBe(1);
    void t.shutdown();
  });
});
