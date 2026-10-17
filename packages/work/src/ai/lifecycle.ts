import { sql, type WorkspaceTransaction } from '@pm/db';
import { contextFromRow, requestJobCancel, transitionOperation } from '@pm/platform';
import {
  defaultPersonalDataRegistry,
  type OwnershipHook,
  type PersonalDataEraser,
  type PersonalDataRegistry,
} from '@pm/tenancy';

/**
 * AI history content lifecycle (ADR-0038 A10). AI content (the redacted prompt, generated output,
 * and context references) is personal to its initiator: no role or grant reaches it. It is erased
 * when the initiator departs (personal-scope data, OD-39 safe default) or when it is older than the
 * technical retention setting (OD-36 undecided: unset keeps it). Usage, cost, operation, and audit
 * facts remain; they are required spending and security records, not user content.
 */
export async function eraseAiContentRows(
  tx: WorkspaceTransaction,
  filter: { membershipId?: string; before?: Date },
): Promise<number> {
  let q = tx.db
    .selectFrom('ai.ai_action')
    .select('operation_id')
    .where('content_state', '=', 'present');
  if (filter.membershipId) q = q.where('initiating_membership_id', '=', filter.membershipId);
  if (filter.before) q = q.where('created_at', '<', filter.before);
  const rows = await q.limit(1000).execute();
  // Also the runs already erased whose execution checkpoints may still carry copies written before
  // corrective review 01 (the old eraser did not reach them).
  let stale = tx.db
    .selectFrom('ai.ai_action')
    .select('operation_id')
    .where('content_state', '=', 'erased');
  if (filter.membershipId)
    stale = stale.where('initiating_membership_id', '=', filter.membershipId);
  if (filter.before) stale = stale.where('created_at', '<', filter.before);
  const erasedIds = (await stale.limit(1000).execute()).map((r) => r.operation_id);
  const ids = rows.map((r) => r.operation_id);
  if (ids.length || erasedIds.length)
    await sql`SELECT ai.scrub_dispatch_checkpoints(${[...ids, ...erasedIds]}::uuid[])`.execute(
      tx.db,
    );
  if (!rows.length) return 0;
  // A departed member's queued or running work stops: no further attempt may start.
  if (filter.membershipId)
    await tx.db
      .updateTable('exec.operation')
      .set({ cancel_requested_at: new Date(), updated_at: new Date() })
      .where('id', 'in', ids)
      .where('cancel_requested_at', 'is', null)
      .where('execution_state', 'in', ['queued', 'running', 'waiting', 'paused'])
      .execute();
  // Work that has not started ends now. Departure's generic step may already have cancelled the
  // queued job; the worker never claims a cancelled job, so its operation is closed here (a run is
  // never left queued forever). Running work observes the cancel request at its next boundary.
  if (filter.membershipId) {
    const queued = await tx.db
      .selectFrom('exec.job as j')
      .innerJoin('exec.operation as o', 'o.id', 'j.operation_id')
      .selectAll('j')
      .where('j.operation_id', 'in', ids)
      .where('o.execution_state', '=', 'queued')
      .where('j.state', 'in', ['queued', 'retry_scheduled', 'cancelled'])
      .execute();
    for (const j of queued) {
      const outcome = j.state === 'cancelled' ? 'cancelled' : await requestJobCancel(tx, j.id);
      if (outcome === 'cancelled')
        await transitionOperation(tx, {
          operationId: j.operation_id!,
          to: 'cancelled',
          terminalReason: 'policy_rejected',
          actor: { type: 'system' },
          context: contextFromRow(j),
        });
    }
  }
  await tx.db
    .updateTable('ai.ai_output')
    .set({ content: null, completeness: 'erased', grounding: null })
    .where('operation_id', 'in', ids)
    .where('completeness', '<>', 'erased')
    .execute();
  await tx.db.deleteFrom('ai.ai_context_ref').where('operation_id', 'in', ids).execute();
  await tx.db
    .updateTable('ai.ai_action')
    .set({ prompt_text: null, content_state: 'erased', content_erased_at: new Date() })
    .where('operation_id', 'in', ids)
    .execute();
  return ids.length;
}

/** Departure (PERM-014): the leaver's AI content is erased; nothing needs a new owner. */
export const aiHistoryOwnerHook: OwnershipHook = {
  key: 'ai_history',
  async plan(tx, membershipId) {
    const r = await tx.db
      .selectFrom('ai.ai_action')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('initiating_membership_id', '=', membershipId)
      .where('content_state', '=', 'present')
      .executeTakeFirstOrThrow();
    return { hook: 'ai_history', owned: Number(r.n), requiresAssignee: false };
  },
  async apply(tx, from) {
    let total = 0;
    for (;;) {
      const n = await eraseAiContentRows(tx, { membershipId: from });
      total += n;
      if (n < 1000) return total;
    }
  },
};

/** Personal-data erasure (account deletion and departure retention): the member's AI content. */
export const aiPersonalDataEraser: PersonalDataEraser = {
  module: 'ai',
  async eraseMembership(tx, membershipId) {
    let total = 0;
    for (;;) {
      const n = await eraseAiContentRows(tx, { membershipId });
      total += n;
      if (n < 1000) return total;
    }
  },
};

/** The personal-data registry with every product module's eraser registered. */
export function productPersonalDataRegistry(): PersonalDataRegistry {
  return defaultPersonalDataRegistry().register(aiPersonalDataEraser);
}
