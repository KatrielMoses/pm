/**
 * Recurrence rules for recurring projects (OD-14): a bounded RFC 5545 subset anchored to an IANA
 * time zone. Occurrence keys are the occurrence's local date-time in the anchor zone
 * (`YYYY-MM-DDTHH:mm`), stable across DST and server zones, so generation is idempotent through
 * the `(recurrence_series_id, occurrence_key)` uniqueness on the target table.
 *
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL=1..366, BYDAY=MO..SU (WEEKLY),
 * BYMONTHDAY=1..31 (MONTHLY; months without that day are skipped), and one end condition:
 * COUNT=1..999 (occurrences counted from the start) or UNTIL=YYYYMMDD (a local date in the anchor
 * zone, inclusive). Anything else, including BYSETPOS, is refused.
 */

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

export interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byDay: number[] | null;
  byMonthDay: number[] | null;
  /** COUNT: total occurrences from the start. */
  count: number | null;
  /** UNTIL as a local date `YYYY-MM-DD` (inclusive) in the anchor zone. */
  until: string | null;
}

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const COUNT_MAX = 999;

export const isCalendarDate = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

export class RuleError extends Error {
  constructor() {
    super('unsupported recurrence rule');
    this.name = 'RuleError';
  }
}

export function parseRule(rrule: string): Rule {
  const parts = new Map<string, string>();
  for (const seg of rrule.split(';')) {
    const [k, v] = seg.split('=');
    if (!k || !v || parts.has(k)) throw new RuleError();
    parts.set(k, v);
  }
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY')
    throw new RuleError();
  for (const k of parts.keys())
    if (!['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL'].includes(k))
      throw new RuleError();
  const interval = parts.has('INTERVAL') ? Number(parts.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 366) throw new RuleError();
  let byDay: number[] | null = null;
  if (parts.has('BYDAY')) {
    if (freq !== 'WEEKLY') throw new RuleError();
    byDay = parts
      .get('BYDAY')!
      .split(',')
      .map((d) => DAYS.indexOf(d as (typeof DAYS)[number]));
    if (byDay.some((d) => d < 0) || new Set(byDay).size !== byDay.length) throw new RuleError();
    byDay.sort((a, b) => a - b);
  }
  let byMonthDay: number[] | null = null;
  if (parts.has('BYMONTHDAY')) {
    if (freq !== 'MONTHLY') throw new RuleError();
    byMonthDay = parts.get('BYMONTHDAY')!.split(',').map(Number);
    if (byMonthDay.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) throw new RuleError();
    byMonthDay = [...new Set(byMonthDay)].sort((a, b) => a - b);
  }
  if (parts.has('COUNT') && parts.has('UNTIL')) throw new RuleError();
  let count: number | null = null;
  if (parts.has('COUNT')) {
    count = Number(parts.get('COUNT'));
    if (!/^\d+$/.test(parts.get('COUNT')!) || count < 1 || count > COUNT_MAX) throw new RuleError();
  }
  let until: string | null = null;
  if (parts.has('UNTIL')) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(parts.get('UNTIL')!);
    if (!m || !isCalendarDate(+m[1]!, +m[2]!, +m[3]!)) throw new RuleError();
    until = `${m[1]}-${m[2]}-${m[3]}`;
  }
  return { freq, interval, byDay, byMonthDay, count, until };
}

/** The structured rule people choose in the UI (and the API accepts), as a canonical RRULE. */
export interface RuleInput {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  weekdays: Weekday[] | null;
  monthDays: number[] | null;
  ends: { type: 'never' } | { type: 'after'; count: number } | { type: 'on'; date: string };
}

export function composeRule(r: RuleInput): string {
  const parts = [`FREQ=${r.frequency.toUpperCase()}`];
  if (r.interval !== 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.weekdays)
    parts.push(
      `BYDAY=${[...r.weekdays].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)).join(',')}`,
    );
  if (r.monthDays) parts.push(`BYMONTHDAY=${[...r.monthDays].sort((a, b) => a - b).join(',')}`);
  if (r.ends.type === 'after') parts.push(`COUNT=${r.ends.count}`);
  if (r.ends.type === 'on') parts.push(`UNTIL=${r.ends.date.replace(/-/g, '')}`);
  return parts.join(';');
}

/** The structured form of a stored rule (for display and editing). */
export function describeRule(rrule: string): RuleInput {
  const r = parseRule(rrule);
  return {
    frequency: r.freq.toLowerCase() as RuleInput['frequency'],
    interval: r.interval,
    weekdays: r.byDay ? r.byDay.map((d) => DAYS[d]!) : null,
    monthDays: r.byMonthDay,
    ends:
      r.count !== null
        ? { type: 'after', count: r.count }
        : r.until !== null
          ? { type: 'on', date: r.until }
          : { type: 'never' },
  };
}

