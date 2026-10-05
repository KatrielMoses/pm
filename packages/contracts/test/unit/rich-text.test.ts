import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  plainFromRichText,
  RICH_TEXT_VERSION,
  richTextFromPlain,
  validateRichText,
} from '../../src/rich-text.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const para = (...texts: string[]) => ({
  type: 'paragraph',
  content: texts.map((text) => ({ type: 'text', text })),
});
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });

describe('rich text version 1 (0D PL-23)', () => {
  it('plain text round-trips through the canonical encoding (one paragraph per line)', () => {
    const text = 'Relaunch the site\n\nOut of scope: the blog\t(for now)';
    const d = richTextFromPlain(text)!;
    expect(d).toEqual(
      doc(
        para('Relaunch the site'),
        { type: 'paragraph', content: [] },
        para('Out of scope: the blog\t(for now)'),
      ),
    );
    expect(validateRichText(d, 20_000)).toEqual({ ok: true, doc: d, text });
    expect(plainFromRichText(d)).toBe(text);
    // Windows line endings are lines too; blank text is null (the only empty value).
    expect(plainFromRichText(richTextFromPlain('a\r\nb'))).toBe('a\nb');
    expect(richTextFromPlain('  \n \n')).toBeNull();
    expect(plainFromRichText(null)).toBe('');
  });

  it('the authoritative 0D example is valid and identical in shape', () => {
    const ex = JSON.parse(
      readFileSync(
        resolve(ROOT, 'docs/architecture/platform/contracts/examples/rich-text.1.json'),
        'utf8',
      ),
    ) as { example: unknown };
    expect(validateRichText(ex.example, 20_000).ok).toBe(true);
    expect(RICH_TEXT_VERSION).toBe(1);
  });

  it('refuses unsupported versions, nodes, marks, attributes, and characters (never stored loosely)', () => {
    const code = (v: unknown) => {
      const r = validateRichText(v, 100);
      return r.ok ? 'ok' : `${r.code}@${r.path}`;
    };
    expect(code({ ...doc(para('a')), version: 2 })).toBe('unsupported_version@/version');
    expect(code('text')).toBe('invalid_type@');
    expect(code(doc())).toBe('invalid_type@/content');
    expect(code({ ...doc(para('a')), attrs: {} })).toBe('unsupported_attribute@/attrs');
    expect(code(doc({ type: 'heading', content: [] }))).toBe('unsupported_node@/content/0');
    expect(code(doc({ type: 'paragraph', content: [{ type: 'image', src: 'x' }] }))).toBe(
      'unsupported_node@/content/0/content/0',
    );
    expect(
      code(
        doc({
          type: 'paragraph',
          content: [{ type: 'text', text: 'a', marks: [{ type: 'bold' }] }],
        }),
      ),
    ).toBe('unsupported_mark@/content/0/content/0/marks');
    expect(code(doc({ type: 'paragraph', content: [{ type: 'text', text: '' }] }))).toBe(
      'invalid_type@/content/0/content/0/text',
    );
    expect(code(doc(para('line\nbreak')))).toBe('invalid_characters@/content/0/content/0/text');
    expect(code(doc(para('bell\u0007')))).toBe('invalid_characters@/content/0/content/0/text');
    expect(code(doc({ type: 'paragraph', content: [] }))).toBe('empty_document@');
    expect(code(doc(para('   ')))).toBe('empty_document@');
  });

  it('limits the extracted text in code points, not serialized JSON bytes', () => {
    const emoji = '😀'.repeat(100); // 100 code points, 200 UTF-16 units, 400 UTF-8 bytes
    expect(validateRichText(doc(para(emoji)), 100).ok).toBe(true);
    expect(JSON.stringify(doc(para(emoji))).length).toBeGreaterThan(100);
    expect(validateRichText(doc(para(emoji + 'x')), 100)).toMatchObject({
      ok: false,
      code: 'too_long',
    });
    // Paragraph boundaries count as one line break each.
    expect(validateRichText(doc(para('a'.repeat(50)), para('b'.repeat(49))), 100).ok).toBe(true);
    expect(validateRichText(doc(para('a'.repeat(50)), para('b'.repeat(50))), 100).ok).toBe(false);
  });

  it('forward compatible: 4C may split text into several nodes; version 1 still reads them', () => {
    const split = doc(para('Hello, ', 'world'));
    expect(validateRichText(split, 100)).toMatchObject({ ok: true, text: 'Hello, world' });
    expect(plainFromRichText(split as never)).toBe('Hello, world');
  });

  it('canonical JSON is key-order independent (stable base_hash for rich text)', () => {
    expect(canonicalJson({ version: 1, type: 'doc', content: [] })).toBe(
      canonicalJson({ content: [], type: 'doc', version: 1 }),
    );
  });
});
