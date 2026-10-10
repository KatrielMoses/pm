import { createHash } from 'node:crypto';
import type { ChangeClass, StoredChange } from '@pm/db';
import { canonicalJson } from '@pm/platform';

/**
 * Classified audit changes (0B §7.3, 0D §12.1). Callers never choose a class at write time: the
 * owning module declares a field catalog, and `diffChanges` derives classified, validated entries
 * from before/after values. The database re-validates every entry (`audit.valid_changes`).
 */

export class AuditChangeError extends Error {
  constructor(reason: string) {
    super(`invalid audit change: ${reason}`);
    this.name = 'AuditChangeError';
  }
}

/** A field's value class and whether it is presentation-only (never audited). */
export interface FieldSpec {
  readonly class: ChangeClass;
  readonly presentation?: boolean;
}

export type FieldCatalog = Readonly<Record<string, FieldSpec>>;

const FIELD = /^[a-z][a-z0-9_]{0,62}(\.[a-z][a-z0-9_]{0,62}){0,3}$/;
const SECRET_NAME =
  /(password|passphrase|secret|token|api_key|apikey|private_key|credential|otp_seed|mfa_seed)/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REF = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MAX_CHANGES = 200;
const MAX_STRING = 2000;
const MAX_ARRAY = 100;
const MAX_ARRAY_STRING = 200;
const MAX_BYTES = 65536;

/** Content values are recorded as a hash plus a version reference, never the body. */
export interface ContentValue {
  readonly hash: string;
  readonly versionRef?: string;
}

/** Declares a module's field catalog; refuses secret-looking names without a secret class. */
export function defineFieldCatalog(catalog: Record<string, FieldSpec>): FieldCatalog {
  for (const [field, spec] of Object.entries(catalog)) {
    if (!FIELD.test(field)) throw new AuditChangeError(`field name ${field}`);
    if (
      SECRET_NAME.test(field) &&
      (spec.class === 'plain' || spec.class === 'personal' || spec.class === 'content')
    )
      throw new AuditChangeError(`secret-looking field ${field} must be secret or credential_ref`);
  }
  return Object.freeze({ ...catalog });
}

export function contentHash(body: string | Buffer): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function validScalar(v: unknown): boolean {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
  if (typeof v === 'string') return v.length <= MAX_STRING && !v.includes('\u0000');
  return false;
}

function validValue(v: unknown): boolean {
  if (Array.isArray(v))
    return (
      v.length <= MAX_ARRAY &&
      v.every(
        (e) =>
          validScalar(e) &&
          (typeof e !== 'string' || e.length <= MAX_ARRAY_STRING) &&
          !(typeof e === 'object' && e !== null),
      )
    );
  return validScalar(v);
}

/** sha256 of the canonical entry without its digest: the entry's fingerprint, kept on redaction. */
export function changeDigest(entry: Omit<StoredChange, 'digest'>): string {
  return `sha256:${createHash('sha256').update(canonicalJson(entry)).digest('hex')}`;
}

function withDigest(entry: Omit<StoredChange, 'digest'>): StoredChange {
  return { ...entry, digest: changeDigest(entry) };
}

/** Typed builders, one per value class (exported for modules with bespoke diff logic). */
export const change = {
  plain(field: string, oldValue: unknown, newValue: unknown): StoredChange {
    guardField(field, 'plain');
    if (!validValue(oldValue) || !validValue(newValue))
      throw new AuditChangeError(`${field} value`);
    return withDigest({ field, class: 'plain', old: oldValue, new: newValue });
  },
  personal(field: string, oldValue: unknown, newValue: unknown): StoredChange {
    guardField(field, 'personal');
    if (!validValue(oldValue) || !validValue(newValue))
      throw new AuditChangeError(`${field} value`);
    return withDigest({ field, class: 'personal', old: oldValue, new: newValue });
  },
  content(field: string, value: ContentValue): StoredChange {
    guardField(field, 'content');
    if (!SHA256.test(value.hash)) throw new AuditChangeError(`${field} content hash`);
    if (value.versionRef !== undefined && !REF.test(value.versionRef))
      throw new AuditChangeError(`${field} version reference`);
    return withDigest({
      field,
      class: 'content',
      hash: value.hash,
      ...(value.versionRef !== undefined ? { version_ref: value.versionRef } : {}),
    });
  },
  /** Secrets never carry values: only the fact that they changed. */
  secret(field: string): StoredChange {
    guardField(field, 'secret');
    return withDigest({ field, class: 'secret', changed: true });
  },
  credentialRef(field: string, oldRef: string | null, newRef: string | null): StoredChange {
    guardField(field, 'credential_ref');
    for (const r of [oldRef, newRef])
      if (r !== null && !REF.test(r)) throw new AuditChangeError(`${field} reference`);
    return withDigest({ field, class: 'credential_ref', old: oldRef, new: newRef });
  },
};

