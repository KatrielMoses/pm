import { sql, type RawBuilder } from '@pm/db';
import type {
  Condition,
  DateValue,
  Entity,
  Granularity,
  Group,
  Query,
  ValueKind,
} from './query.ts';
import { isCustom, isGroup } from './query.ts';

/**
 * Compiles a parsed, resolved query to SQL fragments (ADR-0018 Q2–Q4). The engine supplies the
 * FROM clause with the viewer's visibility predicate; this module only builds the filter, the
 * ordering keys, and the group key. Every reference value has already been resolved to internal
 * IDs **among what the viewer can read**: an unreadable value and an unknown one both resolve to
 * nothing, so they compile identically (0C AT-026).
 *
 * Aliases: `r` the record, `t` the task or `w` the project, `rp` the readable project of a task
 * (NULL when the task has no project or the viewer cannot read it), `pw` that project's row.
 */

/** A custom field the viewer may use (all_readers, guest-visible for guests; ADR-0018 Q5). */
export interface UsableField {
  id: string;
  publicId: string;
  name: string;
  type: string;
  kind: ValueKind;
}

export interface Resolved {
  /** Public ID (or `me`, or platform status key) → internal IDs; absent when unresolvable. */
  refs: Map<string, string>;
  fields: Map<string, UsableField>;
  me: string;
  today: string;
}

export interface OrderKey {
  /** The SQL expression (never NULL-unsafe: nulls sort last via the flag). */
  expr: RawBuilder<unknown>;
  /** The SQL type used to cast cursor values. */
  type: 'text' | 'numeric' | 'date' | 'timestamptz' | 'boolean' | 'uuid' | 'integer';
  dir: 'asc' | 'desc';
}

