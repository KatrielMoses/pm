import type { PlatformDiscovery, TenantDatabase } from '@pm/db';
import type { JobHandler, RecurringJob } from '@pm/platform';
import type { Logger, Metrics } from '@pm/observability';
import { errorFields } from '@pm/observability';
import { AI_DISPATCH_JOB, type AiGatewayService } from './ai-gateway-service.ts';

export const AI_JOB_KINDS = {
  dispatch: AI_DISPATCH_JOB,
  retention: 'ai.history.retention',
} as const;

/**
 * Hourly: AI content past the technical retention setting. The sweep does nothing while
 * AI_HISTORY_RETENTION_DAYS is unset (OD-36 undecided: content is kept).
 */
export const AI_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: AI_JOB_KINDS.retention,
    queue: 'default',
    intervalMs: 60 * 60_000,
    maxAttempts: 3,
    timeoutSeconds: 300,
  },
];

export interface AiJobDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  service: Pick<AiGatewayService, 'runAiDispatch' | 'eraseAiContent' | 'aiHistoryRetentionDays'>;
  metrics: Metrics;
  logger: Logger;
  /** Job attempt cap for a dispatch (AI_MAX_ATTEMPTS). */
  maxAttempts: number;
  timeoutMs: number;
}

/** One provider attempt of an `ai_action` operation (bounded attempts, never an unsafe resend). */
export function aiDispatchHandler(d: AiJobDeps): JobHandler {
  return {
    kind: AI_JOB_KINDS.dispatch,
    queue: 'default',
    maxAttempts: d.maxAttempts,
    timeoutMs: d.timeoutMs,
    handle: (ctx) => d.service.runAiDispatch(ctx),
  };
}

export function aiRetentionHandler(d: AiJobDeps): JobHandler {
  return {
    kind: AI_JOB_KINDS.retention,
    queue: 'default',
    maxAttempts: 3,
    timeoutMs: 300_000,
    async handle() {
      const days = d.service.aiHistoryRetentionDays();
      if (days === null) return;
      const before = new Date(Date.now() - days * 86_400_000);
      const workspaces = await d.discovery.discoverAiRetentionWork(before, 100);
      for (const ws of workspaces) {
        try {
          const erased = await d.tenant.withWorkspace(ws, { module: 'work' }, (tx) =>
            d.service.eraseAiContent(tx, { before }),
          );
          d.metrics.count('ai.history.erased', erased, { reason: 'retention' });
        } catch (err) {
          d.logger.warn('ai.retention_failed', errorFields(err));
        }
      }
    },
  };
}
