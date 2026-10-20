/**
 * Phase 8A automation definitions (ADR-0046 D1–D3): the typed, schema-versioned trigger /
 * condition / action graph and its compiler. Pure: no database, no clock, no authorization. The
 * service resolves references and decides authority; this module decides shape.
 *
 * A definition is data, never code: there are no expressions, no SQL, no scripts, and no
 * templating. Every trigger, operator, action verb, and target selector is a closed set, and
 * anything outside it is refused with a pointer instead of being ignored.
 */

import { PROJECT_PRIORITIES } from '@pm/contracts';
import { parseRule } from '../recurrence.ts';

export const AUTOMATION_SCHEMA_VERSION = 1;

/** The one recurrence evaluator (2A, OD-14): a schedule's rule must parse there. */
function validRule(rule: string): boolean {
  try {
    parseRule(rule);
    return true;
  } catch {
    return false;
  }
}

export type RecordKind = 'task' | 'project';

const NODE_ID = /^[a-z][a-z0-9_]{0,31}$/;
const PUBLIC = (prefix: string) => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
const MEMBER_ID = PUBLIC('mem');
const PROJECT_ID = PUBLIC('prj');
const TASK_ID = PUBLIC('tsk');
const LABEL_ID = PUBLIC('lbl');
const FIELD_ID = PUBLIC('fld');
const WEBHOOK_ID = PUBLIC('whk');
const STATUS_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------------------------------------
// Limits (technical, finite; registered parameters, ADR-0046 D7)
// ---------------------------------------------------------------------------------------------

export interface DefinitionLimits {
  /** AUTOMATION_DEFINITION_BYTES_MAX: canonical JSON size of one definition. */
  definitionBytesMax: number;
  /** AUTOMATION_NODES_MAX: steps (actions, branches, delays) in one definition. */
  nodesMax: number;
  /** AUTOMATION_CONDITION_DEPTH_MAX: nesting of AND/OR groups. */
  conditionDepthMax: number;
  /** AUTOMATION_CONDITIONS_MAX: comparisons across the whole definition. */
  conditionsMax: number;
  /** AUTOMATION_TARGET_FANOUT_MAX: records one action may select. */
  targetFanoutMax: number;
  /** AUTOMATION_DELAY_HORIZON_MINUTES: the longest single delay. */
  delayHorizonMinutes: number;
}

// ---------------------------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------------------------

/**
 * The trigger catalog. `status` is `available` when the source exists and its event contract is
 * verified, `unavailable` when a later phase owns the source (shown at configuration, never
 * activatable).
 */
export const TRIGGERS = {
  'record.created': { status: 'available', records: ['task', 'project'] },
  'record.field_changed': { status: 'available', records: ['task', 'project'] },
  'record.status_changed': { status: 'available', records: ['task', 'project'] },
  'comment.created': { status: 'available', records: ['task', 'project'] },
  'approval.decided': { status: 'available', records: ['task', 'project'] },
  'integration.record_created': { status: 'available', records: ['task'] },
  schedule: { status: 'available', records: [] },
  date: { status: 'available', records: ['task'] },
  manual: { status: 'available', records: ['task', 'project'] },
  'test.result': { status: 'unavailable', records: ['task'], owner: '9B' },
  'agent.result': { status: 'unavailable', records: ['task'], owner: '8C' },
} as const satisfies Record<
  string,
  { status: 'available' | 'unavailable'; records: readonly RecordKind[]; owner?: string }
>;
export type TriggerKind = keyof typeof TRIGGERS;
export const TRIGGER_KINDS = Object.keys(TRIGGERS) as TriggerKind[];

/** Fields a field-changed trigger may watch (the canonical `changed_fields` names). */
export const WATCHABLE_FIELDS: Record<RecordKind, readonly string[]> = {
  task: [
    'title',
    'description',
    'priority',
    'start_date',
    'due_date',
    'deadline',
    'estimate_minutes',
    'status',
  ],
  project: ['name', 'description', 'priority', 'start_date', 'target_date', 'status'],
};

export const STATUS_CATEGORIES = ['planned', 'active', 'paused', 'done', 'cancelled'] as const;
export const REVIEW_DECISIONS = ['approved', 'changes_requested', 'rejected'] as const;

export type Trigger =
  | { kind: 'record.created'; record: RecordKind }
  | { kind: 'record.field_changed'; record: RecordKind; fields: string[] }
  | {
      kind: 'record.status_changed';
      record: RecordKind;
      to_category: (typeof STATUS_CATEGORIES)[number] | null;
    }
  | { kind: 'comment.created'; record: RecordKind }
  | {
      kind: 'approval.decided';
      record: RecordKind;
      decision: (typeof REVIEW_DECISIONS)[number] | null;
    }
  | { kind: 'integration.record_created'; record: 'task' }
  | { kind: 'schedule'; rule: string; start: string; timezone: string }
  | {
      kind: 'date';
      record: 'task';
      field: 'due_date' | 'start_date';
      offset_days: number;
      at: string;
      timezone: string;
    }
  | { kind: 'manual'; record: RecordKind }
  | { kind: 'test.result'; record: 'task' }
  | { kind: 'agent.result'; record: 'task' };

/** The internal event types each event trigger consumes (the registered automation_trigger set). */
export function triggerEvents(t: Trigger): readonly string[] {
  const r = 'record' in t ? t.record : null;
  switch (t.kind) {
    case 'record.created':
      return [r === 'task' ? 'work.task.created' : 'work.project.created'];
    case 'record.field_changed':
      return [r === 'task' ? 'work.task.updated' : 'work.project.updated'];
    case 'record.status_changed':
      return [r === 'task' ? 'work.task.status_changed' : 'work.project.status_changed'];
    case 'comment.created':
      return ['collab.comment.created'];
    case 'approval.decided':
      return ['collab.review.decided'];
    case 'integration.record_created':
      return ['work.task.created'];
    default:
      return [];
  }
}

/** Every internal event any trigger can consume (the trigger consumer subscribes to these). */
export const TRIGGER_EVENT_TYPES = [
  'work.task.created',
  'work.task.updated',
  'work.task.status_changed',
  'work.project.created',
  'work.project.updated',
  'work.project.status_changed',
  'collab.comment.created',
  'collab.review.decided',
] as const;

