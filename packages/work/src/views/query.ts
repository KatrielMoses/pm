import type { ErrorIssue as Issue } from '@pm/contracts';
import { invalid, issue } from '@pm/tenancy';

/**
 * The canonical saved-view query (Phase 3A, ADR-0018 Q1–Q6; 0B §4.7). One versioned AST describes
 * filters (AND/OR groups), multi-sort, and grouping over a whitelisted per-entity field catalog.
 * This module only parses and validates; `compile.ts` turns a parsed query into SQL and the view
 * engine always adds the viewer's own authorization predicate. Nothing in a query can widen access.
 */

export const QUERY_VERSION = 1;
export type Entity = 'task' | 'project';
export const ENTITIES: readonly Entity[] = ['task', 'project'];

/** Operators by value kind. Every operator of a kind is valid for every field of that kind. */
export const OPERATORS = {
  ref: ['in', 'not_in', 'is_empty', 'is_not_empty'],
  multi: ['any_of', 'all_of', 'none_of', 'is_empty', 'is_not_empty'],
  enum: ['in', 'not_in', 'is_empty', 'is_not_empty'],
  date: [
    'on',
    'before',
    'after',
    'on_or_before',
    'on_or_after',
    'between',
    'is_empty',
    'is_not_empty',
  ],
  number: ['eq', 'lt', 'lte', 'gt', 'gte', 'between', 'is_empty', 'is_not_empty'],
  text: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
  bool: ['is_true', 'is_false', 'is_empty', 'is_not_empty'],
} as const;
export type ValueKind = keyof typeof OPERATORS;
export type Operator = (typeof OPERATORS)[ValueKind][number];

/** What a reference value names (its public-ID prefix), or a closed enum's members. */
export type RefKind = 'brand' | 'project' | 'member' | 'label' | 'milestone' | 'status' | 'agent';
export const REF_PREFIX: Record<RefKind, string> = {
  brand: 'br',
  project: 'prj',
  member: 'mem',
  label: 'lbl',
  milestone: 'ms',
  status: 'sts',
  agent: 'agt',
};

export interface FieldSpec {
  kind: ValueKind;
  ref?: RefKind;
  values?: readonly string[];
  sortable: boolean;
  groupable: boolean;
  /** A column that may be shown (and exported). */
  column: boolean;
  /** May appear in a filter condition (manual order is sort-only). */
  filterable: boolean;
  label: string;
}

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export const CATEGORIES = ['planned', 'active', 'paused', 'done', 'cancelled'] as const;
export const HEALTH = ['on_track', 'at_risk', 'off_track'] as const;

const f = (
  kind: ValueKind,
  label: string,
  o: Partial<Omit<FieldSpec, 'kind' | 'label'>> = {},
): FieldSpec => ({
  kind,
  label,
  sortable: false,
  groupable: false,
  column: true,
  filterable: true,
  ...o,
});

const common: Record<string, FieldSpec> = {
  brand: f('ref', 'Brand', { ref: 'brand', sortable: true, groupable: true }),
  status: f('ref', 'Status', { ref: 'status', sortable: true, groupable: true }),
  status_category: f('enum', 'Status category', { values: CATEGORIES, groupable: true }),
  priority: f('enum', 'Priority', { values: PRIORITIES, sortable: true, groupable: true }),
  health: f('enum', 'Health', { values: HEALTH, sortable: true, groupable: true }),
  milestone: f('multi', 'Milestone', { ref: 'milestone', groupable: true }),
  start_date: f('date', 'Start date', { sortable: true, groupable: true }),
  deadline_date: f('date', 'Deadline', { sortable: true, groupable: true }),
  created_at: f('date', 'Created', { sortable: true, groupable: true }),
  updated_at: f('date', 'Updated', { sortable: true, groupable: true }),
  completed_at: f('date', 'Completed', { sortable: true, groupable: true }),
  rank: f('number', 'Manual order', { sortable: true, column: false, filterable: false }),
};

/** The field catalog per entity (VIEW-012, VIEW-014, VIEW-015). Custom fields are `field:fld_…`. */
export const CATALOG: Record<Entity, Record<string, FieldSpec>> = {
  task: {
    title: f('text', 'Title', { sortable: true }),
    ...common,
    project: f('ref', 'Project', { ref: 'project', sortable: true, groupable: true }),
    owner: f('ref', 'Owner', { ref: 'member', sortable: true, groupable: true }),
    assignee: f('multi', 'Assignees', { ref: 'member', groupable: true }),
    assigned_by: f('multi', 'Assigned by', { ref: 'member', column: false }),
    agent: f('multi', 'Agent', { ref: 'agent' }),
    label: f('multi', 'Labels', { ref: 'label' }),
    due_date: f('date', 'Due date', { sortable: true, groupable: true }),
    estimate_minutes: f('number', 'Estimate', { sortable: true }),
    subtask: f('bool', 'Is a subtask', { column: false }),
  },
  project: {
    name: f('text', 'Name', { sortable: true }),
    ...common,
    parent: f('ref', 'Parent project', { ref: 'project', column: false }),
    owner: f('ref', 'Owner', { ref: 'member', sortable: true, groupable: true }),
    target_date: f('date', 'Target date', { sortable: true, groupable: true }),
  },
};

