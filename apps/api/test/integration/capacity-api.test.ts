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

/**
 * 3E HTTP surface (ADR-0022; 0D PL-32): the caller's working hours as a non-resource subject with
 * the version as ETag, time off, brand holidays and reservations as resources (`tof_`, `hol_`,
 * `rsv_`), the computed capacity reads, and the same not_found for strangers. No internal UUIDs.
 */
describe('capacity API (3E)', () => {
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
  const key = (extra: Record<string, string> = {}) => ({ 'idempotency-key': idemKey(), ...extra });
  const base = () => `/v1/workspaces/${ws}`;
  const day = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('cap-owner@example.test', '203.0.113.140');
    stranger = await person('cap-stranger@example.test', '203.0.113.141');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Capacity',
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

  it('sets working hours with If-Match and reads capacity', async () => {
    const p = keep(await owner.get(`${base()}/me/capacity-profile`));
    expect(p.json().data).toMatchObject({ type: 'capacity_profile', configured: false });
    expect(p.headers.etag).toBe('"0"');
    const windows = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      start: '09:00',
      end: '17:00',
    }));
    const no = keep(
      await owner.put(`${base()}/me/capacity-profile`, { windows }, { headers: key() }),
    );
    expect(no.statusCode).toBe(428);
    const ok = keep(
      await owner.put(
        `${base()}/me/capacity-profile`,
        { windows },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers.etag).toBe('"1"');
    expect(ok.json().data).toMatchObject({ type: 'capacity_profile', nominal_week_minutes: 3360 });
    const c = keep(await owner.get(`${base()}/capacity?from=${day}&to=${day}`));
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().data).toMatchObject({
      type: 'capacity',
      days: [expect.objectContaining({ day, available_minutes: 480 })],
    });
    const r = keep(await owner.get(`${base()}/me/rescheduling-inputs?from=${day}&to=${day}`));
    expect(r.json().data).toMatchObject({ type: 'rescheduling_inputs', free_minutes: 480 });
    const range = keep(await owner.get(`${base()}/capacity?from=${day}&to=2099-01-01`));
    expect(range.statusCode).toBe(422);
  });

  it('manages time off, holidays, and reservations as resources', async () => {
    const t = keep(
      await owner.post(
        `${base()}/me/time-off`,
        { kind: 'vacation', all_day: true, starts_on: day },
        { headers: key() },
      ),
    );
    expect(t.statusCode, t.body).toBe(201);
    expect(t.json().data.id).toMatch(/^tof_/);
    const patched = keep(
      await owner.patch(
        `${base()}/me/time-off/${t.json().data.id}`,
        { label: 'Away' },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(patched.statusCode, patched.body).toBe(200);
    const c = keep(await owner.get(`${base()}/capacity?from=${day}&to=${day}`));
    expect(c.json().data.days[0].available_minutes).toBe(0);
    expect(
      keep(
        await owner.delete(`${base()}/me/time-off/${t.json().data.id}`, {
          headers: key({ 'if-match': '"1"' }),
        }),
      ).statusCode,
    ).toBe(200);
    const h = keep(
      await owner.post(
        `${base()}/brands/${brand}/holidays`,
        { day, name: 'Launch' },
        { headers: key() },
      ),
    );
    expect(h.statusCode, h.body).toBe(201);
    expect(h.json().data.id).toMatch(/^hol_/);
    const hl = keep(await owner.get(`${base()}/brands/${brand}/holidays`));
    expect(hl.json()).toMatchObject({
      can_configure: true,
      data: [expect.objectContaining({ day })],
    });
    const mine = c.json().data.member.id as string;
    expect(mine).toMatch(/^mem_/);
    const r = keep(
      await owner.post(
        `${base()}/capacity-reservations`,
        { brand, member: mine, minutes_per_week: 600, effective_from: day },
        { headers: key() },
      ),
    );
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().data.id).toMatch(/^rsv_/);
    const team = keep(await owner.get(`${base()}/capacity/team?from=${day}&to=${day}`));
    expect(team.json().data).toMatchObject({ type: 'team_capacity' });
    expect(
      keep(
        await owner.delete(`${base()}/capacity-reservations/${r.json().data.id}`, {
          headers: key(),
        }),
      ).statusCode,
    ).toBe(200);
    expect(
      keep(
        await owner.delete(`${base()}/brands/${brand}/holidays/${h.json().data.id}`, {
          headers: key(),
        }),
      ).statusCode,
    ).toBe(200);
  });

  it('gives strangers the same not_found everywhere and never returns internal UUIDs', async () => {
    for (const [method, path, body] of [
      ['get', `${base()}/me/capacity-profile`, undefined],
      ['get', `${base()}/capacity`, undefined],
      ['get', `${base()}/capacity/team`, undefined],
      ['get', `${base()}/me/time-off`, undefined],
      ['post', `${base()}/me/time-off`, { starts_on: day }],
      ['get', `${base()}/brands/${brand}/holidays`, undefined],
      ['get', `${base()}/capacity-reservations`, undefined],
    ] as const) {
      const r =
        method === 'get'
          ? await stranger.get(path)
          : await stranger.post(path, body, { headers: key() });
      expect(r.statusCode, `${method} ${path}`).toBe(404);
    }
    for (const b of bodies) expect(b).not.toMatch(UUID);
  });
});
