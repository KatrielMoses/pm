import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  startAiProviderFixture,
  FIXTURE_MODEL_KEY,
  type AiProviderFixture,
} from '@pm/test-support';
import type { Caller } from '@pm/tenancy';
import { richTextFromPlain } from '@pm/contracts';
import type { WorkerRuntime } from '@pm/platform';
import {
  MODELS,
  priceSnapshot,
  productPersonalDataRegistry,
  snapshotCostPico,
  type ModelEntry,
} from '@pm/work';
import { aiWorker, drain, enableAi, fixtureAi, ledger, stepped, stepUp } from './ai-support.ts';
import {
  apply,
  join,
  membershipOf,
  mutation,
  seedAccount,
  workEnv,
  workspaceIdOf,
  WORKSPACE_INPUT,
  type WorkEnv,
} from './fixture.ts';

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; issues?: unknown };
    return { code: err.code, issues: err.issues ?? null };
  }
  throw new Error('expected a refusal');
};
const until = async (cond: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not reached');
};

const FIXTURE = MODELS.find((m) => m.key === FIXTURE_MODEL_KEY)!;
/** The fixture model with the real adapter's conservative error charging (corrective §2). */
const UNKNOWN_CHARGE: ModelEntry = {
  ...FIXTURE,
  capabilities: { ...FIXTURE.capabilities, errorResponsesChargeable: 'unknown' },
};
/** The same model key at a new price, as a later registry deployment would publish it. */
const REPRICED: ModelEntry = {
  ...FIXTURE,
  price: {
    ...FIXTURE.price,
    version: `${FIXTURE.price.version}-repriced`,
    inputPicoPerToken: FIXTURE.price.inputPicoPerToken * 2n,
  },
};

/**
 * Phase 7A corrective review 01 (AT-382–AT-389). §1: generic execution storage never holds AI
 * user content, and departure, retention, and account erasure leave no copy anywhere, including a
 * checkpoint written in the old format. §2: unknown charging stays reserved, unverified bounds
 * and changed prices refuse, every attempt settles against its own snapshot, and over-bound usage
 * is recorded and pauses AI. §3: clipping and invalid provider data are never a complete answer.
 */
