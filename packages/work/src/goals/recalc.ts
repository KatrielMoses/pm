import { createHash } from 'node:crypto';
import { AuditWriter, change, CommandContext } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import { systemExec } from '../notify/system.ts';
import { todayIn } from '../task-core.ts';
import { metricPercent, periodState, rollup, updateState, type GoalBasisKey } from './semantics.ts';

export interface RecalcSettings {
  goalUpdateStaleDays: number;
  goalsRecalcIntervalMinutes: number;
}

export interface RecalcOutcome {
  /** The goal was not active, so only its recheck time moved. */
  skipped: boolean;
  /** A computed check-in was appended. */
  appended: boolean;
  /** The update just became stale. */
  becameStale: boolean;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

function ownPercent(r: {
  baseline: number | null;
  target: number | null;
  current: number | null;
  latest: number | null;
}): number | null {
  return r.target !== null
    ? metricPercent({ baseline: r.baseline, target: r.target, current: r.current })
    : r.latest;
}

/**
 * Recomputes one goal's viewer-neutral derived state (ADR-0028 G3, G11): whether its update is
 * fresh or stale, which side of its period it is on, and, for a goal whose progress is the
 * rollup of manual key results, the rollup itself, appended to the append-only history as a
 * `computed` check-in only when its inputs changed (the inputs hash makes a repeat the same row).
 * A goal that depends on linked work stores no number, because that number would differ by viewer.
 * Idempotent: running it again with the same inputs changes nothing but the recheck time.
 */
export async function recalcGoal(
  tx: WorkspaceTransaction,
  writer: AuditWriter,
  goalId: string,
  settings: RecalcSettings,
  now: Date,
): Promise<RecalcOutcome> {
  // The goal's state row is the lock: a command that changes the goal marks it dirty through the same
  // row, so a change that lands while this runs waits, then marks the state dirty again (never lost).
  await sql`INSERT INTO goals.goal_state (workspace_id, goal_id) VALUES (${tx.workspaceId}, ${goalId})
            ON CONFLICT (workspace_id, goal_id) DO NOTHING`.execute(tx.db);
  await sql`SELECT 1 FROM goals.goal_state WHERE workspace_id = ${tx.workspaceId} AND goal_id = ${goalId}
            FOR UPDATE`.execute(tx.db);
  const g = (
    await sql<{
      public_id: string;
      brand_id: string | null;
      lifecycle_state: string;
      status: string;
      progress_basis: GoalBasisKey;
      period_start: string;
      period_end: string;
      baseline_value: string | null;
      target_value: string | null;
      current_value: string | null;
      latest_percent: string | null;
      latest_checkin_id: string | null;
      latest_checkin_at: Date | null;
    }>`SELECT r.public_id, g.brand_id, g.lifecycle_state, g.status, g.progress_basis,
              g.period_start::text AS period_start, g.period_end::text AS period_end,
              g.baseline_value::text AS baseline_value, g.target_value::text AS target_value,
              g.current_value::text AS current_value, g.latest_percent::text AS latest_percent,
              g.latest_checkin_id, g.latest_checkin_at
         FROM goals.goal g JOIN core.record r ON r.workspace_id = g.workspace_id AND r.id = g.id
        WHERE g.workspace_id = ${tx.workspaceId} AND g.id = ${goalId}`.execute(tx.db)
  ).rows[0];
  const next = new Date(now.getTime() + settings.goalsRecalcIntervalMinutes * 60_000);
  if (!g) return { skipped: true, appended: false, becameStale: false };
  if (g.lifecycle_state !== 'active') {
    await sql`UPDATE goals.goal_state SET dirty = false, next_check_at = ${next}, claimed_until = NULL,
                attempts = 0, last_error = NULL WHERE workspace_id = ${tx.workspaceId} AND goal_id = ${goalId}`.execute(
      tx.db,
    );
    return { skipped: true, appended: false, becameStale: false };
  }
  const prev = (
    await sql<{ update_state: string; inputs_hash: string | null }>`
      SELECT update_state, inputs_hash FROM goals.goal_state
       WHERE workspace_id = ${tx.workspaceId} AND goal_id = ${goalId}`.execute(tx.db)
  ).rows[0];
  const ws = (
    await sql<{
      timezone: string;
    }>`SELECT timezone FROM tenancy.workspace WHERE id = ${tx.workspaceId}`.execute(tx.db)
  ).rows[0]!;
  const today = todayIn(ws.timezone);
  const update = updateState(
    g.latest_checkin_at ? new Date(g.latest_checkin_at) : null,
    now,
    settings.goalUpdateStaleDays,
  );
  const period = periodState(today, { start: g.period_start, end: g.period_end });

  let basis: 'manual' | 'key_results' | 'viewer_dependent';
  let percent: number | null = null;
  let hash: string | null = null;
  if (g.progress_basis === 'manual') {
    basis = 'manual';
    percent = ownPercent({
      baseline: num(g.baseline_value),
      target: num(g.target_value),
      current: num(g.current_value),
      latest: num(g.latest_percent),
    });
  } else if (g.progress_basis === 'linked_work') {
    basis = 'viewer_dependent';
  } else {
    const krs = (
      await sql<{
        id: string;
        progress_basis: 'manual' | 'linked_work';
        baseline_value: string | null;
        target_value: string | null;
        current_value: string | null;
        latest_percent: string | null;
        latest_checkin_id: string | null;
      }>`SELECT id, progress_basis, baseline_value::text AS baseline_value, target_value::text AS target_value,
                current_value::text AS current_value, latest_percent::text AS latest_percent, latest_checkin_id
           FROM goals.key_result WHERE workspace_id = ${tx.workspaceId} AND goal_id = ${goalId}
            AND lifecycle_state = 'active' ORDER BY rank COLLATE "C", id`.execute(tx.db)
    ).rows;
    const r = rollup(
      krs.map((k) => ({
        percent:
          k.progress_basis === 'linked_work'
            ? null
            : ownPercent({
                baseline: num(k.baseline_value),
                target: num(k.target_value),
                current: num(k.current_value),
                latest: num(k.latest_percent),
              }),
        basis: k.progress_basis,
      })),
    );
    if (r.viewerDependent) basis = 'viewer_dependent';
    else {
      basis = 'key_results';
      percent = r.percent;
      hash = `sha256:${createHash('sha256')
        .update(
          JSON.stringify(
            krs.map((k) => [
              k.id,
              k.latest_checkin_id,
              k.baseline_value,
              k.target_value,
              k.current_value,
              k.latest_percent,
            ]),
          ),
        )
        .digest('hex')}`;
    }
  }

  let appended = false;
  if (basis === 'key_results' && percent !== null && hash && hash !== prev?.inputs_hash) {
    const id = newUuidV7();
    const ins = await sql`
      INSERT INTO goals.goal_checkin (id, public_id, workspace_id, goal_id, source, progress_percent, inputs_hash)
      VALUES (${id}, ${newPublicId('gci')}, ${tx.workspaceId}, ${goalId}, 'computed', ${percent}, ${hash})
      ON CONFLICT (workspace_id, goal_id, inputs_hash) WHERE source = 'computed' DO NOTHING`.execute(
      tx.db,
    );
    appended = Number(ins.numAffectedRows ?? 0) > 0;
    if (appended) {
      const exec = systemExec(tx.workspaceId, null);
      await writer.write(
        tx,
        CommandContext.fromExecution(exec, { kind: 'automation' }, { brandId: g.brand_id }),
        {
          action: 'goal.rollup_recorded',
          target: { recordId: goalId, type: 'goal', publicId: g.public_id },
          changes: [
            change.plain('source', null, 'computed'),
            change.plain('progress_percent', null, String(percent)),
          ],
        },
      );
      await writeOutboxEvent(tx, {
        type: 'goals.goal.checkin_recorded',
        aggregate: { type: 'goals.goal_checkin', id, sequence: 0 },
        data: { source: 'computed', confidence: null, has_value: true },
        actor: { type: 'system', id: tx.workspaceId },
        context: exec,
        ...(g.brand_id ? { brandId: g.brand_id } : {}),
      });
    }
  }

  const becameStale = update === 'stale' && prev?.update_state !== 'stale' && g.status === 'active';
  if (becameStale) {
    const days = g.latest_checkin_at
      ? Math.floor((now.getTime() - new Date(g.latest_checkin_at).getTime()) / 86_400_000)
      : 0;
    const exec = systemExec(tx.workspaceId, null);
    await writeOutboxEvent(tx, {
      type: 'goals.goal.update_stale',
      aggregate: { type: 'goals.goal', id: goalId, sequence: 0 },
      data: { days_stale: days },
      actor: { type: 'system', id: tx.workspaceId },
      context: exec,
      ...(g.brand_id ? { brandId: g.brand_id } : {}),
    });
  }

  await sql`
    INSERT INTO goals.goal_state (workspace_id, goal_id, rollup_percent, rollup_basis, inputs_hash, update_state,
                                  period_state, dirty, next_check_at, claimed_until, attempts, last_error, computed_at)
    VALUES (${tx.workspaceId}, ${goalId}, ${percent}, ${basis}, ${hash}, ${update}, ${period}, false, ${next}, NULL, 0, NULL, ${now})
    ON CONFLICT (workspace_id, goal_id) DO UPDATE SET rollup_percent = EXCLUDED.rollup_percent,
      rollup_basis = EXCLUDED.rollup_basis, inputs_hash = EXCLUDED.inputs_hash, update_state = EXCLUDED.update_state,
      period_state = EXCLUDED.period_state, dirty = false, next_check_at = EXCLUDED.next_check_at, claimed_until = NULL,
      attempts = 0, last_error = NULL, computed_at = EXCLUDED.computed_at`.execute(tx.db);
  return { skipped: false, appended, becameStale };
}

/** Marks a goal's derived state out of date; the sweep (or an explicit recalculation) refreshes it. */
export async function markGoalDirty(tx: WorkspaceTransaction, goalId: string): Promise<void> {
  await sql`
    INSERT INTO goals.goal_state (workspace_id, goal_id, dirty, next_check_at)
    VALUES (${tx.workspaceId}, ${goalId}, true, now())
    ON CONFLICT (workspace_id, goal_id) DO UPDATE SET dirty = true, next_check_at = now(), claimed_until = NULL`.execute(
    tx.db,
  );
}
