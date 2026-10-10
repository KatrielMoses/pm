import { ISSUE } from './decision-internal.ts';
import { PolicyDecision, type LifecycleAction } from './decision.ts';

/**
 * Test-only decision issuer (`@pm/lifecycle/testing`). Applications never import this subpath; a
 * confinement test enforces it. Real decisions come from the 1D policy layer.
 */
export function testDecision<A extends LifecycleAction>(
  action: A,
  workspaceId: string,
  options: { recordIds?: readonly string[] | null; principalId: string },
): PolicyDecision<A> {
  return new PolicyDecision(ISSUE, {
    action,
    workspaceId,
    recordIds: options.recordIds ?? null,
    principal: { type: 'member', id: options.principalId },
  });
}
