import { AuditSecurityEventSink, AuditWriter } from '@pm/audit';
import type { ServerConfig } from '@pm/config';
import type { PlatformDatabase, TenantDatabase } from '@pm/db';
import type { Logger, Metrics } from '@pm/observability';
import { PostgresRateLimiter } from '@pm/identity';
import { LifecycleRegistry, LifecycleService, RetentionPolicy } from '@pm/lifecycle';
import { registerTenancyLifecycle, tenancyBrandPort } from './lifecycle.ts';
import { TenancyService, type StepUpPort } from './service.ts';

/** Wires the tenancy service from validated configuration (API process and tests). */
export function createTenancyService(deps: {
  tenant: TenantDatabase;
  platform: PlatformDatabase;
  stepUp: StepUpPort;
  config: Pick<ServerConfig, 'identity' | 'lifecycle' | 'audit'>;
  logger: Logger;
  metrics: Metrics;
}): TenancyService {
  const { config } = deps;
  if (!config.identity.signingKey) throw new Error('AUTH_SIGNING_KEY is required');
  const writer = new AuditWriter({
    module: 'tenancy',
    logger: deps.logger,
    metrics: deps.metrics,
    lockWaitWarnMs: config.audit.chainLockWaitWarnMs,
  });
  const lifecycle = new LifecycleService({
    // Record types register containment in their owning phases; brands register here.
    registry: registerTenancyLifecycle(new LifecycleRegistry()),
    writer,
    retention: new RetentionPolicy(config.lifecycle),
    brands: tenancyBrandPort,
    metrics: deps.metrics,
    logger: deps.logger,
  });
  const signingKey = Buffer.from(config.identity.signingKey.reveal(), 'base64url');
  return new TenancyService({
    tenant: deps.tenant,
    platform: deps.platform,
    writer,
    security: new AuditSecurityEventSink(deps.metrics),
    lifecycle,
    stepUp: deps.stepUp,
    limiter: new PostgresRateLimiter(deps.platform, signingKey, config.identity.rateLimitOverrides),
    signingKey,
    metrics: deps.metrics,
    logger: deps.logger,
  });
}
