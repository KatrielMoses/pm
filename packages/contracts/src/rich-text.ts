import { canonicalJson } from './canonical-json.ts';

export { canonicalJson };

/**
 * Rich text, version 1 (0D `rich-text` schema; PQ-06/DQ-25 first increment). The canonical
 * envelope is `{type: "doc", version, content}`. Version 1 is the plain-text subset: a document is
 * a list of paragraphs, and a paragraph is a list of unmarked text nodes. One paragraph per line is
 * the canonical encoding of plain text. Phase 4C adds node and mark types under the same envelope
 * and `version`; stored version 1 documents stay valid without migration.
 *
 * Rules (enforced identically by `validateRichText` and the database `tenancy.valid_rich_text`):
 * no other node types, no marks, no other attributes; text nodes are non-empty and contain no line
 * breaks or control characters (tab allowed). The length limit applies to the extracted text
 * (paragraphs joined by "\n", counted in code points), never to serialized JSON. A document with no
 * non-whitespace text is refused: `null` is the only "no description" value.
 */
export const RICH_TEXT_VERSION = 1 as const;

export interface RichTextNode {
  type: 'text';
  text: string;
}
export interface RichParagraph {
  type: 'paragraph';
  content: RichTextNode[];
}
export interface RichTextDoc {
  type: 'doc';
  version: typeof RICH_TEXT_VERSION;
  content: RichParagraph[];
}

export type RichTextIssueCode =
  | 'invalid_type'
  | 'unsupported_version'
  | 'unsupported_node'
  | 'unsupported_mark'
  | 'unsupported_attribute'
  | 'invalid_characters'
  | 'empty_document'
  | 'too_long';

export type RichTextResult =
  | { ok: true; doc: RichTextDoc; text: string }
  | { ok: false; code: RichTextIssueCode; path: string; message: string };

// Line breaks are structural (paragraphs), so \n and \r are refused inside text like other controls.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

const keysAre = (o: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(o).find((k) => !allowed.includes(k));
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates a version 1 document and returns it with its extracted text. */
export function validateRichText(value: unknown, maxText: number): RichTextResult {
  const fail = (code: RichTextIssueCode, path: string, message: string): RichTextResult => ({
    ok: false,
    code,
    path,
    message,
  });
  if (!isObj(value) || value.type !== 'doc')
    return fail('invalid_type', '', 'Send a rich-text document.');
  if (value.version !== RICH_TEXT_VERSION)
    return fail('unsupported_version', '/version', 'This rich-text version is not supported.');
  const extra = keysAre(value, ['type', 'version', 'content']);
  if (extra) return fail('unsupported_attribute', `/${extra}`, 'This attribute is not supported.');
  if (!Array.isArray(value.content) || !value.content.length)
    return fail('invalid_type', '/content', 'A document has at least one paragraph.');
  const lines: string[] = [];
  for (const [i, p] of value.content.entries()) {
    const at = `/content/${i}`;
    if (!isObj(p) || p.type !== 'paragraph')
      return fail('unsupported_node', at, 'Only paragraphs are supported here.');
    const pe = keysAre(p, ['type', 'content']);
    if (pe) return fail('unsupported_attribute', `${at}/${pe}`, 'This attribute is not supported.');
    if (!Array.isArray(p.content))
      return fail('invalid_type', `${at}/content`, 'A paragraph holds a list of text.');
    let line = '';
    for (const [j, t] of p.content.entries()) {
      const tat = `${at}/content/${j}`;
      if (!isObj(t) || t.type !== 'text')
        return fail('unsupported_node', tat, 'Only plain text is supported here.');
      if ('marks' in t)
        return fail('unsupported_mark', `${tat}/marks`, 'Formatting is not supported here yet.');
      const te = keysAre(t, ['type', 'text']);
      if (te)
        return fail('unsupported_attribute', `${tat}/${te}`, 'This attribute is not supported.');
      if (typeof t.text !== 'string' || !t.text)
        return fail('invalid_type', `${tat}/text`, 'Text cannot be empty.');
      if (CONTROL.test(t.text))
        return fail(
          'invalid_characters',
          `${tat}/text`,
          "This text contains characters we can't save.",
        );
      line += t.text;
    }
    lines.push(line);
  }
  const text = lines.join('\n');
  if (!text.trim()) return fail('empty_document', '', 'Send null to remove the text instead.');
  if ([...text].length > maxText)
    return fail('too_long', '', `This text can be at most ${maxText} characters.`);
  return { ok: true, doc: value as unknown as RichTextDoc, text };
}

/** The canonical version 1 encoding of plain text (one paragraph per line); blank text is null. */
export function richTextFromPlain(plain: string): RichTextDoc | null {
  const normalized = plain.replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return null;
  return {
    type: 'doc',
    version: RICH_TEXT_VERSION,
    content: normalized
      .split('\n')
      .map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
  };
}

/** The plain text of a document (paragraphs joined by "\n"); null for no document. */
export function plainFromRichText(doc: RichTextDoc | null | undefined): string {
  if (!doc) return '';
  return doc.content.map((p) => p.content.map((t) => t.text).join('')).join('\n');
}
