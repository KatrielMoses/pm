import { domainToASCII } from 'node:url';

export interface NormalizedEmail {
  /** Delivery/display form: trimmed, NFC, ASCII (IDNA) domain. */
  display: string;
  /** Comparison key: display form with the whole address lowercased (no alias rules). */
  key: string;
}

export class EmailFormatError extends Error {
  constructor() {
    super('invalid email address');
    this.name = 'EmailFormatError';
  }
}

// Pragmatic validation: one @, no whitespace or control characters, a dotted domain.
const LOCAL = /^[^\s@\p{Cc}"(),:;<>[\\\]]{1,64}$/u;
const DOMAIN_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Normalizes for comparison without provider-specific assumptions: no dot or plus-tag removal.
 * The domain is case-insensitive and IDNA-encoded; the local part is lowercased for the key only,
 * which matches how virtually all providers treat it, while delivery uses the original case.
 */
export function normalizeEmail(input: unknown): NormalizedEmail {
  if (typeof input !== 'string') throw new EmailFormatError();
  const trimmed = input.normalize('NFC').trim();
  if (trimmed.length < 3 || trimmed.length > 254) throw new EmailFormatError();
  const at = trimmed.lastIndexOf('@');
  if (at < 1 || trimmed.indexOf('@') !== at) throw new EmailFormatError();
  const local = trimmed.slice(0, at);
  const ascii = domainToASCII(trimmed.slice(at + 1).toLowerCase());
  if (
    !ascii ||
    !LOCAL.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..')
  ) {
    throw new EmailFormatError();
  }
  const labels = ascii.split('.');
  if (labels.length < 2 || ascii.length > 253 || !labels.every((l) => DOMAIN_LABEL.test(l)))
    throw new EmailFormatError();
  const display = `${local}@${ascii}`;
  if (display.length > 254) throw new EmailFormatError();
  return { display, key: `${local.toLowerCase()}@${ascii}` };
}
