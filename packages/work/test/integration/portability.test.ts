import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { parseCsv, previewCsv, serializeCsv } from '../../src/portability/csv.ts';
import { join, mutation, workEnv, workspaceWith, type WorkEnv } from './fixture.ts';

describe('CSV portability operations (6D)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let brand: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    const seeded = await workspaceWith(env, db, ['Harbor']);
    ({ owner, ws } = seeded);
    brand = seeded.brands.Harbor!;
  }, 120_000);
  afterAll(async () => db?.drop());

  it('binds a preview to mapping version, applies idempotently, records provenance, and compensates rollback', async () => {
    const mapping = await env.svc.saveImportMapping(owner, ws, {
      name: 'Legacy task sheet',
      entity: 'task',
      mapping: { Summary: 'title' },
    });
    expect(mapping.mapping_version).toBe(1);
    const csv = `schema_version,source_row_key,public_id,Summary,source_actor,created_at,brand_id\n1,source-1,tsk_01J8M5Y7A3B2C4D6E8F0G1H2J3,Imported task,actor_elsewhere,2026-01-02T03:04:05Z,${brand}`;
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
    const task = await env.svc.getTask(owner, ws, applied.rows![0]!.id);
    expect(task.source).toMatchObject({ kind: 'import' });
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
    const csvA = `schema_version,title,brand_id\n1,One,${brand}`;
    const csvB = `schema_version,title,brand_id\n1,Two,${brand}`;
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

  it('exports goals in the import schema and preserves their measurement and period', async () => {
    const created = await env.svc.createGoal(
      owner,
      ws,
      {
        title: 'Reach a measurable outcome',
        period: { kind: 'custom', start: '2026-01-01', end: '2026-12-31' },
        metric: { unit: 'customers', baseline: 0, target: 100, current: 4 },
      },
      mutation(),
    );
    const exported = await env.svc.exportPortabilityCsv(owner, ws, 'goal');
    const preview = previewCsv(exported.csv, 'goal');
    expect(preview.invalid).toBe(0);
    const row = preview.rows.find((r) => r.values.public_id === created.data.id)!;
    expect(row.values).toMatchObject({ target: '100', current: '4', unit: 'customers' });
    expect(JSON.parse(row.values.period!)).toEqual({
      kind: 'custom',
      start: '2026-01-01',
      end: '2026-12-31',
    });
    expect(parseCsv(exported.csv)[0]).toContain('schema_version');
  });

  it('reports an exact export limit as complete when no additional rows exist', async () => {
    const exported = await env.svc.exportPortabilityCsv(owner, ws, 'task');
    const bounded = await env.svc.exportPortabilityCsv(owner, ws, 'task', exported.rows);
    expect(bounded.rows).toBe(exported.rows);
    expect(bounded.truncated).toBe(false);
  });

  it('denies exports to a read-only member on both records and history', async () => {
    const reader = await join(env, db, owner, ws, { kind: 'member', role: 'read_only' });
    await expect(env.svc.exportPortabilityCsv(reader, ws, 'task')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      env.svc.exportPortabilityHistory(reader, ws, 'task_activity', {}),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('exports comment history through its governing record and denies a foreign workspace', async () => {
    const created = await env.svc.createTask(
      owner,
      ws,
      { title: 'History host', brand },
      mutation(),
    );
    const comment = await env.svc.createComment(
      owner,
      ws,
      created.data.id,
      { text: 'A portable comment' },
      mutation(),
    );
    const csv = await env.svc.exportPortabilityHistory(owner, ws, 'comments', {
      record: created.data.id,
    });
    expect(csv.rows).toBe(1);
    expect(csv.csv).toContain(comment.data.id);
    expect(csv.csv).toContain('A portable comment');
    const foreign = await workspaceWith(env, db, ['Other']);
    await expect(
      env.svc.exportPortabilityHistory(foreign.owner, foreign.ws, 'comments', {
        record: created.data.id,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rolls back every row and audit when a later atomic row fails authorization', async () => {
    const csv = `schema_version,title,brand_id\n1,Atomic first,${brand}\n1,Atomic second,br_00000000000000000000000000`;
    const preview = await env.svc.previewPortabilityImportFor(owner, ws, { csv, entity: 'task' });
    await expect(
      env.svc.applyPortabilityImport(
        owner,
        ws,
        {
          csv,
          entity: 'task',
          preview_id: preview.preview_id,
          mode: 'all_or_nothing',
        },
        mutation(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    const remaining = await db.admin(
      "SELECT count(*)::int AS n FROM work.task WHERE title IN ('Atomic first', 'Atomic second')",
    );
    expect(remaining.rows[0]?.n).toBe(0);
  });

  it('reports partial failures individually and permits rollback of completed rows', async () => {
    const csv = `schema_version,title,brand_id\n1,Partial first,${brand}\n1,Partial second,br_00000000000000000000000000`;
    const preview = await env.svc.previewPortabilityImportFor(owner, ws, { csv, entity: 'task' });
    const result = await env.svc.applyPortabilityImport(
      owner,
      ws,
      {
        csv,
        entity: 'task',
        preview_id: preview.preview_id,
        mode: 'partial',
      },
      mutation(),
    );
    expect(result.applied).toBe(1);
    expect(result.rows).toEqual([
      { row: 2, id: expect.any(String) },
      { row: 3, error: 'not_found' },
    ]);
    const beforeExport = await db.admin(
      "SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'portability.exported'",
    );
    const errors = await env.svc.exportImportErrors(owner, ws, result.import_job_id);
    expect(errors.csv).toContain('not_found');
    expect(errors.csv).not.toContain('Partial second');
    const other = await join(env, db, owner, ws, { kind: 'member', role: 'read_only' });
    await expect(env.svc.exportImportErrors(other, ws, result.import_job_id)).rejects.toMatchObject(
      { code: 'not_found' },
    );
    const exported = await db.admin(
      "SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'portability.exported'",
    );
    expect(exported.rows[0]?.n).toBe(beforeExport.rows[0]?.n + 1);
    expect(
      await env.svc.rollbackPortabilityImport(owner, ws, result.import_job_id, mutation()),
    ).toMatchObject({ rolled_back: [2] });
  });

  it('gates audit export by authority, entitlement and fresh verification', async () => {
    const reader = await join(env, db, owner, ws, { kind: 'member', role: 'read_only' });
    await expect(env.svc.exportPortabilityAudit(reader, ws, mutation())).rejects.toMatchObject({
      code: 'forbidden',
    });
    const disabled = workEnv(db, { auditExportAllowed: false });
    await expect(disabled.svc.exportPortabilityAudit(owner, ws, mutation())).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(env.svc.exportPortabilityAudit(owner, ws, mutation())).rejects.toMatchObject({
      code: 'step_up_required',
    });
    env.stepUp.allow = true;
    try {
      const result = await env.svc.exportPortabilityAudit(
        owner,
        ws,
        mutation({ stepUpToken: 't' }),
      );
      expect(result.data.csv).toContain('occurred_at');
      expect(result.data.csv).not.toContain('source_values');
      expect(result.data.rows).toBeGreaterThan(0);
    } finally {
      env.stepUp.allow = false;
    }
  });

  it('resolves an explicit source-row parent through canonical task authorization', async () => {
    const csv = `schema_version,source_row_key,title,brand_id,parent_id\n1,tree-parent,Imported parent,${brand},\n1,tree-child,Imported child,,@tree-parent`;
    const preview = await env.svc.previewPortabilityImportFor(owner, ws, { csv, entity: 'task' });
    const result = await env.svc.applyPortabilityImport(
      owner,
      ws,
      {
        csv,
        entity: 'task',
        preview_id: preview.preview_id,
        mode: 'all_or_nothing',
      },
      mutation(),
    );
    expect(result.applied).toBe(2);
    const child = await env.svc.getTask(owner, ws, result.rows![1]!.id);
    expect(child.parent).toMatchObject({ id: result.rows![0]!.id });
    expect(
      await env.svc.rollbackPortabilityImport(owner, ws, result.import_job_id, mutation()),
    ).toMatchObject({ rolled_back: [3, 2] });
  });

  it.each([
    ['project', { name: 'CSV project' }],
    [
      'workflow',
      {
        name: 'CSV workflow',
        record_kind: 'task',
        scope: 'workspace',
        statuses: [
          { name: 'Ready', category: 'planned' },
          { name: 'Done', category: 'done' },
        ],
      },
    ],
    ['field', { name: 'CSV field', field_type: 'text', scope: 'workspace', applies_to: ['task'] }],
    [
      'goal',
      { title: 'CSV goal', period: { kind: 'custom', start: '2026-01-01', end: '2026-12-31' } },
    ],
    ['document', { title: 'CSV document', document_type: 'page' }],
    ['file', { name: 'CSV external reference', link_url: 'https://example.test/reference' }],
  ] as const)(
    'imports and rolls back supported %s rows through canonical commands',
    async (entity, values) => {
      const row = {
        schema_version: '1',
        ...values,
        ...(entity === 'project' ? { brand_id: brand } : {}),
      };
      const csv = serializeCsv(Object.keys(row), [row]);
      const preview = await env.svc.previewPortabilityImportFor(owner, ws, { csv, entity });
      expect(preview.invalid, JSON.stringify(preview.rows)).toBe(0);
      const result = await env.svc.applyPortabilityImport(
        owner,
        ws,
        {
          csv,
          entity,
          preview_id: preview.preview_id,
          mode: 'all_or_nothing',
        },
        mutation(),
      );
      expect(result.applied).toBe(1);
      expect(result.rows?.[0]?.id).toBeTruthy();
      expect(
        await env.svc.rollbackPortabilityImport(owner, ws, result.import_job_id, mutation()),
      ).toMatchObject({ rolled_back: [2] });
    },
  );
});
