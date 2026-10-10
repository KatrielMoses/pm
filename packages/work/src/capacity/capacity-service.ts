import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  brandLevel,
  compileVisibility,
  decideBrand,
  decideWorkspace,
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
import { dayBounds } from '../planning/semantics.ts';
import { addDays, daysBetween, isoWeekday, localDay, validDay } from '../time/semantics.ts';
import { LayoutService } from '../views/layout-service.ts';
import {
  allDayInterval,
  allocation,
  availability,
  crossBrandOverlaps,
  intersect,
  minutes,
  nominalWeekMinutes,
  type DayAvailability,
  type Interval,
  type WorkingWindow,
} from './semantics.ts';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const NIL = '00000000-0000-7000-8000-000000000000';
const MEMBER = /^mem_[0-9A-HJKMNP-TV-Z]{26}$/;
const KINDS = ['vacation', 'sick', 'personal', 'holiday', 'unavailable'] as const;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const toMinute = (c: string) => Number(c.slice(0, 2)) * 60 + Number(c.slice(3, 5));
const toClock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** Whose capacity a read is about, and what the viewer may see of it. */
interface Subject {
  membershipId: string;
  publicId: string;
  name: string;
  self: boolean;
  tz: string;
}

/**
 * Phase 3E capacity and cross-brand conflicts (ADR-0022; 0B ADR-30; 0C AZ-30; 0D PL-32; OD-19).
 * Working hours, weekly capacity, and time off are personal; brand holidays are brand settings
 * (`brand.configure`); reservations are brand planning targets (`capacity.reserve`). Every
 * computed figure — availability, allocation, founder capacity, conflicts, Today's capacity, and
 * the workload grid's capacity — comes from the canonical sources (3C blocks and commitments, 3A
 * queries for estimates, 3D zone semantics) and only from what the viewer may read.
 */
export class CapacityService extends LayoutService {
  // ---------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------

  protected countCapacity(kind: string, outcome: string) {
    this.d.metrics.count('capacity.changes', 1, { kind, outcome });
  }

