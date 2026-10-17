import type { WorkspaceTransaction } from '@pm/db';
import type { OwnershipHook } from '@pm/tenancy';

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
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.operation_id);
  // A departed member's queued or running work stops: no further attempt may start.
  if (filter.membershipId)
    await tx.db
      .updateTable('exec.operation')
      .set({ cancel_requested_at: new Date(), updated_at: new Date() })
      .where('id', 'in', ids)
      .where('cancel_requested_at', 'is', null)
      .where('execution_state', 'in', ['queued', 'running', 'waiting', 'paused'])
      .execute();
  await tx.db
    .updateTable('ai.ai_output')
    .set({ content: null, completeness: 'erased' })
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
