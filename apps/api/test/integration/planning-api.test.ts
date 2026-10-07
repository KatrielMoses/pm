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
 * 3C HTTP surface (ADR-0021): the Today view and day plan, commitments addressed by day and task
 * (non-resource envelopes with the version as ETag), `{day}:shutdown`, daily records, work blocks
 * and block series as resources, and the same not_found for strangers. No internal UUIDs.
 */
describe('planning API (3C)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let stranger: Browser;
  let ws: string;
  let task: string;
  let today: string;
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

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('plan-owner@example.test', '203.0.113.130');
    stranger = await person('plan-stranger@example.test', '203.0.113.131');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Plans',
        timezone: 'UTC',
        locale: 'en',
        currency: 'USD',
        week_start: 1,
        first_brand: { name: 'Main' },
      },
      { headers: key() },
    );
    ws = created.json().data.id;
    const brand = created.json().data.first_brand.id;
    task = (
      await owner.post(
        `${base()}/tasks`,
        { brand, title: 'Write plan', estimate_minutes: 45 },
        { headers: key() },
      )
    ).json().data.id;
    today = (await owner.get(`${base()}/today/today`)).json().data.day;
  });
  afterAll(async () => {
    await env.close();
  });

  it('commits, reorders with If-Match, plans, shuts down, and lists records', async () => {
    const c = keep(
      await owner.post(`${base()}/today/${today}/items`, { task }, { headers: key() }),
    );
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().data).toMatchObject({ type: 'today_commitment', day: today, outcome: 'open' });
    expect(c.headers.etag).toBe('"0"');
    const noMatch = keep(
      await owner.patch(
        `${base()}/today/${today}/items/${task}`,
        { locked: true },
        { headers: key() },
      ),
    );
    expect(noMatch.statusCode).toBe(428);
    const lock = keep(
      await owner.patch(
        `${base()}/today/${today}/items/${task}`,
        { locked: true },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(lock.statusCode, lock.body).toBe(200);
    expect(lock.headers.etag).toBe('"1"');
    const v = keep(await owner.get(`${base()}/today/${today}`));
    expect(v.json().data).toMatchObject({
      type: 'today_view',
      day: today,
      committed: [expect.objectContaining({ locked: true })],
    });
    const plan = keep(await owner.get(`${base()}/today/today/plan`));
    expect(plan.json().data).toMatchObject({ type: 'day_plan', committed: [task] });
    const down = keep(
      await owner.post(`${base()}/today/${today}:shutdown`, { items: [] }, { headers: key() }),
    );
    expect(down.statusCode, down.body).toBe(200);
    expect(down.json().data).toMatchObject({
      type: 'daily_record',
      closed_by: 'shutdown',
      committed: 1,
      dropped: 1,
    });
    const recs = keep(await owner.get(`${base()}/daily-records`));
    expect(recs.json().data).toMatchObject({
      type: 'daily_records',
      records: [expect.objectContaining({ day: today })],
    });
    const one = keep(await owner.get(`${base()}/daily-records/${today}`));
    expect(one.json().data.items).toEqual([
      expect.objectContaining({ task: { id: task, title: 'Write plan' }, outcome: 'dropped' }),
    ]);
    expect(
      keep(await owner.post(`${base()}/today/${today}:explode`, {}, { headers: key() })).statusCode,
    ).toBe(404);
  });

  it('creates, moves, and deletes blocks and series as resources', async () => {
    const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const b = keep(
      await owner.post(
        `${base()}/work-blocks`,
        { task, starts_at: `${day}T09:00:00Z`, duration_minutes: 60, focus: true, tz: 'UTC' },
        { headers: key() },
      ),
    );
    expect(b.statusCode, b.body).toBe(201);
    const blk = b.json().data;
    expect(blk.id).toMatch(/^blk_/);
    expect(b.headers.etag).toBe('"0"');
    const est = keep(
      await owner.post(
        `${base()}/work-blocks/from-estimate`,
        { task, starts_at: `${day}T13:00:00Z` },
        { headers: key() },
      ),
    );
    expect(est.json().data).toMatchObject({ minutes: 45, focus: true, source: 'estimate' });
    const mv = keep(
      await owner.patch(
        `${base()}/work-blocks/${blk.id}`,
        { starts_at: `${day}T10:00:00Z`, duration_minutes: 30 },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(mv.statusCode, mv.body).toBe(200);
    const list = keep(await owner.get(`${base()}/work-blocks?from=${day}&to=${day}`));
    expect(list.json().data.map((x: { id: string }) => x.id)).toContain(blk.id);
    const del = keep(
      await owner.delete(`${base()}/work-blocks/${blk.id}`, {
        headers: key({ 'if-match': '"1"' }),
      }),
    );
    expect(del.statusCode, del.body).toBe(200);
    const s = keep(
      await owner.post(
        `${base()}/block-series`,
        {
          title: 'Admin',
          rule: { frequency: 'weekly', weekdays: ['FR'] },
          start_date: day,
          start_time: '16:00',
          duration_minutes: 30,
          tz: 'UTC',
        },
        { headers: key() },
      ),
    );
    expect(s.statusCode, s.body).toBe(201);
    expect(s.json().data.id).toMatch(/^bls_/);
    const end = keep(
      await owner.post(
        `${base()}/block-series/${s.json().data.id}:end`,
        {},
        { headers: key({ 'if-match': `"${s.json().data.version}"` }) },
      ),
    );
    expect(end.json().data.state).toBe('ended');
  });

  it('gives strangers the same not_found everywhere and never returns internal UUIDs', async () => {
    for (const [method, path, body] of [
      ['get', `${base()}/today/today`, undefined],
      ['post', `${base()}/today/${today}/items`, { task }],
      ['get', `${base()}/work-blocks`, undefined],
      [
        'post',
        `${base()}/work-blocks`,
        { title: 'x', starts_at: `${today}T09:00:00Z`, duration_minutes: 30 },
      ],
      ['get', `${base()}/daily-records`, undefined],
      ['get', `${base()}/block-series`, undefined],
    ] as const) {
      const r = keep(
        method === 'get'
          ? await stranger.get(path)
          : await stranger.post(path, body, { headers: key() }),
      );
      expect(r.statusCode, path).toBe(404);
    }
    for (const b of bodies) expect(b).not.toMatch(UUID);
  });
});
