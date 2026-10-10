import { errorFields, type Logger, type Metrics } from '@pm/observability';
import type { PlatformDiscovery, TenantDatabase } from '@pm/db';
import type { JobHandler, RecurringJob } from '@pm/platform';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from '../validation.ts';
import type { IntegrationService } from './service.ts';

export const INTEGRATION_QUEUE = 'default';
export const INTEGRATION_JOB_KINDS = { sync: 'integrations.sync' } as const;

/** Every minute: due sync deliveries and sync history past retention. */
export const INTEGRATION_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: INTEGRATION_JOB_KINDS.sync,
    queue: INTEGRATION_QUEUE,
    intervalMs: 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
];

export interface IntegrationJobDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  service: Pick<IntegrationService, 'runSyncSweep'>;
  metrics: Metrics;
  logger: Logger;
  settings?: WorkSettings;
}

export function integrationSyncHandler(d: IntegrationJobDeps): JobHandler {
  const s = d.settings ?? DEFAULT_WORK_SETTINGS;
  return {
    kind: INTEGRATION_JOB_KINDS.sync,
    queue: INTEGRATION_QUEUE,
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle() {
      const now = new Date();
      const retentionBefore = new Date(now.getTime() - s.syncHistoryRetentionDays * 86_400_000);
      const workspaces = await d.discovery.discoverIntegrationWork(now, retentionBefore, 100);
      for (const ws of workspaces) {
        try {
          await d.service.runSyncSweep(d.tenant, ws, now);
          d.metrics.count('integrations.jobs', 1, { kind: 'sync', outcome: 'ok' });
        } catch (err) {
          d.logger.warn('integrations.sweep_failed', errorFields(err));
          d.metrics.count('integrations.jobs', 1, { kind: 'sync', outcome: 'failed' });
        }
      }
    },
  };
}
