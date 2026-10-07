import { createHash } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { evenRanks, rankBetween } from '@pm/contracts/shell';
import { sql, type RawBuilder, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import {
  invalid,
  issue,
  parseIfMatch,
  requireVersion,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import {
  composeRule,
  localToUtc,
  occurrences,
  parseRule,
  RuleError,
  utcToLocal,
} from '../recurrence.ts';
import { TimeService } from '../time/time-service.ts';
import { addDays, daysBetween, localDay, parseInstant, validDay } from '../time/semantics.ts';
import { isPublic } from '../validation.ts';
import { blockWarnings, dayBounds, minutesBetween, validClock, wholeMinute } from './semantics.ts';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const sha = (s: string) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;
const NIL = '00000000-0000-7000-8000-000000000000';
const OPEN = ['planned', 'active', 'paused'];
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

type Action = 'carry' | 'pick_day' | 'return' | 'leave';

interface TaskFacts {
  id: string;
  publicId: string;
  brandId: string;
  title: string;
  due_date: string | null;
  deadline_date: string | null;
  deadline_at: Date | null;
  estimate_minutes: number | null;
  remaining_estimate_minutes: number | null;
  status_category: string;
}

interface BlockRow {
  id: string;
  public_id: string;
  owner_membership_id: string;
  task_id: string | null;
  brand_id: string | null;
  title: string | null;
  starts_at: Date;
  ends_at: Date;
  source_tz: string;
  focus: boolean;
  locked: boolean;
  prep_minutes: number;
  buffer_minutes: number;
  source: 'manual' | 'estimate' | 'recurrence';
  series_id: string | null;
  occurrence_key: string | null;
  version: string | number;
}

/**
 * Phase 3C Today and manual planning (ADR-0021; 0B ADR-29, 0C AZ-29, 0D PL-31). Personal
 * commitments to do tasks on a day (never changing their dates), manual order and locks, work
 * blocks distinct from due dates and deadlines (focus protection, preparation and buffer time,
 * blocks from estimates, recurring blocks through the 2A rule engine), daily planning and
 * shutdown with unfinished-work rescheduling, and append-only planned-versus-completed records.
 * Today's lists run the 3A query engine; tasks resolve through the task loader and the compiled
 * visibility predicate; time comes from 3D. Capacity, calendar events, and AI plans are 3E, 6C,
 * and 7F.
 */
export class PlanningService extends TimeService {
  // ---------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------

  protected override mapFailure(command: string, err: unknown): unknown {
    const pg =
      typeof err === 'object' && err !== null
        ? (err as { code?: string; message?: string; constraint?: string })
        : {};
    if (pg.code === '23P01' && pg.message?.startsWith('focus_protected')) {
      this.count(command, 'conflict');
      return new TenancyError('conflict', {
        issues: [issue('/starts_at', 'focus_protected', 'This time overlaps a focus block.')],
      });
    }
    if (pg.code === '23505' && pg.constraint === 'today_commitment_once') {
      this.count(command, 'conflict');
      return new TenancyError('conflict', {
        issues: [issue('/task', 'already_committed', 'This task is already on that day.')],
      });
    }
    if (pg.code === '23505' && pg.constraint === 'daily_record_once') {
      this.count(command, 'conflict');
      return new TenancyError('conflict', {
        issues: [issue('/', 'already_closed', 'This day is already closed.')],
      });
    }
    return super.mapFailure(command, err);
  }

  /** Serializes one person's planning for a day (commitments, ranks, shutdown). */
  protected async lockDay(tx: WorkspaceTransaction, membershipId: string, day: string) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`planning.day:${tx.workspaceId}:${membershipId}:${day}`}, 0))`.execute(
      tx.db,
    );
  }

  protected async todayFor(tx: WorkspaceTransaction, p: Principal) {
    const tz = await this.personZone(tx, p.membershipId);
    return { tz, today: localDay(new Date(), tz) };
  }

  protected parseDay(v: unknown, path = '/day'): string {
    const d = validDay(v);
    if (!d) throw invalid(issue(path, 'invalid', 'Choose a valid day.'));
    return d;
  }

  protected async dayClosed(tx: WorkspaceTransaction, membershipId: string, day: string) {
    const r = await tx.db
      .selectFrom('planning.daily_record')
      .select('id')
      .where('owner_membership_id', '=', membershipId)
      .where('day', '=', day)
      .executeTakeFirst();
    return !!r;
  }

  protected async requireOpenDay2(tx: WorkspaceTransaction, membershipId: string, day: string) {
    if (await this.dayClosed(tx, membershipId, day))
      throw new TenancyError('conflict', {
        issues: [issue('/day', 'day_closed', 'This day is closed. Its record no longer changes.')],
      });
  }

  /** A task the person can read now (active, not trashed), with the facts planning needs. */
  protected async plannableTask(
    tx: WorkspaceTransaction,
    p: Principal,
    ref: unknown,
    path = '/task',
  ): Promise<TaskFacts> {
    if (ref === undefined || ref === null || ref === '')
      throw invalid(issue(path, 'required', 'Choose a task.'));
    const t = await this.loadTask(tx, p, ref);
    if (t.lifecycleState !== 'active')
      throw new TenancyError('conflict', {
        issues: [issue(path, 'task_archived', 'This task is archived. Restore it to plan it.')],
      });
    return {
      id: t.id,
      publicId: t.publicId,
      brandId: t.brand.id,
      title: t.row.title,
      due_date: t.row.due_date,
      deadline_date: t.row.deadline_date,
      deadline_at: t.row.deadline_at,
      estimate_minutes: t.row.estimate_minutes,
      remaining_estimate_minutes: t.row.remaining_estimate_minutes,
      status_category: t.row.status_category,
    };
  }

  /** The predicate over a task alias `t` / record alias `r` for the viewer (view; active only). */
  protected async readableTasks(tx: WorkspaceTransaction, p: Principal) {
    const vis = await this.taskVisibility(tx, p, false);
    return vis.where('r', { project: sql`t.project_id` });
  }

  protected async planAudit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    target: { id: string; type: string; publicId: string | null },
    changes: ReturnType<typeof change.plain>[],
    brandId: string | null,
  ) {
    await this.workWriter.write(tx, this.cmd(caller, p, brandId), {
      action,
      target: { recordId: target.id, type: target.type, publicId: target.publicId },
      changes,
    });
  }

  protected async planEvent(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    type: Parameters<typeof writeOutboxEvent>[1]['type'],
    aggregate: { type: string; id: string; sequence: number },
    data: Record<string, string | number | boolean | null>,
    brandId: string | null,
  ) {
    await writeOutboxEvent(tx, {
      type,
      aggregate,
      data,
      actor: { type: 'human', id: p.membershipId },
      context: this.exec(caller, p),
      ...(brandId ? { brandId } : {}),
    });
  }

  // ---------------------------------------------------------------------------------------------
  // The Today view (PLAN-001, PLAN-002, PLAN-003, PLAN-005, PLAN-006)
  // ---------------------------------------------------------------------------------------------

  /** One 3A query for a Today section, run with the viewer's own predicate. */
  protected async section(
    tx: WorkspaceTransaction,
    p: Principal,
    today: string,
    filter: Array<Record<string, unknown>>,
    sort: Array<{ field: string; dir: 'asc' | 'desc' }>,
  ) {
    const r = await this.runQuery(
      tx,
      p,
      {
        query: {
          v: 1,
          entity: 'task',
          filter: {
            op: 'and',
            items: [
              { field: 'assignee', op: 'any_of', value: ['me'] },
              { field: 'status_category', op: 'in', value: OPEN },
              ...filter,
            ],
          },
          sort,
        },
        presentation: { columns: ['due_date', 'deadline_date', 'estimate_minutes'] },
        today,
      },
      { entity: 'task', limit: this.ws.todayListMax, includeTotal: false, groups: false },
    );
    return {
      items: r.data.map((d) => ({
        id: d.id as string,
        title: d.title as string,
        brand: d.brand as Record<string, unknown>,
        status: d.status as Record<string, unknown>,
        priority: d.priority as string,
        due_date: (d.due_date as string | null) ?? null,
        deadline_date: (d.deadline_date as string | null) ?? null,
        estimate_minutes: (d.estimate_minutes as number | null) ?? null,
      })),
      has_more: r.page.has_more,
    };
  }

  protected async commitmentRows(
    tx: WorkspaceTransaction,
    p: Principal,
    day: string,
    readable: RawBuilder<boolean>,
  ) {
    return (
      await sql<{
        id: string;
        task_id: string;
        brand_id: string;
        rank: string;
        locked: boolean;
        outcome: string;
        carried_to: string | null;
        source: string;
        version: string;
        public_id: string;
        title: string;
        status_category: string;
        due_date: string | null;
        deadline_date: string | null;
        estimate_minutes: number | null;
        remaining_estimate_minutes: number | null;
        brand_public_id: string;
        brand_name: string;
        readable: boolean;
      }>`SELECT c.id, c.task_id, c.brand_id, c.rank, c.locked, c.outcome, c.carried_to::text AS carried_to,
            c.source, c.version, r.public_id, t.title, t.status_category, t.due_date::text AS due_date,
            t.deadline_date::text AS deadline_date, t.estimate_minutes, t.remaining_estimate_minutes,
            br.public_id AS brand_public_id, b.name AS brand_name, ${readable} AS readable
          FROM planning.today_commitment c
          JOIN work.task t ON t.workspace_id = c.workspace_id AND t.id = c.task_id
          JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
          JOIN tenancy.brand b ON b.id = c.brand_id
          JOIN core.record br ON br.id = b.id
         WHERE c.owner_membership_id = ${p.membershipId}::uuid AND c.day = ${day}::date
         ORDER BY c.rank COLLATE "C", c.id`.execute(tx.db)
    ).rows;
  }

  protected async blocksIn(
    tx: WorkspaceTransaction,
    p: Principal,
    start: Date,
    end: Date,
    readable: RawBuilder<boolean>,
  ) {
    const rows = (
      await sql<
        BlockRow & {
          task_public_id: string | null;
          task_title: string | null;
          readable: boolean | null;
          due_date: string | null;
          deadline_date: string | null;
          deadline_at: Date | null;
          series_public_id: string | null;
        }
      >`SELECT w.*, r.public_id AS task_public_id, t.title AS task_title,
            CASE WHEN w.task_id IS NULL THEN NULL ELSE coalesce(${readable}, false) END AS readable,
            t.due_date::text AS due_date, t.deadline_date::text AS deadline_date, t.deadline_at,
            s.public_id AS series_public_id
          FROM planning.work_block w
          LEFT JOIN work.task t ON t.workspace_id = w.workspace_id AND t.id = w.task_id
          LEFT JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
          LEFT JOIN planning.block_series s ON s.workspace_id = w.workspace_id AND s.id = w.series_id
         WHERE w.owner_membership_id = ${p.membershipId}::uuid
           AND w.starts_at < ${end}::timestamptz AND w.ends_at > ${start}::timestamptz
         ORDER BY w.starts_at, w.id`.execute(tx.db)
    ).rows;
    return rows;
  }

  protected blockView(
    b: Awaited<ReturnType<PlanningService['blocksIn']>>[number],
    viewerTz: string,
  ) {
    // A block on a task the owner can no longer read stays as busy time without its task (AT-171).
    const task = b.task_id && b.readable ? { id: b.task_public_id!, title: b.task_title! } : null;
    const end = new Date(b.ends_at);
    return {
      id: b.public_id,
      type: 'work_block' as const,
      task,
      unavailable: !!b.task_id && !b.readable,
      title: b.task_id ? null : b.title,
      starts_at: iso(b.starts_at)!,
      ends_at: iso(b.ends_at)!,
      minutes: minutesBetween(new Date(b.starts_at), end),
      source_tz: b.source_tz,
      focus: b.focus,
      locked: b.locked,
      prep_minutes: Number(b.prep_minutes),
      buffer_minutes: Number(b.buffer_minutes),
      source: b.source,
      series: b.series_public_id,
      warnings:
        b.task_id && b.readable
          ? blockWarnings(end, viewerTz, {
              due_date: b.due_date,
              deadline_date: b.deadline_date,
              deadline_at: b.deadline_at ? new Date(b.deadline_at) : null,
            })
          : [],
      version: Number(b.version),
    };
  }

  protected async dayView(tx: WorkspaceTransaction, p: Principal, day: string) {
    const { tz, today } = await this.todayFor(tx, p);
    const readable = await this.readableTasks(tx, p);
    const { start, end } = dayBounds(day, tz);
    const commitments = (await this.commitmentRows(tx, p, day, readable)).filter((c) => c.readable);
    const blocks = (await this.blocksIn(tx, p, start, end, readable)).map((b) =>
      this.blockView(b, tz),
    );
    const record = await tx.db
      .selectFrom('planning.daily_record')
      .selectAll()
      .where('owner_membership_id', '=', p.membershipId)
      .where('day', '=', day)
      .executeTakeFirst();
    const open = commitments.filter((c) => c.outcome === 'open');
    const est = (c: {
      remaining_estimate_minutes: number | null;
      estimate_minutes: number | null;
    }) => c.remaining_estimate_minutes ?? c.estimate_minutes;
    const committedIds = new Set(commitments.map((c) => c.public_id));
    const mark = <T extends { id: string }>(x: { items: T[]; has_more: boolean }) => ({
      ...x,
      items: x.items.map((i) => ({ ...i, committed: committedIds.has(i.id) })),
    });
    // Today's lists are about the person's real today (OD-18), whatever day is being viewed.
    const overdue = mark(
      await this.section(
        tx,
        p,
        today,
        [{ field: 'due_date', op: 'before', value: { rel: 'today', days: 0 } }],
        [{ field: 'due_date', dir: 'asc' }],
      ),
    );
    const dueToday = mark(
      await this.section(
        tx,
        p,
        today,
        [{ field: 'due_date', op: 'on', value: { rel: 'today', days: 0 } }],
        [{ field: 'priority', dir: 'desc' }],
      ),
    );
    const upcoming = mark(
      await this.section(
        tx,
        p,
        today,
        [
          {
            field: 'deadline_date',
            op: 'between',
            value: [
              { rel: 'today', days: 0 },
              { rel: 'today', days: this.ws.upcomingDeadlineDays },
            ],
          },
        ],
        [{ field: 'deadline_date', dir: 'asc' }],
      ),
    );
    const blockMinutes = blocks.reduce((s, b) => s + b.minutes, 0);
    return {
      day,
      tz,
      today,
      server_now: new Date().toISOString(),
      closed: !!record,
      committed: commitments.map((c) => ({
        task: {
          id: c.public_id,
          title: c.title,
          brand: { id: c.brand_public_id, name: c.brand_name },
          status_category: c.status_category,
          due_date: c.due_date,
          deadline_date: c.deadline_date,
          estimate_minutes: est(c),
        },
        rank: c.rank,
        locked: c.locked,
        outcome: c.outcome,
        carried_to: c.carried_to,
        source: c.source,
        done: c.status_category === 'done',
        blocks: blocks.filter((b) => b.task?.id === c.public_id).map((b) => b.id),
        version: Number(c.version),
      })),
      scheduled: blocks,
      overdue,
      due_today: dueToday,
      upcoming_deadlines: upcoming,
      totals: {
        committed: open.length,
        estimate_minutes: open.reduce((s, c) => s + (est(c) ?? 0), 0),
        unestimated: open.filter((c) => est(c) === null).length,
        block_minutes: blockMinutes,
        focus_minutes: blocks.filter((b) => b.focus).reduce((s, b) => s + b.minutes, 0),
      },
      // Honest absences: working hours and capacity are 3E; calendar events are 6C.
      available_minutes: null,
      capacity: { available: false, owner: '3E' },
      meetings: { available: false, owner: '6C' },
      record: record ? this.recordView(record) : null,
      can_shutdown: !record && day <= today,
    };
  }

  async todayView(caller: Caller, ws: unknown, day: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const d =
        day === undefined || day === 'today'
          ? (await this.todayFor(tx, p)).today
          : this.parseDay(day);
      return this.dayView(tx, p, d);
    });
  }

  /**
   * The daily plan (PLAN-018): what is already committed (carried-in included) and suggestions
   * the person can commit in one step: overdue and due-today tasks not yet on the day.
   */
  async dayPlan(caller: Caller, ws: unknown, day: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const d =
        day === undefined || day === 'today'
          ? (await this.todayFor(tx, p)).today
          : this.parseDay(day);
      const v = await this.dayView(tx, p, d);
      const seen = new Set<string>();
      const suggestions = [...v.overdue.items, ...v.due_today.items, ...v.upcoming_deadlines.items]
        .filter((i) => !i.committed && !seen.has(i.id) && seen.add(i.id))
        .map((i) => ({
          ...i,
          reason: v.overdue.items.some((o) => o.id === i.id)
            ? 'overdue'
            : v.due_today.items.some((o) => o.id === i.id)
              ? 'due_today'
              : 'deadline_soon',
        }));
      return {
        day: v.day,
        tz: v.tz,
        closed: v.closed,
        carried_in: v.committed.filter((c) => c.source === 'carry').map((c) => c.task.id),
        committed: v.committed.map((c) => c.task.id),
        suggestions,
        totals: v.totals,
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Commitments (PLAN-008, PLAN-009, PLAN-016, PLAN-017)
  // ---------------------------------------------------------------------------------------------

  protected async commitmentView(
    tx: WorkspaceTransaction,
    p: Principal,
    day: string,
    taskId: string,
  ) {
    const readable = await this.readableTasks(tx, p);
    const c = (await this.commitmentRows(tx, p, day, readable)).find((x) => x.task_id === taskId);
    if (!c || !c.readable) throw new TenancyError('not_found');
    return {
      id: `${day}:${c.public_id}`,
      type: 'today_commitment' as const,
      day,
      task: { id: c.public_id, title: c.title },
      rank: c.rank,
      locked: c.locked,
      outcome: c.outcome,
      carried_to: c.carried_to,
      source: c.source,
      version: Number(c.version),
    };
  }

  protected async lastRank(tx: WorkspaceTransaction, membershipId: string, day: string) {
    const r = await tx.db
      .selectFrom('planning.today_commitment')
      .select('rank')
      .where('owner_membership_id', '=', membershipId)
      .where('day', '=', day)
      .orderBy(sql`rank COLLATE "C"`, 'desc')
      .limit(1)
      .executeTakeFirst();
    return r?.rank ?? null;
  }

  protected async insertCommitment(
    tx: WorkspaceTransaction,
    p: Principal,
    day: string,
    task: TaskFacts,
    source: 'manual' | 'plan' | 'carry',
  ) {
    const n = await tx.db
      .selectFrom('planning.today_commitment')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('owner_membership_id', '=', p.membershipId)
      .where('day', '=', day)
      .executeTakeFirstOrThrow();
    if (Number(n.n) >= this.ws.todayItemsMax)
      throw invalid(
        issue('/task', 'too_many', `A day can hold at most ${this.ws.todayItemsMax} tasks.`),
      );
    const last = await this.lastRank(tx, p.membershipId, day);
    const rank = rankBetween(last, null) ?? evenRanks(1)[0]!;
    const id = newUuidV7();
    await tx.db
      .insertInto('planning.today_commitment')
      .values({
        id,
        workspace_id: tx.workspaceId,
        owner_membership_id: p.membershipId,
        day,
        task_id: task.id,
        brand_id: task.brandId,
        rank,
        source,
      })
      .execute();
    return id;
  }

  /**
   * Commits one task (`task`) or several (`tasks`, from the daily plan) to a day in the viewer's
   * zone. Today or later only; a closed day is final. The task's dates never change (PLAN-008).
   */
  async commit(caller: Caller, ws: unknown, day: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const refs = Array.isArray(b.tasks) ? b.tasks : [b.task];
    if (!refs.length || refs.length > this.ws.todayItemsMax)
      throw invalid(issue('/tasks', 'invalid', 'Choose the tasks to commit.'));
    return this.mutate(
      caller,
      'planning.commit',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const { today } = await this.todayFor(tx, p);
        const d = this.parseDay(day);
        if (d < today)
          throw invalid(issue('/day', 'past_day', 'Commit work to today or a later day.'));
        await this.lockDay(tx, p.membershipId, d);
        await this.requireOpenDay2(tx, p.membershipId, d);
        let first: string | null = null;
        for (const [i, ref] of refs.entries()) {
          const task = await this.plannableTask(
            tx,
            p,
            ref,
            Array.isArray(b.tasks) ? `/tasks/${i}` : '/task',
          );
          const id = await this.insertCommitment(
            tx,
            p,
            d,
            task,
            Array.isArray(b.tasks) ? 'plan' : 'manual',
          );
          first ??= task.publicId;
          await this.planAudit(
            tx,
            caller,
            p,
            'today.committed',
            { id, type: 'today_commitment', publicId: null },
            [change.plain('task', null, task.publicId), change.plain('day', null, d)],
            task.brandId,
          );
          await this.planEvent(
            tx,
            caller,
            p,
            'planning.today.committed',
            { type: 'planning.today_commitment', id, sequence: 0 },
            { day: d, source: Array.isArray(b.tasks) ? 'plan' : 'manual' },
            task.brandId,
          );
        }
        this.d.metrics.count('planning.today', refs.length, { action: 'commit', outcome: 'ok' });
        return {
          status: 201,
          ref: { id: `${d}:${first!}`, type: 'today_commitment' },
          data: await this.commitmentView(tx, p, d, (await this.loadTask(tx, p, first!)).id),
        };
      },
      async (tx, p, ref) => {
        const [d, tsk] = ref.id.split(':');
        return this.commitmentView(tx, p, d!, (await this.loadTask(tx, p, tsk)).id);
      },
    );
  }

  protected async ownCommitment(tx: WorkspaceTransaction, p: Principal, day: string, tsk: unknown) {
    if (!isPublic(tsk, 'tsk')) throw new TenancyError('not_found');
    const t = await this.loadTask(tx, p, tsk);
    const row = await tx.db
      .selectFrom('planning.today_commitment')
      .selectAll()
      .where('owner_membership_id', '=', p.membershipId)
      .where('day', '=', day)
      .where('task_id', '=', t.id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    return { row, task: t };
  }

  protected requireUnlocked(locked: boolean, what = 'This item') {
    if (locked)
      throw new TenancyError('conflict', {
        issues: [issue('/locked', 'locked', `${what} is locked. Unlock it to move or remove it.`)],
      });
  }

  /**
   * Changes one commitment (`If-Match`): `locked`; manual order (`after`: the task it follows, or
   * null for the top); or `move_to` another day (an audited reschedule: this commitment closes as
   * carried and a new one opens on that day). Locked commitments only accept unlocking.
   */
  async updateCommitment(
    caller: Caller,
    ws: unknown,
    day: unknown,
    tsk: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'planning.commitment_update',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const expected = parseIfMatch(req.ifMatch);
        const d = this.parseDay(day);
        await this.lockDay(tx, p.membershipId, d);
        const { row, task } = await this.ownCommitment(tx, p, d, tsk);
        requireVersion(expected, Number(row.version));
        if (row.outcome !== 'open')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'day_closed', 'This commitment is closed.')],
          });
        const changes: ReturnType<typeof change.plain>[] = [];
        let locked = row.locked;
        if (b.locked !== undefined) {
          if (typeof b.locked !== 'boolean')
            throw invalid(issue('/locked', 'invalid', 'Choose locked or unlocked.'));
          if (b.locked !== row.locked) changes.push(change.plain('locked', row.locked, b.locked));
          locked = b.locked;
        }
        const moving = b.after !== undefined || b.move_to !== undefined;
        if (moving) this.requireUnlocked(locked, 'This task');
        let rank = row.rank;
        if (b.after !== undefined) {
          const siblings = await tx.db
            .selectFrom('planning.today_commitment as c')
            .innerJoin('core.record as r', 'r.id', 'c.task_id')
            .select(['c.id', 'c.rank', 'r.public_id'])
            .where('c.owner_membership_id', '=', p.membershipId)
            .where('c.day', '=', d)
            .where('c.id', '<>', row.id)
            .orderBy(sql`c.rank COLLATE "C"`)
            .orderBy('c.id')
            .execute();
          const at = b.after === null ? -1 : siblings.findIndex((s) => s.public_id === b.after);
          if (b.after !== null && at < 0)
            throw invalid(issue('/after', 'invalid', 'Choose a task on this day.'));
          rank =
            rankBetween(siblings[at]?.rank ?? null, siblings[at + 1]?.rank ?? null) ??
            (await this.renumber(tx, siblings, at, row.id));
          changes.push(change.plain('rank', row.rank, rank));
        }
        let movedTo: string | null = null;
        if (b.move_to !== undefined) {
          const { today } = await this.todayFor(tx, p);
          const to = this.parseDay(b.move_to, '/move_to');
          if (to <= d || to < today)
            throw invalid(issue('/move_to', 'past_day', 'Move it to a later day.'));
          await this.lockDay(tx, p.membershipId, to);
          await this.requireOpenDay2(tx, p.membershipId, to);
          const facts = await this.plannableTask(tx, p, task.publicId);
          await this.insertCommitment(tx, p, to, facts, 'carry');
          movedTo = to;
          changes.push(change.plain('day', d, to));
        }
        await tx.db
          .updateTable('planning.today_commitment')
          .set({
            locked,
            rank,
            ...(movedTo
              ? { outcome: 'carried' as const, carried_to: movedTo, closed_at: new Date() }
              : {}),
            updated_at: new Date(),
            version: Number(row.version) + 1,
          })
          .where('id', '=', row.id)
          .execute();
        if (changes.length) {
          await this.planAudit(
            tx,
            caller,
            p,
            movedTo ? 'today.rescheduled' : 'today.changed',
            { id: row.id, type: 'today_commitment', publicId: null },
            [change.plain('task', null, task.publicId), ...changes],
            task.brand.id,
          );
          await this.planEvent(
            tx,
            caller,
            p,
            'planning.today.changed',
            { type: 'planning.today_commitment', id: row.id, sequence: Number(row.version) + 1 },
            { day: d, change: movedTo ? 'moved' : b.after !== undefined ? 'reordered' : 'locked' },
            task.brand.id,
          );
        }
        this.d.metrics.count('planning.today', 1, {
          action: movedTo ? 'move' : 'update',
          outcome: 'ok',
        });
        const target = movedTo ?? d;
        return {
          status: 200,
          ref: { id: `${target}:${task.publicId}`, type: 'today_commitment' },
          data: await this.commitmentView(tx, p, target, task.id),
        };
      },
      async (tx, p, ref) => {
        const [dd, t] = ref.id.split(':');
        return this.commitmentView(tx, p, dd!, (await this.loadTask(tx, p, t)).id);
      },
    );
  }

  /** Spreads ranks evenly when there is no room, then returns the rank for the moved item. */
  protected async renumber(
    tx: WorkspaceTransaction,
    siblings: Array<{ id: string; rank: string }>,
    at: number,
    movedId: string,
  ): Promise<string> {
    const order = [...siblings];
    order.splice(at + 1, 0, { id: movedId, rank: '' });
    const ranks = evenRanks(order.length);
    for (const [i, s] of order.entries())
      if (s.id !== movedId)
        await tx.db
          .updateTable('planning.today_commitment')
          .set({ rank: ranks[i]!, version: sql`version + 1` as never })
          .where('id', '=', s.id)
          .execute();
    return ranks[at + 1]!;
  }

  /** Removes an open commitment from a day (it returns to the backlog). Locked: refused. */
  async uncommit(caller: Caller, ws: unknown, day: unknown, tsk: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'planning.uncommit',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const expected = parseIfMatch(req.ifMatch);
        const d = this.parseDay(day);
        await this.lockDay(tx, p.membershipId, d);
        const { row, task } = await this.ownCommitment(tx, p, d, tsk);
        requireVersion(expected, Number(row.version));
        if (row.outcome !== 'open')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'day_closed', 'This commitment is closed.')],
          });
        this.requireUnlocked(row.locked, 'This task');
        await tx.db.deleteFrom('planning.today_commitment').where('id', '=', row.id).execute();
        await this.planAudit(
          tx,
          caller,
          p,
          'today.uncommitted',
          { id: row.id, type: 'today_commitment', publicId: null },
          [change.plain('task', task.publicId, null), change.plain('day', d, null)],
          task.brand.id,
        );
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.today.changed',
          { type: 'planning.today_commitment', id: row.id, sequence: Number(row.version) + 1 },
          { day: d, change: 'removed' },
          task.brand.id,
        );
        return {
          status: 200,
          ref: { id: `${d}:${task.publicId}`, type: 'today_commitment' },
          data: { id: `${d}:${task.publicId}`, type: 'today_commitment' as const, removed: true },
        };
      },
      (_tx, _p, ref) =>
        Promise.resolve({ id: ref.id, type: 'today_commitment' as const, removed: true }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Shutdown and daily records (PLAN-016, PLAN-018, PLAN-019)
  // ---------------------------------------------------------------------------------------------

  /**
   * Shutdown (PLAN-018): each open commitment gets one decision: `carry` (to the next day),
   * `pick_day` (a later day), `return` (to the backlog), or `leave` (left unfinished on this day).
   * Done tasks are recorded as done. Locked commitments may only be left. No decision ever
   * changes a due date or deadline. The day's record is then written once.
   */
  async shutdown(caller: Caller, ws: unknown, day: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const decisions = new Map<string, { action: Action; day?: string }>();
    for (const [i, x] of (Array.isArray(b.items) ? b.items : []).entries()) {
      if (!isObj(x) || typeof x.task !== 'string')
        throw invalid(issue(`/items/${i}/task`, 'required', 'Choose the task.'));
      const action = (['carry', 'pick_day', 'return', 'leave'] as const).find(
        (a) => a === x.action,
      );
      if (!action)
        throw invalid(issue(`/items/${i}/action`, 'invalid', 'Choose what happens to it.'));
      decisions.set(x.task, {
        action,
        ...(action === 'pick_day' ? { day: this.parseDay(x.day, `/items/${i}/day`) } : {}),
      });
    }
    return this.mutate(
      caller,
      'planning.shutdown',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const { tz, today } = await this.todayFor(tx, p);
        const d = this.parseDay(day);
        if (d > today)
          throw invalid(issue('/day', 'future_day', 'Shut down today or an earlier day.'));
        await this.lockDay(tx, p.membershipId, d);
        await this.requireOpenDay2(tx, p.membershipId, d);
        const readable = await this.readableTasks(tx, p);
        const rows = await this.commitmentRows(tx, p, d, readable);
        let carried = 0;
        for (const c of rows.filter((x) => x.outcome === 'open')) {
          const dec = decisions.get(c.public_id) ?? { action: 'leave' as Action };
          if (c.status_category === 'done') {
            await this.closeCommitment(tx, c.id, 'done', null);
            continue;
          }
          if (dec.action !== 'leave')
            this.requireUnlocked(c.locked, `“${c.readable ? c.title : 'A task'}”`);
          if (dec.action === 'carry' || dec.action === 'pick_day') {
            const to = dec.action === 'carry' ? addDays(d, 1) : dec.day!;
            if (to <= d || to < today)
              throw invalid(issue('/items', 'past_day', 'Carry work to a later day.'));
            if (!c.readable) throw new TenancyError('not_found');
            await this.lockDay(tx, p.membershipId, to);
            await this.requireOpenDay2(tx, p.membershipId, to);
            const facts = await this.plannableTask(tx, p, c.public_id);
            const exists = await tx.db
              .selectFrom('planning.today_commitment')
              .select('id')
              .where('owner_membership_id', '=', p.membershipId)
              .where('day', '=', to)
              .where('task_id', '=', c.task_id)
              .executeTakeFirst();
            if (!exists) await this.insertCommitment(tx, p, to, facts, 'carry');
            await this.closeCommitment(tx, c.id, 'carried', to);
            carried++;
          } else {
            await this.closeCommitment(
              tx,
              c.id,
              dec.action === 'return' ? 'returned' : 'dropped',
              null,
            );
          }
          await this.planAudit(
            tx,
            caller,
            p,
            dec.action === 'carry' || dec.action === 'pick_day'
              ? 'today.rescheduled'
              : 'today.closed',
            { id: c.id, type: 'today_commitment', publicId: null },
            [
              change.plain('task', null, c.public_id),
              change.plain('decision', null, dec.action),
              ...(dec.day ? [change.plain('to_day', null, dec.day)] : []),
            ],
            c.brand_id,
          );
        }
        const rec = await writeDailyRecord(tx, p.membershipId, d, tz, 'shutdown');
        await this.planAudit(
          tx,
          caller,
          p,
          'today.shutdown',
          { id: rec.id, type: 'daily_record', publicId: null },
          [
            change.plain('day', null, d),
            change.plain('committed', null, rec.committed),
            change.plain('completed', null, rec.completed),
          ],
          null,
        );
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.day.closed',
          { type: 'planning.daily_record', id: rec.id, sequence: 0 },
          { day: d, closed_by: 'shutdown', committed: rec.committed, completed: rec.completed },
          null,
        );
        this.d.metrics.count('planning.today', 1, {
          action: 'shutdown',
          outcome: carried ? 'carried' : 'ok',
        });
        return {
          status: 200,
          ref: { id: d, type: 'daily_record' },
          data: { id: d, type: 'daily_record' as const, ...(await this.recordFor(tx, p, d)) },
        };
      },
      async (tx, p, ref) => ({
        id: ref.id,
        type: 'daily_record' as const,
        ...(await this.recordFor(tx, p, ref.id)),
      }),
    );
  }

  protected async closeCommitment(
    tx: WorkspaceTransaction,
    id: string,
    outcome: 'done' | 'carried' | 'returned' | 'dropped',
    to: string | null,
  ) {
    await tx.db
      .updateTable('planning.today_commitment')
      .set({
        outcome,
        carried_to: to,
        closed_at: new Date(),
        updated_at: new Date(),
        version: sql`version + 1` as never,
      })
      .where('id', '=', id)
      .execute();
  }

  protected recordView(r: {
    day: string;
    tz: string;
    closed_by: string;
    committed: number;
    completed: number;
    carried: number;
    returned: number;
    dropped: number;
    planned_minutes: number;
    unestimated: number;
    block_minutes: number;
    focus_minutes: number;
    actual_seconds: number;
    created_at: Date;
  }) {
    return {
      day: String(r.day).slice(0, 10),
      tz: r.tz,
      closed_by: r.closed_by,
      committed: r.committed,
      completed: r.completed,
      carried: r.carried,
      returned: r.returned,
      dropped: r.dropped,
      planned_minutes: r.planned_minutes,
      unestimated: r.unestimated,
      block_minutes: r.block_minutes,
      focus_minutes: r.focus_minutes,
      actual_seconds: r.actual_seconds,
      closed_at: iso(r.created_at),
    };
  }

  protected async recordFor(tx: WorkspaceTransaction, p: Principal, day: string) {
    const r = await tx.db
      .selectFrom('planning.daily_record')
      .selectAll()
      .where('owner_membership_id', '=', p.membershipId)
      .where('day', '=', day)
      .executeTakeFirst();
    if (!r) throw new TenancyError('not_found');
    const readable = await this.readableTasks(tx, p);
    const ids = (r.items as Array<{ task: string }>).map((i) => i.task);
    const titles = new Map(
      (
        await sql<{ id: string; public_id: string; title: string }>`
          SELECT t.id, r.public_id, t.title FROM work.task t JOIN core.record r ON r.id = t.id
           WHERE t.id = ANY(${ids.length ? ids : [NIL]}::uuid[]) AND ${readable}`.execute(tx.db)
      ).rows.map((x) => [x.id, x]),
    );
    return {
      ...this.recordView(r),
      // Items keep their recorded outcome; tasks the person can no longer read are not named.
      items: (
        r.items as Array<{ task: string; outcome: string; estimate_minutes: number | null }>
      ).map((i) => {
        const t = titles.get(i.task);
        return {
          task: t ? { id: t.public_id, title: t.title } : null,
          outcome: i.outcome,
          estimate_minutes: i.estimate_minutes,
        };
      }),
    };
  }

  /** Planned versus completed per day (PLAN-019), newest first, over a bounded range. */
  async dailyRecords(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const { today } = await this.todayFor(tx, p);
      const to = query.to === undefined ? today : this.parseDay(query.to, '/to');
      const from = query.from === undefined ? addDays(to, -13) : this.parseDay(query.from, '/from');
      if (to < from || daysBetween(from, to) + 1 > this.ws.workBlocksRangeDaysMax * 3)
        throw invalid(issue('/to', 'too_wide', 'Choose a shorter range.'));
      const rows = await tx.db
        .selectFrom('planning.daily_record')
        .selectAll()
        .where('owner_membership_id', '=', p.membershipId)
        .where('day', '>=', from)
        .where('day', '<=', to)
        .orderBy('day', 'desc')
        .execute();
      return { from, to, records: rows.map((r) => this.recordView(r)) };
    });
  }

  async dailyRecord(caller: Caller, ws: unknown, day: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const d = this.parseDay(day);
      return { id: d, type: 'daily_record' as const, ...(await this.recordFor(tx, p, d)) };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Work blocks (TSK-006, CAL-011, CAL-013, PLAN-014, PLAN-015, PLAN-017)
  // ---------------------------------------------------------------------------------------------

  protected parsePadding(v: unknown, path: string, dflt = 0): number {
    if (v === undefined) return dflt;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 240)
      throw invalid(issue(path, 'invalid', 'Enter 0 to 240 minutes.'));
    return v;
  }

  protected parseFlag(v: unknown, path: string, dflt = false): boolean {
    if (v === undefined) return dflt;
    if (typeof v !== 'boolean') throw invalid(issue(path, 'invalid', 'Choose yes or no.'));
    return v;
  }

  protected parseTitle(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || !v.trim() || v.trim().length > 200)
      throw invalid(issue('/title', 'invalid', 'Name the block (up to 200 characters).'));
    return v.trim();
  }

  /** A block's span: `starts_at` and `ends_at`, or `starts_at` and `duration_minutes`. */
  protected parseBlockSpan(b: Record<string, unknown>, fallback?: { start: Date; end: Date }) {
    const start =
      b.starts_at === undefined && fallback ? fallback.start : parseInstant(b.starts_at);
    if (!start) throw invalid(issue('/starts_at', 'invalid', 'Choose a start time.'));
    let end: Date | null;
    if (b.duration_minutes !== undefined) {
      const m = b.duration_minutes;
      if (typeof m !== 'number' || !Number.isInteger(m) || m < 5 || m > 1440)
        throw invalid(issue('/duration_minutes', 'invalid', 'Enter 5 minutes to 24 hours.'));
      end = new Date(wholeMinute(start).getTime() + m * 60_000);
    } else end = b.ends_at === undefined && fallback ? fallback.end : parseInstant(b.ends_at);
    if (!end) throw invalid(issue('/ends_at', 'invalid', 'Choose an end time.'));
    const s = wholeMinute(start);
    const e = wholeMinute(end);
    const mins = minutesBetween(s, e);
    if (mins < 5)
      throw invalid(issue('/ends_at', 'too_short', 'A block lasts at least 5 minutes.'));
    if (mins > 1440)
      throw invalid(issue('/ends_at', 'too_long', 'A block lasts at most 24 hours.'));
    return { start: s, end: e };
  }

  protected async blockRow(tx: WorkspaceTransaction, p: Principal, blk: unknown) {
    const row = (await tx.db
      .selectFrom('planning.work_block')
      .selectAll()
      .where('public_id', '=', isPublic(blk, 'blk') ? blk : 'blk_0')
      .where('owner_membership_id', '=', p.membershipId)
      .forUpdate()
      .executeTakeFirst()) as BlockRow | undefined;
    if (!row) throw new TenancyError('not_found');
    return row;
  }

  protected async oneBlockView(tx: WorkspaceTransaction, p: Principal, publicId: string) {
    const { tz } = await this.todayFor(tx, p);
    const readable = await this.readableTasks(tx, p);
    const row = await tx.db
      .selectFrom('planning.work_block')
      .select(['starts_at', 'ends_at'])
      .where('public_id', '=', publicId)
      .where('owner_membership_id', '=', p.membershipId)
      .executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    const b = (
      await this.blocksIn(tx, p, new Date(row.starts_at), new Date(row.ends_at), readable)
    ).find((x) => x.public_id === publicId);
    if (!b) throw new TenancyError('not_found');
    return this.blockView(b, tz);
  }

  protected async requireBlockRoom(
    tx: WorkspaceTransaction,
    p: Principal,
    start: Date,
    tz: string,
    exclude: string | null,
  ) {
    const { start: ds, end: de } = dayBounds(localDay(start, tz), tz);
    const n = await tx.db
      .selectFrom('planning.work_block')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('owner_membership_id', '=', p.membershipId)
      .where('starts_at', '>=', ds)
      .where('starts_at', '<', de)
      .where(sql<boolean>`id IS DISTINCT FROM ${exclude}::uuid`)
      .executeTakeFirstOrThrow();
    if (Number(n.n) >= this.ws.workBlocksPerDayMax)
      throw invalid(
        issue(
          '/starts_at',
          'too_many',
          `A day can hold at most ${this.ws.workBlocksPerDayMax} blocks.`,
        ),
      );
  }

  /** Focus protection checked first for a clean refusal; the guard trigger repeats it. */
  protected async requireNoFocusClash(
    tx: WorkspaceTransaction,
    p: Principal,
    v: { start: Date; end: Date; prep: number; buffer: number; focus: boolean },
    exclude: string | null,
  ) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`planning.blocks:${tx.workspaceId}:${p.membershipId}`}, 0))`.execute(
      tx.db,
    );
    const clash = await sql<{ n: number }>`
      SELECT 1 AS n FROM planning.work_block b
       WHERE b.owner_membership_id = ${p.membershipId}::uuid AND b.id IS DISTINCT FROM ${exclude}::uuid
         AND (b.focus OR ${v.focus})
         AND b.starts_at - make_interval(mins => b.prep_minutes) < ${v.end}::timestamptz + make_interval(mins => ${v.buffer})
         AND b.ends_at + make_interval(mins => b.buffer_minutes) > ${v.start}::timestamptz - make_interval(mins => ${v.prep})
       LIMIT 1`.execute(tx.db);
    if (clash.rows.length)
      throw new TenancyError('conflict', {
        issues: [issue('/starts_at', 'focus_protected', 'This time overlaps a focus block.')],
      });
  }

  protected async insertBlock(
    tx: WorkspaceTransaction,
    p: Principal,
    v: {
      task: TaskFacts | null;
      title: string | null;
      start: Date;
      end: Date;
      tz: string;
      focus: boolean;
      locked: boolean;
      prep: number;
      buffer: number;
      source: 'manual' | 'estimate' | 'recurrence';
      seriesId?: string;
      occurrenceKey?: string;
    },
  ) {
    const id = newUuidV7();
    const publicId = newPublicId('blk');
    await tx.db
      .insertInto('planning.work_block')
      .values({
        id,
        public_id: publicId,
        workspace_id: tx.workspaceId,
        owner_membership_id: p.membershipId,
        task_id: v.task?.id ?? null,
        brand_id: v.task?.brandId ?? null,
        title: v.task ? null : v.title,
        starts_at: v.start,
        ends_at: v.end,
        source_tz: v.tz,
        focus: v.focus,
        locked: v.locked,
        prep_minutes: v.prep,
        buffer_minutes: v.buffer,
        source: v.source,
        series_id: v.seriesId ?? null,
        occurrence_key: v.occurrenceKey ?? null,
      })
      .execute();
    return { id, publicId };
  }

  async listBlocks(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const { tz, today } = await this.todayFor(tx, p);
      const from = query.from === undefined ? today : this.parseDay(query.from, '/from');
      const to = query.to === undefined ? addDays(from, 6) : this.parseDay(query.to, '/to');
      if (to < from || daysBetween(from, to) + 1 > this.ws.workBlocksRangeDaysMax)
        throw invalid(
          issue('/to', 'too_wide', `Choose at most ${this.ws.workBlocksRangeDaysMax} days.`),
        );
      const readable = await this.readableTasks(tx, p);
      const rows = await this.blocksIn(
        tx,
        p,
        dayBounds(from, tz).start,
        dayBounds(to, tz).end,
        readable,
      );
      return { from, to, tz, data: rows.map((b) => this.blockView(b, tz)) };
    });
  }

  /**
   * Schedules a block (TSK-006): for a readable task or a named personal block; optional focus,
   * lock, and preparation and buffer time (PLAN-015). It never changes the task's dates; the
   * response warns when it ends after the due date or deadline (CAL-013).
   */
  async createBlock(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'planning.block_create',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const tz = this.zoneInput(b.tz) ?? (await this.personZone(tx, p.membershipId));
        const task =
          b.task === undefined || b.task === null ? null : await this.plannableTask(tx, p, b.task);
        const title = task ? null : this.parseTitle(b.title);
        if (!task && !title)
          throw invalid(issue('/title', 'required', 'Choose a task or name the block.'));
        const span = this.parseBlockSpan(b);
        const v = {
          task,
          title,
          ...span,
          tz,
          focus: this.parseFlag(b.focus, '/focus'),
          locked: this.parseFlag(b.locked, '/locked'),
          prep: this.parsePadding(b.prep_minutes, '/prep_minutes'),
          buffer: this.parsePadding(b.buffer_minutes, '/buffer_minutes'),
          source: 'manual' as const,
        };
        return this.finishBlockCreate(tx, caller, p, v);
      },
      async (tx, p, ref) => this.oneBlockView(tx, p, ref.id),
    );
  }

  protected async finishBlockCreate(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    v: Parameters<PlanningService['insertBlock']>[2],
  ) {
    await this.requireBlockRoom(tx, p, v.start, v.tz, null);
    await this.requireNoFocusClash(
      tx,
      p,
      { start: v.start, end: v.end, prep: v.prep, buffer: v.buffer, focus: v.focus },
      null,
    );
    const blk = await this.insertBlock(tx, p, v);
    await this.planAudit(
      tx,
      caller,
      p,
      'work_block.created',
      { id: blk.id, type: 'work_block', publicId: blk.publicId },
      [
        change.plain('task', null, v.task?.publicId ?? null),
        change.plain('starts_at', null, v.start.toISOString()),
        change.plain('ends_at', null, v.end.toISOString()),
        change.plain('focus', null, v.focus),
        ...(v.title ? [change.content('title', { hash: sha(v.title) })] : []),
      ],
      v.task?.brandId ?? null,
    );
    await this.planEvent(
      tx,
      caller,
      p,
      'planning.work_block.created',
      { type: 'planning.work_block', id: blk.id, sequence: 0 },
      { source: v.source, focus: v.focus },
      v.task?.brandId ?? null,
    );
    this.d.metrics.count('planning.blocks', 1, { action: 'create', outcome: v.source });
    return {
      status: 201,
      ref: { id: blk.publicId, type: 'work_block' },
      data: await this.oneBlockView(tx, p, blk.publicId),
    };
  }

  /**
   * A focus block sized from the task's remaining estimate, or its estimate (CAL-011), starting
   * at `starts_at` (at most 24 hours).
   */
  async blockFromEstimate(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'planning.block_from_estimate',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const tz = this.zoneInput(b.tz) ?? (await this.personZone(tx, p.membershipId));
        const task = await this.plannableTask(tx, p, b.task);
        const minutes = task.remaining_estimate_minutes ?? task.estimate_minutes;
        if (!minutes)
          throw invalid(issue('/task', 'no_estimate', 'Add an estimate to the task first.'));
        const start = parseInstant(b.starts_at);
        if (!start) throw invalid(issue('/starts_at', 'invalid', 'Choose a start time.'));
        const s = wholeMinute(start);
        const m = Math.min(Math.max(minutes, 5), 1440);
        return this.finishBlockCreate(tx, caller, p, {
          task,
          title: null,
          start: s,
          end: new Date(s.getTime() + m * 60_000),
          tz,
          focus: true,
          locked: this.parseFlag(b.locked, '/locked'),
          prep: this.parsePadding(b.prep_minutes, '/prep_minutes'),
          buffer: this.parsePadding(b.buffer_minutes, '/buffer_minutes'),
          source: 'estimate',
        });
      },
      async (tx, p, ref) => this.oneBlockView(tx, p, ref.id),
    );
  }

  /**
   * Moves or resizes a block, or changes its settings (`If-Match`). A locked block accepts only
   * unlocking (PLAN-017). Moving never changes the task's due date or deadline (CAL-013); the
   * response carries warnings, and changing the due date is a separate, explicit task edit.
   */
  async updateBlock(caller: Caller, ws: unknown, blk: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'planning.block_update',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const expected = parseIfMatch(req.ifMatch);
        const row = await this.blockRow(tx, p, blk);
        requireVersion(expected, Number(row.version));
        const locked = this.parseFlag(b.locked, '/locked', row.locked);
        const others = Object.keys(b).filter((k) => k !== 'locked');
        if (row.locked && locked && others.length) this.requireUnlocked(true, 'This block');
        if (row.locked && !locked && others.length)
          throw invalid(issue('/locked', 'unlock_first', 'Unlock the block, then change it.'));
        // The block's task must still be readable to change anything but its lock.
        if (row.task_id && others.length)
          await this.plannableTask(tx, p, await this.publicOf(tx, row.task_id));
        const tz = this.zoneInput(b.tz) ?? row.source_tz;
        const span = this.parseBlockSpan(b, {
          start: new Date(row.starts_at),
          end: new Date(row.ends_at),
        });
        const v = {
          start: span.start,
          end: span.end,
          focus: this.parseFlag(b.focus, '/focus', row.focus),
          prep: this.parsePadding(b.prep_minutes, '/prep_minutes', Number(row.prep_minutes)),
          buffer: this.parsePadding(
            b.buffer_minutes,
            '/buffer_minutes',
            Number(row.buffer_minutes),
          ),
        };
        const title = row.task_id
          ? null
          : b.title !== undefined
            ? (this.parseTitle(b.title) ?? row.title)
            : row.title;
        const moved =
          v.start.getTime() !== new Date(row.starts_at).getTime() ||
          v.end.getTime() !== new Date(row.ends_at).getTime();
        if (moved && localDay(v.start, tz) !== localDay(new Date(row.starts_at), tz))
          await this.requireBlockRoom(tx, p, v.start, tz, row.id);
        await this.requireNoFocusClash(tx, p, { ...v }, row.id);
        await tx.db
          .updateTable('planning.work_block')
          .set({
            starts_at: v.start,
            ends_at: v.end,
            source_tz: tz,
            focus: v.focus,
            locked,
            prep_minutes: v.prep,
            buffer_minutes: v.buffer,
            title,
            updated_at: new Date(),
            version: Number(row.version) + 1,
          })
          .where('id', '=', row.id)
          .execute();
        const changes = [
          ...(moved
            ? [
                change.plain('starts_at', iso(row.starts_at), v.start.toISOString()),
                change.plain('ends_at', iso(row.ends_at), v.end.toISOString()),
              ]
            : []),
          ...(locked !== row.locked ? [change.plain('locked', row.locked, locked)] : []),
          ...(v.focus !== row.focus ? [change.plain('focus', row.focus, v.focus)] : []),
          ...(v.prep !== Number(row.prep_minutes)
            ? [change.plain('prep_minutes', Number(row.prep_minutes), v.prep)]
            : []),
          ...(v.buffer !== Number(row.buffer_minutes)
            ? [change.plain('buffer_minutes', Number(row.buffer_minutes), v.buffer)]
            : []),
        ];
        if (changes.length) {
          await this.planAudit(
            tx,
            caller,
            p,
            moved ? 'work_block.moved' : 'work_block.changed',
            { id: row.id, type: 'work_block', publicId: row.public_id },
            changes,
            row.brand_id,
          );
          if (moved)
            await this.planEvent(
              tx,
              caller,
              p,
              'planning.work_block.moved',
              { type: 'planning.work_block', id: row.id, sequence: Number(row.version) + 1 },
              {
                starts_at: v.start.toISOString(),
                ends_at: v.end.toISOString(),
                source: row.source,
              },
              row.brand_id,
            );
        }
        this.d.metrics.count('planning.blocks', 1, {
          action: moved ? 'move' : 'update',
          outcome: 'ok',
        });
        return {
          status: 200,
          ref: { id: row.public_id, type: 'work_block' },
          data: await this.oneBlockView(tx, p, row.public_id),
        };
      },
      async (tx, p, ref) => this.oneBlockView(tx, p, ref.id),
    );
  }

  async deleteBlock(caller: Caller, ws: unknown, blk: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'planning.block_delete',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const expected = parseIfMatch(req.ifMatch);
        const row = await this.blockRow(tx, p, blk);
        requireVersion(expected, Number(row.version));
        this.requireUnlocked(row.locked, 'This block');
        await tx.db.deleteFrom('planning.work_block').where('id', '=', row.id).execute();
        await this.planAudit(
          tx,
          caller,
          p,
          'work_block.deleted',
          { id: row.id, type: 'work_block', publicId: row.public_id },
          [change.plain('starts_at', iso(row.starts_at), null)],
          row.brand_id,
        );
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.work_block.deleted',
          { type: 'planning.work_block', id: row.id, sequence: Number(row.version) + 1 },
          { source: row.source },
          row.brand_id,
        );
        return {
          status: 200,
          ref: { id: row.public_id, type: 'work_block' },
          data: { id: row.public_id, type: 'work_block' as const, deleted: true },
        };
      },
      (_tx, _p, ref) => Promise.resolve({ id: ref.id, type: 'work_block' as const, deleted: true }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Recurring blocks (CAL-005) through the 2A rule engine
  // ---------------------------------------------------------------------------------------------

  protected seriesView(s: {
    public_id: string;
    rrule: string;
    anchor_tz: string;
    dtstart_local: string | Date;
    duration_minutes: number;
    focus: boolean;
    prep_minutes: number;
    buffer_minutes: number;
    state: string;
    generated_through: string | Date | null;
    title: string | null;
    task_public_id?: string | null;
    version: string | number;
  }) {
    const local = (v: string | Date | null) =>
      v === null
        ? null
        : v instanceof Date
          ? v.toISOString().slice(0, 16)
          : String(v).replace(' ', 'T').slice(0, 16);
    return {
      id: s.public_id,
      type: 'block_series' as const,
      rrule: s.rrule,
      anchor_tz: s.anchor_tz,
      start_local: local(s.dtstart_local),
      duration_minutes: s.duration_minutes,
      focus: s.focus,
      prep_minutes: s.prep_minutes,
      buffer_minutes: s.buffer_minutes,
      state: s.state,
      generated_through: local(s.generated_through),
      title: s.title,
      task: s.task_public_id ?? null,
      version: Number(s.version),
    };
  }

  /**
   * Defines a recurring block (CAL-005): a rule (`rule`: frequency, interval, weekdays, month
   * days, end) from `start_date` at `start_time` in `tz`, with a duration and block settings.
   * Occurrences through BLOCK_SERIES_HORIZON_DAYS are created now; the worker extends them. An
   * occurrence that would overlap a focus block is skipped and counted.
   */
  async createSeries(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'planning.series_create',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const tz = this.zoneInput(b.tz) ?? (await this.personZone(tx, p.membershipId));
        const task =
          b.task === undefined || b.task === null ? null : await this.plannableTask(tx, p, b.task);
        const title = task ? null : this.parseTitle(b.title);
        if (!task && !title)
          throw invalid(issue('/title', 'required', 'Choose a task or name the block.'));
        const startDate = this.parseDay(b.start_date, '/start_date');
        const clock = validClock(b.start_time);
        if (!clock) throw invalid(issue('/start_time', 'invalid', 'Choose a start time (HH:MM).'));
        const duration = b.duration_minutes;
        if (
          typeof duration !== 'number' ||
          !Number.isInteger(duration) ||
          duration < 5 ||
          duration > 1440
        )
          throw invalid(issue('/duration_minutes', 'invalid', 'Enter 5 minutes to 24 hours.'));
        let rrule: string;
        try {
          const r = isObj(b.rule) ? b.rule : {};
          rrule = composeRule({
            frequency: r.frequency as never,
            interval: (r.interval as number) ?? 1,
            weekdays: (r.weekdays as never) ?? null,
            monthDays: (r.month_days as never) ?? null,
            ends: (r.ends as never) ?? { type: 'never' },
          });
          parseRule(rrule);
        } catch (e) {
          if (e instanceof RuleError || e instanceof TypeError)
            throw invalid(issue('/rule', 'invalid', 'Choose how often it repeats.'));
          throw e;
        }
        const active = await tx.db
          .selectFrom('planning.block_series')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('owner_membership_id', '=', p.membershipId)
          .where('state', '=', 'active')
          .executeTakeFirstOrThrow();
        if (Number(active.n) >= this.ws.blockSeriesMax)
          throw invalid(
            issue('/', 'too_many', `Keep at most ${this.ws.blockSeriesMax} recurring blocks.`),
          );
        const id = newUuidV7();
        const publicId = newPublicId('bls');
        await tx.db
          .insertInto('planning.block_series')
          .values({
            id,
            public_id: publicId,
            workspace_id: tx.workspaceId,
            owner_membership_id: p.membershipId,
            task_id: task?.id ?? null,
            brand_id: task?.brandId ?? null,
            title,
            rrule,
            anchor_tz: tz,
            dtstart_local: `${startDate}T${clock}`,
            duration_minutes: duration,
            focus: this.parseFlag(b.focus, '/focus'),
            prep_minutes: this.parsePadding(b.prep_minutes, '/prep_minutes'),
            buffer_minutes: this.parsePadding(b.buffer_minutes, '/buffer_minutes'),
          })
          .execute();
        const out = await generateSeries(tx, id, new Date(), this.ws.blockSeriesHorizonDays);
        await this.planAudit(
          tx,
          caller,
          p,
          'block_series.defined',
          { id, type: 'block_series', publicId },
          [
            change.plain('rrule', null, rrule),
            change.plain('generated', null, out.created),
            change.plain('skipped', null, out.skipped),
          ],
          task?.brandId ?? null,
        );
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.block_series.defined',
          { type: 'planning.block_series', id, sequence: 0 },
          { occurrences: out.created },
          task?.brandId ?? null,
        );
        this.d.metrics.count('planning.block_series', 1, { outcome: 'defined' });
        return {
          status: 201,
          ref: { id: publicId, type: 'block_series' },
          data: {
            ...(await this.oneSeriesView(tx, p, publicId)),
            generated: out.created,
            skipped: out.skipped,
          },
        };
      },
      async (tx, p, ref) => ({
        ...(await this.oneSeriesView(tx, p, ref.id)),
        generated: 0,
        skipped: 0,
      }),
    );
  }

  protected async oneSeriesView(tx: WorkspaceTransaction, p: Principal, bls: unknown) {
    const s = await tx.db
      .selectFrom('planning.block_series as s')
      .leftJoin('core.record as r', 'r.id', 's.task_id')
      .selectAll('s')
      .select('r.public_id as task_public_id')
      .where('s.public_id', '=', isPublic(bls, 'bls') ? bls : 'bls_0')
      .where('s.owner_membership_id', '=', p.membershipId)
      .executeTakeFirst();
    if (!s) throw new TenancyError('not_found');
    return this.seriesView(s as never);
  }

  async listSeries(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const rows = await tx.db
        .selectFrom('planning.block_series as s')
        .leftJoin('core.record as r', 'r.id', 's.task_id')
        .selectAll('s')
        .select('r.public_id as task_public_id')
        .where('s.owner_membership_id', '=', p.membershipId)
        .orderBy('s.created_at', 'desc')
        .execute();
      return { data: rows.map((s) => this.seriesView(s as never)) };
    });
  }

  /**
   * Ends a recurring block: future occurrences nobody changed or locked are removed; past ones,
   * changed ones, and locked ones stay.
   */
  async endSeries(caller: Caller, ws: unknown, bls: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'planning.series_end',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const expected = parseIfMatch(req.ifMatch);
        const s = await tx.db
          .selectFrom('planning.block_series')
          .selectAll()
          .where('public_id', '=', isPublic(bls, 'bls') ? bls : 'bls_0')
          .where('owner_membership_id', '=', p.membershipId)
          .forUpdate()
          .executeTakeFirst();
        if (!s) throw new TenancyError('not_found');
        requireVersion(expected, Number(s.version));
        if (s.state === 'ended')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'ended', 'This recurring block has ended.')],
          });
        const removed = await tx.db
          .deleteFrom('planning.work_block')
          .where('series_id', '=', s.id)
          .where('starts_at', '>', new Date())
          .where('locked', '=', false)
          .where('version', '=', 0)
          .executeTakeFirst();
        await tx.db
          .updateTable('planning.block_series')
          .set({ state: 'ended', updated_at: new Date(), version: Number(s.version) + 1 })
          .where('id', '=', s.id)
          .execute();
        await this.planAudit(
          tx,
          caller,
          p,
          'block_series.ended',
          { id: s.id, type: 'block_series', publicId: s.public_id },
          [
            change.plain('state', 'active', 'ended'),
            change.plain('removed', null, Number(removed.numDeletedRows)),
          ],
          s.brand_id,
        );
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.block_series.ended',
          { type: 'planning.block_series', id: s.id, sequence: Number(s.version) + 1 },
          { removed: Number(removed.numDeletedRows) },
          s.brand_id,
        );
        return {
          status: 200,
          ref: { id: s.public_id, type: 'block_series' },
          data: await this.oneSeriesView(tx, p, s.public_id),
        };
      },
      (tx, p, ref) => this.oneSeriesView(tx, p, ref.id),
    );
  }
}

