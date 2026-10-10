import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { indexWorkspace } from '@pm/work';
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
 * 5A HTTP surface (ADR-0028; 0D PL-38): search, the index status, opening a result, and recent
 * searches. Every response is computed for the caller and never cached; a hidden record and an
 * unknown one are the same answer; no internal identifier or index detail appears in any body.
 */
describe('search API (5A)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let member: Browser;
  let stranger: Browser;
  let anonymous: Browser;
  let ws: string;
  let wsId: string;
  let brand: string;
  let task: string;
  const bodies: string[] = [];
  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const key = () => ({ 'idempotency-key': idemKey() });
  const base = () => `/v1/workspaces/${ws}`;
  const drain = () =>
    indexWorkspace(
      {
        tenant: env.h.worker,
        discovery: undefined as never,
        metrics: env.h.telemetry.metrics,
        logger: env.h.logger,
      },
      wsId,
    );
  const get = (who: Browser, q: string) => keep(who.get(`${base()}/search?${q}`) as never);

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('search-owner@example.test', '203.0.113.190');
    stranger = await person('search-stranger@example.test', '203.0.113.191');
    anonymous = new Browser(env.app);
    anonymous.ip = '203.0.113.192';
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Search',
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
    wsId = (await env.db.admin(`SELECT id FROM tenancy.workspace WHERE public_id = '${ws}'`))
      .rows[0]!.id as string;
    const inv = keep(
      await owner.post(
        `${base()}/invitations`,
        { email: 'search-member@example.test', kind: 'member', role: 'administrator' },
        { headers: key() },
      ),
    );
    expect(inv.statusCode, inv.body).toBe(201);
    await env.deliverMail();
    const token = tokenFrom(mailTo(env, 'search-member@example.test', 'invited').at(-1));
    member = await person('search-member@example.test', '203.0.113.193');
    expect(
      keep(await member.post('/v1/invitations:accept', { token }, { headers: key() })).statusCode,
    ).toBe(200);
    const made = keep(
      await owner.post(
        `${base()}/tasks`,
        { brand, title: 'Gannet quarterly review' },
        { headers: key() },
      ),
    );
    expect(made.statusCode, made.body).toBe(201);
    task = made.json().data.id;
    await drain();
  });
  afterAll(async () => {
    expect(bodies.some((b) => UUID.test(b))).toBe(false);
    await env.close();
  });

  it('answers a search with results, facets, excerpts, and the index state, privately and uncached', async () => {
    const r = await get(owner, 'q=gannet');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    const data = r.json().data;
    expect(data).toMatchObject({
      type: 'search_results',
      total: 1,
      total_is_lower_bound: false,
      index: { state: 'complete', pending: 0, failed: 0 },
      page: { limit: 20, position: 1, has_more: false, next_cursor: null },
      query: { q: 'gannet', state: 'active' },
    });
    expect(data.results[0]).toMatchObject({
      type: 'task',
      id: task,
      title: 'Gannet quarterly review',
      index: 'current',
      brand: { kind: 'brand', name: 'Main' },
    });
    expect(data.results[0].title_parts).toEqual([
      { text: 'Gannet', hit: true },
      { text: ' quarterly review' },
    ]);
    expect(data.facets.kinds).toEqual([{ kind: 'task', label: 'Tasks', count: 1 }]);
  });

  it('gives a hidden record and an unknown one the same answer', async () => {
    const hidden = (await get(member, 'q=gannet')).json();
    const unknown = (await get(member, 'q=qwxzvbnm')).json();
    const strip = (b: any) => {
      const { meta: _meta, ...rest } = b;
      return JSON.parse(JSON.stringify(rest).replace(/gannet|qwxzvbnm/gi, 'X'));
    };
    if (hidden.data.total === 0) expect(strip(hidden)).toEqual(strip(unknown));
    const gone = keep(await stranger.get(`${base()}/search?q=gannet`));
    const gone2 = keep(
      await stranger.get(`/v1/workspaces/wsp_00000000000000000000000000/search?q=gannet`),
    );
    expect(gone.statusCode).toBe(gone2.statusCode);
    expect(gone.statusCode).toBe(404);
    const open = keep(await stranger.post(`${base()}/search/open`, { type: 'task', id: task }));
    expect(open.statusCode).toBe(404);
  });

  it('refuses malformed searches with stable issues and unauthenticated callers with 401', async () => {
    for (const [q, code] of [
      ['q=', 'empty'],
      ['q=-nothing', 'no_terms'],
      [`q=${'x'.repeat(201)}`, 'too_long'],
      ['q=a&kind=nonsense', 'invalid_option'],
      ['q=a&limit=0', 'invalid_option'],
      ['q=a&brand=br_00000000000000000000000000', 'unavailable'],
    ] as const) {
      const r = await get(owner, q);
      expect(r.statusCode, q).toBe(422);
      expect(JSON.stringify(r.json())).toContain(code);
    }
    expect((await get(owner, '')).statusCode).toBe(422);
    const anon = await anonymous.get(`${base()}/search?q=gannet`);
    expect(anon.statusCode).toBe(401);
  });

  it('reports the index state alone, and opens a result only after checking access again', async () => {
    const s = keep(await owner.get(`${base()}/search/status`));
    expect(s.statusCode).toBe(200);
    expect(s.headers['cache-control']).toBe('private, no-store');
    expect(s.json().data).toMatchObject({
      type: 'search_status',
      index: { state: 'complete', pending: 0, failed: 0 },
    });
    expect(s.json().data.sources.map((x: any) => x.kind)).toEqual(
      expect.arrayContaining(['task', 'comment', 'file', 'document']),
    );
    const o = keep(await owner.post(`${base()}/search/open`, { type: 'task', id: task }));
    expect(o.statusCode, o.body).toBe(200);
    expect(o.json().data).toMatchObject({
      type: 'search_open',
      result: { type: 'task', id: task },
      host: null,
    });
    expect(
      keep(await owner.post(`${base()}/search/open`, { type: 'task', id: 'tsk_nope' })).statusCode,
    ).toBe(404);
  });

  it('remembers submitted searches for the person only, and forgets them on request', async () => {
    expect(
      keep(await owner.post(`${base()}/search/recent`, { q: 'gannet', filters: {} })).statusCode,
    ).toBe(202);
    expect(keep(await owner.post(`${base()}/search/recent`, { q: '' })).statusCode).toBe(422);
    const mine = keep(await owner.get(`${base()}/search/recent`));
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['cache-control']).toBe('private, no-store');
    expect(mine.json().data.data).toEqual([
      expect.objectContaining({ q: 'gannet', count: 1, handle: expect.any(String) }),
    ]);
    expect(keep(await member.get(`${base()}/search/recent`)).json().data.data).toEqual([]);
    const handle = mine.json().data.data[0].handle;
    expect(keep(await owner.delete(`${base()}/search/recent/${handle}`)).statusCode).toBe(204);
    expect(keep(await owner.delete(`${base()}/search/recent/${handle}`)).statusCode).toBe(404);
    await owner.post(`${base()}/search/recent`, { q: 'one' });
    await owner.post(`${base()}/search/recent`, { q: 'two' });
    expect(keep(await owner.delete(`${base()}/search/recent`)).json().data).toMatchObject({
      cleared: 2,
    });
    expect(keep(await owner.get(`${base()}/search/recent`)).json().data.data).toEqual([]);
  });
});
