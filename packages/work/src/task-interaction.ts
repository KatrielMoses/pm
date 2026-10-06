import { createHash } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import {
  decideBrand,
  findBrand,
  Issues,
  invalid,
  issue,
  parseIfMatch,
  recordLevel,
  requireVersion,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import type { ActionKey } from '@pm/contracts';
import { FieldService } from './field-service.ts';
import { localToUtc, occurrences, parseRule, RuleError, utcToLocal } from './recurrence.ts';
import { fmtTs, seriesView } from './structures.ts';
import type { LoadedTask } from './task-core.ts';
import {
  instantiateTask,
  normalizedTitleSql,
  normalizeTitle,
  readTaskPackage,
  serializeTask,
  taskPackageItems,
  TASK_NOT_COPIED,
  type TaskPackage,
} from './task-package.ts';
import { generateTaskOccurrences } from './task-recurrence.ts';
import { TASK_FIELDS, taskField } from './task-validation.ts';
import { isPublic, parseRecurrence } from './validation.ts';
import { offered, statusFromKey, statusRef, statusView, TERMINAL } from './workflow/statuses.ts';

/** The bulk operations (0028 closed set). Archive and trash are destructive (atomic by default). */
export const BULK_OPERATIONS = [
  'set_status',
  'set_priority',
  'set_due_date',
  'add_label',
  'remove_label',
  'archive',
  'trash',
] as const;
export type BulkOperation = (typeof BULK_OPERATIONS)[number];
const DESTRUCTIVE = new Set<BulkOperation>(['archive', 'trash']);
const BULK_FIELD: Partial<Record<BulkOperation, 'status' | 'priority' | 'due_date'>> = {
  set_status: 'status',
  set_priority: 'priority',
  set_due_date: 'due_date',
};

/** One item of a preview or report: identifiers, codes, and readable status facts only. */
export interface BulkItem {
  task: string;
  outcome: BulkOutcome;
  code?: string;
  /** set_status: the proposed status as this task's workflow names it. */
  target?: ReturnType<typeof statusView>;
  /** set_status: readable required fields still missing (labels only). */
  required_fields?: string[];
}

/** Per-item outcomes a preview or report may carry (identifiers and codes only). */
export type BulkOutcome =
  | 'ready'
  | 'no_change'
  | 'applied'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'invalid'
  | 'skipped';

export type TaskSignals = {
  stale: boolean;
  blocked: boolean | null;
  repeatedly_rescheduled: boolean;
  missing_owner: boolean | null;
  missing_date: boolean;
  missing_criteria: boolean | null;
  missing_dependency: boolean | null;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const DAY_MS = 86_400_000;
const sha = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(v ?? null))
    .digest();
const instant = (v: unknown, path: string): Date => {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)
  )
    throw invalid(issue(path, 'invalid_type', 'Use a date and time with a time zone.'));
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw invalid(issue(path, 'invalid_type', 'Use a date and time with a time zone.'));
  return d;
};
const onlyKeys = (b: Record<string, unknown>, keys: readonly string[]) => {
  for (const k of Object.keys(b))
    if (!keys.includes(k))
      throw invalid(issue(`/${k}`, 'unsupported_field', 'This field is not supported.'));
};

/**
 * Phase 2D task interaction quality (ADR-0016, 0B ADR-24, 0C AZ-24, 0D PL-26): task signals and
 * freshness (OD-17), deterministic duplicates, personal reminders and snoozes, ordering commands,
 * bulk preview and execution, undo, task templates, and recurring tasks. Extends the 2C chain:
 * every command authorizes each record with its own action, inside one transaction with
 * idempotency, audit, and outbox events. Personal state (reminders, snoozes, undo entries) belongs
 * to its member alone and never changes a task's dates, status, or access.
 */
export class TaskInteractionService extends FieldService {
  // ---------------------------------------------------------------------------------------------
  // Signals and freshness (OD-17)
  // ---------------------------------------------------------------------------------------------

  /**
   * Signals for readable tasks, from facts the viewer may read only. Every input runs the same
   * statements regardless of what is hidden (blockers and criteria are filtered by the visibility
   * predicate in SQL); share-only readers get null for signals that depend on context a share
   * excludes (owners, relationships, project criteria).
   */
  protected async signalsFor(
    tx: WorkspaceTransaction,
    p: Principal,
    tasks: LoadedTask[],
    now = new Date(),
  ): Promise<Map<string, TaskSignals>> {
    const ids = tasks.length ? tasks.map((t) => t.id) : [NIL];
    const vis = await this.taskVisibility(tx, p, true);
    const blockers = await tx.db
      .selectFrom('relations.record_relationship as rel')
      .innerJoin('work.task as b', 'b.id', 'rel.from_record_id')
      .innerJoin('core.record as br', (j) =>
        j.onRef('br.workspace_id', '=', 'b.workspace_id').onRef('br.id', '=', 'b.id'),
      )
      .select(['rel.to_record_id as task', 'b.status_category', 'br.lifecycle_state'])
      .where('rel.kind', '=', 'blocks')
      .where('rel.to_record_id', 'in', ids)
      .where(vis.where('br', { project: sql`b.project_id` }))
      .execute();
    const owners = await tx.db
      .selectFrom('work.task_assignee as a')
      .innerJoin('tenancy.membership as m', 'm.id', 'a.membership_id')
      .select(['a.task_id', (eb) => eb.fn.countAll<string>().as('n')])
      .where('a.task_id', 'in', ids)
      .where('m.state', '=', 'active')
      .groupBy('a.task_id')
      .execute();
    const criteria = await tx.db
      .selectFrom('work.task as t')
      .select([
        't.id',
        sql<string>`(SELECT count(*) FROM work.criteria_item c WHERE c.task_id = t.id)`.as('own'),
        sql<string>`(SELECT count(*) FROM work.criteria_item c
          WHERE t.project_id IS NOT NULL AND c.project_id = t.project_id AND c.kind = 'definition_of_done')`.as(
          'inherited',
        ),
      ])
      .where('t.id', 'in', ids)
      .execute();
    const since = new Date(now.getTime() - this.ws.taskRescheduleWindowDays * DAY_MS);
    // Material reschedules: a due date or deadline that changed from one value to another
    // (setting a first date is not a reschedule). Derived from the audit ledger (ADR-24).
    const reschedules = await tx.db
      .selectFrom('audit.audit_event')
      .select(['target_record_id', (eb) => eb.fn.countAll<string>().as('n')])
      .where('target_record_id', 'in', ids)
      .where('action', '=', 'task.updated')
      .where('occurred_at', '>=', since)
      .where(
        // The deadline is audited as its JSON text, so "no deadline" is the string "null".
        sql<boolean>`jsonb_path_exists(changes, '$[*] ? ((@.field == "due_date" || @.field == "deadline") && @.old != null && @.old != "null")')`,
      )
      .groupBy('target_record_id')
      .execute();
    const ownersBy = new Map(owners.map((o) => [o.task_id, Number(o.n)]));
    const critBy = new Map(criteria.map((c) => [c.id, Number(c.own) + Number(c.inherited)]));
    const reBy = new Map(reschedules.map((r) => [r.target_record_id, Number(r.n)]));
    const out = new Map<string, TaskSignals>();
    for (const t of tasks) {
      const r = t.row;
      const open = !TERMINAL.has(r.status_category as never);
      const age = now.getTime() - r.last_meaningful_update_at.getTime();
      const stale =
        (r.status_category === 'active' && age > this.ws.taskStaleActiveDays * DAY_MS) ||
        (r.status_category === 'planned' && age > this.ws.taskStalePlannedDays * DAY_MS);
      const own = t.ownLevel !== null;
      const mine = blockers.filter((b) => b.task === t.id);
      out.set(t.id, {
        stale,
        blocked: own
          ? open &&
            mine.some(
              (b) => b.lifecycle_state === 'active' && !TERMINAL.has(b.status_category as never),
            )
          : null,
        repeatedly_rescheduled: (reBy.get(t.id) ?? 0) >= this.ws.taskRescheduleCount,
        missing_owner: own && p.kind === 'member' ? open && !(ownersBy.get(t.id) ?? 0) : null,
        missing_date: open && !r.due_date && !r.deadline_date && !r.deadline_at,
        missing_criteria: own ? open && !(critBy.get(t.id) ?? 0) : null,
        missing_dependency: own
          ? open &&
            mine.some((b) => b.status_category === 'cancelled' || b.lifecycle_state === 'archived')
          : null,
      });
    }
    return out;
  }

  protected freshnessView(t: LoadedTask) {
    return {
      last_meaningful_update_at:
        t.ownLevel !== null ? t.row.last_meaningful_update_at.toISOString() : null,
      stale_after_days:
        t.row.status_category === 'active'
          ? this.ws.taskStaleActiveDays
          : t.row.status_category === 'planned'
            ? this.ws.taskStalePlannedDays
            : null,
      reschedule_rule: {
        count: this.ws.taskRescheduleCount,
        window_days: this.ws.taskRescheduleWindowDays,
      },
    };
  }

