import { AuditWriter, change } from '@pm/audit';
import { canonicalJson, newPublicId, newUuidV7, type IdPrefix } from '@pm/contracts';
import {
  PROJECT_STATUSES,
  evenRanks,
  rankBetween,
  type ProjectStatusKey,
} from '@pm/contracts/shell';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import {
  applyFieldMerge,
  auditDiff,
  brandMarker,
  bumpEpoch,
  compileVisibility,
  decideBrand,
  decideProject,
  decideRecord,
  findBrand,
  invalid,
  issue,
  issueRecordLifecycleDecision,
  levelRank,
  NavigationService,
  parseIfMatch,
  parseMerge,
  projectChainOf,
  recordLevel,
  requireVersion,
  TenancyError,
  type BrandFacts,
  type Caller,
  type Level,
  type Mutation,
  type NavigationDeps,
  type Principal,
  type ProjectChain,
  type RecordLifecycleAction,
  type ShareLevel,
} from '@pm/tenancy';
import type { ActionKey } from '@pm/contracts';
import {
  DEFAULT_WORK_SETTINGS,
  isPublic,
  parseAccess,
  parseMove,
  parseProjectCreate,
  PROJECT_CONTENT_FIELDS,
  PROJECT_FIELDS,
  projectField,
  type WorkSettings,
} from './validation.ts';

export interface WorkDeps extends NavigationDeps {
  work?: WorkSettings;
}

/** A project resolved through the one compiled level (brand, project chain, share, lifecycle). */
export interface LoadedProject {
  id: string;
  publicId: string;
  brand: BrandFacts & { publicId: string; name: string };
  brandMarker: ReturnType<typeof brandMarker>;
  chain: ProjectChain;
  lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
  level: Level;
  /** Level from ownership-derived authority only (shares never authorize sharing or managing). */
  ownLevel: Level | null;
  row: {
    parent_project_id: string | null;
    ancestor_ids: string[];
    depth: number;
    name: string;
    description_rich: unknown;
    icon: string | null;
    color: string | null;
    status_id: string;
    status_category: string;
    priority: string;
    start_date: string | null;
    target_date: string | null;
    deadline_date: string | null;
    completed_at: Date | null;
    health: string | null;
    health_source: string | null;
    owner_membership_id: string;
    budget_amount: string | null;
    budget_currency: string | null;
    time_budget_minutes: number | null;
    ai_budget_micros: string | null;
    rank: string;
    access_mode: 'inherit' | 'restricted';
    allow_record_shares: boolean;
    recurrence_series_id: string | null;
    occurrence_key: string | null;
    intake_source_id: string | null;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
}

const STATUS_BY_KEY = new Map(PROJECT_STATUSES.map((s) => [s.key, s]));
const STATUS_ID: Record<ProjectStatusKey, string> = {
  planned: '01920000-0000-7000-8000-000000000001',
  active: '01920000-0000-7000-8000-000000000002',
  on_hold: '01920000-0000-7000-8000-000000000003',
  completed: '01920000-0000-7000-8000-000000000004',
  cancelled: '01920000-0000-7000-8000-000000000005',
};
const KEY_BY_STATUS_ID = new Map(
  Object.entries(STATUS_ID).map(([k, v]) => [v, k as ProjectStatusKey]),
);

const DATE_FIELDS = new Set(['start_date', 'target_date', 'deadline_date']);
const toDate = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v.toISOString().slice(0, 10)
      : String(v).slice(0, 10);

/** The database errors a work command maps to safe validation or conflict issues. */
/**
 * The strict descendants of one project as a recursive CTE named `sub` (id, depth). It descends by
 * `parent_project_id` through `project_children`: array containment is not leakproof, so under RLS
 * an `ancestor_ids` predicate could not use an index. Depth is bounded by the database ceiling.
 */
const subtree = (id: string) => sql`sub AS (
    SELECT id, depth FROM work.project WHERE parent_project_id = ${id}
    UNION ALL
    SELECT c.id, c.depth FROM work.project c JOIN sub ON c.parent_project_id = sub.id
  )`;

function pg(err: unknown): { code?: string; constraint?: string; message?: string } {
  return typeof err === 'object' && err !== null
    ? (err as { code?: string; constraint?: string })
    : {};
}

/**
 * Phase 2A projects (0B ADR-21, 0C AZ-21). Extends the 1C–1E service chain: one membership
 * resolution, one compiler, one idempotency/audit/outbox transaction per command. Project content
 * is audited by the `work` module writer; authority rows are written only through tenancy.
 */
export class ProjectService extends NavigationService {
  protected readonly ws: WorkSettings;
  protected readonly workWriter: AuditWriter;

