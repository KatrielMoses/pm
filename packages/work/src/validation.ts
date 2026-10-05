import {
  CRITERIA_KINDS,
  DECISION_KINDS,
  MILESTONE_STATUSES,
  PHASE_STATUSES,
  PROJECT_HEALTH,
  PROJECT_PRIORITIES,
  PROJECT_STATUSES,
  SCOPE_ITEM_KINDS,
} from '@pm/contracts/shell';
import { validateRichText, type RichTextDoc } from '@pm/contracts';
import { Issues, color as colorValue, currency, text } from '@pm/tenancy';
import {
  composeRule,
  COUNT_MAX,
  isCalendarDate,
  WEEKDAYS,
  type RuleInput,
  type Weekday,
} from './recurrence.ts';

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;

/** Registered bounds (0D PL-22). The database depth ceiling (32) is an invariant, not a setting. */
export interface WorkSettings {
  /** `PROJECT_DEPTH_MAX`: deepest level a command accepts (root = 0). */
  projectDepthMax: number;
  /** `TEMPLATE_ITEMS_MAX`: most structural items per template version or snapshot. */
  templateItemsMax: number;
  /** `RECURRENCE_CATCHUP_MAX`: most missed occurrences one series generates per run. */
  recurrenceCatchupMax: number;
  /** `RECURRENCE_WORKSPACE_DISCOVERY_MAX`: most workspaces one recurrence run visits. */
  recurrenceWorkspaceDiscoveryMax: number;
  /** `RECURRENCE_SERIES_DISCOVERY_MAX`: most due series one run processes per workspace. */
  recurrenceSeriesDiscoveryMax: number;
  /** `TASK_DEPTH_MAX`: deepest subtask level a command accepts (root = 0). */
  taskDepthMax: number;
  /** `TASK_SUBTREE_MAX`: most tasks one subtree operation (move, lifecycle, duplicate) touches. */
  taskSubtreeMax: number;
  /** `TASK_ITEMS_MAX`: most checklist items, criteria items, or links per task (each kind). */
  taskItemsMax: number;
  /** `TASK_ASSIGNEES_MAX` */
  taskAssigneesMax: number;
  /** `TASK_LABELS_MAX` */
  taskLabelsMax: number;
  /** `BRAND_LABELS_MAX` */
  brandLabelsMax: number;
  /** `TASK_ESTIMATE_MINUTES_MAX` */
  taskEstimateMinutesMax: number;
  /** `PAGE_LIMIT_DEFAULT` and `PAGE_LIMIT_MAX` for task and project lists. */
  pageLimitDefault: number;
  pageLimitMax: number;
}

export const DEFAULT_WORK_SETTINGS: WorkSettings = Object.freeze({
  projectDepthMax: 10,
  templateItemsMax: 500,
  recurrenceCatchupMax: 12,
  recurrenceWorkspaceDiscoveryMax: 200,
  recurrenceSeriesDiscoveryMax: 50,
  taskDepthMax: 20,
  taskSubtreeMax: 500,
  taskItemsMax: 200,
  taskAssigneesMax: 20,
  taskLabelsMax: 50,
  brandLabelsMax: 1000,
  taskEstimateMinutesMax: 100_000,
  pageLimitDefault: 50,
  pageLimitMax: 200,
});

/** The database invariant behind `TASK_DEPTH_MAX` (migration 0023). */
export const TASK_DEPTH_CEILING = 64;

/** The database invariant behind `PROJECT_DEPTH_MAX` (migration 0021). */
export const PROJECT_DEPTH_CEILING = 32;

export const PROJECT_ICONS = [
  'folder',
  'rocket',
  'target',
  'flag',
  'star',
  'calendar',
  'chart',
  'box',
  'book',
  'tool',
] as const;

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const PUBLIC = (prefix: string) => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
export const isPublic = (v: unknown, prefix: string): v is string =>
  typeof v === 'string' && PUBLIC(prefix).test(v);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function date(v: unknown, pointer: string, issues: Issues): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    issues.add(pointer, 'invalid_date', 'Use a date like 2026-10-04.');
    return undefined;
  }
  return v;
}

