import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Issues } from '@pm/tenancy';

/**
 * Document content (ADR-0025 D2): rich-text version 2, an ordered list of blocks with stable
 * identifiers. Everything here is pure: parsing validates and normalizes untrusted input into one
 * canonical form (so equal content always has an equal hash), and the readers (plain text,
 * references, change summary, Markdown, HTML) never consult the database or authorization.
 * References carry no label: a viewer's label is looked up when it is shown, so nothing a viewer
 * may not read is ever stored in, or leaves with, the content (IA-46).
 */

export const CONTENT_VERSION = 2;

export const REF_KINDS = ['member', 'team', 'task', 'project', 'brand', 'document'] as const;
export type DocRefKind = (typeof REF_KINDS)[number];
export const RECORD_REF_KINDS = ['task', 'project', 'brand', 'document'] as const;
export type RecordRefKind = (typeof RECORD_REF_KINDS)[number];
export const DOC_REF_PREFIX: Record<DocRefKind, string> = {
  member: 'mem',
  team: 'team',
  task: 'tsk',
  project: 'prj',
  brand: 'br',
  document: 'doc',
};

export interface Ref {
  kind: DocRefKind;
  id: string;
}

/**
 * What a viewer receives in place of a reference they cannot read (IA-46): an opaque token that
 * names nothing (no kind, no identifier, no label). A save sends it back unchanged, and the server
 * restores the reference it stands for, so a person who cannot read a link never removes it.
 */
export interface RestrictedRef {
  kind: 'restricted';
  id: string;
}
export const RESTRICTED_KIND = 'restricted' as const;
export const RESTRICTED_ID = /^rst_[0-9a-f]{16}$/;
export const isRestrictedRef = (r: Ref | RestrictedRef): r is RestrictedRef =>
  r.kind === RESTRICTED_KIND;

/** One run of inline text, or one reference (a run with `ref` has no text). */
export interface Run {
  text?: string;
  bold?: true;
  italic?: true;
  code?: true;
  link?: string;
  ref?: Ref | RestrictedRef;
}

export const CALLOUT_TONES = ['info', 'warning', 'success'] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];
export const EMBED_KINDS = ['image', 'video', 'link'] as const;
export type EmbedKind = (typeof EMBED_KINDS)[number];

export type Block =
  | { id: string; type: 'paragraph'; runs: Run[] }
  | { id: string; type: 'heading'; level: 1 | 2 | 3; runs: Run[] }
  | { id: string; type: 'bulleted_list' | 'numbered_list'; items: Run[][] }
  | { id: string; type: 'checklist'; items: Array<{ runs: Run[]; checked: boolean }> }
  | { id: string; type: 'quote'; runs: Run[] }
  | { id: string; type: 'code'; language: string | null; text: string }
  | { id: string; type: 'table'; header: boolean; rows: string[][] }
  | { id: string; type: 'divider' }
  | { id: string; type: 'callout'; tone: CalloutTone; runs: Run[] }
  | {
      id: string;
      type: 'embed';
      kind: EmbedKind;
      url: string;
      title: string | null;
      alt: string | null;
    };
export type BlockType = Block['type'];
export const BLOCK_TYPES: readonly BlockType[] = [
  'paragraph',
  'heading',
  'bulleted_list',
  'numbered_list',
  'checklist',
  'quote',
  'code',
  'table',
  'divider',
  'callout',
  'embed',
];

export interface DocContent {
  v: 2;
  blocks: Block[];
}

export interface ContentLimits {
  bodyMaxBytes: number;
  blocksMax: number;
  blockTextMaxChars: number;
  tableCellsMax: number;
  referencesMax: number;
  embedUrlMaxChars: number;
}

export const DEFAULT_CONTENT_LIMITS: ContentLimits = Object.freeze({
  bodyMaxBytes: 262_144,
  blocksMax: 2_000,
  blockTextMaxChars: 20_000,
  tableCellsMax: 1_000,
  referencesMax: 500,
  embedUrlMaxChars: 2_048,
});

