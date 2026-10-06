import pg from 'pg';
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

/**
 * Phase 2C configuration concurrency on real PostgreSQL (corrective review 01, ADR-0015 lock
 * order). Two authorized managers act at once on the same or overlapping configuration. A barrier
 * holds the contested row in a pooled `app_rw` connection (with RLS context) until both commands
 * are verifiably waiting on it, then releases it. Every pair ends in one of the documented
 * outcomes, serialized commits with a deterministic final state or one success plus a typed
 * conflict, and the invariants (no lost update, partial configuration, duplicate active rows,
 * cycle, replayable approval, or stale result) are checked directly in the database.
 */
describe('workflow and field configuration concurrency (2C review 01)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let a: Caller;
  let b: Caller;
  let member: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let pool: pg.Pool;
  const scope = () => `brand:${brands.Harbor}`;
  const v = (n: number) => mutation({ ifMatch: `"${n}"` });

  /** Holds `lockSql` (FOR UPDATE) until `n` other backends wait on locks, then releases it. */
  async function contended<T extends readonly unknown[]>(
    lockSql: string,
    params: unknown[],
    run: () => { [K in keyof T]: Promise<T[K]> },
    n = 2,
  ): Promise<{ [K in keyof T]: PromiseSettledResult<T[K]> }> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [wsId]);
      const held = await c.query(lockSql, params);
      expect(held.rowCount, 'the barrier holds the contested row').toBe(1);
      const pending = Promise.allSettled(run());
      const deadline = Date.now() + 10_000;
      for (;;) {
        const w = await db.admin(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (w.rows[0].n >= n) break;
        if (Date.now() > deadline) throw new Error('commands did not reach the barrier');
        await new Promise((r) => setTimeout(r, 10));
      }
      await c.query('COMMIT');
      return (await pending) as never;
    } finally {
      c.release();
    }
  }
  const outcome = (r: PromiseSettledResult<unknown>) =>
    r.status === 'fulfilled' ? 'ok' : ((r.reason as { code?: string }).code ?? 'error');
  const issueCode = (r: PromiseSettledResult<unknown>) =>
    r.status === 'rejected'
      ? ((r.reason as { issues?: Array<{ code: string }> }).issues?.[0]?.code ?? null)
      : null;
  const audits = async (action: string) =>
    (
      await db.admin(
        `SELECT count(*)::int AS n FROM audit.audit_event WHERE workspace_id = $1 AND action = $2`,
        [wsId, action],
      )
    ).rows[0].n as number;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor']));
    wsId = await workspaceIdOf(db, ws);
    a = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    b = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    for (const [who, level] of [
      [a, 'manage'],
      [b, 'manage'],
      [member, 'edit'],
    ] as const) {
      const m = (await membershipOf(db, wsId, who.auth.account.id))!;
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: m.public_id,
        level,
      });
    }
    pool = new pg.Pool({ connectionString: db.app, max: 1 });
  });
  afterAll(async () => {
    await pool.end();
    await env.h.close();
    await db.drop();
  });

  // Each test configures its own project scope (one active workflow per scope and kind).
  let n = 0;
  let lastProject = '';
  const makeWorkflow = async (kind: 'task' | 'project' = 'task') =>
    (
      await env.svc.createWorkflow(
        a,
        ws,
        {
          scope: `project:${(lastProject = (await env.svc.createProject(a, ws, { brand: brands.Harbor, name: `Scope ${++n}` }, mutation())).data.id)}`,
          record_kind: kind,
          name: `Flow ${kind}`,
          statuses: [
            { name: 'Open', category: 'planned' },
            { name: 'Doing', category: 'active' },
            { name: 'Closed', category: 'done' },
          ],
        },
        mutation(),
      )
    ).data;

  it('workflow edit vs status reorder at the same version: one commits, one is a typed conflict; nothing is lost or partial', async () => {
    const wf = await makeWorkflow();
    const [open, doing] = wf.statuses.map((s) => s.id) as [string, string];
    const [r1, r2] = await contended(
      `SELECT id FROM workflow.workflow WHERE public_id = $1 FOR UPDATE`,
      [wf.id],
      () =>
        [
          env.svc.updateWorkflow(a, ws, wf.id, { name: 'Renamed by A' }, v(wf.version)),
          env.svc.moveStatus(b, ws, wf.id, doing, { after: null }, v(wf.version)),
        ] as const,
    );
    expect([outcome(r1), outcome(r2)].sort()).toEqual(['conflict', 'ok']);
    const after = await env.svc.getWorkflow(a, ws, wf.id);
    expect(after.version).toBe(wf.version + 1);
    if (outcome(r1) === 'ok') expect(after.name).toBe('Renamed by A');
    else expect(after.statuses[0]!.id).toBe(doing);
    expect(after.statuses.map((s) => s.id).sort()).toEqual(
      [...wf.statuses.map((s) => s.id)].sort(),
    );
    // Exactly one audit entry and one outbox event for the committed command.
    expect((await audits('workflow.update')) + (await audits('workflow.move_status'))).toBe(1);
    const wfRow = (await db.admin(`SELECT id FROM workflow.workflow WHERE public_id = $1`, [wf.id]))
      .rows[0].id;
    const events = await db.admin(
      `SELECT event_type, aggregate_sequence FROM exec.outbox_event WHERE workspace_id = $1 AND aggregate_id = $2 ORDER BY aggregate_sequence`,
      [wsId, wfRow],
    );
    // One creation event and exactly one event for the committed edit, with increasing sequences.
    expect(events.rows.map((r) => r.event_type)).toEqual([
      'workflow.workflow.created',
      outcome(r1) === 'ok' ? 'workflow.workflow.updated' : 'workflow.status.updated',
    ]);
    expect(Number(events.rows[1].aggregate_sequence)).toBeGreaterThan(
      Number(events.rows[0].aggregate_sequence),
    );
    void open;
  });

  it('transition add/edit/archive and required-field changes serialize; no duplicate active edge or edge to an archived status', async () => {
    const wf = await makeWorkflow('project');
    const [open, doing, closed] = wf.statuses.map((s) => s.id) as [string, string, string];
    // Two managers add the same edge from fresh, different reads: serialized, the second refuses.
    const [x1, x2] = await contended(
      `SELECT id FROM workflow.workflow WHERE public_id = $1 FOR UPDATE`,
      [wf.id],
      () =>
        [
          env.svc.addTransition(
            a,
            ws,
            wf.id,
            { transition: { from: open, to: doing } },
            v(wf.version),
          ),
          env.svc.addTransition(
            b,
            ws,
            wf.id,
            { transition: { from: open, to: doing, requirements: [{ builtin: 'owner' }] } },
            v(wf.version),
          ),
        ] as const,
    );
    expect([outcome(x1), outcome(x2)].sort()).toEqual(['conflict', 'ok']);
    let cur = await env.svc.getWorkflow(a, ws, wf.id);
    expect(cur.transitions).toHaveLength(1);
    const original = cur.transitions[0]!.requirements.map((r) => r.key!).sort();
    // Edit requirements vs archive the target status at the same version.
    const t = cur.transitions[0]!;
    const [y1, y2] = await contended(
      `SELECT id FROM workflow.workflow WHERE public_id = $1 FOR UPDATE`,
      [wf.id],
      () =>
        [
          env.svc.updateTransition(
            a,
            ws,
            wf.id,
            t.id,
            { transition: { requirements: [{ builtin: 'target_date' }], confirmation: 'confirm' } },
            v(cur.version),
          ),
          env.svc.setStatusState(b, ws, wf.id, doing, {}, v(cur.version), 'archived'),
        ] as const,
    );
    expect([outcome(y1), outcome(y2)].sort()).toEqual(['conflict', 'ok']);
    cur = await env.svc.getWorkflow(a, ws, wf.id);
    const bad = await db.admin(
      `SELECT count(*)::int AS n FROM workflow.transition t JOIN workflow.workflow_status s ON s.id IN (t.from_status_id, t.to_status_id)
        WHERE t.workspace_id = $1 AND t.state = 'active' AND s.state = 'archived'`,
      [wsId],
    );
    expect(bad.rows[0].n).toBe(0);
    const dup = await db.admin(
      `SELECT count(*)::int AS n FROM (SELECT workflow_id, from_status_id, to_status_id FROM workflow.transition WHERE state = 'active' GROUP BY 1, 2, 3 HAVING count(*) > 1) d`,
    );
    expect(dup.rows[0].n).toBe(0);
    // The requirement set is all-or-nothing: either exactly the edited rule or the original.
    const reqs = await db.admin(
      `SELECT array_agg(builtin_key ORDER BY builtin_key) AS keys FROM workflow.transition_requirement r JOIN workflow.transition t ON t.id = r.transition_id WHERE t.public_id = $1`,
      [t.id],
    );
    expect([original.length ? original : null, ['target_date']]).toContainEqual(reqs.rows[0].keys);
    void closed;
  });

  it('a configuration change while a transition preview/apply is in flight: the stale fingerprint refuses safely; a racing apply serializes', async () => {
    const wf = await makeWorkflow();
    const [open, doing] = wf.statuses.map((s) => s.id) as [string, string];
    const task = (
      await env.svc.createTask(member, ws, { project: lastProject, title: 'In flight' }, mutation())
    ).data;
    let w2 = (
      await env.svc.addTransition(
        a,
        ws,
        wf.id,
        { transition: { from: open, to: doing, confirmation: 'confirm' } },
        v(wf.version),
      )
    ).data;
    // Preview, then a manager adds a required field before the apply: the fingerprint is stale.
    const pv = await env.svc.previewTransition(member, ws, task.id, { to: doing });
    w2 = (
      await env.svc.updateTransition(
        a,
        ws,
        wf.id,
        w2.transitions[0]!.id,
        { transition: { requirements: [{ builtin: 'due_date' }] } },
        v(w2.version),
      )
    ).data;
    await expect(
      env.svc.applyTransition(
        member,
        ws,
        task.id,
        { to: doing, version: task.version, preview_token: pv.preview_token },
        mutation(),
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: expect.stringMatching(/conflict|validation_failed/) }),
    );
    expect((await env.svc.getTask(member, ws, task.id)).status.key).toBe(open);
    // Racing: apply and a configuration edit both wait on the workflow row; whichever runs second
    // sees the first. Either the apply ran under the old rules (then the edit commits after it) or
    // the edit committed first (then the apply is refused as stale). Never both half-applied.
    const fresh = await env.svc.getTask(member, ws, task.id);
    await env.svc.updateTransition(
      a,
      ws,
      wf.id,
      w2.transitions[0]!.id,
      { transition: { requirements: [] } },
      v(w2.version),
    );
    const w3 = await env.svc.getWorkflow(a, ws, wf.id);
    const pv2 = await env.svc.previewTransition(member, ws, task.id, { to: doing });
    const [r1, r2] = await contended(
      `SELECT id FROM workflow.workflow WHERE public_id = $1 FOR UPDATE`,
      [wf.id],
      () =>
        [
          env.svc.applyTransition(
            member,
            ws,
            task.id,
            { to: doing, version: fresh.version, preview_token: pv2.preview_token },
            mutation(),
          ),
          env.svc.updateTransition(
            b,
            ws,
            wf.id,
            w3.transitions[0]!.id,
            {
              transition: { confirmation: 'none', requirements: [{ builtin: 'estimate_minutes' }] },
            },
            v(w3.version),
          ),
        ] as const,
    );
    expect(outcome(r2)).toBe('ok');
    const now = await env.svc.getTask(member, ws, task.id);
    if (outcome(r1) === 'ok') expect(now.status.key).toBe(doing);
    else {
      expect(outcome(r1)).toBe('conflict');
      expect(now.status.key).toBe(open);
      expect(now.version).toBe(fresh.version);
    }
    // A permission epoch change (the member's grant revoked and restored) also stales a preview.
    const m = (await membershipOf(db, wsId, member.auth.account.id))!;
    const t3 = (
      await env.svc.createTask(
        member,
        ws,
        { project: lastProject, title: 'Epoch', estimate_minutes: 30 },
        mutation(),
      )
    ).data;
    const pv3 = await env.svc.previewTransition(member, ws, t3.id, { to: doing });
    expect(pv3.preview_token).toBeTruthy();
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Harbor,
      principal: m.public_id,
    });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: m.public_id,
      level: 'edit',
    });
    await expect(
      env.svc.applyTransition(
        member,
        ws,
        t3.id,
        { to: doing, version: t3.version, preview_token: pv3.preview_token },
        mutation(),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'conflict' }));
    expect((await env.svc.getTask(member, ws, t3.id)).status.key).toBe(open);
  });

  it('field definitions, values, and set versions: one winner per contested version; no duplicate active definition; formulas match the final values', async () => {
    const pts = (
      await env.svc.createFieldDefinition(
        a,
        ws,
        { scope: scope(), name: 'Points', field_type: 'number', applies_to: ['task'] },
        mutation(),
      )
    ).data;
    const dbl = (
      await env.svc.createFieldDefinition(
        a,
        ws,
        {
          scope: scope(),
          name: 'Doubled',
          field_type: 'formula',
          applies_to: ['task'],
          config: { source: `{${pts.id}} * 2` },
        },
        mutation(),
      )
    ).data;
    // Same definition, same version.
    const [d1, d2] = await contended(
      `SELECT id FROM workflow.field_definition WHERE public_id = $1 FOR UPDATE`,
      [pts.id],
      () =>
        [
          env.svc.updateFieldDefinition(a, ws, pts.id, { name: 'Story points' }, v(pts.version)),
          env.svc.updateFieldDefinition(
            b,
            ws,
            pts.id,
            { presentation: 'advanced' },
            v(pts.version),
          ),
        ] as const,
    );
    expect([outcome(d1), outcome(d2)].sort()).toEqual(['conflict', 'ok']);
    // Two creates with the same name at once: one active definition.
    const [c1, c2] = await Promise.allSettled([
      env.svc.createFieldDefinition(
        a,
        ws,
        { scope: scope(), name: 'Risk', field_type: 'text', applies_to: ['task'] },
        mutation(),
      ),
      env.svc.createFieldDefinition(
        b,
        ws,
        { scope: scope(), name: 'Risk', field_type: 'text', applies_to: ['task'] },
        mutation(),
      ),
    ]);
    expect([outcome(c1), outcome(c2)].sort()).toEqual(['ok', 'validation_failed']);
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM workflow.field_definition WHERE workspace_id = $1 AND normalized_name = 'risk' AND state = 'active'`,
          [wsId],
        )
      ).rows[0].n,
    ).toBe(1);
    // Two value edits on one record at the same version: the record lock serializes them.
    const t = (
      await env.svc.createTask(member, ws, { brand: brands.Harbor, title: 'Valued' }, mutation())
    ).data;
    const f0 = await env.svc.recordFields(member, ws, t.id);
    const [v1, v2] = await contended(
      `SELECT id FROM work.task WHERE id = (SELECT id FROM core.record WHERE public_id = $1) FOR UPDATE`,
      [t.id],
      () =>
        [
          env.svc.updateRecordFields(
            a,
            ws,
            t.id,
            { version: f0.version, changes: { [pts.id]: { base: null, value: '3' } } },
            mutation(),
          ),
          env.svc.updateRecordFields(
            b,
            ws,
            t.id,
            { version: f0.version, changes: { [pts.id]: { base: null, value: '5' } } },
            mutation(),
          ),
        ] as const,
    );
    expect([outcome(v1), outcome(v2)].sort()).toEqual(['conflict', 'ok']);
    const f1 = await env.svc.recordFields(member, ws, t.id);
    const won = f1.fields.find((f) => f.id === pts.id)!.value as string;
    expect(['3', '5']).toContain(won);
    expect(f1.fields.find((f) => f.id === dbl.id)!.value).toBe(String(Number(won) * 2));
    const stored = await db.admin(
      `SELECT v.value #>> '{}' AS v FROM workflow.field_value v JOIN workflow.field_definition d ON d.id = v.definition_id WHERE d.public_id = $1`,
      [dbl.id],
    );
    expect(stored.rows[0].v).toBe(String(Number(won) * 2));
    // A formula edit racing a value edit: the materialized result may be either version, but every
    // read reflects the current definition and the current value (no stale result is served).
    const cur = await env.svc.recordFields(member, ws, t.id);
    const dblRow = await env.svc.getFieldDefinition(a, ws, dbl.id);
    await Promise.allSettled([
      env.svc.updateFieldDefinition(
        a,
        ws,
        dbl.id,
        { config: { source: `{${pts.id}} * 10` } },
        v(dblRow.version),
      ),
      env.svc.updateRecordFields(
        b,
        ws,
        t.id,
        { version: cur.version, changes: { [pts.id]: { value: '7' } } },
        mutation(),
      ),
    ]);
    const after = await env.svc.recordFields(member, ws, t.id);
    const ptsNow = Number(after.fields.find((f) => f.id === pts.id)!.value);
    const def = await env.svc.getFieldDefinition(a, ws, dbl.id);
    const factor = (def.config.source as string).includes('* 10)') ? 10 : 2;
    expect(after.fields.find((f) => f.id === dbl.id)!.value).toBe(String(ptsNow * factor));
    // Field set versions: two edits at the same version, one wins; versions stay contiguous.
    const set = (
      await env.svc.createFieldSet(
        a,
        ws,
        { scope: scope(), name: 'Bug', applies_to: ['task'], items: [{ field: pts.id }] },
        mutation(),
      )
    ).data;
    const [s1, s2] = await contended(
      `SELECT id FROM workflow.field_set WHERE public_id = $1 FOR UPDATE`,
      [set.id],
      () =>
        [
          env.svc.updateFieldSet(
            a,
            ws,
            set.id,
            { version: set.version, items: [{ field: pts.id, presentation: 'advanced' }] },
            mutation(),
          ),
          env.svc.updateFieldSet(
            b,
            ws,
            set.id,
            { version: set.version, items: [{ field: dbl.id }] },
            mutation(),
          ),
        ] as const,
    );
    expect([outcome(s1), outcome(s2)].sort()).toEqual(['conflict', 'ok']);
    const versions = await db.admin(
      `SELECT array_agg(x.version ORDER BY x.version) AS v FROM workflow.field_set_version x JOIN workflow.field_set s ON s.id = x.field_set_id WHERE s.public_id = $1`,
      [set.id],
    );
    expect(versions.rows[0].v).toEqual([1, 2]);
  });

  it('formula dependency edits racing toward a cycle: the graph lock serializes them; exactly one commits and the graph stays acyclic', async () => {
    const x = (
      await env.svc.createFieldDefinition(
        a,
        ws,
        { scope: scope(), name: 'Base X', field_type: 'number', applies_to: ['task'] },
        mutation(),
      )
    ).data;
    const p = (
      await env.svc.createFieldDefinition(
        a,
        ws,
        {
          scope: scope(),
          name: 'P',
          field_type: 'formula',
          applies_to: ['task'],
          config: { source: `{${x.id}} + 1` },
        },
        mutation(),
      )
    ).data;
    const q = (
      await env.svc.createFieldDefinition(
        a,
        ws,
        {
          scope: scope(),
          name: 'Q',
          field_type: 'formula',
          applies_to: ['task'],
          config: { source: `{${x.id}} + 2` },
        },
        mutation(),
      )
    ).data;
    // A makes P depend on Q while B makes Q depend on P.
    const [r1, r2] = await contended(
      `SELECT pg_advisory_xact_lock(hashtextextended('formula-graph:' || $1, 0)), 1 AS held`,
      [wsId],
      () =>
        [
          env.svc.updateFieldDefinition(
            a,
            ws,
            p.id,
            { config: { source: `{${q.id}} + 1` } },
            v(p.version),
          ),
          env.svc.updateFieldDefinition(
            b,
            ws,
            q.id,
            { config: { source: `{${p.id}} + 2` } },
            v(q.version),
          ),
        ] as const,
    );
    expect([outcome(r1), outcome(r2)].sort()).toEqual(['ok', 'validation_failed']);
    expect([issueCode(r1), issueCode(r2)].filter(Boolean)).toEqual(['cycle']);
    const cyc = await db.admin(
      `WITH RECURSIVE g(src, dst, path) AS (
         SELECT definition_id, depends_on_definition_id, ARRAY[definition_id] FROM workflow.formula_dependency WHERE workspace_id = $1
         UNION ALL SELECT g.src, d.depends_on_definition_id, g.path || d.definition_id FROM g JOIN workflow.formula_dependency d ON d.definition_id = g.dst WHERE NOT d.definition_id = ANY(g.path))
       SELECT count(*)::int AS n FROM g WHERE src = dst`,
      [wsId],
    );
    expect(cyc.rows[0].n).toBe(0);
  });

  it('approval policy, requests, decisions, and applies: no replay, single close, single status change; a policy change stales a pending request', async () => {
    let wf = await makeWorkflow();
    const [open, doing] = wf.statuses.map((s) => s.id) as [string, string];
    wf = (
      await env.svc.addTransition(
        a,
        ws,
        wf.id,
        { transition: { from: open, to: doing, approval_policy: 'one_manager' } },
        v(wf.version),
      )
    ).data;
    const t = (
      await env.svc.createTask(
        member,
        ws,
        { project: lastProject, title: 'Approve me' },
        mutation(),
      )
    ).data;
    // Two requests at once for the same change: the record lock serializes; one stays open.
    const [q1, q2] = await contended(
      `SELECT id FROM work.task WHERE id = (SELECT id FROM core.record WHERE public_id = $1) FOR UPDATE`,
      [t.id],
      () =>
        [
          env.svc.requestApproval(member, ws, t.id, { to: doing, version: t.version }, mutation()),
          env.svc.requestApproval(member, ws, t.id, { to: doing, version: t.version }, mutation()),
        ] as const,
    );
    expect([outcome(q1), outcome(q2)].sort()).toEqual(['conflict', 'ok']);
    const req = (
      q1.status === 'fulfilled'
        ? q1.value
        : (q2 as PromiseFulfilledResult<Awaited<ReturnType<typeof env.svc.requestApproval>>>).value
    ).data;
    // Two managers decide at once: one decision counts; the second sees a decided request.
    const [k1, k2] = await contended(
      `SELECT id FROM workflow.approval_request WHERE public_id = $1 FOR UPDATE`,
      [req.id],
      () =>
        [
          env.svc.decideApproval(a, ws, req.id, { decision: 'approve' }, mutation()),
          env.svc.decideApproval(b, ws, req.id, { decision: 'reject' }, mutation()),
        ] as const,
    );
    expect([outcome(k1), outcome(k2)].sort()).toEqual(['conflict', 'ok']);
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM workflow.approval_decision d JOIN workflow.approval_request r ON r.id = d.approval_request_id WHERE r.public_id = $1`,
          [req.id],
        )
      ).rows[0].n,
    ).toBe(1);
    const state = (await env.svc.getApproval(member, ws, req.id)).state;
    if (state === 'approved') {
      // Two applies with the same approval: one applies; the other is refused (no replay).
      const pv = await env.svc.previewTransition(member, ws, t.id, { to: doing });
      const [p1, p2] = await contended(
        `SELECT id FROM work.task WHERE id = (SELECT id FROM core.record WHERE public_id = $1) FOR UPDATE`,
        [t.id],
        () =>
          [
            env.svc.applyTransition(
              member,
              ws,
              t.id,
              { to: doing, version: t.version, preview_token: pv.preview_token, approval: req.id },
              mutation(),
            ),
            env.svc.applyTransition(
              member,
              ws,
              t.id,
              { to: doing, version: t.version, preview_token: pv.preview_token, approval: req.id },
              mutation(),
            ),
          ] as const,
      );
      expect([outcome(p1), outcome(p2)].sort()).toEqual(['conflict', 'ok']);
      expect((await env.svc.getApproval(member, ws, req.id)).state).toBe('applied');
      expect(
        (
          await db.admin(
            `SELECT count(*)::int AS n FROM audit.audit_event WHERE workspace_id = $1 AND action = 'task.updated' AND target_public_id = $2`,
            [wsId, t.id],
          )
        ).rows[0].n,
      ).toBe(1);
      // Direct pooled app_rw: closing an already-closed request is refused by the database guard.
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [wsId]);
        await expect(
          c.query(
            `UPDATE workflow.approval_request SET closed_at = now(), closed_reason = 'withdrawn' WHERE public_id = $1`,
            [req.id],
          ),
        ).rejects.toThrow(/immutable/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }
    // A policy change while a request is pending stales it (the transition version moved).
    const t2 = (
      await env.svc.createTask(
        member,
        ws,
        { project: lastProject, title: 'Policy race' },
        mutation(),
      )
    ).data;
    const r2 = (
      await env.svc.requestApproval(
        member,
        ws,
        t2.id,
        { to: doing, version: t2.version },
        mutation(),
      )
    ).data;
    const w = await env.svc.getWorkflow(a, ws, wf.id);
    await env.svc.updateTransition(
      b,
      ws,
      wf.id,
      w.transitions[0]!.id,
      { transition: { allow_self_approval: true } },
      v(w.version),
    );
    expect((await env.svc.getApproval(member, ws, r2.id)).state).toBe('stale');
    await expect(
      env.svc.decideApproval(a, ws, r2.id, { decision: 'approve' }, mutation()),
    ).rejects.toEqual(expect.objectContaining({ code: 'conflict' }));
    // Direct pooled app_worker: it can neither decide nor reopen approvals.
    await expect(
      (async () => {
        const wk = new pg.Client({ connectionString: db.worker });
        await wk.connect();
        try {
          await wk.query('BEGIN');
          await wk.query(`SELECT set_config('app.workspace_id', $1, true)`, [wsId]);
          await wk.query(`UPDATE workflow.approval_request SET closed_at = NULL`);
        } finally {
          await wk.end();
        }
      })(),
    ).rejects.toThrow(/permission denied/);
  });
});
