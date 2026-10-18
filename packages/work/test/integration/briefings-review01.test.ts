import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaptureTransport } from '@pm/identity';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startAiProviderFixture, type AiProviderFixture } from '@pm/test-support';
import type { WorkerRuntime } from '@pm/platform';
import type { Caller } from '@pm/tenancy';
import {
  addDays,
  aiRetentionHandler,
  emailProviderFrom,
  runNotifyWorkspace,
  type NotifyJobDeps,
} from '@pm/work';
import { aiWorker, drain, enableAi, fixtureAi } from './ai-support.ts';
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

/**
 * Phase 7E corrective review 01 (ADR-0042 D11–D13; AT-468–AT-475). R1: the complete evidence basis
 * of every saved figure is re-authorized (unlisted contributors, previous-window contributors,
 * aggregates without listed rows, exact-brand timesheet approval), at display, replay, and send.
 * R2: correction notes obey the same evidence decision on every surface. R3: configured retention
 * discovers briefing content independently of AI runs and the real handler erases it.
 */
describe('Phase 7E corrective review 01', () => {
  let db: TestDatabase;
  let fx: AiProviderFixture;
  let env: WorkEnv;
  let worker: WorkerRuntime;
  let ws: string;
  let wsId: string;
  let owner: Caller;
  const B = {} as Record<'Harbor' | 'Summit', string>;
  let project: string;
  const today = new Date().toISOString().slice(0, 10);
  const sql = async (q: string, params: unknown[] = []) => (await db.admin(q, params)).rows;
  const mem = async (c: Caller, space = wsId) =>
    (await membershipOf(db, space, c.auth.account.id))!.public_id;
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const generate = async (who: Caller, body: Record<string, unknown>, req = mutation()) =>
    (await env.svc.generateBriefing(who, ws, body, req)).data as View;
  const task = async (title: string, extra: Record<string, unknown> = {}) =>
    (await env.svc.createTask(owner, ws, { brand: B.Harbor, project, title, ...extra }, mutation()))
      .data.id as string;
  const complete = (id: string) => env.svc.completeTask(owner, ws, id, {}, mutation());
  /** A guest who reads exactly the given tasks through record shares; returns share ids. */
  const guestWith = async (tasks: string[]) => {
    const g = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: tasks[0], level: 'comment' }],
    });
    const shares: Record<string, string> = {};
    for (const t of tasks.slice(1))
      shares[t] = (
        await env.svc.createShare(
          owner,
          ws,
          { record: t, grantee: await mem(g), level: 'read' },
          mutation(),
        )
      ).data.id as string;
    return { g, shares };
  };
  const revoke = (share: string) => env.svc.revokeShare(owner, ws, share, mutation());

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startAiProviderFixture();
    env = workEnv(db, { ai: fixtureAi(fx) });
    worker = await aiWorker(env);
    const w = await workspaceWith(env, db, ['Harbor', 'Summit']);
    owner = w.owner;
    ws = w.ws;
    Object.assign(B, w.brands);
    wsId = await workspaceIdOf(db, ws);
    project = (
      await env.svc.createProject(owner, ws, { brand: B.Harbor, name: 'Kestrel' }, mutation())
    ).data.id;
  });
  afterAll(async () => {
    await worker?.stop();
    await env.h.close();
    await fx.close();
    await db.drop();
  });

  it('AT-468 a revoked contributor outside the 20 listed items withholds the saved total wholesale; a fully authorized recipient keeps the canonical total', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) ids.push(await task(`Kestrel done ${i}`));
    for (const id of ids) await complete(id);
    // The guest reads all 22 through shares; the two oldest completions are not listed.
    const { g, shares } = await guestWith(ids);
    const req = mutation();
    const before = await generate(g, { kind: 'owner_daily' }, req);
    expect(stmt(before, 'completed.count')!.figures).toMatchObject({ total: 22, shown: 20 });
    expect(stmt(before, `completed.task:${ids[0]}`)).toBeUndefined();
    const coverage = before.coverage as { sections: Record<string, unknown> };
    expect(coverage.sections.completed).toMatchObject({ state: 'truncated', total: 22 });
    await revoke(shares[ids[1]!]!);
    const after = await env.svc.getBriefing(g, ws, before.id);
    expect(after).toMatchObject({ availability: 'withheld', statements: [], coverage: null });
    expect(text(after)).not.toMatch(/Kestrel|"total"/);
    // The same completed key replays through the same decision.
    const replay = (await env.svc.generateBriefing(g, ws, { kind: 'owner_daily' }, req)).data;
    expect(replay).toMatchObject({ id: before.id, availability: 'withheld', statements: [] });
    const list = await env.svc.listBriefings(g, ws, {});
    expect(text(list)).not.toMatch(/"total"|Kestrel/);
    // A fresh briefing counts only what the guest reads now, and says so as a new briefing.
    await tick();
    const fresh = await generate(g, { kind: 'owner_daily' });
    // Its comparison is recomputed as the guest now: 21, not the saved 22.
    expect(stmt(fresh, 'completed.count')!.figures).toMatchObject({ previous_window_total: 21 });
    // The owner, who reads everything, keeps the canonical total.
    const own = await generate(owner, { kind: 'owner_daily' });
    expect(
      (stmt(own, 'completed.count')!.figures as { total: number }).total,
    ).toBeGreaterThanOrEqual(22);
    expect((await env.svc.getBriefing(owner, ws, own.id)).availability).toBe('available');
  });

  it('AT-469 a contributor present only in the previous-window comparison withholds the later briefing', async () => {
    const x = await task('Prior-window only');
    const y = await task('Current window');
    await complete(x);
    const { g, shares } = await guestWith([y, x]);
    const first = await generate(g, { kind: 'weekly_review' });
    expect(stmt(first, `completed.task:${x}`)).toBeTruthy();
    await tick();
    await complete(y);
    const second = await generate(g, { kind: 'weekly_review' });
    expect(second.baseline).toBe(first.id);
    expect(stmt(second, `completed.task:${x}`)).toBeUndefined();
    expect(stmt(second, 'completed.count')!.figures).toMatchObject({
      total: 1,
      previous_window_total: 1,
    });
    await revoke(shares[x]!);
    expect((await env.svc.getBriefing(g, ws, second.id)).availability).toBe('withheld');
  });

  it('AT-470 an aggregate with no listed rows (the open-task basis) is re-authorized, and a briefing notice is suppressed at send time after the loss', async () => {
    const quiet = await task('Quiet open work');
    const shown = await task('Visible done work');
    await complete(shown);
    const { g, shares } = await guestWith([shown, quiet]);
    const b = await generate(g, { kind: 'owner_daily' });
    const staleCount = stmt(b, 'attention.stale_count')!;
    expect(staleCount.refs).toEqual([]);
    expect(staleCount.figures).toMatchObject({ total: 0, open_total: 1 });
    expect(text(b)).not.toMatch(/Quiet open work/);
    // A scheduled briefing for the same guest, with an email notice queued at publication.
    const daily = (
      await env.svc.createBriefingSchedule(
        g,
        ws,
        {
          kind: 'owner_daily',
          scope: {},
          timezone: 'UTC',
          local_time: '00:00',
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          channels: ['in_app', 'email'],
        },
        mutation(),
      )
    ).data;
    await sql(`UPDATE ai.briefing_schedule SET next_run_at = $2 WHERE public_id = $1`, [
      daily.id,
      new Date(`${today}T00:00:00Z`),
    ]);
    await env.svc.runBriefingSweep(env.h.worker, wsId, new Date());
    const scheduled = (
      await sql(
        `SELECT b.public_id FROM ai.briefing b JOIN ai.briefing_schedule s ON s.id = b.schedule_id WHERE s.public_id = $1`,
        [daily.id],
      )
    )[0]!.public_id as string;
    // Revoke the unlisted contributor before the email is sent.
    await revoke(shares[quiet]!);
    expect((await env.svc.getBriefing(g, ws, b.id)).availability).toBe('withheld');
    expect((await env.svc.getBriefing(g, ws, scheduled)).availability).toBe('withheld');
    const mail = new CaptureTransport();
    const deps: NotifyJobDeps = {
      tenant: env.h.worker,
      discovery: env.h.discovery,
      email: emailProviderFrom(mail, 'PM <no-reply@localhost>'),
      origin: 'https://pm.example.test',
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
      arrayMax: 10_000,
    };
    await runNotifyWorkspace(deps, wsId, new Date());
    const d = await sql(
      `SELECT d.state, d.suppress_reason FROM notify.delivery d JOIN notify.notification n ON n.id = d.notification_id
        WHERE n.type = 'briefing_ready' AND n.facts->>'briefing' = $1 AND d.channel = 'email'`,
      [scheduled],
    );
    expect(d).toEqual([{ state: 'suppressed', suppress_reason: 'access_lost' }]);
    expect(mail.messages.some((m) => text(m).includes(scheduled))).toBe(false);
  });

  it('AT-471 losing timesheet approval in brand A withholds a decision bound to brand A even while approval in brand B remains', async () => {
    const worker2 = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const approver = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: B.Harbor,
      principal: await mem(worker2),
      level: 'edit',
    });
    for (const brand of [B.Harbor, B.Summit])
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand,
        principal: await mem(approver),
        level: 'manage',
      });
    const harborTask = (
      await env.svc.createTask(owner, ws, { brand: B.Harbor, title: 'Harbor hours' }, mutation())
    ).data.id;
    const d = new Date(`${today}T00:00:00Z`);
    const monday = addDays(today, -(((d.getUTCDay() + 6) % 7) + 7));
    await env.svc.createEntry(
      worker2,
      ws,
      { target: harborTask, work_date: addDays(monday, 1), duration_minutes: 60 },
      mutation(),
    );
    await env.svc.submitTimesheet(worker2, ws, { period_start: monday }, mutation());
    const b = await generate(approver, { kind: 'owner_daily' });
    const decision = b.statements.find((s) => s.key.startsWith('decisions.timesheet:'));
    expect(decision).toBeTruthy();
    // Keep Harbor readable (view) but lose approval there; Summit approval stays.
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: B.Harbor,
      principal: await mem(approver),
    });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: B.Harbor,
      principal: await mem(approver),
      level: 'view',
    });
    const after = await env.svc.getBriefing(approver, ws, b.id);
    expect(after).toMatchObject({ availability: 'withheld', statements: [] });
    // Still approving elsewhere does not make the brand-A decision readable again.
    const fresh = await generate(approver, { kind: 'owner_daily' });
    expect(fresh.statements.some((s) => s.key.startsWith('decisions.timesheet:'))).toBe(false);
  });

  it('AT-472 correction notes follow source revocation on the list, commands, completed keys, and reuse; restored access restores them; other people never see them', async () => {
    const overdue = await task('Note source overdue', { due_date: addDays(today, -3) });
    const done = await task('Note source done');
    await complete(done);
    const { g, shares } = await guestWith([done, overdue]);
    const b = await generate(g, { kind: 'owner_daily' });
    const proposedReq = mutation();
    const proposed = (
      await env.svc.proposeBriefingCorrection(
        g,
        ws,
        b.id,
        { statement: `attention.overdue:${overdue}`, text: 'MARKER-PROPOSED-7E1' },
        proposedReq,
      )
    ).data;
    const approvedNote = (
      await env.svc.proposeBriefingCorrection(
        g,
        ws,
        b.id,
        { statement: 'attention.overdue_count', text: 'MARKER-APPROVED-7E1' },
        mutation(),
      )
    ).data;
    const approveReq = mutation({ ifMatch: `"${approvedNote.version}"` });
    await env.svc.decideBriefingCorrection(g, ws, approvedNote.id, 'approve', approveReq);
    await tick();
    const reused = await generate(g, { kind: 'owner_daily' });
    expect(text(reused)).toContain('Your approved note: MARKER-APPROVED-7E1');
    // Revoke only the overdue source; the guest's membership stays active.
    await revoke(shares[overdue]!);
    const list = await env.svc.listBriefingCorrections(g, ws, {});
    expect(text(list)).not.toMatch(/MARKER|attention\.overdue/);
    expect(list.items.map((i) => i.id)).not.toContain(proposed.id);
    expect(list.items.map((i) => i.id)).not.toContain(approvedNote.id);
    // Commands refuse, and completed keys replay as withheld (no text, scope, or statement).
    expect(
      await refusal(env.svc.decideBriefingCorrection(g, ws, proposed.id, 'approve', mutation())),
    ).toBe('not_found');
    expect(
      await refusal(
        env.svc.updateBriefingCorrection(g, ws, proposed.id, { text: 'x' }, mutation()),
      ),
    ).toBe('not_found');
    const replayProposed = (
      await env.svc.proposeBriefingCorrection(
        g,
        ws,
        b.id,
        { statement: `attention.overdue:${overdue}`, text: 'MARKER-PROPOSED-7E1' },
        proposedReq,
      )
    ).data;
    expect(replayProposed).toMatchObject({
      id: proposed.id,
      availability: 'withheld',
      text: null,
      statement: null,
      scope: null,
    });
    const replayApprove = (
      await env.svc.decideBriefingCorrection(g, ws, approvedNote.id, 'approve', approveReq)
    ).data;
    expect(text(replayApprove)).not.toMatch(/MARKER|overdue/);
    // Future briefings neither show nor apply it, and it is not newly approved or marked stale.
    await tick();
    const later = await generate(g, { kind: 'owner_daily' });
    expect(text(later)).not.toMatch(/MARKER/);
    expect(
      await sql(
        `SELECT state FROM ai.briefing_correction WHERE public_id = ANY($1::text[]) ORDER BY public_id`,
        [[proposed.id, approvedNote.id].sort()],
      ),
    ).toEqual(
      [proposed.id, approvedNote.id]
        .sort()
        .map((id) => ({ state: id === proposed.id ? 'proposed' : 'approved' })),
    );
    // Another member and another workspace never see either note.
    const other = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    expect(text(await env.svc.listBriefingCorrections(other, ws, {}))).not.toMatch(/MARKER/);
    expect(
      await refusal(env.svc.decideBriefingCorrection(other, ws, proposed.id, 'reject', mutation())),
    ).toBe('not_found');
    // Restored access restores the notes under the same decision.
    await env.svc.createShare(
      owner,
      ws,
      { record: overdue, grantee: await mem(g), level: 'read' },
      mutation(),
    );
    const back = await env.svc.listBriefingCorrections(g, ws, {});
    expect(text(back)).toContain('MARKER-PROPOSED-7E1');
    expect(text(back)).toContain('MARKER-APPROVED-7E1');
  });

  it('AT-473 retention erasure removes notes that are not approved memory with their briefing; approved memory stays under its own evidence; changed evidence still goes stale', async () => {
    const t1 = await task('Retained note source', { due_date: addDays(today, -2) });
    const { g } = await guestWith([t1]);
    const b = await generate(g, { kind: 'owner_daily' });
    const keep = (
      await env.svc.proposeBriefingCorrection(
        g,
        ws,
        b.id,
        { statement: 'attention.overdue_count', text: 'MARKER-KEEP' },
        mutation(),
      )
    ).data;
    await env.svc.decideBriefingCorrection(g, ws, keep.id, 'approve', mutation());
    const drop = (
      await env.svc.proposeBriefingCorrection(
        g,
        ws,
        b.id,
        { statement: `attention.overdue:${t1}`, text: 'MARKER-DROP' },
        mutation(),
      )
    ).data;
    await sql(
      `UPDATE ai.briefing SET created_at = now() - interval '30 days' WHERE public_id = $1`,
      [b.id],
    );
    await env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      env.svc.eraseAiContent(tx, { before: new Date(Date.now() - 7 * 86_400_000) }),
    );
    expect((await env.svc.getBriefing(g, ws, b.id)).availability).toBe('erased');
    const notes = await sql(
      `SELECT public_id, state, text FROM ai.briefing_correction WHERE public_id = ANY($1::text[])`,
      [[keep.id, drop.id]],
    );
    expect(notes.find((n) => n.public_id === drop.id)).toMatchObject({
      state: 'erased',
      text: null,
    });
    expect(notes.find((n) => n.public_id === keep.id)).toMatchObject({
      state: 'approved',
      text: 'MARKER-KEEP',
    });
    const list = await env.svc.listBriefingCorrections(g, ws, {});
    expect(text(list)).toContain('MARKER-KEEP');
    expect(text(list)).not.toContain('MARKER-DROP');
    // A still-authorized evidence change makes the approved note stale, not authoritative.
    await tick();
    const t2 = await task('Second shared overdue', { due_date: addDays(today, -1) });
    await env.svc.createShare(
      owner,
      ws,
      { record: t2, grantee: await mem(g), level: 'read' },
      mutation(),
    );
    const later = await generate(g, { kind: 'owner_daily' });
    expect(text(later)).not.toContain('MARKER-KEEP');
    expect(
      (await sql(`SELECT state FROM ai.briefing_correction WHERE public_id = $1`, [keep.id]))[0]!
        .state,
    ).toBe('stale');
  });

  it('AT-474 configured retention discovers briefing content without AI runs (none, all erased, mixed) and the registered handler erases only expired content, repeatably and per workspace', async () => {
    const before = new Date(Date.now() - 7 * 86_400_000);
    const age = (id: string) =>
      sql(`UPDATE ai.briefing SET created_at = now() - interval '30 days' WHERE public_id = $1`, [
        id,
      ]);
    // A: briefings only, AI never enabled (fact-only).
    const a = await workspaceWith(env, db, ['Alpha']);
    const aBrief = (
      await env.svc.generateBriefing(a.owner, a.ws, { kind: 'owner_daily' }, mutation())
    ).data;
    await age(aBrief.id);
    // B: mixed — an expired AI run, an expired briefing, and a new briefing.
    const bw = await workspaceWith(env, db, ['Bravo']);
    await enableAi(env, bw.owner, bw.ws);
    const run = await env.svc.startAiTestRun(
      bw.owner,
      bw.ws,
      { prompt: 'Retention probe', confirm_cost: true },
      mutation(),
    );
    await drain(db, worker, run.data.id);
    const bOld = (
      await env.svc.generateBriefing(bw.owner, bw.ws, { kind: 'owner_daily' }, mutation())
    ).data;
    await age(bOld.id);
    await sql(
      `UPDATE ai.ai_action SET created_at = now() - interval '30 days' WHERE operation_id = (SELECT id FROM exec.operation WHERE public_id = $1)`,
      [run.data.id],
    );
    await tick();
    const bNew = (
      await env.svc.generateBriefing(bw.owner, bw.ws, { kind: 'weekly_review' }, mutation())
    ).data;
    // C: every AI run already erased, an expired briefing remains.
    const cw = await workspaceWith(env, db, ['Charlie']);
    await enableAi(env, cw.owner, cw.ws);
    const runC = await env.svc.startAiTestRun(
      cw.owner,
      cw.ws,
      { prompt: 'Erased probe', confirm_cost: true },
      mutation(),
    );
    await drain(db, worker, runC.data.id);
    const cId = await workspaceIdOf(db, cw.ws);
    await env.h.app.withWorkspace(cId, { module: 'test' }, async (tx) => {
      const { eraseAiContentRows } = await import('../../src/ai/lifecycle.ts');
      await eraseAiContentRows(tx, { before: new Date(Date.now() + 86_400_000) });
    });
    const cBrief = (
      await env.svc.generateBriefing(cw.owner, cw.ws, { kind: 'owner_daily' }, mutation())
    ).data;
    await age(cBrief.id);
    // D: a new briefing only (untouched).
    const dw = await workspaceWith(env, db, ['Delta']);
    const dBrief = (
      await env.svc.generateBriefing(dw.owner, dw.ws, { kind: 'owner_daily' }, mutation())
    ).data;
    const ids = {
      a: await workspaceIdOf(db, a.ws),
      b: await workspaceIdOf(db, bw.ws),
      c: cId,
      d: await workspaceIdOf(db, dw.ws),
    };
    // The AI-run discovery alone misses A and C; the briefing discovery finds them (ids only).
    const aiFound = await env.h.discovery.discoverAiRetentionWork(before, 100);
    expect(aiFound).toContain(ids.b);
    expect(aiFound).not.toContain(ids.a);
    expect(aiFound).not.toContain(ids.c);
    const found = await env.h.discovery.discoverBriefingRetentionWork(before, 100);
    expect(found).toEqual(expect.arrayContaining([ids.a, ids.b, ids.c]));
    expect(found).not.toContain(ids.d);
    expect((await env.h.discovery.discoverBriefingRetentionWork(before, 1)).length).toBe(1);
    const usageBefore = await sql(
      `SELECT count(*)::int AS n FROM metering.usage_event WHERE workspace_id = $1`,
      [ids.b],
    );
    const handler = aiRetentionHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      service: {
        runAiDispatch: env.svc.runAiDispatch.bind(env.svc),
        eraseAiContent: env.svc.eraseAiContent.bind(env.svc),
        runBriefingSweep: env.svc.runBriefingSweep.bind(env.svc),
        aiHistoryRetentionDays: () => 7,
      },
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
      maxAttempts: 3,
      timeoutMs: 20_000,
    });
    await handler.handle({} as never);
    const state = async (id: string) =>
      (await sql(`SELECT content_state FROM ai.briefing WHERE public_id = $1`, [id]))[0]!
        .content_state;
    expect(await state(aBrief.id)).toBe('erased');
    expect(await state(bOld.id)).toBe('erased');
    expect(await state(cBrief.id)).toBe('erased');
    expect(await state(bNew.id)).toBe('present');
    expect(await state(dBrief.id)).toBe('present');
    expect(
      await sql(
        `SELECT count(*)::int AS n FROM ai.briefing_statement s JOIN ai.briefing b ON b.id = s.briefing_id
          WHERE b.public_id = ANY($1::text[]) AND (s.text IS NOT NULL OR s.figures IS NOT NULL OR s.refs <> '[]'::jsonb)`,
        [[aBrief.id, bOld.id, cBrief.id]],
      ),
    ).toEqual([{ n: 0 }]);
    expect(
      (
        await sql(
          `SELECT content_state FROM ai.ai_action WHERE operation_id = (SELECT id FROM exec.operation WHERE public_id = $1)`,
          [run.data.id],
        )
      )[0]!.content_state,
    ).toBe('erased');
    expect(
      await sql(`SELECT count(*)::int AS n FROM metering.usage_event WHERE workspace_id = $1`, [
        ids.b,
      ]),
    ).toEqual(usageBefore);
    // Repeated sweeps find nothing more and change nothing.
    expect(await env.h.discovery.discoverBriefingRetentionWork(before, 100)).not.toEqual(
      expect.arrayContaining([ids.a]),
    );
    await handler.handle({} as never);
    expect(await state(bNew.id)).toBe('present');
    // With retention unset, the handler does nothing (OD-36: kept).
    const off = aiRetentionHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      service: {
        runAiDispatch: env.svc.runAiDispatch.bind(env.svc),
        eraseAiContent: env.svc.eraseAiContent.bind(env.svc),
        runBriefingSweep: env.svc.runBriefingSweep.bind(env.svc),
        aiHistoryRetentionDays: () => null,
      },
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
      maxAttempts: 3,
      timeoutMs: 20_000,
    });
    await age(dBrief.id);
    await off.handle({} as never);
    expect(await state(dBrief.id)).toBe('present');
  });

  it('AT-475 0058 corrective schema: protected evidence with forced RLS and no delete, and the least-privileged briefing retention discovery function', async () => {
    expect(
      await sql(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'ai.briefing_evidence'::regclass`,
      ),
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const grants = await sql(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'ai' AND table_name = 'briefing_evidence' AND grantee IN ('app_rw', 'app_worker')
        ORDER BY 1, 2`,
    );
    expect(grants).toEqual([
      { grantee: 'app_rw', privilege_type: 'INSERT' },
      { grantee: 'app_rw', privilege_type: 'SELECT' },
      { grantee: 'app_worker', privilege_type: 'INSERT' },
      { grantee: 'app_worker', privilege_type: 'SELECT' },
    ]);
    const fn = await sql(`
      SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner,
             has_function_privilege('dispatcher', p.oid, 'EXECUTE') AS dispatcher,
             has_function_privilege('app_rw', p.oid, 'EXECUTE') AS app,
             has_function_privilege('app_worker', p.oid, 'EXECUTE') AS worker
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'exec_dispatch' AND p.proname = 'discover_briefing_retention_work'`);
    expect(fn).toEqual([
      { prosecdef: true, owner: 'pm_scheduler', dispatcher: true, app: false, worker: false },
    ]);
    // Evidence rows hold references only, and every saved briefing statement has its basis.
    const cols = await sql(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'ai' AND table_name = 'briefing_evidence' ORDER BY ordinal_position`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      'id',
      'workspace_id',
      'briefing_id',
      'correction_id',
      'position',
      'kind',
      'record_id',
      'brand_id',
      'permission',
      // 7F: plan evidence references its planner proposal (a reference, like the others).
      'proposal_id',
    ]);
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM ai.briefing_evidence WHERE workspace_id = $1`, [
          wsId,
        ])
      )[0]!.n,
    ).toBeGreaterThan(0);
  });
});
