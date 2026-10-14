import { createHash } from 'node:crypto';
import { newUuidV7 } from '@pm/contracts';
import { TenancyError, type Caller, type Mutation } from '@pm/tenancy';
import { CalendarService } from '../integrations/calendar-service.ts';
import { previewCsv, serializeCsv, type ImportPreview } from './csv.ts';

const MAX_EXPORT_ROWS = 10_000;
const MAX_IMPORT_ROWS = 2_000;

/** CSV portability boundary. All reads delegate to the same permission-filtered record lists. */
export class PortabilityService extends CalendarService {
  private async prepareImportJob(
    caller: Caller,
    ws: unknown,
    preview: ImportPreview,
    mode: 'partial' | 'all_or_nothing',
  ): Promise<string> {
    const candidateId = newUuidV7();
    const digest = Buffer.from(preview.digest, 'hex');
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const existing = await tx.db
        .selectFrom('transfer.import_job')
        .select(['id'])
        .where('owner_membership_id', '=', p.membershipId)
        .where('content_sha256', '=', digest)
        .where('entity_kind', '=', preview.entity)
        .where('apply_mode', '=', mode)
        .where('state', '!=', 'rolled_back')
        .executeTakeFirst();
      const id = existing?.id ?? candidateId;
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
            rollback_until: null,
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
            source_values: item.values,
            state: item.errors.length ? 'error' : 'pending',
            issues: item.errors.map((code) => ({ code })),
            record_type: null,
            record_id: null,
            record_public_id: null,
            applied_version: null,
          })
          .onConflict((oc) =>
            oc.columns(['workspace_id', 'import_job_id', 'row_number']).doUpdateSet({
              source_values: item.values,
              state: item.errors.length ? 'error' : 'pending',
              issues: item.errors.map((code) => ({ code })),
              updated_at: new Date(),
            }),
          )
          .execute();
      }
      return id;
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
          ...(data.issue ? { issues: [{ code: data.issue }] } : {}),
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
    if (entity !== 'task' && entity !== 'project') throw new TenancyError('not_found');
    if (caller.delegation) {
      if (!caller.delegation.scopes.includes('records:read')) throw new TenancyError('forbidden');
      const rate = await this.limitApi(caller.delegation.tokenId, false);
      if (!rate.allowed)
        throw new TenancyError('rate_limited', { retryAfterSeconds: rate.retryAfterSeconds });
    }
    const limit = Math.min(Math.max(Math.trunc(cap) || MAX_EXPORT_ROWS, 1), MAX_EXPORT_ROWS);
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    const append = (record: unknown) => {
      if (entity === 'task') {
        const t = record as Record<string, unknown>;
        const status = t.status as { key?: string } | null;
        rows.push({
          schema_version: '1',
          public_id: t.id,
          title: t.title,
          status: status?.key ?? '',
          priority: t.priority,
          start_date: t.start_date,
          due_date: t.due_date,
          estimate_minutes: t.estimate_minutes,
          remaining_estimate_minutes: t.remaining_estimate_minutes,
          brand_id: (t.brand as { id?: string } | null)?.id ?? '',
          lifecycle_state: t.lifecycle_state,
        });
      } else {
        const p = record as Record<string, unknown>;
        const status = p.status as { key?: string } | null;
        rows.push({
          schema_version: '1',
          public_id: p.id,
          name: p.name,
          status: status?.key ?? '',
          priority: p.priority,
          health: p.health,
          target_date: p.target_date,
          brand_id: (p.brand as { id?: string } | null)?.id ?? '',
          parent_id: p.parent ?? '',
          lifecycle_state: p.lifecycle_state,
        });
      }
    };
    if (entity === 'project') {
      const batch = await this.listProjects(caller, ws, { limit: Math.min(limit, 200) });
      batch.data.forEach(append);
      truncated = Number(batch.total.value) > rows.length;
    } else {
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
    const headers =
      entity === 'task'
        ? [
            'schema_version',
            'public_id',
            'title',
            'status',
            'priority',
            'start_date',
            'due_date',
            'estimate_minutes',
            'remaining_estimate_minutes',
            'brand_id',
            'lifecycle_state',
          ]
        : [
            'schema_version',
            'public_id',
            'name',
            'status',
            'priority',
            'health',
            'target_date',
            'brand_id',
            'parent_id',
            'lifecycle_state',
          ];
    await this.inWorkspace(caller, ws, {}, async (tx, p) => {
      await this.workAudit(
        tx,
        caller,
        p,
        'portability.exported',
        { recordId: null, type: 'workspace', publicId: null },
        [],
        null,
      );
    });
    return {
      csv: serializeCsv(headers, rows),
      rows: rows.length,
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

  /** Validation-only import endpoint foundation; applying rows is deliberately explicit. */
  async applyPortabilityImport(caller: Caller, ws: unknown, input: unknown, req: Mutation) {
    const b = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const preview = this.previewPortabilityImport(input);
    if (b.dry_run === true) return { preview, applied: 0, dry_run: true };
    if (!req.idempotencyKey || req.idempotencyKey.length < 16)
      throw new TenancyError('validation_failed');
    // Apply only rows whose destinations are explicit existing public IDs; no tenant, role,
    // membership, permission, actor, or internal identifier fields are ever accepted as authority.
    if (b.mode !== 'partial' && b.mode !== 'all_or_nothing')
      throw new TenancyError('validation_failed');
    if (preview.invalid && b.mode === 'all_or_nothing')
      return { preview, applied: 0, dry_run: false };
    const jobId = await this.prepareImportJob(
      caller,
      ws,
      preview,
      b.mode as 'partial' | 'all_or_nothing',
    );
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
            : await this.createProject(
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
              );
        results.push({ row: item.row, id: created.data.id });
        applied++;
        await this.saveImportCheckpoint(caller, ws, jobId, item.row, 'applied', {
          publicId: created.data.id,
          entity: preview.entity,
          version: created.data.version,
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
              throw new TenancyError('internal_error');
            }
          }
          await this.inWorkspace(caller, ws, {}, async (tx) => {
            await tx.db
              .updateTable('transfer.import_job')
              .set({ state: 'failed', updated_at: new Date() })
              .where('id', '=', jobId)
              .execute();
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
    });
    return { preview, applied, dry_run: false, import_job_id: jobId, rows: results };
  }
}
