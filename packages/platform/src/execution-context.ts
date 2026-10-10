import {
  isUuidV7,
  traceIdToUuid,
  uuidToTraceId,
  type DataClass,
  type ExecutionContext,
  type PrincipalType,
  type RiskClass,
} from '@pm/contracts';
import type { ContextColumns } from '@pm/db';

export class ExecutionContextError extends Error {
  constructor(reason: string) {
    super(`invalid execution context: ${reason}`);
    this.name = 'ExecutionContextError';
  }
}

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export function validateExecutionContext(ctx: ExecutionContext): void {
  if (ctx.workspaceId !== null && !isUuidV7(ctx.workspaceId))
    throw new ExecutionContextError('workspace_id');
  if (!/^[0-9a-f]{32}$/.test(ctx.correlationId)) throw new ExecutionContextError('correlation_id');
  for (const p of [ctx.authenticatedPrincipal, ctx.effectivePrincipal]) {
    if (!isUuidV7(p.id)) throw new ExecutionContextError('principal');
  }
  if (ctx.delegationChain.length < 1) throw new ExecutionContextError('delegation_chain');
  if (ctx.traceparent !== undefined && !TRACEPARENT.test(ctx.traceparent))
    throw new ExecutionContextError('traceparent');
  if (ctx.epochs.workspace < 0 || ctx.epochs.principal < 0)
    throw new ExecutionContextError('epochs');
}

/** Typed columns persisted with operations and jobs (0B PC-01 execution-context columns). */
export type ContextInsert = {
  [K in keyof ContextColumns]: K extends 'delegation_chain' | 'selected_scope'
    ? string
    : ContextColumns[K];
};

export function contextColumns(ctx: ExecutionContext): ContextInsert {
  validateExecutionContext(ctx);
  return {
    authenticated_principal_type: ctx.authenticatedPrincipal.type,
    authenticated_principal_id: ctx.authenticatedPrincipal.id,
    effective_principal_type: ctx.effectivePrincipal.type,
    effective_principal_id: ctx.effectivePrincipal.id,
    initiating_membership_id: ctx.initiatingMembershipId ?? null,
    delegation_chain: JSON.stringify(ctx.delegationChain),
    selected_scope: JSON.stringify(ctx.selectedScope ?? {}),
    workspace_epoch_at_enqueue: ctx.epochs.workspace,
    principal_epoch_at_enqueue: ctx.epochs.principal,
    agent_class_epoch_at_enqueue: ctx.epochs.agentClass ?? null,
    risk_action_key: ctx.risk?.actionKey ?? null,
    risk_class: ctx.risk?.riskClass ?? null,
    approval_class: ctx.risk?.approvalClass ?? null,
    approval_id: ctx.risk?.approvalId ?? null,
    step_up_id: ctx.risk?.stepUpId ?? null,
    data_class_limit: ctx.dataClassLimit,
    locale: ctx.locale ?? null,
    timezone: ctx.timezone ?? null,
    request_id: ctx.requestId ?? null,
    traceparent: ctx.traceparent ?? null,
    correlation_id: traceIdToUuid(ctx.correlationId),
    causation_id: ctx.causationId ?? null,
  };
}

type ContextRow = {
  workspace_id: string | null;
  authenticated_principal_type: string;
  authenticated_principal_id: string;
  effective_principal_type: string;
  effective_principal_id: string;
  initiating_membership_id: string | null;
  delegation_chain: unknown[];
  selected_scope: Record<string, unknown>;
  workspace_epoch_at_enqueue: number;
  principal_epoch_at_enqueue: number;
  agent_class_epoch_at_enqueue: number | null;
  risk_action_key: string | null;
  risk_class: RiskClass | null;
  approval_class: string | null;
  approval_id: string | null;
  step_up_id: string | null;
  data_class_limit: DataClass;
  locale: string | null;
  timezone: string | null;
  request_id: string | null;
  traceparent: string | null;
  correlation_id: string;
  causation_id: string | null;
};

/** Rebuilds the execution context from a job row's durable fields (0C §12.4 step 2). */
export function contextFromRow(row: ContextRow): ExecutionContext {
  const ctx: ExecutionContext = {
    workspaceId: row.workspace_id,
    correlationId: uuidToTraceId(row.correlation_id),
    authenticatedPrincipal: {
      type: row.authenticated_principal_type as PrincipalType,
      id: row.authenticated_principal_id,
    },
    effectivePrincipal: {
      type: row.effective_principal_type as PrincipalType,
      id: row.effective_principal_id,
    },
    delegationChain: row.delegation_chain as ExecutionContext['delegationChain'],
    selectedScope: row.selected_scope as NonNullable<ExecutionContext['selectedScope']>,
    epochs: {
      workspace: row.workspace_epoch_at_enqueue,
      principal: row.principal_epoch_at_enqueue,
      ...(row.agent_class_epoch_at_enqueue !== null
        ? { agentClass: row.agent_class_epoch_at_enqueue }
        : {}),
    },
    dataClassLimit: row.data_class_limit,
  };
  if (row.request_id) ctx.requestId = row.request_id;
  if (row.traceparent) ctx.traceparent = row.traceparent;
  if (row.causation_id) ctx.causationId = row.causation_id;
  if (row.initiating_membership_id) ctx.initiatingMembershipId = row.initiating_membership_id;
  if (row.locale) ctx.locale = row.locale;
  if (row.timezone) ctx.timezone = row.timezone;
  if (row.risk_action_key && row.risk_class) {
    ctx.risk = {
      actionKey: row.risk_action_key,
      riskClass: row.risk_class,
      ...(row.approval_class ? { approvalClass: row.approval_class } : {}),
      ...(row.approval_id ? { approvalId: row.approval_id } : {}),
      ...(row.step_up_id ? { stepUpId: row.step_up_id } : {}),
    };
  }
  return ctx;
}