const BLOCK_ID = /^[A-Za-z0-9_-]{4,64}$/;
const LANGUAGE = /^[a-z0-9+#._-]{1,32}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A new block identifier: `b_` and twelve characters. */
export function newBlockId(): string {
  const bytes = randomBytes(12);
  let out = 'b_';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const refPattern = (kind: DocRefKind) =>
  new RegExp(`^${DOC_REF_PREFIX[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`);

/** Whether `id` is a well-formed public identifier of the reference kind. */
export const refIdOk = (kind: DocRefKind, id: unknown): id is string =>
  typeof id === 'string' && refPattern(kind).test(id);

/** A link or embed address: absolute, bounded, no credentials. */
export function safeUrl(
  raw: unknown,
  schemes: readonly string[],
  max: number,
): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > max || CONTROL.test(raw))
    return null;
  if (/\s/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!schemes.includes(u.protocol)) return null;
  if (u.protocol !== 'mailto:' && (u.username !== '' || u.password !== '' || u.hostname === ''))
    return null;
  return u.toString();
}

// -------------------------------------------------------------------------------------------
// Canonical form and hashes
// -------------------------------------------------------------------------------------------

/** JSON with every object's keys sorted, so storage order never changes a hash. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export const sha256 = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
export const documentContentHash = (c: DocContent) => sha256(stableStringify(c));
export const blockHash = (b: Block) => sha256(stableStringify(b));
export const contentBytes = (c: DocContent) => Buffer.byteLength(stableStringify(c), 'utf8');

// -------------------------------------------------------------------------------------------
// Parsing
// -------------------------------------------------------------------------------------------

type Strictness = { limits: ContentLimits; refs: Ref[]; restricted: string[]; issues: Issues };

function fields(
  b: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: Issues,
) {
  for (const k of Object.keys(b))
    if (!allowed.includes(k)) issues.add(`${path}/${k}`, 'unsupported_field', 'This field is not supported.');
}

function cleanText(v: unknown, path: string, max: number, issues: Issues): string {
  if (typeof v !== 'string') {
    issues.add(path, 'invalid_type', 'Use text.');
    return '';
  }
  const t = v.normalize('NFC').replace(/\r\n?/g, '\n');
  if (CONTROL.test(t)) issues.add(path, 'invalid_text', 'This text has characters that are not allowed.');
  if ([...t].length > max) {
    issues.add(path, 'too_long', `Use at most ${max} characters.`);
    return t.slice(0, max);
  }
  return t;
}

function parseRuns(v: unknown, path: string, st: Strictness): Run[] {
  const { limits, issues } = st;
  if (!Array.isArray(v)) {
    issues.add(path, 'invalid_type', 'Use a list of text runs.');
    return [];
  }
  const out: Run[] = [];
  let chars = 0;
  v.forEach((raw, i) => {
    const p = `${path}/${i}`;
    if (!isObject(raw)) {
      issues.add(p, 'invalid_type', 'Use a text run.');
      return;
    }
    fields(raw, ['text', 'bold', 'italic', 'code', 'link', 'ref'], p, issues);
    const run: Run = {};
    if (raw.ref !== undefined) {
      if (raw.text !== undefined)
        issues.add(`${p}/text`, 'not_allowed', 'A reference has no text of its own.');
      const r = raw.ref;
      if (isObject(r) && r.kind === RESTRICTED_KIND && typeof r.id === 'string' && RESTRICTED_ID.test(r.id)) {
        fields(r, ['kind', 'id'], `${p}/ref`, issues);
        st.restricted.push(r.id);
        run.ref = { kind: RESTRICTED_KIND, id: r.id };
        out.push(run);
        return;
      }
      if (
        !isObject(r) ||
        !(REF_KINDS as readonly unknown[]).includes(r.kind) ||
        !refIdOk(r.kind as DocRefKind, r.id)
      ) {
        issues.add(`${p}/ref`, 'invalid_reference', 'Choose from the list.');
        return;
      }
      fields(r, ['kind', 'id'], `${p}/ref`, issues);
      const ref = { kind: r.kind as DocRefKind, id: r.id as string };
      run.ref = ref;
      st.refs.push(ref);
      out.push(run);
      return;
    }
    const text = cleanText(raw.text ?? '', `${p}/text`, limits.blockTextMaxChars, issues);
    if (text === '') return;
    chars += [...text].length;
    run.text = text;
    for (const m of ['bold', 'italic', 'code'] as const) {
      if (raw[m] === undefined) continue;
      if (raw[m] !== true) issues.add(`${p}/${m}`, 'invalid_option', 'Use true or leave it out.');
      else run[m] = true;
    }
    if (raw.link !== undefined) {
      const url = safeUrl(raw.link, ['https:', 'http:', 'mailto:'], limits.embedUrlMaxChars);
      if (!url) issues.add(`${p}/link`, 'invalid_url', 'Use a full web or email address.');
      else run.link = url;
    }
    out.push(run);
  });
  if (chars > limits.blockTextMaxChars)
    issues.add(path, 'too_long', `Use at most ${limits.blockTextMaxChars} characters in a block.`);
  return mergeRuns(out);
}

const sameMarks = (a: Run, b: Run) =>
  !a.ref &&
  !b.ref &&
  !!a.bold === !!b.bold &&
  !!a.italic === !!b.italic &&
  !!a.code === !!b.code &&
  a.link === b.link;

/** Adjacent text with identical marks is one run (canonical form). */
export function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameMarks(last, r)) last.text = (last.text ?? '') + (r.text ?? '');
    else out.push({ ...r });
  }
  return out;
}

