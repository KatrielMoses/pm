import { createHash } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type CaptureSourceKind, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import {
  decideBrand,
  findBrand,
  invalid,
  issue,
  parseIfMatch,
  requireVersion,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { parseCapture, PARSER_VERSION, splitPaste, type ParseToken } from './capture/parser.ts';
import { recordAssignmentChange } from './collab/history.ts';
import { composeRule, parseRule } from './recurrence.ts';
import { normalizeLabel } from './task-validation.ts';
import { TaskInteractionService } from './task-interaction.ts';
import { isPublic } from './validation.ts';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const hash = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const NIL = '00000000-0000-7000-8000-000000000000';
const URL_RE = /^https:\/\/[^\s]{1,1990}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** An opaque paste-batch reference (Crockford base32 of the batch id; never a raw UUID). */
const batchRef = (uuid: string) => {
  const hex = uuid.replace(/-/g, '');
  let bits = '';
  for (const h of hex) bits += parseInt(h, 16).toString(2).padStart(4, '0');
  bits = bits.padEnd(130, '0');
  let out = '';
  for (let i = 0; i < 130; i += 5) out += CROCKFORD[parseInt(bits.slice(i, i + 5), 2)];
  return `batch:${out}`;
};

export type TriageTarget = 'task' | 'note' | 'project' | 'discard';

/** One resolved or unresolved detected value (names only among what the person can read). */
export interface Detected {
  field: ParseToken['field'];
  text: string;
  start: number;
  end: number;
  rule: string;
  status: 'resolved' | 'unresolved' | 'ambiguous';
  value: unknown;
  label?: string;
  options?: Array<{ value: unknown; label: string }>;
}

export interface CaptureCandidate {
  text: string;
  title: string;
  detected: Detected[];
  needs_confirmation: boolean;
  truncated: boolean;
}

/**
 * Phase 2E Inbox and universal capture (ADR-0017, 0B ADR-25, 0C AZ-25, 0D PL-27). One capture
 * command for every surface; personal Inbox items and notes visible only to their owner (OD-03);
 * deterministic, explainable parsing; triage and note conversion through the canonical task and
 * project commands with record.create decided at preview and apply; merge without destroying
 * source text; brand intake forms (members-only while OD-28 is open).
 */
export class CaptureService extends TaskInteractionService {
  // ---------------------------------------------------------------------------------------------
  // Parsing and resolution
  // ---------------------------------------------------------------------------------------------

  protected today(raw: unknown): string {
    const server = new Date().toISOString().slice(0, 10);
    if (typeof raw !== 'string' || !ISO_DAY.test(raw)) return server;
    // The person's local date may differ from UTC by at most a day.
    const diff = Math.abs(Date.parse(`${raw}T00:00:00Z`) - Date.parse(`${server}T00:00:00Z`));
    return diff <= 86_400_000 ? raw : server;
  }

  protected candidateTexts(body: Record<string, unknown>): {
    source: CaptureSourceKind;
    lines: string[];
  } {
    const max = this.ws.captureTextMax;
    if (Array.isArray(body.items)) {
      if (!body.items.length) throw invalid(issue('/items', 'required', 'Add at least one item.'));
      if (body.items.length > this.ws.capturePasteLinesMax)
        throw invalid(
          issue(
            '/items',
            'too_many',
            `Paste at most ${this.ws.capturePasteLinesMax} items at once.`,
          ),
        );
      const lines = body.items.map((x, i) => {
        const t = isObj(x) && typeof x.text === 'string' ? x.text.trim() : '';
        if (!t) throw invalid(issue(`/items/${i}/text`, 'required', 'This item is empty.'));
        if (t.length > max)
          throw invalid(
            issue(`/items/${i}/text`, 'too_long', `Keep each item under ${max} characters.`),
          );
        return t;
      });
      return { source: 'paste', lines };
    }
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) throw invalid(issue('/text', 'required', 'Type something to capture.'));
    if (text.length > max)
      throw invalid(issue('/text', 'too_long', `Keep a capture under ${max} characters.`));
    if (body.mode === 'paste') {
      const lines = splitPaste(text);
      if (lines.length > this.ws.capturePasteLinesMax)
        throw invalid(
          issue(
            '/text',
            'too_many',
            `Paste at most ${this.ws.capturePasteLinesMax} items at once.`,
          ),
        );
      return { source: 'paste', lines };
    }
    return { source: 'typed', lines: [text.trim()] };
  }

  /**
   * Resolves detected names among what the person can read. Every lookup runs whatever the text
   * names, and hidden and unknown names come back identically as `unresolved` (AT-139).
   */
  protected async resolve(
    tx: WorkspaceTransaction,
    p: Principal,
    tokens: ParseToken[],
    brandHint: string | null,
  ): Promise<Detected[]> {
    const names = (f: ParseToken['field']) =>
      tokens.filter((t) => t.field === f).map((t) => String(t.value).toLowerCase());
    const brandRows = await tx.db
      .selectFrom('tenancy.brand as b')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'b.workspace_id').onRef('r.id', '=', 'b.id'),
      )
      .select([
        'b.id',
        'r.public_id',
        'b.name',
        'b.short_name',
        'b.is_sensitive',
        'b.lifecycle_state',
      ])
      .where((eb) =>
        eb.or([
          eb(sql`lower(b.name)`, 'in', [...names('brand'), '']),
          eb(sql`lower(b.short_name)`, 'in', [...names('brand'), '']),
        ]),
      )
      .where('b.lifecycle_state', '=', 'active')
      .execute();
    const readableBrands = brandRows.filter(
      (b) =>
        decideBrand(p, 'record.read', {
          id: b.id,
          isSensitive: b.is_sensitive,
          lifecycleState: 'active',
        }).allowed,
    );
    const vis = await this.taskVisibility(tx, p, false);
    const projectRows = await tx.db
      .selectFrom('work.project as w')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'w.workspace_id').onRef('r.id', '=', 'w.id'),
      )
      .innerJoin('core.record as br', 'br.id', 'w.brand_id')
      .select(['w.id', 'r.public_id', 'w.name', 'w.brand_id', 'br.public_id as brand'])
      .where(sql<string>`lower(w.name)`, 'in', [...names('project'), ''])
      .where('r.lifecycle_state', '=', 'active')
      .where(vis.where('r', { project: sql`w.id` }))
      .execute();
    const memberRows = await tx.db
      .selectFrom('tenancy.membership as m')
      .innerJoin('identity.account as a', 'a.id', 'm.account_id')
      .select(['m.public_id', 'm.display_name_override', 'a.display_name', 'a.primary_email'])
      .where('m.kind', '=', 'member')
      .where('m.state', '=', 'active')
      .where((eb) =>
        eb.or([
          eb(sql`lower(coalesce(m.display_name_override, a.display_name))`, 'in', [
            ...names('owner'),
            '',
          ]),
          eb(sql`lower(split_part(a.primary_email, '@', 1))`, 'in', [...names('owner'), '']),
          eb(
            sql`lower(split_part(coalesce(m.display_name_override, a.display_name), ' ', 1))`,
            'in',
            [...names('owner'), ''],
          ),
        ]),
      )
      .execute();
    const brandPick = brandHint ?? (readableBrands.length === 1 ? readableBrands[0]!.id : null);
    const labelRows = await tx.db
      .selectFrom('work.label as l')
      .select(['l.public_id', 'l.name', 'l.normalized_name', 'l.brand_id'])
      .where('l.normalized_name', 'in', [...names('label').map(normalizeLabel), ''])
      .where('l.brand_id', '=', brandPick ?? NIL)
      .where('l.state', '=', 'active')
      .execute();
    return tokens.map((t): Detected => {
      const base = { field: t.field, text: t.text, start: t.start, end: t.end, rule: t.rule };
      const key = String(t.value).toLowerCase();
      const many = <R>(rows: R[], value: (r: R) => unknown, label: (r: R) => string): Detected =>
        rows.length === 1
          ? { ...base, status: 'resolved', value: value(rows[0]!), label: label(rows[0]!) }
          : rows.length > 1
            ? {
                ...base,
                status: 'ambiguous',
                value: null,
                options: rows.map((r) => ({ value: value(r), label: label(r) })),
              }
            : { ...base, status: 'unresolved', value: null };
      switch (t.field) {
        case 'brand':
          return many(
            readableBrands.filter(
              (b) => b.name.toLowerCase() === key || b.short_name?.toLowerCase() === key,
            ),
            (b) => b.public_id,
            (b) => b.name,
          );
        case 'project':
          return many(
            projectRows.filter(
              (r) => r.name.toLowerCase() === key && (!brandPick || r.brand_id === brandPick),
            ),
            (r) => r.public_id,
            (r) => r.name,
          );
        case 'owner':
          return many(
            memberRows.filter(
              (m) =>
                (m.display_name_override ?? m.display_name).toLowerCase() === key ||
                (m.display_name_override ?? m.display_name).toLowerCase().split(' ')[0] === key ||
                m.primary_email.toLowerCase().split('@')[0] === key,
            ),
            (m) => m.public_id,
            (m) => m.display_name_override ?? m.display_name,
          );
        case 'label':
          return many(
            labelRows.filter((l) => l.normalized_name === normalizeLabel(String(t.value))),
            (l) => l.public_id,
            (l) => l.name,
          );
        default:
          return t.options
            ? { ...base, status: 'ambiguous', value: null, options: t.options }
            : {
                ...base,
                status: 'resolved',
                value: t.value,
                label: String(JSON.stringify(t.value)),
              };
      }
    });
  }

  protected async candidate(
    tx: WorkspaceTransaction,
    p: Principal,
    text: string,
    today: string,
    brandHint: string | null,
  ): Promise<CaptureCandidate> {
    // The first line carries the task; later lines are kept verbatim in the original text.
    const r = parseCapture(text.split('\n')[0]!, {
      today,
      tokensMax: this.ws.captureParseTokensMax,
    });
    const detected = await this.resolve(tx, p, r.tokens, brandHint);
    return {
      text,
      title: r.title || text.split('\n')[0]!.slice(0, 300),
      detected,
      needs_confirmation: detected.some((d) => d.status === 'ambiguous'),
      truncated: r.truncated,
    };
  }

  /** The capture preview (CAP-004, CAP-010): candidates with detected values; nothing is saved. */
  async previewCapture(caller: Caller, ws: unknown, body: unknown) {
    const b = isObj(body) ? body : {};
    const { lines } = this.candidateTexts(b);
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const brandHint = typeof b.brand === 'string' ? (await findBrand(tx, p, b.brand)).id : null;
      const today = this.today(b.today);
      const candidates: CaptureCandidate[] = [];
      for (const line of lines)
        candidates.push(await this.candidate(tx, p, line, today, brandHint));
      this.d.metrics.count('capture.parse', candidates.length, { outcome: 'preview' });
      return { parser_version: PARSER_VERSION, ai: false as const, candidates };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Capture (CAP-001, CAP-002, CAP-004, CAP-011, CAP-015, CAP-016)
  // ---------------------------------------------------------------------------------------------

  protected async insertInboxItem(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    input: {
      owner: string;
      brandId: string | null;
      intent: 'task' | 'note';
      text: string;
      source: CaptureSourceKind;
      sourceRef: string | null;
      batch: string | null;
      parsed: CaptureCandidate;
    },
  ): Promise<{ id: string; publicId: string }> {
    const id = newUuidV7();
    const publicId = newPublicId('inb');
    const cmd = this.cmd(caller, p, input.brandId);
    await tx.db
      .insertInto('core.record')
      .values({
        id,
        public_id: publicId,
        record_type: 'inbox_item',
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        source_kind:
          input.source === 'typed'
            ? 'ui'
            : input.source === 'paste'
              ? 'paste'
              : input.source === 'api' || input.source === 'webhook'
                ? input.source
                : 'form',
        source_ref: null,
        created_by_actor_type: cmd.actor.type,
        created_by_actor_id: cmd.actor.id,
      })
      .execute();
    await tx.db
      .insertInto('capture.inbox_item')
      .values({
        id,
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        scope_key: input.brandId ?? tx.workspaceId,
        owner_membership_id: input.owner,
        intent: input.intent,
        raw_text: input.text,
        source_kind: input.source,
        source_ref: input.sourceRef,
        correlation_id: this.exec(caller, p).correlationId.replace(
          /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
          '$1-$2-$3-$4-$5',
        ),
        parse_version: PARSER_VERSION,
        parsed: JSON.stringify({ title: input.parsed.title, detected: input.parsed.detected }),
        capture_batch_id: input.batch,
      })
      .execute();
    await this.workWriter.write(tx, cmd, {
      action: 'capture.captured',
      target: { recordId: id, type: 'inbox_item', publicId },
      changes: [
        change.content('raw_text', { hash: hash(input.text) }),
        change.plain('source_kind', null, input.source),
        change.plain('intent', null, input.intent),
      ],
    });
    await writeOutboxEvent(tx, {
      type: 'capture.inbox.captured',
      aggregate: { type: 'capture.inbox_item', id, sequence: 0 },
      data: { source_kind: input.source, intent: input.intent },
      actor: { type: 'human', id: p.membershipId },
      context: this.exec(caller, p),
      ...(input.brandId ? { brandId: input.brandId } : {}),
    });
    return { id, publicId };
  }

  protected async insertNote(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    input: { brandId: string | null; title: string; body: string; source: string | null },
  ) {
    const id = newUuidV7();
    const publicId = newPublicId('note');
    const cmd = this.cmd(caller, p, input.brandId);
    await tx.db
      .insertInto('core.record')
      .values({
        id,
        public_id: publicId,
        record_type: 'note',
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        source_kind: 'ui',
        source_ref: null,
        created_by_actor_type: cmd.actor.type,
        created_by_actor_id: cmd.actor.id,
      })
      .execute();
    await tx.db
      .insertInto('capture.note')
      .values({
        id,
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        scope_key: input.brandId ?? tx.workspaceId,
        owner_membership_id: p.membershipId,
        title: input.title.slice(0, 300).trim() || 'Note',
        body: input.body,
        source_inbox_item_id: input.source,
      })
      .execute();
    await this.workWriter.write(tx, cmd, {
      action: 'note.created',
      target: { recordId: id, type: 'note', publicId },
      changes: [change.content('body', { hash: hash(input.body) })],
    });
    await writeOutboxEvent(tx, {
      type: 'capture.note.created',
      aggregate: { type: 'capture.note', id, sequence: 0 },
      data: { source_kind: input.source ? 'inbox_item' : 'typed' },
      actor: { type: 'human', id: p.membershipId },
      context: this.exec(caller, p),
      ...(input.brandId ? { brandId: input.brandId } : {}),
    });
    return { id, publicId };
  }

  protected async recordConversion(
    tx: WorkspaceTransaction,
    p: Principal,
    source: { id: string; kind: 'inbox_item' | 'note' },
    target: { id: string; kind: 'task' | 'note' | 'project' },
  ) {
    await tx.db
      .insertInto('capture.capture_conversion')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        source_record_id: source.id,
        source_kind: source.kind,
        target_record_id: target.id,
        target_kind: target.kind,
        by_membership_id: p.membershipId,
      })
      .execute();
  }

  protected async rateLimit(policy: 'capture.member' | 'intake.submit', dimension: string) {
    const d = await this.c.limiter.consume(policy as never, dimension);
    if (!d.allowed)
      throw new TenancyError('rate_limited', { retryAfterSeconds: d.retryAfterSeconds });
  }

  /**
   * The one capture command for every surface. Saves every candidate as a personal Inbox item
   * (incomplete and ambiguous input is valid; nothing needs a brand, project, or status). A note
   * capture also creates the note at once, keeping the item as its source. Links attach to each
   * item; file references are refused one by one (storage is 4E) without losing the capture. Each
   * candidate is saved or reported: never silently dropped.
   */
  async capture(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    if (
      caller.delegation &&
      !caller.delegation.scopes.some((s) => s === 'capture:write' || s === 'records:write')
    )
      throw new TenancyError('forbidden');
    const b = isObj(body) ? body : {};
    const intent =
      b.intent === 'note' ? 'note' : b.intent === undefined || b.intent === 'task' ? 'task' : null;
    if (!intent) throw invalid(issue('/intent', 'invalid_option', 'Capture a task or a note.'));
    const parsedTexts = this.candidateTexts(b);
    const source = caller.delegation?.sourceKind ?? parsedTexts.source;
    const lines = parsedTexts.lines;
    const links = Array.isArray(b.links) ? b.links : [];
    const files = Array.isArray(b.files) ? b.files : [];
    if (links.length > this.ws.captureLinksMax)
      throw invalid(
        issue('/links', 'too_many', `Attach at most ${this.ws.captureLinksMax} links.`),
      );
    if (files.length > this.ws.captureFilesMax)
      throw invalid(
        issue('/files', 'too_many', `Attach at most ${this.ws.captureFilesMax} files.`),
      );
    const parsedLinks = links.map((l, i) => {
      const url = isObj(l) && typeof l.url === 'string' ? l.url.trim() : '';
      if (!URL_RE.test(url))
        throw invalid(
          issue(`/links/${i}/url`, 'invalid_url', 'Use a secure web address (https://…).'),
        );
      const title = isObj(l) && typeof l.title === 'string' ? l.title.trim().slice(0, 200) : null;
      return { url, title: title || null };
    });
    return this.mutate(
      caller,
      'capture.capture',
      ws,
      req,
      async (tx, p) => {
        await this.rateLimit('capture.member', p.membershipId);
        const brand = typeof b.brand === 'string' ? await findBrand(tx, p, b.brand) : null;
        const today = this.today(b.today);
        const batch = lines.length > 1 ? newUuidV7() : null;
        const items: Array<{
          id?: string;
          note?: string;
          text: string;
          outcome: 'saved' | 'failed';
          code?: string;
        }> = [];
        for (const [i, text] of lines.entries()) {
          await sql`SAVEPOINT capture_item`.execute(tx.db);
          try {
            const parsed = await this.candidate(tx, p, text, today, brand?.id ?? null);
            const item = await this.insertInboxItem(tx, caller, p, {
              owner: p.membershipId,
              brandId: brand?.id ?? null,
              intent,
              text,
              source,
              sourceRef: batch ? batchRef(batch) : null,
              batch,
              parsed,
            });
            for (const [k, l] of parsedLinks.entries())
              await tx.db
                .insertInto('relations.record_link')
                .values({
                  id: newUuidV7(),
                  public_id: newPublicId('lnk'),
                  workspace_id: tx.workspaceId,
                  source_record_id: item.id,
                  target_kind: 'url',
                  url: l.url,
                  target_record_id: null,
                  title: l.title,
                  rank: String(k + 1).padStart(4, '0'),
                  created_by_membership_id: p.membershipId,
                })
                .execute();
            let note: string | undefined;
            if (intent === 'note') {
              const [first, ...rest] = text.split('\n');
              const n = await this.insertNote(tx, caller, p, {
                brandId: brand?.id ?? null,
                title: parsed.title || first!,
                body: rest.join('\n').trim() || text,
                source: item.id,
              });
              await this.markConverted(tx, item.id, 'note', n.id);
              await this.recordConversion(
                tx,
                p,
                { id: item.id, kind: 'inbox_item' },
                { id: n.id, kind: 'note' },
              );
              note = n.publicId;
            }
            await sql`RELEASE SAVEPOINT capture_item`.execute(tx.db);
            items.push({ id: item.publicId, text, outcome: 'saved', ...(note ? { note } : {}) });
          } catch (err) {
            await sql`ROLLBACK TO SAVEPOINT capture_item`.execute(tx.db);
            const code =
              err instanceof TenancyError ? (err.issues?.[0]?.code ?? err.code) : 'failed';
            items.push({ text, outcome: 'failed', code });
            if (i === 0 && lines.length === 1) throw err;
          }
        }
        const saved = items.filter((x) => x.outcome === 'saved');
        if (!saved.length)
          throw invalid(issue('/items', 'nothing_saved', 'Nothing could be saved. Try again.'));
        this.d.metrics.count('capture.items', saved.length, { outcome: 'saved' });
        if (saved.length < items.length)
          this.d.metrics.count('capture.items', items.length - saved.length, { outcome: 'failed' });
        const attachments = files.map((f, i) => ({
          name: isObj(f) && typeof f.name === 'string' ? f.name.slice(0, 255) : `file ${i + 1}`,
          outcome: 'refused' as const,
          code: 'storage_unavailable',
        }));
        return {
          status: 201,
          ref: { id: saved[0]!.id!, type: 'inbox_item' },
          data: {
            id: saved[0]!.id!,
            type: 'inbox_item' as const,
            batch: batch ? batchRef(batch) : null,
            items,
            links: parsedLinks.length,
            attachments,
          },
        };
      },
      async (tx, p, ref) => {
        const it = await this.ownItem(tx, p, ref.id);
        const batch = it.capture_batch_id;
        const rows = batch
          ? await tx.db
              .selectFrom('capture.inbox_item as i')
              .innerJoin('core.record as r', 'r.id', 'i.id')
              .select(['r.public_id', 'i.raw_text'])
              .where('i.capture_batch_id', '=', batch)
              .where('i.owner_membership_id', '=', p.membershipId)
              .orderBy('i.created_at')
              .orderBy('i.id')
              .execute()
          : [{ public_id: ref.id, raw_text: it.raw_text }];
        return {
          id: ref.id,
          type: 'inbox_item' as const,
          batch: batch ? batchRef(batch) : null,
          items: rows.map((r) => ({
            id: r.public_id,
            text: r.raw_text,
            outcome: 'saved' as const,
          })),
          links: 0,
          attachments: [] as Array<{ name: string; outcome: 'refused'; code: string }>,
        };
      },
    );
  }

  protected async markConverted(
    tx: WorkspaceTransaction,
    itemId: string,
    kind: 'task' | 'note' | 'project',
    recordId: string,
  ) {
    await tx.db
      .updateTable('capture.inbox_item')
      .set({
        triage_state: 'converted',
        converted_kind: kind,
        converted_record_id: recordId,
        triaged_at: new Date(),
        updated_at: new Date(),
        version: sql`version + 1` as never,
      })
      .where('id', '=', itemId)
      .execute();
  }

  // ---------------------------------------------------------------------------------------------
  // The Inbox (owner only; OD-03, AT-138)
  // ---------------------------------------------------------------------------------------------

  /** The caller's own item; anyone else's (or unknown) is not_found with the same statements. */
  protected async ownItem(tx: WorkspaceTransaction, p: Principal, inb: unknown, lock = false) {
    let q = tx.db
      .selectFrom('capture.inbox_item as i')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'i.workspace_id').onRef('r.id', '=', 'i.id'),
      )
      .leftJoin('core.record as br', 'br.id', 'i.brand_id')
      .selectAll('i')
      .select(['r.public_id', 'br.public_id as brand_public_id'])
      .where('r.public_id', '=', isPublic(inb, 'inb') ? inb : 'inb_0')
      .where('i.owner_membership_id', '=', p.membershipId)
      .where('r.lifecycle_state', '=', 'active');
    if (lock) q = q.forUpdate('i');
    const row = await q.executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    return row;
  }

  protected async itemView(
    tx: WorkspaceTransaction,
    row: Awaited<ReturnType<CaptureService['ownItem']>>,
  ) {
    const links = await tx.db
      .selectFrom('relations.record_link')
      .select(['public_id', 'url', 'title'])
      .where('source_record_id', '=', row.id)
      .orderBy('rank')
      .execute();
    const converted = row.converted_record_id
      ? await tx.db
          .selectFrom('core.record')
          .select(['public_id', 'lifecycle_state'])
          .where('id', '=', row.converted_record_id)
          .executeTakeFirst()
      : null;
    const merged = row.merged_into_id ? await this.publicOf(tx, row.merged_into_id) : null;
    const absorbed = await tx.db
      .selectFrom('capture.inbox_item as i')
      .innerJoin('core.record as r', 'r.id', 'i.id')
      .select(['r.public_id', 'i.raw_text', 'i.created_at'])
      .where('i.merged_into_id', '=', row.id)
      .orderBy('i.created_at')
      .execute();
    const parsed = (typeof row.parsed === 'string' ? JSON.parse(row.parsed) : row.parsed) as {
      title?: string;
      detected?: Detected[];
    };
    return {
      id: row.public_id,
      type: 'inbox_item' as const,
      intent: row.intent,
      raw_text: row.raw_text,
      source: { kind: row.source_kind, ...(row.source_ref ? { ref: row.source_ref } : {}) },
      brand: row.brand_public_id,
      parser_version: row.parse_version,
      title: parsed.title ?? row.raw_text.split('\n')[0],
      detected: parsed.detected ?? [],
      triage_state: row.triage_state,
      converted: converted ? { kind: row.converted_kind, id: converted.public_id } : null,
      merged_into: merged,
      merged_from: absorbed.map((a) => ({
        id: a.public_id,
        raw_text: a.raw_text,
        captured_at: new Date(a.created_at).toISOString(),
      })),
      links: links.map((l) => ({ id: l.public_id, url: l.url, title: l.title })),
      captured_at: new Date(row.created_at).toISOString(),
      version: Number(row.version),
    };
  }

  async getInboxItem(caller: Caller, ws: unknown, inb: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) =>
      this.itemView(tx, await this.ownItem(tx, p, inb)),
    );
  }

  /** The person's own Inbox: untriaged (default) or everything, newest first, keyset paged. */
  async listInbox(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const state = query.state === 'all' ? 'all' : 'untriaged';
    const limit = Math.min(
      this.ws.pageLimitMax,
      Math.max(1, Number(query.limit) || this.ws.pageLimitDefault),
    );
    let after: { t: string; i: string } | null = null;
    if (typeof query.cursor === 'string') {
      try {
        const c = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
        if (typeof c.t !== 'string' || typeof c.i !== 'string' || !/^[0-9a-f-]{36}$/.test(c.i))
          throw new Error('cursor');
        after = c;
      } catch {
        throw new TenancyError('cursor_invalid');
      }
    }
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      let q = tx.db
        .selectFrom('capture.inbox_item as i')
        .innerJoin('core.record as r', 'r.id', 'i.id')
        .leftJoin('core.record as br', 'br.id', 'i.brand_id')
        .select([
          'i.id',
          'r.public_id',
          'i.raw_text',
          'i.intent',
          'i.source_kind',
          'i.triage_state',
          'i.parsed',
          'i.created_at',
          'i.version',
          'br.public_id as brand',
        ])
        .where('i.owner_membership_id', '=', p.membershipId)
        .where('r.lifecycle_state', '=', 'active');
      if (state === 'untriaged') q = q.where('i.triage_state', '=', 'untriaged');
      if (after)
        q = q.where(
          sql<boolean>`(i.created_at, i.id) < (${after.t}::timestamptz, ${after.i}::uuid)`,
        );
      const rows = await q
        .orderBy('i.created_at', 'desc')
        .orderBy('i.id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        data: page.map((r) => {
          const parsed = (typeof r.parsed === 'string' ? JSON.parse(r.parsed) : r.parsed) as {
            title?: string;
            detected?: Detected[];
          };
          return {
            id: r.public_id,
            type: 'inbox_item' as const,
            intent: r.intent,
            raw_text: r.raw_text,
            title: parsed.title ?? r.raw_text.split('\n')[0],
            detected: parsed.detected ?? [],
            source: { kind: r.source_kind },
            brand: r.brand,
            triage_state: r.triage_state,
            captured_at: new Date(r.created_at).toISOString(),
            version: Number(r.version),
          };
        }),
        page: {
          has_more: rows.length > limit,
          ...(rows.length > limit && last
            ? {
                next_cursor: Buffer.from(
                  JSON.stringify({ t: new Date(last.created_at).toISOString(), i: last.id }),
                ).toString('base64url'),
              }
            : {}),
        },
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Triage (CAP-012, PRJ-017)
  // ---------------------------------------------------------------------------------------------

  protected parseTriage(body: unknown) {
    const b = isObj(body) ? body : {};
    const to = b.to as TriageTarget;
    if (!['task', 'note', 'project', 'discard'].includes(to))
      throw invalid(issue('/to', 'invalid_option', 'Choose task, note, project, or discard.'));
    const ids = Array.isArray(b.items) ? [...new Set(b.items)] : [];
    if (!ids.length) throw invalid(issue('/items', 'required', 'Choose at least one item.'));
    if (ids.length > this.ws.triageBatchMax)
      throw invalid(
        issue('/items', 'too_many', `Triage at most ${this.ws.triageBatchMax} items at once.`),
      );
    const choices = isObj(b.choices) ? (b.choices as Record<string, unknown>) : {};
    const overrides = isObj(b.overrides) ? b.overrides : {};
    return {
      to,
      ids: ids as string[],
      brand: typeof b.brand === 'string' ? b.brand : null,
      project: typeof b.project === 'string' ? b.project : null,
      choices,
      overrides,
    };
  }

  /**
   * What one item becomes: fields from its parse and the person's choices. An ambiguous value with
   * no choice blocks the item (`needs_confirmation`); a choice of null drops that value.
   */
  protected planFields(
    item: Awaited<ReturnType<CaptureService['ownItem']>>,
    choices: Record<string, unknown>,
    overrides: Record<string, unknown>,
  ) {
    const parsed = (typeof item.parsed === 'string' ? JSON.parse(item.parsed) : item.parsed) as {
      title?: string;
      detected?: Detected[];
    };
    const detected = parsed.detected ?? [];
    const pending: string[] = [];
    const out: Record<string, unknown> = {
      title:
        typeof overrides.title === 'string' && overrides.title.trim()
          ? overrides.title.trim().slice(0, 300)
          : (parsed.title || item.raw_text.split('\n')[0]!).slice(0, 300),
    };
    const labels: string[] = [];
    for (const d of detected) {
      const chosenKey = `${d.field}@${d.start}`;
      let value = d.value;
      if (d.status === 'ambiguous') {
        if (!(chosenKey in choices) && !(d.field in choices)) {
          pending.push(d.field);
          continue;
        }
        value = chosenKey in choices ? choices[chosenKey] : choices[d.field];
        if (
          value !== null &&
          !d.options?.some((o) => JSON.stringify(o.value) === JSON.stringify(value))
        ) {
          pending.push(d.field);
          continue;
        }
      }
      if (value === null || d.status === 'unresolved') continue;
      if (d.field === 'label') labels.push(String(value));
      else out[d.field] = value;
    }
    for (const k of ['due_date', 'priority', 'estimate_minutes'] as const)
      if (overrides[k] !== undefined) out[k] = overrides[k];
    return { fields: out, labels, pending };
  }

  protected async triageOne(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    inb: string,
    plan: ReturnType<CaptureService['parseTriage']>,
    apply: boolean,
  ): Promise<Record<string, unknown>> {
    const item = await this.ownItem(tx, p, inb, apply);
    if (item.triage_state !== 'untriaged')
      return { item: inb, outcome: 'invalid', code: 'already_triaged' };
    const { fields, labels, pending } = this.planFields(item, plan.choices, plan.overrides);
    if (plan.to === 'discard') {
      if (apply) {
        await tx.db
          .updateTable('capture.inbox_item')
          .set({
            triage_state: 'discarded',
            triaged_at: new Date(),
            updated_at: new Date(),
            version: sql`version + 1` as never,
          })
          .where('id', '=', item.id)
          .execute();
        await this.triageAudit(tx, caller, p, item, 'discarded', null);
      }
      return { item: inb, outcome: apply ? 'applied' : 'ready', to: 'discard' };
    }
    if (plan.to === 'note') {
      if (apply) {
        const n = await this.insertNote(tx, caller, p, {
          brandId: item.brand_id,
          title: String(fields.title),
          body: item.raw_text,
          source: item.id,
        });
        await this.markConverted(tx, item.id, 'note', n.id);
        await this.recordConversion(
          tx,
          p,
          { id: item.id, kind: 'inbox_item' },
          { id: n.id, kind: 'note' },
        );
        await this.triageAudit(tx, caller, p, item, 'note', n);
        return { item: inb, outcome: 'applied', to: 'note', record: n.publicId };
      }
      return { item: inb, outcome: 'ready', to: 'note', title: fields.title };
    }
    // Task or project: a brand is required (OD-03); record.create is decided now and again at apply.
    const brandPublic =
      plan.brand ??
      (typeof fields.brand === 'string' ? fields.brand : null) ??
      item.brand_public_id ??
      null;
    if (!brandPublic) return { item: inb, outcome: 'invalid', code: 'brand_required', fields };
    const projectPublic =
      plan.to === 'task'
        ? (plan.project ?? (typeof fields.project === 'string' ? fields.project : null))
        : null;
    let c;
    try {
      c = await this.resolveContainer(
        tx,
        p,
        { brand: brandPublic, ...(projectPublic ? { project: projectPublic } : {}) },
        null,
      );
      this.requireCreateIn(p, c);
    } catch (err) {
      if (err instanceof TenancyError)
        return {
          item: inb,
          outcome:
            err.code === 'not_found'
              ? 'not_found'
              : err.code === 'forbidden'
                ? 'forbidden'
                : 'invalid',
          code: err.issues?.[0]?.code ?? err.code,
        };
      throw err;
    }
    if (pending.length)
      return { item: inb, outcome: 'invalid', code: 'needs_confirmation', pending, fields };
    if (!apply) return { item: inb, outcome: 'ready', to: plan.to, fields, labels };
    if (plan.to === 'project') {
      const created = await this.insertProject(tx, caller, p, {
        brandId: c.brand.id,
        parent: null,
        fields: {
          name: String(fields.title),
          ...(fields.due_date ? { target_date: fields.due_date } : {}),
          ...(fields.priority ? { priority: fields.priority } : {}),
        },
        sourceKind: item.source_kind === 'form' ? 'form' : 'ui',
        intakeSourceId: item.id,
      });
      await this.markConverted(tx, item.id, 'project', created.id);
      await this.recordConversion(
        tx,
        p,
        { id: item.id, kind: 'inbox_item' },
        { id: created.id, kind: 'project' },
      );
      await this.triageAudit(tx, caller, p, item, 'project', created);
      return { item: inb, outcome: 'applied', to: 'project', record: created.publicId };
    }
    const taskFields: Record<string, unknown> = { title: fields.title };
    if (fields.due_date) taskFields.due_date = fields.due_date;
    if (fields.deadline) taskFields.deadline = { date: fields.deadline };
    if (fields.priority) taskFields.priority = fields.priority;
    if (
      typeof fields.estimate_minutes === 'number' &&
      fields.estimate_minutes <= this.ws.taskEstimateMinutesMax
    )
      taskFields.estimate_minutes = fields.estimate_minutes;
    const created = await this.insertTask(tx, caller, p, c, taskFields, {
      source: item.source_kind === 'paste' ? 'paste' : item.source_kind === 'form' ? 'form' : 'ui',
      origin: { kind: 'intake', ref: { inbox: item.public_id } },
    });
    const omitted: string[] = [];
    const t = await this.loadTask(tx, p, created.publicId, { lock: true });
    for (const lbl of labels)
      await this.toggleLabel(tx, caller, p, t, lbl, 'add').catch(() => omitted.push('label'));
    if (typeof fields.owner === 'string') {
      const m = await tx.db
        .selectFrom('tenancy.membership')
        .select(['id', 'kind', 'state'])
        .where('public_id', '=', fields.owner)
        .executeTakeFirst();
      if (m && m.kind === 'member' && m.state === 'active') {
        await tx.db
          .insertInto('work.task_assignee')
          .values({
            workspace_id: tx.workspaceId,
            brand_id: c.brand.id,
            task_id: t.id,
            membership_id: m.id,
            is_primary: true,
            rank: '1',
            assigned_by_membership_id: p.membershipId,
          })
          .execute();
        await recordAssignmentChange(tx, {
          taskId: t.id,
          actorMembershipId: p.membershipId,
          via: 'assign',
          before: [],
          after: [m.id],
        });
      } else omitted.push('owner');
    }
    if (isObj(fields.recurrence)) {
      const fresh = await this.loadTask(tx, p, created.publicId, { lock: true });
      if (this.taskCapabilities(p, fresh).manage_recurrence) {
        const r = fields.recurrence as { frequency: string; interval: number; weekdays?: string[] };
        const rrule = composeRule({
          frequency: r.frequency as never,
          interval: r.interval,
          weekdays: (r.weekdays as never) ?? null,
          monthDays: null,
          ends: { type: 'never' },
        } as never);
        const start = `${(fields.due_date as string | undefined) ?? new Date().toISOString().slice(0, 10)}T09:00`;
        await this.createTaskSeries(tx, caller, p, fresh, {
          rrule,
          rule: parseRule(rrule),
          anchor_tz: fresh.brand.timezone || 'UTC',
          start,
        });
      } else omitted.push('recurrence');
    }
    await this.markConverted(tx, item.id, 'task', created.id);
    await this.recordConversion(
      tx,
      p,
      { id: item.id, kind: 'inbox_item' },
      { id: created.id, kind: 'task' },
    );
    await tx.db
      .insertInto('relations.record_link')
      .columns([
        'id',
        'public_id',
        'workspace_id',
        'source_record_id',
        'target_kind',
        'url',
        'target_record_id',
        'title',
        'rank',
        'created_by_membership_id',
      ])
      .expression((eb) =>
        eb
          .selectFrom('relations.record_link as l')
          .select([
            sql`uuidv7()`.as('id'),
            sql`'lnk_' || upper(substr(replace(uuidv7()::text, '-', ''), 1, 26))`.as('public_id'),
            'l.workspace_id',
            sql`${created.id}::uuid`.as('source_record_id'),
            'l.target_kind',
            'l.url',
            'l.target_record_id',
            'l.title',
            'l.rank',
            sql`${p.membershipId}::uuid`.as('created_by_membership_id'),
          ])
          .where('l.source_record_id', '=', item.id),
      )
      .execute()
      .catch(() => omitted.push('links'));
    await this.triageAudit(tx, caller, p, item, 'task', created);
    return { item: inb, outcome: 'applied', to: 'task', record: created.publicId, omitted };
  }

  protected async triageAudit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    item: { id: string; public_id: string; brand_id: string | null },
    outcome: string,
    created: { id: string; publicId: string } | null,
  ) {
    await this.workWriter.write(tx, this.cmd(caller, p, item.brand_id), {
      action: 'capture.triaged',
      target: { recordId: item.id, type: 'inbox_item', publicId: item.public_id },
      changes: [
        change.plain('outcome', null, outcome),
        ...(created ? [change.plain('converted_to', null, created.publicId)] : []),
      ],
    });
    await writeOutboxEvent(tx, {
      type: 'capture.inbox.triaged',
      aggregate: { type: 'capture.inbox_item', id: item.id, sequence: 1 },
      data: { outcome, converted_record_id: created?.id ?? null },
      actor: { type: 'human', id: p.membershipId },
      context: this.exec(caller, p),
      ...(item.brand_id ? { brandId: item.brand_id } : {}),
    });
    this.d.metrics.count('capture.triage', 1, { outcome });
  }

  /** The permission-checked preview of a triage (nothing changes). */
  async previewTriage(caller: Caller, ws: unknown, body: unknown) {
    const plan = this.parseTriage(body);
    // Not read-only: container resolution takes the same row locks apply takes (no writes).
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const items: Array<Record<string, unknown>> = [];
      for (const id of plan.ids) {
        try {
          items.push(await this.triageOne(tx, caller, p, id, plan, false));
        } catch (err) {
          if (err instanceof TenancyError && err.code === 'not_found')
            items.push({ item: id, outcome: 'not_found' });
          else throw err;
        }
      }
      return { to: plan.to, items };
    });
  }

  /** Applies a triage: each item is decided again and changed in its own savepoint, all reported. */
  async triage(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const plan = this.parseTriage(body);
    return this.mutate(
      caller,
      'capture.triage',
      ws,
      req,
      async (tx, p) => {
        const items: Array<Record<string, unknown>> = [];
        for (const id of plan.ids) {
          await sql`SAVEPOINT triage_item`.execute(tx.db);
          try {
            const r = await this.triageOne(tx, caller, p, id, plan, true);
            await sql`RELEASE SAVEPOINT triage_item`.execute(tx.db);
            items.push(r);
          } catch (err) {
            await sql`ROLLBACK TO SAVEPOINT triage_item`.execute(tx.db);
            if (!(err instanceof TenancyError)) throw err;
            items.push({
              item: id,
              outcome:
                err.code === 'not_found'
                  ? 'not_found'
                  : err.code === 'forbidden'
                    ? 'forbidden'
                    : 'invalid',
              code: err.issues?.[0]?.code ?? err.code,
            });
          }
        }
        const first = plan.ids[0]!;
        return {
          status: 200,
          ref: { id: first, type: 'inbox_item' },
          data: { id: first, type: 'inbox_item' as const, to: plan.to, items },
        };
      },
      async (_tx, _p, ref) => ({
        id: ref.id,
        type: 'inbox_item' as const,
        to: plan.to,
        items: [] as Array<Record<string, unknown>>,
      }),
    );
  }

  /** Puts a merged or discarded item back in the Inbox (its owner only). */
  async restoreInboxItem(caller: Caller, ws: unknown, inb: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'capture.restore',
      ws,
      req,
      async (tx, p) => {
        const item = await this.ownItem(tx, p, inb, true);
        if (item.triage_state !== 'merged' && item.triage_state !== 'discarded')
          throw new TenancyError('conflict', {
            issues: [
              issue('/', 'invalid_state', 'Only merged or discarded items can be restored.'),
            ],
          });
        await tx.db
          .updateTable('capture.inbox_item')
          .set({
            triage_state: 'untriaged',
            merged_into_id: null,
            triaged_at: null,
            updated_at: new Date(),
            version: sql`version + 1` as never,
          })
          .where('id', '=', item.id)
          .execute();
        await this.triageAudit(tx, caller, p, item, 'restored', null);
        return {
          status: 200,
          ref: { id: item.public_id, type: 'inbox_item' },
          data: await this.itemView(tx, await this.ownItem(tx, p, item.public_id)),
        };
      },
      async (tx, p, ref) => this.itemView(tx, await this.ownItem(tx, p, ref.id)),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Merge (CAP-013): one retained item; the others stay, marked merged, with their text and history.
  // ---------------------------------------------------------------------------------------------

  protected parseMerge(body: unknown) {
    const b = isObj(body) ? body : {};
    const items = Array.isArray(b.items) ? [...new Set(b.items as string[])] : [];
    if (items.length < 2)
      throw invalid(issue('/items', 'required', 'Choose at least two items to merge.'));
    if (items.length > this.ws.inboxMergeMax)
      throw invalid(
        issue('/items', 'too_many', `Merge at most ${this.ws.inboxMergeMax} items at once.`),
      );
    const keep = typeof b.keep === 'string' ? b.keep : items[0]!;
    if (!items.includes(keep))
      throw invalid(issue('/keep', 'invalid_reference', 'Keep one of the chosen items.'));
    return { items, keep };
  }

  async previewMerge(caller: Caller, ws: unknown, body: unknown) {
    const m = this.parseMerge(body);
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const rows = [];
      for (const id of m.items) {
        const r = await this.ownItem(tx, p, id);
        if (r.triage_state !== 'untriaged')
          throw invalid(issue('/items', 'already_triaged', 'Only untriaged items can be merged.'));
        rows.push(r);
      }
      return {
        keep: m.keep,
        items: rows.map((r) => ({
          id: r.public_id,
          raw_text: r.raw_text,
          source: { kind: r.source_kind },
          captured_at: new Date(r.created_at).toISOString(),
          role: r.public_id === m.keep ? 'kept' : 'merged',
        })),
        preserved:
          'Every original text, source, and history entry is kept; merged items can be restored.',
      };
    });
  }

  async merge(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const m = this.parseMerge(body);
    return this.mutate(
      caller,
      'capture.merge',
      ws,
      req,
      async (tx, p) => {
        const rows = [];
        for (const id of m.items) {
          const r = await this.ownItem(tx, p, id, true);
          if (r.triage_state !== 'untriaged')
            throw new TenancyError('conflict', {
              issues: [
                issue('/items', 'already_triaged', 'One of these items was triaged meanwhile.'),
              ],
            });
          rows.push(r);
        }
        const keep = rows.find((r) => r.public_id === m.keep)!;
        for (const r of rows.filter((x) => x.id !== keep.id)) {
          await tx.db
            .updateTable('capture.inbox_item')
            .set({
              triage_state: 'merged',
              merged_into_id: keep.id,
              triaged_at: new Date(),
              updated_at: new Date(),
              version: sql`version + 1` as never,
            })
            .where('id', '=', r.id)
            .execute();
          await this.triageAudit(tx, caller, p, r, 'merged', {
            id: keep.id,
            publicId: keep.public_id,
          });
        }
        await writeOutboxEvent(tx, {
          type: 'capture.inbox.merged',
          aggregate: {
            type: 'capture.inbox_item',
            id: keep.id,
            sequence: Number(keep.version) + 1,
          },
          data: { merged_count: rows.length - 1 },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
        });
        return {
          status: 200,
          ref: { id: keep.public_id, type: 'inbox_item' },
          data: await this.itemView(tx, await this.ownItem(tx, p, keep.public_id)),
        };
      },
      async (tx, p, ref) => this.itemView(tx, await this.ownItem(tx, p, ref.id)),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Notes (CAP-002, CAP-014)
  // ---------------------------------------------------------------------------------------------

  protected async ownNote(tx: WorkspaceTransaction, p: Principal, note: unknown, lock = false) {
    let q = tx.db
      .selectFrom('capture.note as n')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'n.workspace_id').onRef('r.id', '=', 'n.id'),
      )
      .leftJoin('core.record as br', 'br.id', 'n.brand_id')
      .selectAll('n')
      .select(['r.public_id', 'br.public_id as brand_public_id'])
      .where('r.public_id', '=', isPublic(note, 'note') ? note : 'note_0')
      .where('n.owner_membership_id', '=', p.membershipId)
      .where('r.lifecycle_state', '=', 'active');
    if (lock) q = q.forUpdate('n');
    const row = await q.executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    return row;
  }

  protected async noteView(
    tx: WorkspaceTransaction,
    n: Awaited<ReturnType<CaptureService['ownNote']>>,
  ) {
    const conversions = await tx.db
      .selectFrom('capture.capture_conversion as c')
      .innerJoin('core.record as r', 'r.id', 'c.target_record_id')
      .select(['c.target_kind', 'r.public_id', 'c.created_at'])
      .where('c.source_record_id', '=', n.id)
      .orderBy('c.created_at')
      .execute();
    return {
      id: n.public_id,
      type: 'note' as const,
      title: n.title,
      body: n.body,
      brand: n.brand_public_id,
      source_inbox_item: n.source_inbox_item_id
        ? await this.publicOf(tx, n.source_inbox_item_id)
        : null,
      conversions: conversions.map((c) => ({
        kind: c.target_kind,
        id: c.public_id,
        at: new Date(c.created_at).toISOString(),
      })),
      updated_at: new Date(n.updated_at).toISOString(),
      version: Number(n.version),
    };
  }

  async listNotes(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const rows = await tx.db
        .selectFrom('capture.note as n')
        .innerJoin('core.record as r', 'r.id', 'n.id')
        .select(['r.public_id', 'n.title', 'n.updated_at', 'n.version'])
        .where('n.owner_membership_id', '=', p.membershipId)
        .where('r.lifecycle_state', '=', 'active')
        .orderBy('n.updated_at', 'desc')
        .orderBy('n.id')
        .limit(this.ws.pageLimitMax)
        .execute();
      return rows.map((r) => ({
        id: r.public_id,
        type: 'note' as const,
        title: r.title,
        updated_at: new Date(r.updated_at).toISOString(),
        version: Number(r.version),
      }));
    });
  }

  async getNote(caller: Caller, ws: unknown, note: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) =>
      this.noteView(tx, await this.ownNote(tx, p, note)),
    );
  }

  async updateNote(caller: Caller, ws: unknown, note: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    for (const k of Object.keys(b))
      if (!['title', 'body', 'version'].includes(k))
        throw invalid(issue(`/${k}`, 'unsupported_field', 'This field is not supported.'));
    if (
      b.title !== undefined &&
      (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 300)
    )
      throw invalid(issue('/title', 'required', 'Give the note a title (at most 300 characters).'));
    if (
      b.body !== undefined &&
      (typeof b.body !== 'string' || b.body.length > this.ws.captureTextMax)
    )
      throw invalid(
        issue('/body', 'too_long', `Keep a note under ${this.ws.captureTextMax} characters.`),
      );
    return this.mutate(
      caller,
      'note.update',
      ws,
      req,
      async (tx, p) => {
        const n = await this.ownNote(tx, p, note, true);
        const expected =
          req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (b.version as number | undefined);
        if (expected === undefined) throw new TenancyError('precondition_required');
        requireVersion(expected, Number(n.version));
        await tx.db
          .updateTable('capture.note')
          .set({
            ...(b.title !== undefined ? { title: (b.title as string).trim() } : {}),
            ...(b.body !== undefined ? { body: b.body as string } : {}),
            updated_at: new Date(),
            version: Number(n.version) + 1,
          })
          .where('id', '=', n.id)
          .execute();
        await this.workWriter.write(tx, this.cmd(caller, p, n.brand_id), {
          action: 'note.updated',
          target: { recordId: n.id, type: 'note', publicId: n.public_id },
          changes: [
            ...(b.title !== undefined
              ? [change.content('title', { hash: hash(b.title as string) })]
              : []),
            ...(b.body !== undefined
              ? [change.content('body', { hash: hash(b.body as string) })]
              : []),
          ],
        });
        return {
          status: 200,
          ref: { id: n.public_id, type: 'note' },
          data: await this.noteView(tx, await this.ownNote(tx, p, n.public_id)),
        };
      },
      async (tx, p, ref) => this.noteView(tx, await this.ownNote(tx, p, ref.id)),
    );
  }

  /**
   * Converts a note into a task or project after explicit confirmation (CAP-014). Mapping: the
   * note title becomes the task title or project name; the body is parsed for dates, priority,
   * and duration. The note stays and records the conversion.
   */
  async convertNote(caller: Caller, ws: unknown, note: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    if (b.to !== 'task' && b.to !== 'project')
      throw invalid(issue('/to', 'invalid_option', 'Convert to a task or a project.'));
    if (b.confirm !== true)
      throw invalid(issue('/confirm', 'required', 'Confirm the conversion; the note is kept.'));
    if (typeof b.brand !== 'string')
      throw invalid(issue('/brand', 'brand_required', 'Choose which brand it belongs to.'));
    return this.mutate(
      caller,
      'note.convert',
      ws,
      req,
      async (tx, p) => {
        const n = await this.ownNote(tx, p, note, true);
        const c = await this.resolveContainer(
          tx,
          p,
          {
            brand: b.brand as string,
            ...(b.to === 'task' && typeof b.project === 'string' ? { project: b.project } : {}),
          },
          null,
        );
        this.requireCreateIn(p, c);
        const parsed = parseCapture(n.body.split('\n')[0] ?? '', {
          today: this.today(b.today),
          tokensMax: this.ws.captureParseTokensMax,
        });
        const value = (f: string) =>
          parsed.tokens.find((t) => t.field === f && t.value !== null)?.value;
        let created: { id: string; publicId: string };
        if (b.to === 'project') {
          created = await this.insertProject(tx, caller, p, {
            brandId: c.brand.id,
            parent: null,
            fields: {
              name: n.title,
              ...(value('due_date') ? { target_date: value('due_date') } : {}),
            },
            sourceKind: 'ui',
            intakeSourceId: n.id,
          });
        } else {
          created = await this.insertTask(
            tx,
            caller,
            p,
            c,
            {
              title: n.title,
              ...(value('due_date') ? { due_date: value('due_date') } : {}),
              ...(value('priority') ? { priority: value('priority') } : {}),
              ...(typeof value('estimate_minutes') === 'number'
                ? { estimate_minutes: value('estimate_minutes') }
                : {}),
            },
            { origin: { kind: 'intake', ref: { note: n.public_id } } },
          );
        }
        await this.recordConversion(
          tx,
          p,
          { id: n.id, kind: 'note' },
          { id: created.id, kind: b.to as 'task' | 'project' },
        );
        await this.workWriter.write(tx, this.cmd(caller, p, n.brand_id), {
          action: 'note.converted',
          target: { recordId: n.id, type: 'note', publicId: n.public_id },
          changes: [
            change.plain('converted_to', null, created.publicId),
            change.plain('kind', null, b.to),
          ],
        });
        await writeOutboxEvent(tx, {
          type: 'capture.note.converted',
          aggregate: { type: 'capture.note', id: n.id, sequence: Number(n.version) + 1 },
          data: { target_kind: b.to as string, target_record_id: created.id },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: c.brand.id,
        });
        return {
          status: 201,
          ref: { id: n.public_id, type: 'note' },
          data: {
            ...(await this.noteView(tx, await this.ownNote(tx, p, n.public_id))),
            created: created.publicId,
          },
        };
      },
      async (tx, p, ref) => ({
        ...(await this.noteView(tx, await this.ownNote(tx, p, ref.id))),
        created: null as string | null,
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Intake forms (CAP-007, PRJ-017; members-only while OD-28 is open)
  // ---------------------------------------------------------------------------------------------

  protected formView(
    r: {
      public_id: string;
      name: string;
      description: string;
      target_kind: string;
      state: string;
      brand: string;
      owner?: string | null;
      version: number | string;
    },
    manage: boolean,
  ) {
    return {
      id: r.public_id,
      type: 'intake_form' as const,
      name: r.name,
      description: r.description,
      brand: r.brand,
      state: r.state,
      ...(manage ? { target_kind: r.target_kind, queue_owner: r.owner ?? null } : {}),
      version: Number(r.version),
    };
  }

  protected async loadForm(tx: WorkspaceTransaction, p: Principal, form: unknown, lock = false) {
    let q = tx.db
      .selectFrom('capture.intake_form as f')
      .innerJoin('core.record as r', (j) =>
        j.onRef('r.workspace_id', '=', 'f.workspace_id').onRef('r.id', '=', 'f.id'),
      )
      .innerJoin('tenancy.brand as b', 'b.id', 'f.brand_id')
      .innerJoin('core.record as br', 'br.id', 'f.brand_id')
      .innerJoin('tenancy.membership as m', 'm.id', 'f.queue_owner_membership_id')
      .selectAll('f')
      .select([
        'r.public_id',
        'br.public_id as brand',
        'b.is_sensitive',
        'b.lifecycle_state as brand_state',
        'm.public_id as owner',
        'm.state as owner_state',
      ])
      .where('r.public_id', '=', isPublic(form, 'form') ? form : 'form_0')
      .where('r.lifecycle_state', '=', 'active');
    if (lock) q = q.forUpdate('f');
    const f = await q.executeTakeFirst();
    // A form of a brand the person cannot read is as absent as an unknown one (AT-144).
    const facts = f
      ? { id: f.brand_id, isSensitive: f.is_sensitive, lifecycleState: 'active' as const }
      : { id: NIL, isSensitive: false, lifecycleState: 'active' as const };
    const readable = decideBrand(p, 'record.read', facts).allowed;
    if (!f || !readable || f.brand_state !== 'active') throw new TenancyError('not_found');
    return f;
  }

  protected requireIntakeManage(p: Principal, brand: { id: string; is_sensitive: boolean }) {
    const o = decideBrand(p, 'intake.manage', {
      id: brand.id,
      isSensitive: brand.is_sensitive,
      lifecycleState: 'active',
    });
    this.decision('intake.manage', o);
    if (!o.allowed) throw new TenancyError(o.code);
  }

  /** Forms the person may use: active forms of readable brands; managers also see archived ones. */
  async listForms(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const rows = await tx.db
        .selectFrom('capture.intake_form as f')
        .innerJoin('core.record as r', 'r.id', 'f.id')
        .innerJoin('tenancy.brand as b', 'b.id', 'f.brand_id')
        .innerJoin('core.record as br', 'br.id', 'f.brand_id')
        .innerJoin('tenancy.membership as m', 'm.id', 'f.queue_owner_membership_id')
        .select([
          'r.public_id',
          'f.name',
          'f.description',
          'f.target_kind',
          'f.state',
          'f.version',
          'f.brand_id',
          'b.is_sensitive',
          'br.public_id as brand',
          'm.public_id as owner',
        ])
        .where('r.lifecycle_state', '=', 'active')
        .where('b.lifecycle_state', '=', 'active')
        .$call((q) =>
          typeof query.brand === 'string' ? q.where('br.public_id', '=', query.brand) : q,
        )
        .orderBy('f.name')
        .limit(500)
        .execute();
      if (p.kind !== 'member') return [];
      return rows.flatMap((r) => {
        const facts = {
          id: r.brand_id,
          isSensitive: r.is_sensitive,
          lifecycleState: 'active' as const,
        };
        if (!decideBrand(p, 'record.read', facts).allowed) return [];
        const manage = decideBrand(p, 'intake.manage', facts).allowed;
        if (r.state !== 'active' && !manage) return [];
        return [this.formView(r, manage)];
      });
    });
  }

  async getForm(caller: Caller, ws: unknown, form: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      if (p.kind !== 'member') throw new TenancyError('not_found');
      const f = await this.loadForm(tx, p, form);
      const manage = decideBrand(p, 'intake.manage', {
        id: f.brand_id,
        isSensitive: f.is_sensitive,
        lifecycleState: 'active',
      }).allowed;
      if (f.state !== 'active' && !manage) throw new TenancyError('not_found');
      return this.formView(f, manage);
    });
  }

  protected parseForm(b: Record<string, unknown>, creating: boolean) {
    for (const k of Object.keys(b))
      if (
        ![
          'brand',
          'name',
          'description',
          'target_kind',
          'queue_owner',
          'state',
          'version',
        ].includes(k)
      )
        throw invalid(issue(`/${k}`, 'unsupported_field', 'This field is not supported.'));
    if (
      (creating || b.name !== undefined) &&
      (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 200)
    )
      throw invalid(issue('/name', 'required', 'Name the form (at most 200 characters).'));
    if (
      b.description !== undefined &&
      (typeof b.description !== 'string' || b.description.length > 2000)
    )
      throw invalid(
        issue('/description', 'too_long', 'Keep the description under 2000 characters.'),
      );
    if (b.target_kind !== undefined && b.target_kind !== 'task' && b.target_kind !== 'project')
      throw invalid(
        issue('/target_kind', 'invalid_option', 'Submissions become tasks or projects.'),
      );
    if (b.state !== undefined && b.state !== 'active' && b.state !== 'archived')
      throw invalid(issue('/state', 'invalid_option', 'Choose active or archived.'));
  }

  /** The queue owner must be an active member who can read the brand (AZ-25). */
  protected async queueOwner(
    tx: WorkspaceTransaction,
    ref: unknown,
    brand: { id: string; is_sensitive: boolean },
  ) {
    const m = isPublic(ref, 'mem')
      ? await tx.db
          .selectFrom('tenancy.membership')
          .select(['id', 'account_id', 'kind', 'state'])
          .where('public_id', '=', ref)
          .executeTakeFirst()
      : undefined;
    if (!m || m.kind !== 'member' || m.state !== 'active')
      throw invalid(
        issue('/queue_owner', 'invalid_reference', 'Choose an active member of this workspace.'),
      );
    const { compilePrincipal } = await import('@pm/tenancy');
    const q = await compilePrincipal(tx, m.id, m.account_id, 'member');
    if (
      !decideBrand(q, 'record.read', {
        id: brand.id,
        isSensitive: brand.is_sensitive,
        lifecycleState: 'active',
      }).allowed
    )
      throw invalid(
        issue('/queue_owner', 'invalid_reference', 'That person cannot see this brand.'),
      );
    return m.id;
  }

  async createForm(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    this.parseForm(b, true);
    return this.mutate(
      caller,
      'intake.form_create',
      ws,
      req,
      async (tx, p) => {
        const brand = await findBrand(tx, p, b.brand, { states: 'active' });
        this.requireIntakeManage(p, brand);
        const n = await tx.db
          .selectFrom('capture.intake_form')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('brand_id', '=', brand.id)
          .executeTakeFirstOrThrow();
        if (Number(n.n) >= this.ws.intakeFormsMax)
          throw invalid(
            issue(
              '/brand',
              'too_many',
              `A brand can have at most ${this.ws.intakeFormsMax} forms.`,
            ),
          );
        const owner =
          b.queue_owner === undefined
            ? p.membershipId
            : await this.queueOwner(tx, b.queue_owner, brand);
        const id = newUuidV7();
        const publicId = newPublicId('form');
        const cmd = this.cmd(caller, p, brand.id);
        await tx.db
          .insertInto('core.record')
          .values({
            id,
            public_id: publicId,
            record_type: 'intake_form',
            workspace_id: tx.workspaceId,
            brand_id: brand.id,
            source_kind: 'ui',
            source_ref: null,
            created_by_actor_type: cmd.actor.type,
            created_by_actor_id: cmd.actor.id,
          })
          .execute();
        await tx.db
          .insertInto('capture.intake_form')
          .values({
            id,
            workspace_id: tx.workspaceId,
            brand_id: brand.id,
            scope_key: brand.id,
            name: (b.name as string).trim(),
            description: typeof b.description === 'string' ? b.description : '',
            target_kind: (b.target_kind as 'task' | 'project' | undefined) ?? 'task',
            queue_owner_membership_id: owner,
            created_by_membership_id: p.membershipId,
          })
          .execute();
        await this.workWriter.write(tx, cmd, {
          action: 'intake.form_created',
          target: { recordId: id, type: 'intake_form', publicId },
          changes: [
            change.content('name', { hash: hash(b.name as string) }),
            change.plain('target_kind', null, (b.target_kind as string) ?? 'task'),
          ],
        });
        await writeOutboxEvent(tx, {
          type: 'capture.intake_form.created',
          aggregate: { type: 'capture.intake_form', id, sequence: 0 },
          data: { target_kind: (b.target_kind as string) ?? 'task' },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: brand.id,
        });
        const f = await this.loadForm(tx, p, publicId);
        return {
          status: 201,
          ref: { id: publicId, type: 'intake_form' },
          data: this.formView(f, true),
        };
      },
      async (tx, p, ref) => this.formView(await this.loadForm(tx, p, ref.id), true),
    );
  }

  async updateForm(caller: Caller, ws: unknown, form: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    this.parseForm(b, false);
    return this.mutate(
      caller,
      'intake.form_update',
      ws,
      req,
      async (tx, p) => {
        const f = await this.loadForm(tx, p, form, true);
        this.requireIntakeManage(p, { id: f.brand_id, is_sensitive: f.is_sensitive });
        const expected =
          req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (b.version as number | undefined);
        if (expected === undefined) throw new TenancyError('precondition_required');
        requireVersion(expected, Number(f.version));
        const owner =
          b.queue_owner === undefined
            ? undefined
            : await this.queueOwner(tx, b.queue_owner, {
                id: f.brand_id,
                is_sensitive: f.is_sensitive,
              });
        await tx.db
          .updateTable('capture.intake_form')
          .set({
            ...(b.name !== undefined ? { name: (b.name as string).trim() } : {}),
            ...(b.description !== undefined ? { description: b.description as string } : {}),
            ...(b.target_kind !== undefined
              ? { target_kind: b.target_kind as 'task' | 'project' }
              : {}),
            ...(b.state !== undefined ? { state: b.state as 'active' | 'archived' } : {}),
            ...(owner ? { queue_owner_membership_id: owner } : {}),
            updated_at: new Date(),
            version: Number(f.version) + 1,
          })
          .where('id', '=', f.id)
          .execute();
        await this.workWriter.write(tx, this.cmd(caller, p, f.brand_id), {
          action: 'intake.form_updated',
          target: { recordId: f.id, type: 'intake_form', publicId: f.public_id },
          changes: Object.keys(b)
            .filter((k) => k !== 'version')
            .map((k) =>
              k === 'name' || k === 'description'
                ? change.content(k, { hash: hash(String(b[k])) })
                : change.plain(k, null, k === 'queue_owner' ? 'changed' : (b[k] as string)),
            ),
        });
        await writeOutboxEvent(tx, {
          type: 'capture.intake_form.updated',
          aggregate: { type: 'capture.intake_form', id: f.id, sequence: Number(f.version) + 1 },
          data: { state: (b.state as string) ?? f.state },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: f.brand_id,
        });
        return {
          status: 200,
          ref: { id: f.public_id, type: 'intake_form' },
          data: this.formView(await this.loadForm(tx, p, f.public_id), true),
        };
      },
      async (tx, p, ref) => this.formView(await this.loadForm(tx, p, ref.id), true),
    );
  }

  /**
   * Submits a form (members who can read the brand; guests refused). The submission becomes an
   * Inbox item of the queue owner with the form's brand and `form` source; the submitter gets an
   * acknowledgement only and learns nothing about the queue.
   */
  async submitForm(caller: Caller, ws: unknown, form: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    const details = typeof b.details === 'string' ? b.details.trim() : '';
    if (!title) throw invalid(issue('/title', 'required', 'Say what you need.'));
    if (title.length + details.length + 2 > this.ws.captureTextMax)
      throw invalid(
        issue(
          '/details',
          'too_long',
          `Keep the request under ${this.ws.captureTextMax} characters.`,
        ),
      );
    return this.mutate(
      caller,
      'intake.submit',
      ws,
      req,
      async (tx, p) => {
        if (p.kind !== 'member') throw new TenancyError('not_found');
        const f = await this.loadForm(tx, p, form);
        const o = decideBrand(p, 'intake.submit', {
          id: f.brand_id,
          isSensitive: f.is_sensitive,
          lifecycleState: 'active',
        });
        this.decision('intake.submit', o);
        if (!o.allowed || f.state !== 'active') throw new TenancyError('not_found');
        await this.rateLimit('intake.submit', `${p.membershipId}:${f.id}`);
        if (f.owner_state !== 'active')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'form_unavailable', "This form isn't taking requests right now.")],
          });
        const text = details ? `${title}\n${details}` : title;
        const parsed = await this.candidate(tx, p, title, this.today(b.today), f.brand_id);
        const item = await this.insertInboxItem(tx, caller, p, {
          owner: f.queue_owner_membership_id,
          brandId: f.brand_id,
          intent: 'task',
          text,
          source: 'form',
          sourceRef: f.public_id,
          batch: null,
          parsed: {
            ...parsed,
            detected: parsed.detected.filter((d) => !['owner', 'brand'].includes(d.field)),
          },
        });
        await tx.db
          .insertInto('capture.intake_submission')
          .values({
            id: newUuidV7(),
            workspace_id: tx.workspaceId,
            form_id: f.id,
            submitter_membership_id: p.membershipId,
            inbox_item_id: item.id,
          })
          .execute();
        await writeOutboxEvent(tx, {
          type: 'capture.intake.submitted',
          aggregate: { type: 'capture.intake_form', id: f.id, sequence: Number(f.version) },
          data: { inbox_item_id: item.id },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: f.brand_id,
        });
        this.d.metrics.count('capture.items', 1, { outcome: 'form' });
        return {
          status: 201,
          ref: { id: f.public_id, type: 'intake_form' },
          data: { id: f.public_id, type: 'intake_form' as const, received: true },
        };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'intake_form' as const, received: true }),
    );
  }
}
