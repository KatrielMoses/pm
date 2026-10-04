import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { SHELL_COMMAND_IDS, type ShellCommandId } from '@pm/contracts/shell';
import { useRouter } from '../router.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { BrandMarker } from './brand-marker.tsx';
import { shell, type NavTarget } from './client.ts';
import { useCommands, type Command } from './commands.tsx';
import { shortcutLabel } from './shortcuts.ts';
import { targetHref, TARGET_TYPE_LABEL } from './targets.ts';
import { countCommand } from './telemetry.ts';
import { useWidthClass } from './width.ts';
import { useWorkspaceShell } from './workspace.tsx';

/**
 * Command palette (RS-11, IA-11). Groups in order: Actions, Go to, Records, Recent. Typing `>`
 * first restricts to actions. Every entry comes from the permission-filtered command registry or
 * from server lists re-authorized for this viewer, so unavailable items are absent. Records are
 * only the currently implemented navigable types; full search is Phase 5A. On Compact the palette
 * is a full-screen sheet that owns a history entry, so the system Back gesture closes it (RS-21).
 */

type Option =
  | { key: string; group: 'Actions' | 'Go to'; command: Command }
  | { key: string; group: 'Records' | 'Recent'; target: NavTarget; href: string };

const GROUP_LIMIT = 8;

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
    const t = setTimeout(() => {
      shell.targets(ws.ws, term).then(
        (r) => live && setFound({ term, records: r }),
        () => live && setFound({ term, records: [] }),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ws, lookup, term]);
  const records = useMemo(
    () => (lookup && found.term === term ? found.records : []),
    [lookup, found, term],
  );
  const searching = lookup && found.term !== term;

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
      for (const r of ws.recent
        .filter((x) => !term || matches(x.label, term))
        .slice(0, GROUP_LIMIT))
        out.push({ key: `recent:${r.id}`, group: 'Recent', target: r, href: targetHref(ws.ws, r) });
    }
    return out;
  }, [commands, term, actionsOnly, records, ws]);

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
    go(o.href);
  };

  useEffect(() => {
    const el = current ? document.getElementById(`${id}-${current.key}`) : null;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [current, id]);

  const groups = ['Actions', 'Go to', 'Records', 'Recent'] as const;
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
