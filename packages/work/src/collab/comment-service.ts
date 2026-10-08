import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { change } from '@pm/audit';
import { canonicalJson, newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  compilePrincipal,
  compileVisibility,
  invalid,
  issue,
  parseIfMatch,
  requireVersion,
  TenancyError,
  type BrandFacts,
  type Caller,
  type Level,
  type Mutation,
  type Principal,
  type ProjectChain,
} from '@pm/tenancy';
import type { ActionKey } from '@pm/contracts';
import { CapacityService } from '../capacity/capacity-service.ts';
import type { LoadedProject } from '../service.ts';
import type { LoadedTask } from '../task-core.ts';
import { isPublic } from '../validation.ts';
import { recordJoins, recordProject, recordTitle } from './record-sql.ts';
import { withinEditWindow, type CollabHostKind, type Reaction } from './semantics.ts';
import {
  parseCommentCreate,
  parseCommentEdit,
  parseCursorQuery,
  parseReaction,
  type CommentInput,
  type MentionInput,
} from './validation.ts';

const hashText = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
/** A well-formed public identifier no row has (constant-shape not-found paths). */
const NIL_TASK = `tsk_${'0'.repeat(26)}`;

/** A record that can host comments, followers, and reviews, resolved through its own compiler. */
export interface CollabHost {
  kind: CollabHostKind;
  id: string;
  publicId: string;
  title: string;
  /** Null for a workspace-level record (a document that belongs to no brand). */
  brand: (BrandFacts & { publicId: string; name: string }) | null;
  chain: ProjectChain;
  lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
  level: Level;
  /** Ownership-derived level only (null: the caller reads the record through a share alone). */
  ownLevel: Level | null;
  version: number;
  /** Decides `action` on the host as the caller; throws not_found or forbidden. */
  decide(
    action: ActionKey,
    opts?: { shares?: boolean; excluded?: 'not_found' | 'forbidden' },
  ): void;
  allows(action: ActionKey, opts?: { shares?: boolean }): boolean;
  /** The governing project column, for visibility predicates (alias `r` is the envelope). */
  projectOf: ReturnType<typeof sql>;
  /** The joins that make `projectOf` available after `FROM core.record r`. */
  joinSql: ReturnType<typeof sql>;
  /** For tasks: the task row (assignees, delegation). */
  task: LoadedTask | null;
}

interface CommentRow {
  id: string;
  public_id: string;
  host_record_id: string;
  root_comment_id: string | null;
  in_reply_to_comment_id: string | null;
  body_rich: unknown;
  body_text: string | null;
  author_membership_id: string;
  created_at: Date;
  edited_at: Date | null;
  edit_count: number;
  deleted_at: Date | null;
  deleted_by_membership_id: string | null;
  deleted_by_kind: 'author' | 'moderator' | null;
  version: number;
  cursor_at?: string;
}

interface CursorPos {
  at: string;
  id: string;
}

type CollabMetric =
  | 'collab.comments'
  | 'collab.reactions'
  | 'collab.follows'
  | 'collab.reviews'
  | 'collab.delegations';

/** A timestamp as text with its full microseconds, so a keyset cursor never rounds a row away. */
export const cursorAt = (col: string) =>
  sql<string>`to_char(${sql.raw(col)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')`;
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

/**
 * Phase 4A comments, mentions, reactions, and following (ADR-0023; 0B ADR-31, 0C AZ-31, 0D PL-33;
 * OD-10, OD-38). Every row hangs on a host record and is authorized through that host's own
 * compiled level on every read and write: nothing here stores or caches anyone's access. Bodies
 * are content: audit events carry hashes only, and the prior body of an edit or a deletion goes
 * to the append-only revision trail.
 */
export class CommentService extends CapacityService {
  readonly #cursorKey: Buffer;

  constructor(deps: ConstructorParameters<typeof CapacityService>[0]) {
    super(deps);
    this.#cursorKey = createHmac('sha256', deps.signingKey)
      .update('cursor:collab.comments')
      .digest();
  }

  // ---------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------

  protected countCollab(metric: CollabMetric, label: string, outcome: string) {
    const key =
      metric === 'collab.reactions' || metric === 'collab.follows'
        ? 'change'
        : metric === 'collab.delegations'
          ? 'kind'
          : 'action';
    this.d.metrics.count(metric, 1, { [key]: label, outcome });
  }

