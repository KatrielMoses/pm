import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { productLifecycleRegistry, purgeGoalTargets } from '@pm/work';
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

const ifMatch = (v: number) => mutation({ ifMatch: `"${v}"` });
const Q = { kind: 'year', year: 2026 };
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; issues?: Array<{ code: string; pointer: string }> };
  }
  throw new Error('expected a rejection');
};

/**
 * 5B portfolios and portfolio insight (ADR-0028): explainable health, dependencies, budgets,
 * deadlines, effort, and orphan findings, all computed for the viewer from authorized records only.
 */
describe('Portfolios and portfolio insight (5B)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller; // edit on Harbor
  let reader: Caller; // view on Harbor
  let outsider: Caller; // no brand access
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const pub: Record<string, string> = {};
  const prj: Record<string, string> = {};
  const tsk: Record<string, string> = {};
  const goalId: Record<string, string> = {};
  let boardId: string;
  let allId: string;

  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const sql = async (text: string) => (await db.admin(text)).rows as Array<Record<string, any>>;
  const project = async (key: string, brand: string, fields: Record<string, unknown>) => {
    const created = (
      await env.svc.createProject(owner, ws, { brand, name: key, ...fields }, mutation())
    ).data;
    prj[key] = created.id;
    return created;
  };
  const task = async (key: string, projectKey: string, fields: Record<string, unknown> = {}) =>
    (tsk[key] = (
      await env.svc.createTask(
        owner,
        ws,
        { title: key, project: prj[projectKey], ...fields },
        mutation(),
      )
    ).data.id);
  const finish = async (key: string) => {
    const v = (await env.svc.getTask(owner, ws, tsk[key]!)).version;
    await env.svc.completeTask(owner, ws, tsk[key]!, {}, mutation({ ifMatch: `"${v}"` }));
  };
  const activate = async (key: string) => {
    const p = await env.svc.getProject(owner, ws, prj[key]!);
    await env.svc.updateProject(
      owner,
      ws,
      prj[key]!,
      { version: p.version, changes: { status: { base: p.status.key, value: 'active' } } },
      mutation({ ifMatch: `"${p.version}"` }),
    );
  };
  const row = (r: { data: Array<{ name: string }> }, name: string) =>
    r.data.find((x) => x.name === name) as any;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    reader = await join(env, db, owner, ws, { kind: 'member', role: 'read_only' });
    outsider = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(editor),
      level: 'edit',
    });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(reader),
      level: 'view',
    });
    pub.owner = await mem(owner);
    pub.editor = await mem(editor);

    await project('Late', brands.Harbor!, {
      start_date: day(-60),
      deadline_date: day(-3),
      budget_amount: 1000,
      budget_currency: 'EUR',
    });
    await project('Fine', brands.Harbor!, {
      start_date: day(-10),
      target_date: day(50),
      budget_amount: 5000,
      budget_currency: 'USD',
      time_budget_minutes: 600,
    });
    await project('Slipping', brands.Harbor!, {
      start_date: day(-40),
      target_date: day(10),
      budget_amount: 2000,
      budget_currency: 'USD',
    });
    await project('Quiet', brands.Harbor!, {});
    await project('Vault', brands.Harbor!, { start_date: day(-10), target_date: day(30) });
    await project('Site', brands.Summit!, { start_date: day(-10), target_date: day(30) });
    await env.svc.setAccess(
      owner,
      ws,
      prj.Vault!,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    for (const k of ['Late', 'Fine', 'Slipping', 'Vault', 'Site']) await activate(k);

    for (const k of ['l1', 'l2', 'l3', 'l4']) await task(k, 'Late', { due_date: day(-8) });
    for (const k of ['f1', 'f2', 'f3', 'f4', 'f5'])
      await task(k, 'Fine', { due_date: day(40), estimate_minutes: 60 });
    for (const k of ['f6', 'f7']) await task(k, 'Fine', { due_date: day(40) });
    for (const k of ['s1', 's2', 's3', 's4', 's5']) await task(k, 'Slipping', { due_date: day(8) });
    await task('v1', 'Vault', { estimate_minutes: 500 });
    await task('v2', 'Vault');
    await task('u1', 'Site');
    await task('u2', 'Site');
    await finish('l1');
    for (const k of ['f1', 'f2']) await finish(k);
    for (const k of ['s1', 's2', 's3']) await finish(k);
    await finish('v1');

    // Time: 120 minutes on Fine (readable), 300 on the restricted Vault project.
    await env.svc.createEntry(
      owner,
      ws,
      { target: tsk.f3, work_date: day(-1), duration_minutes: 120 },
      mutation(),
    );
    await env.svc.createEntry(
      owner,
      ws,
      { target: tsk.v2, work_date: day(-1), duration_minutes: 300 },
      mutation(),
    );

    // Dependencies: f3 blocks s4 (readable), v2 blocks l2 and u1 blocks f4 (one end hidden from the editor).
    await env.svc.addRelationship(
      owner,
      ws,
      tsk.f3!,
      { kind: 'blocks', target: tsk.s4! },
      mutation(),
    );
    await env.svc.addRelationship(
      owner,
      ws,
      tsk.v2!,
      { kind: 'blocks', target: tsk.l2! },
      mutation(),
    );
    await env.svc.addRelationship(
      owner,
      ws,
      tsk.u1!,
      { kind: 'blocks', target: tsk.f4! },
      mutation(),
    );

    // Goals: G1 links Fine, G2 links Slipping's tasks, G3 has no links, G4 is cancelled and links Late.
    const g = async (key: string, body: Record<string, unknown>) =>
      (goalId[key] = (
        await env.svc.createGoal(owner, ws, { title: key, period: Q, ...body }, mutation())
      ).data.id);
    await g('G1', {});
    await g('G2', { brand: brands.Harbor });
    await g('G3', {});
    await g('G4', {});
    await env.svc.addGoalLink(owner, ws, goalId.G1!, { target: prj.Fine }, mutation());
    await env.svc.addGoalLink(owner, ws, goalId.G2!, { target: tsk.s5 }, mutation());
    await env.svc.addGoalLink(owner, ws, goalId.G4!, { target: prj.Late }, mutation());
    const g4 = await env.svc.getGoal(owner, ws, goalId.G4!);
    await env.svc.updateGoal(owner, ws, goalId.G4!, { status: 'cancelled' }, ifMatch(g4.version));
  }, 180_000);

  afterAll(async () => {
    await db.drop();
  });

  // -------------------------------------------------------------------------------------------
  describe('portfolio records', () => {
    it('creates, edits, and lists portfolios at workspace or brand level', async () => {
      const board = (
        await env.svc.createPortfolio(
          owner,
          ws,
          { name: 'Harbor board', brand: brands.Harbor, description: 'Everything Harbor' },
          mutation(),
        )
      ).data;
      boardId = board.id;
      expect(board).toMatchObject({
        type: 'portfolio',
        scope: { kind: 'brand', brand: { name: 'Harbor' } },
        projects_count: 0,
        version: 0,
      });
      allId = (await env.svc.createPortfolio(owner, ws, { name: 'All' }, mutation())).data.id;
      const renamed = await env.svc.updatePortfolio(
        owner,
        ws,
        boardId,
        { name: 'Harbor portfolio' },
        ifMatch(board.version),
      );
      expect(renamed.data).toMatchObject({ name: 'Harbor portfolio', version: 1 });
      expect(
        (await rejects(env.svc.updatePortfolio(owner, ws, boardId, { name: 'late' }, ifMatch(0))))
          .code,
      ).toBe('conflict');
      expect((await env.svc.listPortfolios(editor, ws, {})).data.map((p) => p.name).sort()).toEqual(
        ['All', 'Harbor portfolio'],
      );
      expect((await env.svc.listPortfolios(outsider, ws, {})).data.map((p) => p.name)).toEqual([
        'All',
      ]);
      expect((await rejects(env.svc.getPortfolio(outsider, ws, boardId))).code).toBe('not_found');
      expect(
        (
          await rejects(
            env.svc.createPortfolio(reader, ws, { name: 'x', brand: brands.Harbor }, mutation()),
          )
        ).code,
      ).toBe('forbidden');
    });

    it('names only readable projects, holds a brand portfolio to its brand, and keeps members the editor cannot read', async () => {
      const v = (await env.svc.getPortfolio(owner, ws, boardId)).version;
      const set = await env.svc.setPortfolioProjects(
        owner,
        ws,
        boardId,
        { projects: [prj.Late, prj.Fine, prj.Slipping, prj.Quiet], version: v },
        mutation(),
      );
      expect(set.data.projects_count).toBe(4);
      const cross = await rejects(
        env.svc.setPortfolioProjects(
          owner,
          ws,
          boardId,
          { projects: [prj.Site], version: set.data.version },
          mutation(),
        ),
      );
      expect(cross.issues?.[0]).toMatchObject({
        pointer: '/projects/0',
        code: 'invalid_reference',
      });
      // The owner also puts the restricted Vault project in the brand portfolio; the editor cannot read it.
      const withVault = await env.svc.setPortfolioProjects(
        owner,
        ws,
        boardId,
        {
          projects: [prj.Late, prj.Fine, prj.Slipping, prj.Quiet, prj.Vault],
          version: set.data.version,
        },
        mutation(),
      );
      expect(withVault.data.projects_count).toBe(5);
      const asEditor = await env.svc.getPortfolio(editor, ws, boardId);
      expect(asEditor.projects.sort()).toEqual(
        [prj.Late, prj.Fine, prj.Slipping, prj.Quiet].sort(),
      );
      expect(asEditor.projects_count).toBe(4);
      const hiddenTry = await rejects(
        env.svc.setPortfolioProjects(
          editor,
          ws,
          boardId,
          { projects: [prj.Fine, prj.Vault], version: asEditor.version },
          mutation(),
        ),
      );
      expect(hiddenTry.issues?.[0]).toMatchObject({
        pointer: '/projects/1',
        code: 'invalid_reference',
      });
      const replaced = await env.svc.setPortfolioProjects(
        editor,
        ws,
        boardId,
        { projects: [prj.Late, prj.Fine], version: asEditor.version },
        mutation(),
      );
      expect(replaced.data.projects.sort()).toEqual([prj.Late, prj.Fine].sort());
      // The member the editor could not read is still there for the owner.
      expect((await env.svc.getPortfolio(owner, ws, boardId)).projects.sort()).toEqual(
        [prj.Late, prj.Fine, prj.Vault].sort(),
      );
      // A workspace portfolio spans brands, and only a member with workspace-level edit may change it.
      const owners = await env.svc.setPortfolioProjects(
        owner,
        ws,
        allId,
        { projects: [prj.Fine, prj.Site, prj.Vault, prj.Slipping], version: 0 },
        mutation(),
      );
      expect(owners.data.projects_count).toBe(4);
      expect(
        (
          await rejects(
            env.svc.setPortfolioProjects(
              editor,
              ws,
              allId,
              { projects: [prj.Fine], version: owners.data.version },
              mutation(),
            ),
          )
        ).code,
      ).toBe('forbidden');
      // Back to the four visible projects (the owner's set replaces the members they can read).
      await env.svc.setPortfolioProjects(
        owner,
        ws,
        boardId,
        {
          projects: [prj.Late, prj.Fine, prj.Slipping, prj.Quiet],
          version: (await env.svc.getPortfolio(owner, ws, boardId)).version,
        },
        mutation(),
      );
    });

    it('bounds portfolios and their projects, and archives, trashes, and restores', async () => {
      const small = workEnv(db, { work: { portfoliosMax: 1, portfolioProjectsMax: 10 } });
      const ctx = await workspaceWith(small, db, ['B']);
      const one = (await small.svc.createPortfolio(ctx.owner, ctx.ws, { name: 'one' }, mutation()))
        .data;
      expect(
        (await rejects(small.svc.createPortfolio(ctx.owner, ctx.ws, { name: 'two' }, mutation())))
          .issues?.[0]?.code,
      ).toBe('too_many');
      expect(
        (
          await rejects(
            small.svc.setPortfolioProjects(
              ctx.owner,
              ctx.ws,
              one.id,
              {
                projects: Array.from(
                  { length: 11 },
                  (_, i) => `prj_${String(i).padStart(26, '0')}`,
                ),
                version: 0,
              },
              mutation(),
            ),
          )
        ).issues?.[0]?.code,
      ).toBe('too_many');
      await env.svc.portfolioLifecycle(owner, ws, boardId, 'archive', mutation());
      expect((await env.svc.listPortfolios(owner, ws, {})).data.map((p) => p.name)).not.toContain(
        'Harbor portfolio',
      );
      const archived = await rejects(
        env.svc.updatePortfolio(owner, ws, boardId, { name: 'x' }, ifMatch(2)),
      );
      expect(archived.code).toBe('conflict');
      await env.svc.portfolioLifecycle(owner, ws, boardId, 'unarchive', mutation());
      await env.svc.portfolioLifecycle(owner, ws, boardId, 'trash', mutation());
      expect((await rejects(env.svc.getPortfolio(owner, ws, boardId))).code).toBe('not_found');
      await env.svc.portfolioLifecycle(owner, ws, boardId, 'restore', mutation());
      expect((await env.svc.getPortfolio(owner, ws, boardId)).projects_count).toBe(4);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('health, budgets, deadlines, and effort', () => {
    it('evaluates every project by the same explainable rules and says what is missing', async () => {
      const o = await env.svc.portfolioOverview(owner, ws, { brand: brands.Harbor });
      expect(o.summary.projects).toBe(5); // Late, Fine, Slipping, Quiet, Vault
      const late = row(o, 'Late').health;
      expect(late.value).toBe('off_track');
      expect(late.reasons.map((r: { code: string }) => r.code)).toEqual(
        expect.arrayContaining(['deadline_passed', 'overdue_tasks', 'blocked_tasks']),
      );
      const slipping = row(o, 'Slipping').health;
      expect(slipping.value).toBe('at_risk');
      expect(slipping.reasons.map((r: { code: string }) => r.code)).toContain('behind_schedule');
      expect(row(o, 'Fine').health).toMatchObject({ value: 'on_track', reasons: [] });
      expect(row(o, 'Quiet').health).toMatchObject({
        value: 'unknown',
        incomplete: expect.arrayContaining(['no_dates', 'no_tasks', 'not_started']),
      });
      expect(row(o, 'Late').progress).toEqual({
        done: 1,
        total: 4,
        percent: 25,
        basis: 'readable_leaf_tasks',
      });
      expect(row(o, 'Late').tasks).toEqual({ open: 3, overdue: 3, blocked: 1 });
      // The ordering puts the worst first.
      expect(o.data[0]!.health.value).toBe('off_track');
      expect(o.computed).toBe('live');
      expect(o.coverage).toMatchObject({
        truncated: false,
        not_tracked: ['money_spend', 'ai_usage'],
      });
      // Declared health stays the project's own and is shown beside the computed one.
      const fine = await env.svc.getProject(owner, ws, prj.Fine!);
      await env.svc.updateProject(
        owner,
        ws,
        prj.Fine!,
        { version: fine.version, changes: { health: { base: null, value: 'at_risk' } } },
        mutation({ ifMatch: `"${fine.version}"` }),
      );
      const again = row(
        await env.svc.portfolioOverview(owner, ws, { brand: brands.Harbor }),
        'Fine',
      );
      expect(again.declared_health).toMatchObject({ value: 'at_risk' });
      expect(again.health).toMatchObject({ value: 'on_track', differs_from_declared: true });
    });

    it('summarizes budgets by currency without inventing spend, deadlines, and effort', async () => {
      const o = await env.svc.portfolioOverview(owner, ws, { brand: brands.Harbor });
      expect(o.summary.budgets.money).toEqual({
        by_currency: [
          { currency: 'EUR', budgeted: 1000, projects: 1 },
          { currency: 'USD', budgeted: 7000, projects: 2 },
        ],
        spend_tracked: false,
      });
      expect(row(o, 'Fine').budget).toMatchObject({
        money: { amount: 5000, currency: 'USD', spend: null },
        time: { minutes: 600, logged_minutes: 120 },
      });
      expect(o.summary.budgets.time).toMatchObject({
        budgeted_minutes: 600,
        over_budget_projects: 0,
        projects: 1,
      });
      expect(o.summary.budgets.ai).toMatchObject({ usage_tracked: false });
      expect(o.summary.schedule.overdue_projects).toBeGreaterThanOrEqual(1);
      expect(o.summary.schedule.upcoming.map((u: { name: string }) => u.name)).toContain(
        'Slipping',
      );
      // Open estimates (3 open Fine tasks of 60 minutes less nothing logged against f4/f5, f3 has 120 logged), unestimated counted.
      expect(row(o, 'Fine').effort).toMatchObject({
        open_estimate_minutes: 60 + 60 + 0,
        unestimated_open_tasks: 2,
        logged_minutes: 120,
      });
      expect(row(o, 'Slipping').effort.unestimated_open_tasks).toBe(2);
      expect(o.summary.effort.unestimated_open_tasks).toBeGreaterThan(0);
    });

    it('never lets work, projects, brands, time, or budgets the viewer cannot read change a figure or a label', async () => {
      const owner_ = await env.svc.portfolioOverview(owner, ws, {});
      const editor_ = await env.svc.portfolioOverview(editor, ws, {});
      expect(owner_.summary.projects).toBe(6);
      expect(editor_.summary.projects).toBe(4); // Late, Fine, Slipping, Quiet (Vault is restricted, Site is Summit)
      expect(editor_.data.map((r: { name: string }) => r.name).sort()).toEqual([
        'Fine',
        'Late',
        'Quiet',
        'Slipping',
      ]);
      const text = JSON.stringify(editor_);
      expect(text).not.toMatch(/Vault|Site|Summit|v1|v2|u1/);
      // Vault's 300 logged minutes and its estimate appear in no total the editor sees.
      expect(editor_.summary.effort.logged_minutes).toBe(120);
      expect(owner_.summary.effort.logged_minutes).toBe(420);
      expect(row(editor_, 'Late').tasks.blocked).toBe(0); // v2 blocks l2, but the editor cannot read v2
      expect(row(owner_, 'Late').tasks.blocked).toBe(1);
      const reader_ = await env.svc.portfolioOverview(reader, ws, {});
      expect(reader_.summary.projects).toBe(4);
      const none = await env.svc.portfolioOverview(outsider, ws, {});
      expect(none.summary.projects).toBe(0);
      expect(none.data).toEqual([]);
    });

    it('filters by portfolio, brand, status, health, and owner, and reports a truncated read', async () => {
      const board = await env.svc.portfolioDetail(owner, ws, boardId, {});
      expect(board.portfolio).toMatchObject({ id: boardId, projects_count: 4 });
      expect(board.summary.projects).toBe(4);
      expect(board.coverage.scope).toBe('portfolio');
      expect(
        (await env.svc.portfolioOverview(owner, ws, { health: 'off_track' })).data.map(
          (r: { name: string }) => r.name,
        ),
      ).toContain('Late');
      expect(
        (await env.svc.portfolioOverview(owner, ws, { status: 'planned' })).data.map(
          (r: { name: string }) => r.name,
        ),
      ).toEqual(['Quiet']);
      expect(
        (
          await env.svc.portfolioOverview(owner, ws, { owner: 'me', brand: brands.Summit })
        ).data.map((r: { name: string }) => r.name),
      ).toEqual(['Site']);
      expect(
        (await rejects(env.svc.portfolioOverview(owner, ws, { health: 'great' }))).issues?.[0]
          ?.pointer,
      ).toBe('/health');
      const small = workEnv(db, { work: { portfolioReadProjectsMax: 2 } });
      const ctx = await workspaceWith(small, db, ['T']);
      for (const n of ['a', 'b', 'c'])
        await small.svc.createProject(
          ctx.owner,
          ctx.ws,
          { brand: ctx.brands.T, name: n },
          mutation(),
        );
      const t = await small.svc.portfolioOverview(ctx.owner, ctx.ws, {});
      expect(t.coverage.truncated).toBe(true);
      expect(t.summary.projects).toBe(2);
      expect(
        (await rejects(small.svc.exportPortfolio(ctx.owner, ctx.ws, {}))).issues?.[0]?.code,
      ).toBe('too_many');
    });

    it('keeps hidden brands out of a portfolio the editor reads, without a hint that members were left out', async () => {
      const asEditor = await env.svc.portfolioDetail(editor, ws, allId, {});
      expect(asEditor.summary.projects).toBe(2); // Fine and Slipping; Site and Vault are not readable
      expect(JSON.stringify(asEditor)).not.toMatch(/Vault|Site|Summit/);
      expect(asEditor.portfolio.projects_count).toBe(2);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('dependencies', () => {
    it('shows cross-project dependencies between readable work, with state and drill-down', async () => {
      const d = await env.svc.portfolioDependencies(owner, ws, {});
      const pairs = d.data
        .map((x: any) => `${x.blocker_project.name}>${x.blocked_project.name}`)
        .sort();
      expect(pairs).toEqual(['Fine>Slipping', 'Site>Fine', 'Vault>Late']);
      const fs = d.data.find((x: any) => x.blocker_project.name === 'Fine');
      expect(fs!.edges[0]).toMatchObject({
        blocker: { id: tsk.f3 },
        blocked: { id: tsk.s4 },
        state: expect.stringMatching(/open|late|overdue/),
      });
      expect(d.summary.open + d.summary.overdue + d.summary.late).toBe(3);
      expect(d.summary.late).toBeGreaterThanOrEqual(1);
    });

    it('omits a dependency whose other end the viewer cannot read, and everything derived from it', async () => {
      const d = await env.svc.portfolioDependencies(editor, ws, {});
      expect(d.data.map((x: any) => `${x.blocker_project.name}>${x.blocked_project.name}`)).toEqual(
        ['Fine>Slipping'],
      );
      // The blocker (Fine, due in 40 days) is due after the blocked task (Slipping, due in 8): late.
      expect(d.summary).toEqual({ open: 0, overdue: 0, late: 1, resolved: 0 });
      expect(JSON.stringify(d)).not.toMatch(/Vault|Site|Summit|"v2"|"u1"/);
      expect(row(await env.svc.portfolioOverview(editor, ws, {}), 'Fine').dependencies).toEqual({
        blocking: 1,
        blocked_by: 0,
      });
      expect(row(await env.svc.portfolioOverview(owner, ws, {}), 'Fine').dependencies).toEqual({
        blocking: 1,
        blocked_by: 1,
      });
    });

    it('marks a dependency resolved once the blocker is done', async () => {
      await finish('f3');
      const d = await env.svc.portfolioDependencies(owner, ws, {});
      expect(d.data.find((x: any) => x.blocker_project.name === 'Fine')!.counts.resolved).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('orphans', () => {
    it('lists projects without a goal the viewer can read and goals without active work they can read', async () => {
      const o = await env.svc.portfolioOrphans(owner, ws, {});
      const names = o.projects.data.map((p: { name: string }) => p.name).sort();
      // Fine (G1) and Slipping (G2 via a task) are linked; Late's only goal is cancelled; Quiet has none.
      expect(names).toEqual(expect.arrayContaining(['Late', 'Quiet']));
      expect(names).not.toContain('Fine');
      expect(names).not.toContain('Slipping');
      const g3 = o.goals.data.find((g: { id: string }) => g.id === goalId.G3);
      expect(g3).toMatchObject({ reason: 'no_visible_work' });
      expect(o.goals.data.map((g: { id: string }) => g.id)).not.toContain(goalId.G4); // cancelled goals are not findings
      expect(o.coverage.relative_to).toBe('viewer');
    });

    it('says "no active work" when linked work is finished, and counts only work the viewer can read', async () => {
      const g = (await env.svc.createGoal(owner, ws, { title: 'Done work', period: Q }, mutation()))
        .data;
      await env.svc.addGoalLink(owner, ws, g.id, { target: tsk.l1! }, mutation()); // l1 is done
      let o = await env.svc.portfolioOrphans(owner, ws, {});
      expect(o.goals.data.find((x: { id: string }) => x.id === g.id)).toMatchObject({
        reason: 'no_active_work',
      });
      await env.svc.addGoalLink(owner, ws, g.id, { target: tsk.v2! }, mutation()); // open, but in a restricted project
      o = await env.svc.portfolioOrphans(owner, ws, {});
      expect(o.goals.data.find((x: { id: string }) => x.id === g.id)).toBeUndefined();
      const e = await env.svc.portfolioOrphans(editor, ws, {});
      expect(e.goals.data.find((x: { id: string }) => x.id === g.id)).toMatchObject({
        reason: 'no_active_work',
      });
      expect(JSON.stringify(e)).not.toMatch(/Vault|"v2"/);
    });

    it('counts a project as linked through a parent project', async () => {
      const child = (
        await env.svc.createProject(
          owner,
          ws,
          { brand: brands.Harbor, name: 'Child of Fine', parent: prj.Fine },
          mutation(),
        )
      ).data.id;
      const o = await env.svc.portfolioOrphans(owner, ws, { brand: brands.Harbor });
      expect(o.projects.data.map((p: { name: string }) => p.name)).not.toContain('Child of Fine');
      const ov = await env.svc.portfolioOverview(owner, ws, { brand: brands.Harbor });
      expect(row(ov, 'Child of Fine').goals).toEqual({ direct: 0, inherited: 1, linked: true });
      expect(child).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('exports', () => {
    it('exports the portfolio rows the viewer may read, audited and formula-safe', async () => {
      const csv = await env.svc.exportPortfolio(editor, ws, {});
      const lines = csv.body.split('\r\n').filter(Boolean);
      expect(lines[0]).toContain('computed_health');
      expect(lines).toHaveLength(1 + 5); // Late, Fine, Slipping, Quiet, Child of Fine
      expect(csv.body).not.toMatch(/Vault|Site|Summit/);
      const json = JSON.parse(
        (await env.svc.exportPortfolio(owner, ws, { format: 'json', brand: brands.Summit })).body,
      );
      expect(json.projects.map((p: { name: string }) => p.name)).toEqual(['Site']);
      expect(
        (
          await sql(
            `SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'portfolio.exported'`,
          )
        )[0]!.n,
      ).toBe(2);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('purge and constraints', () => {
    it('removes links and memberships that name a purged project or task, and a goal with its history', async () => {
      const doomed = await project('Doomed', brands.Harbor!, {});
      const t = await task('d1', 'Doomed');
      const g = (
        await env.svc.createGoal(
          owner,
          ws,
          { title: 'Purge me', period: Q, basis: 'key_results' },
          mutation(),
        )
      ).data;
      const kr = (
        await env.svc.createKeyResult(
          owner,
          ws,
          g.id,
          { title: 'K', metric: { baseline: 0, target: 10 } },
          mutation(),
        )
      ).data;
      await env.svc.recordCheckin(owner, ws, g.id, { key_result: kr.id, value: 4 }, mutation());
      await env.svc.recordCheckin(owner, ws, g.id, { note: 'goal level' }, mutation());
      await env.svc.addGoalLink(owner, ws, g.id, { target: doomed.id }, mutation());
      await env.svc.addGoalLink(owner, ws, g.id, { target: t }, mutation());
      const pf = (await env.svc.createPortfolio(owner, ws, { name: 'Tmp' }, mutation())).data;
      await env.svc.setPortfolioProjects(
        owner,
        ws,
        pf.id,
        { projects: [doomed.id], version: 0 },
        mutation(),
      );
      const internal = async (publicId: string) =>
        (await sql(`SELECT id FROM core.record WHERE public_id = '${publicId}'`))[0]!.id as string;
      const [projectInternal, taskInternal, goalInternal, krInternal] = await Promise.all(
        [doomed.id, t, g.id, kr.id].map(internal),
      );
      const registry = productLifecycleRegistry();
      await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
        await registry.get('task')!.purge!.deleteContent(tx, [taskInternal!]);
        // The project's own purge also removes its access grants (its own tests cover that); here
        // only the goal and portfolio references that name it matter.
        await purgeGoalTargets(tx, [projectInternal!]);
      });
      expect(
        await sql(
          `SELECT 1 FROM goals.goal_link WHERE target_record_id IN ('${projectInternal}', '${taskInternal}')`,
        ),
      ).toHaveLength(0);
      expect(
        await sql(`SELECT 1 FROM goals.portfolio_project WHERE project_id = '${projectInternal}'`),
      ).toHaveLength(0);
      expect((await env.svc.getGoal(owner, ws, g.id)).links).toEqual([]);
      expect((await env.svc.getPortfolio(owner, ws, pf.id)).projects_count).toBe(0);
      await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
        await registry.get('key_result')!.purge!.deleteContent(tx, [krInternal!]);
        await registry.get('goal')!.purge!.deleteContent(tx, [goalInternal!]);
      });
      for (const table of ['goal', 'key_result', 'goal_checkin', 'goal_link', 'goal_state'])
        expect(
          await sql(
            `SELECT 1 FROM goals.${table} WHERE ${table === 'goal' ? 'id' : table === 'key_result' ? 'goal_id' : 'goal_id'} = '${goalInternal}'`,
          ),
          table,
        ).toHaveLength(0);
    });

    it('enforces its integrity in the database, not only in commands', async () => {
      const g = (
        await env.svc.createGoal(
          owner,
          ws,
          { title: 'Guard', period: Q, brand: brands.Harbor },
          mutation(),
        )
      ).data;
      const gi = (await sql(`SELECT id FROM core.record WHERE public_id = '${g.id}'`))[0]!.id;
      const siteInternal = (
        await sql(`SELECT id, brand_id FROM core.record WHERE public_id = '${prj.Site}'`)
      )[0]!;
      // A brand goal cannot link another brand's work, even by direct insert.
      await expect(
        db.admin(`INSERT INTO goals.goal_link (id, workspace_id, goal_id, target_kind, target_record_id, target_brand_id, created_by_membership_id)
          SELECT gen_random_uuid(), '${wsId}', '${gi}', 'project', '${siteInternal.id}', '${siteInternal.brand_id}', id FROM tenancy.membership LIMIT 1`),
      ).rejects.toThrow(/own brand/);
      // A link must name a project or a task.
      const brandRecord = (
        await sql(`SELECT id, brand_id FROM core.record WHERE record_type = 'brand' LIMIT 1`)
      )[0]!;
      await expect(
        db.admin(`INSERT INTO goals.goal_link (id, workspace_id, goal_id, target_kind, target_record_id, target_brand_id, created_by_membership_id)
          SELECT gen_random_uuid(), '${wsId}', '${gi}', 'project', '${brandRecord.id}', '${brandRecord.id}', id FROM tenancy.membership LIMIT 1`),
      ).rejects.toThrow();
      // A brand portfolio holds only its brand's projects.
      const pfId = (await sql(`SELECT id FROM core.record WHERE public_id = '${boardId}'`))[0]!.id;
      await expect(
        db.admin(`INSERT INTO goals.portfolio_project (workspace_id, portfolio_id, project_id, position, added_by_membership_id)
          SELECT '${wsId}', '${pfId}', '${siteInternal.id}', 9, id FROM tenancy.membership LIMIT 1`),
      ).rejects.toThrow(/own brand/);
      // A target needs its baseline, and a derived goal carries no measurement.
      await expect(
        db.admin(`UPDATE goals.goal SET target_value = 5 WHERE id = '${gi}'`),
      ).rejects.toThrow();
      await expect(
        db.admin(
          `UPDATE goals.goal SET progress_basis = 'linked_work', baseline_value = 0, target_value = 5 WHERE id = '${gi}'`,
        ),
      ).rejects.toThrow();
    });
  });
});
