import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import type { RecordTypeAdapter } from '@pm/lifecycle';
import type { Caller, TenancyError } from '@pm/tenancy';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  mutation,
  seedAccount,
  tenancyEnv,
  WORKSPACE_INPUT,
  workspaceIdOf,
  type TenancyEnv,
} from './fixture.ts';

const reason = (code: string) => expect.objectContaining({ code });

/**
 * A synthetic record type contained directly by brands (test database only), proving that brand
 * archive follows registered containment through Phase 1F and nothing else.
 */
const contained: RecordTypeAdapter = {
  recordType: 'foundation_fixture',
  async rootsInBrand(tx, brandIds) {
    const rows = await tx.db
      .selectFrom('core.record')
      .select(['id', 'record_type'])
      .where('record_type', '=', 'foundation_fixture')
      .where('brand_id', 'in', [...brandIds])
      .execute();
    return rows.map((r) => ({ id: r.id, recordType: r.record_type }));
  },
};

describe('brand archive/restore, settings, and context (1C)', () => {
  let db: TestDatabase;
  let env: TenancyEnv;
  let owner: Caller;
  let ws: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.admin(
      `INSERT INTO core.record_type (record_type, public_id_prefix, owner_module, test_only)
         VALUES ('foundation_fixture', 'fxt', 'fixture', true)`,
    );
    env = tenancyEnv(db, [contained]);
    owner = await seedAccount(db);
    ws = (
      await env.svc.createWorkspace(owner, { ...WORKSPACE_INPUT, name: 'Lifecycle Co' }, mutation())
    ).data.workspace.id;
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  async function addContained(brandPublicId: string): Promise<string> {
    const wsId = await workspaceIdOf(db, ws);
    const brandId = (
      await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [brandPublicId])
    ).rows[0].id;
    const id = newUuidV7();
    await db.admin(
      `INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type)
       VALUES ($1, $2, 'foundation_fixture', $3, $4, 'system', 'system')`,
      [id, newPublicId('fxt' as never), wsId, brandId],
    );
    return id;
  }

  it('archive and restore go through Phase 1F with If-Match, cascade only through containment, and keep IDs/settings', async () => {
    const brand = (await env.svc.createBrand(owner, ws, { name: 'Seasonal' }, mutation())).data;
    const child = await addContained(brand.id);
    await expect(env.svc.archiveBrand(owner, ws, brand.id, mutation())).rejects.toEqual(
      reason('precondition_required'),
    );
    await expect(
      env.svc.archiveBrand(owner, ws, brand.id, mutation({ ifMatch: '"7"' })),
    ).rejects.toMatchObject({
      code: 'conflict',
      conflict: { current_version: 0 },
    });
    const req = mutation({ ifMatch: '"0"' });
    const archived = await env.svc.archiveBrand(owner, ws, brand.id, req);
    expect(archived.data).toMatchObject({
      id: brand.id,
      lifecycle_state: 'archived',
      version: 1,
      capabilities: { configure: false, restore: true },
    });
    // Same key: replayed; same result, nothing archived twice.
    expect(await env.svc.archiveBrand(owner, ws, brand.id, req)).toMatchObject({
      replayed: true,
      data: { lifecycle_state: 'archived' },
    });
    const states = await db.admin(
      `SELECT r.id, r.lifecycle_state, r.archive_cause FROM core.record r WHERE r.id = $1 OR r.public_id = $2 ORDER BY r.record_type`,
      [child, brand.id],
    );
    expect(states.rows.map((r) => [r.lifecycle_state, r.archive_cause])).toEqual([
      ['archived', 'self'],
      ['archived', 'cascade'],
    ]);
    // Archived: readable, excluded from default lists and context, writes refused.
    expect((await env.svc.listBrands(owner, ws, {})).data.map((b) => b.id)).not.toContain(brand.id);
    expect(
      (await env.svc.listBrands(owner, ws, { state: 'archived' })).data.map((b) => b.id),
    ).toEqual([brand.id]);
    await expect(env.svc.getBrand(owner, ws, brand.id)).resolves.toMatchObject({
      lifecycle_state: 'archived',
    });
    const ctx = await env.svc.getContext(owner, ws, { includeArchived: true });
    expect(ctx.brands.map((b) => b.id)).not.toContain(brand.id);
    expect(ctx.archived_brands!.map((b) => b.id)).toEqual([brand.id]);
    await expect(
      env.svc.updateBrand(
        owner,
        ws,
        brand.id,
        { changes: { color: { base: '#336699', value: '#000000' } } },
        mutation(),
      ),
    ).rejects.toEqual(reason('conflict'));
    await expect(
      env.svc.updateBrandSettings(
        owner,
        ws,
        brand.id,
        'priorities',
        { schema_version: 1, entries: [] },
        mutation({ ifMatch: '"0"' }),
      ),
    ).rejects.toEqual(reason('conflict'));

    const restored = await env.svc.restoreBrand(owner, ws, brand.id, mutation({ ifMatch: '"1"' }));
    expect(restored.data).toMatchObject({ id: brand.id, lifecycle_state: 'active', version: 2 });
    const after = await db.admin(`SELECT lifecycle_state FROM core.record WHERE id = $1`, [child]);
    expect(after.rows[0].lifecycle_state).toBe('active');
    await expect(env.svc.getBrandSettings(owner, ws, brand.id)).resolves.toMatchObject({
      version: 0,
    });
    const wsId = await workspaceIdOf(db, ws);
    const audit = await db.admin(
      `SELECT action, count(*)::int AS n FROM audit.audit_event WHERE workspace_id = $1 AND action IN ('record.archived', 'record.unarchived') GROUP BY 1 ORDER BY 1`,
      [wsId],
    );
    expect(audit.rows).toEqual([
      { action: 'record.archived', n: 2 },
      { action: 'record.unarchived', n: 2 },
    ]);
  });

  it('concurrent archives with different keys: one wins, the other sees a version conflict', async () => {
    const brand = (await env.svc.createBrand(owner, ws, { name: 'Contended' }, mutation())).data;
    const results = await Promise.allSettled([
      env.svc.archiveBrand(owner, ws, brand.id, mutation({ ifMatch: '"0"' })),
      env.svc.archiveBrand(owner, ws, brand.id, mutation({ ifMatch: '"0"' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'conflict' });
    const batches = await db.admin(
      `SELECT count(*)::int AS n FROM core.archive_batch b JOIN core.record r ON r.id = b.root_record_id WHERE r.public_id = $1`,
      [brand.id],
    );
    expect(batches.rows[0].n).toBe(1);
  });

  it('concurrent sensitivity transitions: one wins, the loser conflicts; one grant, one epoch bump each', async () => {
    const brand = (await env.svc.createBrand(owner, ws, { name: 'Vault' }, mutation())).data;
    env.stepUp.allow = true;
    try {
      const results = await Promise.allSettled(
        [true, true].map(() =>
          env.svc.setSensitivity(
            owner,
            ws,
            brand.id,
            { is_sensitive: true },
            mutation({ ifMatch: '"0"', stepUpToken: 't' }),
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
      ).toMatchObject({
        code: 'conflict',
        conflict: { current_version: 1 },
      });
    } finally {
      env.stepUp.allow = false;
    }
    const grants = await db.admin(
      `SELECT grant_source FROM access.role_assignment a JOIN core.record r ON r.id = a.brand_scope_id
        WHERE r.public_id = $1 ORDER BY 1`,
      [brand.id],
    );
    // The creator grant already existed, so marking sensitive added none (no lockout, no duplicate).
    expect(grants.rows.map((r) => r.grant_source)).toEqual(['brand_creator']);
    const sec = await db.admin(
      `SELECT count(*)::int AS n FROM audit.security_event WHERE action = 'brand.sensitivity_changed'
         AND subject_id = (SELECT id FROM core.record WHERE public_id = $1)`,
      [brand.id],
    );
    expect(sec.rows[0].n).toBe(1);
  });

  it('a brand purge blocks safely (no brand purge hooks are registered in 1C)', () => {
    expect(env.registry.missingPurgeHooks(['brand'])).toEqual(['brand']);
  });

  it('settings: If-Match versions, overlap validation, concurrent writers, reserved namespaces untouched', async () => {
    const brand = (await env.svc.createBrand(owner, ws, { name: 'Hours' }, mutation())).data;
    const initial = await env.svc.getBrandSettings(owner, ws, brand.id);
    expect(initial).toMatchObject({
      version: 0,
      timezone: 'Europe/Berlin',
      working_hours: { schema_version: 1 },
    });
    const overlap = await env.svc
      .updateBrandSettings(
        owner,
        ws,
        brand.id,
        'working_hours',
        {
          schema_version: 1,
          days: [
            {
              weekday: 1,
              ranges: [
                { start: '09:00', end: '12:00' },
                { start: '11:00', end: '14:00' },
              ],
            },
          ],
        },
        mutation({ ifMatch: '"0"' }),
      )
      .catch((e: TenancyError) => e);
    expect(overlap).toMatchObject({
      code: 'validation_failed',
      issues: [{ pointer: '/working_hours/days/0/ranges', code: 'overlap' }],
    });
    const hours = {
      schema_version: 1,
      days: [
        {
          weekday: 6,
          ranges: [
            { start: '13:00', end: '24:00' },
            { start: '08:00', end: '12:00' },
          ],
        },
      ],
    };
    const results = await Promise.allSettled([
      env.svc.updateBrandSettings(
        owner,
        ws,
        brand.id,
        'working_hours',
        hours,
        mutation({ ifMatch: '"0"' }),
      ),
      env.svc.updateBrandSettings(
        owner,
        ws,
        brand.id,
        'priorities',
        { schema_version: 1, entries: [{ kind: 'goal', text: 'Open a second shop' }] },
        mutation({ ifMatch: '"0"' }),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({
      code: 'conflict',
      conflict: { current_version: 1 },
    });
    await expect(
      env.svc.updateBrandSettings(owner, ws, brand.id, 'working_hours', hours, mutation()),
    ).rejects.toEqual(reason('precondition_required'));
    await expect(
      env.svc.updateBrandSettings(owner, ws, brand.id, 'ai', {}, mutation({ ifMatch: '"1"' })),
    ).rejects.toEqual(reason('not_found'));
    const saved = await env.svc.updateBrandSettings(
      owner,
      ws,
      brand.id,
      'working_hours',
      hours,
      mutation({ ifMatch: '"1"' }),
    );
    // Stored canonical: ranges sorted.
    expect(saved.data.working_hours).toEqual({
      schema_version: 1,
      days: [
        {
          weekday: 6,
          ranges: [
            { start: '08:00', end: '12:00' },
            { start: '13:00', end: '24:00' },
          ],
        },
      ],
    });
    const reserved = await db.admin(
      `SELECT notification_settings, ai_settings, integration_settings FROM tenancy.brand_setting s
         JOIN core.record r ON r.id = s.brand_id WHERE r.public_id = $1`,
      [brand.id],
    );
    expect(reserved.rows[0]).toEqual({
      notification_settings: null,
      ai_settings: null,
      integration_settings: null,
    });
  });

  it('context: server-derived; stale selections narrow, never broaden to all brands', async () => {
    const fresh = await seedAccount(db);
    const ws2 = (
      await env.svc.createWorkspace(fresh, { ...WORKSPACE_INPUT, name: 'Context Co' }, mutation())
    ).data.workspace.id;
    expect(await env.svc.getContext(fresh, ws2)).toMatchObject({
      scope: { kind: 'none' },
      fallback: 'no_selection',
      brands: [],
    });
    const a = (await env.svc.createBrand(fresh, ws2, { name: 'Alpha Brand' }, mutation())).data;
    const b = (await env.svc.createBrand(fresh, ws2, { name: 'Bravo Brand' }, mutation())).data;
    expect(await env.svc.getContext(fresh, ws2)).toMatchObject({
      scope: { kind: 'brand', brand_id: a.id },
      fallback: 'no_selection',
    });
    expect(await env.svc.selectContext(fresh, ws2, { scope: 'all' })).toMatchObject({
      scope: { kind: 'all', brand_ids: [a.id, b.id] },
      fallback: null,
    });
    expect(
      await env.svc.selectContext(fresh, ws2, { scope: 'brand', brand_id: b.id }),
    ).toMatchObject({
      scope: { kind: 'brand', brand_id: b.id },
    });
    // The selected brand is archived: fall back to an authorized active brand, not to all brands.
    await env.svc.archiveBrand(fresh, ws2, b.id, mutation({ ifMatch: '"0"' }));
    expect(await env.svc.getContext(fresh, ws2)).toMatchObject({
      scope: { kind: 'brand', brand_id: a.id },
      fallback: 'stale_selection',
    });
    await expect(
      env.svc.selectContext(fresh, ws2, { scope: 'brand', brand_id: b.id }),
    ).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.selectContext(fresh, ws2, { scope: 'brand', brand_id: 'garbage' }),
    ).rejects.toEqual(reason('not_found'));
    await expect(env.svc.selectContext(fresh, ws2, { scope: 'everything' })).rejects.toEqual(
      reason('validation_failed'),
    );
    // Body claims about other workspaces or memberships are refused, never trusted.
    await expect(
      env.svc.selectContext(fresh, ws2, { scope: 'all', workspace_id: ws, membership_id: 'mem_x' }),
    ).rejects.toEqual(reason('validation_failed'));
    // Workspace list and last selection come from the directory (own memberships only).
    const list = await env.svc.listWorkspaces(fresh);
    expect(list).toEqual([{ id: ws2, type: 'workspace', name: 'Context Co', selected: true }]);
  });

  it('EXPLAIN: the brand list predicate and envelope join can use their indexes', async () => {
    const wsId = await workspaceIdOf(db, ws);
    const plan = await db.admin(
      `BEGIN;
       SET LOCAL enable_seqscan = off;
       SET LOCAL ROLE app_rw;
       SELECT set_config('app.workspace_id', '${wsId}', true);
       EXPLAIN (FORMAT JSON)
         SELECT b.id, r.public_id FROM tenancy.brand b
           JOIN core.record r ON r.workspace_id = b.workspace_id AND r.id = b.id
          WHERE b.lifecycle_state IN ('active') AND (b.is_sensitive = false OR b.id IN ('${newUuidV7()}'))
          ORDER BY lower(b.name), b.id LIMIT 51;
       COMMIT;`,
    );
    const text = JSON.stringify((plan as unknown as Array<{ rows: unknown[] }>).at(-2)!.rows);
    expect(text).not.toMatch(/"Seq Scan"/);
    expect(text).toMatch(/brand_(visible|name_unique)|brand_workspace_key|brand_pkey/);
    const grants = await db.admin(
      `BEGIN; SET LOCAL enable_seqscan = off; SET LOCAL ROLE app_rw;
       SELECT set_config('app.workspace_id', '${wsId}', true);
       EXPLAIN (FORMAT JSON) SELECT a.brand_scope_id FROM access.role_assignment a
         WHERE a.membership_principal_id = '${newUuidV7()}';
       COMMIT;`,
    );
    const grantPlan = JSON.stringify(
      (grants as unknown as Array<{ rows: unknown[] }>).at(-2)!.rows,
    );
    expect(grantPlan).not.toMatch(/"Seq Scan"/);
    expect(grantPlan).toMatch(/"Index Name":"role_assignment_[a-z_]+"/);
    // The RLS predicate is an index condition (tenant-leading keys), never a post-scan filter only.
    expect(grantPlan).toMatch(/"Index Cond":"\(workspace_id = /);
  });
});
