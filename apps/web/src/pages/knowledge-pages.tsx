import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Problem, type Explained } from '../collab/shared.tsx';
import { documents, DOC_TYPES, type DocListFilters, type DocSummary } from '../docs/client.ts';
import {
  DocRow,
  HonestAbsences,
  NewDocumentDialog,
  StateBadges,
  docHref,
  explainDoc,
} from '../docs/shared.tsx';
import { Link, useRouter } from '../router.tsx';
import { BrandMarker, summaryMarker } from '../shell/brand-marker.tsx';
import { useWidthClass } from '../shell/width.ts';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { collab as people } from '../tenancy/client.ts';
import { useOnline } from '../collab/shared.tsx';
import { Banner } from '../ui/feedback.tsx';
import { Page } from '../ui/layout.tsx';
import type { BrandMarkerData } from '../shell/client.ts';

/**
 * Knowledge (4C): the tree of pages, grouped by Workspace and then by brand. Roots load first and
 * children load when a page is opened. Filters switch to a flat list. The tree follows the treeview
 * pattern: one tab stop, arrow keys move and open and close, Enter opens the page.
 */

interface TreeNode {
  d: DocSummary;
  /** null = not loaded yet */
  kids: string[] | null;
  next: string | null;
  open: boolean;
  loading: boolean;
  error: Explained | null;
  group: string;
  parent: string | null;
}
interface Group {
  id: string;
  label: string;
  marker: BrandMarkerData | null;
  roots: string[] | null;
  next: string | null;
  loading: boolean;
  error: Explained | null;
}
type Row =
  | { kind: 'node'; id: string; level: number }
  | { kind: 'more'; parent: string | 'root'; level: number; label: string };

const PAGE = 50;

