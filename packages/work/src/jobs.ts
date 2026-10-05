import { AuditWriter, change, CommandContext } from '@pm/audit';
import type { ExecutionContext } from '@pm/contracts';
import {
  sql,
  type PlatformDiscovery,
  type TenantDatabase,
  type WorkspaceTransaction,
} from '@pm/db';
import type { Logger, Metrics } from '@pm/observability';
import type { JobHandler, RecurringJob } from '@pm/platform';
import { compilePrincipal, decideBrand, principalFreshness } from '@pm/tenancy';
import { newUuidV7 } from '@pm/contracts';
import { generateOccurrences } from './structures.ts';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from './validation.ts';

export const WORK_JOB_KINDS = { recurrence: 'work.recurrence' } as const;

/** Every five minutes: recurring projects are created close to their scheduled local time. */
export const WORK_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: WORK_JOB_KINDS.recurrence,
    queue: 'default',
    intervalMs: 5 * 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
];

export interface RecurrenceJobDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  metrics: Metrics;
  logger: Logger;
  settings?: WorkSettings;
}

/**
 * Recurrence generation (OD-14). Discovers due workspaces through the payload-free dispatcher
 * function, then per workspace (RLS-scoped) and per due series, before each consequential step:
 * the series owner is re-read and must still be an active internal member who may create records in
 * the brand (principal freshness, 0C §13.5). A series whose owner lost authority is paused (audited)
 * instead of generating. Three registered bounds apply at distinct layers:
 * RECURRENCE_WORKSPACE_DISCOVERY_MAX workspaces per run, RECURRENCE_SERIES_DISCOVERY_MAX due series
 * per workspace, and RECURRENCE_CATCHUP_MAX occurrences per series. Both discovery layers take the
 * oldest-waiting work first (`last_run_at`, stamped on every run), so work beyond a batch stays
 * eligible and is reached in a bounded number of runs. Duplicate keys are skipped, so retries never
 * create a second project for an occurrence.
 */
export function recurrenceHandler(d: RecurrenceJobDeps): JobHandler {
  const settings = d.settings ?? DEFAULT_WORK_SETTINGS;
  const writer = new AuditWriter({ module: 'work', logger: d.logger, metrics: d.metrics });
  return {
    kind: WORK_JOB_KINDS.recurrence,
    queue: 'default',
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle() {
      const now = new Date();
      const workspaces = await d.discovery.discoverRecurrenceDue(
        now,
        settings.recurrenceWorkspaceDiscoveryMax,
      );
      if (workspaces.length >= settings.recurrenceWorkspaceDiscoveryMax)
        d.metrics.count('work.recurrence.occurrences', 1, { outcome: 'workspace_batch_full' });
      for (const workspaceId of workspaces) {
        const due = await d.tenant.withWorkspace(
          workspaceId,
          { module: 'work', readOnly: true },
          (tx) =>
            tx.db
              .selectFrom('planning.recurrence_series')
              .select('id')
              .where('state', '=', 'active')
              .where('next_due_at', '<=', now)
              .orderBy('last_run_at')
              .orderBy('id')
              .limit(settings.recurrenceSeriesDiscoveryMax)
              .execute(),
        );
        if (due.length >= settings.recurrenceSeriesDiscoveryMax)
          d.metrics.count('work.recurrence.occurrences', 1, { outcome: 'series_batch_full' });
        for (const { id } of due)
          await d.tenant.withWorkspace(workspaceId, { module: 'work' }, (tx) =>
            runSeries(tx, d.metrics, writer, settings, id, now),
          );
      }
    },
  };
}

