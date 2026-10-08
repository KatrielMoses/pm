import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const ifMatch = (v: number) => mutation({ ifMatch: `"${v}"` });
const para = (id: string, text: string) => ({ id, type: 'paragraph', runs: [{ text }] });
const content = (...blocks: unknown[]) => ({ v: 2, blocks });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * 4C documents (ADR-0025): placement and authorization through the compiled level, versions that
 * never overwrite, references resolved for the viewer, suggestions, lifecycle, export, approvals.
 */
describe('Documents and knowledge (4C)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller; // member with edit on Harbor
  let commenter: Caller; // member with a comment share on one document
  let reader: Caller; // read_only role (view) on Harbor
  let outsider: Caller; // member with no access to Harbor
  let guest: Caller; // guest with a comment share on one document
  let readGuest: Caller; // guest with a read share on one document
  let stranger: Caller; // account in another workspace
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let project: { id: string };
  let task: { id: string };
  const pub: Record<string, string> = {};

  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const sql = async (text: string) => (await db.admin(text)).rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const make = async (as: Caller, body: Record<string, unknown>) =>
    (await env.svc.createDocument(as, ws, body, mutation())).data;
  const save = async (
    as: Caller,
    d: { id: string; content_version: number },
    blocks: unknown[],
    title?: string,
  ) =>
    (
      await env.svc.saveContent(
        as,
        ws,
        d.id,
        {
          base_version: d.content_version,
          ...(title ? { title } : {}),
          content: content(...blocks),
        },
        mutation(),
      )
    ).data;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
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
    pub.owner = await mem(owner);
    pub.editor = await mem(editor);
    pub.commenter = await mem(commenter);
    pub.reader = await mem(reader);
    pub.outsider = await mem(outsider);
    project = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Launch' }, mutation())
    ).data;
    task = (
      await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'Write copy' }, mutation())
    ).data;
    ({ owner: stranger } = await workspaceWith(env, db, ['Elsewhere']));
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('creates pages in a brand, a project, a task, a parent page, or the workspace, with typed starters', async () => {
    const page = await make(editor, { title: 'Handbook', brand: brands.Harbor });
    expect(page).toMatchObject({
      type: 'document',
      title: 'Handbook',
      doc_type: 'page',
      state: 'draft',
      scope: 'brand',
      depth: 0,
      content_version: 1,
      attachment: { kind: 'brand' },
      owner: { id: pub.editor },
    });
    expect(page.id).toMatch(/^doc_/);
    expect(page.capabilities).toMatchObject({ edit: true, comment: true, archive: true });
  });

  it('places documents by brand, project, task, parent, or workspace and refuses what does not fit', async () => {
    const root = await make(editor, { title: 'Wiki', brand: brands.Harbor });
    const child = await make(editor, { title: 'Child', parent: root.id });
    expect(child).toMatchObject({
      depth: 1,
      scope: 'brand',
      parent: { id: root.id, title: 'Wiki' },
      ancestors: [{ id: root.id, title: 'Wiki' }],
    });
    const onProject = await make(editor, { title: 'Plan', project: project.id });
    expect(onProject).toMatchObject({
      scope: 'brand',
      attachment: { kind: 'project', id: project.id, title: 'Launch' },
    });
    const onTask = await make(editor, { title: 'Notes', task: task.id });
    expect(onTask.attachment).toMatchObject({ kind: 'task', id: task.id, title: 'Write copy' });
    const work = await make(owner, { title: 'Company policy' });
    expect(work).toMatchObject({
      scope: 'workspace',
      brand: null,
      attachment: { kind: 'workspace' },
    });
    // A page lives where its parent lives; a stray brand, project, or task is refused.
    await expect(
      make(editor, { title: 'x', parent: root.id, brand: brands.Harbor }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'conflicting' })],
    });
    // Typed placement: a brand brief sits in a brand, a project brief in a project.
    await expect(make(editor, { type: 'brand_brief', project: project.id })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'invalid_placement' })],
    });
    await expect(
      make(editor, { type: 'project_brief', brand: brands.Harbor }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'invalid_placement' })],
    });
    expect(await make(editor, { type: 'brand_brief', brand: brands.Harbor })).toMatchObject({
      doc_type: 'brand_brief',
    });
    expect(await make(editor, { type: 'project_brief', project: project.id })).toMatchObject({
      doc_type: 'project_brief',
    });
    // Authority: read-only people and people with no access cannot create here; a stranger gets nothing.
    await expect(make(reader, { title: 'x', brand: brands.Harbor })).rejects.toEqual(
      reason('forbidden'),
    );
    await expect(make(outsider, { title: 'x', brand: brands.Harbor })).rejects.toEqual(
      reason('not_found'),
    );
    await expect(make(stranger, { title: 'x', brand: brands.Harbor })).rejects.toEqual(
      reason('not_found'),
    );
    await expect(make(reader, { title: 'x' })).rejects.toEqual(reason('forbidden'));
  });

  it('starts typed documents from built-in starters and records the starter version', async () => {
    const sop = await make(editor, {
      type: 'sop',
      title: 'Onboard a client',
      brand: brands.Harbor,
    });
    expect(sop.content.blocks.length).toBeGreaterThan(3);
    const v = await env.svc.getVersion(editor, ws, sop.id, 1);
    expect(v).toMatchObject({ kind: 'template', template: 'sop@1' });
    const blank = await make(editor, {
      type: 'sop',
      title: 'Empty',
      brand: brands.Harbor,
      starter: false,
    });
    expect(blank.content.blocks).toEqual([]);
    expect((await env.svc.getVersion(editor, ws, blank.id, 1)).kind).toBe('save');
    await expect(
      make(editor, { title: 'both', brand: brands.Harbor, content: content(), starter: true }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'conflicting' })] });
  });

  it('saves versions that never overwrite: a stale base conflicts, equal content is a no-op', async () => {
    const d = await make(editor, { title: 'Spec', brand: brands.Harbor, starter: false });
    const v2 = await save(editor, d, [para('blk_one', 'First draft')]);
    expect(v2).toMatchObject({ content_version: 2, title: 'Spec' });
    // The same content again is no new version.
    const again = await save(editor, v2, [para('blk_one', 'First draft')]);
    expect(again.content_version).toBe(2);
    expect(again.content_hash).toBe(v2.content_hash);
    // Someone else saved from version 2; saving from version 2 again is a conflict, nothing is lost.
    const v3 = await save(owner, v2, [
      para('blk_one', 'First draft'),
      para('blk_two', 'Second block'),
    ]);
    expect(v3.content_version).toBe(3);
    await expect(
      env.svc.saveContent(
        editor,
        ws,
        d.id,
        { base_version: 2, content: content(para('blk_one', 'My conflicting edit')) },
        mutation(),
      ),
    ).rejects.toMatchObject({ code: 'conflict', conflict: { current_version: 3 } });
    const history = await env.svc.listVersions(editor, ws, d.id, {});
    expect(history.data.map((h) => [h.number, h.kind, h.current])).toEqual([
      [3, 'save', true],
      [2, 'save', false],
      [1, 'save', false],
    ]);
    expect(history.data[0]!.summary).toEqual({ added: 1, changed: 0, removed: 0 });
    expect(history.data[1]!.by).toMatchObject({ id: pub.editor });
    expect((await env.svc.getVersion(editor, ws, d.id, 2)).content.blocks).toHaveLength(1);
    // A title change is a version of its own.
    const renamed = await save(
      editor,
      v3,
      [para('blk_one', 'First draft'), para('blk_two', 'Second block')],
      'Spec v2',
    );
    expect(renamed).toMatchObject({ content_version: 4, title: 'Spec v2' });
    await expect(env.svc.getVersion(editor, ws, d.id, 99)).rejects.toEqual(reason('not_found'));
  });

  it('restores an earlier version as a new one and keeps the whole history', async () => {
    const d = await make(editor, { title: 'Policy', brand: brands.Harbor, starter: false });
    const v2 = await save(editor, d, [para('blk_a', 'Original')]);
    const v3 = await save(editor, v2, [para('blk_a', 'Rewritten')], 'Policy (new)');
    const restored = (
      await env.svc.restoreVersion(
        editor,
        ws,
        d.id,
        { version: 2, base_version: v3.content_version },
        mutation(),
      )
    ).data;
    expect(restored).toMatchObject({ content_version: 4, title: 'Policy' });
    expect(restored.content.blocks[0]).toMatchObject({ runs: [{ text: 'Original' }] });
    const v4 = await env.svc.getVersion(editor, ws, d.id, 4);
    expect(v4).toMatchObject({ kind: 'restore', restored_from: 2 });
    // Versions 2 and 3 are untouched.
    expect((await env.svc.getVersion(editor, ws, d.id, 3)).content.blocks[0]).toMatchObject({
      runs: [{ text: 'Rewritten' }],
    });
    await expect(
      env.svc.restoreVersion(editor, ws, d.id, { version: 4, base_version: 4 }, mutation()),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'already_current' })] });
    await expect(
      env.svc.restoreVersion(editor, ws, d.id, { version: 2, base_version: 3 }, mutation()),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      env.svc.restoreVersion(reader, ws, d.id, { version: 2, base_version: 4 }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    // Versions cannot be changed or deleted by the application.
    await expect(
      db.admin(`UPDATE knowledge.document_version SET title = 'x' WHERE number = 2`),
    ).rejects.toThrow(/immutable/);
  });

  it('keeps state, owner, and review date with versions of their own, and never claims current past the review date', async () => {
    const d = await make(editor, { title: 'Runbook', brand: brands.Harbor, starter: false });
    expect(d).toMatchObject({ state: 'draft', effective_state: 'draft', review_due_on: null });
    const current = (
      await env.svc.updateDocument(
        editor,
        ws,
        d.id,
        { state: 'current', review_due_on: inDays(100) },
        ifMatch(d.version),
      )
    ).data;
    expect(current).toMatchObject({
      state: 'current',
      effective_state: 'current',
      review_overdue: false,
    });
    expect(current.version).toBe(d.version + 1);
    // Saving content does not disturb the metadata version, and a metadata change does not stale a save.
    await expect(
      env.svc.updateDocument(editor, ws, d.id, { state: 'draft' }, ifMatch(d.version)),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      env.svc.updateDocument(editor, ws, d.id, { state: 'draft' }, mutation()),
    ).rejects.toEqual(reason('precondition_required'));
    // A review date in the past: still stored as current, honestly reported as stale.
    const overdue = (
      await env.svc.updateDocument(
        editor,
        ws,
        d.id,
        { review_due_on: '2020-01-01' },
        ifMatch(current.version),
      )
    ).data;
    expect(overdue).toMatchObject({
      state: 'current',
      effective_state: 'stale',
      review_overdue: true,
    });
    expect(
      (
        await sql(
          `SELECT state FROM knowledge.document WHERE id = (SELECT id FROM core.record WHERE public_id = '${d.id}')`,
        )
      )[0]!.state,
    ).toBe('current');
    const stale = await env.svc.listDocuments(editor, ws, { state: 'stale', scope: brands.Harbor });
    expect(stale.data.map((x) => x.id)).toContain(d.id);
    const fresh = await env.svc.listDocuments(editor, ws, {
      state: 'current',
      scope: brands.Harbor,
    });
    expect(fresh.data.map((x) => x.id)).not.toContain(d.id);
    await expect(
      env.svc.updateDocument(
        editor,
        ws,
        d.id,
        { review_due_on: '2999-01-01' },
        ifMatch(overdue.version),
      ),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'too_far' })] });
    await expect(
      env.svc.updateDocument(
        editor,
        ws,
        d.id,
        { review_due_on: 'next week' },
        ifMatch(overdue.version),
      ),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'invalid_date' })] });
    // Owners must be able to edit; people who cannot are refused with one issue.
    await expect(
      env.svc.updateDocument(editor, ws, d.id, { owner: pub.reader! }, ifMatch(overdue.version)),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'invalid_reference' })] });
    await expect(
      env.svc.updateDocument(editor, ws, d.id, { owner: pub.outsider! }, ifMatch(overdue.version)),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'invalid_reference' })] });
    const owned = (
      await env.svc.updateDocument(
        editor,
        ws,
        d.id,
        { owner: pub.owner! },
        ifMatch(overdue.version),
      )
    ).data;
    expect(owned.owner).toMatchObject({ id: pub.owner });
    await expect(
      env.svc.updateDocument(reader, ws, d.id, { state: 'stale' }, ifMatch(owned.version)),
    ).rejects.toEqual(reason('forbidden'));
    await expect(
      env.svc.updateDocument(editor, ws, d.id, {}, ifMatch(owned.version)),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'empty' })],
    });
  });

  it('nests pages, moves and reorders them, and refuses cycles, depth, and moves between places', async () => {
    const root = await make(editor, { title: 'Docs root', brand: brands.Harbor });
    const a = await make(editor, { title: 'A', parent: root.id });
    const b = await make(editor, { title: 'B', parent: root.id });
    const a1 = await make(editor, { title: 'A1', parent: a.id });
    const kids = await env.svc.listDocuments(editor, ws, { parent: root.id });
    expect(kids.data.map((x) => x.title)).toEqual(['A', 'B']);
    expect(kids.data[0]).toMatchObject({ has_children: true, parent_id: root.id });
    // Reorder, then move A under B (its subtree follows).
    const moved = (
      await env.svc.moveDocument(editor, ws, b.id, { parent: root.id, after: null }, mutation())
    ).data;
    expect(moved.depth).toBe(1);
    expect(
      (await env.svc.listDocuments(editor, ws, { parent: root.id })).data.map((x) => x.title),
    ).toEqual(['B', 'A']);
    await env.svc.moveDocument(editor, ws, a.id, { parent: b.id }, mutation());
    expect((await env.svc.getDocument(editor, ws, a1.id)).ancestors.map((x) => x.title)).toEqual([
      'Docs root',
      'B',
      'A',
    ]);
    expect((await env.svc.getDocument(editor, ws, a1.id)).depth).toBe(3);
    // A page cannot move into its own subtree.
    await expect(
      env.svc.moveDocument(editor, ws, b.id, { parent: a1.id }, mutation()),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'cycle' })],
    });
    await expect(
      env.svc.moveDocument(editor, ws, b.id, { parent: b.id }, mutation()),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'cycle' })],
    });
    // A page stays where it lives: another brand, or a project, is another place.
    const other = await make(owner, { title: 'Elsewhere', brand: brands.Summit });
    await expect(
      env.svc.moveDocument(editor, ws, a1.id, { parent: other.id }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    const attached = await make(editor, { title: 'Project page', project: project.id });
    await expect(
      env.svc.moveDocument(editor, ws, a1.id, { parent: attached.id }, mutation()),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'different_place' })],
    });
    // Moving to the top level works and drags the subtree along.
    await env.svc.moveDocument(editor, ws, a.id, { parent: null }, mutation());
    expect((await env.svc.getDocument(editor, ws, a1.id)).depth).toBe(1);
    // Depth and breadth are bounded.
    const small = workEnv(db, {
      work: { documentDepthMax: 2, documentChildrenMax: 2, documentTreeMax: 4 },
    });
    const d0 = (
      await small.svc.createDocument(owner, ws, { title: 'r', brand: brands.Harbor }, mutation())
    ).data;
    const d1 = (
      await small.svc.createDocument(owner, ws, { title: 'c1', parent: d0.id }, mutation())
    ).data;
    const d2 = (
      await small.svc.createDocument(owner, ws, { title: 'c2', parent: d1.id }, mutation())
    ).data;
    await expect(
      small.svc.createDocument(owner, ws, { title: 'c3', parent: d2.id }, mutation()),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'depth_exceeded' })],
    });
    await small.svc.createDocument(owner, ws, { title: 'c1b', parent: d0.id }, mutation());
    await expect(
      small.svc.createDocument(owner, ws, { title: 'c1c', parent: d0.id }, mutation()),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'too_many' })],
    });
    await small.h.close();
  });

  it('decides every read and write through the placement: owners, members, read-only, outsiders, shares, and strangers', async () => {
    const d = await make(editor, { title: 'Private notes', brand: brands.Harbor });
    const child = await make(editor, { title: 'Child notes', parent: d.id });
    await apply(env, owner, ws, {
      kind: 'record_share',
      record: d.id,
      grantee: pub.commenter!,
      level: 'comment',
    });
    commenter = commenter;
    guest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: d.id, level: 'comment' }],
    });
    readGuest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: d.id, level: 'read' }],
    });
    const reads = async (c: Caller, id = d.id) =>
      env.svc.getDocument(c, ws, id).then(
        () => true,
        () => false,
      );
    expect(await reads(owner)).toBe(true);
    expect(await reads(editor)).toBe(true);
    expect(await reads(reader)).toBe(true);
    expect(await reads(commenter)).toBe(true);
    expect(await reads(guest)).toBe(true);
    expect(await reads(readGuest)).toBe(true);
    expect(await reads(outsider)).toBe(false);
    expect(await reads(stranger)).toBe(false);
    // A share carries the document, never the tree around it.
    expect(await reads(commenter, child.id)).toBe(false);
    const asGuest = await env.svc.getDocument(guest, ws, d.id);
    expect(asGuest).toMatchObject({
      parent: null,
      ancestors: [],
      children_count: 0,
      attachment: { kind: 'brand', id: null, title: null },
    });
    expect(asGuest.capabilities).toMatchObject({
      edit: false,
      comment: true,
      suggest: true,
      export: false,
      create_page: false,
      move: false,
      archive: false,
    });
    expect((await env.svc.getDocument(readGuest, ws, d.id)).capabilities).toMatchObject({
      comment: false,
      suggest: false,
    });
    expect((await env.svc.getDocument(commenter, ws, d.id)).capabilities).toMatchObject({
      edit: false,
      comment: true,
      export: true,
    });
    expect((await env.svc.getDocument(reader, ws, d.id)).capabilities).toMatchObject({
      edit: false,
      comment: false,
      export: false,
    });
    await expect(env.svc.listDocuments(commenter, ws, { parent: d.id })).rejects.toEqual(
      reason('not_found'),
    );
    const seen = (await env.svc.listDocuments(commenter, ws, {})).data.map((x) => x.id);
    expect(seen).toContain(d.id);
    expect(seen).not.toContain(child.id);
    expect((await env.svc.listDocuments(guest, ws, {})).data.map((x) => x.id)).toEqual([d.id]);
    expect((await env.svc.listDocuments(outsider, ws, {})).data.map((x) => x.id)).not.toContain(
      d.id,
    );
    // Writes: read-only and read-share cannot; a comment share cannot edit; an edit share can.
    await expect(save(reader, d, [para('blk_x', 'no')])).rejects.toEqual(reason('forbidden'));
    await expect(save(commenter, d, [para('blk_x', 'no')])).rejects.toEqual(reason('forbidden'));
    await expect(save(readGuest, d, [para('blk_x', 'no')])).rejects.toEqual(reason('forbidden'));
    await expect(save(outsider, d, [para('blk_x', 'no')])).rejects.toEqual(reason('not_found'));
    await expect(save(stranger, d, [para('blk_x', 'no')])).rejects.toEqual(reason('not_found'));
    const sharedEditor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'record_share',
      record: d.id,
      grantee: await mem(sharedEditor),
      level: 'edit',
    });
    expect(
      (await save(sharedEditor, d, [para('blk_x', 'edited through a share')])).content_version,
    ).toBe(2);
    // ...but that share edits this document only: not its subpages, and not who owns it.
    await expect(
      env.svc.updateDocument(
        sharedEditor,
        ws,
        d.id,
        { owner: await mem(sharedEditor) },
        ifMatch((await env.svc.getDocument(sharedEditor, ws, d.id)).version),
      ),
    ).rejects.toEqual(reason('forbidden'));
    await expect(
      env.svc.createDocument(sharedEditor, ws, { title: 'x', parent: d.id }, mutation()),
    ).rejects.toEqual(reason('not_found'));
  });
});
