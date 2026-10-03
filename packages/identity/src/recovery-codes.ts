import { randomBytes } from 'node:crypto';
import { base32Encode, sha256 } from './primitives.ts';

export const RECOVERY_CODE_COUNT = 10;

/** 80-bit codes shown as four groups of four (e.g. "ABCD-EFGH-JKLM-NPQR"); only SHA-256 stored. */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(10)); // 16 chars
    return raw.match(/.{4}/g)!.join('-');
  });
}

export function normalizeRecoveryCode(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const clean = input.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-7]{16}$/.test(clean) ? clean : undefined;
}

export function hashRecoveryCode(normalized: string): Buffer {
  return sha256(`recovery-code:${normalized}`);
}
