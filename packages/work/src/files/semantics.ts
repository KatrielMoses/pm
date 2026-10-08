/**
 * Phase 4E file and deliverable semantics (ADR-0026 F1–F9). Pure: no database, storage, or clock.
 *
 * - Uploads are accepted only for an allow-list of content types whose extension agrees with the
 *   declared type (a renamed executable is refused, not trusted).
 * - Previews are inline only for formats a browser renders without running content: raster
 *   images, audio, video, PDF, and plain text/code (served as `text/plain`). SVG, HTML, and
 *   anything scriptable are download-only (`Content-Disposition: attachment`).
 * - Comparisons are bounded: a line diff for text and code up to `FILE_COMPARE_MAX_BYTES`, and a
 *   metadata comparison for everything else.
 */

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none';

interface TypeRule {
  preview: PreviewKind;
  extensions: readonly string[];
  /** Served inline as this type (text and code are always `text/plain`). */
  inlineAs?: string;
}

const TEXT = 'text/plain; charset=utf-8';
const CODE_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'log',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'xml',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'sql',
  'css',
  'scss',
  'diff',
  'patch',
] as const;

/** Allow-listed content types (FILE-001, FILE-002). The key is the declared type. */
export const CONTENT_TYPES: Readonly<Record<string, TypeRule>> = {
  'image/png': { preview: 'image', extensions: ['png'] },
  'image/jpeg': { preview: 'image', extensions: ['jpg', 'jpeg'] },
  'image/gif': { preview: 'image', extensions: ['gif'] },
  'image/webp': { preview: 'image', extensions: ['webp'] },
  'image/avif': { preview: 'image', extensions: ['avif'] },
  'image/svg+xml': { preview: 'none', extensions: ['svg'] },
  'video/mp4': { preview: 'video', extensions: ['mp4', 'm4v'] },
  'video/webm': { preview: 'video', extensions: ['webm'] },
  'video/quicktime': { preview: 'none', extensions: ['mov'] },
  'audio/mpeg': { preview: 'audio', extensions: ['mp3'] },
  'audio/ogg': { preview: 'audio', extensions: ['ogg', 'oga'] },
  'audio/wav': { preview: 'audio', extensions: ['wav'] },
  'audio/mp4': { preview: 'audio', extensions: ['m4a'] },
  'application/pdf': { preview: 'pdf', extensions: ['pdf'] },
  'text/plain': { preview: 'text', extensions: [...CODE_EXTENSIONS], inlineAs: TEXT },
  'text/markdown': { preview: 'text', extensions: ['md', 'markdown'], inlineAs: TEXT },
  'text/csv': { preview: 'text', extensions: ['csv'], inlineAs: TEXT },
  'application/json': { preview: 'text', extensions: ['json'], inlineAs: TEXT },
  'text/html': { preview: 'none', extensions: ['html', 'htm'] },
  'application/msword': { preview: 'none', extensions: ['doc'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    preview: 'none',
    extensions: ['docx'],
  },
  'application/vnd.ms-excel': { preview: 'none', extensions: ['xls'] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    preview: 'none',
    extensions: ['xlsx'],
  },
  'application/vnd.ms-powerpoint': { preview: 'none', extensions: ['ppt'] },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    preview: 'none',
    extensions: ['pptx'],
  },
  'application/vnd.oasis.opendocument.text': { preview: 'none', extensions: ['odt'] },
  'application/vnd.oasis.opendocument.spreadsheet': { preview: 'none', extensions: ['ods'] },
  'application/rtf': { preview: 'none', extensions: ['rtf'] },
  'application/zip': { preview: 'none', extensions: ['zip'] },
  'application/gzip': { preview: 'none', extensions: ['gz', 'tgz'] },
  'application/x-tar': { preview: 'none', extensions: ['tar'] },
  'font/woff2': { preview: 'none', extensions: ['woff2'] },
};

/** Lower-cased media type without parameters. */
export const baseType = (t: string) => t.split(';')[0]!.trim().toLowerCase();

export function extensionOf(name: string): string | null {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : null;
}

/** Why a declared name and type cannot be uploaded, or null when they can. */
export function uploadTypeProblem(
  name: string,
  contentType: string,
): 'unsupported_type' | 'type_mismatch' | null {
  const rule = CONTENT_TYPES[baseType(contentType)];
  if (!rule) return 'unsupported_type';
  const ext = extensionOf(name);
  if (!ext || !rule.extensions.includes(ext)) return 'type_mismatch';
  return null;
}