  /** One readable task's signals, freshness, origin, and the caller's own reminders and snooze. */
  async taskSignals(caller: Caller, ws: unknown, tsk: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const t = await this.loadTask(tx, p, tsk);
      const signals = (await this.signalsFor(tx, p, [t])).get(t.id)!;
      const reminders = await tx.db
        .selectFrom('planning.task_reminder')
        .select(['public_id', 'remind_at', 'state', 'fired_at', 'version'])
        .where('owner_membership_id', '=', p.membershipId)
        .where('task_id', '=', t.id)
        .where('state', 'in', ['scheduled', 'fired'])
        .orderBy('remind_at')
        .execute();
      const snooze = await tx.db
        .selectFrom('planning.task_snooze')
        .select(['until_at', 'version'])
        .where('owner_membership_id', '=', p.membershipId)
        .where('task_id', '=', t.id)
        .executeTakeFirst();
      const series =
        t.ownLevel !== null
          ? await tx.db
              .selectFrom('planning.recurrence_series')
              .select(['public_id', 'state', 'target_kind'])
              .where((eb) =>
                eb.or([
                  eb('id', '=', t.row.recurrence_series_id ?? NIL),
                  eb.and([eb('source_record_id', '=', t.id), eb('target_kind', '=', 'task')]),
                ]),
              )
              .orderBy('created_at')
              .execute()
          : [];
      return {
        task: { id: t.publicId, version: t.row.version },
        signals,
        freshness: this.freshnessView(t),
        source:
          t.ownLevel !== null
            ? { kind: t.row.origin_kind, ...t.row.origin_ref }
            : { kind: t.row.origin_kind },
        recurrence: series.map((s) => ({ id: s.public_id, state: s.state })),
        reminders: reminders.map(reminderView),
        snooze:
          snooze && new Date(snooze.until_at) > new Date()
            ? { until: new Date(snooze.until_at).toISOString(), version: Number(snooze.version) }
            : null,
      };
    });
  }

  /** Signals for a page of tasks (at most PAGE_LIMIT_MAX); unreadable ones are omitted silently. */
  async listTaskSignals(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const raw = typeof query.tasks === 'string' ? query.tasks.split(',').filter(Boolean) : [];
    if (!raw.length) throw invalid(issue('/tasks', 'required', 'Choose at least one task.'));
    if (raw.length > this.ws.pageLimitMax)
      throw invalid(issue('/tasks', 'too_many', `Ask for at most ${this.ws.pageLimitMax} tasks.`));
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const loaded: LoadedTask[] = [];
      for (const id of [...new Set(raw)]) {
        try {
          loaded.push(await this.loadTask(tx, p, id));
        } catch (err) {
          if (!(err instanceof TenancyError) || err.code !== 'not_found') throw err;
        }
      }
      const signals = await this.signalsFor(tx, p, loaded);
      return {
        items: loaded.map((t) => ({
          task: t.publicId,
          signals: signals.get(t.id)!,
          freshness: this.freshnessView(t),
        })),
      };
    });
  }

  /** "Mark as updated": the one manual freshness write (a meaningful update, OD-17). */
  async markTaskUpdated(caller: Caller, ws: unknown, tsk: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'task.mark_updated',
      ws,
      req,
      async (tx, p) => {
        const t = await this.editableTask(tx, p, tsk);
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), t.row.version);
        await tx.db
          .updateTable('work.task')
          .set({ last_meaningful_update_at: sql`now()` as never })
          .where('id', '=', t.id)
          .execute();
        await this.taskAudit(tx, caller, p, 'task.marked_updated', t, [
          change.plain('freshness', null, 'manual'),
        ]);
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
  // Deterministic duplicates (advisory only; TSK-042)
  // ---------------------------------------------------------------------------------------------

  /**
   * Readable open tasks in the same workspace and brand, with a compatible project (the same one,
   * or either side projectless), created within DUPLICATE_WINDOW_DAYS, whose normalized title equals
   * the candidate's. Hidden matches are filtered in the query, so they change neither the result,
   * its count, nor the statements run.
   */
  async duplicateCandidates(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const title = typeof query.title === 'string' ? normalizeTitle(query.title) : '';
    if (!title || title.length > 300)
      throw invalid(issue('/title', 'required', 'Type a title to check.'));
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const brand = await findBrand(tx, p, query.brand);
      let projectId: string | null = null;
      if (query.project !== undefined && query.project !== '') {
        const project = await this.loadProject(tx, p, query.project);
        if (project.ownLevel === null || project.brand.id !== brand.id)
          throw new TenancyError('not_found');
        projectId = project.id;
      }
      const exclude = isPublic(query.exclude, 'tsk') ? query.exclude : null;
      const vis = await this.taskVisibility(tx, p, false);
      const since = new Date(Date.now() - this.ws.duplicateWindowDays * DAY_MS);
      const rows = await tx.db
        .selectFrom('work.task as t')
        .innerJoin('core.record as r', (j) =>
          j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
        )
        .select(['r.public_id', 't.title', 't.status_id', 't.created_at'])
        .where('t.brand_id', '=', brand.id)
        .where(sql<boolean>`${normalizedTitleSql} = ${title}`)
        .where('t.status_category', 'not in', ['done', 'cancelled'])
        .where('t.created_at', '>=', since)
        .where('r.lifecycle_state', '=', 'active')
        .where((eb) =>
          projectId
            ? eb.or([eb('t.project_id', '=', projectId), eb('t.project_id', 'is', null)])
            : eb.val(true),
        )
        .where('r.public_id', '<>', exclude ?? '')
        .where(vis.where('r', { project: sql`t.project_id` }))
        .orderBy('t.created_at', 'desc')
        .orderBy('t.id')
        .limit(this.ws.duplicateCandidatesMax)
        .execute();
      return {
        advisory: true as const,
        candidates: rows.map((r) => ({
          id: r.public_id,
          title: r.title,
          status: this.taskStatusView(r.status_id, tx),
          created_at: new Date(r.created_at).toISOString(),
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Personal reminders (TSK-032) and snoozes (TSK-033)
  // ---------------------------------------------------------------------------------------------

  protected requirePersonalAction(p: Principal, action: ActionKey, t: LoadedTask) {
    this.requireTaskAction(p, action, t);
  }

  protected async ownReminder(tx: WorkspaceTransaction, p: Principal, rem: unknown) {
    if (!isPublic(rem, 'rem')) throw new TenancyError('not_found');
    const r = await tx.db
      .selectFrom('planning.task_reminder as m')
      .innerJoin('core.record as r', 'r.id', 'm.task_id')
      .select([
        'm.id',
        'm.public_id',
        'm.task_id',
        'm.remind_at',
        'm.state',
        'm.fired_at',
        'm.version',
        'r.public_id as task_public_id',
      ])
      .where('m.public_id', '=', rem)
      .where('m.owner_membership_id', '=', p.membershipId)
      .forUpdate('m')
      .executeTakeFirst();
    if (!r) throw new TenancyError('not_found');
    // The task must still be readable; otherwise the reminder is as absent as an unknown one.
    const t = await this.loadTask(tx, p, r.task_public_id);
    return { r, t };
  }

  /** The caller's scheduled and recently fired reminders on readable tasks. */
  async listReminders(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const vis = await this.taskVisibility(tx, p, false);
      const rows = await tx.db
        .selectFrom('planning.task_reminder as m')
        .innerJoin('work.task as t', 't.id', 'm.task_id')
        .innerJoin('core.record as r', (j) =>
          j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
        )
        .select([
          'm.public_id',
          'm.remind_at',
          'm.state',
          'm.fired_at',
          'm.version',
          'r.public_id as task',
          't.title',
        ])
        .where('m.owner_membership_id', '=', p.membershipId)
        .where('m.state', 'in', ['scheduled', 'fired'])
        .where(vis.where('r', { project: sql`t.project_id` }))
        .orderBy('m.remind_at')
        .limit(this.ws.pageLimitMax)
        .execute();
      return rows.map((r) => ({ ...reminderView(r), task: { id: r.task, title: r.title } }));
    });
  }

  async createReminder(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    onlyKeys(b, ['remind_at']);
    const at = instant(b.remind_at, '/remind_at');
    return this.mutate(
      caller,
      'task.remind',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        this.requirePersonalAction(p, 'task.remind', t);
        this.requireTaskActive(t);
        if (at.getTime() <= Date.now())
          throw invalid(issue('/remind_at', 'out_of_range', 'Choose a time in the future.'));
        const existing = await tx.db
          .selectFrom('planning.task_reminder')
          .select(['public_id', 'remind_at', 'state', 'fired_at', 'version'])
          .where('owner_membership_id', '=', p.membershipId)
          .where('task_id', '=', t.id)
          .where('remind_at', '=', at)
          .executeTakeFirst();
        if (existing && existing.state === 'scheduled')
          return {
            status: 200,
            ref: { id: existing.public_id, type: 'task_reminder' },
            data: { ...reminderView(existing), task: { id: t.publicId } },
          };
        if (existing)
          throw new TenancyError('conflict', {
            issues: [issue('/remind_at', 'stale', 'A reminder for that time already ended.')],
          });
        const n = await tx.db
          .selectFrom('planning.task_reminder')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('owner_membership_id', '=', p.membershipId)
          .where('task_id', '=', t.id)
          .where('state', '=', 'scheduled')
          .executeTakeFirstOrThrow();
        if (Number(n.n) >= this.ws.taskRemindersMax)
          throw invalid(
            issue(
              '/remind_at',
              'too_many',
              `You can have at most ${this.ws.taskRemindersMax} reminders on one task.`,
            ),
          );
        const id = newUuidV7();
        const publicId = newPublicId('rem');
        await tx.db
          .insertInto('planning.task_reminder')
          .values({
            id,
            public_id: publicId,
            workspace_id: tx.workspaceId,
            owner_membership_id: p.membershipId,
            task_id: t.id,
            remind_at: at,
          })
          .execute();
        await this.workEvent(
          tx,
          caller,
          p,
          'planning.task_reminder.scheduled',
          { type: 'planning.task_reminder', id, sequence: 0 },
          { task_id: t.id, state: 'scheduled' },
          t.brand.id,
        );
        const row = await tx.db
          .selectFrom('planning.task_reminder')
          .select(['public_id', 'remind_at', 'state', 'fired_at', 'version'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return {
          status: 201,
          ref: { id: publicId, type: 'task_reminder' },
          data: { ...reminderView(row), task: { id: t.publicId } },
        };
      },
      async (tx, p, ref) => {
        const { r, t } = await this.ownReminder(tx, p, ref.id);
        return { ...reminderView(r), task: { id: t.publicId } };
      },
    );
  }

  /** Move a scheduled reminder, or dismiss or cancel one (owner only). */
  async updateReminder(caller: Caller, ws: unknown, rem: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    onlyKeys(b, ['remind_at', 'state', 'version']);
    const at = b.remind_at !== undefined ? instant(b.remind_at, '/remind_at') : null;
    const state = b.state;
    if (state !== undefined && state !== 'dismissed' && state !== 'cancelled')
      throw invalid(issue('/state', 'invalid_option', 'Choose dismissed or cancelled.'));
    if (!at && state === undefined)
      throw invalid(issue('/', 'required', 'Send a new time or a state.'));
    return this.mutate(
      caller,
      'task.remind_update',
      ws,
      req,
      async (tx, p) => {
        const { r, t } = await this.ownReminder(tx, p, rem);
        this.requirePersonalAction(p, 'task.remind', t);
        const expected =
          req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (b.version as number | undefined);
        if (expected !== undefined) requireVersion(expected, Number(r.version));
        const set: Record<string, unknown> = {
          updated_at: new Date(),
          version: Number(r.version) + 1,
        };
        if (at) {
          if (r.state !== 'scheduled' || at.getTime() <= Date.now())
            throw invalid(issue('/remind_at', 'out_of_range', 'Choose a time in the future.'));
          set.remind_at = at;
        }
        if (state) {
          const allowed = state === 'dismissed' ? ['scheduled', 'fired'] : ['scheduled'];
          if (!allowed.includes(r.state))
            throw new TenancyError('conflict', {
              issues: [issue('/state', 'stale', 'This reminder already ended.')],
            });
          set.state = state;
        }
        try {
          await tx.db
            .updateTable('planning.task_reminder')
            .set(set)
            .where('id', '=', r.id)
            .execute();
        } catch (err) {
          if ((err as { code?: string }).code === '23505')
            throw new TenancyError('conflict', {
              issues: [issue('/remind_at', 'duplicate', 'You already have a reminder then.')],
            });
          throw err;
        }
        const row = await tx.db
          .selectFrom('planning.task_reminder')
          .select(['public_id', 'remind_at', 'state', 'fired_at', 'version'])
          .where('id', '=', r.id)
          .executeTakeFirstOrThrow();
        return {
          status: 200,
          ref: { id: r.public_id, type: 'task_reminder' },
          data: { ...reminderView(row), task: { id: t.publicId } },
        };
      },
      async (tx, p, ref) => {
        const { r, t } = await this.ownReminder(tx, p, ref.id);
        return { ...reminderView(r), task: { id: t.publicId } };
      },
    );
  }

  /** Snooze a readable task for oneself until an instant (never edits the task). */
  async snoozeTask(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    onlyKeys(b, ['until']);
    const until = instant(b.until, '/until');
    return this.mutate(
      caller,
      'task.snooze',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        this.requirePersonalAction(p, 'task.snooze', t);
        this.requireTaskActive(t);
        const now = Date.now();
        if (until.getTime() <= now || until.getTime() > now + this.ws.taskSnoozeMaxDays * DAY_MS)
          throw invalid(
            issue(
              '/until',
              'out_of_range',
              `Choose a time in the next ${this.ws.taskSnoozeMaxDays} days.`,
            ),
          );
        await tx.db
          .insertInto('planning.task_snooze')
          .values({
            workspace_id: tx.workspaceId,
            owner_membership_id: p.membershipId,
            task_id: t.id,
            until_at: until,
          })
          .onConflict((oc) =>
            oc.columns(['workspace_id', 'owner_membership_id', 'task_id']).doUpdateSet({
              until_at: until,
              updated_at: new Date(),
              version: sql`planning.task_snooze.version + 1`,
            }),
          )
          .execute();
        return {
          status: 200,
          ref: { id: t.publicId, type: 'task' },
          data: await this.snoozeView(tx, p, t),
        };
      },
      async (tx, p, ref) => this.snoozeView(tx, p, await this.loadTask(tx, p, ref.id)),
    );
  }

  async unsnoozeTask(caller: Caller, ws: unknown, tsk: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'task.unsnooze',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        this.requirePersonalAction(p, 'task.snooze', t);
        await tx.db
          .deleteFrom('planning.task_snooze')
          .where('owner_membership_id', '=', p.membershipId)
          .where('task_id', '=', t.id)
          .execute();
        return {
          status: 200,
          ref: { id: t.publicId, type: 'task' },
          data: await this.snoozeView(tx, p, t),
        };
      },
      async (tx, p, ref) => this.snoozeView(tx, p, await this.loadTask(tx, p, ref.id)),
    );
  }

  protected async snoozeView(tx: WorkspaceTransaction, p: Principal, t: LoadedTask) {
    const s = await tx.db
      .selectFrom('planning.task_snooze')
      .select(['until_at'])
      .where('owner_membership_id', '=', p.membershipId)
      .where('task_id', '=', t.id)
      .executeTakeFirst();
    const until =
      s && new Date(s.until_at) > new Date() ? new Date(s.until_at).toISOString() : null;
    return { id: t.publicId, type: 'task' as const, snoozed_until: until };
  }

  // ---------------------------------------------------------------------------------------------
  // Ordering commands (ADR-0016 D9): drag is a convenience over these.
  // ---------------------------------------------------------------------------------------------

  /** Readable siblings of a task in its list (brand, project, and parent), in rank order. */
  protected async readableSiblings(tx: WorkspaceTransaction, p: Principal, t: LoadedTask) {
    const vis = await this.taskVisibility(tx, p, false);
    let q = tx.db
      .selectFrom('work.task as t')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
      )
      .select(['t.id', 't.rank'])
      .where('r.lifecycle_state', '=', 'active')
      .where(vis.where('r', { project: sql`t.project_id` }));
    // The same list the sibling rank scope uses: parent, else project roots, else brand roots.
    q = t.row.parent_task_id
      ? q.where('t.parent_task_id', '=', t.row.parent_task_id)
      : t.row.project_id
        ? q.where('t.project_id', '=', t.row.project_id).where('t.parent_task_id', 'is', null)
        : q
            .where('t.brand_id', '=', t.brand.id)
            .where('t.project_id', 'is', null)
            .where('t.parent_task_id', 'is', null);
    return q
      .orderBy(sql`t.rank COLLATE "C"`)
      .orderBy('t.id')
      .execute();
  }

  /**
   * Moves a task up, down, to the top or bottom, or to a 1-based position among its readable
   * siblings. Returns the new position and an announcement for assistive technology.
   */
  async reorderTask(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    onlyKeys(b, ['position', 'index', 'version']);
    const position = b.position;
    if (!['up', 'down', 'top', 'bottom', 'to'].includes(position as string))
      throw invalid(issue('/position', 'invalid_option', 'Choose up, down, top, bottom, or to.'));
    if (
      position === 'to' &&
      (typeof b.index !== 'number' || !Number.isInteger(b.index) || b.index < 1)
    )
      throw invalid(issue('/index', 'invalid_number', 'Choose a position from 1.'));
    return this.mutate(
      caller,
      'task.reorder',
      ws,
      req,
      async (tx, p) => {
        const t = await this.ownedTask(tx, p, tsk);
        const expected =
          req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (b.version as number | undefined);
        if (expected === undefined) throw new TenancyError('precondition_required');
        requireVersion(expected, t.row.version);
        await this.lockTaskRoots(tx, [t.row.parent_task_id ?? t.row.project_id ?? t.brand.id]);
        const siblings = await this.readableSiblings(tx, p, t);
        const from = siblings.findIndex((s) => s.id === t.id);
        const others = siblings.filter((s) => s.id !== t.id);
        const target =
          position === 'up'
            ? Math.max(0, from - 1)
            : position === 'down'
              ? Math.min(others.length, from + 1)
              : position === 'top'
                ? 0
                : position === 'bottom'
                  ? others.length
                  : Math.min(others.length, (b.index as number) - 1);
        let version = t.row.version;
        let undo: { id: string; expires_at: string } | null = null;
        if (target !== from) {
          const after = target === 0 ? null : others[target - 1]!.id;
          const scope = this.siblingScope({
            brand: t.brand,
            project: t.row.project_id ? { id: t.row.project_id } : null,
            parent: t.row.parent_task_id ? { id: t.row.parent_task_id } : null,
          });
          const rank = await this.nextRank(
            tx,
            'work.task',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (q: any) => scope(q).where('id', '<>', t.id),
            after,
          );
          version = await this.setTaskRank(tx, caller, p, t, rank, from + 1, target + 1);
          undo = await this.recordUndo(tx, p, {
            command: 'task.reorder',
            targets: [{ id: t.id, version }],
            inverse: { rank: t.row.rank },
            before: {},
            after: {},
          });
        }
        const data = {
          id: t.publicId,
          type: 'task' as const,
          position: target + 1,
          total: siblings.length,
          announcement: `Moved to position ${target + 1} of ${siblings.length}.`,
          version,
          undo,
        };
        return { status: 200, ref: { id: t.publicId, type: 'task' }, data };
      },
      async (tx, p, ref) => {
        const t = await this.loadTask(tx, p, ref.id);
        const siblings = await this.readableSiblings(tx, p, t);
        const at = siblings.findIndex((s) => s.id === t.id) + 1;
        return {
          id: t.publicId,
          type: 'task' as const,
          position: at,
          total: siblings.length,
          announcement: `Moved to position ${at} of ${siblings.length}.`,
          version: t.row.version,
          undo: null,
        };
      },
    );
  }

  protected async setTaskRank(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    t: LoadedTask,
    rank: string,
    fromPosition: number,
    toPosition: number,
  ): Promise<number> {
    const version = t.row.version + 1;
    await tx.db
      .updateTable('work.task')
      .set({
        rank,
        updated_at: new Date(),
        updated_by_membership_id: p.membershipId,
        version,
      })
      .where('id', '=', t.id)
      .execute();
    await tx.db
      .updateTable('core.record')
      .set({ version: sql`version + 1` })
      .where('id', '=', t.id)
      .execute();
    await this.taskAudit(tx, caller, p, 'task.reordered', t, [
      change.plain('position', fromPosition, toPosition),
    ]);
    await this.workEvent(
      tx,
      caller,
      p,
      'work.task.moved',
      { type: 'work.task', id: t.id, sequence: version },
      { project_id: t.row.project_id, parent_task_id: t.row.parent_task_id, depth: t.row.depth },
      t.brand.id,
    );
    return version;
  }

  // ---------------------------------------------------------------------------------------------
  // Undo (ADR-0016 D11)
  // ---------------------------------------------------------------------------------------------

  protected override async recordUndo(
    tx: WorkspaceTransaction,
    p: Principal,
    entry: {
      command: string;
      targets: Array<{ id: string; version: number }>;
      inverse: Record<string, unknown>;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    },
  ): Promise<{ id: string; expires_at: string } | null> {
    // A status change into or out of done or cancelled is undone with Reopen, not here.
    const terminal = (k: unknown) => k === 'done' || k === 'cancelled';
    if ('status' in entry.after && (terminal(entry.after.status) || terminal(entry.before.status)))
      return null;
    // The actor's own long-expired rows go first (bounded by the owner index).
    await tx.db
      .deleteFrom('work.undo_entry')
      .where('owner_membership_id', '=', p.membershipId)
      .where('expires_at', '<', new Date(Date.now() - DAY_MS))
      .execute();
    const now = new Date();
    const expires = new Date(now.getTime() + this.ws.undoWindowSeconds * 1000);
    const publicId = newPublicId('und');
    await tx.db
      .insertInto('work.undo_entry')
      .values({
        id: newUuidV7(),
        public_id: publicId,
        workspace_id: tx.workspaceId,
        owner_membership_id: p.membershipId,
        command: entry.command,
        targets: JSON.stringify(entry.targets),
        inverse: JSON.stringify(entry.inverse),
        created_at: now,
        expires_at: expires,
      })
      .execute();
    return { id: publicId, expires_at: expires.toISOString() };
  }

  protected undoView(r: {
    public_id: string;
    command: string;
    state: string;
    expires_at: Date | string;
    version: number | string;
  }) {
    return {
      id: r.public_id,
      type: 'undo_entry' as const,
      command: r.command,
      state: r.state,
      expires_at: new Date(r.expires_at).toISOString(),
      version: Number(r.version),
    };
  }

  /**
   * Applies an undo entry: the actor's own, still available, within its window, and only while
   * every target is at the version the original change produced. The inverse runs through the same
   * commands (current authorization, workflow evaluation, audit) under the request's new
   * idempotency key. A conflicting later change makes the entry unavailable.
   */
  async applyUndo(caller: Caller, ws: unknown, und: unknown, req: Mutation) {
    if (!isPublic(und, 'und')) throw new TenancyError('not_found');
    try {
      return await this.mutate(
        caller,
        'task.undo',
        ws,
        req,
        async (tx, p) => {
          const e = await tx.db
            .selectFrom('work.undo_entry')
            .selectAll()
            .where('public_id', '=', und)
            .where('owner_membership_id', '=', p.membershipId)
            .forUpdate()
            .executeTakeFirst();
          if (!e) throw new TenancyError('not_found');
          if (e.state !== 'available')
            throw new TenancyError('conflict', {
              issues: [issue('/', 'stale', 'This change can no longer be undone.')],
            });
          if (new Date(e.expires_at).getTime() <= Date.now())
            throw new TenancyError('conflict', {
              issues: [issue('/', 'undo_expired', 'The time to undo this change has passed.')],
            });
          const targets = (
            typeof e.targets === 'string' ? JSON.parse(e.targets) : e.targets
          ) as Array<{
            id: string;
            version: number;
          }>;
          const inverse = (
            typeof e.inverse === 'string' ? JSON.parse(e.inverse) : e.inverse
          ) as Record<string, unknown>;
          const done: string[] = [];
          for (const target of targets) {
            const pub = await this.publicOf(tx, target.id);
            const t = await this.loadTask(tx, p, pub ?? NIL, { lock: true });
            if (t.row.version !== target.version) throw new UndoConflict();
            const per =
              (inverse.items as Record<string, Record<string, unknown>> | undefined)?.[target.id] ??
              inverse;
            await this.applyInverse(tx, caller, req, p, t, e.command, per);
            await this.workEvent(
              tx,
              caller,
              p,
              'work.task.undone',
              { type: 'work.task', id: t.id, sequence: t.row.version + 1 },
              { task_id: t.id, command: e.command },
              t.brand.id,
            );
            done.push(t.publicId);
          }
          await tx.db
            .updateTable('work.undo_entry')
            .set({ state: 'applied', closed_at: new Date(), version: Number(e.version) + 1 })
            .where('id', '=', e.id)
            .execute();
          this.d.metrics.count('work.undo.applied', 1, { outcome: 'applied' });
          return {
            status: 200,
            ref: { id: e.public_id, type: 'undo_entry' },
            data: {
              ...this.undoView({ ...e, state: 'applied', version: Number(e.version) + 1 }),
              tasks: done,
            },
          };
        },
        async (tx, _p, ref) => {
          const e = await tx.db
            .selectFrom('work.undo_entry')
            .selectAll()
            .where('public_id', '=', ref.id)
            .executeTakeFirstOrThrow();
          return { ...this.undoView(e), tasks: [] as string[] };
        },
      );
    } catch (err) {
      if (!(err instanceof UndoConflict)) throw err;
      // A later change won: the entry closes for good (its own transaction) and the caller learns
      // only that undo is no longer possible.
      await this.inWorkspace(caller, ws, {}, async (tx, p) => {
        await tx.db
          .updateTable('work.undo_entry')
          .set({ state: 'conflicted', closed_at: new Date(), version: sql`version + 1` })
          .where('public_id', '=', und)
          .where('owner_membership_id', '=', p.membershipId)
          .where('state', '=', 'available')
          .execute();
      });
      this.d.metrics.count('work.undo.applied', 1, { outcome: 'conflicted' });
      throw new TenancyError('conflict', {
        issues: [issue('/', 'stale', 'Someone changed this since, so it can no longer be undone.')],
      });
    }
  }

  protected async applyInverse(
    tx: WorkspaceTransaction,
    caller: Caller,
    req: Mutation,
    p: Principal,
    t: LoadedTask,
    command: string,
    inverse: Record<string, unknown>,
  ) {
    if (command === 'task.reorder') {
      this.requireTaskAction(p, 'record.update', t, { shares: false });
      this.requireTaskActive(t);
      await this.setTaskRank(tx, caller, p, t, inverse.rank as string, 0, 0);
      return;
    }
    if (command === 'bulk.add_label' || command === 'bulk.remove_label') {
      await this.toggleLabel(
        tx,
        caller,
        p,
        t,
        inverse.label as string,
        command === 'bulk.add_label' ? 'remove' : 'add',
      );
      return;
    }
    // Field edits (task.update and the bulk field operations).
    this.requireTaskAction(p, 'record.update', t);
    this.requireTaskActive(t);
    const fields = (inverse.fields ?? {}) as Record<string, unknown>;
    const current = this.currentFields(t.row, tx);
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields))
      if (JSON.stringify(current[k] ?? null) !== JSON.stringify(v ?? null)) next[k] = v;
    if (Object.keys(next).length) await this.applyTaskChanges(tx, caller, req, p, t, current, next);
  }

  // ---------------------------------------------------------------------------------------------
  // Bulk (ADR-0016 D8): a bounded explicit set, previewed first, executed once.
  // ---------------------------------------------------------------------------------------------

  protected parseBulk(body: unknown) {
    const b = isObj(body) ? body : {};
    onlyKeys(b, ['operation', 'params', 'tasks', 'mode']);
    if (!BULK_OPERATIONS.includes(b.operation as BulkOperation))
      throw invalid(issue('/operation', 'invalid_option', 'Choose a bulk action.'));
    const operation = b.operation as BulkOperation;
    if (!Array.isArray(b.tasks) || !b.tasks.length)
      throw invalid(issue('/tasks', 'required', 'Select at least one task.'));
    const tasks = [...new Set(b.tasks)];
    if (tasks.length > this.ws.bulkItemsMax)
      throw invalid(
        issue('/tasks', 'too_many', `Select at most ${this.ws.bulkItemsMax} tasks at once.`),
      );
    if (!tasks.every((t) => typeof t === 'string' && t.length <= 40))
      throw invalid(issue('/tasks', 'invalid_type', 'Select tasks by their identifiers.'));
    const mode =
      b.mode === undefined ? (DESTRUCTIVE.has(operation) ? 'atomic' : 'partial') : b.mode;
    if (mode !== 'atomic' && mode !== 'partial')
      throw invalid(issue('/mode', 'invalid_option', 'Choose all-or-nothing or partial.'));
    const params = isObj(b.params) ? b.params : {};
    const field = BULK_FIELD[operation];
    let value: unknown;
    if (field) {
      onlyKeys(params, ['value']);
      const issues = new Issues();
      value = taskField(field, params.value, issues, this.ws.taskEstimateMinutesMax);
      issues.throwIfAny();
      if (value === undefined && field !== 'due_date')
        throw invalid(issue('/params/value', 'required', 'Choose a value.'));
      if (value === undefined) value = null;
      if (field === 'status' && TERMINAL.has(value as never))
        throw invalid(
          issue('/params/value', 'use_complete', 'Complete or cancel tasks one at a time.'),
        );
    } else if (operation === 'add_label' || operation === 'remove_label') {
      onlyKeys(params, ['label']);
      if (!isPublic(params.label, 'lbl'))
        throw invalid(issue('/params/label', 'required', 'Choose a label.'));
      value = params.label;
    } else onlyKeys(params, []);
    return { operation, tasks: tasks as string[], mode: mode as 'atomic' | 'partial', value };
  }

  protected bulkView(
    r: {
      public_id: string;
      operation: string;
      mode: string;
      state: string;
      expires_at: Date | string;
      executed_at?: Date | string | null;
      version: number | string;
    },
    items: BulkItem[],
  ) {
    const counts: Partial<Record<BulkOutcome, number>> = {};
    for (const i of items) counts[i.outcome] = (counts[i.outcome] ?? 0) + 1;
    return {
      id: r.public_id,
      type: 'bulk_operation' as const,
      operation: r.operation,
      mode: r.mode,
      destructive: DESTRUCTIVE.has(r.operation as BulkOperation),
      state: r.state,
      expires_at: new Date(r.expires_at).toISOString(),
      executed_at: r.executed_at ? new Date(r.executed_at).toISOString() : null,
      items,
      counts,
      version: Number(r.version),
    };
  }

  /** What one item would do, without changing it (the same decisions execution makes). */
  protected async previewItem(
    tx: WorkspaceTransaction,
    p: Principal,
    t: LoadedTask,
    op: BulkOperation,
    value: unknown,
  ): Promise<Omit<BulkItem, 'task'>> {
    // The same decisions the commands make (the task's capability flags).
    const can = this.taskCapabilities(p, t);
    if (op === 'archive' || op === 'trash') {
      if (op === 'archive' && t.lifecycleState !== 'active') return { outcome: 'no_change' };
      return { outcome: can[op] ? 'ready' : 'forbidden' };
    }
    if (t.lifecycleState !== 'active')
      return { outcome: can.restore || can.trash ? 'invalid' : 'forbidden', code: 'archived' };
    if (op === 'add_label' || op === 'remove_label') {
      if (!can.edit_context) return { outcome: 'forbidden' };
      const label = await tx.db
        .selectFrom('work.label as l')
        .select('l.id')
        .where('l.public_id', '=', value as string)
        .where('l.brand_id', '=', t.brand.id)
        .where('l.state', '=', 'active')
        .executeTakeFirst();
      if (!label) return { outcome: 'invalid', code: 'label_unavailable' };
      const has = await tx.db
        .selectFrom('work.task_label')
        .select('label_id')
        .where('task_id', '=', t.id)
        .where('label_id', '=', label.id)
        .executeTakeFirst();
      return { outcome: (op === 'add_label') === !!has ? 'no_change' : 'ready' };
    }
    if (!can.edit) return { outcome: 'forbidden' };
    if (op === 'set_status') return this.previewStatus(tx, p, t, value as string);
    const field = BULK_FIELD[op]!;
    const current = this.currentFields(t.row, tx);
    if (JSON.stringify(current[field] ?? null) === JSON.stringify(value ?? null))
      return { outcome: 'no_change' };
    return { outcome: 'ready' };
  }

  /**
   * A bulk status change for one task through the one transition evaluator (2C W5–W8): the target
   * must be offered by this task's workflow (never mapped to another status), the edge allowed,
   * required fields present, and no confirmation or approval needed (those go one task at a time).
   */
  protected async previewStatus(
    tx: WorkspaceTransaction,
    p: Principal,
    t: LoadedTask,
    key: string,
  ): Promise<Omit<BulkItem, 'task'>> {
    const wf = await this.taskWorkflow(tx, t.brand.id, t.row.project_id);
    const from = statusRef(tx, t.row.status_id);
    if (TERMINAL.has(from.category)) return { outcome: 'invalid', code: 'use_reopen' };
    const target = offered('task', wf).find(
      (x) => x.key === key && x.state === 'active' && !TERMINAL.has(x.category),
    );
    if (!target) return { outcome: 'invalid', code: 'status_unavailable' };
    if (target.key === from.key) return { outcome: 'no_change', target: statusView(target) };
    const r = await this.workRecord(tx, p, t.publicId);
    const to = statusFromKey('task', wf, key, '/params/value');
    const g = this.gateFor(r, wf, from, to, 'edit');
    const e = this.evaluate(tx, p, g, await this.presenceFor(tx, p, g));
    const base = {
      target: statusView(to),
      required_fields: e.required.filter((x) => !x.satisfied).map((x) => x.label),
    };
    if (!e.allowed)
      return { outcome: 'invalid', code: e.issues[0]?.code ?? 'transition_not_allowed', ...base };
    if (e.approval.policy !== 'none')
      return { outcome: 'invalid', code: 'approval_required', ...base };
    if (e.confirmation !== 'none') return { outcome: 'invalid', code: 'needs_review', ...base };
    return { outcome: 'ready', ...base };
  }

  /**
   * The statuses a bulk status change may offer for a selection (ADR-0016 T8, review 01): each
   * readable task's workflow statuses (custom ones included), with how many selected tasks offer
   * each. A status offered by only some tasks is labelled so; it applies only in partial mode, and
   * the preview refuses it per item. Unreadable tasks are as absent as unknown ones.
   */
  async bulkStatusOptions(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const raw = typeof query.tasks === 'string' ? query.tasks.split(',').filter(Boolean) : [];
    if (!raw.length) throw invalid(issue('/tasks', 'required', 'Select at least one task.'));
    if (raw.length > this.ws.bulkItemsMax)
      throw invalid(
        issue('/tasks', 'too_many', `Select at most ${this.ws.bulkItemsMax} tasks at once.`),
      );
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const byKey = new Map<string, { status: ReturnType<typeof statusView>; tasks: number }>();
      const workflows = new Set<string>();
      let readable = 0;
      let editable = 0;
      for (const id of [...new Set(raw)]) {
        let t: LoadedTask;
        try {
          t = await this.loadTask(tx, p, id);
        } catch (err) {
          if (err instanceof TenancyError && err.code === 'not_found') continue;
          throw err;
        }
        readable++;
        if (!this.taskCapabilities(p, t).edit) continue;
        editable++;
        const wf = await this.taskWorkflow(tx, t.brand.id, t.row.project_id);
        workflows.add(wf?.publicId ?? 'default');
        for (const st of offered('task', wf))
          if (st.state === 'active' && !TERMINAL.has(st.category)) {
            const o = byKey.get(st.key) ?? { status: statusView(st), tasks: 0 };
            o.tasks++;
            byKey.set(st.key, o);
          }
      }
      return {
        tasks: readable,
        editable,
        mixed_workflows: workflows.size > 1,
        options: [...byKey.values()]
          .map((o) => ({ status: o.status, available_for: o.tasks, all: o.tasks === editable }))
          .sort((a, b) => Number(b.all) - Number(a.all)),
      };
    });
  }

  async previewBulk(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = this.parseBulk(body);
    return this.mutate(
      caller,
      'task.bulk_preview',
      ws,
      req,
      async (tx, p) => {
        const items: BulkItem[] = [];
        const ids: string[] = [];
        const versions: Record<string, number> = {};
        for (const pub of input.tasks) {
          let t: LoadedTask;
          try {
            t = await this.loadTask(tx, p, pub);
          } catch (err) {
            if (err instanceof TenancyError && err.code === 'not_found') {
              items.push({ task: pub, outcome: 'not_found' });
              continue;
            }
            throw err;
          }
          ids.push(t.id);
          versions[t.id] = t.row.version;
          items.push({
            task: pub,
            ...(await this.previewItem(tx, p, t, input.operation, input.value)),
          });
        }
        if (!ids.length)
          throw invalid(issue('/tasks', 'nothing_to_apply', 'None of these tasks can be changed.'));
        await tx.db
          .deleteFrom('work.bulk_operation')
          .where('owner_membership_id', '=', p.membershipId)
          .where('expires_at', '<', new Date(Date.now() - DAY_MS))
          .execute();
        const id = newUuidV7();
        const publicId = newPublicId('bop');
        const expires = new Date(Date.now() + this.ws.bulkPreviewTtlSeconds * 1000);
        await tx.db
          .insertInto('work.bulk_operation')
          .values({
            id,
            public_id: publicId,
            workspace_id: tx.workspaceId,
            owner_membership_id: p.membershipId,
            operation: input.operation,
            params: JSON.stringify({
              ...(input.value === undefined ? {} : { value: input.value }),
              // Each task's version at preview: a later change makes that item stale (ETag).
              versions,
            }),
            mode: input.mode,
            item_ids: ids,
            fingerprint: sha([input.operation, input.value ?? null, input.mode, input.tasks]),
            expires_at: expires,
          })
          .execute();
        return {
          status: 201,
          ref: { id: publicId, type: 'bulk_operation' },
          data: this.bulkView(
            {
              public_id: publicId,
              operation: input.operation,
              mode: input.mode,
              state: 'previewed',
              expires_at: expires,
              version: 0,
            },
            items,
          ),
        };
      },
      async (tx, p, ref) => this.renderBulk(tx, p, ref.id),
    );
  }

  protected async renderBulk(tx: WorkspaceTransaction, p: Principal, bop: string) {
    const r = await tx.db
      .selectFrom('work.bulk_operation')
      .selectAll()
      .where('public_id', '=', bop)
      .where('owner_membership_id', '=', p.membershipId)
      .executeTakeFirst();
    if (!r) throw new TenancyError('not_found');
    const results = (r.results ?? []) as Array<{
      task: string;
      outcome: BulkOutcome;
      code?: string;
    }>;
    return this.bulkView(r, results);
  }

  async getBulk(caller: Caller, ws: unknown, bop: unknown) {
    if (!isPublic(bop, 'bop')) throw new TenancyError('not_found');
    return this.inWorkspace(caller, ws, { readOnly: true }, (tx, p) => this.renderBulk(tx, p, bop));
  }

  /**
   * Executes a preview once. Safe operations (field and label changes) run each item in its own
   * savepoint and report every item; destructive ones (archive, trash) are all-or-nothing unless
   * the preview chose partial mode. A refused item in atomic mode leaves every task unchanged and
   * returns the per-item report in the conflict. Never a silent partial mutation.
   */
  async executeBulk(caller: Caller, ws: unknown, bop: unknown, req: Mutation) {
    if (!isPublic(bop, 'bop')) throw new TenancyError('not_found');
    return this.mutate(
      caller,
      'task.bulk_execute',
      ws,
      req,
      async (tx, p) => {
        const op = await tx.db
          .selectFrom('work.bulk_operation')
          .selectAll()
          .where('public_id', '=', bop)
          .where('owner_membership_id', '=', p.membershipId)
          .forUpdate()
          .executeTakeFirst();
        if (!op) throw new TenancyError('not_found');
        if (op.state !== 'previewed' || new Date(op.expires_at).getTime() <= Date.now())
          throw new TenancyError('conflict', {
            issues: [issue('/', 'stale', 'This preview expired. Preview the change again.')],
          });
        if (req.ifMatch !== undefined)
          requireVersion(parseIfMatch(req.ifMatch), Number(op.version));
        const operation = op.operation as BulkOperation;
        const { value, versions = {} } = op.params as {
          value?: unknown;
          versions?: Record<string, number>;
        };
        const items: BulkItem[] = [];
        const inverses: Record<string, Record<string, unknown>> = {};
        const targets: Array<{ id: string; version: number }> = [];
        for (const [i, id] of op.item_ids.entries()) {
          const pub = (await this.publicOf(tx, id)) ?? NIL;
          if (op.mode === 'partial') await sql`SAVEPOINT bulk_item`.execute(tx.db);
          try {
            const now = await tx.db
              .selectFrom('work.task')
              .select('version')
              .where('id', '=', id)
              .executeTakeFirst();
            if (now && versions[id] !== undefined && Number(now.version) !== versions[id])
              throw new TenancyError('conflict', {
                issues: [issue(`/tasks/${i}`, 'stale', 'This task changed after the preview.')],
              });
            const r = await this.executeItem(tx, caller, req, p, pub, operation, value);
            if (op.mode === 'partial') await sql`RELEASE SAVEPOINT bulk_item`.execute(tx.db);
            items.push({ task: pub, outcome: r.outcome });
            if (r.outcome === 'applied' && r.inverse) {
              inverses[id] = r.inverse;
              targets.push({ id, version: r.version! });
            }
          } catch (err) {
            const code =
              err instanceof TenancyError ? (err.issues?.[0]?.code ?? err.code) : 'failed';
            const kind = err instanceof TenancyError ? err.code : 'failed';
            const outcome: BulkOutcome =
              kind === 'not_found'
                ? 'not_found'
                : kind === 'forbidden'
                  ? 'forbidden'
                  : kind === 'conflict'
                    ? 'conflict'
                    : 'invalid';
            if (op.mode === 'atomic') {
              const report = [
                ...items,
                { task: pub, outcome, code },
                ...op.item_ids.slice(i + 1).map(() => ({ task: '', outcome: 'skipped' as const })),
              ];
              throw new TenancyError('conflict', {
                issues: [
                  issue(
                    `/tasks/${i}`,
                    'bulk_item_failed',
                    'One task could not be changed, so none were. Review it, or choose partial mode.',
                  ),
                ],
                conflict: {
                  bulk: this.bulkView(
                    op,
                    report.filter((x) => x.task),
                  ),
                } as never,
              });
            }
            await sql`ROLLBACK TO SAVEPOINT bulk_item`.execute(tx.db);
            items.push({ task: pub, outcome, code });
          }
        }
        await tx.db
          .updateTable('work.bulk_operation')
          .set({
            state: 'executed',
            results: JSON.stringify(items),
            executed_at: new Date(),
            version: Number(op.version) + 1,
          })
          .where('id', '=', op.id)
          .execute();
        const applied = items.filter((x) => x.outcome === 'applied').length;
        for (const outcome of new Set(items.map((x) => x.outcome)))
          this.d.metrics.count(
            'work.bulk.items',
            items.filter((x) => x.outcome === outcome).length,
            { outcome },
          );
        await writeOutboxEvent(tx, {
          type: 'work.bulk_operation.executed',
          aggregate: { type: 'work.bulk_operation', id: op.id, sequence: Number(op.version) + 1 },
          data: {
            operation,
            mode: op.mode,
            item_count: items.length,
            succeeded: applied,
            failed: items.filter((x) => !['applied', 'no_change'].includes(x.outcome)).length,
          },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
        });
        const undo =
          targets.length && !DESTRUCTIVE.has(operation)
            ? await this.recordUndo(tx, p, {
                command: `bulk.${operation}`,
                targets,
                inverse: { items: inverses },
                before: {},
                after: {},
              })
            : null;
        return {
          status: 200,
          ref: { id: op.public_id, type: 'bulk_operation' },
          data: {
            ...this.bulkView(
              {
                ...op,
                state: 'executed',
                executed_at: new Date(),
                version: Number(op.version) + 1,
              },
              items,
            ),
            undo,
          },
        };
      },
      async (tx, p, ref) => ({ ...(await this.renderBulk(tx, p, ref.id)), undo: null }),
    );
  }

  /** One bulk item through the same commands a single edit uses. */
  protected async executeItem(
    tx: WorkspaceTransaction,
    caller: Caller,
    req: Mutation,
    p: Principal,
    pub: string,
    op: BulkOperation,
    value: unknown,
  ): Promise<{ outcome: BulkOutcome; inverse?: Record<string, unknown>; version?: number }> {
    if (op === 'archive' || op === 'trash') {
      const t = await this.loadTask(tx, p, pub, { lock: true });
      if (t.ownLevel === null) throw new TenancyError('forbidden');
      if (op === 'archive' && t.lifecycleState !== 'active') return { outcome: 'no_change' };
      const facts = { id: t.id, brand: t.brand, lifecycleState: t.lifecycleState, chain: t.chain };
      const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
      if (op === 'archive')
        await this.d.lifecycle.archive(
          tx,
          this.issueLifecycle(tx, p, 'record.archive', facts),
          input,
          t.id,
        );
      else
        await this.d.lifecycle.trash(
          tx,
          this.issueLifecycle(tx, p, 'record.trash', facts),
          input,
          t.id,
        );
      return { outcome: 'applied' };
    }
    if (op === 'add_label' || op === 'remove_label') {
      const t = await this.ownedTask(tx, p, pub);
      const changed = await this.toggleLabel(
        tx,
        caller,
        p,
        t,
        value as string,
        op === 'add_label' ? 'add' : 'remove',
      );
      return changed
        ? { outcome: 'applied', inverse: { label: value }, version: t.row.version + 1 }
        : { outcome: 'no_change' };
    }
    const t = await this.editableTask(tx, p, pub);
    const field = BULK_FIELD[op]!;
    const current = this.currentFields(t.row, tx);
    if (JSON.stringify(current[field] ?? null) === JSON.stringify(value ?? null))
      return { outcome: 'no_change' };
    const version = await this.applyTaskChanges(tx, caller, req, p, t, current, { [field]: value });
    return {
      outcome: 'applied',
      inverse: { fields: { [field]: current[field] ?? null } },
      version,
    };
  }

  /** Adds or removes one label of the task's brand (bulk and undo); false when nothing changed. */
  protected async toggleLabel(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    t: LoadedTask,
    lbl: string,
    how: 'add' | 'remove',
  ): Promise<boolean> {
    this.requireTaskAction(p, 'record.update', t, { shares: false });
    this.requireTaskActive(t);
    const label = await tx.db
      .selectFrom('work.label as l')
      .select(['l.id', 'l.state'])
      .where('l.public_id', '=', lbl)
      .where('l.brand_id', '=', t.brand.id)
      .executeTakeFirst();
    if (!label || (how === 'add' && label.state !== 'active'))
      throw invalid(
        issue('/params/label', 'invalid_reference', "That label isn't available here."),
      );
    if (how === 'add') {
      const n = await tx.db
        .selectFrom('work.task_label')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('task_id', '=', t.id)
        .executeTakeFirstOrThrow();
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
        .executeTakeFirst();
      if (!Number(r.numInsertedOrUpdatedRows ?? 0)) return false;
      if (Number(n.n) + 1 > this.ws.taskLabelsMax)
        throw invalid(
          issue(
            '/params/label',
            'too_many',
            `A task can have at most ${this.ws.taskLabelsMax} labels.`,
          ),
        );
    } else {
      const r = await tx.db
        .deleteFrom('work.task_label')
        .where('task_id', '=', t.id)
        .where('label_id', '=', label.id)
        .executeTakeFirst();
      if (!Number(r.numDeletedRows)) return false;
    }
    await this.bumpTask(tx, t, p);
    await this.taskAudit(tx, caller, p, how === 'add' ? 'task.labeled' : 'task.unlabeled', t, [
      change.plain('label', how === 'add' ? null : lbl, how === 'add' ? lbl : null),
    ]);
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Task templates (TSK-028; the catalog is 10B)
  // ---------------------------------------------------------------------------------------------

  protected templateView(
    r: {
      public_id: string;
      name: string;
      version_number: number;
      item_count: number;
      brand: string | null;
    },
    omitted: readonly string[] = TASK_NOT_COPIED,
  ) {
    return {
      id: r.public_id,
      type: 'template' as const,
      target: 'task' as const,
      name: r.name,
      version: r.version_number,
      item_count: r.item_count,
      brand: r.brand,
      not_copied: [...omitted],
    };
  }

  protected async renderTemplate(tx: WorkspaceTransaction, tpl: string) {
    const t = await tx.db
      .selectFrom('core.record as r')
      .innerJoin('templates.template as t', 't.id', 'r.id')
      .innerJoin('templates.template_version as v', 'v.id', 't.current_version_id')
      .leftJoin('core.record as br', 'br.id', 't.brand_id')
      .select([
        'r.public_id',
        't.name',
        'v.version_number',
        'v.item_count',
        'br.public_id as brand',
      ])
      .where('r.public_id', '=', tpl)
      .executeTakeFirstOrThrow();
    return this.templateView(t);
  }

  /** Saves a readable task's reusable content as a new task template (immutable version 1). */
  async createTaskTemplate(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const b = isObj(body) ? body : {};
    onlyKeys(b, ['name', 'scope']);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 200)
      throw invalid(issue('/name', 'required', 'Name the template (at most 200 characters).'));
    const scope = b.scope ?? 'brand';
    if (scope !== 'brand' && scope !== 'workspace')
      throw invalid(issue('/scope', 'invalid_option', 'Choose brand or workspace.'));
    return this.mutate(
      caller,
      'template.create_task',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk);
        if (t.ownLevel === null) throw new TenancyError('not_found');
        this.requireTemplatesManage(p, t);
        const { pkg, omitted } = await serializeTask(
          tx,
          p,
          { id: t.id, brandId: t.brand.id, projectId: t.row.project_id, level: t.level },
          this.ws.templateItemsMax,
        );
        const id = newUuidV7();
        const publicId = newPublicId('tpl');
        const brandId = scope === 'brand' ? t.brand.id : null;
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
            name,
            target_record_type: 'task',
            current_version_id: versionId,
            created_by_membership_id: p.membershipId,
          })
          .execute();
        const count = taskPackageItems(pkg);
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
            created_from_record_type: 'task',
            created_by_membership_id: p.membershipId,
          })
          .execute();
        await this.workWriter.write(tx, cmd, {
          action: 'template.created',
          target: { recordId: id, type: 'template', publicId },
          changes: [
            change.content('name', { hash: `sha256:${sha(name).toString('hex')}` }),
            change.plain('target', null, 'task'),
            change.plain('item_count', null, count),
            change.plain('from_task', null, t.publicId),
          ],
        });
        await writeOutboxEvent(tx, {
          type: 'templates.template.created',
          aggregate: { type: 'templates.template', id, sequence: 0 },
          data: { target_record_type: 'task', item_count: count },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          ...(brandId ? { brandId } : {}),
        });
        const data = {
          ...this.templateView(
            {
              public_id: publicId,
              name,
              version_number: 1,
              item_count: count,
              brand: scope === 'brand' ? t.brand.publicId : null,
            },
            omitted,
          ),
        };
        return { status: 201, ref: { id: publicId, type: 'template' }, data };
      },
      async (tx, _p, ref) => this.renderTemplate(tx, ref.id),
    );
  }

  protected requireTemplatesManage(p: Principal, t: LoadedTask) {
    const o = decideBrand(p, 'templates.manage', { ...t.brand, lifecycleState: 'active' });
    this.decision('templates.manage', o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  /** A readable, active task template (unknown, foreign, and unreadable are one refusal). */
  protected async loadTaskTemplate(
    tx: WorkspaceTransaction,
    p: Principal,
    tpl: unknown,
    lock = false,
  ) {
    if (!isPublic(tpl, 'tpl')) throw new TenancyError('not_found');
    const vis = await this.taskVisibility(tx, p, false);
    let q = tx.db
      .selectFrom('core.record as r')
      .innerJoin('templates.template as t', (j) =>
        j.onRef('t.workspace_id', '=', 'r.workspace_id').onRef('t.id', '=', 'r.id'),
      )
      .innerJoin('templates.template_version as v', 'v.id', 't.current_version_id')
      .select([
        't.id',
        'r.public_id',
        't.name',
        't.brand_id',
        't.version',
        'v.id as version_id',
        'v.version_number',
        'v.content',
      ])
      .where('r.public_id', '=', tpl)
      .where('r.lifecycle_state', '=', 'active')
      .where('t.target_record_type', '=', 'task')
      .where(vis.where('r'));
    if (lock) q = q.forUpdate('t');
    const t = await q.executeTakeFirst();
    if (!t) throw new TenancyError('not_found');
    return t;
  }

  /** Appends a new immutable version from a task (templates.manage in the template's brand). */
  async versionTaskTemplate(
    caller: Caller,
    ws: unknown,
    tpl: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const b = isObj(body) ? body : {};
    onlyKeys(b, ['task', 'version']);
    return this.mutate(
      caller,
      'template.version_task',
      ws,
      req,
      async (tx, p) => {
        const tp = await this.loadTaskTemplate(tx, p, tpl, true);
        const expected =
          req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (b.version as number | undefined);
        if (expected !== undefined) requireVersion(expected, Number(tp.version));
        const t = await this.loadTask(tx, p, b.task);
        if (t.ownLevel === null) throw new TenancyError('not_found');
        if (tp.brand_id !== null && tp.brand_id !== t.brand.id)
          throw invalid(issue('/task', 'cross_brand', 'Use a task from the template’s brand.'));
        this.requireTemplatesManage(p, t);
        const { pkg, omitted } = await serializeTask(
          tx,
          p,
          { id: t.id, brandId: t.brand.id, projectId: t.row.project_id, level: t.level },
          this.ws.templateItemsMax,
        );
        const versionId = newUuidV7();
        const number = tp.version_number + 1;
        const count = taskPackageItems(pkg);
        await tx.db
          .insertInto('templates.template_version')
          .values({
            id: versionId,
            workspace_id: tx.workspaceId,
            template_id: tp.id,
            version_number: number,
            schema_version: 1,
            content: JSON.stringify(pkg),
            item_count: count,
            created_from_record_type: 'task',
            created_by_membership_id: p.membershipId,
          })
          .execute();
        await tx.db
          .updateTable('templates.template')
          .set({
            current_version_id: versionId,
            updated_at: new Date(),
            version: Number(tp.version) + 1,
          })
          .where('id', '=', tp.id)
          .execute();
        const cmd = this.cmd(caller, p, tp.brand_id);
        await this.workWriter.write(tx, cmd, {
          action: 'template.versioned',
          target: { recordId: tp.id, type: 'template', publicId: tp.public_id },
          changes: [
            change.plain('version', tp.version_number, number),
            change.plain('item_count', null, count),
            change.plain('from_task', null, t.publicId),
          ],
        });
        await writeOutboxEvent(tx, {
          type: 'templates.template.versioned',
          aggregate: { type: 'templates.template', id: tp.id, sequence: Number(tp.version) + 1 },
          data: { target_record_type: 'task', version: number, item_count: count },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          ...(tp.brand_id ? { brandId: tp.brand_id } : {}),
        });
        return {
          status: 200,
          ref: { id: tp.public_id, type: 'template' },
          data: {
            ...(await this.renderTemplate(tx, tp.public_id)),
            not_copied: omitted,
          },
        };
      },
      async (tx, _p, ref) => this.renderTemplate(tx, ref.id),
    );
  }

  /**
   * Creates a task from a task template at an explicit brand (and optional project). Content the
   * applier may not set there is left out and reported by kind (AT-137).
   */
  async applyTaskTemplate(caller: Caller, ws: unknown, tpl: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    onlyKeys(b, ['brand', 'project', 'title', 'due_date']);
    if (typeof b.brand !== 'string')
      throw invalid(issue('/brand', 'brand_required', 'Choose which brand the task belongs to.'));
    const issues = new Issues();
    const title = b.title !== undefined ? taskField('title', b.title, issues, 0) : undefined;
    const due = b.due_date !== undefined ? taskField('due_date', b.due_date, issues, 0) : undefined;
    issues.throwIfAny();
    let result: Awaited<ReturnType<typeof instantiateTask>> | null = null;
    const out = await this.mutate(
      caller,
      'template.apply_task',
      ws,
      req,
      async (tx, p) => {
        const tp = await this.loadTaskTemplate(tx, p, tpl);
        const c = await this.resolveContainer(
          tx,
          p,
          { brand: b.brand as string, ...(b.project ? { project: b.project as string } : {}) },
          null,
        );
        if (tp.brand_id !== null && tp.brand_id !== c.brand.id)
          throw invalid(
            issue('/template', 'invalid_reference', "That template isn't available here."),
          );
        this.requireCreateIn(p, c);
        const pkg = readTaskPackage(
          typeof tp.content === 'string' ? JSON.parse(tp.content) : tp.content,
          this.ws.templateItemsMax,
        );
        const level =
          recordLevel(p, {
            brand: c.brand,
            lifecycleState: 'active',
            shareLevel: null,
            projectChain: c.chain,
          }) ?? 'view';
        result = await instantiateTask(
          tx,
          {
            writer: this.workWriter,
            exec: this.exec(caller, p),
            source: { kind: 'template' },
            principal: p,
          },
          {
            brandId: c.brand.id,
            projectId: c.project?.id ?? null,
            pkg,
            overrides: {
              ...(title !== undefined ? { title: title as string } : {}),
              ...(due !== undefined ? { due_date: due as string | null } : {}),
            },
            origin: {
              kind: 'template',
              ref: { template: tp.public_id, version: tp.version_number },
            },
            level,
            itemsMax: this.ws.templateItemsMax,
          },
        );
        await writeOutboxEvent(tx, {
          type: 'templates.template.applied',
          aggregate: { type: 'templates.template', id: tp.id, sequence: Number(tp.version) },
          data: { template_version_id: tp.version_id, record_id: result.id },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: c.brand.id,
        });
        const task = await this.taskView(tx, p, await this.loadTask(tx, p, result.publicId));
        return { status: 201, ref: { id: result.publicId, type: 'task' }, data: task };
      },
      async (tx, p, ref) => this.taskView(tx, p, await this.loadTask(tx, p, ref.id)),
    );
    const r = result as Awaited<ReturnType<typeof instantiateTask>> | null;
    return {
      ...out,
      application: {
        task: out.data,
        copied: r?.copied ?? null,
        omitted: r?.omitted ?? null,
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Recurring tasks (TSK-027; the planning occurrence model)
  // ---------------------------------------------------------------------------------------------

  async listTaskRecurrences(caller: Caller, ws: unknown, tsk: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const t = await this.loadTask(tx, p, tsk);
      if (t.ownLevel === null) throw new TenancyError('not_found');
      const rows = await tx.db
        .selectFrom('planning.recurrence_series')
        .selectAll()
        .where('source_record_id', '=', t.id)
        .where('target_kind', '=', 'task')
        .orderBy('created_at')
        .execute();
      return rows.map((r) => seriesView(r));
    });
  }

  async defineTaskRecurrence(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    body: unknown,
    req: Mutation,
  ) {
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
      'recurrence.define_task',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        this.requireTaskAction(p, 'task.manage_recurrence', t, { shares: false });
        this.requireTaskActive(t);
        const { id, publicId } = await this.createTaskSeries(tx, caller, p, t, {
          rrule: input.rrule,
          rule,
          anchor_tz: input.anchor_tz,
          start: input.start,
        });
        return {
          status: 201,
          ref: { id: publicId, type: 'recurrence_series' },
          data: seriesView(await this.seriesRow(tx, id)),
        };
      },
      async (tx, _p, ref) => seriesView(await this.seriesRowByPublic(tx, ref.id)),
    );
  }

  /**
   * Freezes a task's snapshot into a new task series owned by `p` (the caller has checked
   * task.manage_recurrence). Shared by Repeat and by capture triage of a parsed recurrence (2E).
   */
  protected async createTaskSeries(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    t: LoadedTask,
    input: { rrule: string; rule: ReturnType<typeof parseRule>; anchor_tz: string; start: string },
  ): Promise<{ id: string; publicId: string }> {
    const rule = input.rule;
    const project = t.row.project_id
      ? await this.loadProject(tx, p, (await this.publicOf(tx, t.row.project_id))!)
      : null;
    this.requireCreateIn(p, { brand: t.brand, project, chain: t.chain });
    // The snapshot is frozen once here and never updated (database guard).
    const { pkg } = await serializeTask(
      tx,
      p,
      { id: t.id, brandId: t.brand.id, projectId: t.row.project_id, level: t.level },
      this.ws.templateItemsMax,
    );
    const first = occurrences(rule, input.start, null, 1)[0];
    if (!first)
      throw invalid(
        issue('/ends', 'ends_before_first', 'This schedule ends before its first occurrence.'),
      );
    const id = newUuidV7();
    const publicId = newPublicId('rcs');
    await tx.db
      .insertInto('planning.recurrence_series')
      .values({
        id,
        public_id: publicId,
        workspace_id: tx.workspaceId,
        brand_id: t.brand.id,
        target_kind: 'task',
        source_record_id: t.id,
        project_id: t.row.project_id,
        rrule: input.rrule,
        anchor_tz: input.anchor_tz,
        dtstart_local: input.start,
        template_payload: JSON.stringify(pkg),
        payload_item_count: taskPackageItems(pkg),
        next_due_at: localToUtc(first, input.anchor_tz),
        owner_membership_id: p.membershipId,
      })
      .execute();
    await this.taskAudit(tx, caller, p, 'recurrence.defined', t, [
      change.plain('series', null, publicId),
      change.plain('rrule', null, input.rrule),
      change.plain('anchor_tz', null, input.anchor_tz),
    ]);
    await writeOutboxEvent(tx, {
      type: 'planning.recurrence_series.defined',
      aggregate: { type: 'planning.recurrence_series', id, sequence: 0 },
      data: { target_kind: 'task' },
      actor: { type: 'human', id: p.membershipId },
      context: this.exec(caller, p),
      brandId: t.brand.id,
    });
    return { id, publicId };
  }

  protected seriesRow(tx: WorkspaceTransaction, id: string) {
    return tx.db
      .selectFrom('planning.recurrence_series')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  protected seriesRowByPublic(tx: WorkspaceTransaction, pub: string) {
    return tx.db
      .selectFrom('planning.recurrence_series')
      .selectAll()
      .where('public_id', '=', pub)
      .executeTakeFirstOrThrow();
  }

  protected async taskSeries(tx: WorkspaceTransaction, t: LoadedTask, rcs: unknown) {
    if (!isPublic(rcs, 'rcs')) throw new TenancyError('not_found');
    const s = await tx.db
      .selectFrom('planning.recurrence_series')
      .selectAll()
      .where('public_id', '=', rcs)
      .where('source_record_id', '=', t.id)
      .where('target_kind', '=', 'task')
      .forUpdate()
      .executeTakeFirst();
    if (!s) throw new TenancyError('not_found');
    return s;
  }

  async setTaskRecurrenceState(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    rcs: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const state = isObj(body) ? body.state : undefined;
    if (state !== 'active' && state !== 'paused')
      throw invalid(issue('/state', 'invalid_option', 'Choose pause or resume.'));
    return this.mutate(
      caller,
      'recurrence.state_task',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        this.requireTaskAction(p, 'task.manage_recurrence', t, { shares: false });
        const s = await this.taskSeries(tx, t, rcs);
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), Number(s.version));
        if (s.state !== state) {
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
              // Resuming makes the resumer the owner whose authority later runs are checked against.
              ...(state === 'active' ? { owner_membership_id: p.membershipId } : {}),
              updated_at: new Date(),
              version: Number(s.version) + 1,
            })
            .where('id', '=', s.id)
            .execute();
          await this.taskAudit(tx, caller, p, 'recurrence.state_changed', t, [
            change.plain('state', s.state, state),
          ]);
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
            brandId: t.brand.id,
          });
        }
        return {
          status: 200,
          ref: { id: s.public_id, type: 'recurrence_series' },
          data: seriesView(await this.seriesRow(tx, s.id)),
        };
      },
      async (tx, _p, ref) => seriesView(await this.seriesRowByPublic(tx, ref.id)),
    );
  }

  /** Manual "next occurrence": generates the next one now, idempotently by occurrence key. */
  async generateNextTaskOccurrence(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    rcs: unknown,
    req: Mutation,
  ) {
    return this.mutate(
      caller,
      'recurrence.generate_task',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        this.requireTaskAction(p, 'task.manage_recurrence', t, { shares: false });
        const s = await this.taskSeries(tx, t, rcs);
        const project = s.project_id
          ? await this.loadProject(tx, p, (await this.publicOf(tx, s.project_id))!)
          : null;
        this.requireCreateIn(p, { brand: t.brand, project, chain: project?.chain ?? [] });
        const level =
          recordLevel(p, {
            brand: t.brand,
            lifecycleState: 'active',
            shareLevel: null,
            projectChain: project?.chain ?? [],
          }) ?? 'view';
        const out = await generateTaskOccurrences(tx, {
          series: s,
          limit: 1,
          due: null,
          maxItems: this.ws.templateItemsMax,
          level,
          context: {
            writer: this.workWriter,
            exec: this.exec(caller, p),
            source: { kind: 'template' },
            principal: p,
          },
        });
        this.d.metrics.count('work.recurrence.occurrences', out.generated.length, {
          outcome: 'manual',
        });
        return {
          status: out.generated.length ? 201 : 200,
          ref: { id: s.public_id, type: 'recurrence_series' },
          data: {
            ...seriesView(await this.seriesRow(tx, s.id)),
            occurrence: out.generated[0] ?? null,
          },
        };
      },
      async (tx, _p, ref) => ({
        ...seriesView(await this.seriesRowByPublic(tx, ref.id)),
        occurrence: null,
      }),
    );
  }

  /** Inline edits share updateTask; the editable field set is exported for the client. */
  static readonly INLINE_FIELDS = TASK_FIELDS;
}

const NIL = '00000000-0000-7000-8000-000000000000';

class UndoConflict extends Error {}

function reminderView(r: {
  public_id: string;
  remind_at: Date | string;
  state: string;
  fired_at: Date | string | null;
  version: number | string;
}) {
  return {
    id: r.public_id,
    type: 'task_reminder' as const,
    remind_at: new Date(r.remind_at).toISOString(),
    state: r.state,
    fired_at: r.fired_at ? new Date(r.fired_at).toISOString() : null,
    version: Number(r.version),
  };
}

export type { TaskPackage };
