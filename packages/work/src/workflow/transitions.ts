import { createHash } from 'node:crypto';
import type { WorkspaceTransaction } from '@pm/db';
import {
  issue,
  type BrandFacts,
  type Caller,
  type ProjectChain,
  type ShareLevel,
} from '@pm/tenancy';
import { canonical } from './serialization.ts';
import {
  TERMINAL,
  type RecordKind,
  type StatusRef,
  type TransitionRef,
  type WorkflowRef,
} from './statuses.ts';
export type { StatusRef, WorkflowRef } from './statuses.ts';

/**
 * The one transition evaluator (ADR-0015 W4–W8). Preview, apply, a generic status edit, Complete,
 * Cancel, and Reopen all call `evaluateTransition`, so preview equals enforcement. It decides the
 * edge (registered transitions, or the default rules when a workflow has none), the required
 * fields on the final merged record, and the confirmation and approval the change needs. It never
 * mutates; callers apply under the record lock after a clean evaluation.
 */

export type Intent = 'edit' | 'complete' | 'reopen' | 'apply';
type Issue = ReturnType<typeof issue>;

export interface Requirement {
  kind: 'builtin' | 'custom';
  key: string;
  definitionId: string | null;
  allowOverride: boolean;
}
export interface Presence {
  /** Present on the final merged record. */
  present: boolean;
  /** The actor cannot read the field (it is never named to them). */
  hidden: boolean;
  /** Error pointer and label for a visible field. */
  pointer: string;
  label: string;
}

export interface Evaluation {
  allowed: boolean;
  from: StatusRef;
  to: StatusRef;
  transition: TransitionRef | null;
  issues: Issue[];
  required: Array<{ pointer: string; label: string; satisfied: boolean; overridable: boolean }>;
  hiddenRequirementUnmet: boolean;
  overrideUsed: boolean;
  confirmation: 'none' | 'confirm' | 'step_up';
  approval: {
    policy: 'none' | 'one_manager' | 'all_named_approvers';
    approvers: string[];
    allowSelf: boolean;
  };
  semantics: 'edit' | 'complete' | 'cancel' | 'reopen';
}

/** Default rules (WFL-001), also the frame for registered transitions. */
function semanticsOf(from: StatusRef, to: StatusRef): Evaluation['semantics'] {
  if (TERMINAL.has(from.category)) return 'reopen';
  if (to.category === 'done') return 'complete';
  if (to.category === 'cancelled') return 'cancel';
  return 'edit';
}

export function evaluateTransition(input: {
  kind: RecordKind;
  wf: WorkflowRef | null;
  from: StatusRef;
  to: StatusRef;
  intent: Intent;
  presence: (r: Requirement) => Presence;
  canManage: boolean;
  overrideReason: string | null;
}): Evaluation {
  const { wf, from, to, intent } = input;
  const issues: Issue[] = [];
  const semantics = semanticsOf(from, to);
  const base: Evaluation = {
    allowed: false,
    from,
    to,
    transition: null,
    issues,
    required: [],
    hiddenRequirementUnmet: false,
    overrideUsed: false,
    confirmation: 'none',
    approval: { policy: 'none', approvers: [], allowSelf: false },
    semantics,
  };
  const refuse = (code: string, message: string) => {
    issues.push(issue('/status', code, message));
    return base;
  };
  if (from.id === to.id) return refuse('unchanged', 'The record already has this status.');
  if (TERMINAL.has(from.category) && TERMINAL.has(to.category))
    return refuse(
      'transition_not_allowed',
      'Reopen the record before choosing another final status.',
    );
  // The commands keep their meaning: a generic edit never completes or reopens.
  // Tasks have Complete and Reopen commands; a project's status edit is its explicit command.
  if (intent === 'edit' && semantics === 'reopen' && input.kind === 'task')
    return refuse('use_reopen', 'Reopen the task to change its status.');
  if (intent === 'edit' && semantics === 'complete' && input.kind === 'task')
    return refuse('use_complete', 'Use Complete to finish the task.');
  if (intent === 'complete' && semantics !== 'complete')
    return refuse('transition_not_allowed', 'Choose a done status.');
  if (intent === 'reopen' && semantics !== 'reopen')
    return refuse('transition_not_allowed', 'Only a finished record can be reopened.');
  let tr: TransitionRef | null = null;
  if (wf && wf.transitions.length) {
    tr = wf.transitions.find((t) => t.from === from.id && t.to === to.id) ?? null;
    if (!tr)
      return refuse(
        'transition_not_allowed',
        `This workflow does not allow ${from.name} → ${to.name}.`,
      );
  }
  base.transition = tr;
  if (tr) {
    base.confirmation = tr.confirmation;
    base.approval = { policy: tr.approval, approvers: tr.approvers, allowSelf: tr.allowSelf };
    for (const r of tr.requirements) {
      const p = input.presence(r);
      if (p.present) {
        if (!p.hidden)
          base.required.push({
            pointer: p.pointer,
            label: p.label,
            satisfied: true,
            overridable: r.allowOverride,
          });
        continue;
      }
      if (r.allowOverride && input.canManage && input.overrideReason) {
        base.overrideUsed = true;
        if (!p.hidden)
          base.required.push({
            pointer: p.pointer,
            label: p.label,
            satisfied: false,
            overridable: true,
          });
        continue;
      }
      if (p.hidden) {
        base.hiddenRequirementUnmet = true;
        continue;
      }
      base.required.push({
        pointer: p.pointer,
        label: p.label,
        satisfied: false,
        overridable: r.allowOverride && input.canManage,
      });
      issues.push(
        issue(p.pointer, 'required', `${p.label} is required for ${from.name} → ${to.name}.`),
      );
    }
    if (base.hiddenRequirementUnmet)
      issues.push(
        issue(
          '/status',
          'requirements_unmet',
          'This change needs information you cannot provide. Ask someone with access.',
        ),
      );
  }
  base.allowed = issues.length === 0;
  return base;
}

