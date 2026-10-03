import type { ErrorIssue } from '@pm/contracts';
import type { AuthMethod, StepUpMethod } from '@pm/db';

/** Request facts the identity service may use. Minimized before storage (device.ts). */
export interface RequestMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
  /** W3C trace id. */
  correlationId: string;
  traceparent?: string | undefined;
}

export interface AccountView {
  id: string;
  publicId: string;
  email: string;
  displayName: string;
  locale: string;
  timezone: string;
  emailVerified: boolean;
}

export interface SessionView {
  id: string;
  publicId: string;
  assurance: 'single_factor' | 'multi_factor';
  authMethods: AuthMethod[];
  createdAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  mfaVerifiedAt: Date | null;
}

/**
 * The authenticated principal. Identity grants no tenant authority: there is deliberately no
 * workspace, membership, or role here (memberships arrive in 1C/1D).
 */
export interface AuthContext {
  principal: 'account';
  account: AccountView;
  session: SessionView;
}

/** A credential-bearing caller that is not a signed-in person (tokens, agents; later phases). */
export interface NonHumanPrincipal {
  principal: 'non_human';
  type: string;
}

export interface IssuedSession {
  /** Raw opaque token: set once in the cookie, never stored or logged. */
  token: string;
  session: SessionView;
}

export type TokenProblem = 'token_invalid' | 'token_expired' | 'token_used';

export interface StepUpChallengeView {
  id: string;
  type: 'step_up_challenge';
  action_key: string;
  methods: StepUpMethod[];
  expires_at: string;
  state: 'pending' | 'verified' | 'consumed' | 'expired' | 'cancelled';
  verify: string;
  cancel: string;
}

/** Step-up and idempotency inputs for protected account actions (0D §5.2, §11.2). */
export interface ProtectedRequest {
  idempotencyKey: string;
  fingerprint: Buffer;
  stepUpToken?: string | undefined;
}

export type IdentityErrorCode =
  | 'validation_failed'
  | 'rate_limited'
  | 'unauthenticated'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'step_up_required'
  | 'step_up_unavailable'
  | 'idempotency_key_reuse'
  | 'idempotency_in_progress'
  | 'precondition_required';

/** Typed failure carrying only registry codes and generic issue codes (no account facts). */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly issues: ErrorIssue[];
  readonly retryAfterSeconds: number | undefined;
  readonly challenge: StepUpChallengeView | undefined;

  constructor(
    code: IdentityErrorCode,
    options: {
      issues?: ErrorIssue[];
      retryAfterSeconds?: number;
      challenge?: StepUpChallengeView;
    } = {},
  ) {
    super(`identity: ${code}`);
    this.name = 'IdentityError';
    this.code = code;
    this.issues = options.issues ?? [];
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.challenge = options.challenge;
  }
}

export const issue = (pointer: string, code: string, message: string): ErrorIssue => ({
  pointer,
  code,
  message,
});

/** Account-level step-up actions (pending 0C registration; ADR-0008 B2). */
export const ACCOUNT_STEP_UP_ACTIONS = [
  'account.mfa_enroll',
  'account.mfa_disable',
  'account.recovery_codes_regenerate',
] as const;
export type AccountStepUpAction = (typeof ACCOUNT_STEP_UP_ACTIONS)[number];

/** Replay of an idempotent protected action: stored status and references only (PC-02). */
export interface ReplayResult {
  replayed: true;
  status: number;
}
