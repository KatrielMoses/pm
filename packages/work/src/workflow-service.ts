import { createHash, createHmac } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { rankBetween } from '@pm/contracts/shell';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  decideBrand,
  decideProject,
  decideRecord,
  decideWorkspace,
  findBrand,
  invalid,
  issue,
  levelRank,
  parseIfMatch,
  previewToken,
  recordLevel,
  requireVersion,
  TenancyError,
  verifyPreviewToken,
  type Caller,
  type Level,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import type { LoadedProject, WorkDeps } from './service.ts';
import type { LoadedTask } from './task-core.ts';
import { TaskService } from './task-items.ts';
import { isPublic } from './validation.ts';
import { fieldsForRecord, valuesOf } from './workflow/field-access.ts';
import {
  configChanges,
  statusSnapshot,
  transitionSnapshot,
  workflowSnapshot,
  type Snapshot,
} from './workflow/config-audit.ts';
import { CONTROL_CHARS, hasValue } from './workflow/field-types.ts';
import {
  loadWorkflow,
  platformStatuses,
  primeStatuses,
  resolveWorkflow,
  statusFromKey,
  statusRef,
  statusView,
  TERMINAL,
  type Category,
  type RecordKind,
  type StatusRef,
  type WorkflowRef,
} from './workflow/statuses.ts';
import {
  approvalState,
  decisionsOf,
  evaluateTransition,
  evaluationView,
  proposalFingerprint,
  type ApprovalRow,
  type Evaluation,
  type Requirement,
  type StatusGate,
} from './workflow/transitions.ts';

/**
 * Configurable workflows (Phase 2C, ADR-0015): configuration of workflows, statuses, and
 * transitions at a workspace, brand, or project scope; record transition preview and apply; and
 * approval requests and decisions. Every status change in the product reaches `gateStatusChange`,
 * which runs the one evaluator; preview uses the same evaluator, so preview equals enforcement.
 */

export type ScopeKind = 'workspace' | 'brand' | 'project';
export interface ConfigScope {
  kind: ScopeKind;
  brandId: string | null;
  projectId: string | null;
  brandPublicId: string | null;
  projectPublicId: string | null;
}

const COLOR = /^#[0-9a-f]{6}$/;
const ICON = /^[a-z][a-z_]{1,30}$/;
const CATEGORIES: readonly Category[] = ['planned', 'active', 'paused', 'done', 'cancelled'];
const BUILTINS: Record<RecordKind, readonly string[]> = {
  task: [
    'description',
    'priority',
    'start_date',
    'due_date',
    'deadline',
    'estimate_minutes',
    'remaining_estimate_minutes',
    'assignees',
    'labels',
    'expected_deliverable_type',
  ],
  project: ['description', 'priority', 'start_date', 'target_date', 'owner', 'health', 'budget'],
};
const BUILTIN_LABEL: Record<string, string> = {
  description: 'Description',
  priority: 'Priority',
  start_date: 'Start date',
  due_date: 'Due date',
  deadline: 'Deadline',
  estimate_minutes: 'Estimate',
  remaining_estimate_minutes: 'Remaining estimate',
  assignees: 'Assignees',
  labels: 'Labels',
  expected_deliverable_type: 'Expected deliverable',
  owner: 'Owner',
  target_date: 'Target date',
  health: 'Health',
  budget: 'Budget',
};

/** Objects detailed per configuration audit entry; beyond it the entry records a count. */
const CONFIG_AUDIT_OBJECTS_MAX = 8;
const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

function plain(
  v: unknown,
  path: string,
  max: number,
  opts: { required?: boolean; label?: string } = {},
): string | null {
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw invalid(issue(path, 'required', `Enter ${opts.label ?? 'a value'}.`));
    return null;
  }
  if (typeof v !== 'string') throw invalid(issue(path, 'invalid', 'Enter text.'));
  const t = v.trim().replace(/\s+/g, ' ');
  if (!t && opts.required)
    throw invalid(issue(path, 'required', `Enter ${opts.label ?? 'a value'}.`));
  if ([...t].length > max) throw invalid(issue(path, 'too_long', `Use at most ${max} characters.`));
  if (CONTROL_CHARS.test(t)) throw invalid(issue(path, 'invalid', 'Remove control characters.'));
  return t || null;
}
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], path: string, dflt?: T): T => {
  if ((v === undefined || v === null) && dflt !== undefined) return dflt;
  if (!allowed.includes(v as T))
    throw invalid(issue(path, 'invalid', `Choose one of ${allowed.join(', ')}.`));
  return v as T;
};
const color = (v: unknown, path: string, dflt: string) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'string' || !COLOR.test(v))
    throw invalid(issue(path, 'invalid', 'Choose a color like #1a2b3c.'));
  return v;
};

/** `?scope=workspace`, `brand:br_…`, or `project:prj_…` (also accepted in bodies). */
export function parseScopeRef(v: unknown): { kind: ScopeKind; ref: string | null } {
  if (v === undefined || v === null || v === 'workspace') return { kind: 'workspace', ref: null };
  if (typeof v === 'string') {
    const m = /^(brand|project):(.+)$/.exec(v);
    if (m && isPublic(m[2], m[1] === 'brand' ? 'br' : 'prj'))
      return { kind: m[1] as ScopeKind, ref: m[2]! };
  }
  throw invalid(issue('/scope', 'invalid', 'Choose the workspace, a brand, or a project.'));
}

export class WorkflowService extends TaskService {
  readonly #transitionKey: Buffer;
  readonly #wsTtlMs: number;

  constructor(deps: WorkDeps) {
    super(deps);
    this.#transitionKey = createHmac('sha256', deps.signingKey)
      .update('preview:workflow.transition')
      .digest();
    this.#wsTtlMs = this.ws.transitionPreviewTtlSeconds * 1000;
  }

  // ---------------------------------------------------------------------------------------------
  // Configuration scope (AZ-23): decided at the scope itself; no owner/admin bypass
  // ---------------------------------------------------------------------------------------------

  protected async configScope(
    tx: WorkspaceTransaction,
    p: Principal,
    action: 'workflow.configure' | 'fields.configure',
    scope: unknown,
  ): Promise<ConfigScope> {
    if (p.kind !== 'member') throw new TenancyError('not_found');
    const s = parseScopeRef(scope);
    if (s.kind === 'workspace') {
      const o = decideWorkspace(p, action);
      this.decision(action, o);
      if (!o.allowed) throw new TenancyError(o.code);
      return {
        kind: 'workspace',
        brandId: null,
        projectId: null,
        brandPublicId: null,
        projectPublicId: null,
      };
    }
    if (s.kind === 'brand') {
      const b = await findBrand(tx, p, s.ref);
      const o = decideBrand(p, action, {
        id: b.id,
        isSensitive: b.is_sensitive,
        lifecycleState: b.lifecycle_state,
      });
      this.decision(action, o);
      if (!o.allowed) throw new TenancyError(o.code);
      return {
        kind: 'brand',
        brandId: b.id,
        projectId: null,
        brandPublicId: s.ref,
        projectPublicId: null,
      };
    }
    const prj = await this.loadProject(tx, p, s.ref);
    const o = decideProject(p, action, {
      brand: prj.brand,
      lifecycleState: prj.lifecycleState,
      chain: prj.chain,
    });
    this.decision(action, o);
    if (!o.allowed) throw new TenancyError(o.code);
    return {
      kind: 'project',
      brandId: prj.brand.id,
      projectId: prj.id,
      brandPublicId: prj.brand.publicId,
      projectPublicId: prj.publicId,
    };
  }

  /** The configuration scope of an existing row, re-decided for this caller. */
  protected async rowScope(
    tx: WorkspaceTransaction,
    p: Principal,
    action: 'workflow.configure' | 'fields.configure',
    row: { scope_kind: string; brand_id: string | null; project_id: string | null },
  ): Promise<ConfigScope> {
    if (row.scope_kind === 'workspace') return this.configScope(tx, p, action, 'workspace');
    if (row.scope_kind === 'brand') {
      const b = await tx.db
        .selectFrom('core.record')
        .select('public_id')
        .where('id', '=', row.brand_id!)
        .executeTakeFirstOrThrow();
      return this.configScope(tx, p, action, `brand:${b.public_id}`);
    }
    const r = await tx.db
      .selectFrom('core.record')
      .select('public_id')
      .where('id', '=', row.project_id!)
      .executeTakeFirstOrThrow();
    return this.configScope(tx, p, action, `project:${r.public_id}`);
  }

  protected scopeView(s: ConfigScope) {
    return s.kind === 'workspace'
      ? { kind: 'workspace' as const }
      : s.kind === 'brand'
        ? { kind: 'brand' as const, brand: s.brandPublicId }
        : { kind: 'project' as const, brand: s.brandPublicId, project: s.projectPublicId };
  }

