import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { SHELL_COMMAND_IDS, type ShellCommandId } from '@pm/contracts/shell';
import { useRouter } from '../router.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { BrandMarker } from './brand-marker.tsx';
import { searchApi, type RecentSearch, type SearchResult } from '../search/client.ts';
import { EMPTY_QUERY, kindLabel, recentQuery, resultHref, searchHref } from '../search/params.ts';
import { shell, type NavTarget } from './client.ts';
import { useCommands, type Command } from './commands.tsx';
import { shortcutLabel } from './shortcuts.ts';
import { targetHref, TARGET_TYPE_LABEL } from './targets.ts';
import { countCommand } from './telemetry.ts';
import { useWidthClass } from './width.ts';
import { useWorkspaceShell } from './workspace.tsx';

/**
 * Command palette (RS-11, IA-11). Groups in order: Actions, Go to, Records, Search, Recent, and
 * Recent searches (shown before anything is typed). Typing `>` first restricts to actions. Every
 * entry comes from the permission-filtered command registry or from server lists re-authorized for
 * this viewer, so unavailable items are absent. Records are the navigable types; Search adds the
 * permission-aware full-text results (5A) and always offers the full search page for the term.
 * Typing never remembers anything: only choosing "Search everywhere" submits (and remembers) a
 * search. On Compact the palette is a full-screen sheet that owns a history entry, so the system
 * Back gesture closes it (RS-21).
 */

type Option =
  | { key: string; group: 'Actions' | 'Go to'; command: Command }
  | { key: string; group: 'Records' | 'Recent'; target: NavTarget; href: string }
  | { key: string; group: 'Search'; everywhere: string; href: string }
  | { key: string; group: 'Search'; result: SearchResult; href: string }
  | { key: string; group: 'Recent searches'; recent: RecentSearch; href: string };

const GROUP_LIMIT = 8;
const SEARCH_LIMIT = 6;

function matches(text: string, term: string): boolean {
  return text.toLowerCase().includes(term);
}

