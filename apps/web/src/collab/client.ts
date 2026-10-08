import { api, protectedRequest, type StepUpResolver } from '../api.ts';
import type { BrandMarkerData } from '../shell/client.ts';

/** Typed client for the 4A collaboration API (ADR-0023). Every identifier is a public ID. */

export const COMMENT_MAX_CHARS = 10_000;
export const REVIEW_NOTE_MAX_CHARS = 2000;
export const HANDOVER_NOTE_MAX_CHARS = 500;

export type MentionKind = 'member' | 'team' | 'record';
export interface MentionRef {
  kind: MentionKind;
  id: string;
}
export interface Mention extends MentionRef {
  name: string;
}

export const REACTION_KEYS = [
  'thumbs_up',
  'heart',
  'celebrate',
  'eyes',
  'check',
  'question',
  'thanks',
  'laugh',
] as const;
export type ReactionKey = (typeof REACTION_KEYS)[number];

export interface Comment {
  id: string;
  type: 'comment';
  host: { id: string; type: string };
  thread: string | null;
  in_reply_to: string | null;
  text: string | null;
  deleted: boolean;
  deleted_by: 'author' | 'moderator' | null;
  author: { id: string; type: 'member'; name: string } | null;
  created_at: string;
  edited_at: string | null;
  edit_count: number;
  version: number;
  mentions: Mention[];
  reactions: Array<{ reaction: ReactionKey; count: number; mine: boolean }>;
  capabilities: {
    reply: boolean;
    react: boolean;
    edit: boolean;
    delete: boolean;
    history: boolean;
  };
}

export interface Thread extends Comment {
  reply_count: number;
  replies: Comment[];
  replies_more: boolean;
}

export interface Page<T> {
  data: T[];
  page: { limit: number; has_more: boolean; next_cursor?: string; total?: number };
}

export interface Revision {
  revision: number;
  kind: 'edited' | 'deleted';
  text: string | null;
  at: string;
  actor: { id: string; name: string } | null;
}

export interface Candidate {
  kind: MentionKind;
  id: string;
  name: string;
}

export type ReviewState =
  'requested' | 'changes_requested' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';
export type ReviewOutcome = 'approved' | 'changes_requested' | 'rejected';
export type ReviewKind = 'review' | 'approval';
export type ReviewRule = 'any' | 'all';

export interface ReviewRequest {
  id: string;
  type: 'review_request';
  subject: { id: string; type: string; title: string };
  subject_version: number;
  current_version: number;
  stale: boolean;
  kind: ReviewKind;
  rule: ReviewRule;
  state: ReviewState;
  requested_by: { id: string; name: string } | null;
  message: string | null;
  reviewers: Array<{
    member: { id: string; name: string } | null;
    mine: boolean;
    decision: {
      outcome: ReviewOutcome;
      note: string | null;
      self_approval: boolean;
      subject_version: number;
      at: string;
    } | null;
  }>;
  previous: string | null;
  closed_reason: string | null;
  settled_at: string | null;
  created_at: string;
  version: number;
  capabilities: { decide: boolean; withdraw: boolean; refresh: boolean };
}

export interface CollaborationSummary {
  type: 'collaboration_summary';
  record: { id: string; type: string };
  following: boolean;
  followed_at: string | null;
  comment_count: number;
  capabilities: {
    comment: boolean;
    follow: boolean;
    see_followers: boolean;
    request_review: boolean;
    delegate: boolean;
  };
  review?: ReviewRequest | null;
}

export interface FollowingRow {
  id: string;
  type: 'task' | 'project';
  title: string;
  status_category: string;
  due: string | null;
  archived: boolean;
  brand: { id: string; name: string } | null;
  followed_at: string;
}

export interface MyReview {
  id: string;
  type: 'review_request';
  subject: { id: string; type: string; title: string };
  kind: ReviewKind;
  rule: ReviewRule;
  state: ReviewState;
  stale: boolean;
  requested_by: { id: string; name: string } | null;
  mine_decision: ReviewOutcome | null;
  created_at: string;
  settled_at: string | null;
}

export interface AssignmentEvent {
  kind: 'assigned' | 'unassigned' | 'reassigned' | 'delegated';
  via: 'assign' | 'delegate' | 'departure';
  from: { id: string; name: string } | null;
  to: { id: string; name: string } | null;
  by: { id: string; name: string } | null;
  note: string | null;
  at: string;
}

export type { BrandMarkerData };

const w = (ws: string) => `/v1/workspaces/${ws}`;
const qs = (o: Record<string, string | number | undefined>) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== '');
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};

