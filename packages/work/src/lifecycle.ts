import { sql, type WorkspaceTransaction } from '@pm/db';
import { automationAdapter } from './automation/lifecycle.ts';
import { agentProfileAdapter, purgeTaskAgentAssignments } from './agents/lifecycle.ts';
import type { LifecycleRegistry, RecordRef, RecordTypeAdapter } from '@pm/lifecycle';
import { withPersonalReferenceCleanup } from '@pm/tenancy';
import { eraseAiContentRows } from './ai/lifecycle.ts';
import { purgeCollabFacts } from './collab/purge.ts';
import { purgeNotifyFacts } from './notify/purge.ts';
import { attachedDocuments, documentAdapter, purgeDocumentTargets } from './docs/lifecycle.ts';
import {
  attachedGoals,
  goalAdapter,
  keyResultAdapter,
  portfolioAdapter,
  purgeGoalTargets,
} from './goals/lifecycle.ts';
import { attachedInsights, dashboardAdapter, reportAdapter } from './insights/lifecycle.ts';
import { connectionAdapter, webhookSubscriptionAdapter } from './integrations/lifecycle.ts';
import {
  deliverableAdapter,
  fileAdapter,
  fileChildren,
  purgeFileFacts,
} from './files/lifecycle.ts';

/**
 * Project record types for the 1F lifecycle (0B ADR-21). Containment the lifecycle follows:
 * brand → every project in it (each project is its own lifecycle root inside the brand); project →
 * its phases, milestones, decisions, and every task in it (2B; tasks are project content, so a
 * project's lifecycle carries them). Child projects are never containment children of their
 * parent: a project lifecycle command never archives, trashes, or purges sub-projects, and a purge
 * refuses while a live child still references the parent (the foreign key would also block it).
 */

const refs = (rows: Array<{ id: string; type: string }>): RecordRef[] =>
  rows.map((r) => ({ id: r.id, recordType: r.type }));

/** A purged record's workflow facts: values, set attachments, approval requests and decisions. */
async function purgeWorkflowFacts(tx: WorkspaceTransaction, ids: string[]) {
  await sql`DELETE FROM workflow.approval_decision d USING workflow.approval_request r
             WHERE r.id = d.approval_request_id AND r.record_id = ANY(${ids}::uuid[])`.execute(
    tx.db,
  );
  await tx.db.deleteFrom('workflow.approval_request').where('record_id', 'in', ids).execute();
  await tx.db.deleteFrom('workflow.field_value').where('record_id', 'in', ids).execute();
  await tx.db.deleteFrom('workflow.field_set_attachment').where('record_id', 'in', ids).execute();
}

