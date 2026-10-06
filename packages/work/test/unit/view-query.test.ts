import { describe, expect, it } from 'vitest';
import { TenancyError } from '@pm/tenancy';
import {
  CATALOG,
  DEFAULT_COLUMNS,
  OPERATORS,
  parsePresentation,
  parseQuery,
  serializeQuery,
  type QueryBounds,
} from '../../src/views/query.ts';

const BOUNDS: QueryBounds = { conditionsMax: 40, depthMax: 3, sortsMax: 5, valuesMax: 100 };
const ID = (prefix: string, n: number) => `${prefix}_${String(n).padStart(26, '0')}`;

/** A small deterministic PRNG so property runs are reproducible (seeded per case). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const REF: Record<string, string> = {
  brand: 'br',
  project: 'prj',
  member: 'mem',
  label: 'lbl',
  milestone: 'ms',
  status: 'sts',
  agent: 'agt',
};

/** A random valid condition for an entity (every filterable field and operator is reachable). */
function condition(r: () => number, entity: 'task' | 'project') {
  const fields = Object.entries(CATALOG[entity]).filter(([, s]) => s.filterable);
  const [field, spec] = pick(r, fields);
  const ops = OPERATORS[spec.kind].filter(
    (o) => !(spec.kind === 'multi' && (o === 'in' || o === 'not_in')),
  );
  const op = pick(r, ops);
  if (['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(op)) return { field, op };
  switch (spec.kind) {
    case 'enum':
      return { field, op, value: [pick(r, spec.values!)] };
    case 'ref':
    case 'multi':
      return { field, op, value: [ID(REF[spec.ref!]!, Math.floor(r() * 50))] };
    case 'date':
      return {
        field,
        op,
        value:
          op === 'between'
            ? ['2026-01-01', { rel: 'today', days: Math.floor(r() * 20) - 10 }]
            : '2026-02-03',
      };
    case 'number':
      return { field, op, value: op === 'between' ? ['1', 2.5] : String(Math.floor(r() * 99)) };
    default:
      return { field, op, value: 'needle' };
  }
}

function group(r: () => number, entity: 'task' | 'project', depth: number): unknown {
  const n = 1 + Math.floor(r() * 3);
  return {
    op: r() < 0.5 ? 'and' : 'or',
    items: Array.from({ length: n }, () =>
      depth < BOUNDS.depthMax && r() < 0.3 ? group(r, entity, depth + 1) : condition(r, entity),
    ),
  };
}

describe('saved-view query AST (ADR-0018 Q1)', () => {
  it('property: every generated valid query parses, and parsing is idempotent', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const entity = r() < 0.7 ? 'task' : 'project';
      const sortable = Object.entries(CATALOG[entity]).filter(([, s]) => s.sortable);
      const sort = Array.from({ length: Math.floor(r() * 4) }, () => pick(r, sortable)[0])
        .filter((f, i, a) => a.indexOf(f) === i)
        .map((field) => ({ field, dir: r() < 0.5 ? 'asc' : 'desc' }));
      const groupable = Object.entries(CATALOG[entity]).filter(([, s]) => s.groupable);
      const raw = {
        v: 1,
        entity,
        filter: group(r, entity, 1),
        sort,
        ...(r() < 0.5 ? { group: { field: pick(r, groupable)[0] } } : {}),
      };
      let q;
      try {
        q = parseQuery(raw, BOUNDS);
      } catch (e) {
        // Only the conditions bound may legitimately refuse a generated query.
        expect(
          (e as TenancyError).issues.map((i) => i.code),
          `seed ${seed}`,
        ).toEqual(['too_many']);
        continue;
      }
      expect(parseQuery(serializeQuery(q), BOUNDS), `seed ${seed}`).toEqual(q);
      expect(serializeQuery(parseQuery(serializeQuery(q), BOUNDS))).toEqual(serializeQuery(q));
    }
  });

  it('property: arbitrary input is refused only with validation_failed (never a crash)', () => {
    const junk = (r: () => number, d = 0): unknown => {
      const k = Math.floor(r() * 8);
      if (d > 4 || k === 0) return null;
      if (k === 1) return Math.floor(r() * 10) - 5;
      if (k === 2) return pick(r, ['and', 'or', 'in', 'brand', 'field:fld_x', '', 'é', 'me']);
      if (k === 3) return r() < 0.5;
      if (k === 4) return Array.from({ length: Math.floor(r() * 4) }, () => junk(r, d + 1));
      const o: Record<string, unknown> = {};
      for (const key of ['op', 'items', 'field', 'value', 'filter', 'sort', 'group', 'entity', 'v'])
        if (r() < 0.4) o[key] = junk(r, d + 1);
      return o;
    };
    for (let seed = 1; seed <= 2000; seed++) {
      const input = junk(rng(seed));
      try {
        parseQuery(input, BOUNDS, 'task');
      } catch (e) {
        expect(e, `seed ${seed}`).toBeInstanceOf(TenancyError);
        expect((e as TenancyError).code).toBe('validation_failed');
      }
    }
  });

  it('enforces the bounds and reports pointers', () => {
    const issues = (raw: unknown) => {
      try {
        parseQuery(raw, BOUNDS);
        return [];
      } catch (e) {
        return (e as TenancyError).issues.map((i) => `${i.pointer} ${i.code}`);
      }
    };
    let deep: unknown = { field: 'priority', op: 'is_empty' };
    for (let i = 0; i < 4; i++) deep = { op: 'and', items: [deep] };
    expect(issues({ entity: 'task', filter: deep })).toContain(
      '/query/filter/items/0/items/0/items/0 too_deep',
    );
    expect(
      issues({
        entity: 'task',
        filter: {
          op: 'and',
          items: [
            { field: 'brand', op: 'in', value: Array.from({ length: 101 }, (_, i) => ID('br', i)) },
          ],
        },
      }),
    ).toContain('/query/filter/items/0/value too_many');
    expect(
      issues({ entity: 'task', sort: Array.from({ length: 6 }, () => ({ field: 'title' })) }),
    ).toContain('/query/sort too_many');
    expect(issues({ entity: 'task', sort: [{ field: 'title' }, { field: 'title' }] })).toContain(
      '/query/sort/1/field duplicate',
    );
    expect(
      issues({
        entity: 'project',
        filter: { op: 'and', items: [{ field: 'assignee', op: 'is_empty' }] },
      }),
    ).toContain('/query/filter/items/0/field unsupported_field');
    expect(
      issues({
        entity: 'task',
        filter: { op: 'and', items: [{ field: 'rank', op: 'eq', value: '1' }] },
      }),
    ).toContain('/query/filter/items/0/field unsupported_field');
    expect(issues({ entity: 'task', v: 2 })).toContain('/query/v unsupported_version');
  });

  it('normalizes values: dates, relative dates, numbers, de-duplicated refs, trimmed text', () => {
    const q = parseQuery(
      {
        entity: 'task',
        filter: {
          op: 'and',
          items: [
            { field: 'due_date', op: 'between', value: ['2026-01-01', { rel: 'today', days: 7 }] },
            { field: 'estimate_minutes', op: 'gt', value: 30 },
            { field: 'brand', op: 'in', value: [ID('br', 1), ID('br', 1)] },
            { field: 'title', op: 'contains', value: '  launch  ' },
            { field: 'owner', op: 'in', value: ['me'] },
          ],
        },
      },
      BOUNDS,
    );
    expect(q.filter!.items).toEqual([
      { field: 'due_date', op: 'between', values: ['2026-01-01', { rel: 'today', days: 7 }] },
      { field: 'estimate_minutes', op: 'gt', values: ['30'] },
      { field: 'brand', op: 'in', values: [ID('br', 1)] },
      { field: 'title', op: 'contains', values: ['launch'] },
      { field: 'owner', op: 'in', values: ['me'] },
    ]);
  });

  it('presentation: defaults, order, density, and refusals', () => {
    expect(parsePresentation(undefined, 'task', 20)).toEqual({
      columns: DEFAULT_COLUMNS.task,
      density: 'comfortable',
    });
    expect(
      parsePresentation({ columns: ['due_date', 'title'], density: 'compact' }, 'task', 20),
    ).toEqual({
      columns: ['due_date', 'title'],
      density: 'compact',
    });
    const bad = (raw: unknown) => {
      try {
        parsePresentation(raw, 'task', 3);
        return null;
      } catch (e) {
        return (e as TenancyError).issues[0]!.code;
      }
    };
    expect(bad({ columns: ['title', 'title'] })).toBe('unsupported_field');
    expect(bad({ columns: ['title', 'rank'] })).toBe('unsupported_field');
    expect(bad({ columns: ['title', 'status', 'priority', 'brand'] })).toBe('too_many');
    expect(bad({ density: 'tiny' })).toBe('invalid');
    expect(bad({ columns: [] })).toBe('required');
  });
});
