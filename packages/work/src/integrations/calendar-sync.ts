import { newPublicId, newUuidV7 } from '@pm/contracts';
import type { WorkspaceTransaction } from '@pm/db';
import {
  ProviderError,
  type CalendarProvider,
  type ProviderCalendar,
  type ProviderEvent,
} from './calendar-provider.ts';
import {
  expand,
  isMaster,
  normalizeRecurrence,
  originalKey,
  spanOf,
  type EventSpan,
} from './calendar-recurrence.ts';
import type { CalendarEventSecret } from './semantics.ts';

// ---------------------------------------------------------------------------------------------
// The 6A/6C loopback double: events carried in the sealed test credential. Test only.
// ---------------------------------------------------------------------------------------------

export async function upsertCalendarEvents(
  tx: WorkspaceTransaction,
  input: {
    connectionId: string;
    ownerMembershipId: string;
    events: CalendarEventSecret[];
    canWrite: boolean;
  },
): Promise<{ reads: number; writes: number }> {
  let reads = 0;
  let writes = 0;
  for (const ev of input.events) {
    reads += 1;
    const current = await tx.db
      .selectFrom('integrations.calendar_event')
      .select(['id', 'remote_version', 'version'])
      .where('connection_id', '=', input.connectionId)
      .where('calendar_id', '=', ev.calendar_id)
      .where('external_event_id', '=', ev.external_event_id)
      .executeTakeFirst();
    if (current && current.remote_version === ev.version) continue;
    if (!input.canWrite) continue;
    if (current) {
      await tx.db
        .updateTable('integrations.calendar_event')
        .set({
          title: ev.title.slice(0, 500),
          starts_at: new Date(ev.starts_at),
          ends_at: new Date(ev.ends_at),
          event_tz: ev.event_tz,
          all_day: ev.all_day ?? false,
          busy: ev.busy !== false,
          remote_version: ev.version,
          updated_at: new Date(),
          version: Number(current.version) + 1,
        })
        .where('id', '=', current.id)
        .execute();
    } else {
      await tx.db
        .insertInto('integrations.calendar_event')
        .values({
          id: newUuidV7(),
          public_id: newPublicId('cev'),
          workspace_id: tx.workspaceId,
          connection_id: input.connectionId,
          owner_membership_id: input.ownerMembershipId,
          calendar_id: ev.calendar_id,
          external_event_id: ev.external_event_id,
          starts_at: new Date(ev.starts_at),
          ends_at: new Date(ev.ends_at),
          event_tz: ev.event_tz,
          all_day: ev.all_day ?? false,
          title: ev.title.slice(0, 500),
          busy: ev.busy !== false,
          remote_version: ev.version,
        })
        .execute();
    }
    writes += 1;
  }
  return { reads, writes };
}

/** Removes everything a connection mirrored (disconnect with `remove`, purge). */
export async function deleteCalendarEventsForConnection(
  tx: WorkspaceTransaction,
  connectionId: string,
): Promise<void> {
  await tx.db
    .deleteFrom('integrations.calendar_event')
    .where('connection_id', '=', connectionId)
    .execute();
  await tx.db
    .deleteFrom('integrations.calendar_series')
    .where('connection_id', '=', connectionId)
    .execute();
  await tx.db
    .deleteFrom('integrations.calendar_source')
    .where('connection_id', '=', connectionId)
    .execute();
  await tx.db
    .deleteFrom('integrations.connection_mapping')
    .where('connection_id', '=', connectionId)
    .execute();
}

// ---------------------------------------------------------------------------------------------
// Live synchronization (ADR-0037 G3–G6)
// ---------------------------------------------------------------------------------------------

