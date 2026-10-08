import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaptureTransport } from '@pm/identity';
import { measureClasses, statementShape } from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { eraseMembershipNavigation, type Caller } from '@pm/tenancy';
import {
  DEFAULT_WORK_SETTINGS,
  DeliveryError,
  emailProviderFrom,
  type EmailProvider,
  NotificationFanOut,
  productLifecycleRegistry,
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

  describe('preferences, mutes, and quiet hours', () => {
    const setPref = (as: Caller, body: Record<string, unknown>) =>
      env.svc.setNotificationPreference(as, ws, body, mutation());
    const profile = async (as: Caller, body: Record<string, unknown>) =>
      (
        await env.svc.setNotificationProfile(
          as,
          ws,
          body,
          ifMatch((await env.svc.notificationProfile(as, ws)).version),
        )
      ).data;
    const deliveries = (noteId: string) =>
      sql(
        `SELECT d.channel, d.state, d.kind FROM notify.delivery d JOIN notify.notification n ON n.id = d.notification_id WHERE n.public_id = '${noteId}' ORDER BY d.channel`,
      );

    it('uses explicit defaults: email immediate for a mention and a digest for a comment, browser opt-in', async () => {
      const t = await newTask('Defaults');
      await env.svc.setAssignees(
        editor,
        ws,
        t.id,
        { assignees: [pub.owner!], version: t.version },
        mutation(),
      );
      await env.svc.createComment(editor, ws, t.id, { text: 'c' }, mutation());
      await env.svc.createComment(
        editor,
        ws,
        t.id,
        { text: 'm', mentions: [{ kind: 'member', id: pub.owner! }] },
        mutation(),
      );
      await drain();
      const notes = await forTask(owner, t.id);
      const by = Object.fromEntries(notes.map((n) => [n.notification_type, n.id]));
      expect(await deliveries(by.mention!)).toEqual([
        { channel: 'email', state: 'pending', kind: 'notification' },
      ]);
      expect(await deliveries(by.comment!)).toEqual([]);
      expect(
        (
          await sql(
            `SELECT digest_pending FROM notify.notification WHERE public_id = '${by.comment}'`,
          )
        )[0]!.digest_pending,
      ).toBe(true);
      const defaults = (await env.svc.notificationPreferences(owner, ws)).defaults;
      expect(defaults.find((d) => d.event_type === 'comment')).toMatchObject({
        in_app: 'immediate',
        email: 'digest',
        browser: 'muted',
      });
      expect(defaults.find((d) => d.event_type === 'permission_changed')).toMatchObject({
        security: true,
      });
    });

    it('lets a more specific scope win, mutes drop notifications, and mutes can end', async () => {
      const t = await newTask('Muted');
      const quiet = await newTask('Not muted');
      for (const x of [t, quiet]) await env.svc.follow(owner, ws, x.id, true, mutation());
      await setPref(owner, { event_type: 'comment', scope: t.id, channel: 'all', mode: 'muted' });
      await setPref(owner, {
        event_type: '*',
        scope: brands.Harbor!,
        channel: 'email',
        mode: 'muted',
      });
      await env.svc.createComment(editor, ws, t.id, { text: 'muted' }, mutation());
      await env.svc.createComment(editor, ws, quiet.id, { text: 'heard' }, mutation());
      await drain();
      expect(await forTask(owner, t.id)).toEqual([]);
      expect(await forTask(owner, quiet.id)).toHaveLength(1);
      // The brand-wide email mute applies, so even a mention sends no email.
      await env.svc.createComment(
        editor,
        ws,
        quiet.id,
        { text: 'm', mentions: [{ kind: 'member', id: pub.owner! }] },
        mutation(),
      );
      await drain();
      const mention = (await forTask(owner, quiet.id)).find(
        (n) => n.notification_type === 'mention',
      )!;
      expect(await deliveries(mention.id)).toEqual([]);
      // Preferences list, replace idempotently, and remove.
      const list = (await env.svc.notificationPreferences(owner, ws)).data;
      expect(list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ scope: t.id, scope_name: 'Muted', mode: 'muted' }),
        ]),
      );
      await setPref(owner, { event_type: 'comment', scope: t.id, channel: 'all', mode: 'muted' });
      expect((await env.svc.notificationPreferences(owner, ws)).data).toHaveLength(list.length);
      await env.svc.removeNotificationPreference(
        owner,
        ws,
        { event_type: 'comment', scope: t.id, channel: 'all' },
        mutation(),
      );
      await env.svc.removeNotificationPreference(
        owner,
        ws,
        { event_type: 'comment', scope: t.id, channel: 'all' },
        mutation(),
      );
      await env.svc.removeNotificationPreference(
        owner,
        ws,
        { event_type: '*', scope: brands.Harbor!, channel: 'email' },
        mutation(),
      );
      await env.svc.createComment(editor, ws, t.id, { text: 'now heard' }, mutation());
      await drain();
      expect(await forTask(owner, t.id)).toHaveLength(1);
      // A timed mute expires on its own (an expired row is ignored when resolving).
      await setPref(owner, {
        event_type: 'mention',
        scope: 'workspace',
        channel: 'email',
        mode: 'muted',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await db.admin(
        `UPDATE notify.preference SET expires_at = now() - interval '1 minute' WHERE event_type = 'mention'`,
      );
      await env.svc.removeNotificationPreference(
        owner,
        ws,
        { event_type: 'mention', scope: 'workspace', channel: 'email' },
        mutation(),
      );
    });

    it('refuses invalid choices and scopes the person cannot open, with one answer', async () => {
      for (const body of [
        { event_type: 'bogus', scope: 'workspace', channel: 'email', mode: 'muted' },
        { event_type: 'comment', scope: 'workspace', channel: 'in_app', mode: 'digest' },
        { event_type: 'comment', scope: 'workspace', channel: 'all', mode: 'immediate' },
        { event_type: 'comment', scope: 'nope', channel: 'email', mode: 'muted' },
        {
          event_type: 'comment',
          scope: 'workspace',
          channel: 'email',
          mode: 'immediate',
          expires_at: new Date(Date.now() + 1000).toISOString(),
        },
      ])
        await expect(setPref(owner, body)).rejects.toEqual(reason('validation_failed'));
      const summit = await newTask('Summit only', 'Summit');
      const seen = new Set<string>();
      for (const scope of [
        summit.id,
        `tsk_${'0'.repeat(26)}`,
        `br_${'0'.repeat(26)}`,
        brands.Summit!,
      ]) {
        const err = await setPref(editor, {
          event_type: 'comment',
          scope,
          channel: 'email',
          mode: 'muted',
        }).then(
          () => null,
          (e: { issues: unknown }) => e,
        );
        expect(err).toMatchObject({ code: 'validation_failed' });
        seen.add(JSON.stringify(err!.issues));
      }
      expect(seen.size).toBe(1);
    });

    it('holds non-security email in quiet hours but never the notification centre or a security notice', async () => {
      const t = await newTask('Quiet');
      await env.svc
        .setAssignees(
          editor,
          ws,
          t.id,
          { assignees: [pub.outsider!, pub.owner!], version: t.version },
          mutation(),
        )
        .catch(() => undefined);
      const now = new Date();
      const hhmm = (d: Date) =>
        `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
      await profile(owner, {
        timezone: 'UTC',
        quiet_hours: {
          start: hhmm(new Date(now.getTime() - 3_600_000)),
          end: hhmm(new Date(now.getTime() + 3_600_000)),
        },
      });
      await env.svc.createComment(
        editor,
        ws,
        t.id,
        { text: 'q', mentions: [{ kind: 'member', id: pub.owner! }] },
        mutation(),
      );
      await drain();
      const mention = (await forTask(owner, t.id)).find((n) => n.notification_type === 'mention')!;
      expect(mention.state).toBe('unread'); // the centre is unaffected
      const held = await deliveries(mention.id);
      expect(held).toEqual([
        { channel: 'email', state: 'deferred_quiet_hours', kind: 'notification' },
      ]);
      const due = await sql(
        `SELECT next_attempt_at > now() AS later FROM notify.delivery d JOIN notify.notification n ON n.id = d.notification_id WHERE n.public_id = '${mention.id}'`,
      );
      expect(due[0]!.later).toBe(true);
      // Nothing is sent for it while the window is open, even if the sweep runs.
      await sweep();
      expect((await deliveries(mention.id))[0]!.state).toBe('deferred_quiet_hours');
      // After the window, the hold releases and the message goes out.
      await sweep({}, new Date(now.getTime() + 3 * 3_600_000));
      await sweep({}, new Date(now.getTime() + 3 * 3_600_000));
      expect((await deliveries(mention.id))[0]!.state).toBe('delivered');
      // Security notices ignore quiet hours.
      const grant = await newTask('Shared in the night');
      await apply(env, owner, ws, {
        kind: 'record_share',
        record: grant.id,
        grantee: pub.owner!,
        level: 'read',
      }).catch(() => undefined);
      await profile(owner, { quiet_hours: null });
      const profileNow = await env.svc.notificationProfile(owner, ws);
      expect(profileNow.quiet_hours).toBeNull();
    });

    it('validates the profile and reports what each channel can truthfully do', async () => {
      const p0 = await env.svc.notificationProfile(editor, ws);
      expect(p0).toMatchObject({
        email_enabled: true,
        browser_enabled: false,
        digest_cadence: 'daily',
        channels: {
          in_app: { state: 'available' },
          email: { state: 'available', provider: 'capture' },
          browser: { state: 'off' },
        },
      });
      for (const body of [
        { quiet_hours: { start: '10:00', end: '10:00' } },
        { quiet_hours: { start: '25:00', end: '10:00' } },
        { timezone: 'Mars/Base' },
        { digest_cadence: 'hourly' },
        { weekly_digest_day: 9 },
        { surprise: 1 },
      ])
        await expect(
          env.svc.setNotificationProfile(editor, ws, body, ifMatch(p0.version)),
        ).rejects.toEqual(reason('validation_failed'));
      await expect(
        env.svc.setNotificationProfile(editor, ws, { email_enabled: false }, mutation()),
      ).rejects.toEqual(reason('precondition_required'));
      const set = (
        await env.svc.setNotificationProfile(
          editor,
          ws,
          {
            browser_enabled: true,
            browser_permission: 'granted',
            digest_cadence: 'weekly',
            weekly_digest_day: 5,
            weekly_digest_time: '09:30',
          },
          ifMatch(p0.version),
        )
      ).data;
      expect(set).toMatchObject({
        browser_enabled: true,
        digest_cadence: 'weekly',
        weekly_digest_day: 5,
        weekly_digest_time: '09:30',
        channels: { browser: { state: 'on' } },
        version: 1,
      });
      await expect(
        env.svc.setNotificationProfile(editor, ws, { email_enabled: false }, ifMatch(0)),
      ).rejects.toEqual(reason('conflict'));
      const bare = workEnv(db, { emailState: 'unconfigured' });
      try {
        expect((await bare.svc.notificationProfile(editor, ws)).channels.email).toEqual({
          state: 'not_configured',
          provider: 'unconfigured',
        });
      } finally {
        await bare.h.close();
      }
    });
  });

  describe('email delivery', () => {
    const deliveryOf = async (noteId: string) =>
      (
        await sql(
          `SELECT d.id, d.public_id, d.state, d.attempts, d.failure_class, d.failure_code, d.suppress_reason, d.provider_message_id, d.ack_source
             FROM notify.delivery d JOIN notify.notification n ON n.id = d.notification_id
            WHERE n.public_id = '${noteId}' AND d.channel = 'email'`,
        )
      )[0]!;
    const emailOf = async (c: Caller) =>
      (
        await db.admin(
          `SELECT primary_email FROM identity.account WHERE id = '${c.auth.account.id}'`,
        )
      ).rows[0]!.primary_email as string;
    const assignTo = async (title: string, who: string, brand = 'Harbor') => {
      const t = await newTask(title, brand);
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [who], version: t.version },
        mutation(),
      );
      await drain();
      return t;
    };
    const failing = (
      cls: 'transient' | 'permanent' | 'rate_limited',
      code: string,
    ): EmailProvider => ({
      name: 'flaky',
      state: 'configured',
      send: () => Promise.reject(new DeliveryError(cls, code)),
    });

    it('marks delivered only after the provider acknowledges, with standard content and a stable message id', async () => {
      const t = await assignTo('Standard subject line', pub.editor!);
      const note = (await forTask(editor, t.id))[0]!;
      expect((await deliveryOf(note.id)).state).toBe('pending');
      mail.messages.length = 0;
      await sweep();
      const row = await deliveryOf(note.id);
      expect(row).toMatchObject({
        state: 'delivered',
        ack_source: 'provider',
        failure_class: null,
      });
      expect(row.provider_message_id).toBe(`capture-${row.public_id}`);
      const sent = mail.messages.find((m) => m.to === 'x' || m.id === row.public_id)!;
      expect(sent.to).toBe(await emailOf(editor));
      expect(sent.subject).toContain('Standard subject line');
      expect(sent.subject).toContain('assigned you');
      expect(sent.text).toContain(`https://pm.example.test/workspaces/${ws}/tasks/${t.id}`);
      // Delivered once: a later sweep sends nothing more for it.
      mail.messages.length = 0;
      await sweep();
      expect(mail.messages.filter((m) => m.id === row.public_id)).toHaveLength(0);
    });

    it('names only the brand and the kind in email for a sensitive brand or a minimal-content brand (UXD-10)', async () => {
      env.stepUp.allow = true;
      await env.svc.setSensitivity(
        owner,
        ws,
        brands.Summit!,
        { is_sensitive: true },
        mutation({ ifMatch: '"0"', stepUpToken: 't' }),
      );
      env.stepUp.allow = false;
      const own = await newTask('Confidential acquisition', 'Summit');
      await env.svc.createComment(owner, ws, own.id, { text: 'mine' }, mutation());
      const grantee = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
      const gid = await mem(grantee);
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Summit,
        principal: gid,
        level: 'edit',
      });
      await env.svc.setAssignees(
        owner,
        ws,
        own.id,
        { assignees: [gid], version: (await env.svc.getTask(owner, ws, own.id)).version },
        mutation(),
      );
      await drain();
      mail.messages.length = 0;
      await sweep();
      const sent = mail.messages.filter((m) => !m.subject.includes('digest')).at(-1)!;
      expect(sent.subject).toBe('You have an assignment notification in Summit');
      expect(JSON.stringify(sent)).not.toContain('Confidential');
      // The in-app centre still shows the real title: that is re-authorized at display.
      expect((await forTask(grantee, own.id))[0]!.record!.title).toBe('Confidential acquisition');
      // A brand set to minimal behaves the same way, sensitive or not.
      await db.admin(
        `UPDATE tenancy.brand SET is_sensitive = false, notification_content_mode = 'minimal' WHERE id = (SELECT id FROM core.record WHERE public_id = '${brands.Summit}')`,
      );
      const two = await newTask('Board strategy', 'Summit');
      await env.svc.setAssignees(
        owner,
        ws,
        two.id,
        { assignees: [gid], version: two.version },
        mutation(),
      );
      await drain();
      mail.messages.length = 0;
      await sweep();
      const last = mail.messages.filter((m) => !m.subject.includes('digest')).at(-1)!;
      expect(last.subject).toBe('You have an assignment notification in Summit');
      expect(JSON.stringify(last)).not.toContain('Board strategy');
    });

    it('retries transient failures with backoff, then dead-letters; permanent failures stop at once', async () => {
      const t = await assignTo('Flaky provider', pub.editor!);
      const note = (await forTask(editor, t.id))[0]!;
      const small = { ...DEFAULT_WORK_SETTINGS, notifyDeliveryMaxAttempts: 3 };
      const at = Date.now();
      await sweep({ email: failing('transient', 'provider_unreachable'), settings: small });
      let row = await deliveryOf(note.id);
      expect(row).toMatchObject({
        state: 'pending',
        attempts: 1,
        failure_class: 'transient',
        failure_code: 'provider_unreachable',
      });
      const next = (
        await sql(
          `SELECT extract(epoch FROM next_attempt_at) * 1000 AS ms FROM notify.delivery WHERE id = '${row.id}'`,
        )
      )[0]!.ms;
      expect(Number(next) - at).toBeGreaterThanOrEqual(59_000);
      // Nothing is retried before its time.
      await sweep({ email: failing('transient', 'x'), settings: small });
      expect((await deliveryOf(note.id)).attempts).toBe(1);
      await sweep(
        { email: failing('rate_limited', 'provider_rate_limited'), settings: small },
        new Date(at + 3_600_000),
      );
      expect((await deliveryOf(note.id)).attempts).toBe(2);
      await sweep(
        { email: failing('transient', 'transport_error'), settings: small },
        new Date(at + 2 * 3_600_000),
      );
      row = await deliveryOf(note.id);
      expect(row).toMatchObject({ state: 'dead', attempts: 3, failure_class: 'transient' });
      // A permanent failure (a bounce) is not retried.
      const u = await assignTo('Bounces', pub.editor!);
      const unote = (await forTask(editor, u.id))[0]!;
      await sweep({ email: failing('permanent', 'provider_rejected') });
      expect(await deliveryOf(unote.id)).toMatchObject({
        state: 'failed',
        attempts: 1,
        failure_class: 'permanent',
        failure_code: 'provider_rejected',
      });
      // Administrators see both with who and why, never content; a retry reconciles.
      const problems = await env.svc.deliveryProblems(owner, ws, {});
      const ids = problems.data.map((d) => d.id);
      expect(ids).toEqual(expect.arrayContaining([row.public_id]));
      const seen = problems.data.find((d) => d.id === row.public_id)!;
      expect(seen).toMatchObject({
        channel: 'email',
        state: 'dead',
        failure_class: 'transient',
        recipient: { id: pub.editor },
      });
      expect(JSON.stringify(problems)).not.toMatch(/Flaky provider|Bounces|@/);
      await expect(env.svc.deliveryProblems(editor, ws, {})).rejects.toEqual(reason('forbidden'));
      await expect(env.svc.retryDelivery(editor, ws, row.public_id, mutation())).rejects.toEqual(
        reason('forbidden'),
      );
      await expect(
        env.svc.retryDelivery(owner, ws, `ndl_${'0'.repeat(26)}`, mutation()),
      ).rejects.toEqual(reason('not_found'));
      await env.svc.retryDelivery(owner, ws, row.public_id, mutation());
      expect((await deliveryOf(note.id)).state).toBe('pending');
      await expect(env.svc.retryDelivery(owner, ws, row.public_id, mutation())).rejects.toEqual(
        issueOf('not_retryable'),
      );
      await sweep();
      expect(await deliveryOf(note.id)).toMatchObject({ state: 'delivered', attempts: 1 });
      const audit = await sql(
        `SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'notification.delivery_retried'`,
      );
      expect(audit[0]!.n).toBeGreaterThanOrEqual(1);
    });

    it('never claims delivery without a provider: unconfigured email is suppressed with the reason', async () => {
      const t = await assignTo('No provider', pub.editor!);
      const note = (await forTask(editor, t.id))[0]!;
      await sweep({ email: emailProviderFrom(null, 'x') });
      expect(await deliveryOf(note.id)).toMatchObject({
        state: 'suppressed',
        suppress_reason: 'provider_unconfigured',
        provider_message_id: null,
      });
      const mineRows = (await env.svc.myDeliveries(editor, ws, {})).data;
      expect(
        mineRows.find((d) => d.notification === note.id && d.channel === 'email'),
      ).toMatchObject({
        state: 'suppressed',
        suppress_reason: 'provider_unconfigured',
      });
    });

    it('rechecks access, choices, and the address when sending: nothing leaves for what the person lost', async () => {
      const t = await assignTo('Revoked before send', pub.editor!);
      const note = (await forTask(editor, t.id))[0]!;
      await apply(env, owner, ws, {
        kind: 'brand_revoke',
        brand: brands.Harbor,
        principal: pub.editor!,
      });
      mail.messages.length = 0;
      await sweep();
      expect(await deliveryOf(note.id)).toMatchObject({
        state: 'suppressed',
        suppress_reason: 'access_lost',
      });
      expect(JSON.stringify(mail.messages)).not.toContain('Revoked before send');
      // In the centre the row keeps its time and state and loses everything else (IA-53).
      const row = (await mine(editor)).find((n) => n.id === note.id)!;
      expect(row).toMatchObject({
        available: false,
        summary: 'You no longer have access to this item',
        record: null,
        brand: null,
        project: null,
        actor: null,
      });
      expect(JSON.stringify(row)).not.toContain('Revoked before send');
      expect((await mine(editor, { q: 'Revoked before send' })).map((n) => n.id)).not.toContain(
        note.id,
      );
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: pub.editor!,
        level: 'edit',
      });
      // Turning email off, or muting after queueing, stops the send too.
      const a = await assignTo('Switched off', pub.editor!);
      const anote = (await forTask(editor, a.id))[0]!;
      await env.svc.setNotificationProfile(
        editor,
        ws,
        { email_enabled: false },
        ifMatch((await env.svc.notificationProfile(editor, ws)).version),
      );
      await sweep();
      expect(await deliveryOf(anote.id)).toMatchObject({
        state: 'suppressed',
        suppress_reason: 'email_disabled',
      });
      await env.svc.setNotificationProfile(
        editor,
        ws,
        { email_enabled: true },
        ifMatch((await env.svc.notificationProfile(editor, ws)).version),
      );
      const m = await assignTo('Muted after queue', pub.editor!);
      const mnote = (await forTask(editor, m.id))[0]!;
      await env.svc.setNotificationPreference(
        editor,
        ws,
        { event_type: 'assignment', scope: 'workspace', channel: 'email', mode: 'muted' },
        mutation(),
      );
      await sweep();
      expect(await deliveryOf(mnote.id)).toMatchObject({
        state: 'suppressed',
        suppress_reason: 'muted',
      });
      await env.svc.removeNotificationPreference(
        editor,
        ws,
        { event_type: 'assignment', scope: 'workspace', channel: 'email' },
        mutation(),
      );
    });

    it('reclaims a delivery whose sender crashed, under the same message id', async () => {
      const t = await assignTo('Crash recovery', pub.editor!);
      const note = (await forTask(editor, t.id))[0]!;
      const row = await deliveryOf(note.id);
      await db.admin(
        `UPDATE notify.delivery SET state = 'sending', lease_until = now() - interval '1 minute', attempts = 1 WHERE id = '${row.id}'`,
      );
      const ids: string[] = [];
      const recording: EmailProvider = {
        name: 'rec',
        state: 'configured',
        send: (m) => (ids.push(m.id), Promise.resolve({ providerMessageId: 'ok-1' })),
      };
      await sweep({ email: recording });
      expect(ids).toContain(row.public_id);
      expect(await deliveryOf(note.id)).toMatchObject({
        state: 'delivered',
        attempts: 2,
        provider_message_id: 'ok-1',
      });
      // A live lease is left alone.
      const u = await assignTo('Live lease', pub.editor!);
      const unote = (await forTask(editor, u.id))[0]!;
      await db.admin(
        `UPDATE notify.delivery SET state = 'sending', lease_until = now() + interval '1 hour' WHERE notification_id = (SELECT id FROM notify.notification WHERE public_id = '${unote.id}')`,
      );
      await sweep({ email: recording });
      expect((await deliveryOf(unote.id)).state).toBe('sending');
    });

    it('rolls email past the hourly limit into the digest instead of dropping it', async () => {
      const t = await newTask('Overflow');
      const note = await newTask('Overflow two');
      const before = await sql(
        `SELECT count(*)::int AS n FROM notify.notification WHERE digest_pending`,
      );
      // Fill the hour for the editor.
      const anchor = (await sql(`SELECT id, workspace_id FROM notify.notification LIMIT 1`))[0]!;
      const editorId = (
        await sql(`SELECT id FROM tenancy.membership WHERE public_id = '${pub.editor}'`)
      )[0]!.id;
      for (let i = 0; i < DEFAULT_WORK_SETTINGS.notifyEmailPerHourMax; i++)
        await db.admin(
          `INSERT INTO notify.delivery (id, public_id, workspace_id, recipient_membership_id, channel, kind, notification_id, state, suppress_reason)
           VALUES (gen_random_uuid(), 'ndl_' || upper(substr(md5(random()::text || ${i}::text), 1, 26)), '${anchor.workspace_id}', '${editorId}', 'email', 'notification', '${anchor.id}', 'suppressed', 'muted')`.replace(
            /'ndl_' \|\| upper\(substr\(md5\(random\(\)::text \|\| \d+::text\), 1, 26\)\)/,
            `'ndl_' || translate(upper(substr(md5(random()::text), 1, 26)), 'ILOU', '1010')`,
          ),
        );
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [pub.editor!], version: t.version },
        mutation(),
      );
      await drain();
      const n = (await forTask(editor, t.id))[0]!;
      expect(
        (
          await sql(
            `SELECT count(*)::int AS c FROM notify.delivery d JOIN notify.notification x ON x.id = d.notification_id WHERE x.public_id = '${n.id}' AND d.channel = 'email'`,
          )
        )[0]!.c,
      ).toBe(0);
      expect(
        (
          await sql(`SELECT digest_pending FROM notify.notification WHERE public_id = '${n.id}'`)
        )[0]!.digest_pending,
      ).toBe(true);
      expect(before).toBeDefined();
      expect(note).toBeDefined();
    });
  });

  describe('digests, browser, deadlines, retention, and administration', () => {
    const fresh = async (level: 'edit' | 'view' = 'edit') => {
      const who = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
      const id = await mem(who);
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: id,
        level,
      });
      return { who, id };
    };
    const profileOf = async (c: Caller, body: Record<string, unknown>) =>
      env.svc.setNotificationProfile(
        c,
        ws,
        body,
        ifMatch((await env.svc.notificationProfile(c, ws)).version),
      );
    const assign = async (task: { id: string; version: number }, who: string) =>
      env.svc.setAssignees(
        owner,
        ws,
        task.id,
        { assignees: [who], version: task.version },
        mutation(),
      );
    const rows = async (text: string) => sql(text);

    it('assembles one digest per slot, re-authorizes its items, and sends it once', async () => {
      const a = await fresh();
      await profileOf(a.who, { digest_cadence: 'daily', daily_digest_time: '00:00' });
      const t = await newTask('Digest subject');
      await env.svc.follow(a.who, ws, t.id, true, mutation());
      await env.svc.createComment(owner, ws, t.id, { text: 'first remark' }, mutation());
      await drain();
      const note = (await forTask(a.who, t.id)).find((n) => n.notification_type === 'comment')!;
      expect(note).toBeDefined();
      mail.messages.length = 0;
      await sweep();
      await sweep();
      const sent = mail.messages.filter((m) => m.subject.includes('digest'));
      const mineDigests = (await env.svc.myDeliveries(a.who, ws, {})).data.filter(
        (d) => d.kind === 'digest',
      );
      expect(mineDigests).toHaveLength(1);
      expect(mineDigests[0]).toMatchObject({ state: 'delivered' });
      expect(sent.some((m) => m.text.includes('Digest subject'))).toBe(true);
      expect(
        (await rows(`SELECT count(*)::int AS n FROM notify.digest WHERE item_count > 0`))[0]!.n,
      ).toBeGreaterThanOrEqual(1);
      expect(
        (
          await rows(
            `SELECT digest_pending FROM notify.notification WHERE public_id = '${note.id}'`,
          )
        )[0]!.digest_pending,
      ).toBe(false);

      // Items the person can no longer read never reach a digest: access is rechecked at assembly.
      const hidden = await newTask('Secret digest subject');
      await env.svc.follow(a.who, ws, hidden.id, true, mutation());
      await env.svc.createComment(owner, ws, hidden.id, { text: 'private' }, mutation());
      await drain();
      expect((await forTask(a.who, hidden.id)).some((n) => n.notification_type === 'comment')).toBe(
        true,
      );
      await apply(env, owner, ws, { kind: 'brand_revoke', brand: brands.Harbor, principal: a.id });
      await rows(
        `UPDATE notify.digest SET period_start = period_start - interval '30 days', period_end = period_end - interval '30 days' WHERE recipient_membership_id = (SELECT id FROM tenancy.membership WHERE public_id = '${a.id}')`,
      );
      mail.messages.length = 0;
      await sweep();
      expect(JSON.stringify(mail.messages)).not.toContain('Secret digest subject');
      expect(
        (
          await rows(
            `SELECT count(*)::int AS n FROM notify.notification n JOIN tenancy.membership m ON m.id = n.recipient_membership_id WHERE m.public_id = '${a.id}' AND n.digest_pending`,
          )
        )[0]!.n,
      ).toBe(0);
    });

    it('delivers to the browser only after the page reports it, and expires what nobody shows', async () => {
      const a = await fresh();
      await profileOf(a.who, { browser_enabled: true, browser_permission: 'granted' });
      const t = await newTask('Browser subject');
      await assign(t, a.id);
      await drain();
      const note = (await forTask(a.who, t.id))[0]!;
      const pending = (await env.svc.browserPending(a.who, ws)).data.filter(
        (d) => d.notification === note.id,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        notification: note.id,
        path: `/workspaces/${ws}/tasks/${t.id}`,
      });
      expect(pending[0]!.title).toContain('Browser subject');
      // Another person sees nothing and cannot acknowledge it.
      expect((await env.svc.browserPending(outsider, ws)).data).toEqual([]);
      await expect(
        env.svc.acknowledgeBrowser(
          outsider,
          ws,
          pending[0]!.delivery,
          { outcome: 'shown' },
          mutation(),
        ),
      ).rejects.toEqual(reason('not_found'));
      await env.svc.acknowledgeBrowser(
        a.who,
        ws,
        pending[0]!.delivery,
        { outcome: 'shown' },
        mutation(),
      );
      const done = (await env.svc.myDeliveries(a.who, ws, { channel: 'browser' })).data[0]!;
      expect(done).toMatchObject({ state: 'delivered' });
      await expect(
        env.svc.acknowledgeBrowser(
          a.who,
          ws,
          pending[0]!.delivery,
          { outcome: 'shown' },
          mutation(),
        ),
      ).rejects.toEqual(issueOf('not_pending'));
      expect(
        (await env.svc.browserPending(a.who, ws)).data.filter((d) => d.notification === note.id),
      ).toEqual([]);
      // Never shown within the window: expired, not delivered.
      const u = await newTask('Never shown');
      await assign(u, a.id);
      await drain();
      await sweep({}, new Date(Date.now() + 3_600_000));
      const states = (await env.svc.myDeliveries(a.who, ws, { channel: 'browser' })).data.map(
        (d) => d.state,
      );
      expect(states).toEqual(expect.arrayContaining(['expired', 'delivered']));
      // A page that declines is recorded as a permanent failure.
      const v = await newTask('Declined');
      await assign(v, a.id);
      await drain();
      const again = (await env.svc.browserPending(a.who, ws)).data;
      await env.svc.acknowledgeBrowser(
        a.who,
        ws,
        again[0]!.delivery,
        { outcome: 'declined' },
        mutation(),
      );
      expect((await env.svc.myDeliveries(a.who, ws, { state: 'failed' })).data[0]).toMatchObject({
        channel: 'browser',
        failure_code: 'client_declined',
      });
      // Access lost before the page asks: the lines vanish and the delivery is suppressed.
      const w = await newTask('Lost before shown');
      await assign(w, a.id);
      await drain();
      await apply(env, owner, ws, { kind: 'brand_revoke', brand: brands.Harbor, principal: a.id });
      expect((await env.svc.browserPending(a.who, ws)).data).toEqual([]);
    });

    it('announces due-soon and overdue work once per task and date, only to its assignees', async () => {
      const a = await fresh();
      const soon = await newTask('Due tomorrow');
      const late = await newTask('Fell overdue');
      for (const x of [soon, late]) await assign(x, a.id);
      await rows(
        `UPDATE work.task SET due_date = (now() AT TIME ZONE 'UTC')::date + 1 WHERE id = (SELECT id FROM core.record WHERE public_id = '${soon.id}')`,
      );
      await rows(
        `UPDATE work.task SET due_date = (now() AT TIME ZONE 'UTC')::date - 1 WHERE id = (SELECT id FROM core.record WHERE public_id = '${late.id}')`,
      );
      await sweep();
      await sweep();
      expect(
        (await forTask(a.who, soon.id)).filter((n) => n.notification_type === 'due_soon'),
      ).toHaveLength(1);
      expect(
        (await forTask(a.who, late.id)).filter((n) => n.notification_type === 'overdue'),
      ).toHaveLength(1);
      expect(
        (await forTask(outsider, soon.id)).filter((n) => n.notification_type === 'due_soon'),
      ).toHaveLength(0);
      expect(
        (await forTask(a.who, soon.id)).find((n) => n.notification_type === 'due_soon')!
          .occurrences,
      ).toBe(1);
    });

    it('ages out old notifications but keeps saved ones, and erases a departed person', async () => {
      const a = await fresh();
      const old = await newTask('Old news');
      const keep = await newTask('Keep me');
      await assign(old, a.id);
      await assign(keep, a.id);
      await drain();
      const oldNote = (await forTask(a.who, old.id))[0]!;
      const keepNote = (await forTask(a.who, keep.id))[0]!;
      await env.svc.setNotificationState(
        a.who,
        ws,
        keepNote.id,
        { state: 'saved' },
        ifMatch(keepNote.version),
      );
      await rows(`UPDATE notify.notification SET last_occurred_at = now() - interval '400 days'`);
      await sweep();
      expect(
        await rows(`SELECT 1 FROM notify.notification WHERE public_id = '${oldNote.id}'`),
      ).toHaveLength(0);
      expect(
        await rows(`SELECT 1 FROM notify.notification WHERE public_id = '${keepNote.id}'`),
      ).toHaveLength(1);
      expect((await mine(a.who)).map((n) => n.id)).toEqual([keepNote.id]);
    });

    it('lets managers set brand defaults that a person can still override, and no one else', async () => {
      const a = await fresh();
      await env.svc.setScopeDefault(
        owner,
        ws,
        brands.Harbor,
        { event_type: 'assignment', channel: 'email', mode: 'muted' },
        mutation(),
      );
      expect(
        (await env.svc.scopeDefaults(owner, ws, brands.Harbor)).data.some(
          (d) => d.event_type === 'assignment' && d.mode === 'muted',
        ),
      ).toBe(true);
      await expect(
        env.svc.setScopeDefault(
          a.who,
          ws,
          brands.Harbor,
          { event_type: 'assignment', channel: 'email', mode: 'immediate' },
          mutation(),
        ),
      ).rejects.toEqual(reason('forbidden'));
      await expect(
        env.svc.setScopeDefault(
          outsider,
          ws,
          brands.Harbor,
          { event_type: 'assignment', channel: 'email', mode: 'immediate' },
          mutation(),
        ),
      ).rejects.toEqual(reason('not_found'));
      const t = await newTask('Default muted');
      await assign(t, a.id);
      await drain();
      const note = (await forTask(a.who, t.id))[0]!;
      expect(
        await rows(
          `SELECT d.state FROM notify.delivery d JOIN notify.notification n ON n.id = d.notification_id WHERE n.public_id = '${note.id}' AND d.channel = 'email'`,
        ),
      ).toHaveLength(0);
      await env.svc.setNotificationPreference(
        a.who,
        ws,
        { event_type: 'assignment', scope: brands.Harbor, channel: 'email', mode: 'immediate' },
        mutation(),
      );
      const u = await newTask('Personal override');
      await assign(u, a.id);
      await drain();
      const unote = (await forTask(a.who, u.id))[0]!;
      expect(
        await rows(
          `SELECT d.state FROM notify.delivery d JOIN notify.notification n ON n.id = d.notification_id WHERE n.public_id = '${unote.id}' AND d.channel = 'email'`,
        ),
      ).toHaveLength(1);
      await env.svc.removeScopeDefault(
        owner,
        ws,
        brands.Harbor,
        { event_type: 'assignment', channel: 'email' },
        mutation(),
      );
    });
  });

  describe('isolation, idempotency, purge, and departure', () => {
    const own = async (c: Caller, task: string) => (await forTask(c, task))[0]!;
    const assignTo = async (title: string, who: string, brand = 'Harbor') => {
      const t = await newTask(title, brand);
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [who], version: t.version },
        mutation(),
      );
      await drain();
      return t;
    };

    it('gives strangers, other people, and unknown notifications one answer, with the same statements and time', async () => {
      const t = await assignTo('Private to the editor', pub.editor!);
      const note = await own(editor, t.id);
      const unknown = `ntf_${'0'.repeat(26)}`;
      const classes = {
        otherPerson: () => env.svc.getNotification(owner, ws, note.id),
        unknown: () => env.svc.getNotification(owner, ws, unknown),
        otherPersonState: () =>
          env.svc.setNotificationState(owner, ws, note.id, { state: 'read' }, mutation()),
        unknownState: () =>
          env.svc.setNotificationState(owner, ws, unknown, { state: 'read' }, mutation()),
      };
      await expect(classes.otherPerson()).rejects.toEqual(reason('not_found'));
      await expect(classes.unknown()).rejects.toEqual(reason('not_found'));
      const spans = () => env.h.telemetry.spans!;
      expect(await statementShape(spans(), classes.unknown)).toEqual(
        await statementShape(spans(), classes.otherPerson),
      );
      expect(await statementShape(spans(), classes.unknownState)).toEqual(
        await statementShape(spans(), classes.otherPersonState),
      );
      const timing = await measureClasses({
        otherPerson: classes.otherPerson,
        unknown: classes.unknown,
      });
      expect(timing.maxDelta, JSON.stringify(timing.medians)).toBeLessThanOrEqual(timing.threshold);
      // Nobody else's notifications, counts, deliveries, or search hits ever show up.
      expect((await mine(outsider)).map((n) => n.id)).not.toContain(note.id);
      expect(await mine(outsider, { q: 'Private to the editor' })).toEqual([]);
      expect(JSON.stringify(await env.svc.notificationCounts(outsider, ws))).not.toContain(note.id);
      await expect(
        env.svc.bulkNotificationState(
          outsider,
          ws,
          { ids: [note.id], state: 'dismissed' },
          mutation(),
        ),
      ).resolves.toMatchObject({ data: { updated: 0 } });
      expect((await own(editor, t.id)).state).toBe('unread');
    });

    it('applies an event once however often it is delivered, and an occasion fires once', async () => {
      const t = await newTask('Redelivered');
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [pub.editor!], version: t.version },
        mutation(),
      );
      await drain();
      // The consumer's inbox receipt makes redelivery of one event a no-op, so one assignment is one notice.
      const after = await forTask(editor, t.id);
      expect(after).toHaveLength(1);
      expect(after[0]!.occurrences).toBe(1);
      // Concurrent state changes against one version: one wins, the other conflicts.
      const note = after[0]!;
      const results = await Promise.allSettled([
        env.svc.setNotificationState(editor, ws, note.id, { state: 'read' }, ifMatch(note.version)),
        env.svc.setNotificationState(
          editor,
          ws,
          note.id,
          { state: 'saved' },
          ifMatch(note.version),
        ),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      // The same idempotency key applies once and replays the answer.
      const k = mutation();
      const current = await own(editor, t.id);
      const first = await env.svc.setNotificationState(
        editor,
        ws,
        note.id,
        { state: 'dismissed' },
        { ...k, ifMatch: `"${current.version}"` },
      );
      const again = await env.svc.setNotificationState(
        editor,
        ws,
        note.id,
        { state: 'dismissed' },
        { ...k, ifMatch: `"${current.version}"` },
      );
      expect(again.replayed).toBe(true);
      expect(again.data.state).toBe(first.data.state);
    });

    it('removes notifications, deliveries, and choices about a purged record, keeping no title anywhere', async () => {
      const t = await assignTo('Doomed notice', pub.editor!);
      const note = await own(editor, t.id);
      await env.svc.setNotificationPreference(
        editor,
        ws,
        { event_type: 'comment', scope: t.id, channel: 'all', mode: 'muted' },
        mutation(),
      );
      await env.svc.taskLifecycle(owner, ws, t.id, 'trash', {}, mutation());
      await env.svc.taskLifecycle(owner, ws, t.id, 'purge', {}, mutation());
      const { id } = (await sql(`SELECT id FROM core.record WHERE public_id = '${t.id}'`))[0]!;
      await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
        await productLifecycleRegistry()
          .get('task')!
          .purge!.deleteContent(tx, [id as string]);
      });
      expect(
        await sql(`SELECT 1 FROM notify.notification WHERE public_id = '${note.id}'`),
      ).toHaveLength(0);
      expect(
        await sql(
          `SELECT 1 FROM notify.delivery WHERE notification_id IS NOT NULL AND notification_id NOT IN (SELECT id FROM notify.notification)`,
        ),
      ).toHaveLength(0);
      expect(
        await sql(`SELECT 1 FROM notify.preference WHERE scope_record_id = '${id}'`),
      ).toHaveLength(0);
      // Events and audit never held the title.
      const events = await sql(
        `SELECT payload::text AS p FROM exec.outbox_event WHERE event_type LIKE 'notify.%'`,
      );
      expect(events.map((e) => e.p).join(' ')).not.toContain('Doomed notice');
    });

    it('erases a departed person’s notifications, deliveries, choices, and profile, and nobody else’s', async () => {
      const leaver = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
      const leaverId = await mem(leaver);
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: leaverId,
        level: 'edit',
      });
      await env.svc.setNotificationProfile(leaver, ws, { digest_cadence: 'weekly' }, ifMatch(0));
      await env.svc.setNotificationPreference(
        leaver,
        ws,
        { event_type: 'comment', scope: 'workspace', channel: 'email', mode: 'muted' },
        mutation(),
      );
      const t = await assignTo('For the leaver and the editor', leaverId);
      await env.svc.setAssignees(
        owner,
        ws,
        t.id,
        {
          assignees: [leaverId, pub.editor!],
          version: (await env.svc.getTask(owner, ws, t.id)).version,
        },
        mutation(),
      );
      await drain();
      const keep = await own(editor, t.id);
      const leaverRow = (
        await sql(`SELECT id FROM tenancy.membership WHERE public_id = '${leaverId}'`)
      )[0]!.id as string;
      expect(
        await sql(
          `SELECT 1 FROM notify.notification WHERE recipient_membership_id = '${leaverRow}'`,
        ),
      ).not.toHaveLength(0);
      const preview = await env.svc.previewChange(owner, ws, { kind: 'remove', member: leaverId });
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
      // Departure retention ends (or the account is deleted): the personal-data eraser runs.
      await env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
        eraseMembershipNavigation(tx, leaverRow),
      );
      for (const table of [
        'notify.notification',
        'notify.delivery',
        'notify.digest',
        'notify.preference',
        'notify.profile',
      ])
        expect(
          await sql(
            `SELECT 1 FROM ${table} WHERE ${table === 'notify.profile' || table === 'notify.preference' ? 'membership_id' : 'recipient_membership_id'} = '${leaverRow}'`,
          ),
          table,
        ).toHaveLength(0);
      expect((await own(editor, t.id)).id).toBe(keep.id);
    });
  });
});
