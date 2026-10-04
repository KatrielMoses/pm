import type { ErrorIssue } from '@pm/contracts';

/** Registry error codes tenancy commands produce (0D §3). */
export type TenancyErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'precondition_required'
  | 'validation_failed'
  | 'idempotency_key_reuse'
  | 'idempotency_in_progress'
  | 'step_up_required'
  | 'workspace_read_only'
  | 'cursor_invalid'
  | 'unauthenticated'
  | 'rate_limited'
  | 'limit_exceeded';

/** Conflict payload (0D §4.3). `theirs` only for fields the caller can read now. */
export interface ConflictDetail {
  current_version: number;
  would_merge?: string[];
  fields?: Array<{ field: string; yours: unknown; theirs: unknown; theirs_readable: true }>;
}

/**
 * Typed tenancy failure. Unauthorized and nonexistent targets are the same `not_found` (0C AT-02):
 * nothing in the error says whether a workspace or brand exists.
 */
export class TenancyError extends Error {
  readonly code: TenancyErrorCode;
  readonly issues: ErrorIssue[];
  readonly conflict: ConflictDetail | undefined;
  readonly stepUp: Record<string, unknown> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: TenancyErrorCode,
    options: {
      issues?: ErrorIssue[];
      conflict?: ConflictDetail;
      stepUp?: Record<string, unknown>;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(`tenancy command failed: ${code}`);
    this.name = 'TenancyError';
    this.code = code;
    this.issues = options.issues ?? [];
    this.conflict = options.conflict;
    this.stepUp = options.stepUp;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const issue = (pointer: string, code: string, message: string): ErrorIssue => ({
  pointer,
  code,
  message,
});

export function invalid(...issues: ErrorIssue[]): TenancyError {
  return new TenancyError('validation_failed', { issues });
}