function guardField(field: string, cls: ChangeClass): void {
  if (!FIELD.test(field)) throw new AuditChangeError(`field name ${field}`);
  if (SECRET_NAME.test(field) && (cls === 'plain' || cls === 'personal' || cls === 'content'))
    throw new AuditChangeError(`secret-looking field ${field}`);
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/**
 * Material-change detection: compares before/after through the catalog. Presentation-only fields
 * produce nothing; an empty result means "not material, write no audit event". A field missing
 * from the catalog is an error (unclassified values are never stored).
 */
export function diffChanges(
  catalog: FieldCatalog,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): StoredChange[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: StoredChange[] = [];
  for (const field of fields) {
    const spec = catalog[field];
    if (!spec) throw new AuditChangeError(`unclassified field ${field}`);
    if (spec.presentation) continue;
    const a = before[field];
    const b = after[field];
    if (sameValue(a, b)) continue;
    switch (spec.class) {
      case 'plain':
        out.push(change.plain(field, a ?? null, b ?? null));
        break;
      case 'personal':
        out.push(change.personal(field, a ?? null, b ?? null));
        break;
      case 'content': {
        const v = b as ContentValue | null | undefined;
        if (!v || typeof v !== 'object') throw new AuditChangeError(`${field} content value`);
        out.push(change.content(field, v));
        break;
      }
      case 'secret':
        out.push(change.secret(field));
        break;
      case 'credential_ref':
        out.push(
          change.credentialRef(
            field,
            (a as string | null | undefined) ?? null,
            (b as string | null | undefined) ?? null,
          ),
        );
        break;
    }
  }
  return validateChanges(out);
}

/** Mirrors the database check: bounded, classified, digested, unique fields. */
export function validateChanges(changes: StoredChange[]): StoredChange[] {
  if (changes.length > MAX_CHANGES) throw new AuditChangeError('too many changes');
  const seen = new Set<string>();
  for (const c of changes) {
    if (seen.has(c.field)) throw new AuditChangeError(`duplicate field ${c.field}`);
    seen.add(c.field);
    const { digest, ...rest } = c;
    if (!SHA256.test(digest) || (!c.redacted && digest !== changeDigest(rest)))
      throw new AuditChangeError(`${c.field} digest`);
    if (c.class === 'secret' && !c.redacted && ('old' in c || 'new' in c || 'hash' in c))
      throw new AuditChangeError(`${c.field} secret carries a value`);
  }
  if (Buffer.byteLength(JSON.stringify(changes)) > MAX_BYTES)
    throw new AuditChangeError('changes too large');
  return changes;
}

/** A change entry as shown to one viewer: no digests, and no values the viewer may not read. */
export type ViewChange =
  | Omit<StoredChange, 'digest'>
  | { field: string; class: ChangeClass; redacted: true; reason: 'policy' };

/**
 * Applies the viewer's field-level read policy (0C AT-043, 0D §12.4) to stored changes. Unreadable
 * fields keep their position and name but lose every value, hash, and version reference, so a
 * diff, count, or summary built from the result cannot leak them. Digests are always dropped:
 * a fingerprint of a short value could be brute-forced.
 */
export function viewChanges(
  changes: ReadonlyArray<StoredChange>,
  canRead: (field: string) => boolean,
): ViewChange[] {
  return changes.map((c) => {
    const { digest: _digest, ...rest } = c;
    if (c.redacted || canRead(c.field)) return rest;
    return { field: c.field, class: c.class, redacted: true, reason: 'policy' } as const;
  });
}
