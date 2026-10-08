/**
 * Search semantics (Phase 5A, ADR-0028): pure functions with no database access, so the query
 * language, the snippet rules, and the filter canonical form are tested exactly as they run.
 */

/** The ASCII punctuation the index and the query both treat as a word separator. */
const SEPARATOR = /[\s!-/:-@[-`{-~]+/u;
const WORD = /[^\s!-/:-@[-`{-~]+/gu;
const TOKEN_MAX = 64;

export type QueryIssue = 'empty' | 'no_terms' | 'too_long' | 'too_many_terms';

export type QueryTerm =
  | { kind: 'word'; token: string; prefix: boolean; negate: boolean; exact?: true }
  | { kind: 'phrase'; tokens: string[]; negate: boolean };

export interface ParsedQuery {
  terms: QueryTerm[];
  /** The positive words (lowercase) the snippet marks; a prefix word marks any word it starts. */
  marks: string[];
}

export type SearchParseResult = { ok: true; query: ParsedQuery } | { ok: false; issue: QueryIssue };

/** Splits one raw word into index tokens by the shared separator rule. */
export function tokensOf(raw: string): string[] {
  return raw
    .normalize('NFC')
    .split(SEPARATOR)
    .filter(Boolean)
    .map((t) => t.slice(0, TOKEN_MAX));
}

/**
 * The query language: words are all required; `"a phrase"` must appear in that order (a quoted
 * single word is not completed by prefix); `-word` or
 * `-"a phrase"` excludes; a word with punctuation inside (`report.final.pdf`) is a phrase of its
 * parts. The last positive word also matches by prefix, so results appear as the person types.
 * A query of only exclusions or punctuation has no terms and is refused, never "everything".
 */
export function parseSearchQuery(
  raw: string,
  limits: { maxChars: number; maxTerms: number },
): SearchParseResult {
  const text = raw.normalize('NFC').trim();
  if (!text) return { ok: false, issue: 'empty' };
  if ([...text].length > limits.maxChars) return { ok: false, issue: 'too_long' };
  const terms: QueryTerm[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/u.test(text[i]!)) i++;
    if (i >= text.length) break;
    let negate = false;
    if (text[i] === '-' && i + 1 < text.length && !/\s/u.test(text[i + 1]!)) {
      negate = true;
      i++;
    }
    if (text[i] === '"') {
      const end = text.indexOf('"', i + 1);
      const inner = text.slice(i + 1, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end + 1;
      const tokens = tokensOf(inner);
      if (tokens.length === 1)
        terms.push({ kind: 'word', token: tokens[0]!, prefix: false, negate, exact: true });
      else if (tokens.length > 1) terms.push({ kind: 'phrase', tokens, negate });
      continue;
    }
    let j = i;
    while (j < text.length && !/\s/u.test(text[j]!)) j++;
    const tokens = tokensOf(text.slice(i, j));
    i = j;
    if (tokens.length === 1) terms.push({ kind: 'word', token: tokens[0]!, prefix: false, negate });
    else if (tokens.length > 1) terms.push({ kind: 'phrase', tokens, negate });
  }
  if (terms.length > limits.maxTerms) return { ok: false, issue: 'too_many_terms' };
  const positive = terms.filter((t) => !t.negate);
  if (!positive.length) return { ok: false, issue: 'no_terms' };
  // The last positive word completes by prefix (the word being typed), unless it was quoted.
  const last = [...terms].reverse().find((t) => !t.negate);
  if (last?.kind === 'word' && !last.exact) last.prefix = true;
  const marks: string[] = [];
  for (const t of positive)
    for (const w of t.kind === 'word' ? [t.token] : t.tokens) {
      const lower = w.toLowerCase();
      if (!marks.includes(lower)) marks.push(lower);
    }
  return { ok: true, query: { terms, marks } };
}

const quote = (token: string) => `'${token.replace(/'/g, "''")}'`;

/**
 * The text of one term for `to_tsquery` in the `simple` configuration (exact words, phrases in
 * order, and the prefix form of the last word), and for `english` (stemmed words; phrases are the
 * `simple` form's business). Tokens contain no separator, so quoting them is complete escaping.
 */
export function tsqueryText(term: QueryTerm): { simple: string; english: string | null } {
  if (term.kind === 'phrase')
    return { simple: term.tokens.map(quote).join(' <-> '), english: null };
  // A quoted word is not completed by prefix; it is still matched by its stem.
  return {
    simple: `${quote(term.token)}${term.prefix ? ':*' : ''}`,
    english: quote(term.token),
  };
}

// -------------------------------------------------------------------------------------------
// Snippets and highlights: structured parts, never markup
// -------------------------------------------------------------------------------------------

export interface SnippetPart {
  text: string;
  /** True for text that matched the query. */
  hit?: true;
}

export interface Snippet {
  parts: SnippetPart[];
  /** The text continues before / after the excerpt. */
  more_before: boolean;
  more_after: boolean;
}

interface Word {
  start: number;
  end: number;
  lower: string;
}

function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(WORD))
    out.push({ start: m.index!, end: m.index! + m[0].length, lower: m[0].toLowerCase() });
  return out;
}

