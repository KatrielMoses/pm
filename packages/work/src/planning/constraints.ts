import { sql, type WorkspaceTransaction } from '@pm/db';

/**
 * 7F corrective review 01 (R1): the one lock every input of a person's daily plan serializes on
 * (`planning.constraints:<workspace>:<member>`, transaction-scoped). Plan approval and Apply take it
 * first and hold it to commit; canonical writers of calendar mirrors, reservations, the capacity
 * profile, time off, blocks, and Today take it before their own locks, and database triggers make
 * every other writer participate (migration 0059). Lock order: this lock, then the capacity
 * profile, the day, the person's blocks, brand holidays, dependencies (shared), and task rows.
 */
export async function lockPlanConstraints(tx: WorkspaceTransaction, membershipId: string) {
  await sql`SELECT planning.lock_plan_constraints(${tx.workspaceId}::uuid, ${membershipId}::uuid)`.execute(
    tx.db,
  );
}
