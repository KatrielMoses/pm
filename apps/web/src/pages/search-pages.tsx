import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react';
import { ApiError } from '../api.ts';
import { Link, useRouter } from '../router.tsx';
import {
  searchApi,
  type RecentSearch,
  type SearchQuery,
  type SearchResponse,
  type SearchResult,
  type Snippet,
  type SnippetPart,
} from '../search/client.ts';
import {
  activeFilters,
  atCursor,
  EMPTY_QUERY,
  kindLabel,
  parseSearchParams,
  recentQuery,
  resultHref,
  searchHref,
  toSearchParams,
  withFilters,
} from '../search/params.ts';
import { BrandMarker } from '../shell/brand-marker.tsx';
import { useWidthClass } from '../shell/width.ts';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { Announce, Banner, ProblemBanner } from '../ui/feedback.tsx';
import { Page } from '../ui/layout.tsx';

/**
 * Search (5A, ADR-0028; 0E UXD-19). The whole state is in the URL, so a link is a search and Back
 * restores it. Everything shown was authorized for this person by the server at the time of the
 * request; the page never filters, counts, or guesses on its own. When the index lags or has
 * failed it says so rather than presenting an incomplete result as complete.
 */

const WINDOW_LABEL = {
  '': 'Any time',
  day: 'Past day',
  week: 'Past week',
  month: 'Past month',
  year: 'Past year',
} as const;
const STATE_LABEL = {
  active: 'Active',
  archived: 'Archived',
  any: 'Active and archived',
} as const;

const number = new Intl.NumberFormat();
const date = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));

/** Matched text is marked with `<mark>`; text is always rendered as text, never as markup. */
export function Parts({ parts }: { parts: readonly SnippetPart[] }) {
  // Unmarked text stays a bare text node: wrapping it in an element would let some assistive
  // technology drop the spaces around a marked word when it reads the link's name.
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? <mark key={i}>{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>,
      )}
    </>
  );
}

function Excerpt({ snippet }: { snippet: Snippet }) {
  return (
    <p className="search-snippet">
      {snippet.more_before ? <span aria-hidden="true">… </span> : null}
      <Parts parts={snippet.parts} />
      {snippet.more_after ? <span aria-hidden="true"> …</span> : null}
    </p>
  );
}

function IndexNotice({ index }: { index: SearchResponse['index'] }) {
  if (index.state === 'complete') return null;
  if (index.state === 'degraded')
    return (
      <Banner tone="warning" title="Some items couldn't be searched">
        {index.failed === 1
          ? '1 item you can read'
          : `${number.format(index.failed)} items you can read`}{' '}
        couldn't be added to search and may be missing or out of date here. They are still where you
        left them, and the problem is retried automatically.
      </Banner>
    );
  const wait = index.oldest_pending_seconds;
  return (
    <Banner tone="info" title="Search is catching up">
      {index.pending === 1
        ? '1 recent change is'
        : `${number.format(index.pending)} recent changes are`}{' '}
      not searchable yet
      {wait !== null && wait >= 60 ? ` (waiting about ${Math.round(wait / 60)} min)` : ''}. New or
      edited items may be missing from these results; search again in a moment.
    </Banner>
  );
}

interface Settled {
  /** The request this answered: the query's address plus a counter that repeats the same search. */
  key: string;
  q: string;
  data: SearchResponse | null;
  error: unknown;
}
const NONE: ReadonlySet<string> = new Set();