export function CommandPalette() {
  const { commands, closePalette, paletteMode, execute } = useCommands();
  const ws = useWorkspaceShell();
  const { navigate, state } = useRouter();
  const width = useWidthClass();
  const compact = width === 'compact';
  const [input, setInput] = useState(paletteMode === 'actions' ? '>' : '');
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<{ term: string; records: NavTarget[] }>({
    term: '',
    records: [],
  });
  const [searched, setSearched] = useState<{ term: string; results: SearchResult[] }>({
    term: '',
    results: [],
  });
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const actionsOnly = input.startsWith('>');
  const term = (actionsOnly ? input.slice(1) : input).trim().toLowerCase();

  // Compact sheet: push a history entry so Back closes the sheet instead of leaving the page.
  const pushed = useRef(false);
  useEffect(() => {
    if (!compact) return;
    if (!state.sheet) {
      window.history.pushState({ ...state, sheet: 'palette' }, '', window.location.href);
      pushed.current = true;
    }
    const onPop = () => {
      if (!(window.history.state as { sheet?: string } | null)?.sheet) {
        pushed.current = false;
        closePalette();
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact]);
  const close = () => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    }
    closePalette();
  };

  // Records: permission-safe lookup over implemented types (debounced; nothing is stored).
  const lookup = Boolean(ws?.context) && !actionsOnly && term.length >= 1;
  useEffect(() => {
    if (!lookup || !ws) return;
    let live = true;
    const controller = new AbortController();
    const t = setTimeout(() => {
      shell.targets(ws.ws, term).then(
        (r) => live && setFound({ term, records: r }),
        () => live && setFound({ term, records: [] }),
      );
      // The permission-aware full-text lookup (5A): a few results across every searchable kind.
      searchApi.query(ws.ws, { ...EMPTY_QUERY, q: term }, controller.signal, SEARCH_LIMIT).then(
        (r) => live && setSearched({ term, results: r.results }),
        () => live && setSearched({ term, results: [] }),
      );
    }, 200);
    return () => {
      live = false;
      controller.abort();
      clearTimeout(t);
    };
  }, [ws, lookup, term]);
  // Recent searches are offered before anything is typed.
  const wsId = ws?.context ? ws.ws : null;
  useEffect(() => {
    if (!wsId) return;
    let live = true;
    searchApi.recent(wsId).then(
      (r) => live && setRecentSearches(r.slice(0, GROUP_LIMIT)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wsId]);
  const records = useMemo(
    () => (lookup && found.term === term ? found.records : []),
    [lookup, found, term],
  );
  const searching = lookup && (found.term !== term || searched.term !== term);
  const hits = useMemo(
    () => (lookup && searched.term === term ? searched.results : []),
    [lookup, searched, term],
  );

  const options = useMemo<Option[]>(() => {
    const out: Option[] = [];
    const visible = commands.filter(
      (c) => c.id !== 'palette.open' && (!c.layer || c.layer === 'global'),
    );
    const pick = (group: 'Actions' | 'Go to') =>
      visible
        .filter((c) => c.group === group)
        .filter((c) => !term || matches(`${c.label} ${c.keywords ?? ''}`, term))
        .slice(0, GROUP_LIMIT)
        .forEach((c) => out.push({ key: `${group}:${c.id}`, group, command: c }));
    pick('Actions');
    if (actionsOnly) return out;
    pick('Go to');
    if (ws) {
      for (const r of records.slice(0, GROUP_LIMIT))
        out.push({ key: `rec:${r.id}`, group: 'Records', target: r, href: targetHref(ws.ws, r) });
      if (term) {
        out.push({
          key: 'search:all',
          group: 'Search',
          everywhere: term,
          href: searchHref(ws.ws, { q: input.trim() }),
        });
        for (const r of hits) {
          if (records.some((x) => x.id === r.id)) continue;
          const href = resultHref(ws.ws, r);
          if (href) out.push({ key: `hit:${r.type}:${r.id}`, group: 'Search', result: r, href });
        }
      }
      for (const r of ws.recent
        .filter((x) => !term || matches(x.label, term))
        .slice(0, GROUP_LIMIT))
        out.push({ key: `recent:${r.id}`, group: 'Recent', target: r, href: targetHref(ws.ws, r) });
      if (!term)
        for (const r of recentSearches)
          out.push({
            key: `rs:${r.handle}`,
            group: 'Recent searches',
            recent: r,
            href: searchHref(ws.ws, recentQuery(r.q, r.filters)),
          });
    }
    return out;
  }, [commands, term, input, actionsOnly, records, hits, recentSearches, ws]);

  const current = options[Math.min(active, options.length - 1)];

  // Leaving the palette for another page: on Compact the sheet's own history entry is replaced
  // by the destination (Back then returns to the page the palette was opened from).
  const go = (href: string) => {
    const replace = pushed.current;
    pushed.current = false;
    closePalette();
    navigate(href, { replace });
  };
  const run = (o: Option, e?: MouseEvent) => {
    if ('command' in o) {
      if (o.command.href && !o.command.run) {
        if ((SHELL_COMMAND_IDS as readonly string[]).includes(o.command.id))
          countCommand(o.command.id as ShellCommandId, 'palette');
        go(o.command.href);
        return;
      }
      close();
      execute(o.command, 'palette');
      return;
    }
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) return; // browser opens a tab
    e?.preventDefault();
    // Choosing the full search submits it: this is the only place the palette remembers one.
    if ('everywhere' in o && ws)
      void searchApi.remember(ws.ws, { ...EMPTY_QUERY, q: input.trim() }).catch(() => undefined);
    go(o.href);
  };

  useEffect(() => {
    const el = current ? document.getElementById(`${id}-${current.key}`) : null;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [current, id]);

  const groups = ['Actions', 'Go to', 'Records', 'Search', 'Recent', 'Recent searches'] as const;
  return (
    <Dialog title="Command palette" onClose={close}>
      <div className={compact ? 'palette palette-sheet' : 'palette'}>
        <label htmlFor={`${id}-input`} className="visually-hidden">
          Search commands, pages, and records
        </label>
        <input
          id={`${id}-input`}
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={current ? `${id}-${current.key}` : undefined}
          aria-describedby={`${id}-hint`}
          autoComplete="off"
          spellCheck={false}
          placeholder="Type a command or search… (> for actions)"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => (options.length ? (a + 1) % options.length : 0));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => (options.length ? (a - 1 + options.length) % options.length : 0));
            } else if (e.key === 'Enter' && current) {
              e.preventDefault();
              run(current);
            }
          }}
        />
        <p id={`${id}-hint`} className="visually-hidden">
          Use the up and down arrow keys to choose, then press Enter.
        </p>
        <div
          id={`${id}-list`}
          ref={listRef}
          role="listbox"
          aria-label="Results"
          className="palette-list"
        >
          {groups.map((g) => {
            const items = options.filter((o) => o.group === g);
            if (!items.length) return null;
            return (
              <div key={g} role="group" aria-labelledby={`${id}-g-${g}`}>
                <p id={`${id}-g-${g}`} className="palette-group" role="presentation">
                  {g}
                </p>
                {items.map((o) => {
                  const selected = current?.key === o.key;
                  if ('command' in o) {
                    const c = o.command;
                    const body = (
                      <>
                        <span className="palette-label">{c.label}</span>
                        {c.shortcut ? (
                          <kbd
                            className="palette-kbd"
                            aria-label={`Shortcut ${shortcutLabel(c.shortcut)}`}
                          >
                            {shortcutLabel(c.shortcut)}
                          </kbd>
                        ) : null}
                      </>
                    );
                    return c.href ? (
                      <a
                        key={o.key}
                        id={`${id}-${o.key}`}
                        role="option"
                        aria-selected={selected}
                        href={c.href}
                        tabIndex={-1}
                        className="palette-option"
                        onMouseMove={() => setActive(options.indexOf(o))}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                          e.preventDefault();
                          run(o);
                        }}
                      >
                        {body}
                      </a>
                    ) : (
                      <div
                        key={o.key}
                        id={`${id}-${o.key}`}
                        role="option"
                        aria-selected={selected}
                        className="palette-option"
                        onMouseMove={() => setActive(options.indexOf(o))}
                        onClick={() => run(o)}
                      >
                        {body}
                      </div>
                    );
                  }
                  if ('everywhere' in o || 'result' in o || 'recent' in o) {
                    return (
                      <a
                        key={o.key}
                        id={`${id}-${o.key}`}
                        role="option"
                        aria-selected={selected}
                        href={o.href}
                        tabIndex={-1}
                        className="palette-option"
                        onMouseMove={() => setActive(options.indexOf(o))}
                        onClick={(e) => run(o, e)}
                      >
                        {'everywhere' in o ? (
                          <>
                            <span className="palette-label">
                              Search everywhere for “{o.everywhere}”
                            </span>
                            <span className="palette-meta">Full search</span>
                          </>
                        ) : 'result' in o ? (
                          <>
                            <BrandMarker
                              marker={o.result.brand}
                              variant="tile"
                              size={16}
                              decorative
                            />
                            <span className="palette-label">{o.result.title}</span>
                            <span className="palette-meta">{kindLabel(o.result.type)}</span>
                          </>
                        ) : (
                          <>
                            <span className="palette-label">{o.recent.q}</span>
                            <span className="palette-meta">Recent search</span>
                          </>
                        )}
                      </a>
                    );
                  }
                  return (
                    <a
                      key={o.key}
                      id={`${id}-${o.key}`}
                      role="option"
                      aria-selected={selected}
                      href={o.href}
                      tabIndex={-1}
                      className="palette-option"
                      onMouseMove={() => setActive(options.indexOf(o))}
                      onClick={(e) => run(o, e)}
                    >
                      <BrandMarker
                        marker={o.target.brand}
                        variant="tile"
                        size={16}
                        decorative={o.target.type === 'brand'}
                      />
                      <span className="palette-label">{o.target.label}</span>
                      <span className="palette-meta">{TARGET_TYPE_LABEL[o.target.type]}</span>
                    </a>
                  );
                })}
              </div>
            );
          })}
          {!options.length ? (
            <p className="palette-empty" role="status">
              {searching ? 'Searching…' : 'No matching commands, pages, or records.'}
            </p>
          ) : null}
        </div>
        {compact ? (
          <button type="button" className="button button-secondary" onClick={close}>
            Close
          </button>
        ) : null}
      </div>
    </Dialog>
  );
}
