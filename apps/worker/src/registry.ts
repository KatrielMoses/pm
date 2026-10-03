import type { JobHandler, OutboxConsumer } from '@pm/platform';

/**
 * Job handlers and outbox consumers registered by product modules. Phase 1A ships the execution
 * engine only; feature handlers (exports, digests, purge, ...) register here in their own phases.
 */
export function registeredHandlers(): JobHandler[] {
  return [];
}

export function registeredConsumers(): OutboxConsumer[] {
  return [];
}
