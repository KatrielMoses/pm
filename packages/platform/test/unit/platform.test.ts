import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  classifyError,
  decideEffect,
  defineEffectDestination,
  destinationFingerprint,
  JobError,
  requestFingerprint,
  retryDelayMs,
} from '@pm/platform';

describe('full-jitter backoff (0D §7.4)', () => {
  const params = { baseMs: 1000, capMs: 30_000 };
  it('stays within [0, min(cap, base * 2^attempt))', () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const ceiling = Math.min(params.capMs, params.baseMs * 2 ** attempt);
      expect(retryDelayMs(attempt, params, undefined, () => 0)).toBe(0);
      expect(retryDelayMs(attempt, params, undefined, () => 0.999999)).toBeLessThan(ceiling);
    }
  });
  it('honors a longer provider Retry-After', () => {
    expect(retryDelayMs(1, params, 60_000, () => 0.5)).toBe(60_000);
    expect(retryDelayMs(5, params, 10, () => 0.5)).toBe(15_000);
  });
  it('classifies registered and unknown errors', () => {
    expect(classifyError(new JobError('policy', 'limit_exceeded'))).toMatchObject({
      errorClass: 'policy',
      code: 'limit_exceeded',
    });
    expect(classifyError(new Error('anything'))).toMatchObject({
      errorClass: 'transient',
      code: 'unhandled',
    });
    expect(() => new JobError('transient', 'Has user text!')).toThrow(/static identifier/);
  });
});

describe('RFC 8785 canonical JSON and request fingerprints', () => {
  it('is independent of key order and whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1.5, y: 1e21 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":1e+21,"z":1.5}}',
    );
    const one = requestFingerprint({
      method: 'post',
      route: '/r',
      pathParams: { a: '1' },
      query: {},
      body: { x: 1, y: 2 },
    });
    const two = requestFingerprint({
      method: 'POST',
      route: '/r',
      pathParams: { a: '1' },
      query: {},
      body: { y: 2, x: 1 },
    });
    expect(one.equals(two)).toBe(true);
    expect(
      one.equals(
        requestFingerprint({
          method: 'POST',
          route: '/r',
          pathParams: { a: '1' },
          query: {},
          body: { y: 3, x: 1 },
        }),
      ),
    ).toBe(false);
  });
});

describe('effect decisions (0D §5.4)', () => {
  it('never re-attempts sent effects and holds unsafe unknown outcomes', () => {
    expect(decideEffect({ state: 'sent', destination_class: 'unsafe' })).toBe('already_sent');
    expect(decideEffect({ state: 'confirmed', destination_class: 'naturally_idempotent' })).toBe(
      'already_sent',
    );
    expect(decideEffect({ state: 'unknown', destination_class: 'unsafe' })).toBe(
      'await_reconciliation',
    );
    expect(decideEffect({ state: 'unknown', destination_class: 'deduplicated_by_receiver' })).toBe(
      'attempt',
    );
    expect(decideEffect({ state: 'failed', destination_class: 'unsafe' })).toBe('attempt');
    expect(decideEffect({ state: 'cancelled', destination_class: 'unsafe' })).toBe('cancelled');
    // P8-W0: a held claim is never a second dispatch, for any class (recovery decides first).
    for (const c of ['unsafe', 'naturally_idempotent'] as const)
      expect(decideEffect({ state: 'dispatching', destination_class: c })).toBe('in_flight');
  });

  it('registers destinations once with their class and contract (P8-W0)', () => {
    const d = defineEffectDestination('unit.mail_send', 'unsafe', 'v2');
    expect(defineEffectDestination('unit.mail_send', 'unsafe', 'v2')).toBe(d);
    expect(() => defineEffectDestination('unit.mail_send', 'naturally_idempotent', 'v2')).toThrow(
      /already registered/,
    );
    expect(() => defineEffectDestination('unit.mail_send', 'unsafe', 'v3')).toThrow(
      /already registered/,
    );
    expect(() => defineEffectDestination('Bad Id', 'unsafe')).toThrow(/destination id/);
    expect(destinationFingerprint(d)).toMatch(/^[0-9a-f]{64}$/);
    expect(destinationFingerprint(d)).not.toBe(
      destinationFingerprint({ ...d, class: 'naturally_idempotent' }),
    );
  });
});
