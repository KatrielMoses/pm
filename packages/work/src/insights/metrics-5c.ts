import type { Issues } from '@pm/tenancy';
import type {
  Applies,
  Cell,
  IncompleteReason,
  MetricColumn,
  MetricContext,
  MetricProvider,
  MetricRow,
  MetricValue,
} from './metrics.ts';
import { resolveRange } from './semantics.ts';

/**
 * The 5C metrics on the 5D metric port (ADR-0031 D4, ADR-0030 M16). A dashboard or report never
 * calculates these: each widget asks the metric service for the figure and for the records behind
 * it, for the viewer, inside the transaction the report already holds. The figure, its state and
 * incomplete reasons, its freshness, and its definition's limits come from the service unchanged;
 * this file only chooses which number is the headline and how the rest is tabulated.
 */

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Computed = Partial<MetricValue> &
  Pick<MetricValue, 'value' | 'breakdown' | 'columns' | 'rows'>;

const NO_FILTERS: Applies = {
  range: false,
  brands: false,
  projects: false,
  people: false,
  statuses: false,
};
const RECORD_COLUMNS: MetricColumn[] = [
  { key: 'title', label: 'Task' },
  { key: 'project', label: 'Project' },
  { key: 'brand', label: 'Brand' },
  { key: 'status', label: 'Status' },
  { key: 'due_date', label: 'Due' },
];
const STATUS_LABEL: Record<string, string> = {
  planned: 'Planned',
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Cancelled',
};

interface Spec {
  key: string;
  label: string;
  description: string;
  unit: MetricValue['unit'];
  /** The 5C metric that answers it. */
  metric: string;
  /** The 5C drill roles a widget may list; the first is the default. */
  roles: readonly string[];
  /** The headline number of the 5C figure. */
  headline(v: Obj, role: string): number | null;
  /** Further figures, as a breakdown. */
  breakdown(v: Obj): Array<{ key: string | null; label: string; value: number }>;
  columns: MetricColumn[];
  rows(v: Obj): MetricRow[];
  /** Whether the metric reads a window (the dashboard's date range applies). */
  windowed: boolean;
}

const num = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const present = <T extends { value: number | null }>(xs: T[]) =>
  xs.filter((x): x is T & { value: number } => x.value !== null);

