import { randomBytes } from 'node:crypto';
import { loadServerConfig, type ServerConfig } from '@pm/config';
import {
  createPool,
  PlatformDatabase,
  PlatformDiscovery,
  PlatformHealth,
  TenantDatabase,
  type InstrumentedPool,
} from '@pm/db';
import {
  createLogger,
  initTelemetry,
  MemorySink,
  type Logger,
  type Telemetry,
} from '@pm/observability';
import type { DatabaseUrls } from './provision.ts';

/** Random per process: no fixed test key exists in the repository. */
export const TEST_KEYS = {
  signing: randomBytes(32).toString('base64url'),
  vault: randomBytes(32).toString('base64url'),
};

/** Environment for loadServerConfig in tests: real config validation, test identities. */
export function testEnv(
  urls: DatabaseUrls,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    APP_ENV: 'test',
    DATABASE_APP_URL: urls.app,
    DATABASE_WORKER_URL: urls.worker,
    DATABASE_DISPATCHER_URL: urls.dispatcher,
    DATABASE_MIGRATOR_URL: urls.migrator,
    DATABASE_RESTORE_URL: urls.restore,
    LOG_LEVEL: 'debug',
    JOB_LEASE_DURATION_MS: '3000',
    JOB_HEARTBEAT_INTERVAL_MS: '500',
    JOB_BACKOFF_BASE_MS: '10',
    JOB_BACKOFF_CAP_MS: '50',
    WORKER_POLL_INTERVAL_MS: '50',
    // Identity (1B): per-run random keys, development adapters (refused outside local/test).
    AUTH_SIGNING_KEY: TEST_KEYS.signing,
    DEV_VAULT_KEY: TEST_KEYS.vault,
    SECRET_VAULT: 'dev-database',
    MAIL_TRANSPORT: 'capture',
    COOKIE_SECURE: 'false',
    OAUTH_PROVIDERS: 'local',
    BOT_PROTECTION: 'test',
    AUTH_RESPONSE_FLOOR_MS: '0',
    // Minimum Argon2id cost keeps the suite fast; production defaults are covered by unit tests.
    ARGON2_MEMORY_KIB: '19456',
    ARGON2_PASSES: '2',
    ...overrides,
  };
}

export interface Harness {
  config: ServerConfig;
  telemetry: Telemetry;
  sink: MemorySink;
  logger: Logger;
  pools: { app: InstrumentedPool; worker: InstrumentedPool; dispatcher: InstrumentedPool };
  app: TenantDatabase;
  worker: TenantDatabase;
  /** Platform-scope access (identity, platform jobs) as app_rw and app_worker. */
  platform: PlatformDatabase;
  platformWorker: PlatformDatabase;
  discovery: PlatformDiscovery;
  health: PlatformHealth;
  close(): Promise<void>;
}

export function createHarness(urls: DatabaseUrls, overrides: Record<string, string> = {}): Harness {
  const env = testEnv(urls, overrides);
  const api = loadServerConfig({ service: 'api', env });
  const workerConfig = loadServerConfig({ service: 'worker', env });
  const telemetry = initTelemetry({
    serviceName: 'pm-test',
    serviceVersion: 'test',
    environment: 'test',
    traceSampleRatio: 1,
    strictMetrics: true,
    inMemory: true,
  });
  const sink = new MemorySink();
  const logger = createLogger({ service: 'pm-test', level: 'debug', sink });
  const deps = { logger, metrics: telemetry.metrics, tracer: telemetry.tracer };
  const pools = {
    app: createPool(api.database.connections.app!, api.database, deps, {
      applicationName: 'pm-test-app',
    }),
    worker: createPool(workerConfig.database.connections.worker!, workerConfig.database, deps, {
      applicationName: 'pm-test-worker',
    }),
    dispatcher: createPool(
      workerConfig.database.connections.dispatcher!,
      workerConfig.database,
      deps,
      { applicationName: 'pm-test-dispatcher', max: 4 },
    ),
  };
  return {
    config: workerConfig,
    telemetry,
    sink,
    logger,
    pools,
    app: new TenantDatabase(pools.app, deps),
    worker: new TenantDatabase(pools.worker, deps),
    platform: new PlatformDatabase(pools.app, deps),
    platformWorker: new PlatformDatabase(pools.worker, deps),
    discovery: new PlatformDiscovery(pools.dispatcher),
    health: new PlatformHealth(pools.app),
    async close() {
      await Promise.allSettled([pools.app.end(), pools.worker.end(), pools.dispatcher.end()]);
      await telemetry.shutdown();
    },
  };
}
