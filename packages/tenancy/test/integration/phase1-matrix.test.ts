import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { newUuidV7 } from '@pm/contracts';
import { sql } from '@pm/db';
import { testDecision } from '@pm/lifecycle/testing';
import { principalFreshness, type Caller } from '@pm/tenancy';
import { executionContext, syntheticPrincipal } from '@pm/test-support';
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
const ROLES = ['administrator', 'member', 'limited_member', 'read_only'] as const;
type Who = 'owner' | (typeof ROLES)[number] | 'guest';
const WHO: readonly Who[] = ['owner', ...ROLES, 'guest'];

interface Ws {
  key: string;
  publicId: string;
  id: string;
  people: Record<Who, Caller>;
  brands: { main: string; secret: string; old: string; binned: string };
  records: { main: string; secret: string; workspace: string };
}

/**
 * Phase 1 exit gate: the cross-surface isolation and adversarial matrix. Three workspaces, all
 * six roles and a guest, sensitive, archived, and trashed brands, brand- and workspace-scoped
 * records, and principals whose access changes. Every read surface Phase 1 ships (brand list,
 * scope context, palette lookup, favorites, shared records) must agree for every principal, and
 * the direct database roles must agree with them. Access changes take effect on the next check
 * on the same pooled connection, and the worker's freshness check sees them.
 */
