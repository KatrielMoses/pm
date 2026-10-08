import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { discardDraft, loadDraft, saveDraft } from '../shell/drafts.ts';
import type { ReactionKey } from './client.ts';

/** Small helpers shared by the 4A collaboration surfaces: plain error copy, drafts, formatting. */

export const REACTION_LABEL: Record<ReactionKey, { glyph: string; name: string }> = {
  thumbs_up: { glyph: '👍', name: 'Thumbs up' },
  heart: { glyph: '❤️', name: 'Heart' },
  celebrate: { glyph: '🎉', name: 'Celebrate' },
  eyes: { glyph: '👀', name: 'Eyes' },
  check: { glyph: '✅', name: 'Done' },
  question: { glyph: '❓', name: 'Question' },
  thanks: { glyph: '🙏', name: 'Thanks' },
  laugh: { glyph: '😄', name: 'Laugh' },
};

export const REVIEW_STATE_LABEL: Record<string, { icon: string; text: string }> = {
  requested: { icon: '…', text: 'Waiting for review' },
  approved: { icon: '✓', text: 'Approved' },
  changes_requested: { icon: '!', text: 'Changes requested' },
  rejected: { icon: '✕', text: 'Rejected' },
  withdrawn: { icon: '–', text: 'Withdrawn' },
  superseded: { icon: '↻', text: 'Replaced by a newer request' },
};

export const OUTCOME_LABEL: Record<string, string> = {
  approved: 'Approved',
  changes_requested: 'Asked for changes',
  rejected: 'Rejected',
};

