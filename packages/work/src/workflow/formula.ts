/**
 * Formula fields (OD-11, ADR-0015 W17–W19): a small expression language compiled to a versioned
 * typed AST. Nothing is ever executed as code: the parser is hand-written, the evaluator walks the
 * AST, and the only operations are literals, same-record field references, arithmetic, comparison,
 * boolean logic, conditionals, null handling, and the fixed function registry below. There is no
 * network, current time, randomness, context, cross-record access, or side effect.
 */

export const FORMULA_AST_VERSION = 1;

export type FormulaType = 'number' | 'text' | 'boolean' | 'date';
export type FormulaErrorCode = 'missing' | 'invalid' | 'divide_by_zero' | 'cycle' | 'overflow';

export type Node =
  | { k: 'num'; v: string }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'ref'; f: string }
  | { k: 'op'; o: BinaryOp; a: [Node, Node] }
  | { k: 'not'; a: [Node] }
  | { k: 'neg'; a: [Node] }
  | { k: 'fn'; n: FunctionName; a: Node[] };
export interface FormulaAst {
  v: typeof FORMULA_AST_VERSION;
  root: Node;
  result: FormulaType;
}

type BinaryOp = '+' | '-' | '*' | '/' | '=' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or' | '&';
const BINARY: ReadonlySet<string> = new Set([
  '+',
  '-',
  '*',
  '/',
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'and',
  'or',
  '&',
]);

/** The deterministic function registry: name → arity bounds. */
export const FUNCTIONS = {
  if: [3, 3],
  coalesce: [2, 8],
  is_empty: [1, 1],
  round: [1, 2],
  floor: [1, 1],
  ceil: [1, 1],
  abs: [1, 1],
  min: [2, 8],
  max: [2, 8],
  concat: [2, 8],
  len: [1, 1],
  lower: [1, 1],
  upper: [1, 1],
  days_between: [2, 2],
  add_days: [2, 2],
  year: [1, 1],
  month: [1, 1],
} as const satisfies Record<string, readonly [number, number]>;
export type FunctionName = keyof typeof FUNCTIONS;

export interface FormulaLimits {
  sourceMax: number;
  nodesMax: number;
  refsMax: number;
}

/** A compile or type problem, reported as a field issue (never with input values). */
export class FormulaError extends Error {
  readonly code: 'formula_invalid' | 'limit_exceeded';
  readonly at: number | undefined;
  constructor(code: 'formula_invalid' | 'limit_exceeded', message: string, at?: number) {
    super(message);
    this.code = code;
    this.at = at;
  }
}

// -----------------------------------------------------------------------------------------------
// Tokenizer and parser (precedence climbing, bounded by node count)
// -----------------------------------------------------------------------------------------------

type Tok =
  | { t: 'num'; v: string; at: number }
  | { t: 'str'; v: string; at: number }
  | { t: 'ref'; v: string; at: number }
  | { t: 'id'; v: string; at: number }
  | { t: 'op'; v: string; at: number }
  | { t: 'end'; at: number };

const REF = /^fld_[0-9A-HJKMNP-TV-Z]{26}$/;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*(\.[0-9]+)?/.exec(src.slice(i))![0];
      out.push({ t: 'num', v: m, at: i });
      i += m.length;
    } else if (c === '"') {
      let j = i + 1;
      let v = '';
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\') {
          const e = src[++j];
          if (e !== '"' && e !== '\\')
            throw new FormulaError('formula_invalid', 'Unknown escape.', j);
          v += e;
        } else v += src[j];
      }
      if (j >= src.length) throw new FormulaError('formula_invalid', 'Unclosed text.', i);
      out.push({ t: 'str', v, at: i });
      i = j + 1;
    } else if (c === '{') {
      const j = src.indexOf('}', i);
      const id = j < 0 ? '' : src.slice(i + 1, j).trim();
      if (!REF.test(id))
        throw new FormulaError('formula_invalid', 'A field reference is {fld_…}.', i);
      out.push({ t: 'ref', v: id, at: i });
      i = j + 1;
    } else if (/[a-z_]/i.test(c)) {
      const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i))![0];
      out.push({ t: 'id', v: m.toLowerCase(), at: i });
      i += m.length;
    } else {
      const two = src.slice(i, i + 2);
      if (two === '!=' || two === '<=' || two === '>=') {
        out.push({ t: 'op', v: two, at: i });
        i += 2;
      } else if ('+-*/=<>(),&'.includes(c)) {
        out.push({ t: 'op', v: c, at: i });
        i++;
      } else throw new FormulaError('formula_invalid', `Unexpected "${c}".`, i);
    }
  }
  out.push({ t: 'end', at: src.length });
  return out;
}

