import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import {
  collaboration,
  type CollaborationSummary,
  type Comment,
  type MyReview,
  type ReviewRequest,
  type Thread,
} from '../src/collab/client.ts';
import { CollaborationSections } from '../src/collab/collaboration.tsx';
import { CommentsPanel, Composer } from '../src/collab/comments.tsx';
import { FollowingTab, ReviewsTab } from '../src/collab/my-work.tsx';
import { RequestDialog, ReviewCard } from '../src/collab/reviews.tsx';
import { explain } from '../src/collab/shared.tsx';
import { Router } from '../src/router.tsx';
import { StepUpProvider } from '../src/stepup.tsx';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

const wrap = (ui: React.ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );
const err = (
  code: string,
  status: number,
  extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) => new ApiError({ code, status, message: code, ...extra });

const WS = 'ws_A';
const REC = 'tsk_1';

const comment = (id: string, text: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  type: 'comment',
  host: { id: REC, type: 'task' },
  thread: null,
  in_reply_to: null,
  text,
  deleted: false,
  deleted_by: null,
  author: { id: 'mem_1', type: 'member', name: 'Ada Author' },
  created_at: '2026-10-01T10:00:00.000Z',
  edited_at: null,
  edit_count: 0,
  version: 0,
  mentions: [],
  reactions: [],
  capabilities: { reply: true, react: true, edit: false, delete: false, history: false },
  ...extra,
});
const thread = (c: Comment, extra: Partial<Thread> = {}): Thread => ({
  ...c,
  reply_count: 0,
  replies: [],
  replies_more: false,
  ...extra,
});
const page = <T,>(data: T[], more?: string) => ({
  data,
  page: { limit: 25, has_more: !!more, ...(more ? { next_cursor: more } : {}) },
});

const panel = (props: Partial<React.ComponentProps<typeof CommentsPanel>> = {}) =>
  wrap(
    <CommentsPanel
      ws={WS}
      rec={REC}
      canComment
      archived={false}
      canMention
      noun="task"
      {...props}
    />,
  );

describe('explain: plain, honest copy for every failure', () => {
  it('covers offline, rate limit, gone, stale, window and review errors', () => {
    expect(explain(err('offline', 0)).message).toMatch(/offline/i);
    expect(explain(err('rate_limited', 429, { retryAfterSeconds: 12 })).message).toBe(
      "You're doing that too quickly. Try again in 12 seconds.",
    );
    expect(explain(err('not_found', 404)).kind).toBe('gone');
    expect(
      explain(err('forbidden', 403, { issues: [{ code: 'window_closed', message: 'x' }] })).message,
    ).toMatch(/can't be edited or deleted any more/);
    const codes: Array<[string, string]> = [
      ['review_open', 'already has a review in progress'],
      ['review_closed', 'already settled'],
      ['already_decided', 'already decided'],
      ['subject_changed', 'changed after the review began'],
      ['record_archived', 'archived'],
    ];
    for (const [code, text] of codes)
      expect(explain(err('conflict', 409, { issues: [{ code, message: 'x' }] })).message).toContain(
        text,
      );
    for (const [code, text] of [
      ['self_review', "can't ask yourself"],
      ['self_decision', "can't decide your own"],
      ['not_reviewer', "aren't a reviewer"],
    ] as const)
      expect(
        explain(err('forbidden', 403, { issues: [{ code, message: 'x' }] })).message,
      ).toContain(text);
  });
});

describe('comment composer', () => {
  it('keeps the draft across a reload, keeps text and retries with one key when offline', async () => {
    const first = wrap(
      <Composer
        ws={WS}
        rec={REC}
        draftKey="comment.tsk_1"
        label="Add a comment"
        submitLabel="Post comment"
        canMention={false}
        onPosted={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('Add a comment'), {
      target: { value: 'Half a thought' },
    });
    first.unmount(); // the draft is flushed when the page goes away
    const post = vi
      .spyOn(collaboration, 'post')
      .mockRejectedValueOnce(err('offline', 0))
      .mockResolvedValueOnce(comment('cmt_1', 'Half a thought'));
    const onPosted = vi.fn();
    wrap(
      <Composer
        ws={WS}
        rec={REC}
        draftKey="comment.tsk_1"
        label="Add a comment"
        submitLabel="Post comment"
        canMention={false}
        onPosted={onPosted}
      />,
    );
    const box = screen.getByLabelText('Add a comment') as HTMLTextAreaElement;
    expect(box.value).toBe('Half a thought');
    expect(screen.getByText(/Restored your unsent draft/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Post comment' })));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/offline/i);
    expect(box.value).toBe('Half a thought');
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })));
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]![4]).toBeTruthy();
    expect(post.mock.calls[1]![4]).toBe(post.mock.calls[0]![4]); // replayed, never posted twice
    expect(onPosted).toHaveBeenCalledOnce();
    expect(box.value).toBe('');
    expect(localStorage.length).toBe(0);
  });

  it('posts with Ctrl+Enter, counts characters, and refuses an empty or over-long comment', async () => {
    const post = vi.spyOn(collaboration, 'post').mockResolvedValue(comment('cmt_1', 'hi'));
    wrap(
      <Composer
        ws={WS}
        rec={REC}
        draftKey="comment.tsk_1"
        label="Add a comment"
        submitLabel="Post comment"
        canMention={false}
        onPosted={() => undefined}
      />,
    );
    const box = screen.getByLabelText('Add a comment');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Post comment' })));
    expect(screen.getByText('Write something before posting.')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: 'x'.repeat(10_001) } });
    expect(screen.getByText(/10,001 of 10,000 characters — too long/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Post comment' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(box, { target: { value: 'hi' } });
    await act(async () => fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true }));
    expect(post).toHaveBeenCalledWith(
      WS,
      REC,
      { text: 'hi', mentions: [] },
      expect.anything(),
      expect.any(String),
    );
  });

  it('explains a rate limit and keeps the text', async () => {
    vi.spyOn(collaboration, 'post').mockRejectedValue(
      err('rate_limited', 429, { retryAfterSeconds: 20 }),
    );
    wrap(
      <Composer
        ws={WS}
        rec={REC}
        draftKey="comment.tsk_1"
        label="Add a comment"
        submitLabel="Post comment"
        canMention={false}
        onPosted={() => undefined}
      />,
    );
    const box = screen.getByLabelText('Add a comment') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'quick' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Post comment' })));
    expect(screen.getByRole('alert').textContent).toContain('Try again in 20 seconds.');
    expect(box.value).toBe('quick');
  });
});

