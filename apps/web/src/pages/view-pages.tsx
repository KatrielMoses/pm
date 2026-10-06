import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { savedViewKey, type ViewKey } from '@pm/contracts/shell';
import { ApiError } from '../api.ts';
import { Link, useRouter } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useScrollAnchor, useViewState } from '../shell/view-state.ts';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { useStepUp } from '../stepup.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner, ProblemBanner } from '../ui/feedback.tsx';
import { Field, SelectField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';
import {
  decodeState,
  encodeState,
  views,
  type Catalog,
  type CatalogField,
  type Condition,
  type Entity,
  type Group,
  type Presentation,
  type Query,
  type QueryPage,
  type QueryRow,
  type SavedView,
} from '../views/client.ts';

/**
 * Phase 3A saved views (ADR-0018; 0E Phase 3A note): one builder for AND/OR filters, multi-sort,
 * grouping, visible columns and density over the shared query engine; personal and shared views
 * with explicit sharing, defaults, navigation pins, exports, and deep links. The URL carries the
 * current query (`q`), so a link reproduces the view; the last state is kept per person per view
 * and device. The engine always runs the viewer's own permissions: a view never shows more.
 */

const ENTITY_TEXT: Record<Entity, { one: string; many: string }> = {
  task: { one: 'task', many: 'tasks' },
  project: { one: 'project', many: 'projects' },
};
const OP_TEXT: Record<string, string> = {
  in: 'is any of',
  not_in: 'is none of',
  any_of: 'has any of',
  all_of: 'has all of',
  none_of: 'has none of',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  on: 'is on',
  before: 'is before',
  after: 'is after',
  on_or_before: 'is on or before',
  on_or_after: 'is on or after',
  between: 'is between',
  eq: 'equals',
  lt: 'is less than',
  lte: 'is at most',
  gt: 'is more than',
  gte: 'is at least',
  contains: 'contains',
  not_contains: 'does not contain',
  is_true: 'is checked',
  is_false: 'is not checked',
};
const OPS: Record<string, string[]> = {
  ref: ['in', 'not_in', 'is_empty', 'is_not_empty'],
  multi: ['any_of', 'all_of', 'none_of', 'is_empty', 'is_not_empty'],
  enum: ['in', 'not_in', 'is_empty', 'is_not_empty'],
  date: [
    'on',
    'before',
    'after',
    'on_or_before',
    'on_or_after',
    'between',
    'is_empty',
    'is_not_empty',
  ],
  number: ['eq', 'lt', 'lte', 'gt', 'gte', 'between', 'is_empty', 'is_not_empty'],
  text: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
  bool: ['is_true', 'is_false', 'is_empty', 'is_not_empty'],
};
const NO_VALUE = new Set(['is_empty', 'is_not_empty', 'is_true', 'is_false']);
const titleCase = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1).replace(/_/g, ' ') : s);
const isGroup = (n: Condition | Group): n is Group => 'items' in n;

const DEFAULT_PRESENTATION = (catalog: Catalog): Presentation => ({
  columns: catalog.default_columns,
  density: 'comfortable',
});

/** A stable comparison of definitions (for the Modified marker). */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.issues.length) return err.issues.map((i) => i.message).join(' ');
    if (err.code === 'conflict')
      return 'Someone else changed this view. Reload to see their changes.';
    if (err.code === 'forbidden') return "You don't have permission to do that.";
    return err.message;
  }
  return 'Something went wrong.';
}

// -------------------------------------------------------------------------------------------------
// The list of saved views
// -------------------------------------------------------------------------------------------------

export function SavedViewsPage({ ws }: { ws: string }) {
  const [list, setList] = useState<SavedView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    views.list(ws).then(
      (v) => {
        setError(null);
        setList(v);
      },
      (e: unknown) => setError(e),
    );
  }, [ws]);
  useEffect(load, [load]);
  const mine = (list ?? []).filter((v) => v.owned && v.visibility === 'personal');
  const shared = (list ?? []).filter((v) => v.visibility === 'shared');
  const item = (v: SavedView) => (
    <li key={v.id} className="view-item">
      <Link to={routeHref('view', { ws, view: v.id })}>{v.name}</Link>{' '}
      <span className="hint">
        {titleCase(ENTITY_TEXT[v.entity].many)}
        {v.share
          ? ` · Shared with ${
              v.share.scope === 'workspace'
                ? 'the workspace'
                : (v.share.brand?.name ?? v.share.project?.name ?? 'a scope')
            }`
          : ''}
      </span>
    </li>
  );
  return (
    <Page
      title="Saved views"
      lead="Filters, sorting, grouping, and columns you can come back to. A view never shows anyone more than they can already see."
      actions={
        <div className="actions">
          <Link
            className="button button-primary"
            to={`${routeHref('view', { ws, view: 'new' })}?entity=task`}
          >
            New task view
          </Link>
          <Link
            className="button button-secondary"
            to={`${routeHref('view', { ws, view: 'new' })}?entity=project`}
          >
            New project view
          </Link>
        </div>
      }
    >
      {error ? <ProblemBanner error={error} onRetry={load} /> : null}
      {list === null && !error ? <p role="status">Loading views…</p> : null}
      {list ? (
        <>
          <section aria-labelledby="views-mine">
            <h2 id="views-mine">Your views</h2>
            {mine.length ? (
              <ul className="view-list">{mine.map(item)}</ul>
            ) : (
              <p className="hint">No personal views yet. Start a new view to save one.</p>
            )}
          </section>
          <section aria-labelledby="views-shared">
            <h2 id="views-shared">Shared views</h2>
            {shared.length ? (
              <ul className="view-list">{shared.map(item)}</ul>
            ) : (
              <p className="hint">Nothing is shared with you yet.</p>
            )}
          </section>
        </>
      ) : null}
    </Page>
  );
}

