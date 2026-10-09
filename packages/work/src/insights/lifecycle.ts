import type { WorkspaceTransaction } from '@pm/db';
import type { RecordRef, RecordTypeAdapter } from '@pm/lifecycle';

const refs = (rows: Array<{ id: string }>, recordType: string): RecordRef[] =>
  rows.map((r) => ({ id: r.id, recordType }));

/** Dashboards and reports scoped to these projects (their lifecycle carries them). */
export async function attachedInsights(
  tx: WorkspaceTransaction,
  projectIds: readonly string[],
): Promise<RecordRef[]> {
  if (!projectIds.length) return [];
  const ids = [...projectIds];
  const dashboards = await tx.db
    .selectFrom('insights.dashboard')
    .select('id')
    .where('project_id', 'in', ids)
    .where('lifecycle_state', '<>', 'purged')
    .orderBy('id')
    .execute();
  const reports = await tx.db
    .selectFrom('insights.report_definition')
    .select('id')
    .where('project_id', 'in', ids)
    .where('lifecycle_state', '<>', 'purged')
    .orderBy('id')
    .execute();
  return [...refs(dashboards, 'dashboard'), ...refs(reports, 'report_definition')];
}

/**
 * Dashboards (ADR-0031 D14): a project's lifecycle carries the dashboards scoped to it; brand
 * dashboards are brand roots; workspace and personal dashboards belong to no brand.
 */
export const dashboardAdapter: RecordTypeAdapter = {
  recordType: 'dashboard',
  children: () => Promise.resolve([]),
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('insights.dashboard')
      .select('id')
      .where('brand_id', 'in', [...brandIds])
      .where('project_id', 'is', null)
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return refs(rows, 'dashboard');
  },
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('insights.dashboard')
      .select(['project_id', 'brand_id'])
      .where('id', '=', recordId)
      .executeTakeFirst();
    if (!r) return null;
    if (r.project_id) return { id: r.project_id, recordType: 'project' };
    return r.brand_id ? { id: r.brand_id, recordType: 'brand' } : null;
  },
  purge: {
    async deleteContent(tx, recordIds) {
      await tx.db
        .deleteFrom('insights.dashboard')
        .where('id', 'in', [...recordIds])
        .execute();
    },
  },
};

/**
 * Report definitions (ADR-0031 D14). Their recipients, shares, and delivery runs are their content
 * and leave with them: a purge leaves no record that someone received a report.
 */
export const reportAdapter: RecordTypeAdapter = {
  recordType: 'report_definition',
  children: () => Promise.resolve([]),
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('insights.report_definition')
      .select('id')
      .where('brand_id', 'in', [...brandIds])
      .where('project_id', 'is', null)
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return refs(rows, 'report_definition');
  },
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('insights.report_definition')
      .select(['project_id', 'brand_id'])
      .where('id', '=', recordId)
      .executeTakeFirst();
    if (!r) return null;
    if (r.project_id) return { id: r.project_id, recordType: 'project' };
    return r.brand_id ? { id: r.brand_id, recordType: 'brand' } : null;
  },
  purge: {
    async deleteContent(tx, recordIds) {
      const ids = [...recordIds];
      await tx.db.deleteFrom('insights.report_run').where('report_id', 'in', ids).execute();
      await tx.db.deleteFrom('insights.report_share').where('report_id', 'in', ids).execute();
      await tx.db.deleteFrom('insights.report_recipient').where('report_id', 'in', ids).execute();
      await tx.db.deleteFrom('insights.report_definition').where('id', 'in', ids).execute();
    },
  },
};
