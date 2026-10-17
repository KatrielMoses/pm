import { createHash } from 'node:crypto';
import { TenancyError } from '@pm/tenancy';
import { redactCredentials } from '../redaction.ts';
import {
  key,
  SEARCHABLE_KINDS,
  UNSUITABLE_FLAGS,
  type DataClass,
  type Exclusion,
  type IndexState,
  type Manifest,
  type ManifestEntry,
  type PinnedRef,
  type ResolvedScope,
  type RetrievalInput,
  type RetrievalReaders,
  type ScopeInput,
  type Selection,
  type SourceFlag,
  type SourceKind,
  type SourceRecord,
} from './types.ts';

/**
 * The context manifest (ADR-0039 R1–R4): one bounded, explicit, deterministic list of sources for
 * an AI action, built from the effective scope (current authority ∩ AI data policy ∩ the person's
 * choices). Candidates come from the scope, the person's explicit includes, and 5A search; every
 * candidate is then resolved through its canonical read path. The index never authorizes.
 */

export const MANIFEST_TEMPLATE = 'context_manifest.v1';
/** Listing bound: the manifest names at most this many readable sources (citation handles S1..S20). */
export const MANIFEST_LIST_MAX = 20;

export interface ManifestLimits {
  /** Sources sent (AI_CONTEXT_SOURCES_MAX). */
  sourcesMax: number;
  /** Characters of text sent per source (AI_CONTEXT_SOURCE_CHARS). */
  sourceChars: number;
  /** Search candidates considered (bounded by the 5A page size). */
  candidates: number;
}

/** A refusal the gateway reports with a stable code and a sentence that reveals nothing hidden. */
export type RefusalCode =
  | 'scope_unavailable'
  | 'scope_conflict'
  | 'context_unavailable'
  | 'manifest_changed'
  | 'ai_sensitive_brand';

export class RetrievalRefusal extends Error {
  readonly code: RefusalCode;
  readonly reason: string;
  constructor(code: RefusalCode, reason: string) {
    super(code);
    this.name = 'RetrievalRefusal';
    this.code = code;
    this.reason = reason;
  }
}

const hidden = (err: unknown) =>
  err instanceof TenancyError && (err.code === 'not_found' || err.code === 'forbidden');

const CLASS_RANK: Record<DataClass, number> = { C0: 0, C1: 1, C2: 2 };

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Resolves the explicit scope; anything unreadable, unknown, or contradictory refuses. */
export async function resolveScope(
  readers: RetrievalReaders,
  scope: ScopeInput,
): Promise<ResolvedScope> {
  const unavailable = () =>
    new RetrievalRefusal(
      'scope_unavailable',
      'The chosen scope is not available to you. Choose another scope. Nothing was sent.',
    );
  const brands = scope.brands.length ? await readers.brands(scope.brands) : [];
  if (brands.length !== scope.brands.length) throw unavailable();
  if (brands.some((b) => b.sensitive))
    throw new RetrievalRefusal(
      'ai_sensitive_brand',
      'Restricted brands are excluded from AI in this release. Nothing was sent.',
    );
  const load = async (kind: SourceKind, id: string) => {
    try {
      return await readers.source(kind, id);
    } catch (err) {
      if (hidden(err)) throw unavailable();
      throw err;
    }
  };
  const project = scope.project ? await load('project', scope.project) : null;
  const task = scope.task ? await load('task', scope.task) : null;
  const brandIds = new Set(brands.map((b) => b.id));
  const conflict = () =>
    new RetrievalRefusal(
      'scope_conflict',
      'The chosen brand, project, and task do not overlap. Narrow the scope instead of widening it. Nothing was sent.',
    );
  // Conflicting choices never fall back to all brands or the whole workspace.
  if (project && brandIds.size && (!project.brandId || !brandIds.has(project.brandId)))
    throw conflict();
  if (task && brandIds.size && (!task.brandId || !brandIds.has(task.brandId))) throw conflict();
  if (task && project && task.projectId !== project.recordId) throw conflict();
  if ((project && project.brandSensitive) || (task && task.brandSensitive))
    throw new RetrievalRefusal(
      'ai_sensitive_brand',
      'Restricted brands are excluded from AI in this release. Nothing was sent.',
    );
  return {
    brands: brands.map((b) => ({ id: b.id, publicId: b.publicId, name: b.name })),
    project: project
      ? { id: project.recordId, publicId: project.publicId, title: project.title }
      : null,
    task: task ? { id: task.recordId, publicId: task.publicId, title: task.title } : null,
  };
}

function inScope(scope: ResolvedScope, s: SourceRecord): boolean {
  if (scope.brands.length && !(s.brandId && scope.brands.some((b) => b.id === s.brandId)))
    return false;
  if (scope.project && s.projectId !== scope.project.id && s.recordId !== scope.project.id)
    return false;
  if (scope.task && s.taskId !== scope.task.id) return false;
  return true;
}