// -------------------------------------------------------------------------------------------------
// One view: builder, results, and actions
// -------------------------------------------------------------------------------------------------

export function SavedViewPage({ ws, view }: { ws: string; view: string }) {
  const { search } = useRouter();
  const draftEntity = search.get('entity') === 'project' ? 'project' : 'task';
  const isDraft = view === 'new';
  const [saved, setSaved] = useState<SavedView | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (isDraft) return;
    let live = true;
    views.get(ws, view).then(
      (v) => live && (setSaved(v), setFailure(null)),
      (e: unknown) => live && setFailure(e),
    );
    return () => {
      live = false;
    };
  }, [ws, view, isDraft, reload]);
  const entity: Entity = isDraft ? draftEntity : (saved?.entity ?? 'task');
  if (!isDraft && failure instanceof ApiError && failure.code === 'not_found')
    return (
      <Page title="This page isn't available" record={null} section="Not available">
        <p>This view doesn't exist or isn't shared with you.</p>
        <Link to={routeHref('views', { ws })}>All saved views</Link>
      </Page>
    );
  if (!isDraft && !saved)
    return (
      <Page title="Saved view">
        {failure ? (
          <ProblemBanner error={failure} onRetry={() => setReload((n) => n + 1)} />
        ) : (
          <p role="status">Loading view…</p>
        )}
      </Page>
    );
  const key: ViewKey = isDraft ? (`views.draft.${entity}` as ViewKey) : savedViewKey(view);
  return (
    <ViewWorkspace
      key={key}
      ws={ws}
      entity={entity}
      viewKey={key}
      saved={saved}
      onSaved={(v) => setSaved(v)}
    />
  );
}

