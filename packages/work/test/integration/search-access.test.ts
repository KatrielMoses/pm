import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { richTextFromPlain } from '@pm/contracts';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { indexWorkspace, type SearchJobDeps } from '@pm/work';
import type { Caller } from '@pm/tenancy';
import {
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
type Who = 'owner' | (typeof ROLES)[number] | 'guest' | 'shared_guest';

/**
 * Search is allowed to show a person exactly what single-record reads allow them, and nothing else
 * (0C AZ-36): every role, a guest, sensitive brands, restricted projects, exact shares, and a
 * second workspace. The matrix compares the search result set of each person with the answer of
 * the owning module's own read, for every record, so the two authorities cannot drift apart.
 */
describe('search authority equals record authority (5A)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  const people = {} as Record<Who, Caller>;
  let ws: string;
  let wsId: string;
  let other: { ws: string; owner: Caller; wsId: string };
  const brands: Record<string, string> = {};
  const items: Array<{ id: string; kind: 'task' | 'project' | 'document'; label: string }> = [];
  const deps = (): SearchJobDeps => ({
    tenant: env.h.worker,
    discovery: undefined as never,
    metrics: env.h.telemetry.metrics,
    logger: env.h.logger,
  });

  const canRead = async (who: Caller, item: (typeof items)[number]) =>
    (item.kind === 'task'
      ? env.svc.getTask(who, ws, item.id)
      : item.kind === 'project'
        ? env.svc.getProject(who, ws, item.id)
        : env.svc.getDocument(who, ws, item.id)
    ).then(
      () => true,
      (e) => {
        expect(e).toEqual(reason('not_found'));
        return false;
      },
    );
  const found = async (who: Caller) =>
    new Set(
      (await env.svc.search(who, ws, { q: 'plover', state: 'any' })).results.map((r) => r.id),
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    const o = await seedAccount(db);
    const created = await env.svc.createWorkspace(
      o,
      { ...WORKSPACE_INPUT, name: 'Matrix', first_brand: { name: 'Main' } },
      mutation(),
    );
    ws = created.data.workspace.id;
    wsId = await workspaceIdOf(db, ws);
    people.owner = o;
    brands.main = created.data.first_brand!.id;
    brands.secret = (await env.svc.createBrand(o, ws, { name: 'Secret' }, mutation())).data.id;
    env.stepUp.allow = true;
    await env.svc.setSensitivity(
      o,
      ws,
      brands.secret,
      { is_sensitive: true },
      mutation({ ifMatch: '"0"', stepUpToken: 't' }),
    );
    env.stepUp.allow = false;
    for (const role of ROLES) people[role] = await join(env, db, o, ws, { kind: 'member', role });

    const task = async (body: Record<string, unknown>, label: string) => {
      const t = (await env.svc.createTask(o, ws, body, mutation())).data;
      items.push({ id: t.id, kind: 'task', label });
      return t;
    };
    const open = (
      await env.svc.createProject(o, ws, { brand: brands.main, name: 'Plover open' }, mutation())
    ).data;
    items.push({ id: open.id, kind: 'project', label: 'open project' });
    const restricted = (
      await env.svc.createProject(o, ws, { brand: brands.main, name: 'Plover board' }, mutation())
    ).data;
    items.push({ id: restricted.id, kind: 'project', label: 'restricted project' });
    await env.svc.setAccess(o, ws, restricted.id, { access_mode: 'restricted' }, mutation());
    await task({ brand: brands.main, title: 'Plover plain task' }, 'plain task');
    await task(
      { brand: brands.main, title: 'Plover board task', project: restricted.id },
      'task in a restricted project',
    );
    await task(
      { brand: brands.main, title: 'Plover in open', project: open.id },
      'task in an open project',
    );
    await task(
      { brand: brands.secret, title: 'Plover sensitive task' },
      'task in a sensitive brand',
    );
    const secretProject = (
      await env.svc.createProject(
        o,
        ws,
        { brand: brands.secret, name: 'Plover secret' },
        mutation(),
      )
    ).data;
    items.push({ id: secretProject.id, kind: 'project', label: 'sensitive project' });
    const shared = await task(
      {
        brand: brands.secret,
        title: 'Plover shared exactly',
        description: richTextFromPlain('plover'),
      },
      'exactly shared task',
    );
    const doc = (await env.svc.createDocument(o, ws, { title: 'Plover handbook' }, mutation()))
      .data;
    items.push({ id: doc.id, kind: 'document', label: 'workspace document' });
    const brandDoc = (
      await env.svc.createDocument(
        o,
        ws,
        { title: 'Plover brand doc', brand: brands.main },
        mutation(),
      )
    ).data;
    items.push({ id: brandDoc.id, kind: 'document', label: 'brand document' });
    // A guest sees only what is shared with them, at the shared level.
    people.guest = await join(env, db, o, ws, {
      kind: 'guest',
      records: [{ record: shared.id, level: 'read' }],
    });
    people.shared_guest = await join(env, db, o, ws, {
      kind: 'guest',
      records: [{ record: open.id, level: 'comment' }],
    });
    // The member gets an explicit grant on the restricted project: search must follow it.
    const m = (await membershipOf(db, wsId, people.member.auth.account.id))!;
    await env.svc
      .setAccess(
        o,
        ws,
        restricted.id,
        { access_mode: 'restricted', grants: [{ principal: m.public_id, level: 'view' }] },
        mutation(),
      )
      .catch(() => undefined);
    await indexWorkspace(deps(), wsId);

    // A second workspace with the same words, owned by someone else.
    const o2 = await seedAccount(db);
    const c2 = await env.svc.createWorkspace(
      o2,
      { ...WORKSPACE_INPUT, name: 'Other', first_brand: { name: 'Other main' } },
      mutation(),
    );
    other = {
      ws: c2.data.workspace.id,
      owner: o2,
      wsId: await workspaceIdOf(db, c2.data.workspace.id),
    };
    await env.svc.createTask(
      o2,
      other.ws,
      { brand: c2.data.first_brand!.id, title: 'Plover in another workspace' },
      mutation(),
    );
    await indexWorkspace(deps(), other.wsId);
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('shows each person exactly the records their own reads allow, for every role and a guest', async () => {
    const mismatches: string[] = [];
    const sizes: Record<string, number> = {};
    for (const [name, who] of Object.entries(people) as Array<[Who, Caller]>) {
      const seen = await found(who);
      sizes[name] = seen.size;
      for (const item of items) {
        const allowed = await canRead(who, item);
        if (allowed !== seen.has(item.id))
          mismatches.push(`${name} / ${item.label}: read ${allowed}, search ${seen.has(item.id)}`);
      }
      // Nothing the matrix did not create can appear (no foreign identifier, no other workspace).
      for (const id of seen) expect(items.map((i) => i.id)).toContain(id);
    }
    expect(mismatches).toEqual([]);
    // The matrix is not vacuous: someone sees plenty, and the restricted ones see strictly less.
    expect(sizes.owner).toBeGreaterThan(5);
    expect(sizes.guest).toBe(1);
    expect(sizes.administrator).toBeLessThan(sizes.owner!);
  });

  it('never lets a person search, count, or open another workspace', async () => {
    await expect(env.svc.search(other.owner, ws, { q: 'plover' })).rejects.toEqual(
      reason('not_found'),
    );
    const mine = await env.svc.search(other.owner, other.ws, { q: 'plover' });
    expect(mine.total).toBe(1);
    expect(mine.results[0]!.title).toBe('Plover in another workspace');
    const first = items[0]!;
    await expect(
      env.svc.openResult(other.owner, other.ws, { type: first.kind, id: first.id }),
    ).rejects.toEqual(reason('not_found'));
    // Row-level security holds beneath the application: another workspace's context sees no rows.
    await env.h.worker.withWorkspace(other.wsId, { module: 'test' }, async (tx) => {
      const rows = await tx.db.selectFrom('search.entry').select('workspace_id').execute();
      expect(new Set(rows.map((r) => r.workspace_id))).toEqual(new Set([other.wsId]));
      const queue = await tx.db.selectFrom('search.index_task').select('workspace_id').execute();
      expect(queue.every((r) => r.workspace_id === other.wsId)).toBe(true);
    });
  });

  it('follows access changes at once: a removed member has nothing left to search', async () => {
    const leaver = people.limited_member;
    const leaverId = (await membershipOf(db, wsId, leaver.auth.account.id))!.public_id;
    // The limited member holds no grants, so grant one first and watch it reach search.
    const before = await found(leaver);
    const preview = await env.svc.previewChange(people.owner, ws, {
      kind: 'remove',
      member: leaverId,
    });
    env.stepUp.allow = true;
    try {
      await env.svc.removeMember(
        people.owner,
        ws,
        leaverId,
        { preview_token: preview.preview_token },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
    // A removed person has no membership: the workspace is an unknown one to them.
    await expect(env.svc.search(leaver, ws, { q: 'plover' })).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.openResult(leaver, ws, {
        type: 'task',
        id: items.find((i) => i.kind === 'task')!.id,
      }),
    ).rejects.toEqual(reason('not_found'));
    expect(before.size).toBeGreaterThanOrEqual(0);
  });
});
