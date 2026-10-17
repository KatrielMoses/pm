import { randomBytes } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import type { WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import {
  compilePrincipal,
  findBrand,
  invalid,
  issue,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import type { Subject } from '../capacity/capacity-service.ts';
import { dayBounds } from '../planning/semantics.ts';
import { isPublic } from '../validation.ts';
import {
  grantedInternalScopes,
  pkcePair,
  ProviderError,
  type CalendarProvider,
} from './calendar-provider.ts';
import {
  clearSource,
  failureOf,
  plainTitle,
  ProviderFailure,
  refreshCalendarList,
  syncCalendarConnection,
  type SyncContext,
  type SyncHost,
} from './calendar-sync.ts';
import { PublicApiService } from './public-api-service.ts';
import type { Loaded } from './service.ts';
import { syncScopeAllowsWrite, type CredentialSecret, type ProviderId } from './semantics.ts';

const MAX_RANGE_DAYS = 62;

interface EventRow {
  public_id: string;
  title: string;
  starts_at: Date;
  ends_at: Date;
  event_tz: string;
  all_day: boolean;
  busy: boolean;
  status: string;
  calendar_id: string;
  series_id: string | null;
  detached: boolean;
  push_pending: boolean;
  health: string;
  source_public_id: string | null;
  calendar_label: string | null;
  direction: string | null;
  block_public_id: string | null;
}

/**
 * Google Calendar (Phase 6C, completed by the Phase 6 integration review: ADR-0034, ADR-0037).
 * Extends the public API layer without changing token or webhook behavior. Live connections run
 * through the configured provider adapter; `api_key` connections with the loopback flag are the
 * in-process test double and say so (`provider_mode: test_double`).
 *
 * Mirrored calendars are personal: only the connection's owner reads its calendars, events,
 * conflicts, and busy time. Administrators who may configure a connection see its health, never
 * its content. Other people never see busy time, not even anonymously (DQ-06). Moves follow the
 * connection owner's current authority through the canonical planning command, and never touch
 * due dates or deadlines (CAL-013).
 */
export class CalendarService extends PublicApiService {
  readonly #provider: CalendarProvider | null;

  constructor(
    deps: ConstructorParameters<typeof PublicApiService>[0] & {
      calendarProvider?: CalendarProvider | null;
    },
  ) {
    super(deps);
    this.#provider = deps.calendarProvider ?? null;
  }

  protected override configured(id: ProviderId): boolean {
    if (id === 'google_calendar')
      return this.#provider !== null || this.ws.googleCalendarLoopbackEnabled;
    return super.configured(id);
  }

  protected override connectionMode(row: Pick<Loaded, 'provider' | 'authKind'>) {
    if (row.provider !== 'google_calendar') return super.connectionMode(row);
    return row.authKind === 'oauth' && this.#provider
      ? ('live' as const)
      : ('test_double' as const);
  }

  // -------------------------------------------------------------------------------------------
  // Authorization (G2): OAuth 2.0 authorization code with PKCE and a state bound to the connection
  // -------------------------------------------------------------------------------------------

  protected override oauthStart(
    provider: ProviderId,
    scopes: string[],
    ctx: { workspace: string; connection: string },
  ) {
    if (provider !== 'google_calendar' || !this.#provider)
      return super.oauthStart(provider, scopes, ctx);
    const { verifier, challenge } = pkcePair();
    const state = `${ctx.workspace}.${ctx.connection}.${randomBytes(24).toString('base64url')}`;
    return {
      state,
      verifier,
      url: this.#provider.authorizationUrl({ state, codeChallenge: challenge, scopes }),
    };
  }

  protected override async oauthExchange(row: Loaded, secret: CredentialSecret, code: string) {
    if (row.provider !== 'google_calendar' || !this.#provider || !secret.pkce)
      return super.oauthExchange(row, secret, code);
    let t;
    try {
      t = await this.#provider.exchangeCode(code, secret.pkce);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const outage = err.kind === 'transient' || err.kind === 'rate';
      throw invalid(
        issue(
          '/code',
          outage ? 'provider_unavailable' : 'invalid',
          outage
            ? 'Google Calendar did not answer. Try connecting again.'
            : 'The authorization code is not usable.',
        ),
      );
    }
    if (!t.refreshToken)
      throw invalid(issue('/code', 'invalid', 'Offline access was not granted. Try again.'));
    return {
      secret: {
        v: 1 as const,
        kind: 'oauth' as const,
        token: randomBytes(24).toString('base64url'),
        mode: 'ok' as const,
        remote: [],
        oauth: {
          access: t.accessToken,
          refresh: t.refreshToken,
          expires_at: t.expiresAt,
          scopes: t.scope,
        },
      },
      scopes: grantedInternalScopes(row.scopes, t.scope),
    };
  }

  protected override async afterAuthorized(tx: WorkspaceTransaction, row: Loaded): Promise<void> {
    if (!this.#live(row)) return;
    const secret = await this.readConnectionSecret(tx, row);
    if (!secret?.oauth) return;
    // List the calendars now so the person can choose them; a failure leaves it to the next sync.
    try {
      await refreshCalendarList(this.#context(tx, row, { secret }, false));
    } catch (err) {
      if (!(err instanceof ProviderFailure)) throw err;
      this.d.metrics.count('integrations.jobs', 1, { kind: 'calendar_list', outcome: 'deferred' });
    }
  }

  protected override async revokeAtProvider(row: Loaded, secret: CredentialSecret | null) {
    if (!this.#provider || row.provider !== 'google_calendar' || !secret?.oauth) return;
    try {
      await this.#provider.revoke(secret.oauth.refresh ?? secret.oauth.access);
      this.d.metrics.count('integrations.requests', 1, { op: 'calendar_revoke', outcome: 'ok' });
    } catch {
      // Best effort: the local credential is destroyed regardless, so nothing here can use it.
      this.d.metrics.count('integrations.requests', 1, {
        op: 'calendar_revoke',
        outcome: 'failed',
      });
    }
  }

  protected override async afterDisconnectRetained(tx: WorkspaceTransaction, row: Loaded) {
    // Retained events stay readable to their owner; nothing more is written to the provider.
    await tx.db
      .updateTable('integrations.calendar_event')
      .set({ push_pending: false })
      .where('connection_id', '=', row.id)
      .where('push_pending', '=', true)
      .execute();
  }

  // -------------------------------------------------------------------------------------------
  // Synchronization (G3–G6)
  // -------------------------------------------------------------------------------------------

  protected override async syncProviderData(
    tx: WorkspaceTransaction,
    row: Loaded,
    secret: CredentialSecret,
    canWrite: boolean,
  ) {
    if (!this.#live(row) || !secret.oauth) return super.syncProviderData(tx, row, secret, canWrite);
    const totals = await syncCalendarConnection(this.#context(tx, row, { secret }, canWrite));
    this.d.metrics.count('integrations.jobs', 1, {
      kind: 'calendar_sync',
      outcome: totals.partial ? 'partial' : 'ok',
    });
    return totals;
  }

  #live(row: Pick<Loaded, 'provider' | 'authKind'>): boolean {
    return (
      row.provider === 'google_calendar' && row.authKind === 'oauth' && this.#provider !== null
    );
  }

  #context(
    tx: WorkspaceTransaction,
    row: Loaded,
    holder: { secret: CredentialSecret },
    canWrite: boolean,
  ): SyncContext {
    const provider = this.#provider!;
    const host: SyncHost = {
      access: async (force = false) => {
        const grant = holder.secret.oauth;
        if (!grant) throw new ProviderFailure('reauthorize', 'needs_reauthorization');
        if (!force && grant.expires_at - 60_000 > Date.now()) return grant.access;
        if (!grant.refresh) throw new ProviderFailure('reauthorize', 'needs_reauthorization');
        let t;
        try {
          t = await provider.refresh(grant.refresh);
        } catch (err) {
          if (err instanceof ProviderError) throw failureOf(err);
          throw err;
        }
        holder.secret = {
          ...holder.secret,
          oauth: {
            access: t.accessToken,
            refresh: t.refreshToken,
            expires_at: t.expiresAt,
            scopes: t.scope.length ? t.scope : grant.scopes,
          },
        };
        await this.storeConnectionSecret(tx, row, holder.secret);
        const fresh = await tx.db
          .selectFrom('integrations.connection')
          .select('credential_secret_ref')
          .where('id', '=', row.id)
          .executeTakeFirst();
        row.secretRef = fresh?.credential_secret_ref ?? null;
        return t.accessToken;
      },
      moveLinkedBlock: (blockId, start, end) => this.#moveLinked(tx, row, blockId, start, end),
      conflict: async (eventPublicId, local, remote) => {
        await this.recordConflict(tx, row, {
          type: 'calendar_event',
          externalId: eventPublicId,
          field: 'schedule',
          local,
          remote,
        });
      },
      conflictOpen: async (eventPublicId) => {
        const open = await tx.db
          .selectFrom('integrations.sync_conflict as c')
          .innerJoin('integrations.external_identity as i', 'i.id', 'c.external_identity_id')
          .select('c.id')
          .where('c.connection_id', '=', row.id)
          .where('i.external_type', '=', 'calendar_event')
          .where('i.external_id', '=', eventPublicId)
          .where('c.field_key', '=', 'schedule')
          .where('c.state', '=', 'open')
          .executeTakeFirst();
        return !!open;
      },
      linkReleased: (eventId, blockId, reason) =>
        this.#releaseLink(tx, row, eventId, blockId, reason),
    };
    return {
      tx,
      provider,
      connectionId: row.id,
      ownerId: row.ownerId,
      canWrite,
      settings: {
        pagesMax: this.ws.calendarSyncPagesMax,
        pastDays: this.ws.calendarSyncPastDays,
        horizonDays: this.ws.calendarSyncHorizonDays,
        calendarsMax: this.ws.calendarsPerConnectionMax,
        occurrencesMax: this.ws.calendarOccurrencesMax,
      },
      now: new Date(),
      host,
    };
  }

  async #ownerPrincipal(tx: WorkspaceTransaction, ownerId: string): Promise<Principal | null> {
    const m = await tx.db
      .selectFrom('tenancy.membership')
      .select(['id', 'account_id', 'kind', 'state'])
      .where('id', '=', ownerId)
      .executeTakeFirst();
    if (!m || m.state !== 'active' || m.kind !== 'member') return null;
    return compilePrincipal(tx, m.id, m.account_id, 'member');
  }

  /** CAL-012: a provider move applied to the linked block with the owner's current authority. */
  async #moveLinked(
    tx: WorkspaceTransaction,
    row: Loaded,
    blockId: string,
    start: Date,
    end: Date,
  ): Promise<{ ok: true; version: number } | { ok: false; reason: string }> {
    const owner = await this.#ownerPrincipal(tx, row.ownerId);
    if (!owner) return { ok: false, reason: 'unavailable' };
    const moved = await this.applyBlockMove(tx, owner, blockId, start, end);
    if (!moved.ok) {
      this.d.metrics.count('integrations.requests', 1, {
        op: 'calendar_block_move',
        outcome: moved.reason,
      });
      return moved;
    }
    await this.integrationAuditAs(
      tx,
      row,
      'work_block.moved',
      [
        change.plain(
          'starts_at',
          new Date(moved.row.starts_at).toISOString(),
          moved.start.toISOString(),
        ),
        change.plain('ends_at', new Date(moved.row.ends_at).toISOString(), moved.end.toISOString()),
        change.plain('source', null, 'calendar'),
      ],
      { recordId: moved.row.id, type: 'work_block', publicId: moved.row.public_id },
      moved.row.brand_id,
    );
    await writeOutboxEvent(tx, {
      type: 'planning.work_block.moved',
      aggregate: { type: 'planning.work_block', id: moved.row.id, sequence: moved.version },
      data: {
        starts_at: moved.start.toISOString(),
        ends_at: moved.end.toISOString(),
        source: moved.row.source,
      },
      actor: { type: 'integration', id: row.id, onBehalfOfMembershipId: row.ownerId },
      context: this.integrationContext(tx, row),
      ...(moved.row.brand_id ? { brandId: moved.row.brand_id } : {}),
    });
    this.d.metrics.count('integrations.requests', 1, { op: 'calendar_block_move', outcome: 'ok' });
    return { ok: true, version: moved.version };
  }

  async #releaseLink(
    tx: WorkspaceTransaction,
    row: Loaded,
    eventId: string,
    blockId: string,
    reason: string,
  ): Promise<void> {
    const ev = await tx.db
      .selectFrom('integrations.calendar_event')
      .select(['public_id'])
      .where('id', '=', eventId)
      .executeTakeFirst();
    await tx.db
      .updateTable('integrations.calendar_event')
      .set({
        linked_work_block_id: null,
        link_block_version: null,
        link_remote_version: null,
        push_pending: false,
      })
      .where('id', '=', eventId)
      .execute();
    if (ev) await this.#dropScheduleConflicts(tx, row.id, ev.public_id);
    const block = await tx.db
      .selectFrom('planning.work_block')
      .select(['public_id', 'brand_id'])
      .where('id', '=', blockId)
      .executeTakeFirst();
    await this.integrationAuditAs(
      tx,
      row,
      'calendar.link_released',
      [change.plain('reason', null, reason)],
      block ? { recordId: blockId, type: 'work_block', publicId: block.public_id } : undefined,
      block?.brand_id ?? null,
    );
  }

  async #dropScheduleConflicts(
    tx: WorkspaceTransaction,
    connectionId: string,
    eventPublicId: string,
  ) {
    const ident = await tx.db
      .selectFrom('integrations.external_identity')
      .select('id')
      .where('connection_id', '=', connectionId)
      .where('external_type', '=', 'calendar_event')
      .where('external_id', '=', eventPublicId)
      .executeTakeFirst();
    if (!ident) return;
    await tx.db
      .deleteFrom('integrations.sync_conflict')
      .where('external_identity_id', '=', ident.id)
      .where('state', '=', 'open')
      .execute();
  }

  // -------------------------------------------------------------------------------------------
  // Conflict resolution (explicit, by the owner; never silent)
  // -------------------------------------------------------------------------------------------

  protected override async resolveFieldConflict(
    tx: WorkspaceTransaction,
    p: Principal,
    row: Loaded,
    conflict: { id: string; field_key: string; external_identity_id: string },
    resolution: 'kept_local' | 'kept_remote' | 'dismissed',
  ): Promise<boolean> {
    if (conflict.field_key !== 'schedule')
      return super.resolveFieldConflict(tx, p, row, conflict, resolution);
    // Personal data: only the connection's owner resolves a schedule conflict.
    if (p.membershipId !== row.ownerId) throw new TenancyError('not_found');
    const ident = await tx.db
      .selectFrom('integrations.external_identity')
      .select('external_id')
      .where('id', '=', conflict.external_identity_id)
      .executeTakeFirstOrThrow();
    const ev = await tx.db
      .selectFrom('integrations.calendar_event as e')
      .leftJoin('integrations.calendar_source as s', 's.id', 'e.source_id')
      .select([
        'e.id',
        'e.public_id',
        'e.starts_at',
        'e.ends_at',
        'e.all_day',
        'e.remote_version',
        'e.linked_work_block_id',
        's.direction',
      ])
      .where('e.connection_id', '=', row.id)
      .where('e.public_id', '=', ident.external_id)
      .forUpdate('e')
      .executeTakeFirst();
    if (!ev || !ev.linked_work_block_id) return true; // the link already ended: nothing to apply
    const block = await tx.db
      .selectFrom('planning.work_block')
      .select(['id', 'version'])
      .where('id', '=', ev.linked_work_block_id)
      .executeTakeFirstOrThrow();
    if (resolution === 'dismissed') {
      await tx.db
        .updateTable('integrations.calendar_event')
        .set({
          linked_work_block_id: null,
          link_block_version: null,
          link_remote_version: null,
          push_pending: false,
        })
        .where('id', '=', ev.id)
        .execute();
      return true;
    }
    if (resolution === 'kept_remote') {
      if (ev.all_day)
        throw invalid(
          issue('/resolution', 'all_day', 'An all-day event cannot set a block’s time. Unlink it.'),
        );
      const moved = await this.applyBlockMove(
        tx,
        p,
        block.id,
        new Date(ev.starts_at),
        new Date(ev.ends_at),
      );
      if (!moved.ok)
        throw new TenancyError('conflict', {
          issues: [issue('/resolution', moved.reason, refusal(moved.reason))],
        });
      await tx.db
        .updateTable('integrations.calendar_event')
        .set({
          link_block_version: moved.version,
          link_remote_version: ev.remote_version,
          push_pending: false,
        })
        .where('id', '=', ev.id)
        .execute();
      return true;
    }
    // kept_local: the person's plan wins; the provider copy is overwritten deliberately.
    if (ev.direction !== 'two_way')
      throw invalid(
        issue(
          '/resolution',
          'read_only_calendar',
          'This calendar is read-only here. Keep the calendar’s time or unlink.',
        ),
      );
    if (!syncScopeAllowsWrite(row.scopes) || !this.#live(row) || row.health === 'disconnected')
      throw invalid(issue('/resolution', 'insufficient_scope', 'This connection cannot write.'));
    // Agree on the provider version the person saw, then push on the next sync run (queued now).
    await tx.db
      .updateTable('integrations.calendar_event')
      .set({
        link_block_version: Number(block.version),
        link_remote_version: ev.remote_version,
        push_pending: true,
      })
      .where('id', '=', ev.id)
      .execute();
    await this.queueSync(tx, row, `push-${ev.public_id}-v${block.version}-${Date.now()}`);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Block hooks (inside the person's own planning command)
  // -------------------------------------------------------------------------------------------

  protected override async afterBlockMoved(
    tx: WorkspaceTransaction,
    p: Principal,
    blockId: string,
  ) {
    const ev = await tx.db
      .selectFrom('integrations.calendar_event as e')
      .innerJoin('integrations.connection as c', 'c.id', 'e.connection_id')
      .innerJoin('integrations.calendar_source as s', 's.id', 'e.source_id')
      .select(['e.id', 'e.public_id', 'c.id as connection_id', 's.direction', 'c.health'])
      .where('e.linked_work_block_id', '=', blockId)
      .where('e.owner_membership_id', '=', p.membershipId)
      .executeTakeFirst();
    if (!ev || ev.direction !== 'two_way' || ev.health === 'disconnected') return;
    await tx.db
      .updateTable('integrations.calendar_event')
      .set({ push_pending: true })
      .where('id', '=', ev.id)
      .execute();
    await tx.db
      .insertInto('integrations.sync_delivery')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        connection_id: ev.connection_id,
        dedupe_key: `push-${ev.public_id}-${Date.now()}`,
      })
      .execute();
  }

  protected override async beforeBlockDeleted(
    tx: WorkspaceTransaction,
    p: Principal,
    blockId: string,
  ) {
    // The provider event stays as it is; only the link ends (nothing is deleted remotely).
    await tx.db
      .updateTable('integrations.calendar_event')
      .set({
        linked_work_block_id: null,
        link_block_version: null,
        link_remote_version: null,
        push_pending: false,
      })
      .where('linked_work_block_id', '=', blockId)
      .where('owner_membership_id', '=', p.membershipId)
      .execute();
  }

  // -------------------------------------------------------------------------------------------
  // Owner-only reads and commands
  // -------------------------------------------------------------------------------------------

  /** The connection's calendars (CAL-006): only its owner may list or choose them. */
  async listCalendars(caller: Caller, ws: unknown, conn: unknown) {
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const row = await this.#ownedConnection(tx, p, conn);
      return { calendars: await this.#calendarViews(tx, p, row) };
    });
  }

  /** Select calendars, their direction, and an optional brand mapping (CAL-006, WSB-010). */
  async updateCalendars(caller: Caller, ws: unknown, conn: unknown, body: unknown, req: Mutation) {
    const wanted = parseCalendars(body, this.ws.calendarsPerConnectionMax);
    return this.mutate(
      caller,
      'calendar.select',
      ws,
      req,
      async (tx, p) => {
        const row = await this.#ownedConnection(tx, p, conn, true);
        const writable = syncScopeAllowsWrite(row.scopes) && this.#live(row);
        let changed = 0;
        for (const w of wanted) {
          const src = await tx.db
            .selectFrom('integrations.calendar_source')
            .selectAll()
            .where('connection_id', '=', row.id)
            .where('public_id', '=', w.id)
            .forUpdate()
            .executeTakeFirst();
          if (!src || src.state !== 'active') throw new TenancyError('not_found');
          const direction = w.direction ?? src.direction;
          if (
            direction === 'two_way' &&
            (!writable || !['owner', 'writer'].includes(src.access_role))
          )
            throw invalid(
              issue(
                `/calendars/${w.index}/direction`,
                'read_only_calendar',
                'Two-way needs a writable calendar and write access for this connection.',
              ),
            );
          let brandId = src.brand_id;
          if (w.brand !== undefined) {
            if (w.brand === null) brandId = null;
            else {
              // The owner must be able to read the brand now; a hidden brand is unknown.
              const b = await findBrand(tx, p, w.brand);
              if (b.lifecycle_state !== 'active')
                throw new TenancyError('conflict', {
                  issues: [
                    issue(
                      `/calendars/${w.index}/brand`,
                      'brand_archived',
                      'This brand is archived.',
                    ),
                  ],
                });
              brandId = b.id;
            }
          }
          if (
            src.selected === w.selected &&
            src.direction === direction &&
            src.brand_id === brandId
          )
            continue;
          if (src.selected && !w.selected)
            await clearSource(
              {
                tx,
                connectionId: row.id,
                host: this.#context(tx, row, { secret: emptySecret() }, false).host,
              },
              src.id,
              'calendar_deselected',
            );
          await tx.db
            .updateTable('integrations.calendar_source')
            .set({
              selected: w.selected,
              direction,
              brand_id: brandId,
              updated_at: new Date(),
              version: Number(src.version) + 1,
            })
            .where('id', '=', src.id)
            .execute();
          changed += 1;
        }
        if (changed) {
          await this.integrationAuditAs(tx, row, 'connection.calendars_changed', [
            change.plain('calendars', null, String(changed)),
          ]);
          await this.queueSync(tx, row, `calendars-${req.idempotencyKey}`);
        }
        return {
          status: 200,
          ref: { id: row.publicId, type: 'connection' },
          data: {
            id: row.publicId,
            type: 'connection',
            calendars: await this.#calendarViews(tx, p, row),
          },
        };
      },
      async (tx, p, ref) => {
        const row = await this.#ownedConnection(tx, p, ref.id);
        return { id: ref.id, type: 'connection', calendars: await this.#calendarViews(tx, p, row) };
      },
    );
  }

  async #ownedConnection(tx: WorkspaceTransaction, p: Principal, conn: unknown, lock = false) {
    if (p.kind !== 'member') throw new TenancyError('not_found');
    const row = lock
      ? await this.lockedConnection(tx, p, conn)
      : await this.visibleConnection(tx, p, conn);
    // Calendars are the owner's personal data; anyone else gets the same opaque refusal.
    if (row.ownerId !== p.membershipId || row.provider !== 'google_calendar')
      throw new TenancyError('not_found');
    return row;
  }

  async #calendarViews(tx: WorkspaceTransaction, p: Principal, row: Loaded) {
    const rows = await tx.db
      .selectFrom('integrations.calendar_source as s')
      .leftJoin('core.record as br', 'br.id', 's.brand_id')
      .leftJoin('tenancy.brand as b', 'b.id', 's.brand_id')
      .select([
        's.public_id',
        's.label',
        's.calendar_tz',
        's.access_role',
        's.is_primary',
        's.selected',
        's.direction',
        's.brand_id',
        's.last_synced_at',
        'br.public_id as brand_public_id',
        'b.name as brand_name',
      ])
      .where('s.connection_id', '=', row.id)
      .where('s.state', '=', 'active')
      .orderBy('s.is_primary', 'desc')
      .orderBy('s.label')
      .orderBy('s.id')
      .execute();
    const readable = new Set<string>();
    for (const r of rows)
      if (r.brand_id && r.brand_public_id)
        try {
          await findBrand(tx, p, r.brand_public_id);
          readable.add(r.brand_id);
        } catch {
          // a brand the owner can no longer read is shown as unmapped
        }
    const canTwoWay = syncScopeAllowsWrite(row.scopes) && this.#live(row);
    return rows.map((r) => ({
      id: r.public_id,
      type: 'calendar_source' as const,
      label: r.label,
      timezone: r.calendar_tz,
      access_role: r.access_role,
      primary: r.is_primary,
      selected: r.selected,
      direction: r.direction,
      two_way_available: canTwoWay && (r.access_role === 'owner' || r.access_role === 'writer'),
      brand:
        r.brand_id && readable.has(r.brand_id)
          ? { id: r.brand_public_id!, name: r.brand_name! }
          : null,
      last_synced_at: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null,
    }));
  }

  /**
   * The person's own mirrored events in a window (PLAN-004, CAL-002, VIEW-003). Only selected
   * calendars count; events kept after a disconnect are listed as not synchronized.
   */
  async listCalendarEvents(caller: Caller, ws: unknown, query: { from?: string; to?: string }) {
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      if (p.kind !== 'member') throw new TenancyError('forbidden');
      const from = query.from ? new Date(query.from) : new Date(Date.now() - 7 * 86_400_000);
      const to = query.to ? new Date(query.to) : new Date(from.getTime() + 35 * 86_400_000);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from)
        throw invalid(issue('/from', 'invalid', 'Choose a valid range.'));
      if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000)
        throw invalid(issue('/to', 'too_long', `Choose at most ${MAX_RANGE_DAYS} days.`));
      const max = this.ws.calendarEventsListMax;
      const events = await this.#eventsIn(tx, p, from, to, max + 1);
      return {
        events: events.slice(0, max).map((e) => eventView(e)),
        has_more: events.length > max,
        connected: await this.#hasCalendar(tx, p),
      };
    });
  }

  /** The person's open schedule conflicts with both sides' times (owner only). */
  async listCalendarConflicts(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      if (p.kind !== 'member') throw new TenancyError('forbidden');
      const rows = await tx.db
        .selectFrom('integrations.sync_conflict as c')
        .innerJoin('integrations.external_identity as i', 'i.id', 'c.external_identity_id')
        .innerJoin('integrations.connection as k', 'k.id', 'c.connection_id')
        .innerJoin('core.record as kr', 'kr.id', 'k.id')
        .innerJoin('integrations.calendar_event as e', (j) =>
          j
            .onRef('e.public_id', '=', 'i.external_id')
            .onRef('e.connection_id', '=', 'c.connection_id'),
        )
        .leftJoin('planning.work_block as b', 'b.id', 'e.linked_work_block_id')
        .leftJoin('integrations.calendar_source as s', 's.id', 'e.source_id')
        .select([
          'c.public_id',
          'kr.public_id as connection_public_id',
          'e.public_id as event_public_id',
          'e.title',
          'e.starts_at',
          'e.ends_at',
          'e.all_day',
          'b.public_id as block_public_id',
          'b.starts_at as block_starts_at',
          'b.ends_at as block_ends_at',
          's.label as calendar_label',
          's.direction',
        ])
        .where('c.state', '=', 'open')
        .where('c.field_key', '=', 'schedule')
        .where('i.external_type', '=', 'calendar_event')
        .where('e.owner_membership_id', '=', p.membershipId)
        .where('k.owner_membership_id', '=', p.membershipId)
        .orderBy('c.created_at')
        .orderBy('c.id')
        .limit(100)
        .execute();
      return {
        conflicts: rows.map((r) => ({
          id: r.public_id,
          type: 'sync_conflict' as const,
          connection: r.connection_public_id,
          calendar: r.calendar_label,
          can_keep_local: r.direction === 'two_way',
          event: {
            id: r.event_public_id,
            title: r.title,
            starts_at: new Date(r.starts_at).toISOString(),
            ends_at: new Date(r.ends_at).toISOString(),
            all_day: r.all_day,
          },
          block: r.block_public_id
            ? {
                id: r.block_public_id,
                starts_at: new Date(r.block_starts_at!).toISOString(),
                ends_at: new Date(r.block_ends_at!).toISOString(),
              }
            : null,
        })),
      };
    });
  }

  /**
   * Puts a block on a two-way calendar (CAL-012): the provider event is created now, linked, and
   * from then on moves either way. A test-double connection refuses: nothing would really exist.
   */
  async publishBlock(caller: Caller, ws: unknown, blk: unknown, body: unknown, req: Mutation) {
    const calendar = isObjectBody(body) ? body.calendar : undefined;
    if (!isPublic(calendar, 'cal'))
      throw invalid(issue('/calendar', 'required', 'Choose a calendar.'));
    return this.mutate(
      caller,
      'calendar.publish',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const block = await this.blockRow(tx, p, blk);
        const src = await this.#ownedSource(tx, p, calendar);
        if (src.direction !== 'two_way' || !src.selected)
          throw invalid(
            issue('/calendar', 'read_only_calendar', 'Choose a selected two-way calendar.'),
          );
        const row = src.connection;
        if (!this.#live(row) || row.health === 'disconnected' || !syncScopeAllowsWrite(row.scopes))
          throw invalid(
            issue(
              '/calendar',
              'provider_unavailable',
              'This calendar connection cannot write now.',
            ),
          );
        const already = await tx.db
          .selectFrom('integrations.calendar_event')
          .select('id')
          .where('linked_work_block_id', '=', block.id)
          .executeTakeFirst();
        if (already)
          throw new TenancyError('conflict', {
            issues: [issue('/calendar', 'already_linked', 'This block is already on a calendar.')],
          });
        const title = plainTitle(
          block.task_id ? await this.#taskTitle(tx, p, block.task_id) : (block.title ?? undefined),
          'Work block',
        );
        const holder = { secret: (await this.readConnectionSecret(tx, row)) ?? emptySecret() };
        const ctx = this.#context(tx, row, holder, true);
        let ev;
        try {
          ev = await this.#provider!.insertEvent(
            await ctx.host.access(),
            src.external_calendar_id,
            {
              summary: title,
              start: {
                dateTime: new Date(block.starts_at).toISOString(),
                timeZone: block.source_tz,
              },
              end: { dateTime: new Date(block.ends_at).toISOString(), timeZone: block.source_tz },
            },
          );
        } catch (err) {
          if (err instanceof ProviderError || err instanceof ProviderFailure)
            throw invalid(
              issue(
                '/calendar',
                'provider_unavailable',
                'Google Calendar did not accept the event. Try again.',
              ),
            );
          throw err;
        }
        const publicId = newPublicId('cev');
        const etag = ev.etag.slice(0, 80);
        await tx.db
          .insertInto('integrations.calendar_event')
          .values({
            id: newUuidV7(),
            public_id: publicId,
            workspace_id: tx.workspaceId,
            connection_id: row.id,
            owner_membership_id: p.membershipId,
            calendar_id: src.external_calendar_id,
            external_event_id: ev.id.slice(0, 200),
            source_id: src.id,
            starts_at: new Date(block.starts_at),
            ends_at: new Date(block.ends_at),
            event_tz: block.source_tz,
            title,
            busy: true,
            remote_version: etag,
            linked_work_block_id: block.id,
            link_block_version: Number(block.version),
            link_remote_version: etag,
          })
          .execute();
        await this.planAudit(
          tx,
          caller,
          p,
          'work_block.calendar_linked',
          { id: block.id, type: 'work_block', publicId: block.public_id },
          [change.plain('calendar', null, 'linked')],
          block.brand_id,
        );
        return {
          status: 201,
          ref: { id: publicId, type: 'calendar_event' },
          data: await this.#oneEvent(tx, p, publicId),
        };
      },
      async (tx, p, ref) => this.#oneEvent(tx, p, ref.id),
    );
  }

  /** Links an existing event to one of the person's blocks (inbound moves follow it). */
  async linkEvent(caller: Caller, ws: unknown, cev: unknown, body: unknown, req: Mutation) {
    const blk = isObjectBody(body) ? body.block : undefined;
    return this.mutate(
      caller,
      'calendar.link',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const block = await this.blockRow(tx, p, blk);
        const ev = await tx.db
          .selectFrom('integrations.calendar_event')
          .selectAll()
          .where('public_id', '=', isPublic(cev, 'cev') ? cev : 'cev_0')
          .where('owner_membership_id', '=', p.membershipId)
          .forUpdate()
          .executeTakeFirst();
        if (!ev) throw new TenancyError('not_found');
        if (ev.all_day)
          throw invalid(issue('/event', 'all_day', 'An all-day event cannot carry a work block.'));
        if (ev.linked_work_block_id)
          throw new TenancyError('conflict', {
            issues: [issue('/event', 'already_linked', 'This event is already linked.')],
          });
        const taken = await tx.db
          .selectFrom('integrations.calendar_event')
          .select('id')
          .where('linked_work_block_id', '=', block.id)
          .executeTakeFirst();
        if (taken)
          throw new TenancyError('conflict', {
            issues: [issue('/block', 'already_linked', 'This block is already on a calendar.')],
          });
        await tx.db
          .updateTable('integrations.calendar_event')
          .set({
            linked_work_block_id: block.id,
            link_block_version: Number(block.version),
            link_remote_version: ev.remote_version,
            push_pending: false,
          })
          .where('id', '=', ev.id)
          .execute();
        await this.planAudit(
          tx,
          caller,
          p,
          'work_block.calendar_linked',
          { id: block.id, type: 'work_block', publicId: block.public_id },
          [change.plain('calendar', null, 'linked')],
          block.brand_id,
        );
        return {
          status: 200,
          ref: { id: ev.public_id, type: 'calendar_event' },
          data: await this.#oneEvent(tx, p, ev.public_id),
        };
      },
      async (tx, p, ref) => this.#oneEvent(tx, p, ref.id),
    );
  }

  /** Ends a block's calendar link; neither side's time changes and nothing is deleted. */
  async unlinkBlock(caller: Caller, ws: unknown, blk: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'calendar.unlink',
      ws,
      req,
      async (tx, p) => {
        this.requirePersonal(p, 'personal.manage_own');
        const block = await this.blockRow(tx, p, blk);
        const ev = await tx.db
          .selectFrom('integrations.calendar_event')
          .select(['id', 'public_id', 'connection_id'])
          .where('linked_work_block_id', '=', block.id)
          .where('owner_membership_id', '=', p.membershipId)
          .executeTakeFirst();
        if (!ev) throw new TenancyError('not_found');
        await this.beforeBlockDeleted(tx, p, block.id);
        await this.#dropScheduleConflicts(tx, ev.connection_id, ev.public_id);
        await this.planAudit(
          tx,
          caller,
          p,
          'work_block.calendar_unlinked',
          { id: block.id, type: 'work_block', publicId: block.public_id },
          [change.plain('calendar', 'linked', null)],
          block.brand_id,
        );
        return {
          status: 200,
          ref: { id: ev.public_id, type: 'calendar_event' },
          data: await this.#oneEvent(tx, p, ev.public_id),
        };
      },
      async (tx, p, ref) => this.#oneEvent(tx, p, ref.id),
    );
  }

  async #taskTitle(tx: WorkspaceTransaction, p: Principal, taskId: string) {
    try {
      const t = await this.plannableTask(tx, p, await this.publicOf(tx, taskId));
      return t.title;
    } catch {
      return undefined;
    }
  }

  async #ownedSource(tx: WorkspaceTransaction, p: Principal, publicId: string) {
    const src = await tx.db
      .selectFrom('integrations.calendar_source')
      .selectAll()
      .where('public_id', '=', publicId)
      .where('owner_membership_id', '=', p.membershipId)
      .where('state', '=', 'active')
      .executeTakeFirst();
    if (!src) throw new TenancyError('not_found');
    const pub = await tx.db
      .selectFrom('core.record')
      .select('public_id')
      .where('id', '=', src.connection_id)
      .executeTakeFirstOrThrow();
    const connection = await this.#ownedConnection(tx, p, pub.public_id);
    return { ...src, connection };
  }

  async #hasCalendar(tx: WorkspaceTransaction, p: Principal) {
    const r = await tx.db
      .selectFrom('integrations.connection')
      .select('id')
      .where('owner_membership_id', '=', p.membershipId)
      .where('provider', '=', 'google_calendar')
      .where('lifecycle_state', '=', 'active')
      .executeTakeFirst();
    return !!r;
  }

  async #eventsIn(
    tx: WorkspaceTransaction,
    p: Principal,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<EventRow[]> {
    return tx.db
      .selectFrom('integrations.calendar_event as e')
      .innerJoin('integrations.connection as c', 'c.id', 'e.connection_id')
      .leftJoin('integrations.calendar_source as s', 's.id', 'e.source_id')
      .leftJoin('planning.work_block as b', 'b.id', 'e.linked_work_block_id')
      .select([
        'e.public_id',
        'e.title',
        'e.starts_at',
        'e.ends_at',
        'e.event_tz',
        'e.all_day',
        'e.busy',
        'e.status',
        'e.calendar_id',
        'e.series_id',
        'e.detached',
        'e.push_pending',
        'c.health',
        's.public_id as source_public_id',
        's.label as calendar_label',
        's.direction',
        'b.public_id as block_public_id',
      ])
      .where('e.owner_membership_id', '=', p.membershipId)
      .where('c.owner_membership_id', '=', p.membershipId)
      .where('c.lifecycle_state', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('e.source_id', 'is', null),
          eb.and([eb('s.selected', '=', true), eb('s.state', '=', 'active')]),
        ]),
      )
      .where('e.ends_at', '>', from)
      .where('e.starts_at', '<', to)
      .orderBy('e.starts_at')
      .orderBy('e.id')
      .limit(limit)
      .execute() as Promise<EventRow[]>;
  }

  /**
   * 7C: the caller's own mirrored event, as AI context. Only the connection owner reads it (the
   * same rule as the calendar view); anything else is not found. Only the title, times, busy flag,
   * and status exist in the mirror: no attendees, location, or description are stored.
   */
  protected async ownCalendarEvent(tx: WorkspaceTransaction, p: Principal, publicId: string) {
    const view = await this.#oneEvent(tx, p, publicId);
    const row = await tx.db
      .selectFrom('integrations.calendar_event')
      .select('id')
      .where('public_id', '=', publicId)
      .executeTakeFirstOrThrow();
    return { ...view, recordId: row.id };
  }

  async #oneEvent(tx: WorkspaceTransaction, p: Principal, publicId: string) {
    const row = await tx.db
      .selectFrom('integrations.calendar_event')
      .select(['starts_at', 'ends_at'])
      .where('public_id', '=', publicId)
      .where('owner_membership_id', '=', p.membershipId)
      .executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    const all = await this.#eventsIn(
      tx,
      p,
      new Date(new Date(row.starts_at).getTime() - 1),
      new Date(new Date(row.ends_at).getTime() + 1),
      this.ws.calendarEventsListMax,
    );
    const e = all.find((x) => x.public_id === publicId);
    if (!e) throw new TenancyError('not_found');
    return eventView(e);
  }

  // -------------------------------------------------------------------------------------------
  // Today, capacity, and conflicts (PLAN-004, CAL-008, CAL-010)
  // -------------------------------------------------------------------------------------------

  protected override async externalBusy(
    tx: WorkspaceTransaction,
    who: Subject,
    start: Date,
    end: Date,
  ) {
    const rows = await tx.db
      .selectFrom('integrations.calendar_event as e')
      .innerJoin('integrations.connection as c', 'c.id', 'e.connection_id')
      .leftJoin('integrations.calendar_source as s', 's.id', 'e.source_id')
      .select(['e.public_id', 'e.starts_at', 'e.ends_at', 's.brand_id'])
      .where('e.owner_membership_id', '=', who.membershipId)
      .where('c.owner_membership_id', '=', who.membershipId)
      .where('c.lifecycle_state', '=', 'active')
      .where('c.health', '<>', 'disconnected')
      .where('e.busy', '=', true)
      // A block's own calendar copy is the block: never counted twice.
      .where('e.linked_work_block_id', 'is', null)
      .where((eb) =>
        eb.or([
          eb('e.source_id', 'is', null),
          eb.and([eb('s.selected', '=', true), eb('s.state', '=', 'active')]),
        ]),
      )
      .where('e.ends_at', '>', start)
      .where('e.starts_at', '<', end)
      .orderBy('e.starts_at')
      .orderBy('e.id')
      .limit(this.ws.calendarEventsListMax)
      .execute();
    return rows.map((r) => ({
      id: r.public_id,
      start: new Date(r.starts_at),
      end: new Date(r.ends_at),
      brand: r.brand_id ?? null,
    }));
  }

  protected override async dayView(tx: WorkspaceTransaction, p: Principal, day: string) {
    const view = await super.dayView(tx, p, day);
    const { tz } = await this.todayFor(tx, p);
    const { start, end } = dayBounds(day, tz);
    const connected = await this.#hasCalendar(tx, p);
    const events = connected
      ? (await this.#eventsIn(tx, p, start, end, this.ws.calendarEventsListMax)).map(eventView)
      : [];
    const links = new Map(
      events
        .filter((e) => e.link)
        .map((e) => [
          e.link!.block,
          { event: e.id, pending: e.link!.pending, calendar: e.calendar.label },
        ]),
    );
    const own = events.filter((e) => !e.link);
    return {
      ...view,
      scheduled: view.scheduled.map((b) => ({ ...b, calendar: links.get(b.id) ?? null })),
      meetings: connected
        ? {
            available: true as const,
            events: own,
            busy_minutes: busyMinutes(
              own.filter((e) => e.busy),
              start,
              end,
            ),
          }
        : { available: false as const, reason: 'not_connected' as const },
    };
  }
}

