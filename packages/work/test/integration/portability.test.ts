import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { mutation, workEnv, workspaceWith, type WorkEnv } from './fixture.ts';

describe('CSV portability operations (6D)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws } = await workspaceWith(env, db, ['Harbor']));
  }, 120_000);
  afterAll(async () => db?.drop());

  it('binds a preview to mapping version, applies idempotently, records provenance, and compensates rollback', async () => {
    const mapping = await env.svc.saveImportMapping(owner, ws, {
      name: 'Legacy task sheet',
      entity: 'task',
      mapping: { Summary: 'title' },
    });
    expect(mapping.mapping_version).toBe(1);
    const csv =
      'schema_version,source_row_key,public_id,Summary,source_actor,created_at\n1,source-1,tsk_01J8M5Y7A3B2C4D6E8F0G1H2J3,Imported task,actor_elsewhere,2026-01-02T03:04:05Z';
    const preview = await env.svc.previewPortabilityImportFor(owner, ws, {
      csv,
      entity: 'task',
      mapping_id: mapping.id,
      mapping_version: mapping.mapping_version,
    });
    expect(preview.valid).toBe(1);
    expect(preview.preview_id).toBeTruthy();

    const changed = await env.svc.saveImportMapping(owner, ws, {
      name: 'Legacy task sheet',
      entity: 'task',
      mapping: { Summary: 'title' },
      expected_version: 1,
    });
    expect(changed.mapping_version).toBe(2);
    await expect(
      env.svc.applyPortabilityImport(
        owner,
        ws,
        {
          csv,
          entity: 'task',
          mapping_id: mapping.id,
          mapping_version: mapping.mapping_version,
          preview_id: preview.preview_id,
          mode: 'all_or_nothing',
        },
        mutation(),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    const currentPreview = await env.svc.previewPortabilityImportFor(owner, ws, {
      csv,
      entity: 'task',
      mapping_id: changed.id,
      mapping_version: changed.mapping_version,
    });
    const request = {
      csv,
      entity: 'task',
      mapping_id: changed.id,
      mapping_version: changed.mapping_version,
      preview_id: currentPreview.preview_id,
      mode: 'all_or_nothing',
    };
    const req = mutation({ idempotencyKey: 'csv-portability-test-key-0001' });
    const applied = await env.svc.applyPortabilityImport(owner, ws, request, req);
    expect(applied.applied).toBe(1);
    expect(applied.rows?.[0]).toMatchObject({ row: 2, id: expect.any(String) });
    await db.admin(`UPDATE transfer.import_job SET state = 'running' WHERE id = $1::uuid`, [
      applied.import_job_id,
    ]);
    const resumed = await env.svc.applyPortabilityImport(owner, ws, request, req);
    expect(resumed.applied).toBe(1);
    expect(resumed.rows).toEqual(applied.rows);
    const replayed = await env.svc.applyPortabilityImport(owner, ws, request, req);
    expect('replayed' in replayed && replayed.replayed).toBe(true);
    expect('import_job_id' in replayed && replayed.import_job_id).toBe(applied.import_job_id);

    const provenance = await db.admin(
      `SELECT source_values->>'public_id' AS source_public_id,
              source_values->>'source_actor' AS source_actor,
              record_public_id
         FROM transfer.import_row WHERE import_job_id = $1::uuid`,
      [applied.import_job_id],
    );
    expect(provenance.rows).toHaveLength(1);
    expect(provenance.rows[0]).toMatchObject({
      source_public_id: 'tsk_01J8M5Y7A3B2C4D6E8F0G1H2J3',
      source_actor: 'actor_elsewhere',
    });
    expect(provenance.rows[0].record_public_id).not.toBe(provenance.rows[0].source_public_id);

    const duplicatePreview = await env.svc.previewPortabilityImportFor(owner, ws, {
      csv: 'schema_version,source_row_key,public_id,Summary\n1,source-1,tsk_01J8M5Y7A3B2C4D6E8F0G1H2J3,Changed task',
      entity: 'task',
      mapping_id: changed.id,
      mapping_version: changed.mapping_version,
    });
    expect(duplicatePreview.invalid).toBe(1);
    expect(duplicatePreview.rows[0]?.errors).toContain('duplicate_source_row_key');

    const rollback = await env.svc.rollbackPortabilityImport(
      owner,
      ws,
      applied.import_job_id,
      mutation(),
    );
    expect(rollback.rolled_back).toEqual([2]);
    const afterRollback = await env.svc.previewPortabilityImportFor(owner, ws, {
      csv: 'schema_version,source_row_key,public_id,Summary\n1,source-1,tsk_01J8M5Y7A3B2C4D6E8F0G1H2J3,Changed task',
      entity: 'task',
      mapping_id: changed.id,
      mapping_version: changed.mapping_version,
    });
    expect(afterRollback.valid).toBe(1);
  });

  it('keeps idempotency-key reuse with a different payload in conflict', async () => {
    const csvA = 'schema_version,title\n1,One';
    const csvB = 'schema_version,title\n1,Two';
    const previewA = await env.svc.previewPortabilityImportFor(owner, ws, {
      csv: csvA,
      entity: 'task',
    });
    const previewB = await env.svc.previewPortabilityImportFor(owner, ws, {
      csv: csvB,
      entity: 'task',
    });
    const key = 'csv-portability-test-key-0002';
    await env.svc.applyPortabilityImport(
      owner,
      ws,
      {
        csv: csvA,
        entity: 'task',
        preview_id: previewA.preview_id,
        mode: 'partial',
      },
      mutation({ idempotencyKey: key }),
    );
    await expect(
      env.svc.applyPortabilityImport(
        owner,
        ws,
        {
          csv: csvB,
          entity: 'task',
          preview_id: previewB.preview_id,
          mode: 'partial',
        },
        mutation({ idempotencyKey: key }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
