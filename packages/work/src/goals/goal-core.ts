import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  brandMarker,
  compileVisibility,
  decideRecord,
  levelRank,
  recordLevel,
  TenancyError,
  type BrandFacts,
  type Level,
  type Principal,
  type ProjectChain,
} from '@pm/tenancy';
import type { ActionKey } from '@pm/contracts';
import { FileService } from '../files/file-service.ts';
import { NIL_ID, toDate } from '../service.ts';
import { isPublic } from '../validation.ts';
import {
  metricPercent,
  periodState,
  rollup,
  updateState,
  workPercent,
  type ConfidenceKey,
  type GoalBasisKey,
  type GoalStatusKey,
  type PeriodKind,
  type PeriodState,
  type UpdateState,
} from './semantics.ts';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
export const num = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

export interface GoalRow {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: 'active' | 'archived' | 'trashed' | 'purged';
  project_id: string | null;
  title: string;
  description: string | null;
  owner_membership_id: string;
  status: GoalStatusKey;
  period_kind: PeriodKind;
  period_start: string;
  period_end: string;
  progress_basis: GoalBasisKey;
  unit: string | null;
  baseline_value: number | null;
  target_value: number | null;
  current_value: number | null;
  latest_percent: number | null;
  latest_checkin_id: string | null;
  latest_checkin_at: Date | null;
  latest_confidence: ConfidenceKey | null;
  created_by_membership_id: string;
  created_at: Date;
  updated_at: Date;
  updated_by_membership_id: string | null;
  version: number;
  public_id: string;
}

export interface KeyResultRow {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: 'active' | 'archived' | 'trashed' | 'purged';
  goal_id: string;
  title: string;
  owner_membership_id: string;
  progress_basis: 'manual' | 'linked_work';
  unit: string | null;
  baseline_value: number | null;
  target_value: number | null;
  current_value: number | null;
  latest_percent: number | null;
  latest_checkin_id: string | null;
  latest_checkin_at: Date | null;
  latest_confidence: ConfidenceKey | null;
  rank: string;
  version: number;
  public_id: string;
}

/** A goal resolved through the one compiled level (placement, project chain, lifecycle). */
export interface LoadedGoal {
  id: string;
  publicId: string;
  brand: (BrandFacts & { publicId: string; name: string; timezone: string }) | null;
  brandMarker: ReturnType<typeof brandMarker> | null;
  chain: ProjectChain;
  projectId: string | null;
  lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
  level: Level;
  row: GoalRow;
}

export interface LinkRow {
  id: string;
  goal_id: string;
  key_result_id: string | null;
  target_kind: 'project' | 'task';
  target_record_id: string;
  target_brand_id: string;
}

/** What a viewer may be told about how a figure was produced (never about hidden work). */
export interface Progress {
  percent: number | null;
  source: 'metric' | 'manual_percent' | 'key_results' | 'linked_work' | 'none';
  /** The rule, in words, so every number can be explained. */
  explanation: string;
  /** Linked-work counts over the readable leaf tasks (OD-13); null for other sources. */
  work: { done: number; total: number } | null;
  /** Key results with a measurement, of all key results; null for other sources. */
  key_results: { counted: number; total: number } | null;
  /** What is missing, so a quiet figure is never mistaken for a complete one. */
  incomplete: Array<
    | 'no_measurement'
    | 'no_target'
    | 'no_key_results'
    | 'no_readable_work'
    | 'unmeasured_key_results'
  >;
}

interface RankPos {
  k: string;
  id: string;
}

/**
 * Phase 5B goals, part one (ADR-0029; 0B ADR-37, 0C AZ-37): resolution, authorization, progress,
 * and views. A goal is authorized through its placement (workspace or brand level and the
 * governing project chain) by the one compiled level; goals are never shareable, so a guest or a
 * share-only reader has no access to any of them. Every figure a viewer receives that depends on
 * linked work is computed for that viewer from the work they may read, and nothing about work
 * they may not read (its existence, count, or progress) is ever included.
 */
export class GoalCore extends FileService {
  readonly #posKey: Buffer;

  constructor(deps: ConstructorParameters<typeof FileService>[0]) {
    super(deps);
    this.#posKey = createHmac('sha256', deps.signingKey).update('cursor:goals.goals').digest();
  }

