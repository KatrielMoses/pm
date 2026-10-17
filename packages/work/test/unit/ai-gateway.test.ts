import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret, type AiConfig } from '@pm/config';
import { startAiProviderFixture, type AiProviderFixture } from '@pm/test-support';
import { periodFor } from '../../src/ai/budget.ts';
import { microsString, parseMicros, usdDisplay } from '../../src/ai/money.ts';
import { decideAvailability, fieldAllowed } from '../../src/ai/policy.ts';
import { AiProviderError, classifyStatus, MessagesProvider } from '../../src/ai/provider.ts';
import { REDACTION_MARKER, redactCredentials } from '../../src/ai/redaction.ts';
import {
  inputTokenBound,
  maxCostPico,
  modelByKey,
  MODELS,
  modelsForTransport,
  usageCostPico,
} from '../../src/ai/registry.ts';

const FIXTURE = 'fixture/synthetic-messages@2026-10-17';
const REAL = 'anthropic/claude-haiku-5-5@2026-10-06';

describe('7A money: exact decimal micro-dollars', () => {
  it('round-trips six fractional digits and never shows a real cost as zero', () => {
    expect(microsString(parseMicros('0.000001'))).toBe('0.000001');
    expect(microsString(parseMicros('12'))).toBe('12.000000');
    expect(parseMicros('1.5')).toBe(1_500_000n);
    expect(() => parseMicros('-1')).toThrow();
    expect(() => parseMicros('1.0000001')).toThrow();
    expect(usdDisplay(0n)).toBe('$0.00');
    expect(usdDisplay(1n)).not.toBe('$0.00');
    expect(usdDisplay(1_000_000_000_000n)).toBe('$1.00');
    expect(usdDisplay(250_000_000_000n)).toBe('$0.25');
  });
});

describe('7A registry: explicit versioned models, bounded costs', () => {
  it('names every model, price, and privacy guarantee explicitly (no implicit latest)', () => {
    for (const m of MODELS) {
      expect(m.key).toMatch(/^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-z_.-]+$/);
      expect(m.key).not.toMatch(/latest/);
      expect(m.price.version).toBeTruthy();
      expect(m.price.source).toBeTruthy();
      expect(m.privacy.zeroRetention).toBe(false);
      expect(m.capabilities.providerIdempotency).toBe(false);
    }
    expect(modelByKey(REAL)!.price.synthetic).toBe(false);
    expect(modelByKey(FIXTURE)!.synthetic).toBe(true);
    expect(modelsForTransport('fixture').map((m) => m.key)).toEqual([FIXTURE]);
    expect(modelsForTransport('anthropic').map((m) => m.key)).toEqual([REAL]);
    expect(modelsForTransport('none')).toEqual([]);
  });

  it('bounds input conservatively at one token per UTF-8 byte plus framing, and prices the full output maximum', () => {
    const m = modelByKey(REAL)!;
    const bound = inputTokenBound(m, ['system', 'héllo'], 1);
    expect(bound).toBe(6 + 6 + m.inputBound.overheadTokens + m.inputBound.perMessageTokens);
    expect(maxCostPico(m, 100, 50)).toBe(100n * 100_000n + 50n * 500_000n);
    expect(usageCostPico(m, 10, 5)).toBe(10n * 100_000n + 5n * 500_000n);
    expect(usageCostPico(m, 10, 5)).toBeLessThan(maxCostPico(m, 100, 50));
  });
});

describe('7A billing period', () => {
  it('is the calendar month in the workspace timezone, across the month boundary', () => {
    const at = new Date('2026-10-31T23:30:00Z');
    expect(periodFor('UTC', at)).toEqual({ start: '2026-10-01', end: '2026-11-01' });
    expect(periodFor('Europe/Berlin', at)).toEqual({ start: '2026-11-01', end: '2026-12-01' });
    expect(periodFor('America/Los_Angeles', new Date('2026-12-01T05:00:00Z'))).toEqual({
      start: '2026-11-01',
      end: '2026-12-01',
    });
    expect(periodFor('UTC', new Date('2026-12-15T00:00:00Z')).end).toBe('2027-01-01');
  });
});