function parseBlock(raw: unknown, index: number, st: Strictness, seen: Set<string>): Block | null {
  const { limits, issues } = st;
  const path = `/blocks/${index}`;
  if (!isObject(raw)) {
    issues.add(path, 'invalid_type', 'Use a block.');
    return null;
  }
  const type = raw.type;
  if (!(BLOCK_TYPES as readonly unknown[]).includes(type)) {
    issues.add(`${path}/type`, 'unsupported_block', 'This kind of block is not supported.');
    return null;
  }
  let id: string;
  if (raw.id === undefined) id = newBlockId();
  else if (typeof raw.id !== 'string' || !BLOCK_ID.test(raw.id)) {
    issues.add(`${path}/id`, 'invalid_id', 'Use 4 to 64 letters, numbers, dashes, or underscores.');
    id = newBlockId();
  } else id = raw.id;
  if (seen.has(id)) issues.add(`${path}/id`, 'duplicate_block_id', 'Each block needs its own identifier.');
  seen.add(id);
  const t = type as BlockType;
  switch (t) {
    case 'paragraph':
    case 'quote': {
      fields(raw, ['id', 'type', 'runs'], path, issues);
      return { id, type: t, runs: parseRuns(raw.runs ?? [], `${path}/runs`, st) };
    }
    case 'heading': {
      fields(raw, ['id', 'type', 'level', 'runs'], path, issues);
      const level = raw.level;
      if (level !== 1 && level !== 2 && level !== 3)
        issues.add(`${path}/level`, 'invalid_option', 'Choose a heading level from 1 to 3.');
      return {
        id,
        type: 'heading',
        level: level === 2 || level === 3 ? level : 1,
        runs: parseRuns(raw.runs ?? [], `${path}/runs`, st),
      };
    }
    case 'callout': {
      fields(raw, ['id', 'type', 'tone', 'runs'], path, issues);
      const tone = raw.tone ?? 'info';
      if (!(CALLOUT_TONES as readonly unknown[]).includes(tone))
        issues.add(`${path}/tone`, 'invalid_option', 'Choose info, warning, or success.');
      return {
        id,
        type: 'callout',
        tone: (CALLOUT_TONES as readonly unknown[]).includes(tone) ? (tone as CalloutTone) : 'info',
        runs: parseRuns(raw.runs ?? [], `${path}/runs`, st),
      };
    }
    case 'bulleted_list':
    case 'numbered_list': {
      fields(raw, ['id', 'type', 'items'], path, issues);
      const items = Array.isArray(raw.items) ? raw.items : [];
      if (!Array.isArray(raw.items)) issues.add(`${path}/items`, 'invalid_type', 'Use a list of items.');
      if (items.length > limits.blocksMax)
        issues.add(`${path}/items`, 'too_many', `Use at most ${limits.blocksMax} items.`);
      return {
        id,
        type: t,
        items: items
          .slice(0, limits.blocksMax)
          .map((it, i) => parseRuns(it, `${path}/items/${i}`, st)),
      };
    }
    case 'checklist': {
      fields(raw, ['id', 'type', 'items'], path, issues);
      const items = Array.isArray(raw.items) ? raw.items : [];
      if (!Array.isArray(raw.items)) issues.add(`${path}/items`, 'invalid_type', 'Use a list of items.');
      if (items.length > limits.blocksMax)
        issues.add(`${path}/items`, 'too_many', `Use at most ${limits.blocksMax} items.`);
      return {
        id,
        type: 'checklist',
        items: items.slice(0, limits.blocksMax).map((it, i) => {
          const p = `${path}/items/${i}`;
          if (!isObject(it)) {
            issues.add(p, 'invalid_type', 'Use a checklist item.');
            return { runs: [], checked: false };
          }
          fields(it, ['runs', 'checked'], p, issues);
          if (it.checked !== undefined && typeof it.checked !== 'boolean')
            issues.add(`${p}/checked`, 'invalid_type', 'Use true or false.');
          return { runs: parseRuns(it.runs ?? [], `${p}/runs`, st), checked: it.checked === true };
        }),
      };
    }
    case 'code': {
      fields(raw, ['id', 'type', 'language', 'text'], path, issues);
      let language: string | null = null;
      if (raw.language !== undefined && raw.language !== null) {
        if (typeof raw.language !== 'string' || !LANGUAGE.test(raw.language))
          issues.add(`${path}/language`, 'invalid_option', 'Use a short language name.');
        else language = raw.language;
      }
      return {
        id,
        type: 'code',
        language,
        text: cleanText(raw.text ?? '', `${path}/text`, limits.blockTextMaxChars, issues),
      };
    }
    case 'table': {
      fields(raw, ['id', 'type', 'header', 'rows'], path, issues);
      if (raw.header !== undefined && typeof raw.header !== 'boolean')
        issues.add(`${path}/header`, 'invalid_type', 'Use true or false.');
      const rows = Array.isArray(raw.rows) ? raw.rows : [];
      if (!Array.isArray(raw.rows)) issues.add(`${path}/rows`, 'invalid_type', 'Use a list of rows.');
      const width = Array.isArray(rows[0]) ? rows[0].length : 0;
      let cells = 0;
      const out: string[][] = [];
      rows.forEach((row, r) => {
        if (!Array.isArray(row)) {
          issues.add(`${path}/rows/${r}`, 'invalid_type', 'Use a list of cells.');
          return;
        }
        if (row.length !== width)
          issues.add(`${path}/rows/${r}`, 'ragged_table', 'Every row needs the same number of cells.');
        cells += row.length;
        out.push(
          row.map((c, ci) =>
            cleanText(c ?? '', `${path}/rows/${r}/${ci}`, 2_000, issues).replace(/\n/g, ' '),
          ),
        );
      });
      if (cells > limits.tableCellsMax)
        issues.add(path, 'too_many', `Use at most ${limits.tableCellsMax} cells in a table.`);
      return { id, type: 'table', header: raw.header === true, rows: out };
    }
    case 'divider': {
      fields(raw, ['id', 'type'], path, issues);
      return { id, type: 'divider' };
    }
    case 'embed': {
      fields(raw, ['id', 'type', 'kind', 'url', 'title', 'alt'], path, issues);
      if (raw.kind === 'file') {
        issues.add(
          `${path}/kind`,
          'unsupported_embed',
          'Files cannot be embedded yet. Use an image, video, or link address.',
        );
        return null;
      }
      if (!(EMBED_KINDS as readonly unknown[]).includes(raw.kind))
        issues.add(`${path}/kind`, 'invalid_option', 'Choose image, video, or link.');
      const kind = (EMBED_KINDS as readonly unknown[]).includes(raw.kind)
        ? (raw.kind as EmbedKind)
        : 'link';
      const url = safeUrl(raw.url, kind === 'link' ? ['https:', 'http:'] : ['https:'], limits.embedUrlMaxChars);
      if (!url)
        issues.add(
          `${path}/url`,
          'invalid_url',
          kind === 'link' ? 'Use a full web address.' : 'Use a full https address.',
        );
      const opt = (k: 'title' | 'alt', max: number) =>
        raw[k] === undefined || raw[k] === null || raw[k] === ''
          ? null
          : cleanText(raw[k], `${path}/${k}`, max, issues).replace(/\n/g, ' ') || null;
      return { id, type: 'embed', kind, url: url ?? '', title: opt('title', 200), alt: opt('alt', 300) };
    }
  }
}

