import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  AuditWriter,
  change,
  CommandContext,
  projectActivity,
  toAuditEventContract,
  verifyAuditChain,
} from '@pm/audit';
import { newUuidV7 } from '@pm/contracts';
import type { WorkspaceTransaction } from '@pm/db';
import {
  DELETED_ITEM,
  LocalFilePurgeLedger,
  markRestored,
  readRecoveryGate,
  reopen,
  replayPurgeLedger,
  resolveRecordLink,
  UnavailablePurgeLedger,
  type HoldPort,
  type PurgeLedger,
} from '@pm/lifecycle';
import { testDecision } from '@pm/lifecycle/testing';
import { systemExecutionContext } from '@pm/platform';
import {
  contractErrors,
  createHarness,
  createWorkspace,
  type Harness,
  type SyntheticWorkspace,
} from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { installFixtureSchema, lifecycleEnv, newLedgerDir, type LifecycleEnv } from './fixture.ts';

describe('durable purge, tombstones, retention, and the purge ledger (0B §8.7-§8.11)', () => {
  let db: TestDatabase;
  let h: Harness;
  let ws: SyntheticWorkspace;
  let dir: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    await installFixtureSchema(db);
    h = createHarness(db);
    ws = await createWorkspace(h.app, 'Purge');
    dir = newLedgerDir();
  });
  afterEach(async () => {
    await h.close();
    await db.drop();
  });

  const setup = (
    o: Parameters<typeof lifecycleEnv>[1] = { ledger: new LocalFilePurgeLedger(newLedgerDir()) },
  ) => lifecycleEnv(h, o);
  const tx = <T>(fn: (t: WorkspaceTransaction) => Promise<T>) =>
    h.app.withWorkspace(ws.id, { module: 'test' }, fn);
  const input = (env: LifecycleEnv) => ({ exec: env.exec(ws.id), source: { kind: 'ui' as const } });
  const q = async (text: string, params: unknown[] = []) => (await db.admin(text, params)).rows;

  /** root → a → a1, root → b, with an association a ↔ outsider and audited plain values. */
  async function trashedTree(env: LifecycleEnv, options: { lockA1?: boolean } = {}) {
    const root = await env.create(ws.id, 'Confidential root title');
    const a = await env.create(ws.id, 'A', root);
    const a1 = await env.create(ws.id, 'A1', a, { evidenceLocked: options.lockA1 ?? false });
    const b = await env.create(ws.id, 'B', root);
    const outsider = await env.create(ws.id, 'Outsider');
    await env.link(ws.id, a, outsider);
    const writer = new AuditWriter({
      module: 'fixture',
      logger: h.logger,
      metrics: h.telemetry.metrics,
    });
    for (const id of [root, a])
      await tx((x) =>
        writer.write(x, CommandContext.fromExecution(env.exec(ws.id), { kind: 'ui' }), {
          action: 'record.updated',
          target: { recordId: id, type: 'foundation_fixture', publicId: null },
          changes: [
            change.plain('title', 'Draft name', 'Confidential root title'),
            change.secret('api_key'),
          ],
        }),
      );
    await h.worker.withWorkspace(ws.id, { module: 'test' }, (x) => projectActivity(x, root));
    const batch = await tx((x) =>
      env.svc.trash(
        x,
        testDecision('record.trash', ws.id, { principalId: env.principal.id }),
        input(env),
        root,
      ),
    );
    return { root, a, a1, b, outsider, batchId: batch.batchId };
  }

  const requestPurge = (env: LifecycleEnv, batchId: string) =>
    tx((x) =>
      env.svc.requestPurge(
        x,
        testDecision('record.purge', ws.id, { principalId: env.principal.id }),
        input(env),
        batchId,
      ),
    );
  const batchRow = async (id: string) =>
    (await q(`SELECT * FROM core.deletion_batch WHERE id = $1`, [id]))[0];

  it('purges bottom-up through hooks, enqueues object effects, redacts audit values, and leaves content-free tombstones', async () => {
    const ledger = new LocalFilePurgeLedger(dir);
    const env = setup({ ledger });
    const t = await trashedTree(env);
    const publicRoot = (await q(`SELECT public_id FROM core.record WHERE id = $1`, [t.root]))[0]
      .public_id;
    const { operationId } = await requestPurge(env, t.batchId);
    expect((await requestPurge(env, t.batchId)).deduplicated).toBe(true);
    await env.drain();

    const batch = await batchRow(t.batchId);
    expect(batch).toMatchObject({
      state: 'purged',
      terminal_outcome: 'purged',
      ledger_entry_id: `purge:${t.batchId}`,
    });
    expect(batch.ledger_acknowledged_at).toBeInstanceOf(Date);
    // Typed content and associations are gone; the unrelated outsider survives.
    expect(
      await q(`SELECT id FROM fixture.item WHERE id = ANY($1)`, [[t.root, t.a, t.a1, t.b]]),
    ).toEqual([]);
    expect(await q(`SELECT * FROM fixture.link`)).toEqual([]);
    expect(
      (await q(`SELECT lifecycle_state FROM core.record WHERE id = $1`, [t.outsider]))[0]
        .lifecycle_state,
    ).toBe('active');
    // Tombstones keep structural facts only.
    const tombs = await q(
      `SELECT lifecycle_state, purged_at, trashed_at, source_ref, owner_membership_id, archive_batch_id, record_type, public_id
       FROM core.record WHERE id = ANY($1)`,
      [[t.root, t.a, t.a1, t.b]],
    );
    for (const r of tombs)
      expect(r).toMatchObject({
        lifecycle_state: 'purged',
        source_ref: null,
        owner_membership_id: null,
        archive_batch_id: null,
        record_type: 'foundation_fixture',
      });
    expect(await tx((x) => resolveRecordLink(x, publicRoot))).toBe(DELETED_ITEM);
    // Object deletions are enqueued as effects with stable keys, not performed.
    const effects = await q(
      `SELECT effect_key, state FROM exec.external_effect WHERE operation_id = $1 ORDER BY 1`,
      [operationId],
    );
    expect(effects.filter((e) => e.effect_key.startsWith('object:'))).toHaveLength(4);
    expect(
      effects.filter((e) => e.effect_key.startsWith('object:')).every((e) => e.state === 'pending'),
    ).toBe(true);
    expect(effects.find((e) => e.effect_key === `purge-ledger:${t.batchId}`)?.state).toMatch(
      /sent|confirmed/,
    );
    // Audit values of purged targets are redacted explicitly; structure and secrets' flags remain.
    const audit = await q(
      `SELECT a.id, a.action, a.actor_id, a.changes FROM audit.audit_event a WHERE target_record_id = $1 ORDER BY chain_seq`,
      [t.root],
    );
    expect(audit.map((r) => r.action)).toEqual([
      'record.created',
      'record.updated',
      'record.trashed',
      'record.purge_requested',
      'record.purged',
    ]);
    expect(JSON.stringify(audit).includes('Confidential root title')).toBe(false);
    const updated = audit[1];
    expect(updated.changes[0]).toMatchObject({ field: 'title', redacted: true, reason: 'purge' });
    expect(updated.changes[0]).not.toHaveProperty('new');
    expect(updated.changes[1]).toMatchObject({ field: 'api_key', class: 'secret', changed: true });
    const red = await q(
      `SELECT fields, reason, operation_id FROM audit.audit_redaction WHERE audit_event_id = $1`,
      [updated.id],
    );
    expect(red).toEqual([{ fields: ['title'], reason: 'purge', operation_id: operationId }]);
    // Stored events (plain and redacted) conform to the 0D audit-event contract.
    const rows = await q(
      `SELECT * FROM audit.audit_event WHERE target_record_id = $1 ORDER BY chain_seq`,
      [t.root],
    );
    for (const row of rows)
      expect(contractErrors('audit-event', toAuditEventContract(row)), row.action).toEqual([]);
    // The chain still verifies: redaction kept every digest and was recorded.
    const chain = await h.worker.withWorkspace(ws.id, { module: 'test' }, (x) =>
      verifyAuditChain(x),
    );
    expect(chain.problems).toEqual([]);
    // The activity projection for purged targets is gone.
    expect(
      await q(`SELECT * FROM audit.activity_item WHERE target_record_id = ANY($1)`, [
        [t.root, t.a, t.a1, t.b],
      ]),
    ).toEqual([]);
    // The ledger holds identifiers and times only.
    const text = readFileSync(`${dir}/purge-ledger.jsonl`, 'utf8');
    const entry = JSON.parse(text.trim());
    expect(Object.keys(entry).sort()).toEqual(
      [
        'acknowledgedAt',
        'batchId',
        'entryId',
        'operationId',
        'purgedAt',
        'records',
        'rootRecordId',
        'trashedAt',
        'workspaceId',
      ].sort(),
    );
    expect(text.includes('Confidential')).toBe(false);
    expect(entry.records).toHaveLength(4);
    const op = (
      await q(`SELECT execution_state FROM exec.operation WHERE id = $1`, [operationId])
    )[0];
    expect(op.execution_state).toBe('succeeded');
    // Purged content and identifiers never reach logs, spans, or metric labels.
    const logs = h.sink.lines.join('\n');
    const spans = JSON.stringify(h.telemetry.spans!.getFinishedSpans().map((sp) => sp.attributes));
    const { resourceMetrics } = await h.telemetry.metricReader!.collect();
    const labels = JSON.stringify(
      resourceMetrics.scopeMetrics.flatMap((sm) =>
        sm.metrics.flatMap((m) => m.dataPoints.map((dp) => dp.attributes)),
      ),
    );
    expect(labels).toContain('"transition":"purge"');
    for (const [where, text] of [
      ['logs', logs],
      ['spans', spans],
      ['metrics', labels],
    ] as const) {
      expect(text.includes('Confidential root title'), where).toBe(false);
      expect(text.includes('Draft name'), where).toBe(false);
    }
    for (const id of [t.root, t.a, t.a1, t.b, publicRoot])
      expect(labels.includes(id), 'metric id').toBe(false);
  });

  it('fails safe: a record type without purge hooks, no ledger, or a hold blocks before anything is deleted', async () => {
    const cases: Array<[string, Parameters<typeof lifecycleEnv>[1]]> = [
      ['missing_purge_hook', { ledger: new LocalFilePurgeLedger(dir), withPurgeHooks: false }],
      ['ledger_unavailable', { ledger: new UnavailablePurgeLedger() }],
      [
        'hold',
        {
          ledger: new LocalFilePurgeLedger(dir),
          holds: { isHeld: () => Promise.resolve(true) } satisfies HoldPort,
        },
      ],
    ];
    for (const [reason, options] of cases) {
      const env = setup(options);
      const t = await trashedTree(env);
      await requestPurge(env, t.batchId);
      await env.drain();
      const batch = await batchRow(t.batchId);
      expect(batch, reason).toMatchObject({
        state: 'trashed',
        block_result: reason,
        purged_at: null,
      });
      expect(
        (
          await q(`SELECT count(*)::int AS n FROM fixture.item WHERE id = ANY($1)`, [
            [t.root, t.a, t.a1, t.b],
          ])
        )[0].n,
        reason,
      ).toBe(4);
      expect((await q(`SELECT count(*)::int AS n FROM audit.audit_redaction`))[0].n, reason).toBe(
        0,
      );
    }
  });

  it('excludes evidence-locked members and keeps them; a fully locked batch is blocked', async () => {
    const env = setup({ ledger: new LocalFilePurgeLedger(dir) });
    const t = await trashedTree(env, { lockA1: true });
    await requestPurge(env, t.batchId);
    await env.drain();
    expect(await batchRow(t.batchId)).toMatchObject({
      state: 'purged',
      terminal_outcome: 'purged_with_exclusions',
      evidence_locked_count: 1,
      block_result: 'evidence_lock_partial',
    });
    expect(
      (await q(`SELECT lifecycle_state FROM core.record WHERE id = $1`, [t.a1]))[0].lifecycle_state,
    ).toBe('trashed');
    expect(await q(`SELECT title FROM fixture.item WHERE id = $1`, [t.a1])).toEqual([
      { title: 'A1' },
    ]);
    const lone = await env.create(ws.id, 'Locked alone', undefined, { evidenceLocked: true });
    const b2 = await tx((x) =>
      env.svc.trash(
        x,
        testDecision('record.trash', ws.id, { principalId: env.principal.id }),
        input(env),
        lone,
      ),
    );
    await requestPurge(env, b2.batchId);
    await env.drain();
    expect(await batchRow(b2.batchId)).toMatchObject({
      state: 'trashed',
      block_result: 'evidence_lock_all',
    });
  });

  it('resumes from checkpoints after interrupted hooks and never duplicates external effects', async () => {
    const env = setup({ ledger: new LocalFilePurgeLedger(dir) });
    env.controls.failContent = 1;
    env.controls.failProjections = 1;
    const t = await trashedTree(env);
    const { operationId } = await requestPurge(env, t.batchId);
    await env.drain();
    expect((await batchRow(t.batchId)).state).toBe('purged');
    // content ran again only after its own failure; the projections failure did not re-run it.
    expect(env.controls.contentCalls).toBe(4); // 1 failed + 3 depth levels on retry
    expect(env.controls.projectionCalls).toBe(2);
    const effects = await q(
      `SELECT effect_key, count(*)::int AS n FROM exec.external_effect WHERE operation_id = $1 GROUP BY 1`,
      [operationId],
    );
    expect(effects.every((e) => e.n === 1)).toBe(true);
    const attempts = await q(
      `SELECT count(*)::int AS n FROM exec.attempt WHERE operation_id = $1`,
      [operationId],
    );
    expect(attempts[0].n).toBeGreaterThanOrEqual(3);
  });

  it('a purge is not complete until the ledger acknowledges; ledger failures retry', async () => {
    const real = new LocalFilePurgeLedger(dir);
    let failures = 2;
    const flaky: PurgeLedger = {
      kind: 'local',
      available: true,
      append: (e) =>
        failures-- > 0 ? Promise.reject(new Error('ledger store unavailable')) : real.append(e),
      entriesAfter: (p) => real.entriesAfter(p),
    };
    const env = setup({ ledger: flaky });
    const t = await trashedTree(env);
    await requestPurge(env, t.batchId);
    await env.worker.start({ loop: false });
    await env.worker.runCycle({ wait: true });
    const mid = await batchRow(t.batchId);
    expect(mid).toMatchObject({ state: 'purging', ledger_acknowledged_at: null, purged_at: null });
    await env.drain();
    expect(await batchRow(t.batchId)).toMatchObject({ state: 'purged' });
    expect(
      (await real.entriesAfter(new Date(0))).filter((e) => e.batchId === t.batchId),
    ).toHaveLength(1);
  });

  it('retention: an undecided period purges nothing; a decided one schedules the system purge', async () => {
    const env = setup({ ledger: new LocalFilePurgeLedger(dir) });
    const t = await trashedTree(env);
    await db.admin(`BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE core.deletion_batch SET trashed_at = now() - interval '400 days' WHERE id = '${t.batchId}'; COMMIT;`);
    let clockDays = 0;
    const runScheduler = async () => {
      if (env.worker.state !== 'running') await env.worker.start({ loop: false });
      clockDays += 2; // each run is a later scheduler tick
      await env.worker.enqueueDueSchedules(Date.now() + clockDays * 24 * 60 * 60_000);
      await env.drain();
    };
    const purgeOps = async () =>
      (await q(`SELECT count(*)::int AS n FROM exec.operation WHERE kind = 'purge'`))[0].n;
    // Platform default unset, no workspace value: nothing, however old.
    await runScheduler();
    expect(await purgeOps()).toBe(0);
    // An explicit NULL workspace value is still "undecided".
    await db.admin(
      `INSERT INTO governance.retention_policy (id, workspace_id, retention_class, period, source)
                    VALUES ($1, $2, 'R-LIVE', NULL, 'workspace')`,
      [newUuidV7(), ws.id],
    );
    await runScheduler();
    expect(await purgeOps()).toBe(0);
    expect((await batchRow(t.batchId)).state).toBe('trashed');
    // The tombstone sweep stays disabled without an audit retention period.
    const tombstones = async () =>
      (await q(`SELECT count(*)::int AS n FROM core.record WHERE lifecycle_state = 'purged'`))[0].n;
    // A decided period makes the batch due; the purge runs as the system.
    await db.admin(
      `INSERT INTO governance.retention_policy (id, workspace_id, retention_class, period, source, effective_from)
                    VALUES ($1, $2, 'R-LIVE', interval '30 days', 'workspace', now() + interval '1 millisecond')`,
      [newUuidV7(), ws.id],
    );
    await new Promise((r) => setTimeout(r, 10));
    await runScheduler();
    expect(await purgeOps()).toBe(1);
    expect((await batchRow(t.batchId)).state).toBe('purged');
    const op = (
      await q(`SELECT initiated_by_actor_type FROM exec.operation WHERE kind = 'purge'`)
    )[0];
    expect(op.initiated_by_actor_type).toBe('system');
    const before = await tombstones();
    await runScheduler();
    expect(await tombstones()).toBe(before); // sweep disabled: nothing removed
  });

  it('post-restore replay re-applies newer ledger entries before the environment reopens', async () => {
    const ledger = new LocalFilePurgeLedger(dir);
    const env = setup({ ledger });
    // The restored database still has records whose trash and purge happened after the backup.
    const root = await env.create(ws.id, 'Restored root');
    const child = await env.create(ws.id, 'Restored child', root);
    const backupPoint = new Date(Date.now() - 60_000);
    const batchId = newUuidV7();
    await ledger.append({
      entryId: `purge:${batchId}`,
      workspaceId: ws.id,
      batchId,
      rootRecordId: root,
      operationId: newUuidV7(),
      records: [
        { id: root, recordType: 'foundation_fixture' },
        { id: child, recordType: 'foundation_fixture' },
      ],
      trashedAt: new Date(Date.now() - 30_000).toISOString(),
      purgedAt: new Date(Date.now() - 10_000).toISOString(),
    });
    const owner = new pg.Client({ connectionString: db.restore });
    await owner.connect();
    try {
      await markRestored(owner, backupPoint);
      expect(await readRecoveryGate(h.platform)).toEqual({ state: 'replay_required', backupPoint });
      expect(await h.health.recoveryGateOpen()).toBe(false);
      await expect(reopen(owner, 1, null)).rejects.toThrow(/replay incomplete/);
      const deps = {
        tenant: h.worker,
        svc: env.svc,
        executor: env.executor,
        systemContext: systemExecutionContext(null),
      };
      const r = await replayPurgeLedger(deps, backupPoint);
      expect(r).toMatchObject({ applied: 1, skipped: 0 });
      expect(
        await q(`SELECT lifecycle_state FROM core.record WHERE id = ANY($1)`, [[root, child]]),
      ).toEqual([{ lifecycle_state: 'purged' }, { lifecycle_state: 'purged' }]);
      expect(await q(`SELECT id FROM fixture.item WHERE id = ANY($1)`, [[root, child]])).toEqual(
        [],
      );
      expect(await batchRow(batchId)).toMatchObject({
        state: 'purged',
        ledger_entry_id: `purge:${batchId}`,
      });
      expect((await replayPurgeLedger(deps, backupPoint)).skipped).toBe(1); // idempotent
      // Entries at or before the backup point are already in the restored data: not replayed.
      expect((await replayPurgeLedger(deps, new Date())).applied).toBe(0);
      await reopen(owner, 0, r.replayedThrough);
      expect((await readRecoveryGate(h.platform)).state).toBe('open');
      expect(await h.health.recoveryGateOpen()).toBe(true);
    } finally {
      await owner.end();
    }
    // Application identities cannot reopen a closed environment themselves (a real app_rw login,
    // not a role switch on a pooled admin connection).
    const app = new pg.Client({ connectionString: db.app });
    await app.connect();
    try {
      await expect(app.query(`UPDATE ops.recovery_gate SET state = 'open'`)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await app.end();
    }
  });
});