export const collaboration = {
  // ---- Comments ----------------------------------------------------------------------------
  async comments(ws: string, rec: string, o: { cursor?: string; limit?: number } = {}) {
    return (
      await api<Page<Thread>>(
        'GET',
        `${w(ws)}/records/${rec}/comments${qs({ order: 'asc', ...o })}`,
      )
    ).body;
  },
  async replies(ws: string, cmt: string, cursor?: string) {
    return (await api<Page<Comment>>('GET', `${w(ws)}/comments/${cmt}/replies${qs({ cursor })}`))
      .body;
  },
  async comment(ws: string, cmt: string) {
    return (await api<{ data: Comment }>('GET', `${w(ws)}/comments/${cmt}`)).body.data;
  },
  async post(
    ws: string,
    rec: string,
    body: { text: string; mentions: MentionRef[]; reply_to?: string },
    stepUp: StepUpResolver,
    idempotencyKey?: string,
  ) {
    return (
      await protectedRequest<{ data: Comment }>(
        'POST',
        `${w(ws)}/records/${rec}/comments`,
        body,
        stepUp,
        { idempotencyKey },
      )
    ).body.data;
  },
  async edit(
    ws: string,
    cmt: string,
    version: number,
    body: { text: string; mentions: MentionRef[] },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Comment }>('PATCH', `${w(ws)}/comments/${cmt}`, body, stepUp, {
        ifMatch: version,
      })
    ).body.data;
  },
  async remove(ws: string, cmt: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Comment }>('DELETE', `${w(ws)}/comments/${cmt}`, {}, stepUp)
    ).body.data;
  },
  async revisions(ws: string, cmt: string) {
    return (await api<{ data: Revision[] }>('GET', `${w(ws)}/comments/${cmt}/revisions`)).body.data;
  },
  async react(ws: string, cmt: string, key: ReactionKey, on: boolean, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Comment }>(
        on ? 'PUT' : 'DELETE',
        `${w(ws)}/comments/${cmt}/reactions/${key}`,
        {},
        stepUp,
      )
    ).body.data;
  },
  async candidates(ws: string, rec: string, q: string, signal?: AbortSignal) {
    return (
      await api<{ data: Candidate[] }>(
        'GET',
        `${w(ws)}/records/${rec}/mention-candidates${qs({ q, limit: 8 })}`,
        signal ? { signal } : {},
      )
    ).body.data;
  },

  // ---- Following ---------------------------------------------------------------------------
  async summary(ws: string, rec: string) {
    return (
      await api<{ data: CollaborationSummary }>('GET', `${w(ws)}/records/${rec}/collaboration`)
    ).body.data;
  },
  async follow(ws: string, rec: string, on: boolean, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: CollaborationSummary }>(
        on ? 'PUT' : 'DELETE',
        `${w(ws)}/records/${rec}/follow`,
        {},
        stepUp,
      )
    ).body.data;
  },
  async followers(ws: string, rec: string) {
    return (
      await api<{ data: Array<{ id: string; name: string; since: string }> }>(
        'GET',
        `${w(ws)}/records/${rec}/followers`,
      )
    ).body.data;
  },
  async following(ws: string, o: { type?: 'task' | 'project'; cursor?: string } = {}) {
    return (await api<Page<FollowingRow>>('GET', `${w(ws)}/me/following${qs({ limit: 25, ...o })}`))
      .body;
  },

  // ---- Reviews -----------------------------------------------------------------------------
  async reviews(ws: string, rec: string, cursor?: string) {
    return (
      await api<Page<ReviewRequest>>('GET', `${w(ws)}/records/${rec}/reviews${qs({ cursor })}`)
    ).body;
  },
  async requestReview(
    ws: string,
    rec: string,
    body: {
      reviewers: string[];
      rule: ReviewRule;
      kind: ReviewKind;
      message?: string;
      subject_version: number;
    },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: ReviewRequest }>(
        'POST',
        `${w(ws)}/records/${rec}/reviews`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async decide(
    ws: string,
    rvw: string,
    body: { outcome: ReviewOutcome; note?: string; subject_version: number },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: ReviewRequest }>(
        'POST',
        `${w(ws)}/reviews/${rvw}:decide`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async withdraw(ws: string, rvw: string, note: string | undefined, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: ReviewRequest }>(
        'POST',
        `${w(ws)}/reviews/${rvw}:withdraw`,
        note ? { note } : {},
        stepUp,
      )
    ).body.data;
  },
  async refresh(ws: string, rvw: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: ReviewRequest }>(
        'POST',
        `${w(ws)}/reviews/${rvw}:refresh`,
        {},
        stepUp,
      )
    ).body.data;
  },
  async myReviews(
    ws: string,
    o: { role: 'reviewer' | 'requester'; state: 'open' | 'settled'; cursor?: string },
  ) {
    return (await api<Page<MyReview>>('GET', `${w(ws)}/me/reviews${qs({ limit: 25, ...o })}`)).body;
  },

  // ---- Delegation --------------------------------------------------------------------------
  async assignmentHistory(ws: string, tsk: string, cursor?: string) {
    return (
      await api<Page<AssignmentEvent>>(
        'GET',
        `${w(ws)}/tasks/${tsk}/assignment-history${qs({ cursor })}`,
      )
    ).body;
  },
  async delegate(
    ws: string,
    tsk: string,
    body: { to: string; note?: string },
    stepUp: StepUpResolver,
  ) {
    await protectedRequest('POST', `${w(ws)}/tasks/${tsk}:delegate`, body, stepUp);
  },
};