  protected async capAudit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    target: { id: string; type: string; publicId: string | null },
    changes: ReturnType<typeof change.plain>[],
    brandId: string | null,
  ) {
    await this.planAudit(tx, caller, p, action, target, changes, brandId);
  }

  protected capacityRange(q: Record<string, unknown>, tz: string) {
    const today = localDay(new Date(), tz);
    const from = q.from === undefined ? today : validDay(q.from);
    const to = q.to === undefined ? addDays(from ?? today, 6) : validDay(q.to);
    if (!from) throw invalid(issue('/from', 'invalid', 'Choose a valid first day.'));
    if (!to) throw invalid(issue('/to', 'invalid', 'Choose a valid last day.'));
    const span = daysBetween(from, to);
    if (span < 0) throw invalid(issue('/to', 'invalid', 'The last day comes after the first.'));
    if (span + 1 > this.ws.capacityRangeDaysMax)
      throw invalid(
        issue('/to', 'too_long', `Show at most ${this.ws.capacityRangeDaysMax} days at once.`),
      );
    return { from, to };
  }

  /** The person a read is about: `me` (or omitted), or a member the viewer may see capacity of. */
  protected async subject(tx: WorkspaceTransaction, p: Principal, raw: unknown): Promise<Subject> {
    if (raw === undefined || raw === 'me') {
      const me = await sql<{ public_id: string; name: string }>`SELECT m.public_id,
          coalesce(m.display_name_override, a.display_name) AS name FROM tenancy.membership m
          JOIN identity.account a ON a.id = m.account_id WHERE m.id = ${p.membershipId}::uuid`.execute(
        tx.db,
      );
      return {
        membershipId: p.membershipId,
        publicId: me.rows[0]!.public_id,
        name: me.rows[0]!.name,
        self: true,
        tz: await this.personZone(tx, p.membershipId),
      };
    }
    if (typeof raw !== 'string' || !MEMBER.test(raw)) throw new TenancyError('not_found');
    const m = (
      await sql<{ id: string; public_id: string; name: string; kind: string; state: string }>`
        SELECT m.id, m.public_id, coalesce(m.display_name_override, a.display_name) AS name, m.kind, m.state
        FROM tenancy.membership m JOIN identity.account a ON a.id = m.account_id
        WHERE m.workspace_id = ${tx.workspaceId} AND m.public_id = ${raw}`.execute(tx.db)
    ).rows[0];
    if (m?.id === p.membershipId) return this.subject(tx, p, 'me');
    // Another person: only with capacity.view somewhere (the workspace or a brand); otherwise the
    // person is indistinguishable from an unknown one. A departed (or never-joined) member has no
    // capacity: their personal data awaits erasure and is not anyone's to read (phase 3 matrix).
    const brands = await this.capacityBrands(tx, p);
    if (
      !m ||
      m.kind !== 'member' ||
      (m.state !== 'active' && m.state !== 'suspended') ||
      (!brands.workspace && !brands.ids.length)
    )
      throw new TenancyError('not_found');
    return {
      membershipId: m.id,
      publicId: m.public_id,
      name: m.name,
      self: false,
      tz: await this.personZone(tx, m.id),
    };
  }

  /** Brands where the viewer holds `capacity.view` (and whether at the workspace level). */
  protected async capacityBrands(tx: WorkspaceTransaction, p: Principal) {
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      includeArchived: false,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const workspace = p.kind === 'member' && decideWorkspace(p, 'capacity.view').allowed;
    const ids = vis.ctx.brands
      .filter((b) => b.lifecycleState === 'active' && brandLevel(p, b) !== null)
      .filter((b) => workspace || decideBrand(p, 'capacity.view', b).allowed)
      .map((b) => b.id);
    return { workspace, ids, readable: vis.ctx.brandIds, vis };
  }

  // ---------------------------------------------------------------------------------------------
  // Working hours and weekly capacity (TIME-001; personal)
  // ---------------------------------------------------------------------------------------------

  protected async profileOf(tx: WorkspaceTransaction, membershipId: string) {
    const prof = await tx.db
      .selectFrom('planning.capacity_profile')
      .selectAll()
      .where('membership_id', '=', membershipId)
      .executeTakeFirst();
    const windows = (
      await tx.db
        .selectFrom('planning.availability_rule')
        .select(['weekday', 'start_minute', 'end_minute'])
        .where('membership_id', '=', membershipId)
        .orderBy('weekday')
        .orderBy('start_minute')
        .execute()
    ).map((w) => ({ weekday: w.weekday, start: w.start_minute, end: w.end_minute }));
    return {
      exists: !!prof,
      weekly: prof?.weekly_capacity_minutes ?? null,
      observe: prof?.observe_brand_holidays ?? true,
      windows,
      version: Number(prof?.version ?? 0),
    };
  }

  protected profileOut(prof: Awaited<ReturnType<CapacityService['profileOf']>>, tz: string) {
    const nominal = nominalWeekMinutes(prof.windows);
    return {
      timezone: tz,
      windows: prof.windows.map((w) => ({
        weekday: w.weekday,
        start: toClock(w.start),
        end: toClock(w.end),
      })),
      nominal_week_minutes: nominal,
      weekly_capacity_minutes: prof.weekly,
      effective_week_minutes: prof.weekly ?? nominal,
      observe_brand_holidays: prof.observe,
      configured: prof.exists,
      version: prof.version,
    };
  }

  async myCapacityProfile(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      this.requirePersonal(p, 'personal.manage_own');
      return this.profileOut(
        await this.profileOf(tx, p.membershipId),
        await this.personZone(tx, p.membershipId),
      );
    });
  }

  protected parseWindows(raw: unknown): WorkingWindow[] {
    if (!Array.isArray(raw))
      throw invalid(issue('/windows', 'required', 'List the working windows.'));
    if (raw.length > this.ws.availabilityWindowsMax)
      throw invalid(
        issue(
          '/windows',
          'too_many',
          `Use at most ${this.ws.availabilityWindowsMax} working windows.`,
        ),
      );
    const out: WorkingWindow[] = [];
    raw.forEach((w, i) => {
      const at = `/windows/${i}`;
      if (
        !isObj(w) ||
        !Number.isInteger(w.weekday) ||
        (w.weekday as number) < 1 ||
        (w.weekday as number) > 7
      )
        throw invalid(issue(`${at}/weekday`, 'invalid', 'Choose a day of the week.'));
      if (typeof w.start !== 'string' || !CLOCK.test(w.start) || w.start === '24:00')
        throw invalid(issue(`${at}/start`, 'invalid', 'Use a time like 09:00.'));
      if (typeof w.end !== 'string' || !CLOCK.test(w.end))
        throw invalid(issue(`${at}/end`, 'invalid', 'Use a time like 17:30.'));
      const start = toMinute(w.start);
      const end = toMinute(w.end);
      if (end <= start)
        throw invalid(issue(`${at}/end`, 'invalid', 'The window ends after it starts.'));
      for (const o of out)
        if (o.weekday === w.weekday && o.start < end && start < o.end)
          throw invalid(issue(at, 'overlap', 'Working windows on one day cannot overlap.'));
      out.push({ weekday: w.weekday as number, start, end });
    });
    return out;
  }

  /** Replaces the person's working windows and capacity settings (If-Match on the profile). */
  async setMyCapacityProfile(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    for (const k of Object.keys(b))
      if (!['windows', 'weekly_capacity_minutes', 'observe_brand_holidays', 'version'].includes(k))
        throw invalid(issue(`/${k}`, 'unknown_key', 'This key is not allowed.'));
    const windows = b.windows === undefined ? undefined : this.parseWindows(b.windows);
    const weekly = b.weekly_capacity_minutes;
    if (
      weekly !== undefined &&
      weekly !== null &&
      (!Number.isInteger(weekly) || (weekly as number) < 0 || (weekly as number) > 10080)
    )
      throw invalid(
        issue('/weekly_capacity_minutes', 'invalid', 'Use whole minutes from 0 to 10080 (a week).'),
      );
    if (b.observe_brand_holidays !== undefined && typeof b.observe_brand_holidays !== 'boolean')
      throw invalid(issue('/observe_brand_holidays', 'invalid', 'Choose yes or no.'));
    return this.mutate(
      caller,
      'capacity.profile_set',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`capacity.profile:${p.membershipId}`}, 0))`.execute(
          tx.db,
        );
        const cur = await this.profileOf(tx, p.membershipId);
        const expected =
          req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (b.version as number | undefined);
        if (expected === undefined) throw new TenancyError('precondition_required');
        requireVersion(expected, cur.version);
        if (!cur.exists)
          await tx.db
            .insertInto('planning.capacity_profile')
            .values({
              workspace_id: tx.workspaceId,
              membership_id: p.membershipId,
              weekly_capacity_minutes: (weekly as number | null | undefined) ?? null,
              observe_brand_holidays: (b.observe_brand_holidays as boolean | undefined) ?? true,
              version: 1,
            })
            .execute();
        else
          await tx.db
            .updateTable('planning.capacity_profile')
            .set({
              ...(weekly !== undefined ? { weekly_capacity_minutes: weekly as number | null } : {}),
              ...(b.observe_brand_holidays !== undefined
                ? { observe_brand_holidays: b.observe_brand_holidays as boolean }
                : {}),
              updated_at: new Date(),
              version: cur.version + 1,
            })
            .where('membership_id', '=', p.membershipId)
            .execute();
        if (windows) {
          await tx.db
            .deleteFrom('planning.availability_rule')
            .where('membership_id', '=', p.membershipId)
            .execute();
          if (windows.length)
            await tx.db
              .insertInto('planning.availability_rule')
              .values(
                windows.map((w) => ({
                  workspace_id: tx.workspaceId,
                  membership_id: p.membershipId,
                  weekday: w.weekday,
                  start_minute: w.start,
                  end_minute: w.end,
                })),
              )
              .execute();
        }
        await this.capAudit(
          tx,
          caller,
          p,
          'capacity.profile_updated',
          { id: p.membershipId, type: 'membership', publicId: null },
          [
            change.plain('windows', null, windows ? windows.length : cur.windows.length),
            change.plain(
              'weekly_capacity_minutes',
              cur.weekly,
              weekly === undefined ? cur.weekly : (weekly as number | null),
            ),
          ],
          null,
        );
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.capacity_profile.updated',
          { type: 'planning.capacity_profile', id: p.membershipId, sequence: cur.version + 1 },
          {
            windows: windows ? windows.length : cur.windows.length,
            weekly_capacity_minutes: weekly === undefined ? cur.weekly : (weekly as number | null),
            observe_brand_holidays:
              (b.observe_brand_holidays as boolean | undefined) ?? cur.observe,
          },
          null,
        );
        this.countCapacity('profile', 'ok');
        const out = this.profileOut(
          await this.profileOf(tx, p.membershipId),
          await this.personZone(tx, p.membershipId),
        );
        return {
          status: 200,
          ref: { id: 'capacity_profile', type: 'capacity_profile' },
          data: { id: 'capacity_profile', type: 'capacity_profile', ...out },
        };
      },
      async (tx, p) => ({
        id: 'capacity_profile',
        type: 'capacity_profile',
        ...this.profileOut(
          await this.profileOf(tx, p.membershipId),
          await this.personZone(tx, p.membershipId),
        ),
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Time off (TIME-010; personal)
  // ---------------------------------------------------------------------------------------------

  protected timeOffOut(r: {
    public_id: string;
    kind: string;
    all_day: boolean;
    starts_on: string | null;
    ends_on: string | null;
    starts_at: Date | string | null;
    ends_at: Date | string | null;
    source_tz: string;
    label: string | null;
    version: string | number;
  }) {
    return {
      id: r.public_id,
      type: 'time_off' as const,
      kind: r.kind,
      all_day: r.all_day,
      starts_on: r.starts_on,
      ends_on: r.ends_on,
      starts_at: iso(r.starts_at),
      ends_at: iso(r.ends_at),
      tz: r.source_tz,
      label: r.label,
      version: Number(r.version),
    };
  }

  protected parseTimeOff(b: Record<string, unknown>, partial: boolean) {
    for (const k of Object.keys(b))
      if (
        ![
          'kind',
          'all_day',
          'starts_on',
          'ends_on',
          'starts_at',
          'ends_at',
          'tz',
          'label',
          'version',
        ].includes(k)
      )
        throw invalid(issue(`/${k}`, 'unknown_key', 'This key is not allowed.'));
    const kind = b.kind ?? (partial ? undefined : 'unavailable');
    if (kind !== undefined && !(KINDS as readonly unknown[]).includes(kind))
      throw invalid(
        issue('/kind', 'invalid', 'Choose vacation, sick, personal, holiday, or unavailable.'),
      );
    const allDay = b.all_day ?? (partial ? undefined : true);
    if (allDay !== undefined && typeof allDay !== 'boolean')
      throw invalid(issue('/all_day', 'invalid', 'Choose all day or a time range.'));
    const label = b.label;
    if (
      label !== undefined &&
      label !== null &&
      (typeof label !== 'string' || !label.trim() || label.trim().length > 120)
    )
      throw invalid(issue('/label', 'invalid', 'Use up to 120 characters.'));
    return {
      kind: kind as (typeof KINDS)[number] | undefined,
      allDay: allDay as boolean | undefined,
      label: label === undefined ? undefined : label === null ? null : (label as string).trim(),
    };
  }

  protected spanOf(b: Record<string, unknown>, allDay: boolean) {
    if (allDay) {
      const s = validDay(b.starts_on);
      const e = validDay(b.ends_on ?? b.starts_on);
      if (!s) throw invalid(issue('/starts_on', 'invalid', 'Choose the first day.'));
      if (!e || e < s)
        throw invalid(issue('/ends_on', 'invalid', 'The last day is on or after the first.'));
      if (daysBetween(s, e) > 366)
        throw invalid(issue('/ends_on', 'too_long', 'Keep it within a year.'));
      return { starts_on: s, ends_on: e, starts_at: null, ends_at: null };
    }
    const s = typeof b.starts_at === 'string' ? new Date(b.starts_at) : null;
    const e = typeof b.ends_at === 'string' ? new Date(b.ends_at) : null;
    if (!s || Number.isNaN(s.getTime()))
      throw invalid(issue('/starts_at', 'invalid', 'Choose when it starts.'));
    if (!e || Number.isNaN(e.getTime()) || e <= s)
      throw invalid(issue('/ends_at', 'invalid', 'It ends after it starts.'));
    if (e.getTime() - s.getTime() > 31 * 86_400_000)
      throw invalid(issue('/ends_at', 'too_long', 'Use an all-day period for more than 31 days.'));
    return { starts_on: null, ends_on: null, starts_at: s, ends_at: e };
  }

  async listTimeOff(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      this.requirePersonal(p, 'personal.manage_own');
      const tz = await this.personZone(tx, p.membershipId);
      const { from, to } = this.capacityRange(
        {
          from: query.from ?? addDays(localDay(new Date(), tz), -30),
          to: query.to ?? addDays(localDay(new Date(), tz), 62),
        },
        tz,
      );
      const start = dayBounds(from, tz).start;
      const end = dayBounds(to, tz).end;
      const rows = (
        await sql<Parameters<CapacityService['timeOffOut']>[0]>`SELECT public_id, kind, all_day,
            starts_on::text AS starts_on, ends_on::text AS ends_on, starts_at, ends_at, source_tz, label, version
          FROM planning.time_off WHERE workspace_id = ${tx.workspaceId} AND membership_id = ${p.membershipId}::uuid
            AND ((all_day AND ends_on >= ${from}::date AND starts_on <= ${to}::date)
              OR (NOT all_day AND ends_at > ${start}::timestamptz AND starts_at < ${end}::timestamptz))
          ORDER BY coalesce(starts_on::timestamptz, starts_at), id`.execute(tx.db)
      ).rows;
      return { from, to, data: rows.map((r) => this.timeOffOut(r)) };
    });
  }

  protected async loadTimeOff(tx: WorkspaceTransaction, p: Principal, raw: unknown, lock = false) {
    if (typeof raw !== 'string' || !/^tof_[0-9A-HJKMNP-TV-Z]{26}$/.test(raw))
      throw new TenancyError('not_found');
    const r = (
      await sql<
        Parameters<CapacityService['timeOffOut']>[0] & { id: string; membership_id: string }
      >`
        SELECT id, membership_id, public_id, kind, all_day, starts_on::text AS starts_on, ends_on::text AS ends_on,
          starts_at, ends_at, source_tz, label, version FROM planning.time_off
        WHERE workspace_id = ${tx.workspaceId} AND public_id = ${raw}
        ${lock ? sql`FOR UPDATE` : sql``}`.execute(tx.db)
    ).rows[0];
    // Someone else's time off is indistinguishable from an unknown entry (no bypass, AZ-30).
    if (!r || r.membership_id !== p.membershipId) throw new TenancyError('not_found');
    return r;
  }

  async createTimeOff(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const v = this.parseTimeOff(b, false);
    return this.mutate(
      caller,
      'capacity.time_off_create',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const tz = this.zoneInput(b.tz) ?? (await this.personZone(tx, p.membershipId));
        const span = this.spanOf(b, v.allDay!);
        const n = await tx.db
          .selectFrom('planning.time_off')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('membership_id', '=', p.membershipId)
          .executeTakeFirstOrThrow();
        if (Number(n.n) >= this.ws.timeOffEntriesMax)
          throw invalid(
            issue('/', 'too_many', `Keep at most ${this.ws.timeOffEntriesMax} time-off entries.`),
          );
        const id = newUuidV7();
        const publicId = newPublicId('tof');
        await tx.db
          .insertInto('planning.time_off')
          .values({
            id,
            public_id: publicId,
            workspace_id: tx.workspaceId,
            membership_id: p.membershipId,
            kind: v.kind!,
            all_day: v.allDay!,
            ...span,
            source_tz: tz,
            label: v.label ?? null,
          })
          .execute();
        await this.capAudit(
          tx,
          caller,
          p,
          'capacity.time_off_created',
          { id, type: 'time_off', publicId },
          [change.plain('kind', null, v.kind!), change.plain('all_day', null, v.allDay!)],
          null,
        );
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.time_off.created',
          { type: 'planning.time_off', id, sequence: 0 },
          {
            kind: v.kind!,
            all_day: v.allDay!,
            days: span.starts_on ? daysBetween(span.starts_on, span.ends_on!) + 1 : 0,
          },
          null,
        );
        this.countCapacity('time_off', 'created');
        return {
          status: 201,
          ref: { id: publicId, type: 'time_off' },
          data: this.timeOffOut(await this.loadTimeOff(tx, p, publicId)),
        };
      },
      async (tx, p, ref) => this.timeOffOut(await this.loadTimeOff(tx, p, ref.id)),
    );
  }

  async updateTimeOff(caller: Caller, ws: unknown, tof: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const v = this.parseTimeOff(b, true);
    return this.mutate(
      caller,
      'capacity.time_off_update',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const cur = await this.loadTimeOff(tx, p, tof, true);
        const expected =
          req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (b.version as number | undefined);
        if (expected === undefined) throw new TenancyError('precondition_required');
        requireVersion(expected, Number(cur.version));
        const allDay = v.allDay ?? cur.all_day;
        const touchesSpan = ['all_day', 'starts_on', 'ends_on', 'starts_at', 'ends_at'].some(
          (k) => k in b,
        );
        const span = touchesSpan
          ? this.spanOf(
              {
                starts_on: b.starts_on ?? cur.starts_on,
                ends_on: b.ends_on ?? cur.ends_on,
                starts_at: b.starts_at ?? iso(cur.starts_at),
                ends_at: b.ends_at ?? iso(cur.ends_at),
              },
              allDay,
            )
          : null;
        await tx.db
          .updateTable('planning.time_off')
          .set({
            ...(v.kind ? { kind: v.kind } : {}),
            ...(span ? { all_day: allDay, ...span } : {}),
            ...(v.label !== undefined ? { label: v.label } : {}),
            ...(b.tz !== undefined ? { source_tz: this.zoneInput(b.tz)! } : {}),
            updated_at: new Date(),
            version: Number(cur.version) + 1,
          })
          .where('id', '=', cur.id)
          .execute();
        await this.capAudit(
          tx,
          caller,
          p,
          'capacity.time_off_updated',
          { id: cur.id, type: 'time_off', publicId: cur.public_id },
          [change.plain('kind', cur.kind, v.kind ?? cur.kind)],
          null,
        );
        const after = await this.loadTimeOff(tx, p, cur.public_id);
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.time_off.updated',
          { type: 'planning.time_off', id: cur.id, sequence: Number(cur.version) + 1 },
          {
            kind: after.kind,
            all_day: after.all_day,
            days: after.starts_on ? daysBetween(after.starts_on, after.ends_on!) + 1 : 0,
          },
          null,
        );
        this.countCapacity('time_off', 'updated');
        return {
          status: 200,
          ref: { id: cur.public_id, type: 'time_off' },
          data: this.timeOffOut(after),
        };
      },
      async (tx, p, ref) => this.timeOffOut(await this.loadTimeOff(tx, p, ref.id)),
    );
  }

  async deleteTimeOff(caller: Caller, ws: unknown, tof: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'capacity.time_off_delete',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const cur = await this.loadTimeOff(tx, p, tof, true);
        if (req.ifMatch !== undefined)
          requireVersion(parseIfMatch(req.ifMatch), Number(cur.version));
        await tx.db.deleteFrom('planning.time_off').where('id', '=', cur.id).execute();
        await this.capAudit(
          tx,
          caller,
          p,
          'capacity.time_off_deleted',
          { id: cur.id, type: 'time_off', publicId: cur.public_id },
          [change.plain('kind', cur.kind, null)],
          null,
        );
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.time_off.deleted',
          { type: 'planning.time_off', id: cur.id, sequence: Number(cur.version) + 1 },
          { kind: cur.kind },
          null,
        );
        this.countCapacity('time_off', 'deleted');
        return {
          status: 200,
          ref: { id: cur.public_id, type: 'time_off' },
          data: { id: cur.public_id, type: 'time_off', deleted: true },
        };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'time_off', deleted: true }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Brand holidays (OD-19; brand.configure) and reservations (TIME-002; capacity.reserve)
  // ---------------------------------------------------------------------------------------------

  async listHolidays(caller: Caller, ws: unknown, brand: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const b = await findBrand(tx, p, brand);
      const year = typeof query.year === 'string' && /^\d{4}$/.test(query.year) ? query.year : null;
      const rows = (
        await sql<{
          public_id: string;
          day: string;
          name: string;
        }>`SELECT public_id, day::text AS day, name
          FROM planning.holiday WHERE workspace_id = ${tx.workspaceId} AND brand_id = ${b.id}::uuid
            ${year ? sql`AND day BETWEEN ${`${year}-01-01`}::date AND ${`${year}-12-31`}::date` : sql``}
          ORDER BY day LIMIT ${this.ws.brandHolidaysMax}`.execute(tx.db)
      ).rows;
      return {
        brand: b.public_id,
        can_configure: decideBrand(p, 'brand.configure', {
          id: b.id,
          isSensitive: b.is_sensitive,
          lifecycleState: b.lifecycle_state as 'active',
        }).allowed,
        data: rows.map((r) => ({
          id: r.public_id,
          type: 'holiday' as const,
          day: r.day,
          name: r.name,
        })),
      };
    });
  }

  protected async configurableBrand(
    tx: WorkspaceTransaction,
    p: Principal,
    raw: unknown,
    action: 'brand.configure' | 'capacity.reserve',
  ) {
    const b = await findBrand(tx, p, raw, { states: 'active' });
    const o = decideBrand(p, action, {
      id: b.id,
      isSensitive: b.is_sensitive,
      lifecycleState: 'active',
    });
    this.decision(action, o);
    if (!o.allowed) throw new TenancyError(o.code);
    return b;
  }

  async createHoliday(caller: Caller, ws: unknown, brand: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const day = validDay(b.day);
    if (!day) throw invalid(issue('/day', 'invalid', 'Choose the day.'));
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 120)
      throw invalid(issue('/name', 'required', 'Name the holiday (up to 120 characters).'));
    return this.mutate(
      caller,
      'capacity.holiday_create',
      ws,
      req,
      async (tx, p) => {
        const br = await this.configurableBrand(tx, p, brand, 'brand.configure');
        const n = await tx.db
          .selectFrom('planning.holiday')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('brand_id', '=', br.id)
          .executeTakeFirstOrThrow();
        if (Number(n.n) >= this.ws.brandHolidaysMax)
          throw invalid(
            issue('/', 'too_many', `A brand keeps at most ${this.ws.brandHolidaysMax} holidays.`),
          );
        const dup = await tx.db
          .selectFrom('planning.holiday')
          .select('id')
          .where('brand_id', '=', br.id)
          .where('day', '=', day)
          .executeTakeFirst();
        if (dup)
          throw new TenancyError('conflict', {
            issues: [issue('/day', 'duplicate', 'This brand already has a holiday on that day.')],
          });
        const id = newUuidV7();
        const publicId = newPublicId('hol');
        await tx.db
          .insertInto('planning.holiday')
          .values({
            id,
            public_id: publicId,
            workspace_id: tx.workspaceId,
            brand_id: br.id,
            day,
            name: (b.name as string).trim(),
            created_by_membership_id: p.membershipId,
          })
          .execute();
        await this.capAudit(
          tx,
          caller,
          p,
          'capacity.holiday_created',
          { id, type: 'holiday', publicId },
          [change.plain('day', null, day)],
          br.id,
        );
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.holiday.created',
          { type: 'planning.holiday', id, sequence: 0 },
          { day },
          br.id,
        );
        this.countCapacity('holiday', 'created');
        const data = {
          id: publicId,
          type: 'holiday' as const,
          day,
          name: (b.name as string).trim(),
        };
        return { status: 201, ref: { id: publicId, type: 'holiday' }, data };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'holiday' }) as never,
    );
  }

  async deleteHoliday(caller: Caller, ws: unknown, brand: unknown, hol: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'capacity.holiday_delete',
      ws,
      req,
      async (tx, p) => {
        const br = await this.configurableBrand(tx, p, brand, 'brand.configure');
        const h =
          typeof hol === 'string'
            ? await tx.db
                .selectFrom('planning.holiday')
                .select(['id', 'public_id', 'day'])
                .where('public_id', '=', hol)
                .where('brand_id', '=', br.id)
                .executeTakeFirst()
            : undefined;
        if (!h) throw new TenancyError('not_found');
        await tx.db.deleteFrom('planning.holiday').where('id', '=', h.id).execute();
        const day = String(h.day).slice(0, 10);
        await this.capAudit(
          tx,
          caller,
          p,
          'capacity.holiday_deleted',
          { id: h.id, type: 'holiday', publicId: h.public_id },
          [change.plain('day', day, null)],
          br.id,
        );
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.holiday.deleted',
          { type: 'planning.holiday', id: h.id, sequence: 1 },
          { day },
          br.id,
        );
        this.countCapacity('holiday', 'deleted');
        return {
          status: 200,
          ref: { id: h.public_id, type: 'holiday' },
          data: { id: h.public_id, type: 'holiday', deleted: true },
        };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'holiday', deleted: true }),
    );
  }

  protected reservationOut(r: {
    public_id: string;
    brand_public_id: string;
    brand_name: string;
    member_public_id: string;
    member_name: string;
    minutes_per_week: number;
    effective_from: string;
    effective_to: string | null;
    version: string | number;
  }) {
    return {
      id: r.public_id,
      type: 'capacity_reservation' as const,
      brand: { id: r.brand_public_id, name: r.brand_name },
      member: { id: r.member_public_id, name: r.member_name },
      minutes_per_week: Number(r.minutes_per_week),
      effective_from: r.effective_from,
      effective_to: r.effective_to,
      version: Number(r.version),
    };
  }

  protected reservationRows(tx: WorkspaceTransaction, where: ReturnType<typeof sql<boolean>>) {
    return sql<
      Parameters<CapacityService['reservationOut']>[0] & {
        id: string;
        brand_id: string;
        membership_id: string;
      }
    >`
      SELECT c.id, c.public_id, c.brand_id, c.membership_id, br.public_id AS brand_public_id, b.name AS brand_name,
        m.public_id AS member_public_id, coalesce(m.display_name_override, a.display_name) AS member_name,
        c.minutes_per_week, c.effective_from::text AS effective_from, c.effective_to::text AS effective_to, c.version
      FROM planning.capacity_reservation c
      JOIN tenancy.brand b ON b.workspace_id = c.workspace_id AND b.id = c.brand_id
      JOIN core.record br ON br.workspace_id = b.workspace_id AND br.id = b.id
      JOIN tenancy.membership m ON m.workspace_id = c.workspace_id AND m.id = c.membership_id
      JOIN identity.account a ON a.id = m.account_id
      WHERE c.workspace_id = ${tx.workspaceId} AND ${where}
      ORDER BY lower(b.name), lower(coalesce(m.display_name_override, a.display_name)), c.effective_from, c.id`.execute(
      tx.db,
    );
  }

  /**
   * Reservations the viewer may see: their own (in brands they can read) and, with capacity.view
   * at a brand, that brand's. Reservations in brands the viewer cannot read are never returned.
   */
  async listReservations(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const cap = await this.capacityBrands(tx, p);
      const readable = cap.readable.length ? cap.readable : [NIL];
      const viewable = cap.ids.length ? cap.ids : [NIL];
      let brandId: string | null = null;
      if (query.brand !== undefined) brandId = (await findBrand(tx, p, query.brand)).id;
      const rows = (
        await this.reservationRows(
          tx,
          sql<boolean>`c.brand_id = ANY(${readable}::uuid[])
            AND (c.membership_id = ${p.membershipId}::uuid OR c.brand_id = ANY(${viewable}::uuid[]))
            ${brandId ? sql`AND c.brand_id = ${brandId}::uuid` : sql``}`,
        )
      ).rows;
      return { data: rows.map((r) => this.reservationOut(r)) };
    });
  }

  /** Sets (creates or replaces from `effective_from`) one person's weekly reservation for a brand. */
  async setReservation(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    for (const k of Object.keys(b))
      if (
        ![
          'brand',
          'member',
          'minutes_per_week',
          'effective_from',
          'effective_to',
          'version',
        ].includes(k)
      )
        throw invalid(issue(`/${k}`, 'unknown_key', 'This key is not allowed.'));
    if (
      !Number.isInteger(b.minutes_per_week) ||
      (b.minutes_per_week as number) < 0 ||
      (b.minutes_per_week as number) > 10080
    )
      throw invalid(
        issue('/minutes_per_week', 'invalid', 'Use whole minutes from 0 to 10080 (a week).'),
      );
    const from = validDay(b.effective_from);
    if (!from)
      throw invalid(issue('/effective_from', 'invalid', 'Choose the first day it applies.'));
    const to =
      b.effective_to === undefined || b.effective_to === null ? null : validDay(b.effective_to);
    if (b.effective_to !== undefined && b.effective_to !== null && (!to || to < from))
      throw invalid(issue('/effective_to', 'invalid', 'The last day comes on or after the first.'));
    return this.mutate(
      caller,
      'capacity.reservation_set',
      ws,
      req,
      async (tx, p) => {
        const br = await this.configurableBrand(tx, p, b.brand, 'capacity.reserve');
        if (typeof b.member !== 'string' || !MEMBER.test(b.member))
          throw invalid(issue('/member', 'invalid', 'Choose a person.'));
        const m = await tx.db
          .selectFrom('tenancy.membership')
          .select(['id', 'kind', 'state'])
          .where('public_id', '=', b.member)
          .executeTakeFirst();
        if (!m || m.kind !== 'member' || m.state !== 'active')
          throw invalid(issue('/member', 'invalid', 'Choose an active member of this workspace.'));
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`capacity.reservation:${br.id}:${m.id}`}, 0))`.execute(
          tx.db,
        );
        const cur = await tx.db
          .selectFrom('planning.capacity_reservation')
          .select(['id', 'public_id', 'version'])
          .where('brand_id', '=', br.id)
          .where('membership_id', '=', m.id)
          .where('effective_from', '=', from)
          .forUpdate()
          .executeTakeFirst();
        const expected =
          req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (b.version as number | undefined);
        if (cur) {
          if (expected === undefined) throw new TenancyError('precondition_required');
          requireVersion(expected, Number(cur.version));
        }
        let id = cur?.id;
        let publicId = cur?.public_id;
        if (cur)
          await tx.db
            .updateTable('planning.capacity_reservation')
            .set({
              minutes_per_week: b.minutes_per_week as number,
              effective_to: to,
              set_by_membership_id: p.membershipId,
              updated_at: new Date(),
              version: Number(cur.version) + 1,
            })
            .where('id', '=', cur.id)
            .execute();
        else {
          id = newUuidV7();
          publicId = newPublicId('rsv');
          await tx.db
            .insertInto('planning.capacity_reservation')
            .values({
              id,
              public_id: publicId,
              workspace_id: tx.workspaceId,
              brand_id: br.id,
              membership_id: m.id,
              minutes_per_week: b.minutes_per_week as number,
              effective_from: from,
              effective_to: to,
              set_by_membership_id: p.membershipId,
            })
            .execute();
          // The previous open-ended reservation ends the day before this one starts.
          await sql`UPDATE planning.capacity_reservation SET effective_to = ${addDays(from, -1)}::date,
              updated_at = now(), version = version + 1
            WHERE workspace_id = ${tx.workspaceId} AND brand_id = ${br.id}::uuid AND membership_id = ${m.id}::uuid
              AND id <> ${id}::uuid AND effective_from < ${from}::date
              AND (effective_to IS NULL OR effective_to >= ${from}::date)`.execute(tx.db);
        }
        await this.capAudit(
          tx,
          caller,
          p,
          'capacity.reservation_set',
          { id: id!, type: 'capacity_reservation', publicId: publicId! },
          [
            change.plain('minutes_per_week', null, b.minutes_per_week as number),
            change.plain('effective_from', null, from),
            change.plain('effective_to', null, to),
          ],
          br.id,
        );
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.capacity_reservation.set',
          {
            type: 'planning.capacity_reservation',
            id: id!,
            sequence: cur ? Number(cur.version) + 1 : 0,
          },
          {
            minutes_per_week: b.minutes_per_week as number,
            effective_from: from,
            effective_to: to,
          },
          br.id,
        );
        this.countCapacity('reservation', 'set');
        const row = (await this.reservationRows(tx, sql<boolean>`c.id = ${id!}::uuid`)).rows[0]!;
        return {
          status: cur ? 200 : 201,
          ref: { id: publicId!, type: 'capacity_reservation' },
          data: this.reservationOut(row),
        };
      },
      async (tx, _p, ref) =>
        this.reservationOut(
          (await this.reservationRows(tx, sql<boolean>`c.public_id = ${ref.id}`)).rows[0]!,
        ),
    );
  }

  async deleteReservation(caller: Caller, ws: unknown, rsv: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'capacity.reservation_delete',
      ws,
      req,
      async (tx, p) => {
        const r =
          typeof rsv === 'string'
            ? (await this.reservationRows(tx, sql<boolean>`c.public_id = ${rsv}`)).rows[0]
            : undefined;
        if (!r) throw new TenancyError('not_found');
        await this.configurableBrand(tx, p, r.brand_public_id, 'capacity.reserve');
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), Number(r.version));
        await tx.db.deleteFrom('planning.capacity_reservation').where('id', '=', r.id).execute();
        await this.capAudit(
          tx,
          caller,
          p,
          'capacity.reservation_removed',
          { id: r.id, type: 'capacity_reservation', publicId: r.public_id },
          [change.plain('minutes_per_week', Number(r.minutes_per_week), null)],
          r.brand_id,
        );
        await this.planEvent(
          tx,
          caller,
          p,
          'planning.capacity_reservation.removed',
          { type: 'planning.capacity_reservation', id: r.id, sequence: Number(r.version) + 1 },
          { effective_from: r.effective_from },
          r.brand_id,
        );
        this.countCapacity('reservation', 'removed');
        return {
          status: 200,
          ref: { id: r.public_id, type: 'capacity_reservation' },
          data: { id: r.public_id, type: 'capacity_reservation', deleted: true },
        };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'capacity_reservation', deleted: true }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Computation: availability, allocation, founder capacity, and conflicts
  // ---------------------------------------------------------------------------------------------

  /** Availability per day for a person (their windows, time off, observed brand holidays). */
  protected async availabilityOf(
    tx: WorkspaceTransaction,
    who: Subject,
    from: string,
    to: string,
    visibleBrands: string[],
  ): Promise<DayAvailability[]> {
    const prof = await this.profileOf(tx, who.membershipId);
    const start = dayBounds(from, who.tz).start;
    const end = dayBounds(to, who.tz).end;
    const off = (
      await sql<{
        all_day: boolean;
        starts_on: string | null;
        ends_on: string | null;
        starts_at: Date | null;
        ends_at: Date | null;
        source_tz: string;
      }>`
        SELECT all_day, starts_on::text AS starts_on, ends_on::text AS ends_on, starts_at, ends_at, source_tz
        FROM planning.time_off WHERE workspace_id = ${tx.workspaceId} AND membership_id = ${who.membershipId}::uuid
          AND ((all_day AND ends_on >= ${addDays(from, -1)}::date AND starts_on <= ${addDays(to, 1)}::date)
            OR (NOT all_day AND ends_at > ${start}::timestamptz AND starts_at < ${end}::timestamptz))`.execute(
        tx.db,
      )
    ).rows;
    const intervals: Interval[] = off.map((o) =>
      o.all_day
        ? allDayInterval(o.starts_on!, o.ends_on!, o.source_tz)
        : { start: new Date(o.starts_at!), end: new Date(o.ends_at!) },
    );
    // OD-19: a brand holiday removes the person's day only if they observe brand holidays and
    // hold a reservation in that brand during it — and only for brands this viewer can read.
    const holidays = new Set<string>();
    if (prof.observe)
      for (const h of (
        await sql<{ day: string }>`SELECT DISTINCT h.day::text AS day FROM planning.holiday h
          JOIN planning.capacity_reservation c ON c.workspace_id = h.workspace_id AND c.brand_id = h.brand_id
            AND c.membership_id = ${who.membershipId}::uuid AND c.effective_from <= h.day
            AND (c.effective_to IS NULL OR c.effective_to >= h.day)
          WHERE h.workspace_id = ${tx.workspaceId} AND h.day BETWEEN ${from}::date AND ${to}::date
            AND h.brand_id = ANY(${visibleBrands.length ? visibleBrands : [NIL]}::uuid[])`.execute(
          tx.db,
        )
      ).rows)
        holidays.add(h.day);
    return availability({
      from,
      to,
      tz: who.tz,
      windows: prof.windows,
      timeOff: intervals,
      holidays,
      weeklyOverride: prof.weekly,
    });
  }

  /**
   * Work blocks of the person in the window. The person sees all of theirs (blocks on tasks they
   * can no longer read stay as unbranded busy time, AZ-29). Another viewer sees only blocks on
   * tasks that viewer can read, in brands they may see capacity of.
   */
  protected async blocksOf(
    tx: WorkspaceTransaction,
    p: Principal,
    who: Subject,
    start: Date,
    end: Date,
    visibleBrands: string[],
  ) {
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      includeArchived: true,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const rows = (
      await sql<{
        public_id: string;
        starts_at: Date;
        ends_at: Date;
        prep_minutes: number;
        buffer_minutes: number;
        brand_id: string | null;
        readable: boolean;
        focus: boolean;
      }>`
        SELECT w.public_id, w.starts_at, w.ends_at, w.prep_minutes, w.buffer_minutes, w.focus,
          CASE WHEN w.task_id IS NULL THEN NULL ELSE w.brand_id END AS brand_id,
          (w.task_id IS NOT NULL AND EXISTS (SELECT 1 FROM core.record r JOIN work.task t ON t.id = r.id
            WHERE r.workspace_id = w.workspace_id AND r.id = w.task_id
              AND ${vis.where('r', { project: sql`t.project_id` })})) AS readable
        FROM planning.work_block w
        WHERE w.workspace_id = ${tx.workspaceId} AND w.owner_membership_id = ${who.membershipId}::uuid
          AND w.starts_at < ${end}::timestamptz AND w.ends_at > ${start}::timestamptz
        ORDER BY w.starts_at, w.id`.execute(tx.db)
    ).rows;
    return rows
      .filter((b) => who.self || (b.readable && b.brand_id && visibleBrands.includes(b.brand_id)))
      .map((b) => ({
        id: b.public_id,
        // Padding counts as used time (0A §5); the block itself is what conflicts.
        start: new Date(new Date(b.starts_at).getTime() - Number(b.prep_minutes) * 60_000),
        end: new Date(new Date(b.ends_at).getTime() + Number(b.buffer_minutes) * 60_000),
        core: { start: new Date(b.starts_at), end: new Date(b.ends_at) },
        brand: b.readable ? b.brand_id : null,
        focus: b.focus,
      }));
  }

  /**
   * Remaining (else original) estimates of the person's open tasks (primary assignee) due in the
   * window, per brand and due date — through the 3A engine, so the viewer's own predicate decides.
   */
  protected async estimatesOf(
    tx: WorkspaceTransaction,
    p: Principal,
    who: Subject,
    from: string,
    to: string,
  ) {
    const k = await this.compileQuery(
      tx,
      p,
      {
        query: {
          entity: 'task',
          filter: {
            op: 'and',
            items: [
              { field: 'owner', op: 'in', value: [who.self ? 'me' : who.publicId] },
              { field: 'status_category', op: 'not_in', value: ['done', 'cancelled'] },
              { field: 'due_date', op: 'between', value: [from, to] },
            ],
          },
        },
        today: from,
      },
      'task',
    );
    return (
      await sql<{
        brand_id: string;
        due: string;
        minutes: string;
        tasks: string;
        unestimated: string;
      }>`
        SELECT t.brand_id, t.due_date::text AS due,
          coalesce(sum(coalesce(t.remaining_estimate_minutes, t.estimate_minutes)), 0)::text AS minutes,
          count(*)::text AS tasks,
          count(*) FILTER (WHERE coalesce(t.remaining_estimate_minutes, t.estimate_minutes) IS NULL)::text AS unestimated
        ${k.where} GROUP BY 1, 2`.execute(tx.db)
    ).rows.map((r) => ({
      brand: r.brand_id,
      day: r.due,
      minutes: Number(r.minutes),
      tasks: Number(r.tasks),
      unestimated: Number(r.unestimated),
    }));
  }

  /** Reservations of the person in brands the viewer can see, pro-rated per day of the window. */
  protected async reservationsOf(
    tx: WorkspaceTransaction,
    who: Subject,
    from: string,
    to: string,
    visibleBrands: string[],
  ) {
    return (
      await this.reservationRows(
        tx,
        sql<boolean>`c.membership_id = ${who.membershipId}::uuid
          AND c.brand_id = ANY(${visibleBrands.length ? visibleBrands : [NIL]}::uuid[])
          AND c.effective_from <= ${to}::date AND (c.effective_to IS NULL OR c.effective_to >= ${from}::date)`,
      )
    ).rows;
  }

  /**
   * One person's capacity over a window (TIME-007/008, WSB-017/018, CAL-009/010): availability per
   * day; scheduled (blocks) and estimated (open tasks) use; allocation; per-brand reservations
   * versus use; and cross-brand conflicts. Everything is limited to what the viewer may read.
   */
  async personCapacity(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.capacityRead('person', caller, ws, async (tx, p) => {
      const who = await this.subject(tx, p, query.member);
      const { from, to } = this.capacityRange(query, who.tz);
      return this.capacityFor(tx, p, who, from, to);
    });
  }

  protected async capacityRead<T>(
    view: string,
    caller: Caller,
    ws: unknown,
    fn: (tx: WorkspaceTransaction, p: Principal) => Promise<T>,
  ): Promise<T> {
    try {
      const out = await this.inWorkspace(caller, ws, { readOnly: true }, fn);
      this.d.metrics.count('capacity.reads', 1, { view, outcome: 'ok' });
      return out;
    } catch (err) {
      this.d.metrics.count('capacity.reads', 1, {
        view,
        outcome: err instanceof TenancyError ? err.code : 'error',
      });
      throw err;
    }
  }

  protected async capacityFor(
    tx: WorkspaceTransaction,
    p: Principal,
    who: Subject,
    from: string,
    to: string,
  ) {
    const cap = await this.capacityBrands(tx, p);
    // What brands this read may show: for oneself, every brand one can read; for someone else, the
    // brands where the viewer holds capacity.view (and can read).
    const brands = who.self ? cap.readable : cap.workspace ? cap.readable : cap.ids;
    const days = await this.availabilityOf(tx, who, from, to, brands);
    const start = dayBounds(from, who.tz).start;
    const end = dayBounds(to, who.tz).end;
    const blocks = await this.blocksOf(tx, p, who, start, end, brands);
    const estimates = await this.estimatesOf(tx, p, who, from, to);
    const reservations = await this.reservationsOf(tx, who, from, to, brands);
    const brandNames = new Map(
      (
        await sql<{
          id: string;
          public_id: string;
          name: string;
        }>`SELECT b.id, br.public_id, b.name FROM tenancy.brand b
          JOIN core.record br ON br.id = b.id WHERE b.workspace_id = ${tx.workspaceId}
            AND b.id = ANY(${brands.length ? brands : [NIL]}::uuid[])`.execute(tx.db)
      ).rows.map((b) => [b.id, b]),
    );
    const perDay = days.map((d) => {
      const dayStart = dayBounds(d.day, who.tz).start;
      const dayEnd = dayBounds(d.day, who.tz).end;
      const inDay = blocks.filter((b) => b.start < dayEnd && b.end > dayStart);
      const scheduled = minutes(
        intersect(
          inDay.map((b) => ({ start: b.start, end: b.end })),
          [{ start: dayStart, end: dayEnd }],
        ),
      );
      const est = estimates.filter((e) => e.day === d.day);
      return {
        day: d.day,
        weekday: isoWeekday(d.day),
        working_minutes: d.working,
        unavailable_minutes: d.off,
        available_minutes: d.available,
        holiday: d.holiday,
        scheduled_minutes: scheduled,
        estimated_minutes: est.reduce((n, e) => n + e.minutes, 0),
        unestimated_tasks: est.reduce((n, e) => n + e.unestimated, 0),
        ...allocation(
          d.available,
          Math.max(
            scheduled,
            est.reduce((n, e) => n + e.minutes, 0),
          ),
        ),
      };
    });
    const totalAvailable = perDay.reduce((n, d) => n + d.available_minutes, 0);
    const totalScheduled = perDay.reduce((n, d) => n + d.scheduled_minutes, 0);
    const totalEstimated = perDay.reduce((n, d) => n + d.estimated_minutes, 0);
    const spanDays = perDay.length;
    // Per brand: reservation (pro-rated by the days of the window each reservation covers),
    // scheduled block time, and estimated open work.
    const brandRows = new Map<string, { reserved: number; scheduled: number; estimated: number }>();
    const row = (id: string) => {
      if (!brandRows.has(id)) brandRows.set(id, { reserved: 0, scheduled: 0, estimated: 0 });
      return brandRows.get(id)!;
    };
    for (const r of reservations) {
      let daysCovered = 0;
      for (let d = from; d <= to; d = addDays(d, 1))
        if (d >= r.effective_from && (!r.effective_to || d <= r.effective_to)) daysCovered++;
      row(r.brand_id).reserved += Math.round((Number(r.minutes_per_week) * daysCovered) / 7);
    }
    for (const b of blocks)
      if (b.brand)
        row(b.brand).scheduled += Math.round((b.end.getTime() - b.start.getTime()) / 60_000);
    for (const e of estimates) row(e.brand).estimated += e.minutes;
    const brandsOut = [...brandRows.entries()]
      .filter(([id]) => brandNames.has(id))
      .map(([id, v]) => ({
        brand: { id: brandNames.get(id)!.public_id, name: brandNames.get(id)!.name },
        reserved_minutes: v.reserved,
        scheduled_minutes: v.scheduled,
        estimated_minutes: v.estimated,
        over_reservation_minutes: v.reserved ? Math.max(0, v.scheduled - v.reserved) : 0,
      }))
      .sort((a, b) => a.brand.name.localeCompare(b.brand.name));
    // Conflicts (CAL-009, WSB-018): overlapping blocks of different brands; and a brand whose
    // reservation cannot fit because other brands already use the remaining available time.
    const overlaps = crossBrandOverlaps(
      blocks
        .filter((b) => b.brand)
        .map((b) => ({ id: b.id, brand: b.brand, start: b.core.start, end: b.core.end })),
    ).map((o) => ({
      kind: 'overlap' as const,
      at: o.b.start.toISOString(),
      minutes: o.minutes,
      blocks: [o.a.id, o.b.id],
      brands: [brandNames.get(o.a.brand!)!.name, brandNames.get(o.b.brand!)!.name],
    }));
    const unmet = brandsOut
      .filter((b) => {
        const others = brandsOut
          .filter((x) => x.brand.id !== b.brand.id)
          .reduce((n, x) => n + x.scheduled_minutes, 0);
        return b.reserved_minutes > 0 && b.reserved_minutes > totalAvailable - others;
      })
      .map((b) => ({
        kind: 'reservation_unmet' as const,
        brand: b.brand.name,
        reserved_minutes: b.reserved_minutes,
        room_minutes: Math.max(
          0,
          totalAvailable -
            brandsOut
              .filter((x) => x.brand.id !== b.brand.id)
              .reduce((n, x) => n + x.scheduled_minutes, 0),
        ),
      }));
    const planned = Math.max(totalScheduled, totalEstimated);
    return {
      member: { id: who.publicId, name: who.name, self: who.self },
      timezone: who.tz,
      from,
      to,
      days: perDay,
      totals: {
        days: spanDays,
        available_minutes: totalAvailable,
        scheduled_minutes: totalScheduled,
        estimated_minutes: totalEstimated,
        reserved_minutes: brandsOut.reduce((n, b) => n + b.reserved_minutes, 0),
        ...allocation(totalAvailable, planned),
      },
      brands: brandsOut,
      conflicts: [...overlaps, ...unmet],
      // Only the person sees their own unbranded busy time as a separate figure.
      ...(who.self
        ? {
            unbranded_scheduled_minutes: blocks
              .filter((b) => !b.brand)
              .reduce((n, b) => n + Math.round((b.end.getTime() - b.start.getTime()) / 60_000), 0),
          }
        : {}),
    };
  }

  /**
   * Over and under allocation of a team (TIME-007): every active member who holds a reservation in
   * a brand where the viewer has capacity.view (or every member, with workspace capacity.view).
   */
  async teamCapacity(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.capacityRead('team', caller, ws, (tx, p) => this.teamCapacityIn(tx, p, query));
  }

  /** The team capacity read inside an open transaction (also used by 5D reports). */
  protected async teamCapacityIn(
    tx: WorkspaceTransaction,
    p: Principal,
    query: Record<string, unknown>,
  ) {
    {
      const cap = await this.capacityBrands(tx, p);
      if (!cap.workspace && !cap.ids.length) throw new TenancyError('forbidden');
      const tz = await this.personZone(tx, p.membershipId);
      const { from, to } = this.capacityRange(query, tz);
      let brandId: string | null = null;
      if (query.brand !== undefined) {
        brandId = (await findBrand(tx, p, query.brand)).id;
        if (!cap.workspace && !cap.ids.includes(brandId)) throw new TenancyError('forbidden');
      }
      const scope = brandId ? [brandId] : cap.ids;
      const people = (
        await sql<{ public_id: string }>`SELECT m.public_id FROM tenancy.membership m
          WHERE m.workspace_id = ${tx.workspaceId} AND m.kind = 'member' AND m.state = 'active'
            AND (${cap.workspace && !brandId} OR EXISTS (SELECT 1 FROM planning.capacity_reservation c
              WHERE c.workspace_id = m.workspace_id AND c.membership_id = m.id
                AND c.brand_id = ANY(${scope.length ? scope : [NIL]}::uuid[])
                AND c.effective_from <= ${to}::date AND (c.effective_to IS NULL OR c.effective_to >= ${from}::date)))
          ORDER BY m.id LIMIT ${this.ws.capacityPeopleMax + 1}`.execute(tx.db)
      ).rows;
      const truncated = people.length > this.ws.capacityPeopleMax;
      const out = [];
      for (const m of people.slice(0, this.ws.capacityPeopleMax)) {
        const who = await this.subject(tx, p, m.public_id);
        const c = await this.capacityFor(tx, p, who, from, to);
        out.push({
          member: c.member,
          totals: c.totals,
          brands: brandId ? c.brands.filter((b) => b.brand.id !== undefined) : c.brands,
          conflicts: c.conflicts.length,
        });
      }
      out.sort(
        (a, b) => b.totals.over - a.totals.over || a.member.name.localeCompare(b.member.name),
      );
      return { from, to, people: out, truncated };
    }
  }

  /**
   * Inputs for capacity-aware rescheduling (TIME-016): per day of the person's own window, free
   * minutes (available − max(scheduled, committed and estimated)), overcommitted days, locked and
   * focus time, and unscheduled open work. No proposal is made here (7F suggests; people decide).
   */
  async reschedulingInputs(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.capacityRead('rescheduling', caller, ws, async (tx, p) => {
      this.requirePersonal(p, 'personal.manage_own');
      const who = await this.subject(tx, p, 'me');
      const { from, to } = this.capacityRange(query, who.tz);
      const c = await this.capacityFor(tx, p, who, from, to);
      const committed = (
        await sql<{ day: string; minutes: string; locked: string }>`SELECT c.day::text AS day,
            coalesce(sum(coalesce(t.remaining_estimate_minutes, t.estimate_minutes)), 0)::text AS minutes,
            count(*) FILTER (WHERE c.locked)::text AS locked
          FROM planning.today_commitment c JOIN work.task t ON t.workspace_id = c.workspace_id AND t.id = c.task_id
          WHERE c.workspace_id = ${tx.workspaceId} AND c.owner_membership_id = ${p.membershipId}::uuid
            AND c.day BETWEEN ${from}::date AND ${to}::date AND c.outcome = 'open'
          GROUP BY 1`.execute(tx.db)
      ).rows;
      const byDay = new Map(committed.map((r) => [r.day, r]));
      const days = c.days.map((d) => {
        const com = Number(byDay.get(d.day)?.minutes ?? 0);
        const used = Math.max(d.scheduled_minutes, com, d.estimated_minutes);
        return {
          day: d.day,
          available_minutes: d.available_minutes,
          scheduled_minutes: d.scheduled_minutes,
          committed_minutes: com,
          estimated_minutes: d.estimated_minutes,
          locked_commitments: Number(byDay.get(d.day)?.locked ?? 0),
          free_minutes: Math.max(0, d.available_minutes - used),
          over_minutes: Math.max(0, used - d.available_minutes),
        };
      });
      return {
        from,
        to,
        timezone: who.tz,
        days,
        overcommitted_days: days.filter((d) => d.over_minutes > 0).map((d) => d.day),
        free_minutes: days.reduce((n, d) => n + d.free_minutes, 0),
        conflicts: c.conflicts,
        proposals: null,
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Canonical surfaces filled in: Today's capacity (PLAN-005/006/007, TIME-015) and workload (3B)
  // ---------------------------------------------------------------------------------------------

  protected override async dayView(tx: WorkspaceTransaction, p: Principal, day: string) {
    const view = await super.dayView(tx, p, day);
    const who = await this.subject(tx, p, 'me');
    const prof = await this.profileOf(tx, p.membershipId);
    const cap = await this.capacityBrands(tx, p);
    const [d] = await this.availabilityOf(tx, who, day, day, cap.readable);
    const planned = Math.max(view.totals.estimate_minutes, view.totals.block_minutes);
    const configured = prof.exists && prof.windows.length > 0;
    return {
      ...view,
      available_minutes: configured ? d!.available : null,
      capacity: configured
        ? {
            available: true,
            available_minutes: d!.available,
            working_minutes: d!.working,
            unavailable_minutes: d!.off,
            holiday: d!.holiday,
            planned_minutes: planned,
            over_minutes: Math.max(0, planned - d!.available),
            // TIME-015 / PLAN-007: the plan exceeds what the day has room for (a warning only).
            warning: planned > d!.available,
          }
        : { available: false, reason: 'no_working_hours' as const },
    };
  }

  /** The 3B workload grid with capacity per person and bucket where the viewer may see it. */
  override async workload(caller: Caller, ws: unknown, body: unknown) {
    const grid = await super.workload(caller, ws, body);
    const b = isObj(body) ? body : {};
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const cap = await this.capacityBrands(tx, p);
      const people = await Promise.all(
        grid.people.map(async (person) => {
          if (!person.id) return { ...person, capacity: null };
          let who: Subject;
          try {
            who = await this.subject(tx, p, person.id);
          } catch {
            return { ...person, capacity: null };
          }
          if (!who.self && !cap.workspace && !cap.ids.length) return { ...person, capacity: null };
          const days = await this.availabilityOf(
            tx,
            who,
            b.from as string,
            b.to as string,
            who.self || cap.workspace ? cap.readable : cap.ids,
          );
          const cells: Record<string, { available: number; over: number; under: number }> = {};
          for (const bucket of grid.buckets) {
            const next =
              grid.bucket === 'day'
                ? addDays(bucket, 1)
                : grid.bucket === 'week'
                  ? addDays(bucket, 7)
                  : (() => {
                      const d = new Date(`${bucket}T00:00:00Z`);
                      d.setUTCMonth(d.getUTCMonth() + 1);
                      return d.toISOString().slice(0, 10);
                    })();
            const available = days
              .filter((d) => d.day >= bucket && d.day < next)
              .reduce((n, d) => n + d.available, 0);
            const planned = person.cells[bucket]?.minutes ?? 0;
            const a = allocation(available, planned);
            cells[bucket] = { available, over: a.over, under: a.under };
          }
          return { ...person, capacity: cells };
        }),
      );
      return { ...grid, people, capacity: 'per_person' as const };
    });
  }
}
