import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LiveEngine, type LiveOptions, type LiveState } from './live-engine.ts';
import type { PresenceEntry } from './live-client.ts';
import type { LiveConflict } from './live-apply.ts';
import type { Block, References } from './client.ts';
import { blockSummary } from './render.tsx';
import { toBlock, type EditBlock } from './model.ts';

/**
 * The screen side of live editing (ADR-0027, UXD-17, UXD-18): the status line, who is here, the
 * choices for blocks that changed under you, and the hook that owns an engine for as long as the
 * editor is open. Nothing here decides anything about the document.
 */

const IDLE: LiveState = {
  phase: 'off',
  reason: null,
  locked: null,
  mode: null,
  active: false,
  paused: false,
  blocks: [],
  viewBlocks: [],
  references: {},
  conflicts: [],
  presence: [],
  unsent: false,
  serverDirty: false,
  savedAt: null,
  contentVersion: null,
  issues: new Map(),
  notice: null,
  here: new Map(),
};
const noopSubscribe = () => () => undefined;

export function useLiveEngine(
  opts: LiveOptions & { enabled: boolean },
): { engine: LiveEngine | null; state: LiveState } {
  const [engine, setEngine] = useState<LiveEngine | null>(null);
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });
  const { ws, doc, mode, enabled } = opts;
  useEffect(() => {
    if (!enabled) return;
    const e = new LiveEngine({
      ...latest.current,
      // The engine always asks the newest callbacks (the editor re-renders; the engine does not).
      getBlocks: () => latest.current.getBlocks(),
      onBlocks: (b) => latest.current.onBlocks(b),
      ...(latest.current.loadBase ? { loadBase: () => latest.current.loadBase!() } : {}),
    });
    setEngine(e);
    const visible = () => e.setVisible(document.visibilityState !== 'hidden');
    const on = () => e.setOnline(true);
    const off = () => e.setOnline(false);
    const hide = () => e.pageHide();
    const show = (ev: PageTransitionEvent) => {
      if (ev.persisted) e.pageShow();
    };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    document.addEventListener('visibilitychange', visible);
    void e.start();
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      document.removeEventListener('visibilitychange', visible);
      e.dispose();
      setEngine(null);
    };
  }, [ws, doc, mode, enabled]);
  const state = useSyncExternalStore(
    engine ? engine.subscribe : noopSubscribe,
    engine ? engine.getState : () => IDLE,
  );
  return { engine, state };
}

