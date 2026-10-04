import { randomBytes } from 'node:crypto';
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

/** 1E HTTP surface: preferences, favorites, recents, view state, scope context, shell events. */
describe('personal navigation API (1E)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let stranger: Browser;
  let ws: string;
  let brand: string;
  let other: string;
  const deviceKey = randomBytes(32).toString('base64url');
  const bodies: string[] = [];
  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const dev = { 'x-device-key': deviceKey };

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('nav-owner@example.test', '203.0.113.60');
    stranger = await person('nav-stranger@example.test', '203.0.113.61');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Nav Space',
        timezone: 'UTC',
        locale: 'en',
        currency: 'USD',
        week_start: 1,
        first_brand: { name: 'Main' },
      },
      { headers: { 'idempotency-key': idemKey() } },
    );
    ws = created.json().data.id;
    brand = created.json().data.first_brand.id;
    other = (
      await owner.post(
        `/v1/workspaces/${ws}/brands`,
        { name: 'Second' },
        { headers: { 'idempotency-key': idemKey() } },
      )
    ).json().data.id;
  });
  afterAll(async () => {
    await env.close();
  });

  it('preferences: typed GET/PATCH with ETag preconditions and validation', async () => {
    const r = keep(await owner.get('/v1/auth/preferences'));
    expect(r.statusCode).toBe(200);
    expect(r.headers.etag).toBe('"0"');
    expect(r.json().data).toMatchObject({ type: 'preferences', theme: 'system', version: 0 });
    const p = keep(
      await owner.patch(
        '/v1/auth/preferences',
        { theme: 'dark' },
        { headers: { 'if-match': '"0"' } },
      ),
    );
    expect(p.statusCode, p.body).toBe(200);
    expect(p.headers.etag).toBe('"1"');
    const stale = await owner.patch(
      '/v1/auth/preferences',
      { theme: 'light' },
      { headers: { 'if-match': '"0"' } },
    );
    expect(stale.statusCode).toBe(409);
    expect((await owner.patch('/v1/auth/preferences', { theme: 'neon' })).statusCode).toBe(422);
    // Unsafe requests need the CSRF token and origin like every other mutation.
    const csrfless = await owner.request('PATCH', '/v1/auth/preferences', {
      body: { theme: 'light' },
      csrf: null,
    });
    expect(csrfless.statusCode).toBe(403);
    expect((await new Browser(env.app).get('/v1/auth/preferences')).statusCode).toBe(401);
  });

  it('favorites and recents: idempotent PUT, ordered list, move, delete, visit, clear', async () => {
    const put = keep(await owner.put(`/v1/workspaces/${ws}/favorites/${brand}`));
    expect(put.statusCode, put.body).toBe(201);
    expect((await owner.put(`/v1/workspaces/${ws}/favorites/${brand}`)).statusCode).toBe(200);
    await owner.put(`/v1/workspaces/${ws}/favorites/${other}`);
    const moved = keep(
      await owner.post(`/v1/workspaces/${ws}/favorites/${other}:move`, { after: null }),
    );
    expect(moved.json().data.map((t: { id: string }) => t.id)).toEqual([other, brand]);
    expect(moved.json().data[0]).toMatchObject({
      type: 'brand',
      label: 'Second',
      brand: { kind: 'brand', id: other },
    });
    const list = keep(await owner.get(`/v1/workspaces/${ws}/favorites`));
    expect(list.headers['cache-control']).toContain('no-store');
    expect((await owner.delete(`/v1/workspaces/${ws}/favorites/${other}`)).statusCode).toBe(204);
    expect((await owner.delete(`/v1/workspaces/${ws}/favorites/${other}`)).statusCode).toBe(404);
    expect((await owner.post(`/v1/workspaces/${ws}/favorites/${brand}:pin`, {})).statusCode).toBe(
      404,
    );
    const visit = keep(await owner.post(`/v1/workspaces/${ws}/recent`, { target: brand }));
    expect(visit.statusCode).toBe(202);
    const recent = keep(await owner.get(`/v1/workspaces/${ws}/recent?limit=sidebar`));
    expect(recent.json().data.map((t: { id: string }) => t.id)).toEqual([brand]);
    expect(recent.json().data[0].visited_at).toMatch(/Z$/);
    const cleared = keep(await owner.post(`/v1/workspaces/${ws}/recent:clear`, {}));
    expect(cleared.json().data).toMatchObject({ type: 'recent_item', cleared: 1 });
  });

  it('view state is per device: the device key header partitions it; ETag guards writes', async () => {
    const url = `/v1/workspaces/${ws}/view-state/people.list`;
    const empty = keep(await owner.get(url, { headers: dev }));
    expect(empty.json().data).toMatchObject({ key: 'people.list', state: {}, version: 0 });
    const saved = keep(
      await owner.put(
        url,
        { schema_version: 1, state: { sort: 'name', state: 'active' } },
        { headers: { ...dev, 'if-match': '"0"' } },
      ),
    );
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.headers.etag).toBe('"1"');
    expect(
      (
        await owner.put(
          url,
          { schema_version: 1, state: {} },
          { headers: { ...dev, 'if-match': '"0"' } },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await owner.put(url, { schema_version: 1, state: { q: 'never stored' } }, { headers: dev }))
        .statusCode,
    ).toBe(422);
    expect((await owner.put(url, { schema_version: 1, state: {} })).statusCode).toBe(422);
    const otherDevice = await owner.get(url, {
      headers: { 'x-device-key': randomBytes(32).toString('base64url') },
    });
    expect(otherDevice.json().data.state).toEqual({});
    expect(
      (await owner.get(`/v1/workspaces/${ws}/view-state/unknown.view`, { headers: dev }))
        .statusCode,
    ).toBe(404);
    expect((await owner.delete(url, { headers: dev })).statusCode).toBe(204);
  });

  it('context: URL scope tokens are validated and normalized; select stores the device default', async () => {
    const both = keep(
      await owner.get(`/v1/workspaces/${ws}/context?scope=brands:${other},${brand}`, {
        headers: dev,
      }),
    );
    expect(both.json().data).toMatchObject({
      type: 'workspace_context',
      principal: 'member',
      scope: { kind: 'brands', brand_ids: [brand, other].sort() },
      scope_token: `brands:${[brand, other].sort().join(',')}`,
    });
    const junk = keep(await owner.get(`/v1/workspaces/${ws}/context?scope=%3Cscript%3E`));
    expect(junk.json().data.fallback).toBe('invalid');
    const sel = keep(
      await owner.post(
        `/v1/workspaces/${ws}:select`,
        { scope: 'brands', brand_ids: [brand, other] },
        { headers: dev },
      ),
    );
    expect(sel.statusCode, sel.body).toBe(200);
    const again = keep(await owner.get(`/v1/workspaces/${ws}/context`, { headers: dev }));
    expect(again.json().data.scope.kind).toBe('brands');
  });

  it('strangers and forged identifiers get not_found everywhere; palette lookup is scoped', async () => {
    for (const [method, url] of [
      ['GET', `/v1/workspaces/${ws}/favorites`],
      ['GET', `/v1/workspaces/${ws}/recent`],
      ['GET', `/v1/workspaces/${ws}/navigation/targets?q=Main`],
      ['GET', `/v1/workspaces/${ws}/navigation/pins`],
      ['GET', `/v1/workspaces/${ws}/view-state/people.list`],
      ['PUT', `/v1/workspaces/${ws}/favorites/${brand}`],
    ] as const) {
      const r = await stranger.request(method, url, { headers: dev });
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error.code).toBe('not_found');
    }
    expect(
      (await owner.put(`/v1/workspaces/${ws}/favorites/br_00000000000000000000000000`)).statusCode,
    ).toBe(404);
    const hits = keep(await owner.get(`/v1/workspaces/${ws}/navigation/targets?q=sec`));
    expect(hits.json().data.map((t: { label: string }) => t.label)).toEqual(['Second']);
  });

  it('shell events count only registered command IDs and decode reasons', async () => {
    const ok = await owner.post('/v1/shell/events', {
      commands: [
        { command: 'palette.open', trigger: 'shortcut' },
        { command: 'not.registered', trigger: 'palette' },
        { command: 'go.home', trigger: 'everywhere' },
      ],
      decode_failures: [
        { source: 'url', reason: 'malformed' },
        { source: 'disk', reason: 'x' },
      ],
    });
    expect(ok.statusCode).toBe(204);
    const { resourceMetrics } = await env.h.telemetry.metricReader!.collect();
    const points = resourceMetrics.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .filter((m) => m.descriptor.name === 'shell.commands')
      .flatMap((m) => m.dataPoints as Array<{ attributes: Record<string, unknown> }>);
    expect(points.map((p) => p.attributes)).toEqual([
      { command: 'palette.open', trigger: 'shortcut' },
    ]);
    expect((await new Browser(env.app).post('/v1/shell/events', {})).statusCode).toBe(401);
    expect((await owner.post('/v1/shell/events', [])).statusCode).toBe(422);
  });

  it('responses never contain internal UUIDs', () => {
    for (const b of bodies) expect(b).not.toMatch(UUID);
  });
});
