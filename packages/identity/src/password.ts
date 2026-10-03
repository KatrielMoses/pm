import { argon2, randomBytes } from 'node:crypto';
import { safeEqual } from './primitives.ts';

/** Policy (NIST SP 800-63B aligned): length, not composition. Never truncated. */
export const PASSWORD_MIN_CHARS = 12;
export const PASSWORD_MAX_CHARS = 256;
/** Maximum UTF-8 byte length accepted before hashing (bounds Argon2 input and request cost). */
export const PASSWORD_MAX_BYTES = 1024;

export type PasswordProblem = 'too_short' | 'too_long' | 'invalid';

export function checkPasswordPolicy(password: unknown): PasswordProblem | undefined {
  if (typeof password !== 'string') return 'invalid';
  const normalized = password.normalize('NFC');
  const chars = [...normalized].length;
  if (Buffer.byteLength(normalized, 'utf8') > PASSWORD_MAX_BYTES || chars > PASSWORD_MAX_CHARS)
    return 'too_long';
  if (chars < PASSWORD_MIN_CHARS) return 'too_short';
  if (/\p{Cc}/u.test(normalized.replace(/[\t]/g, ''))) return 'invalid';
  return undefined;
}

export interface Argon2Params {
  v: number; // 0x13
  m: number; // memory, KiB
  t: number; // passes
  p: number; // lanes
  len: number; // tag length, bytes
}

export interface PasswordHash {
  hash: Buffer;
  salt: Buffer;
  algorithm: 'argon2id';
  params: Argon2Params;
}

/** Bounds concurrent Argon2 work so memory stays within m × concurrency. */
class Semaphore {
  #available: number;
  readonly #queue: Array<() => void> = [];

  constructor(n: number) {
    this.#available = n;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#available > 0) this.#available--;
    else await new Promise<void>((r) => this.#queue.push(r));
    try {
      return await fn();
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#available++;
    }
  }
}

export class PasswordHasher {
  readonly #target: Argon2Params;
  readonly #gate: Semaphore;

  constructor(config: {
    memoryKiB: number;
    passes: number;
    parallelism: number;
    maxConcurrency: number;
  }) {
    this.#target = { v: 19, m: config.memoryKiB, t: config.passes, p: config.parallelism, len: 32 };
    this.#gate = new Semaphore(config.maxConcurrency);
  }

  get params(): Argon2Params {
    return { ...this.#target };
  }

  #derive(password: string, salt: Buffer, p: Argon2Params): Promise<Buffer> {
    return this.#gate.run(
      () =>
        new Promise<Buffer>((resolve, reject) =>
          argon2(
            'argon2id',
            {
              message: Buffer.from(password.normalize('NFC'), 'utf8'),
              nonce: salt,
              parallelism: p.p,
              tagLength: p.len,
              memory: p.m,
              passes: p.t,
            },
            (err, derived) => (err ? reject(err) : resolve(derived)),
          ),
        ),
    );
  }

  async hash(password: string): Promise<PasswordHash> {
    if (checkPasswordPolicy(password) === 'too_long')
      throw new Error('password exceeds the maximum length');
    const salt = randomBytes(16);
    const params = this.params;
    return {
      hash: await this.#derive(password, salt, params),
      salt,
      algorithm: 'argon2id',
      params,
    };
  }

  async verify(
    password: string,
    stored: Pick<PasswordHash, 'hash' | 'salt' | 'params'>,
  ): Promise<boolean> {
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES)
      return false;
    const derived = await this.#derive(password, stored.salt, stored.params);
    return safeEqual(derived, stored.hash);
  }

  /** Equalizes timing when there is no account: same work as a real verification. */
  async verifyDummy(password: string): Promise<false> {
    await this.#derive(
      typeof password === 'string' ? password.slice(0, PASSWORD_MAX_CHARS) : '',
      DUMMY_SALT,
      this.#target,
    );
    return false;
  }

  /** True when stored parameters are weaker than the configured target (rehash on success). */
  needsRehash(params: Argon2Params): boolean {
    const t = this.#target;
    return (
      params.v !== t.v ||
      params.m < t.m ||
      params.t < t.t ||
      params.p !== t.p ||
      params.len !== t.len
    );
  }
}

const DUMMY_SALT = randomBytes(16);
