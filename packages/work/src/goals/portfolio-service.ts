import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type RawBuilder, type WorkspaceTransaction } from '@pm/db';
import {
  bumpEpoch,
  decideBrand,
  decideWorkspace,
  findBrand,
  invalid,
  issue,
  parseIfMatch,
  recordLevel,
  requireVersion,
  TenancyError,
  levelRank,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { csv } from '../time/semantics.ts';
import { isPublic } from '../validation.ts';
import { GoalService } from './goal-service.ts';
import { num } from './goal-core.ts';
import {
  dependencyState,
  evaluateHealth,
  HEALTH_LABEL,
  ORPHAN_PROJECT_CATEGORIES,
  workPercent,
  type DependencyState,
  type HealthInput,
  type ProjectHealth,
} from './semantics.ts';
import {
  parseOverview,
  parsePortfolio,
  parsePortfolioMembers,
  type OverviewQuery,
} from './validation.ts';

const NIL = '00000000-0000-7000-8000-000000000000';
const STATUS_LABEL: Record<string, string> = {
  planned: 'Planned',
  active: 'Active',
  paused: 'Paused',
  done: 'Completed',
  cancelled: 'Cancelled',
};
const HEALTH_ORDER: Record<ProjectHealth, number> = {
  off_track: 0,
  at_risk: 1,
  unknown: 2,
  on_track: 3,
  complete: 4,
};

interface ProjectFacts {
  id: string;
  public_id: string;
  name: string;
  brand_id: string;
  status_category: 'planned' | 'active' | 'paused' | 'done' | 'cancelled';
  priority: string;
  start_date: string | null;
  target_date: string | null;
  deadline_date: string | null;
  health: 'on_track' | 'at_risk' | 'off_track' | null;
  health_source: string | null;
  owner_membership_id: string;
  budget_amount: string | null;
  budget_currency: string | null;
  time_budget_minutes: number | null;
  ai_budget_micros: string | null;
  version: number;
}

interface TaskFacts {
  done: number;
  total: number;
  overdue: number;
  blocked: number;
  open: number;
  open_estimate_minutes: number;
  unestimated_open: number;
}

/**
 * Phase 5B portfolios and portfolio insight (ADR-0028): saved lists of projects, and the
 * explainable health, dependency, budget, deadline, effort, and orphan reads over the projects a
 * viewer may read. Every figure is computed live for the viewer from authorized records only; a
 * hidden brand, project, or task changes no count and appears in no label (OD-07, IA-42), and each
 * read says what it covers and when it was computed.
 */
export class PortfolioService extends GoalService {
  // ---------------------------------------------------------------------------------------------
  // Portfolio records
  // ---------------------------------------------------------------------------------------------

  protected async loadPortfolio(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    opts: { lock?: boolean; allowTrashed?: boolean } = {},
  ) {
    const unknown = async (): Promise<never> => {
      await this.brandFactsOf(tx, NIL).catch(() => undefined);
      throw new TenancyError('not_found');
    };
    if (!isPublic(publicId, 'pf')) return unknown();
    let q = tx.db
      .selectFrom('core.record as r')
      .innerJoin('goals.portfolio as f', (j) =>
        j.onRef('f.workspace_id', '=', 'r.workspace_id').onRef('f.id', '=', 'r.id'),
      )
      .selectAll('f')
      .select(['r.public_id'])
      .where('r.public_id', '=', publicId)
      .where('r.record_type', '=', 'portfolio');
    if (opts.lock) q = q.forUpdate('f');
    const row = await q.executeTakeFirst();
    if (!row) return unknown();
    let brand = null as Awaited<ReturnType<PortfolioService['brandFactsOf']>> | null;
    if (row.brand_id) brand = await this.brandFactsOf(tx, row.brand_id);
    else await this.brandFactsOf(tx, NIL).catch(() => undefined);
    const trashed = row.lifecycle_state === 'trashed';
    if (trashed && !opts.allowTrashed) throw new TenancyError('not_found');
    const level = recordLevel(p, {
      brand: brand?.facts ?? null,
      lifecycleState: trashed ? 'active' : row.lifecycle_state,
      projectChain: [],
      shareLevel: null,
    });
    if (level === null || p.kind !== 'member') throw new TenancyError('not_found');
    if (trashed && levelRank(level) < levelRank('edit')) throw new TenancyError('not_found');
    return {
      id: row.id,
      publicId: row.public_id,
      brand: brand?.facts ?? null,
      marker: brand?.marker ?? null,
      lifecycleState: row.lifecycle_state,
      level,
      row: { ...row, version: Number(row.version) },
    };
  }

  protected portfolioAllows(
    p: Principal,
    action: Parameters<PortfolioService['requireGoalAction']>[1],
    f: Awaited<ReturnType<PortfolioService['loadPortfolio']>>,
  ) {
    return this.goalAllows(p, action, {
      id: f.id,
      publicId: f.publicId,
      brand: f.brand as never,
      brandMarker: f.marker,
      chain: [],
      projectId: null,
      lifecycleState: f.lifecycleState,
      level: f.level,
      row: null as never,
    });
  }

  protected requirePortfolioAction(
    p: Principal,
    action: Parameters<PortfolioService['requireGoalAction']>[1],
    f: Awaited<ReturnType<PortfolioService['loadPortfolio']>>,
  ) {
    this.requireGoalAction(p, action, {
      id: f.id,
      publicId: f.publicId,
      brand: f.brand as never,
      brandMarker: f.marker,
      chain: [],
      projectId: null,
      lifecycleState: f.lifecycleState,
      level: f.level,
      row: null as never,
    });
  }

  /** The projects of a portfolio the viewer may read, in the portfolio's order. */
  protected async memberProjects(tx: WorkspaceTransaction, p: Principal, portfolioId: string) {
    const vis = await this.workVisibility(tx, p);
    const rows = await sql<{ id: string; public_id: string }>`
      SELECT m.project_id AS id, r.public_id FROM goals.portfolio_project m
        JOIN core.record r ON r.workspace_id = m.workspace_id AND r.id = m.project_id
       WHERE m.workspace_id = ${tx.workspaceId} AND m.portfolio_id = ${portfolioId}
         AND ${vis.where('r', { project: sql`m.project_id` })}
       ORDER BY m.position, m.project_id`.execute(tx.db);
    return rows.rows;
  }

  protected async portfolioView(
    tx: WorkspaceTransaction,
    p: Principal,
    f: Awaited<ReturnType<PortfolioService['loadPortfolio']>>,
  ) {
    const people = await this.goalPeople(tx, p, [f.row.owner_membership_id]);
    const members = await this.memberProjects(tx, p, f.id);
    return {
      id: f.publicId,
      type: 'portfolio' as const,
      name: f.row.name,
      description: f.row.description,
      scope: f.marker
        ? { kind: 'brand' as const, brand: f.marker }
        : { kind: 'workspace' as const },
      owner: people.get(f.row.owner_membership_id) ?? null,
      // Only the members this viewer may read are counted or listed (OD-07).
      projects: members.map((m) => m.public_id),
      projects_count: members.length,
      lifecycle_state: f.lifecycleState,
      capabilities: {
        update: this.portfolioAllows(p, 'record.update', f) && f.lifecycleState === 'active',
        archive: this.portfolioAllows(p, 'record.archive', f),
        trash: this.portfolioAllows(p, 'record.trash', f),
      },
      version: Number(f.row.version),
    };
  }

  async listPortfolios(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.gTrack('goals.reads', 'portfolios', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        this.requireMemberKind(p);
        const vis = await this.goalVisibility(tx, p, query.archived === 'true');
        const brandId =
          typeof query.brand === 'string' && isPublic(query.brand, 'br')
            ? ((
                await tx.db
                  .selectFrom('core.record')
                  .select('id')
                  .where('public_id', '=', query.brand)
                  .executeTakeFirst()
              )?.id ?? NIL)
            : null;
        const rows = await sql<{ public_id: string }>`
          SELECT r.public_id FROM goals.portfolio f JOIN core.record r ON r.workspace_id = f.workspace_id AND r.id = f.id
           WHERE f.workspace_id = ${tx.workspaceId} AND ${vis.where('r')}
             ${brandId ? sql`AND f.brand_id = ${brandId}` : sql``}
           ORDER BY lower(f.name), f.id LIMIT ${this.ws.portfoliosMax}`.execute(tx.db);
        const data = [];
        for (const r of rows.rows)
          data.push(await this.portfolioView(tx, p, await this.loadPortfolio(tx, p, r.public_id)));
        return { data, page: { limit: data.length, has_more: false } };
      }),
    );
  }

  async getPortfolio(caller: Caller, ws: unknown, portfolio: unknown) {
    return this.gTrack('goals.reads', 'portfolio', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) =>
        this.portfolioView(tx, p, await this.loadPortfolio(tx, p, portfolio)),
      ),
    );
  }

  async createPortfolio(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = parsePortfolio(body, true);
    return this.gTrack('goals.changes', 'portfolio_create', () =>
      this.mutate(
        caller,
        'portfolio.create',
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          let brandId: string | null = null;
          let brandFacts: Awaited<ReturnType<PortfolioService['brandFactsOf']>> | null = null;
          if (input.brand) {
            const b = await findBrand(tx, p, input.brand);
            const f = { id: b.id, isSensitive: b.is_sensitive, lifecycleState: b.lifecycle_state };
            const o = decideBrand(p, 'record.create', { ...f, lifecycleState: 'active' });
            this.decision('record.create', o);
            if (!o.allowed) throw new TenancyError(o.code);
            if (b.lifecycle_state !== 'active')
              throw new TenancyError('conflict', {
                issues: [issue('/brand', 'brand_archived', 'This brand is archived.')],
              });
            brandId = b.id;
            brandFacts = await this.brandFactsOf(tx, b.id);
          } else {
            const o = decideWorkspace(p, 'record.create');
            this.decision('record.create', o);
            if (!o.allowed) throw new TenancyError(o.code);
          }
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`portfolios:${tx.workspaceId}`}, 0))`.execute(
            tx.db,
          );
          const n = await sql<{ n: string }>`SELECT count(*)::text AS n FROM goals.portfolio
             WHERE workspace_id = ${tx.workspaceId} AND lifecycle_state <> 'purged'`.execute(tx.db);
          if (Number(n.rows[0]?.n ?? 0) >= this.ws.portfoliosMax)
            throw invalid(
              issue(
                '/',
                'too_many',
                `A workspace can hold at most ${this.ws.portfoliosMax} portfolios.`,
              ),
            );
          let ownerId = p.membershipId;
          if (input.owner) {
            const m = await this.memberByPublic(tx, input.owner, '/owner');
            if (
              !(await this.canEditHere(tx, m.id, {
                brand: (brandFacts?.facts ?? null) as never,
                chain: [],
              }))
            )
              throw invalid(
                issue(
                  '/owner',
                  'invalid_reference',
                  'Choose a member who can edit this portfolio.',
                ),
              );
            ownerId = m.id;
          }
          const id = newUuidV7();
          const publicId = newPublicId('pf');
          const cmd = this.cmd(caller, p, brandId);
          await tx.db
            .insertInto('core.record')
            .values({
              id,
              public_id: publicId,
              record_type: 'portfolio',
              workspace_id: tx.workspaceId,
              brand_id: brandId,
              source_kind: 'ui',
              source_ref: null,
              created_by_actor_type: cmd.actor.type,
              created_by_actor_id: cmd.actor.id,
            })
            .execute();
          await tx.db
            .insertInto('goals.portfolio')
            .values({
              id,
              workspace_id: tx.workspaceId,
              brand_id: brandId,
              scope_key: brandId ?? tx.workspaceId,
              name: input.name!,
              description: input.description ?? null,
              owner_membership_id: ownerId,
              created_by_membership_id: p.membershipId,
              updated_by_membership_id: p.membershipId,
            })
            .execute();
          await this.workAudit(
            tx,
            caller,
            p,
            'portfolio.created',
            { recordId: id, type: 'portfolio', publicId },
            [change.plain('scope', null, brandId ? 'brand' : 'workspace')],
            brandId,
          );
          await this.workEvent(
            tx,
            caller,
            p,
            'goals.portfolio.created',
            { type: 'goals.portfolio', id, sequence: 0 },
            { scope: brandId ? 'brand' : 'workspace' },
            brandId,
          );
          return {
            status: 201,
            ref: { id: publicId, type: 'portfolio' },
            data: await this.portfolioView(tx, p, await this.loadPortfolio(tx, p, publicId)),
          };
        },
        async (tx, p, ref) => this.portfolioView(tx, p, await this.loadPortfolio(tx, p, ref.id)),
      ),
    );
  }

  async updatePortfolio(
    caller: Caller,
    ws: unknown,
    portfolio: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parsePortfolio(body, false);
    return this.gTrack('goals.changes', 'portfolio_update', () =>
      this.mutate(
        caller,
        'portfolio.update',
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const f = await this.loadPortfolio(tx, p, portfolio, { lock: true });
          if (f.lifecycleState !== 'active')
            throw new TenancyError('conflict', {
              issues: [
                issue(
                  '/',
                  'portfolio_archived',
                  'This portfolio is archived. Restore it to make changes.',
                ),
              ],
            });
          this.requirePortfolioAction(p, 'record.update', f);
          requireVersion(
            this.expectedVersion(req, input as { version: number | undefined }),
            Number(f.row.version),
          );
          const set: Record<string, unknown> = {};
          const names: string[] = [];
          if (input.name !== undefined && input.name !== f.row.name) {
            set.name = input.name;
            names.push('name');
          }
          if (input.description !== undefined && input.description !== f.row.description) {
            set.description = input.description;
            names.push('description');
          }
          if (input.owner !== undefined) {
            const m = await this.memberByPublic(tx, input.owner, '/owner');
            if (
              !(await this.canEditHere(tx, m.id, { brand: (f.brand ?? null) as never, chain: [] }))
            )
              throw invalid(
                issue(
                  '/owner',
                  'invalid_reference',
                  'Choose a member who can edit this portfolio.',
                ),
              );
            if (m.id !== f.row.owner_membership_id) {
              set.owner_membership_id = m.id;
              names.push('owner');
            }
          }
          if (names.length) {
            await tx.db
              .updateTable('goals.portfolio')
              .set({
                ...set,
                updated_at: new Date(),
                updated_by_membership_id: p.membershipId,
                version: Number(f.row.version) + 1,
              })
              .where('id', '=', f.id)
              .execute();
            await this.workAudit(
              tx,
              caller,
              p,
              'portfolio.updated',
              { recordId: f.id, type: 'portfolio', publicId: f.publicId },
              [change.plain('fields', null, names.join(','))],
              f.brand?.id ?? null,
            );
            await this.workEvent(
              tx,
              caller,
              p,
              'goals.portfolio.updated',
              { type: 'goals.portfolio', id: f.id, sequence: 0 },
              { change: names.join(',') },
              f.brand?.id ?? null,
            );
          }
          return {
            status: 200,
            ref: { id: f.publicId, type: 'portfolio' },
            data: await this.portfolioView(tx, p, await this.loadPortfolio(tx, p, f.publicId)),
          };
        },
        async (tx, p, ref) => this.portfolioView(tx, p, await this.loadPortfolio(tx, p, ref.id)),
      ),
    );
  }

  /**
   * Sets the projects a portfolio names. The request names the projects the editor can read; members
   * the editor cannot read are kept as they are (neither listed nor removed), so editing never
   * discloses or destroys what the editor cannot see.
   */
  async setPortfolioProjects(
    caller: Caller,
    ws: unknown,
    portfolio: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parsePortfolioMembers(body, this.ws.portfolioProjectsMax);
    return this.gTrack('goals.changes', 'portfolio_members', () =>
      this.mutate(
        caller,
        'portfolio.members',
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const f = await this.loadPortfolio(tx, p, portfolio, { lock: true });
          if (f.lifecycleState !== 'active')
            throw new TenancyError('conflict', {
              issues: [
                issue(
                  '/',
                  'portfolio_archived',
                  'This portfolio is archived. Restore it to make changes.',
                ),
              ],
            });
          this.requirePortfolioAction(p, 'record.update', f);
          requireVersion(this.expectedVersion(req, input), Number(f.row.version));
          const vis = await this.workVisibility(tx, p);
          const wanted = input.projects.length
            ? (
                await sql<{ id: string; public_id: string; brand_id: string }>`
                  SELECT r.id, r.public_id, r.brand_id FROM core.record r
                    JOIN work.project w ON w.workspace_id = r.workspace_id AND w.id = r.id
                   WHERE r.public_id = ANY(${input.projects}::text[]) AND r.record_type = 'project'
                     AND ${vis.where('r', { project: sql`w.id` })}`.execute(tx.db)
              ).rows
            : [];
          const byPublic = new Map(wanted.map((r) => [r.public_id, r]));
          input.projects.forEach((id, i) => {
            const r = byPublic.get(id);
            if (!r || (f.brand && f.brand.id !== r.brand_id))
              throw invalid(
                issue(
                  `/projects/${i}`,
                  'invalid_reference',
                  f.brand
                    ? "Choose a project of this portfolio's brand that you can read."
                    : 'Choose a project you can read.',
                ),
              );
          });
          const readableNow = new Set((await this.memberProjects(tx, p, f.id)).map((m) => m.id));
          const keep = (
            await sql<{ project_id: string }>`SELECT project_id FROM goals.portfolio_project
              WHERE workspace_id = ${tx.workspaceId} AND portfolio_id = ${f.id}`.execute(tx.db)
          ).rows
            .map((r) => r.project_id)
            .filter((id) => !readableNow.has(id));
          if (keep.length + input.projects.length > this.ws.portfolioProjectsMax)
            throw invalid(
              issue(
                '/projects',
                'too_many',
                `A portfolio holds at most ${this.ws.portfolioProjectsMax} projects.`,
              ),
            );
          const next = new Set(input.projects.map((id) => byPublic.get(id)!.id));
          const removed = [...readableNow].filter((id) => !next.has(id));
          const added = [...next].filter((id) => !readableNow.has(id));
          if (removed.length)
            await tx.db
              .deleteFrom('goals.portfolio_project')
              .where('portfolio_id', '=', f.id)
              .where('project_id', 'in', removed)
              .execute();
          for (const [i, pid] of input.projects.map((id) => byPublic.get(id)!.id).entries()) {
            await sql`INSERT INTO goals.portfolio_project (workspace_id, portfolio_id, project_id, position, added_by_membership_id)
              VALUES (${tx.workspaceId}, ${f.id}, ${pid}, ${i}, ${p.membershipId})
              ON CONFLICT (workspace_id, portfolio_id, project_id) DO UPDATE SET position = EXCLUDED.position`.execute(
              tx.db,
            );
          }
          await tx.db
            .updateTable('goals.portfolio')
            .set({
              updated_at: new Date(),
              updated_by_membership_id: p.membershipId,
              version: Number(f.row.version) + 1,
            })
            .where('id', '=', f.id)
            .execute();
          if (added.length || removed.length) {
            await this.workAudit(
              tx,
              caller,
              p,
              'portfolio.members_changed',
              { recordId: f.id, type: 'portfolio', publicId: f.publicId },
              [
                change.plain('added', null, String(added.length)),
                change.plain('removed', null, String(removed.length)),
              ],
              f.brand?.id ?? null,
            );
            await this.workEvent(
              tx,
              caller,
              p,
              'goals.portfolio.members_changed',
              { type: 'goals.portfolio', id: f.id, sequence: 0 },
              { count: input.projects.length },
              f.brand?.id ?? null,
            );
          }
          return {
            status: 200,
            ref: { id: f.publicId, type: 'portfolio' },
            data: await this.portfolioView(tx, p, await this.loadPortfolio(tx, p, f.publicId)),
          };
        },
        async (tx, p, ref) => this.portfolioView(tx, p, await this.loadPortfolio(tx, p, ref.id)),
      ),
    );
  }

  async portfolioLifecycle(
    caller: Caller,
    ws: unknown,
    portfolio: unknown,
    verb: 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge',
    req: Mutation,
  ) {
    return this.gTrack('goals.changes', `portfolio_${verb}`, () =>
      this.mutate(
        caller,
        `portfolio.${verb}`,
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const f = await this.loadPortfolio(tx, p, portfolio, {
            lock: true,
            allowTrashed: verb === 'restore' || verb === 'purge',
          });
          if (req.ifMatch !== undefined)
            requireVersion(parseIfMatch(req.ifMatch), Number(f.row.version));
          const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
          const facts = {
            id: f.id,
            brand: f.brand,
            lifecycleState: f.lifecycleState,
            chain: [] as never[],
          };
          const state = await tx.db
            .selectFrom('core.record')
            .select(['lifecycle_state', 'deletion_batch_id'])
            .where('id', '=', f.id)
            .executeTakeFirstOrThrow();
          const conflict = () =>
            new TenancyError('conflict', {
              issues: [
                issue('/', 'invalid_state', "This portfolio can't do that in its current state."),
              ],
            });
          if (verb === 'archive') {
            if (state.lifecycle_state !== 'active') throw conflict();
            await this.d.lifecycle.archive(
              tx,
              this.issueLifecycle(tx, p, 'record.archive', facts),
              input,
              f.id,
            );
          } else if (verb === 'unarchive') {
            if (state.lifecycle_state !== 'archived') throw conflict();
            await this.d.lifecycle.unarchive(
              tx,
              this.issueLifecycle(tx, p, 'record.restore', facts),
              input,
              f.id,
            );
          } else if (verb === 'trash') {
            if (state.lifecycle_state !== 'active' && state.lifecycle_state !== 'archived')
              throw conflict();
            await this.d.lifecycle.trash(
              tx,
              this.issueLifecycle(tx, p, 'record.trash', facts),
              input,
              f.id,
            );
          } else {
            if (state.lifecycle_state !== 'trashed') throw conflict();
            const own = await tx.db
              .selectFrom('core.deletion_batch')
              .select('id')
              .where('id', '=', state.deletion_batch_id!)
              .where('root_record_id', '=', f.id)
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
            .where('id', '=', f.id)
            .executeTakeFirstOrThrow();
          return {
            status: verb === 'purge' ? 202 : 200,
            ref: { id: f.publicId, type: 'portfolio' },
            data: {
              id: f.publicId,
              type: 'portfolio' as const,
              lifecycle_state: after.lifecycle_state,
            },
          };
        },
        async (tx, _p, ref) => {
          const r = await tx.db
            .selectFrom('core.record')
            .select(['public_id', 'lifecycle_state'])
            .where('public_id', '=', ref.id)
            .executeTakeFirstOrThrow();
          return {
            id: r.public_id,
            type: 'portfolio' as const,
            lifecycle_state: r.lifecycle_state,
          };
        },
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Insight: the readable projects of a scope, evaluated for this viewer
  // ---------------------------------------------------------------------------------------------

  /**
   * The projects a read covers: the portfolio's (or all) projects the viewer may read, filtered,
   * at most `PORTFOLIO_READ_PROJECTS_MAX`; `truncated` says when more exist than were evaluated.
   */
  protected async scopeProjects(tx: WorkspaceTransaction, p: Principal, q: OverviewQuery) {
    const vis = await this.workVisibility(tx, p);
    const cond: RawBuilder<unknown>[] = [
      sql`w.workspace_id = ${tx.workspaceId}`,
      vis.where('r', { project: sql`w.id` }),
    ];
    let portfolioName: string | null = null;
    if (q.portfolio) {
      const f = await this.loadPortfolio(tx, p, q.portfolio);
      portfolioName = f.row.name;
      cond.push(
        sql`w.id IN (SELECT project_id FROM goals.portfolio_project WHERE workspace_id = ${tx.workspaceId} AND portfolio_id = ${f.id})`,
      );
    }
    if (q.brand) {
      const b = await tx.db
        .selectFrom('core.record')
        .select('id')
        .where('public_id', '=', q.brand)
        .executeTakeFirst();
      cond.push(sql`w.brand_id = ${b?.id ?? NIL}`);
    }
    if (q.statuses) cond.push(sql`w.status_category = ANY(${q.statuses}::text[])`);
    if (q.owner) {
      const owner =
        q.owner === 'me'
          ? p.membershipId
          : ((
              await tx.db
                .selectFrom('tenancy.membership')
                .select('id')
                .where('public_id', '=', q.owner)
                .executeTakeFirst()
            )?.id ?? NIL);
      cond.push(sql`w.owner_membership_id = ${owner}`);
    }
    const max = this.ws.portfolioReadProjectsMax;
    const rows = (
      await sql<
        ProjectFacts & {
          start_date_t: string | null;
          target_date_t: string | null;
          deadline_date_t: string | null;
        }
      >`
        SELECT w.id, r.public_id, w.name, w.brand_id, w.status_category, w.priority,
               w.start_date::text AS start_date_t, w.target_date::text AS target_date_t, w.deadline_date::text AS deadline_date_t,
               w.health, w.health_source, w.owner_membership_id, w.budget_amount::text AS budget_amount, w.budget_currency,
               w.time_budget_minutes, w.ai_budget_micros::text AS ai_budget_micros, w.version
          FROM work.project w JOIN core.record r ON r.workspace_id = w.workspace_id AND r.id = w.id
         WHERE ${sql.join(cond, sql` AND `)}
         ORDER BY w.brand_id, w.rank COLLATE "C", w.id
         LIMIT ${max + 1}`.execute(tx.db)
    ).rows;
    const truncated = rows.length > max;
    const projects = rows.slice(0, max).map((r) => ({
      ...r,
      start_date: r.start_date_t,
      target_date: r.target_date_t,
      deadline_date: r.deadline_date_t,
      version: Number(r.version),
    })) as ProjectFacts[];
    return { projects, truncated, portfolioName, vis };
  }

  protected async taskFacts(
    tx: WorkspaceTransaction,
    p: Principal,
    ids: readonly string[],
    today: string,
  ): Promise<Map<string, TaskFacts>> {
    const out = new Map<string, TaskFacts>();
    if (!ids.length) return out;
    const vis = await this.workVisibility(tx, p);
    const rows = await sql<{
      project_id: string;
      done: string;
      total: string;
      overdue: string;
      blocked: string;
      open: string;
      open_estimate: string;
      unestimated: string;
    }>`
      SELECT t.project_id,
        count(*) FILTER (WHERE t.status_category = 'done')::text AS done,
        count(*) FILTER (WHERE t.status_category <> 'cancelled')::text AS total,
        count(*) FILTER (WHERE t.status_category NOT IN ('done', 'cancelled')
          AND LEAST(t.due_date, t.deadline_date, (t.deadline_at AT TIME ZONE t.deadline_tz)::date) < ${today}::date)::text AS overdue,
        count(*) FILTER (WHERE t.status_category NOT IN ('done', 'cancelled') AND (t.status_category = 'paused' OR EXISTS (
            SELECT 1 FROM relations.record_relationship rr
              JOIN work.task b ON b.workspace_id = rr.workspace_id AND b.id = rr.from_record_id
              JOIN core.record br ON br.workspace_id = b.workspace_id AND br.id = b.id
             WHERE rr.workspace_id = t.workspace_id AND rr.kind = 'blocks' AND rr.to_record_id = t.id
               AND b.status_category NOT IN ('done', 'cancelled')
               AND ${vis.where('br', { project: sql`b.project_id` })})))::text AS blocked,
        count(*) FILTER (WHERE t.status_category NOT IN ('done', 'cancelled'))::text AS open,
        COALESCE(sum(CASE WHEN t.status_category NOT IN ('done', 'cancelled') THEN
            COALESCE(t.remaining_estimate_minutes, GREATEST(t.estimate_minutes - lg.m, 0), 0) ELSE 0 END), 0)::text AS open_estimate,
        count(*) FILTER (WHERE t.status_category NOT IN ('done', 'cancelled')
          AND t.remaining_estimate_minutes IS NULL AND t.estimate_minutes IS NULL)::text AS unestimated
        FROM work.task t
        JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
        LEFT JOIN LATERAL (SELECT COALESCE(sum(e.duration_seconds), 0) / 60 AS m FROM timetrack.time_entry e
              WHERE e.workspace_id = t.workspace_id AND e.task_id = t.id AND e.state = 'stopped') lg ON true
       WHERE t.workspace_id = ${tx.workspaceId} AND t.project_id = ANY(${[...ids]}::uuid[])
         AND ${vis.where('r', { project: sql`t.project_id` })}
         AND NOT EXISTS (SELECT 1 FROM work.task c JOIN core.record cr ON cr.workspace_id = c.workspace_id AND cr.id = c.id
              WHERE c.workspace_id = t.workspace_id AND c.parent_task_id = t.id
                AND ${vis.where('cr', { project: sql`c.project_id` })})
       GROUP BY t.project_id`.execute(tx.db);
    for (const r of rows.rows)
      out.set(r.project_id, {
        done: Number(r.done),
        total: Number(r.total),
        overdue: Number(r.overdue),
        blocked: Number(r.blocked),
        open: Number(r.open),
        open_estimate_minutes: Number(r.open_estimate),
        unestimated_open: Number(r.unestimated),
      });
    return out;
  }

  /** Stopped time on each project (its tasks and itself), over the time this viewer may read (3D T8). */
  protected async loggedMinutes(tx: WorkspaceTransaction, p: Principal, ids: readonly string[]) {
    const out = new Map<string, number>();
    if (!ids.length) return out;
    const vis = await this.workVisibility(tx, p);
    const rows = await sql<{ project_id: string; minutes: string }>`
      SELECT COALESCE(t.project_id, e.project_id) AS project_id, (sum(e.duration_seconds) / 60)::text AS minutes
        FROM timetrack.time_entry e
        LEFT JOIN work.task t ON t.workspace_id = e.workspace_id AND t.id = e.task_id
        JOIN core.record r ON r.workspace_id = e.workspace_id AND r.id = COALESCE(e.task_id, e.project_id)
       WHERE e.workspace_id = ${tx.workspaceId} AND e.state = 'stopped'
         AND COALESCE(t.project_id, e.project_id) = ANY(${[...ids]}::uuid[])
         AND ${vis.where('r', { project: sql`COALESCE(t.project_id, e.project_id)` })}
       GROUP BY 1`.execute(tx.db);
    for (const r of rows.rows) out.set(r.project_id, Number(r.minutes));
    return out;
  }

  /** Readable, active goals tied to each project: scoped to it, linked to it or its tasks, or inherited from an ancestor project. */
  protected async goalCoverage(tx: WorkspaceTransaction, p: Principal, ids: readonly string[]) {
    const out = new Map<string, { direct: number; inherited: number }>();
    if (!ids.length) return out;
    const vis = await this.goalVisibility(tx, p, false);
    const rows = await sql<{ project_id: string; how: string; n: string }>`
      WITH ties AS (
        SELECT l.goal_id, l.target_record_id AS project_id, 'direct' AS how FROM goals.goal_link l
         WHERE l.workspace_id = ${tx.workspaceId} AND l.target_kind = 'project' AND l.target_record_id = ANY(${[...ids]}::uuid[])
        UNION ALL
        SELECT l.goal_id, t.project_id, 'direct' FROM goals.goal_link l
          JOIN work.task t ON t.workspace_id = l.workspace_id AND (t.id = l.target_record_id OR t.ancestor_ids @> ARRAY[l.target_record_id])
         WHERE l.workspace_id = ${tx.workspaceId} AND l.target_kind = 'task' AND t.project_id = ANY(${[...ids]}::uuid[])
        UNION ALL
        SELECT g.id, g.project_id, 'direct' FROM goals.goal g
         WHERE g.workspace_id = ${tx.workspaceId} AND g.project_id = ANY(${[...ids]}::uuid[])
        UNION ALL
        SELECT l.goal_id, w.id, 'inherited' FROM goals.goal_link l
          JOIN work.project w ON w.workspace_id = l.workspace_id AND l.target_record_id = ANY(w.ancestor_ids)
         WHERE l.workspace_id = ${tx.workspaceId} AND l.target_kind = 'project' AND w.id = ANY(${[...ids]}::uuid[])
      )
      SELECT x.project_id, x.how, count(DISTINCT x.goal_id)::text AS n FROM ties x
        JOIN goals.goal g ON g.workspace_id = ${tx.workspaceId} AND g.id = x.goal_id
        JOIN core.record gr ON gr.workspace_id = g.workspace_id AND gr.id = g.id
       WHERE g.status = 'active' AND ${vis.where('gr', { project: sql`g.project_id` })}
       GROUP BY 1, 2`.execute(tx.db);
    for (const r of rows.rows) {
      const cur = out.get(r.project_id) ?? { direct: 0, inherited: 0 };
      cur[r.how as 'direct' | 'inherited'] = Number(r.n);
      out.set(r.project_id, cur);
    }
    return out;
  }

  /**
   * Cross-project `blocks` edges where both tasks are readable and at least one project is in the
   * scope. An edge to a task the viewer cannot read, and anything derived from it, is not here
   * (OD-05): it adds no count and no label.
   */
  protected async crossDependencies(
    tx: WorkspaceTransaction,
    p: Principal,
    ids: readonly string[],
    today: string,
  ) {
    if (!ids.length) return [];
    const vis = await this.workVisibility(tx, p);
    const rows = await sql<{
      blocker_id: string;
      blocker_public: string;
      blocker_title: string;
      blocker_category: string;
      blocker_due: string | null;
      blocker_project: string;
      blocked_id: string;
      blocked_public: string;
      blocked_title: string;
      blocked_category: string;
      blocked_due: string | null;
      blocked_project: string;
    }>`
      SELECT a.id AS blocker_id, ar.public_id AS blocker_public, a.title AS blocker_title, a.status_category AS blocker_category,
             LEAST(a.due_date, a.deadline_date)::text AS blocker_due, a.project_id AS blocker_project,
             b.id AS blocked_id, br.public_id AS blocked_public, b.title AS blocked_title, b.status_category AS blocked_category,
             LEAST(b.due_date, b.deadline_date)::text AS blocked_due, b.project_id AS blocked_project
        FROM relations.record_relationship rr
        JOIN work.task a ON a.workspace_id = rr.workspace_id AND a.id = rr.from_record_id
        JOIN work.task b ON b.workspace_id = rr.workspace_id AND b.id = rr.to_record_id
        JOIN core.record ar ON ar.workspace_id = a.workspace_id AND ar.id = a.id
        JOIN core.record br ON br.workspace_id = b.workspace_id AND br.id = b.id
       WHERE rr.workspace_id = ${tx.workspaceId} AND rr.kind = 'blocks'
         AND a.project_id IS NOT NULL AND b.project_id IS NOT NULL AND a.project_id <> b.project_id
         AND (a.project_id = ANY(${[...ids]}::uuid[]) OR b.project_id = ANY(${[...ids]}::uuid[]))
         AND ${vis.where('ar', { project: sql`a.project_id` })}
         AND ${vis.where('br', { project: sql`b.project_id` })}
       ORDER BY a.project_id, b.project_id, a.id, b.id LIMIT ${this.ws.portfolioReadProjectsMax * 4}`.execute(
      tx.db,
    );
    return rows.rows.map((r) => ({
      ...r,
      state: dependencyState({
        blockerCategory: r.blocker_category,
        blockerDue: r.blocker_due,
        blockedDue: r.blocked_due,
        today,
      }),
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Overview (GOAL-007, GOAL-008, GOAL-009)
  // ---------------------------------------------------------------------------------------------

  protected async evaluateScope(tx: WorkspaceTransaction, p: Principal, q: OverviewQuery) {
    const today = await this.workspaceToday(tx);
    const scope = await this.scopeProjects(tx, p, q);
    const ids = scope.projects.map((r) => r.id);
    const [tasks, logged, coverage, deps] = await Promise.all([
      this.taskFacts(tx, p, ids, today),
      this.loggedMinutes(tx, p, ids),
      this.goalCoverage(tx, p, ids),
      this.crossDependencies(tx, p, ids, today),
    ]);
    const people = await this.goalPeople(
      tx,
      p,
      scope.projects.map((r) => r.owner_membership_id),
    );
    const brands = new Map<string, Awaited<ReturnType<PortfolioService['brandFactsOf']>>>();
    for (const b of new Set(scope.projects.map((r) => r.brand_id)))
      brands.set(b, await this.brandFactsOf(tx, b));
    const idToPublic = new Map(scope.projects.map((r) => [r.id, r.public_id]));
    const rows = scope.projects.map((r) => {
      const t = tasks.get(r.id) ?? {
        done: 0,
        total: 0,
        overdue: 0,
        blocked: 0,
        open: 0,
        open_estimate_minutes: 0,
        unestimated_open: 0,
      };
      const lg = logged.get(r.id) ?? 0;
      const input: HealthInput = {
        today,
        statusCategory: r.status_category,
        startDate: r.start_date,
        targetDate: r.target_date,
        deadlineDate: r.deadline_date,
        done: t.done,
        total: t.total,
        overdue: t.overdue,
        blocked: t.blocked,
        timeBudgetMinutes: r.time_budget_minutes,
        loggedMinutes: lg,
      };
      const health = evaluateHealth(input);
      const next =
        [r.target_date, r.deadline_date].filter((d): d is string => !!d).sort()[0] ?? null;
      const cov = coverage.get(r.id) ?? { direct: 0, inherited: 0 };
      const out = deps.filter((d) => d.blocker_project === r.id && d.state !== 'resolved');
      const inn = deps.filter((d) => d.blocked_project === r.id && d.state !== 'resolved');
      const brand = brands.get(r.brand_id)!;
      return {
        id: r.public_id,
        type: 'project' as const,
        name: r.name,
        brand: brand.marker,
        status: {
          category: r.status_category,
          label: STATUS_LABEL[r.status_category] ?? r.status_category,
        },
        priority: r.priority,
        owner: people.get(r.owner_membership_id) ?? null,
        dates: {
          start: r.start_date,
          target: r.target_date,
          deadline: r.deadline_date,
          next_deadline: next,
        },
        declared_health: r.health ? { value: r.health, source: r.health_source } : null,
        health: {
          value: health.health,
          label: HEALTH_LABEL[health.health],
          reasons: health.reasons,
          incomplete: health.incomplete,
          differs_from_declared: !!r.health && r.health !== health.health,
        },
        progress: {
          done: t.done,
          total: t.total,
          percent: workPercent(t.done, t.total),
          basis: 'readable_leaf_tasks' as const,
        },
        tasks: { open: t.open, overdue: t.overdue, blocked: t.blocked },
        effort: {
          open_estimate_minutes: t.open_estimate_minutes,
          unestimated_open_tasks: t.unestimated_open,
          logged_minutes: lg,
        },
        budget: {
          money:
            r.budget_amount !== null
              ? { amount: num(r.budget_amount), currency: r.budget_currency, spend: null }
              : null,
          time:
            r.time_budget_minutes !== null
              ? { minutes: r.time_budget_minutes, logged_minutes: lg }
              : null,
          ai:
            r.ai_budget_micros !== null
              ? { micros: Number(r.ai_budget_micros), usage: null }
              : null,
        },
        goals: {
          direct: cov.direct,
          inherited: cov.inherited,
          linked: cov.direct + cov.inherited > 0,
        },
        dependencies: { blocking: out.length, blocked_by: inn.length },
        version: r.version,
      };
    });
    return { today, rows, deps, idToPublic, scope };
  }

  async portfolioOverview(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const q = parseOverview(query, this.ws.pageLimitMax);
    return this.gTrack('goals.reads', 'overview', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        this.requireMemberKind(p);
        const ev = await this.evaluateScope(tx, p, q);
        const filtered = q.health
          ? ev.rows.filter((r) => q.health!.includes(r.health.value))
          : ev.rows;
        return this.overviewBody(tx, p, ev, filtered, q.limit ?? 100);
      }),
    );
  }

  /** The overview of one saved portfolio (404 when the portfolio is not readable). */
  async portfolioDetail(
    caller: Caller,
    ws: unknown,
    portfolio: unknown,
    query: Record<string, unknown>,
  ) {
    const q = { ...parseOverview(query, this.ws.pageLimitMax), portfolio: portfolio as string };
    return this.gTrack('goals.reads', 'portfolio_overview', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        this.requireMemberKind(p);
        const f = await this.loadPortfolio(tx, p, portfolio);
        const ev = await this.evaluateScope(tx, p, q);
        const filtered = q.health
          ? ev.rows.filter((r) => q.health!.includes(r.health.value))
          : ev.rows;
        return {
          portfolio: await this.portfolioView(tx, p, f),
          ...(await this.overviewBody(tx, p, ev, filtered, q.limit ?? 100)),
        };
      }),
    );
  }

  protected async overviewBody(
    _tx: WorkspaceTransaction,
    _p: Principal,
    ev: Awaited<ReturnType<PortfolioService['evaluateScope']>>,
    rows: Awaited<ReturnType<PortfolioService['evaluateScope']>>['rows'],
    limit: number,
  ) {
    const today = ev.today;
    const sorted = [...rows].sort(
      (a, b) =>
        HEALTH_ORDER[a.health.value] - HEALTH_ORDER[b.health.value] ||
        (a.dates.next_deadline ?? '9999').localeCompare(b.dates.next_deadline ?? '9999') ||
        a.name.localeCompare(b.name),
    );
    const byStatus: Record<string, number> = {
      planned: 0,
      active: 0,
      paused: 0,
      done: 0,
      cancelled: 0,
    };
    const byHealth: Record<string, number> = {
      off_track: 0,
      at_risk: 0,
      on_track: 0,
      complete: 0,
      unknown: 0,
    };
    const money = new Map<string, { currency: string; budgeted: number; projects: number }>();
    let timeBudgeted = 0,
      timeLogged = 0,
      timeOver = 0,
      timeProjects = 0,
      aiBudgeted = 0,
      aiProjects = 0;
    let openEstimate = 0,
      unestimated = 0,
      logged = 0,
      withoutGoals = 0,
      overdueProjects = 0,
      due30 = 0;
    const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const upcoming: Array<{ id: string; name: string; date: string; kind: 'target' | 'deadline' }> =
      [];
    for (const r of rows) {
      byStatus[r.status.category] = (byStatus[r.status.category] ?? 0) + 1;
      byHealth[r.health.value] = (byHealth[r.health.value] ?? 0) + 1;
      if (r.budget.money && r.budget.money.amount !== null && r.budget.money.currency) {
        const m = money.get(r.budget.money.currency) ?? {
          currency: r.budget.money.currency,
          budgeted: 0,
          projects: 0,
        };
        m.budgeted += r.budget.money.amount;
        m.projects++;
        money.set(r.budget.money.currency, m);
      }
      if (r.budget.time) {
        timeProjects++;
        timeBudgeted += r.budget.time.minutes;
        timeLogged += r.budget.time.logged_minutes;
        if (r.budget.time.logged_minutes > r.budget.time.minutes) timeOver++;
      }
      if (r.budget.ai) {
        aiProjects++;
        aiBudgeted += r.budget.ai.micros;
      }
      openEstimate += r.effort.open_estimate_minutes;
      unestimated += r.effort.unestimated_open_tasks;
      logged += r.effort.logged_minutes;
      if (
        !r.goals.linked &&
        (ORPHAN_PROJECT_CATEGORIES as readonly string[]).includes(r.status.category)
      )
        withoutGoals++;
      const open = r.status.category !== 'done' && r.status.category !== 'cancelled';
      if (open) {
        let late = false;
        for (const [kind, date] of [
          ['target', r.dates.target],
          ['deadline', r.dates.deadline],
        ] as const) {
          if (!date) continue;
          if (date < today) late = true;
          else if (date <= horizon) {
            due30++;
            upcoming.push({ id: r.id, name: r.name, date, kind });
          }
        }
        // A project counts once, however many of its dates have passed.
        if (late) overdueProjects++;
      }
    }
    const depOpen = ev.deps.filter((d) => d.state !== 'resolved');
    const depState = (s: DependencyState) => depOpen.filter((d) => d.state === s).length;
    return {
      data: sorted.slice(0, limit),
      summary: {
        projects: rows.length,
        by_status: byStatus,
        by_health: byHealth,
        schedule: {
          overdue_projects: overdueProjects,
          due_in_30_days: due30,
          upcoming: upcoming
            .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
            .slice(0, 10),
        },
        effort: {
          open_estimate_minutes: openEstimate,
          unestimated_open_tasks: unestimated,
          logged_minutes: logged,
        },
        budgets: {
          money: {
            by_currency: [...money.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
            spend_tracked: false,
          },
          time: {
            budgeted_minutes: timeBudgeted,
            logged_minutes: timeLogged,
            over_budget_projects: timeOver,
            projects: timeProjects,
          },
          ai: { budgeted_micros: aiBudgeted, usage_tracked: false, projects: aiProjects },
        },
        goals: { projects_without_goals: withoutGoals },
        dependencies: {
          open: depOpen.length,
          overdue: depState('overdue'),
          late: depState('late'),
        },
      },
      page: { limit, has_more: rows.length > limit },
      coverage: {
        evaluated_projects: ev.rows.length,
        truncated: ev.scope.truncated,
        scope: ev.scope.portfolioName ? 'portfolio' : 'readable_projects',
        note: 'Covers the projects, tasks, goals, and time you can read. Work you cannot read changes no figure here.',
        not_tracked: ['money_spend', 'ai_usage'],
      },
      as_of: new Date().toISOString(),
      computed: 'live' as const,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Dependencies (GOAL-010) and orphans (GOAL-012, GOAL-013)
  // ---------------------------------------------------------------------------------------------

  async portfolioDependencies(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const q = parseOverview(query, this.ws.pageLimitMax);
    return this.gTrack('goals.reads', 'dependencies', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        this.requireMemberKind(p);
        const ev = await this.evaluateScope(tx, p, q);
        const names = new Map<string, { id: string; name: string; brand: unknown }>();
        const missing = [
          ...new Set(ev.deps.flatMap((d) => [d.blocker_project, d.blocked_project])),
        ].filter((id) => !ev.idToPublic.has(id));
        const visible = new Map(
          ev.rows.map((r) => [ev.scope.projects.find((x) => x.public_id === r.id)!.id, r]),
        );
        for (const [id, r] of visible) names.set(id, { id: r.id, name: r.name, brand: r.brand });
        if (missing.length) {
          const vis = await this.workVisibility(tx, p);
          const rows = await sql<{ id: string; public_id: string; name: string; brand_id: string }>`
            SELECT w.id, r.public_id, w.name, w.brand_id FROM work.project w JOIN core.record r ON r.workspace_id = w.workspace_id AND r.id = w.id
             WHERE w.id = ANY(${missing}::uuid[]) AND ${vis.where('r', { project: sql`w.id` })}`.execute(
            tx.db,
          );
          for (const r of rows.rows)
            names.set(r.id, {
              id: r.public_id,
              name: r.name,
              brand: (await this.brandFactsOf(tx, r.brand_id)).marker,
            });
        }
        const pairs = new Map<
          string,
          {
            blocker_project: unknown;
            blocked_project: unknown;
            counts: Record<DependencyState, number>;
            edges: Array<{ blocker: unknown; blocked: unknown; state: DependencyState }>;
          }
        >();
        for (const d of ev.deps) {
          const a = names.get(d.blocker_project);
          const b = names.get(d.blocked_project);
          // A project the viewer cannot read is never named: the pair is left out entirely.
          if (!a || !b) continue;
          const key = `${d.blocker_project}>${d.blocked_project}`;
          const cur = pairs.get(key) ?? {
            blocker_project: a,
            blocked_project: b,
            counts: { resolved: 0, open: 0, overdue: 0, late: 0 },
            edges: [],
          };
          cur.counts[d.state]++;
          if (cur.edges.length < 10)
            cur.edges.push({
              blocker: {
                id: d.blocker_public,
                title: d.blocker_title,
                status_category: d.blocker_category,
                due: d.blocker_due,
              },
              blocked: {
                id: d.blocked_public,
                title: d.blocked_title,
                status_category: d.blocked_category,
                due: d.blocked_due,
              },
              state: d.state,
            });
          pairs.set(key, cur);
        }
        const data = [...pairs.values()].sort(
          (x, y) =>
            y.counts.overdue - x.counts.overdue ||
            y.counts.late - x.counts.late ||
            y.counts.open - x.counts.open,
        );
        const sum = (s: DependencyState) => data.reduce((n, d) => n + d.counts[s], 0);
        return {
          data,
          summary: {
            open: sum('open'),
            overdue: sum('overdue'),
            late: sum('late'),
            resolved: sum('resolved'),
          },
          coverage: {
            evaluated_projects: ev.rows.length,
            truncated: ev.scope.truncated,
            note: 'Only dependencies between work you can read are shown; a dependency on work you cannot read is not counted.',
          },
          as_of: new Date().toISOString(),
          computed: 'live' as const,
        };
      }),
    );
  }

  /**
   * Projects without a linked goal and goals without active work. Both are relative to the viewer:
   * "no linked goal you can read" and "no active work you can read". A project whose only goals are
   * hidden from the viewer is reported as unlinked for that viewer, and says so.
   */
  async portfolioOrphans(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const q = parseOverview(query, this.ws.pageLimitMax);
    return this.gTrack('goals.reads', 'orphans', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        this.requireMemberKind(p);
        const ev = await this.evaluateScope(tx, p, q);
        const projects = ev.rows
          .filter(
            (r) =>
              (ORPHAN_PROJECT_CATEGORIES as readonly string[]).includes(r.status.category) &&
              !r.goals.linked,
          )
          .map((r) => ({
            id: r.id,
            type: 'project' as const,
            name: r.name,
            brand: r.brand,
            status: r.status,
            owner: r.owner,
            reason: 'no_linked_goal' as const,
          }));
        const vis = await this.goalVisibility(tx, p, false);
        const brandFilter = q.brand
          ? ((
              await tx.db
                .selectFrom('core.record')
                .select('id')
                .where('public_id', '=', q.brand)
                .executeTakeFirst()
            )?.id ?? NIL)
          : null;
        const goalRows = await sql<{ id: string; public_id: string }>`
          SELECT g.id, r.public_id FROM goals.goal g JOIN core.record r ON r.workspace_id = g.workspace_id AND r.id = g.id
           WHERE g.workspace_id = ${tx.workspaceId} AND g.status = 'active' AND ${vis.where('r', { project: sql`g.project_id` })}
             ${brandFilter ? sql`AND g.brand_id = ${brandFilter}` : sql``}
           ORDER BY g.period_end, g.id LIMIT ${this.ws.portfolioReadProjectsMax + 1}`.execute(
          tx.db,
        );
        const goalTruncated = goalRows.rows.length > this.ws.portfolioReadProjectsMax;
        const goalIds = goalRows.rows.slice(0, this.ws.portfolioReadProjectsMax).map((r) => r.id);
        const links = await this.linksOf(tx, goalIds);
        const work = await this.activeWorkOf(tx, p, links);
        const quiet = goalRows.rows
          .slice(0, this.ws.portfolioReadProjectsMax)
          .filter((r) => (work.get(r.id)?.active_links ?? 0) === 0);
        const goals = [];
        for (const r of quiet) {
          const g = await this.loadGoal(tx, p, r.public_id);
          const people = await this.goalPeople(tx, p, [g.row.owner_membership_id]);
          const w = work.get(r.id) ?? { visible_links: 0, active_links: 0 };
          goals.push({
            id: g.publicId,
            type: 'goal' as const,
            title: g.row.title,
            scope: g.projectId ? 'project' : g.brand ? 'brand' : 'workspace',
            brand: g.brandMarker,
            owner: people.get(g.row.owner_membership_id) ?? null,
            period_end: g.row.period_end,
            reason:
              w.visible_links === 0 ? ('no_visible_work' as const) : ('no_active_work' as const),
          });
        }
        return {
          projects: { data: projects, truncated: ev.scope.truncated },
          goals: { data: goals, truncated: goalTruncated },
          coverage: {
            relative_to: 'viewer' as const,
            note: 'Findings cover the goals, projects, and work you can read. A goal or project that looks unlinked may be linked to something you cannot read.',
          },
          as_of: new Date().toISOString(),
          computed: 'live' as const,
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------------------------

  async exportPortfolio(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const format =
      query.format === 'json'
        ? 'json'
        : query.format === undefined || query.format === 'csv'
          ? 'csv'
          : null;
    if (!format) throw invalid(issue('/format', 'invalid_option', 'Choose csv or json.'));
    const { format: _f, ...rest } = query;
    const q = parseOverview(rest, this.ws.pageLimitMax);
    return this.gTrack('goals.reads', 'portfolio_export', () =>
      this.inWorkspace(caller, ws, {}, async (tx, p) => {
        this.requireMemberKind(p);
        const ev = await this.evaluateScope(tx, p, q);
        const rows = q.health ? ev.rows.filter((r) => q.health!.includes(r.health.value)) : ev.rows;
        if (ev.scope.truncated || rows.length > this.ws.goalsExportRowsMax)
          throw invalid(
            issue(
              '/',
              'too_many',
              'Narrow the filters: this export would not cover every project.',
            ),
          );
        const header = [
          'id',
          'name',
          'brand',
          'status',
          'owner',
          'start',
          'target',
          'deadline',
          'declared_health',
          'computed_health',
          'health_reasons',
          'done_tasks',
          'total_tasks',
          'percent',
          'open_tasks',
          'overdue_tasks',
          'blocked_tasks',
          'open_estimate_minutes',
          'unestimated_open_tasks',
          'logged_minutes',
          'time_budget_minutes',
          'money_budget',
          'money_currency',
          'ai_budget_micros',
          'linked_goals',
          'blocking',
          'blocked_by',
        ];
        const brandName = (m: unknown) =>
          m && typeof m === 'object' && 'name' in m ? String((m as { name: string }).name) : '';
        const body = rows.map((r) => [
          r.id,
          r.name,
          brandName(r.brand),
          r.status.label,
          r.owner?.name ?? '',
          r.dates.start ?? '',
          r.dates.target ?? '',
          r.dates.deadline ?? '',
          r.declared_health?.value ?? '',
          r.health.value,
          r.health.reasons.map((x) => x.code).join(' '),
          r.progress.done,
          r.progress.total,
          r.progress.percent ?? '',
          r.tasks.open,
          r.tasks.overdue,
          r.tasks.blocked,
          r.effort.open_estimate_minutes,
          r.effort.unestimated_open_tasks,
          r.effort.logged_minutes,
          r.budget.time?.minutes ?? '',
          r.budget.money?.amount ?? '',
          r.budget.money?.currency ?? '',
          r.budget.ai?.micros ?? '',
          r.goals.direct + r.goals.inherited,
          r.dependencies.blocking,
          r.dependencies.blocked_by,
        ]);
        await this.workWriter.write(tx, this.cmd(caller, p), {
          action: 'portfolio.exported',
          target: { type: 'workspace', recordId: tx.workspaceId, publicId: String(ws) },
          changes: [
            change.plain('format', null, format),
            change.plain('rows', null, String(body.length)),
          ],
        });
        await this.d.security.record(tx, {
          category: 'export',
          action: 'portfolio.export',
          outcome: 'success',
          actor: { type: 'human', id: p.membershipId },
          subject: { type: 'workspace', id: tx.workspaceId },
          correlationId: caller.meta.correlationId,
        });
        const stamp = ev.today;
        return format === 'csv'
          ? {
              format,
              filename: `portfolio-${stamp}.csv`,
              body: csv(header, body),
              rows: body.length,
            }
          : {
              format,
              filename: `portfolio-${stamp}.json`,
              body: JSON.stringify(
                {
                  as_of: new Date().toISOString(),
                  scope_note: 'Projects, tasks, and time you can read.',
                  projects: rows,
                },
                null,
                2,
              ),
              rows: body.length,
            };
      }),
    );
  }
}
