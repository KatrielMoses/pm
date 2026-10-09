import { sql, type WorkspaceTransaction } from '@pm/db';
import { TenancyError, type Principal } from '@pm/tenancy';
import type { Issues } from '@pm/tenancy';
import type { QueryResult } from '../views/view-service.ts';
import type { GoalListQuery } from '../goals/validation.ts';
import type { WorkSettings } from '../validation.ts';
import { addDays } from '../time/semantics.ts';
import {
  freshness,
  resolveRange,
  type DashboardFilters,
  type Freshness,
  type ResolvedRange,
} from './semantics.ts';

/**
 * The metric port of Phase 5D (ADR-0030 D4). A dashboard or report never calculates anything: a
 * widget names a metric, and the metric is answered by the service that already owns the data
 * (the 3A query engine for work counts, 5B goals, 3D time, 3E capacity, 3C daily records, 4E
 * deliverables), for the viewer, from what the viewer may read. Metric definitions owned by 5C
 * (cycle time, time in status, aging, created versus completed, blocked, stale) register through
 * this same port when they exist; until then they are listed as not yet available and cannot be
 * placed on a dashboard.
 */

export type Cell = string | number | null;

export interface MetricColumn {
  key: string;
  label: string;
}
export interface RecordLink {
  type: 'task' | 'project' | 'goal' | 'milestone' | 'deliverable' | 'brand' | 'member';
  id: string;
}
export interface MetricRow {
  cells: Record<string, Cell>;
  link: RecordLink | null;
}

export type IncompleteReason =
  | 'count_capped'
  | 'groups_truncated'
  | 'rows_truncated'
  | 'estimates_missing'
  | 'no_measurement'
  | 'source_stale';

export interface MetricValue {
  metric: string;
  version: number;
  label: string;
  unit: 'count' | 'minutes' | 'seconds' | 'percent' | 'none';
  value: number | null;
  breakdown: Array<{ key: string | null; label: string; value: number }>;
  columns: MetricColumn[];
  rows: MetricRow[];
  /** Incomplete data (RPT-023): what is missing, in codes the interface words. */
  incomplete: IncompleteReason[];
  /** Estimated data (RPT-023): the figure is built from estimates, not measurements. */
  estimated: boolean;
  notes: string[];
  /** What the figure covers, for the viewer: never a statement about what they cannot read. */
  covers: string;
  range: ResolvedRange | null;
  /** Which filters changed this figure; the others are shown as not applying (RPT-018). */
  applied: { range: boolean; brands: boolean; projects: boolean; people: boolean; statuses: boolean };
  source: { kind: string; label: string };
  freshness: Freshness;
  drill: boolean;
}

export interface DrillPage {
  columns: MetricColumn[];
  rows: MetricRow[];
  page: { limit: number; has_more: boolean; next_cursor?: string };
  covers: string;
}

/** The part of the dashboard or report a figure is computed for. */
export interface ReportScope {
  kind: 'workspace' | 'brand' | 'project' | 'personal';
  brand: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
}

export interface MetricHost {
  settings: WorkSettings;
  today(tx: WorkspaceTransaction): Promise<string>;
  weekStart(tx: WorkspaceTransaction): Promise<number>;
  query(
    tx: WorkspaceTransaction,
    p: Principal,
    raw: Record<string, unknown>,
    opts: { entity: 'task' | 'project'; limit: number; cursor?: unknown; groups: boolean },
  ): Promise<QueryResult>;
  goals(
    tx: WorkspaceTransaction,
    p: Principal,
    q: GoalListQuery,
    limit: number,
  ): Promise<{
    data: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    page: Record<string, unknown>;
  }>;
  timeReport(
    tx: WorkspaceTransaction,
    p: Principal,
    query: Record<string, unknown>,
    group: 'member' | 'brand' | 'project' | 'task' | 'day' | 'week' | 'month',
  ): Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  teamCapacity(
    tx: WorkspaceTransaction,
    p: Principal,
    query: Record<string, unknown>,
  ): Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  dailyRecords(
    tx: WorkspaceTransaction,
    p: Principal,
    query: Record<string, unknown>,
  ): Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The predicate for tasks and projects the viewer may read (archived excluded). */
  workVisibility(
    tx: WorkspaceTransaction,
    p: Principal,
  ): Promise<{ where(alias: string, opts: { project: unknown }): ReturnType<typeof sql> }>;
  seal(p: Principal, fp: string, pos: { k: string; id: string }): string;
  open(p: Principal, fp: string, raw: unknown): { k: string; id: string };
}

export interface MetricContext {
  tx: WorkspaceTransaction;
  p: Principal;
  host: MetricHost;
  scope: ReportScope;
  filters: DashboardFilters;
  today: string;
  weekStart: number;
  now: Date;
}

export type Applies = MetricValue['applied'];

type Computed = Partial<MetricValue> &
  Pick<MetricValue, 'value' | 'breakdown' | 'columns' | 'rows'>;

