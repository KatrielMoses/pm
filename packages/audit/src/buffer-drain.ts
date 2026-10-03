import { createHash } from 'node:crypto';
import { newUuidV7 } from '@pm/contracts';
import type { PlatformDatabase, ScopedTransaction, TenantDatabase } from '@pm/db';
import type { Logger, Metrics } from '@pm/observability';
import { sql } from '@pm/db';

/**
 * ADR-0008 Phase 1F handoff: lossless migration of `identity.security_event_buffer` into
 * `audit.security_event`.
 *
 * 1. Writers are cut over first: identity writes to `audit.security_event` (AuditSecurityEventSink);
 *    processes still running old code may keep appending to the buffer during a rolling deploy.
 * 2. `drainSecurityEventBuffer` copies rows that are not yet in the sink, keyed by their original
 *    id and occurred_at, in bounded (occurred_at, id)-ordered batches, one transaction per batch.
 *    An interrupted drain resumes from what is missing; re-running adds nothing.
 * 3. `verifySecurityEventBuffer` compares total and per-day counts and a SHA-256 over the
 *    canonical copied fields (ordered by id) under one snapshot, and appends the result to
 *    `audit.buffer_verification`. Any mismatch blocks retirement.
 * 4. The buffer table and its INSERT grants are removed only by a later contract migration, after
 *    a verified result that still matches the buffer (`bufferRetirementReady`).
 */

export interface DrainResult {
  copied: number;
  remaining: number;
  batches: number;
}

export interface BufferVerification {
  outcome: 'verified' | 'mismatch';
  bufferCount: number;
  sinkCount: number;
  bufferDigest: string;
  sinkDigest: string;
  perDay: Array<{ day: string; buffer: number; sink: number }>;
}

/** Canonical text of one copied row; identical expression for buffer and sink. */
const CANONICAL = (alias: string) =>
  sql.raw(`concat_ws('|',
    ${alias}.id::text,
    to_char(${alias}.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    ${alias}.category, ${alias}.action, ${alias}.outcome, ${alias}.actor_type::text,
    coalesce(${alias}.actor_id::text, '\\N'), coalesce(${alias}.subject_type, '\\N'),
    coalesce(${alias}.subject_id::text, '\\N'), coalesce(${alias}.workspace_id::text, '\\N'),
    coalesce(${alias}.network_prefix, '\\N'), coalesce(${alias}.user_agent_family, '\\N'),
    ${alias}.correlation_id::text, ${alias}.retention_class)`);

const COLUMNS =
  sql.raw(`id, occurred_at, category, action, outcome, actor_type, actor_id, subject_type,
  subject_id, workspace_id, network_prefix, user_agent_family, correlation_id, retention_class`);

async function copyBatch(tx: ScopedTransaction, limit: number): Promise<number> {
  const scope =
    tx.workspaceId === null ? sql`b.workspace_id IS NULL` : sql`b.workspace_id = ${tx.workspaceId}`;
  const r = await sql<{ id: string }>`
    WITH batch AS (
      SELECT ${COLUMNS} FROM identity.security_event_buffer b
      WHERE ${scope}
        AND NOT EXISTS (SELECT 1 FROM audit.security_event s WHERE s.id = b.id)
      ORDER BY b.occurred_at, b.id
      LIMIT ${limit}
    )
    INSERT INTO audit.security_event (${COLUMNS})
    SELECT ${COLUMNS} FROM batch
    ON CONFLICT DO NOTHING
    RETURNING id`.execute(tx.db);
  return r.rows.length;
}

