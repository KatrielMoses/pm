import { discardDraft, loadDraft, saveDraft } from '../shell/drafts.ts';

/**
 * Unsaved AI action input (7C): the chosen action, instruction, brief, answers, and scope. It uses
 * the personal-draft store (per account, bounded, removed on sign-out, session end, and account
 * change), is scoped to the workspace, expires, and is validated before use. It is restored only
 * after the server has answered for this workspace.
 */
export const ASSIST_DRAFT_TTL_MS = 72 * 3_600_000;

export interface AssistDraft {
  action: string;
  instruction: string;
  brief: string;
  answers: Array<{ question: string; answer: string }>;
  brands: string[];
  project: string;
  task: string;
  named: string;
  /** Labels and members the person chose not to offer to the action. */
  omit: Array<{ type: string; id: string }>;
}

const idFor = (ws: string) => `ai-assist.${ws.toLowerCase()}`;
const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;

export function readAssistDraft(account: string, ws: string): AssistDraft | null {
  const stored = loadDraft(account, idFor(ws));
  if (!stored) return null;
  const age = Date.now() - Date.parse(stored.savedAt);
  let d: AssistDraft | null;
  try {
    const o = JSON.parse(stored.value) as Record<string, unknown>;
    const ok =
      Number.isFinite(age) &&
      age >= 0 &&
      age <= ASSIST_DRAFT_TTL_MS &&
      str(o.action, 60) &&
      str(o.instruction, 6000) &&
      str(o.brief, 4000) &&
      str(o.project, 40) &&
      str(o.task, 40) &&
      str(o.named, 2000) &&
      Array.isArray(o.brands) &&
      o.brands.length <= 5 &&
      o.brands.every((b) => str(b, 40)) &&
      Array.isArray(o.omit) &&
      o.omit.length <= 60 &&
      o.omit.every(
        (x) =>
          !!x &&
          typeof x === 'object' &&
          ((x as Record<string, unknown>).type === 'label' ||
            (x as Record<string, unknown>).type === 'member') &&
          str((x as Record<string, unknown>).id, 40),
      ) &&
      Array.isArray(o.answers) &&
      o.answers.length <= 5 &&
      o.answers.every(
        (a) =>
          !!a &&
          typeof a === 'object' &&
          str((a as Record<string, unknown>).question, 300) &&
          str((a as Record<string, unknown>).answer, 500),
      );
    d = ok ? (o as unknown as AssistDraft) : null;
  } catch {
    d = null;
  }
  if (!d) discardDraft(account, idFor(ws));
  return d;
}

export function writeAssistDraft(account: string, ws: string, d: AssistDraft | null): void {
  if (!d || !saveDraft(account, idFor(ws), JSON.stringify(d))) discardDraft(account, idFor(ws));
}
