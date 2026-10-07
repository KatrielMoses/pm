import { sql } from '@pm/db';
import type { OwnershipHook } from '@pm/tenancy';
import { settleReview, type ReviewOutcome, type ReviewRule } from './semantics.ts';

/**
 * Departure (0C §11.5, ADR-0023 D7): a departing member's open review requests close, and they
 * leave the reviewer lists of requests they had not decided. A request left with no reviewer
 * closes as `reviewer_departed`; under the `all` rule, one whose remaining reviewers have all
 * approved settles. Decisions already made are history and stay. Nothing needs a new owner.
 */
export const reviewDepartureHook: OwnershipHook = {
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
      .executeTakeFirst();
    n += Number(own.numUpdatedRows);
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
      const next = count === 0 ? 'requested' : settleReview(q.rule, count, decisions);
      if (count === 0)
        await tx.db
          .updateTable('collab.review_request')
          .set({
            state: 'withdrawn',
            closed_reason: 'reviewer_departed',
            settled_at: new Date(),
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('id', '=', q.id)
          .execute();
      else if (next !== 'requested')
        await tx.db
          .updateTable('collab.review_request')
          .set({ state: next, settled_at: new Date(), updated_at: new Date(), version: sql`version + 1` })
          .where('id', '=', q.id)
          .execute();
      n += 1;
    }
    return n;
  },
};