const isMark = (w: Word, marks: readonly string[]) =>
  marks.some((m) => w.lower === m || w.lower.startsWith(m));

/**
 * An excerpt of `text` of at most `maxChars` characters, around the first matching word, with every
 * matching word marked. Whitespace (including line breaks) collapses to single spaces. With no
 * match in the text (a stemmed or deeper match) the excerpt is the start of the text, unmarked.
 */
export function makeSnippet(
  text: string,
  marks: readonly string[],
  maxChars: number,
): Snippet | null {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (!flat) return null;
  const words = wordsOf(flat);
  const first = words.find((w) => isMark(w, marks));
  let start = 0;
  if (first && first.start > Math.floor(maxChars / 4)) {
    // Begin a few words before the first match, on a word boundary.
    const target = Math.max(0, first.start - Math.floor(maxChars / 4));
    const lead = words.find((w) => w.start >= target);
    start = lead ? lead.start : target;
  }
  let end = Math.min(flat.length, start + maxChars);
  if (end < flat.length) {
    const lastSpace = flat.lastIndexOf(' ', end);
    if (lastSpace > start + Math.floor(maxChars / 2)) end = lastSpace;
  }
  const slice = flat.slice(start, end).trimEnd();
  const parts: SnippetPart[] = [];
  let cursor = 0;
  for (const w of wordsOf(slice)) {
    if (!isMark(w, marks)) continue;
    // A marked word is marked up to the characters the query matched, not past the word.
    if (w.start > cursor) parts.push({ text: slice.slice(cursor, w.start) });
    parts.push({ text: slice.slice(w.start, w.end), hit: true });
    cursor = w.end;
  }
  if (cursor < slice.length) parts.push({ text: slice.slice(cursor) });
  return { parts, more_before: start > 0, more_after: end < flat.length };
}

// -------------------------------------------------------------------------------------------
// Index text
// -------------------------------------------------------------------------------------------

/** One line of at most `max` characters (for a title built from a body). */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const chars = [...flat];
  return chars.length <= max
    ? flat
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

/** Indexed text is cut at `max` characters on a character (not byte) boundary. */
export function clampBody(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

// -------------------------------------------------------------------------------------------
// Filters
// -------------------------------------------------------------------------------------------

export const SEARCH_STATES = ['active', 'archived', 'any'] as const;
export type SearchState = (typeof SEARCH_STATES)[number];
export const SEARCH_WINDOWS = ['day', 'week', 'month', 'year'] as const;
export type SearchWindow = (typeof SEARCH_WINDOWS)[number];

export const WINDOW_DAYS: Record<SearchWindow, number> = { day: 1, week: 7, month: 31, year: 366 };

/** Index states a person can be told (never "complete" while anything they can see is queued). */
export type IndexState = 'complete' | 'catching_up' | 'degraded';

export function indexState(pending: number, failed: number): IndexState {
  return failed > 0 ? 'degraded' : pending > 0 ? 'catching_up' : 'complete';
}

/** Backoff before the next attempt: `base` seconds, doubling per attempt, at most one hour. */
export function backoffSeconds(attempt: number, baseSeconds: number): number {
  return Math.min(baseSeconds * 2 ** Math.max(attempt - 1, 0), 3600);
}
