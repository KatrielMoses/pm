import { newPublicId, newUuidV7 } from '@pm/contracts';
import type { WorkspaceTransaction } from '@pm/db';
import type { CalendarEventSecret } from './semantics.ts';

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

export async function deleteCalendarEventsForConnection(
  tx: WorkspaceTransaction,
  connectionId: string,
): Promise<void> {
  await tx.db
    .deleteFrom('integrations.calendar_event')
    .where('connection_id', '=', connectionId)
    .execute();
  await tx.db
    .deleteFrom('integrations.connection_mapping')
    .where('connection_id', '=', connectionId)
    .execute();
}
