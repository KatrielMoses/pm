import { newUuidV7 } from '@pm/contracts';
import { sql } from '@pm/db';
import type { OwnershipHook } from '@pm/tenancy';
import { recordAssignmentChange } from './collab/history.ts';

/**
 * Departure (0C §11.5, PERM-014, AZ-21): a departing member's accountable project ownership, phase
 * and milestone ownership, decision ownership, and recurrence series move to the chosen member, and
 * every active project where they held an explicit manage grant hands that grant to the same member
 * so no project is left without an eligible manager (the deferred database guard holds at commit).
 */
export const projectOwnerHook: OwnershipHook = {
  key: 'project_owner',
  async plan(tx, membershipId) {
    const r = await sql<{ n: string }>`
      SELECT (
        (SELECT count(*) FROM work.project WHERE owner_membership_id = ${membershipId} AND lifecycle_state <> 'purged')
      + (SELECT count(*) FROM work.phase WHERE owner_membership_id = ${membershipId})
      + (SELECT count(*) FROM work.milestone WHERE owner_membership_id = ${membershipId})
      + (SELECT count(*) FROM work.decision_record WHERE owner_membership_id = ${membershipId})
      + (SELECT count(*) FROM planning.recurrence_series WHERE owner_membership_id = ${membershipId})
      + (SELECT count(*) FROM access.role_assignment ra JOIN work.project p ON p.id = ra.scope_id
          WHERE ra.membership_principal_id = ${membershipId} AND ra.scope_type = 'project' AND p.lifecycle_state = 'active')
      )::text AS n`.execute(tx.db);
    const owned = Number(r.rows[0]?.n ?? 0);
    return { hook: 'project_owner', owned, requiresAssignee: owned > 0 };
  },
  async apply(tx, from, to) {
    if (to === null) return 0;
    let n = 0;
    const managed = await tx.db
      .selectFrom('access.role_assignment as ra')
      .innerJoin('access.role as r', 'r.id', 'ra.role_id')
      .innerJoin('work.project as p', 'p.id', 'ra.scope_id')
      .select('ra.scope_id')
      .where('ra.membership_principal_id', '=', from)
      .where('ra.scope_type', '=', 'project')
      .where('r.key', '=', 'scope_manage')
      .where('p.lifecycle_state', '<>', 'purged')
      .execute();
    const owned = await tx.db
      .selectFrom('work.project')
      .select('id')
      .where('owner_membership_id', '=', from)
      .where('lifecycle_state', '<>', 'purged')
      .execute();
    const role = await tx.db
      .selectFrom('access.role')
      .select('id')
      .where('key', '=', 'scope_manage')
      .executeTakeFirstOrThrow();
    for (const projectId of new Set([
      ...managed.map((m) => m.scope_id),
      ...owned.map((o) => o.id),
    ])) {
      const has = await tx.db
        .selectFrom('access.role_assignment')
        .select(['id', 'role_id'])
        .where('membership_principal_id', '=', to)
        .where('project_scope_id', '=', projectId)
        .executeTakeFirst();
      if (has?.role_id === role.id) continue;
      if (has)
        await tx.db
          .updateTable('access.role_assignment')
          .set({ role_id: role.id, version: sql`version + 1` })
          .where('id', '=', has.id)
          .execute();
      else
        await tx.db
          .insertInto('access.role_assignment')
          .values({
            id: newUuidV7(),
            workspace_id: tx.workspaceId,
            principal_type: 'membership',
            principal_id: to,
            scope_type: 'project',
            scope_id: projectId,
            role_id: role.id,
            role_kind: 'scope_level',
            grant_source: 'project_manager',
            granted_by_membership_id: from,
          })
          .execute();
      n++;
    }
    for (const table of [
      'work.project',
      'work.phase',
      'work.milestone',
      'work.decision_record',
    ] as const) {
      const r = await tx.db
        .updateTable(table)
        .set({ owner_membership_id: to, version: sql`version + 1` } as never)
        .where('owner_membership_id', '=', from)
        .executeTakeFirst();
      n += Number(r.numUpdatedRows);
    }
    const s = await tx.db
      .updateTable('planning.recurrence_series')
      .set({ owner_membership_id: to, version: sql`version + 1` } as never)
      .where('owner_membership_id', '=', from)
      .executeTakeFirst();
    return n + Number(s.numUpdatedRows);
  },
};

/**
 * Departure (AZ-22): assignments are responsibility of active members only, so a departing
 * member's assignments end (never transferred: responsibility is chosen, not inherited). The
 * deferred database guard refuses a removal that leaves any assignment behind.
 */
export const taskAssigneeHook: OwnershipHook = {
  key: 'task_assignee',
  async plan(tx, membershipId) {
    const r = await tx.db
      .selectFrom('work.task_assignee')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('membership_id', '=', membershipId)
      .executeTakeFirstOrThrow();
    return { hook: 'task_assignee', owned: Number(r.n), requiresAssignee: false };
  },
  async apply(tx, from) {
    // The departure is recorded as the member's own `unassigned` fact on each task (4A history).
    const tasks = await tx.db
      .selectFrom('work.task_assignee')
      .select('task_id')
      .where('membership_id', '=', from)
      .execute();
    for (const t of tasks)
      await recordAssignmentChange(tx, {
        taskId: t.task_id,
        actorMembershipId: from,
        via: 'departure',
        before: [from],
        after: [],
      });
    const r = await tx.db
      .deleteFrom('work.task_assignee')
      .where('membership_id', '=', from)
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  },
};
