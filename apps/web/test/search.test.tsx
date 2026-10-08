import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { SearchHealthNotice, SearchPage } from '../src/pages/search-pages.tsx';
import { Router } from '../src/router.tsx';
import {
  searchApi,
  searchQueryString,
  type RecentSearch,
  type SearchResponse,
  type SearchResult,
} from '../src/search/client.ts';
import {
  activeFilters,
  EMPTY_QUERY,
  openRef,
  parseSearchParams,
  recentQuery,
  resultHref,
  searchHref,
  toSearchParams,
  withFilters,
} from '../src/search/params.ts';
import { matchRoute } from '../src/shell/registry.ts';

// The page reads the shell's brand scope; tests set it per case.
let shellScope: { kind: string; [k: string]: unknown } = {
  kind: 'all',
  brand_ids: ['br_00000000000000000000000001'],
};
vi.mock('../src/shell/workspace.tsx', () => ({
  useWorkspaceShell: () => ({
    ws: 'wsp_A',
    context: {
      workspace: { id: 'wsp_A', name: 'Co', capabilities: {} },
      scope: shellScope,
      brands: [
        {
          id: 'br_00000000000000000000000001',
          name: 'Harbor',
          short_name: null,
          color: '#336699',
          icon: 'circle',
          is_sensitive: false,
        },
        {
          id: 'br_00000000000000000000000002',
          name: 'Summit',
          short_name: null,
          color: '#996633',
          icon: 'circle',
          is_sensitive: false,
        },
      ],
    },
    recent: [],
  }),
}));

const WS = 'wsp_A';
const TASK = 'tsk_00000000000000000000000001';
const BR = 'br_00000000000000000000000001';
const PRJ = 'prj_00000000000000000000000001';

/** jsdom has no matchMedia: emulate a viewport width (min-width queries only). */
function viewport(width: number) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: min ? width >= Number(min[1]) : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

const brand = {
  kind: 'brand' as const,
  id: BR,
  name: 'Harbor',
  short_name: null,
  color: '#336699',
  icon: 'circle',
  archived: false,
};
const result = (extra: Partial<SearchResult> = {}): SearchResult => ({
  type: 'task',
  id: TASK,
  title: 'Quarterly invoice review',
  title_parts: [{ text: 'Quarterly ' }, { text: 'invoice', hit: true }, { text: ' review' }],
  snippet: {
    parts: [{ text: 'Match every ' }, { text: 'invoice', hit: true }, { text: ' to the ledger' }],
    more_before: true,
    more_after: true,
  },
  brand,
  host: null,
  project: null,
  owner: null,
  lifecycle_state: 'active',
  updated_at: '2026-10-05T10:00:00.000Z',
  index: 'current',
  ...extra,
});
const response = (extra: Partial<SearchResponse> = {}): SearchResponse => ({
  type: 'search_results',
  query: {
    q: 'invoice',
    kind: [],
    brand: [],
    project: null,
    state: 'active',
    updated: null,
    mine: false,
    mentioning_me: false,
  },
  results: [result()],
  total: 1,
  total_is_lower_bound: false,
  facets: {
    capped: false,
    kinds: [
      { kind: 'task', label: 'Tasks', count: 1 },
      { kind: 'comment', label: 'Comments', count: 2 },
    ],
    brands: [{ brand, count: 3 }],
  },
  page: { limit: 20, position: 1, has_more: false, next_cursor: null },
  limits: { results_max: 200, count_max: 1000 },
  index: { state: 'complete', pending: 0, failed: 0, oldest_pending_seconds: null },
  ...extra,
});

function at(search: string) {
  window.history.replaceState({}, '', `/workspaces/${WS}/search${search}`);
}
const renderPage = () =>
  render(
    <Router>
      <SearchPage ws={WS} />
    </Router>,
  );