function eventView(e: EventRow) {
  return {
    id: e.public_id,
    type: 'calendar_event' as const,
    title: e.title,
    starts_at: new Date(e.starts_at).toISOString(),
    ends_at: new Date(e.ends_at).toISOString(),
    event_tz: e.event_tz,
    all_day: e.all_day,
    busy: e.busy,
    status: e.status,
    recurring: e.series_id !== null,
    moved_occurrence: e.detached,
    calendar: e.source_public_id
      ? { id: e.source_public_id, label: e.calendar_label ?? '', direction: e.direction ?? 'read' }
      : { id: null, label: e.calendar_id, direction: 'read' },
    synchronized: e.health !== 'disconnected',
    link: e.block_public_id ? { block: e.block_public_id, pending: e.push_pending } : null,
  };
}

function busyMinutes(
  events: Array<{ starts_at: string; ends_at: string }>,
  start: Date,
  end: Date,
) {
  const spans = events
    .map((e) => ({
      s: Math.max(new Date(e.starts_at).getTime(), start.getTime()),
      t: Math.min(new Date(e.ends_at).getTime(), end.getTime()),
    }))
    .filter((x) => x.t > x.s)
    .sort((a, b) => a.s - b.s);
  let total = 0;
  let cur: { s: number; t: number } | null = null;
  for (const x of spans) {
    if (cur && x.s <= cur.t) cur.t = Math.max(cur.t, x.t);
    else {
      if (cur) total += cur.t - cur.s;
      cur = { ...x };
    }
  }
  if (cur) total += cur.t - cur.s;
  return Math.round(total / 60_000);
}

