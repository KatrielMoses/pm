import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { newUuidV7 } from '@pm/contracts';
import { PlatformHealth, TenantContextError } from '@pm/db';
import { testDecision } from '@pm/lifecycle/testing';
import type { Caller } from '@pm/tenancy';
import { executionContext, syntheticPrincipal } from '@pm/test-support';
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

const TABLES = [
  'tenancy.membership',
  'tenancy.brand',
  'tenancy.brand_setting',
  'tenancy.scope_preference',
  'access.role',
  'access.role_assignment',
  'access.permission_epoch',
  'core.record',
];

/**
 * Isolation matrix (1C brief): three workspaces, two separate account owners plus a second owner
 * in one workspace, sensitive and archived brands, reused pooled connections, and the application
 * and worker database roles used directly.
 */
describe('tenant isolation matrix (1C)', () => {
  let db: TestDatabase;
  let env: TenancyEnv;
  let ann: Caller;
  let ben: Caller;
  const ws: Record<'a1' | 'a2' | 'b1', { publicId: string; id: string }> = {} as never;
  let sensitiveA1: string;
  let archivedA1: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = tenancyEnv(db);
    ann = await seedAccount(db);
    ben = await seedAccount(db);
    for (const [k, who] of [
      ['a1', ann],
      ['a2', ann],
      ['b1', ben],
    ] as const) {
      const publicId = (
        await env.svc.createWorkspace(who, { ...WORKSPACE_INPUT, name: `W ${k}` }, mutation())
      ).data.workspace.id;
      ws[k] = { publicId, id: await workspaceIdOf(db, publicId) };
      for (const n of ['Shared Name', `Only ${k}`])
        await env.svc.createBrand(who, publicId, { name: n }, mutation());
    }
    env.stepUp.allow = true;
    sensitiveA1 = (await env.svc.createBrand(ann, ws.a1.publicId, { name: 'Secret' }, mutation()))
      .data.id;
    await env.svc.setSensitivity(
      ann,
      ws.a1.publicId,
      sensitiveA1,
      { is_sensitive: true },
      mutation({ ifMatch: '"0"', stepUpToken: 't' }),
    );
    archivedA1 = (await env.svc.createBrand(ann, ws.a1.publicId, { name: 'Old' }, mutation())).data
      .id;
    await env.svc.archiveBrand(ann, ws.a1.publicId, archivedA1, mutation({ ifMatch: '"0"' }));
    // One connection, reused for every statement below: transaction-local context must not leak.
    pool = new pg.Pool({ connectionString: db.app, max: 1 });
  });
  afterAll(async () => {
    await pool.end();
    await env.h.close();
    await db.drop();
  });

  async function asApp(
    workspaceId: string | null,
    sql: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (workspaceId)
        await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }

  it('same brand names coexist across workspaces; each owner sees only their own workspaces', async () => {
    expect((await env.svc.listWorkspaces(ann)).map((w) => w.id).sort()).toEqual(
      [ws.a1.publicId, ws.a2.publicId].sort(),
    );
    expect((await env.svc.listWorkspaces(ben)).map((w) => w.id)).toEqual([ws.b1.publicId]);
    for (const k of ['a1', 'a2', 'b1'] as const) {
      const who = k === 'b1' ? ben : ann;
      const names = (await env.svc.listBrands(who, ws[k].publicId, {})).data.map((b) => b.name);
      expect(names).toContain('Shared Name');
      expect(names).toContain(`Only ${k}`);
      for (const other of ['a1', 'a2', 'b1'].filter((o) => o !== k))
        expect(names).not.toContain(`Only ${other}`);
    }
  });

  it('direct app_rw: unset context sees nothing in every tenant table; set context sees one workspace only', async () => {
    // Give every table at least one row in a1 and b1 (scope preferences are lazy).
    await env.svc.selectContext(ann, ws.a1.publicId, { scope: 'all' });
    await env.svc.selectContext(ben, ws.b1.publicId, { scope: 'all' });
    for (const t of TABLES) {
      expect((await asApp(null, `SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      const scoped = await asApp(ws.a1.id, `SELECT DISTINCT workspace_id FROM ${t}`);
      expect(
        scoped.rows.map((r) => r.workspace_id),
        t,
      ).toEqual([ws.a1.id]);
      // Rows of other workspaces exist (so the empty result above is RLS, not absence).
      const total = (await db.admin(`SELECT count(DISTINCT workspace_id)::int AS n FROM ${t}`))
        .rows[0].n;
      expect(total, t).toBeGreaterThan(1);
    }
    // The pooled connection keeps no context after the transaction.
    expect((await asApp(null, `SELECT exec.current_workspace_id() AS w`)).rows[0].w).toBeNull();
  });

  it('direct app_rw cannot write into another workspace or forge cross-workspace references', async () => {
    const brandB1 = (
      await db.admin(`SELECT id FROM tenancy.brand WHERE workspace_id = $1 LIMIT 1`, [ws.b1.id])
    ).rows[0].id;
    await expect(
      asApp(ws.a1.id, `UPDATE tenancy.brand SET name = 'pwned' WHERE id = $1`, [brandB1]),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      asApp(
        ws.a1.id,
        `INSERT INTO tenancy.scope_preference (workspace_id, owner_membership_id, scope_kind) VALUES ($1, $2, 'all')`,
        [ws.b1.id, newUuidV7()],
      ),
    ).rejects.toThrow(/row-level security|violates/);
    // A preference in a1 pointing at a b1 brand fails the same-workspace composite key.
    const memA1 = (
      await db.admin(`SELECT id FROM tenancy.membership WHERE workspace_id = $1 LIMIT 1`, [
        ws.a1.id,
      ])
    ).rows[0].id;
    await expect(
      asApp(
        ws.a1.id,
        `INSERT INTO tenancy.scope_preference (workspace_id, owner_membership_id, scope_kind, brand_id)
                        VALUES ($1, $2, 'brand', $3) ON CONFLICT (workspace_id, owner_membership_id) DO UPDATE SET scope_kind = EXCLUDED.scope_kind, brand_id = EXCLUDED.brand_id`,
        [ws.a1.id, memA1, brandB1],
      ),
    ).rejects.toThrow(/foreign key/);
    // Membership and grant tables are not writable beyond INSERT, and never via UPDATE/DELETE.
    await expect(asApp(ws.a1.id, `DELETE FROM access.role_assignment`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asApp(ws.a1.id, `UPDATE tenancy.membership SET state = 'removed'`),
    ).rejects.toThrow(/permission denied/);
    await expect(asApp(ws.a1.id, `UPDATE tenancy.workspace SET state = 'purging'`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('direct app_worker is read-only on tenancy and equally scoped', async () => {
    const worker = new pg.Pool({ connectionString: db.worker, max: 1 });
    try {
      const c = await worker.connect();
      try {
        await c.query('BEGIN');
        expect((await c.query(`SELECT count(*)::int AS n FROM tenancy.brand`)).rows[0].n).toBe(0);
        await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [ws.b1.id]);
        const rows = await c.query(`SELECT DISTINCT workspace_id FROM tenancy.brand`);
        expect(rows.rows.map((r) => r.workspace_id)).toEqual([ws.b1.id]);
        await expect(c.query(`UPDATE tenancy.brand SET name = 'x'`)).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    } finally {
      await worker.end();
    }
  });

  it('directory functions refuse tenant scope and reveal only the caller account', async () => {
    await expect(
      asApp(ws.a1.id, `SELECT * FROM tenancy.account_workspaces($1)`, [ann.auth.account.id]),
    ).resolves.toMatchObject({ rowCount: 0 });
    // Without platform scope nothing resolves either (the function checks exec.in_platform_scope()).
    expect(
      (
        await asApp(null, `SELECT * FROM tenancy.resolve_membership($1, $2)`, [
          ann.auth.account.id,
          ws.a1.publicId,
        ])
      ).rowCount,
    ).toBe(0);
    // Ben cannot resolve Ann's workspace even with platform scope.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.platform_scope', 'platform', true)`);
      expect(
        (
          await c.query(`SELECT * FROM tenancy.resolve_membership($1, $2)`, [
            ben.auth.account.id,
            ws.a1.publicId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await c.query(`SELECT * FROM tenancy.resolve_membership($1, $2)`, [
            ann.auth.account.id,
            ws.a1.publicId,
          ])
        ).rowCount,
      ).toBe(1);
      // Platform scope still sees no tenant rows directly.
      expect((await c.query(`SELECT count(*)::int AS n FROM tenancy.brand`)).rows[0].n).toBe(0);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });

  it('readiness reports tenant isolation drift (catalog only) and recovers when restored', async () => {
    const health = new PlatformHealth(env.h.pools.app);
    expect(await health.tenantIsolationIntact()).toBe(true);
    await db.admin(`ALTER TABLE tenancy.brand NO FORCE ROW LEVEL SECURITY`);
    expect(await health.tenantIsolationIntact()).toBe(false);
    await db.admin(`ALTER TABLE tenancy.brand FORCE ROW LEVEL SECURITY`);
    await db.admin(`ALTER FUNCTION tenancy.resolve_membership(uuid, text) SECURITY INVOKER`);
    expect(await health.tenantIsolationIntact()).toBe(false);
    await db.admin(`ALTER FUNCTION tenancy.resolve_membership(uuid, text) SECURITY DEFINER`);
    expect(await health.tenantIsolationIntact()).toBe(true);
  });

  it('a wrong or malformed context fails closed before any query', async () => {
    await expect(
      env.h.app.withWorkspace('not-a-uuid', { module: 'test' }, async () => 1),
    ).rejects.toBeInstanceOf(TenantContextError);
    await expect(
      env.h.app.withWorkspace(newUuidV7(), { module: 'test' }, async () => 1),
    ).rejects.toMatchObject({
      reason: 'workspace_unknown',
    });
  });

  it('all-brands union excludes sensitive-without-grant, archived, trashed, and purged brands from rows and counts', async () => {
    const second = await seedSecondOwner(db, ws.a1.id);
    // 1C exposes no trash route; trash through the real 1F command with a test decision so the
    // envelope, batch, and mirrored brand state are all genuine. Trashed brands must vanish.
    const trashed = (await env.svc.createBrand(ann, ws.a1.publicId, { name: 'Binned' }, mutation()))
      .data.id;
    const trashedId = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [trashed]))
      .rows[0].id as string;
    await env.h.app.withWorkspace(ws.a1.id, { module: 'test' }, (tx) =>
      env.lifecycle.trash(
        tx,
        testDecision('record.trash', ws.a1.id, {
          recordIds: [trashedId],
          principalId: newUuidV7(),
        }),
        { exec: executionContext(ws.a1.id, syntheticPrincipal('member')), source: { kind: 'ui' } },
        trashedId,
      ),
    );
    expect(
      (await db.admin(`SELECT lifecycle_state FROM tenancy.brand WHERE id = $1`, [trashedId]))
        .rows[0].lifecycle_state,
    ).toBe('trashed');
    for (const who of [ann, second.caller]) {
      const ctx = await env.svc.selectContext(who, ws.a1.publicId, { scope: 'all' });
      const ids = (ctx.scope as { brand_ids: string[] }).brand_ids;
      const listed = await env.svc.listBrands(who, ws.a1.publicId, { include_total: 'true' });
      expect(ids).toEqual(listed.data.map((b) => b.id));
      expect(listed.page.total!.value).toBe(ids.length);
      expect(ids).not.toContain(archivedA1);
      expect(ids).not.toContain(trashed);
      await expect(env.svc.getBrand(who, ws.a1.publicId, trashed)).rejects.toMatchObject({
        code: 'not_found',
      });
      if (who === ann) expect(ids).toContain(sensitiveA1);
      else expect(ids).not.toContain(sensitiveA1);
    }
    // Archived remains readable to authorized viewers, on request only.
    await expect(
      env.svc.getBrand(second.caller, ws.a1.publicId, archivedA1),
    ).resolves.toMatchObject({ lifecycle_state: 'archived' });
  });

  it('brand-scoped and workspace-scoped records are distinct: brand_id null vs. a real same-workspace brand', async () => {
    const brandA1 = (
      await db.admin(`SELECT id FROM tenancy.brand WHERE workspace_id = $1 LIMIT 1`, [ws.a1.id])
    ).rows[0].id;
    const brandB1 = (
      await db.admin(`SELECT id FROM tenancy.brand WHERE workspace_id = $1 LIMIT 1`, [ws.b1.id])
    ).rows[0].id;
    const insert = (brandId: string | null) =>
      asApp(
        ws.a1.id,
        `INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type)
         VALUES ($1, 'tsk_' || upper(substr(md5(random()::text), 1, 26)), 'task', $2, $3, 'system', 'system') RETURNING scope_key`,
        [newUuidV7(), ws.a1.id, brandId],
      );
    const wsScoped = await insert(null);
    expect(wsScoped.rows[0].scope_key).toBe(ws.a1.id);
    const brandScoped = await insert(brandA1);
    expect(brandScoped.rows[0].scope_key).toBe(brandA1);
    await expect(insert(brandB1)).rejects.toThrow(/foreign key/);
    await expect(insert(newUuidV7())).rejects.toThrow(/foreign key/);
  });
});
