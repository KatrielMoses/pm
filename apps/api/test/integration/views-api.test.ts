import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractErrors } from '@pm/test-support';
import {
  Browser,
  idemKey,
  identityEnv,
  registerAndVerify,
  signIn,
  type IdentityEnv,
} from './identity-helpers.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * 3A HTTP surface (ADR-0018): `tasks:query` and `projects:query` collections with view metadata,
 * `:export` downloads, the builder catalog, saved views and their verbs, defaults, pins, and
 * non-disclosure for strangers. No response carries an internal identifier.
 */
describe('views API (3A)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let stranger: Browser;
  let ws: string;
  let brand: string;
  const bodies: string[] = [];
  const key = () => ({ 'idempotency-key': idemKey() });
  const base = () => `/v1/workspaces/${ws}`;

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('views-owner@example.test', '203.0.113.120');
    stranger = await person('views-stranger@example.test', '203.0.113.121');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Views',
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
    for (const [title, priority] of [
      ['=SUM(A1)', 'high'],
      ['Plain, "quoted"', 'low'],
      ['Third', 'urgent'],
    ])
      await owner.post(`${base()}/tasks`, { brand, title, priority }, { headers: key() });
  });
  afterAll(async () => {
    await env.close();
  });

  it('queries with keyset pages, totals, groups, and view metadata in the collection contract', async () => {
    const q = {
      query: { entity: 'task', sort: [{ field: 'priority' }], group: { field: 'priority' } },
      presentation: { columns: ['title', 'priority'] },
      include_total: true,
      limit: 2,
    };
    const first = await owner.post(`${base()}/tasks:query`, q);
    bodies.push(first.body);
    expect(first.statusCode, first.body).toBe(200);
    expect(contractErrors('collection-page', first.json())).toEqual([]);
    const body = first.json();
    expect(body.page).toMatchObject({
      limit: 2,
      has_more: true,
      total: { value: 3, capped: false },
    });
    expect(body.view.columns).toEqual([
      { field: 'title', label: 'Title' },
      { field: 'priority', label: 'Priority' },
    ]);
    expect(body.view.groups.map((g: { label: string }) => g.label)).toEqual([
      'Urgent',
      'High',
      'Low',
    ]);
    const next = await owner.post(`${base()}/tasks:query`, { ...q, cursor: body.page.next_cursor });
    expect(next.json().data).toHaveLength(1);
    expect(next.json().view.groups).toBeUndefined();
    // A cursor from another query is refused without detail.
    const bad = await owner.post(`${base()}/tasks:query`, {
      query: { entity: 'task' },
      cursor: body.page.next_cursor,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('cursor_invalid');
    expect(contractErrors('error-envelope', bad.json())).toEqual([]);
    const projects = await owner.post(`${base()}/projects:query`, { query: { entity: 'project' } });
    expect(projects.statusCode, projects.body).toBe(200);
    expect(contractErrors('collection-page', projects.json())).toEqual([]);
  });

  it('exports CSV and JSON with neutralized formulas and no-store headers', async () => {
    const csv = await owner.post(`${base()}/tasks:export`, {
      query: { entity: 'task', sort: [{ field: 'title' }] },
      presentation: { columns: ['title', 'priority'] },
      format: 'csv',
      name: 'Main tasks',
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="main-tasks.csv"');
    expect(csv.headers['cache-control']).toBe('private, no-store');
    const lines = csv.body.trim().split('\r\n');
    expect(lines[0]).toBe('ID,Title,Priority');
    expect(csv.body).toContain(`,'=SUM(A1),high`);
    expect(csv.body).toContain(`,"Plain, ""quoted""",low`);
    const json = await owner.post(`${base()}/tasks:export`, {
      query: { entity: 'task' },
      format: 'json',
    });
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(json.body).data).toHaveLength(3);
    bodies.push(json.body);
  });

  it('saved views: create, read, update with If-Match, share verbs, defaults, pins, delete', async () => {
    const created = await owner.post(
      `${base()}/views`,
      {
        name: 'Hot',
        query: {
          entity: 'task',
          filter: { op: 'and', items: [{ field: 'priority', op: 'in', value: ['urgent'] }] },
        },
      },
      { headers: key() },
    );
    expect(created.statusCode, created.body).toBe(201);
    const v = created.json().data;
    expect(v).toMatchObject({
      type: 'saved_view',
      visibility: 'personal',
      entity: 'task',
      version: 0,
    });
    expect(v.id).toMatch(/^view_/);
    bodies.push(created.body);
    expect(contractErrors('success-envelope', created.json())).toEqual([]);
    const got = await owner.get(`${base()}/views/${v.id}`);
    expect(got.headers.etag).toBe('"0"');
    const stale = await owner.patch(
      `${base()}/views/${v.id}`,
      { name: 'Hotter' },
      { headers: { ...key(), 'if-match': '"7"' } },
    );
    expect(stale.json().error.code).toBe('conflict');
    const upd = await owner.patch(
      `${base()}/views/${v.id}`,
      { name: 'Hotter' },
      { headers: { ...key(), 'if-match': '"0"' } },
    );
    expect(upd.statusCode, upd.body).toBe(200);
    const shared = await owner.post(
      `${base()}/views/${v.id}:share`,
      { scope: 'brand', brand },
      { headers: { ...key(), 'if-match': '"1"' } },
    );
    expect(shared.statusCode, shared.body).toBe(200);
    expect(shared.json().data.share).toMatchObject({ scope: 'brand', brand: { id: brand } });
    const pin = await owner.post(
      `${base()}/views/${v.id}:pin`,
      { scope: 'brand', brand },
      { headers: key() },
    );
    expect(pin.statusCode, pin.body).toBe(200);
    const pins = await owner.get(`${base()}/navigation/pins`);
    expect(pins.json().data.map((t: { id: string }) => t.id)).toContain(v.id);
    const def = await owner.put(
      `${base()}/views/defaults`,
      { target: 'brand', brand, entity: 'task', view: v.id },
      { headers: key() },
    );
    expect(def.statusCode, def.body).toBe(200);
    expect(def.json().data).toMatchObject({
      type: 'view_default',
      target: 'brand',
      view: { id: v.id },
    });
    const eff = await owner.get(`${base()}/views/defaults?entity=task&brand=${brand}`);
    expect(eff.json().data.effective).toMatchObject({ id: v.id, source: 'brand' });
    const list = await owner.get(`${base()}/views?entity=task`);
    expect(contractErrors('collection-page', list.json())).toEqual([]);
    expect(list.json().data.map((x: { id: string }) => x.id)).toContain(v.id);
    const catalog = await owner.get(`${base()}/views/catalog/task`);
    expect(catalog.json().data.type).toBe('view_catalog');
    expect(catalog.json().data.fields.map((f: { field: string }) => f.field)).toEqual(
      expect.arrayContaining(['brand', 'priority', 'assignee', 'milestone', 'label', 'agent']),
    );
    const unknownVerb = await owner.post(`${base()}/views/${v.id}:explode`, {}, { headers: key() });
    expect(unknownVerb.statusCode).toBe(404);
    const del = await owner.delete(`${base()}/views/${v.id}`, { headers: key() });
    expect(del.statusCode, del.body).toBe(200);
    expect((await owner.get(`${base()}/views/${v.id}`)).statusCode).toBe(404);
    expect((await owner.get(`${base()}/navigation/pins`)).json().data).toEqual([]);
  });

  it('strangers learn nothing: queries, views, and exports are not_found', async () => {
    const view = (
      await owner.post(
        `${base()}/views`,
        { name: 'Private', query: { entity: 'task' } },
        { headers: key() },
      )
    ).json().data.id;
    for (const r of [
      await stranger.post(`${base()}/tasks:query`, { query: { entity: 'task' } }),
      await stranger.post(`${base()}/tasks:export`, { query: { entity: 'task' } }),
      await stranger.get(`${base()}/views/${view}`),
      await stranger.get(`${base()}/views/view_00000000000000000000000000`),
    ]) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('not_found');
    }
    for (const b of bodies) expect(b).not.toMatch(UUID);
  });
});