export const projectAdapter: RecordTypeAdapter = {
  recordType: 'project',
  async children(tx, parentIds) {
    if (!parentIds.length) return [];
    const rows = await sql<{ id: string; type: string }>`
      SELECT id, 'phase' AS type FROM work.phase WHERE project_id = ANY(${[...parentIds]}::uuid[])
      UNION ALL SELECT id, 'milestone' FROM work.milestone WHERE project_id = ANY(${[...parentIds]}::uuid[])
      UNION ALL SELECT id, 'decision_record' FROM work.decision_record WHERE project_id = ANY(${[...parentIds]}::uuid[])
      UNION ALL SELECT id, 'task' FROM work.task WHERE project_id = ANY(${[...parentIds]}::uuid[])
      UNION ALL SELECT id, 'saved_view' FROM views.saved_view WHERE share_project_id = ANY(${[...parentIds]}::uuid[])
      UNION ALL SELECT id, 'file' FROM files.file WHERE host_record_id = ANY(${[...parentIds]}::uuid[])
      ORDER BY 1`.execute(tx.db);
    // Documents attached to the project travel with it (4C); those on its tasks follow their tasks.
    return [
      ...refs(rows.rows),
      ...(await attachedDocuments(tx, 'attached_project_id', parentIds)),
      // Goals scoped to the project travel with it (5B).
      ...(await attachedGoals(tx, parentIds)),
      // Dashboards and reports scoped to the project travel with it (5D).
      ...(await attachedInsights(tx, parentIds)),
    ];
  },
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('work.project')
      .select('id')
      .where('brand_id', 'in', [...brandIds])
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ id: r.id, recordType: 'project' }));
  },
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('work.project')
      .select(['parent_project_id', 'brand_id'])
      .where('id', '=', recordId)
      .executeTakeFirst();
    if (!r) return null;
    return r.parent_project_id
      ? { id: r.parent_project_id, recordType: 'project' }
      : { id: r.brand_id, recordType: 'brand' };
  },
  purge: {
    async deleteContent(tx, recordIds) {
      const ids = [...recordIds];
      const live = await tx.db
        .selectFrom('work.project')
        .select('id')
        .where('parent_project_id', 'in', ids)
        .where('id', 'not in', ids)
        .executeTakeFirst();
      if (live) throw new Error('project purge blocked: a live child project references it');
      // Its comments, followers, and reviews go with it (4A, OD-38).
      // Its files and deliverables first (they reference its comments and rows, 4E).
      await purgeFileFacts(tx, ids);
      await purgeCollabFacts(tx, ids);
      await purgeNotifyFacts(tx, ids);
      await purgeDocumentTargets(tx, ids);
      await purgeGoalTargets(tx, ids);
      // Views shared with the project are its content (3A); its defaults go with it.
      await tx.db.deleteFrom('views.view_default').where('project_id', 'in', ids).execute();
      // Time logged on the project itself goes with it (3D; its tasks purge their own).
      await tx.db.deleteFrom('timetrack.time_entry').where('project_id', 'in', ids).execute();
      await tx.db
        .deleteFrom('work.project_update_verification')
        .where('project_id', 'in', ids)
        .execute();
      await tx.db.deleteFrom('work.project_update').where('project_id', 'in', ids).execute();
      await sql`DELETE FROM work.task_inherited_criterion x USING work.criteria_item c
                 WHERE c.id = x.criteria_item_id AND c.project_id = ANY(${ids}::uuid[])`.execute(
        tx.db,
      );
      await tx.db.deleteFrom('work.criteria_item').where('project_id', 'in', ids).execute();
      await tx.db.deleteFrom('work.scope_item').where('project_id', 'in', ids).execute();
      // Series sourced from the project keep their frozen snapshot; the source link detaches.
      await sql`UPDATE planning.recurrence_series SET source_record_id = NULL, updated_at = now(), version = version + 1
                 WHERE source_record_id = ANY(${ids}::uuid[])`.execute(tx.db);
      // Task series that generate into the project pause and detach from it (ADR-0016).
      await sql`UPDATE planning.recurrence_series
                   SET project_id = NULL, state = 'paused', next_due_at = NULL, updated_at = now(), version = version + 1
                 WHERE project_id = ANY(${ids}::uuid[])`.execute(tx.db);
      await purgeWorkflowFacts(tx, ids);
      await tx.db.deleteFrom('work.project').where('id', 'in', ids).execute();
    },
    async removeAssociations(tx, recordIds) {
      const ids = [...recordIds];
      const rel = await tx.db
        .deleteFrom('relations.record_relationship')
        .where((eb) => eb.or([eb('from_record_id', 'in', ids), eb('to_record_id', 'in', ids)]))
        .executeTakeFirst();
      let n = Number(rel.numDeletedRows);
      for (const id of ids)
        n += Number(
          (
            await sql<{
              n: number;
            }>`SELECT work.remove_purged_project_access(${id}::uuid) AS n`.execute(tx.db)
          ).rows[0]?.n ?? 0,
        );
      return n;
    },
  },
};

export const phaseAdapter: RecordTypeAdapter = {
  recordType: 'phase',
  children: () => Promise.resolve([]),
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('work.phase')
      .select('project_id')
      .where('id', '=', recordId)
      .executeTakeFirst();
    return r ? { id: r.project_id, recordType: 'project' } : null;
  },
  purge: {
    async deleteContent(tx, recordIds) {
      const ids = [...recordIds];
      await sql`UPDATE work.milestone SET phase_id = NULL, version = version + 1 WHERE phase_id = ANY(${ids}::uuid[])`.execute(
        tx.db,
      );
      await tx.db.deleteFrom('work.phase').where('id', 'in', ids).execute();
    },
  },
};

export const milestoneAdapter: RecordTypeAdapter = {
  recordType: 'milestone',
  children: () => Promise.resolve([]),
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('work.milestone')
      .select('project_id')
      .where('id', '=', recordId)
      .executeTakeFirst();
    return r ? { id: r.project_id, recordType: 'project' } : null;
  },
  purge: {
    async deleteContent(tx, recordIds) {
      await tx.db
        .deleteFrom('work.milestone')
        .where('id', 'in', [...recordIds])
        .execute();
    },
    async removeAssociations(tx, recordIds) {
      const ids = [...recordIds];
      const r = await tx.db
        .deleteFrom('relations.record_relationship')
        .where((eb) => eb.or([eb('from_record_id', 'in', ids), eb('to_record_id', 'in', ids)]))
        .executeTakeFirst();
      return Number(r.numDeletedRows);
    },
  },
};

