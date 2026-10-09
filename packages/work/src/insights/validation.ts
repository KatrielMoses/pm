import { Issues, text as plainField } from '@pm/tenancy';
import { isObject, isPublic } from '../validation.ts';
import {
  DASHBOARD_KINDS,
  FREQUENCIES,
  RANGE_PRESETS,
  STATUS_CATEGORIES,
  WIDGET_SIZES,
  scheduleValid,
  validRange,
  type DashboardFilters,
  type DashboardKindKey,
  type Frequency,
  type Layout,
  type RangeInput,
  type Schedule,
  type WidgetSize,
  type WidgetSpec,
} from './semantics.ts';
import { validZone } from '../time/semantics.ts';

/**
 * Phase 5D inputs (ADR-0030). Every parser refuses unknown fields, reports pointer-precise safe
 * issues, and never echoes input. Nothing here consults the database or authorization; a widget's
 * parameters are checked by the metric that owns them.
 */

const unknownFields = (b: Record<string, unknown>, allowed: readonly string[], issues: Issues) => {
  for (const k of Object.keys(b))
    if (!allowed.includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
};

const ref = (
  b: Record<string, unknown>,
  key: string,
  prefix: string,
  issues: Issues,
): string | null | undefined => {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isPublic(v, prefix)) {
    issues.add(`/${key}`, 'invalid_reference', 'Choose from the list.');
    return undefined;
  }
  return v;
};

const version = (b: Record<string, unknown>, issues: Issues): number | undefined => {
  const v = b.version;
  if (v === undefined) return undefined;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  issues.add('/version', 'invalid_number', 'Send the version you loaded.');
  return undefined;
};

const title = (v: unknown, issues: Issues, required: boolean) =>
  plainField(v, '/title', issues, { max: 200, required, label: 'The title' });

const description = (v: unknown, issues: Issues) =>
  plainField(v, '/description', issues, { max: 2000, required: false, label: 'The description' });

const LIST_MAX = 10;

function idList(
  v: unknown,
  pointer: string,
  prefix: string,
  issues: Issues,
  allowMe = false,
): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > LIST_MAX) {
    issues.add(pointer, 'invalid_type', `Choose at most ${LIST_MAX}.`);
    return [];
  }
  const out: string[] = [];
  for (const [i, x] of v.entries()) {
    if (allowMe && x === 'me') out.push('me');
    else if (isPublic(x, prefix)) out.push(x as string);
    else issues.add(`${pointer}/${i}`, 'invalid_reference', 'Choose from the list.');
  }
  return [...new Set(out)];
}

/** Filters as the API takes them (RPT-018): date, brand, project, person, and status. */
export function parseFilters(raw: unknown, pointer = '/filters', issues = new Issues()) {
  const empty: DashboardFilters = {
    range: null,
    brands: [],
    projects: [],
    people: [],
    statuses: [],
  };
  if (raw === undefined || raw === null) return { value: empty, issues };
  if (!isObject(raw)) {
    issues.add(pointer, 'invalid_type', 'Describe the filters.');
    return { value: empty, issues };
  }
  for (const k of Object.keys(raw))
    if (!['range', 'brands', 'projects', 'people', 'statuses'].includes(k))
      issues.add(`${pointer}/${k}`, 'unsupported_field', 'This filter is not supported.');
  let range: RangeInput | null = null;
  const r = raw.range;
  if (r !== undefined && r !== null) {
    if (isObject(r) && typeof r.preset === 'string' && Object.keys(r).length === 1) {
      if ((RANGE_PRESETS as readonly string[]).includes(r.preset))
        range = { preset: r.preset as (typeof RANGE_PRESETS)[number] };
      else issues.add(`${pointer}/range/preset`, 'invalid_option', 'Choose a date range.');
    } else if (
      isObject(r) &&
      typeof r.from === 'string' &&
      typeof r.to === 'string' &&
      Object.keys(r).length === 2
    ) {
      if (validRange(r.from, r.to)) range = { from: r.from, to: r.to };
      else
        issues.add(
          `${pointer}/range`,
          'invalid_range',
          'Choose real dates, the end on or after the start, within a year.',
        );
    } else issues.add(`${pointer}/range`, 'invalid_type', 'Choose a date range.');
  }
  const statuses: string[] = [];
  if (raw.statuses !== undefined && raw.statuses !== null) {
    if (!Array.isArray(raw.statuses) || raw.statuses.length > STATUS_CATEGORIES.length)
      issues.add(`${pointer}/statuses`, 'invalid_type', 'Choose status categories.');
    else
      for (const [i, s] of raw.statuses.entries())
        if ((STATUS_CATEGORIES as readonly unknown[]).includes(s)) statuses.push(s as string);
        else issues.add(`${pointer}/statuses/${i}`, 'invalid_option', 'Choose a status category.');
  }
  return {
    value: {
      range,
      brands: idList(raw.brands, `${pointer}/brands`, 'br', issues),
      projects: idList(raw.projects, `${pointer}/projects`, 'prj', issues),
      people: idList(raw.people, `${pointer}/people`, 'mem', issues, true),
      statuses: [...new Set(statuses)],
    } satisfies DashboardFilters,
    issues,
  };
}

