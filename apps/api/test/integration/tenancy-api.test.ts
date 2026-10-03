import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  Browser,
  idemKey,
  identityEnv,
  PASSWORD,
  registerAndVerify,
  signIn,
  type IdentityEnv,
} from './identity-helpers.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WORKSPACE = {
  name: 'Synthetic Studio',
  timezone: 'Europe/Lisbon',
  locale: 'pt-PT',
  currency: 'EUR',
  week_start: 1,
};

describe('tenancy API (1C): workspaces, brands, settings, context', () => {
  let env: IdentityEnv;
  let alice: Browser;
  let bob: Browser;
  const bodies: string[] = [];

  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const key = () => ({ 'idempotency-key': idemKey() });

  beforeAll(async () => {
    env = await identityEnv();
    alice = new Browser(env.app);
    await registerAndVerify(env, alice, 'tenancy-alice@example.test');
    await signIn(alice, 'tenancy-alice@example.test');
    bob = new Browser(env.app);
    bob.ip = '203.0.113.20';
    await registerAndVerify(env, bob, 'tenancy-bob@example.test');
    await signIn(bob, 'tenancy-bob@example.test');
  });
  afterAll(async () => {
    await env.close();
  });

  let ws: string;
  let brand: string;

  it('onboarding: no workspaces → create with first brand (idempotent) → listed and selected', async () => {
    expect(keep(await alice.get('/v1/workspaces')).json()).toMatchObject({
      data: [],
      page: { has_more: false },
    });
    expect((await new Browser(env.app).get('/v1/workspaces')).statusCode).toBe(401);
    const missingKey = await alice.post('/v1/workspaces', WORKSPACE);
    expect(missingKey.statusCode).toBe(422);
    expect(missingKey.json().error.issues[0].code).toBe('idempotency_key_required');

    const headers = key();
    const body = {
      ...WORKSPACE,
      first_brand: { name: 'Coastline', color: '#225588', icon: 'globe' },
    };
    const created = keep(await alice.post('/v1/workspaces', body, { headers }));
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe('"0"');
    const data = created.json().data;
    expect(data).toMatchObject({
      type: 'workspace',
      name: 'Synthetic Studio',
      first_brand: { name: 'Coastline' },
    });
    ws = data.id;
    brand = data.first_brand.id;
    const replay = keep(await alice.post('/v1/workspaces', body, { headers }));
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().data.id).toBe(ws);
    const reuse = await alice.post('/v1/workspaces', { ...body, name: 'Different' }, { headers });
    expect(reuse.json().error.code).toBe('idempotency_key_reuse');

    const sel = keep(
      await alice.post(`/v1/workspaces/${ws}:select`, { scope: 'brand', brand_id: brand }),
    );
    expect(sel.statusCode).toBe(200);
    expect(sel.json().data).toMatchObject({
      type: 'workspace_context',
      scope: { kind: 'brand', brand_id: brand },
    });
    expect(keep(await alice.get('/v1/workspaces')).json().data).toEqual([
      { id: ws, type: 'workspace', name: 'Synthetic Studio', selected: true },
    ]);
  });

  it('brands: create, merge-edit with ETag, list with totals; body claims never override the path', async () => {
    const second = keep(
      await alice.post(`/v1/workspaces/${ws}/brands`, { name: 'Summit' }, { headers: key() }),
    );
    expect(second.statusCode).toBe(201);
    const id = second.json().data.id;
    const edit = keep(
      await alice.patch(
        `/v1/workspaces/${ws}/brands/${id}`,
        {
          version: 0,
          changes: {
            short_name: { base: null, value: 'SMT' },
            operational_status: { base: 'operating', value: 'paused' },
          },
        },
        { headers: key() },
      ),
    );
    expect(edit.statusCode).toBe(200);
    expect(edit.headers.etag).toBe('"1"');
    expect(edit.json().data).toMatchObject({
      short_name: 'SMT',
      operational_status: 'paused',
      lifecycle_state: 'active',
    });
    const claims = await alice.post(
      `/v1/workspaces/${ws}/brands`,
      { name: 'Claimed', workspace_id: 'ws_01J0000000000000000000000Z', role: 'owner' },
      { headers: { ...key(), 'x-workspace-id': 'ws_01J0000000000000000000000Z' } },
    );
    expect(claims.statusCode).toBe(422);
    expect(claims.json().error.issues.map((i: { pointer: string }) => i.pointer)).toEqual([
      '/workspace_id',
      '/role',
    ]);
    const list = keep(await alice.get(`/v1/workspaces/${ws}/brands?include_total=true`));
    expect(list.json()).toMatchObject({
      page: { total: { value: 2, estimated: false, capped: false } },
    });
  });

  it('another account gets the same not_found for every guessed workspace and brand route', async () => {
    const probes: Array<Promise<LightMyRequestResponse>> = [
      bob.get(`/v1/workspaces/${ws}`),
      bob.get(`/v1/workspaces/${ws}/brands`),
      bob.get(`/v1/workspaces/${ws}/context`),
      bob.get(`/v1/workspaces/${ws}/brands/${brand}`),
      bob.get(`/v1/workspaces/${ws}/brands/${brand}/settings`),
      bob.post(`/v1/workspaces/${ws}:select`, {}),
      bob.patch(
        `/v1/workspaces/${ws}`,
        { changes: { name: { base: 'x', value: 'y' } } },
        { headers: key() },
      ),
      bob.post(
        `/v1/workspaces/${ws}/brands/${brand}:archive`,
        {},
        { headers: { ...key(), 'if-match': '"0"' } },
      ),
      bob.get('/v1/workspaces/ws_01J0000000000000000000000Z'),
    ];
    for (const r of await Promise.all(probes)) {
      expect(r.statusCode, r.body).toBe(404);
      const e = r.json().error;
      expect(e.code).toBe('not_found');
      expect(r.headers.etag).toBeUndefined();
      expect(Object.keys(e).sort()).toEqual([
        'code',
        'correlation_id',
        'message',
        'request_id',
        'retryable',
        'status',
      ]);
    }
  });

  it('archive/restore require If-Match; conflicts carry the 0D payload', async () => {
    const url = `/v1/workspaces/${ws}/brands/${brand}`;
    expect((await alice.post(`${url}:archive`, {}, { headers: key() })).statusCode).toBe(428);
    const stale = await alice.post(
      `${url}:archive`,
      {},
      { headers: { ...key(), 'if-match': '"5"' } },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.conflict).toEqual({ current_version: 0 });
    const done = keep(
      await alice.post(`${url}:archive`, {}, { headers: { ...key(), 'if-match': '"0"' } }),
    );
    expect(done.statusCode).toBe(200);
    expect(done.json().data).toMatchObject({ lifecycle_state: 'archived', version: 1 });
    expect((await alice.post(`${url}:explode`, {}, { headers: key() })).statusCode).toBe(404);
    const ctx = keep(await alice.get(`/v1/workspaces/${ws}/context?include_archived=true`)).json()
      .data;
    expect(ctx.fallback).toBe('stale_selection');
    expect(ctx.scope.kind).toBe('brand');
    expect(ctx.archived_brands.map((b: { id: string }) => b.id)).toEqual([brand]);
    const back = keep(
      await alice.post(`${url}:restore`, {}, { headers: { ...key(), 'if-match': '"1"' } }),
    );
    expect(back.json().data).toMatchObject({ lifecycle_state: 'active', version: 2 });
  });

  it('settings: GET with ETag, PUT requires If-Match and validates overlaps', async () => {
    const url = `/v1/workspaces/${ws}/brands/${brand}/settings`;
    const got = keep(await alice.get(url));
    expect(got.headers.etag).toBe('"0"');
    expect(got.json().data).toMatchObject({ type: 'brand_settings', timezone: 'Europe/Lisbon' });
    const hours = {
      schema_version: 1,
      days: [{ weekday: 2, ranges: [{ start: '10:00', end: '18:00' }] }],
    };
    expect((await alice.put(`${url}/working-hours`, hours, { headers: key() })).statusCode).toBe(
      428,
    );
    const bad = await alice.put(
      `${url}/working-hours`,
      { schema_version: 1, days: [{ weekday: 2, ranges: [{ start: '10:00', end: '09:00' }] }] },
      { headers: { ...key(), 'if-match': '"0"' } },
    );
    expect(bad.json().error.issues[0]).toMatchObject({ code: 'end_before_start' });
    const ok = keep(
      await alice.put(`${url}/working-hours`, hours, { headers: { ...key(), 'if-match': '"0"' } }),
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"1"');
    expect(
      (await alice.put(`${url}/ai`, {}, { headers: { ...key(), 'if-match': '"1"' } })).statusCode,
    ).toBe(404);
  });

  it('marking sensitive needs a real step-up bound to this membership, workspace, brand, and key', async () => {
    const url = `/v1/workspaces/${ws}/brands/${brand}:set-sensitivity`;
    const headers = { ...key(), 'if-match': '"2"' };
    const first = await alice.post(url, { is_sensitive: true }, { headers });
    expect(first.statusCode).toBe(403);
    const challenge = first.json().error.step_up;
    expect(challenge).toMatchObject({ action_key: 'brand.mark_sensitive', state: 'pending' });
    const row = (
      await env.db.admin(
        `SELECT membership_id IS NOT NULL AS m, workspace_id IS NOT NULL AS w, target_hash IS NOT NULL AS t
           FROM identity.step_up_challenge WHERE public_id = $1`,
        [challenge.id],
      )
    ).rows[0];
    expect(row).toEqual({ m: true, w: true, t: true });
    const verified = await alice.post(`/v1/auth/step-up/${challenge.id}:verify`, {
      method: 'password',
      proof: PASSWORD,
    });
    expect(verified.statusCode).toBe(200);
    const token = verified.json().data.token as string;
    // The token is bound to the original Idempotency-Key: another key cannot spend it.
    const otherKey = await alice.post(
      url,
      { is_sensitive: true },
      { headers: { ...key(), 'if-match': '"2"', 'step-up': token } },
    );
    expect(otherKey.json().error.code).toBe('step_up_required');
    const done = keep(
      await alice.post(url, { is_sensitive: true }, { headers: { ...headers, 'step-up': token } }),
    );
    expect(done.statusCode).toBe(200);
    expect(done.json().data).toMatchObject({
      is_sensitive: true,
      capabilities: { configure: true },
    });
    expect(
      (
        await env.db.admin(`SELECT state FROM identity.step_up_challenge WHERE public_id = $1`, [
          challenge.id,
        ])
      ).rows[0].state,
    ).toBe('consumed');
    // The creator still sees the brand after it became sensitive.
    expect((await alice.get(`/v1/workspaces/${ws}/brands/${brand}`)).statusCode).toBe(200);
  });

  it('responses never expose internal UUIDs, membership internals, or grants', () => {
    for (const b of bodies) {
      expect(b).not.toMatch(UUID);
      expect(b).not.toMatch(
        /mem_[0-9A-Z]{26}|membership_id|role_assignment|grant_source|scope_manage/,
      );
    }
  });
});
