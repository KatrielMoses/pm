import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerRuntime } from '@pm/platform';
import { LogErrorReporter } from '@pm/observability';
import {
  FIXTURE_MODEL_KEY,
  startAiProviderFixture,
  syntheticWav,
  type AiProviderFixture,
} from '@pm/test-support';
import { aiDispatchHandler, aiTranscriptionHandler } from '@pm/work';
import {
  Browser,
  idemKey,
  identityEnv,
  PASSWORD,
  registerAndVerify,
  signIn,
  type IdentityEnv,
} from './identity-helpers.ts';

/**
 * 7F HTTP surface (ADR-0043): daily-plan previews and planner proposals, capture interpretation,
 * and voice capture answer through the same gateway as the service tests, session-only (bearer
 * callers are refused at the edge), with their envelopes; the voice upload goes through the real
 * signed local-storage PUT, and a plan applies through the 7D proposal routes.
 */
describe('Planning and capture API (7F)', () => {
  let fx: AiProviderFixture;
  let env: IdentityEnv;
  let worker: WorkerRuntime;
  let owner: Browser;
  let ws: string;
  let brand: string;
  const key = () => ({ 'idempotency-key': idemKey() });
  const base = () => `/v1/workspaces/${ws}`;
  const handlerDeps = () => ({
    tenant: env.h.worker,
    discovery: env.h.discovery,
    service: env.work,
    metrics: env.h.telemetry.metrics,
    logger: env.h.logger,
    maxAttempts: 3,
    timeoutMs: 20_000,
  });
  const drain = async (run: string) => {
    for (let i = 0; i < 10; i++) {
      await worker.runCycle({ wait: true });
      const s = await env.db.admin(`SELECT execution_state FROM exec.operation WHERE public_id = $1`, [run]);
      if (['succeeded', 'partial', 'failed', 'cancelled'].includes(s.rows[0].execution_state)) return;
    }
    throw new Error('run did not finish');
  };
  async function protectedCall(
    who: Browser,
    method: 'POST' | 'PATCH' | 'PUT',
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    const h = { ...key(), ...headers };
    let res = await who.request(method, url, { body, headers: h });
    if (res.statusCode === 403 && res.json().error.code === 'step_up_required') {
      const v = await who.post(`/v1/auth/step-up/${res.json().error.step_up.id}:verify`, {
        method: 'password',
        proof: PASSWORD,
      });
      res = await who.request(method, url, { body, headers: { ...h, 'step-up': v.json().data.token } });
    }
    return res;
  }
  const bearer = (secret: string, method: 'GET' | 'POST', url: string, body?: unknown) =>
    env.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${secret}`, ...(method === 'POST' ? key() : {}) },
      ...(method === 'POST' ? { payload: (body ?? {}) as object } : {}),
    });

  beforeAll(async () => {
    fx = await startAiProviderFixture();
    env = await identityEnv({
      ...fx.env(),
      TRANSCRIPTION_PROVIDER: 'fixture',
      TRANSCRIPTION_BASE_URL: fx.baseUrl,
      TRANSCRIPTION_API_KEY: fx.apiKey,
      OBJECT_STORAGE: 'local',
      OBJECT_STORAGE_LOCAL_DIR: mkdtempSync(join(tmpdir(), 'pm-api-voice-')),
      OBJECT_STORAGE_LOCAL_SECRET: randomBytes(32).toString('base64url'),
      OBJECT_STORAGE_PUBLIC_BASE_URL: 'http://127.0.0.1:4999',
    });
    const j = env.h.config.jobs;
    worker = new WorkerRuntime({
      db: env.h.worker,
      discovery: env.h.discovery,
      handlers: [aiDispatchHandler(handlerDeps()), aiTranscriptionHandler(handlerDeps())],
      consumers: [],
      params: {
        leaseDurationMs: j.leaseDurationMs,
        heartbeatIntervalMs: j.heartbeatIntervalMs,
        backoffBaseMs: 10,
        backoffCapMs: 20,
        maxAttempts: 3,
        timeoutMs: 20_000,
        workspaceConcurrencyCap: 4,
        pollIntervalMs: 50,
        claimBatchSize: 10,
        shutdownGraceMs: 200,
        outboxReplayWindowMs: env.h.config.retention.outboxReplayWindowMs,
        maintenanceIntervalMs: 3_600_000,
        statsIntervalMs: 3_600_000,
      },
      buildId: 'test',
      logger: env.h.logger,
      metrics: env.h.telemetry.metrics,
      tracer: env.h.telemetry.tracer,
      errors: new LogErrorReporter(env.h.logger),
      random: () => 0,
    });
    await worker.start({ loop: false });
    owner = new Browser(env.app);
    owner.ip = '203.0.113.190';
    await registerAndVerify(env, owner, 'plan-owner@example.test');
    await signIn(owner, 'plan-owner@example.test');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Plans HTTP',
        timezone: 'UTC',
        locale: 'en',
        currency: 'USD',
        week_start: 1,
        first_brand: { name: 'Main' },
      },
      { headers: key() },
    );
    ws = created.json().data.id;
    brand = created.json().data.first_brand.id;
    const settings = await owner.get(`${base()}/ai/settings`);
    const enabled = await protectedCall(
      owner,
      'PATCH',
      `${base()}/ai/settings`,
      { enabled: true, model_key: FIXTURE_MODEL_KEY },
      { 'if-match': settings.headers.etag as string },
    );
    expect(enabled.statusCode, JSON.stringify(enabled.json())).toBe(200);
  });
  afterAll(async () => {
    await worker?.stop();
    await env?.close();
    await fx?.close();
  });

  it('previews a daily plan and turns it into a planner proposal applied through the 7D routes', async () => {
    const prof = await owner.get(`${base()}/me/capacity-profile`);
    const windows = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));
    const put = await owner.request('PUT', `${base()}/me/capacity-profile`, {
      body: { windows },
      headers: { ...key(), 'if-match': prof.headers.etag as string },
    });
    expect(put.statusCode, JSON.stringify(put.json())).toBe(200);
    const ownerMem = (
      (await owner.get(`${base()}/people`)).json().data as Array<{
        id: string;
        email?: string;
        account?: { email?: string };
      }>
    ).find((x) => (x.email ?? x.account?.email) === 'plan-owner@example.test')!.id;
    const t = (
      await owner.post(`${base()}/tasks`, { brand, title: 'Plan me', estimate_minutes: 60 }, { headers: key() })
    ).json().data;
    const assigned = await owner.post(
      `${base()}/tasks/${t.id}:assign`,
      { assignees: [ownerMem], version: t.version },
      { headers: key() },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);
    const today = new Date();
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + ((8 - (today.getUTCDay() || 7)) % 7 || 7)))
      .toISOString()
      .slice(0, 10);
    const preview = await owner.post(`${base()}/planning/day-plan-previews`, { day }, { headers: key() });
    expect(preview.statusCode, JSON.stringify(preview.json())).toBe(200);
    expect(preview.json().data).toMatchObject({ type: 'day_plan_preview', day, mode: 'rule_based', generated: false });
    expect(preview.headers['cache-control']).toBe('private, no-store');
    const created = await owner.post(`${base()}/planning/day-plans`, { day }, { headers: key() });
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    const v = created.json().data;
    expect(v).toMatchObject({ type: 'change_proposal', origin: 'planner' });
    const approved = await owner.post(
      `${base()}/ai/proposals/${v.id}:approve`,
      { revision: v.revision, fingerprint: v.fingerprint },
      { headers: key() },
    );
    expect(approved.statusCode, JSON.stringify(approved.json())).toBe(200);
    const applied = await owner.post(
      `${base()}/ai/proposals/${v.id}:apply`,
      { revision: v.revision, fingerprint: v.fingerprint },
      { headers: key() },
    );
    expect(applied.statusCode, JSON.stringify(applied.json())).toBe(200);
    expect(applied.json().data).toMatchObject({ state: 'applied' });
  });

  it('interprets a capture through the assist routes and returns the checked candidate', async () => {
    const text = 'Book the venue tomorrow high priority #fixture:ok';
    const preview = await owner.post(`${base()}/ai/context-previews`, { scope: {}, include: [] }, { headers: key() });
    expect(preview.statusCode, JSON.stringify(preview.json())).toBe(200);
    const req = {
      action: 'interpret_capture.v1',
      scope: {},
      include: [],
      instruction: text,
      manifest_digest: preview.json().data.digest,
      confirm_cost: true,
    };
    const est = await owner.post(`${base()}/ai/assist-estimates`, req, { headers: key() });
    expect(est.statusCode, JSON.stringify(est.json())).toBe(200);
    const run = await owner.post(
      `${base()}/ai/assist-runs`,
      { ...req, input_digest: est.json().data.input_digest },
      { headers: key() },
    );
    expect(run.statusCode, JSON.stringify(run.json())).toBe(202);
    await drain(run.json().data.id);
    const cand = await owner.post(
      `${base()}/capture/interpretations`,
      { text, interpretation: run.json().data.id },
      { headers: key() },
    );
    expect(cand.statusCode, JSON.stringify(cand.json())).toBe(200);
    expect(cand.json().data).toMatchObject({ type: 'capture_interpretation', ai: true });
    expect(cand.json().data.candidate.detected.map((d: { field: string }) => d.field)).toEqual(
      expect.arrayContaining(['due_date', 'priority']),
    );
  });

  it('voice: settings, create, signed upload, transcribe, read, and cancel', async () => {
    const settings = await owner.get(`${base()}/capture/voice-settings`);
    expect(settings.json().data).toMatchObject({ type: 'voice_settings', transcription: 'available', synthetic: true });
    const bytes = syntheticWav(2, { transcript: 'Spoken note' });
    const sha = createHash('sha256').update(bytes).digest('hex');
    const created = await owner.post(
      `${base()}/capture/voice`,
      { format: 'audio/wav', byte_size: bytes.byteLength, sha256: sha, duration_ms: 2000 },
      { headers: key() },
    );
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    const v = created.json().data;
    expect(v).toMatchObject({ type: 'voice_capture', state: 'uploaded' });
    const url = new URL(v.upload.url);
    const put = await env.app.inject({
      method: 'PUT',
      url: url.pathname + url.search,
      headers: v.upload.headers,
      payload: Buffer.from(bytes),
    });
    expect(put.statusCode).toBeLessThan(300);
    const tr = await owner.post(`${base()}/capture/voice/${v.id}:transcribe`, {}, { headers: key() });
    expect(tr.statusCode, JSON.stringify(tr.json())).toBe(200);
    await drain(tr.json().data.run);
    const got = await owner.get(`${base()}/capture/voice/${v.id}`);
    expect(got.json().data).toMatchObject({
      state: 'transcribed',
      audio: 'discarded',
      transcript: { text: 'Spoken note', synthetic: true },
    });
    const saved = await owner.post(
      `${base()}/capture`,
      { text: 'Spoken note, edited', brand, voice: v.id },
      { headers: key() },
    );
    expect(saved.statusCode, JSON.stringify(saved.json())).toBe(201);
    const other = await owner.post(
      `${base()}/capture/voice`,
      { format: 'audio/wav', byte_size: bytes.byteLength, sha256: sha, duration_ms: 2000 },
      { headers: key() },
    );
    const cancel = await owner.post(`${base()}/capture/voice/${other.json().data.id}:cancel`, {}, { headers: key() });
    expect(cancel.json().data).toMatchObject({ state: 'cancelled', audio: 'discarded' });
    expect((await owner.post(`${base()}/capture/voice/${v.id}:explode`, {}, { headers: key() })).statusCode).toBe(404);
  });

  it('bearer callers never reach plans, interpretation, or voice, whatever their scopes', async () => {
    const tok = await protectedCall(owner, 'POST', `${base()}/api-tokens`, {
      name: '7F',
      kind: 'personal',
      scopes: ['ai:execute', 'records:read', 'records:write', 'capture:write'],
    });
    const secret = tok.json().data.secret as string;
    for (const [method, url] of [
      ['POST', `${base()}/planning/day-plan-previews`],
      ['POST', `${base()}/planning/day-plans`],
      ['POST', `${base()}/capture/interpretations`],
      ['GET', `${base()}/capture/voice-settings`],
      ['POST', `${base()}/capture/voice`],
    ] as const)
      expect((await bearer(secret, method, url, {})).statusCode, url).toBe(403);
  });
});