export const STATUS_CATEGORY_LABEL: Record<string, string> = {
  planned: 'Planned',
  active: 'In progress',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const when = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
export const day = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString([], { dateStyle: 'medium' }) : '';

export interface Explained {
  /** A short plain sentence: what happened and what to do. */
  message: string;
  /** The error code that decided the copy (for callers that need to branch). */
  kind:
    | 'offline'
    | 'rate_limited'
    | 'gone'
    | 'stale'
    | 'window_closed'
    | 'deleted'
    | 'permission'
    | 'rejected'
    | 'server'
    | 'other';
  /** Safe to retry the same request unchanged. */
  retryable: boolean;
  version?: number | undefined;
}

const CONFLICT_COPY: Record<string, string> = {
  review_open: 'This already has a review in progress. Open it below, or withdraw it first.',
  review_closed: 'This review is already settled, so it can no longer be changed.',
  already_decided: 'You already decided this review.',
  subject_changed: 'This changed after the review began. Look at the latest version and ask again.',
  record_archived: 'This is archived. Restore it to request a review.',
  deleted: 'This comment was deleted.',
};
const FORBIDDEN_COPY: Record<string, string> = {
  window_closed: "This comment can't be edited or deleted any more.",
  self_review: "You can't ask yourself to review this here. Choose someone else.",
  self_decision: "You can't decide your own request here.",
  not_reviewer: "You aren't a reviewer on this request.",
  not_assignee: 'You can only hand over work that is assigned to you.',
};
const VALIDATION_COPY: Record<string, string> = {
  self_review: "You can't ask yourself to review this here. Choose someone else.",
  not_reviewer: "That person can't review this. Choose someone who can see it.",
  not_mentionable: "That person, team, or record can't be mentioned here. Remove the mention.",
  not_assignable: "That person can't take this over. Choose someone who can see it.",
};

/** Turns any failure into honest, plain copy (0E ST-03): what failed, why, and what to do. */
export function explain(error: unknown, what = 'that'): Explained {
  if (!(error instanceof ApiError))
    return {
      message: `Something went wrong. Nothing was lost; try ${what} again.`,
      kind: 'server',
      retryable: true,
    };
  const code = error.issues[0]?.code;
  switch (error.code) {
    case 'offline':
    case 'network':
      return {
        message:
          "You're offline or the connection dropped. Your text is kept here. Try again when you're back online.",
        kind: 'offline',
        retryable: true,
      };
    case 'rate_limited': {
      const n = Math.max(1, Math.ceil(error.retryAfterSeconds ?? 30));
      return {
        message: `You're doing that too quickly. Try again in ${n} second${n === 1 ? '' : 's'}.`,
        kind: 'rate_limited',
        retryable: true,
      };
    }
    case 'not_found':
      return {
        message:
          'This is no longer available to you. It may have been moved, deleted, or unshared.',
        kind: 'gone',
        retryable: false,
      };
    case 'forbidden': {
      const copy = code ? FORBIDDEN_COPY[code] : undefined;
      return {
        message: copy ?? "You don't have permission to do that.",
        kind: code === 'window_closed' ? 'window_closed' : 'permission',
        retryable: false,
      };
    }
    case 'conflict': {
      const copy = code ? CONFLICT_COPY[code] : undefined;
      if (code === 'deleted') return { message: copy!, kind: 'deleted', retryable: false };
      if (copy)
        return {
          message: copy,
          kind: code === 'subject_changed' ? 'stale' : 'rejected',
          retryable: false,
          version: error.conflict?.current_version,
        };
      return {
        message: 'This changed while you were working. Reload to see the latest, then try again.',
        kind: 'stale',
        retryable: false,
        version: error.conflict?.current_version,
      };
    }
    case 'precondition_required':
    case 'precondition_failed':
      return {
        message: 'This changed while you were working. Reload to see the latest, then try again.',
        kind: 'stale',
        retryable: false,
      };
    case 'validation_failed': {
      const copy = code ? VALIDATION_COPY[code] : undefined;
      return {
        message: copy ?? error.issues[0]?.message ?? 'Check what you entered and try again.',
        kind: 'rejected',
        retryable: false,
      };
    }
    case 'cancelled':
      return { message: 'Cancelled. Nothing was changed.', kind: 'other', retryable: false };
    default:
      return {
        message: `We couldn't finish ${what} on our side. Your input is still here; try again in a moment.`,
        kind: 'server',
        retryable: true,
      };
  }
}

/** Whether the browser reports a connection (updates on the online and offline events). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** The signed-in account (drafts are per account per device); tests without auth share one key. */
export function useAccountId(): string {
  try {
    return useAuth().me?.id ?? 'device';
  } catch {
    return 'device';
  }
}

/** Draft ids are lower-case (the draft store's id rule); public ids are upper-case ULIDs. */
export const draftId = (kind: 'comment' | 'reply' | 'edit', id: string) =>
  `${kind}.${id.toLowerCase()}`;

/**
 * Text kept in local storage as the person types and restored after a reload or going offline
 * (RS-22). Never cleared by a failed send; `discard` runs only after the server accepted it.
 */
export function useDraft(id: string) {
  const account = useAccountId();
  const [restored] = useState(() => (loadDraft(account, id)?.value ?? '') !== '');
  const [text, setText] = useState(() => loadDraft(account, id)?.value ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
  }, [text]);
  const write = useCallback(
    (value: string) => {
      if (value === '') discardDraft(account, id);
      else saveDraft(account, id, value);
    },
    [account, id],
  );
  const set = useCallback(
    (value: string) => {
      setText(value);
      latest.current = value;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => write(value), 150);
    },
    [write],
  );
  // Flush on unmount so a navigation never drops the last keystrokes.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    const flush = () => write(latest.current);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [write]);
  const discard = useCallback(() => {
    clearTimeout(timer.current);
    discardDraft(account, id);
    latest.current = '';
    setText('');
  }, [account, id]);
  return { text, set, discard, restored };
}

/** A plain error line with an optional Retry (announced; the person's text stays where it is). */
export function Problem({
  problem,
  onRetry,
  busy,
  children,
}: {
  problem: Explained | null;
  onRetry?: (() => void) | undefined;
  busy?: boolean | undefined;
  children?: ReactNode;
}) {
  if (!problem) return null;
  return (
    <div className="collab-problem" role="alert">
      <span className="collab-problem-icon" aria-hidden="true">
        !
      </span>
      <div>
        <p>{problem.message}</p>
        {children}
        {problem.retryable && onRetry ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={onRetry}
            disabled={busy}
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}
