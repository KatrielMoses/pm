import { sql, type WorkspaceTransaction } from '@pm/db';
import type { RecordRef, RecordTypeAdapter } from '@pm/lifecycle';
import type { OwnershipHook } from '@pm/tenancy';

/** Assignments of tasks to agents and their revisions (task purge removes them with the task). */
export async function purgeTaskAgentAssignments(
  tx: WorkspaceTransaction,
  taskIds: readonly string[],
) {
  if (!taskIds.length) return;
  const rows = await tx.db
    .selectFrom('agents.agent_assignment')
    .select('id')
    .where('task_id', 'in', [...taskIds])
    .execute();
  await deleteAssignments(
    tx,
    rows.map((r) => r.id),
  );
}

/**
 * 8C: runs of the given assignments go first, with their events, tool calls, draft artifacts, and
 * credentials (the run operations stay in the execution history like any other). Purging a run's
 * record is erasure of its content; a run that may still be dispatched (open) is cancelled by the
 * task or profile lifecycle before purge, so nothing here can strand an open dispatch.
 */
export async function purgeAgentRuns(tx: WorkspaceTransaction, where: { assignmentIds: string[] }) {
  if (!where.assignmentIds.length) return;
  const runs = await tx.db
    .selectFrom('agents.agent_run')
    .select('id')
    .where('assignment_id', 'in', where.assignmentIds)
    .execute();
  const ids = runs.map((r) => r.id);
  if (!ids.length) return;
  await tx.db.deleteFrom('agents.agent_run_credential').where('run_id', 'in', ids).execute();
  await tx.db.deleteFrom('agents.agent_artifact').where('run_id', 'in', ids).execute();
  await tx.db.deleteFrom('agents.agent_tool_call').where('run_id', 'in', ids).execute();
  await tx.db.deleteFrom('agents.agent_run_event').where('run_id', 'in', ids).execute();
  await tx.db.deleteFrom('agents.agent_run').where('id', 'in', ids).execute();
}

async function deleteAssignments(tx: WorkspaceTransaction, ids: string[]) {
  if (!ids.length) return;
  await purgeAgentRuns(tx, { assignmentIds: ids });
  // The current-revision reference is deferred: revisions and their assignment go in one commit.
  await tx.db
    .deleteFrom('agents.agent_assignment_revision')
    .where('assignment_id', 'in', ids)
    .execute();
  await tx.db.deleteFrom('agents.agent_assignment').where('id', 'in', ids).execute();
}

/**
 * Purge content of agent profiles: their assignments (with revisions), connector tests, the
 * connector (its secret was destroyed when the profile was trashed or disconnected), grants,
 * revisions, and the profile. Test operations stay in the execution history like any other.
 */
export async function purgeAgentProfiles(tx: WorkspaceTransaction, ids: readonly string[]) {
  if (!ids.length) return;
  const list = [...ids];
  const assignments = await tx.db
    .selectFrom('agents.agent_assignment')
    .select('id')
    .where('profile_id', 'in', list)
    .execute();
  await deleteAssignments(
    tx,
    assignments.map((r) => r.id),
  );
  const connectors = await tx.db
    .selectFrom('agents.agent_connector')
    .select(['id', 'secret_ref'])
    .where('profile_id', 'in', list)
    .execute();
  if (connectors.some((c) => c.secret_ref))
    throw new Error('agent profile purge blocked: a connector still holds a secret reference');
  if (connectors.length) {
    await tx.db
      .deleteFrom('agents.agent_connector_test')
      .where(
        'connector_id',
        'in',
        connectors.map((c) => c.id),
      )
      .execute();
    await tx.db.deleteFrom('agents.agent_connector').where('profile_id', 'in', list).execute();
  }
  const revisions = await tx.db
    .selectFrom('agents.agent_profile_revision')
    .select('id')
    .where('profile_id', 'in', list)
    .execute();
  if (revisions.length) {
    const revs = revisions.map((r) => r.id);
    await tx.db.deleteFrom('agents.agent_scope_grant').where('revision_id', 'in', revs).execute();
    await tx.db.deleteFrom('agents.agent_tool_grant').where('revision_id', 'in', revs).execute();
    await tx.db.deleteFrom('agents.agent_profile_revision').where('id', 'in', revs).execute();
  }
  await tx.db.deleteFrom('agents.agent_profile').where('id', 'in', list).execute();
}

const refs = (rows: Array<{ id: string }>): RecordRef[] =>
  rows.map((r) => ({ id: r.id, recordType: 'agent_profile' }));

/**
 * Agent profiles (8B) are workspace records: no brand contains them, and no brand purge reaches
 * them. Purge removes assignments, tests, the connector, grants, and revisions first.
 */
export const agentProfileAdapter: RecordTypeAdapter = {
  recordType: 'agent_profile',
  children: () => Promise.resolve([]),
  rootsInBrand: () => Promise.resolve(refs([])),
  containerOf: () => Promise.resolve(null),
  purge: {
    async deleteContent(tx, recordIds) {
      await purgeAgentProfiles(tx, [...recordIds]);
    },
  },
};

/**
 * Departure (0C §9.3): a departing owner's agent profiles are suspended (`owner_departed`) and
 * take no work; their assignments show as blocked. Nothing is reassigned silently: a person
 * with authority reassigns the profile and turns it on again.
 */
export const agentProfileOwnerHook: OwnershipHook = {
  key: 'agents.owner',
  async plan(tx, membershipId) {
    const r = await tx.db
      .selectFrom('agents.agent_profile')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('owner_membership_id', '=', membershipId)
      .where('lifecycle_state', '<>', 'purged')
      .executeTakeFirstOrThrow();
    return { hook: 'agents.owner', owned: Number(r.n), requiresAssignee: false };
  },
  async apply(tx, from) {
    const r = await tx.db
      .updateTable('agents.agent_profile')
      .set({
        state: 'suspended',
        suspended_reason: 'owner_departed',
        suspended_at: new Date(),
        updated_at: new Date(),
        version: sql`version + 1`,
      })
      .where('owner_membership_id', '=', from)
      .where('state', '<>', 'suspended')
      .returning('id')
      .execute();
    return r.length;
  },
};
