import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPublicId } from '@pm/contracts';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
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
type Who = 'owner' | (typeof ROLES)[number];

/**
 * Phase 2B task authority (0C AZ-22) across three workspaces, all six roles, a guest, sensitive
 * brands, restricted and inherited projects, projectless tasks, exact task shares, and access
 * changes. Every surface agrees with single-record enforcement; responsibility never grants.
 */
describe('task authority and sharing (2B)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  const W: Array<{
    ws: string;
    id: string;
    people: Record<Who, Caller>;
    brands: Record<string, string>;
  }> = [];

  const can = async (who: Caller, ws: string, tsk: string) =>
    env.svc.getTask(who, ws, tsk).then(
      () => true,
      (e) => {
        expect(e).toEqual(reason('not_found'));
        return false;
      },
    );
  const listed = async (who: Caller, ws: string) =>
    (await env.svc.listTasks(who, ws, { limit: '200' })).data.map((t) => t.id).sort();

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    for (const k of ['a', 'b', 'c']) {
      const o = await seedAccount(db);
      const created = await env.svc.createWorkspace(
        o,
        { ...WORKSPACE_INPUT, name: `T ${k}`, first_brand: { name: `Main ${k}` } },
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
      W.push({ ws, id: await workspaceIdOf(db, ws), people, brands });
    }
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('projectless tasks follow the brand; project tasks follow the project chain; sensitive brands need grants', async () => {
    const { ws, people, brands, id } = W[0]!;
    const o = people.owner;
    const free = (
      await env.svc.createTask(o, ws, { brand: brands.main, title: 'Free' }, mutation())
    ).data;
    const prj = (
      await env.svc.createProject(
        o,
        ws,
        { brand: brands.main, name: 'Restricted home' },
        mutation(),
      )
    ).data;
    const inR = (
      await env.svc.createTask(o, ws, { project: prj.id, title: 'In restricted' }, mutation())
    ).data;
    const subR = (
      await env.svc.createTask(o, ws, { parent: inR.id, title: 'Sub restricted' }, mutation())
    ).data;
    const secret = (
      await env.svc.createTask(o, ws, { brand: brands.secret, title: 'Secret' }, mutation())
    ).data;
    await env.svc.setAccess(o, ws, prj.id, { access_mode: 'restricted' }, mutation());
    const lim = (await membershipOf(db, id, people.limited_member.auth.account.id))!;
    for (const who of [
      'owner',
      'administrator',
      'member',
      'read_only',
      'limited_member',
    ] as const) {
      const c = people[who];
      const reads = {
        free: await can(c, ws, free.id),
        inR: await can(c, ws, inR.id),
        subR: await can(c, ws, subR.id),
        secret: await can(c, ws, secret.id),
      };
      // No owner/admin bypass: restricted projects and sensitive brands need explicit grants. The
      // owner holds them as the project's responsible manager and the sensitivity creator (AZ-21).
      const mine = who === 'owner';
      expect(reads, who).toEqual({
        free: who === 'owner' || who === 'administrator',
        inR: mine,
        subR: mine,
        secret: mine,
      });
      // The list agrees with single-record checks before pagination and counts.
      const l = await listed(c, ws);
      const expected = Object.entries({
        free: free.id,
        inR: inR.id,
        subR: subR.id,
        secret: secret.id,
      })
        .filter(([k]) => reads[k as keyof typeof reads])
        .map(([, x]) => x)
        .sort();
      expect(
        [free.id, inR.id, subR.id, secret.id].filter((x) => l.includes(x)).sort(),
        who,
      ).toEqual(expected);
    }
    // An explicit project grant reaches the project's tasks and subtasks (until a restriction).
    await apply(env, o, ws, {
      kind: 'project_grant',
      project: prj.id,
      principal: lim.public_id,
      level: 'edit',
    });
    expect(await can(people.limited_member, ws, subR.id)).toBe(true);
    expect(
      (await env.svc.getTask(people.limited_member, ws, subR.id)).ancestors.map((a) => a.id),
    ).toEqual([inR.id]);
    // Revocation takes effect on the next check, everywhere.
    await env.svc.addFavorite(people.limited_member, ws, inR.id);
    await env.svc.recordVisit(people.limited_member, ws, inR.id);
    await apply(env, o, ws, { kind: 'project_revoke', project: prj.id, principal: lim.public_id });
    expect(await can(people.limited_member, ws, subR.id)).toBe(false);
    expect((await env.svc.listFavorites(people.limited_member, ws)).map((f) => f.id)).not.toContain(
      inR.id,
    );
    expect(
      (await env.svc.listRecent(people.limited_member, ws, {})).map((f) => f.id),
    ).not.toContain(inR.id);
  });

  it('palette, favorites, recents, and lists agree with single-record enforcement for every role', async () => {
    const { ws, people, brands } = W[1]!;
    const o = people.owner;
    const prj = (
      await env.svc.createProject(o, ws, { brand: brands.main, name: 'Quasar home' }, mutation())
    ).data;
    const shown = (
      await env.svc.createTask(o, ws, { brand: brands.main, title: 'Quasar shown' }, mutation())
    ).data;
    const hidden = (
      await env.svc.createTask(o, ws, { project: prj.id, title: 'Quasar hidden' }, mutation())
    ).data;
    await env.svc.setAccess(o, ws, prj.id, { access_mode: 'restricted' }, mutation());
    for (const who of [
      'owner',
      'administrator',
      'member',
      'limited_member',
      'read_only',
    ] as const) {
      const c = people[who];
      const palette = (await env.svc.searchTargets(c, ws, 'Quasar'))
        .filter((t) => t.type === 'task')
        .map((t) => t.id)
        .sort();
      const single: string[] = [];
      for (const t of [shown.id, hidden.id]) if (await can(c, ws, t)) single.push(t);
      expect(palette, who).toEqual(single.sort());
    }
    // A favorite of a task the person cannot read is refused like an unknown one.
    await expect(env.svc.addFavorite(people.member, ws, hidden.id)).rejects.toEqual(
      reason('not_found'),
    );
  });

  it('share-only boundary: the task, its checklist and own criteria; nothing else; no onward sharing', async () => {
    const { ws, people, brands, id } = W[2]!;
    const o = people.owner;
    const prj = (
      await env.svc.createProject(o, ws, { brand: brands.main, name: 'Private' }, mutation())
    ).data;
    await env.svc.addItem(
      o,
      ws,
      prj.id,
      'criteria',
      { kind: 'definition_of_done', text: 'Hidden DoD' },
      mutation(),
    );
    const parent = (
      await env.svc.createTask(o, ws, { project: prj.id, title: 'Hidden parent' }, mutation())
    ).data;
    const t = (
      await env.svc.createTask(o, ws, { parent: parent.id, title: 'Shared task' }, mutation())
    ).data;
    const child = (
      await env.svc.createTask(o, ws, { parent: t.id, title: 'Hidden child' }, mutation())
    ).data;
    const other = (
      await env.svc.createTask(o, ws, { project: prj.id, title: 'Hidden blocker' }, mutation())
    ).data;
    await env.svc.addChecklistItem(o, ws, t.id, { text: 'Visible step' }, mutation());
    await env.svc.addTaskCriterion(o, ws, t.id, { text: 'Visible criterion' }, mutation());
    await env.svc.addRelationship(
      o,
      ws,
      t.id,
      { kind: 'blocked_by', target: other.id },
      mutation(),
    );
    await env.svc.addLink(o, ws, t.id, { url: 'https://example.com/private' }, mutation());
    const label = (
      await env.svc.createLabel(o, ws, brands.main, { name: 'Visible label' }, mutation())
    ).data;
    await env.svc.addTaskLabel(o, ws, t.id, { label: label.id }, mutation());
    const ownerMem = (await membershipOf(db, id, o.auth.account.id))!;
    await env.svc.setAssignees(
      o,
      ws,
      t.id,
      { assignees: [ownerMem.public_id], version: (await env.svc.getTask(o, ws, t.id)).version },
      mutation(),
    );
    await env.svc.setAccess(
      o,
      ws,
      prj.id,
      { access_mode: 'restricted', allow_record_shares: true },
      mutation(),
    );
    const mem = (await membershipOf(db, id, people.member.auth.account.id))!;
    const reviewed = await apply(env, o, ws, {
      kind: 'record_share',
      record: t.id,
      grantee: mem.public_id,
      level: 'edit',
    });
    // Preview equals enforcement: exactly one task, nothing contained.
    expect(reviewed.preview.diff.records_gained).toEqual({ task: 1 });
    const guest = await join(env, db, o, ws, {
      kind: 'guest',
      records: [{ record: t.id, level: 'comment' }],
    });
    for (const who of [people.member, guest]) {
      const d = await env.svc.taskDetail(who, ws, t.id);
      expect(d.task).toMatchObject({
        title: 'Shared task',
        project: null,
        parent: null,
        ancestors: [],
        assignees: [],
        progress: null,
        shared_only: true,
        brand: { id: brands.main },
      });
      expect(d.task.labels).toEqual([{ name: 'Visible label', color: expect.any(String) }]);
      expect(d.checklist.map((c) => c.text)).toEqual(['Visible step']);
      expect(d.criteria.map((c) => c.text)).toEqual(['Visible criterion']);
      expect(d).toMatchObject({
        inherited_criteria: [],
        subtasks: [],
        links: [],
        relationships: { blocks: [], blocked_by: [], related: [] },
      });
      expect(JSON.stringify(d)).not.toMatch(/Hidden|private|lbl_/);
      expect(d.task.capabilities).toMatchObject({
        edit_context: false,
        complete: false,
        move: false,
        relate: false,
        share: false,
        history: false,
      });
      const nf = reason('not_found');
      for (const target of [parent.id, child.id, other.id])
        expect(await can(who, ws, target)).toBe(false);
      await expect(env.svc.taskHistory(who, ws, t.id)).rejects.toEqual(nf);
      await expect(env.svc.listTasks(who, ws, { parent: t.id })).rejects.toEqual(nf);
      await expect(
        env.svc.addRelationship(who, ws, t.id, { kind: 'related', target: other.id }, mutation()),
      ).rejects.toEqual(nf);
      await expect(
        env.svc.addLink(who, ws, t.id, { url: 'https://example.com' }, mutation()),
      ).rejects.toEqual(nf);
      await expect(
        env.svc.addTaskLabel(who, ws, t.id, { label: label.id }, mutation()),
      ).rejects.toEqual(nf);
      await expect(
        env.svc.setAssignees(who, ws, t.id, { assignees: [], version: d.task.version }, mutation()),
      ).rejects.toEqual(nf);
      await expect(
        env.svc.createTask(who, ws, { parent: t.id, title: 'x' }, mutation()),
      ).rejects.toEqual(nf);
      // Actions on the shared task itself that the share excludes are a safe refusal.
      await expect(env.svc.completeTask(who, ws, t.id, {}, mutation())).rejects.toEqual(
        reason('forbidden'),
      );
      await expect(env.svc.moveTask(who, ws, t.id, { parent: null }, mutation())).rejects.toEqual(
        reason('forbidden'),
      );
      await expect(env.svc.duplicateTask(who, ws, t.id, {}, mutation())).rejects.toEqual(
        reason('forbidden'),
      );
      await expect(env.svc.taskLifecycle(who, ws, t.id, 'archive', {}, mutation())).rejects.toEqual(
        reason('forbidden'),
      );
      // No onward sharing (AT-050).
      await expect(
        env.svc.createShare(who, ws, { record: t.id, grantee: brands.other }, mutation()),
      ).rejects.toEqual(reason('forbidden'));
    }
    // The edit share edits the task's own fields and facts.
    const cur = await env.svc.getTask(people.member, ws, t.id);
    await env.svc.updateTask(
      people.member,
      ws,
      t.id,
      { version: cur.version, changes: { priority: { base: 'none', value: 'high' } } },
      mutation({ ifMatch: `"${cur.version}"` }),
    );
    await env.svc.addChecklistItem(
      people.member,
      ws,
      t.id,
      { text: 'Added via share' },
      mutation(),
    );
    // Project rollups never count tasks the viewer reads only through a share.
    await expect(env.svc.getProject(people.member, ws, prj.id)).rejects.toEqual(
      reason('not_found'),
    );
  });

  it('hidden relationship endpoints, children, and counts disappear consistently (AT-119)', async () => {
    const { ws, people, brands, id } = W[0]!;
    const o = people.owner;
    const prj = (
      await env.svc.createProject(o, ws, { brand: brands.main, name: 'Counts' }, mutation())
    ).data;
    const seen = (
      await env.svc.createTask(o, ws, { project: prj.id, title: 'Seen parent' }, mutation())
    ).data;
    const visibleChild = (
      await env.svc.createTask(o, ws, { parent: seen.id, title: 'Visible child' }, mutation())
    ).data;
    const secretPrj = (
      await env.svc.createProject(o, ws, { brand: brands.main, name: 'Counts secret' }, mutation())
    ).data;
    const blocker = (
      await env.svc.createTask(
        o,
        ws,
        { project: secretPrj.id, title: 'Secret blocker' },
        mutation(),
      )
    ).data;
    await env.svc.addRelationship(
      o,
      ws,
      seen.id,
      { kind: 'blocked_by', target: blocker.id },
      mutation(),
    );
    await env.svc.addRelationship(
      o,
      ws,
      visibleChild.id,
      { kind: 'related', target: blocker.id },
      mutation(),
    );
    await env.svc.setAccess(o, ws, secretPrj.id, { access_mode: 'restricted' }, mutation());
    const viewer = people.member;
    const mem = (await membershipOf(db, id, viewer.auth.account.id))!;
    await apply(env, o, ws, {
      kind: 'brand_grant',
      brand: brands.main,
      principal: mem.public_id,
      level: 'view',
    });
    const d = await env.svc.taskDetail(viewer, ws, seen.id);
    expect(d.relationships).toEqual({ blocks: [], blocked_by: [], related: [] });
    expect(JSON.stringify(d)).not.toContain(blocker.id);
    // Project task facts count only readable tasks; the hidden blocker never marks "blocked".
    const ov = await env.svc.overview(viewer, ws, prj.id);
    expect(ov.task_facts).toMatchObject({ total: 2, blocked: 0 });
    const ownerOv = await env.svc.overview(o, ws, prj.id);
    expect(ownerOv.task_facts).toMatchObject({ total: 2, blocked: 1 });
    const page = await env.svc.listTasks(viewer, ws, { project: prj.id, parent: 'root' });
    expect(page.data.find((t) => t.id === seen.id)!.children).toBe(1);
  });

  it('forged, foreign, and malformed identifiers and cursors are not_found or cursor_invalid', async () => {
    const [a, b] = W;
    const foreign = (
      await env.svc.createTask(
        b!.people.owner,
        b!.ws,
        { brand: b!.brands.main, title: 'Foreign' },
        mutation(),
      )
    ).data;
    const o = a!.people.owner;
    for (const id of [foreign.id, newPublicId('tsk'), 'tsk_not-a-real-id', b!.brands.main])
      await expect(env.svc.getTask(o, a!.ws, id)).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.createTask(o, a!.ws, { brand: b!.brands.main, title: 'x' }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.createTask(o, a!.ws, { parent: foreign.id, title: 'x' }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.addRelationship(
        o,
        a!.ws,
        (await env.svc.createTask(o, a!.ws, { brand: a!.brands.main, title: 'mine' }, mutation()))
          .data.id,
        { kind: 'blocks', target: foreign.id },
        mutation(),
      ),
    ).rejects.toEqual(reason('not_found'));
    await expect(env.svc.listTasks(o, a!.ws, { cursor: 'eyJrIjoiIn0' })).rejects.toEqual(
      reason('cursor_invalid'),
    );
    // A cursor from one list cannot page another (bound to its filter).
    for (let i = 0; i < 3; i++)
      await env.svc.createTask(o, a!.ws, { brand: a!.brands.other, title: `p${i}` }, mutation());
    const first = await env.svc.listTasks(o, a!.ws, { limit: '1' });
    expect(first.page.next_cursor).toEqual(expect.any(String));
    await expect(
      env.svc.listTasks(o, a!.ws, { projectless: 'true', cursor: first.page.next_cursor }),
    ).rejects.toEqual(reason('cursor_invalid'));
    const second = await env.svc.listTasks(o, a!.ws, {
      limit: '1',
      cursor: first.page.next_cursor,
    });
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
    // The other workspace's owner never sees this workspace's tasks.
    await expect(env.svc.getTask(b!.people.owner, a!.ws, first.data[0]!.id)).rejects.toEqual(
      reason('not_found'),
    );
  });

  it('read-only and limited members cannot write; guests cannot be assigned or create', async () => {
    const { ws, people, brands, id } = W[1]!;
    const t = (
      await env.svc.createTask(people.owner, ws, { brand: brands.main, title: 'Roles' }, mutation())
    ).data;
    for (const who of ['read_only', 'limited_member'] as const) {
      const m = (await membershipOf(db, id, people[who].auth.account.id))!;
      await apply(env, people.owner, ws, {
        kind: 'brand_grant',
        brand: brands.main,
        principal: m.public_id,
        level: 'view',
      });
    }
    await expect(
      env.svc.updateTask(
        people.read_only,
        ws,
        t.id,
        { version: t.version, changes: { priority: { base: 'none', value: 'low' } } },
        mutation({ ifMatch: `"${t.version}"` }),
      ),
    ).rejects.toEqual(reason('forbidden'));
    await expect(
      env.svc.createTask(people.read_only, ws, { brand: brands.main, title: 'x' }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    await expect(
      env.svc.createLabel(people.limited_member, ws, brands.main, { name: 'x' }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    await expect(env.svc.completeTask(people.read_only, ws, t.id, {}, mutation())).rejects.toEqual(
      reason('forbidden'),
    );
    // Assigning a member who cannot read the task is allowed but grants nothing (AT-117).
    const elsewhere = (
      await env.svc.createTask(
        people.owner,
        ws,
        { brand: brands.other, title: 'Elsewhere' },
        mutation(),
      )
    ).data;
    const lim = (await membershipOf(db, id, people.limited_member.auth.account.id))!;
    await env.svc.setAssignees(
      people.owner,
      ws,
      elsewhere.id,
      { assignees: [lim.public_id], version: elsewhere.version },
      mutation(),
    );
    expect(await can(people.limited_member, ws, elsewhere.id)).toBe(false);
  });
});