const PREC: Record<string, number> = {
  or: 1,
  and: 2,
  '=': 3,
  '!=': 3,
  '<': 3,
  '<=': 3,
  '>': 3,
  '>=': 3,
  '&': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
};

export function parseFormula(src: string, limits: FormulaLimits): Node {
  if (typeof src !== 'string' || !src.trim())
    throw new FormulaError('formula_invalid', 'Enter a formula.');
  if (src.length > limits.sourceMax)
    throw new FormulaError(
      'limit_exceeded',
      `Formulas can be at most ${limits.sourceMax} characters.`,
    );
  const toks = tokenize(src);
  let p = 0;
  let nodes = 0;
  const count = <T extends Node>(n: T): T => {
    if (++nodes > limits.nodesMax)
      throw new FormulaError(
        'limit_exceeded',
        `Formulas can have at most ${limits.nodesMax} parts.`,
      );
    return n;
  };
  const peek = () => toks[p]!;
  const binop = (t: Tok) =>
    t.t === 'op' && t.v in PREC
      ? t.v
      : t.t === 'id' && (t.v === 'and' || t.v === 'or')
        ? t.v
        : null;
  const expect = (v: string) => {
    const t = peek();
    if (t.t !== 'op' || t.v !== v)
      throw new FormulaError('formula_invalid', `Expected "${v}".`, t.at);
    p++;
  };
  const primary = (): Node => {
    const t = toks[p++]!;
    switch (t.t) {
      case 'num':
        return count({ k: 'num', v: t.v.startsWith('.') ? `0${t.v}` : t.v });
      case 'str':
        return count({ k: 'str', v: t.v });
      case 'ref':
        return count({ k: 'ref', f: t.v });
      case 'id': {
        if (t.v === 'true' || t.v === 'false') return count({ k: 'bool', v: t.v === 'true' });
        if (t.v === 'null') return count({ k: 'null' });
        if (t.v === 'not') return count({ k: 'not', a: [unary()] });
        if (!(t.v in FUNCTIONS))
          throw new FormulaError('formula_invalid', `Unknown function "${t.v}".`, t.at);
        expect('(');
        const args: Node[] = [];
        if (!(peek().t === 'op' && (peek() as { v: string }).v === ')')) {
          args.push(expr(0));
          while (peek().t === 'op' && (peek() as { v: string }).v === ',') {
            p++;
            args.push(expr(0));
          }
        }
        expect(')');
        const [lo, hi] = FUNCTIONS[t.v as FunctionName];
        if (args.length < lo || args.length > hi)
          throw new FormulaError(
            'formula_invalid',
            `${t.v} takes ${lo === hi ? lo : `${lo}–${hi}`} values.`,
            t.at,
          );
        return count({ k: 'fn', n: t.v as FunctionName, a: args });
      }
      case 'op':
        if (t.v === '(') {
          const e = expr(0);
          expect(')');
          return e;
        }
        throw new FormulaError('formula_invalid', `Unexpected "${t.v}".`, t.at);
      default:
        throw new FormulaError('formula_invalid', 'The formula ends too early.', t.at);
    }
  };
  const unary = (): Node => {
    const t = peek();
    if (t.t === 'op' && t.v === '-') {
      p++;
      return count({ k: 'neg', a: [unary()] });
    }
    return primary();
  };
  const expr = (min: number): Node => {
    let left = unary();
    for (;;) {
      // Left-associative: the right operand binds only tighter operators.
      const op = binop(peek());
      if (!op || PREC[op]! <= min) break;
      p++;
      const right = expr(PREC[op]!);
      left = count({ k: 'op', o: op as BinaryOp, a: [left, right] });
    }
    return left;
  };
  const root = expr(0);
  if (peek().t !== 'end')
    throw new FormulaError('formula_invalid', 'Unexpected text after the formula.', peek().at);
  return root;
}

