// Static review gate for SQL migrations and bootstrap (complements the catalog tests).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'packages/db/migrations';
const problems = [];
const tenantSchemas = /^(exec|tenancy|access|work|relations|templates|planning)\./;

for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  const sql = readFileSync(join(dir, file), 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  const isUp = file.endsWith('.up.sql');
  const phase = /^-- migrate:phase (expand|contract)/m.exec(sql)?.[1];

  if (/(?<!NO)BYPASSRLS/i.test(code)) problems.push(`${file}: grants BYPASSRLS`);
  if (/set_config\([^)]*,\s*false\s*\)/i.test(code))
    problems.push(`${file}: session-level set_config`);
  if (/\bSET\s+(SESSION\s+)?app\./i.test(code)) problems.push(`${file}: session-level SET app.*`);
  if (/\bTO\s+PUBLIC\b/i.test(code)) problems.push(`${file}: grants to PUBLIC`);
  if (/\bSUPERUSER\b/i.test(code.replace(/NOSUPERUSER/gi, ''))) problems.push(`${file}: superuser`);

  // Every definer function pins search_path.
  for (const m of code.matchAll(
    /CREATE\s+FUNCTION[\s\S]*?\$\$|CREATE\s+FUNCTION[\s\S]*?AS\s+\$\w*\$/gi,
  )) {
    if (/SECURITY\s+DEFINER/i.test(m[0]) && !/SET\s+search_path/i.test(m[0]))
      problems.push(`${file}: SECURITY DEFINER without SET search_path`);
  }

  if (isUp) {
    if (!phase) problems.push(`${file}: missing -- migrate:phase`);
    if (
      phase === 'expand' &&
      /\b(DROP\s+(TABLE|COLUMN|SCHEMA|TYPE)|RENAME\s+(TO|COLUMN)|ALTER\s+COLUMN\s+\w+\s+(TYPE|SET\s+NOT\s+NULL))\b/i.test(
        code,
      )
    ) {
      problems.push(
        `${file}: destructive change in an expand migration (use a contract migration)`,
      );
    }
    // Tenant tables carry RLS (enabled + forced) and a tenant_isolation policy in the same migration.
    for (const m of code.matchAll(/CREATE\s+TABLE\s+([a-z_]+\.[a-z_]+)\s*\(([\s\S]*?)\n\);/gi)) {
      const [, table, body] = m;
      if (!tenantSchemas.test(table)) continue;
      const tenant = /\bworkspace_id\b/.test(body) || table === 'tenancy.workspace';
      if (!tenant) continue;
      for (const need of [
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
        `CREATE POLICY tenant_isolation ON ${table}`,
      ]) {
        if (!code.includes(need)) problems.push(`${file}: ${table} lacks "${need}"`);
      }
    }
  }
}

if (problems.length) {
  console.error(`SQL safety check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log('SQL safety check passed');
