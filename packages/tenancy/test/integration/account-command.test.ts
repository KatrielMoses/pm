import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NonHumanPrincipal } from '@pm/identity';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { mutation, seedAccount, tenancyEnv, WORKSPACE_INPUT, type TenancyEnv } from './fixture.ts';

const reason = (code: string) => expect.objectContaining({ code });

/** 0C AZ-18 / T-36: workspace creation is a human-only account command with four gates. */
describe('workspace.create account command (AT-087…094)', () => {
  let db: TestDatabase;
  let env: TenancyEnv;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = tenancyEnv(db, [], { 'workspace.create': { limit: 2, windowMs: 3_600_000 } });
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  const workspaces = async (accountId: string) =>
    (
      await db.admin(
        `SELECT count(*)::int AS n FROM tenancy.workspace WHERE bootstrap_account_id = $1`,
        [accountId],
      )
    ).rows[0].n as number;

  it('non-human principals cannot create workspaces (AT-089…091)', async () => {
    const human = await seedAccount(db);
    for (const type of ['api_token_personal', 'agent_run', 'automation']) {
      const caller = { ...human, auth: { principal: 'non_human', type } as NonHumanPrincipal };
      await expect(
        env.svc.createWorkspace(caller as never, WORKSPACE_INPUT, mutation()),
      ).rejects.toEqual(reason('unauthenticated'));
    }
    expect(await workspaces(human.auth.account.id)).toBe(0);
  });

  it('account state is re-read from the database: deleted or unverified accounts are refused (AT-088)', async () => {
    const deleted = await seedAccount(db);
    await db.admin(
      `UPDATE identity.account SET deleted_at = now(), pseudonym = 'Deleted person' WHERE id = $1`,
      [deleted.auth.account.id],
    );
    await expect(env.svc.createWorkspace(deleted, WORKSPACE_INPUT, mutation())).rejects.toEqual(
      reason('unauthenticated'),
    );
    // The session snapshot says verified, but the account no longer is.
    const stale = await seedAccount(db);
    await db.admin(`UPDATE identity.account SET email_verified_at = NULL WHERE id = $1`, [
      stale.auth.account.id,
    ]);
    await expect(env.svc.createWorkspace(stale, WORKSPACE_INPUT, mutation())).rejects.toEqual(
      reason('forbidden'),
    );
    expect(await workspaces(deleted.auth.account.id)).toBe(0);
    expect(await workspaces(stale.auth.account.id)).toBe(0);
  });

  it('per-account rate limit; replays of a completed key consume nothing (AT-092, AT-094)', async () => {
    const owner = await seedAccount(db);
    const first = mutation({ body: 'first' });
    await env.svc.createWorkspace(owner, { ...WORKSPACE_INPUT, name: 'One' }, first);
    for (let i = 0; i < 3; i++)
      await expect(
        env.svc.createWorkspace(owner, { ...WORKSPACE_INPUT, name: 'One' }, first),
      ).resolves.toMatchObject({
        replayed: true,
      });
    await env.svc.createWorkspace(owner, { ...WORKSPACE_INPUT, name: 'Two' }, mutation());
    const limited = await env.svc
      .createWorkspace(owner, { ...WORKSPACE_INPUT, name: 'Three' }, mutation())
      .catch((e: unknown) => e);
    expect(limited).toMatchObject({ code: 'rate_limited' });
    expect((limited as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect(await workspaces(owner.auth.account.id)).toBe(2);
    // Another account has its own quota.
    const other = await seedAccount(db);
    await expect(
      env.svc.createWorkspace(other, WORKSPACE_INPUT, mutation()),
    ).resolves.toMatchObject({ status: 201 });
  });

  it('body claims about workspaces, roles, or memberships are refused (AT-093)', async () => {
    const owner = await seedAccount(db);
    await expect(
      env.svc.createWorkspace(
        owner,
        { ...WORKSPACE_INPUT, role: 'owner', workspace_id: 'ws_x', membership_id: 'mem_x' },
        mutation(),
      ),
    ).rejects.toEqual(reason('validation_failed'));
    expect(await workspaces(owner.auth.account.id)).toBe(0);
  });
});
