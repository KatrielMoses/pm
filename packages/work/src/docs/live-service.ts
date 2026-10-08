import { randomBytes, createHash } from 'node:crypto';
import { newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { Issues, TenancyError, issue, type Caller, type Principal } from '@pm/tenancy';
import {
  blockHash,
  collectRefs,
  documentContentHash,
  parseContent,
  readContent,
  type Block,
  type DocContent,
  type Ref,
} from './content.ts';
import { type LoadedDocument } from './document-core.ts';
import { KnowledgeService } from './suggestion-service.ts';
import {
  applyOp,
  opBlockId,
  parseLiveRequest,
  parseSeq,
  parseSessionKey,
  type LiveOp,
} from './live.ts';
import { isObject } from '../validation.ts';

const EVENT_PAGE = 500;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const conflict = (code: string, message: string) =>
  new TenancyError('conflict', { issues: [issue('/', code, message)] });
const peerOf = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 12);

interface SessionRow {
  id: string;
  membership_id: string;
  session_key: string;
  mode: 'edit' | 'view';
  color: number;
  caret_block: string | null;
  expires_at: Date;
}

/**
 * Phase 4D live collaborative editing (ADR-0027). Every call is one workspace transaction that
 * re-reads the document through its compiled level, so a revoked, archived, trashed, or purged
 * document refuses the next request. Operations edit the draft, never a version; a checkpoint
 * appends an ordinary 4C version. Presence is ephemeral rows with an expiry and is never audited.
 */
export class LiveService extends KnowledgeService {
  protected async liveTrack<T>(action: string, fn: () => Promise<T>): Promise<T> {
    return this.kTrack(action, 'knowledge.live', fn);
  }

  protected async liveLimit(p: Principal): Promise<void> {
    const r = await this.c.limiter.consume('document.live' as never, p.membershipId);
    if (!r.allowed) throw new TenancyError('rate_limited', { retryAfterSeconds: r.retryAfterSeconds });
  }

  /** The document, its caller authorized right now; the write forms lock the row. */
  protected async liveDoc(
    tx: WorkspaceTransaction,
    p: Principal & { workspaceState?: string },
    doc: unknown,
    mode: 'edit' | 'view',
    lock: boolean,
  ): Promise<LoadedDocument> {
    if (!this.ws.liveEditingEnabled)
      throw conflict('live_disabled', 'Live editing is not available. Edit and save the document as usual.');
    if (lock && p.workspaceState !== undefined && p.workspaceState !== 'active')
      throw new TenancyError('workspace_read_only');
    const d = await this.loadDocument(tx, p, doc, lock ? { lock: true } : {});
    if (mode === 'edit') this.editableDoc(p, d);
    else this.requireDocActive(d);
    return d;
  }

  protected async ownSession(
    tx: WorkspaceTransaction,
    p: Principal,
    d: LoadedDocument,
    key: string,
  ): Promise<SessionRow> {
    const row = await sql<SessionRow>`
      SELECT id, membership_id, session_key, mode, color, caret_block, expires_at
        FROM knowledge.edit_session
       WHERE document_id = ${d.id} AND session_key = ${key} AND membership_id = ${p.membershipId}
         AND expires_at > now()`.execute(tx.db);
    const s = row.rows[0];
    if (!s) throw conflict('session_expired', 'Your live session ended. Reconnect to keep editing.');
    return s;
  }

  protected async touchSession(tx: WorkspaceTransaction, s: SessionRow, caret?: string | null) {
    await sql`
      UPDATE knowledge.edit_session
         SET last_seen_at = now(), expires_at = now() + make_interval(secs => ${this.ws.liveSessionTtlSeconds})
             ${caret !== undefined ? sql`, caret_block = ${caret}` : sql``}
       WHERE id = ${s.id}`.execute(tx.db);
  }

