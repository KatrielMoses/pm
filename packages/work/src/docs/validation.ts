import { Issues, text as plainField } from '@pm/tenancy';
import { isObject, isPublic } from '../validation.ts';
import {
  RECORD_REF_KINDS,
  REF_PREFIX,
  parseContent,
  type Block,
  type ContentLimits,
  type DocContent,
  type RecordRefKind,
} from './content.ts';
import { DOC_STATES, DOC_TYPES, isDate, type DocState, type DocType } from './semantics.ts';

/**
 * Phase 4C inputs (ADR-0025). Every parser refuses unknown fields, reports pointer-precise safe
 * issues, and never echoes input. Nothing here consults the database or authorization.
 */

const unknownFields = (b: Record<string, unknown>, allowed: readonly string[], issues: Issues) => {
  for (const k of Object.keys(b))
    if (!allowed.includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
};

const title = (v: unknown, pointer: string, issues: Issues, required: boolean) =>
  plainField(v, pointer, issues, { max: 200, required, label: 'The title' }) ?? undefined;

const versionNumber = (v: unknown, pointer: string, issues: Issues): number | undefined => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000) return v;
  issues.add(pointer, 'invalid_number', 'Send the version number you loaded.');
  return undefined;
};

const readDate = (v: unknown, pointer: string, issues: Issues): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isDate(v)) {
    issues.add(pointer, 'invalid_date', 'Use a date like 2026-12-31.');
    return undefined;
  }
  return v;
};

export interface DocumentCreate {
  type: DocType;
  title: string | undefined;
  brand: string | null;
  project: string | null;
  task: string | null;
  parent: string | null;
  content: unknown;
  starter: boolean;
  owner: string | null;
  reviewDueOn: string | null;
  state: DocState;
}

export function parseDocumentCreate(body: unknown): DocumentCreate {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the document.');
  unknownFields(
    b,
    ['type', 'title', 'brand', 'project', 'task', 'parent', 'content', 'starter', 'owner', 'review_due_on', 'state'],
    issues,
  );
  const type = b.type ?? 'page';
  if (!(DOC_TYPES as readonly unknown[]).includes(type))
    issues.add('/type', 'invalid_option', 'Choose a document type from the list.');
  const ref = (k: string, prefix: string) => {
    const v = b[k];
    if (v === undefined || v === null) return null;
    if (!isPublic(v, prefix)) {
      issues.add(`/${k}`, 'invalid_reference', 'Choose from the list.');
      return null;
    }
    return v;
  };
  const brand = ref('brand', 'br');
  const project = ref('project', 'prj');
  const task = ref('task', 'tsk');
  const parent = ref('parent', 'doc');
  const owner = ref('owner', 'mem');
  if (project && task) issues.add('/task', 'conflicting', 'Attach a document to a project or a task, not both.');
  if (parent && (brand || project || task))
    issues.add(
      '/parent',
      'conflicting',
      'A page lives where its parent page lives. Leave out the brand, project, and task.',
    );
  if (b.starter !== undefined && typeof b.starter !== 'boolean')
    issues.add('/starter', 'invalid_type', 'Use true or false.');
  if (b.content !== undefined && b.starter === true)
    issues.add('/content', 'conflicting', 'Send content or ask for the starter, not both.');
  const state = b.state ?? 'draft';
  if (!(DOC_STATES as readonly unknown[]).includes(state) || state === 'stale')
    issues.add('/state', 'invalid_option', 'A new document is a draft or current.');
  const reviewDueOn = readDate(b.review_due_on, '/review_due_on', issues);
  const t = title(b.title, '/title', issues, false);
  issues.throwIfAny();
  return {
    type: type as DocType,
    title: t ?? undefined,
    brand,
    project,
    task,
    parent,
    content: b.content,
    starter: b.starter === undefined ? b.content === undefined : (b.starter as boolean),
    owner,
    reviewDueOn: reviewDueOn ?? null,
    state: state as DocState,
  };
}

export interface ContentSave {
  baseVersion: number;
  title: string | undefined;
  content: DocContent;
  hash: string;
  bytes: number;
  refs: Array<{ kind: string; id: string }>;
}

export function parseContentSave(body: unknown, limits: ContentLimits): ContentSave {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the document.');
  unknownFields(b, ['base_version', 'title', 'content'], issues);
  const baseVersion = versionNumber(b.base_version, '/base_version', issues);
  const t = title(b.title, '/title', issues, false);
  if (b.content === undefined) issues.add('/content', 'required', 'Send the content.');
  const parsed = b.content === undefined ? null : parseContent(b.content, limits, issues, '/content');
  issues.throwIfAny();
  return {
    baseVersion: baseVersion!,
    title: t ?? undefined,
    content: parsed!.content,
    hash: parsed!.hash,
    bytes: parsed!.bytes,
    refs: parsed!.refs,
  };
}

