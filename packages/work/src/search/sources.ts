import { plainFromRichText, type RichTextDoc } from '@pm/contracts/rich-text';
import { sql, type RawBuilder, type WorkspaceTransaction } from '@pm/db';
import { plainText, readContent } from '../docs/content.ts';
import { clampBody, oneLine } from './semantics.ts';

/**
 * Search sources (Phase 5A, ADR-0028). A source is the only way text enters the index: it names
 * a kind, loads the current indexable form of one row, and says which record's access governs it.
 * A later phase registers an adapter here; nothing else can add an entry. A source never decides
 * who may see its text (the query applies the compiled visibility predicate to the governing
 * record), and it never returns text the owning module would show only to some viewers: custom
 * field values, live drafts, and restricted reference labels are not indexed.
 */

export interface IndexDoc {
  /** The record whose access governs the entry (the host for a comment, file, or deliverable). */
  authRecordId: string;
  /** The record that opens the entry in context, when it is not the entry itself. */
  contextRecordId: string | null;
  title: string;
  body: string;
  ownerMembershipId: string | null;
  updatedAt: Date;
}

export class SourceContentError extends Error {
  constructor(message = 'source content cannot be indexed') {
    super(message);
    this.name = 'SourceContentError';
  }
}

export interface SearchSource {
  /** The kind stored on entries and shown as the result type (`task`, `comment`, ...). */
  readonly kind: string;
  /** Plural, human label for filters ("Tasks"). */
  readonly label: string;
  /**
   * The current indexable form of one source row, or null when the row is gone, purged, deleted,
   * or not indexable (the entry is then removed). Throws `SourceContentError` for content that
   * cannot be read, which marks the task failed (visible), never silently skipped.
   */
  load(tx: WorkspaceTransaction, id: string, limits: { bodyMax: number }): Promise<IndexDoc | null>;
  /** Public identifiers of source rows by internal id (the identifiers clients use). */
  publicIds(tx: WorkspaceTransaction, ids: readonly string[]): Promise<Map<string, string>>;
  /**
   * What the entry's own row must still satisfy when it is read (a deleted comment, a trashed
   * file), checked live because the index may lag. `states` are the lifecycle states the query
   * allows. Absent: the governing record's lifecycle is the only one.
   */
  live?(entry: string, states: readonly string[]): RawBuilder<boolean>;
  /** The source row of a public identifier, for the open check; null when unknown. */
  resolve(
    tx: WorkspaceTransaction,
    publicId: string,
  ): Promise<{ id: string; authRecordId: string; contextRecordId: string | null } | null>;
}

const richText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  try {
    return plainFromRichText(value as RichTextDoc);
  } catch {
    throw new SourceContentError('description is not readable rich text');
  }
};

/** The identifier of a record-backed kind: the record's public id. */
async function recordPublicIds(
  tx: WorkspaceTransaction,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await tx.db
    .selectFrom('core.record')
    .select(['id', 'public_id'])
    .where('id', 'in', [...ids])
    .execute();
  for (const r of rows) out.set(r.id, r.public_id);
  return out;
}

async function recordResolve(
  tx: WorkspaceTransaction,
  recordType: string,
  publicId: string,
  context?: (id: string) => Promise<string | null>,
) {
  const r = await tx.db
    .selectFrom('core.record')
    .select(['id'])
    .where('public_id', '=', publicId)
    .where('record_type', '=', recordType)
    .executeTakeFirst();
  if (!r) return null;
  return { id: r.id, authRecordId: r.id, contextRecordId: context ? await context(r.id) : null };
}

const notPurged = sql<boolean>`r.lifecycle_state <> 'purged'`;

// ---------------------------------------------------------------------------------------------
// Work records
// ---------------------------------------------------------------------------------------------

