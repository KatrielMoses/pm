import { AuditWriter, change, CommandContext } from '@pm/audit';
import { newUuidV7, type ExecutionContext } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import type { OwnershipHook } from '@pm/tenancy';
import { settleReview, type ReviewOutcome, type ReviewRule } from './semantics.ts';

/**
 * Departure (0C §11.5, ADR-0023 D7): a departing member's open review requests close, and they
 * leave the reviewer lists of requests they had not decided. A request left with no reviewer
 * closes as `reviewer_departed`; under the `all` rule, one whose remaining reviewers have all
 * approved settles. Decisions already made are history and stay. Nothing needs a new owner. Every
 * state change is audited and announced like the commands that make the same change.
 */
function systemExec(workspaceId: string, membershipId: string): ExecutionContext {
  return {
    workspaceId,
    correlationId: newUuidV7().replace(/-/g, ''),
    authenticatedPrincipal: { type: 'system_job', id: membershipId },
    effectivePrincipal: { type: 'member', id: membershipId },
    initiatingMembershipId: membershipId,
    delegationChain: [
      { type: 'member', id: membershipId },
      { type: 'system_job', id: membershipId },
    ],
    epochs: { workspace: 0, principal: 0 },
    dataClassLimit: 'C2',
  } as ExecutionContext;
}

interface Closing {
  id: string;
  public_id: string;
  version: string | number;
  state: string;
  subject_id: string;
  subject_public: string;
  subject_type: string;
  brand_id: string | null;
}

async function record(
  tx: WorkspaceTransaction,
  writer: AuditWriter,
  from: string,
  q: Closing,
  next: 'withdrawn' | ReviewOutcome,
  reason: string,
): Promise<void> {
  const exec = systemExec(tx.workspaceId, from);
  await writer.write(
    tx,
    CommandContext.fromExecution(exec, { kind: 'automation' }, { brandId: q.brand_id }),
    {
      action: next === 'withdrawn' ? 'review.withdrawn' : 'review.decided',
      target: { recordId: q.subject_id, type: q.subject_type, publicId: q.subject_public },
      changes: [
        change.plain('review', q.public_id, next === 'withdrawn' ? null : q.public_id),
        change.plain('review_state', q.state, next),
        change.plain('reason', null, reason),
      ],
    },
  );
  const base = {
    aggregate: { type: 'collab.review_request', id: q.id, sequence: Number(q.version) + 1 },
    actor: { type: 'system' as const, id: from },
    context: exec,
    ...(q.brand_id ? { brandId: q.brand_id } : {}),
  };
  if (next === 'withdrawn')
    await writeOutboxEvent(tx, {
      ...base,
      type: 'collab.review.withdrawn',
      data: { subject_kind: q.subject_type, subject_ref: q.subject_id, reason },
    });
  else
    await writeOutboxEvent(tx, {
      ...base,
      type: 'collab.review.decided',
      data: { decision: next, self_approval: false, subject_ref: q.subject_id, review_state: next },
    });
}

const closing = (tx: WorkspaceTransaction, ids: readonly string[]) =>
  ids.length
    ? sql<Closing>`SELECT q.id, q.public_id, q.version, q.state, q.subject_record_id AS subject_id,
              r.public_id AS subject_public, q.subject_kind AS subject_type, r.brand_id
         FROM collab.review_request q
         JOIN core.record r ON r.workspace_id = q.workspace_id AND r.id = q.subject_record_id
        WHERE q.id = ANY(${[...ids]}::uuid[])`
        .execute(tx.db)
        .then((x) => x.rows)
    : Promise.resolve([] as Closing[]);

export function reviewDepartureHook(writer: AuditWriter): OwnershipHook {
  return {
    key: 'review_requests',
    async plan(tx, membershipId) {
      const r = await sql<{ n: string }>`
        SELECT (
          (SELECT count(*) FROM collab.review_request q WHERE q.requested_by_membership_id = ${membershipId} AND q.state = 'requested')
        + (SELECT count(*) FROM collab.review_reviewer rv JOIN collab.review_request q
             ON q.workspace_id = rv.workspace_id AND q.id = rv.review_request_id
            WHERE rv.membership_id = ${membershipId} AND q.state = 'requested'
              AND NOT EXISTS (SELECT 1 FROM collab.review_decision d WHERE d.workspace_id = rv.workspace_id
                AND d.review_request_id = rv.review_request_id AND d.reviewer_membership_id = rv.membership_id))
        )::text AS n`.execute(tx.db);
      return { hook: 'review_requests', owned: Number(r.rows[0]?.n ?? 0), requiresAssignee: false };
    },
    async apply(tx, from) {
      let n = 0;
      const own = await tx.db
        .updateTable('collab.review_request')
        .set({
          state: 'withdrawn',
          closed_reason: 'requester_departed',
          settled_at: new Date(),
          updated_at: new Date(),
          version: sql`version + 1`,
        })
        .where('requested_by_membership_id', '=', from)
        .where('state', '=', 'requested')
        .returning(['id', 'version'])
        .execute();
      for (const q of await closing(
        tx,
        own.map((x) => x.id),
      ))
        await record(
          tx,
          writer,
          from,
          { ...q, version: Number(q.version) - 1, state: 'requested' },
          'withdrawn',
          'requester_departed',
        );
      n += own.length;
      const pending = await sql<{ id: string; rule: ReviewRule }>`
        SELECT q.id, q.rule FROM collab.review_request q
          JOIN collab.review_reviewer rv ON rv.workspace_id = q.workspace_id AND rv.review_request_id = q.id
         WHERE rv.membership_id = ${from} AND q.state = 'requested'
           AND NOT EXISTS (SELECT 1 FROM collab.review_decision d WHERE d.workspace_id = rv.workspace_id
             AND d.review_request_id = rv.review_request_id AND d.reviewer_membership_id = rv.membership_id)
         ORDER BY q.id FOR UPDATE OF q`.execute(tx.db);
      for (const q of pending.rows) {
        await tx.db
          .deleteFrom('collab.review_reviewer')
          .where('review_request_id', '=', q.id)
          .where('membership_id', '=', from)
          .execute();
        const left = await tx.db
          .selectFrom('collab.review_reviewer')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('review_request_id', '=', q.id)
          .executeTakeFirstOrThrow();
        const decisions = (
          await tx.db
            .selectFrom('collab.review_decision')
            .select('outcome')
            .where('review_request_id', '=', q.id)
            .orderBy('decided_at')
            .orderBy('id')
            .execute()
        ).map((d) => ({ outcome: d.outcome as ReviewOutcome }));
        const count = Number(left.n);
        const next = count === 0 ? 'withdrawn' : settleReview(q.rule, count, decisions);
        if (next === 'requested') continue;
        const [row] = await closing(tx, [q.id]);
        await tx.db
          .updateTable('collab.review_request')
          .set({
            state: next,
            ...(next === 'withdrawn' ? { closed_reason: 'reviewer_departed' as const } : {}),
            settled_at: new Date(),
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('id', '=', q.id)
          .execute();
        await record(tx, writer, from, row!, next, 'reviewer_departed');
        n += 1;
      }
      return n;
    },
  };
}
