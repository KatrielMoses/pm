import { describe, expect, it } from 'vitest';
import {
  RESTRICTED_LABEL,
  changeSummary,
  collectRefs,
  documentContentHash,
  htmlBody,
  newBlockId,
  parseContent,
  plainText,
  readContent,
  safeUrl,
  stableStringify,
  toHtml,
  toMarkdown,
  type DocContent,
  type ExportNote,
  type DocRefResolver,
} from '../../src/docs/content.ts';
import {
  DOC_TYPES,
  addReviewDays,
  createsCycle,
  effectiveState,
  isDate,
  placementError,
  starterContent,
  templateKey,
} from '../../src/docs/semantics.ts';

const TASK = `tsk_${'0'.repeat(25)}1`;
const MEMBER = `mem_${'0'.repeat(25)}2`;
const doc = (blocks: unknown[]) => ({ v: 2, blocks });
const para = (id: string, text: string) => ({ id, type: 'paragraph', runs: [{ text }] });
const issuesOf = (raw: unknown): Array<{ pointer: string; code: string }> => {
  try {
    parseContent(raw);
  } catch (err) {
    return (err as { issues: Array<{ pointer: string; code: string }> }).issues;
  }
  return [];
};
const none: DocRefResolver = () => null;
const note = (): ExportNote => ({ embeds: 0, restricted: 0 });

