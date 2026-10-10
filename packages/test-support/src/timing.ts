import type { Telemetry } from '@pm/observability';

type SpanExporter = NonNullable<Telemetry['spans']>;

/**
 * Timing-uniformity harness (the 1B identity "one timing class" check, generalized for 2C hidden
 * fields, corrective review 01). Two kinds of evidence:
 *
 * 1. **Statement shape** (deterministic): the ordered list of database operations a request runs,
 *    taken from the in-memory spans the instrumented pool emits (operation keyword and pool
 *    identity only, never SQL text or values). Equal shapes mean the authorization path does the
 *    same database work whether data is visible, hidden, or absent.
 * 2. **Response time** (statistical): classes are sampled interleaved in a fixed rotation after a
 *    warm-up, and their medians compared. The accepted threshold is the larger of an absolute floor
 *    and a fraction of the smaller median ({@link TIMING_DEFAULTS}), which absorbs scheduler and
 *    container noise on CI while still catching a skipped query (each round trip costs well above
 *    the floor on a loopback database) or extra per-field work.
 */

export const TIMING_DEFAULTS = {
  /** Interleaved rounds per class after warm-up. */
  rounds: 31,
  warmup: 5,
  /** Accept |Δ median| ≤ max(absMs, rel × smaller median). */
  absMs: 4,
  rel: 0.35,
} as const;

export type TimingClasses = Record<string, () => Promise<unknown>>;

export interface TimingResult {
  medians: Record<string, number>;
  maxDelta: number;
  threshold: number;
  ok: boolean;
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Samples every class interleaved (rotating start, so no class always runs first). */
export async function measureClasses(
  classes: TimingClasses,
  options: Partial<typeof TIMING_DEFAULTS> = {},
): Promise<TimingResult> {
  const o = { ...TIMING_DEFAULTS, ...options };
  const names = Object.keys(classes);
  const samples: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
  const settle = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      // Refusals are part of the class being measured (not_found, forbidden).
    }
  };
  for (let round = 0; round < o.warmup + o.rounds; round++) {
    for (let i = 0; i < names.length; i++) {
      const name = names[(i + round) % names.length]!;
      const started = performance.now();
      await settle(classes[name]!);
      if (round >= o.warmup) samples[name]!.push(performance.now() - started);
    }
  }
  const medians = Object.fromEntries(names.map((n) => [n, median(samples[n]!)]));
  const values = Object.values(medians);
  const maxDelta = Math.max(...values) - Math.min(...values);
  const threshold = Math.max(o.absMs, o.rel * Math.min(...values));
  return { medians, maxDelta, threshold, ok: maxDelta <= threshold };
}

/**
 * The database operations a call runs, in order (`<identity>:<OPERATION>`), from the pool spans.
 * The exporter is reset first; calls must not overlap.
 */
export async function statementShape(
  spans: SpanExporter,
  fn: () => Promise<unknown>,
): Promise<string[]> {
  spans.reset();
  try {
    await fn();
  } catch {
    // The shape of a refusal is what is being compared.
  }
  return spans
    .getFinishedSpans()
    .filter((s) => s.name.startsWith('db.'))
    .map((s) => {
      const op = String(s.attributes['db.operation.name'] ?? s.name);
      // A transaction ends in one round trip either way: COMMIT for an answer, ROLLBACK for a
      // refusal. The ending is reported as END so a not_found is compared with the work before it.
      return `${String(s.attributes['pm.db.identity'] ?? '')}:${op === 'COMMIT' || op === 'ROLLBACK' ? 'END' : op}`;
    });
}