/** Re-renders now and then, so "saved 3 minutes ago" stays true. */
export function useTick(ms = 30_000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

export function savedAgo(at: number, now = Date.now()): string {
  const mins = Math.floor(Math.max(0, now - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  return new Date(at).toLocaleDateString();
}

/** The one place that says how live editing is going. Never a toast. */
export function LiveStatusLine({
  state,
  onRetry,
  quietWhenPlain = false,
}: {
  state: LiveState;
  onRetry?: () => void;
  /** Read-only views say nothing while the plain page is simply shown. */
  quietWhenPlain?: boolean;
}) {
  useTick();
  const { phase } = state;
  if (phase === 'off') return null;
  if (quietWhenPlain && (phase === 'fallback' || phase === 'joining')) return null;
  let label: string;
  let detail = '';
  switch (phase) {
    case 'joining':
      label = 'Connecting to live editing…';
      break;
    case 'live':
      label = 'Live';
      if (state.paused) detail = ' — updates paused while this tab is in the background';
      else if (state.mode === 'view') detail = ' — viewing';
      else if (state.savedAt) detail = ` — saved ${savedAgo(state.savedAt)}`;
      break;
    case 'reconnecting':
      label = 'Reconnecting…';
      break;
    case 'offline':
      label =
        'Offline — your edits are kept on this device and sent when you reconnect';
      break;
    case 'fallback':
      label = `Editing without live updates (${state.reason ?? "it isn't available"})`;
      break;
    case 'locked':
      label =
        state.locked === 'archived'
          ? 'This document is archived'
          : 'You no longer have access';
      break;
  }
  return (
    <p className="live-status" data-phase={phase}>
      <span className="live-status-label" role="status" aria-live="polite">
        {label}
      </span>
      {detail ? <span className="live-status-detail">{detail}</span> : null}
      {phase === 'live' && state.mode === 'edit' && state.serverDirty && state.savedAt ? (
        <span className="live-status-detail">
          {' '}
          (newer changes are shared but not a saved version yet)
        </span>
      ) : null}
      {phase === 'fallback' && onRetry ? (
        <>
          {' '}
          <button type="button" className="button button-ghost" onClick={onRetry}>
            Try live editing again
          </button>
        </>
      ) : null}
    </p>
  );
}

/** A polite note about what just happened to the document (other people's changes). */
export function LiveNotice({ state }: { state: LiveState }) {
  return (
    <p className="visually-hidden" role="status" aria-live="polite">
      {state.notice?.text ?? ''}
    </p>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Who else is here: names the server sent, each with a colour swatch and a text label. */
export function PresenceList({ presence }: { presence: PresenceEntry[] }) {
  const others = presence.filter((p) => !p.you && p.name);
  const editing = others.filter((p) => p.mode === 'edit').length;
  const viewing = others.length - editing;
  const summary = others.length
    ? [
        editing ? `${plural(editing, 'other', 'others')} editing` : '',
        viewing ? `${viewing} viewing` : '',
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  // Counts are announced when they settle, not on every flicker.
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setAnnounced(summary), 800);
    return () => clearTimeout(t);
  }, [summary]);
  if (!others.length)
    return <p className="visually-hidden" role="status" aria-live="polite">{announced}</p>;
  return (
    <div className="live-presence">
      <p className="live-presence-summary" id="live-presence-summary">
        {summary}
      </p>
      <ul className="live-chips" aria-label="People here" aria-describedby="live-presence-summary">
        {others.map((p) => (
          <li key={p.peer} className="live-chip" data-color={p.color % 8}>
            <span className="live-swatch" aria-hidden="true" />
            <span className="live-chip-name">{p.name}</span>
            <span className="live-chip-mode"> ({p.mode === 'edit' ? 'editing' : 'viewing'})</span>
          </li>
        ))}
      </ul>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announced}
      </p>
    </div>
  );
}

const CONFLICT_COPY: Record<LiveConflict['kind'], (by: string) => string> = {
  changed: (by) => `Updated by ${by} — review`,
  deleted_by_them: (by) => `Deleted by ${by} — review`,
  deleted_by_me: (by) => `You deleted this and ${by} changed it — review`,
};
export const conflictNote = (c: LiveConflict) =>
  CONFLICT_COPY[c.kind](c.by ?? 'another editor');

/** Blocks that changed under you: each has two honest choices and nothing is dropped silently. */
export function ConflictPanel({
  conflicts,
  blocks,
  refs,
  onResolve,
  onFocusBlock,
}: {
  conflicts: LiveConflict[];
  blocks: EditBlock[];
  refs: References;
  onResolve: (id: string, side: 'mine' | 'theirs') => void;
  onFocusBlock: (id: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const summary = (b: Block | null) => (b ? blockSummary(b, refs) || '(empty)' : '(deleted)');
  const mineBlock = (c: LiveConflict) => (c.mine ? toBlock(c.mine, false) : null);
  const pending = useMemo(() => conflicts.map((c) => c.id), [conflicts]);
  if (!conflicts.length) return null;
  const resolve = (id: string, side: 'mine' | 'theirs') => {
    onResolve(id, side);
    const rest = pending.filter((p) => p !== id);
    if (rest.length) setTimeout(() => heading.current?.focus(), 0);
    else setTimeout(() => onFocusBlock(id), 0);
  };
  return (
    <section className="card live-review" aria-labelledby="live-review-h">
      <h3 id="live-review-h" tabIndex={-1} ref={heading}>
        {plural(conflicts.length, 'change', 'changes')} to review
      </h3>
      <p className="hint">
        Someone else changed {conflicts.length === 1 ? 'a block' : 'blocks'} you were editing. Your
        text is kept as you typed it. Choose which to keep for each; nothing is dropped until you
        choose.
      </p>
      <ul className="plain-list">
        {conflicts.map((c) => {
          const n = blocks.findIndex((b) => b.id === c.id) + 1;
          const where = n > 0 ? `block ${n}` : 'a deleted block';
          return (
            <li key={c.id} className="live-review-row" data-block-id={c.id}>
              <p className="live-review-title" id={`live-rv-${c.id}`}>
                <strong>{n > 0 ? `Block ${n}` : 'Deleted block'}:</strong> {conflictNote(c)}
              </p>
              <div className="doc-review-cols">
                <div>
                  <p className="doc-review-label">Your version</p>
                  <p className="doc-review-text">{summary(mineBlock(c))}</p>
                </div>
                <div>
                  <p className="doc-review-label">Their version</p>
                  <p className="doc-review-text">{summary(c.theirs)}</p>
                </div>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="button button-primary"
                  aria-describedby={`live-rv-${c.id}`}
                  onClick={() => resolve(c.id, 'mine')}
                >
                  Keep mine <span className="visually-hidden">for {where}</span>
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  aria-describedby={`live-rv-${c.id}`}
                  onClick={() => resolve(c.id, 'theirs')}
                >
                  Take theirs <span className="visually-hidden">for {where}</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