export const CUSTOM_PREFIX = 'field:';
const FIELD_ID = /^field:fld_[0-9A-HJKMNP-TV-Z]{26}$/;
const PUBLIC_ID = /^([a-z]{2,4})_[0-9A-HJKMNP-TV-Z]{26}$/;
const STATUS_KEY = /^[a-z][a-z_]{1,31}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^-?\d{1,24}(\.\d{1,12})?$/;

/** A relative date: `today` shifted by whole days (evaluated with the caller's `today`). */
export interface RelDate {
  rel: 'today';
  days: number;
}
export type DateValue = string | RelDate;

export interface Condition {
  field: string;
  op: Operator;
  /** Normalized: refs and enums are string arrays; dates/numbers are one or two values. */
  values: unknown[];
}
export interface Group {
  op: 'and' | 'or';
  items: Array<Condition | Group>;
}
export interface SortKey {
  field: string;
  dir: 'asc' | 'desc';
}
export type Granularity = 'day' | 'week' | 'month';
export interface Grouping {
  field: string;
  granularity?: Granularity;
}
export interface Query {
  v: typeof QUERY_VERSION;
  entity: Entity;
  filter: Group | null;
  sort: SortKey[];
  group: Grouping | null;
}

export interface QueryBounds {
  conditionsMax: number;
  depthMax: number;
  sortsMax: number;
  valuesMax: number;
}

export const isGroup = (n: Condition | Group): n is Group => 'items' in n;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The field spec the viewer may use, or null. Custom fields are resolved later against the
 * viewer's readable definitions (an unreadable definition is `unsupported_field`, exactly like an
 * unknown one, 0C AT-026); here they are only shape-checked.
 */
export function fieldSpec(entity: Entity, field: string): FieldSpec | null {
  if (FIELD_ID.test(field)) return null;
  return Object.prototype.hasOwnProperty.call(CATALOG[entity], field)
    ? CATALOG[entity][field]!
    : null;
}
export const isCustom = (field: string) => FIELD_ID.test(field);

/** The kind of a custom field type (formulas use their result type). */
export function customKind(type: string): ValueKind | null {
  switch (type) {
    case 'text':
    case 'url':
    case 'email':
      return 'text';
    case 'number':
    case 'currency':
    case 'percentage':
      return 'number';
    case 'date':
      return 'date';
    case 'checkbox':
    case 'boolean':
      return 'bool';
    case 'select':
    case 'person':
    case 'label':
      return 'ref';
    default:
      return null;
  }
}

class Parser {
  readonly issues: Issue[] = [];
  conditions = 0;
  readonly entity: Entity;
  readonly b: QueryBounds;
  constructor(entity: Entity, b: QueryBounds) {
    this.entity = entity;
    this.b = b;
  }

  fail(path: string, code: string, msg: string): null {
    this.issues.push(issue(path, code, msg));
    return null;
  }

  /** Custom fields are typed later; a condition on one keeps its raw values for the second pass. */
  condition(raw: Record<string, unknown>, path: string): Condition | null {
    this.conditions++;
    const field = raw.field;
    if (typeof field !== 'string') return this.fail(`${path}/field`, 'required', 'Choose a field.');
    const custom = isCustom(field);
    const spec = custom ? null : fieldSpec(this.entity, field);
    if (!custom && !spec?.filterable)
      return this.fail(`${path}/field`, 'unsupported_field', 'This field is not available.');
    const op = raw.op;
    if (typeof op !== 'string') return this.fail(`${path}/op`, 'required', 'Choose a condition.');
    const value = raw.value;
    if (custom) {
      const all = new Set<string>(Object.values(OPERATORS).flat());
      if (!all.has(op)) return this.fail(`${path}/op`, 'invalid', 'This condition is not valid.');
      return { field, op: op as Operator, values: value === undefined ? [] : [value] };
    }
    return this.typed(spec!, field, op, value, path);
  }

