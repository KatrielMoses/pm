import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { cleanupWorkspaceViews, type Caller } from '@pm/tenancy';
import {
  addDays,
  DEFAULT_WORK_SETTINGS,
  isoWeekday,
  localDay,
  periodOf,
  timerGuardHandler,
} from '@pm/work';
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

type Who =
  | 'owner'
  | 'administrator'
  | 'member'
  | 'manager'
  | 'limited_member'
  | 'read_only'
  | 'share_only'
  | 'guest'
  | 'suspended'
  | 'removed';
const VIEWERS: Who[] = [
  'administrator',
  'member',
  'manager',
  'limited_member',
  'read_only',
  'share_only',
  'guest',
];
const UNKNOWN = {
  task: 'tsk_00000000000000000000000000',
  view: 'view_00000000000000000000000000',
  entry: 'te_00000000000000000000000000',
  block: 'blk_00000000000000000000000000',
  timeOff: 'tof_00000000000000000000000000',
  sheet: 'tsh_00000000000000000000000000',
  member: 'mem_00000000000000000000000000',
  brand: 'br_00000000000000000000000000',
  reservation: 'rsv_00000000000000000000000000',
  project: 'prj_00000000000000000000000000',
};
const reason = (code: string) => expect.objectContaining({ code });
const issueOf = (code: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });
const ifMatch = (v: number) => mutation({ ifMatch: `"${v}"` });
const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));

/**
 * Phase 3 integration matrix (exit gate): two workspaces; owner, administrator, member, a brand
 * manager, limited and read-only members, a share-only member, a guest, a suspended and a removed
 * member; a sensitive brand, a restricted project, and hidden tasks carrying time, plans,
 * reservations, and a holiday. Every Phase 3 surface — saved-view queries, groups, totals, and
 * exports; workload, Gantt, milestones, portfolio, timesheet, and activity layouts; Today and work
 * blocks; time entries, timesheets, approvals, reports, and exports; capacity, reservations,
 * holidays, time off, and conflicts — agrees with the one read decision and never names a hidden
 * record. Suspension and removal stop the person and their background work; concurrent edits have
 * one winner; permission lost between read and write is refused; replays never double effects;
 * hidden and unknown identifiers fail the same way.
 */
