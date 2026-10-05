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

/** 2B HTTP surface: task routes, action verbs, item routes, envelopes, ETags, and non-disclosure. */
describe('tasks API (2B)', () => {
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
    owner = await person('tsk-owner@example.test', '203.0.113.80');
    stranger = await person('tsk-stranger@example.test', '203.0.113.81');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Tasks',
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

  it('creates, reads (with detail), lists, and edits a task with ETag preconditions', async () => {
    const c = keep(
      await owner.post(
        `/v1/workspaces/${ws}/tasks`,
        { brand, title: 'API task' },
        { headers: key() },
      ),
    );
    expect(c.statusCode, c.body).toBe(201);
    const t = c.json().data;
    expect(t).toMatchObject({ type: 'task', title: 'API task', status: { key: 'todo' } });
    expect(c.headers.etag).toBe(`"${t.version}"`);
    const g = keep(await owner.get(`/v1/workspaces/${ws}/tasks/${t.id}`));
    expect(g.json().data).toMatchObject({
      id: t.id,
      detail: { checklist: [], criteria: [], links: [] },
    });
    const l = keep(await owner.get(`/v1/workspaces/${ws}/tasks?projectless=true`));
    expect(l.json()).toMatchObject({
      data: [expect.objectContaining({ id: t.id })],
      page: { has_more: false, total: { value: 1 } },
    });
    const stale = keep(
      await owner.patch(
        `/v1/workspaces/${ws}/tasks/${t.id}`,
        { changes: { title: { base: 'Someone else changed this', value: 'x' } } },
        { headers: { ...key(), 'if-match': '"99"' } },
      ),
    );
    expect(stale.statusCode).toBe(409);
    const e = keep(
      await owner.patch(
        `/v1/workspaces/${ws}/tasks/${t.id}`,
        { version: t.version, changes: { title: { base: 'API task', value: 'Renamed' } } },
        { headers: { ...key(), 'if-match': `"${t.version}"` } },
      ),
    );
    expect(e.statusCode, e.body).toBe(200);
    expect(e.json().data.title).toBe('Renamed');
  });

  it('verbs and item routes: complete, reopen, checklist, links, relationships, history; unknown verbs are not_found', async () => {
    const t = keep(
      await owner.post(`/v1/workspaces/${ws}/tasks`, { brand, title: 'Verbs' }, { headers: key() }),
    ).json().data;
    expect(
      keep(await owner.post(`/v1/workspaces/${ws}/tasks/${t.id}:explode`, {}, { headers: key() }))
        .statusCode,
    ).toBe(404);
    const chk = keep(
      await owner.post(
        `/v1/workspaces/${ws}/tasks/${t.id}/checklist`,
        { text: 'One' },
        { headers: key() },
      ),
    );
    expect(chk.statusCode, chk.body).toBe(201);
    expect(chk.json().data.id).toMatch(/^chk_/);
    const done = keep(
      await owner.patch(
        `/v1/workspaces/${ws}/tasks/${t.id}/checklist/${chk.json().data.id}`,
        { done: true },
        { headers: { ...key(), 'if-match': '"0"' } },
      ),
    );
    expect(done.statusCode, done.body).toBe(200);
    const link = keep(
      await owner.post(
        `/v1/workspaces/${ws}/tasks/${t.id}/links`,
        { url: 'http://insecure.test' },
        { headers: key() },
      ),
    );
    expect(link.statusCode).toBe(422);
    const other = keep(
      await owner.post(`/v1/workspaces/${ws}/tasks`, { brand, title: 'Other' }, { headers: key() }),
    ).json().data;
    const rel = keep(
      await owner.post(
        `/v1/workspaces/${ws}/tasks/${t.id}/relationships`,
        { kind: 'blocks', target: other.id },
        { headers: key() },
      ),
    );
    expect(rel.statusCode, rel.body).toBe(200);
    expect(
      keep(
        await owner.delete(`/v1/workspaces/${ws}/tasks/${t.id}/relationships/blocks/${other.id}`, {
          headers: key(),
        }),
      ).statusCode,
    ).toBe(200);
    const c = keep(
      await owner.post(`/v1/workspaces/${ws}/tasks/${t.id}:complete`, {}, { headers: key() }),
    );
    expect(c.json().data.status.key).toBe('done');
    const r = keep(
      await owner.post(`/v1/workspaces/${ws}/tasks/${t.id}:reopen`, {}, { headers: key() }),
    );
    expect(r.json().data.status.key).toBe('todo');
    const h = keep(await owner.get(`/v1/workspaces/${ws}/tasks/${t.id}/history`));
    expect(h.json().data.map((x: { action: string }) => x.action)).toEqual(
      expect.arrayContaining(['task.created', 'task.completed', 'task.reopened']),
    );
    const a = keep(
      await owner.post(`/v1/workspaces/${ws}/tasks/${t.id}:archive`, {}, { headers: key() }),
    );
    expect(a.json().data).toMatchObject({ lifecycle_state: 'archived' });
    const lbl = keep(
      await owner.post(
        `/v1/workspaces/${ws}/brands/${brand}/labels`,
        { name: 'API label' },
        { headers: key() },
      ),
    );
    expect(lbl.statusCode, lbl.body).toBe(201);
    expect(
      keep(await owner.get(`/v1/workspaces/${ws}/brands/${brand}/labels`)).json().data,
    ).toEqual([expect.objectContaining({ name: 'API label' })]);
  });

  it('strangers and guessed identifiers get the same not_found; no response carries internal UUIDs', async () => {
    const t = keep(
      await owner.post(
        `/v1/workspaces/${ws}/tasks`,
        { brand, title: 'Private' },
        { headers: key() },
      ),
    ).json().data;
    for (const path of [
      `/v1/workspaces/${ws}/tasks/${t.id}`,
      `/v1/workspaces/${ws}/tasks/${t.id}/history`,
      `/v1/workspaces/${ws}/tasks/tsk_01J0000000000000000000000Z`,
    ]) {
      const r = keep(await stranger.get(path));
      expect(r.statusCode, path).toBe(404);
      expect(r.json().error.code).toBe('not_found');
    }
    for (const b of bodies) expect(b).not.toMatch(UUID);
  });
});
