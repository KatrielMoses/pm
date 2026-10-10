import type { References, RefKind, Run } from './client.ts';

/**
 * The inline text syntax of the document editor (4C). A block's text box shows runs as plain text:
 *
 *   **bold**   *italic*   `code`   [text](https://address)   [label](ref:KIND:ID)
 *
 * Backslash escapes `\`, `*`, backtick, `[` and `]` in text (and `\` and backtick inside code, `\`
 * and `)` inside an address). A reference shows its label from the document's `references` map
 * (resolved by the server for this viewer); a reference with no label shown shows "Restricted
 * item". Labels are never stored: parsing ignores them and keeps only the kind and identifier.
 * `parse(serialize(runs))` equals `runs` for any canonical list of runs (see `normalizeRuns`).
 */

export const RESTRICTED_LABEL = 'Restricted item';

const REF_URL = /^ref:(member|team|task|project|brand|document|restricted):([A-Za-z0-9_]{1,64})$/;

export const refKey = (kind: string, id: string) => `${kind}:${id}`;

const esc = (s: string) => s.replace(/[\\*`[\]]/g, '\\$&');
const escCode = (s: string) => s.replace(/[\\`]/g, '\\$&');
const escUrl = (s: string) => s.replace(/[\\)]/g, '\\$&');

/** Drops empty text and merges neighbours that carry the same marks (the canonical form). */
export function normalizeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if ('ref' in r) {
      out.push({ ref: { kind: r.ref.kind, id: r.ref.id } });
      continue;
    }
    if (r.text === '') continue;
    const prev = out[out.length - 1];
    if (
      prev &&
      !('ref' in prev) &&
      !!prev.bold === !!r.bold &&
      !!prev.italic === !!r.italic &&
      !!prev.code === !!r.code &&
      (prev.link ?? null) === (r.link ?? null)
    ) {
      prev.text += r.text;
      continue;
    }
    out.push({
      text: r.text,
      ...(r.bold ? { bold: true as const } : {}),
      ...(r.italic ? { italic: true as const } : {}),
      ...(r.code ? { code: true as const } : {}),
      ...(r.link ? { link: r.link } : {}),
    });
  }
  return out;
}

/** The label a reference shows for this viewer; anything not resolved is the neutral token. */
export function labelFor(
  kind: RefKind,
  id: string,
  refs: References,
  local: Readonly<Record<string, string>> = {},
): string {
  if (kind === 'restricted') return RESTRICTED_LABEL;
  return refs[refKey(kind, id)]?.label ?? local[refKey(kind, id)] ?? RESTRICTED_LABEL;
}

export function referenceToken(label: string, kind: RefKind, id: string): string {
  return `[${esc(label)}](ref:${kind}:${id})`;
}

export function serialize(
  runs: readonly Run[],
  refs: References = {},
  local: Readonly<Record<string, string>> = {},
): string {
  let out = '';
  let bold = false;
  let italic = false;
  let link: string | null = null;
  const toggles = (b: boolean, i: boolean) => {
    let s = '';
    if (b !== bold) {
      s += '**';
      bold = b;
    }
    if (i !== italic) {
      s += '*';
      italic = i;
    }
    return s;
  };
  const closeLink = () => {
    if (link !== null) out += `](${escUrl(link)})`;
    link = null;
  };
  for (const run of runs) {
    if ('ref' in run) {
      closeLink();
      out += toggles(false, false);
      out += referenceToken(
        labelFor(run.ref.kind, run.ref.id, refs, local),
        run.ref.kind,
        run.ref.id,
      );
      continue;
    }
    const next = run.link ?? null;
    if (next !== link) {
      closeLink();
      out += toggles(!!run.bold, !!run.italic);
      if (next !== null) out += '[';
      link = next;
    } else out += toggles(!!run.bold, !!run.italic);
    out += run.code ? `\`${escCode(run.text)}\`` : esc(run.text);
  }
  closeLink();
  out += toggles(false, false);
  return out;
}

type Tok =
  | { k: 'text'; s: string; link: string | null }
  | { k: 'code'; s: string; link: string | null }
  | { k: 'bold' }
  | { k: 'italic' }
  | { k: 'ref'; kind: RefKind; id: string };

const SPECIAL = new Set(['\\', '*', '`', '[', ']']);

function findCodeEnd(text: string, from: number): number {
  let j = from;
  while (j < text.length) {
    const c = text[j]!;
    if (c === '\\' && (text[j + 1] === '\\' || text[j + 1] === '`')) j += 2;
    else if (c === '`') return j;
    else j++;
  }
  return -1;
}

