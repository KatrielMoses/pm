import { ISSUE } from './decision-internal.ts';
import { PolicyDecision, type LifecycleAction } from './decision.ts';

/**
 * Restricted decision issuer (`@pm/lifecycle/policy-issuer`) for the tenancy policy compiler
 * (1C, extended by 1D). It issues only what the compiler already decided from canonical
 * membership and effective permission. A confinement test allows exactly one importer:
 * `packages/tenancy/src`. Applications and other packages never import it.
 */
export function issueLifecycleDecision<A extends LifecycleAction>(
  action: A,
  workspaceId: string,
  recordIds: readonly string[],
  membershipId: string,
): PolicyDecision<A> {
  return new PolicyDecision(ISSUE, {
    action,
    workspaceId,
    recordIds,
    principal: { type: 'member', id: membershipId },
  });
}
