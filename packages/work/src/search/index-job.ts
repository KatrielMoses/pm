import {
  sql,
  type PlatformDiscovery,
  type TenantDatabase,
  type WorkspaceTransaction,
} from '@pm/db';
import { errorFields, type Logger, type Metrics } from '@pm/observability';
import type { JobHandler, RecurringJob } from '@pm/platform';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from '../validation.ts';
import { backoffSeconds } from './semantics.ts';
import { defaultSearchSources, SourceContentError, type SearchSourceRegistry } from './sources.ts';

export const SEARCH_JOB_KINDS = { index: 'search.index' } as const;
export const SEARCH_QUEUE = 'default';

/** Every ten seconds: queued keys are indexed, and recent searches past retention are removed (5A). */
export const SEARCH_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: SEARCH_JOB_KINDS.index,
    queue: SEARCH_QUEUE,
    intervalMs: 10_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
];

export interface SearchJobDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  metrics: Metrics;
  logger: Logger;
  settings?: WorkSettings;
  /** The registered sources (default: the 5A registrations). */
  sources?: SearchSourceRegistry;
}

export type FailureCode = 'source_error' | 'invalid_content' | 'timeout' | 'unknown_source';

interface Claimed {
  source_kind: string;
  source_id: string;
  attempts: number;
}

type ItemResult =
  { outcome: 'empty' } | { outcome: 'indexed' | 'removed' | 'failed' | 'retry'; kind: string };

export interface IndexRunResult {
  indexed: number;
  removed: number;
  /** Items whose allowed attempts are used up (shown as failed until a slow retry succeeds). */
  failed: number;
  /** Items that failed this run and wait for their next attempt. */
  retried: number;
}

function classify(err: unknown): FailureCode {
  if (err instanceof SourceContentError) return 'invalid_content';
  const code = (err as { code?: string } | null)?.code;
  if (code === '57014') return 'timeout';
  return 'source_error';
}

/**
 * One indexing step for one workspace: claim the oldest due key (`SKIP LOCKED`, so workers never
 * collide), rebuild that source row's entry from the source of truth (or remove it when the row is
 * gone, deleted, or purged), and drop the key. The load and the write run under a savepoint: a
 * failure rolls back only the attempt, and the key stays with its attempt count, a short code (never
 * the message), and the next attempt time. Used-up attempts mark it `failed`, which search reports
 * to everyone who can see the record, and which is retried slowly until it succeeds. A change that
 * lands while a row is being indexed re-queues its key behind the claim, so it is indexed again.
 */
