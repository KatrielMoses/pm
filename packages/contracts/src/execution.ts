import type { ActorType, PrincipalType } from './generated/registry.ts';

// 0B execution entity vocabularies that are not part of the 0D registry.

/** 0B execution.job last_error_class / 0D job.schema last_error.class. */
export const JOB_ERROR_CLASSES = [
  'transient',
  'deterministic',
  'authorization',
  'policy',
  'worker_lost',
  'timeout',
] as const;
export type JobErrorClass = (typeof JOB_ERROR_CLASSES)[number];

/** 0B execution.external_effect state. */
export const EFFECT_STATES = [
  'pending',
  'sent',
  'unknown',
  'confirmed',
  'failed',
  'cancelled',
] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

/** 0B execution.external_effect destination_class / 0D §5.4. */
export const EFFECT_DESTINATION_CLASSES = [
  'idempotent_by_provider',
  'naturally_idempotent',
  'deduplicated_by_receiver',
  'unsafe',
] as const;
export type EffectDestinationClass = (typeof EFFECT_DESTINATION_CLASSES)[number];

/** 0B execution.idempotency_key state / 0D idempotency-record. */
export const IDEMPOTENCY_STATES = ['in_progress', 'completed', 'failed_deterministic'] as const;
export type IdempotencyState = (typeof IDEMPOTENCY_STATES)[number];

export const RISK_CLASSES = ['R0', 'R1', 'R2', 'R3', 'R4'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const DATA_CLASSES = ['C0', 'C1', 'C2', 'C3', 'C4'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export interface PrincipalRef {
  type: PrincipalType;
  /** Internal UUIDv7. */
  id: string;
}

/**
 * 0D execution-context (internal schema `urn:pm:schema:execution-context`).
 * Built server-side only (0D §2.2); never from request bodies (0C I-09).
 */
export interface ExecutionContext {
  workspaceId: string;
  requestId?: string;
  /** W3C trace id (32 hex). */
  correlationId: string;
  causationId?: string;
  traceparent?: string;
  authenticatedPrincipal: PrincipalRef;
  effectivePrincipal: PrincipalRef;
  initiatingMembershipId?: string;
  delegationChain: ReadonlyArray<{ type: string; id: string; scope_ref?: string }>;
  selectedScope?: {
    brand_ids?: string[];
    project_ids?: string[];
    record_ids?: string[];
    exclude_record_ids?: string[];
  };
  epochs: { workspace: number; principal: number; agentClass?: number };
  risk?: {
    actionKey: string;
    riskClass: RiskClass;
    approvalClass?: string;
    approvalId?: string;
    stepUpId?: string;
  };
  dataClassLimit: DataClass;
  locale?: string;
  timezone?: string;
  operationId?: string;
  attemptId?: string;
}

/** Actor recorded on rows and events (0B §2.5 standard columns). */
export interface ActorRef {
  type: ActorType;
  id?: string;
  onBehalfOfMembershipId?: string;
}

/** Serializes to the exact 0D execution-context JSON shape (snake_case). */
export function executionContextToContract(ctx: ExecutionContext): Record<string, unknown> {
  const out: Record<string, unknown> = {
    workspace_id: ctx.workspaceId,
    correlation_id: ctx.correlationId,
    authenticated_principal: { ...ctx.authenticatedPrincipal },
    effective_principal: { ...ctx.effectivePrincipal },
    delegation_chain: ctx.delegationChain.map((d) => ({ ...d })),
    epochs: {
      workspace: ctx.epochs.workspace,
      principal: ctx.epochs.principal,
      ...(ctx.epochs.agentClass !== undefined ? { agent_class: ctx.epochs.agentClass } : {}),
    },
    data_class_limit: ctx.dataClassLimit,
  };
  if (ctx.requestId !== undefined) out.request_id = ctx.requestId;
  if (ctx.causationId !== undefined) out.causation_id = ctx.causationId;
  if (ctx.traceparent !== undefined) out.traceparent = ctx.traceparent;
  if (ctx.initiatingMembershipId !== undefined)
    out.initiating_membership_id = ctx.initiatingMembershipId;
  if (ctx.selectedScope !== undefined) out.selected_scope = { ...ctx.selectedScope };
  if (ctx.risk !== undefined) {
    out.risk = {
      action_key: ctx.risk.actionKey,
      risk_class: ctx.risk.riskClass,
      ...(ctx.risk.approvalClass !== undefined ? { approval_class: ctx.risk.approvalClass } : {}),
      ...(ctx.risk.approvalId !== undefined ? { approval_id: ctx.risk.approvalId } : {}),
      ...(ctx.risk.stepUpId !== undefined ? { step_up_id: ctx.risk.stepUpId } : {}),
    };
  }
  if (ctx.locale !== undefined) out.locale = ctx.locale;
  if (ctx.timezone !== undefined) out.timezone = ctx.timezone;
  if (ctx.operationId !== undefined) out.operation_id = ctx.operationId;
  if (ctx.attemptId !== undefined) out.attempt_id = ctx.attemptId;
  return out;
}
