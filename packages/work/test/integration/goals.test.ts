import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
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
const Q4 = { kind: 'quarter', year: 2026, index: 4 };
const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; issues?: Array<{ code: string; pointer: string }> };
  }
  throw new Error('expected a rejection');
};

/**
 * 5B goals (ADR-0028): placement and authorization through the compiled level, key results,
 * append-only check-ins, links, and linked-work progress that is computed for each viewer from the
 * work that viewer may read.
 */
describe('Goals (5B)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller; // edit on Harbor
  let reader: Caller; // view on Harbor
  let outsider: Caller; // member with no access to Harbor or Summit
  let guest: Caller; // guest with a share on one task
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const pub: Record<string, string> = {};
  const proj: Record<string, string> = {};
  const tsk: Record<string, string> = {};

  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const sql = async (text: string) => (await db.admin(text)).rows as Array<Record<string, any>>;
  const goal = async (as: Caller, body: Record<string, unknown>) =>
    (await env.svc.createGoal(as, ws, { title: 'Grow', period: Q4, ...body }, mutation())).data;
  const complete = async (key: string) => {
    const v = (await env.svc.getTask(owner, ws, tsk[key]!)).version;
    await env.svc.completeTask(owner, ws, tsk[key]!, {}, mutation({ ifMatch: `"${v}"` }));
  };

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
    pub.reader = await mem(reader);
    pub.outsider = await mem(outsider);
    const mkProject = async (key: string, brand: string, name: string) =>
      (proj[key] = (await env.svc.createProject(owner, ws, { brand, name }, mutation())).data.id);
    await mkProject('launch', brands.Harbor!, 'Launch');
    await mkProject('vault', brands.Harbor!, 'Vault');
    await mkProject('site', brands.Summit!, 'Site');
    await env.svc.setAccess(
      owner,
      ws,
      proj.vault!,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    const mkTask = async (key: string, body: Record<string, unknown>) =>
      (tsk[key] = (
        await env.svc.createTask(owner, ws, { title: key, ...body }, mutation())
      ).data.id);
    await mkTask('l1', { project: proj.launch });
    await mkTask('l2', { project: proj.launch });
    await mkTask('l3', { project: proj.launch });
    await mkTask('v1', { project: proj.vault });
    await mkTask('v2', { project: proj.vault });
    await mkTask('s1', { project: proj.site });
    await mkTask('s2', { project: proj.site });
    await complete('l1');
    await complete('v1');
    await complete('s1');
    guest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: tsk.l2, level: 'comment' }],
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  // -------------------------------------------------------------------------------------------
  describe('placement and authorization', () => {
    it('creates workspace, brand, and project goals at the right level', async () => {
      const w = await goal(owner, {});
      expect(w).toMatchObject({
        type: 'goal',
        scope: { kind: 'workspace' },
        status: 'active',
        basis: 'manual',
        version: 0,
      });
      expect(w.period).toMatchObject({
        label: '2026 Q4',
        start: '2026-10-01',
        end: '2026-12-31',
        calendar: true,
      });
      const b = await goal(editor, { brand: brands.Harbor, title: 'Harbor growth' });
      expect(b.scope).toMatchObject({ kind: 'brand', brand: { name: 'Harbor' } });
      expect(b.owner).toMatchObject({ id: pub.editor });
      const p = await goal(editor, { project: proj.launch, title: 'Launch well' });
      expect(p.scope).toMatchObject({
        kind: 'project',
        project: { id: proj.launch, name: 'Launch' },
      });
    });

    it('refuses what the caller cannot place: view-only, no access, workspace level for a member without it', async () => {
      expect(
        (
          await rejects(
            env.svc.createGoal(
              reader,
              ws,
              { title: 'x', period: Q4, brand: brands.Harbor },
              mutation(),
            ),
          )
        ).code,
      ).toBe('forbidden');
      expect(
        (
          await rejects(
            env.svc.createGoal(
              outsider,
              ws,
              { title: 'x', period: Q4, brand: brands.Harbor },
              mutation(),
            ),
          )
        ).code,
      ).toBe('not_found');
      expect(
        (
          await rejects(
            env.svc.createGoal(
              editor,
              ws,
              { title: 'x', period: Q4, project: proj.site },
              mutation(),
            ),
          )
        ).code,
      ).toBe('not_found');
    });

    it('reads through the same level and gives unreadable and unknown goals one answer', async () => {
      const g = await goal(editor, { brand: brands.Harbor, title: 'Only Harbor' });
      await expect(env.svc.getGoal(reader, ws, g.id)).resolves.toMatchObject({ id: g.id });
      const hidden = await rejects(env.svc.getGoal(outsider, ws, g.id));
      const unknown = await rejects(
        env.svc.getGoal(outsider, ws, 'goal_01HZZZZZZZZZZZZZZZZZZZZZZZ'),
      );
      expect(hidden.code).toBe('not_found');
      expect(unknown.code).toBe('not_found');
      const list = await env.svc.listGoals(outsider, ws, {});
      expect(list.data.map((d) => d.id)).not.toContain(g.id);
    });

    it('never shows goals to guests, whether listed, read, or shared', async () => {
      const g = await goal(owner, { brand: brands.Harbor, title: 'Not for guests' });
      expect((await rejects(env.svc.listGoals(guest, ws, {}))).code).toBe('forbidden');
      expect((await rejects(env.svc.getGoal(guest, ws, g.id))).code).toBe('not_found');
      expect(
        (await rejects(env.svc.createGoal(guest, ws, { title: 'x', period: Q4 }, mutation()))).code,
      ).toBe('forbidden');
      expect((await rejects(env.svc.portfolioOverview(guest, ws, {}))).code).toBe('forbidden');
      // A goal can never be the subject of an exact-record share.
      const shared = await rejects(
        env.svc.previewChange(owner, ws, {
          kind: 'record_share',
          record: g.id,
          grantee: await mem(guest),
          level: 'read',
        }),
      );
      expect(['not_found', 'invalid', 'conflict', 'forbidden']).toContain(shared.code);
    });

    it("keeps an archived brand's goals read-only and requires an owner who can edit", async () => {
      const bad = await rejects(
        env.svc.createGoal(
          owner,
          ws,
          { title: 'x', period: Q4, brand: brands.Harbor, owner: pub.reader },
          mutation(),
        ),
      );
      expect(bad.issues).toEqual([
        expect.objectContaining({ pointer: '/owner', code: 'invalid_reference' }),
      ]);
      const good = await goal(owner, {
        brand: brands.Harbor,
        title: 'Owned by editor',
        owner: pub.editor,
      });
      expect(good.owner?.id).toBe(pub.editor);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('validation', () => {
    it('refuses unknown fields, bad periods, and inconsistent measurements with exact pointers', async () => {
      const e1 = await rejects(
        env.svc.createGoal(owner, ws, { title: 'x', period: Q4, nope: 1 }, mutation()),
      );
      expect(e1.issues).toEqual([
        expect.objectContaining({ pointer: '/nope', code: 'unsupported_field' }),
      ]);
      const e2 = await rejects(
        env.svc.createGoal(
          owner,
          ws,
          { title: 'x', period: { kind: 'quarter', year: 2026, index: 7 } },
          mutation(),
        ),
      );
      expect(e2.issues?.[0]).toMatchObject({ pointer: '/period', code: 'invalid_period' });
      const e3 = await rejects(
        env.svc.createGoal(
          owner,
          ws,
          { title: 'x', period: Q4, metric: { baseline: 1 } },
          mutation(),
        ),
      );
      expect(e3.issues?.[0]).toMatchObject({ pointer: '/metric', code: 'incomplete' });
      const e4 = await rejects(
        env.svc.createGoal(
          owner,
          ws,
          { title: 'x', period: Q4, metric: { baseline: 5, target: 5 } },
          mutation(),
        ),
      );
      expect(e4.issues?.[0]).toMatchObject({ pointer: '/metric/target' });
      const e5 = await rejects(
        env.svc.createGoal(
          owner,
          ws,
          { title: 'x', period: Q4, basis: 'linked_work', metric: { baseline: 0, target: 10 } },
          mutation(),
        ),
      );
      expect(e5.issues?.[0]).toMatchObject({ pointer: '/metric', code: 'conflicting' });
      const e6 = await rejects(env.svc.createGoal(owner, ws, { period: Q4 }, mutation()));
      expect(e6.issues?.[0]).toMatchObject({ pointer: '/title', code: 'required' });
      const e7 = await rejects(
        env.svc.createGoal(
          owner,
          ws,
          { title: 'x', period: Q4, metric: { baseline: 0, target: 1.00001 } },
          mutation(),
        ),
      );
      expect(e7.issues?.[0]).toMatchObject({ code: 'too_precise' });
    });

    it('keeps every scope within its bound', async () => {
      const small = workEnv(db, { work: { goalsPerScopeMax: 10 } });
      const ctx = await workspaceWith(small, db, ['Tiny']);
      for (let i = 0; i < 10; i++)
        await small.svc.createGoal(
          ctx.owner,
          ctx.ws,
          { title: `g${i}`, period: Q4, brand: ctx.brands.Tiny },
          mutation(),
        );
      const over = await rejects(
        small.svc.createGoal(
          ctx.owner,
          ctx.ws,
          { title: 'one more', period: Q4, brand: ctx.brands.Tiny },
          mutation(),
        ),
      );
      expect(over.issues?.[0]).toMatchObject({ code: 'too_many' });
      // Another scope is unaffected.
      await small.svc.createGoal(ctx.owner, ctx.ws, { title: 'workspace', period: Q4 }, mutation());
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('updates and concurrency', () => {
    it('updates with the loaded version and refuses a stale or missing one', async () => {
      const g = await goal(editor, { brand: brands.Harbor, title: 'Rename me' });
      const r = await env.svc.updateGoal(
        editor,
        ws,
        g.id,
        { title: 'Renamed', description: 'Why it matters' },
        ifMatch(g.version),
      );
      expect(r.data).toMatchObject({
        title: 'Renamed',
        description: 'Why it matters',
        version: g.version + 1,
      });
      const stale = await rejects(
        env.svc.updateGoal(editor, ws, g.id, { title: 'Late' }, ifMatch(g.version)),
      );
      expect(stale.code).toBe('conflict');
      const missing = await rejects(
        env.svc.updateGoal(editor, ws, g.id, { title: 'No version' }, mutation()),
      );
      expect(missing.code).toBe('precondition_required');
      const viaBody = await env.svc.updateGoal(
        editor,
        ws,
        g.id,
        { version: g.version + 1, title: 'By body' },
        mutation(),
      );
      expect(viaBody.data.title).toBe('By body');
    });

    it('serializes two concurrent updates: one wins, one is told the goal changed', async () => {
      const g = await goal(editor, { brand: brands.Harbor, title: 'Race' });
      const results = await Promise.allSettled([
        env.svc.updateGoal(editor, ws, g.id, { title: 'A' }, ifMatch(g.version)),
        env.svc.updateGoal(owner, ws, g.id, { title: 'B' }, ifMatch(g.version)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason.code).toBe('conflict');
    });

    it('changes status, never back to draft, and refuses changes to an archived goal', async () => {
      const g = await goal(owner, { title: 'Status', status: 'draft' });
      let v = g.version;
      v = (await env.svc.updateGoal(owner, ws, g.id, { status: 'active' }, ifMatch(v))).data
        .version;
      const back = await rejects(
        env.svc.updateGoal(owner, ws, g.id, { status: 'draft' }, ifMatch(v)),
      );
      expect(back.code).toBe('conflict');
      v = (await env.svc.updateGoal(owner, ws, g.id, { status: 'achieved' }, ifMatch(v))).data
        .version;
      v = (await env.svc.updateGoal(owner, ws, g.id, { status: 'active' }, ifMatch(v))).data
        .version;
      await env.svc.goalLifecycle(owner, ws, g.id, 'archive', mutation());
      const archived = await rejects(
        env.svc.updateGoal(owner, ws, g.id, { title: 'Nope' }, ifMatch(v)),
      );
      expect(archived.code).toBe('conflict');
      expect(archived.issues?.[0]?.code).toBe('goal_archived');
    });

    it('moves from manual to derived progress without keeping a stale measurement', async () => {
      const g = await goal(owner, {
        title: 'Switch',
        metric: { unit: 'users', baseline: 0, target: 100 },
      });
      const r = await env.svc.updateGoal(
        owner,
        ws,
        g.id,
        { basis: 'linked_work' },
        ifMatch(g.version),
      );
      expect(r.data).toMatchObject({
        basis: 'linked_work',
        metric: { target: null, unit: null, current: null },
      });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('check-ins', () => {
    it('measures a goal with a target from the value, and a goal without one from a percentage', async () => {
      const g = await goal(owner, {
        title: 'Users',
        metric: { unit: 'users', baseline: 100, target: 200 },
      });
      const c = await env.svc.recordCheckin(
        owner,
        ws,
        g.id,
        { value: 150, confidence: 'on_track', note: 'Halfway' },
        mutation(),
      );
      expect(c.data).toMatchObject({
        type: 'goal_checkin',
        source: 'manual',
        value: 150,
        progress_percent: 50,
        confidence: 'on_track',
        note: 'Halfway',
      });
      const after = await env.svc.getGoal(owner, ws, g.id);
      expect(after.progress).toMatchObject({ percent: 50, source: 'metric' });
      expect(after.latest).toMatchObject({ checkin: c.data.id, confidence: 'on_track' });
      expect(after.metric.current).toBe(150);
      const noTarget = await goal(owner, { title: 'Soft' });
      await env.svc.recordCheckin(owner, ws, noTarget.id, { percent: 40 }, mutation());
      expect((await env.svc.getGoal(owner, ws, noTarget.id)).progress).toMatchObject({
        percent: 40,
        source: 'manual_percent',
      });
      const e1 = await rejects(env.svc.recordCheckin(owner, ws, g.id, { percent: 10 }, mutation()));
      expect(e1.issues?.[0]).toMatchObject({ pointer: '/percent', code: 'has_target' });
      const e2 = await rejects(
        env.svc.recordCheckin(owner, ws, noTarget.id, { value: 10 }, mutation()),
      );
      expect(e2.issues?.[0]).toMatchObject({ pointer: '/value', code: 'no_target' });
      const e3 = await rejects(env.svc.recordCheckin(owner, ws, g.id, {}, mutation()));
      expect(e3.issues?.[0]).toMatchObject({ code: 'empty' });
    });

    it('keeps the last stated confidence when a later check-in states none, and appends history', async () => {
      const g = await goal(owner, { title: 'Confidence' });
      await env.svc.recordCheckin(
        owner,
        ws,
        g.id,
        { percent: 10, confidence: 'at_risk' },
        mutation(),
      );
      await env.svc.recordCheckin(owner, ws, g.id, { note: 'Just a note' }, mutation());
      const view = await env.svc.getGoal(owner, ws, g.id);
      expect(view.latest.confidence).toBe('at_risk');
      expect(view.progress.percent).toBe(10);
      const hist = await env.svc.listCheckins(owner, ws, g.id, {});
      expect(hist.data.map((c) => c.note)).toEqual(['Just a note', null]);
    });

    it('never lets a derived goal be set by hand, and never changes a check-in', async () => {
      const g = await goal(owner, { title: 'Derived', basis: 'linked_work' });
      const e = await rejects(env.svc.recordCheckin(owner, ws, g.id, { percent: 99 }, mutation()));
      expect(e.issues?.[0]).toMatchObject({ pointer: '/percent', code: 'derived' });
      const ok = await env.svc.recordCheckin(
        owner,
        ws,
        g.id,
        { confidence: 'off_track', note: 'Blocked on legal' },
        mutation(),
      );
      expect(ok.data.progress_percent).toBeNull();
      await expect(
        db.admin(`UPDATE goals.goal_checkin SET note = 'edited' WHERE public_id = '${ok.data.id}'`),
      ).rejects.toThrow(/immutable/);
    });

    it('replays one request as one check-in and limits the rate', async () => {
      const g = await goal(owner, { title: 'Idempotent' });
      const req = mutation();
      const first = await env.svc.recordCheckin(owner, ws, g.id, { percent: 20 }, req);
      const again = await env.svc.recordCheckin(owner, ws, g.id, { percent: 20 }, req);
      expect(again.replayed).toBe(true);
      expect(again.data.id).toBe(first.data.id);
      expect(
        (
          await sql(
            `SELECT count(*)::int AS n FROM goals.goal_checkin WHERE goal_id = (SELECT id FROM core.record WHERE public_id = '${g.id}')`,
          )
        )[0]!.n,
      ).toBe(1);
      const small = workEnv(db, { goalRate: 2 });
      const ctx = await workspaceWith(small, db, ['Rate']);
      const sg = (
        await small.svc.createGoal(ctx.owner, ctx.ws, { title: 'r', period: Q4 }, mutation())
      ).data;
      await small.svc.recordCheckin(ctx.owner, ctx.ws, sg.id, { percent: 1 }, mutation());
      await small.svc.recordCheckin(ctx.owner, ctx.ws, sg.id, { percent: 2 }, mutation());
      expect(
        (
          await rejects(
            small.svc.recordCheckin(ctx.owner, ctx.ws, sg.id, { percent: 3 }, mutation()),
          )
        ).code,
      ).toBe('rate_limited');
    });

    it('refuses a check-in on a closed goal, from a reader, and for a stranger', async () => {
      const g = await goal(editor, { brand: brands.Harbor, title: 'Closed' });
      expect(
        (await rejects(env.svc.recordCheckin(reader, ws, g.id, { percent: 1 }, mutation()))).code,
      ).toBe('forbidden');
      expect(
        (await rejects(env.svc.recordCheckin(outsider, ws, g.id, { percent: 1 }, mutation()))).code,
      ).toBe('not_found');
      await env.svc.updateGoal(editor, ws, g.id, { status: 'missed' }, ifMatch(g.version));
      const closed = await rejects(
        env.svc.recordCheckin(editor, ws, g.id, { percent: 1 }, mutation()),
      );
      expect(closed.issues?.[0]?.code).toBe('goal_closed');
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('key results', () => {
    it('rolls manual key results up as a plain mean and says how complete it is', async () => {
      const g = await goal(owner, { title: 'OKR', basis: 'key_results' });
      const k1 = (
        await env.svc.createKeyResult(
          owner,
          ws,
          g.id,
          { title: 'Signups', metric: { unit: 'n', baseline: 0, target: 200 } },
          mutation(),
        )
      ).data;
      const k2 = (
        await env.svc.createKeyResult(
          owner,
          ws,
          g.id,
          { title: 'NPS', metric: { baseline: 10, target: 50 } },
          mutation(),
        )
      ).data;
      await env.svc.createKeyResult(owner, ws, g.id, { title: 'Press' }, mutation());
      await env.svc.recordCheckin(owner, ws, g.id, { key_result: k1.id, value: 100 }, mutation());
      await env.svc.recordCheckin(owner, ws, g.id, { key_result: k2.id, value: 50 }, mutation());
      const view = await env.svc.getGoal(owner, ws, g.id);
      expect(view.progress).toMatchObject({
        percent: 75,
        source: 'key_results',
        key_results: { counted: 2, total: 3 },
        incomplete: ['unmeasured_key_results'],
      });
      expect(view.key_results.map((k) => k.title)).toEqual(['Signups', 'NPS', 'Press']);
      expect(view.key_results[0]!.progress).toMatchObject({ percent: 50 });
    });

    it('orders, edits, archives, and bounds key results', async () => {
      const small = workEnv(db, { work: { goalKeyResultsMax: 2 } });
      const ctx = await workspaceWith(small, db, ['KR']);
      const g = (
        await small.svc.createGoal(
          ctx.owner,
          ctx.ws,
          { title: 'k', period: Q4, basis: 'key_results' },
          mutation(),
        )
      ).data;
      const a = (
        await small.svc.createKeyResult(ctx.owner, ctx.ws, g.id, { title: 'A' }, mutation())
      ).data;
      const b = (
        await small.svc.createKeyResult(ctx.owner, ctx.ws, g.id, { title: 'B' }, mutation())
      ).data;
      expect(
        (
          await rejects(
            small.svc.createKeyResult(ctx.owner, ctx.ws, g.id, { title: 'C' }, mutation()),
          )
        ).issues?.[0]?.code,
      ).toBe('too_many');
      await small.svc.updateKeyResult(
        ctx.owner,
        ctx.ws,
        g.id,
        b.id,
        { after: null },
        ifMatch(b.version),
      );
      expect(
        (await small.svc.getGoal(ctx.owner, ctx.ws, g.id)).key_results.map((k) => k.title),
      ).toEqual(['B', 'A']);
      const renamed = await small.svc.updateKeyResult(
        ctx.owner,
        ctx.ws,
        g.id,
        a.id,
        { title: 'A2' },
        ifMatch(a.version),
      );
      expect(renamed.data.title).toBe('A2');
      expect(
        (
          await rejects(
            small.svc.updateKeyResult(
              ctx.owner,
              ctx.ws,
              g.id,
              a.id,
              { title: 'late' },
              ifMatch(a.version),
            ),
          )
        ).code,
      ).toBe('conflict');
      await small.svc.keyResultLifecycle(ctx.owner, ctx.ws, g.id, b.id, 'archive', mutation());
      expect(
        (await small.svc.getGoal(ctx.owner, ctx.ws, g.id)).key_results.map((k) => k.title),
      ).toEqual(['A2']);
      await small.svc.keyResultLifecycle(ctx.owner, ctx.ws, g.id, b.id, 'unarchive', mutation());
      expect((await small.svc.getGoal(ctx.owner, ctx.ws, g.id)).key_results).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('links and linked-work progress', () => {
    it('counts done leaf tasks over non-cancelled readable ones, for each viewer', async () => {
      const g = await goal(owner, { title: 'Ship', basis: 'linked_work' });
      await env.svc.addGoalLink(owner, ws, g.id, { target: proj.launch }, mutation()); // l1 done, l2, l3 open
      await env.svc.addGoalLink(owner, ws, g.id, { target: proj.vault }, mutation()); // v1 done, v2 open (restricted)
      await env.svc.addGoalLink(owner, ws, g.id, { target: proj.site }, mutation()); // s1 done, s2 open (Summit)
      const asOwner = await env.svc.getGoal(owner, ws, g.id);
      expect(asOwner.progress).toMatchObject({
        source: 'linked_work',
        work: { done: 3, total: 7 },
        percent: 43,
      });
      expect(asOwner.links.map((l) => l.target.name).sort()).toEqual(['Launch', 'Site', 'Vault']);
      // The editor reads this workspace goal, Harbor's Launch project, and nothing of Vault (restricted)
      // or Summit: their tasks change no number and their projects are not listed.
      const asEditor = await env.svc.getGoal(editor, ws, g.id);
      expect(asEditor.progress.work).toEqual({ done: 1, total: 3 });
      expect(asEditor.links.map((l) => l.target.name)).toEqual(['Launch']);
      expect(JSON.stringify(asEditor)).not.toMatch(/Vault|Site|Summit/);
    });

    it('computes progress only from the work the viewer may read and never discloses the rest', async () => {
      const g = await goal(editor, {
        brand: brands.Harbor,
        title: 'Harbor ship',
        basis: 'linked_work',
      });
      await env.svc.addGoalLink(editor, ws, g.id, { target: proj.launch }, mutation());
      await env.svc.addGoalLink(owner, ws, g.id, { target: proj.vault }, mutation());
      const asOwner = await env.svc.getGoal(owner, ws, g.id);
      expect(asOwner.progress.work).toEqual({ done: 2, total: 5 });
      const asEditor = await env.svc.getGoal(editor, ws, g.id);
      // Vault is restricted: its tasks change no number the editor sees, and it is not listed.
      expect(asEditor.progress.work).toEqual({ done: 1, total: 3 });
      expect(asEditor.links.map((l) => l.target.name)).toEqual(['Launch']);
      expect(JSON.stringify(asEditor)).not.toMatch(/Vault|v1|v2/);
      const asReader = await env.svc.getGoal(reader, ws, g.id);
      expect(asReader.progress.work).toEqual({ done: 1, total: 3 });
    });

    it('drills every figure down to the readable tasks behind it, and only those', async () => {
      const g = await goal(editor, { brand: brands.Harbor!, title: 'Drill', basis: 'linked_work' });
      await env.svc.addGoalLink(owner, ws, g.id, { target: proj.launch! }, mutation());
      await env.svc.addGoalLink(owner, ws, g.id, { target: proj.vault! }, mutation());
      const asOwner = await env.svc.goalWork(owner, ws, g.id, {});
      expect(asOwner.summary).toEqual({ done: 2, total: 5 });
      expect(asOwner.data).toHaveLength(5);
      expect(asOwner.data.filter((t) => t.done)).toHaveLength(2);
      const asEditor = await env.svc.goalWork(editor, ws, g.id, {});
      expect(asEditor.summary).toEqual({ done: 1, total: 3 });
      expect(asEditor.data.map((t) => t.title).sort()).toEqual(['l1', 'l2', 'l3']);
      expect(JSON.stringify(asEditor)).not.toMatch(/Vault|v1|v2/);
      // The list and the count come from the same readable set, so they always agree.
      expect(asEditor.data.length).toBe(asEditor.summary.total);
      expect((await rejects(env.svc.goalWork(outsider, ws, g.id, {}))).code).toBe('not_found');
      const e = await rejects(
        env.svc.goalWork(owner, ws, g.id, { key_result: 'kr_01HZZZZZZZZZZZZZZZZZZZZZZZ' }),
      );
      expect(e.issues?.[0]).toMatchObject({ pointer: '/key_result' });
    });

    it("counts a linked task and its subtasks, and a project's tasks only", async () => {
      const g = await goal(owner, { brand: brands.Harbor, title: 'Tasks', basis: 'linked_work' });
      const parent = (
        await env.svc.createTask(owner, ws, { title: 'parent', brand: brands.Harbor }, mutation())
      ).data.id;
      const c1 = (
        await env.svc.createTask(
          owner,
          ws,
          { title: 'c1', brand: brands.Harbor, parent },
          mutation(),
        )
      ).data.id;
      await env.svc.createTask(
        owner,
        ws,
        { title: 'c2', brand: brands.Harbor, parent },
        mutation(),
      );
      const v = (await env.svc.getTask(owner, ws, c1)).version;
      await env.svc.completeTask(owner, ws, c1, {}, mutation({ ifMatch: `"${v}"` }));
      await env.svc.addGoalLink(owner, ws, g.id, { target: parent }, mutation());
      expect((await env.svc.getGoal(owner, ws, g.id)).progress.work).toEqual({ done: 1, total: 2 });
    });

    it('refuses targets the caller cannot read, in the wrong scope, past the bound, and is idempotent', async () => {
      const g = await goal(editor, { brand: brands.Harbor, title: 'Links' });
      const hidden = await rejects(
        env.svc.addGoalLink(editor, ws, g.id, { target: proj.vault }, mutation()),
      );
      const unknown = await rejects(
        env.svc.addGoalLink(
          editor,
          ws,
          g.id,
          { target: 'prj_01HZZZZZZZZZZZZZZZZZZZZZZZ' },
          mutation(),
        ),
      );
      expect(hidden.issues?.[0]).toMatchObject({ pointer: '/target', code: 'invalid_reference' });
      expect(unknown.issues).toEqual(hidden.issues);
      // A brand goal links its own brand's work only.
      const cross = await rejects(
        env.svc.addGoalLink(owner, ws, g.id, { target: proj.site }, mutation()),
      );
      expect(cross.issues?.[0]).toMatchObject({ code: 'wrong_scope' });
      // A project goal links tasks of its own project.
      const pg = await goal(owner, { project: proj.launch, title: 'In project' });
      expect(
        (await rejects(env.svc.addGoalLink(owner, ws, pg.id, { target: proj.launch }, mutation())))
          .issues?.[0]?.code,
      ).toBe('wrong_scope');
      expect(
        (await rejects(env.svc.addGoalLink(owner, ws, pg.id, { target: tsk.s2 }, mutation())))
          .issues?.[0]?.code,
      ).toBe('wrong_scope');
      await env.svc.addGoalLink(owner, ws, pg.id, { target: tsk.l2 }, mutation());
      const again = await env.svc.addGoalLink(owner, ws, pg.id, { target: tsk.l2 }, mutation());
      expect(again.status).toBe(200);
      expect(
        (
          await sql(
            `SELECT count(*)::int AS n FROM goals.goal_link WHERE goal_id = (SELECT id FROM core.record WHERE public_id = '${pg.id}')`,
          )
        )[0]!.n,
      ).toBe(1);
      await env.svc.removeGoalLink(owner, ws, pg.id, { target: tsk.l2 }, mutation());
      await env.svc.removeGoalLink(owner, ws, pg.id, { target: tsk.l2 }, mutation()); // removing a missing link succeeds
      expect((await env.svc.getGoal(owner, ws, pg.id)).links).toEqual([]);
    });

    it('bounds the links a goal holds', async () => {
      const small = workEnv(db, { work: { goalLinksMax: 10 } });
      const ctx = await workspaceWith(small, db, ['Links']);
      const g = (
        await small.svc.createGoal(ctx.owner, ctx.ws, { title: 'many', period: Q4 }, mutation())
      ).data;
      for (let i = 0; i < 10; i++) {
        const t = (
          await small.svc.createTask(
            ctx.owner,
            ctx.ws,
            { title: `t${i}`, brand: ctx.brands.Links },
            mutation(),
          )
        ).data.id;
        await small.svc.addGoalLink(ctx.owner, ctx.ws, g.id, { target: t }, mutation());
      }
      const t = (
        await small.svc.createTask(
          ctx.owner,
          ctx.ws,
          { title: 'extra', brand: ctx.brands.Links },
          mutation(),
        )
      ).data.id;
      expect(
        (await rejects(small.svc.addGoalLink(ctx.owner, ctx.ws, g.id, { target: t }, mutation())))
          .issues?.[0]?.code,
      ).toBe('too_many');
    });

    it('lists the goals a project sees: scoped to it, or linked to it or its tasks', async () => {
      const a = await goal(owner, { project: proj.launch, title: 'Scoped' });
      const b = await goal(owner, { title: 'Linked via task' });
      await env.svc.addGoalLink(owner, ws, b.id, { target: tsk.l3 }, mutation());
      const list = await env.svc.goalsOfProject(editor, ws, proj.launch);
      expect(list.data.map((d) => d.id)).toEqual(expect.arrayContaining([a.id]));
      // Members read workspace-level goals (OD-06), so the editor sees the one linked through a readable task.
      expect(list.data.map((d) => d.id)).toContain(b.id);
      expect(await env.svc.goalsOfProject(outsider, ws, proj.launch).catch((e) => e.code)).toBe(
        'not_found',
      );
      const asOwner = await env.svc.goalsOfProject(owner, ws, proj.launch);
      expect(asOwner.data.map((d) => d.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('derived state and recalculation', () => {
    it('appends one computed check-in per distinct set of manual key results, idempotently', async () => {
      const g = await goal(owner, { title: 'Rollup', basis: 'key_results' });
      const k = (
        await env.svc.createKeyResult(
          owner,
          ws,
          g.id,
          { title: 'KR', metric: { baseline: 0, target: 10 } },
          mutation(),
        )
      ).data;
      await env.svc.recordCheckin(owner, ws, g.id, { key_result: k.id, value: 5 }, mutation());
      await env.svc.recalculateGoal(owner, ws, g.id, mutation());
      await env.svc.recalculateGoal(owner, ws, g.id, mutation());
      let hist = await env.svc.listCheckins(owner, ws, g.id, {});
      expect(hist.data.filter((c) => c.source === 'computed')).toHaveLength(1);
      expect(hist.data.find((c) => c.source === 'computed')).toMatchObject({
        progress_percent: 50,
        author: null,
      });
      await env.svc.recordCheckin(owner, ws, g.id, { key_result: k.id, value: 8 }, mutation());
      await env.svc.recalculateGoal(owner, ws, g.id, mutation());
      hist = await env.svc.listCheckins(owner, ws, g.id, {});
      expect(
        hist.data.filter((c) => c.source === 'computed').map((c) => c.progress_percent),
      ).toEqual([80, 50]);
      const st = (
        await sql(
          `SELECT rollup_percent::float AS p, rollup_basis, dirty FROM goals.goal_state WHERE goal_id = (SELECT id FROM core.record WHERE public_id = '${g.id}')`,
        )
      )[0]!;
      expect(st).toMatchObject({ p: 80, rollup_basis: 'key_results', dirty: false });
    });

    it('stores no number for a goal whose progress depends on linked work', async () => {
      const g = await goal(owner, { title: 'Viewer dependent', basis: 'linked_work' });
      await env.svc.addGoalLink(owner, ws, g.id, { target: proj.launch }, mutation());
      await env.svc.recalculateGoal(owner, ws, g.id, mutation());
      const st = (
        await sql(
          `SELECT rollup_percent, rollup_basis FROM goals.goal_state WHERE goal_id = (SELECT id FROM core.record WHERE public_id = '${g.id}')`,
        )
      )[0]!;
      expect(st).toEqual({ rollup_percent: null, rollup_basis: 'viewer_dependent' });
      expect((await env.svc.listCheckins(owner, ws, g.id, {})).data).toEqual([]);
      const mixed = await goal(owner, { title: 'Mixed', basis: 'key_results' });
      await env.svc.createKeyResult(
        owner,
        ws,
        mixed.id,
        { title: 'Work', basis: 'linked_work' },
        mutation(),
      );
      await env.svc.createKeyResult(
        owner,
        ws,
        mixed.id,
        { title: 'Hand', metric: { baseline: 0, target: 1, current: 1 } },
        mutation(),
      );
      await env.svc.recalculateGoal(owner, ws, mixed.id, mutation());
      expect((await env.svc.listCheckins(owner, ws, mixed.id, {})).data).toEqual([]);
    });

    it('reports freshness from the goal itself and the recalculation state truthfully', async () => {
      const g = await goal(owner, { title: 'Freshness' });
      let view = await env.svc.getGoal(owner, ws, g.id);
      expect(view.freshness).toMatchObject({
        update_state: 'never',
        period_state: expect.any(String),
        recalculation: { state: 'pending' },
      });
      await env.svc.recalculateGoal(owner, ws, g.id, mutation());
      view = await env.svc.getGoal(owner, ws, g.id);
      expect(view.freshness.recalculation.state).toBe('current');
      await env.svc.recordCheckin(owner, ws, g.id, { percent: 5 }, mutation());
      view = await env.svc.getGoal(owner, ws, g.id);
      expect(view.freshness.update_state).toBe('fresh');
      expect(view.freshness.recalculation.state).toBe('pending');
      // A check-in older than the window is stale for the viewer without waiting for the sweep.
      await db.admin(
        `UPDATE goals.goal SET latest_checkin_at = now() - interval '30 days' WHERE id = (SELECT id FROM core.record WHERE public_id = '${g.id}')`,
      );
      expect((await env.svc.getGoal(owner, ws, g.id)).freshness.update_state).toBe('stale');
      const stale = await env.svc.listGoals(owner, ws, { update: 'stale' });
      expect(stale.data.map((d) => d.id)).toContain(g.id);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('lists, filters, and exports', () => {
    it('filters and pages through only the goals the viewer may read', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++)
        ids.push((await goal(owner, { brand: brands.Summit, title: `Summit ${i}` })).id);
      const first = await env.svc.listGoals(owner, ws, { brand: brands.Summit, limit: 2 });
      expect(first.data).toHaveLength(2);
      expect(first.page.has_more).toBe(true);
      const second = await env.svc.listGoals(owner, ws, {
        brand: brands.Summit,
        limit: 2,
        cursor: (first.page as any).next_cursor,
      });
      expect(second.data.map((d) => d.id)).not.toEqual(
        expect.arrayContaining(first.data.map((d) => d.id)),
      );
      const tampered = await rejects(
        env.svc.listGoals(owner, ws, {
          brand: brands.Summit,
          limit: 2,
          cursor: (first.page as any).next_cursor + 'x',
        }),
      );
      expect(tampered.code).toBe('cursor_invalid');
      // A cursor is bound to its query and to the caller.
      expect(
        (
          await rejects(
            env.svc.listGoals(owner, ws, {
              brand: brands.Harbor,
              limit: 2,
              cursor: (first.page as any).next_cursor,
            }),
          )
        ).code,
      ).toBe('cursor_invalid');
      expect((await env.svc.listGoals(editor, ws, { brand: brands.Summit })).data).toEqual([]);
      const mine = await env.svc.listGoals(editor, ws, { owner: 'me' });
      expect(mine.data.every((d) => d.owner?.id === pub.editor)).toBe(true);
      const byText = await env.svc.listGoals(owner, ws, { q: 'Summit 3' });
      expect(byText.data.map((d) => d.title)).toEqual(['Summit 3']);
      expect(ids).toHaveLength(5);
    });

    it('exports what the viewer may read as bounded, audited CSV and JSON with neutralized formulas', async () => {
      await goal(owner, { brand: brands.Summit, title: '=HYPERLINK("http://x")' });
      const csv = await env.svc.exportGoals(owner, ws, { brand: brands.Summit });
      expect(csv.format).toBe('csv');
      expect(csv.body).toContain(`"'=HYPERLINK(""http://x"")"`);
      const json = JSON.parse(
        (await env.svc.exportGoals(owner, ws, { brand: brands.Summit, format: 'json' })).body,
      );
      expect(json.goals.length).toBeGreaterThan(0);
      const hidden = await env.svc.exportGoals(editor, ws, { brand: brands.Summit });
      expect(hidden.body.split('\r\n').filter(Boolean)).toHaveLength(1); // header only
      expect(
        (
          await sql(
            `SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'goals.exported'`,
          )
        )[0]!.n,
      ).toBeGreaterThanOrEqual(3);
      const small = workEnv(db, { work: { goalsExportRowsMax: 2 } });
      const ctx = await workspaceWith(small, db, ['Exp']);
      for (let i = 0; i < 3; i++)
        await small.svc.createGoal(
          ctx.owner,
          ctx.ws,
          { title: `e${i}`, period: Q4, brand: ctx.brands.Exp },
          mutation(),
        );
      const big = await rejects(
        small.svc.exportGoals(ctx.owner, ctx.ws, { brand: ctx.brands.Exp }),
      );
      expect(big.issues?.[0]).toMatchObject({ code: 'too_many' });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('revocation and concurrency', () => {
    it('stops every read, write, list, and export the moment access is revoked, and shrinks linked-work progress live', async () => {
      const temp = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
      const tempId = await mem(temp);
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor!,
        principal: tempId,
        level: 'edit',
      });
      const g = await goal(owner, {
        brand: brands.Harbor!,
        title: 'Revocable',
        basis: 'linked_work',
      });
      await env.svc.addGoalLink(owner, ws, g.id, { target: proj.launch! }, mutation());
      expect((await env.svc.getGoal(temp, ws, g.id)).progress.work).toEqual({ done: 1, total: 3 });
      expect((await env.svc.exportGoals(temp, ws, { brand: brands.Harbor! })).body).toContain(
        'Revocable',
      );
      // A project-level restriction removes that project's work from the very next read.
      await env.svc.setAccess(
        owner,
        ws,
        proj.launch!,
        { access_mode: 'restricted', allow_record_shares: false },
        mutation(),
      );
      const shrunk = await env.svc.getGoal(temp, ws, g.id);
      expect(shrunk.progress).toMatchObject({
        work: { done: 0, total: 0 },
        percent: null,
        incomplete: ['no_readable_work'],
      });
      expect(shrunk.links).toEqual([]);
      await env.svc.setAccess(
        owner,
        ws,
        proj.launch!,
        { access_mode: 'inherit', allow_record_shares: false },
        mutation(),
      );
      expect((await env.svc.getGoal(temp, ws, g.id)).progress.work).toEqual({ done: 1, total: 3 });
      // Revoking the brand removes the goal itself, everywhere, without a trace in any response.
      await apply(env, owner, ws, {
        kind: 'brand_revoke',
        brand: brands.Harbor!,
        principal: tempId,
      });
      expect((await rejects(env.svc.getGoal(temp, ws, g.id))).code).toBe('not_found');
      expect(
        (await rejects(env.svc.recordCheckin(temp, ws, g.id, { percent: 1 }, mutation()))).code,
      ).toBe('not_found');
      expect(
        (await rejects(env.svc.addGoalLink(temp, ws, g.id, { target: proj.launch! }, mutation())))
          .code,
      ).toBe('not_found');
      expect((await env.svc.listGoals(temp, ws, { brand: brands.Harbor! })).data).toEqual([]);
      expect(
        (await env.svc.exportGoals(temp, ws, { brand: brands.Harbor! })).body
          .split('\r\n')
          .filter(Boolean),
      ).toHaveLength(1);
      expect((await env.svc.portfolioOverview(temp, ws, {})).summary.projects).toBe(0);
      expect((await rejects(env.svc.listCheckins(temp, ws, g.id, {}))).code).toBe('not_found');
      // A replayed request after revocation is not found, and re-renders nothing.
      const req = mutation();
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor!,
        principal: tempId,
        level: 'edit',
      });
      await env.svc.recordCheckin(temp, ws, g.id, { percent: 5 }, req).catch(() => undefined);
      await apply(env, owner, ws, {
        kind: 'brand_revoke',
        brand: brands.Harbor!,
        principal: tempId,
      });
      expect((await rejects(env.svc.recordCheckin(temp, ws, g.id, { percent: 5 }, req))).code).toBe(
        'not_found',
      );
    });

    it('keeps two concurrent check-ins, links, and key results consistent', async () => {
      const g = await goal(owner, { title: 'Concurrent', basis: 'key_results' });
      const both = await Promise.all([
        env.svc.recordCheckin(owner, ws, g.id, { note: 'one', confidence: 'on_track' }, mutation()),
        env.svc.recordCheckin(owner, ws, g.id, { note: 'two', confidence: 'at_risk' }, mutation()),
      ]);
      expect(both).toHaveLength(2);
      const hist = await env.svc.listCheckins(owner, ws, g.id, {});
      expect(hist.data).toHaveLength(2);
      // The latest pointer is exactly the newest row in the history.
      expect((await env.svc.getGoal(owner, ws, g.id)).latest.checkin).toBe(hist.data[0]!.id);
      const links = await Promise.allSettled([
        env.svc.addGoalLink(owner, ws, g.id, { target: tsk.l3! }, mutation()),
        env.svc.addGoalLink(owner, ws, g.id, { target: tsk.l3! }, mutation()),
      ]);
      expect(links.every((r) => r.status === 'fulfilled')).toBe(true);
      expect((await env.svc.getGoal(owner, ws, g.id)).links).toHaveLength(1);
      const small = workEnv(db, { work: { goalKeyResultsMax: 2, goalsPerScopeMax: 3 } });
      const ctx = await workspaceWith(small, db, ['Race']);
      const sg = (
        await small.svc.createGoal(
          ctx.owner,
          ctx.ws,
          { title: 'k', period: Q4, basis: 'key_results' },
          mutation(),
        )
      ).data;
      const krs = await Promise.allSettled(
        ['a', 'b', 'c', 'd'].map((t) =>
          small.svc.createKeyResult(ctx.owner, ctx.ws, sg.id, { title: t }, mutation()),
        ),
      );
      expect(krs.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      const goals = await Promise.allSettled(
        [1, 2, 3, 4, 5, 6].map((i) =>
          small.svc.createGoal(
            ctx.owner,
            ctx.ws,
            { title: `g${i}`, period: Q4, brand: ctx.brands.Race! },
            mutation(),
          ),
        ),
      );
      expect(goals.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    });

    it('treats a reused idempotency key with a different request as a different request, never a replay', async () => {
      const req = mutation();
      const a = await env.svc.createGoal(owner, ws, { title: 'Key A', period: Q4 }, req);
      const same = await env.svc.createGoal(owner, ws, { title: 'Key A', period: Q4 }, req);
      expect(same.replayed).toBe(true);
      expect(same.data.id).toBe(a.data.id);
      const other = {
        ...req,
        fingerprint: createHash('sha256').update('a different request').digest(),
      };
      expect(
        (await rejects(env.svc.createGoal(owner, ws, { title: 'Key B', period: Q4 }, other))).code,
      ).toBe('idempotency_key_reuse');
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('lifecycle, departure, and history', () => {
    it('archives a goal with its key results, restores them, and trashes and restores', async () => {
      const g = await goal(owner, { title: 'Life', basis: 'key_results' });
      await env.svc.createKeyResult(owner, ws, g.id, { title: 'K' }, mutation());
      await env.svc.goalLifecycle(owner, ws, g.id, 'archive', mutation());
      expect(
        (
          await sql(
            `SELECT lifecycle_state FROM goals.key_result WHERE goal_id = (SELECT id FROM core.record WHERE public_id = '${g.id}')`,
          )
        )[0]!.lifecycle_state,
      ).toBe('archived');
      expect((await env.svc.listGoals(owner, ws, { q: 'Life' })).data).toEqual([]);
      await env.svc.goalLifecycle(owner, ws, g.id, 'unarchive', mutation());
      await env.svc.goalLifecycle(owner, ws, g.id, 'trash', mutation());
      expect((await rejects(env.svc.getGoal(owner, ws, g.id))).code).toBe('not_found');
      await env.svc.goalLifecycle(owner, ws, g.id, 'restore', mutation());
      expect((await env.svc.getGoal(owner, ws, g.id)).key_results).toHaveLength(1);
      expect(
        (await rejects(env.svc.goalLifecycle(reader, ws, g.id, 'archive', mutation()))).code,
      ).toMatch(/forbidden|not_found/);
    });

    it("moves a departing member's goals to the chosen member and keeps their check-ins", async () => {
      const leaver = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
      const leaverId = await mem(leaver);
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: leaverId,
        level: 'edit',
      });
      const g = await goal(leaver, { brand: brands.Harbor, title: 'Leaving' });
      await env.svc.recordCheckin(leaver, ws, g.id, { percent: 10, note: 'mine' }, mutation());
      const kr = await env.svc.createKeyResult(leaver, ws, g.id, { title: 'Mine' }, mutation());
      const preview = await env.svc.previewChange(owner, ws, { kind: 'remove', member: leaverId });
      env.stepUp.allow = true;
      try {
        await env.svc.removeMember(
          owner,
          ws,
          leaverId,
          { preview_token: preview.preview_token, reassign_to: pub.editor },
          mutation({ stepUpToken: 't' }),
        );
      } finally {
        env.stepUp.allow = false;
      }
      const after = await env.svc.getGoal(editor, ws, g.id);
      expect(after.owner).toMatchObject({ id: pub.editor });
      expect(after.key_results[0]!.owner).toMatchObject({ id: pub.editor });
      expect(kr.data.id).toBe(after.key_results[0]!.id);
      const hist = await env.svc.listCheckins(editor, ws, g.id, {});
      expect(hist.data[0]).toMatchObject({ note: 'mine', author: { name: 'Former member' } });
    });

    it('records goal changes in the audit trail without content', async () => {
      const g = await goal(owner, { title: 'Audited secret title' });
      await env.svc.updateGoal(
        owner,
        ws,
        g.id,
        { title: 'Another secret title' },
        ifMatch(g.version),
      );
      const rows = await sql(
        `SELECT action, changes::text AS c FROM audit.audit_event WHERE target_public_id = '${g.id}' ORDER BY occurred_at`,
      );
      expect(rows.map((r) => r.action)).toEqual(['goal.created', 'goal.updated']);
      expect(JSON.stringify(rows)).not.toMatch(/secret title/);
    });
  });
});