/** A provider failure the sync framework turns into retry, reauthorization, or dead-letter. */
export class ProviderFailure extends Error {
  readonly kind: 'reauthorize' | 'transient' | 'permanent';
  readonly code: string;
  readonly retryAfterSeconds: number | null;
  constructor(
    kind: 'reauthorize' | 'transient' | 'permanent',
    code: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(`provider ${kind}: ${code}`);
    this.name = 'ProviderFailure';
    this.kind = kind;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function failureOf(err: ProviderError): ProviderFailure {
  switch (err.kind) {
    case 'auth':
    case 'invalid_grant':
      return new ProviderFailure('reauthorize', 'needs_reauthorization');
    case 'rate':
      return new ProviderFailure('transient', 'provider_rate_limited', err.retryAfterSeconds);
    case 'transient':
      return new ProviderFailure('transient', 'provider_unavailable', err.retryAfterSeconds);
    default:
      return new ProviderFailure('permanent', 'provider_rejected');
  }
}

export interface SyncHost {
  /** A current access token; `force` refreshes even when not yet expired. */
  access(force?: boolean): Promise<string>;
  /** The canonical move of a linked block (CAL-012); a refusal names its reason. */
  moveLinkedBlock(
    blockId: string,
    start: Date,
    end: Date,
  ): Promise<{ ok: true; version: number } | { ok: false; reason: string }>;
  /** Records a visible schedule conflict (one open per event). */
  conflict(eventPublicId: string, local: string, remote: string): Promise<void>;
  /** True when a schedule conflict is open for this event. */
  conflictOpen(eventPublicId: string): Promise<boolean>;
  /** Audits that a link ended because the provider event is gone or no longer schedulable. */
  linkReleased(eventId: string, blockId: string, reason: string): Promise<void>;
}

export interface SyncSettings {
  pagesMax: number;
  pastDays: number;
  horizonDays: number;
  calendarsMax: number;
  occurrencesMax: number;
}

export interface SyncContext {
  tx: WorkspaceTransaction;
  provider: CalendarProvider;
  connectionId: string;
  ownerId: string;
  /** Writes allowed: the write scope is granted and the connection is not degraded. */
  canWrite: boolean;
  settings: SyncSettings;
  now: Date;
  host: SyncHost;
}

interface SourceRow {
  id: string;
  public_id: string;
  external_calendar_id: string;
  calendar_tz: string;
  access_role: string;
  selected: boolean;
  direction: 'read' | 'two_way';
  state: string;
}

export interface SyncTotals {
  reads: number;
  writes: number;
  conflicts: number;
  partial: boolean;
}

const ROLE: Record<ProviderCalendar['accessRole'], 'owner' | 'writer' | 'reader' | 'free_busy'> = {
  owner: 'owner',
  writer: 'writer',
  reader: 'reader',
  freeBusyReader: 'free_busy',
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** Provider text as stored plain text (control characters dropped, bounded, never empty). */
export function plainTitle(v: string | undefined, fallback = 'Busy'): string {
  const t = (v ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  return t || fallback;
}

export const validZone = (tz: string) => {
  if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Calls the provider; a rejected access token is refreshed once before reauthorization. */
async function call<T>(ctx: SyncContext, fn: (access: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await ctx.host.access());
  } catch (err) {
    if (!(err instanceof ProviderError) || err.kind !== 'auth') throw err;
  }
  try {
    return await fn(await ctx.host.access(true));
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'auth') throw failureOf(err);
    throw err;
  }
}

const throwing = (err: unknown): never => {
  if (err instanceof ProviderError) throw failureOf(err);
  throw err;
};

/** One inbound run for a live connection: calendar list, selected calendars, then pushes. */
export async function syncCalendarConnection(ctx: SyncContext): Promise<SyncTotals> {
  const totals: SyncTotals = { reads: 0, writes: 0, conflicts: 0, partial: false };
  await refreshCalendarList(ctx, totals);
  const sources = (await ctx.tx.db
    .selectFrom('integrations.calendar_source')
    .select([
      'id',
      'public_id',
      'external_calendar_id',
      'calendar_tz',
      'access_role',
      'selected',
      'direction',
      'state',
    ])
    .where('connection_id', '=', ctx.connectionId)
    .where('selected', '=', true)
    .where('state', '=', 'active')
    .orderBy('created_at')
    .orderBy('id')
    .limit(ctx.settings.calendarsMax)
    .execute()) as SourceRow[];
  for (const source of sources) {
    await syncSource(ctx, source, totals);
    await ctx.tx.db
      .updateTable('integrations.calendar_source')
      .set({ last_synced_at: ctx.now })
      .where('id', '=', source.id)
      .execute();
  }
  await pushPending(ctx, totals);
  return totals;
}

/** The provider's calendar list into `calendar_source` (new calendars: primary selected). */
export async function refreshCalendarList(ctx: SyncContext, totals?: SyncTotals): Promise<void> {
  const seen = new Set<string>();
  let token: string | null = null;
  const listed: ProviderCalendar[] = [];
  for (let pageNo = 0; pageNo < 10; pageNo++) {
    const pg: { items: ProviderCalendar[]; nextPageToken: string | null } = await call(ctx, (a) =>
      ctx.provider.listCalendars(a, token),
    ).catch(throwing);
    listed.push(...pg.items);
    token = pg.nextPageToken;
    if (!token) break;
  }
  for (const c of listed.slice(0, ctx.settings.calendarsMax)) {
    if (!c.id || c.id.length > 200) continue;
    seen.add(c.id);
    const role = ROLE[c.accessRole];
    const tz = validZone(c.timeZone) ? c.timeZone : 'UTC';
    const label = plainTitle(c.summary, 'Calendar').slice(0, 200);
    const current = await ctx.tx.db
      .selectFrom('integrations.calendar_source')
      .select(['id'])
      .where('connection_id', '=', ctx.connectionId)
      .where('external_calendar_id', '=', c.id)
      .executeTakeFirst();
    if (totals) totals.reads += 1;
    if (current) {
      const writable = role === 'owner' || role === 'writer';
      await ctx.tx.db
        .updateTable('integrations.calendar_source')
        .set({
          label,
          calendar_tz: tz,
          access_role: role,
          is_primary: c.primary,
          state: 'active',
          // A calendar that became read-only at the provider cannot stay two-way.
          ...(writable ? {} : { direction: 'read' as const }),
          updated_at: ctx.now,
        })
        .where('id', '=', current.id)
        .execute();
    } else {
      await ctx.tx.db
        .insertInto('integrations.calendar_source')
        .values({
          id: newUuidV7(),
          public_id: newPublicId('cal'),
          workspace_id: ctx.tx.workspaceId,
          connection_id: ctx.connectionId,
          owner_membership_id: ctx.ownerId,
          external_calendar_id: c.id,
          label,
          calendar_tz: tz,
          access_role: role,
          is_primary: c.primary,
          selected: c.primary,
          direction: 'read',
        })
        .execute();
    }
  }
  // Calendars the provider no longer lists: their mirrored events go; linked blocks stay.
  const active = await ctx.tx.db
    .selectFrom('integrations.calendar_source')
    .select(['id', 'external_calendar_id'])
    .where('connection_id', '=', ctx.connectionId)
    .where('state', '=', 'active')
    .execute();
  for (const g of active) {
    if (seen.has(g.external_calendar_id)) continue;
    await clearSource(ctx, g.id, 'calendar_removed');
    await ctx.tx.db
      .updateTable('integrations.calendar_source')
      .set({ state: 'removed', selected: false, updated_at: ctx.now })
      .where('id', '=', g.id)
      .execute();
  }
}

/** Deletes a calendar's mirrored events, series, and checkpoint (deselect, removal). */
export async function clearSource(
  ctx: Pick<SyncContext, 'tx' | 'connectionId' | 'host'>,
  sourceId: string,
  reason: string,
): Promise<void> {
  const linked = await ctx.tx.db
    .selectFrom('integrations.calendar_event')
    .select(['id', 'linked_work_block_id'])
    .where('source_id', '=', sourceId)
    .where('linked_work_block_id', 'is not', null)
    .execute();
  for (const l of linked) await ctx.host.linkReleased(l.id, l.linked_work_block_id!, reason);
  await ctx.tx.db
    .deleteFrom('integrations.calendar_event')
    .where('source_id', '=', sourceId)
    .execute();
  await ctx.tx.db
    .deleteFrom('integrations.calendar_series')
    .where('source_id', '=', sourceId)
    .execute();
  const pub = await ctx.tx.db
    .selectFrom('integrations.calendar_source')
    .select('public_id')
    .where('id', '=', sourceId)
    .executeTakeFirst();
  if (pub)
    await ctx.tx.db
      .deleteFrom('integrations.sync_checkpoint')
      .where('connection_id', '=', ctx.connectionId)
      .where('resource_key', '=', checkpointKey(pub.public_id))
      .execute();
}

export const checkpointKey = (publicId: string) => `calendar:${publicId.toLowerCase()}`;

type Cursor =
  | { mode: 'sync'; token: string }
  | { mode: 'full'; started: number; page: string | null }
  | { mode: 'incremental'; page: string };

export function parseCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  if (raw.startsWith('s:') && raw.length > 2) return { mode: 'sync', token: raw.slice(2) };
  if (raw.startsWith('i:') && raw.length > 2) return { mode: 'incremental', page: raw.slice(2) };
  const f = /^f:(\d{1,15}):(.*)$/.exec(raw);
  if (f) return { mode: 'full', started: Number(f[1]), page: f[2] || null };
  return null;
}

function formatCursor(c: Cursor): string {
  if (c.mode === 'sync') return `s:${c.token}`;
  if (c.mode === 'incremental') return `i:${c.page}`;
  return `f:${c.started}:${c.page ?? ''}`;
}

/** Compare-and-set of a calendar checkpoint (a concurrent writer is a version conflict). */
async function writeCursor(
  ctx: SyncContext,
  key: string,
  prior: { version: number } | undefined,
  next: Cursor | null,
): Promise<{ version: number } | undefined> {
  const cursor = next ? formatCursor(next) : null;
  if (cursor === null || cursor.length > 500) {
    await ctx.tx.db
      .deleteFrom('integrations.sync_checkpoint')
      .where('connection_id', '=', ctx.connectionId)
      .where('resource_key', '=', key)
      .execute();
    return undefined;
  }
  if (!prior) {
    const r = await ctx.tx.db
      .insertInto('integrations.sync_checkpoint')
      .values({
        workspace_id: ctx.tx.workspaceId,
        connection_id: ctx.connectionId,
        resource_key: key,
        cursor,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'connection_id', 'resource_key']).doNothing())
      .executeTakeFirst();
    if (Number(r.numInsertedOrUpdatedRows ?? 0) !== 1)
      throw new ProviderFailure('transient', 'checkpoint_conflict');
    return { version: 0 };
  }
  const r = await ctx.tx.db
    .updateTable('integrations.sync_checkpoint')
    .set({ cursor, version: prior.version + 1, updated_at: ctx.now })
    .where('connection_id', '=', ctx.connectionId)
    .where('resource_key', '=', key)
    .where('version', '=', prior.version)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) !== 1) throw new ProviderFailure('transient', 'checkpoint_conflict');
  return { version: prior.version + 1 };
}