describe('document content (ADR-0025 D2)', () => {
  it('normalizes into one canonical form with a stable hash', () => {
    const a = parseContent(
      doc([
        {
          type: 'paragraph',
          id: 'blk_one',
          runs: [{ text: 'Hello ' }, { text: 'world' }, { text: '!', bold: true }],
        },
      ]),
    );
    // Adjacent runs with the same marks are one run; key order never matters.
    expect(a.content.blocks[0]).toEqual({
      id: 'blk_one',
      type: 'paragraph',
      runs: [{ text: 'Hello world' }, { text: '!', bold: true }],
    });
    const b = parseContent(
      doc([
        {
          runs: [{ text: 'Hello world' }, { bold: true, text: '!' }],
          id: 'blk_one',
          type: 'paragraph',
        },
      ]),
    );
    expect(b.hash).toBe(a.hash);
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(documentContentHash(readContent(JSON.parse(JSON.stringify(a.content))))).toBe(a.hash);
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it('gives a block without an identifier a fresh one and refuses duplicates', () => {
    const made = parseContent(doc([{ type: 'divider' }, { type: 'divider' }]));
    const ids = made.content.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((i) => /^b_[A-Za-z0-9]{12}$/.test(i))).toBe(true);
    expect(newBlockId()).not.toBe(newBlockId());
    expect(issuesOf(doc([para('same', 'a'), para('same', 'b')]))).toContainEqual(
      expect.objectContaining({ code: 'duplicate_block_id', pointer: '/blocks/1/id' }),
    );
  });

  it('refuses unknown fields, kinds, versions, and malformed input with pointer-precise issues', () => {
    expect(issuesOf({ v: 1, blocks: [] })).toContainEqual(
      expect.objectContaining({ code: 'unsupported_version' }),
    );
    expect(issuesOf('text')).toContainEqual(expect.objectContaining({ code: 'invalid_type' }));
    expect(issuesOf(doc([{ type: 'script', id: 'blk_x' }]))).toContainEqual(
      expect.objectContaining({ code: 'unsupported_block', pointer: '/blocks/0/type' }),
    );
    expect(issuesOf(doc([{ ...para('blk_x', 'a'), extra: 1 }]))).toContainEqual(
      expect.objectContaining({ code: 'unsupported_field', pointer: '/blocks/0/extra' }),
    );
    expect(issuesOf(doc([{ type: 'heading', id: 'blk_h', level: 9, runs: [] }]))).toContainEqual(
      expect.objectContaining({ code: 'invalid_option' }),
    );
    expect(issuesOf(doc([para('blk_c', 'bad\u0007text')]))).toContainEqual(
      expect.objectContaining({ code: 'invalid_text' }),
    );
  });

  it('bounds blocks, text, tables, and total size', () => {
    const limits = {
      bodyMaxBytes: 600,
      blocksMax: 3,
      blockTextMaxChars: 50,
      tableCellsMax: 4,
      referencesMax: 2,
      embedUrlMaxChars: 100,
    };
    const run = (raw: unknown) => {
      try {
        parseContent(raw, limits);
      } catch (err) {
        return (err as { issues: Array<{ code: string }> }).issues.map((i) => i.code);
      }
      return [];
    };
    expect(
      run(doc([para('a1b2', 'x'), para('b1c2', 'x'), para('c1d2', 'x'), para('d1e2', 'x')])),
    ).toContain('too_many');
    expect(run(doc([para('a1b2', 'x'.repeat(51))]))).toContain('too_long');
    expect(
      run(
        doc([
          {
            type: 'table',
            id: 'tbl1',
            header: false,
            rows: [
              ['a', 'b', 'c'],
              ['d', 'e', 'f'],
            ],
          },
        ]),
      ),
    ).toContain('too_many');
    expect(
      run(
        doc([
          para('a1b2', 'x'.repeat(40)),
          para('b1c2', 'y'.repeat(40)),
          para('c1d2', 'z'.repeat(40)),
        ]),
      ),
    ).toEqual([]);
    const tiny = () => {
      try {
        parseContent(doc([para('a1b2', 'q'.repeat(50))]), { ...limits, bodyMaxBytes: 60 });
      } catch (err) {
        return (err as { issues: Array<{ code: string }> }).issues.map((i) => i.code);
      }
      return [];
    };
    expect(tiny()).toContain('too_long');
    const refs = [1, 2, 3].map((n) => ({ ref: { kind: 'task', id: `tsk_${'0'.repeat(25)}${n}` } }));
    expect(run(doc([{ id: 'refs', type: 'paragraph', runs: refs }]))).toContain('too_many');
  });

  it('keeps tables rectangular and tidy', () => {
    expect(
      issuesOf(doc([{ type: 'table', id: 'tbl1', header: true, rows: [['a', 'b'], ['c']] }])),
    ).toContainEqual(expect.objectContaining({ code: 'ragged_table' }));
    const ok = parseContent(
      doc([
        {
          type: 'table',
          id: 'tbl1',
          header: true,
          rows: [
            ['a\nb', 'c'],
            ['d', 'e'],
          ],
        },
      ]),
    );
    expect(ok.content.blocks[0]).toMatchObject({
      rows: [
        ['a b', 'c'],
        ['d', 'e'],
      ],
    });
  });

  it('accepts only safe addresses and refuses file embeds until 4E', () => {
    expect(safeUrl('https://example.com/a?b=1', ['https:'], 100)).toBe('https://example.com/a?b=1');
    expect(safeUrl('javascript:alert(1)', ['https:', 'http:'], 100)).toBeNull();
    expect(safeUrl('https://user:pw@example.com/', ['https:'], 100)).toBeNull();
    expect(safeUrl('http://example.com', ['https:'], 100)).toBeNull();
    expect(safeUrl('https://example.com/a b', ['https:'], 100)).toBeNull();
    expect(safeUrl('https://' + 'a'.repeat(200) + '.com', ['https:'], 100)).toBeNull();
    expect(safeUrl('mailto:someone@example.com', ['https:', 'mailto:'], 100)).toBe(
      'mailto:someone@example.com',
    );
    expect(
      issuesOf(
        doc([{ type: 'embed', id: 'emb1', kind: 'file', url: 'https://example.com/x.pdf' }]),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'unsupported_embed' }));
    expect(
      issuesOf(
        doc([{ type: 'embed', id: 'emb1', kind: 'image', url: 'http://example.com/x.png' }]),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'invalid_url', pointer: '/blocks/0/url' }));
    expect(
      issuesOf(
        doc([
          { id: 'lnk1', type: 'paragraph', runs: [{ text: 'x', link: 'javascript:alert(1)' }] },
        ]),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'invalid_url' }));
    const ok = parseContent(
      doc([
        {
          type: 'embed',
          id: 'emb1',
          kind: 'video',
          url: 'https://example.com/v',
          title: 'Demo',
          alt: '',
        },
      ]),
    );
    expect(ok.content.blocks[0]).toMatchObject({ kind: 'video', title: 'Demo', alt: null });
  });

  it('carries references without any label and lists each target once', () => {
    const parsed = parseContent(
      doc([
        {
          id: 'blk_a',
          type: 'paragraph',
          runs: [
            { text: 'See ' },
            { ref: { kind: 'task', id: TASK } },
            { text: ' and ' },
            { ref: { kind: 'member', id: MEMBER } },
          ],
        },
        { id: 'blk_b', type: 'bulleted_list', items: [[{ ref: { kind: 'task', id: TASK } }]] },
      ]),
    );
    expect(parsed.refs).toHaveLength(2);
    expect(collectRefs(parsed.content)).toEqual([
      { kind: 'task', id: TASK, blockId: 'blk_a', position: 0 },
      { kind: 'member', id: MEMBER, blockId: 'blk_a', position: 1 },
    ]);
    expect(JSON.stringify(parsed.content)).not.toContain('"label"');
    expect(
      issuesOf(
        doc([
          { id: 'blk_a', type: 'paragraph', runs: [{ ref: { kind: 'task', id: 'tsk_nope' } }] },
        ]),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'invalid_reference' }));
    expect(
      issuesOf(
        doc([
          {
            id: 'blk_a',
            type: 'paragraph',
            runs: [{ text: 'label', ref: { kind: 'task', id: TASK } }],
          },
        ]),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'not_allowed' }));
  });

  it('summarizes what changed between versions by block', () => {
    const v1 = parseContent(
      doc([para('blk_a', 'one'), para('blk_b', 'two'), para('blk_c', 'three')]),
    ).content;
    const v2 = parseContent(
      doc([para('blk_a', 'one'), para('blk_b', 'TWO'), para('blk_d', 'four')]),
    ).content;
    expect(changeSummary(v1, v2)).toEqual({ added: 1, changed: 1, removed: 1 });
    expect(changeSummary(null, v1)).toEqual({ added: 3, changed: 0, removed: 0 });
    expect(changeSummary(v1, v1)).toEqual({ added: 0, changed: 0, removed: 0 });
    expect(plainText(v2)).toBe('one\n\nTWO\n\nfour');
  });
});