describe('7A redaction', () => {
  it('replaces credential shapes before anything leaves or is stored', () => {
    const samples = [
      'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'AKIAABCDEFGHIJKLMNOP',
      'Bearer abcdefghijklmnopqrstuvwxyz012345',
      'password=correcthorse99',
      'https://user:secretpass@example.com/x',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
    ];
    for (const s of samples) {
      const r = redactCredentials(`before ${s} after`);
      expect(r.text).not.toContain(s.slice(4, 18));
      expect(r.text).toContain(REDACTION_MARKER);
      expect(r.count).toBeGreaterThan(0);
    }
    expect(redactCredentials('Plan the Harbor launch for next week').count).toBe(0);
  });
});

describe('7A dispatch policy', () => {
  const base: AiConfig = {
    provider: {
      provider: 'fixture',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: new Secret('k'),
      timeoutMs: 1000,
    },
    approvedModels: [],
    byokEnabled: false,
    defaults: {
      monthlyAllowanceMicros: '1',
      hardLimitMicros: '1',
      inputTokenLimit: 1,
      outputTokenLimit: 1,
    },
    maxOutputTokens: 64,
    maxAttempts: 3,
    warningThresholdsBp: [8000, 10_000],
    historyRetentionDays: null,
  };
  const policy = {
    enabled: true,
    modelKey: FIXTURE,
    keySource: 'deployment' as const,
    workspaceKeySet: false,
    maxDataClass: 'C2' as const,
    requireTrainingExclusion: true,
  };
  it('fails closed at every prerequisite and never substitutes a model', () => {
    expect(
      decideAvailability({ ...base, provider: { provider: 'none' } }, policy, true).availability,
    ).toBe('unconfigured');
    expect(decideAvailability(base, null, true).availability).toBe('disabled');
    expect(decideAvailability(base, { ...policy, enabled: false }, true).availability).toBe(
      'disabled',
    );
    expect(decideAvailability(base, { ...policy, modelKey: REAL }, true).availability).toBe(
      'model_unavailable',
    );
    const real: AiConfig = {
      ...base,
      provider: {
        provider: 'anthropic',
        baseUrl: 'http://127.0.0.1:1',
        apiKey: new Secret('k'),
        timeoutMs: 1000,
      },
    };
    expect(decideAvailability(real, { ...policy, modelKey: REAL }, true)).toMatchObject({
      availability: 'not_approved',
      model: { key: REAL },
    });
    expect(
      decideAvailability({ ...real, approvedModels: [REAL] }, { ...policy, modelKey: REAL }, true),
    ).toMatchObject({ availability: 'ready', funding: 'platform', approved: true });
    expect(
      decideAvailability(base, { ...policy, keySource: 'workspace', workspaceKeySet: true }, true)
        .availability,
    ).toBe('key_unavailable');
    expect(
      decideAvailability(
        { ...base, byokEnabled: true },
        { ...policy, keySource: 'workspace', workspaceKeySet: true },
        true,
      ),
    ).toMatchObject({ availability: 'ready', funding: 'synthetic' });
    expect(decideAvailability(base, policy, false).availability).toBe('not_entitled');
    expect(decideAvailability(base, policy, true)).toMatchObject({
      availability: 'ready',
      funding: 'synthetic',
    });
  });
  it('sends only AI-eligible fields within the workspace data class', () => {
    expect(fieldAllowed('task', 'title', 'C2')).toBeNull();
    expect(fieldAllowed('task', 'title', 'C1')).toBe('data_class');
    expect(fieldAllowed('task', 'budget_amount', 'C2')).toBe('field_not_ai_eligible');
    expect(fieldAllowed('project', 'ai_budget_micros', 'C2')).toBe('field_not_ai_eligible');
  });
});

