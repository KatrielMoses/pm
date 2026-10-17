import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startAiProviderFixture, type AiProviderFixture } from '@pm/test-support';
import type { Caller } from '@pm/tenancy';
import { richTextFromPlain } from '@pm/contracts';
import type { WorkerRuntime } from '@pm/platform';
import { syntheticCaller } from '../../src/integrations/public-api-service.ts';
import { aiWorker, drain, enableAi, fixtureAi, ledger, stepped, stepUp } from './ai-support.ts';
import {
  apply,
  join,
  membershipOf,
  mutation,
  seedAccount,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  WORKSPACE_INPUT,
  type WorkEnv,
} from './fixture.ts';

type Who =
  'owner' | 'administrator' | 'member' | 'limited_member' | 'read_only' | 'guest' | 'leaver';
const ULID = '01J8M5Y7A3B2C4D6E8F0G1H2J3';
const CANARY_KEY = 'sk-ant-api03-CANARYcanaryCANARYcanary0000';

/** The whole refusal a caller observes: code and issues (nothing else may differ). */
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; issues?: unknown };
    return { code: err.code, issues: err.issues ?? null };
  }
  throw new Error('expected a refusal');
};

/**
 * Phase 7A gateway matrix: three workspaces; owner, administrator, member, limited and read-only
 * members, a guest, and a departing member; a sensitive brand; hidden and unknown sources;
 * revocation before dispatch and before history, replay, and export; redaction; unapproved
 * privacy; outage, rate limit, partial output, cancellation and late usage; retention and
 * departure. Every refusal is the gateway's, before any byte reaches the provider fixture.
 */
