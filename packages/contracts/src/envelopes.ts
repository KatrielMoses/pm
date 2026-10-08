import { ERROR_CODES, ID_PREFIXES, type ErrorCode } from './generated/registry.ts';
import { isPublicId } from './ids.ts';

export const API_VERSION = 'v1';

export interface ResponseMeta {
  request_id: string;
  correlation_id: string;
  api_version: string;
}

/** 0D success-envelope. `data.id` is always a public ID, never an internal key. */
export interface SuccessEnvelope<T extends { id: string; type: string }> {
  data: T;
  meta: ResponseMeta;
}

export interface ErrorIssue {
  pointer?: string;
  code: string;
  message: string;
}

export interface ErrorBody {
  code: ErrorCode;
  status: number;
  message: string;
  retryable: boolean;
  request_id: string;
  correlation_id: string;
  issues?: ErrorIssue[];
  retry_after_seconds?: number;
  operation_id?: string;
  step_up?: Record<string, unknown>;
  /** 0D §4.3 conflict payload (schema `conflict`). */
  conflict?: Record<string, unknown>;
}

/** 0D error-envelope. */
export interface ErrorEnvelope {
  error: ErrorBody;
}

type ErrorCodeEntry = (typeof ERROR_CODES)[number];
const BY_CODE: ReadonlyMap<string, ErrorCodeEntry> = new Map(ERROR_CODES.map((e) => [e.code, e]));

export function errorCodeEntry(code: ErrorCode): ErrorCodeEntry {
  const entry = BY_CODE.get(code);
  if (!entry) throw new Error(`unregistered error code: ${code}`);
  return entry;
}

export function meta(requestId: string, correlationId: string): ResponseMeta {
  return { request_id: requestId, correlation_id: correlationId, api_version: API_VERSION };
}

/**
 * Builds a registry-conformant error envelope. The message is always the registry's safe message
 * (localization arrives with 1E); callers cannot inject free text.
 */
export function errorEnvelope(
  code: ErrorCode,
  ids: { requestId: string; correlationId: string },
  extra: {
    issues?: ErrorIssue[];
    retryAfterSeconds?: number;
    operationId?: string;
    stepUp?: Record<string, unknown>;
    conflict?: Record<string, unknown>;
  } = {},
): ErrorEnvelope {
  const entry = errorCodeEntry(code);
  if (typeof entry.httpStatus !== 'number') {
    throw new Error(`error code ${code} is an outcome code, not an HTTP response`);
  }
  const body: ErrorBody = {
    code,
    status: entry.httpStatus,
    message: entry.safeMessage,
    retryable: entry.retryable,
    request_id: ids.requestId,
    correlation_id: ids.correlationId,
  };
  if (extra.issues?.length) body.issues = extra.issues;
  if (extra.retryAfterSeconds !== undefined) body.retry_after_seconds = extra.retryAfterSeconds;
  if (extra.operationId !== undefined) body.operation_id = extra.operationId;
  if (extra.stepUp !== undefined) body.step_up = extra.stepUp;
  if (extra.conflict !== undefined) body.conflict = extra.conflict;
  return { error: body };
}

export class EnvelopeError extends Error {
  constructor(reason: string) {
    super(`envelope rejected: ${reason}`);
    this.name = 'EnvelopeError';
  }
}

/**
 * 0D success-envelope for resources. `data.id` must be a valid public ID: internal keys and
 * missing IDs are rejected at construction time.
 */
export function successEnvelope<T extends { id: string; type: string }>(
  data: T,
  responseMeta: ResponseMeta,
): SuccessEnvelope<T> {
  if (!isPublicId(data.id)) throw new EnvelopeError('resource id must be a registered public ID');
  if (!/^[a-z_]+$/.test(data.type)) throw new EnvelopeError('resource type');
  return { data, meta: responseMeta };
}

