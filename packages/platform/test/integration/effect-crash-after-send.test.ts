import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineEffectDestination, type JobHandler } from '@pm/platform';
import {
  createHarness,
  seedTwoWorkspaces,
  startEffectReceiverFixture,
  type EffectReceiverFixture,
  type Harness,
  type TenantFixture,
} from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { makeWorker, start } from './helpers.ts';

const UNSAFE = defineEffectDestination('test.crash_receiver', 'unsafe');

/**
 * The REL-FU-7A-01 regression (ADR-0045): the receiver applied an unsafe effect and the worker
 * process stopped before the outcome was stored. On the accepted Phase 7 head the survivor sent it
 * again (applied twice) and reported success; now it is recorded unknown and waits.
 */
describe('crash after an unsafe send', () => {
  let db: TestDatabase;
  let h: Harness;
  let f: TenantFixture;
  let rx: EffectReceiverFixture;
  beforeAll(async () => {
    db = await createTestDatabase();
    h = createHarness(db);
    f = await seedTwoWorkspaces(h.app);
    rx = await startEffectReceiverFixture();
  });
  afterAll(async () => {
    await rx.close();
    await h.close();
    await db.drop();
  });

  it('AT-550 a worker that dies after the receiver applied an unsafe effect is never followed by a second send, and the operation waits instead of succeeding', async () => {
    let stopAfterSend = true;
    const handler: JobHandler = {
      kind: 'test.crash_send',
      queue: 'default',
      handle: async (ctx) => {
        await ctx.effect('send:x', UNSAFE, async () => {
          await fetch(rx.url, { method: 'POST', body: JSON.stringify({ key: 'x' }) });
          if (stopAfterSend) {
            stopAfterSend = false;
            await new Promise(() => undefined); // the process stops here
          }
          return {};
        });
      },
    };
    const doomed = await makeWorker(h, [handler]);
    const op = await start(h, f.alpha.id, f.principals.alphaMember, 'test.crash_send', {
      maxAttempts: 5,
    });
    const applied = new Promise<void>((resolve) => {
      const tick = () => (rx.applied('x') > 0 ? resolve() : setTimeout(tick, 5));
      tick();
    });
    // The doomed worker is killed mid-cycle: its cycle ends in WorkerKilledError, by design.
    void doomed.runCycle().catch(() => undefined);
    await applied;
    doomed.kill();
    await db.admin(
      `UPDATE exec.job SET lease_until = now() - interval '1 second' WHERE operation_id = $1`,
      [op.id],
    );
    const survivor = await makeWorker(h, [handler]);
    for (let i = 0; i < 4; i++) {
      await db.admin(`UPDATE exec.job SET run_at = now() WHERE operation_id = $1`, [op.id]);
      await survivor.runCycle({ wait: true });
    }
    await survivor.stop();
    expect(rx.applied('x')).toBe(1);
    expect(
      (
        await db.admin(
          'SELECT state::text AS state, attempt_count, uncertainty_reason FROM exec.external_effect WHERE operation_id = $1',
          [op.id],
        )
      ).rows,
    ).toEqual([{ state: 'unknown', attempt_count: 1, uncertainty_reason: 'abandoned_claim' }]);
    expect(
      (
        await db.admin('SELECT execution_state, waiting_reason FROM exec.operation WHERE id = $1', [
          op.id,
        ])
      ).rows[0],
    ).toEqual({ execution_state: 'waiting', waiting_reason: 'reconciliation_required' });
  });
});
