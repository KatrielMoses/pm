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

type View = Awaited<ReturnType<WorkEnv['svc']['getBriefing']>>;
const stmt = (v: View, key: string) => v.statements.find((s) => s.key === key);
const text = (v: unknown) => JSON.stringify(v);
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  throw new Error('expected a refusal');
};
const BASIS_MAX = 1000;

/**
 * Phase 7E corrective review 02 (ADR-0042; AT-476–AT-480): overflow evidence fails closed. A figure
 * whose basis cannot be kept whole (above 1000 records for one query, or for the union of its
 * parts) refuses publication, so no lower bound, shown count, size flag, or coverage state is stored
 * without the evidence to re-check it. Large open-task sets state nothing beyond the examined tasks.
 */
describe('Phase 7E corrective review 02', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  const sql = async (q: string, params: unknown[] = []) => (await db.admin(q, params)).rows;
  const tick = () => new Promise((r) => setTimeout(r, 10));

  /** A workspace with a member who holds `edit` on its brand, and a project in that brand. */
  const space = async (name: string) => {
    const w = await workspaceWith(env, db, [name]);
    const wsId = await workspaceIdOf(db, w.ws);
    const brand = w.brands[name]!;
    const member = await join(env, db, w.owner, w.ws, { kind: 'member', role: 'member' });
    await apply(env, w.owner, w.ws, {
      kind: 'brand_grant',
      brand,
      principal: (await membershipOf(db, wsId, member.auth.account.id))!.public_id,
      level: 'edit',
    });
    const project = (
      await env.svc.createProject(w.owner, w.ws, { brand, name: `${name} work` }, mutation())
    ).data.id as string;
    const task = async (title: string, extra: Record<string, unknown> = {}) =>
      (await env.svc.createTask(w.owner, w.ws, { brand, project, title, ...extra }, mutation()))
        .data.id as string;
    return { ...w, wsId, brand, member, project, task };
  };
  /** Clones a template task `n` times in one statement (records and tasks), with overrides. */
  const bulk = async (template: string, n: number, set: Record<string, unknown> = {}) => {
    const cols = async (schema: string, table: string) =>
      (
        await sql(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2 AND is_generated = 'NEVER'
            ORDER BY ordinal_position`,
          [schema, table],
        )
      ).map((c) => `"${c.column_name as string}"`);
    const rc = (await cols('core', 'record')).join(', ');
    const tc = (await cols('work', 'task')).join(', ');
    return sql(
      `WITH ctx AS (SELECT set_config('app.workspace_id', (SELECT workspace_id::text FROM core.record WHERE public_id = $1), true) AS s),
            src_r AS (SELECT r.* FROM core.record r, ctx WHERE r.public_id = $1 AND ctx.s IS NOT NULL),
            src_t AS (SELECT t.* FROM work.task t JOIN src_r ON t.workspace_id = src_r.workspace_id AND t.id = src_r.id),
            ids AS (SELECT uuidv7() AS id,
                           'tsk_' || upper(substr(md5(random()::text || g::text), 1, 26)) AS pub, g
                      FROM generate_series(1, $2) g),
            r AS (INSERT INTO core.record (${rc})
                    SELECT ${rc} FROM (SELECT (jsonb_populate_record(NULL::core.record,
                              to_jsonb(src_r) || jsonb_build_object('id', ids.id, 'public_id', ids.pub))).*
                      FROM src_r, ids) x RETURNING id)
       INSERT INTO work.task (${tc})
         SELECT ${tc} FROM (SELECT (jsonb_populate_record(NULL::work.task,
                   to_jsonb(src_t) || jsonb_build_object('id', ids.id, 'title', src_t.title || ' #' || ids.g)
                   || $3::jsonb)).*
           FROM src_t, ids) y`,
      [template, n, JSON.stringify(set)],
    );
  };
  const trash = (s: Awaited<ReturnType<typeof space>>, id: string) =>
    env.svc.taskLifecycle(s.owner, s.ws, id, 'trash', {}, mutation());
  const generate = async (
    s: Awaited<ReturnType<typeof space>>,
    who: Caller,
    body: Record<string, unknown>,
  ) => (await env.svc.generateBriefing(who, s.ws, body, mutation())).data as View;
  const evidenceOf = async (brf: string) =>
    (
      await sql(
        `SELECT count(*)::int AS n FROM ai.briefing_evidence e JOIN ai.briefing b ON b.id = e.briefing_id WHERE b.public_id = $1`,
        [brf],
      )
    )[0]!.n as number;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('AT-476 an aggregate-only basis above 1000 records refuses publication: nothing contributor-dependent is stored, shown, replayed, corrected, or notified, before or after an unlisted contributor is trashed', async () => {
    const s = await space('Atlas');
    const template = await s.task('Atlas open work');
    await bulk(template, BASIS_MAX);
    // Generated as an authorized member: the project-status task counts list no rows, and their
    // basis (1001 readable tasks) exceeds the bound.
    const req = mutation();
    const b = (
      await env.svc.generateBriefing(
        s.member,
        s.ws,
        { kind: 'project_status', scope: { project: s.project } },
        req,
      )
    ).data as View;
    expect(b).toMatchObject({
      state: 'failed',
      failure_code: 'evidence_unverifiable',
      availability: 'none',
      statements: [],
      coverage: null,
    });
    expect(text(b)).not.toMatch(/1000|1001|More than|basis_too_large|open, |records contribute/);
    expect(await evidenceOf(b.id)).toBe(0);
    expect(
      await sql(
        `SELECT count(*)::int AS n FROM ai.briefing_statement st JOIN ai.briefing x ON x.id = st.briefing_id WHERE x.public_id = $1`,
        [b.id],
      ),
    ).toEqual([{ n: 0 }]);
    // No correction can be made from it, and the completed key replays the same refusal.
    expect(
      await refusal(
        env.svc.proposeBriefingCorrection(
          s.member,
          s.ws,
          b.id,
          { statement: 'project.task_counts', text: 'x' },
          mutation(),
        ),
      ),
    ).toBe('not_found');
    const replay = (
      await env.svc.generateBriefing(
        s.member,
        s.ws,
        { kind: 'project_status', scope: { project: s.project } },
        req,
      )
    ).data as View;
    expect(replay).toMatchObject({ id: b.id, state: 'failed', statements: [] });
    // A schedule for the same briefing refuses too, and no notice is created.
    const sch = (
      await env.svc.createBriefingSchedule(
        s.member,
        s.ws,
        {
          kind: 'project_status',
          scope: { project: s.project },
          timezone: 'UTC',
          local_time: '00:00',
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          channels: ['in_app', 'email'],
        },
        mutation(),
      )
    ).data;
    await sql(
      // The schedule's own occurrence (00:00 in its UTC zone, today), as an explicit instant: never
      // the database session's or the host's local midnight (7F review 01 verification repair).
      `UPDATE ai.briefing_schedule SET next_run_at = $2::timestamptz WHERE public_id = $1`,
      [sch.id, `${new Date().toISOString().slice(0, 10)}T00:00:00Z`],
    );
    expect(await env.svc.runBriefingSweep(env.h.worker, s.wsId, new Date())).toMatchObject({
      queued: 1,
      failed: 1,
      published: 0,
    });
    expect(
      await sql(
        `SELECT count(*)::int AS n FROM notify.notification WHERE workspace_id = $1 AND type = 'briefing_ready'`,
        [s.wsId],
      ),
    ).toEqual([{ n: 0 }]);
    // Trashing an unlisted contributor changes nothing: there is no saved figure to leak.
    const unlisted = (
      await sql(
        `SELECT r.public_id FROM core.record r JOIN work.task t ON t.id = r.id WHERE t.project_id = (SELECT id FROM core.record WHERE public_id = $1) AND r.public_id <> $2 LIMIT 1`,
        [s.project, template],
      )
    )[0]!.public_id as string;
    await trash(s, unlisted);
    const after = await env.svc.getBriefing(s.member, s.ws, b.id);
    expect(after).toMatchObject({ state: 'failed', statements: [], coverage: null });
  });

  it('AT-477 above 1000 open tasks, the blocked and stale figures state nothing beyond the examined tasks, so trashing an unexamined contributor leaves nothing to disclose', async () => {
    const s = await space('Boreal');
    const template = await s.task('Boreal open work');
    await sql(
      `UPDATE work.task SET last_meaningful_update_at = now() - interval '1 hour' WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
      [template],
    );
    await bulk(template, BASIS_MAX + 5);
    const newest = await s.task('Boreal newest open work');
    const b = await generate(s, s.member, { kind: 'owner_daily' });
    expect(b.state).toBe('published');
    for (const key of ['attention.blocked_count', 'attention.stale_count']) {
      const st = stmt(b, key)!;
      expect(st.figures).toMatchObject({ examined: 200, open_total: null });
      expect(st.text).not.toMatch(/others|of \d+ open tasks/);
    }
    expect((b.coverage as { sections: Record<string, unknown> }).sections.blocked).toMatchObject({
      state: 'partial',
      total: null,
      note: 'examined_subset',
    });
    // The newest task is not among the 200 examined, so it is in no basis and in no statement.
    expect(text(b)).not.toContain(newest);
    await trash(s, newest);
    const after = await env.svc.getBriefing(s.member, s.ws, b.id);
    expect(after.availability).toBe('available');
    expect(text(after)).not.toMatch(/others|of \d+ open tasks/);
    expect(stmt(after, 'attention.stale_count')!.figures).toMatchObject({ open_total: null });
  });

  it('AT-478 overflow only in the previous-window comparison refuses publication', async () => {
    const s = await space('Cirrus');
    const first = await generate(s, s.member, { kind: 'weekly_review' });
    expect(first.state).toBe('published');
    const template = await s.task('Cirrus finished work');
    await env.svc.completeTask(s.owner, s.ws, template, {}, mutation());
    const inside = new Date(new Date(first.window.start).getTime() + 60_000).toISOString();
    await sql(
      `UPDATE work.task SET completed_at = $2 WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
      [template, inside],
    );
    await bulk(template, BASIS_MAX, { completed_at: inside });
    await tick();
    const second = await generate(s, s.member, { kind: 'weekly_review' });
    expect(second).toMatchObject({
      state: 'failed',
      failure_code: 'evidence_unverifiable',
      statements: [],
    });
    expect(await evidenceOf(second.id)).toBe(0);
  });

  it('AT-479 exactly at the limit publishes with the whole basis and is withheld when any unlisted contributor is trashed; a fully authorized owner gets the same fail-closed refusal above it', async () => {
    const s = await space('Dune');
    const template = await s.task('Dune finished work');
    await env.svc.completeTask(s.owner, s.ws, template, {}, mutation());
    await bulk(template, BASIS_MAX - 1);
    const b = await generate(s, s.member, { kind: 'owner_daily' });
    expect(b.state).toBe('published');
    expect(stmt(b, 'completed.count')!.figures).toMatchObject({ total: BASIS_MAX, shown: 20 });
    expect(
      (
        await sql(
          `SELECT count(DISTINCT e.record_id)::int AS n FROM ai.briefing_evidence e JOIN ai.briefing x ON x.id = e.briefing_id
            JOIN ai.briefing_statement st ON st.briefing_id = x.id AND st.position = e.position
           WHERE x.public_id = $1 AND st.statement_key = 'completed.count'`,
          [b.id],
        )
      )[0]!.n,
    ).toBe(BASIS_MAX);
    const listed = new Set(b.statements.flatMap((x) => x.refs.map((r) => r.id)));
    const unlisted = (
      await sql(
        `SELECT r.public_id FROM core.record r JOIN work.task t ON t.id = r.id WHERE t.project_id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [s.project],
      )
    )
      .map((r) => r.public_id as string)
      .find((id) => !listed.has(id) && id !== template)!;
    await trash(s, unlisted);
    expect((await env.svc.getBriefing(s.member, s.ws, b.id)).availability).toBe('withheld');
    // One more contributor: the owner, who reads everything, is refused the same way.
    await bulk(template, 2);
    await tick();
    const own = await generate(s, s.owner, {
      kind: 'project_status',
      scope: { project: s.project },
    });
    expect(own).toMatchObject({
      state: 'failed',
      failure_code: 'evidence_unverifiable',
      statements: [],
    });
  });

  it('AT-480 parts within the limit whose union exceeds it refuse publication (current plus previous window)', async () => {
    const s = await space('Ember');
    const first = await generate(s, s.member, { kind: 'weekly_review' });
    const template = await s.task('Ember finished work');
    await env.svc.completeTask(s.owner, s.ws, template, {}, mutation());
    const inside = new Date(new Date(first.window.start).getTime() + 60_000).toISOString();
    // 600 in the previous window (backdated) and 501 in the current one: each part is under 1000.
    await bulk(template, 600, { completed_at: inside });
    await bulk(template, 500);
    await tick();
    const second = await generate(s, s.member, { kind: 'weekly_review' });
    expect(second).toMatchObject({
      state: 'failed',
      failure_code: 'evidence_unverifiable',
      statements: [],
    });
    expect(await evidenceOf(second.id)).toBe(0);
  });
});
