import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newTraceId } from '@pm/contracts';
import {
  enqueueJob,
  JobError,
  requestJobCancel,
  requestOperationCancel,
  type JobHandler,
  type WorkerRuntime,
} from '@pm/platform';
import {
  createHarness,
  executionContext,
  seedTwoWorkspaces,
  type Harness,
  type TenantFixture,
} from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { gate, makeWorker, opState, sleep, start } from './helpers.ts';

describe('durable jobs (0D §7)', () => {
  let db: TestDatabase;
  let h: Harness;
  let f: TenantFixture;
  const workers: WorkerRuntime[] = [];
  const worker = async (
    ...args: Parameters<typeof makeWorker> extends [unknown, ...infer R] ? R : never
  ) => {
    const w = await makeWorker(h, ...args);
    workers.push(w);
    return w;
  };
  /** Moves a job's lease into the past, as if the owning worker stopped heartbeating long ago. */
  const expireLease = (jobId: string) =>
    db.admin(`UPDATE exec.job SET lease_until = now() - interval '1 second' WHERE id = $1`, [
      jobId,
    ]);
  const makeDue = (jobId: string) =>
    db.admin(`UPDATE exec.job SET run_at = now() WHERE id = $1`, [jobId]);

  beforeAll(async () => {
    db = await createTestDatabase();
    h = createHarness(db);
    f = await seedTwoWorkspaces(h.app);
  });
  afterEach(async () => {
    for (const w of workers.splice(0)) {
      if (w.state === 'running') await w.stop();
    }
    await db.admin(
      `UPDATE exec.job SET state = 'cancelled', finished_at = now(), lease_token = NULL, lease_owner = NULL, lease_until = NULL WHERE state NOT IN ('succeeded', 'dead', 'cancelled')`,
    );
  });
  afterAll(async () => {
    await h.close();
    await db.drop();
  });

  it('runs a job to success: operation, attempt, job, and outbox facts commit consistently', async () => {
    const seen: string[] = [];
    const w = await worker([
      {
        kind: 'test.ok',
        queue: 'default',
        handle: async (ctx) => {
          seen.push(ctx.job.kind);
        },
      },
    ]);
    const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.ok');
    const r = await w.runCycle({ wait: true });
    expect(r.claimed).toBe(1);
    const s = await opState(h, f.alpha.id, op.id);
    expect(s.op).toMatchObject({ execution_state: 'succeeded', terminal_reason: null });
    expect(s.op.ended_at).not.toBeNull();
    expect(s.attempts.map((a) => [a.attempt_number, a.execution_state])).toEqual([
      [1, 'succeeded'],
    ]);
    expect(s.job).toMatchObject({ state: 'succeeded', lease_token: null, attempts: 1 });
    const events = await db.admin(
      `SELECT payload->>'state' AS state, aggregate_sequence FROM exec.outbox_event WHERE operation_id = $1 ORDER BY aggregate_sequence`,
      [op.id],
    );
    expect(events.rows).toEqual([
      { state: 'queued', aggregate_sequence: '0' },
      { state: 'running', aggregate_sequence: '1' },
      { state: 'succeeded', aggregate_sequence: '2' },
    ]);
    expect(seen).toEqual(['test.ok']);
  });

  it('retries transient failures with full-jitter backoff, then succeeds on the same operation', async () => {
    let calls = 0;
    const w = await worker([
      {
        kind: 'test.flaky',
        queue: 'default',
        handle: async () => {
          if (++calls === 1) throw new JobError('transient', 'upstream_unavailable');
        },
      },
    ]);
    const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.flaky');
    await w.runCycle({ wait: true });
    let s = await opState(h, f.alpha.id, op.id);
    expect(s.job.state).toBe('retry_scheduled');
    expect(s.job.last_error).toEqual({ class: 'transient', code: 'upstream_unavailable' });
    // random() = 0.5, attempt 1: delay = floor(0.5 * min(50, 10 * 2^1)) = 10 ms
    expect(s.job.run_at.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(s.op.execution_state).toBe('running');
    await sleep(60);
    await w.runCycle({ wait: true });
    s = await opState(h, f.alpha.id, op.id);
    expect(s.op.execution_state).toBe('succeeded');
    expect(s.attempts.map((a) => [a.attempt_number, a.execution_state, a.error_class])).toEqual([
      [1, 'failed', 'transient'],
      [2, 'succeeded', null],
    ]);
    const ops = await db.admin(`SELECT count(*)::int AS n FROM exec.operation WHERE id = $1`, [
      op.id,
    ]);
    expect(ops.rows[0].n).toBe(1); // retries add attempts, never operations
  });

  it('dead-letters after the attempt cap and fails the operation with a terminal reason', async () => {
    const w = await worker([
      {
        kind: 'test.always_fails',
        queue: 'default',
        handle: async () => {
          throw new Error('boom with secret=hunter2');
        },
      },
    ]);
    const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.always_fails', {
      maxAttempts: 2,
    });
    await w.runCycle({ wait: true });
    await makeDue(op.jobId);
    await w.runCycle({ wait: true });
    const s = await opState(h, f.alpha.id, op.id);
    expect(s.job).toMatchObject({ state: 'dead', last_error_class: 'transient', attempts: 2 });
    expect(s.op).toMatchObject({ execution_state: 'failed', terminal_reason: 'error' });
    expect(s.attempts).toHaveLength(2);
    const logs = h.sink.lines.join('\n');
    expect(logs).toContain('job.dead_lettered');
    expect(logs).not.toContain('hunter2');
    expect(logs).not.toContain('boom');
  });

  it('does not retry deterministic or policy failures', async () => {
    const w = await worker([
      {
        kind: 'test.invalid',
        queue: 'default',
        handle: async () => {
          throw new JobError('deterministic', 'invalid_input');
        },
      },
      {
        kind: 'test.limit',
        queue: 'default',
        handle: async () => {
          throw new JobError('policy', 'limit_exceeded');
        },
      },
    ]);
    const a = await start(h, f.alpha.id, f.principals.alphaMember, 'test.invalid', {
      maxAttempts: 5,
    });
    const b = await start(h, f.alpha.id, f.principals.alphaMember, 'test.limit', {
      maxAttempts: 5,
    });
    await w.runCycle({ wait: true });
    expect((await opState(h, f.alpha.id, a.id)).op).toMatchObject({
      execution_state: 'failed',
      terminal_reason: 'error',
    });
    expect((await opState(h, f.alpha.id, a.id)).job).toMatchObject({ state: 'dead', attempts: 1 });
    expect((await opState(h, f.alpha.id, b.id)).op).toMatchObject({
      execution_state: 'failed',
      terminal_reason: 'limit_exceeded',
    });
  });

  it('times out handlers that exceed their timeout', async () => {
    const w = await worker([
      { kind: 'test.slow', queue: 'default', timeoutMs: 100, handle: () => sleep(2_000) },
    ]);
    const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.slow', {
      maxAttempts: 1,
    });
    await w.runCycle({ wait: true });
    const s = await opState(h, f.alpha.id, op.id);
    expect(s.op).toMatchObject({ execution_state: 'failed', terminal_reason: 'timed_out' });
    expect(s.attempts[0]).toMatchObject({
      execution_state: 'failed',
      terminal_reason: 'timed_out',
      error_class: 'timeout',
    });
  });

  it('recovers from worker interruption: lost attempt is marked worker_lost and completed steps are not repeated', async () => {
    const effects = { first: 0, second: 0 };
    const blocked = gate();
    let runs = 0;
    const handler: JobHandler = {
      kind: 'test.two_steps',
      queue: 'default',
      handle: async (ctx) => {
        runs++;
        await ctx.step('first', async () => {
          effects.first++;
          return { cursor: 41 };
        });
        if (runs === 1) await blocked.wait; // the first worker "crashes" here
        const restored = await ctx.step('first', async () => {
          effects.first++;
          return { cursor: -1 };
        });
        expect(restored).toEqual({ cursor: 41 });
        await ctx.step('second', async () => {
          effects.second++;
        });
      },
    };
    const crashing = await worker([handler]);
    const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.two_steps');
    await crashing.runCycle();
    for (let i = 0; i < 50 && effects.first === 0; i++) await sleep(20);
    crashing.kill(); // abrupt: no finalization, no lease release
    blocked.open();
    await expireLease(op.jobId);

    const survivor = await worker([handler]);
    const r = await survivor.runCycle({ wait: true });
    expect(r.reaped).toBe(1);
    const s = await opState(h, f.alpha.id, op.id);
    expect(s.op.execution_state).toBe('succeeded');
    expect(
      s.attempts.map((a) => [a.attempt_number, a.execution_state, a.worker_lost, a.error_class]),
    ).toEqual([
      [1, 'failed', true, 'worker_lost'],
      [2, 'succeeded', false, null],
    ]);
    expect(effects).toEqual({ first: 1, second: 1 });
    expect(s.job.completed_steps).toEqual(['first', 'second']);
    expect(h.sink.lines.some((l) => l.includes('"job.step_skipped"'))).toBe(true);
  });

  it('fences stale workers: a worker whose lease was taken over cannot finalize', async () => {
    const blocked = gate();
    let calls = 0;
    const handler: JobHandler = {
      kind: 'test.fenced',
      queue: 'default',
      handle: async (ctx) => {
        if (++calls === 1) {
          await blocked.wait;
          await ctx.step('late', async () => {});
        }
      },
    };
    const stale = await worker([handler], [], { heartbeatIntervalMs: 60_000 });
    const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.fenced');
    await stale.runCycle();
    await sleep(100);
    await expireLease(op.jobId);
    const fresh = await worker([handler]);
    await fresh.runCycle({ wait: true });
    blocked.open();
    await sleep(200);
    const s = await opState(h, f.alpha.id, op.id);
    expect(s.op.execution_state).toBe('succeeded');
    expect(s.job.completed_steps).toEqual([]);
    expect(h.sink.lines.some((l) => l.includes('"job.lease_lost"'))).toBe(true);
  });

  it('observes cancellation before start and at step boundaries', async () => {
    const w = await worker([
      {
        kind: 'test.cancellable',
        queue: 'default',
        handle: async (ctx) => {
          await ctx.step('one', async (tx) => {
            if (tx.workspaceId === null) throw new Error('tenant job expected');
            await requestOperationCancel(tx, ctx.job.operationId!);
          });
          await ctx.step('two', async () => {
            throw new Error('must not run');
          });
        },
      },
    ]);
    const early = await start(h, f.alpha.id, f.principals.alphaMember, 'test.cancellable');
    await h.app.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
      requestOperationCancel(tx, early.id),
    );
    const running = await start(h, f.alpha.id, f.principals.alphaMember, 'test.cancellable');
    await w.runCycle({ wait: true });
    const e = await opState(h, f.alpha.id, early.id);
    expect(e.op).toMatchObject({ execution_state: 'cancelled', terminal_reason: 'user_cancelled' });
    expect(e.attempts).toHaveLength(0);
    const r = await opState(h, f.alpha.id, running.id);
    expect(r.op).toMatchObject({ execution_state: 'cancelled', terminal_reason: 'user_cancelled' });
    expect(r.attempts[0]).toMatchObject({
      execution_state: 'cancelled',
      terminal_reason: 'user_cancelled',
    });
    expect(r.job).toMatchObject({ state: 'cancelled', completed_steps: ['one'] });
  });

  it('cancels queued jobs without an operation directly', async () => {
    const ctx = executionContext(f.alpha.id, f.principals.systemJob);
    const job = await h.worker.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
      enqueueJob(tx, {
        queue: 'default',
        kind: 'test.ok',
        context: ctx,
        maxAttempts: 1,
        timeoutSeconds: 5,
      }),
    );
    const result = await h.worker.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
      requestJobCancel(tx, job.id),
    );
    expect(result).toBe('cancelled');
  });

  it('absorbs duplicate enqueues by dedupe key while the job is active', async () => {
    const ctx = executionContext(f.alpha.id, f.principals.systemJob);
    const [a, b] = await h.worker.withWorkspace(f.alpha.id, { module: 'test' }, async (tx) => [
      await enqueueJob(tx, {
        queue: 'default',
        kind: 'test.ok',
        context: ctx,
        dedupeKey: 'digest:2026-10-03',
        maxAttempts: 1,
        timeoutSeconds: 5,
      }),
      await enqueueJob(tx, {
        queue: 'default',
        kind: 'test.ok',
        context: ctx,
        dedupeKey: 'digest:2026-10-03',
        maxAttempts: 1,
        timeoutSeconds: 5,
      }),
    ]);
    expect(b).toEqual({ id: a!.id, deduplicated: true });
    // The same key in another workspace is independent (no cross-tenant collision or signal).
    const other = await h.worker.withWorkspace(f.beta.id, { module: 'test' }, (tx) =>
      enqueueJob(tx, {
        queue: 'default',
        kind: 'test.ok',
        context: executionContext(f.beta.id, f.principals.systemJob),
        dedupeKey: 'digest:2026-10-03',
        maxAttempts: 1,
        timeoutSeconds: 5,
      }),
    );
    expect(other.deduplicated).toBe(false);
  });

  it('enforces per-workspace concurrency caps so one tenant cannot monopolize workers (REL-018)', async () => {
    const blocked = gate();
    const handler: JobHandler = {
      kind: 'test.blocking',
      queue: 'fair',
      handle: () => blocked.wait,
    };
    for (let i = 0; i < 8; i++)
      await start(h, f.alpha.id, f.principals.alphaMember, 'test.blocking', { queue: 'fair' });
    for (let i = 0; i < 2; i++)
      await start(h, f.beta.id, f.principals.betaMember, 'test.blocking', { queue: 'fair' });
    const w1 = await worker([handler], [], { workspaceConcurrencyCap: 2, claimBatchSize: 10 });
    const w2 = await worker([handler], [], { workspaceConcurrencyCap: 2, claimBatchSize: 10 });
    const [c1, c2] = await Promise.all([w1.runCycle(), w2.runCycle()]);
    expect(c1.claimed + c2.claimed).toBe(4);
    const leased = await db.admin(
      `SELECT workspace_id, count(*)::int AS n FROM exec.job WHERE queue = 'fair' AND state = 'leased' GROUP BY 1`,
    );
    const byWs = Object.fromEntries(leased.rows.map((r) => [r.workspace_id, r.n]));
    expect(byWs).toEqual({ [f.alpha.id]: 2, [f.beta.id]: 2 });
    blocked.open();
    await sleep(300);
  });

  it('never hands one job to two concurrent workers', async () => {
    const handled: string[] = [];
    const handler: JobHandler = {
      kind: 'test.count',
      queue: 'race',
      handle: async (ctx) => {
        handled.push(ctx.job.id);
      },
    };
    for (let i = 0; i < 12; i++)
      await start(h, i % 2 ? f.alpha.id : f.beta.id, f.principals.alphaMember, 'test.count', {
        queue: 'race',
      });
    const ws = await Promise.all(
      [1, 2, 3].map(() =>
        worker([handler], [], { workspaceConcurrencyCap: 100, claimBatchSize: 5 }),
      ),
    );
    for (let round = 0; round < 4; round++)
      await Promise.all(ws.map((w) => w.runCycle({ wait: true })));
    expect(handled).toHaveLength(12);
    expect(new Set(handled).size).toBe(12);
  });

  it('heartbeats keep a long job leased beyond the lease duration', async () => {
    const w = await worker(
      [{ kind: 'test.long', queue: 'default', handle: () => sleep(1_600) }],
      [],
      { leaseDurationMs: 1_000, heartbeatIntervalMs: 200 },
    );
    const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.long');
    const reaper = await worker([], [], {});
    const run = w.runCycle({ wait: true });
    await sleep(1_200);
    expect(await reaper.reapExpiredLeases()).toBe(0);
    await run;
    const st = await opState(h, f.alpha.id, op.id);
    expect(st.op.execution_state).toBe('succeeded');
  });

  it('shuts down gracefully: stops claiming, releases unfinished leases, removes liveness', async () => {
    const w = await worker(
      [
        {
          kind: 'test.stuck',
          queue: 'default',
          handle: async (ctx) => {
            await sleep(400);
            await ctx.step('after', async () => {});
          },
        },
      ],
      [],
      { shutdownGraceMs: 50 },
    );
    const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.stuck');
    await w.runCycle();
    await sleep(50);
    await w.stop();
    const s = await opState(h, f.alpha.id, op.id);
    expect(s.job).toMatchObject({
      state: 'retry_scheduled',
      lease_token: null,
      last_error_class: 'worker_lost',
    });
    expect(s.attempts[0]).toMatchObject({
      execution_state: 'failed',
      error_class: 'worker_lost',
      worker_lost: true,
    });
    const live = await db.admin(
      'SELECT count(*)::int AS n FROM ops.worker_heartbeat WHERE worker_id = $1',
      [w.workerId],
    );
    expect(live.rows[0].n).toBe(0);
  });

  it('propagates the trace from the enqueuing request into the job span and logs', async () => {
    h.telemetry.spans!.reset();
    const traceId = newTraceId();
    const w = await worker([
      {
        kind: 'test.traced',
        queue: 'default',
        handle: async (ctx) => {
          ctx.logger.info('test.inside_handler');
        },
      },
    ]);
    const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.traced', {
      traceparent: `00-${traceId}-${'1'.repeat(16)}-01`,
    });
    await w.runCycle({ wait: true });
    const job = h.telemetry.spans!.getFinishedSpans().find((s) => s.name === 'job.run');
    expect(job?.spanContext().traceId).toBe(traceId);
    const record = h.sink.records().find((r) => r.event === 'test.inside_handler');
    expect(record).toMatchObject({
      trace_id: traceId,
      correlation_id: op.correlationId,
      job_kind: 'test.traced',
      operation_id: op.id,
    });
  });
});
