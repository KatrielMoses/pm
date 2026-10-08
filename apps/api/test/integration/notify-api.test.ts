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
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const publicId = (prefix: string, n: number) =>
  `${prefix}_${CROCKFORD[n % 32]}${'0'.repeat(24)}${CROCKFORD[Math.floor(n / 32) % 32]}`;

/**
 * 4B HTTP surface (ADR-0024; 0D PL-34): the caller's own notifications, counts, state changes,
 * profile, preferences, deliveries, and browser channel; administrator delivery health; and
 * brand defaults. Strangers get the same 404 as an unknown record, unsafe requests need an
 * idempotency key, versioned edits need If-Match, and no internal identifier leaves the API.
 */
describe('notification API (4B)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let member: Browser;
  let stranger: Browser;
  let ws: string;
  let brand: string;
  let memberMem: string;
  let ownerMem: string;
  let task: string;
  const bodies: string[] = [];
  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const key = (extra: Record<string, string> = {}) => ({ 'idempotency-key': idemKey(), ...extra });
  const base = () => `/v1/workspaces/${ws}`;
  const sql = async (text: string) =>
    (await env.db.admin(text)).rows as Array<Record<string, unknown>>;

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }
  const seed = async (who: string, id: string, type: string, state = 'unread') => {
    await sql(`INSERT INTO notify.notification (id, public_id, workspace_id, recipient_membership_id, type, record_id, dedupe_key, state)
      SELECT gen_random_uuid(), '${id}', m.workspace_id, m.id, '${type}', r.id, '${type}|${id}', '${state}'
        FROM tenancy.membership m, core.record r WHERE m.public_id = '${who}' AND r.public_id = '${task}'`);
  };

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('ntf-owner@example.test', '203.0.113.160');
    stranger = await person('ntf-stranger@example.test', '203.0.113.161');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Notify',
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
    const inv = await owner.post(
      `${base()}/invitations`,
      { email: 'ntf-member@example.test', kind: 'member', role: 'member' },
      { headers: key() },
    );
    expect(inv.statusCode, inv.body).toBe(201);
    await env.deliverMail();
    const token = tokenFrom(mailTo(env, 'ntf-member@example.test', 'invited').at(-1));
    member = await person('ntf-member@example.test', '203.0.113.162');
    await member.post('/v1/invitations:accept', { token }, { headers: key() });
    const people = (await owner.get(`${base()}/people`)).json().data as Array<{
      id: string;
      email?: string;
      account?: { email?: string };
    }>;
    const idOf = (e: string) => people.find((x) => (x.email ?? x.account?.email) === e)!.id;
    memberMem = idOf('ntf-member@example.test');
    ownerMem = idOf('ntf-owner@example.test');
    const t = await owner.post(
      `${base()}/tasks`,
      { brand, title: 'Quarterly plan' },
      { headers: key() },
    );
    task = t.json().data.id;
    for (let i = 0; i < 3; i++) await seed(ownerMem, publicId('ntf', i + 1), 'mention');
    await seed(ownerMem, publicId('ntf', 9), 'comment', 'read');
    await seed(memberMem, publicId('ntf', 20), 'assignment');
  });
  afterAll(async () => {
    expect(bodies.some((b) => UUID.test(b))).toBe(false);
    await env.close();
  });

  it('lists, counts, and reads only the caller’s own notifications, hiding others as unknown', async () => {
    const list = keep(await owner.get(`${base()}/me/notifications?limit=2`));
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data).toHaveLength(2);
    expect(list.json().page).toMatchObject({ limit: 2, has_more: true });
    expect(list.json().data[0]).toMatchObject({
      type: 'notification',
      notification_type: expect.any(String),
      available: true,
    });
    expect(list.json().data[0].record.title).toBe('Quarterly plan');
    const counts = keep(await owner.get(`${base()}/me/notifications/counts`));
    expect(counts.json().data).toMatchObject({ type: 'notification_counts', unread: 3, saved: 0 });
    const mine = list.json().data[0].id as string;
    expect((await member.get(`${base()}/me/notifications/${mine}`)).statusCode).toBe(404);
    expect((await member.get(`${base()}/me/notifications`)).json().data).toHaveLength(1);
    expect((await stranger.get(`${base()}/me/notifications`)).statusCode).toBe(404);
    const one = keep(await owner.get(`${base()}/me/notifications/${mine}`));
    expect(one.statusCode).toBe(200);
    expect(one.headers.etag).toBe('"0"');
    const search = keep(await owner.get(`${base()}/me/notifications?q=Quarterly&tab=all`));
    expect(search.json().data.length).toBeGreaterThan(0);
    expect((await owner.get(`${base()}/me/notifications?q=Nothing%20matches`)).json().data).toEqual(
      [],
    );
  });

  it('changes state with If-Match, replays idempotently, and acts in bulk', async () => {
    const id = publicId('ntf', 1);
    const noKey = keep(
      await owner.patch(
        `${base()}/me/notifications/${id}`,
        { state: 'read' },
        { headers: { 'if-match': '"0"' } },
      ),
    );
    expect(noKey.statusCode).toBe(422);
    const k = key({ 'if-match': '"0"' });
    const read = keep(
      await owner.patch(`${base()}/me/notifications/${id}`, { state: 'read' }, { headers: k }),
    );
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().data).toMatchObject({ id, state: 'read' });
    expect(read.headers.etag).toBe('"1"');
    const replay = keep(
      await owner.patch(`${base()}/me/notifications/${id}`, { state: 'read' }, { headers: k }),
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const stale = keep(
      await owner.patch(
        `${base()}/me/notifications/${id}`,
        { state: 'saved' },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(stale.statusCode).toBe(409);
    expect(
      (
        await member.patch(
          `${base()}/me/notifications/${id}`,
          { state: 'dismissed' },
          { headers: key({ 'if-match': '"1"' }) },
        )
      ).statusCode,
    ).toBe(404);
    const bad = keep(
      await owner.patch(
        `${base()}/me/notifications/${id}`,
        { state: 'bogus' },
        { headers: key({ 'if-match': '"1"' }) },
      ),
    );
    expect(bad.statusCode).toBe(422);
    const bulk = keep(
      await owner.post(
        `${base()}/me/notification-bulk`,
        { all: true, state: 'read' },
        { headers: key() },
      ),
    );
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect(bulk.json().data).toMatchObject({ type: 'notification_update', updated: 2 });
    expect((await owner.get(`${base()}/me/notifications/counts`)).json().data.unread).toBe(0);
  });

  it('reads and replaces the profile with If-Match and reports channels truthfully', async () => {
    const got = keep(await owner.get(`${base()}/me/notification-profile`));
    expect(got.statusCode).toBe(200);
    expect(got.json().data).toMatchObject({
      type: 'notification_profile',
      digest_cadence: 'daily',
    });
    expect(got.json().data.channels.email.state).toBe('available');
    const v = got.headers.etag as string;
    expect(
      (
        await owner.put(
          `${base()}/me/notification-profile`,
          { digest_cadence: 'weekly' },
          { headers: key() },
        )
      ).statusCode,
    ).toBe(428);
    const put = keep(
      await owner.put(
        `${base()}/me/notification-profile`,
        {
          digest_cadence: 'daily',
          daily_digest_time: '08:30',
          quiet_hours: { start: '22:00', end: '07:00' },
        },
        { headers: key({ 'if-match': v }) },
      ),
    );
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().data).toMatchObject({ digest_cadence: 'daily' });
    expect(
      (
        await owner.put(
          `${base()}/me/notification-profile`,
          { quiet_hours: { start: '25:00', end: '07:00' } },
          { headers: key({ 'if-match': put.headers.etag as string }) },
        )
      ).statusCode,
    ).toBe(422);
  });

  it('sets, lists, and removes preferences and mutes for scopes the caller can open', async () => {
    const set = keep(
      await owner.put(
        `${base()}/me/notification-preferences`,
        { event_type: 'comment', scope: brand, channel: 'email', mode: 'muted' },
        { headers: key() },
      ),
    );
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().data).toMatchObject({ type: 'notification_preference', mode: 'muted' });
    const list = keep(await owner.get(`${base()}/me/notification-preferences`));
    expect(list.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ event_type: 'comment', mode: 'muted' })]),
    );
    expect(list.json().defaults.length).toBeGreaterThan(5);
    const hidden = keep(
      await member.put(
        `${base()}/me/notification-preferences`,
        { event_type: 'comment', scope: `prj_${'0'.repeat(26)}`, channel: 'email', mode: 'muted' },
        { headers: key() },
      ),
    );
    expect(hidden.statusCode).toBe(422);
    const gone = keep(
      await owner.delete(
        `${base()}/me/notification-preferences?event_type=comment&scope=${brand}&channel=email`,
        {
          headers: key(),
        },
      ),
    );
    expect(gone.statusCode).toBe(200);
    expect(gone.json().data).toMatchObject({ removed: 1 });
  });

  it('shows the caller’s deliveries and the browser channel, and gives administrators delivery health', async () => {
    expect((await owner.get(`${base()}/me/notification-deliveries`)).json().data).toEqual([]);
    expect((await owner.get(`${base()}/me/notifications/browser-pending`)).json().data).toEqual([]);
    const gone = keep(
      await owner.post(
        `${base()}/me/notification-deliveries/ndl_${'0'.repeat(26)}/ack`,
        { outcome: 'shown' },
        { headers: key() },
      ),
    );
    expect(gone.statusCode).toBe(404);
    const health = keep(await owner.get(`${base()}/notification-deliveries`));
    expect(health.statusCode, health.body).toBe(200);
    expect(health.json().email).toBeDefined();
    expect((await member.get(`${base()}/notification-deliveries`)).statusCode).toBe(403);
    expect(
      (
        await member.post(
          `${base()}/notification-deliveries/ndl_${'0'.repeat(26)}/retry`,
          undefined,
          { headers: key() },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await owner.post(
          `${base()}/notification-deliveries/ndl_${'0'.repeat(26)}/retry`,
          undefined,
          { headers: key() },
        )
      ).statusCode,
    ).toBe(404);
  });

  it('lets administrators set brand defaults and refuses everyone else', async () => {
    const put = keep(
      await owner.put(
        `${base()}/brands/${brand}/notification-defaults`,
        { event_type: 'comment', channel: 'email', mode: 'muted' },
        { headers: key() },
      ),
    );
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().data).toMatchObject({ type: 'notification_default', mode: 'muted' });
    const list = keep(await owner.get(`${base()}/brands/${brand}/notification-defaults`));
    expect(list.json().data).toEqual([{ event_type: 'comment', channel: 'email', mode: 'muted' }]);
    expect(
      (
        await member.put(
          `${base()}/brands/${brand}/notification-defaults`,
          { event_type: 'comment', channel: 'email', mode: 'immediate' },
          { headers: key() },
        )
      ).statusCode,
    ).toBe(404);
    expect((await stranger.get(`${base()}/brands/${brand}/notification-defaults`)).statusCode).toBe(
      404,
    );
    const del = keep(
      await owner.delete(
        `${base()}/brands/${brand}/notification-defaults?event_type=comment&channel=email`,
        {
          headers: key(),
        },
      ),
    );
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json().data).toMatchObject({ removed: 1 });
  });
});
