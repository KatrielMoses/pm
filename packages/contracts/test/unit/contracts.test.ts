import { describe, expect, it } from 'vitest';
import {
  EnvelopeError,
  meta,
  platformSingletonEnvelope,
  successEnvelope,
  errorEnvelope,
  ERROR_CODES,
  isPublicId,
  isUuidV7,
  newPublicId,
  newRequestId,
  newUuidV7,
  parseTraceparent,
  traceIdToUuid,
  uuidToTraceId,
} from '@pm/contracts';
import { contractErrors } from '@pm/test-infra';

describe('identifiers', () => {
  it('generates public IDs matching the 0D pattern with registered prefixes', () => {
    for (let i = 0; i < 200; i++) {
      const id = newPublicId('op');
      expect(id).toMatch(/^op_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(isPublicId(id, 'op')).toBe(true);
    }
    expect(isPublicId('zz_0J8ZK3Q5B8V2N4M6P7R9S0T1HA')).toBe(false);
    expect(newRequestId()).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('generates time-ordered RFC 9562 UUIDv7 keys', () => {
    const a = newUuidV7(1_700_000_000_000);
    const b = newUuidV7(1_700_000_000_001);
    expect(isUuidV7(a)).toBe(true);
    expect(a < b).toBe(true);
  });

  it('round-trips correlation IDs between W3C trace IDs and uuid columns', () => {
    const t = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(uuidToTraceId(traceIdToUuid(t))).toBe(t);
    expect(parseTraceparent(`00-${t}-00f067aa0ba902b7-01`)).toEqual({
      traceId: t,
      spanId: '00f067aa0ba902b7',
      flags: '01',
    });
    expect(parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined();
    expect(parseTraceparent('garbage')).toBeUndefined();
  });
});

describe('error envelopes', () => {
  it('every HTTP error code yields a schema-valid envelope with the registry safe message', () => {
    for (const e of ERROR_CODES.filter((c) => c.httpStatus !== null)) {
      const env = errorEnvelope(e.code, {
        requestId: newRequestId(),
        correlationId: '4bf92f3577b34da6a3ce929d0e0e4736',
      });
      expect(contractErrors('error-envelope', env), e.code).toEqual([]);
      expect(env.error.message).toBe(e.safeMessage);
    }
  });

  it('refuses outcome-only codes as HTTP responses', () => {
    expect(() =>
      errorEnvelope('partial_failure', {
        requestId: newRequestId(),
        correlationId: '4bf92f3577b34da6a3ce929d0e0e4736',
      }),
    ).toThrow(/outcome code/);
  });
});

describe('success envelopes and the platform-singleton specialization (ADR-0007 D6)', () => {
  const m = () => meta(newRequestId(), '4bf92f3577b34da6a3ce929d0e0e4736');

  it('resource envelopes require a registered public ID and validate against the 0D schema', () => {
    const env = successEnvelope({ id: newPublicId('op'), type: 'operation' }, m());
    expect(contractErrors('success-envelope', env)).toEqual([]);
    for (const id of ['', newUuidV7(), 'zz_0J8ZK3Q5B8V2N4M6P7R9S0T1HA', 'op_lowercase']) {
      expect(() => successEnvelope({ id, type: 'operation' }, m())).toThrow(EnvelopeError);
    }
  });

  it('only allow-listed singleton types may omit the id, and they cannot carry one', () => {
    const env = platformSingletonEnvelope('platform_status', { status: 'available' }, m());
    expect(env.data).toEqual({ type: 'platform_status', status: 'available' });
    expect(contractErrors('meta', env.meta)).toEqual([]);
    // The ordinary resource schema still rejects it, so the shape cannot pass as a resource.
    expect(contractErrors('success-envelope', env)).not.toEqual([]);
    expect(() => platformSingletonEnvelope('task' as never, { status: 'x' }, m())).toThrow(
      /not a platform singleton/,
    );
    expect(() =>
      platformSingletonEnvelope('platform_status', { id: newPublicId('op') }, m()),
    ).toThrow(/no id/);
  });
});