const taskSource: SearchSource = {
  kind: 'task',
  label: 'Tasks',
  async load(tx, id, limits) {
    const t = await tx.db
      .selectFrom('work.task as t')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 't.workspace_id').onRef('r.id', '=', 't.id'),
      )
      .select([
        't.id',
        't.title',
        't.description_rich',
        't.created_by_membership_id',
        't.updated_at',
      ])
      .where('t.id', '=', id)
      .where(notPurged)
      .executeTakeFirst();
    if (!t) return null;
    return {
      authRecordId: t.id,
      contextRecordId: null,
      title: t.title,
      body: clampBody(richText(t.description_rich), limits.bodyMax),
      ownerMembershipId: t.created_by_membership_id,
      updatedAt: t.updated_at,
    };
  },
  publicIds: recordPublicIds,
  resolve: (tx, publicId) => recordResolve(tx, 'task', publicId),
};

const projectSource: SearchSource = {
  kind: 'project',
  label: 'Projects',
  async load(tx, id, limits) {
    const p = await tx.db
      .selectFrom('work.project as p')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'p.workspace_id').onRef('r.id', '=', 'p.id'),
      )
      .select(['p.id', 'p.name', 'p.description_rich', 'p.owner_membership_id', 'p.updated_at'])
      .where('p.id', '=', id)
      .where(notPurged)
      .executeTakeFirst();
    if (!p) return null;
    return {
      authRecordId: p.id,
      contextRecordId: null,
      title: p.name,
      body: clampBody(richText(p.description_rich), limits.bodyMax),
      ownerMembershipId: p.owner_membership_id,
      updatedAt: p.updated_at,
    };
  },
  publicIds: recordPublicIds,
  resolve: (tx, publicId) => recordResolve(tx, 'project', publicId),
};

const milestoneSource: SearchSource = {
  kind: 'milestone',
  label: 'Milestones',
  async load(tx, id) {
    const m = await tx.db
      .selectFrom('work.milestone as m')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'm.workspace_id').onRef('r.id', '=', 'm.id'),
      )
      .select(['m.id', 'm.name', 'm.project_id', 'm.owner_membership_id', 'm.updated_at'])
      .where('m.id', '=', id)
      .where(notPurged)
      .executeTakeFirst();
    if (!m) return null;
    return {
      authRecordId: m.id,
      contextRecordId: m.project_id,
      title: m.name,
      body: '',
      ownerMembershipId: m.owner_membership_id,
      updatedAt: m.updated_at,
    };
  },
  publicIds: recordPublicIds,
  resolve: (tx, publicId) =>
    recordResolve(tx, 'milestone', publicId, async (id) => {
      const m = await tx.db
        .selectFrom('work.milestone')
        .select('project_id')
        .where('id', '=', id)
        .executeTakeFirst();
      return m?.project_id ?? null;
    }),
};

const decisionSource: SearchSource = {
  kind: 'decision_record',
  label: 'Decisions',
  async load(tx, id, limits) {
    const d = await tx.db
      .selectFrom('work.decision_record as d')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'd.workspace_id').onRef('r.id', '=', 'd.id'),
      )
      .select([
        'd.id',
        'd.statement',
        'd.outcome',
        'd.project_id',
        'd.owner_membership_id',
        'd.updated_at',
      ])
      .where('d.id', '=', id)
      .where(notPurged)
      .executeTakeFirst();
    if (!d) return null;
    return {
      authRecordId: d.id,
      contextRecordId: d.project_id,
      title: oneLine(d.statement, 200) || 'Decision',
      body: clampBody([d.statement, d.outcome ?? ''].filter(Boolean).join('\n'), limits.bodyMax),
      ownerMembershipId: d.owner_membership_id,
      updatedAt: d.updated_at,
    };
  },
  publicIds: recordPublicIds,
  resolve: (tx, publicId) =>
    recordResolve(tx, 'decision_record', publicId, async (id) => {
      const d = await tx.db
        .selectFrom('work.decision_record')
        .select('project_id')
        .where('id', '=', id)
        .executeTakeFirst();
      return d?.project_id ?? null;
    }),
};

// ---------------------------------------------------------------------------------------------
// Documents: the text of the current saved version. A live draft is never indexed, so search
// cannot show what no version contains; references contribute no text (their labels are the
// viewer's to see), and a file embed contributes its title only.
// ---------------------------------------------------------------------------------------------

