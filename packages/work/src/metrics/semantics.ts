import { createHash } from 'node:crypto';
import { addDays, daysBetween, localDay, validDay, validZone } from '../time/semantics.ts';

/**
 * Phase 5C metric rules (ADR-0030), pure and deterministic. Everything here is a function of its
 * inputs, so any figure can be reproduced and explained. The inputs a caller passes are only the
 * records the viewer may read; nothing here sees, counts, or labels anything else.
 */

export const METRIC_STATES = ['complete', 'partial', 'estimated', 'empty', 'unavailable'] as const;
export type MetricState = (typeof METRIC_STATES)[number];

export interface Incomplete {
  code: string;
  message: string;
  count: number | null;
}

// ---------------------------------------------------------------------------------------------
// Ratios and percentages
// ---------------------------------------------------------------------------------------------

/** Whole percent, half up; null when there is nothing to divide by (never a made-up 0 or 100). */
export function percentOf(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return Math.floor((numerator * 100) / denominator + 0.5);
}

export interface CompletionCounts {
  /** Counted tasks (not cancelled) and the done ones among them. */
  total: number;
  done: number;
  /** Estimate minutes of counted tasks with an estimate, and of the done ones among them. */
  weightTotal: number;
  weightDone: number;
  /** Counted tasks with no estimate (they carry no weight). */
  unestimated: number;
}

export interface LeafTask {
  category: 'planned' | 'active' | 'paused' | 'done' | 'cancelled';
  estimateMinutes: number | null;
}

/** Counts the figures of both completion versions from leaf tasks (the SQL aggregates the same). */
export function completionCounts(tasks: readonly LeafTask[]): CompletionCounts {
  const out: CompletionCounts = {
    total: 0,
    done: 0,
    weightTotal: 0,
    weightDone: 0,
    unestimated: 0,
  };
  for (const t of tasks) {
    if (t.category === 'cancelled') continue;
    out.total++;
    const w = t.estimateMinutes !== null && t.estimateMinutes > 0 ? t.estimateMinutes : 0;
    if (t.category === 'done') out.done++;
    if (w > 0) {
      out.weightTotal += w;
      if (t.category === 'done') out.weightDone += w;
    } else out.unestimated++;
  }
  return out;
}

export function addCounts(a: CompletionCounts, b: CompletionCounts): CompletionCounts {
  return {
    total: a.total + b.total,
    done: a.done + b.done,
    weightTotal: a.weightTotal + b.weightTotal,
    weightDone: a.weightDone + b.weightDone,
    unestimated: a.unestimated + b.unestimated,
  };
}

export interface CompletionFigure {
  percent: number | null;
  numerator: number;
  denominator: number;
  state: MetricState;
  incomplete: Array<Pick<Incomplete, 'code' | 'count'>>;
}

/** The completion figure of a version (1: by count, 2: weighted by estimate). */
export function completionFigure(c: CompletionCounts, version: 1 | 2): CompletionFigure {
  if (c.total === 0)
    return {
      percent: null,
      numerator: 0,
      denominator: 0,
      state: 'empty',
      incomplete: [{ code: 'no_tasks', count: null }],
    };
  if (version === 1)
    return {
      percent: percentOf(c.done, c.total),
      numerator: c.done,
      denominator: c.total,
      state: 'complete',
      incomplete: [],
    };
  if (c.weightTotal === 0)
    return {
      percent: null,
      numerator: 0,
      denominator: 0,
      state: 'empty',
      incomplete: [{ code: 'no_estimates', count: c.unestimated }],
    };
  return {
    percent: percentOf(c.weightDone, c.weightTotal),
    numerator: c.weightDone,
    denominator: c.weightTotal,
    state: c.unestimated > 0 ? 'partial' : 'complete',
    incomplete: c.unestimated > 0 ? [{ code: 'unestimated_tasks', count: c.unestimated }] : [],
  };
}

// ---------------------------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------------------------

/** Linear-interpolation percentile (the continuous definition) of numbers; null when empty. */
export function percentile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const v = s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
  return Math.round(v * 1000) / 1000;
}

export interface Distribution {
  n: number;
  median: number | null;
  p85: number | null;
  mean: number | null;
  min: number | null;
  max: number | null;
}