function ViewWorkspace({
  ws,
  entity,
  viewKey,
  saved,
  onSaved,
}: {
  ws: string;
  entity: Entity;
  viewKey: ViewKey;
  saved: SavedView | null;
  onSaved: (v: SavedView) => void;
}) {
  const { navigate } = useRouter();
  const shellState = useWorkspaceShell();
  const stepUp = useStepUp();
  const state = useViewState(ws, viewKey);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<unknown>(null);
  useEffect(() => {
    views.catalog(ws, entity).then(setCatalog, setCatalogError);
  }, [ws, entity]);

  const base = useMemo<{ query: Query; presentation: Presentation } | null>(() => {
    if (!catalog) return null;
    if (saved)
      return {
        query: { ...saved.query, entity },
        presentation: {
          columns: saved.presentation.columns ?? catalog.default_columns,
          density: saved.presentation.density ?? 'comfortable',
        },
      };
    return { query: { v: 1, entity }, presentation: DEFAULT_PRESENTATION(catalog) };
  }, [catalog, saved, entity]);
  const urlQ = typeof state.state.q === 'string' ? state.state.q : '';
  const fromUrl = useMemo(() => {
    const d = urlQ ? decodeState(urlQ) : null;
    return d && d.query.entity === entity && base
      ? {
          query: d.query,
          presentation: d.presentation.columns.length ? d.presentation : base.presentation,
        }
      : base;
  }, [urlQ, base, entity]);
  // The working copy changes at once; the URL and device state follow (debounced). A URL change
  // made elsewhere (Back, Forward, Reset, a pasted link) replaces the working copy.
  const [current, setLocal] = useState(fromUrl);
  const written = useRef('');
  useEffect(() => {
    setLocal((prev) => (prev === null || urlQ !== written.current ? fromUrl : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromUrl]);
  const modified = !!(saved && current && base && !same(current, base));
  const setCurrent = (next: { query: Query; presentation: Presentation }) => {
    setLocal(next);
    const q = base && same(next, base) ? '' : encodeState(next.query, next.presentation);
    written.current = q;
    state.set({ q: q || undefined });
  };
  /** Back to the saved definition (or the draft defaults), now and in the URL. */
  const resetToBase = () => {
    setLocal(base);
    written.current = '';
    state.set({ q: undefined });
  };
  /** Only complete conditions run; one being edited waits for its value. */
  const runnable = useMemo(
    () => (current ? { ...current, query: completeQuery(current.query) } : null),
    [current],
  );

  // Results: first page on every change, then keyset pages on demand.
  const [page, setPage] = useState<QueryPage | null>(null);
  const [rows, setRows] = useState<QueryRow[]>([]);
  const [queryError, setQueryError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const scope = useMemo(() => {
    const s = shellState?.context?.scope;
    return s?.kind === 'brands' ? s.brand_ids : s?.kind === 'brand' ? [s.brand_id] : [];
  }, [shellState?.context?.scope]);
  const runKey = runnable ? JSON.stringify([runnable, scope]) : '';
  const seq = useRef(0);
  useEffect(() => {
    if (!runnable) return;
    const ctl = new AbortController();
    // Only the latest query's answer is shown (an earlier one may resolve later).
    const mine = ++seq.current;
    views
      .query(
        ws,
        {
          query: runnable.query,
          presentation: runnable.presentation,
          include_total: true,
          limit: 50,
          ...(scope.length ? { scope } : {}),
        },
        ctl.signal,
      )
      .then(
        (p) => {
          if (mine !== seq.current) return;
          setQueryError(null);
          setPage(p);
          setRows(p.data);
        },
        (e: unknown) => {
          if (mine !== seq.current || (e instanceof ApiError && e.code === 'aborted')) return;
          setQueryError(e);
        },
      );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, runKey]);
  const more = async () => {
    if (!runnable || !page?.page.next_cursor) return;
    setLoadingMore(true);
    const mine = seq.current;
    try {
      const p = await views.query(ws, {
        query: runnable.query,
        presentation: runnable.presentation,
        cursor: page.page.next_cursor,
        limit: 50,
        ...(scope.length ? { scope } : {}),
      });
      if (mine !== seq.current) return;
      setPage({ ...p, view: { ...p.view, groups: page.view.groups } });
      setRows((r) => [...r, ...p.data]);
    } catch (e) {
      setQueryError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  const list = useRef<HTMLDivElement>(null);
  useScrollAnchor(
    list,
    page !== null,
    {
      anchor: typeof state.state.anchor === 'string' ? state.state.anchor : undefined,
      position: typeof state.state.position === 'string' ? state.state.position : undefined,
    },
    useCallback(
      (anchor: string, position: number) => state.set({ anchor, position: String(position) }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [state.set],
    ),
  );

  const [panel, setPanel] = useState<'filter' | 'sort' | 'group' | 'columns' | null>(null);
  const [dialog, setDialog] = useState<
    'save_as' | 'share' | 'default' | 'export' | 'delete' | null
  >(null);
  const [said, setSaid] = useState('');
  const [actionError, setActionError] = useState('');

  const act = async (fn: () => Promise<void>) => {
    setActionError('');
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'cancelled')) setActionError(describeError(e));
    }
  };
  const save = () =>
    act(async () => {
      if (!saved || !current) return;
      const v = await views.update(
        ws,
        saved.id,
        { query: completeQuery(current.query), presentation: current.presentation },
        saved.version,
        stepUp,
      );
      onSaved(v);
      written.current = '';
      setLocal({
        query: { ...v.query, entity },
        presentation: {
          columns: v.presentation.columns ?? current.presentation.columns,
          density: v.presentation.density ?? 'comfortable',
        },
      });
      state.set({ q: undefined });
      setSaid('View saved.');
    });

  if (catalogError) return <Page title="Saved view">{<ProblemBanner error={catalogError} />}</Page>;
  if (!catalog || !current) return <Page title="Saved view">{<p role="status">Loading…</p>}</Page>;
  const title = saved ? saved.name : `New ${ENTITY_TEXT[entity].one} view`;
  const fields = new Map(catalog.fields.map((f) => [f.field, f]));
  const total = page?.page.total;
  const summary = page
    ? `${total?.capped ? `More than ${total.value}` : (total?.value ?? rows.length)} ${
        (total?.value ?? rows.length) === 1 ? ENTITY_TEXT[entity].one : ENTITY_TEXT[entity].many
      }`
    : '';
  const filterCount = countConditions(current.query.filter);
  const sharedTo = saved?.share
    ? saved.share.scope === 'workspace'
      ? 'Shared with the workspace'
      : `Shared with ${saved.share.brand?.name ?? saved.share.project?.name}`
    : saved
      ? 'Personal view'
      : 'Not saved yet';

  return (
    <Page
      title={title}
      record={saved ? { title: saved.name } : null}
      breadcrumbs={[{ label: 'Saved views', to: routeHref('views', { ws }) }]}
      wide
    >
      <p className="view-meta">
        <span>{sharedTo}</span>
        {modified ? (
          <span className="badge" aria-label="Modified: not saved to the shared definition">
            Modified
          </span>
        ) : null}
      </p>
      {said ? <Announce>{said}</Announce> : null}
      {actionError ? (
        <Banner tone="danger" title="That didn't work">
          {actionError}
        </Banner>
      ) : null}
      <div className="view-actions" role="group" aria-label="View actions">
        {!saved ? (
          <button
            type="button"
            className="button button-primary"
            onClick={() => setDialog('save_as')}
          >
            Save view…
          </button>
        ) : null}
        {saved && modified && saved.can_manage ? (
          <button type="button" className="button button-primary" onClick={() => void save()}>
            Save
          </button>
        ) : null}
        {saved && modified ? (
          <>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setDialog('save_as')}
            >
              Save as new view…
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                resetToBase();
                setSaid('View reset to the saved definition.');
              }}
            >
              Reset
            </button>
          </>
        ) : null}
        {saved?.can_manage ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setDialog('share')}
          >
            Share…
          </button>
        ) : null}
        {saved ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setDialog('default')}
          >
            Default…
          </button>
        ) : null}
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setDialog('export')}
        >
          Export…
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() =>
            void navigator.clipboard?.writeText(window.location.href).then(
              () => setSaid('Link copied.'),
              () => setSaid('Copy the address from the address bar.'),
            )
          }
        >
          Copy link
        </button>
        {saved?.can_manage ? (
          <button
            type="button"
            className="button button-danger"
            onClick={() => setDialog('delete')}
          >
            Delete…
          </button>
        ) : null}
      </div>

      <div className="view-tools" role="group" aria-label="Change what this view shows">
        {(
          [
            ['filter', `Filters${filterCount ? ` (${filterCount})` : ''}`],
            ['sort', `Sort${current.query.sort?.length ? ` (${current.query.sort.length})` : ''}`],
            [
              'group',
              current.query.group
                ? `Group: ${fields.get(current.query.group.field)?.label ?? ''}`
                : 'Group',
            ],
            ['columns', 'Columns'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="button button-secondary"
            aria-expanded={panel === id}
            aria-controls="view-panel"
            onClick={() => setPanel(panel === id ? null : id)}
          >
            {label}
          </button>
        ))}
        <fieldset className="density">
          <legend className="visually-hidden">Density</legend>
          {(['comfortable', 'compact'] as const).map((d) => (
            <label key={d} className="choice">
              <input
                type="radio"
                name="density"
                checked={current.presentation.density === d}
                onChange={() =>
                  setCurrent({ ...current, presentation: { ...current.presentation, density: d } })
                }
              />{' '}
              {titleCase(d)}
            </label>
          ))}
        </fieldset>
      </div>

      {panel ? (
        <section
          id="view-panel"
          className="view-panel"
          aria-label={titleCase(panel === 'filter' ? 'filters' : panel)}
        >
          {panel === 'filter' ? (
            <FilterEditor
              ws={ws}
              catalog={catalog}
              group={current.query.filter ?? { op: 'and', items: [] }}
              depth={1}
              onChange={(g) =>
                setCurrent({
                  ...current,
                  query: {
                    ...current.query,
                    ...(g.items.length ? { filter: g } : { filter: undefined }),
                  },
                })
              }
            />
          ) : panel === 'sort' ? (
            <SortEditor
              catalog={catalog}
              sort={current.query.sort ?? []}
              onChange={(sort) => setCurrent({ ...current, query: { ...current.query, sort } })}
            />
          ) : panel === 'group' ? (
            <GroupEditor
              catalog={catalog}
              group={current.query.group ?? null}
              onChange={(group) =>
                setCurrent({ ...current, query: { ...current.query, group: group ?? undefined } })
              }
            />
          ) : (
            <ColumnsEditor
              catalog={catalog}
              columns={current.presentation.columns}
              onChange={(columns) =>
                setCurrent({ ...current, presentation: { ...current.presentation, columns } })
              }
            />
          )}
        </section>
      ) : null}

      {queryError ? (
        <Banner tone="danger" title="This view can't be shown">
          {describeError(queryError)}
        </Banner>
      ) : null}
      <p className="view-summary" role="status" aria-live="polite">
        {summary}
      </p>
      {page && !rows.length ? (
        <p className="hint">Nothing matches. {filterCount ? 'Remove a filter to see more.' : ''}</p>
      ) : null}
      {rows.length ? (
        <div
          ref={list}
          className={`view-results density-${current.presentation.density}`}
          role="region"
          aria-label={`${title} results`}
          tabIndex={0}
        >
          <ResultsTable ws={ws} entity={entity} page={page!} rows={rows} catalog={catalog} />
        </div>
      ) : null}
      {page?.page.has_more ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={loadingMore}
          onClick={() => void more()}
        >
          {loadingMore ? 'Loading…' : `Show more ${ENTITY_TEXT[entity].many}`}
        </button>
      ) : null}

      {dialog === 'save_as' ? (
        <SaveAsDialog
          onClose={() => setDialog(null)}
          onSave={async (name) => {
            const v = await views.create(
              ws,
              { name, query: completeQuery(current.query), presentation: current.presentation },
              stepUp,
            );
            setDialog(null);
            if (saved) state.set({ q: undefined });
            navigate(routeHref('view', { ws, view: v.id }));
          }}
        />
      ) : null}
      {dialog === 'share' && saved ? (
        <ShareDialog
          ws={ws}
          view={saved}
          onClose={() => setDialog(null)}
          onDone={(v, message) => {
            onSaved(v);
            setDialog(null);
            setSaid(message);
          }}
        />
      ) : null}
      {dialog === 'default' && saved ? (
        <DefaultDialog
          ws={ws}
          view={saved}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            setDialog(null);
            setSaid(message);
          }}
        />
      ) : null}
      {dialog === 'export' ? (
        <ExportDialog
          max={catalog.bounds.export_rows}
          onClose={() => setDialog(null)}
          onExport={async (format) => {
            const file = await views.exportView(ws, {
              query: completeQuery(current.query),
              presentation: current.presentation,
              format,
              name: title,
              ...(scope.length ? { scope } : {}),
            });
            const url = URL.createObjectURL(new Blob([file.text], { type: file.contentType }));
            const a = document.createElement('a');
            a.href = url;
            a.download = file.filename;
            a.click();
            URL.revokeObjectURL(url);
            setDialog(null);
            setSaid(`Exported ${file.filename}.`);
          }}
        />
      ) : null}
      {dialog === 'delete' && saved ? (
        <Dialog title="Delete this view?" destructive onClose={() => setDialog(null)}>
          <p>
            “{saved.name}” will be removed for everyone it is shared with, with its pins and
            defaults. Records are not affected.
          </p>
          <div className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setDialog(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() =>
                void act(async () => {
                  await views.remove(ws, saved.id, stepUp);
                  setDialog(null);
                  navigate(routeHref('views', { ws }));
                })
              }
            >
              Delete view
            </button>
          </div>
        </Dialog>
      ) : null}
    </Page>
  );
}

