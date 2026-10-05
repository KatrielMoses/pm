import {
  DELIVERABLE_TYPES,
  PROJECT_PRIORITIES,
  TASK_CRITERIA_KINDS,
  TASK_STATUSES,
  LABEL_COLORS,
} from '@pm/contracts/shell';
import { Issues, text } from '@pm/tenancy';
import {
  date,
  DESCRIPTION_TEXT_MAX,
  enumValue,
  isObject,
  isPublic,
  nonNegativeInt,
  PROJECT_ICONS,
  richText,
} from './validation.ts';

/**
 * Phase 2B task inputs (0B ADR-22). Every parser refuses unknown fields and reports pointer-precise
 * issues; nothing is normalized silently except whitespace trimming of plain text and URL
 * normalization (which is reported back in the stored value).
 */

const unknown = (b: Record<string, unknown>, allowed: readonly string[], issues: Issues) => {
  for (const k of Object.keys(b))
    if (!allowed.includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
};
const ref = (v: unknown, prefix: string, pointer: string, issues: Issues, label: string) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isPublic(v, prefix)) {
    issues.add(pointer, 'invalid_reference', label);
    return undefined;
  }
  return v;
};

/** A deadline is a date, or an instant with its IANA zone, or null (0D OD-01). */
export type Deadline = { date: string } | { at: string; tz: string } | null;

export function deadline(v: unknown, pointer: string, issues: Issues): Deadline | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isObject(v)) {
    issues.add(
      pointer,
      'invalid_type',
      'Choose a deadline date, or a date and time with a time zone.',
    );
    return undefined;
  }
  const keys = Object.keys(v).sort().join(',');
  if (keys === 'date') {
    const d = date(v.date, `${pointer}/date`, issues);
    return d ? { date: d } : undefined;
  }
  if (keys === 'at,tz') {
    const at = typeof v.at === 'string' ? v.at : '';
    const ok =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(at) &&
      !Number.isNaN(Date.parse(at));
    if (!ok)
      issues.add(`${pointer}/at`, 'invalid_date', 'Use a date and time like 2026-11-02T17:00:00Z.');
    const tz = typeof v.tz === 'string' ? v.tz : '';
    try {
      if (!tz || tz.length > 64) throw new Error('tz');
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      issues.add(`${pointer}/tz`, 'invalid_timezone', 'Choose a time zone.');
      return undefined;
    }
    return ok ? { at: new Date(at).toISOString(), tz } : undefined;
  }
  issues.add(
    pointer,
    'invalid_type',
    'Choose a deadline date, or a date and time with a time zone.',
  );
  return undefined;
}

/** Fields a task may set on create and change by field merge. */
export const TASK_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'start_date',
  'due_date',
  'deadline',
  'estimate_minutes',
  'remaining_estimate_minutes',
  'expected_deliverable_type',
  'expected_deliverable_detail',
  'requires_acceptance',
] as const;
export type TaskField = (typeof TASK_FIELDS)[number];

export const TASK_CONTENT_FIELDS: Record<string, 'content'> = {
  title: 'content',
  description: 'content',
  expected_deliverable_detail: 'content',
};

/** Statuses a field merge may set: completion and reopening are explicit commands (ADR-22). */
const SETTABLE_STATUSES = TASK_STATUSES.filter((s) => s.category !== 'done').map((s) => s.key);

export function taskField(field: string, v: unknown, issues: Issues, estimateMax: number): unknown {
  const p = `/changes/${field}`;
  switch (field as TaskField) {
    case 'title':
      return text(v, p, issues, { max: 300, required: true, label: 'Task title' });
    case 'description':
      return richText(v, p, issues, DESCRIPTION_TEXT_MAX);
    case 'status': {
      if (v === 'done') {
        issues.add(p, 'use_complete', 'Use Complete to finish a task.');
        return undefined;
      }
      return enumValue(v, SETTABLE_STATUSES, p, issues);
    }
    case 'priority':
      return enumValue(v, PROJECT_PRIORITIES, p, issues);
    case 'start_date':
    case 'due_date':
      return date(v, p, issues);
    case 'deadline':
      return deadline(v, p, issues);
    case 'estimate_minutes':
    case 'remaining_estimate_minutes': {
      const n = nonNegativeInt(v, p, issues, estimateMax);
      return n;
    }
    case 'expected_deliverable_type':
      return enumValue(v, DELIVERABLE_TYPES, p, issues, true);
    case 'expected_deliverable_detail':
      return text(v, p, issues, { max: 500, required: false, label: 'Deliverable detail' });
    case 'requires_acceptance':
      if (typeof v !== 'boolean') {
        issues.add(p, 'invalid_type', 'Choose yes or no.');
        return undefined;
      }
      return v;
    default:
      issues.add(p, 'unsupported_field', 'This field is not supported.');
      return undefined;
  }
}

