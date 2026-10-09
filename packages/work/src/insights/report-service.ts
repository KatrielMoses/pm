import { createHash } from 'node:crypto';
import { AuditWriter, change, CommandContext } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type TenantDatabase, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import {
  bumpEpoch,
  compilePrincipal,
  decideBrand,
  decideRecord,
  decideWorkspace,
  findBrand,
  invalid,
  issue,
  parseIfMatch,
  requireVersion,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { activePerson, principalOf } from '../notify/access.ts';
import { afterFailure, retryDelayMs, type FailureClass } from '../notify/semantics.ts';
import { classifyTransportError, DeliveryError, type EmailProvider } from '../notify/transport.ts';
import { systemExec } from '../notify/system.ts';
import { csv } from '../time/semantics.ts';
import { InsightsCore, type LoadedDashboard, type LoadedReport } from './report-core.ts';
import { providerOf, type DrillPage, type MetricContext, type ReportScope } from './metrics.ts';
import {
  composeReportEmail,
  contentHash,
  describeSchedule,
  dueOccurrence,
  nextRun,
  renderPdf,
  reportLines,
  type DashboardFilters,
  type Layout,
  type Schedule,
  type WidgetSpec,
} from './semantics.ts';
import {
  parseDashboardCreate,
  parseDashboardUpdate,
  parseExportQuery,
  parseListQuery,
  parseRecipients,
  parseReportCreate,
  parseReportUpdate,
  parseScheduleInput,
  parseShare,
  parseWidgetQuery,
} from './validation.ts';

const NIL = '00000000-0000-7000-8000-000000000000';
const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const noteHash = (s: string) => ({ hash: sha(s) });
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

type InsightEvent =
  | 'insights.dashboard.created'
  | 'insights.dashboard.updated'
  | 'insights.report.created'
  | 'insights.report.updated'
  | 'insights.report.shared'
  | 'insights.report.share_revoked'
  | 'insights.report.schedule_changed'
  | 'insights.report.suspended'
  | 'insights.report.resumed';

/** What a delivery sweep needs besides the service itself (the 4B provider boundary). */
export interface DeliveryDeps {
  email: EmailProvider;
  origin: string;
}

export interface SweepResult {
  reports: number;
  delivered: number;
  skipped: number;
  failed: number;
  retried: number;
  suspended: number;
  purged: number;
}

/**
 * Phase 5D, part two (ADR-0030): dashboards, saved and shared reports, schedules, exports, and the
 * delivery sweep. Every figure a dashboard, an export, or an email carries is computed as the
 * person receiving it, at that moment, from the records that person may read; nothing computed for
 * one person is ever kept or reused for another.
 */
export class ReportService extends InsightsCore {
  // ---------------------------------------------------------------------------------------------
  // Audit, events, rooms
  // ---------------------------------------------------------------------------------------------

  protected async insightAudit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    g: { id: string; publicId: string; brandId: string | null },
    type: 'dashboard' | 'report_definition',
    changes: ReturnType<typeof change.plain>[],
  ) {
    return this.workAudit(
      tx,
      caller,
      p,
      action,
      { recordId: g.id, type, publicId: g.publicId },
      changes,
      g.brandId,
    );
  }

  protected async insightEvent(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    type: InsightEvent,
    aggregate: { type: 'insights.dashboard' | 'insights.report_definition'; id: string },
    data: Record<string, string | number | boolean | null>,
    brandId: string | null,
  ) {
    await this.workEvent(tx, caller, p, type, { ...aggregate, sequence: 0 }, data, brandId);
  }

  protected expectedInsightVersion(req: Mutation, body: { version: number | undefined }): number {
    const v = req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : body.version;
    if (v === undefined) throw new TenancyError('precondition_required');
    return v;
  }

  /** Where a new dashboard or report goes: the project's, a brand's, or the workspace's. */
  protected async insightPlacement(
    tx: WorkspaceTransaction,
    p: Principal,
    input: { brand: string | null; project: string | null },
  ) {
    if (input.project) {
      const pr = await this.loadProject(tx, p, input.project, { lock: true });
      this.requireActive(pr);
      this.requireCreateIn(p, { brand: pr.brand, project: pr, chain: pr.chain });
      return {
        brandId: pr.brand.id as string | null,
        projectId: pr.id as string | null,
        scopeKey: pr.brand.id,
      };
    }
    if (input.brand) {
      const b = await findBrand(tx, p, input.brand);
      const facts = { id: b.id, isSensitive: b.is_sensitive, lifecycleState: b.lifecycle_state };
      const o = decideBrand(p, 'record.create', { ...facts, lifecycleState: 'active' });
      this.decision('record.create', o);
      if (!o.allowed) throw new TenancyError(o.code);
      if (b.lifecycle_state !== 'active')
        throw new TenancyError('conflict', {
          issues: [issue('/brand', 'brand_archived', 'This brand is archived.')],
        });
      return { brandId: b.id as string | null, projectId: null as string | null, scopeKey: b.id };
    }
    const o = decideWorkspace(p, 'record.create');
    this.decision('record.create', o);
    if (!o.allowed) throw new TenancyError(o.code);
    return {
      brandId: null as string | null,
      projectId: null as string | null,
      scopeKey: tx.workspaceId,
    };
  }

  protected async requireDashboardRoom(
    tx: WorkspaceTransaction,
    scopeKey: string,
    projectId: string | null,
    personalOwner: string | null,
  ) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`insights.dash:${scopeKey}:${projectId ?? ''}:${personalOwner ?? ''}`}, 0))`.execute(
      tx.db,
    );
    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM insights.dashboard
       WHERE workspace_id = ${tx.workspaceId} AND lifecycle_state <> 'purged'
         AND ${
           personalOwner
             ? sql`kind = 'personal' AND owner_membership_id = ${personalOwner}`
             : sql`kind <> 'personal' AND scope_key = ${scopeKey} AND project_id IS NOT DISTINCT FROM ${projectId}`
         }`.execute(tx.db);
    const max = personalOwner ? this.ws.dashboardPersonalMax : this.ws.dashboardsPerScopeMax;
    if (Number(n.rows[0]?.n ?? 0) >= max)
      throw invalid(issue('/', 'too_many', `You can keep at most ${max} dashboards here.`));
  }

  protected async requireReportRoom(
    tx: WorkspaceTransaction,
    scopeKey: string,
    projectId: string | null,
  ) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`insights.report:${scopeKey}:${projectId ?? ''}`}, 0))`.execute(
      tx.db,
    );
    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM insights.report_definition
       WHERE workspace_id = ${tx.workspaceId} AND scope_key = ${scopeKey}
         AND project_id IS NOT DISTINCT FROM ${projectId} AND lifecycle_state <> 'purged'`.execute(
      tx.db,
    );
    if (Number(n.rows[0]?.n ?? 0) >= this.ws.reportsPerScopeMax)
      throw invalid(
        issue('/', 'too_many', `A scope can hold at most ${this.ws.reportsPerScopeMax} reports.`),
      );
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  protected insightScopeView(
    brandMarker: LoadedDashboard['brandMarker'],
    projectId: string | null,
    project: { id: string; name: string } | null,
  ) {
    if (projectId && brandMarker) return { kind: 'project' as const, brand: brandMarker, project };
    if (brandMarker) return { kind: 'brand' as const, brand: brandMarker };
    return { kind: 'workspace' as const };
  }

  protected async dashboardView(tx: WorkspaceTransaction, p: Principal, g: LoadedDashboard) {
    const r = g.row;
    const project = r.project_id ? await this.publicProject(tx, r.project_id) : null;
    const people = await this.goalPeople(tx, p, [r.owner_membership_id]);
    const personal = r.kind === 'personal';
    return {
      id: g.publicId,
      type: 'dashboard' as const,
      title: r.title,
      description: r.description,
      kind: r.kind,
      scope: personal
        ? { kind: 'personal' as const }
        : this.insightScopeView(g.brandMarker, r.project_id, project),
      owner: people.get(r.owner_membership_id) ?? null,
      widgets: r.layout.widgets.map((w) => this.widgetMeta(w)),
      filters: r.filters,
      lifecycle_state: r.lifecycle_state,
      capabilities: {
        update:
          g.lifecycleState === 'active' && (personal || this.insightAllows(p, 'record.update', g)),
        archive: this.insightAllows(p, 'record.archive', g, { lifecycleState: 'active' }),
        restore: this.insightAllows(p, 'record.restore', g, { lifecycleState: 'active' }),
        trash: this.insightAllows(p, 'record.trash', g, { lifecycleState: 'active' }),
        export: this.insightAllows(p, 'record.export', g),
      },
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
      version: r.version,
    };
  }

  protected scheduleOf(r: LoadedReport['row']): Schedule | null {
    return r.schedule_frequency
      ? {
          frequency: r.schedule_frequency,
          weekday: r.schedule_weekday,
          monthday: r.schedule_monthday,
          minute: r.schedule_minute!,
          timezone: r.schedule_timezone!,
        }
      : null;
  }

  protected async reportView(tx: WorkspaceTransaction, p: Principal, g: LoadedReport) {
    const r = g.row;
    const project = r.project_id ? await this.publicProject(tx, r.project_id) : null;
    const people = await this.goalPeople(tx, p, [r.owner_membership_id]);
    const canSchedule = this.insightAllows(p, 'report.schedule', g);
    const canShare = this.insightAllows(p, 'record.share', g);
    const sched = this.scheduleOf(r);
    const reached = g.level === null ? 'share' : 'placement';
    let recipients: number | null = null;
    let shares: number | null = null;
    let iAmRecipient = false;
    if (p.kind === 'member') {
      iAmRecipient =
        (
          await tx.db
            .selectFrom('insights.report_recipient')
            .select('membership_id')
            .where('report_id', '=', g.id)
            .where('membership_id', '=', p.membershipId)
            .executeTakeFirst()
        )?.membership_id !== undefined;
    }
    if (canSchedule)
      recipients = Number(
        (
          await sql<{ n: string }>`SELECT count(*)::text AS n FROM insights.report_recipient
            WHERE workspace_id = ${tx.workspaceId} AND report_id = ${g.id}`.execute(tx.db)
        ).rows[0]?.n ?? 0,
      );
    if (canShare)
      shares = Number(
        (
          await sql<{ n: string }>`SELECT count(*)::text AS n FROM insights.report_share
            WHERE workspace_id = ${tx.workspaceId} AND report_id = ${g.id} AND revoked_at IS NULL`.execute(
            tx.db,
          )
        ).rows[0]?.n ?? 0,
      );
    return {
      id: g.publicId,
      type: 'report' as const,
      title: r.title,
      description: r.description,
      scope:
        reached === 'share'
          ? { kind: 'shared' as const }
          : this.insightScopeView(g.brandMarker, r.project_id, project),
      owner: people.get(r.owner_membership_id) ?? null,
      widgets: r.config.widgets.map((w) => this.widgetMeta(w)),
      filters: r.config.filters,
      access: reached,
      schedule: sched
        ? {
            ...sched,
            description: describeSchedule(sched),
            next_run_at: iso(r.next_run_at),
            last_run_at: iso(r.last_run_at),
            suspended: r.suspended_reason
              ? { reason: r.suspended_reason, at: iso(r.suspended_at) }
              : null,
          }
        : null,
      subscribed: iAmRecipient,
      recipients_count: recipients,
      shares_count: shares,
      lifecycle_state: r.lifecycle_state,
      capabilities: {
        update:
          g.level !== null &&
          g.lifecycleState === 'active' &&
          this.insightAllows(p, 'record.update', g),
        schedule: g.lifecycleState === 'active' && canSchedule,
        share: g.lifecycleState === 'active' && canShare,
        archive: this.insightAllows(p, 'record.archive', g, { lifecycleState: 'active' }),
        restore: this.insightAllows(p, 'record.restore', g, { lifecycleState: 'active' }),
        trash: this.insightAllows(p, 'record.trash', g, { lifecycleState: 'active' }),
        export: g.level !== null && this.insightAllows(p, 'record.export', g),
      },
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
      version: r.version,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Dashboards: reads
  // ---------------------------------------------------------------------------------------------

  async insightMetrics(caller: Caller, ws: unknown) {
    return this.iTrack('insights.reads', 'catalog', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (_tx, p) =>
        this.metricCatalog(p.kind === 'guest'),
      ),
    );
  }

  async listDashboards(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const q = parseListQuery(query, this.ws.pageLimitMax, this.ws.pageLimitDefault);
    return this.iTrack('insights.reads', 'dashboards', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        this.requireInsightsMember(p);
        const vis = await this.goalVisibility(tx, p, false);
        const cond = [
          vis.where('r', { project: sql`d.project_id` }),
          sql`d.workspace_id = ${tx.workspaceId}`,
          sql`d.lifecycle_state = 'active'::core.lifecycle_state`,
          // Another member's personal dashboard is nobody else's to list.
          sql`(d.kind <> 'personal' OR d.owner_membership_id = ${p.membershipId})`,
        ];
        if (q.kind) cond.push(sql`d.kind = ${q.kind}`);
        if (q.brand) {
          const b = await tx.db
            .selectFrom('core.record')
            .select('id')
            .where('public_id', '=', q.brand)
            .where('record_type', '=', 'brand')
            .executeTakeFirst();
          cond.push(sql`d.brand_id = ${b?.id ?? NIL}`);
        }
        if (q.project) {
          const pr = await tx.db
            .selectFrom('core.record')
            .select('id')
            .where('public_id', '=', q.project)
            .where('record_type', '=', 'project')
            .executeTakeFirst();
          cond.push(sql`d.project_id = ${pr?.id ?? NIL}`);
        }
        const fp = this.goalFp('dashboards', q.kind, q.brand, q.project);
        if (q.cursor) {
          const pos = this.goalOpen(p, fp, q.cursor);
          cond.push(sql`(d.updated_at, d.id) < (${pos.k}::timestamptz, ${pos.id}::uuid)`);
        }
        const rows = await sql<
          Record<string, unknown> & { public_id: string; id: string; upd: string }
        >`
          SELECT d.*, r.public_id, d.updated_at::text AS upd
            FROM insights.dashboard d JOIN core.record r ON r.workspace_id = d.workspace_id AND r.id = d.id
           WHERE ${sql.join(cond, sql` AND `)}
           ORDER BY d.updated_at DESC, d.id DESC LIMIT ${q.limit + 1}`.execute(tx.db);
        const page = rows.rows.slice(0, q.limit);
        const more = rows.rows.length > q.limit;
        const data = [];
        for (const row of page) {
          const rr = this.toDashboardRow(row as never);
          const place = await this.placementOf(tx, rr.brand_id, rr.project_id);
          data.push(
            await this.dashboardView(tx, p, {
              id: rr.id,
              publicId: rr.public_id,
              brand: place.brand,
              brandMarker: place.marker,
              chain: place.chain,
              projectId: rr.project_id,
              lifecycleState: rr.lifecycle_state,
              level: 'view',
              share: null,
              row: rr,
            }),
          );
        }
        const last = page[page.length - 1];
        return {
          data,
          page: {
            limit: q.limit,
            has_more: more,
            ...(more && last
              ? { next_cursor: this.goalSeal(p, fp, { k: String(last.upd), id: last.id }) }
              : {}),
          },
        };
      }),
    );
  }

  async getDashboard(caller: Caller, ws: unknown, dash: unknown) {
    return this.iTrack('insights.reads', 'dashboard', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const g = await this.loadDashboard(tx, p, dash);
        return this.dashboardView(tx, p, g);
      }),
    );
  }

  protected dashboardScope(tx: WorkspaceTransaction, p: Principal, g: LoadedDashboard) {
    const kind =
      g.row.kind === 'personal'
        ? 'personal'
        : g.row.kind === 'project'
          ? 'project'
          : g.row.kind === 'owner'
            ? 'workspace'
            : 'brand';
    return this.insightScope(tx, p, g.row, kind, { shared: false });
  }

  async dashboardWidget(
    caller: Caller,
    ws: unknown,
    dash: unknown,
    widget: unknown,
    query: Record<string, unknown>,
  ) {
    const q = parseWidgetQuery(query, this.ws.pageLimitMax);
    return this.iTrack('insights.reads', 'widget', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const g = await this.loadDashboard(tx, p, dash);
        const spec = this.widgetOf(g.row.layout, widget);
        const filters = q.filters ?? g.row.filters;
        const ctx = await this.metricContext(tx, p, await this.dashboardScope(tx, p, g), filters);
        return {
          widget: this.widgetMeta(spec),
          filters,
          outcome: await this.evaluateWidget(ctx, spec),
        };
      }),
    );
  }

  protected async drillOf(
    ctx: MetricContext,
    spec: WidgetSpec,
    q: { cursor: string | null; limit: number | null },
  ): Promise<DrillPage & { widget: ReturnType<ReportService['widgetMeta']>; as_of: string }> {
    const provider = providerOf(spec.metric);
    if (!provider) throw new TenancyError('not_found');
    if (ctx.p.kind === 'guest' && !provider.guestSafe) throw new TenancyError('not_found');
    const out = await this.isolated(ctx.tx, () =>
      provider.drill(ctx, spec.params, {
        limit: q.limit ?? this.ws.pageLimitDefault,
        cursor: q.cursor,
      }),
    );
    const { coversText } = await import('./metrics.ts');
    return {
      ...out,
      covers: coversText(ctx.scope),
      widget: this.widgetMeta(spec),
      as_of: this.asOf(),
    };
  }

  async dashboardDrill(
    caller: Caller,
    ws: unknown,
    dash: unknown,
    widget: unknown,
    query: Record<string, unknown>,
  ) {
    const q = parseWidgetQuery(query, this.ws.pageLimitMax);
    return this.iTrack('insights.reads', 'drill', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const g = await this.loadDashboard(tx, p, dash);
        const spec = this.widgetOf(g.row.layout, widget);
        const ctx = await this.metricContext(
          tx,
          p,
          await this.dashboardScope(tx, p, g),
          q.filters ?? g.row.filters,
        );
        return this.drillOf(ctx, spec, q);
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Dashboards: changes
  // ---------------------------------------------------------------------------------------------

  async createDashboard(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = parseDashboardCreate(body, this.parseCtx);
    return this.iTrack('insights.changes', 'dashboard_create', () =>
      this.mutate(
        caller,
        'dashboard.create',
        ws,
        req,
        async (tx, p) => {
          this.requireInsightsMember(p);
          const personal = input.kind === 'personal';
          const place = await this.insightPlacement(tx, p, {
            brand: input.kind === 'brand' || input.kind === 'release' ? input.brand : null,
            project: input.kind === 'project' ? input.project : null,
          });
          await this.requireDashboardRoom(
            tx,
            place.scopeKey,
            place.projectId,
            personal ? p.membershipId : null,
          );
          const id = newUuidV7();
          const publicId = newPublicId('dash');
          const cmd = this.cmd(caller, p, place.brandId);
          await tx.db
            .insertInto('core.record')
            .values({
              id,
              public_id: publicId,
              record_type: 'dashboard',
              workspace_id: tx.workspaceId,
              brand_id: place.brandId,
              source_kind: 'ui',
              source_ref: null,
              created_by_actor_type: cmd.actor.type,
              created_by_actor_id: cmd.actor.id,
            })
            .execute();
          await tx.db
            .insertInto('insights.dashboard')
            .values({
              id,
              workspace_id: tx.workspaceId,
              brand_id: place.brandId,
              scope_key: place.scopeKey,
              project_id: place.projectId,
              kind: input.kind,
              title: input.title,
              description: input.description,
              owner_membership_id: p.membershipId,
              layout: JSON.stringify(input.layout),
              filters: JSON.stringify(input.filters),
              created_by_membership_id: p.membershipId,
              updated_by_membership_id: p.membershipId,
            })
            .execute();
          const target = { id, publicId, brandId: place.brandId };
          await this.insightAudit(tx, caller, p, 'dashboard.created', target, 'dashboard', [
            change.content('title', noteHash(input.title)),
            change.plain('kind', null, input.kind),
            change.plain('widgets', null, String(input.layout.widgets.length)),
          ]);
          await this.insightEvent(
            tx,
            caller,
            p,
            'insights.dashboard.created',
            { type: 'insights.dashboard', id },
            {
              kind: input.kind,
              scope: place.projectId ? 'project' : place.brandId ? 'brand' : 'workspace',
            },
            place.brandId,
          );
          return {
            status: 201,
            ref: { id: publicId, type: 'dashboard' },
            data: await this.dashboardView(tx, p, await this.loadDashboard(tx, p, publicId)),
          };
        },
        async (tx, p, ref) => this.dashboardView(tx, p, await this.loadDashboard(tx, p, ref.id)),
      ),
    );
  }

  async updateDashboard(caller: Caller, ws: unknown, dash: unknown, body: unknown, req: Mutation) {
    const input = parseDashboardUpdate(body, this.parseCtx);
    return this.iTrack('insights.changes', 'dashboard_update', () =>
      this.mutate(
        caller,
        'dashboard.update',
        ws,
        req,
        async (tx, p) => {
          this.requireInsightsMember(p);
          const g = await this.loadDashboard(tx, p, dash, { lock: true });
          this.requireInsightActive(g, 'dashboard');
          this.requireInsightAction(p, 'record.update', g);
          requireVersion(this.expectedInsightVersion(req, input), g.row.version);
          const set: Record<string, unknown> = {};
          const changes: ReturnType<typeof change.plain>[] = [];
          const names: string[] = [];
          if (input.title !== undefined && input.title !== g.row.title) {
            set.title = input.title;
            changes.push(change.content('title', noteHash(input.title)));
            names.push('title');
          }
          if (input.description !== undefined && input.description !== g.row.description) {
            set.description = input.description;
            changes.push(change.content('description', noteHash(input.description ?? '')));
            names.push('description');
          }
          if (input.layout !== undefined) {
            set.layout = JSON.stringify(input.layout);
            changes.push(
              change.plain(
                'widgets',
                String(g.row.layout.widgets.length),
                String(input.layout.widgets.length),
              ),
            );
            names.push('layout');
          }
          if (input.filters !== undefined) {
            set.filters = JSON.stringify(input.filters);
            changes.push(change.plain('filters', null, 'changed'));
            names.push('filters');
          }
          if (names.length) {
            await tx.db
              .updateTable('insights.dashboard')
              .set({
                ...set,
                updated_at: new Date(),
                updated_by_membership_id: p.membershipId,
                version: g.row.version + 1,
              } as never)
              .where('id', '=', g.id)
              .execute();
            await this.insightAudit(
              tx,
              caller,
              p,
              'dashboard.updated',
              { id: g.id, publicId: g.publicId, brandId: g.brand?.id ?? null },
              'dashboard',
              changes,
            );
            await this.insightEvent(
              tx,
              caller,
              p,
              'insights.dashboard.updated',
              { type: 'insights.dashboard', id: g.id },
              { change: names.join(',') },
              g.brand?.id ?? null,
            );
          }
          return {
            status: 200,
            ref: { id: g.publicId, type: 'dashboard' },
            data: await this.dashboardView(tx, p, await this.loadDashboard(tx, p, g.publicId)),
          };
        },
        async (tx, p, ref) => this.dashboardView(tx, p, await this.loadDashboard(tx, p, ref.id)),
      ),
    );
  }

  /** archive, unarchive, trash, restore, and purge: the shared lifecycle verbs for either record. */
  protected async insightLifecycle(
    caller: Caller,
    ws: unknown,
    id: unknown,
    kind: 'dashboard' | 'report',
    verb: 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge',
    req: Mutation,
  ) {
    const type = kind === 'dashboard' ? 'dashboard' : 'report_definition';
    return this.iTrack('insights.changes', `${kind}_${verb}`, () =>
      this.mutate(
        caller,
        `${kind}.${verb}`,
        ws,
        req,
        async (tx, p) => {
          this.requireInsightsMember(p);
          const opts = { lock: true, allowTrashed: verb === 'restore' || verb === 'purge' };
          const g: LoadedDashboard | LoadedReport =
            kind === 'dashboard'
              ? await this.loadDashboard(tx, p, id, opts)
              : await this.loadReport(tx, p, id, opts);
          if (g.level === null) throw new TenancyError('not_found');
          if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), g.row.version);
          const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
          const facts = {
            id: g.id,
            brand: g.brand,
            lifecycleState: g.lifecycleState,
            chain: g.chain,
          };
          const state = await tx.db
            .selectFrom('core.record')
            .select(['lifecycle_state', 'deletion_batch_id'])
            .where('id', '=', g.id)
            .executeTakeFirstOrThrow();
          const conflict = () =>
            new TenancyError('conflict', {
              issues: [
                issue('/', 'invalid_state', `This ${kind} can't do that in its current state.`),
              ],
            });
          if (verb === 'archive') {
            if (state.lifecycle_state !== 'active') throw conflict();
            await this.d.lifecycle.archive(
              tx,
              this.issueLifecycle(tx, p, 'record.archive', facts),
              input,
              g.id,
            );
          } else if (verb === 'unarchive') {
            if (state.lifecycle_state !== 'archived') throw conflict();
            await this.d.lifecycle.unarchive(
              tx,
              this.issueLifecycle(tx, p, 'record.restore', facts),
              input,
              g.id,
            );
          } else if (verb === 'trash') {
            if (state.lifecycle_state !== 'active' && state.lifecycle_state !== 'archived')
              throw conflict();
            await this.d.lifecycle.trash(
              tx,
              this.issueLifecycle(tx, p, 'record.trash', facts),
              input,
              g.id,
            );
            // A trashed report sends nothing: the schedule stops until it is restored and resumed.
            if (kind === 'report')
              await sql`UPDATE insights.report_definition SET claimed_until = NULL
                         WHERE workspace_id = ${tx.workspaceId} AND id = ${g.id}`.execute(tx.db);
          } else {
            if (state.lifecycle_state !== 'trashed') throw conflict();
            const own = await tx.db
              .selectFrom('core.deletion_batch')
              .select('id')
              .where('id', '=', state.deletion_batch_id!)
              .where('root_record_id', '=', g.id)
              .executeTakeFirst();
            if (!own) throw conflict();
            if (verb === 'restore')
              await this.d.lifecycle.restore(
                tx,
                this.issueLifecycle(tx, p, 'record.restore', facts),
                input,
                own.id,
              );
            else
              await this.d.lifecycle.requestPurge(
                tx,
                this.issueLifecycle(tx, p, 'record.purge', facts),
                input,
                own.id,
              );
          }
          await bumpEpoch(tx, 'workspace', null);
          const after = await tx.db
            .selectFrom('core.record')
            .select('lifecycle_state')
            .where('id', '=', g.id)
            .executeTakeFirstOrThrow();
          void type;
          return {
            status: verb === 'purge' ? 202 : 200,
            ref: { id: g.publicId, type: kind },
            data: { id: g.publicId, type: kind, lifecycle_state: after.lifecycle_state },
          };
        },
        async (tx, _p, ref) => {
          const r = await tx.db
            .selectFrom('core.record')
            .select(['public_id', 'lifecycle_state'])
            .where('public_id', '=', ref.id)
            .executeTakeFirstOrThrow();
          return { id: r.public_id, type: kind, lifecycle_state: r.lifecycle_state };
        },
      ),
    );
  }

  dashboardLifecycle(
    caller: Caller,
    ws: unknown,
    dash: unknown,
    verb: 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge',
    req: Mutation,
  ) {
    return this.insightLifecycle(caller, ws, dash, 'dashboard', verb, req);
  }

  reportLifecycle(
    caller: Caller,
    ws: unknown,
    report: unknown,
    verb: 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge',
    req: Mutation,
  ) {
    return this.insightLifecycle(caller, ws, report, 'report', verb, req);
  }

  // ---------------------------------------------------------------------------------------------
  // Reports: reads
  // ---------------------------------------------------------------------------------------------

  async listReports(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const q = parseListQuery(query, this.ws.pageLimitMax, this.ws.pageLimitDefault);
    return this.iTrack('insights.reads', 'reports', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const vis = p.kind === 'member' ? await this.goalVisibility(tx, p, false) : null;
        const shared = sql`EXISTS (SELECT 1 FROM insights.report_share s WHERE s.workspace_id = d.workspace_id
            AND s.report_id = d.id AND s.grantee_membership_id = ${p.membershipId} AND s.revoked_at IS NULL
            AND (s.expires_at IS NULL OR s.expires_at > now()))`;
        const cond = [
          sql`d.workspace_id = ${tx.workspaceId}`,
          sql`d.lifecycle_state = 'active'::core.lifecycle_state`,
          vis ? sql`(${vis.where('r', { project: sql`d.project_id` })} OR ${shared})` : shared,
        ];
        if (q.brand) {
          const b = await tx.db
            .selectFrom('core.record')
            .select('id')
            .where('public_id', '=', q.brand)
            .where('record_type', '=', 'brand')
            .executeTakeFirst();
          cond.push(sql`d.brand_id = ${b?.id ?? NIL}`);
        }
        if (q.project) {
          const pr = await tx.db
            .selectFrom('core.record')
            .select('id')
            .where('public_id', '=', q.project)
            .where('record_type', '=', 'project')
            .executeTakeFirst();
          cond.push(sql`d.project_id = ${pr?.id ?? NIL}`);
        }
        const fp = this.goalFp('reports', q.brand, q.project);
        if (q.cursor) {
          const pos = this.goalOpen(p, fp, q.cursor);
          cond.push(sql`(d.updated_at, d.id) < (${pos.k}::timestamptz, ${pos.id}::uuid)`);
        }
        const rows = await sql<
          Record<string, unknown> & { public_id: string; id: string; upd: string }
        >`
          SELECT d.*, r.public_id, d.updated_at::text AS upd
            FROM insights.report_definition d JOIN core.record r ON r.workspace_id = d.workspace_id AND r.id = d.id
           WHERE ${sql.join(cond, sql` AND `)}
           ORDER BY d.updated_at DESC, d.id DESC LIMIT ${q.limit + 1}`.execute(tx.db);
        const page = rows.rows.slice(0, q.limit);
        const more = rows.rows.length > q.limit;
        const data = [];
        for (const row of page)
          data.push(await this.reportView(tx, p, await this.loadReport(tx, p, row.public_id)));
        const last = page[page.length - 1];
        return {
          data,
          page: {
            limit: q.limit,
            has_more: more,
            ...(more && last
              ? { next_cursor: this.goalSeal(p, fp, { k: String(last.upd), id: last.id }) }
              : {}),
          },
        };
      }),
    );
  }

  async getReport(caller: Caller, ws: unknown, report: unknown) {
    return this.iTrack('insights.reads', 'report', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const g = await this.loadReport(tx, p, report);
        return this.reportView(tx, p, g);
      }),
    );
  }

  protected reportScope(tx: WorkspaceTransaction, p: Principal, g: LoadedReport) {
    const kind = g.row.project_id ? 'project' : g.row.brand_id ? 'brand' : 'workspace';
    return this.insightScope(tx, p, g.row, kind, { shared: g.level === null });
  }

  async reportWidget(
    caller: Caller,
    ws: unknown,
    report: unknown,
    widget: unknown,
    query: Record<string, unknown>,
  ) {
    const q = parseWidgetQuery(query, this.ws.pageLimitMax);
    return this.iTrack('insights.reads', 'widget', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const g = await this.loadReport(tx, p, report);
        const spec = this.widgetOf(g.row.config, widget);
        const filters = q.filters ?? g.row.config.filters!;
        const ctx = await this.metricContext(tx, p, await this.reportScope(tx, p, g), filters);
        return {
          widget: this.widgetMeta(spec),
          filters,
          outcome: await this.evaluateWidget(ctx, spec),
        };
      }),
    );
  }

  async reportDrill(
    caller: Caller,
    ws: unknown,
    report: unknown,
    widget: unknown,
    query: Record<string, unknown>,
  ) {
    const q = parseWidgetQuery(query, this.ws.pageLimitMax);
    return this.iTrack('insights.reads', 'drill', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const g = await this.loadReport(tx, p, report);
        const spec = this.widgetOf(g.row.config, widget);
        const ctx = await this.metricContext(
          tx,
          p,
          await this.reportScope(tx, p, g),
          q.filters ?? g.row.config.filters!,
        );
        return this.drillOf(ctx, spec, q);
      }),
    );
  }

  async listReportRuns(caller: Caller, ws: unknown, report: unknown) {
    return this.iTrack('insights.reads', 'runs', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        this.requireInsightsMember(p);
        const g = await this.loadReport(tx, p, report);
        this.requireInsightAction(p, 'report.schedule', g);
        const rows = await sql<{
          id: string;
          occurrence_at: Date;
          state: string;
          detail: string | null;
          row_count: number | null;
          incomplete: boolean;
          failure_class: string | null;
          finished_at: Date | null;
          recipient: string | null;
        }>`
          SELECT x.id, x.occurrence_at, x.state, x.detail, x.row_count, x.incomplete, x.failure_class,
                 x.finished_at, m.public_id AS recipient
            FROM insights.report_run x JOIN tenancy.membership m ON m.workspace_id = x.workspace_id AND m.id = x.recipient_membership_id
           WHERE x.workspace_id = ${tx.workspaceId} AND x.report_id = ${g.id}
           ORDER BY x.occurrence_at DESC, x.id DESC LIMIT ${this.ws.pageLimitMax}`.execute(tx.db);
        const names = await this.goalPeople(tx, p, []);
        void names;
        return {
          data: rows.rows.map((r) => ({
            id: r.id,
            type: 'report_run' as const,
            occurrence_at: iso(r.occurrence_at),
            recipient: r.recipient,
            state: r.state,
            detail: r.detail,
            rows: r.row_count,
            incomplete: r.incomplete,
            failure_class: r.failure_class,
            finished_at: iso(r.finished_at),
          })),
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Reports: changes
  // ---------------------------------------------------------------------------------------------

  async createReport(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = parseReportCreate(body, this.parseCtx);
    return this.iTrack('insights.changes', 'report_create', () =>
      this.mutate(
        caller,
        'report.create',
        ws,
        req,
        async (tx, p) => {
          this.requireInsightsMember(p);
          const place = await this.insightPlacement(tx, p, input);
          await this.requireReportRoom(tx, place.scopeKey, place.projectId);
          let ownerId = p.membershipId;
          if (input.owner) {
            const brand = place.brandId ? (await this.brandFactsOf(tx, place.brandId)).facts : null;
            const chain = await this.chainOfProject(tx, place.projectId);
            ownerId = (await this.goalOwner(tx, input.owner, { brand, chain })).id;
          }
          const id = newUuidV7();
          const publicId = newPublicId('rpt');
          const cmd = this.cmd(caller, p, place.brandId);
          await tx.db
            .insertInto('core.record')
            .values({
              id,
              public_id: publicId,
              record_type: 'report_definition',
              workspace_id: tx.workspaceId,
              brand_id: place.brandId,
              source_kind: 'ui',
              source_ref: null,
              created_by_actor_type: cmd.actor.type,
              created_by_actor_id: cmd.actor.id,
            })
            .execute();
          await tx.db
            .insertInto('insights.report_definition')
            .values({
              id,
              workspace_id: tx.workspaceId,
              brand_id: place.brandId,
              scope_key: place.scopeKey,
              project_id: place.projectId,
              title: input.title,
              description: input.description,
              owner_membership_id: ownerId,
              config: JSON.stringify({ ...input.layout, filters: input.filters }),
              created_by_membership_id: p.membershipId,
              updated_by_membership_id: p.membershipId,
              schedule_frequency: null,
              schedule_weekday: null,
              schedule_monthday: null,
              schedule_minute: null,
              schedule_timezone: null,
              next_run_at: null,
              last_run_at: null,
              claimed_until: null,
              last_error: null,
              suspended_reason: null,
              suspended_at: null,
            })
            .execute();
          await this.insightAudit(
            tx,
            caller,
            p,
            'report.created',
            { id, publicId, brandId: place.brandId },
            'report_definition',
            [
              change.content('title', noteHash(input.title)),
              change.plain('widgets', null, String(input.layout.widgets.length)),
            ],
          );
          await this.insightEvent(
            tx,
            caller,
            p,
            'insights.report.created',
            { type: 'insights.report_definition', id },
            { scope: place.projectId ? 'project' : place.brandId ? 'brand' : 'workspace' },
            place.brandId,
          );
          return {
            status: 201,
            ref: { id: publicId, type: 'report' },
            data: await this.reportView(tx, p, await this.loadReport(tx, p, publicId)),
          };
        },
        async (tx, p, ref) => this.reportView(tx, p, await this.loadReport(tx, p, ref.id)),
      ),
    );
  }

  async updateReport(caller: Caller, ws: unknown, report: unknown, body: unknown, req: Mutation) {
    const input = parseReportUpdate(body, this.parseCtx);
    return this.iTrack('insights.changes', 'report_update', () =>
      this.mutate(
        caller,
        'report.update',
        ws,
        req,
        async (tx, p) => {
          this.requireInsightsMember(p);
          const g = await this.loadReport(tx, p, report, { lock: true });
          this.requireInsightActive(g, 'report');
          this.requireInsightAction(p, 'record.update', g);
          requireVersion(this.expectedInsightVersion(req, input), g.row.version);
          const set: Record<string, unknown> = {};
          const changes: ReturnType<typeof change.plain>[] = [];
          const names: string[] = [];
          if (input.title !== undefined && input.title !== g.row.title) {
            set.title = input.title;
            changes.push(change.content('title', noteHash(input.title)));
            names.push('title');
          }
          if (input.description !== undefined && input.description !== g.row.description) {
            set.description = input.description;
            changes.push(change.content('description', noteHash(input.description ?? '')));
            names.push('description');
          }
          if (input.layout !== undefined || input.filters !== undefined) {
            const widgets = input.layout?.widgets ?? g.row.config.widgets;
            const filters = input.filters ?? g.row.config.filters;
            set.config = JSON.stringify({ v: 1, widgets, filters });
            if (input.layout)
              changes.push(
                change.plain(
                  'widgets',
                  String(g.row.config.widgets.length),
                  String(widgets.length),
                ),
              );
            if (input.filters) changes.push(change.plain('filters', null, 'changed'));
            names.push(input.layout ? 'layout' : 'filters');
          }
          if (names.length) {
            await tx.db
              .updateTable('insights.report_definition')
              .set({
                ...set,
                updated_at: new Date(),
                updated_by_membership_id: p.membershipId,
                version: g.row.version + 1,
              } as never)
              .where('id', '=', g.id)
              .execute();
            await this.insightAudit(
              tx,
              caller,
              p,
              'report.updated',
              { id: g.id, publicId: g.publicId, brandId: g.brand?.id ?? null },
              'report_definition',
              changes,
            );
            await this.insightEvent(
              tx,
              caller,
              p,
              'insights.report.updated',
              { type: 'insights.report_definition', id: g.id },
              { change: names.join(',') },
              g.brand?.id ?? null,
            );
          }
          return {
            status: 200,
            ref: { id: g.publicId, type: 'report' },
            data: await this.reportView(tx, p, await this.loadReport(tx, p, g.publicId)),
          };
        },
        async (tx, p, ref) => this.reportView(tx, p, await this.loadReport(tx, p, ref.id)),
      ),
    );
  }

  protected async recipientCount(tx: WorkspaceTransaction, reportId: string): Promise<number> {
    return Number(
      (
        await sql<{ n: string }>`SELECT count(*)::text AS n FROM insights.report_recipient
          WHERE workspace_id = ${tx.workspaceId} AND report_id = ${reportId}`.execute(tx.db)
      ).rows[0]?.n ?? 0,
    );
  }

  /** The person may read the report now: through the placement (as a member) or an active share. */
  protected async canReadReport(
    tx: WorkspaceTransaction,
    membershipId: string,
    g: Pick<LoadedReport, 'id' | 'brand' | 'chain'>,
  ): Promise<boolean> {
    const m = await activePerson(tx, membershipId);
    if (!m) return false;
    if (m.kind === 'member') {
      const mp = await compilePrincipal(tx, m.id, m.account_id, 'member');
      const lv = (await import('@pm/tenancy')).recordLevel(mp, {
        brand: g.brand,
        lifecycleState: 'active',
        shareLevel: null,
        projectChain: g.chain,
      });
      if (lv !== null) return true;
    }
    return (await this.activeShareOf(tx, g.id, membershipId)) !== null;
  }

  async setReportSchedule(
    caller: Caller,
    ws: unknown,
    report: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseScheduleInput(body);
    return this.iTrack('insights.changes', 'report_schedule', () =>
      this.mutate(
        caller,
        'report.schedule',
        ws,
        req,
        async (tx, p) => {
          this.requireInsightsMember(p);
          const g = await this.loadReport(tx, p, report, { lock: true });
          this.requireInsightActive(g, 'report');
          this.requireInsightAction(p, 'report.schedule', g);
          requireVersion(this.expectedInsightVersion(req, input), g.row.version);
          if (input.schedule && (await this.recipientCount(tx, g.id)) === 0)
            throw invalid(
              issue(
                '/schedule',
                'no_recipients',
                'Choose who receives the report before scheduling it.',
              ),
            );
          const s = input.schedule;
          const next = s ? nextRun(s, new Date()) : null;
          await tx.db
            .updateTable('insights.report_definition')
            .set({
              schedule_frequency: s?.frequency ?? null,
              schedule_weekday: s?.weekday ?? null,
              schedule_monthday: s?.monthday ?? null,
              schedule_minute: s?.minute ?? null,
              schedule_timezone: s?.timezone ?? null,
              next_run_at: next,
              claimed_until: null,
              attempts: 0,
              last_error: null,
              // Whoever sets the schedule answers for it: their authority is rechecked at each send.
              owner_membership_id: s ? p.membershipId : g.row.owner_membership_id,
              suspended_reason: null,
              suspended_at: null,
              updated_at: new Date(),
              updated_by_membership_id: p.membershipId,
              version: g.row.version + 1,
            } as never)
            .where('id', '=', g.id)
            .execute();
          await this.insightAudit(
            tx,
            caller,
            p,
            'report.schedule_changed',
            { id: g.id, publicId: g.publicId, brandId: g.brand?.id ?? null },
            'report_definition',
            [
              change.plain('frequency', g.row.schedule_frequency, s?.frequency ?? null),
              change.plain('timezone', g.row.schedule_timezone, s?.timezone ?? null),
              change.plain(
                'owner_changed',
                null,
                String(!!s && p.membershipId !== g.row.owner_membership_id),
              ),
            ],
          );
          await this.insightEvent(
            tx,
            caller,
            p,
            'insights.report.schedule_changed',
            { type: 'insights.report_definition', id: g.id },
            { frequency: s?.frequency ?? 'none', recipients: await this.recipientCount(tx, g.id) },
            g.brand?.id ?? null,
          );
          return {
            status: 200,
            ref: { id: g.publicId, type: 'report' },
            data: await this.reportView(tx, p, await this.loadReport(tx, p, g.publicId)),
          };
        },
        async (tx, p, ref) => this.reportView(tx, p, await this.loadReport(tx, p, ref.id)),
      ),
    );
  }

  /** Makes a suspended schedule run again, with the caller answering for it (RPT-021). */
  async resumeReport(caller: Caller, ws: unknown, report: unknown, req: Mutation) {
    return this.iTrack('insights.changes', 'report_resume', () =>
      this.mutate(
        caller,
        'report.resume',
        ws,
        req,
        async (tx, p) => {
          this.requireInsightsMember(p);
          const g = await this.loadReport(tx, p, report, { lock: true });
          this.requireInsightActive(g, 'report');
          this.requireInsightAction(p, 'report.schedule', g);
          const s = this.scheduleOf(g.row);
          if (!s || !g.row.suspended_reason)
            throw new TenancyError('conflict', {
              issues: [issue('/', 'invalid_state', 'This report is not suspended.')],
            });
          await tx.db
            .updateTable('insights.report_definition')
            .set({
              owner_membership_id: p.membershipId,
              suspended_reason: null,
              suspended_at: null,
              next_run_at: nextRun(s, new Date()),
              claimed_until: null,
              attempts: 0,
              last_error: null,
              updated_at: new Date(),
              updated_by_membership_id: p.membershipId,
              version: g.row.version + 1,
            } as never)
            .where('id', '=', g.id)
            .execute();
          await this.insightAudit(
            tx,
            caller,
            p,
            'report.resumed',
            { id: g.id, publicId: g.publicId, brandId: g.brand?.id ?? null },
            'report_definition',
            [change.plain('suspended_reason', g.row.suspended_reason, null)],
          );
          await this.insightEvent(
            tx,
            caller,
            p,
            'insights.report.resumed',
            { type: 'insights.report_definition', id: g.id },
            { reason: g.row.suspended_reason },
            g.brand?.id ?? null,
          );
          return {
            status: 200,
            ref: { id: g.publicId, type: 'report' },
            data: await this.reportView(tx, p, await this.loadReport(tx, p, g.publicId)),
          };
        },
        async (tx, p, ref) => this.reportView(tx, p, await this.loadReport(tx, p, ref.id)),
      ),
    );
  }

  async listReportRecipients(caller: Caller, ws: unknown, report: unknown) {
    return this.iTrack('insights.reads', 'recipients', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        this.requireInsightsMember(p);
        const g = await this.loadReport(tx, p, report);
        this.requireInsightAction(p, 'report.schedule', g);
        const rows = await sql<{ id: string }>`
          SELECT m.id FROM insights.report_recipient x JOIN tenancy.membership m
            ON m.workspace_id = x.workspace_id AND m.id = x.membership_id
           WHERE x.workspace_id = ${tx.workspaceId} AND x.report_id = ${g.id} ORDER BY x.added_at, m.id`.execute(
          tx.db,
        );
        const people = await this.goalPeople(
          tx,
          p,
          rows.rows.map((r) => r.id),
        );
        return {
          data: rows.rows.flatMap((r) => {
            const m = people.get(r.id);
            return m ? [m] : [];
          }),
        };
      }),
    );
  }

  async setReportRecipients(
    caller: Caller,
    ws: unknown,
    report: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseRecipients(body, this.ws.reportRecipientsMax);
    return this.iTrack('insights.changes', 'report_recipients', () =>
      this.mutate(
        caller,
        'report.recipients',
        ws,
        req,
        async (tx, p) => {
          this.requireInsightsMember(p);
          const g = await this.loadReport(tx, p, report, { lock: true });
          this.requireInsightActive(g, 'report');
          this.requireInsightAction(p, 'report.schedule', g);
          requireVersion(this.expectedInsightVersion(req, input), g.row.version);
          if (!input.members.length && g.row.schedule_frequency)
            throw invalid(
              issue(
                '/members',
                'schedule_needs_recipient',
                'Remove the schedule before removing every recipient.',
              ),
            );
          const ids: string[] = [];
          for (const pid of input.members) {
            const m = await tx.db
              .selectFrom('tenancy.membership')
              .select('id')
              .where('public_id', '=', pid)
              .executeTakeFirst();
            // Unknown, inactive, and unable-to-read are one answer.
            if (!m || !(await this.canReadReport(tx, m.id, g)))
              throw invalid(
                issue('/members', 'invalid_reference', 'Choose members who can read this report.'),
              );
            ids.push(m.id);
          }
          const before = new Set(
            (
              await tx.db
                .selectFrom('insights.report_recipient')
                .select('membership_id')
                .where('report_id', '=', g.id)
                .execute()
            ).map((r) => r.membership_id),
          );
          const want = new Set(ids);
          const remove = [...before].filter((x) => !want.has(x));
          const add = ids.filter((x) => !before.has(x));
          if (remove.length)
            await tx.db
              .deleteFrom('insights.report_recipient')
              .where('report_id', '=', g.id)
              .where('membership_id', 'in', remove)
              .execute();
          for (const m of add)
            await tx.db
              .insertInto('insights.report_recipient')
              .values({
                workspace_id: tx.workspaceId,
                report_id: g.id,
                membership_id: m,
                added_by_membership_id: p.membershipId,
              })
              .execute();
          if (add.length || remove.length)
            await tx.db
              .updateTable('insights.report_definition')
              .set({
                updated_at: new Date(),
                updated_by_membership_id: p.membershipId,
                version: g.row.version + 1,
              } as never)
              .where('id', '=', g.id)
              .execute();
          await this.insightAudit(
            tx,
            caller,
            p,
            'report.recipients_changed',
            { id: g.id, publicId: g.publicId, brandId: g.brand?.id ?? null },
            'report_definition',
            [
              change.plain('added', null, String(add.length)),
              change.plain('removed', null, String(remove.length)),
            ],
          );
          await this.insightEvent(
            tx,
            caller,
            p,
            'insights.report.schedule_changed',
            { type: 'insights.report_definition', id: g.id },
            { frequency: g.row.schedule_frequency ?? 'none', recipients: ids.length },
            g.brand?.id ?? null,
          );
          return {
            status: 200,
            ref: { id: g.publicId, type: 'report' },
            data: await this.reportView(tx, p, await this.loadReport(tx, p, g.publicId)),
          };
        },
        async (tx, p, ref) => this.reportView(tx, p, await this.loadReport(tx, p, ref.id)),
      ),
    );
  }

  /** A recipient stops their own deliveries (always allowed; it removes only themselves). */
  async leaveReport(caller: Caller, ws: unknown, report: unknown, req: Mutation) {
    return this.iTrack('insights.changes', 'report_leave', () =>
      this.mutate(
        caller,
        'report.leave',
        ws,
        req,
        async (tx, p) => {
          this.requireInsightsMember(p);
          const g = await this.loadReport(tx, p, report, { lock: true });
          const gone = await tx.db
            .deleteFrom('insights.report_recipient')
            .where('report_id', '=', g.id)
            .where('membership_id', '=', p.membershipId)
            .executeTakeFirst();
          if (Number(gone.numDeletedRows) > 0) {
            // Nobody left to send to: the schedule ends rather than running for no one.
            if ((await this.recipientCount(tx, g.id)) === 0 && g.row.schedule_frequency)
              await tx.db
                .updateTable('insights.report_definition')
                .set({
                  schedule_frequency: null,
                  schedule_weekday: null,
                  schedule_monthday: null,
                  schedule_minute: null,
                  schedule_timezone: null,
                  next_run_at: null,
                  claimed_until: null,
                  version: g.row.version + 1,
                } as never)
                .where('id', '=', g.id)
                .execute();
            await this.insightAudit(
              tx,
              caller,
              p,
              'report.recipient_left',
              { id: g.id, publicId: g.publicId, brandId: g.brand?.id ?? null },
              'report_definition',
              [change.plain('recipient', null, 'self')],
            );
          }
          return {
            status: 200,
            ref: { id: g.publicId, type: 'report' },
            data: await this.reportView(tx, p, await this.loadReport(tx, p, g.publicId)),
          };
        },
        async (tx, p, ref) => this.reportView(tx, p, await this.loadReport(tx, p, ref.id)),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Shares (explicit, revocable, bound to the report's scope)
  // ---------------------------------------------------------------------------------------------

  protected insightShareView(s: {
    public_id: string;
    expires_at: Date | string | null;
    created_at: Date | string;
    grantee: string | null;
    name: string | null;
  }) {
    return {
      id: s.public_id,
      type: 'report_share' as const,
      grantee: s.grantee ? { id: s.grantee, name: s.name ?? 'Member' } : null,
      expires_at: iso(s.expires_at),
      created_at: iso(s.created_at),
    };
  }

  async listReportShares(caller: Caller, ws: unknown, report: unknown) {
    return this.iTrack('insights.reads', 'shares', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        this.requireInsightsMember(p);
        const g = await this.loadReport(tx, p, report);
        this.requireInsightAction(p, 'record.share', g);
        const rows = await sql<{
          public_id: string;
          expires_at: Date | null;
          created_at: Date;
          grantee: string;
          name: string;
        }>`SELECT s.public_id, s.expires_at, s.created_at, m.public_id AS grantee,
                  coalesce(m.display_name_override, a.display_name) AS name
             FROM insights.report_share s JOIN tenancy.membership m ON m.workspace_id = s.workspace_id AND m.id = s.grantee_membership_id
             JOIN identity.account a ON a.id = m.account_id
            WHERE s.workspace_id = ${tx.workspaceId} AND s.report_id = ${g.id} AND s.revoked_at IS NULL
            ORDER BY s.created_at, s.id`.execute(tx.db);
        return { data: rows.rows.map((r) => this.insightShareView(r)) };
      }),
    );
  }

  async shareReport(caller: Caller, ws: unknown, report: unknown, body: unknown, req: Mutation) {
    const input = parseShare(body);
    return this.iTrack('insights.changes', 'report_share', () =>
      this.mutate(
        caller,
        'report.share',
        ws,
        req,
        async (tx, p) => {
          this.requireInsightsMember(p);
          const g = await this.loadReport(tx, p, report, { lock: true });
          this.requireInsightActive(g, 'report');
          this.requireInsightAction(p, 'record.share', g);
          const m = await tx.db
            .selectFrom('tenancy.membership')
            .select('id')
            .where('public_id', '=', input.grantee)
            .where('state', '=', 'active')
            .executeTakeFirst();
          if (!m)
            throw invalid(issue('/grantee', 'invalid_reference', 'Choose someone from the list.'));
          const active = Number(
            (
              await sql<{ n: string }>`SELECT count(*)::text AS n FROM insights.report_share
                WHERE workspace_id = ${tx.workspaceId} AND report_id = ${g.id} AND revoked_at IS NULL`.execute(
                tx.db,
              )
            ).rows[0]?.n ?? 0,
          );
          if (active >= this.ws.reportSharesMax)
            throw invalid(
              issue(
                '/',
                'too_many',
                `A report can have at most ${this.ws.reportSharesMax} shares.`,
              ),
            );
          const dup = await this.activeShareOf(tx, g.id, m.id);
          if (dup)
            throw new TenancyError('conflict', {
              issues: [
                issue('/grantee', 'already_shared', 'This report is already shared with them.'),
              ],
            });
          const id = newUuidV7();
          const publicId = newPublicId('rsh');
          await tx.db
            .insertInto('insights.report_share')
            .values({
              id,
              public_id: publicId,
              workspace_id: tx.workspaceId,
              scope_key: g.row.scope_key,
              report_id: g.id,
              grantee_membership_id: m.id,
              created_by_membership_id: p.membershipId,
              expires_at: input.expiresAt,
              revoked_at: null,
              revoked_by_membership_id: null,
            })
            .execute();
          await this.insightAudit(
            tx,
            caller,
            p,
            'report.shared',
            { id: g.id, publicId: g.publicId, brandId: g.brand?.id ?? null },
            'report_definition',
            [
              change.plain('grantee', null, input.grantee),
              change.plain('expires', null, input.expiresAt?.toISOString() ?? null),
            ],
          );
          await this.insightEvent(
            tx,
            caller,
            p,
            'insights.report.shared',
            { type: 'insights.report_definition', id: g.id },
            { scope: g.row.project_id ? 'project' : g.row.brand_id ? 'brand' : 'workspace' },
            g.brand?.id ?? null,
          );
          return {
            status: 201,
            ref: { id: publicId, type: 'report_share' },
            data: { id: publicId, type: 'report_share' as const, report: g.publicId },
          };
        },
        async (_tx, _p, ref) => ({ id: ref.id, type: 'report_share' as const, report: '' }),
      ),
    );
  }

  async revokeReportShare(
    caller: Caller,
    ws: unknown,
    report: unknown,
    share: unknown,
    req: Mutation,
  ) {
    return this.iTrack('insights.changes', 'report_unshare', () =>
      this.mutate(
        caller,
        'report.unshare',
        ws,
        req,
        async (tx, p) => {
          this.requireInsightsMember(p);
          const g = await this.loadReport(tx, p, report, { lock: true });
          this.requireInsightAction(p, 'record.share_revoke', g);
          const s = await tx.db
            .selectFrom('insights.report_share')
            .select(['id', 'public_id'])
            .where('report_id', '=', g.id)
            .where('public_id', '=', typeof share === 'string' ? share : '')
            .where('revoked_at', 'is', null)
            .forUpdate()
            .executeTakeFirst();
          if (!s) throw new TenancyError('not_found');
          await tx.db
            .updateTable('insights.report_share')
            .set({ revoked_at: new Date(), revoked_by_membership_id: p.membershipId })
            .where('id', '=', s.id)
            .execute();
          // A recipient who can read the report only through this share stops receiving it.
          await this.insightAudit(
            tx,
            caller,
            p,
            'report.share_revoked',
            { id: g.id, publicId: g.publicId, brandId: g.brand?.id ?? null },
            'report_definition',
            [change.plain('share', s.public_id, null)],
          );
          await this.insightEvent(
            tx,
            caller,
            p,
            'insights.report.share_revoked',
            { type: 'insights.report_definition', id: g.id },
            { scope: g.row.project_id ? 'project' : g.row.brand_id ? 'brand' : 'workspace' },
            g.brand?.id ?? null,
          );
          return {
            status: 200,
            ref: { id: s.public_id, type: 'report_share' },
            data: { id: s.public_id, type: 'report_share' as const, report: g.publicId },
          };
        },
        async (_tx, _p, ref) => ({ id: ref.id, type: 'report_share' as const, report: '' }),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Export (CSV and PDF): bounded, authorized as the requester, audited, never stored
  // ---------------------------------------------------------------------------------------------

  protected async exportWidgets(
    caller: Caller,
    ws: unknown,
    load: (
      tx: WorkspaceTransaction,
      p: Principal,
    ) => Promise<{
      title: string;
      scope: ReportScope;
      filters: DashboardFilters;
      layout: Layout;
      g: LoadedDashboard | LoadedReport;
      record: { id: string; publicId: string; brandId: string | null; type: string };
    }>,
    q: ReturnType<typeof parseExportQuery>,
  ) {
    return this.iTrack('insights.reads', 'export', () =>
      this.inWorkspace(caller, ws, {}, async (tx, p) => {
        this.requireInsightsMember(p);
        const x = await load(tx, p);
        if (x.g.level === null) throw new TenancyError('not_found');
        this.requireInsightAction(p, 'record.export', x.g);
        const rl = await this.c.limiter.consume('report.export' as never, p.membershipId);
        if (!rl.allowed)
          throw new TenancyError('rate_limited', { retryAfterSeconds: rl.retryAfterSeconds });
        const specs = q.widget ? [this.widgetOf(x.layout, q.widget)] : x.layout.widgets;
        const ctx = await this.metricContext(tx, p, x.scope, q.filters ?? x.filters);
        const outcomes = await this.evaluateAll(ctx, specs);
        const tables = this.tablesOf(specs, outcomes);
        const rowsTotal = tables.reduce((a, t) => a + t.rows.length, 0);
        if (rowsTotal > this.ws.reportExportRowsMax)
          throw invalid(
            issue(
              '/',
              'too_many',
              `Narrow the report: an export holds at most ${this.ws.reportExportRowsMax} rows.`,
            ),
          );
        const stamp = new Date().toISOString().slice(0, 10);
        const slug =
          x.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40) || 'report';
        const subtitle = `Prepared for you ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. ${ctx.scope.guest ? 'Covers the records shared with you.' : 'Covers what you can read.'}`;
        let body: string | Buffer;
        let contentType: string;
        if (q.format === 'csv') {
          body = tables
            .map(
              (t) =>
                `${csv([t.title], [[t.caption]])}${csv(t.columns, t.rows)}${
                  t.notes.length
                    ? csv(
                        ['Notes'],
                        t.notes.map((n) => [n]),
                      )
                    : ''
                }`,
            )
            .join('\r\n');
          contentType = 'text/csv; charset=utf-8';
        } else {
          body = renderPdf(
            reportLines(x.title, subtitle, tables),
            `Generated for the person who requested it. ${x.title}`,
          );
          contentType = 'application/pdf';
        }
        await this.workWriter.write(tx, this.cmd(caller, p, x.record.brandId), {
          action: 'insights.exported',
          target: { type: x.record.type, recordId: x.record.id, publicId: x.record.publicId },
          changes: [
            change.plain('format', null, q.format),
            change.plain('rows', null, String(rowsTotal)),
            change.plain('widgets', null, String(specs.length)),
          ],
        });
        await this.d.security.record(tx, {
          category: 'export',
          action: 'insights.export',
          outcome: 'success',
          actor: { type: 'human', id: p.membershipId },
          subject: { type: x.record.type, id: x.record.id },
          correlationId: caller.meta.correlationId,
        });
        return {
          format: q.format,
          filename: `${slug}-${stamp}.${q.format}`,
          contentType,
          body,
          rows: rowsTotal,
        };
      }),
    );
  }

  async exportDashboard(
    caller: Caller,
    ws: unknown,
    dash: unknown,
    query: Record<string, unknown>,
  ) {
    const q = parseExportQuery(query);
    return this.exportWidgets(
      caller,
      ws,
      async (tx, p) => {
        const g = await this.loadDashboard(tx, p, dash);
        return {
          title: g.row.title,
          scope: await this.dashboardScope(tx, p, g),
          filters: g.row.filters,
          layout: g.row.layout,
          g,
          record: {
            id: g.id,
            publicId: g.publicId,
            brandId: g.brand?.id ?? null,
            type: 'dashboard',
          },
        };
      },
      q,
    );
  }

  async exportReport(caller: Caller, ws: unknown, report: unknown, query: Record<string, unknown>) {
    const q = parseExportQuery(query);
    return this.exportWidgets(
      caller,
      ws,
      async (tx, p) => {
        const g = await this.loadReport(tx, p, report);
        return {
          title: g.row.title,
          scope: await this.reportScope(tx, p, g),
          filters: g.row.config.filters!,
          layout: g.row.config,
          g,
          record: {
            id: g.id,
            publicId: g.publicId,
            brandId: g.brand?.id ?? null,
            type: 'report_definition',
          },
        };
      },
      q,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduled delivery (RPT-021): per recipient, as that recipient, at send time
  // ---------------------------------------------------------------------------------------------

  /**
   * One sweep for a workspace: ages out old runs, claims due reports with a lease, and for each
   * delivers to every recipient as that recipient. Every step is idempotent: the occurrence is a
   * unique key per recipient, a repeated or overlapping sweep finds the run and does nothing, and a
   * crashed worker's reports return when their lease lapses. A failing recipient backs off without
   * holding up the others; when the attempts are spent the run is recorded failed and the schedule
   * moves on. Nothing viewer-specific outlives the delivery: runs hold counts and a hash, not data.
   */
  async runReportSweep(
    tenant: TenantDatabase,
    workspaceId: string,
    now: Date,
    deps: DeliveryDeps,
  ): Promise<SweepResult> {
    const out: SweepResult = {
      reports: 0,
      delivered: 0,
      skipped: 0,
      failed: 0,
      retried: 0,
      suspended: 0,
      purged: 0,
    };
    const s = this.ws;
    out.purged = await tenant.withWorkspace(workspaceId, { module: 'insights' }, async (tx) => {
      const cut = new Date(now.getTime() - s.reportRunRetentionDays * 86_400_000);
      const r = await sql`DELETE FROM insights.report_run WHERE workspace_id = ${workspaceId}
                          AND created_at < ${cut} AND state <> 'pending'`.execute(tx.db);
      return Number(r.numAffectedRows ?? 0);
    });
    const claimed = await tenant.withWorkspace(workspaceId, { module: 'insights' }, async (tx) => {
      const rows = (
        await sql<{ id: string }>`
          SELECT id FROM insights.report_definition
           WHERE workspace_id = ${workspaceId} AND next_run_at IS NOT NULL AND next_run_at <= ${now}
             AND suspended_at IS NULL AND lifecycle_state = 'active'
             AND (claimed_until IS NULL OR claimed_until <= ${now})
           ORDER BY next_run_at, id LIMIT ${s.reportBatchMax} FOR UPDATE SKIP LOCKED`.execute(tx.db)
      ).rows.map((r) => r.id);
      if (rows.length)
        await sql`UPDATE insights.report_definition SET claimed_until = ${new Date(now.getTime() + s.reportLeaseSeconds * 1000)},
            attempts = attempts + 1 WHERE workspace_id = ${workspaceId} AND id = ANY(${rows}::uuid[])`.execute(
          tx.db,
        );
      return rows;
    });
    for (const id of claimed) {
      out.reports++;
      try {
        await this.deliverReport(tenant, workspaceId, id, now, deps, out);
        this.d.metrics.count('insights.jobs', 1, { kind: 'deliver', outcome: 'ok' });
      } catch (err) {
        this.d.metrics.count('insights.jobs', 1, { kind: 'deliver', outcome: 'failed' });
        this.d.logger.warn('insights.delivery_failed', {
          component: 'insights',
          error_class: err instanceof Error ? err.name : 'Error',
        });
        await tenant
          .withWorkspace(workspaceId, { module: 'insights' }, async (tx) => {
            const row = (
              await sql<{ attempts: number }>`SELECT attempts FROM insights.report_definition
                 WHERE workspace_id = ${workspaceId} AND id = ${id}`.execute(tx.db)
            ).rows[0];
            const attempts = Number(row?.attempts ?? 1);
            await sql`UPDATE insights.report_definition SET last_error = 'delivery_failed',
                claimed_until = ${new Date(Date.now() + retryDelayMs(attempts, 60, 3600))}
              WHERE workspace_id = ${workspaceId} AND id = ${id}`.execute(tx.db);
          })
          .catch(() => undefined);
      }
    }
    return out;
  }

  protected async suspend(
    tx: WorkspaceTransaction,
    row: { id: string; public_id: string; brand_id: string | null; version: number },
    reason: 'owner_authority' | 'owner_departed',
  ) {
    await tx.db
      .updateTable('insights.report_definition')
      .set({
        suspended_reason: reason,
        suspended_at: new Date(),
        next_run_at: null,
        claimed_until: null,
        version: row.version + 1,
        updated_at: new Date(),
      } as never)
      .where('id', '=', row.id)
      .execute();
    const exec = systemExec(tx.workspaceId, null);
    await this.workWriter.write(
      tx,
      CommandContext.fromExecution(exec, { kind: 'automation' }, { brandId: row.brand_id }),
      {
        action: 'report.suspended',
        target: { recordId: row.id, type: 'report_definition', publicId: row.public_id },
        changes: [change.plain('reason', null, reason)],
      },
    );
    await writeOutboxEvent(tx, {
      type: 'insights.report.suspended',
      aggregate: { type: 'insights.report_definition', id: row.id, sequence: 0 },
      data: { reason },
      actor: { type: 'system', id: tx.workspaceId },
      context: exec,
      ...(row.brand_id ? { brandId: row.brand_id } : {}),
    });
  }

  protected async deliverReport(
    tenant: TenantDatabase,
    workspaceId: string,
    reportId: string,
    now: Date,
    deps: DeliveryDeps,
    out: SweepResult,
  ): Promise<void> {
    // Step 1: authority of the accountable owner, and the plan (occurrence and recipients).
    const plan = await tenant.withWorkspace(workspaceId, { module: 'insights' }, async (tx) => {
      const r = (
        await sql<Record<string, unknown> & { public_id: string }>`
          SELECT d.*, r.public_id FROM insights.report_definition d
            JOIN core.record r ON r.workspace_id = d.workspace_id AND r.id = d.id
           WHERE d.workspace_id = ${workspaceId} AND d.id = ${reportId} FOR UPDATE OF d`.execute(
          tx.db,
        )
      ).rows[0];
      if (!r) return null;
      const row = this.toReportRow(r as never);
      if (row.lifecycle_state !== 'active' || row.suspended_at || !row.next_run_at) return null;
      const sched = this.scheduleOf(row);
      if (!sched) return null;
      const owner = await activePerson(tx, row.owner_membership_id);
      if (!owner || owner.kind !== 'member') {
        await this.suspend(tx, row, 'owner_departed');
        out.suspended++;
        return null;
      }
      const op = await principalOf(tx, owner);
      const place = await this.placementOf(tx, row.brand_id, row.project_id);
      const decided = decideRecord(op, 'report.schedule', {
        brand: place.brand,
        lifecycleState: 'active',
        shareLevel: null,
        projectChain: place.chain,
      });
      if (!decided.allowed) {
        await this.suspend(tx, row, 'owner_authority');
        out.suspended++;
        return null;
      }
      const recipients = (
        await sql<{ membership_id: string }>`SELECT membership_id FROM insights.report_recipient
          WHERE workspace_id = ${workspaceId} AND report_id = ${reportId} ORDER BY added_at, membership_id
          LIMIT ${this.ws.reportRecipientsMax}`.execute(tx.db)
      ).rows.map((x) => x.membership_id);
      const ws = await tx.db
        .selectFrom('tenancy.workspace')
        .select('public_id')
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow();
      return {
        row,
        sched,
        recipients,
        occurrence: dueOccurrence(sched, row.next_run_at, now),
        wsPublic: ws.public_id,
        sensitive: place.brand?.isSensitive === true,
        brandName: place.brand?.name ?? null,
        isNew: row.attempts <= 1,
      };
    });
    if (!plan) return;

    // Step 2: each recipient, in its own transactions; a network send never holds a transaction.
    let pending = 0;
    for (const rid of plan.recipients) {
      const runId = await tenant.withWorkspace(workspaceId, { module: 'insights' }, async (tx) => {
        const ins = await sql<{ id: string; state: string }>`
          INSERT INTO insights.report_run (id, workspace_id, report_id, recipient_membership_id, occurrence_at)
          VALUES (${newUuidV7()}, ${workspaceId}, ${reportId}, ${rid}, ${plan.occurrence})
          ON CONFLICT (workspace_id, report_id, recipient_membership_id, occurrence_at) DO NOTHING
          RETURNING id, state`.execute(tx.db);
        if (ins.rows[0]) return ins.rows[0];
        const ex = await sql<{
          id: string;
          state: string;
        }>`SELECT id, state FROM insights.report_run
          WHERE workspace_id = ${workspaceId} AND report_id = ${reportId} AND recipient_membership_id = ${rid}
            AND occurrence_at = ${plan.occurrence}`.execute(tx.db);
        return ex.rows[0]!;
      });
      if (runId.state !== 'pending') continue;
      const done = await this.deliverOne(tenant, workspaceId, plan, rid, runId.id, deps, out);
      if (!done) pending++;
    }

    // Step 3: the schedule moves on once every recipient is settled or the attempts are spent.
    await tenant.withWorkspace(workspaceId, { module: 'insights' }, async (tx) => {
      const cur = (
        await sql<{ attempts: number }>`SELECT attempts FROM insights.report_definition
          WHERE workspace_id = ${workspaceId} AND id = ${reportId} FOR UPDATE`.execute(tx.db)
      ).rows[0];
      if (!cur) return;
      const spent = Number(cur.attempts) >= this.ws.reportMaxAttempts;
      if (pending && !spent) {
        out.retried += pending;
        await sql`UPDATE insights.report_definition SET last_error = 'delivery_pending',
            claimed_until = ${new Date(now.getTime() + retryDelayMs(Number(cur.attempts), 60, 3600))}
          WHERE workspace_id = ${workspaceId} AND id = ${reportId}`.execute(tx.db);
        return;
      }
      if (pending) {
        const f =
          await sql`UPDATE insights.report_run SET state = 'failed', detail = 'attempts_spent', finished_at = now()
          WHERE workspace_id = ${workspaceId} AND report_id = ${reportId} AND state = 'pending'`.execute(
            tx.db,
          );
        out.failed += Number(f.numAffectedRows ?? 0);
      }
      // Older occurrences nobody finished are closed, never sent late as a backlog.
      await sql`UPDATE insights.report_run SET state = 'skipped', detail = 'superseded', finished_at = now()
        WHERE workspace_id = ${workspaceId} AND report_id = ${reportId} AND state = 'pending'
          AND occurrence_at < ${plan.occurrence}`.execute(tx.db);
      await sql`UPDATE insights.report_definition SET last_run_at = ${plan.occurrence},
          next_run_at = ${nextRun(plan.sched, now)}, claimed_until = NULL, attempts = 0, last_error = NULL
        WHERE workspace_id = ${workspaceId} AND id = ${reportId}`.execute(tx.db);
    });
  }

  /** Returns true when the recipient's run reached a final state. */
  protected async deliverOne(
    tenant: TenantDatabase,
    workspaceId: string,
    plan: {
      row: LoadedReport['row'];
      sched: Schedule;
      occurrence: Date;
      wsPublic: string;
      sensitive: boolean;
      brandName: string | null;
    },
    recipientId: string,
    runId: string,
    deps: DeliveryDeps,
    out: SweepResult,
  ): Promise<boolean> {
    const finish = (
      state: 'delivered' | 'empty' | 'skipped' | 'failed',
      detail: string | null,
      extra: { rows?: number; incomplete?: boolean; hash?: string; failure?: FailureClass } = {},
    ) =>
      tenant.withWorkspace(workspaceId, { module: 'insights' }, async (tx) => {
        await sql`UPDATE insights.report_run SET state = ${state}, detail = ${detail}, row_count = ${extra.rows ?? null},
            incomplete = ${extra.incomplete ?? false}, content_hash = ${extra.hash ?? null},
            failure_class = ${extra.failure ?? null}, finished_at = now(), attempts = attempts + 1
          WHERE workspace_id = ${workspaceId} AND id = ${runId} AND state = 'pending'`.execute(
          tx.db,
        );
        this.d.metrics.count('insights.jobs', 1, { kind: 'run', outcome: state });
        if (state === 'delivered') out.delivered++;
        else if (state === 'failed') out.failed++;
        else out.skipped++;
      });

    // Render as the recipient, from what the recipient may read right now.
    const rendered = await tenant.withWorkspace(
      workspaceId,
      { module: 'insights', readOnly: true },
      async (tx) => {
        const person = await activePerson(tx, recipientId);
        if (!person) return { kind: 'skip' as const, detail: 'recipient_unavailable' };
        const p = await principalOf(tx, person);
        let g: LoadedReport;
        try {
          g = await this.loadReport(tx, p, await this.publicOfReport(tx, plan.row.id));
        } catch (err) {
          if (err instanceof TenancyError) return { kind: 'skip' as const, detail: 'no_access' };
          throw err;
        }
        const address = (
          await tx.db
            .selectFrom('identity.account')
            .select('primary_email')
            .where('id', '=', person.account_id)
            .executeTakeFirst()
        )?.primary_email;
        if (!address) return { kind: 'skip' as const, detail: 'recipient_unavailable' };
        const scope = await this.reportScope(tx, p, g);
        const specs = g.row.config.widgets;
        const ctx = await this.metricContext(tx, p, scope, g.row.config.filters!);
        const outcomes = await this.evaluateAll(ctx, specs);
        const tables = this.tablesOf(specs, outcomes);
        const okCount = outcomes.filter((o) => o.state === 'ok').length;
        const rows = tables.reduce((a, t) => a + t.rows.length, 0);
        const incomplete = outcomes.some((o) => o.state === 'ok' && o.incomplete.length > 0);
        return {
          kind: 'send' as const,
          address,
          tables,
          rows,
          incomplete,
          okCount,
          title: g.row.title,
          hash: contentHash(tables),
        };
      },
    );
    if (rendered.kind === 'skip') {
      await finish('skipped', rendered.detail);
      return true;
    }
    // A recipient who can see nothing gets no email (AT-016).
    if (rendered.okCount === 0) {
      await finish('skipped', 'nothing_visible', { rows: 0 });
      return true;
    }
    const base = deps.origin.replace(/\/$/, '');
    const url = `${base}/workspaces/${plan.wsPublic}/reports/${await this.publicIdOfReport(tenant, workspaceId, plan.row.id)}`;
    const subject = `${plan.brandName ? `[${plan.brandName}] ` : ''}${rendered.title}`
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 200);
    const body = composeReportEmail({
      title: rendered.title,
      scheduleText: describeSchedule(plan.sched),
      // A sensitive brand's email carries no figures: only the pointer back into the product.
      tables: plan.sensitive ? [] : rendered.tables,
      url,
      footer: `You are receiving this report because you are a recipient. Open it to stop receiving it: ${url}`,
      rowsMax: this.ws.reportEmailRowsMax,
    });
    try {
      await deps.email.send({
        id: runId,
        to: rendered.address,
        subject,
        text: body.text,
        html: body.html,
      });
    } catch (err) {
      const f: DeliveryError = classifyTransportError(err);
      const next = afterFailure(f.failureClass, 1, 1);
      if (f.failureClass === 'unconfigured' || next === 'suppressed') {
        await finish('skipped', 'provider_unconfigured', { failure: 'unconfigured' });
        return true;
      }
      if (f.failureClass === 'permanent') {
        await finish('failed', 'provider_rejected', { failure: 'permanent' });
        return true;
      }
      await tenant.withWorkspace(workspaceId, { module: 'insights' }, async (tx) => {
        await sql`UPDATE insights.report_run SET failure_class = ${f.failureClass}, attempts = attempts + 1
          WHERE workspace_id = ${workspaceId} AND id = ${runId}`.execute(tx.db);
      });
      return false;
    }
    await finish('delivered', null, {
      rows: rendered.rows,
      incomplete: rendered.incomplete,
      hash: rendered.hash,
    });
    return true;
  }

  protected async publicOfReport(tx: WorkspaceTransaction, id: string): Promise<string> {
    const r = await tx.db
      .selectFrom('core.record')
      .select('public_id')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return r.public_id;
  }

  protected publicIdOfReport(tenant: TenantDatabase, workspaceId: string, id: string) {
    return tenant.withWorkspace(workspaceId, { module: 'insights', readOnly: true }, (tx) =>
      this.publicOfReport(tx, id),
    );
  }
}
