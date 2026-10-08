import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Problem } from '../collab/shared.tsx';
import { projects as projectsClient, type ProjectSummary } from '../projects/client.ts';
import { Link, useRouter } from '../router.tsx';
import { BrandMarker } from '../shell/brand-marker.tsx';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { LoadProblem } from '../tenancy/resource.tsx';
import { markReadOnOpen, recordPath, useBellCounts } from './bell.tsx';
import {
  announceNotificationsChanged,
  markerOf,
  NOTIFICATION_TYPES,
  notifications,
  QUERY_MAX_CHARS,
  TABS,
  TYPE_LABEL,
  type ListQuery,
  type NotificationItem,
  type NotificationState,
  type NotificationType,
  type Tab,
} from './client.ts';
import {
  explainNotify,
  relativeTime,
  STATE_LABEL,
  useNow,
  useOnline,
  when,
  type Explained,
} from './shared.tsx';

/**
 * The notification centre (4B): everything addressed to the person, newest first, with tabs,
 * filters, search, grouping, and the four states. A change shows at once and is undone with a
 * message if the server refuses it (UXD-18). A row about something the person can no longer open
 * shows only the server's own words, its time, and state controls.
 */

type Row = NotificationItem & { gone?: boolean };
const NONE: Set<string> = new Set();

const isTab = (v: string | null): v is Tab => TABS.some(([t]) => t === v);
const isType = (v: string | null): v is NotificationType =>
  NOTIFICATION_TYPES.includes(v as NotificationType);

/** What a list shows for its filters: used to drop a row whose new state no longer belongs. */
interface Shape {
  tab: Tab;
  state: NotificationState | null;
  q: string;
  unread: boolean;
}
function belongs(shape: Shape, state: NotificationState): boolean {
  if (shape.unread && state !== 'unread') return false;
  if (shape.state) return state === shape.state;
  if (shape.tab === 'saved') return state === 'saved';
  if (shape.q) return true;
  return state !== 'dismissed';
}

const VERB: Record<NotificationState, string> = {
  unread: 'marking it unread',
  read: 'marking it read',
  saved: 'saving it',
  dismissed: 'dismissing it',
};
const DONE: Record<NotificationState, string> = {
  unread: 'Marked unread.',
  read: 'Marked read.',
  saved: 'Saved.',
  dismissed: 'Dismissed.',
};

interface Entry {
  key: string;
  rows: Row[];
  cursor: string | null;
  status: 'ready' | 'failed';
  error: unknown;
}