describe('7A Messages provider contract (deterministic fixture)', () => {
  let fx: AiProviderFixture;
  let provider: MessagesProvider;
  const req = (user: string, signal = new AbortController().signal, key = () => fx.apiKey) => ({
    model: 'synthetic-messages',
    system: 'system text',
    user,
    maxOutputTokens: 32,
    apiKey: key,
    signal,
  });
  beforeAll(async () => {
    fx = await startAiProviderFixture();
    provider = new MessagesProvider({ baseUrl: fx.baseUrl, timeoutMs: 1500, maxTextChars: 40_000 });
  });
  afterAll(async () => {
    await fx.close();
  });

  it('streams text, usage, stop reason, and the request id with the documented headers and body', async () => {
    const r = await provider.complete(req('Hello there'), false);
    expect(r).toMatchObject({
      outcome: 'complete',
      stopReason: 'end_turn',
      requestId: expect.stringMatching(/^req_fixture_/),
    });
    expect(r.text).toMatch(/Synthetic fixture reply/);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
    const sent = fx.control.received().at(-1)!;
    expect(sent).toMatchObject({
      model: 'synthetic-messages',
      maxTokens: 32,
      system: 'system text',
      user: 'Hello there',
    });
  });

  it('labels truncation and refusal and never calls them complete', async () => {
    expect((await provider.complete(req('x #fixture:truncate'), false)).outcome).toBe('truncated');
    expect((await provider.complete(req('x #fixture:refuse'), false)).outcome).toBe('refused');
  });

  it('classifies HTTP errors without reading bodies; error responses are not charged for this model', async () => {
    const cases: Array<[string, string]> = [
      ['x #fixture:auth', 'auth'],
      ['x #fixture:not_found', 'config'],
      ['x #fixture:overloaded', 'transient'],
    ];
    for (const [user, kind] of cases) {
      const err = (await provider
        .complete(req(user), false)
        .catch((e: unknown) => e)) as AiProviderError;
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err.kind).toBe(kind);
      expect(err.charged).toBe('no');
      expect(err.message).not.toContain('x-api-key');
    }
    fx.control.failNext(1, 429, 7);
    const rate = (await provider
      .complete(req('rate'), false)
      .catch((e: unknown) => e)) as AiProviderError;
    expect(rate).toMatchObject({ kind: 'rate', retryAfterMs: 7000, charged: 'no' });
    // Where error responses may be billed, the adapter says so.
    expect(classifyStatus(500, new Headers(), null, 'unknown').charged).toBe('unknown');
  });

  it('a stream cut mid-way or an error event is an unknown outcome with the partial text kept', async () => {
    const cut = (await provider
      .complete(req('x #fixture:interrupt'), false)
      .catch((e: unknown) => e)) as AiProviderError;
    expect(cut).toMatchObject({ kind: 'stream_interrupted', charged: 'unknown' });
    expect(cut.partialText.length).toBeGreaterThan(0);
    const ev = (await provider
      .complete(req('x #fixture:error_event'), false)
      .catch((e: unknown) => e)) as AiProviderError;
    expect(ev).toMatchObject({ kind: 'stream_interrupted', charged: 'unknown' });
  });

  it('a timeout after sending is unknown; a refused connection is not sent; cancellation says it may be charged', async () => {
    const hung = (await provider
      .complete(req('x #fixture:hang'), false)
      .catch((e: unknown) => e)) as AiProviderError;
    expect(hung).toMatchObject({ kind: 'outcome_unknown', charged: 'unknown' });
    fx.control.releaseHung();
    // A port with nothing listening: the request never left.
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const offline = new MessagesProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 1000,
      maxTextChars: 10,
    });
    const ns = (await offline
      .complete(req('x'), false)
      .catch((e: unknown) => e)) as AiProviderError;
    expect(ns).toMatchObject({ kind: 'not_sent', charged: 'no' });
    const ac = new AbortController();
    const slow = provider
      .complete(req('x #fixture:slow', ac.signal), false)
      .catch((e: unknown) => e);
    setTimeout(() => ac.abort(), 300);
    expect(await slow).toMatchObject({ kind: 'cancelled', charged: 'unknown' });
  });

  it('bounds retained output locally', async () => {
    const tiny = new MessagesProvider({ baseUrl: fx.baseUrl, timeoutMs: 1500, maxTextChars: 10 });
    expect((await tiny.complete(req('bounded'), false)).text.length).toBeLessThanOrEqual(10);
  });
});