  protected async tracked<T>(
    metric: CollabMetric,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const out = await fn();
      this.countCollab(metric, label, 'ok');
      return out;
    } catch (err) {
      this.countCollab(metric, label, err instanceof TenancyError ? err.code : 'error');
      throw err;
    }
  }

  protected sealCursor(p: Principal, fp: string, pos: CursorPos): string {
    const payload = JSON.stringify(pos);
    const mac = createHmac('sha256', this.#cursorKey)
      .update(`${p.workspaceId}|${p.membershipId}|${fp}|${payload}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    return Buffer.from(JSON.stringify({ p: payload, m: mac })).toString('base64url');
  }

  protected openCursor(p: Principal, fp: string, raw: unknown): CursorPos {
    try {
      if (typeof raw !== 'string' || raw.length > 2048) throw new Error();
      const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
        p: string;
        m: string;
      };
      const want = createHmac('sha256', this.#cursorKey)
        .update(`${p.workspaceId}|${p.membershipId}|${fp}|${o.p}`)
        .digest()
        .subarray(0, 16);
      const got = Buffer.from(o.m, 'base64url');
      if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error();
      const c = JSON.parse(o.p) as CursorPos;
      if (!CURSOR_AT.test(c.at) || !/^[0-9a-f-]{36}$/.test(c.id)) throw new Error();
      return c;
    } catch {
      throw new TenancyError('cursor_invalid');
    }
  }

  protected cursorFp(...parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
  }

  protected async collabLimit(p: Principal): Promise<void> {
    const d = await this.c.limiter.consume('comment.member' as never, p.membershipId);
    if (!d.allowed)
      throw new TenancyError('rate_limited', { retryAfterSeconds: d.retryAfterSeconds });
  }

  // ---------------------------------------------------------------------------------------------
  // Host resolution: one compiled level per record type, one decision vocabulary
  // ---------------------------------------------------------------------------------------------

  /**
   * The host record a collaboration command or read is about. An unknown, malformed, unreadable,
   * or unsupported identifier is the same `not_found`, and an unknown task identifier runs the
   * same statements as an existing one the caller cannot read (constant shape, ADR-0015 W20).
   */
  protected async loadHost(
    tx: WorkspaceTransaction,
    p: Principal,
    rec: unknown,
    opts: { lock?: boolean } = {},
  ): Promise<CollabHost> {
    if (isPublic(rec, 'tsk')) {
      const t = await this.loadTask(tx, p, rec, opts);
      return {
        kind: 'task',
        id: t.id,
        publicId: t.publicId,
        title: t.row.title,
        brand: t.brand,
        chain: t.chain,
        lifecycleState: t.lifecycleState,
        level: t.level,
        ownLevel: t.ownLevel,
        version: t.row.version,
        decide: (action, o = {}) => this.requireTaskAction(p, action, t, o),
        allows: (action, o = {}) => this.taskAllows(p, action, t, o),
        projectOf: sql`t.project_id`,
        joinSql: sql`JOIN work.task t ON t.workspace_id = r.workspace_id AND t.id = r.id`,
        task: t,
      };
    }
    if (isPublic(rec, 'prj')) {
      const pr = await this.loadProject(tx, p, rec, opts);
      return {
        kind: 'project',
        id: pr.id,
        publicId: pr.publicId,
        title: pr.row.name,
        brand: pr.brand,
        chain: pr.chain,
        lifecycleState: pr.lifecycleState,
        level: pr.level,
        ownLevel: pr.ownLevel,
        version: pr.row.version,
        decide: (action, o = {}) => this.requireProjectAction(p, action, pr, o),
        allows: (action, o = {}) => this.projectAllows(p, action, pr, o),
        projectOf: sql`w.id`,
        joinSql: sql`JOIN work.project w ON w.workspace_id = r.workspace_id AND w.id = r.id`,
        task: null,
      };
    }
    const extra = await this.loadExtraHost(tx, p, rec, opts);
    if (extra) return extra;
    // Unsupported record types and malformed identifiers: the same statements as a missing task.
    await this.loadTask(tx, p, NIL_TASK).catch(() => undefined);
    throw new TenancyError('not_found');
  }

  /** Hosts registered by later phases (documents, 4C); null when `rec` is not one of theirs. */
  protected loadExtraHost(
    _tx: WorkspaceTransaction,
    _p: Principal,
    _rec: unknown,
    _opts: { lock?: boolean },
  ): Promise<CollabHost | null> {
    return Promise.resolve(null);
  }

  protected taskAllows(
    p: Principal,
    action: ActionKey,
    t: LoadedTask,
    o: { shares?: boolean },
  ): boolean {
    try {
      this.requireTaskAction(p, action, t, o);
      return true;
    } catch (err) {
      if (err instanceof TenancyError) return false;
      throw err;
    }
  }

  protected projectAllows(
    p: Principal,
    action: ActionKey,
    pr: LoadedProject,
    o: { shares?: boolean },
  ): boolean {
    try {
      this.requireProjectAction(p, action, pr, o);
      return true;
    } catch (err) {
      if (err instanceof TenancyError) return false;
      throw err;
    }
  }

  /** Can this other member reach the host at `need` right now (the same compiled predicate)? */
  protected async memberReaches(
    tx: WorkspaceTransaction,
    host: CollabHost,
    m: { id: string; account_id: string; kind: 'member' | 'guest' },
    need: Level,
  ): Promise<boolean> {
    const mp = await compilePrincipal(tx, m.id, m.account_id, m.kind);
    const vis = await compileVisibility(tx, mp, {
      need,
      includeArchived: true,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const res = await sql<{ ok: number }>`
      SELECT 1 AS ok FROM core.record r ${host.joinSql}
       WHERE r.id = ${host.id} AND ${vis.where('r', { project: host.projectOf })}`.execute(tx.db);
    return res.rows.length > 0;
  }

  /** Active internal members by public id with what is needed to evaluate their access. */
  protected async activeMembers(tx: WorkspaceTransaction, publicIds: readonly string[]) {
    if (!publicIds.length) return [];
    return tx.db
      .selectFrom('tenancy.membership as m')
      .innerJoin('identity.account as a', 'a.id', 'm.account_id')
      .select([
        'm.id',
        'm.public_id',
        'm.account_id',
        'm.kind',
        'a.display_name',
        'm.display_name_override',
      ])
      .where('m.public_id', 'in', [...publicIds])
      .where('m.state', '=', 'active')
      .execute();
  }

  protected personName(m: { display_name: string; display_name_override: string | null }) {
    return m.display_name_override ?? m.display_name;
  }

  // ---------------------------------------------------------------------------------------------
  // Comment rows and views
  // ---------------------------------------------------------------------------------------------

  protected async commentRow(
    tx: WorkspaceTransaction,
    publicId: unknown,
    opts: { lock?: boolean } = {},
  ): Promise<(CommentRow & { host_public: string }) | undefined> {
    if (!isPublic(publicId, 'cmt')) return undefined;
    let q = tx.db
      .selectFrom('collab.comment as c')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'c.workspace_id').onRef('r.id', '=', 'c.host_record_id'),
      )
      .select([
        'c.id',
        'c.public_id',
        'c.host_record_id',
        'c.root_comment_id',
        'c.in_reply_to_comment_id',
        'c.body_rich',
        'c.body_text',
        'c.author_membership_id',
        'c.created_at',
        'c.edited_at',
        'c.edit_count',
        'c.deleted_at',
        'c.deleted_by_membership_id',
        'c.deleted_by_kind',
        'c.version',
        'r.public_id as host_public',
      ])
      .where('c.public_id', '=', publicId);
    if (opts.lock) q = q.forUpdate('c');
    const row = await q.executeTakeFirst();
    return row
      ? ({ ...row, version: Number(row.version), edit_count: Number(row.edit_count) } as never)
      : undefined;
  }

  /** The comment and its host as the caller sees them; anything unreadable is `not_found`. */
  protected async loadComment(
    tx: WorkspaceTransaction,
    p: Principal,
    cmt: unknown,
    opts: { lock?: boolean } = {},
  ) {
    const row = await this.commentRow(tx, cmt, opts);
    if (!row) {
      await this.loadTask(tx, p, NIL_TASK).catch(() => undefined);
      throw new TenancyError('not_found');
    }
    const host = await this.loadHost(tx, p, row.host_public);
    return { row, host };
  }

  protected async commentViews(
    tx: WorkspaceTransaction,
    p: Principal,
    host: CollabHost,
    rows: ReadonlyArray<CommentRow>,
  ) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const authorIds = [
      ...new Set(
        rows.flatMap((r) => [
          r.author_membership_id,
          r.deleted_by_membership_id ?? r.author_membership_id,
        ]),
      ),
    ];
    const people = new Map(
      (
        await tx.db
          .selectFrom('tenancy.membership as m')
          .innerJoin('identity.account as a', 'a.id', 'm.account_id')
          .select(['m.id', 'm.public_id', 'm.state', 'a.display_name', 'm.display_name_override'])
          .where('m.id', 'in', authorIds)
          .execute()
      ).map((m) => [m.id, m]),
    );
    const refIds = [
      ...new Set(
        rows
          .flatMap((r) => [r.root_comment_id, r.in_reply_to_comment_id])
          .filter((x): x is string => !!x),
      ),
    ];
    const publicOf = new Map(
      refIds.length
        ? (
            await tx.db
              .selectFrom('collab.comment')
              .select(['id', 'public_id'])
              .where('id', 'in', refIds)
              .execute()
          ).map((c) => [c.id, c.public_id])
        : [],
    );
    const reactions = await tx.db
      .selectFrom('collab.reaction')
      .select(['comment_id', 'reaction', 'membership_id'])
      .where('comment_id', 'in', ids)
      .execute();
    const byComment = new Map<string, Map<string, { count: number; mine: boolean }>>();
    for (const r of reactions) {
      const m = byComment.get(r.comment_id) ?? new Map();
      const cur = m.get(r.reaction) ?? { count: 0, mine: false };
      cur.count += 1;
      if (r.membership_id === p.membershipId) cur.mine = true;
      m.set(r.reaction, cur);
      byComment.set(r.comment_id, m);
    }
    const mentions = await this.mentionViews(tx, p, ids);
    const canComment = host.allows('record.comment');
    const canModerate = host.allows('comment.moderate');
    const now = new Date();
    return rows.map((r) => {
      const author = people.get(r.author_membership_id);
      const deleted = r.deleted_at !== null;
      const mine = r.author_membership_id === p.membershipId;
      const open = withinEditWindow(new Date(r.created_at), now, this.ws.commentEditWindowMinutes);
      const reacts = byComment.get(r.id) ?? new Map<string, { count: number; mine: boolean }>();
      return {
        id: r.public_id,
        type: 'comment' as const,
        host: { id: host.publicId, type: host.kind },
        thread: r.root_comment_id ? (publicOf.get(r.root_comment_id) ?? null) : null,
        in_reply_to: r.in_reply_to_comment_id
          ? (publicOf.get(r.in_reply_to_comment_id) ?? null)
          : null,
        body: deleted ? null : r.body_rich,
        text: deleted ? null : r.body_text,
        deleted,
        deleted_by: r.deleted_by_kind,
        author: author
          ? { id: author.public_id, type: 'member' as const, name: this.personName(author) }
          : null,
        created_at: iso(r.created_at)!,
        edited_at: iso(r.edited_at),
        edit_count: r.edit_count,
        version: r.version,
        mentions: deleted ? [] : (mentions.get(r.id) ?? []),
        reactions: deleted
          ? []
          : [...reacts.entries()].map(([reaction, v]) => ({
              reaction,
              count: v.count,
              mine: v.mine,
            })),
        capabilities: {
          reply: canComment,
          react: canComment && !deleted,
          edit: !deleted && mine && canComment && open && host.allows('comment.edit_own'),
          delete:
            !deleted &&
            ((mine && open && host.allows('comment.edit_own')) ||
              (!mine && canModerate) ||
              (mine && canModerate)),
          history: mine || canModerate,
        },
      };
    });
  }

  /**
   * Mention chips as the viewer may see them: members only, people and teams by display name,
   * records only while the viewer can read them. A target the viewer cannot see is dropped, so a
   * chip never confirms a hidden person or record (the text the author wrote stays text).
   */
  protected async mentionViews(tx: WorkspaceTransaction, p: Principal, commentIds: string[]) {
    const out = new Map<string, Array<{ kind: string; id: string; name: string }>>();
    if (p.kind !== 'member' || !commentIds.length) return out;
    const rows = await tx.db
      .selectFrom('relations.mention')
      .select([
        'source_id',
        'target_kind',
        'target_membership_id',
        'target_team_id',
        'target_record_id',
      ])
      .where('source_id', 'in', commentIds)
      .orderBy('position')
      .orderBy('id')
      .execute();
    if (!rows.length) return out;
    const memberIds = rows.flatMap((r) => (r.target_membership_id ? [r.target_membership_id] : []));
    const teamIds = rows.flatMap((r) => (r.target_team_id ? [r.target_team_id] : []));
    const recordIds = rows.flatMap((r) => (r.target_record_id ? [r.target_record_id] : []));
    const members = new Map(
      memberIds.length
        ? (
            await tx.db
              .selectFrom('tenancy.membership as m')
              .innerJoin('identity.account as a', 'a.id', 'm.account_id')
              .select([
                'm.id',
                'm.public_id',
                'm.state',
                'm.kind',
                'a.display_name',
                'm.display_name_override',
              ])
              .where('m.id', 'in', memberIds)
              .execute()
          ).map((m) => [m.id, m])
        : [],
    );
    const teams = new Map(
      teamIds.length
        ? (
            await tx.db
              .selectFrom('tenancy.team as t')
              .innerJoin('core.record as r', (j) =>
                j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
              )
              .select(['t.id', 'r.public_id', 't.name', 't.lifecycle_state'])
              .where('t.id', 'in', teamIds)
              .execute()
          ).map((t) => [t.id, t])
        : [],
    );
    const vis = recordIds.length ? await this.taskVisibility(tx, p, true) : null;
    const records = new Map(
      vis && recordIds.length
        ? (
            await sql<{ id: string; public_id: string; title: string }>`
              SELECT r.id, r.public_id, ${recordTitle} AS title
                FROM core.record r
                ${recordJoins}
               WHERE r.id = ANY(${recordIds}::uuid[])
                 AND ${vis.where('r', { project: recordProject })}`.execute(
              tx.db,
            )
          ).rows.map((r) => [r.id, r])
        : [],
    );
    for (const r of rows) {
      let chip: { kind: string; id: string; name: string } | null = null;
      if (r.target_membership_id) {
        const m = members.get(r.target_membership_id);
        if (m && m.state === 'active' && m.kind === 'member')
          chip = { kind: 'member', id: m.public_id, name: this.personName(m) };
      } else if (r.target_team_id) {
        const t = teams.get(r.target_team_id);
        if (t && t.lifecycle_state === 'active')
          chip = { kind: 'team', id: t.public_id, name: t.name };
      } else if (r.target_record_id) {
        const rec = records.get(r.target_record_id);
        if (rec) chip = { kind: 'record', id: rec.public_id, name: rec.title };
      }
      if (!chip) continue;
      const list = out.get(r.source_id) ?? [];
      list.push(chip);
      out.set(r.source_id, list);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Mentions: only what the author may name in this record's scope (COL-007, D4)
  // ---------------------------------------------------------------------------------------------

  /**
   * Resolves requested mentions to rows. Hidden, unknown, ineligible, and unsupported targets
   * (agents arrive with 8B) all fail with the one `not_mentionable` issue, after the same lookups.
   */
  protected async resolveMentions(
    tx: WorkspaceTransaction,
    p: Principal,
    host: CollabHost,
    mentions: readonly MentionInput[],
  ) {
    const resolved: Array<{
      kind: 'member' | 'team' | 'record';
      membershipId: string | null;
      teamId: string | null;
      recordId: string | null;
      publicId: string;
    }> = [];
    const refuse = (i: number): never => {
      throw invalid(
        issue(
          `/mentions/${i}`,
          'not_mentionable',
          "That person, team, or record can't be mentioned here.",
        ),
      );
    };
    for (const [i, m] of mentions.entries()) {
      // Guests have no directory (AZ-06): they may not name people, teams, or other records.
      const may = p.kind === 'member';
      if (m.kind === 'member') {
        const found = (await this.activeMembers(tx, [m.id]))[0];
        const ok =
          may &&
          !!found &&
          found.kind === 'member' &&
          (await this.memberReaches(
            tx,
            host,
            { id: found.id, account_id: found.account_id, kind: 'member' },
            'view',
          ));
        if (!ok || !found) refuse(i);
        else
          resolved.push({
            kind: 'member',
            membershipId: found.id,
            teamId: null,
            recordId: null,
            publicId: found.public_id,
          });
      } else if (m.kind === 'team') {
        const team = await tx.db
          .selectFrom('tenancy.team as t')
          .innerJoin('core.record as r', (j) =>
            j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
          )
          .select(['t.id', 'r.public_id', 't.lifecycle_state'])
          .where('r.public_id', '=', m.id)
          .where('r.record_type', '=', 'team')
          .executeTakeFirst();
        if (!may || !team || team.lifecycle_state !== 'active') refuse(i);
        else
          resolved.push({
            kind: 'team',
            membershipId: null,
            teamId: team.id,
            recordId: null,
            publicId: team.public_id,
          });
      } else {
        const vis = await this.taskVisibility(tx, p, true);
        const rec = (
          await sql<{ id: string; public_id: string }>`
            SELECT r.id, r.public_id FROM core.record r
              ${recordJoins}
             WHERE r.public_id = ${m.id} AND r.record_type IN ('task', 'project', 'document')
               AND ${vis.where('r', { project: recordProject })}`.execute(tx.db)
        ).rows[0];
        if (!may || !rec) refuse(i);
        else
          resolved.push({
            kind: 'record',
            membershipId: null,
            teamId: null,
            recordId: rec.id,
            publicId: rec.public_id,
          });
      }
    }
    return resolved;
  }

  /** Replaces a comment's mentions with `next`; returns the ones that are new (for events). */
  protected async syncMentions(
    tx: WorkspaceTransaction,
    commentId: string,
    next: Awaited<ReturnType<CommentService['resolveMentions']>>,
  ) {
    const key = (r: {
      kind: string;
      membershipId: string | null;
      teamId: string | null;
      recordId: string | null;
    }) => `${r.kind}:${r.membershipId ?? r.teamId ?? r.recordId}`;
    const existing = await tx.db
      .selectFrom('relations.mention')
      .select(['id', 'target_kind', 'target_membership_id', 'target_team_id', 'target_record_id'])
      .where('source_id', '=', commentId)
      .execute();
    const have = new Map(
      existing.map((e) => [
        key({
          kind: e.target_kind,
          membershipId: e.target_membership_id,
          teamId: e.target_team_id,
          recordId: e.target_record_id,
        }),
        e.id,
      ]),
    );
    const want = new Set(next.map(key));
    const gone = [...have.entries()].filter(([k]) => !want.has(k)).map(([, id]) => id);
    if (gone.length) await tx.db.deleteFrom('relations.mention').where('id', 'in', gone).execute();
    const added: Array<{ id: string; kind: string; targetId: string }> = [];
    for (const [position, m] of next.entries()) {
      const known = have.get(key(m));
      if (known) {
        await tx.db
          .updateTable('relations.mention')
          .set({ position })
          .where('id', '=', known)
          .execute();
        continue;
      }
      const id = newUuidV7();
      await tx.db
        .insertInto('relations.mention')
        .values({
          id,
          workspace_id: tx.workspaceId,
          source_kind: 'comment',
          source_id: commentId,
          target_kind: m.kind,
          target_membership_id: m.membershipId,
          target_team_id: m.teamId,
          target_record_id: m.recordId,
          position,
        })
        .execute();
      added.push({ id, kind: m.kind, targetId: (m.membershipId ?? m.teamId ?? m.recordId)! });
    }
    return added;
  }

  protected async emitMentions(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    host: CollabHost,
    added: ReadonlyArray<{ id: string; kind: string; targetId: string }>,
  ) {
    // Mentions of records are references, not people to tell; 4B delivers for people and teams.
    for (const a of added.filter((x) => x.kind !== 'record'))
      await this.workEvent(
        tx,
        caller,
        p,
        'relations.mention.created',
        { type: 'relations.mention', id: a.id, sequence: 0 },
        { source_kind: 'comment', target_kind: a.kind, target_id: a.targetId },
        (host.brand?.id ?? null),
      );
  }

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  /** `GET /records/{id}/comments`: root comments with their first replies, by cursor. */
  async listComments(caller: Caller, ws: unknown, rec: unknown, query: Record<string, unknown>) {
    const q = parseCursorQuery(query, ['order']);
    const order = q.order === undefined ? 'asc' : q.order;
    if (order !== 'asc' && order !== 'desc')
      throw invalid(issue('/order', 'invalid_option', 'Choose oldest or newest first.'));
    return this.tracked('collab.comments', 'list', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const host = await this.loadHost(tx, p, rec);
        const limit = this.pageLimit(q.limit);
        const fp = this.cursorFp('comments', host.id, order);
        const after = q.cursor !== undefined ? this.openCursor(p, fp, q.cursor) : null;
        const cmp = order === 'asc' ? sql`>` : sql`<`;
        const dir = order === 'asc' ? sql`ASC` : sql`DESC`;
        const roots = (
          await sql<CommentRow>`
            SELECT c.id, c.public_id, c.host_record_id, c.root_comment_id, c.in_reply_to_comment_id,
                   c.body_rich, c.body_text, c.author_membership_id, c.created_at, c.edited_at,
                   c.edit_count, c.deleted_at, c.deleted_by_membership_id, c.deleted_by_kind, c.version,
                   ${cursorAt('c.created_at')} AS cursor_at
              FROM collab.comment c
             WHERE c.workspace_id = ${tx.workspaceId} AND c.host_record_id = ${host.id}
               AND c.root_comment_id IS NULL
               ${after ? sql`AND (c.created_at, c.id) ${cmp} (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
             ORDER BY c.created_at ${dir}, c.id ${dir}
             LIMIT ${limit + 1}`.execute(tx.db)
        ).rows.map((r) => ({ ...r, version: Number(r.version), edit_count: Number(r.edit_count) }));
        const page = roots.slice(0, limit);
        const hasMore = roots.length > limit;
        const inline = this.ws.commentRepliesInlineMax;
        const ids = page.map((r) => r.id);
        const replies = ids.length
          ? (
              await sql<CommentRow & { rn: string }>`
                SELECT * FROM (
                  SELECT c.id, c.public_id, c.host_record_id, c.root_comment_id, c.in_reply_to_comment_id,
                         c.body_rich, c.body_text, c.author_membership_id, c.created_at, c.edited_at,
                         c.edit_count, c.deleted_at, c.deleted_by_membership_id, c.deleted_by_kind, c.version,
                         row_number() OVER (PARTITION BY c.root_comment_id ORDER BY c.created_at, c.id) AS rn
                    FROM collab.comment c
                   WHERE c.workspace_id = ${tx.workspaceId} AND c.root_comment_id = ANY(${ids}::uuid[])) x
                 WHERE x.rn <= ${inline}
                 ORDER BY x.created_at, x.id`.execute(tx.db)
            ).rows.map((r) => ({
              ...r,
              version: Number(r.version),
              edit_count: Number(r.edit_count),
            }))
          : [];
        const counts = new Map(
          ids.length
            ? (
                await tx.db
                  .selectFrom('collab.comment')
                  .select(['root_comment_id', (eb) => eb.fn.countAll<string>().as('n')])
                  .where('root_comment_id', 'in', ids)
                  .groupBy('root_comment_id')
                  .execute()
              ).map((c) => [c.root_comment_id!, Number(c.n)])
            : [],
        );
        const views = await this.commentViews(tx, p, host, [...page, ...replies]);
        const byId = new Map(views.map((v) => [v.id, v]));
        const data = page.map((r) => {
          const view = byId.get(r.public_id)!;
          const mine = replies.filter((x) => x.root_comment_id === r.id);
          const total = counts.get(r.id) ?? 0;
          return {
            ...view,
            reply_count: total,
            replies: mine.map((x) => byId.get(x.public_id)!),
            replies_more: total > mine.length,
          };
        });
        const last = page.at(-1);
        return {
          data,
          page: {
            limit,
            has_more: hasMore,
            ...(hasMore && last
              ? {
                  next_cursor: this.sealCursor(p, fp, {
                    at: last.cursor_at!,
                    id: last.id,
                  }),
                }
              : {}),
          },
          total: Number(
            (
              await tx.db
                .selectFrom('collab.comment')
                .select((eb) => eb.fn.countAll<string>().as('n'))
                .where('host_record_id', '=', host.id)
                .where('deleted_at', 'is', null)
                .executeTakeFirstOrThrow()
            ).n,
          ),
        };
      }),
    );
  }

  /** `GET /comments/{id}/replies`: a thread's replies after the inline ones, by cursor. */
  async listReplies(caller: Caller, ws: unknown, cmt: unknown, query: Record<string, unknown>) {
    const q = parseCursorQuery(query, []);
    return this.tracked('collab.comments', 'replies', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const { row, host } = await this.loadComment(tx, p, cmt);
        if (row.root_comment_id !== null) throw new TenancyError('not_found');
        const limit = this.pageLimit(q.limit);
        const fp = this.cursorFp('replies', row.id);
        const after = q.cursor !== undefined ? this.openCursor(p, fp, q.cursor) : null;
        const rows = (
          await sql<CommentRow>`
            SELECT c.id, c.public_id, c.host_record_id, c.root_comment_id, c.in_reply_to_comment_id,
                   c.body_rich, c.body_text, c.author_membership_id, c.created_at, c.edited_at,
                   c.edit_count, c.deleted_at, c.deleted_by_membership_id, c.deleted_by_kind, c.version,
                   ${cursorAt('c.created_at')} AS cursor_at
              FROM collab.comment c
             WHERE c.workspace_id = ${tx.workspaceId} AND c.root_comment_id = ${row.id}
               ${after ? sql`AND (c.created_at, c.id) > (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
             ORDER BY c.created_at, c.id LIMIT ${limit + 1}`.execute(tx.db)
        ).rows.map((r) => ({ ...r, version: Number(r.version), edit_count: Number(r.edit_count) }));
        const page = rows.slice(0, limit);
        const views = await this.commentViews(tx, p, host, page);
        const last = page.at(-1);
        return {
          data: views,
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

  async getComment(caller: Caller, ws: unknown, cmt: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const { row, host } = await this.loadComment(tx, p, cmt);
      return (await this.commentViews(tx, p, host, [row]))[0]!;
    });
  }

  /**
   * `GET /comments/{id}/revisions`: the append-only trail (OD-38). Visible to the comment's
   * author and to people with moderation authority on the record; anyone else who can read the
   * comment gets `forbidden`, and anyone who cannot read it gets `not_found`.
   */
  async commentRevisions(caller: Caller, ws: unknown, cmt: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const { row, host } = await this.loadComment(tx, p, cmt);
      const mine = row.author_membership_id === p.membershipId;
      if (!mine && !host.allows('comment.moderate')) throw new TenancyError('forbidden');
      const rows = await tx.db
        .selectFrom('collab.comment_revision as v')
        .innerJoin('tenancy.membership as m', (j) =>
          j
            .onRef('m.workspace_id', '=', 'v.workspace_id')
            .onRef('m.id', '=', 'v.actor_membership_id'),
        )
        .innerJoin('identity.account as a', 'a.id', 'm.account_id')
        .select([
          'v.revision_no',
          'v.kind',
          'v.body_rich',
          'v.body_text',
          'v.created_at',
          'm.public_id as actor_public',
          'a.display_name',
          'm.display_name_override',
        ])
        .where('v.comment_id', '=', row.id)
        .orderBy('v.revision_no')
        .execute();
      return rows.map((v) => ({
        revision: Number(v.revision_no),
        kind: v.kind,
        body: v.body_rich,
        text: v.body_text,
        at: iso(v.created_at)!,
        actor: { id: v.actor_public, name: this.personName(v) },
      }));
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Commands: comments
  // ---------------------------------------------------------------------------------------------

  async createComment(caller: Caller, ws: unknown, rec: unknown, body: unknown, req: Mutation) {
    const input = parseCommentCreate(body, {
      bodyMax: this.ws.commentBodyMaxChars,
      mentionsMax: this.ws.commentMentionsMax,
    });
    return this.tracked('collab.comments', 'create', () =>
      this.mutate(
        caller,
        'comment.create',
        ws,
        req,
        async (tx, p) => {
          const host = await this.loadHost(tx, p, rec);
          host.decide('record.comment');
          await this.collabLimit(p);
          // Serialize posters on this record so the per-record bound holds under concurrency.
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${host.id}::text, 41))`.execute(
            tx.db,
          );
          const count = await tx.db
            .selectFrom('collab.comment')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('host_record_id', '=', host.id)
            .executeTakeFirstOrThrow();
          if (Number(count.n) >= this.ws.commentsPerRecordMax)
            throw invalid(
              issue(
                '/',
                'too_many',
                `A record can hold at most ${this.ws.commentsPerRecordMax} comments.`,
              ),
            );
          let root: { id: string; public_id: string } | null = null;
          let replyTo: { id: string } | null = null;
          if (input.replyTo) {
            const target = await this.commentRow(tx, input.replyTo);
            // A reply answers a comment of this very record (a stranger's comment is just unknown).
            if (!target || target.host_record_id !== host.id)
              throw invalid(
                issue('/reply_to', 'invalid_reference', "That comment can't be replied to."),
              );
            replyTo = { id: target.id };
            root = target.root_comment_id
              ? ((await tx.db
                  .selectFrom('collab.comment')
                  .select(['id', 'public_id'])
                  .where('id', '=', target.root_comment_id)
                  .executeTakeFirst()) ?? null)
              : { id: target.id, public_id: target.public_id };
          }
          const mentions = await this.resolveMentions(tx, p, host, input.mentions);
          const id = newUuidV7();
          const publicId = newPublicId('cmt');
          await tx.db
            .insertInto('collab.comment')
            .values({
              id,
              public_id: publicId,
              workspace_id: tx.workspaceId,
              host_record_id: host.id,
              root_comment_id: root?.id ?? null,
              in_reply_to_comment_id: replyTo?.id ?? null,
              body_rich: JSON.stringify(input.doc),
              body_text: input.text,
              author_membership_id: p.membershipId,
            })
            .execute();
          const added = await this.syncMentions(tx, id, mentions);
          await this.collabAudit(tx, caller, p, 'comment.created', host, [
            change.plain('comment', null, publicId),
            ...(root ? [change.plain('thread', null, root.public_id)] : []),
            change.content('comment_text', { hash: hashText(input.text) }),
          ]);
          await this.workEvent(
            tx,
            caller,
            p,
            'collab.comment.created',
            { type: 'collab.comment', id, sequence: 0 },
            {
              host_record_id: host.id,
              root_comment_id: root?.id ?? null,
              mention_ids: added.map((a) => a.id).join(',') || null,
            },
            (host.brand?.id ?? null),
          );
          await this.emitMentions(tx, caller, p, host, added);
          return {
            status: 201,
            ref: { id: publicId, type: 'comment' },
            data: await this.commentOut(tx, p, host, id),
          };
        },
        async (tx, p, ref) => {
          const { row, host } = await this.loadComment(tx, p, ref.id);
          return (await this.commentViews(tx, p, host, [row]))[0]!;
        },
      ),
    );
  }

  protected async commentOut(tx: WorkspaceTransaction, p: Principal, host: CollabHost, id: string) {
    const row = (await tx.db
      .selectFrom('collab.comment')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()) as unknown as CommentRow;
    return (
      await this.commentViews(tx, p, host, [
        { ...row, version: Number(row.version), edit_count: Number(row.edit_count) },
      ])
    )[0]!;
  }

  protected collabAudit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    host: CollabHost,
    changes: ReturnType<typeof change.plain>[],
  ) {
    return this.workAudit(
      tx,
      caller,
      p,
      action,
      { recordId: host.id, type: host.kind, publicId: host.publicId },
      changes,
      (host.brand?.id ?? null),
    );
  }

  /** Edit within the author's window: prior body to the trail, version bump, mentions resynced. */
  async editComment(caller: Caller, ws: unknown, cmt: unknown, body: unknown, req: Mutation) {
    const input: CommentInput & { version: number | undefined } = parseCommentEdit(body, {
      bodyMax: this.ws.commentBodyMaxChars,
      mentionsMax: this.ws.commentMentionsMax,
    });
    return this.tracked('collab.comments', 'edit', () =>
      this.mutate(
        caller,
        'comment.edit',
        ws,
        req,
        async (tx, p) => {
          const loaded = await this.loadComment(tx, p, cmt);
          const { host } = loaded;
          const row = (await this.commentRow(tx, cmt, { lock: true }))!;
          // Authors edit their own comments only (nobody edits another person's, D2).
          if (row.author_membership_id !== p.membershipId) {
            host.decide('record.comment');
            throw new TenancyError('forbidden');
          }
          host.decide('comment.edit_own');
          if (row.deleted_at)
            throw new TenancyError('conflict', {
              issues: [issue('/', 'deleted', 'This comment was deleted.')],
            });
          if (
            !withinEditWindow(
              new Date(row.created_at),
              new Date(),
              this.ws.commentEditWindowMinutes,
            )
          )
            throw new TenancyError('forbidden', {
              issues: [issue('/', 'window_closed', "This comment can't be edited any more.")],
            });
          const expected = req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : input.version;
          if (expected === undefined) throw new TenancyError('precondition_required');
          requireVersion(expected, row.version);
          await this.collabLimit(p);
          const mentions = await this.resolveMentions(tx, p, host, input.mentions);
          const changed =
            row.body_text !== input.text ||
            canonicalJson(row.body_rich) !== canonicalJson(input.doc);
          if (changed) {
            await this.appendRevision(tx, row, 'edited', p.membershipId);
            await tx.db
              .updateTable('collab.comment')
              .set({
                body_rich: JSON.stringify(input.doc),
                body_text: input.text,
                edited_at: new Date(),
                edit_count: row.edit_count + 1,
                version: row.version + 1,
              })
              .where('id', '=', row.id)
              .execute();
          }
          const added = await this.syncMentions(tx, row.id, mentions);
          if (changed || added.length) {
            if (!changed)
              await tx.db
                .updateTable('collab.comment')
                .set({ version: row.version + 1 })
                .where('id', '=', row.id)
                .execute();
            await this.collabAudit(tx, caller, p, 'comment.edited', host, [
              change.plain('edit_count', row.edit_count, row.edit_count + (changed ? 1 : 0)),
              change.content('comment_text', { hash: hashText(input.text) }),
            ]);
            await this.workEvent(
              tx,
              caller,
              p,
              'collab.comment.edited',
              { type: 'collab.comment', id: row.id, sequence: row.version + 1 },
              { host_record_id: host.id, edit_count: row.edit_count + (changed ? 1 : 0) },
              (host.brand?.id ?? null),
            );
            await this.emitMentions(tx, caller, p, host, added);
          }
          return {
            status: 200,
            ref: { id: row.public_id, type: 'comment' },
            data: await this.commentOut(tx, p, host, row.id),
          };
        },
        async (tx, p, ref) => {
          const { row, host } = await this.loadComment(tx, p, ref.id);
          return (await this.commentViews(tx, p, host, [row]))[0]!;
        },
      ),
    );
  }

  protected async appendRevision(
    tx: WorkspaceTransaction,
    row: CommentRow,
    kind: 'edited' | 'deleted',
    actor: string,
  ) {
    const n = await tx.db
      .selectFrom('collab.comment_revision')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('comment_id', '=', row.id)
      .executeTakeFirstOrThrow();
    await tx.db
      .insertInto('collab.comment_revision')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        comment_id: row.id,
        revision_no: Number(n.n) + 1,
        kind,
        body_rich: JSON.stringify(row.body_rich),
        body_text: row.body_text!,
        actor_membership_id: actor,
      })
      .execute();
  }

  /**
   * Delete: an author inside their window, or a moderator (manage on the record) at any time. A
   * tombstone: the body leaves the row and joins the revision trail; reactions and mentions go.
   * Deleting a deleted comment is a no-op.
   */
  async deleteComment(caller: Caller, ws: unknown, cmt: unknown, req: Mutation) {
    return this.tracked('collab.comments', 'delete', () =>
      this.mutate(
        caller,
        'comment.delete',
        ws,
        req,
        async (tx, p) => {
          const { host } = await this.loadComment(tx, p, cmt);
          const row = (await this.commentRow(tx, cmt, { lock: true }))!;
          if (row.deleted_at)
            return {
              status: 200,
              ref: { id: row.public_id, type: 'comment' },
              data: await this.commentOut(tx, p, host, row.id),
            };
          const mine = row.author_membership_id === p.membershipId;
          const open = withinEditWindow(
            new Date(row.created_at),
            new Date(),
            this.ws.commentEditWindowMinutes,
          );
          let kind: 'author' | 'moderator';
          if (mine && open) {
            host.decide('comment.edit_own');
            kind = 'author';
          } else if (host.allows('comment.moderate')) {
            host.decide('comment.moderate');
            kind = 'moderator';
          } else {
            host.decide('record.comment');
            throw new TenancyError('forbidden', {
              issues: mine
                ? [issue('/', 'window_closed', "This comment can't be deleted any more.")]
                : [],
            });
          }
          await this.appendRevision(tx, row, 'deleted', p.membershipId);
          await tx.db.deleteFrom('relations.mention').where('source_id', '=', row.id).execute();
          await tx.db.deleteFrom('collab.reaction').where('comment_id', '=', row.id).execute();
          await tx.db
            .updateTable('collab.comment')
            .set({
              body_rich: null,
              body_text: null,
              deleted_at: new Date(),
              deleted_by_membership_id: p.membershipId,
              deleted_by_kind: kind,
              version: row.version + 1,
            })
            .where('id', '=', row.id)
            .execute();
          await this.collabAudit(tx, caller, p, 'comment.deleted', host, [
            change.plain('comment', row.public_id, null),
            change.plain('deleted_by', null, kind),
          ]);
          await this.workEvent(
            tx,
            caller,
            p,
            'collab.comment.deleted',
            { type: 'collab.comment', id: row.id, sequence: row.version + 1 },
            { host_record_id: host.id, deleted_by: kind },
            (host.brand?.id ?? null),
          );
          return {
            status: 200,
            ref: { id: row.public_id, type: 'comment' },
            data: await this.commentOut(tx, p, host, row.id),
          };
        },
        async (tx, p, ref) => {
          const { row, host } = await this.loadComment(tx, p, ref.id);
          return (await this.commentViews(tx, p, host, [row]))[0]!;
        },
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Commands: reactions (COL-008)
  // ---------------------------------------------------------------------------------------------

  /** Sets (`on`) or clears the caller's own reaction; both are idempotent. */
  async setReaction(
    caller: Caller,
    ws: unknown,
    cmt: unknown,
    key: unknown,
    on: boolean,
    req: Mutation,
  ) {
    const reaction: Reaction | null = parseReaction(key);
    if (!reaction) throw new TenancyError('not_found');
    return this.tracked('collab.reactions', on ? 'added' : 'removed', () =>
      this.mutate(
        caller,
        on ? 'comment.react' : 'comment.unreact',
        ws,
        req,
        async (tx, p) => {
          const { row, host } = await this.loadComment(tx, p, cmt);
          host.decide('record.comment');
          if (row.deleted_at)
            throw new TenancyError('conflict', {
              issues: [issue('/', 'deleted', 'This comment was deleted.')],
            });
          let changed: boolean;
          if (on) {
            const r = await tx.db
              .insertInto('collab.reaction')
              .values({
                workspace_id: tx.workspaceId,
                comment_id: row.id,
                membership_id: p.membershipId,
                reaction,
              })
              .onConflict((oc) => oc.doNothing())
              .executeTakeFirst();
            changed = Number(r.numInsertedOrUpdatedRows ?? 0) > 0;
          } else {
            const r = await tx.db
              .deleteFrom('collab.reaction')
              .where('comment_id', '=', row.id)
              .where('membership_id', '=', p.membershipId)
              .where('reaction', '=', reaction)
              .executeTakeFirst();
            changed = Number(r.numDeletedRows) > 0;
          }
          if (changed)
            await this.workEvent(
              tx,
              caller,
              p,
              'collab.comment.reaction_changed',
              { type: 'collab.comment', id: row.id, sequence: row.version },
              { host_record_id: host.id, reaction, change: on ? 'added' : 'removed' },
              (host.brand?.id ?? null),
            );
          return {
            status: 200,
            ref: { id: row.public_id, type: 'comment' },
            data: await this.commentOut(tx, p, host, row.id),
          };
        },
        async (tx, p, ref) => {
          const { row, host } = await this.loadComment(tx, p, ref.id);
          return (await this.commentViews(tx, p, host, [row]))[0]!;
        },
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Mention candidates (COL-007): what the picker may offer
  // ---------------------------------------------------------------------------------------------

  /** People who can read the record, teams, and readable records matching `q`, bounded. */
  async mentionCandidates(
    caller: Caller,
    ws: unknown,
    rec: unknown,
    query: Record<string, unknown>,
  ) {
    const q = parseCursorQuery(query, ['q']);
    const needle = typeof q.q === 'string' ? q.q.trim().toLowerCase() : '';
    if (needle.length > 80) throw invalid(issue('/q', 'too_long', 'Search for fewer characters.'));
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const host = await this.loadHost(tx, p, rec);
      host.decide('record.comment');
      // Guests have no directory (AZ-06): nothing to offer.
      if (p.kind !== 'member')
        return { data: [] as Array<{ kind: string; id: string; name: string }> };
      const max = Math.min(this.pageLimit(q.limit), 20);
      const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const out: Array<{ kind: string; id: string; name: string }> = [];
      const people = await sql<{
        id: string;
        public_id: string;
        account_id: string;
        kind: 'member' | 'guest';
        name: string;
      }>`SELECT m.id, m.public_id, m.account_id, m.kind,
                coalesce(m.display_name_override, a.display_name) AS name
           FROM tenancy.membership m JOIN identity.account a ON a.id = m.account_id
          WHERE m.workspace_id = ${tx.workspaceId} AND m.state = 'active' AND m.kind = 'member'
            AND lower(coalesce(m.display_name_override, a.display_name)) LIKE ${like} ESCAPE '\\'
          ORDER BY lower(coalesce(m.display_name_override, a.display_name)), m.id
          LIMIT ${max * 5}`.execute(tx.db);
      for (const m of people.rows) {
        if (out.length >= max) break;
        if (await this.memberReaches(tx, host, m, 'view'))
          out.push({ kind: 'member', id: m.public_id, name: m.name });
      }
      if (out.length < max) {
        const teams = await sql<{ public_id: string; name: string }>`
          SELECT r.public_id, t.name FROM tenancy.team t
            JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
           WHERE t.workspace_id = ${tx.workspaceId} AND t.lifecycle_state = 'active'
             AND lower(t.name) LIKE ${like} ESCAPE '\\'
           ORDER BY lower(t.name), t.id LIMIT ${max - out.length}`.execute(tx.db);
        for (const t of teams.rows) out.push({ kind: 'team', id: t.public_id, name: t.name });
      }
      if (out.length < max && needle) {
        const vis = await this.taskVisibility(tx, p, false);
        const recs = await sql<{ public_id: string; title: string }>`
          SELECT r.public_id, ${recordTitle} AS title FROM core.record r
            ${recordJoins}
           WHERE r.workspace_id = ${tx.workspaceId} AND r.record_type IN ('task', 'project', 'document')
             AND lower(${recordTitle}) LIKE ${like} ESCAPE '\\'
             AND ${vis.where('r', { project: recordProject })}
           ORDER BY lower(${recordTitle}), r.id LIMIT ${max - out.length}`.execute(
          tx.db,
        );
        for (const r of recs.rows) out.push({ kind: 'record', id: r.public_id, name: r.title });
      }
      return { data: out };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Following (COL-010, TSK-009, PRJ-026; OD-10)
  // ---------------------------------------------------------------------------------------------

  /** The caller's own follow state and the follow-related capabilities on a record. */
  async collaborationSummary(caller: Caller, ws: unknown, rec: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const host = await this.loadHost(tx, p, rec);
      return this.summaryOf(tx, p, host);
    });
  }

  protected async summaryOf(tx: WorkspaceTransaction, p: Principal, host: CollabHost) {
    const mine = await tx.db
      .selectFrom('relations.follower')
      .select('created_at')
      .where('record_id', '=', host.id)
      .where('membership_id', '=', p.membershipId)
      .executeTakeFirst();
    const comments = await tx.db
      .selectFrom('collab.comment')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('host_record_id', '=', host.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    const own = host.ownLevel !== null;
    // Only a current assignee can hand their own assignment over (COL-014).
    const assigned =
      host.kind === 'task' && own
        ? !!(await tx.db
            .selectFrom('work.task_assignee')
            .select('task_id')
            .where('task_id', '=', host.id)
            .where('membership_id', '=', p.membershipId)
            .executeTakeFirst())
        : false;
    return {
      record: { id: host.publicId, type: host.kind },
      following: !!mine,
      followed_at: mine ? iso(mine.created_at) : null,
      comment_count: Number(comments.n),
      capabilities: {
        comment: host.allows('record.comment'),
        follow: host.allows('record.follow'),
        // Followers, reviews, and delegation are context a share does not carry (AZ-22).
        see_followers: own,
        request_review: own && host.allows('review.request', { shares: false }),
        delegate:
          assigned && host.lifecycleState === 'active'
            ? host.allows('record.delegate', { shares: false })
            : false,
      },
    };
  }

  async follow(caller: Caller, ws: unknown, rec: unknown, on: boolean, req: Mutation) {
    return this.tracked('collab.follows', on ? 'added' : 'removed', () =>
      this.mutate(
        caller,
        on ? 'record.follow' : 'record.unfollow',
        ws,
        req,
        async (tx, p) => {
          const host = await this.loadHost(tx, p, rec);
          // Following needs only the right to read the record; unfollowing is always allowed
          // once the record is readable (a lost-access follow is cleaned up when it is purged).
          host.decide('record.follow');
          let changed: boolean;
          if (on) {
            const r = await tx.db
              .insertInto('relations.follower')
              .values({
                workspace_id: tx.workspaceId,
                record_id: host.id,
                membership_id: p.membershipId,
                source: 'explicit',
              })
              .onConflict((oc) => oc.doNothing())
              .executeTakeFirst();
            changed = Number(r.numInsertedOrUpdatedRows ?? 0) > 0;
          } else {
            const r = await tx.db
              .deleteFrom('relations.follower')
              .where('record_id', '=', host.id)
              .where('membership_id', '=', p.membershipId)
              .executeTakeFirst();
            changed = Number(r.numDeletedRows) > 0;
          }
          if (changed)
            await this.workEvent(
              tx,
              caller,
              p,
              on ? 'relations.follow.added' : 'relations.follow.removed',
              { type: 'relations.follower', id: host.id, sequence: 0 },
              { record_type: host.kind, membership_id: p.membershipId },
              (host.brand?.id ?? null),
            );
          return {
            status: 200,
            ref: { id: host.publicId, type: host.kind },
            data: await this.summaryOut(tx, p, host.publicId),
          };
        },
        async (tx, p, ref) => this.summaryOut(tx, p, ref.id),
      ),
    );
  }

  protected async summaryOut(tx: WorkspaceTransaction, p: Principal, rec: string) {
    const host = await this.loadHost(tx, p, rec);
    return { ...(await this.summaryOf(tx, p, host)), id: host.publicId, type: host.kind };
  }

  /**
   * `GET /records/{id}/followers`: for people who read the record through ownership only; a
   * follower who can no longer read it is left out (an inert follow is never reported).
   */
  async followers(caller: Caller, ws: unknown, rec: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const host = await this.loadHost(tx, p, rec);
      if (host.ownLevel === null || p.kind !== 'member') throw new TenancyError('not_found');
      const rows = await sql<{
        id: string;
        public_id: string;
        account_id: string;
        kind: 'member' | 'guest';
        name: string;
        created_at: Date;
      }>`SELECT m.id, m.public_id, m.account_id, m.kind, f.created_at,
                coalesce(m.display_name_override, a.display_name) AS name
           FROM relations.follower f
           JOIN tenancy.membership m ON m.workspace_id = f.workspace_id AND m.id = f.membership_id
           JOIN identity.account a ON a.id = m.account_id
          WHERE f.workspace_id = ${tx.workspaceId} AND f.record_id = ${host.id} AND m.state = 'active'
          ORDER BY f.created_at, m.id LIMIT ${this.ws.followersListMax}`.execute(tx.db);
      const out: Array<{ id: string; name: string; since: string }> = [];
      for (const m of rows.rows)
        if (m.id === p.membershipId || (await this.memberReaches(tx, host, m, 'view')))
          out.push({ id: m.public_id, name: m.name, since: iso(m.created_at)! });
      return { data: out };
    });
  }

  /**
   * `GET /me/following` (NAV-006): the records the caller follows and can read right now,
   * newest follow first. A follow on a record the caller can no longer read is omitted.
   */
  async following(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const q = parseCursorQuery(query, ['type']);
    if (
      q.type !== undefined &&
      q.type !== 'task' &&
      q.type !== 'project' &&
      q.type !== 'document'
    )
      throw invalid(issue('/type', 'invalid_option', 'Choose tasks, projects, or documents.'));
    return this.tracked('collab.follows', 'list', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const limit = this.pageLimit(q.limit);
        const fp = this.cursorFp('following', q.type ?? null);
        const after = q.cursor !== undefined ? this.openCursor(p, fp, q.cursor) : null;
        const vis = await this.taskVisibility(tx, p, true);
        const rows = (
          await sql<{
            id: string;
            public_id: string;
            record_type: string;
            title: string;
            status_category: string;
            due: string | null;
            brand_id: string | null;
            lifecycle_state: string;
            followed_at: Date;
            cursor_at: string;
            fid: string;
          }>`SELECT r.id, r.public_id, r.record_type, ${recordTitle} AS title,
                    COALESCE(t.status_category, w.status_category) AS status_category,
                    COALESCE(t.due_date, w.target_date, kd.review_due_on)::text AS due, r.brand_id, r.lifecycle_state,
                    f.created_at AS followed_at, ${cursorAt('f.created_at')} AS cursor_at, r.id AS fid
               FROM relations.follower f
               JOIN core.record r ON r.workspace_id = f.workspace_id AND r.id = f.record_id
               ${recordJoins}
              WHERE f.workspace_id = ${tx.workspaceId} AND f.membership_id = ${p.membershipId}
                AND r.record_type IN ('task', 'project', 'document')
                ${q.type ? sql`AND r.record_type = ${q.type}` : sql``}
                AND ${vis.where('r', { project: recordProject })}
                ${after ? sql`AND (f.created_at, r.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
              ORDER BY f.created_at DESC, r.id DESC LIMIT ${limit + 1}`.execute(tx.db)
        ).rows;
        const page = rows.slice(0, limit);
        const brandIds = [...new Set(page.flatMap((r) => (r.brand_id ? [r.brand_id] : [])))];
        const brands = new Map(
          brandIds.length
            ? (
                await tx.db
                  .selectFrom('tenancy.brand as b')
                  .innerJoin('core.record as br', (j) =>
                    j.onRef('br.workspace_id', '=', 'b.workspace_id').onRef('br.id', '=', 'b.id'),
                  )
                  .select(['b.id', 'br.public_id', 'b.name'])
                  .where('b.id', 'in', brandIds)
                  .execute()
              ).map((b) => [b.id, b])
            : [],
        );
        const readable = new Set(vis.ctx.brandIds);
        const last = page.at(-1);
        return {
          data: page.map((r) => ({
            id: r.public_id,
            type: r.record_type,
            title: r.title,
            status_category: r.status_category,
            due: r.due,
            archived: r.lifecycle_state === 'archived',
            // A brand the viewer cannot read is never named (a shared record shows no brand).
            brand:
              r.brand_id && readable.has(r.brand_id) && brands.get(r.brand_id)
                ? { id: brands.get(r.brand_id)!.public_id, name: brands.get(r.brand_id)!.name }
                : null,
            followed_at: iso(r.followed_at)!,
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
      }),
    );
  }
}

export { hashText };
