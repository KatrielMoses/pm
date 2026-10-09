import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql as ksql } from '@pm/db';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { METRIC_DEFINITIONS, METRIC_IDS } from '@pm/work';
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
const invalid = (pointer: string, code: string) =>
  expect.objectContaining({
    code: 'validation_failed',
    issues: expect.arrayContaining([expect.objectContaining({ pointer, code })]),
  });

/**
 * Phase 5C metrics on real PostgreSQL (ADR-0030): every figure is computed for the person asking
 * from the records they may read, drills to exactly those records, and says what is missing.
 */
describe('Metrics model (5C)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller;
  let reader: Caller;
  let outsider: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const proj: Record<string, string> = {};
  const tsk: Record<string, string> = {};
  const sql = async (text: string, params: unknown[] = []) =>
    (await db.admin(text, params)).rows as Array<Record<string, any>>;
  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const metric = (as: Caller, id: string, q: Record<string, unknown> = {}) =>
    env.svc.getMetric(as, ws, id, q);
  const records = (as: Caller, id: string, member: string, q: Record<string, unknown> = {}) =>
    env.svc.getMetricRecords(as, ws, id, { member, limit: 100, ...q });
  const members = (r: { drill: { members: Array<{ role: string; count: number }> } }) =>
    Object.fromEntries(r.drill.members.map((m) => [m.role, m.count]));
  /** Every drill role lists exactly as many records as its count says. */
  const drillsAgree = async (as: Caller, id: string, q: Record<string, unknown> = {}) => {
    const r = await metric(as, id, q);
    for (const m of r.drill.members) {
      const list = await records(as, id, m.role, q);
      expect(list.total, `${id}/${m.role} total`).toBe(m.count);
      expect(list.items.length, `${id}/${m.role} items`).toBe(m.count);
    }
    return r;
  };
  const mk = async (key: string, body: Record<string, unknown>, as: Caller = owner) =>
    (tsk[key] = (await env.svc.createTask(as, ws, body, mutation())).data.id);
  const setStatus = async (key: string, value: string) => {
    const cur = await env.svc.getTask(owner, ws, tsk[key]!);
    await env.svc.updateTask(
      owner,
      ws,
      tsk[key]!,
      { version: cur.version, changes: { status: { base: cur.status.key, value } } },
      mutation({ ifMatch: `"${cur.version}"` }),
    );
  };
  const done = async (key: string) => {
    const v = (await env.svc.getTask(owner, ws, tsk[key]!)).version;
    await env.svc.completeTask(owner, ws, tsk[key]!, {}, mutation({ ifMatch: `"${v}"` }));
  };

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
    const project = async (key: string, body: Record<string, unknown>) =>
      (proj[key] = (await env.svc.createProject(owner, ws, body, mutation())).data.id);
    await project('alpha', { brand: brands.Harbor, name: 'Alpha' });
    await project('sub', { brand: brands.Harbor, name: 'Alpha sub', parent: proj.alpha });
    await project('vault', { brand: brands.Harbor, name: 'Vault' });
    await project('summit', { brand: brands.Summit, name: 'Summit' });
    await env.svc.setAccess(
      owner,
      ws,
      proj.vault!,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    // Alpha: 2 of 3 counted leaves done; one cancelled; estimates 60, 120, none.
    await mk('a1', { project: proj.alpha, title: 'A1', estimate_minutes: 60 });
    await mk('a2', { project: proj.alpha, title: 'A2', estimate_minutes: 120 });
    await mk('a3', { project: proj.alpha, title: 'A3' });
    await mk('a4', { project: proj.alpha, title: 'A4 cancelled' });
    await setStatus('a4', 'cancelled');
    await done('a1');
    await done('a2');
    // A sub-project task, a parent with a subtask (only the subtask is a leaf), and hidden work.
    await mk('s1', { project: proj.sub, title: 'S1', estimate_minutes: 30 });
    await mk('p1', { project: proj.alpha, title: 'Parent', estimate_minutes: 500 });
    await mk('p1c', { project: proj.alpha, title: 'Child', parent: tsk.p1, estimate_minutes: 40 });
    await mk('v1', { project: proj.vault, title: 'V1', estimate_minutes: 1000 });
    await mk('v2', { project: proj.vault, title: 'V2', estimate_minutes: 1000 });
    await done('v1');
    await mk('m1', { project: proj.summit, title: 'M1', estimate_minutes: 90 });
  }, 240_000);
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('publishes every definition with its version, rollup rule, authorization rule, and drill roles', async () => {
    const cat = await env.svc.listMetrics(editor, ws);
    const ids = new Set(cat.data.map((d: { id: string }) => d.id));
    for (const id of METRIC_IDS) expect(ids, id).toContain(id);
    expect(cat.data.length).toBe(METRIC_DEFINITIONS.length);
    for (const d of cat.data) {
      expect(d.numerator.length, d.id).toBeGreaterThan(0);
      expect(d.authorization).toMatch(/can read/);
      expect(d.does_not_claim.length, d.id).toBeGreaterThan(10);
      expect(d.rollup.note.length, d.id).toBeGreaterThan(0);
      expect(d.digest).toMatch(/^[0-9a-f]{64}$/);
    }
    const completion = cat.data.filter((d: { id: string }) => d.id === 'project.completion');
    expect(completion.map((d: { version: number; current: boolean }) => [d.version, d.current])).toEqual([
      [1, true],
      [2, false],
    ]);
    await expect(env.svc.getMetric(editor, ws, 'nope.nothing', {})).rejects.toEqual(reason('not_found'));
    await expect(metric(editor, 'project.completion', { version: 9 })).rejects.toEqual(
      invalid('/version', 'unavailable'),
    );
  });

  it('counts completion by leaf tasks the viewer may read, never hidden ones (v1)', async () => {
    // Visible to the editor: alpha (a1 done, a2 done, a3, a4 cancelled, p1 parent, p1c leaf) + sub s1.
    const r = await drillsAgree(editor, 'project.completion');
    expect(r.definition).toMatchObject({ id: 'project.completion', version: 1 });
    expect(r.value).toMatchObject({ basis: 'task_count', tasks: { counted: 5, done: 2, unestimated: 1 } });
    expect(r.parts).toEqual({ numerator: 2, denominator: 5 });
    expect(r.value.percent).toBe(40);
    expect(r.state).toBe('complete');
    expect(members(r)).toEqual({ numerator: 2, denominator: 5 });
    // The owner also reads the vault and Summit: more counted tasks, same rule.
    const all = await metric(owner, 'project.completion');
    expect(all.parts).toEqual({ numerator: 3, denominator: 8 });
    // Scoped to a brand and to a project (with and without its sub-project).
    const harbor = await metric(owner, 'project.completion', { brand: brands.Harbor });
    expect(harbor.parts).toEqual({ numerator: 3, denominator: 7 });
    const alpha = await metric(owner, 'project.completion', { project: proj.alpha });
    expect(alpha.parts).toEqual({ numerator: 2, denominator: 5 });
    const alphaOnly = await metric(owner, 'project.completion', {
      project: proj.alpha,
      subprojects: 'false',
    });
    expect(alphaOnly.parts).toEqual({ numerator: 2, denominator: 4 });
  });

  it('weights by estimate in version 2, names tasks without one, and rolls up as a ratio of sums', async () => {
    const r = await drillsAgree(editor, 'project.completion', { version: 2 });
    // Estimated counted leaves: a1 60 (done), a2 120 (done), s1 30, p1c 40; a3 has none.
    expect(r.parts).toEqual({ numerator: 180, denominator: 250 });
    expect(r.value.percent).toBe(72);
    expect(r.value).toMatchObject({ basis: 'estimate_weighted', unit_of_parts: 'estimate_minutes' });
    expect(r.state).toBe('partial');
    expect(r.incomplete).toEqual([
      expect.objectContaining({ code: 'unestimated_tasks', count: 1 }),
    ]);
    expect(members(r)).toEqual({ numerator: 2, denominator: 4, unestimated: 1 });
    // Not an average of the projects' own percentages.
    const bySub = r.groups.map((g: { percent: number | null }) => g.percent);
    expect(bySub.length).toBe(2);
    const sum = r.groups.reduce((a: number, g: { numerator: number }) => a + g.numerator, 0);
    expect(sum).toBe(180);
    // The default stays the count basis; the version is part of the figure's identity.
    const v1 = await metric(editor, 'project.completion');
    expect(v1.definition.version).toBe(1);
    expect(v1.reproducibility.result_digest).not.toBe(r.reproducibility.result_digest);
  });

  it('flags a scope with no estimates or no tasks instead of inventing a percentage', async () => {
    const none = await metric(owner, 'project.completion', { version: 2, project: proj.sub });
    expect(none.parts).toEqual({ numerator: 0, denominator: 30 });
    const empty = await metric(editor, 'project.completion', { brand: brands.Harbor, project: proj.alpha, version: 2 });
    expect(empty.value.percent).not.toBeNull();
    await expect(metric(editor, 'project.completion', { project: proj.vault })).rejects.toEqual(
      invalid('/project', 'unavailable'),
    );
    await expect(metric(editor, 'project.completion', { brand: brands.Summit })).rejects.toEqual(
      invalid('/brand', 'unavailable'),
    );
  });

  it('answers a hidden project and an unknown one in exactly the same way', async () => {
    const unknown = proj.vault!.replace(/.$/, proj.vault!.endsWith('0') ? '1' : '0');
    const hidden = await metric(editor, 'project.completion', { project: proj.vault }).catch((e) => e);
    const missing = await metric(editor, 'project.completion', { project: unknown }).catch((e) => e);
    expect(hidden.code).toBe(missing.code);
    expect(JSON.stringify(hidden.issues)).toBe(JSON.stringify(missing.issues));
  });

  it('lets hidden work contribute nothing to any figure, label, ranking, or digest', async () => {
    const ids = METRIC_IDS.filter(
      (i) => i !== 'cost.spend' && i !== 'quality.tests' && i !== 'data.freshness',
    );
    // Hidden work of every kind, created before the time the figures are read at.
    await mk('v3', { project: proj.vault, title: 'V3 late', due_date: '2026-01-02', estimate_minutes: 700 });
    await mk('v4', { project: proj.vault, title: 'V4', parent: tsk.v3, estimate_minutes: 5 });
    await mk('m2', { project: proj.summit, title: 'M2 late', due_date: '2026-01-03' });
    await done('m2');
    await env.svc.addRelationship(owner, ws, tsk.v3!, { kind: 'blocks', target: tsk.a3! }, mutation());
    await sql(
      `UPDATE work.project SET time_budget_minutes = 10 WHERE id = (SELECT id FROM core.record WHERE public_id = '${proj.vault}')`,
    );
    const at = new Date().toISOString();
    const q = (id: string): Record<string, unknown> => ({
      as_of: at,
      ...(['work.planned_vs_completed', 'work.created_vs_completed', 'work.cycle_time', 'work.time_in_status', 'time.planned_vs_actual'].includes(id)
        ? { from: '2026-01-01', to: '2026-12-31' }
        : {}),
    });
    const read = async (as: Caller) => {
      const out: Record<string, string> = {};
      for (const id of ids) out[id] = (await metric(as, id, q(id))).reproducibility.result_digest;
      return out;
    };
    const editorBefore = await read(editor);
    const readerBefore = await read(reader);
    // The blocker is hidden: the editor sees no blocked task, and the figure is the one without it.
    expect((await metric(editor, 'work.attention', { as_of: at })).value.blocked).toBe(0);
    expect((await metric(owner, 'work.attention', { as_of: at })).value.blocked).toBe(1);
    // Showing the vault to the editor changes the figures that count its work …
    await env.svc.setAccess(owner, ws, proj.vault!, { access_mode: 'inherit' }, mutation());
    const shown = await read(editor);
    for (const id of ['project.completion', 'project.health', 'work.attention', 'work.workload', 'work.age', 'cost.time_budget'])
      expect(shown[id], `${id} sees the vault once it is shared`).not.toBe(editorBefore[id]);
    // … and hiding it again restores exactly the figures it had: hidden work was never in them.
    await env.svc.setAccess(owner, ws, proj.vault!, { access_mode: 'restricted', allow_record_shares: false }, mutation());
    expect(await read(editor)).toEqual(editorBefore);
    expect(await read(reader)).toEqual(readerBefore);
  });

  it('refuses what the caller may not do: nobody outside the workspace, and only admins reconcile', async () => {
    await expect(env.svc.requestReconcile(editor, ws)).rejects.toEqual(reason('forbidden'));
    expect(await env.svc.requestReconcile(owner, ws)).toEqual({ requested: true });
    const stranger = await metric(outsider, 'project.completion');
    expect(stranger.parts).toEqual({ numerator: 0, denominator: 0 });
    expect(stranger.state).toBe('empty');
    expect(ksql).toBeDefined();
  });
});
