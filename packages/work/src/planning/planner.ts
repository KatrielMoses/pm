import { merge, subtract, type Interval } from '../capacity/semantics.ts';

/**
 * Phase 7F deterministic daily planner (ADR-0043 D4–D6; PLAN-010–PLAN-012, AI-021, TIME-016,
 * PLAN-017). Pure and bounded: given the person's free time on one local day (working hours minus
 * time off, holidays, and meetings, already as real instants), their existing blocks, and their
 * readable candidate work, it orders the work by explicit rules, places what fits, and says why
 * everything else does not. It never calls a model, never moves a locked block or commitment, never
 * guesses a missing estimate, and never claims that more fits than does.
 */

export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

export interface PlannerTask {
  id: string;
  priority: Priority;
  /** Local due date (YYYY-MM-DD) or null. */
  dueDate: string | null;
  /** The instant a hard deadline ends (a date deadline's local end, or an exact instant). */
  deadline: Date | null;
  /** Remaining estimate, else the estimate, in minutes; null when unknown. */
  estimate: number | null;
  /** A minutes value the person entered for this plan when the estimate is unknown. */
  assumed: number | null;
  /** Readable open work that blocks this task. */
  blockedBy: string[];
  /** On the person's Today list for this day. */
  committed: boolean;
  /** A locked Today commitment (a hard constraint). */
  committedLocked: boolean;
  /** Minutes of existing blocks for this task on this day. */
  blockedMinutes: number;
  /** Whether the task can be split across several blocks (opt-in per plan). */
  splittable: boolean;
}

export interface PlannerBlock {
  id: string;
  start: Date;
  end: Date;
  /** Preparation and buffer time count as used time. */
  prep: number;
  buffer: number;
  locked: boolean;
  focus: boolean;
  taskId: string | null;
}

export interface PlannerInput {
  day: string;
  tz: string;
  /** Free working intervals before blocks (time off, holidays, and meetings already removed). */
  windows: Interval[];
  /** Minutes the person can work this day (after a weekly-capacity override). */
  capacityMinutes: number;
  /** Meetings (busy calendar time), kept separately to check edits against. */
  meetings: Interval[];
  blocks: PlannerBlock[];
  tasks: PlannerTask[];
  /** Nothing is placed before this instant (now, when planning today). */
  notBefore: Date | null;
  split: boolean;
  /** The smallest block a split produces. */
  minChunk: number;
}

export type ReasonCode =
  | 'locked_commitment'
  | 'committed'
  | 'deadline_today'
  | 'overdue'
  | 'due_today'
  | 'due_soon'
  | 'priority'
  | 'smaller_first'
  | 'assumed_estimate';

export interface Reason {
  code: ReasonCode;
  detail: string;
}

export interface PlannedItem {
  task: string;
  rank: number;
  minutes: number;
  slots: Interval[];
  reasons: Reason[];
  warnings: Array<'after_deadline' | 'after_due_date' | 'split'>;
}

export type UnscheduledCode =
  'missing_estimate' | 'blocked' | 'already_scheduled' | 'does_not_fit' | 'over_capacity';

export interface Unscheduled {
  task: string;
  rank: number;
  code: UnscheduledCode;
  minutes: number | null;
  detail: string;
  blockedBy?: string[];
}

export interface Postponement {
  task: string;
  minutes: number;
  /** Why this one, and what it costs. */
  reason: string;
  tradeoff: string;
  /** An unlocked Today commitment that a postponement would remove (only if the person accepts). */
  committed: boolean;
}

export interface Conflict {
  code: 'locked_does_not_fit' | 'no_free_time';
  task: string | null;
  detail: string;
}

export interface PlanResult {
  day: string;
  tz: string;
  totals: {
    capacity_minutes: number;
    free_minutes: number;
    existing_block_minutes: number;
    candidate_minutes: number;
    scheduled_minutes: number;
    unscheduled_minutes: number;
    unknown_estimates: number;
  };
  scheduled: PlannedItem[];
  unscheduled: Unscheduled[];
  postpone: Postponement[];
  conflicts: Conflict[];
  feasible: boolean;
}

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const MINUTE = 60_000;
const STEP = 5;

