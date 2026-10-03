import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** Reviewed SQL migrations shipped with this package (one ordered stream; 0B §10.1). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const FILE = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;
const GENESIS = '0'.repeat(64);
/** Session advisory lock key that serializes concurrent migrators. */
const LOCK_KEY = 7_340_001;

export type MigrationPhase = 'expand' | 'contract';

export interface MigrationFile {
  version: number;
  name: string;
  phase: MigrationPhase;
  transactional: boolean;
  up: string;
  down: string;
  checksum: string;
  downChecksum: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  phase: MigrationPhase;
  checksum: string;
  down_checksum: string;
  chain_hash: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const normalize = (text: string) => text.replace(/\r\n/g, '\n');

export function chainHash(
  prev: string,
  m: Pick<AppliedMigration, 'version' | 'name' | 'checksum' | 'down_checksum'>,
): string {
  return sha256(`${prev}|${m.version}|${m.name}|${m.checksum}|${m.down_checksum}`);
}

/** Loads and validates the migration files. Every up file needs a down file (reversibility). */
export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const byVersion = new Map<number, { name: string; up?: string; down?: string }>();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const m = FILE.exec(file);
    if (!m) throw new MigrationError(`unexpected migration file name: ${file}`);
    const version = Number(m[1]);
    const entry = byVersion.get(version) ?? { name: m[2]! };
    if (entry.name !== m[2]) throw new MigrationError(`version ${version} has conflicting names`);
    const text = normalize(readFileSync(`${dir}/${file}`, 'utf8'));
    if (m[3] === 'up') entry.up = text;
    else entry.down = text;
    byVersion.set(version, entry);
  }
  const versions = [...byVersion.keys()].sort((a, b) => a - b);
  return versions.map((version, i) => {
    const e = byVersion.get(version)!;
    if (version !== i + 1)
      throw new MigrationError(`migration versions must be contiguous from 1 (found ${version})`);
    if (e.up === undefined || e.down === undefined) {
      throw new MigrationError(`migration ${version}_${e.name} needs both .up.sql and .down.sql`);
    }
    const phaseMatch = /^-- migrate:phase (expand|contract)\s*$/m.exec(e.up);
    if (!phaseMatch)
      throw new MigrationError(`migration ${version}_${e.name} must declare -- migrate:phase`);
    return {
      version,
      name: e.name,
      phase: phaseMatch[1] as MigrationPhase,
      transactional: !/^-- migrate:no-transaction\s*$/m.test(e.up),
      up: e.up,
      down: e.down,
      checksum: sha256(e.up),
      downChecksum: sha256(e.down),
    };
  });
}

export function latestMigrationVersion(dir: string = MIGRATIONS_DIR): number {
  const all = loadMigrations(dir);
  return all.at(-1)?.version ?? 0;
}

export interface VerifyReport {
  applied: number;
  pending: number;
  problems: string[];
}

/** Tamper evidence: checksums, down checksums, hash chain, and ordering against the files. */
export function verifyHistory(files: MigrationFile[], applied: AppliedMigration[]): VerifyReport {
  const problems: string[] = [];
  const byVersion = new Map(files.map((f) => [f.version, f]));
  let prev = GENESIS;
  applied.forEach((row, i) => {
    if (row.version !== i + 1) problems.push(`history gap or reordering at version ${row.version}`);
    const file = byVersion.get(row.version);
    if (!file) {
      problems.push(`applied migration ${row.version}_${row.name} has no file`);
    } else {
      if (file.name !== row.name) problems.push(`migration ${row.version} was renamed`);
      if (file.checksum !== row.checksum)
        problems.push(`migration ${row.version}_${row.name} was modified after it was applied`);
      if (file.downChecksum !== row.down_checksum)
        problems.push(
          `down migration ${row.version}_${row.name} was modified after it was applied`,
        );
    }
    const expected = chainHash(prev, row);
    if (expected !== row.chain_hash)
      problems.push(`history chain broken at version ${row.version}`);
    prev = row.chain_hash;
  });
  return { applied: applied.length, pending: Math.max(files.length - applied.length, 0), problems };
}

export interface MigratorOptions {
  /** Connection string for the `migrator` login role. */
  connectionString: string;
  /** Deployment environment this database is (or becomes) bound to. */
  environment: string;
  dir?: string;
  log?: (event: string, fields: Record<string, string | number | boolean>) => void;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export interface UpOptions {
  /** Contract migrations run only when explicitly requested, after every instance runs new code. */
  includeContract?: boolean;
  /** Stop after this version. */
  to?: number;
}

// Only issues DDL when the history does not exist yet: CREATE SCHEMA IF NOT EXISTS would still
// require database-level CREATE on every run.
const HISTORY_DDL = `
DO $history$
BEGIN
  IF to_regnamespace('ops') IS NULL THEN
    CREATE SCHEMA ops;
    COMMENT ON SCHEMA ops IS 'Operational platform metadata (migration history, environment binding, worker liveness). No tenant data.';
  END IF;
END
$history$;
CREATE TABLE IF NOT EXISTS ops.schema_migration (
  version integer PRIMARY KEY,
  name text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('expand', 'contract')),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  down_checksum text NOT NULL CHECK (down_checksum ~ '^[0-9a-f]{64}$'),
  chain_hash text NOT NULL CHECK (chain_hash ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT session_user,
  execution_ms integer NOT NULL CHECK (execution_ms >= 0)
);`;

export class Migrator {
  readonly #options: MigratorOptions;
  readonly #files: MigrationFile[];

