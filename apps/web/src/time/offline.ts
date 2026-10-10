import { ApiError, newIdempotencyKey } from '../api.ts';
import { time } from './client.ts';

/**
 * Timer recovery (ADR-0019 T5). A pause, resume, or stop pressed while offline is kept on this
 * device with the instant it was pressed and its own idempotency key, then sent in order when the
 * connection returns. The server accepts instants up to TIME_ENTRY_MAX_HOURS late and treats a
 * repeated action as a no-op, so a replay never applies twice and never loses the stop time.
 * Nothing but public IDs, verbs, instants, and keys is stored.
 */

export interface PendingAction {
  ws: string;
  te: string;
  verb: 'pause' | 'resume' | 'stop';
  at: string;
  key: string;
}

const KEY = 'pm.time.pending.v1';

export function pendingActions(): PendingAction[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as PendingAction[]) : [];
  } catch {
    return [];
  }
}

function save(list: PendingAction[]) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: actions are sent directly or not at all */
  }
}

export function queueAction(a: Omit<PendingAction, 'key' | 'at'> & { at?: string }): PendingAction {
  const action = { ...a, at: a.at ?? new Date().toISOString(), key: newIdempotencyKey() };
  save([...pendingActions(), action]);
  return action;
}

/**
 * Sends queued actions oldest first. Stops at the first network failure (still offline); drops an
 * action the server refuses outright (for example, the timer was deleted elsewhere), since
 * retrying it can never succeed. Returns how many were sent.
 */
export async function flushActions(ws: string): Promise<number> {
  let sent = 0;
  for (const a of pendingActions().filter((x) => x.ws === ws)) {
    try {
      await time.action(a.ws, a.te, a.verb, { at: a.at }, a.key);
      sent++;
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'offline' || err.code === 'network')) break;
    }
    save(pendingActions().filter((x) => x.key !== a.key));
  }
  return sent;
}
