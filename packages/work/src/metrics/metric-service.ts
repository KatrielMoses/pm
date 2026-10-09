import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql, type RawBuilder, type WorkspaceTransaction } from '@pm/db';
import {
  brandMarker,
  compileVisibility,
  invalid,
  issue,
  readableBrandsByIds,
  TenancyError,
  type Caller,
  type Principal,
} from '@pm/tenancy';
import { evaluateHealth, type HealthInput, type ProjectHealth } from '../goals/semantics.ts';
import { PortfolioService } from '../goals/portfolio-service.ts';
import { csv, parseInstant } from '../time/semantics.ts';
import { isPublic } from '../validation.ts';
import {
  currentVersion,
  definitionDigest,
  findDefinition,
  isMetricId,
  METRIC_DEFINITIONS,
  type MetricDefinition,
  type MetricScopeKind,
} from './definitions.ts';
import {
  addCounts,
  AGE_BANDS,
  ageBand,
  completionCounts,
  completionFigure,
  digestOf,
  distribution,
  eachDay,
  freshnessState,
  isLive,
  localDay,
  percentOf,
  resolveWindow,
  stateOf,
  validZone,
  worstFreshness,
  type CompletionCounts,
  type FreshnessState,
  type Incomplete,
  type LocalWindow,
  type MetricState,
} from './semantics.ts';

const iso = (d: Date | string) => new Date(d).toISOString();
const NIL = '00000000-0000-7000-8000-000000000000';
const DAY_MS = 86_400_000;
/** Projects listed under a project-level metric (the figures above them still cover every project). */
const GROUP_MAX = 50;

type Vis = Awaited<ReturnType<typeof compileVisibility>>;

interface Scope {
  kind: MetricScopeKind;
  brandId: string | null;
  brand: ReturnType<typeof brandMarker> | null;
  projectId: string | null;
  project: { id: string; name: string } | null;
  subprojects: boolean;
  /** The project and its sub-projects (a project scope with sub-projects), else just the project. */
  projectIds: string[];
}

interface Ctx {
  tx: WorkspaceTransaction;
  p: Principal;
  vis: Vis;
  ws: string;
  def: MetricDefinition;
  scope: Scope;
  window: { local: LocalWindow; start: Date; end: Date } | null;
  asOf: Date;
  /** The figure describes now: statuses are read from the tasks, not rebuilt from history. */
  live: boolean;
  tz: string;
  today: string;
  now: Date;
  personId: string | null;
}

interface Computed {
  value: Record<string, unknown>;
  parts?: { numerator: number | null; denominator: number | null };
  incomplete: Incomplete[];
  state?: MetricState;
  empty?: boolean;
  estimated?: boolean;
  groups?: unknown[];
  /** Per drill role: how many records. Filled from the same selection the drill lists. */
  counts?: Record<string, number>;
  ledger?: boolean;
}

interface Params {
  version: number | undefined;
  brand: string | null;
  project: string | null;
  subprojects: boolean;
  from: unknown;
  to: unknown;
  asOf: Date | null;
  person: string | null;
  member: string | null;
  cursor: string | null;
  limit: number | null;
}

export type MetricResult = Awaited<ReturnType<MetricService['getMetric']>>;

/**
 * Phase 5C metrics (ADR-0030). One authority for every number the product reports: a versioned
 * definition (what is counted, from which records, in whose time zone, how fresh, what is missing,
 * who may see it, where it drills to) and one computation that runs for the person asking. Every
 * statement joins each counted record to the record whose access governs it and applies the one
 * compiled visibility predicate (0C 4.5) before anything is counted, grouped, ranked, or timed, so
 * a record the viewer cannot read adds to no figure, label, ranking, freshness, or timing, and a
 * hidden record and an unknown one are the same absence. A figure is computed from the records at
 * the time of the request (never from a stored count), so it always equals the records behind it
 * and its drill-through lists exactly them; the only stored input is the append-only task status
 * history (migration 0043), which is itself read through the same predicate.
 */
export class MetricService extends PortfolioService {
  readonly #cursorKey: Buffer;

  constructor(deps: ConstructorParameters<typeof PortfolioService>[0]) {
    super(deps);
    this.#cursorKey = createHmac('sha256', deps.signingKey)
      .update('cursor:metrics.records')
      .digest();
  }

  // ---------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------

