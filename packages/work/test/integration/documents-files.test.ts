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
const issueOf = (code: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });
const para = (id: string, text: string) => ({ id, type: 'paragraph', runs: [{ text }] });
const embed = (id: string, file: string, title?: string) => ({
  id,
  type: 'embed',
  kind: 'file',
  url: file,
  ...(title ? { title } : {}),
});
const content = (...blocks: unknown[]) => ({ v: 2, blocks });

/**
 * 4D closes the join 4C and 4E each left to the later integration: a document hosts files through
 * its own level (4E authorities, 4C placement), a file embed names a file attached to that very
 * document, and the lifecycle carries the files with the document.
 */
describe('Documents as file hosts and file embeds (4D)', () => {
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
  const make = async (as: Caller, body: Record<string, unknown>) =>
    (await env.svc.createDocument(as, ws, body, mutation())).data;
  const link = async (
    as: Caller,
    host: string,
    url = 'https://example.com/spec.pdf',
    name?: string,
  ) =>
    (await env.svc.addFileLink(as, ws, { host, url, ...(name ? { name } : {}) }, mutation())).data;

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

  it('attaches files to a brand document and to a workspace document through the document level', async () => {
    const d = await make(editor, { title: 'Spec', brand: brands.Harbor });
    const f = await link(editor, d.id, 'https://example.com/spec.pdf', 'spec.pdf');
    expect(f).toMatchObject({ name: 'spec.pdf', host: { kind: 'document', id: d.id } });
    expect((await env.svc.listFiles(reader, ws, d.id)).data.map((x: any) => x.id)).toEqual([f.id]);
    // The same authority as the document: a reader cannot add, an outsider sees nothing.
    await expect(link(reader, d.id)).rejects.toEqual(reason('forbidden'));
    await expect(env.svc.listFiles(outsider, ws, d.id)).rejects.toEqual(reason('not_found'));
    await expect(env.svc.getFile(outsider, ws, f.id)).rejects.toEqual(reason('not_found'));
    const company = await make(owner, { title: 'Company policy' });
    const g = await link(owner, company.id, 'https://example.com/policy.pdf');
    expect(g.host).toMatchObject({ kind: 'document', id: company.id });
    expect(
      (
        await sql(
          `SELECT f.brand_id FROM files.file f JOIN core.record r ON r.id = f.id WHERE r.public_id = '${g.id}'`,
        )
      )[0]!.brand_id,
    ).toBeNull();
    // A document the person cannot read is an unknown host.
    await expect(link(outsider, d.id)).rejects.toEqual(reason('not_found'));
  });

  it('embeds only files attached to the document, shows them by what the viewer may read, and exports honestly', async () => {
    const d = await make(editor, { title: 'Embeds', brand: brands.Harbor });
    const other = await make(editor, { title: 'Elsewhere', brand: brands.Harbor });
    const mine = await link(editor, d.id, 'https://example.com/a.pdf', 'a.pdf');
    const foreign = await link(editor, other.id, 'https://example.com/b.pdf', 'b.pdf');
    const save = (blocks: unknown[], base: number) =>
      env.svc.saveContent(
        editor,
        ws,
        d.id,
        { base_version: base, content: content(...blocks) },
        mutation(),
      );
    // A file of another document, an unknown id, or an address is refused.
    await expect(save([embed('emb_1', foreign.id)], d.content_version)).rejects.toEqual(
      issueOf('invalid_file'),
    );
    await expect(
      save([embed('emb_1', 'file_00000000000000000000000000')], d.content_version),
    ).rejects.toEqual(issueOf('invalid_file'));
    await expect(
      save(
        [{ id: 'emb_1', type: 'embed', kind: 'file', url: 'https://example.com/a.pdf' }],
        d.content_version,
      ),
    ).rejects.toEqual(issueOf('unsupported_embed'));
    const saved = (
      await save([para('par_1', 'See'), embed('emb_1', mine.id, 'The spec')], d.content_version)
    ).data;
    expect(saved.content.blocks[1]).toMatchObject({
      kind: 'file',
      url: mine.id,
      title: 'The spec',
    });
    expect(saved.files[mine.id]).toMatchObject({
      id: mine.id,
      name: 'a.pdf',
      source: 'external',
      scan: null,
    });
    // A reader sees the card's facts (reading the document is the authority); an outsider sees nothing.
    expect((await env.svc.getDocument(reader, ws, d.id)).files[mine.id]).toMatchObject({
      name: 'a.pdf',
    });
    await expect(env.svc.getDocument(outsider, ws, d.id)).rejects.toEqual(reason('not_found'));
    // Exports never carry the file or its address, and say so.
    const md = (await env.svc.exportDocument(owner, ws, d.id, { format: 'markdown' }, mutation()))
      .data as any;
    expect(md.content).toContain('File: The spec (not included in this export)');
    expect(md.content).not.toContain('example.com');
    expect(md.notes.embeds_as_links).toBeGreaterThanOrEqual(1);
    // A trashed file leaves the card unavailable, and unrelated saves still work.
    await env.svc.trashFile(editor, ws, mine.id, mutation());
    const after = await env.svc.getDocument(editor, ws, d.id);
    expect(after.files[mine.id]).toBeUndefined();
    await env.svc.saveContent(
      editor,
      ws,
      d.id,
      {
        base_version: after.content_version,
        content: content(
          para('par_1', 'See'),
          embed('emb_1', mine.id, 'The spec'),
          para('par_2', 'more'),
        ),
      },
      mutation(),
    );
  });

  it('lets live editing embed an attached file and refuses one that is not', async () => {
    const d = await make(editor, { title: 'Live embeds', brand: brands.Harbor });
    const mine = await link(editor, d.id);
    const stranger = await link(
      editor,
      (await make(editor, { title: 'Other', brand: brands.Harbor })).id,
    );
    const s = (await env.svc.liveJoin(editor, ws, d.id, {})) as any;
    const ok = (await env.svc.liveOps(editor, ws, d.id, {
      session: s.session,
      after: 0,
      ops: [{ op_id: 'op_e1', kind: 'insert', after: null, block: embed('emb_a', mine.id) }],
    })) as any;
    expect(ok.applied).toHaveLength(1);
    await expect(
      env.svc.liveOps(editor, ws, d.id, {
        session: s.session,
        after: 1,
        ops: [{ op_id: 'op_e2', kind: 'insert', after: null, block: embed('emb_b', stranger.id) }],
      }),
    ).rejects.toEqual(issueOf('invalid_file'));
    await env.svc.liveLeave(editor, ws, d.id, { session: s.session });
    expect((await env.svc.getDocument(editor, ws, d.id)).content.blocks[0]).toMatchObject({
      kind: 'file',
      url: mine.id,
    });
  });

  it('carries files with their document through trash, restore, and purge', async () => {
    const d = await make(editor, { title: 'Carrier', brand: brands.Harbor });
    const child = await make(editor, { title: 'Subpage', parent: d.id });
    const f = await link(editor, d.id);
    const g = await link(editor, child.id);
    await env.svc.documentLifecycle(owner, ws, d.id, 'trash', mutation());
    const state = async (id: string) =>
      (await sql(`SELECT lifecycle_state FROM core.record WHERE public_id = '${id}'`))[0]!
        .lifecycle_state;
    expect(await state(f.id)).toBe('trashed');
    expect(await state(g.id)).toBe('trashed');
    await expect(env.svc.getFile(editor, ws, f.id)).rejects.toEqual(reason('not_found'));
    await env.svc.documentLifecycle(owner, ws, d.id, 'restore', mutation());
    expect(await state(f.id)).toBe('active');
    await env.svc.documentLifecycle(owner, ws, d.id, 'trash', mutation());
    await env.svc.documentLifecycle(owner, ws, d.id, 'purge', mutation());
    const ids = (
      await sql(
        `SELECT id FROM core.record WHERE public_id IN ('${d.id}', '${child.id}', '${f.id}', '${g.id}') AND record_type IN ('document', 'file') ORDER BY record_type DESC`,
      )
    ).map((r) => r.id as string);
    expect(ids).toHaveLength(4);
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      const reg = productLifecycleRegistry();
      await reg.get('file')!.purge!.deleteContent(tx, ids.slice(0, 2));
      await reg.get('document')!.purge!.deleteContent(tx, ids.slice(2));
    });
    expect(
      await sql(`SELECT 1 FROM files.file WHERE id = ANY('{${ids.join(',')}}'::uuid[])`),
    ).toHaveLength(0);
  });

  it('lets a comment on a workspace document carry files', async () => {
    const d = await make(owner, { title: 'Company handbook' });
    const c = (await env.svc.createComment(owner, ws, d.id, { text: 'See attachment' }, mutation()))
      .data;
    const f = await link(owner, c.id, 'https://example.com/c.pdf');
    expect(f.host).toMatchObject({ kind: 'comment' });
    expect(
      (
        await sql(
          `SELECT f.brand_id, f.host_kind FROM files.file f JOIN core.record r ON r.id = f.id WHERE r.public_id = '${f.id}'`,
        )
      )[0],
    ).toMatchObject({ brand_id: null, host_kind: 'comment' });
  });
});