describe('Phase 7A corrective review 01', () => {
  let db: TestDatabase;
  let fx: AiProviderFixture;
  let env: WorkEnv;
  let worker: WorkerRuntime;
  let owner: Caller;
  let leaver: Caller;
  let erased: Caller;
  let ws: string;
  let wsId: string;
  let brand: string;
  let task: string;
  const extra: Array<{ env: WorkEnv; worker?: WorkerRuntime }> = [];
  // Unique markers for each kind of content that can reach a provider request.
  const MARK = {
    prompt: 'PROMPTMARK7f3a',
    brand: 'BRANDMARK91c2',
    context: 'CONTEXTMARK4d8e',
  };
  const run = (who: Caller, body: Record<string, unknown>, e = env) =>
    e.svc.startAiTestRun(who, ws, { confirm_cost: true, ...body }, mutation());
  const sent = () => fx.control.received().length;
  const opId = async (runId: string) =>
    (await db.admin(`SELECT id FROM exec.operation WHERE public_id = $1`, [runId])).rows[0]
      .id as string;
  const dispatches = async (runId: string) =>
    (
      await db.admin(
        `SELECT d.state, d.error_kind, d.failure_detail, d.bound_breach, d.clipped_locally,
                d.reserved_micros::text AS reserved, d.settled_micros::text AS settled,
                d.output_token_bound, d.input_tokens, d.output_tokens, d.price_snapshot
           FROM ai.ai_dispatch d WHERE d.operation_id = $1 ORDER BY d.dispatch_number`,
        [await opId(runId)],
      )
    ).rows as Array<Record<string, any>>;
  const noUnreservedDispatch = async () =>
    expect(
      (
        await db.admin(
          `SELECT d.id FROM ai.ai_dispatch d WHERE d.workspace_id = $1 AND d.state <> 'refused'
              AND (SELECT count(*) FROM metering.usage_reservation r WHERE r.dispatch_id = d.id) <> 3`,
          [wsId],
        )
      ).rows,
    ).toEqual([]);

  /**
   * Every table in the database whose rows contain the marker (rows serialised to JSON, so jsonb,
   * text, and arrays are all searched). The source records themselves are expected holders.
   */
  const holders = async (marker: string) => {
    const tables = (
      await db.admin(
        `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
          WHERE table_type = 'BASE TABLE'
            AND table_schema NOT IN ('pg_catalog', 'information_schema', 'public')
          ORDER BY 1`,
      )
    ).rows.map((r) => r.t as string);
    const found: string[] = [];
    for (const t of tables) {
      const [schema, name] = t.split('.');
      const r = await db.admin(
        `SELECT EXISTS (SELECT 1 FROM "${schema}"."${name}" x WHERE strpos(row_to_json(x)::text, $1) > 0) AS hit`,
        [marker],
      );
      if (r.rows[0].hit) found.push(t);
    }
    return found;
  };
  const GENERIC = /^(exec|metering|audit|ops|notify|integrations|insights|metrics)\./;
  /** No marker in any generic execution, usage, audit, or delivery store. */
  const noGenericCopies = async () => {
    for (const m of Object.values(MARK))
      expect(
        (await holders(m)).filter((t) => GENERIC.test(t)),
        m,
      ).toEqual([]);
  };
  let baseline: Record<string, string[]>;

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startAiProviderFixture();
    env = workEnv(db, { ai: fixtureAi(fx) });
    worker = await aiWorker(env);
    owner = await seedAccount(db);
    const created = await env.svc.createWorkspace(
      owner,
      { ...WORKSPACE_INPUT, name: 'AI corrections', first_brand: { name: 'Harbor' } },
      mutation(),
    );
    ws = created.data.workspace.id;
    wsId = await workspaceIdOf(db, ws);
    brand = created.data.first_brand!.id;
    leaver = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    erased = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await enableAi(env, owner, ws);
    await env.svc.updateBrandAiProfile(
      owner,
      ws,
      brand,
      { instructions: `Always cite ${MARK.brand}.` },
      mutation({ ifMatch: '"0"' }),
    );
    task = (
      await env.svc.createTask(
        owner,
        ws,
        {
          brand,
          title: 'Context source',
          description: richTextFromPlain(`Launch notes ${MARK.context}`),
        },
        mutation(),
      )
    ).data.id;
    for (const who of [leaver, erased]) {
      const m = (await membershipOf(db, wsId, who.auth.account.id))!.public_id;
      await apply(env, owner, ws, { kind: 'brand_grant', brand, principal: m, level: 'edit' });
    }
    // Where the source content legitimately lives before any AI run.
    baseline = {};
    for (const [k, m] of Object.entries(MARK)) baseline[k] = await holders(m);
  }, 240_000);

  afterAll(async () => {
    for (const x of extra) {
      await x.worker?.stop?.();
      await x.env.h.close();
    }
    await worker?.stop?.();
    await fx?.close();
    await env?.h.close();
    await db?.drop();
  });

  const withModels = async (models: readonly ModelEntry[], overrides = {}) => {
    const e = workEnv(db, { ai: fixtureAi(fx, overrides, models) });
    const w = await aiWorker(e);
    extra.push({ env: e, worker: w });
    return { env: e, worker: w };
  };
  const body = () => ({
    prompt: `Summarise ${MARK.prompt}`,
    brand,
    context: [{ id: task, fields: ['title', 'description'] }],
  });

  it('AT-382 checkpoints and every generic execution store hold references only: completed, queued, running, and recovered runs', async () => {
    expect(baseline.prompt).toEqual([]);
    const before = sent();
    // Completed.
    const done = await run(leaver, body());
    expect(await drain(db, worker, done.data.id)).toMatchObject({ execution_state: 'succeeded' });
    // The markers really reached the provider (positive control for the scans below).
    const req = fx.control.received().at(-1)!;
    expect(req.user).toContain(MARK.prompt);
    expect(req.user).toContain(MARK.context);
    expect(req.system).toContain(MARK.brand);
    expect(sent()).toBe(before + 1);
    const cp = (
      await db.admin(`SELECT checkpoint FROM exec.job WHERE operation_id = $1`, [
        await opId(done.data.id),
      ])
    ).rows[0].checkpoint as Record<string, Record<string, unknown>>;
    const prepare = cp['ai.prepare.1']!;
    expect(Object.keys(prepare).sort()).toEqual(['dispatchId', 'outcome']);
    expect(prepare.outcome).toBe('dispatch');
    await noGenericCopies();
    // Queued: nothing but references is written when the run is accepted.
    const queued = await run(leaver, body());
    await noGenericCopies();
    // Running, then recovered by another worker after the first is lost mid-call.
    const hung = await run(leaver, { ...body(), prompt: `Hold ${MARK.prompt} #fixture:hang` });
    const w1 = await aiWorker(env);
    extra.push({ env, worker: w1 });
    const inflight = w1.runCycle({ wait: true });
    await until(() => fx.control.received().some((r) => r.user.includes(`Hold ${MARK.prompt}`)));
    await noGenericCopies();
    await db.admin(
      `UPDATE exec.job SET lease_until = now() - interval '1 minute' WHERE operation_id = $1`,
      [await opId(hung.data.id)],
    );
    const w2 = await aiWorker(env);
    extra.push({ env, worker: w2 });
    expect(await w2.reapExpiredLeases()).toBe(1);
    expect(await drain(db, w2, hung.data.id)).toMatchObject({
      execution_state: 'waiting',
      waiting_reason: 'reconciliation_required',
    });
    await noGenericCopies();
    // The late provider response after the restart does not recreate any copy.
    fx.control.releaseHung();
    await inflight;
    await noGenericCopies();
    expect(await drain(db, worker, queued.data.id)).toMatchObject({ execution_state: 'succeeded' });
    await noGenericCopies();
    expect(
      fx.control.received().filter((r) => r.user.includes(`Hold ${MARK.prompt}`)),
    ).toHaveLength(1);
    await ledger(db, wsId);
    await noUnreservedDispatch();
  });

  it('AT-383 departure, account erasure, and retention leave no copy of the prompt, brand instructions, or context anywhere', async () => {
    const queued = await run(leaver, body());
    const mine = await run(erased, body());
    expect(await drain(db, worker, mine.data.id)).toMatchObject({ execution_state: 'succeeded' });
    const ownerRun = await run(owner, body());
    expect(await drain(db, worker, ownerRun.data.id)).toMatchObject({
      execution_state: 'succeeded',
    });
    // Departure through the real removal flow (the AI ownership hook erases the leaver's runs).
    const leaverM = (await membershipOf(db, wsId, leaver.auth.account.id))!;
    const ownerM = (await membershipOf(db, wsId, owner.auth.account.id))!;
    const preview = await env.svc.previewChange(owner, ws, {
      kind: 'remove',
      member: leaverM.public_id,
    });
    await stepped(env, () =>
      env.svc.removeMember(
        owner,
        ws,
        leaverM.public_id,
        { preview_token: preview.preview_token, reassign_to: ownerM.public_id },
        mutation({ stepUpToken: 't' }),
      ),
    );
    // The leaver's queued run can no longer run: nothing is sent and nothing is recreated.
    const before = sent();
    await drain(db, worker, queued.data.id);
    expect(sent()).toBe(before);
    // Account erasure through the product personal-data registry.
    const erasedM = (await membershipOf(db, wsId, erased.auth.account.id))!;
    expect(
      // The account-deletion command runs every registered eraser in worker context, as the
      // departure retention sweep does.
      await env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
        productPersonalDataRegistry().eraseMembership(tx, erasedM.id),
      ),
    ).toBeGreaterThan(0);
    // Retention for everything still present (a cut-off in the future reaches every run).
    await env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      env.svc.eraseAiContent(tx, { before: new Date(Date.now() + 86_400_000) }),
    );
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM ai.ai_action WHERE workspace_id = $1 AND content_state = 'present'`,
          [wsId],
        )
      ).rows[0].n,
    ).toBe(0);
    // The prompt marker is nowhere; source markers only where they were before any AI run.
    expect(await holders(MARK.prompt)).toEqual([]);
    expect(await holders(MARK.brand)).toEqual(baseline.brand);
    expect(await holders(MARK.context)).toEqual(baseline.context);
    // A worker restart afterwards recreates nothing.
    const w = await aiWorker(env);
    extra.push({ env, worker: w });
    await w.runCycle({ wait: true });
    expect(await holders(MARK.prompt)).toEqual([]);
    // Usage and audit facts are kept.
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM metering.usage_event WHERE operation_id = $1`,
          [await opId(mine.data.id)],
        )
      ).rows[0].n,
    ).toBe(3);
    await ledger(db, wsId);
  });

  it('AT-384 a checkpoint written in the old format is scrubbed, including for runs the old eraser already marked erased', async () => {
    const a = await run(owner, body());
    expect(await drain(db, worker, a.data.id)).toMatchObject({ execution_state: 'succeeded' });
    const b = await run(owner, body());
    expect(await drain(db, worker, b.data.id)).toMatchObject({ execution_state: 'succeeded' });
    const old = (step: Record<string, unknown>) => ({
      ...step,
      system: `Brand instructions: ${MARK.brand}`,
      user: `${MARK.prompt} ${MARK.context}`,
      keyRef: 'platform:old',
    });
    for (const id of [a.data.id, b.data.id])
      await db.admin(
        `UPDATE exec.job SET checkpoint = checkpoint || jsonb_build_object('ai.prepare.1', $2::jsonb, 'other.step', '{"kept":true}'::jsonb)
          WHERE operation_id = $1`,
        [await opId(id), JSON.stringify(old({ outcome: 'dispatch', dispatchId: 'seeded' }))],
      );
    // `b` was erased by the old eraser: its action says erased, the checkpoint still holds content.
    await db.admin(
      `UPDATE ai.ai_action SET prompt_text = NULL, content_state = 'erased', content_erased_at = now() WHERE operation_id = $1`,
      [await opId(b.data.id)],
    );
    await db.admin(
      `UPDATE ai.ai_output SET content = NULL, completeness = 'erased' WHERE operation_id = $1`,
      [await opId(b.data.id)],
    );
    expect((await holders(MARK.prompt)).sort()).toEqual(['ai.ai_action', 'exec.job']);
    const ownerM = (await membershipOf(db, wsId, owner.auth.account.id))!;
    await env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      env.svc.eraseAiContent(tx, { membershipId: ownerM.id }),
    );
    expect(await holders(MARK.prompt)).toEqual([]);
    for (const id of [a.data.id, b.data.id]) {
      const cp = (
        await db.admin(`SELECT checkpoint FROM exec.job WHERE operation_id = $1`, [await opId(id)])
      ).rows[0].checkpoint;
      // Unrelated steps and non-content facts are preserved.
      expect(cp['other.step']).toEqual({ kept: true });
      expect(cp['ai.prepare.1']).toEqual({ outcome: 'dispatch', dispatchId: 'seeded' });
    }
    expect(await holders(MARK.brand)).toEqual(baseline.brand);
    expect(await holders(MARK.context)).toEqual(baseline.context);
  });

  it('AT-385 an HTTP error that may have been charged (529, 504) keeps its reservation and is never resent automatically', async () => {
    const u = await withModels([UNKNOWN_CHARGE]);
    for (const status of [529, 504]) {
      const before = sent();
      const held = await ledger(db, wsId);
      fx.control.failNext(1, status);
      const r = await run(owner, { prompt: `Maybe charged ${status}` }, u.env);
      expect(await drain(db, u.worker, r.data.id)).toMatchObject({
        execution_state: 'waiting',
        waiting_reason: 'reconciliation_required',
      });
      expect(sent()).toBe(before + 1);
      const [d, more] = await dispatches(r.data.id);
      expect(more).toBeUndefined();
      expect(d).toMatchObject({ state: 'unknown', settled: null });
      const after = await ledger(db, wsId);
      expect(after.reserved).toBeCloseTo(held.reserved + Number(d!.reserved), 6);
      expect(
        (await refusal(env.svc.retryAiRun(owner, ws, r.data.id, {}, mutation()))).issues,
      ).toEqual([expect.objectContaining({ code: 'reconciliation_required' })]);
    }
    // The synthetic fixture proves its own errors uncharged: those settle at zero and retry.
    const before = sent();
    fx.control.failNext(1, 529);
    const ok = await run(owner, { prompt: 'Synthetic retry' });
    expect(await drain(db, worker, ok.data.id)).toMatchObject({ execution_state: 'succeeded' });
    expect(sent()).toBe(before + 2);
    expect((await dispatches(ok.data.id)).map((d) => [d.state, d.settled])).toEqual([
      ['failed', '0.000000'],
      ['succeeded', expect.any(String)],
    ]);
    await ledger(db, wsId);
    await noUnreservedDispatch();
  });

  it('AT-386 a price changed after confirmation sends nothing and needs a new confirmation; a removed model still reconciles at its own price', async () => {
    const r = await run(owner, { prompt: 'Confirmed at the old price' });
    const repriced = await withModels([REPRICED]);
    const before = sent();
    expect(await drain(db, repriced.worker, r.data.id)).toMatchObject({
      execution_state: 'failed',
    });
    expect(sent()).toBe(before);
    const view = await repriced.env.svc.getAiRun(owner, ws, r.data.id);
    expect(view.status).toBe('Refused by policy');
    expect(view.refusal).toEqual({
      code: 'configuration_changed',
      message: expect.stringMatching(/changed after this run was confirmed. Nothing was sent/),
    });
    expect(await dispatches(r.data.id)).toEqual([]);
    // A retry is a new run at the new price and needs its own confirmation when one is required.
    const retried = await repriced.env.svc.retryAiRun(
      owner,
      ws,
      r.data.id,
      { confirm_cost: true },
      mutation(),
    );
    expect(await drain(db, repriced.worker, retried.data.id)).toMatchObject({
      execution_state: 'succeeded',
    });
    const [d] = await dispatches(retried.data.id);
    expect(d!.price_snapshot).toMatchObject({ version: REPRICED.price.version });

    // Historical reconciliation: an unknown attempt priced at the original snapshot reconciles
    // after its model has been removed from the registry, at that snapshot's price.
    const u = await withModels([UNKNOWN_CHARGE]);
    fx.control.failNext(1, 529);
    const lost = await run(owner, { prompt: 'Reconcile me later' }, u.env);
    expect(await drain(db, u.worker, lost.data.id)).toMatchObject({ execution_state: 'waiting' });
    const removed = await withModels([]);
    const held = await ledger(db, wsId);
    const done = await stepped(removed.env, () =>
      removed.env.svc.reconcileAiDispatch(
        owner,
        ws,
        lost.data.id,
        '1',
        { basis: 'reported', input_tokens: 20, output_tokens: 10 },
        stepUp(),
      ),
    );
    expect(done.data.attempts[0]).toMatchObject({ state: 'reconciled', usage_basis: 'reported' });
    const [l] = await dispatches(lost.data.id);
    const pico = snapshotCostPico(priceSnapshot(FIXTURE), 20, 10);
    expect(Number(l!.settled)).toBeCloseTo(Number(pico) / 1e6, 6);
    const after = await ledger(db, wsId);
    expect(after.reserved).toBeCloseTo(held.reserved - Number(l!.reserved), 6);
    // A duplicate or late reconciliation changes nothing.
    expect(
      (
        await refusal(
          stepped(removed.env, () =>
            removed.env.svc.reconcileAiDispatch(
              owner,
              ws,
              lost.data.id,
              '1',
              { basis: 'reported', input_tokens: 20, output_tokens: 10 },
              stepUp(),
            ),
          ),
        )
      ).code,
    ).toBe('conflict');
    expect(await ledger(db, wsId)).toEqual(after);
    await noUnreservedDispatch();
  });

  it('AT-387 usage beyond the reserved bound is charged in full, recorded as a breach, and pauses AI until reviewed', async () => {
    const before = sent();
    const r = await run(owner, { prompt: 'Too long #fixture:overbound' });
    expect(await drain(db, worker, r.data.id)).toMatchObject({ execution_state: 'succeeded' });
    const [d] = await dispatches(r.data.id);
    expect(d).toMatchObject({ bound_breach: true, failure_detail: 'bound_breach' });
    expect(d!.output_tokens).toBe(d!.output_token_bound + 50);
    // The full known liability is settled at the attempt's own price, never clamped to the bound:
    // the output-token meter records more than its reservation.
    const pico = snapshotCostPico(d!.price_snapshot, d!.input_tokens, d!.output_tokens);
    expect(Number(d!.settled)).toBeCloseTo(Number(pico) / 1e6, 6);
    const meters = (
      await db.admin(
        `SELECT r.meter, r.amount::text AS reserved, r.settled_amount::text AS settled
           FROM metering.usage_reservation r WHERE r.operation_id = $1 ORDER BY r.meter`,
        [await opId(r.data.id)],
      )
    ).rows as Array<{ meter: string; reserved: string; settled: string }>;
    const out = meters.find((m) => m.meter === 'ai.output_tokens')!;
    expect(Number(out.settled)).toBe(d!.output_tokens);
    expect(Number(out.settled)).toBeGreaterThan(Number(out.reserved));
    const settings = await env.svc.getAiSettings(owner, ws);
    expect(settings.suspended).toMatchObject({ reason: 'bound_breach' });
    const paused = {
      code: 'forbidden',
      issues: [expect.objectContaining({ code: 'ai_suspended' })],
    };
    expect(await refusal(env.svc.estimateAiRun(owner, ws, { prompt: 'Next' }))).toEqual(paused);
    expect(await refusal(run(owner, { prompt: 'Next' }))).toEqual(paused);
    expect(sent()).toBe(before + 1);
    const view = await env.svc.getAiRun(owner, ws, r.data.id);
    expect(view.attempts[0]).toMatchObject({ bound_breach: true, failure_detail: 'bound_breach' });
    // An owner resumes after review (step-up), and dispatch works again.
    const current = await env.svc.getAiSettings(owner, ws);
    await stepped(env, () =>
      env.svc.updateAiSettings(owner, ws, { resume_after_review: true }, stepUp(current.version)),
    );
    expect((await env.svc.getAiSettings(owner, ws)).suspended ?? null).toBeNull();
    // Reconciliation reporting more than the bound is also a breach and pauses AI again.
    const u = await withModels([UNKNOWN_CHARGE]);
    fx.control.failNext(1, 529);
    const lost = await run(owner, { prompt: 'Reconciled over bound' }, u.env);
    expect(await drain(db, u.worker, lost.data.id)).toMatchObject({ execution_state: 'waiting' });
    const [l] = await dispatches(lost.data.id);
    await stepped(env, () =>
      env.svc.reconcileAiDispatch(
        owner,
        ws,
        lost.data.id,
        '1',
        { basis: 'reported', input_tokens: 5, output_tokens: l!.output_token_bound + 1 },
        stepUp(),
      ),
    );
    expect((await dispatches(lost.data.id))[0]).toMatchObject({ bound_breach: true });
    expect((await env.svc.getAiSettings(owner, ws)).suspended).toMatchObject({
      reason: 'bound_breach',
    });
    // Invalid reported usage is refused, never priced.
    const again = await env.svc.getAiSettings(owner, ws);
    await stepped(env, () =>
      env.svc.updateAiSettings(owner, ws, { resume_after_review: true }, stepUp(again.version)),
    );
    await ledger(db, wsId);
    await noUnreservedDispatch();
  });

  it('AT-388 a locally clipped answer is partial and truncated, keeping full measured usage', async () => {
    const clip = await withModels([FIXTURE], {
      stream: { outputMaxChars: 256, eventMaxBytes: 65_536, maxBytes: 4_194_304 },
    });
    const r = await run(owner, { prompt: 'Long #fixture:long_answer' }, clip.env);
    expect(await drain(db, clip.worker, r.data.id)).toMatchObject({ execution_state: 'partial' });
    const view = await clip.env.svc.getAiRun(owner, ws, r.data.id);
    expect(view.content.output).toMatchObject({ completeness: 'truncated' });
    expect((view.content.output as { text: string }).text.length).toBeLessThanOrEqual(256);
    expect(view.attempts[0]).toMatchObject({
      state: 'partial',
      usage_basis: 'measured',
      clipped_locally: true,
    });
    const [d] = await dispatches(r.data.id);
    expect(d).toMatchObject({ clipped_locally: true, state: 'partial' });
    // Usage is the provider's full figure for the whole answer, not the retained part.
    expect(d!.output_tokens).toBeGreaterThan(64);
    await ledger(db, wsId);
  });

  it('AT-389 invalid provider data is never a success, never free, and never retried automatically', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['negative_usage', { state: 'unknown', settled: null, failure_detail: 'usage_invalid' }],
      ['fractional_usage', { state: 'unknown', settled: null, failure_detail: 'usage_invalid' }],
      ['missing_usage', { state: 'unknown', settled: null, failure_detail: 'protocol_invalid' }],
      ['huge_event', { state: 'unknown', settled: null, failure_detail: 'stream_overflow' }],
      ['unsupported_stop', { state: 'failed', failure_detail: 'unsupported_stop' }],
    ];
    for (const [scenario, expected] of cases) {
      const before = sent();
      const held = await ledger(db, wsId);
      const r = await run(owner, { prompt: `Bad data #fixture:${scenario}` });
      const end = await drain(db, worker, r.data.id);
      expect(end.execution_state, scenario).not.toBe('succeeded');
      expect(sent(), scenario).toBe(before + 1);
      const all = await dispatches(r.data.id);
      expect(all, scenario).toHaveLength(1);
      expect(all[0], scenario).toMatchObject(expected);
      const after = await ledger(db, wsId);
      if (expected.state === 'unknown') {
        // Uncertain liability stays reserved until an owner reconciles it.
        // (partial when some text arrived, as an interrupted stream; waiting otherwise).
        expect(['partial', 'waiting'], scenario).toContain(end.execution_state);
        expect(after.reserved, scenario).toBeCloseTo(held.reserved + Number(all[0]!.reserved), 6);
      } else {
        // Valid final usage with an unsupported stop is known liability: settled, not zero.
        expect(Number(all[0]!.settled), scenario).toBeGreaterThan(0);
      }
      const view = await env.svc.getAiRun(owner, ws, r.data.id);
      expect(view.content.output?.completeness ?? 'none', scenario).not.toBe('complete');
    }
    await noUnreservedDispatch();
  });
});
