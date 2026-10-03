import type { TestProject } from 'vitest/node';
import { adminQuery, POSTGRES_IMAGE, startPostgres } from '@pm/test-infra';
import { generatePasswords, provisionDatabase } from './provision.ts';

/**
 * Starts one disposable PostgreSQL (container in CI) and a migrated template database for the
 * integration run. The server is stopped (container removed) after success and after failure.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await startPostgres();
  try {
    const passwords = generatePasswords();
    const template = 'pm_template';
    await provisionDatabase(server, template, passwords);
    project.provide('pmPostgres', {
      adminUrl: server.adminUrl(),
      host: server.host,
      port: server.port,
      mode: server.mode,
      passwords,
      template,
    });
    const version = (await adminQuery(server, 'SHOW server_version')).rows[0]
      ?.server_version as string;
    const source = server.mode === 'container' ? `image ${POSTGRES_IMAGE}` : server.mode;
    process.stdout.write(
      `[integration] PostgreSQL ${version} (${source}); migrated template ${template}\n`,
    );
  } catch (err) {
    await server.stop();
    throw err;
  }
  return async () => {
    await server.stop();
    process.stdout.write(`[integration] PostgreSQL (${server.mode}) stopped and removed\n`);
  };
}
