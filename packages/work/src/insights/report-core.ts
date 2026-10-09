import { randomBytes } from 'node:crypto';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  decideBrand,
  decidePersonal,
  decideProject,
  decideWorkspace,
  decideRecord,
  levelRank,
  recordLevel,
  TenancyError,
  type Level,
  type Principal,
  type ProjectChain,
} from '@pm/tenancy';
import type { ActionKey } from '@pm/contracts';
import { MetricService } from '../metrics/metric-service.ts';
import { NIL_ID } from '../service.ts';
import { isPublic } from '../validation.ts';
import type { Issues } from '@pm/tenancy';
import {
  DEFERRED_METRICS,
  PROVIDERS,
  evaluate,
  providerOf,
  type MetricContext,
  type MetricHost,
  type MetricValue,
  type ReportScope,
} from './metrics.ts';
import {
  EMPTY_FILTERS,
  type DashboardFilters,
  type DashboardKindKey,
  type Layout,
  type RenderedTable,
  type Schedule,
  type WidgetSpec,
} from './semantics.ts';
import type { ParamsParser, ParseContext } from './validation.ts';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export interface DashboardRow {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: 'active' | 'archived' | 'trashed' | 'purged';
  project_id: string | null;
  kind: DashboardKindKey;
  title: string;
  description: string | null;
  owner_membership_id: string;
  layout: Layout;
  filters: DashboardFilters;
  created_at: Date;
  updated_at: Date;
  version: number;
  public_id: string;
}

export interface ReportRow {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: 'active' | 'archived' | 'trashed' | 'purged';
  project_id: string | null;
  title: string;
  description: string | null;
  owner_membership_id: string;
  config: { v: 1; widgets: WidgetSpec[]; filters?: DashboardFilters };
  schedule_frequency: Schedule['frequency'] | null;
  schedule_weekday: number | null;
  schedule_monthday: number | null;
  schedule_minute: number | null;
  schedule_timezone: string | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  claimed_until: Date | null;
  attempts: number;
  last_error: string | null;
  suspended_reason: 'owner_authority' | 'owner_departed' | 'admin' | null;
  suspended_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  public_id: string;
}

