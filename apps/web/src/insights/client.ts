import { api, ApiError, protectedRequest, type StepUpResolver } from '../api.ts';
import type { BrandMarkerData } from '../shell/client.ts';

/**
 * Typed client for the 5D dashboards and reports API (ADR-0030). Every identifier is a public ID.
 * Every figure is computed by the server for the viewer; nothing here recalculates, infers, or
 * hints at records the viewer cannot read.
 */

export type DashboardKind = 'owner' | 'brand' | 'project' | 'release' | 'personal';
export type WidgetSize = 'small' | 'medium' | 'large';
export type Lifecycle = 'active' | 'archived' | 'trashed' | 'purged';

export const KIND_LABEL: Record<DashboardKind, string> = {
  owner: 'Owner (all brands)',
  brand: 'Brand',
  project: 'Project',
  release: 'Release',
  personal: 'Personal',
};

export type RangePreset =
  'last_7_days' | 'last_30_days' | 'last_90_days' | 'this_week' | 'this_month' | 'last_month';
export const RANGE_LABEL: Record<RangePreset, string> = {
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  last_90_days: 'Last 90 days',
  this_week: 'This week',
  this_month: 'This month',
  last_month: 'Last month',
};
export const STATUS_CATEGORY_LABEL: Record<string, string> = {
  planned: 'Planned',
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Cancelled',
};

export type RangeInput = { preset: RangePreset } | { from: string; to: string };

export interface Filters {
  range: RangeInput | null;
  brands: string[];
  projects: string[];
  people: string[];
  statuses: string[];
}
export const NO_FILTERS: Filters = {
  range: null,
  brands: [],
  projects: [],
  people: [],
  statuses: [],
};

export interface WidgetMeta {
  id: string;
  metric: string;
  title: string;
  size: WidgetSize;
  params: Record<string, unknown>;
  available: boolean;
}
export interface WidgetInput {
  id: string;
  metric: string;
  title?: string | null;
  size?: WidgetSize;
  params?: Record<string, unknown>;
}

export type InsightScope =
  | { kind: 'workspace' }
  | { kind: 'personal' }
  | { kind: 'shared' }
  | { kind: 'brand'; brand: BrandMarkerData }
  | { kind: 'project'; brand: BrandMarkerData; project: { id: string; name: string } | null };

export interface PersonRef {
  id: string;
  name: string;
  type: 'member';
}

export interface Dashboard {
  id: string;
  type: 'dashboard';
  title: string;
  description: string | null;
  kind: DashboardKind;
  scope: InsightScope;
  owner: PersonRef | null;
  widgets: WidgetMeta[];
  filters: Filters;
  lifecycle_state: Lifecycle;
  capabilities: {
    update: boolean;
    archive: boolean;
    restore: boolean;
    trash: boolean;
    export: boolean;
  };
  created_at: string | null;
  updated_at: string | null;
  version: number;
}

export interface Schedule {
  frequency: 'daily' | 'weekly' | 'monthly';
  weekday: number | null;
  monthday: number | null;
  minute: number;
  timezone: string;
  description: string;
  next_run_at: string | null;
  last_run_at: string | null;
  suspended: { reason: 'owner_authority' | 'owner_departed' | 'admin'; at: string | null } | null;
}

export interface Report {
  id: string;
  type: 'report_definition';
  title: string;
  description: string | null;
  scope: InsightScope;
  owner: PersonRef | null;
  widgets: WidgetMeta[];
  filters: Filters;
  access: 'placement' | 'share';
  schedule: Schedule | null;
  subscribed: boolean;
  recipients_count: number | null;
  shares_count: number | null;
  lifecycle_state: Lifecycle;
  capabilities: {
    update: boolean;
    schedule: boolean;
    share: boolean;
    archive: boolean;
    restore: boolean;
    trash: boolean;
    export: boolean;
  };
  created_at: string | null;
  updated_at: string | null;
  version: number;
}

export type IncompleteReason =
  | 'count_capped'
  | 'groups_truncated'
  | 'rows_truncated'
  | 'estimates_missing'
  | 'no_measurement'
  | 'source_stale';

