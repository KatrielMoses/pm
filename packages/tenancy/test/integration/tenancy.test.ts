import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenancyError, type Caller } from '@pm/tenancy';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  mutation,
  seedAccount,
  seedSecondOwner,
  tenancyEnv,
  WORKSPACE_INPUT,
  workspaceIdOf,
  type TenancyEnv,
} from './fixture.ts';

const reason = (code: string) => expect.objectContaining({ code });

describe('workspace bootstrap (1C)', () => {
  let db: TestDatabase;
  let env: TenancyEnv;
  let owner: Caller;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = tenancyEnv(db);
    owner = await seedAccount(db);
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('creates workspace, canonical membership, owner authority, epochs, audit, security, and first brand atomically', async () => {
    const res = await env.svc.createWorkspace(
      owner,
      { ...WORKSPACE_INPUT, first_brand: { name: 'North Line', color: '#AA3311', icon: 'leaf' } },
      mutation(),
    );
    expect(res).toMatchObject({ status: 201, replayed: false });
    expect(res.data.workspace).toMatchObject({
      type: 'workspace',
      name: 'Synthetic Studio',
      timezone: 'Europe/Berlin',
      locale: 'en-GB',
      currency: 'EUR',
      week_start: 1,
      version: 0,
      capabilities: { configure: true, create_brand: true },
    });
    expect(res.data.workspace.id).toMatch(/^ws_/);
    expect(res.data.first_brand).toMatchObject({
      name: 'North Line',
      color: '#aa3311',
      icon: 'leaf',
    });
    const ws = await workspaceIdOf(db, res.data.workspace.id);
    const m = await db.admin(
      `SELECT m.state, m.kind, w.bootstrap_membership_id = m.id AS bootstrap
         FROM tenancy.membership m JOIN tenancy.workspace w ON w.id = m.workspace_id WHERE m.workspace_id = $1`,
      [ws],
    );
    expect(m.rows).toEqual([{ state: 'active', kind: 'member', bootstrap: true }]);
    const roles = await db.admin(
      `SELECT r.key, a.scope_type, a.grant_source FROM access.role_assignment a
         JOIN access.role r ON r.id = a.role_id WHERE a.workspace_id = $1 ORDER BY a.scope_type DESC`,
      [ws],
    );
    expect(roles.rows).toEqual([
      { key: 'owner', scope_type: 'workspace', grant_source: 'bootstrap_owner' },
      { key: 'scope_manage', scope_type: 'brand', grant_source: 'brand_creator' },
    ]);
    expect(
      (await db.admin(`SELECT count(*)::int AS n FROM access.role WHERE workspace_id = $1`, [ws]))
        .rows[0].n,
    ).toBe(10);
    const epochs = await db.admin(
      `SELECT epoch_kind FROM access.permission_epoch WHERE workspace_id = $1 ORDER BY 1`,
      [ws],
    );
    expect(epochs.rows.map((r) => r.epoch_kind)).toEqual(['principal', 'workspace']);
    const audit = await db.admin(
      `SELECT action FROM audit.audit_event WHERE workspace_id = $1 ORDER BY chain_seq`,
      [ws],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'workspace.created',
      'membership.created',
      'role_assignment.created',
      'record.created',
      'brand.created',
      'role_assignment.created',
    ]);
    const security = await db.admin(
      `SELECT category, action FROM audit.security_event WHERE workspace_id = $1`,
      [ws],
    );
    expect(security.rows).toEqual([
      { category: 'permission', action: 'role_assignment.created' },
      { category: 'permission', action: 'role_assignment.created' },
    ]);
  });

  it('an Idempotency-Key retry returns the original workspace; a different body is key reuse; races create one', async () => {
    const req = mutation({ body: 'same' });
    const first = await env.svc.createWorkspace(
      owner,
      { ...WORKSPACE_INPUT, name: 'Retry Co' },
      req,
    );
    const again = await env.svc.createWorkspace(
      owner,
      { ...WORKSPACE_INPUT, name: 'Retry Co' },
      req,
    );
    expect(again).toMatchObject({ status: 201, replayed: true });
    expect(again.data.workspace.id).toBe(first.data.workspace.id);
    await expect(
      env.svc.createWorkspace(
        owner,
        { ...WORKSPACE_INPUT, name: 'Other' },
        { ...req, fingerprint: Buffer.alloc(32, 7) },
      ),
    ).rejects.toEqual(reason('idempotency_key_reuse'));

    const race = mutation({ body: 'race' });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        env.svc.createWorkspace(owner, { ...WORKSPACE_INPUT, name: 'Race Co' }, race),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(6);
    const ids = new Set(
      ok.map(
        (r) =>
          (r as PromiseFulfilledResult<{ data: { workspace: { id: string } } }>).value.data
            .workspace.id,
      ),
    );
    expect(ids.size).toBe(1);
    expect(
      (await db.admin(`SELECT count(*)::int AS n FROM tenancy.workspace WHERE name = 'Race Co'`))
        .rows[0].n,
    ).toBe(1);
  });

  it('refuses unverified accounts and invalid defaults with field issues', async () => {
    const unverified = await seedAccount(db, { verified: false });
    await expect(env.svc.createWorkspace(unverified, WORKSPACE_INPUT, mutation())).rejects.toEqual(
      reason('forbidden'),
    );
    const err = await env.svc
      .createWorkspace(
        owner,
        { name: ' ', timezone: 'Mars/Base', locale: 'xx_YY', currency: 'EURO', week_start: 9 },
        mutation(),
      )
      .catch((e: TenancyError) => e);
    expect(err).toBeInstanceOf(TenancyError);
    expect((err as TenancyError).issues.map((i) => i.pointer)).toEqual([
      '/name',
      '/timezone',
      '/locale',
      '/currency',
      '/week_start',
    ]);
  });

  it('the last owner cannot be removed, suspended, or demoted (database-enforced)', async () => {
    const res = await env.svc.createWorkspace(
      owner,
      { ...WORKSPACE_INPUT, name: 'Owned' },
      mutation(),
    );
    const ws = await workspaceIdOf(db, res.data.workspace.id);
    await expect(
      db.admin(
        `DELETE FROM access.role_assignment WHERE workspace_id = $1 AND scope_type = 'workspace'`,
        [ws],
      ),
    ).rejects.toThrow(/owner/);
    await expect(
      db.admin(
        `UPDATE tenancy.membership SET state = 'suspended', suspended_at = now(), version = version + 1
          WHERE workspace_id = $1`,
        [ws],
      ),
    ).rejects.toThrow(/owner/);
    await expect(
      db.admin(
        `UPDATE access.role_assignment SET role_id = (SELECT id FROM access.role WHERE workspace_id = $1 AND key = 'member')
          WHERE workspace_id = $1 AND scope_type = 'workspace'`,
        [ws],
      ),
    ).rejects.toThrow(/owner|permission|denied/);
    // 1D: column-scoped transitions only; memberships are never deleted (history, ownership).
    const grants = await db.admin(
      `SELECT has_column_privilege('app_rw', 'access.role_assignment', 'role_id', 'UPDATE') AS u,
              has_column_privilege('app_rw', 'access.role_assignment', 'principal_id', 'UPDATE') AS up,
              has_table_privilege('app_rw', 'tenancy.membership', 'DELETE') AS md,
              has_column_privilege('app_rw', 'tenancy.membership', 'account_id', 'UPDATE') AS ma`,
    );
    expect(grants.rows[0]).toEqual({ u: true, up: false, md: false, ma: false });
  });

  it('a workspace created without its bootstrap owner cannot commit', async () => {
    await expect(
      db.admin(
        `INSERT INTO tenancy.workspace (id, public_id, name, timezone, locale, currency, week_start,
           created_by_actor_type, updated_by_actor_type, creation_key_hash, creation_request_hash, bootstrap_account_id)
         VALUES (uuidv7(), 'ws_01J0000000000000000000000Z', 'Orphan', 'UTC', 'en', 'USD', 1, 'system', 'system',
           decode(repeat('ab', 32), 'hex'), decode(repeat('cd', 32), 'hex'), $1)`,
        [owner.auth.account.id],
      ),
    ).rejects.toThrow(/bootstrap owner/);
  });

  it('updates workspace defaults by field merge with per-field audit; stale same-field edits conflict', async () => {
    const res = await env.svc.createWorkspace(
      owner,
      { ...WORKSPACE_INPUT, name: 'Merge Co' },
      mutation(),
    );
    const id = res.data.workspace.id;
    const a = await env.svc.updateWorkspace(
      owner,
      id,
      { version: 0, changes: { timezone: { base: 'Europe/Berlin', value: 'America/New_York' } } },
      mutation(),
    );
    expect(a.data).toMatchObject({ timezone: 'America/New_York', version: 1 });
    // Different field, stale version: merges.
    const b = await env.svc.updateWorkspace(
      owner,
      id,
      { version: 0, changes: { currency: { base: 'EUR', value: 'USD' } } },
      mutation(),
    );
    expect(b.data).toMatchObject({ currency: 'USD', timezone: 'America/New_York', version: 2 });
    // Same field, stale base: conflict, nothing applied.
    const err = await env.svc
      .updateWorkspace(
        owner,
        id,
        {
          version: 0,
          changes: {
            timezone: { base: 'Europe/Berlin', value: 'Asia/Tokyo' },
            week_start: { base: 1, value: 7 },
          },
        },
        mutation(),
      )
      .catch((e: TenancyError) => e);
    expect(err).toMatchObject({
      code: 'conflict',
      conflict: {
        current_version: 2,
        would_merge: ['week_start'],
        fields: [{ field: 'timezone', theirs: 'America/New_York' }],
      },
    });
    await expect(
      env.svc.updateWorkspace(
        owner,
        id,
        { changes: { logo_file_ref: { base: null, value: 'file_01J0000000000000000000000Z' } } },
        mutation(),
      ),
    ).rejects.toEqual(reason('validation_failed'));
    await expect(
      env.svc.updateWorkspace(
        owner,
        id,
        { changes: { state: { base: 'active', value: 'purging' } } },
        mutation(),
      ),
    ).rejects.toEqual(reason('validation_failed'));
    const ws = await workspaceIdOf(db, id);
    const audit = await db.admin(
      `SELECT changes FROM audit.audit_event WHERE workspace_id = $1 AND action = 'workspace.updated' ORDER BY chain_seq`,
      [ws],
    );
    expect(
      audit.rows.map((r) => (r.changes as Array<{ field: string }>).map((c) => c.field)),
    ).toEqual([['timezone'], ['currency']]);
  });
});

