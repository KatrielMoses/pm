import { createHash, createHmac } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import type { TaskStatusKey } from '@pm/contracts/shell';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import {
  applyFieldMerge,
  auditDiff,
  brandMarker,
  bumpEpoch,
  compilePrincipal,
  compileVisibility,
  decideBrand,
  decideProject,
  decideRecord,
  findBrand,
  invalid,
  issue,
  levelRank,
  parseIfMatch,
  parseMerge,
  previewToken,
  projectChainOf,
  recordLevel,
  requireVersion,
  TenancyError,
  verifyPreviewToken,
  type BrandFacts,
  type Caller,
  type ExposureDiff,
  type Level,
  type Mutation,
  type Principal,
  type ProjectChain,
  type ShareLevel,
} from '@pm/tenancy';
import type { ActionKey } from '@pm/contracts';
import { recordAssignmentChange } from './collab/history.ts';
import { NIL_ID, toDate, type LoadedProject, type WorkDeps } from './service.ts';
import { WorkService } from './structures.ts';
import {
  parseAssignees,
  parseBrandMove,
  parseComplete,
  parseDuplicate,
  parseSubtreeOption,
  parseTaskCreate,
  parseTaskListQuery,
  parseTaskMove,
  TASK_CONTENT_FIELDS,
  TASK_FIELDS,
  taskField,
  type Deadline,
} from './task-validation.ts';
import { isPublic } from './validation.ts';
import type { StatusGate } from './workflow/transitions.ts';

/** The transition apply command's extra input (ADR-0015 W8). */
export interface TaskTransition {
  to: string;
  version: number;
  apply: StatusGate['apply'];
  overrideReason: string | null;
  confirmSubtasks: boolean;
}
import {
  firstOfCategory,
  initialStatus,
  offered,
  primeStatuses,
  resolveWorkflow,
  statusFromKey,
  statusRef,
  statusView,
  TASK_STATUS_ID as PLATFORM_TASK_STATUS_ID,
  TERMINAL,
  type StatusRef,
  type WorkflowRef,
} from './workflow/statuses.ts';

/** Fixed ids of the immutable platform task statuses (migration 0023; one source in statuses.ts). */
export const TASK_STATUS_ID: Record<TaskStatusKey, string> = PLATFORM_TASK_STATUS_ID;

export type TaskRow = {
  project_id: string | null;
  parent_task_id: string | null;
  ancestor_ids: string[];
  depth: number;
  title: string;
  description_rich: unknown;
  status_id: string;
  status_category: string;
  prior_status_id: string | null;
  priority: string;
  start_date: string | null;
  due_date: string | null;
  deadline_date: string | null;
  deadline_at: Date | null;
  deadline_tz: string | null;
  estimate_minutes: number | null;
  remaining_estimate_minutes: number | null;
  completed_at: Date | null;
  completed_by_membership_id: string | null;
  completion_override_reason: string | null;
  expected_deliverable_type: string | null;
  expected_deliverable_detail: string | null;
  requires_acceptance: boolean;
  rank: string;
  created_by_membership_id: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  origin_kind: string;
  origin_ref: Record<string, string | number>;
  recurrence_series_id: string | null;
  occurrence_key: string | null;
  last_meaningful_update_at: Date;
};

/** A task resolved through the one compiled level (brand or project chain, share, lifecycle). */
export interface LoadedTask {
  id: string;
  publicId: string;
  brand: BrandFacts & { publicId: string; name: string; timezone: string };
  brandMarker: ReturnType<typeof brandMarker>;
  chain: ProjectChain;
  lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
  level: Level;
  /** Ownership-derived level only (null: the caller reads it through a share alone). */
  ownLevel: Level | null;
  row: TaskRow;
}

/** The strict descendants of one task as a recursive CTE named `sub` (id, depth). */
export const taskSubtree = (id: string) => sql`sub AS (
    SELECT id, depth FROM work.task WHERE parent_task_id = ${id}
    UNION ALL
    SELECT c.id, c.depth FROM work.task c JOIN sub ON c.parent_task_id = sub.id
  )`;

const pgErr = (err: unknown) =>
  typeof err === 'object' && err !== null ? (err as { code?: string; constraint?: string }) : {};

const deadlineOf = (r: Pick<TaskRow, 'deadline_date' | 'deadline_at' | 'deadline_tz'>): Deadline =>
  r.deadline_date
    ? { date: r.deadline_date }
    : r.deadline_at
      ? { at: new Date(r.deadline_at).toISOString(), tz: r.deadline_tz! }
      : null;