export const decisionAdapter: RecordTypeAdapter = {
  recordType: 'decision_record',
  children: () => Promise.resolve([]),
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('work.decision_record')
      .select('id')
      .where('brand_id', 'in', [...brandIds])
      .where('project_id', 'is', null)
      .execute();
    return rows.map((r) => ({ id: r.id, recordType: 'decision_record' }));
  },
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('work.decision_record')
      .select(['project_id', 'brand_id'])
      .where('id', '=', recordId)
      .executeTakeFirst();
    if (!r) return null;
    return r.project_id
      ? { id: r.project_id, recordType: 'project' }
      : { id: r.brand_id, recordType: 'brand' };
  },
  purge: {
    async deleteContent(tx, recordIds) {
      await tx.db
        .deleteFrom('work.decision_record')
        .where('id', 'in', [...recordIds])
        .execute();
    },
  },
};

/**
 * Tasks (0B ADR-22). A task's own lifecycle never cascades to its subtasks (the command applies
 * to each one only when `include_subtasks` is confirmed), so tasks report no containment children.
 * Projectless tasks are brand roots; project tasks travel with their project. Purge is refused
 * while a live child task still references a purged parent.
 */
export const taskAdapter: RecordTypeAdapter = {
  recordType: 'task',
  // No subtasks; its files (and files on its comments), its deliverables (4E), and the documents
  // attached to it (4C) are its content.
  children: async (tx, parentIds) => [
    ...(await fileChildren(tx, parentIds)),
    ...(await attachedDocuments(tx, 'attached_task_id', parentIds)),
  ],
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('work.task')
      .select('id')
      .where('brand_id', 'in', [...brandIds])
      .where('project_id', 'is', null)
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ id: r.id, recordType: 'task' }));
  },
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('work.task')
      .select(['parent_task_id', 'project_id', 'brand_id'])
      .where('id', '=', recordId)
      .executeTakeFirst();
    if (!r) return null;
    return r.parent_task_id
      ? { id: r.parent_task_id, recordType: 'task' }
      : r.project_id
        ? { id: r.project_id, recordType: 'project' }
        : { id: r.brand_id, recordType: 'brand' };
  },
  purge: {
    async deleteContent(tx, recordIds) {
      const ids = [...recordIds];
      const live = await tx.db
        .selectFrom('work.task')
        .select('id')
        .where('parent_task_id', 'in', ids)
        .where('id', 'not in', ids)
        .executeTakeFirst();
      if (live) throw new Error('task purge blocked: a live child task references it');
      // Comments, revisions, reactions, mentions, followers, reviews, and assignment history are
      // the task's content and go with it (4A, OD-38); audit keeps hashes only.
      // Its files and deliverables first (they reference its comments and rows, 4E).
      await purgeFileFacts(tx, ids);
      await purgeCollabFacts(tx, ids);
      await purgeNotifyFacts(tx, ids);
      await purgeDocumentTargets(tx, ids);
      await purgeGoalTargets(tx, ids);
      // Agent assignments and their revisions go with the task (8B).
      await purgeTaskAgentAssignments(tx, ids);
      // Time logged on the task goes with it (3D); approvals keep their own totals and hash.
      await tx.db.deleteFrom('timetrack.time_entry').where('task_id', 'in', ids).execute();
      // Plans go with the task (3C): commitments, blocks, and recurring blocks for it.
      await tx.db.deleteFrom('planning.today_commitment').where('task_id', 'in', ids).execute();
      await tx.db.deleteFrom('planning.work_block').where('task_id', 'in', ids).execute();
      await sql`DELETE FROM planning.work_block w USING planning.block_series s
                 WHERE s.id = w.series_id AND s.task_id = ANY(${ids}::uuid[])`.execute(tx.db);
      await tx.db.deleteFrom('planning.block_series').where('task_id', 'in', ids).execute();
      await tx.db.deleteFrom('work.task_assignee').where('task_id', 'in', ids).execute();
      await tx.db.deleteFrom('work.checklist_item').where('task_id', 'in', ids).execute();
      await tx.db.deleteFrom('work.task_inherited_criterion').where('task_id', 'in', ids).execute();
      await tx.db.deleteFrom('work.criteria_item').where('task_id', 'in', ids).execute();
      await tx.db.deleteFrom('work.task_label').where('task_id', 'in', ids).execute();
      // Personal reminders and snoozes go with the task; series sourced from it keep their frozen
      // snapshot and detach (ADR-0016).
      await tx.db.deleteFrom('planning.task_reminder').where('task_id', 'in', ids).execute();
      await tx.db.deleteFrom('planning.task_snooze').where('task_id', 'in', ids).execute();
      await sql`UPDATE planning.recurrence_series SET source_record_id = NULL, updated_at = now(), version = version + 1
                 WHERE source_record_id = ANY(${ids}::uuid[])`.execute(tx.db);
      await tx.db
        .deleteFrom('relations.record_link')
        .where('source_record_id', 'in', ids)
        .execute();
      await purgeWorkflowFacts(tx, ids);
      // Children purged in the same batch go first (deepest first) so the parent key never dangles.
      const rows = await tx.db
        .selectFrom('work.task')
        .select(['id', 'depth'])
        .where('id', 'in', ids)
        .execute();
      for (const r of rows.sort((a, b) => b.depth - a.depth))
        await tx.db.deleteFrom('work.task').where('id', '=', r.id).execute();
    },
    async removeAssociations(tx, recordIds) {
      const ids = [...recordIds];
      const rel = await tx.db
        .deleteFrom('relations.record_relationship')
        .where((eb) => eb.or([eb('from_record_id', 'in', ids), eb('to_record_id', 'in', ids)]))
        .executeTakeFirst();
      const links = await tx.db
        .deleteFrom('relations.record_link')
        .where('target_record_id', 'in', ids)
        .executeTakeFirst();
      return Number(rel.numDeletedRows) + Number(links.numDeletedRows);
    },
  },
};

