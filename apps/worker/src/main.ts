// Worker entrypoint: durable jobs, outbox dispatch, lease recovery, and retention maintenance.
// Same artifact as the web/API process; no public ingress.
import { writeFileSync } from 'node:fs';
import { loadLocalDotEnv, loadServerConfig } from '@pm/config';
import {
  assertApplicationIdentity,
  createPool,
  PlatformDatabase,
  PlatformDiscovery,
  TenantDatabase,
} from '@pm/db';
import { CaptureTransport, createVault } from '@pm/identity';
import { PUBLIC_CONFIG } from '@pm/config/public';
import { createLogger, errorFields, initTelemetry, LogErrorReporter } from '@pm/observability';
import { AuditWriter } from '@pm/audit';
import {
  createPurgeLedger,
  LifecycleRegistry,
  LifecycleService,
  PurgeExecutor,
  readRecoveryGate,
  RetentionPolicy,
} from '@pm/lifecycle';
import { SYSTEM_PRINCIPAL, WorkerRuntime } from '@pm/platform';
import { HEALTH_FILE } from './health-file.ts';
import { registeredConsumers, registeredHandlers, registeredSchedules } from './registry.ts';

async function main(): Promise<void> {
  loadLocalDotEnv();
  const config = loadServerConfig({ service: 'worker' });
  const logger = createLogger({
    service: 'pm-worker',
    level: config.log.level,
    base: { env: config.env, build_id: config.build.id },
  });
  const telemetry = initTelemetry({
    serviceName: 'pm-worker',
    serviceVersion: config.build.version,
    environment: config.env,
    otlpEndpoint: config.telemetry.otlpEndpoint,
    traceSampleRatio: config.telemetry.traceSampleRatio,
    strictMetrics: config.env === 'local' || config.env === 'test',
  });
  const deps = { logger, metrics: telemetry.metrics, tracer: telemetry.tracer };
  const workerPool = createPool(config.database.connections.worker!, config.database, deps, {
    applicationName: 'pm-worker',
  });
  const dispatcherPool = createPool(
    config.database.connections.dispatcher!,
    config.database,
    deps,
    { applicationName: 'pm-dispatcher', max: 2 },
  );
  await assertApplicationIdentity(workerPool, config.env);
  await assertApplicationIdentity(dispatcherPool, config.env);

  const errors = new LogErrorReporter(logger);
  const platformDb = new PlatformDatabase(workerPool, deps);
  // A restored environment stays closed until purge-ledger replay completes (0B §8.11).
  const gate = await readRecoveryGate(platformDb);
  if (gate.state !== 'open') throw new Error('recovery gate closed: purge-ledger replay required');
  if (config.identity.mailTransport !== 'capture') throw new Error('no mail transport configured');
  const identityDeps = {
    db: platformDb,
    config: config.identity,
    vault: createVault(config.identity),
    transport: new CaptureTransport(config.identity.mailCaptureDir),
    appName: PUBLIC_CONFIG.appName,
    logger,
    metrics: telemetry.metrics,
  };
  const tenantDb = new TenantDatabase(workerPool, deps);
  const discovery = new PlatformDiscovery(dispatcherPool);
  // Record types register their containment and purge hooks in their owning phases; until then
  // the registry is empty and purge of any batch blocks safely (missing_purge_hook).
  const lifecycle = new LifecycleService({
    registry: new LifecycleRegistry(),
    writer: new AuditWriter({
      module: 'lifecycle',
      logger,
      metrics: telemetry.metrics,
      lockWaitWarnMs: config.audit.chainLockWaitWarnMs,
    }),
    retention: new RetentionPolicy(config.lifecycle),
    metrics: telemetry.metrics,
    logger,
  });
  const runtime = new WorkerRuntime({
    db: tenantDb,
    discovery,
    platformDb,
    handlers: registeredHandlers({
      identity: identityDeps,
      audit: {
        tenant: tenantDb,
        platform: platformDb,
        discovery,
        metrics: telemetry.metrics,
        logger,
      },
      lifecycle: {
        executor: new PurgeExecutor(lifecycle, createPurgeLedger(config.lifecycle)),
        scheduler: {
          svc: lifecycle,
          tenant: tenantDb,
          discovery,
          systemPrincipalId: SYSTEM_PRINCIPAL.id,
        },
      },
    }),
    consumers: registeredConsumers(),
    schedules: registeredSchedules(),
    params: { ...config.jobs, outboxReplayWindowMs: config.retention.outboxReplayWindowMs },
    buildId: config.build.id,
    pools: [workerPool, dispatcherPool],
    errors,
    ...deps,
  });

  // Container health: a fresh timestamp while the runtime is running (no network port needed).
  const touch = () => {
    if (runtime.state === 'running') writeFileSync(HEALTH_FILE, String(Date.now()));
  };
  await runtime.start();
  touch();
  const health = setInterval(touch, Math.max(config.jobs.pollIntervalMs, 1_000));
  health.unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(health);
    logger.info('worker.signal', { signal });
    const force = setTimeout(() => process.exit(1), config.jobs.shutdownGraceMs + 10_000);
    force.unref();
    try {
      await runtime.stop(); // stop claiming, finish or release leases
      await workerPool.end();
      await dispatcherPool.end();
      await telemetry.shutdown(); // flush spans and metrics
      process.exit(0);
    } catch (err) {
      logger.error('worker.stop_failed', errorFields(err));
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => errors.capture(err, { component: 'worker' }));
}

main().catch((err: unknown) => {
  const name = err instanceof Error ? err.name : 'Error';
  const safe = name === 'ConfigError' || name === 'IdentityError';
  process.stderr.write(
    `${JSON.stringify({ level: 'error', service: 'pm-worker', event: 'worker.start_failed', error_class: name, ...(safe ? { reason: (err as Error).message } : {}) })}\n`,
  );
  process.exit(1);
});