/** Today's date in a brand's time zone (brand-level surfaces evaluate dates there, 0A §3). */
export const todayIn = (tz: string, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

/**
 * Phase 2B tasks, part one (0B ADR-22, 0C AZ-22): resolution, views, lists, creation, field edits,
 * completion and reopening, moves (same brand and cross-brand), lifecycle, duplication, and
 * assignment. Extends the 2A service chain: one compiler, one transaction per command with
 * idempotency, audit, and outbox events.
 */
export class TaskCoreService extends WorkService {
  readonly #moveKey: Buffer;

  constructor(deps: WorkDeps) {
    super(deps);
    this.#moveKey = createHmac('sha256', deps.signingKey)
      .update('preview:work.task_move_brand')
      .digest();
  }

  // ---------------------------------------------------------------------------------------------
  // Resolution and authorization
  // ---------------------------------------------------------------------------------------------

  protected async brandFactsOf(tx: WorkspaceTransaction, brandId: string) {
    const b = await tx.db
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
        'b.timezone',
      ])
      .where('b.id', '=', brandId)
      .executeTakeFirstOrThrow();
    return {
      facts: {
        id: b.id,
        publicId: b.public_id,
        name: b.name,
        isSensitive: b.is_sensitive,
        lifecycleState: b.lifecycle_state,
        timezone: b.timezone,
      },
      marker: brandMarker({ ...b }),
    };
  }

  protected async chainOfProject(tx: WorkspaceTransaction, projectId: string | null) {
    // Projectless tasks run the same chain statement (on an identifier no row has), so project
    // membership is not visible through statement shape (ADR-0015 W20).
    const chain = (await projectChainOf(tx, projectId ?? NIL_ID))?.chain ?? [];
    return projectId ? chain : ([] as ProjectChain);
  }

  /**
   * One task through the compiled level. `allowTrashed` (lifecycle restore/purge only) decides on
   * the live record's authority as for projects; anything unreadable is `not_found`.
   */
  protected async loadTask(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    opts: { lock?: boolean; allowTrashed?: boolean } = {},
  ): Promise<LoadedTask> {
    if (!isPublic(publicId, 'tsk')) throw new TenancyError('not_found');
    let q = tx.db
      .selectFrom('core.record as r')
      .innerJoin('work.task as t', (j) =>
        j.onRef('t.workspace_id', '=', 'r.workspace_id').onRef('t.id', '=', 'r.id'),
      )
      .selectAll('t')
      .select(['r.public_id'])
      .where('r.public_id', '=', publicId)
      .where('r.record_type', '=', 'task');
    if (opts.lock) q = q.forUpdate('t');
    const row = await q.executeTakeFirst();
    if (!row) {
      // Constant shape (ADR-0015 W20): the same brand, chain, and share statements as an existing
      // task the caller cannot read; existence is not visible in the statements a request runs.
      await this.brandFactsOf(tx, NIL_ID).catch(() => undefined);
      await this.chainOfProject(tx, null);
      await this.shareLevelOf(tx, p, NIL_ID);
      throw new TenancyError('not_found');
    }
    const { facts: brand, marker } = await this.brandFactsOf(tx, row.brand_id);
    const chain = await this.chainOfProject(tx, row.project_id);
    const trashed = row.lifecycle_state === 'trashed';
    // The share lookup always runs (trashed or not) so every branch has the same statements.
    const share = await this.shareLevelOf(tx, p, row.id);
    if (trashed && !opts.allowTrashed) throw new TenancyError('not_found');
    const lifecycleState = trashed ? 'active' : row.lifecycle_state;
    const shareLevel = trashed ? null : share;
    const level = recordLevel(p, { brand, lifecycleState, projectChain: chain, shareLevel });
    if (level === null) throw new TenancyError('not_found');
    const ownLevel = recordLevel(p, {
      brand,
      lifecycleState,
      projectChain: chain,
      shareLevel: null,
    });
    if (trashed && (ownLevel === null || levelRank(ownLevel) < levelRank('edit')))
      throw new TenancyError('not_found');
    // Statuses are primed only for readable tasks (Phase 2 integration): a custom-workflow status
    // on an unreadable task must not add a statement an unknown identifier lacks.
    await primeStatuses(tx, [row.status_id, row.prior_status_id]);
    return {
      id: row.id,
      publicId: row.public_id,
      brand,
      brandMarker: marker,
      chain,
      lifecycleState: row.lifecycle_state,
      level,
      ownLevel,
      row: {
        ...row,
        start_date: toDate(row.start_date),
        due_date: toDate(row.due_date),
        deadline_date: toDate(row.deadline_date),
        deadline_at: row.deadline_at ? new Date(row.deadline_at) : null,
        completed_at: row.completed_at ? new Date(row.completed_at) : null,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
        last_meaningful_update_at: new Date(row.last_meaningful_update_at),
        version: Number(row.version),
      } as TaskRow,
    };
  }

  #shareForTask(t: LoadedTask): ShareLevel | null {
    if (t.ownLevel !== null && levelRank(t.ownLevel) >= levelRank(t.level)) return null;
    return t.level === 'view' ? 'read' : t.level === 'manage' ? 'edit' : t.level;
  }

  /**
   * A record decision on a task. `shares: false` excludes share authority: for content outside the
   * share (subtasks, relationships, history, project context) a share-only reader gets `not_found`;
   * for actions on the shared task itself it gets `forbidden` (`excluded: 'forbidden'`).
   */
  protected requireTaskAction(
    p: Principal,
    action: ActionKey,
    t: LoadedTask,
    opts: {
      shares?: boolean;
      excluded?: 'not_found' | 'forbidden';
      lifecycleState?: LoadedTask['lifecycleState'];
    } = {},
  ): void {
    if (opts.shares === false && t.ownLevel === null)
      throw new TenancyError(opts.excluded ?? 'not_found');
    const o = decideRecord(p, action, {
      brand: t.brand,
      lifecycleState: opts.lifecycleState ?? t.lifecycleState,
      shareLevel: opts.shares === false ? null : this.#shareForTask(t),
      projectChain: t.chain,
    });
    this.decision(action, o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  protected requireTaskActive(t: LoadedTask): void {
    if (t.lifecycleState !== 'active')
      throw new TenancyError('conflict', {
        issues: [issue('/', 'task_archived', 'This task is archived. Restore it to make changes.')],
      });
  }

  /** Content edits on the task's own facts (shares at edit level may make them). */
  protected async editableTask(tx: WorkspaceTransaction, p: Principal, tsk: unknown) {
    const t = await this.loadTask(tx, p, tsk, { lock: true });
    this.requireTaskAction(p, 'record.update', t);
    this.requireTaskActive(t);
    return t;
  }

  /** Edits to context a share excludes (subtasks, labels, links, relationships, assignees). */
  protected async ownedTask(
    tx: WorkspaceTransaction,
    p: Principal,
    tsk: unknown,
    action: ActionKey = 'record.update',
  ) {
    const t = await this.loadTask(tx, p, tsk, { lock: true });
    this.requireTaskAction(p, action, t, { shares: false });
    this.requireTaskActive(t);
    return t;
  }

  protected async taskVisibility(tx: WorkspaceTransaction, p: Principal, includeArchived = true) {
    return compileVisibility(tx, p, {
      need: 'view',
      includeArchived,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
  }

  protected async bumpTask(tx: WorkspaceTransaction, t: LoadedTask, p: Principal) {
    await tx.db
      .updateTable('work.task')
      .set({
        updated_at: new Date(),
        updated_by_membership_id: p.membershipId,
        version: t.row.version + 1,
      })
      .where('id', '=', t.id)
      .execute();
    await tx.db
      .updateTable('core.record')
      .set({ version: sql`version + 1` })
      .where('id', '=', t.id)
      .execute();
  }

  protected taskAudit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    t: { id: string; publicId: string; brand: { id: string } },
    changes: ReturnType<typeof change.plain>[],
  ) {
    return this.workAudit(
      tx,
      caller,
      p,
      action,
      { recordId: t.id, type: 'task', publicId: t.publicId },
      changes,
      t.brand.id,
    );
  }

  protected taskStatusView(statusId: string, tx: WorkspaceTransaction) {
    return statusView(statusRef(tx, statusId));
  }

  /** The workflow that applies to a task in this container (project → brand → workspace). */
  protected taskWorkflow(tx: WorkspaceTransaction, brandId: string, projectId: string | null) {
    return resolveWorkflow(tx, 'task', { workspaceId: tx.workspaceId, brandId, projectId });
  }

  /** Runs the one transition evaluator for a task status change (ADR-0015 W5–W8). */
  protected taskGate(
    tx: WorkspaceTransaction,
    caller: Caller,
    req: Mutation,
    p: Principal,
    t: LoadedTask,
    g: {
      wf: WorkflowRef | null;
      from: StatusRef;
      to: StatusRef;
      intent: StatusGate['intent'];
      merged: Record<string, unknown>;
    },
    transition?: TaskTransition,
  ) {
    return this.gateStatusChange(tx, p, {
      kind: 'task',
      record: {
        id: t.id,
        publicId: t.publicId,
        version: t.row.version,
        brandId: t.brand.id,
        projectId: t.row.project_id,
      },
      facts: {
        brand: t.brand,
        lifecycleState: t.lifecycleState,
        shareLevel: null,
        projectChain: t.chain,
      },
      ...g,
      intent: transition ? 'apply' : g.intent,
      apply: transition?.apply ?? null,
      overrideReason: transition?.overrideReason ?? null,
      stepUp: () =>
        this.stepUp(tx, caller, p, req, 'workflow.transition', { type: 'task', id: t.publicId }),
      caller,
    });
  }

  /** Capability flags for one task: the same decisions the commands make (booleans only). */
  protected taskCapabilities(p: Principal, t: LoadedTask) {
    const facts = (shares: boolean, state: LoadedTask['lifecycleState'] = t.lifecycleState) => ({
      brand: t.brand,
      lifecycleState: state,
      shareLevel: shares ? this.#shareForTask(t) : null,
      projectChain: t.chain,
    });
    const rec = (a: ActionKey, shares = true) => decideRecord(p, a, facts(shares)).allowed;
    const own = t.ownLevel !== null;
    const active = t.lifecycleState === 'active';
    const life = (a: ActionKey) => own && decideRecord(p, a, facts(false, 'active')).allowed;
    return {
      edit: active && rec('record.update'),
      edit_context: active && own && rec('record.update', false),
      comment: rec('record.comment'),
      complete: active && own && p.kind === 'member' && rec('task.complete', false),
      override_completion:
        active && own && p.kind === 'member' && rec('task.override_completion', false),
      move: active && own && rec('record.move', false),
      move_brand:
        active &&
        own &&
        decideBrand(p, 'record.move_brand', { ...t.brand, lifecycleState: 'active' }).allowed,
      relate: active && own && rec('record.relate', false),
      share: active && own && rec('record.share', false),
      archive: active && life('record.archive'),
      restore: t.lifecycleState === 'archived' && life('record.restore'),
      trash: life('record.trash'),
      create_subtask: active && own && rec('record.create', false),
      history: own,
      // 2D (AZ-24): recurring schedules and task templates.
      manage_recurrence: active && own && rec('task.manage_recurrence', false),
      save_template:
        own && decideBrand(p, 'templates.manage', { ...t.brand, lifecycleState: 'active' }).allowed,
      // 3D: log own time on this task (time.log_own; guests with a comment share may).
      log_time: active && rec('time.log_own'),
    };
  }

  protected async readableAncestorsOfTask(
    tx: WorkspaceTransaction,
    p: Principal,
    ancestorIds: readonly string[],
  ): Promise<Array<{ id: string; title: string; internalId: string }>> {
    if (!ancestorIds.length) return [];
    const vis = await this.taskVisibility(tx, p, true);
    const rows = await tx.db
      .selectFrom('core.record as r')
      .innerJoin('work.task as t', (j) =>
        j.onRef('t.workspace_id', '=', 'r.workspace_id').onRef('t.id', '=', 'r.id'),
      )
      .select(['t.id', 'r.public_id', 't.title'])
      .where('t.id', 'in', [...ancestorIds])
      .where(vis.where('r', { project: sql`t.project_id` }))
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    // An unavailable ancestor is omitted without a placeholder (0B ADR-22).
    return ancestorIds.flatMap((id) => {
      const r = byId.get(id);
      return r ? [{ id: r.public_id, title: r.title, internalId: r.id }] : [];
    });
  }

  /**
   * The task representation. A share-only reader (AZ-22) gets the task's own fields and its brand
   * marker; project, ancestors, assignees, labels beyond names, and progress are omitted.
   */
  protected async taskView(tx: WorkspaceTransaction, p: Principal, t: LoadedTask) {
    const r = t.row;
    const own = t.ownLevel !== null;
    const project =
      own && r.project_id
        ? await tx.db
            .selectFrom('core.record as cr')
            .innerJoin('work.project as w', 'w.id', 'cr.id')
            .select(['cr.public_id', 'w.name'])
            .where('w.id', '=', r.project_id)
            .executeTakeFirst()
        : undefined;
    const readableAncestors = own ? await this.readableAncestorsOfTask(tx, p, r.ancestor_ids) : [];
    const ancestors = readableAncestors.map((a) => ({ id: a.id, title: a.title }));
    const parentAncestor = r.parent_task_id
      ? readableAncestors.find((a) => a.internalId === r.parent_task_id)
      : undefined;
    const assignees =
      own && p.kind === 'member'
        ? await tx.db
            .selectFrom('work.task_assignee as a')
            .innerJoin('tenancy.membership as m', 'm.id', 'a.membership_id')
            .innerJoin('identity.account as acc', 'acc.id', 'm.account_id')
            .select([
              'm.public_id',
              'm.display_name_override',
              'acc.display_name',
              'a.is_primary',
              'm.state',
            ])
            .where('a.task_id', '=', t.id)
            .orderBy('a.is_primary', 'desc')
            .orderBy('a.rank')
            .execute()
        : [];
    const labels = await tx.db
      .selectFrom('work.task_label as tl')
      .innerJoin('work.label as l', 'l.id', 'tl.label_id')
      .select(['l.public_id', 'l.name', 'l.color', 'l.state'])
      .where('tl.task_id', '=', t.id)
      .orderBy('l.rank')
      .orderBy('l.id')
      .execute();
    let progress: { done: number; total: number } | null = null;
    if (own) {
      const vis = await this.taskVisibility(tx, p, false);
      const c = await tx.db
        .selectFrom('work.task as c')
        .innerJoin('core.record as cr', (j) =>
          j.onRef('cr.workspace_id', '=', 'c.workspace_id').onRef('cr.id', '=', 'c.id'),
        )
        .select([
          sql<string>`count(*) FILTER (WHERE c.status_category <> 'cancelled')`.as('total'),
          sql<string>`count(*) FILTER (WHERE c.status_category = 'done')`.as('done'),
        ])
        .where('c.parent_task_id', '=', t.id)
        .where(vis.where('cr', { project: sql`c.project_id` }))
        .executeTakeFirstOrThrow();
      progress = { done: Number(c.done), total: Number(c.total) };
    }
    const status = this.taskStatusView(r.status_id, tx);
    return {
      id: t.publicId,
      type: 'task' as const,
      title: r.title,
      description: r.description_rich ?? null,
      brand: t.brandMarker,
      project: project ? { id: project.public_id, name: project.name } : null,
      // A hidden parent is omitted without a placeholder (0B ADR-22).
      parent: parentAncestor ? { id: parentAncestor.id, title: parentAncestor.title } : null,
      ancestors,
      depth: own ? r.depth : 0,
      status,
      priority: r.priority,
      start_date: r.start_date,
      due_date: r.due_date,
      deadline: deadlineOf(r),
      estimate_minutes: r.estimate_minutes,
      remaining_estimate_minutes: r.remaining_estimate_minutes,
      completed_at: r.completed_at ? r.completed_at.toISOString() : null,
      completion_override:
        own && r.completion_override_reason ? { reason: r.completion_override_reason } : null,
      expected_deliverable: r.expected_deliverable_type
        ? {
            type: r.expected_deliverable_type,
            detail: r.expected_deliverable_detail,
            requires_acceptance: r.requires_acceptance,
          }
        : null,
      requires_acceptance: r.requires_acceptance,
      assignees: assignees
        .filter((a) => a.state === 'active')
        .map((a) => ({
          id: a.public_id,
          name: a.display_name_override ?? a.display_name,
          primary: a.is_primary,
        })),
      // Share-only readers see displayed names and colours only (AZ-22).
      labels: labels
        .filter((l) => own || l.state === 'active')
        .map((l) =>
          own
            ? { id: l.public_id, name: l.name, color: l.color, archived: l.state === 'archived' }
            : { name: l.name, color: l.color },
        ),
      progress,
      // Scheduled time is a planning work block (3C); tasks store no schedule fields (OD-01).
      scheduled: { available: false as const },
      // Origin (ADR-0016 D12): the closed kind for every reader; safe identifiers for own readers.
      source: own ? { kind: r.origin_kind, ...r.origin_ref } : { kind: r.origin_kind },
      last_meaningful_update_at: own ? r.last_meaningful_update_at.toISOString() : null,
      lifecycle_state: t.lifecycleState,
      your_level: t.level,
      shared_only: !own,
      capabilities: this.taskCapabilities(p, t),
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
      version: r.version,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  async getTask(caller: Caller, ws: unknown, tsk: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) =>
      this.taskView(tx, p, await this.loadTask(tx, p, tsk)),
    );
  }

  /**
   * Keyset pages of readable tasks (rank, id) through the one predicate before pagination and the
   * total (authorized records only, OD-07). Cursors are bound to the list they came from.
   */
  async listTasks(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    if (
      caller.delegation &&
      !caller.delegation.scopes.some(
        (s) => s === 'records:read' || s === 'records:write' || s === 'views:read',
      )
    )
      throw new TenancyError('forbidden');
    const q = parseTaskListQuery(query, this.ws);
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const vis = await this.taskVisibility(tx, p, q.state === 'archived');
      let projectId: string | null = null;
      if (q.project) {
        const project = await this.loadProject(tx, p, q.project);
        if (project.ownLevel === null) throw new TenancyError('not_found');
        projectId = project.id;
      }
      let parentId: string | null | 'root' = null;
      if (q.parent === 'root') parentId = 'root';
      else if (q.parent) {
        const parent = await this.loadTask(tx, p, q.parent);
        if (parent.ownLevel === null) throw new TenancyError('not_found');
        parentId = parent.id;
      }
      const brandIds: string[] = [];
      for (const b of q.brands) brandIds.push((await findBrand(tx, p, b)).id);
      const scopeKey = createHash('sha256')
        .update(JSON.stringify([projectId, parentId, q.projectless, brandIds, q.state]))
        .digest('base64url')
        .slice(0, 16);
      let after: { r: string; i: string } | null = null;
      if (q.cursor) {
        try {
          const c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as Record<
            string,
            unknown
          >;
          if (
            c.k !== scopeKey ||
            typeof c.r !== 'string' ||
            !/^[0-9A-Za-z]{1,64}$/.test(c.r) ||
            typeof c.i !== 'string' ||
            !/^[0-9a-f-]{36}$/.test(c.i)
          )
            throw new Error('cursor');
          after = { r: c.r, i: c.i };
        } catch {
          throw new TenancyError('cursor_invalid');
        }
      }
      const base = () => {
        let b = tx.db
          .selectFrom('core.record as r')
          .innerJoin('work.task as t', (j) =>
            j.onRef('t.workspace_id', '=', 'r.workspace_id').onRef('t.id', '=', 'r.id'),
          )
          .where('r.record_type', '=', 'task')
          .where('r.lifecycle_state', '=', q.state)
          .where(vis.where('r', { project: sql`t.project_id` }));
        if (projectId) b = b.where('t.project_id', '=', projectId);
        if (q.projectless) b = b.where('t.project_id', 'is', null);
        if (parentId === 'root') b = b.where('t.parent_task_id', 'is', null);
        else if (parentId) b = b.where('t.parent_task_id', '=', parentId);
        if (brandIds.length) b = b.where('t.brand_id', 'in', brandIds);
        return b;
      };
      const total = await base()
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      let rowsQ = base()
        .innerJoin('tenancy.brand as b', 'b.id', 't.brand_id')
        .innerJoin('core.record as br', 'br.id', 'b.id')
        .select([
          't.id',
          'r.public_id',
          't.title',
          't.status_id',
          't.priority',
          't.start_date',
          't.due_date',
          't.deadline_date',
          't.deadline_at',
          't.deadline_tz',
          't.estimate_minutes',
          't.remaining_estimate_minutes',
          't.parent_task_id',
          't.project_id',
          't.depth',
          't.rank',
          't.version',
          'r.lifecycle_state',
          'br.public_id as brand_public_id',
          'b.name as brand_name',
          'b.short_name as brand_short_name',
          'b.color as brand_color',
          'b.icon as brand_icon',
          'b.lifecycle_state as brand_state',
        ]);
      if (after)
        rowsQ = rowsQ.where(
          sql<boolean>`(t.rank COLLATE "C", t.id) > (${after.r} COLLATE "C", ${after.i}::uuid)`,
        );
      const rows = await rowsQ
        .orderBy(sql`t.rank COLLATE "C"`)
        .orderBy('t.id')
        .limit(q.limit + 1)
        .execute();
      const page = rows.slice(0, q.limit);
      const ids = page.map((r) => r.id);
      // Responsibility facts: assignee names for members; readable child counts only.
      const assignees =
        ids.length && p.kind === 'member'
          ? await tx.db
              .selectFrom('work.task_assignee as a')
              .innerJoin('tenancy.membership as m', 'm.id', 'a.membership_id')
              .innerJoin('identity.account as acc', 'acc.id', 'm.account_id')
              .select([
                'a.task_id',
                'm.public_id',
                'm.display_name_override',
                'acc.display_name',
                'a.is_primary',
              ])
              .where('a.task_id', 'in', ids)
              .where('m.state', '=', 'active')
              .orderBy('a.is_primary', 'desc')
              .orderBy('a.rank')
              .execute()
          : [];
      const children = ids.length
        ? await tx.db
            .selectFrom('work.task as c')
            .innerJoin('core.record as cr', (j) =>
              j.onRef('cr.workspace_id', '=', 'c.workspace_id').onRef('cr.id', '=', 'c.id'),
            )
            .select(['c.parent_task_id', (eb) => eb.fn.countAll<string>().as('n')])
            .where('c.parent_task_id', 'in', ids)
            .where('cr.lifecycle_state', '=', q.state)
            .where(vis.where('cr', { project: sql`c.project_id` }))
            .groupBy('c.parent_task_id')
            .execute()
        : [];
      const childCount = new Map(children.map((c) => [c.parent_task_id, Number(c.n)]));
      const last = page.at(-1);
      await primeStatuses(
        tx,
        page.map((x) => x.status_id),
      );
      return {
        data: page.map((x) => ({
          id: x.public_id,
          type: 'task' as const,
          title: x.title,
          status: this.taskStatusView(x.status_id, tx),
          priority: x.priority,
          start_date: toDate(x.start_date),
          due_date: toDate(x.due_date),
          deadline: deadlineOf({
            deadline_date: toDate(x.deadline_date),
            deadline_at: x.deadline_at ? new Date(x.deadline_at) : null,
            deadline_tz: x.deadline_tz,
          }),
          estimate_minutes: x.estimate_minutes,
          remaining_estimate_minutes: x.remaining_estimate_minutes,
          depth: x.depth,
          children: childCount.get(x.id) ?? 0,
          version: Number(x.version),
          assignees: assignees
            .filter((a) => a.task_id === x.id)
            .map((a) => ({
              id: a.public_id,
              name: a.display_name_override ?? a.display_name,
              primary: a.is_primary,
            })),
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
        page: {
          has_more: rows.length > q.limit,
          ...(rows.length > q.limit && last
            ? {
                next_cursor: Buffer.from(
                  JSON.stringify({ k: scopeKey, r: last.rank, i: last.id }),
                ).toString('base64url'),
              }
            : {}),
        },
        total: { value: Number(total.n), estimated: false },
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------------------------

  /** Where a new or moved task lives: brand, project, parent, and the depth it would take. */
  protected async resolveContainer(
    tx: WorkspaceTransaction,
    p: Principal,
    input: { brand?: string | null; project?: string | null; parent?: string | null },
    selfId: string | null,
  ): Promise<{
    brand: LoadedTask['brand'];
    marker: LoadedTask['brandMarker'];
    project: LoadedProject | null;
    parent: LoadedTask | null;
    chain: ProjectChain;
  }> {
    let parent: LoadedTask | null = null;
    let project: LoadedProject | null = null;
    if (input.parent) {
      parent = await this.loadTask(tx, p, input.parent, { lock: true });
      if (parent.ownLevel === null) throw new TenancyError('not_found');
      this.requireTaskActive(parent);
      if (selfId && (parent.id === selfId || parent.row.ancestor_ids.includes(selfId)))
        throw invalid(issue('/parent', 'cycle', "A task can't be inside itself."));
    }
    if (input.project) {
      project = await this.loadProject(tx, p, input.project, { lock: true });
      if (project.ownLevel === null) throw new TenancyError('not_found');
      this.requireActive(project);
    }
    if (parent && input.project !== undefined && (project?.id ?? null) !== parent.row.project_id)
      throw invalid(
        issue(
          '/parent',
          'parent_project_mismatch',
          'A subtask belongs to the same project as its parent.',
        ),
      );
    if (parent && input.project === undefined && parent.row.project_id) {
      project = await this.loadProject(tx, p, (await this.publicOf(tx, parent.row.project_id))!);
    }
    let brandId: string;
    if (parent) brandId = parent.brand.id;
    else if (project) brandId = project.brand.id;
    else {
      if (!input.brand)
        throw invalid(issue('/brand', 'brand_required', 'Choose which brand owns this task'));
      brandId = (await findBrand(tx, p, input.brand)).id;
    }
    if (input.brand && input.brand !== (await this.publicOf(tx, brandId)))
      throw invalid(
        issue(
          '/brand',
          'cross_brand_container',
          'This task belongs to the brand of its project or parent.',
        ),
      );
    const { facts, marker } = await this.brandFactsOf(tx, brandId);
    if (facts.lifecycleState !== 'active')
      throw new TenancyError('conflict', {
        issues: [issue('/brand', 'brand_archived', 'This brand is archived.')],
      });
    const chain = project ? project.chain : [];
    return { brand: facts, marker, project, parent, chain };
  }

  protected async publicOf(tx: WorkspaceTransaction, id: string): Promise<string | null> {
    const r = await tx.db
      .selectFrom('core.record')
      .select('public_id')
      .where('id', '=', id)
      .executeTakeFirst();
    return r?.public_id ?? null;
  }

  /** `record.create` in the container: the project chain, or the brand for projectless tasks. */
  protected requireCreateIn(
    p: Principal,
    c: { brand: BrandFacts; project: LoadedProject | null; chain: ProjectChain },
  ) {
    const o = c.project
      ? decideProject(p, 'record.create', {
          brand: c.project.brand,
          lifecycleState: 'active',
          chain: c.chain,
        })
      : decideBrand(p, 'record.create', { ...c.brand, lifecycleState: 'active' });
    this.decision('record.create', o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  protected siblingScope(c: {
    brand: { id: string };
    project: { id: string } | null;
    parent: { id: string } | null;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (q: any) =>
      c.parent
        ? q.where('parent_task_id', '=', c.parent.id)
        : c.project
          ? q.where('project_id', '=', c.project.id).where('parent_task_id', 'is', null)
          : q
              .where('brand_id', '=', c.brand.id)
              .where('project_id', 'is', null)
              .where('parent_task_id', 'is', null);
  }

  protected taskColumns(fields: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'description') out.description_rich = v === null ? null : JSON.stringify(v);
      // The status id is resolved through the applicable workflow by the caller.
      else if (k === 'status') continue;
      else if (k === 'deadline') {
        const d = v as Deadline;
        out.deadline_date = d && 'date' in d ? d.date : null;
        out.deadline_at = d && 'at' in d ? d.at : null;
        out.deadline_tz = d && 'at' in d ? d.tz : null;
      } else out[k] = v;
    }
    return out;
  }

  protected checkDates(merged: Record<string, unknown>) {
    if (
      merged.start_date &&
      merged.due_date &&
      (merged.due_date as string) < (merged.start_date as string)
    )
      throw invalid(
        issue('/changes/due_date', 'date_order', 'The due date is before the start date.'),
      );
    if (merged.expected_deliverable_detail && !merged.expected_deliverable_type)
      throw invalid(
        issue(
          '/changes/expected_deliverable_type',
          'required',
          'Choose the kind of deliverable first.',
        ),
      );
  }

  protected async insertTask(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    c: Awaited<ReturnType<TaskCoreService['resolveContainer']>>,
    fields: Record<string, unknown>,
    opts: {
      after?: string | 'last';
      source?: 'ui' | 'template' | 'paste' | 'form' | 'api' | 'webhook' | 'mcp' | 'ai_proposal';
      lenientStatus?: boolean;
      /** 2E: origin for tasks made from captured input (default manual). */
      origin?: { kind: 'intake' | 'import' | 'ai_draft'; ref: Record<string, string> };
    } = {},
  ): Promise<{ id: string; publicId: string }> {
    const depth = c.parent ? c.parent.row.depth + 1 : 0;
    if (depth > this.ws.taskDepthMax)
      throw invalid(
        issue(
          '/parent',
          'depth_exceeded',
          `Subtasks can be nested at most ${this.ws.taskDepthMax} levels deep.`,
        ),
      );
    const id = newUuidV7();
    const publicId = newPublicId('tsk');
    const cmd = this.cmd(caller, p, c.brand.id);
    await tx.db
      .insertInto('core.record')
      .values({
        id,
        public_id: publicId,
        record_type: 'task',
        workspace_id: tx.workspaceId,
        brand_id: c.brand.id,
        source_kind: opts.source ?? 'ui',
        source_ref: null,
        created_by_actor_type: cmd.actor.type,
        created_by_actor_id: cmd.actor.id,
      })
      .execute();
    const rank = await this.nextRank(tx, 'work.task', this.siblingScope(c), opts.after ?? 'last');
    // The starting status comes from the workflow that applies in the container (W4). A copied
    // status the destination no longer offers falls back to the starting status.
    const wf = await this.taskWorkflow(tx, c.brand.id, c.project?.id ?? null);
    const wanted = fields.status;
    const initial: StatusRef =
      wanted === undefined
        ? initialStatus('task', wf)
        : opts.lenientStatus
          ? (offered('task', wf).find((x) => x.key === wanted && !TERMINAL.has(x.category)) ??
            initialStatus('task', wf))
          : statusFromKey('task', wf, wanted, '/status');
    if (initial.category === 'done')
      throw invalid(issue('/status', 'use_complete', 'Create the task, then complete it.'));
    const merged: Record<string, unknown> = { ...fields, status: initial.key };
    this.checkDates(merged);
    await tx.db
      .insertInto('work.task')
      .values({
        id,
        workspace_id: tx.workspaceId,
        brand_id: c.brand.id,
        scope_key: c.brand.id,
        project_id: c.project?.id ?? null,
        parent_task_id: c.parent?.id ?? null,
        ancestor_ids: c.parent ? [...c.parent.row.ancestor_ids, c.parent.id] : [],
        depth,
        status_category: 'planned',
        rank,
        created_by_membership_id: p.membershipId,
        ...(this.taskColumns(merged) as { title: string }),
        status_id: initial.id,
        ...(opts.origin
          ? { origin_kind: opts.origin.kind, origin_ref: JSON.stringify(opts.origin.ref) }
          : {}),
      })
      .execute();
    const { deadline: dl, ...rest } = merged;
    await this.workAudit(
      tx,
      caller,
      p,
      'task.created',
      { recordId: id, type: 'task', publicId },
      [
        ...auditDiff({}, rest, TASK_CONTENT_FIELDS),
        ...(dl !== undefined ? [change.plain('deadline', null, JSON.stringify(dl))] : []),
        change.plain('project', null, c.project?.publicId ?? null),
        change.plain('parent', null, c.parent?.publicId ?? null),
      ],
      c.brand.id,
    );
    await writeOutboxEvent(tx, {
      type: 'work.task.created',
      aggregate: { type: 'work.task', id, sequence: 0 },
      data: {
        project_id: c.project?.id ?? null,
        parent_task_id: c.parent?.id ?? null,
        status_id: initial.id,
        source_kind: opts.source ?? 'ui',
      },
      actor: { type: 'human', id: p.membershipId },
      context: this.exec(caller, p),
      brandId: c.brand.id,
    });
    return { id, publicId };
  }

  async createTask(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    return this.createTaskWithOrigin(caller, ws, body, req);
  }

  /** Trusted adapters supply provenance separately from the untrusted request body. */
  protected async createTaskWithOrigin(
    caller: Caller,
    ws: unknown,
    body: unknown,
    req: Mutation,
    origin?: { kind: 'import'; ref: Record<string, string> },
  ) {
    if (caller.delegation && !caller.delegation.scopes.includes('records:write'))
      throw new TenancyError('forbidden');
    const input = parseTaskCreate(body, this.ws.taskEstimateMinutesMax);
    return this.mutate(
      caller,
      'task.create',
      ws,
      req,
      async (tx, p) => {
        const c = await this.resolveContainer(
          tx,
          p,
          {
            brand: input.brand,
            ...(input.project ? { project: input.project } : {}),
            parent: input.parent,
          },
          null,
        );
        if (c.parent) this.requireTaskAction(p, 'record.create', c.parent, { shares: false });
        else this.requireCreateIn(p, c);
        if (input.fields.status === 'cancelled')
          throw invalid(issue('/status', 'invalid_option', 'A new task starts open.'));
        const created = await this.insertTask(tx, caller, p, c, input.fields, {
          ...(caller.delegation ? { source: caller.delegation.sourceKind } : {}),
          ...(origin ? { origin } : {}),
        });
        return {
          status: 201,
          ref: { id: created.publicId, type: 'task' },
          data: await this.taskView(tx, p, await this.loadTask(tx, p, created.publicId)),
        };
      },
      async (tx, p, ref) => this.taskView(tx, p, await this.loadTask(tx, p, ref.id)),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Field edits, completion, reopening
  // ---------------------------------------------------------------------------------------------

  protected currentFields(r: TaskRow, tx: WorkspaceTransaction): Record<string, unknown> {
    return {
      title: r.title,
      description: r.description_rich ?? null,
      status: statusRef(tx, r.status_id).key,
      priority: r.priority,
      start_date: r.start_date,
      due_date: r.due_date,
      deadline: deadlineOf(r),
      estimate_minutes: r.estimate_minutes,
      remaining_estimate_minutes: r.remaining_estimate_minutes,
      expected_deliverable_type: r.expected_deliverable_type,
      expected_deliverable_detail: r.expected_deliverable_detail,
      requires_acceptance: r.requires_acceptance,
    };
  }

  async updateTask(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    body: unknown,
    req: Mutation,
    transition?: TaskTransition,
  ) {
    // The transition apply command is a status-only edit with a preview or approval (W8).
    const merge = transition
      ? { version: transition.version, changes: new Map() }
      : parseMerge(body, TASK_FIELDS);
    return this.mutate<
      Awaited<ReturnType<TaskCoreService['taskView']>> & {
        undo: { id: string; expires_at: string } | null;
      }
    >(
      caller,
      transition ? 'task.transition' : 'task.update',
      ws,
      req,
      async (tx, p) => {
        const t = await this.editableTask(tx, p, tsk);
        const version = t.row.version;
        const expected = req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : merge.version;
        if (expected === undefined) throw new TenancyError('precondition_required');
        const current = this.currentFields(t.row, tx);
        if (transition) requireVersion(expected, version);
        const next: Record<string, unknown> = transition
          ? { status: transition.to }
          : applyFieldMerge(
              { ...merge, version: expected === version ? version : merge.version },
              current,
              version,
              (field, value, issues) =>
                taskField(field, value, issues, this.ws.taskEstimateMinutesMax),
            );
        if (expected !== version && merge.version === undefined && !Object.keys(next).length)
          requireVersion(expected, version);
        if (!Object.keys(next).length)
          return {
            status: 200,
            ref: { id: t.publicId, type: 'task' },
            data: { ...(await this.taskView(tx, p, t)), undo: null },
          };
        await this.applyTaskChanges(tx, caller, req, p, t, current, next, transition);
        const undo = transition
          ? null
          : await this.recordUndo(tx, p, {
              command: 'task.update',
              targets: [{ id: t.id, version: version + 1 }],
              inverse: {
                fields: Object.fromEntries(Object.keys(next).map((k) => [k, current[k] ?? null])),
              },
              before: current,
              after: next,
            });
        return {
          status: 200,
          ref: { id: t.publicId, type: 'task' },
          data: {
            ...(await this.taskView(tx, p, await this.loadTask(tx, p, t.publicId))),
            // The actor's undo handle for this change (ADR-0016 D11); null on replays.
            undo,
          },
        };
      },
      async (tx, p, ref) => ({
        ...(await this.taskView(tx, p, await this.loadTask(tx, p, ref.id))),
        undo: null,
      }),
    );
  }

  /**
   * Applies validated field changes to a locked, editable task: status changes run the one
   * transition evaluator; the row, envelope version, audit, and outbox events commit together.
   * Shared by edits, inline edits, bulk commands, and undo (ADR-0016 D8, D10, D11).
   */
  protected async applyTaskChanges(
    tx: WorkspaceTransaction,
    caller: Caller,
    req: Mutation,
    p: Principal,
    t: LoadedTask,
    current: Record<string, unknown>,
    next: Record<string, unknown>,
    transition?: TaskTransition,
  ): Promise<number> {
    const version = t.row.version;
    const statusChanging = next.status !== undefined && next.status !== current.status;
    const from = statusRef(tx, t.row.status_id);
    if (statusChanging && TERMINAL.has(from.category))
      throw invalid(
        issue('/changes/status', 'use_reopen', 'Reopen the task to change its status.'),
      );
    const merged = { ...current, ...next };
    this.checkDates(merged);
    let to: StatusRef | null = null;
    if (statusChanging) {
      const wf = await this.taskWorkflow(tx, t.brand.id, t.row.project_id);
      to = statusFromKey('task', wf, next.status, '/changes/status');
      await this.taskGate(
        tx,
        caller,
        req,
        p,
        t,
        { wf, from, to, intent: 'edit', merged },
        transition,
      );
    }
    const set: Record<string, unknown> = {
      ...this.taskColumns(next),
      updated_at: new Date(),
      updated_by_membership_id: p.membershipId,
      version: version + 1,
    };
    if (to) set.status_id = to.id;
    if (to && to.category === 'cancelled') set.prior_status_id = t.row.status_id;
    await tx.db.updateTable('work.task').set(set).where('id', '=', t.id).execute();
    await tx.db
      .updateTable('core.record')
      .set({ version: sql`version + 1` })
      .where('id', '=', t.id)
      .execute();
    const diff = auditDiff(
      { ...current, deadline: JSON.stringify(current.deadline) },
      {
        ...next,
        ...(next.deadline !== undefined ? { deadline: JSON.stringify(next.deadline) } : {}),
      },
      TASK_CONTENT_FIELDS,
    );
    await this.taskAudit(tx, caller, p, 'task.updated', t, diff);
    await this.workEvent(
      tx,
      caller,
      p,
      'work.task.updated',
      { type: 'work.task', id: t.id, sequence: version + 1 },
      { changed_fields: Object.keys(next).sort().join(',') },
      t.brand.id,
    );
    if (statusChanging)
      await this.workEvent(
        tx,
        caller,
        p,
        'work.task.status_changed',
        { type: 'work.task', id: t.id, sequence: version + 1 },
        {
          from_status_id: t.row.status_id,
          to_status_id: to!.id,
          to_category: to!.category,
        },
        t.brand.id,
      );
    return version + 1;
  }

  /**
   * Records the inverse of a reversible task change for its actor (ADR-0016 D11). The 2B/2C chain
   * keeps no undo entries; the 2D service overrides this.
   */
  protected async recordUndo(
    _tx: WorkspaceTransaction,
    _p: Principal,
    _entry: {
      command: string;
      targets: Array<{ id: string; version: number }>;
      inverse: Record<string, unknown>;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    },
  ): Promise<{ id: string; expires_at: string } | null> {
    return null;
  }

  /** Required criteria not yet met: the task's own and its project's inherited definition of done. */
  protected async unmetCriteria(tx: WorkspaceTransaction, t: LoadedTask) {
    const own = await tx.db
      .selectFrom('work.criteria_item')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('task_id', '=', t.id)
      .where('required', '=', true)
      .where('met', '=', false)
      .executeTakeFirstOrThrow();
    let inherited = 0;
    if (t.row.project_id) {
      const r = await sql<{ n: string }>`
        SELECT count(*) AS n FROM work.criteria_item c
         WHERE c.project_id = ${t.row.project_id} AND c.owner_kind = 'project' AND c.kind = 'definition_of_done'
           AND NOT EXISTS (SELECT 1 FROM work.task_inherited_criterion x
                            WHERE x.task_id = ${t.id} AND x.criteria_item_id = c.id)`.execute(
        tx.db,
      );
      inherited = Number(r.rows[0]?.n ?? 0);
    }
    return { own: Number(own.n), inherited };
  }

  /** Incomplete descendants the actor can read (never a count of hidden work, AT-120). */
  protected async incompleteVisibleDescendants(
    tx: WorkspaceTransaction,
    p: Principal,
    t: LoadedTask,
  ) {
    const vis = await this.taskVisibility(tx, p, false);
    const r = await sql<{ n: string }>`
      WITH RECURSIVE ${taskSubtree(t.id)}
      SELECT count(*) AS n FROM sub JOIN work.task d ON d.id = sub.id
        JOIN core.record r ON r.workspace_id = d.workspace_id AND r.id = d.id
       WHERE d.status_category NOT IN ('done', 'cancelled') AND ${vis.where('r', { project: sql`d.project_id` })}`.execute(
      tx.db,
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async completeTask(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    body: unknown,
    req: Mutation,
    transition?: TaskTransition,
  ) {
    const input = transition
      ? { overrideReason: transition.overrideReason, confirmSubtasks: transition.confirmSubtasks }
      : parseComplete(body);
    return this.mutate(
      caller,
      transition ? 'task.transition' : 'task.complete',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        // Completion gates depend on project facts outside a share, so a share alone never
        // completes (AZ-22); a share-only reader gets `forbidden` on the task they can read.
        this.requireTaskAction(p, 'task.complete', t, { shares: false, excluded: 'forbidden' });
        if (p.kind !== 'member') throw new TenancyError('forbidden');
        this.requireTaskActive(t);
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), t.row.version);
        if (transition) requireVersion(transition.version, t.row.version);
        const category = t.row.status_category;
        if (category === 'done' && !transition)
          return {
            status: 200,
            ref: { id: t.publicId, type: 'task' },
            data: await this.taskView(tx, p, t),
          };
        if (category === 'cancelled')
          throw invalid(
            issue('/', 'use_reopen', 'Reopen this cancelled task before completing it.'),
          );
        const unmet = await this.unmetCriteria(tx, t);
        const subtasks = await this.incompleteVisibleDescendants(tx, p, t);
        const needsOverride = unmet.own + unmet.inherited > 0 || subtasks > 0;
        if (unmet.own + unmet.inherited > 0 && !input.overrideReason) {
          this.d.metrics.count('work.task.completions', 1, { outcome: 'refused_criteria' });
          throw invalid(
            issue(
              '/',
              'criteria_incomplete',
              `${unmet.own + unmet.inherited} required ${unmet.own + unmet.inherited === 1 ? 'item is' : 'items are'} not met.`,
            ),
          );
        }
        if (subtasks > 0 && !(input.confirmSubtasks && input.overrideReason)) {
          this.d.metrics.count('work.task.completions', 1, { outcome: 'refused_subtasks' });
          throw new TenancyError('conflict', {
            issues: [
              issue(
                '/confirm_incomplete_subtasks',
                'incomplete_subtasks',
                `${subtasks} ${subtasks === 1 ? 'subtask is' : 'subtasks are'} not finished. Confirm and give a reason to complete anyway.`,
              ),
            ],
          });
        }
        if (needsOverride)
          this.requireTaskAction(p, 'task.override_completion', t, {
            shares: false,
            excluded: 'forbidden',
          });
        // Into done through the workflow: the chosen done status, or the first one (W4–W6).
        const wf = await this.taskWorkflow(tx, t.brand.id, t.row.project_id);
        const from = statusRef(tx, t.row.status_id);
        const done = transition
          ? statusFromKey('task', wf, transition.to, '/to')
          : firstOfCategory('task', wf, 'done');
        if (!done)
          throw invalid(issue('/', 'workflow_incomplete', 'This workflow has no done status.'));
        const gate = await this.taskGate(
          tx,
          caller,
          req,
          p,
          t,
          {
            wf,
            from,
            to: done,
            intent: 'complete',
            merged: this.currentFields(t.row, tx),
          },
          transition,
        );
        const now = new Date();
        await tx.db
          .updateTable('work.task')
          .set({
            status_id: done.id,
            prior_status_id: t.row.status_id,
            completed_at: now,
            completed_by_membership_id: p.membershipId,
            completion_override_reason: needsOverride ? input.overrideReason : null,
            updated_at: now,
            updated_by_membership_id: p.membershipId,
            version: t.row.version + 1,
          })
          .where('id', '=', t.id)
          .execute();
        await tx.db
          .updateTable('core.record')
          .set({ version: sql`version + 1` })
          .where('id', '=', t.id)
          .execute();
        await this.taskAudit(tx, caller, p, 'task.completed', t, [
          change.plain('status', from.key, done.key),
          change.plain('override', null, needsOverride),
          ...(gate.overrideUsed ? [change.plain('workflow_requirement_override', null, true)] : []),
          ...(needsOverride
            ? [
                change.content('override_reason', {
                  hash: `sha256:${createHash('sha256').update(input.overrideReason!).digest('hex')}`,
                }),
                change.plain('unmet_criteria', null, unmet.own + unmet.inherited),
                change.plain('incomplete_subtasks_visible', null, subtasks),
              ]
            : []),
        ]);
        await this.workEvent(
          tx,
          caller,
          p,
          'work.task.completed',
          { type: 'work.task', id: t.id, sequence: t.row.version + 1 },
          {
            completed_at: now.toISOString(),
            status_category: 'done',
            project_id: t.row.project_id,
          },
          t.brand.id,
        );
        await this.workEvent(
          tx,
          caller,
          p,
          'work.task.status_changed',
          { type: 'work.task', id: t.id, sequence: t.row.version + 1 },
          {
            from_status_id: t.row.status_id,
            to_status_id: done.id,
            to_category: 'done',
          },
          t.brand.id,
        );
        this.d.metrics.count('work.task.completions', 1, {
          outcome: needsOverride ? 'override' : 'completed',
        });
        return {
          status: 200,
          ref: { id: t.publicId, type: 'task' },
          data: await this.taskView(tx, p, await this.loadTask(tx, p, t.publicId)),
        };
      },
      async (tx, p, ref) => this.taskView(tx, p, await this.loadTask(tx, p, ref.id)),
    );
  }

  async reopenTask(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    req: Mutation,
    transition?: TaskTransition,
  ) {
    return this.mutate(
      caller,
      transition ? 'task.transition' : 'task.reopen',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        this.requireTaskAction(p, 'task.complete', t, { shares: false, excluded: 'forbidden' });
        this.requireTaskActive(t);
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), t.row.version);
        if (!TERMINAL.has(t.row.status_category))
          return {
            status: 200,
            ref: { id: t.publicId, type: 'task' },
            data: await this.taskView(tx, p, t),
          };
        if (transition) requireVersion(transition.version, t.row.version);
        // The prior non-terminal status when the workflow still offers it, otherwise its first
        // planned status (ADR-22, ADR-0015 W4); the apply command may name the target.
        const wf = await this.taskWorkflow(tx, t.brand.id, t.row.project_id);
        const from = statusRef(tx, t.row.status_id);
        const choices = offered('task', wf);
        const target: StatusRef = transition
          ? statusFromKey('task', wf, transition.to, '/to')
          : (choices.find((x) => x.id === t.row.prior_status_id && !TERMINAL.has(x.category)) ??
            initialStatus('task', wf));
        await this.taskGate(
          tx,
          caller,
          req,
          p,
          t,
          { wf, from, to: target, intent: 'reopen', merged: this.currentFields(t.row, tx) },
          transition,
        );
        const prior = target.id;
        const to = target.key;
        await tx.db
          .updateTable('work.task')
          .set({
            status_id: prior,
            prior_status_id: null,
            completed_at: null,
            completed_by_membership_id: null,
            completion_override_reason: null,
            updated_at: new Date(),
            updated_by_membership_id: p.membershipId,
            version: t.row.version + 1,
          })
          .where('id', '=', t.id)
          .execute();
        await tx.db
          .updateTable('core.record')
          .set({ version: sql`version + 1` })
          .where('id', '=', t.id)
          .execute();
        await this.taskAudit(tx, caller, p, 'task.reopened', t, [
          change.plain('status', from.key, to),
        ]);
        await this.workEvent(
          tx,
          caller,
          p,
          'work.task.reopened',
          { type: 'work.task', id: t.id, sequence: t.row.version + 1 },
          { status_id: prior, status_category: target.category },
          t.brand.id,
        );
        return {
          status: 200,
          ref: { id: t.publicId, type: 'task' },
          data: await this.taskView(tx, p, await this.loadTask(tx, p, t.publicId)),
        };
      },
      async (tx, p, ref) => this.taskView(tx, p, await this.loadTask(tx, p, ref.id)),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Moves
  // ---------------------------------------------------------------------------------------------

  /** The task and its descendants (bounded by TASK_SUBTREE_MAX before any change). */
  protected async subtreeOf(tx: WorkspaceTransaction, taskId: string) {
    const rows = await sql<{ id: string; depth: number }>`
      WITH RECURSIVE ${taskSubtree(taskId)}
      SELECT id, depth FROM sub LIMIT ${this.ws.taskSubtreeMax}`.execute(tx.db);
    if (rows.rows.length + 1 > this.ws.taskSubtreeMax)
      throw invalid(
        issue(
          '/',
          'subtree_too_large',
          `At most ${this.ws.taskSubtreeMax} tasks can move or change together.`,
        ),
      );
    return rows.rows;
  }

  /** Tree-root advisory locks in ascending order (opposing moves serialize; 0B ADR-05). */
  protected async lockTaskRoots(tx: WorkspaceTransaction, roots: Array<string | null | undefined>) {
    for (const r of [...new Set(roots.filter((x): x is string => !!x))].sort())
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'task-tree:' + r}, 0))`.execute(
        tx.db,
      );
  }

  async moveTask(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const input = parseTaskMove(body);
    return this.mutate(
      caller,
      'task.move',
      ws,
      req,
      async (tx, p) => {
        const before = await this.loadTask(tx, p, tsk);
        const parentRow = input.parent
          ? await tx.db
              .selectFrom('work.task as t')
              .innerJoin('core.record as r', 'r.id', 't.id')
              .select(['t.id', 't.ancestor_ids'])
              .where('r.public_id', '=', input.parent)
              .executeTakeFirst()
          : undefined;
        await this.lockTaskRoots(tx, [
          before.row.ancestor_ids[0] ?? before.id,
          parentRow ? (parentRow.ancestor_ids[0] ?? parentRow.id) : null,
        ]);
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        this.requireTaskAction(p, 'record.move', t, { shares: false, excluded: 'forbidden' });
        this.requireTaskActive(t);
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), t.row.version);
        try {
          const projectChanging = input.project !== undefined;
          const currentProject = t.row.project_id
            ? await this.publicOf(tx, t.row.project_id)
            : null;
          const target = await this.resolveContainer(
            tx,
            p,
            {
              // Unchanged containers stay: the current project (or the brand when projectless).
              project: projectChanging ? input.project : currentProject,
              ...(projectChanging ? {} : { brand: t.brand.publicId }),
              parent:
                input.parent !== undefined
                  ? input.parent
                  : projectChanging
                    ? null
                    : t.row.parent_task_id
                      ? await this.publicOf(tx, t.row.parent_task_id)
                      : null,
            },
            t.id,
          );
          if (target.brand.id !== t.brand.id)
            throw invalid(
              issue(
                '/project',
                'cross_brand_move',
                'Use "Move to another brand" to change the brand.',
              ),
            );
          const newProject = target.parent
            ? target.parent.row.project_id
            : (target.project?.id ?? null);
          if (
            newProject !== t.row.project_id ||
            target.parent?.id !== (t.row.parent_task_id ?? undefined)
          )
            this.requireCreateIn(p, {
              brand: target.brand,
              project: target.project,
              chain: target.chain,
            });
          const subtree = await this.subtreeOf(tx, t.id);
          const height = subtree.reduce((m, s) => Math.max(m, s.depth), t.row.depth) - t.row.depth;
          const newDepth = target.parent ? target.parent.row.depth + 1 : 0;
          if (newDepth + height > this.ws.taskDepthMax)
            throw invalid(
              issue(
                '/parent',
                'depth_exceeded',
                `Subtasks can be nested at most ${this.ws.taskDepthMax} levels deep.`,
              ),
            );
          let afterId: string | null = null;
          if (input.after) {
            const a = await this.loadTask(tx, p, input.after);
            if (
              a.row.parent_task_id !== (target.parent?.id ?? null) ||
              a.row.project_id !== newProject
            )
              throw invalid(
                issue('/after', 'invalid_reference', 'Choose a task at the destination.'),
              );
            afterId = a.id;
          }
          const rank = await this.nextRank(
            tx,
            'work.task',
            (q) =>
              this.siblingScope({
                brand: t.brand,
                project: newProject ? { id: newProject } : null,
                parent: target.parent,
              })(q).where('id', '<>', t.id),
            afterId,
          );
          const prefix = target.parent ? [...target.parent.row.ancestor_ids, target.parent.id] : [];
          const oldDepth = t.row.depth;
          await sql`WITH RECURSIVE ${taskSubtree(t.id)}
            UPDATE work.task w SET
              ancestor_ids = ${prefix}::uuid[] || w.ancestor_ids[${oldDepth + 1}:cardinality(w.ancestor_ids)],
              depth = w.depth - ${oldDepth} + ${newDepth},
              project_id = ${newProject}::uuid,
              version = w.version + 1
            FROM sub WHERE w.id = sub.id`.execute(tx.db);
          await tx.db
            .updateTable('work.task')
            .set({
              parent_task_id: target.parent?.id ?? null,
              ancestor_ids: prefix,
              depth: newDepth,
              project_id: newProject,
              rank,
              updated_at: new Date(),
              updated_by_membership_id: p.membershipId,
              version: t.row.version + 1,
            })
            .where('id', '=', t.id)
            .execute();
          await tx.db
            .updateTable('core.record')
            .set({ version: sql`version + 1` })
            .where('id', '=', t.id)
            .execute();
          if (newProject !== t.row.project_id) {
            // Inherited project items belong to the old project (evaluated, never copied).
            await tx.db
              .deleteFrom('work.task_inherited_criterion')
              .where('task_id', 'in', [t.id, ...subtree.map((s) => s.id)])
              .execute();
          }
          const projectPublic = newProject ? await this.publicOf(tx, newProject) : null;
          const oldProjectPublic = t.row.project_id
            ? await this.publicOf(tx, t.row.project_id)
            : null;
          await this.taskAudit(tx, caller, p, 'task.moved', t, [
            change.plain('project', oldProjectPublic, projectPublic),
            change.plain(
              'parent',
              t.row.parent_task_id ? await this.publicOf(tx, t.row.parent_task_id) : null,
              target.parent?.publicId ?? null,
            ),
            change.plain('subtree_size', null, subtree.length + 1),
          ]);
          await this.workEvent(
            tx,
            caller,
            p,
            'work.task.moved',
            { type: 'work.task', id: t.id, sequence: t.row.version + 1 },
            { project_id: newProject, parent_task_id: target.parent?.id ?? null, depth: newDepth },
            t.brand.id,
          );
          this.d.metrics.count('work.task.moves', 1, { outcome: 'ok' });
        } catch (err) {
          const outcome =
            err instanceof TenancyError
              ? err.code
              : pgErr(err).code === '23514'
                ? 'invariant'
                : 'error';
          this.d.metrics.count('work.task.moves', 1, { outcome });
          if (pgErr(err).code === '23514')
            throw new TenancyError('conflict', {
              issues: [
                issue(
                  '/',
                  'stale_ancestry',
                  'The tree changed while you were moving this task. Try again.',
                ),
              ],
            });
          throw err;
        }
        return {
          status: 200,
          ref: { id: t.publicId, type: 'task' },
          data: await this.taskView(tx, p, await this.loadTask(tx, p, t.publicId)),
        };
      },
      async (tx, p, ref) => this.taskView(tx, p, await this.loadTask(tx, p, ref.id)),
    );
  }

  /**
   * Cross-brand move facts (OD-02, AZ-22): manage in both brands, a projectless task or a
   * destination project in the target brand, the bounded subtree, and the exposure diff the
   * preview showed (members who gain or lose read access to the task).
   */
  protected async brandMovePlan(
    tx: WorkspaceTransaction,
    p: Principal,
    t: LoadedTask,
    input: { brand: string; project: string | null },
  ) {
    this.requireTaskAction(p, 'record.move', t, { shares: false, excluded: 'forbidden' });
    this.requireTaskActive(t);
    const dest = await findBrand(tx, p, input.brand);
    if (dest.id === t.brand.id)
      throw invalid(
        issue('/brand', 'same_brand', 'Choose a different brand, or move it within this brand.'),
      );
    for (const b of [
      t.brand,
      { id: dest.id, isSensitive: dest.is_sensitive, lifecycleState: dest.lifecycle_state },
    ]) {
      const o = decideBrand(p, 'record.move_brand', { ...b, lifecycleState: 'active' });
      this.decision('record.move_brand', o);
      if (!o.allowed) throw new TenancyError('forbidden');
    }
    if (dest.lifecycle_state !== 'active')
      throw new TenancyError('conflict', {
        issues: [issue('/brand', 'brand_archived', 'This brand is archived.')],
      });
    let project: LoadedProject | null = null;
    if (input.project) {
      project = await this.loadProject(tx, p, input.project, { lock: true });
      if (project.ownLevel === null) throw new TenancyError('not_found');
      if (project.brand.id !== dest.id)
        throw invalid(
          issue('/project', 'cross_brand_project', 'Choose a project in the destination brand.'),
        );
      this.requireActive(project);
      this.requireCreateIn(p, { brand: project.brand, project, chain: project.chain });
    } else if (t.row.project_id)
      throw invalid(
        issue(
          '/project',
          'project_required',
          'Choose a project in the destination brand for this task.',
        ),
      );
    const subtree = await this.subtreeOf(tx, t.id);
    const ids = [t.id, ...subtree.map((s) => s.id)];
    // Documents live in the brand of the task they are attached to (4C): they move first.
    const attached = await tx.db
      .selectFrom('knowledge.document')
      .select('id')
      .where('attached_task_id', 'in', ids)
      .where('lifecycle_state', '<>', 'purged')
      .limit(1)
      .executeTakeFirst();
    if (attached)
      throw new TenancyError('conflict', {
        issues: [
          issue(
            '/task',
            'documents_attached',
            'This task has documents. Move or remove them before moving the task to another brand.',
          ),
        ],
      });
    const labels = await tx.db
      .selectFrom('work.task_label')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('task_id', 'in', ids)
      .executeTakeFirstOrThrow();
    const inherited = await tx.db
      .selectFrom('work.task_inherited_criterion')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('task_id', 'in', ids)
      .executeTakeFirstOrThrow();
    const { facts: destFacts } = await this.brandFactsOf(tx, dest.id);
    const destChain = project ? project.chain : [];
    // Exposure: every active membership's level on the task before and after (same compiler).
    const members = await tx.db
      .selectFrom('tenancy.membership')
      .select(['id', 'account_id', 'kind'])
      .where('state', '=', 'active')
      .orderBy('id')
      .execute();
    const share = await tx.db
      .selectFrom('access.record_grant')
      .select(['grantee_key', 'level'])
      .where('record_id', '=', t.id)
      .where('state', '=', 'active')
      .execute();
    let gained = 0;
    let lost = 0;
    const assigneesLosing = new Set<string>();
    const assigned = new Set(
      (
        await tx.db
          .selectFrom('work.task_assignee')
          .select('membership_id')
          .where('task_id', '=', t.id)
          .execute()
      ).map((a) => a.membership_id),
    );
    for (const m of members) {
      const mp = await compilePrincipal(tx, m.id, m.account_id, m.kind as 'member' | 'guest');
      const keys = new Set([mp.membershipId, ...mp.teams]);
      const sl = share.find((g) => keys.has(g.grantee_key))?.level as ShareLevel | undefined;
      const b = recordLevel(mp, {
        brand: t.brand,
        lifecycleState: 'active',
        projectChain: t.chain,
        shareLevel: sl ?? null,
      });
      const a = recordLevel(mp, {
        brand: destFacts,
        lifecycleState: 'active',
        projectChain: destChain,
        shareLevel: sl ?? null,
      });
      if (b === null && a !== null) gained++;
      if (b !== null && a === null) {
        lost++;
        if (assigned.has(m.id)) assigneesLosing.add(m.id);
      }
    }
    const diff: ExposureDiff = {
      brands: [],
      records_gained: gained ? { task: ids.length } : {},
      records_lost: lost ? { task: ids.length } : {},
      capabilities_gained: [],
      capabilities_lost: [],
      projects: [],
      affected_members: gained + lost,
      increases_access: gained > 0,
    };
    const change = {
      task: t.publicId,
      version: t.row.version,
      brand: input.brand,
      project: input.project,
      subtree: ids.length,
    };
    return {
      dest: destFacts,
      project,
      subtree,
      ids,
      diff,
      change,
      preview: {
        diff,
        members_gaining: gained,
        members_losing: lost,
        assignees_losing_access: assigneesLosing.size,
        tasks: ids.length,
        omitted: { labels: Number(labels.n), inherited_criteria: Number(inherited.n) },
      },
    };
  }

  async previewTaskBrandMove(caller: Caller, ws: unknown, tsk: unknown, body: unknown) {
    const input = parseBrandMove(body, false);
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const t = await this.loadTask(tx, p, tsk);
      const plan = await this.brandMovePlan(tx, p, t, input);
      return {
        ...plan.preview,
        preview_token: previewToken(
          this.#moveKey,
          { viewer: p.membershipId, change: plan.change, epochs: p.epochs, diff: plan.diff },
          this.c.settings.previewTtlMs,
        ),
      };
    });
  }

  async moveTaskBrand(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const input = parseBrandMove(body, true);
    return this.mutate(
      caller,
      'task.move_brand',
      ws,
      req,
      async (tx, p) => {
        const peek = await this.loadTask(tx, p, tsk);
        await this.lockTaskRoots(tx, [peek.row.ancestor_ids[0] ?? peek.id]);
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        const plan = await this.brandMovePlan(tx, p, t, input);
        // Atomic revalidation: the preview must equal what is applied now (AZ-22).
        if (
          !verifyPreviewToken(this.#moveKey, input.previewToken, {
            viewer: p.membershipId,
            change: plan.change,
            epochs: p.epochs,
            diff: plan.diff,
          })
        )
          throw new TenancyError('conflict', {
            issues: [
              issue('/preview_token', 'stale_preview', 'Something changed. Review the move again.'),
            ],
          });
        const from = t.brand.id;
        const to = plan.dest.id;
        await tx.db.deleteFrom('work.task_label').where('task_id', 'in', plan.ids).execute();
        await tx.db
          .deleteFrom('work.task_inherited_criterion')
          .where('task_id', 'in', plan.ids)
          .execute();
        const oldDepth = t.row.depth;
        await sql`WITH RECURSIVE ${taskSubtree(t.id)}
          UPDATE work.task w SET brand_id = ${to}::uuid, scope_key = ${to}::uuid,
            project_id = ${plan.project?.id ?? null}::uuid,
            ancestor_ids = w.ancestor_ids[${oldDepth + 1}:cardinality(w.ancestor_ids)],
            depth = w.depth - ${oldDepth}, version = w.version + 1
          FROM sub WHERE w.id = sub.id`.execute(tx.db);
        const rank = await this.nextRank(
          tx,
          'work.task',
          (q) => this.siblingScope({ brand: { id: to }, project: plan.project, parent: null })(q),
          'last',
        );
        await tx.db
          .updateTable('work.task')
          .set({
            brand_id: to,
            scope_key: to,
            project_id: plan.project?.id ?? null,
            parent_task_id: null,
            ancestor_ids: [],
            depth: 0,
            rank,
            updated_at: new Date(),
            updated_by_membership_id: p.membershipId,
            version: t.row.version + 1,
          })
          .where('id', '=', t.id)
          .execute();
        // Label values belong to the old brand's labels and cannot follow (ADR-0015 W15).
        await sql`DELETE FROM workflow.field_value v USING workflow.field_definition d
                   WHERE d.id = v.definition_id AND d.field_type = 'label' AND v.record_id = ANY(${plan.ids}::uuid[])`.execute(
          tx.db,
        );
        await sql`SELECT work.move_task_brand(${plan.ids}::uuid[], ${to}::uuid)`.execute(tx.db);
        await bumpEpoch(tx, 'workspace', null);
        await this.workAudit(
          tx,
          caller,
          p,
          'task.moved_brand',
          { recordId: t.id, type: 'task', publicId: t.publicId },
          [
            change.plain('brand', t.brand.publicId, plan.dest.publicId),
            change.plain(
              'project',
              t.row.project_id ? await this.publicOf(tx, t.row.project_id) : null,
              plan.project?.publicId ?? null,
            ),
            change.plain('subtree_size', null, plan.ids.length),
            change.plain('labels_removed', null, plan.preview.omitted.labels),
          ],
          to,
        );
        await writeOutboxEvent(tx, {
          type: 'core.record.moved_brand',
          aggregate: { type: 'core.record', id: t.id, sequence: t.row.version + 1 },
          data: { from_brand_id: from, to_brand_id: to },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: to,
        });
        this.d.metrics.count('work.task.moves', 1, { outcome: 'brand' });
        return {
          status: 200,
          ref: { id: t.publicId, type: 'task' },
          data: await this.taskView(tx, p, await this.loadTask(tx, p, t.publicId)),
        };
      },
      async (tx, p, ref) => this.taskView(tx, p, await this.loadTask(tx, p, ref.id)),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle: the selected task only, or its subtree when explicitly confirmed (ADR-22)
  // ---------------------------------------------------------------------------------------------

  async taskLifecycle(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    verb: 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge',
    body: unknown,
    req: Mutation,
  ) {
    const { includeSubtasks } = parseSubtreeOption(body);
    return this.mutate(
      caller,
      `task.${verb}`,
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, {
          lock: true,
          allowTrashed: verb === 'restore' || verb === 'purge',
        });
        if (t.ownLevel === null) throw new TenancyError('forbidden');
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), t.row.version);
        const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
        const facts = (id: string) => ({
          id,
          brand: t.brand,
          lifecycleState: t.lifecycleState,
          chain: t.chain,
        });
        const subtree = includeSubtasks ? await this.subtreeOf(tx, t.id) : [];
        // Order: containers before contents when activating, contents first when purging.
        const orderedIds =
          verb === 'purge'
            ? [...[...subtree].sort((a, b) => b.depth - a.depth).map((s) => s.id), t.id]
            : [t.id, ...subtree.map((s) => s.id)];
        if (verb === 'purge') {
          const live = await tx.db
            .selectFrom('work.task')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('parent_task_id', 'in', orderedIds)
            .where('id', 'not in', orderedIds)
            .where('lifecycle_state', '<>', 'purged')
            .executeTakeFirstOrThrow();
          if (Number(live.n) > 0)
            throw new TenancyError('conflict', {
              issues: [
                issue(
                  '/',
                  'children_remain',
                  'Move or delete its subtasks before deleting this task permanently.',
                ),
              ],
            });
        }
        let changed = 0;
        for (const id of orderedIds) {
          const state = await tx.db
            .selectFrom('core.record')
            .select(['lifecycle_state', 'deletion_batch_id'])
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
          if (verb === 'archive' && state.lifecycle_state === 'active') {
            await this.d.lifecycle.archive(
              tx,
              this.issueLifecycle(tx, p, 'record.archive', facts(id)),
              input,
              id,
            );
            changed++;
          } else if (verb === 'unarchive' && state.lifecycle_state === 'archived') {
            await this.d.lifecycle.unarchive(
              tx,
              this.issueLifecycle(tx, p, 'record.restore', facts(id)),
              input,
              id,
            );
            changed++;
          } else if (
            verb === 'trash' &&
            (state.lifecycle_state === 'active' || state.lifecycle_state === 'archived')
          ) {
            await this.d.lifecycle.trash(
              tx,
              this.issueLifecycle(tx, p, 'record.trash', facts(id)),
              input,
              id,
            );
            changed++;
          } else if (
            (verb === 'restore' || verb === 'purge') &&
            state.lifecycle_state === 'trashed'
          ) {
            const own = await tx.db
              .selectFrom('core.deletion_batch')
              .select('id')
              .where('id', '=', state.deletion_batch_id!)
              .where('root_record_id', '=', id)
              .executeTakeFirst();
            if (!own) continue; // a member of another batch (e.g. a project's) is restored with it
            if (verb === 'restore')
              await this.d.lifecycle.restore(
                tx,
                this.issueLifecycle(tx, p, 'record.restore', facts(id)),
                input,
                own.id,
              );
            else
              await this.d.lifecycle.requestPurge(
                tx,
                this.issueLifecycle(tx, p, 'record.purge', facts(id)),
                input,
                own.id,
              );
            changed++;
          } else if (id === t.id)
            throw new TenancyError('conflict', {
              issues: [
                issue('/', 'invalid_state', "This task can't do that in its current state."),
              ],
            });
        }
        await bumpEpoch(tx, 'workspace', null);
        const state = await tx.db
          .selectFrom('core.record')
          .select('lifecycle_state')
          .where('id', '=', t.id)
          .executeTakeFirstOrThrow();
        return {
          status: verb === 'purge' ? 202 : 200,
          ref: { id: t.publicId, type: 'task' },
          data: {
            id: t.publicId,
            type: 'task' as const,
            lifecycle_state: state.lifecycle_state,
            changed,
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
          type: 'task' as const,
          lifecycle_state: r.lifecycle_state,
          changed: 0,
        };
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Duplication (ADR-22 decision 17)
  // ---------------------------------------------------------------------------------------------

  /** What duplication never copies (reported to the person). */
  static readonly NOT_COPIED = [
    'assignees',
    'shares',
    'history',
    'comments',
    'dependencies',
    'related_tasks',
    'record_links',
    'acceptance_facts',
    'recurrence',
  ] as const;

  async duplicateTask(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const input = parseDuplicate(body);
    return this.mutate(
      caller,
      'task.duplicate',
      ws,
      req,
      async (tx, p) => {
        const src = await this.loadTask(tx, p, tsk);
        if (src.ownLevel === null) throw new TenancyError('forbidden');
        const container = await this.resolveContainer(
          tx,
          p,
          {
            ...(src.row.project_id ? { project: await this.publicOf(tx, src.row.project_id) } : {}),
            parent: src.row.parent_task_id ? await this.publicOf(tx, src.row.parent_task_id) : null,
            brand: src.brand.publicId,
          },
          null,
        );
        if (container.parent)
          this.requireTaskAction(p, 'record.create', container.parent, { shares: false });
        else this.requireCreateIn(p, container);
        const vis = await this.taskVisibility(tx, p, false);
        // The authorized subtree only (readable, active), within TASK_SUBTREE_MAX.
        const subtree = input.includeSubtasks ? await this.subtreeOf(tx, src.id) : [];
        const readable = subtree.length
          ? new Set(
              (
                await tx.db
                  .selectFrom('core.record as r')
                  .innerJoin('work.task as t', 't.id', 'r.id')
                  .select('t.id')
                  .where(
                    't.id',
                    'in',
                    subtree.map((s) => s.id),
                  )
                  .where(vis.where('r', { project: sql`t.project_id` }))
                  .execute()
              ).map((r) => r.id),
            )
          : new Set<string>();
        const copied = { tasks: 0, checklist_items: 0, criteria: 0, labels: 0, links: 0 };
        const copyOne = async (
          from: LoadedTask,
          c: Awaited<ReturnType<TaskCoreService['resolveContainer']>>,
          title?: string,
        ) => {
          const fields = this.currentFields(from.row, tx);
          const { status: copiedStatus, ...rest } = fields;
          const created = await this.insertTask(
            tx,
            caller,
            p,
            c,
            {
              ...Object.fromEntries(
                Object.entries(rest).filter(([, v]) => v !== null && v !== undefined),
              ),
              ...(TERMINAL.has(from.row.status_category) ? {} : { status: copiedStatus }),
              ...(title ? { title } : {}),
            },
            { lenientStatus: true },
          );
          copied.tasks++;
          const items = await tx.db
            .selectFrom('work.checklist_item')
            .select(['text', 'rank'])
            .where('task_id', '=', from.id)
            .orderBy('rank')
            .execute();
          for (const it of items) {
            await tx.db
              .insertInto('work.checklist_item')
              .values({
                id: newUuidV7(),
                public_id: newPublicId('chk'),
                workspace_id: tx.workspaceId,
                brand_id: c.brand.id,
                task_id: created.id,
                text: it.text,
                rank: it.rank,
              })
              .execute();
            copied.checklist_items++;
          }
          const crit = await tx.db
            .selectFrom('work.criteria_item')
            .select(['kind', 'text', 'rank', 'required'])
            .where('task_id', '=', from.id)
            .orderBy('rank')
            .execute();
          for (const it of crit) {
            await tx.db
              .insertInto('work.criteria_item')
              .values({
                id: newUuidV7(),
                public_id: newPublicId('cri'),
                workspace_id: tx.workspaceId,
                brand_id: c.brand.id,
                owner_kind: 'task',
                project_id: null,
                task_id: created.id,
                kind: it.kind,
                text: it.text,
                rank: it.rank,
                required: it.required,
              })
              .execute();
            copied.criteria++;
          }
          const labels = await tx.db
            .selectFrom('work.task_label')
            .select('label_id')
            .where('task_id', '=', from.id)
            .execute();
          for (const l of labels) {
            await tx.db
              .insertInto('work.task_label')
              .values({
                workspace_id: tx.workspaceId,
                brand_id: c.brand.id,
                task_id: created.id,
                label_id: l.label_id,
                added_by_membership_id: p.membershipId,
              })
              .execute();
            copied.labels++;
          }
          const links = await tx.db
            .selectFrom('relations.record_link')
            .select(['url', 'title', 'rank'])
            .where('source_record_id', '=', from.id)
            .where('target_kind', '=', 'url')
            .orderBy('rank')
            .execute();
          for (const l of links) {
            await tx.db
              .insertInto('relations.record_link')
              .values({
                id: newUuidV7(),
                public_id: newPublicId('lnk'),
                workspace_id: tx.workspaceId,
                source_record_id: created.id,
                target_kind: 'url',
                url: l.url,
                title: l.title,
                rank: l.rank,
                created_by_membership_id: p.membershipId,
              })
              .execute();
            copied.links++;
          }
          return created;
        };
        const root = await copyOne(src, container, input.title);
        let omittedSubtasks = 0;
        const map = new Map<string, string>([[src.id, root.publicId]]);
        for (const s of [...subtree].sort((a, b) => a.depth - b.depth)) {
          const row = await tx.db
            .selectFrom('work.task as t')
            .innerJoin('core.record as r', 'r.id', 't.id')
            .select(['r.public_id', 't.parent_task_id', 'r.lifecycle_state'])
            .where('t.id', '=', s.id)
            .executeTakeFirstOrThrow();
          const parentCopy = row.parent_task_id ? map.get(row.parent_task_id) : undefined;
          if (!readable.has(s.id) || !parentCopy || row.lifecycle_state !== 'active') {
            omittedSubtasks++;
            continue;
          }
          const from = await this.loadTask(tx, p, row.public_id);
          const c = await this.resolveContainer(tx, p, { parent: parentCopy }, null);
          const made = await copyOne(from, c);
          map.set(s.id, made.publicId);
        }
        await this.taskAudit(
          tx,
          caller,
          p,
          'task.duplicated',
          { id: src.id, publicId: src.publicId, brand: src.brand },
          [
            change.plain('copy', null, root.publicId),
            change.plain('copied_tasks', null, copied.tasks),
          ],
        );
        return {
          status: 201,
          ref: { id: root.publicId, type: 'task' },
          data: {
            id: root.publicId,
            type: 'task' as const,
            task: await this.taskView(tx, p, await this.loadTask(tx, p, root.publicId)),
            copied,
            not_copied: [...TaskCoreService.NOT_COPIED],
            omitted_subtasks: omittedSubtasks,
          },
        };
      },
      async (tx, p, ref) => ({
        id: ref.id,
        type: 'task' as const,
        task: await this.taskView(tx, p, await this.loadTask(tx, p, ref.id)),
        copied: { tasks: 0, checklist_items: 0, criteria: 0, labels: 0, links: 0 },
        not_copied: [...TaskCoreService.NOT_COPIED],
        omitted_subtasks: 0,
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Assignees: responsibility, never authority (AZ-22)
  // ---------------------------------------------------------------------------------------------

  async setAssignees(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const input = parseAssignees(body, this.ws.taskAssigneesMax);
    return this.mutate(
      caller,
      'task.assign',
      ws,
      req,
      async (tx, p) => {
        const t = await this.ownedTask(tx, p, tsk);
        const expected = req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : input.version;
        if (expected === undefined) throw new TenancyError('precondition_required');
        await this.setAssigneesIn(tx, caller, p, t, input, expected);
        return {
          status: 200,
          ref: { id: t.publicId, type: 'task' },
          data: await this.taskView(tx, p, await this.loadTask(tx, p, t.publicId)),
        };
      },
      async (tx, p, ref) => this.taskView(tx, p, await this.loadTask(tx, p, ref.id)),
    );
  }

  /**
   * Replaces a task's assignees inside the caller's transaction (7C proposal adapters reuse it):
   * the version check, active-member rule, assignment history, audit, and event are the same as
   * the public command. The task must already be loaded through `ownedTask`.
   */
  protected async setAssigneesIn(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    t: LoadedTask,
    input: { assignees: string[]; primary?: string | null | undefined },
    expected: number,
  ): Promise<void> {
    requireVersion(expected, t.row.version);
    const members: Array<{ id: string; public_id: string }> = [];
    for (const [i, ref] of input.assignees.entries()) {
      const m = await tx.db
        .selectFrom('tenancy.membership')
        .select(['id', 'public_id', 'kind', 'state'])
        .where('public_id', '=', ref)
        .executeTakeFirst();
      if (!m || m.kind !== 'member' || m.state !== 'active')
        throw invalid(
          issue(
            `/assignees/${i}`,
            'not_assignable',
            'Only active members of this workspace can be assigned.',
          ),
        );
      members.push(m);
    }
    const before = await tx.db
      .selectFrom('work.task_assignee as a')
      .innerJoin('tenancy.membership as m', 'm.id', 'a.membership_id')
      .select(['m.id', 'm.public_id', 'a.is_primary'])
      .where('a.task_id', '=', t.id)
      .orderBy('a.is_primary', 'desc')
      .orderBy('a.rank')
      .execute();
    await tx.db.deleteFrom('work.task_assignee').where('task_id', '=', t.id).execute();
    const primary = input.primary ?? null;
    const ranks = members.map((_, i) => String(i + 1).padStart(4, '0'));
    for (const [i, m] of members.entries())
      await tx.db
        .insertInto('work.task_assignee')
        .values({
          workspace_id: tx.workspaceId,
          brand_id: t.brand.id,
          task_id: t.id,
          membership_id: m.id,
          is_primary: m.public_id === primary,
          rank: ranks[i]!,
          assigned_by_membership_id: p.membershipId,
        })
        .execute();
    // Who handed responsibility to whom is an append-only fact (COL-015, 4A).
    await recordAssignmentChange(tx, {
      taskId: t.id,
      actorMembershipId: p.membershipId,
      via: 'assign',
      before: before.map((b) => b.id),
      after: members.map((m) => m.id),
    });
    await this.bumpTask(tx, t, p);
    const fmt = (xs: Array<{ public_id: string; is_primary: boolean }>) =>
      xs.map((x) => (x.is_primary ? `${x.public_id}*` : x.public_id)).join(',') || null;
    await this.taskAudit(tx, caller, p, 'task.assigned', t, [
      change.plain(
        'assignees',
        fmt(before),
        fmt(members.map((m) => ({ public_id: m.public_id, is_primary: m.public_id === primary }))),
      ),
    ]);
    await this.workEvent(
      tx,
      caller,
      p,
      'work.task.assigned',
      { type: 'work.task', id: t.id, sequence: t.row.version + 1 },
      { assignee_membership_ids: members.map((m) => m.id).join(',') || null },
      t.brand.id,
    );
  }

  /** Records a 23505/23514 from task rows as safe issues (duplicates, invariants). */
  protected taskConstraint(err: unknown): never {
    const e = pgErr(err);
    if (e.code === '23505') throw invalid(issue('/', 'duplicate', 'That is already there.'));
    throw err;
  }
}
