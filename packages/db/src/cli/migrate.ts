// Migration CLI: runs only with the migrator identity (DATABASE_MIGRATOR_URL).
//   migrate up [--contract] [--to N]   apply pending migrations (contract ones only with --contract)
//   migrate verify                      tamper-evidence check of the applied history
//   migrate status                      applied/pending summary
//   migrate down --to N                 reverse to version N (local and test only)
import { loadLocalDotEnv, loadServerConfig } from '@pm/config';
import { createLogger } from '@pm/observability';
import { Migrator } from '../migrator.ts';

async function main(): Promise<number> {
  loadLocalDotEnv();
  const config = loadServerConfig({ service: 'migrate' });
  const logger = createLogger({ service: 'pm-migrate', level: config.log.level });
  const conn = config.database.connections.migrator!;
  const migrator = new Migrator({
    connectionString: conn.url.reveal(),
    environment: config.env,
    log: (event, fields) => logger.info(event, fields),
  });
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => rest.includes(name);
  const value = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const to = value('--to') !== undefined ? Number(value('--to')) : undefined;
  if (to !== undefined && (!Number.isInteger(to) || to < 0))
    throw new Error('--to must be a non-negative integer');

  switch (command) {
    case 'up': {
      const result = await migrator.up({
        includeContract: flag('--contract'),
        ...(to !== undefined ? { to } : {}),
      });
      logger.info('migrate.up_complete', { count: result.applied.length });
      if (result.blockedByContract !== undefined) {
        logger.warn('migrate.contract_pending', { migration_version: result.blockedByContract });
      }
      return 0;
    }
    case 'verify':
    case 'status': {
      const status = await migrator.status();
      for (const problem of status.report.problems)
        logger.error('migrate.verify_problem', { reason: problem });
      logger.info(`migrate.${command}`, {
        count: status.applied.length,
        state: status.report.problems.length ? 'tampered' : 'verified',
      });
      for (const p of status.pending)
        logger.info('migrate.pending', {
          migration_version: p.version,
          migration_name: p.name,
          state: p.phase,
        });
      return status.report.problems.length ? 1 : 0;
    }
    case 'down': {
      if (config.env !== 'local' && config.env !== 'test') {
        logger.error('migrate.down_refused', {
          env: config.env,
          reason: 'down migrations run only in local and test; deployed environments roll forward',
        });
        return 2;
      }
      if (to === undefined) throw new Error('down requires --to N');
      const reverted = await migrator.down(to);
      logger.info('migrate.down_complete', { count: reverted.length });
      return 0;
    }
    default:
      logger.error('migrate.usage', {
        reason: 'commands: up [--contract] [--to N] | verify | status | down --to N',
      });
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const name = err instanceof Error ? err.name : 'Error';
    // Migration and configuration errors carry no values; print them for the operator.
    const safe = name === 'MigrationError' || name === 'ConfigError';
    process.stderr.write(`${safe ? (err as Error).message : `migration failed (${name})`}\n`);
    process.exit(1);
  },
);
