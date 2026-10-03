import { errorFields, type LogFields, type Logger } from './logger.ts';

/**
 * Vendor-neutral error-reporting boundary (0D §17.6). A commercial adapter, once approved, must
 * apply the same redaction: it receives only allow-listed fields and the error class/code.
 */
export interface ErrorReporter {
  capture(err: unknown, context?: LogFields): void;
  flush(): Promise<void>;
}

/** Default reporter: emits a structured, redacted `error.captured` log record. */
export class LogErrorReporter implements ErrorReporter {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  capture(err: unknown, context: LogFields = {}): void {
    this.#logger.error('error.captured', { ...context, ...errorFields(err) });
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

export class NoopErrorReporter implements ErrorReporter {
  capture(): void {}

  flush(): Promise<void> {
    return Promise.resolve();
  }
}