/** A condition is complete when its operator needs no value or its value is filled in. */
function complete(c: Condition): boolean {
  if (NO_VALUE.has(c.op)) return true;
  const v = c.value;
  if (Array.isArray(v)) return v.length > 0 && v.every((x) => x !== undefined && x !== '');
  return v !== undefined && v !== '' && v !== null;
}
function completeGroup(g: Group): Group | null {
  const items = g.items
    .map((n) => (isGroup(n) ? completeGroup(n) : complete(n) ? n : null))
    .filter((n): n is Condition | Group => n !== null);
  return items.length ? { ...g, items } : null;
}
function completeQuery(q: Query): Query {
  const filter = q.filter ? completeGroup(q.filter) : null;
  const { filter: _f, ...rest } = q;
  return filter ? { ...rest, filter } : rest;
}

function countConditions(g: Group | undefined): number {
  if (!g) return 0;
  return g.items.reduce((n, x) => n + (isGroup(x) ? countConditions(x) : 1), 0);
}

// -------------------------------------------------------------------------------------------------
// Results
// -------------------------------------------------------------------------------------------------

function cell(ws: string, entity: Entity, field: string, row: QueryRow): ReactNode {
  const v = row[field] as unknown;
  switch (field) {
    case 'title':
    case 'name':
      return (
        <Link
          to={
            entity === 'task'
              ? routeHref('task', { ws, tsk: row.id })
              : routeHref('project', { ws, prj: row.id })
          }
        >
          {row.title}
        </Link>
      );
    case 'status':
      return row.status.name;
    case 'priority':
      return titleCase(row.priority);
    case 'brand':
      return row.brand.name;
    case 'project': {
      const p = row.project as { id: string; name: string } | undefined;
      return p ? <Link to={routeHref('project', { ws, prj: p.id })}>{p.name}</Link> : '';
    }
    case 'owner':
      return (row.owner as { name: string } | null | undefined)?.name ?? '';
    case 'assignee':
      return ((row.assignees as Array<{ name: string }> | undefined) ?? [])
        .map((a) => a.name)
        .join(', ');
    case 'label':
      return ((row.labels as Array<{ name: string }> | undefined) ?? [])
        .map((a) => a.name)
        .join(', ');
    case 'milestone':
      return (row.milestone as { name: string } | null | undefined)?.name ?? '';
    case 'health':
      return v ? titleCase(String(v)) : '';
    case 'status_category':
      return titleCase(String(v ?? ''));
    case 'agent':
      return '';
  }
  if (field.startsWith('field:')) {
    const fv = (row.fields as Record<string, unknown> | undefined)?.[field.slice(6)];
    if (fv === null || fv === undefined) return '';
    if (typeof fv === 'object') return JSON.stringify(fv);
    return typeof fv === 'boolean' ? (fv ? 'Yes' : 'No') : String(fv);
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return v === null || v === undefined ? '' : String(v);
}

function ResultsTable({
  ws,
  entity,
  page,
  rows,
  catalog,
}: {
  ws: string;
  entity: Entity;
  page: QueryPage;
  rows: QueryRow[];
  catalog: Catalog;
}) {
  const cols = page.view.columns;
  const groups = page.view.groups;
  const labelOf = (key: string | undefined) =>
    groups?.find((g) => (g.key ?? undefined) === key) ?? null;
  const out: ReactNode[] = [];
  let last: string | undefined | null = null;
  rows.forEach((row) => {
    if (groups && row.group !== last) {
      last = row.group;
      const g = labelOf(row.group);
      out.push(
        <tr key={`g:${row.group ?? 'none'}:${row.id}`} className="group-row">
          <th scope="rowgroup" colSpan={cols.length}>
            {g?.label ?? 'None'} <span className="hint">({g?.count ?? ''})</span>
          </th>
        </tr>,
      );
    }
    out.push(
      <tr key={row.id} data-anchor-id={row.id}>
        {cols.map((c, i) =>
          i === 0 ? (
            <th key={c.field} scope="row">
              {cell(ws, entity, c.field, row)}
            </th>
          ) : (
            <td key={c.field}>{cell(ws, entity, c.field, row)}</td>
          ),
        )}
      </tr>,
    );
  });
  void catalog;
  return (
    <table className="view-table">
      <caption className="visually-hidden">{ENTITY_TEXT[entity].many} in this view</caption>
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c.field} scope="col">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{out}</tbody>
    </table>
  );
}

