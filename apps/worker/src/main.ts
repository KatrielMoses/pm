// Worker entrypoint: durable jobs, outbox dispatch, lease recovery, and retention maintenance.
// Same artifact as the web/API process; no public ingress.
import { writeFileSync } from 'node:fs';
import { loadLocalDotEnv, loadServerConfig } from '@pm/config';
import { assertApplicationIdentity, createPool, PlatformDiscovery, TenantDatabase } from '@pm/db';
import { createLogger, errorFields, initTelemetry, LogErrorReporter } from '@pm/observability';
import { WorkerRuntime } from '@pm/platform';
import { HEALTH_FILE } from './health-file.ts';
import { registeredConsumers, registeredHandlers } from './registry.ts';

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
  const runtime = new WorkerRuntime({
    db: new TenantDatabase(workerPool, deps),
    discovery: new PlatformDiscovery(dispatcherPool),
    handlers: registeredHandlers(),
    consumers: registeredConsumers(),
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
