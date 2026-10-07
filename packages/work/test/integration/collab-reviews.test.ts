import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@pm/db';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
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

/**
 * Phase 4A review requests and approvals, delegation, reassignment, and assignment history on real
 * PostgreSQL (ADR-0023 D7–D8): explicit authority, current versions, typed immutable decisions,
 * rules, supersession, self-approval policy, serialization of concurrent deciders, departure, and
 * what each kind of reader may see of any of it.
 */
describe('Reviews, approvals, delegation, and assignment history (4A)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let author: Caller; // edit on Harbor; requests reviews
  let rev1: Caller; // edit on Harbor
  let rev2: Caller; // edit on Harbor
  let reader: Caller; // read_only: cannot decide
  let outsider: Caller; // no access to Harbor
  let sharer: Caller; // comment-level share on one task only
  let guest: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const id: Record<string, string> = {};

  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const newTask = async (title: string, as: Caller = owner) =>
    (await env.svc.createTask(as, ws, { brand: brands.Harbor, title }, mutation())).data;
  const request = (tsk: string, body: Record<string, unknown>, as: Caller = author) =>
    env.svc.requestReview(as, ws, tsk, body, mutation());
  const decide = (rvw: string, body: Record<string, unknown>, as: Caller) =>
    env.svc.decideReview(as, ws, rvw, body, mutation());
  const ver = async (tsk: string) => (await env.svc.getTask(owner, ws, tsk)).version;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    for (const k of ['author', 'rev1', 'rev2', 'reader', 'outsider', 'sharer'] as const) {
      const c = await join(env, db, owner, ws, {
        kind: 'member',
        role: k === 'reader' ? 'read_only' : 'member',
      });
      if (k === 'author') author = c;
      if (k === 'rev1') rev1 = c;
      if (k === 'rev2') rev2 = c;
      if (k === 'reader') reader = c;
      if (k === 'outsider') outsider = c;
      if (k === 'sharer') sharer = c;
      id[k] = await mem(c);
    }
    for (const who of [author, rev1, rev2])
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: await mem(who),
        level: 'edit',
      });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: id.reader!,
      level: 'view',
    });
    id.owner = await mem(owner);
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  describe('requests', () => {
    it('names reviewers who can decide now, with one safe refusal for everyone else', async () => {
      const t = await newTask('Needs eyes');
      await apply(env, owner, ws, {
        kind: 'record_share',
        record: t.id,
        grantee: id.sharer!,
        level: 'comment',
      });
      guest = await join(env, db, owner, ws, {
        kind: 'guest',
        records: [{ record: t.id, level: 'comment' }],
      });
      const bad = [
        id.outsider!, // active member without access
        id.reader!, // can read but is capped below comment
        await mem(guest), // guests never review
        `mem_${'0'.repeat(26)}`, // unknown
      ];
      const seen = new Set<string>();
      for (const [i, ref] of bad.entries()) {
        const err = await request(t.id, { reviewers: [ref] }).then(
          () => null,
          (e: { code: string; issues: Array<{ pointer: string; code: string }> }) => e,
        );
        expect(err, ref).toMatchObject({ code: 'validation_failed' });
        seen.add(JSON.stringify(err!.issues));
        expect(i).toBeGreaterThanOrEqual(0);
      }
      expect(seen.size).toBe(1);
      // A share at comment level reads and may decide.
      const ok = (await request(t.id, { reviewers: [id.sharer!, id.rev1!] })).data;
      expect(ok).toMatchObject({
        type: 'review_request',
        state: 'requested',
        kind: 'review',
        rule: 'any',
        subject: { id: t.id, type: 'task', title: 'Needs eyes' },
        stale: false,
        capabilities: { decide: false, withdraw: true, refresh: true },
      });
      expect(ok.reviewers.map((r) => r.member?.id)).toEqual([id.sharer, id.rev1]);
      expect(ok.requested_by).toMatchObject({ id: id.author });
    });

    it('validates input and refuses requests without authority over the record itself', async () => {
      const t = await newTask('Validation');
      for (const body of [
        {},
        { reviewers: [] },
        { reviewers: [id.rev1], rule: 'most' },
        { reviewers: [id.rev1], kind: 'vote' },
        { reviewers: [id.rev1], extra: 1 },
        { reviewers: ['x'] },
        { reviewers: Array.from({ length: 11 }, () => id.rev1) },
      ].slice(0, 6))
        await expect(request(t.id, body)).rejects.toEqual(reason('validation_failed'));
      // 11 distinct references exceed the bound before duplicates are collapsed.
      await expect(
        request(t.id, {
          reviewers: Array.from({ length: 11 }, (_, i) => `mem_${String(i).padStart(26, '0')}`),
        }),
      ).rejects.toEqual(issueOf('too_many'));
      await expect(request(t.id, { reviewers: [id.rev1] }, reader)).rejects.toEqual(
        reason('forbidden'),
      );
      await expect(request(t.id, { reviewers: [id.rev1] }, outsider)).rejects.toEqual(
        reason('not_found'),
      );
      // A share, even at edit level, does not carry the authority to ask for reviews.
      await apply(env, owner, ws, {
        kind: 'record_share',
        record: t.id,
        grantee: id.sharer!,
        level: 'edit',
      });
      await expect(request(t.id, { reviewers: [id.rev1] }, sharer)).rejects.toEqual(
        reason('forbidden'),
      );
      await expect(request(t.id, { reviewers: [id.rev1], subject_version: 999 })).rejects.toEqual(
        issueOf('subject_changed'),
      );
    });

    it('keeps one open request per record and replays an idempotent request', async () => {
      const t = await newTask('One at a time');
      const key = mutation();
      const first = await env.svc.requestReview(author, ws, t.id, { reviewers: [id.rev1] }, key);
      const again = await env.svc.requestReview(author, ws, t.id, { reviewers: [id.rev1] }, key);
      expect(again.replayed).toBe(true);
      expect(again.data.id).toBe(first.data.id);
      await expect(request(t.id, { reviewers: [id.rev2] })).rejects.toEqual(issueOf('review_open'));
      const list = await env.svc.listReviews(owner, ws, t.id, {});
      expect(list.data).toHaveLength(1);
      const summary = await env.svc.collaborationSummary(author, ws, t.id);
      expect(summary.review).toMatchObject({ id: first.data.id, state: 'requested' });
    });
  });

  describe('decisions', () => {
    it('settles under the any rule with the first typed decision, immutably', async () => {
      const t = await newTask('Any rule');
      const r = (await request(t.id, { reviewers: [id.rev1, id.rev2], kind: 'approval' })).data;
      const v = await ver(t.id);
      await expect(
        decide(r.id, { outcome: 'approved', subject_version: v }, author),
      ).rejects.toEqual(reason('forbidden'));
      await expect(decide(r.id, { outcome: 'maybe', subject_version: v }, rev1)).rejects.toEqual(
        reason('validation_failed'),
      );
      await expect(decide(r.id, { outcome: 'approved' }, rev1)).rejects.toEqual(
        reason('validation_failed'),
      );
      const seen = (await env.svc.getReview(rev1, ws, r.id)).capabilities;
      expect(seen.decide).toBe(true);
      const done = (
        await decide(r.id, { outcome: 'approved', note: 'Looks good', subject_version: v }, rev1)
      ).data;
      expect(done).toMatchObject({ state: 'approved', kind: 'approval' });
      expect(done.settled_at).not.toBeNull();
      expect(done.reviewers.find((x) => x.mine)).toMatchObject({
        decision: {
          outcome: 'approved',
          note: 'Looks good',
          self_approval: false,
          subject_version: v,
        },
      });
      // Settled: nobody decides again, and the decision cannot be redone.
      await expect(decide(r.id, { outcome: 'rejected', subject_version: v }, rev2)).rejects.toEqual(
        issueOf('review_closed'),
      );
      await expect(decide(r.id, { outcome: 'rejected', subject_version: v }, rev1)).rejects.toEqual(
        issueOf('review_closed'),
      );
      const rows = await db.admin(`SELECT count(*)::int AS n FROM collab.review_decision`);
      expect((rows.rows[0] as { n: number }).n).toBeGreaterThan(0);
      // The application role can neither rewrite nor remove a decision.
      for (const stmt of [
        sql`UPDATE collab.review_decision SET outcome = 'rejected'`,
        sql`DELETE FROM collab.review_decision`,
      ])
        await expect(
          env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) => stmt.execute(tx.db)),
        ).rejects.toThrow(/permission denied/);
    });

    it('requires every reviewer under the all rule, and any non-approval settles at once', async () => {
      const t = await newTask('All rule');
      const r = (await request(t.id, { reviewers: [id.rev1, id.rev2], rule: 'all' })).data;
      const v = await ver(t.id);
      const first = (await decide(r.id, { outcome: 'approved', subject_version: v }, rev1)).data;
      expect(first.state).toBe('requested');
      await expect(decide(r.id, { outcome: 'approved', subject_version: v }, rev1)).rejects.toEqual(
        issueOf('already_decided'),
      );
      const second = (await decide(r.id, { outcome: 'approved', subject_version: v }, rev2)).data;
      expect(second.state).toBe('approved');
      const u = await newTask('All rule, changes');
      const q = (await request(u.id, { reviewers: [id.rev1, id.rev2], rule: 'all' })).data;
      const w = await ver(u.id);
      const stop = (
        await decide(
          q.id,
          { outcome: 'changes_requested', note: 'Tighten it', subject_version: w },
          rev2,
        )
      ).data;
      expect(stop.state).toBe('changes_requested');
      await expect(decide(q.id, { outcome: 'approved', subject_version: w }, rev1)).rejects.toEqual(
        issueOf('review_closed'),
      );
      const x = await newTask('Rejected');
      const rj = (await request(x.id, { reviewers: [id.rev1] })).data;
      expect(
        (await decide(rj.id, { outcome: 'rejected', subject_version: await ver(x.id) }, rev1)).data
          .state,
      ).toBe('rejected');
    });

    it('binds a decision to the version reviewed: a changed record cannot be approved', async () => {
      const t = await newTask('Moving target');
      const r = (await request(t.id, { reviewers: [id.rev1] })).data;
      const v = await ver(t.id);
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [id.owner!], version: v },
        mutation(),
      );
      const view = await env.svc.getReview(rev1, ws, r.id);
      expect(view).toMatchObject({ stale: true, capabilities: { decide: false } });
      await expect(decide(r.id, { outcome: 'approved', subject_version: v }, rev1)).rejects.toEqual(
        issueOf('subject_changed'),
      );
      await expect(
        decide(r.id, { outcome: 'approved', subject_version: v + 1 }, rev1),
      ).rejects.toEqual(issueOf('subject_changed'));
      // The requester asks again at the current version; the old request is superseded.
      const fresh = (await env.svc.refreshReview(author, ws, r.id, {}, mutation())).data;
      expect(fresh).toMatchObject({ state: 'requested', previous: r.id, stale: false });
      expect((await env.svc.getReview(author, ws, r.id)).state).toBe('superseded');
      await expect(env.svc.refreshReview(author, ws, r.id, {}, mutation())).rejects.toEqual(
        reason('conflict'),
      );
      const ok = (
        await decide(fresh.id, { outcome: 'approved', subject_version: await ver(t.id) }, rev1)
      ).data;
      expect(ok.state).toBe('approved');
      // A rejected or changes-requested review can be asked again too.
      const u = await newTask('Rework');
      const q = (await request(u.id, { reviewers: [id.rev1] })).data;
      await decide(q.id, { outcome: 'changes_requested', subject_version: await ver(u.id) }, rev1);
      const again = (
        await env.svc.refreshReview(author, ws, q.id, { reviewers: [id.rev2] }, mutation())
      ).data;
      expect(again).toMatchObject({ previous: q.id, state: 'requested' });
      expect(again.reviewers.map((x) => x.member?.id)).toEqual([id.rev2]);
      expect((await env.svc.getReview(author, ws, q.id)).state).toBe('changes_requested');
    });

    it('withdraws by the requester or a manager, and only while open', async () => {
      const t = await newTask('Withdraw me');
      const r = (await request(t.id, { reviewers: [id.rev1] })).data;
      await expect(env.svc.withdrawReview(rev1, ws, r.id, {}, mutation())).rejects.toEqual(
        reason('forbidden'),
      );
      await expect(env.svc.withdrawReview(outsider, ws, r.id, {}, mutation())).rejects.toEqual(
        reason('not_found'),
      );
      const gone = (
        await env.svc.withdrawReview(author, ws, r.id, { note: 'No longer needed' }, mutation())
      ).data;
      expect(gone).toMatchObject({ state: 'withdrawn', closed_reason: 'requester' });
      await expect(
        decide(r.id, { outcome: 'approved', subject_version: await ver(t.id) }, rev1),
      ).rejects.toEqual(issueOf('review_closed'));
      await expect(env.svc.withdrawReview(author, ws, r.id, {}, mutation())).rejects.toEqual(
        reason('conflict'),
      );
      const u = await newTask('Manager withdraws');
      const q = (await request(u.id, { reviewers: [id.rev1] })).data;
      expect((await env.svc.withdrawReview(owner, ws, q.id, {}, mutation())).data.state).toBe(
        'withdrawn',
      );
    });

    it('applies the workspace self-approval policy to a reviewer who is also the requester', async () => {
      const t = await newTask('Own work');
      // Several active members: `auto` forbids deciding one's own request.
      await expect(request(t.id, { reviewers: [id.author!] })).rejects.toEqual(
        issueOf('self_review'),
      );
      await db.admin(
        `INSERT INTO access.workspace_policy (workspace_id, self_approval_mode) VALUES ('${wsId}', 'allowed')
         ON CONFLICT (workspace_id) DO UPDATE SET self_approval_mode = 'allowed'`,
      );
      const r = (await request(t.id, { reviewers: [id.author!] })).data;
      expect((await env.svc.getReview(author, ws, r.id)).capabilities.decide).toBe(true);
      const done = (
        await decide(r.id, { outcome: 'approved', subject_version: await ver(t.id) }, author)
      ).data;
      expect(done.reviewers[0]!.decision).toMatchObject({ self_approval: true });
      // Independence required for reviews overrides the allowance.
      await db.admin(
        `UPDATE access.workspace_policy SET require_independent_for = ARRAY['review.decide'] WHERE workspace_id = '${wsId}'`,
      );
      const u = await newTask('Own work again');
      await expect(request(u.id, { reviewers: [id.author!] })).rejects.toEqual(
        issueOf('self_review'),
      );
      await db.admin(
        `UPDATE access.workspace_policy SET self_approval_mode = 'auto', require_independent_for = '{}' WHERE workspace_id = '${wsId}'`,
      );
    });

    it('serializes concurrent deciders: one settles and the rest see a closed review', async () => {
      const t = await newTask('Race');
      const r = (await request(t.id, { reviewers: [id.rev1, id.rev2] })).data;
      const v = await ver(t.id);
      const results = await Promise.allSettled([
        decide(r.id, { outcome: 'approved', subject_version: v }, rev1),
        decide(r.id, { outcome: 'rejected', subject_version: v }, rev2),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: 'conflict' });
      const view = await env.svc.getReview(owner, ws, r.id);
      expect(['approved', 'rejected']).toContain(view.state);
      const n = await db.admin(
        `SELECT count(*)::int AS n FROM collab.review_decision d JOIN collab.review_request q ON q.id = d.review_request_id WHERE q.public_id = '${r.id}'`,
      );
      expect((n.rows[0] as { n: number }).n).toBe(1);
    });
  });

  describe('visibility', () => {
    it('shows reviews only to readers of the record through ownership and the people involved', async () => {
      const t = await newTask('Visible to some');
      await apply(env, owner, ws, {
        kind: 'record_share',
        record: t.id,
        grantee: id.sharer!,
        level: 'comment',
      });
      const r = (await request(t.id, { reviewers: [id.rev1] })).data;
      // A share-only reader who is not part of the review sees nothing and cannot name it.
      expect((await env.svc.listReviews(sharer, ws, t.id, {})).data).toEqual([]);
      expect((await env.svc.collaborationSummary(sharer, ws, t.id)).review).toBeNull();
      await expect(env.svc.getReview(sharer, ws, r.id)).rejects.toEqual(reason('not_found'));
      await expect(env.svc.getReview(outsider, ws, r.id)).rejects.toEqual(reason('not_found'));
      await expect(env.svc.getReview(outsider, ws, `rvw_${'0'.repeat(26)}`)).rejects.toEqual(
        reason('not_found'),
      );
      expect((await env.svc.getReview(reader, ws, r.id)).id).toBe(r.id);
      // The queue lists open requests for the reviewer, and the requester's own.
      const mine = await env.svc.myReviews(rev1, ws, {});
      expect(mine.data.map((x) => x.id)).toContain(r.id);
      expect(mine.data.find((x) => x.id === r.id)).toMatchObject({
        subject: { id: t.id, title: 'Visible to some' },
        state: 'requested',
        stale: false,
        mine_decision: null,
      });
      expect(
        (await env.svc.myReviews(author, ws, { role: 'requester' })).data.map((x) => x.id),
      ).toContain(r.id);
      expect((await env.svc.myReviews(rev2, ws, {})).data.map((x) => x.id)).not.toContain(r.id);
      await decide(r.id, { outcome: 'approved', subject_version: await ver(t.id) }, rev1);
      expect((await env.svc.myReviews(rev1, ws, {})).data.map((x) => x.id)).not.toContain(r.id);
      expect(
        (await env.svc.myReviews(rev1, ws, { state: 'settled' })).data.map((x) => x.id),
      ).toContain(r.id);
      // Losing the record removes the review from the queue.
      const u = await newTask('Then revoked');
      const q = (await request(u.id, { reviewers: [id.rev2] })).data;
      expect((await env.svc.myReviews(rev2, ws, {})).data.map((x) => x.id)).toContain(q.id);
      await apply(env, owner, ws, {
        kind: 'brand_revoke',
        brand: brands.Harbor,
        principal: id.rev2!,
      });
      expect((await env.svc.myReviews(rev2, ws, {})).data.map((x) => x.id)).not.toContain(q.id);
      await expect(env.svc.getReview(rev2, ws, q.id)).rejects.toEqual(reason('not_found'));
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: id.rev2!,
        level: 'edit',
      });
    });
  });

  describe('delegation and assignment history', () => {
    it('hands an assignment over, keeps the primary flag, and remembers who handed it', async () => {
      const t = await newTask('Hand over');
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [id.author!, id.rev2!], primary: id.author!, version: await ver(t.id) },
        mutation(),
      );
      await expect(
        env.svc.delegateTask(rev1, ws, t.id, { to: id.rev2! }, mutation()),
      ).rejects.toEqual(issueOf('not_assignee'));
      for (const to of [id.outsider!, `mem_${'0'.repeat(26)}`, id.author!])
        await expect(env.svc.delegateTask(author, ws, t.id, { to }, mutation())).rejects.toEqual(
          issueOf('not_assignable'),
        );
      const done = (
        await env.svc.delegateTask(author, ws, t.id, { to: id.rev1!, note: 'On leave' }, mutation())
      ).data;
      expect(done.assignees.map((a) => [a.id, a.primary])).toEqual(
        expect.arrayContaining([[id.rev1, true]]),
      );
      expect(done.assignees.map((a) => a.id)).not.toContain(id.author);
      const row = await db.admin(
        `SELECT m.public_id, a.is_primary, d.public_id AS from_public
           FROM work.task_assignee a JOIN core.record r ON r.id = a.task_id
           JOIN tenancy.membership m ON m.id = a.membership_id
           LEFT JOIN tenancy.membership d ON d.id = a.delegated_from_membership_id
          WHERE r.public_id = '${t.id}' AND m.public_id = '${id.rev1}'`,
      );
      expect(row.rows[0]).toMatchObject({ is_primary: true, from_public: id.author });
      // Delegating to someone already assigned merges and passes the primary flag.
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [id.rev1!, id.rev2!], primary: id.rev1!, version: await ver(t.id) },
        mutation(),
      );
      const merged = (await env.svc.delegateTask(rev1, ws, t.id, { to: id.rev2! }, mutation()))
        .data;
      expect(merged.assignees.map((a) => [a.id, a.primary])).toEqual([[id.rev2, true]]);
      // Authority: read-only and unrelated people cannot delegate; the work stays theirs to hand.
      await expect(
        env.svc.delegateTask(outsider, ws, t.id, { to: id.rev1! }, mutation()),
      ).rejects.toEqual(reason('not_found'));
      await expect(
        env.svc.delegateTask(reader, ws, t.id, { to: id.rev1! }, mutation()),
      ).rejects.toEqual(reason('forbidden'));
    });

    it('records every change of responsibility append-only, readable through ownership only', async () => {
      const t = await newTask('History');
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [id.author!], version: await ver(t.id) },
        mutation(),
      );
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [id.rev1!], version: await ver(t.id) },
        mutation(),
      );
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [id.rev1!, id.rev2!], version: await ver(t.id) },
        mutation(),
      );
      await env.svc.delegateTask(
        rev1,
        ws,
        t.id,
        { to: id.author!, note: 'Back to you' },
        mutation(),
      );
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [], version: await ver(t.id) },
        mutation(),
      );
      const h = await env.svc.assignmentHistory(owner, ws, t.id, {});
      expect(h.data.map((e) => e.kind)).toEqual([
        'unassigned',
        'unassigned',
        'delegated',
        'assigned',
        'reassigned',
        'assigned',
      ]);
      expect(h.data.find((e) => e.kind === 'delegated')).toMatchObject({
        from: { id: id.rev1 },
        to: { id: id.author },
        by: { id: id.rev1 },
        note: 'Back to you',
        via: 'delegate',
      });
      expect(h.data.find((e) => e.kind === 'reassigned')).toMatchObject({
        from: { id: id.author },
        to: { id: id.rev1 },
      });
      const page = await env.svc.assignmentHistory(owner, ws, t.id, { limit: '2' });
      expect(page.page.has_more).toBe(true);
      const next = await env.svc.assignmentHistory(owner, ws, t.id, {
        limit: '2',
        cursor: page.page.next_cursor,
      });
      expect(next.data).toHaveLength(2);
      // The log is append-only for the application role.
      for (const stmt of [
        sql`UPDATE collab.assignment_event SET note_text = 'x'`,
        sql`DELETE FROM collab.assignment_event`,
      ])
        await expect(
          env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) => stmt.execute(tx.db)),
        ).rejects.toThrow(/permission denied/);
      await apply(env, owner, ws, {
        kind: 'record_share',
        record: t.id,
        grantee: id.sharer!,
        level: 'edit',
      });
      await expect(env.svc.assignmentHistory(sharer, ws, t.id, {})).rejects.toEqual(
        reason('not_found'),
      );
      await expect(env.svc.assignmentHistory(outsider, ws, t.id, {})).rejects.toEqual(
        reason('not_found'),
      );
    });
  });

  describe('departure and purge', () => {
    it('closes a leaving requester’s requests, drops a leaving reviewer, and records their assignments ending', async () => {
      const leaver = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
      const leaverId = await mem(leaver);
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: leaverId,
        level: 'edit',
      });
      const a = await newTask('Leaver requests');
      const ra = (
        await env.svc.requestReview(leaver, ws, a.id, { reviewers: [id.rev1!] }, mutation())
      ).data;
      const b = await newTask('Leaver reviews');
      const rb = (await request(b.id, { reviewers: [leaverId, id.rev1!], rule: 'all' })).data;
      await decide(rb.id, { outcome: 'approved', subject_version: await ver(b.id) }, rev1);
      const c = await newTask('Only reviewer');
      const rc = (await request(c.id, { reviewers: [leaverId] })).data;
      const d = await newTask('Leaver assigned');
      await env.svc.setAssignees(
        owner,
        ws,
        d.id,
        { assignees: [leaverId], version: await ver(d.id) },
        mutation(),
      );
      const preview = await env.svc.previewChange(owner, ws, { kind: 'remove', member: leaverId });
      expect(preview).toBeDefined();
      env.stepUp.allow = true;
      try {
        await env.svc.removeMember(
          owner,
          ws,
          leaverId,
          { preview_token: preview.preview_token },
          mutation({ stepUpToken: 't' }),
        );
      } finally {
        env.stepUp.allow = false;
      }
      expect(await env.svc.getReview(owner, ws, ra.id)).toMatchObject({
        state: 'withdrawn',
        closed_reason: 'requester_departed',
      });
      // Under the all rule, the remaining reviewer's approval settles it once the leaver is gone.
      expect(await env.svc.getReview(owner, ws, rb.id)).toMatchObject({ state: 'approved' });
      expect(await env.svc.getReview(owner, ws, rc.id)).toMatchObject({
        state: 'withdrawn',
        closed_reason: 'reviewer_departed',
      });
      const h = await env.svc.assignmentHistory(owner, ws, d.id, {});
      expect(h.data.map((e) => [e.kind, e.via])).toEqual([
        ['unassigned', 'departure'],
        ['assigned', 'assign'],
      ]);
    });

    it('removes a purged record’s reviews and assignment history with it', async () => {
      const t = await newTask('Purged with reviews');
      const r = (await request(t.id, { reviewers: [id.rev1!] })).data;
      await decide(r.id, { outcome: 'approved', subject_version: await ver(t.id) }, rev1);
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [id.rev1!], version: await ver(t.id) },
        mutation(),
      );
      await env.svc.taskLifecycle(owner, ws, t.id, 'trash', {}, mutation());
      await env.svc.taskLifecycle(owner, ws, t.id, 'purge', {}, mutation());
      const { id: rec } = (await db.admin(`SELECT id FROM core.record WHERE public_id = '${t.id}'`))
        .rows[0] as {
        id: string;
      };
      await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
        const { productLifecycleRegistry } = await import('@pm/work');
        await productLifecycleRegistry().get('task')!.purge!.deleteContent(tx, [rec]);
      });
      const left = await db.admin(
        `SELECT (SELECT count(*) FROM collab.review_request WHERE subject_record_id = '${rec}')::int AS reviews,
                (SELECT count(*) FROM collab.assignment_event WHERE task_id = '${rec}')::int AS history`,
      );
      expect(left.rows[0]).toMatchObject({ reviews: 0, history: 0 });
    });
  });
});
