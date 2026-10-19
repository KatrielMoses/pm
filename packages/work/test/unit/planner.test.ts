import { describe, expect, it } from 'vitest';
import { workingIntervals } from '../../src/capacity/semantics.ts';
import { dayBounds } from '../../src/planning/semantics.ts';
import {
  checkEdits,
  freeTime,
  planDay,
  rankTasks,
  type PlannerInput,
  type PlannerTask,
} from '../../src/planning/planner.ts';

const at = (iso: string) => new Date(iso);
const task = (id: string, over: Partial<PlannerTask> = {}): PlannerTask => ({
  id,
  priority: 'none',
  dueDate: null,
  deadline: null,
  estimate: 60,
  assumed: null,
  blockedBy: [],
  committed: false,
  committedLocked: false,
  blockedMinutes: 0,
  splittable: false,
  ...over,
});
const DAY = '2026-10-20';
const TZ = 'UTC';
const nineToFive = [{ start: at(`${DAY}T09:00:00Z`), end: at(`${DAY}T17:00:00Z`) }];
const base = (over: Partial<PlannerInput> = {}): PlannerInput => ({
  day: DAY,
  tz: TZ,
  windows: nineToFive,
  capacityMinutes: 480,
  meetings: [],
  blocks: [],
  tasks: [],
  notBefore: null,
  split: false,
  minChunk: 30,
  ...over,
});
const END = dayBounds(DAY, TZ).end;

