import { api, ApiError, newIdempotencyKey } from '../api.ts';

/**
 * Typed client for connected calendars (6C, ADR-0037). Calendars, events, and conflicts are the
 * signed-in person's own; another member's connection answers 404, which reads as "not yours".
 * Every identifier is a public ID.
 */

export interface CalendarEventView {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  event_tz: string | null;
  all_day: boolean;
  busy: boolean;
  status: string;
  recurring: boolean;
  moved_occurrence: boolean;
  calendar: { id: string | null; label: string; direction: string };
  /** False when the event was kept after its connection was disconnected. */
  synchronized: boolean;
  link: { block: string; pending: boolean } | null;
}

export interface CalendarSourceView {
  id: string;
  type: 'calendar_source';
  label: string;
  timezone: string | null;
  access_role: string;
  primary: boolean;
  selected: boolean;
  direction: 'read' | 'two_way';
  two_way_available: boolean;
  brand: { id: string; name: string } | null;
  last_synced_at: string | null;
}

export interface CalendarConflictView {
  id: string;
  connection: string;
  calendar: string | null;
  can_keep_local: boolean;
  event: { id: string; title: string; starts_at: string; ends_at: string; all_day: boolean };
  block: { id: string; starts_at: string; ends_at: string } | null;
}

export interface SyncRunView {
  state: string;
  direction?: string;
  attempt?: number;
  error_code: string | null;
  read_count: number;
  write_count: number;
  conflict_count: number;
  started_at?: string;
  finished_at?: string | null;
}

export type ConflictResolution = 'kept_local' | 'kept_remote' | 'dismissed';

/** A selected two-way calendar a block can be published to. */
export interface CalendarTarget {
  id: string;
  label: string;
  connection: string;
}

const w = (ws: string) => `/v1/workspaces/${ws}`;
const key = () => ({ 'idempotency-key': newIdempotencyKey() });

export const calendars = {
  async events(ws: string, from: string, to: string) {
    const q = new URLSearchParams({ from, to });
    return (
      await api<{
        data: { events: CalendarEventView[]; has_more: boolean; connected: boolean };
      }>('GET', `${w(ws)}/calendar-events?${q.toString()}`)
    ).body.data;
  },
  async conflicts(ws: string) {
    return (
      await api<{ data: { conflicts: CalendarConflictView[] } }>(
        'GET',
        `${w(ws)}/calendar-conflicts`,
      )
    ).body.data.conflicts;
  },
  /** The person's calendars on one connection, or null when the connection is not theirs. */
  async sources(ws: string, conn: string): Promise<CalendarSourceView[] | null> {
    try {
      return (
        await api<{ data: { calendars: CalendarSourceView[] } }>(
          'GET',
          `${w(ws)}/integrations/connections/${conn}/calendars`,
        )
      ).body.data.calendars;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },
  async saveSources(
    ws: string,
    conn: string,
    rows: Array<{ id: string; selected: boolean; direction: string; brand: string | null }>,
  ) {
    return (
      await api<{ data: { calendars: CalendarSourceView[] } }>(
        'PUT',
        `${w(ws)}/integrations/connections/${conn}/calendars`,
        { body: { calendars: rows }, headers: key() },
      )
    ).body.data.calendars;
  },
  async runs(ws: string, conn: string) {
    return (
      await api<{ data: { runs: SyncRunView[] } }>(
        'GET',
        `${w(ws)}/integrations/connections/${conn}/runs`,
      )
    ).body.data.runs;
  },
  async sync(ws: string, conn: string) {
    return (
      await api<{ data: SyncRunView }>('POST', `${w(ws)}/integrations/connections/${conn}/sync`, {
        body: {},
        headers: key(),
      })
    ).body.data;
  },
  async resolve(ws: string, conn: string, cnf: string, resolution: ConflictResolution) {
    await api('POST', `${w(ws)}/integrations/connections/${conn}/conflicts/${cnf}/resolve`, {
      body: { resolution },
      headers: key(),
    });
  },
  async publish(ws: string, blk: string, calendar: string) {
    await api('POST', `${w(ws)}/work-blocks/${blk}/calendar`, {
      body: { calendar },
      headers: key(),
    });
  },
  async unlink(ws: string, blk: string) {
    await api('DELETE', `${w(ws)}/work-blocks/${blk}/calendar`, { headers: key() });
  },
  /**
   * The person's selected two-way calendars across their Google Calendar connections. A
   * connection that is not theirs (404) or cannot be read is skipped.
   */
  async targets(ws: string): Promise<CalendarTarget[]> {
    const listed = (
      await api<{
        data: { connections: Array<{ id: string; provider: string; health: string }> };
      }>('GET', `${w(ws)}/integrations/connections`)
    ).body.data.connections.filter(
      (c) => c.provider === 'google_calendar' && c.health !== 'disconnected',
    );
    const found = await Promise.all(
      listed.map(async (c) => {
        const rows = await calendars.sources(ws, c.id).catch(() => null);
        return (rows ?? [])
          .filter((r) => r.selected && r.direction === 'two_way')
          .map((r) => ({ id: r.id, label: r.label, connection: c.id }));
      }),
    );
    return found.flat();
  },
};

/** Minutes as "1 h 30 min", "45 min", or "2 h". */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** A time range in the viewer's locale and zone; all-day events say so. */
export function rangeText(e: { starts_at: string; ends_at: string; all_day?: boolean }): string {
  const s = new Date(e.starts_at);
  const t = new Date(e.ends_at);
  if (e.all_day) return `All day, ${s.toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
  const sameDay = s.toDateString() === t.toDateString();
  const day = s.toLocaleDateString(undefined, { dateStyle: 'medium' });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return sameDay
    ? `${day}, ${time(s)}–${time(t)}`
    : `${s.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} – ${t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

/** Plain words for sync and connection error codes. */
const ERRORS: Record<string, string> = {
  provider_unavailable: 'Google Calendar could not be reached. It will be retried.',
  needs_reauthorization: 'Access expired or was removed. Reauthorize to continue.',
  provider_rate_limited: 'Google Calendar asked us to slow down. It will be retried shortly.',
  insufficient_scope: 'Calendar access was not granted.',
  provider_unconfigured: 'Google Calendar is not configured in this environment.',
};

export function errorText(code: string | null): string | null {
  if (!code) return null;
  return ERRORS[code] ?? 'Synchronization did not finish. It will be retried.';
}
