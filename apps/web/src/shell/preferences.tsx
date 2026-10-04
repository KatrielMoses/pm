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
import { DEFAULT_PREFERENCES, type DevicePreferences, type Preferences } from '@pm/contracts/shell';
import { ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { applyAppearance, cachedAppearance, followSystemTheme } from './appearance.ts';
import { shell } from './client.ts';
import { finePointer } from './width.ts';

/**
 * One typed personal-preference contract (0B `account_preference`): server-synced for the signed-in
 * account, applied immediately without a reload, and cached locally for pre-paint theming only.
 */
interface PreferencesState {
  preferences: Preferences;
  /** True once the server values are known for the signed-in account. */
  loaded: boolean;
  /** Single-key and sequence shortcuts are active (UXD-04: `auto` = on for fine pointers). */
  singleKeyShortcuts: boolean;
  update: (patch: Partial<Preferences>) => Promise<void>;
  /** Device-local preferences (sidebar collapse); never sent to the server. */
  device: DevicePreferences;
  updateDevice: (patch: Partial<DevicePreferences>) => void;
}

const DEVICE_STORAGE = 'pm.device-preferences';

function readDevice(): DevicePreferences {
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICE_STORAGE) ?? 'null') as unknown;
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return { sidebar: o.sidebar === 'collapsed' ? 'collapsed' : 'expanded' };
  } catch {
    return { sidebar: 'expanded' };
  }
}

const PreferencesContext = createContext<PreferencesState | null>(null);

function withoutVersion(p: Preferences & { version: number }): Preferences {
  return {
    theme: p.theme,
    density: p.density,
    motion: p.motion,
    shortcuts: p.shortcuts,
    record_open: p.record_open,
    start_destination: p.start_destination,
    hidden_destinations: p.hidden_destinations,
  };
}

function initial(): Preferences {
  const cached = cachedAppearance();
  return { ...DEFAULT_PREFERENCES, hidden_destinations: [], ...(cached ?? {}) };
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [prefs, setPrefs] = useState<Preferences>(initial);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [device, setDevice] = useState<DevicePreferences>(readDevice);
  const updateDevice = useCallback((patch: Partial<DevicePreferences>) => {
    setDevice((d) => {
      const next = { ...d, ...patch };
      try {
        localStorage.setItem(DEVICE_STORAGE, JSON.stringify(next));
      } catch {
        // storage unavailable: the choice lasts for this page only
      }
      return next;
    });
  }, []);
  const version = useRef<number | undefined>(undefined);
  const theme = useRef(prefs.theme);
  useEffect(() => followSystemTheme(() => theme.current), []);

  useEffect(() => {
    theme.current = prefs.theme;
    applyAppearance(prefs);
  }, [prefs]);

  // Signed in: the account's stored preferences win over the local cache (survives sign-in on a
  // new device). Signed out: keep the cached appearance so sign-in pages do not flash.
  const account = me?.id;
  useEffect(() => {
    if (!account) {
      version.current = undefined;
      return;
    }
    let active = true;
    shell.preferences().then(
      (p) => {
        if (!active) return;
        version.current = p.version;
        setPrefs(withoutVersion(p));
        setLoadedFor(account);
      },
      () => active && setLoadedFor(account),
    );
    return () => {
      active = false;
    };
  }, [account]);

  const update = useCallback(
    async (patch: Partial<Preferences>) => {
      const before = prefs;
      setPrefs((p) => ({ ...p, ...patch }));
      if (!account) return;
      try {
        let saved;
        try {
          saved = await shell.updatePreferences(patch, version.current);
        } catch (err) {
          // Another device changed preferences: re-read, then apply this change on top.
          if (!(err instanceof ApiError) || err.code !== 'conflict') throw err;
          const fresh = await shell.preferences();
          saved = await shell.updatePreferences(patch, fresh.version);
        }
        version.current = saved.version;
        setPrefs(withoutVersion(saved));
      } catch (err) {
        setPrefs(before);
        throw err;
      }
    },
    [account, prefs],
  );

  const value = useMemo<PreferencesState>(
    () => ({
      preferences: prefs,
      loaded: account !== undefined && loadedFor === account,
      singleKeyShortcuts: prefs.shortcuts === 'on' || (prefs.shortcuts === 'auto' && finePointer()),
      update,
      device,
      updateDevice,
    }),
    [prefs, loadedFor, account, update, device, updateDevice],
  );
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesState {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferences outside PreferencesProvider');
  return ctx;
}
