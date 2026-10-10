import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EnvelopeError,
  meta,
  nonResourceEnvelope,
  successEnvelope,
  errorEnvelope,
  ERROR_CODES,
  ID_PREFIXES,
  NON_RESOURCE_TYPES,
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

const GENERATOR = resolve(import.meta.dirname, '../../scripts/generate.mjs');

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

describe('identity public-ID prefixes (0D registry, PL-17)', () => {
  const identity = [
    ['ses', 'session', 'identity.session'],
    ['mfa', 'mfa_factor', 'identity.mfa_factor'],
    ['oid', 'oauth_identity', 'identity.oauth_identity'],
  ] as const;

  it('are registered once, owned by identity, and mapped to their 0B entities', () => {
    for (const [prefix, resource, entity] of identity) {
      const rows = ID_PREFIXES.filter((p) => p.prefix === prefix);
      expect(rows).toEqual([
        { prefix, resource, entity, ownerModule: 'identity', platformOnly: false },
      ]);
    }
  });

  it('keep the registry free of collisions and malformed prefixes', () => {
    const prefixes = ID_PREFIXES.map((p) => p.prefix);
    const resources = ID_PREFIXES.map((p) => p.resource);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(new Set(resources).size).toBe(resources.length);
    for (const p of prefixes) expect(p).toMatch(/^[a-z]{2,5}$/);
  });

  it('use the single registry validation path', () => {
    for (const [prefix] of identity) {
      const id = newPublicId(prefix);
      expect(id).toMatch(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
      expect(isPublicId(id)).toBe(true);
      expect(isPublicId(id, prefix)).toBe(true);
      expect(isPublicId(id, 'acct')).toBe(false);
    }
    // An unregistered prefix is never a public ID, whatever its shape.
    expect(isPublicId('zzz_0J8ZK3Q5B8V2N4M6P7R9S0T1HA')).toBe(false);
  });

  it('match the generated file exactly (no drift from the 0D/0C sources)', () => {
    const r = spawnSync(process.execPath, [GENERATOR, '--check'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
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

describe('success envelopes and closed non-resource responses (ADR-0007 D6, ADR-0008 B3)', () => {
  const m = () => meta(newRequestId(), '4bf92f3577b34da6a3ce929d0e0e4736');

  it('resource envelopes require a registered public ID and validate against the 0D schema', () => {
    const env = successEnvelope({ id: newPublicId('op'), type: 'operation' }, m());
    expect(contractErrors('success-envelope', env)).toEqual([]);
    for (const id of ['', newUuidV7(), 'zz_0J8ZK3Q5B8V2N4M6P7R9S0T1HA', 'op_lowercase']) {
      expect(() => successEnvelope({ id, type: 'operation' }, m())).toThrow(EnvelopeError);
    }
  });

  it('only the closed non-resource types may omit the id, and they cannot carry one', () => {
    const env = nonResourceEnvelope('platform_status', { status: 'available' }, m());
    expect(env.data).toEqual({ type: 'platform_status', status: 'available' });
    expect(contractErrors('meta', env.meta)).toEqual([]);
    // The ordinary resource schema still rejects it, so the shape cannot pass as a resource.
    expect(contractErrors('success-envelope', env)).not.toEqual([]);
    expect(() => nonResourceEnvelope('task' as never, { status: 'x' }, m())).toThrow(
      /not a non-resource response type/,
    );
    expect(() => nonResourceEnvelope('platform_status', { id: newPublicId('op') }, m())).toThrow(
      /no id/,
    );
  });

  it('no non-resource type is a registered 0D resource type, so resources can never omit their ID', () => {
    const resources: ReadonlySet<string> = new Set(ID_PREFIXES.map((p) => p.resource));
    for (const t of NON_RESOURCE_TYPES) expect(resources.has(t), t).toBe(false);
    for (const resource of [
      'session',
      'mfa_factor',
      'oauth_identity',
      'account',
      'step_up_challenge',
    ])
      expect(() => nonResourceEnvelope(resource as never, { x: 1 }, m())).toThrow(
        /not a non-resource response type/,
      );
    // The identity resources use ordinary envelopes with their registered prefixes.
    for (const [prefix, type] of [
      ['ses', 'session'],
      ['mfa', 'mfa_factor'],
      ['oid', 'oauth_identity'],
    ] as const) {
      const env = successEnvelope({ id: newPublicId(prefix), type }, m());
      expect(contractErrors('success-envelope', env)).toEqual([]);
    }
  });
});
