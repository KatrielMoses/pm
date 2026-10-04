/**
 * Local drafts (RS-22, ST-08) for long-form inputs. 1E provides the storage contract only; no
 * long-form editor exists yet, so nothing writes drafts until the editors arrive. Drafts are per
 * account per device, never synced, and cleared on sign-out together with per-tab view state.
 */
const DRAFT_PREFIX = 'pm.draft.';
const SESSION_PREFIX = 'pm.vs.';
const MAX_DRAFT_BYTES = 64 * 1024;

export interface Draft {
  savedAt: string;
  value: string;
}

const key = (account: string, id: string) => `${DRAFT_PREFIX}${account}.${id}`;

export function saveDraft(account: string, id: string, value: string): boolean {
  if (!/^[a-z][a-z0-9_.:-]{1,120}$/.test(id) || value.length > MAX_DRAFT_BYTES) return false;
  try {
    localStorage.setItem(
      key(account, id),
      JSON.stringify({ savedAt: new Date().toISOString(), value }),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadDraft(account: string, id: string): Draft | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key(account, id)) ?? 'null') as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    return typeof o.value === 'string' && typeof o.savedAt === 'string'
      ? { value: o.value, savedAt: o.savedAt }
      : null;
  } catch {
    return null;
  }
}

export function discardDraft(account: string, id: string): void {
  try {
    localStorage.removeItem(key(account, id));
  } catch {
    // nothing stored
  }
}

/** Sign-out: drafts and per-tab view state go; appearance and the device key stay. */
export function clearPersonalClientState(): void {
  const sweep = (store: Storage, prefix: string) => {
    for (let i = store.length - 1; i >= 0; i--) {
      const k = store.key(i);
      if (k?.startsWith(prefix)) store.removeItem(k);
    }
  };
  try {
    sweep(localStorage, DRAFT_PREFIX);
    sweep(sessionStorage, SESSION_PREFIX);
  } catch {
    // storage unavailable
  }
}
