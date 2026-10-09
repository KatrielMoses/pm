import { describe, expect, it } from 'vitest';
import {
  dependencyState,
  evaluateHealth,
  metricPercent,
  periodIsCanonical,
  periodLabel,
  goalPeriodOf,
  periodState,
  rollup,
  statusChangeAllowed,
  updateState,
  workPercent,
  type HealthInput,
} from '../../src/goals/semantics.ts';

const base: HealthInput = {
  today: '2026-10-08',
  statusCategory: 'active',
  startDate: '2026-09-01',
  targetDate: '2026-11-30',
  deadlineDate: null,
  done: 5,
  total: 10,
  overdue: 0,
  blocked: 0,
  timeBudgetMinutes: null,
  loggedMinutes: 0,
};

/** ADR-0028 G2–G6: periods, progress, freshness, health, dependencies. */
describe('goal periods (5B)', () => {
  it('names calendar quarters, halves, and years, with their real last days', () => {
    expect(goalPeriodOf({ kind: 'quarter', year: 2026, index: 4 })).toEqual({
      kind: 'quarter',
      start: '2026-10-01',
      end: '2026-12-31',
    });
    expect(goalPeriodOf({ kind: 'quarter', year: 2026, index: 1 })?.end).toBe('2026-03-31');
    expect(goalPeriodOf({ kind: 'quarter', year: 2028, index: 1 })?.end).toBe('2028-03-31');
    expect(goalPeriodOf({ kind: 'half', year: 2028, index: 1 })).toEqual({
      kind: 'half',
      start: '2028-01-01',
      end: '2028-06-30',
    });
    expect(goalPeriodOf({ kind: 'year', year: 2026 })).toEqual({
      kind: 'year',
      start: '2026-01-01',
      end: '2026-12-31',
    });
  });

  it('refuses periods it cannot name', () => {
    expect(goalPeriodOf({ kind: 'quarter', year: 2026, index: 5 })).toBeNull();
    expect(goalPeriodOf({ kind: 'half', year: 2026, index: 0 })).toBeNull();
    expect(goalPeriodOf({ kind: 'year', year: 1999 })).toBeNull();
    expect(goalPeriodOf({ kind: 'quarter', year: '2026', index: 1 })).toBeNull();
    expect(goalPeriodOf({ kind: 'custom', start: '2026-02-30', end: '2026-03-01' })).toBeNull();
    expect(goalPeriodOf({ kind: 'custom', start: '2026-03-02', end: '2026-03-01' })).toBeNull();
    expect(goalPeriodOf({ kind: 'custom', start: '2000-01-01', end: '2012-01-01' })).toBeNull();
    expect(goalPeriodOf({ kind: 'fiscal', year: 2026 })).toBeNull();
  });

  it('accepts a custom period and labels each kind', () => {
    const c = goalPeriodOf({ kind: 'custom', start: '2026-10-01', end: '2026-12-15' })!;
    expect(periodLabel(c)).toBe('2026-10-01 to 2026-12-15');
    expect(periodLabel(goalPeriodOf({ kind: 'quarter', year: 2026, index: 4 })!)).toBe('2026 Q4');
    expect(periodLabel(goalPeriodOf({ kind: 'half', year: 2026, index: 2 })!)).toBe('2026 H2');
    expect(periodLabel(goalPeriodOf({ kind: 'year', year: 2027 })!)).toBe('2027');
  });

  it('classifies a day against a period, inclusive of both ends', () => {
    const p = { start: '2026-10-01', end: '2026-12-31' };
    expect(periodState('2026-09-30', p)).toBe('upcoming');
    expect(periodState('2026-10-01', p)).toBe('current');
    expect(periodState('2026-12-31', p)).toBe('current');
    expect(periodState('2027-01-01', p)).toBe('ended');
  });

  it('detects a stored period that does not match its calendar kind', () => {
    expect(periodIsCanonical({ kind: 'quarter', start: '2026-10-01', end: '2026-12-31' })).toBe(
      true,
    );
    expect(periodIsCanonical({ kind: 'quarter', start: '2026-10-01', end: '2026-12-30' })).toBe(
      false,
    );
    expect(periodIsCanonical({ kind: 'custom', start: '2026-10-01', end: '2026-10-02' })).toBe(
      true,
    );
  });
});

