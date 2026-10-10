import type { ActionKey } from '@pm/contracts';
import { ISSUE } from './decision-internal.ts';

/**
 * Authorization decisions for tenant lifecycle and audit services (0C). Every service entry point
 * requires one; it can be constructed only through an issuer holding the module-private token:
 *
 *   - the tenancy policy compiler (1C, extended by 1D) evaluates canonical membership and effective
 *     permission and issues it through the restricted `@pm/lifecycle/policy-issuer` subpath;
 *   - `systemDecision` covers scheduled system work (retention purge) with actor `system`;
 *   - `@pm/lifecycle/testing` issues decisions for tests only (never imported by apps).
 *
 * Nothing builds a decision from request data. Identity proves who someone is; it never yields one
 * of these.
 */

export type LifecycleAction = Extract<
  ActionKey,
  | 'record.archive'
  | 'record.restore'
  | 'record.trash'
  | 'record.purge'
  | 'trash.manage'
  | 'audit.view'
  | 'brand.archive'
>;

export class PolicyDecision<A extends LifecycleAction = LifecycleAction> {
  readonly action: A;
  readonly workspaceId: string;
  /** null = any record in scope (trash.manage, system purge); otherwise the authorized targets. */
  readonly recordIds: ReadonlySet<string> | null;
  readonly principal: { readonly type: 'member' | 'system_job'; readonly id: string };

  /** @internal Use an issuer. */
  constructor(
    token: symbol,
    init: {
      action: A;
      workspaceId: string;
      recordIds: readonly string[] | null;
      principal: { type: 'member' | 'system_job'; id: string };
    },
  ) {
    if (token !== ISSUE) throw new Error('policy decisions are issued by the policy layer only');
    this.action = init.action;
    this.workspaceId = init.workspaceId;
    this.recordIds = init.recordIds === null ? null : new Set(init.recordIds);
    this.principal = Object.freeze({ ...init.principal });
    Object.freeze(this);
  }

  covers(recordId: string): boolean {
    return this.recordIds === null || this.recordIds.has(recordId);
  }
}

export class PolicyDecisionError extends Error {
  constructor(reason: string) {
    super(`policy decision rejected: ${reason}`);
    this.name = 'PolicyDecisionError';
  }
}

export function requireDecision<A extends LifecycleAction>(
  decision: PolicyDecision | undefined,
  action: A,
  workspaceId: string,
  recordId?: string,
): asserts decision is PolicyDecision<A> {
  if (!(decision instanceof PolicyDecision)) throw new PolicyDecisionError('missing');
  if (decision.action !== action) throw new PolicyDecisionError('wrong action');
  if (decision.workspaceId !== workspaceId) throw new PolicyDecisionError('wrong workspace');
  if (recordId !== undefined && !decision.covers(recordId))
    throw new PolicyDecisionError('target not covered');
}

/** Scheduled retention purge runs as the system (0C §11.1: scheduled purges are system jobs). */
export function systemDecision(
  action: 'record.purge',
  workspaceId: string,
  systemPrincipalId: string,
): PolicyDecision<'record.purge'> {
  return new PolicyDecision(ISSUE, {
    action,
    workspaceId,
    recordIds: null,
    principal: { type: 'system_job', id: systemPrincipalId },
  });
}