/** `source_kind` values of tasks created by a verified integration source (6B inbound, 6A sync). */
export const INTEGRATION_SOURCE_KINDS = ['webhook', 'integration'] as const;

// ---------------------------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------------------------

export const CONDITION_FIELDS = {
  status: { records: ['task', 'project'], type: 'status' },
  status_category: { records: ['task', 'project'], type: 'category' },
  priority: { records: ['task', 'project'], type: 'priority' },
  due_date: { records: ['task'], type: 'date' },
  start_date: { records: ['task', 'project'], type: 'date' },
  target_date: { records: ['project'], type: 'date' },
  assignee: { records: ['task'], type: 'member_set' },
  label: { records: ['task'], type: 'label_set' },
  project: { records: ['task'], type: 'project' },
  title: { records: ['task', 'project'], type: 'text' },
} as const satisfies Record<string, { records: readonly RecordKind[]; type: string }>;
export type BuiltinField = keyof typeof CONDITION_FIELDS;

export const OPERATORS = {
  status: ['eq', 'neq', 'in', 'not_in'],
  category: ['eq', 'neq', 'in', 'not_in'],
  priority: ['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'],
  date: ['is_set', 'is_not_set', 'before', 'after', 'on'],
  member_set: ['includes', 'excludes', 'is_set', 'is_not_set'],
  label_set: ['includes', 'excludes', 'is_set', 'is_not_set'],
  project: ['eq', 'neq', 'is_set', 'is_not_set'],
  text: ['contains', 'not_contains', 'is_set', 'is_not_set'],
  custom: ['eq', 'neq', 'is_set', 'is_not_set', 'gt', 'lt', 'contains'],
} as const;
export type Operator = (typeof OPERATORS)[keyof typeof OPERATORS][number];

/** The canonical priorities (contracts `PROJECT_PRIORITIES`, shared by tasks and projects). */
export const PRIORITIES = PROJECT_PRIORITIES;

/** A value compared with: literal, list, or a date relative to the run's local day. */
export type ConditionValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | { relative_days: number };

export type Comparison = { field: string; op: Operator; value?: ConditionValue };
export type Condition = { all: Condition[] } | { any: Condition[] } | Comparison;

// ---------------------------------------------------------------------------------------------
// Actions: the typed per-record matrix (AUTO-005..008)
// ---------------------------------------------------------------------------------------------

export const ACTION_VERBS = [
  'create',
  'update',
  'assign',
  'move',
  'label',
  'notify',
  'schedule',
  'archive',
  'relate',
] as const;
export type ActionVerb = (typeof ACTION_VERBS)[number];

/**
 * The published action matrix. `supported` entries run through the named canonical command;
 * `unsupported` combinations are refused at configuration with the reason; `unavailable` actions
 * exist as typed boundaries whose owning phase has not shipped.
 */
export const ACTION_MATRIX = {
  'task.create': { status: 'supported', record: 'task', permission: 'record.create', command: 'insertTask' },
  'task.update': { status: 'supported', record: 'task', permission: 'record.update', command: 'applyTaskChanges' },
  'task.assign': { status: 'supported', record: 'task', permission: 'record.assign', command: 'setAssigneesIn' },
  'task.move': { status: 'supported', record: 'task', permission: 'record.move', command: 'moveTaskIn' },
  'task.label': { status: 'supported', record: 'task', permission: 'record.update', command: 'toggleLabel' },
  'task.notify': { status: 'supported', record: 'task', permission: 'record.read', command: 'notification' },
  'task.schedule': { status: 'supported', record: 'task', permission: 'record.update', command: 'applyTaskChanges' },
  'task.archive': { status: 'supported', record: 'task', permission: 'record.archive', command: 'archiveTaskIn' },
  'task.relate': { status: 'supported', record: 'task', permission: 'record.relate', command: 'addRelationshipIn' },
  'project.create': { status: 'unsupported', record: 'project', reason: 'Creating a project grants its creator access to it; it stays a person’s decision.' },
  'project.update': { status: 'supported', record: 'project', permission: 'record.update', command: 'updateProjectIn' },
  'project.assign': { status: 'unsupported', record: 'project', reason: 'Changing a project’s owner grants access; it stays a person’s decision.' },
  'project.move': { status: 'unsupported', record: 'project', reason: 'Moving projects changes access for everything inside them; it stays a person’s decision.' },
  'project.label': { status: 'unsupported', record: 'project', reason: 'Projects have no labels.' },
  'project.notify': { status: 'supported', record: 'project', permission: 'record.read', command: 'notification' },
  'project.schedule': { status: 'supported', record: 'project', permission: 'record.update', command: 'updateProjectIn' },
  'project.archive': { status: 'supported', record: 'project', permission: 'record.archive', command: 'archiveProjectIn' },
  'project.relate': { status: 'unsupported', record: 'project', reason: 'Project dependencies are planned by people; use a task relationship instead.' },
  'ai.draft': { status: 'supported', record: null, permission: 'ai.execute', command: 'startAutomationAiRun' },
  'webhook.send': { status: 'supported', record: null, permission: 'webhooks.manage', command: 'automationWebhook' },
  'agent.invoke': { status: 'unavailable', record: null, owner: '8C', reason: 'Agent workflows arrive with the agent runtime (8B/8C).' },
} as const satisfies Record<
  string,
  | { status: 'supported'; record: RecordKind | null; permission: string; command: string }
  | { status: 'unsupported'; record: RecordKind; reason: string }
  | { status: 'unavailable'; record: null; owner: string; reason: string }
>;
export type ActionKey = keyof typeof ACTION_MATRIX;
export const ACTION_KEYS = Object.keys(ACTION_MATRIX) as ActionKey[];

/** Action classes for the R3 standing approval: outbound disclosure needs one (0C §9.4). */
export function actionClass(a: ActionKey): 'internal' | 'ai' | 'outbound' | 'agent' {
  if (a === 'webhook.send') return 'outbound';
  if (a === 'ai.draft') return 'ai';
  if (a === 'agent.invoke') return 'agent';
  return 'internal';
}

