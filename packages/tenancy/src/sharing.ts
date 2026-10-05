import type { ShareLevel } from './policy.ts';

/**
 * The one shareability registry (0C AZ-21, OD-04): record types that may be shared as exact records
 * and the share levels each module actually enforces. Every other record type is non-shareable,
 * even when a `core.record` exists for it (AT-116). Owning phases add their types here when they
 * enforce the levels; nothing else may share a record.
 *
 * Test-only record types (`core.record_type.test_only`, writable only by test fixtures and never by
 * a production role, ADR-0009 G3) are shareable at every level so the generic grant machinery can
 * be exercised without a product type.
 */
export const SHAREABLE_RECORD_TYPES: ReadonlyMap<string, readonly ShareLevel[]> = new Map([
  ['project', ['read', 'comment', 'edit'] as const],
  // 2B (0C AZ-22): the task record, its checklist, and its own criteria only.
  ['task', ['read', 'comment', 'edit'] as const],
]);

/** Share levels a record type supports, or null when it is not shareable. */
export function shareableLevels(
  recordType: string,
  testOnly: boolean,
): readonly ShareLevel[] | null {
  if (testOnly) return ['read', 'comment', 'edit'];
  return SHAREABLE_RECORD_TYPES.get(recordType) ?? null;
}

/**
 * Whether a share of this type may carry selected children. A project share covers the project
 * record only (never phases, milestones, descendants, dependencies, or activity).
 */
export function sharesChildren(_recordType: string, testOnly: boolean): boolean {
  return testOnly;
}
