import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { PUBLIC_CONFIG } from '@pm/config/public';
import { useAuth } from '../auth.tsx';
import { Link, useRouter } from '../router.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { OfflineBanner } from '../ui/feedback.tsx';
import { ScopeSwitcher } from '../tenancy/switcher.tsx';
import { BrandMarker } from './brand-marker.tsx';
import type { NavTarget } from './client.ts';
import { useCommands, useRegisterCommands, type Command } from './commands.tsx';
import { ShellFrameContext } from './frame.ts';
import { CommandPalette } from './palette.tsx';
import { usePreferences } from './preferences.tsx';
import {
  canSee,
  COMPACT_SLOTS,
  matchRoute,
  navEntries,
  ROUTE_INDEX,
  ROUTES,
  routeHref,
  type Access,
  type RouteDef,
} from './registry.ts';
import { ShortcutReference } from './shortcut-help.tsx';
import { shortcutLabel } from './shortcuts.ts';
import { targetHref, TARGET_TYPE_LABEL } from './targets.ts';
import { useWidthClass } from './width.ts';
import { useWorkspaceShell } from './workspace.tsx';

/**
 * The application shell (NAV-001, NAV-014; RS §2): every signed-in page renders inside it.
 *
 * - Expanded/Wide: sticky header (navigation toggle, scope, search/commands, create, help,
 *   account), a collapsible sidebar (remembered per device), and the main outlet.
 * - Medium: a navigation rail (icon + short label) with Favorites/Recent flyouts.
 * - Compact: a top app bar and exactly five bottom slots (Home, Today, Inbox, My Work, More); More
 *   opens a sheet with the remaining destinations, settings, and administration.
 *
 * Width classes are CSS media queries over the same tokens (no user-agent detection). Every entry
 * comes from the route registry through one permission predicate, and every navigational element
 * is a real link.
 */

function hrefFor(def: RouteDef, ws: string | null, scopeToken: string | null): string | null {
  if (def.shell === 'workspace') {
    if (!ws) return null;
    return routeHref(def.id, { ws }, def.scopeSensitive ? { scope: scopeToken ?? undefined } : {});
  }
  return routeHref(def.id, {});
}

function useAccess(): { access: Access | null; ws: string | null; token: string | null } {
  const shell = useWorkspaceShell();
  return {
    access: shell?.access ?? null,
    ws: shell?.ws ?? null,
    token: shell?.context?.scope_token ?? null,
  };
}

/** Shell-level commands, all derived from the registry and the current permissions. */
function useShellCommands(kind: 'workspace' | 'personal') {
  const { access, ws, token } = useAccess();
  const { update, device, updateDevice } = usePreferences();
  const { setHelpOpen } = useCommands();
  const width = useWidthClass();
  const list: Command[] = [];
  list.push({
    id: 'palette.open',
    label: 'Open command palette',
    group: 'Actions',
    shortcut: 'Mod+K',
  });
  list.push({
    id: 'shortcuts.reference',
    label: 'Keyboard shortcuts',
    group: 'Actions',
    keywords: 'help keys',
    shortcut: '?',
    run: () => setHelpOpen(true),
  });
  for (const theme of ['light', 'dark', 'system'] as const)
    list.push({
      id: `theme.${theme}`,
      label: theme === 'system' ? 'Use the system theme' : `Use ${theme} theme`,
      group: 'Actions',
      keywords: 'appearance theme mode',
      run: () => void update({ theme }).catch(() => undefined),
    });
  if (width === 'expanded' || width === 'wide')
    list.push({
      id: 'sidebar.toggle',
      label: device.sidebar === 'collapsed' ? 'Expand navigation' : 'Collapse navigation',
      group: 'Actions',
      keywords: 'sidebar',
      run: () =>
        updateDevice({ sidebar: device.sidebar === 'collapsed' ? 'expanded' : 'collapsed' }),
    });
  list.push(
    {
      id: 'focus.next_region',
      label: 'Move focus to main content',
      group: 'Actions',
      run: () => document.getElementById('main')?.querySelector<HTMLElement>('h1')?.focus(),
    },
    {
      id: 'focus.previous_region',
      label: 'Move focus to navigation',
      group: 'Actions',
      run: () => document.querySelector<HTMLElement>('.app-nav a, .bottom-nav a')?.focus(),
    },
  );
  if (kind === 'workspace' && ws && access) {
    const c = access.capabilities;
    if (c.create_brand)
      list.push({
        id: 'brand.create',
        label: 'Add a brand…',
        group: 'Actions',
        href: routeHref('brand_new', { ws }),
      });
    if (canSee(ROUTE_INDEX.get('invite')!, access))
      list.push({
        id: 'people.invite',
        label: 'Invite people…',
        group: 'Actions',
        href: routeHref('invite', { ws }),
      });
    if (c.manage_teams)
      list.push({
        id: 'team.create',
        label: 'Create a team…',
        group: 'Actions',
        href: routeHref('teams', { ws }),
      });
  }
  for (const def of ROUTES) {
    if (!def.command) continue;
    if (def.shell === 'workspace' && (kind !== 'workspace' || !canSee(def, access))) continue;
    const href = hrefFor(def, ws, token);
    if (!href) continue;
    list.push({
      id: def.command,
      label: def.nav?.label ?? def.section,
      group: 'Go to',
      href,
      ...(def.shortcut ? { shortcut: def.shortcut } : {}),
    });
  }
  useRegisterCommands(list);
}

