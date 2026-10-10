import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError } from '../api.ts';
import { Link } from '../router.tsx';
import { BrandMarker, MarkerStack, summaryMarker } from '../shell/brand-marker.tsx';
import type { ShellContext } from '../shell/client.ts';
import { useRegisterCommands } from '../shell/commands.tsx';
import { routeHref } from '../shell/registry.ts';
import { useWidthClass } from '../shell/width.ts';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Banner } from '../ui/feedback.tsx';

/**
 * The brand-scope switcher (WSB-006; IA-23, RS-04): one brand, several brands, or all brands the
 * person can access. It lists only what the server returned for this person (active brands, then
 * a collapsed archived group), never hidden names or counts. A sole accessible brand is a plain
 * label. Ctrl/⌘+Shift+B and the palette open it. Choosing a scope asks the server, which validates
 * every brand and stores the per-device default; the URL then carries the normalized scope.
 */

export function scopeLabel(ctx: ShellContext): string {
  const s = ctx.scope;
  if (s.kind === 'none') return 'No brands';
  if (s.kind === 'all') return 'All brands';
  if (s.kind === 'brand') return ctx.brands.find((b) => b.id === s.brand_id)?.name ?? 'Brand';
  return `${s.brand_ids.length} brands`;
}

function selectedIds(ctx: ShellContext): string[] {
  const s = ctx.scope;
  return s.kind === 'brand' ? [s.brand_id] : s.kind === 'brands' ? s.brand_ids : [];
}

export function ScopeSwitcher({ placement }: { placement: 'header' | 'rail' | 'bar' }) {
  const shell = useWorkspaceShell();
  const width = useWidthClass();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const ctx = shell?.context ?? null;
  const usable = ctx !== null && ctx.principal === 'member' && ctx.brands.length > 1;
  useRegisterCommands(
    usable
      ? [
          {
            id: 'scope.switch',
            label: 'Switch brand…',
            group: 'Actions',
            keywords: 'scope brand all brands',
            shortcut: 'Mod+Shift+B',
            run: () => setOpen(true),
          },
        ]
      : [],
  );
  if (!ctx || ctx.principal !== 'member' || !shell) return null;
  if (ctx.brands.length === 0) return <span className="scope-label">No active brands</span>;
  if (ctx.brands.length === 1)
    // IA-23: a sole accessible brand is a non-interactive label.
    return (
      <span className="scope-label" aria-label={`Brand: ${ctx.brands[0]!.name}`}>
        <BrandMarker
          marker={summaryMarker(ctx.brands[0]!)}
          variant={placement === 'rail' ? 'tile' : 'marker'}
        />
      </span>
    );
  const label = scopeLabel(ctx);
  const markers =
    ctx.scope.kind === 'brand'
      ? null
      : (ctx.scope.kind === 'all'
          ? ctx.brands
          : ctx.brands.filter((b) => selectedIds(ctx).includes(b.id))
        ).map((b) => summaryMarker(b));
  const single =
    ctx.scope.kind === 'brand' ? ctx.brands.find((b) => b.id === selectedIds(ctx)[0]) : undefined;
  const compact = width === 'compact';
  return (
    <div className={`scope scope-${placement}`}>
      <button
        ref={trigger}
        type="button"
        className="scope-trigger"
        aria-haspopup={compact ? 'dialog' : 'listbox'}
        aria-expanded={open}
        aria-label={`Brand scope: ${label}. Change brand scope`}
        title={ctx.scope.kind === 'all' ? 'All brands you can access' : label}
        onClick={() => setOpen((o) => !o)}
      >
        {single ? (
          <BrandMarker
            marker={summaryMarker(single)}
            variant={placement === 'rail' ? 'tile' : 'marker'}
          />
        ) : (
          <MarkerStack markers={markers ?? []} label={placement === 'rail' ? '' : label} />
        )}
        <span aria-hidden="true" className="scope-caret">
          ▾
        </span>
      </button>
      {open ? (
        compact ? (
          <Dialog title="Brand scope" onClose={() => setOpen(false)}>
            <ScopeOptions ctx={ctx} onDone={() => setOpen(false)} sheet />
          </Dialog>
        ) : (
          <ScopePopover onClose={() => setOpen(false)} trigger={trigger}>
            <ScopeOptions ctx={ctx} onDone={() => setOpen(false)} />
          </ScopePopover>
        )
      ) : null}
    </div>
  );
}

/** Non-modal popover: Esc or a click outside closes it and focus returns to the trigger. */
function ScopePopover({
  children,
  onClose,
  trigger,
}: {
  children: React.ReactNode;
  onClose: () => void;
  trigger: React.RefObject<HTMLButtonElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node) || trigger.current?.contains(e.target as Node))
        return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, trigger]);
  return (
    <div ref={ref} className="scope-popover">
      {children}
    </div>
  );
}

