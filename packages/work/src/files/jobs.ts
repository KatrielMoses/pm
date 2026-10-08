import { AuditWriter, change, CommandContext } from '@pm/audit';
import {
  sql,
  type PlatformDiscovery,
  type TenantDatabase,
  type WorkspaceTransaction,
} from '@pm/db';
import { errorFields, type Logger, type Metrics } from '@pm/observability';
import {
  markEffectAttempt,
  markEffectOutcome,
  writeOutboxEvent,
  type JobHandler,
  type JobHandlerContext,
  type RecurringJob,
} from '@pm/platform';
import { systemExec } from '../notify/system.ts';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from '../validation.ts';
import { FILE_JOB_KINDS, FILE_QUEUE } from './file-service.ts';
import type { MalwareScanner } from './scanner.ts';
import { OBJECT_EFFECT_PREFIX, permanentKey, previewKind } from './semantics.ts';
import type { ObjectStorage } from './storage.ts';

/** Every minute: expired upload sessions, and object deletions recorded by purge (4E). */
export const FILE_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: FILE_JOB_KINDS.sweep,
    queue: FILE_QUEUE,
    intervalMs: 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
];

export interface FileJobDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  storage: ObjectStorage | null;
  scanner: MalwareScanner | null;
  metrics: Metrics;
  logger: Logger;
  settings?: WorkSettings;
}

interface ObjectRow {
  id: string;
  storage_key: string;
  quarantined: boolean;
  byte_size: string;
  content_type: string;
  scan_state: string;
  scan_attempts: number;
}

const writerOf = (d: FileJobDeps) =>
  new AuditWriter({ module: 'work', logger: d.logger, metrics: d.metrics });

async function systemRecord(
  tx: WorkspaceTransaction,
  writer: AuditWriter,
  objectId: string,
  action: string,
  changes: ReturnType<typeof change.plain>[],
  scanState: string,
) {
  // One audit row and one `files.file.scanned` event per version that uses the object.
  const versions = (
    await sql<{
      id: string;
      file_id: string;
      public_id: string;
      brand_id: string | null;
      created_by: string;
    }>`
      SELECT v.id, v.file_id, r.public_id, f.brand_id, v.created_by_membership_id AS created_by
        FROM files.file_version v
        JOIN files.file f ON f.workspace_id = v.workspace_id AND f.id = v.file_id
        JOIN core.record r ON r.workspace_id = f.workspace_id AND r.id = f.id
       WHERE v.workspace_id = ${tx.workspaceId} AND v.file_object_id = ${objectId}`.execute(tx.db)
  ).rows;
  for (const v of versions) {
    const exec = systemExec(tx.workspaceId, null);
    await writer.write(
      tx,
      CommandContext.fromExecution(exec, { kind: 'automation' }, { brandId: v.brand_id }),
      { action, target: { recordId: v.file_id, type: 'file', publicId: v.public_id }, changes },
    );
    await writeOutboxEvent(tx, {
      type: 'files.file.scanned',
      aggregate: { type: 'files.file_version', id: v.id, sequence: 1 },
      data: { scan_state: scanState },
      actor: { type: 'system', id: tx.workspaceId },
      context: exec,
      ...(v.brand_id ? { brandId: v.brand_id } : {}),
    });
  }
}

/** Releases an object's bytes from the workspace's usage (blocked objects keep no bytes). */
async function release(tx: WorkspaceTransaction, bytes: number) {
  await sql`UPDATE files.storage_usage SET used_bytes = greatest(used_bytes - ${bytes}, 0),
      object_count = greatest(object_count - 1, 0), updated_at = now()
      WHERE workspace_id = ${tx.workspaceId}`.execute(tx.db);
}

/**
 * The malware scan of one uploaded object (ADR-0025 F4). The object stays in quarantine — and every
 * download stays refused — until the scanner says `clean`; then it is copied to its permanent key,
 * marked clean, and its previews become available. An infected object is marked `infected` (only
 * the class is ever shown, never the signature), its bytes are deleted, and its bytes leave the
 * quota. Scanner or storage failures retry with backoff; the last allowed attempt marks the object
 * `error` and deletes its bytes, so a file is never downloadable without a clean scan (fail closed).
 */