export interface ParsedContent {
  content: DocContent;
  hash: string;
  bytes: number;
  refs: Ref[];
  /** Restricted-item tokens the content carries (to be restored before it is stored). */
  restricted: string[];
}

/** Validates and normalizes content; throws the collected issues (never echoing input). */
export function parseContent(
  raw: unknown,
  limits: ContentLimits = DEFAULT_CONTENT_LIMITS,
  issues: Issues = new Issues(),
  base = '',
): ParsedContent {
  const refs: Ref[] = [];
  const restricted: string[] = [];
  const st: Strictness = { limits, refs, restricted, issues };
  const blocks: Block[] = [];
  if (!isObject(raw)) {
    issues.add(base || '/', 'invalid_type', 'Send the content as an object.');
  } else {
    fields(raw, ['v', 'blocks'], base, issues);
    if (raw.v !== CONTENT_VERSION)
      issues.add(`${base}/v`, 'unsupported_version', 'Use content version 2.');
    if (!Array.isArray(raw.blocks)) issues.add(`${base}/blocks`, 'invalid_type', 'Send a list of blocks.');
    else {
      if (raw.blocks.length > limits.blocksMax)
        issues.add(`${base}/blocks`, 'too_many', `Use at most ${limits.blocksMax} blocks.`);
      const seen = new Set<string>();
      raw.blocks.slice(0, limits.blocksMax).forEach((b, i) => {
        const block = parseBlock(b, i, st, seen);
        if (block) blocks.push(block);
      });
    }
  }
  const unique = new Map(refs.map((r) => [`${r.kind}:${r.id}`, r]));
  if (unique.size > limits.referencesMax)
    issues.add(`${base}/blocks`, 'too_many', `Use at most ${limits.referencesMax} different links and mentions.`);
  const content: DocContent = { v: 2, blocks };
  const bytes = contentBytes(content);
  if (bytes > limits.bodyMaxBytes)
    issues.add(base || '/', 'too_long', 'This document is too large to save.');
  issues.throwIfAny();
  return {
    content,
    hash: documentContentHash(content),
    bytes,
    refs: [...unique.values()],
    restricted,
  };
}

