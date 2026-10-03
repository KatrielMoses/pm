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

    expect(await migrator(db).down(11)).toEqual([12]);
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

    expect((await migrator(db).up()).applied).toEqual([12]);
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
