import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startAgentConnectorFixture, type AgentConnectorFixture } from '@pm/test-support';
import type { WorkerRuntime } from '@pm/platform';
import { agentConnectorTestHandler } from '@pm/work';
import { mutation, workEnv, type WorkEnv } from './fixture.ts';
import { automationWorker, settle } from './automation-support.ts';
import { agentWorld, code, config, issueOf, v, type AgentWorld } from './agents-support.ts';

const SECRET = 'agent-credential-0123456789abcdef';

/**
 * Phase 8B connectors (AGT-007): real configuration and safe verification against deterministic
 * local peers (the synthetic fixture, never a real agent), for the API, signed-webhook, and
 * MCP-compatible kinds. A test is a separate confirmed operation; the worker re-decides it
 * immediately before one bounded request carrying only protocol metadata and a nonce, and binds
 * the result to the tested configuration version. Capabilities are metadata, never authority.
 */
describe('agents (8B): connectors', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let fx: AgentConnectorFixture;
  let w: AgentWorld;
  let worker: WorkerRuntime;

  const external = async (name: string, tools = [{ name: 'pm.tasks.get', version: '1' }]) =>
    (
      await env.svc.createAgentProfile(
        w.owner,
        w.ws,
        {
          name,
          kind: 'external',
          draft: config({
            kind: 'external',
            model_key: null,
            tools,
            scope: { brands: [w.brands.Harbor!] },
          }),
        },
        mutation(),
      )
    ).data as Record<string, any>;
  const connect = async (
    id: string,
    kind: 'api' | 'webhook' | 'mcp',
    peer: string,
    secret: string | undefined = SECRET,
  ) =>
    (
      await env.svc.configureAgentConnector(
        w.owner,
        w.ws,
        id,
        { kind, endpoint_url: fx.endpoint(peer), ...(kind === 'webhook' ? {} : { secret }) },
        mutation(),
      )
    ).data as Record<string, any>;
  const test = async (id: string) => {
    const r = await env.svc.testAgentConnector(w.owner, w.ws, id, { confirm: true }, mutation());
    await settle(db, worker);
    return (await env.svc.getAgentConnectorTest(
      w.owner,
      w.ws,
      id,
      (r.data as { id: string }).id,
    )) as Record<string, any>;
  };
  const view = async (id: string) =>
    (await env.svc.getAgentProfile(w.owner, w.ws, id)) as Record<string, any>;

  beforeAll(async () => {
    fx = await startAgentConnectorFixture();
    db = await createTestDatabase();
    env = workEnv(db, {
      agents: { transport: 'fixture', productOrigin: 'https://pm.example.test' },
      work: { agentConnectorTimeoutMs: 1000, agentConnectorTestsPerHour: 50 },
    });
    w = await agentWorld(env, db);
    worker = await automationWorker(env, {
      handlers: [agentConnectorTestHandler({ service: env.workerSvc() })],
    });
  });
  afterAll(async () => {
    await worker.stop();
    await env.h.close();
    await db.drop();
    await fx.close();
  });

  it('AT-601 API kind: a bearer handshake proves protocol compatibility only; capabilities are intersected with the registry and the grants; the result is synthetic', async () => {
    fx.peer('api-ok', {
      kind: 'api',
      secret: SECRET,
      tools: [
        { name: 'pm.tasks.get', version: '1' },
        { name: 'pm.tasks.update', version: '1' },
        { name: 'shell.exec', version: '1' },
      ],
    });
    const a = await external('API agent');
    await connect(a.id, 'api', 'api-ok');
    await env.svc.activateAgentProfile(w.owner, w.ws, a.id, mutation());
    const t = await test(a.id);
    expect(t).toMatchObject({ state: 'passed', code: null, synthetic: true, current: true });
    const c = (await view(a.id)).connector;
    expect(c).toMatchObject({
      kind: 'api',
      state: 'verified',
      verified: true,
      synthetic: true,
      secret_set: true,
    });
    // Advertised capability is metadata: unregistered tools are reported, only granted ones count.
    expect(c.capabilities).toMatchObject({
      protocol: 'pm-agent/1',
      advertised: [
        { name: 'pm.tasks.get', version: '1' },
        { name: 'pm.tasks.update', version: '1' },
      ],
      unregistered: [{ name: 'shell.exec', version: '1' }],
      effective: [{ name: 'pm.tasks.get', version: '1' }],
    });
    // The peer received protocol metadata and a nonce only, with the credential as a bearer.
    const got = fx.received().filter((r) => r.peer === 'api-ok');
    expect(got).toHaveLength(1);
    expect(got[0]!.path).toBe('/peer/api-ok/pm-agent/handshake');
    expect(got[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(Object.keys(JSON.parse(got[0]!.body)).sort()).toEqual([
      'issued_at',
      'nonce',
      'protocol',
      'type',
      'versions',
    ]);
    // Readiness reflects a synthetic verification (never a real connector verified).
    expect((await view(a.id)).readiness).toMatchObject({ state: 'ready', synthetic: true });
  });

  it('AT-602 webhook kind: the signing secret is generated and shown once; the answer must be signed with it', async () => {
    const a = await external('Hook agent');
    const req = mutation();
    const first = (
      await env.svc.configureAgentConnector(
        w.owner,
        w.ws,
        a.id,
        { kind: 'webhook', endpoint_url: fx.endpoint('hook-ok') },
        req,
      )
    ).data as Record<string, any>;
    expect(first.signing_secret).toMatch(/^whs_/);
    const replay = await env.svc.configureAgentConnector(
      w.owner,
      w.ws,
      a.id,
      { kind: 'webhook', endpoint_url: fx.endpoint('hook-ok') },
      req,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.data).not.toHaveProperty('signing_secret');
    fx.peer('hook-ok', { kind: 'webhook', secret: first.signing_secret });
    expect(await test(a.id)).toMatchObject({ state: 'passed', synthetic: true });
    // A peer that cannot sign with the secret is refused.
    fx.peer('hook-ok', {
      kind: 'webhook',
      secret: first.signing_secret,
      behaviour: 'bad_signature',
    });
    expect(await test(a.id)).toMatchObject({ state: 'failed', code: 'signature_invalid' });
    expect((await view(a.id)).connector).toMatchObject({
      state: 'configured',
      verified: false,
      last_code: 'signature_invalid',
    });
    // A peer that does not know the secret answers 401: unauthorized, never verified.
    fx.peer('hook-ok', { kind: 'webhook', secret: 'someone-elses-secret-value' });
    expect(await test(a.id)).toMatchObject({ state: 'failed', code: 'unauthorized' });
  });

  it('AT-603 MCP kind: initialize at the agreed protocol version with the manifest in experimental capabilities; another version is refused', async () => {
    fx.peer('mcp-ok', { kind: 'mcp', secret: SECRET });
    const a = await external('MCP agent');
    await connect(a.id, 'mcp', 'mcp-ok');
    expect(await test(a.id)).toMatchObject({ state: 'passed' });
    const body = JSON.parse(
      fx
        .received()
        .filter((r) => r.peer === 'mcp-ok')
        .at(-1)!.body,
    );
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    });
    fx.peer('mcp-ok', { kind: 'mcp', secret: SECRET, behaviour: 'mcp_old_protocol' });
    expect(await test(a.id)).toMatchObject({ state: 'failed', code: 'version_unsupported' });
  });

  it('AT-604 malformed, oversized, redirecting, wrong-version, wrong-nonce, failing, and slow peers fail closed with a bounded code', async () => {
    const a = await external('Hostile peers');
    await connect(a.id, 'api', 'hostile');
    for (const [behaviour, expected] of [
      ['malformed', 'malformed_response'],
      ['huge', 'response_too_large'],
      ['redirect', 'redirect_refused'],
      ['old_version', 'version_unsupported'],
      ['unknown_protocol', 'protocol_unsupported'],
      ['nonce_mismatch', 'nonce_mismatch'],
      ['status_500', 'http_status'],
      ['slow', 'timeout'],
    ] as const) {
      fx.peer('hostile', { kind: 'api', secret: SECRET, behaviour });
      expect({ behaviour, ...(await test(a.id)) }).toMatchObject({
        behaviour,
        state: 'failed',
        code: expected,
      });
    }
    expect((await view(a.id)).readiness.reasons).toContain('connector_not_verified');
  });

  it("AT-605 the endpoint guard refuses private addresses, the product's own endpoints, credentials in URLs, plain http, and the product's own tokens as secrets", async () => {
    const a = await external('Guarded');
    const bad = async (endpoint_url: string, issueCode: string, secret = SECRET) =>
      expect(
        env.svc.configureAgentConnector(
          w.owner,
          w.ws,
          a.id,
          { kind: 'api', endpoint_url, secret },
          mutation(),
        ),
      ).rejects.toEqual(issueOf(issueCode));
    await bad('https://10.0.0.7/agent', 'private_address');
    await bad('https://169.254.169.254/latest', 'private_address');
    await bad('https://pm.example.test/v1/mcp', 'own_endpoint');
    await bad('https://user:pass@agent.example.test/', 'invalid_url');
    await bad('http://agent.example.test/', 'invalid_url');
    await bad(fx.endpoint('x'), 'own_credential', 'pm_abcdefghijklmnopqrstuvwxyz0123456789');
    expect((await view(a.id)).connector).toBeNull();
  });

  it('AT-606 a change before the test runs makes its result stale; rotation and disconnection invalidate readiness; no secret reaches metadata or logs', async () => {
    fx.peer('rotating', { kind: 'api', secret: SECRET });
    const a = await external('Rotating');
    await connect(a.id, 'api', 'rotating');
    expect(await test(a.id)).toMatchObject({ state: 'passed' });
    // Requested, then reconfigured before the worker runs: the old version's result is stale.
    const r = await env.svc.testAgentConnector(w.owner, w.ws, a.id, { confirm: true }, mutation());
    const NEW = 'rotated-credential-abcdef0123456789';
    fx.peer('rotating', { kind: 'api', secret: NEW });
    await connect(a.id, 'api', 'rotating', NEW);
    await settle(db, worker);
    expect(
      await env.svc.getAgentConnectorTest(w.owner, w.ws, a.id, (r.data as { id: string }).id),
    ).toMatchObject({ state: 'stale', code: 'config_changed', current: false });
    expect((await view(a.id)).connector).toMatchObject({
      state: 'configured',
      verified: false,
      config_version: 2,
    });
    expect(await test(a.id)).toMatchObject({ state: 'passed' });
    // Disconnect: the credential is destroyed and the connector revoked; a test is refused.
    const before = (
      await db.admin(
        `SELECT secret_ref FROM agents.agent_connector c JOIN core.record r ON r.id = c.profile_id WHERE r.public_id = $1`,
        [a.id],
      )
    ).rows[0]!.secret_ref as string;
    expect(
      (
        await db.admin(`SELECT count(*)::int AS n FROM ops.dev_secret_vault WHERE ref = $1`, [
          before,
        ])
      ).rows[0]!.n,
    ).toBe(1);
    await env.svc.disconnectAgentConnector(w.owner, w.ws, a.id, mutation());
    expect((await view(a.id)).connector).toMatchObject({
      state: 'revoked',
      secret_set: false,
      verified: false,
    });
    expect(before).toBeTruthy();
    expect(
      (
        await db.admin(`SELECT count(*)::int AS n FROM ops.dev_secret_vault WHERE ref = $1`, [
          before,
        ])
      ).rows[0]!.n,
    ).toBe(0);
    await expect(
      env.svc.testAgentConnector(w.owner, w.ws, a.id, { confirm: true }, mutation()),
    ).rejects.toEqual(issueOf('connector_missing'));
    // Neither credential appears in any connector row, job checkpoint, operation, or log line.
    const meta = (
      await db.admin(
        `SELECT c::text AS t FROM agents.agent_connector c UNION ALL SELECT j::text FROM exec.job j UNION ALL SELECT o::text FROM exec.operation o UNION ALL SELECT t::text FROM agents.agent_connector_test t`,
      )
    ).rows.map((x) => x.t as string);
    for (const s of [SECRET, NEW]) {
      expect(meta.filter((t) => t.includes(s))).toEqual([]);
      expect(env.h.sink.lines.filter((l) => l.includes(s))).toEqual([]);
    }
  });

  it('AT-607 a test needs explicit confirmation, a configurer, and the hourly limit; without the fixture transport it is unavailable', async () => {
    fx.peer('limits', { kind: 'api', secret: SECRET });
    const a = await external('Limits');
    await connect(a.id, 'api', 'limits');
    await expect(env.svc.testAgentConnector(w.owner, w.ws, a.id, {}, mutation())).rejects.toEqual(
      issueOf('confirmation_required'),
    );
    const env2 = workEnv(db, { work: { agentConnectorTestsPerHour: 1 } });
    await expect(
      env2.svc.testAgentConnector(w.owner, w.ws, a.id, { confirm: true }, mutation()),
    ).rejects.toEqual(issueOf('transport_unavailable'));
    const env3 = workEnv(db, {
      agents: { transport: 'fixture', productOrigin: null },
      work: { agentConnectorTestsPerHour: 1 },
    });
    await env3.svc.testAgentConnector(w.owner, w.ws, a.id, { confirm: true }, mutation());
    await expect(
      env3.svc.testAgentConnector(w.owner, w.ws, a.id, { confirm: true }, mutation()),
    ).rejects.toEqual(code('rate_limited'));
    await settle(db, worker);
    await env2.h.close();
    await env3.h.close();
    void v;
  });
});
