import { sql, type WorkspaceTransaction } from '@pm/db';
import type { LifecycleRegistry, RecordRef, RecordTypeAdapter } from '@pm/lifecycle';
import { withPersonalReferenceCleanup } from '@pm/tenancy';

/**
 * Project record types for the 1F lifecycle (0B ADR-21). Containment the lifecycle follows:
 * brand → every project in it (each project is its own lifecycle root inside the brand); project →
 * its phases, milestones, and decisions. Child projects are never containment children of their
 * parent: a project lifecycle command never archives, trashes, or purges sub-projects, and a purge
 * refuses while a live child still references the parent (the foreign key would also block it).
 */

const refs = (rows: Array<{ id: string; type: string }>): RecordRef[] =>
  rows.map((r) => ({ id: r.id, recordType: r.type }));

export const projectAdapter: RecordTypeAdapter = {
  recordType: 'project',
  async children(tx, parentIds) {
    if (!parentIds.length) return [];
    const rows = await sql<{ id: string; type: string }>`
      SELECT id, 'phase' AS type FROM work.phase WHERE project_id = ANY(${[...parentIds]}::uuid[])
      UNION ALL SELECT id, 'milestone' FROM work.milestone WHERE project_id = ANY(${[...parentIds]}::uuid[])
      UNION ALL SELECT id, 'decision_record' FROM work.decision_record WHERE project_id = ANY(${[...parentIds]}::uuid[])
      ORDER BY 1`.execute(tx.db);
    return refs(rows.rows);
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
      await tx.db
        .deleteFrom('work.project_update_verification')
        .where('project_id', 'in', ids)
        .execute();
      await tx.db.deleteFrom('work.project_update').where('project_id', 'in', ids).execute();
      await tx.db.deleteFrom('work.criteria_item').where('project_id', 'in', ids).execute();
      await tx.db.deleteFrom('work.scope_item').where('project_id', 'in', ids).execute();
      // Series sourced from the project keep their frozen snapshot; the source link detaches.
      await sql`UPDATE planning.recurrence_series SET source_record_id = NULL, updated_at = now(), version = version + 1
                 WHERE source_record_id = ANY(${ids}::uuid[])`.execute(tx.db);
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

/** Registers the work record types (API and worker use the same registration). */
export function registerWorkLifecycle(registry: LifecycleRegistry): LifecycleRegistry {
  for (const a of [
    projectAdapter,
    phaseAdapter,
    milestoneAdapter,
    decisionAdapter,
    templateAdapter,
  ])
    registry.register(withPersonalReferenceCleanup(a));
  return registry;
}
