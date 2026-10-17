import { localToUtc, occurrences, parseRule, RuleError, utcToLocal } from '../recurrence.ts';
import { dayBounds } from '../planning/semantics.ts';
import { addDays } from '../time/semantics.ts';
import type { ProviderEvent, ProviderTime } from './calendar-provider.ts';

/**
 * Provider recurrence on the shared recurrence contract (0B §6.4, ADR-0037 G5). A recurring
 * provider event becomes a series anchored to its own IANA zone; occurrences are evaluated in that
 * zone with the same engine recurring tasks and blocks use, so 16:00 Lisbon stays 16:00 Lisbon
 * across DST. Occurrence keys are the original local start (`YYYY-MM-DDTHH:mm`, or `YYYY-MM-DD`
 * for all-day). Exceptions (EXDATE, cancelled or moved instances) name that key.
 *
 * Rules the engine cannot evaluate exactly (ordinal BYDAY, BYSETPOS, BYMONTH, RDATE, EXRULE,
 * multi-day weekly rules with an interval) are marked unsupported and expanded from the
 * provider's own instance list instead. Nothing is approximated.
 */

export interface NormalizedRecurrence {
  /** The engine-subset rule, or null when the provider must expand it. */
  rrule: string | null;
  /** Exact UNTIL instant (occurrences starting after it are dropped). */
  untilAt: Date | null;
  /** Occurrence keys removed by EXDATE. */
  exdates: string[];
}

const COMPACT = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/** A compact RFC 5545 date or date-time as an occurrence key in `anchorTz`. */
function compactKey(value: string, tzid: string | null, anchorTz: string, allDay: boolean) {
  const m = COMPACT.exec(value);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (allDay || m[4] === undefined) return allDay ? date : `${date}T00:00`;
  const local = `${date}T${m[4]}:${m[5]}`;
  const at = m[7] ? new Date(`${local}:${m[6]}Z`) : localToUtc(local, tzid ?? anchorTz);
  return utcToLocal(at, anchorTz);
}

export function normalizeRecurrence(
  lines: readonly string[],
  anchorTz: string,
  allDay: boolean,
): NormalizedRecurrence {
  let rrule: string | null = null;
  let untilAt: Date | null = null;
  let unsupported = false;
  const exdates: string[] = [];
  let rules = 0;
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) {
      unsupported = true;
      continue;
    }
    const head = line.slice(0, colon).toUpperCase();
    const value = line.slice(colon + 1).trim();
    const [name, ...params] = head.split(';');
    if (name === 'RRULE') {
      rules += 1;
      const r = normalizeRule(value, anchorTz, allDay);
      if (!r) unsupported = true;
      else {
        rrule = r.rrule;
        untilAt = r.untilAt;
      }
    } else if (name === 'EXDATE') {
      const tzid = params.find((p) => p.startsWith('TZID='))?.slice(5) ?? null;
      // TZID values keep their case in the original line.
      const tzOriginal = tzid ? (/TZID=([^;:]+)/i.exec(line.slice(0, colon))?.[1] ?? null) : null;
      for (const v of value.split(',')) {
        const key = compactKey(v.trim(), tzOriginal, anchorTz, allDay);
        if (key) exdates.push(key);
        else unsupported = true;
      }
    } else unsupported = true; // RDATE, EXRULE, or anything else
  }
  if (rules !== 1 || unsupported) return { rrule: null, untilAt, exdates };
  return { rrule, untilAt, exdates };
}

function normalizeRule(value: string, anchorTz: string, allDay: boolean) {
  const parts = new Map<string, string>();
  for (const seg of value.split(';')) {
    const [k, v] = seg.split('=');
    if (!k || !v || parts.has(k.toUpperCase())) return null;
    parts.set(k.toUpperCase(), v.toUpperCase());
  }
  // Week start only changes multi-day weekly rules with an interval; those are refused below.
  parts.delete('WKST');
  let untilAt: Date | null = null;
  const until = parts.get('UNTIL');
  if (until) {
    const m = COMPACT.exec(until);
    if (!m) return null;
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    if (m[4] === undefined || allDay) {
      untilAt = allDay ? dayBounds(date, anchorTz).end : localToUtc(`${date}T23:59`, anchorTz);
      parts.set('UNTIL', `${m[1]}${m[2]}${m[3]}`);
    } else {
      const local = `${date}T${m[4]}:${m[5]}`;
      untilAt = m[7] ? new Date(`${local}:${m[6]}Z`) : localToUtc(local, anchorTz);
      // The engine bounds by local date; the exact instant is applied afterwards.
      parts.set('UNTIL', utcToLocal(untilAt, anchorTz).slice(0, 10).replace(/-/g, ''));
    }
  }
  const byDay = parts.get('BYDAY');
  if (byDay && byDay.split(',').some((d) => !/^(MO|TU|WE|TH|FR|SA|SU)$/.test(d))) return null;
  const interval = Number(parts.get('INTERVAL') ?? '1');
  if (parts.get('FREQ') === 'WEEKLY' && interval > 1 && byDay && byDay.split(',').length > 1)
    return null;
  const rrule = [...parts.entries()].map(([k, v]) => `${k}=${v}`).join(';');
  try {
    parseRule(rrule);
  } catch (err) {
    if (err instanceof RuleError) return null;
    throw err;
  }
  return { rrule, untilAt };
}

const OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * An RFC 3339 provider date-time as an instant. A value without an offset is local time in its
 * own `timeZone` (as the provider allows), never the server's zone.
 */
export function instantOf(dateTime: string, tz: string): Date {
  if (OFFSET.test(dateTime)) return new Date(dateTime);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(dateTime);
  return m ? localToUtc(`${m[1]}T${m[2]}:${m[3]}`, tz) : new Date(Number.NaN);
}

export interface EventSpan {
  allDay: boolean;
  /** The event's own zone (the provider's time zone, else the calendar's). */
  tz: string;
  startsAt: Date;
  endsAt: Date;
  /** Local start in `tz` (occurrence key form). */
  localStart: string;
}

/** The instants of a provider start/end pair. All-day dates are read in the calendar's zone. */
export function spanOf(
  start: ProviderTime | undefined,
  end: ProviderTime | undefined,
  calendarTz: string,
): EventSpan | null {
  if (!start) return null;
  if (start.date) {
    const endDate = end?.date ?? start.date;
    const s = dayBounds(start.date, calendarTz).start;
    // The provider's all-day end date is exclusive.
    const e =
      endDate > start.date
        ? dayBounds(endDate, calendarTz).start
        : dayBounds(start.date, calendarTz).end;
    return { allDay: true, tz: calendarTz, startsAt: s, endsAt: e, localStart: start.date };
  }
  if (!start.dateTime) return null;
  const tz = start.timeZone || calendarTz;
  const s = instantOf(start.dateTime, tz);
  const e = end?.dateTime
    ? instantOf(end.dateTime, end.timeZone || tz)
    : new Date(s.getTime() + 30 * 60_000);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  return {
    allDay: false,
    tz,
    startsAt: s,
    endsAt: e > s ? e : new Date(s.getTime() + 60_000),
    localStart: utcToLocal(s, tz),
  };
}

/** The original occurrence key of a provider instance (moved or cancelled exception). */
export function originalKey(
  original: ProviderTime | undefined,
  anchorTz: string,
  allDay: boolean,
): string | null {
  if (!original) return null;
  if (original.date) return original.date;
  if (!original.dateTime) return null;
  const at = instantOf(original.dateTime, original.timeZone || anchorTz);
  if (Number.isNaN(at.getTime())) return null;
  const local = utcToLocal(at, anchorTz);
  return allDay ? local.slice(0, 10) : local;
}

/** The provider's instance identifier for an occurrence (`<master>_<UTC start>` or `_<date>`). */
export function instanceId(
  masterId: string,
  key: string,
  anchorTz: string,
  allDay: boolean,
): string {
  if (allDay) return `${masterId}_${key.replace(/-/g, '')}`;
  const at = localToUtc(key, anchorTz).toISOString();
  return `${masterId}_${at.slice(0, 19).replace(/[-:]/g, '')}Z`;
}

export interface SeriesShape {
  externalId: string;
  rrule: string;
  untilAt: Date | null;
  anchorTz: string;
  /** `YYYY-MM-DDTHH:mm` (all-day series use `T00:00`). */
  dtstartLocal: string;
  allDay: boolean;
  durationMinutes: number;
  /** Zone used for all-day day bounds (the calendar's). */
  dayTz: string;
}

export interface Occurrence {
  key: string;
  instanceId: string;
  startsAt: Date;
  endsAt: Date;
}

/** Occurrences of a supported series overlapping [from, to), at most `limit`. */
export function expand(series: SeriesShape, from: Date, to: Date, limit: number): Occurrence[] {
  const rule = parseRule(series.rrule);
  const lead = new Date(from.getTime() - series.durationMinutes * 60_000 - 86_400_000);
  const afterLocal = utcToLocal(lead, series.anchorTz);
  const after = afterLocal > series.dtstartLocal ? afterLocal : null;
  const through = utcToLocal(to, series.anchorTz);
  const keys = occurrences(rule, series.dtstartLocal, after, limit + 4, through);
  const out: Occurrence[] = [];
  for (const raw of keys) {
    const key = series.allDay ? raw.slice(0, 10) : raw;
    const startsAt = series.allDay
      ? dayBounds(key, series.dayTz).start
      : localToUtc(raw, series.anchorTz);
    if (series.untilAt && startsAt > series.untilAt) continue;
    // All-day spans are whole local days, so a DST day keeps its real 23 or 25 hours.
    const endsAt = series.allDay
      ? dayBounds(
          addDays(key, Math.max(1, Math.round(series.durationMinutes / 1440)) - 1),
          series.dayTz,
        ).end
      : new Date(startsAt.getTime() + series.durationMinutes * 60_000);
    if (endsAt <= from || startsAt >= to) continue;
    out.push({
      key,
      instanceId: instanceId(series.externalId, key, series.anchorTz, series.allDay),
      startsAt,
      endsAt,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** True when a provider item is the master of a recurring series. */
export const isMaster = (e: ProviderEvent) =>
  Array.isArray(e.recurrence) && e.recurrence.length > 0;
