import type { WorkspaceTransaction } from '@pm/db';
import type { LifecycleAction, PolicyDecision } from '@pm/lifecycle';
import { issueLifecycleDecision } from '@pm/lifecycle/policy-issuer';
import { TenancyError } from './errors.ts';
import { decideRecord, type BrandFacts, type Principal, type ProjectChain } from './policy.ts';

/**
 * The tenancy-exported lifecycle issuer (0C AZ-21, Phase 2A confinement rule). Record-owning
 * modules (work) obtain lifecycle decisions only here: the compiled record decision runs first,
 * with the record's brand and governing project chain, and the decision is issued for exactly the
 * authorized record. Work code never imports the restricted issuer and never mints a decision.
 *
 * Unreadable → `not_found`; readable but insufficient → `forbidden` (0C §4.3).
 */
export type RecordLifecycleAction = Extract<
  LifecycleAction,
  'record.archive' | 'record.restore' | 'record.trash' | 'record.purge'
>;

export interface RecordFacts {
  id: string;
  brand: BrandFacts | null;
  lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
  projectChain: ProjectChain | null;
}

export function issueRecordLifecycleDecision<A extends RecordLifecycleAction>(
  tx: WorkspaceTransaction,
  p: Principal,
  action: A,
  record: RecordFacts,
): PolicyDecision<A> {
  // Lifecycle actions are decided on the record's live authority: the archived read-only cap and
  // trash invisibility govern content commands, not the transitions out of those states. The
  // lifecycle service still enforces which transitions are legal from the current state.
  if (record.lifecycleState === 'purged') throw new TenancyError('not_found');
  const lifecycleState = 'active' as const;
  const outcome = decideRecord(p, action, {
    brand: record.brand,
    lifecycleState,
    shareLevel: null,
    projectChain: record.projectChain,
  });
  if (!outcome.allowed) throw new TenancyError(outcome.code);
  return issueLifecycleDecision(action, tx.workspaceId, [record.id], p.membershipId);
}
