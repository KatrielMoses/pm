import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { mutation, workEnv, workspaceWith, type WorkEnv } from './fixture.ts';

// Reads are bounded windows (ADR-0037); the loopback double's event is on 2030-01-15.
const WINDOW = { from: '2030-01-10T00:00:00.000Z', to: '2030-01-20T00:00:00.000Z' };

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
        api_key: 'gcal-loopback-fixture-a', // gitleaks:allow (synthetic loopback credential)
      },
      mutation(),
    );
    await env.svc.syncNow(owner, ws, conn.data.id, mutation());
    const listed = await env.svc.listCalendarEvents(owner, ws, WINDOW);
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
        api_key: 'gcal-loopback-fixture-b', // gitleaks:allow (synthetic loopback credential)
      },
      mutation(),
    );
    await env.svc.syncNow(owner, ws, conn.data.id, mutation());
    const before = (await env.svc.listCalendarEvents(owner, ws, WINDOW)).events.length;
    expect(before).toBeGreaterThan(0);
    await env.svc.disconnect(owner, ws, conn.data.id, { retention: 'remove' }, mutation());
    const after = (await env.svc.listCalendarEvents(owner, ws, WINDOW)).events.length;
    expect(after).toBeLessThan(before);
  });
});
