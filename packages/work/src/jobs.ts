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
import {
  compilePrincipal,
  compileVisibility,
  decideBrand,
  decideProject,
  principalFreshness,
  projectChainOf,
  recordLevel,
  type Principal,
} from '@pm/tenancy';
import { newUuidV7 } from '@pm/contracts';
import { writeOutboxEvent } from '@pm/platform';
import { NIL_ID } from './service.ts';
import { generateOccurrences } from './structures.ts';
import { generateTaskOccurrences } from './task-recurrence.ts';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from './validation.ts';

export const WORK_JOB_KINDS = {
  recurrence: 'work.recurrence',
  reminders: 'work.reminders',
} as const;

/**
 * Every five minutes: recurring projects and tasks are created close to their scheduled local
 * time. Every minute: due personal task reminders fire (2D).
 */
export const WORK_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: WORK_JOB_KINDS.recurrence,
    queue: 'default',
    intervalMs: 5 * 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
  {
    kind: WORK_JOB_KINDS.reminders,
    queue: 'default',
    intervalMs: 60_000,
    maxAttempts: 3,
    timeoutSeconds: 60,
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
  let p: Principal | null = null;
  let level: ReturnType<typeof recordLevel> = null;
  if (owner && fresh !== 'revoked' && owner.kind === 'member') {
    p = await compilePrincipal(tx, owner.id, owner.account_id, owner.kind);
    const brand = await tx.db
      .selectFrom('tenancy.brand')
      .select(['id', 'is_sensitive', 'lifecycle_state'])
      .where('id', '=', s.brand_id)
      .executeTakeFirst();
    const facts = brand
      ? { id: brand.id, isSensitive: brand.is_sensitive, lifecycleState: 'active' as const }
      : null;
    // A task series that generates into a project needs record.create on the project chain
    // (restricted projects included); otherwise in the brand (ADR-0016 D1, AZ-24).
    const chain =
      s.target_kind === 'task' && s.project_id
        ? ((await projectChainOf(tx, s.project_id))?.chain ?? null)
        : null;
    allowed =
      !!brand &&
      !!facts &&
      brand.lifecycle_state === 'active' &&
      (s.target_kind === 'task' && s.project_id
        ? !!chain &&
          decideProject(p, 'record.create', { brand: facts, lifecycleState: 'active', chain })
            .allowed
        : decideBrand(p, 'record.create', facts).allowed);
    if (allowed && facts)
      level = recordLevel(p, {
        brand: facts,
        lifecycleState: 'active',
        shareLevel: null,
        projectChain: chain ?? [],
      });
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
        target: { recordId: s.source_record_id, type: s.target_kind, publicId: null },
        changes: [
          change.plain('state', 'active', 'paused'),
          change.plain('reason', null, 'owner_not_authorized'),
        ],
      },
    );
    metrics.count('work.recurrence.occurrences', 1, { outcome: 'paused' });
    return;
  }
  if (s.target_kind === 'task') {
    const out = await generateTaskOccurrences(tx, {
      series: s,
      limit: settings.recurrenceCatchupMax,
      due: now,
      maxItems: settings.templateItemsMax,
      level: level ?? 'view',
      context: { writer, exec, source: { kind: 'automation' }, principal: p! },
    });
    metrics.count('work.recurrence.occurrences', out.generated.length, { outcome: 'generated' });
    if (out.more) metrics.count('work.recurrence.occurrences', 1, { outcome: 'catchup_deferred' });
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

export type RemindersJobDeps = RecurrenceJobDeps;

/**
 * Personal task reminders (TSK-032, ADR-0016 D3). Discovers workspaces with due reminders through
 * the payload-free dispatcher function, then fires at most REMINDER_FIRE_BATCH_MAX per workspace,
 * earliest first, skipping rows another run holds. Before firing, the owner must still be an active
 * member who can read the task; otherwise the reminder is cancelled without notice. A reminder on a
 * task its owner snoozed moves to the snooze's end. Firing is the one-way scheduled → fired change,
 * so a retried run never fires twice; the outbox fact carries identifiers only (channels are 4B).
 */
export function remindersHandler(d: RemindersJobDeps): JobHandler {
  const settings = d.settings ?? DEFAULT_WORK_SETTINGS;
  return {
    kind: WORK_JOB_KINDS.reminders,
    queue: 'default',
    maxAttempts: 3,
    timeoutMs: 60_000,
    async handle() {
      const now = new Date();
      const workspaces = await d.discovery.discoverRemindersDue(now, 1000);
      for (const workspaceId of workspaces)
        await d.tenant.withWorkspace(workspaceId, { module: 'work' }, (tx) =>
          fireDue(tx, d.metrics, settings, now),
        );
    },
  };
}

async function fireDue(
  tx: WorkspaceTransaction,
  metrics: Metrics,
  settings: WorkSettings,
  now: Date,
): Promise<void> {
  const due = await tx.db
    .selectFrom('planning.task_reminder')
    .select(['id', 'owner_membership_id', 'task_id', 'version'])
    .where('state', '=', 'scheduled')
    .where('remind_at', '<=', now)
    .orderBy('remind_at')
    .orderBy('id')
    .limit(settings.reminderFireBatchMax)
    .forUpdate()
    .skipLocked()
    .execute();
  for (const r of due) {
    const owner = await tx.db
      .selectFrom('tenancy.membership')
      .select(['id', 'account_id', 'kind', 'state'])
      .where('id', '=', r.owner_membership_id)
      .executeTakeFirst();
    const task = await tx.db
      .selectFrom('work.task as t')
      .innerJoin('core.record as c', 'c.id', 't.id')
      .innerJoin('tenancy.brand as b', 'b.id', 't.brand_id')
      .select([
        't.id',
        't.brand_id',
        't.project_id',
        'c.lifecycle_state',
        'b.is_sensitive',
        'b.lifecycle_state as brand_state',
      ])
      .where('t.id', '=', r.task_id)
      .executeTakeFirst();
    let readable = false;
    if (owner && owner.state === 'active' && task && task.lifecycle_state === 'active') {
      const p = await compilePrincipal(tx, owner.id, owner.account_id, owner.kind);
      const chain = task.project_id
        ? ((await projectChainOf(tx, task.project_id))?.chain ?? [])
        : [];
      // Share authority uses the same subjects the API compiles (members, teams, brands).
      const vis = await compileVisibility(tx, p, { need: 'view', arrayMax: 10_000 });
      const shares = await tx.db
        .selectFrom('access.record_grant')
        .select('level')
        .where('record_id', '=', task.id)
        .where('state', '=', 'active')
        .where('grantee_key', 'in', vis.ctx.subjects.length ? vis.ctx.subjects : [NIL_ID])
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
        .execute();
      const order = ['read', 'comment', 'edit'];
      const share = shares.sort((x, y) => order.indexOf(y.level) - order.indexOf(x.level))[0];
      readable =
        recordLevel(p, {
          brand: {
            id: task.brand_id,
            isSensitive: task.is_sensitive,
            lifecycleState: task.brand_state as 'active',
          },
          lifecycleState: 'active',
          shareLevel: share?.level ?? null,
          projectChain: chain,
        }) !== null;
    }
    if (!readable) {
      await tx.db
        .updateTable('planning.task_reminder')
        .set({ state: 'cancelled', updated_at: now, version: Number(r.version) + 1 })
        .where('id', '=', r.id)
        .where('state', '=', 'scheduled')
        .execute();
      metrics.count('work.reminders.fired', 1, { outcome: 'cancelled' });
      continue;
    }
    const snooze = await tx.db
      .selectFrom('planning.task_snooze')
      .select('until_at')
      .where('owner_membership_id', '=', r.owner_membership_id)
      .where('task_id', '=', r.task_id)
      .executeTakeFirst();
    if (snooze && new Date(snooze.until_at) > now) {
      const moved = await tx.db
        .updateTable('planning.task_reminder')
        .set({
          remind_at: new Date(snooze.until_at),
          updated_at: now,
          version: Number(r.version) + 1,
        })
        .where('id', '=', r.id)
        .where('state', '=', 'scheduled')
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('planning.task_reminder as o')
                .select('o.id')
                .where('o.owner_membership_id', '=', r.owner_membership_id)
                .where('o.task_id', '=', r.task_id)
                .where('o.remind_at', '=', new Date(snooze.until_at)),
            ),
          ),
        )
        .executeTakeFirst();
      if (!Number(moved.numUpdatedRows))
        await tx.db
          .updateTable('planning.task_reminder')
          .set({ state: 'cancelled', updated_at: now, version: Number(r.version) + 1 })
          .where('id', '=', r.id)
          .where('state', '=', 'scheduled')
          .execute();
      metrics.count('work.reminders.fired', 1, { outcome: 'snoozed' });
      continue;
    }
    const fired = await tx.db
      .updateTable('planning.task_reminder')
      .set({ state: 'fired', fired_at: now, updated_at: now, version: Number(r.version) + 1 })
      .where('id', '=', r.id)
      .where('state', '=', 'scheduled')
      .executeTakeFirst();
    if (!Number(fired.numUpdatedRows)) continue;
    await writeOutboxEvent(tx, {
      type: 'planning.task_reminder.fired',
      aggregate: { type: 'planning.task_reminder', id: r.id, sequence: Number(r.version) + 1 },
      data: { task_id: r.task_id, account_id: owner!.account_id },
      actor: { type: 'system', id: r.owner_membership_id },
      context: systemExec(tx.workspaceId, r.owner_membership_id),
      brandId: task!.brand_id,
    });
    metrics.count('work.reminders.fired', 1, { outcome: 'fired' });
  }
}
