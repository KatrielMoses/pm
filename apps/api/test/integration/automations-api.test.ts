import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  Browser,
  idemKey,
  identityEnv,
  mailTo,
  registerAndVerify,
  signIn,
  tokenFrom,
  type IdentityEnv,
} from './identity-helpers.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * 8A HTTP surface (ADR-0046; 0D PL-53): automations, revisions, preview, activation, manual runs,
 * run history, retry and cancel, templates, usage, and health. Every request is the session's
 * member deciding now; drafts edit with If-Match; unknown and hidden are one answer; no internal
 * identifier appears in any body.
 */
describe('automations API (8A)', () => {
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
  const post = async (who: Browser, path: string, body: unknown, headers: Record<string, string> = {}) =>
    keep(await who.post(`${base()}${path}`, body, { headers: key(headers) }));
  const patch = async (who: Browser, path: string, body: unknown, headers: Record<string, string> = {}) =>
    keep(await who.patch(`${base()}${path}`, body, { headers: key(headers) }));
  const get = async (who: Browser, path: string) => keep(await who.get(`${base()}${path}`));

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }
  async function invite(email: string, body: Record<string, unknown>, ip: string): Promise<Browser> {
    const inv = keep(await owner.post(`${base()}/invitations`, { email, ...body }, { headers: key() }));
    expect(inv.statusCode, inv.body).toBe(201);
    await env.deliverMail();
    const token = tokenFrom(mailTo(env, email, 'invited').at(-1));
    const who = await person(email, ip);
    const accepted = keep(await who.post('/v1/invitations:accept', { token }, { headers: key() }));
    expect(accepted.statusCode, accepted.body).toBe(200);
    return who;
  }

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('auto-owner@example.test', '203.0.113.210');
    const created = await owner.post(
      '/v1/workspaces',
      { name: 'Automations', timezone: 'UTC', locale: 'en', currency: 'USD', week_start: 1, first_brand: { name: 'Main' } },
      { headers: key() },
    );
    ws = created.json().data.id;
    brand = created.json().data.first_brand.id;
    task = (await post(owner, '/tasks', { brand, title: 'Sample' })).json().data.id;
    member = await invite('auto-member@example.test', { kind: 'member', role: 'member' }, '203.0.113.211');
    guest = await invite('auto-guest@example.test', { kind: 'guest', records: [{ record: task, level: 'comment' }] }, '203.0.113.212');
  });
  afterAll(async () => {
    expect(bodies.some((b) => UUID.test(b))).toBe(false);
    await env.close();
  });

  it('AT-578 create from a template, edit the draft with If-Match, preview, activate, version, duplicate, disable', async () => {
    const templates = await get(owner, '/automation-templates');
    expect(templates.statusCode, templates.body).toBe(200);
    expect(templates.json().data.data.map((t: { key: string }) => t.key)).toContain('label_new_tasks');
    const made = await post(owner, '/automations', {
      name: 'Escalate',
      scope: { kind: 'brand', brand },
      template: 'escalate_overdue',
      template_values: { timezone: 'Europe/London' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const a = made.json().data;
    expect(a).toMatchObject({ type: 'automation', state: 'disabled', template: 'escalate_overdue', draft_status: { valid: true } });
    expect(made.headers.etag).toBe(`"${a.version}"`);
    // Drafts change only with the version the client saw.
    const stale = await patch(owner, `/automations/${a.id}`, { name: 'x' }, { 'if-match': '"99"' });
    expect(stale.statusCode).toBe(409);
    const definition = {
      schema_version: 1,
      trigger: { kind: 'record.created', record: 'task' },
      conditions: null,
      steps: [{ id: 'up', type: 'action', action: 'task.update', params: { fields: { priority: 'high' } } }],
    };
    const edited = await patch(owner, `/automations/${a.id}`, { definition }, { 'if-match': `"${a.version}"` });
    expect(edited.statusCode, edited.body).toBe(200);
    const preview = await post(owner, `/automations/${a.id}:preview`, { record: task });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().data).toMatchObject({ type: 'automation_preview', valid: true, steps: [{ node: 'up', outcome: 'would_run' }] });
    const v1 = edited.json().data.version;
    const act = await post(owner, `/automations/${a.id}:activate`, {}, { 'if-match': `"${v1}"` });
    expect(act.statusCode, act.body).toBe(200);
    expect(act.json().data).toMatchObject({ state: 'active', active_revision: 1 });
    const revisions = await get(owner, `/automations/${a.id}/revisions`);
    expect(revisions.json().data.data).toEqual([expect.objectContaining({ revision: 1, active: true, actions: ['task.update'] })]);
    const dup = await post(owner, `/automations/${a.id}:duplicate`, {});
    expect(dup.statusCode, dup.body).toBe(201);
    expect(dup.json().data).toMatchObject({ name: 'Copy of Escalate', state: 'disabled', active_revision: null });
    const run = await post(owner, `/automations/${a.id}:run`, { record: task });
    expect(run.statusCode, run.body).toBe(202);
    expect(run.json().data).toMatchObject({ type: 'automation_run', run: { type: 'automation_run', status: 'queued', trigger: { kind: 'manual', record: { id: task, type: 'task' } } } });
    const runId = run.json().data.run.id as string;
    const runs = await get(owner, `/automations/${a.id}/runs`);
    expect(runs.json().data.map((r: { id: string }) => r.id)).toContain(runId);
    expect((await get(owner, `/automation-runs/${runId}`)).json().data.run).toMatchObject({ id: runId, automation: { id: a.id } });
    const cancel = await post(owner, `/automation-runs/${runId}:cancel`, {});
    expect(cancel.statusCode, cancel.body).toBe(202);
    expect(cancel.json().data.run).toMatchObject({ status: 'cancelled' });
    const off = await post(owner, `/automations/${a.id}:disable`, {});
    expect(off.json().data).toMatchObject({ state: 'disabled', enabled: false });
    expect((await get(owner, '/automation-usage')).json().data).toMatchObject({ type: 'automation_usage', plan_entitlement: { status: 'unavailable' } });
    expect((await get(owner, '/automation-health')).json().data).toMatchObject({ type: 'automation_health', window_days: 30 });
  });

  it('AT-579 refusals are uniform: members without authority, guests, unknown ids, and unsupported configuration', async () => {
    const list = (await get(owner, '/automations')).json().data as Array<{ id: string }>;
    const id = list[0]!.id;
    for (const who of [member, guest]) {
      expect((await get(who, `/automations/${id}`)).statusCode).toBe(404);
      expect((await get(who, `/automations/auto_01HZZZZZZZZZZZZZZZZZZZZZZZ`)).statusCode).toBe(404);
      expect((await post(who, `/automations/${id}:run`, { record: task })).statusCode).toBe(404);
    }
    expect((await get(guest, '/automations')).statusCode).toBe(404);
    const bad = await post(owner, '/automations', {
      name: 'Bad',
      scope: { kind: 'brand', brand },
      definition: { schema_version: 1, trigger: { kind: 'record.created', record: 'task' }, steps: [{ id: 'x', type: 'action', action: 'http.request', params: { url: 'https://example.test' } }] },
    });
    expect(bad.statusCode, bad.body).toBe(201);
    expect(bad.json().data.draft_status).toMatchObject({ valid: false, issues: [expect.objectContaining({ code: 'invalid_option' })] });
    const refused = await post(owner, `/automations/${bad.json().data.id}:activate`, {}, { 'if-match': `"${bad.json().data.version}"` });
    expect(refused.statusCode).toBe(422);
    expect((await post(owner, `/automations/${id}:explode`, {})).statusCode).toBe(404);
  });
});
