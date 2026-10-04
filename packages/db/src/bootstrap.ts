import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const BOOTSTRAP_ROLES_SQL = fileURLToPath(
  new URL('../bootstrap/roles.sql', import.meta.url),
);

export const LOGIN_ROLES = [
  'migrator',
  'restore_operator',
  'app_rw',
  'app_worker',
  'dispatcher',
] as const;
export type LoginRole = (typeof LOGIN_ROLES)[number];

/**
 * Runs the provider-level role bootstrap as an administrative connection. Passwords travel as
 * transaction-local settings, so they never appear in SQL text or logs.
 */
export async function bootstrapRoles(
  adminConnectionString: string,
  database: string,
  passwords: Readonly<Record<LoginRole, string>>,
): Promise<void> {
  const client = new pg.Client({
    connectionString: adminConnectionString,
    application_name: 'pm-bootstrap',
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('pm.bootstrap.database', $1, true)", [database]);
    for (const role of LOGIN_ROLES) {
      await client.query(`SELECT set_config('pm.bootstrap.${role}_password', $1, true)`, [
        passwords[role],
      ]);
    }
    await client.query(readFileSync(BOOTSTRAP_ROLES_SQL, 'utf8'));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * Re-asserts database-level privileges (CONNECT for login roles, TEMPORARY for the application
 * identities, CREATE for pm_owner) on a database
 * created from a template or restored logically: those privileges belong to the database object,
 * not to its contents. Roles must already exist.
 */
export async function grantDatabaseAccess(
  adminConnectionString: string,
  database: string,
): Promise<void> {
  const client = new pg.Client({
    connectionString: adminConnectionString,
    application_name: 'pm-bootstrap',
  });
  await client.connect();
  try {
    const ident = (await client.query<{ q: string }>('SELECT quote_ident($1) AS q', [database]))
      .rows[0]!.q;
    for (const role of LOGIN_ROLES)
      await client.query(`GRANT CONNECT ON DATABASE ${ident} TO ${role}`);
    await client.query(`GRANT CREATE ON DATABASE ${ident} TO pm_owner`);
    // Visibility-context temporary tables (0C §4.5): explicit, not the PUBLIC default.
    await client.query(`GRANT TEMPORARY ON DATABASE ${ident} TO app_rw, app_worker`);
  } finally {
    await client.end();
  }
}
