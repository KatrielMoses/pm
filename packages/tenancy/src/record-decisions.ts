import type { WorkspaceTransaction } from '@pm/db';
import type { LifecycleAction, PolicyDecision } from '@pm/lifecycle';
import { issueLifecycleDecision } from '@pm/lifecycle/policy-issuer';
import { TenancyError } from './errors.ts';
import {
  decideBrand,
  decidePersonal,
  decideProject,
  decideRecord,
  decideWorkspace,
  recordLevel,
  type BrandFacts,
  type Principal,
  type ProjectChain,
} from './policy.ts';

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
  const facts = {
    brand: record.brand,
    lifecycleState,
    shareLevel: null,
    projectChain: record.projectChain,
  };
  // `record.purge` is an administrative action at the record's brand (or the workspace for a
  // brandless record), 0C policy; the record must still be readable to the caller.
  const outcome =
    action === 'record.purge'
      ? recordLevel(p, facts) === null
        ? ({ allowed: false, code: 'not_found' } as const)
        : record.brand
          ? decideBrand(p, action, { ...record.brand, lifecycleState: 'active' })
          : decideWorkspace(p, action)
      : decideRecord(p, action, facts);
  if (!outcome.allowed) throw new TenancyError(outcome.code);
  return issueLifecycleDecision(action, tx.workspaceId, [record.id], p.membershipId);
}

/**
 * Saved views (Phase 3A, 0C AZ-26): a personal view is deleted by its owner only
 * (`personal.manage_own`); a shared view by whoever may share views at its exact scope
 * (`view.share` at the workspace, brand, or project, never through record shares).
 */
export function issueSavedViewLifecycleDecision(
  tx: WorkspaceTransaction,
  p: Principal,
  view: {
    id: string;
    ownerMembershipId: string;
    scope:
      | { kind: 'personal' }
      | { kind: 'workspace' }
      | { kind: 'brand'; brand: BrandFacts }
      | {
          kind: 'project';
          project: {
            brand: BrandFacts;
            lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
            chain: ProjectChain;
          };
        };
  },
): PolicyDecision<'record.trash'> {
  const s = view.scope;
  const outcome =
    s.kind === 'personal'
      ? view.ownerMembershipId === p.membershipId
        ? decidePersonal(p, 'personal.manage_own')
        : ({ allowed: false, code: 'not_found' } as const)
      : s.kind === 'workspace'
        ? decideWorkspace(p, 'view.share')
        : s.kind === 'brand'
          ? decideBrand(p, 'view.share', s.brand)
          : decideProject(p, 'view.share', s.project);
  if (!outcome.allowed) throw new TenancyError(outcome.code);
  return issueLifecycleDecision('record.trash', tx.workspaceId, [view.id], p.membershipId);
}

/**
 * Personal dashboards (Phase 5D, 0C AZ-39): like a personal saved view, a personal dashboard is
 * its owner's alone and is managed through `personal.manage_own`, never through a placement.
 */
export function issuePersonalRecordLifecycleDecision<A extends RecordLifecycleAction>(
  tx: WorkspaceTransaction,
  p: Principal,
  action: A,
  record: { id: string; ownerMembershipId: string },
): PolicyDecision<A> {
  const outcome =
    record.ownerMembershipId === p.membershipId
      ? decidePersonal(p, 'personal.manage_own')
      : ({ allowed: false, code: 'not_found' } as const);
  if (!outcome.allowed) throw new TenancyError(outcome.code);
  return issueLifecycleDecision(action, tx.workspaceId, [record.id], p.membershipId);
}
