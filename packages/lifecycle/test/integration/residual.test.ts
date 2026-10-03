import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@pm/audit';
import { newUuidV7 } from '@pm/contracts';
import type { WorkspaceTransaction } from '@pm/db';
import { listTrash, LocalFilePurgeLedger } from '@pm/lifecycle';
import { testDecision } from '@pm/lifecycle/testing';
import {
  createHarness,
  createWorkspace,
  type Harness,
  type SyntheticWorkspace,
} from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { installFixtureSchema, lifecycleEnv, newLedgerDir, type LifecycleEnv } from './fixture.ts';

/**
 * Phase 1F review 01: partial evidence-lock exclusions move into retryable successor batches
 * (ADR-0009 G6 replaced). Nothing evidence-locked stays owned by a terminal batch.
 */
describe('residual batches for evidence-locked members', () => {
  let db: TestDatabase;
  let h: Harness;
  let ws: SyntheticWorkspace;
  let dir: string;
  let env: LifecycleEnv;

  beforeEach(async () => {
    db = await createTestDatabase();
    await installFixtureSchema(db);
    h = createHarness(db);
    ws = await createWorkspace(h.app, 'Residual');
    dir = newLedgerDir();
    env = lifecycleEnv(h, { ledger: new LocalFilePurgeLedger(dir) });
  });
  afterEach(async () => {
    await h.close();
    await db.drop();
  });

  const q = async (text: string, params: unknown[] = []) => (await db.admin(text, params)).rows;
  const tx = <T>(fn: (t: WorkspaceTransaction) => Promise<T>) =>
    h.app.withWorkspace(ws.id, { module: 'test' }, fn);
  const input = () => ({ exec: env.exec(ws.id), source: { kind: 'ui' as const } });
  const decision = (a: Parameters<typeof testDecision>[0]) =>
    testDecision(a, ws.id, { principalId: env.principal.id });
  const trash = (root: string) =>
    tx((x) => env.svc.trash(x, decision('record.trash'), input(), root));
  const purge = (batchId: string) =>
    tx((x) => env.svc.requestPurge(x, decision('record.purge'), input(), batchId));
  const batch = async (id: string) =>
    (await q(`SELECT * FROM core.deletion_batch WHERE id = $1`, [id]))[0];
  const successorsOf = async (id: string) =>
    q(
      `SELECT id, root_record_id, member_count, state, trashed_at, trashed_by_id, split_operation_id, restore_location
       FROM core.deletion_batch WHERE split_from_batch_id = $1 ORDER BY root_record_id`,
      [id],
    );
  const ledgerEntries = () =>
    readFileSync(`${dir}/purge-ledger.jsonl`, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  /** root → a → a1 (locked) → a1x ; root → b ; returns ids. */
  async function oneLocked() {
    const root = await env.create(ws.id, 'Root');
    const a = await env.create(ws.id, 'A', root);
    const a1 = await env.create(ws.id, 'Locked evidence title', a, { evidenceLocked: true });
    const a1x = await env.create(ws.id, 'Inside locked', a1);
    const b = await env.create(ws.id, 'B', root);
    const t = await trash(root);
    return { root, a, a1, a1x, b, batchId: t.batchId };
  }

  it('purges unlocked members and moves the locked subtree into one retryable successor batch', async () => {
    const t = await oneLocked();
    const original = await batch(t.batchId);
    const { operationId } = await purge(t.batchId);
    await env.drain();

    expect(await batch(t.batchId)).toMatchObject({
      state: 'purged',
      terminal_outcome: 'purged_with_exclusions',
      block_result: 'evidence_lock_partial',
      evidence_locked_count: 2,
      member_count: 5, // history is never rewritten
    });
    const [succ, ...more] = await successorsOf(t.batchId);
    expect(more).toEqual([]);
    expect(succ).toMatchObject({
      root_record_id: t.a1,
      member_count: 2,
      state: 'trashed',
      trashed_by_id: original.trashed_by_id,
      split_operation_id: operationId,
      restore_location: { container_record_id: t.a, container_type: 'foundation_fixture' },
    });
    expect(succ.trashed_at.getTime()).toBe(original.trashed_at.getTime());
    // Envelopes and active memberships point at the successor; history on the original says so.
    expect(
      await q(
        `SELECT id, lifecycle_state, deletion_batch_id FROM core.record WHERE id = ANY($1) ORDER BY id`,
        [[t.a1, t.a1x]],
      ),
    ).toEqual(
      [t.a1, t.a1x]
        .sort()
        .map((id) => ({ id, lifecycle_state: 'trashed', deletion_batch_id: succ.id })),
    );
    expect(
      await q(
        `SELECT record_id, outcome, successor_batch_id FROM core.deletion_batch_member WHERE batch_id = $1 AND outcome = 'moved_to_successor' ORDER BY record_id`,
        [t.batchId],
      ),
    ).toEqual(
      [t.a1, t.a1x].sort().map((record_id) => ({
        record_id,
        outcome: 'moved_to_successor',
        successor_batch_id: succ.id,
      })),
    );
    expect(
      await q(
        `SELECT record_id, outcome FROM core.deletion_batch_member WHERE batch_id = $1 ORDER BY record_id`,
        [succ.id],
      ),
    ).toEqual([t.a1, t.a1x].sort().map((record_id) => ({ record_id, outcome: 'pending' })));
    // The locked content survives; everything else is purged.
    expect(
      (
        await q(`SELECT id FROM fixture.item WHERE id = ANY($1) ORDER BY id`, [
          [t.root, t.a, t.a1, t.a1x, t.b],
        ])
      ).map((r) => r.id),
    ).toEqual([t.a1, t.a1x].sort());
    // Ledger, effects, redactions, and tombstones cover exactly the purged records.
    const [entry] = ledgerEntries();
    expect(entry.records.map((r: { id: string }) => r.id).sort()).toEqual(
      [t.root, t.a, t.b].sort(),
    );
    const effects = await q(
      `SELECT effect_key FROM exec.external_effect WHERE operation_id = $1 AND effect_key LIKE 'object:%' ORDER BY 1`,
      [operationId],
    );
    expect(effects.map((e) => e.effect_key)).toEqual(
      [t.root, t.a, t.b].map((id) => `object:obj-${id}`).sort(),
    );
    const tombs = await q(
      `SELECT id FROM core.record WHERE lifecycle_state = 'purged' ORDER BY id`,
    );
    expect(tombs.map((r) => r.id)).toEqual([t.root, t.a, t.b].sort());
    const redactedTargets = await q(
      `SELECT DISTINCT a.target_record_id FROM audit.audit_redaction r JOIN audit.audit_event a ON a.id = r.audit_event_id`,
    );
    expect(redactedTargets.map((r) => r.target_record_id).includes(t.a1)).toBe(false);
    // The split is audited structurally, before the destructive steps, without locked content.
    const audit =
      await q(`SELECT action, target_record_id, changes, chain_seq FROM audit.audit_event
      WHERE action IN ('record.partial_purge_split', 'record.residual_batch_created', 'record.purged') ORDER BY chain_seq`);
    expect(audit[0]).toMatchObject({
      action: 'record.residual_batch_created',
      target_record_id: succ.id,
    });
    expect(
      Object.fromEntries(
        audit[0].changes.map((c: { field: string; new: unknown }) => [c.field, c.new]),
      ),
    ).toMatchObject({
      root_record_id: t.a1,
      original_batch_id: t.batchId,
      successor_batch_id: succ.id,
      excluded_count: 2,
    });
    expect(audit[1]).toMatchObject({
      action: 'record.partial_purge_split',
      target_record_id: t.batchId,
    });
    expect(audit.slice(2).every((a) => a.action === 'record.purged')).toBe(true);
    expect(JSON.stringify(audit).includes('Locked evidence title')).toBe(false);
    expect(
      Object.fromEntries(
        audit[1].changes.map((c: { field: string; new: unknown }) => [c.field, c.new]),
      ),
    ).toMatchObject({
      original_batch_id: t.batchId,
      successor_batch_ids: [succ.id],
      excluded_count: 2,
    });
    expect(
      (await h.worker.withWorkspace(ws.id, { module: 'test' }, (x) => verifyAuditChain(x)))
        .problems,
    ).toEqual([]);
    // Trash and restore resolve through the successor, never the terminal original.
    const trashView = await tx((x) =>
      listTrash(x, decision('trash.manage'), { recoveryPeriodMs: null }),
    );
    expect(trashView.map((b) => b.batchId)).toEqual([succ.id]);
    await expect(
      tx((x) => env.svc.restore(x, decision('record.restore'), input(), t.batchId)),
    ).rejects.toMatchObject({ reason: 'not_restorable' });
    await expect(
      tx((x) => env.svc.restore(x, decision('record.restore'), input(), succ.id)),
    ).rejects.toMatchObject({ reason: 'container_missing' });

    // Once the lock is released, the successor purges through the ordinary path.
    await db.admin(`UPDATE fixture.item SET evidence_locked = false WHERE id = $1`, [t.a1]);
    const second = await purge(succ.id);
    await env.drain();
    expect(await batch(succ.id)).toMatchObject({ state: 'purged', terminal_outcome: 'purged' });
    const entries = ledgerEntries();
    expect(entries).toHaveLength(2);
    expect(entries[1].records.map((r: { id: string }) => r.id).sort()).toEqual(
      [t.a1, t.a1x].sort(),
    );
    expect(entries[1].operationId).toBe(second.operationId);
    expect(await q(`SELECT id FROM fixture.item`)).toEqual([]);
  });

  it('retention discovery selects a successor batch without any repair step', async () => {
    const t = await oneLocked();
    await purge(t.batchId);
    await env.drain();
    const [succ] = await successorsOf(t.batchId);
    await db.admin(`UPDATE fixture.item SET evidence_locked = false`);
    await db.admin(`BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE core.deletion_batch SET trashed_at = now() - interval '40 days' WHERE id = '${succ.id}'; COMMIT;`);
    await db.admin(
      `INSERT INTO governance.retention_policy (id, workspace_id, retention_class, period, source)
                    VALUES ($1, $2, 'R-LIVE', interval '30 days', 'workspace')`,
      [newUuidV7(), ws.id],
    );
    expect(await h.discovery.discoverPurgeDue(null, 10)).toEqual([
      { workspaceId: ws.id, batchId: succ.id },
    ]);
  });

  it('groups disjoint locked roots deterministically and never hands the original root to a residual batch', async () => {
    const root = await env.create(ws.id, 'Root');
    const a = await env.create(ws.id, 'A', root);
    const a1 = await env.create(ws.id, 'A1', a, { evidenceLocked: true });
    const a1x = await env.create(ws.id, 'A1X', a1);
    const b = await env.create(ws.id, 'B', root);
    const b1 = await env.create(ws.id, 'B1', b, { evidenceLocked: true });
    await env.create(ws.id, 'C', root);
    const t = await trash(root);
    await purge(t.batchId);
    await env.drain();
    const succ = await successorsOf(t.batchId);
    expect(succ.map((s) => [s.root_record_id, s.member_count])).toEqual(
      [
        [a1, 2],
        [b1, 1],
      ].sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)),
    );
    expect(succ.some((s) => s.root_record_id === root)).toBe(false);
    const owner = Object.fromEntries(
      (
        await q(`SELECT id, deletion_batch_id FROM core.record WHERE id = ANY($1)`, [[a1, a1x, b1]])
      ).map((r) => [r.id, r.deletion_batch_id]),
    );
    expect(owner[a1]).toBe(owner[a1x]);
    expect(owner[b1]).not.toBe(owner[a1]);

    // A locked original root holds the whole batch back (fully evidence-locked: retryable).
    const lockedRoot = await env.create(ws.id, 'Locked root', undefined, { evidenceLocked: true });
    await env.create(ws.id, 'Child', lockedRoot);
    const t2 = await trash(lockedRoot);
    await purge(t2.batchId);
    await env.drain();
    expect(await batch(t2.batchId)).toMatchObject({
      state: 'trashed',
      block_result: 'evidence_lock_all',
    });
    expect(await successorsOf(t2.batchId)).toEqual([]);
    // Released later, the same batch purges normally.
    await db.admin(`UPDATE fixture.item SET evidence_locked = false WHERE id = $1`, [lockedRoot]);
    await purge(t2.batchId);
    await env.drain();
    expect(await batch(t2.batchId)).toMatchObject({ state: 'purged', terminal_outcome: 'purged' });
  });

  it('recovers from a failure before, during, and right after the split without loss or duplicates', async () => {
    // Before: the evidence check fails; nothing moved, the job retries.
    env.controls.failEvidence = 1;
    const t = await oneLocked();
    // During: the split's final audit write fails once, after successor rows were inserted.
    await db.admin(
      `ALTER TABLE audit.audit_event ADD CONSTRAINT test_reject_split CHECK (action <> 'record.partial_purge_split') NOT VALID`,
    );
    await purge(t.batchId);
    await env.worker.start({ loop: false });
    await env.worker.runCycle({ wait: true }); // attempt 1: evidence check fails
    expect(await successorsOf(t.batchId)).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    await env.worker.runCycle({ wait: true }); // attempt 2: split fails and rolls back
    expect(await successorsOf(t.batchId)).toEqual([]);
    expect(await batch(t.batchId)).toMatchObject({ state: 'trashed' });
    expect(
      (
        await q(
          `SELECT count(*)::int AS n FROM core.deletion_batch_member WHERE batch_id = $1 AND outcome = 'pending'`,
          [t.batchId],
        )
      )[0].n,
    ).toBe(5);
    expect(await q(`SELECT id FROM fixture.item WHERE id = $1`, [t.root])).toHaveLength(1); // nothing destructive
    await db.admin(`ALTER TABLE audit.audit_event DROP CONSTRAINT test_reject_split`);
    // Right after: the split commits, then the content step fails once and resumes.
    env.controls.failContent = 1;
    await env.drain();
    expect(await batch(t.batchId)).toMatchObject({
      state: 'purged',
      terminal_outcome: 'purged_with_exclusions',
    });
    const succ = await successorsOf(t.batchId);
    expect(succ).toHaveLength(1);
    expect(
      (
        await q(
          `SELECT count(*)::int AS n FROM core.deletion_batch_member WHERE record_id = $1 AND outcome = 'pending'`,
          [t.a1],
        )
      )[0].n,
    ).toBe(1);
    expect(ledgerEntries()).toHaveLength(1);
    expect(
      (
        await q(
          `SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'record.partial_purge_split'`,
        )
      )[0].n,
    ).toBe(1);
  });

  it('concurrent requests and workers produce one split and one successor membership per record', async () => {
    const t = await oneLocked();
    const ops = await Promise.all([purge(t.batchId), purge(t.batchId), purge(t.batchId)]);
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(1);
    const other = lifecycleEnv(h, { ledger: new LocalFilePurgeLedger(dir) });
    await Promise.all([env.drain(), other.drain()]);
    expect(await successorsOf(t.batchId)).toHaveLength(1);
    const active = await q(
      `SELECT record_id, count(*)::int AS n FROM core.deletion_batch_member WHERE outcome = 'pending' GROUP BY 1`,
    );
    expect(active.every((r) => r.n === 1)).toBe(true);
    expect(ledgerEntries()).toHaveLength(1);
  });

  it('the database forbids dual active membership and terminal batches that still own trashed records', async () => {
    const id = await env.create(ws.id, 'Guarded');
    const t = await trash(id);
    const other = newUuidV7();
    await db.admin(
      `INSERT INTO core.deletion_batch (id, workspace_id, root_record_id, trashed_by_type, restore_location, member_count, correlation_id)
                    VALUES ($1, $2, $3, 'system', '{}', 1, $4)`,
      [other, ws.id, id, newUuidV7()],
    );
    await expect(
      db.admin(
        `INSERT INTO core.deletion_batch_member (workspace_id, batch_id, record_id, record_type, prior_lifecycle_state, depth)
                VALUES ($1, $2, $3, 'foundation_fixture', 'active', 0)`,
        [ws.id, other, id],
      ),
    ).rejects.toThrow(/deletion_batch_member_active/);
    await expect(
      db
        .admin(
          `UPDATE core.deletion_batch SET state = 'purging', operation_id = $2, purge_started_at = now(), version = version + 1 WHERE id = $1`,
          [t.batchId, newUuidV7()],
        )
        .then(() =>
          db.admin(
            `UPDATE core.deletion_batch SET state = 'purged', purged_at = now(), ledger_entry_id = 'x', ledger_acknowledged_at = now(), terminal_outcome = 'purged', version = version + 1 WHERE id = $1`,
            [t.batchId],
          ),
        ),
    ).rejects.toThrow(/strand trashed members/);
    await db.admin(
      `UPDATE core.deletion_batch SET state = 'trashed', version = version + 1 WHERE id = $1`,
      [t.batchId],
    );
    // A purged batch never takes a trashed record back.
    const done = newUuidV7();
    const tomb = await env.create(ws.id, 'Elsewhere');
    await db.admin(
      `INSERT INTO core.deletion_batch (id, workspace_id, root_record_id, trashed_by_type, restore_location, member_count, correlation_id, state, operation_id, purge_started_at, purged_at, ledger_entry_id, ledger_acknowledged_at, terminal_outcome)
                    VALUES ($1, $2, $3, 'system', '{}', 1, $4, 'purged', $4, now(), now(), 'x', now(), 'purged')`,
      [done, ws.id, tomb, newUuidV7()],
    );
    await expect(
      db.admin(
        `UPDATE core.record SET deletion_batch_id = $2, version = version + 1 WHERE id = $1`,
        [id, done],
      ),
    ).rejects.toThrow(/belong to a trashed batch/);
    // Membership history cannot be rewritten once settled.
    await expect(
      db
        .admin(`UPDATE core.deletion_batch_member SET outcome = 'pending' WHERE batch_id = $1`, [
          done,
        ])
        .then(async () =>
          db.admin(
            `UPDATE core.deletion_batch_member SET outcome = 'moved_to_successor' WHERE batch_id = $1`,
            [t.batchId],
          ),
        ),
    ).rejects.toThrow(/successor_consistency|immutable/);
  });
});
