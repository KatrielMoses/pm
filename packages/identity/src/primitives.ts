import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit opaque token: raw value shown or sent once; only its SHA-256 is stored (C4). */
export interface OpaqueToken {
  raw: string;
  hash: Buffer;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function newOpaqueToken(): OpaqueToken {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export function isWellFormedToken(raw: unknown): raw is string {
  return typeof raw === 'string' && TOKEN.test(raw);
}

export function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw, 'utf8').digest();
}

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Domain-separated HMAC (CSRF tokens, rate-limit keys): never reused across purposes. */
export function keyedHash(key: Buffer, domain: string, value: string): Buffer {
  return createHmac('sha256', key).update(`${domain}\u0000${value}`, 'utf8').digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (TOTP secrets, recovery codes). */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Holds a request to a minimum duration so success and failure share one timing class. */
export async function withResponseFloor<T>(floorMs: number, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const remaining = floorMs - (performance.now() - started);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  }
}
