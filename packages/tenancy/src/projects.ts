import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  levelRank,
  minLevel,
  projectChainLevel,
  roleCap,
  type Level,
  type Principal,
  type ProjectChain,
} from './policy.ts';

/**
 * Project scope facts for the one compiler (0C §4.5, AZ-21). Tenancy reads `work.project` only as
 * scope data (ancestry and access mode), never project content; the work module owns the rows.
 *
 * Restriction: a restricted project, and every descendant of one, stops brand, workspace, and
 * implicit role access. Explicit project grants flow down to descendants until a restricted
 * project (the restricted project's own grants still count for it and below).
 */

export interface ProjectScopeRow {
  id: string;
  brandId: string;
  restricted: boolean;
  /** Root first, excluding self. */
  ancestorIds: readonly string[];
}

export interface ProjectScope {
  /** Projects whose chain contains a restricted project (brand access does not reach them). */
  restrictedChain: string[];
  /** Explicit project level per project reachable from the principal's project grants. */
  levels: ReadonlyMap<string, Level>;
}

/** The governing chain of one project (self first, then ancestors up to the root). */
export function chainFrom(
  row: Pick<ProjectScopeRow, 'id' | 'restricted' | 'ancestorIds'>,
  restrictedSelf: ReadonlySet<string>,
): ProjectChain {
  return [
    { id: row.id, restricted: row.restricted },
    ...[...row.ancestorIds].reverse().map((id) => ({ id, restricted: restrictedSelf.has(id) })),
  ];
}

/**
 * Loads the scope rows that can affect the principal: every restricted project and its
 * descendants, and every project reachable from the principal's explicit project grants. Small by
 * construction (restrictions and explicit grants are rare compared with projects). The walk seeds
 * from the restricted partial index and the primary key and descends by `parent_project_id`
 * (`project_children`): array operators are not leakproof, so under RLS they could not use an
 * index and would scan every project in the workspace.
 */
export async function projectScope(tx: WorkspaceTransaction, p: Principal): Promise<ProjectScope> {
  const granted = [...p.projectGrants.keys()].sort();
  const rows = await sql<{
    id: string;
    brand_id: string;
    restricted: boolean;
    ancestor_ids: string[];
  }>`WITH RECURSIVE sub AS (
        SELECT d.id, d.brand_id, d.access_mode, d.ancestor_ids, d.lifecycle_state
          FROM work.project d
         WHERE d.access_mode = 'restricted' OR d.id = ANY(${granted}::uuid[])
        UNION
        SELECT c.id, c.brand_id, c.access_mode, c.ancestor_ids, c.lifecycle_state
          FROM work.project c JOIN sub ON c.parent_project_id = sub.id
      )
      SELECT id, brand_id, access_mode = 'restricted' AS restricted, ancestor_ids
        FROM sub WHERE lifecycle_state <> 'purged'`.execute(tx.db);
  const restrictedSelf = new Set(rows.rows.filter((r) => r.restricted).map((r) => r.id));
  const restrictedChain: string[] = [];
  const levels = new Map<string, Level>();
  const cap = roleCap(p.role);
  for (const r of rows.rows) {
    const chain = chainFrom(
      { id: r.id, restricted: r.restricted, ancestorIds: r.ancestor_ids },
      restrictedSelf,
    );
    if (chain.some((n) => n.restricted)) restrictedChain.push(r.id);
    if (p.kind === 'guest' || !granted.length) continue;
    const capped = minLevel(projectChainLevel(p, chain).explicit, cap);
    if (capped) levels.set(r.id, capped);
  }
  restrictedChain.sort();
  return { restrictedChain, levels };
}

/** Projects where the principal's explicit project level reaches `need`. */
export function projectIdsAtLevel(scope: ProjectScope, need: Level): string[] {
  return [...scope.levels.entries()]
    .filter(([, lv]) => levelRank(lv) >= levelRank(need))
    .map(([id]) => id)
    .sort();
}

/** Loads one project's chain by id (single-record decisions; same facts as the predicate). */
export async function projectChainOf(
  tx: WorkspaceTransaction,
  projectId: string,
): Promise<{ chain: ProjectChain; brandId: string; allowRecordShares: boolean } | null> {
  const row = await tx.db
    .selectFrom('work.project')
    .select(['id', 'brand_id', 'access_mode', 'ancestor_ids', 'allow_record_shares'])
    .where('id', '=', projectId)
    .where('lifecycle_state', '<>', 'purged')
    .executeTakeFirst();
  if (!row) return null;
  const restrictedAncestors = row.ancestor_ids.length
    ? (
        await tx.db
          .selectFrom('work.project')
          .select('id')
          .where('id', 'in', row.ancestor_ids)
          .where('access_mode', '=', 'restricted')
          .execute()
      ).map((r) => r.id)
    : [];
  return {
    chain: chainFrom(
      { id: row.id, restricted: row.access_mode === 'restricted', ancestorIds: row.ancestor_ids },
      new Set(restrictedAncestors),
    ),
    brandId: row.brand_id,
    allowRecordShares: row.allow_record_shares,
  };
}

/**
 * SQL for the governing project of a `core.record` row: the project itself, or the project that
 * contains a phase, milestone, decision, or task (2B; a projectless task has none and follows its
 * brand). Other record types have none.
 */
export function governingProject(alias: string) {
  const r = sql.raw(alias);
  return sql<string | null>`(CASE ${r}.record_type
    WHEN 'project' THEN ${r}.id
    WHEN 'phase' THEN (SELECT x.project_id FROM work.phase x WHERE x.workspace_id = ${r}.workspace_id AND x.id = ${r}.id)
    WHEN 'milestone' THEN (SELECT x.project_id FROM work.milestone x WHERE x.workspace_id = ${r}.workspace_id AND x.id = ${r}.id)
    WHEN 'decision_record' THEN (SELECT x.project_id FROM work.decision_record x WHERE x.workspace_id = ${r}.workspace_id AND x.id = ${r}.id)
    WHEN 'task' THEN (SELECT x.project_id FROM work.task x WHERE x.workspace_id = ${r}.workspace_id AND x.id = ${r}.id)
    ELSE NULL END)`;
}

/** The governing project id of a record (the same derivation as `governingProject`), or null. */
export async function governingProjectId(
  tx: WorkspaceTransaction,
  record: { id: string; recordType: string },
): Promise<string | null> {
  if (record.recordType === 'project') return record.id;
  const table =
    record.recordType === 'task'
      ? 'work.task'
      : record.recordType === 'phase'
        ? 'work.phase'
        : record.recordType === 'milestone'
          ? 'work.milestone'
          : record.recordType === 'decision_record'
            ? 'work.decision_record'
            : null;
  if (!table) return null;
  const r = await sql<{
    project_id: string | null;
  }>`SELECT project_id FROM ${sql.table(table)} WHERE id = ${record.id}`.execute(tx.db);
  return r.rows[0]?.project_id ?? null;
}
