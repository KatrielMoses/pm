import { richTextFromPlain } from '@pm/contracts';
import { sql as ksql } from '@pm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  defaultSearchSources,
  indexWorkspace,
  SearchSourceRegistry,
  type SearchJobDeps,
} from '@pm/work';
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
const para = (id: string, text: string) => ({ id, type: 'paragraph', runs: [{ text }] });
const content = (...blocks: unknown[]) => ({ v: 2, blocks });

/**
 * 5A permission-aware search (ADR-0028): one authority applies the compiled visibility predicate
 * to every candidate before it is matched, ranked, counted, faceted, or excerpted; hidden and
 * unknown are the same absence; the index may lag but never claims to be complete when it is not.
 */
describe('Permission-aware search (5A)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller;
  let reader: Caller;
  let outsider: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const sql = async (text: string) => (await db.admin(text)).rows as Array<Record<string, any>>;
  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const deps = (): SearchJobDeps => ({
    tenant: env.h.worker,
    discovery: undefined as never,
    metrics: env.h.telemetry.metrics,
    logger: env.h.logger,
  });
  const drain = async () => indexWorkspace(deps(), wsId);
  const find = async (as: Caller, q: string, extra: Record<string, unknown> = {}) =>
    env.svc.search(as, ws, { q, ...extra });
  const ids = (r: { results: Array<{ id: string }> }) => r.results.map((x) => x.id);
  const task = async (as: Caller, body: Record<string, unknown>) =>
    (await env.svc.createTask(as, ws, { brand: brands.Harbor, ...body }, mutation())).data;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
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
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('finds tasks, projects, documents, and comments with excerpts, marks, and facets, after indexing', async () => {
    const t = await task(editor, {
      title: 'Quarterly invoice reconciliation',
      description: richTextFromPlain('Match every invoice against the ledger before month end.'),
    });
    const p = (
      await env.svc.createProject(
        owner,
        ws,
        { brand: brands.Harbor, name: 'Invoice automation' },
        mutation(),
      )
    ).data;
    const d = (
      await env.svc.createDocument(
        editor,
        ws,
        { title: 'Finance handbook', brand: brands.Harbor },
        mutation(),
      )
    ).data;
    await env.svc.saveContent(
      editor,
      ws,
      d.id,
      {
        base_version: d.content_version,
        content: content(para('par_1', 'How we pay a supplier invoice within thirty days.')),
      },
      mutation(),
    );
    const c = (
      await env.svc.createComment(
        editor,
        ws,
        t.id,
        { text: 'Is the invoice total final?' },
        mutation(),
      )
    ).data;

    // Nothing is claimed before the worker runs: the response says the index is catching up.
    const before = await find(editor, 'invoice');
    expect(before.index.state).toBe('catching_up');
    expect(before.index.pending).toBeGreaterThanOrEqual(4);
    expect(before.results).toEqual([]);

    const run = await drain();
    expect(run.failed).toBe(0);
    const r = await find(editor, 'invoice');
    expect(r.index).toMatchObject({ state: 'complete', pending: 0, failed: 0 });
    expect(new Set(ids(r))).toEqual(new Set([t.id, p.id, d.id, c.id]));
    expect(r.total).toBe(4);
    expect(r.total_is_lower_bound).toBe(false);
    // The title is marked, and the excerpt of a body match is marked around the word.
    const hit = r.results.find((x) => x.id === t.id)!;
    expect(hit.title_parts.filter((x: any) => x.hit).map((x: any) => x.text)).toEqual(['invoice']);
    expect(hit.snippet!.parts.some((x: any) => x.hit && x.text.toLowerCase() === 'invoice')).toBe(
      true,
    );
    const comment = r.results.find((x) => x.id === c.id)!;
    expect(comment).toMatchObject({ type: 'comment', host: { type: 'task', id: t.id } });
    expect(r.facets.kinds.map((k: any) => [k.kind, k.count])).toEqual([
      ['project', 1],
      ['task', 1],
      ['document', 1],
      ['comment', 1],
    ]);
    expect(r.facets.brands).toEqual([
      expect.objectContaining({ count: 4, brand: expect.objectContaining({ name: 'Harbor' }) }),
    ]);
    // Weighted ranking: a title match outranks a body match.
    expect(r.results[0]!.title.toLowerCase()).toContain('invoice');
  });

  it('treats a hidden record exactly like one that does not exist: no result, count, facet, excerpt, or ranking', async () => {
    const secret = await task(editor, {
      title: 'Zebrafish acquisition plan',
      description: richTextFromPlain('Confidential zebrafish valuation figures.'),
    });
    await drain();
    expect(ids(await find(editor, 'zebrafish'))).toEqual([secret.id]);
    const hidden = await find(outsider, 'zebrafish');
    const unknown = await find(outsider, 'qwxzvbnm');
    // The same shape and the same figures: nothing tells the cases apart.
    const shape = (r: any) => ({
      results: r.results,
      total: r.total,
      lower: r.total_is_lower_bound,
      kinds: r.facets.kinds,
      brands: r.facets.brands,
      more: r.page.has_more,
    });
    expect(shape(hidden)).toEqual(shape(unknown));
    expect(hidden.total).toBe(0);
    // Opening is one not_found for both.
    await expect(env.svc.openResult(outsider, ws, { type: 'task', id: secret.id })).rejects.toEqual(
      reason('not_found'),
    );
    await expect(
      env.svc.openResult(outsider, ws, { type: 'task', id: 'tsk_00000000000000000000000000' }),
    ).rejects.toEqual(reason('not_found'));
    // The index state only counts what the person could see: a hidden edit leaves no trace.
    await env.svc.updateTask(
      editor,
      ws,
      secret.id,
      {
        version: secret.version,
        changes: { title: { base: secret.title, value: 'Zebrafish acquisition plan v2' } },
      },
      mutation({ ifMatch: `"${secret.version}"` }),
    );
    expect((await find(outsider, 'qwxzvbnm')).index).toMatchObject({
      state: 'complete',
      pending: 0,
    });
    expect((await find(editor, 'qwxzvbnm')).index).toMatchObject({ state: 'catching_up' });
    await drain();
  });

  it('checks access at request time: a share grants and a revoked share removes, with no reindex', async () => {
    const t = await task(editor, { title: 'Kestrel migration notes' });
    await drain();
    expect((await find(outsider, 'kestrel')).total).toBe(0);
    const share = await apply(env, owner, ws, {
      kind: 'record_share',
      record: t.id,
      grantee: await mem(outsider),
      level: 'view',
    });
    expect(ids(await find(outsider, 'kestrel'))).toEqual([t.id]);
    await env.svc.revokeShare(
      owner,
      ws,
      (share.result as any).data?.id ??
        (await sql(`SELECT public_id FROM access.share_group ORDER BY created_at DESC LIMIT 1`))[0]!
          .public_id,
      mutation(),
    );
    const after = await find(outsider, 'kestrel');
    expect(after.total).toBe(0);
    expect(after.results).toEqual([]);
    expect((await sql(`SELECT count(*)::int AS n FROM search.index_task`))[0]!.n).toBe(0);
  });

  it('hides trashed and archived records at once, and brings them back on restore without reindexing', async () => {
    const t = await task(editor, { title: 'Pelican budget review' });
    await drain();
    expect(ids(await find(editor, 'pelican'))).toEqual([t.id]);
    await env.svc.taskLifecycle(owner, ws, t.id, 'archive', {}, mutation());
    expect((await find(editor, 'pelican')).total).toBe(0);
    expect(ids(await find(editor, 'pelican', { state: 'archived' }))).toEqual([t.id]);
    expect(ids(await find(editor, 'pelican', { state: 'any' }))).toEqual([t.id]);
    await env.svc.taskLifecycle(owner, ws, t.id, 'unarchive', {}, mutation());
    expect(ids(await find(editor, 'pelican'))).toEqual([t.id]);
    await env.svc.taskLifecycle(owner, ws, t.id, 'trash', {}, mutation());
    for (const state of ['active', 'archived', 'any'])
      expect((await find(owner, 'pelican', { state })).total).toBe(0);
    await env.svc.taskLifecycle(owner, ws, t.id, 'restore', {}, mutation());
    expect(ids(await find(editor, 'pelican'))).toEqual([t.id]);
  });

  it('removes a deleted comment and a trashed file at once, before the index catches up', async () => {
    const t = await task(editor, { title: 'Marmot thread' });
    const c = (
      await env.svc.createComment(
        editor,
        ws,
        t.id,
        { text: 'Marmot secret passphrase' },
        mutation(),
      )
    ).data;
    const f = (
      await env.svc.addFileLink(
        editor,
        ws,
        { host: t.id, url: 'https://example.com/marmot-report.pdf', name: 'marmot.report.pdf' },
        mutation(),
      )
    ).data;
    await drain();
    expect(new Set(ids(await find(editor, 'marmot')))).toEqual(new Set([t.id, c.id, f.id]));
    // A file name with punctuation is found by its parts.
    expect(ids(await find(editor, 'report'))).toContain(f.id);
    await env.svc.deleteComment(editor, ws, c.id, mutation());
    await env.svc.trashFile(editor, ws, f.id, mutation());
    const r = await find(editor, 'marmot');
    expect(ids(r)).toEqual([t.id]);
    expect(r.total).toBe(1);
    expect(r.facets.kinds.map((k: any) => k.kind)).toEqual(['task']);
    await drain();
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM search.entry WHERE source_kind = 'comment' AND body LIKE '%Marmot%'`,
        )
      )[0]!.n,
    ).toBe(0);
  });

  it('reports a lagging index per result and for the workspace, never as complete', async () => {
    const t = await task(editor, { title: 'Ibis rollout' });
    await drain();
    await env.svc.updateTask(
      editor,
      ws,
      t.id,
      { version: t.version, changes: { title: { base: t.title, value: 'Heron rollout' } } },
      mutation({ ifMatch: `"${t.version}"` }),
    );
    const lagging = await find(editor, 'ibis');
    expect(lagging.index.state).toBe('catching_up');
    expect(lagging.results[0]).toMatchObject({ id: t.id, index: 'updating' });
    expect(lagging.index.oldest_pending_seconds).toBeGreaterThanOrEqual(0);
    await drain();
    expect((await find(editor, 'ibis')).results).toEqual([]);
    const now = await find(editor, 'heron');
    expect(now.results[0]).toMatchObject({ id: t.id, index: 'current' });
    expect(now.index.state).toBe('complete');
    expect((await env.svc.searchStatus(editor, ws)).index.state).toBe('complete');
  });

  it('retries a failing source with backoff, shows it as failed, isolates it, and recovers', async () => {
    const poison = new Set<string>();
    const registry = new SearchSourceRegistry();
    for (const s of defaultSearchSources().all())
      registry.register(
        s.kind === 'task'
          ? {
              ...s,
              async load(tx, id, limits) {
                if (poison.has(id)) throw new Error('simulated source failure');
                return s.load(tx, id, limits);
              },
            }
          : s,
      );
    const sick = await task(editor, { title: 'Wombat inventory' });
    const fine = await task(editor, { title: 'Wombat staffing' });
    const idOf = async (pub: string) =>
      (await sql(`SELECT id FROM core.record WHERE public_id = '${pub}'`))[0]!.id as string;
    poison.add(await idOf(sick.id));
    const d = { ...deps(), sources: registry };
    const t0 = new Date();
    const first = await indexWorkspace(d, wsId, t0);
    // The healthy row is indexed; the poison one keeps its key, its attempt count, and a short code.
    expect(first).toMatchObject({ retried: 1, failed: 0 });
    expect(ids(await find(editor, 'wombat'))).toEqual([fine.id]);
    let row = (
      await sql(
        `SELECT state, attempts, failure_code, next_attempt_at > now() AS later FROM search.index_task`,
      )
    )[0]!;
    expect(row).toMatchObject({
      state: 'pending',
      attempts: 1,
      failure_code: 'source_error',
      later: true,
    });
    // Not due yet: a run does nothing to it.
    expect(await indexWorkspace(d, wsId, t0)).toMatchObject({ retried: 0, failed: 0 });
    let status = (await find(editor, 'wombat')).index;
    expect(status).toMatchObject({ state: 'catching_up', pending: 1, failed: 0 });
    // Allowed attempts used up: the task is failed, and the response says so truthfully.
    let at = t0.getTime();
    for (let i = 0; i < 4; i++) {
      at += 3 * 3_600_000;
      await indexWorkspace(d, wsId, new Date(at));
    }
    row = (await sql(`SELECT state, attempts FROM search.index_task`))[0]!;
    expect(row).toMatchObject({ state: 'failed', attempts: 5 });
    status = (await find(editor, 'wombat')).index;
    expect(status).toMatchObject({ state: 'degraded', failed: 1 });
    expect((await env.svc.searchStatus(editor, ws)).index).toMatchObject({
      state: 'degraded',
      failed: 1,
    });
    // The failure is not visible to someone who cannot see the record.
    expect((await find(outsider, 'wombat')).index).toMatchObject({ state: 'complete', failed: 0 });
    // Fixed at the source: the slow retry succeeds and the state returns to complete.
    poison.clear();
    at += 7 * 3_600_000;
    expect(await indexWorkspace(d, wsId, new Date(at))).toMatchObject({ indexed: 1 });
    expect(new Set(ids(await find(editor, 'wombat')))).toEqual(new Set([fine.id, sick.id]));
    expect((await find(editor, 'wombat')).index.state).toBe('complete');
  });

  it('removes entries when a record is purged, and a source that no longer exists is removed, not kept', async () => {
    const t = await task(editor, { title: 'Quokka decommission' });
    const c = (
      await env.svc.createComment(editor, ws, t.id, { text: 'Quokka last words' }, mutation())
    ).data;
    await drain();
    expect(new Set(ids(await find(editor, 'quokka')))).toEqual(new Set([t.id, c.id]));
    await env.svc.taskLifecycle(owner, ws, t.id, 'trash', {}, mutation());
    await env.svc.taskLifecycle(owner, ws, t.id, 'purge', {}, mutation());
    const { id } = (await sql(`SELECT id FROM core.record WHERE public_id = '${t.id}'`))[0]!;
    const entries = async () =>
      (
        await sql(
          `SELECT count(*)::int AS n FROM search.entry WHERE auth_record_id = '${id}' OR source_id = '${id}'`,
        )
      )[0]!.n;
    // Awaiting purge: the record is already invisible, whatever the index still holds.
    expect((await find(owner, 'quokka')).total).toBe(0);
    expect(await entries()).toBe(2);
    // Tombstoning (the last step of a purge) removes the record's entry and everything it hosted.
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      await ksql`UPDATE core.record SET lifecycle_state = 'purged', purged_at = now(),
          prior_lifecycle_state = NULL, owner_membership_id = NULL, source_ref = NULL,
          template_installation_id = NULL, archive_cause = NULL, archive_batch_id = NULL,
          archived_at = NULL, archived_by_type = NULL, archived_by_id = NULL, version = version + 1
        WHERE id = ${id}`.execute(tx.db);
    });
    expect(await entries()).toBe(0);
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM search.index_task WHERE auth_record_id = '${id}'`)
      )[0]!.n,
    ).toBe(0);
    // Deleting a source row (the content hook of a purge) removes its entry the same way.
    const t2 = await task(editor, { title: 'Quokka second' });
    await drain();
    expect(ids(await find(editor, 'quokka'))).toEqual([t2.id]);
    const { id: id2 } = (await sql(`SELECT id FROM core.record WHERE public_id = '${t2.id}'`))[0]!;
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      await ksql`DELETE FROM work.task WHERE id = ${id2}`.execute(tx.db);
    });
    expect(
      (await sql(`SELECT count(*)::int AS n FROM search.entry WHERE source_id = '${id2}'`))[0]!.n,
    ).toBe(0);
    // A queued key whose source is already gone is cleaned up by the worker, not kept or failed.
    const t3 = await task(editor, { title: 'Quokka third' });
    const { id: id3 } = (await sql(`SELECT id FROM core.record WHERE public_id = '${t3.id}'`))[0]!;
    await env.h.worker
      .withWorkspace(wsId, { module: 'test' }, async (tx) => {
        await ksql`DELETE FROM work.task WHERE id = ${id3}`.execute(tx.db);
        await ksql`INSERT INTO search.index_task (workspace_id, source_kind, source_id, auth_record_id)
        VALUES (${wsId}, 'task', ${id3}, ${id3})`.execute(tx.db);
      })
      .catch(() => undefined);
    await drain();
    expect((await find(owner, 'quokka')).total).toBe(0);
  });

  it('refuses malformed, empty, and unbounded searches with one set of issues, and resolves hidden filters like unknown ones', async () => {
    for (const [q, code] of [
      ['', 'empty'],
      ['   ', 'empty'],
      ['-hello', 'no_terms'],
      ['!!! ???', 'no_terms'],
      ['x'.repeat(201), 'too_long'],
      [Array.from({ length: 13 }, (_, i) => `w${i}`).join(' '), 'too_many_terms'],
    ] as const)
      await expect(find(editor, q), q).rejects.toEqual(issueOf(code));
    await expect(env.svc.search(editor, ws, {})).rejects.toEqual(issueOf('required'));
    await expect(find(editor, 'a', { kind: 'nonsense' })).rejects.toEqual(
      issueOf('invalid_option'),
    );
    await expect(find(editor, 'a', { state: 'x' })).rejects.toEqual(issueOf('invalid_option'));
    await expect(find(editor, 'a', { limit: 51 })).rejects.toEqual(issueOf('invalid_option'));
    await expect(find(editor, 'a', { offset: 200 })).rejects.toEqual(issueOf('invalid_option'));
    // A brand the person cannot see and one that does not exist: the same refusal.
    const summit = brands.Summit!;
    await expect(find(outsider, 'a', { brand: summit })).rejects.toEqual(issueOf('unavailable'));
    await expect(find(outsider, 'a', { brand: 'br_00000000000000000000000000' })).rejects.toEqual(
      issueOf('unavailable'),
    );
    await expect(
      find(outsider, 'a', { project: 'prj_00000000000000000000000000' }),
    ).rejects.toEqual(issueOf('unavailable'));
  });

  it('speaks a small query language: words, phrases, exclusions, prefixes, stems, and punctuation', async () => {
    const a = await task(editor, {
      title: 'Wire transfer approval',
      description: richTextFromPlain('Finance signs off the wire transfer before noon.'),
    });
    const b = await task(editor, { title: 'Transfer of the wire cutter', description: null });
    const c = await task(editor, { title: 'Migration checklist for the vendor portal' });
    await drain();
    const only = async (q: string, as: Caller = editor) =>
      new Set(ids(await find(as, q)).filter((x) => [a.id, b.id, c.id].includes(x)));
    expect(await only('wire transfer')).toEqual(new Set([a.id, b.id]));
    expect(await only('"wire transfer"')).toEqual(new Set([a.id]));
    expect(await only('wire -approval')).toEqual(new Set([b.id]));
    expect(await only('wire -"transfer approval"')).toEqual(new Set([b.id]));
    // The last word completes by prefix, as the person types; a quoted word is exact.
    expect(await only('migrat')).toEqual(new Set([c.id]));
    expect(await only('migra')).toEqual(new Set([c.id]));
    expect(await only('"migra"')).toEqual(new Set());
    // Stemmed matching: "migrating" finds "migration".
    expect(await only('migrating checklists')).toEqual(new Set([c.id]));
    // Case and punctuation do not matter; a word with punctuation is its parts in order.
    expect(await only('WIRE.TRANSFER')).toEqual(new Set([a.id]));
    expect(await only('vendor-portal')).toEqual(new Set([c.id]));
    // Words in any language are indexed; nothing is stripped.
    const jp = await task(editor, { title: 'Ünïcode 検索 テスト' });
    await drain();
    expect(ids(await find(editor, '検索'))).toContain(jp.id);
  });

  it('filters by kind, brand, project, state, recency, ownership, and mentions, each applied after authorization', async () => {
    const proj = (
      await env.svc.createProject(
        owner,
        ws,
        { brand: brands.Harbor, name: 'Falcon programme' },
        mutation(),
      )
    ).data;
    const inProj = await task(owner, { title: 'Falcon wiring', project: proj.id });
    const outside = await task(editor, { title: 'Falcon loose end' });
    const summitTask = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Summit, title: 'Falcon summit task' },
        mutation(),
      )
    ).data;
    const c = (
      await env.svc.createComment(
        owner,
        ws,
        inProj.id,
        { text: 'Falcon needs a decision', mentions: [{ kind: 'member', id: await mem(editor) }] },
        mutation(),
      )
    ).data;
    await drain();
    const all = await find(owner, 'falcon');
    expect(new Set(ids(all))).toEqual(
      new Set([proj.id, inProj.id, outside.id, summitTask.id, c.id]),
    );
    expect(ids(await find(owner, 'falcon', { kind: 'task' }))).toHaveLength(3);
    expect(new Set(ids(await find(owner, 'falcon', { kind: 'task,comment' })))).toEqual(
      new Set([inProj.id, outside.id, summitTask.id, c.id]),
    );
    // A kind facet counts what choosing another kind would give; the brand facet likewise.
    const byTask = await find(owner, 'falcon', { kind: 'task' });
    expect(byTask.facets.kinds.find((k: any) => k.kind === 'comment')).toMatchObject({ count: 1 });
    expect(byTask.facets.brands.map((b: any) => b.count).sort()).toEqual([1, 2]);
    expect(new Set(ids(await find(owner, 'falcon', { brand: brands.Summit })))).toEqual(
      new Set([summitTask.id]),
    );
    expect(new Set(ids(await find(owner, 'falcon', { project: proj.id })))).toEqual(
      new Set([proj.id, inProj.id, c.id]),
    );
    expect(ids(await find(owner, 'falcon', { mine: true, kind: 'task' }))).toEqual(
      expect.arrayContaining([inProj.id]),
    );
    expect(ids(await find(owner, 'falcon', { mine: true, kind: 'task' }))).not.toContain(
      outside.id,
    );
    expect(ids(await find(editor, 'falcon', { mentioning_me: true }))).toEqual([c.id]);
    expect(ids(await find(owner, 'falcon', { mentioning_me: true }))).toEqual([]);
    expect((await find(owner, 'falcon', { updated: 'day' })).total).toBe(5);
    await sql(
      `UPDATE search.entry SET source_updated_at = now() - interval '40 days' WHERE title = 'Falcon loose end'`,
    );
    expect(ids(await find(owner, 'falcon', { updated: 'month' }))).not.toContain(outside.id);
    expect(ids(await find(owner, 'falcon', { updated: 'year' }))).toContain(outside.id);
    // The editor holds no Summit access: that brand is unavailable to them, and its task is absent.
    await expect(find(editor, 'falcon', { brand: brands.Summit })).rejects.toEqual(
      issueOf('unavailable'),
    );
    expect(ids(await find(editor, 'falcon'))).not.toContain(summitTask.id);
    // Paging goes through the same authorized set, with a stable order.
    const p1 = await find(owner, 'falcon', { limit: 2 });
    const p2 = await find(owner, 'falcon', { limit: 2, offset: 2 });
    const p3 = await find(owner, 'falcon', { limit: 2, offset: 4 });
    expect(p1.page.has_more).toBe(true);
    expect(p3.page.has_more).toBe(false);
    expect([...ids(p1), ...ids(p2), ...ids(p3)]).toEqual(
      ids(all).length ? [...ids(p1), ...ids(p2), ...ids(p3)] : [],
    );
    expect(new Set([...ids(p1), ...ids(p2), ...ids(p3)])).toEqual(new Set(ids(all)));
  });

  it('indexes the saved text of a document, never a restricted reference label or anything unsaved', async () => {
    const hiddenTask = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Summit, title: 'Osprey reorganisation' },
        mutation(),
      )
    ).data;
    const d = (
      await env.svc.createDocument(
        owner,
        ws,
        { title: 'Weekly notes', brand: brands.Harbor },
        mutation(),
      )
    ).data;
    await env.svc.saveContent(
      owner,
      ws,
      d.id,
      {
        base_version: d.content_version,
        content: content({
          id: 'par_1',
          type: 'paragraph',
          runs: [
            { text: 'We discussed ' },
            { ref: { kind: 'task', id: hiddenTask.id } },
            { text: ' briefly' },
          ],
        }),
      },
      mutation(),
    );
    await drain();
    // The reference label is the viewer's to see, so it is not indexed: the document is not found by it.
    expect(ids(await find(owner, 'osprey')).filter((x) => x === d.id)).toEqual([]);
    expect(ids(await find(owner, 'discussed'))).toEqual([d.id]);
    // Brand-less (workspace) documents and the files and deliverables on tasks are metadata only.
    const wsDoc = (
      await env.svc.createDocument(owner, ws, { title: 'Company handbook Sparrow' }, mutation())
    ).data;
    const t = await task(editor, { title: 'Sparrow launch' });
    const dl = (
      await env.svc.createDeliverable(editor, ws, t.id, { title: 'Sparrow deck' }, mutation())
    ).data;
    await drain();
    expect(new Set(ids(await find(owner, 'sparrow')))).toEqual(new Set([wsDoc.id, t.id, dl.id]));
    // A member of the workspace with no brand access still reads workspace-level documents.
    expect(ids(await find(outsider, 'sparrow'))).toEqual([wsDoc.id]);
    expect(await env.svc.openResult(editor, ws, { type: 'deliverable', id: dl.id })).toMatchObject({
      result: { type: 'deliverable', id: dl.id },
      host: { type: 'task', id: t.id },
    });
  });

  it('opens a result only after checking access again, and never widens it', async () => {
    const t = await task(editor, { title: 'Lynx handover' });
    const c = (await env.svc.createComment(editor, ws, t.id, { text: 'Lynx comment' }, mutation()))
      .data;
    await drain();
    expect(await env.svc.openResult(editor, ws, { type: 'task', id: t.id })).toMatchObject({
      result: { type: 'task', id: t.id },
      host: null,
    });
    expect(await env.svc.openResult(editor, ws, { type: 'comment', id: c.id })).toMatchObject({
      result: { type: 'comment', id: c.id },
      host: { type: 'task', id: t.id },
    });
    // A comment id with a task type, a malformed body, and an unregistered type are all not_found.
    for (const body of [
      { type: 'task', id: c.id },
      { type: 'comment', id: t.id },
      { type: 'nonsense', id: t.id },
      { type: 'task' },
      null,
    ])
      await expect(env.svc.openResult(editor, ws, body)).rejects.toEqual(reason('not_found'));
    // The same checks run at the moment of opening: a deleted comment and a trashed task are gone.
    await env.svc.deleteComment(editor, ws, c.id, mutation());
    await expect(env.svc.openResult(editor, ws, { type: 'comment', id: c.id })).rejects.toEqual(
      reason('not_found'),
    );
    await env.svc.taskLifecycle(owner, ws, t.id, 'trash', {}, mutation());
    await expect(env.svc.openResult(editor, ws, { type: 'task', id: t.id })).rejects.toEqual(
      reason('not_found'),
    );
    await expect(env.svc.openResult(reader, ws, { type: 'task', id: t.id })).rejects.toEqual(
      reason('not_found'),
    );
  });

  it('keeps recent searches personal, bounded, deduplicated, and free of places access has removed', async () => {
    const mine = async (as: Caller) => (await env.svc.listRecentSearches(as, ws)) as any[];
    await env.svc.clearRecentSearches(editor, ws);
    await env.svc.recordRecentSearch(editor, ws, { q: 'Budget review' });
    await env.svc.recordRecentSearch(editor, ws, { q: 'budget REVIEW' });
    let list = await mine(editor);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ q: 'budget REVIEW', count: 2, filters: {} });
    // Personal: nobody else sees it, and typing alone (a search) remembers nothing.
    expect(await mine(owner)).toEqual([]);
    await find(editor, 'never remembered');
    expect((await mine(editor)).map((r) => r.q)).toEqual(['budget REVIEW']);
    // A search that cannot be run is not remembered, and neither is one naming a hidden place.
    await expect(env.svc.recordRecentSearch(editor, ws, { q: '' })).rejects.toEqual(
      issueOf('empty'),
    );
    await expect(
      env.svc.recordRecentSearch(editor, ws, { q: 'x', filters: { brand: brands.Summit } }),
    ).rejects.toEqual(issueOf('unavailable'));
    // Bounded: only the newest SEARCH_RECENT_MAX stay.
    for (let i = 0; i < 30; i++) await env.svc.recordRecentSearch(editor, ws, { q: `query ${i}` });
    list = await mine(editor);
    expect(list).toHaveLength(25);
    expect(list[0]!.q).toBe('query 29');
    expect(list.map((r) => r.q)).not.toContain('budget REVIEW');
    // A search that names a brand is dropped from the list once the person loses that brand.
    await env.svc.recordRecentSearch(editor, ws, {
      q: 'harbor only',
      filters: { brand: brands.Harbor },
    });
    expect((await mine(editor))[0]).toMatchObject({
      q: 'harbor only',
      filters: { brand: [brands.Harbor] },
    });
    // Forget one by its handle, then all.
    const handle = (await mine(editor)).find((r) => r.q === 'query 29')?.handle;
    expect(handle).toEqual(expect.any(String));
    await env.svc.clearRecentSearches(editor, ws, handle);
    expect((await mine(editor)).map((r) => r.q)).not.toContain('query 29');
    await expect(env.svc.clearRecentSearches(editor, ws, 'nope')).rejects.toEqual(
      reason('not_found'),
    );
    await env.svc.clearRecentSearches(editor, ws);
    expect(await mine(editor)).toEqual([]);
    expect(
      (await sql(`SELECT count(*)::int AS n FROM search.recent_query`))[0]!.n,
    ).toBeGreaterThanOrEqual(0);
  });

  it('rate-limits searches per person and keeps every response out of caches', async () => {
    const small = workEnv(db, { searchRate: 3 });
    for (let i = 0; i < 3; i++) await small.svc.search(editor, ws, { q: 'anything' });
    await expect(small.svc.search(editor, ws, { q: 'anything' })).rejects.toEqual(
      reason('rate_limited'),
    );
    // Another person has their own allowance.
    await small.svc.search(owner, ws, { q: 'anything' });
    await small.h.close();
  });
});