export function parseRestore(body: unknown): { version: number; baseVersion: number } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Choose the version to restore.');
  unknownFields(b, ['version', 'base_version'], issues);
  const version = versionNumber(b.version, '/version', issues);
  const baseVersion = versionNumber(b.base_version, '/base_version', issues);
  issues.throwIfAny();
  return { version: version!, baseVersion: baseVersion! };
}

export interface DocumentPatch {
  state?: DocState;
  owner?: string;
  reviewDueOn?: string | null;
}

export function parseDocumentPatch(body: unknown): DocumentPatch {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the changes.');
  unknownFields(b, ['state', 'owner', 'review_due_on'], issues);
  const out: DocumentPatch = {};
  if (b.state !== undefined) {
    if (!(DOC_STATES as readonly unknown[]).includes(b.state))
      issues.add('/state', 'invalid_option', 'Choose draft, current, or stale.');
    else out.state = b.state as DocState;
  }
  if (b.owner !== undefined) {
    if (!isPublic(b.owner, 'mem')) issues.add('/owner', 'invalid_reference', 'Choose a member.');
    else out.owner = b.owner;
  }
  const review = readDate(b.review_due_on, '/review_due_on', issues);
  if (review !== undefined) out.reviewDueOn = review;
  if (!Object.keys(out).length && !issues.list.length)
    issues.add('/', 'empty', 'Send at least one change.');
  issues.throwIfAny();
  return out;
}

export function parseMove(body: unknown): { parent: string | null; after: string | null | undefined } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the new place.');
  unknownFields(b, ['parent', 'after'], issues);
  const one = (k: string): string | null | undefined => {
    const v = b[k];
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (!isPublic(v, 'doc')) {
      issues.add(`/${k}`, 'invalid_reference', 'Choose a page from the list.');
      return undefined;
    }
    return v;
  };
  const parent = one('parent');
  const after = one('after');
  if (parent === undefined) issues.add('/parent', 'required', 'Choose the parent page, or null for the top level.');
  issues.throwIfAny();
  return { parent: parent ?? null, after };
}

export function parseLinks(body: unknown, max: number): Array<{ kind: RecordRefKind; id: string }> {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the linked records.');
  unknownFields(b, ['records'], issues);
  const out: Array<{ kind: RecordRefKind; id: string }> = [];
  if (!Array.isArray(b.records)) issues.add('/records', 'invalid_type', 'Send a list of records.');
  else {
    if (b.records.length > max) issues.add('/records', 'too_many', `Link at most ${max} records.`);
    const seen = new Set<string>();
    for (const [i, r] of b.records.slice(0, max).entries()) {
      const kind = RECORD_REF_KINDS.find((k) => isPublic(r, REF_PREFIX[k]));
      if (!kind) {
        issues.add(`/records/${i}`, 'invalid_reference', 'Choose a task, project, brand, or document.');
        continue;
      }
      if (seen.has(r as string)) continue;
      seen.add(r as string);
      out.push({ kind, id: r as string });
    }
  }
  issues.throwIfAny();
  return out;
}

export interface DocumentListQuery {
  scope: 'all' | 'workspace' | string;
  project: string | null;
  task: string | null;
  parent: 'root' | string | null;
  attached: 'any' | 'none';
  type: DocType | null;
  state: DocState | 'overdue' | null;
  owner: string | null;
  q: string | null;
  archived: boolean;
  limit: unknown;
  cursor: unknown;
}