  protected gTrack<T>(
    kind: 'goals.reads' | 'goals.changes',
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const labels = (outcome: string): Record<string, string> =>
      kind === 'goals.reads' ? { view: label, outcome } : { kind: label, outcome };
    return fn().then(
      (out) => {
        this.d.metrics.count(kind, 1, labels('ok'));
        return out;
      },
      (err) => {
        this.d.metrics.count(kind, 1, labels(err instanceof TenancyError ? err.code : 'error'));
        throw err;
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Cursors over (key, id) positions
  // ---------------------------------------------------------------------------------------------

  protected goalSeal(p: Principal, fp: string, pos: RankPos): string {
    const payload = JSON.stringify(pos);
    const mac = createHmac('sha256', this.#posKey)
      .update(`${p.workspaceId}|${p.membershipId}|${fp}|${payload}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    return Buffer.from(JSON.stringify({ p: payload, m: mac })).toString('base64url');
  }

  protected goalOpen(p: Principal, fp: string, raw: unknown): RankPos {
    try {
      if (typeof raw !== 'string' || raw.length > 2048) throw new Error();
      const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
        p: string;
        m: string;
      };
      const want = createHmac('sha256', this.#posKey)
        .update(`${p.workspaceId}|${p.membershipId}|${fp}|${o.p}`)
        .digest()
        .subarray(0, 16);
      const got = Buffer.from(o.m, 'base64url');
      if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error();
      const pos = JSON.parse(o.p) as RankPos;
      if (typeof pos.k !== 'string' || pos.k.length > 120 || !/^[0-9a-f-]{36}$/.test(pos.id))
        throw new Error();
      return pos;
    } catch {
      throw new TenancyError('cursor_invalid');
    }
  }

  protected goalFp(...parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
  }

  // ---------------------------------------------------------------------------------------------
  // Resolution and authorization
  // ---------------------------------------------------------------------------------------------

  /** Goals and portfolios are for members; a guest never reads one (IA: guests do not see Goals). */
  protected requireMemberKind(p: Principal): void {
    if (p.kind !== 'member') throw new TenancyError('forbidden');
  }

  protected toGoalRow(row: Record<string, unknown> & { public_id: string }): GoalRow {
    const r = row as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      ...(r as unknown as GoalRow),
      period_start: toDate(r.period_start)!,
      period_end: toDate(r.period_end)!,
      baseline_value: num(r.baseline_value),
      target_value: num(r.target_value),
      current_value: num(r.current_value),
      latest_percent: num(r.latest_percent),
      latest_checkin_at: r.latest_checkin_at ? new Date(r.latest_checkin_at) : null,
      created_at: new Date(r.created_at),
      updated_at: new Date(r.updated_at),
      version: Number(r.version),
    };
  }

  /**
   * One goal by public ID through the compiled level. Anything unreadable or unknown is the same
   * `not_found`, and an unknown identifier runs the same statements as a goal the caller cannot
   * read (constant shape).
   */
  protected async loadGoal(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    opts: { lock?: boolean; allowTrashed?: boolean } = {},
  ): Promise<LoadedGoal> {
    const unknown = async (): Promise<never> => {
      await this.brandFactsOf(tx, NIL_ID).catch(() => undefined);
      await this.chainOfProject(tx, null);
      throw new TenancyError('not_found');
    };
    if (!isPublic(publicId, 'goal')) return unknown();
    let q = tx.db
      .selectFrom('core.record as r')
      .innerJoin('goals.goal as g', (j) =>
        j.onRef('g.workspace_id', '=', 'r.workspace_id').onRef('g.id', '=', 'r.id'),
      )
      .selectAll('g')
      .select(['r.public_id'])
      .where('r.public_id', '=', publicId)
      .where('r.record_type', '=', 'goal');
    if (opts.lock) q = q.forUpdate('g');
    const row = await q.executeTakeFirst();
    if (!row) return unknown();
    let brand: LoadedGoal['brand'] = null;
    let marker: LoadedGoal['brandMarker'] = null;
    if (row.brand_id) {
      const b = await this.brandFactsOf(tx, row.brand_id);
      brand = b.facts;
      marker = b.marker;
    } else await this.brandFactsOf(tx, NIL_ID).catch(() => undefined);
    const chain = await this.chainOfProject(tx, row.project_id);
    const trashed = row.lifecycle_state === 'trashed';
    if (trashed && !opts.allowTrashed) throw new TenancyError('not_found');
    const lifecycleState = trashed ? 'active' : row.lifecycle_state;
    const level = recordLevel(p, { brand, lifecycleState, projectChain: chain, shareLevel: null });
    if (level === null || p.kind !== 'member') throw new TenancyError('not_found');
    if (trashed && levelRank(level) < levelRank('edit')) throw new TenancyError('not_found');
    return {
      id: row.id,
      publicId: row.public_id,
      brand,
      brandMarker: marker,
      chain,
      projectId: row.project_id,
      lifecycleState: row.lifecycle_state,
      level,
      row: this.toGoalRow(row as never),
    };
  }

  protected requireGoalAction(
    p: Principal,
    action: ActionKey,
    g: LoadedGoal,
    opts: { lifecycleState?: LoadedGoal['lifecycleState'] } = {},
  ): void {
    const o = decideRecord(p, action, {
      brand: g.brand,
      lifecycleState: opts.lifecycleState ?? g.lifecycleState,
      shareLevel: null,
      projectChain: g.chain,
    });
    this.decision(action, o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  protected goalAllows(p: Principal, action: ActionKey, g: LoadedGoal): boolean {
    try {
      this.requireGoalAction(p, action, g);
      return true;
    } catch (err) {
      if (err instanceof TenancyError) return false;
      throw err;
    }
  }

  protected requireGoalActive(g: LoadedGoal): void {
    if (g.lifecycleState !== 'active')
      throw new TenancyError('conflict', {
        issues: [
          {
            pointer: '/',
            code: 'goal_archived',
            message: 'This goal is archived. Restore it to make changes.',
          },
        ],
      });
  }

  /** The predicate for goals the viewer may read (never through a share). */
  protected async goalVisibility(tx: WorkspaceTransaction, p: Principal, includeArchived: boolean) {
    return compileVisibility(tx, p, {
      need: 'view',
      includeArchived,
      arrayMax: this.c.settings.principalContextArrayMax,
      shares: false,
    });
  }

  /** The predicate for work (projects, tasks) the viewer may read, archived excluded. */
  protected async workVisibility(tx: WorkspaceTransaction, p: Principal) {
    return compileVisibility(tx, p, {
      need: 'view',
      includeArchived: false,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
  }

  protected async brandTimezoneToday(tx: WorkspaceTransaction): Promise<string> {
    return this.workspaceToday(tx);
  }

  // ---------------------------------------------------------------------------------------------
  // People
  // ---------------------------------------------------------------------------------------------

  protected async goalPeople(
    tx: WorkspaceTransaction,
    p: Principal,
    ids: ReadonlyArray<string | null>,
  ): Promise<Map<string, { id: string; name: string; type: 'member' }>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (p.kind !== 'member' || !unique.length) return new Map();
    const rows = await sql<{ id: string; public_id: string; name: string; state: string }>`
      SELECT m.id, m.public_id, m.state, coalesce(m.display_name_override, a.display_name) AS name
        FROM tenancy.membership m JOIN identity.account a ON a.id = m.account_id
       WHERE m.id = ANY(${unique}::uuid[])`.execute(tx.db);
    return new Map(
      rows.rows.map((r) => [
        r.id,
        {
          id: r.public_id,
          name: r.state === 'active' ? r.name : 'Former member',
          type: 'member' as const,
        },
      ]),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Links and linked-work progress (always for this viewer, over what they may read)
  // ---------------------------------------------------------------------------------------------

  protected async linksOf(
    tx: WorkspaceTransaction,
    goalIds: readonly string[],
  ): Promise<LinkRow[]> {
    if (!goalIds.length) return [];
    const rows = await tx.db
      .selectFrom('goals.goal_link')
      .select([
        'id',
        'goal_id',
        'key_result_id',
        'target_kind',
        'target_record_id',
        'target_brand_id',
      ])
      .where('goal_id', 'in', [...goalIds])
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows as LinkRow[];
  }

  /**
   * Done and total readable leaf tasks per owner (a goal or a key result), over the tasks inside
   * each owner's linked projects and under each owner's linked tasks (OD-13). A task the viewer
   * cannot read changes no numerator and no denominator.
   */
  protected async linkedWork(
    tx: WorkspaceTransaction,
    p: Principal,
    owners: ReadonlyArray<{
      key: string;
      links: ReadonlyArray<Pick<LinkRow, 'target_kind' | 'target_record_id'>>;
    }>,
  ): Promise<Map<string, { done: number; total: number }>> {
    const out = new Map<string, { done: number; total: number }>();
    const keys: string[] = [];
    const kinds: string[] = [];
    const targets: string[] = [];
    for (const o of owners)
      for (const l of o.links) {
        keys.push(o.key);
        kinds.push(l.target_kind);
        targets.push(l.target_record_id);
      }
    if (!keys.length) return out;
    const vis = await this.workVisibility(tx, p);
    const rows = await sql<{ owner_key: string; done: string; total: string }>`
      WITH pairs AS (
        SELECT * FROM unnest(${keys}::text[], ${kinds}::text[], ${targets}::uuid[]) AS x(owner_key, kind, target_id)
      ), hits AS (
        SELECT p.owner_key, t.id FROM pairs p JOIN work.task t
          ON t.workspace_id = ${tx.workspaceId} AND p.kind = 'project' AND t.project_id = p.target_id
        UNION
        SELECT p.owner_key, t.id FROM pairs p JOIN work.task t
          ON t.workspace_id = ${tx.workspaceId} AND p.kind = 'task' AND t.id = p.target_id
        UNION
        SELECT p.owner_key, t.id FROM pairs p JOIN work.task t
          ON t.workspace_id = ${tx.workspaceId} AND p.kind = 'task' AND t.ancestor_ids @> ARRAY[p.target_id]
      )
      SELECT h.owner_key,
             count(*) FILTER (WHERE t.status_category = 'done')::text AS done,
             count(*) FILTER (WHERE t.status_category <> 'cancelled')::text AS total
        FROM hits h
        JOIN work.task t ON t.workspace_id = ${tx.workspaceId} AND t.id = h.id
        JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
       WHERE ${vis.where('r', { project: sql`t.project_id` })}
         AND NOT EXISTS (SELECT 1 FROM work.task c JOIN core.record cr ON cr.workspace_id = c.workspace_id AND cr.id = c.id
              WHERE c.workspace_id = t.workspace_id AND c.parent_task_id = t.id
                AND ${vis.where('cr', { project: sql`c.project_id` })})
       GROUP BY h.owner_key`.execute(tx.db);
    for (const r of rows.rows)
      out.set(r.owner_key, { done: Number(r.done), total: Number(r.total) });
    return out;
  }

  /** Metric progress of a goal or key result from its own values, never from work. */
  protected ownPercent(r: {
    baseline_value: number | null;
    target_value: number | null;
    current_value: number | null;
    latest_percent: number | null;
  }): { percent: number | null; source: 'metric' | 'manual_percent' | 'none'; target: boolean } {
    if (r.target_value !== null)
      return {
        percent: metricPercent({
          baseline: r.baseline_value,
          target: r.target_value,
          current: r.current_value,
        }),
        source: 'metric',
        target: true,
      };
    return r.latest_percent !== null
      ? { percent: r.latest_percent, source: 'manual_percent', target: false }
      : { percent: null, source: 'none', target: false };
  }

  /**
   * Progress for each goal and key result, for this viewer. A manual goal is its own measurement; a
   * key-result goal is the plain mean of its key results' measurements; a linked-work goal is the
   * share of readable leaf tasks that are done. Nothing is stored.
   */
  protected async progressOf(
    tx: WorkspaceTransaction,
    p: Principal,
    goals: readonly GoalRow[] & Array<GoalRow & { id: string }>,
    krsByGoal: Map<string, KeyResultRow[]>,
    links: readonly LinkRow[],
  ): Promise<{ goal: Map<string, Progress>; kr: Map<string, Progress> }> {
    const owners: Array<{ key: string; links: LinkRow[] }> = [];
    const goalLinks = new Map<string, LinkRow[]>();
    const krLinks = new Map<string, LinkRow[]>();
    for (const l of links) {
      const m = l.key_result_id ? krLinks : goalLinks;
      const k = l.key_result_id ?? l.goal_id;
      m.set(k, [...(m.get(k) ?? []), l]);
    }
    for (const g of goals) {
      if (g.progress_basis === 'linked_work')
        owners.push({ key: g.id, links: goalLinks.get(g.id) ?? [] });
      for (const kr of krsByGoal.get(g.id) ?? [])
        if (kr.progress_basis === 'linked_work')
          owners.push({ key: kr.id, links: krLinks.get(kr.id) ?? [] });
    }
    const work = await this.linkedWork(tx, p, owners);
    const workProgress = (key: string): Progress => {
      const w = work.get(key);
      const percent = w ? workPercent(w.done, w.total) : null;
      return {
        percent,
        source: 'linked_work',
        explanation:
          'Done tasks as a share of the tasks you can read in the linked projects and tasks (cancelled tasks and tasks you cannot read are not counted).',
        work: w ?? { done: 0, total: 0 },
        key_results: null,
        incomplete: percent === null ? ['no_readable_work'] : [],
      };
    };
    const own = (r: Parameters<GoalCore['ownPercent']>[0]): Progress => {
      const o = this.ownPercent(r);
      return {
        percent: o.percent,
        source: o.source,
        explanation:
          o.source === 'metric'
            ? 'How far the current value has moved from the baseline toward the target.'
            : o.source === 'manual_percent'
              ? 'The percentage in the latest check-in.'
              : 'No measurement has been recorded yet.',
        work: null,
        key_results: null,
        incomplete: o.percent === null ? ['no_measurement'] : [],
      };
    };
    const krProgress = new Map<string, Progress>();
    const goalProgress = new Map<string, Progress>();
    for (const g of goals) {
      const krs = krsByGoal.get(g.id) ?? [];
      for (const kr of krs)
        krProgress.set(kr.id, kr.progress_basis === 'linked_work' ? workProgress(kr.id) : own(kr));
      if (g.progress_basis === 'linked_work') goalProgress.set(g.id, workProgress(g.id));
      else if (g.progress_basis === 'key_results') {
        const r = rollup(
          krs.map((k) => ({ percent: krProgress.get(k.id)!.percent, basis: k.progress_basis })),
        );
        goalProgress.set(g.id, {
          percent: r.percent,
          source: 'key_results',
          explanation:
            'The plain average of the key results that have a measurement. Key results measured by linked work count only the work you can read.',
          work: null,
          key_results: { counted: r.counted, total: r.total },
          incomplete: [
            ...(r.total === 0 ? (['no_key_results'] as const) : []),
            ...(r.total > 0 && r.counted < r.total ? (['unmeasured_key_results'] as const) : []),
          ],
        });
      } else goalProgress.set(g.id, own(g));
    }
    return { goal: goalProgress, kr: krProgress };
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  protected async keyResultsOf(
    tx: WorkspaceTransaction,
    goalIds: readonly string[],
    includeArchived = false,
  ): Promise<Map<string, KeyResultRow[]>> {
    const out = new Map<string, KeyResultRow[]>();
    if (!goalIds.length) return out;
    const rows = await tx.db
      .selectFrom('goals.key_result as k')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'k.workspace_id').onRef('r.id', '=', 'k.id'),
      )
      .selectAll('k')
      .select(['r.public_id'])
      .where('k.goal_id', 'in', [...goalIds])
      .where('k.lifecycle_state', 'in', includeArchived ? ['active', 'archived'] : ['active'])
      .orderBy('k.rank')
      .orderBy('k.id')
      .execute();
    for (const r of rows) {
      const kr = {
        ...(r as unknown as KeyResultRow),
        baseline_value: num(r.baseline_value),
        target_value: num(r.target_value),
        current_value: num(r.current_value),
        latest_percent: num(r.latest_percent),
        latest_checkin_at: r.latest_checkin_at ? new Date(r.latest_checkin_at) : null,
        version: Number(r.version),
      } as KeyResultRow;
      out.set(r.goal_id, [...(out.get(r.goal_id) ?? []), kr]);
    }
    return out;
  }

  protected metricView(r: {
    unit: string | null;
    baseline_value: number | null;
    target_value: number | null;
    current_value: number | null;
  }) {
    return {
      unit: r.unit,
      baseline: r.baseline_value,
      target: r.target_value,
      current: r.current_value,
    };
  }

  protected latestView(
    r: {
      latest_checkin_id: string | null;
      latest_checkin_at: Date | null;
      latest_confidence: ConfidenceKey | null;
    },
    publicIds: Map<string, string>,
  ) {
    return {
      checkin: r.latest_checkin_id ? (publicIds.get(r.latest_checkin_id) ?? null) : null,
      at: iso(r.latest_checkin_at),
      confidence: r.latest_confidence,
    };
  }

  protected async checkinPublicIds(tx: WorkspaceTransaction, ids: ReadonlyArray<string | null>) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map<string, string>();
    const rows = await tx.db
      .selectFrom('goals.goal_checkin')
      .select(['id', 'public_id'])
      .where('id', 'in', unique)
      .execute();
    return new Map(rows.map((r) => [r.id, r.public_id]));
  }

  /**
   * The stored, viewer-neutral derived state of each goal: whether its update is fresh, which
   * side of its period it is on, and whether recalculation is current or failing.
   */
  protected async goalStateOf(tx: WorkspaceTransaction, goalIds: readonly string[]) {
    const out = new Map<
      string,
      {
        update_state: UpdateState;
        period_state: PeriodState;
        dirty: boolean;
        attempts: number;
        last_error: string | null;
        computed_at: Date | null;
      }
    >();
    if (!goalIds.length) return out;
    const rows = await tx.db
      .selectFrom('goals.goal_state')
      .select([
        'goal_id',
        'update_state',
        'period_state',
        'dirty',
        'attempts',
        'last_error',
        'computed_at',
      ])
      .where('goal_id', 'in', [...goalIds])
      .execute();
    for (const r of rows)
      out.set(r.goal_id, {
        update_state: r.update_state,
        period_state: r.period_state,
        dirty: r.dirty,
        attempts: Number(r.attempts),
        last_error: r.last_error,
        computed_at: r.computed_at ? new Date(r.computed_at) : null,
      });
    return out;
  }

  /**
   * Freshness is computed from the goal itself when the stored state lags, so a view never shows
   * a stale flag a recalculation has not yet reached; `recalculation` says whether the stored
   * state (and the computed history) is current, pending, or failing.
   */
  protected freshness(
    g: GoalRow,
    stored: ReturnType<GoalCore['goalStateOf']> extends Promise<Map<string, infer S>>
      ? S | undefined
      : never,
    today: string,
    now: Date,
  ) {
    const update = updateState(g.latest_checkin_at, now, this.ws.goalUpdateStaleDays);
    const period = periodState(today, { start: g.period_start, end: g.period_end });
    const failing =
      !!stored && stored.attempts >= this.ws.goalsRecalcMaxAttempts && !!stored.last_error;
    return {
      update_state: update,
      period_state: period,
      stale_after_days: this.ws.goalUpdateStaleDays,
      recalculation: !stored
        ? { state: 'pending' as const, computed_at: null }
        : failing
          ? { state: 'failing' as const, computed_at: iso(stored.computed_at) }
          : stored.dirty
            ? { state: 'pending' as const, computed_at: iso(stored.computed_at) }
            : { state: 'current' as const, computed_at: iso(stored.computed_at) },
    };
  }

  protected goalScopeView(
    g: LoadedGoal,
    projectName: string | null,
    projectPublicId: string | null,
  ) {
    return g.projectId && g.brandMarker
      ? {
          kind: 'project' as const,
          brand: g.brandMarker,
          project: projectPublicId ? { id: projectPublicId, name: projectName } : null,
        }
      : g.brandMarker
        ? { kind: 'brand' as const, brand: g.brandMarker }
        : { kind: 'workspace' as const };
  }

  protected async projectNames(tx: WorkspaceTransaction, ids: ReadonlyArray<string | null>) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map<string, { id: string; name: string }>();
    const rows = await sql<{ id: string; public_id: string; name: string }>`
      SELECT w.id, r.public_id, w.name FROM work.project w
        JOIN core.record r ON r.workspace_id = w.workspace_id AND r.id = w.id
       WHERE w.id = ANY(${unique}::uuid[])`.execute(tx.db);
    return new Map(rows.rows.map((r) => [r.id, { id: r.public_id, name: r.name }]));
  }

  /** The key-result view (inside a goal's detail). */
  protected keyResultView(
    kr: KeyResultRow,
    progress: Progress,
    people: Map<string, { id: string; name: string; type: 'member' }>,
    checkinIds: Map<string, string>,
  ) {
    return {
      id: kr.public_id,
      type: 'key_result' as const,
      title: kr.title,
      owner: people.get(kr.owner_membership_id) ?? null,
      basis: kr.progress_basis,
      metric: this.metricView(kr),
      progress,
      latest: this.latestView(kr, checkinIds),
      lifecycle_state: kr.lifecycle_state,
      version: kr.version,
    };
  }

  /** Public identifiers of the goals' linked projects and tasks that this viewer may read. */
  protected async readableTargets(
    tx: WorkspaceTransaction,
    p: Principal,
    links: readonly LinkRow[],
  ): Promise<
    Map<
      string,
      {
        id: string;
        type: 'project' | 'task';
        name: string;
        status_category: string;
        brand: unknown;
      }
    >
  > {
    const out = new Map<
      string,
      {
        id: string;
        type: 'project' | 'task';
        name: string;
        status_category: string;
        brand: unknown;
      }
    >();
    const ids = [...new Set(links.map((l) => l.target_record_id))];
    if (!ids.length) return out;
    const vis = await this.workVisibility(tx, p);
    const rows = await sql<{
      id: string;
      public_id: string;
      record_type: 'project' | 'task';
      name: string;
      status_category: string;
      brand_public: string;
      brand_name: string;
      short_name: string | null;
      color: string;
      icon: string;
      brand_state: string;
    }>`
      SELECT r.id, r.public_id, r.record_type, COALESCE(t.title, w.name) AS name,
             COALESCE(t.status_category, w.status_category) AS status_category,
             br.public_id AS brand_public, b.name AS brand_name, b.short_name, b.color, b.icon,
             b.lifecycle_state AS brand_state
        FROM core.record r
        LEFT JOIN work.task t ON t.workspace_id = r.workspace_id AND t.id = r.id AND r.record_type = 'task'
        LEFT JOIN work.project w ON w.workspace_id = r.workspace_id AND w.id = r.id AND r.record_type = 'project'
        JOIN tenancy.brand b ON b.workspace_id = r.workspace_id AND b.id = r.brand_id
        JOIN core.record br ON br.workspace_id = b.workspace_id AND br.id = b.id
       WHERE r.id = ANY(${ids}::uuid[]) AND r.record_type IN ('project', 'task')
         AND ${vis.where('r', { project: sql`COALESCE(t.project_id, w.id)` })}`.execute(tx.db);
    for (const r of rows.rows)
      out.set(r.id, {
        id: r.public_id,
        type: r.record_type,
        name: r.name,
        status_category: r.status_category,
        brand: brandMarker({
          public_id: r.brand_public,
          name: r.brand_name,
          short_name: r.short_name,
          color: r.color,
          icon: r.icon,
          lifecycle_state: r.brand_state as never,
        }),
      });
    return out;
  }

  /**
   * Whether each goal has active work this viewer can read (a planned or active project, or an
   * unfinished task, linked directly or through a key result). Relative to the viewer, and said so.
   */
  protected async activeWorkOf(
    tx: WorkspaceTransaction,
    p: Principal,
    links: readonly LinkRow[],
  ): Promise<Map<string, { visible_links: number; active_links: number }>> {
    const targets = await this.readableTargets(tx, p, links);
    const out = new Map<string, { visible_links: number; active_links: number }>();
    for (const l of links) {
      const t = targets.get(l.target_record_id);
      if (!t) continue;
      const cur = out.get(l.goal_id) ?? { visible_links: 0, active_links: 0 };
      cur.visible_links++;
      const active =
        t.type === 'project'
          ? t.status_category === 'planned' || t.status_category === 'active'
          : t.status_category !== 'done' && t.status_category !== 'cancelled';
      if (active) cur.active_links++;
      out.set(l.goal_id, cur);
    }
    return out;
  }

  protected parseGoalPublic(v: unknown): string {
    if (!isPublic(v, 'goal')) throw new TenancyError('not_found');
    return v;
  }
}