export interface ShareRow {
  id: string;
  public_id: string;
  report_id: string;
  grantee_membership_id: string;
  created_by_membership_id: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

type Brand = Awaited<ReturnType<InsightsCore['brandFactsOf']>>;

export interface LoadedInsight<R> {
  id: string;
  publicId: string;
  brand: Brand['facts'] | null;
  brandMarker: Brand['marker'] | null;
  chain: ProjectChain;
  projectId: string | null;
  lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
  /** The placement level; null when the reader has the report only through a share. */
  level: Level | null;
  share: ShareRow | null;
  row: R;
}
export type LoadedDashboard = LoadedInsight<DashboardRow>;
export type LoadedReport = LoadedInsight<ReportRow>;

export type WidgetOutcome =
  | ({ state: 'ok' } & MetricValue)
  | {
      state: 'unavailable';
      metric: string;
      reason: 'no_access' | 'not_available' | 'not_for_guests';
      message: string;
    }
  | { state: 'error'; metric: string; message: string };

const INCOMPLETE_WORDS: Record<string, string> = {
  count_capped: 'The count stopped at its limit; the true number is higher.',
  groups_truncated: 'Some groups are not shown.',
  rows_truncated: 'Only the first rows are shown.',
  estimates_missing: 'Some items have no estimate and are not counted.',
  no_measurement: 'Some items have no measurement yet.',
  source_stale: 'The source has not updated recently.',
};

/**
 * Phase 5D, part one (ADR-0031): resolution, authorization, and the evaluation of widgets.
 * Dashboards and reports are records in the core envelope; their access is the placement's, and a
 * report may also be opened through an explicit, revocable share. No stored value is ever a figure:
 * every widget is computed for the caller, from what the caller may read, when it is requested.
 */
export class InsightsCore extends MetricService {
  protected iTrack<T>(
    kind: 'insights.reads' | 'insights.changes',
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const labels = (outcome: string): Record<string, string> =>
      kind === 'insights.reads' ? { view: label, outcome } : { kind: label, outcome };
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

  /** Dashboards and reports are for members; a guest reaches a report only through a share. */
  protected requireInsightsMember(p: Principal): void {
    if (p.kind !== 'member') throw new TenancyError('forbidden');
  }

  // ---------------------------------------------------------------------------------------------
  // Metric host and parameters
  // ---------------------------------------------------------------------------------------------

  protected get metricHost(): MetricHost {
    return {
      settings: this.ws,
      today: (tx) => this.workspaceToday(tx),
      weekStart: async (tx) => (await this.workspaceCalendar(tx)).weekStart,
      query: (tx, p, raw, opts) =>
        this.runQuery(tx, p, raw as never, {
          entity: opts.entity,
          limit: opts.limit,
          cursor: opts.cursor,
          includeTotal: true,
          groups: opts.groups,
        }),
      goals: (tx, p, q, limit) => this.goalPage(tx, p, q, limit) as never,
      timeReport: (tx, p, q, g) => this.timeReportIn(tx, p, q, g),
      teamCapacity: (tx, p, q) => this.teamCapacityIn(tx, p, q),
      dailyRecords: (tx, p, q) => this.dailyRecordsIn(tx, p, q),
      workVisibility: (tx, p) => this.workVisibility(tx, p) as never,
      metricFigure: (tx, p, metric, query) => this.figureIn(tx, p, metric, query),
      metricRecords: (tx, p, metric, query) => this.recordsIn(tx, p, metric, query),
      seal: (p, fp, pos) => this.goalSeal(p, fp, pos),
      open: (p, fp, raw) => this.goalOpen(p, fp, raw),
    };
  }

  protected get paramsParser(): ParamsParser {
    return (metric, raw, pointer, issues: Issues) => {
      const provider = providerOf(metric);
      if (provider) return provider.parse(raw, pointer, issues);
      const deferred = DEFERRED_METRICS.find((m) => m.key === metric);
      issues.add(
        pointer.replace(/\/params$/, '/metric'),
        deferred ? 'not_available' : 'unknown_metric',
        deferred ? deferred.reason : 'Choose a metric from the catalog.',
      );
      return null;
    };
  }

  protected get parseCtx(): ParseContext {
    return { maxWidgets: this.ws.dashboardWidgetsMax, params: this.paramsParser };
  }

  /** The metric catalog (RPT-017): what can be placed, and what is not yet available and why. */
  metricCatalog(guest: boolean) {
    return {
      metrics: PROVIDERS.filter((m) => !guest || m.guestSafe).map((m) => ({
        key: m.key,
        version: m.version,
        label: m.label,
        description: m.description,
        category: m.category,
        unit: m.unit,
        source: m.source,
        applies: m.applies,
      })),
      not_available: guest
        ? []
        : DEFERRED_METRICS.map((m) => ({
            key: m.key,
            label: m.label,
            requirement: m.requirement,
            owner_phase: m.owner,
            reason: m.reason,
          })),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------------------------

  protected toDashboardRow(row: Record<string, unknown> & { public_id: string }): DashboardRow {
    const r = row as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      ...(r as unknown as DashboardRow),
      layout: normalizeLayout(r.layout),
      filters: normalizeFilters(r.filters),
      created_at: new Date(r.created_at),
      updated_at: new Date(r.updated_at),
      version: Number(r.version),
    };
  }

  protected toReportRow(row: Record<string, unknown> & { public_id: string }): ReportRow {
    const r = row as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cfg = normalizeLayout(r.config);
    return {
      ...(r as unknown as ReportRow),
      config: {
        ...cfg,
        filters: normalizeFilters((r.config as { filters?: unknown } | null)?.filters),
      },
      next_run_at: r.next_run_at ? new Date(r.next_run_at) : null,
      last_run_at: r.last_run_at ? new Date(r.last_run_at) : null,
      claimed_until: r.claimed_until ? new Date(r.claimed_until) : null,
      suspended_at: r.suspended_at ? new Date(r.suspended_at) : null,
      created_at: new Date(r.created_at),
      updated_at: new Date(r.updated_at),
      attempts: Number(r.attempts),
      version: Number(r.version),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Resolution and authorization
  // ---------------------------------------------------------------------------------------------

  protected async unknownInsight(tx: WorkspaceTransaction): Promise<never> {
    // An unknown identifier runs the same statements as one the caller cannot read.
    await this.brandFactsOf(tx, NIL_ID).catch(() => undefined);
    await this.chainOfProject(tx, null);
    throw new TenancyError('not_found');
  }

  protected async placementOf(
    tx: WorkspaceTransaction,
    brandId: string | null,
    projectId: string | null,
  ) {
    let brand: Brand['facts'] | null = null;
    let marker: Brand['marker'] | null = null;
    if (brandId) {
      const b = await this.brandFactsOf(tx, brandId);
      brand = b.facts;
      marker = b.marker;
    } else await this.brandFactsOf(tx, NIL_ID).catch(() => undefined);
    const chain = await this.chainOfProject(tx, projectId);
    return { brand, marker, chain };
  }

  /** One dashboard by public ID through the compiled level; personal ones belong to their owner. */
  protected async loadDashboard(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    opts: { lock?: boolean; allowTrashed?: boolean } = {},
  ): Promise<LoadedDashboard> {
    if (!isPublic(publicId, 'dash')) return this.unknownInsight(tx);
    let q = tx.db
      .selectFrom('core.record as r')
      .innerJoin('insights.dashboard as d', (j) =>
        j.onRef('d.workspace_id', '=', 'r.workspace_id').onRef('d.id', '=', 'r.id'),
      )
      .selectAll('d')
      .select(['r.public_id'])
      .where('r.public_id', '=', publicId)
      .where('r.record_type', '=', 'dashboard');
    if (opts.lock) q = q.forUpdate('d');
    const row = await q.executeTakeFirst();
    if (!row) return this.unknownInsight(tx);
    const place = await this.placementOf(tx, row.brand_id, row.project_id);
    const trashed = row.lifecycle_state === 'trashed';
    if (trashed && !opts.allowTrashed) throw new TenancyError('not_found');
    const lifecycleState = trashed ? 'active' : row.lifecycle_state;
    const level = recordLevel(p, {
      brand: place.brand,
      lifecycleState,
      projectChain: place.chain,
      shareLevel: null,
    });
    if (p.kind !== 'member') throw new TenancyError('not_found');
    const personal = row.kind === 'personal';
    // A personal dashboard is its owner's alone (no administrator or other member reads it).
    if (personal ? row.owner_membership_id !== p.membershipId : level === null)
      throw new TenancyError('not_found');
    if (trashed && !personal && levelRank(level!) < levelRank('edit'))
      throw new TenancyError('not_found');
    return {
      id: row.id,
      publicId: row.public_id,
      brand: place.brand,
      brandMarker: place.marker,
      chain: place.chain,
      projectId: row.project_id,
      lifecycleState: row.lifecycle_state,
      level: level ?? 'view',
      share: null,
      row: this.toDashboardRow(row as never),
    };
  }

  protected async activeShareOf(
    tx: WorkspaceTransaction,
    reportId: string,
    membershipId: string,
  ): Promise<ShareRow | null> {
    const s = await tx.db
      .selectFrom('insights.report_share')
      .selectAll()
      .where('report_id', '=', reportId)
      .where('grantee_membership_id', '=', membershipId)
      .where('revoked_at', 'is', null)
      .where(sql<boolean>`(expires_at IS NULL OR expires_at > now())`)
      .executeTakeFirst();
    return (s as ShareRow | undefined) ?? null;
  }

  /**
   * One report by public ID: through the placement's level, or else through an active share.
   * Unreadable and unknown are one `not_found`.
   */
  protected async loadReport(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    opts: { lock?: boolean; allowTrashed?: boolean } = {},
  ): Promise<LoadedReport> {
    if (!isPublic(publicId, 'rpt')) return this.unknownInsight(tx);
    let q = tx.db
      .selectFrom('core.record as r')
      .innerJoin('insights.report_definition as d', (j) =>
        j.onRef('d.workspace_id', '=', 'r.workspace_id').onRef('d.id', '=', 'r.id'),
      )
      .selectAll('d')
      .select(['r.public_id'])
      .where('r.public_id', '=', publicId)
      .where('r.record_type', '=', 'report_definition');
    if (opts.lock) q = q.forUpdate('d');
    const row = await q.executeTakeFirst();
    if (!row) return this.unknownInsight(tx);
    const place = await this.placementOf(tx, row.brand_id, row.project_id);
    const trashed = row.lifecycle_state === 'trashed';
    if (trashed && !opts.allowTrashed) throw new TenancyError('not_found');
    const lifecycleState = trashed ? 'active' : row.lifecycle_state;
    const level =
      p.kind === 'member'
        ? recordLevel(p, {
            brand: place.brand,
            lifecycleState,
            projectChain: place.chain,
            shareLevel: null,
          })
        : null;
    let share: ShareRow | null = null;
    if (level === null && !trashed && row.lifecycle_state === 'active')
      share = await this.activeShareOf(tx, row.id, p.membershipId);
    if (level === null && !share) throw new TenancyError('not_found');
    if (trashed && levelRank(level!) < levelRank('edit')) throw new TenancyError('not_found');
    return {
      id: row.id,
      publicId: row.public_id,
      brand: place.brand,
      brandMarker: place.marker,
      chain: place.chain,
      projectId: row.project_id,
      lifecycleState: row.lifecycle_state,
      level,
      share,
      row: this.toReportRow(row as never),
    };
  }

  protected requireInsightAction(
    p: Principal,
    action: ActionKey,
    g: Pick<LoadedInsight<unknown>, 'brand' | 'chain' | 'lifecycleState' | 'level'>,
    opts: { lifecycleState?: LoadedInsight<unknown>['lifecycleState'] } = {},
  ): void {
    if (g.level === null) throw new TenancyError('not_found');
    const o = decideRecord(p, action, {
      brand: g.brand,
      lifecycleState: opts.lifecycleState ?? g.lifecycleState,
      shareLevel: null,
      projectChain: g.chain,
    });
    this.decision(action, o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  /** `report.schedule` is decided at the report's own scope: project, brand, or workspace. */
  protected requireScheduleAction(
    p: Principal,
    g: Pick<LoadedInsight<{ project_id: string | null }>, 'brand' | 'chain' | 'level' | 'row'>,
  ): void {
    if (g.level === null) throw new TenancyError('not_found');
    const o = g.row.project_id
      ? decideProject(p, 'report.schedule', {
          brand: g.brand!,
          lifecycleState: 'active',
          chain: g.chain,
        })
      : g.brand
        ? decideBrand(p, 'report.schedule', { ...g.brand, lifecycleState: 'active' })
        : decideWorkspace(p, 'report.schedule');
    this.decision('report.schedule', o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  protected scheduleAllows(
    p: Principal,
    g: Pick<LoadedInsight<{ project_id: string | null }>, 'brand' | 'chain' | 'level' | 'row'>,
  ): boolean {
    try {
      this.requireScheduleAction(p, g);
      return true;
    } catch (err) {
      if (err instanceof TenancyError) return false;
      throw err;
    }
  }

  protected personalAllowed(p: Principal): boolean {
    return decidePersonal(p, 'personal.manage_own').allowed;
  }

  /** A person manages their own personal dashboards (`personal.manage_own`). */
  protected requirePersonalDashboard(p: Principal): void {
    const o = decidePersonal(p, 'personal.manage_own');
    this.decision('personal.manage_own', o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  protected insightAllows(
    p: Principal,
    action: ActionKey,
    g: Pick<LoadedInsight<unknown>, 'brand' | 'chain' | 'lifecycleState' | 'level'>,
    opts: { lifecycleState?: LoadedInsight<unknown>['lifecycleState'] } = {},
  ): boolean {
    try {
      this.requireInsightAction(p, action, g, opts);
      return true;
    } catch (err) {
      if (err instanceof TenancyError) return false;
      throw err;
    }
  }

  protected requireInsightActive(
    g: Pick<LoadedInsight<unknown>, 'lifecycleState'>,
    what: string,
  ): void {
    if (g.lifecycleState !== 'active')
      throw new TenancyError('conflict', {
        issues: [
          {
            pointer: '/',
            code: `${what}_archived`,
            message: `This ${what} is archived. Restore it to make changes.`,
          },
        ],
      });
  }

  // ---------------------------------------------------------------------------------------------
  // Scope and evaluation
  // ---------------------------------------------------------------------------------------------

  protected async publicProject(tx: WorkspaceTransaction, projectId: string) {
    const r = await sql<{ public_id: string; name: string }>`
      SELECT r.public_id, w.name FROM work.project w JOIN core.record r ON r.workspace_id = w.workspace_id AND r.id = w.id
       WHERE w.workspace_id = ${tx.workspaceId} AND w.id = ${projectId}`.execute(tx.db);
    return r.rows[0] ? { id: r.rows[0].public_id, name: r.rows[0].name } : null;
  }

  /** What a figure is computed over: the placement, narrowed, never widened. */
  protected async insightScope(
    tx: WorkspaceTransaction,
    p: Principal,
    row: { brand_id: string | null; project_id: string | null },
    kind: 'workspace' | 'brand' | 'project' | 'personal',
    reach: { shared: boolean },
  ): Promise<ReportScope> {
    const scope: ReportScope = {
      kind,
      brand: null,
      project: null,
      ...(reach.shared ? { shared: true } : {}),
      ...(p.kind === 'guest' ? { guest: true } : {}),
    };
    if (row.brand_id) {
      const b = await this.brandFactsOf(tx, row.brand_id);
      scope.brand = { id: b.facts.publicId, name: reach.shared ? '' : b.facts.name };
    }
    if (row.project_id) {
      const pr = await this.publicProject(tx, row.project_id);
      if (pr) scope.project = { id: pr.id, name: reach.shared ? '' : pr.name };
    }
    return scope;
  }

  protected async metricContext(
    tx: WorkspaceTransaction,
    p: Principal,
    scope: ReportScope,
    filters: DashboardFilters,
  ): Promise<MetricContext> {
    const host = this.metricHost;
    return {
      tx,
      p,
      host,
      scope,
      filters,
      today: await host.today(tx),
      weekStart: await host.weekStart(tx),
      now: new Date(),
    };
  }

  /** Runs `fn` so that a failing statement cannot poison the transaction for the next widget. */
  protected async isolated<T>(tx: WorkspaceTransaction, fn: () => Promise<T>): Promise<T> {
    const name = `w_${randomBytes(6).toString('hex')}`;
    await sql`SAVEPOINT ${sql.raw(name)}`.execute(tx.db);
    try {
      const out = await fn();
      await sql`RELEASE SAVEPOINT ${sql.raw(name)}`.execute(tx.db);
      return out;
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT ${sql.raw(name)}`.execute(tx.db);
      throw err;
    }
  }

  /** One widget for the caller (RPT-017). A widget that cannot be shown says why, never what it hid. */
  protected async evaluateWidget(ctx: MetricContext, spec: WidgetSpec): Promise<WidgetOutcome> {
    const provider = providerOf(spec.metric);
    const count = (outcome: string) =>
      this.d.metrics.count('insights.widgets', 1, { metric: spec.metric, outcome });
    if (!provider) {
      count('not_available');
      return {
        state: 'unavailable',
        metric: spec.metric,
        reason: 'not_available',
        message: 'This metric is not available.',
      };
    }
    if (ctx.p.kind === 'guest' && !provider.guestSafe) {
      count('not_for_guests');
      return {
        state: 'unavailable',
        metric: spec.metric,
        reason: 'not_for_guests',
        message: 'This widget is not available to you.',
      };
    }
    try {
      const out = await this.isolated(ctx.tx, () =>
        evaluate(provider, ctx, spec.params, this.ws.reportFreshnessMinutes),
      );
      count('ok');
      return { state: 'ok', ...out };
    } catch (err) {
      if (err instanceof TenancyError && (err.code === 'forbidden' || err.code === 'not_found')) {
        count('no_access');
        return {
          state: 'unavailable',
          metric: spec.metric,
          reason: 'no_access',
          message: 'This widget is not available to you.',
        };
      }
      count('error');
      this.d.logger.warn('insights.widget_failed', {
        component: 'insights',
        error_class: err instanceof Error ? err.name : 'Error',
        ...(err instanceof TenancyError ? { error_code: err.code } : {}),
      });
      return {
        state: 'error',
        metric: spec.metric,
        message: 'This widget could not be loaded. Try again.',
      };
    }
  }

  protected widgetOf(layout: Layout, id: unknown): WidgetSpec {
    const w = typeof id === 'string' ? layout.widgets.find((x) => x.id === id) : undefined;
    if (!w) throw new TenancyError('not_found');
    return w;
  }

  /** The widgets as plain tables (CSV, PDF, and email start here), every label included. */
  protected tablesOf(
    specs: readonly WidgetSpec[],
    outcomes: readonly WidgetOutcome[],
  ): RenderedTable[] {
    return specs.map((s, i) => {
      const o = outcomes[i]!;
      const provider = providerOf(s.metric);
      const title = s.title ?? provider?.label ?? s.metric;
      if (o.state !== 'ok')
        return { title, caption: '', columns: ['Status'], rows: [[o.message]], notes: [] };
      const caption = [
        o.covers,
        o.range ? o.range.label : null,
        `as of ${o.freshness.as_of.slice(0, 16).replace('T', ' ')} UTC (${o.freshness.basis === 'live' ? 'computed from current records' : 'derived'})`,
        `source: ${o.source.label}`,
      ]
        .filter(Boolean)
        .join(' · ');
      const notes = [
        ...o.incomplete.map((c) => INCOMPLETE_WORDS[c] ?? c),
        ...(o.estimated ? ['Contains estimated figures.'] : []),
        ...o.notes,
      ];
      return {
        title,
        caption,
        columns: o.columns.map((c) => c.label),
        rows: o.rows.map((r) => o.columns.map((c) => r.cells[c.key] ?? null)),
        notes,
      };
    });
  }

  protected async evaluateAll(
    ctx: MetricContext,
    specs: readonly WidgetSpec[],
  ): Promise<WidgetOutcome[]> {
    const out: WidgetOutcome[] = [];
    for (const s of specs) out.push(await this.evaluateWidget(ctx, s));
    return out;
  }

  protected widgetMeta(s: WidgetSpec) {
    const provider = providerOf(s.metric);
    return {
      id: s.id,
      metric: s.metric,
      title: s.title ?? provider?.label ?? s.metric,
      size: s.size,
      params: s.params,
      available: provider !== null,
    };
  }

  protected asOf(): string {
    return iso(new Date())!;
  }
}

function normalizeLayout(raw: unknown): { v: 1; widgets: WidgetSpec[] } {
  const o = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { widgets?: unknown } | null;
  return { v: 1, widgets: Array.isArray(o?.widgets) ? (o!.widgets as WidgetSpec[]) : [] };
}

function normalizeFilters(raw: unknown): DashboardFilters {
  const o = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Partial<DashboardFilters> | null;
  return { ...EMPTY_FILTERS, ...(o ?? {}) };
}
