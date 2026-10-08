import { routeHref } from '../shell/registry.ts';
import type { SearchQuery, SearchResult, SearchState, SearchWindow } from './client.ts';

/**
 * The search page keeps its whole state in the URL (a deep link is a search): every value is
 * validated here, anything unknown or malformed is dropped, and the same function writes the
 * address back, so a shared link, a reload, and Back all agree.
 */

export const SEARCH_STATES: readonly SearchState[] = ['active', 'archived', 'any'];
export const SEARCH_WINDOWS: readonly SearchWindow[] = ['day', 'week', 'month', 'year'];
export const EMPTY_QUERY: SearchQuery = {
  q: '',
  kind: [],
  brand: [],
  project: '',
  state: 'active',
  updated: '',
  mine: false,
  mentioning_me: false,
  all_brands: false,
  cursor: '',
};

const KIND = /^[a-z][a-z_]{1,30}$/;
const BRAND = /^br_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,2048}$/;

const list = (p: URLSearchParams, name: string) =>
  p
    .getAll(name)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);

export function parseSearchParams(p: URLSearchParams, maxChars = 200): SearchQuery {
  const state = p.get('state') as SearchState | null;
  const updated = p.get('updated') as SearchWindow | null;
  return {
    q: (p.get('q') ?? '').slice(0, maxChars),
    kind: [...new Set(list(p, 'kind').filter((k) => KIND.test(k)))].slice(0, 12),
    brand: [...new Set(list(p, 'brand').filter((b) => BRAND.test(b)))].slice(0, 20),
    project: PROJECT.test(p.get('project') ?? '') ? p.get('project')! : '',
    state: state && SEARCH_STATES.includes(state) ? state : 'active',
    updated: updated && SEARCH_WINDOWS.includes(updated) ? updated : '',
    mine: p.get('mine') === 'true',
    mentioning_me: p.get('mentioning_me') === 'true',
    all_brands: p.get('all_brands') === 'true',
    cursor: CURSOR.test(p.get('cursor') ?? '') ? p.get('cursor')! : '',
  };
}

/** The address query for a search; empty values are left out so links stay short. */
export function toSearchParams(q: SearchQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.kind.length) p.set('kind', q.kind.join(','));
  if (q.brand.length) p.set('brand', q.brand.join(','));
  if (q.project) p.set('project', q.project);
  if (q.state !== 'active') p.set('state', q.state);
  if (q.updated) p.set('updated', q.updated);
  if (q.mine) p.set('mine', 'true');
  if (q.mentioning_me) p.set('mentioning_me', 'true');
  if (q.all_brands) p.set('all_brands', 'true');
  if (q.cursor) p.set('cursor', q.cursor);
  return p;
}

export function searchHref(ws: string, q: Partial<SearchQuery>): string {
  const qs = toSearchParams({ ...EMPTY_QUERY, ...q }).toString();
  return `${routeHref('search', { ws })}${qs ? `?${qs}` : ''}`;
}

/** How many filters are narrowing the search (the count shown on the Compact filter toggle). */
export function activeFilters(q: SearchQuery): number {
  return (
    q.kind.length +
    q.brand.length +
    (q.project ? 1 : 0) +
    (q.state !== 'active' ? 1 : 0) +
    (q.updated ? 1 : 0) +
    (q.mine ? 1 : 0) +
    (q.mentioning_me ? 1 : 0)
  );
}

/** Same search continuing from a cursor the server issued (paging); the filters are untouched. */
export const atCursor = (q: SearchQuery, cursor: string): SearchQuery => ({ ...q, cursor });

/** Changing what is asked starts again from the first result. */
export const withFilters = (q: SearchQuery, patch: Partial<SearchQuery>): SearchQuery => ({
  ...q,
  ...patch,
  cursor: '',
});

type Ref = { type: string; id: string };

/**
 * The page that opens a result in context. A comment, file, deliverable, milestone, or decision
 * opens the record that holds it (shown only when the viewer can see it); a result whose holder
 * is not visible has no page, and the list says so instead of linking somewhere else.
 */
export function openRef(r: Pick<SearchResult, 'type' | 'id' | 'host'>): Ref | null {
  if (r.type === 'task' || r.type === 'project' || r.type === 'document')
    return { type: r.type, id: r.id };
  return r.host ? { type: r.host.type, id: r.host.id } : null;
}

export function refHref(ws: string, ref: Ref | null): string | null {
  if (!ref) return null;
  switch (ref.type) {
    case 'task':
      return routeHref('task', { ws, tsk: ref.id });
    case 'project':
      return routeHref('project', { ws, prj: ref.id });
    case 'document':
      return routeHref('document', { ws, doc: ref.id });
    case 'brand':
      return routeHref('brand', { ws, brand: ref.id });
    default:
      return null;
  }
}

export const resultHref = (ws: string, r: Pick<SearchResult, 'type' | 'id' | 'host'>) =>
  refHref(ws, openRef(r));

export const KIND_LABEL: Record<string, string> = {
  task: 'Task',
  project: 'Project',
  milestone: 'Milestone',
  decision_record: 'Decision',
  document: 'Document',
  comment: 'Comment',
  file: 'File',
  deliverable: 'Deliverable',
};
export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? 'Item';

/** A remembered search as a query (filters are stored in the request's own field names). */
export function recentQuery(q: string, filters: Record<string, unknown>): SearchQuery {
  const p = new URLSearchParams({ q });
  for (const [k, v] of Object.entries(filters))
    if (v !== null && v !== undefined) p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  return parseSearchParams(p);
}
