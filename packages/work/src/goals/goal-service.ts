import { createHash } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type RawBuilder, type WorkspaceTransaction } from '@pm/db';
import {
  bumpEpoch,
  decideBrand,
  decideWorkspace,
  findBrand,
  invalid,
  issue,
  parseIfMatch,
  requireVersion,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { csv } from '../time/semantics.ts';
import { isPublic } from '../validation.ts';
import {
  GoalCore,
  num,
  type GoalRow,
  type KeyResultRow,
  type LinkRow,
  type LoadedGoal,
  type Progress,
} from './goal-core.ts';
import { markGoalDirty, recalcGoal } from './recalc.ts';
import {
  CONFIDENCE_LABEL,
  daysSince,
  metricPercent,
  periodLabel,
  periodIsCanonical,
  statusChangeAllowed,
  type ConfidenceKey,
  type Period,
} from './semantics.ts';
import {
  parseCheckin,
  parseGoalCreate,
  parseGoalList,
  parseGoalUpdate,
  parseKeyResultCreate,
  parseKeyResultUpdate,
  parseGoalLink,
  type GoalCreate,
  type GoalListQuery,
  type Metric,
} from './validation.ts';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const noteHash = (s: string) => ({ hash: sha(s) });
const LIKE = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const NIL = '00000000-0000-7000-8000-000000000000';
const asNumber = (v: number | null) => (v === null ? null : String(v));

type GoalEvent =
  | 'goals.goal.created'
  | 'goals.goal.updated'
  | 'goals.goal.status_changed'
  | 'goals.goal.checkin_recorded'
  | 'goals.goal.link_changed'
  | 'goals.key_result.created'
  | 'goals.key_result.updated';

/**
 * Phase 5B goals, part two (ADR-0028): goals, key results, links, and check-ins. Goals are
 * records in the core envelope; their access is the placement's and is never widened by a link.
 * Every figure that depends on linked work is computed for the viewer, from the work they may
 * read, at the moment it is read (nothing about linked work is stored).
 */
export class GoalService extends GoalCore {
  // ---------------------------------------------------------------------------------------------
  // Audit and events
  // ---------------------------------------------------------------------------------------------

  protected async goalAudit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    g: { id: string; publicId: string; brandId: string | null },
    changes: ReturnType<typeof change.plain>[],
    type = 'goal',
  ) {
    return this.workAudit(
      tx,
      caller,
      p,
      action,
      { recordId: g.id, type, publicId: g.publicId },
      changes,
      g.brandId,
    );
  }

  protected async goalEvent(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    type: GoalEvent,
    aggregate: { type: string; id: string },
    data: Record<string, string | number | boolean | null>,
    brandId: string | null,
    sequence = 0,
  ) {
    await this.workEvent(tx, caller, p, type, { ...aggregate, sequence }, data, brandId);
  }

  // ---------------------------------------------------------------------------------------------
  // Placement
  // ---------------------------------------------------------------------------------------------

  protected async goalPlacement(tx: WorkspaceTransaction, p: Principal, input: GoalCreate) {
    if (input.project) {
      const pr = await this.loadProject(tx, p, input.project, { lock: true });
      this.requireActive(pr);
      this.requireCreateIn(p, { brand: pr.brand, project: pr, chain: pr.chain });
      return {
        brandId: pr.brand.id as string | null,
        brand: { ...pr.brand, timezone: 'UTC' } as LoadedGoal['brand'],
        projectId: pr.id as string | null,
        chain: pr.chain,
        scopeKey: pr.brand.id,
      };
    }
    if (input.brand) {
      const b = await findBrand(tx, p, input.brand);
      const facts = { id: b.id, isSensitive: b.is_sensitive, lifecycleState: b.lifecycle_state };
      const o = decideBrand(p, 'record.create', { ...facts, lifecycleState: 'active' });
      this.decision('record.create', o);
      if (!o.allowed) throw new TenancyError(o.code);
      if (b.lifecycle_state !== 'active')
        throw new TenancyError('conflict', {
          issues: [issue('/brand', 'brand_archived', 'This brand is archived.')],
        });
      return {
        brandId: b.id as string | null,
        brand: {
          ...facts,
          publicId: b.public_id,
          name: b.name,
          timezone: b.timezone,
        } as LoadedGoal['brand'],
        projectId: null as string | null,
        chain: [] as LoadedGoal['chain'],
        scopeKey: b.id,
      };
    }
    const o = decideWorkspace(p, 'record.create');
    this.decision('record.create', o);
    if (!o.allowed) throw new TenancyError(o.code);
    return {
      brandId: null as string | null,
      brand: null as LoadedGoal['brand'],
      projectId: null as string | null,
      chain: [] as LoadedGoal['chain'],
      scopeKey: tx.workspaceId,
    };
  }

  protected async requireGoalRoom(
    tx: WorkspaceTransaction,
    scopeKey: string,
    projectId: string | null,
  ) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`goals.scope:${scopeKey}:${projectId ?? ''}`}, 0))`.execute(
      tx.db,
    );
    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM goals.goal
       WHERE workspace_id = ${tx.workspaceId} AND scope_key = ${scopeKey}
         AND project_id IS NOT DISTINCT FROM ${projectId} AND lifecycle_state <> 'purged'`.execute(
      tx.db,
    );
    if (Number(n.rows[0]?.n ?? 0) >= this.ws.goalsPerScopeMax)
      throw invalid(
        issue('/', 'too_many', `A scope can hold at most ${this.ws.goalsPerScopeMax} goals.`),
      );
  }

  protected async goalOwner(
    tx: WorkspaceTransaction,
    publicId: string,
    where: { brand: LoadedGoal['brand']; chain: LoadedGoal['chain'] },
  ) {
    const m = await this.memberByPublic(tx, publicId, '/owner');
    if (!(await this.canEditHere(tx, m.id, where)))
      throw invalid(
        issue('/owner', 'invalid_reference', 'Choose a member who can edit this goal.'),
      );
    return m;
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  protected periodView(
    g: Pick<GoalRow, 'period_kind' | 'period_start' | 'period_end'>,
    state: string,
  ) {
    const period: Period = { kind: g.period_kind, start: g.period_start, end: g.period_end };
    return {
      kind: g.period_kind,
      start: g.period_start,
      end: g.period_end,
      label: periodLabel(period),
      calendar: periodIsCanonical(period),
      state,
    };
  }

  /**
   * Views for goals the viewer may read, in the order given. List rows carry progress and
   * freshness; `detail` adds key results, the links the viewer may read, and capabilities.
   */
  protected async goalViews(
    tx: WorkspaceTransaction,
    p: Principal,
    rows: Array<{ row: GoalRow; loaded?: LoadedGoal }>,
  ) {
    return (await this.goalViewParts(tx, p, rows, { detail: false })).map((x) => x.base);
  }

  protected async goalDetailViews(
    tx: WorkspaceTransaction,
    p: Principal,
    rows: Array<{ row: GoalRow; loaded?: LoadedGoal }>,
  ) {
    return (await this.goalViewParts(tx, p, rows, { detail: true })).map((x) => ({
      ...x.base,
      ...x.extra!,
    }));
  }

  protected async goalViewParts(
    tx: WorkspaceTransaction,
    p: Principal,
    rows: Array<{
      row: GoalRow;
      loaded?: LoadedGoal;
    }>,
    opts: { detail: boolean },
  ) {
    const now = new Date();
    const today = await this.workspaceToday(tx);
    const goals = rows.map((r) => r.row);
    const ids = goals.map((g) => g.id);
    const idOf = (g: GoalRow) => g.id;
    const krsByGoal = await this.keyResultsOf(tx, ids);
    const links = await this.linksOf(tx, ids);
    const progress = await this.progressOf(tx, p, goals as never, krsByGoal, links);
    const active = await this.activeWorkOf(tx, p, links);
    const state = await this.goalStateOf(tx, ids);
    const krAll = [...krsByGoal.values()].flat();
    const people = await this.goalPeople(tx, p, [
      ...goals.map((g) => g.owner_membership_id),
      ...krAll.map((k) => k.owner_membership_id),
    ]);
    const checkinIds = await this.checkinPublicIds(tx, [
      ...goals.map((g) => g.latest_checkin_id),
      ...krAll.map((k) => k.latest_checkin_id),
    ]);
    const projects = await this.projectNames(
      tx,
      goals.map((g) => g.project_id),
    );
    const brands = new Map<
      string,
      ReturnType<GoalCore['brandFactsOf']> extends Promise<infer B> ? B : never
    >();
    for (const b of new Set(goals.map((g) => g.brand_id).filter((x): x is string => !!x)))
      brands.set(b, await this.brandFactsOf(tx, b));
    const targets = opts.detail ? await this.readableTargets(tx, p, links) : null;
    const krPublic = new Map(krAll.map((k) => [k.id, k.public_id]));
    return rows.map(({ row: g, loaded }) => {
      const id = idOf(g);
      const brand = g.brand_id ? brands.get(g.brand_id) : undefined;
      const proj = g.project_id ? projects.get(g.project_id) : undefined;
      const scope =
        g.project_id && brand
          ? { kind: 'project' as const, brand: brand.marker, project: proj ?? null }
          : brand
            ? { kind: 'brand' as const, brand: brand.marker }
            : { kind: 'workspace' as const };
      const fresh = this.freshness(g, state.get(id), today, now);
      const gp = progress.goal.get(id)!;
      const w = active.get(id) ?? { visible_links: 0, active_links: 0 };
      const krs = krsByGoal.get(id) ?? [];
      const base = {
        id: g.public_id,
        type: 'goal' as const,
        title: g.title,
        description: g.description,
        scope,
        owner: people.get(g.owner_membership_id) ?? null,
        status: g.status,
        period: this.periodView(g, fresh.period_state),
        basis: g.progress_basis,
        metric: this.metricView(g),
        progress: gp,
        latest: this.latestView(g, checkinIds),
        freshness: fresh,
        work: { ...w, relative_to: 'viewer' as const },
        key_results_count: krs.length,
        lifecycle_state: g.lifecycle_state,
        version: g.version,
      };
      if (!opts.detail) return { base, extra: null };
      const goalLinks = links.filter((l) => l.goal_id === id);
      return {
        base,
        extra: {
          key_results: krs.map((k) =>
            this.keyResultView(k, progress.kr.get(k.id)!, people, checkinIds),
          ),
          links: goalLinks.flatMap((l) => {
            const t = targets!.get(l.target_record_id);
            return t
              ? [
                  {
                    target: t,
                    key_result: l.key_result_id ? (krPublic.get(l.key_result_id) ?? null) : null,
                  },
                ]
              : [];
          }),
          capabilities: loaded
            ? {
                update:
                  this.goalAllows(p, 'record.update', loaded) && g.lifecycle_state === 'active',
                check_in:
                  this.goalAllows(p, 'record.update', loaded) &&
                  g.lifecycle_state === 'active' &&
                  (g.status === 'draft' || g.status === 'active'),
                // Decided on the live record, so an archived goal can still be restored by an editor.
                archive: this.lifeAllows(p, 'record.archive', loaded),
                restore: this.lifeAllows(p, 'record.restore', loaded),
                trash: this.lifeAllows(p, 'record.trash', loaded),
              }
            : null,
          as_of: now.toISOString(),
        },
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  async getGoal(caller: Caller, ws: unknown, goal: unknown) {
    return this.gTrack('goals.reads', 'goal', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const g = await this.loadGoal(tx, p, goal);
        const [view] = await this.goalDetailViews(tx, p, [{ row: g.row, loaded: g }]);
        return view!;
      }),
    );
  }

  /** Goals the viewer may read, filtered and paged (a keyset over period and identifier). */
  protected lifeAllows(
    p: Principal,
    action: 'record.archive' | 'record.restore' | 'record.trash',
    g: LoadedGoal,
  ) {
    try {
      this.requireGoalAction(p, action, g, { lifecycleState: 'active' });
      return true;
    } catch (err) {
      if (err instanceof TenancyError) return false;
      throw err;
    }
  }

  /** Trashed goals the viewer may restore (edit access on the live record); nothing else is listed. */
  protected async trashedGoals(tx: WorkspaceTransaction, p: Principal) {
    const rows = await sql<{ public_id: string }>`
      SELECT r.public_id FROM goals.goal g JOIN core.record r ON r.workspace_id = g.workspace_id AND r.id = g.id
       WHERE g.workspace_id = ${tx.workspaceId} AND g.lifecycle_state = 'trashed'
       ORDER BY g.updated_at DESC, g.id DESC LIMIT ${this.ws.pageLimitMax}`.execute(tx.db);
    const data = [];
    for (const r of rows.rows) {
      try {
        const g = await this.loadGoal(tx, p, r.public_id, { allowTrashed: true });
        data.push({
          id: g.publicId,
          type: 'goal' as const,
          title: g.row.title,
          scope: g.brandMarker
            ? { kind: 'brand' as const, brand: g.brandMarker }
            : { kind: 'workspace' as const },
          lifecycle_state: 'trashed' as const,
          version: g.row.version,
        });
      } catch (err) {
        if (!(err instanceof TenancyError)) throw err;
      }
    }
    return { data, page: { limit: data.length, has_more: false } };
  }

  async listGoals(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    if (query.trashed === 'true')
      return this.gTrack('goals.reads', 'trashed', () =>
        this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
          this.requireMemberKind(p);
          return this.trashedGoals(tx, p);
        }),
      );
    const q = parseGoalList(query, this.ws.pageLimitMax);
    return this.gTrack('goals.reads', 'list', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        this.requireMemberKind(p);
        return this.goalPage(tx, p, q, q.limit ?? Math.min(50, this.ws.pageLimitMax));
      }),
    );
  }

  protected async goalPage(
    tx: WorkspaceTransaction,
    p: Principal,
    q: GoalListQuery,
    limit: number,
  ) {
    const vis = await this.goalVisibility(tx, p, q.archived);
    const today = await this.workspaceToday(tx);
    const cond: RawBuilder<unknown>[] = [vis.where('r', { project: sql`g.project_id` })];
    cond.push(sql`g.workspace_id = ${tx.workspaceId}`);
    cond.push(sql`g.lifecycle_state = ${q.archived ? 'archived' : 'active'}::core.lifecycle_state`);
    if (q.brand === 'workspace') cond.push(sql`g.brand_id IS NULL`);
    else if (q.brand) {
      const b = await tx.db
        .selectFrom('core.record')
        .select('id')
        .where('public_id', '=', q.brand)
        .where('record_type', '=', 'brand')
        .executeTakeFirst();
      cond.push(sql`g.brand_id = ${b?.id ?? NIL}`);
    }
    if (q.project) {
      const pr = await tx.db
        .selectFrom('core.record')
        .select('id')
        .where('public_id', '=', q.project)
        .where('record_type', '=', 'project')
        .executeTakeFirst();
      cond.push(sql`g.project_id = ${pr?.id ?? NIL}`);
    }
    if (q.statuses) cond.push(sql`g.status = ANY(${q.statuses}::text[])`);
    if (q.owner) {
      const owner =
        q.owner === 'me'
          ? p.membershipId
          : ((
              await tx.db
                .selectFrom('tenancy.membership')
                .select('id')
                .where('public_id', '=', q.owner)
                .executeTakeFirst()
            )?.id ?? NIL);
      cond.push(sql`g.owner_membership_id = ${owner}`);
    }
    if (q.basis) cond.push(sql`g.progress_basis = ${q.basis}`);
    if (q.confidence === 'none') cond.push(sql`g.latest_confidence IS NULL`);
    else if (q.confidence) cond.push(sql`g.latest_confidence = ${q.confidence}`);
    const staleCut = new Date(Date.now() - this.ws.goalUpdateStaleDays * 86_400_000);
    if (q.update === 'never') cond.push(sql`g.latest_checkin_at IS NULL`);
    else if (q.update === 'stale')
      cond.push(sql`g.latest_checkin_at IS NOT NULL AND g.latest_checkin_at < ${staleCut}`);
    else if (q.update === 'fresh') cond.push(sql`g.latest_checkin_at >= ${staleCut}`);
    if (q.period === 'current')
      cond.push(sql`g.period_start <= ${today}::date AND g.period_end >= ${today}::date`);
    else if (q.period === 'upcoming') cond.push(sql`g.period_start > ${today}::date`);
    else if (q.period === 'ended') cond.push(sql`g.period_end < ${today}::date`);
    if (q.from) cond.push(sql`g.period_end >= ${q.from}::date`);
    if (q.to) cond.push(sql`g.period_start <= ${q.to}::date`);
    if (q.q) cond.push(sql`g.title ILIKE ${LIKE(q.q)} ESCAPE '\\'`);
    const fp = this.goalFp(
      'goals',
      q.brand,
      q.project,
      q.statuses,
      q.owner,
      q.basis,
      q.confidence,
      q.update,
      q.period,
      q.from,
      q.to,
      q.q,
      q.archived,
    );
    if (q.cursor) {
      const pos = this.goalOpen(p, fp, q.cursor);
      cond.push(sql`(g.period_start, g.id) < (${pos.k}::date, ${pos.id}::uuid)`);
    }
    const where = sql.join(cond, sql` AND `);
    const rows = await sql<Record<string, unknown> & { public_id: string; id: string }>`
      SELECT g.*, g.period_start::text AS period_start_t, r.public_id
        FROM goals.goal g JOIN core.record r ON r.workspace_id = g.workspace_id AND r.id = g.id
       WHERE ${where}
       ORDER BY g.period_start DESC, g.id DESC
       LIMIT ${limit + 1}`.execute(tx.db);
    const more = rows.rows.length > limit;
    const page = rows.rows.slice(0, limit);
    const views = await this.goalViews(
      tx,
      p,
      page.map((r) => ({ row: this.toGoalRow(r as never) })),
    );
    const last = page[page.length - 1];
    return {
      data: views,
      page: {
        limit,
        has_more: more,
        ...(more && last
          ? { next_cursor: this.goalSeal(p, fp, { k: String(last.period_start_t), id: last.id }) }
          : {}),
      },
      as_of: new Date().toISOString(),
      scope_note:
        'Only goals you can read are listed; progress from linked work covers the work you can read.',
    };
  }

  /** Check-in history of a goal (or one of its key results): append-only, newest first. */
  async listCheckins(caller: Caller, ws: unknown, goal: unknown, query: Record<string, unknown>) {
    return this.gTrack('goals.reads', 'checkins', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const g = await this.loadGoal(tx, p, goal);
        const limit = Math.min(Math.max(Number(query.limit ?? 25) || 25, 1), this.ws.pageLimitMax);
        const krParam = query.key_result;
        let krId: string | null | undefined;
        if (krParam !== undefined && krParam !== '') {
          if (!isPublic(krParam, 'kr'))
            throw invalid(issue('/key_result', 'invalid_reference', 'Choose a key result.'));
          krId = (await this.loadKeyResult(tx, g, krParam))?.id;
          if (!krId) throw new TenancyError('not_found');
        }
        const fp = this.goalFp('checkins', g.id, krId ?? null);
        let before: { k: string; id: string } | null = null;
        if (typeof query.cursor === 'string') before = this.goalOpen(p, fp, query.cursor);
        const rows = await sql<{
          id: string;
          public_id: string;
          key_result_id: string | null;
          source: string;
          value: string | null;
          progress_percent: string | null;
          confidence: ConfidenceKey | null;
          note: string | null;
          author_membership_id: string | null;
          created_at: Date;
          created_iso: string;
        }>`SELECT c.id, c.public_id, c.key_result_id, c.source, c.value::text AS value,
                  c.progress_percent::text AS progress_percent, c.confidence, c.note, c.author_membership_id,
                  c.created_at, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_iso
             FROM goals.goal_checkin c
            WHERE c.workspace_id = ${tx.workspaceId} AND c.goal_id = ${g.id}
              ${krId !== undefined ? sql`AND c.key_result_id = ${krId}` : sql``}
              ${before ? sql`AND (c.created_at, c.id) < (${before.k}::timestamp AT TIME ZONE 'UTC', ${before.id}::uuid)` : sql``}
            ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit + 1}`.execute(tx.db);
        const more = rows.rows.length > limit;
        const page = rows.rows.slice(0, limit);
        const people = await this.goalPeople(
          tx,
          p,
          page.map((r) => r.author_membership_id),
        );
        const krs = await this.keyResultsOf(tx, [g.id], true);
        const krPublic = new Map((krs.get(g.id) ?? []).map((k) => [k.id, k.public_id]));
        const last = page[page.length - 1];
        return {
          data: page.map((r) => ({
            id: r.public_id,
            type: 'goal_checkin' as const,
            source: r.source,
            key_result: r.key_result_id ? (krPublic.get(r.key_result_id) ?? null) : null,
            value: num(r.value),
            progress_percent: num(r.progress_percent),
            confidence: r.confidence,
            note: r.note,
            author: r.author_membership_id ? (people.get(r.author_membership_id) ?? null) : null,
            created_at: iso(r.created_at),
          })),
          page: {
            limit,
            has_more: more,
            ...(more && last
              ? { next_cursor: this.goalSeal(p, fp, { k: last.created_iso, id: last.id }) }
              : {}),
          },
        };
      }),
    );
  }

  /** The goals an authorized reader of a project sees: scoped to it, or linked to it or its tasks. */
  async goalsOfProject(caller: Caller, ws: unknown, project: unknown) {
    return this.gTrack('goals.reads', 'project_goals', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        this.requireMemberKind(p);
        const pr = await this.loadProject(tx, p, project);
        const vis = await this.goalVisibility(tx, p, false);
        const rows = await sql<Record<string, unknown> & { public_id: string; id: string }>`
          SELECT g.*, r.public_id FROM goals.goal g JOIN core.record r ON r.workspace_id = g.workspace_id AND r.id = g.id
           WHERE g.workspace_id = ${tx.workspaceId} AND ${vis.where('r', { project: sql`g.project_id` })}
             AND (g.project_id = ${pr.id}
               OR EXISTS (SELECT 1 FROM goals.goal_link l WHERE l.workspace_id = g.workspace_id AND l.goal_id = g.id
                    AND (l.target_record_id = ${pr.id}
                      OR l.target_record_id IN (SELECT t.id FROM work.task t WHERE t.workspace_id = g.workspace_id AND t.project_id = ${pr.id}))))
           ORDER BY g.period_start DESC, g.id DESC LIMIT ${this.ws.pageLimitMax}`.execute(tx.db);
        const data = await this.goalViews(
          tx,
          p,
          rows.rows.map((r) => ({ row: this.toGoalRow(r as never) })),
        );
        return { data, page: { limit: data.length, has_more: false } };
      }),
    );
  }

  /**
   * The readable leaf tasks behind a goal's (or one key result's) linked-work progress: the drill
   * down for every figure the goal shows. Only work this viewer may read is listed, so the list and
   * the counts always agree, and nothing here names work the viewer cannot read.
   */
  async goalWork(caller: Caller, ws: unknown, goal: unknown, query: Record<string, unknown>) {
    return this.gTrack('goals.reads', 'work', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const g = await this.loadGoal(tx, p, goal);
        let krId: string | null = null;
        if (query.key_result !== undefined && query.key_result !== '') {
          const kr = await this.loadKeyResult(tx, g, query.key_result);
          if (!kr)
            throw invalid(
              issue('/key_result', 'invalid_reference', 'Choose a key result of this goal.'),
            );
          krId = kr.id;
        }
        const links = (await this.linksOf(tx, [g.id])).filter((l) => l.key_result_id === krId);
        const max = this.ws.pageLimitMax;
        const vis = await this.workVisibility(tx, p);
        const kinds = links.map((l) => l.target_kind);
        const targets = links.map((l) => l.target_record_id);
        const rows = links.length
          ? (
              await sql<{
                public_id: string;
                title: string;
                status_category: string;
                due_date: string | null;
                project_public: string | null;
                project_name: string | null;
              }>`
                WITH pairs AS (
                  SELECT * FROM unnest(${kinds}::text[], ${targets}::uuid[]) AS x(kind, target_id)
                ), hits AS (
                  SELECT t.id FROM pairs p JOIN work.task t ON t.workspace_id = ${tx.workspaceId} AND p.kind = 'project' AND t.project_id = p.target_id
                  UNION SELECT t.id FROM pairs p JOIN work.task t ON t.workspace_id = ${tx.workspaceId} AND p.kind = 'task' AND t.id = p.target_id
                  UNION SELECT t.id FROM pairs p JOIN work.task t ON t.workspace_id = ${tx.workspaceId} AND p.kind = 'task' AND t.ancestor_ids @> ARRAY[p.target_id]
                )
                SELECT r.public_id, t.title, t.status_category, LEAST(t.due_date, t.deadline_date)::text AS due_date,
                       pr.public_id AS project_public, w.name AS project_name
                  FROM hits h
                  JOIN work.task t ON t.workspace_id = ${tx.workspaceId} AND t.id = h.id
                  JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
                  LEFT JOIN work.project w ON w.workspace_id = t.workspace_id AND w.id = t.project_id
                  LEFT JOIN core.record pr ON pr.workspace_id = w.workspace_id AND pr.id = w.id
                 WHERE t.status_category <> 'cancelled' AND ${vis.where('r', { project: sql`t.project_id` })}
                   AND NOT EXISTS (SELECT 1 FROM work.task c JOIN core.record cr ON cr.workspace_id = c.workspace_id AND cr.id = c.id
                        WHERE c.workspace_id = t.workspace_id AND c.parent_task_id = t.id
                          AND ${vis.where('cr', { project: sql`c.project_id` })})
                 ORDER BY (t.status_category = 'done'), t.title, t.id LIMIT ${max + 1}`.execute(
                tx.db,
              )
            ).rows
          : [];
        const truncated = rows.length > max;
        const page = rows.slice(0, max);
        const totals = (await this.linkedWork(tx, p, [{ key: 'k', links }])).get('k') ?? {
          done: 0,
          total: 0,
        };
        return {
          data: page.map((r) => ({
            id: r.public_id,
            type: 'task' as const,
            title: r.title,
            status: { category: r.status_category },
            done: r.status_category === 'done',
            due_date: r.due_date,
            project: r.project_public ? { id: r.project_public, name: r.project_name } : null,
          })),
          summary: { done: totals.done, total: totals.total },
          coverage: {
            truncated,
            relative_to: 'viewer' as const,
            note: 'Tasks you can read inside the linked projects and under the linked tasks; cancelled tasks and work you cannot read are not counted.',
          },
          as_of: new Date().toISOString(),
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Create and update
  // ---------------------------------------------------------------------------------------------

  async createGoal(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = parseGoalCreate(body);
    return this.gTrack('goals.changes', 'create', () =>
      this.mutate(
        caller,
        'goal.create',
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const place = await this.goalPlacement(tx, p, input);
          await this.requireGoalRoom(tx, place.scopeKey, place.projectId);
          let ownerId = p.membershipId;
          if (input.owner)
            ownerId = (
              await this.goalOwner(tx, input.owner, { brand: place.brand, chain: place.chain })
            ).id;
          const id = newUuidV7();
          const publicId = newPublicId('goal');
          const cmd = this.cmd(caller, p, place.brandId);
          await tx.db
            .insertInto('core.record')
            .values({
              id,
              public_id: publicId,
              record_type: 'goal',
              workspace_id: tx.workspaceId,
              brand_id: place.brandId,
              source_kind: 'ui',
              source_ref: null,
              created_by_actor_type: cmd.actor.type,
              created_by_actor_id: cmd.actor.id,
            })
            .execute();
          await tx.db
            .insertInto('goals.goal')
            .values({
              id,
              workspace_id: tx.workspaceId,
              brand_id: place.brandId,
              scope_key: place.scopeKey,
              project_id: place.projectId,
              title: input.title,
              description: input.description,
              owner_membership_id: ownerId,
              status: input.status,
              period_kind: input.period.kind,
              period_start: input.period.start,
              period_end: input.period.end,
              progress_basis: input.basis,
              unit: input.metric.unit,
              baseline_value: asNumber(input.metric.baseline),
              target_value: asNumber(input.metric.target),
              current_value: asNumber(input.metric.current),
              created_by_membership_id: p.membershipId,
              updated_by_membership_id: p.membershipId,
            })
            .execute();
          await markGoalDirty(tx, id);
          const target = { id, publicId, brandId: place.brandId };
          await this.goalAudit(tx, caller, p, 'goal.created', target, [
            change.content('title', noteHash(input.title)),
            change.plain(
              'scope',
              null,
              place.projectId ? 'project' : place.brandId ? 'brand' : 'workspace',
            ),
            change.plain('status', null, input.status),
            change.plain('period_kind', null, input.period.kind),
            change.plain('period_start', null, input.period.start),
            change.plain('period_end', null, input.period.end),
            change.plain('basis', null, input.basis),
            change.plain('target', null, asNumber(input.metric.target)),
          ]);
          await this.goalEvent(
            tx,
            caller,
            p,
            'goals.goal.created',
            { type: 'goals.goal', id },
            {
              scope: place.projectId ? 'project' : place.brandId ? 'brand' : 'workspace',
              period_kind: input.period.kind,
              progress_basis: input.basis,
            },
            place.brandId,
          );
          return {
            status: 201,
            ref: { id: publicId, type: 'goal' },
            data: await this.renderGoal(tx, p, publicId),
          };
        },
        async (tx, p, ref) => this.renderGoal(tx, p, ref.id),
      ),
    );
  }

  protected async renderGoal(tx: WorkspaceTransaction, p: Principal, publicId: string) {
    const g = await this.loadGoal(tx, p, publicId);
    const [view] = await this.goalDetailViews(tx, p, [{ row: g.row, loaded: g }]);
    return view!;
  }

  protected expectedVersion(req: Mutation, body: { version: number | undefined }): number {
    const v = req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : body.version;
    if (v === undefined) throw new TenancyError('precondition_required');
    return v;
  }

  async updateGoal(caller: Caller, ws: unknown, goal: unknown, body: unknown, req: Mutation) {
    const input = parseGoalUpdate(body);
    return this.gTrack('goals.changes', 'update', () =>
      this.mutate(
        caller,
        'goal.update',
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const g = await this.loadGoal(tx, p, goal, { lock: true });
          this.requireGoalActive(g);
          this.requireGoalAction(p, 'record.update', g);
          requireVersion(this.expectedVersion(req, input), g.row.version);
          const cur = g.row;
          const set: Record<string, unknown> = {};
          const changes: ReturnType<typeof change.plain>[] = [];
          const names: string[] = [];
          if (input.title !== undefined && input.title !== cur.title) {
            set.title = input.title;
            changes.push(change.content('title', noteHash(input.title)));
            names.push('title');
          }
          if (input.description !== undefined && input.description !== cur.description) {
            set.description = input.description;
            changes.push(change.content('description', noteHash(input.description ?? '')));
            names.push('description');
          }
          if (input.owner !== undefined) {
            const m = await this.goalOwner(tx, input.owner, { brand: g.brand, chain: g.chain });
            if (m.id !== cur.owner_membership_id) {
              set.owner_membership_id = m.id;
              changes.push(change.plain('owner', null, input.owner));
              names.push('owner');
            }
          }
          let statusChanged = false;
          if (input.status !== undefined && input.status !== cur.status) {
            if (!statusChangeAllowed(cur.status, input.status))
              throw new TenancyError('conflict', {
                issues: [
                  issue(
                    '/status',
                    'invalid_status',
                    'A goal that has left draft cannot return to draft.',
                  ),
                ],
              });
            set.status = input.status;
            changes.push(change.plain('status', cur.status, input.status));
            names.push('status');
            statusChanged = true;
          }
          if (input.period !== undefined) {
            const same =
              input.period.kind === cur.period_kind &&
              input.period.start === cur.period_start &&
              input.period.end === cur.period_end;
            if (!same) {
              set.period_kind = input.period.kind;
              set.period_start = input.period.start;
              set.period_end = input.period.end;
              changes.push(change.plain('period_start', cur.period_start, input.period.start));
              changes.push(change.plain('period_end', cur.period_end, input.period.end));
              names.push('period');
            }
          }
          const basis = input.basis ?? cur.progress_basis;
          if (input.basis !== undefined && input.basis !== cur.progress_basis) {
            set.progress_basis = input.basis;
            changes.push(change.plain('basis', cur.progress_basis, input.basis));
            names.push('basis');
          }
          if (basis !== 'manual') {
            // Derived progress carries no measurement of its own (the values stay in the history).
            if (input.metric && (input.metric.target !== null || input.metric.unit !== null))
              throw invalid(
                issue(
                  '/metric',
                  'conflicting',
                  'Progress from key results or linked work is derived; leave out the measurement.',
                ),
              );
            if (cur.target_value !== null || cur.unit !== null || cur.current_value !== null) {
              Object.assign(set, {
                unit: null,
                baseline_value: null,
                target_value: null,
                current_value: null,
              });
              names.push('metric');
            }
          } else if (input.metric !== undefined) {
            const m: Metric = input.metric;
            const keepCurrent = m.target !== null ? (m.current ?? cur.current_value) : null;
            Object.assign(set, {
              unit: m.unit,
              baseline_value: asNumber(m.baseline),
              target_value: asNumber(m.target),
              current_value: asNumber(keepCurrent),
            });
            changes.push(change.plain('target', asNumber(cur.target_value), asNumber(m.target)));
            changes.push(
              change.plain('baseline', asNumber(cur.baseline_value), asNumber(m.baseline)),
            );
            names.push('metric');
          }
          if (!names.length) {
            return {
              status: 200,
              ref: { id: g.publicId, type: 'goal' },
              data: await this.renderGoal(tx, p, g.publicId),
            };
          }
          await tx.db
            .updateTable('goals.goal')
            .set({
              ...set,
              updated_at: new Date(),
              updated_by_membership_id: p.membershipId,
              version: cur.version + 1,
            })
            .where('id', '=', g.id)
            .execute();
          await markGoalDirty(tx, g.id);
          const target = { id: g.id, publicId: g.publicId, brandId: g.brand?.id ?? null };
          await this.goalAudit(
            tx,
            caller,
            p,
            'goal.updated',
            target,
            changes.length ? changes : [change.plain('fields', null, names.join(','))],
          );
          await this.goalEvent(
            tx,
            caller,
            p,
            'goals.goal.updated',
            { type: 'goals.goal', id: g.id },
            { change: names.slice(0, 8).join(',') },
            target.brandId,
            0,
          );
          if (statusChanged)
            await this.goalEvent(
              tx,
              caller,
              p,
              'goals.goal.status_changed',
              { type: 'goals.goal', id: g.id },
              { status: input.status as string },
              target.brandId,
              1,
            );
          return {
            status: 200,
            ref: { id: g.publicId, type: 'goal' },
            data: await this.renderGoal(tx, p, g.publicId),
          };
        },
        async (tx, p, ref) => this.renderGoal(tx, p, ref.id),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Key results
  // ---------------------------------------------------------------------------------------------

  protected async loadKeyResult(
    tx: WorkspaceTransaction,
    g: LoadedGoal,
    publicId: unknown,
    opts: { lock?: boolean } = {},
  ): Promise<KeyResultRow | undefined> {
    if (!isPublic(publicId, 'kr')) return undefined;
    let q = tx.db
      .selectFrom('goals.key_result as k')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'k.workspace_id').onRef('r.id', '=', 'k.id'),
      )
      .selectAll('k')
      .select(['r.public_id'])
      .where('r.public_id', '=', publicId)
      .where('k.goal_id', '=', g.id)
      .where('k.lifecycle_state', 'in', ['active', 'archived']);
    if (opts.lock) q = q.forUpdate('k');
    const r = await q.executeTakeFirst();
    if (!r) return undefined;
    return {
      ...(r as unknown as KeyResultRow),
      baseline_value: num(r.baseline_value),
      target_value: num(r.target_value),
      current_value: num(r.current_value),
      latest_percent: num(r.latest_percent),
      latest_checkin_at: r.latest_checkin_at ? new Date(r.latest_checkin_at) : null,
      version: Number(r.version),
    } as KeyResultRow;
  }

  protected async renderKeyResult(
    tx: WorkspaceTransaction,
    p: Principal,
    goalPublic: string,
    krPublic: string,
  ) {
    const g = await this.loadGoal(tx, p, goalPublic);
    const kr = await this.loadKeyResult(tx, g, krPublic);
    if (!kr) throw new TenancyError('not_found');
    const krs = new Map([[g.id, [kr]]]);
    const links = await this.linksOf(tx, [g.id]);
    const progress = await this.progressOf(tx, p, [g.row] as never, krs, links);
    const people = await this.goalPeople(tx, p, [kr.owner_membership_id]);
    const ids = await this.checkinPublicIds(tx, [kr.latest_checkin_id]);
    return { ...this.keyResultView(kr, progress.kr.get(kr.id)!, people, ids), goal: g.publicId };
  }

  async createKeyResult(caller: Caller, ws: unknown, goal: unknown, body: unknown, req: Mutation) {
    const input = parseKeyResultCreate(body);
    return this.gTrack('goals.changes', 'key_result_create', () =>
      this.mutate(
        caller,
        'key_result.create',
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const g = await this.loadGoal(tx, p, goal, { lock: true });
          this.requireGoalActive(g);
          this.requireGoalAction(p, 'record.update', g);
          const n = await sql<{ n: string }>`SELECT count(*)::text AS n FROM goals.key_result
             WHERE workspace_id = ${tx.workspaceId} AND goal_id = ${g.id} AND lifecycle_state <> 'purged'`.execute(
            tx.db,
          );
          if (Number(n.rows[0]?.n ?? 0) >= this.ws.goalKeyResultsMax)
            throw invalid(
              issue(
                '/',
                'too_many',
                `A goal can hold at most ${this.ws.goalKeyResultsMax} key results.`,
              ),
            );
          const owner = input.owner
            ? await this.goalOwner(tx, input.owner, { brand: g.brand, chain: g.chain })
            : null;
          const id = newUuidV7();
          const publicId = newPublicId('kr');
          const cmd = this.cmd(caller, p, g.brand?.id ?? null);
          await tx.db
            .insertInto('core.record')
            .values({
              id,
              public_id: publicId,
              record_type: 'key_result',
              workspace_id: tx.workspaceId,
              brand_id: g.brand?.id ?? null,
              source_kind: 'ui',
              source_ref: null,
              created_by_actor_type: cmd.actor.type,
              created_by_actor_id: cmd.actor.id,
            })
            .execute();
          const rank = await this.nextRank(
            tx,
            'goals.key_result',
            (q: any) => q.where('goal_id', '=', g.id), // eslint-disable-line @typescript-eslint/no-explicit-any
            'last',
          );
          await tx.db
            .insertInto('goals.key_result')
            .values({
              id,
              workspace_id: tx.workspaceId,
              brand_id: g.brand?.id ?? null,
              scope_key: g.row.scope_key,
              goal_id: g.id,
              title: input.title,
              owner_membership_id: owner?.id ?? p.membershipId,
              progress_basis: input.basis,
              unit: input.metric.unit,
              baseline_value: asNumber(input.metric.baseline),
              target_value: asNumber(input.metric.target),
              current_value: asNumber(input.metric.current),
              rank,
              created_by_membership_id: p.membershipId,
              updated_by_membership_id: p.membershipId,
            })
            .execute();
          await markGoalDirty(tx, g.id);
          const target = { id, publicId, brandId: g.brand?.id ?? null };
          await this.goalAudit(
            tx,
            caller,
            p,
            'key_result.created',
            target,
            [
              change.content('title', noteHash(input.title)),
              change.plain('goal', null, g.publicId),
              change.plain('basis', null, input.basis),
              change.plain('target', null, asNumber(input.metric.target)),
            ],
            'key_result',
          );
          await this.goalEvent(
            tx,
            caller,
            p,
            'goals.key_result.created',
            { type: 'goals.key_result', id },
            { progress_basis: input.basis },
            target.brandId,
          );
          return {
            status: 201,
            ref: { id: publicId, type: 'key_result' },
            data: await this.renderKeyResultOf(tx, p, g.publicId, publicId),
          };
        },
        async (tx, p, ref) => this.renderKeyResultByPublic(tx, p, ref.id),
      ),
    );
  }

  protected async renderKeyResultOf(
    tx: WorkspaceTransaction,
    p: Principal,
    goalPublic: string,
    krPublic: string,
  ) {
    return this.renderKeyResult(tx, p, goalPublic, krPublic);
  }

  /** A replay renders by the key result's own identifier. */
  protected async renderKeyResultByPublic(
    tx: WorkspaceTransaction,
    p: Principal,
    krPublic: string,
  ) {
    const r = await sql<{ goal_public: string }>`
      SELECT gr.public_id AS goal_public FROM goals.key_result k
        JOIN core.record kr ON kr.workspace_id = k.workspace_id AND kr.id = k.id
        JOIN core.record gr ON gr.workspace_id = k.workspace_id AND gr.id = k.goal_id
       WHERE kr.public_id = ${krPublic}`.execute(tx.db);
    if (!r.rows[0]) throw new TenancyError('not_found');
    return this.renderKeyResult(tx, p, r.rows[0].goal_public, krPublic);
  }

  async updateKeyResult(
    caller: Caller,
    ws: unknown,
    goal: unknown,
    kr: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const input = parseKeyResultUpdate(body);
    return this.gTrack('goals.changes', 'key_result_update', () =>
      this.mutate(
        caller,
        'key_result.update',
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const g = await this.loadGoal(tx, p, goal, { lock: true });
          this.requireGoalActive(g);
          this.requireGoalAction(p, 'record.update', g);
          const cur = await this.loadKeyResult(tx, g, kr, { lock: true });
          if (!cur || cur.lifecycle_state !== 'active') throw new TenancyError('not_found');
          requireVersion(this.expectedVersion(req, input), cur.version);
          const set: Record<string, unknown> = {};
          const names: string[] = [];
          const changes: ReturnType<typeof change.plain>[] = [];
          if (input.title !== undefined && input.title !== cur.title) {
            set.title = input.title;
            changes.push(change.content('title', noteHash(input.title)));
            names.push('title');
          }
          if (input.owner !== undefined) {
            const m = await this.goalOwner(tx, input.owner, { brand: g.brand, chain: g.chain });
            if (m.id !== cur.owner_membership_id) {
              set.owner_membership_id = m.id;
              changes.push(change.plain('owner', null, input.owner));
              names.push('owner');
            }
          }
          const basis = input.basis ?? cur.progress_basis;
          if (input.basis !== undefined && input.basis !== cur.progress_basis) {
            set.progress_basis = input.basis;
            changes.push(change.plain('basis', cur.progress_basis, input.basis));
            names.push('basis');
          }
          if (basis === 'linked_work') {
            if (input.metric && (input.metric.target !== null || input.metric.unit !== null))
              throw invalid(
                issue(
                  '/metric',
                  'conflicting',
                  'A key result measured by linked work is derived; leave out the measurement.',
                ),
              );
            if (cur.target_value !== null || cur.unit !== null) {
              Object.assign(set, {
                unit: null,
                baseline_value: null,
                target_value: null,
                current_value: null,
              });
              names.push('metric');
            }
          } else if (input.metric !== undefined) {
            const m = input.metric;
            Object.assign(set, {
              unit: m.unit,
              baseline_value: asNumber(m.baseline),
              target_value: asNumber(m.target),
              current_value: asNumber(m.target !== null ? (m.current ?? cur.current_value) : null),
            });
            changes.push(change.plain('target', asNumber(cur.target_value), asNumber(m.target)));
            names.push('metric');
          }
          if (input.after !== undefined) {
            if (input.after === kr)
              throw invalid(issue('/after', 'invalid_reference', 'Choose another key result.'));
            const afterRow = input.after ? await this.loadKeyResult(tx, g, input.after) : null;
            if (input.after && !afterRow)
              throw invalid(
                issue('/after', 'invalid_reference', 'Choose a key result of this goal.'),
              );
            set.rank = await this.nextRank(
              tx,
              'goals.key_result',
              (q: any) => q.where('goal_id', '=', g.id).where('id', '<>', cur.id), // eslint-disable-line @typescript-eslint/no-explicit-any
              afterRow?.id ?? null,
            );
            names.push('order');
          }
          if (names.length) {
            await tx.db
              .updateTable('goals.key_result')
              .set({
                ...set,
                updated_at: new Date(),
                updated_by_membership_id: p.membershipId,
                version: cur.version + 1,
              })
              .where('id', '=', cur.id)
              .execute();
            await markGoalDirty(tx, g.id);
            const target = { id: cur.id, publicId: cur.public_id, brandId: g.brand?.id ?? null };
            await this.goalAudit(
              tx,
              caller,
              p,
              'key_result.updated',
              target,
              changes.length ? changes : [change.plain('fields', null, names.join(','))],
              'key_result',
            );
            await this.goalEvent(
              tx,
              caller,
              p,
              'goals.key_result.updated',
              { type: 'goals.key_result', id: cur.id },
              { change: names.join(',') },
              target.brandId,
            );
          }
          return {
            status: 200,
            ref: { id: cur.public_id, type: 'key_result' },
            data: await this.renderKeyResult(tx, p, g.publicId, cur.public_id),
          };
        },
        async (tx, p, ref) => this.renderKeyResultByPublic(tx, p, ref.id),
      ),
    );
  }

  /** Archive or restore one key result (it never leaves its goal; purge is the goal's). */
  async keyResultLifecycle(
    caller: Caller,
    ws: unknown,
    goal: unknown,
    kr: unknown,
    verb: 'archive' | 'unarchive',
    req: Mutation,
  ) {
    return this.gTrack('goals.changes', `key_result_${verb}`, () =>
      this.mutate(
        caller,
        `key_result.${verb}`,
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const g = await this.loadGoal(tx, p, goal, { lock: true });
          this.requireGoalActive(g);
          const cur = await this.loadKeyResult(tx, g, kr, { lock: true });
          if (!cur) throw new TenancyError('not_found');
          if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), cur.version);
          const facts = {
            id: cur.id,
            brand: g.brand,
            lifecycleState: cur.lifecycle_state,
            chain: g.chain,
          };
          const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
          if (verb === 'archive') {
            if (cur.lifecycle_state !== 'active') throw new TenancyError('conflict');
            await this.d.lifecycle.archive(
              tx,
              this.issueLifecycle(tx, p, 'record.archive', facts),
              input,
              cur.id,
            );
          } else {
            if (cur.lifecycle_state !== 'archived') throw new TenancyError('conflict');
            await this.d.lifecycle.unarchive(
              tx,
              this.issueLifecycle(tx, p, 'record.restore', facts),
              input,
              cur.id,
            );
          }
          await markGoalDirty(tx, g.id);
          await bumpEpoch(tx, 'workspace', null);
          return {
            status: 200,
            ref: { id: cur.public_id, type: 'key_result' },
            data: {
              id: cur.public_id,
              type: 'key_result' as const,
              lifecycle_state: verb === 'archive' ? ('archived' as const) : ('active' as const),
            },
          };
        },
        async (tx, _p, ref) => {
          const r = await tx.db
            .selectFrom('core.record')
            .select(['public_id', 'lifecycle_state'])
            .where('public_id', '=', ref.id)
            .executeTakeFirstOrThrow();
          return {
            id: r.public_id,
            type: 'key_result' as const,
            lifecycle_state: r.lifecycle_state as 'active' | 'archived',
          };
        },
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Links (GOAL-003)
  // ---------------------------------------------------------------------------------------------

  /**
   * Links a project or task to the goal (or one of its key results). The linker must be able to
   * read the target; an unknown, unreadable, or wrongly placed target is the same invalid
   * reference, so a link request discloses nothing about work the caller cannot read.
   */
  async addGoalLink(caller: Caller, ws: unknown, goal: unknown, body: unknown, req: Mutation) {
    const input = parseGoalLink(body);
    return this.gTrack('goals.changes', 'link_add', () =>
      this.mutate(
        caller,
        'goal.link',
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const g = await this.loadGoal(tx, p, goal, { lock: true });
          this.requireGoalActive(g);
          this.requireGoalAction(p, 'record.update', g);
          const bad = () =>
            invalid(
              issue('/target', 'invalid_reference', 'Choose a project or task you can read.'),
            );
          let kr: KeyResultRow | undefined;
          if (input.keyResult) {
            kr = await this.loadKeyResult(tx, g, input.keyResult);
            if (!kr || kr.lifecycle_state !== 'active')
              throw invalid(
                issue('/key_result', 'invalid_reference', 'Choose a key result of this goal.'),
              );
          }
          let targetId: string;
          let targetBrandId: string;
          let kind: 'project' | 'task';
          let targetPublic: string;
          if (isPublic(input.target, 'prj')) {
            const pr = await this.loadProject(tx, p, input.target).catch((e) => {
              if (e instanceof TenancyError) throw bad();
              throw e;
            });
            if (pr.lifecycleState !== 'active') throw bad();
            if (g.projectId)
              throw invalid(
                issue('/target', 'wrong_scope', "A project goal links the project's tasks."),
              );
            targetId = pr.id;
            targetBrandId = pr.brand.id;
            kind = 'project';
            targetPublic = pr.publicId;
          } else {
            const t = await this.loadTask(tx, p, input.target).catch((e) => {
              if (e instanceof TenancyError) throw bad();
              throw e;
            });
            if (t.lifecycleState !== 'active') throw bad();
            if (g.projectId && t.row.project_id !== g.projectId)
              throw invalid(
                issue('/target', 'wrong_scope', 'A project goal links tasks of its own project.'),
              );
            targetId = t.id;
            targetBrandId = t.brand.id;
            kind = 'task';
            targetPublic = t.publicId;
          }
          if (g.brand && g.brand.id !== targetBrandId)
            throw invalid(
              issue('/target', 'wrong_scope', 'A brand goal links work in its own brand.'),
            );
          const n = await sql<{ n: string }>`SELECT count(*)::text AS n FROM goals.goal_link
             WHERE workspace_id = ${tx.workspaceId} AND goal_id = ${g.id}`.execute(tx.db);
          const existing = await sql<{ id: string }>`SELECT id FROM goals.goal_link
             WHERE workspace_id = ${tx.workspaceId} AND goal_id = ${g.id}
               AND coalesce(key_result_id, ${NIL}::uuid) = ${kr?.id ?? NIL}::uuid AND target_record_id = ${targetId}`.execute(
            tx.db,
          );
          if (!existing.rows[0]) {
            if (Number(n.rows[0]?.n ?? 0) >= this.ws.goalLinksMax)
              throw invalid(
                issue(
                  '/target',
                  'too_many',
                  `A goal can link at most ${this.ws.goalLinksMax} projects and tasks.`,
                ),
              );
            await tx.db
              .insertInto('goals.goal_link')
              .values({
                id: newUuidV7(),
                workspace_id: tx.workspaceId,
                goal_id: g.id,
                key_result_id: kr?.id ?? null,
                target_kind: kind,
                target_record_id: targetId,
                target_brand_id: targetBrandId,
                created_by_membership_id: p.membershipId,
              })
              .execute();
            await markGoalDirty(tx, g.id);
            const target = { id: g.id, publicId: g.publicId, brandId: g.brand?.id ?? null };
            await this.goalAudit(tx, caller, p, 'goal.link_added', target, [
              change.plain('target', null, targetPublic),
              change.plain('key_result', null, kr?.public_id ?? null),
            ]);
            await this.goalEvent(
              tx,
              caller,
              p,
              'goals.goal.link_changed',
              { type: 'goals.goal_link', id: g.id },
              { change: 'added', target_kind: kind },
              target.brandId,
            );
          }
          return {
            status: existing.rows[0] ? 200 : 201,
            ref: { id: g.publicId, type: 'goal' },
            data: await this.renderGoal(tx, p, g.publicId),
          };
        },
        async (tx, p, ref) => this.renderGoal(tx, p, ref.id),
      ),
    );
  }

  /** Removes a link by its target (idempotent: removing a link that is not there succeeds). */
  async removeGoalLink(
    caller: Caller,
    ws: unknown,
    goal: unknown,
    query: Record<string, unknown>,
    req: Mutation,
  ) {
    const input = parseGoalLink({ target: query.target, key_result: query.key_result });
    return this.gTrack('goals.changes', 'link_remove', () =>
      this.mutate(
        caller,
        'goal.unlink',
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const g = await this.loadGoal(tx, p, goal, { lock: true });
          this.requireGoalActive(g);
          this.requireGoalAction(p, 'record.update', g);
          let kr: KeyResultRow | undefined;
          if (input.keyResult) kr = await this.loadKeyResult(tx, g, input.keyResult);
          const rec = await tx.db
            .selectFrom('core.record')
            .select(['id', 'record_type'])
            .where('public_id', '=', input.target)
            .executeTakeFirst();
          const del = rec
            ? await sql`DELETE FROM goals.goal_link WHERE workspace_id = ${tx.workspaceId} AND goal_id = ${g.id}
                AND coalesce(key_result_id, ${NIL}::uuid) = ${kr?.id ?? NIL}::uuid AND target_record_id = ${rec.id}`.execute(
                tx.db,
              )
            : null;
          if (del && Number(del.numAffectedRows ?? 0) > 0) {
            await markGoalDirty(tx, g.id);
            const target = { id: g.id, publicId: g.publicId, brandId: g.brand?.id ?? null };
            await this.goalAudit(tx, caller, p, 'goal.link_removed', target, [
              change.plain('target', input.target, null),
            ]);
            await this.goalEvent(
              tx,
              caller,
              p,
              'goals.goal.link_changed',
              { type: 'goals.goal_link', id: g.id },
              { change: 'removed', target_kind: rec!.record_type },
              target.brandId,
            );
          }
          return {
            status: 200,
            ref: { id: g.publicId, type: 'goal' },
            data: await this.renderGoal(tx, p, g.publicId),
          };
        },
        async (tx, p, ref) => this.renderGoal(tx, p, ref.id),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Check-ins (GOAL-005, GOAL-006)
  // ---------------------------------------------------------------------------------------------

  /**
   * Appends a manual check-in to a goal or one of its key results. Only a measured-by-hand goal or
   * key result takes a value or percentage (derived progress is never overwritten); every check-in
   * may state a confidence and a note. History is append-only; the goal's latest-update pointers
   * move with it in the same transaction, so "latest update" and "confidence" are never ahead of
   * or behind the history.
   */
  async recordCheckin(caller: Caller, ws: unknown, goal: unknown, body: unknown, req: Mutation) {
    const input = parseCheckin(body);
    return this.gTrack('goals.changes', 'checkin', () =>
      this.mutate(
        caller,
        'goal.checkin',
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const g = await this.loadGoal(tx, p, goal, { lock: true });
          this.requireGoalActive(g);
          this.requireGoalAction(p, 'record.update', g);
          if (g.row.status !== 'draft' && g.row.status !== 'active')
            throw new TenancyError('conflict', {
              issues: [
                issue('/', 'goal_closed', 'This goal is closed. Reopen it to record an update.'),
              ],
            });
          const r = await this.c.limiter.consume('goal.checkin' as never, p.membershipId);
          if (!r.allowed)
            throw new TenancyError('rate_limited', { retryAfterSeconds: r.retryAfterSeconds });
          let kr: KeyResultRow | undefined;
          if (input.keyResult) {
            kr = await this.loadKeyResult(tx, g, input.keyResult, { lock: true });
            if (!kr || kr.lifecycle_state !== 'active')
              throw invalid(
                issue('/key_result', 'invalid_reference', 'Choose a key result of this goal.'),
              );
          }
          const own = kr ?? g.row;
          const basis = kr ? kr.progress_basis : g.row.progress_basis;
          const measured = input.value !== null || input.percent !== null;
          if (measured && basis !== 'manual')
            throw invalid(
              issue(
                input.value !== null ? '/value' : '/percent',
                'derived',
                'This progress is derived from key results or linked work, so it cannot be set by hand. Send a confidence and a note.',
              ),
            );
          if (input.value !== null && own.target_value === null)
            throw invalid(
              issue(
                '/value',
                'no_target',
                'This has no target to measure a value against. Send a percentage, or set a target first.',
              ),
            );
          if (input.percent !== null && own.target_value !== null)
            throw invalid(
              issue(
                '/percent',
                'has_target',
                'This is measured against a target. Send the current value.',
              ),
            );
          const percent =
            input.value !== null
              ? metricPercent({
                  baseline: own.baseline_value,
                  target: own.target_value,
                  current: input.value,
                })
              : input.percent;
          const id = newUuidV7();
          const publicId = newPublicId('gci');
          // Taken after the goal's lock, so check-ins order by when they were recorded, not by when
          // their transactions began (the history and the latest pointer always agree).
          const at = (await sql<{ t: Date }>`SELECT clock_timestamp() AS t`.execute(tx.db)).rows[0]!
            .t;
          await tx.db
            .insertInto('goals.goal_checkin')
            .values({
              id,
              public_id: publicId,
              workspace_id: tx.workspaceId,
              goal_id: g.id,
              key_result_id: kr?.id ?? null,
              source: 'manual',
              value: asNumber(input.value),
              progress_percent: asNumber(percent),
              confidence: input.confidence,
              note: input.note,
              author_membership_id: p.membershipId,
              created_at: at,
            })
            .execute();
          const set = {
            latest_checkin_id: id,
            latest_checkin_at: at,
            ...(input.confidence ? { latest_confidence: input.confidence } : {}),
            ...(input.value !== null ? { current_value: asNumber(input.value) } : {}),
            ...(measured ? { latest_percent: asNumber(percent) } : {}),
            updated_at: at,
            updated_by_membership_id: p.membershipId,
            version: own.version + 1,
          };
          if (kr)
            await tx.db.updateTable('goals.key_result').set(set).where('id', '=', kr.id).execute();
          else await tx.db.updateTable('goals.goal').set(set).where('id', '=', g.id).execute();
          await markGoalDirty(tx, g.id);
          const target = { id: g.id, publicId: g.publicId, brandId: g.brand?.id ?? null };
          await this.goalAudit(tx, caller, p, 'goal.checkin_recorded', target, [
            change.plain('check_in', null, publicId),
            change.plain('key_result', null, kr?.public_id ?? null),
            change.plain('value', null, asNumber(input.value)),
            change.plain('progress_percent', null, asNumber(percent)),
            change.plain('confidence', null, input.confidence),
            ...(input.note ? [change.content('note', noteHash(input.note))] : []),
          ]);
          await this.goalEvent(
            tx,
            caller,
            p,
            'goals.goal.checkin_recorded',
            { type: 'goals.goal_checkin', id },
            { source: 'manual', confidence: input.confidence, has_value: measured },
            target.brandId,
          );
          return {
            status: 201,
            ref: { id: publicId, type: 'goal_checkin' },
            data: await this.renderCheckin(tx, p, publicId),
          };
        },
        async (tx, p, ref) => this.renderCheckin(tx, p, ref.id),
      ),
    );
  }

  protected async renderCheckin(tx: WorkspaceTransaction, p: Principal, publicId: string) {
    const c = await sql<{
      public_id: string;
      goal_public: string;
      key_result_id: string | null;
      kr_public: string | null;
      source: string;
      value: string | null;
      progress_percent: string | null;
      confidence: ConfidenceKey | null;
      note: string | null;
      author_membership_id: string | null;
      created_at: Date;
    }>`SELECT c.public_id, gr.public_id AS goal_public, c.key_result_id, kr.public_id AS kr_public, c.source,
              c.value::text AS value, c.progress_percent::text AS progress_percent, c.confidence, c.note,
              c.author_membership_id, c.created_at
         FROM goals.goal_checkin c
         JOIN core.record gr ON gr.workspace_id = c.workspace_id AND gr.id = c.goal_id
         LEFT JOIN core.record kr ON kr.workspace_id = c.workspace_id AND kr.id = c.key_result_id
        WHERE c.public_id = ${publicId}`.execute(tx.db);
    const r = c.rows[0];
    if (!r) throw new TenancyError('not_found');
    // The caller must still read the goal (a replay after revocation is not found).
    const g = await this.loadGoal(tx, p, r.goal_public);
    const people = await this.goalPeople(tx, p, [r.author_membership_id]);
    return {
      id: r.public_id,
      type: 'goal_checkin' as const,
      goal: { id: g.publicId, version: g.row.version },
      source: r.source,
      key_result: r.kr_public,
      value: num(r.value),
      progress_percent: num(r.progress_percent),
      confidence: r.confidence,
      confidence_label: r.confidence ? CONFIDENCE_LABEL[r.confidence] : null,
      note: r.note,
      author: r.author_membership_id ? (people.get(r.author_membership_id) ?? null) : null,
      created_at: iso(r.created_at),
    };
  }

  /**
   * Recomputes a goal's derived state now (idempotent): the same inputs change nothing. This is
   * also the recovery path for a goal whose background recalculation is failing.
   */
  async recalculateGoal(caller: Caller, ws: unknown, goal: unknown, req: Mutation) {
    return this.gTrack('goals.changes', 'recalculate', () =>
      this.mutate(
        caller,
        'goal.recalculate',
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const g = await this.loadGoal(tx, p, goal, { lock: true });
          this.requireGoalActive(g);
          this.requireGoalAction(p, 'record.update', g);
          await markGoalDirty(tx, g.id);
          await recalcGoal(
            tx,
            this.workWriter,
            g.id,
            {
              goalUpdateStaleDays: this.ws.goalUpdateStaleDays,
              goalsRecalcIntervalMinutes: this.ws.goalsRecalcIntervalMinutes,
            },
            new Date(),
          );
          return {
            status: 200,
            ref: { id: g.publicId, type: 'goal' },
            data: await this.renderGoal(tx, p, g.publicId),
          };
        },
        async (tx, p, ref) => this.renderGoal(tx, p, ref.id),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  async goalLifecycle(
    caller: Caller,
    ws: unknown,
    goal: unknown,
    verb: 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge',
    req: Mutation,
  ) {
    return this.gTrack('goals.changes', verb, () =>
      this.mutate(
        caller,
        `goal.${verb}`,
        ws,
        req,
        async (tx, p) => {
          this.requireMemberKind(p);
          const g = await this.loadGoal(tx, p, goal, {
            lock: true,
            allowTrashed: verb === 'restore' || verb === 'purge',
          });
          if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), g.row.version);
          const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
          const facts = {
            id: g.id,
            brand: g.brand,
            lifecycleState: g.lifecycleState,
            chain: g.chain,
          };
          const state = await tx.db
            .selectFrom('core.record')
            .select(['lifecycle_state', 'deletion_batch_id'])
            .where('id', '=', g.id)
            .executeTakeFirstOrThrow();
          const conflict = () =>
            new TenancyError('conflict', {
              issues: [
                issue('/', 'invalid_state', "This goal can't do that in its current state."),
              ],
            });
          if (verb === 'archive') {
            if (state.lifecycle_state !== 'active') throw conflict();
            await this.d.lifecycle.archive(
              tx,
              this.issueLifecycle(tx, p, 'record.archive', facts),
              input,
              g.id,
            );
          } else if (verb === 'unarchive') {
            if (state.lifecycle_state !== 'archived') throw conflict();
            await this.d.lifecycle.unarchive(
              tx,
              this.issueLifecycle(tx, p, 'record.restore', facts),
              input,
              g.id,
            );
          } else if (verb === 'trash') {
            if (state.lifecycle_state !== 'active' && state.lifecycle_state !== 'archived')
              throw conflict();
            await this.d.lifecycle.trash(
              tx,
              this.issueLifecycle(tx, p, 'record.trash', facts),
              input,
              g.id,
            );
          } else {
            if (state.lifecycle_state !== 'trashed') throw conflict();
            const own = await tx.db
              .selectFrom('core.deletion_batch')
              .select('id')
              .where('id', '=', state.deletion_batch_id!)
              .where('root_record_id', '=', g.id)
              .executeTakeFirst();
            if (!own) throw conflict();
            if (verb === 'restore')
              await this.d.lifecycle.restore(
                tx,
                this.issueLifecycle(tx, p, 'record.restore', facts),
                input,
                own.id,
              );
            else
              await this.d.lifecycle.requestPurge(
                tx,
                this.issueLifecycle(tx, p, 'record.purge', facts),
                input,
                own.id,
              );
          }
          if (verb !== 'purge') await markGoalDirty(tx, g.id);
          await bumpEpoch(tx, 'workspace', null);
          const after = await tx.db
            .selectFrom('core.record')
            .select('lifecycle_state')
            .where('id', '=', g.id)
            .executeTakeFirstOrThrow();
          return {
            status: verb === 'purge' ? 202 : 200,
            ref: { id: g.publicId, type: 'goal' },
            data: { id: g.publicId, type: 'goal' as const, lifecycle_state: after.lifecycle_state },
          };
        },
        async (tx, _p, ref) => {
          const r = await tx.db
            .selectFrom('core.record')
            .select(['public_id', 'lifecycle_state'])
            .where('public_id', '=', ref.id)
            .executeTakeFirstOrThrow();
          return { id: r.public_id, type: 'goal' as const, lifecycle_state: r.lifecycle_state };
        },
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Export (bounded, authorized, audited)
  // ---------------------------------------------------------------------------------------------

  /**
   * CSV or JSON of the goals (and their key results) the viewer may read, with the progress the
   * viewer sees. Larger sets than `GOALS_EXPORT_ROWS_MAX` are refused rather than truncated. The
   * export is audited; nothing is stored.
   */
  async exportGoals(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const format =
      query.format === 'json'
        ? 'json'
        : query.format === undefined || query.format === 'csv'
          ? 'csv'
          : null;
    if (!format) throw invalid(issue('/format', 'invalid_option', 'Choose csv or json.'));
    const { format: _f, ...rest } = query;
    const q = parseGoalList({ ...rest, limit: undefined }, this.ws.pageLimitMax);
    return this.gTrack('goals.reads', 'export', () =>
      this.inWorkspace(caller, ws, {}, async (tx, p) => {
        this.requireMemberKind(p);
        const max = this.ws.goalsExportRowsMax;
        const page = await this.goalPage(tx, p, { ...q, cursor: null }, max + 1);
        if (page.data.length > max)
          throw invalid(
            issue('/', 'too_many', `Narrow the filters: an export holds at most ${max} goals.`),
          );
        const ids = page.data.map((d) => d.id);
        const detail: Awaited<ReturnType<GoalService['renderGoal']>>[] = [];
        for (const id of ids) detail.push(await this.renderGoal(tx, p, id));
        const rows: unknown[][] = [];
        const json: unknown[] = [];
        for (const d of detail) {
          const scope =
            d.scope.kind === 'workspace'
              ? 'Workspace'
              : d.scope.brand.kind === 'brand'
                ? d.scope.brand.name
                : '';
          const project = d.scope.kind === 'project' ? (d.scope.project?.name ?? '') : '';
          rows.push([
            'goal',
            d.id,
            d.id,
            d.title,
            scope,
            project,
            d.owner?.name ?? '',
            d.status,
            d.period.label,
            d.basis,
            d.metric.unit ?? '',
            d.metric.baseline ?? '',
            d.metric.target ?? '',
            d.metric.current ?? '',
            d.progress.percent ?? '',
            d.progress.source,
            d.latest.confidence ?? '',
            d.latest.at ?? '',
            d.freshness.update_state,
          ]);
          const krs = d.key_results.map((k) => {
            rows.push([
              'key_result',
              k.id,
              d.id,
              k.title,
              scope,
              project,
              k.owner?.name ?? '',
              '',
              d.period.label,
              k.basis,
              k.metric.unit ?? '',
              k.metric.baseline ?? '',
              k.metric.target ?? '',
              k.metric.current ?? '',
              k.progress.percent ?? '',
              k.progress.source,
              k.latest.confidence ?? '',
              k.latest.at ?? '',
              '',
            ]);
            return {
              id: k.id,
              title: k.title,
              basis: k.basis,
              metric: k.metric,
              progress: k.progress,
              latest: k.latest,
            };
          });
          json.push({
            id: d.id,
            title: d.title,
            scope,
            project,
            owner: d.owner?.name ?? null,
            status: d.status,
            period: d.period,
            basis: d.basis,
            metric: d.metric,
            progress: d.progress,
            latest: d.latest,
            freshness: d.freshness,
            key_results: krs,
          });
        }
        const header = [
          'kind',
          'id',
          'goal',
          'title',
          'scope',
          'project',
          'owner',
          'status',
          'period',
          'basis',
          'unit',
          'baseline',
          'target',
          'current',
          'progress_percent',
          'progress_source',
          'confidence',
          'latest_update',
          'update_state',
        ];
        await this.workWriter.write(tx, this.cmd(caller, p), {
          action: 'goals.exported',
          target: { type: 'workspace', recordId: tx.workspaceId, publicId: String(ws) },
          changes: [
            change.plain('format', null, format),
            change.plain('rows', null, String(rows.length)),
          ],
        });
        await this.d.security.record(tx, {
          category: 'export',
          action: 'goals.export',
          outcome: 'success',
          actor: { type: 'human', id: p.membershipId },
          subject: { type: 'workspace', id: tx.workspaceId },
          correlationId: caller.meta.correlationId,
        });
        const stamp = new Date().toISOString().slice(0, 10);
        return format === 'csv'
          ? { format, filename: `goals-${stamp}.csv`, body: csv(header, rows), rows: rows.length }
          : {
              format,
              filename: `goals-${stamp}.json`,
              body: JSON.stringify(
                {
                  exported_at: new Date().toISOString(),
                  scope_note:
                    'Goals you can read; progress from linked work covers work you can read.',
                  goals: json,
                },
                null,
                2,
              ),
              rows: rows.length,
            };
      }),
    );
  }

  // The week-old helper keeps `daysSince` used for callers that show "days since update".
  protected daysSinceUpdate(g: GoalRow, now: Date): number | null {
    return daysSince(g.latest_checkin_at, now);
  }

  protected linksFor(links: readonly LinkRow[], goalId: string) {
    return links.filter((l) => l.goal_id === goalId);
  }

  protected progressPercent(p: Progress): number | null {
    return p.percent;
  }
}
