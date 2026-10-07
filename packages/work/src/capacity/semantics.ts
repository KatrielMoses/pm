import { localToUtc } from '../recurrence.ts';
import { dayBounds } from '../planning/semantics.ts';
import { addDays, isoWeekday } from '../time/semantics.ts';

/**
 * Phase 3E capacity semantics (ADR-0022 C1–C3; 0A §5). Working hours are local wall-clock
 * windows in the person's own zone, turned into instants per date with the same conversion the
 * rest of the product uses (2A rule engine, 3C day bounds): gaps resolve forward, overlaps to the
 * first instant. A day that gains or loses an hour therefore has its real length. Availability is
 * working time minus time off and observed holidays; capacity use comes from the person's own
 * blocks and estimates. Everything here is pure and works on whole minutes.
 */

export interface WorkingWindow {
  /** 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** Local minutes from midnight, [start, end). */
  start: number;
  end: number;
}

export interface Interval {
  start: Date;
  end: Date;
}

const clock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The instants of a person's working windows on one local date. */
export function workingIntervals(day: string, tz: string, windows: WorkingWindow[]): Interval[] {
  const wd = isoWeekday(day);
  return windows
    .filter((w) => w.weekday === wd)
    .sort((a, b) => a.start - b.start)
    .map((w) => ({
      start: localToUtc(`${day}T${clock(w.start)}`, tz),
      end: w.end >= 1440 ? dayBounds(day, tz).end : localToUtc(`${day}T${clock(w.end)}`, tz),
    }))
    .filter((i) => i.end > i.start);
}

/** Merges overlapping intervals (sorted, non-overlapping output). */
export function merge(intervals: Interval[]): Interval[] {
  const s = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const i of s) {
    const last = out.at(-1);
    if (last && i.start <= last.end) {
      if (i.end > last.end) last.end = i.end;
    } else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** `base` minus every interval in `remove`. */
export function subtract(base: Interval[], remove: Interval[]): Interval[] {
  const cuts = merge(remove);
  let out = merge(base);
  for (const c of cuts) {
    const next: Interval[] = [];
    for (const i of out) {
      if (c.end <= i.start || c.start >= i.end) next.push(i);
      else {
        if (c.start > i.start) next.push({ start: i.start, end: c.start });
        if (c.end < i.end) next.push({ start: c.end, end: i.end });
      }
    }
    out = next;
  }
  return out;
}

/** The overlap of two interval sets. */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of merge(a))
    for (const y of merge(b)) {
      const s = x.start > y.start ? x.start : y.start;
      const e = x.end < y.end ? x.end : y.end;
      if (e > s) out.push({ start: s, end: e });
    }
  return merge(out);
}

export const minutes = (intervals: Interval[]) =>
  Math.round(
    merge(intervals).reduce((n, i) => n + (i.end.getTime() - i.start.getTime()), 0) / 60_000,
  );

/** The nominal weekly minutes of a set of windows (no time off; a plain local week). */
export const nominalWeekMinutes = (windows: WorkingWindow[]) =>
  windows.reduce((n, w) => n + (w.end - w.start), 0);

/** All-day time off (inclusive local dates in its own zone) as instants. */
export function allDayInterval(startsOn: string, endsOn: string, tz: string): Interval {
  return { start: dayBounds(startsOn, tz).start, end: dayBounds(endsOn, tz).end };
}

export interface DayAvailability {
  day: string;
  /** Working minutes before time off (the real length on DST days). */
  working: number;
  /** Working minutes removed by time off and observed holidays. */
  off: number;
  /** Minutes the person can work this day (after a weekly-capacity override scales it). */
  available: number;
  /** Working intervals left after time off (for conflict and block checks). */
  intervals: Interval[];
  holiday: boolean;
}

/**
 * Availability for each local date in [from, to]. A weekly-capacity override scales each day's
 * working minutes by override / nominal week (so a 32 h override on a 40 h week keeps 80% of
 * every working day); time off and observed holidays remove their part after scaling.
 */
export function availability(input: {
  from: string;
  to: string;
  tz: string;
  windows: WorkingWindow[];
  timeOff: Interval[];
  holidays: ReadonlySet<string>;
  weeklyOverride: number | null;
}): DayAvailability[] {
  const nominal = nominalWeekMinutes(input.windows);
  const scale = input.weeklyOverride === null || nominal === 0 ? 1 : input.weeklyOverride / nominal;
  const out: DayAvailability[] = [];
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) {
    const work = workingIntervals(d, input.tz, input.windows);
    const holiday = input.holidays.has(d);
    const remove = holiday ? [...input.timeOff, dayBounds(d, input.tz)] : input.timeOff;
    const left = subtract(work, remove);
    const working = minutes(work);
    const kept = minutes(left);
    out.push({
      day: d,
      working,
      off: working - kept,
      available: Math.round(kept * scale),
      intervals: left,
      holiday,
    });
  }
  return out;
}

/** Over or under allocation for a period (TIME-007): positive `over` means more planned than available. */
export function allocation(available: number, planned: number) {
  const over = planned - available;
  return {
    available,
    planned,
    over: over > 0 ? over : 0,
    under: over < 0 ? -over : 0,
    state:
      over > 0
        ? ('over' as const)
        : available > 0 && planned < available * 0.5
          ? ('under' as const)
          : ('ok' as const),
  };
}

export interface Placed {
  id: string;
  brand: string | null;
  start: Date;
  end: Date;
}

/** Overlapping items of different brands (CAL-009, WSB-018): one conflict per overlapping pair. */
export function crossBrandOverlaps(items: Placed[]) {
  const s = [...items].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Array<{ a: Placed; b: Placed; minutes: number }> = [];
  for (let i = 0; i < s.length; i++)
    for (let j = i + 1; j < s.length && s[j]!.start < s[i]!.end; j++) {
      const a = s[i]!;
      const b = s[j]!;
      if (!a.brand || !b.brand || a.brand === b.brand) continue;
      const end = a.end < b.end ? a.end : b.end;
      out.push({ a, b, minutes: Math.round((end.getTime() - b.start.getTime()) / 60_000) });
    }
  return out;
}
