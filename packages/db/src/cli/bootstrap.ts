// Provider-level role bootstrap (run once per cluster by the platform/DBA admin, never by the app).
// Inputs (environment only; nothing is echoed):
//   BOOTSTRAP_ADMIN_URL       administrative connection (CREATEROLE) to the target database
//   BOOTSTRAP_DATABASE        database name
//   PM_ROLE_PASSWORD_<ROLE>   one per login role: MIGRATOR, RESTORE_OPERATOR, APP_RW, APP_WORKER, DISPATCHER
import { bootstrapRoles, LOGIN_ROLES, type LoginRole } from '../bootstrap.ts';

const env = process.env;
const missing: string[] = [];
const need = (k: string) => {
  const v = env[k];
  if (!v) missing.push(k);
  return v ?? '';
};
const admin = need('BOOTSTRAP_ADMIN_URL');
const database = need('BOOTSTRAP_DATABASE');
const passwords = Object.fromEntries(
  LOGIN_ROLES.map((r) => [r, need(`PM_ROLE_PASSWORD_${r.toUpperCase()}`)]),
) as Record<LoginRole, string>;
if (missing.length) {
  process.stderr.write(`bootstrap: missing ${missing.join(', ')}\n`);
  process.exit(2);
}
bootstrapRoles(admin, database, passwords).then(
  () => {
    process.stdout.write(
      `${JSON.stringify({ level: 'info', service: 'pm-bootstrap', event: 'bootstrap.roles_asserted', count: LOGIN_ROLES.length })}\n`,
    );
    process.exit(0);
  },
  (err: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', service: 'pm-bootstrap', event: 'bootstrap.failed', error_class: err instanceof Error ? err.name : 'Error', error_code: (err as { code?: string }).code })}\n`,
    );
    process.exit(1);
  },
);