const PRIORITY_ORDER = sql`CASE %P% WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
void PRIORITY_ORDER;
const priorityRank = (col: RawBuilder<unknown>) =>
  sql<number>`(CASE ${col} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END)`;
const categoryRank = (col: RawBuilder<unknown>) =>
  sql<number>`(CASE ${col} WHEN 'planned' THEN 0 WHEN 'active' THEN 1 WHEN 'paused' THEN 2 WHEN 'done' THEN 3 ELSE 4 END)`;
const healthRank = (col: RawBuilder<unknown>) =>
  sql<number>`(CASE ${col} WHEN 'off_track' THEN 0 WHEN 'at_risk' THEN 1 WHEN 'on_track' THEN 2 END)`;

const ids = (r: Resolved, values: unknown[]) => {
  const out: string[] = [];
  for (const v of values) {
    const id = r.refs.get(v as string);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
};
const uuidArr = (xs: string[]) => sql`${xs}::uuid[]`;

/** The UTC calendar day of a timestamp column (date filters on timestamps; ADR-0018 Q3). */
const dayOf = (col: RawBuilder<unknown>) => sql`((${col}) AT TIME ZONE 'UTC')::date`;

function dateValue(v: DateValue, today: string): string {
  if (typeof v === 'string') return v;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + v.days);
  return d.toISOString().slice(0, 10);
}

export class Compiler {
  readonly entity: Entity;
  readonly r: Resolved;
  readonly member: boolean;
  /** Readable-record predicate builder for joined records (parents and readable projects). */
  readonly readable: (alias: string, project: RawBuilder<unknown>) => RawBuilder<boolean>;

  constructor(
    entity: Entity,
    r: Resolved,
    member: boolean,
    readable: (alias: string, project: RawBuilder<unknown>) => RawBuilder<boolean>,
  ) {
    this.entity = entity;
    this.r = r;
    this.member = member;
    this.readable = readable;
  }

  get e() {
    return this.entity === 'task' ? sql.raw('t') : sql.raw('w');
  }

  /** The readable project of a row: the project itself, or a task's project when readable. */
  projectId(): RawBuilder<unknown> {
    return this.entity === 'task' ? sql`rp.id` : sql`w.id`;
  }

  /** A scalar expression for a single-valued field (filters, sorting, grouping). */
  scalar(field: string): { expr: RawBuilder<unknown>; type: OrderKey['type'] } {
    const e = this.e;
    switch (field) {
      case 'title':
        return { expr: sql`lower(t.title) COLLATE "C"`, type: 'text' };
      case 'name':
        return { expr: sql`lower(w.name) COLLATE "C"`, type: 'text' };
      case 'brand':
        return { expr: sql`${e}.brand_id`, type: 'uuid' };
      case 'project':
        return { expr: sql`rp.id`, type: 'uuid' };
      case 'parent':
        return { expr: sql`pp.id`, type: 'uuid' };
      case 'status':
        return { expr: sql`${e}.status_id`, type: 'uuid' };
      case 'status_category':
        return { expr: sql`${e}.status_category`, type: 'text' };
      case 'priority':
        return { expr: sql`${e}.priority`, type: 'text' };
      case 'health':
        return { expr: this.entity === 'task' ? sql`pw.health` : sql`w.health`, type: 'text' };
      case 'owner':
        return {
          expr:
            this.entity === 'task'
              ? sql`(SELECT a.membership_id FROM work.task_assignee a WHERE a.task_id = t.id AND a.is_primary)`
              : sql`w.owner_membership_id`,
          type: 'uuid',
        };
      case 'assignee':
        // Grouping by assignee uses the primary assignee: one group per row (ADR-0018 Q4).
        return this.scalar('owner');
      case 'milestone':
        // The next open milestone of the readable project (grouping; ADR-0018 Q3).
        return {
          expr: sql`(SELECT m.id FROM work.milestone m WHERE m.workspace_id = r.workspace_id
            AND m.project_id = ${this.projectId()} AND m.lifecycle_state = 'active' AND m.status = 'planned'
            ORDER BY m.due_date NULLS LAST, m.rank COLLATE "C", m.id LIMIT 1)`,
          type: 'uuid',
        };
      case 'start_date':
      case 'due_date':
      case 'deadline_date':
      case 'target_date':
        return { expr: sql`${e}.${sql.ref(field)}`, type: 'date' };
      case 'created_at':
      case 'updated_at':
      case 'completed_at':
        return { expr: sql`${e}.${sql.ref(field)}`, type: 'timestamptz' };
      case 'estimate_minutes':
        return { expr: sql`t.estimate_minutes::numeric`, type: 'numeric' };
      case 'rank':
        return { expr: sql`${e}.rank COLLATE "C"`, type: 'text' };
    }
    if (isCustom(field)) {
      const fd = this.r.fields.get(field)!;
      const col =
        fd.kind === 'text'
          ? 'value_text'
          : fd.kind === 'number'
            ? 'value_numeric'
            : fd.kind === 'date'
              ? 'value_date'
              : fd.kind === 'bool'
                ? 'value_bool'
                : 'value_ref';
      const type: OrderKey['type'] =
        fd.kind === 'text'
          ? 'text'
          : fd.kind === 'number'
            ? 'numeric'
            : fd.kind === 'date'
              ? 'date'
              : fd.kind === 'bool'
                ? 'boolean'
                : 'uuid';
      const v = sql`(SELECT fv.${sql.ref(col)} FROM workflow.field_value fv WHERE fv.workspace_id = r.workspace_id
        AND fv.definition_id = ${fd.id}::uuid AND fv.record_id = r.id)`;
      return { expr: fd.kind === 'text' ? sql`lower(${v}) COLLATE "C"` : v, type };
    }
    throw new Error(`no scalar for ${field}`);
  }

  /** Sort keys: categorical fields sort by their natural order, not their stored text. */
  sortKey(field: string, dir: 'asc' | 'desc'): OrderKey {
    const e = this.e;
    switch (field) {
      case 'priority':
        return { expr: priorityRank(sql`${e}.priority`), type: 'integer', dir };
      case 'status':
        return {
          expr: sql`(${categoryRank(sql`${e}.status_category`)} * 1000 + coalesce((SELECT s.rank FROM workflow.platform_status s WHERE s.id = ${e}.status_id), 999))`,
          type: 'integer',
          dir,
        };
      case 'health':
        return {
          expr: healthRank(this.entity === 'task' ? sql`pw.health` : sql`w.health`),
          type: 'integer',
          dir,
        };
      case 'brand':
        return { expr: sql`lower(b.name) COLLATE "C"`, type: 'text', dir };
      case 'project':
        return { expr: sql`lower(pw.name) COLLATE "C"`, type: 'text', dir };
      case 'owner': {
        const owner = this.scalar('owner').expr;
        return {
          expr: sql`(SELECT lower(acc.display_name) COLLATE "C" FROM tenancy.membership m
            JOIN identity.account acc ON acc.id = m.account_id WHERE m.id = ${owner})`,
          type: 'text',
          dir,
        };
      }
    }
    if (isCustom(field) && this.r.fields.get(field)?.type === 'select')
      return {
        expr: sql`(SELECT o.rank COLLATE "C" FROM workflow.field_value fv JOIN workflow.field_option o
          ON o.id = fv.value_ref WHERE fv.workspace_id = r.workspace_id
          AND fv.definition_id = ${this.r.fields.get(field)!.id}::uuid AND fv.record_id = r.id)`,
        type: 'text',
        dir,
      };
    const s = this.scalar(field);
    return { expr: s.expr, type: s.type, dir };
  }

  /** The group key (a date field is bucketed by its granularity, default day). */
  groupKey(field: string, granularity: Granularity | undefined): OrderKey {
    const s = this.scalar(field);
    if (s.type === 'date' || s.type === 'timestamptz') {
      const d = s.type === 'timestamptz' ? dayOf(s.expr) : s.expr;
      const g = granularity ?? 'day';
      return {
        expr: g === 'day' ? sql`(${d})::date` : sql`date_trunc(${g}, ${d})::date`,
        type: 'date',
        dir: 'asc',
      };
    }
    if (field === 'priority' || field === 'status' || field === 'health')
      return { ...this.sortKey(field, 'asc'), dir: 'asc' };
    return { expr: s.expr, type: s.type, dir: 'asc' };
  }

  /** The raw group value for a row (its identity; labels are resolved separately). */
  groupValue(field: string, granularity: Granularity | undefined): RawBuilder<unknown> {
    const s = this.scalar(field);
    if (s.type === 'date' || s.type === 'timestamptz')
      return this.groupKey(field, granularity).expr;
    if (field === 'title' || field === 'name') return s.expr;
    if (isCustom(field) && this.r.fields.get(field)?.kind === 'text')
      return sql`(SELECT fv.value_text FROM workflow.field_value fv WHERE fv.workspace_id = r.workspace_id
        AND fv.definition_id = ${this.r.fields.get(field)!.id}::uuid AND fv.record_id = r.id)`;
    return s.expr;
  }

  filter(g: Group | null): RawBuilder<boolean> {
    if (!g || !g.items.length) return sql<boolean>`true`;
    const parts = g.items.map((n) => (isGroup(n) ? this.filter(n) : this.condition(n)));
    return sql<boolean>`(${sql.join(parts, g.op === 'and' ? sql` AND ` : sql` OR `)})`;
  }

  condition(c: Condition): RawBuilder<boolean> {
    const r = this.r;
    const e = this.e;
    switch (c.field) {
      case 'assignee':
      case 'assigned_by':
        return this.multi(
          c,
          (xs) =>
            c.field === 'assignee'
              ? sql`EXISTS (SELECT 1 FROM work.task_assignee a WHERE a.task_id = t.id AND a.membership_id = ANY(${uuidArr(xs)}))`
              : sql`EXISTS (SELECT 1 FROM work.task_assignee a WHERE a.task_id = t.id
                AND a.assigned_by_membership_id = ANY(${uuidArr(xs)}) AND a.membership_id <> a.assigned_by_membership_id)`,
          (n) =>
            sql`(SELECT count(DISTINCT a.membership_id) FROM work.task_assignee a WHERE a.task_id = t.id AND a.membership_id = ANY(${uuidArr(ids(r, c.values))})) = ${n}`,
          c.field === 'assignee'
            ? sql`EXISTS (SELECT 1 FROM work.task_assignee a WHERE a.task_id = t.id)`
            : sql`EXISTS (SELECT 1 FROM work.task_assignee a WHERE a.task_id = t.id
                AND a.assigned_by_membership_id IS NOT NULL AND a.membership_id <> a.assigned_by_membership_id)`,
        );
      case 'label':
        return this.multi(
          c,
          (xs) =>
            sql`EXISTS (SELECT 1 FROM work.task_label tl WHERE tl.task_id = t.id AND tl.label_id = ANY(${uuidArr(xs)}))`,
          (n) =>
            sql`(SELECT count(DISTINCT tl.label_id) FROM work.task_label tl WHERE tl.task_id = t.id AND tl.label_id = ANY(${uuidArr(ids(r, c.values))})) = ${n}`,
          sql`EXISTS (SELECT 1 FROM work.task_label tl JOIN work.label l ON l.id = tl.label_id
            WHERE tl.task_id = t.id AND l.state = 'active')`,
        );
      case 'milestone': {
        const pid = this.projectId();
        return this.multi(
          c,
          (xs) =>
            sql`EXISTS (SELECT 1 FROM work.milestone m WHERE m.workspace_id = r.workspace_id AND m.project_id = ${pid}
              AND m.lifecycle_state = 'active' AND m.id = ANY(${uuidArr(xs)}))`,
          (n) =>
            sql`(SELECT count(*) FROM work.milestone m WHERE m.workspace_id = r.workspace_id AND m.project_id = ${pid}
              AND m.lifecycle_state = 'active' AND m.id = ANY(${uuidArr(ids(r, c.values))})) = ${n}`,
          sql`EXISTS (SELECT 1 FROM work.milestone m WHERE m.workspace_id = r.workspace_id AND m.project_id = ${pid}
            AND m.lifecycle_state = 'active')`,
        );
      }
      case 'agent':
        // No agent can be assigned before 7A: the filter is exact over today's data (ADR-0018 Q3).
        return this.multi(
          c,
          () => sql`false`,
          () => sql`false`,
          sql`false`,
        );
      case 'subtask': {
        // A subtask whose parent the viewer cannot read is reported as top-level (its parent is
        // absent everywhere else too).
        const readableParent = sql<boolean>`EXISTS (SELECT 1 FROM core.record ptr WHERE ptr.workspace_id = r.workspace_id
          AND ptr.id = t.parent_task_id AND ${this.readable('ptr', sql`t.project_id`)})`;
        return c.op === 'is_true' || c.op === 'is_not_empty'
          ? readableParent
          : sql<boolean>`NOT ${readableParent}`;
      }
    }
    if (isCustom(c.field)) {
      const fd = r.fields.get(c.field)!;
      if (fd.kind === 'ref')
        return this.reference(
          c,
          sql`(SELECT fv.value_ref FROM workflow.field_value fv WHERE fv.workspace_id = r.workspace_id
            AND fv.definition_id = ${fd.id}::uuid AND fv.record_id = r.id)`,
        );
      return this.typed(c, fd.kind, this.scalarRaw(c.field));
    }
    const spec = c.field;
    if (['brand', 'project', 'parent', 'status', 'owner'].includes(spec))
      return this.reference(c, this.scalar(spec).expr);
    if (['status_category', 'priority', 'health'].includes(spec)) {
      const col = this.scalar(spec).expr;
      if (c.op === 'is_empty') return sql<boolean>`${col} IS NULL`;
      if (c.op === 'is_not_empty') return sql<boolean>`${col} IS NOT NULL`;
      const vals = c.values as string[];
      return c.op === 'in'
        ? sql<boolean>`${col} = ANY(${vals}::text[])`
        : sql<boolean>`(${col} IS NULL OR NOT (${col} = ANY(${vals}::text[])))`;
    }
    if (spec === 'title' || spec === 'name')
      return this.typed(c, 'text', spec === 'title' ? sql`t.title` : sql`w.name`);
    if (spec === 'estimate_minutes') return this.typed(c, 'number', sql`t.estimate_minutes`);
    const s = this.scalar(spec);
    if (s.type === 'date') return this.typed(c, 'date', s.expr);
    if (s.type === 'timestamptz') return this.typed(c, 'date', dayOf(s.expr));
    void e;
    throw new Error(`no condition for ${spec}`);
  }

  /** The raw (uncollated) typed value of a custom field. */
  scalarRaw(field: string): RawBuilder<unknown> {
    const fd = this.r.fields.get(field)!;
    const col =
      fd.kind === 'text'
        ? 'value_text'
        : fd.kind === 'number'
          ? 'value_numeric'
          : fd.kind === 'date'
            ? 'value_date'
            : 'value_bool';
    return sql`(SELECT fv.${sql.ref(col)} FROM workflow.field_value fv WHERE fv.workspace_id = r.workspace_id
      AND fv.definition_id = ${fd.id}::uuid AND fv.record_id = r.id)`;
  }

  reference(c: Condition, col: RawBuilder<unknown>): RawBuilder<boolean> {
    if (c.op === 'is_empty') return sql<boolean>`${col} IS NULL`;
    if (c.op === 'is_not_empty') return sql<boolean>`${col} IS NOT NULL`;
    const xs = ids(this.r, c.values);
    return c.op === 'in'
      ? sql<boolean>`${col} = ANY(${uuidArr(xs)})`
      : sql<boolean>`(${col} IS NULL OR NOT (${col} = ANY(${uuidArr(xs)})))`;
  }

  multi(
    c: Condition,
    any: (xs: string[]) => RawBuilder<unknown>,
    all: (n: number) => RawBuilder<unknown>,
    exists: RawBuilder<unknown>,
  ): RawBuilder<boolean> {
    const xs = ids(this.r, c.values);
    switch (c.op) {
      case 'any_of':
        return xs.length ? sql<boolean>`${any(xs)}` : sql<boolean>`false`;
      case 'none_of':
        return xs.length ? sql<boolean>`NOT ${any(xs)}` : sql<boolean>`true`;
      case 'all_of':
        // Every listed value must be present; an unresolvable value can never be present.
        return xs.length === c.values.length && xs.length
          ? sql<boolean>`${all(xs.length)}`
          : sql<boolean>`false`;
      case 'is_empty':
        return sql<boolean>`NOT ${exists}`;
      default:
        return sql<boolean>`${exists}`;
    }
  }

  typed(c: Condition, kind: ValueKind, col: RawBuilder<unknown>): RawBuilder<boolean> {
    if (c.op === 'is_empty')
      return kind === 'text'
        ? sql<boolean>`(${col} IS NULL OR ${col} = '')`
        : sql<boolean>`${col} IS NULL`;
    if (c.op === 'is_not_empty')
      return kind === 'text'
        ? sql<boolean>`(${col} IS NOT NULL AND ${col} <> '')`
        : sql<boolean>`${col} IS NOT NULL`;
    if (kind === 'bool')
      return c.op === 'is_true' ? sql<boolean>`${col} IS TRUE` : sql<boolean>`${col} IS FALSE`;
    if (kind === 'text') {
      const pattern = `%${(c.values[0] as string).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      return c.op === 'contains'
        ? sql<boolean>`${col} ILIKE ${pattern}`
        : sql<boolean>`(${col} IS NULL OR ${col} NOT ILIKE ${pattern})`;
    }
    const cast = kind === 'date' ? sql`::date` : sql`::numeric`;
    const v = (i: number) =>
      kind === 'date'
        ? sql`${dateValue(c.values[i] as DateValue, this.r.today)}${cast}`
        : sql`${c.values[i] as string}${cast}`;
    switch (c.op) {
      case 'on':
      case 'eq':
        return sql<boolean>`${col} = ${v(0)}`;
      case 'before':
      case 'lt':
        return sql<boolean>`${col} < ${v(0)}`;
      case 'after':
      case 'gt':
        return sql<boolean>`${col} > ${v(0)}`;
      case 'on_or_before':
      case 'lte':
        return sql<boolean>`${col} <= ${v(0)}`;
      case 'on_or_after':
      case 'gte':
        return sql<boolean>`${col} >= ${v(0)}`;
      case 'between':
        return sql<boolean>`(${col} >= ${v(0)} AND ${col} <= ${v(1)})`;
      default:
        throw new Error(`no operator ${c.op}`);
    }
  }
}

