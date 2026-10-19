import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  executionContext,
  startEffectReceiverFixture,
  type EffectReceiverFixture,
} from '@pm/test-support';
import { LogErrorReporter } from '@pm/observability';
import {
  cancelOpenEffects,
  defineEffectDestination,
  DeferredAuditSink,
  EffectKeyConflictError,
  EffectNotSentError,
  enqueueJob,
  recordEffect,
  requestOperationCancel,
  startOperation,
  WorkerRuntime,
  type EffectBarriers,
  type EffectDestination,
  type JobHandler,
} from '@pm/platform';
import type { Caller } from '@pm/tenancy';
import { syntheticCaller } from '../../src/integrations/public-api-service.ts';
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

/** Registered destinations, one per retry capability (ADR-0045). */
const DEST = {
  unsafe: defineEffectDestination('test.receiver_unsafe', 'unsafe'),
  provider: defineEffectDestination('test.receiver_provider', 'idempotent_by_provider'),
  receiver: defineEffectDestination('test.receiver_dedup', 'deduplicated_by_receiver'),
  natural: defineEffectDestination('test.receiver_upsert', 'naturally_idempotent'),
} as const;
type Kind = keyof typeof DEST;
const DEDUP: Record<Kind, string> = {
  unsafe: 'none',
  provider: 'provider',
  receiver: 'receiver',
  natural: 'none',
};
/** Never written to the ledger, jobs, outbox, audit, or logs: only the receiver sees it. */
const PAYLOAD_MARKER = 'P8W0-private-payload';
const never = () => new Promise<void>(() => undefined);
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string; issues?: unknown };
    return { code: err.code, message: err.message, issues: err.issues ?? null };
  }
  throw new Error('expected a refusal');
};
const issueCodes = (r: { issues: unknown }) =>
  ((r.issues as Array<{ code: string }> | null) ?? []).map((i) => i.code);

/**
 * Safe recovery of external effects (P8-W0, ADR-0045; REL-FU-7A-01) through the real worker
 * runtime, real PostgreSQL transactions, leases, the reaper, and restarts, against a deterministic
 * local receiver. Barriers hold or fail each boundary (never sleeps or reruns); the receiver counts
 * what was actually applied, the ledger what was attempted. A barrier that never resolves, with the
 * worker killed, models a process that stopped at that point.
 */
