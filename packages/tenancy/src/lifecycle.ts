import type { WorkspaceTransaction } from '@pm/db';
import type { BrandPort, LifecycleRegistry, RecordRef, RecordTypeAdapter } from '@pm/lifecycle';
import { withPersonalReferenceCleanup } from './personal-data.ts';

/**
 * Brand lifecycle hooks registered with Phase 1F. Containment children are the top-level records
 * other modules declare through `rootsInBrand` (none exist yet). The adapter deliberately has no
 * purge hooks: a brand purge blocks with `missing_purge_hook` until every contained module has
 * registered its own (1C does not claim brand purge support).
 */
export function brandAdapter(registry: LifecycleRegistry): RecordTypeAdapter {
  return {
    recordType: 'brand',
    async children(tx: WorkspaceTransaction, parentIds: readonly string[]): Promise<RecordRef[]> {
      const out: RecordRef[] = [];
      for (const a of registry.all()) {
        if (a.recordType === 'brand' || !a.rootsInBrand) continue;
        out.push(...(await a.rootsInBrand(tx, parentIds)));
      }
      return out;
    },
    containerOf: () => Promise.resolve(null),
  };
}

/**
 * Teams (1D) are workspace-scoped envelopes with no contained records. Archived teams confer no
 * grants (the compiler counts active teams only). No purge hooks: a team purge blocks safely.
 */
export const teamAdapter: RecordTypeAdapter = {
  recordType: 'team',
  children: () => Promise.resolve([]),
  containerOf: () => Promise.resolve(null),
};

/**
 * Registers the brand and team record types (API and worker use the same registration). Every
 * adapter is wrapped so a purge also removes personal favorites and recents of purged records
 * (1E); brands and teams have no purge hooks yet, so for them the wrapper changes nothing.
 */
export function registerTenancyLifecycle(registry: LifecycleRegistry): LifecycleRegistry {
  return registry
    .register(withPersonalReferenceCleanup(brandAdapter(registry)))
    .register(withPersonalReferenceCleanup(teamAdapter));
}

/** Real brand state for lifecycle restore checks: restore into a non-active brand is blocked. */
export const tenancyBrandPort: BrandPort = {
  async isActive(tx, brandId) {
    const b = await tx.db
      .selectFrom('tenancy.brand')
      .select('lifecycle_state')
      .where('id', '=', brandId)
      .executeTakeFirst();
    return b?.lifecycle_state === 'active';
  },
};
