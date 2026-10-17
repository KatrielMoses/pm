import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  compilePrincipal,
  decideBrand,
  decideWorkspace,
  findBrand,
  invalid,
  issue,
  parseIfMatch,
  recordLevel,
  requireVersion,
  TenancyError,
  levelRank,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { bumpEpoch } from '@pm/tenancy';
import {
  DOC_REF_PREFIX,
  changeSummary,
  collectRefs,
  contentBytes,
  documentContentHash,
  htmlBody,
  parseContent,
  readContent,
  sha256,
  toHtml,
  toMarkdown,
  type DocContent,
  type ExportNote,
  type FoundRef,
  type Ref,
  type DocRefResolver,
} from './content.ts';
import { DocumentCore, type LoadedDocument } from './document-core.ts';
import {
  DOC_TYPE_LABEL,
  addReviewDays,
  createsCycle,
  defaultTitle,
  placementError,
  starterContent,
  templateKey,
  type DocType,
} from './semantics.ts';
import {
  parseContentSave,
  parseDocumentCreate,
  parseDocumentPatch,
  parseExportQuery,
  parseLinks,
  parseMove,
  parseRestore,
  type DocumentCreate,
} from './validation.ts';

const hashText = (s: string) => sha256(s);
const NIL_MEMBER = '00000000-0000-7000-8000-000000000000';

interface Placement {
  brandId: string | null;
  brand: LoadedDocument['brand'];
  projectId: string | null;
  taskId: string | null;
  parent: LoadedDocument | null;
  scopeKey: string;
}

/**
 * Phase 4C documents, part two: creation, saving, restoring, state and ownership, placement,
 * links, lifecycle, and export (ADR-0025). Every command is one workspace transaction with
 * idempotency, audit (hashes of content, never content), and outbox events. Nothing is saved over
 * a newer version, and nothing the author could not read is linked in their name.
 */
export class DocumentService extends DocumentCore {
  // ---------------------------------------------------------------------------------------------
  // Placement and ownership checks
  // ---------------------------------------------------------------------------------------------