const SPECS: readonly Spec[] = [
  {
    key: 'work.cycle_time',
    label: 'Cycle time',
    description: 'How long finished tasks took from first being worked on to done (median).',
    unit: 'seconds',
    metric: 'work.cycle_time',
    roles: ['included', 'excluded'],
    windowed: true,
    headline: (v) => num(v.median_seconds),
    breakdown: (v) =>
      present([
        { key: 'median', label: 'Median', value: num(v.median_seconds) },
        { key: 'p85', label: '85th percentile', value: num(v.p85_seconds) },
        { key: 'mean', label: 'Mean', value: num(v.mean_seconds) },
      ]),
    columns: [
      { key: 'measure', label: 'Measure' },
      { key: 'seconds', label: 'Seconds' },
    ],
    rows: (v) =>
      present([
        { key: 'Median', value: num(v.median_seconds) },
        { key: '85th percentile', value: num(v.p85_seconds) },
        { key: 'Mean', value: num(v.mean_seconds) },
        { key: 'Fastest', value: num(v.min_seconds) },
        { key: 'Slowest', value: num(v.max_seconds) },
      ]).map((r) => ({ cells: { measure: r.key, seconds: r.value }, link: null })),
  },
  {
    key: 'work.time_in_status',
    label: 'Time in status',
    description: 'How long tasks spent in each status category in the chosen range.',
    unit: 'seconds',
    metric: 'work.time_in_status',
    roles: ['active', 'planned', 'paused', 'done', 'cancelled'],
    windowed: true,
    headline: (v) => num(v.total_seconds),
    breakdown: (v) =>
      (v.categories as Obj[]).map((c) => ({
        key: String(c.category),
        label: STATUS_LABEL[c.category] ?? String(c.category),
        value: Number(c.seconds),
      })),
    columns: [
      { key: 'status', label: 'Status' },
      { key: 'seconds', label: 'Seconds' },
      { key: 'share', label: 'Share (%)' },
      { key: 'tasks', label: 'Tasks' },
    ],
    rows: (v) =>
      (v.categories as Obj[]).map((c) => ({
        cells: {
          status: STATUS_LABEL[c.category] ?? String(c.category),
          seconds: Number(c.seconds),
          share: num(c.share_percent),
          tasks: Number(c.tasks),
        },
        link: null,
      })),
  },
  {
    key: 'work.created_vs_completed',
    label: 'Created versus completed',
    description: 'Tasks created and tasks completed per day in the chosen range.',
    unit: 'count',
    metric: 'work.created_vs_completed',
    roles: ['completed', 'created'],
    windowed: true,
    headline: (v, role) => num(role === 'created' ? v.created : v.completed),
    breakdown: (v) => [
      { key: 'created', label: 'Created', value: Number(v.created) },
      { key: 'completed', label: 'Completed', value: Number(v.completed) },
    ],
    columns: [
      { key: 'day', label: 'Day' },
      { key: 'created', label: 'Created' },
      { key: 'completed', label: 'Completed' },
    ],
    rows: (v) =>
      (v.series as Obj[]).map((d) => ({
        cells: { day: String(d.day), created: Number(d.created), completed: Number(d.completed) },
        link: null,
      })),
  },
  {
    key: 'work.aging',
    label: 'Task aging',
    description: 'Open tasks by how long they have existed, in whole days.',
    unit: 'count',
    metric: 'work.age',
    roles: ['open', 'band_0_7', 'band_8_14', 'band_15_30', 'band_31_60', 'band_61_plus'],
    windowed: false,
    headline: (v) => num(v.open),
    breakdown: (v) =>
      (v.bands as Obj[]).map((b) => ({
        key: String(b.band),
        label: String(b.label),
        value: Number(b.count),
      })),
    columns: [
      { key: 'band', label: 'Age' },
      { key: 'tasks', label: 'Open tasks' },
    ],
    rows: (v) =>
      (v.bands as Obj[]).map((b) => ({
        cells: { band: String(b.label), tasks: Number(b.count) },
        link: null,
      })),
  },
  {
    key: 'work.blocked',
    label: 'Blocked work',
    description: 'Open tasks blocked by an open task you can read.',
    unit: 'count',
    metric: 'work.attention',
    roles: ['blocked'],
    windowed: false,
    headline: (v) => num(v.blocked),
    breakdown: (v) => [{ key: 'open', label: 'Open tasks', value: Number(v.open) }],
    columns: [
      { key: 'measure', label: 'Measure' },
      { key: 'tasks', label: 'Tasks' },
    ],
    rows: (v) => [
      { cells: { measure: 'Blocked', tasks: Number(v.blocked) }, link: null },
      { cells: { measure: 'Open', tasks: Number(v.open) }, link: null },
    ],
  },
  {
    key: 'work.stale',
    label: 'Stale work',
    description: 'Open tasks with no meaningful update for longer than the workspace threshold.',
    unit: 'count',
    metric: 'work.attention',
    roles: ['stale'],
    windowed: false,
    headline: (v) => num(v.stale),
    breakdown: (v) => [{ key: 'open', label: 'Open tasks', value: Number(v.open) }],
    columns: [
      { key: 'measure', label: 'Measure' },
      { key: 'tasks', label: 'Tasks' },
    ],
    rows: (v) => [
      { cells: { measure: 'Stale', tasks: Number(v.stale) }, link: null },
      { cells: { measure: 'Open', tasks: Number(v.open) }, link: null },
    ],
  },
];

/** The scope, filters, and window a figure is asked for (only what the 5C metric can use). */
function query(
  ctx: MetricContext,
  spec: Spec,
): { q: Record<string, unknown>; applied: Applies; notes: string[] } {
  const q: Record<string, unknown> = {};
  const applied = { ...NO_FILTERS };
  const notes: string[] = [];
  const brand =
    ctx.scope.brand?.id ?? (ctx.filters.brands.length === 1 ? ctx.filters.brands[0] : undefined);
  if (brand) {
    q.brand = brand;
    applied.brands = ctx.filters.brands.length === 1;
  } else if (ctx.filters.brands.length > 1)
    notes.push('This figure covers one brand at a time, so the brand filter did not apply.');
  const project =
    ctx.scope.project?.id ??
    (ctx.filters.projects.length === 1 ? ctx.filters.projects[0] : undefined);
  if (project) {
    q.project = project;
    applied.projects = ctx.filters.projects.length === 1;
  } else if (ctx.filters.projects.length > 1)
    notes.push('This figure covers one project at a time, so the project filter did not apply.');
  if (spec.windowed) {
    const r = resolveRange(ctx.filters.range, ctx.today, ctx.weekStart);
    if (r) {
      q.from = r.from;
      q.to = r.to;
      applied.range = true;
    }
  }
  return { q, applied, notes };
}

