import { randomBytes } from 'node:crypto';
import { bootstrapRoles, grantDatabaseAccess, LOGIN_ROLES, Migrator, type LoginRole } from '@pm/db';
import { createDatabase, makeUrl, type PostgresServer } from '@pm/test-infra';

// Binds the application's role bootstrap and migrator onto the generic test infrastructure.

export type RolePasswords = Readonly<Record<LoginRole, string>>;

/** Random per-run credentials: no fixed test password exists in the repository. */
export function generatePasswords(): RolePasswords {
  const out: Partial<Record<LoginRole, string>> = {};
  for (const role of LOGIN_ROLES) out[role] = randomBytes(24).toString('base64url');
  return out as RolePasswords;
}

export interface DatabaseUrls {
  database: string;
  app: string;
  worker: string;
  dispatcher: string;
  migrator: string;
  restore: string;
}

export function urlsFor(
  server: Pick<PostgresServer, 'host' | 'port'>,
  database: string,
  passwords: RolePasswords,
): DatabaseUrls {
  const u = (role: LoginRole) => makeUrl(role, passwords[role], server.host, server.port, database);
  return {
    database,
    app: u('app_rw'),
    worker: u('app_worker'),
    dispatcher: u('dispatcher'),
    migrator: u('migrator'),
    restore: u('restore_operator'),
  };
}

/** Creates a database, bootstraps roles, and applies every migration as `migrator`. */
export async function provisionDatabase(
  server: PostgresServer,
  database: string,
  passwords: RolePasswords,
  environment = 'test',
): Promise<DatabaseUrls> {
  await createDatabase(server, database);
  await bootstrapRoles(server.adminUrl(database), database, passwords);
  const urls = urlsFor(server, database, passwords);
  await new Migrator({ connectionString: urls.migrator, environment }).up();
  return urls;
}

export { grantDatabaseAccess };