  protected async configAudit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    target: { id: string | null; type: string; publicId: string | null },
    changes: ReturnType<typeof change.plain>[],
    brandId: string | null,
  ) {
    return this.workWriter.write(tx, this.cmd(caller, p, brandId), {
      action,
      target: { recordId: null, type: target.type, publicId: target.publicId },
      changes,
    });
  }

  protected async configEvent(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    type: Parameters<WorkflowService['workEvent']>[3],
    aggregate: { type: string; id: string; sequence: number },
    data: Record<string, string | number | boolean | null>,
    brandId: string | null,
  ) {
    await this.workEvent(tx, caller, p, type, aggregate, data, brandId as string);
  }

  // ---------------------------------------------------------------------------------------------
  // Workflows
  // ---------------------------------------------------------------------------------------------

  /** The audit snapshot of a status or transition (null once deleted). */
  protected async configSnap(
    tx: WorkspaceTransaction,
    entity: 'status' | 'transition',
    id: string,
  ): Promise<Snapshot | null> {
    if (entity === 'status') {
      const st = await tx.db
        .selectFrom('workflow.workflow_status')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return st ? statusSnapshot(st) : null;
    }
    const t = await tx.db
      .selectFrom('workflow.transition')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!t) return null;
    const ends = await this.publicIdsOfStatuses(tx, [t.from_status_id, t.to_status_id]);
    const reqs = await tx.db
      .selectFrom('workflow.transition_requirement')
      .select(['builtin_key', 'definition_id', 'allow_manager_override'])
      .where('transition_id', '=', id)
      .execute();
    const defs = await this.publicIdsOf(
      tx,
      reqs.map((r) => r.definition_id).filter((x): x is string => !!x),
      'workflow.field_definition',
    );
    const appr = await tx.db
      .selectFrom('workflow.transition_approver')
      .select('membership_id')
      .where('transition_id', '=', id)
      .execute();
    const mems = await this.publicIdsOf(
      tx,
      appr.map((a) => a.membership_id),
      'tenancy.membership',
    );
    return transitionSnapshot({
      ...t,
      from: ends.get(t.from_status_id)!,
      to: ends.get(t.to_status_id)!,
      requirements: reqs.map((r) => ({
        ref: r.builtin_key ? `builtin:${r.builtin_key}` : defs.get(r.definition_id!)!,
        override: r.allow_manager_override,
      })),
      approvers: appr.map((a) => mems.get(a.membership_id)!),
    });
  }

  /** Audit changes for a new workflow: its snapshot and its statuses (bounded). */
  protected async creationChanges(tx: WorkspaceTransaction, id: string, scopeKind: string) {
    const w = await tx.db
      .selectFrom('workflow.workflow')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const st = await tx.db
      .selectFrom('workflow.workflow_status')
      .selectAll()
      .where('workflow_id', '=', id)
      .orderBy('rank')
      .execute();
    const out = configChanges('workflow', 'workflow.create', scopeKind, null, workflowSnapshot(w));
    st.slice(0, CONFIG_AUDIT_OBJECTS_MAX).forEach((s, i) =>
      out.push(
        ...configChanges('status', 'workflow.create', scopeKind, null, statusSnapshot(s), i + 1),
      ),
    );
    if (st.length > CONFIG_AUDIT_OBJECTS_MAX)
      out.push(
        change.plain('workflow.objects_not_detailed', null, st.length - CONFIG_AUDIT_OBJECTS_MAX),
      );
    return out;
  }

  protected async publicIdsOfStatuses(tx: WorkspaceTransaction, ids: string[]) {
    const out = new Map<string, string>();
    for (const r of await tx.db
      .selectFrom('workflow.workflow_status')
      .select(['id', 'public_id'])
      .where('id', 'in', ids)
      .execute())
      out.set(r.id, r.public_id);
    return out;
  }

  protected async workflowRow(tx: WorkspaceTransaction, publicId: unknown, lock = false) {
    if (!isPublic(publicId, 'wf')) throw new TenancyError('not_found');
    let q = tx.db.selectFrom('workflow.workflow').selectAll().where('public_id', '=', publicId);
    if (lock) q = q.forUpdate();
    const w = await q.executeTakeFirst();
    if (!w) throw new TenancyError('not_found');
    return w;
  }

  protected async workflowView(
    tx: WorkspaceTransaction,
    w: {
      id: string;
      public_id: string;
      name: string;
      scope_kind: string;
      record_kind: string;
      state: string;
      version: number | string;
    },
    scope: ConfigScope,
  ) {
    const full = await loadWorkflow(tx, w, { includeArchivedStatuses: true });
    const archivedTransitions = await tx.db
      .selectFrom('workflow.transition')
      .select(['public_id'])
      .where('workflow_id', '=', w.id)
      .where('state', '=', 'archived')
      .execute();
    const byId = new Map(full.statuses.map((s) => [s.id, s]));
    const defs = await this.publicIdsOf(
      tx,
      full.transitions.flatMap((t) =>
        t.requirements.map((r) => r.definitionId).filter((x): x is string => !!x),
      ),
      'workflow.field_definition',
    );
    const mems = await this.publicIdsOf(
      tx,
      full.transitions.flatMap((t) => t.approvers),
      'tenancy.membership',
    );
    const inUse = await this.statusesInUse(
      tx,
      full.statuses.map((s) => s.id),
    );
    return {
      id: w.public_id,
      type: 'workflow' as const,
      name: w.name,
      record_kind: w.record_kind,
      scope: this.scopeView(scope),
      state: w.state,
      statuses: full.statuses.map((s) => ({
        ...statusView(s),
        id: s.key,
        icon: s.icon,
        state: s.state,
        in_use: inUse.has(s.id),
      })),
      transitions: full.transitions.map((t) => ({
        id: t.publicId,
        from: byId.get(t.from)?.key ?? null,
        to: byId.get(t.to)?.key ?? null,
        description: t.description,
        confirmation: t.confirmation,
        approval_policy: t.approval,
        allow_self_approval: t.allowSelf,
        requirements: t.requirements.map((r) =>
          r.kind === 'builtin'
            ? { kind: 'builtin', key: r.key, allow_manager_override: r.allowOverride }
            : {
                kind: 'custom',
                field: defs.get(r.definitionId!) ?? null,
                allow_manager_override: r.allowOverride,
              },
        ),
        approvers: t.approvers.map((m) => mems.get(m)).filter(Boolean),
        version: t.version,
      })),
      archived_transitions: archivedTransitions.length,
      version: Number(w.version),
    };
  }

  protected async publicIdsOf(
    tx: WorkspaceTransaction,
    ids: string[],
    table: 'workflow.field_definition' | 'tenancy.membership',
  ) {
    const out = new Map<string, string>();
    const uniq = [...new Set(ids)];
    if (!uniq.length) return out;
    for (const r of await tx.db
      .selectFrom(table)
      .select(['id', 'public_id'])
      .where('id', 'in', uniq)
      .execute())
      out.set(r.id, r.public_id);
    return out;
  }

  protected async statusesInUse(tx: WorkspaceTransaction, ids: string[]) {
    const out = new Set<string>();
    if (!ids.length) return out;
    const t = await tx.db
      .selectFrom('work.task')
      .select(['status_id'])
      .where('status_id', 'in', ids)
      .groupBy('status_id')
      .execute();
    const tp = await tx.db
      .selectFrom('work.task')
      .select(['prior_status_id as status_id'])
      .where('prior_status_id', 'in', ids)
      .groupBy('prior_status_id')
      .execute();
    const pr = await tx.db
      .selectFrom('work.project')
      .select(['status_id'])
      .where('status_id', 'in', ids)
      .groupBy('status_id')
      .execute();
    for (const r of [...t, ...tp, ...pr]) if (r.status_id) out.add(r.status_id);
    return out;
  }

  async listWorkflows(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const scope = await this.configScope(tx, p, 'workflow.configure', query.scope);
      let q = tx.db
        .selectFrom('workflow.workflow')
        .selectAll()
        .where('scope_kind', '=', scope.kind)
        .where((eb) =>
          scope.brandId ? eb('brand_id', '=', scope.brandId) : eb('brand_id', 'is', null),
        )
        .where((eb) =>
          scope.projectId ? eb('project_id', '=', scope.projectId) : eb('project_id', 'is', null),
        );
      if (query.state !== 'all') q = q.where('state', '=', 'active');
      const rows = await q
        .orderBy('record_kind')
        .orderBy('created_at')
        .limit(this.pageLimitMax)
        .execute();
      const data = [];
      for (const w of rows) data.push(await this.workflowView(tx, w, scope));
      // What applies here for each kind (most specific first), for the UI's "inherited" notice.
      const applies = {} as Record<RecordKind, unknown>;
      for (const kind of ['project', 'task'] as const) {
        const wf =
          scope.kind === 'workspace'
            ? null
            : await resolveWorkflow(tx, kind, {
                workspaceId: tx.workspaceId,
                brandId: scope.brandId!,
                projectId: scope.projectId,
              });
        applies[kind] = wf ? { id: wf.publicId, scope_kind: wf.scopeKind, name: wf.name } : null;
      }
      return { data, scope: this.scopeView(scope), applies };
    });
  }

  async getWorkflow(caller: Caller, ws: unknown, wfId: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const w = await this.workflowRow(tx, wfId);
      const scope = await this.rowScope(tx, p, 'workflow.configure', w);
      return this.workflowView(tx, w, scope);
    });
  }

  protected parseStatusInput(v: unknown, path: string, creating: boolean) {
    if (!isObj(v)) throw invalid(issue(path, 'invalid', 'A status needs a name and a category.'));
    for (const k of Object.keys(v))
      if (!['name', 'category', 'color', 'icon', 'description'].includes(k))
        throw invalid(issue(`${path}/${k}`, 'unsupported_field', 'Unknown setting.'));
    if (!creating && v.category !== undefined)
      throw invalid(issue(`${path}/category`, 'immutable', 'A status keeps its category.'));
    const out: {
      name?: string;
      category?: Category;
      color?: string;
      icon?: string | null;
      description?: string | null;
    } = {};
    if (creating || v.name !== undefined)
      out.name = plain(v.name, `${path}/name`, 60, { required: true, label: 'a status name' })!;
    if (creating) out.category = oneOf(v.category, CATEGORIES, `${path}/category`);
    if (creating || v.color !== undefined) out.color = color(v.color, `${path}/color`, '#6b7280');
    if (v.icon !== undefined) {
      if (v.icon !== null && (typeof v.icon !== 'string' || !ICON.test(v.icon)))
        throw invalid(issue(`${path}/icon`, 'invalid', 'Choose an icon.'));
      out.icon = v.icon as string | null;
    }
    if (v.description !== undefined)
      out.description = plain(v.description, `${path}/description`, 500);
    return out;
  }

  async createWorkflow(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    if (!isObj(body)) throw invalid(issue('/', 'invalid', 'Send a workflow.'));
    const kind = oneOf(body.record_kind, ['project', 'task'] as const, '/record_kind');
    const name = plain(body.name, '/name', 80, { required: true, label: 'a workflow name' })!;
    const statuses = Array.isArray(body.statuses) ? body.statuses : [];
    if (statuses.length < 2 || statuses.length > this.ws.workflowStatusesMax)
      throw invalid(
        issue(
          '/statuses',
          'invalid',
          `A workflow has 2 to ${this.ws.workflowStatusesMax} statuses.`,
        ),
      );
    const parsed = statuses.map((s, i) => this.parseStatusInput(s, `/statuses/${i}`, true));
    if (!parsed.some((s) => s.category === 'planned'))
      throw invalid(
        issue(
          '/statuses',
          'planned_required',
          'Include at least one planned status (where new records start).',
        ),
      );
    if (kind === 'task' && !parsed.some((s) => s.category === 'done'))
      throw invalid(
        issue(
          '/statuses',
          'done_required',
          'Include at least one done status (where Complete leads).',
        ),
      );
    const names = parsed.map((s) => norm(s.name!));
    const dup = names.findIndex((n, i) => names.indexOf(n) !== i);
    if (dup >= 0)
      throw invalid(
        issue(`/statuses/${dup}/name`, 'name_taken', 'Each status needs a different name.'),
      );
    return this.mutate(
      caller,
      'workflow.create',
      ws,
      req,
      async (tx, p) => {
        const scope = await this.configScope(tx, p, 'workflow.configure', body.scope);
        const id = newUuidV7();
        const publicId = newPublicId('wf');
        try {
          await tx.db
            .insertInto('workflow.workflow')
            .values({
              id,
              public_id: publicId,
              workspace_id: tx.workspaceId,
              brand_id: scope.brandId,
              project_id: scope.projectId,
              scope_kind: scope.kind,
              record_kind: kind,
              name,
              created_by_membership_id: p.membershipId,
            })
            .execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw new TenancyError('conflict', {
              issues: [
                issue(
                  '/scope',
                  'workflow_exists',
                  `This scope already has an active ${kind} workflow. Edit or archive it.`,
                ),
              ],
            });
          throw e;
        }
        let rank: string | null = null;
        for (const s of parsed) {
          rank = rankBetween(rank, null)!;
          await tx.db
            .insertInto('workflow.workflow_status')
            .values({
              id: newUuidV7(),
              public_id: newPublicId('sts'),
              workspace_id: tx.workspaceId,
              workflow_id: id,
              name: s.name!,
              normalized_name: norm(s.name!),
              description: s.description ?? null,
              category: s.category!,
              color: s.color!,
              icon: s.icon ?? null,
              rank,
            })
            .execute();
        }
        await this.configAudit(
          tx,
          caller,
          p,
          'workflow.created',
          { id, type: 'workflow', publicId },
          await this.creationChanges(tx, id, scope.kind),
          scope.brandId,
        );
        await this.configEvent(
          tx,
          caller,
          p,
          'workflow.workflow.created',
          { type: 'workflow.workflow', id, sequence: 0 },
          { record_kind: kind, scope_kind: scope.kind },
          scope.brandId,
        );
        const w = await this.workflowRow(tx, publicId);
        return {
          status: 201,
          ref: { id: publicId, type: 'workflow' },
          data: await this.workflowView(tx, w, scope),
        };
      },
      async (tx, p, ref) => {
        const w = await this.workflowRow(tx, ref.id);
        return this.workflowView(tx, w, await this.rowScope(tx, p, 'workflow.configure', w));
      },
    );
  }

  /** Locks a workflow for a configuration command; decides the caller at its scope; checks the version. */
  protected async editWorkflow(
    tx: WorkspaceTransaction,
    p: Principal,
    wfId: unknown,
    req: Mutation,
    body: Record<string, unknown>,
  ) {
    const w = await this.workflowRow(tx, wfId, true);
    const scope = await this.rowScope(tx, p, 'workflow.configure', w);
    const expected =
      req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (body.version as number | undefined);
    if (expected === undefined) throw new TenancyError('precondition_required');
    requireVersion(expected, Number(w.version));
    return { w, scope };
  }

  protected async bumpWorkflow(tx: WorkspaceTransaction, id: string) {
    await tx.db
      .updateTable('workflow.workflow')
      .set({ version: sql`version + 1`, updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** One configuration command on a workflow: lock, decide, version, audit, event, view. */
  protected configCommand(
    caller: Caller,
    ws: unknown,
    wfId: unknown,
    body: unknown,
    req: Mutation,
    command: string,
    fn: (
      tx: WorkspaceTransaction,
      p: Principal,
      ctx: {
        w: Awaited<ReturnType<WorkflowService['workflowRow']>>;
        scope: ConfigScope;
        b: Record<string, unknown>;
        /** Records a status or transition's snapshot now; its after state is taken at the end. */
        track: (entity: 'status' | 'transition', id: string) => Promise<void>;
      },
    ) => Promise<{
      audit?: ReturnType<typeof change.plain>[];
      event?: {
        type:
          | 'workflow.workflow.updated'
          | 'workflow.status.created'
          | 'workflow.status.updated'
          | 'workflow.transition.created'
          | 'workflow.transition.updated';
        data: Record<string, string | number | boolean | null>;
      };
    }>,
  ) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      command,
      ws,
      req,
      async (tx, p) => {
        const { w, scope } = await this.editWorkflow(tx, p, wfId, req, b);
        // Before/after snapshots (ADR-0015 W9): the workflow itself and every tracked object.
        const wfBefore = workflowSnapshot(w);
        const tracked = new Map<
          string,
          { entity: 'status' | 'transition'; before: Snapshot | null }
        >();
        const track = async (entity: 'status' | 'transition', id: string) => {
          if (!tracked.has(id))
            tracked.set(id, { entity, before: await this.configSnap(tx, entity, id) });
        };
        const out = await fn(tx, p, { w, scope, b, track });
        await this.bumpWorkflow(tx, w.id);
        const changes = [
          ...configChanges(
            'workflow',
            command,
            scope.kind,
            wfBefore,
            workflowSnapshot(await this.workflowRow(tx, w.public_id)),
          ),
        ];
        const slots = { status: 0, transition: 0 };
        let detailed = 0;
        for (const [id, t] of tracked) {
          if (detailed++ >= CONFIG_AUDIT_OBJECTS_MAX) break;
          changes.push(
            ...configChanges(
              t.entity,
              command,
              scope.kind,
              t.before,
              await this.configSnap(tx, t.entity, id),
              ++slots[t.entity],
            ),
          );
        }
        if (tracked.size > CONFIG_AUDIT_OBJECTS_MAX)
          changes.push(
            change.plain(
              'workflow.objects_not_detailed',
              null,
              tracked.size - CONFIG_AUDIT_OBJECTS_MAX,
            ),
          );
        await this.configAudit(
          tx,
          caller,
          p,
          command,
          { id: w.id, type: 'workflow', publicId: w.public_id },
          [...changes, ...(out.audit ?? [])],
          scope.brandId,
        );
        await this.configEvent(
          tx,
          caller,
          p,
          out.event?.type ?? 'workflow.workflow.updated',
          { type: 'workflow.workflow', id: w.id, sequence: Number(w.version) + 1 },
          out.event?.data ?? {
            changed_fields: command.split('.').pop()!,
            lifecycle_state: w.state,
          },
          scope.brandId,
        );
        const fresh = await this.workflowRow(tx, w.public_id);
        return {
          status: 200,
          ref: { id: w.public_id, type: 'workflow' },
          data: await this.workflowView(tx, fresh, scope),
        };
      },
      async (tx, p, ref) => {
        const w = await this.workflowRow(tx, ref.id);
        return this.workflowView(tx, w, await this.rowScope(tx, p, 'workflow.configure', w));
      },
    );
  }

  updateWorkflow(caller: Caller, ws: unknown, wfId: unknown, body: unknown, req: Mutation) {
    return this.configCommand(
      caller,
      ws,
      wfId,
      body,
      req,
      'workflow.update',
      async (tx, _p, { w, b }) => {
        const name = plain(b.name, '/name', 80, { required: true, label: 'a workflow name' })!;
        await tx.db.updateTable('workflow.workflow').set({ name }).where('id', '=', w.id).execute();
        return {
          event: {
            type: 'workflow.workflow.updated',
            data: { changed_fields: 'name', lifecycle_state: w.state },
          },
        };
      },
    );
  }

  /** Archive is reversible; broader workflows (or the platform default) apply while archived. */
  setWorkflowState(
    caller: Caller,
    ws: unknown,
    wfId: unknown,
    body: unknown,
    req: Mutation,
    state: 'active' | 'archived',
  ) {
    return this.configCommand(
      caller,
      ws,
      wfId,
      body,
      req,
      state === 'archived' ? 'workflow.archive' : 'workflow.unarchive',
      async (tx, _p, { w }) => {
        if (w.state === state) return { audit: [] };
        try {
          await tx.db
            .updateTable('workflow.workflow')
            .set({ state })
            .where('id', '=', w.id)
            .execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw new TenancyError('conflict', {
              issues: [
                issue(
                  '/',
                  'workflow_exists',
                  'Another active workflow already applies at this scope.',
                ),
              ],
            });
          throw e;
        }
        return {
          event: {
            type: 'workflow.workflow.updated',
            data: { changed_fields: 'state', lifecycle_state: state },
          },
        };
      },
    );
  }

  /** Purge: refused while any record uses one of its statuses or an approval refers to it. */
  async deleteWorkflow(caller: Caller, ws: unknown, wfId: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'workflow.delete',
      ws,
      req,
      async (tx, p) => {
        const { w, scope } = await this.editWorkflow(tx, p, wfId, req, {});
        if (w.state !== 'archived')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'archive_first', 'Archive the workflow before deleting it.')],
          });
        const statuses = await tx.db
          .selectFrom('workflow.workflow_status')
          .select('id')
          .where('workflow_id', '=', w.id)
          .execute();
        const used = await this.statusesInUse(
          tx,
          statuses.map((s) => s.id),
        );
        const approvals = await tx.db
          .selectFrom('workflow.approval_request')
          .select('id')
          .where('workflow_id', '=', w.id)
          .limit(1)
          .execute();
        if (used.size || approvals.length)
          throw new TenancyError('conflict', {
            issues: [
              issue(
                '/',
                'in_use',
                'Records or approvals still use this workflow. Migrate them first.',
              ),
            ],
          });
        const trs = await tx.db
          .selectFrom('workflow.transition')
          .select('id')
          .where('workflow_id', '=', w.id)
          .execute();
        if (trs.length)
          await tx.db.deleteFrom('workflow.transition').where('workflow_id', '=', w.id).execute();
        if (statuses.length)
          await tx.db
            .deleteFrom('workflow.workflow_status')
            .where('workflow_id', '=', w.id)
            .execute();
        await tx.db.deleteFrom('workflow.workflow').where('id', '=', w.id).execute();
        await this.configAudit(
          tx,
          caller,
          p,
          'workflow.deleted',
          { id: w.id, type: 'workflow', publicId: w.public_id },
          [
            ...configChanges('workflow', 'workflow.delete', scope.kind, workflowSnapshot(w), null),
            change.plain('workflow.deleted_statuses', null, statuses.length),
            change.plain('workflow.deleted_transitions', null, trs.length),
          ],
          scope.brandId,
        );
        return {
          status: 200,
          ref: { id: w.public_id, type: 'workflow' },
          data: { id: w.public_id, type: 'workflow', deleted: true },
        };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'workflow', deleted: true }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Statuses
  // ---------------------------------------------------------------------------------------------

  protected async statusRow(tx: WorkspaceTransaction, workflowId: string, stsId: unknown) {
    if (!isPublic(stsId, 'sts')) throw new TenancyError('not_found');
    const s = await tx.db
      .selectFrom('workflow.workflow_status')
      .selectAll()
      .where('workflow_id', '=', workflowId)
      .where('public_id', '=', stsId)
      .executeTakeFirst();
    if (!s) throw new TenancyError('not_found');
    return s;
  }

  addStatus(caller: Caller, ws: unknown, wfId: unknown, body: unknown, req: Mutation) {
    return this.configCommand(
      caller,
      ws,
      wfId,
      body,
      req,
      'workflow.add_status',
      async (tx, _p, { w, b, track }) => {
        const s = this.parseStatusInput(b.status, '/status', true);
        const count = await tx.db
          .selectFrom('workflow.workflow_status')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('workflow_id', '=', w.id)
          .where('state', '=', 'active')
          .executeTakeFirstOrThrow();
        if (Number(count.n) >= this.ws.workflowStatusesMax)
          throw new TenancyError('limit_exceeded', {
            issues: [
              issue(
                '/status',
                'limit',
                `A workflow has at most ${this.ws.workflowStatusesMax} statuses.`,
              ),
            ],
          });
        const rank = await this.nextRank(
          tx,
          'workflow.workflow_status',
          (q) => q.where('workflow_id', '=', w.id),
          'last',
        );
        const sid = newUuidV7();
        await track('status', sid);
        try {
          await tx.db
            .insertInto('workflow.workflow_status')
            .values({
              id: sid,
              public_id: newPublicId('sts'),
              workspace_id: tx.workspaceId,
              workflow_id: w.id,
              name: s.name!,
              normalized_name: norm(s.name!),
              description: s.description ?? null,
              category: s.category!,
              color: s.color!,
              icon: s.icon ?? null,
              rank,
            })
            .execute();
        } catch (e) {
          throw nameTaken(e, '/status/name');
        }
        return {
          event: {
            type: 'workflow.status.created',
            data: { workflow_id: w.id, category: s.category! },
          },
        };
      },
    );
  }

  updateStatus(
    caller: Caller,
    ws: unknown,
    wfId: unknown,
    stsId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    return this.configCommand(
      caller,
      ws,
      wfId,
      body,
      req,
      'workflow.update_status',
      async (tx, _p, { w, b, track }) => {
        const st = await this.statusRow(tx, w.id, stsId);
        await track('status', st.id);
        const s = this.parseStatusInput(b.status, '/status', false);
        const set: Record<string, unknown> = { updated_at: new Date(), version: sql`version + 1` };
        if (s.name !== undefined)
          Object.assign(set, { name: s.name, normalized_name: norm(s.name) });
        if (s.color !== undefined) set.color = s.color;
        if (s.icon !== undefined) set.icon = s.icon;
        if (s.description !== undefined) set.description = s.description;
        try {
          await tx.db
            .updateTable('workflow.workflow_status')
            .set(set)
            .where('id', '=', st.id)
            .execute();
        } catch (e) {
          throw nameTaken(e, '/status/name');
        }
        return {
          event: {
            type: 'workflow.status.updated',
            data: {
              workflow_id: w.id,
              changed_fields: Object.keys(s).sort().join(','),
              lifecycle_state: st.state,
            },
          },
        };
      },
    );
  }

  moveStatus(
    caller: Caller,
    ws: unknown,
    wfId: unknown,
    stsId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    return this.configCommand(
      caller,
      ws,
      wfId,
      body,
      req,
      'workflow.move_status',
      async (tx, _p, { w, b, track }) => {
        const st = await this.statusRow(tx, w.id, stsId);
        await track('status', st.id);
        const after =
          b.after === null
            ? null
            : b.after === undefined
              ? 'last'
              : (await this.statusRow(tx, w.id, b.after)).id;
        const rank = await this.nextRank(
          tx,
          'workflow.workflow_status',
          (q) => q.where('workflow_id', '=', w.id).where('id', '<>', st.id),
          after,
        );
        await tx.db
          .updateTable('workflow.workflow_status')
          .set({ rank, updated_at: new Date(), version: sql`version + 1` })
          .where('id', '=', st.id)
          .execute();
        return {
          event: {
            type: 'workflow.status.updated',
            data: { workflow_id: w.id, changed_fields: 'rank', lifecycle_state: st.state },
          },
        };
      },
    );
  }

  /** Archive keeps records' statuses; new choices no longer offer it. Unarchive restores it. */
  setStatusState(
    caller: Caller,
    ws: unknown,
    wfId: unknown,
    stsId: unknown,
    body: unknown,
    req: Mutation,
    state: 'active' | 'archived',
  ) {
    return this.configCommand(
      caller,
      ws,
      wfId,
      body,
      req,
      state === 'archived' ? 'workflow.archive_status' : 'workflow.unarchive_status',
      async (tx, _p, { w, track }) => {
        const st = await this.statusRow(tx, w.id, stsId);
        await track('status', st.id);
        if (state === 'archived') {
          const left = await tx.db
            .selectFrom('workflow.workflow_status')
            .select(['category'])
            .where('workflow_id', '=', w.id)
            .where('state', '=', 'active')
            .where('id', '<>', st.id)
            .execute();
          if (!left.some((x) => x.category === 'planned'))
            throw new TenancyError('conflict', {
              issues: [issue('/', 'planned_required', 'Keep at least one planned status active.')],
            });
          if (w.record_kind === 'task' && !left.some((x) => x.category === 'done'))
            throw new TenancyError('conflict', {
              issues: [issue('/', 'done_required', 'Keep at least one done status active.')],
            });
        }
        try {
          await tx.db
            .updateTable('workflow.workflow_status')
            .set({ state, updated_at: new Date(), version: sql`version + 1` })
            .where('id', '=', st.id)
            .execute();
        } catch (e) {
          throw nameTaken(e, '/');
        }
        if (state === 'archived') {
          const edges = await tx.db
            .selectFrom('workflow.transition')
            .select('id')
            .where('workflow_id', '=', w.id)
            .where((eb) =>
              eb.or([eb('from_status_id', '=', st.id), eb('to_status_id', '=', st.id)]),
            )
            .where('state', '=', 'active')
            .execute();
          for (const e of edges) await track('transition', e.id);
          await tx.db
            .updateTable('workflow.transition')
            .set({ state: 'archived', updated_at: new Date(), version: sql`version + 1` })
            .where('workflow_id', '=', w.id)
            .where((eb) =>
              eb.or([eb('from_status_id', '=', st.id), eb('to_status_id', '=', st.id)]),
            )
            .where('state', '=', 'active')
            .execute();
        }
        return {
          event: {
            type: 'workflow.status.updated',
            data: { workflow_id: w.id, changed_fields: 'state', lifecycle_state: state },
          },
        };
      },
    );
  }

  /** Delete: refused while records use the status (archive it instead, W3). */
  deleteStatus(
    caller: Caller,
    ws: unknown,
    wfId: unknown,
    stsId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    return this.configCommand(
      caller,
      ws,
      wfId,
      body,
      req,
      'workflow.delete_status',
      async (tx, _p, { w, track }) => {
        const st = await this.statusRow(tx, w.id, stsId);
        await track('status', st.id);
        const used = await this.statusesInUse(tx, [st.id]);
        const edges = await tx.db
          .selectFrom('workflow.transition')
          .select('id')
          .where((eb) => eb.or([eb('from_status_id', '=', st.id), eb('to_status_id', '=', st.id)]))
          .execute();
        const approvals = edges.length
          ? await tx.db
              .selectFrom('workflow.approval_request')
              .select('id')
              .where(
                'transition_id',
                'in',
                edges.map((e) => e.id),
              )
              .limit(1)
              .execute()
          : [];
        if (used.size || approvals.length)
          throw new TenancyError('conflict', {
            issues: [
              issue('/', 'in_use', 'Records use this status. Archive it, or migrate them first.'),
            ],
          });
        for (const e of edges) await track('transition', e.id);
        if (edges.length)
          await tx.db
            .deleteFrom('workflow.transition')
            .where(
              'id',
              'in',
              edges.map((e) => e.id),
            )
            .execute();
        await tx.db.deleteFrom('workflow.workflow_status').where('id', '=', st.id).execute();
        return {
          event: {
            type: 'workflow.status.updated',
            data: { workflow_id: w.id, changed_fields: 'deleted', lifecycle_state: 'deleted' },
          },
        };
      },
    );
  }

  /**
   * Migrates records from one status to another status of the same category in a bounded batch
   * (FIELD_VALUE_BULK_MAX). Only records the caller can read move; the response reports how many
   * remain, so a manager repeats until none do. Same category keeps completion semantics intact.
   */
  async migrateStatus(
    caller: Caller,
    ws: unknown,
    wfId: unknown,
    stsId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'workflow.migrate_status',
      ws,
      req,
      async (tx, p) => {
        const w = await this.workflowRow(tx, wfId);
        const scope = await this.rowScope(tx, p, 'workflow.configure', w);
        const from = await this.statusRow(tx, w.id, stsId);
        const target = isPublic(b.to, 'sts') ? await this.statusRow(tx, w.id, b.to) : null;
        if (!target || target.state !== 'active' || target.id === from.id)
          throw invalid(
            issue('/to', 'invalid_status', 'Choose another active status of this workflow.'),
          );
        if (target.category !== from.category)
          throw invalid(
            issue('/to', 'category_mismatch', 'Migrate to a status of the same category.'),
          );
        const table = w.record_kind === 'task' ? 'work.task' : 'work.project';
        const vis = await this.taskVisibility(tx, p, false);
        const rows = await sql<{ id: string }>`
          SELECT t.id FROM ${sql.table(table)} t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
           WHERE t.status_id = ${from.id} AND ${vis.where('r', { project: w.record_kind === 'task' ? sql`t.project_id` : sql`t.id` })}
           ORDER BY t.id LIMIT ${this.ws.fieldValueBulkMax} FOR UPDATE OF t`.execute(tx.db);
        const ids = rows.rows.map((r) => r.id);
        if (ids.length) {
          await sql`UPDATE ${sql.table(table)} SET status_id = ${target.id}, version = version + 1, updated_at = now() WHERE id = ANY(${ids}::uuid[])`.execute(
            tx.db,
          );
          await tx.db
            .updateTable('core.record')
            .set({ version: sql`version + 1` })
            .where('id', 'in', ids)
            .execute();
        }
        const left = await sql<{
          n: string;
        }>`SELECT count(*) AS n FROM ${sql.table(table)} WHERE status_id = ${from.id}`.execute(
          tx.db,
        );
        await this.configAudit(
          tx,
          caller,
          p,
          'workflow.status_migrated',
          { id: w.id, type: 'workflow', publicId: w.public_id },
          [
            change.plain('status.operation', null, 'workflow.migrate_status'),
            change.plain('status.migrated_from', null, from.public_id),
            change.plain('status.migrated_to', null, target.public_id),
            change.plain('status.records_migrated', null, ids.length),
          ],
          scope.brandId,
        );
        return {
          status: 200,
          ref: { id: w.public_id, type: 'workflow' },
          data: {
            id: w.public_id,
            type: 'workflow',
            migrated: ids.length,
            remaining: Number(left.rows[0]?.n ?? 0),
          },
        };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'workflow', migrated: 0, remaining: 0 }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------------------------------------

  protected async parseTransitionInput(
    tx: WorkspaceTransaction,
    w: { id: string; record_kind: string },
    v: unknown,
    creating: boolean,
  ) {
    if (!isObj(v)) throw invalid(issue('/transition', 'invalid', 'Send a transition.'));
    for (const k of Object.keys(v))
      if (
        ![
          'from',
          'to',
          'description',
          'confirmation',
          'approval_policy',
          'allow_self_approval',
          'requirements',
          'approvers',
        ].includes(k)
      )
        throw invalid(issue(`/transition/${k}`, 'unsupported_field', 'Unknown setting.'));
    const out: Record<string, unknown> = {};
    if (creating) {
      out.from = (
        await this.statusRow(tx, w.id, v.from).catch(() => {
          throw invalid(
            issue('/transition/from', 'invalid_status', 'Choose a status of this workflow.'),
          );
        })
      ).id;
      out.to = (
        await this.statusRow(tx, w.id, v.to).catch(() => {
          throw invalid(
            issue('/transition/to', 'invalid_status', 'Choose a status of this workflow.'),
          );
        })
      ).id;
      if (out.from === out.to)
        throw invalid(issue('/transition/to', 'invalid', 'Choose a different status.'));
    }
    if (creating || v.description !== undefined)
      out.description = plain(v.description, '/transition/description', 500);
    if (creating || v.confirmation !== undefined)
      out.confirmation = oneOf(
        v.confirmation,
        ['none', 'confirm', 'step_up'] as const,
        '/transition/confirmation',
        'none',
      );
    if (creating || v.approval_policy !== undefined)
      out.approval = oneOf(
        v.approval_policy,
        ['none', 'one_manager', 'all_named_approvers'] as const,
        '/transition/approval_policy',
        'none',
      );
    if (creating || v.allow_self_approval !== undefined) {
      if (v.allow_self_approval !== undefined && typeof v.allow_self_approval !== 'boolean')
        throw invalid(issue('/transition/allow_self_approval', 'invalid', 'Choose yes or no.'));
      out.allowSelf = v.allow_self_approval === true;
    }
    if (creating || v.requirements !== undefined) {
      const list = v.requirements ?? [];
      if (!Array.isArray(list) || list.length > this.ws.transitionRequirementsMax)
        throw invalid(
          issue(
            '/transition/requirements',
            'invalid',
            `At most ${this.ws.transitionRequirementsMax} required fields.`,
          ),
        );
      const reqs: Array<{
        kind: 'builtin' | 'custom';
        key: string | null;
        def: string | null;
        override: boolean;
      }> = [];
      for (const [i, r] of list.entries()) {
        const path = `/transition/requirements/${i}`;
        if (!isObj(r)) throw invalid(issue(path, 'invalid', 'Choose a field.'));
        const override = r.allow_manager_override === true;
        if (typeof r.builtin === 'string') {
          if (!BUILTINS[w.record_kind as RecordKind].includes(r.builtin))
            throw invalid(
              issue(`${path}/builtin`, 'invalid', 'Choose a field of this record kind.'),
            );
          reqs.push({ kind: 'builtin', key: r.builtin, def: null, override });
        } else if (isPublic(r.field, 'fld')) {
          const d = await tx.db
            .selectFrom('workflow.field_definition')
            .select(['id', 'state', 'field_type', 'applies_to_project', 'applies_to_task'])
            .where('public_id', '=', r.field)
            .executeTakeFirst();
          if (
            !d ||
            d.state !== 'active' ||
            d.field_type === 'formula' ||
            !(w.record_kind === 'task' ? d.applies_to_task : d.applies_to_project)
          )
            throw invalid(
              issue(
                `${path}/field`,
                'invalid',
                'Choose an active, editable field of this record kind.',
              ),
            );
          reqs.push({ kind: 'custom', key: null, def: d.id, override });
        } else throw invalid(issue(path, 'invalid', 'Choose a field.'));
      }
      const keys = reqs.map((r) => r.key ?? r.def);
      if (new Set(keys).size !== keys.length)
        throw invalid(
          issue('/transition/requirements', 'duplicate', 'Each field is required once.'),
        );
      out.requirements = reqs;
    }
    if (creating || v.approvers !== undefined) {
      const list = v.approvers ?? [];
      if (!Array.isArray(list) || list.length > this.ws.transitionApproversMax)
        throw invalid(
          issue(
            '/transition/approvers',
            'invalid',
            `At most ${this.ws.transitionApproversMax} approvers.`,
          ),
        );
      const ids: string[] = [];
      for (const [i, m] of list.entries())
        ids.push((await this.memberByPublic(tx, m as string, `/transition/approvers/${i}`)).id);
      if (new Set(ids).size !== ids.length)
        throw invalid(issue('/transition/approvers', 'duplicate', 'Name each approver once.'));
      out.approvers = ids;
    }
    return out as {
      from?: string;
      to?: string;
      description?: string | null;
      confirmation?: 'none' | 'confirm' | 'step_up';
      approval?: 'none' | 'one_manager' | 'all_named_approvers';
      allowSelf?: boolean;
      requirements?: Array<{
        kind: 'builtin' | 'custom';
        key: string | null;
        def: string | null;
        override: boolean;
      }>;
      approvers?: string[];
    };
  }

  protected async writeTransitionChildren(
    tx: WorkspaceTransaction,
    transitionId: string,
    t: Awaited<ReturnType<WorkflowService['parseTransitionInput']>>,
  ) {
    if (t.requirements) {
      await tx.db
        .deleteFrom('workflow.transition_requirement')
        .where('transition_id', '=', transitionId)
        .execute();
      let rank: string | null = null;
      for (const r of t.requirements) {
        rank = rankBetween(rank, null)!;
        await tx.db
          .insertInto('workflow.transition_requirement')
          .values({
            id: newUuidV7(),
            workspace_id: tx.workspaceId,
            transition_id: transitionId,
            field_kind: r.kind,
            builtin_key: r.key,
            definition_id: r.def,
            allow_manager_override: r.override,
            rank,
          })
          .execute();
      }
    }
    if (t.approvers) {
      await tx.db
        .deleteFrom('workflow.transition_approver')
        .where('transition_id', '=', transitionId)
        .execute();
      let rank: string | null = null;
      for (const m of t.approvers) {
        rank = rankBetween(rank, null)!;
        await tx.db
          .insertInto('workflow.transition_approver')
          .values({
            workspace_id: tx.workspaceId,
            transition_id: transitionId,
            membership_id: m,
            rank,
          })
          .execute();
      }
    }
  }

  protected checkApprovalShape(policy: string, approvers: number) {
    if (policy === 'all_named_approvers' && approvers === 0)
      throw invalid(issue('/transition/approvers', 'required', 'Name at least one approver.'));
    if (policy !== 'all_named_approvers' && approvers > 0)
      throw invalid(
        issue(
          '/transition/approvers',
          'invalid',
          'Named approvers apply only to all_named_approvers.',
        ),
      );
  }

  addTransition(caller: Caller, ws: unknown, wfId: unknown, body: unknown, req: Mutation) {
    return this.configCommand(
      caller,
      ws,
      wfId,
      body,
      req,
      'workflow.add_transition',
      async (tx, _p, { w, b, track }) => {
        const t = await this.parseTransitionInput(tx, w, b.transition, true);
        this.checkApprovalShape(t.approval!, t.approvers!.length);
        const n = await tx.db
          .selectFrom('workflow.transition')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('workflow_id', '=', w.id)
          .where('state', '=', 'active')
          .executeTakeFirstOrThrow();
        if (Number(n.n) >= this.ws.workflowTransitionsMax)
          throw new TenancyError('limit_exceeded', {
            issues: [
              issue(
                '/transition',
                'limit',
                `A workflow has at most ${this.ws.workflowTransitionsMax} transitions.`,
              ),
            ],
          });
        const st = await tx.db
          .selectFrom('workflow.workflow_status')
          .select(['id', 'state'])
          .where('id', 'in', [t.from!, t.to!])
          .execute();
        if (st.some((s) => s.state !== 'active'))
          throw invalid(issue('/transition', 'archived_status', 'Both statuses must be active.'));
        const id = newUuidV7();
        await track('transition', id);
        const rank = await this.nextRank(
          tx,
          'workflow.transition',
          (q) => q.where('workflow_id', '=', w.id),
          'last',
        );
        try {
          await tx.db
            .insertInto('workflow.transition')
            .values({
              id,
              public_id: newPublicId('trn'),
              workspace_id: tx.workspaceId,
              workflow_id: w.id,
              from_status_id: t.from!,
              to_status_id: t.to!,
              description: t.description ?? null,
              rank,
              confirmation_tier: t.confirmation!,
              approval_policy: t.approval!,
              allow_self_approval: t.allowSelf!,
            })
            .execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw new TenancyError('conflict', {
              issues: [issue('/transition', 'duplicate', 'This transition already exists.')],
            });
          throw e;
        }
        await this.writeTransitionChildren(tx, id, t);
        return {
          event: {
            type: 'workflow.transition.created',
            data: { workflow_id: w.id, approval_policy: t.approval! },
          },
        };
      },
    );
  }

  updateTransition(
    caller: Caller,
    ws: unknown,
    wfId: unknown,
    trnId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    return this.configCommand(
      caller,
      ws,
      wfId,
      body,
      req,
      'workflow.update_transition',
      async (tx, _p, { w, b, track }) => {
        const tr = await this.transitionRow(tx, w.id, trnId);
        await track('transition', tr.id);
        const t = await this.parseTransitionInput(tx, w, b.transition, false);
        const policy = t.approval ?? tr.approval_policy;
        const approvers =
          t.approvers ??
          (
            await tx.db
              .selectFrom('workflow.transition_approver')
              .select('membership_id')
              .where('transition_id', '=', tr.id)
              .execute()
          ).map((x) => x.membership_id);
        this.checkApprovalShape(policy, approvers.length);
        const set: Record<string, unknown> = { updated_at: new Date(), version: sql`version + 1` };
        if (t.description !== undefined) set.description = t.description;
        if (t.confirmation !== undefined) set.confirmation_tier = t.confirmation;
        if (t.approval !== undefined) set.approval_policy = t.approval;
        if (t.allowSelf !== undefined) set.allow_self_approval = t.allowSelf;
        if (set.allow_self_approval && policy === 'none') set.allow_self_approval = false;
        await tx.db.updateTable('workflow.transition').set(set).where('id', '=', tr.id).execute();
        await this.writeTransitionChildren(tx, tr.id, t);
        return {
          event: {
            type: 'workflow.transition.updated',
            data: {
              workflow_id: w.id,
              changed_fields: Object.keys(t).sort().join(','),
              lifecycle_state: tr.state,
            },
          },
        };
      },
    );
  }

  protected async transitionRow(tx: WorkspaceTransaction, workflowId: string, trnId: unknown) {
    if (!isPublic(trnId, 'trn')) throw new TenancyError('not_found');
    const t = await tx.db
      .selectFrom('workflow.transition')
      .selectAll()
      .where('workflow_id', '=', workflowId)
      .where('public_id', '=', trnId)
      .executeTakeFirst();
    if (!t) throw new TenancyError('not_found');
    return t;
  }

  setTransitionState(
    caller: Caller,
    ws: unknown,
    wfId: unknown,
    trnId: unknown,
    body: unknown,
    req: Mutation,
    state: 'active' | 'archived',
  ) {
    return this.configCommand(
      caller,
      ws,
      wfId,
      body,
      req,
      state === 'archived' ? 'workflow.archive_transition' : 'workflow.unarchive_transition',
      async (tx, _p, { w, track }) => {
        const tr = await this.transitionRow(tx, w.id, trnId);
        await track('transition', tr.id);
        if (state === 'active') {
          const st = await tx.db
            .selectFrom('workflow.workflow_status')
            .select('state')
            .where('id', 'in', [tr.from_status_id, tr.to_status_id])
            .execute();
          if (st.some((s) => s.state !== 'active'))
            throw new TenancyError('conflict', {
              issues: [issue('/', 'archived_status', 'Unarchive both statuses first.')],
            });
        }
        try {
          await tx.db
            .updateTable('workflow.transition')
            .set({ state, updated_at: new Date(), version: sql`version + 1` })
            .where('id', '=', tr.id)
            .execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw new TenancyError('conflict', {
              issues: [
                issue('/', 'duplicate', 'An active transition already connects these statuses.'),
              ],
            });
          throw e;
        }
        return {
          event: {
            type: 'workflow.transition.updated',
            data: { workflow_id: w.id, changed_fields: 'state', lifecycle_state: state },
          },
        };
      },
    );
  }

  moveTransition(
    caller: Caller,
    ws: unknown,
    wfId: unknown,
    trnId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    return this.configCommand(
      caller,
      ws,
      wfId,
      body,
      req,
      'workflow.move_transition',
      async (tx, _p, { w, b, track }) => {
        const tr = await this.transitionRow(tx, w.id, trnId);
        await track('transition', tr.id);
        const after =
          b.after === null
            ? null
            : b.after === undefined
              ? 'last'
              : (await this.transitionRow(tx, w.id, b.after)).id;
        const rank = await this.nextRank(
          tx,
          'workflow.transition',
          (q) => q.where('workflow_id', '=', w.id).where('id', '<>', tr.id),
          after,
        );
        await tx.db
          .updateTable('workflow.transition')
          .set({ rank, updated_at: new Date(), version: sql`version + 1` })
          .where('id', '=', tr.id)
          .execute();
        return {
          event: {
            type: 'workflow.transition.updated',
            data: { workflow_id: w.id, changed_fields: 'rank', lifecycle_state: tr.state },
          },
        };
      },
    );
  }

  /** Delete: only when no approval request refers to it (archive keeps the history otherwise). */
  deleteTransition(
    caller: Caller,
    ws: unknown,
    wfId: unknown,
    trnId: unknown,
    body: unknown,
    req: Mutation,
  ) {
    return this.configCommand(
      caller,
      ws,
      wfId,
      body,
      req,
      'workflow.delete_transition',
      async (tx, _p, { w, track }) => {
        const tr = await this.transitionRow(tx, w.id, trnId);
        await track('transition', tr.id);
        const used = await tx.db
          .selectFrom('workflow.approval_request')
          .select('id')
          .where('transition_id', '=', tr.id)
          .limit(1)
          .execute();
        if (used.length)
          throw new TenancyError('conflict', {
            issues: [
              issue('/', 'in_use', 'Approvals refer to this transition. Archive it instead.'),
            ],
          });
        await tx.db.deleteFrom('workflow.transition').where('id', '=', tr.id).execute();
        return {
          event: {
            type: 'workflow.transition.updated',
            data: { workflow_id: w.id, changed_fields: 'deleted', lifecycle_state: 'deleted' },
          },
        };
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Records: the one gate, previews, apply
  // ---------------------------------------------------------------------------------------------

  /** Loads a project or task with its level and decision facts (not_found when unreadable). */
  protected async workRecord(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    lock = false,
  ) {
    if (isPublic(publicId, 'prj')) {
      const prj: LoadedProject = await this.loadProject(tx, p, publicId, { lock });
      return {
        kind: 'project' as const,
        id: prj.id,
        publicId: prj.publicId,
        version: prj.row.version,
        brandId: prj.brand.id,
        projectId: prj.id,
        statusId: prj.row.status_id,
        level: prj.level,
        facts: {
          brand: prj.brand,
          lifecycleState: prj.lifecycleState,
          shareLevel: null,
          projectChain: prj.chain,
        },
        merged: {
          ...prj.row,
          owner: prj.row.owner_membership_id,
          description: prj.row.description_rich,
        } as Record<string, unknown>,
        loaded: prj,
      };
    }
    if (isPublic(publicId, 'tsk')) {
      const t: LoadedTask = await this.loadTask(tx, p, publicId, { lock });
      return {
        kind: 'task' as const,
        id: t.id,
        publicId: t.publicId,
        version: t.row.version,
        brandId: t.brand.id,
        projectId: t.row.project_id,
        statusId: t.row.status_id,
        level: t.level,
        facts: {
          brand: t.brand,
          lifecycleState: t.lifecycleState,
          shareLevel: null,
          projectChain: t.chain,
        },
        merged: this.currentFields(t.row, tx),
        loaded: t,
      };
    }
    throw new TenancyError('not_found');
  }

  /** Presence of one requirement on the final merged record, as this viewer may know it. */
  protected async presenceFor(tx: WorkspaceTransaction, p: Principal, g: StatusGate) {
    const level = recordLevel(p, g.facts);
    const fields = await fieldsForRecord(
      tx,
      p,
      { id: g.record.id, kind: g.kind, brandId: g.record.brandId, projectId: g.record.projectId },
      level,
    );
    const byId = new Map(fields.map((f) => [f.def.id, f]));
    const values = await valuesOf(tx, g.record.id);
    let counts = g.counts;
    if (!counts && g.kind === 'task') {
      const a = await tx.db
        .selectFrom('work.task_assignee')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('task_id', '=', g.record.id)
        .executeTakeFirstOrThrow();
      const l = await tx.db
        .selectFrom('work.task_label')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('task_id', '=', g.record.id)
        .executeTakeFirstOrThrow();
      counts = { assignees: Number(a.n), labels: Number(l.n) };
    }
    const m = g.merged;
    return (r: Requirement) => {
      if (r.kind === 'builtin') {
        const v =
          r.key === 'assignees'
            ? (counts?.assignees ?? 0) > 0
            : r.key === 'labels'
              ? (counts?.labels ?? 0) > 0
              : r.key === 'priority'
                ? !!m.priority && m.priority !== 'none'
                : r.key === 'budget'
                  ? m.budget_amount !== null && m.budget_amount !== undefined
                  : r.key === 'owner'
                    ? !!m.owner
                    : hasValue(m[r.key]) && !(r.key === 'description' && m[r.key] === null);
        return {
          present: v,
          hidden: false,
          pointer: `/changes/${r.key}`,
          label: BUILTIN_LABEL[r.key] ?? r.key,
        };
      }
      const f = byId.get(r.definitionId!);
      const value = values.get(r.definitionId!)?.value;
      if (!f || !f.readable)
        return { present: hasValue(value), hidden: true, pointer: '/fields', label: '' };
      return {
        present: hasValue(value),
        hidden: false,
        pointer: `/fields/${f.def.public_id}`,
        label: f.def.name,
      };
    };
  }

  protected evaluate(
    tx: WorkspaceTransaction,
    p: Principal,
    g: StatusGate,
    presence: (r: Requirement) => ReturnType<Awaited<ReturnType<WorkflowService['presenceFor']>>>,
  ) {
    void tx;
    return evaluateTransition({
      kind: g.kind,
      wf: g.wf,
      from: g.from,
      to: g.to,
      intent: g.intent,
      presence,
      canManage: recordLevel(p, g.facts) === 'manage' && p.kind === 'member',
      overrideReason: g.overrideReason ?? null,
    });
  }

  protected previewInput(p: Principal, g: StatusGate, e: Evaluation) {
    return {
      viewer: p.membershipId,
      change: {
        record: g.record.publicId,
        version: g.record.version,
        to: g.to.id,
        transition: e.transition?.id ?? null,
        transition_version: e.transition?.version ?? null,
        workflow: g.wf ? [g.wf.id, g.wf.version] : null,
        override: !!g.overrideReason,
      },
      epochs: p.epochs,
      diff: { members_gaining: 0, members_losing: 0 } as never,
    };
  }

  /**
   * The one enforcement point (ADR-0015 W5–W8). A change needing confirmation or an approval is
   * refused outside the apply command; the apply command needs a fresh preview fingerprint and,
   * for gated transitions, an approved request bound to this record and transition version.
   */
  protected override async gateStatusChange(tx: WorkspaceTransaction, p: Principal, g: StatusGate) {
    const started = performance.now();
    // Lock order (ADR-0015): the record row (taken by the command), then the applicable workflow
    // row FOR SHARE. Configuration commands hold it FOR UPDATE, so a configuration change and a
    // status change serialize; a workflow that moved since it was resolved is a stale change.
    if (g.wf) {
      const cur = await tx.db
        .selectFrom('workflow.workflow')
        .select(['version', 'state'])
        .where('id', '=', g.wf.id)
        .forShare()
        .executeTakeFirst();
      if (!cur || Number(cur.version) !== g.wf.version || cur.state !== 'active') {
        this.d.metrics.count('workflow.transitions', 1, { outcome: 'stale' });
        throw new TenancyError('conflict', {
          issues: [issue('/status', 'stale', 'The workflow changed. Review the change again.')],
        });
      }
    }
    const presence = await this.presenceFor(tx, p, g);
    const e = this.evaluate(tx, p, g, presence);
    const done = (outcome: string) => {
      this.d.metrics.count('workflow.transitions', 1, { outcome });
      this.d.metrics.record('workflow.transition.duration', performance.now() - started, {
        outcome,
      });
    };
    if (!e.allowed) {
      done('refused');
      throw invalid(...e.issues);
    }
    const gated = e.confirmation !== 'none' || e.approval.policy !== 'none';
    if (!g.apply) {
      if (gated) {
        done('review_required');
        throw invalid(
          issue('/status', 'transition_requires_review', 'Review this change before applying it.'),
        );
      }
      done('ok');
      return { overrideUsed: e.overrideUsed };
    }
    if (
      !verifyPreviewToken(this.#transitionKey, g.apply.previewToken, this.previewInput(p, g, e))
    ) {
      done('stale');
      throw new TenancyError('conflict', {
        issues: [issue('/preview_token', 'stale', 'Something changed. Review the change again.')],
      });
    }
    if (e.approval.policy !== 'none') {
      if (!isPublic(g.apply.approval, 'wap')) {
        done('approval_required');
        throw new TenancyError('approval_required', {
          issues: [issue('/approval', 'approval_required', 'This change needs approval first.')],
        });
      }
      const r = await this.approvalRow(tx, g.apply.approval, true);
      if (!r || r.record_id !== g.record.id || r.transition_id !== e.transition!.id)
        throw new TenancyError('not_found');
      const state = await this.stateOf(tx, r, g.record.version, e.transition!.version);
      if (state !== 'approved') {
        done(state);
        throw new TenancyError('conflict', {
          issues: [
            issue(
              '/approval',
              state === 'pending' ? 'approval_pending' : 'stale',
              state === 'pending' ? 'The approval is still pending.' : `The approval is ${state}.`,
            ),
          ],
        });
      }
      if (r.requester_membership_id !== p.membershipId) throw new TenancyError('forbidden');
      await tx.db
        .updateTable('workflow.approval_request')
        .set({ closed_at: new Date(), closed_reason: 'applied' })
        .where('id', '=', r.id)
        .execute();
      if (g.caller)
        await this.workEvent(
          tx,
          g.caller,
          p,
          'workflow.approval_request.closed',
          { type: 'workflow.approval_request', id: r.id, sequence: 2 },
          { closed_reason: 'applied' },
          g.record.brandId,
        );
    }
    if (e.confirmation === 'step_up') await g.stepUp?.();
    done('applied');
    return { overrideUsed: e.overrideUsed };
  }

  /** Statuses this record may move to now, with each change's requirements (no hidden names). */
  async recordTransitions(caller: Caller, ws: unknown, record: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const r = await this.workRecord(tx, p, record);
      const wf = await resolveWorkflow(tx, r.kind, {
        workspaceId: tx.workspaceId,
        brandId: r.brandId,
        projectId: r.projectId,
      });
      const from = statusRef(tx, r.statusId);
      const g0 = this.gateFor(r, wf, from, from, 'apply');
      const presence = await this.presenceFor(tx, p, g0);
      const choices = (wf ? wf.statuses : platformStatuses(r.kind)).filter((s) => s.id !== from.id);
      return {
        workflow: wf ? { id: wf.publicId, name: wf.name, scope_kind: wf.scopeKind } : null,
        current: statusView(from),
        options: choices.map((to) => {
          const e = this.evaluate(tx, p, { ...g0, to }, presence);
          return { status: statusView(to), ...evaluationView(e, statusView) };
        }),
      };
    });
  }

  protected gateFor(
    r: Awaited<ReturnType<WorkflowService['workRecord']>>,
    wf: WorkflowRef | null,
    from: StatusRef,
    to: StatusRef,
    intent: StatusGate['intent'],
    overrideReason: string | null = null,
  ): StatusGate {
    return {
      kind: r.kind,
      record: {
        id: r.id,
        publicId: r.publicId,
        version: r.version,
        brandId: r.brandId,
        projectId: r.projectId,
      },
      facts: r.facts,
      wf,
      from,
      to,
      intent,
      merged: r.merged,
      overrideReason,
    };
  }

  protected requireTransitionAction(
    p: Principal,
    r: Awaited<ReturnType<WorkflowService['workRecord']>>,
  ) {
    const o = decideRecord(p, 'workflow.transition', r.facts);
    this.decision('workflow.transition', o);
    if (!o.allowed) throw new TenancyError(o.code);
    if (p.kind !== 'member') throw new TenancyError('forbidden');
  }

  async previewTransition(caller: Caller, ws: unknown, record: unknown, body: unknown) {
    const b = isObj(body) ? body : {};
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const r = await this.workRecord(tx, p, record);
      this.requireTransitionAction(p, r);
      const wf = await resolveWorkflow(tx, r.kind, {
        workspaceId: tx.workspaceId,
        brandId: r.brandId,
        projectId: r.projectId,
      });
      const from = statusRef(tx, r.statusId);
      const to = statusFromKey(r.kind, wf, b.to, '/to');
      const overrideReason = plain(b.override_reason, '/override_reason', 500);
      const g = this.gateFor(r, wf, from, to, 'apply', overrideReason);
      const e = this.evaluate(tx, p, g, await this.presenceFor(tx, p, g));
      const pending =
        e.transition && e.approval.policy !== 'none'
          ? await this.openRequestsFor(
              tx,
              p,
              r.id,
              e.transition.id,
              r.version,
              e.transition.version,
            )
          : [];
      const warnings: string[] = [];
      if (r.kind === 'task' && to.category === 'done') {
        const t = r.loaded as LoadedTask;
        const unmet = await this.unmetCriteria(tx, t);
        if (unmet.own + unmet.inherited) warnings.push('criteria_incomplete');
        if (await this.incompleteVisibleDescendants(tx, p, t)) warnings.push('incomplete_subtasks');
      }
      return {
        ...evaluationView(e, statusView),
        record_version: r.version,
        warnings,
        approval_requests: pending,
        preview_token: e.allowed
          ? previewToken(this.#transitionKey, this.previewInput(p, g, e), this.#wsTtlMs)
          : null,
      };
    });
  }

  /**
   * Applies a previewed transition. Dispatch follows the change's meaning: into done → Complete
   * (criteria gates), out of a final status → Reopen, otherwise a status edit; every path re-runs
   * the evaluator under the record lock.
   */
  async applyTransition(
    caller: Caller,
    ws: unknown,
    record: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const b = isObj(body) ? body : {};
    if (!Number.isInteger(b.version)) throw new TenancyError('precondition_required');
    const plan = await this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const r = await this.workRecord(tx, p, record);
      this.requireTransitionAction(p, r);
      const wf = await resolveWorkflow(tx, r.kind, {
        workspaceId: tx.workspaceId,
        brandId: r.brandId,
        projectId: r.projectId,
      });
      const from = statusRef(tx, r.statusId);
      const to = statusFromKey(r.kind, wf, b.to, '/to');
      return { kind: r.kind, from, to };
    });
    const t = {
      to: plan.to.key,
      version: b.version as number,
      apply: { previewToken: b.preview_token, approval: b.approval },
      overrideReason: plain(b.override_reason, '/override_reason', 500),
      confirmSubtasks: b.confirm_incomplete_subtasks === true,
    };
    if (plan.kind === 'project') return this.updateProject(caller, ws, record, {}, req, t);
    if (TERMINAL.has(plan.from.category)) return this.reopenTask(caller, ws, record, req, t);
    if (plan.to.category === 'done') return this.completeTask(caller, ws, record, {}, req, t);
    return this.updateTask(caller, ws, record, {}, req, t);
  }

  // ---------------------------------------------------------------------------------------------
  // Approvals
  // ---------------------------------------------------------------------------------------------

  protected async approvalRow(
    tx: WorkspaceTransaction,
    wap: unknown,
    lock = false,
  ): Promise<(ApprovalRow & { workflow_id: string; brand_id: string }) | null> {
    if (!isPublic(wap, 'wap')) return null;
    let q = tx.db.selectFrom('workflow.approval_request').selectAll().where('public_id', '=', wap);
    if (lock) q = q.forUpdate();
    return ((await q.executeTakeFirst()) as never) ?? null;
  }

  protected async stateOf(
    tx: WorkspaceTransaction,
    r: ApprovalRow,
    recordVersion: number,
    transitionVersion: number | null,
    eligible?: (m: string) => boolean,
  ) {
    const decisions = await decisionsOf(tx, [r.id]);
    return approvalState(
      r,
      decisions,
      { recordVersion, transitionVersion, now: new Date() },
      eligible ?? (() => true),
    );
  }

  protected async openRequestsFor(
    tx: WorkspaceTransaction,
    p: Principal,
    recordId: string,
    transitionId: string,
    version: number,
    tversion: number,
  ) {
    const rows = (await tx.db
      .selectFrom('workflow.approval_request')
      .selectAll()
      .where('record_id', '=', recordId)
      .where('transition_id', '=', transitionId)
      .where('closed_at', 'is', null)
      .orderBy('created_at', 'desc')
      .limit(5)
      .execute()) as unknown as ApprovalRow[];
    const out = [];
    for (const r of rows)
      out.push({
        id: r.public_id,
        state: await this.stateOf(tx, r, version, tversion),
        mine: r.requester_membership_id === p.membershipId,
        expires_at: new Date(r.expires_at).toISOString(),
      });
    return out;
  }

  /** Requests approval for a gated transition of the current record version (W7). */
  async requestApproval(
    caller: Caller,
    ws: unknown,
    record: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'workflow.approval_request',
      ws,
      req,
      async (tx, p) => {
        const r = await this.workRecord(tx, p, record, true);
        const o = decideRecord(p, 'workflow.approval_request', r.facts);
        this.decision('workflow.approval_request', o);
        if (!o.allowed) throw new TenancyError(o.code);
        if (p.kind !== 'member') throw new TenancyError('forbidden');
        if (!Number.isInteger(b.version)) throw new TenancyError('precondition_required');
        requireVersion(b.version as number, r.version);
        const wf = await resolveWorkflow(tx, r.kind, {
          workspaceId: tx.workspaceId,
          brandId: r.brandId,
          projectId: r.projectId,
        });
        const from = statusRef(tx, r.statusId);
        const to = statusFromKey(r.kind, wf, b.to, '/to');
        const g = this.gateFor(r, wf, from, to, 'apply');
        const e = this.evaluate(tx, p, g, await this.presenceFor(tx, p, g));
        if (!e.allowed) throw invalid(...e.issues);
        if (!e.transition || e.approval.policy === 'none')
          throw invalid(issue('/to', 'approval_not_needed', 'This change does not need approval.'));
        const open = await this.openRequestsFor(
          tx,
          p,
          r.id,
          e.transition.id,
          r.version,
          e.transition.version,
        );
        if (open.some((x) => x.state === 'pending' || x.state === 'approved'))
          throw new TenancyError('conflict', {
            issues: [
              issue('/', 'approval_open', 'An approval request for this change is already open.'),
            ],
          });
        const id = newUuidV7();
        const publicId = newPublicId('wap');
        const fingerprint = proposalFingerprint({
          record: r.publicId,
          recordVersion: r.version,
          transition: e.transition.publicId,
          transitionVersion: e.transition.version,
          to: to.key,
          workflowVersion: wf?.version ?? null,
        });
        const expires = new Date(Date.now() + this.ws.approvalExpiryHours * 3_600_000);
        await tx.db
          .insertInto('workflow.approval_request')
          .values({
            id,
            public_id: publicId,
            workspace_id: tx.workspaceId,
            brand_id: r.brandId,
            workflow_id: wf!.id,
            transition_id: e.transition.id,
            transition_version: e.transition.version,
            record_id: r.id,
            record_type: r.kind,
            record_version: r.version,
            fingerprint,
            requester_membership_id: p.membershipId,
            policy: e.approval.policy as 'one_manager',
            approver_membership_ids:
              e.approval.policy === 'all_named_approvers' ? e.approval.approvers : [],
            allow_self_approval: e.approval.allowSelf,
            expires_at: expires,
          })
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'workflow.approval_requested',
          { recordId: r.id, type: r.kind, publicId: r.publicId },
          [change.plain('to', from.key, to.key), change.plain('policy', null, e.approval.policy)],
          r.brandId,
        );
        await this.workEvent(
          tx,
          caller,
          p,
          'workflow.approval_request.created',
          { type: 'workflow.approval_request', id, sequence: 0 },
          { transition_id: e.transition.id, policy: e.approval.policy, record_type: r.kind },
          r.brandId,
        );
        return {
          status: 201,
          ref: { id: publicId, type: 'workflow_approval' },
          data: await this.approvalView(tx, p, publicId),
        };
      },
      async (tx, p, ref) => this.approvalView(tx, p, ref.id),
    );
  }

  /**
   * OD-20 self-approval: the workspace's `self_approval_mode`. `auto` allows it only while the
   * workspace has a single active internal member; it is always recorded and labelled.
   */
  protected async selfApprovalAllowed(tx: WorkspaceTransaction, p: Principal): Promise<boolean> {
    const mode = (p.policy as Record<string, unknown>).self_approval_mode ?? 'auto';
    if (mode === 'allowed') return true;
    if (mode === 'forbidden') return false;
    const n = await tx.db
      .selectFrom('tenancy.membership')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('kind', '=', 'member')
      .where('state', '=', 'active')
      .executeTakeFirstOrThrow();
    return Number(n.n) <= 1;
  }

  /** May `p` decide this request (policy eligibility; record readability decided by the caller)? */
  protected eligibleApprover(
    p: Principal,
    r: ApprovalRow,
    level: Level | null,
    selfOk: boolean,
  ): boolean {
    if (p.kind !== 'member' || level === null) return false;
    if (r.requester_membership_id === p.membershipId && !(r.allow_self_approval && selfOk))
      return false;
    if (r.policy === 'one_manager') return levelRank(level) >= levelRank('manage');
    return r.approver_membership_ids.includes(p.membershipId);
  }

  /** The approval detail: visible to the requester and eligible approvers who can read the record. */
  protected async approvalView(tx: WorkspaceTransaction, p: Principal, wap: unknown) {
    const r = await this.approvalRow(tx, wap);
    if (!r) throw new TenancyError('not_found');
    const rec = await tx.db
      .selectFrom('core.record')
      .select('public_id')
      .where('id', '=', r.record_id)
      .executeTakeFirstOrThrow();
    const wr = await this.workRecord(tx, p, rec.public_id);
    const mine = r.requester_membership_id === p.membershipId;
    const eligible = this.eligibleApprover(
      p,
      r,
      wr.level,
      mine && (await this.selfApprovalAllowed(tx, p)),
    );
    if (!mine && !eligible && wr.level !== 'manage') throw new TenancyError('not_found');
    const tr = await tx.db
      .selectFrom('workflow.transition')
      .select(['public_id', 'from_status_id', 'to_status_id', 'version'])
      .where('id', '=', r.transition_id)
      .executeTakeFirstOrThrow();
    await primeStatuses(tx, [tr.from_status_id, tr.to_status_id]);
    const decisions = await decisionsOf(tx, [r.id]);
    const state = approvalState(
      r,
      decisions,
      { recordVersion: wr.version, transitionVersion: Number(tr.version), now: new Date() },
      () => true,
    );
    const mems = await this.publicIdsOf(
      tx,
      [
        r.requester_membership_id,
        ...r.approver_membership_ids,
        ...decisions.map((d) => d.approver_membership_id),
      ],
      'tenancy.membership',
    );
    return {
      id: r.public_id,
      type: 'workflow_approval' as const,
      record: { id: wr.publicId, type: wr.kind },
      transition: tr.public_id,
      from: statusView(statusRef(tx, tr.from_status_id)),
      to: statusView(statusRef(tx, tr.to_status_id)),
      policy: r.policy,
      state,
      requester: mems.get(r.requester_membership_id) ?? null,
      approvers: r.approver_membership_ids.map((m) => mems.get(m)),
      decisions: decisions.map((d) => ({
        approver: mems.get(d.approver_membership_id),
        decision: d.decision,
        decided_at: new Date(d.decided_at).toISOString(),
      })),
      expires_at: new Date(r.expires_at).toISOString(),
      can_decide:
        eligible &&
        state === 'pending' &&
        !decisions.some((d) => d.approver_membership_id === p.membershipId),
      can_apply: mine && state === 'approved',
      can_withdraw: mine && (state === 'pending' || state === 'approved'),
      self_requested: mine,
    };
  }

  async getApproval(caller: Caller, ws: unknown, wap: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, (tx, p) =>
      this.approvalView(tx, p, wap),
    );
  }

  /**
   * Pending approvals this person may decide or has requested. Requests whose record they cannot
   * read are omitted entirely, with no count (AT-124). Bounded by the page limit.
   */
  /** In-transaction core of the public reader (7E briefings reuse it for a recipient). */
  protected async listApprovalsIn(
    tx: WorkspaceTransaction,
    p: Principal,
    query: Record<string, unknown>,
  ) {
    if (p.kind !== 'member') return { data: [] };
    const rows = (await tx.db
      .selectFrom('workflow.approval_request')
      .select(['public_id'])
      .where('closed_at', 'is', null)
      .where('expires_at', '>', new Date())
      .where((eb) =>
        query.mine === 'requested'
          ? eb('requester_membership_id', '=', p.membershipId)
          : eb.or([
              eb('policy', '=', 'one_manager'),
              eb(sql`${p.membershipId}::uuid`, '=', sql`ANY(approver_membership_ids)`),
              eb('requester_membership_id', '=', p.membershipId),
            ]),
      )
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(this.pageLimitMax)
      .execute()) as Array<{ public_id: string }>;
    const data = [];
    for (const r of rows) {
      try {
        const v = await this.approvalView(tx, p, r.public_id);
        if (query.mine === 'requested' ? v.self_requested : v.can_decide || v.self_requested)
          data.push(v);
      } catch (e) {
        if (!(e instanceof TenancyError)) throw e;
      }
    }
    return { data };
  }

  async listApprovals(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) =>
      this.listApprovalsIn(tx, p, query),
    );
  }

  async decideApproval(caller: Caller, ws: unknown, wap: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const decision = oneOf(b.decision, ['approve', 'reject'] as const, '/decision');
    const note = plain(b.note, '/note', 1000);
    return this.mutate(
      caller,
      'workflow.approval_decide',
      ws,
      req,
      async (tx, p) => {
        const r = await this.approvalRow(tx, wap, true);
        if (!r) throw new TenancyError('not_found');
        const rec = await tx.db
          .selectFrom('core.record')
          .select('public_id')
          .where('id', '=', r.record_id)
          .executeTakeFirstOrThrow();
        const wr = await this.workRecord(tx, p, rec.public_id);
        const o = decideRecord(p, 'workflow.approval_decide', wr.facts);
        this.decision('workflow.approval_decide', o);
        if (!o.allowed) throw new TenancyError(o.code);
        const self = r.requester_membership_id === p.membershipId;
        if (!this.eligibleApprover(p, r, wr.level, self && (await this.selfApprovalAllowed(tx, p))))
          throw new TenancyError(
            r.requester_membership_id === p.membershipId ? 'forbidden' : 'not_found',
          );
        const tr = await tx.db
          .selectFrom('workflow.transition')
          .select(['version'])
          .where('id', '=', r.transition_id)
          .executeTakeFirstOrThrow();
        const state = await this.stateOf(tx, r, wr.version, Number(tr.version));
        if (state !== 'pending')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'stale', `This request is ${state}.`)],
          });
        try {
          await tx.db
            .insertInto('workflow.approval_decision')
            .values({
              id: newUuidV7(),
              workspace_id: tx.workspaceId,
              approval_request_id: r.id,
              approver_membership_id: p.membershipId,
              decision,
              note_hash: note ? hash(note).slice(7) : null,
            })
            .execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw new TenancyError('conflict', {
              issues: [issue('/', 'already_decided', 'You already decided this request.')],
            });
          throw e;
        }
        const next = await this.stateOf(tx, r, wr.version, Number(tr.version));
        await this.workAudit(
          tx,
          caller,
          p,
          'workflow.approval_decided',
          { recordId: wr.id, type: wr.kind, publicId: wr.publicId },
          [
            change.plain('decision', null, decision),
            change.plain('self_approval', null, r.requester_membership_id === p.membershipId),
            ...(note ? [change.content('note', { hash: hash(note) })] : []),
          ],
          wr.brandId,
        );
        await this.workEvent(
          tx,
          caller,
          p,
          'workflow.approval_request.decided',
          { type: 'workflow.approval_request', id: r.id, sequence: 1 },
          { decision, state: next },
          wr.brandId,
        );
        return {
          status: 200,
          ref: { id: r.public_id, type: 'workflow_approval' },
          data: await this.approvalView(tx, p, r.public_id),
        };
      },
      async (tx, p, ref) => this.approvalView(tx, p, ref.id),
    );
  }

  async withdrawApproval(caller: Caller, ws: unknown, wap: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'workflow.approval_withdraw',
      ws,
      req,
      async (tx, p) => {
        const r = await this.approvalRow(tx, wap, true);
        if (!r) throw new TenancyError('not_found');
        const rec = await tx.db
          .selectFrom('core.record')
          .select('public_id')
          .where('id', '=', r.record_id)
          .executeTakeFirstOrThrow();
        const wr = await this.workRecord(tx, p, rec.public_id);
        if (r.requester_membership_id !== p.membershipId) throw new TenancyError('not_found');
        if (r.closed_at)
          throw new TenancyError('conflict', {
            issues: [issue('/', 'closed', 'This request is closed.')],
          });
        await tx.db
          .updateTable('workflow.approval_request')
          .set({ closed_at: new Date(), closed_reason: 'withdrawn' })
          .where('id', '=', r.id)
          .execute();
        await this.workEvent(
          tx,
          caller,
          p,
          'workflow.approval_request.closed',
          { type: 'workflow.approval_request', id: r.id, sequence: 2 },
          { closed_reason: 'withdrawn' },
          wr.brandId,
        );
        return {
          status: 200,
          ref: { id: r.public_id, type: 'workflow_approval' },
          data: await this.approvalView(tx, p, r.public_id),
        };
      },
      async (tx, p, ref) => this.approvalView(tx, p, ref.id),
    );
  }
}

function hash(s: string) {
  return `sha256:${createHash('sha256').update(s).digest('hex')}`;
}
function nameTaken(e: unknown, path: string) {
  if ((e as { code?: string }).code === '23505')
    return invalid(issue(path, 'name_taken', 'That name is already used in this workflow.'));
  return e;
}
