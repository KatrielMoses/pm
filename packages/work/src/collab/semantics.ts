/**
 * Pure rules of Phase 4A collaboration (ADR-0023): the reaction vocabulary, the author's edit
 * window (OD-38), and how a review request settles from its decisions. No database, no clock, no
 * authorization: those belong to the service.
 */

/** The fixed reaction vocabulary (COL-008); the database CHECK lists the same keys. */
export const REACTIONS = [
  'thumbs_up',
  'heart',
  'celebrate',
  'eyes',
  'check',
  'question',
  'thanks',
  'laugh',
] as const;
export type Reaction = (typeof REACTIONS)[number];

export const REVIEW_KINDS = ['review', 'approval'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
export const REVIEW_RULES = ['any', 'all'] as const;
export type ReviewRule = (typeof REVIEW_RULES)[number];
export const REVIEW_OUTCOMES = ['approved', 'changes_requested', 'rejected'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
export type ReviewState = 'requested' | ReviewOutcome | 'withdrawn' | 'superseded';

/** Record types that can host comments, followers, and reviews until later phases register more. */
export const COLLAB_HOSTS = ['task', 'project', 'document'] as const;
export type CollabHostKind = (typeof COLLAB_HOSTS)[number];

/** Whether an author may still edit or delete their own comment (OD-38 audit window). */
export function withinEditWindow(createdAt: Date, now: Date, windowMinutes: number): boolean {
  return now.getTime() - createdAt.getTime() <= windowMinutes * 60_000;
}

/**
 * The state of a review request after `decisions` (in the order they were made).
 *
 * - `any`: the first decision settles the request with its outcome.
 * - `all`: the first decision that is not an approval settles the request with that outcome;
 *   otherwise the request stays open until every named reviewer has approved.
 */
export function settleReview(
  rule: ReviewRule,
  reviewerCount: number,
  decisions: ReadonlyArray<{ outcome: ReviewOutcome }>,
): 'requested' | ReviewOutcome {
  if (rule === 'any') return decisions[0]?.outcome ?? 'requested';
  let approvals = 0;
  for (const d of decisions) {
    if (d.outcome !== 'approved') return d.outcome;
    approvals += 1;
  }
  return approvals >= reviewerCount && reviewerCount > 0 ? 'approved' : 'requested';
}

/** Review states a decision may still be made in. */
export const isOpenReview = (state: string): boolean => state === 'requested';

/** A stable, order-independent key for one mention target (dedupe within a comment). */
export const mentionKey = (m: { kind: string; id: string }): string => `${m.kind}:${m.id}`;
