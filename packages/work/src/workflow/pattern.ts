/**
 * Safe validation patterns (ADR-0015 W13). Patterns are compiled to a Thompson NFA and simulated
 * over the input in time linear in (input length × automaton size): no backtracking, so no
 * catastrophic patterns. The supported subset: literals, `.`, escapes `\d \w \s \D \W \S` and
 * escaped metacharacters, classes `[a-z0-9_]` and `[^…]`, groups `( )` and `(?: )`, alternation
 * `|`, and quantifiers `* + ? {m} {m,} {m,n}`. No anchors (the whole value must match), back-
 * references, or lookaround. The automaton size is bounded.
 */

type Pred = (c: number) => boolean;
type Ast =
  | { t: 'char'; p: Pred }
  | { t: 'cat'; a: Ast[] }
  | { t: 'alt'; a: Ast[] }
  | { t: 'rep'; a: Ast; min: number; max: number | null }
  | { t: 'empty' };

export class PatternError extends Error {}

/** The largest automaton a pattern may compile to, and the largest bounded repeat. */
export const PATTERN_STATES_MAX = 4000;
export const PATTERN_REPEAT_MAX = 100;

const DIGIT: Pred = (c) => c >= 48 && c <= 57;
const WORD: Pred = (c) => DIGIT(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const SPACE: Pred = (c) => c === 32 || (c >= 9 && c <= 13);
const META = '\\.[]()|*+?{}^$-/';

function parse(src: string): Ast {
  let i = 0;
  const escape = (inClass: boolean): Pred => {
    const c = src[i++];
    if (c === undefined) throw new PatternError('The pattern ends with a backslash.');
    switch (c) {
      case 'd':
        return DIGIT;
      case 'D':
        return (x) => !DIGIT(x);
      case 'w':
        return WORD;
      case 'W':
        return (x) => !WORD(x);
      case 's':
        return SPACE;
      case 'S':
        return (x) => !SPACE(x);
      default: {
        if (!META.includes(c) && !(inClass && c === ']'))
          throw new PatternError(`Unsupported escape \\${c}.`);
        const code = c.codePointAt(0)!;
        return (x) => x === code;
      }
    }
  };
  const klass = (): Pred => {
    const neg = src[i] === '^';
    if (neg) i++;
    const parts: Pred[] = [];
    let first = true;
    while (i < src.length && (src[i] !== ']' || first)) {
      first = false;
      let lo: number;
      if (src[i] === '\\') {
        i++;
        const before = i;
        const p = escape(true);
        if ('dDwWsS'.includes(src[before]!)) {
          parts.push(p);
          continue;
        }
        lo = src[before]!.codePointAt(0)!;
      } else lo = src.codePointAt(i++)!;
      if (src[i] === '-' && src[i + 1] !== ']' && i + 1 < src.length) {
        i++;
        let hi: number;
        if (src[i] === '\\') {
          i++;
          hi = src[i++]!.codePointAt(0)!;
        } else hi = src.codePointAt(i++)!;
        if (hi < lo) throw new PatternError('A class range is reversed.');
        parts.push((x) => x >= lo && x <= hi);
      } else parts.push((x) => x === lo);
    }
    if (src[i] !== ']') throw new PatternError('A class is not closed.');
    i++;
    return neg ? (x) => !parts.some((p) => p(x)) : (x) => parts.some((p) => p(x));
  };
  const atom = (): Ast => {
    const c = src[i]!;
    if (c === '(') {
      i++;
      if (src.startsWith('?:', i)) i += 2;
      else if (src[i] === '?')
        throw new PatternError('Lookaround and named groups are not supported.');
      const inner = alt();
      if (src[i] !== ')') throw new PatternError('A group is not closed.');
      i++;
      return inner;
    }
    if (c === '[') {
      i++;
      return { t: 'char', p: klass() };
    }
    if (c === '\\') {
      i++;
      return { t: 'char', p: escape(false) };
    }
    if (c === '.') {
      i++;
      return { t: 'char', p: (x) => x !== 10 };
    }
    if ('^$'.includes(c))
      throw new PatternError('Anchors are not needed: the whole value must match.');
    if ('*+?{})|]'.includes(c)) throw new PatternError(`Unexpected "${c}".`);
    const code = src.codePointAt(i)!;
    i += code > 0xffff ? 2 : 1;
    return { t: 'char', p: (x) => x === code };
  };
  const quantified = (): Ast => {
    let a = atom();
    for (;;) {
      const c = src[i];
      let min: number;
      let max: number | null;
      if (c === '*') [min, max] = [0, null];
      else if (c === '+') [min, max] = [1, null];
      else if (c === '?') [min, max] = [0, 1];
      else if (c === '{') {
        const m = /^\{(\d{1,3})(,(\d{0,3}))?\}/.exec(src.slice(i));
        if (!m) throw new PatternError('A repeat is written {m}, {m,}, or {m,n}.');
        min = Number(m[1]);
        max = m[2] === undefined ? min : m[3] === '' ? null : Number(m[3]);
        if (min > PATTERN_REPEAT_MAX || (max !== null && (max > PATTERN_REPEAT_MAX || max < min)))
          throw new PatternError(`Repeats are limited to ${PATTERN_REPEAT_MAX}.`);
        i += m[0].length - 1;
      } else return a;
      i++;
      if (src[i] === '?' || src[i] === '+')
        throw new PatternError('Lazy and possessive repeats are not supported.');
      a = { t: 'rep', a, min, max };
    }
  };
  const cat = (): Ast => {
    const a: Ast[] = [];
    while (i < src.length && src[i] !== '|' && src[i] !== ')') a.push(quantified());
    return a.length === 0 ? { t: 'empty' } : a.length === 1 ? a[0]! : { t: 'cat', a };
  };
  const alt = (): Ast => {
    const a = [cat()];
    while (src[i] === '|') {
      i++;
      a.push(cat());
    }
    return a.length === 1 ? a[0]! : { t: 'alt', a };
  };
  const ast = alt();
  if (i !== src.length) throw new PatternError(`Unexpected "${src[i]}".`);
  return ast;
}

// Thompson construction: states with a predicate edge or up to two epsilon edges.
interface State {
  p: Pred | null;
  out: number;
  eps: number[];
}

export interface Pattern {
  test(input: string): boolean;
}

export function compilePattern(src: string, maxLength: number): Pattern {
  if (typeof src !== 'string' || src.length === 0) throw new PatternError('Enter a pattern.');
  if (src.length > maxLength)
    throw new PatternError(`Patterns can be at most ${maxLength} characters.`);
  const ast = parse(src);
  const states: State[] = [];
  const add = (s: State) => {
    if (states.length >= PATTERN_STATES_MAX) throw new PatternError('The pattern is too complex.');
    states.push(s);
    return states.length - 1;
  };
  // Returns [start, end] where end is a fresh accepting-placeholder state.
  const build = (a: Ast): [number, number] => {
    switch (a.t) {
      case 'empty': {
        const s = add({ p: null, out: -1, eps: [] });
        return [s, s];
      }
      case 'char': {
        const e = add({ p: null, out: -1, eps: [] });
        const s = add({ p: a.p, out: e, eps: [] });
        return [s, e];
      }
      case 'cat': {
        const [start, first] = build(a.a[0]!);
        let end = first;
        for (const x of a.a.slice(1)) {
          const [s2, e2] = build(x);
          states[end]!.eps.push(s2);
          end = e2;
        }
        return [start, end];
      }
      case 'alt': {
        const s = add({ p: null, out: -1, eps: [] });
        const e = add({ p: null, out: -1, eps: [] });
        for (const x of a.a) {
          const [s2, e2] = build(x);
          states[s]!.eps.push(s2);
          states[e2]!.eps.push(e);
        }
        return [s, e];
      }
      case 'rep': {
        const s = add({ p: null, out: -1, eps: [] });
        let end = s;
        for (let k = 0; k < a.min; k++) {
          const [s2, e2] = build(a.a);
          states[end]!.eps.push(s2);
          end = e2;
        }
        if (a.max === null) {
          const [s2, e2] = build(a.a);
          const loop = add({ p: null, out: -1, eps: [] });
          states[end]!.eps.push(loop);
          states[loop]!.eps.push(s2);
          states[e2]!.eps.push(loop);
          end = loop;
        } else {
          const e = add({ p: null, out: -1, eps: [] });
          states[end]!.eps.push(e);
          for (let k = a.min; k < a.max; k++) {
            const [s2, e2] = build(a.a);
            states[end]!.eps.push(s2);
            states[e2]!.eps.push(e);
            end = e2;
          }
          end = e;
        }
        return [s, end];
      }
    }
  };
  const [start, accept] = build(ast);
  const closure = (set: Set<number>) => {
    const stack = [...set];
    while (stack.length) {
      const s = stack.pop()!;
      for (const n of states[s]!.eps)
        if (!set.has(n)) {
          set.add(n);
          stack.push(n);
        }
    }
    return set;
  };
  return {
    test(input: string) {
      let cur = closure(new Set([start]));
      for (const ch of input) {
        const code = ch.codePointAt(0)!;
        const next = new Set<number>();
        for (const s of cur) {
          const st = states[s]!;
          if (st.p && st.p(code)) next.add(st.out);
        }
        if (next.size === 0) return false;
        cur = closure(next);
      }
      return cur.has(accept);
    },
  };
}
