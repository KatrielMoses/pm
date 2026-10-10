import type { Preferences } from '@pm/contracts/shell';

/**
 * Appearance (NAV-013, DS-23): theme, density, and motion applied to the document element. The
 * same values are cached locally so `public/theme-init.js` applies them before first paint (no
 * flash of the wrong theme). The cache holds appearance values only, never account data.
 */
export const APPEARANCE_STORAGE = 'pm.appearance';

type Appearance = Pick<Preferences, 'theme' | 'density' | 'motion'>;

function systemDark(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  root.dataset.theme = a.theme;
  root.dataset.colorScheme =
    a.theme === 'dark' || (a.theme === 'system' && systemDark()) ? 'dark' : 'light';
  if (a.density === 'compact') root.dataset.density = 'compact';
  else delete root.dataset.density;
  if (a.motion === 'reduce') root.dataset.motion = 'reduce';
  else delete root.dataset.motion;
  try {
    localStorage.setItem(
      APPEARANCE_STORAGE,
      JSON.stringify({ theme: a.theme, density: a.density, motion: a.motion }),
    );
  } catch {
    // Storage unavailable: the theme still applies for this page; the next load uses the system.
  }
}

/** Follows operating-system changes only while the theme is `system`. Returns an unsubscribe. */
export function followSystemTheme(getTheme: () => Preferences['theme']): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (getTheme() !== 'system') return;
    document.documentElement.dataset.colorScheme = mq.matches ? 'dark' : 'light';
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

export function cachedAppearance(): Appearance | null {
  try {
    const raw = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE) ?? 'null') as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    return {
      theme: o.theme === 'light' || o.theme === 'dark' ? o.theme : 'system',
      density: o.density === 'compact' ? 'compact' : 'comfortable',
      motion: o.motion === 'reduce' ? 'reduce' : 'system',
    };
  } catch {
    return null;
  }
}
