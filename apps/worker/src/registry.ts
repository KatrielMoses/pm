import type { JobHandler, OutboxConsumer, RecurringJob } from '@pm/platform';
import type { Metrics } from '@pm/observability';
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
  NotificationFanOut,
  NOTIFY_SCHEDULES,
  notifyDispatchHandler,
  type NotifyJobDeps,
  DEFAULT_WORK_SETTINGS,
  type WorkSettings,
  remindersHandler,
  PLANNING_SCHEDULES,
  blockSeriesHandler,
  dayCloseHandler,
  TIME_SCHEDULES,
  timerGuardHandler,
  WORK_SCHEDULES,
  type RecurrenceJobDeps,
  FILE_SCHEDULES,
  fileScanHandler,
  fileSweepHandler,
  type FileJobDeps,
} from '@pm/work';

/**
 * Job handlers, outbox consumers, and recurring jobs registered by product modules.
 * 1B: identity mail delivery and retention sweeps (platform-scoped).
 * 1F: audit chain verification, the 1B security-event buffer drain, activity projection, durable
 * purge, the retention purge scheduler, and the (disabled until decided) tombstone sweep.
 * 1E: views cleanup (expired per-device view state, departed members' personal navigation).
 * 2A: recurring project generation (bounded catch-up, owner authority rechecked per series).
 * 2D: recurring task generation (same job) and personal task reminders (deduplicated firing).
 * 3D: the timer guard (runaway timers stop at TIME_TIMER_MAX_HOURS, once).
 * 3C: day close (records for ended days) and recurring work blocks.
 * 4B: the notification fan-out consumer and the dispatcher (deliveries, digests, deadlines, retention).
 * 4E: the malware scan of uploads (fail closed) and the file sweep (expired uploads, object deletion).
 */
export interface WorkerModules {
  identity: IdentityJobDeps;
  audit: AuditJobDeps;
  lifecycle: { executor: PurgeExecutor; scheduler: SchedulerDeps };
  views: ViewsCleanupDeps;
  work: RecurrenceJobDeps;
  notify: NotifyJobDeps;
  files: FileJobDeps;
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
    timerGuardHandler(m.work),
    dayCloseHandler(m.work),
    blockSeriesHandler(m.work),
    notifyDispatchHandler(m.notify),
    fileScanHandler(m.files),
    fileSweepHandler(m.files),
  ];
}

export function registeredConsumers(
  settings: WorkSettings = DEFAULT_WORK_SETTINGS,
  deps: { arrayMax: number; metrics?: Metrics } = { arrayMax: 10_000 },
): OutboxConsumer[] {
  return [
    new ActivityProjector(),
    new NotificationFanOut(
      {
        notifyFanoutRecipientsMax: settings.notifyFanoutRecipientsMax,
        notifyDedupeWindowMinutes: settings.notifyDedupeWindowMinutes,
        notifyEmailPerHourMax: settings.notifyEmailPerHourMax,
        notifyFactsMaxBytes: settings.notifyFactsMaxBytes,
        principalContextArrayMax: deps.arrayMax,
      },
      deps.metrics,
    ),
  ];
}

export function registeredSchedules(): RecurringJob[] {
  return [
    ...IDENTITY_SCHEDULES,
    ...AUDIT_SCHEDULES,
    ...LIFECYCLE_SCHEDULES,
    ...VIEWS_SCHEDULES,
    ...WORK_SCHEDULES,
    ...TIME_SCHEDULES,
    ...PLANNING_SCHEDULES,
    ...NOTIFY_SCHEDULES,
    ...FILE_SCHEDULES,
  ];
}
