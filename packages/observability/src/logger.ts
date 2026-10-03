import { trace } from '@opentelemetry/api';
import { redactString, truncate } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Allow-listed structured fields (0D §17.1). Anything else is dropped before serialization, so
 * customer content, request/response bodies, SQL parameters, headers, and URLs cannot reach logs
 * through a stray property.
 */
const STRING_FIELDS = [
  'request_id',
  'correlation_id',
  'trace_id',
  'span_id',
  'operation_id',
  'attempt_id',
  'job_id',
  'event_id',
  'event_type',
  'workspace_id',
  'principal_type',
  'principal_id',
  'route',
  'method',
  'status_class',
  'action_key',
  'error_code',
  'error_class',
  'error_stack',
  'outcome',
  'job_kind',
  'queue',
  'consumer',
  'component',
  'service',
  'env',
  'build_id',
  'check',
  'state',
  'identity',
  'worker_id',
  'migration_name',
  'reason',
  'signal',
  'effect_state',
  'destination_class',
  'operation_kind',
] as const;
const NUMBER_FIELDS = [
  'status',
  'duration_ms',
  'attempt_number',
  'count',
  'delay_ms',
  'migration_version',
  'port',
  'lag_ms',
] as const;
const BOOLEAN_FIELDS = ['retryable', 'worker_lost', 'ready'] as const;

type StringField = (typeof STRING_FIELDS)[number];
type NumberField = (typeof NUMBER_FIELDS)[number];
type BooleanField = (typeof BOOLEAN_FIELDS)[number];

export type LogFields = Partial<Record<StringField, string>> &
  Partial<Record<NumberField, number>> &
  Partial<Record<BooleanField, boolean>>;

const STRING_SET: ReadonlySet<string> = new Set(STRING_FIELDS);
const NUMBER_SET: ReadonlySet<string> = new Set(NUMBER_FIELDS);
const BOOLEAN_SET: ReadonlySet<string> = new Set(BOOLEAN_FIELDS);
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

export interface LogSink {
  write(line: string): void;
}

export const stdoutSink: LogSink = {
  write(line) {
    process.stdout.write(`${line}\n`);
  },
};

/** Captures records in memory (tests and redaction evidence). */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  records(): Array<Record<string, unknown>> {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  clear(): void {
    this.lines.length = 0;
  }
}

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  sink?: LogSink;
  base?: LogFields;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  /** Number of fields dropped by the allow-list since creation (shared with children). */
  readonly droppedFields: number;
}

export function sanitizeFields(
  fields: Record<string, unknown>,
  counter: { dropped: number },
): LogFields {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (STRING_SET.has(key) && typeof value === 'string') {
      out[key] = truncate(redactString(value), key === 'error_stack' ? 2000 : 200);
    } else if (NUMBER_SET.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (BOOLEAN_SET.has(key) && typeof value === 'boolean') {
      out[key] = value;
    } else {
      counter.dropped++;
    }
  }
  return out as LogFields;
}

export function createLogger(options: LoggerOptions): Logger {
  const counter = { dropped: 0 };
  return makeLogger(options, options.base ?? {}, counter);
}

function makeLogger(options: LoggerOptions, base: LogFields, counter: { dropped: number }): Logger {
  const min = LEVEL_ORDER[options.level ?? 'info'];
  const sink = options.sink ?? stdoutSink;

  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < min) return;
    const safeEvent = EVENT_NAME.test(event) ? event : 'log.invalid_event_name';
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service: options.service,
      event: safeEvent,
      msg: safeEvent,
    };
    const span = trace.getActiveSpan()?.spanContext();
    if (span && span.traceId !== '0'.repeat(32)) {
      record.trace_id = span.traceId;
      record.span_id = span.spanId;
    }
    Object.assign(
      record,
      sanitizeFields({ ...base, ...fields } as Record<string, unknown>, counter),
    );
    sink.write(JSON.stringify(record));
  };

  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
    child: (fields) => makeLogger(options, { ...base, ...fields }, counter),
    get droppedFields() {
      return counter.dropped;
    },
  };
}

/**
 * Safe error fields: class and code only. Messages are excluded because driver and library
 * messages can embed input values (for example PostgreSQL constraint details).
 */
export function errorFields(err: unknown): LogFields {
  if (!(err instanceof Error)) return { error_class: typeof err };
  const code = (err as { code?: unknown }).code;
  const fields: LogFields = { error_class: err.name || 'Error' };
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) fields.error_code = code;
  // Keep stack frames for internal diagnosis, but drop the first line, which holds the message.
  if (err.stack) {
    const frames = err.stack
      .split('\n')
      .slice(1, 12)
      .map((l) => l.trim())
      .join(' | ');
    if (frames) fields.error_stack = frames;
  }
  return fields;
}