describe('Safe recovery of external effects', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let rx: EffectReceiverFixture;
  let ws: string;
  let wsId: string;
  let ownerM: string;
  const P = {} as Record<'owner' | 'administrator' | 'member', Caller>;
  const workers: WorkerRuntime[] = [];
  let barriers: EffectBarriers = {};
  const sql = async (text: string, params: unknown[] = []) => (await db.admin(text, params)).rows;

  /** POSTs the effect to the receiver; only typed proof says "not sent". */
  const providerKeys = new Map<string, string[]>();
  const deliver = async (kind: Kind, key: string, providerKey: string) => {
    providerKeys.set(key, [...(providerKeys.get(key) ?? []), providerKey]);
    let res: Response;
    try {
      res = await fetch(`${rx.url}?dedup=${DEDUP[kind]}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': providerKey,
          'webhook-id': providerKey,
        },
        body: JSON.stringify({ key, note: PAYLOAD_MARKER }),
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code === 'ECONNREFUSED')
        throw new EffectNotSentError('refused_before_send', { cause: err });
      throw err;
    }
    if (res.status === 409) throw new EffectNotSentError('rejected_by_receiver');
    if (!res.ok) throw new Error(`receiver answered ${res.status}`);
    return { externalRef: ((await res.json()) as { ref: string }).ref };
  };
  /** Steps before and after one effect; the effect key is the job's payload reference. */
  const handlers: JobHandler[] = (Object.keys(DEST) as Kind[]).map((kind) => ({
    kind: `test.send_${kind}`,
    queue: 'default',
    handle: async (ctx) => {
      const key = ctx.job.payloadRef!;
      if (key.startsWith('crash-before-claim') && ctx.job.attemptNumber === 1)
        throw new Error('process stopped before the claim');
      await ctx.effect(`send:${key}`, DEST[kind], (providerKey) => deliver(kind, key, providerKey));
      await ctx.step('after_effect', async () => ({ done: true }));
    },
  }));
  const worker = async (overrides: { heartbeatIntervalMs?: number } = {}) => {
    const h = env.h;
    const j = h.config.jobs;
    const w = new WorkerRuntime({
      db: h.worker,
      discovery: h.discovery,
      handlers,
      consumers: [],
      params: {
        leaseDurationMs: j.leaseDurationMs,
        heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? j.heartbeatIntervalMs,
        backoffBaseMs: 1,
        backoffCapMs: 2,
        maxAttempts: 5,
        timeoutMs: 60_000,
        workspaceConcurrencyCap: 8,
        pollIntervalMs: 50,
        claimBatchSize: 10,
        shutdownGraceMs: 200,
        outboxReplayWindowMs: h.config.retention.outboxReplayWindowMs,
        maintenanceIntervalMs: 3_600_000,
        statsIntervalMs: 3_600_000,
      },
      buildId: 'test',
      logger: h.logger,
      metrics: h.telemetry.metrics,
      tracer: h.telemetry.tracer,
      errors: new LogErrorReporter(h.logger),
      random: () => 0,
      effectBarriers: {
        afterClaim: (k) => barriers.afterClaim?.(k) ?? Promise.resolve(),
        afterPerform: (k) => barriers.afterPerform?.(k) ?? Promise.resolve(),
        duringOutcome: (k) => barriers.duringOutcome?.(k) ?? Promise.resolve(),
      },
    });
    await w.start({ loop: false });
    workers.push(w);
    return w;
  };
  const start = async (kind: Kind, key: string, maxAttempts = 5) =>
    env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      startOperation(
        tx,
        {
          kind: 'report_run',
          context: executionContext(wsId, { type: 'member', id: ownerM }),
          initiatedBy: { type: 'human', id: ownerM },
          queue: 'default',
          jobKind: `test.send_${kind}`,
          payloadRef: key,
          maxAttempts,
          timeoutSeconds: 30,
          auditActionKey: 'report.run',
        },
        new DeferredAuditSink(),
      ),
    );
  const ledger = async (opId: string) =>
    (
      await sql(
        `SELECT e.state::text AS state, e.attempt_count, e.uncertainty_reason, e.not_sent_code, e.late_outcome,
                e.reconciliation_decision, e.version::int AS version, e.claim_token IS NOT NULL AS claimed
           FROM exec.external_effect e WHERE e.operation_id = $1`,
        [opId],
      )
    )[0];
  const op = async (opId: string) =>
    (
      await sql(
        `SELECT execution_state, waiting_reason, terminal_reason, outcome_detail, public_id FROM exec.operation WHERE id = $1`,
        [opId],
      )
    )[0]!;
  const expireLeases = (opId: string) =>
    sql(
      `UPDATE exec.job SET lease_until = now() - interval '1 second' WHERE operation_id = $1 AND state = 'leased'`,
      [opId],
    );
  /** Reaps, then cycles until no job of the operation is due (pulling retry delays forward). */
  const settle = async (w: WorkerRuntime, opId: string, max = 8) => {
    await w.runCycle({ wait: true });
    for (let i = 0; i < max; i++) {
      await sql(
        `UPDATE exec.job SET run_at = now() WHERE operation_id = $1 AND state IN ('queued', 'retry_scheduled')`,
        [opId],
      );
      const due = await sql(
        `SELECT 1 FROM exec.job WHERE operation_id = $1 AND state IN ('queued', 'retry_scheduled')`,
        [opId],
      );
      if (!due.length) return;
      await w.runCycle({ wait: true });
    }
  };
  /** Starts an operation on a worker that stops for good at `where`, then recovers it. */
  const crashAt = async (where: keyof EffectBarriers, kind: Kind, key: string) => {
    const reached = new Promise<void>((resolve) => {
      barriers = {
        [where]: (k: string) => {
          if (k !== `send:${key}`) return Promise.resolve();
          resolve();
          return never();
        },
      };
    });
    const started = await start(kind, key);
    const doomed = await worker();
    // The doomed worker is killed mid-cycle: its cycle ends in WorkerKilledError, by design.
    void doomed.runCycle().catch(() => undefined);
    await reached;
    doomed.kill();
    barriers = {};
    await expireLeases(started.id);
    const survivor = await worker();
    await settle(survivor, started.id);
    return { started, survivor };
  };
  const decide = (
    who: Caller,
    opPublic: string,
    key: string,
    body: Record<string, unknown>,
    req = mutation({ stepUpToken: 't' }),
    space = ws,
  ) => {
    env.stepUp.allow = true;
    return env.svc
      .reconcileExternalEffect(who, space, opPublic, `send:${key}`, body, req)
      .finally(() => (env.stepUp.allow = false));
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    rx = await startEffectReceiverFixture();
    const w = await workspaceWith(env, db, ['Harbor']);
    P.owner = w.owner;
    ws = w.ws;
    wsId = await workspaceIdOf(db, ws);
    ownerM = (await membershipOf(db, wsId, P.owner.auth.account.id))!.id;
    P.administrator = await join(env, db, P.owner, ws, { kind: 'member', role: 'administrator' });
    P.member = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    env.h.sink.clear();
  });
  afterEach(async () => {
    barriers = {};
    for (const w of workers.splice(0)) if (w.state === 'running') await w.stop();
  });
  afterAll(async () => {
    await rx.close();
    await env.h.close();
    await db.drop();
  });

  it('AT-539 crash after the receiver applied and answered, before the outcome was stored: recovered as unknown and never resent to an unsafe destination', async () => {
    const { started, survivor } = await crashAt('afterPerform', 'unsafe', 'after-response');
    expect(rx.applied('after-response')).toBe(1);
    expect(await ledger(started.id)).toMatchObject({
      state: 'unknown',
      attempt_count: 1,
      uncertainty_reason: 'abandoned_claim',
      claimed: false,
    });
    expect(await op(started.id)).toMatchObject({
      execution_state: 'waiting',
      waiting_reason: 'reconciliation_required',
    });
    // More cycles and another restart send nothing more.
    await settle(survivor, started.id);
    const restarted = await worker();
    await restarted.runCycle({ wait: true });
    expect(rx.received('after-response')).toBe(1);
    expect((await ledger(started.id))!.attempt_count).toBe(1);
  });

  it('AT-540 a crash before the claim retries once; a crash after the durable claim but before sending is unknown: unsafe waits, a safe class resends once with the same key', async () => {
    const before = await start('unsafe', 'crash-before-claim');
    const w = await worker();
    await settle(w, before.id);
    expect(rx.applied('crash-before-claim')).toBe(1);
    expect(await ledger(before.id)).toMatchObject({ state: 'sent', attempt_count: 1 });
    expect((await op(before.id)).execution_state).toBe('succeeded');

    const unsafe = await crashAt('afterClaim', 'unsafe', 'claimed-unsent');
    expect(rx.received('claimed-unsent')).toBe(0);
    expect(await ledger(unsafe.started.id)).toMatchObject({
      state: 'unknown',
      attempt_count: 1,
      uncertainty_reason: 'abandoned_claim',
    });
    expect((await op(unsafe.started.id)).waiting_reason).toBe('reconciliation_required');

    const safe = await crashAt('afterClaim', 'provider', 'claimed-unsent-safe');
    expect(rx.received('claimed-unsent-safe')).toBe(1);
    expect(rx.applied('claimed-unsent-safe')).toBe(1);
    expect(await ledger(safe.started.id)).toMatchObject({ state: 'sent', attempt_count: 2 });
    expect((await op(safe.started.id)).execution_state).toBe('succeeded');
  });

  it('AT-541 the receiver applied but the answer never arrived (held or dropped): unknown, never resent; a stale worker’s late answer is kept as evidence only', async () => {
    // Held answer: the worker stays alive but loses its lease; another worker recovers the claim.
    const held = rx.holdAfterApply('held-answer');
    const started = await start('unsafe', 'held-answer');
    const stale = await worker({ heartbeatIntervalMs: 3_600_000 });
    const staleRun = stale.runCycle({ wait: true });
    await held.reached;
    await expireLeases(started.id);
    const survivor = await worker();
    await settle(survivor, started.id);
    expect(await ledger(started.id)).toMatchObject({
      state: 'unknown',
      uncertainty_reason: 'abandoned_claim',
    });
    held.release();
    await staleRun;
    expect(await ledger(started.id)).toMatchObject({
      state: 'unknown',
      late_outcome: 'sent',
      attempt_count: 1,
    });
    expect(rx.applied('held-answer')).toBe(1);
    expect((await op(started.id)).waiting_reason).toBe('reconciliation_required');
    // Dropped connection after applying: a generic error is not proof of anything.
    rx.dropAfterApply('dropped');
    const dropped = await start('unsafe', 'dropped');
    await settle(await worker(), dropped.id);
    expect(rx.applied('dropped')).toBe(1);
    expect(await ledger(dropped.id)).toMatchObject({
      state: 'unknown',
      uncertainty_reason: 'unproven_failure',
      attempt_count: 1,
    });
    expect((await op(dropped.id)).waiting_reason).toBe('reconciliation_required');
  });

  it('AT-542 a failed outcome write leaves the claim; recovery records it unknown and nothing is resent', async () => {
    barriers = {
      duringOutcome: async (k) => {
        if (k === 'send:outcome-write') throw new Error('the outcome transaction failed');
      },
    };
    const started = await start('unsafe', 'outcome-write');
    const w = await worker();
    await w.runCycle({ wait: true });
    barriers = {};
    expect(rx.applied('outcome-write')).toBe(1);
    await settle(w, started.id);
    expect(await ledger(started.id)).toMatchObject({
      state: 'unknown',
      uncertainty_reason: 'abandoned_claim',
      attempt_count: 1,
    });
    expect(rx.received('outcome-write')).toBe(1);
    expect((await op(started.id)).waiting_reason).toBe('reconciliation_required');
  });

  it('AT-543 overlapping claimants: a live claim is never dispatched twice; the second claimant waits and then finds it sent', async () => {
    const hold = rx.holdBeforeApply('overlap');
    const started = await start('provider', 'overlap');
    // A second job of the same operation (a duplicate enqueue) races the first.
    await env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      enqueueJob(tx, {
        queue: 'default',
        kind: 'test.send_provider',
        context: executionContext(wsId, { type: 'member', id: ownerM }),
        operationId: started.id,
        payloadRef: 'overlap',
        maxAttempts: 5,
        timeoutSeconds: 30,
      }),
    );
    const a = await worker();
    const b = await worker();
    const running = a.runCycle({ wait: true });
    await hold.reached;
    await b.runCycle({ wait: true });
    expect(rx.received('overlap')).toBe(1);
    expect(env.h.sink.lines.some((l) => l.includes('effect_in_flight'))).toBe(true);
    hold.release();
    await running;
    await settle(b, started.id);
    expect(rx.received('overlap')).toBe(1);
    expect(rx.applied('overlap')).toBe(1);
    expect(await ledger(started.id)).toMatchObject({ state: 'sent', attempt_count: 1 });
  });

  it('AT-544 cancellation stops undispatched work and future attempts but reports what may have left', async () => {
    // Before the claim: nothing is recorded or sent.
    const early = await start('unsafe', 'cancel-early');
    await env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      requestOperationCancel(tx, early.id),
    );
    await settle(await worker(), early.id);
    expect(rx.received('cancel-early')).toBe(0);
    expect(await ledger(early.id)).toBeUndefined();
    expect((await op(early.id)).execution_state).toBe('cancelled');
    // In flight: the send completes, the cancellation is observed after it, and the liability is
    // reported with the cancelled operation.
    const hold = rx.holdBeforeApply('cancel-flight');
    const flight = await start('unsafe', 'cancel-flight');
    const w = await worker();
    const running = w.runCycle({ wait: true });
    await hold.reached;
    await env.h.app.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      await requestOperationCancel(tx, flight.id);
      // Cancelling while the claim is live leaves it alone and reports it in flight.
      expect(await cancelOpenEffects(tx, flight.id)).toEqual({
        cancelled: 0,
        reported: [{ effectKey: 'send:cancel-flight', liability: 'in_flight' }],
      });
    });
    hold.release();
    await running;
    expect(rx.applied('cancel-flight')).toBe(1);
    expect(await ledger(flight.id)).toMatchObject({ state: 'sent' });
    expect(await op(flight.id)).toMatchObject({
      execution_state: 'cancelled',
      outcome_detail: { effect_liability: { sent: 1 } },
    });
    // After an unknown outcome: cancelling never relabels it.
    const { started } = await crashAt('afterPerform', 'unsafe', 'cancel-unknown');
    const reported = await env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      cancelOpenEffects(tx, started.id),
    );
    expect(reported).toEqual({
      cancelled: 0,
      reported: [{ effectKey: 'send:cancel-unknown', liability: 'unknown' }],
    });
    expect((await ledger(started.id))!.state).toBe('unknown');
  });

  it('AT-545 only typed proof means not sent: a rejection is retried and applied once; a generic error after sending is unknown', async () => {
    rx.rejectOnce('rejected');
    const rejected = await start('unsafe', 'rejected');
    const w = await worker();
    await w.runCycle({ wait: true });
    expect(await ledger(rejected.id)).toMatchObject({
      state: 'failed',
      not_sent_code: 'rejected_by_receiver',
      attempt_count: 1,
    });
    await settle(w, rejected.id);
    expect(rx.applied('rejected')).toBe(1);
    expect(await ledger(rejected.id)).toMatchObject({ state: 'sent', attempt_count: 2 });
    expect((await op(rejected.id)).execution_state).toBe('succeeded');
    // The database refuses `failed` without proof.
    const unproven = await start('unsafe', 'no-proof');
    await expect(
      env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
        const row = await recordEffect(tx, {
          operationId: unproven.id,
          effectKey: 'send:no-proof',
          destination: DEST.unsafe,
        });
        await tx.db
          .updateTable('exec.external_effect')
          .set({ state: 'cancelled' })
          .where('id', '=', row.id)
          .execute();
        await tx.db
          .updateTable('exec.external_effect')
          .set({ state: 'failed' })
          .where('id', '=', row.id)
          .execute();
      }),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('AT-546 safe classes resend only under their own contract and with the same key; a key cannot change destination or class', async () => {
    for (const kind of ['provider', 'receiver'] as const) {
      const { started } = await crashAt('afterPerform', kind, `safe-${kind}`);
      // Resent once with the same key; the destination deduplicated it, so it applied once.
      expect(rx.received(`safe-${kind}`)).toBe(2);
      expect(rx.applied(`safe-${kind}`)).toBe(1);
      expect(new Set(rx.dedupKeys(`safe-${kind}`)).size).toBe(1);
      expect(await ledger(started.id)).toMatchObject({ state: 'sent', attempt_count: 2 });
    }
    const natural = await crashAt('afterPerform', 'natural', 'safe-natural');
    expect(rx.received('safe-natural')).toBe(2);
    expect(await ledger(natural.started.id)).toMatchObject({ state: 'sent', attempt_count: 2 });
    // Reusing a key for another destination or class is refused explicitly.
    const other = defineEffectDestination('test.receiver_other', 'unsafe');
    await expect(
      env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
        recordEffect(tx, {
          operationId: natural.started.id,
          effectKey: 'send:safe-natural',
          destination: DEST.unsafe,
        }),
      ),
    ).rejects.toBeInstanceOf(EffectKeyConflictError);
    await expect(
      env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
        recordEffect(tx, {
          operationId: natural.started.id,
          effectKey: 'send:safe-natural',
          destination: { ...other, class: 'naturally_idempotent' } as EffectDestination,
        }),
      ),
    ).rejects.toBeInstanceOf(EffectKeyConflictError);
    // A registered destination cannot be re-registered with a weaker class.
    expect(() => defineEffectDestination('test.receiver_unsafe', 'naturally_idempotent')).toThrow(
      /already registered/,
    );
    // The database refuses claiming an unsafe unknown effect directly.
    const unsafe = await crashAt('afterPerform', 'unsafe', 'no-direct-claim');
    await expect(
      env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
        tx.db
          .updateTable('exec.external_effect')
          .set({
            state: 'dispatching',
            claim_token: '01900000-0000-7000-8000-000000000000',
            claimed_at: new Date(),
            claim_until: new Date(Date.now() + 60_000),
            attempt_count: 2,
          })
          .where('operation_id', '=', unsafe.started.id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('AT-547 reconciliation is authorized, version-bound, audited, idempotent, and honest: sent never resends, retry sends once more with the same key, abandon stops', async () => {
    const sent = await crashAt('afterPerform', 'unsafe', 'rec-sent');
    const retry = await crashAt('afterPerform', 'unsafe', 'rec-retry');
    const abandon = await crashAt('afterPerform', 'unsafe', 'rec-abandon');
    const pub = async (x: { started: { id: string } }) => (await op(x.started.id)).public_id;
    const version = async (x: { started: { id: string } }) => (await ledger(x.started.id))!.version;
    // Listing: owners and administrators only, references and state facts only.
    const listed = await env.svc.listUncertainEffects(P.administrator, ws);
    expect(listed.items.map((i) => i.effect_key)).toEqual(
      expect.arrayContaining(['send:rec-sent', 'send:rec-retry', 'send:rec-abandon']),
    );
    expect(JSON.stringify(listed)).not.toContain(PAYLOAD_MARKER);
    expect((await refusal(env.svc.listUncertainEffects(P.member, ws))).code).toBe('forbidden');
    // Refusals: a member, a delegated token, a stale version, an unknown or foreign effect.
    expect(
      (
        await refusal(
          decide(P.member, await pub(sent), 'rec-sent', {
            decision: 'sent',
            version: await version(sent),
          }),
        )
      ).code,
    ).toBe('forbidden');
    const token = await env.svc
      .createToken(
        P.owner,
        ws,
        { name: 'Effects', kind: 'personal', scopes: ['records:read'] },
        mutation({ stepUpToken: 't' }),
      )
      .catch(() => null);
    if (token) {
      const auth = await env.svc.authenticateApiToken(token.data.secret!);
      const bearer = syntheticCaller(auth!.accountId, auth!.delegation, {
        correlationId: 'c'.repeat(32),
      });
      expect((await refusal(env.svc.listUncertainEffects(bearer, ws))).code).toBe('forbidden');
    }
    const stale = await refusal(
      decide(P.owner, await pub(sent), 'rec-sent', {
        decision: 'sent',
        version: (await version(sent)) - 1,
      }),
    );
    expect(issueCodes(stale)).toEqual(['version_mismatch']);
    const unknownOp = await refusal(
      decide(P.owner, 'op_01J8M5Y7A3B2C4D6E8F0G1H2J3', 'rec-sent', {
        decision: 'sent',
        version: 1,
      }),
    );
    expect(unknownOp.code).toBe('not_found');
    const other = await workspaceWith(env, db, ['Elsewhere']);
    expect(
      await refusal(
        decide(
          other.owner,
          await pub(sent),
          'rec-sent',
          { decision: 'sent', version: await version(sent) },
          undefined,
          other.ws,
        ),
      ),
    ).toEqual(
      await refusal(
        decide(
          other.owner,
          'op_01J8M5Y7A3B2C4D6E8F0G1H2J3',
          'rec-sent',
          { decision: 'sent', version: 1 },
          undefined,
          other.ws,
        ),
      ),
    );
    // Step-up is required.
    expect(
      (
        await refusal(
          env.svc.reconcileExternalEffect(
            P.owner,
            ws,
            await pub(sent),
            'send:rec-sent',
            {
              decision: 'sent',
              version: await version(sent),
            },
            mutation(),
          ),
        )
      ).code,
    ).toBe('step_up_required');

    // "sent": confirmed, never resent; the operation resumes and completes its remaining steps.
    const key = mutation({ stepUpToken: 't' });
    const done = await decide(
      P.owner,
      await pub(sent),
      'rec-sent',
      { decision: 'sent', version: await version(sent) },
      key,
    );
    expect(done.data).toMatchObject({ state: 'confirmed', reconciliation: { decision: 'sent' } });
    await settle(sent.survivor, sent.started.id);
    expect(rx.received('rec-sent')).toBe(1);
    expect((await op(sent.started.id)).execution_state).toBe('succeeded');
    // The same key replays the same answer (rendered now); a second decision is refused.
    const replay = await decide(
      P.owner,
      await pub(sent),
      'rec-sent',
      { decision: 'sent', version: 0 },
      key,
    );
    expect(replay).toMatchObject({ replayed: true, data: { state: 'confirmed' } });
    expect(
      issueCodes(
        await refusal(
          decide(P.owner, await pub(sent), 'rec-sent', {
            decision: 'retry',
            version: await version(sent),
          }),
        ),
      ),
    ).toEqual(['not_unknown']);
    // "retry" (by an administrator): exactly one fresh attempt of the same logical effect, with
    // the same provider key; the operation then completes its remaining steps.
    const adminM = (await membershipOf(db, wsId, P.administrator.auth.account.id))!.public_id;
    const retryKey = mutation({ stepUpToken: 't' });
    const retried = await decide(
      P.administrator,
      await pub(retry),
      'rec-retry',
      { decision: 'retry', version: await version(retry) },
      retryKey,
    );
    expect(retried.data).toMatchObject({ state: 'pending', reconciliation: { decision: 'retry' } });
    await settle(retry.survivor, retry.started.id);
    expect(rx.received('rec-retry')).toBe(2);
    expect(providerKeys.get('rec-retry')).toHaveLength(2);
    expect(new Set(providerKeys.get('rec-retry')).size).toBe(1);
    expect(await ledger(retry.started.id)).toMatchObject({ state: 'sent', attempt_count: 2 });
    expect((await op(retry.started.id)).execution_state).toBe('succeeded');
    // A completed key is not an access grant: once demoted, the same key's replay is refused.
    await apply(env, P.owner, ws, { kind: 'role', member: adminM, role: 'member' });
    expect(
      (
        await refusal(
          decide(
            P.administrator,
            await pub(retry),
            'rec-retry',
            { decision: 'retry', version: 0 },
            retryKey,
          ),
        )
      ).code,
    ).toBe('forbidden');
    await apply(env, P.owner, ws, { kind: 'role', member: adminM, role: 'administrator' });

    // Concurrent decisions on one effect: exactly one applies; the other is refused.
    const race = await crashAt('afterPerform', 'unsafe', 'rec-race');
    const v0 = await version(race);
    const racing = await Promise.allSettled([
      decide(P.owner, await pub(race), 'rec-race', { decision: 'retry', version: v0 }),
      decide(P.administrator, await pub(race), 'rec-race', { decision: 'abandon', version: v0 }),
    ]);
    expect(racing.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = racing.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as { code: string }).code).toBe('conflict');
    expect(await version(race)).toBe(v0 + 1);
    const raceAudit = await sql(
      `SELECT count(*)::int AS n FROM audit.audit_event WHERE workspace_id = $1 AND action = 'operation.effect_reconciled'
          AND target_public_id = $2`,
      [wsId, await pub(race)],
    );
    expect(raceAudit[0]!.n).toBe(1);

    // "abandon": no further attempts; whether it was sent stays unknown (attempts kept).
    await decide(P.owner, await pub(abandon), 'rec-abandon', {
      decision: 'abandon',
      version: await version(abandon),
    });
    await settle(abandon.survivor, abandon.started.id);
    expect(rx.received('rec-abandon')).toBe(1);
    expect(await ledger(abandon.started.id)).toMatchObject({
      state: 'cancelled',
      reconciliation_decision: 'abandon',
      attempt_count: 1,
      uncertainty_reason: 'abandoned_claim',
    });
    expect(await op(abandon.started.id)).toMatchObject({
      execution_state: 'cancelled',
      outcome_detail: { abandoned_effects: 1 },
    });
    // Every decision is audited, with references only.
    const audited = await sql(
      `SELECT count(*)::int AS n FROM audit.audit_event WHERE workspace_id = $1 AND action = 'operation.effect_reconciled'`,
      [wsId],
    );
    expect(audited[0]!.n).toBeGreaterThanOrEqual(3);
  });

  it('AT-548 nothing private reaches the ledger, jobs, outbox, audit, or logs, and no uncertain operation ever reports success', async () => {
    for (const t of [
      'exec.external_effect',
      'exec.job',
      'exec.operation',
      'exec.outbox_event',
      'exec.attempt',
      'audit.audit_event',
    ]) {
      const hit = await sql(
        `SELECT count(*)::int AS n FROM ${t} x WHERE strpos(row_to_json(x)::text, $1) > 0`,
        [PAYLOAD_MARKER],
      );
      expect(hit[0]!.n, t).toBe(0);
    }
    expect(env.h.sink.lines.join('\n')).not.toContain(PAYLOAD_MARKER);
    // Every operation whose effect is unknown or claimed is waiting, never succeeded.
    const uncertain = await sql(
      `SELECT DISTINCT o.execution_state::text AS state FROM exec.external_effect e
         JOIN exec.operation o ON o.id = e.operation_id
        WHERE e.workspace_id = $1 AND e.state::text IN ('unknown', 'dispatching')`,
      [wsId],
    );
    expect(uncertain.map((r) => r.state).filter((s) => s === 'succeeded')).toEqual([]);
    // No state_changed event says succeeded for an operation whose effect is still uncertain.
    const events = await sql(
      `SELECT count(*)::int AS n FROM exec.outbox_event ev
         JOIN exec.external_effect e ON e.operation_id = ev.operation_id
        WHERE e.workspace_id = $1 AND e.state::text IN ('unknown', 'dispatching')
          AND ev.event_type = 'execution.operation.state_changed' AND ev.payload->>'state' = 'succeeded'`,
      [wsId],
    );
    expect(events[0]!.n).toBe(0);
  });
});