async function syncSource(ctx: SyncContext, source: SourceRow, totals: SyncTotals) {
  const key = checkpointKey(source.public_id);
  const row = await ctx.tx.db
    .selectFrom('integrations.sync_checkpoint')
    .select(['cursor', 'version'])
    .where('connection_id', '=', ctx.connectionId)
    .where('resource_key', '=', key)
    .forUpdate()
    .executeTakeFirst();
  let prior: { version: number } | undefined = row ? { version: Number(row.version) } : undefined;
  let cursor: Cursor = parseCursor(row?.cursor) ?? {
    mode: 'full',
    started: ctx.now.getTime(),
    page: null,
  };
  let resets = 0;
  const deferred: ProviderEvent[] = [];
  const timeMin = new Date(ctx.now.getTime() - ctx.settings.pastDays * 86_400_000).toISOString();
  for (let pageNo = 0; ; pageNo++) {
    if (pageNo >= ctx.settings.pagesMax) {
      totals.partial = true;
      break;
    }
    let page;
    try {
      const c = cursor;
      page = await call(ctx, (a) =>
        ctx.provider.listEvents(
          a,
          source.external_calendar_id,
          c.mode === 'sync'
            ? { syncToken: c.token }
            : c.mode === 'incremental'
              ? { pageToken: c.page }
              : { timeMin, ...(c.page ? { pageToken: c.page } : {}) },
        ),
      );
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'gone' && resets === 0) {
        // The incremental checkpoint expired at the provider: start a full resynchronization.
        resets += 1;
        prior = await writeCursor(ctx, key, prior, null);
        cursor = { mode: 'full', started: ctx.now.getTime(), page: null };
        continue;
      }
      if (err instanceof ProviderError && err.kind === 'not_found') {
        await clearSource(ctx, source.id, 'calendar_removed');
        await ctx.tx.db
          .updateTable('integrations.calendar_source')
          .set({ state: 'removed', selected: false, updated_at: ctx.now })
          .where('id', '=', source.id)
          .execute();
        return;
      }
      return throwing(err);
    }
    const full = cursor.mode === 'full';
    // Masters before their instances so a moved or cancelled occurrence finds its series.
    const items = [...page.items].sort((a, b) => Number(isMaster(b)) - Number(isMaster(a)));
    for (const item of items) {
      totals.reads += 1;
      const outcome = await applyItem(ctx, source, item, full);
      if (outcome === 'deferred') deferred.push(item);
      else if (outcome === 'write') totals.writes += 1;
      else if (outcome === 'conflict') totals.conflicts += 1;
    }
    if (page.nextPageToken) {
      cursor =
        cursor.mode === 'full'
          ? { mode: 'full', started: cursor.started, page: page.nextPageToken }
          : { mode: 'incremental', page: page.nextPageToken };
      prior = await writeCursor(ctx, key, prior, cursor);
      continue;
    }
    for (const item of deferred.splice(0)) {
      const outcome = await applyItem(ctx, source, item, full, true);
      if (outcome === 'write') totals.writes += 1;
      else if (outcome === 'conflict') totals.conflicts += 1;
    }
    if (cursor.mode === 'full') await sweepUntouched(ctx, source.id, new Date(cursor.started));
    await writeCursor(
      ctx,
      key,
      prior,
      page.nextSyncToken ? { mode: 'sync', token: page.nextSyncToken } : null,
    );
    break;
  }
  await expandSeries(ctx, source, totals);
}

