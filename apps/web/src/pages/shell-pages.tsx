import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  HIDEABLE_DESTINATIONS,
  NAVIGABLE_RECORD_TYPES,
  START_DESTINATIONS,
  type Preferences,
  type ShellDestination,
} from '@pm/contracts/shell';
import { ApiError } from '../api.ts';
import { Link, useRouter } from '../router.tsx';
import { useStepUp } from '../stepup.tsx';
import { BrandMarker, summaryMarker } from '../shell/brand-marker.tsx';
import { shell, type NavTarget, type RecentItem } from '../shell/client.ts';
import { useRegisterCommands } from '../shell/commands.tsx';
import { usePreferences } from '../shell/preferences.tsx';
import { destinationLabel, ROUTE_INDEX, routeHref } from '../shell/registry.ts';
import { targetHref, TARGET_TYPE_LABEL } from '../shell/targets.ts';
import { pruneSelection, useScrollAnchor, useViewState } from '../shell/view-state.ts';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { collab, tenancy, type Brand } from '../tenancy/client.ts';
import { ResourceView, useResource } from '../tenancy/resource.tsx';
import { Announce, Banner, ProblemBanner } from '../ui/feedback.tsx';
import { NotAvailableBody, Page } from '../ui/layout.tsx';
import { SearchHealthNotice } from './search-pages.tsx';

// -------------------------------------------------------------------------------------------------
// ST-41: not available (not found and not authorized are identical)
// -------------------------------------------------------------------------------------------------

export function NotAvailablePage() {
  const shellState = useWorkspaceShell();
  const home =
    shellState?.context && shellState.access?.principal === 'member'
      ? routeHref('home', { ws: shellState.ws })
      : '/workspaces';
  return (
    <Page title="This page isn't available" record={null} section="Not available">
      <NotAvailableBody home={home} />
    </Page>
  );
}

// -------------------------------------------------------------------------------------------------
// Later destinations: real, addressable routes with an honest unavailable state (no data)
// -------------------------------------------------------------------------------------------------

export function UnavailableDestinationPage({ destination }: { destination: ShellDestination }) {
  const label = destinationLabel(destination);
  return (
    <Page title={label}>
      <section className="card empty-state" aria-labelledby="unavailable-h">
        <h2 id="unavailable-h">{label} isn't available yet</h2>
        <p>
          {label} arrives in a later release. Nothing is missing from your workspace: there is no{' '}
          {label} content to show until then.
        </p>
        <p>
          You can hide destinations you don't use in{' '}
          <Link to="/settings/preferences">Preferences</Link>.
        </p>
      </section>
    </Page>
  );
}

// -------------------------------------------------------------------------------------------------
// Workspace root: the start destination (IA-04; a deep link always overrides it)
// -------------------------------------------------------------------------------------------------

export function WorkspaceRootPage({ ws }: { ws: string }) {
  const shellState = useWorkspaceShell();
  const { preferences, loaded } = usePreferences();
  const { navigate, search } = useRouter();
  const ctx = shellState?.context;
  const access = shellState?.access;
  useEffect(() => {
    if (!ctx || !access || !loaded) return;
    const pref = preferences.start_destination;
    const allowed = (id: string) => {
      const def = ROUTE_INDEX.get(id);
      return Boolean(def && (!def.visible || def.visible(access)));
    };
    // IA-04, adjusted for this release: a destination whose content is a later phase is never the
    // automatic landing page, so members land on Home unless they chose otherwise.
    const start = access.principal === 'guest' ? 'shared' : pref && allowed(pref) ? pref : 'home';
    const def = ROUTE_INDEX.get(start)!;
    const query: Record<string, string | undefined> = def.scopeSensitive
      ? { scope: ctx.scope_token ?? undefined }
      : {};
    const created = search.get('created');
    if (created && start === 'home') query.created = created;
    navigate(routeHref(start, { ws }, query), { replace: true });
  }, [ctx, access, loaded, preferences.start_destination, navigate, ws, search]);
  return (
    <Page title="Loading" record={null}>
      <p className="loading" role="status" aria-live="polite">
        Opening your workspace…
      </p>
    </Page>
  );
}

// -------------------------------------------------------------------------------------------------
// Home (IA-03): adapts to the scope; widgets for unbuilt features are absent
// -------------------------------------------------------------------------------------------------

