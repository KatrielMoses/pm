import type { Block, BlockType, CalloutTone, EmbedKind, References } from './client.ts';
import { itemsToText, parse, plain, serialize, textToItems } from './inline.ts';

/**
 * The editor's working shape of a block: text boxes hold the inline syntax (see inline.ts), so a
 * person edits plain text and the runs are rebuilt when saving. Existing blocks keep the `id` the
 * server gave them; new blocks have none (the server assigns one on save).
 */

export type EditBlock = { key: string; id?: string } & (
  | { type: 'paragraph' | 'quote'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'callout'; tone: CalloutTone; text: string }
  | { type: 'bulleted_list' | 'numbered_list'; text: string }
  | { type: 'checklist'; items: Array<{ key: string; text: string; checked: boolean }> }
  | { type: 'code'; language: string; text: string }
  | { type: 'table'; header: boolean; rows: string[][] }
  | { type: 'divider' }
  | { type: 'embed'; kind: EmbedKind; url: string; title: string; alt: string }
);

export const BLOCK_LABEL: Record<BlockType, string> = {
  paragraph: 'Paragraph',
  heading: 'Heading',
  bulleted_list: 'Bulleted list',
  numbered_list: 'Numbered list',
  checklist: 'Checklist',
  quote: 'Quote',
  callout: 'Callout',
  code: 'Code',
  table: 'Table',
  divider: 'Divider',
  embed: 'Link card (image, video, or link)',
};
export const BLOCK_ORDER: BlockType[] = [
  'paragraph',
  'heading',
  'bulleted_list',
  'numbered_list',
  'checklist',
  'quote',
  'callout',
  'code',
  'table',
  'divider',
  'embed',
];
export const TONE_LABEL: Record<CalloutTone, string> = {
  info: 'Note',
  warning: 'Warning',
  success: 'Success',
};

let counter = 0;
export const newKey = () => `k${++counter}`;

export function blankBlock(type: BlockType): EditBlock {
  const key = newKey();
  switch (type) {
    case 'paragraph':
    case 'quote':
    case 'bulleted_list':
    case 'numbered_list':
      return { key, type, text: '' };
    case 'heading':
      return { key, type, level: 2, text: '' };
    case 'callout':
      return { key, type, tone: 'info', text: '' };
    case 'checklist':
      return { key, type, items: [{ key: newKey(), text: '', checked: false }] };
    case 'code':
      return { key, type, language: '', text: '' };
    case 'table':
      return {
        key,
        type,
        header: true,
        rows: [
          ['', ''],
          ['', ''],
        ],
      };
    case 'divider':
      return { key, type };
    case 'embed':
      return { key, type, kind: 'link', url: '', title: '', alt: '' };
  }
}

export function toEdit(
  block: Block,
  refs: References = {},
  local: Readonly<Record<string, string>> = {},
): EditBlock {
  const base = { key: newKey(), ...(block.id ? { id: block.id } : {}) };
  switch (block.type) {
    case 'paragraph':
    case 'quote':
      return { ...base, type: block.type, text: serialize(block.runs, refs, local) };
    case 'heading':
      return { ...base, type: 'heading', level: block.level, text: serialize(block.runs, refs, local) };
    case 'callout':
      return { ...base, type: 'callout', tone: block.tone, text: serialize(block.runs, refs, local) };
    case 'bulleted_list':
    case 'numbered_list':
      return { ...base, type: block.type, text: itemsToText(block.items, refs, local) };
    case 'checklist':
      return {
        ...base,
        type: 'checklist',
        items: block.items.map((i) => ({
          key: newKey(),
          text: serialize(i.runs, refs, local).replace(/\n/g, ' '),
          checked: i.checked,
        })),
      };
    case 'code':
      return { ...base, type: 'code', language: block.language ?? '', text: block.text };
    case 'table':
      return { ...base, type: 'table', header: block.header, rows: block.rows.map((r) => [...r]) };
    case 'divider':
      return { ...base, type: 'divider' };
    case 'embed':
      return {
        ...base,
        type: 'embed',
        kind: block.kind,
        url: block.url,
        title: block.title ?? '',
        alt: block.alt ?? '',
      };
  }
}