/** After a completed full listing: what the provider no longer has is removed here too. */
async function sweepUntouched(ctx: SyncContext, sourceId: string, started: Date) {
  const stale = await ctx.tx.db
    .selectFrom('integrations.calendar_event')
    .select(['id', 'linked_work_block_id'])
    .where('source_id', '=', sourceId)
    .where('series_id', 'is', null)
    .where('updated_at', '<', started)
    .execute();
  for (const s of stale) {
    if (s.linked_work_block_id)
      await ctx.host.linkReleased(s.id, s.linked_work_block_id, 'event_removed');
    await ctx.tx.db.deleteFrom('integrations.calendar_event').where('id', '=', s.id).execute();
  }
  const series = await ctx.tx.db
    .selectFrom('integrations.calendar_series')
    .select('id')
    .where('source_id', '=', sourceId)
    .where('updated_at', '<', started)
    .execute();
  for (const s of series) await removeSeries(ctx, s.id, 'event_removed');
}

type Outcome = 'read' | 'write' | 'conflict' | 'deferred';

async function applyItem(
  ctx: SyncContext,
  source: SourceRow,
  item: ProviderEvent,
  touch: boolean,
  last = false,
): Promise<Outcome> {
  if (isMaster(item)) return applyMaster(ctx, source, item, touch);
  if (item.recurringEventId) {
    const series = await ctx.tx.db
      .selectFrom('integrations.calendar_series')
      .select(['id', 'anchor_tz', 'all_day', 'title', 'busy'])
      .where('source_id', '=', source.id)
      .where('external_series_id', '=', item.recurringEventId)
      .executeTakeFirst();
    if (series) return applyInstance(ctx, source, series, item, touch);
    if (!last) return 'deferred';
    // An instance whose series the provider never listed is kept as a single event.
  }
  if (item.status === 'cancelled') return removeEvent(ctx, source, item.id);
  const span = spanOf(item.start, item.end, source.calendar_tz);
  if (!span || item.id.length > 200) return 'read';
  return upsertEvent(ctx, source, {
    externalId: item.id,
    title: plainTitle(item.summary),
    span,
    busy: item.transparency !== 'transparent',
    status: item.status === 'tentative' ? 'tentative' : 'confirmed',
    etag: item.etag.slice(0, 80),
    seriesId: null,
    key: null,
    detached: false,
    touch,
  });
}