describe('document export (ADR-0025 D9)', () => {
  const content = (): DocContent =>
    parseContent(
      doc([
        { id: 'blk_h', type: 'heading', level: 1, runs: [{ text: 'Plan' }] },
        {
          id: 'blk_p',
          type: 'paragraph',
          runs: [
            { text: 'a*b_c', bold: true },
            { text: ' ' },
            { text: 'site', link: 'https://example.com/' },
          ],
        },
        {
          id: 'blk_r',
          type: 'paragraph',
          runs: [{ text: 'See ' }, { ref: { kind: 'task', id: TASK } }],
        },
        {
          id: 'blk_k',
          type: 'checklist',
          items: [
            { runs: [{ text: 'done' }], checked: true },
            { runs: [{ text: 'todo' }], checked: false },
          ],
        },
        { id: 'blk_c', type: 'code', language: 'ts', text: 'const a = ```x```;' },
        {
          id: 'blk_t',
          type: 'table',
          header: true,
          rows: [
            ['a|b', 'c'],
            ['d', 'e'],
          ],
        },
        {
          id: 'blk_e',
          type: 'embed',
          kind: 'image',
          url: 'https://example.com/i.png',
          title: null,
          alt: 'A chart',
        },
        { id: 'blk_d', type: 'divider' },
      ]),
    ).content;

  it('writes Markdown, escapes markup, and says what it could not carry', () => {
    const n = note();
    const md = toMarkdown('Q4 *plan*', content(), none, n);
    expect(md).toContain('# Q4 \\*plan\\*');
    expect(md).toContain('## Plan');
    expect(md).toContain('**a\\*b\\_c**');
    expect(md).toContain('[site](https://example.com/)');
    expect(md).toContain(`*${RESTRICTED_LABEL}*`);
    expect(md).toContain('- [x] done');
    expect(md).toContain('- [ ] todo');
    expect(md).toContain('````ts\nconst a = ```x```;\n````');
    expect(md).toContain('| a\\|b | c |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('[image: A chart](https://example.com/i.png)');
    expect(md).toContain('---');
    expect(n).toEqual({ embeds: 1, restricted: 1 });
  });

  it('shows a reference only as the viewer’s resolver allows', () => {
    const resolve: DocRefResolver = (r) => (r.id === TASK ? { label: 'Launch', href: '/t/1' } : null);
    const n = note();
    expect(toMarkdown('T', content(), resolve, n)).toContain('[Launch](/t/1)');
    expect(n.restricted).toBe(0);
  });

  it('writes HTML that escapes everything and prints cleanly', () => {
    const n = note();
    const body = htmlBody(content(), none, n);
    expect(body).toContain('<h2>Plan</h2>');
    expect(body).toContain('<strong>a*b_c</strong>');
    expect(body).toContain('rel="noopener noreferrer nofollow"');
    expect(body).toContain('<em>Restricted item</em>');
    expect(body).toContain('&#9745; done');
    expect(body).toContain('<th>a|b</th>');
    const page = toHtml('<script>alert(1)</script>', body);
    expect(page).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(page).not.toContain('<script>');
    expect(page).toContain('@media print');
  });
});

describe('document semantics (ADR-0025 D4, D7)', () => {
  it('derives staleness from the review date without rewriting the state', () => {
    expect(effectiveState('current', '2026-01-01', '2026-02-01')).toBe('stale');
    expect(effectiveState('current', '2026-02-01', '2026-02-01')).toBe('current');
    expect(effectiveState('current', null, '2026-02-01')).toBe('current');
    expect(effectiveState('draft', '2020-01-01', '2026-02-01')).toBe('draft');
    expect(effectiveState('stale', null, '2026-02-01')).toBe('stale');
  });

  it('checks dates and shifts them', () => {
    expect(isDate('2026-02-28')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('26-02-01')).toBe(false);
    expect(addReviewDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addReviewDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('constrains where each type may live', () => {
    expect(
      placementError('brand_brief', { brand: true, project: false, task: false, parent: false }),
    ).toBeNull();
    expect(
      placementError('brand_brief', { brand: false, project: false, task: false, parent: false }),
    ).toMatchObject({ code: 'invalid_placement' });
    expect(
      placementError('brand_brief', { brand: true, project: true, task: false, parent: false }),
    ).toMatchObject({ code: 'invalid_placement' });
    expect(
      placementError('project_brief', { brand: true, project: false, task: false, parent: false }),
    ).toMatchObject({ code: 'invalid_placement' });
    expect(
      placementError('project_brief', { brand: true, project: true, task: false, parent: false }),
    ).toBeNull();
    expect(
      placementError('sop', { brand: false, project: false, task: false, parent: false }),
    ).toBeNull();
  });

  it('refuses a move into the page’s own subtree', () => {
    expect(createsCycle('a', ['root', 'a', 'b'], 'b')).toBe(true);
    expect(createsCycle('a', [], 'a')).toBe(true);
    expect(createsCycle('a', ['root'], 'c')).toBe(false);
  });

  it('has a valid built-in starter for every type, versioned', () => {
    for (const type of DOC_TYPES) {
      const parsed = parseContent(starterContent(type));
      expect(parsed.content.blocks.length > 0, type).toBe(type !== 'page');
      expect(templateKey(type)).toBe(`${type}@1`);
    }
  });
});
