import { FIELD_TYPES, type FieldType } from './field-types.ts';
import { validateAst, type FormulaLimits } from './formula.ts';

/**
 * Canonical custom-field serialization (WFL-014, ADR-0015 W23). One versioned document carries
 * definitions (scope, applicability, type, configuration, visibility, presentation, lineage),
 * select options with stable IDs, formula ASTs and dependencies, field sets with their versions,
 * and typed values. Everything is addressed by public IDs. Unknown properties are kept as opaque
 * `extensions` on the item that carried them, and definitions of unknown (future) types are kept
 * verbatim; neither is ever interpreted or executed. Export → parse → export is lossless. Files,
 * mapping, jobs, review, and cross-workspace identity resolution are Phase 6D.
 */

export const FIELD_DOCUMENT_SCHEMA = 'pm.custom-fields';
export const FIELD_DOCUMENT_VERSION = 1;

export type Scope =
  | { kind: 'workspace' }
  | { kind: 'brand'; brand: string }
  | { kind: 'project'; brand: string; project: string };
export interface DefinitionDoc {
  id: string;
  lineage: string;
  scope: Scope;
  applies_to: Array<'project' | 'task'>;
  name: string;
  description: string | null;
  type: FieldType;
  config: Record<string, unknown>;
  required: boolean;
  presentation: 'primary' | 'advanced';
  applicability: 'always' | 'via_set';
  view_visibility: Record<string, boolean>;
  visibility: {
    read: 'all_readers' | 'min_level';
    read_min_level: string | null;
    edit_min_level: string | null;
    guest_visible: boolean;
  };
  options: Array<{ id: string; label: string; color: string; state: 'active' | 'archived' }>;
  formula: { ast: unknown; version: number; result: string; depends_on: string[] } | null;
  state: 'active' | 'archived';
  extensions: Record<string, unknown>;
}
export interface FieldSetDoc {
  id: string;
  name: string;
  scope: Scope;
  applies_to: Array<'project' | 'task'>;
  current_version: number;
  versions: Array<{
    version: number;
    items: Array<{ field: string; presentation: 'primary' | 'advanced' | null }>;
  }>;
  state: 'active' | 'archived';
  extensions: Record<string, unknown>;
}
export interface ValueDoc {
  record: string;
  field: string;
  value: unknown;
  computed: boolean;
  error: string | null;
  extensions: Record<string, unknown>;
}
export interface FieldDocument {
  schema: typeof FIELD_DOCUMENT_SCHEMA;
  version: typeof FIELD_DOCUMENT_VERSION;
  definitions: Array<DefinitionDoc | { opaque: Record<string, unknown> }>;
  field_sets: FieldSetDoc[];
  values: ValueDoc[];
  extensions: Record<string, unknown>;
}

export class DocumentError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const PUBLIC = (prefix: string) => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
const RECORD = /^(prj|tsk)_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Splits an object into known keys and preserved unknown keys (merged into `extensions`). */
function split(o: Record<string, unknown>, known: readonly string[], path: string) {
  const ext: Record<string, unknown> = {};
  if (o.extensions !== undefined) {
    if (!isObj(o.extensions))
      throw new DocumentError(`${path}/extensions`, 'Extensions must be an object.');
    Object.assign(ext, o.extensions);
  }
  for (const k of Object.keys(o)) if (!known.includes(k) && k !== 'extensions') ext[k] = o[k];
  return ext;
}

function scope(x: unknown, path: string): Scope {
  if (!isObj(x)) throw new DocumentError(path, 'A scope is required.');
  if (x.kind === 'workspace') return { kind: 'workspace' };
  if (x.kind === 'brand' && typeof x.brand === 'string' && PUBLIC('br').test(x.brand))
    return { kind: 'brand', brand: x.brand };
  if (
    x.kind === 'project' &&
    typeof x.brand === 'string' &&
    PUBLIC('br').test(x.brand) &&
    typeof x.project === 'string' &&
    PUBLIC('prj').test(x.project)
  )
    return { kind: 'project', brand: x.brand, project: x.project };
  throw new DocumentError(path, 'The scope is not valid.');
}
const appliesTo = (x: unknown, path: string) => {
  if (
    !Array.isArray(x) ||
    x.length < 1 ||
    x.length > 2 ||
    x.some((k) => k !== 'project' && k !== 'task') ||
    new Set(x).size !== x.length
  )
    throw new DocumentError(path, 'applies_to lists project, task, or both.');
  return [...(x as Array<'project' | 'task'>)].sort();
};
const str = (x: unknown, path: string, max = 500, nullable = false): string | null => {
  if (nullable && (x === null || x === undefined)) return null;
  if (typeof x !== 'string' || x.length < 1 || x.length > max)
    throw new DocumentError(path, 'Text is required.');
  return x;
};
const oneOf = <T extends string>(x: unknown, allowed: readonly T[], path: string): T => {
  if (!allowed.includes(x as T)) throw new DocumentError(path, `Use one of ${allowed.join(', ')}.`);
  return x as T;
};

