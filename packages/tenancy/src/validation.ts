import {
  BRAND_NOTIFICATION_CONTENT_MODES,
  BRAND_OPERATIONAL_STATUSES,
  type BrandNotificationContentMode,
  type BrandOperationalStatus,
  type ErrorIssue,
} from '@pm/contracts';
import { invalid, issue } from './errors.ts';

/**
 * Input validation for workspace and brand commands. Every rule here is also a database CHECK
 * (migrations 0017/0018); this layer exists to return precise, field-level `validation_failed`
 * issues instead of a generic failure. Messages are safe to show and never echo input.
 */

// Control characters are exactly what this rejects (mirrors tenancy.valid_plain_text).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** IANA zone name shape (also the database CHECK): no UTC offsets, no free text. */
const IANA_ZONE = /^[A-Za-z]+(\/[A-Za-z0-9_+-]+)*$/;
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export const BRAND_ICONS = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'star',
  'bolt',
  'leaf',
  'globe',
  'briefcase',
  'rocket',
  'heart',
  'book',
] as const;
export type BrandIcon = (typeof BRAND_ICONS)[number];
/** Closed vocabularies generated from the 0B brand entity (ADR-19); never maintained here. */
export const OPERATIONAL_STATUSES = BRAND_OPERATIONAL_STATUSES;
export type OperationalStatus = BrandOperationalStatus;
export const NOTIFICATION_CONTENT_MODES = BRAND_NOTIFICATION_CONTENT_MODES;
export type NotificationContentMode = BrandNotificationContentMode;

export class Issues {
  readonly list: ErrorIssue[] = [];
  add(pointer: string, code: string, message: string): void {
    this.list.push(issue(pointer, code, message));
  }
  throwIfAny(): void {
    if (this.list.length) throw invalid(...this.list);
  }
}

export function text(
  v: unknown,
  pointer: string,
  issues: Issues,
  opts: { max: number; required: boolean; label: string },
): string | null | undefined {
  if (v === undefined) {
    if (opts.required) issues.add(pointer, 'required', `${opts.label} is required.`);
    return undefined;
  }
  if (v === null) {
    if (opts.required) issues.add(pointer, 'required', `${opts.label} is required.`);
    return null;
  }
  if (typeof v !== 'string') {
    issues.add(pointer, 'invalid_type', `${opts.label} must be text.`);
    return undefined;
  }
  const t = v.trim();
  if (!t) {
    if (opts.required) issues.add(pointer, 'required', `${opts.label} is required.`);
    return opts.required ? undefined : null;
  }
  if ([...t].length > opts.max) {
    issues.add(pointer, 'too_long', `${opts.label} can be at most ${opts.max} characters.`);
    return undefined;
  }
  if (CONTROL.test(t)) {
    issues.add(pointer, 'invalid_characters', `${opts.label} contains characters we can't save.`);
    return undefined;
  }
  return t;
}

/**
 * IANA time zone known to the runtime's tz database. Canonical names and their aliases (e.g.
 * `Asia/Kolkata` and `Asia/Calcutta`) are both accepted and stored as given: ICU's canonical list
 * lags IANA renames, and browsers report either form.
 */
export function timezone(v: unknown, pointer: string, issues: Issues): string | undefined {
  if (typeof v === 'string' && v.length <= 64 && IANA_ZONE.test(v)) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
      return v;
    } catch {
      // fall through
    }
  }
  issues.add(pointer, 'invalid_timezone', 'Choose a time zone from the list.');
  return undefined;
}

/** BCP 47 tag in canonical form (e.g. `en`, `en-GB`, `pt-BR`). */
export function locale(v: unknown, pointer: string, issues: Issues): string | undefined {
  if (typeof v === 'string' && v.length >= 2 && v.length <= 35) {
    try {
      const [canonical] = Intl.getCanonicalLocales(v);
      if (canonical === v) return v;
    } catch {
      // fall through
    }
  }
  issues.add(pointer, 'invalid_locale', 'Choose a language and region from the list.');
  return undefined;
}

/** ISO 4217 alphabetic code known to the runtime. */
export function currency(v: unknown, pointer: string, issues: Issues): string | undefined {
  if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v) || !CURRENCIES.has(v)) {
    issues.add(pointer, 'invalid_currency', 'Choose a currency from the list.');
    return undefined;
  }
  return v;
}