describe('@mention picker', () => {
  it('searches on @, moves with arrows, chooses with Enter, and sends the mention', async () => {
    const candidates = vi.spyOn(collaboration, 'candidates').mockResolvedValue([
      { kind: 'member', id: 'mem_2', name: 'Bea Builder' },
      { kind: 'member', id: 'mem_3', name: 'Ben Baker' },
    ]);
    const post = vi.spyOn(collaboration, 'post').mockResolvedValue(comment('cmt_1', 'x'));
    wrap(
      <Composer
        ws={WS}
        rec={REC}
        draftKey="comment.tsk_1"
        label="Add a comment"
        submitLabel="Post comment"
        canMention
        onPosted={() => undefined}
      />,
    );
    const box = screen.getByLabelText('Add a comment') as HTMLTextAreaElement;
    box.focus();
    fireEvent.change(box, { target: { value: 'Hello @Be', selectionStart: 9, selectionEnd: 9 } });
    const list = await screen.findByRole('listbox');
    expect(candidates).toHaveBeenCalledWith(WS, REC, 'Be', expect.anything());
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'ArrowUp' }); // wraps
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('Hello @Ben Baker '));
    expect(screen.queryByRole('listbox')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Post comment' })));
    expect(post.mock.calls[0]![2]).toEqual({
      text: 'Hello @Ben Baker ',
      mentions: [{ kind: 'member', id: 'mem_3' }],
    });
  });

  it('Escape closes the list, and a mention whose text was removed is not sent', async () => {
    vi.spyOn(collaboration, 'candidates').mockResolvedValue([
      { kind: 'member', id: 'mem_2', name: 'Bea Builder' },
    ]);
    const post = vi.spyOn(collaboration, 'post').mockResolvedValue(comment('cmt_1', 'x'));
    wrap(
      <Composer
        ws={WS}
        rec={REC}
        draftKey="comment.tsk_1"
        label="Add a comment"
        submitLabel="Post comment"
        canMention
        onPosted={() => undefined}
      />,
    );
    const box = screen.getByLabelText('Add a comment') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@B', selectionStart: 2, selectionEnd: 2 } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(box, { target: { value: '@Be', selectionStart: 3, selectionEnd: 3 } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('@Bea Builder '));
    fireEvent.change(box, {
      target: { value: 'never mind', selectionStart: 10, selectionEnd: 10 },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Post comment' })));
    expect(post.mock.calls[0]![2]).toEqual({ text: 'never mind', mentions: [] });
  });

  it('offers no picker when mentions are not allowed', async () => {
    const candidates = vi.spyOn(collaboration, 'candidates').mockResolvedValue([]);
    wrap(
      <Composer
        ws={WS}
        rec={REC}
        draftKey="comment.tsk_1"
        label="Add a comment"
        submitLabel="Post comment"
        canMention={false}
        onPosted={() => undefined}
      />,
    );
    const box = screen.getByLabelText('Add a comment');
    fireEvent.change(box, { target: { value: '@B', selectionStart: 2, selectionEnd: 2 } });
    await new Promise((r) => setTimeout(r, 250));
    expect(candidates).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('comment list', () => {
  it('lists oldest first with tombstones, replies, Show more replies, and Load more', async () => {
    const root = comment('cmt_1', 'First thought');
    const gone = comment('cmt_2', '', {
      text: null,
      deleted: true,
      deleted_by: 'moderator',
      capabilities: { reply: true, react: false, edit: false, delete: false, history: false },
    });
    const list = vi
      .spyOn(collaboration, 'comments')
      .mockResolvedValueOnce(
        page(
          [
            thread(root, {
              reply_count: 3,
              replies: [comment('cmt_3', 'Reply one', { thread: 'cmt_1' })],
              replies_more: true,
            }),
            thread(gone),
          ],
          'next-1',
        ),
      )
      .mockResolvedValueOnce(page([thread(comment('cmt_9', 'Later one'))]));
    const replies = vi
      .spyOn(collaboration, 'replies')
      .mockResolvedValue(
        page([
          comment('cmt_3', 'Reply one', { thread: 'cmt_1' }),
          comment('cmt_4', 'Reply two', { thread: 'cmt_1' }),
          comment('cmt_5', 'Reply three', { thread: 'cmt_1' }),
        ]),
      );
    panel();
    expect(await screen.findByText('First thought')).toBeTruthy();
    expect(screen.getByText('This comment was removed by a moderator.')).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Show 2 more replies' })),
    );
    expect(replies).toHaveBeenCalledWith(WS, 'cmt_1', undefined);
    expect(screen.getByText('Reply three')).toBeTruthy();
    expect(screen.getAllByText(/Reply (one|two|three)/)).toHaveLength(3);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Load more comments' })),
    );
    expect(list).toHaveBeenLastCalledWith(WS, REC, { cursor: 'next-1' });
    expect(screen.getByText('Later one')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more comments' })).toBeNull();
  });

  it('shows an empty state, a retry on failure, and a deleted-comment reason', async () => {
    const list = vi
      .spyOn(collaboration, 'comments')
      .mockRejectedValueOnce(err('network', 0))
      .mockResolvedValueOnce(page([]));
    panel();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/offline or the connection dropped/);
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })));
    expect(list).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/No comments yet/)).toBeTruthy();
  });

  it('replies to a comment with reply_to and shows the reply', async () => {
    vi.spyOn(collaboration, 'comments').mockResolvedValue(page([thread(comment('cmt_1', 'Root'))]));
    const post = vi
      .spyOn(collaboration, 'post')
      .mockResolvedValue(comment('cmt_2', 'Answer', { thread: 'cmt_1', in_reply_to: 'cmt_1' }));
    panel();
    await screen.findByText('Root');
    fireEvent.click(screen.getByRole('button', { name: /^Reply/ }));
    const box = screen.getByLabelText('Reply to Ada Author');
    fireEvent.change(box, { target: { value: 'Answer' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Post reply' })));
    expect(post.mock.calls[0]![2]).toEqual({ text: 'Answer', mentions: [], reply_to: 'cmt_1' });
    expect(await screen.findByText('Answer')).toBeTruthy();
  });
});

describe('reactions', () => {
  it('are toggle buttons with names, counts, and aria-pressed', async () => {
    const mine = comment('cmt_1', 'Nice', {
      reactions: [
        { reaction: 'heart', count: 2, mine: true },
        { reaction: 'eyes', count: 1, mine: false },
      ],
    });
    vi.spyOn(collaboration, 'comments').mockResolvedValue(page([thread(mine)]));
    const react = vi.spyOn(collaboration, 'react').mockResolvedValue({
      ...mine,
      reactions: [
        { reaction: 'heart', count: 2, mine: true },
        { reaction: 'eyes', count: 2, mine: true },
      ],
    });
    panel();
    const group = await screen.findByRole('group', { name: 'Reactions' });
    expect(within(group).getAllByRole('button')).toHaveLength(8);
    const heart = within(group).getByRole('button', { name: 'Heart, 2' });
    expect(heart.getAttribute('aria-pressed')).toBe('true');
    const eyes = within(group).getByRole('button', { name: 'Eyes, 1' });
    expect(eyes.getAttribute('aria-pressed')).toBe('false');
    await act(async () => fireEvent.click(eyes));
    expect(react).toHaveBeenCalledWith(WS, 'cmt_1', 'eyes', true, expect.anything());
    expect(
      within(group).getByRole('button', { name: 'Eyes, 2' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('read-only readers see only the reactions that exist, without controls', async () => {
    const c = comment('cmt_1', 'Nice', {
      reactions: [{ reaction: 'heart', count: 1, mine: false }],
      capabilities: { reply: false, react: false, edit: false, delete: false, history: false },
    });
    vi.spyOn(collaboration, 'comments').mockResolvedValue(page([thread(c)]));
    panel({ canComment: false });
    const group = await screen.findByRole('group', { name: 'Reactions' });
    const buttons = within(group).getAllByRole('button') as HTMLButtonElement[];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.disabled).toBe(true);
    expect(screen.queryByLabelText('Add a comment')).toBeNull();
    expect(screen.getByText(/you can't add them/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Reply/ })).toBeNull();
  });
});

describe('edit, delete, and history', () => {
  const own = comment('cmt_1', 'Original', {
    version: 2,
    edited_at: '2026-10-01T11:00:00.000Z',
    edit_count: 1,
    capabilities: { reply: true, react: true, edit: true, delete: true, history: true },
  });

  it('on a stale version shows the newer text and keeps the draft; saving again uses the new version', async () => {
    vi.spyOn(collaboration, 'comments').mockResolvedValue(page([thread(own)]));
    const edit = vi
      .spyOn(collaboration, 'edit')
      .mockRejectedValueOnce(
        err('conflict', 409, {
          issues: [{ code: 'version_mismatch', message: 'x' }],
          conflict: { current_version: 3 },
        }),
      )
      .mockResolvedValueOnce({ ...own, text: 'My edit', version: 4 });
    vi.spyOn(collaboration, 'comment').mockResolvedValue({
      ...own,
      text: 'Edited elsewhere',
      version: 3,
    });
    panel();
    await screen.findByText('Original');
    fireEvent.click(screen.getByRole('button', { name: /^Edit/ }));
    const box = screen.getByLabelText('Edit your comment') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'My edit' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
    expect(screen.getByRole('alert').textContent).toMatch(/changed since you started editing/);
    expect(screen.getByText('Edited elsewhere')).toBeTruthy();
    expect(box.value).toBe('My edit');
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save my edit anyway' })),
    );
    expect(edit).toHaveBeenLastCalledWith(
      WS,
      'cmt_1',
      3,
      { text: 'My edit', mentions: [] },
      expect.anything(),
    );
    expect(await screen.findByText('My edit')).toBeTruthy();
  });

  it('explains a closed edit window and keeps the text', async () => {
    vi.spyOn(collaboration, 'comments').mockResolvedValue(page([thread(own)]));
    vi.spyOn(collaboration, 'edit').mockRejectedValue(
      err('forbidden', 403, { issues: [{ code: 'window_closed', message: 'x' }] }),
    );
    panel();
    await screen.findByText('Original');
    fireEvent.click(screen.getByRole('button', { name: /^Edit/ }));
    const box = screen.getByLabelText('Edit your comment') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Too late' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
    expect(screen.getByRole('alert').textContent).toContain("can't be edited or deleted any more");
    expect(box.value).toBe('Too late');
  });

  it('asks before deleting, then shows the tombstone while replies stay', async () => {
    vi.spyOn(collaboration, 'comments').mockResolvedValue(
      page([
        thread(own, {
          reply_count: 1,
          replies: [comment('cmt_2', 'A reply', { thread: 'cmt_1' })],
        }),
      ]),
    );
    const remove = vi
      .spyOn(collaboration, 'remove')
      .mockResolvedValue({ ...own, text: null, deleted: true, deleted_by: 'author' });
    panel();
    await screen.findByText('Original');
    fireEvent.click(screen.getByRole('button', { name: /^Delete/ }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete this comment?' });
    expect(remove).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Delete/ }));
    await act(async () =>
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete comment' }),
      ),
    );
    expect(remove).toHaveBeenCalledOnce();
    expect(await screen.findByText('This comment was deleted.')).toBeTruthy();
    expect(screen.getByText('A reply')).toBeTruthy();
  });

  it('shows revision history only when the server allows it', async () => {
    vi.spyOn(collaboration, 'comments').mockResolvedValue(
      page([thread(own), thread(comment('cmt_2', 'Someone else'))]),
    );
    vi.spyOn(collaboration, 'revisions').mockResolvedValue([
      {
        revision: 1,
        kind: 'edited',
        text: 'Older text',
        at: '2026-10-01T10:30:00.000Z',
        actor: { id: 'mem_1', name: 'Ada Author' },
      },
    ]);
    panel();
    await screen.findByText('Original');
    expect(screen.getAllByRole('button', { name: /^(Hide )?History/ })).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^History/ })));
    expect(await screen.findByText('Older text')).toBeTruthy();
  });
});