/** The ordering keys of a query: group key, then the sorts, then manual order; ID breaks ties. */
export function orderKeys(c: Compiler, q: Query): OrderKey[] {
  const keys: OrderKey[] = [];
  if (q.group) keys.push(c.groupKey(q.group.field, q.group.granularity));
  for (const s of q.sort) keys.push(c.sortKey(s.field, s.dir));
  if (!q.sort.some((s) => s.field === 'rank')) keys.push(c.sortKey('rank', 'asc'));
  return keys;
}

/** ORDER BY: nulls last in both directions (`expr IS NULL` first), then the record ID. */
export function orderBy(keys: OrderKey[]): RawBuilder<unknown> {
  const parts = keys.flatMap((k) => [
    sql`(${k.expr}) IS NULL`,
    k.dir === 'asc' ? sql`(${k.expr}) ASC` : sql`(${k.expr}) DESC`,
  ]);
  parts.push(sql`r.id ASC`);
  return sql.join(parts);
}

/** Cursor values: `[isNull, value]` per key. */
export type CursorKey = [boolean, string | number | boolean | null];

/**
 * The keyset predicate "after the cursor" for mixed directions with nulls last: an OR chain over
 * key prefixes, each key compared as (isNull flag, value).
 */
export function after(keys: OrderKey[], values: CursorKey[], id: string): RawBuilder<boolean> {
  const cmp = (k: OrderKey, v: CursorKey) => sql`${v[1]}::${sql.raw(k.type)}`;
  const eq = (k: OrderKey, v: CursorKey) =>
    v[0] ? sql`(${k.expr}) IS NULL` : sql`(${k.expr}) = ${cmp(k, v)}`;
  const gt = (k: OrderKey, v: CursorKey) => {
    // Nulls sort last: a non-null cursor is followed by greater values, then by nulls.
    if (v[0]) return sql`false`;
    const op = k.dir === 'asc' ? sql`>` : sql`<`;
    return sql`((${k.expr}) IS NULL OR (${k.expr}) ${op} ${cmp(k, v)})`;
  };
  const branches: RawBuilder<unknown>[] = [];
  for (let i = 0; i <= keys.length; i++) {
    const prefix = keys.slice(0, i).map((k, j) => eq(k, values[j]!));
    const last = i < keys.length ? gt(keys[i]!, values[i]!) : sql`r.id > ${id}::uuid`;
    branches.push(prefix.length ? sql`(${sql.join([...prefix, last], sql` AND `)})` : last);
  }
  return sql<boolean>`(${sql.join(branches, sql` OR `)})`;
}