const documentSource: SearchSource = {
  kind: 'document',
  label: 'Documents',
  async load(tx, id, limits) {
    const d = await tx.db
      .selectFrom('knowledge.document as d')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'd.workspace_id').onRef('r.id', '=', 'd.id'),
      )
      .leftJoin('knowledge.document_version as v', (j) =>
        j.onRef('v.workspace_id', '=', 'd.workspace_id').onRef('v.id', '=', 'd.current_version_id'),
      )
      .select(['d.id', 'd.title', 'd.owner_membership_id', 'd.updated_at', 'v.content'])
      .where('d.id', '=', id)
      .where(notPurged)
      .executeTakeFirst();
    if (!d) return null;
    let body = '';
    if (d.content !== null && d.content !== undefined) {
      try {
        body = plainText(readContent(d.content));
      } catch {
        throw new SourceContentError('document content is not readable');
      }
    }
    return {
      authRecordId: d.id,
      contextRecordId: null,
      title: d.title,
      body: clampBody(body, limits.bodyMax),
      ownerMembershipId: d.owner_membership_id,
      updatedAt: d.updated_at,
    };
  },
  publicIds: recordPublicIds,
  resolve: (tx, publicId) => recordResolve(tx, 'document', publicId),
};

// ---------------------------------------------------------------------------------------------
// Comments (4A): governed by the record they are on; a deleted comment is gone at once.
// ---------------------------------------------------------------------------------------------

const commentSource: SearchSource = {
  kind: 'comment',
  label: 'Comments',
  async load(tx, id, limits) {
    const c = await tx.db
      .selectFrom('collab.comment as c')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'c.workspace_id').onRef('r.id', '=', 'c.host_record_id'),
      )
      .select([
        'c.id',
        'c.host_record_id',
        'c.body_text',
        'c.author_membership_id',
        'c.created_at',
        'c.edited_at',
        'c.deleted_at',
      ])
      .where('c.id', '=', id)
      .where(notPurged)
      .executeTakeFirst();
    if (!c || c.deleted_at !== null || !c.body_text) return null;
    return {
      authRecordId: c.host_record_id,
      contextRecordId: c.host_record_id,
      title: oneLine(c.body_text, 80) || 'Comment',
      body: clampBody(c.body_text, limits.bodyMax),
      ownerMembershipId: c.author_membership_id,
      updatedAt: c.edited_at ?? c.created_at,
    };
  },
  async publicIds(tx, ids) {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = await tx.db
      .selectFrom('collab.comment')
      .select(['id', 'public_id'])
      .where('id', 'in', [...ids])
      .execute();
    for (const r of rows) out.set(r.id, r.public_id);
    return out;
  },
  live: (entry) =>
    sql<boolean>`EXISTS (SELECT 1 FROM collab.comment c
                          WHERE c.workspace_id = ${sql.ref(`${entry}.workspace_id`)}
                            AND c.id = ${sql.ref(`${entry}.source_id`)} AND c.deleted_at IS NULL)`,
  async resolve(tx, publicId) {
    const c = await tx.db
      .selectFrom('collab.comment')
      .select(['id', 'host_record_id'])
      .where('public_id', '=', publicId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return c
      ? { id: c.id, authRecordId: c.host_record_id, contextRecordId: c.host_record_id }
      : null;
  },
};

// ---------------------------------------------------------------------------------------------
// Files and deliverables (4E): metadata only (names, titles, a submission note). Bytes are never
// read, and a hit never carries an address; preview and download stay 4E's authorized routes.
// ---------------------------------------------------------------------------------------------

const ownLive = (): NonNullable<SearchSource['live']> => (entry, states) =>
  sql<boolean>`EXISTS (SELECT 1 FROM core.record o
                          WHERE o.workspace_id = ${sql.ref(`${entry}.workspace_id`)}
                            AND o.id = ${sql.ref(`${entry}.source_id`)}
                            AND o.lifecycle_state = ANY(${[...states]}::core.lifecycle_state[]))`;

