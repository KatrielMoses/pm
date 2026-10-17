import { discardDraft, loadDraft, saveDraft } from '../shell/drafts.ts';

/**
 * Unsaved proposal edits on this device (7D corrective review 01 R1). They use the personal-draft
 * store, so they are per account, bounded (64 KB), and removed on sign-out with every other
 * draft. They are also scoped to the workspace and proposal, expire, are validated before use, and
 * are discarded when the server reports the proposal erased, withheld, closed, or not available,
 * or when the session ends or the account changes. A device that is offline keeps them until the
 * next authoritative answer; they are never shown before one arrives.
 */
export const PROPOSAL_DRAFT_TTL_MS = 72 * 3_600_000;

export interface ProposalDraft {
  revision: number;
  fields: Record<string, Record<string, string | null>>;
  selected: string[] | null;
  decisions: Record<string, 'accepted' | 'rejected'>;
}

const draftIdFor = (ws: string, prp: string) =>
  `ai-proposal.${ws.toLowerCase()}.${prp.toLowerCase()}`;
const KEY = /^c[0-9]{1,3}$/;
const FIELD = /^[a-z_]{1,24}$/;
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function valid(raw: unknown): ProposalDraft | null {
  if (!isObj(raw) || !Number.isInteger(raw.revision) || (raw.revision as number) < 1) return null;
  if (!isObj(raw.fields) || !isObj(raw.decisions)) return null;
  const fields: ProposalDraft['fields'] = {};
  for (const [k, v] of Object.entries(raw.fields)) {
    if (!KEY.test(k) || !isObj(v)) return null;
    for (const [f, x] of Object.entries(v))
      if (!FIELD.test(f) || !(x === null || (typeof x === 'string' && x.length <= 20_000)))
        return null;
    fields[k] = v as Record<string, string | null>;
  }
  const decisions: ProposalDraft['decisions'] = {};
  for (const [k, v] of Object.entries(raw.decisions)) {
    if (!KEY.test(k) || (v !== 'accepted' && v !== 'rejected')) return null;
    decisions[k] = v;
  }
  let selected: string[] | null = null;
  if (raw.selected !== null) {
    if (
      !Array.isArray(raw.selected) ||
      raw.selected.length > 100 ||
      !raw.selected.every((k) => typeof k === 'string' && KEY.test(k))
    )
      return null;
    selected = raw.selected as string[];
  }
  return { revision: raw.revision as number, fields, selected, decisions };
}

export function readProposalDraft(account: string, ws: string, prp: string): ProposalDraft | null {
  const id = draftIdFor(ws, prp);
  const stored = loadDraft(account, id);
  if (!stored) return null;
  const age = Date.now() - Date.parse(stored.savedAt);
  let parsed: ProposalDraft | null;
  try {
    parsed =
      Number.isFinite(age) && age >= 0 && age <= PROPOSAL_DRAFT_TTL_MS
        ? valid(JSON.parse(stored.value))
        : null;
  } catch {
    parsed = null;
  }
  // Expired or malformed content is removed, never shown.
  if (!parsed) discardDraft(account, id);
  return parsed;
}

export function writeProposalDraft(
  account: string,
  ws: string,
  prp: string,
  d: ProposalDraft | null,
): void {
  const id = draftIdFor(ws, prp);
  if (!d || !saveDraft(account, id, JSON.stringify(d))) discardDraft(account, id);
}
