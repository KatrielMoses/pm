import { discardDraft, loadDraft, saveDraft } from '../shell/drafts.ts';

/**
 * Unsaved automation edits on this device (8A): per account (the personal-draft store, 64 KB,
 * cleared on sign-out), scoped to the workspace and automation, tied to the version they started
 * from, expiring after 72 hours, validated before use, and never shown before the server answered.
 * A background refresh or an offline save keeps them; a successful save or an explicit discard
 * removes them.
 */
export const AUTOMATION_DRAFT_TTL_MS = 72 * 3_600_000;

export interface AutomationDraft {
  version: number;
  name: string;
  definition: Record<string, unknown>;
  projects: string[];
}

const idFor = (ws: string, aut: string) => `automation.${ws.toLowerCase()}.${aut.toLowerCase()}`;
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function readAutomationDraft(
  account: string,
  ws: string,
  aut: string,
): AutomationDraft | null {
  const stored = loadDraft(account, idFor(ws, aut));
  if (!stored) return null;
  if (Date.now() - Date.parse(stored.savedAt) > AUTOMATION_DRAFT_TTL_MS) {
    discardDraft(account, idFor(ws, aut));
    return null;
  }
  try {
    const raw = JSON.parse(stored.value) as unknown;
    if (
      !isObj(raw) ||
      !Number.isInteger(raw.version) ||
      typeof raw.name !== 'string' ||
      raw.name.length > 120 ||
      !isObj(raw.definition) ||
      !Array.isArray(raw.projects) ||
      !raw.projects.every((p) => typeof p === 'string' && p.length <= 40)
    )
      throw new Error('invalid');
    return raw as unknown as AutomationDraft;
  } catch {
    discardDraft(account, idFor(ws, aut));
    return null;
  }
}

export function writeAutomationDraft(
  account: string,
  ws: string,
  aut: string,
  d: AutomationDraft | null,
) {
  if (!d || !saveDraft(account, idFor(ws, aut), JSON.stringify(d)))
    discardDraft(account, idFor(ws, aut));
}
