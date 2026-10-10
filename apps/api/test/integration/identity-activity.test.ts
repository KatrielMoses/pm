import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTraceId, UUID_ANY_PATTERN } from '@pm/contracts';
import { AuditSecurityEventSink } from '@pm/audit';
import { contractErrors, createWorkspace } from '@pm/test-support';
import {
  Browser,
  identityEnv,
  PASSWORD,
  registerAndVerify,
  signIn,
  type IdentityEnv,
} from './identity-helpers.ts';

/** Phase 1F: the account-owned Security activity view (own events only, display-safe). */
describe('identity: own-account security activity', () => {
  let env: IdentityEnv;

  beforeAll(async () => {
    env = await identityEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  it('shows only the signed-in account’s events, masked, without internal ids or personal values', async () => {
    const me = new Browser(env.app);
    await registerAndVerify(env, me, 'activity-me@example.test');
    await signIn(me, 'activity-me@example.test');
    await signIn(new Browser(env.app), 'activity-me@example.test', 'wrong password!!');
    const someoneElse = new Browser(env.app);
    await registerAndVerify(env, someoneElse, 'activity-other@example.test');
    await signIn(someoneElse, 'activity-other@example.test');
    // A tenant-scoped security event in some workspace never appears in an account view.
    const ws = await createWorkspace(env.h.app, 'Tenant events');
    const meId = (
      await env.db.admin(
        `SELECT id FROM identity.account WHERE email_key = 'activity-me@example.test'`,
      )
    ).rows[0].id;
    await env.h.app.withWorkspace(ws.id, { module: 'test' }, (tx) =>
      new AuditSecurityEventSink().record(tx, {
        category: 'permission',
        action: 'grant.created',
        outcome: 'success',
        actor: { type: 'human', id: meId },
        correlationId: newTraceId(),
      }),
    );

    const r = await me.get('/v1/auth/security-activity');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.data.type).toBe('security_activity');
    expect(contractErrors('meta', body.meta)).toEqual([]);
    const items = body.data.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.some((i) => i.action === 'grant.created')).toBe(false);
    expect(items.some((i) => i.outcome === 'failure')).toBe(true); // the failed sign-in attempt
    const created = items.filter((i) => i.action === 'session.created');
    expect(created.some((i) => i.this_session === true)).toBe(true);
    expect(Object.keys(items[0]!).sort()).toEqual(
      [
        'action',
        'category',
        'client',
        'device',
        'network',
        'occurred_at',
        'outcome',
        'this_session',
      ].sort(),
    );
    const text = r.body;
    for (const forbidden of [
      'activity-other@example.test',
      'activity-me@example.test',
      '203.0.113.10',
      PASSWORD,
      'Mozilla/5.0',
    ])
      expect(text.includes(forbidden), forbidden).toBe(false);
    expect(UUID_ANY_PATTERN.test(text)).toBe(false);
    expect(
      items.every((i) => i.network === null || /^\d+\.\d+\.\d+\.\*$/.test(String(i.network))),
    ).toBe(true);
    // The other account sees its own events only.
    const theirs = (await someoneElse.get('/v1/auth/security-activity')).json().data
      .items as Array<{ action: string }>;
    expect(JSON.stringify(theirs).includes('failure')).toBe(false);
  });

  it('paginates with an opaque cursor bound to the account; bad input is a validation error', async () => {
    const me = new Browser(env.app);
    await registerAndVerify(env, me, 'activity-pages@example.test');
    for (let i = 0; i < 4; i++) await signIn(me, 'activity-pages@example.test');
    const first = (await me.get('/v1/auth/security-activity?limit=2')).json().data;
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const second = (
      await me.get(`/v1/auth/security-activity?limit=2&cursor=${first.next_cursor}`)
    ).json().data;
    expect(second.items).toHaveLength(2);
    expect(second.items[0].occurred_at <= first.items[1].occurred_at).toBe(true);
    // Another account cannot replay my cursor.
    const other = new Browser(env.app);
    await registerAndVerify(env, other, 'activity-thief@example.test');
    await signIn(other, 'activity-thief@example.test');
    const stolen = await other.get(
      `/v1/auth/security-activity?limit=2&cursor=${first.next_cursor}`,
    );
    expect(stolen.statusCode).toBe(422);
    expect(stolen.json().error.issues[0].code).toBe('invalid_cursor');
    expect((await me.get('/v1/auth/security-activity?limit=0')).statusCode).toBe(422);
    expect((await me.get('/v1/auth/security-activity?limit=500')).statusCode).toBe(422);
    expect(
      (await me.get('/v1/auth/security-activity?cursor=not-a-cursor-at-all-xx')).statusCode,
    ).toBe(422);
    expect((await new Browser(env.app).get('/v1/auth/security-activity')).statusCode).toBe(401);
  });
});