export interface MetricProvider {
  key: string;
  version: number;
  label: string;
  description: string;
  unit: MetricValue['unit'];
  category: 'work' | 'projects' | 'time' | 'capacity' | 'planning' | 'deliverables' | 'goals';
  source: { kind: string; label: string };
  /** Guests and share-only readers may place and read only record-level metrics (ADR-0030 D8). */
  guestSafe: boolean;
  applies: Applies;
  /** The dashboard kinds this metric makes sense on (a personal metric is not for a brand). */
  parse(raw: unknown, pointer: string, issues: Issues): Record<string, unknown> | null;
  compute(ctx: MetricContext, params: Record<string, unknown>): Promise<Computed>;
  drill(
    ctx: MetricContext,
    params: Record<string, unknown>,
    page: { limit: number; cursor: string | null },
  ): Promise<Pick<DrillPage, 'columns' | 'rows' | 'page'>>;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const NIL = '00000000-0000-7000-8000-000000000000';
const NONE = { range: false, brands: false, projects: false, people: false, statuses: false };

/** A plain cell from a hydrated query value (references become their names). */
export function cell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map((x) => cell(x)).join(', ') || null;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['label', 'name', 'title', 'key'])
      if (typeof o[k] === 'string') return o[k] as string;
  }
  return null;
}

export function coversText(scope: ReportScope): string {
  switch (scope.kind) {
    case 'project':
      return `Work you can read in the project ${scope.project?.name ?? ''}`.trim();
    case 'brand':
      return `Work you can read in ${scope.brand?.name ?? 'this brand'}`;
    case 'personal':
      return 'Your own work that you can read';
    default:
      return 'Work you can read in every brand you can access';
  }
}

const closeEnough = (n: number) => Math.round(n * 100) / 100;

type Cond = { field: string; op: string; value?: unknown };

/** The conditions the placement and the chosen filters add to a work query (only ever narrowing). */
function narrowing(
  ctx: MetricContext,
  entity: 'task' | 'project',
): { items: Cond[]; applied: Applies } {
  const items: Cond[] = [];
  const f = ctx.filters;
  const applied = { ...NONE };
  if (ctx.scope.brand) items.push({ field: 'brand', op: 'in', value: [ctx.scope.brand.id] });
  if (ctx.scope.project && entity === 'task')
    items.push({ field: 'project', op: 'in', value: [ctx.scope.project.id] });
  if (f.brands.length) {
    items.push({ field: 'brand', op: 'in', value: f.brands });
    applied.brands = true;
  }
  if (f.projects.length && entity === 'task') {
    items.push({ field: 'project', op: 'in', value: f.projects });
    applied.projects = true;
  }
  const people = f.people.length ? f.people : ctx.scope.kind === 'personal' ? ['me'] : [];
  if (people.length) {
    items.push(
      entity === 'task'
        ? { field: 'assignee', op: 'any_of', value: people }
        : { field: 'owner', op: 'in', value: people },
    );
    applied.people = f.people.length > 0;
  }
  if (f.statuses.length) {
    items.push({ field: 'status_category', op: 'in', value: f.statuses });
    applied.statuses = true;
  }
  return { items, applied };
}

const ast = (
  entity: 'task' | 'project',
  items: Cond[],
  sort: Array<{ field: string; dir: 'asc' | 'desc' }>,
  group?: string,
) => ({
  v: 1,
  entity,
  filter: items.length ? { op: 'and', items } : null,
  sort,
  ...(group && group !== 'none' ? { group: { field: group } } : {}),
});

const TASK_COLUMNS: MetricColumn[] = [
  { key: 'title', label: 'Task' },
  { key: 'project', label: 'Project' },
  { key: 'brand', label: 'Brand' },
  { key: 'status', label: 'Status' },
  { key: 'due_date', label: 'Due' },
  { key: 'owner', label: 'Owner' },
];
const PROJECT_COLUMNS: MetricColumn[] = [
  { key: 'title', label: 'Project' },
  { key: 'brand', label: 'Brand' },
  { key: 'status', label: 'Status' },
  { key: 'health', label: 'Health' },
  { key: 'target_date', label: 'Target' },
  { key: 'owner', label: 'Owner' },
];

function queryRow(entity: 'task' | 'project', r: Record<string, unknown>): MetricRow {
  const cols = entity === 'task' ? TASK_COLUMNS : PROJECT_COLUMNS;
  const cells: Record<string, Cell> = {};
  for (const c of cols) cells[c.key] = cell(r[c.key]);
  cells.title = cell(r.title ?? r.name);
  return { cells, link: typeof r.id === 'string' ? { type: entity, id: r.id } : null };
}

const PRESENTATION = {
  task: { columns: ['title', 'project', 'brand', 'status', 'due_date', 'owner'] },
  project: { columns: ['name', 'brand', 'status', 'health', 'target_date', 'owner'] },
};

const TASK_GROUPS = ['none', 'project', 'brand', 'assignee', 'priority', 'status_category'] as const;
const PROJECT_GROUPS = ['none', 'health', 'brand', 'owner'] as const;

function parseGroup(
  raw: unknown,
  pointer: string,
  allowed: readonly string[],
  issues: Issues,
  fallback = 'none',
): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return { group_by: fallback };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.add(pointer, 'invalid_type', 'Describe the options.');
    return null;
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (k !== 'group_by' && k !== 'days')
      issues.add(`${pointer}/${k}`, 'unsupported_field', 'This option is not supported.');
  const g = o.group_by ?? fallback;
  if (typeof g !== 'string' || !allowed.includes(g)) {
    issues.add(`${pointer}/group_by`, 'invalid_option', 'Choose how to group.');
    return null;
  }
  const out: Record<string, unknown> = { group_by: g };
  if (o.days !== undefined) {
    if (typeof o.days !== 'number' || !Number.isInteger(o.days) || o.days < 1 || o.days > 90) {
      issues.add(`${pointer}/days`, 'invalid_number', 'Choose 1 to 90 days.');
      return null;
    }
    out.days = o.days;
  }
  return out;
}

