import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  decodeViewState,
  pickStore,
  viewSchema,
  viewStateFromSearch,
  viewStateToSearch,
  type ViewKey,
  type ViewStateValue,
} from '@pm/contracts/shell';
import { useRouter } from '../router.tsx';
import { shell } from './client.ts';
import { countDecodeFailure } from './telemetry.ts';

/**
 * View state (NAV-011, RS-20): filters, sort, and grouping live in the URL (shareable, survive
 * Back/Forward and reload) and are also stored per person per device for the next session; the
 * scroll anchor is stored per device and per tab; selection lives only in this tab's session.
 * Changes inside a view replace the history entry (UXD-03). Every source is decoded against the
 * view's allow-listed schema, so corrupt or hostile state degrades to defaults.
 */

const URL_DEBOUNCE_MS = 250;
const DEVICE_DEBOUNCE_MS = 800;

function sessionKey(ws: string, key: ViewKey) {
  return `pm.vs.${ws}.${key}`;
}

function readSession(ws: string, key: ViewKey): ViewStateValue {
  try {
    const raw = sessionStorage.getItem(sessionKey(ws, key));
    if (!raw) return {};
    const decoded = decodeViewState(key, JSON.parse(raw) as unknown, { store: 'session' });
    if (!decoded.ok) {
      countDecodeFailure('local', decoded.reason);
      sessionStorage.removeItem(sessionKey(ws, key));
      return {};
    }
    return decoded.state;
  } catch {
    countDecodeFailure('local', 'malformed');
    return {};
  }
}

function writeSession(ws: string, key: ViewKey, state: ViewStateValue) {
  try {
    sessionStorage.setItem(sessionKey(ws, key), JSON.stringify(pickStore(key, state, 'session')));
  } catch {
    // storage unavailable: per-tab state simply does not persist
  }
}