export function enumValue<T extends string>(
  v: unknown,
  allowed: readonly T[],
  pointer: string,
  issues: Issues,
  nullable = false,
): T | null | undefined {
  if (v === undefined) return undefined;
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    issues.add(pointer, 'invalid_option', 'Choose one of the listed options.');
    return undefined;
  }
  return v as T;
}

export function nonNegativeInt(
  v: unknown,
  pointer: string,
  issues: Issues,
  max: number,
): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
    issues.add(pointer, 'invalid_number', 'Use a whole number of zero or more.');
    return undefined;
  }
  return v;
}

function money(v: unknown, pointer: string, issues: Issues): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,14}(\.\d{1,2})?$/.test(s)) {
    issues.add(pointer, 'invalid_number', 'Use an amount like 1500 or 1500.50.');
    return undefined;
  }
  return s;
}

/** Integer micros as a string (0D money convention: int64-safe for JavaScript). */
function micros(v: unknown, pointer: string, issues: Issues): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== 'string' || !/^(0|[1-9]\d{0,17})$/.test(s)) {
    issues.add(pointer, 'invalid_number', 'Use a whole number of zero or more.');
    return undefined;
  }
  return s;
}

/** Most characters of a project description's extracted text (rich text version 1, 0D PL-23). */
export const DESCRIPTION_TEXT_MAX = 20_000;

/**
 * A rich-text field (0D PL-23): `null` clears it; otherwise a version 1 document whose extracted
 * text fits `max`. Unsupported nodes, marks, attributes, and versions are refused, never stored.
 */
export function richText(
  v: unknown,
  pointer: string,
  issues: Issues,
  max: number,
): RichTextDoc | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const r = validateRichText(v, max);
  if (!r.ok) {
    issues.add(`${pointer}${r.path}`, r.code, r.message);
    return undefined;
  }
  return r.doc;
}

/** Fields a project may set on create and change by field-merge (0D field-merge-request). */
export const PROJECT_FIELDS = [
  'name',
  'description',
  'icon',
  'color',
  'status',
  'priority',
  'start_date',
  'target_date',
  'deadline_date',
  'health',
  'budget_amount',
  'budget_currency',
  'time_budget_minutes',
  'ai_budget_micros',
] as const;
export type ProjectField = (typeof PROJECT_FIELDS)[number];

export const PROJECT_CONTENT_FIELDS: Record<string, 'content'> = {
  name: 'content',
  description: 'content',
};

/** Validates one project field value; undefined means invalid (an issue was added). */
export function projectField(field: string, v: unknown, issues: Issues): unknown {
  const p = `/changes/${field}`;
  switch (field as ProjectField) {
    case 'name':
      return text(v, p, issues, { max: 200, required: true, label: 'Project name' });
    case 'description':
      return richText(v, p, issues, DESCRIPTION_TEXT_MAX);
    case 'icon':
      return enumValue(v, PROJECT_ICONS, p, issues, true);
    case 'color':
      return v === null ? null : colorValue(v, p, issues);
    case 'status':
      return enumValue(
        v,
        PROJECT_STATUSES.map((s) => s.key),
        p,
        issues,
      );
    case 'priority':
      return enumValue(v, PROJECT_PRIORITIES, p, issues);
    case 'start_date':
    case 'target_date':
    case 'deadline_date':
      return date(v, p, issues);
    case 'health':
      return enumValue(v, PROJECT_HEALTH, p, issues, true);
    case 'budget_amount':
      return money(v, p, issues);
    case 'budget_currency':
      return v === null ? null : currency(v, p, issues);
    case 'time_budget_minutes':
      return nonNegativeInt(v, p, issues, 100_000_000);
    case 'ai_budget_micros':
      return micros(v, p, issues);
    default:
      issues.add(p, 'unsupported_field', 'This field is not supported.');
      return undefined;
  }
}

export interface ProjectCreateInput {
  brand: string | null;
  parent: string | null;
  template: string | null;
  intake_source: string | null;
  fields: Partial<Record<ProjectField, unknown>>;
}