/** ISO weekday 1 (Monday) … 7 (Sunday). */
export function weekday(v: unknown, pointer: string, issues: Issues): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 7) {
    issues.add(pointer, 'invalid_weekday', 'Choose a day of the week.');
    return undefined;
  }
  return v;
}

export function oneOf<T extends string>(
  v: unknown,
  values: readonly T[],
  pointer: string,
  issues: Issues,
  label: string,
): T | undefined {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    issues.add(pointer, 'invalid_option', `Choose a valid ${label}.`);
    return undefined;
  }
  return v as T;
}

export function color(v: unknown, pointer: string, issues: Issues): string | undefined {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) {
    issues.add(pointer, 'invalid_color', 'Use a color like #336699.');
    return undefined;
  }
  return v.toLowerCase();
}

/**
 * Logo reference boundary: 1C stores only a typed file reference and never bytes. File storage
 * does not exist yet (vendor not selected), so no reference can be verified and none is accepted.
 */
export function logoRef(v: unknown, pointer: string, issues: Issues): null | undefined {
  if (v === undefined || v === null) return v as null | undefined;
  issues.add(pointer, 'logo_upload_unavailable', 'Logo upload is not available yet.');
  return undefined;
}

export function boolean(v: unknown, pointer: string, issues: Issues): boolean | undefined {
  if (typeof v !== 'boolean') {
    issues.add(pointer, 'invalid_type', 'Choose yes or no.');
    return undefined;
  }
  return v;
}

// -------------------------------------------------------------------------------------------
// Typed brand settings (schema_version 1). Stored canonical and validated again by the database.
// -------------------------------------------------------------------------------------------

export interface WorkingHours {
  schema_version: 1;
  days: Array<{ weekday: number; ranges: Array<{ start: string; end: string }> }>;
}
export interface CalendarSettings {
  schema_version: 1;
  week_start: number | null;
  show_weekends: boolean;
  default_view: 'week' | 'month' | 'agenda';
  label: string | null;
}
export interface Priorities {
  schema_version: 1;
  entries: Array<{ kind: 'goal' | 'priority'; text: string }>;
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  schema_version: 1,
  days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, ranges: [{ start: '09:00', end: '17:00' }] })),
};
export const DEFAULT_CALENDAR: CalendarSettings = {
  schema_version: 1,
  week_start: null,
  show_weekends: false,
  default_view: 'week',
  label: null,
};
export const DEFAULT_PRIORITIES: Priorities = { schema_version: 1, entries: [] };

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const HHMM_END = /^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(
  v: Record<string, unknown>,
  allowed: string[],
  pointer: string,
  issues: Issues,
): void {
  for (const k of Object.keys(v))
    if (!allowed.includes(k))
      issues.add(`${pointer}/${k}`, 'unsupported_field', 'This field is not supported.');
}

/**
 * Local weekday/time ranges in the brand's explicit time zone. Ranges are sorted, bounded
 * (at most 4 a day), `start < end`, and must not overlap; one entry per weekday.
 */
