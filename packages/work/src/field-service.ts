import { createHash } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  decideRecord,
  invalid,
  issue,
  parseIfMatch,
  requireVersion,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { isPublic } from './validation.ts';
import { WorkflowService, type ConfigScope } from './workflow-service.ts';
import {
  DEFINITION_COLUMNS,
  fieldsForRecord,
  formulaInputs,
  policiesOf,
  toDefinition,
  valuesOf,
  type DefinitionRow,
  type ResolvedField,
} from './workflow/field-access.ts';
import {
  CONTROL_CHARS,
  currencyExponent,
  FIELD_TYPES,
  FieldValidation,
  hasValue,
  normalizeValue,
  parseFieldConfig,
  type FieldType,
} from './workflow/field-types.ts';
import {
  compileFormula,
  evaluate,
  FormulaError,
  formulaSource,
  storeResult,
  type FormulaAst,
  type FormulaType,
  type Value,
} from './workflow/formula.ts';
import {
  canonical,
  DocumentError,
  FIELD_DOCUMENT_SCHEMA,
  FIELD_DOCUMENT_VERSION,
  parseFieldDocument,
  serializeFieldDocument,
} from './workflow/serialization.ts';
import type { RecordKind } from './workflow/statuses.ts';

/**
 * Custom fields (Phase 2C, ADR-0015 W10–W23): definitions with field policy and formulas,
 * options, typed values with field merge, field sets with explicit upgrades, and canonical
 * serialization. Values go through `fieldsForRecord`, so hidden fields are absent everywhere.
 */

export const VIEW_KINDS = ['list', 'board', 'table', 'calendar', 'timeline', 'gantt'] as const;
const SCOPE_RANK = { workspace: 0, brand: 1, project: 2 } as const;
const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');
const sha = (v: unknown) =>
  `sha256:${createHash('sha256')
    .update(canonical(v ?? null))
    .digest('hex')}`;

/** Formula input type of a field (person and label values are never formula inputs). */
function formulaTypeOf(d: Pick<DefinitionRow, 'field_type' | 'result_type'>): FormulaType | null {
  switch (d.field_type) {
    case 'number':
    case 'currency':
    case 'percentage':
      return 'number';
    case 'date':
      return 'date';
    case 'checkbox':
      return 'boolean';
    case 'text':
    case 'url':
    case 'email':
    case 'select':
      return 'text';
    case 'formula':
      return d.result_type as FormulaType;
    default:
      return null;
  }
}

export class FieldService extends WorkflowService {
  protected get fieldBounds() {
    return { textMax: this.ws.fieldTextMax, patternMax: this.ws.fieldPatternMax };
  }
  protected get formulaLimits() {
    return {
      sourceMax: this.ws.formulaSourceMax,
      nodesMax: this.ws.formulaAstNodesMax,
      refsMax: this.ws.formulaRefsMax,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Definitions
  // ---------------------------------------------------------------------------------------------

  protected async definitionRow(
    tx: WorkspaceTransaction,
    fld: unknown,
    lock = false,
  ): Promise<DefinitionRow> {
    if (!isPublic(fld, 'fld')) throw new TenancyError('not_found');
    let q = tx.db
      .selectFrom('workflow.field_definition')
      .select([...DEFINITION_COLUMNS])
      .where('public_id', '=', fld);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new TenancyError('not_found');
    return toDefinition(r);
  }

  protected async definitionView(tx: WorkspaceTransaction, d: DefinitionRow, scope: ConfigScope) {
    const pol = (await policiesOf(tx, [d.id])).get(d.id);
    const options = d.field_type === 'select' ? await this.optionsOf(tx, d.id, true) : [];
    const inputs =
      d.field_type === 'formula' ? ((await formulaInputs(tx, [d.id])).get(d.id) ?? []) : [];
    const inputIds = await this.publicIdsOf(tx, inputs, 'workflow.field_definition');
    const lineage =
      d.lineage_id === d.id
        ? d.public_id
        : ((await this.publicIdsOf(tx, [d.lineage_id], 'workflow.field_definition')).get(
            d.lineage_id,
          ) ?? null);
    const valueCount = await tx.db
      .selectFrom('workflow.field_value')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('definition_id', '=', d.id)
      .executeTakeFirstOrThrow();
    return {
      id: d.public_id,
      type: 'field_definition' as const,
      lineage,
      scope: this.scopeView(scope),
      name: d.name,
      description: d.description,
      field_type: d.field_type,
      applies_to: [
        ...(d.applies_to_project ? ['project'] : []),
        ...(d.applies_to_task ? ['task'] : []),
      ],
      config:
        d.field_type === 'formula'
          ? { source: d.formula_ast ? formulaSource((d.formula_ast as FormulaAst).root) : '' }
          : d.config,
      required: d.required,
      presentation: d.presentation,
      applicability: d.applicability,
      view_visibility: d.view_visibility,
      visibility: {
        read: pol?.read_rule ?? 'all_readers',
        read_min_level: pol?.read_min_level ?? null,
        edit_min_level: pol?.edit_min_level ?? null,
        guest_visible: pol?.guest_visible ?? false,
      },
      options,
      formula:
        d.field_type === 'formula'
          ? {
              result_type: d.result_type,
              version: d.formula_version,
              depends_on: inputs.map((i) => inputIds.get(i)),
            }
          : null,
      state: d.state,
      in_use: Number(valueCount.n) > 0,
      version: d.version,
    };
  }

  protected async optionsOf(tx: WorkspaceTransaction, definitionId: string, all: boolean) {
    let q = tx.db
      .selectFrom('workflow.field_option')
      .select(['id', 'public_id', 'label', 'color', 'state', 'rank', 'version'])
      .where('definition_id', '=', definitionId);
    if (!all) q = q.where('state', '=', 'active');
    return (await q.orderBy('rank').orderBy('id').execute()).map((o) => ({
      id: o.public_id,
      label: o.label,
      color: o.color,
      state: o.state,
      version: Number(o.version),
    }));
  }

  async listFieldDefinitions(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const scope = await this.configScope(tx, p, 'fields.configure', query.scope);
      let q = tx.db
        .selectFrom('workflow.field_definition')
        .select([...DEFINITION_COLUMNS])
        .where('scope_kind', '=', scope.kind)
        .where((eb) =>
          scope.brandId ? eb('brand_id', '=', scope.brandId) : eb('brand_id', 'is', null),
        )
        .where((eb) =>
          scope.projectId ? eb('project_id', '=', scope.projectId) : eb('project_id', 'is', null),
        );
      if (query.state !== 'all') q = q.where('state', '=', 'active');
      const rows = (
        await q.orderBy('rank').orderBy('id').limit(this.ws.fieldDefinitionsMax).execute()
      ).map(toDefinition);
      // Broader definitions that also apply here (read-only context for shadowing).
      const inherited =
        scope.kind === 'workspace'
          ? []
          : (
              await tx.db
                .selectFrom('workflow.field_definition')
                .select(['public_id', 'name', 'field_type', 'scope_kind'])
                .where('state', '=', 'active')
                .where((eb) =>
                  eb.or([
                    eb('scope_kind', '=', 'workspace'),
                    ...(scope.kind === 'project'
                      ? [
                          eb.and([
                            eb('scope_kind', '=', 'brand'),
                            eb('brand_id', '=', scope.brandId!),
                          ]),
                        ]
                      : []),
                  ]),
                )
                .orderBy('rank')
                .limit(this.ws.fieldDefinitionsMax)
                .execute()
            ).map((r) => ({
              id: r.public_id,
              name: r.name,
              field_type: r.field_type,
              scope_kind: r.scope_kind,
            }));
      const data = [];
      for (const d of rows) data.push(await this.definitionView(tx, d, scope));
      return { data, scope: this.scopeView(scope), inherited };
    });
  }

