// Web/API entrypoint: serves the browser application, `/v1`, `/healthz`, and `/readyz`.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadLocalDotEnv, loadServerConfig } from '@pm/config';
import {
  assertApplicationIdentity,
  createPool,
  latestMigrationVersion,
  PlatformDatabase,
  PlatformHealth,
  TenantDatabase,
} from '@pm/db';
import { createIdentityService } from '@pm/identity';
import {
  createObjectStorage,
  createWorkService,
  LocalObjectStorage,
  syntheticCaller,
} from '@pm/work';
import { PUBLIC_CONFIG } from '@pm/config/public';
import { createLogger, errorFields, initTelemetry, LogErrorReporter } from '@pm/observability';
import { buildApp } from './app.ts';
import { checkReadiness } from './readiness.ts';

async function main(): Promise<void> {
  loadLocalDotEnv();
  const config = loadServerConfig({ service: 'api' });
  const logger = createLogger({
    service: 'pm-api',
    level: config.log.level,
    base: { env: config.env, build_id: config.build.id },
  });
  const telemetry = initTelemetry({
    serviceName: 'pm-api',
    serviceVersion: config.build.version,
    environment: config.env,
    otlpEndpoint: config.telemetry.otlpEndpoint,
    traceSampleRatio: config.telemetry.traceSampleRatio,
    strictMetrics: config.env === 'local' || config.env === 'test',
  });
  const errors = new LogErrorReporter(logger);
  const pool = createPool(
    config.database.connections.app!,
    config.database,
    { logger, metrics: telemetry.metrics, tracer: telemetry.tracer },
    { applicationName: 'pm-api' },
  );
  await assertApplicationIdentity(pool, config.env);

  const health = new PlatformHealth(pool);
  const dbDeps = { logger, metrics: telemetry.metrics, tracer: telemetry.tracer };
  const platformDb = new PlatformDatabase(pool, dbDeps);
  const identity = createIdentityService({
    db: platformDb,
    config: config.identity,
    appName: PUBLIC_CONFIG.appName,
    logger,
    metrics: telemetry.metrics,
  });
  // One service instance: projects (2A) extend the 1C–1E tenancy service.
  const tenancy = createWorkService({
    tenant: new TenantDatabase(pool, dbDeps),
    platform: platformDb,
    identity: identity.service,
    config,
    logger,
    metrics: telemetry.metrics,
  });
  // 4E: the object store this process signs URLs for (readiness probe; local dev/test route).
  const objectStorage = createObjectStorage(config.files.storage);
  let draining = false;
  const defaultWeb = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const app = await buildApp({
    config,
    logger,
    metrics: telemetry.metrics,
    tracer: telemetry.tracer,
    errors,
    webDistDir: config.http.webDistDir ?? (existsSync(defaultWeb) ? defaultWeb : undefined),
    auth: {
      identity: identity.service,
      localOAuth: identity.localOAuth,
      componentHarness: config.features.componentHarness,
      resolveBearer: async (secret) => {
        const apiToken = await tenancy.authenticateApiToken(secret);
        const oauthToken = apiToken ? null : await tenancy.authenticateOAuthAccessToken(secret);
        const found = apiToken ?? oauthToken;
        if (!found) return null;
        const caller = syntheticCaller(found.accountId, found.delegation, {
          correlationId: '0'.repeat(32),
        });
        return {
          auth: caller.auth,
          delegation: found.delegation,
          ...(oauthToken ? { workspacePublicId: oauthToken.workspacePublicId } : {}),
        };
      },
      limitBearer: (tokenId, write) => tenancy.limitApi(tokenId, write),
      limitMcp: (tokenId, write) => tenancy.limitMcp(tokenId, write),
    },
    tenancy: { tenancy },
    work: { work: tenancy },
    localStorage:
      config.files.storage.provider === 'local' && objectStorage instanceof LocalObjectStorage
        ? {
            storage: objectStorage,
            secret: config.files.storage.secret.reveal(),
            maxBytes: config.work.fileUploadMaxBytes,
          }
        : undefined,
    readiness: () =>
      checkReadiness({
        health,
        expectedMigrationVersion: latestMigrationVersion(),
        config: config.readiness,
        logger,
        metrics: telemetry.metrics,
        isDraining: () => draining,
        emailTransport: config.identity.mailTransport,
        mcpEnabled: config.work.mcpEnabled,
        objectStorage: objectStorage ? () => objectStorage.check() : undefined,
      }),
  });
  const saturation = setInterval(() => pool.recordSaturation(), 15_000);
  saturation.unref();

  await app.listen({ host: config.http.host, port: config.http.port });
  logger.info('api.started', { port: config.http.port });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    draining = true; // readiness fails first so the load balancer stops routing
    logger.info('api.stopping', { signal });
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    try {
      await app.close(); // stops accepting, finishes in-flight requests
      clearInterval(saturation);
      await pool.end();
      await telemetry.shutdown();
      logger.info('api.stopped', { signal });
      process.exit(0);
    } catch (err) {
      logger.error('api.stop_failed', errorFields(err));
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    errors.capture(err, { component: 'api' });
  });
}

main().catch((err: unknown) => {
  const name = err instanceof Error ? err.name : 'Error';
  // Configuration and identity errors name rules, never values.
  const safe = name === 'ConfigError' || name === 'IdentityError';
  process.stderr.write(
    `${JSON.stringify({ level: 'error', service: 'pm-api', event: 'api.start_failed', error_class: name, ...(safe ? { reason: (err as Error).message } : {}) })}\n`,
  );
  process.exit(1);
});