export interface TaskCreateInput {
  brand: string | null;
  project: string | null;
  parent: string | null;
  fields: Partial<Record<TaskField, unknown>>;
}

export function parseTaskCreate(body: unknown, estimateMax: number): TaskCreateInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, [...TASK_FIELDS, 'brand', 'project', 'parent'], issues);
  const brand = ref(b.brand, 'br', '/brand', issues, 'Choose a brand.');
  const project = ref(b.project, 'prj', '/project', issues, 'Choose a project.');
  const parent = ref(b.parent, 'tsk', '/parent', issues, 'Choose a task.');
  const fields: Partial<Record<TaskField, unknown>> = {};
  for (const f of TASK_FIELDS) {
    if (b[f] === undefined) continue;
    const v = taskField(f, b[f], issues, estimateMax);
    if (v !== undefined) fields[f] = v;
  }
  if (b.title === undefined) issues.add('/title', 'required', 'Task title is required.');
  if (!brand && !project && !parent)
    issues.add('/brand', 'brand_required', 'Choose which brand owns this task');
  issues.throwIfAny();
  return { brand: brand ?? null, project: project ?? null, parent: parent ?? null, fields };
}

/** Same-brand move: a new project (or none), a new parent (or root), and a sibling to follow. */
export function parseTaskMove(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['project', 'parent', 'after'], issues);
  const out = {
    project: ref(b.project, 'prj', '/project', issues, 'Choose a project.'),
    parent: ref(b.parent, 'tsk', '/parent', issues, 'Choose a task.'),
    after: ref(b.after, 'tsk', '/after', issues, 'Choose a task.') ?? null,
  };
  issues.throwIfAny();
  return out;
}

export function parseBrandMove(body: unknown, needsToken: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['brand', 'project', 'preview_token'], issues);
  const brand = ref(b.brand, 'br', '/brand', issues, 'Choose a brand.');
  if (!brand) issues.add('/brand', 'required', 'Choose a brand.');
  const project = ref(b.project, 'prj', '/project', issues, 'Choose a project.') ?? null;
  if (needsToken && typeof b.preview_token !== 'string')
    issues.add('/preview_token', 'preview_required', 'Review what changes first.');
  issues.throwIfAny();
  return { brand: brand as string, project, previewToken: b.preview_token as string | undefined };
}

export function parseComplete(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['override_reason', 'confirm_incomplete_subtasks'], issues);
  const reason = text(b.override_reason, '/override_reason', issues, {
    max: 500,
    required: false,
    label: 'Reason',
  });
  if (
    b.confirm_incomplete_subtasks !== undefined &&
    typeof b.confirm_incomplete_subtasks !== 'boolean'
  )
    issues.add('/confirm_incomplete_subtasks', 'invalid_type', 'Choose yes or no.');
  issues.throwIfAny();
  return {
    overrideReason: reason ?? null,
    confirmSubtasks: b.confirm_incomplete_subtasks === true,
  };
}

export function parseSubtreeOption(body: unknown, extra: readonly string[] = []) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['include_subtasks', ...extra], issues);
  if (b.include_subtasks !== undefined && typeof b.include_subtasks !== 'boolean')
    issues.add('/include_subtasks', 'invalid_type', 'Choose yes or no.');
  issues.throwIfAny();
  return { includeSubtasks: b.include_subtasks === true, body: b };
}

