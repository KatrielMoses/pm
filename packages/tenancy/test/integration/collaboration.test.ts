import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { principalFreshness, type Caller } from '@pm/tenancy';
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

/** Phase 1D: invitations, six roles, guests, grantable authority, preview vs enforcement. */
describe('collaboration (1D)', () => {
  let db: TestDatabase;
  let env: CollabEnv;
  let owner: Caller;
  let ws: string;
  let wsId: string;
  let brandA: string;
  let brandS: string;
  const people: Record<string, Caller> = {};

  async function invite(as: Caller, body: Record<string, unknown>) {
    return env.collab.invite(as, ws, body, mutation());
  }
  async function accept(who: Caller) {
    const token = await env.tokenFor(who.auth.account.email);
    return env.collab.acceptInvitation(who, { token }, mutation());
  }
  async function join(role: string): Promise<Caller> {
    const who = await seedAccount(db);
    await invite(owner, { email: who.auth.account.email, kind: 'member', role });
    await accept(who);
    return who;
  }
  async function apply(
    as: Caller,
    change: Record<string, unknown>,
    extra: { stepUp?: boolean } = {},
  ) {
    const preview = await env.collab.previewChange(as, ws, change);
    env.stepUp.allow = extra.stepUp ?? true;
    try {
      return await env.collab.applyChange(
        as,
        ws,
        { change, preview_token: preview.preview_token },
        mutation({ stepUpToken: 'verified-step-up' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
  }
  const brandIdsOf = async (who: Caller) =>
    (await env.svc.listBrands(who, ws, {})).data.map((b) => b.id).sort();

  beforeAll(async () => {
    db = await createTestDatabase();
    env = collabEnv(db);
    owner = await seedAccount(db);
    const created = await env.collab.createWorkspace(
      owner,
      { ...WORKSPACE_INPUT, name: 'Collab Co', first_brand: { name: 'Alpha' } },
      mutation(),
    );
    ws = created.data.workspace.id;
    wsId = await workspaceIdOf(db, ws);
    brandA = created.data.first_brand!.id;
    brandS = (await env.collab.createBrand(owner, ws, { name: 'Secret' }, mutation())).data.id;
    env.stepUp.allow = true;
    await env.collab.setSensitivity(
      owner,
      ws,
      brandS,
      { is_sensitive: true },
      mutation({ ifMatch: '"0"', stepUpToken: 't' }),
    );
    env.stepUp.allow = false;
    for (const role of ['administrator', 'member', 'limited_member', 'read_only'])
      people[role] = await join(role);
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('invitations create canonical memberships with exactly the invited role', async () => {
    const roles = await db.admin(
      `SELECT r.key, count(*)::int AS n FROM access.role_assignment a JOIN access.role r ON r.id = a.role_id
        WHERE a.workspace_id = $1 AND a.scope_type = 'workspace' GROUP BY 1 ORDER BY 1`,
      [wsId],
    );
    expect(roles.rows).toEqual([
      { key: 'administrator', n: 1 },
      { key: 'limited_member', n: 1 },
      { key: 'member', n: 1 },
      { key: 'owner', n: 1 },
      { key: 'read_only', n: 1 },
    ]);
    const people_ = await env.collab.listMembers(owner, ws, {});
    expect(people_).toHaveLength(5);
    // Emails only for people managers; never internal IDs.
    const asMember = await env.collab.listMembers(people.member!, ws, {});
    expect(asMember.every((m) => m.email === null)).toBe(true);
    expect(JSON.stringify(asMember)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('acceptance is single-use, email-bound, race-safe, and enumeration-safe', async () => {
    const invitee = await seedAccount(db);
    const stranger = await seedAccount(db);
    await invite(owner, { email: invitee.auth.account.email, kind: 'member', role: 'member' });
    const token = await env.tokenFor(invitee.auth.account.email);
    await expect(env.collab.acceptInvitation(stranger, { token }, mutation())).rejects.toEqual(
      reason('not_found'),
    );
    await expect(env.collab.inspectInvitation(stranger, { token })).resolves.toEqual({
      status: 'email_mismatch',
    });
    await expect(env.collab.inspectInvitation(invitee, { token })).resolves.toMatchObject({
      status: 'ready',
      workspace_name: 'Collab Co',
      kind: 'member',
      role: 'member',
    });
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => env.collab.acceptInvitation(invitee, { token }, mutation())),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(
      results
        .map((r) => (r as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed)
        .filter((x) => !x),
    ).toHaveLength(1);
    expect((await membershipOf(db, wsId, invitee.auth.account.id))?.state).toBe('active');
    // Another account can never reuse the consumed token.
    await expect(env.collab.acceptInvitation(stranger, { token }, mutation())).rejects.toEqual(
      reason('not_found'),
    );
    // Garbage, unknown, and revoked tokens look identical.
    for (const t of ['nope', 'x'.repeat(43), undefined])
      await expect(env.collab.acceptInvitation(invitee, { token: t }, mutation())).rejects.toEqual(
        reason('not_found'),
      );
    // Existing members and pending invitations are explicit; unknown emails succeed silently.
    await expect(
      invite(owner, { email: invitee.auth.account.email, kind: 'member', role: 'member' }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      issues: [expect.objectContaining({ code: 'already_member' })],
    });
    await invite(owner, { email: 'nobody-here@example.test', kind: 'member', role: 'member' });
    await expect(
      invite(owner, { email: 'Nobody-Here@Example.test', kind: 'member', role: 'member' }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'already_invited' })],
    });
  });

  it('resend supersedes the old token; revoke ends the invitation', async () => {
    const invitee = await seedAccount(db);
    const inv = (
      await invite(owner, { email: invitee.auth.account.email, kind: 'member', role: 'read_only' })
    ).data;
    const first = await env.tokenFor(invitee.auth.account.email);
    await env.collab.resendInvitation(owner, ws, inv.id, mutation());
    const second = await env.tokenFor(invitee.auth.account.email);
    expect(second).not.toBe(first);
    await expect(
      env.collab.acceptInvitation(invitee, { token: first }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    await env.collab.revokeInvitation(owner, ws, inv.id, mutation());
    await expect(
      env.collab.acceptInvitation(invitee, { token: second }, mutation()),
    ).rejects.toEqual(reason('not_found'));
  });

  it('grantable authority: administrators never create owners; members invite only guests by policy', async () => {
    const x = await seedAccount(db);
    await expect(
      invite(people.administrator!, { email: x.auth.account.email, kind: 'member', role: 'owner' }),
    ).rejects.toEqual(reason('forbidden'));
    await expect(
      invite(people.member!, { email: x.auth.account.email, kind: 'member', role: 'member' }),
    ).rejects.toEqual(reason('forbidden'));
    const rec = await seedRecord(
      db,
      wsId,
      (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [brandA])).rows[0].id,
    );
    await expect(
      invite(people.member!, {
        email: x.auth.account.email,
        kind: 'guest',
        records: [{ record: rec.publicId }],
      }),
    ).rejects.toEqual(reason('forbidden'));
    // Role change: an administrator cannot promote to owner, nor touch an owner.
    const target = (await membershipOf(db, wsId, people.member!.auth.account.id))!;
    await expect(
      apply(people.administrator!, { kind: 'role', member: target.public_id, role: 'owner' }),
    ).rejects.toEqual(reason('forbidden'));
    const ownerM = (await membershipOf(db, wsId, owner.auth.account.id))!;
    await expect(
      apply(people.administrator!, { kind: 'suspend', member: ownerM.public_id }),
    ).rejects.toEqual(reason('forbidden'));
  });

  it('guests see exactly their shared records: no directory, brands, children, or onward sharing', async () => {
    const alphaId = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [brandA]))
      .rows[0].id;
    const shared = await seedRecord(db, wsId, alphaId);
    const other = await seedRecord(db, wsId, alphaId);
    const guest = await seedAccount(db);
    await expect(
      invite(owner, {
        email: guest.auth.account.email,
        kind: 'guest',
        brands: [{ brand: brandA, level: 'view' }],
      }),
    ).rejects.toEqual(reason('validation_failed'));
    await invite(owner, {
      email: guest.auth.account.email,
      kind: 'guest',
      records: [{ record: shared.publicId, level: 'comment' }],
    });
    await accept(guest);
    expect((await env.collab.listReadableRecords(guest, ws)).map((r) => r.id)).toEqual([
      shared.publicId,
    ]);
    expect((await env.collab.listReadableRecords(guest, ws))[0]!.brand).toMatchObject({
      name: 'Alpha',
    });
    await expect(env.collab.listMembers(guest, ws, {})).rejects.toEqual(reason('not_found'));
    await expect(env.collab.listTeams(guest, ws, {})).rejects.toEqual(reason('not_found'));
    expect(await brandIdsOf(guest)).toEqual([]);
    expect((await env.svc.getContext(guest, ws)).brands).toEqual([]);
    // Readable but not shareable by a guest (received share authority never reshares, AT-050):
    // forbidden. A record the guest cannot read stays not_found and indistinguishable from a
    // guessed identifier (AT-115).
    await expect(
      env.collab.createShare(guest, ws, { record: shared.publicId, grantee: brandA }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    await expect(
      env.collab.createShare(guest, ws, { record: other.publicId, grantee: brandA }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    await expect(
      env.collab.createShare(
        guest,
        ws,
        { record: 'fxt_01J0000000000000000000000Z', grantee: brandA },
        mutation(),
      ),
    ).rejects.toEqual(reason('not_found'));
    expect((await env.collab.listReadableRecords(guest, ws)).map((r) => r.id)).not.toContain(
      other.publicId,
    );
    // Guest memberships hold no role assignments (database role shape).
    const g = (await membershipOf(db, wsId, guest.auth.account.id))!;
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM access.role_assignment WHERE principal_id = $1`,
          [g.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('brand grants and teams through preview/apply; sensitive brands need explicit grants; preview matches enforcement', async () => {
    const lim = people.limited_member!;
    const limM = (await membershipOf(db, wsId, lim.auth.account.id))!;
    expect(await brandIdsOf(lim)).toEqual([]);
    const preview = await env.collab.previewChange(owner, ws, {
      kind: 'brand_grant',
      brand: brandA,
      principal: limM.public_id,
      level: 'edit',
    });
    expect(preview.diff).toMatchObject({
      increases_access: true,
      brands: [{ brand: { id: brandA }, before: null, after: 'edit' }],
    });
    // A stale or forged fingerprint is refused.
    await expect(
      env.collab.applyChange(
        owner,
        ws,
        {
          change: { kind: 'brand_grant', brand: brandA, principal: limM.public_id, level: 'edit' },
          preview_token: 'x.y',
        },
        mutation(),
      ),
    ).rejects.toEqual(reason('conflict'));
    await apply(owner, {
      kind: 'brand_grant',
      brand: brandA,
      principal: limM.public_id,
      level: 'edit',
    });
    expect(await brandIdsOf(lim)).toEqual([brandA]);
    // Preview of the member now equals enforcement.
    const explanation = await env.collab.previewMember(owner, ws, limM.public_id);
    const previewed = explanation.explanation.brands
      .filter((b) => b.level !== null)
      .map((b) => b.brand.id)
      .sort();
    expect(previewed).toEqual(await brandIdsOf(lim));

    // Read-only role cap: an edit grant still reads as view.
    const ro = (await membershipOf(db, wsId, people.read_only!.auth.account.id))!;
    await apply(owner, {
      kind: 'brand_grant',
      brand: brandA,
      principal: ro.public_id,
      level: 'edit',
    });
    const roView = await env.collab.previewMember(owner, ws, ro.public_id);
    expect(roView.explanation.brands.find((b) => b.brand.id === brandA)?.level).toBe('view');

    // Sensitive brand: the administrator has no implicit access, through a team grant it does.
    const admin = people.administrator!;
    const adminM = (await membershipOf(db, wsId, admin.auth.account.id))!;
    expect(await brandIdsOf(admin)).not.toContain(brandS);
    const team = (await env.collab.createTeam(owner, ws, { name: 'Core' }, mutation())).data;
    await apply(owner, { kind: 'brand_grant', brand: brandS, principal: team.id, level: 'view' });
    expect(await brandIdsOf(admin)).not.toContain(brandS);
    await apply(owner, { kind: 'team_add', team: team.id, member: adminM.public_id });
    expect(await brandIdsOf(admin)).toContain(brandS);
    await apply(owner, { kind: 'team_remove', team: team.id, member: adminM.public_id });
    expect(await brandIdsOf(admin)).not.toContain(brandS);
    // The administrator cannot preview or see the sensitive brand's grants.
    await expect(env.collab.listBrandAccess(admin, ws, brandS)).rejects.toEqual(
      reason('not_found'),
    );
    // The owner's own creator grant is the last manager of the sensitive brand: not revocable.
    const ownerM = (await membershipOf(db, wsId, owner.auth.account.id))!;
    await expect(
      apply(owner, { kind: 'brand_revoke', brand: brandS, principal: ownerM.public_id }),
    ).rejects.toEqual(reason('conflict'));
  });

  it('removal: ownership plan, sessions, jobs, grants, and next-check revocation', async () => {
    const leaver = await join('member');
    const m = (await membershipOf(db, wsId, leaver.auth.account.id))!;
    const alphaId = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [brandA]))
      .rows[0].id;
    await seedRecord(db, wsId, alphaId, m.id);
    await db.admin(
      `INSERT INTO identity.session (id, public_id, account_id, token_hash, idle_expires_at, absolute_expires_at, auth_methods, assurance)
       VALUES (uuidv7(), 'ses_' || upper(substr(md5(random()::text), 1, 26)), $1, decode(md5(random()::text) || md5(random()::text), 'hex'),
               now() + interval '1 hour', now() + interval '1 day', ARRAY['password'], 'single_factor')`,
      [leaver.auth.account.id],
    );
    const preview = await env.collab.previewChange(owner, ws, {
      kind: 'remove',
      member: m.public_id,
    });
    env.stepUp.allow = true;
    try {
      await expect(
        env.collab.removeMember(
          owner,
          ws,
          m.public_id,
          { preview_token: preview.preview_token },
          mutation({ stepUpToken: 't' }),
        ),
      ).rejects.toMatchObject({
        code: 'conflict',
        issues: [expect.objectContaining({ code: 'ownership_reassignment_required' })],
      });
      const ownerM = (await membershipOf(db, wsId, owner.auth.account.id))!;
      await env.collab.removeMember(
        owner,
        ws,
        m.public_id,
        { preview_token: preview.preview_token, reassign_to: ownerM.public_id },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
    expect((await membershipOf(db, wsId, leaver.auth.account.id))?.state).toBe('removed');
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM identity.session WHERE account_id = $1 AND revoked_at IS NULL`,
          [leaver.auth.account.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM core.record WHERE owner_membership_id = $1`,
          [m.id],
        )
      ).rows[0].n,
    ).toBe(0);
    // Deferred consumers re-check at execution: the departed principal is revoked.
    await env.h.app.withWorkspace(wsId, { module: 'test' }, async (tx) =>
      expect(
        await principalFreshness(tx, env.h.telemetry.metrics, {
          membershipId: m.id,
          workspaceEpochAtEnqueue: 0,
          principalEpochAtEnqueue: 0,
          consumer: 'job',
        }),
      ).toBe('revoked'),
    );
    // The next check fails: a removed principal resolves nothing (no stale cache exists to reuse).
    await expect(env.svc.listBrands(leaver, ws, {})).rejects.toEqual(reason('not_found'));
  });

  it('the last owner cannot leave; a member can', async () => {
    await expect(env.collab.leave(owner, ws, {}, mutation())).rejects.toMatchObject({
      code: 'conflict',
    });
    const m = await join('member');
    await env.collab.leave(m, ws, {}, mutation());
    expect((await membershipOf(db, wsId, m.auth.account.id))?.state).toBe('removed');
  });

  it('ownership transfer: owner-only with step-up; only the recipient accepts, with step-up', async () => {
    const admin = people.administrator!;
    const adminM = (await membershipOf(db, wsId, admin.auth.account.id))!;
    await expect(
      env.collab.requestOwnershipTransfer(
        admin,
        ws,
        { to: adminM.public_id, demote_previous: true },
        mutation(),
      ),
    ).rejects.toEqual(reason('forbidden'));
    await expect(
      env.collab.requestOwnershipTransfer(
        owner,
        ws,
        { to: adminM.public_id, demote_previous: true },
        mutation(),
      ),
    ).rejects.toEqual(reason('step_up_required'));
    env.stepUp.allow = true;
    const t = (
      await env.collab.requestOwnershipTransfer(
        owner,
        ws,
        { to: adminM.public_id, demote_previous: true },
        mutation({ stepUpToken: 't' }),
      )
    ).data;
    env.stepUp.allow = false;
    await expect(
      env.collab.acceptOwnershipTransfer(people.member!, ws, t.id, mutation()),
    ).rejects.toEqual(reason('not_found'));
    await expect(env.collab.acceptOwnershipTransfer(admin, ws, t.id, mutation())).rejects.toEqual(
      reason('step_up_required'),
    );
    env.stepUp.allow = true;
    await env.collab.acceptOwnershipTransfer(admin, ws, t.id, mutation({ stepUpToken: 't' }));
    env.stepUp.allow = false;
    const roles = await db.admin(
      `SELECT m.account_id, r.key FROM access.role_assignment a JOIN access.role r ON r.id = a.role_id
         JOIN tenancy.membership m ON m.id = a.membership_principal_id
        WHERE a.workspace_id = $1 AND a.scope_type = 'workspace' AND m.account_id IN ($2, $3)`,
      [wsId, owner.auth.account.id, admin.auth.account.id],
    );
    expect(Object.fromEntries(roles.rows.map((r) => [r.account_id, r.key]))).toEqual({
      [owner.auth.account.id]: 'administrator',
      [admin.auth.account.id]: 'owner',
    });
  });

  it('workspace policy: governing actions, owner-only billing toggle, exposure confirmation, step-up', async () => {
    // After the transfer above, the former owner is an administrator.
    const newOwner = people.administrator!;
    await expect(
      env.collab.updatePolicy(
        people.member!,
        ws,
        { changes: { members_invite_guests: true } },
        mutation(),
      ),
    ).rejects.toEqual(reason('forbidden'));
    await expect(
      env.collab.updatePolicy(owner, ws, { changes: { admins_manage_billing: true } }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    await expect(
      env.collab.updatePolicy(
        newOwner,
        ws,
        { changes: { members_invite_guests: true } },
        mutation(),
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
      issues: [expect.objectContaining({ code: 'exposure_confirmation_required' })],
    });
    await expect(
      env.collab.updatePolicy(
        newOwner,
        ws,
        { changes: { members_invite_guests: true }, confirm_exposure: true },
        mutation(),
      ),
    ).rejects.toEqual(reason('step_up_required'));
    env.stepUp.allow = true;
    await env.collab.updatePolicy(
      newOwner,
      ws,
      { changes: { members_invite_guests: true }, confirm_exposure: true },
      mutation({ stepUpToken: 't' }),
    );
    env.stepUp.allow = false;
    await expect(
      env.collab.updatePolicy(
        newOwner,
        ws,
        { changes: { public_links_enabled: true } },
        mutation(),
      ),
    ).rejects.toEqual(reason('validation_failed'));
    expect((await env.collab.getPolicy(newOwner, ws)).settings.members_invite_guests).toMatchObject(
      { value: true },
    );
  });
});
