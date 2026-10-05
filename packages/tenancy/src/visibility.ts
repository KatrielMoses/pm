import { sql, type RawBuilder, type WorkspaceTransaction } from '@pm/db';
import {
  brandLevel,
  levelRank,
  minLevel,
  roleCap,
  subjectKeys,
  workspaceLevel,
  type BrandFacts,
  type Level,
  type Principal,
} from './policy.ts';
import { governingProject, projectIdsAtLevel, projectScope } from './projects.ts';

/**
 * The record visibility predicate (0C §4.5), compiled once per request from the principal and
 * applied in SQL before ordering, pagination, and counts. Single-record checks use the identical
 * predicate with `AND r.id = …` (no second, divergent implementation).
 *
 * Branches: workspace-scoped envelopes (`brand_id IS NULL`) at the workspace level; brand-scoped
 * envelopes in brands at or above the required level (implicit non-sensitive ∪ grants, capped);
 * exact-record grants to the principal's subject keys (membership, teams, viewable brand
 * contexts — never brand contexts for guests). Arrays above `arrayMax` move into a
 * transaction-scoped temporary table joined the same way.
 *
 * Project scope (0C AZ-21): records governed by a restricted project chain leave the brand branch;
 * explicit project grants add a project branch (flowing down until a restricted project). Callers
 * over typed tables pass the governing project column; generic `core.record` queries derive it.
 */

export interface VisibilityContext {
  need: Level;
  brands: readonly BrandFacts[];
  brandIds: string[];
  subjects: string[];
  wsLevel: Level | null;
  includeArchived: boolean;
  strategy: 'array' | 'temp_table' | 'semi_join';
  /** Share levels that satisfy `need` (read=view). Empty: shares cannot satisfy it. */
  shareLevels: string[];
  /** Projects whose chain is restricted (excluded from the brand branch). */
  restrictedProjects: string[];
  /** Projects reachable at `need` through explicit project grants. */
  projectIds: string[];
}

let tempSeq = 0;

/** Loads every brand's facts in the workspace (small: tens) for level computation. */
export async function brandFacts(tx: WorkspaceTransaction): Promise<BrandFacts[]> {
  const rows = await tx.db
    .selectFrom('tenancy.brand')
    .select(['id', 'is_sensitive', 'lifecycle_state'])
    .orderBy('id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    isSensitive: r.is_sensitive,
    lifecycleState: r.lifecycle_state,
  }));
}

