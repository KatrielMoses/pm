import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  invalid,
  issue,
  parseIfMatch,
  requireVersion,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { isPublic } from '../validation.ts';
import {
  blockHash,
  collectRefs,
  parseContent,
  type Block,
  type DocContent,
  type Ref,
} from './content.ts';
import { DocumentService } from './document-service.ts';
import type { LoadedDocument } from './document-core.ts';
import {
  parseSourceApproval,
  parseSuggestionCreate,
  parseSuggestionDecision,
} from './validation.ts';

const NIL_SUGGESTION = `dsg_${'0'.repeat(26)}`;
const NIL_DOC = `doc_${'0'.repeat(26)}`;
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

interface SuggestionRow {
  id: string;
  public_id: string;
  document_id: string;
  block_id: string;
  base_version: number;
  base_block_hash: string;
  proposed: unknown;
  note: string | null;
  state: 'open' | 'accepted' | 'rejected' | 'withdrawn' | 'stale';
  author_membership_id: string;
  decided_by_membership_id: string | null;
  decided_at: Date | null;
  applied_version: number | null;
  created_at: Date;
  version: number;
  document_public: string;
}

/**
 * Phase 4C suggestions and AI-source approvals (ADR-0025 D6, D10). A suggestion proposes replacing
 * one block against the version and block it saw; it is applied only to a block that has not
 * changed since, and otherwise becomes stale with nothing applied. An approval is an append-only
 * fact about one version; it stops applying when a newer version is saved.
 */
