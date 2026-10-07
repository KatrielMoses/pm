import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql, type StoredChange, type WorkspaceTransaction } from '@pm/db';
import {
  compileVisibility,
  invalid,
  issue,
  TenancyError,
  type Caller,
  type Principal,
} from '@pm/tenancy';
import type { WorkDeps } from '../service.ts';
import { fieldsForRecord } from '../workflow/field-access.ts';
import type { Entity } from './query.ts';
import { TimeService } from '../time/time-service.ts';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const NIL = '00000000-0000-7000-8000-000000000000';
const PUBLIC = /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/;
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return day(d);
};
const ACTOR_TYPES = ['human', 'agent', 'integration', 'system'] as const;

type Raw = { query: unknown; presentation?: unknown; scope?: unknown; today?: unknown };

/**
 * Phase 3B core view layouts (ADR-0020; 0B ADR-28, 0C AZ-28, 0D PL-30). Every layout renders the
 * one 3A query result; the reads here only add layout facts (workload totals, dependencies,
 * milestones, progress, the caller's own time, activity) for records that the same compiled,
 * authorized query returns. No layout has its own filtering, sorting, grouping, or authorization.
 */
export class LayoutService extends TimeService {
  readonly #activityKey: Buffer;

  constructor(deps: WorkDeps) {
    super(deps);
    this.#activityKey = createHmac('sha256', deps.signingKey)
      .update('cursor:views.activity')
      .digest();
  }