/** Parses a document without trusting it: shapes, IDs, and formula ASTs are validated. */
export function parseFieldDocument(
  raw: unknown,
  limits: FormulaLimits & { itemsMax: number },
): FieldDocument {
  if (!isObj(raw)) throw new DocumentError('', 'The document must be an object.');
  if (raw.schema !== FIELD_DOCUMENT_SCHEMA || raw.version !== FIELD_DOCUMENT_VERSION)
    throw new DocumentError(
      '/schema',
      `Expected ${FIELD_DOCUMENT_SCHEMA} version ${FIELD_DOCUMENT_VERSION}.`,
    );
  const list = (k: string) => {
    const v = raw[k] ?? [];
    if (!Array.isArray(v)) throw new DocumentError(`/${k}`, 'Must be a list.');
    if (v.length > limits.itemsMax)
      throw new DocumentError(`/${k}`, `At most ${limits.itemsMax} items.`);
    return v as unknown[];
  };
  const definitions = list('definitions').map(
    (d, i): DefinitionDoc | { opaque: Record<string, unknown> } => {
      const p = `/definitions/${i}`;
      if (!isObj(d)) throw new DocumentError(p, 'A definition must be an object.');
      if (isObj(d.opaque) && Object.keys(d).length === 1) return { opaque: d.opaque };
      if (!(FIELD_TYPES as readonly string[]).includes(d.type as string)) return { opaque: d };
      const known = [
        'id',
        'lineage',
        'scope',
        'applies_to',
        'name',
        'description',
        'type',
        'config',
        'required',
        'presentation',
        'applicability',
        'view_visibility',
        'visibility',
        'options',
        'formula',
        'state',
      ];
      const ext = split(d, known, p);
      const id = str(d.id, `${p}/id`, 40)!;
      if (!PUBLIC('fld').test(id)) throw new DocumentError(`${p}/id`, 'Expected a field ID.');
      const lineage = str(d.lineage, `${p}/lineage`, 40)!;
      if (!PUBLIC('fld').test(lineage))
        throw new DocumentError(`${p}/lineage`, 'Expected a field ID.');
      if (!isObj(d.config))
        throw new DocumentError(`${p}/config`, 'Configuration must be an object.');
      if (
        !isObj(d.view_visibility) ||
        Object.values(d.view_visibility).some((v) => typeof v !== 'boolean')
      )
        throw new DocumentError(
          `${p}/view_visibility`,
          'View visibility maps view kinds to true or false.',
        );
      const vis = d.visibility;
      if (!isObj(vis)) throw new DocumentError(`${p}/visibility`, 'Visibility is required.');
      const options = (Array.isArray(d.options) ? d.options : []).map((o, j) => {
        const q = `${p}/options/${j}`;
        if (!isObj(o)) throw new DocumentError(q, 'An option must be an object.');
        const oid = str(o.id, `${q}/id`, 40)!;
        if (!PUBLIC('fop').test(oid)) throw new DocumentError(`${q}/id`, 'Expected an option ID.');
        return {
          id: oid,
          label: str(o.label, `${q}/label`, 80)!,
          color: str(o.color, `${q}/color`, 7)!,
          state: oneOf(o.state, ['active', 'archived'] as const, `${q}/state`),
        };
      });
      let formula: DefinitionDoc['formula'] = null;
      if (d.type === 'formula') {
        const f = d.formula;
        if (!isObj(f) || !Array.isArray(f.depends_on) || !Number.isInteger(f.version))
          throw new DocumentError(
            `${p}/formula`,
            'A formula field needs its AST, version, and dependencies.',
          );
        const ast = validateAst(f.ast, limits);
        const deps = f.depends_on.map((x, j) => {
          if (typeof x !== 'string' || !PUBLIC('fld').test(x))
            throw new DocumentError(`${p}/formula/depends_on/${j}`, 'Expected a field ID.');
          return x;
        });
        formula = {
          ast,
          version: f.version as number,
          result: ast.result,
          depends_on: [...new Set(deps)].sort(),
        };
      } else if (d.formula !== undefined && d.formula !== null)
        throw new DocumentError(`${p}/formula`, 'Only formula fields have a formula.');
      return {
        id,
        lineage,
        scope: scope(d.scope, `${p}/scope`),
        applies_to: appliesTo(d.applies_to, `${p}/applies_to`),
        name: str(d.name, `${p}/name`, 80)!,
        description: str(d.description, `${p}/description`, 500, true),
        type: d.type as FieldType,
        config: d.config,
        required: d.required === true,
        presentation: oneOf(d.presentation, ['primary', 'advanced'] as const, `${p}/presentation`),
        applicability: oneOf(d.applicability, ['always', 'via_set'] as const, `${p}/applicability`),
        view_visibility: d.view_visibility as Record<string, boolean>,
        visibility: {
          read: oneOf(vis.read, ['all_readers', 'min_level'] as const, `${p}/visibility/read`),
          read_min_level: (vis.read_min_level ?? null) as string | null,
          edit_min_level: (vis.edit_min_level ?? null) as string | null,
          guest_visible: vis.guest_visible === true,
        },
        options,
        formula,
        state: oneOf(d.state, ['active', 'archived'] as const, `${p}/state`),
        extensions: ext,
      };
    },
  );
  const field_sets = list('field_sets').map((s, i): FieldSetDoc => {
    const p = `/field_sets/${i}`;
    if (!isObj(s)) throw new DocumentError(p, 'A field set must be an object.');
    const ext = split(
      s,
      ['id', 'name', 'scope', 'applies_to', 'current_version', 'versions', 'state'],
      p,
    );
    const id = str(s.id, `${p}/id`, 40)!;
    if (!PUBLIC('fst').test(id)) throw new DocumentError(`${p}/id`, 'Expected a field set ID.');
    if (!Array.isArray(s.versions) || s.versions.length < 1)
      throw new DocumentError(`${p}/versions`, 'A field set has versions.');
    const versions = s.versions.map((v, j) => {
      const q = `${p}/versions/${j}`;
      if (!isObj(v) || !Number.isInteger(v.version) || !Array.isArray(v.items))
        throw new DocumentError(q, 'A version has a number and items.');
      return {
        version: v.version as number,
        items: v.items.map((it, k) => {
          if (!isObj(it) || typeof it.field !== 'string' || !PUBLIC('fld').test(it.field))
            throw new DocumentError(`${q}/items/${k}`, 'Expected a field ID.');
          return {
            field: it.field,
            presentation: (it.presentation ?? null) as 'primary' | 'advanced' | null,
          };
        }),
      };
    });
    return {
      id,
      name: str(s.name, `${p}/name`, 80)!,
      scope: scope(s.scope, `${p}/scope`),
      applies_to: appliesTo(s.applies_to, `${p}/applies_to`),
      current_version: s.current_version as number,
      versions,
      state: oneOf(s.state, ['active', 'archived'] as const, `${p}/state`),
      extensions: ext,
    };
  });
  const values = list('values').map((v, i): ValueDoc => {
    const p = `/values/${i}`;
    if (!isObj(v)) throw new DocumentError(p, 'A value must be an object.');
    const ext = split(v, ['record', 'field', 'value', 'computed', 'error'], p);
    if (typeof v.record !== 'string' || !RECORD.test(v.record))
      throw new DocumentError(`${p}/record`, 'Expected a project or task ID.');
    if (typeof v.field !== 'string' || !PUBLIC('fld').test(v.field))
      throw new DocumentError(`${p}/field`, 'Expected a field ID.');
    return {
      record: v.record,
      field: v.field,
      value: v.value ?? null,
      computed: v.computed === true,
      error: (v.error ?? null) as string | null,
      extensions: ext,
    };
  });
  const ext = split(raw, ['schema', 'version', 'definitions', 'field_sets', 'values'], '');
  return {
    schema: FIELD_DOCUMENT_SCHEMA,
    version: FIELD_DOCUMENT_VERSION,
    definitions,
    field_sets,
    values,
    extensions: ext,
  };
}

/** Canonical JSON (sorted keys, no whitespace): the comparison and hashing form. */
export function canonical(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

/** Writes the canonical document (the inverse of parseFieldDocument). */
export function serializeFieldDocument(doc: FieldDocument): Record<string, unknown> {
  return JSON.parse(canonical(doc)) as Record<string, unknown>;
}
