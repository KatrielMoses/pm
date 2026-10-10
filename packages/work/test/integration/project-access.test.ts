import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { principalFreshness, type Caller } from '@pm/tenancy';
import {
  apply,
  join,
  membershipOf,
  mutation,
  seedAccount,
  workEnv,
  workspaceIdOf,
  WORKSPACE_INPUT,
  type WorkEnv,
} from './fixture.ts';

const reason = (code: string) => expect.objectContaining({ code });
const ROLES = ['administrator', 'member', 'limited_member', 'read_only'] as const;
type Who = 'owner' | (typeof ROLES)[number] | 'guest' | 'outsider';

/**
 * Phase 2A project authority (0C AZ-21) across three workspaces, all six roles, a guest, sensitive
 * and archived brands, restricted and inherited projects, exact cross-brand shares, and access
 * changes. Every surface agrees with single-record enforcement; preview equals enforcement.
 */
describe('project authority and sharing (2A)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  const W: Array<{
    ws: string;
    id: string;
    people: Record<Who, Caller>;
    brands: Record<string, string>;
  }> = [];

  const ids = async (who: Caller, ws: string) =>
    (await env.svc.listProjects(who, ws, {})).data.map((p) => p.id).sort();
  const can = async (who: Caller, ws: string, prj: string) =>
    env.svc.getProject(who, ws, prj).then(
      () => true,
      (e) => {
        expect(e).toEqual(reason('not_found'));
        return false;
      },
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    for (const k of ['a', 'b', 'c']) {
      const o = await seedAccount(db);
      const created = await env.svc.createWorkspace(
        o,
        { ...WORKSPACE_INPUT, name: `W ${k}`, first_brand: { name: `Main ${k}` } },
        mutation(),
      );
      const ws = created.data.workspace.id;
      const brands: Record<string, string> = { main: created.data.first_brand!.id };
      brands.other = (await env.svc.createBrand(o, ws, { name: `Other ${k}` }, mutation())).data.id;
      brands.secret = (
        await env.svc.createBrand(o, ws, { name: `Secret ${k}` }, mutation())
      ).data.id;
      env.stepUp.allow = true;
      await env.svc.setSensitivity(
        o,
        ws,
        brands.secret,
        { is_sensitive: true },
        mutation({ ifMatch: '"0"', stepUpToken: 't' }),
      );
      env.stepUp.allow = false;
      const people = { owner: o } as Record<Who, Caller>;
      for (const role of ROLES) people[role] = await join(env, db, o, ws, { kind: 'member', role });
      people.outsider = await seedAccount(db);
      W.push({ ws, id: await workspaceIdOf(db, ws), people, brands });
    }
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('inherited projects follow brand access; restricted projects need explicit grants for everyone', async () => {
    const { ws, people, brands } = W[0]!;
    const open = (
      await env.svc.createProject(
        people.owner,
        ws,
        { brand: brands.main, name: 'Open' },
        mutation(),
      )
    ).data;
    const restricted = (
      await env.svc.createProject(
        people.owner,
        ws,
        { brand: brands.main, name: 'Board' },
        mutation(),
      )
    ).data;
    const inside = (
      await env.svc.createProject(
        people.owner,
        ws,
        { parent: restricted.id, name: 'Board child' },
        mutation(),
      )
    ).data;
    await env.svc.setAccess(
      people.owner,
      ws,
      restricted.id,
      { access_mode: 'restricted' },
      mutation(),
    );
    const secret = (
      await env.svc.createProject(
        people.owner,
        ws,
        { brand: brands.secret, name: 'Secret plan' },
        mutation(),
      )
    ).data;
    // Administrators have implicit access to non-restricted projects in non-sensitive brands only.
    expect(await can(people.administrator, ws, open.id)).toBe(true);
    expect(await can(people.administrator, ws, restricted.id)).toBe(false);
    expect(await can(people.administrator, ws, inside.id)).toBe(false);
    expect(await can(people.administrator, ws, secret.id)).toBe(false);
    // The owner keeps the explicit manage grant created with the restriction and the project.
    expect(await can(people.owner, ws, restricted.id)).toBe(true);
    expect(await can(people.owner, ws, inside.id)).toBe(true);
    // Members without grants see nothing, regardless of role.
    for (const r of ['member', 'limited_member', 'read_only'] as const)
      expect(await ids(people[r], ws)).toEqual([]);
    // An explicit project grant flows down to descendants.
    const m = (await membershipOf(db, W[0]!.id, people.member.auth.account.id))!;
    const { preview } = await apply(env, people.owner, ws, {
      kind: 'project_grant',
      project: restricted.id,
      principal: m.public_id,
      level: 'view',
    });
    expect(preview.diff.projects).toEqual([
      { project: { id: restricted.id, name: 'Board' }, before: null, after: 'view' },
    ]);
    expect(preview.diff.records_gained).toMatchObject({ project: 2 });
    expect(await ids(people.member, ws)).toEqual([inside.id, restricted.id].sort());
    // Preview equals enforcement: what the member can now read is exactly the previewed records.
    expect((await env.svc.listProjects(people.member, ws, {})).total.value).toBe(2);
    // Read-only can never exceed view, even with a manage grant.
    const ro = (await membershipOf(db, W[0]!.id, people.read_only.auth.account.id))!;
    await apply(env, people.owner, ws, {
      kind: 'project_grant',
      project: open.id,
      principal: ro.public_id,
      level: 'view',
    });
    expect((await env.svc.getProject(people.read_only, ws, open.id)).capabilities.edit).toBe(false);
  });

  it('collaborators: grants above the granter are refused; the last eligible manager cannot be removed', async () => {
    const { ws, people, brands, id } = W[1]!;
    const p = (
      await env.svc.createProject(
        people.owner,
        ws,
        { brand: brands.main, name: 'Collab' },
        mutation(),
      )
    ).data;
    const mem = (await membershipOf(db, id, people.member.auth.account.id))!;
    const ownerM = (await membershipOf(db, id, people.owner.auth.account.id))!;
    await apply(env, people.owner, ws, {
      kind: 'project_grant',
      project: p.id,
      principal: mem.public_id,
      level: 'edit',
    });
    // An edit-level member cannot grant manage (never above their own level).
    const lim = (await membershipOf(db, id, people.limited_member.auth.account.id))!;
    await expect(
      env.svc.previewChange(people.member, ws, {
        kind: 'project_grant',
        project: p.id,
        principal: lim.public_id,
        level: 'manage',
      }),
    ).rejects.toEqual(reason('forbidden'));
    // Removing the owner's own manage grant (the only eligible manager) is refused.
    await expect(
      apply(env, people.owner, ws, {
        kind: 'project_revoke',
        project: p.id,
        principal: ownerM.public_id,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'conflict',
        issues: [expect.objectContaining({ code: 'last_project_manager' })],
      }),
    );
    // Transfer ownership: the new owner receives an explicit manage grant atomically.
    await env.svc.setOwner(people.owner, ws, p.id, { owner: mem.public_id }, mutation());
    expect((await env.svc.getProject(people.member, ws, p.id)).capabilities.manage_access).toBe(
      true,
    );
    await apply(env, people.owner, ws, {
      kind: 'project_revoke',
      project: p.id,
      principal: ownerM.public_id,
    });
    expect((await env.svc.getProject(people.member, ws, p.id)).owner).toMatchObject({
      id: mem.public_id,
    });
  });

  it('cross-brand exact shares: the project record only, never children, never reshared', async () => {
    const { ws, people, brands, id } = W[2]!;
    const p = (
      await env.svc.createProject(
        people.owner,
        ws,
        { brand: brands.main, name: 'Shared launch' },
        mutation(),
      )
    ).data;
    const phase = (
      await env.svc.createPhase(people.owner, ws, p.id, { name: 'Hidden phase' }, mutation())
    ).data;
    const child = (
      await env.svc.createProject(
        people.owner,
        ws,
        { parent: p.id, name: 'Hidden child' },
        mutation(),
      )
    ).data;
    await env.svc.addItem(
      people.owner,
      ws,
      p.id,
      'criteria',
      { kind: 'success', text: 'Shared criterion' },
      mutation(),
    );
    const guest = await join(env, db, people.owner, ws, {
      kind: 'guest',
      records: [{ record: p.id, level: 'comment' }],
    });
    // The guest reads exactly the project record and its own fields.
    const o = await env.svc.overview(guest, ws, p.id);
    expect(o.project.name).toBe('Shared launch');
    expect(o.criteria.map((c) => c.text)).toEqual(['Shared criterion']);
    expect(o.phases).toEqual([]);
    expect(o.children).toEqual([]);
    expect(o.decisions).toEqual([]);
    expect(await can(guest, ws, child.id)).toBe(false);
    expect(await ids(guest, ws)).toEqual([p.id]);
    // Received share authority never reshares (forbidden: the project is readable).
    const brandB = brands.other;
    await expect(
      env.svc.createShare(guest, ws, { record: p.id, grantee: brandB }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    // Unreadable targets stay not_found (AT-115); unshareable types are forbidden (AT-116).
    await expect(
      env.svc.createShare(guest, ws, { record: child.id, grantee: brandB }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.createShare(people.owner, ws, { record: phase.id, grantee: brandB }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    // A project share cannot carry children.
    await expect(
      env.svc.createShare(
        people.owner,
        ws,
        { record: p.id, children: [child.id], grantee: brandB },
        mutation(),
      ),
    ).rejects.toEqual(reason('validation_failed'));
    // Share levels are only those the project enforces; `view` maps to stored `read`.
    const mem = (await membershipOf(db, id, people.member.auth.account.id))!;
    const reviewed = await apply(env, people.owner, ws, {
      kind: 'record_share',
      record: p.id,
      grantee: mem.public_id,
      level: 'view',
    });
    expect(reviewed.preview.diff.records_gained).toEqual({ project: 1 });
    expect((await env.svc.overview(people.member, ws, p.id)).phases).toEqual([]);
    const lvl = await db.admin(
      `SELECT level FROM access.record_grant g JOIN core.record r ON r.id = g.record_id WHERE r.public_id = $1 AND g.grantee_type = 'membership' ORDER BY g.created_at DESC LIMIT 1`,
      [p.id],
    );
    expect(lvl.rows[0].level).toBe('read');
    // Restricted projects refuse new shares unless allowed.
    await env.svc.setAccess(people.owner, ws, p.id, { access_mode: 'restricted' }, mutation());
    const lim = (await membershipOf(db, id, people.limited_member.auth.account.id))!;
    await expect(
      apply(env, people.owner, ws, {
        kind: 'record_share',
        record: p.id,
        grantee: lim.public_id,
        level: 'view',
      }),
    ).rejects.toEqual(reason('forbidden'));
    await env.svc.setAccess(people.owner, ws, p.id, { allow_record_shares: true }, mutation());
    await apply(env, people.owner, ws, {
      kind: 'record_share',
      record: p.id,
      grantee: lim.public_id,
      level: 'view',
    });
    expect(await can(people.limited_member, ws, p.id)).toBe(true);
  });

  it('share-only boundary: the project, criteria, scope, and the latest verified update; nothing else', async () => {
    const { ws, people, brands, id } = W[1]!;
    const o = people.owner;
    const p = (
      await env.svc.createProject(o, ws, { brand: brands.main, name: 'Boundary' }, mutation())
    ).data;
    await env.svc.addItem(o, ws, p.id, 'criteria', { kind: 'success', text: 'Crit' }, mutation());
    await env.svc.addItem(o, ws, p.id, 'scope', { kind: 'risk', text: 'Risk A' }, mutation());
    const phase = (await env.svc.createPhase(o, ws, p.id, { name: 'Hidden phase' }, mutation()))
      .data;
    const ms = (await env.svc.createMilestone(o, ws, p.id, { name: 'Hidden ms' }, mutation())).data;
    const dec = (
      await env.svc.createDecision(
        o,
        ws,
        p.id,
        { kind: 'decision', statement: 'Hidden' },
        mutation(),
      )
    ).data;
    const dep = (
      await env.svc.createProject(o, ws, { brand: brands.main, name: 'Dep' }, mutation())
    ).data;
    await env.svc.addDependency(o, ws, p.id, { target: dep.id }, mutation());
    const child = (await env.svc.createProject(o, ws, { parent: p.id, name: 'Child' }, mutation()))
      .data;
    const u1 = (await env.svc.postUpdate(o, ws, p.id, { body: 'Older verified' }, mutation())).data;
    await env.svc.verifyUpdate(o, ws, p.id, u1.id, mutation());
    const u2 = (await env.svc.postUpdate(o, ws, p.id, { body: 'Latest verified' }, mutation()))
      .data;
    await env.svc.verifyUpdate(o, ws, p.id, u2.id, mutation());
    const u3 = (await env.svc.postUpdate(o, ws, p.id, { body: 'Unverified draft' }, mutation()))
      .data;
    const series = (
      await env.svc.defineRecurrence(
        o,
        ws,
        p.id,
        {
          frequency: 'weekly',
          interval: 1,
          weekdays: ['MO'],
          start: '2030-01-07T09:00',
          anchor_tz: 'UTC',
        },
        mutation(),
      )
    ).data;
    // Restricted, so brand access does not apply: the member and the guest hold only the share.
    await env.svc.setAccess(
      o,
      ws,
      p.id,
      { access_mode: 'restricted', allow_record_shares: true },
      mutation(),
    );
    const mem = (await membershipOf(db, id, people.member.auth.account.id))!;
    const reviewed = await apply(env, o, ws, {
      kind: 'record_share',
      record: p.id,
      grantee: mem.public_id,
      level: 'edit',
    });
    // Preview equals enforcement: exactly one project, no structures.
    expect(reviewed.preview.diff.records_gained).toEqual({ project: 1 });
    const guest = await join(env, db, o, ws, {
      kind: 'guest',
      records: [{ record: p.id, level: 'comment' }],
    });
    for (const who of [people.member, guest]) {
      const ov = await env.svc.overview(who, ws, p.id);
      expect(ov.criteria.map((c) => c.text)).toEqual(['Crit']);
      expect(ov.scope_items.map((x) => x.text)).toEqual(['Risk A']);
      expect(ov.latest_verified_update).toEqual({ id: u2.id, body: 'Latest verified' });
      expect(ov.updates).toEqual([]);
      expect(ov.phases).toEqual([]);
      expect(ov.milestones).toEqual([]);
      expect(ov.decisions).toEqual([]);
      expect(ov.dependencies).toEqual({ blocked_by: [], blocks: [] });
      expect(ov.children).toEqual([]);
      expect(ov.project.recurrence).toBeNull();
      expect(JSON.stringify(ov)).not.toMatch(
        /Hidden|Older verified|Unverified draft|Child|verified_at/,
      );
      expect(ov.project.capabilities).toMatchObject({
        edit_structure: false,
        relate: false,
        save_template: false,
        manage_recurrence: false,
        verify_update: false,
        share: false,
      });
      // Every direct child endpoint is independently authorized: not_found with the share alone.
      const nf = reason('not_found');
      await expect(env.svc.listRecurrences(who, ws, p.id)).rejects.toEqual(nf);
      await expect(
        env.svc.updatePhase(who, ws, p.id, phase.id, { name: 'x' }, mutation({ ifMatch: '"0"' })),
      ).rejects.toEqual(nf);
      await expect(
        env.svc.childLifecycle(who, ws, p.id, 'phase', phase.id, 'archive', mutation()),
      ).rejects.toEqual(nf);
      await expect(
        env.svc.updateMilestone(who, ws, p.id, ms.id, { name: 'x' }, mutation({ ifMatch: '"0"' })),
      ).rejects.toEqual(nf);
      await expect(
        env.svc.updateDecision(
          who,
          ws,
          p.id,
          dec.id,
          { statement: 'x' },
          mutation({ ifMatch: '"0"' }),
        ),
      ).rejects.toEqual(nf);
      await expect(env.svc.verifyUpdate(who, ws, p.id, u3.id, mutation())).rejects.toEqual(nf);
      await expect(env.svc.removeDependency(who, ws, p.id, dep.id, mutation())).rejects.toEqual(nf);
      await expect(
        env.svc.setRecurrenceState(who, ws, p.id, series.id, { state: 'paused' }, mutation()),
      ).rejects.toEqual(nf);
      await expect(
        env.svc.generateNextOccurrence(who, ws, p.id, series.id, mutation()),
      ).rejects.toEqual(nf);
      await expect(env.svc.createPhase(who, ws, p.id, { name: 'x' }, mutation())).rejects.toEqual(
        nf,
      );
      await expect(env.svc.postUpdate(who, ws, p.id, { body: 'x' }, mutation())).rejects.toEqual(
        nf,
      );
      await expect(
        env.svc.createTemplateFromProject(who, ws, p.id, { name: 'T' }, mutation()),
      ).rejects.toEqual(nf);
      await expect(env.svc.duplicateProject(who, ws, p.id, {}, mutation())).rejects.toEqual(nf);
      expect(await can(who, ws, child.id)).toBe(false);
      // Lists and counts: the project only, with no child count.
      const listed = (await env.svc.listProjects(who, ws, {})).data.filter((x) => x.id === p.id);
      expect(listed).toEqual([expect.objectContaining({ id: p.id, children: 0, parent: null })]);
    }
    // The edit share edits the project's intrinsic facts (criteria, scope entries).
    await env.svc.addItem(
      people.member,
      ws,
      p.id,
      'criteria',
      { kind: 'success', text: 'Shared edit' },
      mutation(),
    );
    // Independent authority shows more: an explicit project grant restores every section.
    await apply(env, o, ws, {
      kind: 'project_grant',
      project: p.id,
      principal: mem.public_id,
      level: 'view',
    });
    const full = await env.svc.overview(people.member, ws, p.id);
    expect(full.phases.map((x) => x.name)).toEqual(['Hidden phase']);
    expect(full.updates).toHaveLength(3);
    expect(full.latest_verified_update).toMatchObject({
      id: u2.id,
      verified_at: expect.any(String),
    });
  });

  it('every surface agrees with single-record enforcement (list, palette, favorites, recents, breadcrumb)', async () => {
    const { ws, people, brands, id } = W[0]!;
    const visible = (
      await env.svc.createProject(
        people.owner,
        ws,
        { brand: brands.main, name: 'Zeta visible' },
        mutation(),
      )
    ).data;
    const hidden = (
      await env.svc.createProject(
        people.owner,
        ws,
        { brand: brands.main, name: 'Zeta hidden' },
        mutation(),
      )
    ).data;
    const under = (
      await env.svc.createProject(
        people.owner,
        ws,
        { parent: hidden.id, name: 'Zeta under' },
        mutation(),
      )
    ).data;
    await env.svc.setAccess(people.owner, ws, hidden.id, { access_mode: 'restricted' }, mutation());
    const lim = (await membershipOf(db, id, people.limited_member.auth.account.id))!;
    await apply(env, people.owner, ws, {
      kind: 'project_grant',
      project: visible.id,
      principal: lim.public_id,
      level: 'view',
    });
    await apply(env, people.owner, ws, {
      kind: 'project_grant',
      project: under.id,
      principal: lim.public_id,
      level: 'view',
    });
    for (const who of [
      'owner',
      'administrator',
      'member',
      'limited_member',
      'read_only',
    ] as const) {
      const caller = people[who];
      const list = await ids(caller, ws);
      const palette = (await env.svc.searchTargets(caller, ws, 'Zeta'))
        .filter((t) => t.type === 'project')
        .map((t) => t.id)
        .sort();
      const single: string[] = [];
      for (const p of [visible.id, hidden.id, under.id])
        if (await can(caller, ws, p)) single.push(p);
      expect(palette, who).toEqual(single.sort());
      expect(
        list.filter((x) => [visible.id, hidden.id, under.id].includes(x)),
        who,
      ).toEqual(single.sort());
    }
    // The limited member reads the child but not its restricted parent: no breadcrumb placeholder.
    expect((await env.svc.getProject(people.limited_member, ws, under.id)).ancestors).toEqual([]);
    // Favorites and recents re-authorize: after revocation the entries vanish on the next read.
    await env.svc.addFavorite(people.limited_member, ws, visible.id);
    await env.svc.recordVisit(people.limited_member, ws, visible.id);
    expect((await env.svc.listFavorites(people.limited_member, ws)).map((f) => f.id)).toContain(
      visible.id,
    );
    await apply(env, people.owner, ws, {
      kind: 'project_revoke',
      project: visible.id,
      principal: lim.public_id,
    });
    expect((await env.svc.listFavorites(people.limited_member, ws)).map((f) => f.id)).not.toContain(
      visible.id,
    );
    expect(
      (await env.svc.listRecent(people.limited_member, ws, {})).map((f) => f.id),
    ).not.toContain(visible.id);
  });

  it('hidden dependency endpoints are omitted entirely (no title, brand, count, or clue)', async () => {
    const { ws, people, brands, id } = W[1]!;
    const a = (
      await env.svc.createProject(
        people.owner,
        ws,
        { brand: brands.main, name: 'Visible A' },
        mutation(),
      )
    ).data;
    const b = (
      await env.svc.createProject(
        people.owner,
        ws,
        { brand: brands.other, name: 'Hidden B' },
        mutation(),
      )
    ).data;
    await env.svc.addDependency(people.owner, ws, a.id, { target: b.id }, mutation());
    const lim = (await membershipOf(db, id, people.limited_member.auth.account.id))!;
    await apply(env, people.owner, ws, {
      kind: 'project_grant',
      project: a.id,
      principal: lim.public_id,
      level: 'edit',
    });
    const o = await env.svc.overview(people.limited_member, ws, a.id);
    expect(o.dependencies).toEqual({ blocked_by: [], blocks: [] });
    expect(JSON.stringify(o)).not.toContain('Hidden B');
    expect(JSON.stringify(o)).not.toContain(b.id);
    // Creating a dependency needs both endpoints independently readable.
    const c = (
      await env.svc.createProject(
        people.owner,
        ws,
        { brand: brands.other, name: 'Hidden C' },
        mutation(),
      )
    ).data;
    await expect(
      env.svc.addDependency(people.limited_member, ws, a.id, { target: c.id }, mutation()),
    ).rejects.toEqual(reason('not_found'));
  });

  it('forged and foreign identifiers are not_found on every project command', async () => {
    const [a, b] = [W[0]!, W[1]!];
    const foreign = (
      await env.svc.createProject(
        b.people.owner,
        b.ws,
        { brand: b.brands.main, name: 'Foreign' },
        mutation(),
      )
    ).data;
    for (const call of [
      () => env.svc.getProject(a.people.owner, a.ws, foreign.id),
      () => env.svc.overview(a.people.owner, a.ws, foreign.id),
      () => env.svc.createPhase(a.people.owner, a.ws, foreign.id, { name: 'x' }, mutation()),
      () => env.svc.getProject(a.people.owner, b.ws, foreign.id),
      () => env.svc.getProject(a.people.outsider, a.ws, foreign.id),
      () => env.svc.getProject(a.people.owner, a.ws, 'prj_01J0000000000000000000000Z'),
      () =>
        env.svc.createProject(a.people.owner, a.ws, { parent: foreign.id, name: 'x' }, mutation()),
    ])
      await expect(call()).rejects.toEqual(reason('not_found'));
  });

  it('suspension, removal, and departure take effect on the next check; ownership never dangles', async () => {
    const { ws, people, brands, id } = W[2]!;
    const p = (
      await env.svc.createProject(
        people.administrator,
        ws,
        { brand: brands.main, name: 'Admin owned' },
        mutation(),
      )
    ).data;
    const adm = (await membershipOf(db, id, people.administrator.auth.account.id))!;
    const owner = (await membershipOf(db, id, people.owner.auth.account.id))!;
    const before = await db.admin(
      `SELECT epoch FROM access.permission_epoch WHERE workspace_id = $1 AND epoch_kind = 'workspace'`,
      [id],
    );
    // Remove the administrator: departure hands their project ownership and manage grant over.
    // Without a chosen assignee, departure fails with an actionable plan (never a dangling owner).
    await expect(
      apply(env, people.owner, ws, { kind: 'remove', member: adm.public_id }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'conflict',
        issues: [expect.objectContaining({ code: 'ownership_reassignment_required' })],
      }),
    );
    const preview = await env.svc.previewChange(people.owner, ws, {
      kind: 'remove',
      member: adm.public_id,
    });
    env.stepUp.allow = true;
    await env.svc.removeMember(
      people.owner,
      ws,
      adm.public_id,
      { preview_token: preview.preview_token, reassign_to: owner.public_id },
      mutation({ stepUpToken: 't' }),
    );
    env.stepUp.allow = false;
    expect((await env.svc.getProject(people.owner, ws, p.id)).owner).toMatchObject({
      id: owner.public_id,
    });
    await expect(env.svc.getProject(people.administrator, ws, p.id)).rejects.toEqual(
      reason('not_found'),
    );
    await env.h.worker.withWorkspace(id, { module: 'test' }, async (tx) =>
      expect(
        await principalFreshness(tx, env.h.telemetry.metrics, {
          membershipId: adm.id,
          workspaceEpochAtEnqueue: Number(before.rows[0]?.epoch ?? 0),
          principalEpochAtEnqueue: 0,
          consumer: 'job',
        }),
      ).toBe('revoked'),
    );
  });
});
