import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Secret, SecretVault } from '@pm/config';
import type { ScopedTransaction } from '@pm/db';

const PURPOSE = /^[a-z_]{1,32}$/;

/**
 * Development-only secret store: AES-256-GCM ciphertext in `ops.dev_secret_vault`, keyed by
 * DEV_VAULT_KEY, written in the caller's transaction. Configuration rejects it outside local and
 * test. It exists so the secret-reference model is exercised end to end before a KMS is chosen.
 */
export class DevDatabaseVault implements SecretVault {
  readonly name = 'dev-database';
  readonly #key: Buffer;

  constructor(key: Secret) {
    const bytes = Buffer.from(key.reveal(), 'base64url');
    this.#key = bytes.subarray(0, 32);
  }

  #scope(scope: unknown): ScopedTransaction {
    if (!scope || typeof scope !== 'object' || !('db' in scope))
      throw new Error('dev vault requires a transaction scope');
    return scope as ScopedTransaction;
  }

  async put(
    purpose: string,
    plaintext: string,
    options: { expiresAt?: Date; scope?: unknown },
  ): Promise<string> {
    if (!PURPOSE.test(purpose)) throw new Error('invalid vault purpose');
    const ref = `dev:${purpose}:${randomBytes(16).toString('hex')}`;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(ref));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    await this.#scope(options.scope)
      .db.insertInto('ops.dev_secret_vault')
      .values({
        ref,
        purpose,
        nonce,
        ciphertext,
        auth_tag: cipher.getAuthTag(),
        expires_at: options.expiresAt ?? null,
      })
      .execute();
    return ref;
  }

  async get(ref: string, options: { scope?: unknown }): Promise<string | undefined> {
    const row = await this.#scope(options.scope)
      .db.selectFrom('ops.dev_secret_vault')
      .select(['nonce', 'ciphertext', 'auth_tag', 'expires_at'])
      .where('ref', '=', ref)
      .executeTakeFirst();
    if (!row || (row.expires_at && row.expires_at.getTime() <= Date.now())) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', this.#key, row.nonce);
    decipher.setAAD(Buffer.from(ref));
    decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  }

  async destroy(ref: string, options: { scope?: unknown }): Promise<void> {
    await this.#scope(options.scope)
      .db.deleteFrom('ops.dev_secret_vault')
      .where('ref', '=', ref)
      .execute();
  }
}