interface CountSpec {
  key: string;
  label: string;
  description: string;
  entity: 'task' | 'project';
  rangeApplies: boolean;
  daysParam?: boolean;
  conditions(ctx: MetricContext, params: Record<string, unknown>): Cond[];
  sort: Array<{ field: string; dir: 'asc' | 'desc' }>;
  defaultGroup?: string;
}

/** A count over the 3A query engine: total, grouping, and the rows behind it, for the viewer. */
function countMetric(s: CountSpec): MetricProvider {
  const groups = s.entity === 'task' ? TASK_GROUPS : PROJECT_GROUPS;
  const build = (ctx: MetricContext, params: Record<string, unknown>, group?: string) => {
    const n = narrowing(ctx, s.entity);
    const range = resolveRange(ctx.filters.range, ctx.today, ctx.weekStart);
    const items = [...n.items, ...s.conditions(ctx, params)];
    const applied = { ...n.applied, range: s.rangeApplies && range !== null };
    return {
      query: ast(s.entity, items, s.sort, group),
      applied,
      range: s.rangeApplies ? range : null,
    };
  };
  return {
    key: s.key,
    version: 1,
    label: s.label,
    description: s.description,
    unit: 'count',
    category: s.entity === 'task' ? 'work' : 'projects',
    source: { kind: 'work_query', label: 'Tasks and projects (saved-view query engine)' },
    guestSafe: s.entity === 'task',
    applies: {
      range: s.rangeApplies,
      brands: true,
      projects: s.entity === 'task',
      people: true,
      statuses: true,
    },
    parse: (raw, pointer, issues) =>
      parseGroup(raw, pointer, groups, issues, s.defaultGroup ?? 'none'),
    async compute(ctx, params) {
      const group = String(params.group_by ?? 'none');
      const b = build(ctx, params, group);
      const r = await ctx.host.query(
        ctx.tx,
        ctx.p,
        {
          query: b.query,
          presentation: PRESENTATION[s.entity],
          today: ctx.today,
        },
        { entity: s.entity, limit: 1, groups: group !== 'none' },
      );
      const total = r.page.total ?? { value: 0, capped: false };
      const incomplete: IncompleteReason[] = [];
      if (total.capped) incomplete.push('count_capped');
      if (r.groups_truncated) incomplete.push('groups_truncated');
      const breakdown = (r.groups ?? []).map((g) => ({ key: g.key, label: g.label, value: g.count }));
      return {
        value: total.value,
        breakdown,
        columns: [
          { key: 'label', label: group === 'none' ? 'Measure' : 'Group' },
          { key: 'count', label: 'Count' },
        ],
        rows: breakdown.length
          ? breakdown.map((g) => ({ cells: { label: g.label, count: g.value }, link: null }))
          : [{ cells: { label: s.label, count: total.value }, link: null }],
        incomplete,
        range: b.range,
        applied: b.applied,
      };
    },
    async drill(ctx, params, page) {
      const b = build(ctx, params);
      const r = await ctx.host.query(
        ctx.tx,
        ctx.p,
        { query: b.query, presentation: PRESENTATION[s.entity], today: ctx.today },
        { entity: s.entity, limit: page.limit, cursor: page.cursor ?? undefined, groups: false },
      );
      return {
        columns: s.entity === 'task' ? TASK_COLUMNS : PROJECT_COLUMNS,
        rows: r.data.map((row) => queryRow(s.entity, row)),
        page: {
          limit: r.page.limit,
          has_more: r.page.has_more,
          ...(r.page.next_cursor ? { next_cursor: r.page.next_cursor } : {}),
        },
      };
    },
  };
}

const OPEN: Cond = { field: 'status_category', op: 'not_in', value: ['done', 'cancelled'] };
const rel = (days: number) => ({ rel: 'today', days });