/** Evaluation view for previews (no hidden field is named). */
export function evaluationView(e: Evaluation, statusView: (s: StatusRef) => unknown) {
  return {
    from: statusView(e.from),
    to: statusView(e.to),
    transition: e.transition?.publicId ?? null,
    allowed: e.allowed,
    before_category: e.from.category,
    after_category: e.to.category,
    required_fields: e.required,
    confirmation: e.confirmation,
    approval: { policy: e.approval.policy, required: e.approval.policy !== 'none' },
    issues: e.issues,
  };
}

// -----------------------------------------------------------------------------------------------
// Approvals (immutable facts; state derived)
// -----------------------------------------------------------------------------------------------

export type ApprovalState =
  'pending' | 'approved' | 'rejected' | 'stale' | 'expired' | 'applied' | 'withdrawn';

/** The proposal a request or a preview is bound to (any change makes it stale). */
export function proposalFingerprint(p: {
  record: string;
  recordVersion: number;
  transition: string | null;
  transitionVersion: number | null;
  to: string;
  workflowVersion: number | null;
  changes?: unknown;
}): string {
  return createHash('sha256').update(canonical(p)).digest('hex');
}

export interface ApprovalRow {
  id: string;
  public_id: string;
  transition_id: string;
  transition_version: number | string;
  record_id: string;
  record_type: string;
  record_version: number | string;
  fingerprint: string;
  requester_membership_id: string;
  policy: string;
  approver_membership_ids: string[];
  allow_self_approval: boolean;
  expires_at: Date;
  created_at: Date;
  closed_at: Date | null;
  closed_reason: string | null;
}

export async function decisionsOf(tx: WorkspaceTransaction, requestIds: string[]) {
  if (!requestIds.length) return [];
  return tx.db
    .selectFrom('workflow.approval_decision')
    .select(['approval_request_id', 'approver_membership_id', 'decision', 'decided_at'])
    .where('approval_request_id', 'in', requestIds)
    .orderBy('decided_at')
    .execute();
}

/**
 * The state of a request given its decisions, the record's current version, the transition's
 * current version, and the time. `eligible(m)` says whether a decider counts toward the policy
 * now (a person who lost access or eligibility no longer counts).
 */
export function approvalState(
  r: ApprovalRow,
  decisions: Array<{ approver_membership_id: string; decision: string }>,
  current: { recordVersion: number; transitionVersion: number | null; now: Date },
  eligible: (membershipId: string) => boolean,
): ApprovalState {
  if (r.closed_reason === 'applied') return 'applied';
  if (r.closed_reason === 'withdrawn') return 'withdrawn';
  if (
    Number(r.record_version) !== current.recordVersion ||
    current.transitionVersion !== Number(r.transition_version)
  )
    return 'stale';
  if (current.now >= r.expires_at) return 'expired';
  const counted = decisions.filter((d) => eligible(d.approver_membership_id));
  if (counted.some((d) => d.decision === 'reject')) return 'rejected';
  const approved = new Set(
    counted.filter((d) => d.decision === 'approve').map((d) => d.approver_membership_id),
  );
  if (r.policy === 'one_manager') return approved.size >= 1 ? 'approved' : 'pending';
  return r.approver_membership_ids.every((m) => approved.has(m)) ? 'approved' : 'pending';
}

/** Everything the workflow layer needs to evaluate and authorize one status change. */
export interface StatusGate {
  kind: RecordKind;
  record: {
    id: string;
    publicId: string;
    version: number;
    brandId: string;
    projectId: string | null;
  };
  /** Decision facts for the record (brand, lifecycle, share level, project chain). */
  facts: {
    brand: BrandFacts;
    lifecycleState: 'active' | 'archived' | 'trashed' | 'purged';
    shareLevel: ShareLevel | null;
    projectChain?: ProjectChain | null;
  };
  wf: WorkflowRef | null;
  from: StatusRef;
  to: StatusRef;
  intent: Intent;
  /** The final merged built-in fields after this command's changes. */
  merged: Record<string, unknown>;
  counts?: { assignees: number; labels: number };
  overrideReason?: string | null;
  /** Only the transition apply command carries a preview fingerprint or an approval request. */
  apply?: { previewToken?: unknown; approval?: unknown } | null;
  /** A verified single-use step-up for the `step_up` confirmation tier (or a challenge). */
  stepUp?: () => Promise<unknown>;
  /** The command's caller (audit and outbox context). */
  caller?: Caller;
}
