import { createHash } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type StoredChange, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import {
  brandMarker,
  decideBrand,
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
import { type LoadedProject } from './service.ts';
import { TaskCoreService, todayIn, type LoadedTask } from './task-core.ts';
import {
  normalizeLabel,
  parseChecklistItem,
  parseInherited,
  parseLabel,
  parseLabelRef,
  parseLink,
  parseRelationship,
  parseTaskCriterion,
} from './task-validation.ts';
import { isObject, isPublic, parseAfter } from './validation.ts';
import { fieldsForRecord } from './workflow/field-access.ts';

const pgCode = (err: unknown) =>
  typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
const hashText = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

/**
 * Record types a task link may target (TSK-017). Documents, files, and external records register
 * here when their owning phases exist (4C, 4E, 6A); until then only the test-only fixture type is
 * linkable, so the adapter is exercised without fabricating later records.
 */
export const LINK_TARGET_TYPES: ReadonlySet<string> = new Set<string>([]);
const linkableType = (recordType: string, testOnly: boolean) =>
  testOnly || LINK_TARGET_TYPES.has(recordType);

type ItemTable = 'checklist' | 'criteria' | 'links';
const ITEM = {
  checklist: { table: 'work.checklist_item', prefix: 'chk', key: 'task_id' },
  criteria: { table: 'work.criteria_item', prefix: 'cri', key: 'task_id' },
  links: { table: 'relations.record_link', prefix: 'lnk', key: 'source_record_id' },
} as const;

/**
 * Phase 2B tasks, part two: the task page detail, checklists, task criteria and inherited project
 * definition of done, labels, links, relationships, the history projection, and the project
 * rollups tasks feed (OD-13 completion, PRJ-021 facts).
 */
export class TaskService extends TaskCoreService {
  // ---------------------------------------------------------------------------------------------
  // Detail
  // ---------------------------------------------------------------------------------------------

  /**
   * The task page. Sections are authorized independently: a share-only reader gets the task, its
   * checklist, and its own criteria; subtasks, inherited criteria, links, and relationships need
   * the reader's own authority, and every counterpart is re-authorized (AZ-22).
   */
  async taskDetail(caller: Caller, ws: unknown, tsk: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const t = await this.loadTask(tx, p, tsk);
      const own = t.ownLevel !== null;
      const checklist = await tx.db
        .selectFrom('work.checklist_item')
        .select(['public_id', 'text', 'done', 'done_at', 'version'])
        .where('task_id', '=', t.id)
        .orderBy('rank')
        .orderBy('id')
        .execute();
      const criteria = await tx.db
        .selectFrom('work.criteria_item')
        .select(['public_id', 'kind', 'text', 'met', 'met_at', 'required', 'version'])
        .where('task_id', '=', t.id)
        .orderBy('kind')
        .orderBy('rank')
        .orderBy('id')
        .execute();
      const inherited =
        own && t.row.project_id
          ? await tx.db
              .selectFrom('work.criteria_item as c')
              .leftJoin('work.task_inherited_criterion as x', (j) =>
                j.onRef('x.criteria_item_id', '=', 'c.id').on('x.task_id', '=', t.id),
              )
              .select(['c.public_id', 'c.text', 'x.state'])
              .where('c.project_id', '=', t.row.project_id)
              .where('c.owner_kind', '=', 'project')
              .where('c.kind', '=', 'definition_of_done')
              .orderBy('c.rank')
              .orderBy('c.id')
              .execute()
          : [];
      const vis = await this.taskVisibility(tx, p, true);
      const subtasks = own
        ? await tx.db
            .selectFrom('work.task as c')
            .innerJoin('core.record as r', (j) =>
              j.onRef('r.workspace_id', '=', 'c.workspace_id').onRef('r.id', '=', 'c.id'),
            )
            .select(['r.public_id', 'c.title', 'c.status_id', 'r.lifecycle_state'])
            .where('c.parent_task_id', '=', t.id)
            .where(vis.where('r', { project: sql`c.project_id` }))
            .orderBy(sql`c.rank COLLATE "C"`)
            .orderBy('c.id')
            .execute()
        : [];
      const links = own ? await this.readableLinks(tx, p, t) : [];
      const relationships = own
        ? await this.readableRelationships(tx, p, t)
        : { blocks: [], blocked_by: [], related: [] };
      return {
        task: await this.taskView(tx, p, t),
        checklist: checklist.map((c) => ({
          id: c.public_id,
          text: c.text,
          done: c.done,
          done_at: c.done_at ? new Date(c.done_at).toISOString() : null,
          version: Number(c.version),
        })),
        criteria: criteria.map((c) => ({
          id: c.public_id,
          kind: c.kind,
          text: c.text,
          met: c.met,
          required: c.required,
          met_at: c.met_at ? new Date(c.met_at).toISOString() : null,
          version: Number(c.version),
        })),
        inherited_criteria: inherited.map((c) => ({
          id: c.public_id,
          text: c.text,
          state: c.state ?? 'open',
        })),
        subtasks: subtasks.map((s) => ({
          id: s.public_id,
          title: s.title,
          status: this.taskStatusView(s.status_id, tx),
          lifecycle_state: s.lifecycle_state,
        })),
        links,
        relationships,
        // Honest absences (later phases); nothing is fabricated.
        unavailable: [
          'comments',
          'followers',
          'files',
          'documents',
          'external_records',
          'agents',
        ],
      };
    });
  }

  protected async readableLinks(tx: WorkspaceTransaction, p: Principal, t: LoadedTask) {
    const rows = await tx.db
      .selectFrom('relations.record_link as l')
      .leftJoin('core.record as r', 'r.id', 'l.target_record_id')
      .select([
        'l.public_id',
        'l.target_kind',
        'l.url',
        'l.title',
        'l.version',
        'l.target_record_id',
        'r.public_id as target_public',
        'r.record_type',
      ])
      .where('l.source_record_id', '=', t.id)
      .orderBy('l.rank')
      .orderBy('l.id')
      .execute();
    const vis = await this.taskVisibility(tx, p, true);
    const recordIds = rows.filter((r) => r.target_record_id).map((r) => r.target_record_id!);
    const readable = recordIds.length
      ? new Set(
          (
            await tx.db
              .selectFrom('core.record as r')
              .select('r.id')
              .where('r.id', 'in', recordIds)
              .where(vis.where('r'))
              .execute()
          ).map((r) => r.id),
        )
      : new Set<string>();
    // A link to a record the reader cannot read is omitted entirely (no title, type, or count).
    return rows
      .filter((r) => r.target_kind === 'url' || readable.has(r.target_record_id!))
      .map((r) =>
        r.target_kind === 'url'
          ? {
              id: r.public_id,
              kind: 'url' as const,
              url: r.url!,
              title: r.title,
              version: Number(r.version),
            }
          : {
              id: r.public_id,
              kind: 'record' as const,
              record: { id: r.target_public!, type: r.record_type! },
              title: r.title,
              version: Number(r.version),
            },
      );
  }

  /** Relationship endpoints re-authorized at display; unreadable counterparts vanish (OD-05). */
  protected async readableRelationships(tx: WorkspaceTransaction, p: Principal, t: LoadedTask) {
    const vis = await this.taskVisibility(tx, p, true);
    const side = (
      mine: 'from_record_id' | 'to_record_id',
      other: 'from_record_id' | 'to_record_id',
      kind: 'blocks' | 'related',
    ) =>
      tx.db
        .selectFrom('relations.record_relationship as rel')
        .innerJoin('core.record as r', (j) =>
          j.onRef('r.workspace_id', '=', 'rel.workspace_id').onRef('r.id', '=', `rel.${other}`),
        )
        .innerJoin('work.task as o', 'o.id', 'r.id')
        .innerJoin('tenancy.brand as b', 'b.id', 'o.brand_id')
        .innerJoin('core.record as br', 'br.id', 'b.id')
        .select([
          'r.public_id',
          'o.title',
          'o.status_id',
          'r.lifecycle_state',
          'br.public_id as brand_public',
          'b.name as brand_name',
          'b.short_name',
          'b.color',
          'b.icon',
          'b.lifecycle_state as brand_state',
        ])
        .where(`rel.${mine}`, '=', t.id)
        .where('rel.kind', '=', kind)
        .where('r.record_type', '=', 'task')
        .where(vis.where('r', { project: sql`o.project_id` }))
        .orderBy(sql`lower(o.title)`)
        .orderBy('r.public_id')
        .execute();
    const view = (rows: Awaited<ReturnType<typeof side>>) =>
      rows.map((r) => ({
        id: r.public_id,
        title: r.title,
        status: this.taskStatusView(r.status_id, tx),
        lifecycle_state: r.lifecycle_state,
        brand: brandMarker({
          public_id: r.brand_public,
          name: r.brand_name,
          short_name: r.short_name,
          color: r.color,
          icon: r.icon,
          lifecycle_state: r.brand_state,
        }),
      }));
    const related = [
      ...(await side('from_record_id', 'to_record_id', 'related')),
      ...(await side('to_record_id', 'from_record_id', 'related')),
    ];
    return {
      blocks: view(await side('from_record_id', 'to_record_id', 'blocks')),
      blocked_by: view(await side('to_record_id', 'from_record_id', 'blocks')),
      related: view(related),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Ordered task items: checklist, criteria, links
  // ---------------------------------------------------------------------------------------------

  protected async itemCount(tx: WorkspaceTransaction, kind: ItemTable, taskId: string) {
    const r = await tx.db
      .selectFrom(ITEM[kind].table)
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where(ITEM[kind].key, '=', taskId)
      .executeTakeFirstOrThrow();
    if (Number(r.n) >= this.ws.taskItemsMax)
      throw invalid(
        issue('/', 'limit_exceeded', `A task can hold at most ${this.ws.taskItemsMax} of these.`),
      );
  }

  protected async loadTaskItem(
    tx: WorkspaceTransaction,
    kind: ItemTable,
    t: LoadedTask,
    ref: unknown,
  ) {
    if (!isPublic(ref, ITEM[kind].prefix)) throw new TenancyError('not_found');
    const row = await tx.db
      .selectFrom(ITEM[kind].table)
      .selectAll()
      .where('public_id', '=', ref)
      .where(ITEM[kind].key, '=', t.id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    return row as Record<string, unknown> & {
      id: string;
      public_id: string;
      version: number | string;
    };
  }

  /** One small command wrapper: the task is rendered after any item change (with its version). */
  protected async taskItemCommand(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    req: Mutation,
    command: string,
    fn: (
      tx: WorkspaceTransaction,
      p: Principal,
    ) => Promise<{ id: string; type: string; task: string }>,
  ) {
    return this.mutate(
      caller,
      command,
      ws,
      req,
      async (tx, p) => {
        const ref = await fn(tx, p);
        return { status: 200, ref: { id: ref.id, type: ref.type }, data: ref };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: ref.type, task: tsk as string }),
    );
  }

  async addChecklistItem(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const input = parseChecklistItem(body, false);
    return this.taskItemCommand(caller, ws, tsk, req, 'checklist.add', async (tx, p) => {
      const t = await this.editableTask(tx, p, tsk);
      await this.itemCount(tx, 'checklist', t.id);
      const publicId = newPublicId('chk');
      const rank = await this.nextRank(
        tx,
        'work.checklist_item',
        (q) => q.where('task_id', '=', t.id),
        'last',
      );
      await tx.db
        .insertInto('work.checklist_item')
        .values({
          id: newUuidV7(),
          public_id: publicId,
          workspace_id: tx.workspaceId,
          brand_id: t.brand.id,
          task_id: t.id,
          text: input.text!,
          rank,
        })
        .execute();
      await this.bumpTask(tx, t, p);
      await this.taskAudit(tx, caller, p, 'checklist.added', t, [
        change.plain('item', null, publicId),
        change.content('item_text', { hash: hashText(input.text!) }),
      ]);
      return { id: publicId, type: 'checklist_item', task: t.publicId };
    });
  }

  async updateChecklistItem(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    ref: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseChecklistItem(body, true);
    return this.taskItemCommand(caller, ws, tsk, req, 'checklist.update', async (tx, p) => {
      const t = await this.editableTask(tx, p, tsk);
      const row = await this.loadTaskItem(tx, 'checklist', t, ref);
      if (req.ifMatch === undefined) throw new TenancyError('precondition_required');
      requireVersion(parseIfMatch(req.ifMatch), Number(row.version));
      const set: Record<string, unknown> = {
        updated_at: new Date(),
        version: Number(row.version) + 1,
      };
      const changes = [change.plain('item', row.public_id, row.public_id)];
      if (input.text !== undefined && input.text !== row.text) {
        set.text = input.text;
        changes.push(change.content('item_text', { hash: hashText(input.text!) }));
      }
      if (input.done !== undefined && input.done !== row.done) {
        // Completion is reversible and audited; it never changes the task status (ADR-22).
        set.done = input.done;
        set.done_at = input.done ? new Date() : null;
        set.done_by_membership_id = input.done ? p.membershipId : null;
        changes.push(change.plain('item_done', row.done, input.done));
      }
      if (Object.keys(set).length > 2) {
        await tx.db.updateTable('work.checklist_item').set(set).where('id', '=', row.id).execute();
        await this.bumpTask(tx, t, p);
        await this.taskAudit(tx, caller, p, 'checklist.updated', t, changes);
      }
      return { id: row.public_id, type: 'checklist_item', task: t.publicId };
    });
  }

  async removeTaskItem(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    kind: ItemTable,
    ref: unknown,
    req: Mutation,
  ) {
    return this.taskItemCommand(caller, ws, tsk, req, `${kind}.remove`, async (tx, p) => {
      const t =
        kind === 'links' ? await this.ownedTask(tx, p, tsk) : await this.editableTask(tx, p, tsk);
      const row = await this.loadTaskItem(tx, kind, t, ref);
      await tx.db.deleteFrom(ITEM[kind].table).where('id', '=', row.id).execute();
      await this.bumpTask(tx, t, p);
      await this.taskAudit(
        tx,
        caller,
        p,
        `${kind === 'links' ? 'link' : kind === 'criteria' ? 'criterion' : 'checklist'}.removed`,
        t,
        [change.plain('item', row.public_id, null)],
      );
      return {
        id: row.public_id,
        type:
          kind === 'links'
            ? 'record_link'
            : kind === 'criteria'
              ? 'criteria_item'
              : 'checklist_item',
        task: t.publicId,
      };
    });
  }

  async moveTaskItem(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    kind: ItemTable,
    ref: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const after = parseAfter(body, ITEM[kind].prefix);
    return this.taskItemCommand(caller, ws, tsk, req, `${kind}.move`, async (tx, p) => {
      const t =
        kind === 'links' ? await this.ownedTask(tx, p, tsk) : await this.editableTask(tx, p, tsk);
      const row = await this.loadTaskItem(tx, kind, t, ref);
      const afterRow = after ? await this.loadTaskItem(tx, kind, t, after) : null;
      if (kind === 'criteria' && afterRow && afterRow.kind !== row.kind)
        throw invalid(issue('/after', 'invalid_reference', 'Choose an entry of the same kind.'));
      const rank = await this.nextRank(
        tx,
        ITEM[kind].table,
        (q) => {
          let w = q.where(ITEM[kind].key, '=', t.id).where('id', '<>', row.id);
          if (kind === 'criteria') w = w.where('kind', '=', row.kind);
          return w;
        },
        afterRow?.id ?? null,
      );
      await tx.db
        .updateTable(ITEM[kind].table)
        .set({ rank, version: Number(row.version) + 1 } as never)
        .where('id', '=', row.id)
        .execute();
      await this.bumpTask(tx, t, p);
      await this.taskAudit(
        tx,
        caller,
        p,
        `${kind === 'links' ? 'link' : kind === 'criteria' ? 'criterion' : 'checklist'}.moved`,
        t,
        [change.plain('item', row.public_id, row.public_id)],
      );
      return { id: row.public_id, type: kind, task: t.publicId };
    });
  }

  async addTaskCriterion(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const input = parseTaskCriterion(body, false);
    return this.taskItemCommand(caller, ws, tsk, req, 'criterion.add', async (tx, p) => {
      const t = await this.editableTask(tx, p, tsk);
      await this.itemCount(tx, 'criteria', t.id);
      const publicId = newPublicId('cri');
      const rank = await this.nextRank(
        tx,
        'work.criteria_item',
        (q) => q.where('task_id', '=', t.id).where('kind', '=', input.kind!),
        'last',
      );
      await tx.db
        .insertInto('work.criteria_item')
        .values({
          id: newUuidV7(),
          public_id: publicId,
          workspace_id: tx.workspaceId,
          brand_id: t.brand.id,
          owner_kind: 'task',
          project_id: null,
          task_id: t.id,
          kind: input.kind!,
          text: input.text!,
          rank,
          required: input.required ?? true,
        })
        .execute();
      await this.bumpTask(tx, t, p);
      await this.taskAudit(tx, caller, p, 'criterion.added', t, [
        change.plain('criterion', null, publicId),
        change.plain('kind', null, input.kind!),
        change.content('criterion_text', { hash: hashText(input.text!) }),
      ]);
      return { id: publicId, type: 'criteria_item', task: t.publicId };
    });
  }

  async updateTaskCriterion(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    ref: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseTaskCriterion(body, true);
    return this.taskItemCommand(caller, ws, tsk, req, 'criterion.update', async (tx, p) => {
      const t = await this.editableTask(tx, p, tsk);
      const row = await this.loadTaskItem(tx, 'criteria', t, ref);
      if (req.ifMatch === undefined) throw new TenancyError('precondition_required');
      requireVersion(parseIfMatch(req.ifMatch), Number(row.version));
      const set: Record<string, unknown> = {
        updated_at: new Date(),
        version: Number(row.version) + 1,
      };
      const changes = [change.plain('criterion', row.public_id, row.public_id)];
      if (input.text !== undefined && input.text !== row.text) {
        set.text = input.text;
        changes.push(change.content('criterion_text', { hash: hashText(input.text!) }));
      }
      if (input.kind !== undefined && input.kind !== row.kind) {
        set.kind = input.kind;
        changes.push(change.plain('kind', row.kind, input.kind));
      }
      if (input.required !== undefined && input.required !== row.required) {
        set.required = input.required;
        changes.push(change.plain('required', row.required, input.required));
      }
      if (input.met !== undefined && input.met !== row.met) {
        set.met = input.met;
        set.met_at = input.met ? new Date() : null;
        set.met_by_membership_id = input.met ? p.membershipId : null;
        changes.push(change.plain('met', row.met, input.met));
      }
      if (Object.keys(set).length > 2) {
        await tx.db.updateTable('work.criteria_item').set(set).where('id', '=', row.id).execute();
        await this.bumpTask(tx, t, p);
        await this.taskAudit(tx, caller, p, 'criterion.updated', t, changes);
      }
      return { id: row.public_id, type: 'criteria_item', task: t.publicId };
    });
  }

  /** Meet, dismiss, or reopen an inherited project definition-of-done item for this task. */
  async setInheritedCriterion(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    ref: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const state = parseInherited(body);
    return this.taskItemCommand(caller, ws, tsk, req, 'criterion.inherited', async (tx, p) => {
      const t = await this.ownedTask(tx, p, tsk);
      if (!isPublic(ref, 'cri') || !t.row.project_id) throw new TenancyError('not_found');
      const item = await tx.db
        .selectFrom('work.criteria_item')
        .select(['id', 'public_id'])
        .where('public_id', '=', ref)
        .where('project_id', '=', t.row.project_id)
        .where('owner_kind', '=', 'project')
        .where('kind', '=', 'definition_of_done')
        .executeTakeFirst();
      if (!item) throw new TenancyError('not_found');
      const before = await tx.db
        .selectFrom('work.task_inherited_criterion')
        .select('state')
        .where('task_id', '=', t.id)
        .where('criteria_item_id', '=', item.id)
        .executeTakeFirst();
      if ((before?.state ?? 'open') === state)
        return { id: item.public_id, type: 'criteria_item', task: t.publicId };
      await tx.db
        .deleteFrom('work.task_inherited_criterion')
        .where('task_id', '=', t.id)
        .where('criteria_item_id', '=', item.id)
        .execute();
      if (state !== 'open')
        await tx.db
          .insertInto('work.task_inherited_criterion')
          .values({
            workspace_id: tx.workspaceId,
            brand_id: t.brand.id,
            task_id: t.id,
            criteria_item_id: item.id,
            state,
            by_membership_id: p.membershipId,
          })
          .execute();
      await this.bumpTask(tx, t, p);
      await this.taskAudit(tx, caller, p, 'criterion.inherited', t, [
        change.plain('inherited_criterion', item.public_id, item.public_id),
        change.plain('state', before?.state ?? 'open', state),
      ]);
      return { id: item.public_id, type: 'criteria_item', task: t.publicId };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Labels (OD-10): one brand each; `label.manage` at brand scope; never authority
  // ---------------------------------------------------------------------------------------------

  protected labelView(l: {
    public_id: string;
    name: string;
    color: string;
    icon: string | null;
    state: string;
    version: number | string;
  }) {
    return {
      id: l.public_id,
      type: 'label' as const,
      name: l.name,
      color: l.color,
      icon: l.icon,
      archived: l.state === 'archived',
      version: Number(l.version),
    };
  }

  async listLabels(
    caller: Caller,
    ws: unknown,
    brand: unknown,
    query: Record<string, unknown> = {},
  ) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      if (p.kind !== 'member') throw new TenancyError('not_found');
      const b = await findBrand(tx, p, brand);
      let q = tx.db
        .selectFrom('work.label')
        .select(['public_id', 'name', 'color', 'icon', 'state', 'version'])
        .where('brand_id', '=', b.id);
      if (query.state !== 'all') q = q.where('state', '=', 'active');
      const rows = await q.orderBy('rank').orderBy('id').limit(this.ws.brandLabelsMax).execute();
      return rows.map((l) => this.labelView(l));
    });
  }

  protected requireLabelManage(
    p: Principal,
    b: {
      id: string;
      is_sensitive: boolean;
      lifecycle_state: 'active' | 'archived' | 'trashed' | 'purged';
    },
  ) {
    const o = decideBrand(p, 'label.manage', {
      id: b.id,
      isSensitive: b.is_sensitive,
      lifecycleState: 'active',
    });
    this.decision('label.manage', o);
    if (!o.allowed) throw new TenancyError(o.code);
    if (b.lifecycle_state !== 'active')
      throw new TenancyError('conflict', {
        issues: [issue('/brand', 'brand_archived', 'This brand is archived.')],
      });
  }

  async createLabel(caller: Caller, ws: unknown, brand: unknown, body: unknown, req: Mutation) {
    const input = parseLabel(body, false);
    return this.mutate(
      caller,
      'label.create',
      ws,
      req,
      async (tx, p) => {
        const b = await findBrand(tx, p, brand, { forUpdate: true });
        this.requireLabelManage(p, b);
        const count = await tx.db
          .selectFrom('work.label')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('brand_id', '=', b.id)
          .executeTakeFirstOrThrow();
        if (Number(count.n) >= this.ws.brandLabelsMax)
          throw invalid(
            issue(
              '/',
              'limit_exceeded',
              `A brand can have at most ${this.ws.brandLabelsMax} labels.`,
            ),
          );
        const id = newUuidV7();
        const publicId = newPublicId('lbl');
        const rank = await this.nextRank(
          tx,
          'work.label',
          (q) => q.where('brand_id', '=', b.id),
          'last',
        );
        try {
          await tx.db
            .insertInto('work.label')
            .values({
              id,
              public_id: publicId,
              workspace_id: tx.workspaceId,
              brand_id: b.id,
              name: input.name!,
              normalized_name: normalizeLabel(input.name!),
              color: input.color!,
              icon: input.icon ?? null,
              rank,
              created_by_membership_id: p.membershipId,
            })
            .execute();
        } catch (err) {
          if (pgCode(err) === '23505')
            throw invalid(
              issue('/name', 'duplicate', 'This brand already has a label with that name.'),
            );
          throw err;
        }
        await this.workAudit(
          tx,
          caller,
          p,
          'label.created',
          { recordId: null, type: 'label', publicId: null },
          [
            change.plain('label', null, publicId),
            change.content('label_name', { hash: hashText(input.name!) }),
          ],
          b.id,
        );
        await writeOutboxEvent(tx, {
          type: 'work.label.created',
          aggregate: { type: 'work.label', id, sequence: 0 },
          data: { label_id: id },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: b.id,
        });
        const row = await tx.db
          .selectFrom('work.label')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return { status: 201, ref: { id: publicId, type: 'label' }, data: this.labelView(row) };
      },
      async (tx, _p, ref) =>
        this.labelView(
          await tx.db
            .selectFrom('work.label')
            .selectAll()
            .where('public_id', '=', ref.id)
            .executeTakeFirstOrThrow(),
        ),
    );
  }

  async updateLabel(caller: Caller, ws: unknown, lbl: unknown, body: unknown, req: Mutation) {
    const input = parseLabel(body, true);
    return this.mutate(
      caller,
      'label.update',
      ws,
      req,
      async (tx, p) => {
        if (!isPublic(lbl, 'lbl')) throw new TenancyError('not_found');
        const row = await tx.db
          .selectFrom('work.label')
          .selectAll()
          .where('public_id', '=', lbl)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new TenancyError('not_found');
        const b = await findBrand(tx, p, await this.publicOf(tx, row.brand_id));
        this.requireLabelManage(p, b);
        if (req.ifMatch === undefined) throw new TenancyError('precondition_required');
        requireVersion(parseIfMatch(req.ifMatch), Number(row.version));
        const set: Record<string, unknown> = {
          updated_at: new Date(),
          version: Number(row.version) + 1,
        };
        const changes = [change.plain('label', row.public_id, row.public_id)];
        if (input.name !== undefined && input.name !== row.name) {
          set.name = input.name;
          set.normalized_name = normalizeLabel(input.name!);
          changes.push(change.content('label_name', { hash: hashText(input.name!) }));
        }
        if (input.color !== undefined && input.color !== row.color) {
          set.color = input.color;
          changes.push(change.plain('color', row.color, input.color));
        }
        if (input.icon !== undefined && input.icon !== row.icon) {
          set.icon = input.icon;
          changes.push(change.plain('icon', row.icon, input.icon));
        }
        if (input.state !== undefined && input.state !== row.state) {
          set.state = input.state;
          changes.push(change.plain('state', row.state, input.state));
        }
        if (Object.keys(set).length > 2) {
          try {
            await tx.db.updateTable('work.label').set(set).where('id', '=', row.id).execute();
          } catch (err) {
            if (pgCode(err) === '23505')
              throw invalid(
                issue('/name', 'duplicate', 'This brand already has a label with that name.'),
              );
            throw err;
          }
          await this.workAudit(
            tx,
            caller,
            p,
            'label.updated',
            { recordId: null, type: 'label', publicId: null },
            changes,
            row.brand_id,
          );
          await writeOutboxEvent(tx, {
            type: 'work.label.updated',
            aggregate: { type: 'work.label', id: row.id, sequence: Number(row.version) + 1 },
            data: { label_id: row.id, lifecycle_state: (set.state as string) ?? row.state },
            actor: { type: 'human', id: p.membershipId },
            context: this.exec(caller, p),
            brandId: row.brand_id,
          });
        }
        const fresh = await tx.db
          .selectFrom('work.label')
          .selectAll()
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow();
        return {
          status: 200,
          ref: { id: row.public_id, type: 'label' },
          data: this.labelView(fresh),
        };
      },
      async (tx, _p, ref) =>
        this.labelView(
          await tx.db
            .selectFrom('work.label')
            .selectAll()
            .where('public_id', '=', ref.id)
            .executeTakeFirstOrThrow(),
        ),
    );
  }

  async addTaskLabel(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const ref = parseLabelRef(body);
    return this.taskItemCommand(caller, ws, tsk, req, 'task.label_add', async (tx, p) => {
      const t = await this.ownedTask(tx, p, tsk);
      const label = await tx.db
        .selectFrom('work.label')
        .select(['id', 'public_id', 'brand_id', 'state'])
        .where('public_id', '=', ref)
        .executeTakeFirst();
      // A label of another brand is indistinguishable from an unknown one.
      if (!label || label.brand_id !== t.brand.id)
        throw invalid(issue('/label', 'invalid_reference', 'Choose a label of this brand.'));
      if (label.state !== 'active')
        throw invalid(issue('/label', 'label_archived', 'This label is archived.'));
      const n = await tx.db
        .selectFrom('work.task_label')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('task_id', '=', t.id)
        .executeTakeFirstOrThrow();
      if (Number(n.n) >= this.ws.taskLabelsMax)
        throw invalid(
          issue('/', 'limit_exceeded', `A task can have at most ${this.ws.taskLabelsMax} labels.`),
        );
      const r = await tx.db
        .insertInto('work.task_label')
        .values({
          workspace_id: tx.workspaceId,
          brand_id: t.brand.id,
          task_id: t.id,
          label_id: label.id,
          added_by_membership_id: p.membershipId,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('label_id')
        .executeTakeFirst();
      if (r) {
        await this.bumpTask(tx, t, p);
        await this.taskAudit(tx, caller, p, 'task.labeled', t, [
          change.plain('label', null, label.public_id),
        ]);
      }
      return { id: t.publicId, type: 'task', task: t.publicId };
    });
  }

  async removeTaskLabel(caller: Caller, ws: unknown, tsk: unknown, lbl: unknown, req: Mutation) {
    return this.taskItemCommand(caller, ws, tsk, req, 'task.label_remove', async (tx, p) => {
      const t = await this.ownedTask(tx, p, tsk);
      if (!isPublic(lbl, 'lbl')) throw new TenancyError('not_found');
      const label = await tx.db
        .selectFrom('work.label')
        .select(['id', 'public_id'])
        .where('public_id', '=', lbl)
        .executeTakeFirst();
      if (!label) throw new TenancyError('not_found');
      const r = await tx.db
        .deleteFrom('work.task_label')
        .where('task_id', '=', t.id)
        .where('label_id', '=', label.id)
        .executeTakeFirst();
      if (!Number(r.numDeletedRows)) throw new TenancyError('not_found');
      await this.bumpTask(tx, t, p);
      await this.taskAudit(tx, caller, p, 'task.unlabeled', t, [
        change.plain('label', label.public_id, null),
      ]);
      return { id: t.publicId, type: 'task', task: t.publicId };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Links (TSK-017)
  // ---------------------------------------------------------------------------------------------

  async addLink(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const input = parseLink(body, false);
    return this.taskItemCommand(caller, ws, tsk, req, 'link.add', async (tx, p) => {
      const t = await this.ownedTask(tx, p, tsk);
      await this.itemCount(tx, 'links', t.id);
      let targetId: string | null = null;
      if (input.record) {
        const vis = await this.taskVisibility(tx, p, false);
        const r = await tx.db
          .selectFrom('core.record as r')
          .innerJoin('core.record_type as ty', 'ty.record_type', 'r.record_type')
          .select(['r.id', 'r.record_type', 'ty.test_only'])
          .where('r.public_id', '=', input.record)
          .where(vis.where('r'))
          .executeTakeFirst();
        // Unknown, unreadable, and unregistered targets are one refusal (no existence clue).
        if (!r || !linkableType(r.record_type, r.test_only) || r.id === t.id)
          throw invalid(issue('/record', 'invalid_reference', "That item can't be linked here."));
        targetId = r.id;
      }
      const publicId = newPublicId('lnk');
      const rank = await this.nextRank(
        tx,
        'relations.record_link',
        (q) => q.where('source_record_id', '=', t.id),
        'last',
      );
      await tx.db
        .insertInto('relations.record_link')
        .values({
          id: newUuidV7(),
          public_id: publicId,
          workspace_id: tx.workspaceId,
          source_record_id: t.id,
          target_kind: targetId ? 'record' : 'url',
          url: input.url ?? null,
          target_record_id: targetId,
          title: input.title ?? null,
          rank,
          created_by_membership_id: p.membershipId,
        })
        .execute();
      await this.bumpTask(tx, t, p);
      await this.taskAudit(tx, caller, p, 'link.added', t, [
        change.plain('link', null, publicId),
        change.plain('target_kind', null, targetId ? 'record' : 'url'),
        ...(input.url ? [change.content('url', { hash: hashText(input.url) })] : []),
      ]);
      return { id: publicId, type: 'record_link', task: t.publicId };
    });
  }

  async updateLink(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    ref: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseLink(body, true);
    return this.taskItemCommand(caller, ws, tsk, req, 'link.update', async (tx, p) => {
      const t = await this.ownedTask(tx, p, tsk);
      const row = await this.loadTaskItem(tx, 'links', t, ref);
      if (req.ifMatch === undefined) throw new TenancyError('precondition_required');
      requireVersion(parseIfMatch(req.ifMatch), Number(row.version));
      if ((input.title ?? null) !== row.title) {
        await tx.db
          .updateTable('relations.record_link')
          .set({
            title: input.title ?? null,
            updated_at: new Date(),
            version: Number(row.version) + 1,
          })
          .where('id', '=', row.id)
          .execute();
        await this.bumpTask(tx, t, p);
        await this.taskAudit(tx, caller, p, 'link.updated', t, [
          change.plain('link', row.public_id, row.public_id),
        ]);
      }
      return { id: row.public_id, type: 'record_link', task: t.publicId };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Relationships (OD-09, OD-05)
  // ---------------------------------------------------------------------------------------------

  async addRelationship(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const input = parseRelationship(body);
    return this.taskItemCommand(caller, ws, tsk, req, 'relationship.add', async (tx, p) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'deps:' + tx.workspaceId}, 0))`.execute(
        tx.db,
      );
      const t = await this.ownedTask(tx, p, tsk, 'record.relate');
      const target = await this.loadTask(tx, p, input.target);
      if (target.id === t.id)
        throw invalid(issue('/target', 'cycle', "A task can't relate to itself."));
      let from = t;
      let to = target;
      if (input.kind === 'blocked_by') [from, to] = [target, t];
      if (input.kind === 'related' && target.id < t.id) [from, to] = [target, t];
      const kind = input.kind === 'related' ? 'related' : 'blocks';
      if (kind === 'blocks') {
        // `to` waits on `from`: refuse if `from` already (transitively) waits on `to`.
        const cycle = await sql<{ found: boolean }>`
          WITH RECURSIVE up(id, n) AS (
            SELECT from_record_id, 1 FROM relations.record_relationship WHERE to_record_id = ${from.id} AND kind = 'blocks'
            UNION
            SELECT r.from_record_id, up.n + 1 FROM relations.record_relationship r JOIN up ON r.to_record_id = up.id
             WHERE r.kind = 'blocks' AND up.n < 1000)
          SELECT EXISTS (SELECT 1 FROM up WHERE id = ${to.id}) AS found`.execute(tx.db);
        if (cycle.rows[0]?.found)
          throw invalid(issue('/target', 'cycle', 'This would make the tasks wait on each other.'));
      }
      const id = newUuidV7();
      try {
        await tx.db
          .insertInto('relations.record_relationship')
          .values({
            id,
            workspace_id: tx.workspaceId,
            kind,
            from_record_id: from.id,
            to_record_id: to.id,
            from_brand_id: from.brand.id,
            to_brand_id: to.brand.id,
            created_by_membership_id: p.membershipId,
          })
          .execute();
      } catch (err) {
        if (pgCode(err) === '23505')
          throw invalid(issue('/target', 'duplicate', 'These tasks are already related this way.'));
        throw err;
      }
      await this.bumpTask(tx, t, p);
      await this.taskAudit(tx, caller, p, 'relationship.added', t, [
        change.plain(input.kind, null, target.publicId),
      ]);
      await writeOutboxEvent(tx, {
        type: 'relations.relationship.created',
        aggregate: { type: 'relations.record_relationship', id, sequence: 0 },
        data: { kind, from_record_id: from.id, to_record_id: to.id },
        actor: { type: 'human', id: p.membershipId },
        context: this.exec(caller, p),
        brandId: t.brand.id,
      });
      return { id: target.publicId, type: 'task', task: t.publicId };
    });
  }

  async removeRelationship(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    kind: unknown,
    target: unknown,
    req: Mutation,
  ) {
    if (kind !== 'blocks' && kind !== 'blocked_by' && kind !== 'related')
      throw new TenancyError('not_found');
    return this.taskItemCommand(caller, ws, tsk, req, 'relationship.remove', async (tx, p) => {
      const t = await this.ownedTask(tx, p, tsk, 'record.relate');
      const other = await this.loadTask(tx, p, target);
      const pairs =
        kind === 'blocks'
          ? [[t.id, other.id]]
          : kind === 'blocked_by'
            ? [[other.id, t.id]]
            : [
                [t.id, other.id],
                [other.id, t.id],
              ];
      const k = kind === 'related' ? 'related' : 'blocks';
      let removed: { id: string; from_record_id: string; to_record_id: string } | undefined;
      for (const [f, to] of pairs) {
        removed ??= await tx.db
          .deleteFrom('relations.record_relationship')
          .where('from_record_id', '=', f!)
          .where('to_record_id', '=', to!)
          .where('kind', '=', k)
          .returning(['id', 'from_record_id', 'to_record_id'])
          .executeTakeFirst();
      }
      if (!removed) throw new TenancyError('not_found');
      await this.bumpTask(tx, t, p);
      await this.taskAudit(tx, caller, p, 'relationship.removed', t, [
        change.plain(kind, other.publicId, null),
      ]);
      await writeOutboxEvent(tx, {
        type: 'relations.relationship.removed',
        aggregate: { type: 'relations.record_relationship', id: removed.id, sequence: 1 },
        data: {
          kind: k,
          from_record_id: removed.from_record_id,
          to_record_id: removed.to_record_id,
        },
        actor: { type: 'human', id: p.membershipId },
        context: this.exec(caller, p),
        brandId: t.brand.id,
      });
      return { id: other.publicId, type: 'task', task: t.publicId };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // History: a permission-filtered projection of the 1F audit ledger (TSK-039; no second table)
  // ---------------------------------------------------------------------------------------------

  async taskHistory(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    query: Record<string, unknown> = {},
  ) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const t = await this.loadTask(tx, p, tsk);
      // History is outside a share (AZ-22).
      if (t.ownLevel === null) throw new TenancyError('not_found');
      const limit = Math.min(
        Number.isInteger(Number(query.limit)) && Number(query.limit) > 0
          ? Number(query.limit)
          : this.ws.pageLimitDefault,
        this.ws.pageLimitMax,
      );
      let before: { at: string; id: string } | null = null;
      if (typeof query.cursor === 'string') {
        try {
          const c = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as Record<
            string,
            unknown
          >;
          if (
            typeof c.a !== 'string' ||
            Number.isNaN(Date.parse(c.a)) ||
            typeof c.i !== 'string' ||
            !/^[0-9a-f-]{36}$/.test(c.i) ||
            c.t !== t.publicId
          )
            throw new Error('cursor');
          before = { at: c.a, id: c.i };
        } catch {
          throw new TenancyError('cursor_invalid');
        }
      }
      let q = tx.db
        .selectFrom('audit.audit_event')
        .select(['id', 'occurred_at', 'action', 'actor_type', 'actor_id', 'changes', 'source_kind'])
        .where('target_record_id', '=', t.id);
      if (before)
        q = q.where(
          sql<boolean>`(occurred_at, id) < (${before.at}::timestamptz, ${before.id}::uuid)`,
        );
      const rows = await q
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      // Re-authorize every referenced record and person before showing a value (no hidden clue).
      const refs = new Set<string>();
      const isRef = (v: unknown): v is string =>
        typeof v === 'string' && /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}\*?$/.test(v);
      for (const e of page)
        for (const c of e.changes as StoredChange[])
          for (const v of [c.old, c.new])
            if (typeof v === 'string')
              for (const part of v.split(',')) if (isRef(part)) refs.add(part.replace(/\*$/, ''));
      const vis = await this.taskVisibility(tx, p, true);
      const recordRefs = [...refs].filter((r) => !r.startsWith('mem_'));
      const readable = recordRefs.length
        ? new Set(
            (
              await tx.db
                .selectFrom('core.record as r')
                .select('r.public_id')
                .where('r.public_id', 'in', recordRefs)
                .where(vis.where('r'))
                .execute()
            ).map((r) => r.public_id),
          )
        : new Set<string>();
      const memberRefs = [...refs].filter((r) => r.startsWith('mem_'));
      const people =
        memberRefs.length && p.kind === 'member'
          ? new Map(
              (
                await tx.db
                  .selectFrom('tenancy.membership as m')
                  .innerJoin('identity.account as a', 'a.id', 'm.account_id')
                  .select(['m.public_id', 'm.display_name_override', 'a.display_name'])
                  .where('m.public_id', 'in', memberRefs)
                  .execute()
              ).map((m) => [m.public_id, m.display_name_override ?? m.display_name]),
            )
          : new Map<string, string>();
      const actors = new Map(
        p.kind === 'member'
          ? (
              await tx.db
                .selectFrom('tenancy.membership as m')
                .innerJoin('identity.account as a', 'a.id', 'm.account_id')
                .select(['m.id', 'm.display_name_override', 'a.display_name'])
                .where('m.id', 'in', [
                  ...new Set(page.map((e) => e.actor_id).filter((x): x is string => !!x)),
                  '00000000-0000-7000-8000-000000000000',
                ])
                .execute()
            ).map((m) => [m.id, m.display_name_override ?? m.display_name])
          : [],
      );
      const show = (v: unknown): { ok: boolean; value: unknown } => {
        if (typeof v !== 'string') return { ok: true, value: v };
        const parts = v.split(',');
        if (!parts.some((x) => isRef(x))) return { ok: true, value: v };
        const out: string[] = [];
        for (const part of parts) {
          const id = part.replace(/\*$/, '');
          if (id.startsWith('mem_')) {
            const name = people.get(id);
            if (name) out.push(part.endsWith('*') ? `${name} (primary)` : name);
          } else if (readable.has(id)) out.push(id);
          else return { ok: false, value: null };
        }
        return { ok: true, value: out.join(', ') || null };
      };
      // Custom field changes are shown only for fields this reader can read now; the resolution
      // always runs, and an entry with nothing left to show is omitted (W20, AZ-23).
      const fieldAccess = await fieldsForRecord(
        tx,
        p,
        { id: t.id, kind: 'task', brandId: t.brand.id, projectId: t.row.project_id },
        t.level,
      );
      const readableFields = new Set(
        fieldAccess.filter((f) => f.readable).map((f) => `fields.${f.def.public_id.toLowerCase()}`),
      );
      const visibleChange = (c: StoredChange) =>
        !c.field.startsWith('fields.') || readableFields.has(c.field);
      const shown = page.filter((e) => {
        const cs = e.changes as StoredChange[];
        return !cs.length || cs.some(visibleChange);
      });
      const last = page.at(-1);
      return {
        data: shown.map((e) => ({
          // An opaque stable key (internal identifiers never leave the API).
          key: createHash('sha256').update(e.id).digest('base64url').slice(0, 22),
          at: new Date(e.occurred_at).toISOString(),
          action: e.action,
          actor: { type: e.actor_type, name: e.actor_id ? (actors.get(e.actor_id) ?? null) : null },
          source: e.source_kind,
          changes: (e.changes as StoredChange[])
            .filter(visibleChange)
            .flatMap(
              (c): Array<{ field: string; changed?: true; before?: unknown; after?: unknown }> => {
                // Content-class and personal values are never shown; redacted entries stay redacted.
                if (c.class !== 'plain' || c.redacted)
                  return [{ field: c.field, changed: true as const }];
                const o = show(c.old);
                const n = show(c.new);
                // A change naming a record the reader cannot read is omitted entirely (OD-05).
                if (!o.ok || !n.ok) return [];
                return [{ field: c.field, before: o.value, after: n.value }];
              },
            ),
        })),
        page: {
          has_more: rows.length > limit,
          ...(rows.length > limit && last
            ? {
                next_cursor: Buffer.from(
                  JSON.stringify({
                    t: t.publicId,
                    a: new Date(last.occurred_at).toISOString(),
                    i: last.id,
                  }),
                ).toString('base64url'),
              }
            : {}),
        },
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Project rollups from readable tasks (OD-13, PRJ-020, PRJ-021)
  // ---------------------------------------------------------------------------------------------

  /** Readable leaf tasks of a project: a leaf has no readable active child (never hidden work). */
  protected async projectTaskFacts(tx: WorkspaceTransaction, p: Principal, project: LoadedProject) {
    const vis = await this.taskVisibility(tx, p, false);
    const today = todayIn((await this.brandFactsOf(tx, project.brand.id)).facts.timezone);
    const r = await sql<{
      leaves: string;
      done: string;
      overdue: string;
      blocked: string;
      unassigned: string;
      total: string;
    }>`
      WITH readable AS (
        SELECT t.* FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
         WHERE t.project_id = ${project.id} AND r.lifecycle_state = 'active'
           AND ${vis.where('r', { project: sql`t.project_id` })})
      SELECT
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM readable c WHERE c.parent_task_id = x.id) AND x.status_category <> 'cancelled') AS leaves,
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM readable c WHERE c.parent_task_id = x.id) AND x.status_category = 'done') AS done,
        count(*) FILTER (WHERE x.status_category NOT IN ('done', 'cancelled') AND x.due_date < ${today}::date) AS overdue,
        count(*) FILTER (WHERE x.status_category NOT IN ('done', 'cancelled') AND (x.status_category = 'paused' OR EXISTS (
          SELECT 1 FROM relations.record_relationship rel
            JOIN work.task b ON b.workspace_id = rel.workspace_id AND b.id = rel.from_record_id
            JOIN core.record br ON br.workspace_id = b.workspace_id AND br.id = b.id
           WHERE rel.to_record_id = x.id AND rel.kind = 'blocks' AND b.status_category NOT IN ('done', 'cancelled')
             AND br.lifecycle_state = 'active' AND ${vis.where('br', { project: sql`b.project_id` })}))) AS blocked,
        count(*) FILTER (WHERE x.status_category NOT IN ('done', 'cancelled') AND NOT EXISTS (
          SELECT 1 FROM work.task_assignee a JOIN tenancy.membership m ON m.id = a.membership_id
           WHERE a.task_id = x.id AND m.state = 'active')) AS unassigned,
        count(*) AS total
      FROM readable x`.execute(tx.db);
    const row = r.rows[0]!;
    return {
      leaves: Number(row.leaves),
      done: Number(row.done),
      overdue: Number(row.overdue),
      blocked: Number(row.blocked),
      unassigned: Number(row.unassigned),
      total: Number(row.total),
    };
  }

  protected override async projectView(
    tx: WorkspaceTransaction,
    p: Principal,
    project: LoadedProject,
  ) {
    const view = await super.projectView(tx, p, project);
    if (project.ownLevel === null) return view;
    const f = await this.projectTaskFacts(tx, p, project);
    if (!f.leaves) return view;
    return {
      ...view,
      // OD-13: done readable leaf tasks over readable non-cancelled leaf tasks.
      completion: { percent: Math.round((f.done / f.leaves) * 100), basis: 'leaf_tasks' as never },
    };
  }

  override async overview(caller: Caller, workspacePublicId: unknown, projectPublicId: unknown) {
    const base = await super.overview(caller, workspacePublicId, projectPublicId);
    return this.inWorkspace(caller, workspacePublicId, { readOnly: true }, async (tx, p) => {
      const project = await this.loadProject(tx, p, projectPublicId);
      if (project.ownLevel === null) return base;
      const f = await this.projectTaskFacts(tx, p, project);
      return {
        ...base,
        task_facts: {
          available: true as never,
          total: f.total,
          overdue: f.overdue,
          blocked: f.blocked,
          unassigned: f.unassigned,
        },
      };
    });
  }

  /** A body object or nothing (helper for routes with optional bodies). */
  static body(b: unknown) {
    return isObject(b) ? b : {};
  }
}
