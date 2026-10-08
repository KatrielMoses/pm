import { api } from '../api.ts';
import type { BrandMarkerData } from '../shell/client.ts';

/** Typed client for the 5A search API. Every identifier is a public ID. */

export type SearchState = 'active' | 'archived' | 'any';
export type SearchWindow = 'day' | 'week' | 'month' | 'year';

/** A run of text; `hit` marks what matched the query (rendered as `<mark>`, never as markup). */
export interface SnippetPart {
  text: string;
  hit?: true;
}
export interface Snippet {
  parts: SnippetPart[];
  more_before: boolean;
  more_after: boolean;
}

export interface SearchResult {
  type: string;
  id: string;
  title: string;
  title_parts: SnippetPart[];
  snippet: Snippet | null;
  brand: BrandMarkerData;
  /** The record that holds this one (a comment's task, a file's host), only when you can see it. */
  host: { type: string; id: string; title: string | null } | null;
  lifecycle_state: 'active' | 'archived';
  updated_at: string;
  /** Whether the index still holds the latest text of this record. */
  index: 'current' | 'updating' | 'failed';
}

export interface IndexStatus {
  state: 'complete' | 'catching_up' | 'degraded';
  pending: number;
  failed: number;
  oldest_pending_seconds: number | null;
}

export interface SearchQuery {
  q: string;
  kind: string[];
  brand: string[];
  project: string;
  state: SearchState;
  updated: '' | SearchWindow;
  mine: boolean;
  mentioning_me: boolean;
  offset: number;
}

export interface SearchResponse {
  type: 'search_results';
  query: {
    q: string;
    kind: string[];
    brand: string[];
    project: string | null;
    state: SearchState;
    updated: SearchWindow | null;
    mine: boolean;
    mentioning_me: boolean;
  };
  results: SearchResult[];
  total: number;
  total_is_lower_bound: boolean;
  facets: {
    kinds: Array<{ kind: string; label: string; count: number }>;
    brands: Array<{ brand: BrandMarkerData; count: number }>;
  };
  page: { limit: number; offset: number; has_more: boolean };
  limits: { results_max: number; count_max: number };
  index: IndexStatus;
}

export interface SearchStatus {
  type: 'search_status';
  index: IndexStatus;
  sources: Array<{ kind: string; label: string }>;
  limits: {
    query_max_chars: number;
    page_size_max: number;
    results_max: number;
    count_max: number;
  };
}

export interface OpenTarget {
  type: 'search_open';
  result: { type: string; id: string };
  host: { type: string; id: string } | null;
  lifecycle_state: 'active' | 'archived';
}

export interface RecentSearch {
  handle: string;
  q: string;
  filters: Record<string, unknown>;
  count: number;
  searched_at: string;
}

const enc = encodeURIComponent;
const base = (ws: string) => `/v1/workspaces/${enc(ws)}/search`;

/** The request query string for a search (only what differs from the defaults). */
export function searchQueryString(q: SearchQuery, limit?: number): string {
  const p = new URLSearchParams();
  p.set('q', q.q);
  if (q.kind.length) p.set('kind', q.kind.join(','));
  if (q.brand.length) p.set('brand', q.brand.join(','));
  if (q.project) p.set('project', q.project);
  if (q.state !== 'active') p.set('state', q.state);
  if (q.updated) p.set('updated', q.updated);
  if (q.mine) p.set('mine', 'true');
  if (q.mentioning_me) p.set('mentioning_me', 'true');
  if (q.offset) p.set('offset', String(q.offset));
  if (limit) p.set('limit', String(limit));
  return p.toString();
}

export const searchApi = {
  query: async (ws: string, q: SearchQuery, signal?: AbortSignal, limit?: number) =>
    (
      await api<{ data: SearchResponse }>('GET', `${base(ws)}?${searchQueryString(q, limit)}`, {
        ...(signal ? { signal } : {}),
      })
    ).body.data,
  status: async (ws: string) =>
    (await api<{ data: SearchStatus }>('GET', `${base(ws)}/status`)).body.data,
  open: async (ws: string, target: { type: string; id: string }) =>
    (await api<{ data: OpenTarget }>('POST', `${base(ws)}/open`, { body: target })).body.data,
  recent: async (ws: string) =>
    (await api<{ data: { data: RecentSearch[] } }>('GET', `${base(ws)}/recent`)).body.data.data,
  remember: async (ws: string, q: SearchQuery) =>
    api('POST', `${base(ws)}/recent`, {
      body: {
        q: q.q,
        filters: {
          ...(q.kind.length ? { kind: q.kind } : {}),
          ...(q.brand.length ? { brand: q.brand } : {}),
          ...(q.project ? { project: q.project } : {}),
          ...(q.state !== 'active' ? { state: q.state } : {}),
          ...(q.updated ? { updated: q.updated } : {}),
          ...(q.mine ? { mine: true } : {}),
          ...(q.mentioning_me ? { mentioning_me: true } : {}),
        },
      },
    }),
  forget: async (ws: string, handle?: string) =>
    api('DELETE', handle ? `${base(ws)}/recent/${enc(handle)}` : `${base(ws)}/recent`),
};
