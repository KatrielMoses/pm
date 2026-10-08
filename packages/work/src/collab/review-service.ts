import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  invalid,
  issue,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { cursorAt, hashText, CommentService, type CollabHost } from './comment-service.ts';
import { isPublic } from '../validation.ts';
import {
  settleReview,
  type ReviewOutcome,
  type ReviewRule,
  type ReviewState,
} from './semantics.ts';
import {
  parseCursorQuery,
  parseDecision,
  parseDelegate,
  parseRefresh,
  parseReviewRequest,
  parseWithdraw,
  type ReviewRequestInput,
} from './validation.ts';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

interface ReviewRow {
  id: string;
  public_id: string;
  subject_record_id: string;
  subject_kind: 'task' | 'project' | 'deliverable';
  subject_version: number;
  kind: 'review' | 'approval';
  rule: ReviewRule;
  state: ReviewState;
  requested_by_membership_id: string;
  message_text: string | null;
  previous_request_id: string | null;
  closed_reason: string | null;
  settled_at: Date | null;
  created_at: Date;
  version: number;
  subject_public: string;
  cursor_at?: string;
}

/**
 * Phase 4A review requests, approvals, delegation, and assignment history (ADR-0023 D7–D8; 0C
 * AZ-31; COL-013 to COL-015, TSK-029, TSK-030). A request names one record at one version and its
 * reviewers; each reviewer's decision is immutable and typed, bound to the version they reviewed,
 * and evaluated against their authority at the moment they decide. Nothing here changes the
 * record's status: workflow transition approvals (2C) stay the gate for status changes.
 */
export class ReviewService extends CommentService {
  // ---------------------------------------------------------------------------------------------
  // Rows and views
  // ---------------------------------------------------------------------------------------------

