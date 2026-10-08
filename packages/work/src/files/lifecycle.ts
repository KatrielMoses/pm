import { sql, type WorkspaceTransaction } from '@pm/db';
import type { RecordRef, RecordTypeAdapter } from '@pm/lifecycle';
import { purgeCollabFacts } from '../collab/purge.ts';
import { purgeNotifyFacts } from '../notify/purge.ts';

/**
 * Files and deliverables in the 1F lifecycle (ADR-0026 F7; FILE-013). A file is contained by its
 * host (brand, project, task, or the record a comment sits on); a deliverable by its task. Both
 * trash, restore, and purge with their container. Purge deletes rows and leaves each object no
 * version still uses as an orphan whose key becomes an `object:{key}` external effect; the file
 * sweep deletes the bytes and then the orphan row. Evidence-locked versions — accepted deliverables
 * and the file versions they point at — are excluded from purge (R-EVIDENCE, OD-36: no period).
 */

/** Files hosted on these records (directly or on their comments) and deliverables of these tasks. */
export async function fileChildren(
  tx: WorkspaceTransaction,
  parentIds: readonly string[],
): Promise<RecordRef[]> {
  if (!parentIds.length) return [];
  const rows = await sql<{ id: string; type: string }>`
    SELECT id, 'file' AS type FROM files.file WHERE host_record_id = ANY(${[...parentIds]}::uuid[])
    UNION ALL SELECT id, 'deliverable' FROM files.deliverable WHERE task_id = ANY(${[...parentIds]}::uuid[])
    ORDER BY 1`.execute(tx.db);
  return rows.rows.map((r) => ({ id: r.id, recordType: r.type }));
}

/** Deletes deliverables (their versions first; their reviews and comments with them). */
export async function deleteDeliverables(tx: WorkspaceTransaction, ids: readonly string[]) {
  if (!ids.length) return;
  const list = [...ids];
  await sql`UPDATE files.deliverable SET current_version_id = NULL, accepted_version_id = NULL
      WHERE workspace_id = ${tx.workspaceId} AND id = ANY(${list}::uuid[])`.execute(tx.db);
  await tx.db
    .deleteFrom('files.deliverable_version')
    .where('deliverable_id', 'in', list)
    .where('evidence_locked', '=', false)
    .execute();
  await purgeCollabFacts(tx, list);
  await purgeNotifyFacts(tx, list);
  await tx.db.deleteFrom('files.deliverable').where('id', 'in', list).execute();
}

/**
 * Deletes files and their versions. Objects no remaining version uses become orphans: their bytes
 * leave the quota now, and purge records their deletion (see `orphanKeys`).
 */
export async function deleteFiles(tx: WorkspaceTransaction, ids: readonly string[]) {
  if (!ids.length) return;
  const list = [...ids];
  const objects = (
    await sql<{ id: string }>`SELECT DISTINCT file_object_id AS id FROM files.file_version
        WHERE workspace_id = ${tx.workspaceId} AND file_id = ANY(${list}::uuid[]) AND file_object_id IS NOT NULL`.execute(
      tx.db,
    )
  ).rows.map((r) => r.id);
  await sql`UPDATE files.file SET current_version_id = NULL
      WHERE workspace_id = ${tx.workspaceId} AND id = ANY(${list}::uuid[])`.execute(tx.db);
  await sql`DELETE FROM files.file_version WHERE workspace_id = ${tx.workspaceId}
      AND file_id = ANY(${list}::uuid[]) AND NOT evidence_locked`.execute(tx.db);
  await purgeCollabFacts(tx, list);
  await purgeNotifyFacts(tx, list);
  await tx.db.deleteFrom('files.file').where('id', 'in', list).execute();
  if (!objects.length) return;
  // Clean or still-pending objects were counted; blocked ones already left the quota.
  const freed = (
    await sql<{
      bytes: string | null;
      n: number;
    }>`SELECT sum(byte_size)::text AS bytes, count(*)::int AS n
        FROM files.file_object o
        WHERE o.workspace_id = ${tx.workspaceId} AND o.id = ANY(${objects}::uuid[])
          AND o.scan_state IN ('clean', 'pending')
          AND NOT EXISTS (SELECT 1 FROM files.file_version v WHERE v.workspace_id = o.workspace_id
                          AND v.file_object_id = o.id)`.execute(tx.db)
  ).rows[0]!;
  if (freed.n)
    await sql`UPDATE files.storage_usage SET used_bytes = greatest(used_bytes - ${Number(freed.bytes ?? 0)}, 0),
        object_count = greatest(object_count - ${freed.n}, 0), updated_at = now()
        WHERE workspace_id = ${tx.workspaceId}`.execute(tx.db);
}

