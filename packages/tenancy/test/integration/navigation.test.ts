import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql } from '@pm/db';
import { createIdentityService, NoopRateLimiter, readPreferences } from '@pm/identity';
import {
  cleanupWorkspaceViews,
  defaultPersonalDataRegistry,
  deviceKeyHash,
  removePersonalReferences,
  viewsCleanupHandler,
  type Caller,
} from '@pm/tenancy';
import { RetentionPolicy } from '@pm/lifecycle';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  collabEnv,
  membershipOf,
  mutation,
  seedAccount,
  seedRecord,
  WORKSPACE_INPUT,
  workspaceIdOf,
  type CollabEnv,
} from './fixture.ts';

const NF = expect.objectContaining({ code: 'not_found' });
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const device = () => deviceKeyHash(randomBytes(32).toString('base64url'))!;

interface Ws {
  publicId: string;
  id: string;
  owner: Caller;
  main: string;
  mainId: string;
  secret: string;
  people: Record<string, Caller>;
  guest: Caller;
  guestRecord: string;
}

/**
 * Phase 1E personal navigation: favorites, recents, view state, scope tokens, and the palette's
 * record provider across three workspaces, all six roles, and a guest (AT-108…114).
 */
describe('personal navigation (1E)', () => {
  let db: TestDatabase;
  let env: CollabEnv;
  let tight: CollabEnv;
  const W: Record<'a' | 'b' | 'c', Ws> = {} as never;

  async function apply(as: Caller, ws: string, change: Record<string, unknown>) {
    const preview = await env.collab.previewChange(as, ws, change);
    env.stepUp.allow = true;
    try {
      return await env.collab.applyChange(
        as,
        ws,
        { change, preview_token: preview.preview_token },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
  }

  async function join(ws: string, owner: Caller, body: Record<string, unknown>): Promise<Caller> {
    const who = await seedAccount(db);
    await env.collab.invite(owner, ws, { email: who.auth.account.email, ...body }, mutation());
    await env.collab.acceptInvitation(
      who,
      { token: await env.tokenFor(who.auth.account.email) },
      mutation(),
    );
    return who;
  }

  /** Members, limited members, and read-only members see a brand only through a grant (1D). */
  async function grantView(
    ws: Ws | { publicId: string; id: string; owner: Caller; main: string },
    who: Caller,
  ) {
    const m = (await membershipOf(db, ws.id, who.auth.account.id))!;
    await apply(ws.owner, ws.publicId, {
      kind: 'brand_grant',
      brand: ws.main,
      principal: m.public_id,
      level: 'view',
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    env = collabEnv(db);
    tight = collabEnv(db, {
      views: { favoritesMax: 4, recentItemsMax: 3, recentVisitCoalesceMs: 60_000 },
    });
    for (const k of ['a', 'b', 'c'] as const) {
      const owner = await seedAccount(db);
      const created = await env.collab.createWorkspace(
        owner,
        { ...WORKSPACE_INPUT, name: `Nav-${k}`, first_brand: { name: `Main ${k}` } },
        mutation(),
      );
      const publicId = created.data.workspace.id;
      const id = await workspaceIdOf(db, publicId);
      const main = created.data.first_brand!.id;
      const secret = (
        await env.collab.createBrand(owner, publicId, { name: `Secret ${k}` }, mutation())
      ).data.id;
      env.stepUp.allow = true;
      await env.collab.setSensitivity(
        owner,
        publicId,
        secret,
        { is_sensitive: true },
        mutation({ ifMatch: '"0"', stepUpToken: 't' }),
      );
      env.stepUp.allow = false;
      const people: Record<string, Caller> = {};
      for (const role of ['administrator', 'member', 'limited_member', 'read_only'])
        people[role] = await join(publicId, owner, { kind: 'member', role });
      for (const role of ['member', 'read_only'])
        await grantView({ publicId, id, owner, main }, people[role]!);
      const mainId = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [main]))
        .rows[0].id as string;
      const rec = await seedRecord(db, id, mainId);
      const guest = await join(publicId, owner, {
        kind: 'guest',
        records: [{ record: rec.publicId, level: 'read' }],
      });
      W[k] = {
        publicId,
        id,
        owner,
        main,
        mainId,
        secret,
        people,
        guest,
        guestRecord: rec.publicId,
      };
    }
  });
  afterAll(async () => {
    await tight.h.close();
    await env.h.close();
    await db.drop();
  });

  it('favorites: idempotent add, stable order, reorder, remove; brand markers and public IDs only', async () => {
    const a = W.a;
    const t1 = (
      await env.collab.createTeam(a.owner, a.publicId, { name: 'Alpha team' }, mutation())
    ).data.id;
    const first = await env.collab.addFavorite(a.owner, a.publicId, a.main);
    expect(first.created).toBe(true);
    expect((await env.collab.addFavorite(a.owner, a.publicId, a.main)).created).toBe(false);
    await env.collab.addFavorite(a.owner, a.publicId, a.secret);
    await env.collab.addFavorite(a.owner, a.publicId, t1);
    let list = await env.collab.listFavorites(a.owner, a.publicId);
    expect(list.map((t) => t.id)).toEqual([a.main, a.secret, t1]);
    expect(list[0]).toMatchObject({
      type: 'brand',
      label: 'Main a',
      brand: { kind: 'brand', id: a.main, name: 'Main a', archived: false },
    });
    expect(list[2]).toMatchObject({ type: 'team', brand: { kind: 'workspace' } });
    expect(JSON.stringify(list)).not.toMatch(UUID);
    list = await env.collab.moveFavorite(a.owner, a.publicId, t1, { after: null });
    expect(list.map((t) => t.id)).toEqual([t1, a.main, a.secret]);
    list = await env.collab.moveFavorite(a.owner, a.publicId, t1, { after: a.secret });
    expect(list.map((t) => t.id)).toEqual([a.main, a.secret, t1]);
    await env.collab.removeFavorite(a.owner, a.publicId, a.secret);
    await expect(env.collab.removeFavorite(a.owner, a.publicId, a.secret)).rejects.toEqual(NF);
    expect((await env.collab.listFavorites(a.owner, a.publicId)).map((t) => t.id)).toEqual([
      a.main,
      t1,
    ]);
    await expect(
      env.collab.moveFavorite(a.owner, a.publicId, t1, { after: a.main, extra: 1 }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('forged, unknown, and other-workspace identifiers are not_found and write nothing (AT-109)', async () => {
    const a = W.a;
    const b = W.b;
    const member = a.people.member!;
    for (const target of [b.main, newPublicId('br'), 'br_short', '../etc', 42, b.guestRecord]) {
      await expect(env.collab.addFavorite(member, a.publicId, target)).rejects.toEqual(NF);
      await expect(env.collab.recordVisit(member, a.publicId, target)).rejects.toEqual(NF);
    }
    // The other workspace's path is not reachable at all for a non-member.
    await expect(env.collab.listFavorites(member, b.publicId)).rejects.toEqual(NF);
    await expect(env.collab.addFavorite(member, b.publicId, b.main)).rejects.toEqual(NF);
    const rows = await db.admin(
      `SELECT count(*)::int AS n FROM views.favorite f JOIN core.record r ON r.id = f.record_id
        WHERE r.workspace_id <> f.workspace_id`,
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it('targets that become unreadable are omitted and removed on the next read (AT-108)', async () => {
    const c = W.c;
    const member = c.people.member!;
    const memberMem = (await membershipOf(db, c.id, member.auth.account.id))!;
    // A sensitive brand is visible only through an explicit grant.
    await expect(env.collab.addFavorite(member, c.publicId, c.secret)).rejects.toEqual(NF);
    await apply(c.owner, c.publicId, {
      kind: 'brand_grant',
      brand: c.secret,
      principal: memberMem.public_id,
      level: 'view',
    });
    await env.collab.addFavorite(member, c.publicId, c.secret);
    await env.collab.recordVisit(member, c.publicId, c.secret);
    await env.collab.addFavorite(member, c.publicId, c.main);
    const team = (await env.collab.createTeam(c.owner, c.publicId, { name: 'Gone' }, mutation()))
      .data.id;
    await env.collab.addFavorite(member, c.publicId, team);
    expect((await env.collab.listFavorites(member, c.publicId)).map((t) => t.id)).toEqual([
      c.secret,
      c.main,
      team,
    ]);
    // Grant removed and team archived: gone from every list on the next read, rows removed.
    await apply(c.owner, c.publicId, {
      kind: 'brand_revoke',
      brand: c.secret,
      principal: memberMem.public_id,
    });
    await env.collab.setTeamArchived(c.owner, c.publicId, team, true, mutation());
    expect((await env.collab.listFavorites(member, c.publicId)).map((t) => t.id)).toEqual([c.main]);
    expect((await env.collab.listRecent(member, c.publicId)).map((t) => t.id)).toEqual([]);
    const left = await db.admin(
      `SELECT count(*)::int AS n FROM views.favorite WHERE owner_membership_id = $1`,
      [memberMem.id],
    );
    expect(left.rows[0].n).toBe(1);
    // An archived brand stays reachable, marked archived, for people who can see it (IA-27).
    await env.collab.archiveBrand(c.owner, c.publicId, c.main, mutation({ ifMatch: '"0"' }));
    const after = await env.collab.listFavorites(member, c.publicId);
    expect(after).toEqual([
      expect.objectContaining({
        id: c.main,
        lifecycle_state: 'archived',
        brand: expect.objectContaining({ archived: true }),
      }),
    ]);
    await env.collab.restoreBrand(c.owner, c.publicId, c.main, mutation({ ifMatch: '"1"' }));
  });

  it('guests: no brands, teams, or directory targets; palette lookup and lists stay empty (AT-110)', async () => {
    const a = W.a;
    const g = a.guest;
    await expect(env.collab.addFavorite(g, a.publicId, a.main)).rejects.toEqual(NF);
    await expect(env.collab.recordVisit(g, a.publicId, a.main)).rejects.toEqual(NF);
    expect(await env.collab.searchTargets(g, a.publicId, 'Main')).toEqual([]);
    expect(await env.collab.listFavorites(g, a.publicId)).toEqual([]);
    const ctx = await env.collab.getContext(g, a.publicId, { includeArchived: true });
    expect(ctx).toMatchObject({ principal: 'guest', brands: [], scope: { kind: 'none' } });
    expect(ctx.archived_brands).toEqual([]);
    expect(ctx.workspace.capabilities).toMatchObject({
      view_directory: false,
      configure: false,
      manage_teams: false,
    });
  });

  it('palette record lookup is permission-safe per role and never crosses workspaces', async () => {
    const a = W.a;
    const roleHits = async (who: Caller, term: string) =>
      (await env.collab.searchTargets(who, a.publicId, term)).map((t) => t.label).sort();
    expect(await roleHits(a.owner, 'Secret')).toEqual(['Secret a']);
    expect(await roleHits(a.people.administrator!, 'Secret')).toEqual([]);
    for (const role of ['member', 'limited_member', 'read_only'])
      expect(await roleHits(a.people[role]!, 'Main'), role).toEqual(
        role === 'limited_member' ? [] : ['Main a'],
      );
    expect(await roleHits(a.owner, 'Main b')).toEqual([]);
    expect(await roleHits(a.owner, '%')).toEqual([]);
  });

  it('recents: recorded per visit, coalesced, trimmed to RECENT_ITEMS_MAX, filtered, and cleared', async () => {
    const b = W.b;
    const teams: string[] = [];
    for (const n of ['R1', 'R2', 'R3', 'R4'])
      teams.push(
        (await tight.collab.createTeam(b.owner, b.publicId, { name: n }, mutation())).data.id,
      );
    expect(await tight.collab.recordVisit(b.owner, b.publicId, b.main)).toEqual({
      outcome: 'recorded',
    });
    expect(await tight.collab.recordVisit(b.owner, b.publicId, b.main)).toEqual({
      outcome: 'coalesced',
    });
    for (const t of teams) await tight.collab.recordVisit(b.owner, b.publicId, t);
    const all = await tight.collab.listRecent(b.owner, b.publicId);
    expect(all.map((t) => t.id)).toEqual([teams[3], teams[2], teams[1]]);
    const stored = await db.admin(
      `SELECT count(*)::int AS n FROM views.recent_item WHERE workspace_id = $1`,
      [b.id],
    );
    expect(stored.rows[0].n).toBe(3);
    expect(await tight.collab.listRecent(b.owner, b.publicId, { type: 'brand' })).toEqual([]);
    await expect(
      tight.collab.listRecent(b.owner, b.publicId, { type: 'secret_type' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      tight.collab.listRecent(b.owner, b.publicId, { limit: '999' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await tight.collab.listRecent(b.owner, b.publicId, { limit: 'sidebar' })).length).toBe(
      3,
    );
    await tight.collab.clearRecent(b.owner, b.publicId, teams[3]);
    expect((await tight.collab.listRecent(b.owner, b.publicId)).map((t) => t.id)).toEqual([
      teams[2],
      teams[1],
    ]);
    expect(await tight.collab.clearRecent(b.owner, b.publicId)).toEqual({ cleared: 2 });
  });

  it('favorites are bounded by FAVORITES_MAX, refused with a limit error, never silently dropped', async () => {
    const b = W.b;
    const ids: string[] = [];
    for (const n of ['F1', 'F2', 'F3', 'F4', 'F5'])
      ids.push(
        (await tight.collab.createTeam(b.owner, b.publicId, { name: n }, mutation())).data.id,
      );
    const results = await Promise.allSettled(
      ids.map((t) => tight.collab.addFavorite(b.owner, b.publicId, t)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'limit_exceeded' });
    const rows = await db.admin(
      `SELECT count(*)::int AS n, count(DISTINCT rank)::int AS ranks FROM views.favorite
        WHERE workspace_id = $1`,
      [b.id],
    );
    expect(rows.rows[0]).toEqual({ n: 4, ranks: 4 });
  });

  it('concurrent favorites, reorders, visits, and view-state writes are deterministic per person and device', async () => {
    const c = W.c;
    const admin = c.people.administrator!;
    const teams: string[] = [];
    for (const n of ['C1', 'C2', 'C3', 'C4', 'C5'])
      teams.push(
        (await env.collab.createTeam(c.owner, c.publicId, { name: n }, mutation())).data.id,
      );
    await Promise.all(
      [...teams, ...teams].map((t) => env.collab.addFavorite(admin, c.publicId, t)),
    );
    let list = await env.collab.listFavorites(admin, c.publicId);
    expect(list.map((t) => t.id).sort()).toEqual([...teams].sort());
    await Promise.all(
      teams.map((t, i) =>
        env.collab.moveFavorite(admin, c.publicId, t, { after: i ? teams[i - 1]! : null }),
      ),
    );
    list = await env.collab.listFavorites(admin, c.publicId);
    expect(new Set(list.map((t) => t.id)).size).toBe(5);
    const ranks = await db.admin(
      `SELECT rank FROM views.favorite f JOIN tenancy.membership m ON m.id = f.owner_membership_id
        WHERE f.workspace_id = $1 AND m.account_id = $2 ORDER BY rank COLLATE "C"`,
      [c.id, admin.auth.account.id],
    );
    expect(new Set(ranks.rows.map((r) => r.rank)).size).toBe(5);
    const visits = await Promise.all(
      Array.from({ length: 6 }, () => env.collab.recordVisit(admin, c.publicId, teams[0])),
    );
    expect(visits.filter((v) => v.outcome === 'recorded').length).toBeGreaterThanOrEqual(1);
    const recentRows = await db.admin(
      `SELECT count(*)::int AS n FROM views.recent_item i JOIN core.record r ON r.id = i.record_id
        WHERE r.public_id = $1`,
      [teams[0]],
    );
    expect(recentRows.rows[0].n).toBe(1);
    // Two devices write concurrently; each keeps its own last state (no cross-device mixing).
    const d1 = device();
    const d2 = device();
    await Promise.all(
      ['name', 'role', 'name', 'role'].map((sort, i) =>
        env.collab.putViewState(
          admin,
          c.publicId,
          'people.list',
          i % 2 ? d2 : d1,
          { schema_version: 1, state: { sort, state: i % 2 ? 'suspended' : 'active' } },
          undefined,
        ),
      ),
    );
    const s1 = await env.collab.getViewState(admin, c.publicId, 'people.list', d1);
    const s2 = await env.collab.getViewState(admin, c.publicId, 'people.list', d2);
    expect(s1.state.state).toBe('active');
    expect(s2.state.state).toBe('suspended');
    expect(s1.version + s2.version).toBe(4);
  });

  it('view state: allow-listed, versioned, bounded, conditional, per device, expiring (AT-111)', async () => {
    const a = W.a;
    const who = a.people.member!;
    const d = device();
    expect(await env.collab.getViewState(who, a.publicId, 'people.list', null)).toEqual({
      key: 'people.list',
      schema_version: 1,
      state: {},
      version: 0,
    });
    const saved = await env.collab.putViewState(
      who,
      a.publicId,
      'people.list',
      d,
      { schema_version: 1, state: { state: 'active', sort: 'name', anchor: newPublicId('mem') } },
      0,
    );
    expect(saved.version).toBe(1);
    await expect(
      env.collab.putViewState(
        who,
        a.publicId,
        'people.list',
        d,
        { schema_version: 1, state: {} },
        0,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    for (const body of [
      { schema_version: 2, state: {} },
      { schema_version: 1, state: { q: 'search text is never stored' } },
      { schema_version: 1, state: JSON.parse('{"__proto__":{"x":1}}') },
      { schema_version: 1, state: { sort: 'x'.repeat(20_000) } },
      { schema_version: 1, state: [] },
      { schema_version: 1, state: {}, extra: true },
      null,
    ])
      await expect(
        env.collab.putViewState(who, a.publicId, 'people.list', d, body, undefined),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      env.collab.putViewState(
        who,
        a.publicId,
        'people.list',
        null,
        { schema_version: 1, state: {} },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(env.collab.getViewState(who, a.publicId, 'nope.view', d)).rejects.toEqual(NF);
    await expect(env.collab.getViewState(who, a.publicId, '__proto__', d)).rejects.toEqual(NF);
    // Another device and another person see nothing of this state.
    expect((await env.collab.getViewState(who, a.publicId, 'people.list', device())).state).toEqual(
      {},
    );
    expect((await env.collab.getViewState(a.owner, a.publicId, 'people.list', d)).state).toEqual(
      {},
    );
    // Corrupt stored state (written behind the API) degrades to defaults.
    await db.admin(
      `UPDATE views.view_state SET state = '{"sort":"drop table","x":1}' WHERE workspace_id = $1`,
      [a.id],
    );
    expect((await env.collab.getViewState(who, a.publicId, 'people.list', d)).state).toEqual({});
    // Expired state is treated as absent and removed by cleanup.
    await db.admin(
      `UPDATE views.view_state SET updated_at = now() - interval '2 days', expires_at = now() - interval '1 day'
        WHERE workspace_id = $1`,
      [a.id],
    );
    expect((await env.collab.getViewState(who, a.publicId, 'people.list', d)).version).toBe(0);
    const cleaned = await env.h.worker.withWorkspace(a.id, { module: 'test' }, (tx) =>
      cleanupWorkspaceViews(tx, env.h.telemetry.metrics, { departedBefore: null }),
    );
    expect(cleaned.expired).toBeGreaterThanOrEqual(1);
  });

  it('scope tokens are validated server-side: hidden or foreign brands narrow, never broaden (AT-112)', async () => {
    const a = W.a;
    const member = a.people.member!;
    const all = await env.collab.getContext(a.owner, a.publicId, { scope: 'all' });
    expect(all.scope).toEqual({
      kind: 'all',
      brand_ids: expect.arrayContaining([a.main, a.secret]),
    });
    expect(all.scope_token).toBe('all');
    const two = await env.collab.getContext(a.owner, a.publicId, {
      scope: `brands:${a.secret},${a.main}`,
    });
    expect(two.scope).toEqual({ kind: 'brands', brand_ids: [a.main, a.secret].sort() });
    // The member cannot see the sensitive brand: it is dropped silently and the scope narrows.
    const narrowed = await env.collab.getContext(member, a.publicId, {
      scope: `brands:${a.secret},${a.main}`,
    });
    expect(narrowed).toMatchObject({
      scope: { kind: 'brand', brand_id: a.main },
      fallback: 'narrowed',
      scope_token: `brand:${a.main}`,
    });
    expect(JSON.stringify(narrowed)).not.toContain(a.secret);
    for (const bad of [
      `brand:${a.secret}`,
      `brand:${W.b.main}`,
      'everything',
      `brands:${W.b.main}`,
    ]) {
      const ctx = await env.collab.getContext(member, a.publicId, { scope: bad });
      expect(ctx.scope, bad).toEqual({ kind: 'brand', brand_id: a.main });
      expect(ctx.fallback, bad).toMatch(/stale_selection|invalid|narrowed/);
      expect(JSON.stringify(ctx), bad).not.toContain(W.b.main);
      expect(JSON.stringify(ctx), bad).not.toContain(a.secret);
    }
    // The per-device default: each device keeps its own selection; a new device falls back to the
    // membership's last single-brand or all-brands choice.
    const d1 = device();
    const d2 = device();
    await env.collab.selectContext(
      a.owner,
      a.publicId,
      { scope: 'brands', brand_ids: [a.main, a.secret] },
      { device: d1 },
    );
    await env.collab.selectContext(
      a.owner,
      a.publicId,
      { scope: 'brand', brand_id: a.main },
      { device: d2 },
    );
    expect((await env.collab.getContext(a.owner, a.publicId, { device: d1 })).scope).toEqual({
      kind: 'brands',
      brand_ids: [a.main, a.secret].sort(),
    });
    expect((await env.collab.getContext(a.owner, a.publicId, { device: d2 })).scope).toEqual({
      kind: 'brand',
      brand_id: a.main,
    });
    await expect(
      env.collab.selectContext(
        member,
        a.publicId,
        { scope: 'brands', brand_ids: [a.main, a.secret] },
        { device: d1 },
      ),
    ).rejects.toEqual(NF);
  });

  it('removed members lose every personal list on the next request; retention cleanup erases them (AT-114)', async () => {
    const b = W.b;
    const leaver = await join(b.publicId, b.owner, { kind: 'member', role: 'member' });
    await grantView(b, leaver);
    const d = device();
    await env.collab.addFavorite(leaver, b.publicId, b.main);
    await env.collab.recordVisit(leaver, b.publicId, b.main);
    await env.collab.putViewState(
      leaver,
      b.publicId,
      'people.list',
      d,
      { schema_version: 1, state: { sort: 'name' } },
      undefined,
    );
    await env.collab.leave(leaver, b.publicId, {}, mutation());
    await expect(env.collab.listFavorites(leaver, b.publicId)).rejects.toEqual(NF);
    await expect(env.collab.listRecent(leaver, b.publicId)).rejects.toEqual(NF);
    await expect(env.collab.getViewState(leaver, b.publicId, 'people.list', d)).rejects.toEqual(NF);
    const m = (await membershipOf(db, b.id, leaver.auth.account.id))!;
    // Undecided R-PERSONAL period: kept. Decided and passed: erased by the cleanup job.
    const discovered = await env.h.discovery.discoverViewsCleanup(null, 100);
    expect(discovered).not.toContain(b.id);
    const handler = viewsCleanupHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      retention: new RetentionPolicy({ retentionPeriodsMs: { 'R-PERSONAL': 1 } }),
      metrics: env.h.telemetry.metrics,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(await env.h.discovery.discoverViewsCleanup(new Date(Date.now() + 1000), 100)).toContain(
      b.id,
    );
    await handler.handle({} as never);
    for (const table of ['views.favorite', 'views.recent_item', 'views.view_state']) {
      const r = await db.admin(
        `SELECT count(*)::int AS n FROM ${table} WHERE owner_membership_id = $1`,
        [m.id],
      );
      expect(r.rows[0].n, table).toBe(0);
    }
  });

  it('purge, membership, and account erasers remove personal references (hooks registered)', async () => {
    const c = W.c;
    const rec = await seedRecord(db, c.id, null);
    const owner = (await membershipOf(db, c.id, c.owner.auth.account.id))!;
    await db.admin(
      `INSERT INTO views.recent_item (workspace_id, owner_membership_id, record_id) VALUES ($1, $2, $3)`,
      [c.id, owner.id, rec.id],
    );
    const n = await env.h.worker.withWorkspace(c.id, { module: 'test' }, (tx) =>
      removePersonalReferences(tx, [rec.id]),
    );
    expect(n).toBe(1);
    const registry = defaultPersonalDataRegistry();
    expect(
      registry
        .all()
        .map((e) => e.module)
        .sort(),
    ).toEqual(['identity', 'views']);
    const { service: identity } = createIdentityService({
      db: env.h.platform,
      config: env.h.config.identity,
      appName: 'PM',
      logger: env.h.logger,
      metrics: env.h.telemetry.metrics,
      limiter: new NoopRateLimiter(),
    });
    await identity.updatePreferences(c.owner.auth, { theme: 'dark' }, undefined);
    await env.h.platform.withPlatform({ module: 'test' }, (tx) =>
      registry.eraseAccount(tx, c.owner.auth.account.id),
    );
    expect((await readPreferences(env.h.platform, c.owner.auth.account.id)).version).toBe(0);
  });

  it('preferences: typed, allow-listed, conditional, and account-scoped', async () => {
    const who = W.a.people.read_only!;
    const { service: identity } = createIdentityService({
      db: env.h.platform,
      config: env.h.config.identity,
      appName: 'PM',
      logger: env.h.logger,
      metrics: env.h.telemetry.metrics,
      limiter: new NoopRateLimiter(),
    });
    const before = await identity.getPreferences(who.auth);
    expect(before).toEqual({
      preferences: {
        theme: 'system',
        density: 'comfortable',
        motion: 'system',
        shortcuts: 'auto',
        record_open: 'panel',
        start_destination: null,
        hidden_destinations: [],
      },
      version: 0,
    });
    const v1 = await identity.updatePreferences(
      who.auth,
      {
        theme: 'dark',
        shortcuts: 'off',
        hidden_destinations: ['goals'],
        start_destination: 'today',
      },
      0,
    );
    expect(v1).toMatchObject({ version: 1, preferences: { theme: 'dark', shortcuts: 'off' } });
    await expect(identity.updatePreferences(who.auth, { theme: 'light' }, 0)).rejects.toMatchObject(
      {
        code: 'conflict',
      },
    );
    for (const bad of [
      { theme: 'neon' },
      { hidden_destinations: ['home'] },
      { hidden_destinations: ['goals', 'goals'] },
      { start_destination: 'admin' },
      { unknown: 1 },
      [],
    ])
      await expect(identity.updatePreferences(who.auth, bad, undefined)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    // Concurrent writers serialize on the row; the version counts every write.
    await Promise.all(
      ['light', 'dark', 'system'].map((theme) =>
        identity.updatePreferences(who.auth, { theme }, undefined),
      ),
    );
    expect((await identity.getPreferences(who.auth)).version).toBe(4);
  });

  it('shared-view pins: only a view shared at the pin scope can be pinned; others are refused', async () => {
    // 1E foundation, 3A write path (ADR-0018): the application role may write pins, and the
    // database refuses any pin whose target is not a saved view shared with the pin's scope.
    const a = W.a;
    const viewId = newUuidV7();
    const owner = (await membershipOf(db, a.id, a.owner.auth.account.id))!;
    await db.admin(
      `INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type)
       VALUES ($1, $2, 'saved_view', $3, NULL, 'system', 'system')`,
      [viewId, newPublicId('view'), a.id],
    );
    // A saved-view record with no shared view behind it cannot be pinned.
    await expect(
      db.admin(
        `INSERT INTO views.view_pin (workspace_id, scope_key, brand_id, saved_view_id, rank, pinned_by_membership_id)
         VALUES ($1, $1, NULL, $2, 'V', $3)`,
        [a.id, viewId, owner.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // Nor can anything that is not a saved view.
    await expect(
      db.admin(
        `INSERT INTO views.view_pin (workspace_id, scope_key, brand_id, saved_view_id, rank, pinned_by_membership_id)
         VALUES ($1, $1, NULL, $2, 'W', $3)`,
        [a.id, a.mainId, owner.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // The application role reaches the same guard (it holds the 3A insert grant).
    await expect(
      env.h.app.withWorkspace(a.id, { module: 'test' }, (tx) =>
        sql`INSERT INTO views.view_pin (workspace_id, scope_key, saved_view_id, rank, pinned_by_membership_id)
            VALUES (${a.id}, ${a.id}, ${viewId}, 'X', ${owner.id})`.execute(tx.db),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await env.collab.listPins(a.owner, a.publicId)).toEqual([]);
  });

  it('EXPLAIN: personal lists, view state, and cleanup use their indexes', async () => {
    const a = W.a;
    const owner = (await membershipOf(db, a.id, a.owner.auth.account.id))!;
    const plan = async (query: string, params: unknown[]) =>
      env.h.app.withWorkspace(a.id, { module: 'test' }, async (tx) => {
        await sql`SET LOCAL enable_seqscan = off`.execute(tx.db);
        const r = await tx.db.executeQuery({
          sql: `EXPLAIN (FORMAT JSON) ${query}`,
          parameters: params,
          query: { kind: 'RawNode' },
        } as never);
        return JSON.stringify((r as { rows: unknown[] }).rows);
      });
    expect(
      await plan(
        `SELECT record_id FROM views.favorite WHERE owner_membership_id = $1 ORDER BY rank, record_id LIMIT 200`,
        [owner.id],
      ),
    ).toMatch(/favorite_by_owner_rank|favorite_pkey/);
    expect(
      await plan(
        `SELECT record_id FROM views.recent_item WHERE owner_membership_id = $1 ORDER BY visited_at DESC, record_id DESC LIMIT 50`,
        [owner.id],
      ),
    ).toMatch(/recent_item_by_owner_time/);
    // Per workspace (worker cleanup, RLS-scoped): an index on the tenant key; across workspaces
    // (the dispatcher's discovery function): the expiry index.
    expect(
      await plan(`SELECT view_key FROM views.view_state WHERE expires_at <= now()`, []),
    ).toMatch(/"Index (Only )?Scan"|"Bitmap Index Scan"/);
    // One multi-statement round trip, so the setting applies on the same connection.
    const discovery = (await db.admin(
      `BEGIN; SET LOCAL enable_seqscan = off;
       EXPLAIN (FORMAT JSON) SELECT s.workspace_id FROM views.view_state s WHERE s.expires_at <= now();
       COMMIT;`,
    )) as unknown as Array<{ rows: unknown[] }>;
    expect(JSON.stringify(discovery[2]!.rows)).toMatch(/view_state_by_expiry/);
    expect(
      await plan(
        `SELECT 1 FROM views.view_state WHERE owner_membership_id = $1 AND device_key_hash = $2 AND view_key = 'people.list'`,
        [owner.id, Buffer.alloc(32)],
      ),
    ).toMatch(/view_state_pkey/);
  });
});
