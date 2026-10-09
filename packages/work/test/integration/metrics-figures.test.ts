import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { addDays, localDay } from '@pm/work';
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

const reason = (code: string) => expect.objectContaining({ code });
const invalid = (pointer: string, code: string) =>
  expect.objectContaining({
    code: 'validation_failed',
    issues: expect.arrayContaining([expect.objectContaining({ pointer, code })]),
  });

type SpanRow = [category: string, entered: string, left: string | null, basis?: string];

/**
 * Phase 5C figures on real PostgreSQL (ADR-0030): each metric's numerator, denominator, window,
 * time zone, incomplete-data labels, and drill-through, against history written to known instants.
 */
describe('Metric figures (5C)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const proj: Record<string, string> = {};
  const tsk: Record<string, string> = {};
  const sql = async (text: string, params: unknown[] = []) =>
    (await db.admin(text, params)).rows as Array<Record<string, any>>;
  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const metric = (as: Caller, id: string, q: Record<string, unknown> = {}) =>
    env.svc.getMetric(as, ws, id, q) as Promise<any>;
  const records = (as: Caller, id: string, member: string, q: Record<string, unknown> = {}) =>
    env.svc.getMetricRecords(as, ws, id, { member, limit: 100, ...q }) as Promise<any>;
  const titles = async (as: Caller, id: string, member: string, q: Record<string, unknown> = {}) =>
    (await records(as, id, member, q)).items.map((i: { title: string }) => i.title).sort();
  const drillsAgree = async (as: Caller, id: string, q: Record<string, unknown> = {}) => {
    const r = await metric(as, id, q);
    for (const m of r.drill.members) {
      const list = await records(as, id, m.role, q);
      expect(list.total, `${id}/${m.role} total`).toBe(m.count);
      expect(list.items.length, `${id}/${m.role} items`).toBe(m.count);
    }
    return r;
  };
  const mk = async (key: string, project: string, body: Record<string, unknown> = {}) =>
    (tsk[key] = (
      await env.svc.createTask(
        owner,
        ws,
        { project: proj[project], title: key, ...body },
        mutation(),
      )
    ).data.id);
  const idOf = async (key: string) =>
    (await sql(`SELECT id FROM core.record WHERE public_id = $1`, [tsk[key]]))[0]!.id as string;
  const done = async (key: string) => {
    const v = (await env.svc.getTask(owner, ws, tsk[key]!)).version;
    await env.svc.completeTask(owner, ws, tsk[key]!, {}, mutation({ ifMatch: `"${v}"` }));
  };
  /** Replaces a task's status history with spans at known instants. */
  const spans = async (key: string, rows: SpanRow[]) => {
    const id = await idOf(key);
    await sql(`DELETE FROM metrics.task_status_span WHERE task_id = $1`, [id]);
    let seq = 1;
    for (const [category, entered, left, basis] of rows)
      await sql(
        `INSERT INTO metrics.task_status_span (workspace_id, task_id, seq, status_id, status_category, entered_at, left_at, basis)
         SELECT workspace_id, id, $2, status_id, $3, $4, $5, $6 FROM work.task WHERE id = $1`,
        [id, seq++, category, entered, left, basis ?? 'recorded'],
      );
  };
  const setCreated = (key: string, at: string) =>
    idOf(key).then((id) => sql(`UPDATE work.task SET created_at = $2 WHERE id = $1`, [id, at]));
  const assign = async (key: string, who: Caller[]) => {
    const cur = await env.svc.getTask(owner, ws, tsk[key]!);
    await env.svc.setAssignees(
      owner,
      ws,
      tsk[key]!,
      { assignees: await Promise.all(who.map(mem)), version: cur.version },
      mutation(),
    );
  };
  const setStatus = async (key: string, value: string) => {
    const cur = await env.svc.getTask(owner, ws, tsk[key]!);
    await env.svc.updateTask(
      owner,
      ws,
      tsk[key]!,
      { version: cur.version, changes: { status: { base: cur.status.key, value } } },
      mutation({ ifMatch: `"${cur.version}"` }),
    );
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(editor),
      level: 'edit',
    });
    for (const k of [
      'cyc',
      'tis',
      'cvc',
      'pvc',
      'age',
      'load',
      'att',
      'act',
      'dlv',
      'health',
      'budget',
    ])
      proj[k] = (
        await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: `P ${k}` }, mutation())
      ).data.id;
    proj.vault = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Vault' }, mutation())
    ).data.id;
    await env.svc.setAccess(
      owner,
      ws,
      proj.vault!,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
  }, 240_000);
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  // -------------------------------------------------------------------------------------------
  it('measures cycle time from the first recorded active status to each completion, and says what it left out', async () => {
    const D = (d: string) => `2026-03-${d}Z`;
    for (const k of ['t1', 't2', 't3', 't4', 't5', 't6']) await mk(k, 'cyc');
    await spans('t1', [
      ['planned', D('01T08:00:00'), D('02T08:00:00')],
      ['active', D('02T08:00:00'), D('04T08:00:00')],
      ['done', D('04T08:00:00'), null],
    ]);
    await spans('t2', [
      ['planned', D('09T00:00:00'), D('10T00:00:00')],
      ['active', D('10T00:00:00'), D('11T00:00:00')],
      ['paused', D('11T00:00:00'), D('11T12:00:00')],
      ['active', D('11T12:00:00'), D('12T00:00:00')],
      ['done', D('12T00:00:00'), null],
    ]);
    await spans('t3', [
      ['active', D('15T00:00:00'), D('16T00:00:00')],
      ['done', D('16T00:00:00'), null],
    ]);
    await spans('t4', [
      ['planned', D('18T00:00:00'), D('20T00:00:00')],
      ['done', D('20T00:00:00'), null],
    ]);
    await spans('t5', [['done', D('20T00:00:00'), null, 'assumed']]);
    // A reopened task finishes twice: each completion is measured from its own start.
    await spans('t6', [
      ['active', D('01T00:00:00'), D('03T00:00:00')],
      ['done', D('03T00:00:00'), D('05T00:00:00')],
      ['active', D('05T00:00:00'), D('06T00:00:00')],
      ['done', D('06T00:00:00'), null],
    ]);
    const q = { from: '2026-03-01', to: '2026-03-31' };
    const r = await drillsAgree(owner, 'work.cycle_time', q);
    expect(r.value).toMatchObject({
      completions: 7,
      measured: 5,
      median_seconds: 172_800,
      p85_seconds: 172_800,
      mean_seconds: 138_240,
      min_seconds: 86_400,
      max_seconds: 172_800,
    });
    expect(r.state).toBe('partial');
    expect(r.incomplete.map((i: { code: string; count: number }) => [i.code, i.count])).toEqual([
      ['history_unavailable', 1],
      ['no_start', 1],
    ]);
    expect(await titles(owner, 'work.cycle_time', 'included', q)).toEqual(['t1', 't2', 't3', 't6']);
    expect(await titles(owner, 'work.cycle_time', 'excluded', q)).toEqual(['t4', 't5']);
    expect(r.timezone).toBe('Europe/Berlin');
    // A window that holds none of them is empty, not zero seconds.
    const none = await metric(owner, 'work.cycle_time', { from: '2025-01-01', to: '2025-01-31' });
    expect(none.state).toBe('empty');
    expect(none.value.median_seconds).toBeNull();
    // A single completion is shown, labelled as a small sample.
    const one = await metric(owner, 'work.cycle_time', {
      from: '2026-03-04',
      to: '2026-03-04',
      brand: brands.Harbor,
    });
    expect(one.value.measured).toBe(1);
    expect(one.incomplete.map((i: { code: string }) => i.code)).toContain('small_sample');
    // The same inputs give the same figure and digest, however many times they are read.
    const again = await metric(owner, 'work.cycle_time', q);
    expect(again.reproducibility.result_digest).toBe(r.reproducibility.result_digest);
    expect(r.reproducibility.definition_digest).toBe(r.definition.digest);
  });

  it('adds up time in each status inside a window, in the workspace zone, leaving assumed history out', async () => {
    for (const k of ['s1', 's2']) await mk(k, 'tis');
    // Berlin is UTC+1 until 2026-03-29: the local days 2 and 3 March are 03-01 23:00Z to 03-03 23:00Z.
    await spans('s1', [
      ['planned', '2026-03-01T00:00:00Z', '2026-03-03T00:00:00Z'],
      ['active', '2026-03-03T00:00:00Z', '2026-03-04T12:00:00Z'],
      ['done', '2026-03-04T12:00:00Z', null],
    ]);
    await spans('s2', [['active', '2026-03-01T00:00:00Z', null, 'assumed']]);
    const r = await drillsAgree(owner, 'work.time_in_status', {
      from: '2026-03-02',
      to: '2026-03-03',
      project: proj.tis,
    });
    const by = Object.fromEntries(
      r.value.categories.map((c: { category: string; seconds: number }) => [c.category, c.seconds]),
    );
    expect(by).toMatchObject({ planned: 25 * 3600, active: 23 * 3600, done: 0, paused: 0 });
    expect(r.value.total_seconds).toBe(48 * 3600);
    expect(
      r.value.categories.find((c: { category: string }) => c.category === 'planned').share_percent,
    ).toBe(52);
    expect(r.incomplete).toEqual([
      expect.objectContaining({ code: 'history_unavailable', count: 1 }),
    ]);
    expect(
      await titles(owner, 'work.time_in_status', 'active', {
        from: '2026-03-02',
        to: '2026-03-03',
        project: proj.tis,
      }),
    ).toEqual(['s1']);
    // The window length is bounded and its ends are real calendar dates.
    await expect(
      metric(owner, 'work.time_in_status', { from: '2024-01-01', to: '2026-03-03' }),
    ).rejects.toEqual(invalid('/to', 'too_long'));
    await expect(metric(owner, 'work.time_in_status', { from: '2026-02-30' })).rejects.toEqual(
      invalid('/from', 'invalid_date'),
    );
    await expect(
      metric(owner, 'work.time_in_status', { from: '2026-03-05', to: '2026-03-01' }),
    ).rejects.toEqual(invalid('/from', 'order'));
  });

  it('buckets created and completed by local day, across midnight and the spring clock change', async () => {
    for (const k of ['c1', 'c2', 'c3', 'c4', 'c5']) await mk(k, 'cvc');
    // c1 is created 00:30 local on the 11th (still the 10th in UTC); c2 22:30 local on the 10th.
    await setCreated('c1', '2026-03-10T23:30:00Z');
    await setCreated('c2', '2026-03-10T21:30:00Z');
    // Across the change to summer time (2026-03-29 02:00 -> 03:00): 23:59 local on the 30th is in the
    // window that ends on the 30th; one minute later is the 31st and is not.
    await setCreated('c4', '2026-03-30T21:59:00Z');
    await setCreated('c5', '2026-03-30T22:00:00Z');
    await spans('c1', [
      ['planned', '2026-03-10T23:30:00Z', '2026-03-11T22:30:00Z'],
      ['done', '2026-03-11T22:30:00Z', null],
    ]);
    await spans('c2', [['planned', '2026-03-10T21:30:00Z', null]]);
    await spans('c3', [
      ['planned', '2026-03-05T00:00:00Z', '2026-03-11T23:30:00Z'],
      ['done', '2026-03-11T23:30:00Z', null],
    ]);
    await spans('c4', [['planned', '2026-03-30T21:59:00Z', null]]);
    await spans('c5', [['planned', '2026-03-30T22:00:00Z', null]]);
    await sql(`UPDATE work.task SET created_at = '2026-03-05T00:00:00Z' WHERE id = $1`, [
      await idOf('c3'),
    ]);
    const r = await drillsAgree(owner, 'work.created_vs_completed', {
      from: '2026-03-10',
      to: '2026-03-12',
      project: proj.cvc,
    });
    const day = (d: string) => r.value.series.find((s: { day: string }) => s.day === d);
    expect(day('2026-03-10')).toEqual({ day: '2026-03-10', created: 1, completed: 0 });
    expect(day('2026-03-11')).toEqual({ day: '2026-03-11', created: 1, completed: 1 });
    expect(day('2026-03-12')).toEqual({ day: '2026-03-12', created: 0, completed: 1 });
    expect(r.value).toMatchObject({ created: 2, completed: 2, net: 0 });
    expect(r.parts).toEqual({ numerator: 2, denominator: 2 });
    // The window across the clock change holds c4 but not c5, and is 3 local days long.
    const dst = await drillsAgree(owner, 'work.created_vs_completed', {
      from: '2026-03-28',
      to: '2026-03-30',
      project: proj.cvc,
    });
    expect(dst.window).toEqual({ from: '2026-03-28', to: '2026-03-30', days: 3 });
    expect(dst.value.series.map((s: { day: string }) => s.day)).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
    ]);
    expect(dst.value.created).toBe(1);
    expect(
      await titles(owner, 'work.created_vs_completed', 'created', {
        from: '2026-03-28',
        to: '2026-03-30',
        project: proj.cvc,
      }),
    ).toEqual(['c4']);
    expect(dst.value.series.find((s: { day: string }) => s.day === '2026-03-30').created).toBe(1);
  });

  it('compares planned and completed work for tasks due in a window, by local date', async () => {
    for (const k of ['pc1', 'pc2', 'pc3', 'pc4', 'pc5', 'pc6', 'pc7'])
      await mk(k, 'pvc', {
        ...(k === 'pc1' ? { due_date: '2026-03-10' } : {}),
        ...(k === 'pc2' ? { due_date: '2026-03-20' } : {}),
        ...(k === 'pc3' ? { due_date: '2026-03-25' } : {}),
        ...(k === 'pc4' ? { due_date: '2026-03-31' } : {}),
        ...(k === 'pc5' ? { due_date: '2026-04-01' } : {}),
        ...(k === 'pc6' ? { due_date: '2026-03-12' } : {}),
      });
    await done('pc1');
    await done('pc2');
    await setStatus('pc6', 'cancelled');
    await sql(`UPDATE work.task SET completed_at = '2026-03-09T10:00:00Z' WHERE id = $1`, [
      await idOf('pc1'),
    ]);
    await sql(`UPDATE work.task SET completed_at = '2026-04-05T10:00:00Z' WHERE id = $1`, [
      await idOf('pc2'),
    ]);
    const q = { from: '2026-03-01', to: '2026-03-31', project: proj.pvc };
    const r = await drillsAgree(owner, 'work.planned_vs_completed', q);
    expect(r.value).toEqual({
      planned: 4,
      completed: 1,
      completed_late: 1,
      not_completed: 2,
      percent: 25,
    });
    expect(r.parts).toEqual({ numerator: 1, denominator: 4 });
    expect(r.incomplete).toEqual([expect.objectContaining({ code: 'undated_tasks', count: 1 })]);
    expect(await titles(owner, 'work.planned_vs_completed', 'not_completed', q)).toEqual([
      'pc3',
      'pc4',
    ]);
    expect(await titles(owner, 'work.planned_vs_completed', 'completed_late', q)).toEqual(['pc2']);
    // Past times cannot be reproduced for a metric that describes now.
    await expect(
      metric(owner, 'work.planned_vs_completed', { ...q, as_of: '2026-03-15T00:00:00Z' }),
    ).rejects.toEqual(invalid('/as_of', 'not_supported'));
  });

  it('bands the age of open tasks and reproduces it for a past instant', async () => {
    const ages: Array<[string, number]> = [
      ['g1', 3],
      ['g2', 10],
      ['g3', 20],
      ['g4', 45],
      ['g5', 100],
    ];
    const at = new Date('2026-04-30T12:00:00Z');
    for (const [k, days] of ages) {
      await mk(k, 'age');
      const created = new Date(at.getTime() - days * 86_400_000 - 3600_000).toISOString();
      await setCreated(k, created);
      await spans(k, [['planned', created, null]]);
    }
    await mk('g6', 'age');
    await setCreated('g6', '2026-04-30T13:00:00Z'); // created after the instant: not there yet
    await spans('g6', [['planned', '2026-04-30T13:00:00Z', null]]);
    const q = { as_of: at.toISOString(), project: proj.age };
    const r = await drillsAgree(owner, 'work.age', q);
    expect(r.value.open).toBe(5);
    expect(r.value.bands.map((b: { band: string; count: number }) => [b.band, b.count])).toEqual([
      ['band_0_7', 1],
      ['band_8_14', 1],
      ['band_15_30', 1],
      ['band_31_60', 1],
      ['band_61_plus', 1],
    ]);
    expect(r.value).toMatchObject({ median_days: 20, p85_days: 67, oldest_days: 100 });
    expect(r.as_of).toBe(at.toISOString());
    expect(r.reproducibility.historical).toBe(true);
    // A task that finished before the instant is not open then, and one that finished after it is.
    await spans('g3', [
      [
        'planned',
        new Date(at.getTime() - 20 * 86_400_000 - 3600_000).toISOString(),
        '2026-04-29T00:00:00Z',
      ],
      ['done', '2026-04-29T00:00:00Z', null],
    ]);
    await spans('g4', [
      [
        'planned',
        new Date(at.getTime() - 45 * 86_400_000 - 3600_000).toISOString(),
        '2026-05-02T00:00:00Z',
      ],
      ['done', '2026-05-02T00:00:00Z', null],
    ]);
    const later = await metric(owner, 'work.age', q);
    expect(later.value.open).toBe(4);
    expect(later.value.bands.find((b: { band: string }) => b.band === 'band_15_30').count).toBe(0);
    expect(later.value.bands.find((b: { band: string }) => b.band === 'band_31_60').count).toBe(1);
    // History that was assumed, not recorded, is labelled.
    await spans('g1', [['planned', '2026-04-27T10:00:00Z', null, 'assumed']]);
    const assumed = await metric(owner, 'work.age', q);
    expect(assumed.incomplete).toEqual([
      expect.objectContaining({ code: 'assumed_history', count: 1 }),
    ]);
    await expect(metric(owner, 'work.age', { as_of: '2999-01-01T00:00:00Z' })).rejects.toEqual(
      invalid('/as_of', 'invalid_date'),
    );
  });

  it('ranks workload by what the viewer can read, counting each task once and naming people only to members', async () => {
    const [w1, w2, w3, w4] = ['w1', 'w2', 'w3', 'w4'];
    await mk(w1!, 'load', { estimate_minutes: 120 });
    await mk(w2!, 'load', { estimate_minutes: 60 });
    await mk(w3!, 'load');
    await mk(w4!, 'load', { estimate_minutes: 45 });
    await mk('wv', 'vault', { estimate_minutes: 5000 });
    await assign(w1!, [owner]);
    await assign(w2!, [owner, editor]);
    await assign(w3!, [editor]);
    await assign('wv', [editor]);
    await env.svc.createEntry(
      owner,
      ws,
      {
        target: tsk.w1,
        started_at: '2026-09-14T09:00:00Z',
        ended_at: '2026-09-14T09:30:00Z',
        tz: 'Europe/Berlin',
      },
      mutation(),
    );
    const r = await drillsAgree(editor, 'work.workload', { project: proj.load });
    expect(r.value).toMatchObject({
      open: 4,
      remaining_minutes: 195,
      unestimated: 1,
      unassigned: { open: 1, remaining_minutes: 45 },
    });
    expect(
      r.groups.map(
        (g: {
          person: { id: string } | null;
          open: number;
          remaining_minutes: number;
          unestimated: number;
        }) => [g.person?.id, g.open, g.remaining_minutes, g.unestimated],
      ),
    ).toEqual([
      [await mem(owner), 2, 150, 0],
      [await mem(editor), 2, 60, 1],
    ]);
    // The hidden vault task assigned to the editor adds to nobody's figures for the editor to see.
    const everything = await metric(owner, 'work.workload', {});
    expect(everything.value.open).toBeGreaterThan(r.value.open - 1);
    expect(
      await titles(editor, 'work.workload', 'open', {
        project: proj.load,
        person: await mem(owner),
      }),
    ).toEqual(['w1', 'w2']);
    // A guest sees tasks, never people.
    const guest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: tsk.w1, level: 'read' }],
    });
    const g = await metric(guest, 'work.workload', {});
    expect(g.groups).toEqual([]);
    expect(g.value.unassigned).toBeNull();
    expect(g.incomplete.map((i: { code: string }) => i.code)).toContain('people_hidden');
    await expect(
      records(guest, 'work.workload', 'open', { person: await mem(owner) }),
    ).rejects.toEqual(invalid('/person', 'unavailable'));
    const a = await metric(guest, 'work.attention', {});
    expect(a.value.unassigned).toBeNull();
    expect(a.incomplete.map((i: { code: string }) => i.code)).toContain('owner_unknown');
    await expect(records(guest, 'work.attention', 'unassigned')).rejects.toEqual(
      invalid('/member', 'invalid_option'),
    );
  });

  it('flags overdue, due soon, blocked, stale, and unowned open work, and drills to the same tasks', async () => {
    const today = localDay(new Date(), 'Europe/Berlin');
    await mk('x1', 'att', { due_date: '2026-01-01' });
    await mk('x2', 'att', { due_date: addDays(today, 3) });
    await mk('x3', 'att', { due_date: today });
    await mk('x4', 'att', { status: 'in_progress' });
    await mk('x5', 'att');
    await mk('x6', 'att');
    await mk('x7', 'att');
    await mk('x8', 'att', { due_date: '2026-01-01' });
    await done('x8');
    for (const k of ['x1', 'x2', 'x3', 'x4', 'x5', 'x6']) await assign(k, [owner]);
    await env.svc.addRelationship(
      owner,
      ws,
      tsk.x1!,
      { kind: 'blocks', target: tsk.x6! },
      mutation(),
    );
    await sql(
      `UPDATE work.task SET last_meaningful_update_at = now() - interval '30 days' WHERE id = $1`,
      [await idOf('x4')],
    );
    await sql(
      `UPDATE work.task SET last_meaningful_update_at = now() - interval '20 days' WHERE id = $1`,
      [await idOf('x5')],
    );
    const r = await drillsAgree(editor, 'work.attention', { project: proj.att });
    expect(r.value).toMatchObject({
      open: 7,
      overdue: 1,
      due_soon: 2,
      blocked: 1,
      stale: 2,
      unassigned: 1,
    });
    expect(r.value.thresholds).toEqual({
      due_soon_days: 7,
      stale_active_days: 7,
      stale_planned_days: 14,
    });
    expect(await titles(editor, 'work.attention', 'overdue', { project: proj.att })).toEqual([
      'x1',
    ]);
    expect(await titles(editor, 'work.attention', 'due_soon', { project: proj.att })).toEqual([
      'x2',
      'x3',
    ]);
    expect(await titles(editor, 'work.attention', 'stale', { project: proj.att })).toEqual([
      'x4',
      'x5',
    ]);
    expect(await titles(editor, 'work.attention', 'unassigned', { project: proj.att })).toEqual([
      'x7',
    ]);
    // Finishing the blocker clears the blocked signal at once, and a done task is never overdue.
    await done('x1');
    const after = await metric(editor, 'work.attention', { project: proj.att });
    expect(after.value).toMatchObject({ open: 6, overdue: 0, blocked: 0 });
  });

  it('compares estimates with logged time for tasks finished in a window', async () => {
    const win = ['2026-03-10T10:00:00Z', null] as const;
    for (const [k, est] of [
      ['u1', 60],
      ['u2', 120],
      ['u3', undefined],
      ['u4', 30],
    ] as const) {
      await mk(k, 'act', est ? { estimate_minutes: est } : {});
      await spans(k, [
        ['planned', '2026-03-09T00:00:00Z', win[0]],
        ['done', win[0], win[1]],
      ]);
    }
    const log = (key: string, minutes: number, day: string) =>
      env.svc.createEntry(
        owner,
        ws,
        {
          target: tsk[key],
          started_at: `${day}T09:00:00Z`,
          ended_at: new Date(Date.parse(`${day}T09:00:00Z`) + minutes * 60_000).toISOString(),
          tz: 'Europe/Berlin',
        },
        mutation(),
      );
    await log('u1', 90, '2026-03-02');
    await log('u2', 60, '2026-03-03');
    await log('u3', 30, '2026-03-04');
    const q = { from: '2026-03-01', to: '2026-03-31', project: proj.act };
    const r = await drillsAgree(owner, 'time.planned_vs_actual', q);
    expect(r.value).toEqual({
      tasks_compared: 3,
      planned_minutes: 210,
      actual_minutes: 150,
      variance_minutes: -60,
      variance_percent: -29,
    });
    expect(r.incomplete.map((i: { code: string; count: number }) => [i.code, i.count])).toEqual([
      ['unestimated_tasks', 1],
      ['no_time_logged', 1],
    ]);
    expect(await titles(owner, 'time.planned_vs_actual', 'unestimated', q)).toEqual(['u3']);
  });

  it('judges project health by the 5B rules, with the reasons, and counts the classes', async () => {
    const day = (n: number) => addDays(localDay(new Date(), 'Europe/Berlin'), n);
    const mkProject = async (
      key: string,
      status: string | null,
      fields: Record<string, string>,
    ) => {
      const p = (
        await env.svc.createProject(
          owner,
          ws,
          { brand: brands.Harbor, name: key, ...fields },
          mutation(),
        )
      ).data;
      proj[key] = p.id;
      if (status) {
        const path =
          status === 'completed' ? ['planned', 'active', 'completed'] : ['planned', status];
        let cur = p;
        for (let i = 1; i < path.length; i++)
          cur = (
            await env.svc.updateProject(
              owner,
              ws,
              cur.id,
              { version: cur.version, changes: { status: { base: path[i - 1], value: path[i] } } },
              mutation({ ifMatch: `"${cur.version}"` }),
            )
          ).data;
      }
    };
    await mkProject('late', 'active', { deadline_date: day(-5) });
    await mkProject('fine', 'active', { target_date: day(30) });
    await mkProject('bare', null, {});
    await mkProject('won', 'completed', {});
    await mk('h1', 'fine');
    const h = await drillsAgree(editor, 'project.health', { brand: brands.Harbor });
    const by = Object.fromEntries(
      h.groups.map((g: { project: { name: string }; health: string }) => [
        g.project.name,
        g.health,
      ]),
    );
    expect(by).toMatchObject({ late: 'off_track', fine: 'on_track', won: 'complete' });
    expect(h.value.classes.off_track).toBeGreaterThanOrEqual(1);
    expect(h.value.classes.complete).toBeGreaterThanOrEqual(1);
    const late = h.groups.find((g: { project: { name: string } }) => g.project.name === 'late');
    expect(late.reasons).toEqual([
      expect.objectContaining({ code: 'deadline_passed', severity: 'off_track' }),
    ]);
    expect(
      h.groups.find((g: { project: { name: string } }) => g.project.name === 'Vault'),
    ).toBeUndefined();
    expect(await titles(editor, 'project.health', 'off_track', { brand: brands.Harbor })).toContain(
      'late',
    );
    // The declared health is never overwritten: this is a second, explained opinion.
    expect(h.limits.join(' ')).toMatch(/can read/);
  });

  it('measures time-budget use per project and acceptance by review state', async () => {
    await sql(
      `UPDATE work.project SET time_budget_minutes = 100 WHERE id = (SELECT id FROM core.record WHERE public_id = '${proj.budget}')`,
    );
    await mk('b1', 'budget');
    await env.svc.createEntry(
      owner,
      ws,
      {
        target: tsk.b1,
        started_at: '2026-03-12T09:00:00Z',
        ended_at: '2026-03-12T11:00:00Z',
        tz: 'Europe/Berlin',
      },
      mutation(),
    );
    const b = await drillsAgree(editor, 'cost.time_budget', { project: proj.budget });
    expect(b.value).toMatchObject({
      percent: 120,
      budget_minutes: 100,
      logged_minutes: 120,
      projects: { budgeted: 1, over_budget: 1, no_budget: 0 },
    });
    expect(
      await titles(editor, 'cost.time_budget', 'over_budget', { project: proj.budget }),
    ).toEqual(['P budget']);

    await mk('d1', 'dlv');
    const mkDeliverable = async (title: string, state: string) => {
      const d = (await env.svc.createDeliverable(owner, ws, tsk.d1!, { title }, mutation())).data;
      if (state === 'accepted') {
        const id = (await sql(`SELECT id FROM core.record WHERE public_id = $1`, [d.id]))[0]!.id;
        const v = (
          await sql(
            `INSERT INTO files.deliverable_version (id, workspace_id, deliverable_id, version_number, source_kind, url, state, submitted_by_membership_id)
           SELECT gen_random_uuid(), workspace_id, id, 1, 'url', 'https://example.com/x', 'draft', created_by_membership_id FROM files.deliverable WHERE id = $1 RETURNING id`,
            [id],
          )
        )[0]!.id;
        await sql(
          `UPDATE files.deliverable SET state = 'accepted', accepted_version_id = $2, current_version_id = $2 WHERE id = $1`,
          [id, v],
        );
      } else if (state !== 'draft')
        await sql(
          `UPDATE files.deliverable SET state = $2 WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
          [d.id, state],
        );
    };
    for (const [t, s] of [
      ['one', 'draft'],
      ['two', 'ready_for_review'],
      ['three', 'changes_requested'],
      ['four', 'accepted'],
      ['five', 'accepted'],
      ['six', 'rejected'],
    ] as const)
      await mkDeliverable(t, s);
    const r = await drillsAgree(editor, 'deliverable.acceptance', { project: proj.dlv });
    expect(r.value).toEqual({
      draft: 1,
      ready_for_review: 1,
      changes_requested: 1,
      accepted: 2,
      rejected: 1,
      submitted: 5,
      accepted_percent: 40,
    });
    expect(r.parts).toEqual({ numerator: 2, denominator: 5 });
    expect(r.incomplete).toEqual([expect.objectContaining({ code: 'drafts_excluded', count: 1 })]);
    const items = (
      await records(editor, 'deliverable.acceptance', 'accepted', { project: proj.dlv })
    ).items;
    expect(items.map((i: { title: string }) => i.title).sort()).toEqual(['five', 'four']);
    expect(items[0].host).toMatchObject({ type: 'task' });
    // A trashed deliverable is no longer counted.
    await env.svc.taskLifecycle(owner, ws, tsk.d1!, 'trash', {}, mutation());
    expect((await metric(editor, 'deliverable.acceptance', { project: proj.dlv })).state).toBe(
      'empty',
    );
  });

  it('reports sources that do not exist yet as unavailable, never as zero', async () => {
    for (const [id, phase] of [
      ['quality.tests', '9B'],
      ['cost.spend', '7A'],
    ] as const) {
      const r = await metric(editor, id);
      expect(r.state).toBe('unavailable');
      expect(r.value).toBeNull();
      expect(r.unavailable).toMatchObject({ phase });
      expect(r.drill.members).toEqual([]);
      await expect(records(editor, id, 'x')).rejects.toEqual(invalid('/member', 'invalid_option'));
    }
  });

  it('refuses scopes a metric cannot take and bad parameters, with one stable code each', async () => {
    await expect(metric(editor, 'work.cycle_time', { brand: 'nope' })).rejects.toEqual(
      invalid('/brand', 'invalid_option'),
    );
    await expect(metric(editor, 'project.completion', { project: 'nope' })).rejects.toEqual(
      invalid('/project', 'invalid_option'),
    );
    await expect(metric(editor, 'project.completion', { subprojects: 'maybe' })).rejects.toEqual(
      invalid('/subprojects', 'invalid_option'),
    );
    await expect(records(editor, 'project.completion', 'wrong')).rejects.toEqual(
      invalid('/member', 'invalid_option'),
    );
    await expect(
      env.svc.getMetricRecords(editor, ws, 'project.completion', {
        limit: 5000,
        member: 'numerator',
      }),
    ).rejects.toEqual(invalid('/limit', 'invalid_option'));
    await expect(
      env.svc.getMetricRecords(editor, ws, 'project.completion', {
        member: 'numerator',
        cursor: 'garbage',
      }),
    ).rejects.toEqual(reason('cursor_invalid'));
  });
});
