import type { Attributes, Counter, Gauge, Histogram, Meter } from '@opentelemetry/api';
import { FORBIDDEN_METRIC_LABELS, TELEMETRY_SIGNALS } from '@pm/contracts';

type SignalType = 'counter' | 'histogram' | 'gauge';

interface SignalDefinition {
  readonly name: string;
  readonly type: SignalType;
  readonly labels: readonly string[];
}

/**
 * Foundation signals added in 1A for health and saturation. They follow the same label rules as
 * the registered 0D signals.
 */
export const FOUNDATION_SIGNALS = [
  { name: 'db.pool.connections', type: 'gauge', labels: ['identity', 'state'] },
  { name: 'db.health', type: 'gauge', labels: ['identity'] },
  { name: 'job.states', type: 'gauge', labels: ['queue', 'state'] },
  { name: 'job.attempt.duration', type: 'histogram', labels: ['queue', 'outcome'] },
  { name: 'job.retries', type: 'counter', labels: ['queue', 'error_class'] },
  { name: 'outbox.backlog', type: 'gauge', labels: [] },
  { name: 'outbox.dispatched', type: 'counter', labels: ['outcome'] },
  { name: 'worker.active_jobs', type: 'gauge', labels: [] },
  { name: 'worker.up', type: 'gauge', labels: ['role'] },
  { name: 'readiness.checks', type: 'counter', labels: ['check', 'outcome'] },
  { name: 'telemetry.label_rejected', type: 'counter', labels: [] },
  // Identity (1B): bounded flow/outcome vocabularies; never emails, accounts, sessions, or IPs.
  { name: 'identity.flow.outcomes', type: 'counter', labels: ['flow', 'outcome'] },
  { name: 'identity.flow.duration', type: 'histogram', labels: ['flow', 'outcome'] },
  { name: 'identity.rate_limited', type: 'counter', labels: ['policy'] },
  { name: 'identity.sessions', type: 'gauge', labels: ['state'] },
  { name: 'identity.cleanup.deleted', type: 'counter', labels: ['kind'] },
  { name: 'mail.enqueued', type: 'counter', labels: ['template'] },
  { name: 'mail.deliveries', type: 'counter', labels: ['template', 'outcome'] },
  // Audit and lifecycle (1F): bounded module/kind/outcome vocabularies only. Never tenant, actor,
  // record, target, email, IP, action, or content values.
  { name: 'audit.writes', type: 'counter', labels: ['module'] },
  { name: 'audit.write.duration', type: 'histogram', labels: ['module', 'outcome'] },
  { name: 'audit.chain.lock_wait', type: 'histogram', labels: ['module'] },
  { name: 'audit.chain.lock_wait_exceeded', type: 'counter', labels: ['module'] },
  { name: 'audit.chain.verifications', type: 'counter', labels: ['outcome'] },
  { name: 'audit.chain.problems', type: 'counter', labels: ['kind'] },
  { name: 'audit.redactions', type: 'counter', labels: ['reason'] },
  { name: 'security_events.written', type: 'counter', labels: ['category', 'scope'] },
  { name: 'security_events.write_failures', type: 'counter', labels: ['scope'] },
  { name: 'security_events.buffer_drained', type: 'counter', labels: [] },
  { name: 'security_events.buffer_remaining', type: 'gauge', labels: [] },
  { name: 'security_events.buffer_verifications', type: 'counter', labels: ['outcome'] },
  { name: 'lifecycle.transitions', type: 'counter', labels: ['transition', 'outcome'] },
  { name: 'purge.backlog', type: 'gauge', labels: ['state'] },
  { name: 'purge.blocked', type: 'counter', labels: ['reason'] },
  { name: 'purge.hook.duration', type: 'histogram', labels: ['hook', 'outcome'] },
  { name: 'purge.hook.failures', type: 'counter', labels: ['hook'] },
  { name: 'purge.ledger.acknowledgements', type: 'counter', labels: ['outcome'] },
  { name: 'retention.scheduler.runs', type: 'counter', labels: ['policy', 'outcome'] },
] as const satisfies readonly SignalDefinition[];

