import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPublicId, newUuidV7, richTextFromPlain } from '@pm/contracts';
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
const v = (n: number) => mutation({ ifMatch: `"${n}"` });

/**
 * Phase 2B tasks on real PostgreSQL (0B ADR-22): scope and brand invariants, the subtask tree,
 * fields and dates, completion gates and overrides, checklists, criteria (own and inherited),
 * labels, links, relationships, moves (same brand and cross-brand), lifecycle, duplication,
 * assignment, history, and the project rollups.
 */
describe('tasks (2B)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;

  const task = (body: Record<string, unknown>, as: Caller = owner) =>
    env.svc.createTask(as, ws, body, mutation()).then((r) => r.data);
  const project = (body: Record<string, unknown>) =>
    env.svc.createProject(owner, ws, body, mutation()).then((r) => r.data);
  const detail = (id: string, as: Caller = owner) => env.svc.taskDetail(as, ws, id);

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('brand is mandatory, project optional; containers share brand and project identity', async () => {
    const free = await task({ brand: brands.Harbor, title: 'Projectless' });
    expect(free).toMatchObject({
      type: 'task',
      status: { key: 'todo', category: 'planned' },
      project: null,
      depth: 0,
      priority: 'none',
    });
    await expect(task({ title: 'No brand' })).rejects.toEqual(issueOf('brand_required'));
    const prj = await project({ brand: brands.Harbor, name: 'Site' });
    const inProject = await task({ project: prj.id, title: 'In project' });
    expect(inProject.project).toEqual({ id: prj.id, name: 'Site' });
    // The brand of a project task is the project's; another brand is refused.
    await expect(task({ project: prj.id, brand: brands.Summit, title: 'x' })).rejects.toEqual(
      issueOf('cross_brand_container'),
    );
    // A subtask inherits project identity; a mismatched project is refused; both projectless is fine.
    const sub = await task({ parent: inProject.id, title: 'Sub' });
    expect(sub).toMatchObject({ depth: 1, project: { id: prj.id }, parent: { id: inProject.id } });
    await expect(task({ parent: free.id, project: prj.id, title: 'x' })).rejects.toEqual(
      issueOf('parent_project_mismatch'),
    );
    expect(await task({ parent: free.id, title: 'Free sub' })).toMatchObject({
      depth: 1,
      project: null,
    });
    // The database refuses a parent of another project or brand, whoever writes it.
    await expect(
      db.admin(
        `UPDATE work.task SET project_id = NULL WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [sub.id],
      ),
    ).rejects.toThrow(/ancestry/);
    await expect(
      db.admin(
        `UPDATE core.record SET brand_id = (SELECT id FROM core.record WHERE public_id = $2), version = version + 1 WHERE public_id = $1`,
        [prj.id, brands.Summit],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('depth is bounded by TASK_DEPTH_MAX (root = 0) and the database ceiling is 64', async () => {
    let parent = (await task({ brand: brands.Summit, title: 'L0' })).id;
    for (let i = 1; i <= 20; i++) parent = (await task({ parent, title: `L${i}` })).id;
    await expect(task({ parent, title: 'Too deep' })).rejects.toEqual(issueOf('depth_exceeded'));
    await expect(db.admin(`UPDATE work.task SET depth = 65 WHERE false`)).resolves.toBeDefined();
    const c = await db.admin(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'task_depth_ceiling'`,
    );
    expect(c.rows[0].d).toContain('64');
  });

  it('fields: dates, deadline as date or instant, estimates, deliverable; done only through Complete', async () => {
    const t = await task({
      brand: brands.Harbor,
      title: 'Fields',
      description: richTextFromPlain('Write the copy'),
      priority: 'high',
      start_date: '2026-11-02',
      due_date: '2026-11-09',
      deadline: { at: '2026-11-12T17:00:00Z', tz: 'Europe/Lisbon' },
      estimate_minutes: 240,
      remaining_estimate_minutes: 300,
      expected_deliverable_type: 'pull_request',
      expected_deliverable_detail: 'The landing page PR',
      requires_acceptance: true,
    });
    expect(t).toMatchObject({
      deadline: { at: '2026-11-12T17:00:00.000Z', tz: 'Europe/Lisbon' },
      estimate_minutes: 240,
      // Remaining may exceed the original estimate after re-estimation (ADR-22).
      remaining_estimate_minutes: 300,
      expected_deliverable: {
        type: 'pull_request',
        detail: 'The landing page PR',
        requires_acceptance: true,
      },
      scheduled: { available: false },
    });
    const bad = (body: Record<string, unknown>) =>
      task({ brand: brands.Harbor, title: 'x', ...body });
    await expect(bad({ due_date: '2026-11-01', start_date: '2026-11-02' })).rejects.toEqual(
      issueOf('date_order'),
    );
    await expect(
      bad({ deadline: { date: '2026-11-01', at: '2026-11-01T00:00:00Z' } }),
    ).rejects.toEqual(issueOf('invalid_type'));
    await expect(
      bad({ deadline: { at: '2026-11-01T00:00:00Z', tz: 'Mars/Base' } }),
    ).rejects.toEqual(issueOf('invalid_timezone'));
    await expect(bad({ estimate_minutes: 100_001 })).rejects.toEqual(issueOf('invalid_number'));
    await expect(bad({ expected_deliverable_type: 'video' })).rejects.toEqual(
      issueOf('invalid_option'),
    );
    // Field merge: the deadline changes only when edited, to a date this time.
    const u = await env.svc.updateTask(
      owner,
      ws,
      t.id,
      {
        version: t.version,
        changes: {
          deadline: { base: t.deadline, value: { date: '2026-11-13' } },
          status: { base: 'todo', value: 'in_progress' },
        },
      },
      v(t.version),
    );
    expect(u.data).toMatchObject({
      deadline: { date: '2026-11-13' },
      status: { key: 'in_progress' },
    });
    await expect(
      env.svc.updateTask(
        owner,
        ws,
        t.id,
        { version: u.data.version, changes: { status: { base: 'in_progress', value: 'done' } } },
        v(u.data.version),
      ),
    ).rejects.toEqual(issueOf('use_complete'));
    // The database keeps the deadline shape whoever writes it.
    await expect(
      db.admin(
        `UPDATE work.task SET deadline_at = now(), deadline_tz = 'UTC' WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [t.id],
      ),
    ).rejects.toThrow(/task_deadline_shape/);
  });

  it('completion gates: required criteria and inherited project definition of done; override needs a reason', async () => {
    const prj = await project({ brand: brands.Harbor, name: 'Gated' });
    await env.svc.addItem(
      owner,
      ws,
      prj.id,
      'criteria',
      { kind: 'definition_of_done', text: 'Reviewed' },
      mutation(),
    );
    const t = await task({ project: prj.id, title: 'Gated task' });
    await env.svc.addTaskCriterion(
      owner,
      ws,
      t.id,
      { kind: 'acceptance', text: 'Copy approved' },
      mutation(),
    );
    await env.svc.addTaskCriterion(
      owner,
      ws,
      t.id,
      { kind: 'acceptance', text: 'Nice to have', required: false },
      mutation(),
    );
    let d = await detail(t.id);
    expect(d.criteria.map((c) => [c.text, c.required, c.met])).toEqual([
      ['Copy approved', true, false],
      ['Nice to have', false, false],
    ]);
    // Inherited items are evaluated from the project, never copied.
    expect(d.inherited_criteria).toEqual([
      expect.objectContaining({ text: 'Reviewed', state: 'open' }),
    ]);
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM work.criteria_item WHERE task_id = (SELECT id FROM core.record WHERE public_id = $1)`,
          [t.id],
        )
      ).rows[0].n,
    ).toBe(2);
    await expect(env.svc.completeTask(owner, ws, t.id, {}, mutation())).rejects.toEqual(
      issueOf('criteria_incomplete'),
    );
    const [req] = d.criteria;
    await env.svc.updateTaskCriterion(owner, ws, t.id, req!.id, { met: true }, v(req!.version));
    await env.svc.setInheritedCriterion(
      owner,
      ws,
      t.id,
      d.inherited_criteria[0]!.id,
      { state: 'dismissed' },
      mutation(),
    );
    d = await detail(t.id);
    expect(d.inherited_criteria[0]!.state).toBe('dismissed');
    const done = await env.svc.completeTask(owner, ws, t.id, {}, mutation());
    expect(done.data).toMatchObject({
      status: { key: 'done', category: 'done' },
      completion_override: null,
    });
    expect(done.data.completed_at).toEqual(expect.any(String));
    // Reopen returns to the prior non-terminal status; a deadline is never rewritten.
    const back = await env.svc.reopenTask(owner, ws, t.id, mutation());
    expect(back.data.status.key).toBe('todo');
    // Override: the reason is required and audited as a hash with the visible counts.
    const t2 = await task({ project: prj.id, title: 'Override me' });
    const o = await env.svc.completeTask(
      owner,
      ws,
      t2.id,
      { override_reason: 'Shipped under exception' },
      mutation(),
    );
    expect(o.data.completion_override).toEqual({ reason: 'Shipped under exception' });
    const audit = await db.admin(
      `SELECT changes::text AS c FROM audit.audit_event WHERE target_public_id = $1 AND action = 'task.completed'`,
      [t2.id],
    );
    expect(audit.rows[0].c).not.toContain('Shipped under exception');
    expect(audit.rows[0].c).toContain('unmet_criteria');
  });

  it('a parent with incomplete subtasks needs a confirmed override; completing never cascades', async () => {
    const parent = await task({ brand: brands.Summit, title: 'Parent' });
    const child = await task({ parent: parent.id, title: 'Child' });
    await expect(env.svc.completeTask(owner, ws, parent.id, {}, mutation())).rejects.toEqual(
      issueOf('incomplete_subtasks'),
    );
    await expect(
      env.svc.completeTask(owner, ws, parent.id, { confirm_incomplete_subtasks: true }, mutation()),
    ).rejects.toEqual(issueOf('incomplete_subtasks'));
    await env.svc.completeTask(
      owner,
      ws,
      parent.id,
      { confirm_incomplete_subtasks: true, override_reason: 'Child moves to next sprint' },
      mutation(),
    );
    expect((await env.svc.getTask(owner, ws, child.id)).status.key).toBe('todo');
    // Completing a child updates the parent's progress, never its status.
    const p2 = await task({ brand: brands.Summit, title: 'P2' });
    const c2 = await task({ parent: p2.id, title: 'C2' });
    await env.svc.completeTask(owner, ws, c2.id, {}, mutation());
    expect(await env.svc.getTask(owner, ws, p2.id)).toMatchObject({
      status: { key: 'todo' },
      progress: { done: 1, total: 1 },
    });
  });

  it('checklists are ordered reversible facts that never change task status', async () => {
    const t = await task({ brand: brands.Harbor, title: 'Checklist' });
    const a = (await env.svc.addChecklistItem(owner, ws, t.id, { text: 'First' }, mutation())).data;
    const b = (await env.svc.addChecklistItem(owner, ws, t.id, { text: 'Second' }, mutation()))
      .data;
    await env.svc.moveTaskItem(owner, ws, t.id, 'checklist', b.id, { after: null }, mutation());
    let d = await detail(t.id);
    expect(d.checklist.map((c) => c.text)).toEqual(['Second', 'First']);
    const first = d.checklist.find((c) => c.id === a.id)!;
    await env.svc.updateChecklistItem(owner, ws, t.id, a.id, { done: true }, v(first.version));
    d = await detail(t.id);
    expect(d.checklist.find((c) => c.id === a.id)!.done).toBe(true);
    expect(d.task.status.key).toBe('todo');
    await env.svc.updateChecklistItem(owner, ws, t.id, a.id, { done: false }, v(first.version + 1));
    await expect(
      env.svc.updateChecklistItem(owner, ws, t.id, a.id, { done: true }, v(first.version)),
    ).rejects.toEqual(reason('conflict'));
    await env.svc.removeTaskItem(owner, ws, t.id, 'checklist', b.id, mutation());
    expect((await detail(t.id)).checklist).toHaveLength(1);
    const actions = (
      await db.admin(
        `SELECT action FROM audit.audit_event WHERE target_public_id = $1 ORDER BY chain_seq`,
        [t.id],
      )
    ).rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'checklist.added',
        'checklist.moved',
        'checklist.updated',
        'checklist.removed',
      ]),
    );
  });

  it('labels: one brand each, normalized unique names, archived stay on tasks; never authority', async () => {
    const l = (
      await env.svc.createLabel(
        owner,
        ws,
        brands.Harbor,
        { name: 'Bug  Fix', color: '#dc2626' },
        mutation(),
      )
    ).data;
    expect(l).toMatchObject({ name: 'Bug Fix', archived: false });
    await expect(
      env.svc.createLabel(owner, ws, brands.Harbor, { name: 'bug fix' }, mutation()),
    ).rejects.toEqual(issueOf('duplicate'));
    // The same name may exist in another brand (labels are brand-scoped).
    const other = (
      await env.svc.createLabel(owner, ws, brands.Summit, { name: 'Bug Fix' }, mutation())
    ).data;
    const t = await task({ brand: brands.Harbor, title: 'Labeled' });
    await env.svc.addTaskLabel(owner, ws, t.id, { label: l.id }, mutation());
    await expect(
      env.svc.addTaskLabel(owner, ws, t.id, { label: other.id }, mutation()),
    ).rejects.toEqual(issueOf('invalid_reference'));
    await env.svc.updateLabel(owner, ws, l.id, { name: 'Defect', state: 'archived' }, v(l.version));
    expect((await env.svc.getTask(owner, ws, t.id)).labels).toEqual([
      expect.objectContaining({ id: l.id, name: 'Defect', archived: true }),
    ]);
    expect((await env.svc.listLabels(owner, ws, brands.Harbor)).map((x) => x.id)).not.toContain(
      l.id,
    );
    const t2 = await task({ brand: brands.Harbor, title: 'x' });
    await expect(
      env.svc.addTaskLabel(owner, ws, t2.id, { label: l.id }, mutation()),
    ).rejects.toEqual(issueOf('label_archived'));
    await expect(
      db.admin(
        `INSERT INTO work.task_label (workspace_id, brand_id, task_id, label_id) SELECT t.workspace_id, t.brand_id, t.id, l.id FROM work.task t, work.label l WHERE t.id = (SELECT id FROM core.record WHERE public_id = $1) AND l.public_id = $2`,
        [t2.id, other.id],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('links: https only, normalized; record targets only for registered readable types', async () => {
    const t = await task({ brand: brands.Harbor, title: 'Links' });
    const link = (body: Record<string, unknown>) =>
      env.svc.addLink(owner, ws, t.id, body, mutation());
    await link({ url: 'https://Example.COM:443/spec?x=1', title: 'Spec' });
    for (const url of [
      'http://example.com',
      'javascript:alert(1)',
      'https://user:pw@example.com',
      'not a url',
    ])
      await expect(link({ url })).rejects.toEqual(
        expect.objectContaining({ code: 'validation_failed' }),
      );
    // Unregistered record types (a project) and unknown records are one refusal.
    const prj = await project({ brand: brands.Harbor, name: 'Not linkable' });
    await expect(link({ record: prj.id })).rejects.toEqual(issueOf('invalid_reference'));
    await expect(link({ record: newPublicId('doc') })).rejects.toEqual(
      issueOf('invalid_reference'),
    );
    // The registered adapter path works for the test-only fixture type.
    await db.admin(
      `INSERT INTO core.record_type (record_type, public_id_prefix, owner_module, test_only) VALUES ('foundation_fixture', 'fxt', 'fixture', true) ON CONFLICT DO NOTHING`,
    );
    const fx = newPublicId('fxt' as never);
    await db.admin(
      `INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type) VALUES ($1, $2, 'foundation_fixture', $3, (SELECT id FROM core.record WHERE public_id = $4), 'system', 'system')`,
      [newUuidV7(), fx, wsId, brands.Harbor],
    );
    await link({ record: fx });
    const d = await detail(t.id);
    expect(d.links).toEqual([
      expect.objectContaining({ kind: 'url', url: 'https://example.com/spec?x=1', title: 'Spec' }),
      expect.objectContaining({ kind: 'record', record: { id: fx, type: 'foundation_fixture' } }),
    ]);
    await expect(
      db.admin(
        `INSERT INTO relations.record_link (id, public_id, workspace_id, source_record_id, target_kind, url, rank) SELECT $1, $2, workspace_id, id, 'url', 'http://x.test', 'a' FROM core.record WHERE public_id = $3`,
        [newUuidV7(), newPublicId('lnk'), t.id],
      ),
    ).rejects.toThrow(/record_link_target_shape/);
  });

  it('relationships: one blocks family (blocked by is its inverse), related stored once, no cycles', async () => {
    const a = await task({ brand: brands.Harbor, title: 'A' });
    const b = await task({ brand: brands.Harbor, title: 'B' });
    const c = await task({ brand: brands.Summit, title: 'C cross-brand' });
    await env.svc.addRelationship(owner, ws, a.id, { kind: 'blocks', target: b.id }, mutation());
    await env.svc.addRelationship(
      owner,
      ws,
      c.id,
      { kind: 'blocked_by', target: b.id },
      mutation(),
    );
    await expect(
      env.svc.addRelationship(owner, ws, c.id, { kind: 'blocks', target: a.id }, mutation()),
    ).rejects.toEqual(issueOf('cycle'));
    await expect(
      env.svc.addRelationship(owner, ws, a.id, { kind: 'blocks', target: a.id }, mutation()),
    ).rejects.toEqual(issueOf('cycle'));
    await expect(
      env.svc.addRelationship(owner, ws, b.id, { kind: 'blocked_by', target: a.id }, mutation()),
    ).rejects.toEqual(issueOf('duplicate'));
    await env.svc.addRelationship(owner, ws, b.id, { kind: 'related', target: a.id }, mutation());
    await expect(
      env.svc.addRelationship(owner, ws, a.id, { kind: 'related', target: b.id }, mutation()),
    ).rejects.toEqual(issueOf('duplicate'));
    const d = await detail(b.id);
    expect(d.relationships.blocked_by.map((x) => x.id)).toEqual([a.id]);
    expect(d.relationships.blocks.map((x) => x.id)).toEqual([c.id]);
    expect(d.relationships.related.map((x) => x.id)).toEqual([a.id]);
    await env.svc.removeRelationship(owner, ws, a.id, 'related', b.id, mutation());
    await env.svc.removeRelationship(owner, ws, b.id, 'blocked_by', a.id, mutation());
    expect((await detail(b.id)).relationships).toMatchObject({ blocked_by: [], related: [] });
  });

  it('moves: reorder, reparent, project change rewrites the subtree; cycles and stale ancestry refused', async () => {
    const prj = await project({ brand: brands.Summit, name: 'Moves' });
    const prj2 = await project({ brand: brands.Summit, name: 'Moves 2' });
    await env.svc.addItem(
      owner,
      ws,
      prj.id,
      'criteria',
      { kind: 'definition_of_done', text: 'Done-done' },
      mutation(),
    );
    const a = await task({ project: prj.id, title: 'a' });
    const b = await task({ project: prj.id, title: 'b' });
    const a1 = await task({ parent: a.id, title: 'a1' });
    const a11 = await task({ parent: a1.id, title: 'a11' });
    const inh = (await detail(a11.id)).inherited_criteria[0]!;
    await env.svc.setInheritedCriterion(owner, ws, a11.id, inh.id, { state: 'met' }, mutation());
    // Reorder: b first.
    await env.svc.moveTask(owner, ws, b.id, { after: null }, mutation());
    const roots = await env.svc.listTasks(owner, ws, { project: prj.id, parent: 'root' });
    expect(roots.data.map((t) => t.title)).toEqual(['b', 'a']);
    expect(roots.total.value).toBe(2);
    await expect(env.svc.moveTask(owner, ws, a.id, { parent: a11.id }, mutation())).rejects.toEqual(
      issueOf('cycle'),
    );
    // Move a (with a1, a11) into project 2: the whole subtree changes project; inherited facts clear.
    await env.svc.moveTask(owner, ws, a.id, { project: prj2.id }, mutation());
    const moved = await env.svc.getTask(owner, ws, a11.id);
    expect(moved).toMatchObject({ project: { id: prj2.id }, depth: 2 });
    expect((await detail(a11.id)).inherited_criteria).toEqual([]);
    // Reparent a1 to the root of project 2.
    await env.svc.moveTask(owner, ws, a1.id, { parent: null }, mutation());
    expect(await env.svc.getTask(owner, ws, a11.id)).toMatchObject({
      depth: 1,
      ancestors: [{ id: a1.id }],
    });
    // Same-brand only: another brand's project is refused here (cross-brand is its own command).
    const harborPrj = await project({ brand: brands.Harbor, name: 'Other brand' });
    await expect(
      env.svc.moveTask(owner, ws, a.id, { project: harborPrj.id }, mutation()),
    ).rejects.toEqual(issueOf('cross_brand_move'));
  });

  it('concurrent opposing reparents serialize: exactly one commits, ancestry stays consistent', async () => {
    for (let round = 0; round < 3; round++) {
      const x = await task({ brand: brands.Harbor, title: `X${round}` });
      const y = await task({ brand: brands.Harbor, title: `Y${round}` });
      const out = await Promise.allSettled([
        env.svc.moveTask(owner, ws, x.id, { parent: y.id }, mutation()),
        env.svc.moveTask(owner, ws, y.id, { parent: x.id }, mutation()),
      ]);
      expect(out.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    }
    const bad = await db.admin(
      `SELECT id FROM work.task WHERE id = ANY(ancestor_ids) OR depth <> cardinality(ancestor_ids)`,
    );
    expect(bad.rows).toEqual([]);
  });

  it('cross-brand move: manage in both brands, preview then atomic apply; labels removed; stale preview refused', async () => {
    const t = await task({ brand: brands.Harbor, title: 'Brand mover' });
    const sub = await task({ parent: t.id, title: 'Rides along' });
    const l = (
      await env.svc.createLabel(owner, ws, brands.Harbor, { name: 'Moves away' }, mutation())
    ).data;
    await env.svc.addTaskLabel(owner, ws, t.id, { label: l.id }, mutation());
    await env.svc.addChecklistItem(owner, ws, t.id, { text: 'Keep me' }, mutation());
    const preview = await env.svc.previewTaskBrandMove(owner, ws, t.id, { brand: brands.Summit });
    expect(preview).toMatchObject({ tasks: 2, omitted: { labels: 1 } });
    await expect(
      env.svc.moveTaskBrand(owner, ws, t.id, { brand: brands.Summit }, mutation()),
    ).rejects.toEqual(issueOf('preview_required'));
    // A change after the preview makes it stale.
    const cur = await env.svc.getTask(owner, ws, t.id);
    await env.svc.updateTask(
      owner,
      ws,
      t.id,
      { version: cur.version, changes: { priority: { base: 'none', value: 'low' } } },
      v(cur.version),
    );
    await expect(
      env.svc.moveTaskBrand(
        owner,
        ws,
        t.id,
        { brand: brands.Summit, preview_token: preview.preview_token },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('stale_preview'));
    const fresh = await env.svc.previewTaskBrandMove(owner, ws, t.id, { brand: brands.Summit });
    const moved = await env.svc.moveTaskBrand(
      owner,
      ws,
      t.id,
      { brand: brands.Summit, preview_token: fresh.preview_token },
      mutation(),
    );
    expect(moved.data).toMatchObject({ brand: { id: brands.Summit }, labels: [] });
    expect((await env.svc.getTask(owner, ws, sub.id)).brand).toMatchObject({ id: brands.Summit });
    expect((await detail(t.id)).checklist.map((c) => c.text)).toEqual(['Keep me']);
    const env2 = await db.admin(
      `SELECT r.brand_id = t.brand_id AS same FROM core.record r JOIN work.task t ON t.id = r.id WHERE r.public_id = ANY($1)`,
      [[t.id, sub.id]],
    );
    expect(env2.rows.every((r) => r.same)).toBe(true);
    // A project task needs a destination project in the target brand.
    const prj = await project({ brand: brands.Summit, name: 'Has tasks' });
    const pt = await task({ project: prj.id, title: 'Project task' });
    await expect(
      env.svc.previewTaskBrandMove(owner, ws, pt.id, { brand: brands.Harbor }),
    ).rejects.toEqual(issueOf('project_required'));
    // A member without manage in the destination brand is refused.
    const member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const mem = (await membershipOf(db, wsId, member.auth.account.id))!;
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Summit,
      principal: mem.public_id,
      level: 'manage',
    });
    const mine = await task({ brand: brands.Summit, title: 'Mine' }, member);
    await expect(
      env.svc.previewTaskBrandMove(member, ws, mine.id, { brand: brands.Harbor }),
    ).rejects.toEqual(reason('not_found'));
  });

  it('lifecycle applies to the selected task only unless include_subtasks; purge blocked by live children', async () => {
    const parent = await task({ brand: brands.Harbor, title: 'Life' });
    const child = await task({ parent: parent.id, title: 'Life child' });
    await env.svc.taskLifecycle(owner, ws, parent.id, 'archive', {}, mutation());
    expect((await env.svc.getTask(owner, ws, child.id)).lifecycle_state).toBe('active');
    // Archived tasks are read-only.
    await expect(
      env.svc.addChecklistItem(owner, ws, parent.id, { text: 'x' }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    await env.svc.taskLifecycle(owner, ws, parent.id, 'unarchive', {}, mutation());
    await env.svc.taskLifecycle(owner, ws, parent.id, 'trash', {}, mutation());
    // The trashed parent is omitted from the child's breadcrumb without a placeholder.
    expect(await env.svc.getTask(owner, ws, child.id)).toMatchObject({
      ancestors: [],
      parent: null,
    });
    await expect(
      env.svc.taskLifecycle(owner, ws, parent.id, 'purge', {}, mutation()),
    ).rejects.toEqual(issueOf('children_remain'));
    await env.svc.taskLifecycle(owner, ws, parent.id, 'restore', {}, mutation());
    const r = await env.svc.taskLifecycle(
      owner,
      ws,
      parent.id,
      'archive',
      { include_subtasks: true },
      mutation(),
    );
    expect(r.data.changed).toBe(2);
    expect((await env.svc.getTask(owner, ws, child.id)).lifecycle_state).toBe('archived');
  });

  it('duplicate copies fields, own criteria, checklist text (reset), labels, URL links; reports omissions', async () => {
    const t = await task({
      brand: brands.Summit,
      title: 'Original',
      priority: 'urgent',
      estimate_minutes: 60,
    });
    const l = (
      await env.svc.createLabel(owner, ws, brands.Summit, { name: 'Copyable' }, mutation())
    ).data;
    await env.svc.addTaskLabel(owner, ws, t.id, { label: l.id }, mutation());
    const it = (await env.svc.addChecklistItem(owner, ws, t.id, { text: 'Step' }, mutation())).data;
    await env.svc.updateChecklistItem(owner, ws, t.id, it.id, { done: true }, v(0));
    await env.svc.addTaskCriterion(owner, ws, t.id, { text: 'Works' }, mutation());
    await env.svc.addLink(owner, ws, t.id, { url: 'https://example.com/a' }, mutation());
    const member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const mem = (await membershipOf(db, wsId, member.auth.account.id))!;
    await env.svc.setAssignees(
      owner,
      ws,
      t.id,
      { assignees: [mem.public_id], version: (await env.svc.getTask(owner, ws, t.id)).version },
      mutation(),
    );
    await task({ parent: t.id, title: 'Sub copy' });
    const dup = await env.svc.duplicateTask(
      owner,
      ws,
      t.id,
      { include_subtasks: true },
      mutation(),
    );
    expect(dup.data).toMatchObject({
      copied: { tasks: 2, checklist_items: 1, criteria: 1, labels: 1, links: 1 },
      not_copied: expect.arrayContaining(['assignees', 'shares', 'history', 'dependencies']),
      omitted_subtasks: 0,
    });
    const d = await detail(dup.data.id);
    expect(d.task).toMatchObject({
      title: 'Original',
      priority: 'urgent',
      estimate_minutes: 60,
      assignees: [],
    });
    expect(d.checklist).toEqual([expect.objectContaining({ text: 'Step', done: false })]);
    expect(d.subtasks.map((s) => s.title)).toEqual(['Sub copy']);
  });

  it('assignees: active members only, one primary, never authority; departure ends assignments', async () => {
    const t = await task({ brand: brands.Harbor, title: 'Assign' });
    const member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const mem = (await membershipOf(db, wsId, member.auth.account.id))!;
    const guest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: t.id, level: 'comment' }],
    });
    const gmem = (await membershipOf(db, wsId, guest.auth.account.id))!;
    const owned = (await membershipOf(db, wsId, owner.auth.account.id))!;
    let cur = await env.svc.getTask(owner, ws, t.id);
    await expect(
      env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [gmem.public_id], version: cur.version },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('not_assignable'));
    await expect(
      env.svc.setAssignees(
        owner,
        ws,
        t.id,
        { assignees: [mem.public_id], primary: owned.public_id, version: cur.version },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('not_assigned'));
    const r = await env.svc.setAssignees(
      owner,
      ws,
      t.id,
      { assignees: [owned.public_id, mem.public_id], primary: mem.public_id, version: cur.version },
      mutation(),
    );
    expect(r.data.assignees).toEqual([
      expect.objectContaining({ id: mem.public_id, primary: true }),
      expect.objectContaining({ id: owned.public_id, primary: false }),
    ]);
    // The member has no Harbor access: being assigned grants nothing (AT-117).
    await expect(env.svc.getTask(member, ws, t.id)).rejects.toEqual(reason('not_found'));
    expect((await env.svc.listTasks(member, ws, {})).data.map((x) => x.id)).not.toContain(t.id);
    // The database refuses a second primary and an ineligible assignee.
    await expect(
      db.admin(
        `UPDATE work.task_assignee SET is_primary = true WHERE task_id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [t.id],
      ),
    ).rejects.toThrow(/one_primary/);
    // Departure removes the member's assignments in the same transaction.
    const preview = await env.svc.previewChange(owner, ws, {
      kind: 'remove',
      member: mem.public_id,
    });
    env.stepUp.allow = true;
    try {
      await env.svc.removeMember(
        owner,
        ws,
        mem.public_id,
        { preview_token: preview.preview_token, reassign_to: owned.public_id },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
    expect((await membershipOf(db, wsId, member.auth.account.id))!.state).toBe('removed');
    cur = await env.svc.getTask(owner, ws, t.id);
    expect(cur.assignees.map((a) => a.id)).toEqual([owned.public_id]);
  });

  it('history: the audit ledger projection with content redacted and hidden endpoints omitted', async () => {
    const t = await task({
      brand: brands.Harbor,
      title: 'History',
      description: richTextFromPlain('Secret plan'),
    });
    const hidden = await project({ brand: brands.Harbor, name: 'Hidden' });
    const ht = await task({ project: hidden.id, title: 'Hidden blocker' });
    await env.svc.addRelationship(
      owner,
      ws,
      t.id,
      { kind: 'blocked_by', target: ht.id },
      mutation(),
    );
    const cur = await env.svc.getTask(owner, ws, t.id);
    await env.svc.updateTask(
      owner,
      ws,
      t.id,
      { version: cur.version, changes: { priority: { base: 'none', value: 'high' } } },
      v(cur.version),
    );
    const h = await env.svc.taskHistory(owner, ws, t.id);
    expect(h.data[0]).toMatchObject({
      action: 'task.updated',
      changes: [{ field: 'priority', before: 'none', after: 'high' }],
    });
    const created = h.data.find((e) => e.action === 'task.created')!;
    expect(created.changes).toEqual(
      expect.arrayContaining([{ field: 'description', changed: true }]),
    );
    expect(JSON.stringify(h)).not.toContain('Secret plan');
    // A reader who cannot read the blocker sees no trace of the relationship change.
    const member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const mem = (await membershipOf(db, wsId, member.auth.account.id))!;
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: mem.public_id,
      level: 'view',
    });
    await env.svc.setAccess(owner, ws, hidden.id, { access_mode: 'restricted' }, mutation());
    const mh = await env.svc.taskHistory(member, ws, t.id);
    const rel = mh.data.find((e) => e.action === 'relationship.added')!;
    expect(rel.changes).toEqual([]);
    expect(JSON.stringify(mh)).not.toContain(ht.id);
    // Paging uses opaque cursors bound to the task.
    const one = await env.svc.taskHistory(owner, ws, t.id, { limit: '1' });
    expect(one.page.next_cursor).toEqual(expect.any(String));
    await expect(
      env.svc.taskHistory(owner, ws, ht.id, { cursor: one.page.next_cursor }),
    ).rejects.toEqual(reason('cursor_invalid'));
  });

  it('project rollups: completion is readable done leaves over readable non-cancelled leaves (OD-13)', async () => {
    const prj = await project({ brand: brands.Summit, name: 'Rollup' });
    expect(prj.completion).toEqual({ percent: 0, basis: 'status' });
    const a = await task({ project: prj.id, title: 'leaf a', due_date: '2020-01-01' });
    const b = await task({ project: prj.id, title: 'parent b' });
    const b1 = await task({ parent: b.id, title: 'leaf b1' });
    const c = await task({ project: prj.id, title: 'cancelled' });
    const cv = await env.svc.getTask(owner, ws, c.id);
    await env.svc.updateTask(
      owner,
      ws,
      c.id,
      { version: cv.version, changes: { status: { base: 'todo', value: 'cancelled' } } },
      v(cv.version),
    );
    await env.svc.completeTask(owner, ws, b1.id, {}, mutation());
    const view = await env.svc.getProject(owner, ws, prj.id);
    // Leaves: a (open), b1 (done); b is not a leaf; the cancelled task is excluded.
    expect(view.completion).toEqual({ percent: 50, basis: 'leaf_tasks' });
    const o = await env.svc.overview(owner, ws, prj.id);
    expect(o.task_facts).toMatchObject({ available: true, overdue: 1, unassigned: 2 });
    expect(a.id).toBeDefined();
  });
});
