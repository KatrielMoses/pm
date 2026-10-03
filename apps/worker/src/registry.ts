import type { JobHandler, OutboxConsumer, RecurringJob } from '@pm/platform';
import { ActivityProjector, AUDIT_SCHEDULES, auditJobHandlers, type AuditJobDeps } from '@pm/audit';
import { IDENTITY_SCHEDULES, identityJobHandlers, type IdentityJobDeps } from '@pm/identity';
import {
  LIFECYCLE_SCHEDULES,
  purgeJobHandler,
  purgeSchedulerHandler,
  tombstoneSweepHandler,
  type PurgeExecutor,
  type SchedulerDeps,
} from '@pm/lifecycle';

/**
 * Job handlers, outbox consumers, and recurring jobs registered by product modules.
 * 1B: identity mail delivery and retention sweeps (platform-scoped).
 * 1F: audit chain verification, the 1B security-event buffer drain, activity projection, durable
 * purge, the retention purge scheduler, and the (disabled until decided) tombstone sweep.
 */
export interface WorkerModules {
  identity: IdentityJobDeps;
  audit: AuditJobDeps;
  lifecycle: { executor: PurgeExecutor; scheduler: SchedulerDeps };
}

export function registeredHandlers(m: WorkerModules): JobHandler[] {
  return [
    ...identityJobHandlers(m.identity),
    ...auditJobHandlers(m.audit),
    purgeJobHandler(m.lifecycle.executor),
    purgeSchedulerHandler(m.lifecycle.scheduler),
    tombstoneSweepHandler(m.lifecycle.scheduler),
  ];
}

export function registeredConsumers(): OutboxConsumer[] {
  return [new ActivityProjector()];
}

export function registeredSchedules(): RecurringJob[] {
  return [...IDENTITY_SCHEDULES, ...AUDIT_SCHEDULES, ...LIFECYCLE_SCHEDULES];
}