/** Checks one widget's parameters; returns the normalized parameters or null after adding issues. */
export type ParamsParser = (
  metric: string,
  raw: unknown,
  pointer: string,
  issues: Issues,
) => Record<string, unknown> | null;

const WIDGET_ID = /^[a-z][a-z0-9_]{0,23}$/;

/** A bounded widget list (RPT-017): unique identifiers, known metrics, valid parameters. */
export function parseLayout(
  raw: unknown,
  pointer: string,
  max: number,
  params: ParamsParser,
  issues: Issues,
): Layout | undefined {
  if (!isObject(raw)) {
    issues.add(pointer, 'invalid_type', 'Describe the widgets.');
    return undefined;
  }
  for (const k of Object.keys(raw))
    if (k !== 'widgets' && k !== 'v')
      issues.add(`${pointer}/${k}`, 'unsupported_field', 'This field is not supported.');
  if (raw.v !== undefined && raw.v !== 1)
    issues.add(`${pointer}/v`, 'unsupported_version', 'This layout needs a newer version.');
  const list = raw.widgets;
  if (!Array.isArray(list)) {
    issues.add(`${pointer}/widgets`, 'invalid_type', 'Send the list of widgets.');
    return undefined;
  }
  if (list.length > max) {
    issues.add(`${pointer}/widgets`, 'too_many', `Use at most ${max} widgets.`);
    return undefined;
  }
  const seen = new Set<string>();
  const widgets: WidgetSpec[] = [];
  for (const [i, w] of list.entries()) {
    const at = `${pointer}/widgets/${i}`;
    if (!isObject(w)) {
      issues.add(at, 'invalid_type', 'Describe the widget.');
      continue;
    }
    for (const k of Object.keys(w))
      if (!['id', 'metric', 'title', 'size', 'params'].includes(k))
        issues.add(`${at}/${k}`, 'unsupported_field', 'This field is not supported.');
    if (typeof w.id !== 'string' || !WIDGET_ID.test(w.id)) {
      issues.add(`${at}/id`, 'invalid', 'Use a short identifier of lowercase letters and digits.');
      continue;
    }
    if (seen.has(w.id))
      issues.add(`${at}/id`, 'duplicate', 'Each widget needs its own identifier.');
    seen.add(w.id);
    if (typeof w.metric !== 'string') {
      issues.add(`${at}/metric`, 'required', 'Choose a metric.');
      continue;
    }
    const wt =
      plainField(w.title, `${at}/title`, issues, {
        max: 80,
        required: false,
        label: 'The title',
      }) ?? null;
    const size = w.size ?? 'medium';
    if (!(WIDGET_SIZES as readonly unknown[]).includes(size))
      issues.add(`${at}/size`, 'invalid_option', 'Choose small, medium, or large.');
    const p = params(w.metric, w.params ?? {}, `${at}/params`, issues);
    if (p)
      widgets.push({ id: w.id, metric: w.metric, title: wt, size: size as WidgetSize, params: p });
  }
  return { v: 1, widgets };
}

export interface ParseContext {
  maxWidgets: number;
  params: ParamsParser;
}

export interface DashboardCreate {
  title: string;
  description: string | null;
  kind: DashboardKindKey;
  brand: string | null;
  project: string | null;
  layout: Layout;
  filters: DashboardFilters;
}