/**
 * Creates a series' occurrences from its last generated one through `horizonDays` after `now`
 * (idempotent: the `(series_id, occurrence_key)` key makes a repeated run create nothing). An
 * occurrence that would overlap a focus block, or of a task its owner can no longer read, is
 * skipped. Runs as the API or the worker inside the workspace transaction.
 */
export async function generateSeries(
  tx: WorkspaceTransaction,
  seriesId: string,
  now: Date,
  horizonDays: number,
): Promise<{ created: number; skipped: number }> {
  const s = await tx.db
    .selectFrom('planning.block_series')
    .selectAll()
    .where('id', '=', seriesId)
    .forUpdate()
    .executeTakeFirst();
  if (!s || s.state !== 'active') return { created: 0, skipped: 0 };
  const local = (v: string | Date) =>
    v instanceof Date ? v.toISOString().slice(0, 16) : String(v).replace(' ', 'T').slice(0, 16);
  const start = local(s.dtstart_local);
  const after = s.generated_through ? local(s.generated_through) : null;
  const through = utcToLocal(new Date(now.getTime() + horizonDays * 86_400_000), s.anchor_tz);
  const keys = occurrences(parseRule(s.rrule), start, after, 500, through);
  let created = 0;
  let skipped = 0;
  for (const key of keys) {
    const startAt = localToUtc(key, s.anchor_tz);
    const endAt = new Date(startAt.getTime() + s.duration_minutes * 60_000);
    await sql`SAVEPOINT occurrence`.execute(tx.db);
    try {
      const r = await tx.db
        .insertInto('planning.work_block')
        .values({
          id: newUuidV7(),
          public_id: newPublicId('blk'),
          workspace_id: tx.workspaceId,
          owner_membership_id: s.owner_membership_id,
          task_id: s.task_id,
          brand_id: s.brand_id,
          title: s.task_id ? null : s.title,
          starts_at: startAt,
          ends_at: endAt,
          source_tz: s.anchor_tz,
          focus: s.focus,
          prep_minutes: s.prep_minutes,
          buffer_minutes: s.buffer_minutes,
          source: 'recurrence',
          series_id: s.id,
          occurrence_key: key,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst();
      await sql`RELEASE SAVEPOINT occurrence`.execute(tx.db);
      if (r) created++;
    } catch (e) {
      await sql`ROLLBACK TO SAVEPOINT occurrence`.execute(tx.db);
      if ((e as { code?: string }).code !== '23P01') throw e;
      skipped++;
    }
  }
  const last = keys.at(-1) ?? null;
  const ended =
    !!parseRule(s.rrule).count || !!parseRule(s.rrule).until
      ? occurrences(parseRule(s.rrule), start, last ?? after, 1, null).length === 0
      : false;
  await tx.db
    .updateTable('planning.block_series')
    .set({
      generated_through: last ?? s.generated_through ?? null,
      ...(ended ? { state: 'ended' as const } : {}),
      updated_at: new Date(),
    })
    .where('id', '=', s.id)
    .execute();
  return { created, skipped };
}

/**
 * Writes a person's record for a day (PLAN-019) from its commitments as they stand (every open
 * one is closed first: done when the task is done, otherwise dropped), the day's blocks, and the
 * person's 3D time for the day. Written once; the unique key makes a second write a conflict.
 */
export async function writeDailyRecord(
  tx: WorkspaceTransaction,
  membershipId: string,
  day: string,
  tz: string,
  closedBy: 'shutdown' | 'auto',
) {
  await sql`UPDATE planning.today_commitment c SET
      outcome = CASE WHEN t.status_category = 'done' THEN 'done' ELSE 'dropped' END,
      closed_at = now(), updated_at = now(), version = c.version + 1
    FROM work.task t
   WHERE t.id = c.task_id AND c.owner_membership_id = ${membershipId}::uuid AND c.day = ${day}::date
     AND c.outcome = 'open'`.execute(tx.db);
  const items = (
    await sql<{
      task_id: string;
      outcome: string;
      estimate: number | null;
    }>`SELECT c.task_id, c.outcome, coalesce(t.remaining_estimate_minutes, t.estimate_minutes) AS estimate
        FROM planning.today_commitment c JOIN work.task t ON t.id = c.task_id
       WHERE c.owner_membership_id = ${membershipId}::uuid AND c.day = ${day}::date
       ORDER BY c.rank COLLATE "C", c.id`.execute(tx.db)
  ).rows;
  const { start, end } = dayBounds(day, tz);
  const blocks = (
    await sql<{ minutes: string; focus_minutes: string }>`
      SELECT coalesce(sum(extract(epoch FROM (least(ends_at, ${end}::timestamptz) - greatest(starts_at, ${start}::timestamptz))) / 60), 0)::bigint AS minutes,
             coalesce(sum(CASE WHEN focus THEN extract(epoch FROM (least(ends_at, ${end}::timestamptz) - greatest(starts_at, ${start}::timestamptz))) / 60 ELSE 0 END), 0)::bigint AS focus_minutes
        FROM planning.work_block
       WHERE owner_membership_id = ${membershipId}::uuid AND starts_at < ${end}::timestamptz AND ends_at > ${start}::timestamptz`.execute(
      tx.db,
    )
  ).rows[0]!;
  const actual = (
    await sql<{
      s: string;
    }>`SELECT coalesce(sum(duration_seconds), 0) AS s FROM timetrack.time_entry
       WHERE membership_id = ${membershipId}::uuid AND work_date = ${day}::date AND state = 'stopped'`.execute(
      tx.db,
    )
  ).rows[0]!;
  const n = (o: string) => items.filter((i) => i.outcome === o).length;
  const id = newUuidV7();
  const rec = {
    committed: items.length,
    completed: n('done'),
    carried: n('carried'),
    returned: n('returned'),
    dropped: n('dropped'),
    planned_minutes: items.reduce((s, i) => s + (i.estimate ?? 0), 0),
    unestimated: items.filter((i) => i.estimate === null).length,
    block_minutes: Number(blocks.minutes),
    focus_minutes: Number(blocks.focus_minutes),
    actual_seconds: Number(actual.s),
  };
  await tx.db
    .insertInto('planning.daily_record')
    .values({
      id,
      workspace_id: tx.workspaceId,
      owner_membership_id: membershipId,
      day,
      tz,
      closed_by: closedBy,
      ...rec,
      items: JSON.stringify(
        items.map((i) => ({ task: i.task_id, outcome: i.outcome, estimate_minutes: i.estimate })),
      ),
    })
    .execute();
  return { id, ...rec };
}