async function removeEvent(
  ctx: SyncContext,
  source: SourceRow,
  externalId: string,
): Promise<Outcome> {
  const row = await ctx.tx.db
    .selectFrom('integrations.calendar_event')
    .select(['id', 'linked_work_block_id'])
    .where('connection_id', '=', ctx.connectionId)
    .where('calendar_id', '=', source.external_calendar_id)
    .where('external_event_id', '=', externalId)
    .executeTakeFirst();
  if (!row) return 'read';
  if (row.linked_work_block_id)
    await ctx.host.linkReleased(row.id, row.linked_work_block_id, 'event_cancelled');
  await ctx.tx.db.deleteFrom('integrations.calendar_event').where('id', '=', row.id).execute();
  return 'write';
}

interface Upsert {
  externalId: string;
  title: string;
  span: EventSpan;
  busy: boolean;
  status: 'confirmed' | 'tentative';
  etag: string;
  seriesId: string | null;
  key: string | null;
  detached: boolean;
  touch: boolean;
}

async function upsertEvent(ctx: SyncContext, source: SourceRow, u: Upsert): Promise<Outcome> {
  const tx = ctx.tx;
  let current = u.seriesId
    ? await tx.db
        .selectFrom('integrations.calendar_event')
        .selectAll()
        .where('series_id', '=', u.seriesId)
        .where('occurrence_key', '=', u.key!)
        .executeTakeFirst()
    : undefined;
  current ??= await tx.db
    .selectFrom('integrations.calendar_event')
    .selectAll()
    .where('connection_id', '=', ctx.connectionId)
    .where('calendar_id', '=', source.external_calendar_id)
    .where('external_event_id', '=', u.externalId)
    .executeTakeFirst();
  if (!current) {
    await tx.db
      .insertInto('integrations.calendar_event')
      .values({
        id: newUuidV7(),
        public_id: newPublicId('cev'),
        workspace_id: tx.workspaceId,
        connection_id: ctx.connectionId,
        owner_membership_id: ctx.ownerId,
        calendar_id: source.external_calendar_id,
        external_event_id: u.externalId,
        source_id: source.id,
        series_id: u.seriesId,
        occurrence_key: u.key,
        detached: u.detached,
        starts_at: u.span.startsAt,
        ends_at: u.span.endsAt,
        event_tz: u.span.tz,
        all_day: u.span.allDay,
        title: u.title,
        busy: u.busy,
        status: u.status,
        remote_version: u.etag,
        // The run's clock, not the transaction's: a full-sync sweep compares against it.
        updated_at: ctx.now,
      })
      .execute();
    return 'write';
  }
  // A moved occurrence stays as the provider moved it; regeneration never overwrites it.
  if (current.detached && !u.detached) return 'read';
  const moved =
    new Date(current.starts_at).getTime() !== u.span.startsAt.getTime() ||
    new Date(current.ends_at).getTime() !== u.span.endsAt.getTime();
  const changed =
    moved ||
    current.remote_version !== u.etag ||
    current.title !== u.title ||
    current.busy !== u.busy ||
    current.status !== u.status ||
    current.detached !== u.detached ||
    current.source_id !== source.id;
  if (!changed && !u.touch) return 'read';
  let outcome: Outcome = changed ? 'write' : 'read';
  let link: Record<string, unknown> = {};
  if (current.linked_work_block_id && (moved || current.link_remote_version !== u.etag)) {
    const r = await reconcileLink(ctx, current, u);
    link = r.set;
    if (r.conflict) outcome = 'conflict';
  }
  await tx.db
    .updateTable('integrations.calendar_event')
    .set({
      external_event_id: u.externalId,
      source_id: source.id,
      series_id: u.seriesId,
      occurrence_key: u.key,
      detached: u.detached,
      starts_at: u.span.startsAt,
      ends_at: u.span.endsAt,
      event_tz: u.span.tz,
      all_day: u.span.allDay,
      title: u.title,
      busy: u.busy,
      status: u.status,
      remote_version: u.etag,
      updated_at: ctx.now,
      version: Number(current.version) + (changed ? 1 : 0),
      ...link,
    })
    .where('id', '=', current.id)
    .execute();
  return outcome;
}

/**
 * A linked event changed at the provider (CAL-012). If only the provider side changed since the
 * last agreement, the block moves through the canonical planning command; if the block changed
 * too, or the move is refused (locked, focus, authority, all-day), the disagreement becomes a
 * visible conflict and neither side is overwritten. Task dates are never touched (CAL-013).
 */
async function reconcileLink(
  ctx: SyncContext,
  current: {
    public_id: string;
    linked_work_block_id: string | null;
    link_block_version: number | null;
    push_pending: boolean;
  },
  u: Upsert,
): Promise<{ set: Record<string, unknown>; conflict: boolean }> {
  const block = await ctx.tx.db
    .selectFrom('planning.work_block')
    .select(['id', 'version', 'starts_at', 'ends_at'])
    .where('id', '=', current.linked_work_block_id!)
    .executeTakeFirst();
  if (!block) return { set: {}, conflict: false };
  const same =
    new Date(block.starts_at).getTime() === u.span.startsAt.getTime() &&
    new Date(block.ends_at).getTime() === u.span.endsAt.getTime();
  if (same)
    return {
      set: {
        link_block_version: Number(block.version),
        link_remote_version: u.etag,
        push_pending: false,
      },
      conflict: false,
    };
  const localChanged =
    Number(block.version) !== Number(current.link_block_version) || current.push_pending;
  if (localChanged || u.span.allDay) {
    await ctx.host.conflict(current.public_id, `blk:v${block.version}`, u.etag);
    return { set: { push_pending: false }, conflict: true };
  }
  const moved = await ctx.host.moveLinkedBlock(block.id, u.span.startsAt, u.span.endsAt);
  if (!moved.ok) {
    await ctx.host.conflict(current.public_id, `blk:v${block.version}`, u.etag);
    return { set: { push_pending: false }, conflict: true };
  }
  return {
    set: { link_block_version: moved.version, link_remote_version: u.etag, push_pending: false },
    conflict: false,
  };
}

