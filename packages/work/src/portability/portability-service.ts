import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  cell,
  compileVisibility,
  decideWorkspace,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
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
  async exportImportErrors(caller: Caller, ws: unknown, job: unknown) {
    await this.requirePortabilityScope(caller, 'records:read');
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      if (typeof job !== 'string' || !/^[0-9a-f-]{36}$/i.test(job))
        throw new TenancyError('not_found');
      const found = await tx.db
        .selectFrom('transfer.import_job')
        .select('id')
        .where('id', '=', job)
        .where('owner_membership_id', '=', p.membershipId)
        .executeTakeFirst();
      if (!found) throw new TenancyError('not_found');
      const rate = await this.d.limiter.consume('api.export', p.membershipId);
      if (!rate.allowed)
        throw new TenancyError('rate_limited', { retryAfterSeconds: rate.retryAfterSeconds });
      const rows = await tx.db
        .selectFrom('transfer.import_row')
        .select(['row_number', 'state', 'issues'])
        .where('import_job_id', '=', job)
        .where('state', 'in', ['error', 'conflict'])
        .orderBy('row_number')
        .limit(MAX_IMPORT_ROWS)
        .execute();
      const errors = rows.map((r) => ({ row: r.row_number, state: r.state, issues: r.issues }));
      await this.workAudit(
        tx,
        caller,
        p,
        'portability.exported',
        { recordId: null, type: 'workspace', publicId: null },
        [],
        null,
      );
      await this.d.security.record(tx, {
        category: 'export',
        action: 'portability.errors_export',
        outcome: 'success',
        actor: { type: 'human', id: p.membershipId },
        subject: { type: 'workspace', id: tx.workspaceId },
        correlationId: caller.meta.correlationId,
      });
      return {
        csv: serializeCsv(['row', 'state', 'issues'], errors),
        filename: 'import-errors.csv',
      };
    });
  }
  async exportPortabilityAudit(caller: Caller, ws: unknown, req: Mutation) {
    if (caller.delegation) throw new TenancyError('forbidden');
    const render = async (tx: WorkspaceTransaction, p: Principal) => {
      const decision = decideWorkspace(p, 'audit.export');
      if (
        !decision.allowed ||
        !(await this.portabilityEntitlements?.auditExportAllowed(tx.workspaceId))
      )
        throw new TenancyError('forbidden');
      const visibility = await compileVisibility(tx, p, {
        need: 'view',
        shares: false,
        arrayMax: this.c.settings.principalContextArrayMax,
      });
      const entries = await tx.db
        .selectFrom('audit.audit_event as a')
        .leftJoin('core.record as r', (j) =>
          j.onRef('r.workspace_id', '=', 'a.workspace_id').onRef('r.id', '=', 'a.target_record_id'),
        )
        .select(['a.chain_seq', 'a.occurred_at', 'a.action', 'a.target_type', 'a.target_public_id'])
        .where((eb) =>
          eb.or([
            eb.and([eb('a.target_record_id', 'is', null), eb('a.brand_id', 'is', null)]),
            visibility.where('r'),
          ]),
        )
        .orderBy('a.chain_seq')
        .limit(MAX_EXPORT_ROWS + 1)
        .execute();
      if (entries.length > MAX_EXPORT_ROWS) throw new TenancyError('limit_exceeded');
      const csv = serializeCsv(
        ['sequence', 'occurred_at', 'action', 'target_type', 'target_public_id'],
        entries.map((e) => ({
          sequence: String(e.chain_seq),
          occurred_at: e.occurred_at.toISOString(),
          action: e.action,
          target_type: e.target_type,
          target_public_id: e.target_public_id,
        })),
      );
      return {
        id: String(ws),
        type: 'workspace' as const,
        csv,
        rows: entries.length,
        filename: 'workspace-audit.csv',
      };
    };
    return this.mutate(
      caller,
      'audit.export',
      ws,
      req,
      async (tx, p) => {
        const decision = decideWorkspace(p, 'audit.export');
        if (
          !decision.allowed ||
          !(await this.portabilityEntitlements?.auditExportAllowed(tx.workspaceId))
        )
          throw new TenancyError('forbidden');
        await this.stepUp(tx, caller, p, req, 'audit.export', {
          type: 'workspace',
          id: tx.workspaceId,
        });
        const data = await render(tx, p);
        await this.workAudit(
          tx,
          caller,
          p,
          'portability.audit_exported',
          { recordId: null, type: 'workspace', publicId: null },
          [],
          null,
        );
        await this.d.security.record(tx, {
          category: 'export',
          action: 'audit.export',
          outcome: 'success',
          actor: { type: 'human', id: p.membershipId },
          subject: { type: 'workspace', id: tx.workspaceId },
          correlationId: caller.meta.correlationId,
        });
        return { status: 200, ref: { id: String(ws), type: 'workspace' }, data };
      },
      async (tx, p) => render(tx, p),
    );
  }
  private readonly importTransaction = new AsyncLocalStorage<{
    caller: Caller;
    ws: unknown;
    tx: WorkspaceTransaction;
    principal: Principal & { workspaceState: string };
  }>();

  protected override async inWorkspace<T>(
    caller: Caller,
    ws: unknown,
    options: { readOnly?: boolean },
    fn: (tx: WorkspaceTransaction, p: Principal & { workspaceState: string }) => Promise<T>,
  ): Promise<T> {
    const active = this.importTransaction.getStore();
    if (!active) return super.inWorkspace(caller, ws, options, fn);
    if (active.caller !== caller || active.ws !== ws) throw new TenancyError('forbidden');
    return fn(active.tx, active.principal);
  }

  private async atomicImport<T>(caller: Caller, ws: unknown, fn: () => Promise<T>): Promise<T> {
    return this.inWorkspace(caller, ws, {}, (tx, principal) =>
      this.importTransaction.run({ caller, ws, tx, principal }, fn),
    );
  }
  private async requirePortabilityExport(caller: Caller, ws: unknown) {
    await this.requirePortabilityScope(caller, 'records:read');
    await this.inWorkspace(caller, ws, { readOnly: true }, async (_tx, p) => {
      const capability = cell('record.export', p.role);
      if (
        capability.kind === 'deny' ||
        (capability.kind === 'policy' &&
          (p.policy as Record<string, unknown>)[capability.key] !== true)
      )
        throw new TenancyError('forbidden');
      const rate = await this.d.limiter.consume('api.export', p.membershipId);
      if (!rate.allowed)
        throw new TenancyError('rate_limited', { retryAfterSeconds: rate.retryAfterSeconds });
    });
  }
  /** Read-only history exports use the same live visibility as their application surfaces. */
  async exportPortabilityHistory(caller: Caller, ws: unknown, kind: string, input: unknown) {
    await this.requirePortabilityExport(caller, ws);
    const q = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (kind === 'time') {
      if (typeof q.from !== 'string' || typeof q.to !== 'string')
        throw new TenancyError('validation_failed');
      const result = await this.exportTime(caller, ws, { from: q.from, to: q.to, format: 'csv' });
      return { csv: result.body, rows: result.rows, truncated: false, filename: result.filename };
    }
    const rows: Record<string, unknown>[] = [];
    if (kind === 'comments') {
      if (typeof q.record !== 'string') throw new TenancyError('validation_failed');
      let cursor: string | undefined;
      do {
        const page = await this.listComments(caller, ws, q.record, {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const comment of page.data) {
          const { replies: _inline, ...root } = comment;
          rows.push({ public_id: root.id, host_public_id: q.record, data: root });
          let repliesCursor: string | undefined;
          do {
            const replies = await this.listReplies(caller, ws, root.id, {
              limit: 100,
              ...(repliesCursor ? { cursor: repliesCursor } : {}),
            });
            for (const reply of replies.data)
              rows.push({ public_id: reply.id, host_public_id: q.record, data: reply });
            if (rows.length > MAX_EXPORT_ROWS) throw new TenancyError('limit_exceeded');
            repliesCursor = replies.page.next_cursor;
          } while (repliesCursor);
        }
        if (rows.length > MAX_EXPORT_ROWS) throw new TenancyError('limit_exceeded');
        cursor = page.page.next_cursor;
      } while (cursor);
    } else if (kind === 'task_detail') {
      if (typeof q.record !== 'string') throw new TenancyError('validation_failed');
      const detail = await this.taskDetail(caller, ws, q.record);
      rows.push({ public_id: detail.task.id, host_public_id: q.record, data: detail });
    } else if (kind === 'task_activity' || kind === 'project_activity') {
      const entity = kind === 'task_activity' ? 'task' : 'project';
      let cursor: string | undefined;
      do {
        const result = await this.activity(caller, ws, entity, {
          query: { entity },
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const entry of result.data) rows.push({ data: entry });
        if (rows.length > MAX_EXPORT_ROWS || result.records_truncated)
          throw new TenancyError('limit_exceeded');
        cursor = result.page.next_cursor;
      } while (cursor);
    } else throw new TenancyError('not_found');
    let csv: string;
    try {
      csv = serializeCsv(['public_id', 'host_public_id', 'data'], rows);
    } catch {
      throw new TenancyError('limit_exceeded');
    }
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
      await this.d.security.record(tx, {
        category: 'export',
        action: 'portability.history_export',
        outcome: 'success',
        actor: { type: 'human', id: p.membershipId },
        subject: { type: 'workspace', id: tx.workspaceId },
        correlationId: caller.meta.correlationId,
      });
    });
    return { csv, rows: rows.length, truncated: false, filename: `workspace-${kind}.csv` };
  }

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

  private portableScope(value: unknown): string {
    if (typeof value === 'string') {
      if (!value.startsWith('{') && !value.startsWith('"')) return value;
      return this.portableScope(JSON.parse(value));
    }
    if (value && typeof value === 'object') {
      const scope = value as Record<string, unknown>;
      if (scope.kind === 'brand' && typeof scope.brand === 'string') return `brand:${scope.brand}`;
      if (scope.kind === 'project' && typeof scope.project === 'string')
        return `project:${scope.project}`;
      if (scope.kind === 'workspace') return 'workspace';
    }
    throw new TenancyError('validation_failed');
  }

  private async persistedSourceKeys(
    caller: Caller,
    ws: unknown,
    entity: PortableEntity,
    keys: string[],
    exceptDigest?: Buffer,
  ): Promise<Set<string>> {
    if (!keys.length) return new Set();
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      let query = tx.db
        .selectFrom('transfer.import_row as r')
        .innerJoin('transfer.import_job as j', 'j.id', 'r.import_job_id')
        .select('r.source_row_key')
        .where('j.owner_membership_id', '=', p.membershipId)
        .where('j.entity_kind', '=', entity)
        .where('r.state', '=', 'applied')
        .where('r.source_row_key', 'in', keys);
      if (exceptDigest) query = query.where('j.content_sha256', '!=', exceptDigest);
      const rows = await query.execute();
      return new Set(rows.flatMap((row) => (row.source_row_key ? [row.source_row_key] : [])));
    });
  }

  private async prepareImportJob(
    caller: Caller,
    ws: unknown,
    preview: ImportPreview,
    mode: 'partial' | 'all_or_nothing',
    snapshot: {
      previewId: string;
      mappingId: string | null;
      mappingVersion: number | null;
      idempotencyKey: string;
    },
  ): Promise<{ id: string; replay: boolean; resume: boolean }> {
    const candidateId = newUuidV7();
    const digest = Buffer.from(preview.digest, 'hex');
    const requestKeyDigest = createHash('sha256').update(snapshot.idempotencyKey).digest();
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${p.membershipId}::text, 406))`.execute(
        tx.db,
      );
      const byKey = await tx.db
        .selectFrom('transfer.import_job')
        .select(['id', 'state', 'content_sha256', 'entity_kind', 'apply_mode'])
        .where('owner_membership_id', '=', p.membershipId)
        .where('request_key_sha256', '=', requestKeyDigest)
        .where('state', '!=', 'rolled_back')
        .executeTakeFirst();
      if (
        byKey &&
        (!Buffer.from(byKey.content_sha256).equals(digest) ||
          byKey.entity_kind !== preview.entity ||
          byKey.apply_mode !== mode)
      )
        throw new TenancyError('conflict');
      const existing =
        byKey ??
        (await tx.db
          .selectFrom('transfer.import_job')
          .select(['id', 'state', 'content_sha256', 'entity_kind', 'apply_mode'])
          .where('owner_membership_id', '=', p.membershipId)
          .where('content_sha256', '=', digest)
          .where('entity_kind', '=', preview.entity)
          .where('apply_mode', '=', mode)
          .where('state', 'not in', ['rolled_back', 'failed'])
          .executeTakeFirst());
      const running = await tx.db
        .selectFrom('transfer.import_job')
        .select('id')
        .where('owner_membership_id', '=', p.membershipId)
        .where('state', '=', 'running')
        .executeTakeFirst();
      if (running && running.id !== existing?.id) throw new TenancyError('conflict');
      const id = existing?.id ?? candidateId;
      if (existing && ['completed', 'partial', 'failed'].includes(existing.state))
        return { id: existing.id, replay: true, resume: false };
      if (existing) {
        await tx.db
          .updateTable('transfer.import_job')
          .set({ state: 'running', preview_id: snapshot.previewId, updated_at: new Date() })
          .where('id', '=', id)
          .execute();
      } else {
        const sourceKeys = preview.rows
          .map((item) => item.values.source_row_key)
          .filter((key): key is string => Boolean(key));
        const duplicates = await tx.db
          .selectFrom('transfer.import_row as r')
          .innerJoin('transfer.import_job as j', 'j.id', 'r.import_job_id')
          .select('r.source_row_key')
          .where('j.owner_membership_id', '=', p.membershipId)
          .where('j.entity_kind', '=', preview.entity)
          .where('r.state', '=', 'applied')
          .where('r.source_row_key', 'in', sourceKeys.length ? sourceKeys : [''])
          .execute();
        if (duplicates.length) throw new TenancyError('conflict');
        await tx.db
          .insertInto('transfer.import_job')
          .values({
            id,
            workspace_id: tx.workspaceId,
            owner_membership_id: p.membershipId,
            preview_id: snapshot.previewId,
            mapping_id: snapshot.mappingId,
            mapping_version: snapshot.mappingVersion,
            schema_version: PORTABILITY_SCHEMA_VERSION,
            content_sha256: digest,
            request_key_sha256: requestKeyDigest,
            entity_kind: preview.entity,
            state: 'running',
            apply_mode: mode,
            row_count: preview.rows.length,
            applied_count: 0,
            error_count: 0,
            checkpoint_row: 0,
            rollback_until: new Date(Date.now() + this.ws.importRollbackPeriodMs),
          })
          .execute();
      }
      if (!existing) {
        for (const item of preview.rows) {
          await tx.db
            .insertInto('transfer.import_row')
            .values({
              workspace_id: tx.workspaceId,
              import_job_id: id,
              row_number: item.row,
              source_row_key: item.errors.includes('duplicate_source_row_key')
                ? null
                : (item.values.source_row_key ?? null),
              source_values: JSON.stringify(item.values),
              state: item.errors.length ? 'error' : 'pending',
              issues: JSON.stringify(item.errors.map((code) => ({ code }))),
              record_type: null,
              record_id: null,
              record_public_id: null,
              applied_version: null,
            })
            .execute();
        }
      }
      return { id, replay: false, resume: Boolean(existing) };
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
          'mapping_version',
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
    const expectedVersion = b.expected_version;
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const current = await tx.db
        .selectFrom('transfer.import_mapping')
        .select(['id', 'mapping_version'])
        .where('owner_membership_id', '=', p.membershipId)
        .where(sql<boolean>`lower(name) = ${name.toLowerCase()}`)
        .executeTakeFirst();
      const id = current?.id ?? newUuidV7();
      let mappingVersion: number;
      if (current) {
        if (
          expectedVersion === undefined ||
          Number(expectedVersion) !== Number(current.mapping_version)
        )
          throw new TenancyError('conflict');
        const updated = await tx.db
          .updateTable('transfer.import_mapping')
          .set({
            name,
            entity_kind: entity as PortableEntity,
            schema_version: PORTABILITY_SCHEMA_VERSION,
            mapping_version: Number(current.mapping_version) + 1,
            column_mapping: JSON.stringify(mapping),
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .where('mapping_version', '=', Number(current.mapping_version))
          .returning('mapping_version')
          .execute();
        if (!updated[0]) throw new TenancyError('conflict');
        mappingVersion = Number(updated[0].mapping_version);
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
            mapping_version: 1,
            column_mapping: JSON.stringify(mapping),
          })
          .execute();
        mappingVersion = 1;
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
        action: 'portability.mapping_save',
        outcome: 'success',
        actor: { type: 'human', id: p.membershipId },
        subject: { type: 'workspace', id: tx.workspaceId },
        correlationId: caller.meta.correlationId,
      });
      return { id, name, entity, mapping, mapping_version: mappingVersion };
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
      await this.d.security.record(tx, {
        category: 'export',
        action: 'portability.mapping_delete',
        outcome: 'success',
        actor: { type: 'human', id: p.membershipId },
        subject: { type: 'workspace', id: tx.workspaceId },
        correlationId: caller.meta.correlationId,
      });
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

  async exportPortabilityCsv(
    caller: Caller,
    ws: unknown,
    entity: string,
    cap = MAX_EXPORT_ROWS,
    host: unknown = 'workspace',
  ) {
    if (!PORTABLE_ENTITIES.includes(entity as PortableEntity)) throw new TenancyError('not_found');
    await this.requirePortabilityExport(caller, ws);
    const limit = Math.min(Math.max(Math.trunc(cap) || MAX_EXPORT_ROWS, 1), MAX_EXPORT_ROWS);
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    if (entity === 'goal') {
      let cursor: string | undefined;
      do {
        const result = await this.listGoals(caller, ws, {
          limit: Math.min(200, limit - rows.length),
          ...(cursor ? { cursor } : {}),
        });
        for (const goal of result.data) {
          const period = { kind: 'custom', start: goal.period.start, end: goal.period.end };
          rows.push({
            schema_version: PORTABILITY_SCHEMA_VERSION,
            source_row_key: goal.id,
            public_id: goal.id,
            title: goal.title,
            status: goal.status,
            basis: goal.basis,
            period,
            unit: goal.metric.unit,
            baseline: goal.metric.baseline,
            target: goal.metric.target,
            current: goal.metric.current,
            project_id: goal.scope.kind === 'project' ? goal.scope.project?.id : '',
            brand_id:
              goal.scope.kind === 'brand' && goal.scope.brand.kind === 'brand'
                ? goal.scope.brand.id
                : '',
          });
        }
        truncated = result.page.has_more;
        cursor = result.page.next_cursor;
      } while (cursor && rows.length < limit);
    } else if (entity === 'workflow') {
      const result = await this.listWorkflows(caller, ws, { state: 'all' });
      const data = (result as { data: unknown[] }).data;
      for (const value of data.slice(0, limit)) {
        const w = value as Record<string, unknown>;
        const statuses = Array.isArray(w.statuses)
          ? w.statuses.map((value) => {
              const status = value as Record<string, unknown>;
              return {
                name: status.name,
                category: status.category,
                color: status.color,
                icon: status.icon,
                description: status.description,
              };
            })
          : [];
        rows.push({
          schema_version: '1',
          public_id: w.id,
          name: w.name,
          record_kind: w.record_kind,
          description: w.description,
          scope: this.portableScope(w.scope),
          statuses,
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
          scope: this.portableScope(f.scope),
          applies_to: f.applies_to,
          required: f.required,
          presentation: f.presentation,
          applicability: f.applicability,
          view_visibility: f.view_visibility,
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
      const result = (await this.listFiles(caller, ws, host)) as { data: unknown[] };
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
          link_url: version.url,
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
      let cursor: string | undefined;
      do {
        const batch = await this.query(caller, ws, 'project', {
          query: { entity: 'project' },
          limit: Math.min(200, limit - rows.length),
          ...(cursor ? { cursor } : {}),
        });
        for (const row of batch.data) append(await this.getProject(caller, ws, row.id));
        truncated = batch.page.has_more;
        cursor = batch.page.next_cursor;
      } while (cursor && rows.length < limit);
    } else if (entity === 'task') {
      let cursor: string | undefined;
      while (rows.length < limit) {
        const batch = await this.listTasks(caller, ws, {
          limit: Math.min(200, limit - rows.length),
          ...(cursor ? { cursor } : {}),
        });
        batch.data.forEach(append);
        if (!batch.page.has_more || rows.length >= limit) {
          truncated = batch.page.has_more;
          break;
        }
        cursor = batch.page.next_cursor;
        if (!cursor) break;
      }
    }
    const headers = PORTABLE_FIELDS[entity as PortableEntity];
    let csv: string;
    try {
      csv = serializeCsv(headers, rows);
      if (Buffer.byteLength(csv, 'utf8') > CSV_LIMITS.bytes)
        throw new Error('csv_export_too_large');
    } catch {
      throw new TenancyError('limit_exceeded');
    }
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
      await this.d.security.record(tx, {
        category: 'export',
        action: `portability.${entity}_export`,
        outcome: 'success',
        actor: { type: 'human', id: p.membershipId },
        subject: { type: 'workspace', id: tx.workspaceId },
        correlationId: caller.meta.correlationId,
      });
    });
    return {
      csv,
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

  async previewPortabilityImportFor(
    caller: Caller,
    ws: unknown,
    input: unknown,
  ): Promise<ImportPreview> {
    await this.requirePortabilityScope(caller, 'records:read');
    const resolved = await this.resolveImportPreview(caller, ws, input);
    const sourceKeys = resolved.preview.rows
      .map((item) => item.values.source_row_key)
      .filter((key): key is string => Boolean(key));
    const duplicates = await this.persistedSourceKeys(
      caller,
      ws,
      resolved.preview.entity,
      sourceKeys,
      Buffer.from(resolved.preview.digest, 'hex'),
    );
    for (const row of resolved.preview.rows) {
      if (row.values.source_row_key && duplicates.has(row.values.source_row_key))
        row.errors.push('duplicate_source_row_key');
    }
    resolved.preview.valid = resolved.preview.rows.filter((row) => row.errors.length === 0).length;
    resolved.preview.invalid = resolved.preview.rows.length - resolved.preview.valid;
    const previewId = newUuidV7();
    await this.inWorkspace(caller, ws, {}, async (tx, p) => {
      await sql`
        DELETE FROM transfer.import_preview p
         WHERE p.owner_membership_id = ${p.membershipId}::uuid
           AND p.expires_at < ${new Date()}
           AND NOT EXISTS (
             SELECT 1 FROM transfer.import_job j
              WHERE j.workspace_id = p.workspace_id AND j.preview_id = p.id
           )`.execute(tx.db);
      await tx.db
        .insertInto('transfer.import_preview')
        .values({
          id: previewId,
          workspace_id: tx.workspaceId,
          owner_membership_id: p.membershipId,
          entity_kind: resolved.preview.entity,
          content_sha256: Buffer.from(resolved.preview.digest, 'hex'),
          schema_version: PORTABILITY_SCHEMA_VERSION,
          mapping_id: resolved.mappingId,
          mapping_version: resolved.mappingVersion,
          expires_at: new Date(Date.now() + 30 * 60_000),
        })
        .execute();
      await this.workAudit(
        tx,
        caller,
        p,
        'portability.import_previewed',
        { recordId: null, type: 'workspace', publicId: null },
        [],
        null,
      );
      await this.d.security.record(tx, {
        category: 'export',
        action: 'portability.import_preview',
        outcome: resolved.preview.invalid ? 'failure' : 'success',
        actor: { type: 'human', id: p.membershipId },
        subject: { type: 'workspace', id: tx.workspaceId },
        correlationId: caller.meta.correlationId,
      });
    });
    return {
      ...resolved.preview,
      preview_id: previewId,
      mapping_id: resolved.mappingId,
      mapping_version: resolved.mappingVersion,
    };
  }

  private async resolveImportPreview(
    caller: Caller,
    ws: unknown,
    input: unknown,
  ): Promise<{
    preview: ImportPreview;
    mappingId: string | null;
    mappingVersion: number | null;
  }> {
    const b = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (b.mapping_id === undefined)
      return {
        preview: this.previewPortabilityImport(input),
        mappingId: null,
        mappingVersion: null,
      };
    const entity = String(b.entity ?? '');
    const mapping = await this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) =>
      tx.db
        .selectFrom('transfer.import_mapping')
        .select(['id', 'entity_kind', 'schema_version', 'mapping_version', 'column_mapping'])
        .where('id', '=', String(b.mapping_id))
        .where('owner_membership_id', '=', p.membershipId)
        .executeTakeFirst(),
    );
    if (
      !mapping ||
      mapping.entity_kind !== entity ||
      mapping.schema_version !== PORTABILITY_SCHEMA_VERSION ||
      (b.mapping_version !== undefined &&
        Number(b.mapping_version) !== Number(mapping.mapping_version))
    )
      throw new TenancyError('conflict');
    const preview = this.previewPortabilityImport({ ...b, mapping: mapping.column_mapping });
    preview.digest = createHash('sha256')
      .update(`${preview.digest}\0${mapping.id}:${mapping.mapping_version}`)
      .digest('hex');
    return {
      preview,
      mappingId: mapping.id,
      mappingVersion: Number(mapping.mapping_version),
    };
  }

  /** Canonical commands share one transaction when the user selects all rows or none. */
  async applyPortabilityImport(caller: Caller, ws: unknown, input: unknown, req: Mutation) {
    const b = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    return b.mode === 'all_or_nothing'
      ? this.atomicImport(caller, ws, () => this.applyImportRows(caller, ws, input, req))
      : this.applyImportRows(caller, ws, input, req);
  }

  private async applyImportRows(caller: Caller, ws: unknown, input: unknown, req: Mutation) {
    await this.requirePortabilityScope(caller, 'records:write');
    const b = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (typeof b.preview_id !== 'string') throw new TenancyError('validation_failed');
    const previewSnapshot = await this.inWorkspace(caller, ws, {}, async (tx, p) =>
      tx.db
        .selectFrom('transfer.import_preview')
        .selectAll()
        .where('id', '=', b.preview_id as string)
        .where('owner_membership_id', '=', p.membershipId)
        .where('expires_at', '>', new Date())
        .executeTakeFirst(),
    );
    if (!previewSnapshot) throw new TenancyError('conflict');
    const resolvedPreview = await this.resolveImportPreview(caller, ws, input);
    const preview = resolvedPreview.preview;
    if (
      preview.entity !== previewSnapshot.entity_kind ||
      !Buffer.from(previewSnapshot.content_sha256).equals(Buffer.from(preview.digest, 'hex')) ||
      resolvedPreview.mappingId !== previewSnapshot.mapping_id ||
      resolvedPreview.mappingVersion !== previewSnapshot.mapping_version
    )
      throw new TenancyError('conflict');
    if (b.dry_run === true) return { preview, applied: 0, dry_run: true };
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
      {
        previewId: previewSnapshot.id,
        mappingId: previewSnapshot.mapping_id,
        mappingVersion: previewSnapshot.mapping_version,
        idempotencyKey: req.idempotencyKey,
      },
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
    const checkpointRows = await this.inWorkspace(caller, ws, { readOnly: true }, async (tx) =>
      tx.db
        .selectFrom('transfer.import_row')
        .select(['row_number', 'state', 'record_public_id'])
        .where('import_job_id', '=', jobId)
        .execute(),
    );
    const completedRows = new Map(
      checkpointRows
        .filter((row) => row.state === 'applied' && row.record_public_id)
        .map((row) => [row.row_number, row.record_public_id!]),
    );
    let applied = completedRows.size;
    for (const item of preview.rows) {
      const completedId = completedRows.get(item.row);
      if (completedId) {
        results.push({ row: item.row, id: completedId });
        continue;
      }
      if (item.errors.length) {
        results.push({ row: item.row, error: item.errors[0] });
        await this.saveImportCheckpoint(caller, ws, jobId, item.row, 'error', {
          issue: item.errors[0],
        });
        continue;
      }
      const v = { ...item.values };
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
        for (const field of ['project_id', 'parent_id', 'host_public_id'] as const) {
          const source = v[field];
          if (!source?.startsWith('@')) continue;
          const expected =
            field === 'project_id' ? 'project' : field === 'parent_id' ? preview.entity : undefined;
          const mapped = await this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
            let query = tx.db
              .selectFrom('transfer.import_row as r')
              .innerJoin('transfer.import_job as j', (j) =>
                j
                  .onRef('j.workspace_id', '=', 'r.workspace_id')
                  .onRef('j.id', '=', 'r.import_job_id'),
              )
              .select('r.record_public_id')
              .where('j.owner_membership_id', '=', p.membershipId)
              .where('r.state', '=', 'applied')
              .where('r.source_row_key', '=', source.slice(1));
            if (expected) query = query.where('j.entity_kind', '=', expected);
            const matches = await query.limit(2).execute();
            return matches.length === 1 ? matches[0]?.record_public_id : null;
          });
          if (!mapped) throw new TenancyError('not_found');
          v[field] = mapped;
        }
        const created =
          preview.entity === 'task'
            ? await this.createTaskWithOrigin(
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
                { kind: 'import', ref: { import_job: jobId, row: String(item.row) } },
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
                      ...(!v.project_id && v.brand_id ? { brand: v.brand_id } : {}),
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
                          ...(v.description ? { description: v.description } : {}),
                          ...(v.scope ? { scope: this.portableScope(v.scope) } : {}),
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
                            ...(v.description ? { description: v.description } : {}),
                            ...(v.scope ? { scope: this.portableScope(v.scope) } : {}),
                            ...(v.config ? { config: JSON.parse(v.config) as unknown } : {}),
                            ...(v.applies_to
                              ? { applies_to: JSON.parse(v.applies_to) as unknown }
                              : {}),
                            ...(v.required ? { required: v.required === 'true' } : {}),
                            ...(v.presentation ? { presentation: v.presentation } : {}),
                            ...(v.applicability ? { applicability: v.applicability } : {}),
                            ...(v.view_visibility
                              ? { view_visibility: JSON.parse(v.view_visibility) as unknown }
                              : {}),
                          },
                          rowReq,
                        )
                      : preview.entity === 'file'
                        ? await this.addFileLink(
                            caller,
                            ws,
                            {
                              host: v.host_public_id || 'workspace',
                              url: v.link_url,
                              name: v.name,
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
        if (b.mode === 'all_or_nothing') throw error;
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
          rollback_until: new Date(Date.now() + this.ws.importRollbackPeriodMs),
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
    return this.atomicImport(caller, ws, () => this.rollbackImportRows(caller, ws, jobValue, req));
  }

  private async rollbackImportRows(caller: Caller, ws: unknown, jobValue: unknown, req: Mutation) {
    await this.requirePortabilityScope(caller, 'records:write');
    if (!req.idempotencyKey || req.idempotencyKey.length < 16)
      throw new TenancyError('validation_failed');
    const jobId = String(jobValue ?? '');
    const snapshot = await this.inWorkspace(caller, ws, {}, async (tx, p) => {
      // A malformed identifier is as unknown as any other (never a database type error).
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new TenancyError('not_found');
      const job = await tx.db
        .selectFrom('transfer.import_job')
        .selectAll()
        .where('id', '=', jobId)
        .where('owner_membership_id', '=', p.membershipId)
        .executeTakeFirst();
      if (!job) throw new TenancyError('not_found');
      if (job.state === 'rolled_back') return { job, rows: [], replayed: true };
      if (
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
      if (
        !['task', 'project', 'workflow', 'field', 'goal', 'document', 'file'].includes(
          job.entity_kind,
        )
      )
        throw new TenancyError('validation_failed');
      for (const row of rows.filter((item) => item.state === 'applied')) {
        if (!row.record_public_id || row.applied_version === null)
          throw new TenancyError('conflict');
        if (job.entity_kind === 'workflow' || job.entity_kind === 'field') {
          const table =
            job.entity_kind === 'workflow' ? 'workflow.workflow' : 'workflow.field_definition';
          const configRecord = await tx.db
            .selectFrom(table)
            .select(['version', 'state'])
            .where('workspace_id', '=', tx.workspaceId)
            .where('public_id', '=', row.record_public_id)
            .executeTakeFirst();
          if (
            !configRecord ||
            Number(configRecord.version) !== Number(row.applied_version) ||
            configRecord.state !== 'active'
          )
            throw new TenancyError('conflict');
          continue;
        }
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
      return { job, rows, replayed: false };
    });
    if (snapshot.replayed) return { import_job_id: jobId, rolled_back: [], replayed: true };
    const rolled: number[] = [];
    for (const row of snapshot.rows.filter((item) => item.state === 'applied').reverse()) {
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
      else if (snapshot.job.entity_kind === 'project')
        await this.projectLifecycle(caller, ws, row.record_public_id, 'trash', mutation);
      else if (snapshot.job.entity_kind === 'goal')
        await this.goalLifecycle(caller, ws, row.record_public_id, 'trash', mutation);
      else if (snapshot.job.entity_kind === 'document')
        await this.documentLifecycle(caller, ws, row.record_public_id, 'trash', mutation);
      else if (snapshot.job.entity_kind === 'workflow')
        await this.setWorkflowState(caller, ws, row.record_public_id, {}, mutation, 'archived');
      else if (snapshot.job.entity_kind === 'field')
        await this.setFieldDefinitionState(
          caller,
          ws,
          row.record_public_id,
          {},
          mutation,
          'archived',
        );
      else await this.trashFile(caller, ws, row.record_public_id, mutation);
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
        action: 'portability.import_rollback',
        outcome: 'success',
        actor: { type: 'human', id: p.membershipId },
        subject: { type: 'workspace', id: tx.workspaceId },
        correlationId: caller.meta.correlationId,
      });
    });
    return { import_job_id: jobId, rolled_back: rolled };
  }
}
