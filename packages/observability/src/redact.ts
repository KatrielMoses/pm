// Redaction layer (SEC-014, 0D §17.1). Used by the logger, error reporting, configuration dumps,
// and span attributes. Allow-lists decide what is logged; these rules are the second line.

export const REDACTED = '[REDACTED]';

/** Keys whose values are never emitted, whatever their content. */
const SENSITIVE_KEY =
  /(authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|credential|session|dsn|connection[-_]?string|database[-_]?url|^url$|_url$|^body$|request[-_]?body|response[-_]?body|payload|content|^params$|parameters|bind|^values$|^query$|search[-_]?query|prompt|file[-_]?name|filename|email|^name$|title|description|comment)/i;

const STRING_RULES: ReadonlyArray<[RegExp, string]> = [
  // Credentials embedded in URLs (postgres://user:pass@host/db, https://user:pass@...).
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Authorization schemes.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/g, `$1 ${REDACTED}`],
  // JWT-shaped values.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED],
  // key=value / key: value pairs naming secrets.
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    `$1$2${REDACTED}`,
  ],
  // Private key blocks.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // Email addresses (0D §17.1 forbids them in logs).
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
];

export function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of STRING_RULES) out = out.replace(pattern, replacement);
  return out;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * Deep redaction for diagnostic objects (configuration dumps, error-report context). Sensitive keys
 * are replaced whole; strings are scrubbed; depth and size are bounded.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return truncate(redactString(value), 512);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') {
    const json = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof json === 'function') return redactValue(json.call(value), depth + 1);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