async function applyMaster(
  ctx: SyncContext,
  source: SourceRow,
  item: ProviderEvent,
  touch: boolean,
): Promise<Outcome> {
  const tx = ctx.tx;
  const existing = await tx.db
    .selectFrom('integrations.calendar_series')
    .selectAll()
    .where('source_id', '=', source.id)
    .where('external_series_id', '=', item.id)
    .executeTakeFirst();
  if (item.status === 'cancelled') {
    if (existing) await removeSeries(ctx, existing.id, 'event_cancelled');
    return existing ? 'write' : 'read';
  }
  const span = spanOf(item.start, item.end, source.calendar_tz);
  if (!span || item.id.length > 150) return 'read';
  const anchorTz = validZone(span.tz) ? span.tz : source.calendar_tz;
  const norm = normalizeRecurrence(item.recurrence ?? [], anchorTz, span.allDay);
  const dtstart = span.allDay ? `${span.localStart}T00:00` : span.localStart;
  const duration = Math.max(
    0,
    Math.round((span.endsAt.getTime() - span.startsAt.getTime()) / 60_000),
  );
  const values = {
    title: plainTitle(item.summary),
    rrule: norm.rrule,
    supported: norm.rrule !== null,
    until_at: norm.untilAt,
    anchor_tz: anchorTz,
    dtstart_local: dtstart,
    all_day: span.allDay,
    duration_minutes: Math.min(duration, 525_600),
    busy: item.transparency !== 'transparent',
    remote_version: item.etag.slice(0, 80),
  };
  let id = existing?.id;
  let outcome: Outcome = 'read';
  if (!existing) {
    id = newUuidV7();
    await tx.db
      .insertInto('integrations.calendar_series')
      .values({
        id,
        workspace_id: tx.workspaceId,
        connection_id: ctx.connectionId,
        source_id: source.id,
        owner_membership_id: ctx.ownerId,
        external_series_id: item.id,
        ...values,
        updated_at: ctx.now,
      })
      .execute();
    outcome = 'write';
  } else if (existing.remote_version !== values.remote_version) {
    await tx.db
      .updateTable('integrations.calendar_series')
      .set({
        ...values,
        expanded_from: null,
        expanded_through: null,
        updated_at: ctx.now,
        version: Number(existing.version) + 1,
      })
      .where('id', '=', existing.id)
      .execute();
    // Generated occurrences follow the new rule; linked ones stay to be reconciled on expansion.
    await tx.db
      .deleteFrom('integrations.calendar_event')
      .where('series_id', '=', existing.id)
      .where('detached', '=', false)
      .where('linked_work_block_id', 'is', null)
      .execute();
    outcome = 'write';
  } else if (touch) {
    await tx.db
      .updateTable('integrations.calendar_series')
      .set({ updated_at: ctx.now })
      .where('id', '=', existing.id)
      .execute();
  }
  for (const key of norm.exdates) await cancelOccurrence(ctx, id!, key);
  return outcome;
}

async function cancelOccurrence(ctx: SyncContext, seriesId: string, key: string) {
  await ctx.tx.db
    .insertInto('integrations.calendar_exception')
    .values({
      workspace_id: ctx.tx.workspaceId,
      series_id: seriesId,
      occurrence_key: key,
      kind: 'cancelled',
    })
    .onConflict((oc) =>
      oc
        .columns(['workspace_id', 'series_id', 'occurrence_key'])
        .doUpdateSet({ kind: 'cancelled' }),
    )
    .execute();
  const row = await ctx.tx.db
    .selectFrom('integrations.calendar_event')
    .select(['id', 'linked_work_block_id'])
    .where('series_id', '=', seriesId)
    .where('occurrence_key', '=', key)
    .executeTakeFirst();
  if (!row) return;
  if (row.linked_work_block_id)
    await ctx.host.linkReleased(row.id, row.linked_work_block_id, 'occurrence_cancelled');
  await ctx.tx.db.deleteFrom('integrations.calendar_event').where('id', '=', row.id).execute();
}

