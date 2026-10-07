import { AuditWriter, change, CommandContext } from '@pm/audit';
import { newUuidV7, type ExecutionContext } from '@pm/contracts';
import {
  sql,
  type PlatformDiscovery,
  type TenantDatabase,
  type WorkspaceTransaction,
} from '@pm/db';
import type { Logger, Metrics } from '@pm/observability';
import { writeOutboxEvent, type JobHandler, type RecurringJob } from '@pm/platform';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from '../validation.ts';
import { secondsBetween } from './semantics.ts';

export const TIME_JOB_KINDS = { timerGuard: 'time.timer_guard' } as const;

/** Every five minutes: timers that reached TIME_TIMER_MAX_HOURS are stopped (3D). */
export const TIME_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: TIME_JOB_KINDS.timerGuard,
    queue: 'default',
    intervalMs: 5 * 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
];

export interface TimerGuardDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  metrics: Metrics;
  logger: Logger;
  settings?: WorkSettings;
}

/** The worker acts for the timer's owner (a scheduled, delegated system action). */
function systemExec(workspaceId: string, membershipId: string): ExecutionContext {
  return {
    workspaceId,
    correlationId: newUuidV7().replace(/-/g, ''),
    authenticatedPrincipal: { type: 'system_job', id: membershipId },
    effectivePrincipal: { type: 'member', id: membershipId },
    initiatingMembershipId: membershipId,
    delegationChain: [
      { type: 'member', id: membershipId },
      { type: 'system_job', id: membershipId },
    ],
    epochs: { workspace: 0, principal: 0 },
    dataClassLimit: 'C2',
  } as ExecutionContext;
}

/**
 * The timer guard (ADR-0019 T6). A timer left running is stopped once its total reaches
 * TIME_TIMER_MAX_HOURS, at exactly that total (never later), and marked `auto_stopped` so the person
 * can review it. Discovery is payload-free and bounded (TIME_RUNAWAY_DISCOVERY_MAX workspaces,
 * TIME_RUNAWAY_BATCH_MAX timers each, oldest first, rows another run holds are skipped). Each stop
 * is the one-way running → stopped change under the person's lock, so a retried or concurrent run
 * never stops a timer twice; a timer the person stopped or paused meanwhile is left alone.
 */
export function timerGuardHandler(d: TimerGuardDeps): JobHandler {
  const settings = d.settings ?? DEFAULT_WORK_SETTINGS;
  const writer = new AuditWriter({ module: 'work', logger: d.logger, metrics: d.metrics });
  return {
    kind: TIME_JOB_KINDS.timerGuard,
    queue: 'default',
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle() {
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const max = settings.timeTimerMaxHours * 3600;
      const workspaces = await d.discovery.discoverRunawayTimers(
        now,
        max,
        settings.timeRunawayDiscoveryMax,
      );
      if (workspaces.length >= settings.timeRunawayDiscoveryMax)
        d.metrics.count('time.timer_guard', 1, { outcome: 'workspace_batch_full' });
      for (const workspaceId of workspaces)
        await d.tenant.withWorkspace(workspaceId, { module: 'work' }, (tx) =>
          stopRunaway(tx, writer, d.metrics, settings, now, max),
        );
    },
  };
}

export async function stopRunaway(
  tx: WorkspaceTransaction,
  writer: AuditWriter,
  metrics: Metrics,
  settings: WorkSettings,
  now: Date,
  max: number,
): Promise<number> {
  // Candidates first, without row locks: each stop then takes the person's lock before its rows,
  // in the same order the API uses, so the guard and a person's own stop never deadlock.
  const due = await tx.db
    .selectFrom('timetrack.time_segment as s')
    .innerJoin('timetrack.time_entry as e', 'e.id', 's.entry_id')
    .select(['e.id', 'e.membership_id'])
    .where('s.ended_at', 'is', null)
    .where('e.state', '=', 'running')
    .orderBy('s.started_at')
    .orderBy('e.id')
    .limit(settings.timeRunawayBatchMax)
    .execute();
  let stopped = 0;
  for (const c of due) {
    await sql`SELECT timetrack.lock_person(${tx.workspaceId}::uuid, ${c.membership_id}::uuid)`.execute(
      tx.db,
    );
    const r = await tx.db
      .selectFrom('timetrack.time_segment as s')
      .innerJoin('timetrack.time_entry as e', 'e.id', 's.entry_id')
      .select([
        'e.id',
        'e.public_id',
        'e.membership_id',
        'e.brand_id',
        'e.billable',
        'e.duration_seconds',
        'e.version',
        's.id as segment_id',
        's.started_at',
      ])
      .where('e.id', '=', c.id)
      .where('s.ended_at', 'is', null)
      .where('e.state', '=', 'running')
      .forUpdate()
      .executeTakeFirst();
    if (!r) continue;
    const closed = Number(r.duration_seconds);
    const start = new Date(r.started_at);
    if (closed + secondsBetween(start, now) < max) continue;
    const end = new Date(start.getTime() + Math.max(max - closed, 0) * 1000);
    const total = closed + secondsBetween(start, end);
    await tx.db
      .updateTable('timetrack.time_segment')
      .set({ ended_at: end })
      .where('id', '=', r.segment_id)
      .execute();
    await tx.db
      .updateTable('timetrack.time_entry')
      .set({
        state: 'stopped',
        ended_at: end,
        duration_seconds: total,
        auto_stopped: true,
        updated_at: now,
        version: Number(r.version) + 1,
      })
      .where('id', '=', r.id)
      .execute();
    const exec = systemExec(tx.workspaceId, r.membership_id);
    await writer.write(
      tx,
      CommandContext.fromExecution(exec, { kind: 'automation' }, { brandId: r.brand_id }),
      {
        action: 'time.timer_auto_stopped',
        target: { recordId: r.id, type: 'time_entry', publicId: r.public_id },
        changes: [
          change.plain('duration_seconds', null, total),
          change.plain('limit_hours', null, settings.timeTimerMaxHours),
        ],
      },
    );
    await writeOutboxEvent(tx, {
      type: 'time.timer.auto_stopped',
      aggregate: { type: 'time.time_entry', id: r.id, sequence: Number(r.version) + 1 },
      data: { duration_seconds: total },
      actor: { type: 'system', id: r.membership_id },
      context: exec,
      brandId: r.brand_id,
    });
    await writeOutboxEvent(tx, {
      type: 'time.time_entry.recorded',
      aggregate: { type: 'time.time_entry', id: r.id, sequence: Number(r.version) + 2 },
      data: { duration_seconds: total, billable: r.billable, source: 'timer' },
      actor: { type: 'system', id: r.membership_id },
      context: exec,
      brandId: r.brand_id,
    });
    metrics.count('time.timer_guard', 1, { outcome: 'stopped' });
    stopped++;
  }
  return stopped;
}
