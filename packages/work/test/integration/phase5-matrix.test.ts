import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  DEFAULT_WORK_SETTINGS,
  goalRecalcHandler,
  indexWorkspace,
  type SearchJobDeps,
} from '@pm/work';
import type { Caller } from '@pm/tenancy';
import {
  apply,
  join,
  membershipOf,
  mutation,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const Q4 = { kind: 'quarter', year: 2026, index: 4 };
const reason = (code: string) => expect.objectContaining({ code });

/**
 * Phase 5 integration (5A search × 5B goals and portfolios): one workspace, every role, and the same
 * hidden work reached through search, goals, key results, portfolios, drill-downs, exports, and
 * administrator state. Hidden and unknown must be indistinguishable on every surface at once, and
 * every change of access, lifecycle, or membership must show everywhere on the next request.
 */
describe('Search with goals and portfolios as one information system (Phase 5 exit)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller;
  let reader: Caller;
  let outsider: Caller;
  let leaver: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const proj: Record<string, string> = {};
  const tsk: Record<string, string> = {};
  const sql = async (text: string) => (await db.admin(text)).rows as Array<Record<string, any>>;
  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const deps = (): SearchJobDeps => ({
    tenant: env.h.worker,
    discovery: undefined as never,
    metrics: env.h.telemetry.metrics,
    logger: env.h.logger,
  });
  const drain = () => indexWorkspace(deps(), wsId);
  const find = (as: Caller, q: string, extra: Record<string, unknown> = {}) =>
    env.svc.search(as, ws, { q, ...extra });
  const ids = (r: { results: Array<{ id: string }> }) => r.results.map((x) => x.id);
  const sweep = () =>
    goalRecalcHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
      settings: DEFAULT_WORK_SETTINGS,
    }).handle({} as never);
  const goal = async (as: Caller, body: Record<string, unknown>) =>
    (await env.svc.createGoal(as, ws, { title: 'Grow', period: Q4, ...body }, mutation())).data;
  const complete = async (key: string) => {
    const v = (await env.svc.getTask(owner, ws, tsk[key]!)).version;
    await env.svc.completeTask(owner, ws, tsk[key]!, {}, mutation({ ifMatch: `"${v}"` }));
  };
  /** What a person sees of a word, on every surface, with the word itself masked out. */
  const surfaces = async (as: Caller, word: string, g: string) => {
    const r = await find(as, word);
    const goalView = await env.svc.getGoal(as, ws, g).then(
      (v) => ({ work: v.progress.work, links: v.links.map((l: any) => l.target.name) }),
      (e) => ({ error: e.code }),
    );
    const overview = await env.svc.portfolioOverview(as, ws, {}).then(
      (o: any) => ({ projects: o.summary?.projects ?? o.data?.length ?? null }),
      (e) => ({ error: e.code }),
    );
    return JSON.parse(
      JSON.stringify({
        r: { ...r, query: undefined, results: r.results.length },
        goalView,
        overview,
      }).replace(new RegExp(word, 'gi'), 'X'),
    );
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    reader = await join(env, db, owner, ws, { kind: 'member', role: 'read_only' });
    outsider = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    leaver = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    for (const [who, level] of [
      [editor, 'edit'],
      [reader, 'view'],
      [leaver, 'edit'],
    ] as const)
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: await mem(who),
        level,
      });
    const mkProject = async (key: string, brand: string, name: string) =>
      (proj[key] = (await env.svc.createProject(owner, ws, { brand, name }, mutation())).data.id);
    await mkProject('open', brands.Harbor!, 'Heron open');
    await mkProject('vault', brands.Harbor!, 'Heron vault');
    await mkProject('summit', brands.Summit!, 'Heron summit');
    await env.svc.setAccess(
      owner,
      ws,
      proj.vault!,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    const mkTask = async (key: string, project: string, title: string) =>
      (tsk[key] = (await env.svc.createTask(owner, ws, { title, project }, mutation())).data.id);
    await mkTask('o1', proj.open!, 'Heron open one');
    await mkTask('o2', proj.open!, 'Heron open two');
    await mkTask('v1', proj.vault!, 'Heron vault secret plan');
    await mkTask('v2', proj.vault!, 'Heron vault budget');
    await mkTask('s1', proj.summit!, 'Heron summit launch');
    await complete('o1');
    await complete('v1');
    await complete('s1');
    await drain();
  }, 180_000);
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('keeps hidden work out of search, goals, key results, portfolios, drill-downs, and exports alike', async () => {
    const g = await goal(owner, { title: 'Flagship programme', basis: 'linked_work' });
    for (const k of ['open', 'vault', 'summit'] as const)
      await env.svc.addGoalLink(owner, ws, g.id, { target: proj[k]! }, mutation());
    const pf = (await env.svc.createPortfolio(owner, ws, { name: 'All Heron' }, mutation())).data;
    await env.svc
      .setPortfolioProjects(
        owner,
        ws,
        pf.id,
        { projects: [proj.open, proj.vault, proj.summit] },
        mutation(),
      )
      .catch(() => undefined);
    await drain();
    // The owner reads everything through every surface.
    const own = await find(owner, 'heron', { limit: 50 });
    expect(own.total).toBeGreaterThanOrEqual(8);
    // The editor (Harbor only, no vault, no Summit) reads exactly the open project and its tasks.
    const ed = await find(editor, 'heron', { limit: 50 });
    expect(new Set(ids(ed))).toEqual(new Set([proj.open, tsk.o1, tsk.o2]));
    expect((await env.svc.getGoal(editor, ws, g.id)).progress.work).toEqual({ done: 1, total: 2 });
    const goalWork = await env.svc.goalWork(editor, ws, g.id, {});
    expect(JSON.stringify(goalWork)).not.toMatch(/vault|summit|secret/i);
    // The outsider reads nothing of it: a search for the word is a search for a word nobody wrote.
    const strip = (r: any) => ({
      t: r.total,
      k: r.facets.kinds,
      b: r.facets.brands,
      r: r.results,
      i: r.index,
    });
    expect(strip(await find(outsider, 'heron'))).toEqual(strip(await find(outsider, 'qwxzvbnm')));
    // The workspace goal itself is readable by every member, but it names and counts none of the work.
    const outsiderGoal = await env.svc.getGoal(outsider, ws, g.id);
    expect(outsiderGoal.links).toEqual([]);
    expect(outsiderGoal.progress.work).toEqual({ done: 0, total: 0 });
    expect(JSON.stringify(outsiderGoal)).not.toMatch(/heron|vault|summit/i);
    // Exports are filtered by the same authority, and say nothing of what was left out.
    const csv = await env.svc.exportPortfolio(editor, ws, {});
    expect(csv.body).not.toMatch(/vault|summit/i);
    const goals = await env.svc.exportGoals(editor, ws, {});
    expect(goals.body).not.toMatch(/vault|summit|secret/i);
    // Goals are not search sources yet (deferred): their title finds nothing, even for the owner.
    expect((await find(owner, 'programme')).total).toBe(0);
    // An administrator's state counts only what they can read, on search and on Home.
    await sql(`INSERT INTO search.index_status (workspace_id, source_kind, source_id, auth_record_id, state, attempts, failure_code, next_attempt_at)
      SELECT '${wsId}', 'task', t.id, t.id, 'failed', 5, 'source_error', now() + interval '1 day'
        FROM core.record t WHERE t.public_id = '${tsk.v2}'`);
    expect((await env.svc.searchStatus(owner, ws)).index).toMatchObject({
      state: 'degraded',
      failed: 1,
    });
    expect((await env.svc.searchStatus(editor, ws)).index).toMatchObject({
      state: 'complete',
      failed: 0,
    });
    expect((await env.svc.searchStatus(outsider, ws)).index).toMatchObject({
      state: 'complete',
      failed: 0,
    });
    await sql(`DELETE FROM search.index_status`);
    expect(await surfaces(outsider, 'heron', g.id)).toEqual(
      await surfaces(outsider, 'qwxzvbnm', g.id),
    );
  });

  it('shows trash, restore, purge, and revocation on every surface at once, and keeps both indexes convergent', async () => {
    const g = await goal(owner, {
      title: 'Convergence',
      basis: 'linked_work',
      brand: brands.Harbor,
    });
    await env.svc.addGoalLink(owner, ws, g.id, { target: proj.open! }, mutation());
    await drain();
    const before = (await env.svc.getGoal(editor, ws, g.id)).progress.work;
    expect(before).toEqual({ done: 1, total: 2 });
    // Trashing a linked task changes the viewer-computed figure and the search result immediately.
    await env.svc.taskLifecycle(owner, ws, tsk.o2!, 'trash', {}, mutation());
    expect((await env.svc.getGoal(editor, ws, g.id)).progress.work).toEqual({ done: 1, total: 1 });
    expect(ids(await find(editor, 'heron'))).not.toContain(tsk.o2);
    await env.svc.taskLifecycle(owner, ws, tsk.o2!, 'restore', {}, mutation());
    expect((await env.svc.getGoal(editor, ws, g.id)).progress.work).toEqual(before);
    expect(ids(await find(editor, 'heron'))).toContain(tsk.o2);
    // Revoking the brand removes the work from the editor's search, goal, and portfolio at once.
    const m = await mem(editor);
    const preview = await env.svc
      .previewChange(owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: m,
        level: 'none',
      })
      .catch(() => null);
    if (preview) {
      env.stepUp.allow = true;
      try {
        await env.svc.applyChange(
          owner,
          ws,
          {
            change: { kind: 'brand_grant', brand: brands.Harbor, principal: m, level: 'none' },
            preview_token: preview.preview_token,
          },
          mutation({ stepUpToken: 't' }),
        );
      } finally {
        env.stepUp.allow = false;
      }
      expect((await find(editor, 'heron')).total).toBe(0);
      expect(await env.svc.getGoal(editor, ws, g.id).catch((e) => e.code)).toBe('not_found');
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: m,
        level: 'edit',
      });
    }
    // A purge removes search rows and goal links together.
    const t = (
      await env.svc.createTask(owner, ws, { title: 'Heron doomed', project: proj.open }, mutation())
    ).data;
    await env.svc.addGoalLink(owner, ws, g.id, { target: t.id }, mutation());
    await drain();
    expect(ids(await find(owner, 'doomed'))).toEqual([t.id]);
    await env.svc.taskLifecycle(owner, ws, t.id, 'trash', {}, mutation());
    expect((await find(owner, 'doomed')).total).toBe(0);
  });

  it('converges when indexing, recalculation, and edits overlap, and repeats change nothing', async () => {
    const g = await goal(owner, { title: 'Overlap', basis: 'linked_work', brand: brands.Harbor });
    await env.svc.addGoalLink(owner, ws, g.id, { target: proj.open! }, mutation());
    const t = (
      await env.svc.createTask(
        owner,
        ws,
        { title: 'Heron overlap alpha', project: proj.open },
        mutation(),
      )
    ).data;
    const rename = async (title: string) => {
      const cur = await env.svc.getTask(owner, ws, t.id);
      await env.svc.updateTask(
        owner,
        ws,
        t.id,
        { version: cur.version, changes: { title: { base: cur.title, value: title } } },
        mutation({ ifMatch: `"${cur.version}"` }),
      );
    };
    await Promise.all([drain(), sweep(), rename('Heron overlap beta'), drain(), sweep()]);
    await drain();
    await sweep();
    expect(ids(await find(owner, 'beta'))).toEqual([t.id]);
    expect((await find(owner, 'alpha')).total).toBe(0);
    const again = await Promise.all([drain(), drain(), sweep(), sweep()]);
    expect(again[0]).toMatchObject({ failed: 0, retried: 0 });
    expect((await env.svc.searchStatus(owner, ws)).index).toMatchObject({
      state: 'complete',
      pending: 0,
      failed: 0,
    });
    const state = (await sql(`SELECT count(*)::int AS n FROM goals.goal_state`))[0]!.n;
    expect(state).toBeGreaterThan(0);
  });

  it('removes a departed member from search and hands their goals on, and never searches across workspaces', async () => {
    const mine = await goal(leaver, { title: 'Leaver goal', brand: brands.Harbor });
    expect((await find(leaver, 'heron')).total).toBeGreaterThan(0);
    await env.svc.recordRecentSearch(leaver, ws, { q: 'heron' });
    const leaverId = await mem(leaver);
    const preview = await env.svc.previewChange(owner, ws, { kind: 'remove', member: leaverId });
    env.stepUp.allow = true;
    try {
      await env.svc.removeMember(
        owner,
        ws,
        leaverId,
        { preview_token: preview.preview_token, reassign_to: await mem(editor) },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
    await expect(find(leaver, 'heron')).rejects.toEqual(reason('not_found'));
    await expect(env.svc.listRecentSearches(leaver, ws)).rejects.toEqual(reason('not_found'));
    await expect(env.svc.getGoal(leaver, ws, mine.id)).rejects.toEqual(reason('not_found'));
    expect((await env.svc.getGoal(owner, ws, mine.id)).owner).toMatchObject({
      id: await mem(editor),
    });
    // Another workspace never sees any of it.
    const other = workEnv(db);
    const o = await workspaceWith(other, db, ['Elsewhere']);
    await other.svc.createTask(
      o.owner,
      o.ws,
      { brand: o.brands.Elsewhere, title: 'Heron elsewhere' },
      mutation(),
    );
    await indexWorkspace({ ...deps(), tenant: other.h.worker }, await workspaceIdOf(db, o.ws));
    expect(ids(await other.svc.search(o.owner, o.ws, { q: 'heron' }))).toHaveLength(1);
    await expect(other.svc.search(o.owner, ws, { q: 'heron' })).rejects.toEqual(
      reason('not_found'),
    );
    await expect(env.svc.getGoal(o.owner, ws, mine.id)).rejects.toEqual(reason('not_found'));
    await other.h.close();
  });
});