export class KnowledgeService extends DocumentService {
  protected async loadSuggestion(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    opts: { lock?: boolean } = {},
  ): Promise<{ row: SuggestionRow; doc: LoadedDocument }> {
    const miss = async (): Promise<never> => {
      await this.loadDocument(tx, p, NIL_DOC).catch(() => undefined);
      throw new TenancyError('not_found');
    };
    if (!isPublic(publicId, 'dsg')) return miss();
    let q = tx.db
      .selectFrom('knowledge.document_suggestion as s')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 's.workspace_id').onRef('r.id', '=', 's.document_id'),
      )
      .selectAll('s')
      .select('r.public_id as document_public')
      .where('s.public_id', '=', publicId);
    if (opts.lock) q = q.forUpdate('s');
    const row = (await q.executeTakeFirst()) as SuggestionRow | undefined;
    if (!row) return miss();
    const doc = await this.loadDocument(tx, p, row.document_public, { lock: opts.lock === true });
    return { row: { ...row, base_version: Number(row.base_version), version: Number(row.version) }, doc };
  }

  protected blockOf(c: DocContent, id: string): Block | undefined {
    return c.blocks.find((b) => b.id === id);
  }

  protected async suggestionView(
    tx: WorkspaceTransaction,
    p: Principal,
    d: LoadedDocument,
    row: SuggestionRow,
  ) {
    const cur = await this.currentContent(tx, d);
    const block = cur ? this.blockOf(cur.content, row.block_id) : undefined;
    const outdated = row.state === 'open' && (!block || blockHash(block) !== row.base_block_hash);
    const people = await this.peopleOf(tx, p, [
      row.author_membership_id,
      ...(row.decided_by_membership_id ? [row.decided_by_membership_id] : []),
    ]);
    const ws = await this.workspacePublicId(tx);
    const proposedRefs = collectRefs({ v: 2, blocks: [row.proposed as Block, ...(block ? [block] : [])] });
    const references = await this.docRefs(
      tx,
      p,
      ws,
      proposedRefs.map((r) => ({ kind: r.kind, id: r.id })),
    );
    const active = d.lifecycleState === 'active';
    return {
      id: row.public_id,
      type: 'document_suggestion' as const,
      document: d.publicId,
      block: row.block_id,
      base_version: row.base_version,
      state: row.state,
      effective_state: outdated ? ('stale' as const) : row.state,
      proposed: this.redact(d, { v: 2, blocks: [row.proposed as Block] }, references).blocks[0]!,
      current: block ? this.redact(d, { v: 2, blocks: [block] }, references).blocks[0]! : null,
      references,
      note: row.note,
      author: people.get(row.author_membership_id) ?? null,
      decided_by: row.decided_by_membership_id ? (people.get(row.decided_by_membership_id) ?? null) : null,
      decided_at: iso(row.decided_at),
      applied_version: row.applied_version,
      created_at: iso(row.created_at),
      version: row.version,
      capabilities: {
        accept: active && row.state === 'open' && !outdated && this.docAllows(p, 'record.update', d),
        reject: active && row.state === 'open' && this.docAllows(p, 'record.update', d),
        withdraw: active && row.state === 'open' && row.author_membership_id === p.membershipId,
      },
    };
  }

  async listSuggestions(caller: Caller, ws: unknown, doc: unknown, query: Record<string, unknown>) {
    return this.kTrack('list', 'knowledge.suggestions', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const d = await this.loadDocument(tx, p, doc);
        const state = query.state === undefined ? 'open' : query.state;
        if (state !== 'open' && state !== 'all')
          throw invalid(issue('/state', 'invalid_option', 'Choose open or all.'));
        const rows = (await tx.db
          .selectFrom('knowledge.document_suggestion')
          .selectAll()
          .where('document_id', '=', d.id)
          .$if(state === 'open', (q) => q.where('state', '=', 'open'))
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(this.pageLimit(query.limit))
          .execute()) as unknown as SuggestionRow[];
        const data = [];
        for (const r of rows)
          data.push(await this.suggestionView(tx, p, d, { ...r, base_version: Number(r.base_version), version: Number(r.version), document_public: d.publicId }));
        return { data, page: { limit: this.pageLimit(query.limit), has_more: false } };
      }),
    );
  }

  async getSuggestion(caller: Caller, ws: unknown, dsg: unknown) {
    return this.kTrack('read', 'knowledge.suggestions', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const { row, doc } = await this.loadSuggestion(tx, p, dsg);
        return this.suggestionView(tx, p, doc, row);
      }),
    );
  }

  async createSuggestion(caller: Caller, ws: unknown, doc: unknown, body: unknown, req: Mutation) {
    const input = parseSuggestionCreate(body, this.contentLimits());
    return this.kTrack('create', 'knowledge.suggestions', () =>
      this.mutate(
        caller,
        'document.suggest',
        ws,
        req,
        async (tx, p) => {
          const d = await this.loadDocument(tx, p, doc, { lock: true });
          this.requireDocAction(p, 'record.comment', d);
          this.requireDocActive(d);
          await this.docLimit(p);
          requireVersion(input.baseVersion, d.row.current_version_number);
          const cur = await this.currentContent(tx, d);
          const block = cur ? this.blockOf(cur.content, input.block) : undefined;
          if (!block) throw invalid(issue('/block', 'invalid_reference', 'Choose a block in this document.'));
          const open = await tx.db
            .selectFrom('knowledge.document_suggestion')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('document_id', '=', d.id)
            .where('state', '=', 'open')
            .executeTakeFirstOrThrow();
          if (Number(open.n) >= this.ws.documentSuggestionsOpenMax)
            throw invalid(issue('/', 'too_many', `A document can have at most ${this.ws.documentSuggestionsOpenMax} open suggestions.`));
          let proposed = { ...input.proposed, id: input.block } as Block;
          if (input.restricted.length) {
            const restored = this.restoreRefs(d, cur?.content ?? null, { v: 2, blocks: [proposed] });
            proposed = restored.blocks[0]!;
          }
          const refs: Ref[] = collectRefs({ v: 2, blocks: [proposed] }).map((r) => ({ kind: r.kind, id: r.id }));
          await this.checkNewRefs(tx, p, d, refs, 'present');
          const id = newUuidV7();
          const publicId = newPublicId('dsg');
          await tx.db
            .insertInto('knowledge.document_suggestion')
            .values({
              id,
              public_id: publicId,
              workspace_id: tx.workspaceId,
              document_id: d.id,
              block_id: input.block,
              base_version: d.row.current_version_number,
              base_block_hash: blockHash(block),
              proposed: JSON.stringify(proposed),
              note: input.note,
              author_membership_id: p.membershipId,
            })
            .execute();
          await this.docAudit(tx, caller, p, 'document.suggestion_created', d, [
            change.plain('suggestion', null, publicId),
            change.plain('block', null, input.block),
            change.plain('base_version', null, d.row.current_version_number),
            change.content('proposed', { hash: blockHash(proposed) }),
          ]);
          await this.workEvent(
            tx,
            caller,
            p,
            'knowledge.document.suggestion_created',
            { type: 'knowledge.document_suggestion', id, sequence: 0 },
            { document_id: d.id, block_id: input.block },
            d.brand?.id ?? null,
          );
          const { row } = await this.loadSuggestion(tx, p, publicId);
          return { status: 201, ref: { id: publicId, type: 'document_suggestion' }, data: await this.suggestionView(tx, p, d, row) };
        },
        async (tx, p, ref) => {
          const { row, doc: d } = await this.loadSuggestion(tx, p, ref.id);
          return this.suggestionView(tx, p, d, row);
        },
      ),
    );
  }

  async decideSuggestion(caller: Caller, ws: unknown, dsg: unknown, body: unknown, req: Mutation) {
    const input = parseSuggestionDecision(body);
    return this.kTrack(input.outcome, 'knowledge.suggestions', () =>
      this.mutate(
        caller,
        `document.suggestion_${input.outcome}`,
        ws,
        req,
        async (tx, p) => {
          const { row, doc: d } = await this.loadSuggestion(tx, p, dsg, { lock: true });
          this.editableDoc(p, d);
          if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), row.version);
          if (row.state !== 'open')
            throw new TenancyError('conflict', { issues: [issue('/', 'already_decided', 'This suggestion is already settled.')] });
          const now = new Date();
          const cur = await this.currentContent(tx, d);
          const block = cur ? this.blockOf(cur.content, row.block_id) : undefined;
          let applied: number | null = null;
          let state: SuggestionRow['state'];
          if (input.outcome === 'reject') state = 'rejected';
          else if (!cur || !block || blockHash(block) !== row.base_block_hash) state = 'stale';
          else {
            const proposed = row.proposed as Block;
            const next: DocContent = {
              v: 2,
              blocks: cur.content.blocks.map((b) => (b.id === row.block_id ? proposed : b)),
            };
            const parsed = parseContent(next, this.contentLimits());
            const v = await this.appendVersion(tx, p, d, {
              title: d.row.title,
              content: parsed.content,
              hash: parsed.hash,
              bytes: parsed.bytes,
              kind: 'suggestion',
              prev: cur.content,
            });
            await this.bumpDoc(tx, d, p, { current_version_id: v.id, current_version_number: v.number });
            const mentions = await this.syncReferences(tx, d, collectRefs(parsed.content));
            await this.docEvent(tx, caller, p, 'knowledge.document.version_saved', d, {
              version_number: v.number,
              kind: 'suggestion',
              size_bytes: parsed.bytes,
            }, d.row.version + 1);
            await this.emitDocMentions(tx, caller, p, { ...d, row: { ...d.row, version: d.row.version + 1 } }, mentions);
            applied = v.number;
            state = 'accepted';
          }
          await tx.db
            .updateTable('knowledge.document_suggestion')
            .set({
              state,
              ...(state === 'accepted' || state === 'rejected'
                ? { decided_by_membership_id: p.membershipId, decided_at: now, applied_version: applied }
                : {}),
              updated_at: now,
              version: row.version + 1,
            })
            .where('id', '=', row.id)
            .execute();
          await this.docAudit(tx, caller, p, 'document.suggestion_decided', d, [
            change.plain('suggestion', row.public_id, row.public_id),
            change.plain('state', 'open', state),
            ...(applied !== null ? [change.plain('applied_version', null, applied)] : []),
          ]);
          await this.workEvent(
            tx,
            caller,
            p,
            'knowledge.document.suggestion_decided',
            { type: 'knowledge.document_suggestion', id: row.id, sequence: row.version + 1 },
            { document_id: d.id, state, applied_version: applied },
            d.brand?.id ?? null,
          );
          const fresh = await this.loadSuggestion(tx, p, row.public_id);
          return { status: 200, ref: { id: row.public_id, type: 'document_suggestion' }, data: await this.suggestionView(tx, p, fresh.doc, fresh.row) };
        },
        async (tx, p, ref) => {
          const { row, doc: d } = await this.loadSuggestion(tx, p, ref.id);
          return this.suggestionView(tx, p, d, row);
        },
      ),
    );
  }

  async withdrawSuggestion(caller: Caller, ws: unknown, dsg: unknown, req: Mutation) {
    return this.kTrack('withdraw', 'knowledge.suggestions', () =>
      this.mutate(
        caller,
        'document.suggestion_withdraw',
        ws,
        req,
        async (tx, p) => {
          const { row, doc: d } = await this.loadSuggestion(tx, p, dsg, { lock: true });
          this.requireDocActive(d);
          if (row.author_membership_id !== p.membershipId)
            throw new TenancyError('forbidden');
          if (row.state !== 'open')
            throw new TenancyError('conflict', { issues: [issue('/', 'already_decided', 'This suggestion is already settled.')] });
          await tx.db
            .updateTable('knowledge.document_suggestion')
            .set({ state: 'withdrawn', updated_at: new Date(), version: row.version + 1 })
            .where('id', '=', row.id)
            .execute();
          await this.docAudit(tx, caller, p, 'document.suggestion_withdrawn', d, [
            change.plain('suggestion', row.public_id, row.public_id),
          ]);
          const fresh = await this.loadSuggestion(tx, p, row.public_id);
          return { status: 200, ref: { id: row.public_id, type: 'document_suggestion' }, data: await this.suggestionView(tx, p, fresh.doc, fresh.row) };
        },
        async (tx, p, ref) => {
          const { row, doc: d } = await this.loadSuggestion(tx, p, ref.id);
          return this.suggestionView(tx, p, d, row);
        },
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // AI-source approvals (DOC-017)
  // ---------------------------------------------------------------------------------------------

  protected async setSource(
    caller: Caller,
    ws: unknown,
    doc: unknown,
    body: unknown,
    req: Mutation,
    kind: 'approved' | 'revoked',
  ) {
    const input = parseSourceApproval(body);
    return this.kTrack(kind === 'approved' ? 'approve' : 'revoke', 'knowledge.documents', () =>
      this.mutate(
        caller,
        `document.source_${kind}`,
        ws,
        req,
        async (tx, p) => {
          const d = await this.loadDocument(tx, p, doc, { lock: true });
          this.requireDocAction(p, 'record.read', d, { shares: false });
          this.requireDocActive(d);
          if (!this.docCapabilities(p, d).approve_source) throw new TenancyError('forbidden');
          if (input.version !== d.row.current_version_number)
            throw new TenancyError('conflict', {
              issues: [issue('/version', 'version_changed', 'The document changed. Review the current version first.')],
              conflict: { current_version: d.row.current_version_number },
            });
          const status = await this.sourceStatus(tx, p, d);
          if (status.approved === (kind === 'approved'))
            return { status: 200, ref: { id: d.publicId, type: 'document' }, data: await this.documentView(tx, p, d) };
          const v = await this.versionRow(tx, d.id, input.version);
          if (!v) throw new TenancyError('not_found');
          const id = newUuidV7();
          await tx.db
            .insertInto('knowledge.source_approval')
            .values({
              id,
              workspace_id: tx.workspaceId,
              document_id: d.id,
              version_number: input.version,
              kind,
              actor_membership_id: p.membershipId,
              note: input.note,
            })
            .execute();
          await this.docAudit(tx, caller, p, kind === 'approved' ? 'document.source_approved' : 'document.source_revoked', d, [
            change.plain('version', null, input.version),
            change.plain('ai_source', status.approved, kind === 'approved'),
          ]);
          await this.workEvent(
            tx,
            caller,
            p,
            'knowledge.document.source_approved',
            { type: 'knowledge.source_approval', id, sequence: 0 },
            { document_version_id: v.id, kind },
            d.brand?.id ?? null,
          );
          const fresh = await this.loadDocument(tx, p, d.publicId);
          return { status: 200, ref: { id: d.publicId, type: 'document' }, data: await this.documentView(tx, p, fresh) };
        },
        async (tx, p, ref) => this.documentView(tx, p, await this.loadDocument(tx, p, ref.id)),
      ),
    );
  }

  approveSource(caller: Caller, ws: unknown, doc: unknown, body: unknown, req: Mutation) {
    return this.setSource(caller, ws, doc, body, req, 'approved');
  }

  revokeSource(caller: Caller, ws: unknown, doc: unknown, body: unknown, req: Mutation) {
    return this.setSource(caller, ws, doc, body, req, 'revoked');
  }

  static readonly nilSuggestion = NIL_SUGGESTION;
  protected static sqlRef = sql;
}