// -------------------------------------------------------------------------------------------------
// Builders
// -------------------------------------------------------------------------------------------------

function FilterEditor({
  ws,
  catalog,
  group,
  depth,
  onChange,
  onRemove,
}: {
  ws: string;
  catalog: Catalog;
  group: Group;
  depth: number;
  onChange: (g: Group) => void;
  onRemove?: () => void;
}) {
  const id = useId();
  const filterable = catalog.fields.filter((f) => f.filterable);
  const first = filterable[0]!;
  const add = () =>
    onChange({
      ...group,
      items: [...group.items, { field: first.field, op: OPS[first.kind]![0]! }],
    });
  const setItem = (i: number, n: Condition | Group) =>
    onChange({ ...group, items: group.items.map((x, j) => (j === i ? n : x)) });
  const remove = (i: number) =>
    onChange({ ...group, items: group.items.filter((_, j) => j !== i) });
  return (
    <fieldset className="filter-group">
      <legend>{depth === 1 ? 'Show records that match' : 'Group of conditions'}</legend>
      <SelectField
        id={`${id}-op`}
        label={depth === 1 ? 'Combine conditions with' : 'Combine this group with'}
        value={group.op}
        onChange={(op) => onChange({ ...group, op: op as Group['op'] })}
        options={[
          { value: 'and', label: 'All of them (and)' },
          { value: 'or', label: 'Any of them (or)' },
        ]}
      />
      {group.items.length ? (
        <ol className="filter-items">
          {group.items.map((n, i) => (
            <li key={i}>
              {isGroup(n) ? (
                <FilterEditor
                  ws={ws}
                  catalog={catalog}
                  group={n}
                  depth={depth + 1}
                  onChange={(g) => setItem(i, g)}
                  onRemove={() => remove(i)}
                />
              ) : (
                <ConditionEditor
                  ws={ws}
                  catalog={catalog}
                  index={i + 1}
                  condition={n}
                  onChange={(c) => setItem(i, c)}
                  onRemove={() => remove(i)}
                />
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="hint">No conditions: everything you can see is shown.</p>
      )}
      <div className="actions">
        <button type="button" className="button button-secondary" onClick={add}>
          Add condition
        </button>
        {depth < catalog.bounds.depth ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() =>
              onChange({
                ...group,
                items: [
                  ...group.items,
                  {
                    op: group.op === 'and' ? 'or' : 'and',
                    items: [{ field: first.field, op: OPS[first.kind]![0]! }],
                  },
                ],
              })
            }
          >
            Add group
          </button>
        ) : null}
        {onRemove ? (
          <button type="button" className="button button-secondary" onClick={onRemove}>
            Remove group
          </button>
        ) : null}
      </div>
    </fieldset>
  );
}

function ConditionEditor({
  ws,
  catalog,
  index,
  condition,
  onChange,
  onRemove,
}: {
  ws: string;
  catalog: Catalog;
  index: number;
  condition: Condition;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const filterable = catalog.fields.filter((f) => f.filterable);
  const spec = filterable.find((f) => f.field === condition.field) ?? filterable[0]!;
  const ops = OPS[spec.kind]!;
  return (
    <div className="condition" role="group" aria-label={`Condition ${index}`}>
      <SelectField
        id={`${id}-field`}
        label="Field"
        value={spec.field}
        onChange={(field) => {
          const next = filterable.find((f) => f.field === field)!;
          onChange({ field, op: OPS[next.kind]![0]! });
        }}
        options={filterable.map((f) => ({ value: f.field, label: f.label }))}
      />
      <SelectField
        id={`${id}-op`}
        label="Condition"
        value={ops.includes(condition.op) ? condition.op : ops[0]!}
        onChange={(op) =>
          onChange(NO_VALUE.has(op) ? { field: spec.field, op } : { ...condition, op })
        }
        options={ops.map((o) => ({ value: o, label: OP_TEXT[o] ?? o }))}
      />
      {NO_VALUE.has(condition.op) ? null : (
        <ValueEditor
          ws={ws}
          entity={catalog.entity}
          spec={spec}
          condition={condition}
          onChange={onChange}
        />
      )}
      <button
        type="button"
        className="button button-secondary"
        aria-label={`Remove condition ${index}`}
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  );
}

function ValueEditor({
  ws,
  entity,
  spec,
  condition,
  onChange,
}: {
  ws: string;
  entity: Entity;
  spec: CatalogField;
  condition: Condition;
  onChange: (c: Condition) => void;
}) {
  const id = useId();
  const set = (value: unknown) => onChange({ ...condition, value });
  const kind = spec.custom && spec.kind === 'ref' ? 'ref' : spec.kind;
  if (kind === 'enum') {
    const chosen = Array.isArray(condition.value) ? (condition.value as string[]) : [];
    return (
      <fieldset className="choices">
        <legend>Values</legend>
        {(spec.values ?? []).map((v) => (
          <label key={v} className="choice">
            <input
              type="checkbox"
              checked={chosen.includes(v)}
              onChange={(e) =>
                set(e.target.checked ? [...chosen, v] : chosen.filter((x) => x !== v))
              }
            />{' '}
            {titleCase(v)}
          </label>
        ))}
      </fieldset>
    );
  }
  if (kind === 'ref' || kind === 'multi')
    return (
      <RefPicker ws={ws} entity={entity} spec={spec} condition={condition} onChange={onChange} />
    );
  if (kind === 'date' || kind === 'number') {
    const two = condition.op === 'between';
    const vals = Array.isArray(condition.value)
      ? (condition.value as unknown[])
      : [condition.value];
    const show = (v: unknown) =>
      typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
    const put = (i: number, v: string) => {
      const next = [...(two ? [vals[0], vals[1]] : [vals[0]])];
      next[i] = v || undefined;
      set(two ? next : next[0]);
    };
    return (
      <div className="value-pair">
        <Field
          id={`${id}-a`}
          label={two ? 'From' : 'Value'}
          type={kind === 'date' ? 'date' : 'number'}
          value={show(vals[0])}
          onChange={(e) => put(0, e.target.value)}
        />
        {two ? (
          <Field
            id={`${id}-b`}
            label="To"
            type={kind === 'date' ? 'date' : 'number'}
            value={show(vals[1])}
            onChange={(e) => put(1, e.target.value)}
          />
        ) : null}
      </div>
    );
  }
  return (
    <Field
      id={`${id}-t`}
      label="Text"
      value={typeof condition.value === 'string' ? condition.value : ''}
      onChange={(e) => set(e.target.value)}
      maxLength={200}
    />
  );
}

function RefPicker({
  ws,
  entity,
  spec,
  condition,
  onChange,
}: {
  ws: string;
  entity: Entity;
  spec: CatalogField;
  condition: Condition;
  onChange: (c: Condition) => void;
}) {
  const id = useId();
  const [options, setOptions] = useState<Array<{ value: string; label: string }> | null>(null);
  useEffect(() => {
    let live = true;
    views.options(ws, entity, spec.field).then(
      (o) => live && setOptions(o),
      () => live && setOptions([]),
    );
    return () => {
      live = false;
    };
  }, [ws, entity, spec.field]);
  const chosen = Array.isArray(condition.value) ? (condition.value as string[]) : [];
  const label = (v: string) => options?.find((o) => o.value === v)?.label ?? 'Unavailable value';
  return (
    <div className="ref-picker">
      {chosen.length ? (
        <ul className="chips" aria-label="Chosen values">
          {chosen.map((v) => (
            <li key={v}>
              {label(v)}{' '}
              <button
                type="button"
                className="link-button"
                aria-label={`Remove ${label(v)}`}
                onClick={() => onChange({ ...condition, value: chosen.filter((x) => x !== v) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <SelectField
        id={`${id}-add`}
        label="Add a value"
        value=""
        onChange={(v) => v && onChange({ ...condition, value: [...chosen, v] })}
        options={[
          {
            value: '',
            label: options === null ? 'Loading…' : options.length ? 'Choose…' : 'Nothing to choose',
          },
          ...(options ?? []).filter((o) => !chosen.includes(o.value)),
        ]}
      />
    </div>
  );
}

function SortEditor({
  catalog,
  sort,
  onChange,
}: {
  catalog: Catalog;
  sort: Array<{ field: string; dir: 'asc' | 'desc' }>;
  onChange: (s: Array<{ field: string; dir: 'asc' | 'desc' }>) => void;
}) {
  const id = useId();
  const sortable = catalog.fields.filter((f) => f.sortable);
  const unused = sortable.filter((f) => !sort.some((s) => s.field === f.field));
  const move = (i: number, d: -1 | 1) => {
    const next = [...sort];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange(next);
  };
  return (
    <div>
      <h2 className="panel-title">Sort</h2>
      {sort.length ? (
        <ol className="sort-items">
          {sort.map((s, i) => (
            <li key={s.field} className="condition" role="group" aria-label={`Sort ${i + 1}`}>
              <SelectField
                id={`${id}-${i}-f`}
                label={i === 0 ? 'Sort by' : 'Then by'}
                value={s.field}
                onChange={(field) => onChange(sort.map((x, j) => (j === i ? { ...x, field } : x)))}
                options={[
                  ...sortable
                    .filter((f) => f.field === s.field || !sort.some((x) => x.field === f.field))
                    .map((f) => ({ value: f.field, label: f.label })),
                ]}
              />
              <SelectField
                id={`${id}-${i}-d`}
                label="Order"
                value={s.dir}
                onChange={(dir) =>
                  onChange(sort.map((x, j) => (j === i ? { ...x, dir: dir as 'asc' | 'desc' } : x)))
                }
                options={[
                  { value: 'asc', label: 'Ascending' },
                  { value: 'desc', label: 'Descending' },
                ]}
              />
              <div className="actions">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move sort ${i + 1} up`}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={i === sort.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move sort ${i + 1} down`}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => onChange(sort.filter((_, j) => j !== i))}
                  aria-label={`Remove sort ${i + 1}`}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="hint">Manual order.</p>
      )}
      {sort.length < catalog.bounds.sorts && unused.length ? (
        <button
          type="button"
          className="button button-secondary"
          onClick={() => onChange([...sort, { field: unused[0]!.field, dir: 'asc' }])}
        >
          Add sort
        </button>
      ) : null}
    </div>
  );
}

function GroupEditor({
  catalog,
  group,
  onChange,
}: {
  catalog: Catalog;
  group: { field: string; granularity?: 'day' | 'week' | 'month' } | null;
  onChange: (g: { field: string; granularity?: 'day' | 'week' | 'month' } | null) => void;
}) {
  const id = useId();
  const groupable = catalog.fields.filter((f) => f.groupable);
  const spec = group ? groupable.find((f) => f.field === group.field) : undefined;
  return (
    <div>
      <SelectField
        id={`${id}-g`}
        label="Group by"
        value={group?.field ?? ''}
        onChange={(field) => onChange(field ? { field } : null)}
        options={[
          { value: '', label: 'No grouping' },
          ...groupable.map((f) => ({ value: f.field, label: f.label })),
        ]}
      />
      {spec?.kind === 'date' ? (
        <SelectField
          id={`${id}-gr`}
          label="Group dates by"
          value={group?.granularity ?? 'day'}
          onChange={(g) =>
            onChange({ field: spec.field, granularity: g as 'day' | 'week' | 'month' })
          }
          options={[
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
          ]}
        />
      ) : null}
    </div>
  );
}

function ColumnsEditor({
  catalog,
  columns,
  onChange,
}: {
  catalog: Catalog;
  columns: string[];
  onChange: (c: string[]) => void;
}) {
  const all = catalog.fields.filter((f) => f.column);
  const label = (f: string) => all.find((x) => x.field === f)?.label ?? f;
  const move = (i: number, d: -1 | 1) => {
    const next = [...columns];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="columns-editor">
      <h2 className="panel-title">Shown columns, in order</h2>
      <ol>
        {columns.map((c, i) => (
          <li key={c} className="column-item">
            <span>{label(c)}</span>
            <span className="actions">
              <button
                type="button"
                className="button button-secondary"
                disabled={i === 0}
                aria-label={`Move ${label(c)} earlier`}
                onClick={() => move(i, -1)}
              >
                Earlier
              </button>
              <button
                type="button"
                className="button button-secondary"
                disabled={i === columns.length - 1}
                aria-label={`Move ${label(c)} later`}
                onClick={() => move(i, 1)}
              >
                Later
              </button>
              <button
                type="button"
                className="button button-secondary"
                disabled={columns.length === 1}
                aria-label={`Hide ${label(c)}`}
                onClick={() => onChange(columns.filter((x) => x !== c))}
              >
                Hide
              </button>
            </span>
          </li>
        ))}
      </ol>
      <fieldset className="choices">
        <legend>Hidden columns</legend>
        {all
          .filter((f) => !columns.includes(f.field))
          .map((f) => (
            <button
              key={f.field}
              type="button"
              className="button button-secondary"
              disabled={columns.length >= catalog.bounds.columns}
              onClick={() => onChange([...columns, f.field])}
            >
              Show {f.label}
            </button>
          ))}
      </fieldset>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Dialogs
// -------------------------------------------------------------------------------------------------

function SaveAsDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give the view a name.');
    try {
      await onSave(name.trim());
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Dialog title="Save view" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <Field
          id="view-name"
          label="Name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          error={error || undefined}
        />
        <p className="hint">Saved views start personal. Share one when others should use it.</p>
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            Save view
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ShareDialog({
  ws,
  view,
  onClose,
  onDone,
}: {
  ws: string;
  view: SavedView;
  onClose: () => void;
  onDone: (v: SavedView, message: string) => void;
}) {
  const shellState = useWorkspaceShell();
  const stepUp = useStepUp();
  const brands = shellState?.context?.brands ?? [];
  const [scope, setScope] = useState<'workspace' | 'brand' | 'project'>(
    view.share?.scope ?? 'brand',
  );
  const [brand, setBrand] = useState(view.share?.brand?.id ?? brands[0]?.id ?? '');
  const [project, setProject] = useState(view.share?.project?.id ?? '');
  const [projects, setProjects] = useState<Array<{ value: string; label: string }>>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    views.options(ws, 'task', 'project').then(setProjects, () => setProjects([]));
  }, [ws]);
  const run = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'cancelled')) setError(describeError(e));
    }
  };
  const pinScope =
    view.share?.scope === 'workspace'
      ? 'workspace'
      : view.share?.scope === 'brand'
        ? 'brand'
        : null;
  return (
    <Dialog
      title="Share view"
      description="Sharing never shows anyone records they can't already see. Each person sees only what they have access to."
      onClose={onClose}
    >
      {error ? (
        <Banner tone="danger" title="That didn't work">
          {error}
        </Banner>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const v = await views.verb(
              ws,
              view.id,
              'share',
              {
                scope,
                ...(scope === 'brand' ? { brand } : {}),
                ...(scope === 'project' ? { project } : {}),
              },
              stepUp,
              view.version,
            );
            onDone(v, 'View shared.');
          });
        }}
      >
        <fieldset>
          <legend>Share with</legend>
          {(
            [
              ['workspace', 'Everyone in the workspace'],
              ['brand', 'People who can see a brand'],
              ['project', 'People who can see a project'],
            ] as const
          ).map(([v, l]) => (
            <label key={v} className="choice">
              <input
                type="radio"
                name="share-scope"
                checked={scope === v}
                onChange={() => setScope(v)}
              />{' '}
              {l}
            </label>
          ))}
        </fieldset>
        {scope === 'brand' ? (
          <SelectField
            id="share-brand"
            label="Brand"
            value={brand}
            onChange={setBrand}
            options={brands.map((b) => ({ value: b.id, label: b.name }))}
          />
        ) : null}
        {scope === 'project' ? (
          <SelectField
            id="share-project"
            label="Project"
            value={project}
            onChange={setProject}
            options={[{ value: '', label: 'Choose…' }, ...projects]}
          />
        ) : null}
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            Share
          </button>
        </div>
      </form>
      {view.share ? (
        <div className="actions">
          {pinScope ? (
            <>
              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  void run(async () => {
                    const v = await views.verb(
                      ws,
                      view.id,
                      'pin',
                      {
                        scope: pinScope,
                        ...(pinScope === 'brand' ? { brand: view.share!.brand!.id } : {}),
                      },
                      stepUp,
                    );
                    shellState?.refreshLists();
                    onDone(v, 'View pinned to navigation.');
                  })
                }
              >
                Pin to navigation
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  void run(async () => {
                    const v = await views.verb(
                      ws,
                      view.id,
                      'unpin',
                      {
                        scope: pinScope,
                        ...(pinScope === 'brand' ? { brand: view.share!.brand!.id } : {}),
                      },
                      stepUp,
                    );
                    shellState?.refreshLists();
                    onDone(v, 'View unpinned.');
                  })
                }
              >
                Unpin
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="button button-secondary"
            onClick={() =>
              void run(async () => {
                const v = await views.verb(ws, view.id, 'unshare', {}, stepUp, view.version);
                shellState?.refreshLists();
                onDone(v, 'View is personal again.');
              })
            }
          >
            Stop sharing
          </button>
        </div>
      ) : null}
    </Dialog>
  );
}

function DefaultDialog({
  ws,
  view,
  onClose,
  onDone,
}: {
  ws: string;
  view: SavedView;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const stepUp = useStepUp();
  const [error, setError] = useState('');
  const set = async (body: Parameters<typeof views.setDefault>[1], message: string) => {
    setError('');
    try {
      await views.setDefault(ws, body, stepUp);
      onDone(message);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'cancelled')) setError(describeError(e));
    }
  };
  return (
    <Dialog title="Default view" onClose={onClose}>
      {error ? (
        <Banner tone="danger" title="That didn't work">
          {error}
        </Banner>
      ) : null}
      <p>Your own default comes first, then a project's, then a brand's.</p>
      <div className="actions view-stack">
        <button
          type="button"
          className="button button-primary"
          onClick={() =>
            void set(
              { target: 'me', entity: view.entity, view: view.id },
              'This is now your default view.',
            )
          }
        >
          Make it my default
        </button>
        {view.share?.scope === 'brand' && view.share.brand ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() =>
              void set(
                {
                  target: 'brand',
                  brand: view.share!.brand!.id,
                  entity: view.entity,
                  view: view.id,
                },
                `This is now the default for ${view.share!.brand!.name}.`,
              )
            }
          >
            Make it the default for {view.share.brand.name}
          </button>
        ) : null}
        {view.share?.scope === 'project' && view.share.project ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() =>
              void set(
                {
                  target: 'project',
                  project: view.share!.project!.id,
                  entity: view.entity,
                  view: view.id,
                },
                `This is now the default for ${view.share!.project!.name}.`,
              )
            }
          >
            Make it the default for {view.share.project.name}
          </button>
        ) : null}
        <button
          type="button"
          className="button button-secondary"
          onClick={() =>
            void set(
              { target: 'me', entity: view.entity, view: null },
              'Your default view is cleared.',
            )
          }
        >
          Clear my default
        </button>
        <button type="button" className="button button-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

function ExportDialog({
  max,
  onClose,
  onExport,
}: {
  max: number;
  onClose: () => void;
  onExport: (format: 'csv' | 'json') => Promise<void>;
}) {
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [error, setError] = useState('');
  return (
    <Dialog
      title="Export view"
      description={`Exports exactly what you can see in this view now, up to ${max} rows.`}
      onClose={onClose}
    >
      {error ? (
        <Banner tone="danger" title="Export didn't work">
          {error}
        </Banner>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          onExport(format).catch((err: unknown) => setError(describeError(err)));
        }}
      >
        <fieldset>
          <legend>Format</legend>
          <label className="choice">
            <input
              type="radio"
              name="export-format"
              checked={format === 'csv'}
              onChange={() => setFormat('csv')}
            />{' '}
            CSV (spreadsheets)
          </label>
          <label className="choice">
            <input
              type="radio"
              name="export-format"
              checked={format === 'json'}
              onChange={() => setFormat('json')}
            />{' '}
            JSON
          </label>
        </fieldset>
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            Export
          </button>
        </div>
      </form>
    </Dialog>
  );
}
