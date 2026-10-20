import type { PlatformDiscovery } from '@pm/db';
import type { InternalEventType } from '@pm/contracts';
import type { JobHandler, OutboxConsumer, RecurringJob } from '@pm/platform';
import type { Logger, Metrics } from '@pm/observability';
import { errorFields } from '@pm/observability';
import { TRIGGER_EVENT_TYPES } from './definition.ts';
import {
  AUTOMATION_QUEUE,
  AUTOMATION_RUN_JOB,
  AUTOMATION_SWEEP_JOB,
  type AutomationService,
} from './service.ts';

export const AUTOMATION_JOB_KINDS = { run: AUTOMATION_RUN_JOB, sweep: AUTOMATION_SWEEP_JOB } as const;

/** Every minute: due date and schedule triggers (the existing recurring-job scheduler). */
export const AUTOMATION_SCHEDULES: readonly RecurringJob[] = [
  { kind: AUTOMATION_SWEEP_JOB, queue: 'default', intervalMs: 60_000, maxAttempts: 3, timeoutSeconds: 120 },
];

export interface AutomationJobDeps {
  discovery: PlatformDiscovery;
  service: Pick<
    AutomationService,
    'runAutomationJob' | 'runTriggerSweep' | 'consumeTriggerEvent' | 'consumeOperationState'
  >;
  metrics: Metrics;
  logger: Logger;
  /** AUTOMATION_SWEEP_BATCH_MAX: workspaces visited per sweep. */
  sweepWorkspacesMax?: number;
}

/** One run of one automation, a fenced step at a time (ADR-0046 D6). */
export function automationRunHandler(d: AutomationJobDeps): JobHandler {
  return {
    kind: AUTOMATION_RUN_JOB,
    queue: AUTOMATION_QUEUE,
    maxAttempts: 5,
    timeoutMs: 300_000,
    handle: (ctx) => d.service.runAutomationJob(ctx),
  };
}

/** Due date and schedule triggers; each workspace in its own transaction, failures isolated. */
export function automationSweepHandler(d: AutomationJobDeps): JobHandler {
  return {
    kind: AUTOMATION_SWEEP_JOB,
    queue: 'default',
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle() {
      const now = new Date();
      const workspaces = await d.discovery.discoverAutomationDue(now, d.sweepWorkspacesMax ?? 100);
      for (const ws of workspaces) {
        try {
          const n = await d.service.runTriggerSweep(ws, now);
          d.metrics.count('automation.runs', n, { outcome: 'scheduled' });
        } catch (err) {
          d.logger.warn('automation.sweep_failed', errorFields(err));
        }
      }
    },
  };
}

/** Admits runs for committed trigger events (one inbox receipt per event). */
export class AutomationTriggerConsumer implements OutboxConsumer {
  readonly name = 'automation.triggers';
  readonly eventTypes = TRIGGER_EVENT_TYPES as unknown as readonly InternalEventType[];
  readonly #service: AutomationJobDeps['service'];
  constructor(service: AutomationJobDeps['service']) {
    this.#service = service;
  }
  handle: OutboxConsumer['handle'] = (tx, event) => this.#service.consumeTriggerEvent(tx, event);
}

/** Keeps runs, slots, usage, and failure alerts truthful from operation outcomes. */
export class AutomationOutcomeConsumer implements OutboxConsumer {
  readonly name = 'automation.outcomes';
  readonly eventTypes = ['execution.operation.state_changed'] as const satisfies readonly InternalEventType[];
  readonly #service: AutomationJobDeps['service'];
  constructor(service: AutomationJobDeps['service']) {
    this.#service = service;
  }
  handle: OutboxConsumer['handle'] = (tx, event) => this.#service.consumeOperationState(tx, event);
}