const reasonOf = (code: string): IncompleteReason =>
  code === 'unestimated_tasks'
    ? 'estimates_missing'
    : code === 'truncated'
      ? 'rows_truncated'
      : 'no_measurement';

function recordRow(r: Obj): MetricRow {
  const cat = r.status?.category as string | undefined;
  return {
    cells: {
      title: r.title ?? null,
      project: r.project?.name ?? null,
      brand: (r.brand && 'name' in r.brand ? (r.brand as Obj).name : null) ?? null,
      status: cat ? (STATUS_LABEL[cat] ?? cat) : null,
      due_date: r.due ?? null,
    } as Record<string, Cell>,
    link: r.record?.type === 'task' ? { type: 'task', id: String(r.record.id) } : null,
  };
}

function parse(spec: Spec) {
  return (raw: unknown, pointer: string, issues: Issues): Record<string, unknown> | null => {
    if (raw === undefined || raw === null) return { role: spec.roles[0] };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      issues.add(pointer, 'invalid_type', 'Describe the options.');
      return null;
    }
    const o = raw as Record<string, unknown>;
    for (const k of Object.keys(o))
      if (k !== 'role')
        issues.add(`${pointer}/${k}`, 'unsupported_field', 'This option is not supported.');
    const role = o.role ?? spec.roles[0];
    if (typeof role !== 'string' || !spec.roles.includes(role)) {
      issues.add(`${pointer}/role`, 'invalid_option', 'Choose a measure from the list.');
      return null;
    }
    return { role };
  };
}

function provider(spec: Spec): MetricProvider {
  return {
    key: spec.key,
    version: 1,
    label: spec.label,
    description: spec.description,
    unit: spec.unit,
    category: 'work',
    source: { kind: 'metrics', label: 'Task records and their status history' },
    // Guests may place and read only record-level work counts (ADR-0031 D8); these need the history.
    guestSafe: false,
    applies: { range: spec.windowed, brands: true, projects: true, people: false, statuses: false },
    parse: parse(spec),
    async compute(ctx, params): Promise<Computed> {
      const { q, applied, notes } = query(ctx, spec);
      const r = await ctx.host.metricFigure(ctx.tx, ctx.p, spec.metric, q);
      const role = typeof params.role === 'string' ? params.role : spec.roles[0]!;
      const v = (r.value ?? {}) as Obj;
      const incomplete = [
        ...new Set(r.incomplete.map((i) => reasonOf(i.code))),
      ] as IncompleteReason[];
      if (r.freshness.state !== 'current' && !incomplete.includes('source_stale'))
        incomplete.push('source_stale');
      return {
        // Nothing to count is a true zero; nothing to measure (a duration with no completions) has no value.
        value: r.state === 'empty' && spec.unit !== 'count' ? null : spec.headline(v, role),
        breakdown: r.state === 'empty' ? [] : spec.breakdown(v),
        columns: spec.columns,
        rows: r.state === 'empty' ? [] : spec.rows(v),
        incomplete,
        estimated: r.state === 'estimated',
        notes: [
          ...notes,
          ...r.incomplete.map((i) => (i.count === null ? i.message : `${i.count}: ${i.message}`)),
          ...r.limits.slice(0, 1),
        ],
        range: r.window
          ? { from: r.window.from, to: r.window.to, label: `${r.window.from} to ${r.window.to}` }
          : null,
        applied,
      };
    },
    async drill(ctx, params, page) {
      const { q } = query(ctx, spec);
      const role = typeof params.role === 'string' ? params.role : spec.roles[0]!;
      const out = await ctx.host.metricRecords(ctx.tx, ctx.p, spec.metric, {
        ...q,
        member: role,
        limit: page.limit,
        ...(page.cursor ? { cursor: page.cursor } : {}),
      });
      return {
        columns: RECORD_COLUMNS,
        rows: (out.items as Obj[]).map(recordRow),
        page: {
          limit: page.limit,
          has_more: out.page.next_cursor !== null,
          ...(out.page.next_cursor ? { next_cursor: out.page.next_cursor } : {}),
        },
      };
    },
  };
}

export const METRICS_5C: readonly MetricProvider[] = SPECS.map(provider);
/** The 5D catalog keys that 5C now answers (they leave the "not yet available" list). */
export const METRICS_5C_KEYS: readonly string[] = SPECS.map((s) => s.key);