export function fileScanHandler(d: FileJobDeps): JobHandler {
  const writer = writerOf(d);
  const s = d.settings ?? DEFAULT_WORK_SETTINGS;
  return {
    kind: FILE_JOB_KINDS.scan,
    queue: FILE_QUEUE,
    maxAttempts: s.fileScanMaxAttempts,
    timeoutMs: 300_000,
    async handle(ctx: JobHandlerContext) {
      const workspaceId = ctx.job.workspaceId;
      const objectId = ctx.job.payloadRef;
      if (!workspaceId || !objectId) return;
      const row = await d.tenant.withWorkspace(workspaceId, { module: 'files' }, (tx) =>
        sql<ObjectRow>`SELECT id, storage_key, quarantined, byte_size::text AS byte_size, content_type, scan_state,
            scan_attempts FROM files.file_object WHERE workspace_id = ${workspaceId} AND id = ${objectId}`.execute(
          tx.db,
        ),
      );
      const o = row.rows[0];
      // Already decided (a retry after success, or a purged upload): nothing to do.
      if (!o || o.scan_state !== 'pending') return;
      const started = Date.now();
      const last = ctx.job.attemptNumber >= s.fileScanMaxAttempts;
      let verdict: 'clean' | 'infected' | 'error';
      let signature: string | null = null;
      try {
        if (!d.storage || !d.scanner) throw new Error('storage or scanner not configured');
        const bytes = await d.storage.read(o.storage_key, { maxBytes: Number(o.byte_size) });
        const r = await d.scanner.scan(bytes);
        verdict = r.verdict;
        if (r.verdict === 'infected') signature = r.signature.slice(0, 200);
        if (r.verdict === 'clean') await d.storage.copy(o.storage_key, permanentKey(o.storage_key));
      } catch (err) {
        ctx.logger.warn('files.scan_attempt_failed', errorFields(err));
        verdict = 'error';
      }
      d.metrics.record('file.scan.duration', (Date.now() - started) / 1000, { outcome: verdict });
      if (verdict === 'error' && !last) {
        await d.tenant.withWorkspace(workspaceId, { module: 'files' }, (tx) =>
          sql`UPDATE files.file_object SET scan_attempts = scan_attempts + 1
              WHERE workspace_id = ${workspaceId} AND id = ${objectId} AND scan_state = 'pending'`.execute(
            tx.db,
          ),
        );
        d.metrics.count('files.jobs', 1, { kind: 'scan', outcome: 'retry' });
        throw new Error('file scan failed; retrying');
      }
      const quarantined = o.storage_key;
      await d.tenant.withWorkspace(workspaceId, { module: 'files' }, async (tx) => {
        const locked = await sql<{ scan_state: string }>`SELECT scan_state FROM files.file_object
            WHERE workspace_id = ${workspaceId} AND id = ${objectId} FOR UPDATE`.execute(tx.db);
        if (locked.rows[0]?.scan_state !== 'pending') return;
        if (verdict === 'clean') {
          await sql`UPDATE files.file_object SET storage_key = ${permanentKey(quarantined)}, quarantined = false,
              scan_state = 'clean', scanned_at = now(), scan_attempts = scan_attempts + 1
              WHERE workspace_id = ${workspaceId} AND id = ${objectId}`.execute(tx.db);
          await sql`UPDATE files.file_version SET preview_state = ${previewKind(o.content_type) === 'none' ? 'unsupported' : 'ready'}
              WHERE workspace_id = ${workspaceId} AND file_object_id = ${objectId}`.execute(tx.db);
          await systemRecord(
            tx,
            writer,
            objectId,
            'file.scanned',
            [change.plain('scan_state', 'pending', 'clean')],
            'clean',
          );
        } else {
          await sql`UPDATE files.file_object SET scan_state = ${verdict}, scan_signature = ${signature},
              scanned_at = now(), scan_attempts = scan_attempts + 1
              WHERE workspace_id = ${workspaceId} AND id = ${objectId}`.execute(tx.db);
          await sql`UPDATE files.file_version SET preview_state = 'failed'
              WHERE workspace_id = ${workspaceId} AND file_object_id = ${objectId}`.execute(tx.db);
          await release(tx, Number(o.byte_size));
          await systemRecord(
            tx,
            writer,
            objectId,
            'file.blocked',
            [change.plain('scan_state', 'pending', verdict === 'infected' ? 'infected' : 'error')],
            verdict,
          );
        }
      });
      // Bytes leave quarantine only after the database says where they are.
      if (d.storage) await d.storage.delete(quarantined).catch(() => undefined);
      d.metrics.count('files.jobs', 1, { kind: 'scan', outcome: verdict });
    },
  };
}

