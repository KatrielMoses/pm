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
 * 2E HTTP surface (ADR-0017): capture preview (non-resource), capture, the Inbox, triage and merge
 * previews and commands, notes and conversion, intake forms, and non-disclosure for strangers.
 */
describe('capture API (2E)', () => {
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
    owner = await person('cap-owner@example.test', '203.0.113.110');
    stranger = await person('cap-stranger@example.test', '203.0.113.111');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Capture',
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

  it('previews, captures, lists, triages, merges, and converts', async () => {
    const pv = keep(
      await owner.post(`${base()}/capture/preview`, {
        mode: 'paste',
        text: '- A tomorrow\n- B !high',
      }),
    );
    expect(pv.statusCode, pv.body).toBe(200);
    expect(pv.json().data).toMatchObject({ type: 'capture_preview', parser_version: 1, ai: false });
    expect(pv.json().data.candidates).toHaveLength(2);
    const c = keep(
      await owner.post(
        `${base()}/capture`,
        { items: [{ text: 'A tomorrow' }, { text: 'B !high' }] },
        { headers: key() },
      ),
    );
    expect(c.statusCode, c.body).toBe(201);
    const [a, b] = c.json().data.items.map((i: { id: string }) => i.id);
    expect(a).toMatch(/^inb_/);
    const list = keep(await owner.get(`${base()}/inbox`));
    expect(list.json().data.map((i: { id: string }) => i.id)).toEqual(
      expect.arrayContaining([a, b]),
    );
    const one = keep(await owner.get(`${base()}/inbox/${a}`));
    expect(one.json().data).toMatchObject({
      type: 'inbox_item',
      raw_text: 'A tomorrow',
      source: { kind: 'paste' },
    });
    const tp = keep(
      await owner.post(`${base()}/inbox-triage/preview`, { items: [a], to: 'task', brand }),
    );
    expect(tp.json().data).toMatchObject({
      type: 'triage_preview',
      items: [expect.objectContaining({ outcome: 'ready' })],
    });
    const tr = keep(
      await owner.post(
        `${base()}/inbox-triage`,
        { items: [a], to: 'task', brand },
        { headers: key() },
      ),
    );
    expect(tr.statusCode, tr.body).toBe(200);
    expect(tr.json().data.items[0]).toMatchObject({
      outcome: 'applied',
      record: expect.stringMatching(/^tsk_/),
    });
    const n = keep(
      await owner.post(`${base()}/capture`, { intent: 'note', text: 'Idea' }, { headers: key() }),
    );
    const note = n.json().data.items[0].note;
    expect(
      keep(await owner.get(`${base()}/notes`))
        .json()
        .data.map((x: { id: string }) => x.id),
    ).toContain(note);
    const cv = keep(
      await owner.post(
        `${base()}/notes/${note}:convert`,
        { to: 'task', brand, confirm: true },
        { headers: key() },
      ),
    );
    expect(cv.statusCode, cv.body).toBe(201);
    const x = keep(
      await owner.post(`${base()}/capture`, { text: 'dup one' }, { headers: key() }),
    ).json().data.id;
    const mp = keep(await owner.post(`${base()}/inbox-merge/preview`, { items: [b, x], keep: b }));
    expect(mp.json().data).toMatchObject({ type: 'merge_preview', keep: b });
    const mg = keep(
      await owner.post(`${base()}/inbox-merge`, { items: [b, x], keep: b }, { headers: key() }),
    );
    expect(mg.statusCode, mg.body).toBe(200);
    expect(
      keep(await owner.post(`${base()}/inbox/${x}:restore`, {}, { headers: key() })).statusCode,
    ).toBe(200);
  });

  it('intake forms over HTTP; strangers and guessed IDs get the same not_found; no internal UUIDs', async () => {
    const f = keep(
      await owner.post(`${base()}/intake-forms`, { brand, name: 'Requests' }, { headers: key() }),
    );
    expect(f.statusCode, f.body).toBe(201);
    const form = f.json().data.id;
    expect(form).toMatch(/^form_/);
    const s = keep(
      await owner.post(
        `${base()}/intake-forms/${form}:submit`,
        { title: 'Need help' },
        { headers: key() },
      ),
    );
    expect(s.json().data).toEqual({ id: form, type: 'intake_form', received: true });
    const item = keep(
      await owner.post(`${base()}/capture`, { text: 'private' }, { headers: key() }),
    ).json().data.id;
    for (const [method, path, body] of [
      ['get', `${base()}/inbox/${item}`, undefined],
      ['get', `${base()}/inbox/inb_01J0000000000000000000000Z`, undefined],
      ['post', `${base()}/capture`, { text: 'x' }],
      ['get', `${base()}/intake-forms/${form}`, undefined],
      ['post', `${base()}/intake-forms/${form}:submit`, { title: 'x' }],
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
