import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { LogErrorReporter } from '@pm/observability';
import { WorkerRuntime } from '@pm/platform';
import {
  CaptureTransport,
  createIdentityService,
  createVault,
  currentStep,
  identityJobHandlers,
  IDENTITY_SCHEDULES,
  totpCode,
  type IdentityService,
  type LocalOAuthProvider,
  type MailMessage,
} from '@pm/identity';
import { createTenancyService } from '@pm/tenancy';
import { createHarness, type Harness } from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { buildApp } from '../../src/app.ts';

export const ORIGIN = 'http://127.0.0.1:3000';
export const PASSWORD = 'correct horse battery staple';

/** Generous limits for flow tests; rate-limit tests pass their own policies. */
const RELAXED_LIMITS = JSON.stringify(
  Object.fromEntries(
    [
      'register.source',
      'register.email',
      'sign_in.source',
      'sign_in.email',
      'resend.source',
      'resend.email',
      'recovery.source',
      'recovery.email',
      'token.source',
      'mfa.account',
      'step_up.account',
      'oauth.source',
    ].map((p) => [p, { limit: 10_000, windowMs: 60_000 }]),
  ),
);

export interface IdentityEnv {
  db: TestDatabase;
  h: Harness;
  app: FastifyInstance;
  identity: IdentityService;
  localOAuth: LocalOAuthProvider;
  transport: CaptureTransport;
  worker: WorkerRuntime;
  /** Runs the worker until queued mail is delivered; returns all captured messages. */
  deliverMail(): Promise<MailMessage[]>;
  close(): Promise<void>;
}

export async function identityEnv(overrides: Record<string, string> = {}): Promise<IdentityEnv> {
  const db = await createTestDatabase();
  const h = createHarness(db, { RATE_LIMIT_POLICIES: RELAXED_LIMITS, ...overrides });
  const { service, localOAuth } = createIdentityService({
    db: h.platform,
    config: h.config.identity,
    appName: 'PM',
    logger: h.logger,
    metrics: h.telemetry.metrics,
  });
  const transport = new CaptureTransport();
  const j = h.config.jobs;
  const worker = new WorkerRuntime({
    db: h.worker,
    platformDb: h.platformWorker,
    discovery: h.discovery,
    handlers: identityJobHandlers({
      db: h.platformWorker,
      config: h.config.identity,
      vault: createVault(h.config.identity),
      transport,
      appName: 'PM',
      logger: h.logger,
      metrics: h.telemetry.metrics,
    }),
    consumers: [],
    schedules: IDENTITY_SCHEDULES,
    params: {
      ...j,
      shutdownGraceMs: 200,
      outboxReplayWindowMs: h.config.retention.outboxReplayWindowMs,
      maintenanceIntervalMs: 3_600_000,
      statsIntervalMs: 3_600_000,
    },
    buildId: 'test',
    logger: h.logger,
    metrics: h.telemetry.metrics,
    tracer: h.telemetry.tracer,
    errors: new LogErrorReporter(h.logger),
  });
  await worker.start({ loop: false });
  const app = await buildApp({
    config: {
      env: 'test',
      build: { version: '0.1.0', id: 'test' },
      http: { ...h.config.http, trustProxy: true },
    },
    logger: h.logger,
    metrics: h.telemetry.metrics,
    tracer: h.telemetry.tracer,
    errors: new LogErrorReporter(h.logger),
    readiness: async () => ({
      ready: true,
      checks: {
        database: 'ok',
        migrations: 'ok',
        dispatcher: 'ok',
        object_storage: 'not_configured',
        recovery_gate: 'ok',
        tenant_isolation: 'ok',
      },
    }),
    auth: { identity: service, localOAuth },
    tenancy: {
      tenancy: createTenancyService({
        tenant: h.app,
        platform: h.platform,
        identity: service,
        config: h.config,
        logger: h.logger,
        metrics: h.telemetry.metrics,
      }),
    },
  });
  await app.ready();
  return {
    db,
    h,
    app,
    identity: service,
    localOAuth: localOAuth!,
    transport,
    worker,
    async deliverMail() {
      for (let i = 0; i < 5; i++) {
        const r = await worker.runCycle({ wait: true });
        if (r.claimed === 0) break;
      }
      return transport.messages;
    },
    async close() {
      await worker.stop();
      await app.close();
      await h.close();
      await db.drop();
    },
  };
}