async function remainingIn(tx: ScopedTransaction): Promise<number> {
  const scope =
    tx.workspaceId === null ? sql`b.workspace_id IS NULL` : sql`b.workspace_id = ${tx.workspaceId}`;
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM identity.security_event_buffer b
    WHERE ${scope} AND NOT EXISTS (SELECT 1 FROM audit.security_event s WHERE s.id = b.id)`.execute(
    tx.db,
  );
  return r.rows[0]!.n;
}

export interface DrainDeps {
  platform: PlatformDatabase;
  tenant: TenantDatabase;
  metrics: Metrics;
  logger: Logger;
}

/** Workspaces that own buffered rows (1B writes none, but tenant rows drain in tenant context). */
async function bufferedWorkspaces(d: DrainDeps): Promise<string[]> {
  return d.platform.withPlatform({ module: 'audit', readOnly: true }, async (tx) => {
    const r = await sql<{ workspace_id: string }>`
      SELECT DISTINCT workspace_id FROM identity.security_event_buffer
      WHERE workspace_id IS NOT NULL ORDER BY workspace_id`.execute(tx.db);
    return r.rows.map((x) => x.workspace_id);
  });
}

/**
 * Copies missing buffer rows in bounded batches. `onBatch` (tests) runs after each committed
 * batch; throwing there simulates an interruption between batches.
 */
export async function drainSecurityEventBuffer(
  d: DrainDeps,
  options: { batchSize?: number; maxBatches?: number; onBatch?: (copied: number) => void } = {},
): Promise<DrainResult> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 500, 1), 5000);
  const maxBatches = options.maxBatches ?? 1000;
  let copied = 0;
  let batches = 0;
  const scopes: Array<string | null> = [null, ...(await bufferedWorkspaces(d))];
  for (const ws of scopes) {
    for (;;) {
      if (batches >= maxBatches) break;
      const n =
        ws === null
          ? await d.platform.withPlatform({ module: 'audit' }, (tx) => copyBatch(tx, batchSize))
          : await d.tenant.withWorkspace(ws, { module: 'audit' }, (tx) => copyBatch(tx, batchSize));
      if (n === 0) break;
      batches += 1;
      copied += n;
      d.metrics.count('security_events.buffer_drained', n);
      options.onBatch?.(n);
    }
  }
  let remaining = 0;
  for (const ws of scopes) {
    remaining +=
      ws === null
        ? await d.platform.withPlatform({ module: 'audit', readOnly: true }, remainingIn)
        : await d.tenant.withWorkspace(ws, { module: 'audit', readOnly: true }, remainingIn);
  }
  d.metrics.gauge('security_events.buffer_remaining', remaining);
  d.logger.info('security_events.buffer_drain', { component: 'audit', count: copied, remaining });
  return { copied, remaining, batches };
}

interface ScopeMeasure {
  bufferCount: number;
  sinkCount: number;
  bufferAgg: string;
  sinkAgg: string;
  perDay: Map<string, { buffer: number; sink: number }>;
}

/** One scope under one snapshot: counts, per-day counts, and canonical aggregates. */
async function measure(tx: ScopedTransaction): Promise<ScopeMeasure> {
  const scope =
    tx.workspaceId === null ? sql`workspace_id IS NULL` : sql`workspace_id = ${tx.workspaceId}`;
  const buf = await sql<{ n: number; agg: string | null }>`
    SELECT count(*)::int AS n, encode(sha256(convert_to(coalesce(string_agg(${CANONICAL('b')}, E'\\n' ORDER BY b.id), ''), 'UTF8')), 'hex') AS agg
    FROM identity.security_event_buffer b WHERE b.${scope}`.execute(tx.db);
  const snk = await sql<{ n: number; agg: string | null }>`
    SELECT count(*)::int AS n, encode(sha256(convert_to(coalesce(string_agg(${CANONICAL('s')}, E'\\n' ORDER BY s.id), ''), 'UTF8')), 'hex') AS agg
    FROM audit.security_event s
    WHERE s.id IN (SELECT b.id FROM identity.security_event_buffer b WHERE b.${scope})`.execute(
    tx.db,
  );
  const days = await sql<{ day: string; buffer: number; sink: number }>`
    SELECT d.day, coalesce(b.n, 0)::int AS buffer, coalesce(s.n, 0)::int AS sink
    FROM (
      SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM identity.security_event_buffer WHERE ${scope}
      UNION
      SELECT to_char(s.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM audit.security_event s
      WHERE s.id IN (SELECT id FROM identity.security_event_buffer WHERE ${scope})
    ) d
    LEFT JOIN (SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS n
               FROM identity.security_event_buffer WHERE ${scope} GROUP BY 1) b ON b.day = d.day
    LEFT JOIN (SELECT to_char(s.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS n
               FROM audit.security_event s
               WHERE s.id IN (SELECT id FROM identity.security_event_buffer WHERE ${scope}) GROUP BY 1) s ON s.day = d.day
    ORDER BY d.day`.execute(tx.db);
  return {
    bufferCount: buf.rows[0]!.n,
    sinkCount: snk.rows[0]!.n,
    bufferAgg: buf.rows[0]!.agg ?? '',
    sinkAgg: snk.rows[0]!.agg ?? '',
    perDay: new Map(days.rows.map((r) => [r.day, { buffer: r.buffer, sink: r.sink }])),
  };
}

function combine(parts: ScopeMeasure[], side: 'bufferAgg' | 'sinkAgg'): string {
  const h = parts.map((p) => p[side]).join(':');
  return `sha256:${createSha256(h)}`;
}

function createSha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Verifies buffer vs sink and appends the result to audit.buffer_verification. */
export async function verifySecurityEventBuffer(d: DrainDeps): Promise<BufferVerification> {
  const parts: ScopeMeasure[] = [];
  parts.push(
    await d.platform.withPlatform(
      { module: 'audit', readOnly: true, isolation: 'repeatable read' },
      measure,
    ),
  );
  for (const ws of await bufferedWorkspaces(d)) {
    parts.push(
      await d.tenant.withWorkspace(
        ws,
        { module: 'audit', readOnly: true, isolation: 'repeatable read' },
        measure,
      ),
    );
  }
  const perDay = new Map<string, { buffer: number; sink: number }>();
  for (const p of parts)
    for (const [day, v] of p.perDay) {
      const cur = perDay.get(day) ?? { buffer: 0, sink: 0 };
      perDay.set(day, { buffer: cur.buffer + v.buffer, sink: cur.sink + v.sink });
    }
  const result: BufferVerification = {
    bufferCount: parts.reduce((a, p) => a + p.bufferCount, 0),
    sinkCount: parts.reduce((a, p) => a + p.sinkCount, 0),
    bufferDigest: combine(parts, 'bufferAgg'),
    sinkDigest: combine(parts, 'sinkAgg'),
    perDay: [...perDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, v]) => ({ day, ...v })),
    outcome: 'mismatch',
  };
  const daysMatch = result.perDay.every((x) => x.buffer === x.sink);
  result.outcome =
    result.bufferCount === result.sinkCount &&
    result.bufferDigest === result.sinkDigest &&
    daysMatch
      ? 'verified'
      : 'mismatch';
  await d.platform.withPlatform({ module: 'audit' }, (tx) =>
    tx.db
      .insertInto('audit.buffer_verification')
      .values({
        id: newUuidV7(),
        outcome: result.outcome,
        buffer_count: result.bufferCount,
        sink_count: result.sinkCount,
        buffer_digest: result.bufferDigest,
        sink_digest: result.sinkDigest,
        per_day: JSON.stringify(result.perDay),
      })
      .execute(),
  );
  d.metrics.count('security_events.buffer_verifications', 1, { outcome: result.outcome });
  d.logger.info('security_events.buffer_verified', {
    component: 'audit',
    outcome: result.outcome,
    count: result.bufferCount,
  });
  return result;
}

/**
 * Retirement precondition for the later contract migration: the latest verification is
 * `verified` and still describes the buffer (no rows appended since).
 */
export async function bufferRetirementReady(d: DrainDeps): Promise<boolean> {
  return d.platform.withPlatform({ module: 'audit', readOnly: true }, async (tx) => {
    const latest = await tx.db
      .selectFrom('audit.buffer_verification')
      .select(['outcome', 'buffer_count'])
      .orderBy('verified_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const now = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM identity.security_event_buffer`.execute(tx.db);
    return latest?.outcome === 'verified' && Number(latest.buffer_count) === now.rows[0]!.n;
  });
}
