/**
 * Exact money for the AI gateway (ADR-0038 A6). Amounts are integer picodollars (1e-12 USD) in
 * memory and decimal micro-dollars with six fractional digits in PostgreSQL (`numeric(20, 6)`), so
 * a per-token price below one micro-dollar is still exact. Nothing here is a float.
 */

export const PICO_PER_MICRO = 1_000_000n;
const MICRO_PATTERN = /^(\d{1,14})(?:\.(\d{1,6}))?$/;

/** Parses a non-negative decimal micro-dollar string (as PostgreSQL returns `numeric`). */
export function parseMicros(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value * PICO_PER_MICRO;
  const text = typeof value === 'number' ? String(value) : value.trim();
  const m = MICRO_PATTERN.exec(text);
  if (!m) throw new Error('invalid micro-dollar amount');
  return BigInt(m[1]!) * PICO_PER_MICRO + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** Formats picodollars as a decimal micro-dollar string with exactly six fractional digits. */
export function microsString(pico: bigint): string {
  if (pico < 0n) throw new Error('negative amount');
  const whole = pico / PICO_PER_MICRO;
  const frac = (pico % PICO_PER_MICRO).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

/**
 * A display string in US dollars. Amounts below a cent keep enough digits to be non-zero, so a
 * real cost is never shown as $0.00; an exact zero is shown as $0.00.
 */
export function usdDisplay(pico: bigint): string {
  if (pico === 0n) return '$0.00';
  const picoPerDollar = 1_000_000_000_000n;
  const dollars = pico / picoPerDollar;
  const rest = pico % picoPerDollar;
  // Up to twelve fractional digits, trimmed, but at least two.
  let frac = rest.toString().padStart(12, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  if (dollars === 0n && frac.length > 8) frac = frac.slice(0, 8).replace(/0+$/, '') || '00000001';
  return `$${dollars}.${frac}`;
}

/** Whole micro-dollars rounded up (the conservative direction for a limit comparison). */
export function ceilMicros(pico: bigint): bigint {
  return (pico + PICO_PER_MICRO - 1n) / PICO_PER_MICRO;
}
