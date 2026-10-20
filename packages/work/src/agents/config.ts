/**
 * Phase 8B agent profile configuration (ADR-0047 D2–D4): the typed, schema-versioned draft of a
 * profile and its compiler. Pure: no database, no clock, no authorization. The service resolves
 * references and decides grantability; this module decides shape and the policy floor.
 *
 * Configuration is data. Tools are registered, versioned operations (`agent-tools.json`), never
 * names chosen by a model or a connector; scope is explicit (empty means nothing, never "all");
 * an approval class can be made stricter than its accepted 0C minimum, never weaker.
 */
import { canonical } from '../automation/definition.ts';
import { MODELS } from '../ai/registry.ts';
import { agentTool, AGENT_TOOLS, type AgentToolClass, type AgentToolDef } from './tool-registry.ts';

export const PROFILE_SCHEMA_VERSION = 1;
export const PROFILE_KINDS = ['internal', 'external'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];
export const SCOPE_KINDS = ['brand', 'project', 'record', 'integration'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export const CONNECTOR_KINDS = ['api', 'webhook', 'mcp'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/** Approval classes for agent actions, weakest first (0C). */
export const APPROVAL_ORDER = [
  'none',
  'low_impact_policy',
  'review_required',
  'human_approval',
] as const;
export type AgentApprovalClass = (typeof APPROVAL_ORDER)[number];

/**
 * The accepted 0C agent tool classes: risk, the minimum approval class, and the record level a
 * person must hold in a scope to grant the class there (grantability, I-11).
 */
export const TOOL_CLASSES: Record<
  AgentToolClass,
  {
    risk: 'R0' | 'R1' | 'R2' | 'R3' | 'R4';
    minimum: AgentApprovalClass;
    level: 'view' | 'edit' | 'manage';
  }
> = {
  read_records: { risk: 'R0', minimum: 'none', level: 'view' },
  draft_content: { risk: 'R0', minimum: 'low_impact_policy', level: 'edit' },
  create_subtasks: { risk: 'R1', minimum: 'low_impact_policy', level: 'edit' },
  attach_artifacts: { risk: 'R0', minimum: 'low_impact_policy', level: 'edit' },
  update_records: { risk: 'R1', minimum: 'review_required', level: 'edit' },
  run_tests: { risk: 'R1', minimum: 'low_impact_policy', level: 'edit' },
  code_change: { risk: 'R2', minimum: 'review_required', level: 'manage' },
  external_message: { risk: 'R3', minimum: 'human_approval', level: 'manage' },
  publish: { risk: 'R3', minimum: 'human_approval', level: 'manage' },
  spend: { risk: 'R3', minimum: 'human_approval', level: 'manage' },
  access_change: { risk: 'R4', minimum: 'human_approval', level: 'manage' },
  destructive: { risk: 'R4', minimum: 'human_approval', level: 'manage' },
  production_change: { risk: 'R4', minimum: 'human_approval', level: 'manage' },
  scope_expansion: { risk: 'R3', minimum: 'human_approval', level: 'manage' },
};

export const approvalRank = (a: AgentApprovalClass) => APPROVAL_ORDER.indexOf(a);

/** Bounded run limits a profile asks 8C to enforce (technical bounds, not cost claims). */
export const LIMIT_BOUNDS = {
  max_runtime_minutes: { min: 1, max: 1440, default: 60 },
  max_tool_calls: { min: 1, max: 1000, default: 100 },
  max_artifacts: { min: 0, max: 100, default: 10 },
} as const;
export type LimitKey = keyof typeof LIMIT_BOUNDS;

export interface ConfigLimits {
  instructionsMaxChars: number;
  scopeGrantsMax: number;
  toolGrantsMax: number;
  configBytesMax: number;
}

export interface ConfigIssue {
  pointer: string;
  code: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    super('invalid agent profile configuration');
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** The canonical, compiled configuration of one profile revision. */
export interface CompiledConfig {
  kind: ProfileKind;
  instructions: string;
  model_key: string | null;
  limits: Record<LimitKey, number>;
  /** Tool grants: a registered tool at its version, its class, and its approval class. */
  tools: Array<{
    name: string;
    version: string;
    tool_class: AgentToolClass;
    approval_class: AgentApprovalClass;
  }>;
  /** Explicit scope by public id (resolved to internal ids by the service). */
  scope: Record<ScopeKind, string[]>;
  /** Tools whose operation has not shipped yet: drafted, never activatable. */
  unavailable: Array<{ pointer: string; tool: string; owner: string }>;
  canonical: string;
  bytes: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const PREFIX: Record<ScopeKind, RegExp> = {
  brand: /^br_[0-9A-HJKMNP-TV-Z]{26}$/,
  project: /^prj_[0-9A-HJKMNP-TV-Z]{26}$/,
  record: /^(tsk|prj|doc)_[0-9A-HJKMNP-TV-Z]{26}$/,
  integration: /^conn_[0-9A-HJKMNP-TV-Z]{26}$/,
};

/**
 * Compiles a profile draft. Unknown keys, unregistered tools or versions, weaker approval
 * classes, out-of-range limits, and malformed references are refused (never ignored).
 */
export function compileConfig(raw: unknown, limits: ConfigLimits): CompiledConfig {
  const issues: ConfigIssue[] = [];
  const bad = (pointer: string, code: string, message: string) => {
    issues.push({ pointer, code, message });
  };
  if (!isObj(raw))
    throw new ConfigError([
      { pointer: '/', code: 'invalid_type', message: 'A configuration is an object.' },
    ]);
  const known = new Set([
    'schema_version',
    'kind',
    'instructions',
    'model_key',
    'limits',
    'tools',
    'scope',
    'approval_policy',
  ]);
  for (const k of Object.keys(raw))
    if (!known.has(k)) bad(`/${k}`, 'unknown_field', 'This setting is not supported.');
  if (raw.schema_version !== PROFILE_SCHEMA_VERSION)
    bad('/schema_version', 'invalid_option', `Use schema version ${PROFILE_SCHEMA_VERSION}.`);
  const kind = raw.kind;
  if (kind !== 'internal' && kind !== 'external')
    bad('/kind', 'invalid_option', 'Choose internal or external.');
  const instructions = typeof raw.instructions === 'string' ? raw.instructions : '';
  if (raw.instructions !== undefined && typeof raw.instructions !== 'string')
    bad('/instructions', 'invalid_type', 'Instructions are text.');
  if (instructions.length > limits.instructionsMaxChars)
    bad(
      '/instructions',
      'invalid_length',
      `Use at most ${limits.instructionsMaxChars} characters.`,
    );
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(instructions))
    bad('/instructions', 'invalid_format', 'Instructions cannot contain control characters.');
  let model: string | null = null;
  if (kind === 'internal') {
    if (raw.model_key === undefined || raw.model_key === null) model = null;
    else if (typeof raw.model_key !== 'string' || !MODELS.some((m) => m.key === raw.model_key))
      bad('/model_key', 'invalid_option', 'Choose a registered model.');
    else model = raw.model_key;
  } else if (raw.model_key !== undefined && raw.model_key !== null)
    bad('/model_key', 'not_applicable', 'An external agent brings its own model.');
  const lim = {} as Record<LimitKey, number>;
  const rawLimits = raw.limits === undefined ? {} : raw.limits;
  if (!isObj(rawLimits)) bad('/limits', 'invalid_type', 'Limits are an object.');
  else {
    for (const k of Object.keys(rawLimits))
      if (!(k in LIMIT_BOUNDS))
        bad(`/limits/${k}`, 'unknown_field', 'This limit is not supported.');
    for (const [k, b] of Object.entries(LIMIT_BOUNDS) as Array<
      [LimitKey, (typeof LIMIT_BOUNDS)[LimitKey]]
    >) {
      const v = rawLimits[k] ?? b.default;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < b.min || v > b.max)
        bad(`/limits/${k}`, 'out_of_range', `Choose ${b.min} to ${b.max}.`);
      else lim[k] = v;
    }
  }
  // Approval policy: per tool class, never weaker than the accepted minimum.
  const policy: Partial<Record<AgentToolClass, AgentApprovalClass>> = {};
  const rawPolicy = raw.approval_policy === undefined ? {} : raw.approval_policy;
  if (!isObj(rawPolicy))
    bad('/approval_policy', 'invalid_type', 'The approval policy is an object.');
  else
    for (const [cls, v] of Object.entries(rawPolicy)) {
      if (!(cls in TOOL_CLASSES)) {
        bad(`/approval_policy/${cls}`, 'invalid_option', 'This is not an agent tool class.');
        continue;
      }
      if (typeof v !== 'string' || !(APPROVAL_ORDER as readonly string[]).includes(v)) {
        bad(`/approval_policy/${cls}`, 'invalid_option', 'Choose an approval class.');
        continue;
      }
      const min = TOOL_CLASSES[cls as AgentToolClass].minimum;
      if (approvalRank(v as AgentApprovalClass) < approvalRank(min))
        bad(
          `/approval_policy/${cls}`,
          'weaker_than_policy',
          `This class needs at least ${min.replace(/_/g, ' ')}; a profile can only make approval stricter.`,
        );
      else policy[cls as AgentToolClass] = v as AgentApprovalClass;
    }
  const tools: CompiledConfig['tools'] = [];
  const unavailable: CompiledConfig['unavailable'] = [];
  const rawTools = raw.tools === undefined ? [] : raw.tools;
  if (!Array.isArray(rawTools)) bad('/tools', 'invalid_type', 'Tools are a list.');
  else {
    if (rawTools.length > limits.toolGrantsMax)
      bad('/tools', 'too_many', `Grant at most ${limits.toolGrantsMax} tools.`);
    const seen = new Set<string>();
    rawTools.forEach((t, i) => {
      const ptr = `/tools/${i}`;
      if (!isObj(t) || Object.keys(t).some((k) => k !== 'name' && k !== 'version')) {
        bad(ptr, 'invalid_type', 'A tool is a registered name and version.');
        return;
      }
      const def: AgentToolDef | undefined = agentTool(t.name, t.version);
      if (!def) {
        bad(
          ptr,
          'unregistered_tool',
          'Only registered tools at registered versions can be granted.',
        );
        return;
      }
      if (seen.has(def.name)) {
        bad(ptr, 'duplicate', 'This tool is already granted.');
        return;
      }
      seen.add(def.name);
      if (def.status === 'unavailable')
        unavailable.push({ pointer: ptr, tool: def.name, owner: def.owner ?? '' });
      const cls = TOOL_CLASSES[def.tool_class];
      tools.push({
        name: def.name,
        version: def.version,
        tool_class: def.tool_class,
        approval_class: policy[def.tool_class] ?? cls.minimum,
      });
    });
  }
  const scope = { brand: [], project: [], record: [], integration: [] } as Record<
    ScopeKind,
    string[]
  >;
  const rawScope = raw.scope === undefined ? {} : raw.scope;
  if (!isObj(rawScope)) bad('/scope', 'invalid_type', 'The scope is an object.');
  else {
    let total = 0;
    for (const k of Object.keys(rawScope))
      if (!(SCOPE_KINDS as readonly string[]).includes(k.replace(/s$/, '')))
        bad(
          `/scope/${k}`,
          'unknown_field',
          'Scope names brands, projects, records, and integrations.',
        );
    for (const kindKey of SCOPE_KINDS) {
      const list = rawScope[`${kindKey}s`] ?? [];
      if (!Array.isArray(list)) {
        bad(`/scope/${kindKey}s`, 'invalid_type', 'A list of references.');
        continue;
      }
      const uniq = new Set<string>();
      list.forEach((v, i) => {
        if (typeof v !== 'string' || !PREFIX[kindKey].test(v))
          bad(`/scope/${kindKey}s/${i}`, 'invalid_reference', 'Choose an existing item.');
        else uniq.add(v);
      });
      scope[kindKey] = [...uniq].sort();
      total += uniq.size;
    }
    if (total > limits.scopeGrantsMax)
      bad('/scope', 'too_many', `Grant at most ${limits.scopeGrantsMax} scope items.`);
  }
  const body = {
    schema_version: PROFILE_SCHEMA_VERSION,
    kind,
    instructions,
    model_key: model,
    limits: lim,
    tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)),
    scope,
  };
  const text = canonical(body);
  const bytes = Buffer.byteLength(text);
  if (bytes > limits.configBytesMax)
    bad('/', 'too_large', `The configuration is larger than ${limits.configBytesMax} bytes.`);
  if (issues.length) throw new ConfigError(issues);
  return {
    kind: kind as ProfileKind,
    instructions,
    model_key: model,
    limits: lim,
    tools: body.tools,
    scope,
    unavailable,
    canonical: text,
    bytes,
  };
}

/** Readiness gaps of a draft before activation (shown in the editor; activation refuses them). */
export function missingConfiguration(
  c: CompiledConfig,
  connector: { configured: boolean } | null,
): string[] {
  const out: string[] = [];
  const scopeSize = Object.values(c.scope).reduce((n, l) => n + l.length, 0);
  if (!scopeSize) out.push('scope');
  if (!c.tools.length) out.push('tools');
  if (c.kind === 'internal' && !c.model_key) out.push('model');
  if (c.kind === 'external' && !connector?.configured) out.push('connector');
  if (c.unavailable.length) out.push('unavailable_tools');
  return out;
}

export const AVAILABLE_TOOLS = AGENT_TOOLS.filter((t) => t.status === 'available');
