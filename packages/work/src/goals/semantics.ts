import { addDays, daysBetween, validDay } from '../time/semantics.ts';

/**
 * Phase 5B goal and portfolio rules (ADR-0028). Everything here is a pure, deterministic function
 * of its inputs, so every figure can be explained with the rule that produced it. The inputs a
 * caller passes are only the work the viewer may read (OD-07, OD-13); nothing here weights by
 * estimate, invents a business outcome, or defines a metric (5C).
 */

export const GOAL_STATUSES = ['draft', 'active', 'achieved', 'missed', 'cancelled'] as const;
export type GoalStatusKey = (typeof GOAL_STATUSES)[number];
export const PERIOD_KINDS = ['quarter', 'half', 'year', 'custom'] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];
export const GOAL_BASES = ['manual', 'key_results', 'linked_work'] as const;
export type GoalBasisKey = (typeof GOAL_BASES)[number];
export const CONFIDENCES = ['on_track', 'at_risk', 'off_track'] as const;
export type ConfidenceKey = (typeof CONFIDENCES)[number];

export const CONFIDENCE_LABEL: Record<ConfidenceKey, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
};

// ---------------------------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------------------------

export interface Period {
  kind: PeriodKind;
  start: string;
  end: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * A calendar period from its parts, or null when they do not name one. `quarter` takes
 * `index` 1–4, `half` 1–2, `year` needs none, and `custom` takes explicit days (at most ten
 * years). Fiscal calendars are not modelled: a quarter is a calendar quarter (ADR-0028 G2).
 */
export function periodOf(input: {
  kind: unknown;
  year?: unknown;
  index?: unknown;
  start?: unknown;
  end?: unknown;
}): Period | null {
  const kind = input.kind;
  if (kind === 'custom') {
    const start = validDay(input.start);
    const end = validDay(input.end);
    if (!start || !end || end < start || daysBetween(start, end) > 3660) return null;
    return { kind, start, end };
  }
  const year = input.year;
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 2000 || year > 2200) return null;
  if (kind === 'year') return { kind, start: `${year}-01-01`, end: `${year}-12-31` };
  const index = input.index;
  if (typeof index !== 'number' || !Number.isInteger(index)) return null;
  if (kind === 'half' && (index === 1 || index === 2)) {
    const m0 = index === 1 ? 1 : 7;
    const m1 = index === 1 ? 6 : 12;
    return { kind, start: `${year}-${pad(m0)}-01`, end: `${year}-${pad(m1)}-${pad(lastDayOf(year, m1))}` };
  }
  if (kind === 'quarter' && index >= 1 && index <= 4) {
    const m0 = (index - 1) * 3 + 1;
    const m1 = m0 + 2;
    return { kind, start: `${year}-${pad(m0)}-01`, end: `${year}-${pad(m1)}-${pad(lastDayOf(year, m1))}` };
  }
  return null;
}

/** "2026 Q4", "2026 H2", "2026", or "2026-10-01 to 2026-12-15". */
export function periodLabel(p: Period): string {
  const year = Number(p.start.slice(0, 4));
  const month = Number(p.start.slice(5, 7));
  if (p.kind === 'quarter') return `${year} Q${Math.floor((month - 1) / 3) + 1}`;
  if (p.kind === 'half') return `${year} H${month <= 6 ? 1 : 2}`;
  if (p.kind === 'year') return String(year);
  return `${p.start} to ${p.end}`;
}

export type PeriodState = 'upcoming' | 'current' | 'ended';
export function periodState(today: string, p: { start: string; end: string }): PeriodState {
  return today < p.start ? 'upcoming' : today > p.end ? 'ended' : 'current';
}

