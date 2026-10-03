import { createDisposableDatabase, sharedServer, type DisposableDatabase } from '@pm/test-infra';
import { bootstrapRoles, grantDatabaseAccess, type LoginRole } from '@pm/db';

// Narrow helper for @pm/db's own tests: generic disposable databases (test-infra) prepared with
// this package's bootstrap. No dependency on @pm/test-support, so the workspace graph stays acyclic.

export interface DbTestDatabase extends DisposableDatabase {
  database: string;
  app: string;
  migrator: string;
}

const extend = (db: DisposableDatabase): DbTestDatabase => ({
  ...db,
  database: db.name,
  app: db.loginUrl('app_rw'),
  migrator: db.loginUrl('migrator'),
});

export async function emptyDatabase(): Promise<DbTestDatabase> {
  return extend(
    await createDisposableDatabase({
      prefix: 'pm_e',
      prepare: (url, name) =>
        bootstrapRoles(url, name, sharedServer().passwords as Record<LoginRole, string>),
    }),
  );
}

export async function migratedDatabase(): Promise<DbTestDatabase> {
  return extend(
    await createDisposableDatabase({
      prefix: 'pm_t',
      template: sharedServer().template,
      prepare: grantDatabaseAccess,
    }),
  );
}
