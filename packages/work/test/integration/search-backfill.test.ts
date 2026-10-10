import { createHash } from 'node:crypto';
import { richTextFromPlain } from '@pm/contracts';
import { Migrator, sql as ksql } from '@pm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { indexWorkspace, type SearchJobDeps } from '@pm/work';
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
import type { LocalObjectStorage } from '@pm/work';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const para = (id: string, text: string) => ({ id, type: 'paragraph', runs: [{ text }] });

interface World {
  ws: string;
  wsId: string;
  owner: Caller;
  editor: Caller;
  brands: Record<string, string>;
  ids: Record<string, string>;
}

/**
 * Migration 0041 on a database that already holds records (corrective brief, Phase 5C review 01):
 * every supported record that existed before the migration is queued exactly once and found by
 * search without being edited first. The migration is rolled down and applied again over records
 * created while it was in force, which is the same starting point as records that predate it.
 */
describe('Search backfill of records that predate migration 0041', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let storage: LocalObjectStorage;
  const worlds: World[] = [];
  const sql = async (text: string, params: unknown[] = []) =>
    (await db.admin(text, params)).rows as Array<Record<string, any>>;
  const deps = (): SearchJobDeps => ({
    tenant: env.h.worker,
    discovery: undefined as never,
    metrics: env.h.telemetry.metrics,
    logger: env.h.logger,
  });
  const drain = (w: World) => indexWorkspace(deps(), w.wsId);
  const ids = (r: { results: Array<{ id: string }> }) => r.results.map((x) => x.id);

  async function seed(prefix: string, other: boolean): Promise<World> {
    const made = await workspaceWith(env, db, [`${prefix}Harbor`, `${prefix}Summit`]);
    const { owner, ws, brands } = made;
    const wsId = await workspaceIdOf(db, ws);
    const editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands[`${prefix}Harbor`],
      principal: (await membershipOf(db, wsId, editor.auth.account.id))!.public_id,
      level: 'edit',
    });
    const word = `${prefix}zephyr`;
    const harbor = brands[`${prefix}Harbor`]!;
    const o: Record<string, string> = {};
    const open = (
      await env.svc.createProject(owner, ws, { brand: harbor, name: `${word} project` }, mutation())
    ).data;
    o.project = open.id;
    const vault = (
      await env.svc.createProject(owner, ws, { brand: harbor, name: `${word} vault` }, mutation())
    ).data;
    await env.svc.setAccess(
      owner,
      ws,
      vault.id,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    o.vault = vault.id;
    o.vaultTask = (
      await env.svc.createTask(
        owner,
        ws,
        { project: vault.id, title: `${word} vault task` },
        mutation(),
      )
    ).data.id;
    const task = (
      await env.svc.createTask(
        owner,
        ws,
        {
          project: open.id,
          title: `${word} task`,
          description: richTextFromPlain(`${word} body text`),
        },
        mutation(),
      )
    ).data;
    o.task = task.id;
    o.summitTask = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands[`${prefix}Summit`], title: `${word} summit task` },
        mutation(),
      )
    ).data.id;
    o.milestone = (
      await env.svc.createMilestone(
        owner,
        ws,
        open.id,
        { name: `${word} milestone`, due_date: '2026-12-01' },
        mutation(),
      )
    ).data.id;
    o.decision = (
      await env.svc.createDecision(
        owner,
        ws,
        open.id,
        { kind: 'decision', statement: `${word} decision` },
        mutation(),
      )
    ).data.id;
    const doc = (
      await env.svc.createDocument(
        owner,
        ws,
        { title: `${word} handbook`, brand: harbor },
        mutation(),
      )
    ).data;
    await env.svc.saveContent(
      owner,
      ws,
      doc.id,
      {
        base_version: doc.content_version,
        content: { v: 2, blocks: [para('par_1', `${word} saved text`)] },
      },
      mutation(),
    );
    o.document = doc.id;
    o.comment = (
      await env.svc.createComment(owner, ws, task.id, { text: `${word} comment` }, mutation())
    ).data.id;
    const deleted = (
      await env.svc.createComment(
        owner,
        ws,
        task.id,
        { text: `${word} deleted comment` },
        mutation(),
      )
    ).data;
    await env.svc.deleteComment(owner, ws, deleted.id, mutation()).catch(() => undefined);
    o.deliverable = (
      await env.svc.createDeliverable(
        owner,
        ws,
        task.id,
        { title: `${word} deliverable` },
        mutation(),
      )
    ).data.id;
    const bytes = Buffer.from(`${word} bytes`);
    const s = (
      await env.svc.initiateUpload(
        owner,
        ws,
        {
          host: task.id,
          name: `${word}-notes.txt`,
          content_type: 'text/plain',
          byte_size: bytes.length,
          sha256: sha(bytes),
        },
        mutation(),
      )
    ).data;
    const key = (
      await sql(
        `SELECT quarantine_object_key AS k FROM files.upload_session WHERE public_id = $1`,
        [s.id],
      )
    )[0]!.k as string;
    await storage.writeObject(key, bytes, { contentType: 'text/plain' });
    o.file = (await env.svc.completeUpload(owner, ws, s.id, mutation())).data.file as string;
    // A trashed record stays out of results, and a purged one has no source row at all.
    o.trashed = (
      await env.svc.createTask(
        owner,
        ws,
        { project: open.id, title: `${word} trashed task` },
        mutation(),
      )
    ).data.id;
    await env.svc.taskLifecycle(owner, ws, o.trashed, 'trash', {}, mutation());
    o.purged = (
      await env.svc.createTask(
        owner,
        ws,
        { project: open.id, title: `${word} purged task` },
        mutation(),
      )
    ).data.id;
    await env.svc.taskLifecycle(owner, ws, o.purged, 'trash', {}, mutation());
    await env.svc.taskLifecycle(owner, ws, o.purged, 'purge', {}, mutation());
    const purgedId = (await sql(`SELECT id FROM core.record WHERE public_id = $1`, [o.purged]))[0]!
      .id as string;
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      await ksql`DELETE FROM work.task WHERE id = ${purgedId}`.execute(tx.db);
    });
    void other;
    return { ws, wsId, owner, editor, brands, ids: o };
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    storage = env.files.storage as LocalObjectStorage;
    worlds.push(await seed('a', false), await seed('b', true));
    // The records predate the search tables: drop them with migration 0041 (and what depends on it),
    // so the next application of the migration meets a database that already holds records.
    await new Migrator({ connectionString: db.migrator, environment: 'test' }).down(40);
    expect((await sql(`SELECT to_regclass('search.index_status') AS t`))[0]!.t).toBeNull();
  }, 360_000);
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('queues every supported record that existed before the migration, exactly once, and no purged or deleted one', async () => {
    const m = new Migrator({ connectionString: db.migrator, environment: 'test' });
    await m.up();
    expect((await m.status()).report.problems).toEqual([]);
    const queued = await sql(
      `SELECT workspace_id, source_kind, source_id, state FROM search.index_status`,
    );
    for (const w of worlds) {
      const mine = queued.filter((q) => q.workspace_id === w.wsId);
      const byKind = (k: string) => mine.filter((q) => q.source_kind === k).length;
      // Project: open + vault; task: task, vault task, summit task, trashed (the purged row is gone).
      expect(byKind('project')).toBe(2);
      expect(byKind('task')).toBe(4);
      expect(byKind('milestone')).toBe(1);
      expect(byKind('decision_record')).toBe(1);
      expect(byKind('document')).toBe(1);
      expect(byKind('comment')).toBe(1); // the deleted comment is not queued
      expect(byKind('deliverable')).toBe(1);
      expect(byKind('file')).toBe(1);
      expect(new Set(mine.map((q) => `${q.source_kind}:${q.source_id}`)).size).toBe(mine.length);
      expect(mine.every((q) => q.state === 'pending')).toBe(true);
    }
    // The tenant isolation the application relies on is exactly as before.
    const force = await sql(`
      SELECT c.relname, c.relforcerowsecurity AS f FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE (n.nspname, c.relname) IN (('work','task'),('work','project'),('work','milestone'),('work','decision_record'),
         ('knowledge','document'),('collab','comment'),('files','file'),('files','deliverable'),
         ('search','search_document'),('search','index_status'),('search','recent_search'))`);
    expect(force.length).toBe(11);
    expect(force.every((r) => r.f === true)).toBe(true);
  });

  it('says catching up until the backlog is indexed, then finds every record without any edit', async () => {
    for (const w of worlds) {
      const word = `${w.ids.project ? (w === worlds[0] ? 'a' : 'b') : ''}zephyr`;
      const before = await env.svc.search(w.owner, w.ws, { q: word });
      expect(before.index.state).toBe('catching_up');
      expect(before.index.pending).toBeGreaterThanOrEqual(11);
      expect(before.results).toEqual([]);
      const run = await drain(w);
      expect(run.failed).toBe(0);
      const owner = await env.svc.search(w.owner, w.ws, { q: word, limit: 50 });
      expect(owner.index).toMatchObject({ state: 'complete', pending: 0, failed: 0 });
      const found = new Set(ids(owner));
      for (const k of [
        'project',
        'vault',
        'task',
        'vaultTask',
        'summitTask',
        'milestone',
        'decision',
        'document',
        'comment',
        'deliverable',
        'file',
      ])
        expect(found.has(w.ids[k]!), `${k} is found`).toBe(true);
      // Trashed and purged records are not results, and the deleted comment is not either.
      expect(found.has(w.ids.trashed!)).toBe(false);
      expect(found.has(w.ids.purged!)).toBe(false);
      expect(owner.total).toBe(11);
      // The editor sees what their access allows: not the restricted project, nor the other brand's task.
      const editor = new Set(ids(await env.svc.search(w.editor, w.ws, { q: word, limit: 50 })));
      expect(editor.has(w.ids.vault!)).toBe(false);
      expect(editor.has(w.ids.vaultTask!)).toBe(false);
      expect(editor.has(w.ids.summitTask!)).toBe(false);
      expect(editor.has(w.ids.task!)).toBe(true);
      expect(editor.has(w.ids.document!)).toBe(true);
    }
    // One workspace's words never appear in the other's results.
    const crossed = await env.svc.search(worlds[0]!.owner, worlds[0]!.ws, { q: 'bzephyr' });
    expect(crossed.results).toEqual([]);
  });

  it('is idempotent: applying the migration again over an indexed database changes nothing, and a failure is shown and recovers', async () => {
    const m = new Migrator({ connectionString: db.migrator, environment: 'test' });
    const count = async () =>
      (await sql(`SELECT count(*)::int AS n FROM search.search_document`))[0]!.n as number;
    const before = await count();
    expect(before).toBe(24);
    // Down and up again re-queues every record once; indexing them again converges on the same rows.
    await m.down(40);
    await m.up();
    expect((await sql(`SELECT count(*)::int AS n FROM search.index_status`))[0]!.n).toBe(24);
    for (const w of worlds) await drain(w);
    expect(await count()).toBe(before);
    // A poison key is retried with backoff and shown as failed (never complete), then recovers.
    const w = worlds[0]!;
    await sql(
      `UPDATE search.index_status SET state = 'failed', attempts = 5, failure_code = 'source_error', next_attempt_at = now() + interval '1 hour' WHERE false`,
    );
    await sql(
      `INSERT INTO search.index_status (workspace_id, source_kind, source_id, auth_record_id, state, attempts, failure_code, next_attempt_at)
       SELECT workspace_id, 'task', id, id, 'failed', 5, 'source_error', now() - interval '1 minute' FROM work.task WHERE workspace_id = $1 LIMIT 1
       ON CONFLICT DO NOTHING`,
      [w.wsId],
    );
    const degraded = await env.svc.search(w.owner, w.ws, { q: 'azephyr' });
    expect(degraded.index.state).toBe('degraded');
    await drain(w);
    expect((await env.svc.search(w.owner, w.ws, { q: 'azephyr' })).index).toMatchObject({
      state: 'complete',
      failed: 0,
    });
  });
});