/** Re-reads stored content (already validated at save) into the canonical typed form. */
export function readContent(stored: unknown): DocContent {
  return parseContent(stored, {
    ...DEFAULT_CONTENT_LIMITS,
    bodyMaxBytes: 2_000_000,
    blocksMax: 5_000,
    blockTextMaxChars: 50_000,
    tableCellsMax: 5_000,
    referencesMax: 5_000,
    embedUrlMaxChars: 8_192,
  }).content;
}

export const emptyContent = (): DocContent => ({ v: 2, blocks: [] });

// -------------------------------------------------------------------------------------------
// Readers
// -------------------------------------------------------------------------------------------

const runText = (runs: readonly Run[]) => runs.map((r) => r.text ?? '').join('');

/** The text of one block (references contribute nothing: their label is the viewer's to see). */
export function blockText(b: Block): string {
  switch (b.type) {
    case 'paragraph':
    case 'heading':
    case 'quote':
    case 'callout':
      return runText(b.runs);
    case 'bulleted_list':
    case 'numbered_list':
      return b.items.map(runText).join('\n');
    case 'checklist':
      return b.items.map((i) => runText(i.runs)).join('\n');
    case 'code':
      return b.text;
    case 'table':
      return b.rows.map((r) => r.join('\t')).join('\n');
    case 'divider':
      return '';
    case 'embed':
      return [b.title, b.alt].filter(Boolean).join(' ');
  }
}