export function parseDashboardCreate(body: unknown, ctx: ParseContext): DashboardCreate {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the dashboard.');
  unknownFields(
    b,
    ['title', 'description', 'kind', 'brand', 'project', 'layout', 'filters'],
    issues,
  );
  const t = title(b.title, issues, true);
  const kind = b.kind;
  if (!(DASHBOARD_KINDS as readonly unknown[]).includes(kind))
    issues.add('/kind', 'invalid_option', 'Choose owner, brand, project, release, or personal.');
  const brand = ref(b, 'brand', 'br', issues) ?? null;
  const project = ref(b, 'project', 'prj', issues) ?? null;
  const k = kind as DashboardKindKey;
  if ((k === 'brand' || k === 'release') && !brand)
    issues.add('/brand', 'required', 'Choose the brand this dashboard is for.');
  if (k === 'project' && !project)
    issues.add('/project', 'required', 'Choose the project this dashboard is for.');
  if ((k === 'owner' || k === 'personal') && (brand || project))
    issues.add('/kind', 'conflicting', 'This dashboard is not tied to a brand or project.');
  if ((k === 'brand' || k === 'release') && project)
    issues.add('/project', 'conflicting', 'Leave the project out: this dashboard is for a brand.');
  if (k === 'project' && brand)
    issues.add(
      '/brand',
      'conflicting',
      "Leave the brand out: a project dashboard uses its project's brand.",
    );
  const layout =
    b.layout === undefined
      ? ({ v: 1, widgets: [] } as Layout)
      : parseLayout(b.layout, '/layout', ctx.maxWidgets, ctx.params, issues);
  const f = parseFilters(b.filters, '/filters', issues).value;
  const desc = description(b.description, issues) ?? null;
  issues.throwIfAny();
  return {
    title: t!,
    description: desc,
    kind: k,
    brand,
    project,
    layout: layout!,
    filters: f,
  };
}

export interface DashboardUpdate {
  version: number | undefined;
  title?: string;
  description?: string | null;
  layout?: Layout;
  filters?: DashboardFilters;
}

export function parseDashboardUpdate(body: unknown, ctx: ParseContext): DashboardUpdate {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the changes.');
  unknownFields(b, ['version', 'title', 'description', 'layout', 'filters'], issues);
  const out: DashboardUpdate = { version: version(b, issues) };
  if (b.title !== undefined) out.title = title(b.title, issues, true) ?? undefined;
  if (b.description !== undefined) out.description = description(b.description, issues) ?? null;
  if (b.layout !== undefined)
    out.layout = parseLayout(b.layout, '/layout', ctx.maxWidgets, ctx.params, issues);
  if (b.filters !== undefined) out.filters = parseFilters(b.filters, '/filters', issues).value;
  if (Object.keys(out).length === 1 && out.version === undefined)
    issues.add('/', 'required', 'Send at least one change.');
  issues.throwIfAny();
  return out;
}

export interface ReportCreate {
  title: string;
  description: string | null;
  brand: string | null;
  project: string | null;
  owner: string | null;
  layout: Layout;
  filters: DashboardFilters;
}

export function parseReportCreate(body: unknown, ctx: ParseContext): ReportCreate {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the report.');
  unknownFields(
    b,
    ['title', 'description', 'brand', 'project', 'owner', 'layout', 'filters'],
    issues,
  );
  const t = title(b.title, issues, true);
  const brand = ref(b, 'brand', 'br', issues) ?? null;
  const project = ref(b, 'project', 'prj', issues) ?? null;
  if (brand && project)
    issues.add(
      '/project',
      'conflicting',
      "Leave the brand out: a project report uses its project's brand.",
    );
  const layout =
    b.layout === undefined
      ? ({ v: 1, widgets: [] } as Layout)
      : parseLayout(b.layout, '/layout', ctx.maxWidgets, ctx.params, issues);
  const filters = parseFilters(b.filters, '/filters', issues).value;
  const desc = description(b.description, issues) ?? null;
  const owner = ref(b, 'owner', 'mem', issues) ?? null;
  issues.throwIfAny();
  return {
    title: t!,
    description: desc,
    brand,
    project,
    owner,
    layout: layout!,
    filters,
  };
}

