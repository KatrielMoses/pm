import { describe, expect, it } from 'vitest';
import {
  configChanges,
  isHashedSetting,
  transitionSnapshot,
} from '../../src/workflow/config-audit.ts';
import {
  FieldValidation,
  normalizeValue,
  parseFieldConfig,
} from '../../src/workflow/field-types.ts';
import {
  compileFormula,
  evaluate,
  FormulaError,
  formulaSource,
  storeResult,
  validateAst,
  type FormulaType,
} from '../../src/workflow/formula.ts';
import { compilePattern, PatternError } from '../../src/workflow/pattern.ts';
import {
  canonical,
  parseFieldDocument,
  serializeFieldDocument,
} from '../../src/workflow/serialization.ts';

const LIMITS = { sourceMax: 2000, nodesMax: 200, refsMax: 20 };
const A = 'fld_00000000000000000000000001';
const B = 'fld_00000000000000000000000002';
const D = 'fld_00000000000000000000000003';
const TYPES: Record<string, FormulaType> = { [A]: 'number', [B]: 'number', [D]: 'date' };
const types = (f: string) => TYPES[f] ?? null;
const run = (src: string, values: Record<string, unknown>) => {
  const { ast } = compileFormula(src, LIMITS, types);
  return evaluate(ast, (f) => (f in values ? (values[f] as never) : null));
};

describe('formula language (OD-11)', () => {
  it('compiles arithmetic, precedence, comparison, conditionals, and functions to a typed AST', () => {
    const { ast, refs } = compileFormula(
      `if({${A}} > 10, round({${A}} * 1.5 + {${B}} / 2, 2), 0)`,
      LIMITS,
      types,
    );
    expect(ast).toMatchObject({ v: 1, result: 'number' });
    expect(refs).toEqual([A, B]);
    expect(run(`{${A}} - {${B}} - 1`, { [A]: 10, [B]: 3 })).toEqual({ ok: true, value: 6 });
    expect(run(`2 + 3 * 4`, {})).toEqual({ ok: true, value: 14 });
    expect(
      run(`if({${A}} > 10, round({${A}} * 1.5 + {${B}} / 2, 2), 0)`, { [A]: 20, [B]: 1 }),
    ).toEqual({ ok: true, value: 30.5 });
    expect(
      run(`days_between({${D}}, add_days({${D}}, 30))`, { [D]: { date: '2026-02-01' } }),
    ).toEqual({ ok: true, value: 30 });
    expect(run(`concat("Q", 3) & "!"`, {})).toEqual({ ok: true, value: 'Q3!' });
  });

  it('typed errors: missing, divide by zero, overflow, invalid; null handling is explicit', () => {
    expect(run(`{${A}} + 1`, {})).toEqual({ ok: false, error: 'missing' });
    expect(run(`coalesce({${A}}, 0) + 1`, {})).toEqual({ ok: true, value: 1 });
    expect(run(`is_empty({${A}})`, {})).toEqual({ ok: true, value: true });
    expect(run(`{${A}} / {${B}}`, { [A]: 1, [B]: 0 })).toEqual({
      ok: false,
      error: 'divide_by_zero',
    });
    expect(run(`{${A}} * {${A}} * {${A}}`, { [A]: 1e7 })).toEqual({ ok: false, error: 'overflow' });
    expect(run(`round({${A}}, 1.5)`, { [A]: 1 })).toEqual({ ok: false, error: 'invalid' });
  });

  it('refuses code, unknown functions, type mismatches, and oversized formulas', () => {
    for (const bad of [
      'eval("1")',
      'process.exit()',
      '`1`',
      '{fld_x}',
      '1 +',
      `{${A}} + "a"`,
      'if(true, 1, "a")',
      'now()',
      'random()',
    ])
      expect(() => compileFormula(bad, LIMITS, types), bad).toThrow(FormulaError);
    expect(() => compileFormula('1+'.repeat(150) + '1', LIMITS, types)).toThrow(
      /at most 200 parts/,
    );
    expect(() => compileFormula('x'.repeat(2001), LIMITS, types)).toThrow(/2000 characters/);
  });

  it('validates stored ASTs strictly and renders them back to source', () => {
    const { ast } = compileFormula(`round({${A}} / 3, 2)`, LIMITS, types);
    expect(validateAst(JSON.parse(JSON.stringify(ast)), LIMITS)).toEqual(ast);
    expect(() => validateAst({ ...ast, root: { k: 'fn', n: 'eval', a: [] } }, LIMITS)).toThrow(
      FormulaError,
    );
    expect(() => validateAst({ ...ast, root: { k: 'num', v: '1', extra: 1 } }, LIMITS)).toThrow(
      FormulaError,
    );
    expect(formulaSource(ast.root)).toBe(`round(({${A}} / 3), 2)`);
    expect(storeResult('number', 0.1 + 0.2)).toBe('0.3');
  });
});