/** Whether a stored period still names the calendar period its kind claims. */
export function periodIsCanonical(p: Period): boolean {
  if (p.kind === 'custom') return true;
  const year = Number(p.start.slice(0, 4));
  const month = Number(p.start.slice(5, 7));
  const index = p.kind === 'quarter' ? Math.floor((month - 1) / 3) + 1 : p.kind === 'half' ? (month <= 6 ? 1 : 2) : 0;
  const canon = periodOf({ kind: p.kind, year, index });
  return !!canon && canon.start === p.start && canon.end === p.end;
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Measured progress toward a target: how far the current value has moved from the baseline toward
 * the target, clamped to 0–100. The direction is the order of baseline and target, so a target
 * below its baseline means "reduce". Null when there is no measurement yet.
 */
export function metricPercent(m: {
  baseline: number | null;
  target: number | null;
  current: number | null;
}): number | null {
  if (m.baseline === null || m.target === null || m.current === null || m.baseline === m.target)
    return null;
  const raw = ((m.current - m.baseline) / (m.target - m.baseline)) * 100;
  return round2(Math.min(100, Math.max(0, raw)));
}

/**
 * Completion of linked work (OD-13): done leaf tasks over non-cancelled leaf tasks the viewer may
 * read, rounded to a whole percent. Null when there is nothing to count.
 */
export function workPercent(done: number, total: number): number | null {
  if (!(total > 0)) return null;
  return Math.round((Math.min(done, total) / total) * 100);
}

export interface KeyResultProgress {
  percent: number | null;
  basis: 'manual' | 'linked_work';
}

/**
 * A goal's progress from its key results: the plain mean of the key results that have a
 * measurement. A key result that measures linked work depends on the viewer, so a rollup that
 * includes one is viewer-dependent and is never stored. `counted` of `total` says how complete it is.
 */
export function rollup(krs: readonly KeyResultProgress[]): {
  percent: number | null;
  counted: number;
  total: number;
  viewerDependent: boolean;
} {
  const measured = krs.filter((k) => k.percent !== null);
  const percent = measured.length
    ? round2(measured.reduce((n, k) => n + (k.percent as number), 0) / measured.length)
    : null;
  return {
    percent,
    counted: measured.length,
    total: krs.length,
    viewerDependent: krs.some((k) => k.basis === 'linked_work'),
  };
}

// ---------------------------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------------------------

export type UpdateState = 'never' | 'fresh' | 'stale';
/** `never` before any manual check-in; `stale` once the newest is older than `staleDays`. */
export function updateState(latest: Date | null, now: Date, staleDays: number): UpdateState {
  if (!latest) return 'never';
  return now.getTime() - latest.getTime() > staleDays * 86_400_000 ? 'stale' : 'fresh';
}

export function daysSince(at: Date | null, now: Date): number | null {
  return at ? Math.floor((now.getTime() - at.getTime()) / 86_400_000) : null;
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

/** `draft` is where a goal starts; once it has left draft it cannot return. */
export function statusChangeAllowed(from: GoalStatusKey, to: GoalStatusKey): boolean {
  if (from === to) return true;
  if (to === 'draft') return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Project health (GOAL-007, GOAL-009): explainable rules over what the viewer may read
// ---------------------------------------------------------------------------------------------

export type ProjectHealth = 'on_track' | 'at_risk' | 'off_track' | 'complete' | 'unknown';
export type Severity = 'at_risk' | 'off_track';

export interface HealthInput {
  today: string;
  statusCategory: 'planned' | 'active' | 'paused' | 'done' | 'cancelled';
  startDate: string | null;
  targetDate: string | null;
  deadlineDate: string | null;
  /** Readable leaf tasks, OD-13. */
  done: number;
  total: number;
  /** Open readable leaf tasks past their due date or deadline. */
  overdue: number;
  /** Open readable leaf tasks that an open task blocks or that are in a paused status. */
  blocked: number;
  timeBudgetMinutes: number | null;
  loggedMinutes: number;
}

export interface HealthReason {
  code:
    | 'deadline_passed'
    | 'target_passed'
    | 'behind_schedule'
    | 'overdue_tasks'
    | 'blocked_tasks'
    | 'time_budget_exceeded'
    | 'time_budget_nearly_used';
  severity: Severity;
  message: string;
  facts: Record<string, number | string>;
}

export type Completeness =
  | 'no_dates'
  | 'no_tasks'
  | 'no_time_budget'
  | 'paused'
  | 'cancelled'
  | 'not_started';

export interface HealthResult {
  health: ProjectHealth;
  reasons: HealthReason[];
  /** What was missing, so a quiet result is never mistaken for a clean one. */
  incomplete: Completeness[];
}

/** Behind-schedule thresholds, in percentage points of completion below the elapsed share. */
export const BEHIND_AT_RISK = 20;
export const BEHIND_OFF_TRACK = 40;
/** Overdue and blocked shares of the open tasks. */
export const OVERDUE_AT_RISK_SHARE = 0.25;
export const OVERDUE_OFF_TRACK_SHARE = 0.5;
export const BLOCKED_AT_RISK_SHARE = 0.25;
/** Days past a target date before a project is off track rather than at risk. */
export const TARGET_OFF_TRACK_DAYS = 14;

/**
 * Health is the worst severity any rule reports; with no rule triggered it is `on_track` only when
 * there was evidence to evaluate (tasks, or dates), else `unknown`. A completed project is
 * `complete`. A planned, paused, or cancelled project is judged only against its dates. The
 * result never overwrites the project's declared health (2A): the two are shown side by side.
 */
export function evaluateHealth(i: HealthInput): HealthResult {
  const reasons: HealthReason[] = [];
  const incomplete: Completeness[] = [];
  if (i.statusCategory === 'done') return { health: 'complete', reasons, incomplete };
  if (i.statusCategory === 'cancelled')
    return { health: 'unknown', reasons, incomplete: ['cancelled'] };
  const dates = i.targetDate ?? i.deadlineDate;
  if (!i.startDate && !i.targetDate && !i.deadlineDate) incomplete.push('no_dates');
  if (!(i.total > 0)) incomplete.push('no_tasks');
  if (i.timeBudgetMinutes === null) incomplete.push('no_time_budget');
  if (i.statusCategory === 'paused') incomplete.push('paused');
  if (i.statusCategory === 'planned') incomplete.push('not_started');

  if (i.deadlineDate && i.deadlineDate < i.today)
    reasons.push({
      code: 'deadline_passed',
      severity: 'off_track',
      message: `The deadline (${i.deadlineDate}) has passed and the project is not complete.`,
      facts: { deadline: i.deadlineDate, days_late: daysBetween(i.deadlineDate, i.today) },
    });
  if (i.targetDate && i.targetDate < i.today) {
    const late = daysBetween(i.targetDate, i.today);
    reasons.push({
      code: 'target_passed',
      severity: late > TARGET_OFF_TRACK_DAYS ? 'off_track' : 'at_risk',
      message: `The target date (${i.targetDate}) passed ${late} day${late === 1 ? '' : 's'} ago.`,
      facts: { target: i.targetDate, days_late: late },
    });
  }
  const active = i.statusCategory === 'active';
  const open = Math.max(i.total - i.done, 0);
  if (active && i.startDate && dates && dates > i.startDate && i.total > 0 && i.today >= i.startDate) {
    const span = daysBetween(i.startDate, dates);
    const elapsed = Math.min(Math.max(daysBetween(i.startDate, i.today), 0), span);
    const expected = Math.round((elapsed / span) * 100);
    const actual = Math.round((i.done / i.total) * 100);
    const lag = expected - actual;
    if (lag >= BEHIND_AT_RISK)
      reasons.push({
        code: 'behind_schedule',
        severity: lag >= BEHIND_OFF_TRACK ? 'off_track' : 'at_risk',
        message: `${actual}% of tasks are done, against ${expected}% of the time elapsed.`,
        facts: { expected_percent: expected, actual_percent: actual, behind_points: lag },
      });
  }
  if (active && open > 0 && i.overdue > 0) {
    const share = i.overdue / open;
    if (share >= OVERDUE_AT_RISK_SHARE)
      reasons.push({
        code: 'overdue_tasks',
        severity: share >= OVERDUE_OFF_TRACK_SHARE ? 'off_track' : 'at_risk',
        message: `${i.overdue} of ${open} open tasks are past due.`,
        facts: { overdue: i.overdue, open },
      });
  }
  if (active && open > 0 && i.blocked > 0 && i.blocked / open >= BLOCKED_AT_RISK_SHARE)
    reasons.push({
      code: 'blocked_tasks',
      severity: 'at_risk',
      message: `${i.blocked} of ${open} open tasks are blocked.`,
      facts: { blocked: i.blocked, open },
    });
  if (i.timeBudgetMinutes !== null && i.timeBudgetMinutes > 0) {
    if (i.loggedMinutes > i.timeBudgetMinutes)
      reasons.push({
        code: 'time_budget_exceeded',
        severity: 'off_track',
        message: `${i.loggedMinutes} of ${i.timeBudgetMinutes} budgeted minutes are logged.`,
        facts: { logged: i.loggedMinutes, budget: i.timeBudgetMinutes },
      });
    else if (i.loggedMinutes >= i.timeBudgetMinutes * 0.9) {
      const actual = i.total > 0 ? Math.round((i.done / i.total) * 100) : 0;
      if (actual < 90)
        reasons.push({
          code: 'time_budget_nearly_used',
          severity: 'at_risk',
          message: `${i.loggedMinutes} of ${i.timeBudgetMinutes} budgeted minutes are logged with ${actual}% of tasks done.`,
          facts: { logged: i.loggedMinutes, budget: i.timeBudgetMinutes, actual_percent: actual },
        });
    }
  }
  const worst: ProjectHealth = reasons.some((r) => r.severity === 'off_track')
    ? 'off_track'
    : reasons.length
      ? 'at_risk'
      : i.total > 0 || dates || i.startDate
        ? 'on_track'
        : 'unknown';
  return { health: worst, reasons, incomplete };
}

export const HEALTH_LABEL: Record<ProjectHealth, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
  complete: 'Complete',
  unknown: 'Not enough information',
};

// ---------------------------------------------------------------------------------------------
// Dependencies (GOAL-010): a `blocks` edge between tasks of two different projects
// ---------------------------------------------------------------------------------------------

export type DependencyState = 'resolved' | 'open' | 'overdue' | 'late';

/**
 * The state of a cross-project dependency (the blocker is the task that must finish first):
 * `resolved` once the blocker is done or cancelled; `overdue` when it is open and past its due
 * date; `late` when it is open and due after the date the blocked task is due; else `open`.
 */
export function dependencyState(e: {
  blockerCategory: string;
  blockerDue: string | null;
  blockedDue: string | null;
  today: string;
}): DependencyState {
  if (e.blockerCategory === 'done' || e.blockerCategory === 'cancelled') return 'resolved';
  if (e.blockerDue && e.blockerDue < e.today) return 'overdue';
  if (e.blockerDue && e.blockedDue && e.blockerDue > e.blockedDue) return 'late';
  return 'open';
}

// ---------------------------------------------------------------------------------------------
// Orphans (GOAL-012, GOAL-013)
// ---------------------------------------------------------------------------------------------

/** A project counts for orphan detection while it can still take goal work. */
export const ORPHAN_PROJECT_CATEGORIES = ['planned', 'active', 'paused'] as const;
/** Work a goal can lean on: a project that is planned or active, or a task that is not finished. */
export function projectIsActiveWork(category: string): boolean {
  return category === 'planned' || category === 'active';
}
export function taskIsActiveWork(category: string): boolean {
  return category !== 'done' && category !== 'cancelled';
}

export { addDays };