  /** Counts a layout read by outcome (`views.layout_reads`; no identifiers or values). */
  protected async track<T>(layout: string, fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      this.d.metrics.count('views.layout_reads', 1, { layout, outcome: 'ok' });
      return out;
    } catch (err) {
      this.d.metrics.count('views.layout_reads', 1, {
        layout,
        outcome: err instanceof TenancyError ? err.code : 'error',
      });
      throw err;
    }
  }

  protected raw(b: Record<string, unknown>): Raw {
    return { query: b.query, presentation: b.presentation, scope: b.scope, today: b.today };
  }

  /** Public IDs from the client, intersected with the authorized query (unknown ones vanish). */
  protected idsOf(b: Record<string, unknown>, prefix: string): string[] {
    const ids = b.ids;
    if (!Array.isArray(ids) || ids.length > this.ws.layoutItemsMax)
      throw invalid(
        issue('/ids', 'too_many', `Ask for at most ${this.ws.layoutItemsMax} records at once.`),
      );
    const out: string[] = [];
    for (const [i, v] of ids.entries()) {
      if (typeof v !== 'string' || !PUBLIC.test(v) || !v.startsWith(`${prefix}_`))
        throw invalid(issue(`/ids/${i}`, 'invalid', 'This identifier is not valid.'));
      if (!out.includes(v)) out.push(v);
    }
    return out;
  }

  protected async authorizedIds(
    tx: WorkspaceTransaction,
    p: Principal,
    raw: Raw,
    entity: Entity,
    publicIds: string[],
  ) {
    const k = await this.compileQuery(tx, p, raw, entity);
    const rows = (
      await sql<{ id: string; public_id: string }>`SELECT r.id, r.public_id ${k.where}
        AND r.public_id = ANY(${publicIds.length ? publicIds : ['x']}::text[])`.execute(tx.db)
    ).rows;
    return { k, rows, byId: new Map(rows.map((r) => [r.id, r.public_id])) };
  }

  // ---------------------------------------------------------------------------------------------
  // Workload (VIEW-007, TIME-009 contribution): person x time, from the view's own records
  // ---------------------------------------------------------------------------------------------

  /**
   * Remaining (else original) estimates of the view's open tasks with a due date in the window,
   * summed per primary assignee and day, week, or month. Computed in one aggregate over the same
   * authorized predicate, so hidden tasks never count. Capacity and over-allocation are 3E's.
   */
  async workload(caller: Caller, ws: unknown, body: unknown) {
    const b = isObj(body) ? body : {};
    const bucket = b.bucket ?? 'week';
    if (bucket !== 'day' && bucket !== 'week' && bucket !== 'month')
      throw invalid(issue('/bucket', 'invalid', 'Group by day, week, or month.'));
    if (
      typeof b.from !== 'string' ||
      !ISO_DAY.test(b.from) ||
      typeof b.to !== 'string' ||
      !ISO_DAY.test(b.to)
    )
      throw invalid(issue('/from', 'invalid', 'Choose a date range.'));
    const span = (Date.parse(b.to) - Date.parse(b.from)) / 86_400_000;
    if (!(span >= 0) || span > this.ws.workloadDaysMax)
      throw invalid(
        issue('/to', 'too_long', `Show at most ${this.ws.workloadDaysMax} days at once.`),
      );
    return this.track('workload', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        if (p.kind !== 'member')
          throw invalid(issue('/', 'unsupported_field', 'Workload is not available.'));
        const k = await this.compileQuery(tx, p, this.raw(b), 'task');
        const trunc =
          bucket === 'day' ? sql`t.due_date` : sql`date_trunc(${bucket}, t.due_date)::date`;
        const rows = (
          await sql<{
            owner: string | null;
            bucket: string;
            minutes: string;
            tasks: string;
            unestimated: string;
          }>`
          SELECT (SELECT a.membership_id FROM work.task_assignee a WHERE a.task_id = t.id AND a.is_primary) AS owner,
            (${trunc})::text AS bucket,
            coalesce(sum(coalesce(t.remaining_estimate_minutes, t.estimate_minutes)), 0)::text AS minutes,
            count(*)::text AS tasks,
            count(*) FILTER (WHERE coalesce(t.remaining_estimate_minutes, t.estimate_minutes) IS NULL)::text AS unestimated
          ${k.where} AND t.status_category NOT IN ('done', 'cancelled')
            AND t.due_date BETWEEN ${b.from}::date AND ${b.to}::date
          GROUP BY 1, 2 ORDER BY 1, 2`.execute(tx.db)
        ).rows;
        const ids = [...new Set(rows.map((r) => r.owner).filter((x): x is string => !!x))];
        const people = new Map(
          (
            await sql<{ id: string; public_id: string; name: string }>`SELECT m.id, m.public_id,
            coalesce(m.display_name_override, acc.display_name) AS name FROM tenancy.membership m
            JOIN identity.account acc ON acc.id = m.account_id
            WHERE m.workspace_id = ${tx.workspaceId} AND m.id = ANY(${ids.length ? ids : [NIL]}::uuid[])`.execute(
              tx.db,
            )
          ).rows.map((r) => [r.id, r]),
        );
        const buckets: string[] = [];
        let cur =
          bucket === 'day'
            ? (b.from as string)
            : bucket === 'week'
              ? addDays(b.from as string, -((new Date(`${b.from}T00:00:00Z`).getUTCDay() + 6) % 7))
              : `${(b.from as string).slice(0, 7)}-01`;
        while (cur <= (b.to as string) && buckets.length < 400) {
          buckets.push(cur);
          if (bucket === 'day') cur = addDays(cur, 1);
          else if (bucket === 'week') cur = addDays(cur, 7);
          else {
            const d = new Date(`${cur}T00:00:00Z`);
            d.setUTCMonth(d.getUTCMonth() + 1);
            cur = day(d);
          }
        }
        const out = new Map<
          string,
          {
            id: string | null;
            name: string;
            cells: Record<string, { minutes: number; tasks: number; unestimated: number }>;
          }
        >();
        for (const r of rows) {
          const key = r.owner ?? '';
          if (!out.has(key)) {
            const m = r.owner ? people.get(r.owner) : undefined;
            out.set(key, { id: m?.public_id ?? null, name: m?.name ?? 'No owner', cells: {} });
          }
          out.get(key)!.cells[r.bucket.slice(0, 10)] = {
            minutes: Number(r.minutes),
            tasks: Number(r.tasks),
            unestimated: Number(r.unestimated),
          };
        }
        const people_ = [...out.values()].sort((a, c) =>
          a.id === null ? 1 : c.id === null ? -1 : a.name.localeCompare(c.name),
        );
        return {
          bucket,
          from: b.from,
          to: b.to,
          buckets,
          people: people_.map((x) => ({
            ...x,
            total_minutes: Object.values(x.cells).reduce((n, c) => n + c.minutes, 0),
          })),
          capacity: null,
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Gantt dependencies, milestones, and portfolio progress (for records the view returns)
  // ---------------------------------------------------------------------------------------------

  /**
   * `blocks` relationships among the given tasks: both endpoints must be returned by the view's
   * authorized query, so an arrow never points at (or reveals) a hidden task (AT-131 rule).
   */
  async dependencies(caller: Caller, ws: unknown, body: unknown) {
    const b = isObj(body) ? body : {};
    const ids = this.idsOf(b, 'tsk');
    return this.track('gantt', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const { byId } = await this.authorizedIds(tx, p, this.raw(b), 'task', ids);
        const internal = [...byId.keys()];
        const rows = (
          await sql<{
            from_record_id: string;
            to_record_id: string;
          }>`SELECT from_record_id, to_record_id
          FROM relations.record_relationship WHERE workspace_id = ${tx.workspaceId} AND kind = 'blocks'
            AND from_record_id = ANY(${internal.length ? internal : [NIL]}::uuid[])
            AND to_record_id = ANY(${internal.length ? internal : [NIL]}::uuid[])
          ORDER BY from_record_id, to_record_id`.execute(tx.db)
        ).rows;
        return {
          edges: rows.map((r) => ({
            from: byId.get(r.from_record_id)!,
            to: byId.get(r.to_record_id)!,
            kind: 'blocks' as const,
          })),
        };
      }),
    );
  }

  /** Milestones of the given projects (each project returned by the view's authorized query). */
  async milestones(caller: Caller, ws: unknown, body: unknown) {
    const b = isObj(body) ? body : {};
    const ids = this.idsOf(b, 'prj');
    return this.track('milestones', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const { byId } = await this.authorizedIds(tx, p, this.raw(b), 'project', ids);
        const internal = [...byId.keys()];
        const rows = (
          await sql<{
            project_id: string;
            public_id: string;
            name: string;
            due_date: string | null;
            status: string;
            reached_at: Date | null;
          }>`SELECT m.project_id, mr.public_id, m.name, m.due_date::text AS due_date, m.status, m.reached_at
          FROM work.milestone m JOIN core.record mr ON mr.workspace_id = m.workspace_id AND mr.id = m.id
          WHERE m.workspace_id = ${tx.workspaceId} AND m.lifecycle_state = 'active'
            AND m.project_id = ANY(${internal.length ? internal : [NIL]}::uuid[])
          ORDER BY m.project_id, m.due_date NULLS LAST, m.rank COLLATE "C", m.id
          LIMIT ${this.ws.layoutItemsMax * 10}`.execute(tx.db)
        ).rows;
        return {
          milestones: rows.map((r) => ({
            id: r.public_id,
            type: 'milestone' as const,
            project: byId.get(r.project_id)!,
            name: r.name,
            due_date: r.due_date,
            status: r.status,
            reached_at: r.reached_at ? new Date(r.reached_at).toISOString() : null,
          })),
        };
      }),
    );
  }

  /**
   * Completion of the given projects (OD-13): done leaf tasks over non-cancelled leaf tasks, among
   * the tasks the viewer can read. Hidden tasks never change a percentage or a count.
   */
  async progress(caller: Caller, ws: unknown, body: unknown) {
    const b = isObj(body) ? body : {};
    const ids = this.idsOf(b, 'prj');
    return this.track('portfolio', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const { byId } = await this.authorizedIds(tx, p, this.raw(b), 'project', ids);
        const internal = [...byId.keys()];
        const vis = await compileVisibility(tx, p, {
          need: 'view',
          includeArchived: false,
          arrayMax: this.c.settings.principalContextArrayMax,
        });
        const rows = (
          await sql<{ project_id: string; done: string; total: string }>`SELECT t.project_id,
            count(*) FILTER (WHERE t.status_category = 'done')::text AS done,
            count(*) FILTER (WHERE t.status_category <> 'cancelled')::text AS total
          FROM core.record r JOIN work.task t ON t.workspace_id = r.workspace_id AND t.id = r.id
          WHERE r.workspace_id = ${tx.workspaceId} AND r.record_type = 'task'
            AND t.project_id = ANY(${internal.length ? internal : [NIL]}::uuid[])
            AND ${vis.where('r', { project: sql`t.project_id` })}
            AND NOT EXISTS (SELECT 1 FROM work.task c JOIN core.record cr ON cr.id = c.id
              WHERE c.workspace_id = t.workspace_id AND c.parent_task_id = t.id
                AND ${vis.where('cr', { project: sql`c.project_id` })})
          GROUP BY t.project_id`.execute(tx.db)
        ).rows;
        const by = new Map(rows.map((r) => [r.project_id, r]));
        return {
          progress: internal.map((id) => {
            const r = by.get(id);
            const done = Number(r?.done ?? 0);
            const total = Number(r?.total ?? 0);
            return {
              project: byId.get(id)!,
              done,
              total,
              percent: total ? Math.round((done / total) * 100) : null,
            };
          }),
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Timesheet layout (VIEW-011): the caller's own time on the view's tasks, per day
  // ---------------------------------------------------------------------------------------------

  /**
   * Minutes the caller logged on each of the given tasks per day in the window (3D entries are the
   * source of truth; logging and submitting stay on the Time page, ADR-0019 T8–T10).
   */
  async myTime(caller: Caller, ws: unknown, body: unknown) {
    const b = isObj(body) ? body : {};
    const ids = this.idsOf(b, 'tsk');
    if (typeof b.from !== 'string' || !ISO_DAY.test(b.from))
      throw invalid(issue('/from', 'invalid', 'Choose the first day.'));
    const days = Number(b.days ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 31)
      throw invalid(issue('/days', 'invalid', 'Show 1 to 31 days.'));
    return this.track('timesheet', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const { byId } = await this.authorizedIds(tx, p, this.raw(b), 'task', ids);
        const internal = [...byId.keys()];
        const rows = (
          await sql<{
            task_id: string;
            work_date: string;
            seconds: string;
            billable: string;
          }>`SELECT
            e.task_id, e.work_date::text AS work_date, sum(e.duration_seconds)::text AS seconds,
            sum(e.duration_seconds) FILTER (WHERE e.billable)::text AS billable
          FROM timetrack.time_entry e
          WHERE e.workspace_id = ${tx.workspaceId} AND e.membership_id = ${p.membershipId}
            AND e.task_id = ANY(${internal.length ? internal : [NIL]}::uuid[])
            AND e.work_date BETWEEN ${b.from}::date AND (${b.from}::date + ${days - 1}::integer)
            AND e.state = 'stopped'
          GROUP BY 1, 2 ORDER BY 1, 2`.execute(tx.db)
        ).rows;
        return {
          from: b.from,
          days: Array.from({ length: days }, (_, i) => addDays(b.from as string, i)),
          cells: rows.map((r) => ({
            task: byId.get(r.task_id)!,
            day: r.work_date,
            minutes: Math.round(Number(r.seconds) / 60),
            billable_minutes: Math.round(Number(r.billable ?? 0) / 60),
          })),
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Activity (VIEW-010; AUD-005 contribution): the view's records, newest first
  // ---------------------------------------------------------------------------------------------

  /**
   * Audit events of records the view returns that the caller can read through ownership (history
   * is outside a share, AZ-22), at most `ACTIVITY_RECORDS_MAX` records. Filters: person, actor
   * type, action family. Every record or person a change names is re-authorized; a change to a
   * field the reader cannot read is dropped, and an entry with nothing left is omitted (IA-43).
   */
  async activity(caller: Caller, ws: unknown, entity: Entity, body: unknown) {
    const b = isObj(body) ? body : {};
    const limit = this.pageLimit(b.limit);
    const actorType = b.actor_type;
    if (actorType !== undefined && !(ACTOR_TYPES as readonly unknown[]).includes(actorType))
      throw invalid(
        issue('/actor_type', 'invalid', 'Choose a person, agent, integration, or system.'),
      );
    const action = b.action;
    if (
      action !== undefined &&
      (typeof action !== 'string' || !/^[a-z_]{1,40}(\.[a-z_]{1,40})?$/.test(action))
    )
      throw invalid(issue('/action', 'invalid', 'Choose an action.'));
    const actor = b.actor;
    if (
      actor !== undefined &&
      actor !== 'me' &&
      (typeof actor !== 'string' || !/^mem_[0-9A-HJKMNP-TV-Z]{26}$/.test(actor))
    )
      throw invalid(issue('/actor', 'invalid', 'Choose a person.'));
    return this.track('activity', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const k = await this.compileQuery(tx, p, this.raw(b), entity);
        const own = await compileVisibility(tx, p, {
          need: 'view',
          includeArchived: false,
          arrayMax: this.c.settings.principalContextArrayMax,
          shares: false,
        });
        const proj = entity === 'task' ? sql`t.project_id` : sql`w.id`;
        const max = this.ws.activityRecordsMax;
        const records = (
          await sql<{
            id: string;
            public_id: string;
            title: string;
            brand_id: string;
            project_id: string | null;
          }>`
          SELECT r.id, r.public_id, ${entity === 'task' ? sql`t.title` : sql`w.name`} AS title,
            ${entity === 'task' ? sql`t.brand_id` : sql`w.brand_id`} AS brand_id,
            ${entity === 'task' ? sql`t.project_id` : sql`w.id`} AS project_id
          ${k.where} AND ${own.where('r', { project: proj })}
          ORDER BY r.id LIMIT ${max + 1}`.execute(tx.db)
        ).rows;
        const truncated = records.length > max;
        const scope = records.slice(0, max);
        const byId = new Map(scope.map((r) => [r.id, r]));
        // Who and what (people are member-only facts).
        let actorId: string | null = null;
        if (actor === 'me') actorId = p.membershipId;
        else if (typeof actor === 'string')
          actorId =
            (
              await sql<{ id: string }>`SELECT id FROM tenancy.membership
              WHERE workspace_id = ${tx.workspaceId} AND public_id = ${actor}`.execute(tx.db)
            ).rows[0]?.id ?? NIL;
        if (actorId && p.kind !== 'member' && actorId !== p.membershipId) actorId = NIL;
        const fp = createHash('sha256')
          .update(JSON.stringify([entity, b.query, b.scope, actorType, action, actor]))
          .digest('base64url');
        let before: { at: string; id: string } | null = null;
        if (b.cursor !== undefined) before = this.decodeActivityCursor(p, fp, b.cursor);
        const ids = [...byId.keys()];
        const rows = (
          await sql<{
            id: string;
            occurred_at: Date;
            action: string;
            actor_type: string;
            actor_id: string | null;
            changes: StoredChange[];
            target_record_id: string;
          }>`SELECT e.id, e.occurred_at, e.action, e.actor_type, e.actor_id, e.changes, e.target_record_id
          FROM audit.audit_event e
          WHERE e.workspace_id = ${tx.workspaceId}
            AND e.target_record_id = ANY(${ids.length ? ids : [NIL]}::uuid[])
            ${actorType ? sql`AND e.actor_type = ${actorType}` : sql``}
            ${actorId ? sql`AND e.actor_id = ${actorId}::uuid` : sql``}
            ${action ? sql`AND (e.action = ${action} OR e.action LIKE ${`${action}.%`} OR e.action LIKE ${`${action}_%`})` : sql``}
            ${before ? sql`AND (e.occurred_at, e.id) < (${before.at}::timestamptz, ${before.id}::uuid)` : sql``}
          ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${limit + 1}`.execute(tx.db)
        ).rows;
        const page = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        // Referenced records and people, re-authorized before any value is shown.
        const isRef = (v: unknown): v is string =>
          typeof v === 'string' && /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}\*?$/.test(v);
        const refs = new Set<string>();
        for (const e of page)
          for (const c of e.changes)
            for (const v of [c.old, c.new])
              if (typeof v === 'string')
                for (const part of v.split(',')) if (isRef(part)) refs.add(part.replace(/\*$/, ''));
        const recordRefs = [...refs].filter((r) => !r.startsWith('mem_'));
        const readable = new Set(
          (
            await sql<{ public_id: string }>`SELECT r.public_id FROM core.record r
            WHERE r.workspace_id = ${tx.workspaceId}
              AND r.public_id = ANY(${recordRefs.length ? recordRefs : ['x']}::text[])
              AND ${k.refVis.where('r')}`.execute(tx.db)
          ).rows.map((r) => r.public_id),
        );
        const memberRefs = [...refs].filter((r) => r.startsWith('mem_'));
        const actorIds = [...new Set(page.map((e) => e.actor_id).filter((x): x is string => !!x))];
        const people =
          p.kind === 'member'
            ? (
                await sql<{ id: string; public_id: string; name: string }>`SELECT m.id, m.public_id,
                coalesce(m.display_name_override, acc.display_name) AS name FROM tenancy.membership m
                JOIN identity.account acc ON acc.id = m.account_id
                WHERE m.workspace_id = ${tx.workspaceId}
                  AND (m.public_id = ANY(${memberRefs.length ? memberRefs : ['x']}::text[])
                    OR m.id = ANY(${actorIds.length ? actorIds : [NIL]}::uuid[]))`.execute(tx.db)
              ).rows
            : [];
        const byPublic = new Map(people.map((m) => [m.public_id, m.name]));
        const byInternal = new Map(people.map((m) => [m.id, m]));
        // Custom fields readable on each record shown (one resolution per record on the page).
        const fieldsByRecord = new Map<string, Set<string>>();
        for (const id of [...new Set(page.map((e) => e.target_record_id))]) {
          const r = byId.get(id)!;
          const access = await fieldsForRecord(
            tx,
            p,
            {
              id,
              kind: entity,
              brandId: r.brand_id,
              projectId: entity === 'task' ? r.project_id : id,
            },
            'view',
          );
          fieldsByRecord.set(
            id,
            new Set(
              access
                .filter((f) => f.readable)
                .map((f) => `fields.${f.def.public_id.toLowerCase()}`),
            ),
          );
        }
        const show = (v: unknown): { ok: boolean; value: unknown } => {
          if (typeof v !== 'string') return { ok: true, value: v };
          const parts = v.split(',');
          if (!parts.some((x) => isRef(x))) return { ok: true, value: v };
          const out: string[] = [];
          for (const part of parts) {
            const id = part.replace(/\*$/, '');
            if (id.startsWith('mem_')) {
              const name = byPublic.get(id);
              if (name) out.push(part.endsWith('*') ? `${name} (primary)` : name);
            } else if (readable.has(id)) out.push(id);
            else return { ok: false, value: null };
          }
          return { ok: true, value: out.join(', ') || null };
        };
        const data = [];
        for (const e of page) {
          const fields = fieldsByRecord.get(e.target_record_id)!;
          const changes = e.changes
            .filter((c) => !c.field.startsWith('fields.') || fields.has(c.field))
            .map((c) => {
              if (c.class !== 'plain' || c.redacted)
                return { field: c.field, changed: true as const };
              const o = show(c.old);
              const n = show(c.new);
              if (!o.ok || !n.ok) return null;
              return { field: c.field, from: o.value, to: n.value };
            });
          if (e.changes.length && (!changes.length || changes.every((c) => c === null))) continue;
          const target = byId.get(e.target_record_id)!;
          const who = e.actor_id ? byInternal.get(e.actor_id) : undefined;
          data.push({
            key: createHash('sha256').update(e.id).digest('base64url').slice(0, 22),
            at: new Date(e.occurred_at).toISOString(),
            action: e.action,
            actor:
              e.actor_type === 'human'
                ? who
                  ? { type: 'human', id: who.public_id, name: who.name }
                  : { type: 'human' }
                : { type: e.actor_type },
            record: { id: target.public_id, type: entity, title: target.title },
            changes: changes.filter((c) => c !== null),
          });
        }
        const last = page.at(-1);
        return {
          data,
          page: {
            limit,
            has_more: hasMore,
            ...(hasMore && last
              ? {
                  next_cursor: this.encodeActivityCursor(p, fp, {
                    at: new Date(last.occurred_at).toISOString(),
                    id: last.id,
                  }),
                }
              : {}),
          },
          records_truncated: truncated,
        };
      }),
    );
  }

  protected encodeActivityCursor(p: Principal, fp: string, c: { at: string; id: string }) {
    const payload = JSON.stringify(c);
    const mac = createHmac('sha256', this.#activityKey)
      .update(`${p.workspaceId}|${p.membershipId}|${fp}|${payload}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    return Buffer.from(JSON.stringify({ p: payload, m: mac })).toString('base64url');
  }

  protected decodeActivityCursor(p: Principal, fp: string, raw: unknown) {
    try {
      if (typeof raw !== 'string' || raw.length > 2048) throw new Error();
      const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
        p: string;
        m: string;
      };
      const want = createHmac('sha256', this.#activityKey)
        .update(`${p.workspaceId}|${p.membershipId}|${fp}|${o.p}`)
        .digest()
        .subarray(0, 16);
      const got = Buffer.from(o.m, 'base64url');
      if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error();
      const c = JSON.parse(o.p) as { at: string; id: string };
      if (Number.isNaN(Date.parse(c.at)) || !/^[0-9a-f-]{36}$/.test(c.id)) throw new Error();
      return c;
    } catch {
      throw new TenancyError('cursor_invalid');
    }
  }
}
