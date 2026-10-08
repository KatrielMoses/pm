import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  brandMarker,
  compileVisibility,
  decideRecord,
  invalid,
  issue,
  levelRank,
  recordLevel,
  TenancyError,
  type BrandFacts,
  type Caller,
  type Level,
  type Principal,
  type ProjectChain,
  type ShareLevel,
} from '@pm/tenancy';
import type { ActionKey } from '@pm/contracts';
import { NotificationService } from '../notify/notification-service.ts';
import { NIL_ID, toDate } from '../service.ts';
import { todayIn } from '../task-core.ts';
import { isPublic } from '../validation.ts';
import type { CollabHost } from '../collab/comment-service.ts';
import { recordJoins } from '../collab/record-sql.ts';
import {
  DEFAULT_CONTENT_LIMITS,
  collectRefs,
  isRestrictedRef,
  mapRefs,
  readContent,
  restrictedToken,
  type ContentLimits,
  type DocContent,
  type Ref,
  type DocRefKind,
  DOC_REF_PREFIX,
} from './content.ts';
import {
  DOC_TYPE_LABEL,
  effectiveState,
  reviewOverdue,
  type AttachmentKind,
  type DocState,
  type DocType,
} from './semantics.ts';
import { parseDocumentList, parseVersionNumber, type DocumentListQuery } from './validation.ts';

const NIL_DOC = `doc_${'0'.repeat(26)}`;
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export interface DocumentRow {
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: 'active' | 'archived' | 'trashed' | 'purged';
  parent_document_id: string | null;
  ancestor_ids: string[];
  depth: number;
  attached_project_id: string | null;
  attached_task_id: string | null;
  doc_type: DocType;
  title: string;
  state: DocState;
  owner_membership_id: string;
  review_due_on: string | null;
  current_version_id: string | null;
  current_version_number: number;
  rank: string;
  created_by_membership_id: string;
  created_at: Date;
  updated_at: Date;
  updated_by_membership_id: string | null;
  version: number;
  public_id: string;
  task_project_id: string | null;
}

/** A document resolved through the one compiled level (placement, share, lifecycle). */
export interface LoadedDocument {
  id: string;
  publicId: string;
  brand: (BrandFacts & { publicId: string; name: string; timezone: string }) | null;
  brandMarker: ReturnType<typeof brandMarker> | null;
  chain: ProjectChain;
  /** The governing project (attached, or the attached task's project). */
  projectId: string | null;
  lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
  level: Level;
  /** Ownership-derived level only (null: the caller reads it through a share alone). */
  ownLevel: Level | null;
  row: DocumentRow;
}

interface RankPos {
  k: string;
  id: string;
}

export interface VersionRow {
  id: string;
  number: number;
  title: string;
  content: unknown;
  content_hash: string;
  size_bytes: number;
  kind: 'save' | 'restore' | 'suggestion' | 'template';
  restored_from_number: number | null;
  template_key: string | null;
  change_summary: Record<string, number>;
  created_by_membership_id: string;
  created_at: Date;
}

/**
 * Phase 4C documents, part one (ADR-0025; 0B ADR-33, 0C AZ-33): resolution, authorization, views,
 * lists, versions, references, and backlinks. A document is authorized through its placement
 * (brand or workspace level, the governing project chain, exact-record shares) by the one compiled
 * level; nothing here stores or caches anyone's access. Every reference a viewer sees is resolved
 * for that viewer when shown (IA-46).
 */
export class DocumentCore extends NotificationService {
  readonly #posKey: Buffer;

  constructor(deps: ConstructorParameters<typeof NotificationService>[0]) {
    super(deps);
    this.#posKey = createHmac('sha256', deps.signingKey).update('cursor:knowledge.documents').digest();
  }

  protected contentLimits(): ContentLimits {
    return {
      bodyMaxBytes: this.ws.documentBodyMaxBytes,
      blocksMax: this.ws.documentBlocksMax,
      blockTextMaxChars: this.ws.documentBlockTextMaxChars,
      tableCellsMax: this.ws.documentTableCellsMax,
      referencesMax: this.ws.documentReferencesMax,
      embedUrlMaxChars: this.ws.documentEmbedUrlMaxChars,
    } satisfies ContentLimits;
  }

  protected static readonly defaultLimits = DEFAULT_CONTENT_LIMITS;

  // ---------------------------------------------------------------------------------------------
  // Cursors over (key, id) positions
  // ---------------------------------------------------------------------------------------------