export function parseDocumentList(raw: Record<string, unknown>, qMax = 100): DocumentListQuery {
  const issues = new Issues();
  unknownFields(
    raw,
    ['scope', 'project', 'task', 'parent', 'attached', 'type', 'state', 'owner', 'q', 'archived', 'limit', 'cursor'],
    issues,
  );
  const ref = (k: string, prefix: string) => {
    const v = raw[k];
    if (v === undefined) return null;
    if (!isPublic(v, prefix)) {
      issues.add(`/${k}`, 'invalid_reference', 'Choose from the list.');
      return null;
    }
    return v;
  };
  let scope: string = 'all';
  if (raw.scope !== undefined) {
    if (raw.scope === 'workspace' || raw.scope === 'all') scope = raw.scope;
    else if (isPublic(raw.scope, 'br')) scope = raw.scope;
    else issues.add('/scope', 'invalid_option', 'Choose workspace, or a brand.');
  }
  let parent: DocumentListQuery['parent'] = null;
  if (raw.parent !== undefined) {
    if (raw.parent === 'root') parent = 'root';
    else if (isPublic(raw.parent, 'doc')) parent = raw.parent;
    else issues.add('/parent', 'invalid_option', 'Choose root, or a page.');
  }
  let attached: DocumentListQuery['attached'] = 'any';
  if (raw.attached !== undefined) {
    if (raw.attached === 'none' || raw.attached === 'any') attached = raw.attached;
    else issues.add('/attached', 'invalid_option', 'Choose any or none.');
  }
  let type: DocType | null = null;
  if (raw.type !== undefined) {
    if ((DOC_TYPES as readonly unknown[]).includes(raw.type)) type = raw.type as DocType;
    else issues.add('/type', 'invalid_option', 'Choose a document type from the list.');
  }
  let state: DocumentListQuery['state'] = null;
  if (raw.state !== undefined) {
    if ((DOC_STATES as readonly unknown[]).includes(raw.state) || raw.state === 'overdue')
      state = raw.state as DocumentListQuery['state'];
    else issues.add('/state', 'invalid_option', 'Choose draft, current, stale, or overdue.');
  }
  let archived = false;
  if (raw.archived !== undefined) {
    if (raw.archived === 'true' || raw.archived === true) archived = true;
    else if (raw.archived === 'false' || raw.archived === false) archived = false;
    else issues.add('/archived', 'invalid_option', 'Use true or false.');
  }
  let q: string | null = null;
  if (raw.q !== undefined) {
    if (typeof raw.q !== 'string') issues.add('/q', 'invalid_type', 'Search for text.');
    else if ([...raw.q.trim()].length > qMax)
      issues.add('/q', 'too_long', `Search for at most ${qMax} characters.`);
    else q = raw.q.trim() || null;
  }
  const project = ref('project', 'prj');
  const task = ref('task', 'tsk');
  const owner = ref('owner', 'mem');
  issues.throwIfAny();
  return { scope, project, task, parent, attached, type, state, owner, q, archived, limit: raw.limit, cursor: raw.cursor };
}

export function parseExportQuery(raw: Record<string, unknown>): {
  format: 'markdown' | 'html';
  includeChildren: boolean;
} {
  const issues = new Issues();
  unknownFields(raw, ['format', 'include_children'], issues);
  const format = raw.format ?? 'markdown';
  if (format !== 'markdown' && format !== 'html')
    issues.add('/format', 'invalid_option', 'Choose markdown or html.');
  let includeChildren = false;
  if (raw.include_children !== undefined) {
    if (raw.include_children === 'true' || raw.include_children === true) includeChildren = true;
    else if (raw.include_children === 'false' || raw.include_children === false) includeChildren = false;
    else issues.add('/include_children', 'invalid_option', 'Use true or false.');
  }
  issues.throwIfAny();
  return { format: format as 'markdown' | 'html', includeChildren };
}

export interface SuggestionCreate {
  block: string;
  baseVersion: number;
  proposed: Block;
  note: string | null;
}

export function parseSuggestionCreate(body: unknown, limits: ContentLimits): SuggestionCreate {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the suggestion.');
  unknownFields(b, ['block', 'base_version', 'proposed', 'note'], issues);
  let block = '';
  if (typeof b.block === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(b.block)) block = b.block;
  else issues.add('/block', 'invalid_reference', 'Choose the block to change.');
  const baseVersion = versionNumber(b.base_version, '/base_version', issues);
  const note = plainField(b.note, '/note', issues, { max: 500, required: false, label: 'The note' }) ?? null;
  let proposed: Block | null = null;
  if (!isObject(b.proposed)) issues.add('/proposed', 'required', 'Send the block as you would have it.');
  else {
    const inner = new Issues();
    try {
      const parsed = parseContent({ v: 2, blocks: [{ ...b.proposed, id: block || 'blk_sugg' }] }, limits, inner);
      proposed = parsed.content.blocks[0] ?? null;
    } catch {
      for (const i of inner.list) issues.add((i.pointer ?? '/').replace(/^\/blocks\/0/, '/proposed'), i.code, i.message);
    }
  }
  issues.throwIfAny();
  return { block, baseVersion: baseVersion!, proposed: proposed!, note };
}

export function parseSuggestionDecision(body: unknown): { outcome: 'accept' | 'reject' } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the decision.');
  unknownFields(b, ['outcome'], issues);
  if (b.outcome !== 'accept' && b.outcome !== 'reject')
    issues.add('/outcome', 'invalid_option', 'Choose accept or reject.');
  issues.throwIfAny();
  return { outcome: b.outcome as 'accept' | 'reject' };
}

export function parseSourceApproval(body: unknown): { version: number; note: string | null } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the approval.');
  unknownFields(b, ['version', 'note'], issues);
  const version = versionNumber(b.version, '/version', issues);
  const note = plainField(b.note, '/note', issues, { max: 500, required: false, label: 'The note' }) ?? null;
  issues.throwIfAny();
  return { version: version!, note };
}

export const parseVersionNumber = (raw: unknown): number | null => {
  const n = typeof raw === 'string' && /^[0-9]{1,7}$/.test(raw) ? Number(raw) : null;
  return n !== null && n >= 1 ? n : null;
};