describe('goal progress (5B)', () => {
  it('measures movement from the baseline toward the target, either direction', () => {
    expect(metricPercent({ baseline: 0, target: 100, current: 25 })).toBe(25);
    expect(metricPercent({ baseline: 10, target: 20, current: 15 })).toBe(50);
    // A target below its baseline means reduce.
    expect(metricPercent({ baseline: 100, target: 40, current: 70 })).toBe(50);
    expect(metricPercent({ baseline: 1, target: 3, current: 1.333 })).toBe(16.65);
  });

  it('clamps to 0–100 and returns null without a measurement', () => {
    expect(metricPercent({ baseline: 0, target: 10, current: -5 })).toBe(0);
    expect(metricPercent({ baseline: 0, target: 10, current: 25 })).toBe(100);
    expect(metricPercent({ baseline: 100, target: 40, current: 120 })).toBe(0);
    expect(metricPercent({ baseline: 0, target: 10, current: null })).toBeNull();
    expect(metricPercent({ baseline: null, target: 10, current: 3 })).toBeNull();
    expect(metricPercent({ baseline: 5, target: 5, current: 5 })).toBeNull();
  });

  it('counts linked work as done over non-cancelled readable leaf tasks (OD-13)', () => {
    expect(workPercent(0, 0)).toBeNull();
    expect(workPercent(0, 4)).toBe(0);
    expect(workPercent(1, 3)).toBe(33);
    expect(workPercent(2, 3)).toBe(67);
    expect(workPercent(4, 4)).toBe(100);
    expect(workPercent(9, 4)).toBe(100);
  });

  it('rolls key results up as a plain mean of the measured ones, and says how complete it is', () => {
    const r = rollup([
      { percent: 50, basis: 'manual' },
      { percent: 100, basis: 'manual' },
      { percent: null, basis: 'manual' },
    ]);
    expect(r).toEqual({ percent: 75, counted: 2, total: 3, viewerDependent: false });
    expect(rollup([])).toEqual({ percent: null, counted: 0, total: 0, viewerDependent: false });
    expect(
      rollup([
        { percent: 40, basis: 'linked_work' },
        { percent: 60, basis: 'manual' },
      ]),
    ).toMatchObject({
      percent: 50,
      viewerDependent: true,
    });
  });
});

describe('goal freshness and status (5B)', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  it('is never before any check-in, fresh within the window, and stale after it', () => {
    expect(updateState(null, now, 14)).toBe('never');
    expect(updateState(new Date('2026-09-25T12:00:00Z'), now, 14)).toBe('fresh');
    expect(updateState(new Date('2026-09-24T11:59:59Z'), now, 14)).toBe('stale');
  });
  it('never returns a goal to draft', () => {
    expect(statusChangeAllowed('draft', 'active')).toBe(true);
    expect(statusChangeAllowed('active', 'achieved')).toBe(true);
    expect(statusChangeAllowed('missed', 'active')).toBe(true);
    expect(statusChangeAllowed('active', 'draft')).toBe(false);
    expect(statusChangeAllowed('draft', 'draft')).toBe(true);
  });
});

