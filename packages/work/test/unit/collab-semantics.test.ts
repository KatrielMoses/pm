import { describe, expect, it } from 'vitest';
import {
  COLLAB_HOSTS,
  REACTIONS,
  isOpenReview,
  mentionKey,
  settleReview,
  withinEditWindow,
} from '../../src/collab/semantics.ts';
import {
  parseCommentCreate,
  parseCommentEdit,
  parseCursorQuery,
  parseDecision,
  parseDelegate,
  parseReaction,
  parseRefresh,
  parseReviewRequest,
  parseWithdraw,
} from '../../src/collab/validation.ts';

const mem = (n: number) => `mem_${String(n).padStart(26, '0')}`;
const bounds = { bodyMax: 100, mentionsMax: 3 };
const issues = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { issues: Array<{ pointer: string; code: string }> }).issues.map(
      (i) => `${i.pointer}:${i.code}`,
    );
  }
  return [];
};

describe('review settlement (ADR-0023 D7)', () => {
  const a = { outcome: 'approved' as const };
  const c = { outcome: 'changes_requested' as const };
  const r = { outcome: 'rejected' as const };

  it('settles under the any rule with the first decision, whatever it is', () => {
    expect(settleReview('any', 3, [])).toBe('requested');
    expect(settleReview('any', 3, [a])).toBe('approved');
    expect(settleReview('any', 3, [c, a])).toBe('changes_requested');
    expect(settleReview('any', 2, [r])).toBe('rejected');
  });

  it('needs every reviewer under the all rule, and any non-approval settles at once', () => {
    expect(settleReview('all', 2, [])).toBe('requested');
    expect(settleReview('all', 2, [a])).toBe('requested');
    expect(settleReview('all', 2, [a, a])).toBe('approved');
    expect(settleReview('all', 3, [a, c])).toBe('changes_requested');
    expect(settleReview('all', 3, [r])).toBe('rejected');
    // A reviewer who left shrinks the count: the remaining approvals can settle it.
    expect(settleReview('all', 1, [a])).toBe('approved');
    expect(settleReview('all', 0, [])).toBe('requested');
  });

  it('knows which states are open', () => {
    expect(isOpenReview('requested')).toBe(true);
    for (const s of ['approved', 'rejected', 'changes_requested', 'withdrawn', 'superseded'])
      expect(isOpenReview(s)).toBe(false);
  });
});

describe('the author’s edit window (OD-38)', () => {
  const t0 = new Date('2026-10-08T10:00:00Z');
  it('is open up to and including the limit, and closed after it', () => {
    expect(withinEditWindow(t0, new Date('2026-10-08T10:00:00Z'), 60)).toBe(true);
    expect(withinEditWindow(t0, new Date('2026-10-08T11:00:00Z'), 60)).toBe(true);
    expect(withinEditWindow(t0, new Date('2026-10-08T11:00:01Z'), 60)).toBe(false);
    expect(withinEditWindow(t0, new Date('2026-10-09T10:00:00Z'), 1440)).toBe(true);
  });
});

describe('vocabularies', () => {
  it('has the eight reactions and the supported hosts the database knows', () => {
    expect(REACTIONS).toHaveLength(8);
    expect(parseReaction('heart')).toBe('heart');
    expect(parseReaction('skull')).toBeNull();
    expect(parseReaction(5)).toBeNull();
    expect([...COLLAB_HOSTS]).toEqual(['task', 'project']);
    expect(mentionKey({ kind: 'team', id: 'x' })).toBe('team:x');
  });
});

describe('comment input', () => {
  it('accepts text or a rich-text body, and refuses both, neither, empty, and oversized', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
    };
    expect(parseCommentCreate({ text: ' Hi\nthere ' }, bounds)).toMatchObject({
      text: ' Hi\nthere ',
      replyTo: null,
    });
    expect(parseCommentCreate({ body: doc }, bounds).text).toBe('Hello');
    expect(issues(() => parseCommentCreate({ body: doc, text: 'x' }, bounds))).toEqual([
      '/text:conflicting',
    ]);
    expect(issues(() => parseCommentCreate({}, bounds))).toEqual(['/text:required']);
    expect(issues(() => parseCommentCreate({ text: '   ' }, bounds))).toEqual(['/text:required']);
    expect(issues(() => parseCommentCreate({ text: 'x'.repeat(101) }, bounds))).toEqual([
      '/text:too_long',
    ]);
    expect(issues(() => parseCommentCreate({ text: 'x', surprise: 1 }, bounds))).toEqual([
      '/surprise:unsupported_field',
    ]);
    expect(issues(() => parseCommentCreate('nope', bounds))[0]).toBe('/:invalid_type');
    expect(
      issues(() =>
        parseCommentCreate(
          { body: { type: 'doc', version: 1, content: [{ type: 'heading' }] } },
          bounds,
        ),
      ),
    ).toEqual(['/body/content/0:unsupported_node']);
  });

  it('validates replies and mentions: kinds, prefixes, duplicates, and the bound', () => {
    expect(
      parseCommentCreate({ text: 'x', reply_to: `cmt_${'0'.repeat(26)}` }, bounds).replyTo,
    ).toBe(`cmt_${'0'.repeat(26)}`);
    expect(issues(() => parseCommentCreate({ text: 'x', reply_to: 'cmt_x' }, bounds))).toEqual([
      '/reply_to:invalid_reference',
    ]);
    const ok = parseCommentCreate(
      {
        text: 'x',
        mentions: [
          { kind: 'member', id: mem(1) },
          { kind: 'member', id: mem(1) },
          { kind: 'team', id: `team_${'0'.repeat(26)}` },
          { kind: 'record', id: `prj_${'0'.repeat(26)}` },
        ],
      },
      { ...bounds, mentionsMax: 4 },
    );
    expect(ok.mentions.map((m) => m.kind)).toEqual(['member', 'team', 'record']);
    for (const bad of [
      { kind: 'agent', id: mem(1) },
      { kind: 'member', id: `team_${'0'.repeat(26)}` },
      { kind: 'record', id: mem(1) },
      { kind: 'member' },
      'x',
    ])
      expect(
        issues(() => parseCommentCreate({ text: 'x', mentions: [bad] }, bounds)),
        JSON.stringify(bad),
      ).toHaveLength(1);
    expect(
      issues(() =>
        parseCommentCreate(
          {
            text: 'x',
            mentions: Array.from({ length: 4 }, (_, i) => ({ kind: 'member', id: mem(i) })),
          },
          bounds,
        ),
      ),
    ).toEqual(['/mentions:too_many']);
  });

  it('reads an edit with an optional version', () => {
    expect(parseCommentEdit({ text: 'x', version: 2 }, bounds).version).toBe(2);
    expect(parseCommentEdit({ text: 'x' }, bounds).version).toBeUndefined();
    expect(issues(() => parseCommentEdit({ text: 'x', version: -1 }, bounds))).toEqual([
      '/version:invalid_number',
    ]);
  });
});