async function runSeries(
  tx: WorkspaceTransaction,
  metrics: Metrics,
  writer: AuditWriter,
  settings: WorkSettings,
  seriesId: string,
  now: Date,
): Promise<void> {
  const s = await tx.db
    .selectFrom('planning.recurrence_series')
    .selectAll()
    .where('id', '=', seriesId)
    .forUpdate()
    .executeTakeFirst();
  if (!s || s.state !== 'active' || !s.next_due_at || new Date(s.next_due_at) > now) return;
  // Fairness: this series moves to the back of the discovery order (operational, no version).
  await tx.db
    .updateTable('planning.recurrence_series')
    .set({ last_run_at: now })
    .where('id', '=', s.id)
    .execute();
  const owner = await tx.db
    .selectFrom('tenancy.membership')
    .select(['id', 'account_id', 'kind', 'state'])
    .where('id', '=', s.owner_membership_id)
    .executeTakeFirst();
  const exec = systemExec(tx.workspaceId, s.owner_membership_id);
  const fresh =
    owner && owner.kind === 'member'
      ? await principalFreshness(tx, metrics, {
          membershipId: owner.id,
          workspaceEpochAtEnqueue: Number.MAX_SAFE_INTEGER,
          principalEpochAtEnqueue: Number.MAX_SAFE_INTEGER,
          consumer: 'job',
        })
      : 'revoked';
  let allowed = false;
  if (owner && fresh !== 'revoked' && owner.kind === 'member') {
    const p = await compilePrincipal(tx, owner.id, owner.account_id, owner.kind);
    const brand = await tx.db
      .selectFrom('tenancy.brand')
      .select(['id', 'is_sensitive', 'lifecycle_state'])
      .where('id', '=', s.brand_id)
      .executeTakeFirst();
    allowed =
      !!brand &&
      brand.lifecycle_state === 'active' &&
      decideBrand(p, 'record.create', {
        id: brand.id,
        isSensitive: brand.is_sensitive,
        lifecycleState: 'active',
      }).allowed;
  }
  if (!allowed) {
    await tx.db
      .updateTable('planning.recurrence_series')
      .set({
        state: 'paused',
        next_due_at: null,
        updated_at: new Date(),
        version: Number(s.version) + 1,
      })
      .where('id', '=', s.id)
      .execute();
    await writer.write(
      tx,
      CommandContext.fromExecution(exec, { kind: 'automation' }, { brandId: s.brand_id }),
      {
        action: 'recurrence.paused',
        target: { recordId: s.source_record_id, type: 'project', publicId: null },
        changes: [
          change.plain('state', 'active', 'paused'),
          change.plain('reason', null, 'owner_not_authorized'),
        ],
      },
    );
    metrics.count('work.recurrence.occurrences', 1, { outcome: 'paused' });
    return;
  }
  const out = await generateOccurrences(tx, {
    series: s,
    limit: settings.recurrenceCatchupMax,
    due: now,
    depthMax: settings.projectDepthMax,
    maxItems: settings.templateItemsMax,
    context: {
      writer,
      exec,
      source: { kind: 'automation' },
      ownerMembershipId: s.owner_membership_id,
      grantManager: async (t, projectId, membershipId) => {
        await sql`SELECT work.grant_occurrence_manager(${projectId}::uuid, ${membershipId}::uuid, ${newUuidV7()}::uuid)`.execute(
          t.db,
        );
      },
    },
  });
  metrics.count('work.recurrence.occurrences', out.generated.length, { outcome: 'generated' });
  if (out.more) metrics.count('work.recurrence.occurrences', 1, { outcome: 'catchup_deferred' });
}

/** The worker acts for the series owner (delegated, scheduled automation). */
function systemExec(workspaceId: string, ownerMembershipId: string): ExecutionContext {
  const correlationId = newUuidV7().replace(/-/g, '');
  return {
    workspaceId,
    correlationId,
    authenticatedPrincipal: { type: 'system_job', id: ownerMembershipId },
    effectivePrincipal: { type: 'member', id: ownerMembershipId },
    initiatingMembershipId: ownerMembershipId,
    delegationChain: [
      { type: 'member', id: ownerMembershipId },
      { type: 'system_job', id: ownerMembershipId },
    ],
    epochs: { workspace: 0, principal: 0 },
    dataClassLimit: 'C2',
  } as ExecutionContext;
}