export function SearchPage({ ws }: { ws: string }) {
  const { search, navigate } = useRouter();
  const shellState = useWorkspaceShell();
  const compact = useWidthClass() === 'compact';
  const id = useId();
  const query = useMemo(() => parseSearchParams(search), [search]);
  const [draft, setDraft] = useState(query.q);
  // The last request that finished (or failed), and which request it answered. Everything shown is
  // derived from it and from the current address, so the page never needs to reset itself.
  const [settled, setSettled] = useState<Settled | null>(null);
  const [goneState, setGoneState] = useState<{ key: string; ids: ReadonlySet<string> }>({
    key: '',
    ids: new Set(),
  });
  const [said, setSaid] = useState('');
  const [recent, setRecent] = useState<RecentSearch[] | null>(null);
  const [recentError, setRecentError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const requestKey = `${toSearchParams(parseSearchParams(search)).toString()}#${reload}`;
  const input = useRef<HTMLInputElement>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const brands = shellState?.context?.brands ?? [];
  const brandName = (b: string) => brands.find((x) => x.id === b)?.name ?? 'A brand';

  // The address is the source of truth: the field follows it (Back, a shared link, a recent
  // search). Adjusted while rendering, not in an effect, so the field never lags the address.
  const [syncedQ, setSyncedQ] = useState(query.q);
  if (syncedQ !== query.q) {
    setSyncedQ(query.q);
    setDraft(query.q);
  }

  const key = toSearchParams(query).toString();
  useEffect(() => {
    if (!query.q) return;
    const controller = new AbortController();
    const asked = `${key}#${reload}`;
    searchApi.query(ws, query, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setSettled({ key: asked, q: query.q, data, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        // The last good results of the same words stay (marked), a different search shows none.
        setSettled((prev) => ({
          key: asked,
          q: query.q,
          data: prev && prev.q === query.q ? prev.data : null,
          error,
        }));
      },
    );
    return () => controller.abort();
    // `key` stands for every field of the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, key, reload]);
  const answered = settled?.key === requestKey;
  const loading = Boolean(query.q) && !answered;
  const error = answered ? settled.error : null;
  // Earlier results stay on screen while the same words are searched again (a filter changed).
  const data = query.q && settled && settled.q === query.q ? settled.data : null;
  const gone = goneState.key === requestKey ? goneState.ids : NONE;

  // A search that failed because the connection dropped runs again by itself when it returns.
  const offline = error instanceof ApiError && error.offline;
  useEffect(() => {
    if (!offline) return;
    const on = () => setReload((n) => n + 1);
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [offline]);

  const loadRecent = useCallback(() => {
    searchApi.recent(ws).then(
      (list) => {
        setRecent(list);
        setRecentError(null);
      },
      (err: unknown) => setRecentError(err),
    );
  }, [ws]);
  useEffect(() => {
    if (!query.q) loadRecent();
  }, [query.q, loadRecent]);

  const go = (next: SearchQuery, replace = false) => navigate(searchHref(ws, next), { replace });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = draft.trim();
    if (!q) {
      setSaid('Type something to search for.');
      input.current?.focus();
      return;
    }
    const next = withFilters(query, { q });
    // Submitting the same search again runs it again (the person may be waiting for the index).
    if (searchHref(ws, next) === searchHref(ws, query)) setReload((n) => n + 1);
    else go(next);
    // Only a submitted search is remembered (never typing, never the palette's live lookups).
    void searchApi.remember(ws, next).catch(() => undefined);
  };

  const open = async (e: MouseEvent<HTMLAnchorElement>, r: SearchResult, href: string) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    try {
      // Opening checks access again at this moment; a result is a pointer, never a grant.
      await searchApi.open(ws, { type: r.type, id: r.id });
      navigate(href);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_found') {
        setGoneState({ key: requestKey, ids: new Set(gone).add(`${r.type}:${r.id}`) });
        setSaid(
          `“${r.title}” is no longer available to you, so it was removed from these results.`,
        );
      } else setSettled({ key: requestKey, q: query.q, data, error: err });
    }
  };

  const shown = (data?.results ?? []).filter((r) => !gone.has(`${r.type}:${r.id}`));
  const filters = activeFilters(query);
  const first = data ? data.page.position : 0;
  const last = data ? data.page.position + data.results.length - 1 : 0;
  const totalText = data
    ? data.total_is_lower_bound
      ? `${number.format(data.total)} or more`
      : number.format(data.total)
    : '';

  const kindOptions = useMemo(() => {
    const out = new Map<string, { label: string; count: number | null }>();
    for (const k of data?.facets.kinds ?? []) out.set(k.kind, { label: k.label, count: k.count });
    for (const k of query.kind)
      if (!out.has(k)) out.set(k, { label: `${kindLabel(k)}s`, count: 0 });
    return [...out.entries()];
  }, [data, query.kind]);
  const brandOptions = useMemo(() => {
    const out = new Map<string, { name: string; count: number }>();
    for (const f of data?.facets.brands ?? [])
      if (f.brand.kind === 'brand') out.set(f.brand.id, { name: f.brand.name, count: f.count });
    for (const b of query.brand) if (!out.has(b)) out.set(b, { name: brandName(b), count: 0 });
    return [...out.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, query.brand, brands]);

  const toggle = (list: string[], v: string, on: boolean) =>
    on ? [...new Set([...list, v])] : list.filter((x) => x !== v);

  const filterPanel = (
    <div className="search-filters-body">
      {kindOptions.length ? (
        <fieldset>
          <legend>Type</legend>
          {kindOptions.map(([kind, o]) => (
            <label key={kind} className="choice">
              <input
                type="checkbox"
                checked={query.kind.includes(kind)}
                onChange={(e) =>
                  go(withFilters(query, { kind: toggle(query.kind, kind, e.target.checked) }))
                }
              />
              {o.count !== null ? `${o.label} (${number.format(o.count)})` : o.label}
            </label>
          ))}
        </fieldset>
      ) : null}
      {brandOptions.length > 1 || query.brand.length ? (
        <fieldset>
          <legend>Brand</legend>
          {brandOptions.map(([b, o]) => (
            <label key={b} className="choice">
              <input
                type="checkbox"
                checked={query.brand.includes(b)}
                onChange={(e) =>
                  go(withFilters(query, { brand: toggle(query.brand, b, e.target.checked) }))
                }
              />
              {`${o.name} (${number.format(o.count)})`}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="field">
        <label htmlFor={`${id}-state`}>Status</label>
        <select
          id={`${id}-state`}
          value={query.state}
          onChange={(e) =>
            go(withFilters(query, { state: e.target.value as SearchQuery['state'] }))
          }
        >
          {(Object.keys(STATE_LABEL) as Array<keyof typeof STATE_LABEL>).map((s) => (
            <option key={s} value={s}>
              {STATE_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-updated`}>Updated</label>
        <select
          id={`${id}-updated`}
          value={query.updated}
          onChange={(e) =>
            go(withFilters(query, { updated: e.target.value as SearchQuery['updated'] }))
          }
        >
          {(Object.keys(WINDOW_LABEL) as Array<keyof typeof WINDOW_LABEL>).map((w) => (
            <option key={w} value={w}>
              {WINDOW_LABEL[w]}
            </option>
          ))}
        </select>
      </div>
      <label className="choice">
        <input
          type="checkbox"
          checked={query.mine}
          onChange={(e) => go(withFilters(query, { mine: e.target.checked }))}
        />
        Created or owned by me
      </label>
      <label className="choice">
        <input
          type="checkbox"
          checked={query.mentioning_me}
          onChange={(e) => go(withFilters(query, { mentioning_me: e.target.checked }))}
        />
        Comments that mention me
      </label>
      {filters ? (
        <button
          type="button"
          className="button button-ghost"
          onClick={() => go({ ...EMPTY_QUERY, q: query.q })}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );

  return (
    <Page title="Search" wide>
      {said ? <Announce>{said}</Announce> : null}
      <form
        role="search"
        aria-label="Search this workspace"
        className="search-form"
        onSubmit={submit}
      >
        <label htmlFor={`${id}-q`}>Search records, comments, files, and documents</label>
        <div className="search-row">
          <input
            ref={input}
            id={`${id}-q`}
            name="q"
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            aria-describedby={`${id}-tips`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="button button-primary">
            Search
          </button>
        </div>
        <p id={`${id}-tips`} className="hint">
          Every word must match. Use “quotes” for an exact phrase and a minus sign to leave a word
          out. Results include only what you can open.
        </p>
      </form>

      {error ? <ProblemBanner error={error} onRetry={() => setReload((n) => n + 1)} /> : null}
      {error && data ? (
        <Banner tone="warning" title="These results are from before the problem">
          They may be out of date. Search again when the connection is back.
        </Banner>
      ) : null}

      {!query.q ? (
        <section aria-labelledby={`${id}-recent`} className="search-recent">
          <h2 id={`${id}-recent`}>Recent searches</h2>
          <ProblemBanner error={recentError} onRetry={loadRecent} />
          {recent === null && !recentError ? (
            <p className="loading" role="status">
              Loading recent searches…
            </p>
          ) : recent && recent.length ? (
            <>
              <ul className="plain-list">
                {recent.map((r) => (
                  <li key={r.handle} className="record-row">
                    <Link className="record-link" to={searchHref(ws, recentQuery(r.q, r.filters))}>
                      {r.q}
                    </Link>
                    <button
                      type="button"
                      className="button button-ghost"
                      aria-label={`Forget the search ${r.q}`}
                      onClick={() =>
                        void searchApi.forget(ws, r.handle).then(
                          () => {
                            setRecent((list) => (list ?? []).filter((x) => x.handle !== r.handle));
                            setSaid('Search forgotten.');
                          },
                          (err: unknown) => setRecentError(err),
                        )
                      }
                    >
                      Forget
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="button button-ghost"
                onClick={() =>
                  void searchApi.forget(ws).then(
                    () => {
                      setRecent([]);
                      setSaid('Recent searches were cleared.');
                    },
                    (err: unknown) => setRecentError(err),
                  )
                }
              >
                Clear recent searches
              </button>
            </>
          ) : (
            <p className="empty">
              Searches you submit appear here, only for you. Nothing is remembered while you type.
            </p>
          )}
        </section>
      ) : (
        <div className="search-layout">
          <aside aria-label="Filters" className="search-filters">
            {compact ? (
              <details>
                <summary>Filters{filters ? ` (${filters})` : ''}</summary>
                {filterPanel}
              </details>
            ) : (
              <>
                <h2>Filters</h2>
                {filterPanel}
              </>
            )}
          </aside>
          <section
            aria-labelledby={`${id}-results`}
            aria-busy={loading}
            className="search-results-region"
          >
            <h2 id={`${id}-results`} ref={resultsHeading} tabIndex={-1}>
              Results
            </h2>
            <p role="status" className="search-count">
              {loading
                ? 'Searching…'
                : data
                  ? data.total === 0
                    ? `No results for “${data.query.q}”.`
                    : `${totalText} ${data.total === 1 && !data.total_is_lower_bound ? 'result' : 'results'} for “${data.query.q}”${
                        data.results.length
                          ? `, showing ${number.format(first)}–${number.format(last)}`
                          : ''
                      }.`
                  : ''}
            </p>
            {data ? <IndexNotice index={data.index} /> : null}
            {data && data.total === 0 && !loading ? (
              <p className="empty">
                {filters
                  ? 'Nothing matches. Try fewer words, or clear the filters.'
                  : 'Nothing matches. Try fewer or different words.'}
              </p>
            ) : null}
            {shown.length ? (
              <ol className="search-results" aria-label="Search results">
                {shown.map((r) => {
                  const href = resultHref(ws, r);
                  return (
                    <li key={`${r.type}:${r.id}`} className="search-result">
                      <h3 className="search-title">
                        {href ? (
                          <a href={href} onClick={(e) => void open(e, r, href)}>
                            <Parts parts={r.title_parts} />
                          </a>
                        ) : (
                          <Parts parts={r.title_parts} />
                        )}
                      </h3>
                      <p className="search-meta">
                        <span className="badge">{kindLabel(r.type)}</span>
                        <BrandMarker marker={r.brand} size={16} />
                        {r.host ? (
                          <span>
                            in {kindLabel(r.host.type)}
                            {r.host.title ? ` “${r.host.title}”` : ''}
                          </span>
                        ) : null}
                        <span>
                          Updated <time dateTime={r.updated_at}>{date(r.updated_at)}</time>
                        </span>
                        {r.lifecycle_state === 'archived' ? (
                          <span className="badge badge-warning">Archived</span>
                        ) : null}
                        {r.index === 'updating' ? (
                          <span className="badge badge-info">Updating</span>
                        ) : r.index === 'failed' ? (
                          <span className="badge badge-warning">May be out of date</span>
                        ) : null}
                      </p>
                      {r.snippet ? <Excerpt snippet={r.snippet} /> : null}
                      {!href ? (
                        <p className="hint">The item it belongs to isn't available to open here.</p>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {data && (data.page.position > 1 || data.page.next_cursor) ? (
              <nav aria-label="Result pages" className="actions">
                {data.page.position > 1 ? (
                  <Link
                    className="button button-secondary"
                    to={searchHref(ws, atCursor(query, ''))}
                    onClick={() => resultsHeading.current?.focus()}
                  >
                    First results
                  </Link>
                ) : null}
                {data.page.next_cursor ? (
                  <Link
                    className="button button-secondary"
                    to={searchHref(ws, atCursor(query, data.page.next_cursor))}
                    onClick={() => resultsHeading.current?.focus()}
                  >
                    Next results
                  </Link>
                ) : null}
              </nav>
            ) : null}
            {data &&
            !data.page.has_more &&
            data.page.position - 1 + data.results.length >= data.limits.results_max ? (
              <p className="hint">
                Results stop at the first {number.format(data.limits.results_max)}. Narrow the
                search to see more.
              </p>
            ) : null}
          </section>
        </div>
      )}
    </Page>
  );
}
