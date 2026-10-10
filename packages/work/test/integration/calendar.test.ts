import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { mutation, workEnv, workspaceWith, type WorkEnv } from './fixture.ts';

describe('Google Calendar (6C)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db, { work: { googleCalendarLoopbackEnabled: true } });
    ({ owner, ws } = await workspaceWith(env, db, ['Harbor']));
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  it('AT-315 mirrors calendar events after sync', async () => {
    const conn = await env.svc.createConnection(
      owner,
      ws,
      {
        provider: 'google_calendar',
        auth_kind: 'api_key',
        display_name: 'My Google',
        scopes: ['calendar.read', 'calendar.write'],
        api_key: 'gcal-test-key-12345678',
      },
      mutation(),
    );
    await env.svc.syncNow(owner, ws, conn.data.id, mutation());
    const listed = await env.svc.listCalendarEvents(owner, ws, {});
    expect(listed.events.length).toBeGreaterThan(0);
    expect(listed.events[0]?.title).toBe('Focus time');
  });

  it('AT-316 removes imported events when disconnecting with remove', async () => {
    const conn = await env.svc.createConnection(
      owner,
      ws,
      {
        provider: 'google_calendar',
        auth_kind: 'api_key',
        display_name: 'Remove me',
        scopes: ['calendar.read', 'calendar.write'],
        api_key: 'gcal-test-key-87654321',
      },
      mutation(),
    );
    await env.svc.syncNow(owner, ws, conn.data.id, mutation());
    const before = (await env.svc.listCalendarEvents(owner, ws, {})).events.length;
    expect(before).toBeGreaterThan(0);
    await env.svc.disconnect(owner, ws, conn.data.id, { retention: 'remove' }, mutation());
    const after = (await env.svc.listCalendarEvents(owner, ws, {})).events.length;
    expect(after).toBeLessThan(before);
  });
});
