import { createHash } from 'node:crypto';
import { newUuidV7 } from '@pm/contracts';
import { sql } from '@pm/db';
import { TenancyError, type Caller, type Mutation } from '@pm/tenancy';
import { CalendarService } from '../integrations/calendar-service.ts';
import {
  PORTABLE_ENTITIES,
  PORTABLE_FIELDS,
  PORTABILITY_SCHEMA_VERSION,
  CSV_LIMITS,
  previewCsv,
  serializeCsv,
  type ImportPreview,
  type PortableEntity,
} from './csv.ts';

const MAX_EXPORT_ROWS = 10_000;
const MAX_IMPORT_ROWS = 2_000;
export const IMPORT_ROLLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/** CSV portability boundary. All reads delegate to the same permission-filtered record lists. */
export class PortabilityService extends CalendarService {
  private async requirePortabilityScope(caller: Caller, scope: 'records:read' | 'records:write') {
    if (!caller.delegation) return;
    if (!caller.delegation.scopes.includes(scope)) throw new TenancyError('forbidden');
    const rate = await this.limitApi(caller.delegation.tokenId, scope === 'records:write');
    if (!rate.allowed)
      throw new TenancyError('rate_limited', { retryAfterSeconds: rate.retryAfterSeconds });
  }

  private csvNumber(value: string | undefined): number | null {
    if (value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TenancyError('validation_failed');
    return number;
  }

  private async prepareImportJob(
    caller: Caller,
    ws: unknown,
    preview: ImportPreview,
    mode: 'partial' | 'all_or_nothing',
  ): Promise<{ id: string; replay: boolean }> {
    const candidateId = newUuidV7();
    const digest = Buffer.from(preview.digest, 'hex');
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const existing = await tx.db
        .selectFrom('transfer.import_job')
        .select(['id', 'state'])
        .where('owner_membership_id', '=', p.membershipId)
        .where('content_sha256', '=', digest)
        .where('entity_kind', '=', preview.entity)
        .where('apply_mode', '=', mode)
        .where('state', '!=', 'rolled_back')
        .executeTakeFirst();
      const id = existing?.id ?? candidateId;
      if (existing && (existing.state === 'completed' || existing.state === 'partial'))
        return { id: existing.id, replay: true };
      if (existing) {
        await tx.db
          .updateTable('transfer.import_job')
          .set({ state: 'running', updated_at: new Date() })
          .where('id', '=', id)
          .execute();
      } else {
        await tx.db
          .insertInto('transfer.import_job')
          .values({
            id,
            workspace_id: tx.workspaceId,
            owner_membership_id: p.membershipId,
            content_sha256: digest,
            entity_kind: preview.entity,
            state: 'running',
            apply_mode: mode,
            row_count: preview.rows.length,
            applied_count: 0,
            error_count: 0,
            checkpoint_row: 0,
            rollback_until: new Date(Date.now() + IMPORT_ROLLBACK_WINDOW_MS),
          })
          .execute();
      }
      for (const item of preview.rows) {
        await tx.db
          .insertInto('transfer.import_row')
          .values({
            workspace_id: tx.workspaceId,
            import_job_id: id,
            row_number: item.row,
            source_row_key: item.values.source_row_key ?? null,
            source_values: JSON.stringify(item.values),
            state: item.errors.length ? 'error' : 'pending',
            issues: JSON.stringify(item.errors.map((code) => ({ code }))),
            record_type: null,
            record_id: null,
            record_public_id: null,
            applied_version: null,
          })
          .onConflict((oc) =>
            oc.columns(['workspace_id', 'import_job_id', 'row_number']).doUpdateSet({
              source_values: JSON.stringify(item.values),
              state: item.errors.length ? 'error' : 'pending',
              issues: JSON.stringify(item.errors.map((code) => ({ code }))),
              updated_at: new Date(),
            }),
          )
          .execute();
      }
      return { id, replay: false };
    });
  }

  private validateMapping(entity: string, mapping: unknown): Record<string, string> {
    if (
      !PORTABLE_ENTITIES.includes(entity as PortableEntity) ||
      !mapping ||
      typeof mapping !== 'object' ||
      Array.isArray(mapping)
    )
      throw new TenancyError('validation_failed');
    const allowed = new Set<string>(PORTABLE_FIELDS[entity as PortableEntity]);
    const entries = Object.entries(mapping as Record<string, unknown>);
    if (entries.length > 100) throw new TenancyError('validation_failed');
    const normalized: Record<string, string> = {};
    const targets = new Set<string>();
    for (const [source, target] of entries) {
      if (
        !source.trim() ||
        source.length > 100 ||
        typeof target !== 'string' ||
        !allowed.has(target) ||
        targets.has(target)
      )
        throw new TenancyError('validation_failed');
      normalized[source] = target;
      targets.add(target);
    }
    return Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
  }

  async listImportMappings(caller: Caller, ws: unknown) {
    await this.requirePortabilityScope(caller, 'records:read');
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const rows = await tx.db
        .selectFrom('transfer.import_mapping')
        .select([
          'id',
          'name',
          'entity_kind',
          'schema_version',
          'column_mapping',
          'created_at',
          'updated_at',
        ])
        .where('owner_membership_id', '=', p.membershipId)
        .orderBy('name')
        .limit(100)
        .execute();
      return rows.map((row) => ({ ...row, column_mapping: row.column_mapping }));
    });
  }

  async saveImportMapping(caller: Caller, ws: unknown, input: unknown) {
    await this.requirePortabilityScope(caller, 'records:write');
    const b = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const entity = String(b.entity ?? '');
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 80) throw new TenancyError('validation_failed');
    const mapping = this.validateMapping(entity, b.mapping);
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const current = await tx.db
        .selectFrom('transfer.import_mapping')
        .select('id')
        .where('owner_membership_id', '=', p.membershipId)
        .where(sql<boolean>`lower(name) = ${name.toLowerCase()}`)
        .executeTakeFirst();
      const id = current?.id ?? newUuidV7();
      if (current) {
        await tx.db
          .updateTable('transfer.import_mapping')
          .set({
            entity_kind: entity as PortableEntity,
            schema_version: PORTABILITY_SCHEMA_VERSION,
            column_mapping: JSON.stringify(mapping),
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .execute();
      } else {
        await tx.db
          .insertInto('transfer.import_mapping')
          .values({
            id,
            workspace_id: tx.workspaceId,
            owner_membership_id: p.membershipId,
            name,
            entity_kind: entity as PortableEntity,
            schema_version: PORTABILITY_SCHEMA_VERSION,
            column_mapping: JSON.stringify(mapping),
          })
          .execute();
      }
      await this.workAudit(
        tx,
        caller,
        p,
        'portability.mapping_saved',
        { recordId: null, type: 'workspace', publicId: null },
        [],
        null,
      );
      await this.d.security.record(tx, {
        category: 'export',
        action: 'portability.mapping.save',
        outcome: 'success',
        actor: { type: 'human', id: p.membershipId },
        subject: { type: 'workspace', id: tx.workspaceId },
        correlationId: caller.meta.correlationId,
      });
      return { id, name, entity, mapping };
    });
  }

  async deleteImportMapping(caller: Caller, ws: unknown, mappingId: unknown) {
    await this.requirePortabilityScope(caller, 'records:write');
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const removed = await tx.db
        .deleteFrom('transfer.import_mapping')
        .where('owner_membership_id', '=', p.membershipId)
        .where('id', '=', String(mappingId))
        .returning('id')
        .executeTakeFirst();
      if (!removed) throw new TenancyError('not_found');
      await this.workAudit(
        tx,
        caller,
        p,
        'portability.mapping_deleted',
        { recordId: null, type: 'workspace', publicId: null },
        [],
        null,
      );
      return { deleted: true };
    });
  }

  private async saveImportCheckpoint(
    caller: Caller,
    ws: unknown,
    jobId: string,
    row: number,
    state: 'applied' | 'error' | 'rolled_back',
    data: { publicId?: string; entity?: string; version?: number; issue?: string } = {},
  ) {
    await this.inWorkspace(caller, ws, {}, async (tx) => {
      await tx.db
        .updateTable('transfer.import_row')
        .set({
          state,
          ...(data.publicId
            ? {
                record_type: data.entity ?? null,
                record_public_id: data.publicId,
                applied_version: data.version ?? null,
              }
            : {}),
          ...(data.issue ? { issues: JSON.stringify([{ code: data.issue }]) } : {}),
          updated_at: new Date(),
        })
        .where('import_job_id', '=', jobId)
        .where('row_number', '=', row)
        .execute();
      await tx.db
        .updateTable('transfer.import_job')
        .set({ checkpoint_row: row, updated_at: new Date() })
        .where('id', '=', jobId)
        .execute();
    });
  }

  async exportPortabilityCsv(caller: Caller, ws: unknown, entity: string, cap = MAX_EXPORT_ROWS) {
    if (!PORTABLE_ENTITIES.includes(entity as PortableEntity)) throw new TenancyError('not_found');
    await this.requirePortabilityScope(caller, 'records:read');
    const limit = Math.min(Math.max(Math.trunc(cap) || MAX_EXPORT_ROWS, 1), MAX_EXPORT_ROWS);
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    let suppliedCsv: string | undefined;
    let suppliedRows: number | undefined;
    if (entity === 'goal') {
      const result = await this.exportGoals(caller, ws, { format: 'csv' });
      suppliedCsv = result.body;
      suppliedRows = result.rows;
      truncated = result.rows >= limit;
    } else if (entity === 'workflow') {
      const result = await this.listWorkflows(caller, ws, { state: 'all' });
      const data = (result as { data: unknown[] }).data;
      for (const value of data.slice(0, limit)) {
        const w = value as Record<string, unknown>;
        rows.push({
          schema_version: '1',
          public_id: w.id,
          name: w.name,
          record_kind: w.record_kind,
          description: w.description,
          scope: w.scope,
          statuses: w.statuses,
        });
      }
      truncated = data.length > limit;
    } else if (entity === 'field') {
      const result = await this.listFieldDefinitions(caller, ws, { state: 'all' });
      const data = (result as { data: unknown[] }).data;
      for (const value of data.slice(0, limit)) {
        const f = value as Record<string, unknown>;
        rows.push({
          schema_version: '1',
          public_id: f.id,
          name: f.name,
          field_type: f.field_type,
          description: f.description,
          config: f.config,
          scope: f.scope,
        });
      }
      truncated = data.length > limit;
    } else if (entity === 'document') {
      let cursor: string | undefined;
      do {
        const result = (await this.listDocuments(caller, ws, {
          limit: Math.min(200, limit - rows.length),
          ...(cursor ? { cursor } : {}),
        })) as { data: unknown[]; page?: { has_more?: boolean; next_cursor?: string | null } };
        for (const value of result.data) {
          if (rows.length >= limit) break;
          const d = value as Record<string, unknown>;
          const attachment =
            d.attachment && typeof d.attachment === 'object'
              ? (d.attachment as Record<string, unknown>)
              : {};
          rows.push({
            schema_version: '1',
            public_id: d.id,
            title: d.title,
            document_type: d.doc_type,
            project_id: attachment.kind === 'project' ? attachment.id : '',
            parent_id: d.parent_id,
            created_at: d.created_at,
            updated_at: d.updated_at,
          });
        }
        if (rows.length >= limit) {
          truncated = Boolean(result.page?.has_more);
          break;
        }
        if (!result.page?.has_more || !result.page.next_cursor) break;
        cursor = result.page.next_cursor;
      } while (rows.length < limit);
    } else if (entity === 'file') {
      const result = (await this.listFiles(caller, ws, 'workspace')) as { data: unknown[] };
      for (const value of result.data.slice(0, limit)) {
        const f = value as Record<string, unknown>;
        const version =
          f.current && typeof f.current === 'object' ? (f.current as Record<string, unknown>) : {};
        const host =
          f.host && typeof f.host === 'object' ? (f.host as Record<string, unknown>) : {};
        rows.push({
          schema_version: '1',
          public_id: f.id,
          name: f.name,
          media_type: version.content_type,
          size_bytes: version.byte_size,
          checksum_sha256: version.sha256,
          host_kind: host.kind,
          host_public_id: host.id,
          scan_state: version.scan_state,
          created_at: f.created_at,
          updated_at: f.updated_at,
        });
      }
      truncated = result.data.length > limit;
    }
    const append = (record: unknown) => {
      if (entity === 'task') {
        const t = record as Record<string, unknown>;
        const status = t.status as { key?: string } | null;
        rows.push({
          schema_version: '1',
          source_row_key: t.id,
          public_id: t.id,
          title: t.title,
          status: status?.key ?? '',
          priority: t.priority,
          start_date: t.start_date,
          due_date: t.due_date,
          estimate_minutes: t.estimate_minutes,
          remaining_estimate_minutes: t.remaining_estimate_minutes,
          brand_id: (t.brand as { id?: string } | null)?.id ?? '',
          project_id: (t.project as { id?: string } | null)?.id ?? '',
          parent_id: (t.parent as { id?: string } | null)?.id ?? '',
          source_actor: (t.created_by as { id?: string } | null)?.id ?? '',
          created_at: t.created_at,
          updated_at: t.updated_at,
          lifecycle_state: t.lifecycle_state,
        });
      } else {
        const p = record as Record<string, unknown>;
        const status = p.status as { key?: string } | null;
        rows.push({
          schema_version: '1',
          source_row_key: p.id,
          public_id: p.id,
          name: p.name,
          status: status?.key ?? '',
          priority: p.priority,
          health: p.health,
          target_date: p.target_date,
          brand_id: (p.brand as { id?: string } | null)?.id ?? '',
          parent_id: p.parent ?? '',
          source_actor: (p.created_by as { id?: string } | null)?.id ?? '',
          created_at: p.created_at,
          updated_at: p.updated_at,
          lifecycle_state: p.lifecycle_state,
        });
      }
    };
    if (entity === 'project') {
      const batch = await this.listProjects(caller, ws, { limit: Math.min(limit, 200) });
      batch.data.forEach(append);
      truncated = Number(batch.total.value) > rows.length;
    } else if (entity === 'task') {
      let cursor: string | undefined;
      while (rows.length < limit) {
        const batch = await this.listTasks(caller, ws, {
          limit: Math.min(200, limit - rows.length),
          ...(cursor ? { cursor } : {}),
        });
        batch.data.forEach(append);
        if (!batch.page.has_more || rows.length >= limit) {
          truncated = rows.length >= limit || batch.page.has_more;
          break;
        }
        cursor = batch.page.next_cursor;
        if (!cursor) break;
      }
    }
    const headers = PORTABLE_FIELDS[entity as PortableEntity];
    await this.inWorkspace(caller, ws, {}, async (tx, p) => {
      if (entity !== 'goal')
        await this.workAudit(
          tx,
          caller,
          p,
          'portability.exported',
          { recordId: null, type: 'workspace', publicId: null },
          [],
          null,
        );
      if (entity !== 'goal')
        await this.d.security.record(tx, {
          category: 'export',
          action: `portability.${entity}.export`,
          outcome: 'success',
          actor: { type: 'human', id: p.membershipId },
          subject: { type: 'workspace', id: tx.workspaceId },
          correlationId: caller.meta.correlationId,
        });
    });
    let csv: string;
    try {
      csv = suppliedCsv ?? serializeCsv(headers, rows);
      if (Buffer.byteLength(csv, 'utf8') > CSV_LIMITS.bytes)
        throw new Error('csv_export_too_large');
    } catch {
      throw new TenancyError('limit_exceeded');
    }
    return {
      csv,
      rows: suppliedRows ?? rows.length,
      truncated,
      filename: `workspace-${entity}s.csv`,
    };
  }

  previewPortabilityImport(input: unknown): ImportPreview {
    const b = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (typeof b.csv !== 'string' || b.csv.length > 5 * 1024 * 1024)
      throw new TenancyError('validation_failed');
    try {
      const result = previewCsv(
        b.csv,
        String(b.entity ?? ''),
        b.mapping as Record<string, string> | undefined,
      );
      if (result.rows.length > MAX_IMPORT_ROWS) throw new Error('csv_too_many_rows');
      return result;
    } catch {
      throw new TenancyError('validation_failed');
    }
  }

  async previewPortabilityImportFor(
    caller: Caller,
    ws: unknown,
    input: unknown,
  ): Promise<ImportPreview> {
    await this.requirePortabilityScope(caller, 'records:read');
    const b = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (b.mapping_id === undefined) return this.previewPortabilityImport(input);
    const entity = String(b.entity ?? '');
    const mapping = await this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) =>
      tx.db
        .selectFrom('transfer.import_mapping')
        .select(['entity_kind', 'schema_version', 'column_mapping'])
        .where('id', '=', String(b.mapping_id))
        .where('owner_membership_id', '=', p.membershipId)
        .executeTakeFirst(),
    );
    if (
      !mapping ||
      mapping.entity_kind !== entity ||
      mapping.schema_version !== PORTABILITY_SCHEMA_VERSION
    )
      throw new TenancyError('not_found');
    return this.previewPortabilityImport({ ...b, mapping: mapping.column_mapping });
  }

  /** Validation-only import endpoint foundation; applying rows is deliberately explicit. */
  async applyPortabilityImport(caller: Caller, ws: unknown, input: unknown, req: Mutation) {
    await this.requirePortabilityScope(caller, 'records:write');
    const b = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const preview = await this.previewPortabilityImportFor(caller, ws, input);
    if (b.dry_run === true) return { preview, applied: 0, dry_run: true };
    if (b.mode === 'all_or_nothing' && !['task', 'project'].includes(preview.entity))
      throw new TenancyError('validation_failed');
    if (!req.idempotencyKey || req.idempotencyKey.length < 16)
      throw new TenancyError('validation_failed');
    // Apply only rows whose destinations are explicit existing public IDs; no tenant, role,
    // membership, permission, actor, or internal identifier fields are ever accepted as authority.
    if (b.mode !== 'partial' && b.mode !== 'all_or_nothing')
      throw new TenancyError('validation_failed');
    if (preview.invalid && b.mode === 'all_or_nothing')
      return { preview, applied: 0, dry_run: false };
    const prepared = await this.prepareImportJob(
      caller,
      ws,
      preview,
      b.mode as 'partial' | 'all_or_nothing',
    );
    const jobId = prepared.id;
    if (prepared.replay) {
      return this.inWorkspace(caller, ws, { readOnly: true }, async (tx) => {
        const rows = await tx.db
          .selectFrom('transfer.import_row')
          .select(['row_number', 'state', 'issues', 'record_public_id'])
          .where('import_job_id', '=', jobId)
          .orderBy('row_number')
          .execute();
        return {
          preview,
          applied: rows.filter((row) => row.state === 'applied').length,
          dry_run: false,
          import_job_id: jobId,
          replayed: true,
          rows: rows.map((row) => ({
            row: row.row_number,
            ...(row.record_public_id ? { id: row.record_public_id } : {}),
            ...(row.state === 'error' ? { error: 'row_rejected' } : {}),
          })),
        };
      });
    }
    const results: Array<{ row: number; id?: string; error?: string }> = [];
    let applied = 0;
    for (const item of preview.rows) {
      if (item.errors.length) {
        results.push({ row: item.row, error: item.errors[0] });
        await this.saveImportCheckpoint(caller, ws, jobId, item.row, 'error', {
          issue: item.errors[0],
        });
        continue;
      }
      const v = item.values;
      const hash = createHash('sha256')
        .update(`${preview.digest}:${item.row}`)
        .digest('hex')
        .slice(0, 48);
      const rowReq = {
        ...req,
        idempotencyKey: `csv_${hash}`,
        fingerprint: createHash('sha256').update(`${preview.digest}:${item.row}`).digest(),
      };
      try {
        const created =
          preview.entity === 'task'
            ? await this.createTask(
                caller,
                ws,
                {
                  title: v.title,
                  ...(v.brand_id ? { brand: v.brand_id } : {}),
                  ...(v.project_id ? { project: v.project_id } : {}),
                  ...(v.parent_id ? { parent: v.parent_id } : {}),
                  ...(v.status ? { status: v.status } : {}),
                  ...(v.priority ? { priority: v.priority } : {}),
                  ...(v.start_date ? { start_date: v.start_date } : {}),
                  ...(v.due_date ? { due_date: v.due_date } : {}),
                  ...(v.estimate_minutes ? { estimate_minutes: Number(v.estimate_minutes) } : {}),
                  ...(v.remaining_estimate_minutes
                    ? { remaining_estimate_minutes: Number(v.remaining_estimate_minutes) }
                    : {}),
                },
                rowReq,
              )
            : preview.entity === 'project'
              ? await this.createProject(
                  caller,
                  ws,
                  {
                    name: v.name,
                    ...(v.brand_id ? { brand: v.brand_id } : {}),
                    ...(v.parent_id ? { parent: v.parent_id } : {}),
                    ...(v.status ? { status: v.status } : {}),
                    ...(v.priority ? { priority: v.priority } : {}),
                    ...(v.health ? { health: v.health } : {}),
                    ...(v.target_date ? { target_date: v.target_date } : {}),
                  },
                  rowReq,
                )
              : preview.entity === 'goal'
                ? await this.createGoal(
                    caller,
                    ws,
                    {
                      title: v.title,
                      ...(v.project_id ? { project: v.project_id } : {}),
                      status: v.status || 'active',
                      basis: v.basis || 'manual',
                      period: JSON.parse(v.period ?? '{}') as unknown,
                      metric: {
                        unit: v.unit || null,
                        baseline: this.csvNumber(v.baseline),
                        target: this.csvNumber(v.target),
                        current: this.csvNumber(v.current),
                      },
                    },
                    rowReq,
                  )
                : preview.entity === 'document'
                  ? await this.createDocument(
                      caller,
                      ws,
                      {
                        title: v.title,
                        type: v.document_type || 'page',
                        ...(v.project_id ? { project: v.project_id } : {}),
                        ...(v.parent_id ? { parent: v.parent_id } : {}),
                        state: 'draft',
                      },
                      rowReq,
                    )
                  : preview.entity === 'workflow'
                    ? await this.createWorkflow(
                        caller,
                        ws,
                        {
                          name: v.name,
                          record_kind: v.record_kind,
                          ...(v.scope ? { scope: JSON.parse(v.scope) as unknown } : {}),
                          statuses: JSON.parse(v.statuses ?? '[]') as unknown,
                        },
                        rowReq,
                      )
                    : preview.entity === 'field'
                      ? await this.createFieldDefinition(
                          caller,
                          ws,
                          {
                            name: v.name,
                            field_type: v.field_type,
                            ...(v.scope ? { scope: JSON.parse(v.scope) as unknown } : {}),
                            ...(v.config ? { config: JSON.parse(v.config) as unknown } : {}),
                          },
                          rowReq,
                        )
                      : (() => {
                          throw new TenancyError('validation_failed');
                        })();
        const createdData = (created as { data: { id: string; version?: number } }).data;
        results.push({ row: item.row, id: createdData.id });
        applied++;
        await this.saveImportCheckpoint(caller, ws, jobId, item.row, 'applied', {
          publicId: createdData.id,
          entity: preview.entity,
          version: createdData.version,
        });
      } catch (error) {
        if (b.mode === 'all_or_nothing') {
          for (const done of results.filter((r) => r.id)) {
            try {
              const rollbackKey = createHash('sha256')
                .update(`${req.idempotencyKey}:rollback:${done.row}`)
                .digest('hex')
                .slice(0, 48);
              if (preview.entity === 'task')
                await this.taskLifecycle(
                  caller,
                  ws,
                  done.id,
                  'trash',
                  {},
                  { ...rowReq, idempotencyKey: `csv_rb_${rollbackKey}` },
                );
              else
                await this.projectLifecycle(caller, ws, done.id, 'trash', {
                  ...rowReq,
                  idempotencyKey: `csv_rb_${rollbackKey}`,
                });
              await this.saveImportCheckpoint(caller, ws, jobId, done.row, 'rolled_back');
            } catch {
              throw new TenancyError('conflict');
            }
          }
          await this.inWorkspace(caller, ws, {}, async (tx) => {
            await tx.db
              .updateTable('transfer.import_job')
              .set({ state: 'failed', updated_at: new Date() })
              .where('id', '=', jobId)
              .execute();
          });
          await this.inWorkspace(caller, ws, {}, async (tx, p) => {
            await this.workAudit(
              tx,
              caller,
              p,
              'portability.import_failed',
              { recordId: null, type: 'workspace', publicId: null },
              [],
              null,
            );
            await this.d.security.record(tx, {
              category: 'export',
              action: 'portability.import',
              outcome: 'failure',
              actor: { type: 'human', id: p.membershipId },
              subject: { type: 'workspace', id: tx.workspaceId },
              correlationId: caller.meta.correlationId,
            });
          });
          throw error;
        }
        results.push({
          row: item.row,
          error: error instanceof TenancyError ? error.code : 'row_rejected',
        });
        await this.saveImportCheckpoint(caller, ws, jobId, item.row, 'error', {
          issue: error instanceof TenancyError ? error.code : 'row_rejected',
        });
      }
    }
    await this.inWorkspace(caller, ws, {}, async (tx, p) => {
      await tx.db
        .updateTable('transfer.import_job')
        .set({
          state: results.some((r) => r.error) ? 'partial' : 'completed',
          applied_count: applied,
          error_count: results.filter((r) => r.error).length,
          checkpoint_row: preview.rows.at(-1)?.row ?? 0,
          rollback_until: new Date(Date.now() + IMPORT_ROLLBACK_WINDOW_MS),
          updated_at: new Date(),
        })
        .where('id', '=', jobId)
        .execute();
      await this.workAudit(
        tx,
        caller,
        p,
        'portability.imported',
        { recordId: null, type: 'workspace', publicId: null },
        [],
        null,
      );
      await this.d.security.record(tx, {
        category: 'export',
        action: 'portability.import',
        outcome: results.some((row) => row.error) ? 'failure' : 'success',
        actor: { type: 'human', id: p.membershipId },
        subject: { type: 'workspace', id: tx.workspaceId },
        correlationId: caller.meta.correlationId,
      });
    });
    return { preview, applied, dry_run: false, import_job_id: jobId, rows: results };
  }

  async rollbackPortabilityImport(caller: Caller, ws: unknown, jobValue: unknown, req: Mutation) {
    await this.requirePortabilityScope(caller, 'records:write');
    if (!req.idempotencyKey || req.idempotencyKey.length < 16)
      throw new TenancyError('validation_failed');
    const jobId = String(jobValue ?? '');
    const snapshot = await this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const job = await tx.db
        .selectFrom('transfer.import_job')
        .selectAll()
        .where('id', '=', jobId)
        .where('owner_membership_id', '=', p.membershipId)
        .executeTakeFirst();
      if (
        !job ||
        !job.rollback_until ||
        job.rollback_until.getTime() < Date.now() ||
        !['completed', 'partial'].includes(job.state)
      )
        throw new TenancyError('not_found');
      const rows = await tx.db
        .selectFrom('transfer.import_row')
        .selectAll()
        .where('import_job_id', '=', jobId)
        .orderBy('row_number')
        .execute();
      if (job.entity_kind !== 'task' && job.entity_kind !== 'project')
        throw new TenancyError('validation_failed');
      for (const row of rows.filter((item) => item.state === 'applied')) {
        if (!row.record_public_id || row.applied_version === null)
          throw new TenancyError('conflict');
        const record = await tx.db
          .selectFrom('core.record')
          .select(['version', 'lifecycle_state'])
          .where('workspace_id', '=', tx.workspaceId)
          .where('public_id', '=', row.record_public_id)
          .executeTakeFirst();
        if (
          !record ||
          Number(record.version) !== Number(row.applied_version) ||
          record.lifecycle_state !== 'active'
        )
          throw new TenancyError('conflict');
      }
      return { job, rows };
    });
    const rolled: number[] = [];
    for (const row of snapshot.rows.filter((item) => item.state === 'applied')) {
      const key = createHash('sha256')
        .update(`${jobId}:rollback:${row.row_number}`)
        .digest('hex')
        .slice(0, 48);
      const mutation: Mutation = {
        ...req,
        idempotencyKey: `csv_rb_${key}`,
        ifMatch: `"${row.applied_version}"`,
        fingerprint: createHash('sha256')
          .update(`${jobId}:${row.row_number}:${row.applied_version}`)
          .digest(),
      };
      if (snapshot.job.entity_kind === 'task')
        await this.taskLifecycle(caller, ws, row.record_public_id, 'trash', {}, mutation);
      else await this.projectLifecycle(caller, ws, row.record_public_id, 'trash', mutation);
      await this.saveImportCheckpoint(caller, ws, jobId, row.row_number, 'rolled_back');
      rolled.push(row.row_number);
    }
    await this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const remains = await tx.db
        .selectFrom('transfer.import_row')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('import_job_id', '=', jobId)
        .where('state', '=', 'applied')
        .executeTakeFirstOrThrow();
      if (Number(remains.n) === 0)
        await tx.db
          .updateTable('transfer.import_job')
          .set({ state: 'rolled_back', updated_at: new Date() })
          .where('id', '=', jobId)
          .execute();
      await this.workAudit(
        tx,
        caller,
        p,
        'portability.import_rolled_back',
        { recordId: null, type: 'workspace', publicId: null },
        [],
        null,
      );
      await this.d.security.record(tx, {
        category: 'export',
        action: 'portability.import.rollback',
        outcome: 'success',
        actor: { type: 'human', id: p.membershipId },
        subject: { type: 'workspace', id: tx.workspaceId },
        correlationId: caller.meta.correlationId,
      });
    });
    return { import_job_id: jobId, rolled_back: rolled };
  }
}
