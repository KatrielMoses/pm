import type { WorkspaceTransaction } from '@pm/db';
import type { RecordRef, RecordTypeAdapter } from '@pm/lifecycle';

const refs = (rows: Array<{ id: string }>, recordType: string): RecordRef[] =>
  rows.map((r) => ({ id: r.id, recordType }));

/**
 * Links and portfolio memberships that name a purged project or task leave with it (ADR-0029 G17),
 * so no goal or portfolio keeps a reference to something that no longer exists. The goals,
 * key results, and portfolios themselves stay.
 */
export async function purgeGoalTargets(
  tx: WorkspaceTransaction,
  recordIds: readonly string[],
): Promise<void> {
  const ids = [...recordIds];
  if (!ids.length) return;
  await tx.db.deleteFrom('goals.goal_link').where('target_record_id', 'in', ids).execute();
  await tx.db.deleteFrom('goals.portfolio_project').where('project_id', 'in', ids).execute();
}

/** Goals scoped to these projects (their lifecycle carries them). */
export async function attachedGoals(
  tx: WorkspaceTransaction,
  projectIds: readonly string[],
): Promise<RecordRef[]> {
  if (!projectIds.length) return [];
  const rows = await tx.db
    .selectFrom('goals.goal')
    .select('id')
    .where('project_id', 'in', [...projectIds])
    .where('lifecycle_state', '<>', 'purged')
    .orderBy('id')
    .execute();
  return refs(rows, 'goal');
}

/**
 * Goals (ADR-0029 G17). A goal's lifecycle carries its key results; a project's carries the goals
 * scoped to it; brand-level goals are brand roots, and workspace-level goals belong to no brand.
 */
export const goalAdapter: RecordTypeAdapter = {
  recordType: 'goal',
  async children(tx, parentIds) {
    if (!parentIds.length) return [];
    const rows = await tx.db
      .selectFrom('goals.key_result')
      .select('id')
      .where('goal_id', 'in', [...parentIds])
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return refs(rows, 'key_result');
  },
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('goals.goal')
      .select('id')
      .where('brand_id', 'in', [...brandIds])
      .where('project_id', 'is', null)
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return refs(rows, 'goal');
  },
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('goals.goal')
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
      // Check-ins and links name the goal or its key results; they are its content. The latest
      // check-in pointers and the check-ins reference each other through deferred keys, so both
      // sides go in this transaction.
      await tx.db.deleteFrom('goals.goal_link').where('goal_id', 'in', ids).execute();
      await tx.db.deleteFrom('goals.goal_state').where('goal_id', 'in', ids).execute();
      await tx.db.deleteFrom('goals.goal_checkin').where('goal_id', 'in', ids).execute();
      await tx.db.deleteFrom('goals.key_result').where('goal_id', 'in', ids).execute();
      await tx.db.deleteFrom('goals.goal').where('id', 'in', ids).execute();
    },
  },
};

export const keyResultAdapter: RecordTypeAdapter = {
  recordType: 'key_result',
  children: () => Promise.resolve([]),
  async rootsInBrand() {
    // A key result is never a brand root: it travels with its goal.
    return [];
  },
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('goals.key_result')
      .select('goal_id')
      .where('id', '=', recordId)
      .executeTakeFirst();
    return r ? { id: r.goal_id, recordType: 'goal' } : null;
  },
  purge: {
    async deleteContent(tx, recordIds) {
      const ids = [...recordIds];
      await tx.db.deleteFrom('goals.goal_link').where('key_result_id', 'in', ids).execute();
      // A purge that reaches a key result alone removes its own check-ins (never a goal's); the
      // deferred pointer keys are checked at commit, when the key result is gone too.
      await tx.db.deleteFrom('goals.goal_checkin').where('key_result_id', 'in', ids).execute();
      await tx.db.deleteFrom('goals.key_result').where('id', 'in', ids).execute();
    },
  },
};

export const portfolioAdapter: RecordTypeAdapter = {
  recordType: 'portfolio',
  children: () => Promise.resolve([]),
  async rootsInBrand(tx, brandIds) {
    if (!brandIds.length) return [];
    const rows = await tx.db
      .selectFrom('goals.portfolio')
      .select('id')
      .where('brand_id', 'in', [...brandIds])
      .where('lifecycle_state', '<>', 'purged')
      .orderBy('id')
      .execute();
    return refs(rows, 'portfolio');
  },
  async containerOf(tx, recordId) {
    const r = await tx.db
      .selectFrom('goals.portfolio')
      .select('brand_id')
      .where('id', '=', recordId)
      .executeTakeFirst();
    return r?.brand_id ? { id: r.brand_id, recordType: 'brand' } : null;
  },
  purge: {
    async deleteContent(tx, recordIds) {
      const ids = [...recordIds];
      await tx.db.deleteFrom('goals.portfolio_project').where('portfolio_id', 'in', ids).execute();
      await tx.db.deleteFrom('goals.portfolio').where('id', 'in', ids).execute();
    },
  },
};
