import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  currentVersion,
  definitionDigest,
  findDefinition,
  METRIC_DEFINITIONS,
  METRIC_IDS,
} from '../../src/metrics/definitions.ts';
import {
  addCounts,
  ageBand,
  canonicalJson,
  completionCounts,
  completionFigure,
  digestOf,
  distribution,
  eachDay,
  freshnessState,
  percentile,
  percentOf,
  resolveWindow,
  stateOf,
  worstFreshness,
  type LeafTask,
} from '../../src/metrics/semantics.ts';

/** A small seeded generator, so the property checks are random-looking and exactly repeatable. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CATS = ['planned', 'active', 'paused', 'done', 'cancelled'] as const;
function tasks(r: () => number, n: number): LeafTask[] {
  return Array.from({ length: n }, () => ({
    category: CATS[Math.floor(r() * CATS.length)]!,
    estimateMinutes: r() < 0.3 ? null : r() < 0.1 ? 0 : 1 + Math.floor(r() * 480),
  }));
}

describe('metric definitions (5C)', () => {
  it('are unique, complete, and immutable once released: the pinned digest of each must not change', () => {
    const pinned = JSON.parse(
      readFileSync(new URL('./metric-definition-digests.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;
    const seen = new Set<string>();
    for (const d of METRIC_DEFINITIONS) {
      const key = `${d.id}@${d.version}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
      // Changing what a number means is a new version, not an edit: add `${id}@${version + 1}` and
      // pin it; never re-pin an existing key.
      expect(pinned[key], `${key} is not pinned`).toBeDefined();
      expect(definitionDigest(d), `${key} changed after release`).toBe(pinned[key]);
    }
    expect(Object.keys(pinned).sort()).toEqual([...seen].sort());
    for (const id of METRIC_IDS)
      expect(
        METRIC_DEFINITIONS.some((d) => d.id === id),
        id,
      ).toBe(true);
  });

  it('state scope, numerator, rollup, timezone, freshness, authorization, drill path, and what they do not claim', () => {
    for (const d of METRIC_DEFINITIONS) {
      expect(d.scopes.length, d.id).toBeGreaterThan(0);
      expect(d.numerator.length, d.id).toBeGreaterThan(0);
      expect(d.rollup.note.length, d.id).toBeGreaterThan(0);
      expect(['workspace', 'none']).toContain(d.timezone);
      expect(['live', 'ledger', 'mixed']).toContain(d.freshness);
      expect(d.authorization).toMatch(/can read/);
      expect(d.doesNotClaim.length, d.id).toBeGreaterThan(20);
      expect(new Set(d.drill.map((x) => x.role)).size, `${d.id} drill roles`).toBe(d.drill.length);
      expect(new Set(d.incomplete.map((x) => x.code)).size, `${d.id} codes`).toBe(
        d.incomplete.length,
      );
      // A windowed metric is read in the workspace zone; a snapshot of a ledger metric needs history.
      if (d.window === 'window') expect(d.timezone, d.id).toBe('workspace');
      if (d.availability.state === 'source_unavailable') {
        expect(d.drill, d.id).toEqual([]);
        expect(
          d.incomplete.map((x) => x.code),
          d.id,
        ).toContain('source_not_available');
      } else if (d.id !== 'data.freshness') expect(d.drill.length, d.id).toBeGreaterThan(0);
    }
  });

  it('resolve the current version, keep earlier versions computable, and never invent a business outcome', () => {
    expect(currentVersion('project.completion')).toBe(1);
    expect(currentVersion('project.health')).toBe(1);
    expect(findDefinition('project.completion', 2)?.name).toMatch(/weighted/);
    expect(findDefinition('project.completion')?.version).toBe(1);
    expect(findDefinition('project.completion', 3)).toBeUndefined();
    expect(findDefinition('nope')).toBeUndefined();
    for (const d of METRIC_DEFINITIONS)
      expect(d.doesNotClaim).toMatch(/\b(not|never|no figure)\b/i);
  });
});

describe('ratios and completion (5C)', () => {
  it('rounds half up in whole percent and never fabricates a percentage from nothing', () => {
    expect(percentOf(1, 2)).toBe(50);
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(1, 8)).toBe(13);
    expect(percentOf(0, 5)).toBe(0);
    expect(percentOf(5, 0)).toBeNull();
    expect(percentOf(0, 0)).toBeNull();
    expect(percentOf(-1, 3)).toBe(-33);
  });

  it('property: counts of a partition add up to the counts of the whole, in any order (ratio of sums)', () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const all = tasks(r, 1 + Math.floor(r() * 60));
      const cut = Math.floor(r() * (all.length + 1));
      const a = completionCounts(all.slice(0, cut));
      const b = completionCounts(all.slice(cut));
      const whole = completionCounts(all);
      expect(addCounts(a, b)).toEqual(whole);
      expect(completionCounts([...all].reverse())).toEqual(whole);
      for (const v of [1, 2] as const) {
        const f = completionFigure(whole, v);
        if (f.percent !== null) {
          expect(f.percent).toBeGreaterThanOrEqual(0);
          expect(f.percent).toBeLessThanOrEqual(100);
          expect(f.numerator).toBeLessThanOrEqual(f.denominator);
        }
      }
    }
  });

  it('property: version 1 is the done share of the counted tasks, version 2 the done share of the estimate', () => {
    const r = rng(11);
    for (let i = 0; i < 200; i++) {
      const all = tasks(r, 1 + Math.floor(r() * 40));
      const counted = all.filter((t) => t.category !== 'cancelled');
      const done = counted.filter((t) => t.category === 'done');
      const c = completionCounts(all);
      const v1 = completionFigure(c, 1);
      if (!counted.length) expect(v1.state).toBe('empty');
      else expect(v1.percent).toBe(Math.floor((done.length * 100) / counted.length + 0.5));
      const w = (t: LeafTask) =>
        t.estimateMinutes && t.estimateMinutes > 0 ? t.estimateMinutes : 0;
      const wt = counted.reduce((a, t) => a + w(t), 0);
      const wd = done.reduce((a, t) => a + w(t), 0);
      const v2 = completionFigure(c, 2);
      if (!counted.length) expect(v2.state).toBe('empty');
      else if (wt === 0)
        expect(v2.incomplete).toEqual([{ code: 'no_estimates', count: counted.length }]);
      else {
        expect(v2.numerator).toBe(wd);
        expect(v2.denominator).toBe(wt);
        const un = counted.filter((t) => w(t) === 0).length;
        expect(v2.state).toBe(un ? 'partial' : 'complete');
        if (un) expect(v2.incomplete).toEqual([{ code: 'unestimated_tasks', count: un }]);
      }
    }
  });

  it('weights a large task more than a small one, and is not an average of percentages', () => {
    const big: LeafTask[] = [
      { category: 'done', estimateMinutes: 900 },
      { category: 'planned', estimateMinutes: 100 },
    ];
    const small: LeafTask[] = [
      { category: 'planned', estimateMinutes: 10 },
      { category: 'planned', estimateMinutes: 10 },
    ];
    const sum = addCounts(completionCounts(big), completionCounts(small));
    expect(completionFigure(sum, 2).percent).toBe(Math.floor((900 * 100) / 1020 + 0.5));
    const avg =
      (completionFigure(completionCounts(big), 2).percent! +
        completionFigure(completionCounts(small), 2).percent!) /
      2;
    expect(completionFigure(sum, 2).percent).not.toBe(avg);
    // Cancelled work and work without an estimate carry no weight.
    const c = completionCounts([
      { category: 'cancelled', estimateMinutes: 999 },
      { category: 'done', estimateMinutes: null },
    ]);
    expect(c).toMatchObject({ total: 1, done: 1, weightTotal: 0, unestimated: 1 });
    expect(completionFigure(c, 1).percent).toBe(100);
    expect(completionFigure(c, 2).state).toBe('empty');
  });
});

describe('distributions, bands, windows, and digests (5C)', () => {
  it('property: percentiles are monotone, bounded by the data, and independent of order', () => {
    const r = rng(3);
    for (let i = 0; i < 200; i++) {
      const v = Array.from({ length: 1 + Math.floor(r() * 30) }, () => Math.floor(r() * 1000));
      const p = [0, 0.25, 0.5, 0.85, 1].map((q) => percentile(v, q)!);
      for (let k = 1; k < p.length; k++) expect(p[k]).toBeGreaterThanOrEqual(p[k - 1]!);
      expect(p[0]).toBe(Math.min(...v));
      expect(p.at(-1)).toBe(Math.max(...v));
      expect(percentile([...v].reverse(), 0.5)).toBe(percentile(v, 0.5));
    }
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.85)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(distribution([86400, 86400, 172800, 172800, 172800])).toMatchObject({
      n: 5,
      median: 172800,
      p85: 172800,
      mean: 138240,
      min: 86400,
      max: 172800,
    });
    expect(distribution([])).toEqual({
      n: 0,
      median: null,
      p85: null,
      mean: null,
      min: null,
      max: null,
    });
  });

  it('puts an age in the band of its whole days, with every boundary in one band only', () => {
    expect([0, 7, 8, 14, 15, 30, 31, 60, 61, 4000].map(ageBand)).toEqual([
      'band_0_7',
      'band_0_7',
      'band_8_14',
      'band_8_14',
      'band_15_30',
      'band_15_30',
      'band_31_60',
      'band_31_60',
      'band_61_plus',
      'band_61_plus',
    ]);
    expect(ageBand(7.9)).toBe('band_0_7');
    expect(ageBand(-3)).toBe('band_0_7');
  });

  it('resolves a window of local days: defaults, derived ends, and bounds', () => {
    const w = (i: object) => resolveWindow(i, '2026-03-31', 30, 366);
    expect(w({})).toEqual({ ok: true, window: { from: '2026-03-02', to: '2026-03-31', days: 30 } });
    expect(w({ from: '2026-03-01' })).toEqual({
      ok: true,
      window: { from: '2026-03-01', to: '2026-03-30', days: 30 },
    });
    expect(w({ to: '2026-03-31' })).toMatchObject({ ok: true, window: { from: '2026-03-02' } });
    expect(w({ from: '2026-03-10', to: '2026-03-10' })).toMatchObject({
      ok: true,
      window: { days: 1 },
    });
    expect(w({ from: '2026-02-30' })).toEqual({
      ok: false,
      issue: 'invalid_date',
      pointer: '/from',
    });
    expect(w({ from: '2026-03-05', to: '2026-03-01' })).toEqual({
      ok: false,
      issue: 'order',
      pointer: '/from',
    });
    expect(w({ from: '2020-01-01', to: '2026-03-01' })).toEqual({
      ok: false,
      issue: 'too_long',
      pointer: '/to',
    });
    expect(w({ from: '2024-02-28', to: '2024-03-01' })).toMatchObject({
      ok: true,
      window: { days: 3 },
    });
    expect(eachDay({ from: '2026-03-28', to: '2026-03-30', days: 3 })).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
    ]);
    // The length counts calendar days, so the day the clocks change is still one day.
    expect(eachDay({ from: '2026-03-28', to: '2026-03-31', days: 4 }).length).toBe(4);
  });

  it('derives freshness from pending and failed work, the worst source decides, and empty means empty', () => {
    expect(freshnessState(0, 0)).toBe('current');
    expect(freshnessState(3, 0)).toBe('catching_up');
    expect(freshnessState(0, 1)).toBe('degraded');
    expect(freshnessState(0, 0, true)).toBe('degraded');
    expect(worstFreshness([])).toBe('current');
    expect(worstFreshness(['current', 'catching_up'])).toBe('catching_up');
    expect(worstFreshness(['catching_up', 'degraded', 'current'])).toBe('degraded');
    expect(stateOf({ empty: true, incomplete: [{ code: 'x' }] })).toBe('empty');
    expect(stateOf({ empty: false, incomplete: [{ code: 'x' }] })).toBe('partial');
    expect(stateOf({ empty: false, incomplete: [] })).toBe('complete');
    expect(stateOf({ empty: false, incomplete: [], estimated: true })).toBe('estimated');
  });

  it('hashes equal figures equally however their keys were ordered, and different figures differently', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
    expect(digestOf({ a: undefined, b: 1 })).toBe(digestOf({ b: 1 }));
    expect(digestOf({ a: null })).not.toBe(digestOf({}));
  });
});