export function workingHours(v: unknown, issues: Issues): WorkingHours | undefined {
  const p = '/working_hours';
  if (!isObject(v) || v.schema_version !== 1 || !Array.isArray(v.days)) {
    issues.add(p, 'invalid_type', 'Working hours are not in a supported format.');
    return undefined;
  }
  onlyKeys(v, ['schema_version', 'days'], p, issues);
  if (v.days.length > 7) issues.add(`${p}/days`, 'too_many', 'Add each day at most once.');
  const seen = new Set<number>();
  const days: WorkingHours['days'] = [];
  v.days.forEach((d: unknown, i: number) => {
    const dp = `${p}/days/${i}`;
    if (!isObject(d) || !Array.isArray(d.ranges)) {
      issues.add(dp, 'invalid_type', 'This day is not in a supported format.');
      return;
    }
    onlyKeys(d, ['weekday', 'ranges'], dp, issues);
    const wd = weekday(d.weekday, `${dp}/weekday`, issues);
    if (wd === undefined) return;
    if (seen.has(wd)) {
      issues.add(`${dp}/weekday`, 'duplicate_day', 'Add each day at most once.');
      return;
    }
    seen.add(wd);
    if (d.ranges.length > 4) {
      issues.add(`${dp}/ranges`, 'too_many', 'Use at most 4 time ranges a day.');
      return;
    }
    const ranges: Array<{ start: string; end: string }> = [];
    d.ranges.forEach((r: unknown, j: number) => {
      const rp = `${dp}/ranges/${j}`;
      if (!isObject(r) || typeof r.start !== 'string' || typeof r.end !== 'string') {
        issues.add(rp, 'invalid_type', 'Enter a start and end time.');
        return;
      }
      onlyKeys(r, ['start', 'end'], rp, issues);
      if (!HHMM.test(r.start)) issues.add(`${rp}/start`, 'invalid_time', 'Use a time like 09:00.');
      else if (!HHMM_END.test(r.end))
        issues.add(`${rp}/end`, 'invalid_time', 'Use a time like 17:30.');
      else if (r.start >= r.end)
        issues.add(`${rp}/end`, 'end_before_start', 'The end time must be after the start time.');
      else ranges.push({ start: r.start, end: r.end });
    });
    ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    for (let k = 1; k < ranges.length; k++)
      if (ranges[k]!.start < ranges[k - 1]!.end)
        issues.add(`${dp}/ranges`, 'overlap', 'Time ranges on the same day must not overlap.');
    days.push({ weekday: wd, ranges });
  });
  days.sort((a, b) => a.weekday - b.weekday);
  return { schema_version: 1, days };
}

export function calendar(v: unknown, issues: Issues): CalendarSettings | undefined {
  const p = '/calendar';
  if (!isObject(v) || v.schema_version !== 1) {
    issues.add(p, 'invalid_type', 'Calendar settings are not in a supported format.');
    return undefined;
  }
  onlyKeys(
    v,
    ['schema_version', 'week_start', 'show_weekends', 'default_view', 'label'],
    p,
    issues,
  );
  const weekStart =
    v.week_start === null || v.week_start === undefined
      ? null
      : weekday(v.week_start, `${p}/week_start`, issues);
  const showWeekends = boolean(v.show_weekends ?? false, `${p}/show_weekends`, issues);
  const view = oneOf(
    v.default_view ?? 'week',
    ['week', 'month', 'agenda'] as const,
    `${p}/default_view`,
    issues,
    'calendar view',
  );
  const label = text(v.label ?? null, `${p}/label`, issues, {
    max: 80,
    required: false,
    label: 'Calendar label',
  });
  if (weekStart === undefined || showWeekends === undefined || !view || label === undefined)
    return undefined;
  return {
    schema_version: 1,
    week_start: weekStart,
    show_weekends: showWeekends,
    default_view: view,
    label,
  };
}

export function priorities(v: unknown, issues: Issues): Priorities | undefined {
  const p = '/priorities';
  if (!isObject(v) || v.schema_version !== 1 || !Array.isArray(v.entries)) {
    issues.add(p, 'invalid_type', 'Goals and priorities are not in a supported format.');
    return undefined;
  }
  onlyKeys(v, ['schema_version', 'entries'], p, issues);
  if (v.entries.length > 10) {
    issues.add(`${p}/entries`, 'too_many', 'Keep at most 10 goals and priorities.');
    return undefined;
  }
  const entries: Priorities['entries'] = [];
  v.entries.forEach((e: unknown, i: number) => {
    const ep = `${p}/entries/${i}`;
    if (!isObject(e)) {
      issues.add(ep, 'invalid_type', 'This entry is not in a supported format.');
      return;
    }
    onlyKeys(e, ['kind', 'text'], ep, issues);
    const kind = oneOf(e.kind, ['goal', 'priority'] as const, `${ep}/kind`, issues, 'type');
    const t = text(e.text, `${ep}/text`, issues, { max: 280, required: true, label: 'Text' });
    if (kind && t) entries.push({ kind, text: t });
  });
  return { schema_version: 1, entries };
}

/** Reserved, schema-versioned namespaces whose owners are later phases. 1C never writes them. */
export const RESERVED_SETTING_NAMESPACES = {
  notifications: { owner: '4B' },
  ai: { owner: '7A' },
  integrations: { owner: '6A' },
} as const;
export type ReservedSettingNamespace = keyof typeof RESERVED_SETTING_NAMESPACES;