  /** Blocks as this viewer may see them, with the labels of the references they may read. */
  protected async shownBlocks(tx: WorkspaceTransaction, p: Principal, d: LoadedDocument, blocks: readonly Block[]) {
    const content: DocContent = { v: 2, blocks: [...blocks] };
    const refs = collectRefs(content) as Ref[];
    const resolved = refs.length ? await this.docRefs(tx, p, await this.workspacePublicId(tx), refs) : {};
    return { blocks: this.redact(d, content, resolved).blocks, references: resolved };
  }

  protected async snapshot(
    tx: WorkspaceTransaction,
    p: Principal,
    d: LoadedDocument,
    draft: { content: unknown; seq: string | number; base_version: number; dirty: boolean },
  ) {
    const content = readContent(draft.content);
    const { blocks, references } = await this.shownBlocks(tx, p, d, content.blocks);
    return {
      seq: Number(draft.seq),
      base_version: draft.base_version,
      dirty: draft.dirty,
      content: { v: 2 as const, blocks },
      hashes: Object.fromEntries(content.blocks.map((b) => [b.id, blockHash(b)])),
      references,
      files: await this.embeddedFiles(tx, d, content),
    };
  }

  /** Presence a viewer may see (ADR-0027 C9): members see members; everyone else sees only themselves. */
  protected async presence(tx: WorkspaceTransaction, p: Principal, d: LoadedDocument, own: SessionRow | null) {
    const rows = await sql<SessionRow & { state: string }>`
      SELECT s.id, s.membership_id, s.session_key, s.mode, s.color, s.caret_block, s.expires_at, m.state
        FROM knowledge.edit_session s
        JOIN tenancy.membership m ON m.workspace_id = s.workspace_id AND m.id = s.membership_id
       WHERE s.document_id = ${d.id} AND s.expires_at > now() AND m.state = 'active'
       ORDER BY s.started_at, s.id`.execute(tx.db);
    const visible = rows.rows.filter((r) => (p.kind === 'member' ? true : r.id === own?.id));
    const people = await this.peopleOf(tx, p, visible.map((r) => r.membership_id));
    const list = visible.map((r) => ({
      peer: peerOf(r.id),
      you: r.id === own?.id,
      name: people.get(r.membership_id)?.name ?? null,
      mode: r.mode,
      color: r.color,
      caret_block: r.caret_block,
    }));
    const tag = createHash('sha256').update(JSON.stringify(list)).digest('base64url').slice(0, 16);
    return { list, tag };
  }

  /** The draft for a document, opened from its current version when there is none (or it is stale and clean). */
  protected async ensureDraft(tx: WorkspaceTransaction, p: Principal, d: LoadedDocument) {
    let draft = await this.draftOf(tx, d.id, true);
    const cur = await this.currentContent(tx, d);
    const content = cur?.content ?? { v: 2 as const, blocks: [] };
    const hash = documentContentHash(content);
    if (!draft) {
      await sql`
        INSERT INTO knowledge.edit_draft (workspace_id, document_id, base_version, content, content_hash)
        VALUES (${tx.workspaceId}, ${d.id}, ${d.row.current_version_number}, ${JSON.stringify(content)}::jsonb, ${hash})
        ON CONFLICT DO NOTHING`.execute(tx.db);
      draft = await this.draftOf(tx, d.id, true);
    } else if (!draft.dirty && draft.base_version !== d.row.current_version_number) {
      // A non-live save or restore moved the document while nobody was editing: start over from it,
      // and make every client that held the old draft reload (their log position is gone).
      await tx.db.deleteFrom('knowledge.edit_op').where('document_id', '=', d.id).execute();
      await sql`
        UPDATE knowledge.edit_draft
           SET base_version = ${d.row.current_version_number}, content = ${JSON.stringify(content)}::jsonb,
               content_hash = ${hash}, seq = seq + 1, checkpoint_seq = seq + 1, updated_at = now()
         WHERE document_id = ${d.id}`.execute(tx.db);
      draft = await this.draftOf(tx, d.id, true);
    }
    void p;
    return draft!;
  }

