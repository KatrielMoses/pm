import type { WorkspaceTransaction } from '@pm/db';

/**
 * Typed lifecycle failures. Callers map them to API problems once tenant routes exist (1C/1D);
 * none of them carries record content.
 */
export type LifecycleFailure =
  | 'not_found'
  | 'not_active'
  | 'archived_by_container'
  | 'in_trash'
  | 'not_restorable'
  | 'container_missing'
  | 'container_trashed'
  | 'container_inactive'
  | 'brand_inactive'
  | 'recovery_expired'
  | 'hold'
  | 'evidence_locked'
  | 'missing_purge_hook'
  | 'ledger_unavailable'
  | 'concurrent_change'
  | 'unregistered_type';

export class LifecycleError extends Error {
  readonly reason: LifecycleFailure;
  constructor(reason: LifecycleFailure) {
    super(`lifecycle command failed: ${reason}`);
    this.name = 'LifecycleError';
    this.reason = reason;
  }
}

export interface RecordRef {
  id: string;
  recordType: string;
}

/**
 * Purge hooks a module registers for its record type. Every hook is idempotent (a retried purge
 * step calls it again) and must touch only rows of the given records.
 */
export interface PurgeHooks {
  /** Deletes typed rows and hosted children (comments, field values, followers, …). */
  deleteContent(tx: WorkspaceTransaction, recordIds: readonly string[]): Promise<void>;
  /** Deletes association rows touching these records (both endpoints). */
  removeAssociations?(tx: WorkspaceTransaction, recordIds: readonly string[]): Promise<number>;
  /** Stable object keys to delete through external effects (performed later, never inline). */
  objectKeys?(tx: WorkspaceTransaction, recordIds: readonly string[]): Promise<string[]>;
  /** Removes derived projections (search documents, metric contributions, caches). */
  removeProjections?(tx: WorkspaceTransaction, recordIds: readonly string[]): Promise<void>;
}

/**
 * What an owning module tells the lifecycle core about one record type. Containment is the only
 * relation lifecycle follows; associations never cascade (0A hierarchy §3.1).
 */
export interface RecordTypeAdapter {
  readonly recordType: string;
  /** Direct containment children of these parents (any type), never associations. */
  children?(tx: WorkspaceTransaction, parentIds: readonly string[]): Promise<RecordRef[]>;
  /**
   * Top-level records of this type that a brand contains directly (projects, documents, …). The
   * brand adapter (1C) unions these as the brand's containment children; modules register them
   * in their owning phases.
   */
  rootsInBrand?(tx: WorkspaceTransaction, brandIds: readonly string[]): Promise<RecordRef[]>;
  /** The record's container, recorded as the restore location. */
  containerOf?(tx: WorkspaceTransaction, recordId: string): Promise<RecordRef | null>;
  /** Members that are evidence-locked (excluded from purge while the lock exists). */
  evidenceLocked?(tx: WorkspaceTransaction, recordIds: readonly string[]): Promise<string[]>;
  /** Required for purge: absent hooks make purge fail safely. */
  purge?: PurgeHooks;
}

export class LifecycleRegistry {
  readonly #adapters = new Map<string, RecordTypeAdapter>();

  register(adapter: RecordTypeAdapter): this {
    if (this.#adapters.has(adapter.recordType))
      throw new Error(`record type ${adapter.recordType} is already registered`);
    this.#adapters.set(adapter.recordType, adapter);
    return this;
  }

  get(recordType: string): RecordTypeAdapter | undefined {
    return this.#adapters.get(recordType);
  }

  all(): RecordTypeAdapter[] {
    return [...this.#adapters.values()];
  }

  /** Record types among `types` with no purge hooks (purge must not proceed). */
  missingPurgeHooks(types: Iterable<string>): string[] {
    return [...new Set(types)].filter((t) => !this.#adapters.get(t)?.purge).sort();
  }
}

/** Legal/retention holds (OD-37 undecided). Default: none registered. */
export interface HoldPort {
  isHeld(
    tx: WorkspaceTransaction,
    scope: { workspaceId: string; recordIds: readonly string[] },
  ): Promise<boolean>;
}
export const NO_HOLDS: HoldPort = { isHeld: () => Promise.resolve(false) };

/**
 * Brand state. `@pm/tenancy` supplies the real port (restore into an archived brand is blocked,
 * 0A §2); the permissive default remains only for lower-layer tests without brands.
 */
export interface BrandPort {
  isActive(tx: WorkspaceTransaction, brandId: string): Promise<boolean>;
}
export const BRANDS_UNTIL_1C: BrandPort = { isActive: () => Promise.resolve(true) };