const mins = (i: Interval) => Math.round((i.end.getTime() - i.start.getTime()) / MINUTE);
const total = (xs: Interval[]) => xs.reduce((n, i) => n + mins(i), 0);
/** Rounds an instant up to the next whole STEP minutes. */
const ceilStep = (d: Date) => new Date(Math.ceil(d.getTime() / (STEP * MINUTE)) * STEP * MINUTE);

/** The day-relative ordering facts of a task (shared by the ranking and its explanation). */
function urgency(t: PlannerTask, day: string, dayEnd: Date) {
  return {
    lockedCommitment: t.committedLocked,
    committed: t.committed,
    deadlineToday: !!t.deadline && t.deadline.getTime() <= dayEnd.getTime(),
    overdue: !!t.dueDate && t.dueDate < day,
    dueToday: t.dueDate === day,
  };
}

/** Deterministic order: locked commitments, commitments, deadlines, overdue, due today, priority, due date, size, id. */
export function rankTasks(tasks: PlannerTask[], day: string, dayEnd: Date): PlannerTask[] {
  const key = (t: PlannerTask) => {
    const u = urgency(t, day, dayEnd);
    return [
      u.lockedCommitment ? 0 : 1,
      u.committed ? 0 : 1,
      u.deadlineToday ? 0 : 1,
      u.overdue ? 0 : 1,
      u.dueToday ? 0 : 1,
      PRIORITY_RANK[t.priority],
      t.dueDate ?? '9999-12-31',
      t.estimate ?? t.assumed ?? Number.MAX_SAFE_INTEGER,
    ] as const;
  };
  return [...tasks].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      const x = ka[i]!;
      const y = kb[i]!;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function reasonsFor(t: PlannerTask, day: string, dayEnd: Date): Reason[] {
  const u = urgency(t, day, dayEnd);
  const out: Reason[] = [];
  if (u.lockedCommitment)
    out.push({
      code: 'locked_commitment',
      detail: 'Locked on your Today list: it is planned first and never moved.',
    });
  else if (u.committed) out.push({ code: 'committed', detail: 'On your Today list for this day.' });
  if (u.deadlineToday)
    out.push({ code: 'deadline_today', detail: 'Its hard deadline ends by the end of this day.' });
  if (u.overdue) out.push({ code: 'overdue', detail: `It was due ${t.dueDate}.` });
  else if (u.dueToday) out.push({ code: 'due_today', detail: 'It is due this day.' });
  else if (t.dueDate) out.push({ code: 'due_soon', detail: `It is due ${t.dueDate}.` });
  if (t.priority !== 'none') out.push({ code: 'priority', detail: `Priority ${t.priority}.` });
  if (t.estimate === null && t.assumed !== null)
    out.push({
      code: 'assumed_estimate',
      detail: `No estimate: using the ${t.assumed} minutes you entered.`,
    });
  return out;
}

/** Free intervals after existing blocks (with their padding) and before `notBefore`. */
export function freeTime(
  input: Pick<PlannerInput, 'windows' | 'blocks' | 'notBefore'>,
): Interval[] {
  const busy = input.blocks.map((b) => ({
    start: new Date(b.start.getTime() - b.prep * MINUTE),
    end: new Date(b.end.getTime() + b.buffer * MINUTE),
  }));
  let free = subtract(merge(input.windows), busy);
  if (input.notBefore) {
    const nb = input.notBefore;
    free = free
      .map((i) => (i.end <= nb ? null : { start: i.start < nb ? nb : i.start, end: i.end }))
      .filter((i): i is Interval => !!i);
  }
  // Slots start on whole STEP minutes; a remainder too short for a block is not offered.
  return free.map((i) => ({ start: ceilStep(i.start), end: i.end })).filter((i) => mins(i) >= STEP);
}

/** Takes `need` minutes from `free` (earliest first): one contiguous slot, or chunks when split. */
function take(
  free: Interval[],
  need: number,
  split: boolean,
  minChunk: number,
): { slots: Interval[]; rest: Interval[] } | null {
  const contiguous = free.findIndex((i) => mins(i) >= need);
  if (contiguous >= 0) {
    const i = free[contiguous]!;
    const end = new Date(i.start.getTime() + need * MINUTE);
    const rest = [...free];
    rest.splice(contiguous, 1, ...(end < i.end ? [{ start: end, end: i.end }] : []));
    return { slots: [{ start: i.start, end }], rest };
  }
  if (!split) return null;
  let left = need;
  const slots: Interval[] = [];
  const rest: Interval[] = [];
  for (const i of free) {
    const avail = mins(i);
    if (left <= 0 || avail < Math.min(minChunk, left)) {
      rest.push(i);
      continue;
    }
    let use = Math.min(avail, left);
    // Never leave a remainder smaller than a chunk for later.
    if (left - use > 0 && left - use < minChunk) use = Math.max(minChunk, left - minChunk);
    if (use < minChunk && use < left) {
      rest.push(i);
      continue;
    }
    const end = new Date(i.start.getTime() + use * MINUTE);
    slots.push({ start: i.start, end });
    if (end < i.end) rest.push({ start: end, end: i.end });
    left -= use;
  }
  return left <= 0 ? { slots, rest } : null;
}

/** Plans one day. Bounded by the candidates given (the caller caps and reports them). */
export function planDay(input: PlannerInput, dayEnd: Date): PlanResult {
  let free = freeTime(input);
  const freeMinutes = total(free);
  const existingBlockMinutes = input.blocks.reduce((n, b) => n + mins(b), 0);
  let capacityLeft = Math.max(
    0,
    Math.min(input.capacityMinutes - existingBlockMinutes, freeMinutes),
  );
  const ranked = rankTasks(input.tasks, input.day, dayEnd);
  const scheduled: PlannedItem[] = [];
  const unscheduled: Unscheduled[] = [];
  const conflicts: Conflict[] = [];
  let candidateMinutes = 0;
  let unknown = 0;
  for (const [index, t] of ranked.entries()) {
    const rank = index + 1;
    const estimate = t.estimate ?? t.assumed;
    if (estimate === null) {
      unknown++;
      unscheduled.push({
        task: t.id,
        rank,
        code: 'missing_estimate',
        minutes: null,
        detail: 'It has no estimate. Enter the minutes it needs, or plan it yourself.',
      });
      continue;
    }
    const need = Math.max(0, estimate - t.blockedMinutes);
    candidateMinutes += need;
    if (t.blockedBy.length) {
      unscheduled.push({
        task: t.id,
        rank,
        code: 'blocked',
        minutes: need,
        detail: 'It is blocked by open work.',
        blockedBy: t.blockedBy,
      });
      continue;
    }
    if (need === 0) {
      unscheduled.push({
        task: t.id,
        rank,
        code: 'already_scheduled',
        minutes: 0,
        detail: 'Existing blocks this day already cover its estimate.',
      });
      continue;
    }
    if (need > capacityLeft) {
      unscheduled.push({
        task: t.id,
        rank,
        code: 'over_capacity',
        minutes: need,
        detail: `It needs ${need} minutes; ${capacityLeft} minutes of capacity are left this day.`,
      });
      if (t.committedLocked)
        conflicts.push({
          code: 'locked_does_not_fit',
          task: t.id,
          detail:
            'A locked Today commitment does not fit the remaining capacity. Nothing is moved; change it yourself.',
        });
      continue;
    }
    const got = take(free, need, input.split && t.splittable, input.minChunk);
    if (!got) {
      unscheduled.push({
        task: t.id,
        rank,
        code: 'does_not_fit',
        minutes: need,
        detail:
          input.split && t.splittable
            ? `No free time this day holds ${need} minutes, even split.`
            : `No single free period this day holds ${need} minutes.`,
      });
      if (t.committedLocked)
        conflicts.push({
          code: 'locked_does_not_fit',
          task: t.id,
          detail:
            'A locked Today commitment does not fit any free time. Nothing is moved; change it yourself.',
        });
      continue;
    }
    free = got.rest;
    capacityLeft -= need;
    const last = got.slots[got.slots.length - 1]!;
    const warnings: PlannedItem['warnings'] = [];
    if (t.deadline && last.end > t.deadline) warnings.push('after_deadline');
    if (got.slots.length > 1) warnings.push('split');
    scheduled.push({
      task: t.id,
      rank,
      minutes: need,
      slots: got.slots,
      reasons: reasonsFor(t, input.day, dayEnd),
      warnings,
    });
  }
  if (!freeMinutes && input.tasks.length)
    conflicts.push({
      code: 'no_free_time',
      task: null,
      detail: 'There is no free working time left this day.',
    });
  // Postponement recommendations (AI-021): what did not fit, least urgent first, with the cost.
  const deferredIds = new Set(
    unscheduled
      .filter((u) => u.code === 'over_capacity' || u.code === 'does_not_fit')
      .map((u) => u.task),
  );
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const postpone: Postponement[] = ranked
    .filter((t) => deferredIds.has(t.id) && !t.committedLocked)
    .reverse()
    .map((t) => {
      const need = Math.max(0, (t.estimate ?? t.assumed ?? 0) - t.blockedMinutes);
      const why =
        t.deadline && t.deadline.getTime() <= dayEnd.getTime()
          ? 'its hard deadline is today, so postponing it misses the deadline'
          : t.dueDate && t.dueDate <= input.day
            ? `it was due ${t.dueDate}, so postponing it keeps it overdue`
            : t.dueDate
              ? `it is not due until ${t.dueDate}`
              : 'it has no due date';
      return {
        task: t.id,
        minutes: need,
        reason: `It ranks below the scheduled work (priority ${byId.get(t.id)!.priority}).`,
        tradeoff: `Postponing it keeps ${need} minutes of work off this day; ${why}. Its dates do not change unless you change them.`,
        committed: t.committed,
      };
    });
  const scheduledMinutes = scheduled.reduce((n, s) => n + s.minutes, 0);
  return {
    day: input.day,
    tz: input.tz,
    totals: {
      capacity_minutes: input.capacityMinutes,
      free_minutes: freeMinutes,
      existing_block_minutes: existingBlockMinutes,
      candidate_minutes: candidateMinutes,
      scheduled_minutes: scheduledMinutes,
      unscheduled_minutes: candidateMinutes - scheduledMinutes,
      unknown_estimates: unknown,
    },
    scheduled,
    unscheduled,
    postpone,
    conflicts,
    feasible: conflicts.length === 0 && unknown === 0 && scheduledMinutes === candidateMinutes,
  };
}

export interface EditIssue {
  block: string;
  code:
    | 'overlaps_block'
    | 'overlaps_meeting'
    | 'overlaps_plan'
    | 'outside_working_hours'
    | 'after_deadline';
  severity: 'error' | 'warning';
}

/**
 * Re-checks proposed blocks after edits (before approval): overlaps with existing blocks (locked,
 * focus, or not), meetings, or each other are errors; time outside working hours and slots after a
 * deadline are warnings. Nothing is adjusted: the person decides.
 */
export function checkEdits(
  proposed: Array<{ key: string; start: Date; end: Date; task: string | null }>,
  ctx: {
    windows: Interval[];
    meetings: Interval[];
    blocks: PlannerBlock[];
    deadlines: Map<string, Date>;
    /** Existing blocks a selected change moves or removes (they no longer occupy their time). */
    released: ReadonlySet<string>;
  },
): EditIssue[] {
  const out: EditIssue[] = [];
  const overlap = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;
  for (const [i, p] of proposed.entries()) {
    const span = { start: p.start, end: p.end };
    for (const b of ctx.blocks) {
      if (ctx.released.has(b.id)) continue;
      const busy = {
        start: new Date(b.start.getTime() - b.prep * MINUTE),
        end: new Date(b.end.getTime() + b.buffer * MINUTE),
      };
      if (overlap(span, busy)) {
        out.push({ block: p.key, code: 'overlaps_block', severity: 'error' });
        break;
      }
    }
    if (ctx.meetings.some((m) => overlap(span, m)))
      out.push({ block: p.key, code: 'overlaps_meeting', severity: 'error' });
    if (proposed.some((q, j) => j !== i && overlap(span, { start: q.start, end: q.end })))
      out.push({ block: p.key, code: 'overlaps_plan', severity: 'error' });
    const inside = merge(ctx.windows).some((w) => w.start <= p.start && p.end <= w.end);
    if (!inside) out.push({ block: p.key, code: 'outside_working_hours', severity: 'warning' });
    const dl = p.task ? ctx.deadlines.get(p.task) : undefined;
    if (dl && p.end > dl) out.push({ block: p.key, code: 'after_deadline', severity: 'warning' });
  }
  return out;
}