/** Field references in an AST (unique, in first-use order). */
export function formulaRefs(n: Node, out: string[] = []): string[] {
  if (n.k === 'ref') {
    if (!out.includes(n.f)) out.push(n.f);
  } else if ('a' in n) for (const c of n.a) formulaRefs(c, out);
  return out;
}

// -----------------------------------------------------------------------------------------------
// Type checking
// -----------------------------------------------------------------------------------------------

type T = FormulaType | 'null';

/**
 * Infers the result type, given the types of referenced fields. Throws `formula_invalid` for a
 * type mismatch. `null` is compatible with every type (null handling is explicit).
 */
export function typeOf(n: Node, refType: (f: string) => FormulaType | null): T {
  const sub = (x: Node) => typeOf(x, refType);
  const need = (x: Node, want: FormulaType[], what: string): T => {
    const t = sub(x);
    if (t !== 'null' && !want.includes(t))
      throw new FormulaError('formula_invalid', `${what} needs ${want.join(' or ')}.`);
    return t;
  };
  switch (n.k) {
    case 'num':
      return 'number';
    case 'str':
      return 'text';
    case 'bool':
      return 'boolean';
    case 'null':
      return 'null';
    case 'ref': {
      const t = refType(n.f);
      if (!t)
        throw new FormulaError('formula_invalid', 'A referenced field cannot be used in formulas.');
      return t;
    }
    case 'neg':
      need(n.a[0], ['number'], 'Negation');
      return 'number';
    case 'not':
      need(n.a[0], ['boolean'], 'not');
      return 'boolean';
    case 'op': {
      const [l, r] = n.a;
      if (n.o === 'and' || n.o === 'or') {
        need(l, ['boolean'], n.o);
        need(r, ['boolean'], n.o);
        return 'boolean';
      }
      if (n.o === '&') {
        need(l, ['text', 'number'], '&');
        need(r, ['text', 'number'], '&');
        return 'text';
      }
      if (['+', '-', '*', '/'].includes(n.o)) {
        need(l, ['number'], n.o);
        need(r, ['number'], n.o);
        return 'number';
      }
      const a = sub(l);
      const b = sub(r);
      if (a !== 'null' && b !== 'null' && a !== b)
        throw new FormulaError('formula_invalid', 'Compare values of the same type.');
      if (n.o !== '=' && n.o !== '!=' && (a === 'boolean' || b === 'boolean'))
        throw new FormulaError('formula_invalid', 'Booleans can only be compared for equality.');
      return 'boolean';
    }
    case 'fn': {
      const a = n.a;
      switch (n.n) {
        case 'if': {
          need(a[0]!, ['boolean'], 'if');
          const x = sub(a[1]!);
          const y = sub(a[2]!);
          if (x !== 'null' && y !== 'null' && x !== y)
            throw new FormulaError('formula_invalid', 'Both if branches need the same type.');
          return x === 'null' ? y : x;
        }
        case 'coalesce': {
          let t: T = 'null';
          for (const x of a) {
            const u = sub(x);
            if (u === 'null') continue;
            if (t !== 'null' && u !== t)
              throw new FormulaError('formula_invalid', 'coalesce needs values of one type.');
            t = u;
          }
          return t;
        }
        case 'is_empty':
          sub(a[0]!);
          return 'boolean';
        case 'round':
        case 'floor':
        case 'ceil':
        case 'abs':
        case 'min':
        case 'max':
          for (const x of a) need(x, ['number'], n.n);
          return 'number';
        case 'concat':
          for (const x of a) need(x, ['text', 'number'], 'concat');
          return 'text';
        case 'len':
          need(a[0]!, ['text'], 'len');
          return 'number';
        case 'lower':
        case 'upper':
          need(a[0]!, ['text'], n.n);
          return 'text';
        case 'days_between':
          need(a[0]!, ['date'], 'days_between');
          need(a[1]!, ['date'], 'days_between');
          return 'number';
        case 'add_days':
          need(a[0]!, ['date'], 'add_days');
          need(a[1]!, ['number'], 'add_days');
          return 'date';
        case 'year':
        case 'month':
          need(a[0]!, ['date'], n.n);
          return 'number';
      }
    }
  }
}