function findLink(
  text: string,
  i: number,
): { inner: string; url: string; end: number } | null {
  let j = i + 1;
  let closed = false;
  while (j < text.length) {
    const c = text[j]!;
    if (c === '\\' && SPECIAL.has(text[j + 1] ?? '')) j += 2;
    else if (c === '`') {
      const e = findCodeEnd(text, j + 1);
      j = e >= 0 ? e + 1 : j + 1;
    } else if (c === '[') return null;
    else if (c === ']') {
      closed = true;
      break;
    } else j++;
  }
  if (!closed || text[j + 1] !== '(') return null;
  let k = j + 2;
  while (k < text.length) {
    const c = text[k]!;
    if (c === '\\' && (text[k + 1] === '\\' || text[k + 1] === ')')) k += 2;
    else if (c === ')') break;
    else if (c === '\n') return null;
    else k++;
  }
  if (k >= text.length) return null;
  const url = text.slice(j + 2, k).replace(/\\([\\)])/g, '$1');
  if (url.trim() === '') return null;
  return { inner: text.slice(i + 1, j), url, end: k + 1 };
}

function tokenize(text: string, link: string | null, out: Tok[]): void {
  let buf = '';
  const flush = () => {
    if (buf) out.push({ k: 'text', s: buf, link });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\' && SPECIAL.has(text[i + 1] ?? '')) {
      buf += text[i + 1];
      i += 2;
    } else if (c === '*') {
      let n = 0;
      while (text[i + n] === '*') n++;
      flush();
      for (let b = 0; b < Math.floor(n / 2); b++) out.push({ k: 'bold' });
      if (n % 2) out.push({ k: 'italic' });
      i += n;
    } else if (c === '`') {
      const end = findCodeEnd(text, i + 1);
      if (end < 0) {
        buf += c;
        i++;
      } else {
        flush();
        out.push({ k: 'code', s: text.slice(i + 1, end).replace(/\\([\\`])/g, '$1'), link });
        i = end + 1;
      }
    } else if (c === '[' && link === null) {
      const l = findLink(text, i);
      if (!l) {
        buf += c;
        i++;
        continue;
      }
      flush();
      const ref = REF_URL.exec(l.url);
      if (ref) out.push({ k: 'ref', kind: ref[1] as RefKind, id: ref[2]! });
      else tokenize(l.inner, l.url, out);
      i = l.end;
    } else {
      buf += c;
      i++;
    }
  }
  flush();
}

export function parse(text: string): Run[] {
  const toks: Tok[] = [];
  tokenize(text, null, toks);
  // A marker with no partner is ordinary text (a lone asterisk is not a style that never ends).
  for (const kind of ['bold', 'italic'] as const) {
    const at = toks.flatMap((t, i) => (t.k === kind ? [i] : []));
    if (at.length % 2) toks[at[at.length - 1]!] = { k: 'text', s: kind === 'bold' ? '**' : '*', link: null };
  }
  const runs: Run[] = [];
  let bold = false;
  let italic = false;
  for (const t of toks) {
    if (t.k === 'bold') bold = !bold;
    else if (t.k === 'italic') italic = !italic;
    else if (t.k === 'ref') runs.push({ ref: { kind: t.kind, id: t.id } });
    else
      runs.push({
        text: t.s,
        ...(bold ? { bold: true as const } : {}),
        ...(italic ? { italic: true as const } : {}),
        ...(t.k === 'code' ? { code: true as const } : {}),
        ...(t.link ? { link: t.link } : {}),
      });
  }
  return normalizeRuns(runs);
}

/** Lists: one item per line. A line break inside an item becomes a space. */
export function itemsToText(
  items: ReadonlyArray<readonly Run[]>,
  refs: References = {},
  local: Readonly<Record<string, string>> = {},
): string {
  return items.map((runs) => serialize(runs, refs, local).replace(/\n/g, ' ')).join('\n');
}

export function textToItems(text: string): Run[][] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parse);
}

/** Plain text of some runs (for summaries and accessible names). */
export function plain(runs: readonly Run[], refs: References = {}): string {
  return runs
    .map((r) => ('ref' in r ? labelFor(r.ref.kind, r.ref.id, refs) : r.text))
    .join('');
}

/** Every reference named in some runs. */
export function referencesIn(runs: readonly Run[]): Array<{ kind: RefKind; id: string }> {
  return runs.flatMap((r) => ('ref' in r ? [r.ref] : []));
}