export const plainText = (c: DocContent) =>
  c.blocks
    .map(blockText)
    .filter((t) => t !== '')
    .join('\n\n');

export const wordCount = (c: DocContent) =>
  plainText(c)
    .split(/\s+/)
    .filter(Boolean).length;

function runsOf(b: Block): Run[][] {
  switch (b.type) {
    case 'paragraph':
    case 'heading':
    case 'quote':
    case 'callout':
      return [b.runs];
    case 'bulleted_list':
    case 'numbered_list':
      return b.items;
    case 'checklist':
      return b.items.map((i) => i.runs);
    default:
      return [];
  }
}

/** A copy of the content with every reference replaced by `f(reference)` (pure; same shape). */
export function mapRefs(
  c: DocContent,
  f: (ref: Ref | RestrictedRef) => Ref | RestrictedRef,
): DocContent {
  const runs = (rs: Run[]): Run[] => rs.map((r) => (r.ref ? { ref: f(r.ref) } : r));
  return {
    v: 2,
    blocks: c.blocks.map((b): Block => {
      switch (b.type) {
        case 'paragraph':
        case 'quote':
          return { ...b, runs: runs(b.runs) };
        case 'heading':
          return { ...b, runs: runs(b.runs) };
        case 'callout':
          return { ...b, runs: runs(b.runs) };
        case 'bulleted_list':
        case 'numbered_list':
          return { ...b, items: b.items.map(runs) };
        case 'checklist':
          return { ...b, items: b.items.map((i) => ({ ...i, runs: runs(i.runs) })) };
        default:
          return b;
      }
    }),
  };
}

/** The opaque token that stands for `ref` in document `docId` (stable, names nothing). */
export function restrictedToken(key: Buffer, docId: string, ref: Ref): string {
  return `rst_${createHmac('sha256', key).update(`${docId}|${ref.kind}|${ref.id}`).digest('hex').slice(0, 16)}`;
}

export interface FoundRef extends Ref {
  blockId: string;
  position: number;
}