const summary = (
  extra: Partial<CollaborationSummary> = {},
  caps: Partial<CollaborationSummary['capabilities']> = {},
): CollaborationSummary => ({
  type: 'collaboration_summary',
  record: { id: REC, type: 'task' },
  following: false,
  followed_at: null,
  comment_count: 0,
  capabilities: {
    comment: true,
    follow: true,
    see_followers: false,
    request_review: false,
    delegate: false,
    ...caps,
  },
  review: null,
  ...extra,
});
const sections = (over: Partial<React.ComponentProps<typeof CollaborationSections>> = {}) =>
  wrap(
    <CollaborationSections
      ws={WS}
      rec={REC}
      kind="task"
      version={3}
      archived={false}
      sharedOnly={false}
      onRecordChanged={() => undefined}
      {...over}
    />,
  );

describe('follow toggle', () => {
  it('flips at once, is aria-pressed, and rolls back with a message when it fails', async () => {
    vi.spyOn(collaboration, 'comments').mockResolvedValue(page([]));
    vi.spyOn(collaboration, 'summary').mockResolvedValue(summary());
    let fail!: (e: unknown) => void;
    vi.spyOn(collaboration, 'follow').mockReturnValue(new Promise((_, rej) => (fail = rej)));
    sections();
    const button = await screen.findByRole('button', { name: 'Follow' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true'); // immediate
    await act(async () => fail(err('network', 0)));
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('alert').textContent).toMatch(
      /couldn't follow this task, so nothing changed/,
    );
  });

  it('unfollows idempotently and reports the server state', async () => {
    vi.spyOn(collaboration, 'comments').mockResolvedValue(page([]));
    vi.spyOn(collaboration, 'summary').mockResolvedValue(
      summary({ following: true, followed_at: '2026-10-02T10:00:00.000Z' }),
    );
    const follow = vi.spyOn(collaboration, 'follow').mockResolvedValue(summary());
    sections();
    const button = await screen.findByRole('button', { name: 'Follow' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await act(async () => fireEvent.click(button));
    expect(follow).toHaveBeenCalledWith(WS, REC, false, expect.anything());
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('You are not following this task.')).toBeTruthy();
  });

  it('lists followers only when allowed, with empty and error states', async () => {
    vi.spyOn(collaboration, 'comments').mockResolvedValue(page([]));
    vi.spyOn(collaboration, 'summary').mockResolvedValue(summary({}, { see_followers: true }));
    const followers = vi
      .spyOn(collaboration, 'followers')
      .mockRejectedValueOnce(err('internal_error', 500))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'mem_2', name: 'Bea Builder', since: '2026-10-02T10:00:00.000Z' },
      ]);
    sections();
    fireEvent.click(await screen.findByRole('button', { name: 'Followers' }));
    const alert = await screen.findByRole('alert');
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })));
    expect(followers).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Nobody who can see this follows it yet.')).toBeTruthy();
  });
});

