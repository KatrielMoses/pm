import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrations, MigrationError, sqlOperationName } from '@pm/db';

const ROOT = resolve(import.meta.dirname, '../../../..');

describe('migration files', () => {
  it('are contiguous, paired with down migrations, and declare a phase', () => {
    const files = loadMigrations();
    expect(files.map((f) => f.version)).toEqual(files.map((_, i) => i + 1));
    for (const f of files) expect(['expand', 'contract']).toContain(f.phase);
  });

  it('rejects missing down files and missing phase headers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-mig-'));
    writeFileSync(join(dir, '0001_a.up.sql'), '-- migrate:phase expand\nSELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(MigrationError);
    writeFileSync(join(dir, '0001_a.down.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '0002_b.up.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '0002_b.down.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/migrate:phase/);
  });
});

describe('content-free SQL span names', () => {
  it('reduces statements to their leading keyword', () => {
    expect(sqlOperationName("select * from exec.job where id = 'secret'")).toBe('SELECT');
    expect(sqlOperationName({ text: 'INSERT INTO t VALUES ($1)' })).toBe('INSERT');
    expect(sqlOperationName('DO $$ BEGIN END $$')).toBe('OTHER');
  });
});

describe('operational identities stay out of application code', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
    );
  it('web/API, worker, and platform sources never reference migrator or restore credentials', () => {
    const files = ['apps/api/src', 'apps/worker/src', 'packages/platform/src'].flatMap((d) =>
      walk(join(ROOT, d)),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(
        /DATABASE_(MIGRATOR|RESTORE)_URL|connections\.(migrator|restore)|['"](migrator|restore_operator|pm_owner)['"]/,
      );
    }
  });
});