/** Parses, type-checks, and bounds a formula; returns the AST and its referenced public IDs. */
export function compileFormula(
  src: string,
  limits: FormulaLimits,
  refType: (f: string) => FormulaType | null,
): { ast: FormulaAst; refs: string[] } {
  const root = parseFormula(src, limits);
  const refs = formulaRefs(root);
  if (refs.length > limits.refsMax)
    throw new FormulaError(
      'limit_exceeded',
      `Formulas can reference at most ${limits.refsMax} fields.`,
    );
  const t = typeOf(root, refType);
  if (t === 'null') throw new FormulaError('formula_invalid', 'A formula must produce a value.');
  return { ast: { v: FORMULA_AST_VERSION, root, result: t }, refs };
}

/** Validates a stored or imported AST (shape, version, registry, bounds) without trusting it. */
export function validateAst(ast: unknown, limits: FormulaLimits): FormulaAst {
  let nodes = 0;
  const bad = () =>
    new FormulaError('formula_invalid', 'The formula is not a valid version 1 formula.');
  const node = (x: unknown): Node => {
    if (++nodes > limits.nodesMax)
      throw new FormulaError(
        'limit_exceeded',
        `Formulas can have at most ${limits.nodesMax} parts.`,
      );
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad();
    const o = x as Record<string, unknown>;
    const keys = Object.keys(o).sort().join(',');
    switch (o.k) {
      case 'num':
        if (keys !== 'k,v' || typeof o.v !== 'string' || !/^[0-9]{1,24}(\.[0-9]{1,12})?$/.test(o.v))
          throw bad();
        return { k: 'num', v: o.v };
      case 'str':
        if (keys !== 'k,v' || typeof o.v !== 'string' || o.v.length > limits.sourceMax) throw bad();
        return { k: 'str', v: o.v };
      case 'bool':
        if (keys !== 'k,v' || typeof o.v !== 'boolean') throw bad();
        return { k: 'bool', v: o.v };
      case 'null':
        if (keys !== 'k') throw bad();
        return { k: 'null' };
      case 'ref':
        if (keys !== 'f,k' || typeof o.f !== 'string' || !REF.test(o.f)) throw bad();
        return { k: 'ref', f: o.f };
      case 'not':
      case 'neg':
        if (keys !== 'a,k' || !Array.isArray(o.a) || o.a.length !== 1) throw bad();
        return { k: o.k, a: [node(o.a[0])] };
      case 'op':
        if (
          keys !== 'a,k,o' ||
          typeof o.o !== 'string' ||
          !BINARY.has(o.o) ||
          !Array.isArray(o.a) ||
          o.a.length !== 2
        )
          throw bad();
        return { k: 'op', o: o.o as BinaryOp, a: [node(o.a[0]), node(o.a[1])] };
      case 'fn': {
        if (
          keys !== 'a,k,n' ||
          typeof o.n !== 'string' ||
          !(o.n in FUNCTIONS) ||
          !Array.isArray(o.a)
        )
          throw bad();
        const [lo, hi] = FUNCTIONS[o.n as FunctionName];
        if (o.a.length < lo || o.a.length > hi) throw bad();
        return { k: 'fn', n: o.n as FunctionName, a: o.a.map(node) };
      }
      default:
        throw bad();
    }
  };
  if (!ast || typeof ast !== 'object') throw bad();
  const a = ast as Record<string, unknown>;
  if (
    a.v !== FORMULA_AST_VERSION ||
    !['number', 'text', 'boolean', 'date'].includes(a.result as string)
  )
    throw bad();
  const root = node(a.root);
  if (formulaRefs(root).length > limits.refsMax)
    throw new FormulaError(
      'limit_exceeded',
      `Formulas can reference at most ${limits.refsMax} fields.`,
    );
  return { v: FORMULA_AST_VERSION, root, result: a.result as FormulaType };
}

