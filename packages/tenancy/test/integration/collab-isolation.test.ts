import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@pm/db';
import { compilePrincipal, compileVisibility, type Caller } from '@pm/tenancy';
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

const reason = (code: string) => expect.objectContaining({ code });

interface Ws {
  publicId: string;
  id: string;
  owner: Caller;
  brand: string;
  brandId: string;
  people: Record<string, Caller>;
}

/**
 * 1D isolation, concurrency, and query-plan matrix: three workspaces, all six roles, a second
 * owner, teams, record grants, sensitive brands, and both visibility strategies.
 */
describe('collaboration isolation and concurrency (1D)', () => {
  let db: TestDatabase;
  let env: CollabEnv;
  let small: CollabEnv;
  const W: Record<'a' | 'b' | 'c', Ws> = {} as never;

  async function apply(e: CollabEnv, as: Caller, ws: string, change: Record<string, unknown>) {
    const preview = await e.collab.previewChange(as, ws, change);
    e.stepUp.allow = true;
    try {
      return await e.collab.applyChange(
        as,
        ws,
        { change, preview_token: preview.preview_token },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      e.stepUp.allow = false;
    }
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    env = collabEnv(db);
    small = collabEnv(db, { arrayMax: 1 });
    for (const k of ['a', 'b', 'c'] as const) {
      const owner = await seedAccount(db);
      const created = await env.collab.createWorkspace(
        owner,
        { ...WORKSPACE_INPUT, name: `W-${k}`, first_brand: { name: `B-${k}` } },
        mutation(),
      );
      const publicId = created.data.workspace.id;
      const people: Record<string, Caller> = {};
      for (const role of ['administrator', 'member', 'limited_member', 'read_only']) {
        const who = await seedAccount(db);
        await env.collab.invite(
          owner,
          publicId,
          { email: who.auth.account.email, kind: 'member', role },
          mutation(),
        );
        await env.collab.acceptInvitation(
          who,
          { token: await env.tokenFor(who.auth.account.email) },
          mutation(),
        );
        people[role] = who;
      }
      const brandId = (
        await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [
          created.data.first_brand!.id,
        ])
      ).rows[0].id;
      W[k] = {
        publicId,
        id: await workspaceIdOf(db, publicId),
        owner,
        brand: created.data.first_brand!.id,
        brandId,
        people,
      };
    }
  });
  afterAll(async () => {
    await small.h.close();
    await env.h.close();
    await db.drop();
  });

  it('cross-workspace people, invitations, teams, shares, access, and transfers are identical not_found', async () => {
    const a = W.a;
    const b = W.b;
    const memberB = (await membershipOf(db, b.id, b.people.member!.auth.account.id))!;
    const teamB = (await env.collab.createTeam(b.owner, b.publicId, { name: 'B team' }, mutation()))
      .data;
    const invB = (
      await env.collab.invite(
        b.owner,
        b.publicId,
        { email: 'x-b@example.test', kind: 'member', role: 'member' },
        mutation(),
      )
    ).data;
    const recB = await seedRecord(db, b.id, b.brandId);
    // a's owner aims at b's resources through a's own path (guessed public IDs) and through b's path.
    await expect(env.collab.getMember(a.owner, a.publicId, memberB.public_id)).rejects.toEqual(
      reason('not_found'),
    );
    await expect(env.collab.getTeam(a.owner, a.publicId, teamB.id)).rejects.toEqual(
      reason('not_found'),
    );
    await expect(
      env.collab.revokeInvitation(a.owner, a.publicId, invB.id, mutation()),
    ).rejects.toEqual(reason('not_found'));
    await expect(env.collab.previewMember(a.owner, a.publicId, memberB.public_id)).rejects.toEqual(
      reason('not_found'),
    );
    await expect(
      env.collab.createShare(
        a.owner,
        a.publicId,
        { record: recB.publicId, grantee: a.brand },
        mutation(),
      ),
    ).rejects.toEqual(reason('not_found'));
    await expect(
      env.collab.previewChange(a.owner, a.publicId, {
        kind: 'brand_grant',
        brand: b.brand,
        principal: memberB.public_id,
        level: 'view',
      }),
    ).rejects.toEqual(reason('not_found'));
    for (const call of [
      () => env.collab.listMembers(a.owner, b.publicId, {}),
      () => env.collab.listInvitations(a.owner, b.publicId, {}),
      () => env.collab.listTeams(a.owner, b.publicId, {}),
      () => env.collab.getPolicy(a.owner, b.publicId),
      () => env.collab.getOwnershipTransfer(a.owner, b.publicId),
      () => env.collab.listReadableRecords(a.owner, b.publicId),
    ])
      await expect(call()).rejects.toEqual(reason('not_found'));
    // Body claims about other workspaces or roles never apply.
    await expect(
      env.collab.invite(
        a.owner,
        a.publicId,
        { email: 'y@example.test', kind: 'member', role: 'member', workspace: b.publicId },
        mutation(),
      ),
    ).rejects.toEqual(reason('validation_failed'));
  });

  it('teams add only their current grants; removal takes effect on the next check', async () => {
    const a = W.a;
    const lim = a.people.limited_member!;
    const limM = (await membershipOf(db, a.id, lim.auth.account.id))!;
    const team = (await env.collab.createTeam(a.owner, a.publicId, { name: 'Ops' }, mutation()))
      .data;
    await apply(env, a.owner, a.publicId, {
      kind: 'team_add',
      team: team.id,
      member: limM.public_id,
    });
    expect((await env.svc.listBrands(lim, a.publicId, {})).data).toEqual([]);
    await apply(env, a.owner, a.publicId, {
      kind: 'brand_grant',
      brand: a.brand,
      principal: team.id,
      level: 'comment',
    });
    expect((await env.svc.listBrands(lim, a.publicId, {})).data.map((x) => x.id)).toEqual([
      a.brand,
    ]);
    // Archiving the team removes its contribution immediately.
    await env.collab.setTeamArchived(a.owner, a.publicId, team.id, true, mutation());
    expect((await env.svc.listBrands(lim, a.publicId, {})).data).toEqual([]);
    await env.collab.setTeamArchived(a.owner, a.publicId, team.id, false, mutation());
    expect((await env.svc.listBrands(lim, a.publicId, {})).data.map((x) => x.id)).toEqual([
      a.brand,
    ]);
    await apply(env, a.owner, a.publicId, {
      kind: 'brand_revoke',
      brand: a.brand,
      principal: team.id,
    });
    expect((await env.svc.listBrands(lim, a.publicId, {})).data).toEqual([]);
  });

  it('expired and revoked grants never count; preview equals enforcement for all six roles', async () => {
    const a = W.a;
    const rec = await seedRecord(db, a.id, a.brandId);
    const guest = await seedAccount(db);
    await env.collab.invite(
      a.owner,
      a.publicId,
      { email: guest.auth.account.email, kind: 'guest', records: [{ record: rec.publicId }] },
      mutation(),
    );
    await env.collab.acceptInvitation(
      guest,
      { token: await env.tokenFor(guest.auth.account.email) },
      mutation(),
    );
    expect((await env.collab.listReadableRecords(guest, a.publicId)).map((r) => r.id)).toEqual([
      rec.publicId,
    ]);
    await db.admin(
      `UPDATE access.record_grant SET expires_at = now() - interval '1 second', version = version + 1 WHERE record_id = $1`,
      [rec.id],
    );
    expect(await env.collab.listReadableRecords(guest, a.publicId)).toEqual([]);

    const callers: Record<string, Caller> = { owner: a.owner, ...a.people, guest };
    for (const [role, who] of Object.entries(callers)) {
      const m = (await membershipOf(db, a.id, who.auth.account.id))!;
      const enforced = (await env.svc.listBrands(who, a.publicId, {})).data.map((x) => x.id).sort();
      const previewed = (
        await env.collab.previewMember(a.owner, a.publicId, m.public_id)
      ).explanation.brands
        .filter((x) => x.level !== null)
        .map((x) => x.brand.id)
        .sort();
      expect(previewed, role).toEqual(enforced);
    }
  });

  it('temporary-table strategy gives identical visibility to the array strategy', async () => {
    const a = W.a;
    const alphaRec = await seedRecord(db, a.id, a.brandId);
    const wsRec = await seedRecord(db, a.id, null);
    for (const who of [a.owner, a.people.member!, a.people.read_only!, a.people.limited_member!]) {
      const big = (await env.collab.listReadableRecords(who, a.publicId)).map((r) => r.id).sort();
      const tiny = (await small.collab.listReadableRecords(who, a.publicId))
        .map((r) => r.id)
        .sort();
      expect(tiny).toEqual(big);
    }
    // Both oversized strategies (read-write temp table, read-only semi-join) match the array path.
    for (const readOnly of [false, true]) {
      // The owner's context (membership + viewable brand subjects) exceeds arrayMax = 1.
      const m = (await membershipOf(db, a.id, a.owner.auth.account.id))!;
      const got = await env.h.app.withWorkspace(a.id, { module: 'test', readOnly }, async (tx) => {
        const p = await compilePrincipal(tx, m.id, a.owner.auth.account.id, 'member');
        const vis = await compileVisibility(tx, p, { need: 'view', arrayMax: 1 });
        expect(vis.ctx.strategy).toBe(readOnly ? 'semi_join' : 'temp_table');
        return (
          await tx.db
            .selectFrom('core.record as r')
            .select('r.public_id')
            .where('r.record_type', '=', 'foundation_fixture')
            .where(vis.where('r'))
            .execute()
        )
          .map((r) => r.public_id)
          .sort();
      });
      const viaArray = (await env.collab.listReadableRecords(a.owner, a.publicId))
        .map((r) => r.id)
        .sort();
      expect(got).toEqual(viaArray);
    }
    expect((await env.collab.listReadableRecords(a.owner, a.publicId)).map((r) => r.id)).toEqual(
      expect.arrayContaining([alphaRec.publicId, wsRec.publicId]),
    );
    // Members see workspace-scoped records at the default level; limited members do not.
    expect(
      (await env.collab.listReadableRecords(a.people.member!, a.publicId)).map((r) => r.id),
    ).toContain(wsRec.publicId);
    expect(
      (await env.collab.listReadableRecords(a.people.limited_member!, a.publicId)).map((r) => r.id),
    ).not.toContain(wsRec.publicId);
  });

  it('concurrency: role races, last-owner races, and preview/apply races stay consistent', async () => {
    const c = W.c;
    const cM = (await membershipOf(db, c.id, c.people.member!.auth.account.id))!;
    // Two different reviewed role changes on one member: the second preview goes stale.
    const p1 = await env.collab.previewChange(c.owner, c.publicId, {
      kind: 'role',
      member: cM.public_id,
      role: 'read_only',
    });
    const p2 = await env.collab.previewChange(c.owner, c.publicId, {
      kind: 'role',
      member: cM.public_id,
      role: 'administrator',
    });
    env.stepUp.allow = true;
    const results = await Promise.allSettled([
      env.collab.applyChange(
        c.owner,
        c.publicId,
        {
          change: { kind: 'role', member: cM.public_id, role: 'read_only' },
          preview_token: p1.preview_token,
        },
        mutation({ stepUpToken: 't' }),
      ),
      env.collab.applyChange(
        c.owner,
        c.publicId,
        {
          change: { kind: 'role', member: cM.public_id, role: 'administrator' },
          preview_token: p2.preview_token,
        },
        mutation({ stepUpToken: 't' }),
      ),
    ]);
    env.stepUp.allow = false;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'conflict' });

    // Two owners demote each other concurrently: one wins, the last owner always remains.
    const admin = c.people.administrator!;
    const adminM = (await membershipOf(db, c.id, admin.auth.account.id))!;
    await apply(env, c.owner, c.publicId, {
      kind: 'role',
      member: adminM.public_id,
      role: 'owner',
    });
    const ownerM = (await membershipOf(db, c.id, c.owner.auth.account.id))!;
    const pa = await env.collab.previewChange(c.owner, c.publicId, {
      kind: 'role',
      member: adminM.public_id,
      role: 'member',
    });
    const pb = await env.collab.previewChange(admin, c.publicId, {
      kind: 'role',
      member: ownerM.public_id,
      role: 'member',
    });
    env.stepUp.allow = true;
    await Promise.allSettled([
      env.collab.applyChange(
        c.owner,
        c.publicId,
        {
          change: { kind: 'role', member: adminM.public_id, role: 'member' },
          preview_token: pa.preview_token,
        },
        mutation({ stepUpToken: 't' }),
      ),
      env.collab.applyChange(
        admin,
        c.publicId,
        {
          change: { kind: 'role', member: ownerM.public_id, role: 'member' },
          preview_token: pb.preview_token,
        },
        mutation({ stepUpToken: 't' }),
      ),
    ]);
    env.stepUp.allow = false;
    const owners = await db.admin(
      `SELECT count(*)::int AS n FROM access.role_assignment a JOIN access.role r ON r.id = a.role_id
        WHERE a.workspace_id = $1 AND a.scope_type = 'workspace' AND r.key = 'owner'`,
      [c.id],
    );
    expect(owners.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('EXPLAIN: representative principals hit the visibility indexes (filter before pagination)', async () => {
    const a = W.a;
    const guest = await seedAccount(db);
    const rec = await seedRecord(db, a.id, a.brandId);
    await env.collab.invite(
      a.owner,
      a.publicId,
      { email: guest.auth.account.email, kind: 'guest', records: [{ record: rec.publicId }] },
      mutation(),
    );
    await env.collab.acceptInvitation(
      guest,
      { token: await env.tokenFor(guest.auth.account.email) },
      mutation(),
    );
    for (const [label, who] of Object.entries({ owner: a.owner, ...a.people, guest })) {
      const m = (await membershipOf(db, a.id, who.auth.account.id))!;
      const plan = await env.h.app.withWorkspace(a.id, { module: 'test' }, async (tx) => {
        const p = await compilePrincipal(
          tx,
          m.id,
          who.auth.account.id,
          m.kind as 'member' | 'guest',
        );
        const vis = await compileVisibility(tx, p, { need: 'view', arrayMax: 10_000 });
        await sql`SET LOCAL enable_seqscan = off`.execute(tx.db);
        const q = tx.db
          .selectFrom('core.record as r')
          .select('r.id')
          .where(vis.where('r'))
          .orderBy('r.id')
          .limit(50);
        const compiled = q.compile();
        const res = await tx.db.executeQuery({
          ...compiled,
          sql: `EXPLAIN (FORMAT JSON) ${compiled.sql}`,
        } as never);
        return JSON.stringify((res as { rows: unknown[] }).rows);
      });
      expect(plan, label).toMatch(/"Index (Only )?Scan"|"Bitmap Index Scan"/);
      if (label === 'guest')
        expect(plan, label).toMatch(
          /record_grant_by_(record|grantee)_active|record_grant_one_active/,
        );
    }
  });
});