export interface Column {
  key: string;
  label: string;
}
export interface RecordLink {
  type: 'task' | 'project' | 'goal' | 'milestone' | 'deliverable' | 'brand' | 'member';
  id: string;
}
export interface Row {
  cells: Record<string, string | number | null>;
  link: RecordLink | null;
}

export interface Freshness {
  as_of: string;
  basis: 'live' | 'derived';
  source_as_of: string | null;
  stale: boolean;
}

export interface MetricValue {
  state: 'ok';
  metric: string;
  version: number;
  label: string;
  unit: 'count' | 'minutes' | 'seconds' | 'percent' | 'none';
  value: number | null;
  breakdown: Array<{ key: string | null; label: string; value: number }>;
  columns: Column[];
  rows: Row[];
  incomplete: IncompleteReason[];
  estimated: boolean;
  notes: string[];
  covers: string;
  range: { from: string; to: string; label: string } | null;
  applied: {
    range: boolean;
    brands: boolean;
    projects: boolean;
    people: boolean;
    statuses: boolean;
  };
  source: { kind: string; label: string };
  freshness: Freshness;
  drill: boolean;
}
export type WidgetOutcome =
  | MetricValue
  | { state: 'unavailable'; metric: string; reason: string; message: string }
  | { state: 'error'; metric: string; message: string };

export interface WidgetResult {
  type: 'widget_result';
  widget: WidgetMeta;
  filters: Filters;
  outcome: WidgetOutcome;
}
export interface WidgetRecords {
  type: 'widget_records';
  widget: WidgetMeta;
  columns: Column[];
  rows: Row[];
  page: { limit: number; has_more: boolean; next_cursor?: string };
  covers: string;
  as_of: string;
}

export interface CatalogMetric {
  key: string;
  version: number;
  label: string;
  description: string;
  category: string;
  unit: string;
  source: { kind: string; label: string };
  applies: {
    range: boolean;
    brands: boolean;
    projects: boolean;
    people: boolean;
    statuses: boolean;
  };
}
export interface Catalog {
  type: 'insight_metrics';
  metrics: CatalogMetric[];
  not_available: Array<{
    key: string;
    label: string;
    requirement: string;
    owner_phase: string;
    reason: string;
  }>;
}

export interface PageOf<T> {
  data: T[];
  page: { limit: number; has_more: boolean; next_cursor?: string };
}

export interface Share {
  id: string;
  type: 'report_share';
  grantee: { id: string; name: string } | null;
  expires_at: string | null;
  created_at: string | null;
}
export interface Run {
  id: string;
  occurrence_at: string | null;
  recipient: string | null;
  state: 'pending' | 'delivered' | 'empty' | 'skipped' | 'failed';
  detail: string | null;
  rows: number | null;
  incomplete: boolean;
  failure_class: string | null;
  finished_at: string | null;
}

export interface ScheduleInput {
  frequency: 'daily' | 'weekly' | 'monthly';
  weekday?: number | null;
  monthday?: number | null;
  time: string;
  timezone: string;
}

export interface DashboardCreate {
  title: string;
  description?: string;
  kind: DashboardKind;
  brand?: string;
  project?: string;
  layout?: { widgets: WidgetInput[] };
  filters?: Filters;
}
export interface ReportCreate {
  title: string;
  description?: string;
  brand?: string;
  project?: string;
  layout?: { widgets: WidgetInput[] };
  filters?: Filters;
}
export interface InsightPatch {
  title?: string;
  description?: string | null;
  layout?: { widgets: WidgetInput[] };
  filters?: Filters;
}

// ---- Requests ---------------------------------------------------------------------------------

const w = (ws: string) => `/v1/workspaces/${ws}`;
const qs = (o: Record<string, string | number | undefined>) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== '');
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};
export const filtersParam = (f: Filters | null | undefined) =>
  f ? { filters: JSON.stringify(f) } : {};

