import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { executionContextToContract, newUuidV7, type PrincipalRef } from '@pm/contracts';
import {
  completeIdempotencyKey,
  contextFromRow,
  defineEffectDestination,
  EffectOutcomeUnknownError,
  failIdempotencyKeyDeterministic,
  fingerprintHex,
  JobError,
  reconcileEffect,
  releaseIdempotencyKey,
  renderReplay,
  requestFingerprint,
  reserveIdempotencyKey,
  toPublicOperation,
  writeOutboxEvent,
  type InternalEvent,
  type OutboxConsumer,
  type WorkerRuntime,
} from '@pm/platform';
import {
  contractErrors,
  createHarness,
  executionContext,
  seedTwoWorkspaces,
  type Harness,
  type TenantFixture,
} from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { makeWorker, opState, sleep, start } from './helpers.ts';

describe('outbox, inbox, idempotency, and external effects', () => {
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

  beforeAll(async () => {
    db = await createTestDatabase();
    h = createHarness(db);
    f = await seedTwoWorkspaces(h.app);
  });
  afterEach(async () => {
    for (const w of workers.splice(0)) if (w.state === 'running') await w.stop();
    await db.admin(
      `UPDATE exec.outbox_event SET dispatched_at = now() WHERE dispatched_at IS NULL`,
    );
    await db.admin(
      `UPDATE exec.job SET state = 'cancelled', finished_at = now(), lease_token = NULL, lease_owner = NULL, lease_until = NULL WHERE state NOT IN ('succeeded', 'dead', 'cancelled')`,
    );
  });
  afterAll(async () => {
    await h.close();
    await db.drop();
  });

  describe('outbox dispatch (0D §8.3)', () => {
    const recording = (name: string, failFirst = false) => {
      const seen: InternalEvent[] = [];
      let failures = failFirst ? 1 : 0;
      const consumer: OutboxConsumer = {
        name,
        eventTypes: ['execution.operation.state_changed'],
        handle: async (tx, event) => {
          if (failures-- > 0) throw new Error('consumer temporarily failing');
          await tx.db.selectFrom('exec.operation').select('id').execute(); // runs inside the tenant transaction
          seen.push(event);
        },
      };
      return { consumer, seen };
    };

    it('delivers at least once and deduplicates redelivery with inbox receipts', async () => {
      const a = recording('test.consumer_a');
      const b = recording('test.consumer_b', true);
      const w = await worker([], [a.consumer, b.consumer]);
      const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.unused');
      await w.dispatchOutbox();
      expect(a.seen).toHaveLength(1);
      expect(b.seen).toHaveLength(0);
      const pending = await db.admin(
        'SELECT dispatched_at, dispatch_attempts FROM exec.outbox_event WHERE operation_id = $1',
        [op.id],
      );
      expect(pending.rows[0]).toMatchObject({ dispatched_at: null, dispatch_attempts: 1 });

      // Dispatch lease expires (e.g. dispatcher crash) -> redelivery to every consumer.
      await db.admin(
        `UPDATE exec.outbox_event SET dispatch_lease_until = now() - interval '1 second' WHERE operation_id = $1`,
        [op.id],
      );
      await w.dispatchOutbox();
      expect(a.seen).toHaveLength(1); // receipt made the redelivery a no-op
      expect(b.seen).toHaveLength(1);
      const done = await db.admin(
        'SELECT dispatched_at, dispatch_attempts FROM exec.outbox_event WHERE operation_id = $1',
        [op.id],
      );
      expect(done.rows[0].dispatched_at).not.toBeNull();
      expect(done.rows[0].dispatch_attempts).toBe(2);

      // Crash after consumers committed but before the dispatched mark: full redelivery is absorbed.
      await db.admin(
        'UPDATE exec.outbox_event SET dispatched_at = NULL, dispatch_lease_until = NULL WHERE operation_id = $1',
        [op.id],
      );
      await w.dispatchOutbox();
      expect(a.seen).toHaveLength(1);
      expect(b.seen).toHaveLength(1);
      const receipts = await db.admin(
        'SELECT consumer_name FROM exec.inbox_receipt WHERE workspace_id = $1 ORDER BY 1',
        [f.alpha.id],
      );
      expect(receipts.rows.map((r) => r.consumer_name)).toEqual([
        'test.consumer_a',
        'test.consumer_b',
      ]);
    });

    it('builds 0D internal-event envelopes that validate against the accepted schema', async () => {
      const a = recording('test.schema');
      const w = await worker([], [a.consumer]);
      await start(h, f.beta.id, f.principals.betaMember, 'test.unused');
      await w.dispatchOutbox();
      expect(a.seen).toHaveLength(1);
      expect(contractErrors('internal-event', a.seen[0])).toEqual([]);
      expect(a.seen[0]).toMatchObject({
        workspace_id: f.beta.id,
        data: { kind: 'report_run', state: 'queued' },
        max_class: 'C1',
      });
    });

    it('rejects unregistered event types and undeclared fields', async () => {
      const ctx = executionContext(f.alpha.id, f.principals.alphaMember);
      await expect(
        h.app.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
          writeOutboxEvent(tx, {
            type: 'work.task.invented' as never,
            aggregate: { type: 'x', id: newUuidV7(), sequence: 1 },
            data: {},
            actor: { type: 'system' },
            context: ctx,
          }),
        ),
      ).rejects.toThrow(/unregistered/);
      await expect(
        h.app.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
          writeOutboxEvent(tx, {
            type: 'execution.operation.state_changed',
            aggregate: { type: 'x', id: newUuidV7(), sequence: 1 },
            data: { title: 'customer text' },
            actor: { type: 'system' },
            context: ctx,
          }),
        ),
      ).rejects.toThrow(/undeclared field title/);
    });

    it('maintenance deletes dispatched events after the replay window, one workspace at a time', async () => {
      await start(h, f.alpha.id, f.principals.alphaMember, 'test.unused');
      await db.admin(
        `UPDATE exec.outbox_event SET dispatched_at = now() - interval '2 hours' WHERE workspace_id = $1`,
        [f.alpha.id],
      );
      await db.admin(
        `UPDATE exec.inbox_receipt SET processed_at = now() - interval '2 hours' WHERE workspace_id = $1`,
        [f.alpha.id],
      );
      const w = await worker([]);
      const touched = await w.runMaintenance();
      expect(touched).toBeGreaterThanOrEqual(1);
      const left = await db.admin(
        'SELECT count(*)::int AS n FROM exec.outbox_event WHERE workspace_id = $1',
        [f.alpha.id],
      );
      expect(left.rows[0].n).toBe(0);
      const receipts = await db.admin(
        'SELECT count(*)::int AS n FROM exec.inbox_receipt WHERE workspace_id = $1',
        [f.alpha.id],
      );
      expect(receipts.rows[0].n).toBe(0);
    });
  });

  describe('idempotency keys (0D §5.2)', () => {
    const fp = (body: unknown) =>
      requestFingerprint({
        method: 'POST',
        route: '/v1/workspaces/{ws}/exports',
        pathParams: { ws: 'ws_X' },
        query: {},
        body,
      });
    const reserve = (principal: PrincipalRef, key: string, body: unknown, ws = f.alpha.id) =>
      h.app.withWorkspace(ws, { module: 'test' }, (tx) =>
        reserveIdempotencyKey(tx, { principal, key, fingerprint: fp(body), retentionMs: 60_000 }),
      );

    it('reserves, reports in-progress, replays references, and rejects key reuse', async () => {
      const p = f.principals.alphaMember;
      const key = 'client-key-0001-abcdef';
      expect(await reserve(p, key, { format: 'csv' })).toEqual({ outcome: 'reserved' });
      expect(await reserve(p, key, { format: 'csv' })).toEqual({
        outcome: 'in_progress',
        operationId: undefined,
      });
      expect(await reserve(p, key, { format: 'pdf' })).toEqual({ outcome: 'key_reuse' });
      await h.app.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
        completeIdempotencyKey(tx, p, key, {
          status: 202,
          resource_refs: [
            { id: 'op_0J8ZK3Q5B8V2N4M6P7R9S0T1HA', type: 'operation' },
            { id: 'op_0J8ZK3Q5B8V2N4M6P7R9S0T1HB', type: 'operation' },
          ],
        }),
      );
      const replay = await reserve(p, key, { format: 'csv' });
      expect(replay).toMatchObject({ outcome: 'replay', response: { status: 202 } });
      // PC-02: replay re-renders through *current* authorization; a now-unreadable ref is omitted.
      const rendered = await renderReplay(
        (replay as { response: Parameters<typeof renderReplay>[0] }).response,
        async (ref) => (ref.id.endsWith('HA') ? { id: ref.id } : undefined),
      );
      expect(rendered.resources).toEqual([{ id: 'op_0J8ZK3Q5B8V2N4M6P7R9S0T1HA' }]);
      // Keys are scoped per principal and per workspace.
      expect(await reserve(f.principals.alphaSecondMember, key, { format: 'csv' })).toEqual({
        outcome: 'reserved',
      });
      expect(await reserve(f.principals.betaMember, key, { format: 'csv' }, f.beta.id)).toEqual({
        outcome: 'reserved',
      });
    });

    it('stores deterministic failures and releases keys after transient failures', async () => {
      const p = f.principals.alphaMember;
      await reserve(p, 'client-key-0002-abcdef', {});
      await h.app.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
        failIdempotencyKeyDeterministic(tx, p, 'client-key-0002-abcdef', 422, 'validation_failed'),
      );
      expect(await reserve(p, 'client-key-0002-abcdef', {})).toMatchObject({
        outcome: 'replay',
        response: { status: 422, error_code: 'validation_failed' },
      });
      await reserve(p, 'client-key-0003-abcdef', {});
      await h.app.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
        releaseIdempotencyKey(tx, p, 'client-key-0003-abcdef'),
      );
      expect(await reserve(p, 'client-key-0003-abcdef', {})).toEqual({ outcome: 'reserved' });
    });

    it('serializes concurrent duplicates on the unique key', async () => {
      const p = f.principals.alphaMember;
      const key = 'client-key-0004-abcdef';
      let release!: () => void;
      const holding = new Promise<void>((r) => (release = r));
      const first = h.app.withWorkspace(f.alpha.id, { module: 'test' }, async (tx) => {
        const r = await reserveIdempotencyKey(tx, {
          principal: p,
          key,
          fingerprint: fp({}),
          retentionMs: 60_000,
        });
        await holding;
        return r;
      });
      await sleep(50);
      const second = reserve(p, key, {});
      await sleep(50);
      release();
      expect(await first).toEqual({ outcome: 'reserved' });
      expect(await second).toEqual({ outcome: 'in_progress', operationId: undefined });
    });

    it('treats an expired key as a new request', async () => {
      const p = f.principals.alphaMember;
      await reserve(p, 'client-key-0005-abcdef', {});
      await db.admin(
        `UPDATE exec.idempotency_key SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE key = 'client-key-0005-abcdef'`,
      );
      expect(await reserve(p, 'client-key-0005-abcdef', { different: true })).toEqual({
        outcome: 'reserved',
      });
    });

    it('stored rows map onto the 0D idempotency-record contract', async () => {
      const row = (
        await db.admin(
          `SELECT * FROM exec.idempotency_key WHERE key = 'client-key-0001-abcdef' AND principal_id = $1`,
          [f.principals.alphaMember.id],
        )
      ).rows[0];
      const record = {
        workspace_id: row.workspace_id,
        principal: { type: row.principal_type, id: row.principal_id },
        key: row.key,
        fingerprint: fingerprintHex(row.request_fingerprint),
        state: row.state,
        response: { status: row.response_status, ...row.response_ref },
        created_at: row.created_at.toISOString(),
        expires_at: row.expires_at.toISOString(),
      };
      expect(contractErrors('idempotency-record', record)).toEqual([]);
    });
  });

  describe('external effects (0D §5.4)', () => {
    const NOTIFY = defineEffectDestination('test.notify_provider', 'idempotent_by_provider');
    const EMAIL = defineEffectDestination('test.email_send', 'unsafe');
    it('safe destinations retry after an unknown outcome; sent effects are never repeated', async () => {
      const performed: string[] = [];
      let calls = 0;
      const w = await worker([
        {
          kind: 'test.notify',
          queue: 'default',
          handle: async (ctx) => {
            calls++;
            await ctx.effect('notify:1', NOTIFY, async (providerKey) => {
              performed.push(providerKey);
              if (performed.length === 1) throw new EffectOutcomeUnknownError();
              return { externalRef: 'provider-ref-1' };
            });
            if (calls === 2) throw new JobError('transient', 'after_effect');
          },
        },
      ]);
      const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.notify', {
        maxAttempts: 5,
      });
      for (let i = 0; i < 3; i++) {
        await db.admin('UPDATE exec.job SET run_at = now() WHERE id = $1', [op.jobId]);
        await w.runCycle({ wait: true });
      }
      expect((await opState(h, f.alpha.id, op.id)).op.execution_state).toBe('succeeded');
      expect(performed).toHaveLength(2); // attempt 1 unknown, attempt 2 sent, attempt 3 skipped
      expect(new Set(performed).size).toBe(1); // stable provider idempotency key across attempts
      const effect = (
        await db.admin(
          'SELECT state, attempt_count, external_ref FROM exec.external_effect WHERE operation_id = $1',
          [op.id],
        )
      ).rows[0];
      expect(effect).toEqual({ state: 'sent', attempt_count: 2, external_ref: 'provider-ref-1' });
    });

    it('unsafe destinations with unknown outcomes wait for reconciliation and are never auto-resent', async () => {
      let sends = 0;
      const handler = {
        kind: 'test.unsafe_send',
        queue: 'default',
        handle: async (ctx: Parameters<import('@pm/platform').JobHandler['handle']>[0]) => {
          await ctx.effect('email:1', EMAIL, async () => {
            sends++;
            throw new EffectOutcomeUnknownError();
          });
        },
      };
      const w = await worker([handler]);
      const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.unsafe_send', {
        maxAttempts: 5,
      });
      await w.runCycle({ wait: true });
      const s = await opState(h, f.alpha.id, op.id);
      expect(s.op).toMatchObject({
        execution_state: 'waiting',
        waiting_reason: 'reconciliation_required',
      });
      expect(s.job.state).toBe('dead');
      expect(sends).toBe(1);
      const effect = (
        await db.admin('SELECT id, state FROM exec.external_effect WHERE operation_id = $1', [
          op.id,
        ])
      ).rows[0];
      expect(effect.state).toBe('unknown');

      // The database refuses to move an unsafe unknown effect back to pending without a decision.
      await expect(
        h.worker.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
          tx.db
            .updateTable('exec.external_effect')
            .set({ state: 'pending' })
            .where('id', '=', effect.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '55000' });

      // A human decides "not sent - retry": recorded on the ledger, effect returns to pending.
      await h.app.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
        reconcileEffect(tx, effect.id, 'retry', { type: 'human', id: f.principals.alphaMember.id }),
      );
      const after = (
        await db.admin(
          'SELECT state, reconciliation_decision, reconciled_by FROM exec.external_effect WHERE id = $1',
          [effect.id],
        )
      ).rows[0];
      expect(after).toEqual({
        state: 'pending',
        reconciliation_decision: 'retry',
        reconciled_by: f.principals.alphaMember.id,
      });
    });

    it('rejects illegal effect transitions in the database', async () => {
      const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.unused');
      await expect(
        h.worker.withWorkspace(f.alpha.id, { module: 'test' }, async (tx) => {
          await tx.db
            .insertInto('exec.external_effect')
            .values({
              id: newUuidV7(),
              workspace_id: f.alpha.id,
              operation_id: op.id,
              effect_key: 'k',
              destination_class: 'naturally_idempotent',
              state: 'confirmed',
            })
            .execute();
          await tx.db
            .updateTable('exec.external_effect')
            .set({ state: 'pending' })
            .where('operation_id', '=', op.id)
            .execute();
        }),
      ).rejects.toMatchObject({ code: '55000' });
    });
  });

  describe('public and internal contract shapes', () => {
    it('operations serialize to the public 0D operation schema without internal keys', async () => {
      const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.unused');
      const { op: row, job } = await opState(h, f.alpha.id, op.id);
      const pub = toPublicOperation(row, { workspacePublicId: f.alpha.publicId, attemptCount: 0 });
      expect(contractErrors('operation', pub)).toEqual([]);
      expect(JSON.stringify(pub)).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/,
      );
      // The job's durable context round-trips into the internal execution-context contract.
      expect(
        contractErrors('execution-context', executionContextToContract(contextFromRow(job))),
      ).toEqual([]);
    });
  });
});
