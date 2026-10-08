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
const para = (id: string, text: string) => ({ id, type: 'paragraph', runs: [{ text }] });

/**
 * 4D HTTP surface (ADR-0027; 0D PL-37): the live editing session, ordered operations, the long poll,
 * heartbeat, checkpoint, and leave. Every call re-checks the document's level, strangers see the
 * same 404, nothing is cached, and no internal identifier appears in any response.
 */
describe('live editing API (4D)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let member: Browser;
  let reader: Browser;
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
  let n = 0;
  const opId = () => `api_${(n += 1)}_${Math.random().toString(36).slice(2, 8)}`;

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
  const newDoc = async () => {
    const made = keep(
      await owner.post(`${base()}/documents`, { title: 'Live', brand }, { headers: key() }),
    );
    expect(made.statusCode, made.body).toBe(201);
    const d = made.json().data;
    const saved = keep(
      await owner.put(
        `${base()}/documents/${d.id}/content`,
        {
          base_version: d.content_version,
          content: { v: 2, blocks: [para('blk_a', 'Alpha'), para('blk_b', 'Beta')] },
        },
        { headers: key() },
      ),
    );
    expect(saved.statusCode, saved.body).toBe(200);
    return saved.json().data;
  };
  const live = (doc: string, rest: string) => `${base()}/documents/${doc}/live/${rest}`;

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('live-owner@example.test', '203.0.113.180');
    stranger = await person('live-stranger@example.test', '203.0.113.181');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Live',
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
    member = await invite(
      'live-member@example.test',
      { kind: 'member', role: 'administrator' },
      '203.0.113.182',
    );
    reader = await invite(
      'live-reader@example.test',
      { kind: 'member', role: 'read_only' },
      '203.0.113.183',
    );
  });
  afterAll(async () => {
    expect(bodies.some((b) => UUID.test(b))).toBe(false);
    await env.close();
  });

  it('runs a live session end to end: join, operate, poll, heartbeat, checkpoint, leave', async () => {
    const d = await newDoc();
    const j = keep(await owner.post(live(d.id, 'session'), {}));
    expect(j.statusCode, j.body).toBe(201);
    const a = j.json().data;
    expect(a).toMatchObject({
      type: 'live_session',
      mode: 'edit',
      seq: 0,
      base_version: 2,
      dirty: false,
    });
    expect(a.session).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(a.content.blocks.map((b: any) => b.id)).toEqual(['blk_a', 'blk_b']);
    const m = keep(await member.post(live(d.id, 'session'), {}));
    expect(m.statusCode, m.body).toBe(201);
    const b = m.json().data;
    // The second editor sees the first by name.
    expect(b.presence.filter((p: any) => !p.you)).toHaveLength(1);

    const op = keep(
      await owner.post(live(d.id, 'operations'), {
        session: a.session,
        after: 0,
        ops: [
          {
            op_id: opId(),
            kind: 'replace',
            base_hash: a.hashes.blk_a,
            block: para('blk_a', 'Alpha 1'),
          },
        ],
      }),
    );
    expect(op.statusCode, op.body).toBe(200);
    expect(op.json().data).toMatchObject({ type: 'live_update', seq: 1, rejected: [] });
    const poll = keep(await member.get(`${live(d.id, 'events')}?session=${b.session}&after=0`));
    expect(poll.statusCode, poll.body).toBe(200);
    expect(poll.headers['cache-control']).toBe('no-store');
    expect(poll.json().data.events).toEqual([
      expect.objectContaining({ seq: 1, kind: 'replace', block_id: 'blk_a' }),
    ]);
    // The other editor's stale write is refused with the current block.
    const lost = keep(
      await member.post(live(d.id, 'operations'), {
        session: b.session,
        after: 0,
        ops: [
          {
            op_id: opId(),
            kind: 'replace',
            base_hash: b.hashes.blk_a,
            block: para('blk_a', 'Alpha 2'),
          },
        ],
      }),
    );
    expect(lost.json().data.rejected).toEqual([
      expect.objectContaining({
        code: 'block_changed',
        current: expect.objectContaining({ id: 'blk_a' }),
      }),
    ]);
    const hb = keep(
      await owner.post(live(d.id, 'heartbeat'), { session: a.session, caret: 'blk_b' }),
    );
    expect(hb.statusCode, hb.body).toBe(200);
    expect(hb.json().data.presence.find((p: any) => p.you).caret_block).toBe('blk_b');
    // A plain save while someone edits live is a 409 with a stable code.
    const plain = keep(
      await member.put(
        `${base()}/documents/${d.id}/content`,
        { base_version: 2, content: { v: 2, blocks: [para('blk_a', 'Plain')] } },
        { headers: key() },
      ),
    );
    expect(plain.statusCode).toBe(409);
    expect(
      plain.json().errors?.[0]?.code ?? plain.json().issues?.[0]?.code ?? plain.body,
    ).toContain('live_edit_in_progress');
    const cp = keep(await owner.post(live(d.id, 'checkpoint'), { session: a.session }));
    expect(cp.json().data).toMatchObject({
      type: 'live_update',
      saved: true,
      content_version: 3,
      dirty: false,
    });
    const read = keep(await owner.get(`${base()}/documents/${d.id}`));
    expect(read.json().data.content_version).toBe(3);
    expect(read.json().data.content.blocks[0].runs[0].text).toBe('Alpha 1');
    for (const [who, s] of [
      [owner, a.session],
      [member, b.session],
    ] as const) {
      const left = keep(await who.post(live(d.id, 'leave'), { session: s }));
      expect(left.statusCode, left.body).toBe(200);
      expect(left.json().data.left).toBe(true);
    }
  });

  it('lets a member only watch, and gives unreadable-document callers, strangers, and the signed-out the same 404/401', async () => {
    const d = await newDoc();
    // A member who asks only to watch gets a view session that cannot write.
    const w = keep(await member.post(live(d.id, 'session'), { mode: 'view' }));
    expect(w.statusCode, w.body).toBe(201);
    expect(w.json().data.mode).toBe('view');
    const o = keep(await owner.post(live(d.id, 'session'), {}));
    const w2 = w.json().data;
    const denied = keep(
      await member.post(live(d.id, 'operations'), {
        session: w2.session,
        after: 0,
        ops: [{ op_id: opId(), kind: 'insert', after: null, block: para('blk_n', 'n') }],
      }),
    );
    expect(denied.statusCode).toBe(409);
    expect(denied.body).toContain('session_read_only');
    // Someone who cannot read the document is told exactly what a stranger is told.
    const unread = keep(await reader.post(live(d.id, 'session'), {}));
    expect(unread.statusCode).toBe(404);
    expect(keep(await reader.get(`${base()}/documents/${d.id}`)).statusCode).toBe(404);
    expect(keep(await reader.post(live(d.id, 'session'), { mode: 'edit' })).statusCode).toBe(404);
    const s = keep(await stranger.post(live(d.id, 'session'), {}));
    const missing = keep(
      await stranger.post(live('doc_00000000000000000000000000', 'session'), {}),
    );
    expect(s.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    const shape = (r: LightMyRequestResponse) => {
      const { request_id: _r, correlation_id: _c, ...rest } = r.json().error;
      return rest;
    };
    expect(shape(s)).toEqual(shape(missing));
    const anon = new Browser(env.app);
    expect(keep(await anon.post(live(d.id, 'session'), {})).statusCode).toBe(401);
    expect(
      keep(await anon.get(`${live(d.id, 'events')}?session=${o.json().data.session}&after=0`))
        .statusCode,
    ).toBe(401);
    await member.post(live(d.id, 'leave'), { session: w2.session });
    await owner.post(live(d.id, 'leave'), { session: o.json().data.session });
  });

  it('refuses malformed input with pointer-precise issues and never echoes it', async () => {
    const d = await newDoc();
    const a = keep(await owner.post(live(d.id, 'session'), {})).json().data;
    const bad = keep(
      await owner.post(live(d.id, 'operations'), {
        session: 'sEcReTv4lue',
        after: -1,
        ops: [{ kind: 'nope' }],
        extra: 1,
      }),
    );
    expect(bad.statusCode).toBe(422);
    expect(bad.body).not.toContain('sEcReTv4lue');
    const none = keep(
      await owner.post(live(d.id, 'operations'), { session: a.session, after: 0, ops: [] }),
    );
    expect(none.statusCode).toBe(422);
    const ev = keep(await owner.get(`${live(d.id, 'events')}?session=${a.session}`));
    expect(ev.statusCode).toBe(422);
    const gone = keep(await owner.post(live(d.id, 'heartbeat'), { session: 'A'.repeat(24) }));
    expect(gone.statusCode).toBe(409);
    await owner.post(live(d.id, 'leave'), { session: a.session });
  });
});
