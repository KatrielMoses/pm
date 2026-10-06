/** Same-origin JSON client: CSRF header, typed errors, idempotency keys, step-up continuation. */

export interface ApiIssue {
  pointer?: string;
  code: string;
  message: string;
}

export interface StepUpChallenge {
  id: string;
  action_key: string;
  methods: Array<'password' | 'totp' | 'recovery_code' | 'webauthn'>;
  expires_at: string;
  verify: string;
  cancel: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: ApiIssue[];
  readonly retryAfterSeconds: number | undefined;
  readonly stepUp: StepUpChallenge | undefined;
  readonly requestId: string | undefined;
  /** 0D §4.3 conflict payload (current version, mergeable and conflicting fields). */
  readonly conflict: ConflictPayload | undefined;

  constructor(init: {
    code: string;
    status: number;
    message: string;
    issues?: ApiIssue[];
    retryAfterSeconds?: number;
    stepUp?: StepUpChallenge;
    requestId?: string;
    conflict?: ConflictPayload;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.issues = init.issues ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.stepUp = init.stepUp;
    this.requestId = init.requestId;
    this.conflict = init.conflict;
  }

  get offline(): boolean {
    return this.code === 'offline';
  }
}

export interface ConflictPayload {
  current_version: number;
  would_merge?: string[];
  fields?: Array<{ field: string; yours: unknown; theirs?: unknown; theirs_readable: boolean }>;
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

let csrfToken: string | undefined;

export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

export async function api<T = unknown>(
  method: Method,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<{ status: number; body: T }> {
  if (!navigator.onLine)
    throw new ApiError({ code: 'offline', status: 0, message: "You're offline." });
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.signal ? { signal: options.signal } : {}),
      ...(method !== 'GET' ? { body: JSON.stringify(options.body ?? {}) } : {}),
    });
  } catch {
    // A superseded read (2D): the caller started a newer request and ignores this one.
    if (options.signal?.aborted)
      throw new ApiError({ code: 'aborted', status: 0, message: 'Superseded.' });
    throw new ApiError({
      code: navigator.onLine ? 'network' : 'offline',
      status: 0,
      message: 'Network error.',
    });
  }
  const token = res.headers.get('x-csrf-token');
  if (token) csrfToken = token;
  if (res.status === 204) return { status: 204, body: undefined as T };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError({
      code: 'service_unavailable',
      status: res.status,
      message: 'Unexpected response.',
    });
  }
  if (!res.ok) {
    const e = (json as { error?: Record<string, unknown> }).error ?? {};
    throw new ApiError({
      code: typeof e.code === 'string' ? e.code : 'internal_error',
      status: res.status,
      message: typeof e.message === 'string' ? e.message : 'Something went wrong.',
      issues: Array.isArray(e.issues) ? (e.issues as ApiIssue[]) : [],
      ...(typeof e.retry_after_seconds === 'number'
        ? { retryAfterSeconds: e.retry_after_seconds }
        : {}),
      ...(e.step_up ? { stepUp: e.step_up as StepUpChallenge } : {}),
      ...(typeof e.request_id === 'string' ? { requestId: e.request_id } : {}),
      ...(e.conflict ? { conflict: e.conflict as ConflictPayload } : {}),
    });
  }
  return { status: res.status, body: json as T };
}

export function clearCsrf(): void {
  csrfToken = undefined;
}

/** Resolves a step-up challenge (by showing the dialog) to a single-use token, or null if cancelled. */
export type StepUpResolver = (challenge: StepUpChallenge) => Promise<string | null>;

/**
 * A mutating request (0D §8, §11.2): one Idempotency-Key for the whole attempt. The first attempt
 * may answer `step_up_required`; after verification the same request is retried with the same key,
 * so the caller's form input is never lost and a retry never applies twice.
 */
export async function protectedRequest<T>(
  method: Exclude<Method, 'GET'>,
  path: string,
  body: unknown,
  resolveStepUp: StepUpResolver,
  options: { ifMatch?: number | undefined } = {},
): Promise<{ status: number; body: T; replayed: boolean; etag: string | null }> {
  const key = newIdempotencyKey();
  const headers: Record<string, string> = { 'idempotency-key': key };
  if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
  try {
    const r = await api<T>(method, path, { body, headers });
    return { ...r, replayed: false, etag: null };
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'step_up_required' || !err.stepUp) throw err;
    const token = await resolveStepUp(err.stepUp);
    if (!token) throw new ApiError({ code: 'cancelled', status: 0, message: 'Cancelled.' });
    const r = await api<T>(method, path, { body, headers: { ...headers, 'step-up': token } });
    return { ...r, replayed: false, etag: null };
  }
}

/** POST to a step-up protected action (kept for the 1B account flows). */
export async function protectedPost<T>(
  path: string,
  body: unknown,
  resolveStepUp: StepUpResolver,
): Promise<{ status: number; body: T; replayed: boolean }> {
  return protectedRequest<T>('POST', path, body, resolveStepUp);
}