export const templateAdapter: RecordTypeAdapter = {
  recordType: 'template',
  children: () => Promise.resolve([]),
  containerOf: () => Promise.resolve(null),
  purge: {
    async deleteContent(tx: WorkspaceTransaction, recordIds) {
      const ids = [...recordIds];
      await sql`UPDATE templates.template SET current_version_id = NULL WHERE id = ANY(${ids}::uuid[])`.execute(
        tx.db,
      );
      await tx.db
        .deleteFrom('templates.template_version')
        .where('template_id', 'in', ids)
        .execute();
      await tx.db.deleteFrom('templates.template').where('id', 'in', ids).execute();
    },
  },
};

/** Brand-scoped capture rows purge with their brand; brandless ones only with the workspace. */
const brandRoots =
  (table: 'capture.inbox_item' | 'capture.note' | 'capture.intake_form', recordType: string) =>
  async (tx: WorkspaceTransaction, brandIds: readonly string[]) => {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom(table)
      .select('id')
      .where('brand_id', 'in', [...brandIds])
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ id: r.id, recordType }));
  };

/** Detaches records that name a purged capture record as their source (never cascades). */
async function detachCaptureSources(tx: WorkspaceTransaction, ids: string[]) {
  await sql`UPDATE work.project SET intake_source_id = NULL WHERE intake_source_id = ANY(${ids}::uuid[])`.execute(
    tx.db,
  );
  await tx.db
    .deleteFrom('capture.capture_conversion')
    .where('source_record_id', 'in', ids)
    .execute();
  await tx.db.deleteFrom('relations.record_link').where('source_record_id', 'in', ids).execute();
}

/**
 * 7F (Phase 7 integration, ADR-0044 I2): a purged capture takes its protected AI copies with it.
 * The interpretation run that read its text and the transcription of the recording it was saved
 * from are erased (usage, operation, and audit facts stay), and the recording stops naming the
 * item; it stays `saved` as a reference-only fact (its audio was already deleted).
 */
async function purgeCaptureAiCopies(tx: WorkspaceTransaction, ids: string[]) {
  const voice = await tx.db
    .selectFrom('capture.voice_capture')
    .select(['id', 'operation_id'])
    .where('inbox_item_id', 'in', ids)
    .execute();
  const interpreted = await tx.db
    .selectFrom('capture.inbox_item as i')
    .innerJoin('exec.operation as o', (j) =>
      j.on(sql<boolean>`o.public_id = i.parsed->'interpretation'->>'run'`),
    )
    .select('o.id')
    .where('i.id', 'in', ids)
    .execute();
  const runs = [
    ...voice.flatMap((v) => (v.operation_id ? [v.operation_id] : [])),
    ...interpreted.map((r) => r.id),
  ];
  for (let i = 0; i < runs.length; i += 1000)
    await eraseAiContentRows(tx, { operationIds: runs.slice(i, i + 1000) });
  if (voice.length)
    await tx.db
      .updateTable('capture.voice_capture')
      .set({ inbox_item_id: null, updated_at: new Date(), version: sql`version + 1` })
      .where(
        'id',
        'in',
        voice.map((v) => v.id),
      )
      .execute();
}