/** The request shape of a block (`id` only for blocks the server already knows). */
export function toBlock(b: EditBlock, withId = true): Block {
  const id = withId && b.id ? { id: b.id } : {};
  switch (b.type) {
    case 'paragraph':
    case 'quote':
      return { ...id, type: b.type, runs: parse(b.text) };
    case 'heading':
      return { ...id, type: 'heading', level: b.level, runs: parse(b.text) };
    case 'callout':
      return { ...id, type: 'callout', tone: b.tone, runs: parse(b.text) };
    case 'bulleted_list':
    case 'numbered_list':
      return { ...id, type: b.type, items: textToItems(b.text) };
    case 'checklist':
      return {
        ...id,
        type: 'checklist',
        items: b.items
          .filter((i) => i.text.trim() !== '')
          .map((i) => ({ runs: parse(i.text), checked: i.checked })),
      };
    case 'code':
      return { ...id, type: 'code', language: b.language.trim() === '' ? null : b.language.trim(), text: b.text };
    case 'table':
      return { ...id, type: 'table', header: b.header, rows: b.rows.map((r) => [...r]) };
    case 'divider':
      return { ...id, type: 'divider' };
    case 'embed':
      return {
        ...id,
        type: 'embed',
        kind: b.kind,
        url: b.url.trim(),
        title: b.title.trim() === '' ? null : b.title.trim(),
        alt: b.alt.trim() === '' ? null : b.alt.trim(),
      };
  }
}

/** A stable text of the content, used to tell whether anything differs from what was loaded. */
export function contentFingerprint(blocks: readonly EditBlock[], title: string): string {
  return JSON.stringify({ t: title.trim(), b: blocks.map((b) => toBlock(b)) });
}

export function blockFingerprint(block: Block): string {
  return JSON.stringify(toBlock(toEdit(block)));
}

/** Turns a paragraph into a heading and back, keeping its text and identity. */
export function convert(b: EditBlock, to: 'paragraph' | 'heading', level: 1 | 2 | 3 = 2): EditBlock {
  if (b.type !== 'paragraph' && b.type !== 'heading') return b;
  return to === 'heading'
    ? { key: b.key, ...(b.id ? { id: b.id } : {}), type: 'heading', level, text: b.text }
    : { key: b.key, ...(b.id ? { id: b.id } : {}), type: 'paragraph', text: b.text };
}

/** A plain-text copy of the content (a downloadable copy of someone's own unsaved version). */
export function blocksToPlainText(title: string, blocks: readonly EditBlock[]): string {
  const lines = [title.trim() === '' ? 'Untitled' : title.trim(), ''];
  for (const b of blocks.map((x) => toBlock(x))) {
    switch (b.type) {
      case 'paragraph':
      case 'quote':
      case 'callout':
        lines.push(plain(b.runs), '');
        break;
      case 'heading':
        lines.push(`${'#'.repeat(b.level)} ${plain(b.runs)}`, '');
        break;
      case 'bulleted_list':
        lines.push(...b.items.map((i) => `- ${plain(i)}`), '');
        break;
      case 'numbered_list':
        lines.push(...b.items.map((i, n) => `${n + 1}. ${plain(i)}`), '');
        break;
      case 'checklist':
        lines.push(...b.items.map((i) => `- [${i.checked ? 'x' : ' '}] ${plain(i.runs)}`), '');
        break;
      case 'code':
        lines.push('```' + (b.language ?? ''), b.text, '```', '');
        break;
      case 'table':
        lines.push(...b.rows.map((r) => r.join(' | ')), '');
        break;
      case 'divider':
        lines.push('---', '');
        break;
      case 'embed':
        lines.push(`${b.title ?? b.kind}: ${b.url}`, '');
        break;
    }
  }
  return lines.join('\n');
}

/** Labels for references the person has just chosen (shown before the server has resolved them). */
export function collectLabels(refs: References): Record<string, string> {
  return Object.fromEntries(
    Object.values(refs)
      .filter((r) => r.kind !== 'restricted')
      .map((r) => [`${r.kind}:${r.id}`, r.label]),
  );
}

/** Labels written in the text boxes' own reference tokens (for what was just mentioned). */
export function labelsInBlocks(blocks: readonly EditBlock[]): Record<string, string> {
  const out: Record<string, string> = {};
  const scan = (text: string) => {
    for (const m of text.matchAll(
      /\[((?:\\.|[^\]\\])*)\]\(ref:(member|team|task|project|brand|document):([A-Za-z0-9_]{1,64})\)/g,
    ))
      out[`${m[2]}:${m[3]}`] = m[1]!.replace(/\\(.)/g, '$1');
  };
  for (const b of blocks) {
    if ('text' in b) scan(b.text);
    if (b.type === 'checklist') for (const i of b.items) scan(i.text);
  }
  return out;
}

/** Issue pointers `/content/blocks/N/...` grouped by block index; everything else is general. */
export function groupIssues<T extends { pointer?: string }>(issues: readonly T[]) {
  const byBlock = new Map<number, T[]>();
  const general: T[] = [];
  for (const i of issues) {
    const m = /^\/content\/blocks\/(\d+)(?:\/|$)/.exec(i.pointer ?? '');
    if (m) {
      const n = Number(m[1]);
      byBlock.set(n, [...(byBlock.get(n) ?? []), i]);
    } else general.push(i);
  }
  return { byBlock, general };
}