  // ---------------------------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------------------------

  async liveJoin(caller: Caller, ws: unknown, doc: unknown, body: unknown) {
    const issues = new Issues();
    const b = isObject(body) ? body : {};
    for (const k of Object.keys(b))
      if (k !== 'mode') issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
    if (b.mode !== undefined && b.mode !== 'edit' && b.mode !== 'view')
      issues.add('/mode', 'invalid_option', 'Choose edit or view.');
    issues.throwIfAny();
    return this.liveTrack('join', () =>
      this.inWorkspace(caller, ws, {}, async (tx, p) => {
        await this.liveLimit(p);
        const probe = await this.liveDoc(tx, p, doc, 'view', true);
        const canEdit = this.docCapabilities(p, probe).edit;
        const mode: 'edit' | 'view' = (b.mode as 'edit' | 'view' | undefined) ?? (canEdit ? 'edit' : 'view');
        const d = mode === 'edit' ? await this.liveDoc(tx, p, doc, 'edit', true) : probe;
        await sql`DELETE FROM knowledge.edit_session WHERE document_id = ${d.id} AND expires_at <= now()`.execute(tx.db);
        const counts = await sql<{ total: string; mine: string }>`
          SELECT count(*) AS total, count(*) FILTER (WHERE membership_id = ${p.membershipId}) AS mine
            FROM knowledge.edit_session WHERE document_id = ${d.id}`.execute(tx.db);
        if (
          Number(counts.rows[0]?.total ?? 0) >= this.ws.liveSessionsMax ||
          Number(counts.rows[0]?.mine ?? 0) >= this.ws.liveSessionsPerMemberMax
        )
          throw conflict('live_capacity', 'Too many people are editing live. Edit and save the document as usual.');
        const draft = await this.ensureDraft(tx, p, d);
        const key = randomBytes(18).toString('base64url');
        const id = newUuidV7();
        const colour = createHash('sha256').update(p.membershipId).digest()[0]! % 8;
        await sql`
          INSERT INTO knowledge.edit_session (id, workspace_id, document_id, membership_id, session_key, mode, color, expires_at)
          VALUES (${id}, ${tx.workspaceId}, ${d.id}, ${p.membershipId}, ${key}, ${mode}, ${colour},
                  now() + make_interval(secs => ${this.ws.liveSessionTtlSeconds}))`.execute(tx.db);
        const own = (await this.ownSession(tx, p, d, key))!;
        const presence = await this.presence(tx, p, d, own);
        return {
          session: key,
          peer: peerOf(id),
          mode,
          expires_at: own.expires_at.toISOString(),
          ttl_seconds: this.ws.liveSessionTtlSeconds,
          poll_wait_seconds: this.ws.livePollWaitSeconds,
          ops_batch_max: this.ws.liveOpsBatchMax,
          ...(await this.snapshot(tx, p, d, draft)),
          presence: presence.list,
          presence_tag: presence.tag,
          document: { id: d.publicId, title: d.row.title, content_version: d.row.current_version_number },
        };
      }),
    );
  }

