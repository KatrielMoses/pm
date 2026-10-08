import { AuditSecurityEventSink, AuditWriter } from '@pm/audit';
import type { ServerConfig } from '@pm/config';
import type { PlatformDatabase, TenantDatabase } from '@pm/db';
import { PostgresRateLimiter } from '@pm/identity';
import { LifecycleRegistry, LifecycleService, RetentionPolicy } from '@pm/lifecycle';
import type { Logger, Metrics } from '@pm/observability';
import {
  defaultNavigationTargets,
  defaultOwnershipRegistry,
  registerTenancyLifecycle,
  tenancyBrandPort,
  type CollaborationIdentityPort,
} from '@pm/tenancy';
import { registerWorkLifecycle } from './lifecycle.ts';
import { projectTargets, savedViewTargets, taskTargets } from './navigation.ts';
import { projectOwnerHook, taskAssigneeHook } from './ownership.ts';
import { FileService } from './files/file-service.ts';
import { createMalwareScanner } from './files/scanner.ts';
import { createObjectStorage } from './files/storage.ts';
import { reviewDepartureHook } from './collab/departure.ts';
import { documentOwnerHook } from './docs/ownership.ts';
import { departureTimerHook } from './time/jobs.ts';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from './validation.ts';

/** The lifecycle registry with every record type registered so far (API and worker). */
export function productLifecycleRegistry(): LifecycleRegistry {
  return registerWorkLifecycle(registerTenancyLifecycle(new LifecycleRegistry()));
}

/**
 * Wires the full 1C–4B service (with 3B layouts, 3C planning, 4A collaboration, and 4B notifications) (tenancy, collaboration, navigation, projects, tasks) from validated
 * configuration. Work plugs into tenancy by injection only: its lifecycle adapters, its navigation
 * target, and its departure hook.
 */
export function createWorkService(deps: {
  tenant: TenantDatabase;
  platform: PlatformDatabase;
  identity: CollaborationIdentityPort;
  config: Pick<ServerConfig, 'identity' | 'lifecycle' | 'audit' | 'tenancy' | 'views'> &
    Partial<Pick<ServerConfig, 'files'>> & {
      work?: WorkSettings;
    };
  logger: Logger;
  metrics: Metrics;
}): FileService {
  const { config } = deps;
  if (!config.identity.signingKey) throw new Error('AUTH_SIGNING_KEY is required');
  const writer = new AuditWriter({
    module: 'tenancy',
    logger: deps.logger,
    metrics: deps.metrics,
    lockWaitWarnMs: config.audit.chainLockWaitWarnMs,
  });
  const lifecycle = new LifecycleService({
    registry: productLifecycleRegistry(),
    writer,
    retention: new RetentionPolicy(config.lifecycle),
    brands: tenancyBrandPort,
    metrics: deps.metrics,
    logger: deps.logger,
  });
  const signingKey = Buffer.from(config.identity.signingKey.reveal(), 'base64url');
  const arrayMax = config.tenancy.principalContextArrayMax;
  const work = config.work ?? DEFAULT_WORK_SETTINGS;
  return new FileService({
    // 4E: object storage and malware scanning, each absent until configured (never claimed).
    files: {
      storage: config.files ? createObjectStorage(config.files.storage) : null,
      scanner: config.files ? createMalwareScanner(config.files.scanner) : null,
    },
    notify: {
      emailState: config.identity.mailTransport === 'capture' ? 'capture' : 'unconfigured',
    },
    tenant: deps.tenant,
    platform: deps.platform,
    writer,
    security: new AuditSecurityEventSink(deps.metrics),
    lifecycle,
    stepUp: deps.identity,
    identity: deps.identity,
    ownership: defaultOwnershipRegistry()
      .register(projectOwnerHook)
      .register(taskAssigneeHook)
      .register(documentOwnerHook)
      .register(reviewDepartureHook(writer))
      .register(departureTimerHook(writer)),
    settings: {
      invitationLifetimeMs: config.tenancy.invitationLifetimeMs,
      ownershipTransferLifetimeMs: config.tenancy.ownershipTransferLifetimeMs,
      principalContextArrayMax: arrayMax,
      previewTtlMs: 10 * 60_000,
    },
    views: config.views,
    targets: defaultNavigationTargets()
      .register(projectTargets(arrayMax))
      .register(taskTargets(arrayMax))
      .register(savedViewTargets(arrayMax)),
    work,
    limiter: new PostgresRateLimiter(deps.platform, signingKey, {
      ...config.identity.rateLimitOverrides,
      'capture.member': { limit: work.captureRatePerMinute, windowMs: 60_000 },
      'intake.submit': { limit: work.intakeSubmissionsPerHour, windowMs: 60 * 60_000 },
      'comment.member': { limit: work.commentRatePerMinute, windowMs: 60_000 },
      'document.save': { limit: work.documentSaveRatePerMinute, windowMs: 60_000 },
    }),
    signingKey,
    metrics: deps.metrics,
    logger: deps.logger,
  });
}
