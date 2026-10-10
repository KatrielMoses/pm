import { TenancyError, type Caller } from '@pm/tenancy';
import { PublicApiService } from './public-api-service.ts';
import type { ProviderId } from './semantics.ts';

/**
 * Google Calendar mirror and sync (Phase 6C). Extends the public API layer without changing token
 * or webhook behavior.
 */
export class CalendarService extends PublicApiService {
  protected override configured(id: ProviderId): boolean {
    if (id === 'google_calendar' && this.ws.googleCalendarLoopbackEnabled) return true;
    return super.configured(id);
  }

  async listCalendarEvents(
    caller: Caller,
    ws: unknown,
    query: { from?: string; to?: string },
  ): Promise<{ events: Array<Record<string, unknown>> }> {
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      if (p.kind !== 'member') throw new TenancyError('forbidden');
      let q = tx.db
        .selectFrom('integrations.calendar_event')
        .select([
          'public_id as id',
          'title',
          'starts_at',
          'ends_at',
          'event_tz',
          'all_day',
          'busy',
          'calendar_id',
          'connection_id',
        ])
        .where('owner_membership_id', '=', p.membershipId)
        .orderBy('starts_at');
      if (query.from) q = q.where('ends_at', '>=', new Date(query.from));
      if (query.to) q = q.where('starts_at', '<=', new Date(query.to));
      const rows = await q.limit(200).execute();
      return {
        events: rows.map((r) => ({
          id: r.id,
          type: 'calendar_event',
          title: r.title,
          starts_at: new Date(r.starts_at).toISOString(),
          ends_at: new Date(r.ends_at).toISOString(),
          event_tz: r.event_tz,
          all_day: r.all_day,
          busy: r.busy,
          calendar_id: r.calendar_id,
          connection_id: r.connection_id,
        })),
      };
    });
  }
}
