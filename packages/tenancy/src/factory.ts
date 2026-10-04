import { AuditSecurityEventSink, AuditWriter } from '@pm/audit';
import type { ServerConfig } from '@pm/config';
import type { PlatformDatabase, TenantDatabase } from '@pm/db';
import type { Logger, Metrics } from '@pm/observability';
import { PostgresRateLimiter } from '@pm/identity';
import { LifecycleRegistry, LifecycleService, RetentionPolicy } from '@pm/lifecycle';
import { registerTenancyLifecycle, tenancyBrandPort } from './lifecycle.ts';
import type { CollaborationIdentityPort } from './collaboration.ts';
import { NavigationService } from './navigation.ts';

/** Wires the tenancy service from validated configuration (API process and tests). */
export function createTenancyService(deps: {
  tenant: TenantDatabase;
  platform: PlatformDatabase;
  /** Identity (1B): step-up, invitation tokens and mail, departure session revocation. */
  identity: CollaborationIdentityPort;
  config: Pick<ServerConfig, 'identity' | 'lifecycle' | 'audit' | 'tenancy' | 'views'>;
  logger: Logger;
  metrics: Metrics;
}): NavigationService {
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
  return new NavigationService({
    tenant: deps.tenant,
    platform: deps.platform,
    writer,
    security: new AuditSecurityEventSink(deps.metrics),
    lifecycle,
    stepUp: deps.identity,
    identity: deps.identity,
    settings: {
      invitationLifetimeMs: config.tenancy.invitationLifetimeMs,
      ownershipTransferLifetimeMs: config.tenancy.ownershipTransferLifetimeMs,
      principalContextArrayMax: config.tenancy.principalContextArrayMax,
      previewTtlMs: 10 * 60_000,
    },
    views: config.views,
    limiter: new PostgresRateLimiter(deps.platform, signingKey, config.identity.rateLimitOverrides),
    signingKey,
    metrics: deps.metrics,
    logger: deps.logger,
  });
}