export const TARGETS = ['trigger', 'trigger.project', 'trigger.parent', 'trigger.subtasks'] as const;
export type Target = (typeof TARGETS)[number];

/** The record kind a target selects, given the trigger's record kind (null = cannot select). */
export function targetKind(target: Target, trigger: RecordKind | null): RecordKind | null {
  if (trigger === null) return null;
  if (target === 'trigger') return trigger;
  if (target === 'trigger.project') return 'project';
  if (trigger !== 'task') return null;
  return 'task';
}

/** Typed failure classes a fallback edge may handle. Unknown external outcomes are never one. */
export const FAILURE_CLASSES = [
  'policy_rejected',
  'validation_failed',
  'conflict',
  'not_found',
  'unavailable',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface RelativeDays {
  days: number;
}

export type ActionParams = Record<string, unknown>;

export interface ActionNode {
  id: string;
  type: 'action';
  action: ActionKey;
  target: Target | null;
  params: ActionParams;
  next: string | null;
  fallback: { on: FailureClass[]; next: string | null } | null;
}
export interface BranchNode {
  id: string;
  type: 'branch';
  when: Condition;
  then: string | null;
  else: string | null;
}
export interface DelayNode {
  id: string;
  type: 'delay';
  minutes: number;
  next: string | null;
}
export type StepNode = ActionNode | BranchNode | DelayNode;

export interface Definition {
  schema_version: typeof AUTOMATION_SCHEMA_VERSION;
  trigger: Trigger;
  conditions: Condition | null;
  steps: StepNode[];
}

// ---------------------------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------------------------

export interface DefinitionIssue {
  pointer: string;
  code: string;
  message: string;
}

/** References a definition makes, resolved and authorized by the service (never trusted here). */
export interface DefinitionRefs {
  members: Set<string>;
  projects: Set<string>;
  tasks: Set<string>;
  labels: Set<string>;
  fields: Set<string>;
  webhooks: Set<string>;
  brands: Set<string>;
}

export interface Compiled {
  definition: Definition;
  /** Canonical JSON (stable key order) and its byte length. */
  canonical: string;
  bytes: number;
  recordKind: RecordKind | null;
  actions: ActionKey[];
  classes: Array<ReturnType<typeof actionClass>>;
  refs: DefinitionRefs;
  /** Longest path through the step graph (bounded walks). */
  depth: number;
  comparisons: number;
  /** Trigger or action whose owning phase has not shipped: saved, never activatable. */
  unavailable: Array<{ pointer: string; code: string; owner: string }>;
  /** Webhook steps: the declared destination and payload field set (standing approval input). */
  outbound: Array<{ node: string; webhook: string; fields: string[] }>;
}

export class DefinitionError extends Error {
  readonly issues: DefinitionIssue[];
  constructor(issues: DefinitionIssue[]) {
    super('invalid automation definition');
    this.name = 'DefinitionError';
    this.issues = issues;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Canonical JSON: sorted keys, no whitespace (the definition hash and size bound use it). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** Validates an IANA time zone through the platform's own database. */
export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length < 1 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Known parameter keys per action: anything else is refused, never ignored. */
const PARAM_KEYS: Record<ActionKey, readonly string[]> = {
  'task.create': ['title', 'project', 'parent', 'priority', 'due', 'start'],
  'task.update': ['fields'],
  'task.assign': ['mode', 'assignees'],
  'task.move': ['project'],
  'task.label': ['mode', 'label'],
  'task.notify': ['recipients', 'message'],
  'task.schedule': ['start', 'due'],
  'task.archive': [],
  'task.relate': ['kind', 'to'],
  'project.create': [],
  'project.update': ['fields'],
  'project.assign': [],
  'project.move': [],
  'project.label': [],
  'project.notify': ['recipients', 'message'],
  'project.schedule': ['start', 'target'],
  'project.archive': [],
  'project.relate': [],
  'ai.draft': ['action', 'instruction'],
  'webhook.send': ['subscription', 'fields'],
  'agent.invoke': ['agent'],
};

/** AI catalog actions an automation may request (drafts and analyses only; never auto-applied). */
export const AI_DRAFT_ACTIONS = [
  'summarize.v1',
  'draft_status_update.v1',
  'draft_tasks.v1',
  'categorize.v1',
  'recommend_next.v1',
] as const;

/**
 * Payload fields an automation webhook may declare: structural facts only (no titles, names, or
 * descriptions), each disclosed only when the standing approval names it (0C §9.4, §9.5).
 */
export const WEBHOOK_FIELDS: Record<RecordKind, readonly string[]> = {
  task: ['status', 'status_category', 'priority', 'due_date', 'start_date', 'project'],
  project: ['status', 'status_category', 'priority', 'start_date', 'target_date'],
};

export const NOTIFY_MESSAGE_MAX = 280;
export const TITLE_MAX = 200;
export const TEXT_CONTAINS_MAX = 200;
export const RELATIVE_DAYS_MAX = 366;

/**
 * Compiles an untrusted definition. Returns the canonical, validated form or throws
 * `DefinitionError` with every issue (pointer, code, safe message). Cross-record checks (that a
 * member exists, that a project is in scope, field permissions, grantability) are the service's.
 */
export function compileDefinition(raw: unknown, limits: DefinitionLimits): Compiled {
  const issues: DefinitionIssue[] = [];
  const bad = (pointer: string, code: string, message: string): void => {
    issues.push({ pointer, code, message });
  };
  const refs: DefinitionRefs = {
    members: new Set(),
    projects: new Set(),
    tasks: new Set(),
    labels: new Set(),
    fields: new Set(),
    webhooks: new Set(),
    brands: new Set(),
  };
  const unavailable: Compiled['unavailable'] = [];
  const outbound: Compiled['outbound'] = [];
  let comparisons = 0;
  let depth = 0;

  if (!isObj(raw)) throw new DefinitionError([{ pointer: '/', code: 'invalid_type', message: 'Send a definition object.' }]);
  const size = Buffer.byteLength(canonical(raw), 'utf8');
  if (size > limits.definitionBytesMax)
    throw new DefinitionError([
      { pointer: '/', code: 'too_large', message: 'This automation is too large. Split it into smaller automations.' },
    ]);
  for (const k of Object.keys(raw))
    if (!['schema_version', 'trigger', 'conditions', 'steps'].includes(k))
      bad(`/${k}`, 'unknown_field', 'This setting is not supported.');
  if (raw.schema_version !== AUTOMATION_SCHEMA_VERSION)
    bad('/schema_version', 'unsupported_version', 'This automation format version is not supported.');

  // ---- trigger -------------------------------------------------------------------------------
  const trigger = compileTrigger(raw.trigger, bad, unavailable);
  const recordKind: RecordKind | null = trigger && 'record' in trigger ? trigger.record : null;

  // ---- conditions ----------------------------------------------------------------------------
  const condition = (c: unknown, pointer: string, depth: number): Condition | null => {
    if (!isObj(c)) {
      bad(pointer, 'invalid_type', 'Each condition must be a group or a comparison.');
      return null;
    }
    if ('all' in c || 'any' in c) {
      const key = 'all' in c ? 'all' : 'any';
      if (Object.keys(c).length !== 1) bad(pointer, 'unknown_field', 'A group has only its list.');
      if (depth >= limits.conditionDepthMax) {
        bad(pointer, 'too_deep', 'Conditions are nested too deeply.');
        return null;
      }
      const list = c[key];
      if (!Array.isArray(list) || list.length < 1 || list.length > 20) {
        bad(`${pointer}/${key}`, 'invalid_length', 'A group needs 1 to 20 conditions.');
        return null;
      }
      const out = list.map((x, i) => condition(x, `${pointer}/${key}/${i}`, depth + 1));
      return { [key]: out.filter((x): x is Condition => x !== null) } as Condition;
    }
    comparisons++;
    return comparison(c, pointer);
  };
  const comparison = (c: Record<string, unknown>, pointer: string): Comparison | null => {
    for (const k of Object.keys(c))
      if (!['field', 'op', 'value'].includes(k)) bad(`${pointer}/${k}`, 'unknown_field', 'This setting is not supported.');
    const field = c.field;
    let type: string;
    if (typeof field === 'string' && field.startsWith('custom:')) {
      const id = field.slice(7);
      if (!FIELD_ID.test(id)) {
        bad(`${pointer}/field`, 'invalid_reference', 'Choose a custom field.');
        return null;
      }
      refs.fields.add(id);
      type = 'custom';
    } else if (typeof field === 'string' && field in CONDITION_FIELDS) {
      const def = CONDITION_FIELDS[field as BuiltinField];
      if (recordKind === null || !(def.records as readonly string[]).includes(recordKind)) {
        bad(`${pointer}/field`, 'field_not_applicable', 'This field does not apply to the trigger’s record.');
        return null;
      }
      type = def.type;
    } else {
      bad(`${pointer}/field`, 'invalid_option', 'Choose a supported field.');
      return null;
    }
    if (recordKind === null) {
      bad(`${pointer}/field`, 'field_not_applicable', 'A scheduled automation has no trigger record to compare.');
      return null;
    }
    const ops = OPERATORS[type as keyof typeof OPERATORS] as readonly string[];
    if (typeof c.op !== 'string' || !ops.includes(c.op)) {
      bad(`${pointer}/op`, 'invalid_option', 'Choose a supported comparison.');
      return null;
    }
    const op = c.op as Operator;
    const v = c.value;
    const needsNone = op === 'is_set' || op === 'is_not_set';
    if (needsNone) {
      if (v !== undefined && v !== null) bad(`${pointer}/value`, 'unexpected_value', 'This comparison takes no value.');
      return { field: field as string, op };
    }
    const value = comparisonValue(type, op, v, `${pointer}/value`, bad, refs);
    if (value === undefined) return null;
    return { field: field as string, op, value };
  };
  let conditions: Condition | null = null;
  if (raw.conditions !== undefined && raw.conditions !== null)
    conditions = condition(raw.conditions, '/conditions', 0);

  // ---- steps ---------------------------------------------------------------------------------
  const steps: StepNode[] = [];
  if (!Array.isArray(raw.steps) || raw.steps.length < 1) {
    bad('/steps', 'invalid_length', 'Add at least one step.');
  } else if (raw.steps.length > limits.nodesMax) {
    bad('/steps', 'too_many', `An automation has at most ${limits.nodesMax} steps.`);
  } else {
    const ids = new Set<string>();
    raw.steps.forEach((s, i) => {
      const pointer = `/steps/${i}`;
      if (!isObj(s)) return bad(pointer, 'invalid_type', 'Each step must be an object.');
      if (typeof s.id !== 'string' || !NODE_ID.test(s.id))
        return bad(`${pointer}/id`, 'invalid_format', 'Step ids are short lowercase names.');
      if (ids.has(s.id)) return bad(`${pointer}/id`, 'duplicate', 'Step ids must be unique.');
      ids.add(s.id);
      const node = compileNode(s, pointer, recordKind, limits, bad, refs, unavailable, outbound, (c, p) =>
        condition(c, p, 0),
      );
      if (node) steps.push(node);
    });
    // Default edges: an action or delay without `next` continues with the following step.
    const list = raw.steps as unknown[];
    list.forEach((s, i) => {
      const node = steps.find((n) => isObj(s) && n.id === s.id);
      if (!node || !isObj(s)) return;
      const following = list[i + 1];
      if ((node.type === 'action' || node.type === 'delay') && s.next === undefined)
        node.next = isObj(following) && typeof following.id === 'string' ? following.id : null;
    });
    // References and acyclicity (every edge points forward into the defined set).
    const edges = (n: StepNode): Array<[string, string | null]> =>
      n.type === 'branch'
        ? [['then', n.then], ['else', n.else]]
        : n.type === 'action'
          ? [['next', n.next], ...(n.fallback ? ([['fallback/next', n.fallback.next]] as Array<[string, string | null]>) : [])]
          : [['next', n.next]];
    steps.forEach((n, i) => {
      for (const [k, to] of edges(n))
        if (to !== null && !ids.has(to)) bad(`/steps/${i}/${k}`, 'invalid_reference', 'This step points to a step that does not exist.');
    });
    const byId = new Map(steps.map((n) => [n.id, n]));
    const state = new Map<string, 1 | 2>();
    let cyclic = false;
    const visit = (id: string): number => {
      if (state.get(id) === 1) {
        cyclic = true;
        return 0;
      }
      if (state.get(id) === 2) return memo.get(id) ?? 0;
      state.set(id, 1);
      const n = byId.get(id);
      let best = 0;
      if (n) for (const [, to] of edges(n)) if (to && byId.has(to)) best = Math.max(best, visit(to));
      state.set(id, 2);
      memo.set(id, best + 1);
      return best + 1;
    };
    const memo = new Map<string, number>();
    if (steps.length) visit(steps[0]!.id);
    for (const n of steps) if (!state.has(n.id)) visit(n.id);
    if (cyclic) bad('/steps', 'cycle', 'Steps cannot loop back to an earlier step.');
    const reachable = new Set<string>();
    const walk = (id: string | null) => {
      if (!id || reachable.has(id) || !byId.has(id)) return;
      reachable.add(id);
      for (const [, to] of edges(byId.get(id)!)) walk(to);
    };
    if (steps.length && !cyclic) walk(steps[0]!.id);
    steps.forEach((n, i) => {
      if (!cyclic && !reachable.has(n.id)) bad(`/steps/${i}`, 'unreachable', 'No path reaches this step.');
    });
    depth = steps.length ? (memo.get(steps[0]!.id) ?? 0) : 0;
  }
  if (comparisons > limits.conditionsMax)
    bad('/', 'too_many_conditions', `An automation has at most ${limits.conditionsMax} comparisons.`);

  if (issues.length || !trigger) throw new DefinitionError(issues.length ? issues : [{ pointer: '/trigger', code: 'required', message: 'Choose a trigger.' }]);
  const definition: Definition = {
    schema_version: AUTOMATION_SCHEMA_VERSION,
    trigger,
    conditions,
    steps,
  };
  const text = canonical(definition);
  const actions = [...new Set(steps.flatMap((n) => (n.type === 'action' ? [n.action] : [])))].sort() as ActionKey[];
  return {
    definition,
    canonical: text,
    bytes: Buffer.byteLength(text, 'utf8'),
    recordKind,
    actions,
    classes: [...new Set(actions.map(actionClass))].sort(),
    refs,
    depth,
    comparisons,
    unavailable,
    outbound,
  };
}
type Bad = (pointer: string, code: string, message: string) => void;

function compileTrigger(t: unknown, bad: Bad, unavailable: Compiled['unavailable']): Trigger | null {
  if (!isObj(t)) {
    bad('/trigger', 'required', 'Choose a trigger.');
    return null;
  }
  const kind = t.kind;
  if (typeof kind !== 'string' || !(kind in TRIGGERS)) {
    bad('/trigger/kind', 'invalid_option', 'Choose a supported trigger.');
    return null;
  }
  const def = TRIGGERS[kind as TriggerKind];
  const allowed: Record<TriggerKind, readonly string[]> = {
    'record.created': ['kind', 'record'],
    'record.field_changed': ['kind', 'record', 'fields'],
    'record.status_changed': ['kind', 'record', 'to_category'],
    'comment.created': ['kind', 'record'],
    'approval.decided': ['kind', 'record', 'decision'],
    'integration.record_created': ['kind', 'record'],
    schedule: ['kind', 'rule', 'start', 'timezone'],
    date: ['kind', 'record', 'field', 'offset_days', 'at', 'timezone'],
    manual: ['kind', 'record'],
    'test.result': ['kind', 'record'],
    'agent.result': ['kind', 'record'],
  };
  for (const k of Object.keys(t))
    if (!allowed[kind as TriggerKind].includes(k)) bad(`/trigger/${k}`, 'unknown_field', 'This trigger setting is not supported.');
  if (def.status === 'unavailable')
    unavailable.push({ pointer: '/trigger/kind', code: 'trigger_unavailable', owner: (def as { owner: string }).owner });
  let record: RecordKind | null = null;
  if (def.records.length) {
    if (typeof t.record !== 'string' || !(def.records as readonly string[]).includes(t.record)) {
      bad('/trigger/record', 'invalid_option', 'Choose a record type this trigger supports.');
      return null;
    }
    record = t.record as RecordKind;
  }
  switch (kind as TriggerKind) {
    case 'record.field_changed': {
      const f = t.fields;
      const watch = WATCHABLE_FIELDS[record!];
      if (!Array.isArray(f) || f.length < 1 || f.length > watch.length || new Set(f).size !== f.length || f.some((x) => typeof x !== 'string' || !watch.includes(x))) {
        bad('/trigger/fields', 'invalid_option', 'Choose one or more fields to watch.');
        return null;
      }
      return { kind: 'record.field_changed', record: record!, fields: [...(f as string[])].sort() };
    }
    case 'record.status_changed': {
      const c = t.to_category ?? null;
      if (c !== null && !(STATUS_CATEGORIES as readonly unknown[]).includes(c)) {
        bad('/trigger/to_category', 'invalid_option', 'Choose a status category.');
        return null;
      }
      return { kind: 'record.status_changed', record: record!, to_category: c as (typeof STATUS_CATEGORIES)[number] | null };
    }
    case 'approval.decided': {
      const d = t.decision ?? null;
      if (d !== null && !(REVIEW_DECISIONS as readonly unknown[]).includes(d)) {
        bad('/trigger/decision', 'invalid_option', 'Choose a decision.');
        return null;
      }
      return { kind: 'approval.decided', record: record!, decision: d as (typeof REVIEW_DECISIONS)[number] | null };
    }
    case 'schedule': {
      if (typeof t.rule !== 'string' || t.rule.length > 200 || !validRule(t.rule)) {
        bad('/trigger/rule', 'invalid_format', 'Choose how often it runs.');
        return null;
      }
      if (typeof t.start !== 'string' || !LOCAL_DATETIME.test(t.start)) {
        bad('/trigger/start', 'invalid_format', 'Choose a start date and time.');
        return null;
      }
      if (!validTimezone(t.timezone)) {
        bad('/trigger/timezone', 'invalid_timezone', 'Choose a time zone.');
        return null;
      }
      return { kind: 'schedule', rule: t.rule, start: t.start, timezone: t.timezone };
    }
    case 'date': {
      if (t.field !== 'due_date' && t.field !== 'start_date') {
        bad('/trigger/field', 'invalid_option', 'Choose the due date or the start date.');
        return null;
      }
      if (typeof t.offset_days !== 'number' || !Number.isInteger(t.offset_days) || Math.abs(t.offset_days) > 30) {
        bad('/trigger/offset_days', 'out_of_range', 'Choose between 30 days before and 30 days after.');
        return null;
      }
      if (typeof t.at !== 'string' || !LOCAL_TIME.test(t.at)) {
        bad('/trigger/at', 'invalid_format', 'Choose a time of day.');
        return null;
      }
      if (!validTimezone(t.timezone)) {
        bad('/trigger/timezone', 'invalid_timezone', 'Choose a time zone.');
        return null;
      }
      return { kind: 'date', record: 'task', field: t.field, offset_days: t.offset_days, at: t.at, timezone: t.timezone };
    }
    default:
      return { kind, record } as Trigger;
  }
}

function comparisonValue(
  type: string,
  op: Operator,
  v: unknown,
  pointer: string,
  bad: Bad,
  refs: DefinitionRefs,
): ConditionValue | undefined {
  const list = op === 'in' || op === 'not_in';
  const fail = (message: string) => {
    bad(pointer, 'invalid_value', message);
    return undefined;
  };
  switch (type) {
    case 'status':
      if (list) return Array.isArray(v) && v.length >= 1 && v.length <= 20 && v.every((x) => typeof x === 'string' && STATUS_KEY.test(x)) ? (v as string[]) : fail('Choose one or more statuses.');
      return typeof v === 'string' && STATUS_KEY.test(v) ? v : fail('Choose a status.');
    case 'category':
      if (list) return Array.isArray(v) && v.length >= 1 && v.every((x) => (STATUS_CATEGORIES as readonly unknown[]).includes(x)) ? (v as string[]) : fail('Choose one or more categories.');
      return (STATUS_CATEGORIES as readonly unknown[]).includes(v) ? (v as string) : fail('Choose a category.');
    case 'priority':
      if (list) return Array.isArray(v) && v.length >= 1 && v.every((x) => (PRIORITIES as readonly unknown[]).includes(x)) ? (v as string[]) : fail('Choose one or more priorities.');
      return (PRIORITIES as readonly unknown[]).includes(v) ? (v as string) : fail('Choose a priority.');
    case 'date': {
      if (isObj(v) && Object.keys(v).length === 1 && typeof v.relative_days === 'number' && Number.isInteger(v.relative_days) && Math.abs(v.relative_days) <= RELATIVE_DAYS_MAX)
        return { relative_days: v.relative_days };
      return fail('Choose a number of days from the run day.');
    }
    case 'member_set':
      if (typeof v === 'string' && MEMBER_ID.test(v)) {
        refs.members.add(v);
        return v;
      }
      return fail('Choose a member.');
    case 'label_set':
      if (typeof v === 'string' && LABEL_ID.test(v)) {
        refs.labels.add(v);
        return v;
      }
      return fail('Choose a label.');
    case 'project':
      if (typeof v === 'string' && PROJECT_ID.test(v)) {
        refs.projects.add(v);
        return v;
      }
      return fail('Choose a project.');
    case 'text':
      return typeof v === 'string' && v.length >= 1 && v.length <= TEXT_CONTAINS_MAX ? v : fail(`Enter 1 to ${TEXT_CONTAINS_MAX} characters.`);
    case 'custom':
      if (typeof v === 'string' && v.length <= TEXT_CONTAINS_MAX) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'boolean' && (op === 'eq' || op === 'neq')) return v;
      return fail('Enter a value to compare with.');
  }
  return fail('Enter a value.');
}

function relativeDays(v: unknown, pointer: string, bad: Bad): RelativeDays | null | undefined {
  if (v === null) return null;
  if (isObj(v) && Object.keys(v).length === 1 && typeof v.days === 'number' && Number.isInteger(v.days) && Math.abs(v.days) <= RELATIVE_DAYS_MAX)
    return { days: v.days };
  bad(pointer, 'invalid_value', 'Choose a number of days from the run day, or clear it.');
  return undefined;
}

function compileNode(
  s: Record<string, unknown>,
  pointer: string,
  recordKind: RecordKind | null,
  limits: DefinitionLimits,
  bad: Bad,
  refs: DefinitionRefs,
  unavailable: Compiled['unavailable'],
  outbound: Compiled['outbound'],
  condition: (c: unknown, pointer: string) => Condition | null,
): StepNode | null {
  const id = s.id as string;
  const edge = (v: unknown, p: string): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v === 'string' && NODE_ID.test(v)) return v;
    bad(p, 'invalid_reference', 'Choose a step.');
    return null;
  };
  const known = (keys: string[]) => {
    for (const k of Object.keys(s)) if (!keys.includes(k)) bad(`${pointer}/${k}`, 'unknown_field', 'This step setting is not supported.');
  };
  if (s.type === 'branch') {
    known(['id', 'type', 'when', 'then', 'else']);
    if (recordKind === null) bad(`${pointer}/when`, 'field_not_applicable', 'A scheduled automation has no trigger record to branch on.');
    const when = condition(s.when, `${pointer}/when`);
    if (!when) return null;
    return { id, type: 'branch', when, then: edge(s.then, `${pointer}/then`) ?? null, else: edge(s.else, `${pointer}/else`) ?? null };
  }
  if (s.type === 'delay') {
    known(['id', 'type', 'minutes', 'next']);
    const m = s.minutes;
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > limits.delayHorizonMinutes) {
      bad(`${pointer}/minutes`, 'out_of_range', `Choose a delay from 1 minute to ${limits.delayHorizonMinutes} minutes.`);
      return null;
    }
    const next = edge(s.next, `${pointer}/next`);
    return { id, type: 'delay', minutes: m, next: next === undefined ? null : next };
  }
  if (s.type !== 'action') {
    bad(`${pointer}/type`, 'invalid_option', 'Choose an action, a branch, or a delay.');
    return null;
  }
  known(['id', 'type', 'action', 'target', 'params', 'next', 'fallback']);
  const action = s.action;
  if (typeof action !== 'string' || !(action in ACTION_MATRIX)) {
    bad(`${pointer}/action`, 'invalid_option', 'Choose a supported action.');
    return null;
  }
  const key = action as ActionKey;
  const def = ACTION_MATRIX[key];
  if (def.status === 'unsupported') {
    bad(`${pointer}/action`, 'action_unsupported', def.reason);
    return null;
  }
  if (def.status === 'unavailable')
    unavailable.push({ pointer: `${pointer}/action`, code: 'action_unavailable', owner: def.owner });
  // Target: record actions select a record related to the trigger record (bounded).
  let target: Target | null = null;
  if (def.record !== null) {
    const raw = s.target ?? 'trigger';
    if (typeof raw !== 'string' || !(TARGETS as readonly string[]).includes(raw)) {
      bad(`${pointer}/target`, 'invalid_option', 'Choose which record the action applies to.');
      return null;
    }
    target = raw as Target;
    const creating = key === 'task.create';
    if (!creating) {
      const kind = targetKind(target, recordKind);
      if (kind !== def.record) {
        bad(`${pointer}/target`, 'target_not_applicable', 'This action cannot apply to that record for this trigger.');
        return null;
      }
    } else if (target !== 'trigger') {
      bad(`${pointer}/target`, 'target_not_applicable', 'Created records are placed with their own settings.');
    }
  } else if (s.target !== undefined && s.target !== null) {
    bad(`${pointer}/target`, 'unexpected_value', 'This action has no target record.');
  }
  const params = isObj(s.params) ? s.params : s.params === undefined ? {} : null;
  if (params === null) {
    bad(`${pointer}/params`, 'invalid_type', 'Settings must be an object.');
    return null;
  }
  for (const k of Object.keys(params))
    if (!PARAM_KEYS[key].includes(k)) bad(`${pointer}/params/${k}`, 'unknown_field', 'This setting is not supported.');
  const out = compileParams(key, params, `${pointer}/params`, recordKind, bad, refs);
  if (out === null) return null;
  if (key === 'webhook.send') outbound.push({ node: id, webhook: out.subscription as string, fields: out.fields as string[] });
  // Fallback: explicit typed failure classes only; it can never hide an unknown external outcome.
  let fallback: ActionNode['fallback'] = null;
  if (s.fallback !== undefined && s.fallback !== null) {
    const f = s.fallback;
    if (!isObj(f) || !Array.isArray(f.on) || f.on.length < 1 || new Set(f.on).size !== f.on.length || f.on.some((x) => !(FAILURE_CLASSES as readonly unknown[]).includes(x))) {
      bad(`${pointer}/fallback/on`, 'invalid_option', 'Choose which failures the fallback handles.');
    } else {
      for (const k of Object.keys(f)) if (k !== 'on' && k !== 'next') bad(`${pointer}/fallback/${k}`, 'unknown_field', 'This setting is not supported.');
      fallback = { on: [...(f.on as FailureClass[])].sort(), next: edge(f.next, `${pointer}/fallback/next`) ?? null };
    }
  }
  const next = edge(s.next, `${pointer}/next`);
  return { id, type: 'action', action: key, target, params: out, next: next === undefined ? null : next, fallback };
}