export function KnowledgePage({ ws }: { ws: string }) {
  const shell = useWorkspaceShell();
  const ctx = shell?.context ?? null;
  const { search, navigate, path } = useRouter();
  const online = useOnline();
  const width = useWidthClass();
  const guest = ctx?.principal === 'guest';

  const brandIds = useMemo(() => {
    const s = ctx?.scope;
    if (!s) return [] as string[];
    return s.kind === 'brand'
      ? [s.brand_id]
      : s.kind === 'brands' || s.kind === 'all'
        ? s.brand_ids
        : [];
  }, [ctx?.scope]);
  const brandOptions = useMemo(
    () => (ctx?.brands ?? []).filter((b) => brandIds.includes(b.id)),
    [ctx?.brands, brandIds],
  );

  const [type, setType] = useState(search.get('type') ?? '');
  const [state, setState] = useState(search.get('state') ?? '');
  const [owner, setOwner] = useState(search.get('owner') ?? '');
  const [q, setQ] = useState(search.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [members, setMembers] = useState<Array<{ id: string; name: string; me: boolean }> | null>(
    null,
  );
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim().slice(0, 100)), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (guest) return;
    let active = true;
    people.people(ws, { state: 'active' }).then(
      (list) =>
        active &&
        setMembers(
          list
            .filter((m) => m.kind === 'member')
            .map((m) => ({ id: m.id, name: m.display_name, me: m.is_you })),
        ),
      () => active && setMembers(null),
    );
    return () => {
      active = false;
    };
  }, [ws, guest]);

  const filtering = !!(type || state || owner || debounced);
  // The filters live in the address, so a filtered list can be shared or reloaded.
  useEffect(() => {
    const next = new URLSearchParams(search);
    for (const [k, v] of [
      ['type', type],
      ['state', state],
      ['owner', owner],
      ['q', debounced],
    ] as const) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const s = next.toString();
    if (s !== search.toString()) navigate(`${path}${s ? `?${s}` : ''}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, state, owner, debounced]);

  return (
    <Page
      title="Knowledge"
      wide
      lead="Pages, procedures, and decisions, kept in versions. Pages belong to the workspace or to one brand."
      actions={
        guest ? null : (
          <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
            New page
          </button>
        )
      }
    >
      {!online ? (
        <Banner tone="warning" title="You're offline">
          Pages already on screen stay readable. Loading more or creating a page needs a connection.
        </Banner>
      ) : null}
      <form
        className="doc-filters card"
        role="search"
        aria-label="Filter pages"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="field">
          <label htmlFor="kn-q">Search titles</label>
          <input
            id="kn-q"
            type="search"
            value={q}
            maxLength={100}
            autoComplete="off"
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="kn-type">Type</label>
          <select id="kn-type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {DOC_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="kn-state">State</label>
          <select id="kn-state" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Any state</option>
            <option value="draft">Draft</option>
            <option value="current">Current</option>
            <option value="stale">Stale</option>
            <option value="overdue">Review overdue</option>
          </select>
        </div>
        {members && members.length ? (
          <div className="field">
            <label htmlFor="kn-owner">Owner</label>
            <select id="kn-owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Anyone</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.me ? `${m.name} (you)` : m.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {filtering ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              setType('');
              setState('');
              setOwner('');
              setQ('');
              setDebounced('');
            }}
          >
            Clear filters
          </button>
        ) : null}
      </form>
      {filtering ? (
        <FlatList
          ws={ws}
          filters={{ type, state, owner, q: debounced }}
          compact={width === 'compact'}
        />
      ) : (
        <TreeView
          ws={ws}
          guest={!!guest}
          groups={[
            { id: 'workspace', label: 'Workspace', marker: { kind: 'workspace' } },
            ...brandOptions.map((b) => ({ id: b.id, label: b.name, marker: summaryMarker(b) })),
          ]}
        />
      )}
      <HonestAbsences />
      {creating ? (
        <NewDocumentDialog
          ws={ws}
          brands={brandOptions.map((b) => ({ id: b.id, name: b.name }))}
          {...(brandOptions.length === 1 ? { defaultBrand: brandOptions[0]!.id } : {})}
          onClose={() => setCreating(false)}
          onCreated={() => setCreating(false)}
        />
      ) : null}
    </Page>
  );
}

// -----------------------------------------------------------------------------------------------
// Flat list (filters)
// -----------------------------------------------------------------------------------------------

function FlatList({
  ws,
  filters,
}: {
  ws: string;
  filters: { type: string; state: string; owner: string; q: string };
  compact: boolean;
}) {
  const key = JSON.stringify(filters);
  const [entry, setEntry] = useState<{
    key: string;
    nonce: number;
    rows: DocSummary[] | null;
    next: string | null;
    failed: Explained | null;
  }>({ key, nonce: 0, rows: null, next: null, failed: null });
  const [more, setMore] = useState<{ busy: boolean; e: Explained | null }>({
    busy: false,
    e: null,
  });
  const [nonce, setNonce] = useState(0);
  const current = entry.key === key && entry.nonce === nonce;
  const rows = current ? entry.rows : null;
  const next = current ? entry.next : null;
  const failed = current ? entry.failed : null;
  const f = useMemo<DocListFilters>(
    () => ({
      scope: 'all',
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.state ? { state: filters.state } : {}),
      ...(filters.owner ? { owner: filters.owner } : {}),
      ...(filters.q ? { q: filters.q } : {}),
      limit: PAGE,
    }),
    [filters.type, filters.state, filters.owner, filters.q],
  );
  useEffect(() => {
    const c = new AbortController();
    documents.list(ws, f, c.signal).then(
      (r) =>
        setEntry({
          key,
          nonce,
          rows: r.data,
          next: r.page.has_more ? (r.page.next_cursor ?? null) : null,
          failed: null,
        }),
      (err: unknown) => {
        if (c.signal.aborted) return;
        setEntry({
          key,
          nonce,
          rows: null,
          next: null,
          failed: { ...explainDoc(err, 'loading pages'), retryable: true },
        });
      },
    );
    return () => c.abort();
  }, [ws, key, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadMore = async () => {
    if (!next) return;
    setMore({ busy: true, e: null });
    try {
      const r = await documents.list(ws, { ...f, cursor: next });
      setEntry((cur) => ({
        ...cur,
        rows: [...(cur.rows ?? []), ...r.data],
        next: r.page.has_more ? (r.page.next_cursor ?? null) : null,
      }));
      setMore({ busy: false, e: null });
    } catch (err) {
      setMore({ busy: false, e: { ...explainDoc(err, 'loading more'), retryable: true } });
    }
  };
  return (
    <section className="card" aria-labelledby="kn-results-h">
      <h2 id="kn-results-h">Matching pages</h2>
      <p className="visually-hidden" role="status" aria-live="polite">
        {rows
          ? rows.length === 0
            ? 'No pages match.'
            : `${rows.length} ${rows.length === 1 ? 'page' : 'pages'} shown${next ? ', more available' : ''}.`
          : failed
            ? ''
            : 'Searching…'}
      </p>
      <p className="hint">Searches every page you can see, across the workspace and your brands.</p>
      {rows === null && !failed ? <p className="loading">Loading pages…</p> : null}
      <Problem problem={failed} onRetry={() => setNonce((n) => n + 1)} />
      {rows && rows.length === 0 ? (
        <p>No pages match these filters. Clear a filter to see more.</p>
      ) : null}
      {rows && rows.length ? (
        <ul className="plain-list record-rows" aria-label="Pages">
          {rows.map((d) => (
            <DocRow key={d.id} ws={ws} d={d} showPlace />
          ))}
        </ul>
      ) : null}
      {next ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={more.busy}
          onClick={() => void loadMore()}
        >
          {more.busy ? 'Loading…' : 'Load more pages'}
        </button>
      ) : null}
      <Problem problem={more.e} onRetry={() => void loadMore()} />
    </section>
  );
}

// -----------------------------------------------------------------------------------------------
// Tree
// -----------------------------------------------------------------------------------------------

function TreeView({
  ws,
  guest,
  groups: defs,
}: {
  ws: string;
  guest: boolean;
  groups: Array<{ id: string; label: string; marker: BrandMarkerData }>;
}) {
  const [nodes, setNodes] = useState<Record<string, TreeNode>>({});
  const [groups, setGroups] = useState<Record<string, Group>>({});
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const defKey = defs.map((d) => d.id).join(',');

  const absorb = useCallback((list: DocSummary[], group: string, parent: string | null) => {
    setNodes((cur) => {
      const out = { ...cur };
      for (const d of list)
        out[d.id] = {
          d,
          kids: out[d.id]?.kids ?? null,
          next: out[d.id]?.next ?? null,
          open: out[d.id]?.open ?? false,
          loading: false,
          error: null,
          group,
          parent,
        };
      return out;
    });
  }, []);

  const loadRoots = useCallback(
    async (gid: string, cursor?: string) => {
      setGroups((g) => ({ ...g, [gid]: { ...g[gid]!, loading: true, error: null } }));
      try {
        const r = await documents.list(ws, {
          scope: gid,
          parent: 'root',
          attached: 'none',
          limit: PAGE,
          ...(cursor ? { cursor } : {}),
        });
        absorb(r.data, gid, null);
        setGroups((g) => ({
          ...g,
          [gid]: {
            ...g[gid]!,
            roots: [...(cursor ? (g[gid]!.roots ?? []) : []), ...r.data.map((d) => d.id)],
            next: r.page.has_more ? (r.page.next_cursor ?? null) : null,
            loading: false,
          },
        }));
      } catch (err) {
        setGroups((g) => ({
          ...g,
          [gid]: {
            ...g[gid]!,
            loading: false,
            error: { ...explainDoc(err, 'loading pages'), retryable: true },
          },
        }));
      }
    },
    [ws, absorb],
  );

  useEffect(() => {
    setNodes({});
    setGroups(
      Object.fromEntries(
        defs.map((d) => [
          d.id,
          {
            id: d.id,
            label: d.label,
            marker: d.marker,
            roots: null,
            next: null,
            loading: true,
            error: null,
          } as Group,
        ]),
      ),
    );
    for (const d of defs) void loadRoots(d.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, defKey]);

  const loadKids = useCallback(
    async (id: string, cursor?: string) => {
      setNodes((cur) => ({ ...cur, [id]: { ...cur[id]!, loading: true, error: null } }));
      try {
        const r = await documents.list(ws, {
          parent: id,
          limit: PAGE,
          ...(cursor ? { cursor } : {}),
        });
        const group = nodesRef.current[id]!.group;
        absorb(r.data, group, id);
        setNodes((cur) => ({
          ...cur,
          [id]: {
            ...cur[id]!,
            kids: [...(cursor ? (cur[id]!.kids ?? []) : []), ...r.data.map((d) => d.id)],
            next: r.page.has_more ? (r.page.next_cursor ?? null) : null,
            loading: false,
          },
        }));
      } catch (err) {
        setNodes((cur) => ({
          ...cur,
          [id]: {
            ...cur[id]!,
            loading: false,
            error: { ...explainDoc(err, 'loading subpages'), retryable: true },
          },
        }));
      }
    },
    [ws, absorb],
  );

  const toggle = (id: string, open: boolean) => {
    setNodes((cur) => ({ ...cur, [id]: { ...cur[id]!, open } }));
    if (open && nodesRef.current[id]!.kids === null) void loadKids(id);
  };

  return (
    <div className="knowledge-groups">
      {guest ? (
        <p className="hint">
          You can open pages that were shared with you from Shared with me. The tree shows only what
          you may browse.
        </p>
      ) : null}
      {defs.map((d) => {
        const g = groups[d.id];
        return (
          <section key={d.id} className="card knowledge-group" aria-labelledby={`kg-${d.id}`}>
            <h2 id={`kg-${d.id}`} className="knowledge-group-title">
              <BrandMarker marker={d.marker} size={20} /> <span>{d.label}</span>
            </h2>
            {!g || (g.roots === null && g.loading) ? (
              <p className="loading">Loading pages…</p>
            ) : null}
            {g?.error ? <Problem problem={g.error} onRetry={() => void loadRoots(d.id)} /> : null}
            {g?.roots && g.roots.length === 0 ? (
              <p>
                {d.id === 'workspace'
                  ? 'No workspace-level pages yet.'
                  : `No pages for ${d.label} yet.`}
                {guest ? '' : ' Use New page to start one.'}
              </p>
            ) : null}
            {g?.roots && g.roots.length ? (
              <Tree
                ws={ws}
                label={`${d.label} pages`}
                group={g}
                nodes={nodes}
                onToggle={toggle}
                onMoreRoots={() => void loadRoots(d.id, g.next!)}
                onMoreKids={(id) => void loadKids(id, nodesRef.current[id]!.next!)}
                onRetryKids={(id) => void loadKids(id)}
              />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function flatten(group: Group, nodes: Record<string, TreeNode>): Row[] {
  const out: Row[] = [];
  const walk = (ids: string[], level: number) => {
    for (const id of ids) {
      const n = nodes[id];
      if (!n) continue;
      out.push({ kind: 'node', id, level });
      if (n.open && n.kids) {
        walk(n.kids, level + 1);
        if (n.next)
          out.push({
            kind: 'more',
            parent: id,
            level: level + 1,
            label: `Load more pages under ${n.d.title || 'Untitled'}`,
          });
      }
    }
  };
  walk(group.roots ?? [], 1);
  if (group.next) out.push({ kind: 'more', parent: 'root', level: 1, label: 'Load more pages' });
  return out;
}

function Tree({
  ws,
  label,
  group,
  nodes,
  onToggle,
  onMoreRoots,
  onMoreKids,
  onRetryKids,
}: {
  ws: string;
  label: string;
  group: Group;
  nodes: Record<string, TreeNode>;
  onToggle: (id: string, open: boolean) => void;
  onMoreRoots: () => void;
  onMoreKids: (id: string) => void;
  onRetryKids: (id: string) => void;
}) {
  const { navigate } = useRouter();
  const rows = useMemo(() => flatten(group, nodes), [group, nodes]);
  const rowKey = (r: Row) => (r.kind === 'node' ? r.id : `more:${r.parent}`);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const active = rows.some((r) => rowKey(r) === focusKey)
    ? focusKey!
    : rows[0]
      ? rowKey(rows[0])
      : null;
  const refs = useRef(new Map<string, HTMLLIElement>());
  const focus = (k: string | undefined) => {
    if (!k) return;
    setFocusKey(k);
    refs.current.get(k)?.focus();
  };
  const keyDown = (e: KeyboardEvent<HTMLLIElement>, r: Row, i: number) => {
    const n = r.kind === 'node' ? nodes[r.id] : null;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focus(rows[i + 1] && rowKey(rows[i + 1]!));
        break;
      case 'ArrowUp':
        e.preventDefault();
        focus(rows[i - 1] && rowKey(rows[i - 1]!));
        break;
      case 'Home':
        e.preventDefault();
        focus(rowKey(rows[0]!));
        break;
      case 'End':
        e.preventDefault();
        focus(rowKey(rows[rows.length - 1]!));
        break;
      case 'ArrowRight':
        if (!n) break;
        e.preventDefault();
        if (n.error) onRetryKids(n.d.id);
        else if (n.d.has_children && !n.open) onToggle(n.d.id, true);
        else if (n.open && rows[i + 1] && rows[i + 1]!.level > r.level) focus(rowKey(rows[i + 1]!));
        break;
      case 'ArrowLeft':
        if (!n) break;
        e.preventDefault();
        if (n.open) onToggle(n.d.id, false);
        else if (n.parent) focus(n.parent);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (r.kind === 'more') {
          if (r.parent === 'root') onMoreRoots();
          else onMoreKids(r.parent);
        } else if (e.key === 'Enter') navigate(docHref(ws, r.id));
        else if (n?.d.has_children) onToggle(n.d.id, !n.open);
        break;
    }
  };
  return (
    <ul role="tree" aria-label={label} className="doc-tree">
      {rows.map((r, i) => {
        const k = rowKey(r);
        const common = {
          ref: (el: HTMLLIElement | null) => {
            if (el) refs.current.set(k, el);
            else refs.current.delete(k);
          },
          tabIndex: active === k ? 0 : -1,
          onFocus: () => setFocusKey(k),
          onKeyDown: (e: KeyboardEvent<HTMLLIElement>) => keyDown(e, r, i),
          style: { paddingInlineStart: `calc(var(--space-3) * ${r.level})` },
        };
        if (r.kind === 'more')
          return (
            <li
              key={k}
              role="treeitem"
              aria-level={r.level}
              className="doc-tree-item doc-tree-more"
              {...common}
              onClick={() => (r.parent === 'root' ? onMoreRoots() : onMoreKids(r.parent))}
            >
              {r.label}
            </li>
          );
        const n = nodes[r.id]!;
        return (
          <li
            key={k}
            role="treeitem"
            aria-level={r.level}
            aria-expanded={n.d.has_children ? n.open : undefined}
            aria-selected={false}
            className="doc-tree-item"
            {...common}
          >
            <span
              className="doc-tree-twist"
              aria-hidden="true"
              onClick={() => n.d.has_children && onToggle(n.d.id, !n.open)}
            >
              {n.d.has_children ? (n.open ? '▾' : '▸') : '·'}
            </span>
            <Link to={docHref(ws, n.d.id)} tabIndex={-1} className="doc-tree-link">
              {n.d.title || 'Untitled'}
            </Link>{' '}
            <span className="hint">{n.d.doc_type_label}</span> <StateBadges doc={n.d} />
            {n.loading ? <span className="hint"> Loading…</span> : null}
            {n.error ? (
              <span className="field-error" role="alert">
                {' '}
                {n.error.message}{' '}
                <button
                  type="button"
                  tabIndex={-1}
                  className="button button-ghost"
                  onClick={() => onRetryKids(n.d.id)}
                >
                  Retry
                </button>
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
