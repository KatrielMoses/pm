import type { WorkspaceTransaction } from '@pm/db';
import { sql } from '@pm/db';
import type { RecordRef, RecordTypeAdapter } from '@pm/lifecycle';
import { purgeCollabFacts } from '../collab/purge.ts';
import { purgeNotifyFacts } from '../notify/purge.ts';
import { fileChildren, purgeFileFacts } from '../files/lifecycle.ts';

/**
 * References that name a purged record (a task, project, or document) leave with it, so no
 * document keeps a link to something that no longer exists; the content keeps its reference token,
 * which renders as a restricted item (ADR-0025 D5).
 */
export async function purgeDocumentTargets(
  tx: WorkspaceTransaction,
  recordIds: readonly string[],
): Promise<void> {
  const ids = [...recordIds];
  if (!ids.length) return;
  await tx.db.deleteFrom('knowledge.document_reference').where('target_record_id', 'in', ids).execute();
}

const refs = (rows: Array<{ id: string }>): RecordRef[] =>
  rows.map((r) => ({ id: r.id, recordType: 'document' }));

/** Top-level documents attached to these projects or tasks (their pages follow through the tree). */
export async function attachedDocuments(
  tx: WorkspaceTransaction,
  column: 'attached_project_id' | 'attached_task_id',
  hostIds: readonly string[],
): Promise<RecordRef[]> {
  if (!hostIds.length) return [];
  const rows = await tx.db
    .selectFrom('knowledge.document')
    .select('id')
    .where(column, 'in', [...hostIds])
    .where('parent_document_id', 'is', null)
    .where('lifecycle_state', '<>', 'purged')
    .orderBy('id')
    .execute();
  return refs(rows);
}

/**
 * Documents (ADR-0025 D10). A page's lifecycle carries its subpages; a project's or task's carries
 * the documents attached to it; brand-level and workspace-level documents are brand roots.
 */
export const documentAdapter: RecordTypeAdapter = {
  recordType: 'document',
  async children(tx, parentIds) {
    if (!parentIds.length) return [];
    const rows = await tx.db
      .selectFrom('knowledge.document')
      .select('id')
      .where('parent_document_id', 'in', [...parentIds])
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    // Files hosted on a page (and on its comments) travel with it (4D closes the 4C and 4E join).
    return [...refs(rows), ...(await fileChildren(tx, parentIds))];
  },
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('knowledge.document')
      .select('id')
      .where('brand_id', 'in', [...brandIds])
      .where('parent_document_id', 'is', null)
      .where('attached_project_id', 'is', null)
      .where('attached_task_id', 'is', null)
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return refs(rows);
  },
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('knowledge.document')
      .select(['parent_document_id', 'attached_project_id', 'attached_task_id', 'brand_id'])
      .where('id', '=', recordId)
      .executeTakeFirst();
    if (!r) return null;
    if (r.parent_document_id) return { id: r.parent_document_id, recordType: 'document' };
    if (r.attached_task_id) return { id: r.attached_task_id, recordType: 'task' };
    if (r.attached_project_id) return { id: r.attached_project_id, recordType: 'project' };
    return r.brand_id ? { id: r.brand_id, recordType: 'brand' } : null;
  },
  purge: {
    async deleteContent(tx, recordIds) {
      const ids = [...recordIds];
      // Its files first (they reference its comments and rows, 4E), then comments, followers, reviews, notifications, and their own references.
      await purgeFileFacts(tx, ids);
      await purgeCollabFacts(tx, ids);
      await purgeNotifyFacts(tx, ids);
      // Live editing leaves nothing behind: the operation log, the sessions, and the draft (4D).
      await tx.db.deleteFrom('knowledge.edit_op').where('document_id', 'in', ids).execute();
      await tx.db.deleteFrom('knowledge.edit_session').where('document_id', 'in', ids).execute();
      await tx.db.deleteFrom('knowledge.edit_draft').where('document_id', 'in', ids).execute();
      await tx.db.deleteFrom('knowledge.document_suggestion').where('document_id', 'in', ids).execute();
      await tx.db.deleteFrom('knowledge.source_approval').where('document_id', 'in', ids).execute();
      await tx.db.deleteFrom('knowledge.document_reference').where('document_id', 'in', ids).execute();
      await purgeDocumentTargets(tx, ids);
      // The version pointer and the versions reference each other; both sides go in this transaction.
      await tx.db.deleteFrom('knowledge.document').where('id', 'in', ids).execute();
      await tx.db.deleteFrom('knowledge.document_version').where('document_id', 'in', ids).execute();
    },
    async removeAssociations(tx, recordIds) {
      const ids = [...recordIds];
      const r = await tx.db
        .deleteFrom('knowledge.document_reference')
        .where('target_record_id', 'in', ids)
        .executeTakeFirst();
      const rel = await tx.db
        .deleteFrom('relations.record_relationship')
        .where((eb) => eb.or([eb('from_record_id', 'in', ids), eb('to_record_id', 'in', ids)]))
        .executeTakeFirst();
      void sql;
      return Number(r.numDeletedRows) + Number(rel.numDeletedRows);
    },
  },
};