describe('brands, sensitivity, and isolation (1C)', () => {
  let db: TestDatabase;
  let env: TenancyEnv;
  let alice: Caller;
  let bob: Caller;
  let wsA: string;
  let wsB: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = tenancyEnv(db);
    alice = await seedAccount(db);
    bob = await seedAccount(db);
    wsA = (await env.svc.createWorkspace(alice, { ...WORKSPACE_INPUT, name: 'Alpha' }, mutation()))
      .data.workspace.id;
    wsB = (await env.svc.createWorkspace(bob, { ...WORKSPACE_INPUT, name: 'Beta' }, mutation()))
      .data.workspace.id;
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('creates brands with race-safe case-insensitive name uniqueness per workspace', async () => {
    const one = await env.svc.createBrand(alice, wsA, { name: 'Harbor' }, mutation());
    expect(one).toMatchObject({
      status: 201,
      data: { name: 'Harbor', timezone: 'Europe/Berlin', operational_status: 'operating' },
    });
    await expect(env.svc.createBrand(alice, wsA, { name: 'harbor' }, mutation())).rejects.toEqual(
      reason('validation_failed'),
    );
    // Same name in another workspace is fine.
    await expect(
      env.svc.createBrand(bob, wsB, { name: 'Harbor' }, mutation()),
    ).resolves.toMatchObject({ status: 201 });
    const race = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        env.svc.createBrand(alice, wsA, { name: 'Raced' }, mutation()),
      ),
    );
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of race.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'validation_failed' });
    await expect(
      env.svc.createBrand(
        alice,
        wsA,
        { name: '<script>x</script>\u0007', color: 'red', icon: 'skull', is_sensitive: true },
        mutation(),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('another account cannot read, list, write, or select across workspaces (identical not_found)', async () => {
    const brand = (await env.svc.createBrand(alice, wsA, { name: 'Private Line' }, mutation()))
      .data;
    await expect(env.svc.getWorkspace(bob, wsA)).rejects.toEqual(reason('not_found'));
    await expect(env.svc.listBrands(bob, wsA, {})).rejects.toEqual(reason('not_found'));
    await expect(env.svc.getContext(bob, wsA)).rejects.toEqual(reason('not_found'));
    // Guessed public ID through the caller's own workspace path: not_found.
    await expect(env.svc.getBrand(bob, wsB, brand.id)).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.selectContext(bob, wsB, { scope: 'brand', brand_id: brand.id }),
    ).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.updateBrand(
        bob,
        wsB,
        brand.id,
        { changes: { name: { base: 'Private Line', value: 'x' } } },
        mutation(),
      ),
    ).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.archiveBrand(bob, wsB, brand.id, mutation({ ifMatch: '"0"' })),
    ).rejects.toEqual(reason('not_found'));
    // Malformed and unknown workspace IDs: the same answer.
    for (const bad of ['nope', 'ws_01J0000000000000000000000Z', 42, undefined])
      await expect(env.svc.getWorkspace(alice, bad)).rejects.toEqual(reason('not_found'));
  });

  it('sensitive brands need the explicit grant: owners without it see nothing (rows, counts, context)', async () => {
    const brand = (await env.svc.createBrand(alice, wsA, { name: 'Confidential' }, mutation()))
      .data;
    // Step-up is mandatory: without a valid token the server issues a bound challenge.
    const noStep = await env.svc
      .setSensitivity(alice, wsA, brand.id, { is_sensitive: true }, mutation({ ifMatch: '"0"' }))
      .catch((e: TenancyError) => e);
    expect(noStep).toMatchObject({
      code: 'step_up_required',
      stepUp: { action_key: 'brand.mark_sensitive' },
    });
    expect(env.stepUp.challenges.at(-1)).toMatchObject({ actionKey: 'brand.mark_sensitive' });
    expect((await env.svc.getBrand(alice, wsA, brand.id)).is_sensitive).toBe(false);

    env.stepUp.allow = true;
    await expect(
      env.svc.setSensitivity(
        alice,
        wsA,
        brand.id,
        { is_sensitive: true },
        mutation({ ifMatch: '"0"' }),
      ),
    ).rejects.toEqual(reason('step_up_required')); // no Step-Up token presented
    const marked = await env.svc.setSensitivity(
      alice,
      wsA,
      brand.id,
      { is_sensitive: true },
      mutation({ ifMatch: '"0"', stepUpToken: 'token-from-verified-challenge' }),
    );
    expect(marked.data).toMatchObject({
      is_sensitive: true,
      version: 1,
      capabilities: { configure: true },
    });
    env.stepUp.allow = false;
    // The creator keeps access through the explicit grant (never locked out).
    await expect(env.svc.getBrand(alice, wsA, brand.id)).resolves.toMatchObject({
      is_sensitive: true,
    });

    // A second owner of the same workspace without a grant: the brand does not exist for them.
    const second = await seedSecondOwner(db, await workspaceIdOf(db, wsA));
    await expect(env.svc.getBrand(second.caller, wsA, brand.id)).rejects.toEqual(
      reason('not_found'),
    );
    const theirs = await env.svc.listBrands(second.caller, wsA, { include_total: 'true' });
    expect(theirs.data.map((b) => b.id)).not.toContain(brand.id);
    expect(theirs.page.total?.value).toBe(theirs.data.length);
    const ctx = await env.svc.selectContext(second.caller, wsA, { scope: 'all' });
    expect(ctx.scope.kind).toBe('all');
    expect((ctx.scope as { brand_ids: string[] }).brand_ids).not.toContain(brand.id);
    expect(ctx.brands.map((b) => b.id)).not.toContain(brand.id);
    await expect(
      env.svc.selectContext(second.caller, wsA, { scope: 'brand', brand_id: brand.id }),
    ).rejects.toEqual(reason('not_found'));
    const mine = await env.svc.listBrands(alice, wsA, { include_total: 'true' });
    expect(mine.data.map((b) => b.id)).toContain(brand.id);
    expect(mine.page.total!.value).toBe(theirs.page.total!.value + 1);

    const ws = await workspaceIdOf(db, wsA);
    const sec = await db.admin(
      `SELECT action FROM audit.security_event WHERE workspace_id = $1 AND action = 'brand.sensitivity_changed'`,
      [ws],
    );
    expect(sec.rows).toHaveLength(1);
  });

  it('paginates by keyset with cursors bound to workspace, membership, and query', async () => {
    for (const n of ['Delta', 'Echo', 'Foxtrot'])
      await env.svc.createBrand(alice, wsA, { name: n }, mutation());
    const all = await env.svc.listBrands(alice, wsA, { include_total: 'true' });
    const p1 = await env.svc.listBrands(alice, wsA, { limit: '2' });
    expect(p1.page).toMatchObject({ limit: 2, has_more: true });
    const p2 = await env.svc.listBrands(alice, wsA, { limit: '2', cursor: p1.page.next_cursor });
    expect([...p1.data, ...p2.data].map((b) => b.id)).toEqual(
      all.data.slice(0, 4).map((b) => b.id),
    );
    // Cursor reuse with another query, another workspace, or another member: cursor_invalid.
    await expect(
      env.svc.listBrands(alice, wsA, {
        limit: '2',
        state: 'archived',
        cursor: p1.page.next_cursor,
      }),
    ).rejects.toEqual(reason('cursor_invalid'));
    await expect(
      env.svc.listBrands(bob, wsB, { limit: '2', cursor: p1.page.next_cursor }),
    ).rejects.toEqual(reason('cursor_invalid'));
    await expect(
      env.svc.listBrands(alice, wsA, { cursor: 'tampered-cursor-value-xx' }),
    ).rejects.toEqual(reason('cursor_invalid'));
  });
});