export function NotificationCentre({ ws }: { ws: string }) {
  const { path, search, navigate } = useRouter();
  const shell = useWorkspaceShell();
  const online = useOnline();
  const now = useNow();
  const { counts } = useBellCounts(ws);
  const headingId = useId();

  const tab: Tab = isTab(search.get('tab')) ? (search.get('tab') as Tab) : 'all';
  const type = isType(search.get('type')) ? search.get('type')! : '';
  const brand = search.get('brand') ?? '';
  const project = search.get('project') ?? '';
  const unread = search.get('unread') === 'true';
  const group = search.get('group') === 'true';
  const dismissed = search.get('state') === 'dismissed';
  const q = (search.get('q') ?? '').slice(0, QUERY_MAX_CHARS);

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    navigate(s ? `${path}?${s}` : path, { replace: true });
  };

  const query: ListQuery = {
    tab,
    ...(dismissed ? { state: 'dismissed' as const } : {}),
    ...(type ? { type } : {}),
    ...(brand ? { brand } : {}),
    ...(project ? { project } : {}),
    ...(unread ? { unread: true } : {}),
    ...(q ? { q } : {}),
    ...(group ? { group: true } : {}),
  };
  const key = `${ws}|${JSON.stringify(query)}`;
  const shape: Shape = { tab, state: dismissed ? 'dismissed' : null, q, unread };

  // ---- The list -------------------------------------------------------------------------------
  const [entry, setEntry] = useState<Entry | null>(null);
  const [nonce, setNonce] = useState(0);
  const [more, setMore] = useState<{ busy: boolean; e: Explained | null }>({
    busy: false,
    e: null,
  });
  const current = entry?.key === key ? entry : null;
  const rows = current?.rows ?? [];
  const cursor = current?.cursor ?? null;
  const status = current?.status ?? 'loading';
  const setRows = useCallback(
    (update: (rows: Row[]) => Row[]) =>
      setEntry((e) => (e && e.key === key ? { ...e, rows: update(e.rows) } : e)),
    [key],
  );

  useEffect(() => {
    let active = true;
    notifications.list(ws, query).then(
      (r) => {
        if (!active) return;
        setEntry({
          key,
          rows: r.data,
          cursor: r.page.has_more ? (r.page.next_cursor ?? null) : null,
          status: 'ready',
          error: null,
        });
        setMore({ busy: false, e: null });
      },
      (error: unknown) =>
        active && setEntry({ key, rows: [], cursor: null, status: 'failed', error }),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  const reload = () => {
    setProblem(null);
    setEntry(null);
    setNonce((n) => n + 1);
  };

  const loadMore = async () => {
    if (!cursor) return;
    setMore({ busy: true, e: null });
    try {
      const r = await notifications.list(ws, { ...query, cursor });
      setEntry((e) =>
        e && e.key === key
          ? {
              ...e,
              rows: [...e.rows, ...r.data.filter((n) => !e.rows.some((x) => x.id === n.id))],
              cursor: r.page.has_more ? (r.page.next_cursor ?? null) : null,
            }
          : e,
      );
      setMore({ busy: false, e: null });
    } catch (err) {
      setMore({ busy: false, e: explainNotify(err, 'loading more') });
    }
  };

  // ---- Filters' choices ---------------------------------------------------------------------------
  const brands = shell?.context?.brands ?? [];
  const [projectList, setProjectList] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    let active = true;
    projectsClient.list(ws).then(
      (r) => active && setProjectList(r.data),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [ws]);

  // ---- Changing state: at once, undone with a message if refused -----------------------------------
  const [problem, setProblem] = useState<{ e: Explained; retry: (() => void) | null } | null>(null);
  const [said, setSaid] = useState('');
  // A selection belongs to one list: a new list (filters, reload) starts with nothing selected.
  const listId = `${key}|${nonce}`;
  const [sel, setSel] = useState<{ list: string; ids: Set<string> }>({
    list: '',
    ids: new Set(),
  });
  const selected = sel.list === listId ? sel.ids : NONE;
  const setSelected = (f: (s: Set<string>) => Set<string>) =>
    setSel((cur) => ({ list: listId, ids: f(cur.list === listId ? cur.ids : new Set()) }));
  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    if (!focusAfter.current) return;
    const id = focusAfter.current;
    focusAfter.current = null;
    document.getElementById(id)?.focus();
  });

  const change = async (targets: Row[], next: NotificationState, fromToolbar = false) => {
    if (!targets.length) return;
    setProblem(null);
    const before = rows;
    const ids = new Set(targets.map((t) => t.id));
    const after = before.flatMap((r): Row[] => {
      if (!ids.has(r.id)) return [r];
      return belongs(shape, next) ? [{ ...r, state: next }] : [];
    });
    if (after.length < before.length) {
      const firstGone = before.findIndex((r) => ids.has(r.id));
      const neighbour = after[firstGone] ?? after[firstGone - 1];
      focusAfter.current = fromToolbar || !neighbour ? headingId : `ntf-row-${neighbour.id}`;
    }
    setRows(() => after);
    setSelected((s) => new Set([...s].filter((id) => !ids.has(id))));
    try {
      const wide = targets.some((t) => t.group_ids?.length);
      if (targets.length === 1 && !wide) await notifications.setState(ws, targets[0]!.id, next);
      else
        await notifications.bulk(
          ws,
          { ids: targets.flatMap((t) => (t.group_ids?.length ? t.group_ids : [t.id])) },
          next,
        );
      announceNotificationsChanged();
      setSaid(
        targets.length > 1 ? `${DONE[next].slice(0, -1)} for ${targets.length}.` : DONE[next],
      );
    } catch (err) {
      const e = explainNotify(err, VERB[next]);
      // Put every row back where it was (a refused change never leaves the list lying).
      setRows((cur) => {
        const out = [...cur];
        before.forEach((orig, index) => {
          if (!ids.has(orig.id)) return;
          const restored: Row = e.kind === 'gone' ? { ...orig, gone: true } : orig;
          const at = out.findIndex((r) => r.id === orig.id);
          if (at >= 0) out[at] = restored;
          else out.splice(Math.min(index, out.length), 0, restored);
        });
        return out;
      });
      setSelected(() => new Set());
      setProblem({
        e:
          e.kind === 'gone'
            ? {
                ...e,
                message:
                  'That notification is no longer available to you. Refresh the list to update it.',
              }
            : { ...e, message: `We couldn't change that. ${e.message} It is back as it was.` },
        retry: e.retryable ? () => void change(targets, next, fromToolbar) : null,
      });
    }
  };

  const markAll = async () => {
    setProblem(null);
    try {
      const r = await notifications.bulk(ws, { all: { tab, ...(type ? { type } : {}) } }, 'read');
      announceNotificationsChanged();
      setSaid(
        r.updated === 1 ? 'Marked 1 notification read.' : `Marked ${r.updated} notifications read.`,
      );
      reload();
    } catch (err) {
      setProblem({
        e: explainNotify(err, 'marking them read'),
        retry: () => void markAll(),
      });
    }
  };

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const chosen = rows.filter((r) => selected.has(r.id) && !r.gone);

  const filtered = Boolean(type || brand || project || unread || q || dismissed);
  const tabLabel = TABS.find(([t]) => t === tab)![1];
  const count = rows.length;
  const announced =
    status !== 'ready'
      ? ''
      : count === 0
        ? q
          ? `No notifications match "${q}".`
          : 'No notifications to show.'
        : `${count} ${count === 1 ? 'notification' : 'notifications'}${cursor ? ' shown, more available' : ''}${q ? ` match "${q}"` : ''}.`;
  const tabCount = (t: Tab): number =>
    !counts
      ? 0
      : t === 'all'
        ? counts.unread
        : t === 'mentions'
          ? counts.mentions_unread
          : t === 'reviews'
            ? counts.reviews_unread
            : 0;

  return (
    <>
      <nav className="tabs" aria-label="Notifications">
        <ul>
          {TABS.map(([id, label]) => (
            <li key={id}>
              <Link to={`${path}?tab=${id}`} aria-current={tab === id ? 'page' : undefined}>
                {label}
                {tabCount(id) > 0 ? (
                  <span className="badge badge-info">
                    {tabCount(id) > 99 ? '99+' : tabCount(id)}
                    <span className="visually-hidden"> unread</span>
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <section className="card ntf-controls" aria-label="Search and filters">
        <SearchBox key={q} q={q} onSearch={(v) => setParams({ q: v })} />
        <div className="ntf-filters" role="group" aria-label="Filters">
          <div className="field">
            <label htmlFor="ntf-type">Type</label>
            <select
              id="ntf-type"
              value={type}
              onChange={(e) => setParams({ type: e.target.value })}
            >
              <option value="">All types</option>
              {NOTIFICATION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ntf-brand">Brand</label>
            <select
              id="ntf-brand"
              value={brand}
              onChange={(e) => setParams({ brand: e.target.value })}
            >
              <option value="">All brands</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
              {brand && !brands.some((b) => b.id === brand) ? (
                <option value={brand}>Selected brand</option>
              ) : null}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ntf-project">Project</label>
            <select
              id="ntf-project"
              value={project}
              onChange={(e) => setParams({ project: e.target.value })}
            >
              <option value="">All projects</option>
              {projectList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              {project && !projectList.some((p) => p.id === project) ? (
                <option value={project}>Selected project</option>
              ) : null}
            </select>
          </div>
          <label className="choice">
            <input
              type="checkbox"
              checked={unread}
              onChange={(e) => setParams({ unread: e.target.checked ? 'true' : null })}
            />
            Unread only
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={group}
              onChange={(e) => setParams({ group: e.target.checked ? 'true' : null })}
            />
            Group similar
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={dismissed}
              onChange={(e) => setParams({ state: e.target.checked ? 'dismissed' : null })}
            />
            Show dismissed
          </label>
        </div>
        {filtered ? (
          <p>
            <button
              type="button"
              className="button button-ghost"
              onClick={() =>
                setParams({
                  type: null,
                  brand: null,
                  project: null,
                  unread: null,
                  q: null,
                  state: null,
                })
              }
            >
              Clear filters
            </button>
          </p>
        ) : null}
      </section>

      <section className="card" aria-labelledby={headingId}>
        <h2 id={headingId} tabIndex={-1}>
          {dismissed ? 'Dismissed' : tabLabel}
        </h2>
        <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {announced}
        </p>
        {!online ? (
          <p className="collab-offline" role="status">
            <span aria-hidden="true">! </span>
            You're offline. What you see may be out of date, and changes can't be saved until you're
            back online.
          </p>
        ) : null}
        <p className="visually-hidden" role="status" aria-live="polite">
          {said}
        </p>
        <Problem problem={problem?.e ?? null} onRetry={problem?.retry ?? undefined}>
          {problem?.e.kind === 'gone' ? (
            <button type="button" className="button button-secondary" onClick={reload}>
              Refresh the list
            </button>
          ) : null}
        </Problem>

        {status === 'ready' && rows.length ? (
          <div className="ntf-toolbar" role="group" aria-label="Actions for several notifications">
            <label className="choice">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(e) =>
                  setSelected(() =>
                    e.target.checked
                      ? new Set(rows.filter((r) => !r.gone).map((r) => r.id))
                      : new Set(),
                  )
                }
              />
              Select all shown
            </label>
            <span className="hint" aria-live="polite">
              {chosen.length ? `${chosen.length} selected` : ''}
            </span>
            <button
              type="button"
              className="button button-secondary"
              disabled={!chosen.length}
              onClick={() => void change(chosen, 'read', true)}
            >
              Mark selected read
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={!chosen.length}
              onClick={() => void change(chosen, 'dismissed', true)}
            >
              Dismiss selected
            </button>
            {tab !== 'saved' && !filtered ? (
              <button type="button" className="button button-ghost" onClick={() => void markAll()}>
                Mark all read
              </button>
            ) : null}
          </div>
        ) : null}

        {status === 'loading' ? (
          <p className="loading" role="status">
            Loading notifications…
          </p>
        ) : null}
        {status === 'failed' ? (
          <LoadProblem error={current?.error} onRetry={reload} what="notifications" />
        ) : null}
        {status === 'ready' && !rows.length ? (
          <p className="empty">
            {filtered
              ? 'No notifications match these filters.'
              : tab === 'mentions'
                ? 'No mentions yet. When someone mentions you, it shows up here.'
                : tab === 'reviews'
                  ? 'No review notifications yet.'
                  : tab === 'saved'
                    ? 'Nothing saved. Choose Save on a notification to keep it here.'
                    : "You're all caught up."}
          </p>
        ) : null}
        {rows.length ? (
          <ul
            className="plain-list ntf-list"
            aria-label={`${dismissed ? 'Dismissed' : tabLabel} notifications`}
          >
            {rows.map((n) => (
              <NotificationRow
                key={n.id}
                ws={ws}
                n={n}
                now={now}
                checked={selected.has(n.id)}
                onCheck={(on) => toggle(n.id, on)}
                onChange={(next) => void change([n], next)}
              />
            ))}
          </ul>
        ) : null}
        <Problem problem={more.e} onRetry={() => void loadMore()} busy={more.busy} />
        {cursor ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={more.busy}
            onClick={() => void loadMore()}
          >
            {more.busy ? 'Loading…' : 'Load more notifications'}
          </button>
        ) : null}
      </section>
    </>
  );
}

function NotificationRow({
  ws,
  n,
  now,
  checked,
  onCheck,
  onChange,
}: {
  ws: string;
  n: Row;
  now: number;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onChange: (next: NotificationState) => void;
}) {
  const sid = useId();
  const [open, setOpen] = useState(false);
  const similar = (n.group_count ?? 1) - 1;
  const st = STATE_LABEL[n.state]!;
  const time = (
    <time className="ntf-time" dateTime={n.last_occurred_at} title={when(n.last_occurred_at)}>
      {relativeTime(n.last_occurred_at, now)}
    </time>
  );
  if (n.gone)
    return (
      <li id={`ntf-row-${n.id}`} tabIndex={-1} className="ntf-row ntf-gone">
        <p>This notification is no longer available to you.</p>
      </li>
    );
  const counted = n.occurrences > 1 && !n.summary.includes(`${n.occurrences} times`);
  return (
    <li
      id={`ntf-row-${n.id}`}
      tabIndex={-1}
      className={`ntf-row${n.state === 'unread' ? ' ntf-unread' : ''}${n.available ? '' : ' ntf-unavailable'}`}
    >
      <input
        type="checkbox"
        className="ntf-check"
        checked={checked}
        aria-label={`Select: ${n.summary}`}
        onChange={(e) => onCheck(e.target.checked)}
      />
      <div className="ntf-main">
        <p className="ntf-summary" id={sid}>
          {n.state !== 'read' ? (
            <span className={`ntf-state ntf-state-${n.state}`}>
              <span aria-hidden="true">{st.icon} </span>
              {st.text}
            </span>
          ) : null}{' '}
          {n.summary}
        </p>
        <p className="ntf-meta">
          {n.available && n.brand ? <BrandMarker marker={markerOf(n.brand)} size={16} /> : null}
          {n.available && n.record ? (
            <Link
              className="record-link"
              to={recordPath(ws, n.record)}
              onClick={() => markReadOnOpen(ws, n)}
            >
              {n.record.title}
            </Link>
          ) : null}
          {n.available && n.record?.archived ? <span className="badge">Archived</span> : null}
          {n.available && n.project ? <span className="hint">in {n.project.name}</span> : null}
          {n.available && n.actor ? <span className="hint">from {n.actor.name}</span> : null}
          {counted ? <span className="badge">{n.occurrences} times</span> : null}
          {time}
        </p>
        {similar > 0 ? (
          <div>
            <button
              type="button"
              className="button button-ghost ntf-similar"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              +{similar} similar
            </button>
            {open && n.group_ids ? (
              <SimilarItems ws={ws} ids={n.group_ids.filter((id) => id !== n.id)} now={now} />
            ) : null}
          </div>
        ) : null}
      </div>
      <div role="group" aria-labelledby={sid} className="ntf-actions">
        {n.state === 'dismissed' ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => onChange('read')}
          >
            Restore
          </button>
        ) : (
          <>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onChange(n.state === 'unread' ? 'read' : 'unread')}
            >
              {n.state === 'unread' ? 'Mark read' : 'Mark unread'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              aria-pressed={n.state === 'saved'}
              onClick={() => onChange(n.state === 'saved' ? 'read' : 'saved')}
            >
              {n.state === 'saved' ? 'Unsave' : 'Save'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onChange('dismissed')}
            >
              Dismiss
            </button>
          </>
        )}
        {similar > 0 ? <span className="hint">Applies to all {similar + 1} similar</span> : null}
      </div>
    </li>
  );
}

const SIMILAR_MAX = 10;

/** The other notifications folded into a group, read one by one so each is checked for access now. */
function SimilarItems({ ws, ids, now }: { ws: string; ids: string[]; now: number }) {
  const shown = ids.slice(0, SIMILAR_MAX);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  useEffect(() => {
    let active = true;
    Promise.allSettled(shown.map((id) => notifications.get(ws, id))).then((r) => {
      if (!active) return;
      setItems(r.flatMap((x) => (x.status === 'fulfilled' ? [x.value] : [])));
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, ids.join(',')]);
  if (!items) return <p className="loading">Loading similar notifications…</p>;
  return (
    <>
      <ul className="plain-list ntf-similar-list" aria-label="Similar notifications">
        {items.map((s) => (
          <li key={s.id}>
            {s.summary}{' '}
            <time
              className="ntf-time"
              dateTime={s.last_occurred_at}
              title={when(s.last_occurred_at)}
            >
              {relativeTime(s.last_occurred_at, now)}
            </time>
          </li>
        ))}
      </ul>
      {ids.length > shown.length ? (
        <p className="hint">and {ids.length - shown.length} more</p>
      ) : null}
    </>
  );
}

/** The search form: typed text is local until submitted (keyed by the applied search). */
function SearchBox({ q, onSearch }: { q: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(q);
  return (
    <form
      role="search"
      aria-label="Find notifications"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSearch(text.trim().slice(0, QUERY_MAX_CHARS));
      }}
      className="ntf-search"
    >
      <div className="field">
        <label htmlFor="ntf-q">Search notifications</label>
        <p className="hint" id="ntf-q-hint">
          Searches the item, the person, and the kind of notification. Up to {QUERY_MAX_CHARS}{' '}
          characters.
        </p>
        <input
          id="ntf-q"
          type="search"
          value={text}
          maxLength={QUERY_MAX_CHARS}
          aria-describedby="ntf-q-hint"
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="actions">
        <button type="submit" className="button button-secondary">
          Search
        </button>
        {q ? (
          <button type="button" className="button button-ghost" onClick={() => onSearch('')}>
            Clear search
          </button>
        ) : null}
      </div>
    </form>
  );
}
