import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { LogErrorReporter } from '@pm/observability';
import { WorkerRuntime } from '@pm/platform';
import { startAgentConnectorFixture, type AgentConnectorFixture } from '@pm/test-support';
import {
  agentConnectorTestHandler,
  agentRunHandler,
  AgentRunOutcomeConsumer,
  createWorkService,
} from '@pm/work';
import {
  Browser,
  idemKey,
  identityEnv,
  PASSWORD,
  registerAndVerify,
  signIn,
  ORIGIN,
  type IdentityEnv,
} from './identity-helpers.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SECRET = 'agent-credential-0123456789abcdef';

/**
 * 8C HTTP surface (ADR-0048; 0D PL-55): starting runs, reading them and their progress by long
 * poll, controls, the emergency stop, and the external agent's callbacks with its run-bound
 * credential through the real bearer gate, the agent-run routes, and the MCP endpoint. The
 * fixture agent works over HTTP into the app (in process); no internal identifier appears in any
 * body.
 */
describe('agent runs API (8C)', () => {
  let env: IdentityEnv;
  let fx: AgentConnectorFixture;
  let worker: WorkerRuntime;
  let owner: Browser;
  let ws: string;
  let brand: string;
  const bodies: string[] = [];
  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const key = (extra: Record<string, string> = {}) => ({ 'idempotency-key': idemKey(), ...extra });
  const base = () => `/v1/workspaces/${ws}`;
  const post = async (
    who: Browser,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => keep(await who.post(`${base()}${path}`, body, { headers: key(headers) }));
  const patch = async (
    who: Browser,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => keep(await who.patch(`${base()}${path}`, body, { headers: key(headers) }));
  const get = async (who: Browser, path: string) => keep(await who.get(`${base()}${path}`));
  const bearer = async (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const r = await env.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(method === 'POST' ? key() : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
    bodies.push(r.body);
    return r;
  };
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await fx.settled();
      const r = await worker.runCycle({ wait: true });
      if (!r.claimed && !r.dispatched) {
        const more = await env.db.admin(
          `SELECT (SELECT count(*)::int FROM exec.job WHERE state IN ('queued','retry_scheduled') AND run_at <= now()) +
                  (SELECT count(*)::int FROM exec.outbox_event WHERE dispatched_at IS NULL) AS n`,
        );
        if (!more.rows[0].n) return;
      }
    }
  };
  const agent = async (name: string, kind: 'api' | 'mcp', run: 'complete' | 'mutate' | 'ack') => {
    const made = (await post(owner, '/agents', { kind: 'external', name })).json().data;
    const edited = await patch(
      owner,
      `/agents/${made.id}`,
      {
        draft: {
          ...made.draft,
          scope: { brands: [brand] },
          tools: [
            { name: 'pm.tasks.get', version: '1' },
            { name: 'pm.tasks.update', version: '1' },
          ],
        },
      },
      { 'if-match': `"${made.version}"` },
    );
    expect(edited.statusCode, edited.body).toBe(200);
    const peer = `peer-${made.id.slice(4, 14).toLowerCase()}`;
    fx.peer(peer, { kind, secret: SECRET, run, tools: [{ name: 'pm.tasks.get', version: '1' }] });
    const c = await post(owner, `/agents/${made.id}/connector`, {
      kind,
      endpoint_url: fx.endpoint(peer),
      secret: SECRET,
    });
    expect(c.statusCode, c.body).toBe(200);
    const on = await post(
      owner,
      `/agents/${made.id}:activate`,
      {},
      { 'if-match': `"${c.json().data.version}"` },
    );
    expect(on.statusCode, on.body).toBe(200);
    expect(
      (await post(owner, `/agents/${made.id}/connector:test`, { confirm: true })).statusCode,
    ).toBe(202);
    await settle();
    return { id: made.id as string, peer };
  };
  const task = async (title: string) =>
    (await post(owner, '/tasks', { brand, title })).json().data.id as string;

  beforeAll(async () => {
    env = await identityEnv({ AGENT_CONNECTOR_TRANSPORT: 'fixture', PUBLIC_BASE_URL: ORIGIN });
    fx = await startAgentConnectorFixture({
      callback: async (url, init) => {
        const u = new URL(url);
        const r = await env.app.inject({
          method: init.method as 'POST',
          url: u.pathname + u.search,
          headers: init.headers,
          ...(init.body ? { payload: init.body } : {}),
        });
        bodies.push(r.body);
        let body: unknown;
        try {
          body = JSON.parse(r.body);
        } catch {
          body = r.body;
        }
        return { status: r.statusCode, body };
      },
    });
    const h = env.h;
    const svc = createWorkService({
      tenant: h.worker,
      platform: h.platform,
      identity: env.identity,
      config: h.config,
      logger: h.logger,
      metrics: h.telemetry.metrics,
    });
    worker = new WorkerRuntime({
      db: h.worker,
      discovery: h.discovery,
      handlers: [agentConnectorTestHandler({ service: svc }), agentRunHandler({ service: svc })],
      consumers: [new AgentRunOutcomeConsumer(svc)],
      params: {
        ...h.config.jobs,
        backoffBaseMs: 10,
        backoffCapMs: 20,
        shutdownGraceMs: 200,
        outboxReplayWindowMs: h.config.retention.outboxReplayWindowMs,
        maintenanceIntervalMs: 3_600_000,
        statsIntervalMs: 3_600_000,
      },
      buildId: 'test',
      logger: h.logger,
      metrics: h.telemetry.metrics,
      tracer: h.telemetry.tracer,
      errors: new LogErrorReporter(h.logger),
    });
    await worker.start({ loop: false });
    owner = new Browser(env.app);
    owner.ip = '203.0.113.230';
    await registerAndVerify(env, owner, 'run-owner@example.test');
    await signIn(owner, 'run-owner@example.test');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Runs',
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
    expect(bodies.some((b) => UUID.test(b))).toBe(false);
    await worker.stop();
    await env.close();
    await fx.close();
  });

  it('AT-661 over HTTP: start, dispatch, the agent works through its credential (API kind), progress by long poll, ready for review; the credential reaches nothing else', async () => {
    const a = await agent('HTTP agent', 'api', 'mutate');
    const t = await task('HTTP task');
    expect(
      (await post(owner, `/tasks/${t}/agents`, { profile: a.id, goal: 'Draft notes.' })).statusCode,
    ).toBe(201);
    const preview = await get(owner, `/tasks/${t}/agent-run-preview?profile=${a.id}`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().data).toMatchObject({
      can_start: true,
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'pm.tasks.get', mode: 'runs' }),
      ]),
    });
    const start = await post(owner, `/tasks/${t}/agents/${a.id}:run`, {});
    expect(start.statusCode, start.body).toBe(202);
    const run = start.json().data.run.id as string;
    await settle();
    const d = fx.dispatches().find((x) => x.peer === a.peer)!;
    const steps = Object.fromEntries(d.calls.map((c) => [c.step, c.status]));
    expect(steps).toMatchObject({
      progress: 200,
      commentary: 200,
      read: 200,
      write: 403,
      artifact: 200,
      result: 200,
    });
    const v = await get(owner, `/agent-runs/${run}`);
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().data.run).toMatchObject({
      state: 'ready_for_review',
      review: { required: true, owner: '8D' },
      capabilities: { accept: false },
    });
    const events = await get(owner, `/agent-runs/${run}/events?after=0&wait=0`);
    expect(events.statusCode).toBe(200);
    const evs = events.json().data.events as Array<{
      kind: string;
      source: string;
      verified: boolean;
      text: string;
    }>;
    expect(evs.find((e) => e.kind === 'commentary')).toMatchObject({
      source: 'agent',
      verified: false,
    });
    const art = await get(owner, `/agent-runs/${run}/artifacts/notes`);
    expect(art.json().data.versions[0].content).toContain('Notes for HTTP task');
    // The credential: other paths are one opaque answer; once the run ended it authenticates nothing.
    const token = (d.body.credential as { token: string }).token;
    expect((await bearer(token, 'GET', `${base()}/tasks`)).statusCode).toBe(401);
    expect((await bearer(token, 'GET', `${base()}/agent-runs/${run}`)).statusCode).toBe(401);
  });

  it('AT-662 MCP kind: the agent calls its run tools through the MCP endpoint with the run credential; other MCP methods and tools are refused', async () => {
    const a = await agent('MCP agent', 'mcp', 'ack');
    const t = await task('MCP task');
    await post(owner, `/tasks/${t}/agents`, { profile: a.id, goal: 'Read it.' });
    const run = (await post(owner, `/tasks/${t}/agents/${a.id}:run`, {})).json().data.run
      .id as string;
    await settle();
    const d = fx.dispatches().find((x) => x.peer === a.peer)!;
    const token = (d.body.credential as { token: string }).token;
    const mcp = (body: unknown) =>
      env.app.inject({
        method: 'POST',
        url: `${base()}/mcp`,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        payload: JSON.stringify(body),
      });
    const list = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().result.tools.map((x: { name: string }) => x.name)).toEqual(['pm.tasks.get']);
    const call = await mcp({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'pm.tasks.get',
        arguments: { task: t },
        _meta: { idempotencyKey: 'mcp-read-00001' },
      },
    });
    expect(JSON.parse(call.json().result.content[0].text)).toMatchObject({
      id: t,
      title: 'MCP task',
    });
    const write = await mcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'pm.tasks.update', arguments: { task: t } },
    });
    expect(write.json().error).toBeTruthy();
    const resources = await mcp({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri: 'pm://help' },
    });
    expect(resources.json().error.code).toBe(-32601);
    // People's routes and other workspaces stay closed to it.
    expect((await bearer(token, 'POST', `${base()}/agent-runs/${run}:cancel`, {})).statusCode).toBe(
      404,
    );
    expect(
      (
        await bearer(
          token,
          'GET',
          `/v1/workspaces/ws_01HZZZZZZZZZZZZZZZZZZZZZZZ/agent-runs/${run}/context`,
        )
      ).statusCode,
    ).toBe(401);
    const ctx = await bearer(token, 'GET', `${base()}/agent-runs/${run}/context`);
    expect(ctx.statusCode, ctx.body).toBe(200);
    expect(ctx.json().data).toMatchObject({
      task: { id: t },
      tools: [{ name: 'pm.tasks.get', version: '1' }],
    });
  });

  it('AT-663 controls and the emergency stop over HTTP: tokens need agents:execute to control and can never stop or read health', async () => {
    const a = await agent('Control agent', 'api', 'ack');
    const t = await task('Control task');
    await post(owner, `/tasks/${t}/agents`, { profile: a.id, goal: 'Wait.' });
    const run = (await post(owner, `/tasks/${t}/agents/${a.id}:run`, {})).json().data.run
      .id as string;
    await settle();
    const mint = async (scopes: string[]) => {
      const headers = key();
      const body = { name: `Tok ${scopes.join(' ')}`, kind: 'personal', scopes };
      let tok = await owner.request('POST', `${base()}/api-tokens`, { body, headers });
      if (tok.statusCode === 403 && tok.json().error.code === 'step_up_required') {
        const sv = await owner.post(`/v1/auth/step-up/${tok.json().error.step_up.id}:verify`, {
          method: 'password',
          proof: PASSWORD,
        });
        tok = await owner.request('POST', `${base()}/api-tokens`, {
          body,
          headers: { ...headers, 'step-up': sv.json().data.token },
        });
      }
      expect(tok.statusCode, tok.body).toBe(201);
      return tok.json().data.secret as string;
    };
    const plain = await mint(['records:read', 'records:write']);
    const exec = await mint(['records:read', 'agents:execute']);
    expect((await bearer(plain, 'POST', `${base()}/agent-runs/${run}:pause`, {})).statusCode).toBe(
      403,
    );
    const paused = await bearer(exec, 'POST', `${base()}/agent-runs/${run}:pause`, {});
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json().data.run).toMatchObject({ state: 'waiting', waiting: 'paused' });
    expect((await bearer(exec, 'POST', `${base()}/agent-emergency-stop`, {})).statusCode).toBe(403);
    expect((await bearer(exec, 'GET', `${base()}/agent-health`)).statusCode).toBe(403);
    // A people token cannot post agent callbacks either.
    expect((await bearer(exec, 'POST', `${base()}/agent-runs/${run}/result`, {})).statusCode).toBe(
      404,
    );
    const stop = await post(owner, '/agent-emergency-stop', { reason: 'Drill' });
    expect(stop.statusCode, stop.body).toBe(200);
    expect(stop.json().data).toMatchObject({ stopped: true });
    const health = await get(owner, '/agent-health');
    expect(health.json().data.emergency_stop).toMatchObject({ stopped: true, can_trigger: true });
    const restart = await post(owner, '/agent-emergency-stop/restart', {});
    expect(restart.json().data).toMatchObject({ stopped: false });
  });
});
