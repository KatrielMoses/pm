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
 * 5C HTTP surface (ADR-0030; 0D PL-40): the catalog, one metric, the records behind it, its export,
 * and the reconciliation request. Every response is computed for the caller and never cached; a
 * hidden project and an unknown one are the same answer; no internal identifier appears in a body.
 */
describe('metrics API (5C)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let member: Browser;
  let stranger: Browser;
  let anonymous: Browser;
  let ws: string;
  let brand: string;
  let project: string;
  const bodies: string[] = [];
  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const key = () => ({ 'idempotency-key': idemKey() });
  const base = () => `/v1/workspaces/${ws}`;
  const get = (who: Browser, path: string) => keep(who.get(`${base()}/metrics${path}`) as never);

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('metrics-owner@example.test', '203.0.113.210');
    stranger = await person('metrics-stranger@example.test', '203.0.113.211');
    anonymous = new Browser(env.app);
    anonymous.ip = '203.0.113.212';
    const created = await owner.post(
      '/v1/workspaces',
      { name: 'Metrics', timezone: 'UTC', locale: 'en', currency: 'USD', week_start: 1, first_brand: { name: 'Main' } },
      { headers: key() },
    );
    ws = created.json().data.id;
    brand = created.json().data.first_brand.id;
    const inv = keep(
      await owner.post(`${base()}/invitations`, { email: 'metrics-member@example.test', kind: 'member', role: 'member' }, { headers: key() }),
    );
    expect(inv.statusCode, inv.body).toBe(201);
    await env.deliverMail();
    const token = tokenFrom(mailTo(env, 'metrics-member@example.test', 'invited').at(-1));
    member = await person('metrics-member@example.test', '203.0.113.213');
    expect(keep(await member.post('/v1/invitations:accept', { token }, { headers: key() })).statusCode).toBe(200);
    const p = keep(await owner.post(`${base()}/projects`, { brand, name: 'Gannet' }, { headers: key() }));
    expect(p.statusCode, p.body).toBe(201);
    project = p.json().data.id;
    for (const title of ['One', 'Two', 'Three'])
      expect(keep(await owner.post(`${base()}/tasks`, { project, title, estimate_minutes: 30 }, { headers: key() })).statusCode).toBe(201);
  });
  afterAll(async () => {
    expect(bodies.some((b) => UUID.test(b))).toBe(false);
    await env.close();
  });

  it('lists the definitions with versions, rules, and drill roles, privately and uncached', async () => {
    const r = await get(owner, '');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    const d = r.json().data;
    expect(d.type).toBe('metric_catalog');
    const ids = d.data.map((x: { id: string }) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['project.completion', 'work.cycle_time', 'data.freshness', 'quality.tests']));
    expect(d.data.find((x: { id: string; version: number }) => x.id === 'project.completion' && x.version === 2)).toMatchObject({ current: false });
    expect(d.limits).toMatchObject({ window_days_max: 366, default_window_days: 30 });
  });

  it('computes a figure with its definition, scope, freshness, provenance, limits, and drill-through', async () => {
    const r = await get(owner, `/project.completion?project=${project}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    const m = r.json().data;
    expect(m).toMatchObject({
      type: 'metric_result',
      definition: { id: 'project.completion', version: 1 },
      scope: { kind: 'project', project: { id: project, name: 'Gannet' } },
      state: 'complete',
      parts: { numerator: 0, denominator: 3 },
      freshness: { state: 'current', basis: 'live' },
      provenance: { authorization: 'viewer' },
    });
    expect(m.drill.members).toEqual([
      { role: 'numerator', label: 'Done tasks', count: 0 },
      { role: 'denominator', label: 'Counted tasks', count: 3 },
    ]);
    expect(m.limits.join(' ')).toMatch(/can read/);
    const weighted = (await get(owner, `/project.completion?project=${project}&version=2`)).json().data;
    expect(weighted).toMatchObject({ definition: { version: 2 }, parts: { numerator: 0, denominator: 90 } });
    const t = await get(owner, '/work.cycle_time?from=2026-01-01&to=2026-01-31');
    expect(t.json().data).toMatchObject({ state: 'empty', timezone: 'UTC', window: { from: '2026-01-01', to: '2026-01-31', days: 31 } });
    const u = await get(owner, '/quality.tests');
    expect(u.json().data).toMatchObject({ state: 'unavailable', unavailable: { phase: '9B' } });
  });

  it('lists the records behind a figure, paged, and exports it as CSV', async () => {
    const r = await get(owner, `/project.completion/records?project=${project}&member=denominator&limit=2`);
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json().data;
    expect(d).toMatchObject({ type: 'metric_records', total: 3, member: { role: 'denominator', records: 'task' } });
    expect(d.items.length).toBe(2);
    expect(d.items[0]).toMatchObject({ record: { type: 'task' }, status: { category: 'planned' } });
    const next = await get(owner, `/project.completion/records?project=${project}&member=denominator&limit=2&cursor=${encodeURIComponent(d.page.next_cursor)}`);
    expect(next.json().data.items.length).toBe(1);
    const csv = keep(await owner.get(`${base()}/metrics/project.completion/export?project=${project}`) as never);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('project.completion-v1.csv');
    expect(csv.headers['cache-control']).toBe('private, no-store');
    expect(csv.headers['x-content-type-options']).toBe('nosniff');
    expect(csv.body).toContain('parts.denominator,3');
  });

  it('gives a hidden project, an unknown one, and a stranger the same kind of refusal', async () => {
    const hidden = await get(member, `/project.completion?project=${project}`);
    // The member holds no grant on the brand yet: the project is unavailable, exactly as an unknown one.
    const unknown = await get(member, `/project.completion?project=prj_00000000000000000000000000`);
    expect(hidden.statusCode).toBe(unknown.statusCode);
    expect(JSON.stringify(hidden.json().error.issues)).toBe(JSON.stringify(unknown.json().error.issues));
    expect((await get(member, '/project.completion')).json().data.state).toBe('empty');
    const gone = keep(await stranger.get(`${base()}/metrics/project.completion`));
    const gone2 = keep(await stranger.get(`/v1/workspaces/wsp_00000000000000000000000000/metrics/project.completion`));
    expect(gone.statusCode).toBe(404);
    expect(gone2.statusCode).toBe(404);
    expect((await get(owner, '/nope.nothing')).statusCode).toBe(404);
  });

  it('refuses malformed requests with stable issues and unauthenticated callers with 401', async () => {
    for (const [q, code] of [
      ['/project.completion?version=0', 'invalid_option'],
      ['/project.completion?subprojects=maybe', 'invalid_option'],
      ['/work.cycle_time?from=2026-02-30', 'invalid_date'],
      ['/work.cycle_time?from=2026-03-05&to=2026-03-01', 'order'],
      ['/work.cycle_time?from=2020-01-01&to=2026-03-01', 'too_long'],
      ['/work.planned_vs_completed?as_of=2026-03-15T00:00:00Z', 'not_supported'],
      ['/work.age?as_of=2999-01-01T00:00:00Z', 'invalid_date'],
      ['/project.completion/records?member=nope', 'invalid_option'],
    ] as const) {
      const r = await get(owner, q);
      expect(r.statusCode, q).toBe(422);
      expect(JSON.stringify(r.json()), q).toContain(code);
    }
    const junk = await get(owner, '/project.completion/records?member=numerator&cursor=junk');
    expect(junk.statusCode).toBe(400);
    expect(JSON.stringify(junk.json())).toContain('cursor_invalid');
    expect((await anonymous.get(`${base()}/metrics/project.completion`)).statusCode).toBe(401);
  });

  it('lets only an administrator ask for a reconciliation pass, as a scheduling request that returns at once', async () => {
    const asMember = keep(await member.post(`${base()}/metrics:reconcile`, {}, { headers: key() }));
    expect(asMember.statusCode).toBe(403);
    const r = keep(await owner.post(`${base()}/metrics:reconcile`, {}, { headers: key() }));
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().data).toMatchObject({ type: 'metric_reconcile', requested: true });
    expect(r.headers['cache-control']).toBe('private, no-store');
  });
});
