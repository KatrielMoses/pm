import { sql, type WorkspaceTransaction } from '@pm/db';
import { levelRank, type Level, type Principal } from '@pm/tenancy';
import type { FieldType } from './field-types.ts';
import type { FormulaAst } from './formula.ts';
import type { RecordKind } from './statuses.ts';

/**
 * Which custom fields apply to a record and what one viewer may do with each (ADR-0015 W11, W19,
 * W20, W22; 0C §7.1–7.2, AZ-23). Every serializer, error, required-field check, serialization,
 * and formula explanation goes through `fieldsForRecord`, so hidden fields are absent everywhere.
 *
 * Applicability: definitions at the workspace, the record's brand, and the record's project
 * (a task's project, or a project record itself) accumulate; within one lineage the most specific
 * scope shadows broader ones. `via_set` definitions apply only through an attached set version.
 * Archived definitions still apply when the record has a value (read-only history).
 */

export interface DefinitionRow {
  id: string;
  public_id: string;
  lineage_id: string;
  scope_kind: 'workspace' | 'brand' | 'project';
  brand_id: string | null;
  project_id: string | null;
  name: string;
  description: string | null;
  field_type: FieldType;
  config: Record<string, unknown>;
  required: boolean;
  presentation: 'primary' | 'advanced';
  applicability: 'always' | 'via_set';
  view_visibility: Record<string, unknown>;
  formula_ast: FormulaAst | null;
  formula_version: number;
  result_type: string | null;
  applies_to_project: boolean;
  applies_to_task: boolean;
  rank: string;
  state: 'active' | 'archived';
  version: number;
  extensions: Record<string, unknown>;
}
export interface PolicyRow {
  read_rule: 'all_readers' | 'min_level';
  read_min_level: Level | null;
  edit_min_level: Level | null;
  guest_visible: boolean;
}
export interface ResolvedField {
  def: DefinitionRow;
  policy: PolicyRow;
  /** Presentation override from an attached set version, if any. */
  presentation: 'primary' | 'advanced';
  setRank: number | null;
  readable: boolean;
  editable: boolean;
  /** Formula inputs (definition ids), for formulas only. */
  inputs: string[];
}

const DEFAULT_POLICY: PolicyRow = {
  read_rule: 'all_readers',
  read_min_level: null,
  edit_min_level: null,
  guest_visible: false,
};
const SCOPE_ORDER = { project: 0, brand: 1, workspace: 2 } as const;

export const DEFINITION_COLUMNS = [
  'id',
  'public_id',
  'lineage_id',
  'scope_kind',
  'brand_id',
  'project_id',
  'name',
  'description',
  'field_type',
  'config',
  'required',
  'presentation',
  'applicability',
  'view_visibility',
  'formula_ast',
  'formula_version',
  'result_type',
  'applies_to_project',
  'applies_to_task',
  'rank',
  'state',
  'version',
  'extensions',
] as const;

export const toDefinition = (r: Record<string, unknown>): DefinitionRow =>
  ({
    ...r,
    version: Number(r.version),
    formula_version: Number(r.formula_version),
  }) as unknown as DefinitionRow;

/** Field policy: readable and editable for one viewer at their record level (0C §7.1). */
export function canRead(p: Principal, level: Level | null, pol: PolicyRow): boolean {
  if (level === null) return false;
  if (p.kind === 'guest' && !pol.guest_visible) return false;
  if (pol.read_rule === 'min_level' && levelRank(level) < levelRank(pol.read_min_level))
    return false;
  return true;
}
export function canEdit(p: Principal, level: Level | null, pol: PolicyRow): boolean {
  if (!canRead(p, level, pol)) return false;
  const need: Level =
    pol.edit_min_level && levelRank(pol.edit_min_level) > levelRank('edit')
      ? pol.edit_min_level
      : 'edit';
  return levelRank(level) >= levelRank(need);
}

export async function policiesOf(tx: WorkspaceTransaction, ids: string[]) {
  const out = new Map<string, PolicyRow>();
  // Always one statement, even with no definitions (constant shape, ADR-0015 W20).
  for (const r of await tx.db
    .selectFrom('access.field_policy')
    .select(['definition_id', 'read_rule', 'read_min_level', 'edit_min_level', 'guest_visible'])
    .where('definition_id', 'in', ids.length ? ids : ['00000000-0000-7000-8000-000000000000'])
    .execute())
    out.set(r.definition_id, r as unknown as PolicyRow);
  return out;
}

/**
 * The fields of one record for one viewer (`level` is the viewer's level on the record; null
 * means the viewer cannot read the record, so nothing is readable).
 */
