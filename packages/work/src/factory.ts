import { GoogleCalendarProvider, type CalendarProvider } from './integrations/calendar-provider.ts';
import { randomBytes } from 'node:crypto';
import { AuditSecurityEventSink, AuditWriter } from '@pm/audit';
import type { ServerConfig } from '@pm/config';
import type { PlatformDatabase, TenantDatabase } from '@pm/db';
import { createVault, PostgresRateLimiter } from '@pm/identity';
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
import { AiGatewayService } from './ai/ai-gateway-service.ts';
import { MessagesProvider, type AiProvider } from './ai/provider.ts';
import { connectionOwnerHook, webhookOwnerHook } from './integrations/ownership.ts';
import { goalOwnerHook } from './goals/ownership.ts';
import { insightsOwnerHook } from './insights/ownership.ts';
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
 * Wires the full 1C–5D service (with 3B layouts, 3C planning, 4A collaboration, 4B notifications, 4E files, 5A search, 5B goals and portfolios, 5C metrics, and 5D reports) (tenancy, collaboration, navigation, projects, tasks) from validated
 * configuration. Work plugs into tenancy by injection only: its lifecycle adapters, its navigation
 * target, and its departure hook.
 */
export function createWorkService(deps: {
  tenant: TenantDatabase;
  platform: PlatformDatabase;
  identity: CollaborationIdentityPort;
  config: Pick<ServerConfig, 'identity' | 'lifecycle' | 'audit' | 'tenancy' | 'views'> &
    Partial<Pick<ServerConfig, 'files' | 'env' | 'calendar' | 'ai'>> & {
      work?: WorkSettings;
    };
  logger: Logger;
  metrics: Metrics;
  /**
   * The worker renders reports but never issues or reads a client cursor, so it may run without
   * AUTH_SIGNING_KEY: a throwaway in-memory key stands in. The API never sets this and still fails
   * closed when the key is missing.
   */
  ephemeralSigningKey?: boolean;
  /** Overrides the configured calendar provider (tests point the real adapter at a fixture). */
  calendarProvider?: CalendarProvider | null;
  /** Overrides the configured AI transport (tests inject a fetch-wrapped adapter). */
  aiProvider?: AiProvider | null;
}): AiGatewayService {
  const { config } = deps;
  if (!config.identity.signingKey && !deps.ephemeralSigningKey)
    throw new Error('AUTH_SIGNING_KEY is required');
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
  const signingKey = config.identity.signingKey
    ? Buffer.from(config.identity.signingKey.reveal(), 'base64url')
    : randomBytes(32);
  const arrayMax = config.tenancy.principalContextArrayMax;
  const work = config.work ?? DEFAULT_WORK_SETTINGS;
  const vault =
    config.identity.vault === 'dev-database' && config.identity.devVaultKey
      ? createVault(config.identity)
      : null;
  if (!vault) throw new Error('Secret vault is required for integrations');
  // 6C: the live Google Calendar adapter exists only when a deployment configures its client.
  const calendar = config.calendar;
  const calendarProvider =
    deps.calendarProvider !== undefined
      ? deps.calendarProvider
      : calendar?.provider === 'google'
        ? new GoogleCalendarProvider({
            clientId: calendar.clientId,
            clientSecret: () => calendar.clientSecret.reveal(),
            redirectUri: calendar.redirectUri,
            authorizeUrl: calendar.authorizeUrl,
            tokenUrl: calendar.tokenUrl,
            revokeUrl: calendar.revokeUrl,
            apiBase: calendar.apiBase,
            timeoutMs: calendar.timeoutMs,
          })
        : null;
  // 7A: the AI transport exists only when a deployment configures it (production refuses it).
  const ai = config.ai;
  const aiProvider =
    deps.aiProvider !== undefined
      ? deps.aiProvider
      : ai && ai.provider.provider !== 'none'
        ? new MessagesProvider({
            baseUrl: ai.provider.baseUrl,
            timeoutMs: ai.provider.timeoutMs,
            maxTextChars: 40_000,
          })
        : null;
  return new AiGatewayService({
    ...(ai
      ? {
          ai: {
            config: ai,
            provider: aiProvider,
            // 10A owns commercial entitlements: deny in deployed modes until it supplies a provider.
            entitlements: {
              aiAllowed: async () => config.env === 'local' || config.env === 'test',
            },
          },
        }
      : {}),
    calendarProvider,
    portabilityEntitlements: {
      auditExportAllowed: async () => config.env === 'local' || config.env === 'test',
    },
    vault,
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
      .register(goalOwnerHook)
      .register(insightsOwnerHook)
      .register(connectionOwnerHook)
      .register(webhookOwnerHook)
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
      'document.live': { limit: work.liveRatePerMinute, windowMs: 60_000 },
      'search.member': { limit: work.searchRatePerMinute, windowMs: 60_000 },
      'goal.checkin': { limit: work.goalCheckinRatePerMinute, windowMs: 60_000 },
      'metrics.member': { limit: work.metricsRatePerMinute, windowMs: 60_000 },
      'report.export': { limit: work.reportExportRatePerMinute, windowMs: 60_000 },
      'integration.member': { limit: work.syncRatePerMinute, windowMs: 60_000 },
      'api.read': { limit: work.apiReadRatePerMinute, windowMs: 60_000 },
      'api.write': { limit: work.apiWriteRatePerMinute, windowMs: 60_000 },
      'api.export': { limit: work.apiExportRatePerMinute, windowMs: 60_000 },
      'webhook.inbound': { limit: work.apiWriteRatePerMinute, windowMs: 60_000 },
      'mcp.read': { limit: work.mcpReadRatePerMinute, windowMs: 60_000 },
      'mcp.write': { limit: work.mcpWriteRatePerMinute, windowMs: 60_000 },
    }),
    signingKey,
    metrics: deps.metrics,
    logger: deps.logger,
  });
}
