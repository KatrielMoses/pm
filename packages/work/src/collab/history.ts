import { newUuidV7 } from '@pm/contracts';
import type { WorkspaceTransaction } from '@pm/db';

/**
 * Assignment history (COL-014, COL-015; ADR-0023 D8): an append-only fact for every change of who
 * is responsible for a task. A change that removes one person and adds another is one
 * `reassigned` fact; any other change is one `assigned` or `unassigned` fact per person. The
 * rows name memberships only: who may see them is decided when the history is read.
 */
export async function recordAssignmentChange(
  tx: WorkspaceTransaction,
  change: {
    taskId: string;
    actorMembershipId: string;
    via: 'assign' | 'departure';
    before: readonly string[];
    after: readonly string[];
  },
): Promise<number> {
  const before = new Set(change.before);
  const after = new Set(change.after);
  const removed = [...before].filter((x) => !after.has(x));
  const added = [...after].filter((x) => !before.has(x));
  const rows: Array<{
    kind: 'assigned' | 'unassigned' | 'reassigned';
    from: string | null;
    to: string | null;
  }> = [];
  if (removed.length === 1 && added.length === 1)
    rows.push({ kind: 'reassigned', from: removed[0]!, to: added[0]! });
  else {
    for (const r of removed) rows.push({ kind: 'unassigned', from: r, to: null });
    for (const a of added) rows.push({ kind: 'assigned', from: null, to: a });
  }
  for (const r of rows)
    await tx.db
      .insertInto('collab.assignment_event')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        task_id: change.taskId,
        kind: r.kind,
        via: change.via,
        from_membership_id: r.from,
        to_membership_id: r.to,
        actor_membership_id: change.actorMembershipId,
      })
      .execute();
  return rows.length;
}
