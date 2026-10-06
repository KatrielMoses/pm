import { createHash } from 'node:crypto';
import { change } from '@pm/audit';
import { canonical } from './serialization.ts';

/**
 * Configuration audit facts (ADR-0015 W9, 0B 07 §7.3.1). Every workflow, status, transition,
 * required-field, and approval-policy mutation writes one append-only audit entry whose changes are
 * a bounded, deterministic before/after of a **snapshot**:
 *
 * - plain (C1): stable public IDs, operation, scope kind, record kind, version, category, color,
 *   icon, rank, state, confirmation tier, approval policy, self-approval flag, required-field
 *   references (`builtin:<key>` or the field's public ID, plus `:override`), approver count;
 * - hashed (canonical SHA-256 of the canonical JSON): names, descriptions, and the approver set,
 *   so content and personal identifiers never enter the ledger, yet equality is checkable.
 *
 * There is no second history store: the entries go to the existing audit ledger through `change`.
 */

export type Scalar = string | number | boolean | null;
export type Snapshot = Readonly<Record<string, Scalar | readonly string[]>>;

/** Canonical content hash (the same form as `contentHash` in the audit helpers). */
export const configHash = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : `sha256:${createHash('sha256').update(canonical(v)).digest('hex')}`;

/** Fields that hold hashes of content-class or personal values (their names end in `_hash`). */
const HASHED = /_hash$/;

export function workflowSnapshot(w: {
  public_id: string;
  record_kind: string;
  scope_kind: string;
  name: string;
  state: string;
  version: number | string;
}): Snapshot {
  return {
    id: w.public_id,
    record_kind: w.record_kind,
    scope_kind: w.scope_kind,
    name_hash: configHash(w.name),
    state: w.state,
    version: Number(w.version),
  };
}

export function statusSnapshot(s: {
  public_id: string;
  name: string;
  description: string | null;
  category: string;
  color: string;
  icon: string | null;
  rank: string;
  state: string;
  version: number | string;
}): Snapshot {
  return {
    id: s.public_id,
    category: s.category,
    name_hash: configHash(s.name),
    description_hash: configHash(s.description),
    color: s.color,
    icon: s.icon,
    rank: s.rank,
    state: s.state,
    version: Number(s.version),
  };
}

export function transitionSnapshot(t: {
  public_id: string;
  from: string;
  to: string;
  description: string | null;
  confirmation_tier: string;
  approval_policy: string;
  allow_self_approval: boolean;
  state: string;
  version: number | string;
  requirements: Array<{ ref: string; override: boolean }>;
  approvers: string[];
}): Snapshot {
  return {
    id: t.public_id,
    from: t.from,
    to: t.to,
    description_hash: configHash(t.description),
    confirmation: t.confirmation_tier,
    approval_policy: t.approval_policy,
    allow_self_approval: t.allow_self_approval,
    state: t.state,
    version: Number(t.version),
    required_fields: t.requirements.map((r) => `${r.ref}${r.override ? ':override' : ''}`).sort(),
    approver_count: t.approvers.length,
    approvers_hash: configHash([...t.approvers].sort()),
  };
}

/**
 * Before/after changes for one configuration object. Always records the operation, the object's
 * stable ID, and the changed setting names; then each changed setting as `<entity>.<setting>`.
 * Keys are emitted in sorted order, so equal inputs give byte-equal entries.
 */
export function configChanges(
  entity: 'workflow' | 'status' | 'transition',
  operation: string,
  scopeKind: string,
  before: Snapshot | null,
  after: Snapshot | null,
  /** Ordinal slot (1-based) when one entry describes several objects of a kind; workflow has none. */
  slot?: number,
) {
  const name = slot ? `${entity}.o${slot}` : entity;
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  const changed = keys.filter(
    (k) => canonical(before?.[k] ?? null) !== canonical(after?.[k] ?? null),
  );
  const id = (after?.id ?? before?.id ?? null) as string | null;
  const out = [
    change.plain(`${name}.operation`, null, operation),
    change.plain(
      `${name}.id`,
      (before?.id as string | undefined) ?? null,
      (after?.id as string | undefined) ?? id,
    ),
    change.plain(`${name}.scope_kind`, null, scopeKind),
    change.plain(
      `${name}.changed`,
      null,
      changed.filter((k) => k !== 'version'),
    ),
  ];
  for (const k of changed) {
    if (k === 'id' || k === 'scope_kind') continue;
    const b = before?.[k] ?? null;
    const a = after?.[k] ?? null;
    // Hashed settings (`*_hash`) carry hashes only; scalar settings carry their bounded values.
    out.push(change.plain(`${name}.${k}`, b, a));
  }
  return out;
}

/** Which audit change names are hashes of content or personal values (for classification tests). */
export const isHashedSetting = (field: string) => HASHED.test(field);
