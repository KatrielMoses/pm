import { describe, expect, it } from 'vitest';
import {
  backoffSeconds,
  clampBody,
  indexState,
  makeSnippet,
  oneLine,
  parseSearchQuery,
  tokensOf,
  tsqueryText,
  type QueryTerm,
} from '../../src/search/semantics.ts';

const limits = { maxChars: 200, maxTerms: 12 };
const ok = (q: string) => {
  const r = parseSearchQuery(q, limits);
  if (!r.ok) throw new Error(`expected ${q} to parse, got ${r.issue}`);
  return r.query;
};
const bad = (q: string, l = limits) => {
  const r = parseSearchQuery(q, l);
  return r.ok ? null : r.issue;
};

describe('search query language (5A)', () => {
  it('splits on the same ASCII separators the index uses, and keeps every other character', () => {
    expect(tokensOf('report.final-v2_pdf')).toEqual(['report', 'final', 'v2', 'pdf']);
    expect(tokensOf('user@example.com')).toEqual(['user', 'example', 'com']);
    expect(tokensOf('検索 テスト')).toEqual(['検索', 'テスト']);
    expect(tokensOf('Ünïcode')).toEqual(['Ünïcode']);
    expect(tokensOf('  ')).toEqual([]);
    expect(tokensOf('x'.repeat(100))[0]).toHaveLength(64);
  });

  it('parses words, phrases, exclusions, and a word with punctuation as a phrase of its parts', () => {
    const q = ok('wire "bank transfer" -refund report.final');
    expect(q.terms).toEqual([
      { kind: 'word', token: 'wire', prefix: false, negate: false },
      { kind: 'phrase', tokens: ['bank', 'transfer'], negate: false },
      { kind: 'word', token: 'refund', prefix: false, negate: true },
      { kind: 'phrase', tokens: ['report', 'final'], negate: false },
    ]);
    expect(q.marks).toEqual(['wire', 'bank', 'transfer', 'report', 'final']);
    expect(ok('-"a b" c').terms[0]).toEqual({ kind: 'phrase', tokens: ['a', 'b'], negate: true });
    // A lone hyphen or one inside a word is not an exclusion.
    expect(ok('well-known').terms).toEqual([
      { kind: 'phrase', tokens: ['well', 'known'], negate: false },
    ]);
    expect(ok('a - b').terms.map((t) => (t as { token?: string }).token)).toEqual(['a', 'b']);
    // An unterminated quote takes the rest as the phrase.
    expect(ok('say "hello there').terms[1]).toEqual({
      kind: 'phrase',
      tokens: ['hello', 'there'],
      negate: false,
    });
  });

  it('completes only the last positive word by prefix, never a quoted word or a phrase', () => {
    const prefixes = (q: string) => ok(q).terms.map((t) => (t.kind === 'word' ? t.prefix : null));
    expect(prefixes('wire tran')).toEqual([false, true]);
    expect(prefixes('wire tran -x')).toEqual([false, true, false]);
    expect(prefixes('wire "tran"')).toEqual([false, false]);
    expect(prefixes('"wire transfer"')).toEqual([null]);
    expect(prefixes('one')).toEqual([true]);
  });

  it('refuses queries with nothing to match, too long, or too many terms', () => {
    expect(bad('')).toBe('empty');
    expect(bad('   ')).toBe('empty');
    expect(bad('-hello')).toBe('no_terms');
    expect(bad('!!! ???')).toBe('no_terms');
    expect(bad('""')).toBe('no_terms');
    expect(bad('x'.repeat(201))).toBe('too_long');
    expect(bad('a b c', { maxChars: 200, maxTerms: 2 })).toBe('too_many_terms');
    // Characters, not UTF-16 units: 200 emoji are 200 characters.
    expect(bad('😀'.repeat(200))).toBeNull();
    expect(bad('😀'.repeat(201))).toBe('too_long');
  });

  it('writes tsquery text that quotes every token, so no input can inject operators', () => {
    const t = (term: QueryTerm) => tsqueryText(term);
    expect(t({ kind: 'word', token: 'wire', prefix: true, negate: false })).toEqual({
      simple: "'wire':*",
      english: "'wire'",
    });
    expect(t({ kind: 'phrase', tokens: ['a', 'b'], negate: false })).toEqual({
      simple: "'a' <-> 'b'",
      english: null,
    });
    // The separator rule leaves no quote, backslash, colon, or operator in a token.
    for (const hostile of [`it's`, `a\\b`, `x:*`, `a & b | !c`, `<->`, `'); DROP TABLE x;--`]) {
      const parsed = parseSearchQuery(hostile, limits);
      if (!parsed.ok) continue;
      for (const term of parsed.query.terms)
        for (const token of term.kind === 'word' ? [term.token] : term.tokens)
          expect(token).toMatch(/^[^\s!-/:-@[-`{-~]+$/u);
    }
    expect(t({ kind: 'word', token: "o'brien", prefix: false, negate: false }).simple).toBe(
      "'o''brien'",
    );
  });
});

describe('search snippets and marks (5A)', () => {
  const text = (s: ReturnType<typeof makeSnippet>) => s?.parts.map((p) => p.text).join('');
  const hits = (s: ReturnType<typeof makeSnippet>) =>
    s?.parts.filter((p) => p.hit).map((p) => p.text);

  it('marks every matching word, case-insensitively and by prefix, as plain text parts', () => {
    const s = makeSnippet('Invoices and an Invoice for the invoicing team', ['invoic'], 200)!;
    expect(hits(s)).toEqual(['Invoices', 'Invoice', 'invoicing']);
    expect(text(s)).toBe('Invoices and an Invoice for the invoicing team');
    expect(s.more_before).toBe(false);
    expect(s.more_after).toBe(false);
  });

  it('centres a long text on the first match, on word boundaries, within the limit', () => {
    const words = Array.from({ length: 200 }, (_, i) => (i === 120 ? 'needle' : `word${i}`)).join(
      ' ',
    );
    const s = makeSnippet(words, ['needle'], 80)!;
    expect(text(s)!.length).toBeLessThanOrEqual(80);
    expect(hits(s)).toEqual(['needle']);
    expect(s.more_before).toBe(true);
    expect(s.more_after).toBe(true);
    expect(text(s)!.startsWith('word')).toBe(true);
    expect(text(s)!.endsWith(' ')).toBe(false);
  });

  it('collapses whitespace and line breaks, and falls back to the start when nothing matches', () => {
    const s = makeSnippet('First line\n\n  second   line', ['zzz'], 200)!;
    expect(text(s)).toBe('First line second line');
    expect(hits(s)).toEqual([]);
    expect(makeSnippet('   \n ', ['a'], 80)).toBeNull();
  });

  it('never splits a marked character and never produces markup', () => {
    const s = makeSnippet('<b>invoice</b> & "quotes" 検索', ['invoice', '検索'], 200)!;
    expect(hits(s)).toEqual(['invoice', '検索']);
    expect(JSON.stringify(s.parts)).toContain('<b>');
    expect(text(s)).toBe('<b>invoice</b> & "quotes" 検索');
  });
});

describe('search index helpers (5A)', () => {
  it('shortens a body to one line and clamps by character, not byte', () => {
    expect(oneLine('a\n  b   c', 80)).toBe('a b c');
    expect(oneLine('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
    expect(oneLine('😀'.repeat(20), 5)).toBe('😀😀😀😀…');
    expect(clampBody('😀😀😀', 2)).toBe('😀😀');
    expect(clampBody('abc', 10)).toBe('abc');
  });

  it('never calls the index complete while anything is queued or failed', () => {
    expect(indexState(0, 0)).toBe('complete');
    expect(indexState(3, 0)).toBe('catching_up');
    expect(indexState(0, 1)).toBe('degraded');
    expect(indexState(5, 2)).toBe('degraded');
  });

  it('doubles the wait per attempt up to an hour', () => {
    expect([1, 2, 3, 4].map((n) => backoffSeconds(n, 30))).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(20, 30)).toBe(3600);
    expect(backoffSeconds(0, 30)).toBe(30);
  });
});
