/**
 * Outbound redaction for AI requests (ADR-0038 A5, SEC-014 contribution). Free text that leaves
 * for a provider is scanned for credential shapes; each match is replaced with a fixed marker
 * before the text is stored or sent. The scan is deliberately conservative: a false positive costs
 * a word, a false negative could send a credential.
 */

const PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  {
    kind: 'private_key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { kind: 'provider_key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'product_token', re: /\bpm_[A-Za-z0-9_-]{8}[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'google_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { kind: 'url_credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
  {
    kind: 'assigned_secret',
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*\S{6,}/gi,
  },
];

export const REDACTION_MARKER = '[redacted credential]';

export interface Redaction {
  text: string;
  count: number;
  kinds: string[];
}

export function redactCredentials(input: string): Redaction {
  let text = input;
  let count = 0;
  const kinds = new Set<string>();
  for (const { kind, re } of PATTERNS) {
    text = text.replace(re, () => {
      count += 1;
      kinds.add(kind);
      return REDACTION_MARKER;
    });
  }
  return { text, count, kinds: [...kinds].sort() };
}