function compileParams(
  key: ActionKey,
  p: Record<string, unknown>,
  pointer: string,
  recordKind: RecordKind | null,
  bad: Bad,
  refs: DefinitionRefs,
): ActionParams | null {
  const out: ActionParams = {};
  const text = (k: string, max: number, required: boolean) => {
    const v = p[k];
    if (v === undefined && !required) return;
    if (typeof v !== 'string' || v.trim().length < 1 || v.length > max)
      return bad(`${pointer}/${k}`, 'invalid_length', `Enter 1 to ${max} characters.`);
    out[k] = v.trim();
  };
  const priority = (k: string) => {
    if (p[k] === undefined) return;
    if (p[k] !== null && !(PRIORITIES as readonly unknown[]).includes(p[k])) return bad(`${pointer}/${k}`, 'invalid_option', 'Choose a priority.');
    out[k] = p[k];
  };
  const days = (k: string) => {
    if (p[k] === undefined) return;
    const d = relativeDays(p[k], `${pointer}/${k}`, bad);
    if (d !== undefined) out[k] = d;
  };
  const project = (k: string, allowTrigger: boolean, allowNull: boolean) => {
    const v = p[k];
    if (v === undefined) return;
    if (v === null && allowNull) return void (out[k] = null);
    if (allowTrigger && v === 'trigger.project') {
      if (recordKind === null) return bad(`${pointer}/${k}`, 'target_not_applicable', 'There is no trigger record.');
      return void (out[k] = v);
    }
    if (typeof v === 'string' && PROJECT_ID.test(v)) {
      refs.projects.add(v);
      return void (out[k] = v);
    }
    bad(`${pointer}/${k}`, 'invalid_reference', 'Choose a project.');
  };
  const recipients = () => {
    const v = p.recipients;
    if (!Array.isArray(v) || v.length < 1 || v.length > 10 || new Set(v).size !== v.length)
      return bad(`${pointer}/recipients`, 'invalid_length', 'Choose 1 to 10 recipients.');
    for (const r of v) {
      if (r === 'assignees' || r === 'owner') continue;
      if (typeof r === 'string' && MEMBER_ID.test(r)) refs.members.add(r);
      else return bad(`${pointer}/recipients`, 'invalid_reference', 'Choose members, the assignees, or the owner.');
    }
    if (key === 'project.notify' && v.includes('assignees'))
      return bad(`${pointer}/recipients`, 'invalid_option', 'Projects have an owner, not assignees.');
    out.recipients = [...v].sort();
  };
  const fields = (allowed: readonly string[]) => {
    const f = p.fields;
    if (!isObj(f) || Object.keys(f).length < 1) return bad(`${pointer}/fields`, 'required', 'Choose at least one change.');
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f)) {
      if (!allowed.includes(k)) {
        bad(`${pointer}/fields/${k}`, 'invalid_option', 'This field cannot be changed by an automation.');
        continue;
      }
      if (k === 'priority' && v !== null && !(PRIORITIES as readonly unknown[]).includes(v)) bad(`${pointer}/fields/${k}`, 'invalid_option', 'Choose a priority.');
      else if (k === 'status' && (typeof v !== 'string' || !STATUS_KEY.test(v))) bad(`${pointer}/fields/${k}`, 'invalid_option', 'Choose a status.');
      else if ((k === 'title' || k === 'name') && (typeof v !== 'string' || v.trim().length < 1 || v.length > TITLE_MAX)) bad(`${pointer}/fields/${k}`, 'invalid_length', `Enter 1 to ${TITLE_MAX} characters.`);
      else o[k] = typeof v === 'string' ? v.trim() : v;
    }
    out.fields = o;
  };
  switch (key) {
    case 'task.create':
      text('title', TITLE_MAX, true);
      project('project', true, true);
      if (p.parent !== undefined) {
        if (p.parent !== null && p.parent !== 'trigger') bad(`${pointer}/parent`, 'invalid_option', 'A new task can only be placed under the trigger task.');
        else if (p.parent === 'trigger' && recordKind !== 'task') bad(`${pointer}/parent`, 'target_not_applicable', 'The trigger record is not a task.');
        else out.parent = p.parent;
        if (p.parent === 'trigger' && p.project !== undefined) bad(`${pointer}/project`, 'conflicting_settings', 'A subtask stays in its parent’s project.');
      }
      if (out.project === undefined && out.parent === undefined) bad(`${pointer}/project`, 'required', 'Choose where the new task goes.');
      priority('priority');
      days('due');
      days('start');
      break;
    case 'task.update':
      fields(['priority', 'status', 'title']);
      break;
    case 'project.update':
      fields(['priority', 'status', 'name']);
      break;
    case 'task.assign': {
      if (p.mode !== 'add' && p.mode !== 'replace') bad(`${pointer}/mode`, 'invalid_option', 'Choose add or replace.');
      else out.mode = p.mode;
      const a = p.assignees;
      if (!Array.isArray(a) || a.length > 10 || new Set(a).size !== a.length || a.some((x) => typeof x !== 'string' || !MEMBER_ID.test(x)) || (p.mode === 'add' && a.length < 1))
        bad(`${pointer}/assignees`, 'invalid_reference', 'Choose up to 10 members.');
      else {
        for (const m of a as string[]) refs.members.add(m);
        out.assignees = [...(a as string[])].sort();
      }
      break;
    }
    case 'task.move':
      project('project', false, true);
      if (out.project === undefined) bad(`${pointer}/project`, 'required', 'Choose a project, or no project.');
      break;
    case 'task.label':
      if (p.mode !== 'add' && p.mode !== 'remove') bad(`${pointer}/mode`, 'invalid_option', 'Choose add or remove.');
      else out.mode = p.mode;
      if (typeof p.label !== 'string' || !LABEL_ID.test(p.label)) bad(`${pointer}/label`, 'invalid_reference', 'Choose a label.');
      else {
        refs.labels.add(p.label);
        out.label = p.label;
      }
      break;
    case 'task.notify':
    case 'project.notify':
      recipients();
      text('message', NOTIFY_MESSAGE_MAX, true);
      break;
    case 'task.schedule':
      days('start');
      days('due');
      if (out.start === undefined && out.due === undefined) bad(pointer, 'required', 'Choose a start or due date.');
      break;
    case 'project.schedule':
      days('start');
      days('target');
      if (out.start === undefined && out.target === undefined) bad(pointer, 'required', 'Choose a start or target date.');
      break;
    case 'task.relate':
      if (p.kind !== 'related' && p.kind !== 'blocks') bad(`${pointer}/kind`, 'invalid_option', 'Choose related or blocks.');
      else out.kind = p.kind;
      if (typeof p.to !== 'string' || !TASK_ID.test(p.to)) bad(`${pointer}/to`, 'invalid_reference', 'Choose a task.');
      else {
        refs.tasks.add(p.to);
        out.to = p.to;
      }
      break;
    case 'task.archive':
    case 'project.archive':
      break;
    case 'ai.draft':
      if (typeof p.action !== 'string' || !(AI_DRAFT_ACTIONS as readonly string[]).includes(p.action)) bad(`${pointer}/action`, 'invalid_option', 'Choose an AI action.');
      else out.action = p.action;
      if (recordKind === null) bad(`${pointer}/action`, 'target_not_applicable', 'An AI draft needs a trigger record as its context.');
      if (p.instruction !== undefined) text('instruction', 1000, true);
      break;
    case 'webhook.send': {
      if (typeof p.subscription !== 'string' || !WEBHOOK_ID.test(p.subscription)) bad(`${pointer}/subscription`, 'invalid_reference', 'Choose a configured webhook.');
      else {
        refs.webhooks.add(p.subscription);
        out.subscription = p.subscription;
      }
      const allowed = recordKind ? WEBHOOK_FIELDS[recordKind] : [];
      const f = p.fields;
      if (recordKind === null) bad(`${pointer}/fields`, 'target_not_applicable', 'A webhook sends facts about the trigger record.');
      else if (!Array.isArray(f) || f.length < 1 || new Set(f).size !== f.length || f.some((x) => typeof x !== 'string' || !allowed.includes(x)))
        bad(`${pointer}/fields`, 'invalid_option', 'Choose which fields the webhook may send.');
      else out.fields = [...(f as string[])].sort();
      break;
    }
    case 'agent.invoke':
      if (typeof p.agent !== 'string' || p.agent.length < 1 || p.agent.length > 64) bad(`${pointer}/agent`, 'invalid_reference', 'Choose an agent.');
      else out.agent = p.agent;
      break;
    case 'project.create':
    case 'project.assign':
    case 'project.move':
    case 'project.label':
    case 'project.relate':
      return null;
  }
  return out;
}

/** Stable short hash input for a definition (immutable revisions are compared by it). */
export function definitionDigestInput(c: Compiled): string {
  return c.canonical;
}
