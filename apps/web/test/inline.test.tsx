import { describe, expect, it } from 'vitest';
import type { References, Run } from '../src/docs/client.ts';
import {
  itemsToText,
  normalizeRuns,
  parse,
  plain,
  RESTRICTED_LABEL,
  serialize,
  textToItems,
} from '../src/docs/inline.ts';

const refs: References = {
  'member:mem_1': { kind: 'member', id: 'mem_1', label: 'Ada [Lovelace]', path: null },
  'task:tsk_1': {
    kind: 'task',
    id: 'tsk_1',
    label: 'Fix *the* bug',
    path: '/workspaces/ws_A/tasks/tsk_1',
  },
};

/** A tiny seeded generator, so a failure names its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const ALPHABET = [
  'a',
  'b',
  ' ',
  '*',
  '`',
  '[',
  ']',
  '(',
  ')',
  '\\',
  '@',
  '_',
  '1',
  '\n',
  '**',
  '](',
  ':',
];
const URLS = [
  'https://a.example',
  'https://a.example/x)y',
  'https://b.example/p?q=1&r=\\2',
  'https://c.example/(x)',
];
const REFS = [
  { kind: 'member' as const, id: 'mem_1' },
  { kind: 'task' as const, id: 'tsk_1' },
  { kind: 'restricted' as const, id: 'rst_ABC' },
];

function randomRuns(next: () => number): Run[] {
  const n = 1 + Math.floor(next() * 6);
  const runs: Run[] = [];
  for (let i = 0; i < n; i++) {
    if (next() < 0.15) {
      runs.push({ ref: REFS[Math.floor(next() * REFS.length)]! });
      continue;
    }
    let text = '';
    const len = 1 + Math.floor(next() * 6);
    for (let k = 0; k < len; k++) text += ALPHABET[Math.floor(next() * ALPHABET.length)];
    runs.push({
      text,
      ...(next() < 0.3 ? { bold: true as const } : {}),
      ...(next() < 0.3 ? { italic: true as const } : {}),
      ...(next() < 0.25 ? { code: true as const } : {}),
      ...(next() < 0.25 ? { link: URLS[Math.floor(next() * URLS.length)]! } : {}),
    });
  }
  return normalizeRuns(runs);
}

describe('inline syntax', () => {
  it('writes each mark in the documented syntax', () => {
    expect(
      serialize([
        { text: 'a ' },
        { text: 'b', bold: true },
        { text: ' ' },
        { text: 'i', italic: true },
        { text: ' ' },
        { text: 'c', code: true },
        { text: ' ' },
        { text: 'l', link: 'https://x.example' },
      ]),
    ).toBe('a **b** *i* `c` [l](https://x.example)');
  });

  it('reads the documented syntax', () => {
    expect(parse('plain **bold *both*** `code` [site](https://x.example)')).toEqual([
      { text: 'plain ' },
      { text: 'bold ', bold: true },
      { text: 'both', bold: true, italic: true },
      { text: ' ' },
      { text: 'code', code: true },
      { text: ' ' },
      { text: 'site', link: 'https://x.example' },
    ]);
  });

  it('shows a reference by its resolved label and keeps only kind and identifier', () => {
    const runs: Run[] = [{ text: 'See ' }, { ref: { kind: 'task', id: 'tsk_1' } }];
    const text = serialize(runs, refs);
    expect(text).toBe('See [Fix \\*the\\* bug](ref:task:tsk_1)');
    expect(parse(text)).toEqual(runs);
    // A label typed into the text box is never stored.
    expect(parse('[Anything at all](ref:task:tsk_1)')).toEqual([
      { ref: { kind: 'task', id: 'tsk_1' } },
    ]);
  });

  it('shows "Restricted item" for restricted tokens and unresolved references, keeping the token exactly', () => {
    const runs: Run[] = [
      { ref: { kind: 'restricted', id: 'rst_01ABC' } },
      { ref: { kind: 'document', id: 'doc_unknown' } },
    ];
    const text = serialize(runs, refs);
    expect(text).toBe(
      `[${RESTRICTED_LABEL}](ref:restricted:rst_01ABC)[${RESTRICTED_LABEL}](ref:document:doc_unknown)`,
    );
    expect(parse(text)).toEqual(runs);
    expect(plain(runs, refs)).toBe(`${RESTRICTED_LABEL}${RESTRICTED_LABEL}`);
  });

  it('keeps markers inside code, inside escapes, and in brackets as plain text', () => {
    for (const text of [
      '`**not bold**`',
      '\\*star\\*',
      '\\[x\\](y)',
      'a ** b',
      '*',
      '`',
      '[a',
      'a]',
      '[a](b',
    ]) {
      const runs = parse(text);
      expect(parse(serialize(runs))).toEqual(runs);
    }
    expect(parse('`**x**`')).toEqual([{ text: '**x**', code: true }]);
    expect(parse('\\*x\\*')).toEqual([{ text: '*x*' }]);
    // A lone marker is text, not a style that never ends.
    expect(parse('2 * 3')).toEqual([{ text: '2 * 3' }]);
    expect(parse('a **b')).toEqual([{ text: 'a **b' }]);
  });

  it('allows bold and italic to nest in either order and across a link', () => {
    expect(parse('***x***')).toEqual([{ text: 'x', bold: true, italic: true }]);
    expect(parse('**[a](https://x.example)b**')).toEqual([
      { text: 'a', bold: true, link: 'https://x.example' },
      { text: 'b', bold: true },
    ]);
    expect(parse('[**a**b](https://x.example)')).toEqual([
      { text: 'a', bold: true, link: 'https://x.example' },
      { text: 'b', link: 'https://x.example' },
    ]);
  });

  it('turns an unreadable link into text rather than losing it', () => {
    expect(parse('[a]( )')).toEqual([{ text: '[a]( )' }]);
    expect(parse('[a]()')).toEqual([{ text: '[a]()' }]);
  });

  it('round-trips awkward text exactly', () => {
    const cases: Run[][] = [
      [{ text: 'a\\b *c* `d` [e](f) **g**' }],
      [{ text: 'x'.repeat(20_000) }],
      [
        { text: 'tick ` inside', code: true },
        { text: 'back\\slash', code: true, bold: true },
      ],
      [{ text: 'a', link: 'https://x.example/(1)\\' }, { text: 'b' }],
      [
        { text: 'a', bold: true },
        { text: 'b', italic: true },
        { text: 'c', bold: true, italic: true },
      ],
      [{ text: 'line one\nline two' }],
      [{ ref: { kind: 'member', id: 'mem_1' } }, { ref: { kind: 'member', id: 'mem_1' } }],
    ];
    for (const runs of cases) expect(parse(serialize(runs, refs))).toEqual(normalizeRuns(runs));
  });

  it('round-trips 600 generated run lists (property test, fixed seeds)', () => {
    for (let seed = 1; seed <= 600; seed++) {
      const runs = randomRuns(rng(seed));
      const text = serialize(runs, refs);
      expect(parse(text), `seed ${seed}: ${JSON.stringify(text)}`).toEqual(runs);
      // Writing what was read changes nothing (a stable text box).
      expect(serialize(parse(text), refs), `seed ${seed} stable`).toBe(text);
    }
  });

  it('normalizes: empty text is dropped and equal neighbours merge', () => {
    expect(
      normalizeRuns([{ text: '' }, { text: 'a' }, { text: 'b' }, { text: 'c', bold: true }]),
    ).toEqual([{ text: 'ab' }, { text: 'c', bold: true }]);
  });

  it('lists are one item per line and blank lines are dropped', () => {
    const items = textToItems('one\n\n  \n**two**\nthree');
    expect(items).toEqual([[{ text: 'one' }], [{ text: 'two', bold: true }], [{ text: 'three' }]]);
    expect(itemsToText(items)).toBe('one\n**two**\nthree');
    expect(itemsToText([[{ text: 'a\nb' }]])).toBe('a b');
  });
});