  async liveOps(caller: Caller, ws: unknown, doc: unknown, body: unknown) {
    const input = parseLiveRequest(body, this.contentLimits(), this.ws.liveOpsBatchMax);
    return this.liveTrack('ops', () =>
      this.inWorkspace(caller, ws, {}, async (tx, p) => {
        await this.liveLimit(p);
        const d = await this.liveDoc(tx, p, doc, 'edit', true);
        const session = await this.ownSession(tx, p, d, input.session);
        if (session.mode !== 'edit') throw conflict('session_read_only', 'This session can only watch.');
        const draft = await this.draftOf(tx, d.id, true);
        if (!draft || draft.base_version !== d.row.current_version_number)
          throw conflict('session_expired', 'Your live session ended. Reconnect to keep editing.');
        let content = readContent(draft.content);
        let seq = Number(draft.seq);
        const applied: Array<{ op_id: string; seq: number; block_hash: string | null }> = [];
        const rejected: Array<{ op_id: string; code: string; current: Block | null; current_hash: string | null }> = [];
        const refsOf = (c: DocContent) => new Set(collectRefs(c).map((r) => `${r.kind}:${r.id}`));
        for (const raw of input.ops) {
          const prior = await sql<{ seq: string; payload: { block_hash: string | null } }>`
            SELECT seq, payload FROM knowledge.edit_op
             WHERE document_id = ${d.id} AND membership_id = ${p.membershipId} AND op_id = ${raw.opId}`.execute(tx.db);
          if (prior.rows[0]) {
            applied.push({ op_id: raw.opId, seq: Number(prior.rows[0].seq), block_hash: prior.rows[0].payload.block_hash ?? null });
            continue;
          }
          const op = this.restoreOp(d, content, raw);
          const before = refsOf(content);
          if (op.kind === 'insert' || op.kind === 'replace') {
            const fresh = collectRefs({ v: 2, blocks: [op.block] }).filter((r) => !before.has(`${r.kind}:${r.id}`));
            await this.checkNewRefs(tx, p, d, fresh, 'present');
          }
          if (op.kind === 'insert' || op.kind === 'replace')
            await this.checkFileEmbeds(tx, d, { v: 2, blocks: [op.block] }, content);
          const result = applyOp(content, op);
          if (!result.ok) {
            const shown = result.current ? (await this.shownBlocks(tx, p, d, [result.current])).blocks[0]! : null;
            rejected.push({
              op_id: raw.opId,
              code: result.code,
              current: shown,
              current_hash: result.current ? blockHash(result.current) : null,
            });
            continue;
          }
          const parsed = parseContent(result.content, this.contentLimits(), undefined, '/content');
          content = parsed.content;
          seq += 1;
          await tx.db
            .insertInto('knowledge.edit_op')
            .values({
              workspace_id: tx.workspaceId,
              document_id: d.id,
              seq,
              session_id: session.id,
              membership_id: p.membershipId,
              op_id: raw.opId,
              kind: op.kind,
              block_id: opBlockId(op),
              payload: JSON.stringify({
                block: op.kind === 'insert' || op.kind === 'replace' ? op.block : null,
                after: op.kind === 'insert' || op.kind === 'move' ? op.after : null,
                block_hash: result.hash,
              }),
            })
            .execute();
          applied.push({ op_id: raw.opId, seq, block_hash: result.hash });
        }
        if (applied.length && seq !== Number(draft.seq)) {
          await sql`
            UPDATE knowledge.edit_draft
               SET content = ${JSON.stringify(content)}::jsonb, content_hash = ${documentContentHash(content)},
                   seq = ${seq}, dirty = true, last_editor_membership_id = ${p.membershipId}, updated_at = now()
             WHERE document_id = ${d.id}`.execute(tx.db);
        }
        await this.touchSession(tx, session, input.caret);
        const caught = await this.eventsSince(tx, p, d, input.after, seq);
        const presence = await this.presence(tx, p, d, session);
        return { applied, rejected, seq, ...caught, presence: presence.list, presence_tag: presence.tag };
      }),
    );
  }

  /** Puts back the references that restricted tokens stand for in an incoming operation. */
  protected restoreOp(d: LoadedDocument, content: DocContent, op: LiveOp): LiveOp {
    if (op.kind !== 'insert' && op.kind !== 'replace') return op;
    const restored = this.restoreRefs(d, content, { v: 2, blocks: [op.block] }).blocks[0]!;
    return { ...op, block: restored } as LiveOp;
  }

