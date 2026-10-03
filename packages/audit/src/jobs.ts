import type {
  PlatformDatabase,
  PlatformDiscovery,
  TenantDatabase,
  WorkspaceTransaction,
} from '@pm/db';
import type { Logger, Metrics } from '@pm/observability';
import { enqueueJob, type JobHandler, type RecurringJob } from '@pm/platform';
import { drainSecurityEventBuffer, verifySecurityEventBuffer } from './buffer-drain.ts';
import { verifyAuditChain } from './chain.ts';

export interface AuditJobDeps {
  tenant: TenantDatabase;
  platform: PlatformDatabase;
  discovery: PlatformDiscovery;
  metrics: Metrics;
  logger: Logger;
}

export const AUDIT_JOB_KINDS = {
  chainVerify: 'audit.chain_verify',
  chainVerifyFanout: 'audit.chain_verify_fanout',
  bufferDrain: 'security_events.buffer_drain',
} as const;

/** Per-workspace chain verification (records a checkpoint when clean). */
export function chainVerifyHandler(d: AuditJobDeps): JobHandler {
  return {
    kind: AUDIT_JOB_KINDS.chainVerify,
    queue: 'maintenance',
    maxAttempts: 3,
    timeoutMs: 300_000,
    async handle(ctx) {
      const result = await ctx.step('verify', async (tx) => {
        const r = await verifyAuditChain(tx as WorkspaceTransaction);
        return { checked: r.checked, problems: r.problems.map((p) => p.kind) };
      });
      d.metrics.count('audit.chain.verifications', 1, {
        outcome: result.problems.length ? 'problems' : 'ok',
      });
      for (const kind of result.problems) d.metrics.count('audit.chain.problems', 1, { kind });
      if (result.problems.length) {
        // Alert-worthy; chain positions only, never values.
        d.logger.error('audit.chain_problems', {
          component: 'audit',
          workspace_id: ctx.job.workspaceId ?? undefined,
          count: result.problems.length,
          problem: [...new Set(result.problems)].join(','),
        });
        return { state: 'partial', result: { problems: result.problems.length } };
      }
      return { state: 'succeeded' };
    },
  };
}

/** Platform job: enqueue one verification per workspace with audit history. */
export function chainVerifyFanoutHandler(d: AuditJobDeps): JobHandler {
  return {
    kind: AUDIT_JOB_KINDS.chainVerifyFanout,
    queue: 'maintenance',
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle(ctx) {
      let after: string | null = null;
      for (;;) {
        const page = await d.discovery.discoverAuditWorkspaces(after, 200);
        for (const ws of page) {
          await d.tenant.withWorkspace(ws, { module: 'audit' }, (tx) =>
            enqueueJob(tx, {
              queue: 'maintenance',
              kind: AUDIT_JOB_KINDS.chainVerify,
              context: { ...ctx.context, workspaceId: ws },
              dedupeKey: AUDIT_JOB_KINDS.chainVerify,
              maxAttempts: 3,
              timeoutSeconds: 300,
            }),
          );
        }
        if (page.length < 200) break;
        after = page[page.length - 1]!;
      }
    },
  };
}

/** Platform job: drain the 1B buffer, then verify once nothing remains. */
export function bufferDrainHandler(d: AuditJobDeps): JobHandler {
  return {
    kind: AUDIT_JOB_KINDS.bufferDrain,
    queue: 'maintenance',
    maxAttempts: 5,
    timeoutMs: 300_000,
    async handle() {
      const drained = await drainSecurityEventBuffer(d, { batchSize: 500, maxBatches: 200 });
      if (drained.remaining === 0) await verifySecurityEventBuffer(d);
    },
  };
}

export function auditJobHandlers(d: AuditJobDeps): JobHandler[] {
  return [chainVerifyHandler(d), chainVerifyFanoutHandler(d), bufferDrainHandler(d)];
}

export const AUDIT_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: AUDIT_JOB_KINDS.chainVerifyFanout,
    queue: 'maintenance',
    intervalMs: 60 * 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
  {
    kind: AUDIT_JOB_KINDS.bufferDrain,
    queue: 'maintenance',
    intervalMs: 15 * 60_000,
    maxAttempts: 5,
    timeoutSeconds: 300,
  },
];
