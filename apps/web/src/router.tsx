import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from 'react';

interface RouterState {
  path: string;
  search: URLSearchParams;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterState | null>(null);

/**
 * Minimal history router. On every navigation focus moves to the page heading (0E A11Y focus
 * rules) and the document title updates, so screen-reader users hear the new page.
 */
export function Router({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(() => ({
    path: window.location.pathname,
    search: window.location.search,
  }));

  useEffect(() => {
    const onPop = () =>
      setLocation({ path: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string, options: { replace?: boolean } = {}) => {
    if (options.replace) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    const url = new URL(to, window.location.origin);
    setLocation({ path: url.pathname, search: url.search });
  }, []);

  return (
    <RouterContext.Provider
      value={{ path: location.path, search: new URLSearchParams(location.search), navigate }}
    >
      {children}
    </RouterContext.Provider>
  );
}

export function useRouter(): RouterState {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter outside Router');
  return ctx;
}

export function Link({
  to,
  children,
  ...rest
}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
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
        navigate(to);
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
 * public-ID characters only; anything else does not match (the page is then "not found").
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