/** Storage keys of objects no version uses any more (purge records each as an external effect). */
export async function orphanKeys(tx: WorkspaceTransaction): Promise<string[]> {
  return (
    await sql<{ storage_key: string }>`SELECT o.storage_key FROM files.file_object o
        WHERE o.workspace_id = ${tx.workspaceId}
          AND NOT EXISTS (SELECT 1 FROM files.file_version v WHERE v.workspace_id = o.workspace_id
                          AND v.file_object_id = o.id)
          AND NOT EXISTS (SELECT 1 FROM files.upload_session s WHERE s.workspace_id = o.workspace_id
                          AND s.file_object_id = o.id AND s.state IN ('initiated', 'uploaded', 'verifying'))
        ORDER BY o.storage_key`.execute(tx.db)
  ).rows.map((r) => r.storage_key);
}

/** A host's purge removes its deliverables and files first (their keys reference its rows). */
export async function purgeFileFacts(tx: WorkspaceTransaction, hostIds: readonly string[]) {
  if (!hostIds.length) return;
  const list = [...hostIds];
  const dl = await tx.db
    .selectFrom('files.deliverable')
    .select('id')
    .where('task_id', 'in', list)
    .execute();
  await deleteDeliverables(
    tx,
    dl.map((r) => r.id),
  );
  const fl = await sql<{ id: string }>`SELECT f.id FROM files.file f
      LEFT JOIN collab.comment c ON c.workspace_id = f.workspace_id AND c.id = f.comment_id
      WHERE f.workspace_id = ${tx.workspaceId}
        AND (f.host_record_id = ANY(${list}::uuid[]) OR c.host_record_id = ANY(${list}::uuid[]))`.execute(
    tx.db,
  );
  await deleteFiles(
    tx,
    fl.rows.map((r) => r.id),
  );
}

export const fileAdapter: RecordTypeAdapter = {
  recordType: 'file',
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('files.file')
      .select('id')
      .where('host_kind', '=', 'brand')
      .where('host_record_id', 'in', [...brandIds])
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ id: r.id, recordType: 'file' }));
  },
  async containerOf(tx, recordId) {
    const r = await sql<{ id: string | null; type: string | null }>`SELECT f.host_record_id AS id,
        hr.record_type AS type FROM files.file f
        LEFT JOIN core.record hr ON hr.workspace_id = f.workspace_id AND hr.id = f.host_record_id
        WHERE f.workspace_id = ${tx.workspaceId} AND f.id = ${recordId}`.execute(tx.db);
    const row = r.rows[0];
    return row?.id && row.type ? { id: row.id, recordType: row.type } : null;
  },
  async evidenceLocked(tx, recordIds) {
    if (!recordIds.length) return [];
    const rows = await tx.db
      .selectFrom('files.file_version')
      .select('file_id')
      .distinct()
      .where('file_id', 'in', [...recordIds])
      .where('evidence_locked', '=', true)
      .execute();
    return rows.map((r) => r.file_id);
  },
  purge: {
    async deleteContent(tx, recordIds) {
      await deleteFiles(tx, recordIds);
    },
    objectKeys: (tx) => orphanKeys(tx),
  },
};

export const deliverableAdapter: RecordTypeAdapter = {
  recordType: 'deliverable',
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('files.deliverable')
      .select('task_id')
      .where('id', '=', recordId)
      .executeTakeFirst();
    return r ? { id: r.task_id, recordType: 'task' } : null;
  },
  async evidenceLocked(tx, recordIds) {
    if (!recordIds.length) return [];
    const rows = await tx.db
      .selectFrom('files.deliverable')
      .select('id')
      .where('id', 'in', [...recordIds])
      .where('accepted_version_id', 'is not', null)
      .execute();
    return rows.map((r) => r.id);
  },
  purge: {
    async deleteContent(tx, recordIds) {
      await deleteDeliverables(tx, recordIds);
    },
  },
};