describe('capability-driven sections', () => {
  const setup = (
    s: CollaborationSummary,
    over: Partial<React.ComponentProps<typeof CollaborationSections>> = {},
  ) => {
    vi.spyOn(collaboration, 'comments').mockResolvedValue(page([]));
    vi.spyOn(collaboration, 'summary').mockResolvedValue(s);
    vi.spyOn(collaboration, 'assignmentHistory').mockRejectedValue(err('not_found', 404));
    sections(over);
  };

  it('owner: comment, follow, followers, review, hand over', async () => {
    setup(summary({}, { see_followers: true, request_review: true, delegate: true }));
    expect(await screen.findByLabelText('Add a comment')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Followers' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request review…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hand over…' })).toBeTruthy();
  });

  it('member: comment and follow only', async () => {
    setup(summary());
    expect(await screen.findByLabelText('Add a comment')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Followers' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hand over…' })).toBeNull();
  });

  it('read-only viewer: no composer, a plain reason', async () => {
    setup(summary({}, { comment: false }));
    expect(await screen.findByText(/you can't add them/)).toBeTruthy();
    expect(screen.queryByLabelText('Add a comment')).toBeNull();
  });

  it('archived: the composer is replaced by an explanation', async () => {
    setup(summary({}, { comment: false }), { archived: true });
    expect(
      await screen.findByText(/This task is archived, so comments are read-only/),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Add a comment')).toBeNull();
  });

  it('share-only guest: composer without a picker, no history, no reviews', async () => {
    setup(
      summary({
        capabilities: {
          comment: true,
          follow: true,
          see_followers: false,
          request_review: false,
          delegate: false,
        },
      }),
      {
        sharedOnly: true,
      },
    );
    const box = await screen.findByLabelText('Add a comment');
    expect(box.getAttribute('aria-autocomplete')).toBeNull();
    expect(screen.queryByText('Assignment history')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Review' })).toBeNull();
    expect(screen.getByText(/Press Ctrl\+Enter/)).toBeTruthy();
    expect(screen.queryByText(/Type @ to mention/)).toBeNull();
  });

  it('a permission change mid-session (404) shows the not-available state', async () => {
    vi.spyOn(collaboration, 'summary').mockRejectedValue(err('not_found', 404));
    sections();
    expect(await screen.findByText(/may have been moved or deleted/)).toBeTruthy();
  });

  it('assignment history treats 404 as not available, not as an error', async () => {
    setup(summary());
    fireEvent.click(await screen.findByRole('button', { name: 'Show assignment history' }));
    expect(await screen.findByText(/isn't available to you for this task/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('hands a task over to a chosen person', async () => {
    setup(summary({}, { delegate: true }));
    vi.spyOn(collaboration, 'candidates').mockResolvedValue([
      { kind: 'member', id: 'mem_2', name: 'Bea Builder' },
      { kind: 'team', id: 'team_1', name: 'Crew' },
    ]);
    const delegate = vi.spyOn(collaboration, 'delegate').mockResolvedValue(undefined);
    fireEvent.click(await screen.findByRole('button', { name: 'Hand over…' }));
    const dialog = screen.getByRole('dialog', { name: 'Hand this task over' });
    {
      const bea = await within(dialog).findByLabelText('Bea Builder');
      await act(async () => fireEvent.click(bea));
    }
    expect(within(dialog).queryByLabelText('Crew')).toBeNull(); // people only
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), {
      target: { value: 'Yours now' },
    });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Hand over' })),
    );
    expect(delegate).toHaveBeenCalledWith(
      WS,
      REC,
      { to: 'mem_2', note: 'Yours now' },
      expect.anything(),
    );
  });
});

const review = (extra: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: 'rvw_1',
  type: 'review_request',
  subject: { id: REC, type: 'task', title: 'Write copy' },
  subject_version: 3,
  current_version: 3,
  stale: false,
  kind: 'review',
  rule: 'any',
  state: 'requested',
  requested_by: { id: 'mem_1', name: 'Ada Author' },
  message: 'Please check',
  reviewers: [{ member: { id: 'mem_2', name: 'Bea Builder' }, mine: true, decision: null }],
  previous: null,
  closed_reason: null,
  settled_at: null,
  created_at: '2026-10-02T10:00:00.000Z',
  version: 0,
  capabilities: { decide: true, withdraw: false, refresh: false },
  ...extra,
});