export function distribution(values: readonly number[]): Distribution {
  if (!values.length) return { n: 0, median: null, p85: null, mean: null, min: null, max: null };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    median: percentile(values, 0.5),
    p85: percentile(values, 0.85),
    mean: Math.round((sum / values.length) * 1000) / 1000,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export const AGE_BANDS = [
  { role: 'band_0_7', label: '0 to 7 days', from: 0, to: 7 },
  { role: 'band_8_14', label: '8 to 14 days', from: 8, to: 14 },
  { role: 'band_15_30', label: '15 to 30 days', from: 15, to: 30 },
  { role: 'band_31_60', label: '31 to 60 days', from: 31, to: 60 },
  { role: 'band_61_plus', label: 'Over 60 days', from: 61, to: null },
] as const;

/** The band of an age in whole 24-hour periods (a negative age, from clock skew, is band 0). */
export function ageBand(ageDays: number): (typeof AGE_BANDS)[number]['role'] {
  const d = Math.max(Math.floor(ageDays), 0);
  return (AGE_BANDS.find((b) => d >= b.from && (b.to === null || d <= b.to)) ?? AGE_BANDS[4]).role;
}

// ---------------------------------------------------------------------------------------------
// Windows and time zones
// ---------------------------------------------------------------------------------------------

export interface WindowInput {
  from?: unknown;
  to?: unknown;
}

export type WindowIssue = 'invalid_date' | 'order' | 'too_long';

export interface LocalWindow {
  /** Inclusive local dates in the workspace zone. */
  from: string;
  to: string;
  days: number;
}

/**
 * A window of local calendar days in the workspace zone. With neither bound it is the last
 * `defaultDays` days ending today; with one bound the other is derived; the length is bounded.
 */
export function resolveWindow(
  input: WindowInput,
  today: string,
  defaultDays: number,
  maxDays: number,
): { ok: true; window: LocalWindow } | { ok: false; issue: WindowIssue; pointer: string } {
  const has = (v: unknown) => v !== undefined && v !== null && v !== '';
  let from = has(input.from) ? validDay(input.from) : null;
  let to = has(input.to) ? validDay(input.to) : null;
  if (has(input.from) && !from) return { ok: false, issue: 'invalid_date', pointer: '/from' };
  if (has(input.to) && !to) return { ok: false, issue: 'invalid_date', pointer: '/to' };
  if (!from && !to) {
    to = today;
    from = addDays(today, -(defaultDays - 1));
  } else if (!to) to = addDays(from!, defaultDays - 1);
  else if (!from) from = addDays(to, -(defaultDays - 1));
  if (from! > to!) return { ok: false, issue: 'order', pointer: '/from' };
  const days = daysBetween(from!, to!) + 1;
  if (days > maxDays) return { ok: false, issue: 'too_long', pointer: '/to' };
  return { ok: true, window: { from: from!, to: to!, days } };
}

/** Every local day of a window, in order. */
export function eachDay(w: LocalWindow): string[] {
  return Array.from({ length: w.days }, (_, i) => addDays(w.from, i));
}

export { localDay, validDay, validZone, addDays, daysBetween };

// ---------------------------------------------------------------------------------------------
// States and reproducibility
// ---------------------------------------------------------------------------------------------

/** The state of a result: unavailable is decided by the source; otherwise empty, partial, or complete. */
export function stateOf(args: {
  empty: boolean;
  incomplete: ReadonlyArray<{ code: string }>;
  estimated?: boolean;
}): MetricState {
  if (args.empty) return 'empty';
  if (args.estimated) return 'estimated';
  return args.incomplete.length ? 'partial' : 'complete';
}

export type FreshnessState = 'current' | 'catching_up' | 'degraded';

/** Pending work means catching up; a failed item or a failing job means degraded. */
export function freshnessState(pending: number, failed: number, failing = false): FreshnessState {
  if (failed > 0 || failing) return 'degraded';
  return pending > 0 ? 'catching_up' : 'current';
}

const SEVERITY: Record<FreshnessState, number> = { current: 0, catching_up: 1, degraded: 2 };
export function worstFreshness(states: readonly FreshnessState[]): FreshnessState {
  return states.reduce<FreshnessState>((w, s) => (SEVERITY[s] > SEVERITY[w] ? s : w), 'current');
}

/** Canonical JSON (sorted keys), so equal figures hash equal however they were built. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export function digestOf(v: unknown): string {
  return createHash('sha256').update(canonicalJson(v)).digest('hex');
}

/** Whether `asOf` is the present (within a minute), so the live state is used rather than history. */
export function isLive(asOf: Date, now: Date): boolean {
  return Math.abs(now.getTime() - asOf.getTime()) < 60_000;
}
