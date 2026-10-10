import type { PlatformDiscovery, TenantDatabase } from '@pm/db';
import type { RetentionPolicy } from '@pm/lifecycle';
import type { Metrics } from '@pm/observability';
import type { JobHandler, RecurringJob } from '@pm/platform';
import { cleanupWorkspaceViews } from './personal-data.ts';

export const VIEWS_JOB_KINDS = { cleanup: 'views.cleanup' } as const;

/** Hourly: personal navigation rows are hints, so cleanup latency only affects storage. */
export const VIEWS_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: VIEWS_JOB_KINDS.cleanup,
    queue: 'maintenance',
    intervalMs: 60 * 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
];

export interface ViewsCleanupDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  retention: RetentionPolicy;
  metrics: Metrics;
}

/**
 * Views cleanup (1E): discovers workspaces through the payload-free dispatcher function, then
 * cleans each in its own workspace transaction (RLS-scoped): expired per-device view state, and
 * personal navigation rows of members removed longer ago than the R-PERSONAL period. With that
 * period undecided (null) departed members' rows are kept (OD-39).
 */
export function viewsCleanupHandler(d: ViewsCleanupDeps): JobHandler {
  return {
    kind: VIEWS_JOB_KINDS.cleanup,
    queue: 'maintenance',
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle() {
      const period = d.retention.platformPeriodMs('R-PERSONAL');
      const departedBefore = period === null ? null : new Date(Date.now() - period);
      const workspaces = await d.discovery.discoverViewsCleanup(departedBefore, 200);
      for (const workspaceId of workspaces)
        await d.tenant.withWorkspace(workspaceId, { module: 'views' }, (tx) =>
          cleanupWorkspaceViews(tx, d.metrics, { departedBefore }),
        );
    },
  };
}