  /** Validates an operator and value for a field of the given kind; values are normalized. */
  typed(
    spec: Pick<FieldSpec, 'kind' | 'ref' | 'values'>,
    field: string,
    op: string,
    value: unknown,
    path: string,
  ): Condition | null {
    if (!(OPERATORS[spec.kind] as readonly string[]).includes(op))
      return this.fail(`${path}/op`, 'invalid', 'This condition does not apply to this field.');
    const o = op as Operator;
    if (o === 'is_empty' || o === 'is_not_empty' || o === 'is_true' || o === 'is_false') {
      if (value !== undefined && value !== null)
        return this.fail(`${path}/value`, 'invalid', 'This condition takes no value.');
      return { field, op: o, values: [] };
    }
    switch (spec.kind) {
      case 'ref':
      case 'multi':
      case 'enum': {
        if (!Array.isArray(value) || !value.length)
          return this.fail(`${path}/value`, 'required', 'Choose at least one value.');
        if (value.length > this.b.valuesMax)
          return this.fail(
            `${path}/value`,
            'too_many',
            `Choose at most ${this.b.valuesMax} values.`,
          );
        const out: string[] = [];
        for (const [i, v] of value.entries()) {
          if (typeof v !== 'string')
            return this.fail(`${path}/value/${i}`, 'invalid', 'This value is not valid.');
          if (spec.kind === 'enum') {
            if (!spec.values!.includes(v))
              return this.fail(`${path}/value/${i}`, 'invalid', 'This value is not valid.');
          } else if (spec.ref === 'member' && v === 'me') {
            // `me` is the caller (My Work, Assigned by Me; NAV-004/005 contributions).
          } else if (spec.ref === 'status' && STATUS_KEY.test(v)) {
            // A platform status key.
          } else if (spec.ref === undefined) {
            // Option and custom reference IDs are prefix-checked against the field later.
            if (!PUBLIC_ID.test(v))
              return this.fail(`${path}/value/${i}`, 'invalid', 'This value is not valid.');
          } else {
            const m = PUBLIC_ID.exec(v);
            if (!m || m[1] !== REF_PREFIX[spec.ref])
              return this.fail(`${path}/value/${i}`, 'invalid', 'This value is not valid.');
          }
          if (!out.includes(v)) out.push(v);
        }
        if (spec.kind === 'multi' && o !== 'any_of' && o !== 'all_of' && o !== 'none_of')
          return this.fail(`${path}/op`, 'invalid', 'This condition does not apply to this field.');
        return { field, op: o, values: out };
      }
      case 'date': {
        const vals = o === 'between' ? value : [value];
        if (!Array.isArray(vals) || vals.length !== (o === 'between' ? 2 : 1))
          return this.fail(
            `${path}/value`,
            'invalid',
            o === 'between' ? 'Choose a start and an end date.' : 'Choose a date.',
          );
        const out: DateValue[] = [];
        for (const v of vals) {
          if (typeof v === 'string' && ISO_DAY.test(v) && !Number.isNaN(Date.parse(v))) out.push(v);
          else if (
            isObj(v) &&
            v.rel === 'today' &&
            Number.isInteger(v.days) &&
            Math.abs(v.days as number) <= 3660 &&
            Object.keys(v).length === 2
          )
            out.push({ rel: 'today', days: v.days as number });
          else return this.fail(`${path}/value`, 'invalid', 'Choose a valid date.');
        }
        return { field, op: o, values: out };
      }
      case 'number': {
        const vals = o === 'between' ? value : [value];
        if (!Array.isArray(vals) || vals.length !== (o === 'between' ? 2 : 1))
          return this.fail(`${path}/value`, 'invalid', 'Enter a number.');
        const out: string[] = [];
        for (const v of vals) {
          const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
          if (typeof s !== 'string' || !NUMBER.test(s))
            return this.fail(`${path}/value`, 'invalid', 'Enter a number.');
          out.push(s);
        }
        return { field, op: o, values: out };
      }
      case 'text': {
        if (typeof value !== 'string' || !value.trim() || value.length > 200)
          return this.fail(`${path}/value`, 'invalid', 'Enter up to 200 characters.');
        return { field, op: o, values: [value.trim()] };
      }
      default:
        return this.fail(`${path}/op`, 'invalid', 'This condition is not valid.');
    }
  }