export function HomePage({ ws }: { ws: string }) {
  const shellState = useWorkspaceShell();
  const { search } = useRouter();
  const ctx = shellState?.context;
  const inScope =
    ctx?.scope.kind === 'brand'
      ? [ctx.scope.brand_id]
      : ctx?.scope.kind === 'brands' || ctx?.scope.kind === 'all'
        ? ctx.scope.brand_ids
        : [];
  const key = ctx ? `home:${ws}:${inScope.join(',')}` : 'wait';
  const data = useResource(async () => {
    const [active, archived] = await Promise.all([
      tenancy.listBrands(ws, 'active'),
      tenancy.listBrands(ws, 'archived'),
    ]);
    return { active: active.data, archived: archived.data };
  }, key);
  const created = search.get('created');
  const stepUp = useStepUp();
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState<unknown>(null);
  const restore = async (b: Brand) => {
    setProblem(null);
    try {
      await tenancy.restore(ws, b.id, b.version, stepUp);
      setSaid(`${b.name} was restored.`);
      data.reload();
      shellState?.reloadContext();
    } catch (err) {
      setProblem(err);
    }
  };
  if (!ctx) return <Page title="Home">{null}</Page>;
  const caption =
    ctx.scope.kind === 'all'
      ? `Across your ${ctx.brands.length} brands`
      : ctx.scope.kind === 'brands'
        ? ctx.brands
            .filter((b) => inScope.includes(b.id))
            .map((b) => b.name)
            .join(', ')
        : ctx.scope.kind === 'brand'
          ? (ctx.brands.find((b) => b.id === inScope[0])?.name ?? '')
          : '';
  return (
    <Page title={ctx.workspace.name} lead={caption || undefined} wide>
      <ResourceView resource={data.state} onRetry={data.retry} what="workspace">
        {(d) => {
          // "All brands" is every active brand the person can access now (IA-23).
          const shown =
            ctx.scope.kind === 'all' ? d.active : d.active.filter((b) => inScope.includes(b.id));
          const createdBrand = created ? d.active.find((b) => b.id === created) : undefined;
          return (
            <>
              {createdBrand && !said ? <Announce>{createdBrand.name} was created.</Announce> : null}
              {said ? <Announce>{said}</Announce> : null}
              <ProblemBanner error={problem} />
              {ctx.workspace.capabilities.configure ? <SearchHealthNotice ws={ws} /> : null}
              <section aria-labelledby="active-h">
                <div className="section-head">
                  <h2 id="active-h">Active brands ({shown.length})</h2>
                  {ctx.workspace.capabilities.create_brand ? (
                    <Link to={routeHref('brand_new', { ws })} className="button button-primary">
                      Add a brand
                    </Link>
                  ) : null}
                </div>
                {shown.length ? (
                  <ul className="brand-cards">
                    {shown.map((b) => (
                      <HomeBrandCard key={b.id} ws={ws} brand={b} />
                    ))}
                  </ul>
                ) : (
                  <p className="empty">
                    {ctx.brands.length
                      ? 'No brands in this scope.'
                      : 'No active brands. Add a brand to start organizing work by business or product line.'}
                  </p>
                )}
              </section>
              {d.archived.length ? (
                <section aria-labelledby="archived-h">
                  <h2 id="archived-h">Archived brands ({d.archived.length})</h2>
                  <ul className="brand-cards">
                    {d.archived.map((b) => (
                      <HomeBrandCard
                        key={b.id}
                        ws={ws}
                        brand={b}
                        onRestore={() => void restore(b)}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          );
        }}
      </ResourceView>
    </Page>
  );
}

function HomeBrandCard({
  ws,
  brand,
  onRestore,
}: {
  ws: string;
  brand: Brand;
  onRestore?: () => void;
}) {
  const headingId = `card-${brand.id}`;
  const archived = brand.lifecycle_state === 'archived';
  return (
    <li className="brand-card card" aria-labelledby={headingId}>
      <div className="brand-card-head">
        <h3 id={headingId}>
          <BrandMarker marker={summaryMarker(brand, archived)} />
        </h3>
      </div>
      <p className="badges">
        {brand.is_sensitive ? <span className="badge badge-danger">Sensitive</span> : null}
      </p>
      <div className="actions actions-compact">
        <Link to={routeHref('brand', { ws, brand: brand.id })}>
          {archived ? 'View' : 'Settings'} <span className="visually-hidden">for {brand.name}</span>
        </Link>
        {onRestore && brand.capabilities.restore ? (
          <button type="button" className="button button-secondary" onClick={onRestore}>
            Restore <span className="visually-hidden">{brand.name}</span>
          </button>
        ) : null}
      </div>
    </li>
  );
}

// -------------------------------------------------------------------------------------------------
// Shared with me (IA-05, guests' home)
// -------------------------------------------------------------------------------------------------

export function SharedWithMePage({ ws }: { ws: string }) {
  const data = useResource(() => collab.shared(ws), `shared:${ws}`);
  return (
    <Page title="Shared with me">
      <ResourceView resource={data.state} onRetry={data.retry} what="shared items">
        {(items) =>
          items.length ? (
            <ul className="plain-list record-list">
              {items.map((r) => (
                <li key={r.id} className="record-row">
                  <BrandMarker marker={r.brand} size={16} />
                  <span>{r.type.replace(/_/g, ' ')}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Nothing has been shared with you yet.</p>
          )
        }
      </ResourceView>
    </Page>
  );
}

// -------------------------------------------------------------------------------------------------
// Favorites (NAV-008): keyboard-accessible reorder with buttons (no drag needed)
// -------------------------------------------------------------------------------------------------

export function FavoritesPage({ ws }: { ws: string }) {
  const shellState = useWorkspaceShell();
  const [items, setItems] = useState<NavTarget[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [said, setSaid] = useState('');
  const focusAfter = useRef<string | null>(null);
  const load = useCallback(() => {
    shell.favorites(ws).then(setItems, (e: unknown) => setError(e));
  }, [ws]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!focusAfter.current) return;
    document.getElementById(focusAfter.current)?.focus();
    focusAfter.current = null;
  }, [items]);
  const move = async (t: NavTarget, after: string | null, message: string, focusId: string) => {
    setError(null);
    try {
      const next = await shell.moveFavorite(ws, t.id, after);
      // Keep focus on the moved item: the same button, or its other direction at either end.
      const at = next.findIndex((x) => x.id === t.id);
      focusAfter.current =
        at === 0 ? `fav-down-${t.id}` : at === next.length - 1 ? `fav-up-${t.id}` : focusId;
      setItems(next);
      setSaid(message);
      shellState?.refreshLists();
    } catch (err) {
      setError(err);
    }
  };
  const remove = async (t: NavTarget) => {
    setError(null);
    try {
      await shell.removeFavorite(ws, t.id);
      setItems((x) => (x ?? []).filter((y) => y.id !== t.id));
      setSaid(`${t.label} was removed from favorites.`);
      shellState?.refreshLists();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Page title="Favorites">
      {said ? <Announce>{said}</Announce> : null}
      <ProblemBanner error={error} onRetry={load} />
      {items === null ? (
        <p className="loading" role="status">
          Loading favorites…
        </p>
      ) : items.length ? (
        <ol className="plain-list favorites-list">
          {items.map((t, i) => (
            <li key={t.id} className="record-row">
              <Link to={targetHref(ws, t)} className="record-link">
                <BrandMarker
                  marker={t.brand}
                  variant="tile"
                  size={16}
                  decorative={t.type === 'brand'}
                />
                <span>{t.label}</span>
                <span className="hint"> · {TARGET_TYPE_LABEL[t.type]}</span>
              </Link>
              <span className="row-actions">
                <button
                  id={`fav-up-${t.id}`}
                  type="button"
                  className="button button-ghost"
                  disabled={i === 0}
                  onClick={() =>
                    void move(
                      t,
                      i >= 2 ? items[i - 2]!.id : null,
                      `${t.label} moved up to position ${i}.`,
                      `fav-up-${t.id}`,
                    )
                  }
                >
                  Move up <span className="visually-hidden">{t.label}</span>
                </button>
                <button
                  id={`fav-down-${t.id}`}
                  type="button"
                  className="button button-ghost"
                  disabled={i === items.length - 1}
                  onClick={() =>
                    void move(
                      t,
                      items[i + 1]?.id ?? null,
                      `${t.label} moved down to position ${i + 2}.`,
                      `fav-down-${t.id}`,
                    )
                  }
                >
                  Move down <span className="visually-hidden">{t.label}</span>
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => void remove(t)}
                >
                  Remove <span className="visually-hidden">{t.label} from favorites</span>
                </button>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty">
          No favorites yet. Use “Add to favorites” on a brand or team page to keep it here.
        </p>
      )}
    </Page>
  );
}

/** Favorite toggle for a record page's context bar (also a palette action while mounted). */
export function FavoriteToggle({ target, label }: { target: string; label: string }) {
  const shellState = useWorkspaceShell();
  const favorite = shellState?.favorites.some((f) => f.id === target) ?? false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toggle = useCallback(async () => {
    if (!shellState) return;
    setBusy(true);
    setError(null);
    try {
      if (favorite) await shell.removeFavorite(shellState.ws, target);
      else await shell.addFavorite(shellState.ws, target);
      shellState.refreshLists();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }, [favorite, shellState, target]);
  useRegisterCommands([
    {
      id: 'favorite.toggle',
      label: favorite ? `Remove ${label} from favorites` : `Add ${label} to favorites`,
      group: 'Actions',
      keywords: 'favorite star pin',
      run: () => void toggle(),
    },
  ]);
  if (!shellState) return null;
  return (
    <>
      <button
        type="button"
        className="button button-secondary"
        aria-pressed={favorite}
        disabled={busy}
        onClick={() => void toggle()}
      >
        <span aria-hidden="true">{favorite ? '★ ' : '☆ '}</span>
        {favorite ? 'In favorites' : 'Add to favorites'}
      </button>
      {error ? (
        <Banner
          tone="danger"
          title={
            error instanceof ApiError && error.code === 'limit_exceeded'
              ? (error.issues[0]?.message ?? 'You have too many favorites.')
              : "We couldn't update your favorites. Try again."
          }
        />
      ) : null}
    </>
  );
}

// -------------------------------------------------------------------------------------------------
// Recently viewed (NAV-007): last 50, grouped by day, filterable, clearable, selectable
// -------------------------------------------------------------------------------------------------

function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(d);
}

export function RecentPage({ ws }: { ws: string }) {
  const shellState = useWorkspaceShell();
  const view = useViewState(ws, 'recent.list');
  const type = typeof view.state.type === 'string' ? view.state.type : '';
  const brand = typeof view.state.brand === 'string' ? view.state.brand : '';
  const [items, setItems] = useState<RecentItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [said, setSaid] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = Array.isArray(view.state.selected) ? view.state.selected : [];
  const latestSelected = useRef(selected);
  useEffect(() => {
    latestSelected.current = selected;
  });
  const setView = view.set;
  const load = useCallback(() => {
    shell.recent(ws, { ...(type ? { type } : {}), ...(brand ? { brand } : {}) }).then(
      (next) => {
        setError(null);
        setItems(next);
        // Prune the selection to what is shown after every filter or permission change (RS-20),
        // so a bulk action never applies to items the person cannot currently see.
        const { kept, removed } = pruneSelection(
          latestSelected.current,
          next.map((i) => i.id),
        );
        if (removed) {
          setView({ selected: kept });
          setSaid(
            `${removed} selected ${removed === 1 ? 'item is' : 'items are'} no longer shown and ${removed === 1 ? 'was' : 'were'} deselected.`,
          );
        }
      },
      (e: unknown) => setError(e),
    );
  }, [ws, type, brand, setView]);
  useEffect(load, [load]);
  useScrollAnchor(
    list,
    items !== null,
    {
      anchor: typeof view.state.anchor === 'string' ? view.state.anchor : undefined,
      position: typeof view.state.position === 'string' ? view.state.position : undefined,
    },
    useCallback(
      (anchor: string, position: number) => view.set({ anchor, position: String(position) }),
      [view],
    ),
  );
  const brands = shellState?.context?.brands ?? [];
  const clearAll = async () => {
    try {
      await shell.clearRecent(ws);
      setItems([]);
      view.set({ selected: [] });
      setSaid('Recently viewed was cleared.');
      shellState?.refreshLists();
    } catch (err) {
      setError(err);
    }
  };
  const removeSelected = async () => {
    const { kept } = pruneSelection(
      selected,
      (items ?? []).map((i) => i.id),
    );
    try {
      for (const t of kept) await shell.removeRecent(ws, t);
      setItems((x) => (x ?? []).filter((y) => !kept.includes(y.id)));
      view.set({ selected: [] });
      setSaid(
        `${kept.length} ${kept.length === 1 ? 'item was' : 'items were'} removed from recently viewed.`,
      );
      shellState?.refreshLists();
    } catch (err) {
      setError(err);
    }
  };
  const groups: Array<{ day: string; items: RecentItem[] }> = [];
  for (const it of items ?? []) {
    const day = dayLabel(it.visited_at);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(it);
    else groups.push({ day, items: [it] });
  }
  return (
    <Page title="Recently viewed" wide>
      {said ? <Announce>{said}</Announce> : null}
      <ProblemBanner error={error} onRetry={load} />
      <form
        className="filters"
        aria-label="Filter recently viewed"
        onSubmit={(e) => e.preventDefault()}
      >
        <label htmlFor={`${id}-type`}>Type</label>
        <select
          id={`${id}-type`}
          value={type}
          onChange={(e) => view.set({ type: e.target.value || undefined })}
        >
          <option value="">All types</option>
          {NAVIGABLE_RECORD_TYPES.map((t) => (
            <option key={t} value={t}>
              {TARGET_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        {brands.length > 1 ? (
          <>
            <label htmlFor={`${id}-brand`}>Brand</label>
            <select
              id={`${id}-brand`}
              value={brand}
              onChange={(e) => view.set({ brand: e.target.value || undefined })}
            >
              <option value="">All brands</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </form>
      <div className="actions">
        <button
          type="button"
          className="button button-secondary"
          disabled={!selected.length}
          onClick={() => void removeSelected()}
        >
          Remove selected ({selected.length})
        </button>
        <button
          type="button"
          className="button button-ghost"
          disabled={!items?.length}
          onClick={() => void clearAll()}
        >
          Clear all recently viewed
        </button>
      </div>
      <div ref={list}>
        {items === null ? (
          <p className="loading" role="status">
            Loading recently viewed…
          </p>
        ) : groups.length ? (
          groups.map((g) => (
            <section key={g.day} aria-labelledby={`${id}-${g.day}`}>
              <h2 id={`${id}-${g.day}`}>{g.day}</h2>
              <ul className="plain-list">
                {g.items.map((t) => (
                  <li key={t.id} className="record-row" data-anchor-id={t.id}>
                    <input
                      type="checkbox"
                      id={`${id}-sel-${t.id}`}
                      checked={selected.includes(t.id)}
                      onChange={(e) =>
                        view.set({
                          selected: e.target.checked
                            ? [...selected, t.id]
                            : selected.filter((x) => x !== t.id),
                        })
                      }
                    />
                    <label htmlFor={`${id}-sel-${t.id}`} className="visually-hidden">
                      Select {t.label}
                    </label>
                    <Link to={targetHref(ws, t)} className="record-link">
                      <BrandMarker
                        marker={t.brand}
                        variant="tile"
                        size={16}
                        decorative={t.type === 'brand'}
                      />
                      <span>{t.label}</span>
                      <span className="hint"> · {TARGET_TYPE_LABEL[t.type]}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
        ) : (
          <p className="empty">
            {type || brand ? 'Nothing you viewed matches these filters.' : 'Nothing viewed yet.'}
          </p>
        )}
      </div>
    </Page>
  );
}

// -------------------------------------------------------------------------------------------------
// Preferences (Settings › Preferences; NAV-010, NAV-013, UXD-20)
// -------------------------------------------------------------------------------------------------

const THEME_LABEL = { system: 'Match my device', light: 'Light', dark: 'Dark' } as const;
const START_LABEL = (d: (typeof START_DESTINATIONS)[number]) =>
  d === 'shared' ? 'Shared with me' : destinationLabel(d);

export function PreferencesPage() {
  const { preferences, update, singleKeyShortcuts } = usePreferences();
  const [said, setSaid] = useState('');
  const [error, setError] = useState<unknown>(null);
  const id = useId();
  const save = async (patch: Partial<Preferences>, message: string) => {
    setError(null);
    try {
      await update(patch);
      setSaid(message);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Page title="Preferences">
      {said ? <Announce>{said}</Announce> : null}
      <ProblemBanner error={error} />
      <fieldset className="card">
        <legend>Theme</legend>
        {(['system', 'light', 'dark'] as const).map((t) => (
          <label key={t} className="choice">
            <input
              type="radio"
              name={`${id}-theme`}
              checked={preferences.theme === t}
              onChange={() => void save({ theme: t }, `Theme set to ${THEME_LABEL[t]}.`)}
            />
            {THEME_LABEL[t]}
          </label>
        ))}
      </fieldset>
      <fieldset className="card">
        <legend>Density</legend>
        {(['comfortable', 'compact'] as const).map((d) => (
          <label key={d} className="choice">
            <input
              type="radio"
              name={`${id}-density`}
              checked={preferences.density === d}
              onChange={() => void save({ density: d }, `Density set to ${d}.`)}
            />
            {d === 'comfortable' ? 'Comfortable' : 'Compact'}
          </label>
        ))}
      </fieldset>
      <fieldset className="card">
        <legend>Motion</legend>
        <label className="choice">
          <input
            type="checkbox"
            checked={preferences.motion === 'reduce'}
            onChange={(e) =>
              void save(
                { motion: e.target.checked ? 'reduce' : 'system' },
                e.target.checked ? 'Motion reduced.' : 'Motion follows your device.',
              )
            }
          />
          Reduce motion (in addition to your device setting)
        </label>
      </fieldset>
      <fieldset className="card">
        <legend>Keyboard shortcuts</legend>
        <p className="hint" id={`${id}-sc-hint`}>
          Single-key shortcuts (such as ? and G then H) never act while you type. Shortcuts with
          Ctrl or ⌘ always work.
        </p>
        {(['auto', 'on', 'off'] as const).map((s) => (
          <label key={s} className="choice">
            <input
              type="radio"
              name={`${id}-shortcuts`}
              aria-describedby={`${id}-sc-hint`}
              checked={preferences.shortcuts === s}
              onChange={() =>
                void save(
                  { shortcuts: s },
                  s === 'off'
                    ? 'Single-key shortcuts are off.'
                    : 'Single-key shortcuts setting saved.',
                )
              }
            />
            {s === 'auto' ? 'On for mouse and trackpad, off for touch' : s === 'on' ? 'On' : 'Off'}
          </label>
        ))}
        <p className="hint">Currently {singleKeyShortcuts ? 'on' : 'off'} on this device.</p>
      </fieldset>
      <fieldset className="card">
        <legend>Start page</legend>
        <label htmlFor={`${id}-start`}>Open this page when you enter a workspace</label>
        <select
          id={`${id}-start`}
          value={preferences.start_destination ?? ''}
          onChange={(e) =>
            void save(
              {
                start_destination: (e.target.value || null) as Preferences['start_destination'],
              },
              'Start page saved.',
            )
          }
        >
          <option value="">Default (Home)</option>
          {START_DESTINATIONS.map((d) => (
            <option key={d} value={d}>
              {START_LABEL(d)}
            </option>
          ))}
        </select>
      </fieldset>
      <fieldset className="card">
        <legend>Opening records</legend>
        {(['panel', 'full_page'] as const).map((m) => (
          <label key={m} className="choice">
            <input
              type="radio"
              name={`${id}-open`}
              checked={preferences.record_open === m}
              onChange={() => void save({ record_open: m }, 'Saved.')}
            />
            {m === 'panel' ? 'In a side panel next to the list' : 'As a full page'}
          </label>
        ))}
        <p className="hint">Applies to records opened from lists as those lists arrive.</p>
      </fieldset>
      <fieldset className="card">
        <legend>Destinations in navigation</legend>
        <p className="hint">Hide destinations you don't use. Home always stays.</p>
        {HIDEABLE_DESTINATIONS.map((d) => {
          const hidden = preferences.hidden_destinations.includes(d);
          return (
            <label key={d} className="choice">
              <input
                type="checkbox"
                checked={!hidden}
                onChange={(e) =>
                  void save(
                    {
                      hidden_destinations: e.target.checked
                        ? preferences.hidden_destinations.filter((x) => x !== d)
                        : [...preferences.hidden_destinations, d],
                    },
                    `${destinationLabel(d)} is ${e.target.checked ? 'shown' : 'hidden'}.`,
                  )
                }
              />
              Show {destinationLabel(d)}
            </label>
          );
        })}
      </fieldset>
    </Page>
  );
}