// -------------------------------------------------------------------------------------------------

export function AppShell({
  kind,
  children,
}: {
  kind: 'workspace' | 'personal';
  children: ReactNode;
}) {
  const { paletteOpen, helpOpen } = useCommands();
  const { device } = usePreferences();
  const shellState = useWorkspaceShell();
  const width = useWidthClass();
  useShellCommands(kind);
  const collapsed = device.sidebar === 'collapsed';
  const frame = useMemo(() => ({ kind }), [kind]);
  return (
    <ShellFrameContext.Provider value={frame}>
      <div className="app" data-collapsed={collapsed ? 'true' : undefined}>
        <SkipLink target="main">Skip to main content</SkipLink>
        <SkipLink target="primary-nav">Skip to navigation</SkipLink>
        <Header kind={kind} />
        <div className="app-body">
          <Sidebar kind={kind} />
          <div className="app-main">
            <OfflineBanner />
            {shellState ? <ScopeNoticeBar /> : null}
            {children}
          </div>
        </div>
        {width === 'compact' ? <BottomBar kind={kind} /> : null}
        {paletteOpen ? <CommandPalette /> : null}
        {helpOpen ? <ShortcutReference /> : null}
      </div>
    </ShellFrameContext.Provider>
  );
}

/** Moves focus to a landmark without changing the URL (the router owns the address). */
function SkipLink({ target, children }: { target: string; children: ReactNode }) {
  return (
    <a
      className="skip-link"
      href={`#${target}`}
      onClick={(e) => {
        e.preventDefault();
        document.getElementById(target)?.focus();
      }}
    >
      {children}
    </a>
  );
}

function Header({ kind }: { kind: 'workspace' | 'personal' }) {
  const { openPalette } = useCommands();
  const { device, updateDevice } = usePreferences();
  const shellState = useWorkspaceShell();
  const width = useWidthClass();
  const compact = width === 'compact';
  const collapsed = device.sidebar === 'collapsed';
  return (
    <header className="app-header">
      {width === 'expanded' || width === 'wide' ? (
        <button
          type="button"
          className="icon-button"
          aria-expanded={!collapsed}
          aria-controls="primary-nav"
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          onClick={() => updateDevice({ sidebar: collapsed ? 'expanded' : 'collapsed' })}
        >
          <span aria-hidden="true">≡</span>
        </button>
      ) : null}
      {kind === 'workspace' && shellState?.context ? (
        <ScopeSwitcher placement={compact ? 'bar' : 'header'} />
      ) : (
        <Link to="/workspaces" className="app-name">
          {PUBLIC_CONFIG.appName}
        </Link>
      )}
      {kind === 'workspace' && shellState?.context && !compact ? (
        <span className="workspace-name">{shellState.context.workspace.name}</span>
      ) : null}
      <span className="header-spacer" />
      <button
        type="button"
        className={compact ? 'icon-button' : 'search-button'}
        aria-label="Search and commands"
        aria-keyshortcuts={shortcutLabel('Mod+K').replace('⌘', 'Meta+')}
        onClick={() => openPalette()}
      >
        <span aria-hidden="true">⌕</span>
        {compact ? null : (
          <>
            <span className="search-label" aria-hidden="true">
              Search and commands
            </span>
            <kbd>{shortcutLabel('Mod+K')}</kbd>
          </>
        )}
      </button>
      {kind === 'workspace' && !compact ? <CreateMenu /> : null}
      {kind === 'workspace' ? <NotificationsFoundation /> : null}
      {!compact ? <HelpButton /> : null}
      {!compact ? <AccountMenu /> : null}
    </header>
  );
}

