import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureClasses, statementShape } from '@pm/test-support';
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

/**
 * Phase 3B layout reads (ADR-0020): every layout fact comes from the records the caller's own
 * compiled 3A query returns. Workload totals, Gantt arrows, milestones, portfolio progress, the
 * caller's time, and activity never count, point at, or reveal a hidden record; history is outside
 * a share; layouts persist on saved views and each entity offers only its own layouts.
 */
/** Time cannot be logged in the future (3D): the time facts use the past two days. */
const PAST = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
const PAST_WEEK = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);

describe('Phase 3B core view layouts', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let ws: string;
  let owner: Caller;
  let member: Caller;
  let shareOnly: Caller;
  const brands = {} as Record<'Alpha' | 'Secret', string>;
  let launch: string;
  let vault: string;
  const t: Record<string, string> = {};
  let memberId: string;
  const all = { entity: 'task' };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    const w = await workspaceWith(env, db, ['Alpha', 'Secret']);
    ({ ws, owner } = w);
    Object.assign(brands, w.brands);
    const wsId = await workspaceIdOf(db, ws);
    env.stepUp.allow = true;
    await env.svc.setSensitivity(
      owner,
      ws,
      brands.Secret,
      { is_sensitive: true },
      mutation({ ifMatch: '"0"', stepUpToken: 't' }),
    );
    env.stepUp.allow = false;
    member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    shareOnly = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
    memberId = await mem(member);
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Alpha,
      principal: memberId,
      level: 'edit',
    });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Secret,
      principal: await mem(owner),
      level: 'manage',
    });
    launch = (
      await env.svc.createProject(owner, ws, { brand: brands.Alpha, name: 'Launch' }, mutation())
    ).data.id;
    vault = (
      await env.svc.createProject(owner, ws, { brand: brands.Alpha, name: 'Vault' }, mutation())
    ).data.id;
    await env.svc.setAccess(
      owner,
      ws,
      vault,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    await env.svc.createMilestone(
      owner,
      ws,
      launch,
      { name: 'Beta', due_date: '2026-11-20' },
      mutation(),
    );
    await env.svc.createMilestone(
      owner,
      ws,
      vault,
      { name: 'Hidden', due_date: '2026-11-21' },
      mutation(),
    );
    const mk = async (key: string, body: Record<string, unknown>) =>
      (t[key] = (await env.svc.createTask(owner, ws, { title: key, ...body }, mutation())).data.id);
    await mk('a', { project: launch, due_date: '2026-11-02', estimate_minutes: 60 });
    await mk('b', { project: launch, due_date: '2026-11-03', estimate_minutes: 90 });
    await mk('c', { project: launch, due_date: '2026-11-10' });
    await mk('vault', { project: vault, due_date: '2026-11-02', estimate_minutes: 600 });
    await mk('secret', { brand: brands.Secret, due_date: '2026-11-02', estimate_minutes: 600 });
    await mk('shared', { brand: brands.Alpha, due_date: '2026-11-04', estimate_minutes: 30 });
    for (const k of ['a', 'b', 'c', 'vault', 'secret']) {
      const v = (await env.svc.getTask(owner, ws, t[k]!)).version;
      await env.svc.setAssignees(
        owner,
        ws,
        t[k]!,
        { assignees: [memberId], primary: memberId, version: v },
        mutation(),
      );
    }
    // a blocks b (both readable); vault blocks a (one end hidden from the member).
    await env.svc.addRelationship(owner, ws, t.a!, { kind: 'blocks', target: t.b! }, mutation());
    await env.svc.addRelationship(
      owner,
      ws,
      t.vault!,
      { kind: 'blocks', target: t.a! },
      mutation(),
    );
    // Leaf tasks: a done, c open; b open; vault open (hidden from the member).
    const done = async (k: string) => {
      const v = (await env.svc.getTask(owner, ws, t[k]!)).version;
      await env.svc.completeTask(owner, ws, t[k]!, {}, mutation({ ifMatch: `"${v}"` }));
    };
    await done('a');
    await apply(env, owner, ws, {
      kind: 'record_share',
      record: t.shared!,
      grantee: await mem(shareOnly),
      level: 'edit',
    });
    // Time: the member logs on a and c; the owner logs on a (never shown to the member).
    for (const [who, k, min] of [
      [member, 'a', 30],
      [member, 'c', 45],
      [owner, 'a', 120],
    ] as const)
      await env.svc.createEntry(
        who,
        ws,
        { target: t[k]!, work_date: PAST, duration_minutes: min },
        mutation(),
      );
  }, 240_000);
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('workload sums only the tasks the person can read, per owner and bucket', async () => {
    const body = { query: all, bucket: 'week', from: '2026-11-01', to: '2026-11-30' };
    const asMember = await env.svc.workload(member, ws, body);
    const asOwner = await env.svc.workload(owner, ws, body);
    const total = (r: typeof asMember) => r.people.reduce((n, x) => n + x.total_minutes, 0);
    // a is done (not open work); b 90 + c unestimated + the unassigned Alpha task 30; vault and
    // secret are hidden from the member.
    expect(total(asMember)).toBe(90 + 30);
    expect(total(asOwner)).toBe(90 + 600 + 600 + 30);
    // Week of 2 November: b (90); week of 9 November: c, which has no estimate.
    const cells = asMember.people.find((x) => x.id === memberId)!.cells;
    expect(cells['2026-11-02']).toEqual({ minutes: 90, tasks: 1, unestimated: 0 });
    expect(cells['2026-11-09']).toEqual({ minutes: 0, tasks: 1, unestimated: 1 });
    expect(asMember.capacity).toBeNull();
    await expect(env.svc.workload(member, ws, { ...body, to: '2028-01-01' })).rejects.toEqual(
      expect.objectContaining({ code: 'validation_failed' }),
    );
  });

  it('Gantt arrows connect only tasks both returned by the view; milestones and progress likewise', async () => {
    const ids = Object.values(t);
    const dm = await env.svc.dependencies(member, ws, { query: all, ids });
    expect(dm.edges).toEqual([{ from: t.a, to: t.b, kind: 'blocks' }]);
    const dOwn = await env.svc.dependencies(owner, ws, { query: all, ids });
    expect(dOwn.edges).toHaveLength(2);
    const projects = { query: { entity: 'project' }, ids: [launch, vault] };
    const mm = await env.svc.milestones(member, ws, projects);
    expect(mm.milestones.map((x) => x.name)).toEqual(['Beta']);
    const pm = await env.svc.progress(member, ws, projects);
    expect(pm.progress).toEqual([{ project: launch, done: 1, total: 3, percent: 33 }]);
    const po = await env.svc.progress(owner, ws, projects);
    expect(po.progress.map((x) => x.project).sort()).toEqual([launch, vault].sort());
  });

  it('the timesheet layout shows only the caller’s own time on readable tasks', async () => {
    const r = await env.svc.myTime(member, ws, {
      query: all,
      ids: [t.a!, t.c!, t.vault!],
      from: PAST_WEEK,
      days: 7,
    });
    expect(r.days).toHaveLength(7);
    expect(r.cells.map((c) => [c.task, c.minutes]).sort()).toEqual(
      [
        [t.a, 30],
        [t.c, 45],
      ].sort(),
    );
  });

  it('activity: records the view returns, outside shares, filtered, paged, and redacted', async () => {
    const m = await env.svc.activity(member, ws, 'task', { query: all, limit: 200 });
    const records = new Set(m.data.map((e) => e.record.id));
    expect(records.has(t.a!)).toBe(true);
    expect(records.has(t.vault!)).toBe(false);
    expect(records.has(t.secret!)).toBe(false);
    // The relationship change on a names the hidden vault task: that entry is omitted for the member.
    const json = JSON.stringify(m.data);
    expect(json).not.toContain(t.vault!);
    // History is outside a share (AZ-22): the share-only reader sees no activity.
    const s = await env.svc.activity(shareOnly, ws, 'task', { query: all });
    expect(s.data).toEqual([]);
    // Filters and pages.
    const mine = await env.svc.activity(owner, ws, 'task', { query: all, actor: 'me', limit: 3 });
    expect(mine.data.length).toBe(3);
    expect(mine.page.has_more).toBe(true);
    const next = await env.svc.activity(owner, ws, 'task', {
      query: all,
      actor: 'me',
      limit: 3,
      cursor: mine.page.next_cursor,
    });
    expect(next.data.map((e) => e.key)).not.toContain(mine.data[0]!.key);
    await expect(
      env.svc.activity(member, ws, 'task', {
        query: all,
        actor: 'me',
        limit: 3,
        cursor: mine.page.next_cursor,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'cursor_invalid' }));
    const agents = await env.svc.activity(owner, ws, 'task', { query: all, actor_type: 'agent' });
    expect(agents.data).toEqual([]);
  });

  it('hidden and unknown ids cost the same statements and time and return nothing', async () => {
    const spans = () => env.h.telemetry.spans!;
    const classes = {
      hidden: () => env.svc.dependencies(member, ws, { query: all, ids: [t.vault!] }),
      unknown: () =>
        env.svc.dependencies(member, ws, { query: all, ids: ['tsk_00000000000000000000000000'] }),
    };
    expect(await classes.hidden()).toEqual(await classes.unknown());
    const shapes: string[][] = [];
    for (const fn of Object.values(classes)) shapes.push(await statementShape(spans(), fn));
    expect(shapes[1]).toEqual(shapes[0]);
    const timing = await measureClasses(classes);
    expect(timing.maxDelta, JSON.stringify(timing.medians)).toBeLessThanOrEqual(timing.threshold);
  });

  it('group keys and every layout read carry public identifiers only (no internal UUIDs)', async () => {
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const field of ['brand', 'project', 'status', 'owner', 'milestone', 'priority']) {
      const r = await env.svc.query(owner, ws, 'task', {
        query: { entity: 'task', group: { field } },
        presentation: { columns: ['title', 'status', 'owner', 'project', 'milestone'] },
        limit: 200,
      });
      expect(JSON.stringify(r), field).not.toMatch(UUID);
      expect(r.groups!.length).toBeGreaterThan(0);
    }
    const ids = Object.values(t);
    for (const body of [
      await env.svc.workload(owner, ws, {
        query: all,
        bucket: 'day',
        from: '2026-11-01',
        to: '2026-11-30',
      }),
      await env.svc.dependencies(owner, ws, { query: all, ids }),
      await env.svc.activity(owner, ws, 'task', { query: all }),
      await env.svc.progress(owner, ws, { query: { entity: 'project' }, ids: [launch, vault] }),
      await env.svc.milestones(owner, ws, { query: { entity: 'project' }, ids: [launch, vault] }),
    ])
      expect(JSON.stringify(body)).not.toMatch(UUID);
  });

  it('saved views keep a layout per entity; other entities’ layouts are refused', async () => {
    const v = (
      await env.svc.createView(
        member,
        ws,
        {
          name: 'Board',
          layout: 'board',
          query: all,
          presentation: { board_field: 'status', density: 'compact' },
        },
        mutation(),
      )
    ).data;
    expect(v.layout).toBe('board');
    expect(v.presentation).toMatchObject({ board_field: 'status' });
    const u = (
      await env.svc.updateView(
        member,
        ws,
        v.id,
        {
          layout: 'calendar',
          presentation: { date_field: 'deadline_date', calendar_mode: 'week' },
          version: 0,
        },
        mutation(),
      )
    ).data;
    expect(u.layout).toBe('calendar');
    await expect(
      env.svc.createView(member, ws, { name: 'Bad', layout: 'portfolio', query: all }, mutation()),
    ).rejects.toEqual(expect.objectContaining({ code: 'validation_failed' }));
    await expect(
      env.svc.createView(
        member,
        ws,
        { name: 'Bad', query: all, presentation: { date_field: 'target_date' } },
        mutation(),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'validation_failed' }));
  });
});