const fileSource: SearchSource = {
  kind: 'file',
  label: 'Files',
  async load(tx, id) {
    const f = await tx.db
      .selectFrom('files.file as f')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'f.workspace_id').onRef('r.id', '=', 'f.id'),
      )
      .select([
        'f.id',
        'f.name',
        'f.host_kind',
        'f.host_record_id',
        'f.owner_membership_id',
        'f.updated_at',
      ])
      .where('f.id', '=', id)
      .where(notPurged)
      .executeTakeFirst();
    if (!f) return null;
    const workspaceHost = f.host_kind === 'workspace';
    const host = workspaceHost ? null : f.host_record_id;
    if (!workspaceHost && !host) return null;
    return {
      authRecordId: host ?? f.id,
      contextRecordId: host,
      title: f.name,
      body: '',
      ownerMembershipId: f.owner_membership_id,
      updatedAt: f.updated_at,
    };
  },
  publicIds: recordPublicIds,
  live: ownLive(),
  async resolve(tx, publicId) {
    const f = await tx.db
      .selectFrom('core.record as r')
      .innerJoin('files.file as f', (j) =>
        j.onRef('f.workspace_id', '=', 'r.workspace_id').onRef('f.id', '=', 'r.id'),
      )
      .select(['f.id', 'f.host_kind', 'f.host_record_id'])
      .where('r.public_id', '=', publicId)
      .where('r.record_type', '=', 'file')
      .executeTakeFirst();
    if (!f) return null;
    const host = f.host_kind === 'workspace' ? null : f.host_record_id;
    return { id: f.id, authRecordId: host ?? f.id, contextRecordId: host };
  },
};

const deliverableSource: SearchSource = {
  kind: 'deliverable',
  label: 'Deliverables',
  async load(tx, id, limits) {
    const d = await tx.db
      .selectFrom('files.deliverable as d')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'd.workspace_id').onRef('r.id', '=', 'd.id'),
      )
      .leftJoin('files.deliverable_version as v', (j) =>
        j.onRef('v.workspace_id', '=', 'd.workspace_id').onRef('v.id', '=', 'd.current_version_id'),
      )
      .select([
        'd.id',
        'd.title',
        'd.task_id',
        'd.created_by_membership_id',
        'd.updated_at',
        'v.note_text',
      ])
      .where('d.id', '=', id)
      .where(notPurged)
      .executeTakeFirst();
    if (!d) return null;
    return {
      authRecordId: d.task_id,
      contextRecordId: d.task_id,
      title: d.title,
      body: clampBody(d.note_text ?? '', limits.bodyMax),
      ownerMembershipId: d.created_by_membership_id,
      updatedAt: d.updated_at,
    };
  },
  publicIds: recordPublicIds,
  live: ownLive(),
  async resolve(tx, publicId) {
    const d = await tx.db
      .selectFrom('core.record as r')
      .innerJoin('files.deliverable as d', (j) =>
        j.onRef('d.workspace_id', '=', 'r.workspace_id').onRef('d.id', '=', 'r.id'),
      )
      .select(['d.id', 'd.task_id'])
      .where('r.public_id', '=', publicId)
      .where('r.record_type', '=', 'deliverable')
      .executeTakeFirst();
    return d ? { id: d.id, authRecordId: d.task_id, contextRecordId: d.task_id } : null;
  },
};

/** The registry of search sources: a lookup by kind, in the order filters list them. */
export class SearchSourceRegistry {
  readonly #sources = new Map<string, SearchSource>();

  register(source: SearchSource): this {
    if (!/^[a-z][a-z_]{1,30}$/.test(source.kind))
      throw new Error(`search source kind ${source.kind} is not a valid kind`);
    if (this.#sources.has(source.kind))
      throw new Error(`search source ${source.kind} is already registered`);
    this.#sources.set(source.kind, source);
    return this;
  }

  get(kind: string): SearchSource | undefined {
    return this.#sources.get(kind);
  }

  all(): SearchSource[] {
    return [...this.#sources.values()];
  }

  kinds(): string[] {
    return [...this.#sources.keys()];
  }
}

/** The 5A registrations: the Phase 1–4 records that carry searchable text. */
export function defaultSearchSources(): SearchSourceRegistry {
  return new SearchSourceRegistry()
    .register(projectSource)
    .register(taskSource)
    .register(milestoneSource)
    .register(decisionSource)
    .register(documentSource)
    .register(commentSource)
    .register(fileSource)
    .register(deliverableSource);
}
