import { createHash } from 'node:crypto';
import { sql, type RawBuilder, type WorkspaceTransaction } from '@pm/db';
import type { Principal } from '@pm/tenancy';
import { addDays, localDay } from '../../time/semantics.ts';
import { parseMicros, usdDisplay } from '../money.ts';
import { decideBrand } from '@pm/tenancy';
import { BASIS_MAX, type Basis } from './evidence.ts';

/**
 * Phase 7E (ADR-0042): the deterministic fact engine of a briefing. Every figure and item is read
 * as the recipient, inside one transaction, through the canonical readers (task signals, reviews,
 * workflow and timesheet approvals, the 3D time report, 3E capacity, the 7A usage ledger, 2A
 * project updates, 4E deliverable acceptance). Nothing here calls a provider or changes a record.
 * Each list is bounded; a bound that hides items is reported as truncation, never silently.
 */

export const BRIEFING_TEMPLATE_VERSION = 'briefing.v1';
export const BRIEFING_KINDS = [
  'owner_daily',
  'brand_daily',
  'weekly_review',
  'project_status',
  'release_readiness',
] as const;
export type BriefingKind = (typeof BRIEFING_KINDS)[number];
/** Items listed per section; counts always cover every authorized item. */
export const SECTION_ITEMS_MAX = 20;
/** Open tasks examined for blocked and stale signals (the rest is reported as not examined). */
export const SIGNAL_CANDIDATES_MAX = 200;
export const STATEMENTS_MAX = 400;

export const STATEMENT_KINDS = [
  'fact',
  'calculation',
  'excerpt',
  'suggestion',
  'unknown',
  'annotation',
  'unavailable',
] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

/**
 * An evidence reference. `rec` names the task, project, or document whose read access authorizes
 * the item; `perm` names a non-record right the item depends on; `self` items are the recipient's
 * own (their time, capacity, AI usage, earlier briefings).
 */
export interface Ref {
  type:
    | 'task'
    | 'project'
    | 'deliverable'
    | 'review'
    | 'approval'
    | 'timesheet'
    | 'project_update'
    | 'brand'
    | 'briefing'
    | 'correction'
    | 'time'
    | 'capacity'
    | 'ai_usage';
  id: string;
  v?: number | string;
  rec?: string;
  brand?: string;
  self?: true;
}

export interface Statement {
  section: string;
  kind: StatementKind;
  key: string;
  text: string;
  refs: Ref[];
  figures?: Record<string, string | number | boolean | null>;
  correctionId?: string | null;
  /**
   * Corrective review 01 (R1): the complete authorization basis of the statement, not only the
   * listed sample: every contributing record (including unlisted items and previous-window
   * contributors), brand, and exact-brand permission. Stored as protected evidence and re-checked
   * before any saved content is shown.
   */
  basis?: Basis;
}

export interface SectionCoverage {
  state: 'complete' | 'truncated' | 'partial' | 'unavailable';
  shown: number;
  total: number | null;
  note?: string;
}

export interface Coverage {
  sections: Record<string, SectionCoverage>;
  window_clamped?: boolean;
}

export interface BriefingScope {
  key: string;
  /** Internal ids (never stored in statements; scope public ids are). */
  brandId: string | null;
  projectId: string | null;
  brandPublicId: string | null;
  projectPublicId: string | null;
  label: string;
}

/** The canonical readers the engine reads through (bound to the gateway service chain). */
export interface BriefingReaders {
  visibility(): Promise<{
    where: (alias: string, opts?: { project?: RawBuilder<unknown> }) => RawBuilder<boolean>;
    brandIds: readonly string[];
  }>;
  signals(
    taskPublicIds: string[],
  ): Promise<Map<string, { stale: boolean; blocked: boolean | null }>>;
  reviews(): Promise<{
    data: Array<{
      id: string;
      subject: { id: string; type: string; title: string };
      kind: string;
      stale: boolean;
    }>;
    page: { has_more: boolean };
  }>;
  approvals(): Promise<{
    data: Array<{
      id: string;
      record: { id: string; type: string };
      can_decide?: boolean;
      self_requested?: boolean;
      state: string;
    }>;
  }>;
  timesheets(): Promise<{
    data: Array<
      { id: string; period?: { start: string; end: string } | null } & Record<string, unknown>
    >;
  }>;
  timeReport(q: Record<string, unknown>): Promise<{
    range: { from: string; to: string };
    rows: Array<
      { key: { id?: string | null; label: string } | Record<string, unknown> } & Record<
        string,
        unknown
      >
    >;
    truncated: boolean;
    totals: { planned_minutes: number; actual_seconds: number; entries: number };
    planned_measure: string;
  }>;
  capacity(
    from: string,
    to: string,
  ): Promise<{
    timezone: string;
    totals: {
      available_minutes: number;
      scheduled_minutes: number;
      estimated_minutes: number;
    } & Record<string, unknown>;
    brands: Array<{ brand: { id: string; name: string } } & Record<string, unknown>>;
    conflicts: Array<Record<string, unknown> & { kind: string }>;
  }>;
}

export interface BuildInput {
  kind: BriefingKind;
  scope: BriefingScope;
  timezone: string;
  windowStart: Date;
  windowEnd: Date;
  baseline: { publicId: string; windowStart: Date; windowEnd: Date; publishedAt: Date } | null;
  clamped: boolean;
  /** Whether generated wording could be produced (it is never required). */
  generated: { available: false; reason: string } | { available: true };
}

const DAY = 86_400_000;