  protected sealPos(p: Principal, fp: string, pos: RankPos): string {
    const payload = JSON.stringify(pos);
    const mac = createHmac('sha256', this.#posKey)
      .update(`${p.workspaceId}|${p.membershipId}|${fp}|${payload}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    return Buffer.from(JSON.stringify({ p: payload, m: mac })).toString('base64url');
  }

  protected openPos(p: Principal, fp: string, raw: unknown): RankPos {
    try {
      if (typeof raw !== 'string' || raw.length > 2048) throw new Error();
      const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { p: string; m: string };
      const want = createHmac('sha256', this.#posKey)
        .update(`${p.workspaceId}|${p.membershipId}|${fp}|${o.p}`)
        .digest()
        .subarray(0, 16);
      const got = Buffer.from(o.m, 'base64url');
      if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error();
      const pos = JSON.parse(o.p) as RankPos;
      if (typeof pos.k !== 'string' || pos.k.length > 80 || !/^[0-9a-f-]{36}$/.test(pos.id))
        throw new Error();
      return pos;
    } catch {
      throw new TenancyError('cursor_invalid');
    }
  }

  /** The content a viewer receives: references they cannot read become opaque tokens (IA-46). */
  protected redact(
    d: { id: string },
    content: DocContent,
    resolved: Record<string, unknown>,
  ): DocContent {
    return mapRefs(content, (r) =>
      isRestrictedRef(r) || resolved[`${r.kind}:${r.id}`]
        ? r
        : { kind: 'restricted', id: restrictedToken(this.#posKey, d.id, r) },
    );
  }

  /**
   * Puts back the references that restricted tokens stand for. A token must name a reference the
   * document already holds (its current content); anything else is refused, and nothing about
   * what a token stands for is ever sent to the client.
   */
  protected restoreRefs(d: { id: string }, current: DocContent | null, next: DocContent): DocContent {
    const known = new Map<string, Ref>();
    if (current)
      for (const f of collectRefs(current))
        known.set(restrictedToken(this.#posKey, d.id, f), { kind: f.kind, id: f.id });
    let bad = false;
    const out = mapRefs(next, (r) => {
      if (!isRestrictedRef(r)) return r;
      const real = known.get(r.id);
      if (!real) bad = true;
      return real ?? r;
    });
    if (bad)
      throw invalid(
        issue('/content', 'invalid_reference', 'This document changed. Reload it and try again.'),
      );
    return out;
  }

  protected docFp(...parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
  }

  // ---------------------------------------------------------------------------------------------
  // Resolution and authorization
  // ---------------------------------------------------------------------------------------------

  /**
   * One document by public ID through the compiled level. Anything unreadable or unknown is the
   * same `not_found`, and an unknown identifier runs the same statements as a document the caller
   * cannot read (constant shape).
   */
  protected async loadDocument(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    opts: { lock?: boolean; allowTrashed?: boolean } = {},
  ): Promise<LoadedDocument> {
    const unknown = async (): Promise<never> => {
      await this.brandFactsOf(tx, NIL_ID).catch(() => undefined);
      await this.chainOfProject(tx, null);
      await this.shareLevelOf(tx, p, NIL_ID);
      throw new TenancyError('not_found');
    };
    if (!isPublic(publicId, 'doc')) return unknown();
    let q = tx.db
      .selectFrom('core.record as r')
      .innerJoin('knowledge.document as d', (j) =>
        j.onRef('d.workspace_id', '=', 'r.workspace_id').onRef('d.id', '=', 'r.id'),
      )
      .leftJoin('work.task as kt', (j) =>
        j.onRef('kt.workspace_id', '=', 'd.workspace_id').onRef('kt.id', '=', 'd.attached_task_id'),
      )
      .selectAll('d')
      .select(['r.public_id', 'kt.project_id as task_project_id'])
      .where('r.public_id', '=', publicId)
      .where('r.record_type', '=', 'document');
    if (opts.lock) q = q.forUpdate('d');
    const row = await q.executeTakeFirst();
    if (!row) return unknown();
    let brand: LoadedDocument['brand'] = null;
    let marker: LoadedDocument['brandMarker'] = null;
    if (row.brand_id) {
      const b = await this.brandFactsOf(tx, row.brand_id);
      brand = b.facts;
      marker = b.marker;
    } else await this.brandFactsOf(tx, NIL_ID).catch(() => undefined);
    const projectId = row.attached_project_id ?? row.task_project_id;
    const chain = await this.chainOfProject(tx, projectId);
    const trashed = row.lifecycle_state === 'trashed';
    const share = await this.shareLevelOf(tx, p, row.id);
    if (trashed && !opts.allowTrashed) throw new TenancyError('not_found');
    const lifecycleState = trashed ? 'active' : row.lifecycle_state;
    const shareLevel = trashed ? null : share;
    const level = recordLevel(p, { brand, lifecycleState, projectChain: chain, shareLevel });
    if (level === null) throw new TenancyError('not_found');
    const ownLevel = recordLevel(p, { brand, lifecycleState, projectChain: chain, shareLevel: null });
    if (trashed && (ownLevel === null || levelRank(ownLevel) < levelRank('edit')))
      throw new TenancyError('not_found');
    return {
      id: row.id,
      publicId: row.public_id,
      brand,
      brandMarker: marker,
      chain,
      projectId,
      lifecycleState: row.lifecycle_state,
      level,
      ownLevel,
      row: {
        ...row,
        review_due_on: toDate(row.review_due_on),
        current_version_number: Number(row.current_version_number),
        depth: Number(row.depth),
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
        version: Number(row.version),
      } as DocumentRow,
    };
  }

  protected docShare(d: LoadedDocument): ShareLevel | null {
    if (d.ownLevel !== null && levelRank(d.ownLevel) >= levelRank(d.level)) return null;
    return d.level === 'view' ? 'read' : d.level === 'manage' ? 'edit' : d.level;
  }

  /**
   * A record decision on a document. `shares: false` excludes share authority: for context outside
   * the share (the tree, ancestors, backlinks) a share-only reader gets `not_found`; for actions on
   * the shared document itself it gets `forbidden` (`excluded: 'forbidden'`).
   */
  protected requireDocAction(
    p: Principal,
    action: ActionKey,
    d: LoadedDocument,
    opts: {
      shares?: boolean;
      excluded?: 'not_found' | 'forbidden';
      lifecycleState?: LoadedDocument['lifecycleState'];
    } = {},
  ): void {
    if (opts.shares === false && d.ownLevel === null)
      throw new TenancyError(opts.excluded ?? 'not_found');
    const o = decideRecord(p, action, {
      brand: d.brand,
      lifecycleState: opts.lifecycleState ?? d.lifecycleState,
      shareLevel: opts.shares === false ? null : this.docShare(d),
      projectChain: d.chain,
    });
    this.decision(action, o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  protected docAllows(
    p: Principal,
    action: ActionKey,
    d: LoadedDocument,
    opts: { shares?: boolean } = {},
  ): boolean {
    try {
      this.requireDocAction(p, action, d, opts);
      return true;
    } catch (err) {
      if (err instanceof TenancyError) return false;
      throw err;
    }
  }

  protected requireDocActive(d: LoadedDocument): void {
    if (d.lifecycleState !== 'active')
      throw new TenancyError('conflict', {
        issues: [issue('/', 'document_archived', 'This document is archived. Restore it to make changes.')],
      });
  }

  /** Editing content, title, links: `record.update` through the document's own level. */
  protected editableDoc(p: Principal, d: LoadedDocument): void {
    this.requireDocAction(p, 'record.update', d);
    this.requireDocActive(d);
  }

  /** The 4A host for comments, following, and reviews (ADR-0025 D6). */
  protected override async loadExtraHost(
    tx: WorkspaceTransaction,
    p: Principal,
    rec: unknown,
    opts: { lock?: boolean },
  ): Promise<CollabHost | null> {
    if (!isPublic(rec, 'doc')) return null;
    const d = await this.loadDocument(tx, p, rec, opts);
    return {
      kind: 'document',
      id: d.id,
      publicId: d.publicId,
      title: d.row.title,
      brand: d.brand,
      chain: d.chain,
      lifecycleState: d.lifecycleState,
      level: d.level,
      ownLevel: d.ownLevel,
      version: d.row.current_version_number,
      decide: (action, o = {}) => this.requireDocAction(p, action, d, o),
      allows: (action, o = {}) => this.docAllows(p, action, d, o),
      projectOf: sql`COALESCE(kd.attached_project_id, kt.project_id)`,
      joinSql: sql`JOIN knowledge.document kd ON kd.workspace_id = r.workspace_id AND kd.id = r.id
        LEFT JOIN work.task kt ON kt.workspace_id = kd.workspace_id AND kt.id = kd.attached_task_id`,
      task: null,
    };
  }

  protected async docVisibility(tx: WorkspaceTransaction, p: Principal, includeArchived = true) {
    return compileVisibility(tx, p, {
      need: 'view',
      includeArchived,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
  }

  protected async workspaceToday(tx: WorkspaceTransaction): Promise<string> {
    const w = await tx.db
      .selectFrom('tenancy.workspace')
      .select('timezone')
      .where('id', '=', tx.workspaceId)
      .executeTakeFirstOrThrow();
    return todayIn(w.timezone);
  }

  // ---------------------------------------------------------------------------------------------
  // People, versions, references
  // ---------------------------------------------------------------------------------------------

  /** Display names of people for viewers who may see people (members); guests see none. */
  protected async peopleOf(
    tx: WorkspaceTransaction,
    p: Principal,
    ids: readonly string[],
  ): Promise<Map<string, { id: string; name: string; type: 'member' }>> {
    const unique = [...new Set(ids)];
    if (p.kind !== 'member' || !unique.length) return new Map();
    const rows = await sql<{ id: string; public_id: string; name: string }>`
      SELECT m.id, m.public_id, coalesce(m.display_name_override, a.display_name) AS name
        FROM tenancy.membership m JOIN identity.account a ON a.id = m.account_id
       WHERE m.id = ANY(${unique}::uuid[])`.execute(tx.db);
    return new Map(rows.rows.map((r) => [r.id, { id: r.public_id, name: r.name, type: 'member' as const }]));
  }

  protected async versionRow(
    tx: WorkspaceTransaction,
    documentId: string,
    number: number,
  ): Promise<VersionRow | undefined> {
    const row = await tx.db
      .selectFrom('knowledge.document_version')
      .selectAll()
      .where('document_id', '=', documentId)
      .where('number', '=', number)
      .executeTakeFirst();
    return row
      ? ({ ...row, number: Number(row.number), size_bytes: Number(row.size_bytes) } as unknown as VersionRow)
      : undefined;
  }

  /**
   * Every reference of a document, resolved for this viewer: a label and a path when the viewer
   * can read the target now, and nothing at all otherwise (IA-46). The result is keyed by
   * `kind:id`; a missing key is "Restricted item".
   */
  protected async docRefs(
    tx: WorkspaceTransaction,
    p: Principal,
    workspacePublicId: string,
    refs: readonly Ref[],
  ): Promise<Record<string, { kind: DocRefKind; id: string; label: string; path: string | null }>> {
    const out: Record<string, { kind: DocRefKind; id: string; label: string; path: string | null }> = {};
    if (!refs.length) return out;
    const by = (k: DocRefKind) => [...new Set(refs.filter((r) => r.kind === k).map((r) => r.id))];
    const recordIds = [...by('task'), ...by('project'), ...by('brand'), ...by('document')];
    if (recordIds.length) {
      const vis = await this.docVisibility(tx, p, true);
      const rows = await sql<{ public_id: string; record_type: string; title: string }>`
        SELECT r.public_id, r.record_type, COALESCE(t.title, w.name, kd.title, b.name) AS title
          FROM core.record r
          ${recordJoins}
          LEFT JOIN tenancy.brand b ON b.workspace_id = r.workspace_id AND b.id = r.id
         WHERE r.public_id = ANY(${recordIds}::text[])
           AND r.record_type IN ('task', 'project', 'brand', 'document')
           AND ${vis.where('r', { project: sql`COALESCE(t.project_id, w.id, kd.attached_project_id, kt.project_id)` })}`.execute(
        tx.db,
      );
      const seg: Record<string, string> = {
        task: 'tasks',
        project: 'projects',
        brand: 'brands',
        document: 'documents',
      };
      for (const r of rows.rows)
        out[`${r.record_type}:${r.public_id}`] = {
          kind: r.record_type as DocRefKind,
          id: r.public_id,
          label: r.title,
          path: `/workspaces/${workspacePublicId}/${seg[r.record_type]}/${r.public_id}`,
        };
    }
    if (p.kind === 'member') {
      const members = by('member');
      if (members.length) {
        const rows = await sql<{ public_id: string; state: string; name: string }>`
          SELECT m.public_id, m.state, coalesce(m.display_name_override, a.display_name) AS name
            FROM tenancy.membership m JOIN identity.account a ON a.id = m.account_id
           WHERE m.public_id = ANY(${members}::text[]) AND m.kind = 'member'`.execute(tx.db);
        for (const r of rows.rows)
          out[`member:${r.public_id}`] = {
            kind: 'member',
            id: r.public_id,
            label: r.state === 'active' ? r.name : 'Former member',
            path: null,
          };
      }
      const teams = by('team');
      if (teams.length) {
        const rows = await sql<{ public_id: string; name: string }>`
          SELECT r.public_id, t.name FROM tenancy.team t
            JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
           WHERE r.public_id = ANY(${teams}::text[]) AND t.lifecycle_state = 'active'`.execute(tx.db);
        for (const r of rows.rows)
          out[`team:${r.public_id}`] = { kind: 'team', id: r.public_id, label: r.name, path: null };
      }
    }
    return out;
  }

  protected async workspacePublicId(tx: WorkspaceTransaction): Promise<string> {
    const w = await tx.db
      .selectFrom('tenancy.workspace')
      .select('public_id')
      .where('id', '=', tx.workspaceId)
      .executeTakeFirstOrThrow();
    return w.public_id;
  }

  /** The AI-source status of the current version: the latest approval row, if it still applies. */
  protected async sourceStatus(
    tx: WorkspaceTransaction,
    p: Principal,
    d: LoadedDocument,
  ): Promise<{ approved: boolean; version: number | null; at: string | null; by: { id: string; name: string } | null }> {
    const last = await tx.db
      .selectFrom('knowledge.source_approval')
      .selectAll()
      .where('document_id', '=', d.id)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!last || last.kind !== 'approved' || Number(last.version_number) !== d.row.current_version_number)
      return { approved: false, version: null, at: null, by: null };
    const who = (await this.peopleOf(tx, p, [last.actor_membership_id])).get(last.actor_membership_id);
    return {
      approved: true,
      version: Number(last.version_number),
      at: iso(last.created_at),
      by: who ? { id: who.id, name: who.name } : null,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  /** The host a document is attached to, shown only to viewers who may read the host itself. */
  protected async attachmentOf(
    tx: WorkspaceTransaction,
    p: Principal,
    d: LoadedDocument,
  ): Promise<{ kind: AttachmentKind; id: string | null; title: string | null }> {
    const kind: AttachmentKind = d.row.attached_task_id
      ? 'task'
      : d.row.attached_project_id
        ? 'project'
        : d.brand
          ? 'brand'
          : 'workspace';
    if (kind === 'workspace' || kind === 'brand' || d.ownLevel === null)
      return { kind, id: null, title: null };
    const hostId = d.row.attached_task_id ?? d.row.attached_project_id!;
    const vis = await this.docVisibility(tx, p, true);
    const r = await sql<{ public_id: string; title: string }>`
      SELECT r.public_id, COALESCE(t.title, w.name) AS title FROM core.record r
        LEFT JOIN work.task t ON t.workspace_id = r.workspace_id AND t.id = r.id
        LEFT JOIN work.project w ON w.workspace_id = r.workspace_id AND w.id = r.id
       WHERE r.id = ${hostId}
         AND ${vis.where('r', { project: sql`COALESCE(t.project_id, w.id)` })}`.execute(tx.db);
    const host = r.rows[0];
    return host ? { kind, id: host.public_id, title: host.title } : { kind, id: null, title: null };
  }

  protected docCapabilities(p: Principal, d: LoadedDocument) {
    const own = d.ownLevel !== null;
    const active = d.lifecycleState === 'active';
    return {
      edit: active && this.docAllows(p, 'record.update', d),
      comment: this.docAllows(p, 'record.comment', d),
      suggest: active && this.docAllows(p, 'record.comment', d),
      follow: this.docAllows(p, 'record.follow', d),
      assign_owner: active && own && this.docAllows(p, 'record.assign', d, { shares: false }),
      create_page: active && own && this.docAllows(p, 'record.create', d, { shares: false }),
      move: active && own && this.docAllows(p, 'record.update', d, { shares: false }),
      archive: own && this.docAllows(p, 'record.archive', d, { shares: false }),
      trash: own && this.docAllows(p, 'record.trash', d, { shares: false }),
      share: own && this.docAllows(p, 'record.share', d, { shares: false }),
      export: this.docAllows(p, 'record.export', d),
      request_review: own && active && this.docAllows(p, 'review.request', d, { shares: false }),
      approve_source:
        own &&
        active &&
        (d.row.owner_membership_id === p.membershipId
          ? this.docAllows(p, 'record.update', d, { shares: false })
          : this.docAllows(p, 'record.share', d, { shares: false })),
    };
  }

  /** The document's full view for this viewer, with its current content. */
  protected async documentView(tx: WorkspaceTransaction, p: Principal, d: LoadedDocument) {
    const ws = await this.workspacePublicId(tx);
    const today = await this.workspaceToday(tx);
    const version = d.row.current_version_id
      ? await this.versionRow(tx, d.id, d.row.current_version_number)
      : undefined;
    const content: DocContent = version ? readContent(version.content) : { v: 2, blocks: [] };
    const refs = await tx.db
      .selectFrom('knowledge.document_reference')
      .select(['kind', 'target_kind', 'target_membership_id', 'target_team_id', 'target_record_id', 'target_record_type', 'block_id'])
      .where('document_id', '=', d.id)
      .execute();
    const wanted = await this.refsToResolve(tx, content, refs);
    const resolved = await this.docRefs(tx, p, ws, wanted.all);
    const own = d.ownLevel !== null;
    const ancestors = own && d.row.ancestor_ids.length ? await this.ancestorsOf(tx, p, d) : [];
    const people = await this.peopleOf(tx, p, [
      d.row.owner_membership_id,
      d.row.created_by_membership_id,
      ...(d.row.updated_by_membership_id ? [d.row.updated_by_membership_id] : []),
    ]);
    const childCount = own ? await this.readableChildCount(tx, p, d.id) : 0;
    const eff = effectiveState(d.row.state, d.row.review_due_on, today);
    return {
      id: d.publicId,
      type: 'document' as const,
      title: d.row.title,
      doc_type: d.row.doc_type,
      doc_type_label: DOC_TYPE_LABEL[d.row.doc_type],
      state: d.row.state,
      effective_state: eff,
      review_due_on: d.row.review_due_on,
      review_overdue: reviewOverdue(d.row.review_due_on, today),
      owner: people.get(d.row.owner_membership_id) ?? null,
      created_by: people.get(d.row.created_by_membership_id) ?? null,
      updated_by: d.row.updated_by_membership_id ? (people.get(d.row.updated_by_membership_id) ?? null) : null,
      brand: d.brandMarker,
      scope: d.brand ? ('brand' as const) : ('workspace' as const),
      attachment: await this.attachmentOf(tx, p, d),
      parent: own && d.row.parent_document_id ? (ancestors.at(-1) ?? null) : null,
      ancestors,
      depth: d.row.depth,
      children_count: childCount,
      lifecycle_state: d.lifecycleState,
      archived: d.lifecycleState === 'archived',
      version: d.row.version,
      content_version: d.row.current_version_number,
      content_hash: version?.content_hash ?? null,
      size_bytes: version?.size_bytes ?? 0,
      content: this.redact(d, content, resolved),
      references: resolved,
      links: wanted.links.flatMap((l) => {
        const hit = resolved[`${l.kind}:${l.id}`];
        return hit ? [hit] : [];
      }),
      links_restricted: wanted.links.filter((l) => !resolved[`${l.kind}:${l.id}`]).length,
      ai_source: await this.sourceStatus(tx, p, d),
      created_at: iso(d.row.created_at),
      updated_at: iso(d.row.updated_at),
      capabilities: this.docCapabilities(p, d),
    };
  }

  /** Reference targets of a document as `kind:id` public identifiers (content mentions and links). */
  protected async refsToResolve(
    tx: WorkspaceTransaction,
    content: DocContent,
    rows: ReadonlyArray<{
      kind: string;
      target_kind: string;
      target_membership_id: string | null;
      target_team_id: string | null;
      target_record_id: string | null;
      target_record_type: string | null;
    }>,
  ): Promise<{ all: Ref[]; links: Array<{ kind: DocRefKind; id: string }> }> {
    const all = new Map<string, Ref>();
    for (const b of content.blocks) {
      const runs =
        b.type === 'paragraph' || b.type === 'heading' || b.type === 'quote' || b.type === 'callout'
          ? [b.runs]
          : b.type === 'bulleted_list' || b.type === 'numbered_list'
            ? b.items
            : b.type === 'checklist'
              ? b.items.map((i) => i.runs)
              : [];
      for (const rs of runs)
        for (const r of rs)
          if (r.ref && !isRestrictedRef(r.ref)) all.set(`${r.ref.kind}:${r.ref.id}`, r.ref);
    }
    const links = rows.filter((r) => r.kind === 'link' && r.target_record_id);
    const ids = links.map((l) => l.target_record_id!);
    const publics = new Map(
      ids.length
        ? (
            await tx.db.selectFrom('core.record').select(['id', 'public_id']).where('id', 'in', ids).execute()
          ).map((r) => [r.id, r.public_id])
        : [],
    );
    const out: Array<{ kind: DocRefKind; id: string }> = [];
    for (const l of links) {
      const id = publics.get(l.target_record_id!);
      if (!id || !l.target_record_type) continue;
      const ref = { kind: l.target_record_type as DocRefKind, id };
      all.set(`${ref.kind}:${ref.id}`, ref);
      out.push(ref);
    }
    return { all: [...all.values()], links: out };
  }

  /** Ancestors, root first, only for a reader through ownership (they share the placement). */
  protected async ancestorsOf(tx: WorkspaceTransaction, p: Principal, d: LoadedDocument) {
    if (!d.row.ancestor_ids.length) return [];
    const rows = await sql<{ id: string; public_id: string; title: string }>`
      SELECT d.id, r.public_id, d.title FROM knowledge.document d
        JOIN core.record r ON r.workspace_id = d.workspace_id AND r.id = d.id
       WHERE d.id = ANY(${d.row.ancestor_ids}::uuid[]) AND r.lifecycle_state IN ('active', 'archived')`.execute(
      tx.db,
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    void p;
    return d.row.ancestor_ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [{ id: r.public_id, title: r.title }] : [];
    });
  }

  protected async readableChildCount(tx: WorkspaceTransaction, p: Principal, id: string): Promise<number> {
    const vis = await this.docVisibility(tx, p, false);
    const r = await sql<{ n: string }>`
      SELECT count(*) AS n FROM core.record r
        JOIN knowledge.document d ON d.workspace_id = r.workspace_id AND d.id = r.id
        LEFT JOIN work.task kt ON kt.workspace_id = d.workspace_id AND kt.id = d.attached_task_id
       WHERE d.parent_document_id = ${id}
         AND ${vis.where('r', { project: sql`COALESCE(d.attached_project_id, kt.project_id)` })}`.execute(tx.db);
    return Number(r.rows[0]?.n ?? 0);
  }

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  protected async kTrack<T>(
    action: string,
    metric: 'knowledge.documents' | 'knowledge.versions' | 'knowledge.suggestions' | 'knowledge.references',
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const out = await fn();
      this.d.metrics.count(metric, 1, { action, outcome: 'ok' });
      return out;
    } catch (err) {
      this.d.metrics.count(metric, 1, {
        action,
        outcome: err instanceof TenancyError ? err.code : 'error',
      });
      throw err;
    }
  }

  async getDocument(caller: Caller, ws: unknown, doc: unknown) {
    return this.kTrack('read', 'knowledge.documents', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const d = await this.loadDocument(tx, p, doc);
        return this.documentView(tx, p, d);
      }),
    );
  }

  /** A listing row: metadata only, no content. */
  protected docSummary(
    row: {
      public_id: string;
      title: string;
      doc_type: DocType;
      state: DocState;
      review_due_on: string | null;
      lifecycle_state: string;
      brand_id: string | null;
      depth: number;
      parent_public: string | null;
      owner_membership_id: string;
      updated_at: Date;
      current_version_number: number;
      attached: AttachmentKind;
      children: number;
    },
    today: string,
    people: Map<string, { id: string; name: string; type: 'member' }>,
    brands: Map<string, ReturnType<typeof brandMarker>>,
    attachedTitles: Map<string, { id: string; title: string }>,
  ) {
    return {
      id: row.public_id,
      type: 'document' as const,
      title: row.title,
      doc_type: row.doc_type,
      doc_type_label: DOC_TYPE_LABEL[row.doc_type],
      state: row.state,
      effective_state: effectiveState(row.state, toDate(row.review_due_on), today),
      review_due_on: toDate(row.review_due_on),
      review_overdue: reviewOverdue(toDate(row.review_due_on), today),
      owner: people.get(row.owner_membership_id) ?? null,
      brand: row.brand_id ? (brands.get(row.brand_id) ?? null) : null,
      scope: row.brand_id ? ('brand' as const) : ('workspace' as const),
      attachment: { kind: row.attached, ...(attachedTitles.get(row.public_id) ?? { id: null, title: null }) },
      parent_id: row.parent_public,
      depth: Number(row.depth),
      has_children: row.children > 0,
      content_version: Number(row.current_version_number),
      archived: row.lifecycle_state === 'archived',
      updated_at: iso(row.updated_at),
    };
  }

  async listDocuments(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const q = parseDocumentList(query, this.ws.notifySearchQueryMax);
    return this.kTrack('list', 'knowledge.documents', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => this.listInTx(tx, p, q)),
    );
  }

  protected async listInTx(tx: WorkspaceTransaction, p: Principal, q: DocumentListQuery) {
    const limit = this.pageLimit(q.limit);
    const vis = await this.docVisibility(tx, p, q.archived);
    const today = await this.workspaceToday(tx);
    const where = [] as ReturnType<typeof sql>[];
    let scopeKey = 'all';
    if (q.scope === 'workspace') where.push(sql`d.brand_id IS NULL`);
    else if (q.scope !== 'all') {
      const { findBrand } = await import('@pm/tenancy');
      const b = await findBrand(tx, p, q.scope);
      where.push(sql`d.brand_id = ${b.id}`);
      scopeKey = b.id;
    }
    if (q.project) {
      const pr = await this.loadProject(tx, p, q.project);
      where.push(sql`(d.attached_project_id = ${pr.id} OR kt.project_id = ${pr.id})`);
    }
    if (q.task) {
      const t = await this.loadTask(tx, p, q.task);
      where.push(sql`d.attached_task_id = ${t.id}`);
    }
    let rankOrder = false;
    if (q.parent === 'root') {
      where.push(sql`d.parent_document_id IS NULL`);
      rankOrder = true;
    } else if (q.parent) {
      const parent = await this.loadDocument(tx, p, q.parent);
      if (parent.ownLevel === null) throw new TenancyError('not_found');
      where.push(sql`d.parent_document_id = ${parent.id}`);
      rankOrder = true;
    }
    if (q.attached === 'none') where.push(sql`d.attached_project_id IS NULL AND d.attached_task_id IS NULL`);
    if (q.type) where.push(sql`d.doc_type = ${q.type}`);
    if (q.state === 'draft') where.push(sql`d.state = 'draft'`);
    else if (q.state === 'stale')
      where.push(sql`(d.state = 'stale' OR (d.state = 'current' AND d.review_due_on < ${today}::date))`);
    else if (q.state === 'current')
      where.push(sql`(d.state = 'current' AND (d.review_due_on IS NULL OR d.review_due_on >= ${today}::date))`);
    else if (q.state === 'overdue') where.push(sql`(d.review_due_on IS NOT NULL AND d.review_due_on < ${today}::date)`);
    if (q.owner) {
      const m = await tx.db
        .selectFrom('tenancy.membership')
        .select('id')
        .where('public_id', '=', q.owner)
        .executeTakeFirst();
      where.push(sql`d.owner_membership_id = ${m?.id ?? NIL_ID}`);
    }
    if (q.q) {
      const like = `%${q.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(sql`lower(d.title) LIKE ${like} ESCAPE '\\'`);
    }
    const fp = this.docFp('documents', rankOrder, scopeKey, q.project, q.task, q.parent, q.attached, q.type, q.state, q.owner, q.q, q.archived);
    const after = q.cursor !== undefined ? this.openPos(p, fp, q.cursor) : null;
    const cond = where.length ? sql.join(where, sql` AND `) : sql`true`;
    const order = rankOrder
      ? sql`ORDER BY d.rank COLLATE "C", d.id`
      : sql`ORDER BY d.updated_at DESC, d.id DESC`;
    const seek = !after
      ? sql``
      : rankOrder
        ? sql`AND (d.rank COLLATE "C", d.id) > (${after.k} COLLATE "C", ${after.id}::uuid)`
        : sql`AND (d.updated_at, d.id) < (${after.k}::timestamptz, ${after.id}::uuid)`;
    const rows = (
      await sql<{
        id: string;
        public_id: string;
        title: string;
        doc_type: DocType;
        state: DocState;
        review_due_on: string | null;
        lifecycle_state: string;
        brand_id: string | null;
        depth: number;
        owner_membership_id: string;
        updated_at: Date;
        current_version_number: number;
        rank: string;
        parent_document_id: string | null;
        attached_project_id: string | null;
        attached_task_id: string | null;
        sort_key: string;
      }>`
        SELECT d.id, r.public_id, d.title, d.doc_type, d.state, d.review_due_on::text AS review_due_on, d.lifecycle_state::text AS lifecycle_state,
               d.brand_id, d.depth, d.owner_membership_id, d.updated_at, d.current_version_number, d.rank,
               d.parent_document_id, d.attached_project_id, d.attached_task_id,
               ${rankOrder ? sql`d.rank` : sql`to_char(d.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')`} AS sort_key
          FROM core.record r
          JOIN knowledge.document d ON d.workspace_id = r.workspace_id AND d.id = r.id
          LEFT JOIN work.task kt ON kt.workspace_id = d.workspace_id AND kt.id = d.attached_task_id
         WHERE ${cond} ${seek}
           AND ${vis.where('r', { project: sql`COALESCE(d.attached_project_id, kt.project_id)` })}
         ${order} LIMIT ${limit + 1}`.execute(tx.db)
    ).rows;
    const page = rows.slice(0, limit);
    const ids = page.map((r) => r.id);
    const parents = new Map(
      page.some((r) => r.parent_document_id)
        ? (
            await tx.db
              .selectFrom('core.record')
              .select(['id', 'public_id'])
              .where('id', 'in', page.flatMap((r) => (r.parent_document_id ? [r.parent_document_id] : [])))
              .execute()
          ).map((r) => [r.id, r.public_id])
        : [],
    );
    const people = await this.peopleOf(tx, p, page.map((r) => r.owner_membership_id));
    const brandIds = [...new Set(page.flatMap((r) => (r.brand_id ? [r.brand_id] : [])))];
    const brands = new Map<string, ReturnType<typeof brandMarker>>();
    for (const b of brandIds) brands.set(b, (await this.brandFactsOf(tx, b)).marker);
    const counts = new Map<string, number>();
    if (ids.length) {
      const c = await sql<{ parent: string; n: string }>`
        SELECT d.parent_document_id AS parent, count(*) AS n FROM core.record r
          JOIN knowledge.document d ON d.workspace_id = r.workspace_id AND d.id = r.id
          LEFT JOIN work.task kt ON kt.workspace_id = d.workspace_id AND kt.id = d.attached_task_id
         WHERE d.parent_document_id = ANY(${ids}::uuid[])
           AND ${vis.where('r', { project: sql`COALESCE(d.attached_project_id, kt.project_id)` })}
         GROUP BY d.parent_document_id`.execute(tx.db);
      for (const r of c.rows) counts.set(r.parent, Number(r.n));
    }
    // Attached host titles are shown only for hosts the viewer reads (never through a share).
    const attachedTitles = new Map<string, { id: string; title: string }>();
    const hostIds = [...new Set(page.flatMap((r) => [r.attached_project_id, r.attached_task_id].filter((x): x is string => !!x)))];
    if (hostIds.length) {
      const hosts = await sql<{ id: string; public_id: string; title: string }>`
        SELECT r.id, r.public_id, COALESCE(t.title, w.name) AS title FROM core.record r
          LEFT JOIN work.task t ON t.workspace_id = r.workspace_id AND t.id = r.id
          LEFT JOIN work.project w ON w.workspace_id = r.workspace_id AND w.id = r.id
         WHERE r.id = ANY(${hostIds}::uuid[])
           AND ${vis.where('r', { project: sql`COALESCE(t.project_id, w.id)` })}`.execute(tx.db);
      const byId = new Map(hosts.rows.map((h) => [h.id, h]));
      for (const r of page) {
        const h = byId.get(r.attached_task_id ?? r.attached_project_id ?? '');
        if (h) attachedTitles.set(r.public_id, { id: h.public_id, title: h.title });
      }
    }
    const last = page.at(-1);
    return {
      data: page.map((r) =>
        this.docSummary(
          {
            ...r,
            parent_public: r.parent_document_id ? (parents.get(r.parent_document_id) ?? null) : null,
            attached: r.attached_task_id ? 'task' : r.attached_project_id ? 'project' : r.brand_id ? 'brand' : 'workspace',
            children: counts.get(r.id) ?? 0,
          },
          today,
          people,
          brands,
          attachedTitles,
        ),
      ),
      page: {
        limit,
        has_more: rows.length > limit,
        ...(rows.length > limit && last
          ? { next_cursor: this.sealPos(p, fp, { k: last.sort_key, id: last.id }) }
          : {}),
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Versions
  // ---------------------------------------------------------------------------------------------

  async listVersions(caller: Caller, ws: unknown, doc: unknown, query: Record<string, unknown>) {
    return this.kTrack('list', 'knowledge.versions', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const d = await this.loadDocument(tx, p, doc);
        const limit = this.pageLimit(query.limit);
        const fp = this.docFp('versions', d.id);
        const after = query.cursor !== undefined ? this.openPos(p, fp, query.cursor) : null;
        const rows = await tx.db
          .selectFrom('knowledge.document_version')
          .select([
            'id',
            'number',
            'title',
            'content_hash',
            'size_bytes',
            'kind',
            'restored_from_number',
            'template_key',
            'change_summary',
            'created_by_membership_id',
            'created_at',
          ])
          .where('document_id', '=', d.id)
          .$if(!!after, (qb) => qb.where('number', '<', Number(after!.k)))
          .orderBy('number', 'desc')
          .limit(limit + 1)
          .execute();
        const page = rows.slice(0, limit);
        const people = await this.peopleOf(tx, p, page.map((r) => r.created_by_membership_id));
        const approved = await this.approvedVersions(tx, d.id);
        const last = page.at(-1);
        return {
          data: page.map((r) => ({
            number: Number(r.number),
            type: 'document_version' as const,
            title: r.title,
            kind: r.kind,
            restored_from: r.restored_from_number,
            template: r.template_key,
            summary: r.change_summary,
            size_bytes: Number(r.size_bytes),
            hash: r.content_hash,
            current: Number(r.number) === d.row.current_version_number,
            ai_source: approved.has(Number(r.number)),
            by: people.get(r.created_by_membership_id) ?? null,
            at: iso(r.created_at),
          })),
          page: {
            limit,
            has_more: rows.length > limit,
            ...(rows.length > limit && last
              ? { next_cursor: this.sealPos(p, fp, { k: String(last.number), id: d.id }) }
              : {}),
          },
        };
      }),
    );
  }

  /** Versions whose latest approval row says approved (the latest row per document decides). */
  protected async approvedVersions(tx: WorkspaceTransaction, documentId: string): Promise<Set<number>> {
    const last = await tx.db
      .selectFrom('knowledge.source_approval')
      .select(['kind', 'version_number'])
      .where('document_id', '=', documentId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return new Set(last && last.kind === 'approved' ? [Number(last.version_number)] : []);
  }

  async getVersion(caller: Caller, ws: unknown, doc: unknown, number: unknown) {
    const n = typeof number === 'number' ? number : parseVersionNumber(number);
    return this.kTrack('read', 'knowledge.versions', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const d = await this.loadDocument(tx, p, doc);
        const row = n === null ? undefined : await this.versionRow(tx, d.id, n);
        if (!row) throw new TenancyError('not_found');
        const people = await this.peopleOf(tx, p, [row.created_by_membership_id]);
        const content = readContent(row.content);
        const ws0 = await this.workspacePublicId(tx);
        const wanted = await this.refsToResolve(tx, content, []);
        const references = await this.docRefs(tx, p, ws0, wanted.all);
        return {
          number: row.number,
          type: 'document_version' as const,
          document: d.publicId,
          title: row.title,
          kind: row.kind,
          restored_from: row.restored_from_number,
          template: row.template_key,
          summary: row.change_summary,
          size_bytes: row.size_bytes,
          hash: row.content_hash,
          current: row.number === d.row.current_version_number,
          by: people.get(row.created_by_membership_id) ?? null,
          at: iso(row.created_at),
          content: this.redact(d, content, references),
          references,
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Backlinks (DOC-008): the documents that name a record, as far as the viewer can read both
  // ---------------------------------------------------------------------------------------------

  async backlinks(caller: Caller, ws: unknown, rec: unknown, query: Record<string, unknown>) {
    return this.kTrack('backlinks', 'knowledge.references', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const prefix = (['task', 'project', 'brand', 'document'] as const).find((k) => isPublic(rec, DOC_REF_PREFIX[k]));
        if (!prefix) throw new TenancyError('not_found');
        const vis = await this.docVisibility(tx, p, true);
        // The target must itself be readable: nothing is revealed about who links to a hidden record.
        const target = await sql<{ id: string }>`
          SELECT r.id FROM core.record r ${recordJoins}
           WHERE r.public_id = ${rec as string}
             AND ${vis.where('r', { project: sql`COALESCE(t.project_id, w.id, kd.attached_project_id, kt.project_id)` })}`.execute(tx.db);
        if (!target.rows[0]) {
          await this.docVisibility(tx, p, true);
          throw new TenancyError('not_found');
        }
        const limit = this.pageLimit(query.limit);
        const fp = this.docFp('backlinks', target.rows[0].id);
        const after = query.cursor !== undefined ? this.openPos(p, fp, query.cursor) : null;
        const rows = await sql<{ id: string; public_id: string; title: string; kind: string; sort_key: string; doc_type: string; state: string }>`
          SELECT DISTINCT ON (d.updated_at, d.id) d.id, r.public_id, d.title, ref.kind, d.doc_type, d.state,
                 to_char(d.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS sort_key
            FROM knowledge.document_reference ref
            JOIN knowledge.document d ON d.workspace_id = ref.workspace_id AND d.id = ref.document_id
            JOIN core.record r ON r.workspace_id = d.workspace_id AND r.id = d.id
            LEFT JOIN work.task kt ON kt.workspace_id = d.workspace_id AND kt.id = d.attached_task_id
           WHERE ref.target_record_id = ${target.rows[0].id}
             AND ${vis.where('r', { project: sql`COALESCE(d.attached_project_id, kt.project_id)` })}
             ${after ? sql`AND (d.updated_at, d.id) < (${after.k}::timestamptz, ${after.id}::uuid)` : sql``}
           ORDER BY d.updated_at DESC, d.id DESC LIMIT ${limit + 1}`.execute(tx.db);
        const page = rows.rows.slice(0, limit);
        const last = page.at(-1);
        return {
          data: page.map((r) => ({
            id: r.public_id,
            type: 'document' as const,
            title: r.title,
            doc_type: r.doc_type,
            state: r.state,
            via: r.kind,
          })),
          page: {
            limit,
            has_more: rows.rows.length > limit,
            ...(rows.rows.length > limit && last
              ? { next_cursor: this.sealPos(p, fp, { k: last.sort_key, id: last.id }) }
              : {}),
          },
        };
      }),
    );
  }

  protected invalidRef(pointer: string) {
    return invalid(issue(pointer, 'not_linkable', "That can't be linked here."));
  }

  protected docInvalid(pointer: string, code: string, message: string) {
    return invalid(issue(pointer, code, message));
  }

  protected static nilDoc = NIL_DOC;
}