describe('safe patterns', () => {
  it('matches the whole value with the supported subset', () => {
    const p = compilePattern('[A-Z]{2,3}-\\d{3,}', 200);
    expect(p.test('AB-123')).toBe(true);
    expect(p.test('ABCD-123')).toBe(false);
    expect(p.test('AB-12')).toBe(false);
    expect(compilePattern('(?:cat|dog)s?', 200).test('dogs')).toBe(true);
  });

  it('runs in linear time on classic catastrophic patterns', () => {
    const p = compilePattern('(a+)+b', 200);
    const t = performance.now();
    expect(p.test('a'.repeat(5000))).toBe(false);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  it('refuses backreferences, lookaround, anchors, and oversized repeats', () => {
    for (const bad of ['(a)\\1', '(?=a)', '^a$', 'a{1000}', '[z-a]', 'a**?', '('])
      expect(() => compilePattern(bad, 200), bad).toThrow(PatternError);
  });
});

describe('field values', () => {
  const b = { textMax: 5000, patternMax: 200 };
  const none = async () => null;
  const val = (type: Parameters<typeof parseFieldConfig>[0], config: unknown, v: unknown) =>
    normalizeValue(
      { type, config: parseFieldConfig(type, config, b), name: 'F' },
      v,
      '/fields/x',
      b,
      none,
    );

  it('currency is integer minor units with an ISO 4217 code; no floats, no conversion', async () => {
    expect(await val('currency', { currency: 'USD' }, { amount: '12.34' })).toEqual({
      minor: '1234',
      currency: 'USD',
    });
    expect(await val('currency', { currency: 'JPY' }, { amount: '500' })).toEqual({
      minor: '500',
      currency: 'JPY',
    });
    expect(await val('currency', { currency: 'KWD' }, { minor: '1500' })).toEqual({
      minor: '1500',
      currency: 'KWD',
    });
    await expect(val('currency', { currency: 'USD' }, { amount: '1.234' })).rejects.toThrow(
      FieldValidation,
    );
    await expect(
      val('currency', { currency: 'USD' }, { minor: '1', currency: 'EUR' }),
    ).rejects.toThrow(FieldValidation);
    expect(() => parseFieldConfig('currency', { currency: 'XYZ' }, b)).toThrow(FieldValidation);
  });

  it('percentage and number bounds and scale; dates, URLs, emails, patterns', async () => {
    expect(await val('percentage', { scale: 1 }, '12.5')).toBe('12.5');
    await expect(val('percentage', {}, '120')).rejects.toThrow(FieldValidation);
    await expect(val('number', { scale: 0 }, '1.5')).rejects.toThrow(FieldValidation);
    expect(await val('number', { min: '0', max: '10', scale: 2 }, 3.5)).toBe('3.5');
    await expect(val('date', { min_date: '2026-01-01' }, '2025-12-31')).rejects.toThrow(
      FieldValidation,
    );
    await expect(val('date', {}, '2026-02-30')).rejects.toThrow(FieldValidation);
    expect(await val('url', {}, ' https://Example.com/a ')).toBe('https://example.com/a');
    await expect(val('url', {}, 'javascript:alert(1)')).rejects.toThrow(FieldValidation);
    await expect(val('url', {}, 'http://example.com')).rejects.toThrow(FieldValidation);
    expect(await val('email', {}, ' Ada@Example.COM ')).toBe('Ada@example.com');
    await expect(val('email', {}, 'not-an-email')).rejects.toThrow(FieldValidation);
    await expect(val('text', { pattern: '[A-Z]{3}' }, 'abc')).rejects.toThrow(FieldValidation);
    await expect(val('person', {}, 'mem_x')).rejects.toThrow(FieldValidation);
    expect(() => parseFieldConfig('text', { pattern: '(a)\\1' }, b)).toThrow(FieldValidation);
    expect(() => parseFieldConfig('text', { secret: 1 }, b)).toThrow(FieldValidation);
  });
});

describe('canonical serialization (WFL-014)', () => {
  const doc = {
    schema: 'pm.custom-fields',
    version: 1,
    definitions: [
      {
        id: A,
        lineage: A,
        scope: { kind: 'workspace' },
        applies_to: ['task'],
        name: 'Points',
        description: null,
        type: 'number',
        config: { scale: 0 },
        required: false,
        presentation: 'primary',
        applicability: 'always',
        view_visibility: { board: true },
        visibility: {
          read: 'all_readers',
          read_min_level: null,
          edit_min_level: null,
          guest_visible: false,
        },
        options: [],
        formula: null,
        state: 'active',
        extensions: { future_flag: { nested: [1, 2] } },
      },
      { opaque: { type: 'rating_v9', stars: 5 } },
    ],
    field_sets: [],
    values: [
      {
        record: 'tsk_00000000000000000000000001',
        field: A,
        value: '3',
        computed: false,
        error: null,
        extensions: {},
      },
    ],
    extensions: { produced_by: 'future' },
  };

  it('round-trips losslessly and keeps unknown parts opaque', () => {
    const limits = { ...LIMITS, itemsMax: 1000 };
    const once = serializeFieldDocument(parseFieldDocument(doc, limits));
    expect(canonical(once)).toBe(canonical(doc));
    expect(canonical(serializeFieldDocument(parseFieldDocument(once, limits)))).toBe(
      canonical(doc),
    );
    const unknownType = { ...doc, definitions: [{ ...doc.definitions[0], type: 'hologram' }] };
    const parsed = parseFieldDocument(unknownType, limits);
    expect(parsed.definitions[0]).toEqual({ opaque: unknownType.definitions[0] });
  });
});

describe('configuration audit facts (ADR-0015 W9)', () => {
  const base = {
    public_id: 'trn_00000000000000000000000001',
    from: 'sts_00000000000000000000000001',
    to: 'sts_00000000000000000000000002',
    description: 'Ship only after QA signs off with Ada',
    confirmation_tier: 'none',
    approval_policy: 'none',
    allow_self_approval: false,
    state: 'active',
    version: 1,
    requirements: [{ ref: 'builtin:due_date', override: false }],
    approvers: [] as string[],
  };

  it('records scalar before/after for settings and hashes for content and approver identities', () => {
    const before = transitionSnapshot(base);
    const after = transitionSnapshot({
      ...base,
      approval_policy: 'all_named_approvers',
      approvers: ['mem_00000000000000000000000009'],
      description: 'Changed wording',
      requirements: [
        { ref: 'fld_00000000000000000000000004', override: true },
        { ref: 'builtin:due_date', override: false },
      ],
      version: 2,
    });
    const changes = configChanges(
      'transition',
      'workflow.update_transition',
      'brand',
      before,
      after,
    );
    const byField = Object.fromEntries(changes.map((c) => [c.field, c]));
    expect(byField['transition.operation']).toMatchObject({
      class: 'plain',
      new: 'workflow.update_transition',
    });
    expect(byField['transition.id']).toMatchObject({ old: base.public_id, new: base.public_id });
    expect(byField['transition.changed']).toMatchObject({
      new: [
        'approval_policy',
        'approver_count',
        'approvers_hash',
        'description_hash',
        'required_fields',
      ],
    });
    expect(byField['transition.approval_policy']).toMatchObject({
      old: 'none',
      new: 'all_named_approvers',
    });
    expect(byField['transition.required_fields']).toMatchObject({
      old: ['builtin:due_date'],
      new: ['builtin:due_date', 'fld_00000000000000000000000004:override'],
    });
    expect(byField['transition.description_hash']!.new).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(byField['transition.approvers_hash']!.new).toMatch(/^sha256:[0-9a-f]{64}$/);
    // No free text, personal identifier, or unchanged setting is in the entry.
    const text = JSON.stringify(changes);
    for (const leak of ['Ada', 'QA signs off', 'Changed wording', 'mem_00000000000000000000000009'])
      expect(text).not.toContain(leak);
    expect(byField['transition.confirmation']).toBeUndefined();
    for (const c of changes)
      if (isHashedSetting(c.field)) expect(String((c as { new: unknown }).new)).toMatch(/^sha256:/);
  });

  it('is deterministic, covers creation and deletion, and stays within the ledger bounds', () => {
    const a = configChanges('transition', 'op', 'workspace', null, transitionSnapshot(base));
    const b = configChanges(
      'transition',
      'op',
      'workspace',
      null,
      transitionSnapshot({ ...base, requirements: [...base.requirements] }),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const gone = configChanges('transition', 'op', 'workspace', transitionSnapshot(base), null);
    expect(gone.find((c) => c.field === 'transition.state')).toMatchObject({
      old: 'active',
      new: null,
    });
    expect(a.length).toBeLessThan(20);
  });
});