const taskMetrics: MetricProvider[] = [
  countMetric({
    key: 'tasks.open',
    label: 'Open tasks',
    description: 'Tasks that are not done or cancelled.',
    entity: 'task',
    rangeApplies: false,
    conditions: () => [OPEN],
    sort: [{ field: 'due_date', dir: 'asc' }],
  }),
  countMetric({
    key: 'tasks.due_soon',
    label: 'Due soon',
    description: 'Open tasks due from today through the next days (default 7).',
    entity: 'task',
    rangeApplies: false,
    daysParam: true,
    conditions: (_c, params) => [
      OPEN,
      { field: 'due_date', op: 'between', value: [rel(0), rel(Number(params.days ?? 7))] },
    ],
    sort: [{ field: 'due_date', dir: 'asc' }],
  }),
  countMetric({
    key: 'tasks.overdue',
    label: 'Overdue tasks',
    description: 'Open tasks whose due date has passed.',
    entity: 'task',
    rangeApplies: false,
    conditions: () => [OPEN, { field: 'due_date', op: 'before', value: rel(0) }],
    sort: [{ field: 'due_date', dir: 'asc' }],
  }),
  countMetric({
    key: 'tasks.unassigned',
    label: 'Unassigned tasks',
    description: 'Open tasks nobody is assigned to.',
    entity: 'task',
    rangeApplies: false,
    conditions: () => [OPEN, { field: 'assignee', op: 'is_empty' }],
    sort: [{ field: 'due_date', dir: 'asc' }],
  }),
  countMetric({
    key: 'tasks.completed',
    label: 'Completed tasks',
    description: 'Tasks completed in the chosen date range (last 30 days by default).',
    entity: 'task',
    rangeApplies: true,
    conditions: (ctx) => {
      const r = resolveRange(ctx.filters.range, ctx.today, ctx.weekStart) ?? {
        from: addDays(ctx.today, -29),
        to: ctx.today,
      };
      return [
        { field: 'status_category', op: 'in', value: ['done'] },
        { field: 'completed_at', op: 'between', value: [r.from, r.to] },
      ];
    },
    sort: [{ field: 'completed_at', dir: 'desc' }],
  }),
  countMetric({
    key: 'tasks.created',
    label: 'Created tasks',
    description: 'Tasks created in the chosen date range (last 30 days by default).',
    entity: 'task',
    rangeApplies: true,
    conditions: (ctx) => {
      const r = resolveRange(ctx.filters.range, ctx.today, ctx.weekStart) ?? {
        from: addDays(ctx.today, -29),
        to: ctx.today,
      };
      return [{ field: 'created_at', op: 'between', value: [r.from, r.to] }];
    },
    sort: [{ field: 'created_at', dir: 'desc' }],
  }),
  countMetric({
    key: 'projects.active',
    label: 'Active projects and health',
    description: 'Projects in progress, grouped by health.',
    entity: 'project',
    rangeApplies: false,
    conditions: () => [{ field: 'status_category', op: 'in', value: ['active'] }],
    sort: [{ field: 'name', dir: 'asc' }],
    defaultGroup: 'health',
  }),
  countMetric({
    key: 'projects.deadlines',
    label: 'Upcoming project deadlines',
    description: 'Open projects with a deadline in the next days (default 30).',
    entity: 'project',
    rangeApplies: false,
    daysParam: true,
    conditions: (_c, params) => [
      OPEN,
      { field: 'deadline_date', op: 'between', value: [rel(0), rel(Number(params.days ?? 30))] },
    ],
    sort: [{ field: 'deadline_date', dir: 'asc' }],
  }),
];

// ---------------------------------------------------------------------------------------------
// Milestones (RPT-004)
// ---------------------------------------------------------------------------------------------

const MILESTONE_COLUMNS: MetricColumn[] = [
  { key: 'name', label: 'Milestone' },
  { key: 'project', label: 'Project' },
  { key: 'brand', label: 'Brand' },
  { key: 'due_date', label: 'Due' },
];

async function milestoneRows(
  ctx: MetricContext,
  days: number,
  limit: number,
  after: { k: string; id: string } | null,
) {
  const vis = await ctx.host.workVisibility(ctx.tx, ctx.p);
  const brands = [...(ctx.scope.brand ? [ctx.scope.brand.id] : []), ...ctx.filters.brands];
  const projects = [...(ctx.scope.project ? [ctx.scope.project.id] : []), ...ctx.filters.projects];
  const to = addDays(ctx.today, days);
  const rows = await sql<{
    public_id: string;
    name: string;
    due_date: string;
    project_name: string;
    brand_name: string;
    k: string;
  }>`
    SELECT mr.public_id, m.name, m.due_date::text AS due_date, pj.name AS project_name, b.name AS brand_name,
           m.due_date::text || m.id::text AS k
      FROM work.milestone m
      JOIN core.record mr ON mr.workspace_id = m.workspace_id AND mr.id = m.id
      JOIN work.project pj ON pj.workspace_id = m.workspace_id AND pj.id = m.project_id
      JOIN tenancy.brand b ON b.workspace_id = m.workspace_id AND b.id = m.brand_id
     WHERE m.workspace_id = ${ctx.tx.workspaceId} AND m.lifecycle_state = 'active' AND m.status = 'planned'
       AND m.due_date BETWEEN ${ctx.today}::date AND ${to}::date
       AND ${vis.where('mr', { project: sql`m.project_id` })}
       ${brands.length ? sql`AND b.id IN (SELECT id FROM core.record WHERE public_id = ANY(${brands}::text[]))` : sql``}
       ${projects.length ? sql`AND pj.id IN (SELECT id FROM core.record WHERE public_id = ANY(${projects}::text[]))` : sql``}
       ${after ? sql`AND (m.due_date::text || m.id::text) > ${after.k}` : sql``}
     ORDER BY m.due_date, m.id LIMIT ${limit + 1}`.execute(ctx.tx.db);
  return rows.rows;
}

