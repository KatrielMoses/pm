import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { measureClasses, statementShape } from '@pm/test-support';
import type { Caller } from '@pm/tenancy';
import { DEFAULT_WORK_SETTINGS, NotificationFanOut } from '@pm/work';
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
const run = (id: string, kind: string) => ({ ref: { kind, id } });

/**
 * 4C with 4B: mentions in documents and comments on documents reach people through the one
 * notification pipeline, only for people who can read the document, and a document notification is
 * re-authorized when it is shown. Also the 4C isolation, concurrency, idempotency, and audit
 * guarantees that need no worker.
 */
describe('Documents with notifications, isolation, and concurrency (4C)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller;
  let watcher: Caller;
  let outsider: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let drain: () => Promise<void>;
  const pub: Record<string, string> = {};
  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const sql = async (text: string) => (await db.admin(text)).rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    watcher = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    outsider = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    for (const who of [editor, watcher])
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: await mem(who),
        level: 'edit',
      });
    pub.owner = await mem(owner);
    pub.editor = await mem(editor);
    pub.watcher = await mem(watcher);
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

  const make = async (as: Caller, body: Record<string, unknown>) =>
    (await env.svc.createDocument(as, ws, body, mutation())).data;
  const mine = async (as: Caller) =>
    (await env.svc.listNotifications(as, ws, { limit: '100' })).data;

  it('notifies a person named in a document only if they can read it, once, and never the author', async () => {
    const d = await make(editor, { title: 'Launch plan', brand: brands.Harbor, starter: false });
    await env.svc.saveContent(
      editor,
      ws,
      d.id,
      {
        base_version: 1,
        content: {
          v: 2,
          blocks: [
            {
              id: 'blk_a',
              type: 'paragraph',
              runs: [
                { text: 'Owners: ' },
                run(pub.watcher!, 'member'),
                run(pub.editor!, 'member'),
                run(pub.owner!, 'member'),
              ],
            },
          ],
        },
      },
      mutation(),
    );
    // The outsider cannot be named by someone who cannot read them as a target of a document they cannot read.
    await drain();
    const forWatcher = (await mine(watcher)).filter((n) => n.record?.id === d.id);
    expect(forWatcher).toHaveLength(1);
    expect(forWatcher[0]).toMatchObject({
      notification_type: 'mention',
      record: { id: d.id, type: 'document', title: 'Launch plan' },
      actor: { id: pub.editor },
    });
    expect((await mine(editor)).filter((n) => n.record?.id === d.id)).toEqual([]);
    // The owner (an administrator of everything) is named too and can read it.
    expect((await mine(owner)).filter((n) => n.record?.id === d.id)).toHaveLength(1);
    // Saving the same mention again does not notify again; a new person does.
    const again = await env.svc.getDocument(editor, ws, d.id);
    await env.svc.saveContent(
      editor,
      ws,
      d.id,
      {
        base_version: again.content_version,
        content: {
          v: 2,
          blocks: [
            {
              id: 'blk_a',
              type: 'paragraph',
              runs: [
                { text: 'Owners, edited: ' },
                run(pub.watcher!, 'member'),
                run(pub.outsider!, 'member'),
              ],
            },
          ],
        },
      },
      mutation(),
    );
    await drain();
    expect((await mine(watcher)).filter((n) => n.record?.id === d.id)).toHaveLength(1);
    // The outsider is named but cannot read the document: nothing is created for them.
    expect((await mine(outsider)).filter((n) => n.record?.id === d.id)).toEqual([]);
    expect(
      await sql(
        `SELECT 1 FROM notify.notification n JOIN tenancy.membership m ON m.id = n.recipient_membership_id WHERE m.public_id = '${pub.outsider}' AND n.type = 'mention'`,
      ),
    ).toHaveLength(0);
    // Access lost: the row says so and shows nothing about the document.
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Harbor,
      principal: pub.watcher!,
    });
    const gone = (await mine(watcher)).find((n) => n.notification_type === 'mention')!;
    expect(gone).toMatchObject({
      available: false,
      record: null,
      summary: 'You no longer have access to this item',
    });
    expect(JSON.stringify(gone)).not.toContain('Launch plan');
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: pub.watcher!,
      level: 'edit',
    });
  });

  it('notifies followers of a document about a new comment', async () => {
    const d = await make(editor, { title: 'Followed page', brand: brands.Harbor, starter: false });
    await env.svc.follow(watcher, ws, d.id, true, mutation());
    await env.svc.createComment(
      editor,
      ws,
      d.id,
      { text: 'Please review the second section' },
      mutation(),
    );
    await drain();
    const got = (await mine(watcher)).filter((n) => n.record?.id === d.id);
    expect(got.map((n) => n.notification_type)).toEqual(['comment']);
    expect(got[0]!.record).toMatchObject({ type: 'document', title: 'Followed page' });
    expect(got[0]!.summary).not.toContain('Please review');
  });

  it('gives hidden and unknown documents, versions, suggestions, and backlinks the same statements and time', async () => {
    const hidden = await make(owner, {
      title: 'Summit only',
      brand: brands.Summit,
      starter: false,
    });
    await env.svc.saveContent(
      owner,
      ws,
      hidden.id,
      {
        base_version: 1,
        content: { v: 2, blocks: [{ id: 'blk_a', type: 'paragraph', runs: [{ text: 'secret' }] }] },
      },
      mutation(),
    );
    const sugg = (
      await env.svc.createSuggestion(
        owner,
        ws,
        hidden.id,
        { block: 'blk_a', base_version: 2, proposed: { type: 'paragraph', runs: [{ text: 'x' }] } },
        mutation(),
      )
    ).data;
    const unknown = `doc_${'0'.repeat(26)}`;
    const spans = () => env.h.telemetry.spans!;
    const classes = {
      hiddenDoc: () => env.svc.getDocument(outsider, ws, hidden.id),
      unknownDoc: () => env.svc.getDocument(outsider, ws, unknown),
      hiddenVersion: () => env.svc.getVersion(outsider, ws, hidden.id, 1),
      unknownVersion: () => env.svc.getVersion(outsider, ws, unknown, 1),
      hiddenSuggestions: () => env.svc.listSuggestions(outsider, ws, hidden.id, {}),
      unknownSuggestions: () => env.svc.listSuggestions(outsider, ws, unknown, {}),
      hiddenSuggestion: () => env.svc.getSuggestion(outsider, ws, sugg.id),
      unknownSuggestion: () => env.svc.getSuggestion(outsider, ws, `dsg_${'0'.repeat(26)}`),
      hiddenSave: () =>
        env.svc.saveContent(
          outsider,
          ws,
          hidden.id,
          { base_version: 2, content: { v: 2, blocks: [] } },
          mutation(),
        ),
      unknownSave: () =>
        env.svc.saveContent(
          outsider,
          ws,
          unknown,
          { base_version: 2, content: { v: 2, blocks: [] } },
          mutation(),
        ),
    };
    for (const [h, u] of [
      ['hiddenDoc', 'unknownDoc'],
      ['hiddenVersion', 'unknownVersion'],
      ['hiddenSuggestions', 'unknownSuggestions'],
      ['hiddenSuggestion', 'unknownSuggestion'],
      ['hiddenSave', 'unknownSave'],
    ] as const) {
      await expect(classes[h]()).rejects.toEqual(reason('not_found'));
      await expect(classes[u]()).rejects.toEqual(reason('not_found'));
      expect(await statementShape(spans(), classes[u])).toEqual(
        await statementShape(spans(), classes[h]),
      );
    }
    const timing = await measureClasses({
      hiddenDoc: classes.hiddenDoc,
      unknownDoc: classes.unknownDoc,
      hiddenVersion: classes.hiddenVersion,
      unknownVersion: classes.unknownVersion,
    });
    expect(timing.maxDelta, JSON.stringify(timing.medians)).toBeLessThanOrEqual(timing.threshold);
    // A hidden document's title is in no list, search, count, or error the outsider can reach.
    expect(
      JSON.stringify((await env.svc.listDocuments(outsider, ws, { q: 'Summit' })).data),
    ).not.toContain('Summit only');
  });

  it('serializes concurrent saves on one base version: one wins, the other conflicts, nothing is lost', async () => {
    const d = await make(editor, { title: 'Race', brand: brands.Harbor, starter: false });
    const attempt = (as: Caller, text: string) =>
      env.svc.saveContent(
        as,
        ws,
        d.id,
        {
          base_version: 1,
          content: { v: 2, blocks: [{ id: 'blk_a', type: 'paragraph', runs: [{ text }] }] },
        },
        mutation(),
      );
    const results = await Promise.allSettled([
      attempt(editor, 'from the editor'),
      attempt(owner, 'from the owner'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'conflict', conflict: { current_version: 2 } });
    const versions = await env.svc.listVersions(owner, ws, d.id, {});
    expect(versions.data.map((v) => v.number)).toEqual([2, 1]);
  });

  it('applies an idempotent create and save once, and conflicts on a reused key with another body', async () => {
    const key = mutation();
    const first = await env.svc.createDocument(
      editor,
      ws,
      { title: 'Once', brand: brands.Harbor, starter: false },
      key,
    );
    const again = await env.svc.createDocument(
      editor,
      ws,
      { title: 'Once', brand: brands.Harbor, starter: false },
      key,
    );
    expect(again.replayed).toBe(true);
    expect(again.data.id).toBe(first.data.id);
    await expect(
      env.svc.createDocument(
        editor,
        ws,
        { title: 'Different', brand: brands.Harbor },
        { ...key, fingerprint: createHash('sha256').update('other').digest() },
      ),
    ).rejects.toEqual(reason('idempotency_key_reuse'));
    const saveKey = mutation();
    const body = {
      base_version: 1,
      content: { v: 2, blocks: [{ id: 'blk_a', type: 'paragraph', runs: [{ text: 'once' }] }] },
    };
    await env.svc.saveContent(editor, ws, first.data.id, body, saveKey);
    const replay = await env.svc.saveContent(editor, ws, first.data.id, body, saveKey);
    expect(replay.replayed).toBe(true);
    expect((await env.svc.listVersions(editor, ws, first.data.id, {})).data).toHaveLength(2);
  });

  it('keeps titles, text, and addresses out of audit and events', async () => {
    const d = await make(editor, {
      title: 'Needle title for audit',
      brand: brands.Harbor,
      starter: false,
    });
    await env.svc.saveContent(
      editor,
      ws,
      d.id,
      {
        base_version: 1,
        content: {
          v: 2,
          blocks: [
            {
              id: 'blk_a',
              type: 'paragraph',
              runs: [{ text: 'Needle body text for audit', link: 'https://needle.example/path' }],
            },
          ],
        },
      },
      mutation(),
    );
    const audit = await sql(
      `SELECT changes::text AS c FROM audit.audit_event WHERE action LIKE 'document.%'`,
    );
    expect(audit.map((a) => a.c).join(' ')).not.toMatch(/Needle|needle\.example/);
    const events = await sql(
      `SELECT payload::text AS p FROM exec.outbox_event WHERE event_type LIKE 'knowledge.%'`,
    );
    expect(events.map((e) => e.p).join(' ')).not.toMatch(/Needle|needle\.example/);
    expect(events.length).toBeGreaterThan(0);
  });
});
