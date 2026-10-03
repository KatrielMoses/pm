import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';

/**
 * Holds a secret value. Every implicit serialization path (String(), JSON, util.inspect, template
 * literals) yields `[REDACTED]`; only `reveal()` returns the value, which keeps reveals greppable.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/**
 * Adapter boundary for the future managed secret store / KMS (DQ-28, vendor not selected).
 * Values of the form `secretref:<name>` are resolved through the configured provider.
 */
export interface SecretProvider {
  readonly name: string;
  resolve(reference: string): Promise<string>;
}

/** Resolves only values injected into the process environment (local, CI, injected deployments). */
export class EnvironmentSecretProvider implements SecretProvider {
  readonly name = 'env';

  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.#env = env;
  }

  resolve(reference: string): Promise<string> {
    const value = this.#env[reference];
    if (value === undefined || value === '') {
      return Promise.reject(new Error(`secret reference not available: ${reference}`));
    }
    return Promise.resolve(value);
  }
}

export const SECRET_REFERENCE_PREFIX = 'secretref:';