export interface ReportUpdate {
  version: number | undefined;
  title?: string;
  description?: string | null;
  layout?: Layout;
  filters?: DashboardFilters;
}

export function parseReportUpdate(body: unknown, ctx: ParseContext): ReportUpdate {
  return parseDashboardUpdate(body, ctx);
}

export interface ScheduleInput {
  version: number | undefined;
  /** `null` removes the schedule. */
  schedule: Schedule | null;
}

/** A schedule (RPT-021): frequency, local time, and zone; weekly names a weekday, monthly a day. */
export function parseScheduleInput(body: unknown): ScheduleInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the schedule.');
  unknownFields(b, ['version', 'schedule'], issues);
  const v = version(b, issues);
  const s = b.schedule;
  if (s === null) {
    issues.throwIfAny();
    return { version: v, schedule: null };
  }
  if (!isObject(s)) {
    issues.add('/schedule', 'required', 'Send the schedule, or null to remove it.');
    issues.throwIfAny();
    return { version: v, schedule: null };
  }
  for (const k of Object.keys(s))
    if (!['frequency', 'weekday', 'monthday', 'time', 'timezone'].includes(k))
      issues.add(`/schedule/${k}`, 'unsupported_field', 'This field is not supported.');
  if (!(FREQUENCIES as readonly unknown[]).includes(s.frequency))
    issues.add('/schedule/frequency', 'invalid_option', 'Choose daily, weekly, or monthly.');
  const m = typeof s.time === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.time) : null;
  if (!m) issues.add('/schedule/time', 'invalid', 'Use a time like 08:30.');
  const tz = validZone(s.timezone);
  if (!tz) issues.add('/schedule/timezone', 'invalid_zone', 'Choose a time zone from the list.');
  const weekday = s.weekday === undefined || s.weekday === null ? null : (s.weekday as number);
  const monthday = s.monthday === undefined || s.monthday === null ? null : (s.monthday as number);
  const f = s.frequency as Frequency;
  const sched: Schedule = {
    frequency: f,
    weekday,
    monthday,
    minute: m ? Number(m[1]) * 60 + Number(m[2]) : 0,
    timezone: tz ?? 'UTC',
  };
  if (!issues.list.length && !scheduleValid(sched))
    issues.add(
      '/schedule',
      'invalid',
      'Weekly needs a weekday (1 to 7), monthly a day from 1 to 28, and daily neither.',
    );
  issues.throwIfAny();
  return { version: v, schedule: sched };
}

export interface RecipientsInput {
  version: number | undefined;
  members: string[];
}

export function parseRecipients(body: unknown, max: number): RecipientsInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the recipients.');
  unknownFields(b, ['version', 'members'], issues);
  const v = version(b, issues);
  const members = idList(b.members, '/members', 'mem', issues);
  if (Array.isArray(b.members) && b.members.length > max)
    issues.add('/members', 'too_many', `Name at most ${max} recipients.`);
  issues.throwIfAny();
  return { version: v, members };
}

export interface ShareInput {
  grantee: string;
  expiresAt: Date | null;
}

export function parseShare(body: unknown): ShareInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the share.');
  unknownFields(b, ['grantee', 'expires_at'], issues);
  const grantee = ref(b, 'grantee', 'mem', issues);
  if (!grantee) issues.add('/grantee', 'required', 'Choose who to share with.');
  let expiresAt: Date | null = null;
  if (b.expires_at !== undefined && b.expires_at !== null) {
    const ms = typeof b.expires_at === 'string' ? Date.parse(b.expires_at) : NaN;
    if (!Number.isFinite(ms) || !/Z$|[+-]\d{2}:\d{2}$/.test(String(b.expires_at)))
      issues.add(
        '/expires_at',
        'invalid',
        'Use a date and time with a zone, like 2026-12-01T00:00:00Z.',
      );
    else if (ms <= Date.now())
      issues.add('/expires_at', 'in_the_past', 'Choose a time in the future.');
    else expiresAt = new Date(ms);
  }
  issues.throwIfAny();
  return { grantee: grantee!, expiresAt };
}

export interface WidgetQuery {
  filters: DashboardFilters | null;
  cursor: string | null;
  limit: number | null;
}