async function indexOne(
  tx: WorkspaceTransaction,
  d: Required<Pick<SearchJobDeps, 'sources' | 'logger'>> & { settings: WorkSettings },
  now: Date,
): Promise<ItemResult> {
  const ws = tx.workspaceId;
  const claimed = (
    await sql<Claimed>`SELECT source_kind, source_id, attempts FROM search.index_status
        WHERE workspace_id = ${ws} AND next_attempt_at <= ${now}
        ORDER BY next_attempt_at, requested_at, source_id
        LIMIT 1 FOR UPDATE SKIP LOCKED`.execute(tx.db)
  ).rows[0];
  if (!claimed) return { outcome: 'empty' };
  const source = d.sources.get(claimed.source_kind);
  let failure: FailureCode | null = null;
  let outcome: 'indexed' | 'removed' = 'indexed';
  if (!source) failure = 'unknown_source';
  else {
    await sql`SAVEPOINT search_item`.execute(tx.db);
    try {
      const doc = await source.load(tx, claimed.source_id, {
        bodyMax: d.settings.searchBodyMaxChars,
      });
      if (!doc) {
        await sql`DELETE FROM search.search_document WHERE workspace_id = ${ws}
            AND source_kind = ${claimed.source_kind} AND source_id = ${claimed.source_id}`.execute(
          tx.db,
        );
        outcome = 'removed';
      } else {
        await sql`INSERT INTO search.search_document (workspace_id, source_kind, source_id, auth_record_id,
              context_record_id, title, body, owner_membership_id, source_updated_at, indexed_at)
            VALUES (${ws}, ${claimed.source_kind}, ${claimed.source_id}, ${doc.authRecordId},
              ${doc.contextRecordId}, ${doc.title}, ${doc.body}, ${doc.ownerMembershipId},
              ${doc.updatedAt}, now())
            ON CONFLICT (workspace_id, source_kind, source_id) DO UPDATE SET
              auth_record_id = EXCLUDED.auth_record_id, context_record_id = EXCLUDED.context_record_id,
              title = EXCLUDED.title, body = EXCLUDED.body,
              owner_membership_id = EXCLUDED.owner_membership_id,
              source_updated_at = EXCLUDED.source_updated_at, indexed_at = now()`.execute(tx.db);
      }
      await sql`RELEASE SAVEPOINT search_item`.execute(tx.db);
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT search_item`.execute(tx.db);
      d.logger.warn('search.index_failed', {
        record_type: claimed.source_kind,
        ...errorFields(err),
      });
      failure = classify(err);
    }
  }
  if (!failure) {
    await sql`DELETE FROM search.index_status WHERE workspace_id = ${ws}
        AND source_kind = ${claimed.source_kind} AND source_id = ${claimed.source_id}`.execute(
      tx.db,
    );
    return { outcome, kind: claimed.source_kind };
  }
  const attempts = claimed.attempts + 1;
  const exhausted = attempts >= d.settings.searchIndexMaxAttempts;
  const waitSeconds = exhausted
    ? d.settings.searchFailedRetryMinutes * 60
    : backoffSeconds(attempts, d.settings.searchIndexBackoffSeconds);
  await sql`UPDATE search.index_status
      SET attempts = ${attempts}, state = ${exhausted ? 'failed' : 'pending'},
          failure_code = ${failure}, last_attempt_at = ${now},
          next_attempt_at = ${new Date(now.getTime() + waitSeconds * 1000)}
      WHERE workspace_id = ${ws} AND source_kind = ${claimed.source_kind}
        AND source_id = ${claimed.source_id}`.execute(tx.db);
  return { outcome: exhausted ? 'failed' : 'retry', kind: claimed.source_kind };
}

/**
 * Indexes up to `SEARCH_INDEX_BATCH_MAX` due keys of one workspace, one transaction per key (so a
 * poison row never blocks or rolls back the others), and reports what happened.
 */
export async function indexWorkspace(
  d: SearchJobDeps,
  workspaceId: string,
  now: Date = new Date(),
): Promise<IndexRunResult> {
  const settings = d.settings ?? DEFAULT_WORK_SETTINGS;
  const deps = { sources: d.sources ?? defaultSearchSources(), logger: d.logger, settings };
  const result: IndexRunResult = { indexed: 0, removed: 0, failed: 0, retried: 0 };
  for (let i = 0; i < settings.searchIndexBatchMax; i++) {
    const r = await d.tenant.withWorkspace(workspaceId, { module: 'search' }, (tx) =>
      indexOne(tx, deps, now),
    );
    if (r.outcome === 'empty') break;
    d.metrics.count('search.index.jobs', 1, { kind: r.kind, outcome: r.outcome });
    if (r.outcome === 'indexed') result.indexed++;
    else if (r.outcome === 'removed') result.removed++;
    else if (r.outcome === 'failed') result.failed++;
    else result.retried++;
  }
  return result;
}

/** Recent searches older than `SEARCH_RECENT_RETENTION_DAYS` (bounded per run). */
export async function sweepRecentSearches(
  d: SearchJobDeps,
  workspaceId: string,
  now: Date = new Date(),
): Promise<number> {
  const settings = d.settings ?? DEFAULT_WORK_SETTINGS;
  const before = new Date(now.getTime() - settings.searchRecentRetentionDays * 86_400_000);
  return d.tenant.withWorkspace(workspaceId, { module: 'search' }, async (tx) => {
    const r = await sql`DELETE FROM search.recent_search WHERE id IN (
        SELECT id FROM search.recent_search WHERE workspace_id = ${workspaceId} AND searched_at < ${before}
         ORDER BY searched_at LIMIT ${settings.searchIndexBatchMax})`.execute(tx.db);
    return Number(r.numAffectedRows ?? 0);
  });
}

/**
 * The indexing job: discovers workspaces with due keys (ids only, payload-free), then indexes each
 * under that workspace's own isolation. Work beyond a batch stays queued for the next run.
 */
export function searchIndexHandler(d: SearchJobDeps): JobHandler {
  const settings = d.settings ?? DEFAULT_WORK_SETTINGS;
  return {
    kind: SEARCH_JOB_KINDS.index,
    queue: SEARCH_QUEUE,
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle() {
      const now = new Date();
      const retentionBefore = new Date(
        now.getTime() - settings.searchRecentRetentionDays * 86_400_000,
      );
      const workspaces = await d.discovery.discoverSearchWork(
        now,
        retentionBefore,
        settings.searchIndexDiscoveryMax,
      );
      for (const ws of workspaces) {
        try {
          await indexWorkspace(d, ws, now);
          const swept = await sweepRecentSearches(d, ws, now);
          if (swept)
            d.metrics.count('search.index.jobs', swept, { kind: 'recent', outcome: 'swept' });
        } catch (err) {
          // One workspace failing never stops the others; its keys keep their place in the queue.
          d.logger.error('search.workspace_failed', errorFields(err));
          d.metrics.count('search.index.jobs', 1, { kind: 'workspace', outcome: 'error' });
        }
      }
    },
  };
}
