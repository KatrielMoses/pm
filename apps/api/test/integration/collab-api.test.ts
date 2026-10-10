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

/**
 * 4A HTTP surface (ADR-0023; 0D PL-33): comments, replies, reactions, mention candidates,
 * following, reviews and their verbs, delegation, and assignment history as resources (`cmt_`,
 * `rvw_`) and the closed non-resource summary; ETags and If-Match on edits; idempotent replays;
 * and the same 404 for strangers. No internal identifiers anywhere in a response.
 */
describe('collaboration API (4A)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let admin: Browser;
  let guest: Browser;
  let readGuest: Browser;
  let stranger: Browser;
  let ws: string;
  let brand: string;
  let adminMem: string;
  let task: { id: string; version: number };
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

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('col-owner@example.test', '203.0.113.150');
    stranger = await person('col-stranger@example.test', '203.0.113.151');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Collab',
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
    admin = await invite(
      'col-admin@example.test',
      { kind: 'member', role: 'administrator' },
      '203.0.113.152',
    );
    const t = await owner.post(
      `${base()}/tasks`,
      { brand, title: 'Shared plan' },
      { headers: key() },
    );
    task = { id: t.json().data.id, version: t.json().data.version };
    guest = await invite(
      'col-guest@example.test',
      { kind: 'guest', records: [{ record: task.id, level: 'comment' }] },
      '203.0.113.153',
    );
    readGuest = await invite(
      'col-readguest@example.test',
      { kind: 'guest', records: [{ record: task.id, level: 'read' }] },
      '203.0.113.154',
    );
    const people = (await owner.get(`${base()}/people`)).json().data as Array<{
      id: string;
      email?: string;
      account?: { email?: string };
    }>;
    adminMem = people.find((x) => (x.email ?? x.account?.email) === 'col-admin@example.test')!.id;
  });
  afterAll(async () => {
    await env.close();
  });

  it('posts, replies, lists, edits with If-Match, and deletes a comment over HTTP', async () => {
    const c = keep(
      await owner.post(
        `${base()}/records/${task.id}/comments`,
        { text: 'Kickoff notes' },
        { headers: key() },
      ),
    );
    expect(c.statusCode, c.body).toBe(201);
    const root = c.json().data;
    expect(root).toMatchObject({
      type: 'comment',
      text: 'Kickoff notes',
      host: { id: task.id, type: 'task' },
    });
    expect(root.id).toMatch(/^cmt_/);
    expect(c.headers.etag).toBe('"0"');
    // An idempotent replay returns the same comment and says so.
    const k = key();
    const first = await admin.post(
      `${base()}/records/${task.id}/comments`,
      { text: 'Reply once', reply_to: root.id },
      { headers: k },
    );
    const replay = keep(
      await admin.post(
        `${base()}/records/${task.id}/comments`,
        { text: 'Reply once', reply_to: root.id },
        { headers: k },
      ),
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().data.id).toBe(first.json().data.id);
    const list = keep(await owner.get(`${base()}/records/${task.id}/comments`));
    expect(list.json()).toMatchObject({
      data: [expect.objectContaining({ id: root.id, reply_count: 1, replies_more: false })],
      page: { has_more: false, total: 2 },
    });
    const replies = keep(await owner.get(`${base()}/comments/${root.id}/replies`));
    expect(replies.json().data).toHaveLength(1);
    // Edits need the version; the author's window and trail apply.
    const noMatch = keep(
      await owner.patch(
        `${base()}/comments/${root.id}`,
        { text: 'Kickoff notes v2' },
        { headers: key() },
      ),
    );
    expect(noMatch.statusCode).toBe(428);
    const edited = keep(
      await owner.patch(
        `${base()}/comments/${root.id}`,
        { text: 'Kickoff notes v2' },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.headers.etag).toBe('"1"');
    const stale = keep(
      await owner.patch(
        `${base()}/comments/${root.id}`,
        { text: 'Kickoff notes v3' },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.conflict).toMatchObject({ current_version: 1 });
    const other = keep(
      await admin.patch(
        `${base()}/comments/${root.id}`,
        { text: 'Hijack' },
        { headers: key({ 'if-match': '"1"' }) },
      ),
    );
    expect(other.statusCode).toBe(403);
    const trail = keep(await owner.get(`${base()}/comments/${root.id}/revisions`));
    expect(trail.json().data).toMatchObject([
      { revision: 1, kind: 'edited', text: 'Kickoff notes' },
    ]);
    const gone = keep(await owner.delete(`${base()}/comments/${root.id}`, { headers: key() }));
    expect(gone.statusCode).toBe(200);
    expect(gone.json().data).toMatchObject({ deleted: true, text: null, deleted_by: 'author' });
    const invalid = keep(
      await owner.post(
        `${base()}/records/${task.id}/comments`,
        { text: '   ' },
        { headers: key() },
      ),
    );
    expect(invalid.statusCode).toBe(422);
  });

  it('reacts idempotently from a fixed vocabulary and exposes mention candidates', async () => {
    const c = (
      await owner.post(
        `${base()}/records/${task.id}/comments`,
        { text: 'React here' },
        { headers: key() },
      )
    ).json().data;
    const on = keep(
      await admin.put(`${base()}/comments/${c.id}/reactions/thumbs_up`, undefined, {
        headers: key(),
      }),
    );
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().data.reactions).toEqual([{ reaction: 'thumbs_up', count: 1, mine: true }]);
    const again = keep(
      await admin.put(`${base()}/comments/${c.id}/reactions/thumbs_up`, undefined, {
        headers: key(),
      }),
    );
    expect(again.json().data.reactions[0].count).toBe(1);
    expect(
      (
        await admin.delete(`${base()}/comments/${c.id}/reactions/thumbs_up`, { headers: key() })
      ).json().data.reactions,
    ).toEqual([]);
    expect(
      (await admin.put(`${base()}/comments/${c.id}/reactions/skull`, undefined, { headers: key() }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await readGuest.put(`${base()}/comments/${c.id}/reactions/heart`, undefined, {
          headers: key(),
        })
      ).statusCode,
    ).toBe(403);
    const cand = keep(await owner.get(`${base()}/records/${task.id}/mention-candidates?q=`));
    expect(cand.statusCode, cand.body).toBe(200);
    expect(cand.json().data.map((x: { kind: string; id: string }) => x.id)).toContain(adminMem);
    const mentioned = keep(
      await owner.post(
        `${base()}/records/${task.id}/comments`,
        { text: 'Hi @admin', mentions: [{ kind: 'member', id: adminMem }] },
        { headers: key() },
      ),
    );
    expect(mentioned.json().data.mentions).toEqual([
      expect.objectContaining({ kind: 'member', id: adminMem }),
    ]);
    const bad = keep(
      await guest.post(
        `${base()}/records/${task.id}/comments`,
        { text: 'x', mentions: [{ kind: 'member', id: adminMem }] },
        { headers: key() },
      ),
    );
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.issues).toEqual([
      expect.objectContaining({ code: 'not_mentionable', pointer: '/mentions/0' }),
    ]);
  });

  it('follows with PUT and DELETE, and lists what the person follows', async () => {
    const s0 = keep(await admin.get(`${base()}/records/${task.id}/collaboration`));
    expect(s0.json().data).toMatchObject({
      type: 'collaboration_summary',
      following: false,
      record: { id: task.id, type: 'task' },
      capabilities: { comment: true, follow: true },
    });
    expect(s0.json().data).not.toHaveProperty('id');
    const on = keep(
      await admin.put(`${base()}/records/${task.id}/follow`, undefined, { headers: key() }),
    );
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().data).toMatchObject({ type: 'collaboration_summary', following: true });
    const list = keep(await admin.get(`${base()}/me/following`));
    expect(list.json().data).toEqual([
      expect.objectContaining({ id: task.id, type: 'task', title: 'Shared plan' }),
    ]);
    const followers = keep(await owner.get(`${base()}/records/${task.id}/followers`));
    expect(followers.json().data).toEqual([expect.objectContaining({ id: adminMem })]);
    expect((await readGuest.get(`${base()}/records/${task.id}/followers`)).statusCode).toBe(404);
    const off = keep(await admin.delete(`${base()}/records/${task.id}/follow`, { headers: key() }));
    expect(off.json().data.following).toBe(false);
    expect((await admin.get(`${base()}/me/following`)).json().data).toEqual([]);
  });

  it('requests, decides, withdraws, and refreshes reviews through verbs', async () => {
    const t = (
      await owner.post(`${base()}/tasks`, { brand, title: 'Review me' }, { headers: key() })
    ).json().data;
    const r = keep(
      await owner.post(
        `${base()}/records/${t.id}/reviews`,
        { reviewers: [adminMem], kind: 'approval' },
        { headers: key() },
      ),
    );
    expect(r.statusCode, r.body).toBe(201);
    const review = r.json().data;
    expect(review).toMatchObject({ type: 'review_request', state: 'requested', kind: 'approval' });
    expect(review.id).toMatch(/^rvw_/);
    const queue = keep(await admin.get(`${base()}/me/reviews`));
    expect(queue.json().data).toEqual([
      expect.objectContaining({ id: review.id, mine_decision: null }),
    ]);
    const unknown = keep(
      await admin.post(`${base()}/reviews/${review.id}:vote`, {}, { headers: key() }),
    );
    expect(unknown.statusCode).toBe(404);
    const noVersion = keep(
      await admin.post(
        `${base()}/reviews/${review.id}:decide`,
        { outcome: 'approved' },
        { headers: key() },
      ),
    );
    expect(noVersion.statusCode).toBe(422);
    const current = (await owner.get(`${base()}/tasks/${t.id}`)).json().data.version;
    const done = keep(
      await admin.post(
        `${base()}/reviews/${review.id}:decide`,
        { outcome: 'approved', note: 'Ship it', subject_version: current },
        { headers: key() },
      ),
    );
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().data).toMatchObject({ state: 'approved' });
    const closed = keep(
      await admin.post(
        `${base()}/reviews/${review.id}:decide`,
        { outcome: 'rejected', subject_version: current },
        { headers: key() },
      ),
    );
    expect(closed.statusCode).toBe(409);
    const list = keep(await owner.get(`${base()}/records/${t.id}/reviews`));
    expect(list.json().data).toEqual([
      expect.objectContaining({ id: review.id, state: 'approved' }),
    ]);
    // A second request, withdrawn and refreshed.
    const again = (
      await owner.post(
        `${base()}/records/${t.id}/reviews`,
        { reviewers: [adminMem] },
        { headers: key() },
      )
    ).json().data;
    const withdrawn = keep(
      await owner.post(`${base()}/reviews/${again.id}:withdraw`, {}, { headers: key() }),
    );
    expect(withdrawn.json().data).toMatchObject({ state: 'withdrawn' });
    const fresh = keep(
      await owner.post(`${base()}/reviews/${again.id}:refresh`, undefined, { headers: key() }),
    );
    expect(fresh.statusCode).toBe(409);
    expect((await readGuest.get(`${base()}/reviews/${review.id}`)).statusCode).toBe(404);
  });

  it('delegates through the task verb and lists assignment history', async () => {
    const t = (
      await owner.post(`${base()}/tasks`, { brand, title: 'Hand off' }, { headers: key() })
    ).json().data;
    const me = (await owner.get(`${base()}/context`)).json().data;
    expect(me).toBeDefined();
    const ownerMem = (
      (await owner.get(`${base()}/people`)).json().data as Array<{
        id: string;
        email?: string;
        account?: { email?: string };
      }>
    ).find((x) => (x.email ?? x.account?.email) === 'col-owner@example.test')!.id;
    const assigned = keep(
      await owner.post(
        `${base()}/tasks/${t.id}:assign`,
        { assignees: [ownerMem], version: t.version },
        { headers: key() },
      ),
    );
    expect(assigned.statusCode, assigned.body).toBe(200);
    const delegated = keep(
      await owner.post(
        `${base()}/tasks/${t.id}:delegate`,
        { to: adminMem, note: 'Over to you' },
        { headers: key() },
      ),
    );
    expect(delegated.statusCode, delegated.body).toBe(200);
    expect(delegated.json().data.assignees.map((a: { id: string }) => a.id)).toEqual([adminMem]);
    const history = keep(await owner.get(`${base()}/tasks/${t.id}/assignment-history`));
    expect(history.json().data.map((e: { kind: string }) => e.kind)).toEqual([
      'delegated',
      'assigned',
    ]);
    expect(history.json().data[0]).toMatchObject({
      note: 'Over to you',
      via: 'delegate',
      to: { id: adminMem },
    });
    const refused = keep(
      await owner.post(`${base()}/tasks/${t.id}:delegate`, { to: adminMem }, { headers: key() }),
    );
    expect(refused.statusCode).toBe(403);
  });

  it('gives strangers and unknown records the same 404, and never returns an internal identifier', async () => {
    const reads = [
      `${base()}/records/${task.id}/comments`,
      `${base()}/records/${task.id}/collaboration`,
      `${base()}/records/${task.id}/reviews`,
      `${base()}/records/${task.id}/mention-candidates`,
      `${base()}/records/tsk_${'0'.repeat(26)}/comments`,
      `${base()}/records/tsk_${'0'.repeat(26)}/reviews`,
      `${base()}/comments/cmt_${'0'.repeat(26)}`,
      `${base()}/reviews/rvw_${'0'.repeat(26)}`,
      `${base()}/tasks/${task.id}/assignment-history`,
    ];
    const shapes = new Set<string>();
    for (const url of reads) {
      const r = keep(await stranger.get(url));
      expect(r.statusCode, url).toBe(404);
      shapes.add(JSON.stringify(r.json().error.code));
    }
    expect(shapes.size).toBe(1);
    expect(
      (
        await stranger.post(
          `${base()}/records/${task.id}/comments`,
          { text: 'hi' },
          { headers: key() },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await stranger.put(`${base()}/records/${task.id}/follow`, undefined, { headers: key() }))
        .statusCode,
    ).toBe(404);
    for (const b of bodies) expect(b).not.toMatch(UUID);
  });
});
