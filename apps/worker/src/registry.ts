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
import { VIEWS_SCHEDULES, viewsCleanupHandler, type ViewsCleanupDeps } from '@pm/tenancy';
import {
  recurrenceHandler,
  remindersHandler,
  WORK_SCHEDULES,
  type RecurrenceJobDeps,
} from '@pm/work';

/**
 * Job handlers, outbox consumers, and recurring jobs registered by product modules.
 * 1B: identity mail delivery and retention sweeps (platform-scoped).
 * 1F: audit chain verification, the 1B security-event buffer drain, activity projection, durable
 * purge, the retention purge scheduler, and the (disabled until decided) tombstone sweep.
 * 1E: views cleanup (expired per-device view state, departed members' personal navigation).
 * 2A: recurring project generation (bounded catch-up, owner authority rechecked per series).
 * 2D: recurring task generation (same job) and personal task reminders (deduplicated firing).
 */
export interface WorkerModules {
  identity: IdentityJobDeps;
  audit: AuditJobDeps;
  lifecycle: { executor: PurgeExecutor; scheduler: SchedulerDeps };
  views: ViewsCleanupDeps;
  work: RecurrenceJobDeps;
}

export function registeredHandlers(m: WorkerModules): JobHandler[] {
  return [
    ...identityJobHandlers(m.identity),
    ...auditJobHandlers(m.audit),
    purgeJobHandler(m.lifecycle.executor),
    purgeSchedulerHandler(m.lifecycle.scheduler),
    tombstoneSweepHandler(m.lifecycle.scheduler),
    viewsCleanupHandler(m.views),
    recurrenceHandler(m.work),
    remindersHandler(m.work),
  ];
}

export function registeredConsumers(): OutboxConsumer[] {
  return [new ActivityProjector()];
}

export function registeredSchedules(): RecurringJob[] {
  return [
    ...IDENTITY_SCHEDULES,
    ...AUDIT_SCHEDULES,
    ...LIFECYCLE_SCHEDULES,
    ...VIEWS_SCHEDULES,
    ...WORK_SCHEDULES,
  ];
}