describe('Phase 3 cross-surface authorization matrix', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let ws: string;
  let wsId: string;
  const P = {} as Record<Who, Caller>;
  const M = {} as Record<Who, string>;
  let main: string;
  let secret: string;
  let restrictedProject: string;
  let openProject: string;
  const T = {} as Record<'open' | 'restricted' | 'secret' | 'shared' | 'race', string>;
  let statuses: string[];
  let today: string;
  let week: string;
  let past: string;
  let tsWeek: string;
  let ownerView: string;
  let sharedView: string;
  let hiddenEntries: string[];
  let secretReservation: string;
  let memberSheet: string;
  let ownerSheet: string;
  // Workspace B (cross-workspace identifiers).
  const B = {} as Record<
    'ws' | 'owner_task' | 'view' | 'entry' | 'block' | 'time_off' | 'reservation' | 'brand',
    string
  > & { owner: Caller };

  /** Names and identifiers only the owner may ever see. */
  const hidden = () => [
    T.restricted,
    T.secret,
    'Vault zeta',
    'Omega classified',
    secret,
    'Covert A',
    restrictedProject,
    'Restricted A',
    ownerView,
    'Owner omega view',
    'Omega holiday',
    secretReservation,
    ...hiddenEntries,
  ];

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    today = localDay(new Date(), 'UTC');
    past = addDays(today, -2);
    week = addDays(today, 7 + ((8 - isoWeekday(today)) % 7));
    tsWeek = periodOf(addDays(today, -21), 1).start;

    const o = await seedAccount(db);
    const created = await env.svc.createWorkspace(
      o,
      { ...WORKSPACE_INPUT, name: 'Matrix three', first_brand: { name: 'Main A' } },
      mutation(),
    );
    ws = created.data.workspace.id;
    wsId = await workspaceIdOf(db, ws);
    main = created.data.first_brand!.id;
    secret = (await env.svc.createBrand(o, ws, { name: 'Covert A' }, mutation())).data.id;
    env.stepUp.allow = true;
    await env.svc.setSensitivity(
      o,
      ws,
      secret,
      { is_sensitive: true },
      mutation({ ifMatch: '"0"', stepUpToken: 't' }),
    );
    env.stepUp.allow = false;
    P.owner = o;
    P.administrator = await join(env, db, o, ws, { kind: 'member', role: 'administrator' });
    for (const who of ['member', 'manager', 'share_only', 'suspended', 'removed'] as const)
      P[who] = await join(env, db, o, ws, { kind: 'member', role: 'member' });
    P.limited_member = await join(env, db, o, ws, { kind: 'member', role: 'limited_member' });
    P.read_only = await join(env, db, o, ws, { kind: 'member', role: 'read_only' });
    for (const who of Object.keys(P) as Who[])
      M[who] = (await membershipOf(db, wsId, P[who].auth.account.id))!.public_id;
    const grant = (who: Who, brand: string, level: string) =>
      apply(env, o, ws, { kind: 'brand_grant', brand, principal: M[who], level });
    await grant('owner', secret, 'manage');
    await grant('member', main, 'edit');
    await grant('manager', main, 'manage');
    await grant('limited_member', main, 'view');
    await grant('read_only', main, 'view');
    await grant('suspended', main, 'edit');
    await grant('removed', main, 'edit');

    const wf = (
      await env.svc.createWorkflow(
        o,
        ws,
        {
          scope: `brand:${main}`,
          record_kind: 'task',
          name: 'Studio',
          statuses: [
            { name: 'Queued', category: 'planned' },
            { name: 'Making', category: 'active' },
            { name: 'Review', category: 'active' },
            { name: 'Shipped', category: 'done' },
          ],
        },
        mutation(),
      )
    ).data;
    statuses = wf.statuses.map((s: { id: string }) => s.id);

    openProject = (
      await env.svc.createProject(o, ws, { brand: main, name: 'Launch A' }, mutation())
    ).data.id;
    restrictedProject = (
      await env.svc.createProject(o, ws, { brand: main, name: 'Restricted A' }, mutation())
    ).data.id;
    await env.svc.setAccess(
      o,
      ws,
      restrictedProject,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    await env.svc.createMilestone(
      o,
      ws,
      openProject,
      { name: 'Beta A', due_date: addDays(week, 3) },
      mutation(),
    );
    await env.svc.createMilestone(
      o,
      ws,
      restrictedProject,
      { name: 'Vault zeta milestone', due_date: addDays(week, 3) },
      mutation(),
    );
    const task = async (body: Record<string, unknown>) =>
      (await env.svc.createTask(o, ws, body, mutation())).data;
    const due = { due_date: addDays(week, 1), estimate_minutes: 120 };
    T.open = (await task({ project: openProject, title: 'Quarterly report', ...due })).id;
    T.restricted = (await task({ project: restrictedProject, title: 'Vault zeta', ...due })).id;
    T.secret = (await task({ brand: secret, title: 'Omega classified', ...due })).id;
    T.shared = (await task({ brand: main, title: 'Shared brief', ...due })).id;
    T.race = (await task({ brand: main, title: 'Race target' })).id;
    // The member is assigned everything (hidden work must still never be counted for them).
    for (const k of ['open', 'restricted', 'secret', 'shared'] as const) {
      const v = (await env.svc.getTask(o, ws, T[k])).version;
      await env.svc.setAssignees(
        o,
        ws,
        T[k],
        { assignees: [M.member], primary: M.member, version: v },
        mutation(),
      );
    }
    await env.svc.addRelationship(
      o,
      ws,
      T.restricted,
      { kind: 'blocks', target: T.open },
      mutation(),
    );
    await apply(env, o, ws, {
      kind: 'record_share',
      record: T.shared,
      grantee: M.share_only,
      level: 'edit',
    });
    P.guest = await join(env, db, o, ws, {
      kind: 'guest',
      records: [{ record: T.shared, level: 'comment' }],
    });
    M.guest = (await membershipOf(db, wsId, P.guest.auth.account.id))!.public_id;

    // Saved views: a personal owner view naming the secret brand; a workspace-shared view.
    ownerView = (
      await env.svc.createView(
        o,
        ws,
        {
          name: 'Owner omega view',
          query: {
            entity: 'task',
            filter: { op: 'and', items: [{ field: 'brand', op: 'in', value: [secret] }] },
          },
        },
        mutation(),
      )
    ).data.id;
    sharedView = (
      await env.svc.createView(
        o,
        ws,
        { name: 'Everything', layout: 'board', query: { entity: 'task' } },
        mutation(),
      )
    ).data.id;
    await env.svc.shareView(o, ws, sharedView, { scope: 'workspace', version: 0 }, mutation());

    // Time: the owner logs on hidden work and on the shared task; the member on readable work.
    const log = (as: Caller, target: string, day: string, minutes: number) =>
      env.svc
        .createEntry(as, ws, { target, work_date: day, duration_minutes: minutes }, mutation())
        .then((r) => r.data.id);
    hiddenEntries = [
      await log(o, T.restricted, past, 30),
      await log(o, T.secret, past, 40),
      await log(o, T.restricted, tsWeek, 30),
      await log(o, T.secret, tsWeek, 40),
    ];
    await log(o, T.shared, past, 15);
    await log(P.member, T.open, past, 25);
    await log(P.member, T.open, tsWeek, 60);
    memberSheet = (
      await env.svc.submitTimesheet(P.member, ws, { period_start: tsWeek }, mutation())
    ).data.id;
    ownerSheet = (await env.svc.submitTimesheet(o, ws, { period_start: tsWeek }, mutation())).data
      .id;

    // Today and blocks: the owner plans hidden work; the member plans readable work.
    await env.svc.commit(o, ws, today, { task: T.secret }, mutation());
    await env.svc.createBlock(
      o,
      ws,
      { tz: 'UTC', task: T.restricted, starts_at: `${week}T09:00:00Z`, duration_minutes: 60 },
      mutation(),
    );
    await env.svc.commit(P.member, ws, today, { task: T.open }, mutation());
    await env.svc.createBlock(
      P.member,
      ws,
      { tz: 'UTC', task: T.open, starts_at: `${addDays(week, 1)}T09:00:00Z`, duration_minutes: 60 },
      mutation(),
    );

    // Capacity: the member works weekdays; reservations in both brands; a holiday on each brand.
    await env.svc.setMyCapacityProfile(P.member, ws, { windows: WEEKDAYS }, ifMatch(0));
    secretReservation = (
      await env.svc.setReservation(
        o,
        ws,
        { brand: secret, member: M.member, minutes_per_week: 600, effective_from: week },
        mutation(),
      )
    ).data.id;
    await env.svc.setReservation(
      P.manager,
      ws,
      { brand: main, member: M.member, minutes_per_week: 900, effective_from: week },
      mutation(),
    );
    await env.svc.createHoliday(
      o,
      ws,
      secret,
      { day: addDays(week, 4), name: 'Omega holiday' },
      mutation(),
    );
    await env.svc.createHoliday(
      o,
      ws,
      main,
      { day: addDays(week, 3), name: 'Main day off' },
      mutation(),
    );
    await env.svc.createTimeOff(
      P.member,
      ws,
      { kind: 'vacation', all_day: true, starts_on: addDays(week, 2), label: 'Private trip' },
      mutation(),
    );

    // Workspace B.
    const bo = await seedAccount(db);
    const bc = await env.svc.createWorkspace(
      bo,
      { ...WORKSPACE_INPUT, name: 'Matrix other', first_brand: { name: 'Main B' } },
      mutation(),
    );
    B.owner = bo;
    B.ws = bc.data.workspace.id;
    B.brand = bc.data.first_brand!.id;
    B.owner_task = (
      await env.svc.createTask(bo, B.ws, { brand: B.brand, title: 'Only in B' }, mutation())
    ).data.id;
    B.view = (
      await env.svc.createView(bo, B.ws, { name: 'B view', query: { entity: 'task' } }, mutation())
    ).data.id;
    B.entry = (
      await env.svc.createEntry(
        bo,
        B.ws,
        { target: B.owner_task, work_date: past, duration_minutes: 10 },
        mutation(),
      )
    ).data.id;
    B.block = (
      await env.svc.createBlock(
        bo,
        B.ws,
        { tz: 'UTC', title: 'B block', starts_at: `${week}T09:00:00Z`, duration_minutes: 30 },
        mutation(),
      )
    ).data.id;
    B.time_off = (await env.svc.createTimeOff(bo, B.ws, { starts_on: week }, mutation())).data.id;
    const bm = (await membershipOf(db, await workspaceIdOf(db, B.ws), bo.auth.account.id))!
      .public_id;
    B.reservation = (
      await env.svc.setReservation(
        bo,
        B.ws,
        { brand: B.brand, member: bm, minutes_per_week: 60, effective_from: week },
        mutation(),
      )
    ).data.id;
  }, 300_000);
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  /** Every Phase 3 read a person can make; a refusal is recorded as its error code. */
  const surfaces = async (c: Caller) => {
    const out: Record<string, unknown> = {};
    const all = { entity: 'task' };
    const ids = Object.values(T);
    const probes: Record<string, () => Promise<unknown>> = {
      query: () =>
        env.svc.query(c, ws, 'task', {
          query: { entity: 'task', group: { field: 'brand' } },
          presentation: { columns: ['title', 'brand', 'project', 'status'] },
          include_total: true,
          limit: 200,
        }),
      queryProjects: () =>
        env.svc.query(c, ws, 'project', { query: { entity: 'project' }, include_total: true }),
      sharedViewRun: async () =>
        env.svc.query(c, ws, 'task', {
          query: (await env.svc.getView(c, ws, sharedView)).query,
          include_total: true,
        }),
      exportView: () =>
        env.svc.exportView(c, ws, 'task', {
          query: { entity: 'task' },
          presentation: { columns: ['title', 'brand', 'project'] },
        }),
      listViews: () => env.svc.listViews(c, ws, {}),
      workload: () =>
        env.svc.workload(c, ws, {
          query: all,
          bucket: 'week',
          from: week,
          to: addDays(week, 13),
        }),
      dependencies: () => env.svc.dependencies(c, ws, { query: all, ids }),
      milestones: () =>
        env.svc.milestones(c, ws, {
          query: { entity: 'project' },
          ids: [openProject, restrictedProject],
        }),
      progress: () =>
        env.svc.progress(c, ws, {
          query: { entity: 'project' },
          ids: [openProject, restrictedProject],
        }),
      myTime: () => env.svc.myTime(c, ws, { query: all, ids, from: addDays(today, -6), days: 7 }),
      activity: () => env.svc.activity(c, ws, 'task', { query: all, limit: 200 }),
      activityProjects: () =>
        env.svc.activity(c, ws, 'project', { query: { entity: 'project' }, limit: 200 }),
      today: () => env.svc.todayView(c, ws, today),
      todayWeek: () => env.svc.todayView(c, ws, addDays(week, 1)),
      blocks: () => env.svc.listBlocks(c, ws, { from: week, to: addDays(week, 6) }),
      dailyRecords: () => env.svc.dailyRecords(c, ws, {}),
      entries: () => env.svc.listEntries(c, ws, {}),
      timeByBrand: () =>
        env.svc.timeReport(c, ws, { from: addDays(today, -30), to: today, group: 'brand' }),
      timeByMember: () =>
        env.svc.timeReport(c, ws, { from: addDays(today, -30), to: today, group: 'member' }),
      timeByTask: () =>
        env.svc.timeReport(c, ws, { from: addDays(today, -30), to: today, group: 'task' }),
      timeExport: () =>
        env.svc.exportTime(c, ws, { from: addDays(today, -30), to: today, format: 'json' }),
      period: () => env.svc.timesheetPeriod(c, ws, { date: tsWeek }),
      approvals: () => env.svc.listTimesheetApprovals(c, ws, {}),
      memberSheet: () => env.svc.getTimesheet(c, ws, memberSheet),
      ownerSheet: () => env.svc.getTimesheet(c, ws, ownerSheet),
      summaryProject: () => env.svc.workSummary(c, ws, openProject),
      capacityMe: () => env.svc.personCapacity(c, ws, { from: week, to: addDays(week, 6) }),
      capacityMember: () =>
        env.svc.personCapacity(c, ws, { member: M.member, from: week, to: addDays(week, 6) }),
      team: () => env.svc.teamCapacity(c, ws, { from: week, to: addDays(week, 6) }),
      reservations: () => env.svc.listReservations(c, ws, {}),
      holidaysMain: () => env.svc.listHolidays(c, ws, main, {}),
      timeOff: () => env.svc.listTimeOff(c, ws, { from: week, to: addDays(week, 6) }),
      rescheduling: () => env.svc.reschedulingInputs(c, ws, { from: week, to: addDays(week, 6) }),
    };
    for (const [k, fn] of Object.entries(probes))
      out[k] = await fn().catch((e: { code?: string }) => ({ refused: e.code ?? String(e) }));
    return out;
  };
  const refused = (v: unknown) => (v as { refused?: string }).refused;

  it('every Phase 3 surface agrees with the one read decision and never names hidden work', async () => {
    const markers = hidden();
    const owner = await surfaces(P.owner);
    // The owner sees everything, so every marker is reachable (the probes are meaningful).
    const ownerJson = JSON.stringify(owner);
    for (const m of [T.restricted, T.secret, 'Vault zeta', 'Omega classified', 'Covert A'])
      expect(ownerJson, m).toContain(m);
    for (const who of VIEWERS) {
      const s = await surfaces(P[who]);
      const json = JSON.stringify(s);
      for (const m of markers) expect(json, `${who} leaks ${m}`).not.toContain(m);
      // No surface crashes: every refusal is a typed authorization or validation outcome.
      for (const [k, v] of Object.entries(s))
        if (refused(v))
          expect(['forbidden', 'not_found', 'validation_failed'], `${who} ${k}`).toContain(
            refused(v),
          );
      // Rows, groups, and totals use one predicate: group counts sum to the total and the rows.
      const q = s.query as {
        data: Array<{ id: string }>;
        groups: Array<{ count: number }>;
        page: { total: { value: number } };
      };
      const readable = [
        'administrator',
        'member',
        'manager',
        'limited_member',
        'read_only',
      ].includes(who)
        ? [T.open, T.shared, T.race]
        : [T.shared];
      expect(q.data.map((r) => r.id).sort(), who).toEqual([...readable].sort());
      expect(
        q.groups.reduce((n, g) => n + g.count, 0),
        who,
      ).toBe(q.page.total.value);
      expect(q.page.total.value, who).toBe(readable.length);
    }
  });

  it('share-only members and guests see no capacity, no history, and no brand-wide aggregates', async () => {
    for (const who of ['share_only', 'guest'] as const) {
      const s = await surfaces(P[who]);
      // History is outside a share (AZ-22 shares:false): no activity at all.
      expect((s.activity as { data: unknown[] }).data, who).toEqual([]);
      // Other people's capacity is not_found; team capacity is forbidden.
      expect(refused(s.capacityMember), who).toBe('not_found');
      expect(refused(s.team), who).toBe('forbidden');
      expect(JSON.stringify(s.reservations), who).not.toContain(M.member);
      // No brand-wide holidays, approvals, or project roll-ups.
      expect(refused(s.holidaysMain), who).toBe('not_found');
      expect((s.approvals as { data: unknown[] }).data, who).toEqual([]);
      expect(refused(s.summaryProject), who).toBe('not_found');
      expect(refused(s.memberSheet), who).toBe('not_found');
      expect(JSON.stringify(s.workload), who).not.toContain('"capacity":{');
      expect(JSON.stringify(s.progress), who).not.toContain(openProject);
      expect((s.query as { groups: unknown[] }).groups, who).toHaveLength(1);
    }
    // A guest reads only their own time: nobody else's minutes on the shared task.
    const g = await surfaces(P.guest);
    expect((g.timeByBrand as { totals: { actual_seconds: number } }).totals.actual_seconds).toBe(0);
    expect((g.entries as { data: unknown[] }).data).toEqual([]);
    expect(JSON.stringify(g.timeByMember)).not.toContain(M.owner);
  });

  it('capacity reads name only readable brands; others see minutes, never kinds, labels, or hidden reservations', async () => {
    const own = await env.svc.personCapacity(P.member, ws, { from: week, to: addDays(week, 6) });
    // The member's own capacity: the Main reservation, never the sensitive brand's.
    expect(own.brands.map((b: { brand: { name: string } }) => b.brand.name)).toEqual(['Main A']);
    expect(JSON.stringify(own)).not.toMatch(/Covert|Omega|Vault zeta/);
    // Hidden tasks assigned to the member are never counted in their estimates.
    const estimated = own.days.reduce(
      (n: number, d: { estimated_minutes: number }) => n + d.estimated_minutes,
      0,
    );
    expect(estimated).toBe(120 + 120); // open + shared (restricted and secret are hidden)
    const byManager = JSON.stringify(
      await env.svc.personCapacity(P.manager, ws, {
        member: M.member,
        from: week,
        to: addDays(week, 6),
      }),
    );
    expect(byManager).not.toMatch(/Private trip|vacation|Covert|Omega/);
    // The plain member has no capacity.view: another person is unknown.
    await expect(
      env.svc.personCapacity(P.limited_member, ws, { member: M.member }),
    ).rejects.toEqual(reason('not_found'));
    // Holidays of an unreadable brand are not_found, exactly like an unknown brand.
    for (const who of VIEWERS) {
      const a = await env.svc.listHolidays(P[who], ws, secret, {}).catch((e) => e.code);
      const b = await env.svc.listHolidays(P[who], ws, UNKNOWN.brand, {}).catch((e) => e.code);
      expect(a, who).toBe('not_found');
      expect(b, who).toBe(a);
    }
    // Reservations: the manager sees Main only; the administrator never sees the sensitive brand.
    for (const who of ['manager', 'administrator'] as const) {
      const r = await env.svc.listReservations(P[who], ws, {});
      expect(
        r.data.map((x: { brand: { name: string } }) => x.brand.name),
        who,
      ).toEqual(['Main A']);
    }
  });

  it('workspaces never cross: Phase 3 identifiers from another workspace are not_found', async () => {
    const o = P.owner;
    const nf = reason('not_found');
    for (const call of [
      () => env.svc.getView(o, ws, B.view),
      () => env.svc.updateView(o, ws, B.view, { name: 'x', version: 0 }, mutation()),
      () => env.svc.getEntry(o, ws, B.entry),
      () => env.svc.updateEntry(o, ws, B.entry, { billable: true }, ifMatch(0)),
      () => env.svc.updateBlock(o, ws, B.block, { locked: true }, ifMatch(0)),
      () => env.svc.deleteBlock(o, ws, B.block, ifMatch(0)),
      () => env.svc.updateTimeOff(o, ws, B.time_off, { label: 'x' }, ifMatch(0)),
      () => env.svc.deleteReservation(o, ws, B.reservation, mutation()),
      () => env.svc.commit(o, ws, today, { task: B.owner_task }, mutation()),
      () =>
        env.svc.createEntry(
          o,
          ws,
          { target: B.owner_task, work_date: past, duration_minutes: 5 },
          mutation(),
        ),
      () => env.svc.startTimer(o, ws, { target: B.owner_task }, mutation()),
      () => env.svc.workSummary(o, ws, B.owner_task),
      () => env.svc.listHolidays(o, ws, B.brand, {}),
      () =>
        env.svc.createBlock(
          o,
          ws,
          { tz: 'UTC', task: B.owner_task, starts_at: `${week}T15:00:00Z`, duration_minutes: 30 },
          mutation(),
        ),
    ])
      await expect(call()).rejects.toEqual(nf);
    // A person from workspace A is unknown in workspace A's capacity reads when they belong to B.
    const bm = (await membershipOf(db, await workspaceIdOf(db, B.ws), B.owner.auth.account.id))!
      .public_id;
    await expect(env.svc.personCapacity(o, ws, { member: bm })).rejects.toEqual(nf);
    // Layout reads with B's ids return nothing, like unknown ids.
    const dep = await env.svc.dependencies(o, ws, {
      query: { entity: 'task' },
      ids: [B.owner_task],
    });
    expect(dep).toEqual(
      await env.svc.dependencies(o, ws, { query: { entity: 'task' }, ids: [UNKNOWN.task] }),
    );
    // A's owner is not a member of B at all.
    await expect(env.svc.todayView(o, B.ws, today)).rejects.toEqual(nf);
  });

  it('hidden and unknown identifiers return the same error on every Phase 3 route', async () => {
    const m = P.member;
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: { code?: string }) => e.code,
      );
    const pairs: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
      [
        'getView',
        () => env.svc.getView(m, ws, ownerView),
        () => env.svc.getView(m, ws, UNKNOWN.view),
      ],
      [
        'updateView',
        () => env.svc.updateView(m, ws, ownerView, { name: 'x', version: 0 }, mutation()),
        () => env.svc.updateView(m, ws, UNKNOWN.view, { name: 'x', version: 0 }, mutation()),
      ],
      [
        'pinView',
        () => env.svc.pinView(m, ws, ownerView, { scope: 'workspace' }, mutation()),
        () => env.svc.pinView(m, ws, UNKNOWN.view, { scope: 'workspace' }, mutation()),
      ],
      [
        'getEntry',
        () => env.svc.getEntry(m, ws, hiddenEntries[0]!),
        () => env.svc.getEntry(m, ws, UNKNOWN.entry),
      ],
      [
        'deleteEntry',
        () => env.svc.deleteEntry(m, ws, hiddenEntries[0]!, ifMatch(0)),
        () => env.svc.deleteEntry(m, ws, UNKNOWN.entry, ifMatch(0)),
      ],
      [
        'createEntry',
        () =>
          env.svc.createEntry(
            m,
            ws,
            { target: T.secret, work_date: past, duration_minutes: 5 },
            mutation(),
          ),
        () =>
          env.svc.createEntry(
            m,
            ws,
            { target: UNKNOWN.task, work_date: past, duration_minutes: 5 },
            mutation(),
          ),
      ],
      [
        'startTimer',
        () => env.svc.startTimer(m, ws, { target: T.restricted }, mutation()),
        () => env.svc.startTimer(m, ws, { target: UNKNOWN.task }, mutation()),
      ],
      [
        'commit',
        () => env.svc.commit(m, ws, addDays(today, 1), { task: T.secret }, mutation()),
        () => env.svc.commit(m, ws, addDays(today, 1), { task: UNKNOWN.task }, mutation()),
      ],
      [
        'createBlock',
        () =>
          env.svc.createBlock(
            m,
            ws,
            { tz: 'UTC', task: T.restricted, starts_at: `${week}T15:00:00Z`, duration_minutes: 30 },
            mutation(),
          ),
        () =>
          env.svc.createBlock(
            m,
            ws,
            { tz: 'UTC', task: UNKNOWN.task, starts_at: `${week}T15:00:00Z`, duration_minutes: 30 },
            mutation(),
          ),
      ],
      [
        'workSummary',
        () => env.svc.workSummary(m, ws, restrictedProject),
        () => env.svc.workSummary(m, ws, UNKNOWN.project),
      ],
      [
        'workSummaryTask',
        () => env.svc.workSummary(m, ws, T.secret),
        () => env.svc.workSummary(m, ws, UNKNOWN.task),
      ],
      [
        'getTimesheet',
        () => env.svc.getTimesheet(m, ws, ownerSheet),
        () => env.svc.getTimesheet(m, ws, UNKNOWN.sheet),
      ],
      [
        'decideTimesheet',
        () =>
          env.svc.decideTimesheet(
            m,
            ws,
            ownerSheet,
            { brand: main, decision: 'approve' },
            ifMatch(0),
          ),
        () =>
          env.svc.decideTimesheet(
            m,
            ws,
            UNKNOWN.sheet,
            { brand: main, decision: 'approve' },
            ifMatch(0),
          ),
      ],
      [
        'holidays',
        () => env.svc.listHolidays(m, ws, secret, {}),
        () => env.svc.listHolidays(m, ws, UNKNOWN.brand, {}),
      ],
      [
        'setReservation',
        () =>
          env.svc.setReservation(
            P.manager,
            ws,
            { brand: secret, member: M.member, minutes_per_week: 5, effective_from: week },
            mutation(),
          ),
        () =>
          env.svc.setReservation(
            P.manager,
            ws,
            { brand: UNKNOWN.brand, member: M.member, minutes_per_week: 5, effective_from: week },
            mutation(),
          ),
      ],
      [
        'deleteReservation',
        () => env.svc.deleteReservation(P.manager, ws, secretReservation, mutation()),
        () => env.svc.deleteReservation(P.manager, ws, UNKNOWN.reservation, mutation()),
      ],
      [
        'personCapacity',
        () => env.svc.personCapacity(P.limited_member, ws, { member: M.member }),
        () => env.svc.personCapacity(P.limited_member, ws, { member: UNKNOWN.member }),
      ],
    ];
    for (const [name, hiddenCall, unknownCall] of pairs) {
      const a = await code(hiddenCall());
      const b = await code(unknownCall());
      expect(a, name).toBe('not_found');
      expect(b, name).toBe(a);
    }
    // Other people's personal plans are unknown too, even to the owner.
    const ownerBlocks = await env.svc.listBlocks(P.owner, ws, { from: week, to: addDays(week, 6) });
    const ob = ownerBlocks.data[0]!;
    expect(
      await code(
        env.svc.updateBlock(P.administrator, ws, ob.id, { locked: true }, ifMatch(ob.version)),
      ),
    ).toBe('not_found');
    const tof = (await env.svc.listTimeOff(P.member, ws, { from: week, to: addDays(week, 6) }))
      .data[0]!;
    expect(
      await code(env.svc.updateTimeOff(P.owner, ws, tof.id, { label: 'x' }, ifMatch(tof.version))),
    ).toBe('not_found');
  });

  it('serializes concurrent saved-view edits, board transitions, Today commits and reorders', async () => {
    const o = P.owner;
    const m = P.member;
    // Saved view: two writers on one version, exactly one conflict.
    const v = await env.svc.getView(o, ws, sharedView);
    const views = await Promise.allSettled([
      env.svc.updateView(o, ws, sharedView, { name: 'A', version: v.version }, mutation()),
      env.svc.updateView(o, ws, sharedView, { name: 'B', version: v.version }, mutation()),
    ]);
    expect(views.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(views.find((r) => r.status === 'rejected')).toMatchObject({
      reason: reason('conflict'),
    });
    expect((await env.svc.getView(o, ws, sharedView)).version).toBe(v.version + 1);
    // Board: two moves of the same card from the same version, one winner.
    const t = await env.svc.getTask(m, ws, T.race);
    const [pa, pb] = await Promise.all([
      env.svc.previewTransition(m, ws, T.race, { to: statuses[1] }),
      env.svc.previewTransition(o, ws, T.race, { to: statuses[2] }),
    ]);
    const moves = await Promise.allSettled([
      env.svc.applyTransition(
        m,
        ws,
        T.race,
        { to: statuses[1], version: t.version, preview_token: pa.preview_token },
        mutation(),
      ),
      env.svc.applyTransition(
        o,
        ws,
        T.race,
        { to: statuses[2], version: t.version, preview_token: pb.preview_token },
        mutation(),
      ),
    ]);
    expect(moves.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(moves.find((r) => r.status === 'rejected')).toMatchObject({
      reason: reason('conflict'),
    });
    expect((await env.svc.getTask(o, ws, T.race)).version).toBe(t.version + 1);
    // Today: concurrent commits of one task, one wins; concurrent reorders on one version, one wins.
    const day = addDays(today, 2);
    const commits = await Promise.allSettled(
      [1, 2, 3].map(() => env.svc.commit(m, ws, day, { task: T.shared }, mutation())),
    );
    expect(commits.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of commits.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toEqual(issueOf('already_committed'));
    const second = (await env.svc.commit(m, ws, day, { task: T.race }, mutation())).data;
    const reorders = await Promise.allSettled([
      env.svc.updateCommitment(m, ws, day, T.race, { after: null }, ifMatch(second.version)),
      env.svc.updateCommitment(m, ws, day, T.race, { locked: true }, ifMatch(second.version)),
    ]);
    expect(reorders.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(reorders.find((r) => r.status === 'rejected')).toMatchObject({
      reason: reason('conflict'),
    });
    const n = await db.admin(
      `SELECT count(*)::int AS n FROM planning.today_commitment c JOIN core.record r ON r.id = c.task_id
        WHERE r.public_id = $1 AND c.day = $2`,
      [T.shared, day],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('serializes timers, approvals against edits, and reservation sets', async () => {
    const m = P.member;
    // Timers: four racing starts leave exactly one running timer.
    const starts = await Promise.allSettled(
      [T.open, T.shared, T.open, T.race].map((target) =>
        env.svc.startTimer(m, ws, { target }, mutation()),
      ),
    );
    expect(starts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of starts.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toEqual(issueOf('timer_running'));
    const live = await db.admin(
      `SELECT count(*)::int AS n FROM timetrack.time_entry e JOIN tenancy.membership m ON m.id = e.membership_id
        WHERE m.public_id = $1 AND e.state <> 'stopped'`,
      [M.member],
    );
    expect(live.rows[0].n).toBe(1);
    const timer = (await env.svc.getTimer(m, ws)).timer!;
    await env.svc.timerAction(m, ws, timer.id, 'stop', {}, mutation());
    // Approval races an edit of the submitted period: the edit never lands, the evidence is exact.
    const sheet = await env.svc.getTimesheet(m, ws, memberSheet);
    const entry = sheet.entries[0]!;
    const race = await Promise.allSettled([
      env.svc.decideTimesheet(
        P.manager,
        ws,
        memberSheet,
        { brand: main, decision: 'approve' },
        ifMatch(sheet.version),
      ),
      env.svc.updateEntry(m, ws, entry.id, { duration_minutes: 5 }, ifMatch(entry.version)),
    ]);
    expect(race[0].status).toBe('fulfilled');
    expect(race[1].status).toBe('rejected');
    expect((race[1] as PromiseRejectedResult).reason.issues[0].code).toMatch(
      /period_submitted|period_locked/,
    );
    const after = await env.svc.getEntry(m, ws, entry.id);
    expect(after).toMatchObject({
      duration_seconds: entry.duration_seconds,
      version: entry.version,
    });
    // The approved period is locked for every write path the person has.
    await expect(
      env.svc.updateEntry(m, ws, entry.id, { billable: true }, ifMatch(after.version)),
    ).rejects.toEqual(issueOf('period_locked'));
    await expect(
      env.svc.createEntry(
        m,
        ws,
        { target: T.open, work_date: tsWeek, duration_minutes: 5 },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('period_locked'));
    // Reservations: two first-time sets for one person and brand; one creates, one must re-read.
    const from = addDays(week, 7);
    const sets = await Promise.allSettled([
      env.svc.setReservation(
        P.manager,
        ws,
        { brand: main, member: M.share_only, minutes_per_week: 300, effective_from: from },
        mutation(),
      ),
      env.svc.setReservation(
        P.owner,
        ws,
        { brand: main, member: M.share_only, minutes_per_week: 400, effective_from: from },
        mutation(),
      ),
    ]);
    expect(sets.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(sets.find((r) => r.status === 'rejected')).toMatchObject({
      reason: reason('precondition_required'),
    });
    const rows = await db.admin(
      `SELECT count(*)::int AS n FROM planning.capacity_reservation c JOIN tenancy.membership m ON m.id = c.membership_id
        WHERE m.public_id = $1 AND c.effective_from = $2`,
      [M.share_only, from],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('refuses writes when permission is revoked between the read and the write', async () => {
    const o = P.owner;
    const r = P.removed; // still active here; edit on Main
    const view = (
      await env.svc.createView(r, ws, { name: 'Mine', query: { entity: 'task' } }, mutation())
    ).data;
    await env.svc.shareView(
      r,
      ws,
      view.id,
      { scope: 'brand', brand: main, version: 0 },
      mutation(),
    );
    const listed = await env.svc.query(r, ws, 'task', { query: { entity: 'task' } });
    expect(listed.data.map((x) => x.id)).toContain(T.open);
    const pv = await env.svc.previewTransition(r, ws, T.open, { to: statuses[1] });
    const t = await env.svc.getTask(r, ws, T.open);
    // Manager's view of a reservation, then the manager loses manage.
    const rsv = (await env.svc.listReservations(P.manager, ws, {})).data[0]!;
    await apply(env, o, ws, { kind: 'brand_revoke', brand: main, principal: M.removed });
    await apply(env, o, ws, {
      kind: 'brand_grant',
      brand: main,
      principal: M.manager,
      level: 'view',
    });
    const nf = reason('not_found');
    await expect(
      env.svc.applyTransition(
        r,
        ws,
        T.open,
        { to: statuses[1], version: t.version, preview_token: pv.preview_token },
        mutation(),
      ),
    ).rejects.toEqual(nf);
    await expect(env.svc.commit(r, ws, today, { task: T.open }, mutation())).rejects.toEqual(nf);
    await expect(
      env.svc.createBlock(
        r,
        ws,
        { tz: 'UTC', task: T.open, starts_at: `${week}T13:00:00Z`, duration_minutes: 30 },
        mutation(),
      ),
    ).rejects.toEqual(nf);
    await expect(
      env.svc.createEntry(
        r,
        ws,
        { target: T.open, work_date: past, duration_minutes: 5 },
        mutation(),
      ),
    ).rejects.toEqual(nf);
    await expect(env.svc.startTimer(r, ws, { target: T.open }, mutation())).rejects.toEqual(nf);
    // The brand share no longer qualifies: the shared view cannot be edited or re-shared at Main.
    await expect(
      env.svc.shareView(r, ws, view.id, { scope: 'brand', brand: main, version: 1 }, mutation()),
    ).rejects.toEqual(
      expect.objectContaining({ code: expect.stringMatching(/not_found|forbidden/) }),
    );
    expect((await env.svc.query(r, ws, 'task', { query: { entity: 'task' } })).data).toEqual([]);
    // The manager, now view only, can no longer change reservations or decide approvals.
    await expect(
      env.svc.setReservation(
        P.manager,
        ws,
        {
          brand: main,
          member: M.member,
          minutes_per_week: 1,
          effective_from: rsv.effective_from,
        },
        ifMatch(rsv.version),
      ),
    ).rejects.toEqual(reason('forbidden'));
    await expect(env.svc.deleteReservation(P.manager, ws, rsv.id, mutation())).rejects.toEqual(
      reason('forbidden'),
    );
    const os = await env.svc.getTimesheet(o, ws, ownerSheet);
    await expect(
      env.svc.decideTimesheet(
        P.manager,
        ws,
        ownerSheet,
        { brand: main, decision: 'approve' },
        ifMatch(os.version),
      ),
    ).rejects.toEqual(nf);
    await expect(env.svc.teamCapacity(P.manager, ws, {})).rejects.toEqual(reason('forbidden'));
    await apply(env, o, ws, {
      kind: 'brand_grant',
      brand: main,
      principal: M.manager,
      level: 'manage',
    });
    await apply(env, o, ws, {
      kind: 'brand_grant',
      brand: main,
      principal: M.removed,
      level: 'edit',
    });
  });

  it('replays an idempotency key with the same result and exactly one audit and event row', async () => {
    const m = P.member;
    const count = async (publicId: string) => {
      const a = await db.admin(
        `SELECT count(*)::int AS n FROM audit.audit_event WHERE target_public_id = $1`,
        [publicId],
      );
      return a.rows[0].n as number;
    };
    const events = async (table: string, publicId: string) => {
      const e = await db.admin(
        `SELECT count(*)::int AS n FROM exec.outbox_event o JOIN ${table} t ON t.id = o.aggregate_id WHERE t.public_id = $1`,
        [publicId],
      );
      return e.rows[0].n as number;
    };
    // A time entry.
    const key = mutation();
    const body = { target: T.open, work_date: addDays(today, -3), duration_minutes: 20 };
    const a = await env.svc.createEntry(m, ws, body, key);
    const b = await env.svc.createEntry(m, ws, body, key);
    expect(b.replayed).toBe(true);
    expect(b.data).toEqual(a.data);
    expect(await count(a.data.id)).toBe(1);
    expect(await events('timetrack.time_entry', a.data.id)).toBe(1);
    const n = await db.admin(
      `SELECT count(*)::int AS n FROM timetrack.time_entry e JOIN tenancy.membership m ON m.id = e.membership_id
        WHERE m.public_id = $1 AND e.work_date = $2`,
      [M.member, addDays(today, -3)],
    );
    expect(n.rows[0].n).toBe(1);
    // A reservation.
    const rk = mutation();
    const rb = { brand: main, member: M.manager, minutes_per_week: 120, effective_from: week };
    const r1 = await env.svc.setReservation(P.owner, ws, rb, rk);
    const r2 = await env.svc.setReservation(P.owner, ws, rb, rk);
    expect(r2.replayed).toBe(true);
    expect(r2.data.id).toBe(r1.data.id);
    expect(await count(r1.data.id)).toBe(1);
    expect(await events('planning.capacity_reservation', r1.data.id)).toBe(1);
    // A saved view.
    const vk = mutation();
    const vb = { name: 'Replay me', query: { entity: 'task' } };
    const v1 = await env.svc.createView(m, ws, vb, vk);
    const v2 = await env.svc.createView(m, ws, vb, vk);
    expect(v2.data.id).toBe(v1.data.id);
    expect(await count(v1.data.id)).toBe(1);
    // A Today commitment and a work block.
    const ck = mutation();
    const day = addDays(today, 4);
    await env.svc.commit(m, ws, day, { task: T.open }, ck);
    const c2 = await env.svc.commit(m, ws, day, { task: T.open }, ck);
    expect(c2.replayed).toBe(true);
    const commits = await db.admin(
      `SELECT count(*)::int AS n FROM audit.audit_event WHERE workspace_id = $1 AND action = 'today.committed'
        AND changes::text LIKE $2`,
      [wsId, `%${day}%`],
    );
    expect(commits.rows[0].n).toBe(1);
    const bk = mutation();
    const bb = {
      tz: 'UTC',
      title: 'Replay block',
      starts_at: `${addDays(week, 2)}T15:00:00Z`,
      duration_minutes: 30,
    };
    const k1 = await env.svc.createBlock(m, ws, bb, bk);
    const k2 = await env.svc.createBlock(m, ws, bb, bk);
    expect(k2.data.id).toBe(k1.data.id);
    expect(await count(k1.data.id)).toBe(1);
    expect(await events('planning.work_block', k1.data.id)).toBeLessThanOrEqual(1);
  });

  it('suspension and removal stop the person, their timer, and their personal planning data', async () => {
    const o = P.owner;
    const s = P.suspended;
    const r = P.removed;
    // The suspended person leaves a timer running; the removed person has plans and time off.
    const t0 = new Date(Date.now() - 90 * 60_000);
    const timer = (
      await env.svc.startTimer(s, ws, { target: T.open, at: t0.toISOString() }, mutation())
    ).data;
    const removedTimer = (
      await env.svc.startTimer(
        r,
        ws,
        { target: T.shared, at: new Date(Date.now() - 30 * 60_000).toISOString() },
        mutation(),
      )
    ).data;
    await env.svc.commit(r, ws, today, { task: T.shared }, mutation());
    await env.svc.createBlock(
      r,
      ws,
      { tz: 'UTC', title: 'Removed focus', starts_at: `${week}T10:00:00Z`, duration_minutes: 30 },
      mutation(),
    );
    await env.svc.createTimeOff(r, ws, { starts_on: addDays(week, 1) }, mutation());
    await env.svc.setMyCapacityProfile(r, ws, { windows: WEEKDAYS }, ifMatch(0));
    await env.svc.setReservation(
      P.manager,
      ws,
      { brand: main, member: M.removed, minutes_per_week: 60, effective_from: week },
      mutation(),
    );
    await apply(env, o, ws, { kind: 'suspend', member: M.suspended });
    await apply(env, o, ws, { kind: 'remove', member: M.removed });
    // Removal stops the departing person's running timer then and there (not at the guard's limit).
    const ended = await env.svc.getEntry(o, ws, removedTimer.id);
    expect(ended).toMatchObject({ state: 'stopped', auto_stopped: false });
    expect(ended.duration_seconds).toBeGreaterThanOrEqual(1800);
    expect(ended.duration_seconds).toBeLessThan(1800 + 120);
    const why = await db.admin(
      `SELECT changes FROM audit.audit_event WHERE target_public_id = $1 AND action = 'time.timer_auto_stopped'`,
      [removedTimer.id],
    );
    expect(why.rows).toHaveLength(1);
    expect(JSON.stringify(why.rows[0].changes)).toContain('departure');
    // Their reads and writes fail on every Phase 3 surface.
    for (const who of [s, r]) {
      for (const call of [
        () => env.svc.todayView(who, ws, today),
        () => env.svc.listBlocks(who, ws, { from: week, to: addDays(week, 6) }),
        () => env.svc.getTimer(who, ws),
        () => env.svc.listEntries(who, ws, {}),
        () => env.svc.personCapacity(who, ws, {}),
        () => env.svc.query(who, ws, 'task', { query: { entity: 'task' } }),
        () => env.svc.listViews(who, ws, {}),
        () => env.svc.timerAction(who, ws, timer.id, 'stop', {}, mutation()),
      ])
        await expect(call()).rejects.toBeDefined();
    }
    // Departed and suspended people are not offered as capacity or reservations.
    const team = await env.svc.teamCapacity(o, ws, { from: week, to: addDays(week, 6) });
    const people = team.people.map((p: { member: { id: string } }) => p.member.id);
    expect(people).not.toContain(M.suspended);
    expect(people).not.toContain(M.removed);
    await expect(
      env.svc.personCapacity(o, ws, { member: M.removed, from: week, to: addDays(week, 6) }),
    ).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.setReservation(
        o,
        ws,
        { brand: main, member: M.suspended, minutes_per_week: 60, effective_from: week },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('invalid'));
    // The suspended person's timer is stopped by the guard at exactly the limit, once.
    const deps = {
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
      settings: { ...DEFAULT_WORK_SETTINGS, timeTimerMaxHours: 1 },
    };
    await timerGuardHandler(deps).handle({} as never);
    await timerGuardHandler(deps).handle({} as never);
    const stopped = await env.svc.getEntry(o, ws, timer.id);
    expect(stopped).toMatchObject({ state: 'stopped', duration_seconds: 3600, auto_stopped: true });
    const ev = await db.admin(
      `SELECT count(*)::int AS n FROM exec.outbox_event o JOIN timetrack.time_entry t ON t.id = o.aggregate_id
        WHERE t.public_id = $1 AND o.event_type = 'time.timer.auto_stopped'`,
      [timer.id],
    );
    expect(ev.rows[0].n).toBe(1);
    // The departure sweep erases the removed person's plans, time off, profile, and reservations,
    // even when they kept no favorites or recents.
    const rid = (await membershipOf(db, wsId, r.auth.account.id))!.id;
    const left = async () =>
      Number(
        (
          await db.admin(
            `SELECT (SELECT count(*) FROM planning.time_off WHERE membership_id = $1)
              + (SELECT count(*) FROM planning.capacity_reservation WHERE membership_id = $1)
              + (SELECT count(*) FROM planning.capacity_profile WHERE membership_id = $1)
              + (SELECT count(*) FROM planning.work_block WHERE owner_membership_id = $1)
              + (SELECT count(*) FROM planning.today_commitment WHERE owner_membership_id = $1) AS n`,
            [rid],
          )
        ).rows[0].n,
      );
    expect(await left()).toBeGreaterThan(0);
    await db.admin(`DELETE FROM views.recent_item WHERE owner_membership_id = $1`, [rid]);
    await db.admin(`DELETE FROM views.favorite WHERE owner_membership_id = $1`, [rid]);
    await db.admin(`DELETE FROM views.view_state WHERE owner_membership_id = $1`, [rid]);
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
      cleanupWorkspaceViews(tx, env.h.telemetry.metrics, {
        departedBefore: new Date(Date.now() + 60_000),
      }),
    );
    expect(await left()).toBe(0);
    // The suspended person's data is kept (they may come back).
    const sid = (await membershipOf(db, wsId, s.auth.account.id))!.id;
    const kept = await db.admin(
      `SELECT count(*)::int AS n FROM timetrack.time_entry WHERE membership_id = $1`,
      [sid],
    );
    expect(kept.rows[0].n).toBe(1);
  });
});