/** A local date-time (no zone) as calendar fields. */
interface Local {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
}

function parseLocal(s: string): Local {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) throw new RuleError();
  return { y: +m[1]!, m: +m[2]!, d: +m[3]!, hh: +m[4]!, mm: +m[5]! };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export function formatLocal(l: Local): string {
  return `${pad(l.y, 4)}-${pad(l.m)}-${pad(l.d)}T${pad(l.hh)}:${pad(l.mm)}`;
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayNumber = (l: Local) => Date.UTC(l.y, l.m - 1, l.d) / 86_400_000;
const fromDayNumber = (n: number, hh: number, mm: number): Local => {
  const d = new Date(n * 86_400_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh, mm };
};

/**
 * Occurrences strictly after `after` (or from `dtstart` inclusive when null), at most `limit`,
 * none later than `through` (inclusive) when given. Pure calendar arithmetic in local time.
 */
export function occurrences(
  rule: Rule,
  dtstart: string,
  after: string | null,
  limit: number,
  through: string | null = null,
): string[] {
  // UNTIL ends the series at the end of that local day; COUNT counts from the start, so the whole
  // counted prefix is computed first (bounded by COUNT_MAX) and then filtered.
  const end = rule.until ? `${rule.until}T23:59` : null;
  const bound = end !== null && (through === null || end < through) ? end : through;
  if (rule.count !== null)
    return scan(rule, dtstart, null, rule.count, bound)
      .filter((k) => after === null || k > after)
      .slice(0, limit);
  return scan(rule, dtstart, after, limit, bound);
}

function scan(
  rule: Rule,
  dtstart: string,
  after: string | null,
  limit: number,
  through: string | null,
): string[] {
  const start = parseLocal(dtstart);
  const out: string[] = [];
  const accept = (l: Local) => {
    const s = formatLocal(l);
    if (s < dtstart) return true;
    if (after !== null && s <= after) return true;
    if (through !== null && s > through) return false;
    out.push(s);
    return out.length < limit;
  };
  const startDay = dayNumber(start);
  // Start at the period containing `after`, then scan a bounded number of periods (callers bound
  // `limit` far below this).
  let first = 0;
  if (after !== null && after > dtstart) {
    const a = parseLocal(after);
    const span =
      rule.freq === 'DAILY'
        ? dayNumber(a) - startDay
        : rule.freq === 'WEEKLY'
          ? Math.floor((dayNumber(a) - startDay) / 7)
          : rule.freq === 'MONTHLY'
            ? (a.y - start.y) * 12 + (a.m - start.m)
            : a.y - start.y;
    first = Math.max(0, Math.floor(span / rule.interval) - 1);
  }
  const periods = Math.max(400, (rule.count ?? 0) * 4 + 8);
  for (let period = first; period < first + periods && out.length < limit; period++) {
    let cont = true;
    if (rule.freq === 'DAILY') {
      cont = accept(fromDayNumber(startDay + period * rule.interval, start.hh, start.mm));
    } else if (rule.freq === 'WEEKLY') {
      const weekStart =
        startDay + period * 7 * rule.interval - new Date(startDay * 86_400_000).getUTCDay();
      const days = rule.byDay ?? [new Date(startDay * 86_400_000).getUTCDay()];
      for (const wd of days) {
        cont = accept(fromDayNumber(weekStart + wd, start.hh, start.mm));
        if (!cont) break;
      }
    } else if (rule.freq === 'MONTHLY') {
      const total = start.y * 12 + (start.m - 1) + period * rule.interval;
      const y = Math.floor(total / 12);
      const m = (total % 12) + 1;
      for (const md of rule.byMonthDay ?? [start.d]) {
        if (md > daysInMonth(y, m)) continue;
        cont = accept({ y, m, d: md, hh: start.hh, mm: start.mm });
        if (!cont) break;
      }
    } else {
      const y = start.y + period * rule.interval;
      if (start.m === 2 && start.d === 29 && daysInMonth(y, 2) < 29) continue;
      cont = accept({ y, m: start.m, d: start.d, hh: start.hh, mm: start.mm });
    }
    if (!cont) break;
  }
  return out;
}

/** The UTC instant of a local date-time in `tz` (gaps resolve forward, overlaps to the first). */
export function localToUtc(local: string, tz: string): Date {
  const l = parseLocal(local);
  const guess = Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm);
  const offset = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(t));
    const g = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t);
}

/** The local date-time in `tz` of an instant (for "now" in the anchor zone). */
export function utcToLocal(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const g = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return formatLocal({ y: g('year'), m: g('month'), d: g('day'), hh: g('hour'), mm: g('minute') });
}
