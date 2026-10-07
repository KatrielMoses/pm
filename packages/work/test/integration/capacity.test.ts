import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { eraseMembershipNavigation, type Caller } from '@pm/tenancy';
import { addDays, isoWeekday, localDay } from '@pm/work';
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
const issueOf = (code: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });
const ifMatch = (v: number) => mutation({ ifMatch: `"${v}"` });
const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));

/**
 * Phase 3E capacity and cross-brand conflicts on real PostgreSQL (ADR-0022; OD-19): working hours
 * in the person's zone (DST-safe), weekly overrides, time off, observed brand holidays, per-brand
 * reservations, allocation, cross-brand overlaps and unmet reservations, Today's capacity warning,
 * the workload grid's capacity, rescheduling inputs; privacy (others see only unavailable minutes
 * and readable brands), authorization, permission loss, and concurrent profile edits.
 */
describe('Capacity and cross-brand conflicts (3E)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let lead: Caller; // member with manage on Harbor only → capacity.view at Harbor
  let plain: Caller; // member with edit on Harbor → no capacity.view
  let ws: string;
  let wsId: string;
  let me: string;
  let leadId: string;
  let brands: Record<string, string>;
  let week: string; // a Monday at least a week ahead (UTC; seeded accounts use UTC)
  const t: Record<string, string> = {};

  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const profile = (as: Caller = owner) => env.svc.myCapacityProfile(as, ws);
  const setProfile = async (body: Record<string, unknown>, as: Caller = owner) =>
    (await env.svc.setMyCapacityProfile(as, ws, body, ifMatch((await profile(as)).version))).data;
  const cap = (q: Record<string, unknown> = {}, as: Caller = owner) =>
    env.svc.personCapacity(as, ws, { from: week, to: addDays(week, 6), ...q });
  const task = async (key: string, brand: string, body: Record<string, unknown>) => {
    const created = (await env.svc.createTask(owner, ws, { brand, ...body }, mutation())).data;
    await env.svc.setAssignees(
      owner,
      ws,
      created.id,
      { assignees: [me], primary: me, version: created.version },
      mutation(),
    );
    t[key] = created.id;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    me = await mem(owner);
    lead = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    plain = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    leadId = await mem(lead);
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: leadId,
      level: 'manage',
    });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(plain),
      level: 'edit',
    });
    const today = localDay(new Date(), 'UTC');
    week = addDays(today, 7 + ((8 - isoWeekday(today)) % 7));
    await task('h', brands.Harbor!, {
      title: 'Harbor copy',
      due_date: addDays(week, 1),
      estimate_minutes: 300,
    });
    await task('s', brands.Summit!, {
      title: 'Summit deck',
      due_date: addDays(week, 1),
      estimate_minutes: 240,
    });
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('starts unconfigured, then sets working hours with If-Match and validates windows', async () => {
    expect(await profile()).toMatchObject({
      configured: false,
      version: 0,
      windows: [],
      timezone: 'UTC',
      observe_brand_holidays: true,
    });
    await expect(
      env.svc.setMyCapacityProfile(owner, ws, { windows: WEEKDAYS }, mutation()),
    ).rejects.toEqual(reason('precondition_required'));
    await expect(
      env.svc.setMyCapacityProfile(
        owner,
        ws,
        {
          windows: [
            { weekday: 1, start: '09:00', end: '12:00' },
            { weekday: 1, start: '11:00', end: '13:00' },
          ],
        },
        ifMatch(0),
      ),
    ).rejects.toEqual(issueOf('overlap'));
    await expect(
      env.svc.setMyCapacityProfile(
        owner,
        ws,
        { windows: [{ weekday: 8, start: '09:00', end: '10:00' }] },
        ifMatch(0),
      ),
    ).rejects.toEqual(issueOf('invalid'));
    const p = await setProfile({ windows: WEEKDAYS });
    expect(p).toMatchObject({
      configured: true,
      version: 1,
      nominal_week_minutes: 2400,
      effective_week_minutes: 2400,
    });
    await expect(
      env.svc.setMyCapacityProfile(owner, ws, { weekly_capacity_minutes: 60 }, ifMatch(0)),
    ).rejects.toEqual(reason('conflict'));
  });

  it('computes availability per day, scaled by a weekly override', async () => {
    let c = await cap();
    expect(c.days.map((d) => d.available_minutes)).toEqual([480, 480, 480, 480, 480, 0, 0]);
    expect(c.totals.available_minutes).toBe(2400);
    await setProfile({ weekly_capacity_minutes: 1200 });
    c = await cap();
    expect(c.days.map((d) => d.available_minutes)).toEqual([240, 240, 240, 240, 240, 0, 0]);
    await setProfile({ weekly_capacity_minutes: null });
  });

  it('reports estimates per brand and over-allocation on the due day', async () => {
    const c = await cap();
    const tue = c.days[1]!;
    expect(tue).toMatchObject({
      estimated_minutes: 540,
      available_minutes: 480,
      over: 60,
      state: 'over',
    });
    expect(c.brands.map((b) => [b.brand.name, b.estimated_minutes])).toEqual([
      ['Harbor', 300],
      ['Summit', 240],
    ]);
  });

  it('removes time off from availability and keeps its details private', async () => {
    const all = (
      await env.svc.createTimeOff(
        owner,
        ws,
        { kind: 'vacation', all_day: true, starts_on: addDays(week, 2), label: 'Lisbon' },
        mutation(),
      )
    ).data;
    await env.svc.createTimeOff(
      owner,
      ws,
      {
        kind: 'personal',
        all_day: false,
        starts_at: `${addDays(week, 3)}T09:00:00Z`,
        ends_at: `${addDays(week, 3)}T11:00:00Z`,
      },
      mutation(),
    );
    const c = await cap();
    expect(c.days.map((d) => d.available_minutes)).toEqual([480, 480, 0, 360, 480, 0, 0]);
    expect(c.days[2]).toMatchObject({ unavailable_minutes: 480 });
    const list = await env.svc.listTimeOff(owner, ws, { from: week, to: addDays(week, 6) });
    expect(list.data.map((x) => x.kind)).toEqual(['vacation', 'personal']);
    // Someone else's entry is indistinguishable from an unknown one.
    await expect(
      env.svc.updateTimeOff(lead, ws, all.id, { label: 'x' }, ifMatch(all.version)),
    ).rejects.toEqual(reason('not_found'));
    // The owner viewing their own capacity sees totals; a lead sees only minutes, never kinds or labels.
    const seen = JSON.stringify(await cap({ member: me }, lead));
    expect(seen).not.toMatch(/Lisbon|vacation|personal/);
    expect(JSON.parse(seen).days[2].available_minutes).toBe(0);
    await env.svc.deleteTimeOff(owner, ws, all.id, ifMatch(all.version));
  });

  it('applies brand holidays only where the person holds a reservation and observes them (OD-19)', async () => {
    const day = addDays(week, 4);
    await env.svc.createHoliday(
      owner,
      ws,
      brands.Summit,
      { day, name: 'Founders day' },
      mutation(),
    );
    expect((await cap()).days[4]!.available_minutes).toBe(480); // no Summit reservation yet
    await expect(
      env.svc.createHoliday(plain, ws, brands.Harbor, { day, name: 'Nope' }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    await env.svc.setReservation(
      owner,
      ws,
      { brand: brands.Summit, member: me, minutes_per_week: 600, effective_from: week },
      mutation(),
    );
    expect((await cap()).days[4]).toMatchObject({ available_minutes: 0, holiday: true });
    await setProfile({ observe_brand_holidays: false });
    expect((await cap()).days[4]!.available_minutes).toBe(480);
    await setProfile({ observe_brand_holidays: true });
  });

  it('keeps reservations to capacity.reserve and shows them only where visible', async () => {
    await expect(
      env.svc.setReservation(
        plain,
        ws,
        { brand: brands.Harbor, member: me, minutes_per_week: 60, effective_from: week },
        mutation(),
      ),
    ).rejects.toEqual(reason('forbidden'));
    // Lead manages Harbor: may reserve there, never in Summit (unreadable → not found).
    await env.svc.setReservation(
      lead,
      ws,
      { brand: brands.Harbor, member: me, minutes_per_week: 1200, effective_from: week },
      mutation(),
    );
    await expect(
      env.svc.setReservation(
        lead,
        ws,
        { brand: brands.Summit, member: me, minutes_per_week: 60, effective_from: week },
        mutation(),
      ),
    ).rejects.toEqual(reason('not_found'));
    const mine = await env.svc.listReservations(owner, ws, {});
    expect(mine.data.map((r) => r.brand.name).sort()).toEqual(['Harbor', 'Summit']);
    const leads = await env.svc.listReservations(lead, ws, {});
    expect(leads.data.map((r) => r.brand.name)).toEqual(['Harbor']);
    expect((await env.svc.listReservations(plain, ws, {})).data).toEqual([]);
  });

  it('finds cross-brand overlaps and unmet reservations, limited to readable brands', async () => {
    const day = addDays(week, 1);
    await env.svc.createBlock(
      owner,
      ws,
      { tz: 'UTC', task: t.h, starts_at: `${day}T09:00:00Z`, ends_at: `${day}T11:00:00Z` },
      mutation(),
    );
    await env.svc.createBlock(
      owner,
      ws,
      { tz: 'UTC', task: t.s, starts_at: `${day}T10:00:00Z`, ends_at: `${day}T12:00:00Z` },
      mutation(),
    );
    const c = await cap();
    const overlap = c.conflicts.find((x) => x.kind === 'overlap');
    expect(overlap).toMatchObject({ minutes: 60, brands: ['Harbor', 'Summit'] });
    // Harbor 1200 + Summit 600 fit the 1920 minutes left after the holiday; 2400 for Harbor cannot.
    const harbor = (await env.svc.listReservations(owner, ws, { brand: brands.Harbor })).data[0]!;
    await env.svc.setReservation(
      owner,
      ws,
      { brand: brands.Harbor, member: me, minutes_per_week: 2400, effective_from: week },
      ifMatch(harbor.version),
    );
    expect(
      (await cap()).conflicts.some((x) => x.kind === 'reservation_unmet' && x.brand === 'Harbor'),
    ).toBe(true);
    // The lead (Harbor only) sees no Summit block, brand, or overlap.
    const seen = await cap({ member: me }, lead);
    expect(seen.brands.map((b) => b.brand.name)).toEqual(['Harbor']);
    expect(seen.conflicts.filter((x) => x.kind === 'overlap')).toEqual([]);
    expect(JSON.stringify(seen)).not.toMatch(/Summit/);
    expect(seen).not.toHaveProperty('unbranded_scheduled_minutes');
  });

  it('denies other people’s capacity without capacity.view, and after permission loss', async () => {
    await expect(cap({ member: me }, plain)).rejects.toEqual(reason('not_found'));
    await expect(env.svc.teamCapacity(plain, ws, {})).rejects.toEqual(reason('forbidden'));
    const team = await env.svc.teamCapacity(lead, ws, { from: week, to: addDays(week, 6) });
    expect(team.people.map((p) => p.member.id)).toContain(me);
    await apply(env, owner, ws, { kind: 'brand_revoke', brand: brands.Harbor, principal: leadId });
    await expect(cap({ member: me }, lead)).rejects.toEqual(reason('not_found'));
    await expect(env.svc.teamCapacity(lead, ws, {})).rejects.toEqual(reason('forbidden'));
  });

  it('warns on Today when the plan exceeds the day, and fills the workload grid', async () => {
    const day = addDays(week, 1);
    await env.svc.commit(owner, ws, day, { task: t.h }, mutation());
    await env.svc.commit(owner, ws, day, { task: t.s }, mutation());
    const v = await env.svc.todayView(owner, ws, day);
    expect(v.available_minutes).toBe(480);
    expect(v.capacity).toMatchObject({
      available: true,
      planned_minutes: 540,
      over_minutes: 60,
      warning: true,
    });
    const grid = await env.svc.workload(owner, ws, {
      query: { entity: 'task' },
      from: week,
      to: addDays(week, 6),
      bucket: 'day',
    });
    const row = grid.people.find((p) => p.id === me)!;
    expect(row.capacity?.[day]).toMatchObject({ available: 480 });
    const inputs = await env.svc.reschedulingInputs(owner, ws, {
      from: week,
      to: addDays(week, 6),
    });
    expect(inputs.overcommitted_days).toContain(day);
    expect(inputs.proposals).toBeNull();
  });

  it('serializes concurrent profile edits on the version', async () => {
    const v = (await profile()).version;
    const results = await Promise.allSettled([
      env.svc.setMyCapacityProfile(owner, ws, { weekly_capacity_minutes: 1000 }, ifMatch(v)),
      env.svc.setMyCapacityProfile(owner, ws, { weekly_capacity_minutes: 2000 }, ifMatch(v)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: reason('conflict'),
    });
    expect((await profile()).version).toBe(v + 1);
  });

  it('erases the person’s profile, time off, and reservations about them on departure', async () => {
    const memberId = (await membershipOf(db, wsId, plain.auth.account.id))!.id;
    await env.svc.setReservation(
      owner,
      ws,
      {
        brand: brands.Harbor,
        member: await mem(plain),
        minutes_per_week: 120,
        effective_from: week,
      },
      mutation(),
    );
    await env.svc.createTimeOff(plain, ws, { starts_on: week }, mutation());
    await env.svc.setMyCapacityProfile(
      plain,
      ws,
      { windows: WEEKDAYS },
      ifMatch((await profile(plain)).version),
    );
    const erased = await env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
      eraseMembershipNavigation(tx, memberId),
    );
    expect(erased).toBeGreaterThanOrEqual(3);
    const left = await db.admin(
      `SELECT (SELECT count(*) FROM planning.time_off WHERE membership_id = '${memberId}')
            + (SELECT count(*) FROM planning.capacity_reservation WHERE membership_id = '${memberId}')
            + (SELECT count(*) FROM planning.capacity_profile WHERE membership_id = '${memberId}')
            + (SELECT count(*) FROM planning.availability_rule WHERE membership_id = '${memberId}') AS n`,
    );
    expect(Number(left.rows[0].n)).toBe(0);
    // Holidays set by others are brand settings and stay.
    expect((await env.svc.listHolidays(owner, ws, brands.Summit, {})).data).toHaveLength(1);
  });

  it('keeps the real length of DST days in the person’s zone', async () => {
    await db.admin(
      `UPDATE identity.account SET timezone = 'Europe/Berlin' WHERE id = '${plain.auth.account.id}'`,
    );
    await env.svc.setMyCapacityProfile(
      plain,
      ws,
      {
        windows: [
          { weekday: 7, start: '00:00', end: '24:00' },
          { weekday: 1, start: '00:00', end: '24:00' },
        ],
      },
      ifMatch(0),
    );
    // 2026-03-29 (Sunday) has 23 hours in Berlin; 2026-10-25 (Sunday) has 25.
    const spring = await env.svc.personCapacity(plain, ws, {
      from: '2026-03-29',
      to: '2026-03-30',
    });
    expect(spring.days.map((d) => d.working_minutes)).toEqual([1380, 1440]);
    const autumn = await env.svc.personCapacity(plain, ws, {
      from: '2026-10-25',
      to: '2026-10-25',
    });
    expect(autumn.days[0]!.working_minutes).toBe(1500);
    expect(autumn.timezone).toBe('Europe/Berlin');
  });
});
