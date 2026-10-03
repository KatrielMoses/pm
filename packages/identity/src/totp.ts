import { createHmac, randomBytes } from 'node:crypto';
import { base32Decode, base32Encode } from './primitives.ts';

// RFC 6238 TOTP: HMAC-SHA1, 6 digits, 30-second steps (authenticator-app compatible).
export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
/** Accepted clock drift: one step before or after. */
export const TOTP_WINDOW = 1;

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20)); // 160 bits (RFC 4226 recommendation)
}

export function totpCode(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return bin.toString().padStart(TOTP_DIGITS, '0');
}

export function currentStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_S);
}

/**
 * Returns the matching time step within the window, or undefined. Callers must reject steps at or
 * below the factor's last accepted step (replay protection).
 */
export function verifyTotp(
  secretB32: string,
  code: unknown,
  nowMs: number = Date.now(),
): number | undefined {
  if (typeof code !== 'string') return undefined;
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return undefined;
  const now = currentStep(nowMs);
  let matched: number | undefined;
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    // Evaluate every candidate (no early exit) to keep timing independent of the matching step.
    if (totpCode(secretB32, now + d) === digits && matched === undefined) matched = now + d;
  }
  return matched;
}

export function otpauthUri(secretB32: string, accountLabel: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_S),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