  /** Accepted operations after `after`, as this viewer may see them; or a reload when the log no longer reaches back. */
  protected async eventsSince(tx: WorkspaceTransaction, p: Principal, d: LoadedDocument, after: number, head: number) {
    const bounds = await sql<{ lo: string | null }>`
      SELECT min(seq) AS lo FROM knowledge.edit_op WHERE document_id = ${d.id}`.execute(tx.db);
    const lo = bounds.rows[0]?.lo === null || bounds.rows[0]?.lo === undefined ? null : Number(bounds.rows[0].lo);
    if (after > head || (after < head && (lo === null || after < lo - 1))) {
      const draft = (await this.draftOf(tx, d.id))!;
      return { resync: await this.snapshot(tx, p, d, draft), events: [] as never[] };
    }
    const rows = await sql<{ seq: string; session_id: string | null; op_id: string; kind: string; block_id: string; payload: { block: Block | null; after: string | null; block_hash: string | null } }>`
      SELECT seq, session_id, op_id, kind, block_id, payload FROM knowledge.edit_op
       WHERE document_id = ${d.id} AND seq > ${after} ORDER BY seq LIMIT ${EVENT_PAGE}`.execute(tx.db);
    const shown = await this.shownBlocks(
      tx,
      p,
      d,
      rows.rows.flatMap((r) => (r.payload.block ? [r.payload.block] : [])),
    );
    let n = 0;
    const events = rows.rows.map((r) => ({
      seq: Number(r.seq),
      op_id: r.op_id,
      peer: r.session_id ? peerOf(r.session_id) : null,
      kind: r.kind,
      block_id: r.block_id,
      block: r.payload.block ? (shown.blocks[n++] ?? null) : null,
      block_hash: r.payload.block_hash ?? null,
      after: r.payload.after ?? null,
    }));
    return { events, references: shown.references };
  }

  /** Long poll: answers at once when there is news, else after at most `wait` seconds. */
  async liveEvents(caller: Caller, ws: unknown, doc: unknown, query: Record<string, unknown>) {
    const issues = new Issues();
    const session = parseSessionKey(query.session, issues);
    const after = parseSeq(query.after === undefined ? undefined : Number(query.after), '/after', issues);
    const waitSecs =
      query.wait === undefined
        ? 0
        : Number.isInteger(Number(query.wait)) && Number(query.wait) >= 0
          ? Math.min(Number(query.wait), this.ws.livePollWaitSeconds)
          : (issues.add('/wait', 'invalid_number', 'Send a number of seconds.'), 0);
    const tag = typeof query.presence_tag === 'string' ? query.presence_tag.slice(0, 32) : '';
    issues.throwIfAny();
    const deadline = Date.now() + waitSecs * 1000;
    return this.liveTrack('poll', async () => {
      let first = true;
      for (;;) {
        const out = await this.inWorkspace(caller, ws, { readOnly: !first }, async (tx, p) => {
          if (first) await this.liveLimit(p);
          const d = await this.liveDoc(tx, p, doc, 'view', false);
          const own = await this.ownSession(tx, p, d, session);
          if (first) await this.touchSession(tx, own);
          const draft = await this.draftOf(tx, d.id);
          if (!draft) throw conflict('session_expired', 'Your live session ended. Reconnect to keep editing.');
          const caught = await this.eventsSince(tx, p, d, after!, Number(draft.seq));
          const presence = await this.presence(tx, p, d, own);
          return {
            seq: Number(draft.seq),
            base_version: draft.base_version,
            dirty: draft.dirty,
            ...caught,
            presence: presence.list,
            presence_tag: presence.tag,
            news: 'resync' in caught || caught.events.length > 0 || presence.tag !== tag,
          };
        });
        first = false;
        if (out.news || Date.now() >= deadline) {
          const { news: _news, ...rest } = out;
          return rest;
        }
        await wait(Math.min(400, Math.max(0, deadline - Date.now())));
      }
    });
  }

