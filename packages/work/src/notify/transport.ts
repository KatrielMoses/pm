import type { MailTransport } from '@pm/identity';
import type { FailureClass } from './semantics.ts';

/**
 * The provider-neutral email boundary of the notification platform (ADR-0024 D8). A provider
 * acknowledges a message by returning its id; anything else is a classified failure. No provider
 * is selected before the roadmap approves one, so an unconfigured platform says so (readiness
 * reports `not_configured`) and never reports a message delivered.
 */
export class DeliveryError extends Error {
  readonly failureClass: FailureClass;
  readonly code: string;
  constructor(failureClass: FailureClass, code: string) {
    super(`notification delivery failed: ${code}`);
    this.name = 'DeliveryError';
    this.failureClass = failureClass;
    this.code = code;
  }
}

export interface ExternalMessage {
  /** Stable per delivery: the idempotency key a provider adapter forwards. */
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProvider {
  readonly name: string;
  /** `capture` keeps messages for developers and tests; `unconfigured` has no provider at all. */
  readonly state: 'configured' | 'capture' | 'unconfigured';
  send(message: ExternalMessage): Promise<{ providerMessageId: string }>;
}

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ESOCKET',
]);

/** Sorts what a mail transport throws into the failure classes the retry policy understands. */
export function classifyTransportError(err: unknown): DeliveryError {
  if (err instanceof DeliveryError) return err;
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    responseCode?: unknown;
    status?: unknown;
  };
  const status = Number(e.responseCode ?? e.status);
  if (status === 429) return new DeliveryError('rate_limited', 'provider_rate_limited');
  if (status >= 500 && status < 600 && status !== 503 && status !== 502 && status !== 504)
    return new DeliveryError('permanent', 'provider_rejected');
  if (status >= 400 && status < 500) return new DeliveryError('permanent', 'provider_rejected');
  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code))
    return new DeliveryError('transient', 'provider_unreachable');
  return new DeliveryError('transient', 'transport_error');
}

/** The email provider the platform uses: the configured mail transport, or none. */
export function emailProviderFrom(transport: MailTransport | null, from: string): EmailProvider {
  if (!transport)
    return {
      name: 'none',
      state: 'unconfigured',
      send: () => Promise.reject(new DeliveryError('unconfigured', 'provider_unconfigured')),
    };
  return {
    name: transport.name,
    state: transport.name === 'capture' ? 'capture' : 'configured',
    async send(m) {
      try {
        return await transport.send({ ...m, from });
      } catch (err) {
        throw classifyTransportError(err);
      }
    },
  };
}