  protected async trackMetric<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const out = await fn();
      this.d.metrics.count('metrics.requests', 1, { op, outcome: 'ok' });
      if (op === 'compute')
        this.d.metrics.record('metrics.query.duration', (Date.now() - started) / 1000, {
          outcome: 'ok',
        });
      return out;
    } catch (err) {
      const outcome = err instanceof TenancyError ? err.code : 'error';
      this.d.metrics.count('metrics.requests', 1, { op, outcome });
      if (op === 'compute')
        this.d.metrics.record('metrics.query.duration', (Date.now() - started) / 1000, { outcome });
      throw err;
    }
  }

  protected async metricsLimit(p: Principal): Promise<void> {
    const r = await this.c.limiter.consume('metrics.member' as never, p.membershipId);
    if (!r.allowed)
      throw new TenancyError('rate_limited', { retryAfterSeconds: r.retryAfterSeconds });
  }

  // ---------------------------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------------------------

  #flag(v: unknown, pointer: string, fallback: boolean): boolean {
    if (v === undefined) return fallback;
    if (v === true || v === 'true' || v === '1') return true;
    if (v === false || v === 'false' || v === '0') return false;
    throw invalid(issue(pointer, 'invalid_option', 'Use true or false.'));
  }

  #one(v: unknown, pointer: string): string | null {
    if (v === undefined || v === '') return null;
    if (typeof v !== 'string')
      throw invalid(issue(pointer, 'invalid_option', 'Give one value.'));
    return v;
  }

  #params(input: Record<string, unknown>, drill: boolean): Params {
    let version: number | undefined;
    if (input.version !== undefined) {
      const n = Number(input.version);
      if (!Number.isInteger(n) || n < 1 || n > 1000)
        throw invalid(issue('/version', 'invalid_option', 'Give a version number.'));
      version = n;
    }
    const brand = this.#one(input.brand, '/brand');
    if (brand !== null && !isPublic(brand, 'br'))
      throw invalid(issue('/brand', 'invalid_option', 'Choose a brand from the list.'));
    const project = this.#one(input.project, '/project');
    if (project !== null && !isPublic(project, 'prj'))
      throw invalid(issue('/project', 'invalid_option', 'Choose a project from the list.'));
    let asOf: Date | null = null;
    if (input.as_of !== undefined && input.as_of !== '') {
      asOf = parseInstant(input.as_of);
      if (!asOf)
        throw invalid(
          issue('/as_of', 'invalid_date', 'Use a date and time with an offset, such as 2026-10-01T09:00:00Z.'),
        );
    }
    const person = this.#one(input.person, '/person');
    if (person !== null && !isPublic(person, 'mem'))
      throw invalid(issue('/person', 'invalid_option', 'Choose a person from the list.'));
    const member = drill ? this.#one(input.member, '/member') : null;
    let cursor: string | null = null;
    let limit: number | null = null;
    if (drill) {
      if (input.cursor !== undefined) {
        if (typeof input.cursor !== 'string' || input.cursor.length > 2048)
          throw new TenancyError('cursor_invalid');
        cursor = input.cursor;
      }
      if (input.limit !== undefined) {
        const n = Number(input.limit);
        if (!Number.isInteger(n) || n < 1 || n > this.ws.metricsDrillPageMax)
          throw invalid(
            issue('/limit', 'invalid_option', `Use a page size from 1 to ${this.ws.metricsDrillPageMax}.`),
          );
        limit = n;
      }
    }
    return {
      version,
      brand,
      project,
      subprojects: this.#flag(input.subprojects, '/subprojects', true),
      from: input.from,
      to: input.to,
      asOf,
      person,
      member,
      cursor,
      limit,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Context: scope, zone, window, and time, all resolved against what the viewer may read
  // ---------------------------------------------------------------------------------------------

  async #context(
    tx: WorkspaceTransaction,
    p: Principal,
    def: MetricDefinition,
    q: Params,
  ): Promise<Ctx> {
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      includeArchived: false,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const unavailable = (pointer: string, what: string) =>
      invalid(issue(pointer, 'unavailable', `That ${what} is not available.`));
    const w = await tx.db
      .selectFrom('tenancy.workspace')
      .select('timezone')
      .where('id', '=', tx.workspaceId)
      .executeTakeFirstOrThrow();
    const tz = validZone(w.timezone) ?? 'UTC';
    const now = new Date();
    const asOf = q.asOf ?? now;
    if (asOf.getTime() > now.getTime() + 60_000)
      throw invalid(issue('/as_of', 'invalid_date', 'Use a time that is not in the future.'));
    const live = !q.asOf || isLive(asOf, now);
    if (!live && !def.historical)
      throw invalid(
        issue(
          '/as_of',
          'not_supported',
          `${def.name} describes the present and cannot be reproduced for a past time.`,
        ),
      );

    let brandId: string | null = null;
    let brand: Scope['brand'] = null;
    if (q.brand) {
      const row = await tx.db
        .selectFrom('core.record')
        .select('id')
        .where('record_type', '=', 'brand')
        .where('public_id', '=', q.brand)
        .executeTakeFirst();
      const readable = row ? await readableBrandsByIds(tx, p, [row.id]) : [];
      if (!readable[0]) throw unavailable('/brand', 'brand');
      brandId = readable[0].id;
      brand = brandMarker(readable[0]);
    }
    let projectId: string | null = null;
    let project: Scope['project'] = null;
    let projectIds: string[] = [];
    if (q.project) {
      const r = await sql<{ id: string; name: string; brand_id: string }>`
        SELECT r.id, w.name, w.brand_id FROM core.record r
          JOIN work.project w ON w.workspace_id = r.workspace_id AND w.id = r.id
         WHERE r.workspace_id = ${tx.workspaceId} AND r.public_id = ${q.project}
           AND r.record_type = 'project' AND ${vis.where('r', { project: sql`r.id` })}`.execute(tx.db);
      const row = r.rows[0];
      if (!row || (brandId && row.brand_id !== brandId)) throw unavailable('/project', 'project');
      projectId = row.id;
      project = { id: q.project, name: row.name };
      projectIds = q.subprojects
        ? (
            await sql<{ id: string }>`
              SELECT id FROM work.project WHERE workspace_id = ${tx.workspaceId}
                AND (id = ${projectId} OR ${projectId} = ANY(ancestor_ids))`.execute(tx.db)
          ).rows.map((x) => x.id)
        : [projectId];
    }
    const kind: MetricScopeKind = projectId ? 'project' : brandId ? 'brand' : 'workspace';
    if (!def.scopes.includes(kind))
      throw invalid(issue('/scope', 'not_supported', `${def.name} cannot be scoped to a ${kind}.`));

    let window: Ctx['window'] = null;
    if (def.window === 'window') {
      const r = resolveWindow(
        { from: q.from, to: q.to },
        localDay(asOf, tz),
        this.ws.metricsDefaultWindowDays,
        this.ws.metricsWindowDaysMax,
      );
      if (!r.ok) {
        const msg = {
          invalid_date: 'Use a calendar date such as 2026-10-01.',
          order: 'The start must not be after the end.',
          too_long: `Use a window of at most ${this.ws.metricsWindowDaysMax} days.`,
        }[r.issue];
        throw invalid(issue(r.pointer, r.issue, msg));
      }
      const b = (
        await sql<{ s: Date; e: Date }>`
          SELECT (${r.window.from}::date)::timestamp AT TIME ZONE ${tz} AS s,
                 ((${r.window.to}::date + 1))::timestamp AT TIME ZONE ${tz} AS e`.execute(tx.db)
      ).rows[0]!;
      window = { local: r.window, start: new Date(b.s), end: new Date(b.e) };
    }

    let personId: string | null = null;
    if (q.person) {
      if (p.kind !== 'member') throw unavailable('/person', 'person');
      const m = await tx.db
        .selectFrom('tenancy.membership')
        .select('id')
        .where('public_id', '=', q.person)
        .executeTakeFirst();
      personId = m?.id ?? NIL;
    }
    return {
      tx,
      p,
      vis,
      ws: tx.workspaceId,
      def,
      scope: { kind, brandId, brand, projectId, project, subprojects: q.subprojects, projectIds },
      window,
      asOf,
      live,
      tz,
      today: localDay(asOf, tz),
      now,
      personId,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Shared SQL: the tasks the viewer may read inside the scope
  // ---------------------------------------------------------------------------------------------

  #taskFrom(): RawBuilder<unknown> {
    return sql`work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id`;
  }

  #taskCond(c: Ctx): RawBuilder<boolean> {
    const parts: RawBuilder<unknown>[] = [
      sql`t.workspace_id = ${c.ws}`,
      c.vis.where('r', { project: sql`t.project_id` }),
    ];
    if (c.scope.kind === 'brand') parts.push(sql`t.brand_id = ${c.scope.brandId}`);
    if (c.scope.kind === 'project')
      parts.push(sql`t.project_id = ANY(${c.scope.projectIds}::uuid[])`);
    return sql<boolean>`${sql.join(parts, sql` AND `)}`;
  }

  /** A leaf for this viewer: no child task they may read (so hidden children never change it). */
  #leaf(c: Ctx): RawBuilder<boolean> {
    return sql<boolean>`NOT EXISTS (SELECT 1 FROM work.task ch
        JOIN core.record cr ON cr.workspace_id = ch.workspace_id AND cr.id = ch.id
       WHERE ch.workspace_id = t.workspace_id AND ch.parent_task_id = t.id
         AND ${c.vis.where('cr', { project: sql`ch.project_id` })})`;
  }

  /** The status category of a task at the time asked: now, or rebuilt from the status history. */
  #statusJoin(c: Ctx): RawBuilder<unknown> {
    return c.live
      ? sql``
      : sql`LEFT JOIN LATERAL (SELECT s.status_category, s.basis FROM metrics.task_status_span s
              WHERE s.workspace_id = t.workspace_id AND s.task_id = t.id
                AND s.entered_at <= ${c.asOf} AND (s.left_at IS NULL OR s.left_at > ${c.asOf})
              ORDER BY s.seq DESC LIMIT 1) st ON true`;
  }

  #cat(c: Ctx): RawBuilder<string> {
    return c.live ? sql<string>`t.status_category` : sql<string>`st.status_category`;
  }

  /** Counts tasks the scope reads, to refuse a computation larger than one request may carry. */
  async #guardSize(c: Ctx): Promise<void> {
    const n = (
      await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM (SELECT 1 FROM ${this.#taskFrom()}
          WHERE ${this.#taskCond(c)} LIMIT ${this.ws.metricsScopeTasksMax + 1}) x`.execute(c.tx.db)
    ).rows[0]!.n;
    if (Number(n) > this.ws.metricsScopeTasksMax)
      throw invalid(
        issue(
          '/scope',
          'too_large',
          'That scope covers too much work for one figure. Choose a brand or a project.',
        ),
      );
  }

  /** `SELECT <id> FROM …` selecting the task ids of a role, as a sub-query. */
  #ids(c: Ctx, role: string): RawBuilder<unknown> | null {
    switch (c.def.id) {
      case 'project.completion':
        return this.#completionIds(c, role);
      case 'work.attention':
        return this.#attentionIds(c, role);
      case 'work.planned_vs_completed':
        return this.#plannedIds(c, role);
      case 'work.created_vs_completed':
        return this.#createdIds(c, role);
      case 'work.cycle_time':
        return this.#cycleIds(c, role);
      case 'work.time_in_status':
        return this.#statusTimeIds(c, role);
      case 'work.age':
        return this.#ageIds(c, role);
      case 'work.workload':
        return role === 'open' ? this.#workloadIds(c) : null;
      case 'time.planned_vs_actual':
        return this.#actualIds(c, role);
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // project.completion (v1 by count, v2 weighted by estimate)
  // ---------------------------------------------------------------------------------------------

  #weight(): RawBuilder<number> {
    return sql<number>`(CASE WHEN t.estimate_minutes > 0 THEN t.estimate_minutes ELSE 0 END)`;
  }

  #completionBase(c: Ctx): RawBuilder<unknown> {
    const cat = this.#cat(c);
    return sql`FROM ${this.#taskFrom()} ${this.#statusJoin(c)}
      WHERE ${this.#taskCond(c)} AND ${this.#leaf(c)} AND ${cat} IS NOT NULL`;
  }

  #completionPred(c: Ctx, role: string): RawBuilder<boolean> | null {
    const cat = this.#cat(c);
    const v2 = c.def.version === 2;
    const w = this.#weight();
    if (role === 'numerator')
      return v2 ? sql<boolean>`${cat} = 'done' AND ${w} > 0` : sql<boolean>`${cat} = 'done'`;
    if (role === 'denominator')
      return v2 ? sql<boolean>`${cat} <> 'cancelled' AND ${w} > 0` : sql<boolean>`${cat} <> 'cancelled'`;
    if (role === 'unestimated' && v2) return sql<boolean>`${cat} <> 'cancelled' AND ${w} = 0`;
    return null;
  }

  #completionIds(c: Ctx, role: string): RawBuilder<unknown> | null {
    const pred = this.#completionPred(c, role);
    return pred ? sql`SELECT t.id ${this.#completionBase(c)} AND ${pred}` : null;
  }

  async #completion(c: Ctx): Promise<Computed> {
    const cat = this.#cat(c);
    const w = this.#weight();
    const version = c.def.version as 1 | 2;
    const rows = (
      await sql<{
        project_id: string | null;
        total: string;
        done: string;
        weight_total: string;
        weight_done: string;
        unestimated: string;
        assumed: string;
      }>`
        SELECT t.project_id,
               count(*) FILTER (WHERE ${cat} <> 'cancelled')::text AS total,
               count(*) FILTER (WHERE ${cat} = 'done')::text AS done,
               COALESCE(sum(${w}) FILTER (WHERE ${cat} <> 'cancelled'), 0)::text AS weight_total,
               COALESCE(sum(${w}) FILTER (WHERE ${cat} = 'done'), 0)::text AS weight_done,
               count(*) FILTER (WHERE ${cat} <> 'cancelled' AND ${w} = 0)::text AS unestimated,
               ${c.live ? sql`0` : sql`count(*) FILTER (WHERE st.basis = 'assumed')`}::text AS assumed
          ${this.#completionBase(c)}
         GROUP BY t.project_id`.execute(c.tx.db)
    ).rows;
    const toCounts = (r: (typeof rows)[number]): CompletionCounts => ({
      total: Number(r.total),
      done: Number(r.done),
      weightTotal: Number(r.weight_total),
      weightDone: Number(r.weight_done),
      unestimated: Number(r.unestimated),
    });
    const all = rows.reduce<CompletionCounts>((a, r) => addCounts(a, toCounts(r)), completionCounts([]));
    const fig = completionFigure(all, version);
    const assumed = rows.reduce((a, r) => a + Number(r.assumed), 0);
    const incomplete: Incomplete[] = fig.incomplete.map((i) => ({
      code: i.code,
      count: i.count,
      message: this.#message(c.def, i.code),
    }));
    if (!c.live) {
      incomplete.push({
        code: 'current_structure',
        count: null,
        message: this.#message(c.def, 'current_structure'),
      });
      if (assumed > 0)
        incomplete.push({
          code: 'assumed_history',
          count: assumed,
          message: 'For some tasks the status at that time is assumed because their earlier history was not recorded.',
        });
    }
    const names = await this.#projectNames(c, rows.map((r) => r.project_id));
    const groups = rows
      .map((r) => ({
        r,
        f: completionFigure(toCounts(r), version),
        project: r.project_id ? (names.get(r.project_id) ?? null) : null,
      }))
      .sort(
        (a, b) =>
          Number(b.r.total) - Number(a.r.total) ||
          (a.project?.id ?? '').localeCompare(b.project?.id ?? ''),
      )
      .slice(0, GROUP_MAX)
      .map(({ f, project }) => ({
        project,
        percent: f.percent,
        numerator: f.numerator,
        denominator: f.denominator,
        state: f.state,
      }));
    return {
      value: {
        percent: fig.percent,
        basis: version === 2 ? 'estimate_weighted' : 'task_count',
        unit_of_parts: version === 2 ? 'estimate_minutes' : 'tasks',
        ...(version === 2
          ? {
              estimated_task_share: all.total ? percentOf(all.total - all.unestimated, all.total) : null,
            }
          : {}),
        tasks: { counted: all.total, done: all.done, unestimated: all.unestimated },
      },
      parts: { numerator: fig.numerator, denominator: fig.denominator },
      incomplete,
      state: fig.state === 'complete' && incomplete.length ? 'partial' : fig.state,
      empty: fig.state === 'empty',
      groups,
    };
  }

  async #projectNames(c: Ctx, ids: ReadonlyArray<string | null>) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const out = new Map<string, { id: string; name: string }>();
    if (!unique.length) return out;
    const rows = await sql<{ id: string; public_id: string; name: string }>`
      SELECT w.id, r.public_id, w.name FROM work.project w
        JOIN core.record r ON r.workspace_id = w.workspace_id AND r.id = w.id
       WHERE w.workspace_id = ${c.ws} AND w.id = ANY(${unique}::uuid[])
         AND ${c.vis.where('r', { project: sql`w.id` })}`.execute(c.tx.db);
    for (const r of rows.rows) out.set(r.id, { id: r.public_id, name: r.name });
    return out;
  }

  #message(def: MetricDefinition, code: string): string {
    return def.incomplete.find((i) => i.code === code)?.meaning ?? code;
  }

  // ---------------------------------------------------------------------------------------------
  // project.health and cost.time_budget: judged per visible project
  // ---------------------------------------------------------------------------------------------

  async #projects(c: Ctx) {
    const cond: RawBuilder<unknown>[] = [
      sql`w.workspace_id = ${c.ws}`,
      c.vis.where('r', { project: sql`w.id` }),
    ];
    if (c.scope.kind === 'brand') cond.push(sql`w.brand_id = ${c.scope.brandId}`);
    if (c.scope.kind === 'project') cond.push(sql`w.id = ANY(${c.scope.projectIds}::uuid[])`);
    const max = this.ws.portfolioReadProjectsMax;
    const rows = (
      await sql<{
        id: string;
        public_id: string;
        name: string;
        brand_id: string;
        status_category: HealthInput['statusCategory'];
        start_date: string | null;
        target_date: string | null;
        deadline_date: string | null;
        time_budget_minutes: number | null;
      }>`
        SELECT w.id, r.public_id, w.name, w.brand_id, w.status_category,
               w.start_date::text AS start_date, w.target_date::text AS target_date,
               w.deadline_date::text AS deadline_date, w.time_budget_minutes
          FROM work.project w JOIN core.record r ON r.workspace_id = w.workspace_id AND r.id = w.id
         WHERE ${sql.join(cond, sql` AND `)}
         ORDER BY w.brand_id, w.rank COLLATE "C", w.id
         LIMIT ${max + 1}`.execute(c.tx.db)
    ).rows;
    return { projects: rows.slice(0, max), truncated: rows.length > max };
  }

  async #healthRows(c: Ctx) {
    const { projects, truncated } = await this.#projects(c);
    const ids = projects.map((x) => x.id);
    const [tasks, logged] = await Promise.all([
      this.taskFacts(c.tx, c.p, ids, c.today),
      this.loggedMinutes(c.tx, c.p, ids),
    ]);
    const rows = projects.map((pr) => {
      const t = tasks.get(pr.id);
      const input: HealthInput = {
        today: c.today,
        statusCategory: pr.status_category,
        startDate: pr.start_date,
        targetDate: pr.target_date,
        deadlineDate: pr.deadline_date,
        done: t?.done ?? 0,
        total: t?.total ?? 0,
        overdue: t?.overdue ?? 0,
        blocked: t?.blocked ?? 0,
        timeBudgetMinutes: pr.time_budget_minutes,
        loggedMinutes: logged.get(pr.id) ?? 0,
      };
      return { pr, result: evaluateHealth(input) };
    });
    return { rows, truncated };
  }

  async #health(c: Ctx): Promise<Computed> {
    const { rows, truncated } = await this.#healthRows(c);
    const classes: ProjectHealth[] = ['on_track', 'at_risk', 'off_track', 'complete', 'unknown'];
    const counts = Object.fromEntries(classes.map((k) => [k, 0])) as Record<ProjectHealth, number>;
    const codes = new Map<string, number>();
    for (const { result } of rows) {
      counts[result.health]++;
      for (const code of result.incomplete) codes.set(code, (codes.get(code) ?? 0) + 1);
    }
    const incomplete: Incomplete[] = [...codes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => ({ code, count, message: this.#message(c.def, code) }));
    if (truncated)
      incomplete.push({ code: 'truncated', count: null, message: this.#message(c.def, 'truncated') });
    const groups = rows.slice(0, GROUP_MAX).map(({ pr, result }) => ({
      project: { id: pr.public_id, name: pr.name },
      health: result.health,
      reasons: result.reasons.map((r) => ({ code: r.code, severity: r.severity, message: r.message })),
      incomplete: result.incomplete,
    }));
    return {
      value: { projects: rows.length, classes: counts, incomplete_projects: Object.fromEntries([...codes.entries()].sort(([a], [b]) => a.localeCompare(b))) },
      parts: { numerator: null, denominator: rows.length },
      // Not-enough-information is a result, not a defect, so it does not mark the figure partial
      // unless the list was cut short.
      incomplete: incomplete.filter((i) => i.code === 'truncated'),
      state: truncated ? 'partial' : undefined,
      empty: rows.length === 0,
      groups,
      counts,
    };
  }

  async #timeBudget(c: Ctx): Promise<Computed> {
    const { projects, truncated } = await this.#projects(c);
    const logged = await this.loggedMinutes(c.tx, c.p, projects.map((x) => x.id));
    const budgeted = projects.filter((x) => (x.time_budget_minutes ?? 0) > 0);
    const rows = budgeted.map((x) => ({ x, logged: logged.get(x.id) ?? 0 }));
    const budget = rows.reduce((a, r) => a + (r.x.time_budget_minutes ?? 0), 0);
    const used = rows.reduce((a, r) => a + r.logged, 0);
    const over = rows.filter((r) => r.logged > (r.x.time_budget_minutes ?? 0)).length;
    const none = projects.length - budgeted.length;
    const incomplete: Incomplete[] = [];
    if (none > 0)
      incomplete.push({ code: 'no_time_budget', count: none, message: this.#message(c.def, 'no_time_budget') });
    if (truncated)
      incomplete.push({ code: 'truncated', count: null, message: this.#message(c.def, 'truncated') });
    return {
      value: {
        percent: percentOf(used, budget),
        budget_minutes: budget,
        logged_minutes: used,
        projects: { budgeted: budgeted.length, over_budget: over, no_budget: none },
      },
      parts: { numerator: used, denominator: budget },
      incomplete,
      empty: budgeted.length === 0,
      groups: rows.slice(0, GROUP_MAX).map((r) => ({
        project: { id: r.x.public_id, name: r.x.name },
        budget_minutes: r.x.time_budget_minutes,
        logged_minutes: r.logged,
        percent: percentOf(r.logged, r.x.time_budget_minutes ?? 0),
      })),
      counts: { over_budget: over, within_budget: budgeted.length - over, no_budget: none },
    };
  }

  /** The projects behind a project-level drill role. */
  async #projectRole(c: Ctx, role: string): Promise<Array<{ public_id: string; name: string; brand_id: string; status: string }>> {
    if (c.def.id === 'project.health') {
      const { rows } = await this.#healthRows(c);
      return rows
        .filter((r) => r.result.health === role)
        .map((r) => ({ public_id: r.pr.public_id, name: r.pr.name, brand_id: r.pr.brand_id, status: r.pr.status_category }));
    }
    const { projects } = await this.#projects(c);
    const logged = await this.loggedMinutes(c.tx, c.p, projects.map((x) => x.id));
    return projects
      .filter((x) => {
        const budget = x.time_budget_minutes ?? 0;
        if (role === 'no_budget') return budget <= 0;
        if (budget <= 0) return false;
        const over = (logged.get(x.id) ?? 0) > budget;
        return role === 'over_budget' ? over : !over;
      })
      .map((x) => ({ public_id: x.public_id, name: x.name, brand_id: x.brand_id, status: x.status_category }));
  }

  // ---------------------------------------------------------------------------------------------
  // work.attention
  // ---------------------------------------------------------------------------------------------

  #attention(c: Ctx): Record<string, RawBuilder<boolean>> {
    const eff = sql`LEAST(t.due_date, t.deadline_date, (t.deadline_at AT TIME ZONE t.deadline_tz)::date)`;
    const open = sql<boolean>`t.status_category NOT IN ('done', 'cancelled')`;
    const staleActive = new Date(c.asOf.getTime() - this.ws.taskStaleActiveDays * DAY_MS);
    const stalePlanned = new Date(c.asOf.getTime() - this.ws.taskStalePlannedDays * DAY_MS);
    return {
      open,
      overdue: sql<boolean>`${open} AND ${eff} < ${c.today}::date`,
      due_soon: sql<boolean>`${open} AND ${eff} >= ${c.today}::date AND ${eff} < (${c.today}::date + 7)`,
      blocked: sql<boolean>`${open} AND EXISTS (SELECT 1 FROM relations.record_relationship rr
          JOIN work.task b ON b.workspace_id = rr.workspace_id AND b.id = rr.from_record_id
          JOIN core.record br ON br.workspace_id = b.workspace_id AND br.id = b.id
         WHERE rr.workspace_id = t.workspace_id AND rr.kind = 'blocks' AND rr.to_record_id = t.id
           AND b.status_category NOT IN ('done', 'cancelled')
           AND ${c.vis.where('br', { project: sql`b.project_id` })})`,
      stale: sql<boolean>`((t.status_category = 'active' AND t.last_meaningful_update_at < ${staleActive})
          OR (t.status_category = 'planned' AND t.last_meaningful_update_at < ${stalePlanned}))`,
      unassigned: sql<boolean>`${open} AND NOT EXISTS (SELECT 1 FROM work.task_assignee a
          JOIN tenancy.membership m ON m.id = a.membership_id
         WHERE a.workspace_id = t.workspace_id AND a.task_id = t.id AND m.state = 'active')`,
    };
  }

  #attentionIds(c: Ctx, role: string): RawBuilder<unknown> | null {
    if (role === 'unassigned' && c.p.kind !== 'member') return null;
    const pred = this.#attention(c)[role];
    return pred ? sql`SELECT t.id FROM ${this.#taskFrom()} WHERE ${this.#taskCond(c)} AND ${pred}` : null;
  }

  async #attentionFigures(c: Ctx): Promise<Computed> {
    const pr = this.#attention(c);
    const member = c.p.kind === 'member';
    const r = (
      await sql<Record<string, string>>`
        SELECT count(*) FILTER (WHERE ${pr.open!})::text AS open,
               count(*) FILTER (WHERE ${pr.overdue!})::text AS overdue,
               count(*) FILTER (WHERE ${pr.due_soon!})::text AS due_soon,
               count(*) FILTER (WHERE ${pr.blocked!})::text AS blocked,
               count(*) FILTER (WHERE ${pr.stale!})::text AS stale,
               ${member ? sql`count(*) FILTER (WHERE ${pr.unassigned!})` : sql`0`}::text AS unassigned
          FROM ${this.#taskFrom()} WHERE ${this.#taskCond(c)}`.execute(c.tx.db)
    ).rows[0]!;
    const n = (k: string) => Number(r[k]);
    const incomplete: Incomplete[] = member
      ? []
      : [{ code: 'owner_unknown', count: null, message: this.#message(c.def, 'owner_unknown') }];
    return {
      value: {
        open: n('open'),
        overdue: n('overdue'),
        due_soon: n('due_soon'),
        blocked: n('blocked'),
        stale: n('stale'),
        unassigned: member ? n('unassigned') : null,
        thresholds: {
          due_soon_days: 7,
          stale_active_days: this.ws.taskStaleActiveDays,
          stale_planned_days: this.ws.taskStalePlannedDays,
        },
      },
      parts: { numerator: null, denominator: n('open') },
      incomplete,
      empty: n('open') === 0,
      counts: {
        open: n('open'),
        overdue: n('overdue'),
        due_soon: n('due_soon'),
        blocked: n('blocked'),
        stale: n('stale'),
        ...(member ? { unassigned: n('unassigned') } : {}),
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // work.planned_vs_completed
  // ---------------------------------------------------------------------------------------------

  #planned(c: Ctx): Record<string, RawBuilder<boolean>> {
    const w = c.window!;
    const eff = sql`LEAST(t.due_date, t.deadline_date, (t.deadline_at AT TIME ZONE t.deadline_tz)::date)`;
    const planned = sql<boolean>`t.status_category <> 'cancelled'
      AND ${eff} >= ${w.local.from}::date AND ${eff} <= ${w.local.to}::date`;
    return {
      planned,
      completed: sql<boolean>`${planned} AND t.status_category = 'done' AND (t.completed_at IS NULL OR t.completed_at < ${w.end})`,
      completed_late: sql<boolean>`${planned} AND t.status_category = 'done' AND t.completed_at >= ${w.end}`,
      not_completed: sql<boolean>`${planned} AND t.status_category <> 'done'`,
    };
  }

  #plannedIds(c: Ctx, role: string): RawBuilder<unknown> | null {
    const pred = this.#planned(c)[role];
    return pred ? sql`SELECT t.id FROM ${this.#taskFrom()} WHERE ${this.#taskCond(c)} AND ${pred}` : null;
  }

  async #plannedFigures(c: Ctx): Promise<Computed> {
    const pr = this.#planned(c);
    const r = (
      await sql<Record<string, string>>`
        SELECT count(*) FILTER (WHERE ${pr.planned!})::text AS planned,
               count(*) FILTER (WHERE ${pr.completed!})::text AS completed,
               count(*) FILTER (WHERE ${pr.completed_late!})::text AS completed_late,
               count(*) FILTER (WHERE ${pr.not_completed!})::text AS not_completed,
               count(*) FILTER (WHERE t.status_category NOT IN ('done', 'cancelled')
                 AND t.due_date IS NULL AND t.deadline_date IS NULL AND t.deadline_at IS NULL)::text AS undated
          FROM ${this.#taskFrom()} WHERE ${this.#taskCond(c)}`.execute(c.tx.db)
    ).rows[0]!;
    const n = (k: string) => Number(r[k]);
    const incomplete: Incomplete[] =
      n('undated') > 0
        ? [{ code: 'undated_tasks', count: n('undated'), message: this.#message(c.def, 'undated_tasks') }]
        : [];
    return {
      value: {
        planned: n('planned'),
        completed: n('completed'),
        completed_late: n('completed_late'),
        not_completed: n('not_completed'),
        percent: percentOf(n('completed'), n('planned')),
      },
      parts: { numerator: n('completed'), denominator: n('planned') },
      incomplete,
      empty: n('planned') === 0,
      counts: {
        planned: n('planned'),
        completed: n('completed'),
        completed_late: n('completed_late'),
        not_completed: n('not_completed'),
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // work.created_vs_completed
  // ---------------------------------------------------------------------------------------------

  #createdIds(c: Ctx, role: string): RawBuilder<unknown> | null {
    const w = c.window!;
    if (role === 'created')
      return sql`SELECT t.id FROM ${this.#taskFrom()} WHERE ${this.#taskCond(c)}
        AND t.created_at >= ${w.start} AND t.created_at < ${w.end} AND t.created_at <= ${c.asOf}`;
    if (role === 'completed')
      return sql`SELECT DISTINCT t.id FROM metrics.task_status_span s JOIN ${this.#taskFrom()}
          ON t.workspace_id = s.workspace_id AND t.id = s.task_id
        WHERE ${this.#taskCond(c)} AND s.status_category = 'done'
          AND s.entered_at >= ${w.start} AND s.entered_at < ${w.end} AND s.entered_at <= ${c.asOf}`;
    return null;
  }

  async #createdFigures(c: Ctx): Promise<Computed> {
    const w = c.window!;
    const created = (
      await sql<{ day: string; n: number }>`
        SELECT (t.created_at AT TIME ZONE ${c.tz})::date::text AS day, count(*)::int AS n
          FROM ${this.#taskFrom()} WHERE ${this.#taskCond(c)}
           AND t.created_at >= ${w.start} AND t.created_at < ${w.end} AND t.created_at <= ${c.asOf}
         GROUP BY 1`.execute(c.tx.db)
    ).rows;
    const done = (
      await sql<{ day: string; n: number; assumed: number }>`
        SELECT (s.entered_at AT TIME ZONE ${c.tz})::date::text AS day, count(*)::int AS n,
               count(*) FILTER (WHERE s.basis = 'assumed')::int AS assumed
          FROM metrics.task_status_span s JOIN ${this.#taskFrom()}
            ON t.workspace_id = s.workspace_id AND t.id = s.task_id
         WHERE ${this.#taskCond(c)} AND s.status_category = 'done'
           AND s.entered_at >= ${w.start} AND s.entered_at < ${w.end} AND s.entered_at <= ${c.asOf}
         GROUP BY 1`.execute(c.tx.db)
    ).rows;
    const cBy = new Map(created.map((r) => [r.day, r.n]));
    const dBy = new Map(done.map((r) => [r.day, r.n]));
    const series = eachDay(w.local).map((day) => ({
      day,
      created: cBy.get(day) ?? 0,
      completed: dBy.get(day) ?? 0,
    }));
    const createdN = series.reduce((a, s) => a + s.created, 0);
    const completedN = series.reduce((a, s) => a + s.completed, 0);
    const assumed = done.reduce((a, r) => a + r.assumed, 0);
    const incomplete: Incomplete[] =
      assumed > 0
        ? [{ code: 'assumed_history', count: assumed, message: this.#message(c.def, 'assumed_history') }]
        : [];
    return {
      value: { created: createdN, completed: completedN, net: completedN - createdN, series },
      parts: { numerator: completedN, denominator: createdN },
      incomplete,
      empty: createdN === 0 && completedN === 0,
      ledger: true,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // work.cycle_time
  // ---------------------------------------------------------------------------------------------

  /**
   * One row per completion (entry into a done status) in the window, classed `measured` (a recorded
   * active start before it), `history_unavailable` (finished before history was recorded, or its
   * start was not recorded), or `no_start` (never active).
   */
  #cycleEvents(c: Ctx): RawBuilder<unknown> {
    const w = c.window!;
    return sql`SELECT e.task_id AS id, e.done_at, e.start_at,
        CASE WHEN e.done_basis <> 'recorded' OR (e.start_at IS NULL AND e.unrecorded_start) THEN 'history_unavailable'
             WHEN e.start_at IS NULL THEN 'no_start' ELSE 'measured' END AS cls
      FROM (
        SELECT d.task_id, d.entered_at AS done_at, d.basis AS done_basis,
          (SELECT min(a.entered_at) FROM metrics.task_status_span a
            WHERE a.workspace_id = d.workspace_id AND a.task_id = d.task_id
              AND a.status_category = 'active' AND a.basis = 'recorded' AND a.seq < d.seq
              AND a.seq > COALESCE((SELECT max(pd.seq) FROM metrics.task_status_span pd
                   WHERE pd.workspace_id = d.workspace_id AND pd.task_id = d.task_id
                     AND pd.status_category = 'done' AND pd.seq < d.seq), 0)) AS start_at,
          EXISTS (SELECT 1 FROM metrics.task_status_span a
            WHERE a.workspace_id = d.workspace_id AND a.task_id = d.task_id
              AND a.status_category = 'active' AND a.basis <> 'recorded' AND a.seq < d.seq
              AND a.seq > COALESCE((SELECT max(pd.seq) FROM metrics.task_status_span pd
                   WHERE pd.workspace_id = d.workspace_id AND pd.task_id = d.task_id
                     AND pd.status_category = 'done' AND pd.seq < d.seq), 0)) AS unrecorded_start
          FROM metrics.task_status_span d
         WHERE d.workspace_id = ${c.ws} AND d.status_category = 'done'
           AND d.entered_at >= ${w.start} AND d.entered_at < ${w.end} AND d.entered_at <= ${c.asOf}
      ) e
      JOIN ${this.#taskFrom()} ON t.workspace_id = ${c.ws} AND t.id = e.task_id
      WHERE ${this.#taskCond(c)}`;
  }

  #cycleIds(c: Ctx, role: string): RawBuilder<unknown> | null {
    if (role === 'included') return sql`SELECT DISTINCT x.id FROM (${this.#cycleEvents(c)}) x WHERE x.cls = 'measured'`;
    if (role === 'excluded') return sql`SELECT DISTINCT x.id FROM (${this.#cycleEvents(c)}) x WHERE x.cls <> 'measured'`;
    return null;
  }

  async #cycleFigures(c: Ctx): Promise<Computed> {
    const rows = (
      await sql<{ cls: string; secs: number | null }>`
        SELECT x.cls, extract(epoch FROM (x.done_at - x.start_at))::float8 AS secs
          FROM (${this.#cycleEvents(c)}) x`.execute(c.tx.db)
    ).rows;
    const measured = rows.filter((r) => r.cls === 'measured').map((r) => Number(r.secs));
    const unavailable = rows.filter((r) => r.cls === 'history_unavailable').length;
    const noStart = rows.filter((r) => r.cls === 'no_start').length;
    const d = distribution(measured);
    const incomplete: Incomplete[] = [];
    if (unavailable) incomplete.push({ code: 'history_unavailable', count: unavailable, message: this.#message(c.def, 'history_unavailable') });
    if (noStart) incomplete.push({ code: 'no_start', count: noStart, message: this.#message(c.def, 'no_start') });
    if (d.n > 0 && d.n < this.ws.metricsSampleMin)
      incomplete.push({ code: 'small_sample', count: d.n, message: this.#message(c.def, 'small_sample') });
    return {
      value: {
        completions: rows.length,
        measured: d.n,
        median_seconds: d.median,
        p85_seconds: d.p85,
        mean_seconds: d.mean,
        min_seconds: d.min,
        max_seconds: d.max,
        sample_min: this.ws.metricsSampleMin,
      },
      parts: { numerator: d.n, denominator: rows.length },
      incomplete,
      empty: rows.length === 0,
      ledger: true,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // work.time_in_status
  // ---------------------------------------------------------------------------------------------

  #overlap(c: Ctx): { start: Date; end: Date } {
    const w = c.window!;
    return { start: w.start, end: new Date(Math.min(w.end.getTime(), c.asOf.getTime())) };
  }

  #statusTimeIds(c: Ctx, role: string): RawBuilder<unknown> | null {
    if (!['planned', 'active', 'paused', 'done', 'cancelled'].includes(role)) return null;
    const o = this.#overlap(c);
    return sql`SELECT DISTINCT t.id FROM metrics.task_status_span s JOIN ${this.#taskFrom()}
        ON t.workspace_id = s.workspace_id AND t.id = s.task_id
      WHERE ${this.#taskCond(c)} AND s.status_category = ${role} AND s.basis <> 'assumed'
        AND s.entered_at < ${o.end} AND COALESCE(s.left_at, ${c.asOf}) > ${o.start}
        AND LEAST(COALESCE(s.left_at, ${c.asOf}), ${o.end}) > GREATEST(s.entered_at, ${o.start})`;
  }

  async #statusTimeFigures(c: Ctx): Promise<Computed> {
    const o = this.#overlap(c);
    const rows = (
      await sql<{ cat: string; secs: number; tasks: number }>`
        SELECT s.status_category AS cat,
               sum(extract(epoch FROM (LEAST(COALESCE(s.left_at, ${c.asOf}), ${o.end}) - GREATEST(s.entered_at, ${o.start}))))::float8 AS secs,
               count(DISTINCT s.task_id)::int AS tasks
          FROM metrics.task_status_span s JOIN ${this.#taskFrom()}
            ON t.workspace_id = s.workspace_id AND t.id = s.task_id
         WHERE ${this.#taskCond(c)} AND s.basis <> 'assumed'
           AND s.entered_at < ${o.end} AND COALESCE(s.left_at, ${c.asOf}) > ${o.start}
           AND LEAST(COALESCE(s.left_at, ${c.asOf}), ${o.end}) > GREATEST(s.entered_at, ${o.start})
         GROUP BY 1`.execute(c.tx.db)
    ).rows;
    const assumed = (
      await sql<{ n: number }>`
        SELECT count(DISTINCT s.task_id)::int AS n
          FROM metrics.task_status_span s JOIN ${this.#taskFrom()}
            ON t.workspace_id = s.workspace_id AND t.id = s.task_id
         WHERE ${this.#taskCond(c)} AND s.basis = 'assumed'
           AND s.entered_at < ${o.end} AND COALESCE(s.left_at, ${c.asOf}) > ${o.start}`.execute(c.tx.db)
    ).rows[0]!.n;
    const total = rows.reduce((a, r) => a + Number(r.secs), 0);
    const byCat = new Map(rows.map((r) => [r.cat, r]));
    const cats = ['planned', 'active', 'paused', 'done', 'cancelled'] as const;
    const categories = cats.map((k) => {
      const r = byCat.get(k);
      const secs = Math.round(Number(r?.secs ?? 0));
      return { category: k, seconds: secs, share_percent: percentOf(secs, Math.round(total)), tasks: r?.tasks ?? 0 };
    });
    const incomplete: Incomplete[] =
      assumed > 0
        ? [{ code: 'history_unavailable', count: assumed, message: this.#message(c.def, 'history_unavailable') }]
        : [];
    return {
      value: { total_seconds: Math.round(total), categories },
      parts: { numerator: null, denominator: Math.round(total) },
      incomplete,
      empty: rows.length === 0 && assumed === 0,
      ledger: true,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // work.age
  // ---------------------------------------------------------------------------------------------

  #ageBase(c: Ctx): RawBuilder<unknown> {
    const cat = this.#cat(c);
    return sql`FROM ${this.#taskFrom()} ${this.#statusJoin(c)}
      WHERE ${this.#taskCond(c)} AND ${cat} IN ('planned', 'active', 'paused') AND t.created_at <= ${c.asOf}`;
  }

  #ageIds(c: Ctx, role: string): RawBuilder<unknown> | null {
    const days = sql`floor(extract(epoch FROM (${c.asOf}::timestamptz - t.created_at)) / 86400)`;
    if (role === 'open') return sql`SELECT t.id ${this.#ageBase(c)}`;
    const band = AGE_BANDS.find((b) => b.role === role);
    if (!band) return null;
    return sql`SELECT t.id ${this.#ageBase(c)} AND ${days} >= ${band.from}${band.to === null ? sql`` : sql` AND ${days} <= ${band.to}`}`;
  }

  async #ageFigures(c: Ctx): Promise<Computed> {
    const rows = (
      await sql<{ days: number; assumed: boolean }>`
        SELECT floor(extract(epoch FROM (${c.asOf}::timestamptz - t.created_at)) / 86400)::int AS days,
                      ${c.live ? sql`false` : sql`COALESCE(st.basis = 'assumed', false)`} AS assumed
          ${this.#ageBase(c)}`.execute(c.tx.db)
    ).rows;
    const bands = AGE_BANDS.map((b) => ({
      band: b.role,
      label: b.label,
      count: rows.filter((r) => ageBand(r.days) === b.role).length,
    }));
    const d = distribution(rows.map((r) => r.days));
    const assumed = rows.filter((r) => r.assumed).length;
    const incomplete: Incomplete[] =
      assumed > 0
        ? [{ code: 'assumed_history', count: assumed, message: this.#message(c.def, 'assumed_history') }]
        : [];
    return {
      value: {
        open: rows.length,
        bands,
        median_days: d.median,
        p85_days: d.p85,
        oldest_days: d.max,
      },
      parts: { numerator: null, denominator: rows.length },
      incomplete,
      empty: rows.length === 0,
      ledger: !c.live,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // work.workload
  // ---------------------------------------------------------------------------------------------

  #workloadOpen(c: Ctx): RawBuilder<unknown> {
    return sql`SELECT t.id,
        COALESCE(t.remaining_estimate_minutes, GREATEST(t.estimate_minutes - lg.m, 0), 0)::int AS rem,
        (t.remaining_estimate_minutes IS NULL AND t.estimate_minutes IS NULL) AS unest,
        (LEAST(t.due_date, t.deadline_date, (t.deadline_at AT TIME ZONE t.deadline_tz)::date) < ${c.today}::date) AS overdue
      FROM ${this.#taskFrom()}
      LEFT JOIN LATERAL (SELECT COALESCE(sum(e.duration_seconds), 0) / 60 AS m FROM timetrack.time_entry e
         WHERE e.workspace_id = t.workspace_id AND e.task_id = t.id AND e.state = 'stopped') lg ON true
      WHERE ${this.#taskCond(c)} AND t.status_category NOT IN ('done', 'cancelled')`;
  }

  #workloadIds(c: Ctx): RawBuilder<unknown> {
    if (c.personId)
      return sql`SELECT o.id FROM (${this.#workloadOpen(c)}) o WHERE EXISTS (
        SELECT 1 FROM work.task_assignee a JOIN tenancy.membership m ON m.id = a.membership_id
         WHERE a.workspace_id = ${c.ws} AND a.task_id = o.id AND a.membership_id = ${c.personId} AND m.state = 'active')`;
    return sql`SELECT o.id FROM (${this.#workloadOpen(c)}) o`;
  }

  async #workloadFigures(c: Ctx): Promise<Computed> {
    const total = (
      await sql<{ open: number; rem: string; unest: number; overdue: number }>`
        SELECT count(*)::int AS open, COALESCE(sum(o.rem), 0)::text AS rem,
               count(*) FILTER (WHERE o.unest)::int AS unest, count(*) FILTER (WHERE o.overdue)::int AS overdue
          FROM (${this.#workloadOpen(c)}) o`.execute(c.tx.db)
    ).rows[0]!;
    const member = c.p.kind === 'member';
    const per = member
      ? (
          await sql<{ membership_id: string; open: number; rem: string; unest: number; overdue: number }>`
            SELECT a.membership_id, count(*)::int AS open, COALESCE(sum(o.rem), 0)::text AS rem,
                   count(*) FILTER (WHERE o.unest)::int AS unest, count(*) FILTER (WHERE o.overdue)::int AS overdue
              FROM (${this.#workloadOpen(c)}) o
              JOIN work.task_assignee a ON a.workspace_id = ${c.ws} AND a.task_id = o.id
              JOIN tenancy.membership m ON m.id = a.membership_id AND m.state = 'active'
             GROUP BY a.membership_id`.execute(c.tx.db)
        ).rows
      : [];
    const unassigned = member
      ? (
          await sql<{ open: number; rem: string }>`
            SELECT count(*)::int AS open, COALESCE(sum(o.rem), 0)::text AS rem
              FROM (${this.#workloadOpen(c)}) o
             WHERE NOT EXISTS (SELECT 1 FROM work.task_assignee a JOIN tenancy.membership m ON m.id = a.membership_id
                    WHERE a.workspace_id = ${c.ws} AND a.task_id = o.id AND m.state = 'active')`.execute(c.tx.db)
        ).rows[0]!
      : null;
    const people = await this.goalPeople(c.tx, c.p, per.map((r) => r.membership_id));
    const groups = per
      .map((r) => ({
        person: people.get(r.membership_id) ?? null,
        open: r.open,
        remaining_minutes: Number(r.rem),
        unestimated: r.unest,
        overdue: r.overdue,
      }))
      .sort(
        (a, b) =>
          b.remaining_minutes - a.remaining_minutes ||
          b.open - a.open ||
          (a.person?.id ?? '').localeCompare(b.person?.id ?? ''),
      );
    const incomplete: Incomplete[] = [];
    if (total.unest > 0)
      incomplete.push({ code: 'unestimated_tasks', count: total.unest, message: this.#message(c.def, 'unestimated_tasks') });
    if (!member)
      incomplete.push({ code: 'people_hidden', count: null, message: this.#message(c.def, 'people_hidden') });
    return {
      value: {
        open: total.open,
        remaining_minutes: Number(total.rem),
        unestimated: total.unest,
        overdue: total.overdue,
        unassigned: unassigned ? { open: unassigned.open, remaining_minutes: Number(unassigned.rem) } : null,
      },
      parts: { numerator: Number(total.rem), denominator: null },
      incomplete,
      empty: total.open === 0,
      groups,
      counts: { open: total.open },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // time.planned_vs_actual
  // ---------------------------------------------------------------------------------------------

  #actualTasks(c: Ctx): RawBuilder<unknown> {
    const w = c.window!;
    return sql`SELECT t.id, t.estimate_minutes AS est,
        COALESCE((SELECT sum(e.duration_seconds) FROM timetrack.time_entry e
           WHERE e.workspace_id = t.workspace_id AND e.task_id = t.id AND e.state = 'stopped'
             AND e.work_date <= ${c.today}::date), 0)::bigint AS secs
      FROM ${this.#taskFrom()}
      WHERE ${this.#taskCond(c)} AND t.id IN (
        SELECT s.task_id FROM metrics.task_status_span s
         WHERE s.workspace_id = ${c.ws} AND s.status_category = 'done'
           AND s.entered_at >= ${w.start} AND s.entered_at < ${w.end} AND s.entered_at <= ${c.asOf})`;
  }

  #actualIds(c: Ctx, role: string): RawBuilder<unknown> | null {
    if (role === 'compared') return sql`SELECT a.id FROM (${this.#actualTasks(c)}) a WHERE a.est > 0`;
    if (role === 'unestimated') return sql`SELECT a.id FROM (${this.#actualTasks(c)}) a WHERE a.est IS NULL OR a.est <= 0`;
    return null;
  }

  async #actualFigures(c: Ctx): Promise<Computed> {
    const r = (
      await sql<{ compared: number; unest: number; planned: string; secs: string; no_time: number }>`
        SELECT count(*) FILTER (WHERE a.est > 0)::int AS compared,
               count(*) FILTER (WHERE a.est IS NULL OR a.est <= 0)::int AS unest,
               COALESCE(sum(a.est) FILTER (WHERE a.est > 0), 0)::text AS planned,
               COALESCE(sum(a.secs) FILTER (WHERE a.est > 0), 0)::text AS secs,
               count(*) FILTER (WHERE a.est > 0 AND a.secs = 0)::int AS no_time
          FROM (${this.#actualTasks(c)}) a`.execute(c.tx.db)
    ).rows[0]!;
    const planned = Number(r.planned);
    const actual = Math.round(Number(r.secs) / 60);
    const incomplete: Incomplete[] = [];
    if (r.unest > 0)
      incomplete.push({ code: 'unestimated_tasks', count: r.unest, message: this.#message(c.def, 'unestimated_tasks') });
    if (r.no_time > 0)
      incomplete.push({ code: 'no_time_logged', count: r.no_time, message: this.#message(c.def, 'no_time_logged') });
    return {
      value: {
        tasks_compared: r.compared,
        planned_minutes: planned,
        actual_minutes: actual,
        variance_minutes: actual - planned,
        variance_percent: planned > 0 ? Math.floor(((actual - planned) * 100) / planned + 0.5) : null,
      },
      parts: { numerator: actual, denominator: planned },
      incomplete,
      empty: r.compared === 0 && r.unest === 0,
      counts: { compared: r.compared, unestimated: r.unest },
      ledger: true,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // deliverable.acceptance
  // ---------------------------------------------------------------------------------------------

  #deliverableFrom(c: Ctx): RawBuilder<unknown> {
    const parts: RawBuilder<unknown>[] = [
      sql`d.workspace_id = ${c.ws}`,
      sql`dr.lifecycle_state = 'active'`,
      c.vis.where('r', { project: sql`t.project_id` }),
    ];
    if (c.scope.kind === 'brand') parts.push(sql`t.brand_id = ${c.scope.brandId}`);
    if (c.scope.kind === 'project') parts.push(sql`t.project_id = ANY(${c.scope.projectIds}::uuid[])`);
    return sql`files.deliverable d
      JOIN core.record dr ON dr.workspace_id = d.workspace_id AND dr.id = d.id AND dr.record_type = 'deliverable'
      JOIN work.task t ON t.workspace_id = d.workspace_id AND t.id = d.task_id
      JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
      WHERE ${sql.join(parts, sql` AND `)}`;
  }

  async #deliverableFigures(c: Ctx): Promise<Computed> {
    const rows = (
      await sql<{ state: string; n: number }>`
        SELECT d.state, count(*)::int AS n FROM ${this.#deliverableFrom(c)} GROUP BY d.state`.execute(c.tx.db)
    ).rows;
    const by = new Map(rows.map((r) => [r.state, r.n]));
    const n = (k: string) => by.get(k) ?? 0;
    const submitted = n('ready_for_review') + n('changes_requested') + n('accepted') + n('rejected');
    const total = submitted + n('draft');
    return {
      value: {
        draft: n('draft'),
        ready_for_review: n('ready_for_review'),
        changes_requested: n('changes_requested'),
        accepted: n('accepted'),
        rejected: n('rejected'),
        submitted,
        accepted_percent: percentOf(n('accepted'), submitted),
      },
      parts: { numerator: n('accepted'), denominator: submitted },
      incomplete:
        n('draft') > 0
          ? [{ code: 'drafts_excluded', count: n('draft'), message: this.#message(c.def, 'drafts_excluded') }]
          : [],
      empty: total === 0,
      counts: {
        draft: n('draft'),
        ready_for_review: n('ready_for_review'),
        changes_requested: n('changes_requested'),
        accepted: n('accepted'),
        rejected: n('rejected'),
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // data.freshness
  // ---------------------------------------------------------------------------------------------

  async #reconcile(c: Ctx) {
    const row = await c.tx.db
      .selectFrom('metrics.reconcile_state')
      .select(['next_run_at', 'last_success_at', 'last_failure_at', 'attempts', 'failure_code'])
      .where('workspace_id', '=', c.ws)
      .executeTakeFirst();
    const failing = !!row && row.attempts >= this.ws.metricsReconcileMaxAttempts && !!row.failure_code;
    const intervalMs = this.ws.metricsReconcileIntervalMinutes * 60_000;
    const state: 'current' | 'pending' | 'overdue' | 'failing' = !row
      ? 'current'
      : failing
        ? 'failing'
        : !row.last_success_at
          ? 'pending'
          : c.now.getTime() - new Date(row.last_success_at).getTime() > 2 * intervalMs
            ? 'overdue'
            : 'current';
    return {
      state,
      last_success_at: row?.last_success_at ? iso(row.last_success_at) : null,
      next_run_at: row ? iso(row.next_run_at) : null,
      failure_code: failing ? (row?.failure_code ?? null) : null,
    };
  }

  #reconcileFreshness(s: 'current' | 'pending' | 'overdue' | 'failing'): FreshnessState {
    return s === 'failing' ? 'degraded' : s === 'current' ? 'current' : 'catching_up';
  }

  async #ledgerCounts(c: Ctx) {
    return (
      await sql<{ assumed: number; repaired: number }>`
        SELECT count(DISTINCT s.task_id) FILTER (WHERE s.basis = 'assumed')::int AS assumed,
               count(DISTINCT s.task_id) FILTER (WHERE s.basis = 'repaired')::int AS repaired
          FROM metrics.task_status_span s JOIN ${this.#taskFrom()}
            ON t.workspace_id = s.workspace_id AND t.id = s.task_id
         WHERE ${this.#taskCond(c)}`.execute(c.tx.db)
    ).rows[0]!;
  }

  async #freshnessFigures(c: Ctx): Promise<Computed> {
    const rec = await this.#reconcile(c);
    const ledger = await this.#ledgerCounts(c);
    const index = await this.indexStatusFor(c.tx, c.vis);
    const gvis = await this.goalVisibility(c.tx, c.p, false);
    const goals = (
      await sql<{ pending: number; failed: number }>`
        SELECT count(*) FILTER (WHERE s.dirty OR s.computed_at IS NULL)::int AS pending,
               count(*) FILTER (WHERE s.attempts >= ${this.ws.goalsRecalcMaxAttempts} AND s.last_error IS NOT NULL)::int AS failed
          FROM goals.goal_state s JOIN goals.goal g ON g.workspace_id = s.workspace_id AND g.id = s.goal_id
          JOIN core.record gr ON gr.workspace_id = g.workspace_id AND gr.id = g.id
         WHERE s.workspace_id = ${c.ws} AND ${gvis.where('gr', { project: sql`g.project_id` })}`.execute(c.tx.db)
    ).rows[0]!;
    const sources = [
      {
        source: 'status_history',
        label: 'Task status history',
        state: this.#reconcileFreshness(rec.state),
        pending: ledger.repaired,
        failed: rec.state === 'failing' ? 1 : 0,
        last_success_at: rec.last_success_at,
        detail: { reconciliation: rec.state, tasks_with_assumed_history: ledger.assumed },
      },
      {
        source: 'search_index',
        label: 'Search index',
        state: freshnessState(index.pending, index.failed),
        pending: index.pending,
        failed: index.failed,
        last_success_at: null,
        detail: { oldest_pending_seconds: index.oldest_pending_seconds },
      },
      {
        source: 'goal_recalculation',
        label: 'Goal recalculation',
        state: freshnessState(goals.pending, goals.failed),
        pending: goals.pending,
        failed: goals.failed,
        last_success_at: null,
        detail: {},
      },
    ];
    const overall = worstFreshness(sources.map((s) => s.state));
    return {
      value: { overall, sources },
      incomplete:
        overall === 'current'
          ? []
          : [{ code: 'catching_up', count: sources.filter((s) => s.state !== 'current').length, message: this.#message(c.def, 'catching_up') }],
      state: overall === 'current' ? 'complete' : 'partial',
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Computation, result, and freshness
  // ---------------------------------------------------------------------------------------------

  async #compute(c: Ctx): Promise<Computed> {
    switch (c.def.id) {
      case 'project.completion':
        await this.#guardSize(c);
        return this.#completion(c);
      case 'project.health':
        return this.#health(c);
      case 'work.attention':
        await this.#guardSize(c);
        return this.#attentionFigures(c);
      case 'work.planned_vs_completed':
        await this.#guardSize(c);
        return this.#plannedFigures(c);
      case 'work.created_vs_completed':
        await this.#guardSize(c);
        return this.#createdFigures(c);
      case 'work.cycle_time':
        await this.#guardSize(c);
        return this.#cycleFigures(c);
      case 'work.time_in_status':
        await this.#guardSize(c);
        return this.#statusTimeFigures(c);
      case 'work.age':
        await this.#guardSize(c);
        return this.#ageFigures(c);
      case 'work.workload':
        await this.#guardSize(c);
        return this.#workloadFigures(c);
      case 'time.planned_vs_actual':
        await this.#guardSize(c);
        return this.#actualFigures(c);
      case 'cost.time_budget':
        return this.#timeBudget(c);
      case 'deliverable.acceptance':
        return this.#deliverableFigures(c);
      case 'data.freshness':
        return this.#freshnessFigures(c);
      default:
        throw new TenancyError('not_found');
    }
  }

  async #freshness(c: Ctx, computed: Computed) {
    if (c.def.id === 'data.freshness') {
      const overall = (computed.value as { overall: FreshnessState }).overall;
      return { state: overall, data_as_of: iso(c.now), basis: 'live' as const };
    }
    const ledger = computed.ledger ?? c.def.freshness === 'ledger';
    if (!ledger) return { state: 'current' as FreshnessState, data_as_of: iso(c.now), basis: 'live' as const };
    const rec = await this.#reconcile(c);
    const counts = await this.#ledgerCounts(c);
    return {
      state: this.#reconcileFreshness(rec.state),
      data_as_of: iso(c.now),
      basis: 'ledger' as const,
      ledger: {
        reconciliation: rec.state,
        last_success_at: rec.last_success_at,
        tasks_with_assumed_history: counts.assumed,
        tasks_with_repaired_history: counts.repaired,
      },
    };
  }

  #scopeView(c: Ctx) {
    return {
      kind: c.scope.kind,
      brand: c.scope.brand,
      project: c.scope.project,
      subprojects: c.scope.kind === 'project' ? c.scope.subprojects : null,
    };
  }

  #definitionView(def: MetricDefinition) {
    return {
      id: def.id,
      version: def.version,
      name: def.name,
      unit: def.unit,
      digest: definitionDigest(def),
    };
  }

  async getMetric(caller: Caller, ws: unknown, metric: unknown, query: Record<string, unknown>) {
    const q = this.#params(query, false);
    const def = this.#definition(metric, q.version);
    return this.trackMetric('compute', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        await this.metricsLimit(p);
        const c = await this.#context(tx, p, def, q);
        return this.#result(c);
      }),
    );
  }

  #definition(metric: unknown, version: number | undefined): MetricDefinition {
    const def = isMetricId(metric) ? findDefinition(metric, version) : undefined;
    if (!def) {
      if (isMetricId(metric) && version !== undefined)
        throw invalid(issue('/version', 'unavailable', 'That version of the metric does not exist.'));
      throw new TenancyError('not_found');
    }
    return def;
  }

  async #result(c: Ctx) {
    const base = {
      definition: this.#definitionView(c.def),
      scope: this.#scopeView(c),
      window: c.window
        ? { from: c.window.local.from, to: c.window.local.to, days: c.window.local.days }
        : null,
      as_of: iso(c.asOf),
      timezone: c.def.timezone === 'workspace' ? c.tz : null,
      limits: [c.def.doesNotClaim, c.def.authorization],
      provenance: {
        sources: c.def.sources,
        authorization: 'viewer' as const,
        evidence: 'recorded_records' as const,
      },
    };
    if (c.def.availability.state === 'source_unavailable') {
      const out = {
        ...base,
        state: 'unavailable' as MetricState,
        value: null,
        parts: null,
        incomplete: c.def.incomplete.map((i) => ({ code: i.code, message: i.meaning, count: null })),
        groups: [] as unknown[],
        freshness: { state: 'current' as FreshnessState, data_as_of: iso(c.now), basis: 'live' as const },
        unavailable: {
          phase: c.def.availability.phase,
          reason: c.def.availability.reason,
        },
        drill: { members: [] as Array<{ role: string; label: string; count: number }> },
      };
      return { ...out, reproducibility: this.#reproducibility(c, out) };
    }
    const computed = await this.#compute(c);
    const members = await this.#memberCounts(c, computed);
    const state =
      computed.state ?? stateOf({ empty: !!computed.empty, incomplete: computed.incomplete, estimated: computed.estimated });
    const out = {
      ...base,
      state,
      value: computed.value,
      parts: computed.parts ?? null,
      incomplete: computed.incomplete,
      groups: computed.groups ?? [],
      freshness: await this.#freshness(c, computed),
      unavailable: null,
      drill: { members },
    };
    return { ...out, reproducibility: this.#reproducibility(c, out) };
  }

  /**
   * The inputs and a digest of the figure: the same definition version, scope, window, and time
   * give the same digest on every read while the records are unchanged, so two figures can be
   * compared without reading them. Freshness is not part of it (it is about when, not what).
   */
  #reproducibility(
    c: Ctx,
    out: { value: unknown; parts: unknown; incomplete: unknown; state: unknown; groups: unknown; drill: unknown },
  ) {
    return {
      definition_digest: definitionDigest(c.def),
      as_of: iso(c.asOf),
      historical: !c.live,
      result_digest: digestOf({
        definition: [c.def.id, c.def.version],
        scope: this.#scopeView(c),
        window: c.window?.local ?? null,
        as_of: c.live ? null : iso(c.asOf),
        state: out.state,
        value: out.value,
        parts: out.parts,
        incomplete: out.incomplete,
        groups: out.groups,
        drill: out.drill,
      }),
    };
  }

  async #memberCounts(c: Ctx, computed: Computed): Promise<Array<{ role: string; label: string; count: number }>> {
    const out: Array<{ role: string; label: string; count: number }> = [];
    for (const d of c.def.drill) {
      if (d.role === 'unassigned' && c.p.kind !== 'member') continue;
      if (computed.counts && d.role in computed.counts) {
        out.push({ role: d.role, label: d.label, count: computed.counts[d.role]! });
        continue;
      }
      const ids = this.#ids(c, d.role);
      if (!ids) continue;
      const n = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM (${ids}) m`.execute(c.tx.db)).rows[0]!.n;
      out.push({ role: d.role, label: d.label, count: Number(n) });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------------------------------

  async listMetrics(caller: Caller, ws: unknown) {
    return this.trackMetric('catalog', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (_tx, p) => {
        await this.metricsLimit(p);
        return {
          data: METRIC_DEFINITIONS.map((d) => ({
            id: d.id,
            version: d.version,
            current: currentVersion(d.id) === d.version,
            name: d.name,
            summary: d.summary,
            unit: d.unit,
            scopes: d.scopes,
            window: d.window,
            historical: d.historical,
            numerator: d.numerator,
            denominator: d.denominator,
            sources: d.sources,
            timezone: d.timezone,
            freshness: d.freshness,
            rollup: d.rollup,
            incomplete: d.incomplete.map((i) => ({ code: i.code, meaning: i.meaning })),
            authorization: d.authorization,
            drill: d.drill.map((x) => ({ role: x.role, label: x.label, records: x.records })),
            does_not_claim: d.doesNotClaim,
            availability: d.availability,
            changelog: d.changelog,
            digest: definitionDigest(d),
          })),
          limits: {
            window_days_max: this.ws.metricsWindowDaysMax,
            default_window_days: this.ws.metricsDefaultWindowDays,
            drill_page_max: this.ws.metricsDrillPageMax,
            sample_min: this.ws.metricsSampleMin,
          },
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Drill-through: the records behind a figure, selected by the same statements
  // ---------------------------------------------------------------------------------------------

  #fingerprint(c: Ctx, role: string): string {
    return digestOf({
      id: c.def.id,
      version: c.def.version,
      role,
      scope: [c.scope.brandId, c.scope.projectId, c.scope.subprojects],
      window: c.window?.local ?? null,
      as_of: c.live ? null : iso(c.asOf),
      person: c.personId,
    });
  }

  #seal(p: Principal, fp: string, pos: { after: string | null; n: number }): string {
    const payload = JSON.stringify(pos);
    const mac = createHmac('sha256', this.#cursorKey)
      .update(`${p.workspaceId}|${p.membershipId}|${fp}|${payload}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    return Buffer.from(JSON.stringify({ p: payload, m: mac })).toString('base64url');
  }

  #open(p: Principal, fp: string, raw: string): { after: string | null; n: number } {
    try {
      const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { p: string; m: string };
      const want = createHmac('sha256', this.#cursorKey)
        .update(`${p.workspaceId}|${p.membershipId}|${fp}|${o.p}`)
        .digest()
        .subarray(0, 16);
      const got = Buffer.from(o.m, 'base64url');
      if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error();
      const c = JSON.parse(o.p) as { after: string | null; n: number };
      if (
        !(c.after === null || typeof c.after === 'string') ||
        !Number.isInteger(c.n) ||
        c.n < 0 ||
        c.n > this.ws.metricsDrillResultsMax
      )
        throw new Error();
      return c;
    } catch {
      throw new TenancyError('cursor_invalid');
    }
  }

  async getMetricRecords(caller: Caller, ws: unknown, metric: unknown, query: Record<string, unknown>) {
    const q = this.#params(query, true);
    const def = this.#definition(metric, q.version);
    return this.trackMetric('records', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        await this.metricsLimit(p);
        const c = await this.#context(tx, p, def, q);
        const role = q.member;
        const spec = role ? def.drill.find((d) => d.role === role) : undefined;
        if (!spec || (role === 'unassigned' && p.kind !== 'member'))
          throw invalid(issue('/member', 'invalid_option', 'Choose which records to list.'));
        const limit = q.limit ?? Math.min(20, this.ws.metricsDrillPageMax);
        const fp = this.#fingerprint(c, spec.role);
        const cur = q.cursor ? this.#open(p, fp, q.cursor) : { after: null, n: 0 };
        const reach = Math.max(this.ws.metricsDrillResultsMax - cur.n, 0);
        const take = Math.min(limit, reach);
        const total = await this.#recordTotal(c, spec.role);
        const page =
          spec.records === 'project'
            ? await this.#projectPage(c, spec.role, cur, take)
            : spec.records === 'deliverable'
              ? await this.#deliverablePage(c, spec.role, cur, take)
              : await this.#taskPage(c, spec.role, cur, take);
        const shown = cur.n + page.items.length;
        const more = page.more && shown < this.ws.metricsDrillResultsMax;
        return {
          definition: this.#definitionView(def),
          member: { role: spec.role, label: spec.label, records: spec.records },
          scope: this.#scopeView(c),
          window: c.window ? { from: c.window.local.from, to: c.window.local.to, days: c.window.local.days } : null,
          as_of: iso(c.asOf),
          total,
          items: page.items,
          page: {
            limit: take,
            next_cursor: more && page.last ? this.#seal(p, fp, { after: page.last, n: shown }) : null,
            truncated: page.more && !more,
          },
        };
      }),
    );
  }

  async #recordTotal(c: Ctx, role: string): Promise<number> {
    const spec = c.def.drill.find((d) => d.role === role)!;
    if (spec.records === 'project') return (await this.#projectRole(c, role)).length;
    if (spec.records === 'deliverable') {
      const n = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${this.#deliverableFrom(c)} AND d.state = ${role}`.execute(c.tx.db);
      return Number(n.rows[0]!.n);
    }
    const ids = this.#ids(c, role);
    if (!ids) return 0;
    const n = await sql<{ n: string }>`SELECT count(*)::text AS n FROM (${ids}) m`.execute(c.tx.db);
    return Number(n.rows[0]!.n);
  }

  async #markers(c: Ctx, brandIds: string[]) {
    const rows = await readableBrandsByIds(c.tx, c.p, [...new Set(brandIds)]);
    return new Map(rows.map((b) => [b.id, brandMarker(b)]));
  }

  async #taskPage(c: Ctx, role: string, cur: { after: string | null }, take: number) {
    const ids = this.#ids(c, role);
    if (!ids || take <= 0) return { items: [], more: false, last: null as string | null };
    const rows = (
      await sql<{
        id: string;
        public_id: string;
        title: string;
        brand_id: string;
        status_category: string;
        due: string | null;
        project_public: string | null;
        project_name: string | null;
        parent_public: string | null;
      }>`
        SELECT t.id, r.public_id, t.title, t.brand_id, t.status_category,
               LEAST(t.due_date, t.deadline_date, (t.deadline_at AT TIME ZONE t.deadline_tz)::date)::text AS due,
               pr.public_id AS project_public, pw.name AS project_name, par.public_id AS parent_public
          FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
          LEFT JOIN work.project pw ON pw.workspace_id = t.workspace_id AND pw.id = t.project_id
          LEFT JOIN core.record pr ON pr.workspace_id = pw.workspace_id AND pr.id = pw.id AND ${c.vis.where('pr', { project: sql`pw.id` })}
          LEFT JOIN core.record par ON par.workspace_id = t.workspace_id AND par.id = t.parent_task_id
         WHERE t.workspace_id = ${c.ws} AND t.id IN (${ids}) ${cur.after ? sql`AND t.id > ${cur.after}::uuid` : sql``}
         ORDER BY t.id LIMIT ${take + 1}`.execute(c.tx.db)
    ).rows;
    const more = rows.length > take;
    const shown = rows.slice(0, take);
    const marks = await this.#markers(c, shown.map((r) => r.brand_id));
    return {
      items: shown.map((r) => ({
        record: { type: 'task' as const, id: r.public_id },
        title: r.title,
        brand: marks.get(r.brand_id) ?? null,
        project: r.project_public && r.project_name ? { id: r.project_public, name: r.project_name } : null,
        status: { category: r.status_category },
        due: r.due,
      })),
      more,
      last: shown.at(-1)?.id ?? null,
    };
  }

  async #deliverablePage(c: Ctx, role: string, cur: { after: string | null }, take: number) {
    if (take <= 0) return { items: [], more: false, last: null as string | null };
    const rows = (
      await sql<{ id: string; public_id: string; title: string; state: string; brand_id: string; task_public: string; task_title: string }>`
        SELECT d.id, dr.public_id, d.title, d.state, t.brand_id, r.public_id AS task_public, t.title AS task_title
          FROM ${this.#deliverableFrom(c)} AND d.state = ${role} ${cur.after ? sql`AND d.id > ${cur.after}::uuid` : sql``}
         ORDER BY d.id LIMIT ${take + 1}`.execute(c.tx.db)
    ).rows;
    const more = rows.length > take;
    const shown = rows.slice(0, take);
    const marks = await this.#markers(c, shown.map((r) => r.brand_id));
    return {
      items: shown.map((r) => ({
        record: { type: 'deliverable' as const, id: r.public_id },
        title: r.title,
        brand: marks.get(r.brand_id) ?? null,
        project: null,
        status: { state: r.state },
        host: { type: 'task' as const, id: r.task_public, title: r.task_title },
        due: null,
      })),
      more,
      last: shown.at(-1)?.id ?? null,
    };
  }

  async #projectPage(c: Ctx, role: string, cur: { after: string | null; n: number }, take: number) {
    if (take <= 0) return { items: [], more: false, last: null as string | null };
    const all = (await this.#projectRole(c, role)).sort((a, b) => a.name.localeCompare(b.name) || a.public_id.localeCompare(b.public_id));
    const from = cur.n;
    const slice = all.slice(from, from + take);
    const marks = await this.#markers(c, slice.map((r) => r.brand_id));
    return {
      items: slice.map((r) => ({
        record: { type: 'project' as const, id: r.public_id },
        title: r.name,
        brand: marks.get(r.brand_id) ?? null,
        project: null,
        status: { category: r.status },
        due: null,
      })),
      more: from + take < all.length,
      last: slice.length ? `${from + slice.length}` : null,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Export: the same figure, as rows (formula-safe CSV)
  // ---------------------------------------------------------------------------------------------

  async exportMetric(caller: Caller, ws: unknown, metric: unknown, query: Record<string, unknown>) {
    const result = await this.getMetric(caller, ws, metric, query);
    return this.trackMetric('export', async () => ({
      filename: `${result.definition.id}-v${result.definition.version}.csv`,
      body: this.#toCsv(result),
    }));
  }

  #toCsv(r: MetricResult): string {
    const rows: unknown[][] = [
      ['metric', r.definition.id],
      ['version', r.definition.version],
      ['definition_digest', r.definition.digest],
      ['scope', r.scope.kind],
      ['brand', (r.scope.brand as { name?: string } | null)?.name ?? ''],
      ['project', r.scope.project?.name ?? ''],
      ['window_from', r.window?.from ?? ''],
      ['window_to', r.window?.to ?? ''],
      ['as_of', r.as_of],
      ['timezone', r.timezone ?? ''],
      ['state', r.state],
      ['freshness', r.freshness.state],
      ['result_digest', r.reproducibility.result_digest],
    ];
    const flat = (prefix: string, v: unknown) => {
      if (v === null || v === undefined) rows.push([prefix, '']);
      else if (Array.isArray(v)) v.forEach((x, i) => flat(`${prefix}.${i}`, x));
      else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) flat(`${prefix}.${k}`, x);
      else rows.push([prefix, v]);
    };
    flat('value', r.value);
    if (r.parts) flat('parts', r.parts);
    r.incomplete.forEach((i, n) => rows.push([`incomplete.${n}`, `${i.code}${i.count === null ? '' : ` (${i.count})`}: ${i.message}`]));
    flat('groups', r.groups);
    r.drill.members.forEach((m) => rows.push([`records.${m.role}`, m.count]));
    return csv(['field', 'value'], rows);
  }

  // ---------------------------------------------------------------------------------------------
  // Recovery: ask for a reconciliation pass now
  // ---------------------------------------------------------------------------------------------

  async requestReconcile(caller: Caller, ws: unknown) {
    return this.trackMetric('reconcile', () =>
      this.inWorkspace(caller, ws, {}, async (tx, p) => {
        this.requireWorkspace(p, 'workspace.configure');
        await this.metricsLimit(p);
        // The API may only ask for a pass sooner; attempts and failure state are the worker's own.
        await sql`UPDATE metrics.reconcile_state SET next_run_at = now()
                   WHERE workspace_id = ${tx.workspaceId}`.execute(tx.db);
        return { requested: true as const };
      }),
    );
  }
}
