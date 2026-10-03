import { bootstrapRoles, grantDatabaseAccess } from '@pm/db';
import { createDisposableDatabase, sharedServer } from '@pm/test-infra';
import type pg from 'pg';
import { urlsFor, type DatabaseUrls, type RolePasswords } from './provision.ts';

export interface TestDatabase extends DatabaseUrls {
  /** Superuser access for assertions that must look past RLS (catalog checks, crash simulation). */
  admin(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
  drop(): Promise<void>;
}

async function wrap(
  db: Awaited<ReturnType<typeof createDisposableDatabase>>,
): Promise<TestDatabase> {
  const server = sharedServer();
  return {
    ...urlsFor(server, db.name, server.passwords as RolePasswords),
    admin: db.admin,
    drop: db.drop,
  };
}

/**
 * A per-file database cloned from the migrated template. Database-level privileges are not copied
 * by a template (nor by a logical restore), so they are re-asserted as the restore runbook requires.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  return wrap(
    await createDisposableDatabase({
      prefix: 'pm_t',
      template: sharedServer().template,
      prepare: grantDatabaseAccess,
    }),
  );
}

/** A brand-new database with bootstrapped roles and no migrations. */
export async function createEmptyTestDatabase(): Promise<TestDatabase> {
  const passwords = sharedServer().passwords as RolePasswords;
  return wrap(
    await createDisposableDatabase({
      prefix: 'pm_e',
      prepare: (url, name) => bootstrapRoles(url, name, passwords),
    }),
  );
}