interface Policy {
  maxDataClass: DataClass;
  /** The single scope brand whose profile limits sources to the brand, if any. */
  brandOnly: string | null;
  limits: ManifestLimits;
}

/** The fields of a source that may be sent under the workspace data class. */
function eligibleFields(s: SourceRecord, maxDataClass: DataClass) {
  return s.fields.filter((f) => CLASS_RANK[f.dataClass] <= CLASS_RANK[maxDataClass]);
}

function exclusionFor(
  s: SourceRecord,
  selection: Selection,
  scope: ResolvedScope,
  excluded: boolean,
  policy: Policy,
): Exclusion | null {
  if (excluded) return 'user_excluded';
  if (!inScope(scope, s)) return 'out_of_scope';
  if (s.brandSensitive) return 'sensitive_brand';
  if (policy.brandOnly && s.brandId !== policy.brandOnly) return 'brand_only_policy';
  if (!eligibleFields(s, policy.maxDataClass).length) return 'data_class';
  // A stale, draft, unapproved, superseded, or archived source is used only by explicit choice.
  if (
    selection !== 'explicit' &&
    s.flags.some((f) => (UNSUITABLE_FLAGS as readonly string[]).includes(f))
  )
    return 'needs_explicit_choice';
  return null;
}

/** The exact payload sent for a source: redacted, bounded, deterministic. */
export function payloadOf(
  s: SourceRecord,
  maxDataClass: DataClass,
  sourceChars: number,
): { payload: Record<string, string>; truncated: boolean; hash: string; fieldNames: string[] } {
  const fields = eligibleFields(s, maxDataClass);
  const payload: Record<string, string> = {};
  let room = sourceChars;
  let truncated = false;
  for (const f of fields) {
    const text = redactCredentials(f.text).text;
    const piece = text.slice(0, Math.max(room, 0));
    if (piece.length < text.length) truncated = true;
    payload[f.name] = piece;
    room -= piece.length;
  }
  const hash = sha256(
    JSON.stringify({ kind: s.kind, id: s.publicId, version: s.version, fields: payload }),
  );
  return { payload, truncated, hash, fieldNames: fields.map((f) => f.name) };
}

function digestOf(
  scope: ResolvedScope,
  query: string | null,
  entries: ManifestEntry[],
  omitted: number,
) {
  return sha256(
    JSON.stringify({
      t: MANIFEST_TEMPLATE,
      scope: {
        brands: scope.brands.map((b) => b.publicId),
        project: scope.project?.publicId ?? null,
        task: scope.task?.publicId ?? null,
      },
      query,
      entries: entries.map((e) => [
        e.key,
        e.version,
        e.contentHash,
        e.included,
        e.exclusion,
        e.flags,
        e.handle,
        e.selection,
      ]),
      omitted,
    }),
  );
}

function entryOf(
  s: SourceRecord,
  selection: Selection,
  exclusion: Exclusion | null,
  policy: Policy,
): ManifestEntry {
  const sent = exclusion ? null : payloadOf(s, policy.maxDataClass, policy.limits.sourceChars);
  const flags: SourceFlag[] = [...s.flags];
  if (sent?.truncated) flags.push('truncated');
  return {
    key: key(s.kind, s.publicId),
    kind: s.kind,
    publicId: s.publicId,
    recordId: s.recordId,
    title: s.title,
    link: s.link,
    brandId: s.brandId,
    version: s.version,
    versionLabel: s.versionLabel,
    selection,
    included: exclusion === null,
    exclusion,
    flags,
    handle: null,
    fieldNames: sent ? sent.fieldNames : s.fields.map((f) => f.name),
    payload: sent ? sent.payload : null,
    contentHash: sent ? sent.hash : null,
    facts: s.facts,
  };
}

/**
 * Builds the manifest a person previews and confirms. Explicit includes that are hidden or
 * unknown refuse the whole request identically; search candidates that fail their canonical
 * re-check are dropped silently (the index is a pointer, not authorization or current truth).
 */
