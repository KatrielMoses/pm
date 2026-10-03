import { ERROR_CODES, type ErrorCode } from './generated/registry.ts';
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
  extra: { issues?: ErrorIssue[]; retryAfterSeconds?: number; operationId?: string } = {},
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
 * Accepted platform-envelope specialization (1A review 01, D6): non-record platform singletons
 * (health/status) use the success-envelope shape without `data.id`. The allow-list is closed;
 * ordinary resources must use `successEnvelope`, which requires a public ID.
 */
export const PLATFORM_SINGLETON_TYPES = ['platform_status'] as const;
export type PlatformSingletonType = (typeof PLATFORM_SINGLETON_TYPES)[number];

export interface PlatformSingletonEnvelope<T extends Record<string, unknown>> {
  data: { type: PlatformSingletonType } & T;
  meta: ResponseMeta;
}

export function platformSingletonEnvelope<T extends Record<string, unknown>>(
  type: PlatformSingletonType,
  data: T,
  responseMeta: ResponseMeta,
): PlatformSingletonEnvelope<T> {
  if (!(PLATFORM_SINGLETON_TYPES as readonly string[]).includes(type))
    throw new EnvelopeError('not a platform singleton type');
  if ('id' in data || 'type' in data)
    throw new EnvelopeError('platform singletons carry no id and a fixed type');
  return { data: { type, ...data }, meta: responseMeta };
}
