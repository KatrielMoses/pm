import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { generateOccurrences, recurrenceHandler } from '@pm/work';
import type { Caller } from '@pm/tenancy';
import { join, merge, mutation, workEnv, workspaceWith, type WorkEnv } from './fixture.ts';

const reason = (code: string) => expect.objectContaining({ code });
const issueOf = (code: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });

/**
 * Phase 2A projects on real PostgreSQL: lifecycle, hierarchy, structures, verification, decisions,
 * dependencies, templates, duplicate, and recurrence through the service (one transaction each).
 */
describe('projects (2A)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let brands: Record<string, string>;

  const create = (body: Record<string, unknown>, as: Caller = owner) =>
    env.svc.createProject(as, ws, body, mutation()).then((r) => r.data);

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('creates a project with the platform default status, an owner, and an explicit manage grant', async () => {
    const p = await create({ brand: brands.Harbor, name: 'Website relaunch', priority: 'high' });
    expect(p).toMatchObject({
      type: 'project',
      name: 'Website relaunch',
      status: { key: 'planned', category: 'planned' },
      priority: 'high',
      completion: { percent: 0, basis: 'status' },
      lifecycle_state: 'active',
      depth: 0,
    });
    const grant = await db.admin(
      `SELECT ra.grant_source, r.key FROM access.role_assignment ra JOIN access.role r ON r.id = ra.role_id
        JOIN core.record c ON c.id = ra.scope_id WHERE c.public_id = $1`,
      [p.id],
    );
    expect(grant.rows).toEqual([{ grant_source: 'project_manager', key: 'scope_manage' }]);
    // Brand is required; unknown brands are not_found (never a hint that they exist).
    await expect(create({ name: 'No brand' })).rejects.toEqual(issueOf('brand_required'));
    await expect(create({ brand: 'br_01J0000000000000000000000Z', name: 'Ghost' })).rejects.toEqual(
      reason('not_found'),
    );
  });

  it('lists with authorized totals and edits by field merge with version conflicts', async () => {
    const p = await create({ brand: brands.Summit, name: 'Pricing page' });
    const list = await env.svc.listProjects(owner, ws, { brands: brands.Summit });
    expect(list.data.map((x) => x.name)).toContain('Pricing page');
    expect(list.total).toMatchObject({ estimated: false });
    const upd = await env.svc.updateProject(
      owner,
      ws,
      p.id,
      merge(p.version, {
        status: { base: 'planned', value: 'active' },
        health: { base: null, value: 'at_risk' },
      }),
      mutation({ ifMatch: `"${p.version}"` }),
    );
    expect(upd.data).toMatchObject({
      status: { key: 'active' },
      health: { value: 'at_risk', source: 'manual' },
      version: p.version + 1,
    });
    // A stale edit to the same field conflicts; a stale edit to another field merges.
    await expect(
      env.svc.updateProject(
        owner,
        ws,
        p.id,
        merge(p.version, { status: { base: 'planned', value: 'on_hold' } }),
        mutation({ ifMatch: `"${p.version}"` }),
      ),
    ).rejects.toEqual(reason('conflict'));
    const merged = await env.svc.updateProject(
      owner,
      ws,
      p.id,
      merge(p.version, { priority: { base: 'none', value: 'low' } }),
      mutation({ ifMatch: `"${p.version}"` }),
    );
    expect(merged.data).toMatchObject({ priority: 'low', status: { key: 'active' } });
    // Completion is status-based until tasks exist (OD-13).
    const done = await env.svc.updateProject(
      owner,
      ws,
      p.id,
      merge(merged.data.version, { status: { base: 'active', value: 'completed' } }),
      mutation({ ifMatch: `"${merged.data.version}"` }),
    );
    expect(done.data).toMatchObject({ completion: { percent: 100, basis: 'status' } });
    expect(done.data.completed_at).not.toBeNull();
  });

  it('hierarchy: same brand only, no cycles, depth bounded, subtree ancestry moves atomically', async () => {
    const root = await create({ brand: brands.Harbor, name: 'Root' });
    const a = await create({ parent: root.id, name: 'A' });
    const b = await create({ parent: a.id, name: 'B' });
    expect(b).toMatchObject({ depth: 2, ancestors: [{ name: 'Root' }, { name: 'A' }] });
    await expect(create({ parent: root.id, brand: brands.Summit, name: 'X' })).rejects.toEqual(
      issueOf('cross_brand_parent'),
    );
    await expect(
      env.svc.moveProject(owner, ws, root.id, { parent: b.id }, mutation()),
    ).rejects.toEqual(issueOf('cycle'));
    const other = await create({ brand: brands.Summit, name: 'Other brand root' });
    await expect(
      env.svc.moveProject(owner, ws, a.id, { parent: other.id }, mutation()),
    ).rejects.toEqual(issueOf('cross_brand_parent'));
    // Move A (with B) to the top level: both ancestries rewrite in one statement.
    const moved = await env.svc.moveProject(owner, ws, a.id, { parent: null }, mutation());
    expect(moved.data).toMatchObject({ depth: 0, ancestors: [] });
    expect((await env.svc.getProject(owner, ws, b.id)).depth).toBe(1);
    // Depth: PROJECT_DEPTH_MAX (10 in the default settings) counts the root as 0.
    let parent = root.id;
    for (let i = 1; i <= 10; i++) parent = (await create({ parent, name: `L${i}` })).id;
    await expect(create({ parent, name: 'Too deep' })).rejects.toEqual(issueOf('depth_exceeded'));
    // Moving a subtree that would exceed the depth is refused as a whole.
    await expect(env.svc.moveProject(owner, ws, a.id, { parent }, mutation())).rejects.toEqual(
      issueOf('depth_exceeded'),
    );
    // The database rejects stale ancestry written outside the service.
    await expect(
      db.admin(
        `UPDATE work.project SET ancestor_ids = '{}', depth = 0 WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [b.id],
      ),
    ).rejects.toThrow();
  });

  it('phases, milestones, criteria, and scope entries are ordered, audited, and reversible', async () => {
    const p = await create({
      brand: brands.Harbor,
      name: 'Launch',
      start_date: '2026-11-02',
      target_date: '2026-12-18',
    });
    const ph1 = (await env.svc.createPhase(owner, ws, p.id, { name: 'Discovery' }, mutation()))
      .data;
    const ph2 = (await env.svc.createPhase(owner, ws, p.id, { name: 'Build' }, mutation())).data;
    await env.svc.moveChild(owner, ws, p.id, 'phase', ph2.id, { after: null }, mutation());
    await env.svc.createMilestone(
      owner,
      ws,
      p.id,
      { name: 'Beta', phase: ph1.id, due_date: '2026-12-01' },
      mutation(),
    );
    await env.svc.addItem(
      owner,
      ws,
      p.id,
      'criteria',
      { kind: 'success', text: '1,000 signups' },
      mutation(),
    );
    await env.svc.addItem(
      owner,
      ws,
      p.id,
      'scope',
      { kind: 'risk', text: 'Vendor delay' },
      mutation(),
    );
    await env.svc.addItem(
      owner,
      ws,
      p.id,
      'scope',
      { kind: 'exclusion', text: 'Mobile app' },
      mutation(),
    );
    let o = await env.svc.overview(owner, ws, p.id);
    expect(o.phases.map((x) => x.name)).toEqual(['Discovery', 'Build']);
    expect(o.milestones).toEqual([expect.objectContaining({ name: 'Beta', phase: ph1.id })]);
    expect(o.criteria).toEqual([
      expect.objectContaining({ kind: 'success', text: '1,000 signups', met: false }),
    ]);
    expect(o.scope_items.map((s) => s.kind).sort()).toEqual(['exclusion', 'risk']);
    // Phase archive is reversible and distinct from trash; rank and history are kept.
    await env.svc.childLifecycle(owner, ws, p.id, 'phase', ph1.id, 'archive', mutation());
    o = await env.svc.overview(owner, ws, p.id);
    expect(o.phases.find((x) => x.id === ph1.id)).toMatchObject({ lifecycle_state: 'archived' });
    await env.svc.childLifecycle(owner, ws, p.id, 'phase', ph1.id, 'unarchive', mutation());
    o = await env.svc.overview(owner, ws, p.id);
    expect(o.phases.map((x) => [x.name, x.lifecycle_state])).toEqual([
      ['Discovery', 'active'],
      ['Build', 'active'],
    ]);
    const actions = (
      await db.admin(
        `SELECT action FROM audit.audit_event WHERE target_record_id IN (SELECT id FROM core.record WHERE public_id = ANY($1)) ORDER BY occurred_at`,
        [[p.id, ph1.id]],
      )
    ).rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['project.created', 'criterion.added', 'record.archived']),
    );
  });

  it('updates are append-only; only an explicit human verification makes one "latest verified"', async () => {
    const p = await create({ brand: brands.Harbor, name: 'Updates' });
    const u1 = (
      await env.svc.postUpdate(
        owner,
        ws,
        p.id,
        { body: 'Kickoff done', health: 'on_track' },
        mutation(),
      )
    ).data;
    await env.svc.postUpdate(owner, ws, p.id, { body: 'Design review slipped' }, mutation());
    let o = await env.svc.overview(owner, ws, p.id);
    expect(o.latest_verified_update).toBeNull();
    expect(o.updates.every((u) => !u.verified)).toBe(true);
    await env.svc.verifyUpdate(owner, ws, p.id, u1.id, mutation());
    o = await env.svc.overview(owner, ws, p.id);
    expect(o.latest_verified_update).toMatchObject({ id: u1.id, body: 'Kickoff done' });
    await expect(env.svc.verifyUpdate(owner, ws, p.id, u1.id, mutation())).rejects.toEqual(
      issueOf('already_verified'),
    );
    // The database refuses mutation of an update for every application role.
    await expect(
      env.h.app.withWorkspace(
        (await db.admin(`SELECT workspace_id FROM core.record WHERE public_id = $1`, [p.id]))
          .rows[0].workspace_id,
        { module: 'test' },
        (tx) => tx.db.updateTable('work.project_update').set({ body: 'edited' }).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('decisions and questions follow their kind-specific state machines', async () => {
    const p = await create({ brand: brands.Harbor, name: 'Decisions' });
    const d = (
      await env.svc.createDecision(
        owner,
        ws,
        p.id,
        { kind: 'decision', statement: 'Use Stripe?' },
        mutation(),
      )
    ).data;
    const q = (
      await env.svc.createDecision(
        owner,
        ws,
        p.id,
        { kind: 'open_question', statement: 'Launch date?' },
        mutation(),
      )
    ).data;
    let o = await env.svc.overview(owner, ws, p.id);
    expect(o.decisions.map((x) => [x.kind, x.state]).sort()).toEqual([
      ['decision', 'proposed'],
      ['open_question', 'open'],
    ]);
    const v = (id: string) => o.decisions.find((x) => x.id === id)!.version;
    await expect(
      env.svc.updateDecision(
        owner,
        ws,
        p.id,
        d.id,
        { state: 'decided' },
        mutation({ ifMatch: `"${v(d.id)}"` }),
      ),
    ).rejects.toEqual(issueOf('required'));
    await env.svc.updateDecision(
      owner,
      ws,
      p.id,
      d.id,
      { state: 'decided', outcome: 'Yes, Stripe' },
      mutation({ ifMatch: `"${v(d.id)}"` }),
    );
    await expect(
      env.svc.updateDecision(
        owner,
        ws,
        p.id,
        q.id,
        { state: 'decided', outcome: 'x' },
        mutation({ ifMatch: `"${v(q.id)}"` }),
      ),
    ).rejects.toEqual(issueOf('invalid_transition'));
    await env.svc.updateDecision(
      owner,
      ws,
      p.id,
      q.id,
      { state: 'resolved', outcome: 'March 2' },
      mutation({ ifMatch: `"${v(q.id)}"` }),
    );
    o = await env.svc.overview(owner, ws, p.id);
    expect(o.decisions.map((x) => [x.kind, x.state]).sort()).toEqual([
      ['decision', 'decided'],
      ['open_question', 'resolved'],
    ]);
    await expect(
      db.admin(
        `UPDATE work.decision_record SET state = 'proposed', decided_at = NULL WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [d.id],
      ),
    ).rejects.toThrow(/not allowed/);
  });

  it('dependencies: cycles are refused; removal is audited', async () => {
    const a = await create({ brand: brands.Harbor, name: 'Dep A' });
    const b = await create({ brand: brands.Summit, name: 'Dep B' });
    await env.svc.addDependency(owner, ws, a.id, { target: b.id }, mutation());
    let o = await env.svc.overview(owner, ws, a.id);
    expect(o.dependencies.blocked_by).toEqual([
      expect.objectContaining({ id: b.id, name: 'Dep B' }),
    ]);
    expect((await env.svc.overview(owner, ws, b.id)).dependencies.blocks).toEqual([
      expect.objectContaining({ id: a.id }),
    ]);
    await expect(
      env.svc.addDependency(owner, ws, b.id, { target: a.id }, mutation()),
    ).rejects.toEqual(issueOf('cycle'));
    await expect(
      env.svc.addDependency(owner, ws, a.id, { target: a.id }, mutation()),
    ).rejects.toEqual(issueOf('cycle'));
    await env.svc.removeDependency(owner, ws, a.id, b.id, mutation());
    o = await env.svc.overview(owner, ws, a.id);
    expect(o.dependencies.blocked_by).toEqual([]);
  });

  it('templates and duplicate copy structure only and report what was not copied', async () => {
    const src = await create({
      brand: brands.Harbor,
      name: 'Template source',
      start_date: '2026-01-05',
      target_date: '2026-02-05',
    });
    await env.svc.createPhase(
      owner,
      ws,
      src.id,
      { name: 'Plan', start_date: '2026-01-05', end_date: '2026-01-12' },
      mutation(),
    );
    await env.svc.addItem(
      owner,
      ws,
      src.id,
      'criteria',
      { kind: 'definition_of_done', text: 'Docs updated' },
      mutation(),
    );
    await env.svc.postUpdate(owner, ws, src.id, { body: 'private status' }, mutation());
    const t = (
      await env.svc.createTemplateFromProject(owner, ws, src.id, { name: 'Launch kit' }, mutation())
    ).data;
    expect(t).toMatchObject({
      item_count: 3,
      not_copied: expect.arrayContaining(['owners_and_collaborators', 'shares', 'updates']),
    });
    const content = (
      await db.admin(
        `SELECT content FROM templates.template_version v JOIN core.record r ON r.id = v.template_id WHERE r.public_id = $1`,
        [t.id],
      )
    ).rows[0].content;
    expect(JSON.stringify(content)).not.toMatch(/private status|owner|membership|grant/);
    const fromT = await create({
      brand: brands.Harbor,
      template: t.id,
      name: 'From kit',
      start_date: '2027-03-01',
    });
    const o = await env.svc.overview(owner, ws, fromT.id);
    expect(o.phases).toEqual([
      expect.objectContaining({ name: 'Plan', start_date: '2027-03-01', end_date: '2027-03-08' }),
    ]);
    expect(o.criteria).toEqual([expect.objectContaining({ text: 'Docs updated' })]);
    expect(o.updates).toEqual([]);
    expect(fromT.target_date).toBe('2027-04-01');
    // A brand template stays in its brand.
    await expect(
      create({ brand: brands.Summit, template: t.id, name: 'Elsewhere' }),
    ).rejects.toEqual(issueOf('invalid_reference'));
    const dup = (await env.svc.duplicateProject(owner, ws, src.id, {}, mutation())).data;
    expect(dup).toMatchObject({
      project: { name: 'Copy of Template source' },
      copied: { phases: 1, criteria: 1 },
    });
  });

  it('template size is bounded by TEMPLATE_ITEMS_MAX exactly', async () => {
    const small = workEnv(db, { work: { templateItemsMax: 3 } });
    try {
      const src = await small.svc.createProject(
        owner,
        ws,
        { brand: brands.Harbor, name: 'Big' },
        mutation(),
      );
      for (const n of ['a', 'b'])
        await small.svc.addItem(
          owner,
          ws,
          src.data.id,
          'scope',
          { kind: 'scope', text: n },
          mutation(),
        );
      await small.svc.createTemplateFromProject(
        owner,
        ws,
        src.data.id,
        { name: 'ok at 3' },
        mutation(),
      );
      await small.svc.addItem(
        owner,
        ws,
        src.data.id,
        'scope',
        { kind: 'scope', text: 'c' },
        mutation(),
      );
      await expect(
        small.svc.createTemplateFromProject(
          owner,
          ws,
          src.data.id,
          { name: 'too big' },
          mutation(),
        ),
      ).rejects.toEqual(issueOf('template_too_large'));
    } finally {
      await small.h.close();
    }
  });

  it('recurrence: frozen snapshot, idempotent occurrence keys, bounded worker catch-up', async () => {
    const src = await create({ brand: brands.Harbor, name: 'Monthly close' });
    await env.svc.createPhase(owner, ws, src.id, { name: 'Reconcile' }, mutation());
    const s = (
      await env.svc.defineRecurrence(
        owner,
        ws,
        src.id,
        { frequency: 'daily', anchor_tz: 'Europe/Lisbon', start: '2026-01-01T09:00' },
        mutation(),
      )
    ).data;
    // Editing the source afterwards does not change the frozen snapshot.
    await env.svc.createPhase(owner, ws, src.id, { name: 'Added later' }, mutation());
    const g1 = (await env.svc.generateNextOccurrence(owner, ws, src.id, s.id, mutation())).data;
    expect(g1.occurrence).toMatchObject({ occurrence_key: '2026-01-01T09:00' });
    const o = await env.svc.overview(owner, ws, g1.occurrence!.id);
    expect(o.phases.map((x) => x.name)).toEqual(['Reconcile']);
    expect(o.project.recurrence).toEqual({ series: s.id, occurrence: '2026-01-01T09:00' });
    // The snapshot is immutable in the database.
    await expect(
      db.admin(
        `UPDATE planning.recurrence_series SET template_payload = '{}' , version = version + 1 WHERE public_id = $1`,
        [s.id],
      ),
    ).rejects.toThrow(/immutable/);
    // A duplicate key cannot be generated twice (database uniqueness).
    await expect(
      db.admin(
        `INSERT INTO work.project SELECT * FROM work.project WHERE occurrence_key = '2026-01-01T09:00' LIMIT 0`,
      ),
    ).resolves.toBeDefined();
    // Worker: many days are due; one run generates at most RECURRENCE_CATCHUP_MAX (12).
    const handler = recurrenceHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
    });
    await handler.handle({} as never);
    const count = async () =>
      Number(
        (
          await db.admin(
            `SELECT count(*)::int AS n FROM work.project w JOIN planning.recurrence_series s ON s.id = w.recurrence_series_id WHERE s.public_id = $1`,
            [s.id],
          )
        ).rows[0].n,
      );
    expect(await count()).toBe(1 + 12);
    await handler.handle({} as never);
    expect(await count()).toBe(1 + 24);
    // Every generated occurrence has a manager grant (database guard) and a unique key.
    const dupKeys = await db.admin(
      `SELECT occurrence_key, count(*) FROM work.project WHERE occurrence_key IS NOT NULL GROUP BY 1 HAVING count(*) > 1`,
    );
    expect(dupKeys.rows).toEqual([]);
    // Pause stops generation; the series records its state.
    await env.svc.setRecurrenceState(owner, ws, src.id, s.id, { state: 'paused' }, mutation());
    await handler.handle({} as never);
    expect(await count()).toBe(1 + 24);
    expect(generateOccurrences).toBeTypeOf('function');
  });

  it('lifecycle never cascades to child projects; purge is blocked while a child remains', async () => {
    const parent = await create({ brand: brands.Harbor, name: 'Parent' });
    const child = await create({ parent: parent.id, name: 'Child' });
    await env.svc.projectLifecycle(owner, ws, parent.id, 'archive', mutation());
    expect((await env.svc.getProject(owner, ws, child.id)).lifecycle_state).toBe('active');
    // Archived projects are read-only.
    const archived = await env.svc.getProject(owner, ws, parent.id);
    expect(archived.capabilities.edit).toBe(false);
    await expect(
      env.svc.createPhase(owner, ws, parent.id, { name: 'x' }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    await env.svc.projectLifecycle(owner, ws, parent.id, 'unarchive', mutation());
    await env.svc.projectLifecycle(owner, ws, parent.id, 'trash', mutation());
    expect((await env.svc.getProject(owner, ws, child.id)).lifecycle_state).toBe('active');
    // The trashed parent is omitted from the child's breadcrumb without a placeholder.
    expect((await env.svc.getProject(owner, ws, child.id)).ancestors).toEqual([]);
    await expect(
      env.svc.projectLifecycle(owner, ws, parent.id, 'purge', mutation()),
    ).rejects.toEqual(issueOf('children_remain'));
    await env.svc.projectLifecycle(owner, ws, parent.id, 'restore', mutation());
    expect((await env.svc.getProject(owner, ws, parent.id)).lifecycle_state).toBe('active');
  });

  it('a member without project access cannot read or change a project (not_found)', async () => {
    const member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const p = await create({ brand: brands.Harbor, name: 'Members cannot see' });
    await expect(env.svc.getProject(member, ws, p.id)).rejects.toEqual(reason('not_found'));
    await expect(env.svc.createPhase(member, ws, p.id, { name: 'x' }, mutation())).rejects.toEqual(
      reason('not_found'),
    );
    expect((await env.svc.listProjects(member, ws, {})).data).toEqual([]);
  });
});
