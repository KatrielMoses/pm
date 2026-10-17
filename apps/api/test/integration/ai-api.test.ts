import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerRuntime } from '@pm/platform';
import { LogErrorReporter } from '@pm/observability';
import {
  startAiProviderFixture,
  type AiProviderFixture,
  FIXTURE_MODEL_KEY,
} from '@pm/test-support';
import { aiDispatchHandler } from '@pm/work';
import {
  Browser,
  idemKey,
  identityEnv,
  mailTo,
  PASSWORD,
  registerAndVerify,
  signIn,
  tokenFrom,
  type IdentityEnv,
} from './identity-helpers.ts';

/**
 * 7A HTTP surface (ADR-0038): the AI routes answer through the same gateway as the service tests,
 * readiness reports a configured transport truthfully, bearer callers need `ai:execute` (or
 * `usage:read`) and never reach settings, keys, limits, or reconciliation, and a completed
 * Idempotency-Key re-renders through current authority without dispatching again.
 */
describe('AI gateway API (7A)', () => {
  let fx: AiProviderFixture;
  let env: IdentityEnv;
  let worker: WorkerRuntime;
  let owner: Browser;
  let ws: string;
  let brand: string;
  const key = () => ({ 'idempotency-key': idemKey() });
  const base = () => `/v1/workspaces/${ws}`;

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }
  /** A protected request, completing the password step-up when challenged. */
  async function protectedCall(
    who: Browser,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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
      res = await who.request(method, url, {
        body,
        headers: { ...h, 'step-up': v.json().data.token },
      });
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
  const drain = async (run: string) => {
    for (let i = 0; i < 10; i++) {
      await worker.runCycle({ wait: true });
      const s = await env.db.admin(
        `SELECT execution_state FROM exec.operation WHERE public_id = $1`,
        [run],
      );
      if (['succeeded', 'partial', 'failed', 'cancelled'].includes(s.rows[0].execution_state))
        return s.rows[0].execution_state;
    }
    throw new Error('run did not finish');
  };

  beforeAll(async () => {
    fx = await startAiProviderFixture();
    env = await identityEnv(fx.env());
    const j = env.h.config.jobs;
    worker = new WorkerRuntime({
      db: env.h.worker,
      discovery: env.h.discovery,
      handlers: [
        aiDispatchHandler({
          tenant: env.h.worker,
          discovery: env.h.discovery,
          service: env.work,
          metrics: env.h.telemetry.metrics,
          logger: env.h.logger,
          maxAttempts: 3,
          timeoutMs: 20_000,
        }),
      ],
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
    owner = await person('ai-owner@example.test', '203.0.113.170');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'AI HTTP',
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
  });
  afterAll(async () => {
    await worker?.stop();
    await env?.close();
    await fx?.close();
  });

  it('AT-378 serves status, settings, estimates, runs, and usage over HTTP with truthful readiness and bearer scopes', async () => {
    expect(env.work.aiReadiness()).toBe('ok');
    const off = await owner.get(`${base()}/ai`);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().data).toMatchObject({ type: 'ai_overview', availability: 'disabled' });
    const settings = await owner.get(`${base()}/ai/settings`);
    expect(settings.statusCode, settings.body).toBe(200);
    expect(settings.json().data).toMatchObject({
      type: 'ai_settings',
      transport: 'fixture',
      enabled: false,
    });
    expect(settings.json().data.id).toBeUndefined();
    const on = await protectedCall(
      owner,
      'PATCH',
      `${base()}/ai/settings`,
      { enabled: true, model_key: FIXTURE_MODEL_KEY },
      {
        'if-match': settings.headers.etag as string,
      },
    );
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().data).toMatchObject({ availability: 'ready', enabled: true });
    expect(on.headers.etag).toBe('"1"');
    const est = await owner.post(`${base()}/ai/estimates`, { prompt: 'Over HTTP' });
    expect(est.statusCode, est.body).toBe(200);
    expect(est.json().data).toMatchObject({
      type: 'ai_estimate',
      synthetic: true,
      confirm_required: true,
    });
    const started = await owner.post(
      `${base()}/ai/test-runs`,
      { prompt: 'Over HTTP', confirm_cost: true },
      { headers: key() },
    );
    expect(started.statusCode, started.body).toBe(202);
    const run = started.json().data.id as string;
    expect(run).toMatch(/^op_/);
    expect(await drain(run)).toBe('succeeded');
    const detail = await owner.get(`${base()}/ai/runs/${run}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.headers['cache-control']).toContain('no-store');
    expect(detail.json().data.content).toMatchObject({
      state: 'present',
      output: { completeness: 'complete' },
    });
    expect(
      (await owner.post(`${base()}/ai/runs/${run}:archive`, {}, { headers: key() })).statusCode,
    ).toBe(404);
    const list = await owner.get(`${base()}/ai/runs`);
    expect(list.json().data).toMatchObject({ type: 'ai_runs' });
    expect(list.json().data.items.map((r: { id: string }) => r.id)).toContain(run);
    const usage = await owner.get(`${base()}/ai/usage`);
    expect(usage.json().data).toMatchObject({ type: 'ai_usage', can_reconcile: true });
    // Bearer callers: ai:execute runs and reads its own history; nothing reaches configuration.
    const mint = async (scopes: string[]) => {
      const made = await protectedCall(owner, 'POST', `${base()}/api-tokens`, {
        name: 'AI',
        kind: 'personal',
        scopes,
      });
      expect(made.statusCode, made.body).toBe(201);
      return made.json().data.secret as string;
    };
    const ai = await mint(['ai:execute']);
    const reader = await mint(['records:read', 'usage:read']);
    const viaToken = await bearer(ai, 'POST', `${base()}/ai/test-runs`, {
      prompt: 'Token run',
      confirm_cost: true,
    });
    expect(viaToken.statusCode, viaToken.body).toBe(202);
    expect(
      (await bearer(ai, 'GET', `${base()}/ai/runs/${viaToken.json().data.id}`)).statusCode,
    ).toBe(200);
    expect(
      (await bearer(reader, 'POST', `${base()}/ai/test-runs`, { prompt: 'No scope' })).statusCode,
    ).toBe(403);
    expect((await bearer(reader, 'GET', `${base()}/ai`)).statusCode).toBe(403);
    expect((await bearer(reader, 'GET', `${base()}/ai/usage`)).statusCode).toBe(200);
    expect((await bearer(ai, 'GET', `${base()}/ai/usage`)).statusCode).toBe(403);
    for (const url of ['/ai/settings', '/ai/limits'])
      expect((await bearer(ai, 'GET', `${base()}${url}`)).statusCode).toBe(403);
    expect(
      (
        await bearer(ai, 'POST', `${base()}/ai/runs/${run}/attempts/1:reconcile`, {
          basis: 'not_charged',
        })
      ).statusCode,
    ).toBe(403);
    expect((await bearer(ai, 'POST', `${base()}/brands/${brand}/ai-profile`, {})).statusCode).toBe(
      403,
    );
    const ready = await env.app.inject('/readyz');
    expect(ready.json().checks.ai_provider).toBe('ok');
  });

  it('AT-379 a completed run key re-renders through current authority over HTTP and never dispatches again', async () => {
    const inv = await owner.post(
      `${base()}/invitations`,
      { email: 'ai-member@example.test', kind: 'member', role: 'member' },
      { headers: key() },
    );
    expect(inv.statusCode, inv.body).toBe(201);
    await env.deliverMail();
    const member = await person('ai-member@example.test', '203.0.113.171');
    const accepted = await member.post(
      '/v1/invitations:accept',
      { token: tokenFrom(mailTo(env, 'ai-member@example.test', 'invited').at(-1)) },
      { headers: key() },
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    const memberId = (await owner.get(`${base()}/people`))
      .json()
      .data.find((p: { role: string }) => p.role === 'member').id;
    const change = async (c: Record<string, unknown>) => {
      const preview = await owner.post(`${base()}/access:preview`, { change: c });
      const res = await protectedCall(owner, 'POST', `${base()}/access:apply`, {
        change: c,
        preview_token: preview.json().data.preview_token,
      });
      expect(res.statusCode, res.body).toBe(200);
    };
    await change({ kind: 'brand_grant', brand, principal: memberId, level: 'edit' });
    const task = await owner.post(
      `${base()}/tasks`,
      { brand, title: 'Replay context' },
      { headers: key() },
    );
    expect(task.statusCode, task.body).toBe(201);
    const body = {
      prompt: 'Replay me',
      brand,
      context: [{ id: task.json().data.id }],
      confirm_cost: true,
    };
    const headers = key();
    const first = await member.post(`${base()}/ai/test-runs`, body, { headers });
    expect(first.statusCode, first.body).toBe(202);
    const run = first.json().data.id as string;
    expect(await drain(run)).toBe('succeeded');
    const sent = fx.control.received().filter((r) => r.user.startsWith('Replay me')).length;
    expect(sent).toBe(1);
    const again = await member.post(`${base()}/ai/test-runs`, body, { headers });
    expect(again.statusCode).toBe(202);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().data.content.state).toBe('present');
    await change({ kind: 'brand_revoke', brand, principal: memberId });
    const revoked = await member.post(`${base()}/ai/test-runs`, body, { headers });
    expect(revoked.statusCode, revoked.body).toBe(202);
    expect(revoked.headers['idempotent-replayed']).toBe('true');
    expect(revoked.json().data.content).toMatchObject({
      state: 'withheld',
      prompt: null,
      output: null,
    });
    expect(JSON.stringify(revoked.json())).not.toContain('Replay context');
    const csv = await member.get(`${base()}/portability/exports/ai_history.csv`);
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain(run);
    expect(csv.body).not.toContain('Replay me');
    await worker.runCycle({ wait: true });
    expect(fx.control.received().filter((r) => r.user.startsWith('Replay me')).length).toBe(1);
  });

  it('AT-402 7B previews and grounded answers over HTTP: envelopes, no-store, bearer scopes and brand narrowing, completed-key replay', async () => {
    const mk = async (b: string, title: string) => {
      const r = await owner.post(`${base()}/tasks`, { brand: b, title }, { headers: key() });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().data.id as string;
    };
    const other = (
      await owner.post(`${base()}/brands`, { name: 'Other' }, { headers: key() })
    ).json().data.id as string;
    const mine = await mk(brand, 'HTTP falcon task');
    const theirs = await mk(other, 'HTTP other task');
    const preview = await owner.post(`${base()}/ai/context-previews`, {
      include: [{ type: 'task', id: mine }],
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers['cache-control']).toContain('no-store');
    expect(preview.json().data).toMatchObject({
      type: 'ai_context_manifest',
      sources: [expect.objectContaining({ handle: 'S1', id: mine, included: true })],
      semantic_search: false,
    });
    const digest = preview.json().data.digest as string;
    expect(
      (
        await owner.post(`${base()}/ai/context-previews`, {
          include: [{ type: 'task', id: mine, title: 'x' }],
        })
      ).statusCode,
    ).toBe(422);
    const est = await owner.post(`${base()}/ai/answer-estimates`, {
      include: [{ type: 'task', id: mine }],
      question: 'HTTP grounded?',
      manifest_digest: digest,
    });
    expect(est.statusCode, est.body).toBe(200);
    expect(est.json().data).toMatchObject({ type: 'ai_estimate', manifest: { digest } });
    const body = {
      include: [{ type: 'task', id: mine }],
      question: 'HTTP grounded?',
      manifest_digest: digest,
      confirm_cost: true,
    };
    const headers = key();
    const first = await owner.post(`${base()}/ai/answers`, body, { headers });
    expect(first.statusCode, first.body).toBe(202);
    const run = first.json().data.id as string;
    expect(await drain(run)).toBe('succeeded');
    const detail = await owner.get(`${base()}/ai/runs/${run}`);
    expect(detail.json().data).toMatchObject({
      purpose: 'grounded_answer',
      content: { state: 'present', answer: { status: 'checked' } },
    });
    const sent = fx.control.received().filter((r) => r.user.startsWith('HTTP grounded?')).length;
    const replay = await owner.post(`${base()}/ai/answers`, body, { headers });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().data.id).toBe(run);
    await worker.runCycle({ wait: true });
    expect(fx.control.received().filter((r) => r.user.startsWith('HTTP grounded?')).length).toBe(
      sent,
    );
    // Bearer callers: ai:execute previews and asks; without it nothing is previewed; a token
    // narrowed to one brand cannot reach a record in another (the same opaque refusal).
    const mint = async (extra: Record<string, unknown>) => {
      const made = await protectedCall(owner, 'POST', `${base()}/api-tokens`, {
        name: 'AI 7B',
        kind: 'personal',
        ...extra,
      });
      expect(made.statusCode, made.body).toBe(201);
      return made.json().data.secret as string;
    };
    const ai = await mint({ scopes: ['ai:execute'] });
    const reader = await mint({ scopes: ['records:read'] });
    const narrowed = await mint({ scopes: ['ai:execute'], brands: [brand] });
    expect(
      (
        await bearer(ai, 'POST', `${base()}/ai/context-previews`, {
          include: [{ type: 'task', id: mine }],
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await bearer(reader, 'POST', `${base()}/ai/context-previews`, {
          include: [{ type: 'task', id: mine }],
        })
      ).statusCode,
    ).toBe(403);
    const blocked = await bearer(narrowed, 'POST', `${base()}/ai/context-previews`, {
      include: [{ type: 'task', id: theirs }],
    });
    const unknown = await bearer(narrowed, 'POST', `${base()}/ai/context-previews`, {
      include: [{ type: 'task', id: `tsk_${'0'.repeat(26)}` }],
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.issues).toEqual(unknown.json().error.issues);
    expect(blocked.json().error.issues[0].code).toBe('context_unavailable');
    expect(blocked.body).not.toContain('HTTP other task');
  });
});
