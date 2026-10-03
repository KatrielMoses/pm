import { randomBytes, randomFillSync } from 'node:crypto';
import { ID_PREFIXES, type IdPrefix } from './generated/registry.ts';

// Crockford base32 without I, L, O, U (0D common#/$defs/public_id).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PUBLIC_ID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KNOWN_PREFIXES: ReadonlySet<string> = new Set(ID_PREFIXES.map((p) => p.prefix));

/** Encodes 128 random bits as 26 Crockford base32 characters (top two bits are zero). */
function encode128(bytes: Uint8Array): string {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/** Public ID: `<prefix>_<26 Crockford base32>` over 128 random bits (0B §2.2). */
export function newPublicId(prefix: IdPrefix): string {
  return `${prefix}_${encode128(randomBytes(16))}`;
}

export function isPublicId(value: string, prefix?: IdPrefix): boolean {
  const sep = value.indexOf('_');
  if (sep < 2) return false;
  const p = value.slice(0, sep);
  if (prefix !== undefined ? p !== prefix : !KNOWN_PREFIXES.has(p)) return false;
  return PUBLIC_ID_BODY.test(value.slice(sep + 1));
}

/** Per-request identifier (`req_`), never persisted (registry: platform-only). */
export function newRequestId(): string {
  return newPublicId('req');
}

/**
 * Internal UUIDv7 (RFC 9562): 48-bit Unix ms timestamp, version 7, variant 10, random tail.
 * Internal only: never placed in URLs or public API bodies (0B §2.2).
 */
export function newUuidV7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  randomFillSync(b, 6);
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

/** Pattern used by tests and response scanners to prove internal keys never leak. */
export const UUID_ANY_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function isTraceId(value: string): boolean {
  return TRACE_ID.test(value) && value !== '0'.repeat(32);
}

export function isSpanId(value: string): boolean {
  return SPAN_ID.test(value) && value !== '0'.repeat(16);
}

export interface ParsedTraceparent {
  traceId: string;
  spanId: string;
  flags: string;
}

export function parseTraceparent(value: string | undefined): ParsedTraceparent | undefined {
  if (value === undefined) return undefined;
  const m = TRACEPARENT.exec(value.trim());
  if (!m) return undefined;
  const [, traceId, spanId, flags] = m as unknown as [string, string, string, string];
  if (!isTraceId(traceId) || !isSpanId(spanId)) return undefined;
  return { traceId, spanId, flags };
}

/** Correlation IDs are W3C trace IDs (32 hex) publicly and `uuid` columns internally (0B model). */
export function traceIdToUuid(traceId: string): string {
  if (!TRACE_ID.test(traceId)) throw new Error('invalid trace id');
  return `${traceId.slice(0, 8)}-${traceId.slice(8, 12)}-${traceId.slice(12, 16)}-${traceId.slice(16, 20)}-${traceId.slice(20)}`;
}

export function uuidToTraceId(uuid: string): string {
  const hex = uuid.replaceAll('-', '').toLowerCase();
  if (!TRACE_ID.test(hex)) throw new Error('invalid uuid');
  return hex;
}
