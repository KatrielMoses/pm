import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from 'react';

/**
 * Per-entry history state (RS-21): the tab-local scope token for pages whose URL carries no scope,
 * and a sheet marker so the system Back gesture closes a Compact full-screen sheet. Never holds
 * titles, names, or anything not already in the URL or the visible page.
 */
export interface HistoryState {
  scope?: string;
  /** The scope before an automatic switch into a record's brand (IA-25 "Back to previous scope"). */
  previousScope?: string;
  sheet?: string;
}

interface NavigateOptions {
  replace?: boolean;
  state?: HistoryState;
}

interface RouterState {
  path: string;
  search: URLSearchParams;
  state: HistoryState;
  navigate: (to: string, options?: NavigateOptions) => void;
  /** Replaces only the history state of the current entry (no URL change). */
  setState: (state: HistoryState) => void;
  /**
   * Registers a leave guard (RS-25): while it returns true, in-app navigation asks first. Returns
   * an unregister function.
   */
  guard: (blocking: () => boolean) => () => void;
}

const RouterContext = createContext<RouterState | null>(null);

function readState(): HistoryState {
  const s = window.history.state as unknown;
  if (!s || typeof s !== 'object') return {};
  const o = s as Record<string, unknown>;
  const out: HistoryState = {};
  for (const k of ['scope', 'previousScope', 'sheet'] as const)
    if (typeof o[k] === 'string' && (o[k] as string).length <= 2048) out[k] = o[k] as string;
  return out;
}

/**
 * History router. On every navigation focus moves to the page heading (0E A11Y focus rules) and
 * the document title updates, so screen-reader users hear the new page. Push and replace follow
 * RS-21; leave guards follow RS-25.
 */
export function Router({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(() => ({
    path: window.location.pathname,
    search: window.location.search,
    state: readState(),
  }));
  const guards = useRef(new Set<() => boolean>());
  const [pending, setPending] = useState<null | (() => void)>(null);
  const current = useRef(window.location.pathname + window.location.search);

  const blocked = () => [...guards.current].some((g) => g());

  useEffect(() => {
    const onPop = () => {
      const next = window.location.pathname + window.location.search;
      if (blocked()) {
        // Undo the browser's move, then ask (Stay keeps the page; Leave repeats the navigation).
        const target = next;
        window.history.pushState(null, '', current.current);
        setPending(() => () => {
          guards.current.clear();
          window.history.pushState(null, '', target);
          current.current = target;
          setLocation({
            path: window.location.pathname,
            search: window.location.search,
            state: {},
          });
        });
        return;
      }
      current.current = next;
      setLocation({
        path: window.location.pathname,
        search: window.location.search,
        state: readState(),
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((to: string, options: NavigateOptions = {}) => {
    const state = options.state ?? null;
    if (options.replace) window.history.replaceState(state, '', to);
    else window.history.pushState(state, '', to);
    const url = new URL(to, window.location.origin);
    current.current = url.pathname + url.search;
    setLocation({ path: url.pathname, search: url.search, state: options.state ?? {} });
  }, []);

  const navigate = useCallback(
    (to: string, options: NavigateOptions = {}) => {
      if (!options.replace && blocked()) {
        setPending(() => () => {
          guards.current.clear();
          go(to, options);
        });
        return;
      }
      go(to, options);
    },
    [go],
  );

  const setState = useCallback((state: HistoryState) => {
    window.history.replaceState(state, '', window.location.pathname + window.location.search);
    setLocation((l) => ({ ...l, state }));
  }, []);

  const guard = useCallback((blocking: () => boolean) => {
    guards.current.add(blocking);
    return () => {
      guards.current.delete(blocking);
    };
  }, []);

  const value = useMemo(
    () => ({
      path: location.path,
      search: new URLSearchParams(location.search),
      state: location.state,
      navigate,
      setState,
      guard,
    }),
    [location, navigate, setState, guard],
  );

  return (
    <RouterContext.Provider value={value}>
      {children}
      {pending ? (
        <LeaveConfirm
          onStay={() => setPending(null)}
          onLeave={() => {
            const run = pending;
            setPending(null);
            run();
          }}
        />
      ) : null}
    </RouterContext.Provider>
  );
}

/** RS-25: Stay is the default focus; Leave discards unsaved, non-draftable input. */
function LeaveConfirm({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    stay.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onStay();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onStay]);
  return (
    <div className="scrim">
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="leave-title"
        aria-describedby="leave-desc"
      >
        <h2 id="leave-title">Leave without saving?</h2>
        <p id="leave-desc" className="dialog-desc">
          Your changes on this page haven't been saved.
        </p>
        <div className="actions">
          <button ref={stay} type="button" className="button button-primary" onClick={onStay}>
            Stay
          </button>
          <button type="button" className="button button-secondary" onClick={onLeave}>
            Leave without saving
          </button>
        </div>
      </div>
    </div>
  );
}

export function useRouter(): RouterState {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter outside Router');
  return ctx;
}

/**
 * RS-25: while `dirty`, in-app navigation asks for confirmation; closing the tab uses the browser's
 * own prompt only when `pendingSave` (input not yet sent to the server).
 */
export function useLeaveGuard(dirty: boolean, pendingSave = false): void {
  const { guard } = useRouter();
  const ref = useRef(dirty);
  useEffect(() => {
    ref.current = dirty;
  }, [dirty]);
  useEffect(() => guard(() => ref.current), [guard]);
  useEffect(() => {
    if (!pendingSave) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [pendingSave]);
}

/**
 * Every navigational element is a real link (RS-24): modified clicks, middle clicks, and "Open in
 * new tab" keep browser behavior; plain clicks push a history entry.
 */
export function Link({
  to,
  children,
  state,
  replace,
  ...rest
}: {
  to: string;
  children: ReactNode;
  state?: HistoryState;
  replace?: boolean;
} & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        )
          return;
        e.preventDefault();
        navigate(to, { ...(state ? { state } : {}), ...(replace ? { replace } : {}) });
      }}
    >
      {children}
    </a>
  );
}

/** Reads a one-time token from the URL fragment, then removes it from the address bar. */
export function takeFragmentToken(): string | undefined {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]{43})/.exec(window.location.hash);
  if (window.location.hash)
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return m?.[1];
}

/**
 * Matches `/workspaces/:ws/brands/:brand`-style patterns. Parameters are single path segments of
 * public-ID characters only; anything else does not match (the page is then "not available").
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const s = path.split('/');
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    const seg = s[i]!;
    if (part.startsWith(':')) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(seg)) return null;
      params[part.slice(1)] = seg;
    } else if (part !== seg) return null;
  }
  return params;
}
