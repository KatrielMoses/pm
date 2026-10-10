import type { WorkspaceTransaction } from '@pm/db';
import type { InternalEventType } from '@pm/contracts';
import type { JobHandler, OutboxConsumer, RecurringJob } from '@pm/platform';
import type { Logger, Metrics } from '@pm/observability';
import { errorFields } from '@pm/observability';
import type { PlatformDiscovery, TenantDatabase } from '@pm/db';
import { PUBLIC_WEBHOOKS } from './semantics.ts';
import type { PublicApiService } from './public-api-service.ts';
import type { IntegrationService } from './service.ts';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from '../validation.ts';

export const INTEGRATION_QUEUE = 'default';
export const INTEGRATION_JOB_KINDS = {
  sync: 'integrations.sync',
  deliver: 'integrations.webhook.deliver',
} as const;

/** Every minute: due sync deliveries and sync history past retention. */
export const INTEGRATION_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: INTEGRATION_JOB_KINDS.sync,
    queue: INTEGRATION_QUEUE,
    intervalMs: 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
  {
    kind: INTEGRATION_JOB_KINDS.deliver,
    queue: INTEGRATION_QUEUE,
    intervalMs: 15_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
];

const EVENT_TYPES = Object.keys(PUBLIC_WEBHOOKS) as InternalEventType[];

/** Turns public-webhook facts into pending deliveries inside the outbox transaction. */
export class WebhookProjector implements OutboxConsumer {
  readonly name = 'integrations.webhooks';
  readonly eventTypes = EVENT_TYPES;
  readonly #service: Pick<PublicApiService, 'projectWebhook'>;
  constructor(service: Pick<PublicApiService, 'projectWebhook'>) {
    this.#service = service;
  }
  handle(
    tx: WorkspaceTransaction,
    event: Parameters<PublicApiService['projectWebhook']>[1],
  ): Promise<void> {
    return this.#service.projectWebhook(tx, event).then(() => undefined);
  }
}

export interface IntegrationJobDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  service: Pick<IntegrationService, 'runSyncSweep'> & Pick<PublicApiService, 'runWebhookSweep'>;
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

export function webhookDeliveryHandler(d: IntegrationJobDeps): JobHandler {
  const s = d.settings ?? DEFAULT_WORK_SETTINGS;
  return {
    kind: INTEGRATION_JOB_KINDS.deliver,
    queue: INTEGRATION_QUEUE,
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle() {
      const now = new Date();
      const retentionBefore = new Date(now.getTime() - s.webhookDeliveryRetentionDays * 86_400_000);
      const workspaces = await d.discovery.discoverWebhookWork(now, retentionBefore, 100);
      for (const ws of workspaces) {
        try {
          await d.service.runWebhookSweep(d.tenant, ws, now);
        } catch (err) {
          d.logger.warn('webhook.sweep_failed', errorFields(err));
          d.metrics.count('webhook.deliveries', 1, {
            outcome: 'sweep_failed',
            status_class: 'error',
          });
        }
      }
    },
  };
}
