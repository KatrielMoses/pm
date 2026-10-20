import { discardDraft, loadDraft, saveDraft } from '../shell/drafts.ts';

/**
 * Unsaved agent configuration on this device (8B): per account (the personal-draft store, cleared
 * on sign-out), scoped to the workspace and profile, tied to the version it started from, expiring
 * after 72 hours, validated before use. Instructions a person typed are never lost to an offline
 * save or a conflict; a successful save or an explicit discard removes them.
 */
export const AGENT_DRAFT_TTL_MS = 72 * 3_600_000;

export interface AgentDraft {
  version: number;
  name: string;
  purpose: string;
  draft: Record<string, unknown>;
}

const idFor = (ws: string, agt: string) => `agent.${ws.toLowerCase()}.${agt.toLowerCase()}`;
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function readAgentDraft(account: string, ws: string, agt: string): AgentDraft | null {
  const stored = loadDraft(account, idFor(ws, agt));
  if (!stored) return null;
  if (Date.now() - Date.parse(stored.savedAt) > AGENT_DRAFT_TTL_MS) {
    discardDraft(account, idFor(ws, agt));
    return null;
  }
  try {
    const raw = JSON.parse(stored.value) as unknown;
    if (
      !isObj(raw) ||
      !Number.isInteger(raw.version) ||
      typeof raw.name !== 'string' ||
      raw.name.length > 120 ||
      typeof raw.purpose !== 'string' ||
      raw.purpose.length > 1000 ||
      !isObj(raw.draft)
    )
      throw new Error('invalid');
    return raw as unknown as AgentDraft;
  } catch {
    discardDraft(account, idFor(ws, agt));
    return null;
  }
}

export function writeAgentDraft(account: string, ws: string, agt: string, d: AgentDraft | null) {
  if (!d || !saveDraft(account, idFor(ws, agt), JSON.stringify(d)))
    discardDraft(account, idFor(ws, agt));
}