export interface WriteOptions {
  version?: number;
  key?: string;
}
const write = (o?: WriteOptions) => ({
  ...(o?.version !== undefined ? { ifMatch: o.version } : {}),
  ...(o?.key ? { idempotencyKey: o.key } : {}),
});

/** A GET whose success response is a file (CSV or PDF). Errors use the JSON error envelope. */
async function downloadGet(
  path: string,
): Promise<{ blob: Blob; filename: string; contentType: string }> {
  if (!navigator.onLine)
    throw new ApiError({ code: 'offline', status: 0, message: "You're offline." });
  let res: Response;
  try {
    res = await fetch(path, { method: 'GET', credentials: 'same-origin' });
  } catch {
    throw new ApiError({ code: 'network', status: 0, message: 'Network error.' });
  }
  if (!res.ok) {
    let e: Record<string, unknown> = {};
    try {
      e = ((await res.json()) as { error?: Record<string, unknown> }).error ?? {};
    } catch {
      // The body was not JSON.
    }
    throw new ApiError({
      code: typeof e.code === 'string' ? e.code : 'internal_error',
      status: res.status,
      message: typeof e.message === 'string' ? e.message : 'Something went wrong.',
      issues: Array.isArray(e.issues)
        ? (e.issues as Array<{ pointer?: string; code: string; message: string }>)
        : [],
    });
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  return {
    blob: await res.blob(),
    filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'export',
    contentType: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!,
  };
}

/** Saves a downloaded export through the browser. */
export function saveBlob(file: { blob: Blob; filename: string }): void {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Verb = 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge';

function insightApi<T extends { id: string; version: number }>(
  collection: 'dashboards' | 'reports',
  type: string,
) {
  return {
    async list(
      ws: string,
      q: { kind?: string; brand?: string; project?: string; limit?: number; cursor?: string } = {},
    ) {
      return (await api<PageOf<T>>('GET', `${w(ws)}/${collection}${qs({ ...q })}`)).body;
    },
    async get(ws: string, id: string) {
      return (await api<{ data: T }>('GET', `${w(ws)}/${collection}/${id}`)).body.data;
    },
    async verb(ws: string, id: string, verb: Verb, version: number, stepUp: StepUpResolver) {
      return (
        await protectedRequest<{ data: { id: string; type: string; lifecycle_state: Lifecycle } }>(
          'POST',
          `${w(ws)}/${collection}/${id}:${verb}`,
          {},
          stepUp,
          write({ version }),
        )
      ).body.data;
    },
    async widget(
      ws: string,
      id: string,
      widget: string,
      filters?: Filters | null,
      signal?: AbortSignal,
    ) {
      return (
        await api<{ data: WidgetResult }>(
          'GET',
          `${w(ws)}/${collection}/${id}/widgets/${widget}${qs(filtersParam(filters))}`,
          signal ? { signal } : {},
        )
      ).body.data;
    },
    async records(
      ws: string,
      id: string,
      widget: string,
      o: { filters?: Filters | null; cursor?: string; limit?: number } = {},
    ) {
      return (
        await api<{ data: WidgetRecords }>(
          'GET',
          `${w(ws)}/${collection}/${id}/widgets/${widget}/records${qs({
            ...filtersParam(o.filters),
            cursor: o.cursor,
            limit: o.limit,
          })}`,
        )
      ).body.data;
    },
    async export(
      ws: string,
      id: string,
      o: { format: 'csv' | 'pdf'; widget?: string; filters?: Filters | null },
    ) {
      return downloadGet(
        `${w(ws)}/${collection}/${id}/export${qs({
          format: o.format,
          widget: o.widget,
          ...filtersParam(o.filters),
        })}`,
      );
    },
    type,
  };
}

export const dashboards = {
  ...insightApi<Dashboard>('dashboards', 'dashboard'),
  async create(ws: string, body: DashboardCreate, stepUp: StepUpResolver, o?: WriteOptions) {
    return (
      await protectedRequest<{ data: Dashboard }>(
        'POST',
        `${w(ws)}/dashboards`,
        body,
        stepUp,
        write(o),
      )
    ).body.data;
  },
  async update(
    ws: string,
    id: string,
    version: number,
    body: InsightPatch,
    stepUp: StepUpResolver,
    o?: WriteOptions,
  ) {
    return (
      await protectedRequest<{ data: Dashboard }>(
        'PATCH',
        `${w(ws)}/dashboards/${id}`,
        body,
        stepUp,
        write({ ...o, version }),
      )
    ).body.data;
  },
};

export const reports = {
  ...insightApi<Report>('reports', 'report_definition'),
  async create(ws: string, body: ReportCreate, stepUp: StepUpResolver, o?: WriteOptions) {
    return (
      await protectedRequest<{ data: Report }>('POST', `${w(ws)}/reports`, body, stepUp, write(o))
    ).body.data;
  },
  async update(
    ws: string,
    id: string,
    version: number,
    body: InsightPatch,
    stepUp: StepUpResolver,
    o?: WriteOptions,
  ) {
    return (
      await protectedRequest<{ data: Report }>(
        'PATCH',
        `${w(ws)}/reports/${id}`,
        body,
        stepUp,
        write({ ...o, version }),
      )
    ).body.data;
  },
  async setSchedule(
    ws: string,
    id: string,
    version: number,
    schedule: ScheduleInput | null,
    stepUp: StepUpResolver,
    o?: WriteOptions,
  ) {
    return (
      await protectedRequest<{ data: Report }>(
        'PUT',
        `${w(ws)}/reports/${id}/schedule`,
        { schedule },
        stepUp,
        write({ ...o, version }),
      )
    ).body.data;
  },
  async resume(ws: string, id: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Report }>('POST', `${w(ws)}/reports/${id}:resume`, {}, stepUp)
    ).body.data;
  },
  async leave(ws: string, id: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Report }>('POST', `${w(ws)}/reports/${id}:leave`, {}, stepUp)
    ).body.data;
  },
  async recipients(ws: string, id: string) {
    return (
      await api<{ data: { type: 'report_recipients'; data: PersonRef[] } }>(
        'GET',
        `${w(ws)}/reports/${id}/recipients`,
      )
    ).body.data.data;
  },
  async setRecipients(
    ws: string,
    id: string,
    version: number,
    members: string[],
    stepUp: StepUpResolver,
    o?: WriteOptions,
  ) {
    return (
      await protectedRequest<{ data: Report }>(
        'PUT',
        `${w(ws)}/reports/${id}/recipients`,
        { members },
        stepUp,
        write({ ...o, version }),
      )
    ).body.data;
  },
  async runs(ws: string, id: string) {
    return (
      await api<{ data: { type: 'report_runs'; data: Run[] } }>(
        'GET',
        `${w(ws)}/reports/${id}/runs`,
      )
    ).body.data.data;
  },
  async shares(ws: string, id: string) {
    return (
      await api<{ data: { type: 'report_shares'; data: Share[] } }>(
        'GET',
        `${w(ws)}/reports/${id}/shares`,
      )
    ).body.data.data;
  },
  async share(
    ws: string,
    id: string,
    body: { grantee: string; expires_at?: string },
    stepUp: StepUpResolver,
    o?: WriteOptions,
  ) {
    return (
      await protectedRequest<{ data: { id: string } }>(
        'POST',
        `${w(ws)}/reports/${id}/shares`,
        body,
        stepUp,
        write(o),
      )
    ).body.data;
  },
  async unshare(ws: string, id: string, share: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: { id: string } }>(
        'DELETE',
        `${w(ws)}/reports/${id}/shares/${share}`,
        undefined,
        stepUp,
      )
    ).body.data;
  },
};

export const insights = {
  async catalog(ws: string) {
    return (await api<{ data: Catalog }>('GET', `${w(ws)}/insights/metrics`)).body.data;
  },
  async trash(ws: string) {
    return (
      await api<{ data: { type: string; data: Array<Dashboard | Report> } }>(
        'GET',
        `${w(ws)}/insights/trash`,
      )
    ).body.data.data;
  },
};