/**
 * The file sweep: expired, unfinished upload sessions release their reserved bytes and lose their
 * quarantined object; object deletions that purge recorded as external effects (`object:{key}`)
 * are performed — a delete is naturally idempotent, so a lost acknowledgement just repeats it —
 * and confirmed, or left failed for the next sweep when storage is unavailable.
 */
export function fileSweepHandler(d: FileJobDeps): JobHandler {
  return {
    kind: FILE_JOB_KINDS.sweep,
    queue: FILE_QUEUE,
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle() {
      const s = d.settings ?? DEFAULT_WORK_SETTINGS;
      const now = new Date();
      const workspaces = await d.discovery.discoverFileWork(now, s.fileDiscoveryMax);
      for (const ws of workspaces) {
        const expired = await d.tenant.withWorkspace(ws, { module: 'files' }, async (tx) => {
          const rows = (
            await sql<{
              id: string;
              byte_size: string;
              key: string;
            }>`SELECT id, byte_size::text AS byte_size,
                quarantine_object_key AS key FROM files.upload_session
                WHERE workspace_id = ${ws} AND state IN ('initiated', 'uploaded') AND expires_at <= ${now}
                ORDER BY expires_at, id LIMIT ${s.fileExpiryBatchMax} FOR UPDATE SKIP LOCKED`.execute(
              tx.db,
            )
          ).rows;
          for (const r of rows) {
            await sql`UPDATE files.upload_session SET state = 'expired', updated_at = now(), version = version + 1
                WHERE workspace_id = ${ws} AND id = ${r.id}`.execute(tx.db);
            await sql`UPDATE files.storage_usage SET reserved_bytes = greatest(reserved_bytes - ${Number(r.byte_size)}, 0),
                updated_at = now() WHERE workspace_id = ${ws}`.execute(tx.db);
          }
          return rows.map((r) => r.key);
        });
        if (d.storage)
          for (const key of expired) await d.storage.delete(key).catch(() => undefined);
        if (expired.length)
          d.metrics.count('files.jobs', expired.length, { kind: 'expire', outcome: 'ok' });
        if (!d.storage) continue;
        const effects = await d.tenant.withWorkspace(ws, { module: 'files' }, (tx) =>
          sql<{ id: string; effect_key: string }>`SELECT id, effect_key FROM exec.external_effect
              WHERE workspace_id = ${ws} AND effect_key LIKE ${OBJECT_EFFECT_PREFIX + '%'}
                AND state IN ('pending', 'failed')
              ORDER BY created_at, id LIMIT ${s.fileExpiryBatchMax}`.execute(tx.db),
        );
        for (const e of effects.rows) {
          const key = e.effect_key.slice(OBJECT_EFFECT_PREFIX.length);
          await d.tenant.withWorkspace(ws, { module: 'files' }, (tx) =>
            markEffectAttempt(tx, e.id, undefined),
          );
          let ok = true;
          try {
            await d.storage.delete(key);
            // A purged object may still sit in quarantine when it was never scanned clean.
            if (key.startsWith('o.')) await d.storage.delete(`q.${key.slice(2)}`);
          } catch (err) {
            ok = false;
            d.logger.warn('files.object_delete_failed', errorFields(err));
          }
          await d.tenant.withWorkspace(ws, { module: 'files' }, (tx) =>
            markEffectOutcome(tx, e.id, ok ? 'confirmed' : 'failed'),
          );
          d.metrics.count('files.jobs', 1, {
            kind: 'delete_object',
            outcome: ok ? 'ok' : 'failed',
          });
        }
      }
    },
  };
}
