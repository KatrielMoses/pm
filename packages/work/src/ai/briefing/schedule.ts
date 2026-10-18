import { addDays, isoWeekday, localDay } from '../../time/semantics.ts';

/**
 * Phase 7E (BRF-014): briefing schedule arithmetic in the recipient's own timezone. Pure and
 * clock-free so it is tested against controlled instants. Binding DST rules: a local time inside a
 * spring-forward gap runs at the first valid instant after the gap; a local time repeated by a
 * fall-back fold runs once, at its earlier instant. Days and weeks are local calendar days, so a
 * window can be 23 or 25 hours long.
 */

export interface ScheduleShape {
  timezone: string;
  /** Minutes after local midnight, 0..1439. */
  local_minute: number;
  /** ISO weekdays, 1 (Monday) to 7 (Sunday). */
  weekdays: readonly number[];
}

export interface Occurrence {
  /** The intended local date, YYYY-MM-DD. */
  day: string;
  /** The intended local time, HH:MM. */
  time: string;
  /** The single instant it runs at. */
  at: Date;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The local wall-clock reading of an instant, expressed as a naive UTC millisecond count. */
function wall(t: number, tz: string): number {
  const parts = formatter(tz).formatToParts(new Date(t));
  const g = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
}

export const clock = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** The instant a local date and minute run at in `tz`, applying the gap and fold rules. */
export function occurrenceInstant(day: string, minute: number, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
  const before = naive - HOUR * 30;
  const after = naive + HOUR * 30;
  const offBefore = wall(before, tz) - before;
  const offAfter = wall(after, tz) - after;
  const valid = [naive - offBefore, naive - offAfter]
    .filter((t) => wall(t, tz) === naive)
    .sort((a, b) => a - b);
  // A fold yields two valid instants: the earlier one only.
  if (valid.length) return new Date(valid[0]!);
  // A gap: the smallest whole minute whose wall clock is at or past the intended time.
  let lo = naive - Math.max(offBefore, offAfter) - 3 * HOUR;
  let hi = naive - Math.min(offBefore, offAfter) + 3 * HOUR;
  lo = Math.floor(lo / MINUTE);
  hi = Math.ceil(hi / MINUTE);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (wall(mid * MINUTE, tz) >= naive) hi = mid;
    else lo = mid + 1;
  }
  return new Date(lo * MINUTE);
}

/** Local midnight of `day` (or the first valid instant of that day when midnight is skipped). */
export const dayStart = (day: string, tz: string): Date => occurrenceInstant(day, 0, tz);

function occurrenceOn(s: ScheduleShape, day: string): Occurrence | null {
  if (!s.weekdays.includes(isoWeekday(day))) return null;
  return {
    day,
    time: clock(s.local_minute),
    at: occurrenceInstant(day, s.local_minute, s.timezone),
  };
}

/** The first occurrence strictly after `after`, or null when no weekday is selected. */
export function nextOccurrence(s: ScheduleShape, after: Date): Occurrence | null {
  if (!s.weekdays.length) return null;
  const start = addDays(localDay(after, s.timezone), -1);
  for (let i = 0; i < 16; i++) {
    const o = occurrenceOn(s, addDays(start, i));
    if (o && o.at.getTime() > after.getTime()) return o;
  }
  return null;
}

/**
 * The occurrence a sweep at `now` owes, when `nextRunAt` has passed: the latest occurrence at or
 * before `now`. Older missed occurrences collapse into it (a briefing summarizes up to its cutoff,
 * so one run covers them); the window still starts at the previous published baseline.
 */
export function dueOccurrence(s: ScheduleShape, nextRunAt: Date, now: Date): Occurrence | null {
  if (nextRunAt.getTime() > now.getTime() || !s.weekdays.length) return null;
  const today = addDays(localDay(now, s.timezone), 1);
  for (let i = 0; i < 16; i++) {
    const o = occurrenceOn(s, addDays(today, -i));
    if (!o || o.at.getTime() > now.getTime()) continue;
    return o.at.getTime() >= nextRunAt.getTime() ? o : null;
  }
  return null;
}

/** The stable identity of one intended local occurrence of one schedule revision. */
export const occurrenceKey = (schedule: string, revision: number, o: Occurrence): string =>
  `${schedule}:r${revision}:${o.day}T${o.time}`;

export const WEEKLY_KINDS = new Set(['weekly_review']);
/** The longest reporting window a briefing reads, in local days. */
export const MAX_WINDOW_DAYS = 31;

/**
 * The reporting window ending at `cutoff`. With a comparable published baseline it starts exactly
 * at the baseline's end (no gap, no double count); otherwise it is the previous local day (daily
 * kinds) or the previous seven local days (weekly), labelled as having no baseline. A window is
 * never longer than MAX_WINDOW_DAYS local days; a clamp is reported, never silent.
 */
export function reportingWindow(
  kind: string,
  tz: string,
  cutoff: Date,
  baselineEnd: Date | null,
): { start: Date; end: Date; clamped: boolean } {
  const today = localDay(cutoff, tz);
  const earliest = dayStart(addDays(today, -MAX_WINDOW_DAYS), tz);
  if (baselineEnd && baselineEnd.getTime() < cutoff.getTime()) {
    if (baselineEnd.getTime() < earliest.getTime())
      return { start: earliest, end: cutoff, clamped: true };
    return { start: baselineEnd, end: cutoff, clamped: false };
  }
  const span = WEEKLY_KINDS.has(kind) ? 7 : 1;
  return { start: dayStart(addDays(today, -span), tz), end: cutoff, clamped: false };
}