/**
 * Closed set of **non-resource** response types (ADR-0007 D6, ADR-0008 B3): platform status and
 * authentication results/acknowledgements are not records and have no public ID, so they use the
 * success-envelope shape without `data.id`. They are not "platform singletons" and not resources.
 * Every ordinary resource must use `successEnvelope`, which requires a registered public ID; no
 * type here may equal a registered 0D resource type (checked below and by unit tests).
 */
export const NON_RESOURCE_TYPES = [
  'platform_status',
  'acknowledgement',
  'sign_in_result',
  'step_up_token',
  'recovery_code_set',
  'oauth_authorization',
  // 1F: the account's own security activity. Security events are internal records without public
  // IDs (0D security-event schema), so the display projection is not a resource collection.
  'security_activity',
  // 1C: the server-derived workspace/brand scope for the caller. A computed view over authorized
  // brands and a personal preference, not a record.
  'workspace_context',
  // 1D: computed views and command results that are not records.
  'access_explanation',
  'departure_plan',
  'permission_preview',
  'permission_change',
  'brand_access',
  'invitation_preview',
  'invitation_acceptance',
  'workspace_policy',
  'ownership_transfer_status',
  // 1E: personal navigation and preferences (hints about the caller, never records themselves).
  'preferences',
  'favorite',
  'recent_item',
  'view_state',
  'navigation_target',
  'shell_navigation',
  // 2A: the project overview is a computed composite of one project and its authorized structures.
  'project_overview',
  // 2C: computed workflow and field views (ADR-0015): a record's available transitions and one
  // transition's preview, a record's readable custom fields, formula previews and explanations, a
  // field-set upgrade preview, and the canonical field document and its round-trip check.
  'transition_options',
  'transition_preview',
  'record_fields',
  'formula_preview',
  'formula_explanation',
  'field_set_preview',
  'field_document',
  'field_document_check',
  // 2D: computed task interaction views (ADR-0016): task signals (one task or a page of tasks),
  // deterministic duplicate candidates, and a template application with its omissions report.
  'task_signals',
  'duplicate_candidates',
  'template_application',
  // 2D review 01: the statuses a bulk status change may offer for a selection.
  'bulk_status_options',
  // 2E: a deterministic capture parse (spans, values, ambiguities) and triage and merge previews.
  'capture_preview',
  'triage_preview',
  'merge_preview',
  'view_catalog',
  'view_default',
  'view_default_resolution',
  'view_field_options',
  'view_workload',
  'view_dependencies',
  'view_time',
  'view_milestones',
  'view_progress',
  'view_activity',
  // 3D: the live timer, one person's period, planned-versus-actual reports, and work summaries.
  'timer_status',
  'timesheet_period',
  'time_report',
  'time_summary',
  // 3C: Today, the day plan, and planned-versus-completed daily records.
  'today_view',
  'day_plan',
  'daily_records',
  'today_commitment',
  'daily_record',
  // 3E: working hours, capacity reads, and capacity-aware rescheduling inputs.
  'capacity_profile',
  'capacity',
  'team_capacity',
  'rescheduling_inputs',
  // 4A: a record's collaboration summary (follow state, comment count, capabilities, latest review).
  'collaboration_summary',
] as const;
export type NonResourceType = (typeof NON_RESOURCE_TYPES)[number];

const RESOURCE_TYPES: ReadonlySet<string> = new Set(ID_PREFIXES.map((p) => p.resource));

export interface NonResourceEnvelope<T extends Record<string, unknown>> {
  data: { type: NonResourceType } & T;
  meta: ResponseMeta;
}

export function nonResourceEnvelope<T extends Record<string, unknown>>(
  type: NonResourceType,
  data: T,
  responseMeta: ResponseMeta,
): NonResourceEnvelope<T> {
  if (!(NON_RESOURCE_TYPES as readonly string[]).includes(type) || RESOURCE_TYPES.has(type))
    throw new EnvelopeError('not a non-resource response type');
  if ('id' in data || 'type' in data)
    throw new EnvelopeError('non-resource responses carry no id and a fixed type');
  return { data: { type, ...data }, meta: responseMeta };
}
