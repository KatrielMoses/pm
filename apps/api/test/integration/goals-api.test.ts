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
const Q4 = { kind: 'quarter', year: 2026, index: 4 };

/**
 * 5B HTTP surface (ADR-0028; 0D PL-38): goals, key results, links, check-ins, and portfolios.
 * Every request re-checks the record's level, strangers and guests see the documented answers,
 * linked-work figures are computed for the caller, and no internal identifier appears in any body.
 */
describe('goals and portfolios API (5B)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let editor: Browser;
  let reader: Browser;
  let stranger: Browser;
  let guest: Browser;
  let ws: string;
  let brand: string;
  let summit: string;
  const ids: Record<string, string> = {};
  const bodies: string[] = [];
  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const key = (extra: Record<string, string> = {}) => ({ 'idempotency-key': idemKey(), ...extra });
  const base = () => `/v1/workspaces/${ws}`;

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
  const post = async (
    who: Browser,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => keep(await who.post(`${base()}${path}`, body, { headers: key(headers) }));

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('goals-owner@example.test', '203.0.113.190');
    stranger = await person('goals-stranger@example.test', '203.0.113.191');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Goals',
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
    summit = (await post(owner, '/brands', { name: 'Summit' })).json().data.id;
    editor = await invite(
      'goals-editor@example.test',
      { kind: 'member', role: 'member' },
      '203.0.113.192',
    );
    reader = await invite(
      'goals-reader@example.test',
      { kind: 'member', role: 'read_only' },
      '203.0.113.193',
    );
    ids.project = (await post(owner, '/projects', { brand, name: 'Launch' })).json().data.id;
    ids.summitProject = (
      await post(owner, '/projects', { brand: summit, name: 'Secret site' })
    ).json().data.id;
    ids.task = (
      await post(owner, '/tasks', { brand, title: 'Ship it', project: ids.project })
    ).json().data.id;
    ids.task2 = (
      await post(owner, '/tasks', { brand, title: 'Test it', project: ids.project })
    ).json().data.id;
    ids.summitTask = (
      await post(owner, '/tasks', { brand: summit, title: 'Hidden', project: ids.summitProject })
    ).json().data.id;
    guest = await invite(
      'goals-guest@example.test',
      { kind: 'guest', records: [{ record: ids.task, level: 'comment' }] },
      '203.0.113.194',
    );
  });
  afterAll(async () => {
    expect(bodies.some((b) => UUID.test(b))).toBe(false);
    await env.close();
  });

  it('creates, reads, and edits a goal with ETags, idempotency, and validation errors', async () => {
    const created = await post(owner, '/goals', {
      title: 'Grow',
      period: Q4,
      brand,
      metric: { unit: 'users', baseline: 0, target: 100 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const g = created.json().data;
    ids.goal = g.id;
    expect(g).toMatchObject({
      type: 'goal',
      title: 'Grow',
      status: 'active',
      version: 0,
      scope: { kind: 'brand' },
    });
    expect(created.headers.etag).toBe('"0"');
    const same = keep(
      await owner.post(
        `${base()}/goals`,
        { title: 'Grow', period: Q4, brand },
        { headers: { 'idempotency-key': 'goal-create-key-0001' } },
      ),
    );
    const replay = keep(
      await owner.post(
        `${base()}/goals`,
        { title: 'Grow', period: Q4, brand },
        { headers: { 'idempotency-key': 'goal-create-key-0001' } },
      ),
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().data.id).toBe(same.json().data.id);
    const read = keep(await owner.get(`${base()}/goals/${g.id}`));
    expect(read.statusCode).toBe(200);
    expect(read.json().data.progress).toMatchObject({
      percent: null,
      source: 'metric',
      incomplete: ['no_measurement'],
    });
    const patched = keep(
      await owner.patch(
        `${base()}/goals/${g.id}`,
        { title: 'Grow faster' },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.headers.etag).toBe('"1"');
    const stale = keep(
      await owner.patch(
        `${base()}/goals/${g.id}`,
        { title: 'Late' },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(stale.statusCode).toBe(409);
    const missing = keep(
      await owner.patch(
        `${base()}/goals/${g.id}`,
        { title: 'No precondition' },
        { headers: key() },
      ),
    );
    expect(missing.statusCode).toBe(428);
    const bad = await post(owner, '/goals', {
      title: 'x',
      period: { kind: 'quarter', year: 2026, index: 9 },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors?.[0] ?? bad.json().error?.issues?.[0] ?? bad.body).toBeTruthy();
    const unkeyed = keep(await owner.post(`${base()}/goals`, { title: 'x', period: Q4 }));
    expect(unkeyed.statusCode, unkeyed.body).toBeGreaterThanOrEqual(400);
    expect(unkeyed.statusCode).toBeLessThan(500);
  });

  it('records check-ins and lists the append-only history with a cursor', async () => {
    const c = await post(owner, `/goals/${ids.goal}/check-ins`, {
      value: 40,
      confidence: 'at_risk',
      note: 'Behind plan',
    });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().data).toMatchObject({
      type: 'goal_checkin',
      source: 'manual',
      value: 40,
      progress_percent: 40,
      confidence: 'at_risk',
    });
    expect(c.json().data.id).toMatch(/^gci_/);
    for (let i = 0; i < 3; i++)
      await post(owner, `/goals/${ids.goal}/check-ins`, { value: 41 + i });
    const first = keep(await owner.get(`${base()}/goals/${ids.goal}/check-ins?limit=2`));
    expect(first.json().data).toHaveLength(2);
    expect(first.json().page).toMatchObject({ has_more: true, limit: 2 });
    const next = keep(
      await owner.get(
        `${base()}/goals/${ids.goal}/check-ins?limit=2&cursor=${first.json().page.next_cursor}`,
      ),
    );
    expect(next.json().data).toHaveLength(2);
    const goal = keep(await owner.get(`${base()}/goals/${ids.goal}`));
    expect(goal.json().data).toMatchObject({
      progress: { percent: 43 },
      latest: { confidence: 'at_risk' },
    });
  });

  it('manages key results, links, and linked-work progress through the verbs', async () => {
    const kr = await post(owner, `/goals/${ids.goal}/key-results`, {
      title: 'Signups',
      basis: 'linked_work',
    });
    expect(kr.statusCode, kr.body).toBe(201);
    expect(kr.json().data).toMatchObject({ type: 'key_result', basis: 'linked_work' });
    ids.kr = kr.json().data.id;
    const link = await post(owner, `/goals/${ids.goal}/links`, {
      target: ids.project,
      key_result: ids.kr,
    });
    expect(link.statusCode, link.body).toBe(201);
    expect(link.json().data.links).toEqual([
      expect.objectContaining({
        key_result: ids.kr,
        target: expect.objectContaining({ id: ids.project, name: 'Launch' }),
      }),
    ]);
    // A brand goal refuses another brand's work with the same answer as unreadable work.
    const wrongScope = await post(owner, `/goals/${ids.goal}/links`, { target: ids.summitProject });
    expect(wrongScope.statusCode).toBe(422);
    const done = keep(await owner.get(`${base()}/tasks/${ids.task}`));
    const complete = await post(
      owner,
      `/tasks/${ids.task}:complete`,
      {},
      { 'if-match': `"${done.json().data.version}"` },
    );
    expect(complete.statusCode, complete.body).toBe(200);
    const view = keep(await owner.get(`${base()}/goals/${ids.goal}`)).json().data;
    expect(view.key_results[0].progress).toMatchObject({
      source: 'linked_work',
      work: { done: 1, total: 2 },
      percent: 50,
    });
    const removed = keep(
      await owner.delete(
        `${base()}/goals/${ids.goal}/links?target=${ids.project}&key_result=${ids.kr}`,
        { headers: key() },
      ),
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().data.links).toEqual([]);
    const arch = await post(owner, `/goals/${ids.goal}/key-results/${ids.kr}:archive`, {});
    expect(arch.json().data.lifecycle_state).toBe('archived');
    expect(
      (await post(owner, `/goals/${ids.goal}/key-results/${ids.kr}:explode`, {})).statusCode,
    ).toBe(404);
  });

  it('answers strangers, readers, and guests as documented, and never lists what it hides', async () => {
    const hidden = await post(owner, '/goals', { title: 'Summit only', period: Q4, brand: summit });
    ids.summitGoal = hidden.json().data.id;
    expect(keep(await stranger.get(`${base()}/goals/${ids.goal}`)).statusCode).toBe(404);
    // The editor holds no grant on Summit, so its goal is simply not there for them.
    expect(keep(await editor.get(`${base()}/goals/${ids.summitGoal}`)).statusCode).toBe(404);
    expect(keep(await editor.get(`${base()}/goals?brand=${summit}`)).json().data).toEqual([]);
    // Guests have no goals at all.
    expect(keep(await guest.get(`${base()}/goals`)).statusCode).toBe(403);
    expect(keep(await guest.get(`${base()}/goals/${ids.goal}`)).statusCode).toBe(404);
    expect(keep(await guest.get(`${base()}/portfolio/overview`)).statusCode).toBe(403);
    // Workspace-level goals are readable by members (OD-06); a reader reads one and cannot write.
    ids.wsGoal = (
      await post(owner, '/goals', { title: 'Company goal', period: Q4 })
    ).json().data.id;
    expect(keep(await reader.get(`${base()}/goals/${ids.wsGoal}`)).statusCode).toBe(200);
    expect(keep(await reader.get(`${base()}/goals/${ids.goal}`)).statusCode).toBe(404); // a brand goal needs brand access
    expect((await post(reader, `/goals/${ids.wsGoal}/check-ins`, { percent: 1 })).statusCode).toBe(
      403,
    );
    expect((await post(reader, '/goals', { title: 'x', period: Q4 })).statusCode).toBe(403);
    // Unknown identifiers and verbs are the same 404.
    expect(
      keep(await owner.get(`${base()}/goals/goal_01HZZZZZZZZZZZZZZZZZZZZZZZ`)).statusCode,
    ).toBe(404);
    expect((await post(owner, `/goals/${ids.goal}:explode`, {})).statusCode).toBe(404);
    expect(keep(await owner.get(`${base()}/goals?status=great`)).statusCode).toBe(422);
  });

  it('serves portfolios, health, dependencies, orphans, and exports', async () => {
    const pf = await post(owner, '/portfolios', { name: 'Everything', brand });
    expect(pf.statusCode, pf.body).toBe(201);
    ids.portfolio = pf.json().data.id;
    const set = keep(
      await owner.put(
        `${base()}/portfolios/${ids.portfolio}/projects`,
        { projects: [ids.project], version: 0 },
        { headers: key() },
      ),
    );
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().data).toMatchObject({ projects: [ids.project], projects_count: 1 });
    const overview = keep(await owner.get(`${base()}/portfolios/${ids.portfolio}/overview`));
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.headers['cache-control']).toMatch(/no-store/);
    expect(overview.json().data).toMatchObject({
      type: 'portfolio_overview',
      computed: 'live',
      summary: { projects: 1 },
      coverage: { truncated: false },
    });
    expect(overview.json().data.data[0]).toMatchObject({
      name: 'Launch',
      progress: { done: 1, total: 2, percent: 50 },
    });
    const all = keep(await owner.get(`${base()}/portfolio/overview`));
    expect(all.json().data.summary.projects).toBe(2);
    const dep = keep(await owner.get(`${base()}/portfolio/dependencies`));
    expect(dep.json().data).toMatchObject({ type: 'portfolio_dependencies', data: [] });
    const orphans = keep(await owner.get(`${base()}/portfolio/orphans`));
    expect(orphans.json().data).toMatchObject({
      type: 'portfolio_orphans',
      coverage: { relative_to: 'viewer' },
    });
    expect(orphans.json().data.projects.data.map((p: { name: string }) => p.name)).toContain(
      'Secret site',
    );
    const csv = keep(await owner.get(`${base()}/portfolio/export`));
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(
      /attachment; filename="portfolio-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(csv.headers['x-content-type-options']).toBe('nosniff');
    const goalsCsv = keep(await owner.get(`${base()}/goals/export?brand=${brand}`));
    expect(goalsCsv.headers['content-type']).toMatch(/text\/csv/);
    expect(goalsCsv.body).toContain('Grow faster');
    expect(keep(await owner.get(`${base()}/goals/export?format=xml`)).statusCode).toBe(422);
    // A stranger sees nothing of any of it.
    expect(keep(await stranger.get(`${base()}/portfolios/${ids.portfolio}`)).statusCode).toBe(404);
    expect(keep(await stranger.get(`${base()}/portfolio/overview`)).statusCode).toBe(404);
  });

  it("archives, restores, and recalculates a goal and lists a project's goals", async () => {
    const list = keep(await owner.get(`${base()}/projects/${ids.project}/goals`));
    expect(list.statusCode, list.body).toBe(200);
    const r = await post(owner, `/goals/${ids.goal}:recalculate`, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data.freshness.recalculation.state).toBe('current');
    expect((await post(owner, `/goals/${ids.goal}:archive`, {})).json().data.lifecycle_state).toBe(
      'archived',
    );
    expect(keep(await owner.get(`${base()}/goals?q=Grow%20faster`)).json().data).toEqual([]);
    expect(
      (await post(owner, `/goals/${ids.goal}:unarchive`, {})).json().data.lifecycle_state,
    ).toBe('active');
  });
});
