import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newTraceId, newUuidV7 } from '@pm/contracts';
import {
  bufferRetirementReady,
  drainSecurityEventBuffer,
  verifySecurityEventBuffer,
  type DrainDeps,
} from '@pm/audit';
import { BufferedSecurityEvents } from '@pm/identity';
import { createHarness, type Harness } from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';

/** ADR-0008 Phase 1F handoff: identity.security_event_buffer → audit.security_event. */
describe('security-event buffer drain and verification', () => {
  let db: TestDatabase;
  let h: Harness;
  let d: DrainDeps;
  const legacy = new BufferedSecurityEvents();
  const account = newUuidV7();

  beforeEach(async () => {
    db = await createTestDatabase();
    h = createHarness(db);
    d = {
      platform: h.platformWorker,
      tenant: h.worker,
      metrics: h.telemetry.metrics,
      logger: h.logger,
    };
  });
  afterEach(async () => {
    await h.close();
    await db.drop();
  });

  /** Old (1B) processes writing to the buffer, as during a rolling deploy. */
  const writeLegacy = (n: number, prefix = 'sign_in') =>
    h.platform.withPlatform({ module: 'test' }, async (tx) => {
      for (let i = 0; i < n; i++)
        await legacy.record(tx, {
          category: 'authentication',
          action: `${prefix}.password`,
          outcome: i % 3 === 0 ? 'failure' : 'success',
          actor: { type: 'human', id: account },
          subject: { type: 'account', id: account },
          network: { prefix: '203.0.113.0/24', userAgentFamily: 'Firefox on Linux' },
          correlationId: newTraceId(),
        });
    });
  const count = async (t: string) =>
    (await db.admin(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n as number;

  it('zero events: verification is trivially exact and retirement is ready', async () => {
    expect(await drainSecurityEventBuffer(d)).toEqual({ copied: 0, remaining: 0, batches: 0 });
    const v = await verifySecurityEventBuffer(d);
    expect(v).toMatchObject({ outcome: 'verified', bufferCount: 0, sinkCount: 0, perDay: [] });
    expect(v.bufferDigest).toBe(v.sinkDigest);
    expect(await bufferRetirementReady(d)).toBe(true);
  });

  it('copies every row with its original id and occurred_at; a rerun adds nothing', async () => {
    await writeLegacy(23);
    // Spread events over several days so per-day verification is meaningful.
    await db.admin(
      `UPDATE identity.security_event_buffer SET occurred_at = occurred_at - (random() * interval '5 days')`,
    );
    const first = await drainSecurityEventBuffer(d, { batchSize: 5 });
    expect(first).toEqual({ copied: 23, remaining: 0, batches: 5 });
    const same = await db.admin(`
      SELECT count(*)::int AS n FROM identity.security_event_buffer b
      JOIN audit.security_event s ON s.id = b.id AND s.occurred_at = b.occurred_at
        AND s.action = b.action AND s.correlation_id = b.correlation_id
        AND s.network_prefix IS NOT DISTINCT FROM b.network_prefix`);
    expect(same.rows[0].n).toBe(23);
    expect(await drainSecurityEventBuffer(d, { batchSize: 5 })).toEqual({
      copied: 0,
      remaining: 0,
      batches: 0,
    });
    expect(await count('audit.security_event')).toBe(23);
    const v = await verifySecurityEventBuffer(d);
    expect(v.outcome).toBe('verified');
    expect(v.perDay.reduce((a, x) => a + x.buffer, 0)).toBe(23);
    expect(v.perDay.every((x) => x.buffer === x.sink)).toBe(true);
    expect(await bufferRetirementReady(d)).toBe(true);
  });

  it('resumes safely after an interruption between batches, without loss or duplication', async () => {
    await writeLegacy(12);
    let batches = 0;
    await expect(
      drainSecurityEventBuffer(d, {
        batchSize: 4,
        onBatch: () => {
          batches += 1;
          if (batches === 2) throw new Error('worker killed');
        },
      }),
    ).rejects.toThrow('worker killed');
    expect(await count('audit.security_event')).toBe(8);
    expect(await drainSecurityEventBuffer(d, { batchSize: 4 })).toMatchObject({
      copied: 4,
      remaining: 0,
    });
    expect(await count('audit.security_event')).toBe(12);
    expect((await verifySecurityEventBuffer(d)).outcome).toBe('verified');
  });

  it('handles events written to the buffer concurrently with the drain (rolling cutover)', async () => {
    await writeLegacy(10);
    await Promise.all([
      drainSecurityEventBuffer(d, { batchSize: 3 }),
      writeLegacy(7, 'session'),
      drainSecurityEventBuffer(d, { batchSize: 2 }),
    ]);
    // New-code writers go to the final sink only; a final drain catches any late legacy row.
    const final = await drainSecurityEventBuffer(d, { batchSize: 50 });
    expect(final.remaining).toBe(0);
    expect(await count('audit.security_event')).toBe(17);
    expect((await verifySecurityEventBuffer(d)).outcome).toBe('verified');
    // A legacy row appended after verification invalidates retirement readiness until re-verified.
    await writeLegacy(1, 'late');
    expect(await bufferRetirementReady(d)).toBe(false);
    await drainSecurityEventBuffer(d);
    await verifySecurityEventBuffer(d);
    expect(await bufferRetirementReady(d)).toBe(true);
  });

  it('a checksum mismatch is recorded and blocks retirement', async () => {
    await writeLegacy(5);
    // A sink row with the same identity but different facts (e.g. an earlier faulty copy).
    const victim = (
      await db.admin(`SELECT * FROM identity.security_event_buffer ORDER BY id LIMIT 1`)
    ).rows[0];
    await db.admin(
      `INSERT INTO audit.security_event (id, occurred_at, category, action, outcome, actor_type, actor_id, subject_type,
         subject_id, workspace_id, network_prefix, user_agent_family, correlation_id)
       VALUES ($1, $2, $3, 'sign_in.forged', $4, $5, $6, $7, $8, NULL, $9, $10, $11)`,
      [
        victim.id,
        victim.occurred_at,
        victim.category,
        victim.outcome,
        victim.actor_type,
        victim.actor_id,
        victim.subject_type,
        victim.subject_id,
        victim.network_prefix,
        victim.user_agent_family,
        victim.correlation_id,
      ],
    );
    expect((await drainSecurityEventBuffer(d)).remaining).toBe(0);
    const v = await verifySecurityEventBuffer(d);
    expect(v.outcome).toBe('mismatch');
    expect(v.bufferCount).toBe(v.sinkCount);
    expect(v.bufferDigest).not.toBe(v.sinkDigest);
    expect(await bufferRetirementReady(d)).toBe(false);
    const log = await db.admin(`SELECT outcome FROM audit.buffer_verification`);
    expect(log.rows).toEqual([{ outcome: 'mismatch' }]);
    await expect(db.admin(`DELETE FROM audit.buffer_verification`)).rejects.toThrow(/append-only/);
  });
});
