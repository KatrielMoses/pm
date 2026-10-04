import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { parseScopeToken } from '@pm/contracts/shell';
import { ApiError } from '../api.ts';
import { useRouter } from '../router.tsx';
import { shell, type NavTarget, type RecentItem, type ShellContext } from './client.ts';
import { usePreferences } from './preferences.tsx';
import { matchRoute, type Access } from './registry.ts';
import { countDecodeFailure } from './telemetry.ts';

/**
 * Workspace shell state: the server-derived context (scope, accessible brands, capabilities) and
 * the personal lists shown in navigation. Everything is re-checked on every navigation, so a lost
 * membership, grant, or brand disappears on the next page even if this tab cached it (AT-108,
 * AT-114). Scope lives in the URL on scope-sensitive pages and in the history entry elsewhere, so
 * reload, new tabs, and Back reproduce it (IA-24, IA-25, RS-21).
 */

export interface ScopeNotice {
  kind: 'switched' | 'reverted' | 'normalized';
  /** The brand name for `switched` (an authorized brand from this context only). */
  brand?: string;
}

interface WorkspaceShellState {
  ws: string;
  context: ShellContext | null;
  failure: unknown;
  access: Access | null;
  favorites: NavTarget[];
  recent: RecentItem[];
  /** The scope token requested by this history entry (URL or entry state), if any. */
  requested: string | null;
  notice: ScopeNotice | null;
  dismissNotice: () => void;
  selectScope: (
    sel:
      | { scope: 'all' }
      | { scope: 'brand'; brand_id: string }
      | { scope: 'brands'; brand_ids: string[] },
  ) => Promise<void>;
  /** IA-25: a record of another brand opened; the shell scope follows it (tab-local). */
  enterRecordBrand: (brandId: string) => void;
  revertScope: () => void;
  refreshLists: () => void;
  /** Re-reads the server context (after a change to brands this page made itself). */
  reloadContext: () => void;
}

const WorkspaceShellContext = createContext<WorkspaceShellState | null>(null);