describe('reviews', () => {
  it('requests a review from chosen people with the version that was looked at', async () => {
    vi.spyOn(collaboration, 'candidates').mockResolvedValue([
      { kind: 'member', id: 'mem_2', name: 'Bea Builder' },
      { kind: 'team', id: 'team_1', name: 'Crew' },
    ]);
    const request = vi.spyOn(collaboration, 'requestReview').mockResolvedValue(review());
    const onDone = vi.fn();
    wrap(
      <RequestDialog
        ws={WS}
        rec={REC}
        noun="task"
        subjectVersion={3}
        onClose={() => undefined}
        onDone={onDone}
        onStale={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Request a review' });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' })),
    );
    expect(within(dialog).getByRole('alert').textContent).toContain(
      'Choose at least one reviewer.',
    );
    {
      const bea = await within(dialog).findByLabelText('Bea Builder');
      await act(async () => fireEvent.click(bea));
    }
    fireEvent.change(within(dialog).getByLabelText('Who has to answer?'), {
      target: { value: 'all' },
    });
    fireEvent.change(within(dialog).getByLabelText('What are you asking for?'), {
      target: { value: 'approval' },
    });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' })),
    );
    expect(request).toHaveBeenCalledWith(
      WS,
      REC,
      { reviewers: ['mem_2'], rule: 'all', kind: 'approval', subject_version: 3 },
      expect.anything(),
    );
    expect(onDone).toHaveBeenCalledOnce();
  });

  it.each([
    ['review_open', 'already has a review in progress'],
    ['subject_changed', 'changed after the review began'],
    ['record_archived', 'archived'],
  ])('request error %s is explained', async (code, text) => {
    vi.spyOn(collaboration, 'candidates').mockResolvedValue([
      { kind: 'member', id: 'mem_2', name: 'Bea Builder' },
    ]);
    vi.spyOn(collaboration, 'requestReview').mockRejectedValue(
      err('conflict', 409, { issues: [{ code, message: 'x' }], conflict: { current_version: 4 } }),
    );
    const stale = vi.fn();
    wrap(
      <RequestDialog
        ws={WS}
        rec={REC}
        noun="task"
        subjectVersion={3}
        onClose={() => undefined}
        onDone={() => undefined}
        onStale={stale}
      />,
    );
    const dialog = screen.getByRole('dialog');
    {
      const bea = await within(dialog).findByLabelText('Bea Builder');
      await act(async () => fireEvent.click(bea));
    }
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' })),
    );
    expect(within(dialog).getByRole('alert').textContent).toContain(text);
  });

  it('a named reviewer decides; the decision is sent with the current version', async () => {
    const decide = vi.spyOn(collaboration, 'decide').mockResolvedValue(
      review({
        state: 'approved',
        reviewers: [
          {
            member: { id: 'mem_2', name: 'Bea Builder' },
            mine: true,
            decision: {
              outcome: 'approved',
              note: 'Good',
              self_approval: false,
              subject_version: 3,
              at: '2026-10-02T11:00:00.000Z',
            },
          },
        ],
      }),
    );
    const onChanged = vi.fn();
    wrap(<ReviewCard ws={WS} review={review()} onChanged={onChanged} onStale={() => undefined} />);
    expect(screen.getByText('Waiting for review')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Decide…' }));
    const dialog = screen.getByRole('dialog');
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send decision' })),
    );
    expect(within(dialog).getByRole('alert').textContent).toContain('Choose approve');
    fireEvent.click(within(dialog).getByLabelText(/^Approve/));
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), {
      target: { value: 'Good' },
    });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send decision' })),
    );
    expect(decide).toHaveBeenCalledWith(
      WS,
      'rvw_1',
      { outcome: 'approved', note: 'Good', subject_version: 3 },
      expect.anything(),
    );
    expect(onChanged.mock.calls[0]![0].state).toBe('approved');
  });

  it.each([
    ['conflict', 'review_closed', 'already settled'],
    ['conflict', 'already_decided', 'already decided'],
    ['conflict', 'subject_changed', 'changed after the review began'],
    ['forbidden', 'self_decision', "can't decide your own"],
    ['forbidden', 'not_reviewer', "aren't a reviewer"],
  ])(
    'decision error %s/%s is explained and the page data is refreshed',
    async (status, code, text) => {
      vi.spyOn(collaboration, 'decide').mockRejectedValue(
        err(status, status === 'conflict' ? 409 : 403, {
          issues: [{ code, message: 'x' }],
          conflict: { current_version: 4 },
        }),
      );
      const stale = vi.fn();
      wrap(<ReviewCard ws={WS} review={review()} onChanged={() => undefined} onStale={stale} />);
      fireEvent.click(screen.getByRole('button', { name: 'Decide…' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByLabelText(/^Reject/));
      await act(async () =>
        fireEvent.click(within(dialog).getByRole('button', { name: 'Send decision' })),
      );
      expect(within(dialog).getByRole('alert').textContent).toContain(text);
      if (status === 'conflict') expect(stale).toHaveBeenCalled();
    },
  );

  it('stale review: warning, no Decide, and Ask again for the requester', async () => {
    const refresh = vi
      .spyOn(collaboration, 'refresh')
      .mockResolvedValue(review({ id: 'rvw_2', previous: 'rvw_1' }));
    const onChanged = vi.fn();
    wrap(
      <ReviewCard
        ws={WS}
        review={review({
          stale: true,
          current_version: 5,
          capabilities: { decide: true, withdraw: true, refresh: true },
        })}
        onChanged={onChanged}
        onStale={() => undefined}
      />,
    );
    expect(screen.getByText('This changed after the review began')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Decide…' })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Ask again' })));
    expect(refresh).toHaveBeenCalledWith(WS, 'rvw_1', expect.anything());
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('withdraws after confirmation', async () => {
    const withdraw = vi
      .spyOn(collaboration, 'withdraw')
      .mockResolvedValue(review({ state: 'withdrawn' }));
    wrap(
      <ReviewCard
        ws={WS}
        review={review({ capabilities: { decide: false, withdraw: true, refresh: false } })}
        onChanged={() => undefined}
        onStale={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Decide…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw request…' }));
    await act(async () =>
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Withdraw request' }),
      ),
    );
    expect(withdraw).toHaveBeenCalledWith(WS, 'rvw_1', undefined, expect.anything());
  });

  it('state badges use text and an icon, and panels show earlier reviews with a cursor', async () => {
    vi.spyOn(collaboration, 'comments').mockResolvedValue(page([]));
    vi.spyOn(collaboration, 'summary').mockResolvedValue(
      summary(
        {
          review: review({
            state: 'approved',
            capabilities: { decide: false, withdraw: false, refresh: false },
          }),
        },
        { request_review: true },
      ),
    );
    vi.spyOn(collaboration, 'assignmentHistory').mockResolvedValue(page([]));
    const list = vi
      .spyOn(collaboration, 'reviews')
      .mockResolvedValueOnce(
        page(
          [review({ id: 'rvw_1', state: 'approved' }), review({ id: 'rvw_0', state: 'rejected' })],
          'c1',
        ),
      )
      .mockResolvedValueOnce(page([review({ id: 'rvw_x', state: 'superseded' })]));
    sections();
    expect((await screen.findAllByText('Approved')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier reviews' }));
    const earlier = await screen.findByRole('list', { name: 'Earlier reviews' });
    expect(earlier.querySelectorAll(':scope > li')).toHaveLength(1);
    expect(within(earlier).getByText('Rejected')).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Load more reviews' })),
    );
    expect(list).toHaveBeenLastCalledWith(WS, REC, 'c1');
    expect(screen.getByText('Replaced by a newer request')).toBeTruthy();
  });
});

describe('My Work tabs', () => {
  const row = (id: string, type: 'task' | 'project', title: string, extra = {}) => ({
    id,
    type,
    title,
    status_category: 'active',
    due: '2026-11-01',
    archived: false,
    brand: { id: 'br_1', name: 'Harbor' },
    followed_at: '2026-10-02T10:00:00.000Z',
    ...extra,
  });

  it('Following lists records with links, filters, Load more, and an empty state', async () => {
    const following = vi
      .spyOn(collaboration, 'following')
      .mockResolvedValueOnce(
        page(
          [
            row('tsk_1', 'task', 'Write copy'),
            row('prj_1', 'project', 'Launch', { archived: true }),
          ],
          'c1',
        ),
      )
      .mockResolvedValueOnce(page([row('tsk_2', 'task', 'Second')]))
      .mockResolvedValueOnce(page([]));
    wrap(<FollowingTab ws={WS} />);
    const link = await screen.findByRole('link', { name: 'Write copy' });
    expect(link.getAttribute('href')).toBe('/workspaces/ws_A/tasks/tsk_1');
    expect(screen.getByRole('link', { name: 'Launch' }).getAttribute('href')).toBe(
      '/workspaces/ws_A/projects/prj_1',
    );
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(screen.getAllByText('Harbor', { selector: '.badge' })).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Load more records' })),
    );
    expect(following).toHaveBeenLastCalledWith(WS, { cursor: 'c1' });
    expect(screen.getByText('Second')).toBeTruthy();
    const projects = screen.getByRole('button', { name: 'Projects' });
    await act(async () => fireEvent.click(projects));
    expect(projects.getAttribute('aria-pressed')).toBe('true');
    expect(following).toHaveBeenLastCalledWith(WS, { type: 'project' });
    expect(await screen.findByText(/You aren't following any projects yet/)).toBeTruthy();
  });

  it('Reviews has To do, Asked by me, and Settled', async () => {
    const mine = (id: string, extra: Partial<MyReview> = {}): MyReview => ({
      id,
      type: 'review_request',
      subject: { id: REC, type: 'task', title: `Subject ${id}` },
      kind: 'approval',
      rule: 'any',
      state: 'requested',
      stale: false,
      requested_by: { id: 'mem_1', name: 'Ada Author' },
      mine_decision: null,
      created_at: '2026-10-02T10:00:00.000Z',
      settled_at: null,
      ...extra,
    });
    const list = vi
      .spyOn(collaboration, 'myReviews')
      .mockResolvedValueOnce(page([mine('a', { stale: true })]))
      .mockResolvedValueOnce(page([mine('b')]))
      .mockResolvedValueOnce(page([mine('c', { state: 'approved', mine_decision: 'approved' })]));
    wrap(<ReviewsTab ws={WS} />);
    expect(await screen.findByRole('link', { name: 'Subject a' })).toBeTruthy();
    expect(list).toHaveBeenLastCalledWith(WS, { role: 'reviewer', state: 'open' });
    expect(screen.getByText('Approval')).toBeTruthy();
    expect(screen.getByText(/Changed since asked/)).toBeTruthy();
    expect(screen.getByText(/Asked by Ada Author/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Asked by me' })));
    expect(list).toHaveBeenLastCalledWith(WS, { role: 'requester', state: 'open' });
    expect(await screen.findByText(/Asked by you/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('checkbox', { name: 'Settled' })));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(WS, { role: 'requester', state: 'settled' }),
    );
    expect(await screen.findByText(/You approved/)).toBeTruthy();
  });

  it('shows an honest failure with Try again', async () => {
    const list = vi
      .spyOn(collaboration, 'myReviews')
      .mockRejectedValueOnce(err('internal_error', 500))
      .mockResolvedValueOnce(page([]));
    wrap(<ReviewsTab ws={WS} />);
    {
      const retry = await screen.findByRole('button', { name: 'Try again' });
      await act(async () => fireEvent.click(retry));
    }
    expect(list).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/Nothing is waiting for your review/)).toBeTruthy();
  });
});
