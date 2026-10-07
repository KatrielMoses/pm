import { sql, type PlatformDiscovery, type TenantDatabase } from '@pm/db';
import type { Logger, Metrics } from '@pm/observability';
import type { JobHandler, RecurringJob } from '@pm/platform';
import { localDay, validZone } from '../time/semantics.ts';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from '../validation.ts';
import { generateSeries, writeDailyRecord } from './today-service.ts';

export const PLANNING_JOB_KINDS = {
  dayClose: 'planning.day_close',
  blockSeries: 'planning.block_series',
} as const;

/** Hourly: past days get their record; recurring blocks are generated ahead (3C). */
export const PLANNING_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: PLANNING_JOB_KINDS.dayClose,
    queue: 'default',
    intervalMs: 60 * 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
  {
    kind: PLANNING_JOB_KINDS.blockSeries,
    queue: 'default',
    intervalMs: 60 * 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
];

export interface PlanningJobDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  metrics: Metrics;
  logger: Logger;
  settings?: WorkSettings;
}

/**
 * Day close (ADR-0020 P9). A day that ended in its owner's zone without a shutdown still gets its
 * record: open commitments become done (the task is done) or dropped, and the record is written
 * once (`closed_by = auto`). Discovery is payload-free and bounded (DAY_CLOSE_DISCOVERY_MAX
 * workspaces, DAY_CLOSE_BATCH_MAX person-days each, oldest first); a day that is still today in
 * the owner's zone is left alone; a concurrent shutdown wins through the per-day lock and key.
 */
export function dayCloseHandler(d: PlanningJobDeps): JobHandler {
  const settings = d.settings ?? DEFAULT_WORK_SETTINGS;
  return {
    kind: PLANNING_JOB_KINDS.dayClose,
    queue: 'default',
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle() {
      const now = new Date();
      const before = now.toISOString().slice(0, 10);
      const workspaces = await d.discovery.discoverDaysToClose(
        before,
        settings.dayCloseDiscoveryMax,
      );
      for (const workspaceId of workspaces)
        await d.tenant.withWorkspace(workspaceId, { module: 'work' }, async (tx) => {
          const due = await tx.db
            .selectFrom('planning.today_commitment as c')
            .innerJoin('tenancy.membership as m', 'm.id', 'c.owner_membership_id')
            .innerJoin('identity.account as a', 'a.id', 'm.account_id')
            .select(['c.owner_membership_id', 'c.day', 'a.timezone'])
            .distinct()
            .where('c.day', '<', before)
            .where(({ not, exists, selectFrom }) =>
              not(
                exists(
                  selectFrom('planning.daily_record as r')
                    .select('r.id')
                    .whereRef('r.owner_membership_id', '=', 'c.owner_membership_id')
                    .whereRef('r.day', '=', 'c.day'),
                ),
              ),
            )
            .orderBy('c.day')
            .orderBy('c.owner_membership_id')
            .limit(settings.dayCloseBatchMax)
            .execute();
          const ws = await tx.db
            .selectFrom('tenancy.workspace')
            .select('timezone')
            .where('id', '=', tx.workspaceId)
            .executeTakeFirstOrThrow();
          for (const r of due) {
            const tz = validZone(r.timezone) ?? ws.timezone;
            const day = String(r.day).slice(0, 10);
            if (day >= localDay(now, tz)) continue;
            await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`planning.day:${tx.workspaceId}:${r.owner_membership_id}:${day}`}, 0))`.execute(
              tx.db,
            );
            const exists = await tx.db
              .selectFrom('planning.daily_record')
              .select('id')
              .where('owner_membership_id', '=', r.owner_membership_id)
              .where('day', '=', day)
              .executeTakeFirst();
            if (exists) continue;
            await writeDailyRecord(tx, r.owner_membership_id, day, tz, 'auto');
            d.metrics.count('planning.day_close', 1, { outcome: 'closed' });
          }
        });
    },
  };
}

/** Recurring blocks (CAL-005): active series are generated through BLOCK_SERIES_HORIZON_DAYS. */
export function blockSeriesHandler(d: PlanningJobDeps): JobHandler {
  const settings = d.settings ?? DEFAULT_WORK_SETTINGS;
  return {
    kind: PLANNING_JOB_KINDS.blockSeries,
    queue: 'default',
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle() {
      const now = new Date();
      // Discovery compares in UTC; each series then generates in its own zone (a day of slack).
      const through = new Date(now.getTime() + (settings.blockSeriesHorizonDays - 1) * 86_400_000)
        .toISOString()
        .slice(0, 16);
      const workspaces = await d.discovery.discoverBlockSeriesDue(
        through,
        settings.dayCloseDiscoveryMax,
      );
      for (const workspaceId of workspaces)
        await d.tenant.withWorkspace(workspaceId, { module: 'work' }, async (tx) => {
          const series = await tx.db
            .selectFrom('planning.block_series')
            .select('id')
            .where('state', '=', 'active')
            .orderBy('generated_through')
            .limit(settings.dayCloseBatchMax)
            .execute();
          for (const s of series) {
            const out = await generateSeries(tx, s.id, now, settings.blockSeriesHorizonDays);
            if (out.created)
              d.metrics.count('planning.block_series', out.created, { outcome: 'generated' });
            if (out.skipped)
              d.metrics.count('planning.block_series', out.skipped, { outcome: 'skipped' });
          }
        });
    },
  };
}
