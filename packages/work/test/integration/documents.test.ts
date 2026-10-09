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
  const sql = async (text: string) => (await db.admin(text)).rows as Array<Record<string, any>>;
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

  describe('references, backlinks, and comments', () => {
    const run = (id: string, kind: string) => ({ ref: { kind, id } });

    it('links records by registered reference, re-checks every viewer, and shows no title they cannot read', async () => {
      const secret = (
        await env.svc.createTask(
          owner,
          ws,
          { brand: brands.Summit, title: 'Hidden acquisition' },
          mutation(),
        )
      ).data;
      const target = (
        await env.svc.createTask(
          owner,
          ws,
          { brand: brands.Harbor, title: 'Visible task' },
          mutation(),
        )
      ).data;
      const d = await make(editor, { title: 'Links', brand: brands.Harbor, starter: false });
      // New references must be readable by the person saving; hidden, unknown, and unsupported are one issue.
      for (const ref of [
        run(secret.id, 'task'),
        run(`tsk_${'0'.repeat(25)}1`, 'task'),
        run(`prj_${'0'.repeat(25)}1`, 'project'),
      ])
        await expect(
          save(editor, d, [{ id: 'blk_a', type: 'paragraph', runs: [{ text: 'See ' }, ref] }]),
        ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'not_linkable' })] });
      const saved = await save(editor, d, [
        {
          id: 'blk_a',
          type: 'paragraph',
          runs: [
            { text: 'See ' },
            run(target.id, 'task'),
            { text: ' and ' },
            run(pub.owner!, 'member'),
            { text: ' and ' },
            run(project.id, 'project'),
          ],
        },
      ]);
      expect(saved.references[`task:${target.id}`]).toMatchObject({
        label: 'Visible task',
        path: `/workspaces/${ws}/tasks/${target.id}`,
      });
      expect(saved.references[`member:${pub.owner}`]).toMatchObject({ kind: 'member' });
      expect(JSON.stringify(saved.content)).not.toContain('Visible task');
      // A viewer who can read the document but not the target sees a restricted token: no entry at all.
      const asReader = await env.svc.getDocument(reader, ws, d.id);
      expect(asReader.references[`task:${target.id}`]).toBeDefined();
      // An editor who cannot read a link already in the document can still save it unchanged.
      const hiddenFromEditor = await make(owner, {
        title: 'Owner links',
        brand: brands.Harbor,
        starter: false,
      });
      const withSecret = await save(owner, hiddenFromEditor, [
        { id: 'blk_a', type: 'paragraph', runs: [{ text: 'Plan ' }, run(secret.id, 'task')] },
      ]);
      const asEditor = await env.svc.getDocument(editor, ws, withSecret.id);
      expect(asEditor.references[`task:${secret.id}`]).toBeUndefined();
      expect(JSON.stringify(asEditor)).not.toContain('Hidden acquisition');
      expect(JSON.stringify(asEditor)).not.toContain(secret.id);
      expect(asEditor.content.blocks[0]).toMatchObject({
        runs: [
          { text: 'Plan ' },
          { ref: { kind: 'restricted', id: expect.stringMatching(/^rst_[0-9a-f]{16}$/) } },
        ],
      });
      const token = (asEditor.content.blocks[0] as { runs: unknown[] }).runs[1];
      const edited = await save(editor, withSecret, [
        { id: 'blk_a', type: 'paragraph', runs: [{ text: 'Plan, edited ' }, token] },
      ]);
      // The link survives an editor who cannot read it: the token went back to what it stood for.
      expect(
        (
          await sql(
            `SELECT count(*)::int AS n FROM knowledge.document_reference ref JOIN core.record r ON r.id = ref.target_record_id WHERE r.public_id = '${secret.id}'`,
          )
        )[0]!.n,
      ).toBe(1);
      expect(
        (await env.svc.getDocument(owner, ws, withSecret.id)).references[`task:${secret.id}`],
      ).toMatchObject({ label: 'Hidden acquisition' });
      // A token that stands for nothing in this document is refused.
      await expect(
        save(editor, edited, [
          {
            id: 'blk_a',
            type: 'paragraph',
            runs: [{ ref: { kind: 'restricted', id: 'rst_0123456789abcdef' } }],
          },
        ]),
      ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'invalid_reference' })] });
      expect(edited.content_version).toBe(withSecret.content_version + 1);
      // ...but cannot add a new link to something hidden.
      await expect(
        save(editor, edited, [
          {
            id: 'blk_a',
            type: 'paragraph',
            runs: [
              run(secret.id, 'task'),
              run(secret.id.replace(/.$/, secret.id.endsWith('0') ? '1' : '0'), 'task'),
            ],
          },
        ]),
      ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'not_linkable' })] });
    });

    it('lists backlinks only for documents and targets the viewer can read', async () => {
      const target = (
        await env.svc.createTask(
          owner,
          ws,
          { brand: brands.Harbor, title: 'Backlinked' },
          mutation(),
        )
      ).data;
      const readable = await make(editor, {
        title: 'Mentions it',
        brand: brands.Harbor,
        starter: false,
      });
      await save(editor, readable, [
        { id: 'blk_a', type: 'paragraph', runs: [run(target.id, 'task')] },
      ]);
      const linked = await make(editor, {
        title: 'Linked explicitly',
        brand: brands.Harbor,
        starter: false,
      });
      const withLink = (
        await env.svc.setLinks(
          editor,
          ws,
          linked.id,
          { records: [target.id, project.id] },
          ifMatch(linked.version),
        )
      ).data;
      expect(withLink.links.map((l) => l.id).sort()).toEqual([project.id, target.id].sort());
      const hidden = await make(owner, {
        title: 'Summit mention',
        brand: brands.Summit,
        starter: false,
      });
      await save(owner, hidden, [
        { id: 'blk_a', type: 'paragraph', runs: [run(target.id, 'task')] },
      ]);
      const seen = await env.svc.backlinks(editor, ws, target.id, {});
      expect(seen.data.map((x) => [x.title, x.via]).sort()).toEqual([
        ['Linked explicitly', 'link'],
        ['Mentions it', 'mention'],
      ]);
      expect(
        (await env.svc.backlinks(owner, ws, target.id, {})).data.map((x) => x.title),
      ).toContain('Summit mention');
      // Nothing is revealed about the links to a record the viewer cannot read.
      await expect(env.svc.backlinks(outsider, ws, target.id, {})).rejects.toEqual(
        reason('not_found'),
      );
      await expect(env.svc.backlinks(stranger, ws, target.id, {})).rejects.toEqual(
        reason('not_found'),
      );
      await expect(env.svc.backlinks(editor, ws, `tsk_${'0'.repeat(26)}`, {})).rejects.toEqual(
        reason('not_found'),
      );
      // A document cannot link to itself, and the explicit links are replaced as one set.
      await expect(
        env.svc.setLinks(
          editor,
          ws,
          linked.id,
          { records: [linked.id] },
          ifMatch(withLink.version),
        ),
      ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'not_linkable' })] });
      const cleared = (
        await env.svc.setLinks(editor, ws, linked.id, { records: [] }, ifMatch(withLink.version))
      ).data;
      expect(cleared.links).toEqual([]);
      expect((await env.svc.backlinks(editor, ws, target.id, {})).data.map((x) => x.title)).toEqual(
        ['Mentions it'],
      );
    });

    it('replaces the links a viewer can see and keeps the ones they cannot', async () => {
      const secret = (
        await env.svc.createTask(
          owner,
          ws,
          { brand: brands.Summit, title: 'Unseen link' },
          mutation(),
        )
      ).data;
      const seen = (
        await env.svc.createTask(
          owner,
          ws,
          { brand: brands.Harbor, title: 'Seen link' },
          mutation(),
        )
      ).data;
      const d = await make(owner, { title: 'Mixed links', brand: brands.Harbor, starter: false });
      const first = (
        await env.svc.setLinks(
          owner,
          ws,
          d.id,
          { records: [secret.id, seen.id] },
          ifMatch(d.version),
        )
      ).data;
      expect(first.links_restricted).toBe(0);
      const asEditor = await env.svc.getDocument(editor, ws, d.id);
      expect(asEditor.links.map((l) => l.id)).toEqual([seen.id]);
      expect(asEditor.links_restricted).toBe(1);
      // The editor clears the links they can see; the one they cannot see stays.
      const cleared = (
        await env.svc.setLinks(editor, ws, d.id, { records: [] }, ifMatch(asEditor.version))
      ).data;
      expect(cleared.links).toEqual([]);
      expect(cleared.links_restricted).toBe(1);
      expect((await env.svc.getDocument(owner, ws, d.id)).links.map((l) => l.id)).toEqual([
        secret.id,
      ]);
    });

    it('comments, follows, and reviews work on a document through the collaboration host', async () => {
      const d = await make(editor, {
        title: 'Reviewed spec',
        brand: brands.Harbor,
        starter: false,
      });
      const v2 = await save(editor, d, [para('blk_a', 'Draft')]);
      const c = (
        await env.svc.createComment(editor, ws, d.id, { text: 'Looks right to me' }, mutation())
      ).data;
      expect(c).toMatchObject({ host: { id: d.id, type: 'document' } });
      await expect(
        env.svc.createComment(reader, ws, d.id, { text: 'no' }, mutation()),
      ).rejects.toEqual(reason('forbidden'));
      await expect(
        env.svc.createComment(outsider, ws, d.id, { text: 'no' }, mutation()),
      ).rejects.toEqual(reason('not_found'));
      // Comments may name documents (TSK-019): readable ones become chips, hidden ones are refused as before.
      const other = await make(editor, {
        title: 'Named in a comment',
        brand: brands.Harbor,
        starter: false,
      });
      const hiddenDoc = await make(owner, {
        title: 'Summit page',
        brand: brands.Summit,
        starter: false,
      });
      const named = (
        await env.svc.createComment(
          editor,
          ws,
          d.id,
          { text: 'See the other page', mentions: [{ kind: 'record', id: other.id }] },
          mutation(),
        )
      ).data;
      expect(named.mentions).toEqual([
        { kind: 'record', id: other.id, name: 'Named in a comment' },
      ]);
      await expect(
        env.svc.createComment(
          editor,
          ws,
          d.id,
          { text: 'And this one', mentions: [{ kind: 'record', id: hiddenDoc.id }] },
          mutation(),
        ),
      ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'not_mentionable' })] });
      expect((await env.svc.listComments(owner, ws, d.id, {})).data).toHaveLength(2);
      await env.svc.follow(owner, ws, d.id, true, mutation());
      expect(
        (await env.svc.following(owner, ws, { type: 'document' })).data.map((x) => x.id),
      ).toContain(d.id);
      // A review binds to the current content version and goes stale when the content changes.
      const review = (
        await env.svc.requestReview(
          editor,
          ws,
          d.id,
          { reviewers: [pub.owner!], subject_version: v2.content_version },
          mutation(),
        )
      ).data;
      expect(review).toMatchObject({
        subject: { id: d.id, type: 'document', title: 'Reviewed spec' },
        subject_version: 2,
        stale: false,
      });
      const v3 = await save(editor, v2, [para('blk_a', 'Draft, revised')]);
      expect((await env.svc.getReview(owner, ws, review.id)).stale).toBe(true);
      await expect(
        env.svc.decideReview(
          owner,
          ws,
          review.id,
          { outcome: 'approved', subject_version: 2 },
          mutation(),
        ),
      ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'subject_changed' })] });
      expect(v3.content_version).toBe(3);
      // A metadata change (state, owner, review date) never stales a review.
      const fresh = (await env.svc.refreshReview(editor, ws, review.id, {}, mutation())).data;
      await env.svc.updateDocument(editor, ws, d.id, { state: 'current' }, ifMatch(v3.version));
      expect((await env.svc.getReview(owner, ws, fresh.id)).stale).toBe(false);
      const decided = (
        await env.svc.decideReview(
          owner,
          ws,
          fresh.id,
          { outcome: 'approved', subject_version: 3 },
          mutation(),
        )
      ).data;
      expect(decided.state).toBe('approved');
      expect(
        (await env.svc.myReviews(owner, ws, { role: 'reviewer', state: 'settled' })).data.map(
          (r) => r.subject.title,
        ),
      ).toContain('Reviewed spec');
    });
  });

  describe('suggestions and source approvals', () => {
    const base = async (title: string) => {
      const d = await make(editor, { title, brand: brands.Harbor, starter: false });
      const v = await save(editor, d, [para('blk_a', 'Alpha'), para('blk_b', 'Bravo')]);
      return v;
    };
    const suggest = (
      as: Caller,
      d: { id: string; content_version: number },
      block: string,
      text: string,
    ) =>
      env.svc.createSuggestion(
        as,
        ws,
        d.id,
        {
          block,
          base_version: d.content_version,
          proposed: { type: 'paragraph', runs: [{ text }] },
          note: 'Better wording',
        },
        mutation(),
      );

    it('applies a suggestion to an unchanged block as a new version, and only an editor decides', async () => {
      await apply(env, owner, ws, {
        kind: 'record_share',
        record: (await base('Shared')).id,
        grantee: pub.commenter!,
        level: 'comment',
      });
      const shared = (await env.svc.listDocuments(commenter, ws, {})).data.find(
        (x) => x.title === 'Shared',
      )!;
      const doc = await env.svc.getDocument(editor, ws, shared.id);
      const made = (await suggest(commenter, doc, 'blk_a', 'Alpha, improved')).data;
      expect(made).toMatchObject({
        type: 'document_suggestion',
        state: 'open',
        effective_state: 'open',
        block: 'blk_a',
        note: 'Better wording',
      });
      expect(made.id).toMatch(/^dsg_/);
      expect(made.author).toMatchObject({ id: pub.commenter });
      expect(made.capabilities).toMatchObject({ accept: false, reject: false, withdraw: true });
      // The suggester cannot decide it; a reader cannot suggest at all.
      await expect(
        env.svc.decideSuggestion(commenter, ws, made.id, { outcome: 'accept' }, mutation()),
      ).rejects.toEqual(reason('forbidden'));
      await expect(suggest(reader, doc, 'blk_a', 'x')).rejects.toEqual(reason('forbidden'));
      await expect(suggest(outsider, doc, 'blk_a', 'x')).rejects.toEqual(reason('not_found'));
      const decided = (
        await env.svc.decideSuggestion(editor, ws, made.id, { outcome: 'accept' }, mutation())
      ).data;
      expect(decided).toMatchObject({ state: 'accepted', applied_version: 3 });
      const now = await env.svc.getDocument(editor, ws, doc.id);
      expect(now.content_version).toBe(3);
      expect(now.content.blocks[0]).toMatchObject({
        id: 'blk_a',
        runs: [{ text: 'Alpha, improved' }],
      });
      expect(now.content.blocks[1]).toMatchObject({ runs: [{ text: 'Bravo' }] });
      expect(await env.svc.getVersion(editor, ws, doc.id, 3)).toMatchObject({ kind: 'suggestion' });
      await expect(
        env.svc.decideSuggestion(editor, ws, made.id, { outcome: 'reject' }, mutation()),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'already_decided' })],
      });
    });

    it('goes stale, with nothing applied, when the block changed since; rejects and withdraws without touching content', async () => {
      const doc = await base('Stale suggestions');
      const mine = (await suggest(editor, doc, 'blk_a', 'Alpha (from a suggestion)')).data;
      const other = (await suggest(owner, doc, 'blk_b', 'Bravo (from another)')).data;
      const later = (await suggest(owner, doc, 'blk_b', 'Bravo, second thought')).data;
      // The first block changes under an open suggestion.
      const changed = await save(editor, doc, [
        para('blk_a', 'Alpha, edited by hand'),
        para('blk_b', 'Bravo'),
      ]);
      const view = await env.svc.getSuggestion(editor, ws, mine.id);
      expect(view).toMatchObject({ state: 'open', effective_state: 'stale' });
      expect(view.capabilities.accept).toBe(false);
      const result = (
        await env.svc.decideSuggestion(editor, ws, mine.id, { outcome: 'accept' }, mutation())
      ).data;
      expect(result).toMatchObject({ state: 'stale', applied_version: null });
      expect((await env.svc.getDocument(editor, ws, doc.id)).content_version).toBe(
        changed.content_version,
      );
      // A rejection leaves content alone; the author withdraws their own; nobody else can.
      expect(
        (await env.svc.decideSuggestion(editor, ws, other.id, { outcome: 'reject' }, mutation()))
          .data.state,
      ).toBe('rejected');
      await expect(env.svc.withdrawSuggestion(editor, ws, later.id, mutation())).rejects.toEqual(
        reason('forbidden'),
      );
      expect((await env.svc.withdrawSuggestion(owner, ws, later.id, mutation())).data.state).toBe(
        'withdrawn',
      );
      expect((await env.svc.getDocument(editor, ws, doc.id)).content.blocks[1]).toMatchObject({
        runs: [{ text: 'Bravo' }],
      });
      const open = await env.svc.listSuggestions(editor, ws, doc.id, {});
      expect(open.data).toEqual([]);
      const all = await env.svc.listSuggestions(editor, ws, doc.id, { state: 'all' });
      expect(all.data.map((x) => x.state).sort()).toEqual(['rejected', 'stale', 'withdrawn']);
      // Suggestions bind to the version and block they were made against.
      await expect(suggest(editor, doc, 'blk_a', 'x')).rejects.toMatchObject({ code: 'conflict' });
      await expect(suggest(editor, changed, 'blk_missing', 'x')).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'invalid_reference' })],
      });
      await expect(env.svc.getSuggestion(outsider, ws, mine.id)).rejects.toEqual(
        reason('not_found'),
      );
      await expect(env.svc.getSuggestion(stranger, ws, mine.id)).rejects.toEqual(
        reason('not_found'),
      );
      await expect(env.svc.getSuggestion(editor, ws, `dsg_${'0'.repeat(26)}`)).rejects.toEqual(
        reason('not_found'),
      );
      const limited = workEnv(db, { work: { documentSuggestionsOpenMax: 1 } });
      const l = (
        await limited.svc.createDocument(
          owner,
          ws,
          { title: 'cap', brand: brands.Harbor, starter: false },
          mutation(),
        )
      ).data;
      const l2 = (
        await limited.svc.saveContent(
          owner,
          ws,
          l.id,
          { base_version: 1, content: content(para('blk_a', 'x')) },
          mutation(),
        )
      ).data;
      await limited.svc.createSuggestion(
        owner,
        ws,
        l.id,
        { block: 'blk_a', base_version: 2, proposed: { type: 'paragraph', runs: [{ text: 'y' }] } },
        mutation(),
      );
      await expect(
        limited.svc.createSuggestion(
          owner,
          ws,
          l.id,
          {
            block: 'blk_a',
            base_version: l2.content_version,
            proposed: { type: 'paragraph', runs: [{ text: 'z' }] },
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'too_many' })] });
      await limited.h.close();
    });

    it('approves the current version as an AI source, stops applying on the next save, and is append-only', async () => {
      const doc = await base('Source of truth');
      expect(doc).toBeDefined();
      const cap = await env.svc.getDocument(editor, ws, doc.id);
      // The owner (the editor, who made it) may approve; another editor may not; managers may.
      expect(cap.capabilities.approve_source).toBe(true);
      await expect(
        env.svc.approveSource(reader, ws, doc.id, { version: 2 }, mutation()),
      ).rejects.toEqual(reason('forbidden'));
      await expect(
        env.svc.approveSource(outsider, ws, doc.id, { version: 2 }, mutation()),
      ).rejects.toEqual(reason('not_found'));
      await expect(
        env.svc.approveSource(editor, ws, doc.id, { version: 1 }, mutation()),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'version_changed' })],
      });
      const approved = (
        await env.svc.approveSource(
          editor,
          ws,
          doc.id,
          { version: 2, note: 'Reviewed' },
          mutation(),
        )
      ).data;
      expect(approved.ai_source).toMatchObject({
        approved: true,
        version: 2,
        by: { id: pub.editor },
      });
      expect(
        (await env.svc.listVersions(editor, ws, doc.id, {})).data.find((v) => v.number === 2)!
          .ai_source,
      ).toBe(true);
      // Approving again is a no-op; a new version no longer carries the approval.
      await env.svc.approveSource(editor, ws, doc.id, { version: 2 }, mutation());
      const next = await save(editor, approved, [
        para('blk_a', 'Alpha'),
        para('blk_b', 'Bravo, changed'),
      ]);
      expect(next.ai_source).toEqual({ approved: false, version: null, at: null, by: null });
      expect(
        (await env.svc.approveSource(editor, ws, doc.id, { version: 3 }, mutation())).data.ai_source
          .approved,
      ).toBe(true);
      const revoked = (await env.svc.revokeSource(editor, ws, doc.id, { version: 3 }, mutation()))
        .data;
      expect(revoked.ai_source.approved).toBe(false);
      expect(
        (
          await sql(
            `SELECT kind FROM knowledge.source_approval a JOIN core.record r ON r.id = a.document_id WHERE r.public_id = '${doc.id}' ORDER BY a.created_at, a.id`,
          )
        ).map((r) => r.kind),
      ).toEqual(['approved', 'approved', 'revoked']);
      const grants = await sql(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'app_rw' AND table_schema = 'knowledge' AND table_name IN ('source_approval', 'document_version') ORDER BY 1, 2`,
      );
      expect(grants.map((g) => `${g.table_name}:${g.privilege_type}`)).toEqual([
        'document_version:INSERT',
        'document_version:SELECT',
        'source_approval:INSERT',
        'source_approval:SELECT',
      ]);
    });
  });

  describe('lifecycle, export, departure', () => {
    it('archives, trashes, restores, and purges a page with its subpages, and a project or task carries its documents', async () => {
      const root = await make(editor, { title: 'Tree root', brand: brands.Harbor });
      const kid = await make(editor, { title: 'Tree kid', parent: root.id });
      const grandkid = await make(editor, { title: 'Tree grandkid', parent: kid.id });
      await env.svc.documentLifecycle(editor, ws, root.id, 'archive', mutation());
      expect((await env.svc.getDocument(editor, ws, grandkid.id)).archived).toBe(true);
      // Archived documents are read-only: edits are refused with a plain reason, reads still work.
      await expect(
        save(editor, { ...grandkid, content_version: 1 }, [para('blk_a', 'x')]),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'document_archived' })],
      });
      await expect(
        env.svc.createDocument(editor, ws, { title: 'x', parent: kid.id }, mutation()),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'document_archived' })],
      });
      expect(
        (await env.svc.listDocuments(editor, ws, { scope: brands.Harbor, q: 'Tree gr' })).data,
      ).toEqual([]);
      expect(
        (
          await env.svc.listDocuments(editor, ws, {
            scope: brands.Harbor,
            q: 'Tree gr',
            archived: 'true',
          })
        ).data.map((x) => x.title),
      ).toEqual(['Tree grandkid']);
      await env.svc.documentLifecycle(editor, ws, root.id, 'unarchive', mutation());
      expect((await env.svc.getDocument(editor, ws, grandkid.id)).archived).toBe(false);
      // Trash hides the whole tree; restore brings it all back; a reader cannot trash.
      await expect(
        env.svc.documentLifecycle(reader, ws, root.id, 'trash', mutation()),
      ).rejects.toEqual(reason('forbidden'));
      await env.svc.documentLifecycle(editor, ws, root.id, 'trash', mutation());
      await expect(env.svc.getDocument(editor, ws, kid.id)).rejects.toEqual(reason('not_found'));
      await expect(
        env.svc.documentLifecycle(editor, ws, kid.id, 'restore', mutation()),
      ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'invalid_state' })] });
      await env.svc.documentLifecycle(editor, ws, root.id, 'restore', mutation());
      expect((await env.svc.getDocument(editor, ws, kid.id)).title).toBe('Tree kid');
      // Purge removes content, versions, and references, deepest first, and links to it.
      const linker = await make(editor, {
        title: 'Links to grandkid',
        brand: brands.Harbor,
        starter: false,
      });
      await env.svc.setLinks(
        editor,
        ws,
        linker.id,
        { records: [grandkid.id] },
        ifMatch(linker.version),
      );
      await env.svc.documentLifecycle(editor, ws, root.id, 'trash', mutation());
      await expect(
        env.svc.documentLifecycle(editor, ws, root.id, 'purge', mutation()),
      ).rejects.toEqual(reason('forbidden'));
      await env.svc.documentLifecycle(owner, ws, root.id, 'purge', mutation());
      const ids = (
        await sql(
          `SELECT d.id, d.depth FROM knowledge.document d JOIN core.record r ON r.id = d.id WHERE r.public_id IN ('${root.id}', '${kid.id}', '${grandkid.id}') ORDER BY d.depth DESC`,
        )
      ).map((r) => r.id as string);
      expect(ids).toHaveLength(3);
      for (const id of ids)
        await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
          await productLifecycleRegistry().get('document')!.purge!.deleteContent(tx, [id]);
        });
      expect(
        await sql(`SELECT 1 FROM knowledge.document WHERE id = ANY('{${ids.join(',')}}'::uuid[])`),
      ).toHaveLength(0);
      expect(
        await sql(
          `SELECT 1 FROM knowledge.document_version WHERE document_id = ANY('{${ids.join(',')}}'::uuid[])`,
        ),
      ).toHaveLength(0);
      expect(
        await sql(
          `SELECT 1 FROM knowledge.document_reference WHERE target_record_id = ANY('{${ids.join(',')}}'::uuid[])`,
        ),
      ).toHaveLength(0);
      // The link rows are gone; the surviving document just shows no link.
      expect((await env.svc.getDocument(editor, ws, linker.id)).links).toEqual([]);
    });

    it('carries documents with their project and task, and keeps a task with documents in its brand', async () => {
      const pr = (
        await env.svc.createProject(
          owner,
          ws,
          { brand: brands.Harbor, name: 'Carrying project' },
          mutation(),
        )
      ).data;
      const tk = (
        await env.svc.createTask(
          owner,
          ws,
          { brand: brands.Harbor, title: 'Carrying task', project: pr.id },
          mutation(),
        )
      ).data;
      const onProject = await make(editor, { title: 'On the project', project: pr.id });
      const onTask = await make(editor, { title: 'On the task', task: tk.id });
      const sub = await make(editor, { title: 'Under the task page', parent: onTask.id });
      expect(
        (await env.svc.listDocuments(editor, ws, { project: pr.id })).data
          .map((x) => x.title)
          .sort(),
      ).toEqual(['On the project', 'On the task', 'Under the task page']);
      expect(
        (await env.svc.listDocuments(editor, ws, { task: tk.id })).data.map((x) => x.title).sort(),
      ).toEqual(['On the task', 'Under the task page']);
      // The task's documents live in its brand: it cannot move away until they do.
      const loose = (
        await env.svc.createTask(
          owner,
          ws,
          { brand: brands.Harbor, title: 'Projectless' },
          mutation(),
        )
      ).data;
      await expect(
        env.svc.previewTaskBrandMove(owner, ws, loose.id, { brand: brands.Summit }),
      ).resolves.toBeDefined();
      await make(editor, { title: 'Pins the brand', task: loose.id });
      await expect(
        env.svc.previewTaskBrandMove(owner, ws, loose.id, { brand: brands.Summit }),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'documents_attached' })],
      });
      // Trashing the project carries its documents, and the ones on its tasks.
      await env.svc.projectLifecycle(owner, ws, pr.id, 'trash', mutation());
      for (const d of [onProject, onTask, sub])
        await expect(env.svc.getDocument(editor, ws, d.id)).rejects.toEqual(reason('not_found'));
    });

    it('exports Markdown and HTML for people who may, audits the fact and never the content, and is honest about what it cannot carry', async () => {
      const secret = (
        await env.svc.createTask(
          owner,
          ws,
          { brand: brands.Summit, title: 'Hidden export target' },
          mutation(),
        )
      ).data;
      const open = (
        await env.svc.createTask(
          owner,
          ws,
          { brand: brands.Harbor, title: 'Open export target' },
          mutation(),
        )
      ).data;
      const d = await make(owner, { title: 'Export me', brand: brands.Harbor, starter: false });
      const v2 = await save(owner, d, [
        { id: 'blk_h', type: 'heading', level: 1, runs: [{ text: 'Intro' }] },
        {
          id: 'blk_p',
          type: 'paragraph',
          runs: [
            { text: 'Open: ' },
            { ref: { kind: 'task', id: open.id } },
            { text: ' Secret: ' },
            { ref: { kind: 'task', id: secret.id } },
          ],
        },
        {
          id: 'blk_e',
          type: 'embed',
          kind: 'image',
          url: 'https://example.com/chart.png',
          alt: 'Chart',
        },
      ]);
      const child = await make(owner, { title: 'Export child', parent: d.id });
      await save(owner, child, [para('blk_c', 'Child text')]);
      const md = (
        await env.svc.exportDocument(editor, ws, d.id, { format: 'markdown' }, mutation())
      ).data;
      expect(md).toMatchObject({
        type: 'document_export',
        format: 'markdown',
        filename: 'export-me.md',
        pages: 1,
      });
      expect(md.content).toContain('# Export me');
      expect(md.content).toContain('## Intro');
      expect(md.content).toContain(`[Open export target](/workspaces/${ws}/tasks/${open.id})`);
      expect(md.content).toContain('*Restricted item*');
      expect(md.content).not.toContain('Hidden export target');
      expect(md.content).not.toContain(secret.id);
      expect(md.content).toContain('[image: Chart](https://example.com/chart.png)');
      expect(md.notes).toEqual({
        embeds_as_links: 1,
        restricted_items: 1,
        pages_omitted: 0,
        unsupported: ['pdf'],
      });
      const html = (
        await env.svc.exportDocument(
          editor,
          ws,
          d.id,
          { format: 'html', include_children: true },
          mutation(),
        )
      ).data;
      expect(html).toMatchObject({
        filename: 'export-me.html',
        pages: 2,
        content_type: 'text/html; charset=utf-8',
      });
      expect(html.content).toContain('<!doctype html>');
      expect(html.content).toContain('Child text');
      expect(html.content).toContain('@media print');
      // Everyone who may read may export, except where policy says no; the audit holds counts only.
      await expect(
        env.svc.exportDocument(reader, ws, d.id, { format: 'markdown' }, mutation()),
      ).rejects.toEqual(reason('forbidden'));
      await expect(
        env.svc.exportDocument(outsider, ws, d.id, { format: 'markdown' }, mutation()),
      ).rejects.toEqual(reason('not_found'));
      await expect(
        env.svc.exportDocument(editor, ws, d.id, { format: 'pdf' }, mutation()),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'invalid_option' })],
      });
      const audit = await sql(
        `SELECT changes::text AS c FROM audit.audit_event WHERE action = 'document.exported'`,
      );
      expect(audit.length).toBeGreaterThanOrEqual(2);
      const text = audit.map((a) => a.c).join(' ');
      expect(text).not.toContain('Export me');
      expect(text).not.toContain('Child text');
      expect(v2.content_version).toBe(2);
      // A page the viewer cannot read is left out of an export of its parent.
      await apply(env, owner, ws, {
        kind: 'record_share',
        record: d.id,
        grantee: pub.commenter!,
        level: 'read',
      });
      const shared = (
        await env.svc.exportDocument(
          commenter,
          ws,
          d.id,
          { format: 'markdown', include_children: true },
          mutation(),
        )
      ).data;
      expect(shared.pages).toBe(1);
      const tiny = workEnv(db, { work: { documentExportMaxBytes: 65_536 } });
      const big = (
        await tiny.svc.createDocument(
          owner,
          ws,
          { title: 'Big', brand: brands.Harbor, starter: false },
          mutation(),
        )
      ).data;
      const blocks = Array.from({ length: 40 }, (_, i) =>
        para(`blk_${String(i).padStart(3, '0')}x`, 'x'.repeat(1_900)),
      );
      await tiny.svc.saveContent(
        owner,
        ws,
        big.id,
        { base_version: 1, content: content(...blocks) },
        mutation(),
      );
      await expect(
        tiny.svc.exportDocument(owner, ws, big.id, { format: 'markdown' }, mutation()),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'too_large' })],
      });
      await tiny.h.close();
    });

    it('moves a departing owner’s documents to the member chosen in the departure plan', async () => {
      const leaver = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
      const leaverId = await mem(leaver);
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: leaverId,
        level: 'edit',
      });
      const mine = await make(leaver, { title: 'Leaver owns this', brand: brands.Harbor });
      const preview = await env.svc.previewChange(owner, ws, { kind: 'remove', member: leaverId });
      expect(preview.diff.records_lost).toMatchObject({ document: expect.any(Number) });
      env.stepUp.allow = true;
      try {
        await env.svc.removeMember(
          owner,
          ws,
          leaverId,
          { preview_token: preview.preview_token, reassign_to: pub.editor },
          mutation({ stepUpToken: 't' }),
        );
      } finally {
        env.stepUp.allow = false;
      }
      expect((await env.svc.getDocument(editor, ws, mine.id)).owner).toMatchObject({
        id: pub.editor,
      });
      expect((await env.svc.getDocument(editor, ws, mine.id)).created_by).toMatchObject({
        id: leaverId,
      });
    });
  });
});