export async function discoverManifest(
  readers: RetrievalReaders,
  input: RetrievalInput,
  policy: { maxDataClass: DataClass; limits: ManifestLimits },
): Promise<Manifest> {
  const scope = await resolveScope(readers, input.scope);
  const only = scope.brands.length === 1 ? scope.brands[0]!.id : null;
  const full: Policy = {
    ...policy,
    brandOnly: only && (await readers.brandOnly(only)) ? only : null,
  };
  const excluded = new Set(input.exclude.map((r) => key(r.kind, r.id)));
  const candidates: Array<{ kind: SourceKind; id: string; selection: Selection }> = [];
  const seen = new Set<string>();
  const add = (kind: SourceKind, id: string, selection: Selection) => {
    const k = key(kind, id);
    if (seen.has(k)) return;
    seen.add(k);
    candidates.push({ kind, id, selection });
  };
  for (const r of input.include) add(r.kind, r.id, 'explicit');
  // A source the person excluded stays listed (so it can be included again); naming a hidden
  // or unknown one as excluded has no effect and reveals nothing.
  const soft = new Set<string>();
  for (const r of input.exclude) {
    const k = key(r.kind, r.id);
    if (!seen.has(k)) soft.add(k);
    add(r.kind, r.id, 'explicit');
  }
  if (scope.task) {
    add('task', scope.task.publicId, 'scope');
    add('activity', scope.task.publicId, 'scope');
  }
  if (scope.project) add('project', scope.project.publicId, 'scope');
  let index: IndexState | null = null;
  if (input.query) {
    const found = await readers.search({
      q: input.query,
      kinds: SEARCHABLE_KINDS,
      brands: scope.brands.map((b) => b.publicId),
      project: scope.project?.publicId ?? null,
      limit: policy.limits.candidates,
    });
    index = found.index;
    for (const h of found.hits) add(h.kind, h.id, 'search');
  }

  const resolved: Array<{ s: SourceRecord; selection: Selection }> = [];
  for (const [i, c] of candidates.entries()) {
    try {
      resolved.push({ s: await readers.source(c.kind, c.id), selection: c.selection });
    } catch (err) {
      if (!hidden(err)) throw err;
      if (c.selection === 'explicit' && !soft.has(key(c.kind, c.id)))
        throw new RetrievalRefusal(
          'context_unavailable',
          `Source ${i + 1} is not available to you. Nothing was sent.`,
        );
      // A scope implication (the task's activity outside a share) or a stale search pointer.
    }
  }
  // Search results from a task scope must belong to that task (its comments, attached documents).
  const relevant = resolved.filter(
    ({ s, selection }) => selection !== 'search' || inScope(scope, s),
  );
  const listed = relevant.slice(0, MANIFEST_LIST_MAX);
  const omitted = relevant.length - listed.length;
  const entries: ManifestEntry[] = [];
  let sent = 0;
  for (const { s, selection } of listed) {
    let exclusion = exclusionFor(s, selection, scope, excluded.has(key(s.kind, s.publicId)), full);
    if (!exclusion && sent >= policy.limits.sourcesMax) exclusion = 'over_limit';
    const e = entryOf(s, selection, exclusion, full);
    if (e.included) {
      sent += 1;
      e.handle = `S${sent}`;
    }
    entries.push(e);
  }
  return {
    scope,
    query: input.query,
    entries,
    omitted,
    index,
    digest: digestOf(scope, input.query, entries, omitted),
  };
}

/**
 * Re-resolves a recorded manifest immediately before dispatch or publication. A source that is no
 * longer readable refuses (as at preview); one whose content, version, or policy outcome changed
 * invalidates the manifest with an honest notice. Nothing is narrowed silently.
 */
export async function pinnedManifest(
  readers: RetrievalReaders,
  scopeInput: ScopeInput,
  query: string | null,
  pinned: readonly PinnedRef[],
  policy: { maxDataClass: DataClass; limits: ManifestLimits },
  options: { omitted: number } = { omitted: 0 },
): Promise<Manifest> {
  const scope = await resolveScope(readers, scopeInput);
  const only = scope.brands.length === 1 ? scope.brands[0]!.id : null;
  const full: Policy = {
    ...policy,
    brandOnly: only && (await readers.brandOnly(only)) ? only : null,
  };
  const changed = () =>
    new RetrievalRefusal(
      'manifest_changed',
      'A source changed after you reviewed the context. Nothing was sent. Preview the context again.',
    );
  const entries: ManifestEntry[] = [];
  for (const [i, r] of pinned.entries()) {
    if (!r.included) {
      entries.push({
        key: key(r.kind, r.id),
        kind: r.kind,
        publicId: r.id,
        recordId: '',
        title: '',
        link: { type: 'task', id: r.id, anchor: null },
        brandId: null,
        version: r.version,
        versionLabel: r.versionLabel ?? '',
        selection: r.selection,
        included: false,
        exclusion: r.exclusion,
        flags: r.flags,
        handle: null,
        fieldNames: r.fields,
        payload: null,
        contentHash: null,
        facts: {},
      });
      continue;
    }
    let s: SourceRecord;
    try {
      s = await readers.source(r.kind, r.id);
    } catch (err) {
      if (!hidden(err)) throw err;
      throw new RetrievalRefusal(
        'context_unavailable',
        `Source ${i + 1} is not available to you. Nothing was sent.`,
      );
    }
    const exclusion = exclusionFor(s, r.selection, scope, false, full);
    if (exclusion) throw changed();
    const e = entryOf(s, r.selection, null, full);
    if (e.contentHash !== r.contentHash) throw changed();
    e.handle = r.handle;
    entries.push(e);
  }
  return {
    scope,
    query,
    entries,
    omitted: options.omitted,
    index: null,
    digest: digestOf(scope, query, entries, options.omitted),
  };
}