/** Every reference in the content with the block it is in, first occurrence of each target. */
export function collectRefs(c: DocContent): FoundRef[] {
  const out: FoundRef[] = [];
  const seen = new Set<string>();
  for (const b of c.blocks) {
    let position = 0;
    for (const runs of runsOf(b))
      for (const r of runs)
        if (r.ref && !isRestrictedRef(r.ref)) {
          const key = `${r.ref.kind}:${r.ref.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ ...r.ref, blockId: b.id, position });
          }
          position += 1;
        }
  }
  return out;
}

export interface ChangeSummary extends Record<string, number> {
  added: number;
  changed: number;
  removed: number;
}

/** Blocks added, changed, and removed between two contents, matched by block identifier. */
export function changeSummary(prev: DocContent | null, next: DocContent): ChangeSummary {
  const before = new Map((prev?.blocks ?? []).map((b) => [b.id, blockHash(b)]));
  let added = 0;
  let changed = 0;
  const kept = new Set<string>();
  for (const b of next.blocks) {
    const h = before.get(b.id);
    if (h === undefined) added += 1;
    else {
      kept.add(b.id);
      if (h !== blockHash(b)) changed += 1;
    }
  }
  return { added, changed, removed: before.size - kept.size };
}

// -------------------------------------------------------------------------------------------
// Export: Markdown and HTML (OD-32). Labels for references come from the caller, per viewer.
// -------------------------------------------------------------------------------------------

/** What a reference shows for this viewer: a label and where it leads, or null when restricted. */
export type DocRefResolver = (ref: Ref) => { label: string; href: string | null } | null;
export const RESTRICTED_LABEL = 'Restricted item';

export interface ExportNote {
  /** What could not be carried, in the reader's words (counted, never naming content). */
  embeds: number;
  restricted: number;
}

const mdEscape = (s: string) => s.replace(/([\\`*_[\]<>|#])/g, '\\$1');

function mdRuns(runs: readonly Run[], resolve: DocRefResolver, note: ExportNote): string {
  return runs
    .map((r) => {
      if (r.ref) {
        const hit = isRestrictedRef(r.ref) ? null : resolve(r.ref);
        if (!hit) {
          note.restricted += 1;
          return `*${RESTRICTED_LABEL}*`;
        }
        return hit.href ? `[${mdEscape(hit.label)}](${hit.href})` : mdEscape(hit.label);
      }
      let t = r.code ? `\`${(r.text ?? '').replace(/`/g, "'")}\`` : mdEscape(r.text ?? '');
      if (r.bold) t = `**${t}**`;
      if (r.italic) t = `*${t}*`;
      if (r.link) t = `[${t}](${r.link})`;
      return t;
    })
    .join('');
}

const fenceFor = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(Math.max(3, longest + 1));
};

export function toMarkdown(
  title: string,
  c: DocContent,
  resolve: DocRefResolver,
  note: ExportNote,
): string {
  const out: string[] = [`# ${mdEscape(title)}`];
  for (const b of c.blocks) {
    switch (b.type) {
      case 'paragraph':
        out.push(mdRuns(b.runs, resolve, note));
        break;
      case 'heading':
        out.push(`${'#'.repeat(b.level + 1)} ${mdRuns(b.runs, resolve, note)}`);
        break;
      case 'quote':
        out.push(
          mdRuns(b.runs, resolve, note)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        );
        break;
      case 'callout':
        out.push(`> **${b.tone[0]!.toUpperCase()}${b.tone.slice(1)}:** ${mdRuns(b.runs, resolve, note)}`);
        break;
      case 'bulleted_list':
        out.push(b.items.map((i) => `- ${mdRuns(i, resolve, note)}`).join('\n'));
        break;
      case 'numbered_list':
        out.push(b.items.map((i, n) => `${n + 1}. ${mdRuns(i, resolve, note)}`).join('\n'));
        break;
      case 'checklist':
        out.push(
          b.items
            .map((i) => `- [${i.checked ? 'x' : ' '}] ${mdRuns(i.runs, resolve, note)}`)
            .join('\n'),
        );
        break;
      case 'code': {
        const f = fenceFor(b.text);
        out.push(`${f}${b.language ?? ''}\n${b.text}\n${f}`);
        break;
      }
      case 'table': {
        const cell = (s: string) => mdEscape(s).replace(/\n/g, ' ');
        const rows = b.rows.map((r) => `| ${r.map(cell).join(' | ')} |`);
        if (rows.length) {
          const width = b.rows[0]!.length;
          const sep = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
          out.push(
            b.header ? [rows[0], sep, ...rows.slice(1)].join('\n') : [
              `| ${Array.from({ length: width }, () => ' ').join(' | ')} |`,
              sep,
              ...rows,
            ].join('\n'),
          );
        }
        break;
      }
      case 'divider':
        out.push('---');
        break;
      case 'embed': {
        note.embeds += 1;
        const label = mdEscape(b.title ?? b.alt ?? b.url);
        out.push(`[${b.kind === 'link' ? label : `${b.kind}: ${label}`}](${b.url})`);
        break;
      }
    }
  }
  return `${out.join('\n\n')}\n`;
}

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function htmlRuns(runs: readonly Run[], resolve: DocRefResolver, note: ExportNote): string {
  return runs
    .map((r) => {
      if (r.ref) {
        const hit = isRestrictedRef(r.ref) ? null : resolve(r.ref);
        if (!hit) {
          note.restricted += 1;
          return `<em>${RESTRICTED_LABEL}</em>`;
        }
        return hit.href ? `<a href="${esc(hit.href)}">${esc(hit.label)}</a>` : esc(hit.label);
      }
      let t = esc(r.text ?? '').replace(/\n/g, '<br>');
      if (r.code) t = `<code>${t}</code>`;
      if (r.bold) t = `<strong>${t}</strong>`;
      if (r.italic) t = `<em>${t}</em>`;
      if (r.link) t = `<a href="${esc(r.link)}" rel="noopener noreferrer nofollow">${t}</a>`;
      return t;
    })
    .join('');
}