describe('Phase 7F deterministic daily planner', () => {
  it('orders by explicit rules and explains each placement', () => {
    const ranked = rankTasks(
      [
        task('low', { priority: 'low' }),
        task('due', { dueDate: DAY }),
        task('locked', { committed: true, committedLocked: true }),
        task('deadline', { deadline: at(`${DAY}T15:00:00Z`) }),
        task('overdue', { dueDate: '2026-10-18' }),
        task('urgent', { priority: 'urgent' }),
        task('committed', { committed: true }),
      ],
      DAY,
      END,
    ).map((t) => t.id);
    expect(ranked).toEqual(['locked', 'committed', 'deadline', 'overdue', 'due', 'urgent', 'low']);
    const r = planDay(base({ tasks: [task('a', { priority: 'high', dueDate: DAY })] }), END);
    expect(r.scheduled[0]).toMatchObject({
      task: 'a',
      minutes: 60,
      slots: [{ start: at(`${DAY}T09:00:00Z`), end: at(`${DAY}T10:00:00Z`) }],
    });
    expect(r.scheduled[0]!.reasons.map((x) => x.code)).toEqual(['due_today', 'priority']);
    expect(r.feasible).toBe(true);
  });

  it('never claims more fits than capacity: overload defers with a reason and recommends postponements', () => {
    const r = planDay(
      base({
        capacityMinutes: 120,
        tasks: [
          task('a', { priority: 'urgent', estimate: 90 }),
          task('b', { priority: 'medium', estimate: 60, dueDate: '2026-10-25' }),
          task('c', { priority: 'low', estimate: 30 }),
        ],
      }),
      END,
    );
    expect(r.scheduled.map((s) => s.task)).toEqual(['a', 'c']);
    expect(r.unscheduled).toEqual([
      expect.objectContaining({ task: 'b', code: 'over_capacity', minutes: 60 }),
    ]);
    expect(r.totals).toMatchObject({
      candidate_minutes: 180,
      scheduled_minutes: 120,
      unscheduled_minutes: 60,
    });
    expect(r.feasible).toBe(false);
    expect(r.postpone).toEqual([
      expect.objectContaining({ task: 'b', minutes: 60, committed: false }),
    ]);
    expect(r.postpone[0]!.tradeoff).toMatch(/not due until 2026-10-25.*dates do not change/);
  });

  it('a missing estimate is a question, never zero; an entered assumption is used and labelled', () => {
    const r = planDay(base({ tasks: [task('x', { estimate: null })] }), END);
    expect(r.unscheduled[0]).toMatchObject({ task: 'x', code: 'missing_estimate', minutes: null });
    expect(r.totals.unknown_estimates).toBe(1);
    expect(r.feasible).toBe(false);
    const a = planDay(base({ tasks: [task('x', { estimate: null, assumed: 45 })] }), END);
    expect(a.scheduled[0]).toMatchObject({ task: 'x', minutes: 45 });
    expect(a.scheduled[0]!.reasons.map((x) => x.code)).toContain('assumed_estimate');
  });

  it('dependencies, existing blocks, and locked work are hard constraints', () => {
    const r = planDay(
      base({
        blocks: [
          {
            id: 'blk_locked',
            start: at(`${DAY}T09:00:00Z`),
            end: at(`${DAY}T12:00:00Z`),
            prep: 0,
            buffer: 15,
            locked: true,
            focus: true,
            taskId: null,
          },
        ],
        tasks: [
          task('blocked', { blockedBy: ['tsk_blocker'] }),
          task('partly', { estimate: 90, blockedMinutes: 30 }),
          task('done_already', { estimate: 30, blockedMinutes: 30 }),
        ],
      }),
      END,
    );
    // Free time starts after the locked focus block and its buffer.
    expect(r.scheduled[0]).toMatchObject({
      task: 'partly',
      minutes: 60,
      slots: [{ start: at(`${DAY}T12:15:00Z`), end: at(`${DAY}T13:15:00Z`) }],
    });
    expect(r.unscheduled.map((u) => [u.task, u.code])).toEqual([
      ['done_already', 'already_scheduled'],
      ['blocked', 'blocked'],
    ]);
    // A locked commitment that cannot fit is a conflict; nothing is moved.
    const c = planDay(
      base({
        capacityMinutes: 60,
        tasks: [task('big', { estimate: 120, committed: true, committedLocked: true })],
      }),
      END,
    );
    expect(c.conflicts).toEqual([
      expect.objectContaining({ code: 'locked_does_not_fit', task: 'big' }),
    ]);
    expect(c.postpone).toEqual([]);
  });

  it('splits only when opted in and the task allows it, preserving the total', () => {
    const windows = [
      { start: at(`${DAY}T09:00:00Z`), end: at(`${DAY}T10:00:00Z`) },
      { start: at(`${DAY}T11:00:00Z`), end: at(`${DAY}T12:00:00Z`) },
    ];
    const t = task('long', { estimate: 100, splittable: true });
    expect(planDay(base({ windows, tasks: [t] }), END).unscheduled[0]!.code).toBe('does_not_fit');
    const s = planDay(base({ windows, split: true, tasks: [t] }), END);
    expect(
      s.scheduled[0]!.slots.reduce((n, x) => n + (x.end.getTime() - x.start.getTime()) / 60000, 0),
    ).toBe(100);
    expect(s.scheduled[0]!.warnings).toContain('split');
    expect(
      planDay(base({ windows, split: true, tasks: [task('nosplit', { estimate: 100 })] }), END)
        .unscheduled[0]!.code,
    ).toBe('does_not_fit');
  });

  it('works in real instants across daylight saving and respects the current time', () => {
    const tz = 'America/New_York';
    // 2026-03-08 loses an hour; 09:00-17:00 local is still 8 hours of real time.
    const w = workingIntervals('2026-03-08', tz, [{ weekday: 7, start: 540, end: 1020 }]);
    expect(w[0]!.start.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    const r = planDay(
      base({ day: '2026-03-08', tz, windows: w, tasks: [task('a')] }),
      dayBounds('2026-03-08', tz).end,
    );
    expect(r.scheduled[0]!.slots[0]!.start.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    const free = freeTime({ windows: nineToFive, blocks: [], notBefore: at(`${DAY}T10:02:00Z`) });
    expect(free[0]!.start.toISOString()).toBe(`${DAY}T10:05:00.000Z`);
  });

  it('never places work over a meeting, even when the windows do not exclude it (review 01)', () => {
    const r = planDay(
      base({
        meetings: [{ start: at(`${DAY}T09:30:00Z`), end: at(`${DAY}T10:30:00Z`) }],
        tasks: [task('a', { estimate: 60 })],
      }),
      END,
    );
    expect(r.scheduled[0]!.slots).toEqual([
      { start: at(`${DAY}T10:30:00Z`), end: at(`${DAY}T11:30:00Z`) },
    ]);
  });

  it('re-checks edited blocks: overlaps are errors, outside hours and late slots are warnings', () => {
    const issues = checkEdits(
      [
        { key: 'c1', start: at(`${DAY}T09:30:00Z`), end: at(`${DAY}T10:30:00Z`), task: 't1' },
        { key: 'c2', start: at(`${DAY}T10:00:00Z`), end: at(`${DAY}T10:45:00Z`), task: 't2' },
        { key: 'c3', start: at(`${DAY}T18:00:00Z`), end: at(`${DAY}T19:00:00Z`), task: 't3' },
      ],
      {
        windows: nineToFive,
        meetings: [{ start: at(`${DAY}T10:15:00Z`), end: at(`${DAY}T10:30:00Z`) }],
        blocks: [
          {
            id: 'blk_a',
            start: at(`${DAY}T09:00:00Z`),
            end: at(`${DAY}T09:45:00Z`),
            prep: 0,
            buffer: 0,
            locked: true,
            focus: false,
            taskId: null,
          },
        ],
        deadlines: new Map([['t3', at(`${DAY}T18:30:00Z`)]]),
        released: new Set(),
      },
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        { block: 'c1', code: 'overlaps_block', severity: 'error' },
        { block: 'c1', code: 'overlaps_meeting', severity: 'error' },
        { block: 'c1', code: 'overlaps_plan', severity: 'error' },
        { block: 'c2', code: 'overlaps_plan', severity: 'error' },
        { block: 'c3', code: 'outside_working_hours', severity: 'warning' },
        { block: 'c3', code: 'after_deadline', severity: 'warning' },
      ]),
    );
  });
});
