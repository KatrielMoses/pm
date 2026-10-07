import { localToUtc } from '../recurrence.ts';
import { addDays } from '../time/semantics.ts';

/**
 * Phase 3C day semantics (ADR-0021 P1). A Today day is a calendar date in the viewer's zone
 * (OD-18). Its bounds are the UTC instants of local midnight and the next local midnight, so a
 * day that gains or loses an hour to daylight saving is 25 or 23 hours long. Gaps resolve forward
 * and overlaps to the first instant (the 2A rule engine's conversion).
 */
export function dayBounds(day: string, tz: string): { start: Date; end: Date } {
  return {
    start: localToUtc(`${day}T00:00`, tz),
    end: localToUtc(`${addDays(day, 1)}T00:00`, tz),
  };
}

/** Whole minutes between two instants. */
export const minutesBetween = (a: Date, b: Date) =>
  Math.round((b.getTime() - a.getTime()) / 60_000);

/** An instant truncated to the minute (blocks are whole minutes). */
export const wholeMinute = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000);

/** `HH:MM` (24-hour) or null. */
export function validClock(v: unknown): string | null {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null;
}

/**
 * Where a block ends relative to a task's dates (CAL-013): after the due date's local day ends,
 * or after the deadline (a date's local end, or an exact instant). Warnings only: a block never
 * changes either date.
 */
export function blockWarnings(
  end: Date,
  tz: string,
  task: { due_date: string | null; deadline_date: string | null; deadline_at: Date | null },
): Array<'after_due_date' | 'after_deadline'> {
  const out: Array<'after_due_date' | 'after_deadline'> = [];
  if (task.due_date && end > dayBounds(task.due_date, tz).end) out.push('after_due_date');
  const deadline =
    task.deadline_at ?? (task.deadline_date ? dayBounds(task.deadline_date, tz).end : null);
  if (deadline && end > deadline) out.push('after_deadline');
  return out;
}
