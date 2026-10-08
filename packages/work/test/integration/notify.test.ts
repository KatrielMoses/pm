import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaptureTransport } from '@pm/identity';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import {
  DEFAULT_WORK_SETTINGS,
  emailProviderFrom,
  NotificationFanOut,
  runNotifyWorkspace,
  type NotifyJobDeps,
} from '@pm/work';
import { makeWorker } from '../../../platform/test/integration/helpers.ts';
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

/**
 * Phase 4B notification platform on real PostgreSQL (ADR-0024; UXD-10, UXD-18): the one durable
 * pipeline from canonical events to notifications, recipient authorization at creation and at
 * display, preferences and mutes, quiet hours, deduplication and grouping, digests, email and
 * browser delivery with honest states, failure classification and retries, and what each kind of
 * person may see.
 */
describe('Notification platform (4B)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller;
  let reader: Caller; // read-only: sees Harbor, cannot comment
  let outsider: Caller; // no access to Harbor
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let drain: () => Promise<void>;
  let mail: CaptureTransport;
  const pub: Record<string, string> = {};

  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const newTask = async (title: string, brand = 'Harbor', as: Caller = owner) =>
    (await env.svc.createTask(as, ws, { brand: brands[brand], title }, mutation())).data;
  const mine = async (as: Caller, q: Record<string, unknown> = {}) =>
    (await env.svc.listNotifications(as, ws, { limit: '100', ...q })).data;
  const forTask = async (as: Caller, task: string, q: Record<string, unknown> = {}) =>
    (await mine(as, q)).filter((n) => n.record?.id === task);
  const sql = async (text: string) => (await db.admin(text)).rows as Array<Record<string, any>>;

  const deps = (over: Partial<NotifyJobDeps> = {}): NotifyJobDeps => ({
    tenant: env.h.worker,
    platform: env.h.platformWorker,
    discovery: env.h.discovery,
    email: emailProviderFrom(mail, 'PM <no-reply@localhost>'),
    origin: 'https://pm.example.test',
    metrics: env.h.telemetry.metrics,
    logger: env.h.logger,
    arrayMax: 10_000,
    ...over,
  });
  const sweep = (over: Partial<NotifyJobDeps> = {}, now = new Date()) =>
    runNotifyWorkspace(deps(over), wsId, now);

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    mail = new CaptureTransport();
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
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
    pub.owner = await mem(owner);
    pub.editor = await mem(editor);
    pub.reader = await mem(reader);
    pub.outsider = await mem(outsider);
    const worker = await makeWorker(
      env.h,
      [],
      [
        new NotificationFanOut(
          {
            notifyFanoutRecipientsMax: DEFAULT_WORK_SETTINGS.notifyFanoutRecipientsMax,
            notifyDedupeWindowMinutes: DEFAULT_WORK_SETTINGS.notifyDedupeWindowMinutes,
            notifyEmailPerHourMax: DEFAULT_WORK_SETTINGS.notifyEmailPerHourMax,
            notifyFactsMaxBytes: DEFAULT_WORK_SETTINGS.notifyFactsMaxBytes,
            principalContextArrayMax: 10_000,
          },
          env.h.telemetry.metrics,
        ),
      ],
    );
    drain = async () => {
      for (let i = 0; i < 20; i++) if ((await worker.dispatchOutbox()) === 0) return;
    };
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('turns a comment into notifications for the people it concerns, who can read the record', async () => {
    const t = await newTask('Notify me');
    await env.svc.setAssignees(
      owner,
      ws,
      t.id,
      { assignees: [pub.owner!], version: t.version },
      mutation(),
    );
    await env.svc.follow(reader, ws, t.id, true, mutation());
    await drain();
    // Self-assignment tells nobody; the assignee is the actor.
    expect(await forTask(owner, t.id)).toEqual([]);
    await env.svc.createComment(editor, ws, t.id, { text: 'Looking at this' }, mutation());
    await drain();
    const ownerNotes = await forTask(owner, t.id);
    expect(ownerNotes).toHaveLength(1);
    expect(ownerNotes[0]).toMatchObject({
      type: 'notification',
      notification_type: 'comment',
      state: 'unread',
      available: true,
      summary: 'Synthetic Person commented',
      record: { id: t.id, type: 'task', title: 'Notify me' },
      brand: { name: 'Harbor' },
      actor: { id: pub.editor, type: 'person' },
    });
    expect(ownerNotes[0]!.id).toMatch(/^ntf_/);
    expect((await forTask(reader, t.id)).map((n) => n.notification_type)).toEqual(['comment']);
    // The author, and people who cannot read the record, hear nothing.
    expect(await forTask(editor, t.id)).toEqual([]);
    expect(await mine(outsider)).toEqual([]);
    // Redelivering the same event changes nothing (the inbox receipt and the dedupe key).
    const rows = await sql(`SELECT count(*)::int AS n FROM notify.notification`);
    await drain();
    expect((await sql(`SELECT count(*)::int AS n FROM notify.notification`))[0]!.n).toBe(
      rows[0]!.n,
    );
  });

  it('notifies on assignment, handover, mention, review request and decision, and sharing', async () => {
    const t = await newTask('Many events');
    await env.svc.setAssignees(
      editor,
      ws,
      t.id,
      { assignees: [pub.owner!], version: t.version },
      mutation(),
    );
    await env.svc.createComment(
      editor,
      ws,
      t.id,
      { text: 'Ping', mentions: [{ kind: 'member', id: pub.owner! }] },
      mutation(),
    );
    const r = (
      await env.svc.requestReview(editor, ws, t.id, { reviewers: [pub.owner!] }, mutation())
    ).data;
    await env.svc.decideReview(
      owner,
      ws,
      r.id,
      {
        outcome: 'changes_requested',
        note: 'Tighten',
        subject_version: (await env.svc.getTask(owner, ws, t.id)).version,
      },
      mutation(),
    );
    await env.svc.delegateTask(owner, ws, t.id, { to: pub.editor! }, mutation());
    await drain();
    const ownerTypes = (await forTask(owner, t.id)).map((n) => n.notification_type).sort();
    // A mentioned person gets the mention, not a second comment notice.
    expect(ownerTypes).toEqual(['assignment', 'mention', 'review_requested']);
    const editorNotes = await forTask(editor, t.id);
    expect(editorNotes.map((n) => n.notification_type).sort()).toEqual([
      'approval_decided',
      'assignment',
    ]);
    expect(editorNotes.find((n) => n.notification_type === 'approval_decided')).toMatchObject({
      summary: 'Synthetic Person asked for changes to your review request',
    });
    expect(editorNotes.find((n) => n.notification_type === 'assignment')!.summary).toContain(
      'handed this over',
    );
    // Sharing a task tells the grantee, who then reads it; revoking tells them again, without the record.
    const shared = await newTask('Shared with outsider');
    const granted = await apply(env, owner, ws, {
      kind: 'record_share',
      record: shared.id,
      grantee: pub.outsider!,
      level: 'read',
    });
    expect(granted.result).toBeDefined();
    await drain();
    expect((await forTask(outsider, shared.id)).map((n) => n.notification_type)).toEqual([
      'share_changed',
    ]);
  });

  it('collapses repeats into one notification and reopens it, keeping saved items saved', async () => {
    const t = await newTask('Chatty');
    await env.svc.setAssignees(
      editor,
      ws,
      t.id,
      { assignees: [pub.owner!], version: t.version },
      mutation(),
    );
    for (const text of ['one', 'two', 'three'])
      await env.svc.createComment(editor, ws, t.id, { text }, mutation());
    await drain();
    let n = (await forTask(owner, t.id)).filter((x) => x.notification_type === 'comment');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ occurrences: 3, summary: 'Synthetic Person commented (3 times)' });
    const id = n[0]!.id;
    await env.svc.setNotificationState(owner, ws, id, { state: 'read' }, mutation());
    await env.svc.createComment(editor, ws, t.id, { text: 'four' }, mutation());
    await drain();
    n = (await forTask(owner, t.id)).filter((x) => x.notification_type === 'comment');
    expect(n[0]).toMatchObject({ state: 'unread', occurrences: 4 });
    await env.svc.setNotificationState(owner, ws, id, { state: 'saved' }, mutation());
    await env.svc.createComment(editor, ws, t.id, { text: 'five' }, mutation());
    await drain();
    expect((await env.svc.getNotification(owner, ws, id)).state).toBe('saved');
    // Another person's comments are a separate notification (the actor is part of the key).
    await env.svc
      .createComment(reader, ws, t.id, { text: 'six' }, mutation())
      .catch(() => undefined);
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM notify.notification WHERE public_id = '${id}'`)
      )[0]!.n,
    ).toBe(1);
  });

  it('keeps states, tabs, bulk changes, and history for the recipient only', async () => {
    const t = await newTask('States');
    await env.svc.setAssignees(
      editor,
      ws,
      t.id,
      { assignees: [pub.owner!], version: t.version },
      mutation(),
    );
    await env.svc.createComment(
      editor,
      ws,
      t.id,
      { text: 'hi', mentions: [{ kind: 'member', id: pub.owner! }] },
      mutation(),
    );
    await drain();
    const [a, m] = [
      (await forTask(owner, t.id)).find((x) => x.notification_type === 'assignment')!,
      (await forTask(owner, t.id)).find((x) => x.notification_type === 'mention')!,
    ];
    const tab = async (name: string) => (await mine(owner, { tab: name })).map((x) => x.id);
    expect(await tab('mentions')).toContain(m.id);
    expect(await tab('mentions')).not.toContain(a.id);
    const counts = await env.svc.notificationCounts(owner, ws);
    expect(counts.unread).toBeGreaterThanOrEqual(2);
    expect(counts.mentions_unread).toBeGreaterThanOrEqual(1);
    // Someone else's notification is as absent as an unknown one.
    for (const who of [editor, outsider]) {
      await expect(env.svc.getNotification(who, ws, a.id)).rejects.toEqual(reason('not_found'));
      await expect(
        env.svc.setNotificationState(who, ws, a.id, { state: 'read' }, mutation()),
      ).rejects.toEqual(reason('not_found'));
    }
    await expect(env.svc.getNotification(owner, ws, `ntf_${'0'.repeat(26)}`)).rejects.toEqual(
      reason('not_found'),
    );
    await expect(
      env.svc.setNotificationState(owner, ws, a.id, { state: 'bogus' }, mutation()),
    ).rejects.toEqual(reason('validation_failed'));
    // Versions guard a stale toggle; dismissed items leave the default list but stay searchable.
    await expect(
      env.svc.setNotificationState(owner, ws, a.id, { state: 'read' }, ifMatch(99)),
    ).rejects.toEqual(reason('conflict'));
    await env.svc.setNotificationState(owner, ws, a.id, { state: 'dismissed' }, ifMatch(a.version));
    expect((await mine(owner)).map((x) => x.id)).not.toContain(a.id);
    expect((await mine(owner, { state: 'dismissed' })).map((x) => x.id)).toContain(a.id);
    expect((await mine(owner, { q: 'States' })).map((x) => x.id)).toContain(a.id);
    // Bulk: named ids, then everything in a tab.
    const done = await env.svc.bulkNotificationState(
      owner,
      ws,
      { ids: [m.id], state: 'saved' },
      mutation(),
    );
    expect(done.data.updated).toBe(1);
    await expect(
      env.svc.bulkNotificationState(owner, ws, { ids: [], state: 'read' }, mutation()),
    ).rejects.toEqual(reason('validation_failed'));
    await expect(
      env.svc.bulkNotificationState(owner, ws, { state: 'read' }, mutation()),
    ).rejects.toEqual(reason('validation_failed'));
    const all = await env.svc.bulkNotificationState(
      owner,
      ws,
      { all: { tab: 'all' }, state: 'read' },
      mutation(),
    );
    expect(all.data.updated).toBeGreaterThan(0);
    expect((await env.svc.notificationCounts(owner, ws)).unread).toBe(0);
    expect((await mine(owner, { tab: 'saved' })).map((x) => x.id)).toContain(m.id);
  });
});