describe('Phase 7A AI gateway', () => {
  let db: TestDatabase;
  let fx: AiProviderFixture;
  let env: WorkEnv;
  let worker: WorkerRuntime;
  let ws: string;
  let wsId: string;
  let harbor: string;
  let vault: string;
  const P = {} as Record<Who, Caller>;
  const M = {} as Record<Who, string>;
  const T = {} as Record<'open' | 'vault' | 'shared' | 'hidden' | 'member', string>;
  const B = {} as { owner: Caller; ws: string; task: string; wsId: string };
  const C = {} as { owner: Caller; ws: string };
  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const grant = (who: Who, brand: string, level: string) =>
    apply(env, P.owner, ws, { kind: 'brand_grant', brand, principal: M[who], level });
  const revoke = (who: Who, brand: string) =>
    apply(env, P.owner, ws, { kind: 'brand_revoke', brand, principal: M[who] });
  const run = (who: Caller, body: Record<string, unknown>, req = mutation(), space = ws) =>
    env.svc.startAiTestRun(who, space, { confirm_cost: true, ...body }, req);
  const requests = () => fx.control.received();
  const n = async (sql: string, params: unknown[] = []) =>
    (await db.admin(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n as number;

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startAiProviderFixture();
    env = workEnv(db, { ai: fixtureAi(fx) });
    worker = await aiWorker(env);
    P.owner = await seedAccount(db);
    const created = await env.svc.createWorkspace(
      P.owner,
      { ...WORKSPACE_INPUT, name: 'AI gateway', first_brand: { name: 'Harbor' } },
      mutation(),
    );
    ws = created.data.workspace.id;
    wsId = await workspaceIdOf(db, ws);
    harbor = created.data.first_brand!.id;
    vault = (await env.svc.createBrand(P.owner, ws, { name: 'Vault' }, mutation())).data.id;
    await stepped(env, () =>
      env.svc.setSensitivity(P.owner, ws, vault, { is_sensitive: true }, stepUp(0)),
    );
    P.administrator = await join(env, db, P.owner, ws, { kind: 'member', role: 'administrator' });
    P.member = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    P.leaver = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    P.limited_member = await join(env, db, P.owner, ws, { kind: 'member', role: 'limited_member' });
    P.read_only = await join(env, db, P.owner, ws, { kind: 'member', role: 'read_only' });
    for (const who of Object.keys(P) as Who[]) M[who] = await mem(P[who]);
    await grant('owner', vault, 'manage');
    await grant('member', harbor, 'edit');
    await grant('leaver', harbor, 'edit');
    await grant('limited_member', harbor, 'view');
    await grant('read_only', harbor, 'view');
    const task = async (body: Record<string, unknown>) =>
      (await env.svc.createTask(P.owner, ws, body, mutation())).data.id;
    T.open = await task({
      brand: harbor,
      title: 'Open harbor brief',
      description: richTextFromPlain('Harbor launch notes'),
    });
    T.vault = await task({
      brand: vault,
      title: 'Vault omega plan',
      description: richTextFromPlain('Omega secret plan'),
    });
    T.shared = await task({ brand: harbor, title: 'Shared brief' });
    T.member = await task({ brand: harbor, title: 'Member brief' });
    P.guest = await join(env, db, P.owner, ws, {
      kind: 'guest',
      records: [{ record: T.shared, level: 'comment' }],
    });
    M.guest = await mem(P.guest);
    const b = await workspaceWith(env, db, ['Bravo']);
    B.owner = b.owner;
    B.ws = b.ws;
    B.wsId = await workspaceIdOf(db, b.ws);
    B.task = (
      await env.svc.createTask(
        B.owner,
        B.ws,
        { brand: b.brands.Bravo, title: 'Bravo private' },
        mutation(),
      )
    ).data.id;
    const c = await workspaceWith(env, db, ['Charlie']);
    C.owner = c.owner;
    C.ws = c.ws;
  }, 240_000);

  afterAll(async () => {
    await worker?.stop?.();
    await fx?.close();
    await env?.h.close();
    await db?.drop();
  });

  it('AT-354 AI starts disabled; disabled and unconfigured AI refuse truthfully and leave manual work usable', async () => {
    const overview = await env.svc.aiOverview(P.owner, ws);
    expect(overview.availability).toBe('disabled');
    expect(overview.manual_fallback).toMatch(/without it/);
    expect(await refusal(env.svc.estimateAiRun(P.owner, ws, { prompt: 'Hello' }))).toEqual({
      code: 'forbidden',
      issues: [expect.objectContaining({ code: 'ai_disabled' })],
    });
    // A deployment without a transport: unconfigured, healthy, and manual work still succeeds.
    const plain = workEnv(db);
    expect(plain.svc.aiReadiness()).toBe('not_configured');
    expect((await plain.svc.aiOverview(P.owner, ws)).availability).toBe('unconfigured');
    expect(await refusal(plain.svc.estimateAiRun(P.owner, ws, { prompt: 'Hello' }))).toEqual({
      code: 'dependency_unavailable',
      issues: [expect.objectContaining({ code: 'ai_unconfigured' })],
    });
    const manual = await plain.svc.createTask(
      P.owner,
      ws,
      { brand: harbor, title: 'Manual path' },
      mutation(),
    );
    expect(manual.data.id).toMatch(/^tsk_/);
    await plain.h.close();
    expect(requests()).toHaveLength(0);
  });

  it('AT-355 only owners and administrators manage providers, with step-up; members, limited, read-only, and guests cannot', async () => {
    for (const who of ['member', 'limited_member', 'read_only'] as const)
      expect((await refusal(env.svc.getAiSettings(P[who], ws))).code).toBe('forbidden');
    expect((await refusal(env.svc.getAiSettings(P.guest, ws))).code).toMatch(/forbidden|not_found/);
    // Without a step-up the change is challenged and nothing is stored.
    expect(
      (
        await refusal(
          env.svc.updateAiSettings(
            P.administrator,
            ws,
            { enabled: true, model_key: 'fixture/synthetic-messages@2026-10-17' },
            mutation({ ifMatch: '"0"' }),
          ),
        )
      ).code,
    ).toBe('step_up_required');
    expect(await n('ai.ai_provider_config')).toBe(0);
    const enabled = await enableAi(env, P.administrator, ws);
    expect(enabled.data).toMatchObject({ enabled: true, availability: 'ready', version: 1 });
    expect((await env.svc.aiOverview(P.member, ws)).availability).toBe('ready');
  });

  it('AT-356 a synthetic test run reserves, dispatches once, settles exactly, and records complete history', async () => {
    const before = requests().length;
    // Above the confirm-above threshold (0 by default) the person must confirm the estimate first.
    expect(
      await refusal(env.svc.startAiTestRun(P.member, ws, { prompt: 'Unconfirmed' }, mutation())),
    ).toEqual({
      code: 'conflict',
      issues: [
        expect.objectContaining({
          code: 'confirmation_required',
          message: expect.stringMatching(/could cost up to \$/),
        }),
      ],
    });
    const started = await run(P.member, {
      prompt: 'Summarize the brief',
      brand: harbor,
      context: [{ id: T.open }],
    });
    expect(started.status).toBe(202);
    const id = started.data.id;
    expect(started.data).toMatchObject({ state: 'queued', synthetic: true, purpose: 'test_run' });
    expect(await drain(db, worker, id)).toMatchObject({ execution_state: 'succeeded' });
    const detail = await env.svc.getAiRun(P.member, ws, id);
    expect(detail.content.state).toBe('present');
    expect(detail.content.prompt).toBe('Summarize the brief');
    expect(detail.content.output).toMatchObject({ completeness: 'complete' });
    expect(detail.content.output!.text).toMatch(/Synthetic fixture reply/);
    expect(detail.context).toEqual([
      expect.objectContaining({ id: T.open, included: true, available: true }),
    ]);
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]).toMatchObject({
      state: 'succeeded',
      usage_basis: 'measured',
      provider_request_id: expect.stringMatching(/^req_fixture_/),
    });
    expect(detail.attempts[0]!.input_tokens!).toBeLessThanOrEqual(
      detail.attempts[0]!.input_token_bound,
    );
    expect(requests().length).toBe(before + 1);
    const sent = requests().at(-1)!;
    expect(sent.user).toContain('Harbor launch notes');
    expect(sent.maxTokens).toBe(detail.estimate.output_token_bound);
    const l = await ledger(db, wsId);
    expect(l.reserved).toBe(0);
    expect(l.consumed).toBeGreaterThan(0);
    expect(l.consumed).toBe(l.settledReservations);
  });

  it('AT-357 roles and guests: execution follows ai.execute and workspace policy, never a provider answer', async () => {
    expect((await run(P.owner, { prompt: 'Owner check' })).status).toBe(202);
    expect((await run(P.administrator, { prompt: 'Admin check' })).status).toBe(202);
    expect((await refusal(run(P.limited_member, { prompt: 'Limited check' }))).code).toBe(
      'forbidden',
    );
    expect((await refusal(run(P.read_only, { prompt: 'Read only check' }))).code).toBe('forbidden');
    expect((await refusal(run(P.guest, { prompt: 'Guest check' }))).code).toMatch(
      /forbidden|not_found/,
    );
    expect((await refusal(env.svc.aiOverview(P.guest, ws))).code).toBe('not_found');
  });

  it('AT-358 hidden and unknown context sources are refused identically and nothing is sent', async () => {
    const before = requests().length;
    const hidden = await refusal(run(P.member, { prompt: 'Peek', context: [{ id: T.vault }] }));
    const unknown = await refusal(
      run(P.member, { prompt: 'Peek', context: [{ id: `tsk_${ULID}` }] }),
    );
    const foreign = await refusal(run(P.member, { prompt: 'Peek', context: [{ id: B.task }] }));
    expect(hidden).toEqual(unknown);
    expect(foreign).toEqual(unknown);
    expect(hidden).toEqual({
      code: 'forbidden',
      issues: [expect.objectContaining({ code: 'context_unavailable' })],
    });
    expect(requests().length).toBe(before);
  });

  it('AT-359 field, data-class, and sensitive-brand restrictions exclude content before it leaves', async () => {
    const before = requests().length;
    // The owner can read the sensitive brand, but restricted brands never reach AI in 7A.
    const est = await env.svc.estimateAiRun(P.owner, ws, {
      prompt: 'Compare',
      context: [{ id: T.vault }, { id: T.open, fields: ['title', 'budget_amount'] }],
    });
    expect(est.context).toEqual([
      expect.objectContaining({
        id: T.vault,
        included: false,
        exclusion_reason: 'sensitive_brand',
      }),
      expect.objectContaining({
        id: T.open,
        included: false,
        exclusion_reason: 'field_not_ai_eligible',
      }),
    ]);
    expect(
      (await refusal(env.svc.estimateAiRun(P.owner, ws, { prompt: 'x', brand: vault }))).issues,
    ).toEqual([expect.objectContaining({ code: 'ai_sensitive_brand' })]);
    const started = await run(P.owner, { prompt: 'Compare plans', context: [{ id: T.vault }] });
    await drain(db, worker, started.data.id);
    const mine = requests()
      .slice(before)
      .filter((r) => r.user.startsWith('Compare plans'));
    expect(mine).toHaveLength(1);
    const sent = mine[0]!;
    expect(sent.user).not.toContain('Omega');
    expect(sent.system).not.toContain('Omega');
  });

  it('AT-360 revocation before a queued dispatch stops it: no request, no reservation, no charge', async () => {
    const before = requests().length;
    const started = await run(P.leaver, {
      prompt: 'Use my brief',
      brand: harbor,
      context: [{ id: T.open }],
    });
    await revoke('leaver', harbor);
    expect(await drain(db, worker, started.data.id)).toMatchObject({ execution_state: 'failed' });
    const detail = await env.svc.getAiRun(P.leaver, ws, started.data.id);
    expect(detail.terminal_reason).toBe('policy_rejected');
    expect(detail.attempts).toHaveLength(0);
    expect(requests().length).toBe(before);
    expect(
      await n(
        `metering.usage_reservation r JOIN exec.operation o ON o.id = r.operation_id WHERE o.public_id = $1`,
        [started.data.id],
      ),
    ).toBe(0);
    await grant('leaver', harbor, 'edit');
  });

  it('AT-361 revocation withholds history, completed-key replays, and exports, and never resends', async () => {
    const req = mutation();
    const started = await run(
      P.member,
      { prompt: 'Brief me', brand: harbor, context: [{ id: T.member }] },
      req,
    );
    await drain(db, worker, started.data.id);
    const sentBefore = requests().length;
    expect((await env.svc.getAiRun(P.member, ws, started.data.id)).content.state).toBe('present');
    await revoke('member', harbor);
    const detail = await env.svc.getAiRun(P.member, ws, started.data.id);
    expect(detail.content).toMatchObject({ state: 'withheld', prompt: null, output: null });
    expect(detail.context[0]).toMatchObject({ id: null, available: false });
    // The same key re-renders through current authority and never dispatches again.
    const replay = await run(
      P.member,
      { prompt: 'Brief me', brand: harbor, context: [{ id: T.member }] },
      req,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.data.content).toMatchObject({ state: 'withheld', prompt: null });
    expect(requests().length).toBe(sentBefore);
    const exported = await env.svc.exportPortabilityHistory(P.member, ws, 'ai_history', {});
    expect(exported.csv).not.toContain('Brief me');
    expect(exported.csv).not.toContain('Synthetic fixture reply');
    expect(exported.csv).toContain(started.data.id);
    await grant('member', harbor, 'edit');
    expect((await env.svc.getAiRun(P.member, ws, started.data.id)).content.state).toBe('present');
  });

  it('AT-362 credentials are redacted before storage and dispatch; keys never reach history, logs, or errors', async () => {
    const started = await run(P.owner, {
      prompt: `Use key ${CANARY_KEY} and password=hunter22secret now`,
    });
    await drain(db, worker, started.data.id);
    const sent = requests().at(-1)!;
    expect(sent.user).not.toContain(CANARY_KEY);
    expect(sent.user).not.toContain('hunter22secret');
    expect(sent.user).toContain('[redacted credential]');
    const detail = await env.svc.getAiRun(P.owner, ws, started.data.id);
    expect(detail.content.prompt).not.toContain(CANARY_KEY);
    expect(detail.content.redactions).toBe(2);
    const stored = JSON.stringify((await db.admin(`SELECT * FROM ai.ai_action`)).rows);
    const logs = env.h.sink.lines.join('\n');
    for (const secret of [CANARY_KEY, 'hunter22secret', fx.apiKey]) {
      expect(stored).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect(sent.keyFingerprint).toBeTruthy();
  });

  it('AT-363 unapproved models, unsupported privacy, and disabled workspace keys refuse dispatch with a reason', async () => {
    const real = workEnv(db, {
      ai: {
        ...fixtureAi(fx),
        config: {
          ...fixtureAi(fx).config,
          provider: { provider: 'anthropic', baseUrl: fx.baseUrl, apiKey: null, timeoutMs: 1000 },
        },
      },
    });
    const settings = await real.svc.getAiSettings(P.owner, ws);
    expect(settings.models.map((m) => m.key)).toEqual(['anthropic/claude-haiku-5-5@2026-10-06']);
    expect(settings.models[0]).toMatchObject({
      approved_for_workspace_data: false,
      privacy: { zero_retention: false },
    });
    await stepped(real, () =>
      real.svc.updateAiSettings(
        P.owner,
        ws,
        { model_key: 'anthropic/claude-haiku-5-5@2026-10-06' },
        stepUp(settings.version),
      ),
    );
    expect(await refusal(real.svc.estimateAiRun(P.owner, ws, { prompt: 'Hi' }))).toEqual({
      code: 'forbidden',
      issues: [
        expect.objectContaining({
          code: 'ai_not_approved',
          message: expect.stringMatching(/not been approved/),
        }),
      ],
    });
    // Back to the fixture model; workspace keys stay off (OD-46).
    const s2 = await env.svc.getAiSettings(P.owner, ws);
    await stepped(env, () =>
      env.svc.updateAiSettings(
        P.owner,
        ws,
        { model_key: 'fixture/synthetic-messages@2026-10-17' },
        stepUp(s2.version),
      ),
    );
    expect(
      (
        await refusal(
          stepped(env, () =>
            env.svc.updateAiSettings(
              P.owner,
              ws,
              { key_source: 'workspace' },
              stepUp(s2.version + 1),
            ),
          ),
        )
      ).issues,
    ).toEqual([expect.objectContaining({ code: 'ai_byok_disabled' })]);
    expect(
      (
        await refusal(
          stepped(env, () =>
            env.svc.setAiWorkspaceKey(P.owner, ws, { key: 'x'.repeat(32) }, stepUp()),
          ),
        )
      ).issues,
    ).toEqual([expect.objectContaining({ code: 'ai_byok_disabled' })]);
    expect(
      (
        await refusal(
          stepped(env, () =>
            env.svc.updateAiSettings(P.owner, ws, { max_data_class: 'C3' }, stepUp(s2.version + 1)),
          ),
        )
      ).code,
    ).toBe('validation_failed');
    await real.h.close();
  });

  it('AT-364 outage and rate limits: bounded retries of zero-cost failures only, Retry-After honored, never a false success', async () => {
    const before = requests().length;
    const outage = await run(P.owner, { prompt: 'Always overloaded #fixture:overloaded' });
    expect(await drain(db, worker, outage.data.id)).toMatchObject({ execution_state: 'failed' });
    const o = await env.svc.getAiRun(P.owner, ws, outage.data.id);
    expect(o.status).toBe('Failed');
    expect(o.attempts.map((a) => [a.state, a.usage_basis, a.settled?.micros])).toEqual([
      ['failed', 'not_charged', '0.000000'],
      ['failed', 'not_charged', '0.000000'],
      ['failed', 'not_charged', '0.000000'],
    ]);
    expect(requests().length).toBe(before + 3);
    const limited = await run(P.owner, { prompt: 'Once #fixture:rate_limit_once' });
    await worker.runCycle({ wait: true });
    const job = (
      await db.admin(
        `SELECT state, run_at FROM exec.job WHERE operation_id = (SELECT id FROM exec.operation WHERE public_id = $1)`,
        [limited.data.id],
      )
    ).rows[0];
    expect(job.state).toBe('retry_scheduled');
    expect(new Date(job.run_at).getTime()).toBeGreaterThan(Date.now() + 500);
    expect(await drain(db, worker, limited.data.id)).toMatchObject({
      execution_state: 'succeeded',
    });
    const auth = await run(P.owner, { prompt: 'Bad key #fixture:auth' });
    expect(await drain(db, worker, auth.data.id)).toMatchObject({ execution_state: 'failed' });
    expect((await env.svc.getAiRun(P.owner, ws, auth.data.id)).attempts).toHaveLength(1);
    await ledger(db, wsId);
  });

  it('AT-365 partial output is kept and labelled; an interrupted stream holds its reservation as unknown', async () => {
    const truncated = await run(P.owner, { prompt: 'Long answer #fixture:truncate' });
    expect(await drain(db, worker, truncated.data.id)).toMatchObject({
      execution_state: 'partial',
    });
    const t = await env.svc.getAiRun(P.owner, ws, truncated.data.id);
    expect(t.content.output).toMatchObject({ completeness: 'truncated' });
    expect(t.attempts[0]).toMatchObject({ state: 'partial', usage_basis: 'measured' });
    const cut = await run(P.owner, { prompt: 'Stream cut #fixture:interrupt' });
    expect(await drain(db, worker, cut.data.id)).toMatchObject({ execution_state: 'partial' });
    const c = await env.svc.getAiRun(P.owner, ws, cut.data.id);
    expect(c.content.output).toMatchObject({ completeness: 'partial' });
    expect(c.attempts[0]).toMatchObject({ state: 'unknown', settled: null });
    expect(c.cost.unknown_reserved.micros).not.toBe('0.000000');
    const l = await ledger(db, wsId);
    expect(l.reserved).toBeGreaterThan(0);
  });

  it('AT-366 cancellation is honest: a running call is closed, its cost stays accountable, and late usage settles once', async () => {
    const slow = await run(P.member, { prompt: 'Take your time #fixture:slow', brand: harbor });
    const cycle = worker.runCycle({ wait: true });
    for (let i = 0; i < 40; i++) {
      const s = (
        await db.admin(
          `SELECT state FROM ai.ai_dispatch d JOIN exec.operation o ON o.id = d.operation_id WHERE o.public_id = $1`,
          [slow.data.id],
        )
      ).rows[0];
      if (s) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const cancelled = await env.svc.cancelAiRun(P.member, ws, slow.data.id, mutation());
    expect(cancelled.data).toMatchObject({ cancelling: true, status: 'Cancelling…' });
    await cycle;
    expect(await drain(db, worker, slow.data.id)).toMatchObject({ execution_state: 'cancelled' });
    const after = await env.svc.getAiRun(P.member, ws, slow.data.id);
    expect(after.status).toBe('Cancelled (cost may still be charged)');
    expect(after.attempts[0]).toMatchObject({ state: 'unknown', cancel_observed: true });
    expect(after.cancellation_note).toMatch(/cannot be recalled/);
    // Late provider-reported usage settles once; a duplicate changes nothing.
    const before = await ledger(db, wsId);
    const reconciled = await stepped(env, () =>
      env.svc.reconcileAiDispatch(
        P.owner,
        ws,
        slow.data.id,
        '1',
        { basis: 'reported', input_tokens: 20, output_tokens: 10 },
        stepUp(),
      ),
    );
    expect(reconciled.data.attempts[0]).toMatchObject({
      state: 'reconciled',
      usage_basis: 'reported',
      input_tokens: 20,
      output_tokens: 10,
    });
    const mid = await ledger(db, wsId);
    expect(mid.reserved).toBeLessThan(before.reserved);
    expect(mid.consumed).toBeGreaterThan(before.consumed);
    expect(
      (
        await refusal(
          stepped(env, () =>
            env.svc.reconcileAiDispatch(
              P.owner,
              ws,
              slow.data.id,
              '1',
              { basis: 'reported', input_tokens: 20, output_tokens: 10 },
              stepUp(),
            ),
          ),
        )
      ).code,
    ).toBe('conflict');
    expect(await ledger(db, wsId)).toEqual(mid);
    // A member cannot reconcile spend.
    expect(
      (
        await refusal(
          stepped(env, () =>
            env.svc.reconcileAiDispatch(
              P.member,
              ws,
              slow.data.id,
              '1',
              { basis: 'not_charged' },
              stepUp(),
            ),
          ),
        )
      ).code,
    ).toBe('forbidden');
  });

  it('AT-367 a queued run cancelled before dispatch never reaches the provider and costs nothing', async () => {
    const before = requests().length;
    const queued = await run(P.owner, { prompt: 'Never mind' });
    const res = await env.svc.cancelAiRun(P.owner, ws, queued.data.id, mutation());
    expect(res.data).toMatchObject({ state: 'cancelled', status: 'Cancelled' });
    await worker.runCycle({ wait: true });
    expect(requests().length).toBe(before);
    expect((await env.svc.getAiRun(P.owner, ws, queued.data.id)).attempts).toHaveLength(0);
    expect((await refusal(env.svc.cancelAiRun(P.owner, ws, queued.data.id, mutation()))).code).toBe(
      'conflict',
    );
  });

  it('AT-368 isolation across three workspaces: runs, usage, and context never cross', async () => {
    const mine = await run(P.owner, { prompt: 'Workspace A only' });
    expect((await refusal(env.svc.getAiRun(B.owner, B.ws, mine.data.id))).code).toBe('not_found');
    expect((await refusal(env.svc.getAiRun(B.owner, ws, mine.data.id))).code).toBe('not_found');
    expect((await refusal(env.svc.cancelAiRun(C.owner, C.ws, mine.data.id, mutation()))).code).toBe(
      'not_found',
    );
    expect((await env.svc.listAiRuns(B.owner, B.ws, {})).items).toEqual([]);
    const usageB = await env.svc.aiUsage(B.owner, B.ws);
    expect(usageB.runs).toEqual([]);
    expect(usageB.usage.consumed.micros).toBe('0.000000');
    expect((await refusal(env.svc.aiUsage(C.owner, ws))).code).toBe('not_found');
    expect(await n(`ai.ai_action WHERE workspace_id = $1`, [B.wsId])).toBe(0);
  });

  it("AT-369 an administrator sees usage metadata but never another person's prompt, output, or context", async () => {
    const mine = await run(P.member, {
      prompt: 'Private member prompt',
      brand: harbor,
      context: [{ id: T.member }],
    });
    await drain(db, worker, mine.data.id);
    const usage = await env.svc.aiUsage(P.administrator, ws);
    const entry = usage.runs.find((r) => r.id === mine.data.id)!;
    expect(entry).toBeDefined();
    expect(JSON.stringify(usage)).not.toContain('Private member prompt');
    expect(JSON.stringify(usage)).not.toContain('Synthetic fixture reply');
    expect(entry).not.toHaveProperty('content');
    expect((await refusal(env.svc.getAiRun(P.administrator, ws, mine.data.id))).code).toBe(
      'not_found',
    );
    expect((await refusal(env.svc.aiUsage(P.member, ws))).code).toBe('forbidden');
    expect(
      (await env.svc.listAiRuns(P.administrator, ws, {})).items.map((r) => r.id),
    ).not.toContain(mine.data.id);
  });

  it('AT-370 API and MCP delegations use the same gateway and lose execution when revoked before dispatch', async () => {
    const token = await stepped(env, () =>
      env.svc.createToken(
        P.owner,
        ws,
        { name: 'AI token', kind: 'personal', scopes: ['ai:execute', 'records:read'] },
        stepUp(),
      ),
    );
    const auth = (await env.svc.authenticateApiToken(token.data.secret!))!;
    const api = syntheticCaller(auth.accountId, auth.delegation, { correlationId: 'c'.repeat(32) });
    const viaApi = await run(api, { prompt: 'From the API' });
    // An MCP-sourced caller goes through the same gateway with the same accountable context.
    const mcp = syntheticCaller(
      auth.accountId,
      { ...auth.delegation, sourceKind: 'mcp' },
      { correlationId: 'd'.repeat(32) },
    );
    const viaMcp = await run(mcp, { prompt: 'From MCP' });
    for (const [id, kind] of [
      [viaApi.data.id, 'api'],
      [viaMcp.data.id, 'mcp'],
    ] as const) {
      expect((await env.svc.getAiRun(P.owner, ws, id)).caller_kind).toBe(kind);
      const ctx = (
        await db.admin(
          `SELECT authenticated_principal_type, effective_principal_type, delegation_chain FROM exec.operation WHERE public_id = $1`,
          [id],
        )
      ).rows[0];
      expect(ctx).toMatchObject({
        authenticated_principal_type: 'api_token_personal',
        effective_principal_type: 'member',
      });
      expect(ctx.delegation_chain).toHaveLength(2);
    }
    const before = requests().length;
    await env.svc.revokeToken(P.owner, ws, token.data.id, mutation());
    for (const id of [viaApi.data.id, viaMcp.data.id]) {
      expect(await drain(db, worker, id)).toMatchObject({ execution_state: 'failed' });
      expect((await env.svc.getAiRun(P.owner, ws, id)).attempts).toHaveLength(0);
    }
    expect(requests().length).toBe(before);
  });

  it("AT-371 departure erases the leaver's AI content but keeps usage and audit facts; retention erases aged content", async () => {
    const mine = await run(P.leaver, { prompt: 'Leaver prompt', brand: harbor });
    await drain(db, worker, mine.data.id);
    const leaverId = (await membershipOf(db, wsId, P.leaver.auth.account.id))!.id;
    const usageBefore = await n(
      `metering.usage_event e JOIN exec.operation o ON o.id = e.operation_id WHERE o.public_id = $1`,
      [mine.data.id],
    );
    expect(usageBefore).toBe(3);
    const erased = await env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      env.svc.eraseAiContent(tx, { membershipId: leaverId }),
    );
    expect(erased).toBeGreaterThan(0);
    const row = (
      await db.admin(
        `SELECT a.prompt_text, a.content_state FROM ai.ai_action a JOIN exec.operation o ON o.id = a.operation_id WHERE o.public_id = $1`,
        [mine.data.id],
      )
    ).rows[0];
    expect(row).toEqual({ prompt_text: null, content_state: 'erased' });
    expect(
      await n(
        `ai.ai_output WHERE content IS NOT NULL AND operation_id = (SELECT id FROM exec.operation WHERE public_id = $1)`,
        [mine.data.id],
      ),
    ).toBe(0);
    expect(
      await n(
        `metering.usage_event e JOIN exec.operation o ON o.id = e.operation_id WHERE o.public_id = $1`,
        [mine.data.id],
      ),
    ).toBe(usageBefore);
    expect((await env.svc.getAiRun(P.leaver, ws, mine.data.id)).content.state).toBe('erased');
    // Retention: content older than the cut-off is erased, newer content stays.
    const kept = await run(P.owner, { prompt: 'Recent prompt' });
    await drain(db, worker, kept.data.id);
    const aged = await env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      env.svc.eraseAiContent(tx, { before: new Date(Date.now() - 86_400_000) }),
    );
    expect(aged).toBe(0);
    expect((await env.svc.getAiRun(P.owner, ws, kept.data.id)).content.state).toBe('present');
  });

  it('AT-380 AI usage reaches dashboards through the 5D metric port for usage viewers only, without content', async () => {
    const used = await run(P.owner, { prompt: 'Usage source', brand: harbor });
    await drain(db, worker, used.data.id);
    const dash = await env.svc.createDashboard(
      P.owner,
      ws,
      { title: 'AI spend', kind: 'owner', layout: { widgets: [{ id: 'ai', metric: 'ai.usage' }] } },
      mutation(),
    );
    const value = async (who: Caller) =>
      (
        (await env.svc.dashboardWidget(who, ws, dash.data.id, 'ai', {})) as {
          outcome: Record<string, any>;
        }
      ).outcome;
    const mine = await value(P.owner);
    expect(mine.value).toBeGreaterThan(0);
    expect(mine.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine)).not.toContain('Summarize the brief');
    expect(JSON.stringify(mine)).not.toContain('Synthetic fixture reply');
    // A brand-scoped dashboard for a brand manager shows that brand's usage only.
    const brandDash = await env.svc.createDashboard(
      P.owner,
      ws,
      {
        title: 'Harbor AI',
        kind: 'brand',
        brand: harbor,
        layout: { widgets: [{ id: 'ai', metric: 'ai.usage' }] },
      },
      mutation(),
    );
    const b = (
      (await env.svc.dashboardWidget(P.owner, ws, brandDash.data.id, 'ai', {})) as {
        outcome: Record<string, any>;
      }
    ).outcome;
    expect(b.value).toBeGreaterThan(0);
    expect(b.rows.length).toBeGreaterThan(0);
    expect(b.rows.every((r: { cells: { brand: string } }) => r.cells.brand === 'Harbor')).toBe(
      true,
    );
    const catalog = await env.svc.insightMetrics(P.owner, ws);
    expect(catalog.metrics.map((m: { key: string }) => m.key)).toContain('ai.usage');
    expect(catalog.not_available.map((m: { key: string }) => m.key)).not.toContain('ai.usage');
  });
});
