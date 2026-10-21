import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SYNTHETIC_MODEL = 'fixture/synthetic-messages@2026-10-17';

/**
 * 8B HTTP surface (ADR-0047; 0D PL-54): agent profiles, templates, the tool registry, connectors,
 * and task assignments. Configuration is session-only (the bearer gate refuses tokens on
 * `/agents`); task assignment writes need `agents:execute`; execution is refused until 8C; no
 * internal identifier appears in any body.
 */
describe('agents API (8B)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let member: Browser;
  let guest: Browser;
  let ws: string;
  let brand: string;
  let task: string;
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

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }
  async function invite(
    email: string,
    body: Record<string, unknown>,
    ip: string,
  ): Promise<Browser> {
    const inv = keep(
      await owner.post(`${base()}/invitations`, { email, ...body }, { headers: key() }),
    );
    expect(inv.statusCode, inv.body).toBe(201);
    await env.deliverMail();
    const token = tokenFrom(mailTo(env, email, 'invited').at(-1));
    const who = await person(email, ip);
    const accepted = keep(await who.post('/v1/invitations:accept', { token }, { headers: key() }));
    expect(accepted.statusCode, accepted.body).toBe(200);
    return who;
  }
  async function token(scopes: string[]): Promise<string> {
    const headers = key();
    const body = { name: `Agents ${scopes.join(' ')}`, kind: 'personal', scopes };
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
  }
  const bearer = async (secret: string, method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await env.app.inject({
      method,
      url: `${base()}${url}`,
      headers: { authorization: `Bearer ${secret}`, ...(method === 'POST' ? key() : {}) },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    bodies.push(res.body);
    return res;
  };

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('agent-owner@example.test', '203.0.113.220');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Agents',
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
    task = (await post(owner, '/tasks', { brand, title: 'Write launch notes' })).json().data.id;
    member = await invite(
      'agent-member@example.test',
      { kind: 'member', role: 'member' },
      '203.0.113.221',
    );
    guest = await invite(
      'agent-guest@example.test',
      { kind: 'guest', records: [{ record: task, level: 'comment' }] },
      '203.0.113.222',
    );
  });
  afterAll(async () => {
    expect(bodies.some((b) => UUID.test(b))).toBe(false);
    await env.close();
  });

  let internal: { id: string; version: number };

  it('AT-625 templates and the registry, create from a template, edit with If-Match, activate an internal profile, and its readiness is truthful', async () => {
    const templates = await get(owner, '/agent-templates');
    expect(templates.statusCode, templates.body).toBe(200);
    expect(templates.json().data.type).toBe('agent_templates');
    expect(templates.json().data.data.map((t: { key: string }) => t.key)).toEqual([
      'development',
      'research',
      'growth',
      'documentation',
      'testing',
    ]);
    const tools = await get(owner, '/agent-tools');
    expect(
      tools.json().data.data.find((t: { name: string }) => t.name === 'pm.tests.run'),
    ).toMatchObject({
      status: 'unavailable',
      owner: '9B',
    });
    expect(tools.json().data.models.some((m: { key: string }) => m.key === SYNTHETIC_MODEL)).toBe(
      true,
    );
    const made = await post(owner, '/agents', { template: 'research', name: 'Researcher' });
    expect(made.statusCode, made.body).toBe(201);
    const a = made.json().data;
    expect(a).toMatchObject({
      type: 'agent_profile',
      kind: 'internal',
      state: 'draft',
      template: 'research',
      draft_status: { valid: true, missing: ['scope', 'model'] },
      execution: { available: true, owner: '8C' },
    });
    expect(a.id).toMatch(/^agt_/);
    expect(made.headers.etag).toBe(`"${a.version}"`);
    // Missing scope and model: activation refuses.
    const incomplete = await post(
      owner,
      `/agents/${a.id}:activate`,
      {},
      { 'if-match': `"${a.version}"` },
    );
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json().error.issues.map((i: { code: string }) => i.code)).toContain(
      'configuration_incomplete',
    );
    const stale = await patch(owner, `/agents/${a.id}`, { name: 'x' }, { 'if-match': '"99"' });
    expect(stale.statusCode).toBe(409);
    const edited = await patch(
      owner,
      `/agents/${a.id}`,
      { draft: { ...a.draft, model_key: SYNTHETIC_MODEL, scope: { brands: [brand] } } },
      { 'if-match': `"${a.version}"` },
    );
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().data.draft_status.missing).toEqual([]);
    const on = await post(
      owner,
      `/agents/${a.id}:activate`,
      {},
      { 'if-match': `"${edited.json().data.version}"` },
    );
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().data).toMatchObject({ state: 'active', active_revision: { revision: 1 } });
    expect(on.json().data.active_revision.scope.items).toEqual([
      { kind: 'brand', id: brand, name: 'Main' },
    ]);
    // AI is not configured for this workspace: the profile is on, and says it is not ready.
    expect(on.json().data.readiness.state).toBe('not_ready');
    expect(on.json().data.readiness.reasons.some((r: string) => r.startsWith('model_'))).toBe(true);
    internal = on.json().data;
    const list = await get(owner, '/agents');
    expect(list.json().data.map((x: { id: string }) => x.id)).toContain(a.id);
    expect(list.json().capabilities).toEqual({ create: true });
  });

  it('AT-626 refusals are uniform: members without the policy, guests, unknown ids and verbs; members see summaries only', async () => {
    expect((await post(member, '/agents', { kind: 'internal', name: 'Mine' })).statusCode).toBe(
      403,
    );
    const seen = await get(member, `/agents/${internal.id}`);
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json().data.draft).toBeUndefined();
    expect(seen.json().data.connector).toBeUndefined();
    expect(
      (await patch(member, `/agents/${internal.id}`, { name: 'x' }, { 'if-match': '"1"' }))
        .statusCode,
    ).toBe(403);
    for (const path of ['/agents', `/agents/${internal.id}`, '/agent-templates', '/agent-tools'])
      expect((await get(guest, path)).statusCode, path).toBe(404);
    expect((await get(owner, '/agents/agt_01HZZZZZZZZZZZZZZZZZZZZZZZ')).statusCode).toBe(404);
    expect((await post(owner, `/agents/${internal.id}:explode`, {})).statusCode).toBe(404);
    expect((await post(owner, `/agents/${internal.id}/elsewhere`, {})).statusCode).toBe(404);
    const unknown = await post(owner, '/agents', { kind: 'internal', name: 'X', run: 'rm -rf /' });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error.issues[0]).toMatchObject({
      pointer: '/run',
      code: 'unknown_field',
    });
  });

  it('AT-627 an external connector: guarded endpoints, the shown-once webhook secret, and tests refused without a transport', async () => {
    const ext = (await post(owner, '/agents', { kind: 'external', name: 'Connected' })).json().data;
    for (const [url, code] of [
      ['https://10.0.0.5/agent', 'private_address'],
      ['https://169.254.169.254/latest', 'private_address'],
      ['http://93.184.215.14/agent', 'invalid_url'],
      ['https://u:p@93.184.215.14/agent', 'invalid_url'],
    ] as const) {
      const r = await post(owner, `/agents/${ext.id}/connector`, {
        kind: 'api',
        endpoint_url: url,
      });
      expect(r.statusCode, url).toBe(422);
      expect(r.json().error.issues[0].code).toBe(code);
    }
    const own = await post(owner, `/agents/${ext.id}/connector`, {
      kind: 'mcp',
      endpoint_url: 'https://93.184.215.14/agent',
      secret: 'pm_this_is_a_product_token_123',
    });
    expect(own.statusCode).toBe(422);
    const hook = await post(owner, `/agents/${ext.id}/connector`, {
      kind: 'webhook',
      endpoint_url: 'https://93.184.215.14/agent',
    });
    expect(hook.statusCode, hook.body).toBe(200);
    expect(hook.json().data.signing_secret).toMatch(/^whs_/);
    expect(hook.json().data.connector).toMatchObject({
      kind: 'webhook',
      state: 'configured',
      transport: 'unavailable',
    });
    const again = await get(owner, `/agents/${ext.id}`);
    expect(again.json().data.signing_secret).toBeUndefined();
    expect(again.body).not.toContain(hook.json().data.signing_secret);
    // A test must be confirmed, and with no transport configured it is refused, sending nothing.
    expect((await post(owner, `/agents/${ext.id}/connector:test`, {})).statusCode).toBe(422);
    const t = await post(owner, `/agents/${ext.id}/connector:test`, { confirm: true });
    expect(t.statusCode, t.body).toBe(503);
    expect(t.json().error.code).toBe('dependency_unavailable');
    const off = await post(owner, `/agents/${ext.id}/connector:disconnect`, {});
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().data.connector.state).toBe('revoked');
  });

  it('AT-628 task assignment: preview, assign, edit, withdraw; agents are separate from assignees; execution refused until 8C', async () => {
    const preview = await post(owner, `/tasks/${task}/agent-preview`, {
      profile: internal.id,
      goal: 'Summarize.',
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().data).toMatchObject({
      type: 'agent_assignment_preview',
      refusals: [],
      can_save: true,
    });
    const made = await post(owner, `/tasks/${task}/agents`, {
      profile: internal.id,
      goal: 'Summarize.',
      criteria: ['Cites sources'],
    });
    expect(made.statusCode, made.body).toBe(201);
    const a = made.json().data.assignment;
    expect(a).toMatchObject({
      id: `${task}:${internal.id}`,
      revision: 1,
      criteria: ['Cites sources'],
    });
    const t = (await get(owner, `/tasks/${task}`)).json().data;
    expect(JSON.stringify(t.assignees ?? [])).not.toContain(internal.id);
    const dup = await post(owner, `/tasks/${task}/agents`, {
      profile: internal.id,
      goal: 'Again.',
    });
    expect(dup.statusCode).toBe(409);
    const revised = await patch(
      owner,
      `/tasks/${task}/agents/${internal.id}`,
      { goal: 'Summarize briefly.' },
      {
        'if-match': `"${a.version}"`,
      },
    );
    expect(revised.statusCode, revised.body).toBe(200);
    expect(revised.json().data.assignment.revision).toBe(2);
    // 8C: runs exist; this internal agent is not ready (AI is not configured), so starting a run
    // is refused truthfully and nothing is admitted.
    const run = await post(owner, `/tasks/${task}/agents/${internal.id}:run`, {});
    expect(run.statusCode).toBe(409);
    expect(run.json().error.code).toBe('conflict');
    const listed = await get(guest, `/tasks/${task}/agents`);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data.capabilities.assign).toBe(false);
    expect(
      (await post(guest, `/tasks/${task}/agents/${internal.id}:withdraw`, {})).statusCode,
    ).toBe(403);
    const gone = await post(owner, `/tasks/${task}/agents/${internal.id}:withdraw`, {});
    expect(gone.statusCode, gone.body).toBe(200);
    expect(gone.json().data.assignment.state).toBe('withdrawn');
  });

  it('AT-629 tokens: profiles are session-only for every scope; task assignment writes need agents:execute', async () => {
    const plain = await token(['records:read', 'records:write']);
    const agentTok = await token(['records:read', 'agents:execute']);
    for (const secret of [plain, agentTok]) {
      for (const path of ['/agents', `/agents/${internal.id}`, '/agent-templates', '/agent-tools'])
        expect((await bearer(secret, 'GET', path)).statusCode, path).toBe(403);
      expect(
        (await bearer(secret, 'POST', '/agents', { kind: 'internal', name: 'Tok' })).statusCode,
      ).toBe(403);
      expect((await bearer(secret, 'POST', `/agents/${internal.id}:activate`, {})).statusCode).toBe(
        403,
      );
    }
    const refused = await bearer(plain, 'POST', `/tasks/${task}/agents`, {
      profile: internal.id,
      goal: 'By token.',
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).not.toContain(internal.id);
    const ok = await bearer(agentTok, 'POST', `/tasks/${task}/agents`, {
      profile: internal.id,
      goal: 'By token.',
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const read = await bearer(plain, 'GET', `/tasks/${task}/agents`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().data.items.some((x: { goal: string }) => x.goal === 'By token.')).toBe(true);
  });

  const change = async (c: Record<string, unknown>) => {
    const preview = await owner.post(`${base()}/access:preview`, { change: c });
    expect(preview.statusCode, preview.body).toBe(200);
    const body = { change: c, preview_token: preview.json().data.preview_token };
    const headers = key();
    let res = await owner.post(`${base()}/access:apply`, body, { headers });
    if (res.statusCode === 403 && res.json().error.code === 'step_up_required') {
      const sv = await owner.post(`/v1/auth/step-up/${res.json().error.step_up.id}:verify`, {
        method: 'password',
        proof: PASSWORD,
      });
      res = await owner.post(`${base()}/access:apply`, body, {
        headers: { ...headers, 'step-up': sv.json().data.token },
      });
    }
    expect(res.statusCode, res.body).toBe(200);
  };
  const activeInternal = async (name: string, scope: Record<string, string[]>) => {
    const made = (await post(owner, '/agents', { template: 'research', name })).json().data;
    const edited = await patch(
      owner,
      `/agents/${made.id}`,
      { draft: { ...made.draft, model_key: SYNTHETIC_MODEL, scope } },
      { 'if-match': `"${made.version}"` },
    );
    const on = await post(
      owner,
      `/agents/${made.id}:activate`,
      {},
      {
        'if-match': `"${edited.json().data.version}"`,
      },
    );
    expect(on.statusCode, on.body).toBe(200);
    return made.id as string;
  };

  it('AT-640 R1 over HTTP: a share-only reader cannot tell assignments apart by hidden scope; no count or profile fact reaches them', async () => {
    const other = (await post(owner, '/brands', { name: 'Other' })).json().data.id as string;
    const hidden = (await post(owner, '/projects', { brand: other, name: 'Hidden project' })).json()
      .data.id as string;
    const a0 = await activeInternal('Equivalent zero', { brands: [brand, other] });
    const a1 = await activeInternal('Equivalent one', { brands: [brand, other] });
    for (const [agt, projects] of [
      [a0, []],
      [a1, [hidden]],
    ] as const) {
      const r = await post(owner, `/tasks/${task}/agents`, {
        profile: agt,
        goal: 'Same brief.',
        scope: { records: [task], projects },
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    const res = await get(guest, `/tasks/${task}/agents`);
    expect(res.statusCode, res.body).toBe(200);
    const pick = (agt: string) => {
      const x = res
        .json()
        .data.items.find((i: { profile: { id: string } }) => i.profile.id === agt);
      const { id: _i, profile: _p, version: _v, assigned_at: _a, ...rest } = x;
      return JSON.stringify(rest);
    };
    expect(pick(a1)).toBe(pick(a0));
    expect(res.body).not.toMatch(/not_shown/);
    expect(res.body).not.toContain(hidden);
    expect(res.body).not.toMatch(/model_|connector_|owner_/);
    // The owner, who can open everything selected, sees the hidden project by name.
    const all = await get(owner, `/tasks/${task}/agents`);
    expect(all.body).toContain('Hidden project');
  });

  it('AT-641 R2 over HTTP: when the assigner is downgraded to view, every reader sees the assignment blocked and the assigner can no longer assign', async () => {
    const memberId = (await owner.get(`${base()}/people`))
      .json()
      .data.find((x: { role: string }) => x.role === 'member').id as string;
    await change({ kind: 'brand_grant', brand, principal: memberId, level: 'edit' });
    const agt = await activeInternal('Downgrade', { brands: [brand] });
    const spare = await activeInternal('Spare', { brands: [brand] });
    const made = await post(member, `/tasks/${task}/agents`, {
      profile: agt,
      goal: 'By the member.',
    });
    expect(made.statusCode, made.body).toBe(201);
    const reasons = async (who: Browser) =>
      (await get(who, `/tasks/${task}/agents`))
        .json()
        .data.items.find((i: { profile: { id: string } }) => i.profile.id === agt) as {
        state: string;
        blocked_reasons: string[];
      };
    expect((await reasons(owner)).blocked_reasons).not.toContain('assigner_authority');
    await change({ kind: 'brand_revoke', brand, principal: memberId });
    await change({ kind: 'brand_grant', brand, principal: memberId, level: 'view' });
    const byOwner = await reasons(owner);
    expect(byOwner.state).toBe('blocked');
    expect(byOwner.blocked_reasons).toContain('assigner_authority');
    const byGuest = await reasons(guest);
    expect(byGuest.state).toBe('blocked');
    expect(byGuest.blocked_reasons).toContain('assigner_authority');
    for (const r of byGuest.blocked_reasons)
      expect([
        'agent_not_ready',
        'assigner_authority',
        'assigner_unavailable',
        'task_ineligible',
        'scope_lost',
      ]).toContain(r);
    expect(
      (await post(member, `/tasks/${task}/agents`, { profile: spare, goal: 'Again.' })).statusCode,
    ).toBe(403);
  });
});