export function fmtInstant(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

const quote = (s: string) => `“${s.replace(/\s+/g, ' ').trim().slice(0, 200)}”`;
const hours = (seconds: number) => Math.round((seconds / 3600) * 10) / 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A stable digest of figures, used as the version of a statement without a record version. */
export function figuresDigest(f: Record<string, unknown> | undefined): string {
  // Key order is not significant (figures read back from jsonb come out sorted).
  const sorted = Object.fromEntries(Object.entries(f ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

interface TaskRowLite {
  id: string;
  public_id: string;
  title: string;
  version: number;
  status_category: string;
  completed_at: Date | null;
  due_date: string | null;
  deadline_at: Date | null;
  requires_acceptance: boolean;
}

/**
 * Builds the statements of one briefing. Reads only through `tx` as the principal the readers are
 * bound to; `p` identifies the recipient for personal data (their time, capacity, AI usage).
 */
export async function buildStatements(
  tx: WorkspaceTransaction,
  p: Principal,
  readers: BriefingReaders,
  input: BuildInput,
): Promise<{ statements: Statement[]; coverage: Coverage }> {
  const out: Statement[] = [];
  const coverage: Coverage = { sections: {} };
  if (input.clamped) coverage.window_clamped = true;
  const tz = input.timezone;
  const { scope } = input;
  const vis = await readers.visibility();
  const taskScope = (alias: string): RawBuilder<boolean> =>
    scope.projectId
      ? sql<boolean>`${sql.ref(`${alias}.project_id`)} = ${scope.projectId}::uuid`
      : scope.brandId
        ? sql<boolean>`${sql.ref(`${alias}.brand_id`)} = ${scope.brandId}::uuid`
        : sql<boolean>`true`;
  const readableTask = sql<boolean>`r.lifecycle_state = 'active' AND ${vis.where('r', {
    project: sql`t.project_id`,
  })} AND ${taskScope('t')}`;
  const today = localDay(input.windowEnd, tz);
  const cover = (section: string, shown: number, total: number | null, note?: string) => {
    coverage.sections[section] = {
      state: total === null ? 'partial' : shown < total ? 'truncated' : 'complete',
      shown,
      total,
      ...(note ? { note } : {}),
    };
  };

  /** The complete record basis of a count: every authorized contributor, up to BASIS_MAX. */
  const basisOf = async (body: RawBuilder<unknown>, id = sql`r.public_id`) => {
    const rows = (
      await sql<{ id: string }>`SELECT DISTINCT ${id} AS id ${body} LIMIT ${BASIS_MAX + 1}`.execute(
        tx.db,
      )
    ).rows;
    return { ids: rows.slice(0, BASIS_MAX).map((r) => r.id), overflow: rows.length > BASIS_MAX };
  };
  const records = (...parts: Array<{ ids: string[]; overflow: boolean }>): Basis => ({
    records: [...new Set(parts.flatMap((x) => x.ids))],
    brands: [],
    perms: [],
    overflow: parts.some((x) => x.overflow),
  });
  /**
   * Corrective review 02: a statement whose basis exceeds BASIS_MAX keeps its overflow flag; the
   * composer then refuses to publish the briefing (fail closed). Nothing contributor-dependent (a
   * lower bound, a shown count, a size flag) is ever stored without its complete evidence.
   */
  const push = (s: Statement) => out.push(s);
  const coverOf = (section: string, shown: number, total: number, _overflow?: boolean) =>
    cover(section, shown, total);

  // -- Header: window, scope, baseline -----------------------------------------------------------
  out.push({
    section: 'overview',
    kind: 'fact',
    key: 'overview.window',
    text: input.baseline
      ? `This briefing covers ${fmtInstant(input.windowStart, tz)} to ${fmtInstant(input.windowEnd, tz)} (${tz}), continuing from your briefing published ${fmtInstant(input.baseline.publishedAt, tz)}.`
      : `This is your first ${KIND_LABEL[input.kind].toLowerCase()} for this scope, so there is no earlier briefing to compare with. It covers ${fmtInstant(input.windowStart, tz)} to ${fmtInstant(input.windowEnd, tz)} (${tz}).`,
    refs: input.baseline ? [{ type: 'briefing', id: input.baseline.publicId, self: true }] : [],
    figures: {
      window_start: input.windowStart.toISOString(),
      window_end: input.windowEnd.toISOString(),
      timezone: tz,
      baseline: input.baseline?.publicId ?? null,
    },
  });
  if (input.clamped)
    out.push({
      section: 'overview',
      kind: 'fact',
      key: 'overview.clamped',
      text: 'Your previous briefing is older than 31 days, so this one starts 31 days ago rather than at that briefing.',
      refs: [],
    });
  out.push({
    section: 'overview',
    kind: 'fact',
    key: 'overview.scope',
    text: `Scope: ${scope.label}. Everything below is what you can read now.`,
    refs: scope.projectPublicId
      ? [{ type: 'project', id: scope.projectPublicId, rec: scope.projectPublicId }]
      : scope.brandPublicId
        ? [{ type: 'brand', id: scope.brandPublicId, brand: scope.brandPublicId }]
        : [],
  });

  // -- Completed (claimed) work in the window ----------------------------------------------------
  const completedIn = (from: Date, to: Date) =>
    sql<TaskRowLite & { n: string }>`
      SELECT t.id, r.public_id, t.title, t.version, t.status_category, t.completed_at, t.due_date::text AS due_date,
             t.deadline_at, t.requires_acceptance, count(*) OVER () AS n
        FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
       WHERE t.status_category = 'done' AND t.completed_at >= ${from} AND t.completed_at < ${to}
         AND ${readableTask}
       ORDER BY t.completed_at DESC, t.id DESC
       LIMIT ${SECTION_ITEMS_MAX}`.execute(tx.db);
  const completedBasis = (from: Date, to: Date) =>
    basisOf(sql`FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
       WHERE t.status_category = 'done' AND t.completed_at >= ${from} AND t.completed_at < ${to}
         AND ${readableTask}`);
  const done = (await completedIn(input.windowStart, input.windowEnd)).rows;
  const doneTotal = Number(done[0]?.n ?? 0);
  const doneBasis = await completedBasis(input.windowStart, input.windowEnd);
  const prevBasis = input.baseline
    ? await completedBasis(input.baseline.windowStart, input.baseline.windowEnd)
    : { ids: [], overflow: false };
  const previous = input.baseline
    ? Number(
        (await completedIn(input.baseline.windowStart, input.baseline.windowEnd)).rows[0]?.n ?? 0,
      )
    : null;
  push({
    section: 'completed',
    kind: 'calculation',
    key: 'completed.count',
    text:
      (doneTotal
        ? `${plural(doneTotal, 'task')} you can read ${doneTotal === 1 ? 'was' : 'were'} marked done in this window.`
        : 'No task you can read was marked done in this window.') +
      (previous !== null
        ? ` In the previous briefing's window, counted the same way today: ${previous}.`
        : '') +
      ' Marked done is a claim of completion, not acceptance.',
    refs: done.map((t) => ({
      type: 'task' as const,
      id: t.public_id,
      rec: t.public_id,
      v: t.version,
    })),
    figures: { total: doneTotal, shown: done.length, previous_window_total: previous },
    // The full basis: every contributor in this window and in the previous one, not the sample.
    basis: records(doneBasis, prevBasis),
  });
  for (const t of done)
    out.push({
      section: 'completed',
      kind: 'fact',
      key: `completed.task:${t.public_id}`,
      text: `${quote(t.title)} was marked done ${fmtInstant(t.completed_at!, tz)}.`,
      refs: [{ type: 'task', id: t.public_id, rec: t.public_id, v: t.version }],
    });
  coverOf('completed', done.length, doneTotal, doneBasis.overflow || prevBasis.overflow);

  // -- Accepted deliverables, separately from claimed completion (BRF-007, 4E) -------------------
  const accepted = (
    await sql<{
      dlv_public: string;
      title: string;
      version_number: number;
      accepted_at: Date;
      task_public: string;
      task_version: number;
      current: boolean;
      n: string;
    }>`
      SELECT dr.public_id AS dlv_public, d.title, v.version_number, v.accepted_at, r.public_id AS task_public,
             t.version AS task_version, (d.accepted_version_id = v.id AND d.state = 'accepted') AS current,
             count(*) OVER () AS n
        FROM files.deliverable_version v
        JOIN files.deliverable d ON d.workspace_id = v.workspace_id AND d.id = v.deliverable_id
        JOIN core.record dr ON dr.workspace_id = d.workspace_id AND dr.id = d.id
        JOIN work.task t ON t.workspace_id = d.workspace_id AND t.id = d.task_id
        JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
       WHERE v.accepted_at IS NOT NULL AND v.accepted_at >= ${input.windowStart} AND v.accepted_at < ${input.windowEnd}
         AND ${readableTask}
       ORDER BY v.accepted_at DESC, v.id DESC
       LIMIT ${SECTION_ITEMS_MAX}`.execute(tx.db)
  ).rows;
  const acceptedTotal = Number(accepted[0]?.n ?? 0);
  const acceptedBasis = await basisOf(sql`FROM files.deliverable_version v
        JOIN files.deliverable d ON d.workspace_id = v.workspace_id AND d.id = v.deliverable_id
        JOIN work.task t ON t.workspace_id = d.workspace_id AND t.id = d.task_id
        JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
       WHERE v.accepted_at IS NOT NULL AND v.accepted_at >= ${input.windowStart} AND v.accepted_at < ${input.windowEnd}
         AND ${readableTask}`);
  push({
    section: 'accepted',
    kind: 'calculation',
    key: 'accepted.count',
    text: acceptedTotal
      ? `${plural(acceptedTotal, 'deliverable version')} ${acceptedTotal === 1 ? 'was' : 'were'} accepted through review in this window.`
      : 'No deliverable version was accepted through review in this window.',
    refs: accepted.map((a) => ({
      type: 'deliverable' as const,
      id: a.dlv_public,
      v: a.version_number,
      rec: a.task_public,
    })),
    figures: { total: acceptedTotal, shown: accepted.length },
    basis: records(acceptedBasis),
  });
  for (const a of accepted)
    out.push({
      section: 'accepted',
      kind: 'fact',
      key: `accepted.deliverable:${a.dlv_public}`,
      text: a.current
        ? `Deliverable ${quote(a.title)} version ${a.version_number} was accepted ${fmtInstant(a.accepted_at, tz)}.`
        : `Deliverable ${quote(a.title)} version ${a.version_number} was accepted ${fmtInstant(a.accepted_at, tz)}, but that acceptance is no longer current (a later version or decision replaced it).`,
      refs: [
        { type: 'deliverable', id: a.dlv_public, v: a.version_number, rec: a.task_public },
        { type: 'task', id: a.task_public, rec: a.task_public, v: a.task_version },
      ],
      figures: { current: a.current },
    });
  coverOf('accepted', accepted.length, acceptedTotal, acceptedBasis.overflow);
  const claimed = (
    await sql<{ public_id: string; title: string; version: number; n: string }>`
      SELECT r.public_id, t.title, t.version, count(*) OVER () AS n
        FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
       WHERE t.status_category = 'done' AND t.completed_at >= ${input.windowStart} AND t.completed_at < ${input.windowEnd}
         AND ${readableTask}
         AND (t.requires_acceptance OR EXISTS (SELECT 1 FROM files.deliverable d WHERE d.workspace_id = t.workspace_id AND d.task_id = t.id))
         AND NOT EXISTS (SELECT 1 FROM files.deliverable d WHERE d.workspace_id = t.workspace_id AND d.task_id = t.id
                          AND d.state = 'accepted' AND d.accepted_version_id IS NOT NULL)
       ORDER BY t.completed_at DESC, t.id DESC
       LIMIT ${SECTION_ITEMS_MAX}`.execute(tx.db)
  ).rows;
  const claimedTotal = Number(claimed[0]?.n ?? 0);
  const claimedBasis =
    await basisOf(sql`FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
       WHERE t.status_category = 'done' AND t.completed_at >= ${input.windowStart} AND t.completed_at < ${input.windowEnd}
         AND ${readableTask}
         AND (t.requires_acceptance OR EXISTS (SELECT 1 FROM files.deliverable d WHERE d.workspace_id = t.workspace_id AND d.task_id = t.id))
         AND NOT EXISTS (SELECT 1 FROM files.deliverable d WHERE d.workspace_id = t.workspace_id AND d.task_id = t.id
                          AND d.state = 'accepted' AND d.accepted_version_id IS NOT NULL)`);
  push({
    section: 'accepted',
    kind: 'calculation',
    key: 'accepted.claimed_count',
    text: claimedTotal
      ? `${plural(claimedTotal, 'task')} marked done in this window ${claimedTotal === 1 ? 'needs' : 'need'} acceptance and ${claimedTotal === 1 ? 'has' : 'have'} no accepted deliverable.`
      : 'Every task marked done in this window that needs acceptance has an accepted deliverable.',
    refs: claimed.map((c) => ({
      type: 'task' as const,
      id: c.public_id,
      rec: c.public_id,
      v: c.version,
    })),
    figures: { total: claimedTotal, shown: claimed.length },
    basis: records(claimedBasis),
  });
  for (const c of claimed)
    out.push({
      section: 'accepted',
      kind: 'fact',
      key: `accepted.claimed:${c.public_id}`,
      text: `${quote(c.title)} is marked done but has no accepted deliverable yet: completion is claimed, not accepted.`,
      refs: [{ type: 'task', id: c.public_id, rec: c.public_id, v: c.version }],
    });
  coverOf('claimed', claimed.length, claimedTotal, claimedBasis.overflow);

  // -- Attention: overdue, blocked, stale, at risk (BRF-008) -------------------------------------
  if (input.kind !== 'release_readiness') {
    const overdue = (
      await sql<{ public_id: string; title: string; version: number; due: string; n: string }>`
        SELECT r.public_id, t.title, t.version, coalesce(t.due_date::text, t.deadline_date::text,
               to_char(t.deadline_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')) AS due, count(*) OVER () AS n
          FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
         WHERE t.status_category NOT IN ('done', 'cancelled') AND ${readableTask}
           AND (t.due_date < ${today}::date OR t.deadline_date < ${today}::date OR t.deadline_at < ${input.windowEnd})
         ORDER BY coalesce(t.due_date, t.deadline_date, (t.deadline_at AT TIME ZONE ${tz})::date), t.id
         LIMIT ${SECTION_ITEMS_MAX}`.execute(tx.db)
    ).rows;
    const overdueTotal = Number(overdue[0]?.n ?? 0);
    const overdueBasis =
      await basisOf(sql`FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
         WHERE t.status_category NOT IN ('done', 'cancelled') AND ${readableTask}
           AND (t.due_date < ${today}::date OR t.deadline_date < ${today}::date OR t.deadline_at < ${input.windowEnd})`);
    push({
      section: 'attention',
      kind: 'calculation',
      key: 'attention.overdue_count',
      text: overdueTotal
        ? `${plural(overdueTotal, 'open task')} ${overdueTotal === 1 ? 'is' : 'are'} past due (dates evaluated in ${tz}).`
        : `No open task you can read is past due (dates evaluated in ${tz}).`,
      refs: overdue.map((t) => ({
        type: 'task' as const,
        id: t.public_id,
        rec: t.public_id,
        v: t.version,
      })),
      figures: { total: overdueTotal, shown: overdue.length },
      basis: records(overdueBasis),
    });
    for (const t of overdue)
      out.push({
        section: 'attention',
        kind: 'fact',
        key: `attention.overdue:${t.public_id}`,
        text: `${quote(t.title)} was due ${t.due} and is still open.`,
        refs: [{ type: 'task', id: t.public_id, rec: t.public_id, v: t.version }],
      });
    coverOf('overdue', overdue.length, overdueTotal, overdueBasis.overflow);

    // Blocked and stale come from the task signals (2D, OD-17) over a bounded candidate set.
    const candidates = (
      await sql<{ public_id: string; title: string; version: number; n: string }>`
        SELECT r.public_id, t.title, t.version, count(*) OVER () AS n
          FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
         WHERE t.status_category NOT IN ('done', 'cancelled') AND ${readableTask}
         ORDER BY t.last_meaningful_update_at, t.id
         LIMIT ${SIGNAL_CANDIDATES_MAX}`.execute(tx.db)
    ).rows;
    const openBasis =
      await basisOf(sql`FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
         WHERE t.status_category NOT IN ('done', 'cancelled') AND ${readableTask}`);
    // The open total is stated only while its whole basis is kept. Otherwise nothing beyond the
    // examined tasks is stated: no total, no "others", and a coverage state derived only from the
    // examined set itself (which is the statement's basis).
    const openKnown = !openBasis.overflow;
    const capped = candidates.length >= SIGNAL_CANDIDATES_MAX;
    const openTotal = Number(candidates[0]?.n ?? 0);
    const examined = { ids: candidates.map((c) => c.public_id), overflow: false };
    const signals = await readers.signals(candidates.map((c) => c.public_id));
    const blocked = candidates.filter((c) => signals.get(c.public_id)?.blocked === true);
    const stale = candidates.filter((c) => signals.get(c.public_id)?.stale === true);
    const examinedNote = openKnown
      ? openTotal > candidates.length
        ? ` Examined the ${candidates.length} least recently updated of ${openTotal} open tasks.`
        : ''
      : ` Examined the ${candidates.length} least recently updated open tasks (at most ${SIGNAL_CANDIDATES_MAX} are examined).`;
    const partial = openKnown ? openTotal > candidates.length : capped;
    for (const [section, list, label] of [
      ['blocked', blocked, 'blocked by open work'],
      ['stale', stale, 'stale (no meaningful update within the freshness rule)'],
    ] as const) {
      push({
        section: 'attention',
        kind: 'calculation',
        key: `attention.${section}_count`,
        text:
          (list.length
            ? `${plural(list.length, 'open task')} ${list.length === 1 ? 'is' : 'are'} ${label}.`
            : `No open task is ${label}.`) + examinedNote,
        refs: list
          .slice(0, SECTION_ITEMS_MAX)
          .map((t) => ({ type: 'task' as const, id: t.public_id, rec: t.public_id, v: t.version })),
        figures: {
          total: list.length,
          examined: candidates.length,
          open_total: openKnown ? openTotal : null,
        },
        basis: openKnown ? records(examined, openBasis) : records(examined),
      });
      for (const t of list.slice(0, SECTION_ITEMS_MAX))
        out.push({
          section: 'attention',
          kind: 'fact',
          key: `attention.${section}:${t.public_id}`,
          text: `${quote(t.title)} is ${label}.`,
          refs: [{ type: 'task', id: t.public_id, rec: t.public_id, v: t.version }],
        });
      coverage.sections[section] = {
        state: partial ? 'partial' : list.length > SECTION_ITEMS_MAX ? 'truncated' : 'complete',
        shown: Math.min(list.length, SECTION_ITEMS_MAX),
        total: partial ? null : list.length,
        ...(partial ? { note: 'examined_subset' } : {}),
      };
    }

    // At risk: projects whose latest update reports a risk (verified or not, labelled).
    const risky = (
      await sql<{
        public_id: string;
        name: string;
        version: number;
        upd: string;
        health: string;
        created_at: Date;
        verified: boolean;
        n: string;
      }>`
        SELECT r.public_id, w.name, w.version, u.public_id AS upd, u.health, u.created_at,
               EXISTS (SELECT 1 FROM work.project_update_verification v WHERE v.workspace_id = u.workspace_id AND v.update_id = u.id) AS verified,
               count(*) OVER () AS n
          FROM work.project w JOIN core.record r ON r.workspace_id = w.workspace_id AND r.id = w.id
          JOIN LATERAL (SELECT * FROM work.project_update u WHERE u.workspace_id = w.workspace_id AND u.project_id = w.id
                         ORDER BY u.created_at DESC, u.id DESC LIMIT 1) u ON true
         WHERE r.lifecycle_state = 'active' AND u.health IN ('at_risk', 'off_track')
           AND ${vis.where('r', { project: sql`w.id` })}
           AND ${scope.projectId ? sql`w.id = ${scope.projectId}::uuid` : scope.brandId ? sql`w.brand_id = ${scope.brandId}::uuid` : sql`true`}
         ORDER BY u.created_at DESC, w.id
         LIMIT ${SECTION_ITEMS_MAX}`.execute(tx.db)
    ).rows;
    const riskyTotal = Number(risky[0]?.n ?? 0);
    const riskyBasis =
      await basisOf(sql`FROM work.project w JOIN core.record r ON r.workspace_id = w.workspace_id AND r.id = w.id
          JOIN LATERAL (SELECT * FROM work.project_update u WHERE u.workspace_id = w.workspace_id AND u.project_id = w.id
                         ORDER BY u.created_at DESC, u.id DESC LIMIT 1) u ON true
         WHERE r.lifecycle_state = 'active' AND u.health IN ('at_risk', 'off_track')
           AND ${vis.where('r', { project: sql`w.id` })}
           AND ${scope.projectId ? sql`w.id = ${scope.projectId}::uuid` : scope.brandId ? sql`w.brand_id = ${scope.brandId}::uuid` : sql`true`}`);
    push({
      section: 'attention',
      kind: 'calculation',
      key: 'attention.at_risk_count',
      text: riskyTotal
        ? `${plural(riskyTotal, 'project')} you can read ${riskyTotal === 1 ? 'reports' : 'report'} a risk in its latest update.`
        : 'No project you can read reports a risk in its latest update.',
      refs: risky.map((r) => ({
        type: 'project' as const,
        id: r.public_id,
        rec: r.public_id,
        v: r.version,
      })),
      figures: { total: riskyTotal, shown: risky.length },
      basis: records(riskyBasis),
    });
    for (const r of risky)
      out.push({
        section: 'attention',
        kind: 'fact',
        key: `attention.at_risk:${r.public_id}`,
        text: `Project ${quote(r.name)}: its latest update (${fmtInstant(r.created_at, tz)}) reports ${r.health === 'at_risk' ? 'at risk' : 'off track'}${r.verified ? ' and is verified' : ', not verified'}.`,
        refs: [
          { type: 'project', id: r.public_id, rec: r.public_id, v: r.version },
          { type: 'project_update', id: r.upd, rec: r.public_id },
        ],
        figures: { health: r.health, verified: r.verified },
      });
    coverOf('at_risk', risky.length, riskyTotal, riskyBasis.overflow);
  }

  // -- Decisions awaiting this person (BRF-009) --------------------------------------------------
  if (input.kind !== 'project_status' && input.kind !== 'release_readiness') {
    const reviews = await readers.reviews();
    const decisions: Statement[] = [];
    for (const r of reviews.data) {
      const rec =
        r.subject.type === 'deliverable' ? await deliverableTask(tx, r.subject.id) : r.subject.id;
      if (!rec || !(await inScope(tx, rec, scope))) continue;
      decisions.push({
        section: 'decisions',
        kind: 'fact',
        key: `decisions.review:${r.id}`,
        text: `Your review is requested on ${quote(r.subject.title)}${r.stale ? ' (the item changed since the request)' : ''}.`,
        refs: [
          { type: 'review', id: r.id, rec },
          {
            type: r.subject.type === 'deliverable' ? 'deliverable' : 'task',
            id: r.subject.id,
            rec,
          },
        ],
      });
    }
    const approvals = await readers.approvals();
    for (const a of approvals.data) {
      if (!a.can_decide || a.state !== 'pending') continue;
      if (!(await inScope(tx, a.record.id, scope))) continue;
      decisions.push({
        section: 'decisions',
        kind: 'fact',
        key: `decisions.approval:${a.id}`,
        text: `A status change on a ${a.record.type} waits for your approval.`,
        refs: [
          { type: 'approval', id: a.id, rec: a.record.id },
          {
            type: a.record.type === 'project' ? 'project' : 'task',
            id: a.record.id,
            rec: a.record.id,
          },
        ],
      });
    }
    if (!scope.projectId) {
      const sheets = await readers.timesheets();
      const sheetBrands = await approvableSheetBrands(
        tx,
        p,
        sheets.data.map((s) => s.id),
      );
      for (const s of sheets.data) {
        const start =
          typeof s.period_start === 'string' ? s.period_start : (s.period?.start ?? null);
        decisions.push({
          section: 'decisions',
          kind: 'fact',
          key: `decisions.timesheet:${s.id}`,
          text: `A timesheet${start ? ` for the period starting ${start}` : ''} waits for your approval.`,
          refs: [{ type: 'timesheet', id: s.id }],
          // Bound to the exact brands whose pending lines made it this person's decision.
          basis: {
            records: [],
            brands: [],
            perms: (sheetBrands.get(s.id) ?? []).map((brand) => ({
              perm: 'timesheet.approve' as const,
              brand,
            })),
          },
        });
      }
    }
    const shown = decisions.slice(0, SECTION_ITEMS_MAX);
    out.push({
      section: 'decisions',
      kind: 'calculation',
      key: 'decisions.count',
      text: decisions.length
        ? `${plural(decisions.length, 'decision')} ${decisions.length === 1 ? 'waits' : 'wait'} for you.`
        : 'Nothing waits for your decision.',
      refs: shown.flatMap((d) => d.refs.slice(0, 1)),
      basis: {
        records: decisions.flatMap((d) => d.refs.flatMap((r) => (r.rec ? [r.rec] : []))),
        brands: [],
        perms: decisions.flatMap((d) => d.basis?.perms ?? []),
      },
      figures: {
        total: decisions.length,
        shown: shown.length,
        more_reviews: reviews.page.has_more,
      },
    });
    out.push(...shown);
    coverage.sections.decisions = {
      state: reviews.page.has_more
        ? 'partial'
        : shown.length < decisions.length
          ? 'truncated'
          : 'complete',
      shown: shown.length,
      total: reviews.page.has_more ? null : decisions.length,
    };
  }

  // -- Approaching deadlines and capacity conflicts (BRF-011, 3E) --------------------------------
  if (input.kind !== 'release_readiness') {
    const horizon = addDays(today, 7);
    const due = (
      await sql<{ public_id: string; title: string; version: number; due: string; n: string }>`
        SELECT r.public_id, t.title, t.version, coalesce(t.due_date::text, t.deadline_date::text,
               to_char(t.deadline_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')) AS due, count(*) OVER () AS n
          FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
         WHERE t.status_category NOT IN ('done', 'cancelled') AND ${readableTask}
           AND ((t.due_date BETWEEN ${today}::date AND ${horizon}::date)
             OR (t.deadline_date BETWEEN ${today}::date AND ${horizon}::date)
             OR (t.deadline_at >= ${input.windowEnd} AND t.deadline_at < ${new Date(input.windowEnd.getTime() + 8 * DAY)}))
           ${input.kind === 'owner_daily' || input.kind === 'weekly_review' ? sql`AND EXISTS (SELECT 1 FROM work.task_assignee a WHERE a.task_id = t.id AND a.membership_id = ${p.membershipId}::uuid)` : sql``}
         ORDER BY 4, t.id
         LIMIT ${SECTION_ITEMS_MAX}`.execute(tx.db)
    ).rows;
    const dueTotal = Number(due[0]?.n ?? 0);
    const mine = input.kind === 'owner_daily' || input.kind === 'weekly_review';
    const dueBasis =
      await basisOf(sql`FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
         WHERE t.status_category NOT IN ('done', 'cancelled') AND ${readableTask}
           AND ((t.due_date BETWEEN ${today}::date AND ${horizon}::date)
             OR (t.deadline_date BETWEEN ${today}::date AND ${horizon}::date)
             OR (t.deadline_at >= ${input.windowEnd} AND t.deadline_at < ${new Date(input.windowEnd.getTime() + 8 * DAY)}))
           ${mine ? sql`AND EXISTS (SELECT 1 FROM work.task_assignee a WHERE a.task_id = t.id AND a.membership_id = ${p.membershipId}::uuid)` : sql``}`);
    push({
      section: 'deadlines',
      kind: 'calculation',
      key: 'deadlines.count',
      text: dueTotal
        ? `${plural(dueTotal, 'open task')}${mine ? ' assigned to you' : ''} ${dueTotal === 1 ? 'is' : 'are'} due in the next 7 days (${today} to ${horizon}).`
        : `No open task${mine ? ' assigned to you' : ''} is due in the next 7 days (${today} to ${horizon}).`,
      refs: due.map((t) => ({
        type: 'task' as const,
        id: t.public_id,
        rec: t.public_id,
        v: t.version,
      })),
      figures: { total: dueTotal, shown: due.length, from: today, to: horizon },
      basis: records(dueBasis),
    });
    for (const t of due)
      out.push({
        section: 'deadlines',
        kind: 'fact',
        key: `deadlines.task:${t.public_id}`,
        text: `${quote(t.title)} is due ${t.due}.`,
        refs: [{ type: 'task', id: t.public_id, rec: t.public_id, v: t.version }],
      });
    coverOf('deadlines', due.length, dueTotal, dueBasis.overflow);
    if (!scope.projectId && p.kind === 'guest') {
      out.push({
        section: 'capacity',
        kind: 'unavailable',
        key: 'capacity.guest',
        text: 'Capacity and conflicts are not available to guests.',
        refs: [],
      });
      coverage.sections.capacity = { state: 'unavailable', shown: 0, total: null };
    } else if (!scope.projectId && input.kind !== 'project_status') {
      const cap = await readers.capacity(today, addDays(today, 6));
      const t = cap.totals;
      const planned = Math.max(t.scheduled_minutes, t.estimated_minutes);
      // Basis: the brands whose reservations, blocks, and estimates count, and every readable open
      // task assigned to the person and due in the window (a superset of the estimated tasks).
      const capTasks =
        await basisOf(sql`FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
           WHERE t.status_category NOT IN ('done', 'cancelled') AND ${readableTask}
             AND t.due_date BETWEEN ${today}::date AND ${addDays(today, 6)}::date
             AND EXISTS (SELECT 1 FROM work.task_assignee a WHERE a.task_id = t.id AND a.membership_id = ${p.membershipId}::uuid)`);
      const capBasis: Basis = {
        ...records(capTasks),
        brands: cap.brands.map((b) => b.brand.id),
      };
      push({
        section: 'capacity',
        kind: 'calculation',
        key: 'capacity.week',
        text: `Next 7 days (${cap.timezone}): ${hours(t.available_minutes * 60)} h available, ${hours(planned * 60)} h planned (the larger of scheduled blocks and estimates). Time off counts as unavailable time.`,
        refs: [{ type: 'capacity', id: 'me', self: true }],
        figures: {
          available_minutes: t.available_minutes,
          scheduled_minutes: t.scheduled_minutes,
          estimated_minutes: t.estimated_minutes,
        },
        basis: capBasis,
      });
      const conflicts = cap.conflicts.filter((c) =>
        scope.brandId
          ? JSON.stringify(c).includes(JSON.stringify(scopeBrandName(cap, scope.brandPublicId)))
          : true,
      );
      for (const [i, c] of conflicts.slice(0, SECTION_ITEMS_MAX).entries())
        out.push({
          section: 'capacity',
          kind: 'fact',
          key: `capacity.conflict:${i}:${figuresDigest(c)}`,
          text: conflictText(c, tz),
          refs: [{ type: 'capacity', id: 'me', self: true }],
          figures: { kind: c.kind },
          basis: { records: [], brands: cap.brands.map((b) => b.brand.id), perms: [] },
        });
      cover('capacity', Math.min(conflicts.length, SECTION_ITEMS_MAX), conflicts.length);
    }
  }

  // -- Planned versus actual time (BRF-012, 3D) --------------------------------------------------
  if (input.kind !== 'release_readiness') {
    const from = localDay(input.windowStart, tz);
    const to = localDay(new Date(input.windowEnd.getTime() - 1), tz);
    const report = await readers.timeReport({
      from,
      to: to < from ? from : to,
      member: 'me',
      ...(scope.brandPublicId ? { brand: scope.brandPublicId } : {}),
    });
    // Basis: the work records of the person's entries on those dates and every readable task
    // assigned to them due on those dates (a superset of the planned estimates).
    const timeEntries = await basisOf(sql`FROM timetrack.time_entry e
        JOIN core.record r ON r.workspace_id = e.workspace_id AND r.id = coalesce(e.task_id, e.project_id)
        LEFT JOIN work.task tk ON tk.workspace_id = e.workspace_id AND tk.id = e.task_id
       WHERE e.membership_id = ${p.membershipId}::uuid AND e.state = 'stopped'
         AND e.work_date BETWEEN ${report.range.from}::date AND ${report.range.to}::date
         AND ${vis.where('r', { project: sql`coalesce(tk.project_id, e.project_id)` })}
         ${scope.brandId ? sql`AND e.brand_id = ${scope.brandId}::uuid` : sql``}`);
    const timePlanned =
      await basisOf(sql`FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
       WHERE ${vis.where('r', { project: sql`t.project_id` })} AND ${taskScope('t')}
         AND t.due_date BETWEEN ${report.range.from}::date AND ${report.range.to}::date
         AND EXISTS (SELECT 1 FROM work.task_assignee a WHERE a.task_id = t.id AND a.membership_id = ${p.membershipId}::uuid)`);
    push({
      section: 'time',
      kind: 'calculation',
      key: 'time.planned_actual',
      text: `Your time on work dates ${report.range.from} to ${report.range.to}: ${hours(report.totals.planned_minutes * 60)} h planned (task estimates) and ${hours(report.totals.actual_seconds)} h actual across ${plural(report.totals.entries, 'time entry', 'time entries')}.`,
      refs: [{ type: 'time', id: 'me', self: true }],
      figures: {
        from: report.range.from,
        to: report.range.to,
        planned_minutes: report.totals.planned_minutes,
        actual_seconds: report.totals.actual_seconds,
        entries: report.totals.entries,
      },
      basis: records(timeEntries, timePlanned),
    });
    coverage.sections.time = {
      state: report.truncated ? 'truncated' : 'complete',
      shown: report.rows.length,
      total: null,
      note: 'totals cover every row',
    };
  }

  // -- AI usage and execution cost (BRF-013, 7A ledger) ------------------------------------------
  if (
    input.kind === 'owner_daily' ||
    input.kind === 'weekly_review' ||
    input.kind === 'brand_daily'
  ) {
    const usage = (
      await sql<{ synthetic: boolean; runs: string; cost: string | null }>`
        SELECT a.synthetic, count(DISTINCT a.operation_id) AS runs,
               (SELECT string_agg(u.quantity::text, ',') FROM metering.usage_event u JOIN ai.ai_action a2 ON a2.operation_id = u.operation_id
                 WHERE u.meter = 'ai.cost' AND a2.initiating_membership_id = ${p.membershipId}::uuid AND a2.synthetic = a.synthetic
                   AND u.occurred_at >= ${input.windowStart} AND u.occurred_at < ${input.windowEnd}
                   ${scope.brandId ? sql`AND a2.brand_id = ${scope.brandId}::uuid` : sql``}) AS cost
          FROM ai.ai_action a
         WHERE a.initiating_membership_id = ${p.membershipId}::uuid
           AND a.created_at >= ${input.windowStart} AND a.created_at < ${input.windowEnd}
           ${scope.brandId ? sql`AND a.brand_id = ${scope.brandId}::uuid` : sql``}
         GROUP BY a.synthetic`.execute(tx.db)
    ).rows;
    const pending = (
      await sql<{ state: string; n: string; reserved: string | null }>`
        SELECT d.state, count(*) AS n, string_agg(d.reserved_micros::text, ',') AS reserved
          FROM ai.ai_dispatch d JOIN ai.ai_action a ON a.operation_id = d.operation_id
         WHERE a.initiating_membership_id = ${p.membershipId}::uuid AND d.state IN ('dispatching', 'unknown')
           ${scope.brandId ? sql`AND a.brand_id = ${scope.brandId}::uuid` : sql``}
         GROUP BY d.state`.execute(tx.db)
    ).rows;
    const sum = (csv: string | null) =>
      (csv ? csv.split(',') : []).reduce((n, q) => n + parseMicros(q), 0n);
    const real = usage.find((u) => !u.synthetic);
    const synth = usage.find((u) => u.synthetic);
    const unknown = pending.find((x) => x.state === 'unknown');
    const reserved = pending.find((x) => x.state === 'dispatching');
    const parts: string[] = [];
    parts.push(
      real
        ? `${plural(Number(real.runs), 'AI run')} you started cost ${usdDisplay(sum(real.cost))} (recorded usage).`
        : 'You started no billable AI runs in this window.',
    );
    if (synth)
      parts.push(
        `${plural(Number(synth.runs), 'synthetic test run')} recorded ${usdDisplay(sum(synth.cost))} at a synthetic price, not a real charge.`,
      );
    if (reserved)
      parts.push(
        `${plural(Number(reserved.n), 'attempt')} in progress hold${Number(reserved.n) === 1 ? 's' : ''} a reservation of ${usdDisplay(sum(reserved.reserved))}.`,
      );
    if (unknown)
      parts.push(
        `${plural(Number(unknown.n), 'attempt')} ${Number(unknown.n) === 1 ? 'has' : 'have'} an unknown outcome; up to ${usdDisplay(sum(unknown.reserved))} stays reserved until reconciled.`,
      );
    out.push({
      section: 'ai_cost',
      kind: 'calculation',
      key: 'ai_cost.window',
      text: parts.join(' ') + ' Only your own runs are shown.',
      refs: [{ type: 'ai_usage', id: 'me', self: true }],
      figures: {
        actual_micros: real ? usdDisplay(sum(real.cost)) : '$0.00',
        synthetic_micros: synth ? usdDisplay(sum(synth.cost)) : null,
        reserved_attempts: Number(reserved?.n ?? 0),
        unknown_attempts: Number(unknown?.n ?? 0),
      },
    });
    coverage.sections.ai_cost = { state: 'complete', shown: 1, total: 1 };
    // Agent runs ready for review (BRF-010, 8C): runs that returned draft output in this window
    // on tasks the recipient can read. Ready for review is not acceptance and not completion.
    const ready = (
      await sql<{ public_id: string; title: string; version: number; agent: string; n: string }>`
        SELECT r.public_id, t.title, t.version, ap.name AS agent, count(*) OVER () AS n
          FROM agents.agent_run ar
          JOIN exec.operation op ON op.id = ar.current_operation_id
          JOIN agents.agent_profile ap ON ap.id = ar.profile_id
          JOIN work.task t ON t.workspace_id = ar.workspace_id AND t.id = ar.task_id
          JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
         WHERE op.execution_state = 'succeeded'
           AND ar.ended_at >= ${input.windowStart} AND ar.ended_at < ${input.windowEnd}
           AND ${readableTask}
           ${scope.brandId ? sql`AND t.brand_id = ${scope.brandId}::uuid` : sql``}
         ORDER BY ar.ended_at DESC, ar.id DESC
         LIMIT ${SECTION_ITEMS_MAX}`.execute(tx.db)
    ).rows;
    const readyTotal = Number(ready[0]?.n ?? 0);
    out.push({
      section: 'agent_runs',
      kind: 'calculation',
      key: 'agent_runs.ready',
      text: readyTotal
        ? `${plural(readyTotal, 'agent run')} on tasks you can read returned draft output for review in this window. Ready for review is not acceptance and does not complete a task.`
        : 'No agent run on a task you can read returned output for review in this window.',
      refs: ready.map((t) => ({
        type: 'task' as const,
        id: t.public_id,
        rec: t.public_id,
        v: t.version,
      })),
      figures: { total: readyTotal, shown: ready.length },
    });
    for (const t of ready)
      out.push({
        section: 'agent_runs',
        kind: 'fact',
        key: `agent_runs.task:${t.public_id}`,
        text: `${quote(t.agent)} returned draft output for ${quote(t.title)}; it is ready for review.`,
        refs: [{ type: 'task', id: t.public_id, rec: t.public_id, v: t.version }],
      });
    coverage.sections.agent_runs = {
      state: ready.length < readyTotal ? 'truncated' : 'complete',
      shown: ready.length,
      total: readyTotal,
    };
  }

  // -- Project status (BRF-004, PRJ-025) and release readiness (BRF-005) -------------------------
  if (scope.projectId && (input.kind === 'project_status' || input.kind === 'release_readiness')) {
    const updates = (
      await sql<{
        public_id: string;
        body: string;
        health: string | null;
        created_at: Date;
        verified_at: Date | null;
        source_kind: string;
      }>`
        SELECT u.public_id, u.body, u.health, u.created_at, v.verified_at, u.source_kind
          FROM work.project_update u
          LEFT JOIN work.project_update_verification v ON v.workspace_id = u.workspace_id AND v.update_id = u.id
         WHERE u.project_id = ${scope.projectId}::uuid
         ORDER BY u.created_at DESC, u.id DESC LIMIT 20`.execute(tx.db)
    ).rows;
    const verified = updates.find((u) => u.verified_at);
    const newer = verified ? updates.filter((u) => u.created_at > verified.created_at) : updates;
    const proj = {
      type: 'project' as const,
      id: scope.projectPublicId!,
      rec: scope.projectPublicId!,
    };
    if (input.kind === 'project_status') {
      out.push(
        verified
          ? {
              section: 'project',
              kind: 'excerpt',
              key: `project.verified_update:${verified.public_id}`,
              text: `Latest verified update (${fmtInstant(verified.created_at, tz)}, verified ${fmtInstant(verified.verified_at!, tz)}${verified.health ? `, ${verified.health.replace('_', ' ')}` : ''}): ${quote(verified.body)}`,
              refs: [proj, { type: 'project_update', id: verified.public_id, rec: proj.id }],
            }
          : {
              section: 'project',
              kind: 'unknown',
              key: 'project.no_verified_update',
              text: 'This project has no verified update yet. Updates that were posted but not verified are listed as drafts, not as verified status.',
              refs: [proj],
            },
      );
      for (const u of newer.slice(0, 3))
        out.push({
          section: 'project',
          kind: 'fact',
          key: `project.unverified_update:${u.public_id}`,
          text: `A ${u.source_kind === 'ai_draft' ? 'generated draft' : 'posted'} update from ${fmtInstant(u.created_at, tz)} is not verified${u.health ? ` (reports ${u.health.replace('_', ' ')})` : ''}.`,
          refs: [proj, { type: 'project_update', id: u.public_id, rec: proj.id }],
        });
    }
    const counts = (
      await sql<{ cat: string; n: string }>`
        SELECT t.status_category AS cat, count(*) AS n
          FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
         WHERE ${readableTask} GROUP BY 1 ORDER BY 1`.execute(tx.db)
    ).rows;
    const open = counts
      .filter((c) => c.cat !== 'done' && c.cat !== 'cancelled')
      .reduce((n, c) => n + Number(c.n), 0);
    const finished = Number(counts.find((c) => c.cat === 'done')?.n ?? 0);
    const projectTasks =
      await basisOf(sql`FROM work.task t JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
         WHERE ${readableTask}`);
    push({
      section: 'project',
      kind: 'calculation',
      key: 'project.task_counts',
      text: `Tasks you can read in this project: ${open} open, ${finished} done.`,
      refs: [proj],
      figures: { open, done: finished },
      basis: records(projectTasks),
    });
    if (input.kind === 'release_readiness') {
      const dl = (
        await sql<{
          dlv_public: string;
          title: string;
          state: string;
          task_public: string;
          n: string;
        }>`
          SELECT dr.public_id AS dlv_public, d.title, d.state, r.public_id AS task_public, count(*) OVER () AS n
            FROM files.deliverable d
            JOIN core.record dr ON dr.workspace_id = d.workspace_id AND dr.id = d.id
            JOIN work.task t ON t.workspace_id = d.workspace_id AND t.id = d.task_id
            JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
           WHERE ${readableTask} AND NOT (d.state = 'accepted' AND d.accepted_version_id IS NOT NULL)
           ORDER BY d.created_at, d.id LIMIT ${SECTION_ITEMS_MAX}`.execute(tx.db)
      ).rows;
      const acceptedAll = Number(
        (
          await sql<{ n: string }>`
            SELECT count(*) AS n FROM files.deliverable d
              JOIN work.task t ON t.workspace_id = d.workspace_id AND t.id = d.task_id
              JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
             WHERE ${readableTask} AND d.state = 'accepted' AND d.accepted_version_id IS NOT NULL`.execute(
            tx.db,
          )
        ).rows[0]?.n ?? 0,
      );
      const notAccepted = Number(dl[0]?.n ?? 0);
      const deliverableTasks = await basisOf(sql`FROM files.deliverable d
            JOIN work.task t ON t.workspace_id = d.workspace_id AND t.id = d.task_id
            JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
           WHERE ${readableTask}`);
      push({
        section: 'release',
        kind: 'calculation',
        key: 'release.deliverables',
        text: `Deliverables: ${acceptedAll} accepted through review, ${notAccepted} not accepted.`,
        refs: [
          proj,
          ...dl.map((d) => ({
            type: 'deliverable' as const,
            id: d.dlv_public,
            rec: d.task_public,
          })),
        ],
        figures: { accepted: acceptedAll, not_accepted: notAccepted },
        basis: records(deliverableTasks),
      });
      for (const d of dl)
        out.push({
          section: 'release',
          kind: 'fact',
          key: `release.missing_acceptance:${d.dlv_public}`,
          text: `Missing evidence: deliverable ${quote(d.title)} is ${d.state.replace(/_/g, ' ')}, not accepted.`,
          refs: [
            { type: 'deliverable', id: d.dlv_public, rec: d.task_public },
            { type: 'task', id: d.task_public, rec: d.task_public },
          ],
        });
      coverOf('release', dl.length, notAccepted, deliverableTasks.overflow);
      out.push(
        {
          section: 'release',
          kind: 'unavailable',
          key: 'release.test_evidence',
          text: 'Missing evidence: test results are not recorded in this product yet (a later release, Phase 9D, adds them).',
          refs: [],
        },
        {
          section: 'release',
          kind: 'unavailable',
          key: 'release.release_records',
          text: 'Missing evidence: release records and sign-off are not recorded in this product yet (Phase 9D).',
          refs: [],
        },
        {
          section: 'release',
          kind: 'fact',
          key: 'release.no_certification',
          text: 'This summary lists the evidence that exists. It does not certify a release and does not publish one.',
          refs: [proj],
        },
      );
    }
  }

  // -- Generated wording (optional, never required) ----------------------------------------------
  if (!input.generated.available)
    out.push({
      section: 'generated',
      kind: 'unavailable',
      key: 'generated.unavailable',
      text: `Generated wording is not part of this briefing: ${input.generated.reason} The facts above are complete without it.`,
      refs: [],
    });

  return { statements: out.slice(0, STATEMENTS_MAX), coverage };
}

export const KIND_LABEL: Record<BriefingKind, string> = {
  owner_daily: 'Daily briefing',
  brand_daily: 'Brand daily briefing',
  weekly_review: 'Weekly review',
  project_status: 'Project status update',
  release_readiness: 'Release-readiness summary',
};

function scopeBrandName(
  cap: { brands: Array<{ brand: { id: string; name: string } }> },
  brandPublicId: string | null,
): string | null {
  return cap.brands.find((b) => b.brand.id === brandPublicId)?.brand.name ?? null;
}

function conflictText(c: Record<string, unknown> & { kind: string }, tz: string): string {
  if (c.kind === 'overlap' && Array.isArray(c.brands))
    return `Overlapping work blocks for ${(c.brands as string[]).join(' and ')} at ${fmtInstant(new Date(String(c.at)), tz)} (${String(c.minutes)} min).`;
  if (c.kind === 'reservation_unmet')
    return `The time reserved for ${String(c.brand)} (${String(c.reserved_minutes)} min) does not fit: ${String(c.room_minutes)} min remain after other brands.`;
  return 'A calendar event overlaps scheduled work.';
}

/**
 * The brands whose pending lines make each timesheet this person's decision, decided per exact
 * brand by the canonical `timesheet.approve` brand decision (R1: never a workspace-wide check).
 */
async function approvableSheetBrands(
  tx: WorkspaceTransaction,
  p: Principal,
  sheets: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!sheets.length) return out;
  const rows = (
    await sql<{
      sheet: string;
      brand: string;
      id: string;
      is_sensitive: boolean;
      lifecycle_state: string;
    }>`
      SELECT DISTINCT s.public_id AS sheet, br.public_id AS brand, b.id, b.is_sensitive, b.lifecycle_state
        FROM timetrack.timesheet_line l
        JOIN timetrack.timesheet s ON s.workspace_id = l.workspace_id AND s.id = l.timesheet_id
        JOIN tenancy.brand b ON b.workspace_id = l.workspace_id AND b.id = l.brand_id
        JOIN core.record br ON br.workspace_id = b.workspace_id AND br.id = b.id
       WHERE s.public_id = ANY(${sheets}::text[]) AND l.state = 'pending'`.execute(tx.db)
  ).rows;
  for (const r of rows)
    if (
      decideBrand(p, 'timesheet.approve', {
        id: r.id,
        isSensitive: r.is_sensitive,
        lifecycleState: r.lifecycle_state as 'active',
      }).allowed
    )
      out.set(r.sheet, [...(out.get(r.sheet) ?? []), r.brand]);
  return out;
}

async function deliverableTask(tx: WorkspaceTransaction, dlv: string): Promise<string | null> {
  const r = await sql<{ public_id: string }>`
    SELECT tr.public_id FROM core.record dr
      JOIN files.deliverable d ON d.workspace_id = dr.workspace_id AND d.id = dr.id
      JOIN core.record tr ON tr.workspace_id = d.workspace_id AND tr.id = d.task_id
     WHERE dr.public_id = ${dlv}`.execute(tx.db);
  return r.rows[0]?.public_id ?? null;
}

/** Whether a record (task or project public id) falls inside the briefing scope. */
async function inScope(tx: WorkspaceTransaction, publicId: string, scope: BriefingScope) {
  if (!scope.brandId && !scope.projectId) return true;
  const r = await sql<{ brand_id: string | null; project_id: string | null; id: string }>`
    SELECT r.id, r.brand_id, coalesce(t.project_id, CASE WHEN r.record_type = 'project' THEN r.id END) AS project_id
      FROM core.record r LEFT JOIN work.task t ON t.workspace_id = r.workspace_id AND t.id = r.id
     WHERE r.public_id = ${publicId}`.execute(tx.db);
  const row = r.rows[0];
  if (!row) return false;
  return scope.projectId ? row.project_id === scope.projectId : row.brand_id === scope.brandId;
}