  async liveHeartbeat(caller: Caller, ws: unknown, doc: unknown, body: unknown) {
    const issues = new Issues();
    const b = isObject(body) ? body : {};
    for (const k of Object.keys(b))
      if (k !== 'session' && k !== 'caret') issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
    const session = parseSessionKey(b.session, issues);
    if (b.caret !== undefined && b.caret !== null && (typeof b.caret !== 'string' || b.caret.length < 1 || b.caret.length > 64))
      issues.add('/caret', 'invalid_block', 'Send a block identifier or null.');
    issues.throwIfAny();
    return this.liveTrack('heartbeat', () =>
      this.inWorkspace(caller, ws, {}, async (tx, p) => {
        await this.liveLimit(p);
        const d = await this.liveDoc(tx, p, doc, 'view', true);
        const own = await this.ownSession(tx, p, d, session);
        await this.touchSession(tx, own, b.caret as string | null | undefined);
        const fresh = await this.ownSession(tx, p, d, session);
        const presence = await this.presence(tx, p, d, fresh);
        return { expires_at: fresh.expires_at.toISOString(), presence: presence.list, presence_tag: presence.tag };
      }),
    );
  }

  /** Explicit save: the draft becomes a version now (the session continues). */
  async liveCheckpoint(caller: Caller, ws: unknown, doc: unknown, body: unknown) {
    const issues = new Issues();
    const b = isObject(body) ? body : {};
    for (const k of Object.keys(b))
      if (k !== 'session') issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
    const session = parseSessionKey(b.session, issues);
    issues.throwIfAny();
    return this.liveTrack('checkpoint', () =>
      this.inWorkspace(caller, ws, {}, async (tx, p) => {
        await this.liveLimit(p);
        await this.docLimit(p);
        const d = await this.liveDoc(tx, p, doc, 'edit', true);
        const own = await this.ownSession(tx, p, d, session);
        if (own.mode !== 'edit') throw conflict('session_read_only', 'This session can only watch.');
        const before = d.row.current_version_number;
        const fresh = await this.checkpointDraft(tx, caller, p, d, 'save');
        await this.touchSession(tx, own);
        const draft = (await this.draftOf(tx, d.id))!;
        return {
          saved: fresh.row.current_version_number !== before,
          content_version: fresh.row.current_version_number,
          seq: Number(draft.seq),
          dirty: draft.dirty,
        };
      }),
    );
  }

  async liveLeave(caller: Caller, ws: unknown, doc: unknown, body: unknown) {
    const issues = new Issues();
    const b = isObject(body) ? body : {};
    for (const k of Object.keys(b))
      if (k !== 'session') issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
    const session = parseSessionKey(b.session, issues);
    issues.throwIfAny();
    return this.liveTrack('leave', () =>
      this.inWorkspace(caller, ws, {}, async (tx, p) => {
        // Ending is always allowed; saving what the session left behind needs authority that may be gone.
        let d: LoadedDocument | null = null;
        try {
          d = await this.loadDocument(tx, p, doc, { lock: true });
        } catch (err) {
          if (!(err instanceof TenancyError)) throw err;
        }
        const gone = d
          ? await sql<{ id: string; mode: string }>`
              DELETE FROM knowledge.edit_session
               WHERE document_id = ${d.id} AND session_key = ${session} AND membership_id = ${p.membershipId}
              RETURNING id, mode`.execute(tx.db)
          : { rows: [] as Array<{ id: string; mode: string }> };
        let saved = false;
        if (d && gone.rows[0]?.mode === 'edit' && p.workspaceState === 'active') {
          const others = await this.liveSessionCount(tx, d.id);
          if (others === 0 && this.docCapabilities(p, d).edit) {
            const before = d.row.current_version_number;
            const fresh = await this.checkpointDraft(tx, caller, p, d, 'leave');
            saved = fresh.row.current_version_number !== before;
          }
        }
        return { left: gone.rows.length > 0, saved };
      }),
    );
  }
}