export function parseProjectCreate(body: unknown): ProjectCreateInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  const allowed = new Set<string>([
    ...PROJECT_FIELDS,
    'brand',
    'parent',
    'template',
    'intake_source',
  ]);
  for (const k of Object.keys(b))
    if (!allowed.has(k)) issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const ref = (k: string, prefix: string) => {
    const v = b[k];
    if (v === undefined || v === null) return null;
    if (!isPublic(v, prefix)) {
      issues.add(`/${k}`, 'invalid_reference', 'Choose an item from the list.');
      return null;
    }
    return v;
  };
  const brand = ref('brand', 'br');
  const parent = ref('parent', 'prj');
  const template = ref('template', 'tpl');
  const intake = ref('intake_source', 'form');
  const fields: Partial<Record<ProjectField, unknown>> = {};
  for (const f of PROJECT_FIELDS) {
    if (b[f] === undefined) continue;
    const v = projectField(f, b[f], issues);
    if (v !== undefined) fields[f] = v;
  }
  if (b.name === undefined && template === null)
    issues.add('/name', 'required', 'Project name is required.');
  if (brand === null && parent === null)
    issues.add('/brand', 'brand_required', 'Choose which brand owns this');
  issues.throwIfAny();
  return { brand, parent, template, intake_source: intake, fields };
}

/** Reorder/reparent body: the new parent (null = root) and the sibling to place after. */
export function parseMove(body: unknown): { parent: string | null; after: string | null } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (k !== 'parent' && k !== 'after')
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const parent = b.parent ?? null;
  const after = b.after ?? null;
  if (parent !== null && !isPublic(parent, 'prj'))
    issues.add('/parent', 'invalid_reference', 'Choose a project.');
  if (after !== null && !isPublic(after, 'prj'))
    issues.add('/after', 'invalid_reference', 'Choose a project.');
  issues.throwIfAny();
  return { parent: parent as string | null, after: after as string | null };
}

/** Ordered child rows (phases, milestones, criteria, scope items): place after a sibling or first. */
export function parseAfter(body: unknown, prefix: string): string | null {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  const after = b.after ?? null;
  if (after !== null && !isPublic(after, prefix))
    issues.add('/after', 'invalid_reference', 'Choose an item from the list.');
  issues.throwIfAny();
  return after as string | null;
}

export function parsePhase(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['name', 'start_date', 'end_date', 'status', 'owner'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const out = {
    name: text(b.name, '/name', issues, { max: 120, required: !partial, label: 'Phase name' }),
    start_date: date(b.start_date, '/start_date', issues),
    end_date: date(b.end_date, '/end_date', issues),
    status: enumValue(b.status, PHASE_STATUSES, '/status', issues),
    owner: ownerRef(b.owner, issues),
  };
  if (out.start_date && out.end_date && out.end_date < out.start_date)
    issues.add('/end_date', 'date_order', 'The end date is before the start date.');
  issues.throwIfAny();
  return out;
}

export function parseMilestone(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['name', 'due_date', 'status', 'phase', 'owner'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const phase = b.phase;
  if (phase !== undefined && phase !== null && !isPublic(phase, 'phs'))
    issues.add('/phase', 'invalid_reference', 'Choose a phase of this project.');
  const out = {
    name: text(b.name, '/name', issues, { max: 120, required: !partial, label: 'Milestone name' }),
    due_date: date(b.due_date, '/due_date', issues),
    status: enumValue(b.status, MILESTONE_STATUSES, '/status', issues),
    phase: phase as string | null | undefined,
    owner: ownerRef(b.owner, issues),
  };
  issues.throwIfAny();
  return out;
}

function ownerRef(v: unknown, issues: Issues): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isPublic(v, 'mem')) {
    issues.add('/owner', 'invalid_reference', 'Choose a person.');
    return undefined;
  }
  return v;
}

