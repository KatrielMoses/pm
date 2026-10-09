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

/**
 * Who may see a figure, and what changing that does (5C): revocation, trash and restore, departure,
 * another workspace, paging, the export, and the request limit, all on the same live authority.
 */
describe('Metrics authorization and delivery (5C)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller;
  let leaver: Caller;
  let outsider: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const proj: Record<string, string> = {};
  const tsk: string[] = [];
  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const completion = (as: Caller, q: Record<string, unknown> = {}) =>
    env.svc.getMetric(as, ws, 'project.completion', q) as Promise<any>;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    leaver = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    outsider = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    for (const who of [editor, leaver])
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: await mem(who),
        level: 'edit',
      });
    proj.a = (
      await env.svc.createProject(
        owner,
        ws,
        { brand: brands.Harbor, name: '=HYPERLINK("x")' },
        mutation(),
      )
    ).data.id;
    for (let i = 0; i < 7; i++)
      tsk.push(
        (
          await env.svc.createTask(
            owner,
            ws,
            { project: proj.a, title: `T${i}`, estimate_minutes: 10 },
            mutation(),
          )
        ).data.id,
      );
    const v = (await env.svc.getTask(owner, ws, tsk[0]!)).version;
    await env.svc.completeTask(owner, ws, tsk[0]!, {}, mutation({ ifMatch: `"${v}"` }));
  }, 240_000);
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  const fresh = async () => undefined;

  it('follows revocation, trash and restore, and departure on the very next request', async () => {
    await fresh();
    expect((await completion(editor)).parts).toEqual({ numerator: 1, denominator: 7 });
    await env.svc.taskLifecycle(owner, ws, tsk[1]!, 'trash', {}, mutation());
    expect((await completion(editor)).parts).toEqual({ numerator: 1, denominator: 6 });
    await env.svc.taskLifecycle(owner, ws, tsk[1]!, 'restore', {}, mutation());
    expect((await completion(editor)).parts).toEqual({ numerator: 1, denominator: 7 });
    await fresh();
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Harbor,
      principal: await mem(editor),
    });
    const after = await completion(editor);
    expect(after.parts).toEqual({ numerator: 0, denominator: 0 });
    expect(after.state).toBe('empty');
    await expect(completion(editor, { brand: brands.Harbor })).rejects.toEqual(
      expect.objectContaining({ code: 'validation_failed' }),
    );
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(editor),
      level: 'edit',
    });
    await fresh();
    expect((await completion(editor)).parts).toEqual({ numerator: 1, denominator: 7 });
    // A member who has left sees nothing of the workspace, not even that figures exist.
    const lm = await mem(leaver);
    const preview = await env.svc.previewChange(owner, ws, { kind: 'remove', member: lm });
    env.stepUp.allow = true;
    try {
      await env.svc.removeMember(
        owner,
        ws,
        lm,
        { preview_token: preview.preview_token },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
    await expect(completion(leaver)).rejects.toEqual(reason('not_found'));
  });

  it('keeps one workspace’s figures out of another’s, and refuses a stranger as an absent workspace', async () => {
    await fresh();
    const other = workEnv(db);
    const o = await workspaceWith(other, db, ['Else']);
    await other.svc.createProject(
      o.owner,
      o.ws,
      { brand: o.brands.Else, name: 'Theirs' },
      mutation(),
    );
    const mine = await completion(owner);
    expect(mine.parts).toEqual({ numerator: 1, denominator: 7 });
    expect((await other.svc.getMetric(o.owner, o.ws, 'project.completion', {})).state).toBe(
      'empty',
    );
    await expect(env.svc.getMetric(o.owner, ws, 'project.completion', {})).rejects.toEqual(
      reason('not_found'),
    );
    await expect(
      other.svc.getMetricRecords(owner, o.ws, 'project.completion', { member: 'numerator' }),
    ).rejects.toEqual(reason('not_found'));
    await expect(other.svc.listMetrics(owner, o.ws)).rejects.toEqual(reason('not_found'));
    await other.h.close();
  });

  it('pages a drill-through by a signed cursor that works for one person and one request only', async () => {
    await fresh();
    const q = { member: 'denominator', limit: 3, brand: brands.Harbor };
    const p1 = await env.svc.getMetricRecords(owner, ws, 'project.completion', q);
    expect(p1.total).toBe(7);
    expect(p1.items.length).toBe(3);
    expect(p1.page.next_cursor).toEqual(expect.any(String));
    const p2 = await env.svc.getMetricRecords(owner, ws, 'project.completion', {
      ...q,
      cursor: p1.page.next_cursor,
    });
    const p3 = await env.svc.getMetricRecords(owner, ws, 'project.completion', {
      ...q,
      cursor: p2.page.next_cursor,
    });
    expect(p3.items.length).toBe(1);
    expect(p3.page.next_cursor).toBeNull();
    const all = [...p1.items, ...p2.items, ...p3.items].map((i) => i.record.id);
    expect(new Set(all).size).toBe(7);
    expect(all.sort()).toEqual([...tsk].sort());
    // Not for another person, another metric role, or after tampering; and never a stack trace.
    await expect(
      env.svc.getMetricRecords(editor, ws, 'project.completion', {
        ...q,
        cursor: p1.page.next_cursor,
      }),
    ).rejects.toEqual(reason('cursor_invalid'));
    await expect(
      env.svc.getMetricRecords(owner, ws, 'project.completion', {
        ...q,
        member: 'numerator',
        cursor: p1.page.next_cursor,
      }),
    ).rejects.toEqual(reason('cursor_invalid'));
    const bad = Buffer.from(p1.page.next_cursor!, 'base64url')
      .toString()
      .replace('"m":"', '"m":"x');
    await expect(
      env.svc.getMetricRecords(owner, ws, 'project.completion', {
        ...q,
        cursor: Buffer.from(bad).toString('base64url'),
      }),
    ).rejects.toEqual(reason('cursor_invalid'));
    // Every item carries only public identifiers and no more than the viewer may read.
    expect(JSON.stringify(p1)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });

  it('exports the same figure as formula-safe CSV, with its definition, window, state, and digest', async () => {
    await fresh();
    const r = await completion(owner, { project: proj.a });
    const csv = await env.svc.exportMetric(owner, ws, 'project.completion', { project: proj.a });
    expect(csv.filename).toBe('project.completion-v1.csv');
    const rows = new Map(
      csv.body
        .trim()
        .split('\r\n')
        .slice(1)
        .map((l) => {
          const i = l.indexOf(',');
          return [l.slice(0, i), l.slice(i + 1)] as const;
        }),
    );
    expect(rows.get('metric')).toBe('project.completion');
    expect(rows.get('version')).toBe('1');
    expect(rows.get('state')).toBe(r.state);
    expect(rows.get('result_digest')).toBe(r.reproducibility.result_digest);
    expect(rows.get('definition_digest')).toBe(r.definition.digest);
    expect(rows.get('value.percent')).toBe(String(r.value.percent));
    expect(rows.get('parts.numerator')).toBe(String(r.parts!.numerator));
    expect(rows.get('parts.denominator')).toBe(String(r.parts!.denominator));
    // A project named like a formula is neutralized, so a spreadsheet never runs it.
    expect(csv.body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.body).not.toMatch(/(^|\r\n|,)"?=HYPERLINK/);
    // The export of a hidden project is the same absence as the figure.
    await expect(
      env.svc.exportMetric(outsider, ws, 'project.completion', { project: proj.a }),
    ).rejects.toEqual(expect.objectContaining({ code: 'validation_failed' }));
  });

  it('limits how fast one person may ask, per person and not for everyone', async () => {
    const slow = workEnv(db, { metricsRate: 3 });
    let limited: unknown = null;
    for (let i = 0; i < 12 && !limited; i++)
      await slow.svc.getMetric(outsider, ws, 'project.completion', {}).catch((e) => (limited = e));
    expect(limited).toEqual(reason('rate_limited'));
    expect(limited).toMatchObject({ retryAfterSeconds: expect.any(Number) });
    // Another person is not slowed by it.
    expect((await slow.svc.getMetric(owner, ws, 'project.completion', {})).state).toBeDefined();
    await slow.h.close();
  });
});
