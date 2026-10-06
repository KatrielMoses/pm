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
export interface Presentation {
  columns: string[];
  density: 'comfortable' | 'compact';
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
        body: { today: today(), ...body },
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
    return (await protectedRequest<{ data: SavedView }>('POST', `${w(ws)}/views`, body, stepUp))
      .body.data;
  },
  async update(
    ws: string,
    view: string,
    body: Partial<{ name: string; description: string; query: Query; presentation: Presentation }>,
    version: number,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: SavedView }>('PATCH', `${w(ws)}/views/${view}`, body, stepUp, {
        ifMatch: version,
      })
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
      },
    };
  } catch {
    return null;
  }
}
