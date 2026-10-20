import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { loadMigrations, MIGRATIONS_DIR, Migrator, TABLE_COLUMNS, verifyHistory } from '@pm/db';
import {
  emptyDatabase as createEmptyTestDatabase,
  migratedDatabase as createTestDatabase,
  type DbTestDatabase as TestDatabase,
} from './databases.ts';

const migrator = (db: TestDatabase, dir?: string, environment = 'test') =>
  new Migrator({ connectionString: db.migrator, environment, ...(dir ? { dir } : {}) });

async function catalogFingerprint(db: TestDatabase): Promise<string> {
  const cols = await db.admin(`
    SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema IN ('exec', 'tenancy', 'access', 'ops', 'exec_dispatch', 'identity')
    ORDER BY 1, 2, 3`);
  const cons = await db.admin(`
    SELECT n.nspname, c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname IN ('exec', 'tenancy', 'ops', 'identity') ORDER BY 1, 2`);
  const pol = await db.admin(
    `SELECT schemaname, tablename, policyname, roles::text, qual, with_check FROM pg_policies ORDER BY 1, 2, 3`,
  );
  return JSON.stringify([cols.rows, cons.rows, pol.rows]);
}

describe('migrations from an empty database', () => {
  let first: TestDatabase;
  let second: TestDatabase;

  beforeAll(async () => {
    first = await createEmptyTestDatabase();
    second = await createEmptyTestDatabase();
  });
  afterAll(async () => {
    await first.drop();
    await second.drop();
  });

  it('applies every migration as the migrator identity and binds the environment', async () => {
    const result = await migrator(first).up();
    expect(result.applied).toEqual(loadMigrations().map((m) => m.version));
    const status = await migrator(first).status();
    expect(status.pending).toHaveLength(0);
    expect(status.report.problems).toEqual([]);
    const env = await first.admin('SELECT environment FROM ops.environment_binding');
    expect(env.rows).toEqual([{ environment: 'test' }]);
    const owner =
      await first.admin(`SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('exec', 'tenancy', 'ops') AND c.relkind = 'r'`);
    expect(owner.rows).toEqual([{ owner: 'pm_owner' }]);
  });

  it('is reproducible: two empty databases converge on identical history and catalog', async () => {
    await migrator(second).up();
    const h1 = await first.admin(
      'SELECT version, name, checksum, down_checksum, chain_hash FROM ops.schema_migration ORDER BY 1',
    );
    const h2 = await second.admin(
      'SELECT version, name, checksum, down_checksum, chain_hash FROM ops.schema_migration ORDER BY 1',
    );
    expect(h2.rows).toEqual(h1.rows);
    expect(await catalogFingerprint(second)).toEqual(await catalogFingerprint(first));
  });

  it('matches the typed column inventory used by application queries (schema drift check)', async () => {
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      const [schema, name] = table.split('.');
      const res = await first.admin(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        [schema, name],
      );
      expect(res.rows.map((r) => r.column_name).sort(), table).toEqual([...columns].sort());
    }
  });

  it('reverses completely with down migrations and re-applies cleanly', async () => {
    const reverted = await migrator(second).down(0);
    expect(reverted).toEqual(
      loadMigrations()
        .map((m) => m.version)
        .reverse(),
    );
    const left = await second.admin(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema IN ('exec', 'tenancy')`,
    );
    expect(left.rows[0].n).toBe(0);
    await second.admin('DELETE FROM ops.schema_migration'); // already empty; asserts table survives
    await migrator(second).up();
    expect(await catalogFingerprint(second)).toEqual(await catalogFingerprint(first));
  });

  it('upgrades through every accepted boundary (0009–0052) the 7A boundaries 0053–0054, the 7B boundary 0055, the 7D boundary 0056, the 7C boundary 0057, the 7E boundary 0058, the 7F boundary 0059, the Phase 7 integration boundary 0060, the effect-recovery boundary 0061, the 8A automation boundary 0062, and the 8A review 01 checkpoint boundary 0063 to the candidate and reverses each boundary step', async () => {
    // Accepted subphase boundaries: 1A 0009, 1B 0012, 1F 0016, 1C 0018, 1D 0019, 1E 0020; 2A adds
    // 0021 (work) and 0022 (relations, templates, recurrence); 2B–2E add 0023–0030; 3A adds 0031
    // (saved views, defaults, and pin writes); 3D adds 0032 (time entries, timesheets, approvals,
    // and period locks); 3B adds 0033 (core view layouts); 3C adds 0034 (Today, work blocks,
    // block series, and daily records); 3E adds 0035 (capacity); 4A adds 0036 (comments, mentions,
    // followers, reviews, and assignment history); 4B adds 0037 (notifications); 4C adds 0038 (documents);
    // 4E adds 0039 (files, versions, upload sessions, deliverables, and storage usage); 4D adds 0040
    // (live edit drafts, sessions, and the ordered operation log); 5A adds 0041 (the search
    // projection, its indexing queue, recent searches, and the source triggers); 5B adds 0042 (goals,
    // key results, links, check-ins, derived state, and portfolios); 5C adds 0043 (the task status ledger
    // and its reconciliation state); 5D adds 0044 (dashboards, saved reports, report shares,
    // recipients, and scheduled runs); 6A adds 0045 (connections, checkpoints, identities, sync
    // runs, deliveries, and conflicts); 6B adds 0046 (API tokens and webhooks); 6C adds 0047
    // (calendar_event and connection_mapping); 6E adds 0048 (MCP clients, consent, and tokens) and
    // 0049 (MCP invocation provenance); 6D adds 0050 (CSV portability); the Phase 6 integration
    // review adds 0051 (connected calendars, provider series, exceptions, and block links) and its
    // corrective review 0052 (webhook pause, delivery sources, replay cycles, skipped deliveries);
    // 7A adds 0053 (AI policy, actions, dispatches, outputs, spend limits, balances, reservations,
    // and usage events) and its corrective review 0054 (attempt snapshots, breach and clipping
    // facts, workspace suspension, and checkpoint content removal); 7B adds 0055 (the grounded-answer
    // purpose, retrieval scope, context manifest entries, and validated answers); 7D adds 0056
    // (the change-proposal purpose, proposals, changes, history, approvals, and applications); 7C
    // adds 0057 (the analysis purpose, action keys and input digests, goal and meeting sources,
    // three proposal operations, and assumptions); 7E adds 0058 (briefing schedules, briefings,
    // statements, corrections and their history, and the briefing discovery function); 7F adds 0059
    // (planner proposals and planning operations, plan evidence, voice captures, the transcription
    // purpose, and the voice cleanup and plan retention discovery functions); the Phase 7
    // integration review adds 0060 (a saved recording may outlive its purged Inbox item); P8-W0
    // adds 0061 (effect claims, typed not-sent proof, unknown reasons, late evidence); 8A adds 0062
    // (automations, immutable revisions, runs and step runs, standing approvals, trigger schedules,
    // usage periods, the automation notice type, and the automation AI caller); 8A corrective
    // review 01 adds 0063 (automation checkpoints keep references only; data, no catalog change).
    const boundaries = [
      9, 12, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
      39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61,
      62, 63,
    ];
    // Functions and triggers are compared from the last Phase 6 boundary on (the Phase 7 steps).
    // Earlier accepted steps are compared on tables, constraints, grants, and policies only: the
    // 0010–0012 rollback does not restore exec_dispatch.claim_jobs byte for byte (recorded in the
    // Phase 7 exit report; accepted migrations are not edited).
    const DEEP_FROM = 52;
    const full = async (db: TestDatabase, deep = true) => {
      const objects = await db.admin(`
        SELECT n.nspname, c.relname, c.relkind::text, c.relrowsecurity, c.relforcerowsecurity
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         ORDER BY 1, 2`);
      const cons = await db.admin(`
        SELECT n.nspname, c.conname, pg_get_constraintdef(c.oid) AS def
          FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2`);
      const grants = await db.admin(`
        SELECT table_schema, table_name, grantee, privilege_type FROM information_schema.role_table_grants
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2, 3, 4`);
      const pol = await db.admin(
        `SELECT schemaname, tablename, policyname, roles::text, qual, with_check FROM pg_policies ORDER BY 1, 2, 3`,
      );
      // Phase 7 integration: functions (body, security, owner, and execute grants) and triggers are
      // part of each boundary's exact catalog, not only tables, constraints, grants, and policies.
      const fns = await db.admin(`
        SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
               md5(pg_get_functiondef(p.oid)) AS def, p.prosecdef, pg_get_userbyid(p.proowner) AS owner,
               coalesce(p.proacl::text, '') AS acl
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p')
         ORDER BY 1, 2, 3`);
      const trg = await db.admin(`
        SELECT n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) AS def, t.tgenabled::text
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal ORDER BY 1, 2, 3`);
      return JSON.stringify(
        deep
          ? [objects.rows, cons.rows, grants.rows, pol.rows, fns.rows, trg.rows]
          : [objects.rows, cons.rows, grants.rows, pol.rows],
      );
    };
    const stepped = await createEmptyTestDatabase();
    const reference = await createEmptyTestDatabase();
    try {
      await migrator(reference).up();
      const at = new Map<number, string>();
      for (const to of boundaries) {
        await migrator(stepped).up({ to });
        expect((await migrator(stepped).status()).report.problems, `at ${to}`).toEqual([]);
        at.set(to, await full(stepped, to >= DEEP_FROM));
      }
      // Stepping through the boundaries reaches exactly the one-shot candidate catalog.
      expect(at.get(63)).toEqual(await full(reference));
      // Each subphase's step reverses to the prior boundary's exact catalog and re-applies to its
      // own, walking down from the candidate.
      for (let i = boundaries.length - 1; i > 0; i--) {
        const [lower, upper] = [boundaries[i - 1]!, boundaries[i]!];
        await migrator(stepped).down(lower);
        expect(await full(stepped, lower >= DEEP_FROM), `down to ${lower}`).toEqual(at.get(lower));
        await migrator(stepped).up({ to: upper });
        expect(await full(stepped, upper >= DEEP_FROM), `up to ${upper}`).toEqual(at.get(upper));
        await migrator(stepped).down(lower);
      }
      await migrator(stepped).up();
      expect(await full(stepped)).toEqual(await full(reference));
    } finally {
      await stepped.drop();
      await reference.drop();
    }
  });

  it('refuses identities other than migrator', async () => {
    const bad = new Migrator({ connectionString: first.app, environment: 'test' });
    await expect(bad.up()).rejects.toThrow(/migrator role/);
  });

  it('refuses to migrate a database bound to another environment', async () => {
    await expect(migrator(first, undefined, 'staging').up()).rejects.toThrow(
      /bound to another environment/,
    );
  });
});

describe('migration 0012: stored locked step-up state', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  const hash = (n: number) => `decode(repeat('${n.toString(16).padStart(2, '0')}', 32), 'hex')`;
  const stateDef = async () =>
    (
      await db.admin(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'step_up_challenge_state_known'`,
      )
    ).rows[0].def as string;

  async function seedChallenge(): Promise<string> {
    const account = newUuidV7();
    const session = newUuidV7();
    const challenge = newPublicId('stp');
    await db.admin(
      `INSERT INTO identity.account (id, public_id, primary_email, email_key, display_name, timezone, locale, terms_version, privacy_version, legal_acknowledged_at)
       VALUES ($1, $2, 'mig@example.test', 'mig@example.test', 'Migration', 'UTC', 'en', 't1', 'p1', now())`,
      [account, newPublicId('acct')],
    );
    await db.admin(
      `INSERT INTO identity.session (id, public_id, account_id, token_hash, idle_expires_at, absolute_expires_at, auth_methods, assurance)
       VALUES ($1, $2, $3, ${hash(1)}, now() + interval '1 hour', now() + interval '1 day', ARRAY['password'], 'single_factor')`,
      [session, newPublicId('ses'), account],
    );
    await db.admin(
      `INSERT INTO identity.step_up_challenge (id, public_id, account_id, session_id, action_key, methods, challenge_nonce_hash, expires_at)
       VALUES ($1, $2, $3, $4, 'account.mfa_disable', ARRAY['password'], ${hash(2)}, now() + interval '5 minutes')`,
      [newUuidV7(), challenge, account, session],
    );
    return challenge;
  }

  it('stores locked consistently, reverses locked rows to expired, and re-applies with a verified checksum', async () => {
    const twelve = loadMigrations().find((m) => m.version === 12)!;
    expect(twelve.name).toBe('step_up_locked');
    expect(await stateDef()).toContain("'locked'");
    const id = await seedChallenge();
    const set = (sql: string) =>
      db.admin(`UPDATE identity.step_up_challenge SET ${sql} WHERE public_id = $1`, [id]);
    await expect(set(`state = 'locked'`)).rejects.toThrow(/step_up_challenge_locked_state/);
    await expect(set(`locked_at = now()`)).rejects.toThrow(/step_up_challenge_locked_state/);
    await expect(
      set(
        `state = 'locked', locked_at = now(), token_hash = ${hash(3)}, verified_at = now(), token_expires_at = now()`,
      ),
    ).rejects.toThrow(/step_up_challenge_(locked_tokenless|verified_state)/);
    await set(`state = 'locked', locked_at = now(), failed_attempts = 5`);

    const above11 = loadMigrations()
      .map((m) => m.version)
      .filter((v) => v > 11);
    expect(await migrator(db).down(11)).toEqual([...above11].reverse());
    const reverted = await db.admin(
      `SELECT state FROM identity.step_up_challenge WHERE public_id = $1`,
      [id],
    );
    expect(reverted.rows).toEqual([{ state: 'expired' }]);
    expect(await stateDef()).not.toContain("'locked'");
    const col = await db.admin(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = 'step_up_challenge' AND column_name = 'locked_at'`,
    );
    expect(col.rows).toHaveLength(0);
    await expect(set(`state = 'locked'`)).rejects.toThrow(/step_up_challenge_state_known/);

    expect((await migrator(db).up()).applied).toEqual(above11);
    expect(await stateDef()).toContain("'locked'");
    const history = await db.admin(
      'SELECT checksum, down_checksum FROM ops.schema_migration WHERE version = 12',
    );
    expect(history.rows).toEqual([
      { checksum: twelve.checksum, down_checksum: twelve.downChecksum },
    ]);
    expect((await migrator(db).verify()).problems).toEqual([]);
  });
});

describe('tamper evidence', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('detects a modified migration file and refuses to continue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-mig-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const file = join(dir, '0004_exec_operation_attempt.up.sql');
    writeFileSync(file, readFileSync(file, 'utf8') + '\n-- silent edit\n');
    const report = await migrator(db, dir).verify();
    expect(report.problems).toContain(
      'migration 4_exec_operation_attempt was modified after it was applied',
    );
    await expect(migrator(db, dir).up()).rejects.toThrow(/verification failed/);
  });

  it('detects edited history rows through the hash chain', async () => {
    await db.admin("UPDATE ops.schema_migration SET name = 'renamed' WHERE version = 2");
    const report = await migrator(db).verify();
    expect(report.problems.some((p) => p.includes('renamed') || p.includes('chain broken'))).toBe(
      true,
    );
    await db.admin("UPDATE ops.schema_migration SET name = 'ops_runtime' WHERE version = 2");
    expect((await migrator(db).verify()).problems).toEqual([]);
  });

  it('verifyHistory flags deleted history rows (gaps)', () => {
    const files = loadMigrations();
    const report = verifyHistory(files, [
      {
        version: 2,
        name: files[1]!.name,
        phase: 'expand',
        checksum: files[1]!.checksum,
        down_checksum: files[1]!.downChecksum,
        chain_hash: 'x'.repeat(64),
      },
    ]);
    expect(report.problems.length).toBeGreaterThan(0);
  });
});

describe('applied-migration boundary: the 0041 backfill correction (Phase 5C review 01)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createEmptyTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  // The repository has no accepted deployment, so 0041 was corrected in place (an applied
  // migration is otherwise immutable). A database that already applied the earlier 0041 is
  // refused, not silently continued: it must be rebuilt (or, where it holds no data worth keeping,
  // rolled down with the migration files it was built from and migrated again), after which the
  // corrected 0041 queues every existing record. This test is that boundary.
  it('refuses to continue a database that applied the uncorrected 0041, and rebuilds from its own files', async () => {
    const old = mkdtempSync(join(tmpdir(), 'pm-mig-old-'));
    cpSync(MIGRATIONS_DIR, old, { recursive: true });
    writeFileSync(
      join(old, '0041_permission_aware_search.up.sql'),
      readFileSync(
        new URL(
          '../fixtures/0041_permission_aware_search.pre-backfill-fix.up.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await migrator(db, old).up({ to: 41 });
    const report = await migrator(db).verify();
    expect(report.problems).toContain(
      'migration 41_permission_aware_search was modified after it was applied',
    );
    await expect(migrator(db).up()).rejects.toThrow(/verification failed/);
    // Rebuild: roll back with the files the database was built from, then migrate with the corrected ones.
    await migrator(db, old).down(0);
    const rebuilt = await migrator(db).up();
    expect(rebuilt.applied.length).toBe(loadMigrations().length);
    expect((await migrator(db).verify()).problems).toEqual([]);
  });
});

describe('applied-migration boundary: 0054 removes AI content from execution checkpoints (7A corrective review 01)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createEmptyTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  const CTX_COLS = `authenticated_principal_type, authenticated_principal_id, effective_principal_type, effective_principal_id, delegation_chain, workspace_epoch_at_enqueue, principal_epoch_at_enqueue, data_class_limit, correlation_id`;
  const ctx = () =>
    `'member', '${newUuidV7()}', 'member', '${newUuidV7()}', '[{"type":"member","id":"00000000-0000-7000-8000-000000000000"}]'::jsonb, 0, 0, 'C2', '${newUuidV7()}'`;
  const workspace = async () => {
    const id = newUuidV7();
    await db.admin(
      `INSERT INTO tenancy.workspace (id, public_id, name, timezone, locale, currency, week_start, created_by_actor_type, updated_by_actor_type)
       VALUES ($1, $2, 'Synthetic Workspace', 'UTC', 'en', 'USD', 1, 'system', 'system')`,
      [id, newPublicId('ws')],
    );
    return id;
  };
  const job = async (ws: string, kind: string, checkpoint: unknown) => {
    const id = newUuidV7();
    await db.admin(
      `INSERT INTO exec.job (id, workspace_id, queue, kind, max_attempts, timeout_seconds, checkpoint, ${CTX_COLS})
       VALUES ($1, $2, 'default', $3, 1, 5, $4::jsonb, ${ctx()})`,
      [id, ws, kind, JSON.stringify(checkpoint)],
    );
    return id;
  };
  const scrubbed: string[] = [];
  const operation = async (ws: string) => {
    const id = newUuidV7();
    await db.admin(
      `INSERT INTO exec.operation (id, workspace_id, public_id, kind, initiated_by_actor_type, ${CTX_COLS})
       VALUES ($1, $2, $3, 'ai_action', 'system', ${ctx()})`,
      [id, ws, newPublicId('op')],
    );
    return id;
  };
  const checkpoint = async (id: string) =>
    (await db.admin(`SELECT checkpoint FROM exec.job WHERE id = $1`, [id])).rows[0].checkpoint;
  // The format 0053-era workers wrote: the rendered prompt, source content, and key reference.
  const OLD = {
    'ai.prepare.1': {
      outcome: 'dispatch',
      dispatchId: 'd1',
      system: 'Brand instructions: MIGMARK-brand',
      user: 'MIGMARK-prompt MIGMARK-context',
      keyRef: 'platform:old',
    },
    'ai.prepare.2': { outcome: 'reconcile' },
    'other.step': { user: 'not an AI preparation step', n: 1 },
  };

  it('scrubs every old-format AI checkpoint in every workspace on upgrade, keeps other steps and jobs, and restores forced row-level security', async () => {
    await migrator(db).up({ to: 53 });
    const [w1, w2] = [await workspace(), await workspace()];
    const a = await job(w1, 'ai.action.dispatch', OLD);
    const b = await job(w2, 'ai.action.dispatch', OLD);
    const other = await job(w1, 'test.noop', OLD);
    await migrator(db).up({ to: 54 });
    expect((await migrator(db).status()).report.problems).toEqual([]);
    for (const id of [a, b])
      expect(await checkpoint(id)).toEqual({
        'ai.prepare.1': { outcome: 'dispatch', dispatchId: 'd1' },
        'ai.prepare.2': { outcome: 'reconcile' },
        'other.step': { user: 'not an AI preparation step', n: 1 },
      });
    // Jobs of other kinds are not touched.
    expect(await checkpoint(other)).toEqual(OLD);
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM exec.job WHERE checkpoint::text LIKE '%MIGMARK%' AND kind = 'ai.action.dispatch'`,
        )
      ).rows[0].n,
    ).toBe(0);
    // Row-level security on exec.job is forced again after the one-statement cleanup.
    expect(
      (
        await db.admin(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'exec.job'::regclass`,
        )
      ).rows,
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    scrubbed.push(a, b);
  });

  it('0063 removes payload copies from automation checkpoints in every workspace, keeps the step and its effect key, leaves effects and other jobs untouched, and restores forced row-level security (8A review 01 R2)', async () => {
    await migrator(db).up({ to: 62 });
    const [w1, w2] = [await workspace(), await workspace()];
    // The format the 8A candidate wrote before review 01: the prepared payload in the checkpoint.
    const OLD8A = {
      u0: { advance: { kind: 'continue' } },
      u1: {
        advance: {
          kind: 'effect',
          node: 'send',
          logicalKey: 'k'.repeat(64),
          subscriptionId: newUuidV7(),
          fingerprint: 'f'.repeat(64),
          envelope: { data: { fields: { due_date: 'MIGMARK-2041-01-01' } } },
        },
      },
      u2: { advance: { kind: 'done', result: { state: 'succeeded' } } },
    };
    const a = await job(w1, 'automation.run', OLD8A);
    const b = await job(w2, 'automation.run', OLD8A);
    const other = await job(w1, 'test.noop', OLD8A);
    await migrator(db).up({ to: 63 });
    expect((await migrator(db).status()).report.problems).toEqual([]);
    for (const id of [a, b])
      expect(await checkpoint(id)).toEqual({
        u0: { advance: { kind: 'continue' } },
        u1: { advance: { kind: 'effect', node: 'send', logicalKey: 'k'.repeat(64) } },
        u2: { advance: { kind: 'done', result: { state: 'succeeded' } } },
      });
    expect(await checkpoint(other)).toEqual(OLD8A);
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM exec.job WHERE checkpoint::text LIKE '%MIGMARK%' AND kind = 'automation.run'`,
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await db.admin(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'exec.job'::regclass`,
        )
      ).rows,
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    // Rolling back to 0062 changes no catalog object and puts no payload back.
    await migrator(db).down(62);
    expect(await checkpoint(a)).toEqual({
      u0: { advance: { kind: 'continue' } },
      u1: { advance: { kind: 'effect', node: 'send', logicalKey: 'k'.repeat(64) } },
      u2: { advance: { kind: 'done', result: { state: 'succeeded' } } },
    });
    await migrator(db).up();
  });

  it('scrub_dispatch_checkpoints reaches only the current workspace, for API and worker roles, and is not public', async () => {
    const [w1, w2] = [await workspace(), await workspace()];
    const ops: string[] = [];
    const ids: string[] = [];
    for (const ws of [w1, w2]) {
      const op = await operation(ws);
      const id = await job(ws, 'ai.action.dispatch', OLD);
      await db.admin(`UPDATE exec.job SET operation_id = $2 WHERE id = $1`, [id, op]);
      ops.push(op);
      ids.push(id);
    }
    const { Client } = (await import('pg')).default;
    const app = new Client({ connectionString: db.app });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.workspace_id', $1, true)`, [w1]);
      const r = await app.query(`SELECT ai.scrub_dispatch_checkpoints($1::uuid[]) AS n`, [ops]);
      await app.query('COMMIT');
      expect(r.rows[0].n).toBe(1);
      // Without a workspace context nothing is reachable (fail closed).
      const none = await app.query(`SELECT ai.scrub_dispatch_checkpoints($1::uuid[]) AS n`, [ops]);
      expect(none.rows[0].n).toBe(0);
    } finally {
      await app.end();
    }
    expect((await checkpoint(ids[0]!))['ai.prepare.1']).toEqual({
      outcome: 'dispatch',
      dispatchId: 'd1',
    });
    expect(await checkpoint(ids[1]!)).toEqual(OLD);
    const grants = await db.admin(
      `SELECT grantee FROM information_schema.routine_privileges
        WHERE routine_schema = 'ai' AND routine_name = 'scrub_dispatch_checkpoints' AND privilege_type = 'EXECUTE'
        ORDER BY 1`,
    );
    expect(grants.rows.map((g) => g.grantee).filter((g) => g !== 'pm_owner')).toEqual([
      'app_rw',
      'app_worker',
    ]);
  });

  it('rolls back to the exact 0053 shape without restoring removed content', async () => {
    const ws = await workspace();
    await migrator(db).down(53);
    const id = await job(ws, 'ai.action.dispatch', {
      'ai.prepare.1': { outcome: 'dispatch', dispatchId: 'd2' },
    });
    const cols = await db.admin(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'ai' AND table_name = 'ai_dispatch'
          AND column_name IN ('price_snapshot', 'capability_snapshot', 'bound_breach', 'clipped_locally', 'failure_detail')`,
    );
    expect(cols.rows).toEqual([]);
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'scrub_dispatch_checkpoints'`,
        )
      ).rows[0].n,
    ).toBe(0);
    // The checkpoints 0054 scrubbed stay scrubbed: rollback never restores removed content.
    expect(scrubbed).toHaveLength(2);
    for (const j of scrubbed) expect(JSON.stringify(await checkpoint(j))).not.toContain('MIGMARK');
    await migrator(db).up();
    for (const j of scrubbed) expect(JSON.stringify(await checkpoint(j))).not.toContain('MIGMARK');
    expect((await migrator(db).verify()).problems).toEqual([]);
    expect(await checkpoint(id)).toEqual({
      'ai.prepare.1': { outcome: 'dispatch', dispatchId: 'd2' },
    });
  });
});

