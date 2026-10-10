import { api, downloadPost, protectedRequest, type StepUpResolver } from '../api.ts';

/** Typed client for the 3A query and saved-view engine. Every identifier is a public ID. */

export type Entity = 'task' | 'project';
export type ValueKind = 'ref' | 'multi' | 'enum' | 'date' | 'number' | 'text' | 'bool';

export interface CatalogField {
  field: string;
  label: string;
  kind: ValueKind;
  values?: string[];
  ref?: string;
  custom?: boolean;
  type?: string;
  sortable: boolean;
  groupable: boolean;
  column: boolean;
  filterable: boolean;
}

export interface Catalog {
  entity: Entity;
  fields: CatalogField[];
  default_columns: string[];
  bounds: {
    conditions: number;
    depth: number;
    sorts: number;
    columns: number;
    export_rows: number;
  };
}

export type RelDate = { rel: 'today'; days: number };
export interface Condition {
  field: string;
  op: string;
  value?: unknown;
}
export interface Group {
  op: 'and' | 'or';
  items: Array<Condition | Group>;
}
export interface SortKey {
  field: string;
  dir: 'asc' | 'desc';
}
export interface Query {
  v?: 1;
  entity: Entity;
  filter?: Group;
  sort?: SortKey[];
  group?: { field: string; granularity?: 'day' | 'week' | 'month' } | null;
}
export type Layout =
  | 'list'
  | 'board'
  | 'table'
  | 'calendar'
  | 'timeline'
  | 'gantt'
  | 'workload'
  | 'milestones'
  | 'portfolio'
  | 'activity'
  | 'timesheet';
export const LAYOUTS: Record<Entity, Layout[]> = {
  task: [
    'list',
    'board',
    'table',
    'calendar',
    'timeline',
    'gantt',
    'workload',
    'activity',
    'timesheet',
  ],
  project: [
    'list',
    'board',
    'table',
    'calendar',
    'timeline',
    'gantt',
    'milestones',
    'portfolio',
    'activity',
  ],
};
export const LAYOUT_TEXT: Record<Layout, string> = {
  list: 'List',
  board: 'Board',
  table: 'Table',
  calendar: 'Calendar',
  timeline: 'Timeline',
  gantt: 'Gantt',
  workload: 'Workload',
  milestones: 'Milestones',
  portfolio: 'Portfolio',
  activity: 'Activity',
  timesheet: 'Timesheet',
};
export const DATE_FIELDS: Record<Entity, string[]> = {
  task: ['due_date', 'deadline_date', 'start_date'],
  project: ['target_date', 'deadline_date', 'start_date'],
};

/** Presentation plus layout (the layout travels in the URL with the rest; ADR-0020 B1). */
export interface Presentation {
  columns: string[];
  density: 'comfortable' | 'compact';
  layout?: Layout;
  board_field?: 'status' | 'priority';
  date_field?: string;
  calendar_mode?: 'day' | 'week' | 'month' | 'agenda';
  zoom?: 'day' | 'week' | 'month' | 'quarter';
  bucket?: 'day' | 'week' | 'month';
}

/** What the server's presentation accepts (the layout is a separate saved-view field). */
export function serverPresentation(p: Presentation): Omit<Presentation, 'layout'> {
  const { layout: _layout, ...rest } = p;
  return rest;
}

export interface QueryRow {
  id: string;
  type: Entity;
  title: string;
  status: { key: string; name: string; category: string };
  priority: string;
  brand: { id: string; name: string; short_name: string | null; color: string; icon: string };
  group?: string;
  version: number;
  [k: string]: unknown;
}

export interface QueryPage {
  data: QueryRow[];
  page: {
    limit: number;
    has_more: boolean;
    next_cursor?: string;
    total?: { value: number; capped: boolean };
  };
  view: {
    columns: Array<{ field: string; label: string }>;
    groups?: Array<{ key: string | null; label: string; count: number }>;
    groups_truncated?: boolean;
    refs: Record<string, string>;
  };
}

export interface SavedView {
  id: string;
  type: 'saved_view';
  entity: Entity;
  name: string;
  description: string;
  visibility: 'personal' | 'shared';
  share: {
    scope: 'workspace' | 'brand' | 'project';
    brand?: { id: string; name: string };
    project?: { id: string; name: string };
  } | null;
  owned: boolean;
  can_manage: boolean;
  query: Query;
  presentation: Partial<Presentation>;
  layout: Layout;
  version: number;
}