export function WorkspaceShellProvider({ ws, children }: { ws: string; children: ReactNode }) {
  const { path, search, state, navigate, setState } = useRouter();
  const { preferences } = usePreferences();
  const route = matchRoute(path);
  const scopeSensitive = route?.def.scopeSensitive === true;
  const urlToken = search.get('scope');
  const requested = scopeSensitive ? urlToken : (state.scope ?? null);
  const [context, setContext] = useState<ShellContext | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [favorites, setFavorites] = useState<NavTarget[]>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [notice, setNotice] = useState<ScopeNotice | null>(null);
  const [listNonce, setListNonce] = useState(0);
  const [contextNonce, setContextNonce] = useState(0);
  const seq = useRef(0);

  // Context: re-derived for every history entry (path, query, or entry state change).
  const locationKey = `${path}?${search.toString()}#${requested ?? ''}`;
  useEffect(() => {
    const mine = ++seq.current;
    if (urlToken && scopeSensitive && !parseScopeToken(urlToken))
      countDecodeFailure('url', 'malformed');
    shell.context(ws, requested).then(
      (ctx) => {
        if (mine !== seq.current) return;
        setFailure(null);
        setContext(ctx);
        // Normalize the address bar or entry to the server's (narrowed, never broadened) scope.
        if (ctx.scope_token && requested && ctx.scope_token !== requested) {
          setNotice({ kind: 'normalized' });
          if (scopeSensitive) {
            const q = new URLSearchParams(search);
            q.set('scope', ctx.scope_token);
            navigate(`${path}?${q.toString()}`, { replace: true, state });
          } else setState({ ...state, scope: ctx.scope_token });
        } else if (scopeSensitive && !urlToken && ctx.scope_token) {
          const q = new URLSearchParams(search);
          q.set('scope', ctx.scope_token);
          navigate(`${path}?${q.toString()}`, { replace: true, state });
        }
      },
      (err: unknown) => {
        if (mine !== seq.current) return;
        setContext(null);
        setFailure(err);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, locationKey, contextNonce]);

  // Personal lists for navigation (favorites, the recent five): also re-checked per navigation.
  const memberOrGuest = context !== null;
  useEffect(() => {
    if (!memberOrGuest) return;
    let active = true;
    Promise.all([shell.favorites(ws), shell.recent(ws, { limit: 'sidebar' })]).then(
      ([f, r]) => {
        if (!active) return;
        setFavorites(f);
        setRecent(r);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [ws, memberOrGuest, path, listNonce]);

  const selectScope = useCallback<WorkspaceShellState['selectScope']>(
    async (sel) => {
      const ctx = await shell.select(ws, sel);
      setContext(ctx);
      const token = ctx.scope_token ?? undefined;
      if (scopeSensitive) {
        const q = new URLSearchParams(search);
        if (token) q.set('scope', token);
        navigate(`${path}?${q.toString()}`);
      } else
        navigate(`${path}${search.size ? `?${search.toString()}` : ''}`, {
          state: { scope: token },
        });
    },
    [ws, scopeSensitive, search, path, navigate],
  );

  const enterRecordBrand = useCallback(
    (brandId: string) => {
      if (!context || scopeSensitive) return;
      const s = context.scope;
      const inScope =
        (s.kind === 'brand' && s.brand_id === brandId) ||
        ((s.kind === 'brands' || s.kind === 'all') && s.brand_ids.includes(brandId));
      if (inScope) return;
      const brand = context.brands.find((b) => b.id === brandId);
      if (!brand) return; // archived or not in this principal's active brands: no switch
      setState({
        ...state,
        scope: `brand:${brandId}`,
        ...(context.scope_token ? { previousScope: context.scope_token } : {}),
      });
      setNotice({ kind: 'switched', brand: brand.name });
    },
    [context, scopeSensitive, setState, state],
  );

  const revertScope = useCallback(() => {
    if (!state.previousScope) return;
    setState({ scope: state.previousScope });
    setNotice({ kind: 'reverted' });
  }, [setState, state.previousScope]);

  const access = useMemo<Access | null>(
    () =>
      context
        ? {
            principal: context.principal,
            capabilities: context.workspace.capabilities,
            hidden: preferences.hidden_destinations,
          }
        : null,
    [context, preferences.hidden_destinations],
  );

  const value = useMemo<WorkspaceShellState>(
    () => ({
      ws,
      context,
      failure,
      access,
      favorites: context ? favorites : [],
      recent: context ? recent : [],
      requested,
      notice,
      dismissNotice: () => setNotice(null),
      selectScope,
      enterRecordBrand,
      revertScope,
      refreshLists: () => setListNonce((n) => n + 1),
      reloadContext: () => setContextNonce((n) => n + 1),
    }),
    [
      ws,
      context,
      failure,
      access,
      favorites,
      recent,
      requested,
      notice,
      selectScope,
      enterRecordBrand,
      revertScope,
    ],
  );
  return <WorkspaceShellContext.Provider value={value}>{children}</WorkspaceShellContext.Provider>;
}

export function useWorkspaceShell(): WorkspaceShellState | null {
  return useContext(WorkspaceShellContext);
}

/** True when the failure means "no access or no such workspace" (one indistinguishable state). */
export function isNotAvailable(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden');
}

/**
 * Records a visit after a successful authorized render (NAV-007): called by record pages once
 * their data has loaded, never for probes, failures, or background loads. Failures are ignored
 * so the page never depends on the write.
 */
export function useRecordVisit(target: string | null): void {
  const shellState = useWorkspaceShell();
  const ws = shellState?.ws;
  const refresh = shellState?.refreshLists;
  useEffect(() => {
    if (!ws || !target) return;
    // The page calls this only once its data rendered; repeats inside the coalescing window are
    // absorbed by the server (no write), so a double effect never double-counts.
    shell.recordVisit(ws, target).then(
      () => refresh?.(),
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, target]);
}
