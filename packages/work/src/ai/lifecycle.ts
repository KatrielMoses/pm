import { newUuidV7 } from '@pm/contracts';
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
  filter: { membershipId?: string; before?: Date; operationIds?: readonly string[] },
): Promise<number> {
  // 7F (Phase 7 integration): named runs, when the capture they were made from is purged.
  if (filter.operationIds && !filter.operationIds.length) return 0;
  let q = tx.db
    .selectFrom('ai.ai_action')
    .select('operation_id')
    .where('content_state', '=', 'present');
  if (filter.membershipId) q = q.where('initiating_membership_id', '=', filter.membershipId);
  if (filter.before) q = q.where('created_at', '<', filter.before);
  if (filter.operationIds) q = q.where('operation_id', 'in', filter.operationIds);
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
  if (filter.operationIds) stale = stale.where('operation_id', 'in', filter.operationIds);
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
  // 7D: a proposal's content (title, reason, proposed values) is erased with its run, and an
  // approval that has not been used can no longer be. Applied records are ordinary domain records
  // and stay; the reference-only history and application outcome stay as accountability facts.
  const proposals = await tx.db
    .selectFrom('ai.change_proposal')
    .select(['id', 'revision', 'fingerprint'])
    .where('operation_id', 'in', ids)
    .where('content_state', '=', 'present')
    .execute();
  if (proposals.length) {
    const pids = proposals.map((r) => r.id);
    const now = new Date();
    await tx.db
      .updateTable('ai.proposed_change')
      .set({ payload: null, updated_at: now })
      .where('proposal_id', 'in', pids)
      .execute();
    await tx.db
      .updateTable('ai.proposal_approval')
      .set({ state: 'revoked' })
      .where('proposal_id', 'in', pids)
      .where('state', '=', 'active')
      .execute();
    await tx.db
      .updateTable('ai.change_proposal')
      .set({
        title: null,
        reject_reason: null,
        assumptions: null,
        content_state: 'erased',
        content_erased_at: now,
        updated_at: now,
        version: sql`version + 1`,
      })
      .where('id', 'in', pids)
      .execute();
    await tx.db
      .insertInto('ai.proposal_event')
      .values(
        proposals.map((r) => ({
          id: newUuidV7(),
          workspace_id: tx.workspaceId,
          proposal_id: r.id,
          revision: r.revision,
          kind: 'erased' as const,
          actor_membership_id: null,
          change_keys: [],
          fingerprint: r.fingerprint,
        })),
      )
      .execute();
  }
  await tx.db
    .updateTable('ai.ai_action')
    .set({ prompt_text: null, content_state: 'erased', content_erased_at: new Date() })
    .where('operation_id', 'in', ids)
    .execute();
  return ids.length;
}

/**
 * 7E (ADR-0042 D10): briefing content lifecycle. Statement text, figures, references, and
 * coverage are content of the recipient; correction text too. A departure (or account erasure)
 * erases both and stops the person's schedules; technical retention erases briefing content and
 * the notes on it that are not approved memory (approved notes are re-checked against their own
 * evidence on every use). Briefing, schedule, and correction rows stay as
 * reference-only facts with their operations and audit; business records are never touched.
 */
export async function eraseBriefingRows(
  tx: WorkspaceTransaction,
  filter: { membershipId?: string; before?: Date },
): Promise<number> {
  const now = new Date();
  let q = tx.db.selectFrom('ai.briefing').select('id').where('content_state', '=', 'present');
  if (filter.membershipId) q = q.where('recipient_membership_id', '=', filter.membershipId);
  if (filter.before) q = q.where('created_at', '<', filter.before);
  const ids = (await q.limit(1000).execute()).map((r) => r.id);
  if (ids.length) {
    await tx.db
      .updateTable('ai.briefing_statement')
      .set({ text: null, refs: '[]', figures: null })
      .where('briefing_id', 'in', ids)
      .execute();
    await tx.db
      .updateTable('ai.briefing')
      .set({
        coverage: null,
        content_state: 'erased',
        content_erased_at: now,
        updated_at: now,
        version: sql`version + 1`,
      })
      .where('id', 'in', ids)
      .execute();
  }
  // Retention (corrective review 01 R3): notes that are not approved memory go with the briefing
  // content they were made on, so its erased text cannot be recovered through them. Approved notes
  // stay under their own evidence (R2) until departure or account erasure.
  let notesErased = 0;
  if (ids.length && !filter.membershipId) {
    const dead = await tx.db
      .selectFrom('ai.briefing_correction')
      .select(['id', 'revision'])
      .where('origin_briefing_id', 'in', ids)
      .where('state', 'not in', ['approved', 'erased'])
      .execute();
    if (dead.length) {
      await tx.db
        .updateTable('ai.briefing_correction')
        .set({ text: null, state: 'erased', updated_at: now, version: sql`version + 1` })
        .where(
          'id',
          'in',
          dead.map((n) => n.id),
        )
        .execute();
      await tx.db
        .insertInto('ai.briefing_correction_event')
        .values(
          dead.map((n) => ({
            id: newUuidV7(),
            workspace_id: tx.workspaceId,
            correction_id: n.id,
            kind: 'erased' as const,
            revision: n.revision,
            actor_membership_id: null,
          })),
        )
        .execute();
      notesErased = dead.length;
    }
  }
  if (filter.membershipId) {
    await tx.db
      .updateTable('ai.briefing_schedule')
      .set({ enabled: false, next_run_at: null, updated_at: now, version: sql`version + 1` })
      .where('membership_id', '=', filter.membershipId)
      .where('enabled', '=', true)
      .execute();
    const notes = await tx.db
      .selectFrom('ai.briefing_correction')
      .select(['id', 'revision'])
      .where('recipient_membership_id', '=', filter.membershipId)
      .where('state', '<>', 'erased')
      .limit(1000)
      .execute();
    if (notes.length) {
      await tx.db
        .updateTable('ai.briefing_correction')
        .set({ text: null, state: 'erased', updated_at: now, version: sql`version + 1` })
        .where(
          'id',
          'in',
          notes.map((n) => n.id),
        )
        .execute();
      await tx.db
        .insertInto('ai.briefing_correction_event')
        .values(
          notes.map((n) => ({
            id: newUuidV7(),
            workspace_id: tx.workspaceId,
            correction_id: n.id,
            kind: 'erased' as const,
            revision: n.revision,
            actor_membership_id: null,
          })),
        )
        .execute();
    }
    return ids.length + notes.length;
  }
  return ids.length + notesErased;
}