function ScopeOptions({
  ctx,
  onDone,
  sheet = false,
}: {
  ctx: ShellContext;
  onDone: () => void;
  sheet?: boolean;
}) {
  const shell = useWorkspaceShell()!;
  const id = useId();
  const [multi, setMulti] = useState(ctx.scope.kind === 'brands');
  // From "All brands", multi-select starts with every brand checked (uncheck to narrow).
  const [checked, setChecked] = useState<string[]>(
    ctx.scope.kind === 'all' ? ctx.brands.map((b) => b.id) : selectedIds(ctx),
  );
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showArchived, setShowArchived] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const items: Array<{ id: string; label: string }> = [
    ...(multi ? [] : [{ id: 'all', label: 'All brands' }]),
    ...ctx.brands.map((b) => ({ id: b.id, label: b.name })),
  ];
  useEffect(() => {
    list.current?.focus();
  }, [multi]);
  const choose = async (
    sel:
      | { scope: 'all' }
      | { scope: 'brand'; brand_id: string }
      | { scope: 'brands'; brand_ids: string[] },
  ) => {
    setBusy(true);
    setError(null);
    try {
      await shell.selectScope(sel);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const pick = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (multi)
      setChecked((c) => (c.includes(item.id) ? c.filter((x) => x !== item.id) : [...c, item.id]));
    else void choose(item.id === 'all' ? { scope: 'all' } : { scope: 'brand', brand_id: item.id });
  };
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(items.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(active);
    }
  };
  const current = selectedIds(ctx);
  const isSelected = (itemId: string) =>
    multi
      ? checked.includes(itemId)
      : itemId === 'all'
        ? ctx.scope.kind === 'all'
        : current.length === 1 && current[0] === itemId;
  return (
    <div className={sheet ? 'scope-options scope-sheet' : 'scope-options'}>
      <p id={`${id}-desc`} className="hint">
        All brands means every active brand you can access.
      </p>
      <ul
        ref={list}
        id={`${id}-list`}
        role="listbox"
        aria-label={multi ? 'Choose brands' : 'Brand scope'}
        aria-multiselectable={multi || undefined}
        aria-describedby={`${id}-desc`}
        aria-activedescendant={`${id}-o-${active}`}
        aria-busy={busy}
        tabIndex={0}
        className="scope-list"
        onKeyDown={onKey}
      >
        {items.map((item, i) => {
          const b = ctx.brands.find((x) => x.id === item.id);
          return (
            <li
              key={item.id}
              id={`${id}-o-${i}`}
              role="option"
              aria-selected={isSelected(item.id)}
              className={i === active ? 'scope-option scope-option-active' : 'scope-option'}
              onClick={() => {
                setActive(i);
                pick(i);
              }}
            >
              {multi ? (
                <span className="scope-check" aria-hidden="true">
                  {checked.includes(item.id) ? '☑' : '☐'}
                </span>
              ) : null}
              {b ? (
                <BrandMarker marker={summaryMarker(b)} />
              ) : (
                <span className="marker-name">All brands</span>
              )}
              {!multi && isSelected(item.id) ? <span className="scope-current" /> : null}
            </li>
          );
        })}
      </ul>
      <div className={sheet ? 'actions scope-actions sticky-actions' : 'actions scope-actions'}>
        {multi ? (
          <>
            <button
              type="button"
              className="button button-primary"
              disabled={busy || checked.length === 0}
              onClick={() =>
                void choose(
                  checked.length === 1
                    ? { scope: 'brand', brand_id: checked[0]! }
                    : { scope: 'brands', brand_ids: checked },
                )
              }
            >
              Apply ({checked.length})
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setMulti(false)}
            >
              Back to single brand
            </button>
          </>
        ) : (
          <button type="button" className="button button-secondary" onClick={() => setMulti(true)}>
            Select multiple…
          </button>
        )}
      </div>
      {ctx.archived_brands?.length ? (
        <div className="scope-archived">
          <button
            type="button"
            className="button button-ghost"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((s) => !s)}
          >
            Archived brands
          </button>
          {showArchived ? (
            <ul className="plain-list">
              {ctx.archived_brands.map((b) => (
                <li key={b.id}>
                  <Link
                    to={routeHref('brand', { ws: ctx.workspace.id, brand: b.id })}
                    onClick={onDone}
                  >
                    <BrandMarker marker={summaryMarker(b, true)} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <Banner
          tone="danger"
          title={
            error instanceof ApiError && error.code === 'not_found'
              ? "That brand isn't available anymore"
              : error instanceof ApiError && error.offline
                ? "You're offline. Try again when you're connected."
                : "We couldn't switch. Try again."
          }
        />
      ) : null}
    </div>
  );
}
