import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MailMessage {
  /** Stable per delivery; also the idempotency key a provider adapter should forward. */
  id: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

/** Provider-neutral mail boundary. No production provider is selected (roadmap approval). */
export interface MailTransport {
  readonly name: string;
  send(message: MailMessage): Promise<{ providerMessageId: string }>;
}

/**
 * Local/test capture: messages are kept in memory and, when a directory is configured, written as
 * JSON files readable only by developers and tests. Never enabled in deployed environments.
 */
export class CaptureTransport implements MailTransport {
  readonly name = 'capture';
  readonly messages: MailMessage[] = [];
  readonly #dir: string | undefined;

  constructor(dir?: string) {
    this.#dir = dir;
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  send(message: MailMessage): Promise<{ providerMessageId: string }> {
    this.messages.push(message);
    if (this.#dir) {
      writeFileSync(
        join(this.#dir, `${Date.now()}-${message.id}.json`),
        JSON.stringify(message, null, 2),
        { mode: 0o600 },
      );
    }
    return Promise.resolve({ providerMessageId: `capture-${message.id}` });
  }
}