export const ALL_SIGNALS: readonly SignalDefinition[] = [
  ...TELEMETRY_SIGNALS,
  ...FOUNDATION_SIGNALS,
];
export type SignalName =
  (typeof TELEMETRY_SIGNALS)[number]['name'] | (typeof FOUNDATION_SIGNALS)[number]['name'];

const FORBIDDEN: ReadonlySet<string> = new Set(FORBIDDEN_METRIC_LABELS);
const BY_NAME: ReadonlyMap<string, SignalDefinition> = new Map(ALL_SIGNALS.map((s) => [s.name, s]));

/** Values that look like identifiers or personal data are high-cardinality by definition. */
const HIGH_CARDINALITY_VALUE = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // UUID
  /\b[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}\b/, // public ID
  /@/, // email-like
  /\b\d{1,3}(\.\d{1,3}){3}\b/, // IPv4
  /^https?:/i, // URL
  /[0-9a-f]{24,}/i, // long hex (trace IDs, hashes)
];
const SAFE_VALUE = /^[A-Za-z0-9_./:{}-]{1,64}$/;

export class MetricLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricLabelError';
  }
}

export type Labels = Readonly<Record<string, string | number | boolean>>;

export interface MetricsOptions {
  meter: Meter;
  /** Throw on label violations (local/test). Otherwise drop the sample and count the rejection. */
  strict: boolean;
}

export function validateLabels(signal: SignalDefinition, labels: Labels): string | undefined {
  for (const [key, value] of Object.entries(labels)) {
    if (FORBIDDEN.has(key)) return `label ${key} is forbidden (0D §17.3)`;
    if (!signal.labels.includes(key)) return `label ${key} is not declared for ${signal.name}`;
    if (typeof value === 'string') {
      if (!SAFE_VALUE.test(value)) return `label ${key} has an unbounded value`;
      if (HIGH_CARDINALITY_VALUE.some((p) => p.test(value))) {
        return `label ${key} carries an identifier-like value`;
      }
    }
  }
  return undefined;
}

/** Metric facade: only declared signals, only declared labels, only bounded values. */
export class Metrics {
  readonly #meter: Meter;
  readonly #strict: boolean;
  readonly #instruments = new Map<string, Counter | Histogram | Gauge>();
  #rejected = 0;

  constructor(options: MetricsOptions) {
    this.#meter = options.meter;
    this.#strict = options.strict;
  }

  get rejectedSamples(): number {
    return this.#rejected;
  }

  count(name: SignalName, value = 1, labels: Labels = {}): void {
    const inst = this.#instrument(name, 'counter', labels);
    (inst as Counter | undefined)?.add(value, labels as Attributes);
  }

  record(name: SignalName, value: number, labels: Labels = {}): void {
    const inst = this.#instrument(name, 'histogram', labels);
    (inst as Histogram | undefined)?.record(value, labels as Attributes);
  }

  gauge(name: SignalName, value: number, labels: Labels = {}): void {
    const inst = this.#instrument(name, 'gauge', labels);
    (inst as Gauge | undefined)?.record(value, labels as Attributes);
  }

  #instrument(
    name: string,
    type: SignalType,
    labels: Labels,
  ): Counter | Histogram | Gauge | undefined {
    const signal = BY_NAME.get(name);
    let problem: string | undefined;
    if (!signal) problem = `signal ${name} is not registered`;
    else if (signal.type !== type) problem = `signal ${name} is a ${signal.type}, not a ${type}`;
    else problem = validateLabels(signal, labels);
    if (problem) {
      if (this.#strict) throw new MetricLabelError(problem);
      this.#rejected++;
      if (name !== 'telemetry.label_rejected') this.count('telemetry.label_rejected');
      return undefined;
    }
    let inst = this.#instruments.get(name);
    if (!inst) {
      inst =
        type === 'counter'
          ? this.#meter.createCounter(name)
          : type === 'histogram'
            ? this.#meter.createHistogram(name, { unit: name.endsWith('duration') ? 'ms' : '1' })
            : this.#meter.createGauge(name);
      this.#instruments.set(name, inst);
    }
    return inst;
  }
}
