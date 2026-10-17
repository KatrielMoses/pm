/**
 * Phase 7B retrieval types (ADR-0039). A source is always resolved through its module's canonical
 * read path for the current principal; the search index only proposes candidates.
 */

/** Source kinds with a genuine, implemented canonical read path. */
export const SOURCE_KINDS = ['task', 'project', 'document', 'comment', 'activity'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Kinds that 5A search can propose (activity is reached through its task, never searched). */
export const SEARCHABLE_KINDS = ['task', 'project', 'document', 'comment'] as const;

/** Suitability flags: a flagged source is listed but needs an explicit choice to be included. */
export const UNSUITABLE_FLAGS = [
  'stale',
  'draft',
  'unapproved',
  'approved_version_differs',
  'archived',
] as const;
export const SOURCE_FLAGS = [...UNSUITABLE_FLAGS, 'truncated'] as const;
export type SourceFlag = (typeof SOURCE_FLAGS)[number];

export const EXCLUSIONS = [
  'field_not_ai_eligible',
  'data_class',
  'sensitive_brand',
  'out_of_scope',
  'user_excluded',
  'needs_explicit_choice',
  'brand_only_policy',
  'over_limit',
] as const;
export type Exclusion = (typeof EXCLUSIONS)[number];

/** How a source entered the manifest: named by the person, implied by the scope, or searched. */
export type Selection = 'explicit' | 'scope' | 'search';

export type DataClass = 'C0' | 'C1' | 'C2';

export interface SourceFacts {
  status?: { name: string; category: string };
  dueDate?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  completedAt?: string | null;
  /** Documents: the approved version, when an approval still applies to the current version. */
  approvedVersion?: number | null;
  reviewDueOn?: string | null;
  documentState?: string;
}

/** A source resolved through its canonical read path for the current principal. */
export interface SourceRecord {
  kind: SourceKind;
  /** The public reference (an activity source is named by its task). */
  publicId: string;
  /** The internal id of the source (recorded as a reference only; no foreign key). */
  recordId: string;
  brandId: string | null;
  brandSensitive: boolean;
  /** The governing project, when there is one. */
  projectId: string | null;
  /** The governing task: the task itself, a comment's host task, a document's attached task. */
  taskId: string | null;
  /** The display title, resolved through current authorization. */
  title: string;
  /** Where a citation of this source opens (the canonical record page). */
  link: { type: 'task' | 'project' | 'document'; id: string; anchor: string | null };
  /** A numeric version (row or content version) and a readable label for it. */
  version: number;
  versionLabel: string;
  /** AI-eligible text fields only, in a fixed order, with their data class. */
  fields: Array<{ name: string; dataClass: DataClass; text: string }>;
  facts: SourceFacts;
  flags: SourceFlag[];
}

export interface IndexState {
  state: 'complete' | 'catching_up' | 'degraded';
  pending: number;
  failed: number;
}

/** What the gateway lends the retrieval engine: canonical reads for one principal and transaction. */
export interface RetrievalReaders {
  /** Resolves one source; throws a not_found/forbidden TenancyError when it is not readable. */
  source(kind: SourceKind, publicId: string): Promise<SourceRecord>;
  /** 5A search over readable records (candidates only). */
  search(q: {
    q: string;
    kinds: readonly string[];
    brands: readonly string[];
    project: string | null;
    limit: number;
  }): Promise<{ hits: Array<{ kind: SourceKind; id: string }>; index: IndexState }>;
  /**
   * Readable brands by public id (unreadable or unknown ones are simply absent): active only, or
   * also archived when re-checking history (an archived brand's history stays readable).
   */
  brands(
    publicIds: readonly string[],
    opts?: { archived?: boolean },
  ): Promise<Array<{ id: string; publicId: string; name: string; sensitive: boolean }>>;
  /** Whether the brand's AI profile limits sources to the brand (approved_sources = brand_only). */
  brandOnly(brandId: string): Promise<boolean>;
}

export interface SourceRef {
  kind: SourceKind;
  id: string;
}

export interface ScopeInput {
  brands: string[];
  project: string | null;
  task: string | null;
}

export interface RetrievalInput {
  scope: ScopeInput;
  query: string | null;
  include: SourceRef[];
  exclude: SourceRef[];
}

/** A manifest entry recorded on a run, re-resolved before dispatch and publication. */
export interface PinnedRef {
  kind: SourceKind;
  id: string;
  selection: Selection;
  included: boolean;
  exclusion: Exclusion | null;
  handle: string | null;
  contentHash: string | null;
  flags: SourceFlag[];
  version: number;
  versionLabel: string | null;
  fields: string[];
}

export interface ResolvedScope {
  brands: Array<{ id: string; publicId: string; name: string }>;
  project: { id: string; publicId: string; title: string } | null;
  task: { id: string; publicId: string; title: string } | null;
}

export interface ManifestEntry {
  key: string;
  kind: SourceKind;
  publicId: string;
  recordId: string;
  title: string;
  link: SourceRecord['link'];
  brandId: string | null;
  version: number;
  versionLabel: string;
  selection: Selection;
  included: boolean;
  exclusion: Exclusion | null;
  flags: SourceFlag[];
  handle: string | null;
  /** The field names sent (or that would be sent) for this source. */
  fieldNames: string[];
  /** The exact, redacted text sent to the provider (included sources only; memory only). */
  payload: Record<string, string> | null;
  contentHash: string | null;
  facts: SourceFacts;
}

export interface Manifest {
  scope: ResolvedScope;
  query: string | null;
  entries: ManifestEntry[];
  /** Readable candidates beyond the listing bound (never counts hidden records). */
  omitted: number;
  index: IndexState | null;
  digest: string;
}

export const key = (kind: SourceKind, id: string) => `${kind}:${id}`;