  protected async reviewRow(
    tx: WorkspaceTransaction,
    publicId: unknown,
    opts: { lock?: boolean } = {},
  ): Promise<ReviewRow | undefined> {
    if (!isPublic(publicId, 'rvw')) return undefined;
    let q = tx.db
      .selectFrom('collab.review_request as q')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'q.workspace_id').onRef('r.id', '=', 'q.subject_record_id'),
      )
      .select([
        'q.id',
        'q.public_id',
        'q.subject_record_id',
        'q.subject_kind',
        'q.subject_version',
        'q.kind',
        'q.rule',
        'q.state',
        'q.requested_by_membership_id',
        'q.message_text',
        'q.previous_request_id',
        'q.closed_reason',
        'q.settled_at',
        'q.created_at',
        'q.version',
        'r.public_id as subject_public',
      ])
      .where('q.public_id', '=', publicId);
    if (opts.lock) q = q.forUpdate('q');
    const row = await q.executeTakeFirst();
    return row
      ? ({
          ...row,
          subject_version: Number(row.subject_version),
          version: Number(row.version),
        } as ReviewRow)
      : undefined;
  }

  /**
   * A review as the caller may see it: through the subject record (ownership), or because the
   * caller is a named reviewer or the requester. Everything else is `not_found`.
   */
  protected async loadReview(
    tx: WorkspaceTransaction,
    p: Principal,
    rvw: unknown,
    opts: { lock?: boolean } = {},
  ) {
    const row = await this.reviewRow(tx, rvw, opts);
    if (!row) {
      await this.loadTask(tx, p, `tsk_${'0'.repeat(26)}`).catch(() => undefined);
      throw new TenancyError('not_found');
    }
    const host = await this.loadHost(tx, p, row.subject_public);
    const reviewers = await this.reviewerRows(tx, row.id);
    const involved =
      row.requested_by_membership_id === p.membershipId ||
      reviewers.some((r) => r.membership_id === p.membershipId);
    if (host.ownLevel === null && !involved) throw new TenancyError('not_found');
    return { row, host, reviewers };
  }

  protected async reviewerRows(tx: WorkspaceTransaction, requestId: string) {
    return sql<{
      membership_id: string;
      public_id: string;
      state: string;
      name: string;
      rank: number;
      outcome: ReviewOutcome | null;
      note_text: string | null;
      self_approval: boolean | null;
      decision_version: string | null;
      decided_at: Date | null;
      decision_id: string | null;
    }>`SELECT rv.membership_id, m.public_id, m.state, rv.rank,
              coalesce(m.display_name_override, a.display_name) AS name,
              d.outcome, d.note_text, d.self_approval, d.subject_version AS decision_version,
              d.decided_at, d.id AS decision_id
         FROM collab.review_reviewer rv
         JOIN tenancy.membership m ON m.workspace_id = rv.workspace_id AND m.id = rv.membership_id
         JOIN identity.account a ON a.id = m.account_id
         LEFT JOIN collab.review_decision d ON d.workspace_id = rv.workspace_id
          AND d.review_request_id = rv.review_request_id AND d.reviewer_membership_id = rv.membership_id
        WHERE rv.workspace_id = ${tx.workspaceId} AND rv.review_request_id = ${requestId}
        ORDER BY rv.rank`
      .execute(tx.db)
      .then((r) => r.rows);
  }

  protected async currentVersion(tx: WorkspaceTransaction, subject: string): Promise<number> {
    const r = await sql<{ version: string }>`
      SELECT COALESCE(t.version, w.version) AS version FROM core.record r
        LEFT JOIN work.task t ON t.workspace_id = r.workspace_id AND t.id = r.id
        LEFT JOIN work.project w ON w.workspace_id = r.workspace_id AND w.id = r.id
       WHERE r.id = ${subject}`.execute(tx.db);
    return Number(r.rows[0]?.version ?? 0);
  }

  protected async reviewView(
    tx: WorkspaceTransaction,
    p: Principal,
    host: CollabHost,
    row: ReviewRow,
    reviewers?: Awaited<ReturnType<ReviewService['reviewerRows']>>,
  ) {
    const rs = reviewers ?? (await this.reviewerRows(tx, row.id));
    const requester = await tx.db
      .selectFrom('tenancy.membership as m')
      .innerJoin('identity.account as a', 'a.id', 'm.account_id')
      .select(['m.public_id', 'm.display_name_override', 'a.display_name'])
      .where('m.id', '=', row.requested_by_membership_id)
      .executeTakeFirst();
    const previous = row.previous_request_id
      ? await tx.db
          .selectFrom('collab.review_request')
          .select('public_id')
          .where('id', '=', row.previous_request_id)
          .executeTakeFirst()
      : undefined;
    const open = row.state === 'requested';
    const mineReviewer = rs.find((r) => r.membership_id === p.membershipId);
    const stale = host.version !== row.subject_version;
    const isRequester = row.requested_by_membership_id === p.membershipId;
    const people = p.kind === 'member';
    const canDecide =
      open &&
      !!mineReviewer &&
      mineReviewer.outcome === null &&
      !stale &&
      host.allows('review.decide') &&
      (!isRequester || (await this.selfDecisionAllowed(tx, p)));
    return {
      id: row.public_id,
      type: 'review_request' as const,
      subject: { id: host.publicId, type: host.kind, title: host.title },
      subject_version: row.subject_version,
      current_version: host.version,
      stale,
      kind: row.kind,
      rule: row.rule,
      state: row.state,
      requested_by:
        people && requester
          ? {
              id: requester.public_id,
              name: requester.display_name_override ?? requester.display_name,
            }
          : null,
      message: row.message_text,
      reviewers: rs.map((r) => ({
        member: people ? { id: r.public_id, name: r.name } : null,
        mine: r.membership_id === p.membershipId,
        decision: r.outcome
          ? {
              outcome: r.outcome,
              note: r.note_text,
              self_approval: !!r.self_approval,
              subject_version: Number(r.decision_version),
              at: iso(r.decided_at),
            }
          : null,
      })),
      previous: previous?.public_id ?? null,
      closed_reason: row.closed_reason,
      settled_at: iso(row.settled_at),
      created_at: iso(row.created_at)!,
      version: row.version,
      capabilities: {
        decide: canDecide,
        withdraw:
          open && (isRequester || host.allows('comment.moderate')) && host.ownLevel !== null,
        refresh:
          isRequester &&
          (row.state === 'requested' ||
            row.state === 'changes_requested' ||
            row.state === 'rejected') &&
          host.lifecycleState === 'active',
      },
    };
  }

  /** OD-20 for reviews: the workspace's `self_approval_mode`, and no independence requirement. */
  protected async selfDecisionAllowed(tx: WorkspaceTransaction, p: Principal): Promise<boolean> {
    if (p.kind !== 'member') return false;
    const required = (p.policy as Record<string, unknown>).require_independent_for;
    if (
      Array.isArray(required) &&
      required.some((x) => x === 'review.decide' || x === 'review.self_approve' || x === 'R2')
    )
      return false;
    return this.selfApprovalAllowed(tx, p);
  }

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  /** `GET /records/{id}/reviews`: the record's reviews, newest first (ownership readers). */
  async listReviews(caller: Caller, ws: unknown, rec: unknown, query: Record<string, unknown>) {
    const q = parseCursorQuery(query, []);
    return this.tracked('collab.reviews', 'list', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const host = await this.loadHost(tx, p, rec);
        const limit = this.pageLimit(q.limit);
        const fp = this.cursorFp('reviews', host.id);
        const after = q.cursor !== undefined ? this.openCursor(p, fp, q.cursor) : null;
        // Reviews are context a share does not carry: a share-only reader sees only the requests
        // they take part in.
        const rows = (
          await sql<ReviewRow>`
            SELECT q.id, q.public_id, q.subject_record_id, q.subject_kind, q.subject_version, q.kind,
                   q.rule, q.state, q.requested_by_membership_id, q.message_text, q.previous_request_id,
                   q.closed_reason, q.settled_at, q.created_at, q.version, ${host.publicId}::text AS subject_public,
                   ${cursorAt('q.created_at')} AS cursor_at
              FROM collab.review_request q
             WHERE q.workspace_id = ${tx.workspaceId} AND q.subject_record_id = ${host.id}
               ${
                 host.ownLevel === null
                   ? sql`AND (q.requested_by_membership_id = ${p.membershipId} OR EXISTS (
                      SELECT 1 FROM collab.review_reviewer rv WHERE rv.workspace_id = q.workspace_id
                        AND rv.review_request_id = q.id AND rv.membership_id = ${p.membershipId}))`
                   : sql``
               }
               ${after ? sql`AND (q.created_at, q.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
             ORDER BY q.created_at DESC, q.id DESC LIMIT ${limit + 1}`.execute(tx.db)
        ).rows.map((r) => ({
          ...r,
          subject_version: Number(r.subject_version),
          version: Number(r.version),
        }));
        const page = rows.slice(0, limit);
        const data = [];
        for (const r of page) data.push(await this.reviewView(tx, p, host, r));
        const last = page.at(-1);
        return {
          data,
          page: {
            limit,
            has_more: rows.length > limit,
            ...(rows.length > limit && last
              ? {
                  next_cursor: this.sealCursor(p, fp, {
                    at: last.cursor_at!,
                    id: last.id,
                  }),
                }
              : {}),
          },
        };
      }),
    );
  }

  async getReview(caller: Caller, ws: unknown, rvw: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const { row, host, reviewers } = await this.loadReview(tx, p, rvw);
      return this.reviewView(tx, p, host, row, reviewers);
    });
  }

  /**
   * `GET /me/reviews` (My Work, Reviews): requests naming the caller as reviewer (default) or
   * made by them, whose subject the caller can read now. `state` is `open` (default), `settled`,
   * or `all`.
   */
  async myReviews(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const q = parseCursorQuery(query, ['role', 'state']);
    const role = q.role === undefined ? 'reviewer' : q.role;
    const state = q.state === undefined ? 'open' : q.state;
    if (role !== 'reviewer' && role !== 'requester')
      throw invalid(
        issue('/role', 'invalid_option', 'Choose reviews to do or reviews you asked for.'),
      );
    if (state !== 'open' && state !== 'settled' && state !== 'all')
      throw invalid(issue('/state', 'invalid_option', 'Choose open, settled, or all.'));
    return this.tracked('collab.reviews', 'queue', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const limit = this.pageLimit(q.limit);
        const fp = this.cursorFp('my-reviews', role, state);
        const after = q.cursor !== undefined ? this.openCursor(p, fp, q.cursor) : null;
        const vis = await this.taskVisibility(tx, p, true);
        const rows = (
          await sql<
            ReviewRow & {
              title: string;
              subject_record_type: string;
              current_version: string;
              brand_id: string | null;
              my_outcome: string | null;
            }
          >`SELECT q.id, q.public_id, q.subject_record_id, q.subject_kind, q.subject_version, q.kind,
                   q.rule, q.state, q.requested_by_membership_id, q.message_text, q.previous_request_id,
                   q.closed_reason, q.settled_at, q.created_at, q.version, r.public_id AS subject_public,
                   r.record_type AS subject_record_type, r.brand_id, ${cursorAt('q.created_at')} AS cursor_at,
                   COALESCE(t.title, w.name, dl.title) AS title,
                   COALESCE(t.version, w.version, dl.version) AS current_version,
                   ${
                     role === 'reviewer'
                       ? sql`(SELECT d.outcome FROM collab.review_decision d WHERE d.workspace_id = q.workspace_id
                              AND d.review_request_id = q.id AND d.reviewer_membership_id = ${p.membershipId}) AS my_outcome`
                       : sql`NULL::text AS my_outcome`
                   }
              FROM collab.review_request q
              JOIN core.record r ON r.workspace_id = q.workspace_id AND r.id = q.subject_record_id
              LEFT JOIN work.task t ON t.workspace_id = r.workspace_id AND t.id = r.id
              LEFT JOIN work.project w ON w.workspace_id = r.workspace_id AND w.id = r.id
              -- 4E: a deliverable is reviewed through its task (title, visibility).
              LEFT JOIN files.deliverable dl ON dl.workspace_id = r.workspace_id AND dl.id = r.id
              LEFT JOIN work.task dt ON dt.workspace_id = dl.workspace_id AND dt.id = dl.task_id
              LEFT JOIN core.record dr ON dr.workspace_id = dt.workspace_id AND dr.id = dt.id
             WHERE q.workspace_id = ${tx.workspaceId}
               ${
                 role === 'reviewer'
                   ? sql`AND EXISTS (SELECT 1 FROM collab.review_reviewer rv WHERE rv.workspace_id = q.workspace_id
                        AND rv.review_request_id = q.id AND rv.membership_id = ${p.membershipId})`
                   : sql`AND q.requested_by_membership_id = ${p.membershipId}`
               }
               ${state === 'open' ? sql`AND q.state = 'requested'` : state === 'settled' ? sql`AND q.state <> 'requested'` : sql``}
               AND ((dl.id IS NULL AND ${vis.where('r', { project: sql`COALESCE(t.project_id, w.id)` })})
                 OR (dl.id IS NOT NULL AND ${vis.where('dr', { project: sql`dt.project_id` })}))
               ${after ? sql`AND (q.created_at, q.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
             ORDER BY q.created_at DESC, q.id DESC LIMIT ${limit + 1}`.execute(tx.db)
        ).rows;
        const page = rows.slice(0, limit);
        const people = new Map(
          p.kind === 'member' && page.length
            ? (
                await tx.db
                  .selectFrom('tenancy.membership as m')
                  .innerJoin('identity.account as a', 'a.id', 'm.account_id')
                  .select(['m.id', 'm.public_id', 'm.display_name_override', 'a.display_name'])
                  .where('m.id', 'in', [...new Set(page.map((r) => r.requested_by_membership_id))])
                  .execute()
              ).map((m) => [m.id, m])
            : [],
        );
        const last = page.at(-1);
        return {
          data: page.map((r) => {
            const who = people.get(r.requested_by_membership_id);
            return {
              id: r.public_id,
              type: 'review_request' as const,
              subject: { id: r.subject_public, type: r.subject_kind, title: r.title },
              kind: r.kind,
              rule: r.rule,
              state: r.state,
              stale: Number(r.current_version) !== Number(r.subject_version),
              requested_by: who
                ? { id: who.public_id, name: who.display_name_override ?? who.display_name }
                : null,
              mine_decision: r.my_outcome,
              created_at: iso(r.created_at)!,
              settled_at: iso(r.settled_at),
            };
          }),
          page: {
            limit,
            has_more: rows.length > limit,
            ...(rows.length > limit && last
              ? {
                  next_cursor: this.sealCursor(p, fp, {
                    at: last.cursor_at!,
                    id: last.id,
                  }),
                }
              : {}),
          },
        };
      }),
    );
  }

  /** The record's collaboration summary, with its latest review (4A). */
  override async collaborationSummary(caller: Caller, ws: unknown, rec: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const host = await this.loadHost(tx, p, rec);
      return this.summaryOf(tx, p, host);
    });
  }

  /** The record summary gains its latest review (ownership readers and involved people). */
  protected override async summaryOf(tx: WorkspaceTransaction, p: Principal, host: CollabHost) {
    const base = await super.summaryOf(tx, p, host);
    const row = (
      await sql<ReviewRow>`
        SELECT q.id, q.public_id, q.subject_record_id, q.subject_kind, q.subject_version, q.kind,
               q.rule, q.state, q.requested_by_membership_id, q.message_text, q.previous_request_id,
               q.closed_reason, q.settled_at, q.created_at, q.version, ${host.publicId}::text AS subject_public
          FROM collab.review_request q
         WHERE q.workspace_id = ${tx.workspaceId} AND q.subject_record_id = ${host.id}
           ${
             host.ownLevel === null
               ? sql`AND (q.requested_by_membership_id = ${p.membershipId} OR EXISTS (
                  SELECT 1 FROM collab.review_reviewer rv WHERE rv.workspace_id = q.workspace_id
                    AND rv.review_request_id = q.id AND rv.membership_id = ${p.membershipId}))`
               : sql``
           }
         ORDER BY q.created_at DESC, q.id DESC LIMIT 1`.execute(tx.db)
    ).rows[0];
    return {
      ...base,
      review: row
        ? await this.reviewView(tx, p, host, {
            ...row,
            subject_version: Number(row.subject_version),
            version: Number(row.version),
          })
        : null,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Commands: requests
  // ---------------------------------------------------------------------------------------------

  /** The reviewers a request may name: active members who can decide on the record right now. */
  protected async resolveReviewers(
    tx: WorkspaceTransaction,
    p: Principal,
    host: CollabHost,
    refs: readonly string[],
    selfOk: boolean,
  ) {
    const members = await this.activeMembers(tx, refs);
    const byPublic = new Map(members.map((m) => [m.public_id, m]));
    const out: Array<{ id: string; public_id: string }> = [];
    for (const [i, ref] of refs.entries()) {
      const m = byPublic.get(ref);
      // Unknown, departed, guest, and unable-to-read are one answer (D4's rule, applied here).
      const ok =
        !!m &&
        m.kind === 'member' &&
        (m.id !== p.membershipId || selfOk) &&
        (await this.memberReaches(
          tx,
          host,
          { id: m.id, account_id: m.account_id, kind: 'member' },
          'comment',
        ));
      if (!ok || !m)
        throw invalid(
          issue(
            `/reviewers/${i}`,
            m?.id === p.membershipId ? 'self_review' : 'not_reviewer',
            m?.id === p.membershipId
              ? "You can't review your own request here."
              : "That person can't review this.",
          ),
        );
      out.push({ id: m.id, public_id: m.public_id });
    }
    return out;
  }

  protected async insertRequest(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    host: CollabHost,
    input: ReviewRequestInput,
    reviewers: Array<{ id: string; public_id: string }>,
    previous: { id: string; public_id: string } | null,
  ) {
    const id = newUuidV7();
    const publicId = newPublicId('rvw');
    try {
      await tx.db
        .insertInto('collab.review_request')
        .values({
          id,
          public_id: publicId,
          workspace_id: tx.workspaceId,
          subject_record_id: host.id,
          subject_kind: host.kind,
          subject_version: host.version,
          kind: input.kind,
          rule: input.rule,
          requested_by_membership_id: p.membershipId,
          message_text: input.message,
          previous_request_id: previous?.id ?? null,
        })
        .execute();
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw new TenancyError('conflict', {
          issues: [issue('/', 'review_open', 'This already has a review in progress.')],
        });
      throw err;
    }
    for (const [i, r] of reviewers.entries())
      await tx.db
        .insertInto('collab.review_reviewer')
        .values({
          workspace_id: tx.workspaceId,
          review_request_id: id,
          membership_id: r.id,
          rank: i + 1,
        })
        .execute();
    await this.collabAudit(tx, caller, p, 'review.requested', host, [
      change.plain('review', null, publicId),
      change.plain('review_kind', null, input.kind),
      change.plain('review_rule', null, input.rule),
      change.plain('subject_version', null, host.version),
      change.plain('reviewers', null, reviewers.map((r) => r.public_id).join(',')),
      ...(previous ? [change.plain('previous_review', null, previous.public_id)] : []),
      ...(input.message
        ? [change.content('review_message', { hash: hashText(input.message) })]
        : []),
    ]);
    await this.workEvent(
      tx,
      caller,
      p,
      'collab.review.requested',
      { type: 'collab.review_request', id, sequence: 0 },
      {
        subject_kind: host.kind,
        subject_ref: host.id,
        reviewer_rule: input.rule,
        request_kind: input.kind,
      },
      host.brand.id,
    );
    return { id, publicId };
  }

  /**
   * Called in the same transaction when a review settles (or is withdrawn). Record types whose
   * state follows their review (4E deliverables) react here; tasks and projects do not.
   */
  protected async reviewSettled(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    host: CollabHost,
    request: { id: string },
    outcome: 'approved' | 'changes_requested' | 'rejected' | 'withdrawn',
    decisionId: string | null,
  ): Promise<void> {
    void tx;
    void caller;
    void p;
    void host;
    void request;
    void outcome;
    void decisionId;
  }

  async requestReview(caller: Caller, ws: unknown, rec: unknown, body: unknown, req: Mutation) {
    const input = parseReviewRequest(body, this.ws.reviewReviewersMax);
    return this.tracked('collab.reviews', 'request', () =>
      this.mutate(
        caller,
        'review.request',
        ws,
        req,
        async (tx, p) => {
          const host = await this.loadHost(tx, p, rec);
          // Requesting is authority over the record itself; a share does not carry it.
          host.decide('review.request', { shares: false, excluded: 'forbidden' });
          this.requireReviewable(host);
          if (input.subjectVersion !== undefined && input.subjectVersion !== host.version)
            throw this.subjectChanged(host.version);
          const open = await tx.db
            .selectFrom('collab.review_request')
            .select('id')
            .where('subject_record_id', '=', host.id)
            .where('state', '=', 'requested')
            .executeTakeFirst();
          if (open)
            throw new TenancyError('conflict', {
              issues: [issue('/', 'review_open', 'This already has a review in progress.')],
            });
          const reviewers = await this.resolveReviewers(
            tx,
            p,
            host,
            input.reviewers,
            await this.selfDecisionAllowed(tx, p),
          );
          const made = await this.insertRequest(tx, caller, p, host, input, reviewers, null);
          return {
            status: 201,
            ref: { id: made.publicId, type: 'review_request' },
            data: await this.reviewOut(tx, p, made.publicId),
          };
        },
        async (tx, p, ref) => this.reviewOut(tx, p, ref.id),
      ),
    );
  }

  protected requireReviewable(host: CollabHost): void {
    if (host.lifecycleState !== 'active')
      throw new TenancyError('conflict', {
        issues: [
          issue('/', 'record_archived', 'This is archived. Restore it to request a review.'),
        ],
      });
  }

  protected subjectChanged(current: number) {
    return new TenancyError('conflict', {
      issues: [
        issue(
          '/subject_version',
          'subject_changed',
          'This changed after the review began. Look again.',
        ),
      ],
      conflict: { current_version: current },
    });
  }

  protected async reviewOut(tx: WorkspaceTransaction, p: Principal, rvw: string) {
    const { row, host, reviewers } = await this.loadReview(tx, p, rvw);
    return this.reviewView(tx, p, host, row, reviewers);
  }

  // ---------------------------------------------------------------------------------------------
  // Commands: decisions
  // ---------------------------------------------------------------------------------------------

  /**
   * Records the caller's decision. The request is locked, so concurrent deciders are serialized:
   * the first settles it and the rest see `review_closed`. Authority, eligibility, and the version
   * are evaluated now, not when the review was requested.
   */
  async decideReview(caller: Caller, ws: unknown, rvw: unknown, body: unknown, req: Mutation) {
    const input = parseDecision(body);
    return this.tracked('collab.reviews', 'decide', () =>
      this.mutate(
        caller,
        'review.decide',
        ws,
        req,
        async (tx, p) => {
          await this.loadReview(tx, p, rvw);
          const row = (await this.reviewRow(tx, rvw, { lock: true }))!;
          const { host, reviewers } = await this.loadReview(tx, p, rvw);
          host.decide('review.decide');
          const me = reviewers.find((r) => r.membership_id === p.membershipId);
          if (!me)
            throw new TenancyError('forbidden', {
              issues: [issue('/', 'not_reviewer', "You aren't a reviewer here.")],
            });
          if (row.state !== 'requested')
            throw new TenancyError('conflict', {
              issues: [issue('/', 'review_closed', 'This review is already settled.')],
            });
          if (me.outcome !== null)
            throw new TenancyError('conflict', {
              issues: [issue('/', 'already_decided', 'You already decided this review.')],
            });
          // The decision is bound to the version the reviewer looked at, and that version must
          // still be the record's current one (the review cannot approve a changed record).
          if (input.subjectVersion !== host.version || row.subject_version !== host.version)
            throw this.subjectChanged(host.version);
          const self = row.requested_by_membership_id === p.membershipId;
          if (self && !(await this.selfDecisionAllowed(tx, p)))
            throw new TenancyError('forbidden', {
              issues: [issue('/', 'self_decision', "You can't decide your own request.")],
            });
          const decisionId = newUuidV7();
          await tx.db
            .insertInto('collab.review_decision')
            .values({
              id: decisionId,
              workspace_id: tx.workspaceId,
              review_request_id: row.id,
              reviewer_membership_id: p.membershipId,
              outcome: input.outcome,
              subject_version: input.subjectVersion,
              note_text: input.note,
              self_approval: self,
            })
            .execute();
          const decisions = (
            await tx.db
              .selectFrom('collab.review_decision')
              .select('outcome')
              .where('review_request_id', '=', row.id)
              .orderBy('decided_at')
              .orderBy('id')
              .execute()
          ).map((d) => ({ outcome: d.outcome as ReviewOutcome }));
          const next = settleReview(row.rule, reviewers.length, decisions);
          await tx.db
            .updateTable('collab.review_request')
            .set({
              state: next,
              settled_at: next === 'requested' ? null : new Date(),
              updated_at: new Date(),
              version: row.version + 1,
            })
            .where('id', '=', row.id)
            .execute();
          await this.collabAudit(tx, caller, p, 'review.decided', host, [
            change.plain('review', null, row.public_id),
            change.plain('outcome', null, input.outcome),
            change.plain('review_state', row.state, next),
            change.plain('self_approval', null, self),
            ...(input.note ? [change.content('review_note', { hash: hashText(input.note) })] : []),
          ]);
          await this.workEvent(
            tx,
            caller,
            p,
            'collab.review.decided',
            { type: 'collab.review_decision', id: decisionId, sequence: 0 },
            {
              decision: input.outcome,
              self_approval: self,
              subject_ref: host.id,
              review_state: next,
            },
            host.brand.id,
          );
          if (next !== 'requested')
            await this.reviewSettled(tx, caller, p, host, row, next, decisionId);
          return {
            status: 200,
            ref: { id: row.public_id, type: 'review_request' },
            data: await this.reviewOut(tx, p, row.public_id),
          };
        },
        async (tx, p, ref) => this.reviewOut(tx, p, ref.id),
      ),
    );
  }

  /** The requester (or a moderator) closes an open request without a decision. */
  async withdrawReview(caller: Caller, ws: unknown, rvw: unknown, body: unknown, req: Mutation) {
    parseWithdraw(body);
    return this.tracked('collab.reviews', 'withdraw', () =>
      this.mutate(
        caller,
        'review.withdraw',
        ws,
        req,
        async (tx, p) => {
          await this.loadReview(tx, p, rvw);
          const row = (await this.reviewRow(tx, rvw, { lock: true }))!;
          const { host } = await this.loadReview(tx, p, rvw);
          const requester = row.requested_by_membership_id === p.membershipId;
          if (!requester) {
            // Someone else needs authority over the record itself.
            host.decide('comment.moderate', { shares: false, excluded: 'forbidden' });
          } else host.decide('review.request', { shares: false, excluded: 'forbidden' });
          if (row.state !== 'requested')
            throw new TenancyError('conflict', {
              issues: [issue('/', 'review_closed', 'This review is already settled.')],
            });
          await tx.db
            .updateTable('collab.review_request')
            .set({
              state: 'withdrawn',
              closed_reason: 'requester',
              settled_at: new Date(),
              updated_at: new Date(),
              version: row.version + 1,
            })
            .where('id', '=', row.id)
            .execute();
          await this.collabAudit(tx, caller, p, 'review.withdrawn', host, [
            change.plain('review', row.public_id, null),
            change.plain('review_state', 'requested', 'withdrawn'),
          ]);
          await this.workEvent(
            tx,
            caller,
            p,
            'collab.review.withdrawn',
            { type: 'collab.review_request', id: row.id, sequence: row.version + 1 },
            { subject_kind: host.kind, subject_ref: host.id, reason: 'requester' },
            host.brand.id,
          );
          await this.reviewSettled(tx, caller, p, host, row, 'withdrawn', null);
          return {
            status: 200,
            ref: { id: row.public_id, type: 'review_request' },
            data: await this.reviewOut(tx, p, row.public_id),
          };
        },
        async (tx, p, ref) => this.reviewOut(tx, p, ref.id),
      ),
    );
  }

  /**
   * The requester asks again at the record's current version: the open request (if any) is
   * superseded, and a new request keeps its reviewers (or takes new ones) and links back to it.
   */
  async refreshReview(caller: Caller, ws: unknown, rvw: unknown, body: unknown, req: Mutation) {
    const override = parseRefresh(body, this.ws.reviewReviewersMax);
    return this.tracked('collab.reviews', 'refresh', () =>
      this.mutate(
        caller,
        'review.refresh',
        ws,
        req,
        async (tx, p) => {
          await this.loadReview(tx, p, rvw);
          const row = (await this.reviewRow(tx, rvw, { lock: true }))!;
          const { host, reviewers } = await this.loadReview(tx, p, rvw);
          if (row.requested_by_membership_id !== p.membershipId)
            throw new TenancyError('forbidden');
          host.decide('review.request', { shares: false, excluded: 'forbidden' });
          this.requireReviewable(host);
          if (!['requested', 'changes_requested', 'rejected'].includes(row.state))
            throw new TenancyError('conflict', {
              issues: [issue('/', 'review_closed', 'This review is already settled.')],
            });
          const later = await tx.db
            .selectFrom('collab.review_request')
            .select('id')
            .where('previous_request_id', '=', row.id)
            .executeTakeFirst();
          if (later)
            throw new TenancyError('conflict', {
              issues: [issue('/', 'review_replaced', 'This review was already asked again.')],
            });
          const selfOk = await this.selfDecisionAllowed(tx, p);
          const refs = override?.reviewers ?? reviewers.map((r) => r.public_id);
          const input: ReviewRequestInput = override ?? {
            reviewers: refs,
            rule: row.rule,
            kind: row.kind,
            message: row.message_text,
            subjectVersion: undefined,
          };
          if (input.subjectVersion !== undefined && input.subjectVersion !== host.version)
            throw this.subjectChanged(host.version);
          // Reviewers who left or lost access are dropped; the request needs at least one left.
          const keep: string[] = [];
          for (const ref of refs) {
            const m = (await this.activeMembers(tx, [ref]))[0];
            if (
              m &&
              m.kind === 'member' &&
              (m.id !== p.membershipId || selfOk) &&
              (await this.memberReaches(
                tx,
                host,
                { id: m.id, account_id: m.account_id, kind: 'member' },
                'comment',
              ))
            )
              keep.push(ref);
            else if (override) await this.resolveReviewers(tx, p, host, [ref], selfOk);
          }
          if (!keep.length)
            throw invalid(issue('/reviewers', 'required', 'Choose at least one reviewer.'));
          if (row.state === 'requested')
            await tx.db
              .updateTable('collab.review_request')
              .set({
                state: 'superseded',
                closed_reason: 'refreshed',
                settled_at: new Date(),
                updated_at: new Date(),
                version: row.version + 1,
              })
              .where('id', '=', row.id)
              .execute();
          const reviewerRows = await this.resolveReviewers(tx, p, host, keep, selfOk);
          const made = await this.insertRequest(
            tx,
            caller,
            p,
            host,
            { ...input, reviewers: keep },
            reviewerRows,
            { id: row.id, public_id: row.public_id },
          );
          if (row.state === 'requested')
            await this.workEvent(
              tx,
              caller,
              p,
              'collab.review.superseded',
              { type: 'collab.review_request', id: row.id, sequence: row.version + 1 },
              { subject_kind: host.kind, subject_ref: host.id, successor_ref: made.id },
              host.brand.id,
            );
          return {
            status: 201,
            ref: { id: made.publicId, type: 'review_request' },
            data: await this.reviewOut(tx, p, made.publicId),
          };
        },
        async (tx, p, ref) => this.reviewOut(tx, p, ref.id),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Delegation and assignment history (COL-014, COL-015)
  // ---------------------------------------------------------------------------------------------

  /**
   * An assignee hands their own assignment to another eligible member. The delegate keeps the
   * primary flag; the delegation and the person who made it are remembered on the assignment and
   * in the append-only history. It changes responsibility only, never anyone's access.
   */
  async delegateTask(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const input = parseDelegate(body);
    return this.tracked('collab.delegations', 'delegate', () =>
      this.mutate(
        caller,
        'task.delegate',
        ws,
        req,
        async (tx, p) => {
          const t = await this.ownedTask(tx, p, tsk, 'record.delegate');
          const mine = await tx.db
            .selectFrom('work.task_assignee')
            .select(['is_primary', 'rank'])
            .where('task_id', '=', t.id)
            .where('membership_id', '=', p.membershipId)
            .executeTakeFirst();
          if (!mine)
            throw new TenancyError('forbidden', {
              issues: [issue('/', 'not_assignee', 'You can only hand over work assigned to you.')],
            });
          const target = (await this.activeMembers(tx, [input.to]))[0];
          const host = await this.loadHost(tx, p, t.publicId);
          const eligible =
            !!target &&
            target.kind === 'member' &&
            target.id !== p.membershipId &&
            (await this.memberReaches(
              tx,
              host,
              { id: target.id, account_id: target.account_id, kind: 'member' },
              'view',
            ));
          if (!eligible || !target)
            throw invalid(issue('/to', 'not_assignable', "That person can't take this over."));
          const already = await tx.db
            .selectFrom('work.task_assignee')
            .select('is_primary')
            .where('task_id', '=', t.id)
            .where('membership_id', '=', target.id)
            .executeTakeFirst();
          await tx.db
            .deleteFrom('work.task_assignee')
            .where('task_id', '=', t.id)
            .where('membership_id', '=', p.membershipId)
            .execute();
          if (already) {
            if (mine.is_primary)
              await tx.db
                .updateTable('work.task_assignee')
                .set({ is_primary: true })
                .where('task_id', '=', t.id)
                .where('membership_id', '=', target.id)
                .execute();
          } else
            await tx.db
              .insertInto('work.task_assignee')
              .values({
                workspace_id: tx.workspaceId,
                brand_id: t.brand.id,
                task_id: t.id,
                membership_id: target.id,
                is_primary: mine.is_primary,
                rank: mine.rank,
                assigned_by_membership_id: p.membershipId,
                delegated_from_membership_id: p.membershipId,
                delegated_at: new Date(),
              })
              .execute();
          await tx.db
            .insertInto('collab.assignment_event')
            .values({
              id: newUuidV7(),
              workspace_id: tx.workspaceId,
              task_id: t.id,
              kind: 'delegated',
              via: 'delegate',
              from_membership_id: p.membershipId,
              to_membership_id: target.id,
              actor_membership_id: p.membershipId,
              note_text: input.note,
            })
            .execute();
          const me = await tx.db
            .selectFrom('tenancy.membership')
            .select('public_id')
            .where('id', '=', p.membershipId)
            .executeTakeFirstOrThrow();
          await this.bumpTask(tx, t, p);
          await this.taskAudit(tx, caller, p, 'task.delegated', t, [
            change.plain('delegated', me.public_id, target.public_id),
            ...(input.note
              ? [change.content('delegation_note', { hash: hashText(input.note) })]
              : []),
          ]);
          await this.workEvent(
            tx,
            caller,
            p,
            'work.task.delegated',
            { type: 'work.task', id: t.id, sequence: t.row.version + 1 },
            { from_membership_id: p.membershipId, to_membership_id: target.id },
            t.brand.id,
          );
          return {
            status: 200,
            ref: { id: t.publicId, type: 'task' },
            data: await this.taskView(tx, p, await this.loadTask(tx, p, t.publicId)),
          };
        },
        async (tx, p, ref) => this.taskView(tx, p, await this.loadTask(tx, p, ref.id)),
      ),
    );
  }

  /**
   * `GET /tasks/{id}/assignment-history`: who was assigned, handed over, or reassigned, newest
   * first. Outside a share (AZ-22); people are named only to members.
   */
  async assignmentHistory(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    query: Record<string, unknown>,
  ) {
    const q = parseCursorQuery(query, []);
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const t = await this.loadTask(tx, p, tsk);
      if (t.ownLevel === null || p.kind !== 'member') throw new TenancyError('not_found');
      const limit = this.pageLimit(q.limit);
      const fp = this.cursorFp('assignments', t.id);
      const after = q.cursor !== undefined ? this.openCursor(p, fp, q.cursor) : null;
      const rows = (
        await sql<{
          id: string;
          kind: string;
          via: string;
          from_id: string | null;
          to_id: string | null;
          actor_id: string;
          note_text: string | null;
          occurred_at: Date;
          cursor_at: string;
        }>`SELECT e.id, e.kind, e.via, e.from_membership_id AS from_id, e.to_membership_id AS to_id,
                  e.actor_membership_id AS actor_id, e.note_text, e.occurred_at,
                  ${cursorAt('e.occurred_at')} AS cursor_at
             FROM collab.assignment_event e
            WHERE e.workspace_id = ${tx.workspaceId} AND e.task_id = ${t.id}
              ${after ? sql`AND (e.occurred_at, e.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
            ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${limit + 1}`.execute(tx.db)
      ).rows;
      const page = rows.slice(0, limit);
      const ids = [
        ...new Set(
          page.flatMap((r) => [r.from_id, r.to_id, r.actor_id]).filter((x): x is string => !!x),
        ),
      ];
      const people = new Map(
        ids.length
          ? (
              await tx.db
                .selectFrom('tenancy.membership as m')
                .innerJoin('identity.account as a', 'a.id', 'm.account_id')
                .select(['m.id', 'm.public_id', 'm.display_name_override', 'a.display_name'])
                .where('m.id', 'in', ids)
                .execute()
            ).map((m) => [
              m.id,
              { id: m.public_id, name: m.display_name_override ?? m.display_name },
            ])
          : [],
      );
      const who = (id: string | null) => (id ? (people.get(id) ?? null) : null);
      const last = page.at(-1);
      return {
        data: page.map((r) => ({
          kind: r.kind,
          via: r.via,
          from: who(r.from_id),
          to: who(r.to_id),
          by: who(r.actor_id),
          note: r.note_text,
          at: iso(r.occurred_at)!,
        })),
        page: {
          limit,
          has_more: rows.length > limit,
          ...(rows.length > limit && last
            ? {
                next_cursor: this.sealCursor(p, fp, {
                  at: last.cursor_at,
                  id: last.id,
                }),
              }
            : {}),
        },
      };
    });
  }
}