  group(raw: unknown, path: string, depth: number): Group | null {
    if (!isObj(raw)) return this.fail(path, 'invalid', 'This filter is not valid.');
    if (depth > this.b.depthMax)
      return this.fail(path, 'too_deep', `Nest filter groups at most ${this.b.depthMax} deep.`);
    const op = raw.op;
    if (op !== 'and' && op !== 'or')
      return this.fail(`${path}/op`, 'invalid', 'Combine with “and” or “or”.');
    if (!Array.isArray(raw.items))
      return this.fail(`${path}/items`, 'required', 'Add a condition.');
    const items: Array<Condition | Group> = [];
    for (const [i, it] of raw.items.entries()) {
      const p = `${path}/items/${i}`;
      if (isObj(it) && 'items' in it) {
        const g = this.group(it, p, depth + 1);
        if (g) items.push(g);
      } else if (isObj(it)) {
        const c = this.condition(it, p);
        if (c) items.push(c);
      } else this.fail(p, 'invalid', 'This condition is not valid.');
    }
    if (this.conditions > this.b.conditionsMax)
      return this.fail(
        path,
        'too_many',
        `A view can have at most ${this.b.conditionsMax} conditions.`,
      );
    return { op, items };
  }
}

/**
 * Parses and validates a query AST. Unknown fields fail with `unsupported_field`. Every problem is
 * reported with a JSON pointer (`validation_failed`).
 */
export function parseQuery(raw: unknown, bounds: QueryBounds, entityHint?: Entity): Query {
  if (!isObj(raw)) throw invalid(issue('/query', 'required', 'A query is required.'));
  const issues: Issue[] = [];
  if (raw.v !== undefined && raw.v !== QUERY_VERSION)
    issues.push(issue('/query/v', 'unsupported_version', 'This view needs a newer version.'));
  const entity = raw.entity ?? entityHint;
  if (entity !== 'task' && entity !== 'project')
    throw invalid(issue('/query/entity', 'invalid', 'Choose tasks or projects.'), ...issues);
  if (entityHint && entity !== entityHint)
    throw invalid(issue('/query/entity', 'invalid', 'This query is for a different list.'));
  const known = new Set(['v', 'entity', 'filter', 'sort', 'group']);
  for (const k of Object.keys(raw))
    if (!known.has(k)) issues.push(issue(`/query/${k}`, 'unknown_key', 'This key is not allowed.'));
  const p = new Parser(entity, bounds);
  const filter =
    raw.filter === undefined || raw.filter === null
      ? null
      : p.group(raw.filter, '/query/filter', 1);
  const sort: SortKey[] = [];
  if (raw.sort !== undefined) {
    if (!Array.isArray(raw.sort)) p.fail('/query/sort', 'invalid', 'Sort is a list.');
    else if (raw.sort.length > bounds.sortsMax)
      p.fail('/query/sort', 'too_many', `Sort by at most ${bounds.sortsMax} fields.`);
    else
      for (const [i, s] of raw.sort.entries()) {
        const path = `/query/sort/${i}`;
        if (!isObj(s) || typeof s.field !== 'string') {
          p.fail(path, 'invalid', 'Choose a field to sort by.');
          continue;
        }
        const spec = isCustom(s.field) ? null : fieldSpec(entity, s.field);
        if (!isCustom(s.field) && !spec?.sortable) {
          p.fail(`${path}/field`, 'unsupported_field', 'This field cannot be sorted.');
          continue;
        }
        const dir = s.dir ?? 'asc';
        if (dir !== 'asc' && dir !== 'desc') {
          p.fail(`${path}/dir`, 'invalid', 'Sort ascending or descending.');
          continue;
        }
        if (sort.some((x) => x.field === s.field)) {
          p.fail(`${path}/field`, 'duplicate', 'Sort by each field once.');
          continue;
        }
        sort.push({ field: s.field, dir });
      }
  }
  let group: Grouping | null = null;
  if (raw.group !== undefined && raw.group !== null) {
    const g = raw.group;
    if (!isObj(g) || typeof g.field !== 'string')
      p.fail('/query/group', 'invalid', 'Choose a field.');
    else {
      const spec = isCustom(g.field) ? null : fieldSpec(entity, g.field);
      if (!isCustom(g.field) && !spec?.groupable)
        p.fail('/query/group/field', 'unsupported_field', 'This field cannot be grouped.');
      else if (
        g.granularity !== undefined &&
        g.granularity !== 'day' &&
        g.granularity !== 'week' &&
        g.granularity !== 'month'
      )
        p.fail('/query/group/granularity', 'invalid', 'Group dates by day, week, or month.');
      else
        group = {
          field: g.field,
          ...(g.granularity ? { granularity: g.granularity as Granularity } : {}),
        };
    }
  }
  issues.push(...p.issues);
  if (issues.length) throw invalid(...issues);
  return { v: QUERY_VERSION, entity, filter, sort, group };
}