function HelpButton() {
  const { setHelpOpen } = useCommands();
  return (
    <button
      type="button"
      className="icon-button"
      aria-label="Keyboard shortcuts"
      aria-keyshortcuts="Shift+?"
      onClick={() => setHelpOpen(true)}
    >
      <span aria-hidden="true">?</span>
    </button>
  );
}

/** A non-modal disclosure popover (light dismiss, Esc returns focus to its button). */
function Popover({
  label,
  buttonLabel,
  buttonClass = 'icon-button',
  children,
}: {
  label: string;
  buttonLabel: ReactNode;
  buttonClass?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="popover-host" ref={box}>
      <button
        ref={button}
        type="button"
        className={buttonClass}
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {buttonLabel}
      </button>
      {open ? (
        <div id={id} className="popover" role="group" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function CreateMenu() {
  const { commands } = useCommands();
  const creates = commands.filter((c) =>
    ['brand.create', 'people.invite', 'team.create'].includes(c.id),
  );
  if (!creates.length) return null;
  return (
    <Popover
      label="Create"
      buttonClass="button button-primary"
      buttonLabel={
        <>
          <span aria-hidden="true">+ </span>Create
        </>
      }
    >
      {(close) => (
        <ul className="plain-list">
          {creates.map((c) => (
            <li key={c.id}>
              <Link to={c.href!} onClick={close}>
                {c.label.replace('…', '')}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}

/** Notifications arrive with their owning phase (4B); until then the bell says so honestly. */
function NotificationsFoundation() {
  return (
    <Popover label="Notifications" buttonLabel={<span aria-hidden="true">🔔</span>}>
      {() => (
        <p className="popover-text">
          Notifications aren't available yet. They arrive in a later release.
        </p>
      )}
    </Popover>
  );
}

function AccountMenu() {
  const { me, signOut } = useAuth();
  const { navigate } = useRouter();
  const { setHelpOpen } = useCommands();
  const initial = me?.display_name?.trim().charAt(0).toUpperCase() || '●';
  return (
    <Popover
      label="Account"
      buttonClass="avatar-button"
      buttonLabel={<span aria-hidden="true">{initial}</span>}
    >
      {(close) => (
        <div className="account-menu">
          {me ? (
            <p className="account-who">
              <span>{me.display_name}</span>
              <span className="hint">{me.email}</span>
            </p>
          ) : null}
          <ul className="plain-list">
            <li>
              <Link to="/settings/preferences" onClick={close}>
                Preferences
              </Link>
            </li>
            <li>
              <Link to="/account/security" onClick={close}>
                Account security
              </Link>
            </li>
            <li>
              <Link to="/workspaces" onClick={close}>
                Switch workspace
              </Link>
            </li>
            <li>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => {
                  close();
                  setHelpOpen(true);
                }}
              >
                Keyboard shortcuts
              </button>
            </li>
            <li>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => {
                  close();
                  void signOut().then(() => navigate('/sign-in'));
                }}
              >
                Sign out
              </button>
            </li>
          </ul>
        </div>
      )}
    </Popover>
  );
}

// -------------------------------------------------------------------------------------------------
// Sidebar and rail
// -------------------------------------------------------------------------------------------------

function NavLink({ def, ws, token }: { def: RouteDef; ws: string | null; token: string | null }) {
  const { path } = useRouter();
  const href = hrefFor(def, ws, token);
  if (!href || !def.nav) return null;
  const here = matchRoute(path)?.def.id === def.id;
  return (
    <li>
      <Link
        to={href}
        aria-current={here ? 'page' : undefined}
        className="nav-link"
        title={def.nav.label}
      >
        <span className="nav-icon" aria-hidden="true">
          {def.nav.icon}
        </span>
        <span className="nav-label">{def.nav.label}</span>
        <span className="nav-short" aria-hidden="true">
          {def.nav.short}
        </span>
      </Link>
    </li>
  );
}

function TargetLink({ ws, t }: { ws: string; t: NavTarget }) {
  const { path } = useRouter();
  const href = targetHref(ws, t);
  return (
    <li>
      <Link to={href} className="nav-target" aria-current={path === href ? 'page' : undefined}>
        <BrandMarker marker={t.brand} variant="tile" size={16} decorative={t.type === 'brand'} />
        <span className="nav-label">{t.label}</span>
        <span className="visually-hidden">, {TARGET_TYPE_LABEL[t.type]}</span>
      </Link>
    </li>
  );
}

function PersonalLists({ ws }: { ws: string }) {
  const shellState = useWorkspaceShell()!;
  return (
    <>
      <section className="nav-section nav-favorites" aria-labelledby="nav-fav-h">
        <h2 id="nav-fav-h" className="nav-heading">
          <Link to={routeHref('favorites', { ws })}>Favorites</Link>
        </h2>
        {shellState.favorites.length ? (
          <ul>
            {shellState.favorites.slice(0, 10).map((t) => (
              <TargetLink key={t.id} ws={ws} t={t} />
            ))}
          </ul>
        ) : (
          <p className="nav-empty">No favorites yet.</p>
        )}
      </section>
      <section className="nav-section nav-recent" aria-labelledby="nav-recent-h">
        <h2 id="nav-recent-h" className="nav-heading">
          Recent
        </h2>
        {shellState.recent.length ? (
          <ul>
            {shellState.recent.map((t) => (
              <TargetLink key={t.id} ws={ws} t={t} />
            ))}
          </ul>
        ) : (
          <p className="nav-empty">Nothing viewed yet.</p>
        )}
        <p className="nav-more">
          <Link to={routeHref('recent', { ws })}>All recent</Link>
        </p>
      </section>
    </>
  );
}

/** Rail (Medium, collapsed sidebar): Favorites and Recent open as a flyout (RS §2 Medium). */
function RailFlyouts({ ws }: { ws: string }) {
  const shellState = useWorkspaceShell()!;
  const lists: Array<{
    key: string;
    label: string;
    icon: string;
    items: NavTarget[];
    all: string;
  }> = [
    {
      key: 'fav',
      label: 'Favorites',
      icon: '☆',
      items: shellState.favorites,
      all: routeHref('favorites', { ws }),
    },
    {
      key: 'recent',
      label: 'Recent',
      icon: '↺',
      items: shellState.recent,
      all: routeHref('recent', { ws }),
    },
  ];
  return (
    <ul className="rail-flyouts">
      {lists.map((l) => (
        <li key={l.key}>
          <Popover
            label={l.label}
            buttonClass="nav-link rail-flyout-button"
            buttonLabel={
              <>
                <span className="nav-icon" aria-hidden="true">
                  {l.icon}
                </span>
                <span className="nav-short" aria-hidden="true">
                  {l.label}
                </span>
              </>
            }
          >
            {(close) => (
              <div onClick={close}>
                {l.items.length ? (
                  <ul className="plain-list">
                    {l.items.slice(0, 10).map((t) => (
                      <TargetLink key={t.id} ws={ws} t={t} />
                    ))}
                  </ul>
                ) : (
                  <p className="popover-text">Nothing here yet.</p>
                )}
                <p>
                  <Link to={l.all}>See all</Link>
                </p>
              </div>
            )}
          </Popover>
        </li>
      ))}
    </ul>
  );
}

function Sidebar({ kind }: { kind: 'workspace' | 'personal' }) {
  const { access, ws, token } = useAccess();
  const primary = kind === 'workspace' ? navEntries('primary', access) : [];
  const workspace = kind === 'workspace' ? navEntries('workspace', access) : [];
  const admin = kind === 'workspace' ? navEntries('admin', access) : [];
  const personal = navEntries('personal', null).filter((d) => d.shell === 'personal');
  return (
    <nav id="primary-nav" aria-label="Primary" className="app-nav" tabIndex={-1}>
      {primary.length ? (
        <ul className="nav-list">
          {primary.map((d) => (
            <NavLink key={d.id} def={d} ws={ws} token={token} />
          ))}
        </ul>
      ) : null}
      {kind === 'workspace' && ws && access ? (
        <>
          <div className="nav-lists">
            <PersonalLists ws={ws} />
          </div>
          <RailFlyouts ws={ws} />
        </>
      ) : null}
      {workspace.length ? (
        <section className="nav-section" aria-labelledby="nav-ws-h">
          <h2 id="nav-ws-h" className="nav-heading">
            Workspace
          </h2>
          <ul className="nav-list">
            {workspace.map((d) => (
              <NavLink key={d.id} def={d} ws={ws} token={token} />
            ))}
          </ul>
        </section>
      ) : null}
      <section className="nav-section nav-footer" aria-labelledby="nav-settings-h">
        <h2 id="nav-settings-h" className="nav-heading">
          Settings
        </h2>
        <ul className="nav-list">
          {kind === 'personal' ? (
            <li>
              <Link to="/workspaces" className="nav-link">
                <span className="nav-icon" aria-hidden="true">
                  ▦
                </span>
                <span className="nav-label">Workspaces</span>
                <span className="nav-short" aria-hidden="true">
                  Spaces
                </span>
              </Link>
            </li>
          ) : null}
          {personal.map((d) => (
            <NavLink key={d.id} def={d} ws={ws} token={token} />
          ))}
        </ul>
        {admin.length ? (
          <>
            <h2 className="nav-heading">Administration</h2>
            <ul className="nav-list">
              {admin.map((d) => (
                <NavLink key={d.id} def={d} ws={ws} token={token} />
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </nav>
  );
}

// -------------------------------------------------------------------------------------------------
// Compact bottom bar and More sheet (RS-05)
// -------------------------------------------------------------------------------------------------

function BottomBar({ kind }: { kind: 'workspace' | 'personal' }) {
  const { access, ws, token } = useAccess();
  const [more, setMore] = useState(false);
  const [hidden, setHidden] = useState(false);
  const { path } = useRouter();
  // RS-03: on short viewports the bar hides while scrolling down and returns on scroll up, on
  // focus, or at the end of the page.
  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const short = window.innerHeight < 500;
      const atEnd = window.innerHeight + y >= document.documentElement.scrollHeight - 2;
      setHidden(short && y > last && !atEnd);
      last = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (kind !== 'workspace' || !ws || !access) return null;
  const slots: RouteDef[] =
    access.principal === 'member'
      ? COMPACT_SLOTS.map((id) => ROUTE_INDEX.get(id)!)
      : [ROUTE_INDEX.get('shared')!, ROUTE_INDEX.get('recent')!];
  const current = matchRoute(path)?.def.id;
  return (
    <>
      <nav
        aria-label="Primary"
        className="bottom-nav"
        data-hidden={hidden ? 'true' : undefined}
        onFocus={() => setHidden(false)}
      >
        <ul>
          {slots.map((d) => (
            <li key={d.id}>
              <Link
                to={hrefFor(d, ws, token)!}
                aria-current={current === d.id ? 'page' : undefined}
                className="bottom-link"
              >
                <span className="nav-icon" aria-hidden="true">
                  {d.nav?.icon}
                </span>
                <span>{d.nav?.short ?? d.section}</span>
              </Link>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="bottom-link"
              aria-haspopup="dialog"
              aria-expanded={more}
              onClick={() => setMore(true)}
            >
              <span className="nav-icon" aria-hidden="true">
                ⋯
              </span>
              <span>More</span>
            </button>
          </li>
        </ul>
      </nav>
      {more ? <MoreSheet onClose={() => setMore(false)} /> : null}
    </>
  );
}

function MoreSheet({ onClose }: { onClose: () => void }) {
  const { access, ws, token } = useAccess();
  const { signOut } = useAuth();
  const { navigate } = useRouter();
  const pushed = useRef(false);
  // A Compact sheet owns a history entry: the system Back gesture closes it (RS-21).
  useEffect(() => {
    window.history.pushState(
      { ...(window.history.state ?? {}), sheet: 'more' },
      '',
      window.location.href,
    );
    pushed.current = true;
    const onPop = () => {
      pushed.current = false;
      onClose();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [onClose]);
  const close = () => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else onClose();
  };
  const go = (to: string) => {
    pushed.current = false;
    onClose();
    navigate(to, { replace: true });
  };
  const slots = new Set<string>(
    access?.principal === 'member' ? COMPACT_SLOTS : ['shared', 'recent'],
  );
  const groups: Array<{ title: string; items: RouteDef[] }> = [
    { title: 'Go to', items: navEntries('primary', access).filter((d) => !slots.has(d.id)) },
    { title: 'Personal', items: navEntries('personal', access).filter((d) => !slots.has(d.id)) },
    { title: 'Workspace', items: navEntries('workspace', access) },
    { title: 'Administration', items: navEntries('admin', access) },
  ];
  return (
    <Dialog title="More" onClose={close}>
      <div className="sheet">
        {groups.map((g) =>
          g.items.length ? (
            <section key={g.title} aria-label={g.title}>
              <h3 className="nav-heading">{g.title}</h3>
              <ul className="plain-list sheet-list">
                {g.items.map((d) => {
                  const href = hrefFor(d, ws, token);
                  return href ? (
                    <li key={d.id}>
                      <a
                        href={href}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                          e.preventDefault();
                          go(href);
                        }}
                      >
                        <span className="nav-icon" aria-hidden="true">
                          {d.nav?.icon}
                        </span>
                        {d.nav?.label ?? d.section}
                      </a>
                    </li>
                  ) : null;
                })}
              </ul>
            </section>
          ) : null,
        )}
        <section aria-label="Account">
          <h3 className="nav-heading">Account</h3>
          <ul className="plain-list sheet-list">
            <li>
              <a
                href="/workspaces"
                onClick={(e) => {
                  e.preventDefault();
                  go('/workspaces');
                }}
              >
                Switch workspace
              </a>
            </li>
            <li>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => {
                  onClose();
                  void signOut().then(() => navigate('/sign-in'));
                }}
              >
                Sign out
              </button>
            </li>
          </ul>
        </section>
        <div className="actions sticky-actions">
          <button type="button" className="button button-secondary" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// -------------------------------------------------------------------------------------------------
// Scope notices (IA-25: switched into a record's brand, Back to previous scope)
// -------------------------------------------------------------------------------------------------

function ScopeNoticeBar() {
  const shellState = useWorkspaceShell()!;
  const { state } = useRouter();
  const n = shellState.notice;
  if (!n) return <p className="visually-hidden" role="status" aria-live="polite" />;
  return (
    <div className="banner banner-info scope-notice" role="status" aria-live="polite">
      <span className="banner-icon" aria-hidden="true">
        ℹ
      </span>
      <div>
        <p className="banner-title">
          {n.kind === 'switched'
            ? `Switched to ${n.brand}`
            : n.kind === 'reverted'
              ? 'Back to your previous scope'
              : "Some brands in that link aren't available to you. Showing brands you can access."}
        </p>
        <div className="banner-action">
          {n.kind === 'switched' && state.previousScope ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={shellState.revertScope}
            >
              Back to previous scope
            </button>
          ) : null}
          <button type="button" className="button button-ghost" onClick={shellState.dismissNotice}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