  constructor(deps: WorkDeps) {
    super(deps);
    this.ws = deps.work ?? DEFAULT_WORK_SETTINGS;
    this.workWriter = new AuditWriter({
      module: 'work',
      logger: deps.logger,
      metrics: deps.metrics,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Resolution and authorization
  // ---------------------------------------------------------------------------------------------

  protected async loadProject(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    opts: { lock?: boolean } = {},
  ): Promise<LoadedProject> {
    if (!isPublic(publicId, 'prj')) throw new TenancyError('not_found');
    let q = tx.db
      .selectFrom('core.record as r')
      .innerJoin('work.project as w', (j) =>
        j.onRef('w.workspace_id', '=', 'r.workspace_id').onRef('w.id', '=', 'r.id'),
      )
      .selectAll('w')
      .select(['r.public_id'])
      .where('r.public_id', '=', publicId)
      .where('r.record_type', '=', 'project');
    if (opts.lock) q = q.forUpdate('w');
    const row = await q.executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    const brandRow = await tx.db
      .selectFrom('tenancy.brand as b')
      .innerJoin('core.record as br', (j) =>
        j.onRef('br.workspace_id', '=', 'b.workspace_id').onRef('br.id', '=', 'b.id'),
      )
      .select([
        'b.id',
        'br.public_id',
        'b.name',
        'b.short_name',
        'b.color',
        'b.icon',
        'b.is_sensitive',
        'b.lifecycle_state',
      ])
      .where('b.id', '=', row.brand_id)
      .executeTakeFirstOrThrow();
    const scope = await projectChainOf(tx, row.id);
    if (!scope) throw new TenancyError('not_found');
    const brand = {
      id: brandRow.id,
      publicId: brandRow.public_id,
      name: brandRow.name,
      isSensitive: brandRow.is_sensitive,
      lifecycleState: brandRow.lifecycle_state,
    };
    const shareLevel = await this.shareLevelOf(tx, p, row.id);
    const facts = {
      brand,
      lifecycleState: row.lifecycle_state,
      projectChain: scope.chain,
    };
    const level = recordLevel(p, { ...facts, shareLevel });
    if (level === null) throw new TenancyError('not_found');
    return {
      id: row.id,
      publicId: row.public_id,
      brand,
      brandMarker: brandMarker({ ...brandRow }),
      chain: scope.chain,
      lifecycleState: row.lifecycle_state,
      level,
      ownLevel: recordLevel(p, { ...facts, shareLevel: null }),
      row: {
        ...row,
        start_date: toDate(row.start_date),
        target_date: toDate(row.target_date),
        deadline_date: toDate(row.deadline_date),
        completed_at: row.completed_at ? new Date(row.completed_at) : null,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
        budget_amount: row.budget_amount === null ? null : String(row.budget_amount),
        ai_budget_micros: row.ai_budget_micros === null ? null : String(row.ai_budget_micros),
        version: Number(row.version),
      } as LoadedProject['row'],
    };
  }

  /** The best active, unexpired exact-record grant the principal holds on a record. */
  protected async shareLevelOf(
    tx: WorkspaceTransaction,
    p: Principal,
    recordId: string,
  ): Promise<ShareLevel | null> {
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const rows = await tx.db
      .selectFrom('access.record_grant')
      .select('level')
      .where('record_id', '=', recordId)
      .where('state', '=', 'active')
      .where(
        'grantee_key',
        'in',
        vis.ctx.subjects.length ? vis.ctx.subjects : ['00000000-0000-7000-8000-000000000000'],
      )
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
      .execute();
    const order: ShareLevel[] = ['read', 'comment', 'edit'];
    let best: ShareLevel | null = null;
    for (const r of rows)
      if (best === null || order.indexOf(r.level as ShareLevel) > order.indexOf(best))
        best = r.level as ShareLevel;
    return best;
  }

  /** Record-scope decision on a project (or a record governed by it). */
  protected requireProjectAction(
    p: Principal,
    action: ActionKey,
    project: LoadedProject,
    opts: { shares?: boolean; lifecycleState?: LoadedProject['lifecycleState'] } = {},
  ): void {
    // A share grants the project and its intrinsic facts only (ADR-0013 P5): to a share-only
    // reader, everything a share excludes does not exist (not_found, never forbidden).
    if (opts.shares === false && project.ownLevel === null) throw new TenancyError('not_found');
    const o = decideRecord(p, action, {
      brand: project.brand,
      lifecycleState: opts.lifecycleState ?? project.lifecycleState,
      shareLevel: opts.shares === false ? null : this.#shareFor(project),
      projectChain: project.chain,
    });
    this.decision(action, o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  #shareFor(project: LoadedProject): ShareLevel | null {
    if (project.ownLevel !== null && levelRank(project.ownLevel) >= levelRank(project.level))
      return null;
    return project.level === 'view' ? 'read' : project.level === 'manage' ? 'edit' : project.level;
  }

  /** Project-scope admin or create decision (never satisfied by shares). */
  protected requireProjectScope(p: Principal, action: ActionKey, project: LoadedProject): void {
    const o = decideProject(p, action, {
      brand: project.brand,
      lifecycleState: project.lifecycleState,
      chain: project.chain,
    });
    this.decision(action, o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  /** Content commands require an active (not archived) project. */
  protected requireActive(project: LoadedProject): void {
    if (project.lifecycleState !== 'active')
      throw new TenancyError('conflict', {
        issues: [
          issue('/', 'project_archived', 'This project is archived. Restore it to make changes.'),
        ],
      });
  }

  protected issueLifecycle<A extends RecordLifecycleAction>(
    tx: WorkspaceTransaction,
    p: Principal,
    action: A,
    record: {
      id: string;
      brand: BrandFacts;
      lifecycleState: LoadedProject['lifecycleState'];
      chain: ProjectChain;
    },
  ) {
    try {
      const d = issueRecordLifecycleDecision(tx, p, action, {
        id: record.id,
        brand: record.brand,
        lifecycleState: record.lifecycleState,
        projectChain: record.chain,
      });
      this.decision(action, { allowed: true });
      return d;
    } catch (err) {
      if (err instanceof TenancyError) this.decision(action, { allowed: false, code: err.code });
      throw err;
    }
  }

  protected async workAudit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    target: { recordId: string | null; type: string; publicId: string | null },
    changes: ReturnType<typeof change.plain>[],
    brandId: string,
  ): Promise<string> {
    return this.workWriter.write(tx, this.cmd(caller, p, brandId), { action, target, changes });
  }

  protected async workEvent(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    type: Parameters<typeof writeOutboxEvent>[1]['type'],
    aggregate: { type: string; id: string; sequence: number },
    data: Record<string, string | number | boolean | null>,
    brandId: string,
  ): Promise<void> {
    await writeOutboxEvent(tx, {
      type,
      aggregate,
      data,
      actor: { type: 'human', id: p.membershipId },
      context: this.exec(caller, p),
      brandId,
    });
  }

  /** An active internal member of this workspace (owners, phase/milestone owners). */
  protected async memberByPublic(tx: WorkspaceTransaction, publicId: string, pointer: string) {
    const m = await tx.db
      .selectFrom('tenancy.membership')
      .select(['id', 'public_id', 'kind', 'state'])
      .where('public_id', '=', publicId)
      .executeTakeFirst();
    if (!m || m.kind !== 'member' || m.state !== 'active')
      throw invalid(
        issue(pointer, 'invalid_reference', 'Choose an active member of this workspace.'),
      );
    return m;
  }

  /** Ensures `membershipId` holds an explicit project manage grant (0C AZ-21). */
  protected async ensureManagerGrant(
    tx: WorkspaceTransaction,
    projectId: string,
    membershipId: string,
    grantedBy: string,
  ): Promise<boolean> {
    const role = await tx.db
      .selectFrom('access.role')
      .select('id')
      .where('key', '=', 'scope_manage')
      .executeTakeFirstOrThrow();
    const existing = await tx.db
      .selectFrom('access.role_assignment')
      .select(['id', 'role_id'])
      .where('principal_type', '=', 'membership')
      .where('principal_id', '=', membershipId)
      .where('project_scope_id', '=', projectId)
      .forUpdate()
      .executeTakeFirst();
    if (existing?.role_id === role.id) return false;
    if (existing)
      await tx.db
        .updateTable('access.role_assignment')
        .set({ role_id: role.id, version: sql`version + 1` })
        .where('id', '=', existing.id)
        .execute();
    else
      await tx.db
        .insertInto('access.role_assignment')
        .values({
          id: newUuidV7(),
          workspace_id: tx.workspaceId,
          principal_type: 'membership',
          principal_id: membershipId,
          scope_type: 'project',
          scope_id: projectId,
          role_id: role.id,
          role_kind: 'scope_level',
          grant_source: 'project_manager',
          granted_by_membership_id: grantedBy,
        })
        .execute();
    await bumpEpoch(tx, 'principal', membershipId);
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  protected statusView(statusId: string) {
    const key = KEY_BY_STATUS_ID.get(statusId) ?? 'planned';
    const s = STATUS_BY_KEY.get(key)!;
    return { key: s.key, name: s.name, category: s.category };
  }

  protected capabilities(p: Principal, project: LoadedProject) {
    const facts = (lifecycleState: LoadedProject['lifecycleState'], shares: boolean) => ({
      brand: project.brand,
      lifecycleState,
      shareLevel: shares ? this.#shareFor(project) : null,
      projectChain: project.chain,
    });
    const rec = (a: ActionKey, shares = true) =>
      decideRecord(p, a, facts(project.lifecycleState, shares)).allowed;
    const life = (a: ActionKey) => decideRecord(p, a, facts('active', false)).allowed;
    const scope = (a: ActionKey) =>
      decideProject(p, a, {
        brand: project.brand,
        lifecycleState: project.lifecycleState,
        chain: project.chain,
      }).allowed;
    const active = project.lifecycleState === 'active';
    return {
      /** The project's own fields and intrinsic facts (criteria, scope entries); a share may grant it. */
      edit: active && rec('record.update'),
      /** Phases, milestones, decisions, updates: own authority only (never through a share). */
      edit_structure: active && rec('record.update', false),
      comment: rec('record.comment'),
      complete: active && rec('project.complete', false),
      create_child: active && scope('record.create'),
      manage_access: scope('access.grant_scope'),
      restrict: scope('access.restrict_scope'),
      share: active && rec('record.share', false),
      move: active && rec('record.move', false),
      relate: active && rec('record.relate', false),
      archive: active && life('record.archive'),
      restore: project.lifecycleState === 'archived' && life('record.restore'),
      trash: life('record.trash'),
      verify_update: active && p.kind === 'member' && rec('project.verify_update', false),
      // Each occurrence is a new project in the brand, so it also needs record.create there (the
      // same decision the commands and the worker make).
      manage_recurrence:
        rec('project.manage_recurrence', false) &&
        decideBrand(p, 'record.create', { ...project.brand, lifecycleState: 'active' }).allowed,
      save_template:
        project.ownLevel !== null &&
        decideBrand(p, 'templates.manage', {
          ...project.brand,
          lifecycleState: 'active',
        }).allowed,
    };
  }

  /** Readable ancestors only (an unavailable parent is omitted without a placeholder). */
  protected async readableAncestors(
    tx: WorkspaceTransaction,
    p: Principal,
    ancestorIds: readonly string[],
  ): Promise<Array<{ id: string; name: string }>> {
    if (!ancestorIds.length) return [];
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      includeArchived: true,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const rows = await tx.db
      .selectFrom('core.record as r')
      .innerJoin('work.project as w', (j) =>
        j.onRef('w.workspace_id', '=', 'r.workspace_id').onRef('w.id', '=', 'r.id'),
      )
      .select(['w.id', 'r.public_id', 'w.name'])
      .where('w.id', 'in', [...ancestorIds])
      .where(vis.where('r', { project: sql`w.id` }))
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ancestorIds.flatMap((id) => {
      const r = byId.get(id);
      return r ? [{ id: r.public_id, name: r.name }] : [];
    });
  }

  protected async projectView(tx: WorkspaceTransaction, p: Principal, project: LoadedProject) {
    const r = project.row;
    const owner =
      p.kind === 'member'
        ? await tx.db
            .selectFrom('tenancy.membership as m')
            .innerJoin('identity.account as a', 'a.id', 'm.account_id')
            .select(['m.public_id', 'm.display_name_override', 'a.display_name'])
            .where('m.id', '=', r.owner_membership_id)
            .executeTakeFirst()
        : undefined;
    const ancestors = await this.readableAncestors(tx, p, r.ancestor_ids);
    const series = r.recurrence_series_id
      ? await tx.db
          .selectFrom('planning.recurrence_series')
          .select('public_id')
          .where('id', '=', r.recurrence_series_id)
          .executeTakeFirst()
      : undefined;
    const status = this.statusView(r.status_id);
    return {
      id: project.publicId,
      type: 'project' as const,
      name: r.name,
      // Rich text version 1 (0D PL-23).
      description: r.description_rich ?? null,
      icon: r.icon,
      color: r.color,
      brand: project.brandMarker,
      parent:
        ancestors.length && ancestors.at(-1)!.id
          ? r.parent_project_id
            ? (ancestors.at(-1) ?? null)
            : null
          : null,
      ancestors,
      depth: r.depth,
      status,
      priority: r.priority,
      start_date: r.start_date,
      target_date: r.target_date,
      deadline_date: r.deadline_date,
      completed_at: r.completed_at ? r.completed_at.toISOString() : null,
      health: r.health ? { value: r.health, source: r.health_source } : null,
      budget:
        r.budget_amount !== null ? { amount: r.budget_amount, currency: r.budget_currency } : null,
      time_budget_minutes: r.time_budget_minutes,
      ai_budget_micros: r.ai_budget_micros,
      // OD-13: status-based until tasks exist (2B replaces the basis with readable leaf tasks).
      completion: { percent: status.category === 'done' ? 100 : 0, basis: 'status' as const },
      owner: owner
        ? { id: owner.public_id, name: owner.display_name_override ?? owner.display_name }
        : null,
      access_mode: r.access_mode,
      allow_record_shares: r.allow_record_shares,
      // Recurrence configuration is not part of a share (ADR-0013 P5).
      recurrence:
        series && r.occurrence_key && project.ownLevel !== null
          ? { series: series.public_id, occurrence: r.occurrence_key }
          : null,
      lifecycle_state: project.lifecycleState,
      your_level: project.level,
      capabilities: this.capabilities(p, project),
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
      version: r.version,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------------------

  /**
   * Projects the caller can read in the requested brands (or every readable brand), filtered by
   * the one visibility predicate before ordering, pagination, and totals (0C §4.5).
   */
  async listProjects(
    caller: Caller,
    workspacePublicId: unknown,
    query: { brands?: unknown; state?: unknown; parent?: unknown; limit?: unknown },
  ) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      const archived = query.state === 'archived';
      const vis = await compileVisibility(tx, p, {
        need: 'view',
        includeArchived: archived,
        arrayMax: this.c.settings.principalContextArrayMax,
      });
      const brandIds: string[] = [];
      if (typeof query.brands === 'string' && query.brands) {
        for (const b of query.brands.split(',').slice(0, 50)) {
          if (!isPublic(b, 'br')) throw new TenancyError('not_found');
          brandIds.push((await findBrand(tx, p, b)).id);
        }
      }
      let parentId: string | null | undefined;
      if (query.parent === 'root') parentId = null;
      else if (query.parent !== undefined)
        parentId = (await this.loadProject(tx, p, query.parent)).id;
      const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 200);
      let q = tx.db
        .selectFrom('core.record as r')
        .innerJoin('work.project as w', (j) =>
          j.onRef('w.workspace_id', '=', 'r.workspace_id').onRef('w.id', '=', 'r.id'),
        )
        .innerJoin('tenancy.brand as b', (j) =>
          j.onRef('b.workspace_id', '=', 'w.workspace_id').onRef('b.id', '=', 'w.brand_id'),
        )
        .innerJoin('core.record as br', (j) =>
          j.onRef('br.workspace_id', '=', 'b.workspace_id').onRef('br.id', '=', 'b.id'),
        )
        .where('r.record_type', '=', 'project')
        .where(vis.where('r', { project: sql`w.id` }))
        .where('r.lifecycle_state', '=', archived ? 'archived' : 'active');
      if (brandIds.length) q = q.where('w.brand_id', 'in', brandIds);
      if (parentId === null) q = q.where('w.parent_project_id', 'is', null);
      else if (parentId) q = q.where('w.parent_project_id', '=', parentId);
      const total = await q
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const rows = await q
        .select([
          'r.public_id',
          'w.id',
          'w.name',
          'w.status_id',
          'w.priority',
          'w.health',
          'w.target_date',
          'w.depth',
          'w.parent_project_id',
          'w.rank',
          'r.lifecycle_state',
          'br.public_id as brand_public_id',
          'b.name as brand_name',
          'b.short_name as brand_short_name',
          'b.color as brand_color',
          'b.icon as brand_icon',
          'b.lifecycle_state as brand_state',
        ])
        .orderBy('b.name')
        .orderBy('w.rank')
        .orderBy('w.id')
        .limit(limit)
        .execute();
      // Children counts and parent references cover readable projects only.
      const ids = rows.map((x) => x.id);
      const readableChildren = ids.length
        ? await tx.db
            .selectFrom('core.record as r')
            .innerJoin('work.project as w', (j) =>
              j.onRef('w.workspace_id', '=', 'r.workspace_id').onRef('w.id', '=', 'r.id'),
            )
            .select(['w.parent_project_id', (eb) => eb.fn.countAll<string>().as('n')])
            .where('w.parent_project_id', 'in', ids)
            .where('r.lifecycle_state', '=', archived ? 'archived' : 'active')
            .where(vis.where('r', { project: sql`w.id` }))
            .groupBy('w.parent_project_id')
            .execute()
        : [];
      const childCount = new Map(readableChildren.map((c) => [c.parent_project_id, Number(c.n)]));
      const readableIds = new Set(ids);
      const publicById = new Map(rows.map((x) => [x.id, x.public_id]));
      return {
        data: rows.map((x) => ({
          id: x.public_id,
          type: 'project' as const,
          name: x.name,
          status: this.statusView(x.status_id),
          priority: x.priority,
          health: x.health,
          target_date: toDate(x.target_date),
          depth: x.depth,
          parent:
            x.parent_project_id && readableIds.has(x.parent_project_id)
              ? publicById.get(x.parent_project_id)!
              : null,
          children: childCount.get(x.id) ?? 0,
          lifecycle_state: x.lifecycle_state,
          brand: brandMarker({
            public_id: x.brand_public_id,
            name: x.brand_name,
            short_name: x.brand_short_name,
            color: x.brand_color,
            icon: x.brand_icon,
            lifecycle_state: x.brand_state,
          }),
        })),
        // Authorized records only (IA-41); never a count of hidden projects.
        total: { value: Number(total.n), estimated: false, capped: Number(total.n) > limit },
      };
    });
  }

  async getProject(caller: Caller, workspacePublicId: unknown, projectPublicId: unknown) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      const project = await this.loadProject(tx, p, projectPublicId);
      return this.projectView(tx, p, project);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Create, edit, move
  // ---------------------------------------------------------------------------------------------

  protected async nextRank(
    tx: WorkspaceTransaction,
    table:
      'work.project' | 'work.phase' | 'work.milestone' | 'work.criteria_item' | 'work.scope_item',
    where: (q: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
    after: string | null,
  ): Promise<string> {
    const siblings: Array<{ id: string; rank: string }> = await where(
      tx.db.selectFrom(table).select(['id', 'rank']),
    )
      .orderBy('rank')
      .orderBy('id')
      .execute();
    let idx = after === null ? siblings.length - 1 : siblings.findIndex((s) => s.id === after);
    if (after !== null && idx < 0)
      throw invalid(issue('/after', 'invalid_reference', 'Choose an item from the list.'));
    if (after === null) idx = siblings.length - 1;
    const before = idx >= 0 ? siblings[idx]!.rank : null;
    const next = siblings[idx + 1]?.rank ?? null;
    const r = rankBetween(before, next);
    if (r !== null) return r;
    // Rebalance the sibling list evenly, then retry once.
    const ranks = evenRanks(siblings.length + 1);
    for (const [i, s] of siblings.entries())
      await tx.db.updateTable(table).set({ rank: ranks[i]! }).where('id', '=', s.id).execute();
    return rankBetween(ranks[idx] ?? null, ranks[idx + 1] ?? null) ?? ranks[siblings.length]!;
  }

  /** Creates the envelope, typed row, owner grant, audit, and outbox event for one project. */
  protected async insertProject(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    input: {
      brandId: string;
      parent: LoadedProject | null;
      fields: Record<string, unknown>;
      sourceKind?: 'ui' | 'template' | 'form';
      intakeSourceId?: string | null;
      recurrence?: { seriesId: string; occurrenceKey: string } | null;
    },
  ): Promise<{ id: string; publicId: string }> {
    const depth = input.parent ? input.parent.row.depth + 1 : 0;
    if (depth > this.ws.projectDepthMax)
      throw invalid(
        issue(
          '/parent',
          'depth_exceeded',
          `Projects can be nested at most ${this.ws.projectDepthMax} levels deep.`,
        ),
      );
    const id = newUuidV7();
    const publicId = newPublicId('prj');
    const cmd = this.cmd(caller, p, input.brandId);
    const source = input.sourceKind ?? 'ui';
    await tx.db
      .insertInto('core.record')
      .values({
        id,
        public_id: publicId,
        record_type: 'project',
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        source_kind: source,
        source_ref: null,
        created_by_actor_type: cmd.actor.type,
        created_by_actor_id: cmd.actor.id,
      })
      .execute();
    const statusKey = (input.fields.status as ProjectStatusKey | undefined) ?? 'planned';
    const rank = await this.nextRank(
      tx,
      'work.project',
      (q) =>
        input.parent
          ? q.where('parent_project_id', '=', input.parent.id)
          : q.where('parent_project_id', 'is', null).where('brand_id', '=', input.brandId),
      null,
    );
    const f = input.fields;
    await tx.db
      .insertInto('work.project')
      .values({
        id,
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        scope_key: input.brandId,
        parent_project_id: input.parent?.id ?? null,
        ancestor_ids: input.parent ? [...input.parent.row.ancestor_ids, input.parent.id] : [],
        depth,
        name: f.name as string,
        description_rich: f.description ? JSON.stringify(f.description) : null,
        icon: (f.icon as string | null | undefined) ?? null,
        color: (f.color as string | null | undefined) ?? null,
        status_id: STATUS_ID[statusKey],
        priority: (f.priority as never) ?? 'none',
        start_date: (f.start_date as string | null | undefined) ?? null,
        target_date: (f.target_date as string | null | undefined) ?? null,
        deadline_date: (f.deadline_date as string | null | undefined) ?? null,
        completed_at: statusKey === 'completed' ? new Date() : null,
        health: (f.health as never) ?? null,
        health_source: f.health ? 'manual' : null,
        owner_membership_id: p.membershipId,
        budget_amount: (f.budget_amount as string | null | undefined) ?? null,
        budget_currency: (f.budget_currency as string | null | undefined) ?? null,
        time_budget_minutes: (f.time_budget_minutes as number | null | undefined) ?? null,
        ai_budget_micros:
          f.ai_budget_micros === undefined || f.ai_budget_micros === null
            ? null
            : String(f.ai_budget_micros),
        rank,
        recurrence_series_id: input.recurrence?.seriesId ?? null,
        occurrence_key: input.recurrence?.occurrenceKey ?? null,
        intake_source_id: input.intakeSourceId ?? null,
        created_by_membership_id: p.membershipId,
      })
      .execute();
    // Ownership is responsibility; the explicit manage grant is the authority (0C AZ-21).
    await this.ensureManagerGrant(tx, id, p.membershipId, p.membershipId);
    await this.workAudit(
      tx,
      caller,
      p,
      'project.created',
      { recordId: id, type: 'project', publicId },
      [
        change.content('name', { hash: contentHash(f.name) }),
        change.plain('status', null, statusKey),
        change.plain('parent', null, input.parent?.publicId ?? null),
        change.plain('source', null, source),
        ...(input.intakeSourceId ? [change.plain('intake_source', null, true)] : []),
      ],
      input.brandId,
    );
    await this.workEvent(
      tx,
      caller,
      p,
      'work.project.created',
      { type: 'work.project', id, sequence: 0 },
      { parent_project_id: input.parent?.id ?? null, status_id: STATUS_ID[statusKey] },
      input.brandId,
    );
    return { id, publicId };
  }

  async createProject(caller: Caller, workspacePublicId: unknown, body: unknown, req: Mutation) {
    const input = parseProjectCreate(body);
    return this.mutate(
      caller,
      'project.create',
      workspacePublicId,
      req,
      async (tx, p) => {
        let parent: LoadedProject | null = null;
        let brandId: string;
        if (input.parent) {
          parent = await this.loadProject(tx, p, input.parent, { lock: true });
          this.requireProjectScope(p, 'record.create', parent);
          this.requireActive(parent);
          if (input.brand && input.brand !== parent.brand.publicId)
            throw invalid(
              issue(
                '/brand',
                'cross_brand_parent',
                'A sub-project belongs to the same brand as its parent.',
              ),
            );
          brandId = parent.brand.id;
        } else {
          const brand = await findBrand(tx, p, input.brand, { forUpdate: false });
          const facts = {
            id: brand.id,
            isSensitive: brand.is_sensitive,
            lifecycleState: brand.lifecycle_state,
          };
          const o = decideBrand(p, 'record.create', { ...facts, lifecycleState: 'active' });
          this.decision('record.create', o);
          if (!o.allowed) throw new TenancyError(o.code);
          if (brand.lifecycle_state !== 'active')
            throw new TenancyError('conflict', {
              issues: [issue('/brand', 'brand_archived', 'This brand is archived.')],
            });
          brandId = brand.id;
        }
        const intakeSourceId = input.intake_source
          ? await this.intakeSource(tx, p, input.intake_source)
          : null;
        const fields: Record<string, unknown> = { ...input.fields };
        let created: { id: string; publicId: string };
        if (input.template) {
          created = await this.instantiateTemplate(tx, caller, p, {
            templatePublicId: input.template,
            brandId,
            parent,
            overrides: fields,
          });
        } else {
          if (fields.status === 'completed') this.requireCompleteAllowed(p, brandId, parent);
          created = await this.insertProject(tx, caller, p, {
            brandId,
            parent,
            fields,
            intakeSourceId,
            sourceKind: intakeSourceId ? 'form' : 'ui',
          });
        }
        const project = await this.loadProject(tx, p, created.publicId);
        return {
          status: 201,
          ref: { id: created.publicId, type: 'project' },
          data: await this.projectView(tx, p, project),
        };
      },
      async (tx, p, ref) => this.projectView(tx, p, await this.loadProject(tx, p, ref.id)),
    );
  }

  /** Completion is a human decision needing `project.complete` (0C) on the new project's scope. */
  protected requireCompleteAllowed(p: Principal, brandId: string, parent: LoadedProject | null) {
    if (parent) {
      const o = decideRecord(p, 'project.complete', {
        brand: parent.brand,
        lifecycleState: 'active',
        shareLevel: null,
        projectChain: parent.chain,
      });
      this.decision('project.complete', o);
      if (!o.allowed) throw new TenancyError('forbidden');
    }
    void brandId;
  }

  /** PRJ-017: an optional intake source must be a readable intake form in this workspace. */
  protected async intakeSource(tx: WorkspaceTransaction, p: Principal, publicId: string) {
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const r = await tx.db
      .selectFrom('core.record as r')
      .select('r.id')
      .where('r.public_id', '=', publicId)
      .where('r.record_type', '=', 'intake_form')
      .where(vis.where('r'))
      .executeTakeFirst();
    // Unknown, foreign, and unreadable sources are one indistinguishable refusal.
    if (!r)
      throw invalid(
        issue('/intake_source', 'invalid_reference', "That intake source isn't available."),
      );
    return r.id;
  }

  async updateProject(
    caller: Caller,
    workspacePublicId: unknown,
    projectPublicId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const merge = parseMerge(body, PROJECT_FIELDS);
    return this.mutate(
      caller,
      'project.update',
      workspacePublicId,
      req,
      async (tx, p) => {
        const project = await this.loadProject(tx, p, projectPublicId, { lock: true });
        this.requireProjectAction(p, 'record.update', project);
        this.requireActive(project);
        const version = project.row.version;
        const expected = req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : merge.version;
        if (expected === undefined) throw new TenancyError('precondition_required');
        const r = project.row;
        const current: Record<string, unknown> = {
          name: r.name,
          description: r.description_rich ?? null,
          icon: r.icon,
          color: r.color,
          status: KEY_BY_STATUS_ID.get(r.status_id),
          priority: r.priority,
          start_date: r.start_date,
          target_date: r.target_date,
          deadline_date: r.deadline_date,
          health: r.health,
          budget_amount: r.budget_amount,
          budget_currency: r.budget_currency,
          time_budget_minutes: r.time_budget_minutes,
          ai_budget_micros: r.ai_budget_micros === null ? null : String(r.ai_budget_micros),
        };
        const next = applyFieldMerge(
          { ...merge, version: expected === version ? version : merge.version },
          current,
          version,
          (field, value, issues) => projectField(field, value, issues),
        );
        if (expected !== version && merge.version === undefined && !Object.keys(next).length)
          requireVersion(expected, version);
        if (!Object.keys(next).length)
          return {
            status: 200,
            ref: { id: project.publicId, type: 'project' },
            data: await this.projectView(tx, p, project),
          };
        const statusChanging = next.status !== undefined && next.status !== current.status;
        if (statusChanging && (next.status === 'completed' || current.status === 'completed'))
          this.requireProjectAction(p, 'project.complete', project, { shares: false });
        const merged = { ...current, ...next };
        if (
          merged.start_date &&
          merged.target_date &&
          (merged.target_date as string) < (merged.start_date as string)
        )
          throw invalid(
            issue(
              '/changes/target_date',
              'date_order',
              'The target date is before the start date.',
            ),
          );
        if ((merged.budget_amount === null) !== (merged.budget_currency === null))
          throw invalid(
            issue(
              '/changes/budget_currency',
              'budget_pair',
              'Set both the budget amount and its currency.',
            ),
          );
        const set: Record<string, unknown> = {
          updated_at: new Date(),
          updated_by_membership_id: p.membershipId,
          version: version + 1,
        };
        for (const [k, v] of Object.entries(next)) {
          if (k === 'status') {
            set.status_id = STATUS_ID[v as ProjectStatusKey];
            set.completed_at = v === 'completed' ? new Date() : null;
          } else if (k === 'health') {
            set.health = v;
            set.health_source = v === null ? null : 'manual';
          } else if (k === 'ai_budget_micros') set.ai_budget_micros = v === null ? null : String(v);
          else if (k === 'description')
            set.description_rich = v === null ? null : JSON.stringify(v);
          else set[k] = v;
        }
        await tx.db.updateTable('work.project').set(set).where('id', '=', project.id).execute();
        await tx.db
          .updateTable('core.record')
          .set({ version: sql`version + 1` })
          .where('id', '=', project.id)
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'project.updated',
          { recordId: project.id, type: 'project', publicId: project.publicId },
          auditDiff(current, next, PROJECT_CONTENT_FIELDS),
          project.brand.id,
        );
        await this.workEvent(
          tx,
          caller,
          p,
          'work.project.updated',
          { type: 'work.project', id: project.id, sequence: version + 1 },
          { changed_fields: Object.keys(next).sort().join(',') },
          project.brand.id,
        );
        if (statusChanging || next.health !== undefined)
          await this.workEvent(
            tx,
            caller,
            p,
            'work.project.status_changed',
            { type: 'work.project', id: project.id, sequence: version + 1 },
            {
              to_category: STATUS_BY_KEY.get(merged.status as ProjectStatusKey)!.category,
              health: (merged.health as string | null) ?? null,
            },
            project.brand.id,
          );
        const fresh = await this.loadProject(tx, p, project.publicId);
        return {
          status: 200,
          ref: { id: project.publicId, type: 'project' },
          data: await this.projectView(tx, p, fresh),
        };
      },
      async (tx, p, ref) => this.projectView(tx, p, await this.loadProject(tx, p, ref.id)),
    );
  }

  /**
   * Reorders or reparents a project subtree (0B ADR-05/21): tree-root advisory locks in ascending
   * order, then the moved row; same brand; no cycles; `PROJECT_DEPTH_MAX` over the whole subtree;
   * the subtree's ancestry updates in one statement (the deferred ancestry check holds at commit).
   */
  async moveProject(
    caller: Caller,
    workspacePublicId: unknown,
    projectPublicId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseMove(body);
    return this.mutate(
      caller,
      'project.move',
      workspacePublicId,
      req,
      async (tx, p) => {
        try {
          const first = await this.loadProject(tx, p, projectPublicId);
          const target = input.parent ? await this.loadProject(tx, p, input.parent) : null;
          const roots = [
            first.row.ancestor_ids[0] ?? first.id,
            target ? (target.row.ancestor_ids[0] ?? target.id) : null,
          ]
            .filter((x): x is string => x !== null)
            .sort();
          for (const root of [...new Set(roots)])
            await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'tree:' + root}, 0))`.execute(
              tx.db,
            );
          const project = await this.loadProject(tx, p, projectPublicId, { lock: true });
          const parent = input.parent
            ? await this.loadProject(tx, p, input.parent, { lock: true })
            : null;
          if (req.ifMatch !== undefined)
            requireVersion(parseIfMatch(req.ifMatch), project.row.version);
          this.requireProjectAction(p, 'record.move', project, { shares: false });
          this.requireActive(project);
          if (parent) {
            this.requireProjectScope(p, 'record.create', parent);
            if (parent.brand.id !== project.brand.id)
              throw invalid(
                issue(
                  '/parent',
                  'cross_brand_parent',
                  'A sub-project belongs to the same brand as its parent.',
                ),
              );
            if (parent.id === project.id || parent.row.ancestor_ids.includes(project.id))
              throw invalid(issue('/parent', 'cycle', "A project can't move inside itself."));
          }
          const restrictionChanges =
            project.chain.slice(1).some((n) => n.restricted) !==
            Boolean(parent?.chain.some((n) => n.restricted));
          if (restrictionChanges) this.requireProjectScope(p, 'access.restrict_scope', project);
          const newDepth = parent ? parent.row.depth + 1 : 0;
          const deepest = (
            await sql<{ d: number | null }>`WITH RECURSIVE ${subtree(project.id)}
              SELECT max(depth)::int AS d FROM sub`.execute(tx.db)
          ).rows[0]!;
          const height = Number(deepest.d ?? project.row.depth) - project.row.depth;
          if (newDepth + height > this.ws.projectDepthMax)
            throw invalid(
              issue(
                '/parent',
                'depth_exceeded',
                `Projects can be nested at most ${this.ws.projectDepthMax} levels deep.`,
              ),
            );
          const after = input.after ? await this.loadProject(tx, p, input.after) : null;
          if (after && after.row.parent_project_id !== (parent?.id ?? null))
            throw invalid(
              issue('/after', 'invalid_reference', 'Choose a project at the destination.'),
            );
          const rank = await this.nextRank(
            tx,
            'work.project',
            (q) =>
              (parent
                ? q.where('parent_project_id', '=', parent.id)
                : q.where('parent_project_id', 'is', null).where('brand_id', '=', project.brand.id)
              ).where('id', '<>', project.id),
            after?.id ?? null,
          );
          const prefix = parent ? [...parent.row.ancestor_ids, parent.id] : [];
          const oldDepth = project.row.depth;
          await sql`WITH RECURSIVE ${subtree(project.id)}
            UPDATE work.project w SET
              ancestor_ids = ${prefix}::uuid[] || w.ancestor_ids[${oldDepth + 1}:cardinality(w.ancestor_ids)],
              depth = w.depth - ${oldDepth} + ${newDepth}
            FROM sub WHERE w.id = sub.id`.execute(tx.db);
          await tx.db
            .updateTable('work.project')
            .set({
              parent_project_id: parent?.id ?? null,
              ancestor_ids: prefix,
              depth: newDepth,
              rank,
              updated_at: new Date(),
              updated_by_membership_id: p.membershipId,
              version: project.row.version + 1,
            })
            .where('id', '=', project.id)
            .execute();
          await tx.db
            .updateTable('core.record')
            .set({ version: sql`version + 1` })
            .where('id', '=', project.id)
            .execute();
          if (restrictionChanges) await bumpEpoch(tx, 'workspace', null);
          await this.workAudit(
            tx,
            caller,
            p,
            'project.moved',
            { recordId: project.id, type: 'project', publicId: project.publicId },
            [
              change.plain(
                'parent',
                project.row.parent_project_id
                  ? project.row.ancestor_ids.length
                    ? 'project'
                    : null
                  : null,
                parent?.publicId ?? null,
              ),
              change.plain('depth', oldDepth, newDepth),
            ],
            project.brand.id,
          );
          await this.workEvent(
            tx,
            caller,
            p,
            'work.project.moved',
            { type: 'work.project', id: project.id, sequence: project.row.version + 1 },
            { parent_project_id: parent?.id ?? null, depth: newDepth },
            project.brand.id,
          );
          this.d.metrics.count('work.hierarchy.moves', 1, { outcome: 'ok' });
          const fresh = await this.loadProject(tx, p, project.publicId);
          return {
            status: 200,
            ref: { id: project.publicId, type: 'project' },
            data: await this.projectView(tx, p, fresh),
          };
        } catch (err) {
          const e = pg(err);
          const outcome =
            err instanceof TenancyError ? err.code : e.code === '23514' ? 'invariant' : 'error';
          this.d.metrics.count('work.hierarchy.moves', 1, { outcome });
          if (e.code === '23514')
            throw new TenancyError('conflict', {
              issues: [
                issue(
                  '/parent',
                  'stale_ancestry',
                  'The project tree changed. Refresh and try again.',
                ),
              ],
            });
          throw err;
        }
      },
      async (tx, p, ref) => this.projectView(tx, p, await this.loadProject(tx, p, ref.id)),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Ownership and access mode
  // ---------------------------------------------------------------------------------------------

  async setOwner(
    caller: Caller,
    workspacePublicId: unknown,
    projectPublicId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const ownerRef =
      typeof body === 'object' && body !== null ? (body as { owner?: unknown }).owner : undefined;
    if (!isPublic(ownerRef, 'mem'))
      throw invalid(issue('/owner', 'invalid_reference', 'Choose a person.'));
    return this.mutate(
      caller,
      'project.owner',
      workspacePublicId,
      req,
      async (tx, p) => {
        const project = await this.loadProject(tx, p, projectPublicId, { lock: true });
        this.requireProjectScope(p, 'access.grant_scope', project);
        if (req.ifMatch !== undefined)
          requireVersion(parseIfMatch(req.ifMatch), project.row.version);
        const m = await this.memberByPublic(tx, ownerRef, '/owner');
        if (m.id !== project.row.owner_membership_id) {
          await this.ensureManagerGrant(tx, project.id, m.id, p.membershipId);
          await tx.db
            .updateTable('work.project')
            .set({
              owner_membership_id: m.id,
              updated_at: new Date(),
              updated_by_membership_id: p.membershipId,
              version: project.row.version + 1,
            })
            .where('id', '=', project.id)
            .execute();
          await bumpEpoch(tx, 'workspace', null);
          await this.workAudit(
            tx,
            caller,
            p,
            'project.owner_changed',
            { recordId: project.id, type: 'project', publicId: project.publicId },
            [change.plain('owner', null, m.public_id)],
            project.brand.id,
          );
          await this.workEvent(
            tx,
            caller,
            p,
            'work.project.owner_changed',
            { type: 'work.project', id: project.id, sequence: project.row.version + 1 },
            { owner_membership_id: m.id },
            project.brand.id,
          );
        }
        const fresh = await this.loadProject(tx, p, project.publicId);
        return {
          status: 200,
          ref: { id: project.publicId, type: 'project' },
          data: await this.projectView(tx, p, fresh),
        };
      },
      async (tx, p, ref) => this.projectView(tx, p, await this.loadProject(tx, p, ref.id)),
    );
  }

  /**
   * Restriction (0C AZ-21): restricting stops brand, workspace, and ancestor access for the project
   * and its descendants. The responsible owner and the acting manager keep explicit manage grants
   * in the same transaction; record shares stay off unless allowed.
   */
  async setAccess(
    caller: Caller,
    workspacePublicId: unknown,
    projectPublicId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseAccess(body);
    return this.mutate(
      caller,
      'project.access',
      workspacePublicId,
      req,
      async (tx, p) => {
        const project = await this.loadProject(tx, p, projectPublicId, { lock: true });
        this.requireProjectScope(p, 'access.restrict_scope', project);
        if (req.ifMatch !== undefined)
          requireVersion(parseIfMatch(req.ifMatch), project.row.version);
        const mode = input.access_mode ?? project.row.access_mode;
        const allow =
          input.allow_record_shares ??
          (mode === 'restricted' && project.row.access_mode !== 'restricted'
            ? false
            : project.row.allow_record_shares);
        if (mode === 'restricted') {
          await this.ensureManagerGrant(
            tx,
            project.id,
            project.row.owner_membership_id,
            p.membershipId,
          );
          if (p.kind === 'member')
            await this.ensureManagerGrant(tx, project.id, p.membershipId, p.membershipId);
        }
        if (mode !== project.row.access_mode || allow !== project.row.allow_record_shares) {
          await tx.db
            .updateTable('work.project')
            .set({
              access_mode: mode,
              allow_record_shares: allow,
              updated_at: new Date(),
              updated_by_membership_id: p.membershipId,
              version: project.row.version + 1,
            })
            .where('id', '=', project.id)
            .execute();
          await bumpEpoch(tx, 'workspace', null);
          await this.workAudit(
            tx,
            caller,
            p,
            'project.access_changed',
            { recordId: project.id, type: 'project', publicId: project.publicId },
            [
              change.plain('access_mode', project.row.access_mode, mode),
              change.plain('allow_record_shares', project.row.allow_record_shares, allow),
            ],
            project.brand.id,
          );
          await this.security(tx, caller, p, 'project.access_changed', {
            type: 'project',
            id: project.id,
          });
          await this.workEvent(
            tx,
            caller,
            p,
            'work.project.updated',
            { type: 'work.project', id: project.id, sequence: project.row.version + 1 },
            { changed_fields: 'access_mode,allow_record_shares' },
            project.brand.id,
          );
        }
        const fresh = await this.loadProject(tx, p, project.publicId);
        return {
          status: 200,
          ref: { id: project.publicId, type: 'project' },
          data: await this.projectView(tx, p, fresh),
        };
      },
      async (tx, p, ref) => this.projectView(tx, p, await this.loadProject(tx, p, ref.id)),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle (1F machinery; never cascades to child projects)
  // ---------------------------------------------------------------------------------------------

  async projectLifecycle(
    caller: Caller,
    workspacePublicId: unknown,
    projectPublicId: unknown,
    verb: 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge',
    req: Mutation,
  ) {
    return this.mutate(
      caller,
      `project.${verb}`,
      workspacePublicId,
      req,
      async (tx, p) => {
        const project = await this.loadLifecycleTarget(tx, p, projectPublicId, verb);
        if (req.ifMatch !== undefined)
          requireVersion(parseIfMatch(req.ifMatch), project.row.version);
        const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
        const facts = {
          id: project.id,
          brand: project.brand,
          lifecycleState: project.lifecycleState,
          chain: project.chain,
        };
        if (verb === 'archive') {
          const d = this.issueLifecycle(tx, p, 'record.archive', facts);
          await this.d.lifecycle.archive(tx, d, input, project.id);
        } else if (verb === 'unarchive') {
          const d = this.issueLifecycle(tx, p, 'record.restore', facts);
          await this.d.lifecycle.unarchive(tx, d, input, project.id);
        } else if (verb === 'trash') {
          const d = this.issueLifecycle(tx, p, 'record.trash', facts);
          await this.d.lifecycle.trash(tx, d, input, project.id);
        } else {
          const batch = await this.batchOf(tx, project.id);
          if (verb === 'restore') {
            const d = this.issueLifecycle(tx, p, 'record.restore', facts);
            await this.d.lifecycle.restore(tx, d, input, batch);
          } else {
            // Purge is blocked while a live child still references the parent (0B ADR-21).
            const children = await tx.db
              .selectFrom('work.project')
              .select((eb) => eb.fn.countAll<string>().as('n'))
              .where('parent_project_id', '=', project.id)
              .where('lifecycle_state', '<>', 'purged')
              .executeTakeFirstOrThrow();
            if (Number(children.n) > 0)
              throw new TenancyError('conflict', {
                issues: [
                  issue(
                    '/',
                    'children_remain',
                    'Move or delete its sub-projects before deleting this project permanently.',
                  ),
                ],
              });
            const d = this.issueLifecycle(tx, p, 'record.purge', facts);
            await this.d.lifecycle.requestPurge(tx, d, input, batch);
          }
        }
        await bumpEpoch(tx, 'workspace', null);
        const state = await tx.db
          .selectFrom('core.record')
          .select(['lifecycle_state', 'version'])
          .where('id', '=', project.id)
          .executeTakeFirstOrThrow();
        return {
          status: verb === 'purge' ? 202 : 200,
          ref: { id: project.publicId, type: 'project' },
          data: {
            id: project.publicId,
            type: 'project' as const,
            lifecycle_state: state.lifecycle_state,
          },
        };
      },
      async (tx, _p, ref) => {
        const r = await tx.db
          .selectFrom('core.record')
          .select(['public_id', 'lifecycle_state'])
          .where('public_id', '=', ref.id)
          .executeTakeFirstOrThrow();
        return { id: r.public_id, type: 'project' as const, lifecycle_state: r.lifecycle_state };
      },
    );
  }

  /** Trashed projects are readable for restore/purge only by people with live edit access. */
  protected async loadLifecycleTarget(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    verb: string,
  ): Promise<LoadedProject> {
    if (verb !== 'restore' && verb !== 'purge')
      return this.loadProject(tx, p, publicId, { lock: true });
    if (!isPublic(publicId, 'prj')) throw new TenancyError('not_found');
    const r = await tx.db
      .selectFrom('core.record')
      .select(['id', 'lifecycle_state'])
      .where('public_id', '=', publicId)
      .where('record_type', '=', 'project')
      .executeTakeFirst();
    if (!r || r.lifecycle_state !== 'trashed')
      return this.loadProject(tx, p, publicId, { lock: true });
    // Decide on the live record (temporarily as active facts); unreadable stays not_found.
    const brandRow = await tx.db
      .selectFrom('work.project as w')
      .innerJoin('tenancy.brand as b', 'b.id', 'w.brand_id')
      .innerJoin('core.record as br', 'br.id', 'b.id')
      .selectAll('w')
      .select([
        'br.public_id as brand_public',
        'b.name as brand_name',
        'b.short_name',
        'b.color as brand_color',
        'b.icon as brand_icon',
        'b.is_sensitive',
        'b.lifecycle_state as brand_state',
      ])
      .where('w.id', '=', r.id)
      .forUpdate('w')
      .executeTakeFirstOrThrow();
    const scope = (await projectChainOf(tx, r.id))!;
    const brand = {
      id: brandRow.brand_id,
      publicId: brandRow.brand_public,
      name: brandRow.brand_name,
      isSensitive: brandRow.is_sensitive,
      lifecycleState: brandRow.brand_state,
    };
    const lv = recordLevel(p, {
      brand,
      lifecycleState: 'active',
      shareLevel: null,
      projectChain: scope.chain,
    });
    if (lv === null || levelRank(lv) < levelRank('edit')) throw new TenancyError('not_found');
    return {
      id: r.id,
      publicId: publicId as string,
      brand,
      brandMarker: brandMarker({
        public_id: brandRow.brand_public,
        name: brandRow.brand_name,
        short_name: brandRow.short_name,
        color: brandRow.brand_color,
        icon: brandRow.brand_icon,
        lifecycle_state: brandRow.brand_state,
      }),
      chain: scope.chain,
      lifecycleState: 'trashed',
      level: lv,
      ownLevel: lv,
      row: { ...(brandRow as unknown as LoadedProject['row']), version: Number(brandRow.version) },
    };
  }

  protected async batchOf(tx: WorkspaceTransaction, recordId: string): Promise<string> {
    const r = await tx.db
      .selectFrom('core.record')
      .select('deletion_batch_id')
      .where('id', '=', recordId)
      .executeTakeFirstOrThrow();
    if (!r.deletion_batch_id)
      throw new TenancyError('conflict', {
        issues: [issue('/', 'not_in_trash', 'This project is not in the trash.')],
      });
    return r.deletion_batch_id;
  }

  /** Shared with structures: a fresh public id for a non-addressable child row. */
  protected childId(prefix: Extract<IdPrefix, 'cri' | 'sco' | 'pup' | 'rcs'>): string {
    return newPublicId(prefix);
  }

  /** Creates a project from a template version (implemented by the structures layer). */
  protected async instantiateTemplate(
    _tx: WorkspaceTransaction,
    _caller: Caller,
    _p: Principal,
    _input: {
      templatePublicId: string;
      brandId: string;
      parent: LoadedProject | null;
      overrides: Record<string, unknown>;
    },
  ): Promise<{ id: string; publicId: string }> {
    throw new TenancyError('not_found');
  }
}

export function contentHash(v: unknown): string {
  // Content-class audit values carry a hash only (never titles or descriptions).
  // RFC 8785 canonical form, so equal rich-text documents hash equally (0D §4.2 `base_hash`).
  return `sha256:${createHashHex(canonicalJson(v ?? null))}`;
}

import { createHash } from 'node:crypto';
function createHashHex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export { STATUS_ID, DATE_FIELDS, toDate };
