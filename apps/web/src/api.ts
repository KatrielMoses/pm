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

  constructor(init: {
    code: string;
    status: number;
    message: string;
    issues?: ApiIssue[];
    retryAfterSeconds?: number;
    stepUp?: StepUpChallenge;
    requestId?: string;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.issues = init.issues ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.stepUp = init.stepUp;
    this.requestId = init.requestId;
  }

  get offline(): boolean {
    return this.code === 'offline';
  }
}

let csrfToken: string | undefined;

export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

export async function api<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: T }> {
  if (!navigator.onLine)
    throw new ApiError({ code: 'offline', status: 0, message: "You're offline." });
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
    });
  } catch {
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
 * POST to a step-up protected action (0D §11.2): the first attempt may answer `step_up_required`;
 * after verification the same request is retried automatically with the same Idempotency-Key, so
 * the caller's form input is never lost.
 */
export async function protectedPost<T>(
  path: string,
  body: unknown,
  resolveStepUp: StepUpResolver,
): Promise<{ status: number; body: T; replayed: boolean }> {
  const key = newIdempotencyKey();
  try {
    const r = await api<T>('POST', path, { body, headers: { 'idempotency-key': key } });
    return { ...r, replayed: false };
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'step_up_required' || !err.stepUp) throw err;
    const token = await resolveStepUp(err.stepUp);
    if (!token) throw new ApiError({ code: 'cancelled', status: 0, message: 'Cancelled.' });
    const r = await api<T>('POST', path, {
      body,
      headers: { 'idempotency-key': key, 'step-up': token },
    });
    return { ...r, replayed: false };
  }
}
