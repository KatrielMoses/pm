import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { productLifecycleRegistry } from '@pm/work';
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
const issueCode = (code: string) =>
  expect.objectContaining({ issues: [expect.objectContaining({ code })] });
const para = (id: string, text: string) => ({ id, type: 'paragraph', runs: [{ text }] });
const content = (...blocks: unknown[]) => ({ v: 2, blocks });
let n = 0;
const opId = () => `op_${Date.now().toString(36)}_${(n += 1)}`;

/**
 * 4D live collaborative editing (ADR-0027): the server sequences block operations, a conflicting
 * operation is refused with the current block, presence is ephemeral and permission-safe, every
 * request re-checks the document's own level, and a checkpoint is an ordinary 4C version.
 */
describe('Live collaborative editing (4D)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller; // edit on Harbor
  let editor2: Caller; // edit on Harbor
  let reader: Caller; // view on Harbor
  let outsider: Caller; // no access to Harbor
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const pub: Record<string, string> = {};

  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const sql = async (text: string) => (await db.admin(text)).rows as Array<Record<string, any>>;
  const make = async (
    as: Caller,
    blocks: unknown[] = [para('blk_a', 'Alpha'), para('blk_b', 'Beta')],
  ) => {
    const d = (
      await env.svc.createDocument(as, ws, { title: 'Live doc', brand: brands.Harbor }, mutation())
    ).data;
    return (
      await env.svc.saveContent(
        as,
        ws,
        d.id,
        { base_version: d.content_version, content: content(...blocks) },
        mutation(),
      )
    ).data;
  };
  const joinLive = (as: Caller, doc: string, mode?: 'edit' | 'view') =>
    env.svc.liveJoin(as, ws, doc, mode ? { mode } : {}) as Promise<any>;
  const ops = (as: Caller, doc: string, session: string, after: number, list: unknown[]) =>
    env.svc.liveOps(as, ws, doc, { session, after, ops: list }) as Promise<any>;
  const poll = (as: Caller, doc: string, session: string, after: number, extra = {}) =>
    env.svc.liveEvents(as, ws, doc, { session, after, ...extra }) as Promise<any>;
  const expire = (doc: string) =>
    sql(
      `UPDATE knowledge.edit_session SET expires_at = now() - interval '1 second' WHERE document_id = (SELECT id FROM core.record WHERE public_id = '${doc}')`,
    );
  const versions = async (doc: string) =>
    sql(
      `SELECT v.number, v.content FROM knowledge.document_version v JOIN core.record r ON r.id = v.document_id WHERE r.public_id = '${doc}' ORDER BY v.number`,
    );
  const leaveAll = async (doc: string, ...who: Array<[Caller, string]>) => {
    for (const [c, s] of who) await env.svc.liveLeave(c, ws, doc, { session: s });
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    editor2 = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    reader = await join(env, db, owner, ws, { kind: 'member', role: 'read_only' });
    outsider = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    for (const [who, level] of [
      [editor, 'edit'],
      [editor2, 'edit'],
      [reader, 'view'],
    ] as const)
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: await mem(who),
        level,
      });
    pub.editor = await mem(editor);
    pub.editor2 = await mem(editor2);
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('opens a draft from the current version and converges two editors on the server order', async () => {
    const d = await make(editor);
    const a = await joinLive(editor, d.id);
    const b = await joinLive(editor2, d.id);
    expect(a).toMatchObject({ mode: 'edit', seq: 0, base_version: 2, dirty: false });
    expect(a.content.blocks.map((x: any) => x.id)).toEqual(['blk_a', 'blk_b']);
    expect(a.hashes.blk_a).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Both see each other; a person sees themselves marked.
    expect(a.presence.map((p: any) => p.name).sort()).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(b.presence.filter((p: any) => p.you)).toHaveLength(1);

    const r1 = await ops(editor, d.id, a.session, 0, [
      {
        op_id: opId(),
        kind: 'replace',
        base_hash: a.hashes.blk_a,
        block: para('blk_a', 'Alpha one'),
      },
    ]);
    expect(r1.applied).toHaveLength(1);
    expect(r1.seq).toBe(1);
    const r2 = await ops(editor2, d.id, b.session, 0, [
      { op_id: opId(), kind: 'insert', after: 'blk_b', block: para('blk_c', 'Gamma') },
    ]);
    // The second editor's response already carries the first editor's earlier operation.
    expect(r2.events.map((e: any) => [e.seq, e.kind, e.block_id])).toEqual([
      [1, 'replace', 'blk_a'],
      [2, 'insert', 'blk_c'],
    ]);
    const caught = await poll(editor, d.id, a.session, 1);
    expect(caught.events.map((e: any) => e.seq)).toEqual([2]);
    expect(caught.seq).toBe(2);
    // Nothing is a version until a checkpoint: the immutable history is untouched.
    expect((await versions(d.id)).map((v) => v.number)).toEqual([1, 2]);
    expect((await env.svc.getDocument(editor, ws, d.id)).content_version).toBe(2);

    const saved = (await env.svc.liveCheckpoint(editor, ws, d.id, { session: a.session })) as any;
    expect(saved).toMatchObject({ saved: true, content_version: 3, dirty: false });
    const v3 = (await versions(d.id)).find((v) => v.number === 3)!;
    expect(v3.content.blocks.map((x: any) => x.id)).toEqual(['blk_a', 'blk_b', 'blk_c']);
    expect(v3.content.blocks[0].runs[0].text).toBe('Alpha one');
    // Block identifiers survive, so a second checkpoint with nothing new makes no version.
    expect(await env.svc.liveCheckpoint(editor, ws, d.id, { session: a.session })).toMatchObject({
      saved: false,
      content_version: 3,
    });
    await leaveAll(d.id, [editor, a.session], [editor2, b.session]);
  });

  it('refuses a conflicting operation with the current block and never merges or drops it silently', async () => {
    const d = await make(editor);
    const a = await joinLive(editor, d.id);
    const b = await joinLive(editor2, d.id);
    const won = await ops(editor, d.id, a.session, 0, [
      {
        op_id: opId(),
        kind: 'replace',
        base_hash: a.hashes.blk_a,
        block: para('blk_a', 'Editor one'),
      },
    ]);
    expect(won.rejected).toEqual([]);
    // The second editor changed the same block from the same base.
    const lost = await ops(editor2, d.id, b.session, 0, [
      {
        op_id: opId(),
        kind: 'replace',
        base_hash: b.hashes.blk_a,
        block: para('blk_a', 'Editor two'),
      },
    ]);
    expect(lost.applied).toEqual([]);
    expect(lost.rejected).toEqual([
      expect.objectContaining({
        code: 'block_changed',
        current: expect.objectContaining({ id: 'blk_a', runs: [{ text: 'Editor one' }] }),
        current_hash: won.applied[0].block_hash,
      }),
    ]);
    // Keep mine: the same edit against the current hash is accepted.
    const again = await ops(editor2, d.id, b.session, won.seq, [
      {
        op_id: opId(),
        kind: 'replace',
        base_hash: lost.rejected[0].current_hash,
        block: para('blk_a', 'Editor two'),
      },
    ]);
    expect(again.applied).toHaveLength(1);
    // Edits to different blocks commute; deleting a changed block, or moving after a deleted one, is refused.
    const del = await ops(editor, d.id, a.session, again.seq, [
      { op_id: opId(), kind: 'delete', block_id: 'blk_b', base_hash: a.hashes.blk_b },
    ]);
    expect(del.applied).toHaveLength(1);
    const gone = await ops(editor2, d.id, b.session, again.seq, [
      { op_id: opId(), kind: 'replace', base_hash: b.hashes.blk_b, block: para('blk_b', 'Late') },
      { op_id: opId(), kind: 'insert', after: 'blk_b', block: para('blk_z', 'Orphan') },
      { op_id: opId(), kind: 'insert', after: null, block: para('blk_a', 'Duplicate id') },
      { op_id: opId(), kind: 'move', block_id: 'blk_a', after: 'blk_b' },
    ]);
    expect(gone.rejected.map((r: any) => r.code)).toEqual([
      'block_missing',
      'anchor_missing',
      'block_exists',
      'anchor_missing',
    ]);
    // Every client replays the accepted log to the same blocks as the server's draft.
    const final = await poll(editor, d.id, a.session, 0);
    const log = final.events.map((e: any) => `${e.seq}:${e.kind}:${e.block_id}`);
    expect(log).toEqual(['1:replace:blk_a', '2:replace:blk_a', '3:delete:blk_b']);
    await leaveAll(d.id, [editor, a.session], [editor2, b.session]);
    const latest = (await versions(d.id)).at(-1)!;
    expect(latest.content.blocks.map((x: any) => [x.id, x.runs[0].text])).toEqual([
      ['blk_a', 'Editor two'],
    ]);
  });

  it('sequences concurrent editors without gaps, and the replayed log equals the draft', async () => {
    const d = await make(editor, [para('blk_a', 'Alpha')]);
    const who = [editor, editor2, owner];
    const sessions = await Promise.all(who.map((c) => joinLive(c, d.id)));
    // Three people each add ten blocks and fight over one shared block, all at once.
    await Promise.all(
      who.map(async (c, i) => {
        for (let k = 0; k < 10; k += 1)
          await ops(c, d.id, sessions[i].session, 0, [
            {
              op_id: opId(),
              kind: 'insert',
              after: null,
              block: para(`blk_${i}_${k}`, `${i}:${k}`),
            },
            {
              op_id: opId(),
              kind: 'replace',
              base_hash: sessions[i].hashes.blk_a,
              block: para('blk_a', `edit ${i}:${k}`),
            },
          ]);
      }),
    );
    const log = (await poll(editor, d.id, sessions[0].session, 0)).events;
    expect(log.map((e: any) => e.seq)).toEqual(Array.from({ length: log.length }, (_, i) => i + 1));
    // The shared block was won by exactly one writer per hash (the rest were refused, none merged).
    const wins = log.filter((e: any) => e.block_id === 'blk_a');
    expect(wins).toHaveLength(1);
    expect(log.filter((e: any) => e.kind === 'insert')).toHaveLength(30);
    // Replaying the accepted log on the starting blocks reproduces the server's draft exactly.
    const rebuilt: any[] = [para('blk_a', 'Alpha')];
    for (const e of log) {
      if (e.kind === 'insert')
        rebuilt.splice(
          e.after === null ? 0 : rebuilt.findIndex((b) => b.id === e.after) + 1,
          0,
          e.block,
        );
      if (e.kind === 'replace') rebuilt[rebuilt.findIndex((b) => b.id === e.block_id)] = e.block;
    }
    const stored = (
      await sql(
        `SELECT content FROM knowledge.edit_draft WHERE document_id = (SELECT id FROM core.record WHERE public_id = '${d.id}')`,
      )
    )[0]!.content;
    expect(rebuilt).toEqual(stored.blocks);
    for (let i = 0; i < who.length; i += 1)
      await env.svc.liveLeave(who[i]!, ws, d.id, { session: sessions[i].session });
  });

  it('makes a retried operation idempotent and bounds a batch', async () => {
    const d = await make(editor);
    const a = await joinLive(editor, d.id);
    const op = { op_id: opId(), kind: 'insert', after: null, block: para('blk_n', 'New') };
    const first = await ops(editor, d.id, a.session, 0, [op]);
    const retry = await ops(editor, d.id, a.session, 0, [op]);
    expect(retry.applied).toEqual(first.applied);
    expect(retry.seq).toBe(1);
    expect(
      (await poll(editor, d.id, a.session, 0)).events.filter((e: any) => e.kind === 'insert'),
    ).toHaveLength(1);
    await expect(ops(editor, d.id, a.session, 0, [])).rejects.toMatchObject({
      issues: expect.any(Array),
    });
    await expect(
      ops(
        editor,
        d.id,
        a.session,
        0,
        Array.from({ length: 51 }, () => ({ ...op, op_id: opId() })),
      ),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'too_many' })] });
    await expect(
      ops(editor, d.id, a.session, 0, [{ op_id: 'x', kind: 'delete', block_id: 'blk_a' }]),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'invalid_hash' })] });
    await leaveAll(d.id, [editor, a.session]);
  });

  it('keeps hidden references opaque in snapshots and events, and restores them when a block is edited', async () => {
    const hidden = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Summit, title: 'Secret plan' },
        mutation(),
      )
    ).data;
    const d = await make(owner, [para('blk_a', 'Alpha')]);
    const o = await joinLive(owner, d.id);
    const withRef = {
      id: 'blk_r',
      type: 'paragraph',
      runs: [{ text: 'See ' }, { ref: { kind: 'task', id: hidden.id } }],
    };
    const ins = await ops(owner, d.id, o.session, 0, [
      { op_id: opId(), kind: 'insert', after: 'blk_a', block: withRef },
    ]);
    expect(ins.applied).toHaveLength(1);
    const e = await joinLive(editor, d.id);
    const text = JSON.stringify(e);
    // The editor holds a token that names nothing, and no label, identifier, or title leaks.
    expect(text).not.toContain(hidden.id);
    expect(text).not.toContain('Secret plan');
    const shown = e.content.blocks.find((b: any) => b.id === 'blk_r');
    expect(shown.runs[1].ref).toEqual({ kind: 'restricted', id: expect.stringMatching(/^rst_/) });
    const viaPoll = JSON.stringify(await poll(editor, d.id, e.session, 0));
    expect(viaPoll).not.toContain(hidden.id);
    expect(viaPoll).not.toContain('Secret plan');
    // Editing the sentence around the token keeps the link it stands for.
    const edited = await ops(editor, d.id, e.session, e.seq, [
      {
        op_id: opId(),
        kind: 'replace',
        base_hash: e.hashes.blk_r,
        block: { id: 'blk_r', type: 'paragraph', runs: [{ text: 'Refer to ' }, shown.runs[1]] },
      },
    ]);
    expect(edited.applied).toHaveLength(1);
    expect(JSON.stringify(edited)).not.toContain(hidden.id);
    await env.svc.liveCheckpoint(owner, ws, d.id, { session: o.session });
    const latest = (await versions(d.id)).at(-1)!;
    expect(latest.content.blocks[1].runs[1].ref).toEqual({ kind: 'task', id: hidden.id });
    // A token the draft never held is refused, not guessed at.
    await expect(
      ops(editor, d.id, e.session, edited.seq, [
        {
          op_id: opId(),
          kind: 'insert',
          after: null,
          block: {
            id: 'blk_q',
            type: 'paragraph',
            runs: [{ ref: { kind: 'restricted', id: 'rst_0000000000000000' } }],
          },
        },
      ]),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'invalid_reference' })] });
    // A new link to something the editor cannot read is refused too.
    const other = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Summit, title: 'Other secret' },
        mutation(),
      )
    ).data;
    await expect(
      ops(editor, d.id, e.session, edited.seq, [
        {
          op_id: opId(),
          kind: 'insert',
          after: null,
          block: {
            id: 'blk_h',
            type: 'paragraph',
            runs: [{ ref: { kind: 'task', id: other.id } }],
          },
        },
      ]),
    ).rejects.toBeDefined();
    await leaveAll(d.id, [owner, o.session], [editor, e.session]);
  });

  it('decides every call through the document level: viewers watch, outsiders and revoked editors are refused', async () => {
    const d = await make(editor);
    const watch = await joinLive(reader, d.id);
    expect(watch.mode).toBe('view');
    await expect(joinLive(reader, d.id, 'edit')).rejects.toBeDefined();
    await expect(
      ops(reader, d.id, watch.session, 0, [
        { op_id: opId(), kind: 'insert', after: null, block: para('blk_x', 'x') },
      ]),
    ).rejects.toBeDefined();
    await expect(joinLive(outsider, d.id)).rejects.toEqual(reason('not_found'));
    // Someone else's session key is worthless to me.
    const mine = await joinLive(editor, d.id);
    await expect(poll(editor2, d.id, mine.session, 0)).rejects.toBeDefined();
    await expect(poll(outsider, d.id, mine.session, 0)).rejects.toEqual(reason('not_found'));
    // A viewer sees the editor's operations as they arrive, with the editor named.
    await ops(editor, d.id, mine.session, 0, [
      { op_id: opId(), kind: 'insert', after: null, block: para('blk_w', 'Hello') },
    ]);
    const seen = await poll(reader, d.id, watch.session, 0);
    expect(seen.events).toHaveLength(1);
    expect(seen.presence.map((p: any) => p.mode).sort()).toEqual(['edit', 'view']);
    // Revoking the grant ends editing at the next request, and the draft is not lost.
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Harbor,
      principal: pub.editor!,
    });
    await expect(
      ops(editor, d.id, mine.session, 1, [
        { op_id: opId(), kind: 'insert', after: null, block: para('blk_v', 'x') },
      ]),
    ).rejects.toEqual(reason('not_found'));
    await expect(poll(editor, d.id, mine.session, 1)).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.liveLeave(editor, ws, d.id, { session: mine.session }),
    ).resolves.toMatchObject({ left: false });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: pub.editor!,
      level: 'edit',
    });
    const still = await joinLive(editor2, d.id);
    expect(still.content.blocks.map((b: any) => b.id)).toContain('blk_w');
    await leaveAll(d.id, [reader, watch.session], [editor2, still.session]);
  });

  it('shows presence only to people who may see people, and never after it expires', async () => {
    const d = await make(editor);
    const e = await joinLive(editor, d.id);
    const e2 = await joinLive(editor2, d.id);
    const guest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: d.id, level: 'read' }],
    });
    const g = await joinLive(guest, d.id);
    expect(g.mode).toBe('view');
    // A guest sees themselves only; no editor's name, count, or caret.
    expect(g.presence).toEqual([expect.objectContaining({ you: true, mode: 'view' })]);
    expect((await poll(guest, d.id, g.session, 0)).presence).toHaveLength(1);
    // Members see members, with the block they are in and nothing else.
    await env.svc.liveHeartbeat(editor, ws, d.id, { session: e.session, caret: 'blk_a' });
    const seen = await poll(editor2, d.id, e2.session, 0);
    const other = seen.presence.find((p: any) => !p.you);
    expect(other).toMatchObject({ mode: 'edit', caret_block: 'blk_a', name: expect.any(String) });
    expect(Object.keys(other).sort()).toEqual([
      'caret_block',
      'color',
      'mode',
      'name',
      'peer',
      'you',
    ]);
    // A presence change wakes a poll that holds the previous tag.
    const tag = seen.presence_tag;
    expect((await poll(editor2, d.id, e2.session, 0, { presence_tag: tag })).presence_tag).toBe(
      tag,
    );
    await env.svc.liveHeartbeat(editor, ws, d.id, { session: e.session, caret: 'blk_b' });
    expect((await poll(editor2, d.id, e2.session, 0, { presence_tag: tag })).presence_tag).not.toBe(
      tag,
    );
    // Stale sessions drop out at once and can no longer write; presence is never audited.
    await expire(d.id);
    await expect(poll(editor2, d.id, e2.session, 0)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'session_expired' })],
    });
    const fresh = await joinLive(editor2, d.id);
    expect(fresh.presence).toHaveLength(1);
    await leaveAll(d.id, [editor2, fresh.session]);
  });

  it('keeps versioned non-live editing safe: a live session blocks it, unsaved work is saved first, nothing is overwritten', async () => {
    const d = await make(editor);
    const a = await joinLive(editor, d.id);
    await ops(editor, d.id, a.session, 0, [
      {
        op_id: opId(),
        kind: 'replace',
        base_hash: a.hashes.blk_a,
        block: para('blk_a', 'Live edit'),
      },
    ]);
    // While someone edits live, a plain save or restore says so and changes nothing.
    await expect(
      env.svc.saveContent(
        editor2,
        ws,
        d.id,
        { base_version: 2, content: content(para('blk_a', 'Plain')) },
        mutation(),
      ),
    ).rejects.toEqual(issueCode('live_edit_in_progress'));
    await expect(
      env.svc.restoreVersion(editor2, ws, d.id, { version: 1, base_version: 2 }, mutation()),
    ).rejects.toEqual(issueCode('live_edit_in_progress'));
    // The editor's connection dies; the session expires with unsaved work in the draft.
    await expire(d.id);
    const stale = await env.svc
      .saveContent(
        editor2,
        ws,
        d.id,
        { base_version: 2, content: content(para('blk_a', 'Plain')) },
        mutation(),
      )
      .catch((e) => e);
    // Their stale base is refused with the newer version, and the live work is now a version.
    expect(stale).toEqual(reason('conflict'));
    const all = await versions(d.id);
    expect(all.at(-1)!.content.blocks[0].runs[0].text).toBe('Live edit');
    expect(all.map((v) => v.number)).toEqual([1, 2, 3]);
    // With the draft clean, the plain path works again against the new version.
    const ok = await env.svc.saveContent(
      editor2,
      ws,
      d.id,
      { base_version: 3, content: content(para('blk_a', 'Plain')) },
      mutation(),
    );
    expect(ok.data.content_version).toBe(4);
    // A new live session starts from the new version, and an older client's position is reloaded.
    const b = await joinLive(editor, d.id);
    expect(b.content.blocks[0].runs[0].text).toBe('Plain');
    expect(b.base_version).toBe(4);
    const resync = await poll(editor, d.id, b.session, b.seq + 5);
    expect(resync.resync).toMatchObject({ base_version: 4 });
    await leaveAll(d.id, [editor, b.session]);
  });

  it('saves on the last leave, turns live editing off by configuration, and bounds sessions', async () => {
    const d = await make(editor);
    const a = await joinLive(editor, d.id);
    const b = await joinLive(editor2, d.id);
    await ops(editor, d.id, a.session, 0, [
      { op_id: opId(), kind: 'insert', after: null, block: para('blk_l', 'Left') },
    ]);
    expect(await env.svc.liveLeave(editor, ws, d.id, { session: a.session })).toMatchObject({
      left: true,
      saved: false,
    });
    expect((await versions(d.id)).length).toBe(2);
    expect(await env.svc.liveLeave(editor2, ws, d.id, { session: b.session })).toMatchObject({
      left: true,
      saved: true,
    });
    expect((await versions(d.id)).length).toBe(3);
    await expect(poll(editor, d.id, a.session, 0)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'session_expired' })],
    });

    const off = workEnv(db, { work: { liveEditingEnabled: 0 } });
    await expect(off.svc.liveJoin(editor, ws, d.id, {})).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'live_disabled' })],
    });
    await off.h.close();
    const small = workEnv(db, { work: { liveSessionsMax: 2, liveSessionsPerMemberMax: 1 } });
    const s1 = (await small.svc.liveJoin(editor, ws, d.id, {})) as any;
    await expect(small.svc.liveJoin(editor, ws, d.id, {})).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'live_capacity' })],
    });
    const s2 = (await small.svc.liveJoin(editor2, ws, d.id, {})) as any;
    await expect(small.svc.liveJoin(owner, ws, d.id, {})).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'live_capacity' })],
    });
    await small.svc.liveLeave(editor, ws, d.id, { session: s1.session });
    await small.svc.liveLeave(editor2, ws, d.id, { session: s2.session });
    await small.h.close();
  });

  it('refuses archived documents, trashes sessions out, and purges drafts, sessions, and the log', async () => {
    const d = await make(editor);
    const a = await joinLive(editor, d.id);
    await ops(editor, d.id, a.session, 0, [
      { op_id: opId(), kind: 'insert', after: null, block: para('blk_p', 'Gone') },
    ]);
    await env.svc.documentLifecycle(owner, ws, d.id, 'trash', mutation());
    await expect(poll(editor, d.id, a.session, 0)).rejects.toEqual(reason('not_found'));
    await expect(
      ops(editor, d.id, a.session, 1, [
        { op_id: opId(), kind: 'insert', after: null, block: para('blk_y', 'y') },
      ]),
    ).rejects.toEqual(reason('not_found'));
    await env.svc.documentLifecycle(owner, ws, d.id, 'purge', mutation());
    const id = (await sql(`SELECT id FROM core.record WHERE public_id = '${d.id}'`))[0]!
      .id as string;
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      await productLifecycleRegistry().get('document')!.purge!.deleteContent(tx, [id]);
    });
    for (const t of ['edit_draft', 'edit_session', 'edit_op'])
      expect(await sql(`SELECT 1 FROM knowledge.${t} WHERE document_id = '${id}'`), t).toHaveLength(
        0,
      );
    const archived = await make(editor);
    await env.svc.documentLifecycle(owner, ws, archived.id, 'archive', mutation());
    await expect(joinLive(editor, archived.id)).rejects.toEqual(issueCode('document_archived'));
  });
});
