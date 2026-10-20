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

/** The pre-correction 7D namespace (unscoped, per tab); only ever purged, never read. */
const LEGACY_PROPOSAL_PREFIX = 'pm.ai.proposal.draft.';

const sweep = (store: Storage, match: (k: string) => boolean) => {
  for (let i = store.length - 1; i >= 0; i--) {
    const k = store.key(i);
    if (k && match(k)) store.removeItem(k);
  }
};

/** Sign-out: drafts and per-tab view state go; appearance and the device key stay. */
export function clearPersonalClientState(): void {
  try {
    sweep(localStorage, (k) => k.startsWith(DRAFT_PREFIX));
    sweep(
      sessionStorage,
      (k) => k.startsWith(SESSION_PREFIX) || k.startsWith(LEGACY_PROPOSAL_PREFIX),
    );
  } catch {
    // storage unavailable
  }
}

/**
 * AI proposal drafts copy private proposal text (7D corrective review 01 R1). They go when the
 * session is observed to be invalid or the account changes, as well as on sign-out; other
 * personal drafts follow their own lifecycle.
 */
export function clearProposalDrafts(): void {
  try {
    // 7C: unsaved AI action inputs (briefs and answers) follow the same lifecycle; so do 7E
    // unsaved briefing notes (they may quote briefing content) and 7F capture and plan drafts.
    sweep(
      localStorage,
      (k) =>
        k.startsWith(DRAFT_PREFIX) &&
        (k.includes('.ai-proposal.') ||
          k.includes('.ai-assist.') ||
          k.includes('.ai-briefing.') ||
          // 7F: unsaved capture transcripts and interpretations, and daily-plan options.
          k.includes('.ai-capture.') ||
          k.includes('.ai-plan.') ||
          // 8A: unsaved automation definitions (messages and titles a person typed).
          k.includes('.automation.') ||
          // 8B: unsaved agent configuration (instructions a person typed).
          k.includes('.agent.')),
    );
    purgeLegacyProposalDrafts();
  } catch {
    // storage unavailable
  }
}

/** Removes drafts stored before corrective review 01 (unscoped by account or workspace). */
export function purgeLegacyProposalDrafts(): void {
  try {
    sweep(sessionStorage, (k) => k.startsWith(LEGACY_PROPOSAL_PREFIX));
  } catch {
    // storage unavailable
  }
}
