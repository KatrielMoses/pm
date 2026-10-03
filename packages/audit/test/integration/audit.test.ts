import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { newUuidV7, newTraceId, type ExecutionContext } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  AuditSecurityEventSink,
  AuditWriteError,
  AuditWriter,
  change,
  changeDigest,
  CommandContext,
  projectActivity,
  verifyAuditChain,
} from '@pm/audit';
import {
  createHarness,
  createWorkspace,
  executionContext,
  syntheticPrincipal,
  type Harness,
  type SyntheticWorkspace,
} from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';

describe('audit events: same-transaction truth, append-only storage, tamper evidence', () => {
  let db: TestDatabase;
  let h: Harness;
  let alpha: SyntheticWorkspace;
  let beta: SyntheticWorkspace;
  let writer: AuditWriter;
  const principal = syntheticPrincipal('member');
  const ctxFor = (ws: string): ExecutionContext => executionContext(ws, principal);
  const cmdFor = (ws: string) => CommandContext.fromExecution(ctxFor(ws), { kind: 'ui' });

  beforeAll(async () => {
    db = await createTestDatabase();
    h = createHarness(db);
    alpha = await createWorkspace(h.app, 'Audit alpha');
    beta = await createWorkspace(h.app, 'Audit beta');
    writer = new AuditWriter({ module: 'test', logger: h.logger, metrics: h.telemetry.metrics });
  });
  afterAll(async () => {
    await h.close();
    await db.drop();
  });

  const write = (
    ws: string,
    action = 'record.updated',
    changes = [change.plain('title', 'a', 'b')],
  ) =>
    h.app.withWorkspace(ws, { module: 'test' }, (tx) =>
      writer.write(tx, cmdFor(ws), {
        action,
        target: { recordId: newUuidV7(), type: 'task', publicId: null },
        changes,
      }),
    );

  it('writes inside the caller transaction; if the audit write fails, the mutation rolls back', async () => {
    const id = await write(alpha.id);
    const stored = await db.admin(
      'SELECT action, chain_seq, changes FROM audit.audit_event WHERE id = $1',
      [id],
    );
    expect(stored.rows[0]).toMatchObject({ action: 'record.updated', chain_seq: '1' });
    // A material mutation and a failing audit write in one transaction: nothing commits.
    await expect(
      h.app.withWorkspace(alpha.id, { module: 'test' }, async (tx) => {
        await tx.db
          .updateTable('tenancy.workspace')
          .set({ name: 'Renamed in the failing transaction' })
          .where('id', '=', alpha.id)
          .execute();
        await writer.write(tx, cmdFor(alpha.id), {
          action: 'NOT A VALID ACTION',
          target: { recordId: null, type: 'workspace', publicId: null },
        });
      }),
    ).rejects.toBeInstanceOf(AuditWriteError);
    const ws = await db.admin('SELECT name FROM tenancy.workspace WHERE id = $1', [alpha.id]);
    expect(ws.rows[0].name).toBe('Audit alpha');
    expect(h.sink.lines.some((l) => l.includes('"audit.write_failed"'))).toBe(true);
    // A database-level failure inside the insert also propagates and rolls back.
    await expect(
      h.app.withWorkspace(alpha.id, { module: 'test' }, async (tx) => {
        await tx.db
          .updateTable('tenancy.workspace')
          .set({ name: 'Also rolled back' })
          .where('id', '=', alpha.id)
          .execute();
        await writer.write(tx, cmdFor(beta.id), {
          action: 'record.updated',
          target: { recordId: null, type: 'task', publicId: null },
        });
      }),
    ).rejects.toThrow(/workspace mismatch/);
    expect(
      (await db.admin('SELECT name FROM tenancy.workspace WHERE id = $1', [alpha.id])).rows[0].name,
    ).toBe('Audit alpha');
  });

  it('the database rejects secrets, unclassified, malformed, nested, and oversized changes', async () => {
    // An empty workspace, so each attempted insert is a valid chain position (seq 1, genesis link).
    const empty = await createWorkspace(h.app, 'Change checks');
    const good = change.plain('title', 'a', 'b');
    const digest = (e: Record<string, unknown>) => changeDigest(e as never);
    const bad: unknown[][] = [
      [
        {
          field: 'api_key',
          class: 'secret',
          old: 'leaked',
          new: 'x',
          digest: digest({ field: 'api_key', class: 'secret' }),
        },
      ],
      [
        {
          field: 'api_key',
          class: 'secret',
          changed: true,
          hash: `sha256:${'0'.repeat(64)}`,
          digest: good.digest,
        },
      ],
      [{ field: 'title', old: 'a', new: 'b', digest: good.digest }],
      [{ field: 'title', class: 'mystery', old: 'a', new: 'b', digest: good.digest }],
      [{ field: 'title', class: 'plain', old: 'a', new: 'b' }],
      [
        {
          field: 'title',
          class: 'plain',
          old: { nested: { deep: 1 } },
          new: 'b',
          digest: good.digest,
        },
      ],
      [{ field: 'title', class: 'plain', old: 'a', new: 'x'.repeat(2001), digest: good.digest }],
      [{ field: 'session_token', class: 'plain', old: 'a', new: 'b', digest: good.digest }],
      [{ field: 'body', class: 'content', old: 'full body text', new: 'x', digest: good.digest }],
      [good, good],
      Array.from({ length: 201 }, (_, i) => ({ ...good, field: `f${i}` })),
    ];
    for (const changes of bad) {
      await expect(
        db.admin(
          `INSERT INTO audit.audit_event (id, occurred_at, workspace_id, action, actor_type, actor_id, target_type,
             changes, correlation_id, source_kind, chain_seq, prev_hash, hash)
           VALUES ($1, now(), $2, 'record.updated', 'human', $3, 'task', $4, $5, 'ui', 1, $6, $6)`,
          [
            newUuidV7(),
            empty.id,
            principal.id,
            JSON.stringify(changes),
            newUuidV7(),
            Buffer.alloc(32),
          ],
        ),
        JSON.stringify(changes).slice(0, 60),
      ).rejects.toThrow(/audit_event_changes_valid/);
    }
  });

  it('append-only for application, worker, misgranted support, maintainer, and owner paths', async () => {
    const id = await write(beta.id);
    const attempt = async (url: string, statement: string, setup: string[] = []) => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.workspace_id', $1, true)", [beta.id]);
        for (const s of setup) await c.query(s);
        await c.query(statement, statement.includes('$1') ? [id] : []);
        await c.query('COMMIT');
        return 'allowed';
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        return (err as { code?: string }).code ?? 'error';
      } finally {
        await c.end();
      }
    };
    const update = `UPDATE audit.audit_event SET action = 'record.forged' WHERE id = $1`;
    const del = `DELETE FROM audit.audit_event WHERE id = $1`;
    for (const url of [db.app, db.worker]) {
      expect(await attempt(url, update)).toBe('42501');
      expect(await attempt(url, del)).toBe('42501');
      expect(await attempt(url, 'TRUNCATE audit.audit_event')).toBe('42501');
      for (const t of ['audit.security_event', 'audit.audit_redaction', 'audit.chain_checkpoint'])
        expect(await attempt(url, `DELETE FROM ${t} WHERE id = $1`), t).toBe('42501');
    }
    // A support-like role that was wrongly granted UPDATE/DELETE is still stopped by the triggers.
    const probe = `support_probe_${Date.now()}`;
    await db.admin(`CREATE ROLE ${probe} LOGIN PASSWORD 'probe-password-1234567890'`);
    await db.admin(`GRANT CONNECT ON DATABASE ${db.database} TO ${probe}`);
    await db.admin(`GRANT USAGE ON SCHEMA audit, exec TO ${probe}`);
    await db.admin(
      `GRANT SELECT, UPDATE, DELETE, TRUNCATE ON audit.audit_event, audit.security_event TO ${probe}`,
    );
    const probeUrl = db.app.replace(/\/\/[^:]+:[^@]+@/, `//${probe}:probe-password-1234567890@`);
    expect(await attempt(probeUrl, update)).toBe('42501');
    expect(await attempt(probeUrl, del)).toBe('42501');
    expect(await attempt(probeUrl, 'TRUNCATE audit.audit_event')).toBe('42501');
    // The owner (migrator SET ROLE pm_owner) is stopped too: append-only is not convention.
    const owner = ['SET LOCAL ROLE pm_owner'];
    expect(await attempt(db.migrator, update, owner)).toBe('42501');
    expect(await attempt(db.migrator, del, owner)).toBe('42501');
    expect(await attempt(db.migrator, 'TRUNCATE audit.audit_event', owner)).toBe('42501');
    // audit_maintainer without a redaction operation, or changing structure, is refused.
    const maint = ['SET LOCAL ROLE pm_owner', 'SET LOCAL ROLE audit_maintainer'];
    expect(
      await attempt(
        db.migrator,
        `UPDATE audit.audit_event SET changes = changes WHERE id = $1`,
        maint,
      ),
    ).toBe('42501');
    const withOp = [
      ...maint,
      `SELECT set_config('app.redaction_operation_id', '${newUuidV7()}', true)`,
    ];
    expect(await attempt(db.migrator, update, withOp)).toBe('42501'); // no column privilege on action
    expect(
      await attempt(
        db.migrator,
        `UPDATE audit.audit_event SET changes = '[]'::jsonb WHERE id = $1`,
        withOp,
      ),
    ).toBe('42501'); // may not remove entries
    expect(await attempt(db.migrator, del, withOp)).toBe('42501');
    // Even the superuser's TRUNCATE fires the statement trigger.
    await expect(db.admin('TRUNCATE audit.audit_event')).rejects.toThrow(/append-only/);
    // No login identity can become audit_maintainer.
    const members = await db.admin(`
      SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      WHERE m.roleid = 'audit_maintainer'::regrole`);
    expect(members.rows.map((r) => r.rolname)).toEqual(['pm_owner']);
    for (const role of ['app_rw', 'app_worker', 'dispatcher']) {
      const can = await db.admin(
        `SELECT pg_has_role($1, 'audit_maintainer', 'USAGE') AS u, pg_has_role($1, 'audit_maintainer', 'SET') AS s`,
        [role],
      );
      expect(can.rows[0], role).toEqual({ u: false, s: false });
    }
    await db.admin(`REVOKE ALL ON audit.audit_event, audit.security_event FROM ${probe}`);
    await db.admin(`REVOKE ALL ON SCHEMA audit, exec FROM ${probe}`);
    await db.admin(`REVOKE CONNECT ON DATABASE ${db.database} FROM ${probe}`);
    await db.admin(`DROP ROLE ${probe}`);
  });

  it('verifies a clean chain, records a checkpoint, and detects tampering outside the application', async () => {
    const ws = await createWorkspace(h.app, 'Chain probe');
    for (let i = 0; i < 6; i++)
      await write(ws.id, 'record.updated', [change.plain('title', `v${i}`, `v${i + 1}`)]);
    const verify = () =>
      h.worker.withWorkspace(ws.id, { module: 'test' }, (tx) =>
        verifyAuditChain(tx as WorkspaceTransaction),
      );
    const clean = await verify();
    expect(clean).toMatchObject({ checked: 6, headSeq: '6', problems: [], checkpointed: true });
    // Simulated attacker edits bypassing triggers (superuser + replica mode): each is detected.
    const tamper = async (statement: string) => {
      await db.admin(`BEGIN; SET LOCAL session_replication_role = replica; ${statement}; COMMIT;`);
    };
    await tamper(
      `UPDATE audit.audit_event SET changes = jsonb_set(changes, '{0,new}', '"forged"') WHERE workspace_id = '${ws.id}' AND chain_seq = 2`,
    );
    await tamper(
      `UPDATE audit.audit_event SET action = 'record.forged' WHERE workspace_id = '${ws.id}' AND chain_seq = 3`,
    );
    await tamper(`DELETE FROM audit.audit_event WHERE workspace_id = '${ws.id}' AND chain_seq = 4`);
    await tamper(
      `UPDATE audit.audit_event SET changes = jsonb_build_array((changes->0) - 'old' - 'new' || '{"redacted": true, "reason": "purge"}') WHERE workspace_id = '${ws.id}' AND chain_seq = 5`,
    );
    const found = await verify();
    const kinds = found.problems.map((p) => `${p.kind}@${p.seq}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'value_digest_mismatch@2',
        'hash_mismatch@3',
        'gap@4',
        'broken_link@5',
        'unrecorded_redaction@5',
      ]),
    );
    expect(found.checkpointed).toBe(false);
    // Tail truncation below the recorded checkpoint is detected.
    await tamper(`DELETE FROM audit.audit_event WHERE workspace_id = '${ws.id}' AND chain_seq = 6`);
    expect((await verify()).problems.map((p) => p.kind)).toContain('truncated_below_checkpoint');
  });

  it('concurrent writers in one workspace produce one continuous chain', async () => {
    const ws = await createWorkspace(h.app, 'Concurrent chain');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        write(ws.id, 'record.updated', [change.plain('title', `${i}`, `${i + 1}`)]),
      ),
    );
    const seqs = await db.admin(
      `SELECT chain_seq::int AS s FROM audit.audit_event WHERE workspace_id = $1 ORDER BY 1`,
      [ws.id],
    );
    expect(seqs.rows.map((r) => r.s)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const v = await h.worker.withWorkspace(ws.id, { module: 'test' }, (tx) =>
      verifyAuditChain(tx as WorkspaceTransaction),
    );
    expect(v.problems).toEqual([]);
    // A forked link is refused by the database even if a writer computes it wrongly.
    await expect(
      db.admin(
        `INSERT INTO audit.audit_event (id, occurred_at, workspace_id, action, actor_type, actor_id, target_type,
           correlation_id, source_kind, chain_seq, prev_hash, hash)
         VALUES ($1, now(), $2, 'record.updated', 'human', $3, 'task', $4, 'ui', 5, $5, $5)`,
        [newUuidV7(), ws.id, principal.id, newUuidV7(), Buffer.alloc(32)],
      ),
    ).rejects.toThrow(/chain continuity|audit_event_chain/);
  });

  it('measures chain-lock contention: a delayed holder blocks writers, which recover in order once it commits', async () => {
    const ws = await createWorkspace(h.app, 'Contention');
    const slow = new AuditWriter({
      module: 'contention',
      logger: h.logger,
      metrics: h.telemetry.metrics,
      lockWaitWarnMs: 100,
    });
    let acquired!: () => void;
    const holding = new Promise<void>((r) => (acquired = r));
    const HOLD_MS = 400;
    const holder = h.app.withWorkspace(ws.id, { module: 'test' }, async (tx) => {
      await slow.write(tx, cmdFor(ws.id), {
        action: 'record.updated',
        target: { recordId: null, type: 'task', publicId: null },
        changes: [change.plain('title', 'secret holder title', 'x')],
      });
      acquired();
      await new Promise((r) => setTimeout(r, HOLD_MS)); // a (bad) long transaction holding the chain lock
    });
    await holding;
    const started = Date.now();
    const finished: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        h.app
          .withWorkspace(ws.id, { module: 'test' }, (tx) =>
            slow.write(tx, cmdFor(ws.id), {
              action: 'record.updated',
              target: { recordId: null, type: 'task', publicId: null },
              changes: [change.plain('title', `${i}`, `${i + 1}`)],
            }),
          )
          .then(() => finished.push(Date.now() - started)),
      ),
    );
    await holder;
    // Every waiter was held back by the holder, and all recovered promptly after its commit.
    expect(Math.min(...finished)).toBeGreaterThanOrEqual(HOLD_MS - 100);
    expect(Math.max(...finished)).toBeLessThan(HOLD_MS + 3_000);
    const seqs = await db.admin(
      `SELECT chain_seq::int AS s FROM audit.audit_event WHERE workspace_id = $1 ORDER BY 1`,
      [ws.id],
    );
    expect(seqs.rows.map((r) => r.s)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      (
        await h.worker.withWorkspace(ws.id, { module: 'test' }, (tx) =>
          verifyAuditChain(tx as WorkspaceTransaction),
        )
      ).problems,
    ).toEqual([]);
    // Lock wait is measured separately from total write time, with bounded labels only.
    const { resourceMetrics } = await h.telemetry.metricReader!.collect();
    const metrics = resourceMetrics.scopeMetrics.flatMap((sm) => sm.metrics);
    const points = (name: string) =>
      metrics
        .filter((m) => m.descriptor.name === name)
        .flatMap(
          (m) => m.dataPoints as Array<{ attributes: Record<string, unknown>; value: unknown }>,
        )
        .filter((p) => p.attributes.module === 'contention');
    const wait = points('audit.chain.lock_wait')[0]!.value as { count: number; max: number };
    expect(wait.count).toBe(6);
    expect(wait.max).toBeGreaterThanOrEqual(HOLD_MS - 100);
    const total = points('audit.write.duration').find((p) => p.attributes.outcome === 'ok')!
      .value as { count: number };
    expect(total.count).toBe(6);
    expect(points('audit.chain.lock_wait_exceeded')[0]!.value).toBe(5);
    for (const p of [
      ...points('audit.chain.lock_wait'),
      ...points('audit.chain.lock_wait_exceeded'),
    ])
      expect(Object.keys(p.attributes)).toEqual(['module']);
    // The warning is content-free.
    const warnings = h.sink.lines.filter((l) => l.includes('"audit.chain_lock_wait_high"'));
    expect(warnings).toHaveLength(5);
    expect(warnings.join('\n').includes('secret holder title')).toBe(false);
  });

  it('isolates tenants (RLS) and keeps account and workspace security events in separate contexts', async () => {
    await write(alpha.id);
    const seen = await h.worker.withWorkspace(beta.id, { module: 'test', readOnly: true }, (tx) =>
      tx.db.selectFrom('audit.audit_event').select('workspace_id').execute(),
    );
    expect(new Set(seen.map((r) => r.workspace_id))).toEqual(new Set([beta.id]));
    // Unset context: zero rows and writes fail (fail closed).
    const c = new pg.Client({ connectionString: db.app });
    await c.connect();
    try {
      for (const t of [
        'audit.audit_event',
        'audit.security_event',
        'audit.audit_redaction',
        'audit.activity_item',
      ])
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      await expect(
        c.query(
          `INSERT INTO audit.security_event (id, category, action, outcome, actor_type, correlation_id)
                 VALUES ($1, 'session', 'session.created', 'success', 'human', $2)`,
          [newUuidV7(), newUuidV7()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
    // A pooled connection reused after a workspace transaction carries no context forward.
    const reused = new pg.Client({ connectionString: db.app });
    await reused.connect();
    try {
      await reused.query('BEGIN');
      await reused.query("SELECT set_config('app.workspace_id', $1, true)", [alpha.id]);
      expect(
        (await reused.query('SELECT count(*)::int AS n FROM audit.audit_event')).rows[0].n,
      ).toBeGreaterThan(0);
      await reused.query('COMMIT');
      for (const t of ['audit.audit_event', 'audit.security_event', 'core.record'])
        expect((await reused.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      // A wrong (unknown) workspace id sees nothing either.
      await reused.query('BEGIN');
      await reused.query("SELECT set_config('app.workspace_id', $1, true)", [newUuidV7()]);
      expect(
        (await reused.query('SELECT count(*)::int AS n FROM audit.audit_event')).rows[0].n,
      ).toBe(0);
      await reused.query('COMMIT');
    } finally {
      await reused.end();
    }
    const sink = new AuditSecurityEventSink(h.telemetry.metrics);
    const event = (action: string) => ({
      category: 'session' as const,
      action,
      outcome: 'success' as const,
      actor: { type: 'human' as const, id: principal.id },
      correlationId: newTraceId(),
      network: { prefix: '198.51.100.0/24' },
    });
    await h.platform.withPlatform({ module: 'test' }, (tx) =>
      sink.record(tx, event('session.account_level')),
    );
    await h.app.withWorkspace(alpha.id, { module: 'test' }, (tx) =>
      sink.record(tx, event('session.tenant_level')),
    );
    const platformView = await h.platform.withPlatform({ module: 'test', readOnly: true }, (tx) =>
      tx.db.selectFrom('audit.security_event').select(['action', 'workspace_id']).execute(),
    );
    expect(platformView.map((r) => r.action)).toEqual(['session.account_level']);
    const tenantView = await h.app.withWorkspace(
      alpha.id,
      { module: 'test', readOnly: true },
      (tx) => tx.db.selectFrom('audit.security_event').select(['action']).execute(),
    );
    expect(tenantView.map((r) => r.action)).toEqual(['session.tenant_level']);
    expect(
      await h.app.withWorkspace(beta.id, { module: 'test', readOnly: true }, (tx) =>
        tx.db.selectFrom('audit.security_event').select(['action']).execute(),
      ),
    ).toEqual([]);
    // Cross-context writes are refused by RLS.
    await expect(
      h.platform.withPlatform({ module: 'test' }, (tx) =>
        sql`INSERT INTO audit.security_event (id, category, action, outcome, actor_type, correlation_id, workspace_id)
            VALUES (${newUuidV7()}, 'session', 'session.forged', 'success', 'human', ${newUuidV7()}, ${alpha.id})`.execute(
          tx.db,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // Unminimized network context is refused before it reaches storage.
    await expect(
      h.platform.withPlatform({ module: 'test' }, (tx) =>
        sink.record(tx, { ...event('session.created'), network: { prefix: '198.51.100.7' } }),
      ),
    ).rejects.toThrow(/minimized/);
  });

  it('projects activity with display-safe values only and rebuilds idempotently', async () => {
    const target = newUuidV7();
    await h.app.withWorkspace(alpha.id, { module: 'test' }, (tx) =>
      writer.write(tx, cmdFor(alpha.id), {
        action: 'record.updated',
        target: { recordId: target, type: 'task', publicId: null },
        changes: [
          change.plain('title', 'Old', 'New title'),
          change.personal('owner_email', null, 'p@example.test'),
          change.secret('api_key'),
        ],
      }),
    );
    const n = await h.worker.withWorkspace(alpha.id, { module: 'test' }, (tx) =>
      projectActivity(tx, target),
    );
    expect(n).toBe(1);
    expect(
      await h.worker.withWorkspace(alpha.id, { module: 'test' }, (tx) =>
        projectActivity(tx, target),
      ),
    ).toBe(0);
    const item = await db.admin(
      `SELECT summary_key, display_values FROM audit.activity_item WHERE target_record_id = $1`,
      [target],
    );
    expect(item.rows[0]).toEqual({
      summary_key: 'activity.record.updated',
      display_values: { title: 'New title' },
    });
    // The app identity can read but never write the projection.
    await expect(
      h.app.withWorkspace(alpha.id, { module: 'test' }, (tx) =>
        tx.db.deleteFrom('audit.activity_item').execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('only the worker may call the guarded redaction procedure, and only under a running purge', async () => {
    const op = newUuidV7();
    await expect(
      h.app.withWorkspace(alpha.id, { module: 'test' }, (tx) =>
        sql`SELECT audit.redact_purged_values(${op}::uuid, ${newUuidV7()}::uuid, 'system', NULL, ${newUuidV7()}::uuid)`.execute(
          tx.db,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      h.worker.withWorkspace(alpha.id, { module: 'test' }, (tx) =>
        sql`SELECT audit.redact_purged_values(${op}::uuid, ${newUuidV7()}::uuid, 'system', NULL, ${newUuidV7()}::uuid)`.execute(
          tx.db,
        ),
      ),
    ).rejects.toThrow(/redaction operation is not set/);
    await expect(
      h.worker.withWorkspace(alpha.id, { module: 'test' }, async (tx) => {
        await sql`SELECT set_config('app.redaction_operation_id', ${op}, true)`.execute(tx.db);
        await sql`SELECT audit.redact_purged_values(${op}::uuid, ${newUuidV7()}::uuid, 'system', NULL, ${newUuidV7()}::uuid)`.execute(
          tx.db,
        );
      }),
    ).rejects.toThrow(/running purge operation/);
  });
});