/** Personal Inbox items (2E, OD-03); merged items are removed before the item they merged into. */
export const inboxItemAdapter: RecordTypeAdapter = {
  recordType: 'inbox_item',
  children: () => Promise.resolve([]),
  rootsInBrand: brandRoots('capture.inbox_item', 'inbox_item'),
  containerOf: () => Promise.resolve(null),
  purge: {
    async deleteContent(tx, recordIds) {
      const ids = [...recordIds];
      await detachCaptureSources(tx, ids);
      await purgeCaptureAiCopies(tx, ids);
      await sql`UPDATE capture.note SET source_inbox_item_id = NULL WHERE source_inbox_item_id = ANY(${ids}::uuid[])`.execute(
        tx.db,
      );
      await tx.db
        .deleteFrom('capture.intake_submission')
        .where('inbox_item_id', 'in', ids)
        .execute();
      await tx.db
        .deleteFrom('capture.inbox_item')
        .where('id', 'in', ids)
        .where('merged_into_id', 'is not', null)
        .execute();
      await tx.db.deleteFrom('capture.inbox_item').where('id', 'in', ids).execute();
    },
  },
};

/** Personal notes (2E). */
export const noteAdapter: RecordTypeAdapter = {
  recordType: 'note',
  children: () => Promise.resolve([]),
  rootsInBrand: brandRoots('capture.note', 'note'),
  containerOf: () => Promise.resolve(null),
  purge: {
    async deleteContent(tx, recordIds) {
      const ids = [...recordIds];
      await detachCaptureSources(tx, ids);
      await tx.db.deleteFrom('capture.note').where('id', 'in', ids).execute();
    },
  },
};

/** Brand intake forms (2E); submissions are receipts and go with the form. */
export const intakeFormAdapter: RecordTypeAdapter = {
  recordType: 'intake_form',
  children: () => Promise.resolve([]),
  rootsInBrand: brandRoots('capture.intake_form', 'intake_form'),
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('capture.intake_form')
      .select('brand_id')
      .where('id', '=', recordId)
      .executeTakeFirst();
    return r ? { id: r.brand_id, recordType: 'brand' } : null;
  },
  purge: {
    async deleteContent(tx, recordIds) {
      const ids = [...recordIds];
      await tx.db.deleteFrom('capture.intake_submission').where('form_id', 'in', ids).execute();
      await tx.db.deleteFrom('capture.intake_form').where('id', 'in', ids).execute();
    },
  },
};

/**
 * Saved views (3A). Views are workspace records; a view shared with a brand or one of its projects
 * purges with that brand. Pins and defaults referencing a purged view go with it.
 */
export const savedViewAdapter: RecordTypeAdapter = {
  recordType: 'saved_view',
  children: () => Promise.resolve([]),
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('views.saved_view')
      .select('id')
      .where('share_brand_id', 'in', [...brandIds])
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ id: r.id, recordType: 'saved_view' }));
  },
  containerOf: () => Promise.resolve(null),
  purge: {
    async deleteContent(tx, recordIds) {
      const ids = [...recordIds];
      await tx.db.deleteFrom('views.view_pin').where('saved_view_id', 'in', ids).execute();
      await tx.db.deleteFrom('views.view_default').where('saved_view_id', 'in', ids).execute();
      await tx.db.deleteFrom('views.saved_view').where('id', 'in', ids).execute();
    },
  },
};

/** Registers the work record types (API and worker use the same registration). */
export function registerWorkLifecycle(registry: LifecycleRegistry): LifecycleRegistry {
  for (const a of [
    projectAdapter,
    phaseAdapter,
    milestoneAdapter,
    decisionAdapter,
    taskAdapter,
    templateAdapter,
    inboxItemAdapter,
    noteAdapter,
    intakeFormAdapter,
    savedViewAdapter,
    documentAdapter,
    goalAdapter,
    keyResultAdapter,
    portfolioAdapter,
    dashboardAdapter,
    reportAdapter,
    connectionAdapter,
    webhookSubscriptionAdapter,
    fileAdapter,
    deliverableAdapter,
    automationAdapter,
    agentProfileAdapter,
  ])
    registry.register(withPersonalReferenceCleanup(a));
  return registry;
}
