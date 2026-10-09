import { api } from '../api.ts';
import type { BrandMarkerData } from '../shell/client.ts';

/** Typed client for the 5C metrics API. Every identifier is a public ID; the server decides what is shown. */

export type MetricState = 'complete' | 'partial' | 'estimated' | 'empty' | 'unavailable';
export type FreshnessState = 'current' | 'catching_up' | 'degraded';

export interface MetricDefinitionInfo {
  id: string;
  version: number;
  current: boolean;
  name: string;
  summary: string;
  unit: string;
  scopes: Array<'workspace' | 'brand' | 'project'>;
  window: 'window' | 'none';
  historical: boolean;
  numerator: string;
  denominator: string | null;
  sources: string[];
  timezone: 'workspace' | 'none';
  freshness: string;
  rollup: { kind: string; note: string };
  incomplete: Array<{ code: string; meaning: string }>;
  authorization: string;
  drill: Array<{ role: string; label: string; records: 'task' | 'project' | 'deliverable' }>;
  does_not_claim: string;
  availability:
    { state: 'available' } | { state: 'source_unavailable'; phase: string; reason: string };
  changelog: string;
  digest: string;
}

export interface MetricCatalog {
  type: 'metric_catalog';
  data: MetricDefinitionInfo[];
  limits: {
    window_days_max: number;
    default_window_days: number;
    drill_page_max: number;
    sample_min: number;
  };
}

export interface MetricResult {
  type: 'metric_result';
  definition: { id: string; version: number; name: string; unit: string; digest: string };
  scope: {
    kind: 'workspace' | 'brand' | 'project';
    brand: BrandMarkerData | null;
    project: { id: string; name: string } | null;
    subprojects: boolean | null;
  };
  window: { from: string; to: string; days: number } | null;
  as_of: string;
  timezone: string | null;
  state: MetricState;
  value: Record<string, unknown> | null;
  parts: { numerator: number | null; denominator: number | null } | null;
  incomplete: Array<{ code: string; message: string; count: number | null }>;
  groups: unknown[];
  freshness: {
    state: FreshnessState;
    data_as_of: string;
    basis: 'live' | 'ledger';
    ledger?: {
      reconciliation: string;
      last_success_at: string | null;
      tasks_with_assumed_history: number;
      tasks_with_repaired_history: number;
    };
  };
  provenance: { sources: string[]; authorization: 'viewer'; evidence: string };
  limits: string[];
  unavailable: { phase: string; reason: string } | null;
  drill: { members: Array<{ role: string; label: string; count: number }> };
  reproducibility: {
    definition_digest: string;
    as_of: string;
    historical: boolean;
    result_digest: string;
  };
}

export interface MetricRecord {
  record: { type: 'task' | 'project' | 'deliverable'; id: string };
  title: string;
  brand: BrandMarkerData | null;
  project: { id: string; name: string } | null;
  status: { category?: string; state?: string };
  due: string | null;
  host?: { type: 'task'; id: string; title: string };
}

export interface MetricRecords {
  type: 'metric_records';
  member: { role: string; label: string; records: 'task' | 'project' | 'deliverable' };
  total: number;
  items: MetricRecord[];
  page: { limit: number; next_cursor: string | null; truncated: boolean };
}

/** What the page asks of the server: the metric and the scope, window, and version it is read at. */
export interface MetricQuery {
  metric: string;
  version: string;
  brand: string;
  project: string;
  from: string;
  to: string;
  member: string;
}

export const EMPTY_METRIC_QUERY: MetricQuery = {
  metric: '',
  version: '',
  brand: '',
  project: '',
  from: '',
  to: '',
  member: '',
};

const enc = encodeURIComponent;
const base = (ws: string) => `/v1/workspaces/${enc(ws)}/metrics`;

/** The request query string (only what is set); the same one drives the figure, its records, and its export. */
export function metricQueryString(q: MetricQuery, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (q.version) p.set('version', q.version);
  if (q.brand) p.set('brand', q.brand);
  if (q.project) p.set('project', q.project);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p.toString();
}

export const metricsApi = {
  catalog: async (ws: string) => (await api<{ data: MetricCatalog }>('GET', base(ws))).body.data,
  get: async (ws: string, q: MetricQuery, signal?: AbortSignal) =>
    (
      await api<{ data: MetricResult }>(
        'GET',
        `${base(ws)}/${enc(q.metric)}?${metricQueryString(q)}`,
        signal ? { signal } : {},
      )
    ).body.data,
  records: async (ws: string, q: MetricQuery, cursor: string, signal?: AbortSignal) =>
    (
      await api<{ data: MetricRecords }>(
        'GET',
        `${base(ws)}/${enc(q.metric)}/records?${metricQueryString(q, { member: q.member, cursor, limit: '20' })}`,
        signal ? { signal } : {},
      )
    ).body.data,
  exportHref: (ws: string, q: MetricQuery) =>
    `${base(ws)}/${enc(q.metric)}/export?${metricQueryString(q)}`,
  reconcile: async (ws: string) => api('POST', `${base(ws)}:reconcile`, { body: {} }),
};