/**
 * 7F (ADR-0043 D9): planner proposals are personal assistance content like AI proposals: their
 * title, plan (day facts, deferrals, reasons), and proposed values are erased on departure,
 * account erasure, and configured retention; unused approvals are revoked. Applied blocks and
 * commitments are ordinary planning records and stay; references and outcomes stay.
 */
export async function erasePlanProposals(
  tx: WorkspaceTransaction,
  filter: { membershipId?: string; before?: Date },
): Promise<number> {
  let q = tx.db
    .selectFrom('ai.change_proposal')
    .select(['id', 'revision', 'fingerprint'])
    .where('origin', '=', 'planner')
    .where('content_state', '=', 'present');
  if (filter.membershipId) q = q.where('initiating_membership_id', '=', filter.membershipId);
  if (filter.before) q = q.where('created_at', '<', filter.before);
  const rows = await q.limit(1000).execute();
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const now = new Date();
  await tx.db
    .updateTable('ai.proposed_change')
    .set({ payload: null, updated_at: now })
    .where('proposal_id', 'in', ids)
    .execute();
  await tx.db
    .updateTable('ai.proposal_approval')
    .set({ state: 'revoked' })
    .where('proposal_id', 'in', ids)
    .where('state', '=', 'active')
    .execute();
  await tx.db
    .updateTable('ai.change_proposal')
    .set({
      title: null,
      reject_reason: null,
      assumptions: null,
      plan: null,
      content_state: 'erased',
      content_erased_at: now,
      updated_at: now,
      version: sql`version + 1`,
    })
    .where('id', 'in', ids)
    .execute();
  await tx.db
    .insertInto('ai.proposal_event')
    .values(
      rows.map((r) => ({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        proposal_id: r.id,
        revision: r.revision,
        kind: 'erased' as const,
        actor_membership_id: null,
        change_keys: [],
        fingerprint: r.fingerprint,
      })),
    )
    .execute();
  return rows.length;
}

/**
 * 7F: a leaver's open recordings end now (uploaded or transcribing becomes cancelled) and every
 * recording that still names its audio is due at once, so the registered cleanup sweep deletes the
 * object. Departure, account erasure, and the service eraser all call this one function.
 */
export async function endVoiceCaptures(tx: WorkspaceTransaction, membershipId: string) {
  const now = new Date();
  const r = await tx.db
    .updateTable('capture.voice_capture')
    .set({
      state: sql`CASE WHEN state IN ('uploaded', 'transcribing') THEN 'cancelled' ELSE state END`,
      expires_at: now,
      updated_at: now,
    })
    .where('membership_id', '=', membershipId)
    .where('storage_key', 'is not', null)
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
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
    let total = await endVoiceCaptures(tx, from);
    for (;;) {
      const n = await eraseAiContentRows(tx, { membershipId: from });
      total += n;
      if (n < 1000) break;
    }
    for (;;) {
      const n = await eraseBriefingRows(tx, { membershipId: from });
      total += n;
      if (n < 1000) break;
    }
    for (;;) {
      const n = await erasePlanProposals(tx, { membershipId: from });
      total += n;
      if (n < 1000) return total;
    }
  },
};

/** Personal-data erasure (account deletion and departure retention): the member's AI content. */
export const aiPersonalDataEraser: PersonalDataEraser = {
  module: 'ai',
  async eraseMembership(tx, membershipId) {
    let total = await endVoiceCaptures(tx, membershipId);
    for (;;) {
      const n = await eraseAiContentRows(tx, { membershipId });
      total += n;
      if (n < 1000) break;
    }
    for (;;) {
      const n = await eraseBriefingRows(tx, { membershipId });
      total += n;
      if (n < 1000) break;
    }
    for (;;) {
      const n = await erasePlanProposals(tx, { membershipId });
      total += n;
      if (n < 1000) return total;
    }
  },
};

/** The personal-data registry with every product module's eraser registered. */
export function productPersonalDataRegistry(): PersonalDataRegistry {
  return defaultPersonalDataRegistry().register(aiPersonalDataEraser);
}