/** Custom fields the query references (for one resolution statement). */
export function customFields(q: Query): string[] {
  const out = new Set<string>();
  const walk = (g: Group | null) =>
    g?.items.forEach((n) => (isGroup(n) ? walk(n) : isCustom(n.field) && out.add(n.field)));
  walk(q.filter);
  q.sort.forEach((s) => isCustom(s.field) && out.add(s.field));
  if (q.group && isCustom(q.group.field)) out.add(q.group.field);
  return [...out].sort();
}

/** Every condition, depth-first (for value resolution by kind). */
export function conditions(q: Query): Condition[] {
  const out: Condition[] = [];
  const walk = (g: Group | null) => g?.items.forEach((n) => (isGroup(n) ? walk(n) : out.push(n)));
  walk(q.filter);
  return out;
}

/** Re-validates a custom-field condition once the viewer's readable definition is known. */
export function typeCustomCondition(
  c: Condition,
  kind: ValueKind,
  path: string,
  bounds: QueryBounds,
): Condition {
  const p = new Parser('task', bounds);
  const value = c.values.length ? c.values[0] : undefined;
  const typed = p.typed({ kind }, c.field, c.op, value, path);
  if (!typed) throw invalid(...p.issues);
  return typed;
}

/** Presentation: visible columns in order and density (VIEW-020; WFL-009 contribution). */
export interface Presentation {
  columns: string[];
  density: 'comfortable' | 'compact';
}

export const DEFAULT_COLUMNS: Record<Entity, string[]> = {
  task: ['title', 'status', 'priority', 'owner', 'due_date', 'brand', 'project'],
  project: ['name', 'status', 'priority', 'health', 'owner', 'target_date', 'brand'],
};

export function parsePresentation(raw: unknown, entity: Entity, columnsMax: number): Presentation {
  if (raw === undefined || raw === null)
    return { columns: [...DEFAULT_COLUMNS[entity]], density: 'comfortable' };
  if (!isObj(raw)) throw invalid(issue('/presentation', 'invalid', 'Presentation is an object.'));
  const issues: Issue[] = [];
  for (const k of Object.keys(raw))
    if (k !== 'columns' && k !== 'density')
      issues.push(issue(`/presentation/${k}`, 'unknown_key', 'This key is not allowed.'));
  const density = raw.density ?? 'comfortable';
  if (density !== 'comfortable' && density !== 'compact')
    issues.push(issue('/presentation/density', 'invalid', 'Choose comfortable or compact.'));
  const columns: string[] = [];
  if (raw.columns !== undefined) {
    if (!Array.isArray(raw.columns) || !raw.columns.length)
      issues.push(issue('/presentation/columns', 'required', 'Show at least one column.'));
    else if (raw.columns.length > columnsMax)
      issues.push(
        issue('/presentation/columns', 'too_many', `Show at most ${columnsMax} columns.`),
      );
    else
      raw.columns.forEach((c, i) => {
        const ok =
          typeof c === 'string' &&
          (isCustom(c) || fieldSpec(entity, c)?.column === true) &&
          !columns.includes(c);
        if (!ok)
          issues.push(
            issue(
              `/presentation/columns/${i}`,
              'unsupported_field',
              'This column is not available.',
            ),
          );
        else columns.push(c);
      });
  } else columns.push(...DEFAULT_COLUMNS[entity]);
  if (issues.length) throw invalid(...issues);
  return { columns, density: density as Presentation['density'] };
}

/**
 * The canonical stored form of a parsed query (the AST a client sends): `parseQuery` of this is the
 * same query again. Saved views store this form, so equal views store equal JSON.
 */
export function serializeQuery(q: Query): Record<string, unknown> {
  const cond = (c: Condition): Record<string, unknown> => {
    if (!c.values.length) return { field: c.field, op: c.op };
    const spec = isCustom(c.field) ? null : fieldSpec(q.entity, c.field);
    const list = spec
      ? spec.kind === 'ref' || spec.kind === 'multi' || spec.kind === 'enum'
      : false;
    // Unresolved custom-field conditions keep the raw value they were given.
    const value =
      list || c.op === 'between'
        ? isCustom(c.field) && c.op !== 'between'
          ? c.values[0]
          : c.values
        : c.values[0];
    return { field: c.field, op: c.op, value };
  };
  const grp = (g: Group): Record<string, unknown> => ({
    op: g.op,
    items: g.items.map((n) => (isGroup(n) ? grp(n) : cond(n))),
  });
  return {
    v: q.v,
    entity: q.entity,
    ...(q.filter ? { filter: grp(q.filter) } : {}),
    ...(q.sort.length ? { sort: q.sort } : {}),
    ...(q.group ? { group: q.group } : {}),
  };
}