const w = (ws: string) => `/v1/workspaces/${ws}`;
const plural = (e: Entity) => `${e}s`;

/** The person's local date, so relative dates mean their today. */
const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const views = {
  async catalog(ws: string, entity: Entity) {
    return (await api<{ data: Catalog }>('GET', `${w(ws)}/views/catalog/${entity}`)).body.data;
  },
  async options(ws: string, entity: Entity, field: string, q = '') {
    return (
      await api<{ data: { options: Array<{ value: string; label: string }> } }>(
        'GET',
        `${w(ws)}/views/options/${entity}/${encodeURIComponent(field)}${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      )
    ).body.data.options;
  },
  async query(
    ws: string,
    body: {
      query: Query;
      presentation?: Presentation;
      cursor?: string;
      limit?: number;
      scope?: string[];
      include_total?: boolean;
    },
    signal?: AbortSignal,
  ) {
    return (
      await api<QueryPage>('POST', `${w(ws)}/${plural(body.query.entity)}:query`, {
        body: {
          today: today(),
          ...body,
          ...(body.presentation ? { presentation: serverPresentation(body.presentation) } : {}),
        },
        ...(signal ? { signal } : {}),
      })
    ).body;
  },
  async exportView(
    ws: string,
    body: {
      query: Query;
      presentation?: Presentation;
      format: 'csv' | 'json';
      name?: string;
      scope?: string[];
    },
  ) {
    return downloadPost(`${w(ws)}/${plural(body.query.entity)}:export`, {
      today: today(),
      ...body,
      ...(body.presentation ? { presentation: serverPresentation(body.presentation) } : {}),
    });
  },
  async list(ws: string, entity?: Entity) {
    return (
      await api<{ data: SavedView[] }>('GET', `${w(ws)}/views${entity ? `?entity=${entity}` : ''}`)
    ).body.data;
  },
  async get(ws: string, view: string) {
    return (await api<{ data: SavedView }>('GET', `${w(ws)}/views/${view}`)).body.data;
  },
  async create(
    ws: string,
    body: { name: string; description?: string; query: Query; presentation: Presentation },
    stepUp: StepUpResolver,
  ) {
    const { presentation, ...rest } = body;
    return (
      await protectedRequest<{ data: SavedView }>(
        'POST',
        `${w(ws)}/views`,
        {
          ...rest,
          presentation: serverPresentation(presentation),
          layout: presentation.layout ?? 'list',
        },
        stepUp,
      )
    ).body.data;
  },
  async update(
    ws: string,
    view: string,
    body: Partial<{ name: string; description: string; query: Query; presentation: Presentation }>,
    version: number,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: SavedView }>(
        'PATCH',
        `${w(ws)}/views/${view}`,
        body.presentation
          ? {
              ...body,
              presentation: serverPresentation(body.presentation),
              layout: body.presentation.layout ?? 'list',
            }
          : body,
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async verb(
    ws: string,
    view: string,
    verb: 'share' | 'unshare' | 'pin' | 'unpin',
    body: Record<string, unknown>,
    stepUp: StepUpResolver,
    version?: number,
  ) {
    return (
      await protectedRequest<{ data: SavedView }>(
        'POST',
        `${w(ws)}/views/${view}:${verb}`,
        body,
        stepUp,
        version !== undefined ? { ifMatch: version } : {},
      )
    ).body.data;
  },
  async remove(ws: string, view: string, stepUp: StepUpResolver) {
    await protectedRequest('DELETE', `${w(ws)}/views/${view}`, undefined, stepUp);
  },
  async defaults(ws: string, entity: Entity, ctx: { brand?: string; project?: string } = {}) {
    const q = new URLSearchParams({ entity, ...ctx });
    return (
      await api<{
        data: {
          effective: { id: string; name: string; source: string } | null;
          member: { id: string } | null;
          brand: { id: string } | null;
          project: { id: string } | null;
        };
      }>('GET', `${w(ws)}/views/defaults?${q}`)
    ).body.data;
  },
  async setDefault(
    ws: string,
    body: {
      target: 'me' | 'brand' | 'project';
      entity: Entity;
      view: string | null;
      brand?: string;
      project?: string;
    },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: unknown }>('PUT', `${w(ws)}/views/defaults`, body, stepUp)
    ).body.data;
  },
};

/** URL state: the current query and presentation as base64url JSON (the `q` field, RS-20). */
export function encodeState(query: Query, presentation: Presentation): string {
  const json = JSON.stringify({ q: query, p: presentation });
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeState(raw: string): { query: Query; presentation: Presentation } | null {
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const v = JSON.parse(new TextDecoder().decode(bytes)) as { q?: Query; p?: Presentation };
    if (!v.q || (v.q.entity !== 'task' && v.q.entity !== 'project')) return null;
    return {
      query: v.q,
      presentation: {
        columns: Array.isArray(v.p?.columns)
          ? v.p.columns.filter((c) => typeof c === 'string')
          : [],
        density: v.p?.density === 'compact' ? 'compact' : 'comfortable',
        ...pick(v.p, ['layout', 'board_field', 'date_field', 'calendar_mode', 'zoom', 'bucket']),
      },
    };
  } catch {
    return null;
  }
}

const pick = (o: unknown, keys: string[]) => {
  const out: Record<string, string> = {};
  if (o && typeof o === 'object')
    for (const k of keys) {
      const v = (o as Record<string, unknown>)[k];
      if (typeof v === 'string' && /^[a-z_]{1,20}$/.test(v)) out[k] = v;
    }
  return out as Partial<Presentation>;
};

const ql = (ws: string, path: string) => `${w(ws)}/${path}`;
type LayoutBody = { query: Query; scope?: string[] };

/** Layout reads (3B): facts for records the same query returns (ADR-0020). */
export const layouts = {
  async workload(
    ws: string,
    body: LayoutBody & { bucket: 'day' | 'week' | 'month'; from: string; to: string },
  ) {
    return (
      await api<{
        data: {
          buckets: string[];
          people: Array<{
            id: string | null;
            name: string;
            total_minutes: number;
            cells: Record<string, { minutes: number; tasks: number; unestimated: number }>;
            /** 3E: available time per bucket where the viewer may see this person's capacity. */
            capacity: Record<string, { available: number; over: number; under: number }> | null;
          }>;
          capacity: 'per_person' | null;
        };
      }>('POST', ql(ws, 'tasks:workload'), { body: { today: today(), ...body } })
    ).body.data;
  },
  async dependencies(ws: string, body: LayoutBody & { ids: string[] }) {
    return (
      await api<{ data: { edges: Array<{ from: string; to: string; kind: 'blocks' }> } }>(
        'POST',
        ql(ws, 'tasks:dependencies'),
        { body: { today: today(), ...body } },
      )
    ).body.data.edges;
  },
  async myTime(ws: string, body: LayoutBody & { ids: string[]; from: string; days: number }) {
    return (
      await api<{
        data: {
          days: string[];
          cells: Array<{ task: string; day: string; minutes: number; billable_minutes: number }>;
        };
      }>('POST', ql(ws, 'tasks:my_time'), { body: { today: today(), ...body } })
    ).body.data;
  },
  async milestones(ws: string, body: LayoutBody & { ids: string[] }) {
    return (
      await api<{
        data: {
          milestones: Array<{
            id: string;
            project: string;
            name: string;
            due_date: string | null;
            status: string;
          }>;
        };
      }>('POST', ql(ws, 'projects:milestones'), { body: { today: today(), ...body } })
    ).body.data.milestones;
  },
  async progress(ws: string, body: LayoutBody & { ids: string[] }) {
    return (
      await api<{
        data: {
          progress: Array<{ project: string; done: number; total: number; percent: number | null }>;
        };
      }>('POST', ql(ws, 'projects:progress'), { body: { today: today(), ...body } })
    ).body.data.progress;
  },
  async activity(
    ws: string,
    entity: Entity,
    body: LayoutBody & {
      actor?: string;
      actor_type?: string;
      action?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    return (
      await api<{
        data: {
          items: ActivityItem[];
          page: { has_more: boolean; next_cursor?: string };
          records_truncated: boolean;
        };
      }>('POST', ql(ws, `${entity}s:activity`), { body: { today: today(), ...body } })
    ).body.data;
  },
};

export interface ActivityItem {
  key: string;
  at: string;
  action: string;
  actor: { type: string; id?: string; name?: string };
  record: { id: string; type: Entity; title: string };
  changes: Array<{ field: string; from?: unknown; to?: unknown; changed?: true }>;
}
