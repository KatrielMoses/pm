import type { WorkspaceTransaction } from '@pm/db';
import { sql } from '@pm/db';

/**
 * A purged record's collaboration content (OD-38, ADR-0023 D2): its comments with their revisions,
 * reactions, and mentions (bodies are content and leave with the record), its followers, its
 * reviews with their decisions, and a task's assignment history. Mentions of the record in other
 * records' comments go too. Only structural audit facts remain, and they carry hashes, never text.
 */
export async function purgeCollabFacts(
  tx: WorkspaceTransaction,
  hostIds: readonly string[],
): Promise<void> {
  const ids = [...hostIds];
  if (!ids.length) return;
  await sql`DELETE FROM relations.mention m USING collab.comment c
             WHERE c.workspace_id = m.workspace_id AND c.id = m.source_id
               AND c.host_record_id = ANY(${ids}::uuid[])`.execute(tx.db);
  await tx.db.deleteFrom('relations.mention').where('target_record_id', 'in', ids).execute();
  await sql`DELETE FROM collab.reaction r USING collab.comment c
             WHERE c.workspace_id = r.workspace_id AND c.id = r.comment_id
               AND c.host_record_id = ANY(${ids}::uuid[])`.execute(tx.db);
  await sql`DELETE FROM collab.comment_revision v USING collab.comment c
             WHERE c.workspace_id = v.workspace_id AND c.id = v.comment_id
               AND c.host_record_id = ANY(${ids}::uuid[])`.execute(tx.db);
  // Replies go with their thread (cascade); roots and replies share the host.
  await tx.db.deleteFrom('collab.comment').where('host_record_id', 'in', ids).execute();
  await tx.db.deleteFrom('relations.follower').where('record_id', 'in', ids).execute();
  await sql`DELETE FROM collab.review_decision d USING collab.review_request q
             WHERE q.workspace_id = d.workspace_id AND q.id = d.review_request_id
               AND q.subject_record_id = ANY(${ids}::uuid[])`.execute(tx.db);
  await sql`DELETE FROM collab.review_reviewer v USING collab.review_request q
             WHERE q.workspace_id = v.workspace_id AND q.id = v.review_request_id
               AND q.subject_record_id = ANY(${ids}::uuid[])`.execute(tx.db);
  await tx.db.deleteFrom('collab.review_request').where('subject_record_id', 'in', ids).execute();
  await tx.db.deleteFrom('collab.assignment_event').where('task_id', 'in', ids).execute();
}