describe('Phase 1 isolation matrix (exit gate)', () => {
  let db: TestDatabase;
  let env: CollabEnv;
  const W: Record<'a' | 'b' | 'c', Ws> = {} as never;

  async function apply(ws: Ws, change: Record<string, unknown>) {
    const preview = await env.collab.previewChange(ws.people.owner, ws.publicId, change);
    env.stepUp.allow = true;
    try {
      return await env.collab.applyChange(
        ws.people.owner,
        ws.publicId,
        { change, preview_token: preview.preview_token },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
  }

  const memberOf = async (ws: Ws, who: Who) =>
    (await membershipOf(db, ws.id, ws.people[who].auth.account.id))!;

  /** Everything one principal can see in one workspace, through every Phase 1 read surface. */
  async function surfaces(ws: Ws, who: Who) {
    const caller = ws.people[who];
    const brands = (await env.svc.listBrands(caller, ws.publicId, {})).data.map((b) => b.id).sort();
    const archived = (await env.svc.listBrands(caller, ws.publicId, { state: 'archived' })).data
      .map((b) => b.id)
      .sort();
    const ctx = await env.svc.getContext(caller, ws.publicId, { scope: 'all' });
    const scope = ctx.scope.kind === 'all' ? [...ctx.scope.brand_ids].sort() : [];
    const palette = (await env.collab.searchTargets(caller, ws.publicId, ws.key))
      .filter((t) => t.type === 'brand')
      .map((t) => t.id)
      .sort();
    const records = (await env.collab.listReadableRecords(caller, ws.publicId))
      .map((r) => r.id)
      .sort();
    return { brands, archived, scope, palette, records };
  }

  /** Brands this principal can favorite, probing every brand of every workspace (forged IDs too). */
  async function favoritable(ws: Ws, who: Who): Promise<string[]> {
    const ok: string[] = [];
    for (const other of Object.values(W))
      for (const b of Object.values(other.brands)) {
        try {
          await env.collab.addFavorite(ws.people[who], ws.publicId, b);
          ok.push(b);
        } catch (err) {
          expect(err, `${ws.key}/${who} favorite ${b}`).toEqual(reason('not_found'));
        }
      }
    return ok.sort();
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    env = collabEnv(db);
    for (const k of ['a', 'b', 'c'] as const) {
      const owner = await seedAccount(db);
      const created = await env.collab.createWorkspace(
        owner,
        { ...WORKSPACE_INPUT, name: `Matrix ${k}`, first_brand: { name: `Main ${k}x` } },
        mutation(),
      );
      const publicId = created.data.workspace.id;
      const id = await workspaceIdOf(db, publicId);
      const main = created.data.first_brand!.id;
      const make = async (name: string) =>
        (await env.svc.createBrand(owner, publicId, { name }, mutation())).data.id;
      const secret = await make(`Secret ${k}x`);
      const old = await make(`Old ${k}x`);
      const binned = await make(`Binned ${k}x`);
      env.stepUp.allow = true;
      await env.svc.setSensitivity(
        owner,
        publicId,
        secret,
        { is_sensitive: true },
        mutation({ ifMatch: '"0"', stepUpToken: 't' }),
      );
      env.stepUp.allow = false;
      await env.svc.archiveBrand(owner, publicId, old, mutation({ ifMatch: '"0"' }));
      const idOf = async (p: string) =>
        (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [p])).rows[0]
          .id as string;
      // Trash through the real 1F command (no trash route exists in Phase 1).
      const binnedId = await idOf(binned);
      await env.h.app.withWorkspace(id, { module: 'test' }, (tx) =>
        env.lifecycle.trash(
          tx,
          testDecision('record.trash', id, { recordIds: [binnedId], principalId: newUuidV7() }),
          { exec: executionContext(id, syntheticPrincipal('member')), source: { kind: 'ui' } },
          binnedId,
        ),
      );
      const people = { owner } as Record<Who, Caller>;
      for (const role of ROLES) {
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
      const recMain = await seedRecord(db, id, await idOf(main));
      const recSecret = await seedRecord(db, id, await idOf(secret));
      const recWorkspace = await seedRecord(db, id, null);
      const guest = await seedAccount(db);
      await env.collab.invite(
        owner,
        publicId,
        { email: guest.auth.account.email, kind: 'guest', records: [{ record: recMain.publicId }] },
        mutation(),
      );
      await env.collab.acceptInvitation(
        guest,
        { token: await env.tokenFor(guest.auth.account.email) },
        mutation(),
      );
      people.guest = guest;
      W[k] = {
        key: `${k}x`,
        publicId,
        id,
        people,
        brands: { main, secret, old, binned },
        records: {
          main: recMain.publicId,
          secret: recSecret.publicId,
          workspace: recWorkspace.publicId,
        },
      };
      // The member reads the main brand through a grant; the others hold no brand grant.
      await apply(W[k], {
        kind: 'brand_grant',
        brand: main,
        principal: (await memberOf(W[k], 'member')).public_id,
        level: 'view',
      });
    }
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('every surface agrees for every principal in all three workspaces', async () => {
    for (const ws of Object.values(W)) {
      for (const who of WHO) {
        const s = await surfaces(ws, who);
        const label = `${ws.key}/${who}`;
        // The brand list, the all-brands scope, and the palette name the same active brands.
        expect(s.scope, label).toEqual(s.brands);
        expect(s.palette, label).toEqual(s.brands);
        // Favorites accept exactly the readable brands (active and archived), nothing foreign.
        expect(await favoritable(ws, who), label).toEqual([...s.brands, ...s.archived].sort());
        // Trashed brands and other workspaces' brands never appear anywhere.
        for (const other of Object.values(W)) {
          expect(s.brands, label).not.toContain(other.brands.binned);
          if (other !== ws)
            for (const b of Object.values(other.brands)) {
              expect([...s.brands, ...s.archived, ...s.palette], label).not.toContain(b);
            }
          if (other !== ws)
            for (const r of Object.values(other.records)) expect(s.records, label).not.toContain(r);
        }
        // The sensitive brand and its record need the explicit grant (only the marking owner).
        const secretVisible = who === 'owner';
        expect(s.brands.includes(ws.brands.secret), label).toBe(secretVisible);
        expect(s.records.includes(ws.records.secret), label).toBe(secretVisible);
      }
      // Role expectations (0C): owners and administrators see non-sensitive brands; members
      // see granted brands; limited, read-only, and guests see no brand.
      const b = async (who: Who) => (await surfaces(ws, who)).brands;
      expect(await b('administrator')).toEqual([ws.brands.main]);
      expect(await b('member')).toEqual([ws.brands.main]);
      expect(await b('limited_member')).toEqual([]);
      expect(await b('read_only')).toEqual([]);
      expect(await b('guest')).toEqual([]);
      // The guest reads exactly the one shared record and nothing else.
      expect((await surfaces(ws, 'guest')).records).toEqual([ws.records.main]);
    }
  });

  it('forged identifiers and other workspaces are the same not_found on every surface', async () => {
    const a = W.a;
    const b = W.b;
    for (const who of WHO) {
      const caller = a.people[who];
      await expect(env.svc.listBrands(caller, b.publicId, {})).rejects.toEqual(reason('not_found'));
      await expect(env.svc.getContext(caller, b.publicId)).rejects.toEqual(reason('not_found'));
      await expect(env.collab.searchTargets(caller, b.publicId, 'x')).rejects.toEqual(
        reason('not_found'),
      );
      await expect(env.collab.listReadableRecords(caller, b.publicId)).rejects.toEqual(
        reason('not_found'),
      );
      await expect(env.collab.addFavorite(caller, b.publicId, b.brands.main)).rejects.toEqual(
        reason('not_found'),
      );
    }
    // A scope token naming foreign or hidden brands narrows; it never broadens.
    const ctx = await env.svc.getContext(a.people.member, a.publicId, {
      scope: `brands:${b.brands.main},${a.brands.secret},${a.brands.main}`,
    });
    expect(ctx.scope).toEqual({ kind: 'brand', brand_id: a.brands.main });
    expect(ctx.scope_token).toBe(`brand:${a.brands.main}`);
    // Sharing a foreign record, or one the owner cannot read, is refused without detail.
    await expect(
      env.collab.createShare(
        a.people.owner,
        a.publicId,
        {
          record: b.records.main,
          principal: (await memberOf(a, 'guest')).public_id,
          level: 'read',
        },
        mutation(),
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(not_found|validation_failed)$/) });
  });

  it('direct app_rw and app_worker see one workspace per context and nothing without one', async () => {
    const tables = [
      'tenancy.brand',
      'core.record',
      'tenancy.membership',
      'access.role_assignment',
      'access.record_grant',
      'views.favorite',
      'audit.audit_event',
    ];
    for (const url of [db.app, db.worker]) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        for (const t of tables) {
          const unset = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
          expect(unset.rows[0].n, `${t} without context`).toBe(0);
        }
        for (const ws of Object.values(W)) {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [ws.id]);
          for (const t of tables) {
            const r = await client.query(
              `SELECT count(*)::int AS n, count(*) FILTER (WHERE workspace_id <> $1)::int AS foreign_rows FROM ${t}`,
              [ws.id],
            );
            expect(r.rows[0].foreign_rows, `${t} in ${ws.key}`).toBe(0);
            expect(r.rows[0].n, `${t} in ${ws.key}`).toBeGreaterThan(0);
          }
          await client.query('ROLLBACK');
        }
      } finally {
        await client.end();
      }
    }
  });

  it('revoke, suspend, and remove take effect on the next check on the same pooled connection', async () => {
    const c = W.c;
    const pid = () =>
      env.h.app.withWorkspace(c.id, { module: 'test', readOnly: true }, async (tx) => {
        const r = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx.db);
        return r.rows[0]!.pid;
      });
    /** The epochs a job would record when enqueued for this principal now. */
    const enqueue = async (membershipId: string) => {
      const r = await db.admin(
        `SELECT coalesce(max(epoch) FILTER (WHERE epoch_kind = 'workspace'), 0)::int AS ws,
                coalesce(max(epoch) FILTER (WHERE epoch_kind = 'principal'), 0)::int AS principal
           FROM access.permission_epoch
          WHERE workspace_id = $1 AND (epoch_kind = 'workspace' OR subject_id = $2)`,
        [c.id, membershipId],
      );
      return { membershipId, ws: r.rows[0].ws as number, principal: r.rows[0].principal as number };
    };
    /** The worker's execution-time check for a job enqueued with those epochs. */
    const freshness = (job: Awaited<ReturnType<typeof enqueue>>) =>
      env.h.worker.withWorkspace(c.id, { module: 'test', readOnly: true }, (tx) =>
        principalFreshness(tx, env.h.telemetry.metrics, {
          membershipId: job.membershipId,
          workspaceEpochAtEnqueue: job.ws,
          principalEpochAtEnqueue: job.principal,
          consumer: 'job',
        }),
      );

    // Revoke a brand grant: every surface drops the brand, the favorite disappears on read.
    const member = await memberOf(c, 'member');
    await env.collab.addFavorite(c.people.member, c.publicId, c.brands.main);
    const memberJob = await enqueue(member.id);
    expect(await freshness(memberJob)).toBe('current');
    const granted = await surfaces(c, 'member');
    expect(granted.brands).toEqual([c.brands.main]);
    expect(granted.records).toEqual([c.records.main, c.records.workspace].sort());
    const before = await pid();
    await apply(c, { kind: 'brand_revoke', brand: c.brands.main, principal: member.public_id });
    const after = await surfaces(c, 'member');
    expect(await pid()).toBe(before); // the checks above reused the same server connection
    // Workspace-scoped records stay readable by role; the brand's record goes with the brand.
    expect(after).toMatchObject({
      brands: [],
      scope: [],
      palette: [],
      records: [c.records.workspace],
    });
    expect(await env.collab.listFavorites(c.people.member, c.publicId)).toEqual([]);
    expect(await freshness(memberJob)).toBe('changed');

    // Suspend: the next request on any surface is not_found; the worker sees a revoked principal.
    const limited = await memberOf(c, 'limited_member');
    const limitedJob = await enqueue(limited.id);
    expect(await freshness(limitedJob)).toBe('current');
    await apply(c, { kind: 'suspend', member: limited.public_id });
    for (const call of [
      () => env.svc.listBrands(c.people.limited_member, c.publicId, {}),
      () => env.svc.getContext(c.people.limited_member, c.publicId),
      () => env.collab.searchTargets(c.people.limited_member, c.publicId, 'x'),
      () => env.collab.listFavorites(c.people.limited_member, c.publicId),
      () => env.collab.listReadableRecords(c.people.limited_member, c.publicId),
    ])
      await expect(call()).rejects.toEqual(reason('not_found'));
    expect(await freshness(limitedJob)).toBe('revoked');

    // Remove the guest: the share stops counting at once; sessions end; the worker agrees.
    const guest = await memberOf(c, 'guest');
    const guestJob = await enqueue(guest.id);
    const preview = await env.collab.previewChange(c.people.owner, c.publicId, {
      kind: 'remove',
      member: guest.public_id,
    });
    env.stepUp.allow = true;
    try {
      await env.collab.removeMember(
        c.people.owner,
        c.publicId,
        guest.public_id,
        { preview_token: preview.preview_token },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
    await expect(env.collab.listReadableRecords(c.people.guest, c.publicId)).rejects.toEqual(
      reason('not_found'),
    );
    expect(await freshness(guestJob)).toBe('revoked');
    const live = await db.admin(
      `SELECT count(*)::int AS n FROM identity.session WHERE account_id = $1 AND revoked_at IS NULL`,
      [c.people.guest.auth.account.id],
    );
    expect(live.rows[0].n).toBe(0);
    // Other workspaces are untouched by any of it.
    expect((await surfaces(W.a, 'member')).brands).toEqual([W.a.brands.main]);
    expect((await surfaces(W.b, 'guest')).records).toEqual([W.b.records.main]);
  });
});