export function parseCriterion(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['kind', 'text', 'met'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const out = {
    kind: partial
      ? enumValue(b.kind, CRITERIA_KINDS, '/kind', issues)
      : (enumValue(b.kind ?? 'success', CRITERIA_KINDS, '/kind', issues) as
          (typeof CRITERIA_KINDS)[number] | undefined),
    text: text(b.text, '/text', issues, { max: 500, required: !partial, label: 'Criterion' }),
    met: b.met === undefined ? undefined : b.met === true,
  };
  if (b.met !== undefined && typeof b.met !== 'boolean')
    issues.add('/met', 'invalid_type', 'Choose met or not met.');
  issues.throwIfAny();
  return out;
}

export function parseScopeItem(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['kind', 'text'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const out = {
    kind: partial
      ? enumValue(b.kind, SCOPE_ITEM_KINDS, '/kind', issues)
      : enumValue(b.kind, SCOPE_ITEM_KINDS, '/kind', issues),
    text: text(b.text, '/text', issues, { max: 1000, required: !partial, label: 'Entry' }),
  };
  if (!partial && out.kind === undefined && b.kind === undefined)
    issues.add('/kind', 'required', 'Choose what kind of entry this is.');
  issues.throwIfAny();
  return out;
}

export function parseUpdate(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['body', 'health'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const out = {
    body: text(b.body, '/body', issues, { max: 10000, required: true, label: 'Update' }) as string,
    health: enumValue(b.health ?? null, PROJECT_HEALTH, '/health', issues, true) ?? null,
  };
  issues.throwIfAny();
  return out;
}

export function parseDecision(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (
      !['kind', 'statement', 'outcome', 'owner', 'due_date', 'state', 'superseded_by'].includes(k)
    )
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const out = {
    kind: partial ? undefined : enumValue(b.kind ?? 'decision', DECISION_KINDS, '/kind', issues),
    statement: text(b.statement, '/statement', issues, {
      max: 2000,
      required: !partial,
      label: 'Statement',
    }),
    outcome: text(b.outcome, '/outcome', issues, { max: 4000, required: false, label: 'Outcome' }),
    owner: ownerRef(b.owner, issues),
    due_date: date(b.due_date, '/due_date', issues),
    state:
      b.state === undefined
        ? undefined
        : enumValue(
            b.state,
            ['proposed', 'decided', 'superseded', 'open', 'resolved'],
            '/state',
            issues,
          ),
    superseded_by:
      b.superseded_by === undefined || b.superseded_by === null
        ? null
        : isPublic(b.superseded_by, 'dec')
          ? b.superseded_by
          : (issues.add('/superseded_by', 'invalid_reference', 'Choose a decision.'), null),
  };
  issues.throwIfAny();
  return out;
}

export function parseDependency(body: unknown): { target: string } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (k !== 'target' && k !== 'kind')
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  if (b.kind !== undefined && b.kind !== 'blocks')
    issues.add('/kind', 'invalid_option', 'Projects depend on each other with "blocks".');
  if (!isPublic(b.target, 'prj')) issues.add('/target', 'invalid_reference', 'Choose a project.');
  issues.throwIfAny();
  return { target: b.target as string };
}

export function parseAccess(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['access_mode', 'allow_record_shares'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const mode = enumValue(b.access_mode, ['inherit', 'restricted'] as const, '/access_mode', issues);
  if (b.allow_record_shares !== undefined && typeof b.allow_record_shares !== 'boolean')
    issues.add('/allow_record_shares', 'invalid_type', 'Choose on or off.');
  issues.throwIfAny();
  return {
    access_mode: mode ?? undefined,
    allow_record_shares: b.allow_record_shares as boolean | undefined,
  };
}

export function parseTemplateFromProject(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['name', 'scope'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const out = {
    name: text(b.name, '/name', issues, {
      max: 200,
      required: true,
      label: 'Template name',
    }) as string,
    scope: (enumValue(b.scope ?? 'brand', ['brand', 'workspace'] as const, '/scope', issues) ??
      'brand') as 'brand' | 'workspace',
  };
  issues.throwIfAny();
  return out;
}

/**
 * A recurrence definition as people choose it (ADR-0013 P11): frequency, interval, weekdays
 * (weekly), month days (monthly), the anchor local date-time and IANA zone, and one end condition.
 * Combinations the rule subset does not support are field errors; nothing is silently normalized.
 */
export function parseRecurrence(body: unknown): {
  rule: RuleInput;
  rrule: string;
  anchor_tz: string;
  start: string;
} {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (
      !['frequency', 'interval', 'weekdays', 'month_days', 'start', 'anchor_tz', 'ends'].includes(k)
    )
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const frequency = enumValue(b.frequency, FREQUENCIES, '/frequency', issues);
  if (frequency === undefined && b.frequency === undefined)
    issues.add('/frequency', 'required', 'Choose how often this repeats.');
  let interval = 1;
  if (b.interval !== undefined) {
    if (
      typeof b.interval !== 'number' ||
      !Number.isInteger(b.interval) ||
      b.interval < 1 ||
      b.interval > 366
    )
      issues.add('/interval', 'invalid_number', 'Use a whole number from 1 to 366.');
    else interval = b.interval;
  }
  let weekdays: Weekday[] | null = null;
  if (b.weekdays !== undefined && b.weekdays !== null) {
    if (frequency !== 'weekly')
      issues.add('/weekdays', 'not_applicable', 'Weekdays apply only to weekly schedules.');
    else if (
      !Array.isArray(b.weekdays) ||
      !b.weekdays.length ||
      b.weekdays.some((d) => !(WEEKDAYS as readonly unknown[]).includes(d)) ||
      new Set(b.weekdays).size !== b.weekdays.length
    )
      issues.add('/weekdays', 'invalid_option', 'Choose one or more different weekdays.');
    else weekdays = b.weekdays as Weekday[];
  }
  let monthDays: number[] | null = null;
  if (b.month_days !== undefined && b.month_days !== null) {
    if (frequency !== 'monthly')
      issues.add(
        '/month_days',
        'not_applicable',
        'Days of the month apply only to monthly schedules.',
      );
    else if (
      !Array.isArray(b.month_days) ||
      !b.month_days.length ||
      b.month_days.some((d) => typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 31) ||
      new Set(b.month_days).size !== b.month_days.length
    )
      issues.add(
        '/month_days',
        'invalid_option',
        'Choose one or more different days from 1 to 31.',
      );
    else monthDays = b.month_days as number[];
  }
  const tz = typeof b.anchor_tz === 'string' ? b.anchor_tz : '';
  try {
    if (!tz) throw new Error('empty');
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    issues.add('/anchor_tz', 'invalid_timezone', 'Choose a time zone.');
  }
  const start = typeof b.start === 'string' ? b.start : '';
  const sm = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(start);
  if (!sm || !isCalendarDate(+sm[1]!, +sm[2]!, +sm[3]!))
    issues.add('/start', 'invalid_date', 'Choose the first date and time, like 2026-11-02T09:00.');
  let ends: RuleInput['ends'] = { type: 'never' };
  const e = b.ends;
  if (e !== undefined && e !== null) {
    const t = isObject(e) ? e.type : undefined;
    if (t === 'never' && isObject(e) && Object.keys(e).length === 1) ends = { type: 'never' };
    else if (t === 'after' && isObject(e)) {
      const c = e.count;
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > COUNT_MAX)
        issues.add('/ends/count', 'invalid_number', `Use a whole number from 1 to ${COUNT_MAX}.`);
      else ends = { type: 'after', count: c };
    } else if (t === 'on' && isObject(e)) {
      const d = typeof e.date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.date) : null;
      if (!d || !isCalendarDate(+d[1]!, +d[2]!, +d[3]!))
        issues.add('/ends/date', 'invalid_date', 'Choose the last date, like 2027-06-30.');
      else if (sm && (e.date as string) < start.slice(0, 10))
        issues.add(
          '/ends/date',
          'before_start',
          'The last date must be on or after the first one.',
        );
      else ends = { type: 'on', date: e.date as string };
    } else
      issues.add('/ends', 'invalid_option', 'Choose never, after a number of times, or on a date.');
  }
  issues.throwIfAny();
  const rule: RuleInput = { frequency: frequency!, interval, weekdays, monthDays, ends };
  return { rule, rrule: composeRule(rule), anchor_tz: tz, start };
}

export { colorValue };
