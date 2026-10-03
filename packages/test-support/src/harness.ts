import { loadServerConfig, type ServerConfig } from '@pm/config';
import {
  createPool,
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
    discovery: new PlatformDiscovery(pools.dispatcher),
    health: new PlatformHealth(pools.app),
    async close() {
      await Promise.allSettled([pools.app.end(), pools.worker.end(), pools.dispatcher.end()]);
      await telemetry.shutdown();
    },
  };
}