export const previewKind = (contentType: string | null): PreviewKind =>
  contentType ? (CONTENT_TYPES[baseType(contentType)]?.preview ?? 'none') : 'none';

/** The type a preview is served inline as, or null when the format is download-only. */
export function inlineType(contentType: string | null): string | null {
  if (!contentType) return null;
  const rule = CONTENT_TYPES[baseType(contentType)];
  if (!rule || rule.preview === 'none') return null;
  return rule.inlineAs ?? baseType(contentType);
}

/** A display name: trimmed, no control characters or path separators, at most 255 characters. */
export function cleanFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim();
  return name.length >= 1 && name.length <= 255 && name !== '.' && name !== '..' ? name : null;
}

/** An external link (FILE-005): http(s) only, no credentials, at most 2048 characters. */
export function cleanExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname) return null;
  const out = u.toString();
  // eslint-disable-next-line no-control-regex
  return out.length <= 2048 && !/[\s\u0000-\u001f]/.test(out) ? out : null;
}

/** A display name for an external link: its last path segment, else its host. */
export function linkName(url: string): string {
  const u = new URL(url);
  const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
  return cleanFileName(last) ?? cleanFileName(u.hostname) ?? 'Link';
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Object keys carry no names and no identifiers (they appear in signed URLs and provider logs) and
 * are effect-key safe (purge records `object:{key}`): `q.{64 random hex}` while quarantined, and the
 * same random part under `o.` once promoted. The database row binds a key to its workspace.
 */
export const quarantineKey = (randomHex: string) => `q.${randomHex}`;
export const permanentKey = (quarantined: string) => `o.${quarantined.slice(2)}`;
export const OBJECT_EFFECT_PREFIX = 'object:';

// -------------------------------------------------------------------------------------------------
// Deliverables (FILE-006, FILE-007, FILE-009)
// -------------------------------------------------------------------------------------------------

export type DeliverableState =
  'draft' | 'ready_for_review' | 'changes_requested' | 'accepted' | 'rejected';

/**
 * The deliverable's state after a 4A review of its current version settles (or is withdrawn).
 * Acceptance needs an approval by a human reviewer; 4A's `approved` maps to `accepted`.
 */
export function stateAfterReview(
  outcome: 'approved' | 'changes_requested' | 'rejected' | 'withdrawn',
): DeliverableState {
  return outcome === 'approved'
    ? 'accepted'
    : outcome === 'changes_requested'
      ? 'changes_requested'
      : outcome === 'rejected'
        ? 'rejected'
        : 'draft';
}

/** Whether a new version may be submitted for review in `state` (an accepted one is final). */
export const canSubmit = (state: DeliverableState) => state !== 'accepted';

// -------------------------------------------------------------------------------------------------
// Comparisons (FILE-008): bounded line diff
// -------------------------------------------------------------------------------------------------

export type DiffLine = { op: 'same' | 'add' | 'remove'; text: string };

/**
 * A line diff of two texts (Myers-free LCS over at most `maxLines` lines each). Returns null when
 * either side is longer, so a caller reports "too large to compare" instead of a partial diff.
 */
export function lineDiff(a: string, b: string, maxLines = 2_000): DiffLine[] | null {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  if (x.length > maxLines || y.length > maxLines) return null;
  const n = x.length;
  const m = y.length;
  // LCS lengths, one row at a time per suffix (O(n·m) time, O(n·m) bits via Uint16 rows).
  const rows: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      rows[i]![j] =
        x[i] === y[j] ? rows[i + 1]![j + 1]! + 1 : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: 'same', text: x[i]! });
      i++;
      j++;
    } else if (rows[i + 1]![j]! >= rows[i]![j + 1]!) out.push({ op: 'remove', text: x[i++]! });
    else out.push({ op: 'add', text: y[j++]! });
  }
  while (i < n) out.push({ op: 'remove', text: x[i++]! });
  while (j < m) out.push({ op: 'add', text: y[j++]! });
  return out;
}

/** Whether bytes decode as UTF-8 text without NUL bytes (safe to diff). */
export function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
