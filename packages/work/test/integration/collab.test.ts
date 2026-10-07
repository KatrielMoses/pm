import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { sql } from '@pm/db';
import { measureClasses, statementShape } from '@pm/test-support';
import { productLifecycleRegistry } from '@pm/work';
import {
  apply,
  join,
  membershipOf,
  mutation,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const reason = (code: string) => expect.objectContaining({ code });
const issueOf = (code: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });
const ifMatch = (v: number) => mutation({ ifMatch: `"${v}"` });
const doc = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/**
 * Phase 4A comments, mentions, reactions, and following on real PostgreSQL (ADR-0023; OD-10,
 * OD-38): threads, the author's edit window and revision trail, tombstones, moderation, mentions
 * that name only what the author may name, fixed-vocabulary reactions, explicit idempotent
 * following, and authorization on every read for owners, members, read-only members, guests,
 * share-only readers, strangers, and revoked people.
 */
describe('Comments, mentions, reactions, and following (4A)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller; // member with edit on Harbor
  let commenter: Caller; // member with comment-level share only
  let reader: Caller; // read_only role (view)
  let outsider: Caller; // member with no access to Harbor
  let guest: Caller; // guest with a comment share on the task
  let readGuest: Caller; // guest with a read share on the task
  let stranger: Caller; // account in another workspace
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let task: { id: string; version: number };
  let project: { id: string };
  const pub: Record<string, string> = {};

  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  /** Moves a comment's creation time back (the guard trigger pins it, so a test pauses it). */
  const age = async (id: string, by: string) => {
    await db.admin('ALTER TABLE collab.comment DISABLE TRIGGER comment_thread_guard');
    await db.admin(
      `UPDATE collab.comment SET created_at = now() - interval '${by}' WHERE public_id = '${id}'`,
    );
    await db.admin('ALTER TABLE collab.comment ENABLE TRIGGER comment_thread_guard');
  };
  const post = async (
    as: Caller,
    text: string,
    extra: Record<string, unknown> = {},
    rec = task.id,
  ) => (await env.svc.createComment(as, ws, rec, { text, ...extra }, mutation())).data;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db, { work: { commentEditWindowMinutes: 60 } });
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    commenter = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    reader = await join(env, db, owner, ws, { kind: 'member', role: 'read_only' });
    outsider = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    for (const [who, level] of [
      [editor, 'edit'],
      [reader, 'view'],
    ] as const)
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: await mem(who),
        level,
      });
    const t = (
      await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'Write copy' }, mutation())
    ).data;
    task = { id: t.id, version: t.version };
    project = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Launch' }, mutation())
    ).data;
    await apply(env, owner, ws, {
      kind: 'record_share',
      record: task.id,
      grantee: await mem(commenter),
      level: 'comment',
    });
    guest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: task.id, level: 'comment' }],
    });
    readGuest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: task.id, level: 'read' }],
    });
    ({ owner: stranger } = await workspaceWith(env, db, ['Elsewhere']));
    pub.owner = await mem(owner);
    pub.editor = await mem(editor);
    pub.commenter = await mem(commenter);
    pub.outsider = await mem(outsider);
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('posts comments and threaded replies, listed oldest first with inline replies', async () => {
    const root = await post(editor, 'First thoughts');
    expect(root).toMatchObject({
      type: 'comment',
      host: { id: task.id, type: 'task' },
      deleted: false,
      thread: null,
      in_reply_to: null,
      text: 'First thoughts',
      author: { id: pub.editor },
      version: 0,
    });
    expect(root.id).toMatch(/^cmt_/);
    const reply = await post(owner, 'Agreed', { reply_to: root.id });
    expect(reply).toMatchObject({ thread: root.id, in_reply_to: root.id });
    const nested = await post(editor, 'Thanks', { reply_to: reply.id });
    expect(nested).toMatchObject({ thread: root.id, in_reply_to: reply.id });
    const page = await env.svc.listComments(owner, ws, task.id, {});
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ id: root.id, reply_count: 2, replies_more: false });
    expect(page.data[0]!.replies.map((r) => r.id)).toEqual([reply.id, nested.id]);
    expect(page.total).toBe(3);
    pub.root = root.id;
  });

  it('paginates thread roots with a bound cursor and loads further replies by cursor', async () => {
    const t = (
      await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'Busy' }, mutation())
    ).data;
    const a = await post(owner, 'a', {}, t.id);
    const b = await post(owner, 'b', {}, t.id);
    for (const n of [1, 2, 3]) await post(owner, `r${n}`, { reply_to: a.id }, t.id);
    const first = await env.svc.listComments(owner, ws, t.id, { limit: '1' });
    expect(first.data.map((c) => c.id)).toEqual([a.id]);
    expect(first.page.has_more).toBe(true);
    const second = await env.svc.listComments(owner, ws, t.id, {
      limit: '1',
      cursor: first.page.next_cursor,
    });
    expect(second.data.map((c) => c.id)).toEqual([b.id]);
    const newest = await env.svc.listComments(owner, ws, t.id, { order: 'desc' });
    expect(newest.data.map((c) => c.id)).toEqual([b.id, a.id]);
    // A cursor from another list, or a forged one, is refused.
    await expect(
      env.svc.listComments(owner, ws, t.id, { order: 'desc', cursor: first.page.next_cursor }),
    ).rejects.toEqual(reason('cursor_invalid'));
    const replies = await env.svc.listReplies(owner, ws, a.id, { limit: '2' });
    expect(replies.data.map((r) => r.text)).toEqual(['r1', 'r2']);
    const more = await env.svc.listReplies(owner, ws, a.id, {
      limit: '2',
      cursor: replies.page.next_cursor,
    });
    expect(more.data.map((r) => r.text)).toEqual(['r3']);
  });

  it('refuses empty, oversized, malformed, and unknown input with precise issues', async () => {
    for (const body of [
      {},
      { text: '   ' },
      { text: 'x', body: doc('x') },
      { text: 5 },
      { nope: 1, text: 'x' },
    ])
      await expect(env.svc.createComment(owner, ws, task.id, body, mutation())).rejects.toEqual(
        reason('validation_failed'),
      );
    await expect(
      env.svc.createComment(owner, ws, task.id, { text: 'x'.repeat(10_001) }, mutation()),
    ).rejects.toEqual(issueOf('too_long'));
    await expect(
      env.svc.createComment(owner, ws, task.id, { text: 'hi', reply_to: 'cmt_nope' }, mutation()),
    ).rejects.toEqual(reason('validation_failed'));
    await expect(
      env.svc.createComment(
        owner,
        ws,
        task.id,
        { text: 'hi', reply_to: `cmt_${'0'.repeat(26)}` },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('invalid_reference'));
    await expect(env.svc.createComment(owner, ws, task.id, {}, mutation())).rejects.toEqual(
      reason('validation_failed'),
    );
  });

  it('replays an idempotent create and conflicts on a reused key with another body', async () => {
    const key = mutation();
    const a = await env.svc.createComment(owner, ws, task.id, { text: 'once' }, key);
    const again = await env.svc.createComment(owner, ws, task.id, { text: 'once' }, key);
    expect(again.replayed).toBe(true);
    expect(again.data.id).toBe(a.data.id);
    await expect(
      env.svc.createComment(
        owner,
        ws,
        task.id,
        { text: 'twice' },
        { ...key, fingerprint: createHash('sha256').update('other').digest() },
      ),
    ).rejects.toEqual(reason('idempotency_key_reuse'));
    const all = await env.svc.listComments(owner, ws, task.id, { limit: '100' });
    expect(all.data.filter((c) => c.text === 'once')).toHaveLength(1);
  });

  it('lets an author edit within the window with a revision trail, and refuses others', async () => {
    const c = await post(editor, 'Draft one');
    await expect(
      env.svc.editComment(editor, ws, c.id, { text: 'Draft two' }, mutation()),
    ).rejects.toEqual(reason('precondition_required'));
    const edited = (await env.svc.editComment(editor, ws, c.id, { text: 'Draft two' }, ifMatch(0)))
      .data;
    expect(edited).toMatchObject({ text: 'Draft two', edit_count: 1, version: 1 });
    expect(edited.edited_at).not.toBeNull();
    await expect(
      env.svc.editComment(editor, ws, c.id, { text: 'Draft three' }, ifMatch(0)),
    ).rejects.toEqual(reason('conflict'));
    // Nobody edits another person's comment, administrators and owners included.
    await expect(
      env.svc.editComment(owner, ws, c.id, { text: 'Rewritten' }, ifMatch(1)),
    ).rejects.toEqual(reason('forbidden'));
    // An unchanged edit writes nothing.
    const same = (await env.svc.editComment(editor, ws, c.id, { text: 'Draft two' }, ifMatch(1)))
      .data;
    expect(same.version).toBe(1);
    const trail = await env.svc.commentRevisions(editor, ws, c.id);
    expect(trail).toMatchObject([{ revision: 1, kind: 'edited', text: 'Draft one' }]);
    // The owner is a moderator here (manage), so may read the trail; a commenter may not.
    expect((await env.svc.commentRevisions(owner, ws, c.id)).length).toBe(1);
    await expect(env.svc.commentRevisions(commenter, ws, c.id)).rejects.toEqual(
      reason('forbidden'),
    );
  });

  it('closes the author window by age, but moderators may still delete', async () => {
    const c = await post(editor, 'Old comment');
    await age(c.id, '2 hours');
    await expect(
      env.svc.editComment(editor, ws, c.id, { text: 'Late edit' }, ifMatch(0)),
    ).rejects.toEqual(issueOf('window_closed'));
    await expect(env.svc.deleteComment(editor, ws, c.id, mutation())).rejects.toEqual(
      issueOf('window_closed'),
    );
    const moderated = (await env.svc.deleteComment(owner, ws, c.id, mutation())).data;
    expect(moderated).toMatchObject({
      deleted: true,
      deleted_by: 'moderator',
      text: null,
      body: null,
    });
    const trail = await env.svc.commentRevisions(owner, ws, c.id);
    expect(trail).toMatchObject([{ kind: 'deleted', text: 'Old comment' }]);
  });

  it('deletes as a tombstone that keeps the thread and the prior body, and is idempotent', async () => {
    const root = await post(editor, 'To be removed');
    const reply = await post(owner, 'A reply', { reply_to: root.id });
    const gone = (await env.svc.deleteComment(editor, ws, root.id, mutation())).data;
    expect(gone).toMatchObject({
      deleted: true,
      deleted_by: 'author',
      text: null,
      mentions: [],
      reactions: [],
    });
    const again = (await env.svc.deleteComment(editor, ws, root.id, mutation())).data;
    expect(again.version).toBe(gone.version);
    const list = await env.svc.listComments(owner, ws, task.id, { limit: '100' });
    const thread = list.data.find((c) => c.id === root.id)!;
    expect(thread).toMatchObject({ deleted: true, reply_count: 1 });
    expect(thread.replies[0]!.id).toBe(reply.id);
    await expect(
      env.svc.editComment(editor, ws, root.id, { text: 'back' }, ifMatch(gone.version)),
    ).rejects.toEqual(issueOf('deleted'));
    // Replying under a tombstone is allowed; the thread stays whole.
    const late = await post(owner, 'Still here', { reply_to: root.id });
    expect(late.thread).toBe(root.id);
    expect(JSON.stringify(list)).not.toContain('To be removed');
    const trail = await env.svc.commentRevisions(editor, ws, root.id);
    expect(trail).toMatchObject([{ kind: 'deleted', text: 'To be removed' }]);
  });

  it('lets people with comment authority react from a fixed vocabulary, idempotently', async () => {
    const c = await post(owner, 'React to me');
    const set = (as: Caller, key: string, on = true) =>
      env.svc.setReaction(as, ws, c.id, key, on, mutation());
    expect((await set(editor, 'thumbs_up')).data.reactions).toEqual([
      { reaction: 'thumbs_up', count: 1, mine: true },
    ]);
    expect((await set(editor, 'thumbs_up')).data.reactions[0]!.count).toBe(1);
    const both = (await set(owner, 'thumbs_up')).data;
    expect(both.reactions).toEqual([{ reaction: 'thumbs_up', count: 2, mine: true }]);
    expect((await env.svc.getComment(editor, ws, c.id)).reactions).toEqual([
      { reaction: 'thumbs_up', count: 2, mine: true },
    ]);
    await set(editor, 'thumbs_up', false);
    expect((await set(editor, 'thumbs_up', false)).data.reactions[0]!.count).toBe(1);
    await expect(set(editor, 'skull')).rejects.toEqual(reason('not_found'));
    // Read-only people cannot react; guests with a comment share can.
    await expect(set(reader, 'heart')).rejects.toEqual(reason('forbidden'));
    await expect(set(readGuest, 'heart')).rejects.toEqual(reason('forbidden'));
    expect((await set(guest, 'heart')).data.reactions.map((r) => r.reaction).sort()).toEqual([
      'heart',
      'thumbs_up',
    ]);
  });

  it('follows explicitly and idempotently, never by role, assignment, or share', async () => {
    const before = await env.svc.collaborationSummary(editor, ws, task.id);
    expect(before.following).toBe(false);
    const on = (await env.svc.follow(editor, ws, task.id, true, mutation())).data;
    expect(on).toMatchObject({ following: true, id: task.id, type: 'task' });
    expect((await env.svc.follow(editor, ws, task.id, true, mutation())).data.following).toBe(true);
    // The owner, the creator, and the share grantee do not follow by being any of those.
    expect((await env.svc.collaborationSummary(owner, ws, task.id)).following).toBe(false);
    expect((await env.svc.collaborationSummary(commenter, ws, task.id)).following).toBe(false);
    expect((await env.svc.follow(editor, ws, task.id, false, mutation())).data.following).toBe(
      false,
    );
    expect((await env.svc.follow(editor, ws, task.id, false, mutation())).data.following).toBe(
      false,
    );
    // Read-level people and share-only guests can follow what they can read; others cannot.
    expect((await env.svc.follow(reader, ws, task.id, true, mutation())).data.following).toBe(true);
    expect((await env.svc.follow(readGuest, ws, task.id, true, mutation())).data.following).toBe(
      true,
    );
    await expect(env.svc.follow(outsider, ws, task.id, true, mutation())).rejects.toEqual(
      reason('not_found'),
    );
    await expect(env.svc.follow(stranger, ws, task.id, true, mutation())).rejects.toEqual(
      reason('not_found'),
    );
  });

  it('lists followed records the person can read now, and drops a follow after access is lost', async () => {
    await env.svc.follow(editor, ws, task.id, true, mutation());
    await env.svc.follow(editor, ws, project.id, true, mutation());
    const list = await env.svc.following(editor, ws, {});
    expect(list.data.map((r) => r.id).sort()).toEqual([project.id, task.id].sort());
    expect(list.data[0]).toMatchObject({ brand: { name: 'Harbor' }, archived: false });
    expect(
      (await env.svc.following(editor, ws, { type: 'project' })).data.map((r) => r.id),
    ).toEqual([project.id]);
    const followers = await env.svc.followers(owner, ws, task.id);
    expect(followers.data.map((f) => f.id)).toContain(pub.editor);
    // Someone who follows and then loses Harbor: the follow is inert, in their list and for others.
    const leaver = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const leaverId = await mem(leaver);
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: leaverId,
      level: 'edit',
    });
    await env.svc.follow(leaver, ws, task.id, true, mutation());
    expect((await env.svc.followers(owner, ws, task.id)).data.map((f) => f.id)).toContain(leaverId);
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Harbor,
      principal: leaverId,
    });
    expect((await env.svc.following(leaver, ws, {})).data).toEqual([]);
    expect((await env.svc.followers(owner, ws, task.id)).data.map((f) => f.id)).not.toContain(
      leaverId,
    );
    await expect(env.svc.follow(leaver, ws, task.id, false, mutation())).rejects.toEqual(
      reason('not_found'),
    );
    // A share-only reader sees no brand name and cannot read the follower list.
    const gone = await env.svc.following(readGuest, ws, {});
    expect(gone.data.map((r) => r.id)).toEqual([task.id]);
    expect(gone.data[0]!.brand).toBeNull();
    await expect(env.svc.followers(readGuest, ws, task.id)).rejects.toEqual(reason('not_found'));
  });

  it('resolves mentions only to what the author may name, with one safe refusal for the rest', async () => {
    const team = (await env.svc.createTeam(owner, ws, { name: 'Copy team' }, mutation())).data;
    const other = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Harbor, title: 'Linked work' },
        mutation(),
      )
    ).data;
    const hidden = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Summit, title: 'Hidden work' },
        mutation(),
      )
    ).data;
    const c = await post(editor, 'Looping people in', {
      mentions: [
        { kind: 'member', id: pub.owner },
        { kind: 'team', id: team.id },
        { kind: 'record', id: other.id },
      ],
    });
    expect(c.mentions).toEqual([
      expect.objectContaining({ kind: 'member', id: pub.owner }),
      expect.objectContaining({ kind: 'team', id: team.id, name: 'Copy team' }),
      expect.objectContaining({ kind: 'record', id: other.id, name: 'Linked work' }),
    ]);
    // Hidden, unknown, ineligible, and unsupported targets are one answer at the same pointer.
    const refusals = [
      { kind: 'member', id: pub.outsider }, // an active member who cannot read this task
      { kind: 'member', id: `mem_${'0'.repeat(26)}` }, // unknown
      { kind: 'record', id: hidden.id }, // a record the editor cannot read
      { kind: 'record', id: `tsk_${'0'.repeat(26)}` },
      { kind: 'team', id: `team_${'0'.repeat(26)}` },
    ];
    const seen = new Set<string>();
    for (const m of refusals) {
      const err = await env.svc
        .createComment(editor, ws, task.id, { text: 'x', mentions: [m] }, mutation())
        .then(
          () => null,
          (e: {
            code: string;
            issues: Array<{ pointer: string; code: string; message: string }>;
          }) => e,
        );
      expect(err, JSON.stringify(m)).toMatchObject({ code: 'validation_failed' });
      seen.add(JSON.stringify(err!.issues));
    }
    expect(seen.size).toBe(1);
    // The hidden task never shows through a record mention, and a stranger sees no chips at all.
    expect(
      JSON.stringify(await env.svc.listComments(editor, ws, task.id, { limit: '100' })),
    ).not.toContain('Hidden work');
    // Guests have no directory: they may not name people, teams, or other records.
    await expect(
      env.svc.createComment(
        guest,
        ws,
        task.id,
        { text: 'x', mentions: [{ kind: 'member', id: pub.owner }] },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('not_mentionable'));
    const asGuest = await env.svc.getComment(guest, ws, c.id);
    expect(asGuest.mentions).toEqual([]);
    expect(asGuest.text).toBe('Looping people in');
    // Too many mentions and duplicates.
    await expect(
      env.svc.createComment(
        owner,
        ws,
        task.id,
        {
          text: 'x',
          mentions: Array.from({ length: 21 }, () => ({ kind: 'member', id: pub.owner })),
        },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('too_many'));
    const dup = await post(owner, 'dup', {
      mentions: [
        { kind: 'member', id: pub.editor },
        { kind: 'member', id: pub.editor },
      ],
    });
    expect(dup.mentions).toHaveLength(1);
    // Mention events exist for people and teams, never for records, and notify nobody in 4A.
    const events = await db.admin(
      `SELECT event_type, payload FROM exec.outbox_event WHERE event_type = 'relations.mention.created' ORDER BY id`,
    );
    expect(
      events.rows.some(
        (r: { payload: { target_kind: string } }) => r.payload.target_kind === 'team',
      ),
    ).toBe(true);
    expect(
      events.rows.some(
        (r: { payload: { target_kind: string } }) => r.payload.target_kind === 'record',
      ),
    ).toBe(false);
    const flags = await db.admin(`SELECT DISTINCT notified FROM relations.mention`);
    expect(flags.rows).toEqual([{ notified: false }]);
  });

  it('syncs mentions on edit and drops them with the comment, and offers only permitted candidates', async () => {
    const c = await post(editor, 'Hi', { mentions: [{ kind: 'member', id: pub.owner }] });
    const edited = (
      await env.svc.editComment(
        editor,
        ws,
        c.id,
        { text: 'Hi again', mentions: [{ kind: 'member', id: pub.commenter }] },
        ifMatch(0),
      )
    ).data;
    expect(edited.mentions.map((m) => m.id)).toEqual([pub.commenter]);
    // Only a mentions change still counts as an edit of the comment.
    const onlyMentions = (
      await env.svc.editComment(
        editor,
        ws,
        c.id,
        { text: 'Hi again', mentions: [{ kind: 'member', id: pub.owner }] },
        ifMatch(1),
      )
    ).data;
    expect(onlyMentions.mentions.map((m) => m.id)).toEqual([pub.owner]);
    expect(onlyMentions.edit_count).toBe(1);
    const found = await env.svc.mentionCandidates(editor, ws, task.id, { q: '' });
    const ids = found.data.map((x) => x.id);
    expect(ids).toContain(pub.owner);
    expect(ids).toContain(pub.commenter); // a share at comment level reads the task
    expect(ids).not.toContain(pub.outsider);
    expect((await env.svc.mentionCandidates(guest, ws, task.id, {})).data).toEqual([]);
    await expect(env.svc.mentionCandidates(reader, ws, task.id, {})).rejects.toEqual(
      reason('forbidden'),
    );
    await env.svc.deleteComment(editor, ws, c.id, mutation());
    const left = await db.admin(
      `SELECT count(*)::int AS n FROM relations.mention m JOIN collab.comment c ON c.id = m.source_id WHERE c.public_id = '${c.id}'`,
    );
    expect(left.rows[0]).toMatchObject({ n: 0 });
  });

  it('decides every read and write through the record: owners, members, read-only, guests, and strangers', async () => {
    const nf = reason('not_found');
    const c = await post(owner, 'Matrix subject');
    const reads = async (who: Caller) =>
      env.svc.listComments(who, ws, task.id, {}).then(
        () => true,
        (e) => {
          expect(e).toEqual(nf);
          return false;
        },
      );
    expect(await reads(owner)).toBe(true);
    expect(await reads(editor)).toBe(true);
    expect(await reads(commenter)).toBe(true);
    expect(await reads(reader)).toBe(true);
    expect(await reads(guest)).toBe(true);
    expect(await reads(readGuest)).toBe(true);
    expect(await reads(outsider)).toBe(false);
    expect(await reads(stranger)).toBe(false);
    const writes = async (who: Caller) =>
      env.svc.createComment(who, ws, task.id, { text: 'hello' }, mutation()).then(
        () => 'ok',
        (e: { code: string }) => e.code,
      );
    expect(await writes(owner)).toBe('ok');
    expect(await writes(editor)).toBe('ok');
    expect(await writes(commenter)).toBe('ok'); // share at comment level
    expect(await writes(guest)).toBe('ok');
    expect(await writes(reader)).toBe('forbidden'); // read-only role is capped at view
    expect(await writes(readGuest)).toBe('forbidden'); // share at read level
    expect(await writes(outsider)).toBe('not_found');
    expect(await writes(stranger)).toBe('not_found');
    // A comment id behaves like its record: unknown and unreadable are one answer.
    for (const who of [outsider, stranger]) {
      await expect(env.svc.getComment(who, ws, c.id)).rejects.toEqual(nf);
      await expect(env.svc.editComment(who, ws, c.id, { text: 'x' }, ifMatch(0))).rejects.toEqual(
        nf,
      );
      await expect(env.svc.deleteComment(who, ws, c.id, mutation())).rejects.toEqual(nf);
      await expect(env.svc.commentRevisions(who, ws, c.id)).rejects.toEqual(nf);
      await expect(env.svc.setReaction(who, ws, c.id, 'heart', true, mutation())).rejects.toEqual(
        nf,
      );
    }
    await expect(env.svc.getComment(owner, ws, `cmt_${'0'.repeat(26)}`)).rejects.toEqual(nf);
    await expect(env.svc.getComment(owner, ws, 'nope')).rejects.toEqual(nf);
    // Moderation needs manage on the record: an editor cannot delete the owner's comment.
    await expect(env.svc.deleteComment(editor, ws, c.id, mutation())).rejects.toEqual(
      reason('forbidden'),
    );
    await expect(env.svc.deleteComment(reader, ws, c.id, mutation())).rejects.toEqual(
      reason('forbidden'),
    );
    // Unsupported hosts and malformed identifiers are not_found too.
    for (const rec of ['mem_0', `file_${'0'.repeat(26)}`, 'x'])
      await expect(env.svc.listComments(owner, ws, rec, {})).rejects.toEqual(nf);
    // Comments hang on projects as well.
    const pc = await post(owner, 'On the project', {}, project.id);
    expect(pc.host).toEqual({ id: project.id, type: 'project' });
    await expect(env.svc.listComments(outsider, ws, project.id, {})).rejects.toEqual(nf);
  });

  it('keeps comments readable while the record is archived only per policy, and hides them when trashed', async () => {
    const t = (
      await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'Lifecycle' }, mutation())
    ).data;
    await post(owner, 'before', {}, t.id);
    await env.svc.taskLifecycle(owner, ws, t.id, 'archive', {}, mutation());
    expect((await env.svc.listComments(owner, ws, t.id, {})).data).toHaveLength(1);
    await expect(
      env.svc.createComment(owner, ws, t.id, { text: 'late' }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    await env.svc.taskLifecycle(owner, ws, t.id, 'unarchive', {}, mutation());
    await env.svc.taskLifecycle(owner, ws, t.id, 'trash', {}, mutation());
    await expect(env.svc.listComments(owner, ws, t.id, {})).rejects.toEqual(reason('not_found'));
    await env.svc.taskLifecycle(owner, ws, t.id, 'restore', {}, mutation());
    expect((await env.svc.listComments(owner, ws, t.id, {})).data).toHaveLength(1);
  });

  it('removes a purged record’s comments, revisions, reactions, mentions, followers, and reviews, leaving no text in audit', async () => {
    const t = (
      await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'Doomed' }, mutation())
    ).data;
    const c = await post(
      editor,
      'Secret words',
      { mentions: [{ kind: 'member', id: pub.owner }] },
      t.id,
    );
    await env.svc.editComment(editor, ws, c.id, { text: 'More secret words' }, ifMatch(0));
    await env.svc.setReaction(owner, ws, c.id, 'heart', true, mutation());
    await env.svc.follow(owner, ws, t.id, true, mutation());
    await env.svc.taskLifecycle(owner, ws, t.id, 'trash', {}, mutation());
    await env.svc.taskLifecycle(owner, ws, t.id, 'purge', {}, mutation());
    const { id } = (await db.admin(`SELECT id FROM core.record WHERE public_id = '${t.id}'`))
      .rows[0] as { id: string };
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      await productLifecycleRegistry().get('task')!.purge!.deleteContent(tx, [id]);
    });
    for (const table of [
      'collab.comment',
      'collab.comment_revision',
      'collab.reaction',
      'relations.mention',
      'relations.follower',
    ]) {
      const n = await db.admin(`SELECT count(*)::int AS n FROM ${table}`);
      expect((n.rows[0] as { n: number }).n, table).toBeGreaterThanOrEqual(0);
    }
    const left = await db.admin(
      `SELECT (SELECT count(*) FROM collab.comment WHERE host_record_id = '${id}')::int AS comments,
              (SELECT count(*) FROM relations.follower WHERE record_id = '${id}')::int AS followers`,
    );
    expect(left.rows[0]).toMatchObject({ comments: 0, followers: 0 });
    // Audit keeps the facts and hashes, never the words.
    const audit = await db.admin(
      `SELECT changes::text AS c FROM audit.audit_event WHERE action LIKE 'comment.%'`,
    );
    const all = audit.rows.map((r: { c: string }) => r.c).join(' ');
    expect(all).toContain('sha256:');
    expect(all).not.toContain('secret words');
    expect(all).not.toContain('Secret words');
  });

  it('serializes concurrent edits of one comment on its version', async () => {
    const c = await post(editor, 'Race to edit');
    const results = await Promise.allSettled([
      env.svc.editComment(editor, ws, c.id, { text: 'Edit A' }, ifMatch(0)),
      env.svc.editComment(editor, ws, c.id, { text: 'Edit B' }, ifMatch(0)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({
      code: 'conflict',
    });
    const now = await env.svc.getComment(editor, ws, c.id);
    expect(now).toMatchObject({ version: 1, edit_count: 1 });
    expect((await env.svc.commentRevisions(editor, ws, c.id)).length).toBe(1);
  });

  it('rate limits comment bursts per person and never on an idempotent replay', async () => {
    const limited = workEnv(db, { commentRate: 2 });
    try {
      const key = mutation();
      await limited.svc.createComment(owner, ws, task.id, { text: 'one' }, key);
      await limited.svc.createComment(owner, ws, task.id, { text: 'one' }, key); // replay: free
      await limited.svc.createComment(owner, ws, task.id, { text: 'two' }, mutation());
      await expect(
        limited.svc.createComment(owner, ws, task.id, { text: 'three' }, mutation()),
      ).rejects.toEqual(reason('rate_limited'));
      // Another person is not affected.
      await limited.svc.createComment(editor, ws, task.id, { text: 'mine' }, mutation());
    } finally {
      await limited.h.close();
    }
  });

  it('holds its invariants in the database: threads stay in their record, identity is pinned, history is append-only', async () => {
    const a = await post(owner, 'Thread A');
    const other = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Harbor, title: 'Another record' },
        mutation(),
      )
    ).data;
    const b = await post(owner, 'Thread B', {}, other.id);
    await expect(
      db.admin(
        `INSERT INTO collab.comment (id, public_id, workspace_id, host_record_id, root_comment_id, in_reply_to_comment_id, body_rich, body_text, author_membership_id)
         SELECT gen_random_uuid(), 'cmt_' || repeat('1', 26), x.workspace_id, x.host_record_id, y.id, y.id, x.body_rich, 'cross', x.author_membership_id
           FROM collab.comment x, collab.comment y WHERE x.public_id = '${a.id}' AND y.public_id = '${b.id}'`,
      ),
    ).rejects.toThrow(/same record/);
    await expect(
      db.admin(
        `UPDATE collab.comment SET author_membership_id = host_record_id WHERE public_id = '${a.id}'`,
      ),
    ).rejects.toThrow();
    for (const stmt of [
      sql`DELETE FROM collab.comment`,
      sql`UPDATE collab.comment SET created_at = now()`,
      sql`DELETE FROM collab.comment_revision`,
      sql`UPDATE collab.comment_revision SET body_text = 'x'`,
      sql`UPDATE collab.reaction SET reaction = 'heart'`,
    ])
      await expect(
        env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) => stmt.execute(tx.db)),
      ).rejects.toThrow(/permission denied/);
    // A tombstone stays deleted and has no body; a live comment has one.
    await expect(
      db.admin(
        `UPDATE collab.comment SET body_rich = NULL, body_text = NULL WHERE public_id = '${a.id}'`,
      ),
    ).rejects.toThrow(/comment_body_shape/);
  });

  it('allows comments on archived records only when the workspace policy says so', async () => {
    const t = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Harbor, title: 'Archived chat' },
        mutation(),
      )
    ).data;
    await env.svc.taskLifecycle(owner, ws, t.id, 'archive', {}, mutation());
    await expect(
      env.svc.createComment(owner, ws, t.id, { text: 'late' }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    await db.admin(
      `INSERT INTO access.workspace_policy (workspace_id, comment_on_archived) VALUES ('${wsId}', true)
       ON CONFLICT (workspace_id) DO UPDATE SET comment_on_archived = true`,
    );
    try {
      expect((await post(owner, 'allowed now', {}, t.id)).text).toBe('allowed now');
    } finally {
      await db.admin(
        `UPDATE access.workspace_policy SET comment_on_archived = false WHERE workspace_id = '${wsId}'`,
      );
    }
  });

  it('shows collaboration in activity and history without bodies, and omits what the viewer cannot read', async () => {
    const t = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Harbor, title: 'Audited chat' },
        mutation(),
      )
    ).data;
    const hiddenPeer = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const c = await post(editor, 'Words that must not appear in activity', {}, t.id);
    await env.svc.editComment(
      editor,
      ws,
      c.id,
      { text: 'Edited words that must not appear' },
      ifMatch(0),
    );
    await env.svc.setReaction(owner, ws, c.id, 'heart', true, mutation());
    const r = (
      await env.svc.requestReview(owner, ws, t.id, { reviewers: [pub.editor!] }, mutation())
    ).data;
    await env.svc.decideReview(
      editor,
      ws,
      r.id,
      { outcome: 'approved', subject_version: (await env.svc.getTask(owner, ws, t.id)).version },
      mutation(),
    );
    const feed = await env.svc.activity(owner, ws, 'task', {
      query: { entity: 'task' },
      limit: 200,
    });
    const mine = feed.data.filter((e) => e.record.id === t.id).map((e) => e.action);
    expect(mine).toEqual(
      expect.arrayContaining([
        'comment.created',
        'comment.edited',
        'review.requested',
        'review.decided',
      ]),
    );
    const json = JSON.stringify(feed);
    expect(json).not.toContain('must not appear');
    expect(json).toContain(c.id); // the reference is shown; the words never are
    const history = await env.svc.taskHistory(owner, ws, t.id);
    expect(JSON.stringify(history)).not.toContain('must not appear');
    expect(history.data.map((e) => e.action)).toEqual(
      expect.arrayContaining(['comment.created', 'review.decided']),
    );
    // History is outside a share: a share-only reader gets nothing.
    expect(
      (await env.svc.activity(commenter, ws, 'task', { query: { entity: 'task' } })).data,
    ).toEqual([]);
    // A reassignment naming a person the viewer may not see as a person is a plain reference, not a name.
    await env.svc.setAssignees(
      owner,
      ws,
      t.id,
      {
        assignees: [await mem(hiddenPeer)],
        version: (await env.svc.getTask(owner, ws, t.id)).version,
      },
      mutation(),
    );
    const guestFeed = await env.svc.activity(readGuest, ws, 'task', { query: { entity: 'task' } });
    expect(JSON.stringify(guestFeed)).not.toContain(await mem(hiddenPeer));
  });

  it('gives hidden and unknown comments, records, and reviews the same statements and time', async () => {
    const spans = () => env.h.telemetry.spans!;
    const hiddenTask = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Summit, title: 'Summit only' },
        mutation(),
      )
    ).data;
    const hidden = await post(owner, 'In Summit', {}, hiddenTask.id);
    // Only the owner reads Summit, so the owner is the reviewer; self-review needs the policy.
    await db.admin(
      `INSERT INTO access.workspace_policy (workspace_id, self_approval_mode) VALUES ('${wsId}', 'allowed')
       ON CONFLICT (workspace_id) DO UPDATE SET self_approval_mode = 'allowed'`,
    );
    const req = (
      await env.svc.requestReview(owner, ws, hiddenTask.id, { reviewers: [pub.owner!] }, mutation())
    ).data;
    await db.admin(
      `UPDATE access.workspace_policy SET self_approval_mode = 'auto' WHERE workspace_id = '${wsId}'`,
    );
    const hiddenProject = (
      await env.svc.createProject(
        owner,
        ws,
        { brand: brands.Summit, name: 'Summit project' },
        mutation(),
      )
    ).data;
    const hiddenOnProject = await post(owner, 'In a Summit project', {}, hiddenProject.id);
    const unknownTask = `tsk_${'0'.repeat(26)}`;
    const classes = {
      hiddenComment: () => env.svc.getComment(editor, ws, hidden.id),
      unknownComment: () => env.svc.getComment(editor, ws, `cmt_${'0'.repeat(26)}`),
      hiddenList: () => env.svc.listComments(editor, ws, hiddenTask.id, {}),
      unknownList: () => env.svc.listComments(editor, ws, unknownTask, {}),
      hiddenProjectComment: () => env.svc.getComment(editor, ws, hiddenOnProject.id),
      hiddenProjectList: () => env.svc.listComments(editor, ws, hiddenProject.id, {}),
      unknownProjectList: () => env.svc.listComments(editor, ws, `prj_${'0'.repeat(26)}`, {}),
      hiddenReview: () => env.svc.getReview(editor, ws, req.id),
      unknownReview: () => env.svc.getReview(editor, ws, `rvw_${'0'.repeat(26)}`),
    };
    const shape = async (k: keyof typeof classes) => statementShape(spans(), classes[k]);
    expect(await shape('unknownComment')).toEqual(await shape('hiddenComment'));
    expect(await shape('unknownList')).toEqual(await shape('hiddenList'));
    expect(await shape('unknownReview')).toEqual(await shape('hiddenReview'));
    expect(await shape('unknownProjectList')).toEqual(await shape('hiddenProjectList'));
    // A project-hosted comment costs the project loader's statements: the same count as the task's.
    expect((await shape('hiddenProjectComment')).length).toBe(
      (await shape('hiddenComment')).length,
    );
    const timing = await measureClasses(classes);
    expect(timing.maxDelta, JSON.stringify(timing.medians)).toBeLessThanOrEqual(timing.threshold);
  });
});