describe('project health (5B)', () => {
  it('is on track when the work matches the calendar', () => {
    // 38 of 90 days elapsed (42%), 50% done: ahead.
    const r = evaluateHealth(base);
    expect(r.health).toBe('on_track');
    expect(r.reasons).toEqual([]);
  });

  it('is complete for a done project and unknown for a cancelled one', () => {
    expect(evaluateHealth({ ...base, statusCategory: 'done' }).health).toBe('complete');
    const c = evaluateHealth({ ...base, statusCategory: 'cancelled' });
    expect(c.health).toBe('unknown');
    expect(c.incomplete).toContain('cancelled');
  });

  it('is off track once the deadline has passed, with the days late', () => {
    const r = evaluateHealth({ ...base, deadlineDate: '2026-10-01' });
    expect(r.health).toBe('off_track');
    expect(r.reasons[0]).toMatchObject({ code: 'deadline_passed', facts: { days_late: 7 } });
  });

  it('separates a recently missed target (at risk) from a long-missed one (off track)', () => {
    const nearlyDone = { ...base, done: 9, total: 10 };
    expect(evaluateHealth({ ...nearlyDone, targetDate: '2026-09-30' }).health).toBe('at_risk');
    expect(evaluateHealth({ ...nearlyDone, targetDate: '2026-09-23' }).health).toBe('off_track');
  });

  it('compares completion with the share of time elapsed', () => {
    // 2026-09-08 to 2026-10-08 is exactly 30 of 60 days (50%).
    const input = { ...base, startDate: '2026-09-08', targetDate: '2026-11-07', total: 10 };
    expect(evaluateHealth({ ...input, done: 4 }).health).toBe('on_track');
    expect(evaluateHealth({ ...input, done: 3 }).reasons[0]).toMatchObject({
      code: 'behind_schedule',
      severity: 'at_risk',
    });
    expect(evaluateHealth({ ...input, done: 1 }).reasons[0]).toMatchObject({
      code: 'behind_schedule',
      severity: 'off_track',
    });
    // Not started: no schedule judgement before the start day.
    expect(evaluateHealth({ ...input, startDate: '2026-10-09', done: 0 }).reasons).toEqual([]);
  });

  it('reads the share of open tasks that are past due or blocked', () => {
    expect(
      evaluateHealth({ ...base, done: 0, total: 8, overdue: 2 }).reasons.map((r) => r.code),
    ).toContain('overdue_tasks');
    const off = evaluateHealth({ ...base, done: 0, total: 8, overdue: 4 });
    expect(off.reasons.find((r) => r.code === 'overdue_tasks')?.severity).toBe('off_track');
    expect(
      evaluateHealth({ ...base, done: 0, total: 8, overdue: 1 }).reasons.map((r) => r.code),
    ).not.toContain('overdue_tasks');
    expect(
      evaluateHealth({ ...base, done: 0, total: 8, blocked: 2 }).reasons.map((r) => r.code),
    ).toContain('blocked_tasks');
  });

  it('reads the time budget: exceeded is off track, nearly used with little done is at risk', () => {
    expect(evaluateHealth({ ...base, timeBudgetMinutes: 600, loggedMinutes: 601 }).health).toBe(
      'off_track',
    );
    const near = evaluateHealth({ ...base, timeBudgetMinutes: 600, loggedMinutes: 560 });
    expect(near.reasons[0]).toMatchObject({ code: 'time_budget_nearly_used', severity: 'at_risk' });
    expect(
      evaluateHealth({ ...base, done: 10, total: 10, timeBudgetMinutes: 600, loggedMinutes: 580 })
        .reasons,
    ).toEqual([]);
  });

  it('judges a planned or paused project against its dates only, and says so', () => {
    const planned = evaluateHealth({
      ...base,
      statusCategory: 'planned',
      done: 0,
      overdue: 9,
      blocked: 9,
      startDate: null,
    });
    expect(planned.reasons).toEqual([]);
    expect(planned.incomplete).toContain('not_started');
    expect(
      evaluateHealth({ ...base, statusCategory: 'paused', targetDate: '2026-01-01' }).health,
    ).toBe('off_track');
  });

  it('is unknown, not on track, when there is nothing to evaluate', () => {
    const r = evaluateHealth({
      ...base,
      startDate: null,
      targetDate: null,
      deadlineDate: null,
      total: 0,
      done: 0,
    });
    expect(r.health).toBe('unknown');
    expect(r.incomplete).toEqual(expect.arrayContaining(['no_dates', 'no_tasks']));
  });

  it('takes the worst severity and keeps every reason', () => {
    const r = evaluateHealth({ ...base, done: 0, total: 10, overdue: 6, targetDate: '2026-10-01' });
    expect(r.health).toBe('off_track');
    expect(r.reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining(['target_passed', 'overdue_tasks']),
    );
  });
});

describe('dependency state (5B)', () => {
  const t = '2026-10-08';
  it('resolves once the blocker is finished', () => {
    expect(
      dependencyState({
        blockerCategory: 'done',
        blockerDue: '2026-12-01',
        blockedDue: '2026-11-01',
        today: t,
      }),
    ).toBe('resolved');
    expect(
      dependencyState({
        blockerCategory: 'cancelled',
        blockerDue: null,
        blockedDue: null,
        today: t,
      }),
    ).toBe('resolved');
  });
  it('is overdue, late, or open while the blocker is unfinished', () => {
    expect(
      dependencyState({
        blockerCategory: 'active',
        blockerDue: '2026-10-01',
        blockedDue: '2026-11-01',
        today: t,
      }),
    ).toBe('overdue');
    expect(
      dependencyState({
        blockerCategory: 'planned',
        blockerDue: '2026-11-15',
        blockedDue: '2026-11-01',
        today: t,
      }),
    ).toBe('late');
    expect(
      dependencyState({
        blockerCategory: 'planned',
        blockerDue: '2026-10-20',
        blockedDue: '2026-11-01',
        today: t,
      }),
    ).toBe('open');
    expect(
      dependencyState({ blockerCategory: 'planned', blockerDue: null, blockedDue: null, today: t }),
    ).toBe('open');
  });
});