describe('applied-migration boundary: 0061 classifies attempted effects as unknown and refuses an unrepresentable rollback (P8-W0)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createEmptyTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  const CTX_COLS = `authenticated_principal_type, authenticated_principal_id, effective_principal_type, effective_principal_id, delegation_chain, workspace_epoch_at_enqueue, principal_epoch_at_enqueue, data_class_limit, correlation_id`;
  const ctx = () =>
    `'member', '${newUuidV7()}', 'member', '${newUuidV7()}', '[{"type":"member","id":"00000000-0000-7000-8000-000000000000"}]'::jsonb, 0, 0, 'C2', '${newUuidV7()}'`;
  const effects = async () =>
    (
      await db.admin(
        `SELECT effect_key, state::text AS state, attempt_count, uncertainty_reason, version::int AS version
           FROM exec.external_effect ORDER BY effect_key`,
      )
    ).rows;

  it('reclassifies attempted pending and failed rows as unknown without resetting anything; leaves the rest; rollback refuses claims and late evidence, then restores 0060 exactly', async () => {
    await migrator(db).up({ to: 60 });
    const ws = newUuidV7();
    await db.admin(
      `INSERT INTO tenancy.workspace (id, public_id, name, timezone, locale, currency, week_start, created_by_actor_type, updated_by_actor_type)
       VALUES ($1, $2, 'Synthetic Workspace', 'UTC', 'en', 'USD', 1, 'system', 'system')`,
      [ws, newPublicId('ws')],
    );
    const op = newUuidV7();
    await db.admin(
      `INSERT INTO exec.operation (id, workspace_id, public_id, kind, initiated_by_actor_type, ${CTX_COLS})
       VALUES ($1, $2, $3, 'report_run', 'system', ${ctx()})`,
      [op, ws, newPublicId('op')],
    );
    const row = (key: string, cls: string, state: string, attempts: number) =>
      db.admin(
        `INSERT INTO exec.external_effect (id, workspace_id, operation_id, effect_key, destination_class, state, attempt_count, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 3)`,
        [newUuidV7(), ws, op, key, cls, state, attempts],
      );
    await row('a-never', 'unsafe', 'pending', 0);
    await row('b-attempted', 'unsafe', 'pending', 2);
    await row('c-failed-safe', 'naturally_idempotent', 'failed', 1);
    await row('d-sent', 'unsafe', 'sent', 1);
    await row('e-unknown', 'unsafe', 'unknown', 1);
    await migrator(db).up({ to: 61 });
    expect(await effects()).toEqual([
      {
        effect_key: 'a-never',
        state: 'pending',
        attempt_count: 0,
        uncertainty_reason: null,
        version: 3,
      },
      {
        effect_key: 'b-attempted',
        state: 'unknown',
        attempt_count: 2,
        uncertainty_reason: 'legacy_attempted',
        version: 4,
      },
      {
        effect_key: 'c-failed-safe',
        state: 'unknown',
        attempt_count: 1,
        uncertainty_reason: 'legacy_attempted',
        version: 4,
      },
      {
        effect_key: 'd-sent',
        state: 'sent',
        attempt_count: 1,
        uncertainty_reason: null,
        version: 3,
      },
      {
        effect_key: 'e-unknown',
        state: 'unknown',
        attempt_count: 1,
        uncertainty_reason: null,
        version: 3,
      },
    ]);
    const forced = await db.admin(
      `SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'exec.external_effect'::regclass`,
    );
    expect(forced.rows[0].f).toBe(true);
    // An owned claim cannot be represented in 0060: the rollback refuses with counts.
    await db.admin(
      `UPDATE exec.external_effect SET state = 'dispatching', attempt_count = 1, claim_token = $1, claimed_at = now(),
              claim_until = now() + interval '1 minute' WHERE effect_key = 'a-never'`,
      [newUuidV7()],
    );
    await expect(migrator(db).down(60)).rejects.toThrow(
      /1 effect\(s\) are dispatching and 0 carry late evidence/,
    );
    expect((await migrator(db).status()).report.problems).toEqual([]);
    await db.admin(
      `UPDATE exec.external_effect SET state = 'unknown', uncertainty_reason = 'abandoned_claim', claim_token = NULL,
              claim_until = NULL WHERE effect_key = 'a-never'`,
    );
    await db.admin(
      `UPDATE exec.external_effect SET late_outcome = 'sent', late_outcome_at = now() WHERE effect_key = 'd-sent'`,
    );
    await expect(migrator(db).down(60)).rejects.toThrow(
      /0 effect\(s\) are dispatching and 1 carry late evidence/,
    );
    await db.admin(
      `UPDATE exec.external_effect SET late_outcome = NULL, late_outcome_at = NULL WHERE effect_key = 'd-sent'`,
    );
    // Representable rows roll back keeping their states (unknown stays unknown: it still waits).
    await migrator(db).down(60);
    const back = await db.admin(
      `SELECT effect_key, state::text AS state, attempt_count FROM exec.external_effect ORDER BY effect_key`,
    );
    expect(back.rows).toEqual([
      { effect_key: 'a-never', state: 'unknown', attempt_count: 1 },
      { effect_key: 'b-attempted', state: 'unknown', attempt_count: 2 },
      { effect_key: 'c-failed-safe', state: 'unknown', attempt_count: 1 },
      { effect_key: 'd-sent', state: 'sent', attempt_count: 1 },
      { effect_key: 'e-unknown', state: 'unknown', attempt_count: 1 },
    ]);
    const labels = await db.admin(
      `SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS l FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'effect_state'`,
    );
    expect(labels.rows[0].l).toEqual([
      'pending',
      'sent',
      'unknown',
      'confirmed',
      'failed',
      'cancelled',
    ]);
    await migrator(db).up();
    expect((await migrator(db).status()).report.problems).toEqual([]);
  });
});

describe('expand/contract gating', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('holds contract migrations until explicitly requested', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-mig-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const next = String(loadMigrations().length + 1).padStart(4, '0');
    writeFileSync(
      join(dir, `${next}_contract_probe.up.sql`),
      '-- migrate:phase contract\nCOMMENT ON SCHEMA access IS NULL;\n',
    );
    writeFileSync(
      join(dir, `${next}_contract_probe.down.sql`),
      "COMMENT ON SCHEMA access IS 'restored';\n",
    );
    const held = await migrator(db, dir).up();
    expect(held.applied).toEqual([]);
    expect(held.blockedByContract).toBe(Number(next));
    const applied = await migrator(db, dir).up({ includeContract: true });
    expect(applied.applied).toEqual([Number(next)]);
  });
});