export async function fieldsForRecord(
  tx: WorkspaceTransaction,
  p: Principal,
  record: { id: string; kind: RecordKind; brandId: string; projectId: string | null },
  level: Level | null,
): Promise<ResolvedField[]> {
  const defs = (
    await tx.db
      .selectFrom('workflow.field_definition')
      .select([...DEFINITION_COLUMNS])
      .where(record.kind === 'project' ? 'applies_to_project' : 'applies_to_task', '=', true)
      .where((eb) =>
        eb.or([
          eb('scope_kind', '=', 'workspace'),
          eb.and([eb('scope_kind', '=', 'brand'), eb('brand_id', '=', record.brandId)]),
          ...(record.projectId
            ? [eb.and([eb('scope_kind', '=', 'project'), eb('project_id', '=', record.projectId)])]
            : []),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb('state', '=', 'active'),
          eb.exists(
            eb
              .selectFrom('workflow.field_value as v')
              .select(sql`1`.as('x'))
              .whereRef('v.definition_id', '=', 'workflow.field_definition.id')
              .where('v.record_id', '=', record.id),
          ),
        ]),
      )
      .orderBy('rank')
      .orderBy('id')
      .execute()
  ).map(toDefinition);
  // Attached set versions: which via_set definitions apply, and presentation overrides.
  const attached = await tx.db
    .selectFrom('workflow.field_set_attachment as a')
    .innerJoin('workflow.field_set_version as v', (j) =>
      j.onRef('v.field_set_id', '=', 'a.field_set_id').onRef('v.version', '=', 'a.version'),
    )
    .select(['v.items'])
    .where('a.record_id', '=', record.id)
    .execute();
  const fromSets = new Map<string, { presentation: 'primary' | 'advanced' | null; rank: number }>();
  let n = 0;
  for (const a of attached)
    for (const it of a.items as Array<{
      definition_id: string;
      presentation: 'primary' | 'advanced' | null;
    }>)
      if (!fromSets.has(it.definition_id))
        fromSets.set(it.definition_id, { presentation: it.presentation, rank: n++ });
  // Lineage shadowing: the most specific active scope wins.
  const byLineage = new Map<string, DefinitionRow>();
  for (const d of defs) {
    if (d.applicability === 'via_set' && !fromSets.has(d.id)) continue;
    const cur = byLineage.get(d.lineage_id);
    if (
      !cur ||
      SCOPE_ORDER[d.scope_kind] < SCOPE_ORDER[cur.scope_kind] ||
      (cur.state === 'archived' && d.state === 'active')
    )
      byLineage.set(d.lineage_id, d);
  }
  const chosen = [...byLineage.values()];
  const policies = await policiesOf(
    tx,
    chosen.map((d) => d.id),
  );
  const deps = await formulaInputs(
    tx,
    chosen.filter((d) => d.field_type === 'formula').map((d) => d.id),
  );
  const base = new Map(
    chosen.map((d) => {
      const pol = policies.get(d.id) ?? DEFAULT_POLICY;
      return [d.id, { d, pol, read: canRead(p, level, pol) }] as const;
    }),
  );
  // A formula is readable only where every (transitive) input is readable (AT-127).
  const readable = (id: string, seen: Set<string> = new Set()): boolean => {
    const b = base.get(id);
    if (!b || !b.read) return false;
    if (b.d.field_type !== 'formula') return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (deps.get(id) ?? []).every((x) => readable(x, seen));
  };
  return chosen.map((d) => {
    const b = base.get(d.id)!;
    const set = fromSets.get(d.id);
    const r = readable(d.id);
    return {
      def: d,
      policy: b.pol,
      presentation: set?.presentation ?? d.presentation,
      setRank: set?.rank ?? null,
      readable: r,
      editable: r && d.state === 'active' && d.field_type !== 'formula' && canEdit(p, level, b.pol),
      inputs: deps.get(d.id) ?? [],
    };
  });
}

export async function formulaInputs(tx: WorkspaceTransaction, ids: string[]) {
  const out = new Map<string, string[]>();
  for (const r of await tx.db
    .selectFrom('workflow.formula_dependency')
    .select(['definition_id', 'depends_on_definition_id'])
    .where('definition_id', 'in', ids.length ? ids : ['00000000-0000-7000-8000-000000000000'])
    .execute())
    out.set(r.definition_id, [...(out.get(r.definition_id) ?? []), r.depends_on_definition_id]);
  return out;
}

/** Stored values of a record (canonical JSON by definition id). */
export async function valuesOf(tx: WorkspaceTransaction, recordId: string) {
  const rows = await tx.db
    .selectFrom('workflow.field_value')
    .select([
      'definition_id',
      'value',
      'computed',
      'formula_version',
      'error_code',
      'version',
      'extensions',
    ])
    .where('record_id', '=', recordId)
    .execute();
  return new Map(rows.map((r) => [r.definition_id, r]));
}