export async function compileVisibility(
  tx: WorkspaceTransaction,
  p: Principal,
  options: { need: Level; includeArchived?: boolean; arrayMax: number; brands?: BrandFacts[] },
): Promise<{
  ctx: VisibilityContext;
  where: (alias: string, opts?: { project?: RawBuilder<unknown> }) => RawBuilder<boolean>;
}> {
  const brands = options.brands ?? (await brandFacts(tx));
  const cap = roleCap(p.role);
  const effectiveNeed = options.need;
  const capped = levelRank(cap) >= levelRank(effectiveNeed);
  const viewable = brands
    .filter((b) => b.lifecycleState === 'active' || b.lifecycleState === 'archived')
    .filter(
      (b) => levelRank(brandLevel(p, { ...b, lifecycleState: 'active' })) >= levelRank('view'),
    )
    .map((b) => b.id);
  const brandIds = capped
    ? brands
        .filter((b) => b.lifecycleState === 'active' || b.lifecycleState === 'archived')
        .filter(
          (b) =>
            levelRank(brandLevel(p, { ...b, lifecycleState: 'active' })) >=
            levelRank(effectiveNeed),
        )
        .map((b) => b.id)
    : [];
  const subjects = subjectKeys(p, viewable);
  const wsLevel = capped ? workspaceLevel(p) : null;
  const shareCap = p.kind === 'guest' ? minLevel(cap, 'edit') : cap;
  const shareLevels = !capped
    ? []
    : (['read', 'comment', 'edit'] as const).filter((s) => {
        const lv = minLevel(s === 'read' ? 'view' : s, shareCap);
        return levelRank(lv) >= levelRank(effectiveNeed);
      });
  const includeArchived =
    (options.includeArchived ?? false) &&
    levelRank(effectiveNeed) <= levelRank(p.policy.comment_on_archived ? 'comment' : 'view');
  const scope = await projectScope(tx, p);
  const restrictedProjects = scope.restrictedChain;
  const projectIds = capped ? projectIdsAtLevel(scope, effectiveNeed) : [];
  const oversized =
    brandIds.length > options.arrayMax ||
    subjects.length > options.arrayMax ||
    restrictedProjects.length > options.arrayMax ||
    projectIds.length > options.arrayMax;
  // Temporary tables cannot be created in read-only transactions; there the same sets join as a
  // row-set semi-join over `unnest` (equivalent plan shape, no catalog writes).
  const readOnly = oversized
    ? (
        await sql<{ ro: string }>`SELECT current_setting('transaction_read_only') AS ro`.execute(
          tx.db,
        )
      ).rows[0]?.ro === 'on'
    : false;
  const strategy: VisibilityContext['strategy'] = !oversized
    ? 'array'
    : readOnly
      ? 'semi_join'
      : 'temp_table';
  const sets: Record<'brands' | 'subjects' | 'restricted' | 'projects', RawBuilder<unknown>> = {
    brands: sql`${brandIds}::uuid[]`,
    subjects: sql`${subjects}::uuid[]`,
    restricted: sql`${restrictedProjects}::uuid[]`,
    projects: sql`${projectIds}::uuid[]`,
  };
  const values = {
    brands: brandIds,
    subjects,
    restricted: restrictedProjects,
    projects: projectIds,
  };
  if (strategy === 'semi_join')
    for (const k of Object.keys(values) as Array<keyof typeof values>)
      sets[k] = sql`ARRAY(SELECT DISTINCT unnest(${values[k]}::uuid[]))`;
  if (strategy === 'temp_table') {
    const n = ++tempSeq;
    for (const k of Object.keys(values) as Array<keyof typeof values>) {
      const t = sql.raw(`pg_temp.ctx_${k}_${n}`);
      await sql`CREATE TEMP TABLE ${t} (id uuid PRIMARY KEY) ON COMMIT DROP`.execute(tx.db);
      if (values[k].length)
        await sql`INSERT INTO ${t} SELECT unnest(${values[k]}::uuid[])`.execute(tx.db);
      await sql`ANALYZE ${t}`.execute(tx.db);
      sets[k] = sql`ARRAY(SELECT id FROM ${t})`;
    }
  }
  const brandSet = sets.brands;
  const subjectSet = sets.subjects;
  const ctx: VisibilityContext = {
    need: effectiveNeed,
    brands,
    brandIds,
    subjects,
    wsLevel,
    includeArchived,
    strategy,
    shareLevels,
    restrictedProjects,
    projectIds,
  };
  const states = includeArchived ? ['active', 'archived'] : ['active'];
  const projectAware = restrictedProjects.length > 0 || projectIds.length > 0;
  const where = (alias: string, opts: { project?: RawBuilder<unknown> } = {}) => {
    const r = sql.raw(alias);
    const gp = projectAware ? (opts.project ?? governingProject(alias)) : null;
    const brandBranch = gp
      ? sql`(${r}.brand_id = ANY(${brandSet}) AND (${gp} IS NULL OR ${gp} <> ALL(${sets.restricted})))`
      : sql`${r}.brand_id = ANY(${brandSet})`;
    const projectBranch = gp && projectIds.length ? sql`${gp} = ANY(${sets.projects})` : sql`false`;
    const wsBranch =
      wsLevel !== null && levelRank(wsLevel) >= levelRank(effectiveNeed)
        ? sql`${r}.brand_id IS NULL`
        : sql`false`;
    const shareBranch = shareLevels.length
      ? sql`EXISTS (SELECT 1 FROM access.record_grant g
                     WHERE g.workspace_id = ${r}.workspace_id AND g.record_id = ${r}.id
                       AND g.grantee_key = ANY(${subjectSet})
                       AND g.state = 'active' AND (g.expires_at IS NULL OR g.expires_at > now())
                       AND g.level = ANY(${shareLevels}::text[]))`
      : sql`false`;
    return sql<boolean>`(${r}.lifecycle_state = ANY(${states}::core.lifecycle_state[])
      AND (${wsBranch} OR ${brandBranch} OR ${projectBranch} OR ${shareBranch}))`;
  };
  return { ctx, where };
}