export function useViewState(ws: string, key: ViewKey) {
  const { search, path, state: historyState, navigate } = useRouter();
  const fromUrl = useMemo(() => {
    const r = viewStateFromSearch(key, search);
    if (!r.ok) {
      countDecodeFailure('url', r.reason);
      return {};
    }
    if (r.dropped) countDecodeFailure('url', 'field');
    return r.state;
  }, [key, search]);
  const [device, setDevice] = useState<ViewStateValue | null>(null);
  const [session, setSession] = useState<ViewStateValue>(() => readSession(ws, key));
  const pendingUrl = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingDevice = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Durable per-device state for this view (a new session restores the last filters and anchor).
  useEffect(() => {
    let live = true;
    shell.viewState(ws, key).then(
      (v) => live && setDevice(v.state),
      () => live && setDevice({}),
    );
    return () => {
      live = false;
    };
  }, [ws, key]);

  // When the URL names none of the view's URL fields, apply the stored ones (replace, no push).
  const applied = useRef(false);
  useEffect(() => {
    if (!device || applied.current) return;
    applied.current = true;
    const urlFields = Object.entries(viewSchema(key)!.fields)
      .filter(([, d]) => (d.stores as readonly string[]).includes('url'))
      .map(([n]) => n);
    if (urlFields.some((n) => search.has(n))) return;
    const stored = pickStore(key, device, 'url');
    if (!Object.keys(stored).length) return;
    const q = viewStateToSearch(key, stored, search);
    navigate(`${path}?${q.toString()}`, { replace: true, state: historyState });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  const merged = useMemo<ViewStateValue>(
    () => ({
      ...(device ? pickStore(key, device, 'device') : {}),
      ...session,
      ...fromUrl,
    }),
    [device, session, fromUrl, key],
  );

  const latest = useRef(merged);
  // URL-owned fields set but not yet written to the URL (debounced): a re-render in between must
  // not replace them with the URL's older values (including fields being removed).
  const pendingUrlFields = useRef<ViewStateValue | null>(null);
  useEffect(() => {
    const pending = pendingUrlFields.current;
    if (!pending) {
      latest.current = merged;
      return;
    }
    const next: ViewStateValue = { ...merged };
    for (const name of Object.keys(pickStore(key, merged, 'url'))) delete next[name];
    latest.current = { ...next, ...pending };
  }, [merged, key]);

  const set = useCallback(
    (patch: Record<string, string | string[] | undefined>) => {
      const next: ViewStateValue = { ...latest.current };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete next[k];
        else next[k] = v;
      }
      latest.current = next;
      const urlPart = pickStore(key, next, 'url');
      const urlChanged = JSON.stringify(urlPart) !== JSON.stringify(pickStore(key, fromUrl, 'url'));
      if (urlChanged) {
        pendingUrlFields.current = urlPart;
        clearTimeout(pendingUrl.current);
        pendingUrl.current = setTimeout(() => {
          pendingUrlFields.current = null;
          const q = viewStateToSearch(
            key,
            pickStore(key, latest.current, 'url'),
            new URLSearchParams(window.location.search),
          );
          const qs = q.toString();
          navigate(`${window.location.pathname}${qs ? `?${qs}` : ''}`, {
            replace: true,
            state: historyState,
          });
        }, URL_DEBOUNCE_MS);
      }
      const sess = pickStore(key, next, 'session');
      setSession(sess);
      writeSession(ws, key, next);
      const dev = pickStore(key, next, 'device');
      clearTimeout(pendingDevice.current);
      pendingDevice.current = setTimeout(() => {
        void shell
          .saveViewState(ws, key, { schema_version: viewSchema(key)!.version, state: dev })
          .then(
            (v) => setDevice(v.state),
            () => undefined,
          );
      }, DEVICE_DEBOUNCE_MS);
    },
    [key, ws, fromUrl, navigate, historyState],
  );

  useEffect(
    () => () => {
      clearTimeout(pendingUrl.current);
    },
    [],
  );

  return { state: merged, set, deviceLoaded: device !== null };
}

/**
 * Scroll by anchor item (RS-20): remembers the first fully visible row and its index, and restores
 * to that row, else to the row now at its former position, else to the top. Rows carry
 * `data-anchor-id`. Never restores to a row that is not rendered (hidden rows are never rendered).
 */
export function useScrollAnchor(
  container: RefObject<HTMLElement | null>,
  ready: boolean,
  saved: { anchor?: string | undefined; position?: string | undefined },
  onAnchor: (anchor: string, position: number) => void,
) {
  const restored = useRef(false);
  useEffect(() => {
    if (!ready || restored.current || !container.current) return;
    restored.current = true;
    const rows = [...container.current.querySelectorAll<HTMLElement>('[data-anchor-id]')];
    const byId = saved.anchor ? rows.find((r) => r.dataset.anchorId === saved.anchor) : undefined;
    const byPos =
      !byId && saved.position !== undefined
        ? rows[Math.min(Number(saved.position), rows.length - 1)]
        : undefined;
    (byId ?? byPos)?.scrollIntoView?.({ block: 'start' });
  }, [ready, container, saved.anchor, saved.position]);

  useEffect(() => {
    if (!ready) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const rows = [
          ...(container.current?.querySelectorAll<HTMLElement>('[data-anchor-id]') ?? []),
        ];
        const header = document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? 0;
        const i = rows.findIndex((r) => r.getBoundingClientRect().top >= header);
        if (i >= 0) onAnchor(rows[i]!.dataset.anchorId!, i);
      }, 200);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      window.removeEventListener('scroll', onScroll);
    };
  }, [ready, container, onAnchor]);
}

/**
 * Prunes a selection to the items currently shown (RS-20) before any bulk action; returns the
 * pruned selection and how many were removed (for the polite announcement).
 */
export function pruneSelection(
  selected: readonly string[],
  visible: readonly string[],
): { kept: string[]; removed: number } {
  const shown = new Set(visible);
  const kept = selected.filter((id) => shown.has(id));
  return { kept, removed: selected.length - kept.length };
}