  protected async resolvePlacement(
    tx: WorkspaceTransaction,
    p: Principal,
    input: DocumentCreate,
  ): Promise<Placement> {
    if (input.parent) {
      const parent = await this.loadDocument(tx, p, input.parent, { lock: true });
      this.requireDocActive(parent);
      this.requireDocAction(p, 'record.create', parent, { shares: false });
      if (parent.row.depth + 1 > this.ws.documentDepthMax)
        throw invalid(
          issue('/parent', 'depth_exceeded', `Pages can be nested at most ${this.ws.documentDepthMax} levels deep.`),
        );
      const root = parent.row.ancestor_ids[0] ?? parent.id;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${root}::text, 43))`.execute(tx.db);
      const kids = await tx.db
        .selectFrom('knowledge.document')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('parent_document_id', '=', parent.id)
        .where('lifecycle_state', '<>', 'purged')
        .executeTakeFirstOrThrow();
      if (Number(kids.n) >= this.ws.documentChildrenMax)
        throw invalid(
          issue('/parent', 'too_many', `A page can have at most ${this.ws.documentChildrenMax} subpages.`),
        );
      await this.requireTreeRoom(tx, root, 1);
      return {
        brandId: parent.brand?.id ?? null,
        brand: parent.brand,
        projectId: parent.row.attached_project_id,
        taskId: parent.row.attached_task_id,
        parent,
        scopeKey: parent.row.scope_key,
      };
    }
    if (input.task) {
      const t = await this.loadTask(tx, p, input.task, { lock: true });
      this.requireTaskAction(p, 'record.create', t, { shares: false });
      this.requireTaskActive(t);
      if (input.brand && input.brand !== t.brand.publicId)
        throw invalid(issue('/brand', 'cross_brand', "Leave out the brand: a task's documents live in its brand."));
      return { brandId: t.brand.id, brand: t.brand, projectId: null, taskId: t.id, parent: null, scopeKey: t.brand.id };
    }
    if (input.project) {
      const pr = await this.loadProject(tx, p, input.project, { lock: true });
      this.requireActive(pr);
      this.requireCreateIn(p, { brand: pr.brand, project: pr, chain: pr.chain });
      if (input.brand && input.brand !== pr.brand.publicId)
        throw invalid(issue('/brand', 'cross_brand', "Leave out the brand: a project's documents live in its brand."));
      return { brandId: pr.brand.id, brand: { ...pr.brand, timezone: 'UTC' }, projectId: pr.id, taskId: null, parent: null, scopeKey: pr.brand.id };
    }
    if (input.brand) {
      const b = await findBrand(tx, p, input.brand);
      const facts = { id: b.id, isSensitive: b.is_sensitive, lifecycleState: b.lifecycle_state };
      const o = decideBrand(p, 'record.create', { ...facts, lifecycleState: 'active' });
      this.decision('record.create', o);
      if (!o.allowed) throw new TenancyError(o.code);
      if (b.lifecycle_state !== 'active')
        throw new TenancyError('conflict', { issues: [issue('/brand', 'brand_archived', 'This brand is archived.')] });
      return {
        brandId: b.id,
        brand: { ...facts, publicId: b.public_id, name: b.name, timezone: b.timezone },
        projectId: null,
        taskId: null,
        parent: null,
        scopeKey: b.id,
      };
    }
    const o = decideWorkspace(p, 'record.create');
    this.decision('record.create', o);
    if (!o.allowed) throw new TenancyError(o.code);
    return { brandId: null, brand: null, projectId: null, taskId: null, parent: null, scopeKey: tx.workspaceId };
  }

  /** At most `DOCUMENT_TREE_MAX` live pages per tree (the root counts). */
  protected async requireTreeRoom(tx: WorkspaceTransaction, rootId: string, adding: number) {
    const n = await sql<{ n: string }>`
      SELECT count(*) AS n FROM knowledge.document
       WHERE workspace_id = ${tx.workspaceId} AND lifecycle_state <> 'purged'
         AND (id = ${rootId}::uuid OR ${rootId}::uuid = ANY(ancestor_ids))`.execute(tx.db);
    if (Number(n.rows[0]?.n ?? 0) + adding > this.ws.documentTreeMax)
      throw invalid(
        issue('/parent', 'too_many', `A page tree can hold at most ${this.ws.documentTreeMax} pages.`),
      );
  }

  /** Whether `membershipId` can edit a document placed here (an owner must be able to). */
  protected async canEditHere(
    tx: WorkspaceTransaction,
    membershipId: string,
    where: { brand: LoadedDocument['brand']; chain: LoadedDocument['chain'] },
  ): Promise<boolean> {
    const m = await tx.db
      .selectFrom('tenancy.membership')
      .select(['id', 'account_id', 'kind'])
      .where('id', '=', membershipId)
      .where('state', '=', 'active')
      .executeTakeFirst();
    if (!m || m.kind !== 'member') return false;
    const mp = await compilePrincipal(tx, m.id, m.account_id, 'member');
    const lv = recordLevel(mp, {
      brand: where.brand,
      lifecycleState: 'active',
      shareLevel: null,
      projectChain: where.chain,
    });
    return lv !== null && levelRank(lv) >= levelRank('edit');
  }

  /**
   * References new to a document must exist and be readable by the person saving (hidden, unknown,
   * and unsupported targets share one issue). References already part of the document stay, whoever
   * saves, so an editor who cannot read a link never breaks it.
   */
  protected async checkNewRefs(
    tx: WorkspaceTransaction,
    p: Principal,
    d: LoadedDocument | null,
    refs: readonly Ref[],
    trusted: 'none' | 'present',
  ): Promise<void> {
    if (!refs.length) return;
    const present = new Set<string>();
    if (d && trusted === 'present') {
      const rows = await tx.db
        .selectFrom('knowledge.document_reference as ref')
        .leftJoin('core.record as r', (j) =>
          j.onRef('r.workspace_id', '=', 'ref.workspace_id').onRef('r.id', '=', 'ref.target_record_id'),
        )
        .leftJoin('tenancy.membership as m', (j) =>
          j.onRef('m.workspace_id', '=', 'ref.workspace_id').onRef('m.id', '=', 'ref.target_membership_id'),
        )
        .leftJoin('core.record as tr', (j) =>
          j.onRef('tr.workspace_id', '=', 'ref.workspace_id').onRef('tr.id', '=', 'ref.target_team_id'),
        )
        .select(['ref.target_kind', 'ref.target_record_type', 'r.public_id as record_public', 'm.public_id as member_public', 'tr.public_id as team_public'])
        .where('ref.document_id', '=', d.id)
        .execute();
      for (const r of rows)
        present.add(
          r.target_kind === 'member'
            ? `member:${r.member_public}`
            : r.target_kind === 'team'
              ? `team:${r.team_public}`
              : `${r.target_record_type}:${r.record_public}`,
        );
    }
    const fresh = refs.filter((r) => !present.has(`${r.kind}:${r.id}`));
    if (!fresh.length) return;
    const ws = await this.workspacePublicId(tx);
    const seen = await this.docRefs(tx, p, ws, fresh);
    for (const r of fresh)
      if (!seen[`${r.kind}:${r.id}`])
        throw this.invalidRef(`/content/references/${r.kind}`);
  }

  /**
   * A file embed must name an active file attached to this document (4D). Embeds already in the
   * previous content stay, so a file that was trashed later never blocks an unrelated save.
   */
  protected async checkFileEmbeds(
    tx: WorkspaceTransaction,
    d: LoadedDocument,
    next: DocContent,
    prev: DocContent | null,
  ): Promise<void> {
    const had = new Set(prev ? this.fileEmbedIds(prev) : []);
    const fresh = this.fileEmbedIds(next).filter((id) => !had.has(id));
    if (!fresh.length) return;
    const found = await this.embeddedFiles(tx, d, {
      v: 2,
      blocks: next.blocks.filter((b) => b.type === 'embed' && b.kind === 'file' && fresh.includes(b.url)),
    });
    if (fresh.some((id) => !found[id]))
      throw invalid(
        issue('/content', 'invalid_file', 'Embed only files that are attached to this document.'),
      );
  }

  /** Replaces the mention rows of the current content; returns the member mentions that are new. */
  protected async syncReferences(
    tx: WorkspaceTransaction,
    d: LoadedDocument,
    found: readonly FoundRef[],
  ): Promise<Array<{ id: string; block: string }>> {
    const prior = await tx.db
      .selectFrom('knowledge.document_reference')
      .select(['target_membership_id'])
      .where('document_id', '=', d.id)
      .where('kind', '=', 'mention')
      .where('target_kind', '=', 'member')
      .execute();
    const had = new Set(prior.map((r) => r.target_membership_id));
    await tx.db
      .deleteFrom('knowledge.document_reference')
      .where('document_id', '=', d.id)
      .where('kind', '=', 'mention')
      .execute();
    const added: Array<{ id: string; block: string }> = [];
    if (!found.length) return added;
    const memberIds = found.filter((f) => f.kind === 'member').map((f) => f.id);
    const teamIds = found.filter((f) => f.kind === 'team').map((f) => f.id);
    const recordIds = found.filter((f) => f.kind !== 'member' && f.kind !== 'team').map((f) => f.id);
    const members = new Map(
      memberIds.length
        ? (
            await tx.db
              .selectFrom('tenancy.membership')
              .select(['id', 'public_id'])
              .where('public_id', 'in', memberIds)
              .where('kind', '=', 'member')
              .execute()
          ).map((m) => [m.public_id, m.id])
        : [],
    );
    const teams = new Map(
      teamIds.length
        ? (
            await tx.db
              .selectFrom('core.record')
              .select(['id', 'public_id'])
              .where('public_id', 'in', teamIds)
              .where('record_type', '=', 'team')
              .execute()
          ).map((t) => [t.public_id, t.id])
        : [],
    );
    const records = new Map(
      recordIds.length
        ? (
            await tx.db
              .selectFrom('core.record')
              .select(['id', 'public_id', 'record_type'])
              .where('public_id', 'in', recordIds)
              .where('record_type', 'in', ['task', 'project', 'brand', 'document'])
              .where('lifecycle_state', 'in', ['active', 'archived'])
              .execute()
          ).map((r) => [r.public_id, r])
        : [],
    );
    for (const f of found) {
      const base = {
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        document_id: d.id,
        block_id: f.blockId,
        position: Math.min(f.position, 32000),
        kind: 'mention' as const,
      };
      if (f.kind === 'member') {
        const id = members.get(f.id);
        if (!id) continue;
        await tx.db
          .insertInto('knowledge.document_reference')
          .values({ ...base, target_kind: 'member', target_membership_id: id, target_team_id: null, target_record_id: null, target_record_type: null })
          .execute();
        if (!had.has(id)) added.push({ id: base.id, block: f.blockId });
      } else if (f.kind === 'team') {
        const id = teams.get(f.id);
        if (!id) continue;
        await tx.db
          .insertInto('knowledge.document_reference')
          .values({ ...base, target_kind: 'team', target_membership_id: null, target_team_id: id, target_record_id: null, target_record_type: null })
          .execute();
      } else {
        const r = records.get(f.id);
        if (!r) continue;
        await tx.db
          .insertInto('knowledge.document_reference')
          .values({
            ...base,
            target_kind: 'record',
            target_membership_id: null,
            target_team_id: null,
            target_record_id: r.id,
            target_record_type: r.record_type as 'task' | 'project' | 'brand' | 'document',
          })
          .execute();
      }
    }
    return added;
  }

  protected async docAudit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    d: LoadedDocument,
    changes: ReturnType<typeof change.plain>[],
  ) {
    return this.workAudit(tx, caller, p, action, { recordId: d.id, type: 'document', publicId: d.publicId }, changes, d.brand?.id ?? null);
  }

  protected async docEvent(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    type:
      | 'knowledge.document.created'
      | 'knowledge.document.version_saved'
      | 'knowledge.document.updated'
      | 'knowledge.document.mention_added',
    d: LoadedDocument,
    data: Record<string, string | number | boolean | null>,
    sequence: number,
  ) {
    await this.workEvent(tx, caller, p, type, { type: 'knowledge.document', id: d.id, sequence }, data, d.brand?.id ?? null);
  }

  protected async docLimit(p: Principal): Promise<void> {
    const r = await this.c.limiter.consume('document.save' as never, p.membershipId);
    if (!r.allowed) throw new TenancyError('rate_limited', { retryAfterSeconds: r.retryAfterSeconds });
  }

  protected async bumpDoc(tx: WorkspaceTransaction, d: LoadedDocument, p: Principal, set: Record<string, unknown>) {
    await tx.db
      .updateTable('knowledge.document')
      .set({
        ...set,
        updated_at: new Date(),
        updated_by_membership_id: p.membershipId,
        version: d.row.version + 1,
      })
      .where('id', '=', d.id)
      .execute();
    await tx.db.updateTable('core.record').set({ version: sql`version + 1` }).where('id', '=', d.id).execute();
  }

  /** Appends the next version, and moves the document's pointer to it. */
  protected async appendVersion(
    tx: WorkspaceTransaction,
    p: Principal,
    d: LoadedDocument,
    v: {
      title: string;
      content: DocContent;
      hash: string;
      bytes: number;
      kind: 'save' | 'restore' | 'suggestion' | 'template';
      restoredFrom?: number;
      template?: string;
      prev: DocContent | null;
    },
  ): Promise<{ id: string; number: number; summary: Record<string, number> }> {
    if (d.row.current_version_number >= this.ws.documentVersionsMax)
      throw invalid(
        issue('/', 'too_many', `A document can keep at most ${this.ws.documentVersionsMax} versions.`),
      );
    const number = d.row.current_version_number + 1;
    const id = newUuidV7();
    const summary = changeSummary(v.prev, v.content);
    await tx.db
      .insertInto('knowledge.document_version')
      .values({
        id,
        public_id: newPublicId('dcv'),
        workspace_id: tx.workspaceId,
        document_id: d.id,
        number,
        title: v.title,
        content: JSON.stringify(v.content),
        content_hash: v.hash,
        size_bytes: Math.max(1, v.bytes),
        kind: v.kind,
        restored_from_number: v.restoredFrom ?? null,
        template_key: v.template ?? null,
        change_summary: JSON.stringify(summary),
        created_by_membership_id: p.membershipId,
      })
      .execute();
    return { id, number, summary };
  }

  protected async currentContent(tx: WorkspaceTransaction, d: LoadedDocument) {
    const row = d.row.current_version_id ? await this.versionRow(tx, d.id, d.row.current_version_number) : undefined;
    return row ? { content: readContent(row.content), hash: row.content_hash, title: row.title } : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Live drafts (4D, ADR-0027 C3 and C4)
  // ---------------------------------------------------------------------------------------------

  protected async draftOf(tx: WorkspaceTransaction, documentId: string, lock = false) {
    const q = tx.db.selectFrom('knowledge.edit_draft').selectAll().where('document_id', '=', documentId);
    return (lock ? q.forUpdate() : q).executeTakeFirst();
  }

  /** Editing sessions of anyone that have not expired (stale ones and watchers never count). */
  protected async liveSessionCount(tx: WorkspaceTransaction, documentId: string): Promise<number> {
    const r = await sql<{ n: string }>`
      SELECT count(*) AS n FROM knowledge.edit_session
       WHERE document_id = ${documentId} AND mode = 'edit' AND expires_at > now()`.execute(tx.db);
    return Number(r.rows[0]?.n ?? 0);
  }

  /**
   * Turns the live draft into one ordinary version (the same path as a save: canonical content,
   * references, audit, events, mentions). Nothing happens when the draft holds nothing new. The
   * person who triggers the checkpoint is its author; the audit counts the contributors.
   */
  protected async checkpointDraft(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    d: LoadedDocument,
    why: 'save' | 'leave' | 'recovery',
  ): Promise<LoadedDocument> {
    const dr = await this.draftOf(tx, d.id, true);
    if (!dr || !dr.dirty) return d;
    const content = readContent(dr.content);
    const hash = documentContentHash(content);
    const cur = await this.currentContent(tx, d);
    const seq = Number(dr.seq);
    const clean = async (version: number) => {
      await tx.db
        .updateTable('knowledge.edit_draft')
        .set({ base_version: version, dirty: false, checkpoint_seq: seq, content_hash: hash, updated_at: new Date() })
        .where('document_id', '=', d.id)
        .execute();
      await tx.db
        .deleteFrom('knowledge.edit_op')
        .where('document_id', '=', d.id)
        .where('seq', '<=', Math.max(0, seq - this.ws.liveOpLogMax))
        .execute();
    };
    if (cur && cur.hash === hash) {
      await clean(d.row.current_version_number);
      return d;
    }
    const bytes = contentBytes(content);
    const v = await this.appendVersion(tx, p, d, {
      title: d.row.title,
      content,
      hash,
      bytes,
      kind: 'save',
      prev: cur?.content ?? null,
    });
    await this.bumpDoc(tx, d, p, { current_version_id: v.id, current_version_number: v.number });
    const mentions = await this.syncReferences(tx, d, collectRefs(content));
    const who = await sql<{ n: string }>`
      SELECT count(DISTINCT membership_id) AS n FROM knowledge.edit_op
       WHERE document_id = ${d.id} AND seq > ${Number(dr.checkpoint_seq)}`.execute(tx.db);
    await this.docAudit(tx, caller, p, 'document.saved', d, [
      change.plain('version', d.row.current_version_number, v.number),
      change.content('content', { hash }),
      change.plain('blocks_added', null, v.summary.added ?? 0),
      change.plain('blocks_changed', null, v.summary.changed ?? 0),
      change.plain('blocks_removed', null, v.summary.removed ?? 0),
      change.plain('live_contributors', null, Number(who.rows[0]?.n ?? 0)),
      change.plain('live_checkpoint', null, why),
    ]);
    await this.docEvent(tx, caller, p, 'knowledge.document.version_saved', d, {
      version_number: v.number,
      kind: 'save',
      size_bytes: bytes,
    }, d.row.version + 1);
    await this.emitDocMentions(tx, caller, p, { ...d, row: { ...d.row, version: d.row.version + 1 } }, mentions);
    await clean(v.number);
    return this.loadDocument(tx, p, d.publicId, { lock: true });
  }

  /**
   * Unsaved live work with nobody editing becomes a version in its own transaction, before a plain
   * save or restore runs: that command may then be refused as stale, and a refusal must not roll
   * the saved work back. The caller's own base version is then compared with the version it made.
   */
  protected async recoverLiveDraft(caller: Caller, ws: unknown, doc: unknown): Promise<void> {
    const needed = await this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const d = await this.loadDocument(tx, p, doc);
      const dr = await this.draftOf(tx, d.id);
      return !!dr?.dirty && (await this.liveSessionCount(tx, d.id)) === 0;
    });
    if (!needed) return;
    await this.inWorkspace(caller, ws, {}, async (tx, p) => {
      if (p.workspaceState !== 'active') return;
      const d = await this.loadDocument(tx, p, doc, { lock: true });
      this.editableDoc(p, d);
      if ((await this.liveSessionCount(tx, d.id)) === 0) await this.checkpointDraft(tx, caller, p, d, 'recovery');
    });
  }

  /**
   * Every path that appends a version outside the live editor calls this first (ADR-0027 C4): a
   * live session blocks it (`live_edit_in_progress`, the client uses the live editor or waits for
   * the session to end), and unsaved live work with nobody editing is saved as a version first, so
   * nothing is ever lost or overwritten. Returns the document as it is afterwards.
   */
  protected async liveGuard(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    d: LoadedDocument,
  ): Promise<LoadedDocument> {
    const dr = await this.draftOf(tx, d.id, true);
    if (!dr) return d;
    if ((await this.liveSessionCount(tx, d.id)) > 0)
      throw new TenancyError('conflict', {
        issues: [
          issue('/', 'live_edit_in_progress', 'Someone is editing this document live. Save from the live editor, or try again when they finish.'),
        ],
      });
    return dr.dirty ? this.checkpointDraft(tx, caller, p, d, 'recovery') : d;
  }

  // ---------------------------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------------------------

  async createDocument(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = parseDocumentCreate(body);
    return this.kTrack('create', 'knowledge.documents', () =>
      this.mutate(
        caller,
        'document.create',
        ws,
        req,
        async (tx, p) => {
          const place = await this.resolvePlacement(tx, p, input);
          const bad = placementError(input.type, {
            brand: place.brandId !== null && !place.projectId && !place.taskId,
            project: !!place.projectId,
            task: !!place.taskId,
            parent: !!place.parent,
          });
          if (bad) throw invalid(issue(bad.pointer, bad.code, bad.message));
          const limits = this.contentLimits();
          const title = input.title ?? defaultTitle(input.type);
          const parsed = parseContent(
            input.content !== undefined ? input.content : input.starter ? starterContent(input.type) : { v: 2, blocks: [] },
            limits,
            undefined,
            '/content',
          );
          const chain = place.parent
            ? place.parent.chain
            : place.projectId
              ? await this.chainOfProject(tx, place.projectId)
              : place.taskId
                ? await this.chainOfProject(tx, (await this.taskProject(tx, place.taskId)) ?? null)
                : [];
          let ownerId = p.membershipId;
          if (input.owner) {
            const m = await this.memberByPublic(tx, input.owner, '/owner');
            if (!(await this.canEditHere(tx, m.id, { brand: place.brand, chain })))
              throw invalid(issue('/owner', 'invalid_reference', 'Choose a member who can edit this document.'));
            ownerId = m.id;
          }
          if (input.reviewDueOn) await this.requireReviewDate(tx, input.reviewDueOn);
          const id = newUuidV7();
          const publicId = newPublicId('doc');
          const cmd = this.cmd(caller, p, place.brandId);
          await tx.db
            .insertInto('core.record')
            .values({
              id,
              public_id: publicId,
              record_type: 'document',
              workspace_id: tx.workspaceId,
              brand_id: place.brandId,
              source_kind: 'ui',
              source_ref: null,
              created_by_actor_type: cmd.actor.type,
              created_by_actor_id: cmd.actor.id,
            })
            .execute();
          const rank = await this.nextRank(
            tx,
            'knowledge.document',
            (q: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
              place.parent
                ? q.where('parent_document_id', '=', place.parent.id)
                : q
                    .where('scope_key', '=', place.scopeKey)
                    .where('parent_document_id', 'is', null)
                    .where('attached_project_id', place.projectId ? '=' : 'is', place.projectId)
                    .where('attached_task_id', place.taskId ? '=' : 'is', place.taskId),
            'last',
          );
          await tx.db
            .insertInto('knowledge.document')
            .values({
              id,
              workspace_id: tx.workspaceId,
              brand_id: place.brandId,
              scope_key: place.scopeKey,
              parent_document_id: place.parent?.id ?? null,
              ancestor_ids: place.parent ? [...place.parent.row.ancestor_ids, place.parent.id] : [],
              depth: place.parent ? place.parent.row.depth + 1 : 0,
              attached_project_id: place.projectId,
              attached_task_id: place.taskId,
              doc_type: input.type,
              title,
              state: input.state,
              owner_membership_id: ownerId,
              review_due_on: input.reviewDueOn,
              rank,
              created_by_membership_id: p.membershipId,
              updated_by_membership_id: p.membershipId,
            })
            .execute();
          const created = await this.loadDocument(tx, p, publicId, { lock: true });
          await this.checkNewRefs(tx, p, created, parsed.refs, 'none');
          const starter = input.content === undefined && input.starter && input.type !== 'page';
          const v = await this.appendVersion(tx, p, created, {
            title,
            content: parsed.content,
            hash: parsed.hash,
            bytes: parsed.bytes,
            kind: starter ? 'template' : 'save',
            ...(starter ? { template: templateKey(input.type) } : {}),
            prev: null,
          });
          await tx.db
            .updateTable('knowledge.document')
            .set({ current_version_id: v.id, current_version_number: v.number })
            .where('id', '=', id)
            .execute();
          const fresh = await this.loadDocument(tx, p, publicId, { lock: true });
          const mentions = await this.syncReferences(tx, fresh, collectRefs(parsed.content));
          await this.docAudit(tx, caller, p, 'document.created', fresh, [
            change.plain('type', null, input.type),
            change.plain('scope', null, place.brand ? 'brand' : 'workspace'),
            change.plain('attached', null, place.taskId ? 'task' : place.projectId ? 'project' : null),
            change.plain('parent', null, place.parent?.publicId ?? null),
            change.content('title', { hash: hashText(title) }),
            change.content('content', { hash: parsed.hash }),
          ]);
          await this.docEvent(tx, caller, p, 'knowledge.document.created', fresh, {
            doc_type: input.type,
            parent_document_id: place.parent?.id ?? null,
            attached_kind: place.taskId ? 'task' : place.projectId ? 'project' : place.brand ? 'brand' : 'workspace',
          }, 0);
          await this.docEvent(tx, caller, p, 'knowledge.document.version_saved', fresh, {
            version_number: v.number,
            kind: starter ? 'template' : 'save',
            size_bytes: parsed.bytes,
          }, 1);
          await this.emitDocMentions(tx, caller, p, fresh, mentions);
          return {
            status: 201,
            ref: { id: publicId, type: 'document' },
            data: await this.documentView(tx, p, fresh),
          };
        },
        async (tx, p, ref) => this.documentView(tx, p, await this.loadDocument(tx, p, ref.id)),
      ),
    );
  }

  protected async taskProject(tx: WorkspaceTransaction, taskId: string): Promise<string | null> {
    const t = await tx.db.selectFrom('work.task').select('project_id').where('id', '=', taskId).executeTakeFirst();
    return t?.project_id ?? null;
  }

  protected async requireReviewDate(tx: WorkspaceTransaction, date: string): Promise<void> {
    const today = await this.workspaceToday(tx);
    if (date > addReviewDays(today, this.ws.documentReviewHorizonDays))
      throw invalid(
        issue('/review_due_on', 'too_far', `Choose a review date within ${this.ws.documentReviewHorizonDays} days.`),
      );
  }

  /** One event per new member mention; the 4B fan-out turns each into a notification if allowed. */
  protected async emitDocMentions(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    d: LoadedDocument,
    added: ReadonlyArray<{ id: string; block: string }>,
  ) {
    for (const a of added)
      await this.docEvent(tx, caller, p, 'knowledge.document.mention_added', d, { reference_id: a.id, block_id: a.block }, d.row.version + 2);
  }

  // ---------------------------------------------------------------------------------------------
  // Save and restore content
  // ---------------------------------------------------------------------------------------------

  async saveContent(caller: Caller, ws: unknown, doc: unknown, body: unknown, req: Mutation) {
    const input = parseContentSave(body, this.contentLimits());
    await this.recoverLiveDraft(caller, ws, doc);
    return this.kTrack('save', 'knowledge.versions', () =>
      this.mutate(
        caller,
        'document.save',
        ws,
        req,
        async (tx, p) => {
          const d = await this.saveContentIn(tx, caller, p, doc, input);
          return { status: 200, ref: { id: d.publicId, type: 'document' }, data: await this.documentView(tx, p, d) };
        },
        async (tx, p, ref) => this.documentView(tx, p, await this.loadDocument(tx, p, ref.id)),
      ),
    );
  }

  /**
   * The canonical document save inside a caller's transaction: lock, edit permission, rate limit,
   * the live-edit guard, the base-version precondition, references and embeds, and a new immutable
   * version with audit and events. Shared by the API and 7D proposal application.
   */
  protected async saveContentIn(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    doc: unknown,
    input: ReturnType<typeof parseContentSave>,
  ): Promise<LoadedDocument> {
    const loaded = await this.loadDocument(tx, p, doc, { lock: true });
    this.editableDoc(p, loaded);
    await this.docLimit(p);
    const d = await this.liveGuard(tx, caller, p, loaded);
    requireVersion(input.baseVersion, d.row.current_version_number);
    const cur = await this.currentContent(tx, d);
    const title = input.title ?? d.row.title;
    if (cur && cur.hash === input.hash && cur.title === title)
      return d;
    let next = { content: input.content, hash: input.hash, bytes: input.bytes, refs: input.refs as Ref[] };
    if (input.restricted.length) {
      // The client held opaque tokens for links it cannot read; they go back to what they were.
      const restored = parseContent(
        this.restoreRefs(d, cur?.content ?? null, input.content),
        this.contentLimits(),
        undefined,
        '/content',
      );
      next = { content: restored.content, hash: restored.hash, bytes: restored.bytes, refs: restored.refs };
    }
    if (cur && cur.hash === next.hash && cur.title === title)
      return d;
    await this.checkNewRefs(tx, p, d, next.refs, 'present');
    await this.checkFileEmbeds(tx, d, next.content, cur?.content ?? null);
    const v = await this.appendVersion(tx, p, d, {
      title,
      content: next.content,
      hash: next.hash,
      bytes: next.bytes,
      kind: 'save',
      prev: cur?.content ?? null,
    });
    await this.bumpDoc(tx, d, p, { title, current_version_id: v.id, current_version_number: v.number });
    const mentions = await this.syncReferences(tx, d, collectRefs(next.content));
    await this.docAudit(tx, caller, p, 'document.saved', d, [
      change.plain('version', d.row.current_version_number, v.number),
      ...(title !== d.row.title ? [change.content('title', { hash: hashText(title) })] : []),
      change.content('content', { hash: next.hash }),
      change.plain('blocks_added', null, v.summary.added ?? 0),
      change.plain('blocks_changed', null, v.summary.changed ?? 0),
      change.plain('blocks_removed', null, v.summary.removed ?? 0),
    ]);
    await this.docEvent(tx, caller, p, 'knowledge.document.version_saved', d, {
      version_number: v.number,
      kind: 'save',
      size_bytes: next.bytes,
    }, d.row.version + 1);
    await this.emitDocMentions(tx, caller, p, { ...d, row: { ...d.row, version: d.row.version + 1 } }, mentions);
    return this.loadDocument(tx, p, d.publicId);
  }

  async restoreVersion(caller: Caller, ws: unknown, doc: unknown, body: unknown, req: Mutation) {
    const input = parseRestore(body);
    await this.recoverLiveDraft(caller, ws, doc);
    return this.kTrack('restore', 'knowledge.versions', () =>
      this.mutate(
        caller,
        'document.restore_version',
        ws,
        req,
        async (tx, p) => {
          const loaded = await this.loadDocument(tx, p, doc, { lock: true });
          this.editableDoc(p, loaded);
          await this.docLimit(p);
          const d = await this.liveGuard(tx, caller, p, loaded);
          requireVersion(input.baseVersion, d.row.current_version_number);
          const target = await this.versionRow(tx, d.id, input.version);
          if (!target) throw new TenancyError('not_found');
          if (target.number === d.row.current_version_number)
            throw new TenancyError('conflict', {
              issues: [issue('/version', 'already_current', 'That is already the current version.')],
            });
          const content = readContent(target.content);
          const parsed = parseContent(content, { ...this.contentLimits(), bodyMaxBytes: Math.max(this.contentLimits().bodyMaxBytes, target.size_bytes) });
          const cur = await this.currentContent(tx, d);
          const v = await this.appendVersion(tx, p, d, {
            title: target.title,
            content: parsed.content,
            hash: parsed.hash,
            bytes: parsed.bytes,
            kind: 'restore',
            restoredFrom: target.number,
            prev: cur?.content ?? null,
          });
          await this.bumpDoc(tx, d, p, { title: target.title, current_version_id: v.id, current_version_number: v.number });
          await this.syncReferences(tx, d, collectRefs(parsed.content));
          await this.docAudit(tx, caller, p, 'document.version_restored', d, [
            change.plain('version', d.row.current_version_number, v.number),
            change.plain('restored_from', null, target.number),
            change.content('content', { hash: parsed.hash }),
          ]);
          await this.docEvent(tx, caller, p, 'knowledge.document.version_saved', d, {
            version_number: v.number,
            kind: 'restore',
            size_bytes: parsed.bytes,
          }, d.row.version + 1);
          const fresh = await this.loadDocument(tx, p, d.publicId);
          return { status: 200, ref: { id: d.publicId, type: 'document' }, data: await this.documentView(tx, p, fresh) };
        },
        async (tx, p, ref) => this.documentView(tx, p, await this.loadDocument(tx, p, ref.id)),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // State, owner, review date
  // ---------------------------------------------------------------------------------------------

  async updateDocument(caller: Caller, ws: unknown, doc: unknown, body: unknown, req: Mutation) {
    const input = parseDocumentPatch(body);
    return this.kTrack('update', 'knowledge.documents', () =>
      this.mutate(
        caller,
        'document.update',
        ws,
        req,
        async (tx, p) => {
          const d = await this.loadDocument(tx, p, doc, { lock: true });
          this.editableDoc(p, d);
          if (req.ifMatch === undefined) throw new TenancyError('precondition_required');
          requireVersion(parseIfMatch(req.ifMatch), d.row.version);
          const set: Record<string, unknown> = {};
          const changes: ReturnType<typeof change.plain>[] = [];
          const kinds: string[] = [];
          if (input.state !== undefined && input.state !== d.row.state) {
            set.state = input.state;
            changes.push(change.plain('state', d.row.state, input.state));
            kinds.push('state');
          }
          if (input.reviewDueOn !== undefined && input.reviewDueOn !== d.row.review_due_on) {
            if (input.reviewDueOn) await this.requireReviewDate(tx, input.reviewDueOn);
            set.review_due_on = input.reviewDueOn;
            changes.push(change.plain('review_due_on', d.row.review_due_on, input.reviewDueOn));
            kinds.push('review_due');
          }
          if (input.owner !== undefined) {
            const m = await this.memberByPublic(tx, input.owner, '/owner');
            if (m.id !== d.row.owner_membership_id) {
              this.requireDocAction(p, 'record.assign', d, { shares: false, excluded: 'forbidden' });
              if (!(await this.canEditHere(tx, m.id, { brand: d.brand, chain: d.chain })))
                throw invalid(issue('/owner', 'invalid_reference', 'Choose a member who can edit this document.'));
              const from = await tx.db.selectFrom('tenancy.membership').select('public_id').where('id', '=', d.row.owner_membership_id).executeTakeFirst();
              set.owner_membership_id = m.id;
              changes.push(change.plain('owner', from?.public_id ?? null, m.public_id));
              kinds.push('owner');
            }
          }
          if (kinds.length) {
            await this.bumpDoc(tx, d, p, set);
            await this.docAudit(tx, caller, p, 'document.updated', d, changes);
            await this.docEvent(tx, caller, p, 'knowledge.document.updated', d, { change: kinds.join(',') }, d.row.version + 1);
          }
          const fresh = await this.loadDocument(tx, p, d.publicId);
          return { status: 200, ref: { id: d.publicId, type: 'document' }, data: await this.documentView(tx, p, fresh) };
        },
        async (tx, p, ref) => this.documentView(tx, p, await this.loadDocument(tx, p, ref.id)),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Pages: move and reorder
  // ---------------------------------------------------------------------------------------------

  async moveDocument(caller: Caller, ws: unknown, doc: unknown, body: unknown, req: Mutation) {
    const input = parseMove(body);
    return this.kTrack('move', 'knowledge.documents', () =>
      this.mutate(
        caller,
        'document.move',
        ws,
        req,
        async (tx, p) => {
          const peek = await this.loadDocument(tx, p, doc);
          const root = peek.row.ancestor_ids[0] ?? peek.id;
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${root}::text, 43))`.execute(tx.db);
          const d = await this.loadDocument(tx, p, doc, { lock: true });
          this.requireDocActive(d);
          this.requireDocAction(p, 'record.update', d, { shares: false, excluded: 'forbidden' });
          if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), d.row.version);
          let parent: LoadedDocument | null = null;
          if (input.parent) {
            parent = await this.loadDocument(tx, p, input.parent, { lock: true });
            this.requireDocActive(parent);
            this.requireDocAction(p, 'record.create', parent, { shares: false });
            if (
              parent.row.scope_key !== d.row.scope_key ||
              parent.row.attached_project_id !== d.row.attached_project_id ||
              parent.row.attached_task_id !== d.row.attached_task_id
            )
              throw invalid(
                issue('/parent', 'different_place', 'A page can only move within where it lives. Create a copy there instead.'),
              );
            if (createsCycle(d.id, parent.row.ancestor_ids, parent.id))
              throw invalid(issue('/parent', 'cycle', "A page can't move inside itself."));
          }
          const tallest = await sql<{ h: number }>`
            SELECT COALESCE(max(depth), ${d.row.depth})::int - ${d.row.depth}::int AS h FROM knowledge.document
             WHERE workspace_id = ${tx.workspaceId} AND ${d.id}::uuid = ANY(ancestor_ids)`.execute(tx.db);
          const newDepth = parent ? parent.row.depth + 1 : 0;
          if (newDepth + (tallest.rows[0]?.h ?? 0) > this.ws.documentDepthMax)
            throw invalid(issue('/parent', 'depth_exceeded', `Pages can be nested at most ${this.ws.documentDepthMax} levels deep.`));
          if (parent && parent.id !== d.row.parent_document_id) {
            const kids = await tx.db
              .selectFrom('knowledge.document')
              .select((eb) => eb.fn.countAll<string>().as('n'))
              .where('parent_document_id', '=', parent.id)
              .where('lifecycle_state', '<>', 'purged')
              .executeTakeFirstOrThrow();
            if (Number(kids.n) >= this.ws.documentChildrenMax)
              throw invalid(issue('/parent', 'too_many', `A page can have at most ${this.ws.documentChildrenMax} subpages.`));
          }
          const prefix = parent ? [...parent.row.ancestor_ids, parent.id] : [];
          const rank = await this.nextRank(
            tx,
            'knowledge.document',
            (q: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
              (parent
                ? q.where('parent_document_id', '=', parent.id)
                : q
                    .where('scope_key', '=', d.row.scope_key)
                    .where('parent_document_id', 'is', null)
                    .where('attached_project_id', d.row.attached_project_id ? '=' : 'is', d.row.attached_project_id)
                    .where('attached_task_id', d.row.attached_task_id ? '=' : 'is', d.row.attached_task_id)
              ).where('id', '<>', d.id),
            input.after === undefined ? 'last' : input.after === null ? null : await this.siblingId(tx, input.after),
          );
          await sql`UPDATE knowledge.document x
              SET ancestor_ids = ${prefix}::uuid[] || x.ancestor_ids[${d.row.depth + 1}:cardinality(x.ancestor_ids)],
                  depth = x.depth + ${newDepth - d.row.depth}, version = x.version + 1
            WHERE x.workspace_id = ${tx.workspaceId} AND ${d.id}::uuid = ANY(x.ancestor_ids)`.execute(tx.db);
          await this.bumpDoc(tx, d, p, {
            parent_document_id: parent?.id ?? null,
            ancestor_ids: prefix,
            depth: newDepth,
            rank,
          });
          await this.docAudit(tx, caller, p, 'document.moved', d, [
            change.plain('parent', d.row.parent_document_id ? await this.publicOf(tx, d.row.parent_document_id) : null, parent?.publicId ?? null),
          ]);
          await this.docEvent(tx, caller, p, 'knowledge.document.updated', d, { change: 'moved' }, d.row.version + 1);
          const fresh = await this.loadDocument(tx, p, d.publicId);
          return { status: 200, ref: { id: d.publicId, type: 'document' }, data: await this.documentView(tx, p, fresh) };
        },
        async (tx, p, ref) => this.documentView(tx, p, await this.loadDocument(tx, p, ref.id)),
      ),
    );
  }

  protected async siblingId(tx: WorkspaceTransaction, publicId: string): Promise<string> {
    const r = await tx.db
      .selectFrom('core.record')
      .select('id')
      .where('public_id', '=', publicId)
      .where('record_type', '=', 'document')
      .executeTakeFirst();
    return r?.id ?? NIL_MEMBER;
  }

  // ---------------------------------------------------------------------------------------------
  // Links (DOC-008): documents linked to records, beside the mentions inside the content
  // ---------------------------------------------------------------------------------------------

  async setLinks(caller: Caller, ws: unknown, doc: unknown, body: unknown, req: Mutation) {
    const links = parseLinks(body, this.ws.documentReferencesMax);
    return this.kTrack('links', 'knowledge.references', () =>
      this.mutate(
        caller,
        'document.links',
        ws,
        req,
        async (tx, p) => {
          const d = await this.loadDocument(tx, p, doc, { lock: true });
          this.editableDoc(p, d);
          if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), d.row.version);
          const refs: Ref[] = links.map((l) => ({ kind: l.kind, id: l.id }));
          const priorLinks = await tx.db
            .selectFrom('knowledge.document_reference as ref')
            .innerJoin('core.record as r', (j) =>
              j.onRef('r.workspace_id', '=', 'ref.workspace_id').onRef('r.id', '=', 'ref.target_record_id'),
            )
            .select(['r.public_id', 'ref.target_record_type'])
            .where('ref.document_id', '=', d.id)
            .where('ref.kind', '=', 'link')
            .execute();
          const had = new Set(priorLinks.map((r) => `${r.target_record_type}:${r.public_id}`));
          const fresh = refs.filter((r) => !had.has(`${r.kind}:${r.id}`));
          if (fresh.some((r) => r.kind === 'document' && r.id === d.publicId))
            throw invalid(issue('/records', 'not_linkable', "A document can't link to itself."));
          await this.checkNewRefs(tx, p, d, fresh, 'none');
          // The set is replaced as the viewer sees it: links to what they cannot read stay as they are.
          const ws0 = await this.workspacePublicId(tx);
          const visible = await this.docRefs(
            tx,
            p,
            ws0,
            priorLinks.map((r) => ({ kind: r.target_record_type as Ref['kind'], id: r.public_id })),
          );
          const keep = new Set(
            priorLinks
              .filter((r) => !visible[`${r.target_record_type}:${r.public_id}`])
              .map((r) => `${r.target_record_type}:${r.public_id}`),
          );
          const gone = priorLinks
            .filter((r) => visible[`${r.target_record_type}:${r.public_id}`])
            .map((r) => r.public_id);
          if (gone.length)
            await sql`DELETE FROM knowledge.document_reference ref USING core.record r
                       WHERE r.workspace_id = ref.workspace_id AND r.id = ref.target_record_id
                         AND ref.document_id = ${d.id} AND ref.kind = 'link' AND r.public_id = ANY(${gone}::text[])`.execute(
              tx.db,
            );
          const wanted = refs.filter((r) => !keep.has(`${r.kind}:${r.id}`));
          if (keep.size + wanted.length > this.ws.documentReferencesMax)
            throw invalid(issue('/records', 'too_many', `Link at most ${this.ws.documentReferencesMax} records.`));
          if (wanted.length) {
            const ids = new Map(
              (
                await tx.db
                  .selectFrom('core.record')
                  .select(['id', 'public_id', 'record_type'])
                  .where('public_id', 'in', wanted.map((r) => r.id))
                  .where('lifecycle_state', 'in', ['active', 'archived'])
                  .execute()
              ).map((r) => [r.public_id, r]),
            );
            let position = keep.size;
            for (const r of wanted) {
              const row = ids.get(r.id);
              if (!row) continue;
              await tx.db
                .insertInto('knowledge.document_reference')
                .values({
                  id: newUuidV7(),
                  workspace_id: tx.workspaceId,
                  document_id: d.id,
                  block_id: '-',
                  position: position++,
                  kind: 'link',
                  target_kind: 'record',
                  target_membership_id: null,
                  target_team_id: null,
                  target_record_id: row.id,
                  target_record_type: row.record_type as 'task' | 'project' | 'brand' | 'document',
                })
                .execute();
            }
          }
          await this.bumpDoc(tx, d, p, {});
          await this.docAudit(tx, caller, p, 'document.links_changed', d, [change.plain('links', priorLinks.length, refs.length)]);
          await this.docEvent(tx, caller, p, 'knowledge.document.updated', d, { change: 'links' }, d.row.version + 1);
          const out = await this.loadDocument(tx, p, d.publicId);
          return { status: 200, ref: { id: d.publicId, type: 'document' }, data: await this.documentView(tx, p, out) };
        },
        async (tx, p, ref) => this.documentView(tx, p, await this.loadDocument(tx, p, ref.id)),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle: a page's lifecycle carries its subpages (ADR-0025 D10)
  // ---------------------------------------------------------------------------------------------

  async documentLifecycle(
    caller: Caller,
    ws: unknown,
    doc: unknown,
    verb: 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge',
    req: Mutation,
  ) {
    return this.kTrack(verb, 'knowledge.documents', () =>
      this.mutate(
        caller,
        `document.${verb}`,
        ws,
        req,
        async (tx, p) => {
          const d = await this.loadDocument(tx, p, doc, {
            lock: true,
            allowTrashed: verb === 'restore' || verb === 'purge',
          });
          if (d.ownLevel === null) throw new TenancyError('forbidden');
          if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), d.row.version);
          const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
          const facts = { id: d.id, brand: d.brand, lifecycleState: d.lifecycleState, chain: d.chain };
          const state = await tx.db
            .selectFrom('core.record')
            .select(['lifecycle_state', 'deletion_batch_id'])
            .where('id', '=', d.id)
            .executeTakeFirstOrThrow();
          const conflict = () =>
            new TenancyError('conflict', {
              issues: [issue('/', 'invalid_state', "This document can't do that in its current state.")],
            });
          if (verb === 'archive') {
            if (state.lifecycle_state !== 'active') throw conflict();
            await this.d.lifecycle.archive(
              tx,
              this.issueLifecycle(tx, p, 'record.archive', facts),
              input,
              d.id,
            );
          } else if (verb === 'unarchive') {
            if (state.lifecycle_state !== 'archived') throw conflict();
            await this.d.lifecycle.unarchive(
              tx,
              this.issueLifecycle(tx, p, 'record.restore', facts),
              input,
              d.id,
            );
          } else if (verb === 'trash') {
            if (state.lifecycle_state !== 'active' && state.lifecycle_state !== 'archived') throw conflict();
            await this.d.lifecycle.trash(
              tx,
              this.issueLifecycle(tx, p, 'record.trash', facts),
              input,
              d.id,
            );
          } else {
            if (state.lifecycle_state !== 'trashed') throw conflict();
            const own = await tx.db
              .selectFrom('core.deletion_batch')
              .select('id')
              .where('id', '=', state.deletion_batch_id!)
              .where('root_record_id', '=', d.id)
              .executeTakeFirst();
            // A page trashed with its parent comes back with it.
            if (!own) throw conflict();
            if (verb === 'restore')
              await this.d.lifecycle.restore(
                tx,
                this.issueLifecycle(tx, p, 'record.restore', facts),
                input,
                own.id,
              );
            else
              await this.d.lifecycle.requestPurge(
                tx,
                this.issueLifecycle(tx, p, 'record.purge', facts),
                input,
                own.id,
              );
          }
          await bumpEpoch(tx, 'workspace', null);
          const after = await tx.db
            .selectFrom('core.record')
            .select('lifecycle_state')
            .where('id', '=', d.id)
            .executeTakeFirstOrThrow();
          return {
            status: verb === 'purge' ? 202 : 200,
            ref: { id: d.publicId, type: 'document' },
            data: { id: d.publicId, type: 'document' as const, lifecycle_state: after.lifecycle_state },
          };
        },
        async (tx, _p, ref) => {
          const r = await tx.db
            .selectFrom('core.record')
            .select(['public_id', 'lifecycle_state'])
            .where('public_id', '=', ref.id)
            .executeTakeFirstOrThrow();
          return { id: r.public_id, type: 'document' as const, lifecycle_state: r.lifecycle_state };
        },
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Export (DOC-020, OD-32): Markdown and HTML, bounded, authorized, audited, honest
  // ---------------------------------------------------------------------------------------------

  async exportDocument(caller: Caller, ws: unknown, doc: unknown, body: unknown, req: Mutation) {
    const q = parseExportQuery(isPlain(body) ? body : {});
    const metric = (outcome: string) =>
      this.d.metrics.count('knowledge.exports', 1, { format: q.format, outcome });
    try {
      const out = await this.mutate(
        caller,
        'document.export',
        ws,
        req,
        async (tx, p) => {
          const d = await this.loadDocument(tx, p, doc);
          this.requireDocAction(p, 'record.export', d);
          return { status: 200, ref: { id: d.publicId, type: 'document_export' }, data: await this.buildExport(tx, caller, p, d, q) };
        },
        async (tx, p, ref) => {
          const d = await this.loadDocument(tx, p, ref.id);
          this.requireDocAction(p, 'record.export', d);
          return this.buildExport(tx, caller, p, d, q, true);
        },
      );
      metric('ok');
      return out;
    } catch (err) {
      metric(err instanceof TenancyError ? err.code : 'error');
      throw err;
    }
  }

  protected async buildExport(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    d: LoadedDocument,
    q: { format: 'markdown' | 'html'; includeChildren: boolean },
    replay = false,
  ) {
    const pages: Array<{ title: string; content: DocContent }> = [];
    const first = await this.currentContent(tx, d);
    pages.push({ title: d.row.title, content: first?.content ?? { v: 2, blocks: [] } });
    let omitted = 0;
    if (q.includeChildren && d.ownLevel !== null) {
      const vis = await this.docVisibility(tx, p, false);
      const rows = await sql<{ id: string; title: string; version_id: string | null; number: number }>`
        SELECT x.id, x.title, x.current_version_id AS version_id, x.current_version_number AS number
          FROM core.record r
          JOIN knowledge.document x ON x.workspace_id = r.workspace_id AND x.id = r.id
          LEFT JOIN work.task kt ON kt.workspace_id = x.workspace_id AND kt.id = x.attached_task_id
         WHERE ${d.id}::uuid = ANY(x.ancestor_ids)
           AND ${vis.where('r', { project: sql`COALESCE(x.attached_project_id, kt.project_id)` })}
         ORDER BY x.depth, x.rank COLLATE "C", x.id LIMIT ${this.ws.documentExportPagesMax}`.execute(tx.db);
      for (const r of rows.rows) {
        const v = await this.versionRow(tx, r.id, Number(r.number));
        pages.push({ title: r.title, content: v ? readContent(v.content) : { v: 2, blocks: [] } });
      }
      const total = await tx.db
        .selectFrom('knowledge.document')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where(sql<boolean>`${d.id}::uuid = ANY(ancestor_ids)`)
        .where('lifecycle_state', 'in', ['active', 'archived'])
        .executeTakeFirstOrThrow();
      omitted = Math.max(0, Number(total.n) - (pages.length - 1));
    }
    const ws = await this.workspacePublicId(tx);
    const all: Ref[] = [];
    for (const pg of pages) for (const f of collectRefs(pg.content)) all.push({ kind: f.kind, id: f.id });
    const resolved = await this.docRefs(tx, p, ws, all);
    const resolve: DocRefResolver = (r) => {
      const hit = resolved[`${r.kind}:${r.id}`];
      return hit ? { label: hit.label, href: hit.path } : null;
    };
    const note: ExportNote = { embeds: 0, restricted: 0 };
    const ext = q.format === 'markdown' ? 'md' : 'html';
    let content: string;
    if (q.format === 'markdown')
      content = pages.map((pg) => toMarkdown(pg.title, pg.content, resolve, note)).join('\n---\n\n');
    else {
      const body = pages
        .map((pg, i) =>
          i === 0 ? htmlBody(pg.content, resolve, note) : `<hr><h1>${escapeHtml(pg.title)}</h1>\n${htmlBody(pg.content, resolve, note)}`,
        )
        .join('\n');
      content = toHtml(d.row.title, body);
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.ws.documentExportMaxBytes)
      throw new TenancyError('conflict', {
        issues: [issue('/', 'too_large', 'This export is too large. Export fewer pages.')],
      });
    const slug = d.row.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
    if (!replay)
      await this.docAudit(tx, caller, p, 'document.exported', d, [
        change.plain('format', null, q.format),
        change.plain('pages', null, pages.length),
        change.plain('bytes', null, bytes),
        change.plain('embeds_as_links', null, note.embeds),
        change.plain('restricted_items', null, note.restricted),
      ]);
    return {
      id: d.publicId,
      type: 'document_export' as const,
      format: q.format,
      filename: `${slug}.${ext}`,
      content_type: q.format === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
      content,
      bytes,
      pages: pages.length,
      notes: {
        embeds_as_links: note.embeds,
        restricted_items: note.restricted,
        pages_omitted: omitted,
        unsupported: ['pdf'],
      },
    };
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Re-exported for the HTTP layer and tests.
export { DOC_TYPE_LABEL, DOC_REF_PREFIX };
export type { DocType };
