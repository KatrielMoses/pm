import { errorFields, type Logger, type Metrics } from '@pm/observability';
import type { PlatformDiscovery, TenantDatabase } from '@pm/db';
import type { JobHandler, RecurringJob } from '@pm/platform';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from '../validation.ts';
import type { DeliveryDeps, ReportService } from './report-service.ts';

export const REPORT_QUEUE = 'default';
export const REPORT_JOB_KINDS = { deliver: 'insights.deliver' } as const;

/** Every minute: scheduled reports due, and delivery records past retention. */
export const REPORT_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: REPORT_JOB_KINDS.deliver,
    queue: REPORT_QUEUE,
    intervalMs: 60_000,
    maxAttempts: 3,
    timeoutSeconds: 240,
  },
];

export interface ReportJobDeps extends DeliveryDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  /** The service that renders as each recipient (the same one the API uses). */
  service: Pick<ReportService, 'runReportSweep'>;
  metrics: Metrics;
  logger: Logger;
  settings?: WorkSettings;
}

/**
 * The scheduled-delivery sweep (ADR-0031 D12). Discovery is payload-free (workspace identifiers);
 * each workspace is swept in its own transactions. A failing workspace never holds up the others,
 * and a repeated or overlapping sweep changes nothing (the occurrence is a unique key).
 */
export function reportDeliveryHandler(d: ReportJobDeps): JobHandler {
  const s = d.settings ?? DEFAULT_WORK_SETTINGS;
  return {
    kind: REPORT_JOB_KINDS.deliver,
    queue: REPORT_QUEUE,
    maxAttempts: 3,
    timeoutMs: 240_000,
    async handle() {
      const now = new Date();
      const retentionBefore = new Date(now.getTime() - s.reportRunRetentionDays * 86_400_000);
      const workspaces = await d.discovery.discoverReportWork(now, retentionBefore, 100);
      for (const ws of workspaces) {
        try {
          await d.service.runReportSweep(d.tenant, ws, now, { email: d.email, origin: d.origin });
        } catch (err) {
          d.logger.warn('insights.sweep_failed', errorFields(err));
          d.metrics.count('insights.jobs', 1, { kind: 'sweep', outcome: 'failed' });
        }
      }
    },
  };
}