/** Query-string options of a widget read or drill: ad hoc filters (JSON), a cursor, a page size. */
export function parseWidgetQuery(q: Record<string, unknown>, pageMax: number): WidgetQuery {
  const issues = new Issues();
  for (const k of Object.keys(q))
    if (!['filters', 'cursor', 'limit'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This option is not supported.');
  let filters: DashboardFilters | null = null;
  if (q.filters !== undefined) {
    let raw: unknown;
    try {
      raw =
        typeof q.filters === 'string' && q.filters.length <= 4096
          ? JSON.parse(q.filters)
          : undefined;
    } catch {
      raw = undefined;
    }
    if (raw === undefined) issues.add('/filters', 'invalid', 'Send the filters as JSON.');
    else filters = parseFilters(raw, '/filters', issues).value;
  }
  let limit: number | null = null;
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1)
      issues.add('/limit', 'invalid_number', 'Choose a page size of at least 1.');
    else limit = Math.min(n, pageMax);
  }
  const cursor = typeof q.cursor === 'string' && q.cursor.length <= 2048 ? q.cursor : null;
  if (q.cursor !== undefined && cursor === null)
    issues.add('/cursor', 'invalid', 'This cursor is not valid.');
  issues.throwIfAny();
  return { filters, cursor, limit };
}

export interface ListQuery {
  kind: DashboardKindKey | null;
  brand: string | null;
  project: string | null;
  limit: number;
  cursor: string | null;
}

export function parseListQuery(
  q: Record<string, unknown>,
  pageMax: number,
  defaultLimit: number,
): ListQuery {
  const issues = new Issues();
  for (const k of Object.keys(q))
    if (!['kind', 'brand', 'project', 'limit', 'cursor', 'trashed'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This option is not supported.');
  const kind = q.kind === undefined ? null : q.kind;
  if (kind !== null && !(DASHBOARD_KINDS as readonly unknown[]).includes(kind))
    issues.add('/kind', 'invalid_option', 'Choose a dashboard kind.');
  const brand = q.brand === undefined ? null : q.brand;
  if (brand !== null && !isPublic(brand, 'br'))
    issues.add('/brand', 'invalid_reference', 'Choose from the list.');
  const project = q.project === undefined ? null : q.project;
  if (project !== null && !isPublic(project, 'prj'))
    issues.add('/project', 'invalid_reference', 'Choose from the list.');
  let limit = defaultLimit;
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1)
      issues.add('/limit', 'invalid_number', 'Choose a page size of at least 1.');
    else limit = Math.min(n, pageMax);
  }
  const cursor = typeof q.cursor === 'string' && q.cursor.length <= 2048 ? q.cursor : null;
  if (q.cursor !== undefined && cursor === null)
    issues.add('/cursor', 'invalid', 'This cursor is not valid.');
  issues.throwIfAny();
  return {
    kind: kind as DashboardKindKey | null,
    brand: brand as string | null,
    project: project as string | null,
    limit,
    cursor,
  };
}

export interface ExportQuery {
  format: 'csv' | 'pdf';
  widget: string | null;
  filters: DashboardFilters | null;
}

export function parseExportQuery(q: Record<string, unknown>): ExportQuery {
  const issues = new Issues();
  for (const k of Object.keys(q))
    if (!['format', 'widget', 'filters'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This option is not supported.');
  const format = q.format === undefined ? 'csv' : q.format;
  if (format !== 'csv' && format !== 'pdf')
    issues.add('/format', 'invalid_option', 'Choose csv or pdf.');
  const widget = q.widget === undefined ? null : q.widget;
  if (widget !== null && (typeof widget !== 'string' || !/^[a-z][a-z0-9_]{0,23}$/.test(widget)))
    issues.add('/widget', 'invalid', 'Choose a widget from the list.');
  let filters: DashboardFilters | null = null;
  if (q.filters !== undefined) {
    let raw: unknown;
    try {
      raw =
        typeof q.filters === 'string' && q.filters.length <= 4096
          ? JSON.parse(q.filters)
          : undefined;
    } catch {
      raw = undefined;
    }
    if (raw === undefined) issues.add('/filters', 'invalid', 'Send the filters as JSON.');
    else filters = parseFilters(raw, '/filters', issues).value;
  }
  issues.throwIfAny();
  return { format: format as 'csv' | 'pdf', widget: widget as string | null, filters };
}