function refusal(reason: string): string {
  switch (reason) {
    case 'locked':
      return 'The block is locked. Unlock it, then choose again.';
    case 'focus_protected':
      return 'That time overlaps a focus block.';
    case 'unavailable':
      return 'You can no longer plan this block’s task.';
    case 'too_many':
      return 'That day already holds as many blocks as it can.';
    default:
      return 'That time cannot hold this block.';
  }
}

function isObjectBody(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function emptySecret(): CredentialSecret {
  return { v: 1, kind: 'api_key', token: 'unavailable', mode: 'ok', remote: [] };
}

function parseCalendars(body: unknown, max: number) {
  const list = isObjectBody(body) ? body.calendars : undefined;
  if (!Array.isArray(list) || list.length < 1 || list.length > max)
    throw invalid(issue('/calendars', 'invalid', 'Choose the calendars to change.'));
  const seen = new Set<string>();
  return list.map((raw: unknown, index) => {
    if (!isObjectBody(raw))
      throw invalid(issue(`/calendars/${index}`, 'invalid_type', 'Expected an object.'));
    if (!isPublic(raw.id, 'cal') || seen.has(raw.id))
      throw invalid(issue(`/calendars/${index}/id`, 'invalid', 'Choose a listed calendar.'));
    seen.add(raw.id);
    if (typeof raw.selected !== 'boolean')
      throw invalid(
        issue(`/calendars/${index}/selected`, 'invalid', 'Choose whether to include it.'),
      );
    const direction = raw.direction;
    if (direction !== undefined && direction !== 'read' && direction !== 'two_way')
      throw invalid(
        issue(`/calendars/${index}/direction`, 'invalid_option', 'Choose read or two-way.'),
      );
    const brand = raw.brand;
    if (brand !== undefined && brand !== null && (typeof brand !== 'string' || brand.length < 3))
      throw invalid(issue(`/calendars/${index}/brand`, 'invalid', 'Choose a brand, or none.'));
    return {
      index,
      id: raw.id,
      selected: raw.selected,
      direction: direction as 'read' | 'two_way' | undefined,
      brand: brand as string | null | undefined,
    };
  });
}
