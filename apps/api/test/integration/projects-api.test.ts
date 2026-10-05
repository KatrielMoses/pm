import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  Browser,
  idemKey,
  identityEnv,
  registerAndVerify,
  signIn,
  type IdentityEnv,
} from './identity-helpers.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** 2A HTTP surface: project routes, action verbs, envelopes, ETags, and non-disclosure. */
describe('projects API (2A)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let stranger: Browser;
  let ws: string;
  let brand: string;
  const bodies: string[] = [];
  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const key = () => ({ 'idempotency-key': idemKey() });

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('prj-owner@example.test', '203.0.113.70');
    stranger = await person('prj-stranger@example.test', '203.0.113.71');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Projects',
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
    await env.close();
  });

  it('creates, reads, lists, and edits a project with ETag preconditions', async () => {
    const c = keep(
      await owner.post(
        `/v1/workspaces/${ws}/projects`,
        { brand, name: 'API project' },
        { headers: key() },
      ),
    );
    expect(c.statusCode, c.body).toBe(201);
    const prj = c.json().data.id as string;
    expect(prj).toMatch(/^prj_/);
    expect(c.headers.etag).toBe('"0"');
    const g = keep(await owner.get(`/v1/workspaces/${ws}/projects/${prj}`));
    expect(g.json().data).toMatchObject({
      type: 'project',
      name: 'API project',
      brand: { kind: 'brand', id: brand },
    });
    const l = keep(await owner.get(`/v1/workspaces/${ws}/projects`));
    expect(l.json().data.map((x: { id: string }) => x.id)).toContain(prj);
    expect(l.json().page.total).toMatchObject({ value: 1 });
    // An edit without If-Match is a precondition failure; with it, the version advances.
    const noMatch = keep(
      await owner.patch(
        `/v1/workspaces/${ws}/projects/${prj}`,
        { changes: { name: { base: 'API project', value: 'Renamed' } } },
        { headers: key() },
      ),
    );
    expect(noMatch.statusCode).toBe(428);
    const e = keep(
      await owner.patch(
        `/v1/workspaces/${ws}/projects/${prj}`,
        { version: 0, changes: { name: { base: 'API project', value: 'Renamed' } } },
        { headers: { ...key(), 'if-match': '"0"' } },
      ),
    );
    expect(e.statusCode, e.body).toBe(200);
    expect(e.headers.etag).toBe('"1"');
    const o = keep(await owner.get(`/v1/workspaces/${ws}/projects/${prj}/overview`));
    expect(o.json().data).toMatchObject({
      type: 'project_overview',
      project: { name: 'Renamed' },
      task_facts: { available: false },
    });
  });

  it('action verbs: unknown verbs and paths are not_found; lifecycle verbs work through the service', async () => {
    const prj = keep(
      await owner.post(
        `/v1/workspaces/${ws}/projects`,
        { brand, name: 'Verbs' },
        { headers: key() },
      ),
    ).json().data.id;
    expect(
      keep(await owner.post(`/v1/workspaces/${ws}/projects/${prj}:explode`, {}, { headers: key() }))
        .statusCode,
    ).toBe(404);
    const a = keep(
      await owner.post(`/v1/workspaces/${ws}/projects/${prj}:archive`, {}, { headers: key() }),
    );
    expect(a.json().data).toMatchObject({ lifecycle_state: 'archived' });
    const u = keep(
      await owner.post(`/v1/workspaces/${ws}/projects/${prj}:unarchive`, {}, { headers: key() }),
    );
    expect(u.json().data).toMatchObject({ lifecycle_state: 'active' });
    const ph = keep(
      await owner.post(
        `/v1/workspaces/${ws}/projects/${prj}/phases`,
        { name: 'One' },
        { headers: key() },
      ),
    );
    expect(ph.statusCode, ph.body).toBe(201);
    expect(ph.json().data.id).toMatch(/^phs_/);
  });

  it('strangers and guessed identifiers get the same not_found; no response carries internal UUIDs', async () => {
    const prj = keep(
      await owner.post(
        `/v1/workspaces/${ws}/projects`,
        { brand, name: 'Private' },
        { headers: key() },
      ),
    ).json().data.id;
    for (const path of [
      `/v1/workspaces/${ws}/projects/${prj}`,
      `/v1/workspaces/${ws}/projects/${prj}/overview`,
      `/v1/workspaces/${ws}/projects/prj_01J0000000000000000000000Z`,
    ]) {
      const r = keep(await stranger.get(path));
      expect(r.statusCode, path).toBe(404);
      expect(r.json().error.code).toBe('not_found');
    }
    for (const b of bodies) expect(b).not.toMatch(UUID);
  });
});