  constructor(options: MigratorOptions) {
    this.#options = options;
    this.#files = loadMigrations(options.dir);
  }

  get files(): readonly MigrationFile[] {
    return this.#files;
  }

  async #withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({
      connectionString: this.#options.connectionString,
      application_name: 'pm-migrator',
      lock_timeout: this.#options.lockTimeoutMs ?? 10_000,
      statement_timeout: this.#options.statementTimeoutMs ?? 300_000,
    });
    await client.connect();
    try {
      await this.#assertMigratorIdentity(client);
      await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
      try {
        await client.query('SET ROLE pm_owner');
        await client.query(HISTORY_DDL);
        return await fn(client);
      } finally {
        await client.query('RESET ROLE').catch(() => undefined);
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
      }
    } finally {
      await client.end();
    }
  }

  /** Migrations run only through the dedicated migrator login (0C §12.3). */
  async #assertMigratorIdentity(client: pg.Client): Promise<void> {
    const { rows } = await client.query<{ u: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    const row = rows[0];
    if (!row || row.u !== 'migrator')
      throw new MigrationError('migrations must run as the migrator role');
    if (row.rolsuper || row.rolbypassrls)
      throw new MigrationError('the migrator role must not be a superuser or bypass RLS');
  }

  async #applied(client: pg.Client): Promise<AppliedMigration[]> {
    const { rows } = await client.query<AppliedMigration>(
      'SELECT version, name, phase, checksum, down_checksum, chain_hash FROM ops.schema_migration ORDER BY version',
    );
    return rows;
  }

  async #checkEnvironment(client: pg.Client, bind: boolean): Promise<void> {
    const exists = await client.query<{ present: boolean }>(
      "SELECT to_regclass('ops.environment_binding') IS NOT NULL AS present",
    );
    if (!exists.rows[0]?.present) return;
    const { rows } = await client.query<{ environment: string }>(
      'SELECT environment FROM ops.environment_binding',
    );
    const bound = rows[0]?.environment;
    if (bound !== undefined && bound !== this.#options.environment) {
      throw new MigrationError(
        `database is bound to another environment; refusing to migrate it as ${this.#options.environment}`,
      );
    }
    if (bound === undefined && bind) {
      await client.query('INSERT INTO ops.environment_binding (environment) VALUES ($1)', [
        this.#options.environment,
      ]);
      this.#options.log?.('migrate.environment_bound', { env: this.#options.environment });
    }
  }

  async verify(): Promise<VerifyReport> {
    return this.#withClient(async (client) =>
      verifyHistory(this.#files, await this.#applied(client)),
    );
  }

  async status(): Promise<{
    applied: AppliedMigration[];
    pending: MigrationFile[];
    report: VerifyReport;
  }> {
    return this.#withClient(async (client) => {
      const applied = await this.#applied(client);
      return {
        applied,
        pending: this.#files.slice(applied.length),
        report: verifyHistory(this.#files, applied),
      };
    });
  }

  async up(
    options: UpOptions = {},
  ): Promise<{ applied: number[]; blockedByContract: number | undefined }> {
    return this.#withClient(async (client) => {
      await this.#checkEnvironment(client, false);
      const applied = await this.#applied(client);
      const report = verifyHistory(this.#files, applied);
      if (report.problems.length)
        throw new MigrationError(
          `migration history verification failed:\n${report.problems.join('\n')}`,
        );
      let prev = applied.at(-1)?.chain_hash ?? GENESIS;
      const done: number[] = [];
      let blockedByContract: number | undefined;
      for (const file of this.#files.slice(applied.length)) {
        if (options.to !== undefined && file.version > options.to) break;
        if (file.phase === 'contract' && !options.includeContract) {
          blockedByContract = file.version;
          break;
        }
        const started = performance.now();
        const chain = chainHash(prev, {
          version: file.version,
          name: file.name,
          checksum: file.checksum,
          down_checksum: file.downChecksum,
        });
        const record = async () => {
          await client.query(
            `INSERT INTO ops.schema_migration (version, name, phase, checksum, down_checksum, chain_hash, execution_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              file.version,
              file.name,
              file.phase,
              file.checksum,
              file.downChecksum,
              chain,
              Math.round(performance.now() - started),
            ],
          );
        };
        if (file.transactional) {
          await client.query('BEGIN');
          try {
            await client.query(file.up);
            await record();
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        } else {
          await client.query(file.up);
          await record();
        }
        prev = chain;
        done.push(file.version);
        this.#options.log?.('migrate.applied', {
          migration_version: file.version,
          migration_name: file.name,
          state: file.phase,
        });
      }
      await this.#checkEnvironment(client, true);
      return { applied: done, blockedByContract };
    });
  }

  /** Reverses migrations above `to`. Callers restrict this to local and test environments. */
  async down(to: number): Promise<number[]> {
    return this.#withClient(async (client) => {
      const applied = await this.#applied(client);
      const report = verifyHistory(this.#files, applied);
      if (report.problems.length)
        throw new MigrationError(
          `migration history verification failed:\n${report.problems.join('\n')}`,
        );
      const reverted: number[] = [];
      for (const row of [...applied].reverse()) {
        if (row.version <= to) break;
        const file = this.#files[row.version - 1]!;
        await client.query('BEGIN');
        try {
          await client.query(file.down);
          await client.query('DELETE FROM ops.schema_migration WHERE version = $1', [row.version]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
        reverted.push(row.version);
        this.#options.log?.('migrate.reverted', {
          migration_version: row.version,
          migration_name: row.name,
        });
      }
      return reverted;
    });
  }
}
