import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUuidV7 } from '@pm/contracts';
import {
  assertWritable,
  DELETED_ITEM,
  getRecord,
  listRecords,
  listTrash,
  PolicyDecision,
  PolicyDecisionError,
  resolveRecordLink,
  UnavailablePurgeLedger,
} from '@pm/lifecycle';
import { testDecision } from '@pm/lifecycle/testing';
import {
  createHarness,
  createWorkspace,
  seedBrand,
  type Harness,
  type SyntheticWorkspace,
} from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { installFixtureSchema, lifecycleEnv, type LifecycleEnv } from './fixture.ts';

describe('lifecycle commands: archive, trash, restore (0B §8.3-§8.6)', () => {
  let db: TestDatabase;
  let h: Harness;
  let ws: SyntheticWorkspace;
  let other: SyntheticWorkspace;
  let env: LifecycleEnv;
  let brandActive = true;

  beforeAll(async () => {
    db = await createTestDatabase();
    await installFixtureSchema(db);
    h = createHarness(db);
    ws = await createWorkspace(h.app, 'Lifecycle');
    other = await createWorkspace(h.app, 'Other tenant');
    env = lifecycleEnv(h, {
      ledger: new UnavailablePurgeLedger(),
      brands: { isActive: () => Promise.resolve(brandActive) },
    });
  });
  afterAll(async () => {
    await h.close();
    await db.drop();
  });

  const d = <A extends Parameters<typeof testDecision>[0]>(action: A, w = ws.id) =>
    testDecision(action, w, { principalId: env.principal.id });
  const input = (w = ws.id) => ({ exec: env.exec(w), source: { kind: 'ui' as const } });
  const tx = <T>(
    fn: (t: Parameters<Parameters<Harness['app']['withWorkspace']>[2]>[0]) => Promise<T>,
    w = ws.id,
  ) => h.app.withWorkspace(w, { module: 'test' }, fn);
  const state = async (id: string) =>
    (
      await db.admin(
        `SELECT r.lifecycle_state AS s, i.lifecycle_state AS typed FROM core.record r
                     LEFT JOIN fixture.item i ON i.id = r.id WHERE r.id = $1`,
        [id],
      )
    ).rows[0] as { s: string; typed: string | null };

  /** root → a → a1, root → b; a2 under a is archived on its own first. */
  async function tree() {
    const root = await env.create(ws.id, 'Root');
    const a = await env.create(ws.id, 'A', root);
    const a1 = await env.create(ws.id, 'A1', a);
    const a2 = await env.create(ws.id, 'A2', a);
    const b = await env.create(ws.id, 'B', root);
    return { root, a, a1, a2, b };
  }

  it('policy decisions cannot be forged and must match the action, workspace, and target', async () => {
    expect(
      () =>
        new PolicyDecision(Symbol('forged'), {
          action: 'record.trash',
          workspaceId: ws.id,
          recordIds: null,
          principal: { type: 'member', id: env.principal.id },
        }),
    ).toThrow(/policy layer only/);
    const t = await tree();
    await expect(
      tx((x) => env.svc.trash(x, undefined as never, input(), t.root)),
    ).rejects.toBeInstanceOf(PolicyDecisionError);
    await expect(tx((x) => env.svc.trash(x, d('record.archive'), input(), t.root))).rejects.toThrow(
      /wrong action/,
    );
    await expect(
      tx((x) => env.svc.trash(x, d('record.trash', other.id), input(), t.root)),
    ).rejects.toThrow(/wrong workspace/);
    const narrow = testDecision('record.trash', ws.id, {
      principalId: env.principal.id,
      recordIds: [t.b],
    });
    await expect(tx((x) => env.svc.trash(x, narrow, input(), t.root))).rejects.toThrow(
      /not covered/,
    );
  });

  it('archive cascades through containment only and records exact batch membership', async () => {
    const t = await tree();
    const pre = await tx((x) => env.svc.archive(x, d('record.archive'), input(), t.a2));
    const outsider = await env.create(ws.id, 'Linked outsider');
    await env.link(ws.id, t.a, outsider);
    const r = await tx((x) => env.svc.archive(x, d('record.archive'), input(), t.root));
    expect(r.members).toBe(4); // root, a, a1, b (a2 already archived on its own batch)
    const rows = await db.admin(
      `SELECT id, lifecycle_state, archive_cause, archive_batch_id FROM core.record WHERE id = ANY($1)`,
      [[t.root, t.a, t.a1, t.a2, t.b, outsider]],
    );
    const by = Object.fromEntries(rows.rows.map((x) => [x.id, x]));
    expect(by[t.root]).toMatchObject({
      lifecycle_state: 'archived',
      archive_cause: 'self',
      archive_batch_id: r.batchId,
    });
    expect(by[t.a1]).toMatchObject({ archive_cause: 'cascade', archive_batch_id: r.batchId });
    expect(by[t.a2]).toMatchObject({ archive_cause: 'self', archive_batch_id: pre.batchId });
    expect(by[outsider]).toMatchObject({ lifecycle_state: 'active' }); // associations never cascade
    expect((await state(t.a1)).typed).toBe('archived'); // typed row mirrors the envelope
    // Archived records are read-only and hidden from default reads.
    await expect(tx((x) => assertWritable(x, t.a))).rejects.toMatchObject({ reason: 'not_active' });
    expect(await tx((x) => getRecord(x, t.a))).toBeNull();
    expect((await tx((x) => getRecord(x, t.a, 'active_or_archived')))?.lifecycleState).toBe(
      'archived',
    );
    // Repeating is idempotent; unarchiving a cascaded member is refused.
    expect(await tx((x) => env.svc.archive(x, d('record.archive'), input(), t.root))).toMatchObject(
      {
        alreadyArchived: true,
        batchId: r.batchId,
      },
    );
    await expect(
      tx((x) => env.svc.unarchive(x, d('record.restore'), input(), t.a)),
    ).rejects.toMatchObject({
      reason: 'archived_by_container',
    });
    // Unarchive reverses exactly that batch: a2 stays archived under its own batch.
    expect(
      await tx((x) => env.svc.unarchive(x, d('record.restore'), input(), t.root)),
    ).toMatchObject({ members: 4 });
    expect((await state(t.a1)).s).toBe('active');
    expect((await state(t.a2)).s).toBe('archived');
    const batch = await db.admin(`SELECT state FROM core.archive_batch WHERE id = $1`, [r.batchId]);
    expect(batch.rows[0].state).toBe('restored');
  });

  it('concurrent archive requests on one subtree produce one batch and never split it', async () => {
    const t = await tree();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        tx((x) => env.svc.archive(x, d('record.archive'), input(), t.root)),
      ),
    );
    const created = results.filter((r) => !r.alreadyArchived);
    expect(created).toHaveLength(1);
    const batches = await db.admin(
      `SELECT DISTINCT archive_batch_id FROM core.record WHERE id = ANY($1) AND lifecycle_state = 'archived' AND id <> $2`,
      [[t.root, t.a, t.a1, t.b], t.a2],
    );
    expect(batches.rows).toHaveLength(1);
  });

  it('trash preserves prior states and restore returns them with the same ids, once', async () => {
    const t = await tree();
    await tx((x) => env.svc.archive(x, d('record.archive'), input(), t.a1));
    const before = (
      await db.admin(`SELECT id, public_id FROM core.record WHERE id = ANY($1) ORDER BY id`, [
        [t.root, t.a, t.a1, t.a2, t.b],
      ])
    ).rows;
    const r = await tx((x) => env.svc.trash(x, d('record.trash'), input(), t.root));
    expect(r.members).toBe(5);
    const members = await db.admin(
      `SELECT record_id, prior_lifecycle_state, depth FROM core.deletion_batch_member WHERE batch_id = $1`,
      [r.batchId],
    );
    expect(members.rows.find((m) => m.record_id === t.a1)).toMatchObject({
      prior_lifecycle_state: 'archived',
      depth: 2,
    });
    // Default reads exclude trash entirely, even with archived included.
    expect(await tx((x) => getRecord(x, t.b, 'active_or_archived'))).toBeNull();
    expect(
      (await tx((x) => listRecords(x, { visibility: 'active_or_archived' }))).some(
        (e) => e.id === t.b,
      ),
    ).toBe(false);
    // Only the trash repository enumerates it, and only with trash.manage.
    await expect(
      tx((x) => listTrash(x, d('record.trash'), { recoveryPeriodMs: null })),
    ).rejects.toThrow(/wrong action/);
    const trash = await tx((x) => listTrash(x, d('trash.manage'), { recoveryPeriodMs: null }));
    expect(trash.find((b) => b.batchId === r.batchId)).toMatchObject({
      memberCount: 5,
      purgeEligibleAt: null,
    });
    // Trashing a member of another batch directly is refused; re-trashing the root is idempotent.
    await expect(
      tx((x) => env.svc.trash(x, d('record.trash'), input(), t.a)),
    ).rejects.toMatchObject({ reason: 'in_trash' });
    expect(await tx((x) => env.svc.trash(x, d('record.trash'), input(), t.root))).toMatchObject({
      alreadyTrashed: true,
    });
    // Concurrent restores: one restores, the rest observe the result.
    const restores = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        tx((x) => env.svc.restore(x, d('record.restore'), input(), r.batchId)),
      ),
    );
    const ok = restores
      .filter((p) => p.status === 'fulfilled')
      .map((p) => (p as PromiseFulfilledResult<{ alreadyRestored: boolean }>).value);
    expect(ok.filter((v) => !v.alreadyRestored)).toHaveLength(1);
    expect((await state(t.a1)).s).toBe('archived');
    expect((await state(t.a)).s).toBe('active');
    const after = (
      await db.admin(`SELECT id, public_id FROM core.record WHERE id = ANY($1) ORDER BY id`, [
        [t.root, t.a, t.a1, t.a2, t.b],
      ])
    ).rows;
    expect(after).toEqual(before);
    const batch = await db.admin(
      `SELECT state, terminal_outcome FROM core.deletion_batch WHERE id = $1`,
      [r.batchId],
    );
    expect(batch.rows[0]).toEqual({ state: 'restored', terminal_outcome: 'restored' });
    // Restore emits a distinct restored event per member and replays nothing from the original history.
    const events = await db.admin(
      `SELECT event_type, count(*)::int AS n FROM exec.outbox_event WHERE aggregate_id = $1 GROUP BY 1 ORDER BY 1`,
      [t.b],
    );
    expect(events.rows).toEqual([
      { event_type: 'core.record.restored', n: 1 },
      { event_type: 'core.record.trashed', n: 1 },
    ]);
    const audit = await db.admin(
      `SELECT action FROM audit.audit_event WHERE target_record_id = $1 ORDER BY chain_seq`,
      [t.b],
    );
    expect(audit.rows.map((x) => x.action)).toEqual([
      'record.created',
      'record.trashed',
      'record.restored',
    ]);
  });

  it('restore fails with typed reasons: trashed or missing container, inactive brand, expired recovery', async () => {
    const parent = await env.create(ws.id, 'Parent');
    const child = await env.create(ws.id, 'Child', parent);
    const childBatch = await tx((x) => env.svc.trash(x, d('record.trash'), input(), child));
    const parentBatch = await tx((x) => env.svc.trash(x, d('record.trash'), input(), parent));
    await expect(
      tx((x) => env.svc.restore(x, d('record.restore'), input(), childBatch.batchId)),
    ).rejects.toMatchObject({
      reason: 'container_trashed',
    });
    // The failed attempt left the batch untouched (the transition is rolled back with it).
    expect(
      (await db.admin(`SELECT state FROM core.deletion_batch WHERE id = $1`, [childBatch.batchId]))
        .rows[0].state,
    ).toBe('trashed');
    await tx((x) => env.svc.restore(x, d('record.restore'), input(), parentBatch.batchId));
    expect(
      await tx((x) => env.svc.restore(x, d('record.restore'), input(), childBatch.batchId)),
    ).toMatchObject({ alreadyRestored: false });

    const brand = (await seedBrand(db.admin, ws.id)).id;
    const branded = await env.create(ws.id, 'Branded', undefined, { brandId: brand });
    const brandedBatch = await tx((x) => env.svc.trash(x, d('record.trash'), input(), branded));
    brandActive = false;
    await expect(
      tx((x) => env.svc.restore(x, d('record.restore'), input(), brandedBatch.batchId)),
    ).rejects.toMatchObject({
      reason: 'brand_inactive',
    });
    brandActive = true;

    const old = await env.create(ws.id, 'Old');
    const oldBatch = await tx((x) => env.svc.trash(x, d('record.trash'), input(), old));
    await db.admin(
      `INSERT INTO governance.retention_policy (id, workspace_id, retention_class, period, source, effective_from)
                    VALUES ($1, $2, 'R-LIVE', interval '1 hour', 'workspace', now() - interval '1 day')`,
      [newUuidV7(), ws.id],
    );
    await db.admin(`BEGIN; SET LOCAL session_replication_role = replica;
                    UPDATE core.deletion_batch SET trashed_at = now() - interval '2 hours' WHERE id = '${oldBatch.batchId}'; COMMIT;`);
    await expect(
      tx((x) => env.svc.restore(x, d('record.restore'), input(), oldBatch.batchId)),
    ).rejects.toMatchObject({
      reason: 'recovery_expired',
    });
    await db.admin(`DELETE FROM governance.retention_policy WHERE workspace_id = $1`, [ws.id]);
    await expect(
      tx((x) => env.svc.restore(x, d('record.restore'), input(), newUuidV7())),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('links resolve to one generic deleted item for trashed, unknown, and malformed ids', async () => {
    const id = await env.create(ws.id, 'Linked title that must not leak');
    const rec = await tx((x) => getRecord(x, id));
    expect(await tx((x) => resolveRecordLink(x, rec!.publicId))).toMatchObject({ kind: 'record' });
    await tx((x) => env.svc.trash(x, d('record.trash'), input(), id));
    const trashed = await tx((x) => resolveRecordLink(x, rec!.publicId));
    const unknown = await tx((x) => resolveRecordLink(x, 'fxt_0J8ZK3Q5B8V2N4M6P7R9S0T1HA'));
    const malformed = await tx((x) => resolveRecordLink(x, 'nonsense'));
    expect(trashed).toBe(DELETED_ITEM);
    expect(unknown).toBe(DELETED_ITEM);
    expect(malformed).toBe(DELETED_ITEM);
    expect(JSON.stringify(trashed)).toBe('{"kind":"deleted_item"}');
    // Another tenant's id resolves the same way (RLS), never to the record.
    expect(await tx((x) => resolveRecordLink(x, rec!.publicId), other.id)).toBe(DELETED_ITEM);
  });

  it('isolates tenants: other workspaces, unset contexts, and cross-tenant writes see or change nothing', async () => {
    const mine = await env.create(ws.id, 'Mine');
    await tx((x) => env.svc.trash(x, d('record.trash'), input(), mine));
    const theirs = await env.create(other.id, 'Theirs');
    for (const db_ of [h.app, h.worker]) {
      const seen = await db_.withWorkspace(
        other.id,
        { module: 'test', readOnly: true },
        async (x) => ({
          records: await x.db.selectFrom('core.record').select('workspace_id').execute(),
          batches: await x.db.selectFrom('core.deletion_batch').select('workspace_id').execute(),
          members: await x.db
            .selectFrom('core.deletion_batch_member')
            .select('workspace_id')
            .execute(),
        }),
      );
      expect(new Set(seen.records.map((r) => r.workspace_id))).toEqual(new Set([other.id]));
      expect(seen.batches).toEqual([]);
      expect(seen.members).toEqual([]);
    }
    // A command cannot reach another tenant's record even with a decision for its own workspace.
    await expect(
      tx((x) => env.svc.trash(x, d('record.trash'), input(), theirs)),
    ).rejects.toMatchObject({ reason: 'not_found' });
    // Unset context: zero rows, writes refused.
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: db.worker });
    await c.connect();
    try {
      for (const t of [
        'core.record',
        'core.archive_batch',
        'core.deletion_batch',
        'core.deletion_batch_member',
        'governance.retention_policy',
      ])
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      await expect(
        c
          .query(`UPDATE core.record SET version = version + 1 WHERE id = $1`, [theirs])
          .then((r) => r.rowCount),
      ).resolves.toBe(0);
    } finally {
      await c.end();
    }
  });

  it('the database guards transitions, identity, versions, and batch facts', async () => {
    const id = await env.create(ws.id, 'Guarded');
    await expect(
      db.admin(
        `UPDATE core.record SET lifecycle_state = 'purged', version = version + 1 WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/not allowed|record_/);
    await expect(
      db.admin(
        `UPDATE core.record SET public_id = 'fxt_0J8ZK3Q5B8V2N4M6P7R9S0T1HB', version = version + 1 WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.admin(`UPDATE core.record SET source_ref = 'x' WHERE id = $1`, [id]),
    ).rejects.toThrow(/version/);
    await expect(db.admin(`DELETE FROM core.record WHERE id = $1`, [id])).rejects.toThrow(
      /only tombstones/,
    );
    const b = await tx((x) => env.svc.trash(x, d('record.trash'), input(), id));
    await expect(
      db.admin(
        `UPDATE core.deletion_batch SET state = 'purged', version = version + 1 WHERE id = $1`,
        [b.batchId],
      ),
    ).rejects.toThrow(/not allowed|deletion_batch_/);
    await expect(
      db.admin(`DELETE FROM core.deletion_batch_member WHERE batch_id = $1`, [b.batchId]),
    ).rejects.toThrow(/append-only/);
  });

  it('a lifecycle command whose audit insert fails rolls back entirely (0D §12.2)', async () => {
    const parent = await env.create(ws.id, 'Atomic');
    const child = await env.create(ws.id, 'Atomic child', parent);
    // Make the audit insert itself fail in the database (simulated storage-side failure).
    await db.admin(
      `ALTER TABLE audit.audit_event ADD CONSTRAINT test_reject_archive CHECK (action <> 'record.archived') NOT VALID`,
    );
    try {
      await expect(
        tx((x) => env.svc.archive(x, d('record.archive'), input(), parent)),
      ).rejects.toThrow(/audit write failed/);
    } finally {
      await db.admin(`ALTER TABLE audit.audit_event DROP CONSTRAINT test_reject_archive`);
    }
    expect((await state(parent)).s).toBe('active');
    expect((await state(child)).s).toBe('active');
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM core.archive_batch WHERE root_record_id = $1`,
          [parent],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM exec.outbox_event WHERE aggregate_id = $1 AND event_type = 'core.record.archived'`,
          [parent],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
