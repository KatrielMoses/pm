import { recordJoins, recordProject } from '../collab/record-sql.ts';
import { change } from '@pm/audit';
import { newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  compileVisibility,
  decideBrand,
  decideWorkspace,
  invalid,
  issue,
  parseIfMatch,
  requireVersion,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { ReviewService } from '../collab/review-service.ts';
import { cursorAt } from '../collab/comment-service.ts';
import type { WorkDeps } from '../service.ts';
import { isPublic } from '../validation.ts';
import {
  externalLine,
  viewNotifications,
  type NotificationRow,
  type NotificationView,
} from './render.ts';
import { NOTIFICATION_TYPES, SECURITY_TYPES, systemDefault, typeLabel } from './semantics.ts';
import {
  clockText,
  parseBrowserAck,
  parseBulk,
  parseDeliveryQuery,
  parseListQuery,
  parsePreference,
  parsePreferenceKey,
  parseProfile,
  parseScopeDefault,
  parseStateChange,
} from './validation.ts';
import { validZone } from '../time/semantics.ts';
import { writeOutboxEvent } from '@pm/platform';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/**
 * Phase 4B notification centre, preferences, browser channel, and delivery visibility (ADR-0024;
 * 0B ADR-32, 0C AZ-32, 0D PL-34). Everything here is the caller's own (`personal.manage_own`:
 * no administrator reads another person's notifications or preferences), re-authorized at display.
 * Administrators see only delivery health and set brand and project defaults.
 */
export class NotificationService extends ReviewService {
  readonly #emailState: 'configured' | 'capture' | 'unconfigured';

  constructor(deps: ConstructorParameters<typeof ReviewService>[0] & Pick<WorkDeps, 'notify'>) {
    super(deps);
    this.#emailState = deps.notify?.emailState ?? 'unconfigured';
  }

  protected async trackRead<T>(view: string, fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      this.d.metrics.count('notify.reads', 1, { view, outcome: 'ok' });
      return out;
    } catch (err) {
      this.d.metrics.count('notify.reads', 1, {
        view,
        outcome: err instanceof TenancyError ? err.code : 'error',
      });
      throw err;
    }
  }

  protected arrayMax(): number {
    return this.c.settings.principalContextArrayMax;
  }

  // ---------------------------------------------------------------------------------------------
  // The notification centre
  // ---------------------------------------------------------------------------------------------

  /**
   * `GET /me/notifications`: newest first, by cursor, re-authorized as shown. Filters and search
   * only ever match what the viewer can read now; dismissed items stay findable by search (IA-52).
   */
  async listNotifications(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const q = parseListQuery(query, this.ws.notifySearchQueryMax);
    return this.trackRead('list', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const limit = this.pageLimit(q.limit);
        const fp = this.cursorFp(
          'notifications',
          q.tab,
          q.state,
          q.type,
          q.brand,
          q.project,
          q.unread,
          q.q,
        );
        const after = q.cursor !== undefined ? this.openCursor(p, fp, q.cursor) : null;
        const vis = await compileVisibility(tx, p, {
          need: 'view',
          includeArchived: true,
          arrayMax: this.arrayMax(),
        });
        const like = q.q ? `%${q.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
        const typeMatches = q.q
          ? NOTIFICATION_TYPES.filter((t) =>
              typeLabel(t).toLowerCase().includes(q.q!.toLowerCase()),
            )
          : [];
        const stateWhere = q.state
          ? sql`n.state = ${q.state}`
          : q.tab === 'saved'
            ? sql`n.state = 'saved'`
            : q.q
              ? sql`true`
              : sql`n.state <> 'dismissed'`;
        const tabWhere =
          q.tab === 'mentions'
            ? sql`n.type = 'mention'`
            : q.tab === 'reviews'
              ? sql`n.type IN ('review_requested', 'approval_decided')`
              : sql`true`;
        const rows = (
          await sql<NotificationRow & { cursor_at: string }>`
            SELECT n.id, n.public_id, n.type, n.record_id, n.actor_membership_id, n.facts, n.occurrences,
                   n.state, n.group_key, n.created_at, n.last_occurred_at, n.version,
                   ${cursorAt('n.last_occurred_at')} AS cursor_at
              FROM notify.notification n
              LEFT JOIN work.task t ON t.workspace_id = n.workspace_id AND t.id = n.record_id
              LEFT JOIN work.project w ON w.workspace_id = n.workspace_id AND w.id = n.record_id
              LEFT JOIN core.record r ON r.workspace_id = n.workspace_id AND r.id = n.record_id
                AND ${vis.where('r', { project: sql`COALESCE(t.project_id, w.id)` })}
              LEFT JOIN tenancy.membership am ON am.workspace_id = n.workspace_id AND am.id = n.actor_membership_id
              LEFT JOIN identity.account aa ON aa.id = am.account_id
              ${q.brand ? sql`LEFT JOIN core.record br ON br.workspace_id = r.workspace_id AND br.id = r.brand_id` : sql``}
              ${q.project ? sql`LEFT JOIN core.record pr ON pr.workspace_id = r.workspace_id AND pr.id = COALESCE(t.project_id, w.id)` : sql``}
             WHERE n.workspace_id = ${tx.workspaceId} AND n.recipient_membership_id = ${p.membershipId}
               AND ${stateWhere} AND ${tabWhere}
               ${q.unread ? sql`AND n.state = 'unread'` : sql``}
               ${q.type ? sql`AND n.type = ${q.type}` : sql``}
               ${q.brand ? sql`AND r.id IS NOT NULL AND br.public_id = ${q.brand}` : sql``}
               ${q.project ? sql`AND r.id IS NOT NULL AND pr.public_id = ${q.project}` : sql``}
               ${
                 like
                   ? sql`AND ((r.id IS NOT NULL AND lower(COALESCE(t.title, w.name)) LIKE ${like} ESCAPE '\\')
                        OR (${p.kind === 'member'} AND lower(coalesce(am.display_name_override, aa.display_name)) LIKE ${like} ESCAPE '\\')
                        ${typeMatches.length ? sql`OR n.type = ANY(${typeMatches}::text[])` : sql``})`
                   : sql``
               }
               ${after ? sql`AND (n.last_occurred_at, n.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
             ORDER BY n.last_occurred_at DESC, n.id DESC LIMIT ${limit + 1}`.execute(tx.db)
        ).rows.map((r) => ({ ...r, occurrences: Number(r.occurrences) }));
        const page = rows.slice(0, limit);
        const views = await viewNotifications(tx, p, page, this.arrayMax());
        // Repeats about one record collapse into the latest entry (COL-019): failures and
        // security notices never carry a group key, so they are never folded away.
        let data: Array<NotificationView & { group_count?: number; group_ids?: string[] }> = views;
        if (q.group) {
          const seen = new Map<
            string,
            NotificationView & { group_count?: number; group_ids?: string[] }
          >();
          data = [];
          for (const v of views) {
            const lead = v.group ? seen.get(v.group) : undefined;
            if (lead) {
              lead.group_count = (lead.group_count ?? 1) + 1;
              lead.group_ids = [...(lead.group_ids ?? [lead.id]), v.id];
              continue;
            }
            const entry = { ...v };
            if (v.group) seen.set(v.group, entry);
            data.push(entry);
          }
        }
        const last = page.at(-1);
        return {
          data,
          page: {
            limit,
            has_more: rows.length > limit,
            ...(rows.length > limit && last
              ? { next_cursor: this.sealCursor(p, fp, { at: last.cursor_at, id: last.id }) }
              : {}),
          },
        };
      }),
    );
  }

  /** `GET /me/notifications/counts`: the person's own unread numbers (badge and tabs). */
  async notificationCounts(caller: Caller, ws: unknown) {
    return this.trackRead('counts', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const r = await sql<{ unread: string; mentions: string; reviews: string; saved: string }>`
          SELECT count(*) FILTER (WHERE state = 'unread') AS unread,
                 count(*) FILTER (WHERE state = 'unread' AND type = 'mention') AS mentions,
                 count(*) FILTER (WHERE state = 'unread' AND type IN ('review_requested', 'approval_decided')) AS reviews,
                 count(*) FILTER (WHERE state = 'saved') AS saved
            FROM notify.notification
           WHERE workspace_id = ${tx.workspaceId} AND recipient_membership_id = ${p.membershipId}`.execute(
          tx.db,
        );
        const c = r.rows[0]!;
        return {
          unread: Number(c.unread),
          mentions_unread: Number(c.mentions),
          reviews_unread: Number(c.reviews),
          saved: Number(c.saved),
        };
      }),
    );
  }

  protected async ownRow(tx: WorkspaceTransaction, p: Principal, ntf: unknown, lock = false) {
    if (!isPublic(ntf, 'ntf')) throw new TenancyError('not_found');
    let q = tx.db
      .selectFrom('notify.notification')
      .selectAll()
      .where('public_id', '=', ntf)
      .where('recipient_membership_id', '=', p.membershipId);
    if (lock) q = q.forUpdate();
    // Someone else's notification is as absent as an unknown one.
    const row = await q.executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    return row;
  }

  protected async viewOne(tx: WorkspaceTransaction, p: Principal, id: string) {
    const row = await tx.db
      .selectFrom('notify.notification')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return (
      await viewNotifications(tx, p, [row as unknown as NotificationRow], this.arrayMax())
    )[0]!;
  }

  async getNotification(caller: Caller, ws: unknown, ntf: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const row = await this.ownRow(tx, p, ntf);
      return this.viewOne(tx, p, row.id);
    });
  }

  /** `PATCH /me/notifications/{id}`: read, unread, saved, or dismissed (COL-020). */
  async setNotificationState(
    caller: Caller,
    ws: unknown,
    ntf: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseStateChange(body);
    return this.mutate(
      caller,
      'notification.state',
      ws,
      req,
      async (tx, p) => {
        const row = await this.ownRow(tx, p, ntf, true);
        if (req.ifMatch !== undefined)
          requireVersion(parseIfMatch(req.ifMatch), Number(row.version));
        if (row.state !== input.state)
          await tx.db
            .updateTable('notify.notification')
            .set({
              state: input.state,
              state_changed_at: new Date(),
              version: Number(row.version) + 1,
            })
            .where('id', '=', row.id)
            .execute();
        return {
          status: 200,
          ref: { id: row.public_id, type: 'notification' },
          data: await this.viewOne(tx, p, row.id),
        };
      },
      async (tx, p, ref) => this.viewOne(tx, p, (await this.ownRow(tx, p, ref.id)).id),
    );
  }

  /** `POST /me/notifications:update`: named ids, or every notification in a tab (mark all read). */
  async bulkNotificationState(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = parseBulk(body, this.ws.notifyBulkStateMax);
    return this.mutate(
      caller,
      'notification.bulk_state',
      ws,
      req,
      async (tx, p) => {
        const set = {
          state: input.state,
          state_changed_at: new Date(),
          version: sql<number>`version + 1`,
        };
        let n: number;
        if (input.ids) {
          const r = await tx.db
            .updateTable('notify.notification')
            .set(set)
            .where('recipient_membership_id', '=', p.membershipId)
            .where('public_id', 'in', input.ids)
            .where('state', '<>', input.state)
            .executeTakeFirst();
          n = Number(r.numUpdatedRows);
        } else {
          const a = input.all!;
          const r =
            await sql`UPDATE notify.notification SET state = ${input.state}, state_changed_at = now(), version = version + 1
             WHERE workspace_id = ${tx.workspaceId} AND recipient_membership_id = ${p.membershipId}
               AND state <> ${input.state}
               ${a.tab === 'saved' ? sql`AND state = 'saved'` : sql`AND state IN ('unread', 'read')`}
               ${a.tab === 'mentions' ? sql`AND type = 'mention'` : a.tab === 'reviews' ? sql`AND type IN ('review_requested', 'approval_decided')` : sql``}
               ${a.type ? sql`AND type = ${a.type}` : sql``}`.execute(tx.db);
          n = Number(r.numAffectedRows ?? 0);
        }
        return {
          status: 200,
          ref: { id: p.membershipId, type: 'notification_update' },
          data: { id: p.membershipId, type: 'notification_update' as const, updated: n },
        };
      },
      async (_tx, p) => ({ id: p.membershipId, type: 'notification_update' as const, updated: 0 }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // The person's profile and preferences (COL-017, NTF-008 to NTF-010)
  // ---------------------------------------------------------------------------------------------

  protected async profileRow(tx: WorkspaceTransaction, p: Principal) {
    return tx.db
      .selectFrom('notify.profile')
      .selectAll()
      .where('membership_id', '=', p.membershipId)
      .executeTakeFirst();
  }

  protected profileView(
    row: Awaited<ReturnType<NotificationService['profileRow']>>,
    accountZone: string,
  ) {
    const quiet =
      row && row.quiet_start_minute !== null && row.quiet_end_minute !== null
        ? { start: clockText(row.quiet_start_minute), end: clockText(row.quiet_end_minute) }
        : null;
    return {
      timezone: row?.timezone ?? null,
      effective_timezone: validZone(row?.timezone) ?? accountZone,
      quiet_hours: quiet,
      email_enabled: row?.email_enabled ?? true,
      browser_enabled: row?.browser_enabled ?? false,
      browser_permission: row?.browser_permission ?? 'unknown',
      digest_cadence: row?.digest_cadence ?? 'daily',
      daily_digest_time: clockText(row?.daily_digest_minute ?? 480),
      weekly_digest_day: row?.weekly_digest_weekday ?? 1,
      weekly_digest_time: clockText(row?.weekly_digest_minute ?? 540),
      version: Number(row?.version ?? 0),
      // What each channel can truthfully do now (never "sent" when only queued, UXD-18).
      channels: {
        in_app: { state: 'available' as const },
        email: {
          state:
            this.#emailState === 'unconfigured'
              ? ('not_configured' as const)
              : ('available' as const),
          provider: this.#emailState,
        },
        browser: {
          state:
            row?.browser_enabled && row.browser_permission === 'granted'
              ? ('on' as const)
              : ('off' as const),
          permission: row?.browser_permission ?? 'unknown',
        },
      },
    };
  }

  protected async accountZoneOf(tx: WorkspaceTransaction, p: Principal): Promise<string> {
    const a = await tx.db
      .selectFrom('identity.account')
      .select('timezone')
      .where('id', '=', p.accountId)
      .executeTakeFirst();
    const w = await tx.db
      .selectFrom('tenancy.workspace')
      .select('timezone')
      .where('id', '=', tx.workspaceId)
      .executeTakeFirstOrThrow();
    return validZone(a?.timezone) ?? w.timezone;
  }

  async notificationProfile(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) =>
      this.profileView(await this.profileRow(tx, p), await this.accountZoneOf(tx, p)),
    );
  }

  /** `PUT /me/notification-profile` with `If-Match` (the profile is a subject, not a record). */
  async setNotificationProfile(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = parseProfile(body);
    return this.mutate(
      caller,
      'notification.profile',
      ws,
      req,
      async (tx, p) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`notify.profile:${p.membershipId}`}, 0))`.execute(
          tx.db,
        );
        const row = await this.profileRow(tx, p);
        const expected = req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : undefined;
        if (expected === undefined) throw new TenancyError('precondition_required');
        requireVersion(expected, Number(row?.version ?? 0));
        const set = {
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.quiet !== undefined
            ? {
                quiet_start_minute: input.quiet?.start ?? null,
                quiet_end_minute: input.quiet?.end ?? null,
              }
            : {}),
          ...(input.email_enabled !== undefined ? { email_enabled: input.email_enabled } : {}),
          ...(input.browser_enabled !== undefined
            ? { browser_enabled: input.browser_enabled }
            : {}),
          ...(input.browser_permission !== undefined
            ? { browser_permission: input.browser_permission }
            : {}),
          ...(input.digest_cadence !== undefined ? { digest_cadence: input.digest_cadence } : {}),
          ...(input.daily_digest_minute !== undefined
            ? { daily_digest_minute: input.daily_digest_minute }
            : {}),
          ...(input.weekly_digest_weekday !== undefined
            ? { weekly_digest_weekday: input.weekly_digest_weekday }
            : {}),
          ...(input.weekly_digest_minute !== undefined
            ? { weekly_digest_minute: input.weekly_digest_minute }
            : {}),
        };
        if (!row)
          await tx.db
            .insertInto('notify.profile')
            .values({
              workspace_id: tx.workspaceId,
              membership_id: p.membershipId,
              ...set,
              version: 1,
            })
            .execute();
        else if (Object.keys(set).length)
          await tx.db
            .updateTable('notify.profile')
            .set({ ...set, updated_at: new Date(), version: Number(row.version) + 1 })
            .where('membership_id', '=', p.membershipId)
            .execute();
        const view = this.profileView(
          await this.profileRow(tx, p),
          await this.accountZoneOf(tx, p),
        );
        return {
          status: 200,
          ref: { id: p.membershipId, type: 'notification_profile' },
          data: { id: p.membershipId, type: 'notification_profile' as const, ...view },
        };
      },
      async (tx, p) => ({
        id: p.membershipId,
        type: 'notification_profile' as const,
        ...this.profileView(await this.profileRow(tx, p), await this.accountZoneOf(tx, p)),
      }),
    );
  }

  /** The record a preference or default names, as a scope the caller can read. */
  protected async scopeOf(tx: WorkspaceTransaction, p: Principal, scope: string) {
    if (scope === 'workspace')
      return {
        kind: 'workspace' as const,
        id: null as string | null,
        brand: null as string | null,
      };
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      includeArchived: true,
      arrayMax: this.arrayMax(),
    });
    const r = await sql<{ id: string; record_type: string }>`
      SELECT r.id, r.record_type FROM core.record r
        ${recordJoins}
       WHERE r.public_id = ${scope} AND r.record_type IN ('brand', 'project', 'task', 'document')
         AND ${vis.where('r', { project: recordProject })}`.execute(tx.db);
    const row = r.rows[0];
    // Unknown and unreadable scopes are one answer.
    if (!row)
      throw invalid(
        issue('/scope', 'invalid_reference', 'Choose a brand, project, or task you can open.'),
      );
    return {
      kind: (row.record_type === 'task' || row.record_type === 'document' ? 'record' : row.record_type) as
        'brand' | 'project' | 'record',
      id: row.id,
      brand: null,
    };
  }

  /**
   * `GET /me/notification-preferences`: the person's rows, with the explicit system defaults so a
   * screen can show what applies without a row (UXD-18) and the bound.
   */
  async notificationPreferences(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const rows = await sql<{
        event_type: string;
        scope_kind: string;
        scope_public: string | null;
        scope_name: string | null;
        channel: string;
        mode: string;
        expires_at: Date | null;
        version: string;
      }>`SELECT pr.event_type, pr.scope_kind, rr.public_id AS scope_public,
               COALESCE(t.title, w.name, kd.title, b.name) AS scope_name, pr.channel, pr.mode, pr.expires_at, pr.version
          FROM notify.preference pr
          LEFT JOIN core.record rr ON rr.workspace_id = pr.workspace_id AND rr.id = pr.scope_record_id
          LEFT JOIN work.task t ON t.workspace_id = rr.workspace_id AND t.id = rr.id
          LEFT JOIN work.project w ON w.workspace_id = rr.workspace_id AND w.id = rr.id
          LEFT JOIN knowledge.document kd ON kd.workspace_id = rr.workspace_id AND kd.id = rr.id
          LEFT JOIN tenancy.brand b ON b.workspace_id = rr.workspace_id AND b.id = rr.id
         WHERE pr.membership_id = ${p.membershipId}
         ORDER BY pr.scope_kind, pr.event_type, pr.channel, pr.id`.execute(tx.db);
      // Names only for scopes the person can read now.
      const vis = await compileVisibility(tx, p, {
        need: 'view',
        includeArchived: true,
        arrayMax: this.arrayMax(),
      });
      const readable = new Set(
        (
          await sql<{ public_id: string }>`
            SELECT r.public_id FROM core.record r
              ${recordJoins}
             WHERE r.public_id = ANY(${rows.rows.flatMap((r) => (r.scope_public ? [r.scope_public] : []))}::text[])
               AND ${vis.where('r', { project: recordProject })}`.execute(tx.db)
        ).rows.map((r) => r.public_id),
      );
      return {
        data: rows.rows.map((r) => ({
          event_type: r.event_type,
          scope:
            r.scope_kind === 'workspace'
              ? 'workspace'
              : r.scope_public && readable.has(r.scope_public)
                ? r.scope_public
                : null,
          scope_kind: r.scope_kind,
          scope_name: r.scope_public && readable.has(r.scope_public) ? r.scope_name : null,
          channel: r.channel,
          mode: r.mode,
          expires_at: iso(r.expires_at),
        })),
        defaults: NOTIFICATION_TYPES.map((t) => ({
          event_type: t,
          label: typeLabel(t),
          in_app: systemDefault(t, 'in_app'),
          email: systemDefault(t, 'email'),
          browser: systemDefault(t, 'browser'),
          security: SECURITY_TYPES.has(t),
        })),
        limit: this.ws.notifyPreferencesMax,
      };
    });
  }

  /** Sets (or replaces) one preference or mute; idempotent on its key (NTF-008, NTF-010). */
  async setNotificationPreference(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = parsePreference(body, new Date());
    return this.mutate(
      caller,
      'notification.preference',
      ws,
      req,
      async (tx, p) => {
        const scope = await this.scopeOf(tx, p, input.scope);
        const count = await tx.db
          .selectFrom('notify.preference')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('membership_id', '=', p.membershipId)
          .executeTakeFirstOrThrow();
        const key = sql`workspace_id = ${tx.workspaceId} AND membership_id = ${p.membershipId} AND event_type = ${input.event_type}
          AND channel = ${input.channel} AND scope_kind = ${scope.kind}
          AND COALESCE(scope_record_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(${scope.id}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`;
        const existing = await sql<{
          id: string;
          version: string;
        }>`SELECT id, version FROM notify.preference WHERE ${key}`.execute(tx.db);
        if (existing.rows[0])
          await tx.db
            .updateTable('notify.preference')
            .set({
              mode: input.mode,
              expires_at: input.expires_at,
              updated_at: new Date(),
              version: Number(existing.rows[0].version) + 1,
            })
            .where('id', '=', existing.rows[0].id)
            .execute();
        else {
          if (Number(count.n) >= this.ws.notifyPreferencesMax)
            throw invalid(
              issue(
                '/',
                'too_many',
                `You can keep at most ${this.ws.notifyPreferencesMax} notification choices.`,
              ),
            );
          await tx.db
            .insertInto('notify.preference')
            .values({
              id: newUuidV7(),
              workspace_id: tx.workspaceId,
              membership_id: p.membershipId,
              event_type: input.event_type,
              scope_kind: scope.kind,
              scope_record_id: scope.id,
              channel: input.channel,
              mode: input.mode,
              expires_at: input.expires_at,
            })
            .execute();
        }
        return {
          status: 200,
          ref: { id: p.membershipId, type: 'notification_preference' },
          data: {
            id: p.membershipId,
            type: 'notification_preference' as const,
            ...this.echo(input),
          },
        };
      },
      async (_tx, p) => ({
        id: p.membershipId,
        type: 'notification_preference' as const,
        ...this.echo(input),
      }),
    );
  }

  protected echo(i: {
    event_type: string;
    scope: string;
    channel: string;
    mode: string;
    expires_at?: Date | null;
  }) {
    return {
      event_type: i.event_type,
      scope: i.scope,
      channel: i.channel,
      mode: i.mode,
      expires_at: iso(i.expires_at ?? null),
    };
  }

  /** Removes one preference or mute (idempotent: removing nothing succeeds). */
  async removeNotificationPreference(
    caller: Caller,
    ws: unknown,
    query: Record<string, unknown>,
    req: Mutation,
  ) {
    const key = parsePreferenceKey(query);
    return this.mutate(
      caller,
      'notification.preference_remove',
      ws,
      req,
      async (tx, p) => {
        const scope = await this.scopeOf(tx, p, key.scope);
        const r = await sql`DELETE FROM notify.preference
           WHERE workspace_id = ${tx.workspaceId} AND membership_id = ${p.membershipId} AND event_type = ${key.event_type}
             AND channel = ${key.channel} AND scope_kind = ${scope.kind}
             AND COALESCE(scope_record_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(${scope.id}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`.execute(
          tx.db,
        );
        return {
          status: 200,
          ref: { id: p.membershipId, type: 'notification_preference' },
          data: {
            id: p.membershipId,
            type: 'notification_preference' as const,
            removed: Number(r.numAffectedRows ?? 0),
          },
        };
      },
      async (_tx, p) => ({
        id: p.membershipId,
        type: 'notification_preference' as const,
        removed: 0,
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Browser channel: the person's own open browser acknowledges what it shows (NTF-003)
  // ---------------------------------------------------------------------------------------------

  /**
   * `GET /me/notifications/browser-pending`: deliveries waiting for this person's browser, each as
   * a minimal external line re-authorized now. One that can no longer be shown is suppressed.
   */
  async browserPending(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const profile = await this.profileRow(tx, p);
      if (!profile?.browser_enabled || profile.browser_permission !== 'granted')
        return { data: [] as Array<Record<string, string>> };
      const rows = await sql<NotificationRow & { delivery_id: string; delivery_public: string }>`
        SELECT n.id, n.public_id, n.type, n.record_id, n.actor_membership_id, n.facts, n.occurrences, n.state,
               n.group_key, n.created_at, n.last_occurred_at, n.version, dl.id AS delivery_id, dl.public_id AS delivery_public
          FROM notify.delivery dl JOIN notify.notification n ON n.workspace_id = dl.workspace_id AND n.id = dl.notification_id
         WHERE dl.recipient_membership_id = ${p.membershipId} AND dl.channel = 'browser' AND dl.state = 'pending'
           AND dl.next_attempt_at <= now()
         ORDER BY dl.next_attempt_at, dl.id LIMIT ${this.ws.notifyDeliveryBatchMax}`.execute(tx.db);
      const ws0 = await tx.db
        .selectFrom('tenancy.workspace')
        .select('public_id')
        .where('id', '=', tx.workspaceId)
        .executeTakeFirstOrThrow();
      const out: Array<Record<string, string>> = [];
      for (const r of rows.rows) {
        const line = await externalLine(tx, p, r, ws0.public_id, this.arrayMax());
        if (!line) {
          await tx.db
            .updateTable('notify.delivery')
            .set({
              state: 'suppressed',
              suppress_reason: 'access_lost',
              updated_at: new Date(),
              version: sql`version + 1`,
            })
            .where('id', '=', r.delivery_id)
            .execute();
          continue;
        }
        out.push({
          delivery: r.delivery_public,
          notification: r.public_id,
          title: line.line,
          path: line.path,
        });
      }
      return { data: out };
    });
  }

  /** The browser reports it showed the notification (delivered) or declined to (failed). */
  async acknowledgeBrowser(
    caller: Caller,
    ws: unknown,
    ndl: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseBrowserAck(body);
    return this.mutate(
      caller,
      'notification.browser_ack',
      ws,
      req,
      async (tx, p) => {
        if (!isPublic(ndl, 'ndl')) throw new TenancyError('not_found');
        const row = await tx.db
          .selectFrom('notify.delivery')
          .selectAll()
          .where('public_id', '=', ndl)
          .where('recipient_membership_id', '=', p.membershipId)
          .where('channel', '=', 'browser')
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new TenancyError('not_found');
        if (row.state !== 'pending')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'not_pending', 'This notification is no longer waiting.')],
          });
        const now = new Date();
        await tx.db
          .updateTable('notify.delivery')
          .set(
            input.shown
              ? {
                  state: 'delivered',
                  delivered_at: now,
                  ack_source: 'client',
                  attempts: row.attempts + 1,
                  updated_at: now,
                  version: Number(row.version) + 1,
                }
              : {
                  state: 'failed',
                  failure_class: 'permanent',
                  failure_code: 'client_declined',
                  attempts: row.attempts + 1,
                  updated_at: now,
                  version: Number(row.version) + 1,
                },
          )
          .where('id', '=', row.id)
          .execute();
        await writeOutboxEvent(tx, {
          type: 'notify.delivery.state_changed',
          aggregate: {
            type: 'notify.notification_delivery',
            id: row.id,
            sequence: Number(row.version) + 1,
          },
          data: {
            channel: 'browser',
            kind: 'notification',
            state: input.shown ? 'delivered' : 'failed',
            failure_class: input.shown ? null : 'permanent',
          },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
        });
        return {
          status: 200,
          ref: { id: row.public_id, type: 'notification_delivery' },
          data: {
            id: row.public_id,
            type: 'notification_delivery' as const,
            state: input.shown ? 'delivered' : 'failed',
          },
        };
      },
      async (tx, p, ref) => {
        const r = await tx.db
          .selectFrom('notify.delivery')
          .select(['public_id', 'state'])
          .where('public_id', '=', ref.id)
          .where('recipient_membership_id', '=', p.membershipId)
          .executeTakeFirst();
        if (!r) throw new TenancyError('not_found');
        return { id: r.public_id, type: 'notification_delivery' as const, state: r.state };
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Delivery history (mine) and delivery health (administrators)
  // ---------------------------------------------------------------------------------------------

  protected deliveryOut(r: {
    public_id: string;
    channel: string;
    kind: string;
    state: string;
    attempts: number;
    failure_class: string | null;
    failure_code: string | null;
    suppress_reason: string | null;
    created_at: Date;
    updated_at: Date;
    delivered_at: Date | null;
    ntf_public?: string | null;
    ntf_type?: string | null;
  }) {
    return {
      id: r.public_id,
      type: 'notification_delivery' as const,
      channel: r.channel,
      kind: r.kind,
      state: r.state,
      attempts: Number(r.attempts),
      failure_class: r.failure_class,
      failure_code: r.failure_code,
      suppress_reason: r.suppress_reason,
      notification: r.ntf_public ?? null,
      notification_type: r.ntf_type ?? null,
      created_at: iso(r.created_at)!,
      updated_at: iso(r.updated_at)!,
      delivered_at: iso(r.delivered_at),
    };
  }

  /** `GET /me/notification-deliveries`: what was sent, held, suppressed, or failed for me. */
  async myDeliveries(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const q = parseDeliveryQuery({
      ...query,
      state: query.state ?? 'pending,deferred_quiet_hours,delivered,failed,dead,suppressed,expired',
    });
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const limit = this.pageLimit(query.limit);
      const fp = this.cursorFp('my-deliveries', q.states, q.channel);
      const after = query.cursor !== undefined ? this.openCursor(p, fp, query.cursor) : null;
      const rows = (
        await sql<
          Parameters<NotificationService['deliveryOut']>[0] & { id: string; cursor_at: string }
        >`
          SELECT dl.id, dl.public_id, dl.channel, dl.kind, dl.state, dl.attempts, dl.failure_class, dl.failure_code,
                 dl.suppress_reason, dl.created_at, dl.updated_at, dl.delivered_at, n.public_id AS ntf_public,
                 n.type AS ntf_type, ${cursorAt('dl.created_at')} AS cursor_at
            FROM notify.delivery dl LEFT JOIN notify.notification n ON n.workspace_id = dl.workspace_id AND n.id = dl.notification_id
           WHERE dl.recipient_membership_id = ${p.membershipId} AND dl.state = ANY(${q.states}::text[])
             ${q.channel ? sql`AND dl.channel = ${q.channel}` : sql``}
             ${after ? sql`AND (dl.created_at, dl.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
           ORDER BY dl.created_at DESC, dl.id DESC LIMIT ${limit + 1}`.execute(tx.db)
      ).rows;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        data: page.map((r) => this.deliveryOut(r)),
        page: {
          limit,
          has_more: rows.length > limit,
          ...(rows.length > limit && last
            ? { next_cursor: this.sealCursor(p, fp, { at: last.cursor_at, id: last.id }) }
            : {}),
        },
      };
    });
  }

  /**
   * `GET /notification-deliveries`: failed and dead-lettered deliveries for administrators
   * (`health.view`): who, which channel, why, how many attempts. Never a title, body, or address.
   */
  async deliveryProblems(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const q = parseDeliveryQuery(query);
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const o = decideWorkspace(p, 'health.view');
      this.decision('health.view', o);
      if (!o.allowed) throw new TenancyError(o.code);
      const limit = this.pageLimit(query.limit);
      const fp = this.cursorFp('delivery-problems', q.states, q.channel);
      const after = query.cursor !== undefined ? this.openCursor(p, fp, query.cursor) : null;
      const rows = (
        await sql<
          Parameters<NotificationService['deliveryOut']>[0] & {
            id: string;
            cursor_at: string;
            who: string;
            who_name: string;
          }
        >`SELECT dl.id, dl.public_id, dl.channel, dl.kind, dl.state, dl.attempts, dl.failure_class, dl.failure_code,
                 dl.suppress_reason, dl.created_at, dl.updated_at, dl.delivered_at, n.public_id AS ntf_public,
                 n.type AS ntf_type, m.public_id AS who, coalesce(m.display_name_override, a.display_name) AS who_name,
                 ${cursorAt('dl.updated_at')} AS cursor_at
            FROM notify.delivery dl
            JOIN tenancy.membership m ON m.workspace_id = dl.workspace_id AND m.id = dl.recipient_membership_id
            JOIN identity.account a ON a.id = m.account_id
            LEFT JOIN notify.notification n ON n.workspace_id = dl.workspace_id AND n.id = dl.notification_id
           WHERE dl.state = ANY(${q.states}::text[]) ${q.channel ? sql`AND dl.channel = ${q.channel}` : sql``}
             ${after ? sql`AND (dl.updated_at, dl.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
           ORDER BY dl.updated_at DESC, dl.id DESC LIMIT ${limit + 1}`.execute(tx.db)
      ).rows;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        data: page.map((r) => ({
          ...this.deliveryOut(r),
          recipient: { id: r.who, name: r.who_name },
        })),
        page: {
          limit,
          has_more: rows.length > limit,
          ...(rows.length > limit && last
            ? { next_cursor: this.sealCursor(p, fp, { at: last.cursor_at, id: last.id }) }
            : {}),
        },
        email: this.#emailState,
      };
    });
  }

  /** Sends a failed or dead-lettered delivery back to the queue (reconciliation); audited. */
  async retryDelivery(caller: Caller, ws: unknown, ndl: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'notification.delivery_retry',
      ws,
      req,
      async (tx, p) => {
        const o = decideWorkspace(p, 'workspace.configure');
        this.decision('workspace.configure', o);
        if (!o.allowed) throw new TenancyError(o.code);
        if (!isPublic(ndl, 'ndl')) throw new TenancyError('not_found');
        const row = await tx.db
          .selectFrom('notify.delivery')
          .selectAll()
          .where('public_id', '=', ndl)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new TenancyError('not_found');
        if (row.state !== 'failed' && row.state !== 'dead')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'not_retryable', 'Only a failed delivery can be retried.')],
          });
        await tx.db
          .updateTable('notify.delivery')
          .set({
            state: 'pending',
            attempts: 0,
            next_attempt_at: new Date(),
            failure_class: null,
            failure_code: null,
            updated_at: new Date(),
            version: Number(row.version) + 1,
          })
          .where('id', '=', row.id)
          .execute();
        await this.workWriter.write(tx, this.cmd(caller, p, null), {
          action: 'notification.delivery_retried',
          target: { recordId: null, type: 'notification_delivery', publicId: row.public_id },
          changes: [
            change.plain('delivery_state', row.state, 'pending'),
            change.plain('channel', null, row.channel),
          ],
        });
        return {
          status: 200,
          ref: { id: row.public_id, type: 'notification_delivery' },
          data: { id: row.public_id, type: 'notification_delivery' as const, state: 'pending' },
        };
      },
      async (_tx, _p, ref) => ({
        id: ref.id,
        type: 'notification_delivery' as const,
        state: 'pending',
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Brand and project defaults (WSB-014; notifications.configure_scope)
  // ---------------------------------------------------------------------------------------------

  protected async scopeFor(tx: WorkspaceTransaction, p: Principal, rec: unknown) {
    if (isPublic(rec, 'br')) {
      const brand = await tx.db
        .selectFrom('core.record as r')
        .select(['r.id'])
        .where('r.public_id', '=', rec)
        .where('r.record_type', '=', 'brand')
        .executeTakeFirst();
      if (!brand) throw new TenancyError('not_found');
      const { facts } = await this.brandFactsOf(tx, brand.id);
      const o = decideBrand(p, 'notifications.configure_scope', facts);
      this.decision('notifications.configure_scope', o);
      if (!o.allowed) throw new TenancyError(o.code);
      return { kind: 'brand' as const, id: brand.id, brand: facts.id };
    }
    if (isPublic(rec, 'prj')) {
      const project = await this.loadProject(tx, p, rec);
      this.requireProjectScope(p, 'notifications.configure_scope', project);
      return { kind: 'project' as const, id: project.id, brand: project.brand.id };
    }
    throw new TenancyError('not_found');
  }

  async scopeDefaults(caller: Caller, ws: unknown, rec: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const scope = await this.scopeFor(tx, p, rec);
      const rows = await tx.db
        .selectFrom('notify.scope_default')
        .select(['event_type', 'channel', 'mode'])
        .where('scope_record_id', '=', scope.id)
        .orderBy('event_type')
        .orderBy('channel')
        .execute();
      return { data: rows };
    });
  }

  async setScopeDefault(caller: Caller, ws: unknown, rec: unknown, body: unknown, req: Mutation) {
    const input = parseScopeDefault(body);
    return this.mutate(
      caller,
      'notification.scope_default',
      ws,
      req,
      async (tx, p) => {
        const scope = await this.scopeFor(tx, p, rec);
        const key = {
          scope_record_id: scope.id,
          event_type: input.event_type,
          channel: input.channel as 'in_app' | 'email' | 'browser',
        };
        const existing = await tx.db
          .selectFrom('notify.scope_default')
          .select(['id', 'mode', 'version'])
          .where('scope_record_id', '=', key.scope_record_id)
          .where('event_type', '=', key.event_type)
          .where('channel', '=', key.channel)
          .executeTakeFirst();
        if (existing)
          await tx.db
            .updateTable('notify.scope_default')
            .set({
              mode: input.mode,
              set_by_membership_id: p.membershipId,
              updated_at: new Date(),
              version: Number(existing.version) + 1,
            })
            .where('id', '=', existing.id)
            .execute();
        else
          await tx.db
            .insertInto('notify.scope_default')
            .values({
              id: newUuidV7(),
              workspace_id: tx.workspaceId,
              scope_kind: scope.kind,
              ...key,
              mode: input.mode,
              set_by_membership_id: p.membershipId,
            })
            .execute();
        await this.workWriter.write(tx, this.cmd(caller, p, scope.brand), {
          action: 'notification.default_set',
          target: { recordId: scope.id, type: scope.kind, publicId: String(rec) },
          changes: [
            change.plain('event_type', null, input.event_type),
            change.plain('channel', null, input.channel),
            change.plain('mode', existing?.mode ?? null, input.mode),
          ],
        });
        return {
          status: 200,
          ref: { id: String(rec), type: scope.kind },
          data: {
            id: String(rec),
            type: 'notification_default' as const,
            event_type: input.event_type,
            channel: input.channel,
            mode: input.mode,
          },
        };
      },
      async (_tx, _p, ref) => ({
        id: ref.id,
        type: 'notification_default' as const,
        event_type: input.event_type,
        channel: input.channel,
        mode: input.mode,
      }),
    );
  }

  async removeScopeDefault(
    caller: Caller,
    ws: unknown,
    rec: unknown,
    query: Record<string, unknown>,
    req: Mutation,
  ) {
    const key = parsePreferenceKey({ ...query, scope: 'workspace' });
    return this.mutate(
      caller,
      'notification.scope_default_remove',
      ws,
      req,
      async (tx, p) => {
        const scope = await this.scopeFor(tx, p, rec);
        const r = await tx.db
          .deleteFrom('notify.scope_default')
          .where('scope_record_id', '=', scope.id)
          .where('event_type', '=', key.event_type)
          .where('channel', '=', key.channel as 'in_app' | 'email' | 'browser')
          .executeTakeFirst();
        if (Number(r.numDeletedRows))
          await this.workWriter.write(tx, this.cmd(caller, p, scope.brand), {
            action: 'notification.default_removed',
            target: { recordId: scope.id, type: scope.kind, publicId: String(rec) },
            changes: [
              change.plain('event_type', key.event_type, null),
              change.plain('channel', key.channel, null),
            ],
          });
        return {
          status: 200,
          ref: { id: String(rec), type: scope.kind },
          data: {
            id: String(rec),
            type: 'notification_default' as const,
            removed: Number(r.numDeletedRows),
          },
        };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'notification_default' as const, removed: 0 }),
    );
  }
}