export const PRINT_STYLE =
  'body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#111}' +
  'pre{background:#f4f4f4;padding:.75rem;overflow:auto}code{font-family:ui-monospace,monospace}' +
  'table{border-collapse:collapse}td,th{border:1px solid #888;padding:.25rem .5rem}' +
  'blockquote{border-left:4px solid #888;margin:0;padding-left:1rem}.callout{border:2px solid #888;padding:.5rem .75rem}' +
  '@media print{body{max-width:none;margin:0}a{color:inherit}}';

export function htmlBody(c: DocContent, resolve: DocRefResolver, note: ExportNote): string {
  const out: string[] = [];
  for (const b of c.blocks) {
    switch (b.type) {
      case 'paragraph':
        out.push(`<p>${htmlRuns(b.runs, resolve, note)}</p>`);
        break;
      case 'heading':
        out.push(`<h${b.level + 1}>${htmlRuns(b.runs, resolve, note)}</h${b.level + 1}>`);
        break;
      case 'quote':
        out.push(`<blockquote>${htmlRuns(b.runs, resolve, note)}</blockquote>`);
        break;
      case 'callout':
        out.push(
          `<div class="callout"><strong>${esc(b.tone[0]!.toUpperCase() + b.tone.slice(1))}:</strong> ${htmlRuns(b.runs, resolve, note)}</div>`,
        );
        break;
      case 'bulleted_list':
        out.push(`<ul>${b.items.map((i) => `<li>${htmlRuns(i, resolve, note)}</li>`).join('')}</ul>`);
        break;
      case 'numbered_list':
        out.push(`<ol>${b.items.map((i) => `<li>${htmlRuns(i, resolve, note)}</li>`).join('')}</ol>`);
        break;
      case 'checklist':
        out.push(
          `<ul>${b.items
            .map((i) => `<li>${i.checked ? '&#9745;' : '&#9744;'} ${htmlRuns(i.runs, resolve, note)}</li>`)
            .join('')}</ul>`,
        );
        break;
      case 'code':
        out.push(`<pre><code>${esc(b.text)}</code></pre>`);
        break;
      case 'table': {
        const row = (r: string[], tag: string) =>
          `<tr>${r.map((cell) => `<${tag}>${esc(cell)}</${tag}>`).join('')}</tr>`;
        const [first, ...rest] = b.rows;
        out.push(
          `<table>${
            b.header && first
              ? `<thead>${row(first, 'th')}</thead><tbody>${rest.map((r) => row(r, 'td')).join('')}</tbody>`
              : `<tbody>${b.rows.map((r) => row(r, 'td')).join('')}</tbody>`
          }</table>`,
        );
        break;
      }
      case 'divider':
        out.push('<hr>');
        break;
      case 'embed':
        note.embeds += 1;
        out.push(
          `<p><a href="${esc(b.url)}" rel="noopener noreferrer nofollow">${esc(
            `${b.kind === 'link' ? '' : `${b.kind}: `}${b.title ?? b.alt ?? b.url}`,
          )}</a></p>`,
        );
        break;
    }
  }
  return out.join('\n');
}

export function toHtml(title: string, body: string): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_STYLE}</style></head><body><h1>${esc(title)}</h1>\n${body}\n</body></html>\n`;
}