async function applyInstance(
  ctx: SyncContext,
  source: SourceRow,
  series: { id: string; anchor_tz: string; all_day: boolean; title: string; busy: boolean },
  item: ProviderEvent,
  touch: boolean,
): Promise<Outcome> {
  const key = originalKey(item.originalStartTime, series.anchor_tz, series.all_day);
  if (!key || item.id.length > 200) return 'read';
  if (item.status === 'cancelled') {
    await cancelOccurrence(ctx, series.id, key);
    return 'write';
  }
  const span = spanOf(item.start, item.end, source.calendar_tz);
  if (!span) return 'read';
  await ctx.tx.db
    .insertInto('integrations.calendar_exception')
    .values({
      workspace_id: ctx.tx.workspaceId,
      series_id: series.id,
      occurrence_key: key,
      kind: 'moved',
    })
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'series_id', 'occurrence_key']).doUpdateSet({ kind: 'moved' }),
    )
    .execute();
  return upsertEvent(ctx, source, {
    externalId: item.id,
    title: item.summary !== undefined ? plainTitle(item.summary) : series.title,
    span,
    busy: item.transparency ? item.transparency !== 'transparent' : series.busy,
    status: item.status === 'tentative' ? 'tentative' : 'confirmed',
    etag: item.etag.slice(0, 80),
    seriesId: series.id,
    key,
    detached: true,
    touch,
  });
}

async function removeSeries(ctx: SyncContext, seriesId: string, reason: string) {
  const linked = await ctx.tx.db
    .selectFrom('integrations.calendar_event')
    .select(['id', 'linked_work_block_id'])
    .where('series_id', '=', seriesId)
    .where('linked_work_block_id', 'is not', null)
    .execute();
  for (const l of linked) await ctx.host.linkReleased(l.id, l.linked_work_block_id!, reason);
  await ctx.tx.db
    .deleteFrom('integrations.calendar_event')
    .where('series_id', '=', seriesId)
    .execute();
  await ctx.tx.db.deleteFrom('integrations.calendar_series').where('id', '=', seriesId).execute();
}

/**
 * Rolls each series' occurrences over the sync window. Supported rules are evaluated with the
 * shared engine in their anchor zone; others use the provider's instance expansion. Exceptions
 * and detached (moved) occurrences are never regenerated over.
 */
async function expandSeries(ctx: SyncContext, source: SourceRow, totals: SyncTotals) {
  const from = new Date(ctx.now.getTime() - ctx.settings.pastDays * 86_400_000);
  const to = new Date(ctx.now.getTime() + ctx.settings.horizonDays * 86_400_000);
  const all = await ctx.tx.db
    .selectFrom('integrations.calendar_series')
    .selectAll()
    .where('source_id', '=', source.id)
    .execute();
  for (const s of all) {
    const fresh =
      s.expanded_from &&
      s.expanded_through &&
      new Date(s.expanded_from) <= from &&
      new Date(s.expanded_through).getTime() >= to.getTime() - 86_400_000;
    if (fresh) continue;
    const exceptions = new Set(
      (
        await ctx.tx.db
          .selectFrom('integrations.calendar_exception')
          .select('occurrence_key')
          .where('series_id', '=', s.id)
          .execute()
      ).map((e) => e.occurrence_key),
    );
    const wanted = new Set<string>();
    const place = async (o: {
      key: string;
      id: string;
      title: string;
      span: EventSpan;
      status?: 'confirmed' | 'tentative';
    }) => {
      wanted.add(o.key);
      const r = await upsertEvent(ctx, source, {
        externalId: o.id,
        title: o.title,
        span: o.span,
        busy: s.busy,
        status: o.status ?? 'confirmed',
        etag: s.remote_version,
        seriesId: s.id,
        key: o.key,
        detached: false,
        touch: false,
      });
      if (r === 'write') totals.writes += 1;
      if (r === 'conflict') totals.conflicts += 1;
    };
    if (s.supported && s.rrule) {
      const occ = expand(
        {
          externalId: s.external_series_id,
          rrule: s.rrule,
          untilAt: s.until_at ? new Date(s.until_at) : null,
          anchorTz: s.anchor_tz,
          dtstartLocal: localText(s.dtstart_local),
          allDay: s.all_day,
          durationMinutes: Number(s.duration_minutes),
          dayTz: source.calendar_tz,
        },
        from,
        to,
        ctx.settings.occurrencesMax,
      );
      for (const o of occ) {
        if (exceptions.has(o.key)) continue;
        await place({
          key: o.key,
          id: o.instanceId,
          title: s.title,
          span: {
            allDay: s.all_day,
            tz: s.anchor_tz,
            startsAt: o.startsAt,
            endsAt: o.endsAt,
            localStart: o.key,
          },
        });
      }
    } else {
      let token: string | undefined;
      for (let pageNo = 0; pageNo < ctx.settings.pagesMax; pageNo++) {
        const t = token;
        const page = await call(ctx, (a) =>
          ctx.provider.listInstances(a, source.external_calendar_id, s.external_series_id, {
            timeMin: from.toISOString(),
            timeMax: to.toISOString(),
            ...(t ? { pageToken: t } : {}),
          }),
        ).catch(throwing);
        for (const inst of page.items) {
          const key = originalKey(inst.originalStartTime ?? inst.start, s.anchor_tz, s.all_day);
          if (!key || inst.status === 'cancelled' || exceptions.has(key) || inst.id.length > 200)
            continue;
          const span = spanOf(inst.start, inst.end, source.calendar_tz);
          if (!span) continue;
          await place({
            key,
            id: inst.id,
            title: inst.summary !== undefined ? plainTitle(inst.summary) : s.title,
            span,
            status: inst.status === 'tentative' ? 'tentative' : 'confirmed',
          });
        }
        if (!page.nextPageToken) break;
        token = page.nextPageToken;
      }
    }
    // Generated occurrences the rule no longer produces inside the window, or that fell out of
    // the window, are removed (a linked one releases its block first; past linked ones stay).
    const generated = await ctx.tx.db
      .selectFrom('integrations.calendar_event')
      .select(['id', 'occurrence_key', 'linked_work_block_id', 'ends_at', 'starts_at'])
      .where('series_id', '=', s.id)
      .where('detached', '=', false)
      .execute();
    for (const g of generated) {
      const outside = new Date(g.ends_at) <= from;
      const unwanted = !outside && new Date(g.starts_at) < to && !wanted.has(g.occurrence_key!);
      if (!outside && !unwanted) continue;
      if (outside && g.linked_work_block_id) continue;
      if (g.linked_work_block_id)
        await ctx.host.linkReleased(g.id, g.linked_work_block_id, 'occurrence_removed');
      await ctx.tx.db.deleteFrom('integrations.calendar_event').where('id', '=', g.id).execute();
    }
    await ctx.tx.db
      .updateTable('integrations.calendar_series')
      .set({ expanded_from: from, expanded_through: to })
      .where('id', '=', s.id)
      .execute();
  }
}