/** Renders an AST back to source (canonical spacing), for editing and explanations. */
export function formulaSource(n: Node): string {
  switch (n.k) {
    case 'num':
      return n.v;
    case 'str':
      return `"${n.v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    case 'bool':
      return String(n.v);
    case 'null':
      return 'null';
    case 'ref':
      return `{${n.f}}`;
    case 'neg':
      return `-(${formulaSource(n.a[0])})`;
    case 'not':
      return `not (${formulaSource(n.a[0])})`;
    case 'op':
      return `(${formulaSource(n.a[0])} ${n.o} ${formulaSource(n.a[1])})`;
    case 'fn':
      return `${n.n}(${n.a.map(formulaSource).join(', ')})`;
  }
}

// -----------------------------------------------------------------------------------------------
// Evaluation
// -----------------------------------------------------------------------------------------------

/** A runtime value: numbers are finite doubles, dates ISO `YYYY-MM-DD`, or null. */
export type Value = number | string | boolean | { date: string } | null;

class Fail extends Error {
  readonly code: FormulaErrorCode;
  constructor(code: FormulaErrorCode) {
    super(code);
    this.code = code;
  }
}

/** The largest magnitude a formula number may reach (registered as an invariant, ADR-0015 W18). */
export const FORMULA_NUMBER_LIMIT = 1e18;
const SCALE = 1e12;

const fixNum = (x: number): number => {
  if (!Number.isFinite(x) || Math.abs(x) > FORMULA_NUMBER_LIMIT) throw new Fail('overflow');
  // Twelve decimal places, the stored scale; avoids platform-dependent tails.
  return Math.round(x * SCALE) / SCALE;
};
const epochDay = (iso: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Fail('invalid');
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  const d = new Date(t);
  if (d.getUTCMonth() !== +m[2]! - 1) throw new Fail('invalid');
  return Math.round(t / 86_400_000);
};
const fromEpochDay = (n: number): string => {
  if (!Number.isInteger(n) || Math.abs(n) > 3_000_000) throw new Fail('overflow');
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
};

/**
 * Evaluates an AST against the record's input values (already authorized and typed; `undefined`
 * or null means no value). Returns a typed result or a typed error, never an input value.
 */
export function evaluate(
  ast: FormulaAst,
  input: (field: string) => Value,
): { ok: true; value: Value } | { ok: false; error: FormulaErrorCode } {
  const ev = (n: Node): Value => {
    switch (n.k) {
      case 'num':
        return Number(n.v);
      case 'str':
        return n.v;
      case 'bool':
        return n.v;
      case 'null':
        return null;
      case 'ref': {
        const v = input(n.f);
        return v === undefined ? null : v;
      }
      case 'neg': {
        const x = strict(n.a[0]);
        return fixNum(-(x as number));
      }
      case 'not':
        return !(strict(n.a[0]) as boolean);
      case 'op': {
        if (n.o === 'and') return (strict(n.a[0]) as boolean) && (strict(n.a[1]) as boolean);
        if (n.o === 'or') return (strict(n.a[0]) as boolean) || (strict(n.a[1]) as boolean);
        const a = strict(n.a[0]);
        const b = strict(n.a[1]);
        switch (n.o) {
          case '+':
            return fixNum((a as number) + (b as number));
          case '-':
            return fixNum((a as number) - (b as number));
          case '*':
            return fixNum((a as number) * (b as number));
          case '/':
            if (b === 0) throw new Fail('divide_by_zero');
            return fixNum((a as number) / (b as number));
          case '&':
            return text(a) + text(b);
          default:
            return compare(n.o, a, b);
        }
      }
      case 'fn':
        return call(n.n, n.a);
    }
  };
  /** A value that must be present: a missing input is the `missing` error. */
  const strict = (n: Node): Exclude<Value, null> => {
    const v = ev(n);
    if (v === null) throw new Fail('missing');
    return v;
  };
  const text = (v: Exclude<Value, null>) =>
    typeof v === 'string'
      ? v
      : typeof v === 'number'
        ? String(v)
        : typeof v === 'boolean'
          ? String(v)
          : v.date;
  const key = (v: Exclude<Value, null>) => (typeof v === 'object' ? epochDay(v.date) : v);
  const compare = (o: string, a: Exclude<Value, null>, b: Exclude<Value, null>): boolean => {
    const x = key(a);
    const y = key(b);
    switch (o) {
      case '=':
        return x === y;
      case '!=':
        return x !== y;
      case '<':
        return x < y;
      case '<=':
        return x <= y;
      case '>':
        return x > y;
      default:
        return x >= y;
    }
  };
  const call = (name: FunctionName, args: Node[]): Value => {
    switch (name) {
      case 'if':
        return strict(args[0]!) ? ev(args[1]!) : ev(args[2]!);
      case 'coalesce':
        for (const a of args) {
          const v = ev(a);
          if (v !== null) return v;
        }
        return null;
      case 'is_empty': {
        const v = ev(args[0]!);
        return v === null || v === '';
      }
      case 'round': {
        const x = strict(args[0]!) as number;
        const d = args[1] ? (strict(args[1]) as number) : 0;
        if (!Number.isInteger(d) || d < 0 || d > 12) throw new Fail('invalid');
        const f = 10 ** d;
        return fixNum(Math.round(x * f) / f);
      }
      case 'floor':
        return fixNum(Math.floor(strict(args[0]!) as number));
      case 'ceil':
        return fixNum(Math.ceil(strict(args[0]!) as number));
      case 'abs':
        return fixNum(Math.abs(strict(args[0]!) as number));
      case 'min':
        return fixNum(Math.min(...args.map((a) => strict(a) as number)));
      case 'max':
        return fixNum(Math.max(...args.map((a) => strict(a) as number)));
      case 'concat':
        return args.map((a) => text(strict(a))).join('');
      case 'len':
        return [...(strict(args[0]!) as string)].length;
      case 'lower':
        return (strict(args[0]!) as string).toLowerCase();
      case 'upper':
        return (strict(args[0]!) as string).toUpperCase();
      case 'days_between':
        return (
          epochDay((strict(args[1]!) as { date: string }).date) -
          epochDay((strict(args[0]!) as { date: string }).date)
        );
      case 'add_days': {
        const n = strict(args[1]!) as number;
        if (!Number.isInteger(n)) throw new Fail('invalid');
        return { date: fromEpochDay(epochDay((strict(args[0]!) as { date: string }).date) + n) };
      }
      case 'year':
        return Number((strict(args[0]!) as { date: string }).date.slice(0, 4));
      case 'month':
        return Number((strict(args[0]!) as { date: string }).date.slice(5, 7));
    }
  };
  try {
    const v = ev(ast.root);
    if (typeof v === 'string' && v.length > 20000) return { ok: false, error: 'overflow' };
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.code };
    if (e instanceof RangeError) return { ok: false, error: 'overflow' };
    throw e;
  }
}

/** Canonical storage form of a result (matches the database value shape for the result type). */
export function storeResult(t: FormulaType, v: Value): unknown {
  if (v === null) return null;
  switch (t) {
    case 'number': {
      const n = v as number;
      const s = n.toFixed(12).replace(/\.?0+$/, '');
      return s === '-0' ? '0' : s;
    }
    case 'date':
      return (v as { date: string }).date;
    case 'boolean':
      return v as boolean;
    default:
      return v as string;
  }
}