/** Extracts the one-time token from a captured message link (URL fragment). */
export function tokenFrom(message: MailMessage | undefined): string {
  const m = /#token=([A-Za-z0-9_-]{43})/.exec(message?.text ?? '');
  if (!m) throw new Error('no token in message');
  return m[1]!;
}

export function mailTo(env: IdentityEnv, to: string, template?: string): MailMessage[] {
  return env.transport.messages.filter(
    (m) =>
      m.to.toLowerCase() === to.toLowerCase() &&
      (!template || m.subject.toLowerCase().includes(template)),
  );
}

export function totpNow(secret: string, offset = 0): string {
  return totpCode(secret, currentStep() + offset);
}

/**
 * A browser-like client: keeps cookies (honouring deletion), sends Origin on unsafe requests,
 * and echoes the CSRF token the server issues.
 */
export class Browser {
  readonly cookies = new Map<string, string>();
  csrf: string | undefined;
  origin = ORIGIN;
  ip = '203.0.113.10';
  userAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  readonly #app: FastifyInstance;

  constructor(app: FastifyInstance) {
    this.#app = app;
  }

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    opts: {
      body?: unknown;
      headers?: Record<string, string>;
      origin?: string | null;
      csrf?: string | null;
    } = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      'x-forwarded-for': this.ip,
      ...opts.headers,
    };
    if (this.cookies.size)
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') {
      const origin = opts.origin === undefined ? this.origin : opts.origin;
      if (origin) headers.origin = origin;
      const csrf = opts.csrf === undefined ? this.csrf : opts.csrf;
      if (csrf) headers['x-csrf-token'] = csrf;
    }
    const res = await this.#app.inject({
      method,
      url,
      headers,
      ...(method !== 'GET' ? { payload: (opts.body ?? {}) as object } : {}),
    });
    const setCookie = res.headers['set-cookie'];
    for (const c of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const [pair, ...attrs] = c.split(';');
      const [name, value] = [
        pair!.slice(0, pair!.indexOf('=')),
        pair!.slice(pair!.indexOf('=') + 1),
      ];
      if (attrs.some((a) => a.trim() === 'Max-Age=0') || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const csrf = res.headers['x-csrf-token'];
    if (typeof csrf === 'string') this.csrf = csrf;
    return res;
  }

  get(url: string, opts: { headers?: Record<string, string> } = {}) {
    return this.request('GET', url, opts);
  }

  post(
    url: string,
    body?: unknown,
    opts: { headers?: Record<string, string>; origin?: string | null; csrf?: string | null } = {},
  ) {
    return this.request('POST', url, { ...opts, body });
  }

  patch(url: string, body?: unknown, opts: { headers?: Record<string, string> } = {}) {
    return this.request('PATCH', url, { ...opts, body });
  }

  put(url: string, body?: unknown, opts: { headers?: Record<string, string> } = {}) {
    return this.request('PUT', url, { ...opts, body });
  }

  get session(): string | undefined {
    return this.cookies.get('pm_session');
  }
}

export async function registerAndVerify(
  env: IdentityEnv,
  b: Browser,
  email: string,
  name = 'Synthetic Person',
): Promise<void> {
  const cfg = env.identity.config.legal;
  const r = await b.post('/v1/auth/register', {
    email,
    password: PASSWORD,
    display_name: name,
    terms_version: cfg.termsVersion,
    privacy_version: cfg.privacyVersion,
    bot_proof: 'test-pass',
  });
  if (r.statusCode !== 202) throw new Error(`register failed ${r.statusCode} ${r.body}`);
  await env.deliverMail();
  const token = tokenFrom(mailTo(env, email, 'verify').at(-1));
  const v = await b.post('/v1/auth/email:verify', { token });
  if (v.statusCode !== 200) throw new Error(`verify failed ${v.statusCode} ${v.body}`);
}

export async function signIn(
  b: Browser,
  email: string,
  password = PASSWORD,
): Promise<LightMyRequestResponse> {
  return b.post('/v1/auth/sign-in', { email, password });
}

let keyCounter = 0;
export const idemKey = () => `test-key-${Date.now()}-${++keyCounter}-abcdef`;