describe('review and delegation input', () => {
  it('parses a request with defaults and refuses bad rules, kinds, counts, and notes', () => {
    expect(parseReviewRequest({ reviewers: [mem(1), mem(1), mem(2)] }, 5)).toMatchObject({
      reviewers: [mem(1), mem(2)],
      rule: 'any',
      kind: 'review',
      message: null,
    });
    expect(
      parseReviewRequest(
        { reviewers: [mem(1)], rule: 'all', kind: 'approval', message: ' Please ' },
        5,
      ),
    ).toMatchObject({
      rule: 'all',
      kind: 'approval',
      message: 'Please',
    });
    expect(issues(() => parseReviewRequest({}, 5))).toEqual(['/reviewers:required']);
    expect(issues(() => parseReviewRequest({ reviewers: [] }, 5))).toEqual(['/reviewers:required']);
    expect(issues(() => parseReviewRequest({ reviewers: [mem(1), mem(2)] }, 1))).toEqual([
      '/reviewers:too_many',
    ]);
    expect(issues(() => parseReviewRequest({ reviewers: ['x'] }, 5))).toEqual([
      '/reviewers/0:invalid_reference',
    ]);
    expect(issues(() => parseReviewRequest({ reviewers: [mem(1)], rule: 'most' }, 5))).toEqual([
      '/rule:invalid_option',
    ]);
    expect(issues(() => parseReviewRequest({ reviewers: [mem(1)], kind: 'vote' }, 5))).toEqual([
      '/kind:invalid_option',
    ]);
    expect(
      issues(() => parseReviewRequest({ reviewers: [mem(1)], message: 'x'.repeat(2001) }, 5)),
    ).toEqual(['/message:too_long']);
    expect(
      issues(() => parseReviewRequest({ reviewers: [mem(1)], message: 'a\u0000b' }, 5)),
    ).toEqual(['/message:invalid_characters']);
    expect(parseReviewRequest({ reviewers: [mem(1)], subject_version: 4 }, 5).subjectVersion).toBe(
      4,
    );
  });

  it('needs a typed outcome and the version reviewed to decide', () => {
    expect(parseDecision({ outcome: 'approved', subject_version: 3, note: ' ok ' })).toEqual({
      outcome: 'approved',
      note: 'ok',
      subjectVersion: 3,
    });
    expect(issues(() => parseDecision({ outcome: 'approved' }))).toEqual([
      '/subject_version:required',
    ]);
    expect(issues(() => parseDecision({ outcome: 'meh', subject_version: 0 }))).toEqual([
      '/outcome:invalid_option',
    ]);
    expect(issues(() => parseDecision({ outcome: 'approved', subject_version: 1.5 }))).toEqual([
      '/subject_version:required',
    ]);
  });

  it('parses withdraw, refresh, delegate, and list options', () => {
    expect(parseWithdraw({})).toEqual({ reason: null });
    expect(parseWithdraw({ note: 'Done' })).toEqual({ reason: 'Done' });
    expect(parseRefresh(undefined, 5)).toBeNull();
    expect(parseRefresh({}, 5)).toBeNull();
    expect(parseRefresh({ reviewers: [mem(1)] }, 5)?.reviewers).toEqual([mem(1)]);
    expect(parseDelegate({ to: mem(1), note: 'Over to you' })).toEqual({
      to: mem(1),
      note: 'Over to you',
    });
    expect(issues(() => parseDelegate({ to: 'x' }))).toEqual(['/to:invalid_reference']);
    expect(issues(() => parseDelegate({ to: mem(1), note: 'x'.repeat(501) }))).toEqual([
      '/note:too_long',
    ]);
    expect(parseCursorQuery({ limit: '5', order: 'asc' }, ['order'])).toEqual({
      limit: '5',
      order: 'asc',
    });
    expect(issues(() => parseCursorQuery({ nope: 1 }, []))).toEqual(['/nope:unsupported_field']);
  });
});