export function parseDuplicate(body: unknown) {
  const { includeSubtasks, body: b } = parseSubtreeOption(body, ['title']);
  const issues = new Issues();
  const title =
    b.title === undefined
      ? undefined
      : text(b.title, '/title', issues, { max: 300, required: true, label: 'Task title' });
  issues.throwIfAny();
  return { includeSubtasks, title: title ?? undefined };
}

export function parseAssignees(body: unknown, max: number) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['assignees', 'primary', 'version'], issues);
  const list = b.assignees;
  const out: string[] = [];
  if (!Array.isArray(list)) issues.add('/assignees', 'invalid_type', 'Send the list of people.');
  else {
    if (list.length > max)
      issues.add('/assignees', 'too_many', `A task can have at most ${max} assignees.`);
    for (const [i, m] of list.entries()) {
      if (!isPublic(m, 'mem'))
        issues.add(`/assignees/${i}`, 'invalid_reference', 'Choose a person.');
      else if (out.includes(m))
        issues.add(`/assignees/${i}`, 'duplicate', 'This person is already listed.');
      else out.push(m);
    }
  }
  const primary = ref(b.primary, 'mem', '/primary', issues, 'Choose a person.') ?? null;
  if (primary && !out.includes(primary))
    issues.add('/primary', 'not_assigned', 'The primary assignee must be one of the assignees.');
  if (b.version !== undefined && (typeof b.version !== 'number' || !Number.isInteger(b.version)))
    issues.add('/version', 'invalid_type', 'Version must be a whole number.');
  issues.throwIfAny();
  return { assignees: out, primary, version: b.version as number | undefined };
}

export function parseChecklistItem(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['text', 'done'], issues);
  const out = {
    text: text(b.text, '/text', issues, { max: 500, required: !partial, label: 'Checklist item' }),
    done: b.done === undefined ? undefined : b.done === true,
  };
  if (b.done !== undefined && typeof b.done !== 'boolean')
    issues.add('/done', 'invalid_type', 'Choose done or not done.');
  issues.throwIfAny();
  return out;
}

export function parseTaskCriterion(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['kind', 'text', 'met', 'required'], issues);
  const out = {
    kind: partial
      ? enumValue(b.kind, TASK_CRITERIA_KINDS, '/kind', issues)
      : enumValue(b.kind ?? 'acceptance', TASK_CRITERIA_KINDS, '/kind', issues),
    text: text(b.text, '/text', issues, { max: 500, required: !partial, label: 'Criterion' }),
    met: b.met === undefined ? undefined : b.met === true,
    required: b.required === undefined ? undefined : b.required === true,
  };
  for (const k of ['met', 'required'] as const)
    if (b[k] !== undefined && typeof b[k] !== 'boolean')
      issues.add(`/${k}`, 'invalid_type', 'Choose yes or no.');
  issues.throwIfAny();
  return out;
}

export function parseInherited(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['state'], issues);
  const state = enumValue(b.state, ['met', 'dismissed', 'open'] as const, '/state', issues);
  issues.throwIfAny();
  return state as 'met' | 'dismissed' | 'open';
}

/** Label names compare case-insensitively with collapsed spaces (OD-10). */
export const normalizeLabel = (name: string) => name.replace(/\s+/g, ' ').toLowerCase();

export function parseLabel(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['name', 'color', 'icon', 'state'], issues);
  const name = text(b.name, '/name', issues, { max: 60, required: !partial, label: 'Label name' });
  const out = {
    name: name ? name.replace(/\s+/g, ' ') : name,
    color: partial
      ? enumValue(b.color, LABEL_COLORS, '/color', issues)
      : (enumValue(b.color ?? LABEL_COLORS[0], LABEL_COLORS, '/color', issues) as
          string | undefined),
    icon: enumValue(b.icon, PROJECT_ICONS, '/icon', issues, true),
    state: enumValue(b.state, ['active', 'archived'] as const, '/state', issues),
  };
  issues.throwIfAny();
  return out;
}

export function parseLabelRef(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['label'], issues);
  const label = ref(b.label, 'lbl', '/label', issues, 'Choose a label.');
  if (!label) issues.add('/label', 'required', 'Choose a label.');
  issues.throwIfAny();
  return label as string;
}