  async getFieldDefinition(caller: Caller, ws: unknown, fld: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const d = await this.definitionRow(tx, fld);
      return this.definitionView(tx, d, await this.rowScope(tx, p, 'fields.configure', d));
    });
  }

  /** Parses the editable parts of a definition (type-aware); `type` is fixed after creation. */
  protected parseDefinitionBody(b: Record<string, unknown>, type: FieldType, creating: boolean) {
    const known = [
      'scope',
      'name',
      'description',
      'field_type',
      'applies_to',
      'config',
      'required',
      'presentation',
      'applicability',
      'view_visibility',
      'visibility',
      'shadow',
      'version',
    ];
    for (const k of Object.keys(b))
      if (!known.includes(k))
        throw invalid(issue(`/${k}`, 'unsupported_field', 'Unknown setting.'));
    if (!creating && b.field_type !== undefined)
      throw invalid(issue('/field_type', 'immutable', 'A field keeps its type.'));
    const out: Record<string, unknown> = {};
    const text = (k: string, max: number, required: boolean): void => {
      const v = b[k];
      if (v === undefined) return;
      if (v === null && !required) {
        out[k] = null;
        return;
      }
      if (typeof v !== 'string' || !v.trim())
        throw invalid(issue(`/${k}`, 'required', 'Enter a value.'));
      const t = v.trim().replace(/\s+/g, ' ');
      if ([...t].length > max || CONTROL_CHARS.test(t))
        throw invalid(issue(`/${k}`, 'invalid', `Use at most ${max} plain characters.`));
      out[k] = t;
    };
    text('name', 80, true);
    if (creating && out.name === undefined)
      throw invalid(issue('/name', 'required', 'Enter a field name.'));
    text('description', 500, false);
    if (b.applies_to !== undefined || creating) {
      const a = b.applies_to ?? ['task'];
      if (!Array.isArray(a) || !a.length || a.some((x) => x !== 'project' && x !== 'task'))
        throw invalid(issue('/applies_to', 'invalid', 'Choose projects, tasks, or both.'));
      out.applies_to_project = a.includes('project');
      out.applies_to_task = a.includes('task');
    }
    if (b.config !== undefined || creating)
      out.config = parseFieldConfig(type, b.config, this.fieldBounds);
    if (b.required !== undefined) {
      if (typeof b.required !== 'boolean' || (b.required && type === 'formula'))
        throw invalid(issue('/required', 'invalid', 'Formula fields cannot be required.'));
      out.required = b.required;
    }
    if (b.presentation !== undefined) {
      if (b.presentation !== 'primary' && b.presentation !== 'advanced')
        throw invalid(issue('/presentation', 'invalid', 'Choose primary or advanced.'));
      out.presentation = b.presentation;
    }
    if (b.applicability !== undefined) {
      if (b.applicability !== 'always' && b.applicability !== 'via_set')
        throw invalid(issue('/applicability', 'invalid', 'Choose always or through a field set.'));
      out.applicability = b.applicability;
    }
    if (b.view_visibility !== undefined) {
      const v = b.view_visibility;
      if (
        !isObj(v) ||
        Object.entries(v).some(
          ([k, x]) => !(VIEW_KINDS as readonly string[]).includes(k) || typeof x !== 'boolean',
        )
      )
        throw invalid(
          issue('/view_visibility', 'invalid', `Map ${VIEW_KINDS.join(', ')} to true or false.`),
        );
      out.view_visibility = Object.fromEntries(Object.entries(v).sort());
    }
    if (b.visibility !== undefined) {
      const v = b.visibility;
      if (!isObj(v))
        throw invalid(issue('/visibility', 'invalid', 'Choose who can see and edit the field.'));
      const read = v.read ?? 'all_readers';
      if (read !== 'all_readers' && read !== 'min_level')
        throw invalid(
          issue(
            '/visibility/read',
            'invalid',
            'Choose everyone who can read the record, or a minimum level.',
          ),
        );
      const rml = v.read_min_level ?? null;
      if (read === 'min_level' && !['comment', 'edit', 'manage'].includes(rml as string))
        throw invalid(
          issue('/visibility/read_min_level', 'invalid', 'Choose comment, edit, or manage.'),
        );
      const eml = v.edit_min_level ?? null;
      if (eml !== null && !['edit', 'manage'].includes(eml as string))
        throw invalid(issue('/visibility/edit_min_level', 'invalid', 'Choose edit or manage.'));
      if (v.guest_visible !== undefined && typeof v.guest_visible !== 'boolean')
        throw invalid(issue('/visibility/guest_visible', 'invalid', 'Choose yes or no.'));
      out.visibility = {
        read_rule: read,
        read_min_level: read === 'min_level' ? rml : null,
        edit_min_level: eml,
        guest_visible: v.guest_visible === true,
      };
    }
    return out;
  }

  /**
   * Compiles a formula against the definitions it may reference (same or broader scope, same
   * workspace, active, a formula input type), then checks the dependency depth and cycles.
   */
  protected async compileFor(
    tx: WorkspaceTransaction,
    self: { id: string | null; scope: ConfigScope },
    source: string,
  ) {
    const refs = new Map<string, DefinitionRow>();
    let compiled: ReturnType<typeof compileFormula>;
    try {
      // Pre-resolve every reference mentioned in the source.
      const ids = [...source.matchAll(/\{\s*(fld_[0-9A-HJKMNP-TV-Z]{26})\s*\}/g)].map((m) => m[1]!);
      if (ids.length) {
        const rows = (
          await tx.db
            .selectFrom('workflow.field_definition')
            .select([...DEFINITION_COLUMNS])
            .where('public_id', 'in', [...new Set(ids)])
            .execute()
        ).map(toDefinition);
        for (const r of rows) refs.set(r.public_id, r);
      }
      const usable = (r: DefinitionRow | undefined) => {
        if (!r || r.state !== 'active' || r.id === self.id) return null;
        if (SCOPE_RANK[r.scope_kind] > SCOPE_RANK[self.scope.kind]) return null;
        if (r.scope_kind === 'brand' && r.brand_id !== self.scope.brandId) return null;
        if (r.scope_kind === 'project' && r.project_id !== self.scope.projectId) return null;
        return formulaTypeOf(r);
      };
      compiled = compileFormula(source, this.formulaLimits, (f) => usable(refs.get(f)));
    } catch (e) {
      if (e instanceof FormulaError)
        throw invalid(
          issue(
            '/config/source',
            e.code === 'limit_exceeded' ? 'limit_exceeded' : 'formula_invalid',
            e.message,
          ),
        );
      throw e;
    }
    const inputIds = compiled.refs.map((r) => refs.get(r)!.id);
    // Depth: the longest chain through existing formulas (bounded by FORMULA_DEPTH_MAX); a chain
    // that reaches this definition is a cycle.
    const depthOf = async (ids: string[], depth: number, seen: Set<string>): Promise<number> => {
      if (!ids.length) return depth;
      if (depth > this.ws.formulaDepthMax)
        throw invalid(
          issue(
            '/config/source',
            'depth_exceeded',
            `Formulas can depend on at most ${this.ws.formulaDepthMax} levels of formulas.`,
          ),
        );
      if (self.id && ids.includes(self.id))
        throw invalid(issue('/config/source', 'cycle', 'This formula would depend on itself.'));
      const next = await formulaInputs(tx, ids);
      const deeper = [...next.values()].flat().filter((x) => !seen.has(x));
      for (const x of deeper) seen.add(x);
      return deeper.length ? depthOf(deeper, depth + 1, seen) : depth;
    };
    await depthOf(inputIds, 1, new Set(inputIds));
    return { ast: compiled.ast, inputIds };
  }

  protected async writePolicy(
    tx: WorkspaceTransaction,
    defId: string,
    v: Record<string, unknown> | undefined,
  ) {
    if (!v) return;
    await tx.db
      .insertInto('access.field_policy')
      .values({
        workspace_id: tx.workspaceId,
        definition_id: defId,
        read_rule: v.read_rule as string,
        read_min_level: v.read_min_level as string | null,
        edit_min_level: v.edit_min_level as string | null,
        guest_visible: v.guest_visible as boolean,
      })
      .onConflict((oc) =>
        oc.column('definition_id').doUpdateSet({
          read_rule: v.read_rule as string,
          read_min_level: v.read_min_level as string | null,
          edit_min_level: v.edit_min_level as string | null,
          guest_visible: v.guest_visible as boolean,
          updated_at: new Date(),
          version: sql`access.field_policy.version + 1`,
        }),
      )
      .execute();
  }

  async createFieldDefinition(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const type = b.field_type as FieldType;
    if (!(FIELD_TYPES as readonly string[]).includes(type))
      throw invalid(issue('/field_type', 'invalid', `Choose one of ${FIELD_TYPES.join(', ')}.`));
    const parsed = this.parseDefinitionBody(b, type, true);
    return this.mutate(
      caller,
      'fields.create',
      ws,
      req,
      async (tx, p) => {
        const scope = await this.configScope(tx, p, 'fields.configure', b.scope);
        const count = await tx.db
          .selectFrom('workflow.field_definition')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('scope_kind', '=', scope.kind)
          .where((eb) =>
            scope.brandId ? eb('brand_id', '=', scope.brandId) : eb('brand_id', 'is', null),
          )
          .where((eb) =>
            scope.projectId ? eb('project_id', '=', scope.projectId) : eb('project_id', 'is', null),
          )
          .where('state', '=', 'active')
          .executeTakeFirstOrThrow();
        if (Number(count.n) >= this.ws.fieldDefinitionsMax)
          throw new TenancyError('limit_exceeded', {
            issues: [
              issue('/', 'limit', `At most ${this.ws.fieldDefinitionsMax} fields per scope.`),
            ],
          });
        const id = newUuidV7();
        const publicId = newPublicId('fld');
        // Shadowing (W11): a narrower definition continues a broader definition's lineage.
        let lineage = id;
        if (b.shadow !== undefined) {
          const parent = await this.definitionRow(tx, b.shadow);
          if (SCOPE_RANK[parent.scope_kind] >= SCOPE_RANK[scope.kind] || parent.field_type !== type)
            throw invalid(issue('/shadow', 'invalid', 'Shadow a broader field of the same type.'));
          lineage = parent.lineage_id;
        }
        let formula: { ast: FormulaAst; inputIds: string[] } | null = null;
        if (type === 'formula')
          formula = await this.compileFor(
            tx,
            { id: null, scope },
            (parsed.config as { source: string }).source,
          );
        const rank = await this.nextRank(
          tx,
          'workflow.field_definition',
          (q) => q.where('scope_kind', '=', scope.kind),
          'last',
        );
        try {
          await tx.db
            .insertInto('workflow.field_definition')
            .values({
              id,
              public_id: publicId,
              workspace_id: tx.workspaceId,
              brand_id: scope.brandId,
              project_id: scope.projectId,
              scope_kind: scope.kind,
              lineage_id: lineage,
              applies_to_project: parsed.applies_to_project as boolean,
              applies_to_task: parsed.applies_to_task as boolean,
              name: parsed.name as string,
              normalized_name: norm(parsed.name as string),
              description: (parsed.description as string | null | undefined) ?? null,
              field_type: type,
              config: JSON.stringify(type === 'formula' ? {} : parsed.config),
              required: (parsed.required as boolean | undefined) ?? false,
              presentation: (parsed.presentation as 'primary' | undefined) ?? 'primary',
              applicability: (parsed.applicability as 'always' | undefined) ?? 'always',
              view_visibility: JSON.stringify(parsed.view_visibility ?? {}),
              formula_ast: formula ? JSON.stringify(formula.ast) : null,
              formula_version: formula ? 1 : 0,
              result_type: formula ? formula.ast.result : null,
              rank,
              created_by_membership_id: p.membershipId,
            })
            .execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw invalid(
              issue('/name', 'name_taken', 'A field with this name already exists here.'),
            );
          throw e;
        }
        for (const i of formula?.inputIds ?? [])
          await tx.db
            .insertInto('workflow.formula_dependency')
            .values({
              workspace_id: tx.workspaceId,
              definition_id: id,
              depends_on_definition_id: i,
            })
            .execute();
        await this.writePolicy(
          tx,
          id,
          (parsed.visibility as Record<string, unknown> | undefined) ?? {
            read_rule: 'all_readers',
            read_min_level: null,
            edit_min_level: null,
            guest_visible: false,
          },
        );
        await this.configAudit(
          tx,
          caller,
          p,
          'fields.created',
          { id, type: 'field_definition', publicId },
          [
            change.plain('field_type', null, type),
            change.plain('scope_kind', null, scope.kind),
            change.content('name', { hash: sha(parsed.name) }),
          ],
          scope.brandId,
        );
        await this.configEvent(
          tx,
          caller,
          p,
          'workflow.field_definition.created',
          { type: 'workflow.field_definition', id, sequence: 0 },
          { field_type: type, scope_kind: scope.kind },
          scope.brandId,
        );
        return {
          status: 201,
          ref: { id: publicId, type: 'field_definition' },
          data: await this.definitionView(tx, await this.definitionRow(tx, publicId), scope),
        };
      },
      async (tx, p, ref) => {
        const d = await this.definitionRow(tx, ref.id);
        return this.definitionView(tx, d, await this.rowScope(tx, p, 'fields.configure', d));
      },
    );
  }

  /** One configuration command on a definition: lock, decide at its scope, version, audit. */
  protected definitionCommand(
    caller: Caller,
    ws: unknown,
    fld: unknown,
    body: unknown,
    req: Mutation,
    command: string,
    fn: (
      tx: WorkspaceTransaction,
      p: Principal,
      ctx: { d: DefinitionRow; scope: ConfigScope; b: Record<string, unknown> },
    ) => Promise<ReturnType<typeof change.plain>[]>,
  ) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      command,
      ws,
      req,
      async (tx, p) => {
        const d = await this.definitionRow(tx, fld, true);
        const scope = await this.rowScope(tx, p, 'fields.configure', d);
        const expected =
          req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (b.version as number | undefined);
        if (expected === undefined) throw new TenancyError('precondition_required');
        requireVersion(expected, d.version);
        const audit = await fn(tx, p, { d, scope, b });
        await tx.db
          .updateTable('workflow.field_definition')
          .set({ version: sql`version + 1`, updated_at: new Date() })
          .where('id', '=', d.id)
          .execute();
        await this.configAudit(
          tx,
          caller,
          p,
          command,
          { id: d.id, type: 'field_definition', publicId: d.public_id },
          audit,
          scope.brandId,
        );
        const fresh = await this.definitionRow(tx, d.public_id);
        await this.configEvent(
          tx,
          caller,
          p,
          'workflow.field_definition.updated',
          { type: 'workflow.field_definition', id: d.id, sequence: d.version + 1 },
          { changed_fields: command.split('.').pop()!, lifecycle_state: fresh.state },
          scope.brandId,
        );
        return {
          status: 200,
          ref: { id: d.public_id, type: 'field_definition' },
          data: await this.definitionView(tx, fresh, scope),
        };
      },
      async (tx, p, ref) => {
        const d = await this.definitionRow(tx, ref.id);
        return this.definitionView(tx, d, await this.rowScope(tx, p, 'fields.configure', d));
      },
    );
  }

  updateFieldDefinition(caller: Caller, ws: unknown, fld: unknown, body: unknown, req: Mutation) {
    return this.definitionCommand(
      caller,
      ws,
      fld,
      body,
      req,
      'fields.update',
      async (tx, _p, { d, scope, b }) => {
        const parsed = this.parseDefinitionBody(b, d.field_type, false);
        const set: Record<string, unknown> = {};
        const audit: ReturnType<typeof change.plain>[] = [];
        for (const k of [
          'name',
          'description',
          'required',
          'presentation',
          'applicability',
          'applies_to_project',
          'applies_to_task',
        ])
          if (parsed[k] !== undefined) {
            set[k] = parsed[k];
            audit.push(
              k === 'name' || k === 'description'
                ? change.content(k, { hash: sha(parsed[k]) })
                : change.plain(
                    k,
                    (d as unknown as Record<string, unknown>)[k] as never,
                    parsed[k] as never,
                  ),
            );
          }
        if (set.name !== undefined) set.normalized_name = norm(set.name as string);
        if (parsed.view_visibility !== undefined)
          set.view_visibility = JSON.stringify(parsed.view_visibility);
        if (parsed.config !== undefined) {
          if (d.field_type === 'formula') {
            const f = await this.compileFor(
              tx,
              { id: d.id, scope },
              (parsed.config as { source: string }).source,
            );
            set.formula_ast = JSON.stringify(f.ast);
            set.result_type = f.ast.result;
            set.formula_version = d.formula_version + 1;
            await tx.db
              .deleteFrom('workflow.formula_dependency')
              .where('definition_id', '=', d.id)
              .execute();
            for (const i of f.inputIds)
              await tx.db
                .insertInto('workflow.formula_dependency')
                .values({
                  workspace_id: tx.workspaceId,
                  definition_id: d.id,
                  depends_on_definition_id: i,
                })
                .execute();
            audit.push(change.content('formula', { hash: sha(f.ast) }));
            // Existing results are stale by version; reads compute the current result until the
            // next write to each record materializes it (no queue is needed: inputs are same-record).
          } else {
            set.config = JSON.stringify(parsed.config);
            audit.push(change.plain('config', null, true));
          }
        }
        if (parsed.applies_to_project === false || parsed.applies_to_task === false) {
          const kind = parsed.applies_to_project === false ? 'project' : 'task';
          const used = await sql<{
            n: string;
          }>`SELECT count(*) AS n FROM workflow.field_value v JOIN core.record r ON r.id = v.record_id WHERE v.definition_id = ${d.id} AND r.record_type = ${kind}`.execute(
            tx.db,
          );
          if (Number(used.rows[0]?.n ?? 0))
            throw new TenancyError('conflict', {
              issues: [
                issue(
                  '/applies_to',
                  'in_use',
                  `Some ${kind}s have values for this field. Clear them first.`,
                ),
              ],
            });
        }
        if (Object.keys(set).length) {
          try {
            await tx.db
              .updateTable('workflow.field_definition')
              .set(set)
              .where('id', '=', d.id)
              .execute();
          } catch (e) {
            if ((e as { code?: string }).code === '23505')
              throw invalid(
                issue('/name', 'name_taken', 'A field with this name already exists here.'),
              );
            throw e;
          }
        }
        if (parsed.visibility) {
          await this.writePolicy(tx, d.id, parsed.visibility as Record<string, unknown>);
          audit.push(
            change.plain(
              'visibility',
              null,
              (parsed.visibility as { read_rule: string }).read_rule,
            ),
          );
        }
        return audit;
      },
    );
  }

  setFieldDefinitionState(
    caller: Caller,
    ws: unknown,
    fld: unknown,
    body: unknown,
    req: Mutation,
    state: 'active' | 'archived',
  ) {
    return this.definitionCommand(
      caller,
      ws,
      fld,
      body,
      req,
      state === 'archived' ? 'fields.archive' : 'fields.unarchive',
      async (tx, _p, { d }) => {
        if (state === 'archived') {
          const dependents = await tx.db
            .selectFrom('workflow.formula_dependency as fd')
            .innerJoin('workflow.field_definition as f', 'f.id', 'fd.definition_id')
            .select('f.id')
            .where('fd.depends_on_definition_id', '=', d.id)
            .where('f.state', '=', 'active')
            .limit(1)
            .execute();
          if (dependents.length)
            throw new TenancyError('conflict', {
              issues: [
                issue(
                  '/',
                  'in_use',
                  'Active formulas use this field. Change or archive them first.',
                ),
              ],
            });
        }
        try {
          await tx.db
            .updateTable('workflow.field_definition')
            .set({ state })
            .where('id', '=', d.id)
            .execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw new TenancyError('conflict', {
              issues: [
                issue('/', 'name_taken', 'An active field already uses this name or lineage here.'),
              ],
            });
          throw e;
        }
        return [change.plain('state', d.state, state)];
      },
    );
  }

  /** Purge: refused while values, formulas, transitions, or field sets refer to it (W9). */
  async deleteFieldDefinition(caller: Caller, ws: unknown, fld: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'fields.delete',
      ws,
      req,
      async (tx, p) => {
        const d = await this.definitionRow(tx, fld, true);
        const scope = await this.rowScope(tx, p, 'fields.configure', d);
        if (d.state !== 'archived')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'archive_first', 'Archive the field before deleting it.')],
          });
        const refs = await sql<{ n: string }>`
          SELECT (SELECT count(*) FROM workflow.field_value WHERE definition_id = ${d.id})
               + (SELECT count(*) FROM workflow.formula_dependency WHERE depends_on_definition_id = ${d.id})
               + (SELECT count(*) FROM workflow.transition_requirement WHERE definition_id = ${d.id})
               + (SELECT count(*) FROM workflow.field_set_version v, jsonb_array_elements(v.items) it WHERE it->>'definition_id' = ${d.id}) AS n`.execute(
          tx.db,
        );
        if (Number(refs.rows[0]?.n ?? 0))
          throw new TenancyError('conflict', {
            issues: [
              issue(
                '/',
                'in_use',
                'Values, formulas, transitions, or field sets still refer to this field.',
              ),
            ],
          });
        await tx.db.deleteFrom('workflow.field_option').where('definition_id', '=', d.id).execute();
        await tx.db.deleteFrom('workflow.field_definition').where('id', '=', d.id).execute();
        await this.configAudit(
          tx,
          caller,
          p,
          'fields.deleted',
          { id: d.id, type: 'field_definition', publicId: d.public_id },
          [change.plain('state', 'archived', 'deleted')],
          scope.brandId,
        );
        return {
          status: 200,
          ref: { id: d.public_id, type: 'field_definition' },
          data: { id: d.public_id, type: 'field_definition', deleted: true },
        };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'field_definition', deleted: true }),
    );
  }

  moveFieldDefinition(caller: Caller, ws: unknown, fld: unknown, body: unknown, req: Mutation) {
    return this.definitionCommand(
      caller,
      ws,
      fld,
      body,
      req,
      'fields.move',
      async (tx, _p, { d, b }) => {
        const after =
          b.after === null
            ? null
            : b.after === undefined
              ? 'last'
              : (await this.definitionRow(tx, b.after)).id;
        const rank = await this.nextRank(
          tx,
          'workflow.field_definition',
          (q) =>
            q
              .where('scope_kind', '=', d.scope_kind)
              .where('id', '<>', d.id)
              .where('brand_id', 'is not distinct from', d.brand_id)
              .where('project_id', 'is not distinct from', d.project_id),
          after,
        );
        await tx.db
          .updateTable('workflow.field_definition')
          .set({ rank })
          .where('id', '=', d.id)
          .execute();
        return [change.plain('moved', null, true)];
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Options (stable identity; in-use removal needs a replacement)
  // ---------------------------------------------------------------------------------------------

  protected async optionRow(tx: WorkspaceTransaction, definitionId: string, fop: unknown) {
    if (!isPublic(fop, 'fop')) throw new TenancyError('not_found');
    const o = await tx.db
      .selectFrom('workflow.field_option')
      .selectAll()
      .where('definition_id', '=', definitionId)
      .where('public_id', '=', fop)
      .executeTakeFirst();
    if (!o) throw new TenancyError('not_found');
    return o;
  }

  addOption(caller: Caller, ws: unknown, fld: unknown, body: unknown, req: Mutation) {
    return this.definitionCommand(
      caller,
      ws,
      fld,
      body,
      req,
      'fields.add_option',
      async (tx, _p, { d, b }) => {
        if (d.field_type !== 'select')
          throw invalid(issue('/', 'invalid', 'Only select fields have options.'));
        const label = typeof b.label === 'string' ? b.label.trim().replace(/\s+/g, ' ') : '';
        if (!label || [...label].length > 80)
          throw invalid(
            issue('/label', 'required', 'Enter an option label of at most 80 characters.'),
          );
        const color =
          typeof b.color === 'string' && /^#[0-9a-f]{6}$/.test(b.color) ? b.color : '#6b7280';
        const n = await tx.db
          .selectFrom('workflow.field_option')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('definition_id', '=', d.id)
          .where('state', '=', 'active')
          .executeTakeFirstOrThrow();
        if (Number(n.n) >= this.ws.fieldOptionsMax)
          throw new TenancyError('limit_exceeded', {
            issues: [issue('/', 'limit', `At most ${this.ws.fieldOptionsMax} options.`)],
          });
        const rank = await this.nextRank(
          tx,
          'workflow.field_option',
          (q) => q.where('definition_id', '=', d.id),
          'last',
        );
        try {
          await tx.db
            .insertInto('workflow.field_option')
            .values({
              id: newUuidV7(),
              public_id: newPublicId('fop'),
              workspace_id: tx.workspaceId,
              definition_id: d.id,
              label,
              normalized_label: norm(label),
              color,
              rank,
            })
            .execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw invalid(issue('/label', 'name_taken', 'This option already exists.'));
          throw e;
        }
        return [change.plain('option_added', null, true)];
      },
    );
  }

  updateOption(
    caller: Caller,
    ws: unknown,
    fld: unknown,
    fop: unknown,
    body: unknown,
    req: Mutation,
  ) {
    return this.definitionCommand(
      caller,
      ws,
      fld,
      body,
      req,
      'fields.update_option',
      async (tx, _p, { d, b }) => {
        const o = await this.optionRow(tx, d.id, fop);
        const set: Record<string, unknown> = { updated_at: new Date(), version: sql`version + 1` };
        if (b.label !== undefined) {
          const label = typeof b.label === 'string' ? b.label.trim().replace(/\s+/g, ' ') : '';
          if (!label || [...label].length > 80)
            throw invalid(
              issue('/label', 'required', 'Enter an option label of at most 80 characters.'),
            );
          Object.assign(set, { label, normalized_label: norm(label) });
        }
        if (b.color !== undefined) {
          if (typeof b.color !== 'string' || !/^#[0-9a-f]{6}$/.test(b.color))
            throw invalid(issue('/color', 'invalid', 'Choose a color.'));
          set.color = b.color;
        }
        if (b.state !== undefined) {
          if (b.state !== 'active' && b.state !== 'archived')
            throw invalid(issue('/state', 'invalid', 'Choose active or archived.'));
          set.state = b.state;
        }
        if (b.after !== undefined)
          set.rank = await this.nextRank(
            tx,
            'workflow.field_option',
            (q) => q.where('definition_id', '=', d.id).where('id', '<>', o.id),
            b.after === null ? null : (await this.optionRow(tx, d.id, b.after)).id,
          );
        try {
          await tx.db
            .updateTable('workflow.field_option')
            .set(set)
            .where('id', '=', o.id)
            .execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw invalid(issue('/label', 'name_taken', 'This option already exists.'));
          throw e;
        }
        return [change.plain('option_updated', null, true)];
      },
    );
  }

  /**
   * Removes an option. In use, it needs `replace_with` (another active option): values move in
   * one bounded batch (FIELD_VALUE_BULK_MAX); when more remain, the option stays and the response
   * says how many, so the command is repeated. Otherwise archive it.
   */
  removeOption(
    caller: Caller,
    ws: unknown,
    fld: unknown,
    fop: unknown,
    body: unknown,
    req: Mutation,
  ) {
    let remaining = 0;
    return this.definitionCommand(
      caller,
      ws,
      fld,
      body,
      req,
      'fields.remove_option',
      async (tx, _p, { d, b }) => {
        const o = await this.optionRow(tx, d.id, fop);
        const used = await tx.db
          .selectFrom('workflow.field_value')
          .select(['record_id'])
          .where('definition_id', '=', d.id)
          .where('value_ref', '=', o.id)
          .limit(this.ws.fieldValueBulkMax + 1)
          .execute();
        if (used.length) {
          if (b.replace_with === undefined)
            throw new TenancyError('conflict', {
              issues: [
                issue(
                  '/replace_with',
                  'in_use',
                  'Records use this option. Choose a replacement, or archive the option.',
                ),
              ],
            });
          const target = await this.optionRow(tx, d.id, b.replace_with);
          if (target.id === o.id || target.state !== 'active')
            throw invalid(issue('/replace_with', 'invalid', 'Choose another active option.'));
          const batch = used.slice(0, this.ws.fieldValueBulkMax).map((u) => u.record_id);
          await tx.db
            .updateTable('workflow.field_value')
            .set({
              value: JSON.stringify(target.id),
              version: sql`version + 1`,
              updated_at: new Date(),
            })
            .where('definition_id', '=', d.id)
            .where('record_id', 'in', batch)
            .execute();
          remaining = used.length - batch.length;
          if (remaining) return [change.plain('option_replaced', null, batch.length)];
        }
        await tx.db.deleteFrom('workflow.field_option').where('id', '=', o.id).execute();
        return [change.plain('option_removed', null, used.length)];
      },
    ).then((r) => ({ ...r, data: { ...r.data, remaining } }));
  }

  // ---------------------------------------------------------------------------------------------
  // Values
  // ---------------------------------------------------------------------------------------------

  /** Typed formula input from a stored value. */
  protected inputValue(
    d: DefinitionRow,
    stored: unknown,
    optionLabels: Map<string, string>,
  ): Value {
    if (stored === null || stored === undefined) return null;
    switch (d.field_type) {
      case 'number':
      case 'percentage':
        return Number(stored);
      case 'currency': {
        const c = stored as { minor: string; currency: string };
        return Number(c.minor) / 10 ** currencyExponent(c.currency);
      }
      case 'date':
        return { date: stored as string };
      case 'checkbox':
        return stored as boolean;
      case 'select':
        return optionLabels.get(stored as string) ?? null;
      case 'formula':
        return d.result_type === 'date'
          ? { date: stored as string }
          : d.result_type === 'number'
            ? Number(stored)
            : (stored as Value);
      default:
        return stored as string;
    }
  }

  /**
   * Formula results for a record, in dependency order, from the record's stored values. Returns
   * id → { value | error }. Never consults viewer visibility (results are filtered on output).
   */
  protected async computeFormulas(
    tx: WorkspaceTransaction,
    fields: ResolvedField[],
    stored: Map<string, { value: unknown }>,
  ) {
    const byId = new Map(fields.map((f) => [f.def.id, f]));
    const optionIds = fields.filter((f) => f.def.field_type === 'select').map((f) => f.def.id);
    const optionLabels = new Map<string, string>();
    if (optionIds.length)
      for (const o of await tx.db
        .selectFrom('workflow.field_option')
        .select(['id', 'label'])
        .where('definition_id', 'in', optionIds)
        .execute())
        optionLabels.set(o.id, o.label);
    const out = new Map<string, { value: unknown; error: string | null }>();
    const visiting = new Set<string>();
    const resolve = (id: string): { value: unknown; error: string | null } => {
      const done = out.get(id);
      if (done) return done;
      const f = byId.get(id)!;
      if (visiting.has(id)) return { value: null, error: 'cycle' };
      visiting.add(id);
      const r = evaluate(f.def.formula_ast as FormulaAst, (pub) => {
        const dep = fields.find((x) => x.def.public_id === pub);
        if (!dep) return null;
        if (dep.def.field_type === 'formula') {
          const v = resolve(dep.def.id);
          if (v.error) throw Object.assign(new Error('dep'), { dep: v.error });
          return this.inputValue(dep.def, v.value, optionLabels);
        }
        return this.inputValue(dep.def, stored.get(dep.def.id)?.value, optionLabels);
      });
      visiting.delete(id);
      const res = r.ok
        ? { value: storeResult(f.def.result_type as FormulaType, r.value), error: null }
        : { value: null, error: r.error };
      this.d.metrics.count('workflow.formula.evaluations', 1, { outcome: r.ok ? 'ok' : r.error });
      out.set(id, res);
      return res;
    };
    for (const f of fields)
      if (f.def.field_type === 'formula' && f.def.formula_ast) {
        try {
          resolve(f.def.id);
        } catch (e) {
          const code = (e as { dep?: string }).dep;
          if (!code) throw e;
          out.set(f.def.id, { value: null, error: code === 'cycle' ? 'cycle' : 'invalid' });
        }
      }
    return out;
  }

  /** Public form of stored values (people, labels, options by public ID and display). */
  protected async publicValues(
    tx: WorkspaceTransaction,
    fields: ResolvedField[],
    stored: Map<string, unknown>,
  ) {
    const refs = (type: FieldType) =>
      fields
        .filter((f) => f.def.field_type === type)
        .map((f) => stored.get(f.def.id))
        .filter((v): v is string => typeof v === 'string');
    const people = new Map<string, { id: string; name: string }>();
    const ppl = refs('person');
    if (ppl.length)
      for (const m of await tx.db
        .selectFrom('tenancy.membership as m')
        .innerJoin('identity.account as a', 'a.id', 'm.account_id')
        .select(['m.id', 'm.public_id', 'a.display_name', 'm.display_name_override'])
        .where('m.id', 'in', ppl)
        .execute())
        people.set(m.id, { id: m.public_id, name: m.display_name_override ?? m.display_name });
    const labels = new Map<
      string,
      { id: string; name: string; color: string; archived: boolean }
    >();
    const lbl = refs('label');
    if (lbl.length)
      for (const l of await tx.db
        .selectFrom('work.label')
        .select(['id', 'public_id', 'name', 'color', 'state'])
        .where('id', 'in', lbl)
        .execute())
        labels.set(l.id, {
          id: l.public_id,
          name: l.name,
          color: l.color,
          archived: l.state === 'archived',
        });
    const options = new Map<
      string,
      { id: string; label: string; color: string; archived: boolean }
    >();
    const opt = refs('select');
    if (opt.length)
      for (const o of await tx.db
        .selectFrom('workflow.field_option')
        .select(['id', 'public_id', 'label', 'color', 'state'])
        .where('id', 'in', opt)
        .execute())
        options.set(o.id, {
          id: o.public_id,
          label: o.label,
          color: o.color,
          archived: o.state === 'archived',
        });
    return (f: ResolvedField, v: unknown): unknown => {
      if (v === null || v === undefined) return null;
      switch (f.def.field_type) {
        case 'person':
          return people.get(v as string) ?? null;
        case 'label':
          return labels.get(v as string) ?? null;
        case 'select':
          return options.get(v as string) ?? null;
        case 'currency': {
          const c = v as { minor: string; currency: string };
          const exp = currencyExponent(c.currency);
          const neg = c.minor.startsWith('-');
          const digits = c.minor.replace('-', '').padStart(exp + 1, '0');
          return {
            ...c,
            amount: `${neg ? '-' : ''}${exp ? `${digits.slice(0, -exp)}.${digits.slice(-exp)}` : digits}`,
          };
        }
        default:
          return v;
      }
    };
  }

  /** The readable fields of a record with values (formula results current), for one viewer. */
  async recordFields(caller: Caller, ws: unknown, record: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const r = await this.workRecord(tx, p, record);
      const o = decideRecord(p, 'field.value_read', r.facts);
      this.decision('field.value_read', o);
      if (!o.allowed) throw new TenancyError(o.code);
      return this.fieldsPayload(tx, p, r);
    });
  }

  protected async fieldsPayload(
    tx: WorkspaceTransaction,
    p: Principal,
    r: Awaited<ReturnType<FieldService['workRecord']>>,
  ) {
    const fields = await fieldsForRecord(
      tx,
      p,
      { id: r.id, kind: r.kind, brandId: r.brandId, projectId: r.projectId },
      r.level,
    );
    const values = await valuesOf(tx, r.id);
    // Stale or missing formula results are computed now (reads never write).
    const stale = fields.some(
      (f) =>
        f.def.field_type === 'formula' &&
        values.get(f.def.id)?.formula_version !== f.def.formula_version,
    );
    const computed = stale
      ? await this.computeFormulas(
          tx,
          fields,
          new Map([...values].map(([k, v]) => [k, { value: v.value }])),
        )
      : null;
    const visible = fields.filter((f) => f.readable);
    const pub = await this.publicValues(
      tx,
      visible,
      new Map([...values].map(([k, v]) => [k, v.value])),
    );
    const editLevel = decideRecord(p, 'field.value_edit', r.facts).allowed;
    const options = new Map<string, unknown>();
    for (const f of visible.filter((x) => x.def.field_type === 'select'))
      options.set(f.def.id, await this.optionsOf(tx, f.def.id, false));
    const list = visible
      .sort(
        (a, b) =>
          (a.setRank ?? 1e9) - (b.setRank ?? 1e9) ||
          (a.def.rank < b.def.rank ? -1 : a.def.rank > b.def.rank ? 1 : 0),
      )
      .map((f) => {
        const st = values.get(f.def.id);
        const res =
          f.def.field_type === 'formula'
            ? (computed?.get(f.def.id) ?? {
                value: st?.value ?? null,
                error: st?.error_code ?? null,
              })
            : null;
        return {
          id: f.def.public_id,
          name: f.def.name,
          description: f.def.description,
          field_type: f.def.field_type,
          result_type: f.def.result_type,
          presentation: f.presentation,
          required: f.def.required,
          config: f.def.field_type === 'formula' ? {} : f.def.config,
          options: options.get(f.def.id) ?? [],
          value: res ? res.value : pub(f, st?.value),
          error: res?.error ?? null,
          read_only:
            f.def.field_type === 'formula' || !f.editable || !editLevel || f.def.state !== 'active',
          archived: f.def.state === 'archived',
          scope_kind: f.def.scope_kind,
        };
      });
    const sets = await tx.db
      .selectFrom('workflow.field_set_attachment as a')
      .innerJoin('workflow.field_set as s', 's.id', 'a.field_set_id')
      .select(['s.public_id', 's.name', 'a.version', 's.current_version'])
      .where('a.record_id', '=', r.id)
      .execute();
    return {
      record: { id: r.publicId, type: r.kind },
      version: r.version,
      fields: list,
      field_sets: sets.map((s) => ({
        id: s.public_id,
        name: s.name,
        version: s.version,
        current_version: s.current_version,
        upgrade_available: s.current_version > s.version,
      })),
    };
  }

  /** Bumps the record version (field values are part of the record for ETags and staleness). */
  protected async bumpRecord(
    tx: WorkspaceTransaction,
    r: { id: string; kind: RecordKind },
    p: Principal,
  ) {
    const table = r.kind === 'task' ? 'work.task' : 'work.project';
    await tx.db
      .updateTable(table)
      .set({
        version: sql`version + 1`,
        updated_at: new Date(),
        updated_by_membership_id: p.membershipId,
      } as never)
      .where('id', '=', r.id)
      .execute();
    await tx.db
      .updateTable('core.record')
      .set({ version: sql`version + 1` })
      .where('id', '=', r.id)
      .execute();
  }

  /** Writes formula results for the record (same transaction as the inputs, W18). */
  protected async materializeFormulas(
    tx: WorkspaceTransaction,
    p: Principal,
    r: { id: string; kind: RecordKind; brandId: string; projectId: string | null },
  ) {
    const all = await fieldsForRecord(
      tx,
      p,
      { id: r.id, kind: r.kind, brandId: r.brandId, projectId: r.projectId },
      'manage',
    );
    const formulas = all.filter((f) => f.def.field_type === 'formula' && f.def.state === 'active');
    if (!formulas.length) return;
    const values = await valuesOf(tx, r.id);
    const results = await this.computeFormulas(
      tx,
      all,
      new Map([...values].map(([k, v]) => [k, { value: v.value }])),
    );
    for (const f of formulas) {
      const res = results.get(f.def.id)!;
      const prev = values.get(f.def.id);
      if (
        prev &&
        canonical(prev.value) === canonical(res.value) &&
        prev.error_code === res.error &&
        prev.formula_version === f.def.formula_version
      )
        continue;
      const row = {
        value: res.value === null ? null : JSON.stringify(res.value),
        computed: true,
        formula_version: f.def.formula_version,
        error_code: res.error,
        updated_at: new Date(),
      };
      if (res.value === null && res.error === null) {
        if (prev)
          await tx.db
            .deleteFrom('workflow.field_value')
            .where('definition_id', '=', f.def.id)
            .where('record_id', '=', r.id)
            .execute();
        continue;
      }
      await tx.db
        .insertInto('workflow.field_value')
        .values({
          workspace_id: tx.workspaceId,
          brand_id: r.brandId,
          definition_id: f.def.id,
          record_id: r.id,
          ...row,
        })
        .onConflict((oc) =>
          oc
            .columns(['definition_id', 'record_id'])
            .doUpdateSet({ ...row, version: sql`workflow.field_value.version + 1` }),
        )
        .execute();
    }
  }

  /**
   * Field-merge edit of custom field values (W12–W16): `{ version, changes: { fld_…: { base,
   * value } } }`. Each field must be readable and editable for the caller (else `not_found` for
   * hidden, `forbidden` for read-only), `base` must equal the current public value, and values are
   * validated and normalized before any write. Formulas recompute in the same transaction.
   */
  async updateRecordFields(
    caller: Caller,
    ws: unknown,
    record: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const b = isObj(body) ? body : {};
    if (!isObj(b.changes) || !Object.keys(b.changes).length)
      throw invalid(issue('/changes', 'required', 'Send at least one field change.'));
    if (Object.keys(b.changes).length > this.ws.fieldDefinitionsMax)
      throw invalid(issue('/changes', 'limit_exceeded', 'Too many changes.'));
    return this.mutate(
      caller,
      'fields.update_values',
      ws,
      req,
      async (tx, p) => {
        const r = await this.workRecord(tx, p, record, true);
        const o = decideRecord(p, 'field.value_edit', r.facts);
        this.decision('field.value_edit', o);
        if (!o.allowed) throw new TenancyError(o.code);
        if (r.facts.lifecycleState !== 'active') throw new TenancyError('forbidden');
        const expected =
          req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (b.version as number | undefined);
        if (expected === undefined) throw new TenancyError('precondition_required');
        requireVersion(expected, r.version);
        const fields = await fieldsForRecord(
          tx,
          p,
          { id: r.id, kind: r.kind, brandId: r.brandId, projectId: r.projectId },
          r.level,
        );
        const byPublic = new Map(fields.map((f) => [f.def.public_id, f]));
        const values = await valuesOf(tx, r.id);
        const pub = await this.publicValues(
          tx,
          fields.filter((f) => f.readable),
          new Map([...values].map(([k, v]) => [k, v.value])),
        );
        const writes: Array<{ f: ResolvedField; value: unknown }> = [];
        const issues: ReturnType<typeof issue>[] = [];
        for (const [key, ch] of Object.entries(b.changes as Record<string, unknown>)) {
          const path = `/changes/${key}`;
          const f = byPublic.get(key);
          if (!f || !f.readable) throw new TenancyError('not_found');
          if (!f.editable) throw new TenancyError('forbidden');
          if (!isObj(ch) || !('value' in ch)) {
            issues.push(issue(path, 'invalid', 'Send { base, value }.'));
            continue;
          }
          const current = pub(f, values.get(f.def.id)?.value);
          const comparable = (v: unknown) =>
            isObj(v) && 'id' in v
              ? (v as { id: unknown }).id
              : isObj(v) && 'minor' in v
                ? { minor: v.minor, currency: v.currency }
                : v;
          if (
            'base' in ch &&
            canonical(comparable(ch.base ?? null)) !== canonical(comparable(current))
          )
            throw new TenancyError('conflict', {
              issues: [issue(path, 'stale', 'This field changed since you loaded it.')],
              conflict: {
                current_version: r.version,
                fields: [{ field: key, yours: ch.value, theirs: current, theirs_readable: true }],
              },
            });
          try {
            const v = await normalizeValue(
              { type: f.def.field_type, config: f.def.config, name: f.def.name },
              ch.value,
              path,
              this.fieldBounds,
              (kind, pid) => this.resolveFieldRef(tx, kind, pid, f.def.id, r.brandId),
            );
            if (v === null && f.def.required)
              issues.push(issue(path, 'required', `${f.def.name} is required.`));
            else writes.push({ f, value: v });
          } catch (e) {
            if (e instanceof FieldValidation)
              issues.push(...e.issues.map((i) => issue(i.path, i.code, i.message)));
            else throw e;
          }
        }
        if (issues.length) throw invalid(...issues);
        for (const w of writes) {
          if (w.value === null) {
            await tx.db
              .deleteFrom('workflow.field_value')
              .where('definition_id', '=', w.f.def.id)
              .where('record_id', '=', r.id)
              .execute();
            continue;
          }
          const row = {
            value: JSON.stringify(w.value),
            updated_by_membership_id: p.membershipId,
            updated_at: new Date(),
          };
          await tx.db
            .insertInto('workflow.field_value')
            .values({
              workspace_id: tx.workspaceId,
              brand_id: r.brandId,
              definition_id: w.f.def.id,
              record_id: r.id,
              ...row,
            })
            .onConflict((oc) =>
              oc
                .columns(['definition_id', 'record_id'])
                .doUpdateSet({ ...row, version: sql`workflow.field_value.version + 1` }),
            )
            .execute();
        }
        await this.materializeFormulas(tx, p, r);
        await this.bumpRecord(tx, r, p);
        // Content-class values are audited as hashes; the field identity is plain (W-audit).
        await this.workAudit(
          tx,
          caller,
          p,
          'fields.values_updated',
          { recordId: r.id, type: r.kind, publicId: r.publicId },
          writes.map((w) =>
            change.content(`fields.${w.f.def.public_id.toLowerCase()}`, { hash: sha(w.value) }),
          ),
          r.brandId,
        );
        await this.workEvent(
          tx,
          caller,
          p,
          'workflow.field_value.changed',
          { type: `work.${r.kind}`, id: r.id, sequence: r.version + 1 },
          {
            record_type: r.kind,
            definition_ids: writes
              .map((w) => w.f.def.public_id)
              .sort()
              .join(','),
          },
          r.brandId,
        );
        const fresh = await this.workRecord(tx, p, r.publicId);
        return {
          status: 200,
          ref: { id: r.publicId, type: r.kind },
          data: { id: r.publicId, type: r.kind, ...(await this.fieldsPayload(tx, p, fresh)) },
        };
      },
      async (tx, p, ref) => ({
        id: ref.id,
        type: ref.type,
        ...(await this.fieldsPayload(tx, p, await this.workRecord(tx, p, ref.id))),
      }),
    );
  }

  /** Eligible reference targets (W15): active members; labels of the record's brand; active options. */
  protected async resolveFieldRef(
    tx: WorkspaceTransaction,
    kind: 'person' | 'label' | 'select',
    pid: string,
    definitionId: string,
    brandId: string,
  ) {
    if (kind === 'person') {
      if (!isPublic(pid, 'mem')) return null;
      const m = await tx.db
        .selectFrom('tenancy.membership')
        .select(['id', 'kind', 'state'])
        .where('public_id', '=', pid)
        .executeTakeFirst();
      return m && m.kind === 'member' && m.state === 'active' ? m.id : null;
    }
    if (kind === 'label') {
      if (!isPublic(pid, 'lbl')) return null;
      const l = await tx.db
        .selectFrom('work.label')
        .select(['id', 'state'])
        .where('public_id', '=', pid)
        .where('brand_id', '=', brandId)
        .executeTakeFirst();
      return l && l.state === 'active' ? l.id : null;
    }
    if (!isPublic(pid, 'fop')) return null;
    const o = await tx.db
      .selectFrom('workflow.field_option')
      .select(['id', 'state'])
      .where('public_id', '=', pid)
      .where('definition_id', '=', definitionId)
      .executeTakeFirst();
    return o && o.state === 'active' ? o.id : null;
  }

  /** Explains a formula on a record only when every input is readable (W19, AT-127). */
  async explainFormula(caller: Caller, ws: unknown, record: unknown, fld: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const r = await this.workRecord(tx, p, record);
      const o = decideRecord(p, 'field.formula_inspect', r.facts);
      this.decision('field.formula_inspect', o);
      if (!o.allowed) throw new TenancyError(o.code);
      const fields = await fieldsForRecord(
        tx,
        p,
        { id: r.id, kind: r.kind, brandId: r.brandId, projectId: r.projectId },
        r.level,
      );
      const f = fields.find((x) => x.def.public_id === fld);
      if (!f || !f.readable || f.def.field_type !== 'formula') throw new TenancyError('not_found');
      const values = await valuesOf(tx, r.id);
      const res = await this.computeFormulas(
        tx,
        fields,
        new Map([...values].map(([k, v]) => [k, { value: v.value }])),
      );
      const inputs = fields.filter((x) => f.inputs.includes(x.def.id));
      return {
        field: f.def.public_id,
        source: formulaSource((f.def.formula_ast as FormulaAst).root),
        result_type: f.def.result_type,
        result: res.get(f.def.id)?.value ?? null,
        error: res.get(f.def.id)?.error ?? null,
        inputs: inputs.map((x) => ({
          id: x.def.public_id,
          name: x.def.name,
          has_value: hasValue(values.get(x.def.id)?.value),
        })),
      };
    });
  }

  /** Compiles a formula and evaluates it against sample inputs (no record, no stored values). */
  async previewFormula(caller: Caller, ws: unknown, body: unknown) {
    const b = isObj(body) ? body : {};
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const scope = await this.configScope(tx, p, 'fields.configure', b.scope);
      if (typeof b.source !== 'string')
        throw invalid(issue('/source', 'required', 'Enter a formula.'));
      const { ast, inputIds } = await this.compileFor(
        tx,
        { id: isPublic(b.field, 'fld') ? (await this.definitionRow(tx, b.field)).id : null, scope },
        b.source.replace(/^/, ''),
      );
      const inputs = (
        await tx.db
          .selectFrom('workflow.field_definition')
          .select([...DEFINITION_COLUMNS])
          .where('id', 'in', inputIds.length ? inputIds : ['00000000-0000-0000-0000-000000000000'])
          .execute()
      ).map(toDefinition);
      const sample = isObj(b.sample) ? b.sample : {};
      const r = evaluate(ast, (pub) => {
        const d = inputs.find((x) => x.public_id === pub);
        const v = sample[pub];
        if (!d || v === undefined || v === null) return null;
        const t = formulaTypeOf(d);
        return t === 'number'
          ? Number(v)
          : t === 'date'
            ? { date: String(v) }
            : t === 'boolean'
              ? v === true
              : String(v);
      });
      return {
        result_type: ast.result,
        source: formulaSource(ast.root),
        depends_on: inputs.map((d) => ({
          id: d.public_id,
          name: d.name,
          field_type: d.field_type,
        })),
        sample_result: r.ok ? storeResult(ast.result, r.value) : null,
        sample_error: r.ok ? null : r.error,
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Field sets (versioned; explicit upgrades, W22)
  // ---------------------------------------------------------------------------------------------

  protected async setRow(tx: WorkspaceTransaction, fst: unknown, lock = false) {
    if (!isPublic(fst, 'fst')) throw new TenancyError('not_found');
    let q = tx.db.selectFrom('workflow.field_set').selectAll().where('public_id', '=', fst);
    if (lock) q = q.forUpdate();
    const s = await q.executeTakeFirst();
    if (!s) throw new TenancyError('not_found');
    return s;
  }

  protected async setView(
    tx: WorkspaceTransaction,
    s: Awaited<ReturnType<FieldService['setRow']>>,
    scope: ConfigScope | null,
  ) {
    const versions = await tx.db
      .selectFrom('workflow.field_set_version')
      .select(['version', 'items', 'created_at'])
      .where('field_set_id', '=', s.id)
      .orderBy('version')
      .execute();
    const defIds = versions.flatMap((v) =>
      (v.items as Array<{ definition_id: string }>).map((i) => i.definition_id),
    );
    const pubs = await this.publicIdsOf(tx, defIds, 'workflow.field_definition');
    const attached = await tx.db
      .selectFrom('workflow.field_set_attachment')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('field_set_id', '=', s.id)
      .executeTakeFirstOrThrow();
    return {
      id: s.public_id,
      type: 'field_set' as const,
      name: s.name,
      scope: scope ? this.scopeView(scope) : null,
      applies_to: [
        ...(s.applies_to_project ? ['project'] : []),
        ...(s.applies_to_task ? ['task'] : []),
      ],
      current_version: s.current_version,
      versions: versions.map((v) => ({
        version: v.version,
        items: (v.items as Array<{ definition_id: string; presentation: string | null }>).map(
          (i) => ({ field: pubs.get(i.definition_id), presentation: i.presentation }),
        ),
      })),
      attached_records: Number(attached.n),
      state: s.state,
      version: Number(s.version),
    };
  }

  protected async parseSetItems(
    tx: WorkspaceTransaction,
    scope: ConfigScope,
    raw: unknown,
    applies: { project: boolean; task: boolean },
  ) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > this.ws.fieldSetItemsMax)
      throw invalid(
        issue('/items', 'invalid', `A field set has 1 to ${this.ws.fieldSetItemsMax} fields.`),
      );
    const out: Array<{ definition_id: string; presentation: 'primary' | 'advanced' | null }> = [];
    for (const [i, it] of raw.entries()) {
      const path = `/items/${i}`;
      if (!isObj(it) || !isPublic(it.field, 'fld'))
        throw invalid(issue(`${path}/field`, 'invalid', 'Choose a field.'));
      const d = await this.definitionRow(tx, it.field).catch(() => {
        throw invalid(issue(`${path}/field`, 'invalid', 'Choose a field.'));
      });
      if (
        d.state !== 'active' ||
        SCOPE_RANK[d.scope_kind] > SCOPE_RANK[scope.kind] ||
        (d.scope_kind === 'brand' && d.brand_id !== scope.brandId) ||
        (d.scope_kind === 'project' && d.project_id !== scope.projectId)
      )
        throw invalid(
          issue(`${path}/field`, 'invalid', 'Choose an active field available at this scope.'),
        );
      if ((applies.project && !d.applies_to_project) || (applies.task && !d.applies_to_task))
        throw invalid(
          issue(`${path}/field`, 'invalid', 'The field must apply to the same record kinds.'),
        );
      const pres = it.presentation ?? null;
      if (pres !== null && pres !== 'primary' && pres !== 'advanced')
        throw invalid(issue(`${path}/presentation`, 'invalid', 'Choose primary or advanced.'));
      if (out.some((x) => x.definition_id === d.id))
        throw invalid(issue(`${path}/field`, 'duplicate', 'Add each field once.'));
      out.push({ definition_id: d.id, presentation: pres as 'primary' | 'advanced' | null });
    }
    return out;
  }

  async listFieldSets(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const scope = await this.configScope(tx, p, 'fields.configure', query.scope);
      let q = tx.db
        .selectFrom('workflow.field_set')
        .selectAll()
        .where('scope_kind', '=', scope.kind)
        .where((eb) =>
          scope.brandId ? eb('brand_id', '=', scope.brandId) : eb('brand_id', 'is', null),
        )
        .where((eb) =>
          scope.projectId ? eb('project_id', '=', scope.projectId) : eb('project_id', 'is', null),
        );
      if (query.state !== 'all') q = q.where('state', '=', 'active');
      const rows = await q.orderBy('normalized_name').limit(this.ws.fieldSetsMax).execute();
      const data = [];
      for (const s of rows) data.push(await this.setView(tx, s, scope));
      return { data, scope: this.scopeView(scope) };
    });
  }

  async createFieldSet(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || [...name].length > 80)
      throw invalid(issue('/name', 'required', 'Enter a field set name of at most 80 characters.'));
    const a = Array.isArray(b.applies_to) ? b.applies_to : ['task'];
    if (!a.length || a.some((x) => x !== 'project' && x !== 'task'))
      throw invalid(issue('/applies_to', 'invalid', 'Choose projects, tasks, or both.'));
    const applies = { project: a.includes('project'), task: a.includes('task') };
    return this.mutate(
      caller,
      'fields.create_set',
      ws,
      req,
      async (tx, p) => {
        const scope = await this.configScope(tx, p, 'fields.configure', b.scope);
        const items = await this.parseSetItems(tx, scope, b.items, applies);
        const n = await tx.db
          .selectFrom('workflow.field_set')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('state', '=', 'active')
          .where('scope_kind', '=', scope.kind)
          .executeTakeFirstOrThrow();
        if (Number(n.n) >= this.ws.fieldSetsMax)
          throw new TenancyError('limit_exceeded', {
            issues: [issue('/', 'limit', `At most ${this.ws.fieldSetsMax} field sets per scope.`)],
          });
        const id = newUuidV7();
        const publicId = newPublicId('fst');
        try {
          await tx.db
            .insertInto('workflow.field_set')
            .values({
              id,
              public_id: publicId,
              workspace_id: tx.workspaceId,
              brand_id: scope.brandId,
              project_id: scope.projectId,
              scope_kind: scope.kind,
              applies_to_project: applies.project,
              applies_to_task: applies.task,
              name,
              normalized_name: norm(name),
              created_by_membership_id: p.membershipId,
            })
            .execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw invalid(issue('/name', 'name_taken', 'A field set with this name exists here.'));
          throw e;
        }
        await tx.db
          .insertInto('workflow.field_set_version')
          .values({
            workspace_id: tx.workspaceId,
            field_set_id: id,
            version: 1,
            items: JSON.stringify(items),
            created_by_membership_id: p.membershipId,
          })
          .execute();
        await this.configAudit(
          tx,
          caller,
          p,
          'fields.set_created',
          { id, type: 'field_set', publicId },
          [change.plain('items', null, items.length)],
          scope.brandId,
        );
        await this.configEvent(
          tx,
          caller,
          p,
          'workflow.field_set.versioned',
          { type: 'workflow.field_set', id, sequence: 0 },
          { version: 1 },
          scope.brandId,
        );
        return {
          status: 201,
          ref: { id: publicId, type: 'field_set' },
          data: await this.setView(tx, await this.setRow(tx, publicId), scope),
        };
      },
      async (tx, p, ref) => {
        const s = await this.setRow(tx, ref.id);
        return this.setView(tx, s, await this.rowScope(tx, p, 'fields.configure', s));
      },
    );
  }

  /** A new version (items) or a rename/archive; existing attachments keep their version. */
  async updateFieldSet(caller: Caller, ws: unknown, fst: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'fields.update_set',
      ws,
      req,
      async (tx, p) => {
        const s = await this.setRow(tx, fst, true);
        const scope = await this.rowScope(tx, p, 'fields.configure', s);
        const expected =
          req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (b.version as number | undefined);
        if (expected === undefined) throw new TenancyError('precondition_required');
        requireVersion(expected, Number(s.version));
        const set: Record<string, unknown> = { updated_at: new Date(), version: sql`version + 1` };
        const audit: ReturnType<typeof change.plain>[] = [];
        if (b.name !== undefined) {
          const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
          if (!name || [...name].length > 80)
            throw invalid(issue('/name', 'required', 'Enter a field set name.'));
          Object.assign(set, { name, normalized_name: norm(name) });
          audit.push(change.content('name', { hash: sha(name) }));
        }
        if (b.state !== undefined) {
          if (b.state !== 'active' && b.state !== 'archived')
            throw invalid(issue('/state', 'invalid', 'Choose active or archived.'));
          set.state = b.state;
          audit.push(change.plain('state', s.state, b.state));
        }
        if (b.items !== undefined) {
          const items = await this.parseSetItems(tx, scope, b.items, {
            project: s.applies_to_project,
            task: s.applies_to_task,
          });
          const v = s.current_version + 1;
          await tx.db
            .insertInto('workflow.field_set_version')
            .values({
              workspace_id: tx.workspaceId,
              field_set_id: s.id,
              version: v,
              items: JSON.stringify(items),
              created_by_membership_id: p.membershipId,
            })
            .execute();
          set.current_version = v;
          audit.push(change.plain('version', s.current_version, v));
          await this.configEvent(
            tx,
            caller,
            p,
            'workflow.field_set.versioned',
            { type: 'workflow.field_set', id: s.id, sequence: v },
            { version: v },
            scope.brandId,
          );
        }
        try {
          await tx.db.updateTable('workflow.field_set').set(set).where('id', '=', s.id).execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw invalid(issue('/name', 'name_taken', 'A field set with this name exists here.'));
          throw e;
        }
        await this.configAudit(
          tx,
          caller,
          p,
          'fields.set_updated',
          { id: s.id, type: 'field_set', publicId: s.public_id },
          audit,
          scope.brandId,
        );
        return {
          status: 200,
          ref: { id: s.public_id, type: 'field_set' },
          data: await this.setView(tx, await this.setRow(tx, s.public_id), scope),
        };
      },
      async (tx, p, ref) => {
        const s = await this.setRow(tx, ref.id);
        return this.setView(tx, s, await this.rowScope(tx, p, 'fields.configure', s));
      },
    );
  }

  /** What attaching or upgrading a set changes on a record (fields gained, fields hidden). */
  protected async setEffect(
    tx: WorkspaceTransaction,
    recordId: string,
    s: { id: string; current_version: number },
    target: number,
  ) {
    const att = await tx.db
      .selectFrom('workflow.field_set_attachment')
      .select('version')
      .where('record_id', '=', recordId)
      .where('field_set_id', '=', s.id)
      .executeTakeFirst();
    const itemsOf = async (v: number) =>
      (
        (
          await tx.db
            .selectFrom('workflow.field_set_version')
            .select('items')
            .where('field_set_id', '=', s.id)
            .where('version', '=', v)
            .executeTakeFirstOrThrow()
        ).items as Array<{ definition_id: string }>
      ).map((i) => i.definition_id);
    const before = att ? await itemsOf(att.version) : [];
    const after = await itemsOf(target);
    const values = await valuesOf(tx, recordId);
    const removed = before.filter((x) => !after.includes(x));
    return {
      from: att?.version ?? null,
      to: target,
      gained: after.filter((x) => !before.includes(x)),
      removed,
      hidden_values: removed.filter((x) => hasValue(values.get(x)?.value)).length,
    };
  }

  protected async setForRecord(
    tx: WorkspaceTransaction,
    p: Principal,
    r: Awaited<ReturnType<FieldService['workRecord']>>,
    fst: unknown,
  ) {
    const s = await this.setRow(tx, fst);
    if (s.state !== 'active')
      throw invalid(issue('/set', 'archived', 'This field set is archived.'));
    const applies =
      (s.scope_kind === 'workspace' ||
        (s.scope_kind === 'brand' && s.brand_id === r.brandId) ||
        (s.scope_kind === 'project' && s.project_id === r.projectId)) &&
      (r.kind === 'task' ? s.applies_to_task : s.applies_to_project);
    if (!applies)
      throw invalid(issue('/set', 'invalid', 'This field set does not apply to this record.'));
    void p;
    return s;
  }

  async previewFieldSet(caller: Caller, ws: unknown, record: unknown, body: unknown) {
    const b = isObj(body) ? body : {};
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const r = await this.workRecord(tx, p, record);
      const s = await this.setForRecord(tx, p, r, b.set);
      const e = await this.setEffect(tx, r.id, s, s.current_version);
      const pubs = await this.publicIdsOf(
        tx,
        [...e.gained, ...e.removed],
        'workflow.field_definition',
      );
      // Hidden fields are counted only as a number of values that will stop showing.
      const visible = new Set(
        (
          await fieldsForRecord(
            tx,
            p,
            { id: r.id, kind: r.kind, brandId: r.brandId, projectId: r.projectId },
            r.level,
          )
        )
          .filter((f) => f.readable)
          .map((f) => f.def.id),
      );
      return {
        set: s.public_id,
        from_version: e.from,
        to_version: e.to,
        fields_added: e.gained.map((x) => pubs.get(x)),
        fields_removed: e.removed.filter((x) => visible.has(x)).map((x) => pubs.get(x)),
        values_hidden: e.hidden_values,
        values_deleted: 0,
      };
    });
  }

  /**
   * Attaches a set's current version to a record, or explicitly upgrades an attachment (W22).
   * Upgrading needs manage on the record; values are never deleted, only hidden when removed.
   */
  async applyFieldSet(caller: Caller, ws: unknown, record: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'fields.apply_set',
      ws,
      req,
      async (tx, p) => {
        const r = await this.workRecord(tx, p, record, true);
        const o = decideRecord(p, 'field.value_edit', r.facts);
        this.decision('field.value_edit', o);
        if (!o.allowed) throw new TenancyError(o.code);
        if (!Number.isInteger(b.version)) throw new TenancyError('precondition_required');
        requireVersion(b.version as number, r.version);
        const s = await this.setForRecord(tx, p, r, b.set);
        const e = await this.setEffect(tx, r.id, s, s.current_version);
        if (e.from !== null && r.level !== 'manage') throw new TenancyError('forbidden');
        if (e.from === s.current_version)
          throw invalid(issue('/set', 'up_to_date', 'This record already has the latest version.'));
        await tx.db
          .insertInto('workflow.field_set_attachment')
          .values({
            workspace_id: tx.workspaceId,
            brand_id: r.brandId,
            record_id: r.id,
            field_set_id: s.id,
            version: s.current_version,
            attached_by_membership_id: p.membershipId,
          })
          .onConflict((oc) =>
            oc.columns(['record_id', 'field_set_id']).doUpdateSet({
              version: s.current_version,
              attached_by_membership_id: p.membershipId,
              attached_at: new Date(),
            }),
          )
          .execute();
        await this.materializeFormulas(tx, p, r);
        await this.bumpRecord(tx, r, p);
        await this.workAudit(
          tx,
          caller,
          p,
          e.from === null ? 'fields.set_attached' : 'fields.set_upgraded',
          { recordId: r.id, type: r.kind, publicId: r.publicId },
          [
            change.plain('field_set_version', e.from, e.to),
            change.plain('values_hidden', null, e.hidden_values),
          ],
          r.brandId,
        );
        await this.workEvent(
          tx,
          caller,
          p,
          'workflow.field_set.applied',
          { type: 'workflow.field_set', id: s.id, sequence: s.current_version },
          { record_type: r.kind, version: s.current_version },
          r.brandId,
        );
        const fresh = await this.workRecord(tx, p, r.publicId);
        return {
          status: 200,
          ref: { id: r.publicId, type: r.kind },
          data: { id: r.publicId, type: r.kind, ...(await this.fieldsPayload(tx, p, fresh)) },
        };
      },
      async (tx, p, ref) => ({
        id: ref.id,
        type: ref.type,
        ...(await this.fieldsPayload(tx, p, await this.workRecord(tx, p, ref.id))),
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Canonical serialization (WFL-014)
  // ---------------------------------------------------------------------------------------------

  /** The scope's definitions, options, sets, and (optionally) one record's readable values. */
  async exportFields(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const scope = await this.configScope(tx, p, 'fields.configure', query.scope);
      const defs = (
        await tx.db
          .selectFrom('workflow.field_definition')
          .select([...DEFINITION_COLUMNS])
          .where('scope_kind', '=', scope.kind)
          .where((eb) =>
            scope.brandId ? eb('brand_id', '=', scope.brandId) : eb('brand_id', 'is', null),
          )
          .where((eb) =>
            scope.projectId ? eb('project_id', '=', scope.projectId) : eb('project_id', 'is', null),
          )
          .orderBy('rank')
          .orderBy('id')
          .limit(this.ws.fieldDefinitionsMax)
          .execute()
      ).map(toDefinition);
      const definitions = [];
      for (const d of defs) {
        const v = await this.definitionView(tx, d, scope);
        definitions.push({
          id: v.id,
          lineage: v.lineage,
          scope: v.scope,
          applies_to: v.applies_to,
          name: v.name,
          description: v.description,
          type: d.field_type,
          config: d.field_type === 'formula' ? {} : d.config,
          required: d.required,
          presentation: d.presentation,
          applicability: d.applicability,
          view_visibility: d.view_visibility,
          visibility: v.visibility,
          options: v.options.map((o) => ({
            id: o.id,
            label: o.label,
            color: o.color,
            state: o.state,
          })),
          formula:
            d.field_type === 'formula'
              ? {
                  ast: d.formula_ast,
                  version: d.formula_version,
                  result: d.result_type,
                  depends_on: [...(v.formula!.depends_on as string[])].sort(),
                }
              : null,
          state: d.state,
          extensions: d.extensions ?? {},
        });
      }
      const sets = await tx.db
        .selectFrom('workflow.field_set')
        .selectAll()
        .where('scope_kind', '=', scope.kind)
        .where((eb) =>
          scope.brandId ? eb('brand_id', '=', scope.brandId) : eb('brand_id', 'is', null),
        )
        .where((eb) =>
          scope.projectId ? eb('project_id', '=', scope.projectId) : eb('project_id', 'is', null),
        )
        .limit(this.ws.fieldSetsMax)
        .execute();
      const field_sets = [];
      for (const s of sets) {
        const v = await this.setView(tx, s, scope);
        field_sets.push({
          id: v.id,
          name: v.name,
          scope: v.scope,
          applies_to: v.applies_to,
          current_version: v.current_version,
          versions: v.versions,
          state: v.state,
          extensions: {},
        });
      }
      const values: unknown[] = [];
      if (query.record !== undefined) {
        const r = await this.workRecord(tx, p, query.record);
        const fields = (
          await fieldsForRecord(
            tx,
            p,
            { id: r.id, kind: r.kind, brandId: r.brandId, projectId: r.projectId },
            r.level,
          )
        ).filter((f) => f.readable);
        const stored = await valuesOf(tx, r.id);
        for (const f of fields) {
          const v = stored.get(f.def.id);
          if (!v) continue;
          const pubRef =
            ['person', 'label', 'select'].includes(f.def.field_type) && typeof v.value === 'string'
              ? (await this.publicValues(tx, [f], new Map([[f.def.id, v.value]])))(f, v.value)
              : null;
          values.push({
            record: r.publicId,
            field: f.def.public_id,
            value: pubRef ? (pubRef as { id: string }).id : v.value,
            computed: v.computed,
            error: v.error_code,
            extensions: v.extensions ?? {},
          });
        }
      }
      return serializeFieldDocument(
        parseFieldDocument(
          {
            schema: FIELD_DOCUMENT_SCHEMA,
            version: FIELD_DOCUMENT_VERSION,
            definitions,
            field_sets,
            values,
            extensions: {},
          },
          { ...this.formulaLimits, itemsMax: this.ws.fieldDefinitionsMax * 50 },
        ),
      );
    });
  }

  /** Parses a document in memory and reports whether re-serializing it is lossless (6D imports). */
  async validateFieldDocument(caller: Caller, ws: unknown, body: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      await this.configScope(tx, p, 'fields.configure', 'workspace').catch(async () => {
        throw new TenancyError('forbidden');
      });
      try {
        const doc = parseFieldDocument(body, {
          ...this.formulaLimits,
          itemsMax: this.ws.fieldDefinitionsMax * 50,
        });
        const out = serializeFieldDocument(doc);
        const again = serializeFieldDocument(
          parseFieldDocument(out, {
            ...this.formulaLimits,
            itemsMax: this.ws.fieldDefinitionsMax * 50,
          }),
        );
        return {
          valid: true,
          lossless: canonical(out) === canonical(again),
          opaque_definitions: doc.definitions.filter((d) => 'opaque' in d).length,
          document: out,
        };
      } catch (e) {
        if (e instanceof DocumentError || e instanceof FormulaError)
          throw invalid(issue((e as DocumentError).path ?? '/', 'invalid', e.message));
        throw e;
      }
    });
  }
}
