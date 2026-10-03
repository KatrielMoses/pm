import type { JobHandler, OutboxConsumer, RecurringJob } from '@pm/platform';
import { IDENTITY_SCHEDULES, identityJobHandlers, type IdentityJobDeps } from '@pm/identity';

/**
 * Job handlers, outbox consumers, and recurring platform jobs registered by product modules.
 * 1B: identity mail delivery and retention sweeps (platform-scoped, workspace-free).
 */
export function registeredHandlers(identity: IdentityJobDeps): JobHandler[] {
  return [...identityJobHandlers(identity)];
}

export function registeredConsumers(): OutboxConsumer[] {
  return [];
}

export function registeredSchedules(): RecurringJob[] {
  return [...IDENTITY_SCHEDULES];
}