beforeEach(() => {
  shellScope = { kind: 'all', brand_ids: [BR, 'br_00000000000000000000000002'] };
  viewport(1280);
  vi.spyOn(searchApi, 'recent').mockResolvedValue([]);
  vi.spyOn(searchApi, 'remember').mockResolvedValue({ status: 202, body: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('search URL state (5A)', () => {
  it('reads only valid values from the address and writes the shortest address back', () => {
    const q = parseSearchParams(
      new URLSearchParams(
        `q=invoice&kind=task,comment,BAD!&brand=${BR},br_nope&project=${PRJ}&state=archived&updated=week&mine=true&mentioning_me=true&cursor=abc_DEF-123`,
      ),
    );
    expect(q).toEqual({
      q: 'invoice',
      kind: ['task', 'comment'],
      brand: [BR],
      project: PRJ,
      state: 'archived',
      updated: 'week',
      mine: true,
      mentioning_me: true,
      all_brands: false,
      cursor: 'abc_DEF-123',
    });
    expect(toSearchParams(q).toString()).toBe(
      `q=invoice&kind=task%2Ccomment&brand=${BR}&project=${PRJ}&state=archived&updated=week&mine=true&mentioning_me=true&cursor=abc_DEF-123`,
    );
    expect(toSearchParams({ ...EMPTY_QUERY, q: 'a' }).toString()).toBe('q=a');
    // Anything unknown or malformed is dropped, never passed on.
    expect(
      parseSearchParams(new URLSearchParams('state=x&updated=decade&cursor=bad!&mine=1&kind=')),
    ).toEqual(EMPTY_QUERY);
    expect(parseSearchParams(new URLSearchParams(`q=${'x'.repeat(300)}`)).q).toHaveLength(200);
    expect(parseSearchParams(new URLSearchParams(`cursor=${'a'.repeat(2049)}`)).cursor).toBe('');
  });

  it('round-trips a search through its address, a remembered search, and the request', () => {
    const q = {
      ...EMPTY_QUERY,
      q: 'budget plan',
      kind: ['document'],
      state: 'any' as const,
      cursor: 'c1_x',
    };
    const href = searchHref(WS, q);
    expect(href.startsWith(`/workspaces/${WS}/search?`)).toBe(true);
    expect(parseSearchParams(new URL(href, 'http://x').searchParams)).toEqual(q);
    expect(recentQuery('budget plan', { kind: ['document'], state: 'any' })).toEqual({
      ...q,
      cursor: '',
    });
    expect(searchQueryString(q, 6)).toBe(
      'q=budget+plan&kind=document&state=any&cursor=c1_x&limit=6',
    );
    expect(searchHref(WS, {})).toBe(`/workspaces/${WS}/search`);
    expect(withFilters({ ...q, cursor: 'zz' }, { mine: true }).cursor).toBe('');
    expect(
      activeFilters(parseSearchParams(new URLSearchParams(`kind=aa,bb&brand=${BR}&mine=true`))),
    ).toBe(4);
  });

  it('opens a result in context: records open themselves, held items open what holds them', () => {
    expect(resultHref(WS, { type: 'task', id: TASK, host: null })).toBe(
      `/workspaces/${WS}/tasks/${TASK}`,
    );
    expect(resultHref(WS, { type: 'project', id: PRJ, host: null })).toBe(
      `/workspaces/${WS}/projects/${PRJ}`,
    );
    expect(resultHref(WS, { type: 'document', id: 'doc_1', host: null })).toBe(
      `/workspaces/${WS}/documents/doc_1`,
    );
    expect(
      resultHref(WS, {
        type: 'comment',
        id: 'cmt_1',
        host: { type: 'task', id: TASK, title: null },
      }),
    ).toBe(`/workspaces/${WS}/tasks/${TASK}`);
    expect(
      resultHref(WS, {
        type: 'milestone',
        id: 'ms_1',
        host: { type: 'project', id: PRJ, title: 'P' },
      }),
    ).toBe(`/workspaces/${WS}/projects/${PRJ}`);
    // A held item whose holder is not visible has no page.
    expect(resultHref(WS, { type: 'comment', id: 'cmt_1', host: null })).toBeNull();
    expect(openRef({ type: 'file', id: 'file_1', host: null })).toBeNull();
    // The route is registered, scope-free, and open to every shell kind that reaches a workspace.
    const hit = matchRoute(`/workspaces/${WS}/search`);
    expect(hit?.def.id).toBe('search');
    expect(hit?.def.scopeSensitive).toBeUndefined();
    expect(hit?.def.command).toBe('go.search');
  });
});

describe('search page (5A)', () => {
  it('shows results with marked matches, a type, brand, holder, date, and a polite count', async () => {
    at('?q=invoice');
    const q = vi.spyOn(searchApi, 'query').mockResolvedValue(
      response({
        results: [
          result(),
          result({
            type: 'comment',
            id: 'cmt_1',
            title: 'Is the invoice final?',
            title_parts: [{ text: 'Is the ' }, { text: 'invoice', hit: true }, { text: ' final?' }],
            snippet: null,
            host: { type: 'task', id: TASK, title: 'Close the books' },
          }),
        ],
        total: 2,
      }),
    );
    renderPage();
    const list = await screen.findByRole('list', { name: 'Search results' });
    expect(q).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ q: 'invoice' }),
      expect.anything(),
    );
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const first = within(items[0]!);
    expect(first.getByRole('link', { name: 'Quarterly invoice review' }).getAttribute('href')).toBe(
      `/workspaces/${WS}/tasks/${TASK}`,
    );
    expect(items[0]!.querySelectorAll('mark')).toHaveLength(2);
    expect(first.getByText('Task')).toBeTruthy();
    expect(first.getByText('Harbor')).toBeTruthy();
    expect(first.getByText('Oct 5, 2026')).toBeTruthy();
    expect(within(items[1]!).getByText(/in Task “Close the books”/)).toBeTruthy();
    expect(screen.getByRole('status', { name: '' }).textContent).toContain(
      '2 results for “invoice”, showing 1–2.',
    );
    // Matched text is plain text in a mark, never markup.
    expect(document.body.innerHTML).not.toContain('&lt;mark');
  });

  it('renders text as text: a title that looks like markup is not interpreted', async () => {
    at('?q=x');
    vi.spyOn(searchApi, 'query').mockResolvedValue(
      response({
        results: [
          result({
            title: '<img src=x onerror=alert(1)>',
            title_parts: [{ text: '<img src=x onerror=alert(1)>' }],
            snippet: {
              parts: [{ text: '<script>boom()</script>' }],
              more_before: false,
              more_after: false,
            },
          }),
        ],
      }),
    );
    renderPage();
    await screen.findByRole('list', { name: 'Search results' });
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>boom()</script>')).toBeTruthy();
  });

  it('submits a search into the address, remembers it once, and runs an unchanged one again', async () => {
    at('');
    const q = vi.spyOn(searchApi, 'query').mockResolvedValue(response());
    renderPage();
    const box = screen.getByRole('searchbox', { name: /Search records/ });
    // An empty submission asks for words and does nothing else.
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Type something to search for.')).toBeTruthy();
    expect(q).not.toHaveBeenCalled();
    expect(searchApi.remember).not.toHaveBeenCalled();
    // Typing alone never searches or remembers.
    fireEvent.change(box, { target: { value: '  invoice  ' } });
    expect(q).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(q).toHaveBeenCalledTimes(1));
    expect(window.location.search).toBe('?q=invoice');
    expect(searchApi.remember).toHaveBeenCalledTimes(1);
    expect(searchApi.remember).toHaveBeenCalledWith(WS, expect.objectContaining({ q: 'invoice' }));
    await screen.findByRole('list', { name: 'Search results' });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(q).toHaveBeenCalledTimes(2));
  });

  it('changes filters through the address, back to the first result, and clears them together', async () => {
    at('?q=invoice&cursor=old_cursor');
    const q = vi.spyOn(searchApi, 'query').mockResolvedValue(response());
    renderPage();
    const filters = await screen.findByRole('complementary', { name: 'Filters' });
    fireEvent.click(within(filters).getByRole('checkbox', { name: 'Comments (2)' }));
    await waitFor(() => expect(window.location.search).toBe('?q=invoice&kind=comment'));
    fireEvent.change(within(filters).getByLabelText('Updated'), { target: { value: 'week' } });
    await waitFor(() => expect(window.location.search).toContain('updated=week'));
    fireEvent.click(within(filters).getByRole('checkbox', { name: 'Created or owned by me' }));
    await waitFor(() => expect(window.location.search).toContain('mine=true'));
    expect(q).toHaveBeenLastCalledWith(
      WS,
      expect.objectContaining({ kind: ['comment'], updated: 'week', mine: true, cursor: '' }),
      expect.anything(),
    );
    fireEvent.click(within(filters).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(window.location.search).toBe('?q=invoice'));
    expect(within(filters).queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('keeps filters in a collapsed disclosure on Compact, with the number in use', async () => {
    viewport(320);
    at('?q=invoice&kind=task&mine=true');
    vi.spyOn(searchApi, 'query').mockResolvedValue(response());
    renderPage();
    const summary = await screen.findByText('Filters (2)');
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });

  it('says when the index is catching up or has failed, and marks results that are not current', async () => {
    at('?q=invoice');
    const q = vi.spyOn(searchApi, 'query');
    q.mockResolvedValue(
      response({
        results: [result({ index: 'updating' }), result({ id: 'tsk_2', index: 'failed' })],
        total: 2,
        index: { state: 'catching_up', pending: 3, failed: 0, oldest_pending_seconds: 130 },
      }),
    );
    const { unmount } = renderPage();
    const banner = await screen.findByText('Search is catching up');
    expect(banner.closest('[role="status"]')!.textContent).toContain(
      '3 recent changes are not searchable yet (waiting about 2 min)',
    );
    expect(screen.getByText('Updating')).toBeTruthy();
    expect(screen.getByText('May be out of date')).toBeTruthy();
    unmount();
    q.mockResolvedValue(
      response({ index: { state: 'degraded', pending: 0, failed: 2, oldest_pending_seconds: 5 } }),
    );
    renderPage();
    expect(await screen.findByText("Some items couldn't be searched")).toBeTruthy();
    expect(screen.getByText(/2 items you can read/)).toBeTruthy();
  });

  it('explains an empty result and a result cap, and pages with real links', async () => {
    at('?q=nothing');
    const q = vi.spyOn(searchApi, 'query');
    q.mockResolvedValue(response({ results: [], total: 0 }));
    const { unmount } = renderPage();
    expect(await screen.findByText('No results for “invoice”.')).toBeTruthy();
    expect(screen.getByText('Nothing matches. Try fewer or different words.')).toBeTruthy();
    unmount();
    at('?q=invoice&cursor=c2&kind=task');
    q.mockResolvedValue(
      response({
        total: 1000,
        total_is_lower_bound: true,
        page: { limit: 20, position: 21, has_more: true, next_cursor: 'c3' },
        results: Array.from({ length: 20 }, (_, i) => result({ id: `tsk_${i}` })),
      }),
    );
    renderPage();
    expect(
      await screen.findByText(/1,000 or more results for “invoice”, showing 21–40\./),
    ).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Result pages' });
    expect(within(nav).getByRole('link', { name: 'Next results' }).getAttribute('href')).toBe(
      `/workspaces/${WS}/search?q=invoice&kind=task&cursor=c3`,
    );
    expect(within(nav).getByRole('link', { name: 'First results' }).getAttribute('href')).toBe(
      `/workspaces/${WS}/search?q=invoice&kind=task`,
    );
  });

  it('checks access again when a result is opened, and removes one that is no longer available', async () => {
    at('?q=invoice');
    vi.spyOn(searchApi, 'query').mockResolvedValue(
      response({
        results: [
          result(),
          result({ id: 'tsk_2', title: 'Second', title_parts: [{ text: 'Second' }] }),
        ],
        total: 2,
      }),
    );
    const open = vi.spyOn(searchApi, 'open');
    open.mockResolvedValueOnce({
      type: 'search_open',
      result: { type: 'task', id: TASK },
      host: null,
      lifecycle_state: 'active',
    });
    renderPage();
    const link = await screen.findByRole('link', { name: 'Quarterly invoice review' });
    fireEvent.click(link);
    await waitFor(() => expect(open).toHaveBeenCalledWith(WS, { type: 'task', id: TASK }));
    await waitFor(() => expect(window.location.pathname).toBe(`/workspaces/${WS}/tasks/${TASK}`));
    // Back to the search: the next open is refused, and the result leaves the list with an explanation.
    at('?q=invoice');
    cleanup();
    open.mockRejectedValueOnce(new ApiError({ code: 'not_found', status: 404, message: 'x' }));
    renderPage();
    fireEvent.click(await screen.findByRole('link', { name: 'Second' }));
    expect(await screen.findByText(/“Second” is no longer available to you/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Second' })).toBeNull();
    // A modified click leaves the browser to open a tab; the destination checks access itself.
    const before = open.mock.calls.length;
    const stop = (e: Event) => e.preventDefault(); // jsdom cannot navigate
    document.addEventListener('click', stop);
    fireEvent.click(screen.getByRole('link', { name: 'Quarterly invoice review' }), {
      ctrlKey: true,
    });
    document.removeEventListener('click', stop);
    expect(open.mock.calls.length).toBe(before);
  });

  it('keeps earlier results and says so when the connection fails, and searches again when it returns', async () => {
    at('?q=invoice');
    const q = vi.spyOn(searchApi, 'query');
    q.mockResolvedValueOnce(response());
    renderPage();
    await screen.findByRole('list', { name: 'Search results' });
    q.mockRejectedValueOnce(
      new ApiError({ code: 'offline', status: 0, message: "You're offline." }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText("You're offline")).toBeTruthy();
    expect(screen.getByText('These results are from before the problem')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Search results' })).toBeTruthy();
    q.mockResolvedValueOnce(response({ total: 1 }));
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(screen.queryByText("You're offline")).toBeNull());
    expect(screen.queryByText('These results are from before the problem')).toBeNull();
  });

  it('lists recent searches only before a search, forgets one or all, and links each back', async () => {
    at('');
    const recent: RecentSearch[] = [
      {
        handle: 'h1',
        q: 'budget',
        filters: { kind: ['document'], state: 'any' },
        count: 2,
        searched_at: '2026-10-05T10:00:00.000Z',
      },
      {
        handle: 'h2',
        q: 'roadmap',
        filters: {},
        count: 1,
        searched_at: '2026-10-04T10:00:00.000Z',
      },
    ];
    vi.spyOn(searchApi, 'recent').mockResolvedValue(recent);
    const forget = vi
      .spyOn(searchApi, 'forget')
      .mockResolvedValue({ status: 204, body: undefined });
    renderPage();
    const link = await screen.findByRole('link', { name: 'budget' });
    expect(link.getAttribute('href')).toBe(
      `/workspaces/${WS}/search?q=budget&kind=document&state=any`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Forget the search budget' }));
    await waitFor(() => expect(forget).toHaveBeenCalledWith(WS, 'h1'));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'budget' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Clear recent searches' }));
    await waitFor(() => expect(forget).toHaveBeenLastCalledWith(WS));
    expect(await screen.findByText(/Nothing is remembered while you type/)).toBeTruthy();
  });

  it('searches inside the shell scope by default, says so, and widens on request (IA-10)', async () => {
    shellScope = { kind: 'brand', brand_id: BR };
    at('?q=invoice');
    const q = vi.spyOn(searchApi, 'query').mockResolvedValue(response());
    renderPage();
    expect(await screen.findByText(/Searching in Harbor\./)).toBeTruthy();
    await waitFor(() =>
      expect(q).toHaveBeenLastCalledWith(
        WS,
        expect.objectContaining({ brand: [BR] }),
        expect.anything(),
      ),
    );
    // The address stays short: the scope is a default, not a filter the person chose.
    expect(window.location.search).toBe('?q=invoice');
    fireEvent.click(screen.getByRole('button', { name: 'Search all my brands' }));
    await waitFor(() => expect(window.location.search).toBe('?q=invoice&all_brands=true'));
    await waitFor(() =>
      expect(q).toHaveBeenLastCalledWith(
        WS,
        expect.objectContaining({ brand: [] }),
        expect.anything(),
      ),
    );
    expect(screen.queryByText(/Searching in Harbor/)).toBeNull();
    // A submitted search is remembered as asked: the scope is a default, not part of the search.
    window.history.replaceState({}, '', `/workspaces/${WS}/search?q=invoice`);
    cleanup();
    renderPage();
    await screen.findByText(/Searching in Harbor\./);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(searchApi.remember).toHaveBeenCalledWith(
        WS,
        expect.objectContaining({ q: 'invoice', brand: [] }),
      ),
    );
  });

  it('lets chosen brands replace the scope, and ticking the last one off means every brand', async () => {
    shellScope = { kind: 'brand', brand_id: BR };
    at('?q=invoice');
    vi.spyOn(searchApi, 'query').mockResolvedValue(
      response({
        facets: {
          capped: false,
          kinds: [],
          brands: [
            { brand, count: 3 },
            { brand: { ...brand, id: 'br_00000000000000000000000002', name: 'Summit' }, count: 2 },
          ],
        },
      }),
    );
    renderPage();
    const filters = await screen.findByRole('complementary', { name: 'Filters' });
    const harbor = await within(filters).findByRole('checkbox', { name: 'Harbor (3)' });
    expect((harbor as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(filters).getByRole('checkbox', { name: 'Summit (2)' }));
    await waitFor(() =>
      expect(window.location.search).toBe(`?q=invoice&brand=${BR}%2Cbr_00000000000000000000000002`),
    );
    fireEvent.click(within(filters).getByRole('checkbox', { name: 'Harbor (3)' }));
    fireEvent.click(within(filters).getByRole('checkbox', { name: 'Summit (2)' }));
    await waitFor(() => expect(window.location.search).toBe('?q=invoice&all_brands=true'));
  });

  it('shows the project, the owner, and a removable project filter on results', async () => {
    at(`?q=invoice&project=${PRJ}`);
    vi.spyOn(searchApi, 'query').mockResolvedValue(
      response({
        query: { ...response().query, project: { id: PRJ, name: 'Launch plan' } },
        results: [
          result({
            project: { id: PRJ, name: 'Launch plan' },
            owner: { label: 'Created by', name: 'Fay Founder' },
          }),
        ],
      }),
    );
    renderPage();
    const list = await screen.findByRole('list', { name: 'Search results' });
    expect(within(list).getByText('Project: Launch plan')).toBeTruthy();
    expect(within(list).getByText('Created by: Fay Founder')).toBeTruthy();
    expect(screen.getByText('Launch plan', { selector: 'strong' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the project filter' }));
    await waitFor(() => expect(window.location.search).toBe('?q=invoice'));
  });

  it('tells administrators on Home about failed indexing, and stays silent when healthy or unreadable', async () => {
    const status = vi.spyOn(searchApi, 'status');
    status.mockResolvedValueOnce({
      type: 'search_status',
      index: { state: 'degraded', pending: 0, failed: 3, oldest_pending_seconds: null },
      sources: [],
      limits: { query_max_chars: 200, page_size_max: 50, results_max: 200, count_max: 1000 },
    });
    const { unmount } = render(
      <Router>
        <SearchHealthNotice ws={WS} />
      </Router>,
    );
    expect(await screen.findByText("Some items couldn't be searched")).toBeTruthy();
    expect(screen.getByText(/3 items couldn't be added to search/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open search' }).getAttribute('href')).toBe(
      `/workspaces/${WS}/search`,
    );
    unmount();
    status.mockResolvedValueOnce({
      type: 'search_status',
      index: { state: 'complete', pending: 0, failed: 0, oldest_pending_seconds: null },
      sources: [],
      limits: { query_max_chars: 200, page_size_max: 50, results_max: 200, count_max: 1000 },
    });
    const healthy = render(
      <Router>
        <SearchHealthNotice ws={WS} />
      </Router>,
    );
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(healthy.container.textContent).toBe('');
    healthy.unmount();
    status.mockRejectedValueOnce(new ApiError({ code: 'offline', status: 0, message: 'x' }));
    const failed = render(
      <Router>
        <SearchHealthNotice ws={WS} />
      </Router>,
    );
    await waitFor(() => expect(status).toHaveBeenCalledTimes(3));
    expect(failed.container.textContent).toBe('');
  });
});
