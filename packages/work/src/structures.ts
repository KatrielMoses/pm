import { primeStatuses } from './workflow/statuses.ts';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import {
  brandMarker,
  compileVisibility,
  decideBrand,
  findBrand,
  invalid,
  issue,
  levelRank,
  parseIfMatch,
  requireVersion,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { instantiatePackage, NOT_COPIED, type Copied } from './instantiate.ts';
import {
  describeRule,
  localToUtc,
  occurrences,
  parseRule,
  RuleError,
  utcToLocal,
} from './recurrence.ts';
import { contentHash, ProjectService, toDate, type LoadedProject } from './service.ts';
import { readPackage, serializeProject, type TemplatePackage } from './templates.ts';
import {
  isPublic,
  parseAfter,
  parseCriterion,
  parseDecision,
  parseDependency,
  parseMilestone,
  parsePhase,
  parseRecurrence,
  parseScopeItem,
  parseTemplateFromProject,
  parseUpdate,
} from './validation.ts';

type Child = 'phase' | 'milestone' | 'decision_record';
const CHILD_TABLE = {
  phase: 'work.phase',
  milestone: 'work.milestone',
  decision_record: 'work.decision_record',
} as const;
const CHILD_PREFIX = { phase: 'phs', milestone: 'ms', decision_record: 'dec' } as const;

const pgCode = (err: unknown) =>
  typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;

/**
 * Project structures (PRJ-005/006/010/011/013/014/015/024/025): phases, milestones, criteria,
 * scope entries, updates and verification, decisions and questions, dependencies, templates,
 * duplicate, and recurrence. Everything authorizes through the containing project:
 *
 *   - Records with their own envelope (phases, milestones, decisions) need ownership-derived
 *     access to the project; a project share never reaches them (0C AZ-21).
 *   - The project's own fields (criteria, scope entries, updates) follow the project's level,
 *     including an exact share.
 */
export class WorkService extends ProjectService {
  // ---------------------------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------------------------

  /** Everything the Overview and Timeline show, each part re-authorized (no hidden counts). */
  async overview(caller: Caller, workspacePublicId: unknown, projectPublicId: unknown) {
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      const project = await this.loadProject(tx, p, projectPublicId);
      const own = project.ownLevel !== null;
      const criteria = await tx.db
        .selectFrom('work.criteria_item')
        .select(['public_id', 'kind', 'text', 'met', 'met_at', 'version'])
        .where('project_id', '=', project.id)
        .orderBy('kind')
        .orderBy('rank')
        .orderBy('id')
        .execute();
      const scope = await tx.db
        .selectFrom('work.scope_item')
        .select(['public_id', 'kind', 'text', 'version'])
        .where('project_id', '=', project.id)
        .orderBy('kind')
        .orderBy('rank')
        .orderBy('id')
        .execute();
      const updates = await tx.db
        .selectFrom('work.project_update as u')
        .leftJoin('work.project_update_verification as v', (j) =>
          j.onRef('v.workspace_id', '=', 'u.workspace_id').onRef('v.update_id', '=', 'u.id'),
        )
        .select([
          'u.public_id',
          'u.body',
          'u.health',
          'u.source_kind',
          'u.created_at',
          'v.verified_at',
        ])
        .where('u.project_id', '=', project.id)
        .orderBy('u.created_at', 'desc')
        .orderBy('u.id', 'desc')
        .limit(20)
        .execute();
      // OD-16: the newest update that carries a verification fact (never a mutated update).
      const latestVerified = await tx.db
        .selectFrom('work.project_update as u')
        .innerJoin('work.project_update_verification as v', (j) =>
          j.onRef('v.workspace_id', '=', 'u.workspace_id').onRef('v.update_id', '=', 'u.id'),
        )
        .select(['u.public_id', 'u.body', 'u.health', 'u.created_at', 'v.verified_at'])
        .where('u.project_id', '=', project.id)
        .orderBy('u.created_at', 'desc')
        .orderBy('u.id', 'desc')
        .limit(1)
        .executeTakeFirst();
      const vis = await compileVisibility(tx, p, {
        need: 'view',
        includeArchived: true,
        arrayMax: this.c.settings.principalContextArrayMax,
      });
      const child = <T extends Child>(type: T) =>
        tx.db
          .selectFrom(`${CHILD_TABLE[type]} as t` as 'work.phase as t')
          .innerJoin('core.record as r', (j) =>
            j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
          )
          .where('t.project_id', '=', project.id)
          .where(vis.where('r', { project: sql`t.project_id` }));
      // Each section is authorized on its own (ADR-0013 P5): a project share grants the project and
      // its intrinsic facts (criteria, scope entries, the latest verified update's content), never
      // phases, milestones, decisions, dependencies, children, update history, or recurrence. Child
      // records appear only through the caller's own authority over each of them.
      const phases = own
        ? await child('phase')
            .select([
              'r.public_id',
              't.name',
              't.start_date',
              't.end_date',
              't.status',
              't.lifecycle_state',
              't.version',
            ])
            .orderBy('t.rank')
            .orderBy('t.id')
            .execute()
        : [];
      const phaseIds = own
        ? new Map(
            (
              await tx.db
                .selectFrom('work.phase as t')
                .innerJoin('core.record as r', 'r.id', 't.id')
                .select(['t.id', 'r.public_id'])
                .where('t.project_id', '=', project.id)
                .execute()
            ).map((x) => [x.id, x.public_id]),
          )
        : new Map<string, string>();
      const milestones = own
        ? await tx.db
            .selectFrom('work.milestone as t')
            .innerJoin('core.record as r', (j) =>
              j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
            )
            .where('t.project_id', '=', project.id)
            .where(vis.where('r', { project: sql`t.project_id` }))
            .select([
              'r.public_id',
              't.name',
              't.due_date',
              't.status',
              't.phase_id',
              't.lifecycle_state',
              't.version',
            ])
            .orderBy('t.rank')
            .orderBy('t.id')
            .execute()
        : [];
      const decisions = own
        ? await tx.db
            .selectFrom('work.decision_record as t')
            .innerJoin('core.record as r', (j) =>
              j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
            )
            .where('t.project_id', '=', project.id)
            .where(vis.where('r', { project: sql`t.project_id` }))
            .select([
              'r.public_id',
              't.kind',
              't.state',
              't.statement',
              't.outcome',
              't.due_date',
              't.decided_at',
              't.resolved_at',
              't.version',
            ])
            .orderBy('t.created_at', 'desc')
            .execute()
        : [];
      const dependencies = own
        ? await this.readableDependencies(tx, p, project)
        : { blocked_by: [], blocks: [] };
      const children = await tx.db
        .selectFrom('core.record as r')
        .innerJoin('work.project as w', (j) =>
          j.onRef('w.workspace_id', '=', 'r.workspace_id').onRef('w.id', '=', 'r.id'),
        )
        .select(['r.public_id', 'w.name', 'w.status_id'])
        .where('w.parent_project_id', '=', project.id)
        .where('r.lifecycle_state', '=', 'active')
        .where(vis.where('r', { project: sql`w.id` }))
        .orderBy('w.rank')
        .orderBy('w.id')
        .execute();
      await primeStatuses(
        tx,
        children.map((c) => c.status_id),
      );
      return {
        project: await this.projectView(tx, p, project),
        criteria: criteria.map((c) => ({
          id: c.public_id,
          kind: c.kind,
          text: c.text,
          met: c.met,
          met_at: c.met_at ? new Date(c.met_at).toISOString() : null,
          version: Number(c.version),
        })),
        scope_items: scope.map((s) => ({
          id: s.public_id,
          kind: s.kind,
          text: s.text,
          version: Number(s.version),
        })),
        phases: phases.map((x) => ({
          id: x.public_id,
          name: x.name,
          start_date: toDate(x.start_date),
          end_date: toDate(x.end_date),
          status: x.status,
          lifecycle_state: x.lifecycle_state,
          version: Number(x.version),
        })),
        milestones: milestones.map((m) => ({
          id: m.public_id,
          name: m.name,
          due_date: toDate(m.due_date),
          status: m.status,
          phase: m.phase_id ? (phaseIds.get(m.phase_id) ?? null) : null,
          lifecycle_state: m.lifecycle_state,
          version: Number(m.version),
        })),
        decisions: decisions.map((d) => ({
          id: d.public_id,
          kind: d.kind,
          state: d.state,
          statement: d.statement,
          outcome: d.outcome,
          due_date: toDate(d.due_date),
          decided_at: d.decided_at ? new Date(d.decided_at).toISOString() : null,
          resolved_at: d.resolved_at ? new Date(d.resolved_at).toISOString() : null,
          version: Number(d.version),
        })),
        updates: (own ? updates : []).map((u) => ({
          id: u.public_id,
          body: u.body,
          health: u.health,
          source_kind: u.source_kind,
          created_at: new Date(u.created_at).toISOString(),
          verified: u.verified_at !== null,
        })),
        // PRJ-025: a share-only reader gets the latest verified update's content and ID only (no
        // verifier, verification time or history, other updates, or counts).
        latest_verified_update: !latestVerified
          ? null
          : own
            ? {
                id: latestVerified.public_id,
                body: latestVerified.body,
                health: latestVerified.health,
                created_at: new Date(latestVerified.created_at).toISOString(),
                verified_at: new Date(latestVerified.verified_at).toISOString(),
              }
            : { id: latestVerified.public_id, body: latestVerified.body },
        dependencies,
        children: children.map((c) => ({
          id: c.public_id,
          name: c.name,
          status: this.statusView(c.status_id, tx),
        })),
        // Task-derived facts arrive with tasks (2B/5C); nothing is fabricated here.
        task_facts: { available: false as const },
      };
    });
  }

  /**
   * Dependencies with both endpoints re-authorized at display (OD-05): an unreadable counterpart
   * is omitted entirely, with no title, type, brand, state, count, or broken-link clue.
   */
  protected async readableDependencies(
    tx: WorkspaceTransaction,
    p: Principal,
    project: LoadedProject,
  ) {
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      includeArchived: true,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const side = async (
      mine: 'from_record_id' | 'to_record_id',
      other: 'from_record_id' | 'to_record_id',
    ) =>
      tx.db
        .selectFrom('relations.record_relationship as rel')
        .innerJoin('core.record as r', (j) =>
          j.onRef('r.workspace_id', '=', 'rel.workspace_id').onRef('r.id', '=', `rel.${other}`),
        )
        .innerJoin('work.project as w', (j) =>
          j.onRef('w.workspace_id', '=', 'r.workspace_id').onRef('w.id', '=', 'r.id'),
        )
        .innerJoin('tenancy.brand as b', 'b.id', 'w.brand_id')
        .innerJoin('core.record as br', 'br.id', 'b.id')
        .select([
          'r.public_id',
          'w.name',
          'w.status_id',
          'r.lifecycle_state',
          'br.public_id as brand_public_id',
          'b.name as brand_name',
          'b.short_name',
          'b.color',
          'b.icon',
          'b.lifecycle_state as brand_state',
        ])
        .where(`rel.${mine}`, '=', project.id)
        .where('rel.kind', '=', 'blocks')
        .where('r.record_type', '=', 'project')
        .where(vis.where('r', { project: sql`w.id` }))
        .orderBy('w.name')
        .execute();
    const view = (rows: Awaited<ReturnType<typeof side>>) =>
      rows.map((x) => ({
        id: x.public_id,
        name: x.name,
        status: this.statusView(x.status_id, tx),
        lifecycle_state: x.lifecycle_state,
        brand: brandMarker({
          public_id: x.brand_public_id,
          name: x.brand_name,
          short_name: x.short_name,
          color: x.color,
          icon: x.icon,
          lifecycle_state: x.brand_state,
        }),
      }));
    const blockedBy = await side('to_record_id', 'from_record_id');
    const blocks = await side('from_record_id', 'to_record_id');
    await primeStatuses(
      tx,
      [...blockedBy, ...blocks].map((x) => x.status_id),
    );
    return { blocked_by: view(blockedBy), blocks: view(blocks) };
  }

  // ---------------------------------------------------------------------------------------------
  // Child records (phases, milestones, decisions)
  // ---------------------------------------------------------------------------------------------

  /** A child record of a project, readable only with ownership-derived project access. */
  protected async loadChild(
    tx: WorkspaceTransaction,
    project: LoadedProject,
    type: Child,
    publicId: unknown,
    lock = false,
  ) {
    if (!isPublic(publicId, CHILD_PREFIX[type]) || project.ownLevel === null)
      throw new TenancyError('not_found');
    let q = tx.db
      .selectFrom('core.record as r')
      .innerJoin(`${CHILD_TABLE[type]} as t` as 'work.phase as t', (j) =>
        j.onRef('t.workspace_id', '=', 'r.workspace_id').onRef('t.id', '=', 'r.id'),
      )
      .select(['r.id', 'r.public_id', 'r.lifecycle_state', 'r.deletion_batch_id', 't.version'])
      .where('r.public_id', '=', publicId)
      .where('t.project_id', '=', project.id);
    if (lock) q = q.forUpdate('t');
    const row = await q.executeTakeFirst();
    if (!row || row.lifecycle_state === 'purged') throw new TenancyError('not_found');
    return {
      id: row.id,
      publicId: row.public_id,
      lifecycleState: row.lifecycle_state,
      batchId: row.deletion_batch_id,
      version: Number(row.version),
    };
  }

  protected async insertChildEnvelope(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    project: LoadedProject,
    type: Child,
  ): Promise<{ id: string; publicId: string }> {
    const id = newUuidV7();
    const publicId = newPublicId(CHILD_PREFIX[type]);
    const cmd = this.cmd(caller, p, project.brand.id);
    await tx.db
      .insertInto('core.record')
      .values({
        id,
        public_id: publicId,
        record_type: type,
        workspace_id: tx.workspaceId,
        brand_id: project.brand.id,
        source_kind: 'ui',
        source_ref: null,
        created_by_actor_type: cmd.actor.type,
        created_by_actor_id: cmd.actor.id,
      })
      .execute();
    return { id, publicId };
  }

  /** Child commands: edit on the project through ownership-derived access, project active. */
  protected async editableProject(
    tx: WorkspaceTransaction,
    p: Principal,
    projectPublicId: unknown,
  ) {
    const project = await this.loadProject(tx, p, projectPublicId, { lock: true });
    if (project.ownLevel === null) throw new TenancyError('not_found');
    this.requireProjectAction(p, 'record.update', project, { shares: false });
    this.requireActive(project);
    return project;
  }

  protected async ownerId(
    tx: WorkspaceTransaction,
    ref: string | null | undefined,
    pointer: string,
  ) {
    if (ref === undefined) return undefined;
    if (ref === null) return null;
    return (await this.memberByPublic(tx, ref, pointer)).id;
  }

  protected async rendered<T>(
    caller: Caller,
    ws: unknown,
    projectPublicId: unknown,
    req: Mutation,
    command: string,
    fn: (tx: WorkspaceTransaction, p: Principal) => Promise<{ id: string; type: string }>,
  ) {
    return this.mutate(
      caller,
      command,
      ws,
      req,
      async (tx, p) => {
        const ref = await fn(tx, p);
        return {
          status: 200,
          ref,
          data: { id: ref.id, type: ref.type, project: projectPublicId as string },
        };
      },
      async (_tx, _p, ref) =>
        ({ id: ref.id, type: ref.type, project: projectPublicId as string }) as T & {
          id: string;
          type: string;
          project: string;
        },
    );
  }

  async createPhase(caller: Caller, ws: unknown, prj: unknown, body: unknown, req: Mutation) {
    const input = parsePhase(body, false);
    return this.rendered(caller, ws, prj, req, 'phase.create', async (tx, p) => {
      const project = await this.editableProject(tx, p, prj);
      const env = await this.insertChildEnvelope(tx, caller, p, project, 'phase');
      const rank = await this.nextRank(
        tx,
        'work.phase',
        (q) => q.where('project_id', '=', project.id),
        'last',
      );
      await tx.db
        .insertInto('work.phase')
        .values({
          id: env.id,
          workspace_id: tx.workspaceId,
          brand_id: project.brand.id,
          scope_key: project.brand.id,
          project_id: project.id,
          name: input.name as string,
          rank,
          start_date: input.start_date ?? null,
          end_date: input.end_date ?? null,
          status: input.status ?? 'planned',
          owner_membership_id: (await this.ownerId(tx, input.owner, '/owner')) ?? null,
        })
        .execute();
      await this.workAudit(
        tx,
        caller,
        p,
        'phase.created',
        { recordId: env.id, type: 'phase', publicId: env.publicId },
        [
          change.content('name', { hash: contentHash(input.name) }),
          change.plain('project', null, project.publicId),
        ],
        project.brand.id,
      );
      await this.workEvent(
        tx,
        caller,
        p,
        'work.phase.created',
        { type: 'work.phase', id: env.id, sequence: 0 },
        { project_id: project.id },
        project.brand.id,
      );
      return { id: env.publicId, type: 'phase' };
    });
  }

  async updatePhase(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    phs: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parsePhase(body, true);
    return this.rendered(caller, ws, prj, req, 'phase.update', async (tx, p) => {
      const project = await this.editableProject(tx, p, prj);
      const ph = await this.loadChild(tx, project, 'phase', phs, true);
      if (req.ifMatch === undefined) throw new TenancyError('precondition_required');
      requireVersion(parseIfMatch(req.ifMatch), ph.version);
      if (ph.lifecycleState !== 'active') throw new TenancyError('conflict');
      const set: Record<string, unknown> = {
        updated_at: new Date(),
        updated_by_membership_id: p.membershipId,
        version: ph.version + 1,
      };
      const changes = [];
      for (const k of ['name', 'start_date', 'end_date', 'status'] as const)
        if (input[k] !== undefined) {
          set[k] = input[k];
          changes.push(
            k === 'name'
              ? change.content('name', { hash: contentHash(input.name) })
              : change.plain(k, null, input[k] ?? null),
          );
        }
      const owner = await this.ownerId(tx, input.owner, '/owner');
      if (owner !== undefined) {
        set.owner_membership_id = owner;
        changes.push(change.plain('owner', null, input.owner ?? null));
      }
      try {
        await tx.db.updateTable('work.phase').set(set).where('id', '=', ph.id).execute();
      } catch (err) {
        if (pgCode(err) === '23514')
          throw invalid(issue('/end_date', 'date_order', 'The end date is before the start date.'));
        throw err;
      }
      await this.workAudit(
        tx,
        caller,
        p,
        'phase.updated',
        { recordId: ph.id, type: 'phase', publicId: ph.publicId },
        changes,
        project.brand.id,
      );
      await this.workEvent(
        tx,
        caller,
        p,
        'work.phase.updated',
        { type: 'work.phase', id: ph.id, sequence: ph.version + 1 },
        {
          project_id: project.id,
          changed_fields: Object.keys(set)
            .filter((k) => !['updated_at', 'updated_by_membership_id', 'version'].includes(k))
            .sort()
            .join(','),
        },
        project.brand.id,
      );
      return { id: ph.publicId, type: 'phase' };
    });
  }

  /** Reorder phases or milestones (stable fractional rank; never drag-only, A11Y-PA-08). */
  async moveChild(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    type: 'phase' | 'milestone',
    ref: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const after = parseAfter(body, CHILD_PREFIX[type]);
    return this.rendered(caller, ws, prj, req, `${type}.move`, async (tx, p) => {
      const project = await this.editableProject(tx, p, prj);
      const row = await this.loadChild(tx, project, type, ref, true);
      const afterRow = after ? await this.loadChild(tx, project, type, after) : null;
      const table = type === 'phase' ? 'work.phase' : 'work.milestone';
      const rank = await this.nextRank(
        tx,
        table,
        (q) => q.where('project_id', '=', project.id).where('id', '<>', row.id),
        afterRow?.id ?? null,
      );
      await tx.db
        .updateTable(table)
        .set({ rank, version: row.version + 1, updated_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      await this.workAudit(
        tx,
        caller,
        p,
        `${type}.moved`,
        { recordId: row.id, type, publicId: row.publicId },
        [change.plain('after', null, after)],
        project.brand.id,
      );
      return { id: row.publicId, type };
    });
  }

  /** Phase and milestone archive/restore (reversible, canonical lifecycle), milestone trash/restore. */
  async childLifecycle(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    type: 'phase' | 'milestone',
    ref: unknown,
    verb: 'archive' | 'unarchive' | 'trash' | 'restore',
    req: Mutation,
  ) {
    return this.rendered(caller, ws, prj, req, `${type}.${verb}`, async (tx, p) => {
      const project = await this.loadProject(tx, p, prj, { lock: true });
      if (project.ownLevel === null) throw new TenancyError('not_found');
      this.requireActive(project);
      const row = await this.loadChild(tx, project, type, ref, true);
      if (row.lifecycleState === 'trashed' && levelRank(project.ownLevel) < levelRank('edit'))
        throw new TenancyError('not_found');
      const facts = {
        id: row.id,
        brand: project.brand,
        lifecycleState: row.lifecycleState,
        chain: project.chain,
      };
      const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
      if (verb === 'archive')
        await this.d.lifecycle.archive(
          tx,
          this.issueLifecycle(tx, p, 'record.archive', facts),
          input,
          row.id,
        );
      else if (verb === 'unarchive')
        await this.d.lifecycle.unarchive(
          tx,
          this.issueLifecycle(tx, p, 'record.restore', facts),
          input,
          row.id,
        );
      else if (verb === 'trash')
        await this.d.lifecycle.trash(
          tx,
          this.issueLifecycle(tx, p, 'record.trash', facts),
          input,
          row.id,
        );
      else {
        if (!row.batchId) throw new TenancyError('conflict');
        await this.d.lifecycle.restore(
          tx,
          this.issueLifecycle(tx, p, 'record.restore', facts),
          input,
          row.batchId,
        );
      }
      return { id: row.publicId, type };
    });
  }

  async createMilestone(caller: Caller, ws: unknown, prj: unknown, body: unknown, req: Mutation) {
    const input = parseMilestone(body, false);
    return this.rendered(caller, ws, prj, req, 'milestone.create', async (tx, p) => {
      const project = await this.editableProject(tx, p, prj);
      const phase = input.phase ? await this.loadChild(tx, project, 'phase', input.phase) : null;
      const env = await this.insertChildEnvelope(tx, caller, p, project, 'milestone');
      const rank = await this.nextRank(
        tx,
        'work.milestone',
        (q) => q.where('project_id', '=', project.id),
        'last',
      );
      await tx.db
        .insertInto('work.milestone')
        .values({
          id: env.id,
          workspace_id: tx.workspaceId,
          brand_id: project.brand.id,
          scope_key: project.brand.id,
          project_id: project.id,
          phase_id: phase?.id ?? null,
          name: input.name as string,
          rank,
          due_date: input.due_date ?? null,
          status: input.status ?? 'planned',
          reached_at: input.status === 'reached' ? new Date() : null,
          owner_membership_id: (await this.ownerId(tx, input.owner, '/owner')) ?? null,
        })
        .execute();
      await this.workAudit(
        tx,
        caller,
        p,
        'milestone.created',
        { recordId: env.id, type: 'milestone', publicId: env.publicId },
        [
          change.content('name', { hash: contentHash(input.name) }),
          change.plain('project', null, project.publicId),
        ],
        project.brand.id,
      );
      await this.workEvent(
        tx,
        caller,
        p,
        'work.milestone.created',
        { type: 'work.milestone', id: env.id, sequence: 0 },
        { project_id: project.id, phase_id: phase?.id ?? null },
        project.brand.id,
      );
      return { id: env.publicId, type: 'milestone' };
    });
  }

  async updateMilestone(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    ms: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseMilestone(body, true);
    return this.rendered(caller, ws, prj, req, 'milestone.update', async (tx, p) => {
      const project = await this.editableProject(tx, p, prj);
      const row = await this.loadChild(tx, project, 'milestone', ms, true);
      if (req.ifMatch === undefined) throw new TenancyError('precondition_required');
      requireVersion(parseIfMatch(req.ifMatch), row.version);
      if (row.lifecycleState !== 'active') throw new TenancyError('conflict');
      const set: Record<string, unknown> = {
        updated_at: new Date(),
        updated_by_membership_id: p.membershipId,
        version: row.version + 1,
      };
      const changes = [];
      if (input.name !== undefined) {
        set.name = input.name;
        changes.push(change.content('name', { hash: contentHash(input.name) }));
      }
      if (input.due_date !== undefined) {
        set.due_date = input.due_date;
        changes.push(change.plain('due_date', null, input.due_date));
      }
      if (input.status !== undefined) {
        set.status = input.status;
        set.reached_at = input.status === 'reached' ? new Date() : null;
        changes.push(change.plain('status', null, input.status));
      }
      if (input.phase !== undefined) {
        set.phase_id = input.phase
          ? (await this.loadChild(tx, project, 'phase', input.phase)).id
          : null;
        changes.push(change.plain('phase', null, input.phase));
      }
      const owner = await this.ownerId(tx, input.owner, '/owner');
      if (owner !== undefined) {
        set.owner_membership_id = owner;
        changes.push(change.plain('owner', null, input.owner ?? null));
      }
      await tx.db.updateTable('work.milestone').set(set).where('id', '=', row.id).execute();
      await this.workAudit(
        tx,
        caller,
        p,
        'milestone.updated',
        { recordId: row.id, type: 'milestone', publicId: row.publicId },
        changes,
        project.brand.id,
      );
      await this.workEvent(
        tx,
        caller,
        p,
        'work.milestone.updated',
        { type: 'work.milestone', id: row.id, sequence: row.version + 1 },
        {
          project_id: project.id,
          status: (input.status ?? null) as string | null,
          changed_fields: changes
            .map((c) => c.field)
            .sort()
            .join(','),
        },
        project.brand.id,
      );
      return { id: row.publicId, type: 'milestone' };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Criteria and scope entries (the project's own fields; ordered, mutable)
  // ---------------------------------------------------------------------------------------------

  protected async fieldProject(tx: WorkspaceTransaction, p: Principal, prj: unknown) {
    const project = await this.loadProject(tx, p, prj, { lock: true });
    this.requireProjectAction(p, 'record.update', project);
    this.requireActive(project);
    return project;
  }

  async addItem(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    table: 'criteria' | 'scope',
    body: unknown,
    req: Mutation,
  ) {
    const input = table === 'criteria' ? parseCriterion(body, false) : parseScopeItem(body, false);
    return this.rendered(caller, ws, prj, req, `${table}.add`, async (tx, p) => {
      const project = await this.fieldProject(tx, p, prj);
      const t = table === 'criteria' ? 'work.criteria_item' : 'work.scope_item';
      const id = newUuidV7();
      const publicId = newPublicId(table === 'criteria' ? 'cri' : 'sco');
      const rank = await this.nextRank(
        tx,
        t,
        (q) => q.where('project_id', '=', project.id).where('kind', '=', input.kind as string),
        'last',
      );
      await tx.db
        .insertInto(t)
        .values({
          id,
          public_id: publicId,
          workspace_id: tx.workspaceId,
          brand_id: project.brand.id,
          project_id: project.id,
          kind: input.kind as never,
          text: input.text as string,
          rank,
          ...(table === 'criteria' && 'met' in input && input.met
            ? { met: true, met_at: new Date(), met_by_membership_id: p.membershipId }
            : {}),
        } as never)
        .execute();
      await this.workAudit(
        tx,
        caller,
        p,
        `${table === 'criteria' ? 'criterion' : 'scope_item'}.added`,
        { recordId: project.id, type: 'project', publicId: project.publicId },
        [
          change.plain('kind', null, input.kind),
          change.content('text', { hash: contentHash(input.text) }),
        ],
        project.brand.id,
      );
      return { id: publicId, type: table === 'criteria' ? 'criteria_item' : 'scope_item' };
    });
  }

  async updateItem(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    table: 'criteria' | 'scope',
    ref: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = table === 'criteria' ? parseCriterion(body, true) : parseScopeItem(body, true);
    return this.rendered(caller, ws, prj, req, `${table}.update`, async (tx, p) => {
      const project = await this.fieldProject(tx, p, prj);
      const row = await this.loadItem(tx, project, table, ref, true);
      if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), row.version);
      const t = table === 'criteria' ? 'work.criteria_item' : 'work.scope_item';
      const set: Record<string, unknown> = { updated_at: new Date(), version: row.version + 1 };
      const changes = [];
      if (input.kind !== undefined) {
        set.kind = input.kind;
        changes.push(change.plain('kind', null, input.kind));
      }
      if (input.text !== undefined) {
        set.text = input.text;
        changes.push(change.content('text', { hash: contentHash(input.text) }));
      }
      if (table === 'criteria' && 'met' in input && input.met !== undefined) {
        set.met = input.met;
        set.met_at = input.met ? new Date() : null;
        set.met_by_membership_id = input.met ? p.membershipId : null;
        changes.push(change.plain('met', null, input.met));
      }
      await tx.db
        .updateTable(t)
        .set(set as never)
        .where('id', '=', row.id)
        .execute();
      await this.workAudit(
        tx,
        caller,
        p,
        `${table === 'criteria' ? 'criterion' : 'scope_item'}.updated`,
        { recordId: project.id, type: 'project', publicId: project.publicId },
        changes,
        project.brand.id,
      );
      return { id: row.publicId, type: table === 'criteria' ? 'criteria_item' : 'scope_item' };
    });
  }

  async removeItem(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    table: 'criteria' | 'scope',
    ref: unknown,
    req: Mutation,
  ) {
    return this.rendered(caller, ws, prj, req, `${table}.remove`, async (tx, p) => {
      const project = await this.fieldProject(tx, p, prj);
      const row = await this.loadItem(tx, project, table, ref, true);
      await tx.db
        .deleteFrom(table === 'criteria' ? 'work.criteria_item' : 'work.scope_item')
        .where('id', '=', row.id)
        .execute();
      await this.workAudit(
        tx,
        caller,
        p,
        `${table === 'criteria' ? 'criterion' : 'scope_item'}.removed`,
        { recordId: project.id, type: 'project', publicId: project.publicId },
        [change.plain('item', row.publicId, null)],
        project.brand.id,
      );
      return { id: row.publicId, type: table === 'criteria' ? 'criteria_item' : 'scope_item' };
    });
  }

  async moveItem(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    table: 'criteria' | 'scope',
    ref: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const after = parseAfter(body, table === 'criteria' ? 'cri' : 'sco');
    return this.rendered(caller, ws, prj, req, `${table}.move`, async (tx, p) => {
      const project = await this.fieldProject(tx, p, prj);
      const row = await this.loadItem(tx, project, table, ref, true);
      const afterRow = after ? await this.loadItem(tx, project, table, after) : null;
      if (afterRow && afterRow.kind !== row.kind)
        throw invalid(issue('/after', 'invalid_reference', 'Choose an entry of the same kind.'));
      const t = table === 'criteria' ? 'work.criteria_item' : 'work.scope_item';
      const rank = await this.nextRank(
        tx,
        t,
        (q) =>
          q
            .where('project_id', '=', project.id)
            .where('kind', '=', row.kind)
            .where('id', '<>', row.id),
        afterRow?.id ?? null,
      );
      await tx.db
        .updateTable(t)
        .set({ rank, version: row.version + 1, updated_at: new Date() } as never)
        .where('id', '=', row.id)
        .execute();
      return { id: row.publicId, type: table === 'criteria' ? 'criteria_item' : 'scope_item' };
    });
  }

  protected async loadItem(
    tx: WorkspaceTransaction,
    project: LoadedProject,
    table: 'criteria' | 'scope',
    ref: unknown,
    lock = false,
  ) {
    if (!isPublic(ref, table === 'criteria' ? 'cri' : 'sco')) throw new TenancyError('not_found');
    let q = tx.db
      .selectFrom(table === 'criteria' ? 'work.criteria_item' : 'work.scope_item')
      .select(['id', 'public_id', 'kind', 'version'])
      .where('public_id', '=', ref)
      .where('project_id', '=', project.id);
    if (lock) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    return {
      id: row.id,
      publicId: row.public_id,
      kind: row.kind as string,
      version: Number(row.version),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Updates (append-only) and verification (OD-16)
  // ---------------------------------------------------------------------------------------------

  async postUpdate(caller: Caller, ws: unknown, prj: unknown, body: unknown, req: Mutation) {
    const input = parseUpdate(body);
    return this.rendered(caller, ws, prj, req, 'update.post', async (tx, p) => {
      // Update history is not part of a share (ADR-0013 P5), so posting needs own authority.
      const project = await this.editableProject(tx, p, prj);
      const id = newUuidV7();
      const publicId = newPublicId('pup');
      await tx.db
        .insertInto('work.project_update')
        .values({
          id,
          public_id: publicId,
          workspace_id: tx.workspaceId,
          brand_id: project.brand.id,
          project_id: project.id,
          body: input.body,
          health: input.health,
          source_kind: 'human',
          author_membership_id: p.membershipId,
        })
        .execute();
      await this.workAudit(
        tx,
        caller,
        p,
        'project_update.posted',
        { recordId: project.id, type: 'project', publicId: project.publicId },
        [
          change.content('body', { hash: contentHash(input.body) }),
          change.plain('health', null, input.health),
        ],
        project.brand.id,
      );
      await this.workEvent(
        tx,
        caller,
        p,
        'work.project_update.posted',
        { type: 'work.project_update', id, sequence: 0 },
        { project_id: project.id, source_kind: 'human', health: input.health },
        project.brand.id,
      );
      return { id: publicId, type: 'project_update' };
    });
  }

  /** Explicit human verification as a separate append-only fact; authoring never verifies. */
  async verifyUpdate(caller: Caller, ws: unknown, prj: unknown, pup: unknown, req: Mutation) {
    return this.rendered(caller, ws, prj, req, 'update.verify', async (tx, p) => {
      const project = await this.loadProject(tx, p, prj, { lock: true });
      this.requireProjectAction(p, 'project.verify_update', project, { shares: false });
      if (p.kind !== 'member') throw new TenancyError('forbidden');
      this.requireActive(project);
      if (!isPublic(pup, 'pup')) throw new TenancyError('not_found');
      const u = await tx.db
        .selectFrom('work.project_update')
        .select(['id', 'public_id'])
        .where('public_id', '=', pup)
        .where('project_id', '=', project.id)
        .executeTakeFirst();
      if (!u) throw new TenancyError('not_found');
      const done = await tx.db
        .selectFrom('work.project_update_verification')
        .select('update_id')
        .where('update_id', '=', u.id)
        .executeTakeFirst();
      if (done)
        throw new TenancyError('conflict', {
          issues: [issue('/', 'already_verified', 'This update is already verified.')],
        });
      const auditId = await this.workAudit(
        tx,
        caller,
        p,
        'project_update.verified',
        { recordId: project.id, type: 'project', publicId: project.publicId },
        [change.plain('update', null, u.public_id)],
        project.brand.id,
      );
      await tx.db
        .insertInto('work.project_update_verification')
        .values({
          workspace_id: tx.workspaceId,
          update_id: u.id,
          project_id: project.id,
          verifier_membership_id: p.membershipId,
          audit_event_id: auditId,
        })
        .execute();
      await this.workEvent(
        tx,
        caller,
        p,
        'work.project_update.verified',
        { type: 'work.project_update', id: u.id, sequence: 1 },
        { project_id: project.id },
        project.brand.id,
      );
      return { id: u.public_id, type: 'project_update' };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Decisions and open questions (OD-15)
  // ---------------------------------------------------------------------------------------------

  async createDecision(caller: Caller, ws: unknown, prj: unknown, body: unknown, req: Mutation) {
    const input = parseDecision(body, false);
    return this.rendered(caller, ws, prj, req, 'decision.create', async (tx, p) => {
      const project = await this.editableProject(tx, p, prj);
      const env = await this.insertChildEnvelope(tx, caller, p, project, 'decision_record');
      const kind = input.kind ?? 'decision';
      await tx.db
        .insertInto('work.decision_record')
        .values({
          id: env.id,
          workspace_id: tx.workspaceId,
          brand_id: project.brand.id,
          scope_key: project.brand.id,
          project_id: project.id,
          kind,
          state: kind === 'decision' ? 'proposed' : 'open',
          statement: input.statement as string,
          outcome: input.outcome ?? null,
          owner_membership_id: (await this.ownerId(tx, input.owner, '/owner')) ?? null,
          due_date: input.due_date ?? null,
        })
        .execute();
      await this.workAudit(
        tx,
        caller,
        p,
        'decision.created',
        { recordId: env.id, type: 'decision_record', publicId: env.publicId },
        [
          change.plain('kind', null, kind),
          change.content('statement', { hash: contentHash(input.statement) }),
        ],
        project.brand.id,
      );
      await this.workEvent(
        tx,
        caller,
        p,
        'work.decision_record.created',
        { type: 'work.decision_record', id: env.id, sequence: 0 },
        { project_id: project.id, kind, state: kind === 'decision' ? 'proposed' : 'open' },
        project.brand.id,
      );
      return { id: env.publicId, type: 'decision_record' };
    });
  }

  async updateDecision(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    dec: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseDecision(body, true);
    return this.rendered(caller, ws, prj, req, 'decision.update', async (tx, p) => {
      const project = await this.editableProject(tx, p, prj);
      const row = await this.loadChild(tx, project, 'decision_record', dec, true);
      if (req.ifMatch === undefined) throw new TenancyError('precondition_required');
      requireVersion(parseIfMatch(req.ifMatch), row.version);
      const cur = await tx.db
        .selectFrom('work.decision_record')
        .selectAll()
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow();
      const set: Record<string, unknown> = {
        updated_at: new Date(),
        updated_by_membership_id: p.membershipId,
        version: row.version + 1,
      };
      const changes = [];
      if (input.statement !== undefined && input.statement !== null) {
        set.statement = input.statement;
        changes.push(change.content('statement', { hash: contentHash(input.statement) }));
      }
      if (input.outcome !== undefined) {
        set.outcome = input.outcome;
        changes.push(change.content('outcome', { hash: contentHash(input.outcome) }));
      }
      if (input.due_date !== undefined) {
        set.due_date = input.due_date;
        changes.push(change.plain('due_date', null, input.due_date));
      }
      const owner = await this.ownerId(tx, input.owner, '/owner');
      if (owner !== undefined) {
        set.owner_membership_id = owner;
        changes.push(change.plain('owner', null, input.owner ?? null));
      }
      if (input.state !== undefined && input.state !== cur.state) {
        const allowed =
          (cur.kind === 'decision' &&
            ((cur.state === 'proposed' && input.state === 'decided') ||
              (cur.state === 'decided' && input.state === 'superseded'))) ||
          (cur.kind === 'open_question' && cur.state === 'open' && input.state === 'resolved');
        if (!allowed)
          throw invalid(
            issue('/state', 'invalid_transition', 'That change of state is not allowed.'),
          );
        const outcome = (set.outcome as string | null | undefined) ?? cur.outcome;
        if ((input.state === 'decided' || input.state === 'resolved') && !outcome)
          throw invalid(
            issue(
              '/outcome',
              'required',
              input.state === 'decided' ? 'Record the decision.' : 'Record the answer.',
            ),
          );
        set.state = input.state;
        if (input.state === 'decided') set.decided_at = new Date();
        if (input.state === 'resolved') set.resolved_at = new Date();
        if (input.state === 'superseded') {
          if (!input.superseded_by)
            throw invalid(
              issue('/superseded_by', 'required', 'Choose the decision that replaces this one.'),
            );
          const by = await this.loadChild(tx, project, 'decision_record', input.superseded_by);
          if (by.id === row.id)
            throw invalid(
              issue('/superseded_by', 'invalid_reference', 'Choose a different decision.'),
            );
          set.superseded_by_id = by.id;
        }
        changes.push(change.plain('state', cur.state, input.state));
      }
      try {
        await tx.db.updateTable('work.decision_record').set(set).where('id', '=', row.id).execute();
      } catch (err) {
        if (pgCode(err) === '23514')
          throw invalid(
            issue('/state', 'invalid_transition', 'That change of state is not allowed.'),
          );
        throw err;
      }
      await this.workAudit(
        tx,
        caller,
        p,
        'decision.updated',
        { recordId: row.id, type: 'decision_record', publicId: row.publicId },
        changes,
        project.brand.id,
      );
      if (set.state)
        await this.workEvent(
          tx,
          caller,
          p,
          'work.decision_record.state_changed',
          { type: 'work.decision_record', id: row.id, sequence: row.version + 1 },
          { kind: cur.kind, state: set.state as string },
          project.brand.id,
        );
      return { id: row.publicId, type: 'decision_record' };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Dependencies (canonical relationships, OD-05)
  // ---------------------------------------------------------------------------------------------

  /** `project` is blocked by `target`. Both endpoints must be independently readable at creation. */
  async addDependency(caller: Caller, ws: unknown, prj: unknown, body: unknown, req: Mutation) {
    const input = parseDependency(body);
    return this.rendered(caller, ws, prj, req, 'dependency.add', async (tx, p) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'deps:' + tx.workspaceId}, 0))`.execute(
        tx.db,
      );
      const project = await this.loadProject(tx, p, prj, { lock: true });
      this.requireProjectAction(p, 'record.relate', project, { shares: false });
      this.requireActive(project);
      const target = await this.loadProject(tx, p, input.target);
      if (target.id === project.id)
        throw invalid(issue('/target', 'cycle', "A project can't depend on itself."));
      // Cycle check over 'blocks' edges (bounded recursion under the workspace dependency lock).
      const cycle = await sql<{ found: boolean }>`
        WITH RECURSIVE up(id, n) AS (
          SELECT from_record_id, 1 FROM relations.record_relationship WHERE to_record_id = ${target.id} AND kind = 'blocks'
          UNION
          SELECT r.from_record_id, up.n + 1 FROM relations.record_relationship r JOIN up ON r.to_record_id = up.id
           WHERE r.kind = 'blocks' AND up.n < 1000)
        SELECT EXISTS (SELECT 1 FROM up WHERE id = ${project.id}) AS found`.execute(tx.db);
      if (cycle.rows[0]?.found)
        throw invalid(
          issue('/target', 'cycle', 'This would make the projects wait on each other.'),
        );
      const id = newUuidV7();
      try {
        await tx.db
          .insertInto('relations.record_relationship')
          .values({
            id,
            workspace_id: tx.workspaceId,
            kind: 'blocks',
            from_record_id: target.id,
            to_record_id: project.id,
            from_brand_id: target.brand.id,
            to_brand_id: project.brand.id,
            created_by_membership_id: p.membershipId,
          })
          .execute();
      } catch (err) {
        if (pgCode(err) === '23505') return { id: target.publicId, type: 'project' };
        throw err;
      }
      await this.workAudit(
        tx,
        caller,
        p,
        'dependency.added',
        { recordId: project.id, type: 'project', publicId: project.publicId },
        [change.plain('blocked_by', null, target.publicId)],
        project.brand.id,
      );
      await writeOutboxEvent(tx, {
        type: 'relations.relationship.created',
        aggregate: { type: 'relations.record_relationship', id, sequence: 0 },
        data: { kind: 'blocks', from_record_id: target.id, to_record_id: project.id },
        actor: { type: 'human', id: p.membershipId },
        context: this.exec(caller, p),
        brandId: project.brand.id,
      });
      return { id: target.publicId, type: 'project' };
    });
  }

  async removeDependency(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    target: unknown,
    req: Mutation,
  ) {
    return this.rendered(caller, ws, prj, req, 'dependency.remove', async (tx, p) => {
      const project = await this.loadProject(tx, p, prj, { lock: true });
      this.requireProjectAction(p, 'record.relate', project, { shares: false });
      const t = await this.loadProject(tx, p, target);
      const rel = await tx.db
        .deleteFrom('relations.record_relationship')
        .where('from_record_id', '=', t.id)
        .where('to_record_id', '=', project.id)
        .where('kind', '=', 'blocks')
        .returning('id')
        .executeTakeFirst();
      if (!rel) throw new TenancyError('not_found');
      await this.workAudit(
        tx,
        caller,
        p,
        'dependency.removed',
        { recordId: project.id, type: 'project', publicId: project.publicId },
        [change.plain('blocked_by', t.publicId, null)],
        project.brand.id,
      );
      await writeOutboxEvent(tx, {
        type: 'relations.relationship.removed',
        aggregate: { type: 'relations.record_relationship', id: rel.id, sequence: 1 },
        data: { kind: 'blocks', from_record_id: t.id, to_record_id: project.id },
        actor: { type: 'human', id: p.membershipId },
        context: this.exec(caller, p),
        brandId: project.brand.id,
      });
      return { id: t.publicId, type: 'project' };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Templates and duplicate (PRJ-001/014/015)
  // ---------------------------------------------------------------------------------------------

  async listTemplates(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const vis = await compileVisibility(tx, p, {
        need: 'view',
        arrayMax: this.c.settings.principalContextArrayMax,
      });
      const rows = await tx.db
        .selectFrom('core.record as r')
        .innerJoin('templates.template as t', (j) =>
          j.onRef('t.workspace_id', '=', 'r.workspace_id').onRef('t.id', '=', 'r.id'),
        )
        .innerJoin('templates.template_version as v', 'v.id', 't.current_version_id')
        .leftJoin('core.record as br', 'br.id', 't.brand_id')
        .select(['r.public_id', 't.name', 'v.item_count', 'br.public_id as brand'])
        .where(vis.where('r'))
        .orderBy('t.name')
        .limit(200)
        .execute();
      return rows.map((r) => ({
        id: r.public_id,
        type: 'template' as const,
        name: r.name,
        item_count: r.item_count,
        brand: r.brand,
      }));
    });
  }

  async createTemplateFromProject(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseTemplateFromProject(body);
    return this.mutate(
      caller,
      'template.create',
      ws,
      req,
      async (tx, p) => {
        const project = await this.loadProject(tx, p, prj);
        if (project.ownLevel === null) throw new TenancyError('not_found');
        const o = decideBrand(p, 'templates.manage', {
          ...project.brand,
          lifecycleState: 'active',
        });
        this.decision('templates.manage', o);
        if (!o.allowed) throw new TenancyError(o.code);
        const pkg = await serializeProject(tx, project.id, this.ws.templateItemsMax);
        const id = newUuidV7();
        const publicId = newPublicId('tpl');
        const brandId = input.scope === 'brand' ? project.brand.id : null;
        const cmd = this.cmd(caller, p, brandId);
        await tx.db
          .insertInto('core.record')
          .values({
            id,
            public_id: publicId,
            record_type: 'template',
            workspace_id: tx.workspaceId,
            brand_id: brandId,
            source_kind: 'ui',
            source_ref: null,
            created_by_actor_type: cmd.actor.type,
            created_by_actor_id: cmd.actor.id,
          })
          .execute();
        const versionId = newUuidV7();
        await tx.db
          .insertInto('templates.template')
          .values({
            id,
            workspace_id: tx.workspaceId,
            brand_id: brandId,
            scope_key: brandId ?? tx.workspaceId,
            name: input.name,
            target_record_type: 'project',
            current_version_id: versionId,
            created_by_membership_id: p.membershipId,
          })
          .execute();
        const count =
          1 +
          pkg.phases.length +
          pkg.milestones.length +
          pkg.criteria.length +
          pkg.scope_items.length;
        await tx.db
          .insertInto('templates.template_version')
          .values({
            id: versionId,
            workspace_id: tx.workspaceId,
            template_id: id,
            version_number: 1,
            schema_version: 1,
            content: JSON.stringify(pkg),
            item_count: count,
            created_from_record_type: 'project',
            created_by_membership_id: p.membershipId,
          })
          .execute();
        await this.workWriter.write(tx, cmd, {
          action: 'template.created',
          target: { recordId: id, type: 'template', publicId },
          changes: [
            change.content('name', { hash: contentHash(input.name) }),
            change.plain('item_count', null, count),
            change.plain('from_project', null, project.publicId),
          ],
        });
        await writeOutboxEvent(tx, {
          type: 'templates.template.created',
          aggregate: { type: 'templates.template', id, sequence: 0 },
          data: { target_record_type: 'project', item_count: count },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          ...(brandId ? { brandId } : {}),
        });
        const data = {
          id: publicId,
          type: 'template' as const,
          name: input.name,
          item_count: count,
          not_copied: [...NOT_COPIED],
        };
        return { status: 201, ref: { id: publicId, type: 'template' }, data };
      },
      async (tx, _p, ref) => {
        const t = await tx.db
          .selectFrom('core.record as r')
          .innerJoin('templates.template as t', 't.id', 'r.id')
          .innerJoin('templates.template_version as v', 'v.id', 't.current_version_id')
          .select(['r.public_id', 't.name', 'v.item_count'])
          .where('r.public_id', '=', ref.id)
          .executeTakeFirstOrThrow();
        return {
          id: t.public_id,
          type: 'template' as const,
          name: t.name,
          item_count: t.item_count,
          not_copied: [...NOT_COPIED],
        };
      },
    );
  }

  protected override async instantiateTemplate(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    input: {
      templatePublicId: string;
      brandId: string;
      parent: LoadedProject | null;
      overrides: Record<string, unknown>;
    },
  ) {
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const t = await tx.db
      .selectFrom('core.record as r')
      .innerJoin('templates.template as t', (j) =>
        j.onRef('t.workspace_id', '=', 'r.workspace_id').onRef('t.id', '=', 'r.id'),
      )
      .innerJoin('templates.template_version as v', 'v.id', 't.current_version_id')
      .select(['t.id', 't.brand_id', 'v.id as version_id', 'v.content'])
      .where('r.public_id', '=', input.templatePublicId)
      .where('r.lifecycle_state', '=', 'active')
      .where(vis.where('r'))
      .executeTakeFirst();
    // Unknown, foreign, and unreadable templates are one refusal; a brand template stays in its brand.
    if (!t || (t.brand_id !== null && t.brand_id !== input.brandId))
      throw invalid(issue('/template', 'invalid_reference', "That template isn't available."));
    const pkg = readPackage(
      typeof t.content === 'string' ? JSON.parse(t.content) : t.content,
      this.ws.templateItemsMax,
    );
    const created = await this.instantiate(tx, caller, p, {
      brandId: input.brandId,
      parent: input.parent,
      pkg,
      name: (input.overrides.name as string | undefined) ?? pkg.project.name,
      start: (input.overrides.start_date as string | null | undefined) ?? null,
      templateVersionId: t.version_id,
      source: 'template',
    });
    return created;
  }

  protected async instantiate(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    input: {
      brandId: string;
      parent: LoadedProject | null;
      pkg: TemplatePackage;
      name: string;
      start: string | null;
      templateVersionId: string | null;
      source: 'template' | 'ui';
    },
  ): Promise<{ id: string; publicId: string; copied: Copied }> {
    const rank = await this.nextRank(
      tx,
      'work.project',
      (q) =>
        input.parent
          ? q.where('parent_project_id', '=', input.parent.id)
          : q.where('parent_project_id', 'is', null).where('brand_id', '=', input.brandId),
      'last',
    );
    return instantiatePackage(
      tx,
      {
        writer: this.workWriter,
        exec: this.exec(caller, p),
        source: { kind: input.source },
        ownerMembershipId: p.membershipId,
        grantManager: async (t, projectId, membershipId) => {
          await this.ensureManagerGrant(t, projectId, membershipId, p.membershipId);
        },
      },
      {
        brandId: input.brandId,
        parent: input.parent
          ? {
              id: input.parent.id,
              ancestorIds: input.parent.row.ancestor_ids,
              depth: input.parent.row.depth,
            }
          : null,
        depthMax: this.ws.projectDepthMax,
        maxItems: this.ws.templateItemsMax,
        pkg: input.pkg,
        overrides: { name: input.name, start_date: input.start },
        rank,
        templateVersionId: input.templateVersionId,
      },
    );
  }

  /** Duplicates the project's own structure (never people, shares, history, or links). */
  async duplicateProject(caller: Caller, ws: unknown, prj: unknown, body: unknown, req: Mutation) {
    const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    for (const k of Object.keys(b))
      if (k !== 'name')
        throw invalid(issue(`/${k}`, 'unsupported_field', 'This field is not supported.'));
    const name =
      b.name === undefined
        ? null
        : typeof b.name === 'string' && b.name.trim()
          ? b.name.trim().slice(0, 200)
          : undefined;
    if (name === undefined) throw invalid(issue('/name', 'required', 'Project name is required.'));
    return this.mutate(
      caller,
      'project.duplicate',
      ws,
      req,
      async (tx, p) => {
        const source = await this.loadProject(tx, p, prj);
        if (source.ownLevel === null) throw new TenancyError('not_found');
        const parent = source.row.parent_project_id
          ? await this.loadProject(
              tx,
              p,
              (
                await tx.db
                  .selectFrom('core.record')
                  .select('public_id')
                  .where('id', '=', source.row.parent_project_id)
                  .executeTakeFirstOrThrow()
              ).public_id,
            ).catch(() => null)
          : null;
        if (parent) this.requireProjectScope(p, 'record.create', parent);
        else {
          const o = decideBrand(p, 'record.create', { ...source.brand, lifecycleState: 'active' });
          this.decision('record.create', o);
          if (!o.allowed) throw new TenancyError(o.code === 'not_found' ? 'forbidden' : o.code);
        }
        const pkg = await serializeProject(tx, source.id, this.ws.templateItemsMax);
        const created = await this.instantiate(tx, caller, p, {
          brandId: source.brand.id,
          parent,
          pkg,
          name: name ?? `Copy of ${source.row.name}`.slice(0, 200),
          start: source.row.start_date,
          templateVersionId: null,
          source: 'ui',
        });
        const view = await this.projectView(tx, p, await this.loadProject(tx, p, created.publicId));
        return {
          status: 201,
          ref: { id: created.publicId, type: 'project' },
          data: {
            id: created.publicId,
            type: 'project',
            project: view,
            copied: created.copied as Copied | null,
            not_copied: [...NOT_COPIED],
          },
        };
      },
      async (tx, p, ref) => ({
        id: ref.id,
        type: 'project',
        project: await this.projectView(tx, p, await this.loadProject(tx, p, ref.id)),
        copied: null as Copied | null,
        not_copied: [...NOT_COPIED],
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Recurrence (OD-14): planning-owned series with an immutable snapshot
  // ---------------------------------------------------------------------------------------------

  async listRecurrences(caller: Caller, ws: unknown, prj: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const project = await this.loadProject(tx, p, prj);
      if (project.ownLevel === null) throw new TenancyError('not_found');
      const rows = await tx.db
        .selectFrom('planning.recurrence_series')
        .select([
          'public_id',
          'state',
          'rrule',
          'anchor_tz',
          'dtstart_local',
          'generated_through',
          'next_due_at',
          'payload_item_count',
          'version',
        ])
        .where('source_record_id', '=', project.id)
        .orderBy('created_at')
        .execute();
      return rows.map((r) => seriesView(r));
    });
  }

  async defineRecurrence(caller: Caller, ws: unknown, prj: unknown, body: unknown, req: Mutation) {
    const input = parseRecurrence(body);
    let rule;
    try {
      rule = parseRule(input.rrule);
    } catch (err) {
      if (err instanceof RuleError)
        throw invalid(issue('/rrule', 'invalid_rule', 'Choose how often this repeats.'));
      throw err;
    }
    return this.mutate(
      caller,
      'recurrence.define',
      ws,
      req,
      async (tx, p) => {
        const project = await this.loadProject(tx, p, prj, { lock: true });
        this.requireProjectAction(p, 'project.manage_recurrence', project, { shares: false });
        const o = decideBrand(p, 'record.create', { ...project.brand, lifecycleState: 'active' });
        this.decision('record.create', o);
        if (!o.allowed) throw new TenancyError('forbidden');
        // The snapshot is frozen once here and never updated (database guard).
        const pkg = await serializeProject(tx, project.id, this.ws.templateItemsMax);
        const first = occurrences(rule, input.start, null, 1)[0];
        if (!first)
          throw invalid(
            issue('/ends', 'ends_before_first', 'This schedule ends before its first occurrence.'),
          );
        const id = newUuidV7();
        const publicId = newPublicId('rcs');
        const count =
          1 +
          pkg.phases.length +
          pkg.milestones.length +
          pkg.criteria.length +
          pkg.scope_items.length;
        await tx.db
          .insertInto('planning.recurrence_series')
          .values({
            id,
            public_id: publicId,
            workspace_id: tx.workspaceId,
            brand_id: project.brand.id,
            target_kind: 'project',
            source_record_id: project.id,
            rrule: input.rrule,
            anchor_tz: input.anchor_tz,
            dtstart_local: input.start,
            template_payload: JSON.stringify(pkg),
            payload_item_count: count,
            next_due_at: localToUtc(first, input.anchor_tz),
            owner_membership_id: p.membershipId,
          })
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'recurrence.defined',
          { recordId: project.id, type: 'project', publicId: project.publicId },
          [
            change.plain('series', null, publicId),
            change.plain('rrule', null, input.rrule),
            change.plain('anchor_tz', null, input.anchor_tz),
          ],
          project.brand.id,
        );
        await writeOutboxEvent(tx, {
          type: 'planning.recurrence_series.defined',
          aggregate: { type: 'planning.recurrence_series', id, sequence: 0 },
          data: { target_kind: 'project' },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: project.brand.id,
        });
        const row = await tx.db
          .selectFrom('planning.recurrence_series')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return {
          status: 201,
          ref: { id: publicId, type: 'recurrence_series' },
          data: seriesView(row),
        };
      },
      async (tx, _p, ref) =>
        seriesView(
          await tx.db
            .selectFrom('planning.recurrence_series')
            .selectAll()
            .where('public_id', '=', ref.id)
            .executeTakeFirstOrThrow(),
        ),
    );
  }

  protected async loadSeries(tx: WorkspaceTransaction, project: LoadedProject, rcs: unknown) {
    if (!isPublic(rcs, 'rcs')) throw new TenancyError('not_found');
    const s = await tx.db
      .selectFrom('planning.recurrence_series')
      .selectAll()
      .where('public_id', '=', rcs)
      .where('source_record_id', '=', project.id)
      .forUpdate()
      .executeTakeFirst();
    if (!s) throw new TenancyError('not_found');
    return s;
  }

  async setRecurrenceState(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    rcs: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const state =
      typeof body === 'object' && body !== null ? (body as { state?: unknown }).state : undefined;
    if (state !== 'active' && state !== 'paused')
      throw invalid(issue('/state', 'invalid_option', 'Choose pause or resume.'));
    return this.mutate(
      caller,
      'recurrence.state',
      ws,
      req,
      async (tx, p) => {
        const project = await this.loadProject(tx, p, prj, { lock: true });
        this.requireProjectAction(p, 'project.manage_recurrence', project, { shares: false });
        const s = await this.loadSeries(tx, project, rcs);
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), Number(s.version));
        if (s.state !== state) {
          // Resuming skips occurrences missed while paused: the next one after now.
          const rule = parseRule(s.rrule);
          const nowLocal = utcToLocal(new Date(), s.anchor_tz);
          const after = [s.generated_through ? fmtTs(s.generated_through) : null, nowLocal]
            .filter(Boolean)
            .sort()
            .at(-1)!;
          const next =
            state === 'active' ? occurrences(rule, fmtTs(s.dtstart_local), after, 1)[0] : undefined;
          await tx.db
            .updateTable('planning.recurrence_series')
            .set({
              state,
              next_due_at: next ? localToUtc(next, s.anchor_tz) : null,
              updated_at: new Date(),
              version: Number(s.version) + 1,
            })
            .where('id', '=', s.id)
            .execute();
          await this.workAudit(
            tx,
            caller,
            p,
            'recurrence.state_changed',
            { recordId: project.id, type: 'project', publicId: project.publicId },
            [change.plain('state', s.state, state)],
            project.brand.id,
          );
          await writeOutboxEvent(tx, {
            type: 'planning.recurrence_series.state_changed',
            aggregate: {
              type: 'planning.recurrence_series',
              id: s.id,
              sequence: Number(s.version) + 1,
            },
            data: { state },
            actor: { type: 'human', id: p.membershipId },
            context: this.exec(caller, p),
            brandId: project.brand.id,
          });
        }
        const row = await tx.db
          .selectFrom('planning.recurrence_series')
          .selectAll()
          .where('id', '=', s.id)
          .executeTakeFirstOrThrow();
        return {
          status: 200,
          ref: { id: s.public_id, type: 'recurrence_series' },
          data: seriesView(row),
        };
      },
      async (tx, _p, ref) =>
        seriesView(
          await tx.db
            .selectFrom('planning.recurrence_series')
            .selectAll()
            .where('public_id', '=', ref.id)
            .executeTakeFirstOrThrow(),
        ),
    );
  }

  /** Manual "next occurrence": generates the next one now, idempotently by occurrence key. */
  async generateNextOccurrence(
    caller: Caller,
    ws: unknown,
    prj: unknown,
    rcs: unknown,
    req: Mutation,
  ) {
    return this.mutate(
      caller,
      'recurrence.generate',
      ws,
      req,
      async (tx, p) => {
        const project = await this.loadProject(tx, p, prj, { lock: true });
        this.requireProjectAction(p, 'project.manage_recurrence', project, { shares: false });
        const o = decideBrand(p, 'record.create', { ...project.brand, lifecycleState: 'active' });
        this.decision('record.create', o);
        if (!o.allowed) throw new TenancyError('forbidden');
        const s = await this.loadSeries(tx, project, rcs);
        const out = await generateOccurrences(tx, {
          series: s,
          limit: 1,
          due: null,
          depthMax: this.ws.projectDepthMax,
          maxItems: this.ws.templateItemsMax,
          context: {
            writer: this.workWriter,
            exec: this.exec(caller, p),
            source: { kind: 'template' },
            ownerMembershipId: s.owner_membership_id,
            grantManager: async (t, projectId, membershipId) => {
              await this.ensureManagerGrant(t, projectId, membershipId, p.membershipId);
            },
          },
        });
        this.d.metrics.count('work.recurrence.occurrences', out.generated.length, {
          outcome: 'manual',
        });
        const created = out.generated[0] ?? null;
        const row = await tx.db
          .selectFrom('planning.recurrence_series')
          .selectAll()
          .where('id', '=', s.id)
          .executeTakeFirstOrThrow();
        return {
          status: created ? 201 : 200,
          ref: { id: s.public_id, type: 'recurrence_series' },
          data: {
            id: s.public_id,
            type: 'recurrence_series',
            series: seriesView(row),
            occurrence: created,
          },
        };
      },
      async (tx, _p, ref) => ({
        id: ref.id,
        type: 'recurrence_series',
        series: seriesView(
          await tx.db
            .selectFrom('planning.recurrence_series')
            .selectAll()
            .where('public_id', '=', ref.id)
            .executeTakeFirstOrThrow(),
        ),
        occurrence: null,
      }),
    );
  }
}

type SeriesRow = {
  id: string;
  public_id: string;
  brand_id: string;
  state: string;
  rrule: string;
  anchor_tz: string;
  dtstart_local: string | Date;
  generated_through: string | Date | null;
  next_due_at: Date | string | null;
  payload_item_count: number;
  template_payload: unknown;
  owner_membership_id: string;
  version: number | string;
};

/** Local timestamps come back as Date (server zone) or text; normalize to `YYYY-MM-DDTHH:mm`. */
export function fmtTs(v: string | Date): string {
  if (v instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}T${pad(v.getHours())}:${pad(v.getMinutes())}`;
  }
  return v.replace(' ', 'T').slice(0, 16);
}

/**
 * A series for people: the structured rule, the next occurrence as local intent (anchor zone) and
 * as an instant, and a status. `catching_up` means occurrences are due now and wait for the next
 * job run (bounded catch-up); `ended` means the end condition has no further occurrence.
 */
function seriesView(
  r: Pick<
    SeriesRow,
    | 'public_id'
    | 'state'
    | 'rrule'
    | 'anchor_tz'
    | 'dtstart_local'
    | 'generated_through'
    | 'next_due_at'
    | 'payload_item_count'
    | 'version'
  >,
  now = new Date(),
) {
  const rule = describeRule(r.rrule);
  const start = fmtTs(r.dtstart_local);
  const through = r.generated_through ? fmtTs(r.generated_through) : null;
  const nextLocal = occurrences(parseRule(r.rrule), start, through, 1)[0] ?? null;
  const due = r.next_due_at ? new Date(r.next_due_at) : null;
  const status =
    r.state === 'paused'
      ? 'paused'
      : nextLocal === null
        ? 'ended'
        : due && due <= now
          ? 'catching_up'
          : 'active';
  return {
    id: r.public_id,
    type: 'recurrence_series' as const,
    state: r.state,
    status,
    rule: {
      frequency: rule.frequency,
      interval: rule.interval,
      weekdays: rule.weekdays,
      month_days: rule.monthDays,
      ends: rule.ends,
    },
    rrule: r.rrule,
    anchor_tz: r.anchor_tz,
    start,
    generated_through: through,
    next_occurrence: r.state === 'paused' ? null : nextLocal,
    next_due_at: due ? due.toISOString() : null,
    item_count: r.payload_item_count,
    version: Number(r.version),
  };
}

/**
 * Generates occurrences after the series cursor: at most `limit`, only those due by `due` (null =
 * the next one regardless of time). Each occurrence is one project from the frozen snapshot with
 * the stable occurrence key; an already generated key is skipped (idempotent). Advances
 * `generated_through` and `next_due_at` in the same transaction.
 */
export async function generateOccurrences(
  tx: WorkspaceTransaction,
  input: {
    series: SeriesRow;
    limit: number;
    due: Date | null;
    depthMax: number;
    maxItems: number;
    context: Parameters<typeof instantiatePackage>[1];
  },
): Promise<{ generated: Array<{ id: string; occurrence_key: string }>; more: boolean }> {
  const s = input.series;
  const rule = parseRule(s.rrule);
  const start = fmtTs(s.dtstart_local);
  const cursor = s.generated_through ? fmtTs(s.generated_through) : null;
  const through = input.due ? utcToLocal(input.due, s.anchor_tz) : null;
  const keys = occurrences(rule, start, cursor, input.limit + 1, through);
  const now = keys.slice(0, input.limit);
  const pkg = readPackage(
    typeof s.template_payload === 'string' ? JSON.parse(s.template_payload) : s.template_payload,
    input.maxItems,
  );
  const generated: Array<{ id: string; occurrence_key: string }> = [];
  for (const key of now) {
    const exists = await tx.db
      .selectFrom('work.project as w')
      .innerJoin('core.record as r', 'r.id', 'w.id')
      .select('r.public_id')
      .where('w.recurrence_series_id', '=', s.id)
      .where('w.occurrence_key', '=', key)
      .executeTakeFirst();
    if (exists) continue;
    const ranks = await tx.db
      .selectFrom('work.project')
      .select((eb) => eb.fn.max('rank').as('r'))
      .where('parent_project_id', 'is', null)
      .where('brand_id', '=', s.brand_id)
      .executeTakeFirst();
    const { rankBetween } = await import('@pm/contracts/shell');
    const rank = rankBetween((ranks?.r as string | null) ?? null, null) ?? 'z';
    const created = await instantiatePackage(tx, input.context, {
      brandId: s.brand_id,
      parent: null,
      depthMax: input.depthMax,
      maxItems: input.maxItems,
      pkg,
      overrides: { name: pkg.project.name, start_date: key.slice(0, 10) },
      rank,
      recurrence: { seriesId: s.id, occurrenceKey: key },
    });
    await writeOutboxEvent(tx, {
      type: 'planning.occurrence.generated',
      aggregate: { type: 'planning.recurrence_series', id: s.id, sequence: Number(s.version) + 1 },
      data: { occurrence_key: key, record_id: created.id },
      actor: {
        type: input.context.exec.effectivePrincipal.type === 'member' ? 'human' : 'system',
        id: input.context.exec.effectivePrincipal.id,
      },
      context: input.context.exec,
      brandId: s.brand_id,
    });
    generated.push({ id: created.publicId, occurrence_key: key });
  }
  const last = now.at(-1) ?? cursor;
  const next = last ? occurrences(rule, start, last, 1)[0] : occurrences(rule, start, null, 1)[0];
  await tx.db
    .updateTable('planning.recurrence_series')
    .set({
      generated_through: last ? last.replace('T', ' ') : null,
      next_due_at: s.state === 'active' && next ? localToUtc(next, s.anchor_tz) : null,
      updated_at: new Date(),
      version: Number(s.version) + 1,
    })
    .where('id', '=', s.id)
    .execute();
  return { generated, more: keys.length > input.limit };
}

export { findBrand };