const milestones: MetricProvider = {
  key: 'milestones.upcoming',
  version: 1,
  label: 'Upcoming milestones',
  description: 'Milestones not yet reached with a due date in the next days (default 30).',
  unit: 'count',
  category: 'projects',
  source: { kind: 'work_milestones', label: 'Project milestones' },
  guestSafe: false,
  applies: { range: false, brands: true, projects: true, people: false, statuses: false },
  parse: (raw, pointer, issues) => parseGroup(raw, pointer, ['none'], issues),
  async compute(ctx, params) {
    const max = ctx.host.settings.reportExportRowsMax;
    const rows = await milestoneRows(ctx, Number(params.days ?? 30), Math.min(max, 200), null);
    const shown = rows.slice(0, Math.min(max, 200));
    return {
      value: shown.length,
      breakdown: [],
      columns: MILESTONE_COLUMNS,
      rows: shown.map((r) => ({
        cells: { name: r.name, project: r.project_name, brand: r.brand_name, due_date: r.due_date },
        link: { type: 'milestone' as const, id: r.public_id },
      })),
      incomplete: rows.length > shown.length ? ['rows_truncated' as const] : [],
      applied: { ...NONE, brands: ctx.filters.brands.length > 0, projects: ctx.filters.projects.length > 0 },
    };
  },
  async drill(ctx, params, page) {
    const fp = `milestones:${JSON.stringify([params.days ?? 30, ctx.filters.brands, ctx.filters.projects])}`;
    const after = page.cursor ? ctx.host.open(ctx.p, fp, page.cursor) : null;
    const rows = await milestoneRows(ctx, Number(params.days ?? 30), page.limit, after);
    const shown = rows.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return {
      columns: MILESTONE_COLUMNS,
      rows: shown.map((r) => ({
        cells: { name: r.name, project: r.project_name, brand: r.brand_name, due_date: r.due_date },
        link: { type: 'milestone' as const, id: r.public_id },
      })),
      page: {
        limit: page.limit,
        has_more: rows.length > shown.length,
        ...(rows.length > shown.length && last
          ? { next_cursor: ctx.host.seal(ctx.p, fp, { k: last.k, id: last.public_id }) }
          : {}),
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Goals (RPT-016)
// ---------------------------------------------------------------------------------------------

const GOAL_COLUMNS: MetricColumn[] = [
  { key: 'title', label: 'Goal' },
  { key: 'scope', label: 'Scope' },
  { key: 'status', label: 'Status' },
  { key: 'progress', label: 'Progress %' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'update', label: 'Update' },
];

function goalQuery(ctx: MetricContext, limit: number, cursor: string | null): GoalListQuery {
  const brand = ctx.scope.brand?.id ?? (ctx.filters.brands[0] ?? null);
  return {
    brand,
    project: ctx.scope.project?.id ?? ctx.filters.projects[0] ?? null,
    statuses: ctx.filters.statuses.length ? null : ['active'],
    owner: ctx.filters.people[0] ?? (ctx.scope.kind === 'personal' ? 'me' : null),
    basis: null,
    confidence: null,
    update: null,
    period: 'current',
    from: null,
    to: null,
    q: null,
    archived: false,
    limit,
    cursor,
  };
}

const goalRow = (g: Record<string, any>): MetricRow => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
  cells: {
    title: g.title,
    scope: g.scope?.kind === 'workspace' ? 'Workspace' : cell(g.scope?.brand) ?? cell(g.scope?.project),
    status: g.status,
    progress: g.progress?.percent ?? null,
    confidence: g.latest?.confidence ?? null,
    update: g.freshness?.update_state ?? null,
  },
  link: { type: 'goal', id: g.id },
});

const goalsMetric: MetricProvider = {
  key: 'goals.progress',
  version: 1,
  label: 'Goal progress',
  description: 'Active goals in the current period with the progress you can see.',
  unit: 'count',
  category: 'goals',
  source: { kind: 'goals', label: 'Goals and key results' },
  guestSafe: false,
  applies: { range: false, brands: true, projects: true, people: true, statuses: false },
  parse: (raw, pointer, issues) => parseGroup(raw, pointer, ['none'], issues),
  async compute(ctx) {
    const max = Math.min(ctx.host.settings.reportExportRowsMax, 200);
    const page = await ctx.host.goals(ctx.tx, ctx.p, goalQuery(ctx, null as never, null), max);
    const rows = page.data.map(goalRow);
    const missing = page.data.filter((g) => g.progress?.percent === null || g.progress?.percent === undefined);
    const known = page.data.length - missing.length;
    const avg = known
      ? closeEnough(
          page.data.reduce((a, g) => a + (Number(g.progress?.percent) || 0), 0) / known,
        )
      : null;
    const incomplete: IncompleteReason[] = [];
    if (page.page.has_more) incomplete.push('rows_truncated');
    if (missing.length) incomplete.push('no_measurement');
    return {
      value: avg,
      breakdown: [],
      columns: GOAL_COLUMNS,
      rows,
      incomplete,
      notes: [
        `The figure is the average progress of the ${known} goals with a measurement; progress from linked work covers the work you can read.`,
      ],
      applied: {
        ...NONE,
        brands: ctx.filters.brands.length > 0,
        projects: ctx.filters.projects.length > 0,
        people: ctx.filters.people.length > 0,
      },
    };
  },
  async drill(ctx, _params, page) {
    const r = await ctx.host.goals(ctx.tx, ctx.p, goalQuery(ctx, page.limit, page.cursor), page.limit);
    return {
      columns: GOAL_COLUMNS,
      rows: r.data.map(goalRow),
      page: {
        limit: page.limit,
        has_more: r.page.has_more === true,
        ...(typeof r.page.next_cursor === 'string' ? { next_cursor: r.page.next_cursor } : {}),
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Time (RPT-006, RPT-011)
// ---------------------------------------------------------------------------------------------

function timeQuery(ctx: MetricContext, group: string): Record<string, unknown> {
  const r = resolveRange(ctx.filters.range, ctx.today, ctx.weekStart) ?? {
    from: addDays(ctx.today, -29),
    to: ctx.today,
  };
  const q: Record<string, unknown> = { from: r.from, to: r.to, group };
  const brands = [...(ctx.scope.brand ? [ctx.scope.brand.id] : []), ...ctx.filters.brands];
  if (brands.length) q.brands = brands.join(',');
  const target = ctx.scope.project?.id ?? ctx.filters.projects[0];
  if (target) q.target = target;
  const member = ctx.filters.people[0] ?? (ctx.scope.kind === 'personal' ? 'me' : undefined);
  if (member) q.member = member;
  return q;
}

const hours = (seconds: number) => closeEnough(seconds / 3600);

function timeMetric(
  key: string,
  label: string,
  description: string,
  group: 'brand' | 'project' | 'member',
  planned: boolean,
): MetricProvider {
  const columns: MetricColumn[] = [
    { key: 'label', label: group === 'brand' ? 'Brand' : group === 'project' ? 'Project' : 'Person' },
    ...(planned ? [{ key: 'planned_hours', label: 'Planned hours (estimate)' }] : []),
    { key: 'actual_hours', label: 'Actual hours' },
    { key: 'billable_hours', label: 'Billable hours' },
  ];
  const rowsOf = (rep: Record<string, any>): MetricRow[] => // eslint-disable-line @typescript-eslint/no-explicit-any
    (rep.rows as Array<Record<string, any>>).map((r) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      cells: {
        label: r.key.label,
        ...(planned
          ? { planned_hours: r.planned_minutes === null ? null : closeEnough(r.planned_minutes / 60) }
          : {}),
        actual_hours: hours(r.actual_seconds),
        billable_hours: hours(r.billable_seconds),
      },
      link: r.key.id ? { type: group === 'member' ? 'member' : group, id: r.key.id } : null,
    }));
  return {
    key,
    version: 1,
    label,
    description,
    unit: 'seconds',
    category: 'time',
    source: { kind: 'time', label: 'Time entries and task estimates' },
    guestSafe: false,
    applies: { range: true, brands: true, projects: true, people: true, statuses: false },
    parse: (raw, pointer, issues) => parseGroup(raw, pointer, ['none'], issues),
    async compute(ctx) {
      let rep: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        rep = await ctx.host.timeReport(ctx.tx, ctx.p, timeQuery(ctx, group), group);
      } catch (err) {
        if (err instanceof TenancyError && err.code === 'not_found')
          return { value: 0, breakdown: [], columns, rows: [], incomplete: [] };
        throw err;
      }
      const rows = rowsOf(rep);
      return {
        value: rep.totals.actual_seconds,
        breakdown: (rep.rows as Array<Record<string, any>>).map((r) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
          key: r.key.id,
          label: r.key.label,
          value: r.actual_seconds,
        })),
        columns,
        rows,
        incomplete: rep.truncated ? ['rows_truncated'] : [],
        estimated: planned,
        notes: planned
          ? ['Planned time is the sum of task estimates, not a measurement; tasks without an estimate add nothing to it.']
          : [],
        range: { from: rep.range.from, to: rep.range.to, label: `${rep.range.from} to ${rep.range.to}` },
        applied: {
          ...NONE,
          range: true,
          brands: ctx.filters.brands.length > 0,
          projects: ctx.filters.projects.length > 0,
          people: ctx.filters.people.length > 0,
        },
      };
    },
    async drill(ctx, _params, page) {
      const rep = await ctx.host.timeReport(ctx.tx, ctx.p, timeQuery(ctx, group), group);
      const rows = rowsOf(rep);
      return { columns, rows: rows.slice(0, page.limit), page: { limit: page.limit, has_more: false } };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Capacity (RPT-010) and the daily plan (RPT-005)
// ---------------------------------------------------------------------------------------------

const capacityMetric: MetricProvider = {
  key: 'capacity.workload',
  version: 1,
  label: 'Workload and capacity',
  description: 'Allocation against capacity for the people whose capacity you may see.',
  unit: 'count',
  category: 'capacity',
  source: { kind: 'capacity', label: 'Capacity and reservations' },
  guestSafe: false,
  applies: { range: true, brands: true, projects: false, people: false, statuses: false },
  parse: (raw, pointer, issues) => parseGroup(raw, pointer, ['none'], issues),
  async compute(ctx) {
    const r = resolveRange(ctx.filters.range, ctx.today, ctx.weekStart) ?? {
      from: ctx.today,
      to: addDays(ctx.today, 6),
      label: 'Next 7 days',
    };
    const q: Record<string, unknown> = { from: r.from, to: r.to };
    const brand = ctx.scope.brand?.id ?? ctx.filters.brands[0];
    if (brand) q.brand = brand;
    const rep = await ctx.host.teamCapacity(ctx.tx, ctx.p, q);
    const people = rep.people as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const columns: MetricColumn[] = [
      { key: 'person', label: 'Person' },
      { key: 'over', label: 'Over capacity (min)' },
      { key: 'conflicts', label: 'Conflicts' },
    ];
    return {
      value: people.filter((x) => Number(x.totals?.over) > 0).length,
      breakdown: [],
      columns,
      rows: people.map((x) => ({
        cells: { person: x.member?.name ?? null, over: Number(x.totals?.over ?? 0), conflicts: Number(x.conflicts ?? 0) },
        link: null,
      })),
      incomplete: rep.truncated ? ['rows_truncated'] : [],
      estimated: true,
      notes: ['Scheduled and estimated use is built from task estimates and work blocks.'],
      range: { from: r.from, to: r.to, label: r.label },
      applied: { ...NONE, range: ctx.filters.range !== null, brands: ctx.filters.brands.length > 0 },
    };
  },
  async drill(ctx, params, page) {
    const c = await this.compute(ctx, params);
    return { columns: c.columns, rows: c.rows.slice(0, page.limit), page: { limit: page.limit, has_more: false } };
  },
};

const planningMetric: MetricProvider = {
  key: 'planning.planned_vs_completed',
  version: 1,
  label: 'Planned versus completed',
  description: 'Your own daily plans: what was planned each day and what was completed.',
  unit: 'percent',
  category: 'planning',
  source: { kind: 'planning', label: 'Your daily records' },
  guestSafe: false,
  applies: { range: true, brands: false, projects: false, people: false, statuses: false },
  parse: (raw, pointer, issues) => parseGroup(raw, pointer, ['none'], issues),
  async compute(ctx) {
    const r = resolveRange(ctx.filters.range, ctx.today, ctx.weekStart) ?? {
      from: addDays(ctx.today, -13),
      to: ctx.today,
      label: 'Last 14 days',
    };
    const rep = await ctx.host.dailyRecords(ctx.tx, ctx.p, { from: r.from, to: r.to });
    const recs = rep.records as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const columns: MetricColumn[] = [
      { key: 'day', label: 'Day' },
      { key: 'planned', label: 'Planned' },
      { key: 'completed', label: 'Completed' },
    ];
    const planned = recs.reduce((a, x) => a + Number(x.planned_count ?? x.planned ?? 0), 0);
    const completed = recs.reduce((a, x) => a + Number(x.completed_count ?? x.completed ?? 0), 0);
    return {
      value: planned ? closeEnough((completed / planned) * 100) : null,
      breakdown: [],
      columns,
      rows: recs.map((x) => ({
        cells: {
          day: x.day,
          planned: Number(x.planned_count ?? x.planned ?? 0),
          completed: Number(x.completed_count ?? x.completed ?? 0),
        },
        link: null,
      })),
      incomplete: planned ? [] : ['no_measurement'],
      notes: ['These are your own plans; other people’s daily plans are never included.'],
      range: { from: r.from, to: r.to, label: r.label },
      applied: { ...NONE, range: ctx.filters.range !== null },
    };
  },
  async drill(ctx, params, page) {
    const c = await this.compute(ctx, params);
    return { columns: c.columns, rows: c.rows.slice(0, page.limit), page: { limit: page.limit, has_more: false } };
  },
};

// ---------------------------------------------------------------------------------------------
// Deliverables (RPT-014)
// ---------------------------------------------------------------------------------------------

const DELIVERABLE_COLUMNS: MetricColumn[] = [
  { key: 'title', label: 'Deliverable' },
  { key: 'task', label: 'Task' },
  { key: 'brand', label: 'Brand' },
  { key: 'state', label: 'State' },
  { key: 'updated', label: 'Updated' },
];
const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  ready_for_review: 'Ready for review',
  changes_requested: 'Changes requested',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

async function deliverableScope(ctx: MetricContext) {
  const vis = await ctx.host.workVisibility(ctx.tx, ctx.p);
  const brands = [...(ctx.scope.brand ? [ctx.scope.brand.id] : []), ...ctx.filters.brands];
  const projects = [...(ctx.scope.project ? [ctx.scope.project.id] : []), ...ctx.filters.projects];
  const r = resolveRange(ctx.filters.range, ctx.today, ctx.weekStart);
  return sql`
      FROM files.deliverable d
      JOIN work.task t ON t.workspace_id = d.workspace_id AND t.id = d.task_id
      JOIN core.record tr ON tr.workspace_id = t.workspace_id AND tr.id = t.id
      JOIN core.record dr ON dr.workspace_id = d.workspace_id AND dr.id = d.id
      JOIN tenancy.brand b ON b.workspace_id = d.workspace_id AND b.id = d.brand_id
     WHERE d.workspace_id = ${ctx.tx.workspaceId} AND ${vis.where('tr', { project: sql`t.project_id` })}
       ${brands.length ? sql`AND d.brand_id IN (SELECT id FROM core.record WHERE public_id = ANY(${brands}::text[]))` : sql``}
       ${projects.length ? sql`AND t.project_id IN (SELECT id FROM core.record WHERE public_id = ANY(${projects}::text[]))` : sql``}
       ${r ? sql`AND d.updated_at >= ${r.from}::date AND d.updated_at < (${r.to}::date + 1)` : sql``}`;
}

const deliverablesMetric: MetricProvider = {
  key: 'deliverables.status',
  version: 1,
  label: 'Deliverables by state',
  description: 'Accepted, rejected, and pending deliverables on work you can read.',
  unit: 'count',
  category: 'deliverables',
  source: { kind: 'deliverables', label: 'Deliverables (files)' },
  guestSafe: false,
  applies: { range: true, brands: true, projects: true, people: false, statuses: false },
  parse: (raw, pointer, issues) => parseGroup(raw, pointer, ['none'], issues),
  async compute(ctx) {
    const from = await deliverableScope(ctx);
    const rows = await sql<{ state: string; n: string }>`
      SELECT d.state, count(*)::text AS n ${from} GROUP BY d.state ORDER BY d.state`.execute(ctx.tx.db);
    const breakdown = rows.rows.map((r) => ({
      key: r.state,
      label: STATE_LABEL[r.state] ?? r.state,
      value: Number(r.n),
    }));
    const pending = breakdown
      .filter((b) => ['draft', 'ready_for_review', 'changes_requested'].includes(String(b.key)))
      .reduce((a, b) => a + b.value, 0);
    const range = resolveRange(ctx.filters.range, ctx.today, ctx.weekStart);
    return {
      value: breakdown.reduce((a, b) => a + b.value, 0),
      breakdown,
      columns: [
        { key: 'state', label: 'State' },
        { key: 'count', label: 'Count' },
      ],
      rows: [
        ...breakdown.map((b) => ({ cells: { state: b.label, count: b.value }, link: null })),
        { cells: { state: 'Pending (draft, review, changes)', count: pending }, link: null },
      ],
      incomplete: [],
      range,
      applied: {
        ...NONE,
        range: range !== null,
        brands: ctx.filters.brands.length > 0,
        projects: ctx.filters.projects.length > 0,
      },
    };
  },
  async drill(ctx, _params, page) {
    const from = await deliverableScope(ctx);
    const fp = `deliverables:${JSON.stringify([ctx.filters.brands, ctx.filters.projects, ctx.filters.range])}`;
    const after = page.cursor ? ctx.host.open(ctx.p, fp, page.cursor) : null;
    const rows = await sql<{
      public_id: string;
      title: string;
      task_title: string;
      brand_name: string;
      state: string;
      updated: string;
      k: string;
    }>`
      SELECT dr.public_id, d.title, t.title AS task_title, b.name AS brand_name, d.state,
             d.updated_at::text AS updated, lpad(extract(epoch FROM d.updated_at)::bigint::text, 12, '0') || d.id::text AS k
      ${from} ${after ? sql`AND (lpad(extract(epoch FROM d.updated_at)::bigint::text, 12, '0') || d.id::text) < ${after.k}` : sql``}
      ORDER BY d.updated_at DESC, d.id DESC LIMIT ${page.limit + 1}`.execute(ctx.tx.db);
    const shown = rows.rows.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return {
      columns: DELIVERABLE_COLUMNS,
      rows: shown.map((r) => ({
        cells: {
          title: r.title,
          task: r.task_title,
          brand: r.brand_name,
          state: STATE_LABEL[r.state] ?? r.state,
          updated: r.updated.slice(0, 10),
        },
        link: { type: 'deliverable' as const, id: r.public_id },
      })),
      page: {
        limit: page.limit,
        has_more: rows.rows.length > shown.length,
        ...(rows.rows.length > shown.length && last
          ? { next_cursor: ctx.host.seal(ctx.p, fp, { k: last.k, id: last.public_id }) }
          : {}),
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------------------------

export const PROVIDERS: readonly MetricProvider[] = [
  ...taskMetrics,
  milestones,
  planningMetric,
  timeMetric(
    'time.planned_vs_actual',
    'Planned versus actual time',
    'Task estimates against time logged, by project.',
    'project',
    true,
  ),
  timeMetric(
    'time.by_brand',
    'Time investment by brand',
    'Time logged per brand in the chosen range.',
    'brand',
    false,
  ),
  timeMetric(
    'time.by_project',
    'Time investment by project',
    'Time logged per project in the chosen range.',
    'project',
    false,
  ),
  capacityMetric,
  deliverablesMetric,
  goalsMetric,
];

/** Requirements whose sources are defined by a later phase: listed, never placed (honest absence). */
export const DEFERRED_METRICS: ReadonlyArray<{
  key: string;
  label: string;
  requirement: string;
  owner: string;
  reason: string;
}> = [
  { key: 'work.blocked', label: 'Blocked work', requirement: 'RPT-003', owner: '5C', reason: 'The blocked and stale definitions arrive with the metrics model.' },
  { key: 'work.stale', label: 'Stale work', requirement: 'RPT-003', owner: '5C', reason: 'The blocked and stale definitions arrive with the metrics model.' },
  { key: 'work.cycle_time', label: 'Cycle time and time in status', requirement: 'RPT-007', owner: '5C', reason: 'Cycle time needs the metrics model definition.' },
  { key: 'work.created_vs_completed', label: 'Created versus completed', requirement: 'RPT-008', owner: '5C', reason: 'The combined trend needs the metrics model definition.' },
  { key: 'work.aging', label: 'Task aging', requirement: 'RPT-009', owner: '5C', reason: 'Aging needs the metrics model definition.' },
  { key: 'ai.usage', label: 'AI usage and cost', requirement: 'RPT-012', owner: '7A', reason: 'AI usage is not tracked yet.' },
  { key: 'automation.rates', label: 'Automation and agent success rates', requirement: 'RPT-013', owner: '8A/8C', reason: 'Automations and agents do not exist yet.' },
  { key: 'quality.release', label: 'Test pass rate, flaky tests, defects, and release blockers', requirement: 'RPT-015', owner: '9B/9C/9D', reason: 'Testing and release management do not exist yet.' },
];

const BY_KEY = new Map(PROVIDERS.map((p) => [p.key, p]));
export const providerOf = (key: string): MetricProvider | null => BY_KEY.get(key) ?? null;

/** The complete widget answer: the provider's figure plus the labels every figure carries. */
export async function evaluate(
  provider: MetricProvider,
  ctx: MetricContext,
  params: Record<string, unknown>,
  staleMinutes: number,
): Promise<MetricValue> {
  const c = await provider.compute(ctx, params);
  const range = c.range ?? null;
  return {
    metric: provider.key,
    version: provider.version,
    label: provider.label,
    unit: provider.unit,
    value: c.value,
    breakdown: c.breakdown,
    columns: c.columns,
    rows: c.rows,
    incomplete: c.incomplete ?? [],
    estimated: c.estimated ?? false,
    notes: c.notes ?? [],
    covers: coversText(ctx.scope),
    range,
    applied: c.applied ?? { ...NONE },
    source: provider.source,
    freshness: freshness(ctx.now, null, staleMinutes),
    drill: true,
  };
}

export const noFilters: DashboardFilters = {
  range: null,
  brands: [],
  projects: [],
  people: [],
  statuses: [],
};

export { NIL };
