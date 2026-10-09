import { createHash } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type RawBuilder, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import {
  compileVisibility,
  decideBrand,
  findBrand,
  invalid,
  issue,
  parseIfMatch,
  requireVersion,
  TenancyError,
  type BrandFacts,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { ViewService } from '../views/view-service.ts';
import { isPublic } from '../validation.ts';
import {
  addDays,
  bucketOf,
  csv,
  daysBetween,
  entriesHash,
  hoursOf,
  localDay,
  parseInstant,
  periodOf,
  secondsBetween,
  validDay,
  validZone,
  wholeSecond,
} from './semantics.ts';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** Clock skew tolerated for instants a client sends (offline timers, manual end times). */
const SKEW_SECONDS = 300;
const NOTE_MAX = 1000;
const DAY_SECONDS = 86_400;

/** Where a person may log time: one task or one project, in its own brand. */
interface Target {
  kind: 'task' | 'project';
  id: string;
  publicId: string;
  brandId: string;
  title: string;
}

type Span =
  | { kind: 'timed'; start: Date; end: Date; day: string; seconds: number }
  | { kind: 'duration'; day: string; seconds: number };

export type EntryStatus = 'open' | 'submitted' | 'locked';

/** A time entry as one viewer may see it. */
export interface TimeEntryView {
  id: string;
  type: 'time_entry';
  target: { type: 'task' | 'project'; id: string; title: string } | null;
  brand: { id: string; name: string };
  person: { id: string; name: string };
  source: 'manual' | 'timer';
  state: 'running' | 'paused' | 'stopped';
  started_at: string | null;
  ended_at: string | null;
  running_since: string | null;
  work_date: string;
  tz: string;
  duration_seconds: number;
  hours: number;
  billable: boolean;
  note: string;
  auto_stopped: boolean;
  segments: Array<{ started_at: string; ended_at: string | null }>;
  status: EntryStatus;
  own: boolean;
  editable: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

interface EntryRow {
  id: string;
  public_id: string;
  brand_id: string;
  membership_id: string;
  task_id: string | null;
  project_id: string | null;
  source: 'manual' | 'timer';
  state: 'running' | 'paused' | 'stopped';
  started_at: Date | null;
  ended_at: Date | null;
  work_date: string;
  tz: string;
  duration_seconds: number;
  billable: boolean;
  note: string;
  auto_stopped: boolean;
  created_at: Date;
  updated_at: Date;
  version: string | number;
}

interface ViewRow extends EntryRow {
  target_public_id: string | null;
  target_title: string | null;
  brand_public_id: string;
  brand_name: string;
  person_public_id: string;
  person_name: string;
  closed: 'submitted' | 'locked' | null;
  visible: boolean;
  loggable: boolean;
}

/** The FROM clause every entry read uses: the entry, its target record, and the task (if any). */
const ENTRY_FROM = sql`timetrack.time_entry e
  JOIN core.record r ON r.workspace_id = e.workspace_id AND r.id = coalesce(e.task_id, e.project_id)
  LEFT JOIN work.task tk ON tk.workspace_id = e.workspace_id AND tk.id = e.task_id`;

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

/**
 * Phase 3D time tracking and timesheets (ADR-0019; 0B §6.6, 0C AZ-27, 0D PL-29). Manual entries
 * and timers on readable work (`time.log_own`), billable state, planned/actual/remaining effort,
 * weekly timesheets submitted by their owner and approved per brand line (`timesheet.approve`),
 * period locks with an audited admin unlock (OD-26), and bounded direct exports. Every read runs
 * the viewer's own visibility predicate: entries on work the viewer cannot read are absent from
 * lists, totals, reports, and exports. One per-person database lock serializes every write that a
 * period check protects, and database guards repeat the overlap and lock rules.
 */
export class TimeService extends ViewService {
  // ---------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------

  protected override mapFailure(command: string, err: unknown): unknown {
    const pg =
      typeof err === 'object' && err !== null
        ? (err as { code?: string; message?: string; constraint?: string })
        : {};
    if (pg.code === '23P01' && pg.message?.startsWith('time_overlap')) {
      this.count(command, 'conflict');
      return new TenancyError('conflict', {
        issues: [issue('/started_at', 'overlap', 'This time overlaps another entry of yours.')],
      });
    }
    if (pg.code === '23514' && /^time_(submitted|locked)/.test(pg.message ?? '')) {
      this.count(command, 'conflict');
      return new TenancyError('conflict', {
        issues: [
          issue(
            '/',
            'time_locked',
            'Some of this time is in a submitted or approved timesheet. Withdraw the timesheet or ask an admin to unlock the period first.',
          ),
        ],
      });
    }
    if (pg.code === '23505' && pg.constraint === 'time_entry_one_live_timer') {
      this.count(command, 'conflict');
      return new TenancyError('conflict', {
        issues: [issue('/', 'timer_running', 'A timer is already running. Stop it first.')],
      });
    }
    return super.mapFailure(command, err);
  }

  protected async lockPerson(tx: WorkspaceTransaction, membershipId: string) {
    await sql`SELECT timetrack.lock_person(${tx.workspaceId}::uuid, ${membershipId}::uuid)`.execute(
      tx.db,
    );
  }

  protected async closedReason(
    tx: WorkspaceTransaction,
    membershipId: string,
    brandId: string,
    day: string,
  ): Promise<'submitted' | 'locked' | null> {
    const r = await sql<{ c: 'submitted' | 'locked' | null }>`SELECT timetrack.day_closed(
      ${tx.workspaceId}::uuid, ${membershipId}::uuid, ${brandId}::uuid, ${day}::date) AS c`.execute(
      tx.db,
    );
    return r.rows[0]?.c ?? null;
  }

  /** The period rule (TIME-012, TIME-013): submitted or approved time is closed for edits. */
  protected async requireOpenDay(
    tx: WorkspaceTransaction,
    membershipId: string,
    brandId: string,
    day: string,
  ) {
    const why = await this.closedReason(tx, membershipId, brandId, day);
    if (why === 'submitted')
      throw new TenancyError('conflict', {
        issues: [
          issue(
            '/',
            'period_submitted',
            'This week is submitted for approval. Withdraw the timesheet to change its time.',
          ),
        ],
      });
    if (why === 'locked')
      throw new TenancyError('conflict', {
        issues: [
          issue(
            '/',
            'period_locked',
            'This week is approved and locked. An admin must unlock it before its time can change.',
          ),
        ],
      });
  }

  protected async workspaceCalendar(tx: WorkspaceTransaction) {
    const w = await tx.db
      .selectFrom('tenancy.workspace')
      .select(['timezone', 'week_start'])
      .where('id', '=', tx.workspaceId)
      .executeTakeFirstOrThrow();
    return { timezone: w.timezone, weekStart: Number(w.week_start) };
  }

  /** The person's own zone (profile), else the workspace zone (0A §3). */
  protected async personZone(tx: WorkspaceTransaction, membershipId: string): Promise<string> {
    const r = await tx.db
      .selectFrom('tenancy.membership as m')
      .innerJoin('identity.account as a', 'a.id', 'm.account_id')
      .select('a.timezone')
      .where('m.id', '=', membershipId)
      .executeTakeFirst();
    return validZone(r?.timezone) ?? (await this.workspaceCalendar(tx)).timezone;
  }

  protected zoneInput(v: unknown, path = '/tz'): string | null {
    if (v === undefined || v === null) return null;
    const z = validZone(v);
    if (!z) throw invalid(issue(path, 'invalid', 'Choose a valid time zone.'));
    return z;
  }

  protected get maxEntrySeconds(): number {
    return this.ws.timeEntryMaxHours * 3600;
  }

  protected brandFacts(row: { id: string; is_sensitive: boolean; lifecycle_state: string }) {
    return {
      id: row.id,
      isSensitive: row.is_sensitive,
      lifecycleState: 'active' as const,
    } satisfies BrandFacts;
  }

  protected async brandRows(tx: WorkspaceTransaction, ids?: string[]) {
    let q = tx.db
      .selectFrom('tenancy.brand as b')
      .innerJoin('core.record as br', (j) =>
        j.onRef('br.workspace_id', '=', 'b.workspace_id').onRef('br.id', '=', 'b.id'),
      )
      .select(['b.id', 'br.public_id', 'b.name', 'b.is_sensitive', 'b.lifecycle_state']);
    if (ids) q = q.where('b.id', 'in', ids.length ? ids : ['00000000-0000-7000-8000-000000000000']);
    return q.where('b.lifecycle_state', 'in', ['active', 'archived']).orderBy('b.name').execute();
  }

  // ---------------------------------------------------------------------------------------------
  // Targets and the visibility predicate
  // ---------------------------------------------------------------------------------------------

  /** A task or project the caller may log time on now (`time.log_own`; active work only). */
  protected async loggableTarget(
    tx: WorkspaceTransaction,
    p: Principal,
    ref: unknown,
  ): Promise<Target> {
    if (ref === undefined || ref === null || ref === '')
      throw invalid(issue('/target', 'required', 'Choose a task or project to log time on.'));
    if (isPublic(ref, 'tsk')) {
      const t = await this.loadTask(tx, p, ref);
      this.requireTaskAction(p, 'time.log_own', t);
      this.requireTaskActive(t);
      return {
        kind: 'task',
        id: t.id,
        publicId: t.publicId,
        brandId: t.brand.id,
        title: t.row.title,
      };
    }
    if (isPublic(ref, 'prj')) {
      const prj = await this.loadProject(tx, p, ref);
      this.requireProjectAction(p, 'time.log_own', prj);
      if (prj.lifecycleState !== 'active')
        throw new TenancyError('conflict', {
          issues: [
            issue('/target', 'archived', 'This project is archived. Restore it to log time.'),
          ],
        });
      return {
        kind: 'project',
        id: prj.id,
        publicId: prj.publicId,
        brandId: prj.brand.id,
        title: prj.row.name,
      };
    }
    throw new TenancyError('not_found');
  }

  protected async targetOfRow(tx: WorkspaceTransaction, p: Principal, row: EntryRow) {
    const pub = await this.publicOf(tx, (row.task_id ?? row.project_id)!);
    return this.loggableTarget(tx, p, pub);
  }

  /**
   * The entries a viewer may read (ADR-0019 T8): entries on work the viewer can read (archived
   * included, read-only), never trashed or hidden work; guests read only their own entries.
   */
  protected async entryPredicate(
    tx: WorkspaceTransaction,
    p: Principal,
  ): Promise<RawBuilder<boolean>> {
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      includeArchived: true,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const work = vis.where('r', { project: sql`coalesce(tk.project_id, e.project_id)` });
    return p.kind === 'guest'
      ? sql<boolean>`(${work} AND e.membership_id = ${p.membershipId}::uuid)`
      : sql<boolean>`${work}`;
  }

  /**
   * Where the viewer may log time now: the same compiled predicate at `comment` on active work
   * (time.log_own's level; read-only roles are capped at view, guests need a comment share).
   */
  protected async loggablePredicate(
    tx: WorkspaceTransaction,
    p: Principal,
  ): Promise<RawBuilder<boolean>> {
    const vis = await compileVisibility(tx, p, {
      need: 'comment',
      includeArchived: false,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    return vis.where('r', { project: sql`coalesce(tk.project_id, e.project_id)` });
  }

  /** A readable project for grouping (a task's hidden project is never named or counted). */
  protected async projectPredicate(tx: WorkspaceTransaction, p: Principal, alias: string) {
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      includeArchived: true,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    return vis.where(alias, { project: sql.raw(`${alias}.id`) });
  }

  /** Entry rows with their display joins, filtered by `where` (which must include visibility). */
  protected async entryRows(
    tx: WorkspaceTransaction,
    where: RawBuilder<boolean>,
    opts: {
      limit: number;
      order?: 'asc' | 'desc';
      visible?: RawBuilder<boolean>;
      loggable?: RawBuilder<boolean>;
    },
  ): Promise<ViewRow[]> {
    const dir = sql.raw(opts.order === 'asc' ? 'ASC' : 'DESC');
    const r = await sql<ViewRow>`
      SELECT e.*, r.public_id AS target_public_id, coalesce(tk.title, pj.name) AS target_title,
        br.public_id AS brand_public_id, b.name AS brand_name,
        m.public_id AS person_public_id, coalesce(m.display_name_override, a.display_name) AS person_name,
        timetrack.day_closed(e.workspace_id, e.membership_id, e.brand_id, e.work_date) AS closed,
        ${opts.visible ?? sql`true`} AS visible,
        ${opts.loggable ?? sql`false`} AS loggable
      FROM ${ENTRY_FROM}
      LEFT JOIN work.project pj ON pj.workspace_id = e.workspace_id AND pj.id = e.project_id
      JOIN tenancy.brand b ON b.workspace_id = e.workspace_id AND b.id = e.brand_id
      JOIN core.record br ON br.workspace_id = b.workspace_id AND br.id = b.id
      JOIN tenancy.membership m ON m.workspace_id = e.workspace_id AND m.id = e.membership_id
      JOIN identity.account a ON a.id = m.account_id
      WHERE ${where}
      ORDER BY e.work_date ${dir}, e.started_at ${dir} NULLS LAST, e.id ${dir}
      LIMIT ${opts.limit}`.execute(tx.db);
    return r.rows;
  }

  protected async segmentsOf(tx: WorkspaceTransaction, entryIds: string[]) {
    const out = new Map<string, Array<{ started_at: string; ended_at: string | null }>>();
    if (!entryIds.length) return out;
    const rows = await tx.db
      .selectFrom('timetrack.time_segment')
      .select(['entry_id', 'started_at', 'ended_at'])
      .where('entry_id', 'in', entryIds)
      .orderBy('started_at')
      .execute();
    for (const s of rows) {
      const list = out.get(s.entry_id) ?? [];
      list.push({ started_at: iso(s.started_at)!, ended_at: iso(s.ended_at) });
      out.set(s.entry_id, list);
    }
    return out;
  }

  protected async views(
    tx: WorkspaceTransaction,
    p: Principal,
    rows: ViewRow[],
  ): Promise<TimeEntryView[]> {
    const segs = await this.segmentsOf(
      tx,
      rows.map((r) => r.id),
    );
    return rows.map((r) => {
      const own = r.membership_id === p.membershipId;
      const s = segs.get(r.id) ?? [];
      const open = s.find((x) => x.ended_at === null);
      return {
        id: r.public_id,
        type: 'time_entry' as const,
        // An own live timer on work the person can no longer read keeps no target (T8).
        target:
          r.visible && r.target_public_id
            ? {
                type: r.task_id ? ('task' as const) : ('project' as const),
                id: r.target_public_id,
                title: r.target_title ?? '',
              }
            : null,
        brand: { id: r.brand_public_id, name: r.brand_name },
        person: { id: r.person_public_id, name: r.person_name },
        source: r.source,
        state: r.state,
        started_at: iso(r.started_at),
        ended_at: iso(r.ended_at),
        running_since: open?.started_at ?? null,
        work_date: String(r.work_date).slice(0, 10),
        tz: r.tz,
        duration_seconds: Number(r.duration_seconds),
        hours: hoursOf(Number(r.duration_seconds)),
        billable: r.billable,
        note: r.visible ? r.note : '',
        auto_stopped: r.auto_stopped,
        segments: s,
        status: r.closed ?? 'open',
        own,
        editable: own && r.visible && r.loggable && r.closed === null,
        version: Number(r.version),
        created_at: iso(r.created_at)!,
        updated_at: iso(r.updated_at)!,
      };
    });
  }

  /** One entry as the caller sees it (readable entries, plus the caller's own live timer). */
  protected async entryView(
    tx: WorkspaceTransaction,
    p: Principal,
    te: string,
    opts: { own?: boolean } = {},
  ): Promise<TimeEntryView> {
    const vis = await this.entryPredicate(tx, p);
    // A timer command answers with the person's own timer even when its work became unreadable
    // (target and note withheld); reads show only readable entries and the live timer.
    const own = opts.own ? sql`true` : sql`e.state <> 'stopped'`;
    const rows = await this.entryRows(
      tx,
      sql<boolean>`e.public_id = ${te} AND (${vis} OR (e.membership_id = ${p.membershipId}::uuid AND ${own}))`,
      { limit: 1, visible: vis, loggable: await this.loggablePredicate(tx, p) },
    );
    if (!rows.length) throw new TenancyError('not_found');
    return (await this.views(tx, p, rows))[0]!;
  }

  /** The caller's own entry (anyone else's, or unknown, is not_found), locked for a change. */
  protected async ownEntry(tx: WorkspaceTransaction, p: Principal, te: unknown): Promise<EntryRow> {
    const row = (await tx.db
      .selectFrom('timetrack.time_entry')
      .selectAll()
      .where('public_id', '=', isPublic(te, 'te') ? te : 'te_0')
      .where('membership_id', '=', p.membershipId)
      .forUpdate()
      .executeTakeFirst()) as EntryRow | undefined;
    if (!row) throw new TenancyError('not_found');
    return row;
  }

  // ---------------------------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------------------------

  protected parseNote(v: unknown): string | undefined {
    if (v === undefined) return undefined;
    if (v === null) return '';
    if (typeof v !== 'string') throw invalid(issue('/note', 'invalid', 'Write the note as text.'));
    const s = v.trim();
    if (s.length > NOTE_MAX)
      throw invalid(issue('/note', 'too_long', `Keep the note under ${NOTE_MAX} characters.`));
    return s;
  }

  protected parseBillable(v: unknown): boolean | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean')
      throw invalid(issue('/billable', 'invalid', 'Choose billable or non-billable.'));
    return v;
  }

  /** An optional client instant for offline timer actions, within the accepted window. */
  protected parseAt(v: unknown, now: Date): Date {
    if (v === undefined || v === null) return wholeSecond(now);
    const at = parseInstant(v);
    if (!at) throw invalid(issue('/at', 'invalid', 'Send the time as an ISO instant.'));
    const skew = secondsBetween(now, at);
    if (skew > SKEW_SECONDS)
      throw invalid(issue('/at', 'future', 'That time is in the future. Check the device clock.'));
    if (-skew > this.maxEntrySeconds)
      throw invalid(
        issue(
          '/at',
          'too_old',
          `Timer actions can be recorded at most ${this.ws.timeEntryMaxHours} hours late.`,
        ),
      );
    return at;
  }

  /**
   * A manual span: either both instants (a timed entry; its day is the start's day in `zone`) or a
   * work date and a duration in minutes (a duration-only entry). Never negative, never longer than
   * TIME_ENTRY_MAX_HOURS, never in the future.
   */
  protected parseSpan(b: Record<string, unknown>, zone: string, now: Date): Span {
    const max = this.maxEntrySeconds;
    if (b.started_at !== undefined || b.ended_at !== undefined) {
      const start = parseInstant(b.started_at);
      const end = parseInstant(b.ended_at);
      if (!start) throw invalid(issue('/started_at', 'invalid', 'Enter a valid start time.'));
      if (!end) throw invalid(issue('/ended_at', 'invalid', 'Enter a valid end time.'));
      const seconds = secondsBetween(start, end);
      if (seconds < 1)
        throw invalid(issue('/ended_at', 'before_start', 'The end must be after the start.'));
      if (seconds > max)
        throw invalid(
          issue(
            '/ended_at',
            'too_long',
            `One entry can be at most ${this.ws.timeEntryMaxHours} hours.`,
          ),
        );
      if (secondsBetween(now, end) > SKEW_SECONDS)
        throw invalid(issue('/ended_at', 'future', 'Time cannot be logged in the future.'));
      const day = localDay(start, zone);
      if (b.work_date !== undefined && b.work_date !== day)
        throw invalid(
          issue('/work_date', 'mismatch', 'The date must be the day the time started.'),
        );
      return { kind: 'timed', start, end, day, seconds };
    }
    const day = validDay(b.work_date);
    if (!day) throw invalid(issue('/work_date', 'invalid', 'Choose the date of the work.'));
    if (day > localDay(now, zone))
      throw invalid(issue('/work_date', 'future', 'Time cannot be logged in the future.'));
    const minutes = b.duration_minutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1)
      throw invalid(
        issue('/duration_minutes', 'invalid', 'Enter the time spent in whole minutes.'),
      );
    if (minutes * 60 > max)
      throw invalid(
        issue(
          '/duration_minutes',
          'too_long',
          `One entry can be at most ${this.ws.timeEntryMaxHours} hours.`,
        ),
      );
    return { kind: 'duration', day, seconds: minutes * 60 };
  }

  protected async requireNoOverlap(
    tx: WorkspaceTransaction,
    membershipId: string,
    start: Date,
    end: Date | null,
    exclude: string | null,
  ) {
    const r = await sql<{ n: number }>`
      SELECT 1 AS n FROM timetrack.time_segment s
       WHERE s.workspace_id = ${tx.workspaceId}::uuid AND s.membership_id = ${membershipId}::uuid
         AND s.ended_at IS DISTINCT FROM s.started_at
         AND s.started_at < coalesce(${end}::timestamptz, 'infinity'::timestamptz)
         AND coalesce(s.ended_at, 'infinity'::timestamptz) > ${start}::timestamptz
         AND s.entry_id IS DISTINCT FROM ${exclude}::uuid
       LIMIT 1`.execute(tx.db);
    if (r.rows.length)
      throw new TenancyError('conflict', {
        issues: [issue('/started_at', 'overlap', 'This time overlaps another entry of yours.')],
      });
  }

  /** A duration-only entry may not take a person's day past 24 hours. */
  protected async requireDayRoom(
    tx: WorkspaceTransaction,
    membershipId: string,
    day: string,
    seconds: number,
    exclude: string | null,
  ) {
    const r = await sql<{ s: string }>`
      SELECT coalesce(sum(duration_seconds), 0) AS s FROM timetrack.time_entry
       WHERE workspace_id = ${tx.workspaceId}::uuid AND membership_id = ${membershipId}::uuid
         AND work_date = ${day}::date AND id IS DISTINCT FROM ${exclude}::uuid`.execute(tx.db);
    if (Number(r.rows[0]?.s ?? 0) + seconds > DAY_SECONDS)
      throw invalid(
        issue('/duration_minutes', 'day_full', 'A day can hold at most 24 hours of time.'),
      );
  }

  protected async timeAudit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    target: { id: string; type: 'time_entry' | 'timesheet'; publicId: string },
    changes: ReturnType<typeof change.plain>[],
    brandId: string | null,
  ) {
    await this.workWriter.write(tx, this.cmd(caller, p, brandId), {
      action,
      target: { recordId: target.id, type: target.type, publicId: target.publicId },
      changes,
    });
  }

  protected async timeEvent(
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

  protected async insertEntry(
    tx: WorkspaceTransaction,
    p: Principal,
    target: Target,
    v: {
      source: 'manual' | 'timer';
      state: 'running' | 'stopped';
      span: Span | { kind: 'open'; start: Date; day: string };
      tz: string;
      billable: boolean;
      note: string;
    },
  ) {
    const id = newUuidV7();
    const publicId = newPublicId('te');
    const timed = v.span.kind !== 'duration';
    const start = v.span.kind === 'duration' ? null : v.span.start;
    const end = v.span.kind === 'timed' ? v.span.end : null;
    await tx.db
      .insertInto('timetrack.time_entry')
      .values({
        id,
        public_id: publicId,
        workspace_id: tx.workspaceId,
        brand_id: target.brandId,
        membership_id: p.membershipId,
        task_id: target.kind === 'task' ? target.id : null,
        project_id: target.kind === 'project' ? target.id : null,
        source: v.source,
        state: v.state,
        started_at: start,
        ended_at: end,
        work_date: v.span.day,
        tz: v.tz,
        duration_seconds: v.span.kind === 'open' ? 0 : v.span.seconds,
        billable: v.billable,
        note: v.note,
      })
      .execute();
    if (timed)
      await tx.db
        .insertInto('timetrack.time_segment')
        .values({
          id: newUuidV7(),
          workspace_id: tx.workspaceId,
          entry_id: id,
          membership_id: p.membershipId,
          started_at: start!,
          ended_at: end,
        })
        .execute();
    return { id, publicId };
  }

  // ---------------------------------------------------------------------------------------------
  // Manual entries (TSK-024, TSK-026, TIME-004, TIME-011)
  // ---------------------------------------------------------------------------------------------

  async createEntry(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const billable = this.parseBillable(b.billable) ?? false;
    const note = this.parseNote(b.note) ?? '';
    return this.mutate(
      caller,
      'time.entry_create',
      ws,
      req,
      async (tx, p) => {
        await this.lockPerson(tx, p.membershipId);
        const target = await this.loggableTarget(tx, p, b.target);
        const zone = this.zoneInput(b.tz) ?? (await this.personZone(tx, p.membershipId));
        const span = this.parseSpan(b, zone, new Date());
        await this.requireOpenDay(tx, p.membershipId, target.brandId, span.day);
        if (span.kind === 'timed')
          await this.requireNoOverlap(tx, p.membershipId, span.start, span.end, null);
        else await this.requireDayRoom(tx, p.membershipId, span.day, span.seconds, null);
        const e = await this.insertEntry(tx, p, target, {
          source: 'manual',
          state: 'stopped',
          span,
          tz: zone,
          billable,
          note,
        });
        await this.timeAudit(
          tx,
          caller,
          p,
          'time.entry_created',
          { id: e.id, type: 'time_entry', publicId: e.publicId },
          [
            change.plain('target', null, target.publicId),
            change.plain('work_date', null, span.day),
            change.plain('duration_seconds', null, span.seconds),
            change.plain('billable', null, billable),
            ...(note ? [change.content('note', { hash: `sha256:${sha(note)}` })] : []),
          ],
          target.brandId,
        );
        await this.timeEvent(
          tx,
          caller,
          p,
          'time.time_entry.recorded',
          { type: 'time.time_entry', id: e.id, sequence: 0 },
          { duration_seconds: span.seconds, billable, source: 'manual' },
          target.brandId,
        );
        this.d.metrics.count('time.entries', 1, { source: 'manual', outcome: 'created' });
        return {
          status: 201,
          ref: { id: e.publicId, type: 'time_entry' },
          data: await this.entryView(tx, p, e.publicId),
        };
      },
      (tx, p, ref) => this.entryView(tx, p, ref.id),
    );
  }

  /**
   * Changes the caller's own entry (target, times or duration, billable, note) with `If-Match`.
   * The entry's old and new days must both be open. Editing a timer's times replaces its segments
   * with the one edited span.
   */
  async updateEntry(caller: Caller, ws: unknown, te: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const billable = this.parseBillable(b.billable);
    const note = this.parseNote(b.note);
    const timesChanged =
      b.started_at !== undefined ||
      b.ended_at !== undefined ||
      b.work_date !== undefined ||
      b.duration_minutes !== undefined;
    return this.mutate(
      caller,
      'time.entry_update',
      ws,
      req,
      async (tx, p) => {
        const expected = parseIfMatch(req.ifMatch);
        await this.lockPerson(tx, p.membershipId);
        const row = await this.ownEntry(tx, p, te);
        const current = await this.targetOfRow(tx, p, row);
        requireVersion(expected, Number(row.version));
        await this.requireOpenDay(tx, p.membershipId, row.brand_id, row.work_date);
        const target =
          b.target !== undefined && b.target !== current.publicId
            ? await this.loggableTarget(tx, p, b.target)
            : current;
        const zone = this.zoneInput(b.tz) ?? row.tz;
        let span: Span | null = null;
        if (timesChanged || zone !== row.tz) {
          if (row.state !== 'stopped')
            throw new TenancyError('conflict', {
              issues: [issue('/', 'timer_live', 'Stop the timer before changing its times.')],
            });
          // Unchanged parts of the span come from the entry; clock times win over a duration.
          const clock = b.started_at !== undefined || b.ended_at !== undefined;
          const merged =
            clock ||
            (row.started_at && b.duration_minutes === undefined && b.work_date === undefined)
              ? {
                  started_at: b.started_at ?? iso(row.started_at),
                  ended_at: b.ended_at ?? iso(row.ended_at),
                  ...(b.work_date !== undefined ? { work_date: b.work_date } : {}),
                }
              : {
                  work_date: b.work_date ?? String(row.work_date).slice(0, 10),
                  duration_minutes: b.duration_minutes ?? Math.round(row.duration_seconds / 60),
                };
          span = this.parseSpan(merged, zone, new Date());
          if (row.source === 'timer' && span.kind !== 'timed')
            throw invalid(
              issue('/started_at', 'required', 'A timer entry keeps its start and end times.'),
            );
        }
        const day = span?.day ?? row.work_date;
        if (target.brandId !== row.brand_id || day !== row.work_date)
          await this.requireOpenDay(tx, p.membershipId, target.brandId, day);
        if (span?.kind === 'timed')
          await this.requireNoOverlap(tx, p.membershipId, span.start, span.end, row.id);
        if (span?.kind === 'duration')
          await this.requireDayRoom(tx, p.membershipId, span.day, span.seconds, row.id);
        const set: Record<string, unknown> = {
          updated_at: new Date(),
          version: Number(row.version) + 1,
        };
        const changes: ReturnType<typeof change.plain>[] = [];
        if (target.id !== (row.task_id ?? row.project_id)) {
          // Target and brand change together in the one update (the brand is part of the key).
          set.brand_id = target.brandId;
          set.task_id = target.kind === 'task' ? target.id : null;
          set.project_id = target.kind === 'project' ? target.id : null;
          changes.push(change.plain('target', current.publicId, target.publicId));
        }
        if (billable !== undefined && billable !== row.billable) {
          set.billable = billable;
          changes.push(change.plain('billable', row.billable, billable));
        }
        if (note !== undefined && note !== row.note) {
          set.note = note;
          changes.push(change.content('note', { hash: `sha256:${sha(note)}` }));
        }
        if (zone !== row.tz) {
          set.tz = zone;
          changes.push(change.plain('tz', row.tz, zone));
        }
        if (span) {
          set.work_date = span.day;
          set.duration_seconds = span.seconds;
          set.started_at = span.kind === 'timed' ? span.start : null;
          set.ended_at = span.kind === 'timed' ? span.end : null;
          if (span.day !== row.work_date)
            changes.push(change.plain('work_date', row.work_date, span.day));
          if (span.seconds !== row.duration_seconds)
            changes.push(change.plain('duration_seconds', row.duration_seconds, span.seconds));
          await tx.db.deleteFrom('timetrack.time_segment').where('entry_id', '=', row.id).execute();
        }
        await tx.db
          .updateTable('timetrack.time_entry')
          .set(set as never)
          .where('id', '=', row.id)
          .execute();
        if (span?.kind === 'timed')
          await tx.db
            .insertInto('timetrack.time_segment')
            .values({
              id: newUuidV7(),
              workspace_id: tx.workspaceId,
              entry_id: row.id,
              membership_id: p.membershipId,
              started_at: span.start,
              ended_at: span.end,
            })
            .execute();
        if (changes.length) {
          await this.timeAudit(
            tx,
            caller,
            p,
            'time.entry_updated',
            { id: row.id, type: 'time_entry', publicId: row.public_id },
            changes,
            target.brandId,
          );
          await this.timeEvent(
            tx,
            caller,
            p,
            'time.time_entry.updated',
            { type: 'time.time_entry', id: row.id, sequence: Number(row.version) + 1 },
            {
              duration_seconds: span?.seconds ?? row.duration_seconds,
              billable: billable ?? row.billable,
            },
            target.brandId,
          );
        }
        this.d.metrics.count('time.entries', 1, { source: row.source, outcome: 'updated' });
        return {
          status: 200,
          ref: { id: row.public_id, type: 'time_entry' },
          data: await this.entryView(tx, p, row.public_id),
        };
      },
      (tx, p, ref) => this.entryView(tx, p, ref.id),
    );
  }

  /**
   * Deletes the caller's own entry (`If-Match`). A live timer may be discarded even when its work
   * is no longer readable, so revocation never strands a person with a timer they cannot stop.
   */
  async deleteEntry(caller: Caller, ws: unknown, te: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'time.entry_delete',
      ws,
      req,
      async (tx, p) => {
        const expected = parseIfMatch(req.ifMatch);
        await this.lockPerson(tx, p.membershipId);
        const row = await this.ownEntry(tx, p, te);
        if (row.state === 'stopped') await this.targetOfRow(tx, p, row);
        requireVersion(expected, Number(row.version));
        await this.requireOpenDay(tx, p.membershipId, row.brand_id, row.work_date);
        await tx.db.deleteFrom('timetrack.time_entry').where('id', '=', row.id).execute();
        await this.timeAudit(
          tx,
          caller,
          p,
          'time.entry_deleted',
          { id: row.id, type: 'time_entry', publicId: row.public_id },
          [
            change.plain('work_date', row.work_date, null),
            change.plain('duration_seconds', row.duration_seconds, null),
          ],
          row.brand_id,
        );
        await this.timeEvent(
          tx,
          caller,
          p,
          'time.time_entry.deleted',
          { type: 'time.time_entry', id: row.id, sequence: Number(row.version) + 1 },
          { duration_seconds: row.duration_seconds },
          row.brand_id,
        );
        this.d.metrics.count('time.entries', 1, { source: row.source, outcome: 'deleted' });
        return {
          status: 200,
          ref: { id: row.public_id, type: 'time_entry' },
          data: { id: row.public_id, type: 'time_entry' as const, deleted: true },
        };
      },
      (_tx, _p, ref) => Promise.resolve({ id: ref.id, type: 'time_entry' as const, deleted: true }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Timers (TSK-025): start, pause, resume, stop; idempotent by state; recoverable after refresh
  // ---------------------------------------------------------------------------------------------

  protected async liveTimer(tx: WorkspaceTransaction, membershipId: string, lock = false) {
    let q = tx.db
      .selectFrom('timetrack.time_entry')
      .selectAll()
      .where('membership_id', '=', membershipId)
      .where('state', 'in', ['running', 'paused']);
    if (lock) q = q.forUpdate();
    return (await q.executeTakeFirst()) as EntryRow | undefined;
  }

  /**
   * Closes the open segment at `at` (never before the segment began; a stop in the first second
   * closes it with zero length), capped so the timer never exceeds TIME_ENTRY_MAX_HOURS. Returns
   * the closed seconds total.
   */
  protected async closeSegment(
    tx: WorkspaceTransaction,
    row: EntryRow,
    at: Date,
    cap: number,
  ): Promise<{ total: number; capped: boolean; end: Date }> {
    const open = await tx.db
      .selectFrom('timetrack.time_segment')
      .select(['id', 'started_at'])
      .where('entry_id', '=', row.id)
      .where('ended_at', 'is', null)
      .executeTakeFirstOrThrow();
    const start = new Date(open.started_at);
    const room = cap - Number(row.duration_seconds);
    let end = at.getTime() < start.getTime() ? start : at;
    let capped = false;
    if (secondsBetween(start, end) > room) {
      end = new Date(start.getTime() + Math.max(room, 0) * 1000);
      capped = true;
    }
    await tx.db
      .updateTable('timetrack.time_segment')
      .set({ ended_at: end })
      .where('id', '=', open.id)
      .execute();
    return { total: Number(row.duration_seconds) + secondsBetween(start, end), capped, end };
  }

  async getTimer(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const row = await this.liveTimer(tx, p.membershipId);
      return {
        timer: row ? await this.entryView(tx, p, row.public_id) : null,
        server_now: new Date().toISOString(),
        max_seconds: this.maxEntrySeconds,
      };
    });
  }

  /**
   * Starts a timer on readable work. With a live timer already running, `replace: true` stops it
   * first (at the same instant); otherwise the request is a `timer_running` conflict. `at` lets an
   * offline client record when the person pressed start.
   */
  async startTimer(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const billable = this.parseBillable(b.billable) ?? false;
    const note = this.parseNote(b.note) ?? '';
    return this.mutate(
      caller,
      'time.timer_start',
      ws,
      req,
      async (tx, p) => {
        const now = new Date();
        const at = this.parseAt(b.at, now);
        await this.lockPerson(tx, p.membershipId);
        const target = await this.loggableTarget(tx, p, b.target);
        const zone = this.zoneInput(b.tz) ?? (await this.personZone(tx, p.membershipId));
        const live = await this.liveTimer(tx, p.membershipId, true);
        if (live) {
          if (b.replace !== true)
            throw new TenancyError('conflict', {
              issues: [issue('/', 'timer_running', 'A timer is already running. Stop it first.')],
            });
          await this.finishTimer(tx, caller, p, live, at);
        }
        const start = at;
        const day = localDay(start, zone);
        await this.requireOpenDay(tx, p.membershipId, target.brandId, day);
        await this.requireNoOverlap(tx, p.membershipId, start, null, null);
        const e = await this.insertEntry(tx, p, target, {
          source: 'timer',
          state: 'running',
          span: { kind: 'open', start, day },
          tz: zone,
          billable,
          note,
        });
        await this.timeAudit(
          tx,
          caller,
          p,
          'time.timer_started',
          { id: e.id, type: 'time_entry', publicId: e.publicId },
          [change.plain('target', null, target.publicId), change.plain('billable', null, billable)],
          target.brandId,
        );
        this.d.metrics.count('time.timers', 1, { action: 'start', outcome: 'ok' });
        return {
          status: 201,
          ref: { id: e.publicId, type: 'time_entry' },
          data: await this.entryView(tx, p, e.publicId),
        };
      },
      (tx, p, ref) => this.entryView(tx, p, ref.id),
    );
  }

  /** Stops a live timer at `at`, records the entry, and returns its final seconds. */
  protected async finishTimer(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    row: EntryRow,
    at: Date,
  ) {
    let total = Number(row.duration_seconds);
    let capped = false;
    let end: Date;
    if (row.state === 'running') {
      const c = await this.closeSegment(tx, row, at, this.maxEntrySeconds);
      total = c.total;
      capped = c.capped;
      end = c.end;
    } else {
      const last = await tx.db
        .selectFrom('timetrack.time_segment')
        .select((eb) => eb.fn.max('ended_at').as('end'))
        .where('entry_id', '=', row.id)
        .executeTakeFirstOrThrow();
      end = new Date(last.end as Date);
    }
    await tx.db
      .updateTable('timetrack.time_entry')
      .set({
        state: 'stopped',
        ended_at: end,
        duration_seconds: total,
        updated_at: new Date(),
        version: Number(row.version) + 1,
      })
      .where('id', '=', row.id)
      .execute();
    await this.timeAudit(
      tx,
      caller,
      p,
      'time.timer_stopped',
      { id: row.id, type: 'time_entry', publicId: row.public_id },
      [
        change.plain('duration_seconds', null, total),
        ...(capped ? [change.plain('capped', null, true)] : []),
      ],
      row.brand_id,
    );
    await this.timeEvent(
      tx,
      caller,
      p,
      'time.time_entry.recorded',
      { type: 'time.time_entry', id: row.id, sequence: Number(row.version) + 1 },
      { duration_seconds: total, billable: row.billable, source: 'timer' },
      row.brand_id,
    );
    this.d.metrics.count('time.timers', 1, { action: 'stop', outcome: capped ? 'capped' : 'ok' });
    return { total, end };
  }

  /**
   * Pause, resume, and stop. Each is idempotent by state: pausing a paused timer, resuming a
   * running one, and stopping a stopped one change nothing and return the current entry, so a
   * retried or replayed offline action is harmless. Pause and stop work on the person's own timer
   * even if its work became unreadable; resume needs `time.log_own` again.
   */
  async timerAction(
    caller: Caller,
    ws: unknown,
    te: unknown,
    action: 'pause' | 'resume' | 'stop',
    body: unknown,
    req: Mutation,
  ) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      `time.timer_${action}`,
      ws,
      req,
      async (tx, p) => {
        const now = new Date();
        const at = this.parseAt(b.at, now);
        await this.lockPerson(tx, p.membershipId);
        const row = await this.ownEntry(tx, p, te);
        if (row.source !== 'timer')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'not_a_timer', 'This entry is not a timer.')],
          });
        const noop =
          (action === 'pause' && row.state !== 'running') ||
          (action === 'resume' && row.state === 'running') ||
          (action === 'stop' && row.state === 'stopped');
        if (action === 'resume' && row.state === 'stopped')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'timer_stopped', 'This timer is stopped. Start a new one.')],
          });
        if (!noop) {
          await this.requireOpenDay(tx, p.membershipId, row.brand_id, row.work_date);
          if (action === 'pause') {
            const c = await this.closeSegment(tx, row, at, this.maxEntrySeconds);
            if (c.capped) {
              // The timer reached its limit while running: pausing it now records it, stopped.
              await this.finishTimer(
                tx,
                caller,
                p,
                { ...row, state: 'paused', duration_seconds: c.total },
                c.end,
              );
              action = 'stop';
            } else
              await tx.db
                .updateTable('timetrack.time_entry')
                .set({
                  state: 'paused',
                  duration_seconds: c.total,
                  updated_at: new Date(),
                  version: Number(row.version) + 1,
                })
                .where('id', '=', row.id)
                .execute();
          } else if (action === 'resume') {
            await this.targetOfRow(tx, p, row);
            if (Number(row.duration_seconds) >= this.maxEntrySeconds)
              throw new TenancyError('conflict', {
                issues: [
                  issue(
                    '/',
                    'timer_full',
                    `A timer can run at most ${this.ws.timeEntryMaxHours} hours.`,
                  ),
                ],
              });
            const last = await tx.db
              .selectFrom('timetrack.time_segment')
              .select((eb) => eb.fn.max('ended_at').as('end'))
              .where('entry_id', '=', row.id)
              .executeTakeFirstOrThrow();
            const floor = new Date(last.end as Date);
            const start = at.getTime() < floor.getTime() ? floor : at;
            await this.requireNoOverlap(tx, p.membershipId, start, null, row.id);
            await tx.db
              .insertInto('timetrack.time_segment')
              .values({
                id: newUuidV7(),
                workspace_id: tx.workspaceId,
                entry_id: row.id,
                membership_id: p.membershipId,
                started_at: start,
                ended_at: null,
              })
              .execute();
            await tx.db
              .updateTable('timetrack.time_entry')
              .set({ state: 'running', updated_at: new Date(), version: Number(row.version) + 1 })
              .where('id', '=', row.id)
              .execute();
          } else {
            await this.finishTimer(tx, caller, p, row, at);
          }
          if (action !== 'stop')
            await this.timeAudit(
              tx,
              caller,
              p,
              `time.timer_${action === 'pause' ? 'paused' : 'resumed'}`,
              { id: row.id, type: 'time_entry', publicId: row.public_id },
              [change.plain('state', row.state, action === 'pause' ? 'paused' : 'running')],
              row.brand_id,
            );
        }
        this.d.metrics.count('time.timers', 1, { action, outcome: noop ? 'noop' : 'ok' });
        return {
          status: 200,
          ref: { id: row.public_id, type: 'time_entry' },
          data: await this.entryView(tx, p, row.public_id, { own: true }),
        };
      },
      (tx, p, ref) => this.entryView(tx, p, ref.id, { own: true }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Reading entries
  // ---------------------------------------------------------------------------------------------

  protected parseRange(q: Record<string, unknown>, fallbackDay: string) {
    const to = q.to === undefined ? fallbackDay : validDay(q.to);
    const from = q.from === undefined ? (to ? addDays(to, -6) : null) : validDay(q.from);
    if (!from) throw invalid(issue('/from', 'invalid', 'Choose a valid start date.'));
    if (!to) throw invalid(issue('/to', 'invalid', 'Choose a valid end date.'));
    if (to < from) throw invalid(issue('/to', 'before_start', 'The end date is before the start.'));
    if (daysBetween(from, to) + 1 > this.ws.timeReportRangeDaysMax)
      throw invalid(
        issue('/to', 'too_wide', `Choose at most ${this.ws.timeReportRangeDaysMax} days.`),
      );
    return { from, to };
  }

  /** Narrowing filters shared by lists, reports, and exports (they only ever narrow). */
  protected async filters(
    tx: WorkspaceTransaction,
    p: Principal,
    q: Record<string, unknown>,
  ): Promise<RawBuilder<boolean>[]> {
    const out: RawBuilder<boolean>[] = [];
    const brands = typeof q.brands === 'string' ? q.brands.split(',').filter(Boolean) : [];
    if (typeof q.brand === 'string') brands.push(q.brand);
    if (brands.length) {
      const ids: string[] = [];
      for (const b of brands.slice(0, 50)) ids.push((await findBrand(tx, p, b)).id);
      out.push(sql<boolean>`e.brand_id = ANY(${ids}::uuid[])`);
    }
    if (q.member === 'me') out.push(sql<boolean>`e.membership_id = ${p.membershipId}::uuid`);
    else if (typeof q.member === 'string') {
      const m = await tx.db
        .selectFrom('tenancy.membership')
        .select('id')
        .where('public_id', '=', q.member)
        .executeTakeFirst();
      out.push(
        sql<boolean>`e.membership_id = ${m?.id ?? '00000000-0000-7000-8000-000000000000'}::uuid`,
      );
    }
    if (typeof q.target === 'string') {
      const rec = await tx.db
        .selectFrom('core.record')
        .select(['id', 'record_type'])
        .where('public_id', '=', q.target)
        .executeTakeFirst();
      const id = rec?.id ?? '00000000-0000-7000-8000-000000000000';
      out.push(
        rec?.record_type === 'project' && q.include_tasks !== 'false'
          ? sql<boolean>`(e.project_id = ${id}::uuid OR tk.project_id = ${id}::uuid)`
          : sql<boolean>`(e.task_id = ${id}::uuid OR e.project_id = ${id}::uuid)`,
      );
    }
    if (q.billable === 'billable') out.push(sql<boolean>`e.billable`);
    if (q.billable === 'non_billable') out.push(sql<boolean>`NOT e.billable`);
    return out;
  }

  /**
   * Entries the caller may read, newest first, keyset paged. Filters: date range, brands, member
   * (`me` or a member ID), target (a task, or a project with its tasks), billable.
   */
  async listEntries(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const limit = Math.min(
      this.ws.pageLimitMax,
      Math.max(1, Number(query.limit) || this.ws.pageLimitDefault),
    );
    let after: { d: string; s: string | null; i: string } | null = null;
    if (typeof query.cursor === 'string') {
      try {
        const c = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
        if (!validDay(c.d) || !/^[0-9a-f-]{36}$/.test(c.i) || (c.s !== null && !parseInstant(c.s)))
          throw new Error('cursor');
        after = c;
      } catch {
        throw new TenancyError('cursor_invalid');
      }
    }
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const zone = await this.personZone(tx, p.membershipId);
      const ranged = query.from !== undefined || query.to !== undefined;
      const range = ranged ? this.parseRange(query, localDay(new Date(), zone)) : null;
      const vis = await this.entryPredicate(tx, p);
      const parts = [vis, ...(await this.filters(tx, p, query))];
      if (range)
        parts.push(sql<boolean>`e.work_date BETWEEN ${range.from}::date AND ${range.to}::date`);
      if (after)
        parts.push(
          sql<boolean>`(e.work_date, coalesce(e.started_at, '-infinity'::timestamptz), e.id) <
            (${after.d}::date, coalesce(${after.s}::timestamptz, '-infinity'::timestamptz), ${after.i}::uuid)`,
        );
      const rows = await this.entryRows(tx, sql.join(parts, sql` AND `) as RawBuilder<boolean>, {
        limit: limit + 1,
        visible: vis,
        loggable: await this.loggablePredicate(tx, p),
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        data: await this.views(tx, p, page),
        page: {
          limit,
          has_more: rows.length > limit,
          ...(rows.length > limit && last
            ? {
                next_cursor: Buffer.from(
                  JSON.stringify({
                    d: String(last.work_date).slice(0, 10),
                    s: iso(last.started_at),
                    i: last.id,
                  }),
                ).toString('base64url'),
              }
            : {}),
        },
      };
    });
  }

  async getEntry(caller: Caller, ws: unknown, te: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, (tx, p) =>
      this.entryView(tx, p, isPublic(te, 'te') ? te : 'te_0'),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Timesheets (TIME-012, TIME-013; OD-20 self-approval, OD-26 unlock)
  // ---------------------------------------------------------------------------------------------

  /** The person's sheet containing `day`, or the computed period for it (no row yet). */
  protected async sheetFor(
    tx: WorkspaceTransaction,
    membershipId: string,
    day: string,
    weekStart: number,
    lock = false,
  ) {
    let q = tx.db
      .selectFrom('timetrack.timesheet')
      .selectAll()
      .where('membership_id', '=', membershipId)
      .where('period_start', '<=', day)
      .where('period_end', '>=', day);
    if (lock) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    const period = row
      ? { start: String(row.period_start).slice(0, 10), end: String(row.period_end).slice(0, 10) }
      : periodOf(day, weekStart);
    return { row, period };
  }

  /** The person's own readable entries in a period, grouped per brand (submission snapshot). */
  protected async periodTotals(
    tx: WorkspaceTransaction,
    p: Principal,
    membershipId: string,
    period: { start: string; end: string },
    brandIds?: string[],
  ) {
    const vis = await this.entryPredicate(tx, p);
    const rows = await sql<{
      public_id: string;
      brand_id: string;
      duration_seconds: number;
      billable: boolean;
      version: string;
      state: string;
      visible: boolean;
    }>`SELECT e.public_id, e.brand_id, e.duration_seconds, e.billable, e.version, e.state, ${vis} AS visible
        FROM ${ENTRY_FROM}
       WHERE e.membership_id = ${membershipId}::uuid
         AND e.work_date BETWEEN ${period.start}::date AND ${period.end}::date
         ${brandIds ? sql`AND e.brand_id = ANY(${brandIds}::uuid[])` : sql``}
       LIMIT ${this.ws.timeTimesheetEntriesMax + 1}`.execute(tx.db);
    if (rows.rows.length > this.ws.timeTimesheetEntriesMax)
      throw invalid(
        issue(
          '/period_start',
          'too_many',
          `A week can hold at most ${this.ws.timeTimesheetEntriesMax} entries.`,
        ),
      );
    const byBrand = new Map<
      string,
      {
        seconds: number;
        billable: number;
        entries: number;
        hidden: number;
        live: number;
        rows: Array<{
          public_id: string;
          duration_seconds: number;
          billable: boolean;
          version: number;
        }>;
      }
    >();
    for (const r of rows.rows) {
      const g = byBrand.get(r.brand_id) ?? {
        seconds: 0,
        billable: 0,
        entries: 0,
        hidden: 0,
        live: 0,
        rows: [],
      };
      if (!r.visible) g.hidden++;
      else {
        if (r.state !== 'stopped') g.live++;
        g.seconds += Number(r.duration_seconds);
        if (r.billable) g.billable += Number(r.duration_seconds);
        g.entries++;
        g.rows.push({
          public_id: r.public_id,
          duration_seconds: Number(r.duration_seconds),
          billable: r.billable,
          version: Number(r.version),
        });
      }
      byBrand.set(r.brand_id, g);
    }
    return byBrand;
  }

  protected async linesOf(tx: WorkspaceTransaction, sheetId: string) {
    return tx.db
      .selectFrom('timetrack.timesheet_line')
      .selectAll()
      .where('timesheet_id', '=', sheetId)
      .execute();
  }

  /** The person's period: entries, per-day and per-brand totals, lines, and what they may do. */
  async timesheetPeriod(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const zone = await this.personZone(tx, p.membershipId);
      const cal = await this.workspaceCalendar(tx);
      const today = localDay(new Date(), zone);
      const day = query.date === undefined ? today : validDay(query.date);
      if (!day) throw invalid(issue('/date', 'invalid', 'Choose a valid date.'));
      const { row, period } = await this.sheetFor(tx, p.membershipId, day, cal.weekStart);
      const vis = await this.entryPredicate(tx, p);
      const entryRows = await this.entryRows(
        tx,
        sql<boolean>`${vis} AND e.membership_id = ${p.membershipId}::uuid
          AND e.work_date BETWEEN ${period.start}::date AND ${period.end}::date`,
        {
          limit: this.ws.timeTimesheetEntriesMax,
          order: 'asc',
          visible: vis,
          loggable: await this.loggablePredicate(tx, p),
        },
      );
      const entries = await this.views(tx, p, entryRows);
      const days = Array.from({ length: 7 }, (_, i) => addDays(period.start, i)).map((d) => ({
        date: d,
        seconds: entries
          .filter((e) => e.work_date === d)
          .reduce((s, e) => s + e.duration_seconds, 0),
      }));
      const totals = entries.reduce(
        (t, e) => ({
          seconds: t.seconds + e.duration_seconds,
          billable_seconds: t.billable_seconds + (e.billable ? e.duration_seconds : 0),
        }),
        { seconds: 0, billable_seconds: 0 },
      );
      const lines = row ? await this.lineViews(tx, p, row.id, true) : [];
      const brandIds = new Set(entryRows.map((r) => r.brand_id));
      const brandsWithLines = new Set(lines.map((l) => l.brand.id));
      const brands = await this.brandRows(tx, [...brandIds]);
      for (const b of brands)
        if (!brandsWithLines.has(b.public_id))
          lines.push({
            brand: { id: b.public_id, name: b.name },
            state: null,
            submitted: null,
            decisions: [],
            locks: [],
            locked: false,
            can_approve: false,
            can_unlock: false,
          });
      const state = row?.state ?? 'open';
      const live = entries.some((e) => e.state !== 'stopped');
      const unlocked = lines.some(
        (l) =>
          l.state === null ||
          l.state === 'rejected' ||
          l.state === 'withdrawn' ||
          l.state === 'unlocked',
      );
      return {
        period,
        week_start: cal.weekStart,
        today,
        timesheet: row
          ? {
              id: row.public_id,
              state: row.state,
              version: Number(row.version),
              submitted_at: iso(row.submitted_at),
            }
          : null,
        lines,
        days: days.map((d) => ({ ...d, hours: hoursOf(d.seconds) })),
        totals: {
          ...totals,
          non_billable_seconds: totals.seconds - totals.billable_seconds,
          hours: hoursOf(totals.seconds),
        },
        entries,
        has_live_timer: live,
        can_submit:
          p.kind === 'member' && state === 'open' && !live && unlocked && entries.length > 0,
        can_withdraw: state === 'submitted',
      };
    });
  }

  protected async lineViews(
    tx: WorkspaceTransaction,
    p: Principal,
    sheetId: string,
    owner: boolean,
  ) {
    const lines = await this.linesOf(tx, sheetId);
    const brands = new Map(
      (
        await this.brandRows(
          tx,
          lines.map((l) => l.brand_id),
        )
      ).map((b) => [b.id, b]),
    );
    const decisions = await tx.db
      .selectFrom('timetrack.timesheet_approval as d')
      .innerJoin('tenancy.membership as m', 'm.id', 'd.decided_by_membership_id')
      .innerJoin('identity.account as a', 'a.id', 'm.account_id')
      .select([
        'd.line_id',
        'd.decision',
        'd.self_approval',
        'd.created_at',
        'd.total_seconds',
        'm.public_id',
        sql<string>`coalesce(m.display_name_override, a.display_name)`.as('name'),
      ])
      .where('d.timesheet_id', '=', sheetId)
      .orderBy('d.created_at')
      .execute();
    const sheet = await tx.db
      .selectFrom('timetrack.timesheet')
      .select(['membership_id', 'period_start'])
      .where('id', '=', sheetId)
      .executeTakeFirstOrThrow();
    const locks = await tx.db
      .selectFrom('timetrack.period_lock as l')
      .innerJoin('tenancy.membership as m', 'm.id', 'l.by_membership_id')
      .innerJoin('identity.account as a', 'a.id', 'm.account_id')
      .select([
        'l.brand_id',
        'l.action',
        'l.reason',
        'l.created_at',
        'm.public_id',
        sql<string>`coalesce(m.display_name_override, a.display_name)`.as('name'),
      ])
      .where('l.membership_id', '=', sheet.membership_id)
      .where('l.period_start', '=', sheet.period_start)
      .orderBy('l.created_at')
      .orderBy('l.id')
      .execute();
    const out = [];
    for (const l of lines) {
      const b = brands.get(l.brand_id);
      if (!b) continue;
      const facts = this.brandFacts(b);
      const approve = decideBrand(p, 'timesheet.approve', facts).allowed && p.kind === 'member';
      const unlock = decideBrand(p, 'timesheet.unlock', facts).allowed && p.kind === 'member';
      if (!owner && !approve && !unlock) continue;
      const ls = locks.filter((x) => x.brand_id === l.brand_id);
      out.push({
        brand: { id: b.public_id, name: b.name },
        state: l.state as string | null,
        submitted: {
          seconds: l.submitted_seconds,
          billable_seconds: l.submitted_billable_seconds,
          entries: l.submitted_entries,
          hours: hoursOf(l.submitted_seconds),
        } as { seconds: number; billable_seconds: number; entries: number; hours: number } | null,
        decisions: decisions
          .filter((d) => d.line_id === l.id)
          .map((d) => ({
            decision: d.decision,
            by: { id: d.public_id, name: d.name },
            at: iso(d.created_at)!,
            self_approval: d.self_approval,
            total_seconds: d.total_seconds,
          })),
        // Unlock reasons are shown to the period's owner and to admins who may unlock.
        locks: ls.map((x) => ({
          action: x.action,
          by: { id: x.public_id, name: x.name },
          at: iso(x.created_at)!,
          ...(x.action === 'unlock' && (owner || unlock) ? { reason: x.reason } : {}),
        })),
        locked: ls.at(-1)?.action === 'lock',
        can_approve: approve,
        can_unlock: unlock && ls.at(-1)?.action === 'lock',
      });
    }
    return out;
  }

  /** A timesheet: its owner sees everything; approvers and admins see only their brands' lines. */
  protected async sheetView(tx: WorkspaceTransaction, p: Principal, tsh: unknown) {
    const row = await tx.db
      .selectFrom('timetrack.timesheet as s')
      .innerJoin('tenancy.membership as m', 'm.id', 's.membership_id')
      .innerJoin('identity.account as a', 'a.id', 'm.account_id')
      .selectAll('s')
      .select([
        'm.public_id as person_public_id',
        sql<string>`coalesce(m.display_name_override, a.display_name)`.as('person_name'),
      ])
      .where('s.public_id', '=', isPublic(tsh, 'tsh') ? tsh : 'tsh_0')
      .executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    const owner = row.membership_id === p.membershipId;
    const lines = await this.lineViews(tx, p, row.id, owner);
    if (!owner && !lines.length) throw new TenancyError('not_found');
    const vis = await this.entryPredicate(tx, p);
    const brandIds = owner
      ? null
      : (await this.brandRows(tx))
          .filter((b) => lines.some((l) => l.brand.id === b.public_id))
          .map((b) => b.id);
    const entryRows = await this.entryRows(
      tx,
      sql<boolean>`${vis} AND e.membership_id = ${row.membership_id}::uuid
        AND e.work_date BETWEEN ${row.period_start}::date AND ${row.period_end}::date
        ${brandIds ? sql`AND e.brand_id = ANY(${brandIds}::uuid[])` : sql``}`,
      {
        limit: this.ws.timeTimesheetEntriesMax,
        order: 'asc',
        visible: vis,
        loggable: await this.loggablePredicate(tx, p),
      },
    );
    const selfOk = owner ? await this.selfApprovalAllowed(tx, p) : false;
    return {
      id: row.public_id,
      type: 'timesheet' as const,
      person: { id: row.person_public_id, name: row.person_name },
      period: {
        start: String(row.period_start).slice(0, 10),
        end: String(row.period_end).slice(0, 10),
      },
      state: row.state,
      submitted_at: iso(row.submitted_at),
      own: owner,
      lines: lines.map((l) => ({
        ...l,
        // OD-20: a person decides their own line only while self-approval is allowed.
        can_approve: l.can_approve && l.state === 'pending' && (!owner || selfOk),
        self_approval: owner && l.can_approve,
      })),
      entries: await this.views(tx, p, entryRows),
      version: Number(row.version),
      updated_at: iso(row.updated_at)!,
    };
  }

  async getTimesheet(caller: Caller, ws: unknown, tsh: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, (tx, p) => this.sheetView(tx, p, tsh));
  }

  /**
   * Submits the caller's period: one pending line per brand with readable time that is not already
   * approved. A live timer in the period must be stopped first. While submitted, the person's time
   * in the period cannot change (the database guard enforces it).
   */
  async submitTimesheet(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'time.timesheet_submit',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'timesheet.submit_own');
        const start = validDay(b.period_start);
        if (!start) throw invalid(issue('/period_start', 'invalid', 'Choose the week to submit.'));
        await this.lockPerson(tx, p.membershipId);
        const cal = await this.workspaceCalendar(tx);
        const found = await this.sheetFor(tx, p.membershipId, start, cal.weekStart, true);
        if (found.period.start !== start)
          throw invalid(
            issue('/period_start', 'not_period_start', 'Choose the first day of the week.'),
          );
        let sheet = found.row;
        if (sheet?.state === 'submitted' || sheet?.state === 'approved')
          throw new TenancyError('conflict', {
            issues: [issue('/', `already_${sheet.state}`, `This week is already ${sheet.state}.`)],
          });
        if (sheet && b.version !== undefined && Number(b.version) !== Number(sheet.version))
          throw new TenancyError('conflict', {
            conflict: { current_version: Number(sheet.version) },
          });
        const totals = await this.periodTotals(tx, p, p.membershipId, found.period);
        if ([...totals.values()].some((g) => g.live))
          throw new TenancyError('conflict', {
            issues: [
              issue('/', 'timer_live', 'Stop the running timer before submitting this week.'),
            ],
          });
        if (!sheet) {
          const id = newUuidV7();
          await tx.db
            .insertInto('timetrack.timesheet')
            .values({
              id,
              public_id: newPublicId('tsh'),
              workspace_id: tx.workspaceId,
              membership_id: p.membershipId,
              period_start: found.period.start,
              period_end: found.period.end,
            })
            .execute();
          sheet = await tx.db
            .selectFrom('timetrack.timesheet')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
        }
        const s = sheet!;
        const existing = new Map((await this.linesOf(tx, s.id)).map((l) => [l.brand_id, l]));
        let pending = 0;
        for (const [brandId, g] of totals) {
          const line = existing.get(brandId);
          if (line?.state === 'approved') continue;
          if (!g.entries) continue;
          const values = {
            state: 'pending' as const,
            submitted_seconds: g.seconds,
            submitted_billable_seconds: g.billable,
            submitted_entries: g.entries,
            submitted_hash: entriesHash(g.rows),
          };
          if (line)
            await tx.db
              .updateTable('timetrack.timesheet_line')
              .set({ ...values, updated_at: new Date(), version: Number(line.version) + 1 })
              .where('id', '=', line.id)
              .execute();
          else
            await tx.db
              .insertInto('timetrack.timesheet_line')
              .values({
                id: newUuidV7(),
                workspace_id: tx.workspaceId,
                timesheet_id: s.id,
                brand_id: brandId,
                ...values,
              })
              .execute();
          pending++;
        }
        // A brand whose time was all removed after a rejection or unlock has nothing to approve.
        for (const [brandId, line] of existing)
          if (line.state !== 'approved' && !(totals.get(brandId)?.entries ?? 0))
            await tx.db
              .updateTable('timetrack.timesheet_line')
              .set({
                state: 'withdrawn',
                updated_at: new Date(),
                version: Number(line.version) + 1,
              })
              .where('id', '=', line.id)
              .execute();
        if (!pending)
          throw invalid(
            issue(
              '/period_start',
              'nothing_to_submit',
              'There is no time to submit for this week.',
            ),
          );
        await tx.db
          .updateTable('timetrack.timesheet')
          .set({
            state: 'submitted',
            submitted_at: new Date(),
            updated_at: new Date(),
            version: Number(s.version) + 1,
          })
          .where('id', '=', s.id)
          .execute();
        await this.timeAudit(
          tx,
          caller,
          p,
          'timesheet.submitted',
          { id: s.id, type: 'timesheet', publicId: s.public_id },
          [
            change.plain('period_start', null, found.period.start),
            change.plain('lines', null, pending),
          ],
          null,
        );
        await this.timeEvent(
          tx,
          caller,
          p,
          'time.timesheet.submitted',
          { type: 'time.timesheet', id: s.id, sequence: Number(s.version) + 1 },
          { period_start: found.period.start, lines: pending },
          null,
        );
        this.d.metrics.count('time.timesheets', 1, { action: 'submit', outcome: 'ok' });
        return {
          status: 200,
          ref: { id: s.public_id, type: 'timesheet' },
          data: await this.sheetView(tx, p, s.public_id),
        };
      },
      (tx, p, ref) => this.sheetView(tx, p, ref.id),
    );
  }

  /** The owner withdraws a submitted period: undecided lines return to them for changes. */
  async withdrawTimesheet(caller: Caller, ws: unknown, tsh: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'time.timesheet_withdraw',
      ws,
      req,
      async (tx, p) => {
        const expected = parseIfMatch(req.ifMatch);
        await this.lockPerson(tx, p.membershipId);
        const s = await tx.db
          .selectFrom('timetrack.timesheet')
          .selectAll()
          .where('public_id', '=', isPublic(tsh, 'tsh') ? tsh : 'tsh_0')
          .where('membership_id', '=', p.membershipId)
          .forUpdate()
          .executeTakeFirst();
        if (!s) throw new TenancyError('not_found');
        requireVersion(expected, Number(s.version));
        if (s.state !== 'submitted')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'not_submitted', 'This week is not waiting for approval.')],
          });
        await tx.db
          .updateTable('timetrack.timesheet_line')
          .set({ state: 'withdrawn', updated_at: new Date(), version: sql`version + 1` as never })
          .where('timesheet_id', '=', s.id)
          .where('state', '=', 'pending')
          .execute();
        await this.settleSheet(tx, s.id, Number(s.version));
        await this.timeAudit(
          tx,
          caller,
          p,
          'timesheet.withdrawn',
          { id: s.id, type: 'timesheet', publicId: s.public_id },
          [change.plain('state', 'submitted', 'open')],
          null,
        );
        await this.timeEvent(
          tx,
          caller,
          p,
          'time.timesheet.withdrawn',
          { type: 'time.timesheet', id: s.id, sequence: Number(s.version) + 1 },
          { period_start: String(s.period_start).slice(0, 10) },
          null,
        );
        this.d.metrics.count('time.timesheets', 1, { action: 'withdraw', outcome: 'ok' });
        return {
          status: 200,
          ref: { id: s.public_id, type: 'timesheet' },
          data: await this.sheetView(tx, p, s.public_id),
        };
      },
      (tx, p, ref) => this.sheetView(tx, p, ref.id),
    );
  }

  /**
   * After a line changes: with pending lines the sheet stays submitted; otherwise it is approved
   * when every remaining line is approved, else open again (returned for changes).
   */
  protected async settleSheet(tx: WorkspaceTransaction, sheetId: string, version: number) {
    const lines = await this.linesOf(tx, sheetId);
    const pending = lines.some((l) => l.state === 'pending');
    const live = lines.filter((l) => l.state !== 'withdrawn');
    const state = pending
      ? 'submitted'
      : live.length > 0 && live.every((l) => l.state === 'approved')
        ? 'approved'
        : 'open';
    await tx.db
      .updateTable('timetrack.timesheet')
      .set({ state, updated_at: new Date(), version: version + 1 })
      .where('id', '=', sheetId)
      .execute();
    return state;
  }

  /**
   * Approves or rejects one brand line of a submitted period (`timesheet.approve`, manage in that
   * brand, decided now). The approver must be able to read every entry in the line; a person
   * decides their own line only while self-approval is allowed (OD-20), and it is labelled.
   * Approval records the exact entries (hash and totals) and locks the period for that brand.
   */
  async decideTimesheet(caller: Caller, ws: unknown, tsh: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const decision = b.decision === 'approve' || b.decision === 'reject' ? b.decision : null;
    if (!decision) throw invalid(issue('/decision', 'invalid', 'Approve or reject.'));
    const note = this.parseNote(b.note) ?? '';
    if (decision === 'reject' && note.length < 3)
      throw invalid(issue('/note', 'required', 'Say what needs to change.'));
    return this.mutate(
      caller,
      `time.timesheet_${decision}`,
      ws,
      req,
      async (tx, p) => {
        const expected = parseIfMatch(req.ifMatch);
        const peek = await tx.db
          .selectFrom('timetrack.timesheet')
          .select(['membership_id'])
          .where('public_id', '=', isPublic(tsh, 'tsh') ? tsh : 'tsh_0')
          .executeTakeFirst();
        if (!peek) throw new TenancyError('not_found');
        await this.lockPerson(tx, peek.membership_id);
        const s = await tx.db
          .selectFrom('timetrack.timesheet')
          .selectAll()
          .where('public_id', '=', tsh as string)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const brand = await findBrand(tx, p, b.brand);
        const facts = this.brandFacts(brand as never);
        const o = decideBrand(p, 'timesheet.approve', facts);
        this.decision('timesheet.approve', o);
        const own = s.membership_id === p.membershipId;
        if (!o.allowed || p.kind !== 'member')
          throw new TenancyError(own ? 'forbidden' : 'not_found');
        const line = await tx.db
          .selectFrom('timetrack.timesheet_line')
          .selectAll()
          .where('timesheet_id', '=', s.id)
          .where('brand_id', '=', brand.id)
          .forUpdate()
          .executeTakeFirst();
        if (!line) throw new TenancyError('not_found');
        requireVersion(expected, Number(s.version));
        if (own && !(await this.selfApprovalAllowed(tx, p)))
          throw new TenancyError('forbidden', {
            issues: [issue('/', 'self_approval', 'Someone else must decide your own timesheet.')],
          });
        if (line.state !== 'pending' || s.state !== 'submitted')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'not_pending', 'This line is not waiting for a decision.')],
          });
        const g = (
          await this.periodTotals(
            tx,
            p,
            s.membership_id,
            {
              start: String(s.period_start).slice(0, 10),
              end: String(s.period_end).slice(0, 10),
            },
            [brand.id],
          )
        ).get(brand.id) ?? {
          seconds: 0,
          billable: 0,
          entries: 0,
          hidden: 0,
          live: 0,
          rows: [],
        };
        if (g.hidden)
          throw new TenancyError('forbidden', {
            issues: [
              issue(
                '/',
                'incomplete_visibility',
                'Some of this time is on work you cannot see. Someone who can see all of it must decide.',
              ),
            ],
          });
        const hash = entriesHash(g.rows);
        if (hash !== line.submitted_hash)
          throw new TenancyError('conflict', {
            issues: [issue('/', 'stale', 'This time changed after it was submitted.')],
          });
        const approvalId = newUuidV7();
        await tx.db
          .insertInto('timetrack.timesheet_approval')
          .values({
            id: approvalId,
            workspace_id: tx.workspaceId,
            timesheet_id: s.id,
            line_id: line.id,
            brand_id: brand.id,
            membership_id: s.membership_id,
            period_start: s.period_start,
            period_end: s.period_end,
            decided_by_membership_id: p.membershipId,
            decision,
            self_approval: own,
            note_hash: note ? sha(note) : null,
            total_seconds: g.seconds,
            billable_seconds: g.billable,
            entry_count: g.entries,
            entries_hash: hash,
            timesheet_version: Number(s.version),
          })
          .execute();
        await tx.db
          .updateTable('timetrack.timesheet_line')
          .set({
            state: decision === 'approve' ? 'approved' : 'rejected',
            updated_at: new Date(),
            version: Number(line.version) + 1,
          })
          .where('id', '=', line.id)
          .execute();
        if (decision === 'approve')
          await tx.db
            .insertInto('timetrack.period_lock')
            .values({
              id: newUuidV7(),
              workspace_id: tx.workspaceId,
              brand_id: brand.id,
              membership_id: s.membership_id,
              period_start: s.period_start,
              period_end: s.period_end,
              action: 'lock',
              approval_id: approvalId,
              by_membership_id: p.membershipId,
            })
            .execute();
        const state = await this.settleSheet(tx, s.id, Number(s.version));
        await this.timeAudit(
          tx,
          caller,
          p,
          decision === 'approve' ? 'timesheet.approved' : 'timesheet.rejected',
          { id: s.id, type: 'timesheet', publicId: s.public_id },
          [
            change.plain('brand', null, brand.public_id),
            change.plain('decision', null, decision),
            change.plain('self_approval', null, own),
            change.plain('total_seconds', null, g.seconds),
            change.plain('sheet_state', s.state, state),
            ...(note ? [change.content('note', { hash: `sha256:${sha(note)}` })] : []),
          ],
          brand.id,
        );
        await this.timeEvent(
          tx,
          caller,
          p,
          decision === 'approve' ? 'time.timesheet.approved' : 'time.timesheet.rejected',
          { type: 'time.timesheet_approval', id: approvalId, sequence: 0 },
          { period_start: String(s.period_start).slice(0, 10), brand_id: brand.public_id },
          brand.id,
        );
        this.d.metrics.count('time.timesheets', 1, {
          action: decision,
          outcome: own ? 'self' : 'ok',
        });
        return {
          status: 200,
          ref: { id: s.public_id, type: 'timesheet' },
          data: await this.sheetView(tx, p, s.public_id),
        };
      },
      (tx, p, ref) => this.sheetView(tx, p, ref.id),
    );
  }

  /**
   * Unlocks one approved brand line (OD-26): workspace admins only (`timesheet.unlock`), with
   * step-up and a reason. Appends an `unlock` row (the approval stays as evidence); the person may
   * change that time again, and the line must be submitted and approved again.
   */
  async unlockTimesheet(caller: Caller, ws: unknown, tsh: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    if (reason.length < 3 || reason.length > 500)
      throw invalid(
        issue('/reason', 'required', 'Give a reason for unlocking (3–500 characters).'),
      );
    return this.mutate(
      caller,
      'time.timesheet_unlock',
      ws,
      req,
      async (tx, p) => {
        const expected = parseIfMatch(req.ifMatch);
        const peek = await tx.db
          .selectFrom('timetrack.timesheet')
          .select(['membership_id'])
          .where('public_id', '=', isPublic(tsh, 'tsh') ? tsh : 'tsh_0')
          .executeTakeFirst();
        if (!peek) throw new TenancyError('not_found');
        await this.lockPerson(tx, peek.membership_id);
        const s = await tx.db
          .selectFrom('timetrack.timesheet')
          .selectAll()
          .where('public_id', '=', tsh as string)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const brand = await findBrand(tx, p, b.brand);
        const o = decideBrand(p, 'timesheet.unlock', this.brandFacts(brand as never));
        this.decision('timesheet.unlock', o);
        if (!o.allowed || p.kind !== 'member')
          throw new TenancyError(s.membership_id === p.membershipId ? 'forbidden' : 'not_found');
        const line = await tx.db
          .selectFrom('timetrack.timesheet_line')
          .selectAll()
          .where('timesheet_id', '=', s.id)
          .where('brand_id', '=', brand.id)
          .forUpdate()
          .executeTakeFirst();
        if (!line) throw new TenancyError('not_found');
        requireVersion(expected, Number(s.version));
        if (line.state !== 'approved')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'not_locked', 'Only an approved, locked week can be unlocked.')],
          });
        const stepUpId = await this.stepUp(tx, caller, p, req, 'timesheet.unlock', {
          type: 'timesheet',
          id: s.public_id,
        });
        await tx.db
          .insertInto('timetrack.period_lock')
          .values({
            id: newUuidV7(),
            workspace_id: tx.workspaceId,
            brand_id: brand.id,
            membership_id: s.membership_id,
            period_start: s.period_start,
            period_end: s.period_end,
            action: 'unlock',
            reason,
            by_membership_id: p.membershipId,
            step_up_id: stepUpId,
          })
          .execute();
        await tx.db
          .updateTable('timetrack.timesheet_line')
          .set({ state: 'unlocked', updated_at: new Date(), version: Number(line.version) + 1 })
          .where('id', '=', line.id)
          .execute();
        const state = await this.settleSheet(tx, s.id, Number(s.version));
        await this.timeAudit(
          tx,
          caller,
          p,
          'timesheet.unlocked',
          { id: s.id, type: 'timesheet', publicId: s.public_id },
          [
            change.plain('brand', null, brand.public_id),
            change.plain('sheet_state', s.state, state),
            change.content('reason', { hash: `sha256:${sha(reason)}` }),
          ],
          brand.id,
        );
        await this.security(tx, caller, p, 'timesheet.unlock', { type: 'timesheet', id: s.id });
        await this.timeEvent(
          tx,
          caller,
          p,
          'time.timesheet.unlocked',
          { type: 'time.period_lock', id: s.id, sequence: Number(s.version) + 1 },
          { period_start: String(s.period_start).slice(0, 10), brand_id: brand.public_id },
          brand.id,
        );
        this.d.metrics.count('time.timesheets', 1, { action: 'unlock', outcome: 'ok' });
        return {
          status: 200,
          ref: { id: s.public_id, type: 'timesheet' },
          data: await this.sheetView(tx, p, s.public_id),
        };
      },
      (tx, p, ref) => this.sheetView(tx, p, ref.id),
    );
  }

  /**
   * The approval queue: submitted periods with pending lines in brands the caller may approve
   * (`state=pending`, default), or recently decided ones (`state=decided`). Periods are listed
   * only for brands the caller may decide; everything else about them stays hidden.
   */
  async listTimesheetApprovals(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      if (p.kind !== 'member') return { data: [] };
      const brands = (await this.brandRows(tx)).filter(
        (b) => decideBrand(p, 'timesheet.approve', this.brandFacts(b)).allowed,
      );
      if (!brands.length) return { data: [] };
      const decided = query.state === 'decided';
      const rows = await tx.db
        .selectFrom('timetrack.timesheet_line as l')
        .innerJoin('timetrack.timesheet as s', 's.id', 'l.timesheet_id')
        .select(['s.public_id', 's.period_start'])
        .distinct()
        .where(
          'l.brand_id',
          'in',
          brands.map((b) => b.id),
        )
        .where('l.state', 'in', decided ? ['approved', 'rejected'] : ['pending'])
        .orderBy('s.period_start', decided ? 'desc' : 'asc')
        .orderBy('s.public_id')
        .limit(this.pageLimitMax)
        .execute();
      const data = [];
      for (const r of rows) data.push(await this.sheetView(tx, p, r.public_id));
      return { data };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Planned, actual, and remaining effort (TIME-003, TIME-005, TIME-006, PRJ-022)
  // ---------------------------------------------------------------------------------------------

  /**
   * Planned versus actual by member, brand, project, task, or period (day, week, month) over a
   * date range. Actual = readable entries with a work date in the range. Planned = estimates of
   * readable tasks due in the range or with readable time in it (`planned_measure`), never of
   * hidden work; for periods, by due date. Rows are sorted by actual time and bounded by
   * TIME_REPORT_ROWS_MAX; totals always cover every row.
   */
  async timeReport(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const group = (['member', 'brand', 'project', 'task', 'day', 'week', 'month'] as const).find(
      (g) => g === (query.group ?? 'brand'),
    );
    if (!group)
      throw invalid(
        issue('/group', 'invalid', 'Group by member, brand, project, task, day, week, or month.'),
      );
    return this.inWorkspace(caller, ws, { readOnly: true }, (tx, p) =>
      this.timeReportIn(tx, p, query, group),
    );
  }

  /** The time report for a person inside an open transaction (also used by 5D reports). */
  protected async timeReportIn(
    tx: WorkspaceTransaction,
    p: Principal,
    query: Record<string, unknown>,
    group: 'member' | 'brand' | 'project' | 'task' | 'day' | 'week' | 'month',
  ) {
    {
      const zone = await this.personZone(tx, p.membershipId);
      const cal = await this.workspaceCalendar(tx);
      const range = this.parseRange(query, localDay(new Date(), zone));
      const vis = await this.entryPredicate(tx, p);
      const filters = await this.filters(
        tx,
        p,
        p.kind === 'guest' ? { ...query, member: 'me' } : query,
      );
      const where = sql.join(
        [
          vis,
          ...filters,
          sql<boolean>`e.state = 'stopped'`,
          sql<boolean>`e.work_date BETWEEN ${range.from}::date AND ${range.to}::date`,
        ],
        sql` AND `,
      );
      const projVis = await this.projectPredicate(tx, p, 'pr');
      const periodic = group === 'day' || group === 'week' || group === 'month';
      const actualKey =
        group === 'member'
          ? sql`e.membership_id::text`
          : group === 'brand'
            ? sql`e.brand_id::text`
            : group === 'project'
              ? sql`CASE WHEN pr.id IS NOT NULL AND ${projVis} THEN pr.id::text END`
              : group === 'task'
                ? sql`e.task_id::text`
                : sql`e.work_date::text`;
      const actual = await sql<{ k: string | null; total: string; billable: string; n: string }>`
        SELECT ${actualKey} AS k, sum(e.duration_seconds) AS total,
          sum(CASE WHEN e.billable THEN e.duration_seconds ELSE 0 END) AS billable, count(*) AS n
          FROM ${ENTRY_FROM}
          LEFT JOIN core.record pr ON pr.workspace_id = e.workspace_id AND pr.id = coalesce(e.project_id, tk.project_id)
         WHERE ${where}
         GROUP BY 1`.execute(tx.db);
      // Planned: estimates of readable, non-trashed tasks (brand and member filters narrow).
      const taskVis = await this.taskVisibility(tx, p, true);
      const brandFilter = filters.length
        ? await this.plannedFilters(tx, p, p.kind === 'guest' ? { ...query, member: 'me' } : query)
        : [];
      const plannedKey =
        group === 'member'
          ? sql`pa.membership_id::text`
          : group === 'brand'
            ? sql`t.brand_id::text`
            : group === 'project'
              ? sql`CASE WHEN pr.id IS NOT NULL AND ${projVis} THEN pr.id::text END`
              : group === 'task'
                ? sql`t.id::text`
                : sql`t.due_date::text`;
      const inRange = periodic
        ? sql`t.due_date BETWEEN ${range.from}::date AND ${range.to}::date`
        : sql`(t.due_date BETWEEN ${range.from}::date AND ${range.to}::date OR EXISTS (
            SELECT 1 FROM ${ENTRY_FROM} WHERE ${where} AND e.task_id = t.id))`;
      const planned = await sql<{ k: string | null; minutes: string; n: string }>`
        SELECT ${plannedKey} AS k, sum(t.estimate_minutes) AS minutes, count(*) AS n
          FROM work.task t
          JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
          LEFT JOIN work.task_assignee pa ON pa.task_id = t.id AND pa.is_primary
          LEFT JOIN core.record pr ON pr.workspace_id = t.workspace_id AND pr.id = t.project_id
         WHERE t.estimate_minutes IS NOT NULL AND ${taskVis.where('r', { project: sql`t.project_id` })}
           AND ${inRange} ${brandFilter.length ? sql`AND ${sql.join(brandFilter, sql` AND `)}` : sql``}
         GROUP BY 1`.execute(tx.db);
      const bucket = (k: string | null) =>
        periodic && k
          ? bucketOf(k.slice(0, 10), group as 'day' | 'week' | 'month', cal.weekStart)
          : k;
      const rows = new Map<
        string,
        {
          k: string | null;
          planned: number | null;
          estimated: number;
          total: number;
          billable: number;
          n: number;
        }
      >();
      const at = (k: string | null) => {
        const key = k ?? '';
        let r = rows.get(key);
        if (!r) {
          r = { k, planned: null, estimated: 0, total: 0, billable: 0, n: 0 };
          rows.set(key, r);
        }
        return r;
      };
      for (const a of actual.rows) {
        const r = at(bucket(a.k));
        r.total += Number(a.total);
        r.billable += Number(a.billable);
        r.n += Number(a.n);
      }
      for (const pl of planned.rows) {
        const r = at(bucket(pl.k));
        r.planned = (r.planned ?? 0) + Number(pl.minutes);
        r.estimated += Number(pl.n);
      }
      const labels = await this.reportLabels(
        tx,
        group,
        [...rows.values()].map((r) => r.k),
      );
      const all = [...rows.values()].map((r) => ({
        key: {
          type: group,
          id: r.k === null ? null : periodic ? r.k : (labels.get(r.k)?.id ?? null),
          label:
            r.k === null
              ? group === 'member'
                ? 'Unassigned'
                : group === 'project'
                  ? 'No project'
                  : group === 'task'
                    ? 'Project-level time'
                    : 'No date'
              : periodic
                ? r.k
                : (labels.get(r.k)?.label ?? ''),
        },
        planned_minutes: r.planned,
        estimated_tasks: r.estimated,
        actual_seconds: r.total,
        actual_hours: hoursOf(r.total),
        billable_seconds: r.billable,
        non_billable_seconds: r.total - r.billable,
        entries: r.n,
        ...(group === 'project' && r.k ? { budget_minutes: labels.get(r.k)?.budget ?? null } : {}),
      }));
      all.sort((a, b) =>
        periodic
          ? String(a.key.label).localeCompare(String(b.key.label))
          : b.actual_seconds - a.actual_seconds || a.key.label.localeCompare(b.key.label),
      );
      const max = this.ws.timeReportRowsMax;
      const totals = all.reduce(
        (t, r) => ({
          planned_minutes: t.planned_minutes + (r.planned_minutes ?? 0),
          actual_seconds: t.actual_seconds + r.actual_seconds,
          billable_seconds: t.billable_seconds + r.billable_seconds,
          entries: t.entries + r.entries,
        }),
        { planned_minutes: 0, actual_seconds: 0, billable_seconds: 0, entries: 0 },
      );
      return {
        range,
        group,
        planned_measure: periodic ? 'task_estimate_by_due_date' : 'task_estimate',
        billable:
          query.billable === 'billable' || query.billable === 'non_billable'
            ? query.billable
            : 'all',
        rows: all.slice(0, max),
        truncated: all.length > max,
        totals: {
          ...totals,
          actual_hours: hoursOf(totals.actual_seconds),
          non_billable_seconds: totals.actual_seconds - totals.billable_seconds,
        },
      };
    }
  }

  /** Brand and member filters re-expressed over planned tasks (aliases t, pa). */
  protected async plannedFilters(
    tx: WorkspaceTransaction,
    p: Principal,
    q: Record<string, unknown>,
  ): Promise<RawBuilder<boolean>[]> {
    const out: RawBuilder<boolean>[] = [];
    const brands = typeof q.brands === 'string' ? q.brands.split(',').filter(Boolean) : [];
    if (typeof q.brand === 'string') brands.push(q.brand);
    if (brands.length) {
      const ids: string[] = [];
      for (const b of brands.slice(0, 50)) ids.push((await findBrand(tx, p, b)).id);
      out.push(sql<boolean>`t.brand_id = ANY(${ids}::uuid[])`);
    }
    if (q.member === 'me') out.push(sql<boolean>`pa.membership_id = ${p.membershipId}::uuid`);
    else if (typeof q.member === 'string') {
      const m = await tx.db
        .selectFrom('tenancy.membership')
        .select('id')
        .where('public_id', '=', q.member)
        .executeTakeFirst();
      out.push(
        sql<boolean>`pa.membership_id = ${m?.id ?? '00000000-0000-7000-8000-000000000000'}::uuid`,
      );
    }
    if (typeof q.target === 'string') {
      const rec = await tx.db
        .selectFrom('core.record')
        .select(['id', 'record_type'])
        .where('public_id', '=', q.target)
        .executeTakeFirst();
      const id = rec?.id ?? '00000000-0000-7000-8000-000000000000';
      out.push(
        rec?.record_type === 'project'
          ? sql<boolean>`t.project_id = ${id}::uuid`
          : sql<boolean>`t.id = ${id}::uuid`,
      );
    }
    return out;
  }

  protected async reportLabels(
    tx: WorkspaceTransaction,
    group: string,
    keys: Array<string | null>,
  ): Promise<Map<string, { id: string; label: string; budget?: number | null }>> {
    const ids = keys.filter((k): k is string => !!k && /^[0-9a-f-]{36}$/.test(k));
    const out = new Map<string, { id: string; label: string; budget?: number | null }>();
    if (!ids.length) return out;
    if (group === 'member') {
      for (const m of await tx.db
        .selectFrom('tenancy.membership as m')
        .innerJoin('identity.account as a', 'a.id', 'm.account_id')
        .select([
          'm.id',
          'm.public_id',
          sql<string>`coalesce(m.display_name_override, a.display_name)`.as('name'),
        ])
        .where('m.id', 'in', ids)
        .execute())
        out.set(m.id, { id: m.public_id, label: m.name });
    } else if (group === 'brand') {
      for (const b of await this.brandRows(tx, ids))
        out.set(b.id, { id: b.public_id, label: b.name });
    } else if (group === 'project') {
      for (const r of await tx.db
        .selectFrom('work.project as w')
        .innerJoin('core.record as r', 'r.id', 'w.id')
        .select(['w.id', 'r.public_id', 'w.name', 'w.time_budget_minutes'])
        .where('w.id', 'in', ids)
        .execute())
        out.set(r.id, { id: r.public_id, label: r.name, budget: r.time_budget_minutes });
    } else if (group === 'task') {
      for (const r of await tx.db
        .selectFrom('work.task as t')
        .innerJoin('core.record as r', 'r.id', 't.id')
        .select(['t.id', 'r.public_id', 't.title'])
        .where('t.id', 'in', ids)
        .execute())
        out.set(r.id, { id: r.public_id, label: r.title });
    }
    return out;
  }

  /**
   * One task's or project's planned, actual, and remaining effort (TIME-003, TIME-006, PRJ-022).
   * A project counts its own time and the time on its readable tasks (not child projects: rollups
   * are 5C). Remaining effort sums each open readable task's remaining estimate, or its estimate
   * less its readable actual time when no remaining estimate is set; tasks with neither are
   * counted as unestimated.
   */
  async workSummary(caller: Caller, ws: unknown, target: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const vis = await this.entryPredicate(tx, p);
      const taskVis = await this.taskVisibility(tx, p, true);
      let kind: 'task' | 'project';
      let id: string;
      let planned: Record<string, unknown>;
      let scope: RawBuilder<boolean>;
      if (isPublic(target, 'tsk')) {
        const t = await this.loadTask(tx, p, target);
        kind = 'task';
        id = t.id;
        scope = sql<boolean>`e.task_id = ${t.id}::uuid`;
        planned = {
          estimate_minutes: t.row.estimate_minutes,
          remaining_estimate_minutes: t.row.remaining_estimate_minutes,
        };
      } else if (isPublic(target, 'prj')) {
        const prj = await this.loadProject(tx, p, target);
        kind = 'project';
        id = prj.id;
        scope = sql<boolean>`(e.project_id = ${prj.id}::uuid OR tk.project_id = ${prj.id}::uuid)`;
        const est = await sql<{ minutes: string | null; n: string; n_all: string }>`
          SELECT sum(t.estimate_minutes) AS minutes, count(t.estimate_minutes) AS n, count(*) AS n_all
            FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
           WHERE t.project_id = ${prj.id}::uuid AND ${taskVis.where('r', { project: sql`t.project_id` })}`.execute(
          tx.db,
        );
        planned = {
          budget_minutes: prj.row.time_budget_minutes,
          task_estimate_minutes:
            est.rows[0]?.minutes === null ? null : Number(est.rows[0]?.minutes ?? 0),
          estimated_tasks: Number(est.rows[0]?.n ?? 0),
          tasks: Number(est.rows[0]?.n_all ?? 0),
        };
      } else throw new TenancyError('not_found');
      const a = await sql<{ total: string; billable: string; mine: string; n: string }>`
        SELECT coalesce(sum(e.duration_seconds), 0) AS total,
          coalesce(sum(CASE WHEN e.billable THEN e.duration_seconds ELSE 0 END), 0) AS billable,
          coalesce(sum(CASE WHEN e.membership_id = ${p.membershipId}::uuid THEN e.duration_seconds ELSE 0 END), 0) AS mine,
          count(*) AS n
          FROM ${ENTRY_FROM} WHERE ${vis} AND ${scope} AND e.state = 'stopped'`.execute(tx.db);
      const total = Number(a.rows[0]?.total ?? 0);
      // Remaining: per open readable task (one task, or the project's tasks).
      const rem = await sql<{ remaining: string | null; unestimated: string; open: string }>`
        WITH tasks AS (
          SELECT t.id, t.estimate_minutes, t.remaining_estimate_minutes
            FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
           WHERE ${kind === 'task' ? sql`t.id = ${id}::uuid` : sql`t.project_id = ${id}::uuid`}
             AND t.status_category NOT IN ('done', 'cancelled')
             AND ${taskVis.where('r', { project: sql`t.project_id` })}
        ), actual AS (
          SELECT e.task_id, sum(e.duration_seconds) AS s FROM ${ENTRY_FROM}
           WHERE ${vis} AND e.state = 'stopped' AND e.task_id IN (SELECT id FROM tasks) GROUP BY e.task_id
        )
        SELECT sum(CASE WHEN tasks.remaining_estimate_minutes IS NOT NULL THEN tasks.remaining_estimate_minutes * 60
                        WHEN tasks.estimate_minutes IS NOT NULL THEN greatest(tasks.estimate_minutes * 60 - coalesce(actual.s, 0), 0)
                   END) AS remaining,
               count(*) FILTER (WHERE tasks.remaining_estimate_minutes IS NULL AND tasks.estimate_minutes IS NULL) AS unestimated,
               count(*) AS open
          FROM tasks LEFT JOIN actual ON actual.task_id = tasks.id`.execute(tx.db);
      const remaining = rem.rows[0]?.remaining;
      const live = await this.liveTimer(tx, p.membershipId);
      const liveHere =
        live && (live.task_id === id || live.project_id === id) ? live.public_id : null;
      return {
        target: { type: kind, id: String(target) },
        planned,
        actual: {
          seconds: total,
          hours: hoursOf(total),
          billable_seconds: Number(a.rows[0]?.billable ?? 0),
          non_billable_seconds: total - Number(a.rows[0]?.billable ?? 0),
          mine_seconds: Number(a.rows[0]?.mine ?? 0),
          entries: Number(a.rows[0]?.n ?? 0),
        },
        remaining: {
          minutes:
            remaining === null || remaining === undefined
              ? null
              : Math.ceil(Number(remaining) / 60),
          open_tasks: Number(rem.rows[0]?.open ?? 0),
          unestimated_open_tasks: Number(rem.rows[0]?.unestimated ?? 0),
          method: 'remaining_estimate_else_estimate_minus_actual' as const,
        },
        live_timer: liveHere,
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Export (TIME-014)
  // ---------------------------------------------------------------------------------------------

  /**
   * Exports readable entries for a range (CSV or JSON), directly and bounded by
   * TIME_EXPORT_ROWS_MAX; nothing is stored, so no artifact outlives a revocation. Audited, with
   * an `export` security event. Stored, scheduled, and adapter exports are 6D.
   */
  async exportTime(
    caller: Caller,
    ws: unknown,
    body: unknown,
  ): Promise<{ filename: string; contentType: string; body: string; rows: number }> {
    const b = isObj(body) ? body : {};
    const format = b.format ?? 'csv';
    if (format !== 'csv' && format !== 'json')
      throw invalid(issue('/format', 'invalid', 'Export as CSV or JSON.'));
    const max = this.ws.timeExportRowsMax;
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const zone = await this.personZone(tx, p.membershipId);
      const range = this.parseRange(b, localDay(new Date(), zone));
      const vis = await this.entryPredicate(tx, p);
      const parts = [
        vis,
        ...(await this.filters(tx, p, b)),
        sql<boolean>`e.state = 'stopped'`,
        sql<boolean>`e.work_date BETWEEN ${range.from}::date AND ${range.to}::date`,
      ];
      const projVis = await this.projectPredicate(tx, p, 'pr');
      const rows = await sql<{
        public_id: string;
        work_date: string;
        tz: string;
        started_at: Date | null;
        ended_at: Date | null;
        duration_seconds: number;
        billable: boolean;
        source: string;
        note: string;
        brand: string;
        project: string | null;
        task: string | null;
        task_id: string | null;
        project_id: string | null;
        person: string;
        closed: string | null;
      }>`
        SELECT e.public_id, e.work_date::text AS work_date, e.tz, e.started_at, e.ended_at,
          e.duration_seconds, e.billable, e.source, e.note, b.name AS brand,
          CASE WHEN pr.id IS NOT NULL AND ${projVis} THEN pw.name END AS project,
          tk.title AS task, tr.public_id AS task_id,
          CASE WHEN pr.id IS NOT NULL AND ${projVis} THEN pr.public_id END AS project_id,
          coalesce(m.display_name_override, a.display_name) AS person,
          timetrack.day_closed(e.workspace_id, e.membership_id, e.brand_id, e.work_date) AS closed
          FROM ${ENTRY_FROM}
          LEFT JOIN core.record tr ON tr.id = e.task_id
          LEFT JOIN core.record pr ON pr.workspace_id = e.workspace_id AND pr.id = coalesce(e.project_id, tk.project_id)
          LEFT JOIN work.project pw ON pw.id = pr.id
          JOIN tenancy.brand b ON b.id = e.brand_id
          JOIN tenancy.membership m ON m.id = e.membership_id
          JOIN identity.account a ON a.id = m.account_id
         WHERE ${sql.join(parts, sql` AND `)}
         ORDER BY e.work_date, e.started_at NULLS LAST, e.id
         LIMIT ${max + 1}`.execute(tx.db);
      if (rows.rows.length > max)
        throw invalid(
          issue(
            '/to',
            'too_many',
            `This range has more than ${max} entries. Choose a shorter range or a filter, then export again.`,
          ),
        );
      const data = rows.rows.map((r) => ({
        id: r.public_id,
        date: r.work_date,
        tz: r.tz,
        started_at: iso(r.started_at),
        ended_at: iso(r.ended_at),
        duration_seconds: Number(r.duration_seconds),
        hours: hoursOf(Number(r.duration_seconds)),
        billable: r.billable,
        brand: r.brand,
        project: r.project,
        project_id: r.project_id,
        task: r.task,
        task_id: r.task_id,
        person: r.person,
        status: r.closed === 'locked' ? 'approved' : (r.closed ?? 'open'),
        source: r.source,
        note: r.note,
      }));
      const content =
        format === 'json'
          ? JSON.stringify({ range, rounding: 'half_up_0.01h', data }, null, 2)
          : csv(
              [
                'Entry ID',
                'Date',
                'Time zone',
                'Start (UTC)',
                'End (UTC)',
                'Seconds',
                'Hours',
                'Billable',
                'Brand',
                'Project',
                'Task',
                'Person',
                'Status',
                'Source',
                'Note',
              ],
              data.map((d) => [
                d.id,
                d.date,
                d.tz,
                d.started_at,
                d.ended_at,
                d.duration_seconds,
                d.hours.toFixed(2),
                d.billable ? 'yes' : 'no',
                d.brand,
                d.project,
                d.task,
                d.person,
                d.status,
                d.source,
                d.note,
              ]),
            );
      await this.workWriter.write(tx, this.cmd(caller, p), {
        action: 'time.exported',
        target: { type: 'workspace', recordId: tx.workspaceId, publicId: String(ws) },
        changes: [
          change.plain('format', null, format as string),
          change.plain('from', null, range.from),
          change.plain('to', null, range.to),
          change.plain('rows', null, String(data.length)),
        ],
      });
      await this.d.security.record(tx, {
        category: 'export',
        action: 'time.export',
        outcome: 'success',
        actor: { type: 'human', id: p.membershipId },
        subject: { type: 'workspace', id: tx.workspaceId },
        correlationId: caller.meta.correlationId,
      });
      this.d.metrics.count('time.exports', 1, { format: format as string });
      return {
        filename: `time-${range.from}-to-${range.to}.${format}`,
        contentType: format === 'json' ? 'application/json' : 'text/csv',
        body: content,
        rows: data.length,
      };
    });
  }
}