/**
 * Safe URL links (TSK-017): https only, no credentials, normalized (lower-case host, no default
 * port, no fragment-only changes). The normalized URL is what is stored and shown.
 */
export function normalizeUrl(v: unknown, pointer: string, issues: Issues): string | undefined {
  if (typeof v !== 'string' || v.length > 2048) {
    issues.add(pointer, 'invalid_url', 'Use a web address that starts with https://.');
    return undefined;
  }
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    issues.add(pointer, 'invalid_url', 'Use a web address that starts with https://.');
    return undefined;
  }
  if (u.protocol !== 'https:') {
    issues.add(pointer, 'unsafe_url', 'Only https:// links are allowed.');
    return undefined;
  }
  if (u.username || u.password) {
    issues.add(pointer, 'unsafe_url', 'Links cannot contain a user name or password.');
    return undefined;
  }
  if (!u.hostname || /\s/.test(u.href)) {
    issues.add(pointer, 'invalid_url', 'Use a web address that starts with https://.');
    return undefined;
  }
  u.hostname = u.hostname.toLowerCase();
  if (u.port === '443') u.port = '';
  const href = u.href;
  if (href.length > 2048) {
    issues.add(pointer, 'invalid_url', 'This web address is too long.');
    return undefined;
  }
  return href;
}

export function parseLink(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, partial ? ['title'] : ['url', 'record', 'title'], issues);
  let url: string | undefined;
  let record: string | undefined;
  if (!partial) {
    if ((b.url === undefined) === (b.record === undefined))
      issues.add('/url', 'required', 'Add a web address or choose a record.');
    else if (b.url !== undefined) url = normalizeUrl(b.url, '/url', issues);
    else if (typeof b.record !== 'string' || !/^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/.test(b.record))
      issues.add('/record', 'invalid_reference', 'Choose a record.');
    else record = b.record;
  }
  const title = text(b.title, '/title', issues, { max: 200, required: false, label: 'Link title' });
  issues.throwIfAny();
  return { url, record, title };
}

export function parseRelationship(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['kind', 'target'], issues);
  const kind = enumValue(b.kind, ['blocks', 'blocked_by', 'related'] as const, '/kind', issues);
  const target = ref(b.target, 'tsk', '/target', issues, 'Choose a task.');
  if (!target) issues.add('/target', 'required', 'Choose a task.');
  issues.throwIfAny();
  return { kind: kind as 'blocks' | 'blocked_by' | 'related', target: target as string };
}

export function parseTaskListQuery(
  query: Record<string, unknown>,
  limits: { pageLimitDefault: number; pageLimitMax: number },
) {
  const issues = new Issues();
  unknown(
    query,
    ['project', 'parent', 'projectless', 'brands', 'state', 'cursor', 'limit'],
    issues,
  );
  const project = ref(query.project, 'prj', '/project', issues, 'Choose a project.');
  const parent =
    query.parent === 'root'
      ? 'root'
      : ref(query.parent, 'tsk', '/parent', issues, 'Choose a task.');
  const projectless = query.projectless === 'true';
  const brands =
    typeof query.brands === 'string' && query.brands ? query.brands.split(',').slice(0, 50) : [];
  for (const [i, b] of brands.entries())
    if (!isPublic(b, 'br')) issues.add(`/brands/${i}`, 'invalid_reference', 'Choose a brand.');
  const state = query.state === 'archived' ? 'archived' : 'active';
  const n = query.limit === undefined ? limits.pageLimitDefault : Number(query.limit);
  if (!Number.isInteger(n) || n < 1) issues.add('/limit', 'invalid_number', 'Use a whole number.');
  const limit = Math.min(
    Number.isInteger(n) && n > 0 ? n : limits.pageLimitDefault,
    limits.pageLimitMax,
  );
  issues.throwIfAny();
  return {
    project: project ?? null,
    parent: parent ?? null,
    projectless,
    brands,
    state: state as 'active' | 'archived',
    cursor: typeof query.cursor === 'string' ? query.cursor : null,
    limit,
  };
}
