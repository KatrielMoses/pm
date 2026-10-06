import { createHash } from 'node:crypto';

/**
 * Phase 3D time semantics (ADR-0019 T1–T4), pure and deterministic. Instants are UTC and whole
 * seconds; an entry also keeps the IANA zone it was recorded in and the local calendar day it
 * counts towards. Durations are differences of UTC instants, so a day that gains or loses an hour
 * to daylight saving counts the hours that actually passed. Totals are sums of exact seconds and
 * are rounded once, half-up, to hundredths of an hour for display and export.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const TZ = /^[A-Za-z]+(\/[A-Za-z0-9_+-]+)*$/;
const DAY_MS = 86_400_000;

/** An IANA zone the runtime knows (validated by formatting with it), or null. */
export function validZone(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 64 || !TZ.test(v)) return null;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: v });
    return v;
  } catch {
    return null;
  }
}

/** A real calendar date `YYYY-MM-DD` (rejects 2026-02-30), or null. */
export function validDay(v: unknown): string | null {
  if (typeof v !== 'string' || !ISO_DAY.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

/** An instant with an explicit offset (`Z` or `±hh:mm`), truncated to whole seconds, or null. */
export function parseInstant(v: unknown): Date | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(v))
    return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? wholeSecond(new Date(ms)) : null;
}

export const wholeSecond = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);

/** The calendar day of an instant in a zone. */
export function localDay(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Whole seconds between two instants (DST-safe: both are UTC). */
export const secondsBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 1000);

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar day. */
export function isoWeekday(day: string): number {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * The timesheet period containing a day: the seven days starting on the workspace's week start
 * (ISO weekday 1–7).
 */
export function periodOf(day: string, weekStart: number): { start: string; end: string } {
  const offset = (isoWeekday(day) - weekStart + 7) % 7;
  const start = addDays(day, -offset);
  return { start, end: addDays(start, 6) };
}

/** Hours from exact seconds, rounded once half-up to 0.01 h (deterministic display/export). */
export function hoursOf(seconds: number): number {
  // Integer arithmetic: hundredths of an hour = floor((s·100 + 1800) / 3600).
  return Math.floor((seconds * 100 + 1800) / 3600) / 100;
}

/** `h:mm` from exact seconds (minutes floored, never rounded up past what was recorded). */
export function clockOf(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** The evidence hash of a set of entries (order-independent). */
export function entriesHash(
  rows: Array<{ public_id: string; duration_seconds: number; billable: boolean; version: number }>,
): string {
  const lines = rows
    .map((r) => `${r.public_id}:${r.duration_seconds}:${r.billable ? 1 : 0}:${r.version}`)
    .sort();
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/** Calendar bucket of a day for period grouping. */
export function bucketOf(day: string, unit: 'day' | 'week' | 'month', weekStart: number): string {
  if (unit === 'day') return day;
  if (unit === 'month') return `${day.slice(0, 7)}-01`;
  return periodOf(day, weekStart).start;
}

/** RFC 4180 cell with formula-injection neutralization (cells starting =, +, -, @ are prefixed). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
