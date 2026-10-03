import {
  context,
  metrics as metricsApi,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  MetricReader,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  NodeTracerProvider,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { Metrics } from './metrics.ts';

/** Metric reader collected on demand (tests and in-process evidence). */
export class CollectingMetricReader extends MetricReader {
  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }

  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  otlpEndpoint?: string | undefined;
  traceSampleRatio: number;
  /** Throw on metric label violations (local/test). */
  strictMetrics: boolean;
  /** Capture spans and metrics in memory instead of exporting (tests). */
  inMemory?: boolean;
}

export interface Telemetry {
  readonly tracer: Tracer;
  readonly metrics: Metrics;
  /** Present only when `inMemory` is set. */
  readonly spans: InMemorySpanExporter | undefined;
  readonly metricReader: CollectingMetricReader | undefined;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const propagator = new W3CTraceContextPropagator();

/**
 * Initializes W3C-trace-context tracing and metrics (0D §17.2-17.3). Exports over OTLP only when
 * an endpoint is configured; no vendor SDK is bound into application code.
 */
export function initTelemetry(options: TelemetryOptions): Telemetry {
  const resource = resourceFromAttributes({
    'service.name': options.serviceName,
    'service.version': options.serviceVersion,
    'deployment.environment.name': options.environment,
  });

  const spanProcessors: SpanProcessor[] = [];
  let spans: InMemorySpanExporter | undefined;
  if (options.inMemory) {
    spans = new InMemorySpanExporter();
    spanProcessors.push(new SimpleSpanProcessor(spans));
  } else if (options.otlpEndpoint) {
    spanProcessors.push(
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${options.otlpEndpoint}/v1/traces` })),
    );
  }
  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(options.traceSampleRatio),
    }),
    spanProcessors,
  });
  tracerProvider.register({ propagator });

  let metricReader: CollectingMetricReader | undefined;
  const readers: MetricReader[] = [];
  if (options.inMemory) {
    metricReader = new CollectingMetricReader();
    readers.push(metricReader);
  } else if (options.otlpEndpoint) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${options.otlpEndpoint}/v1/metrics` }),
        exportIntervalMillis: 15_000,
      }),
    );
  }
  const meterProvider = new MeterProvider({ resource, readers });
  metricsApi.setGlobalMeterProvider(meterProvider);

  const metrics = new Metrics({
    meter: meterProvider.getMeter('pm'),
    strict: options.strictMetrics,
  });

  return {
    tracer: tracerProvider.getTracer('pm'),
    metrics,
    spans,
    metricReader,
    async flush() {
      await Promise.allSettled([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
    },
    async shutdown() {
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
      trace.disable();
      metricsApi.disable();
      propagation.disable();
    },
  };
}

/** Extracts a remote parent from a stored or incoming `traceparent` (W3C). */
export function contextFromTraceparent(traceparent: string | undefined | null): Context {
  if (!traceparent) return ROOT_CONTEXT;
  return propagator.extract(
    ROOT_CONTEXT,
    { traceparent },
    {
      get: (carrier, key) => (carrier as Record<string, string>)[key],
      keys: (carrier) => Object.keys(carrier),
    },
  );
}

/** Serializes the active span as a `traceparent` for persistence in jobs and outbox rows. */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagator.inject(context.active(), carrier, {
    set: (c, k, v) => {
      (c as Record<string, string>)[k] = v;
    },
  });
  return carrier.traceparent;
}

/**
 * Runs `fn` inside a span. Attributes must be bounded, content-free values; the error recorded on
 * failure is the class only (never the message).
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
  options: { parent?: Context; kind?: SpanKind } = {},
): Promise<T> {
  const parent = options.parent ?? context.active();
  return tracer.startActiveSpan(
    name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes },
    parent,
    async (span) => {
      try {
        const result = await fn(span);
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute('error.type', err instanceof Error ? err.name : 'unknown');
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

export { SpanKind, SpanStatusCode, context, trace };
export type { Span, Tracer, Context };