/** A `timestamp without time zone` as the engine's local `YYYY-MM-DDTHH:mm`. */
function localText(v: unknown): string {
  if (v instanceof Date) {
    // node-postgres reads a zone-less timestamp in the process zone; undo that reading.
    const local = new Date(v.getTime() - v.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }
  return String(v).slice(0, 16).replace(' ', 'T');
}

/**
 * Local block moves written to the provider (two-way calendars only). The write is conditional on
 * the provider version both sides last agreed on, so a provider-side change is never overwritten:
 * it becomes a conflict instead.
 */
export async function pushPending(ctx: SyncContext, totals: SyncTotals) {
  const pending = await ctx.tx.db
    .selectFrom('integrations.calendar_event as e')
    .innerJoin('integrations.calendar_source as s', 's.id', 'e.source_id')
    .innerJoin('planning.work_block as b', 'b.id', 'e.linked_work_block_id')
    .select([
      'e.id',
      'e.public_id',
      'e.external_event_id',
      'e.series_id',
      'e.occurrence_key',
      'e.link_remote_version',
      'e.linked_work_block_id',
      's.external_calendar_id',
      's.direction',
      's.selected',
      's.state',
      'b.starts_at',
      'b.ends_at',
      'b.source_tz',
      'b.version as block_version',
    ])
    .where('e.connection_id', '=', ctx.connectionId)
    .where('e.push_pending', '=', true)
    .orderBy('e.id')
    .limit(100)
    .execute();
  for (const p of pending) {
    if (p.direction !== 'two_way' || !p.selected || p.state !== 'active') {
      await ctx.tx.db
        .updateTable('integrations.calendar_event')
        .set({ push_pending: false })
        .where('id', '=', p.id)
        .execute();
      continue;
    }
    if (!ctx.canWrite || (await ctx.host.conflictOpen(p.public_id))) continue;
    let ev: ProviderEvent;
    try {
      ev = await call(ctx, (a) =>
        ctx.provider.patchEvent(
          a,
          p.external_calendar_id,
          p.external_event_id,
          {
            start: { dateTime: new Date(p.starts_at).toISOString(), timeZone: p.source_tz },
            end: { dateTime: new Date(p.ends_at).toISOString(), timeZone: p.source_tz },
          },
          p.link_remote_version,
        ),
      );
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'precondition') {
        await ctx.host.conflict(p.public_id, `blk:v${p.block_version}`, 'changed');
        await ctx.tx.db
          .updateTable('integrations.calendar_event')
          .set({ push_pending: false })
          .where('id', '=', p.id)
          .execute();
        totals.conflicts += 1;
        continue;
      }
      if (err instanceof ProviderError && (err.kind === 'not_found' || err.kind === 'gone')) {
        await ctx.host.linkReleased(p.id, p.linked_work_block_id!, 'event_removed');
        await ctx.tx.db.deleteFrom('integrations.calendar_event').where('id', '=', p.id).execute();
        continue;
      }
      return throwing(err);
    }
    const etag = ev.etag.slice(0, 80);
    if (p.series_id && p.occurrence_key)
      await ctx.tx.db
        .insertInto('integrations.calendar_exception')
        .values({
          workspace_id: ctx.tx.workspaceId,
          series_id: p.series_id,
          occurrence_key: p.occurrence_key,
          kind: 'moved',
        })
        .onConflict((oc) =>
          oc
            .columns(['workspace_id', 'series_id', 'occurrence_key'])
            .doUpdateSet({ kind: 'moved' }),
        )
        .execute();
    await ctx.tx.db
      .updateTable('integrations.calendar_event')
      .set({
        starts_at: new Date(p.starts_at),
        ends_at: new Date(p.ends_at),
        remote_version: etag,
        link_remote_version: etag,
        link_block_version: Number(p.block_version),
        push_pending: false,
        detached: p.series_id !== null,
        updated_at: ctx.now,
      })
      .where('id', '=', p.id)
      .execute();
    totals.writes += 1;
  }
}
