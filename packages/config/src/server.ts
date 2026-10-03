import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Secret, SECRET_REFERENCE_PREFIX } from './secret.ts';

export const APP_ENVS = ['local', 'test', 'preview', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Environments that host shared, deployed infrastructure and get the strict rules. */
const DEPLOYED_ENVS: ReadonlySet<AppEnv> = new Set(['preview', 'staging', 'production']);

export const SERVICES = ['api', 'worker', 'migrate', 'restore'] as const;
export type Service = (typeof SERVICES)[number];

/** Database identities from 0C §12.3. Each process uses only the identities it needs. */
export const DB_IDENTITIES = {
  app: { envVar: 'DATABASE_APP_URL', role: 'app_rw' },
  worker: { envVar: 'DATABASE_WORKER_URL', role: 'app_worker' },
  dispatcher: { envVar: 'DATABASE_DISPATCHER_URL', role: 'dispatcher' },
  migrator: { envVar: 'DATABASE_MIGRATOR_URL', role: 'migrator' },
  restore: { envVar: 'DATABASE_RESTORE_URL', role: 'restore_operator' },
} as const;
export type DbIdentity = keyof typeof DB_IDENTITIES;

const IDENTITIES_BY_SERVICE: Record<Service, readonly DbIdentity[]> = {
  api: ['app'],
  worker: ['worker', 'dispatcher'],
  migrate: ['migrator'],
  restore: ['restore'],
};

export interface DbConnectionConfig {
  identity: DbIdentity;
  /** Expected login role; startup verifies `current_user` matches. */
  role: string;
  url: Secret;
  host: string;
  port: number;
  database: string;
}

export interface ServerConfig {
  env: AppEnv;
  service: Service;
  build: { version: string; id: string };
  http: {
    host: string;
    port: number;
    trustProxy: boolean;
    bodyLimitBytes: number;
    publicBaseUrl: string | undefined;
    webDistDir: string | undefined;
  };
  log: { level: 'debug' | 'info' | 'warn' | 'error' };
  telemetry: {
    otlpEndpoint: string | undefined;
    traceSampleRatio: number;
  };
  database: {
    connections: Partial<Record<DbIdentity, DbConnectionConfig>>;
    poolMax: number;
    /** Named DB parameters (implementation values, not promises). */
    statementTimeoutMs: number;
    lockTimeoutMs: number;
    idleInTransactionTimeoutMs: number;
    connectTimeoutMs: number;
  };
  /** 0D named parameters owned by 1A (values are configuration, not promises). */
  jobs: {
    leaseDurationMs: number; // JOB_LEASE_DURATION
    heartbeatIntervalMs: number; // JOB_HEARTBEAT_INTERVAL
    backoffBaseMs: number; // JOB_BACKOFF_BASE
    backoffCapMs: number; // JOB_BACKOFF_CAP
    maxAttempts: number; // JOB_MAX_ATTEMPTS
    timeoutMs: number; // JOB_TIMEOUT
    workspaceConcurrencyCap: number; // WORKSPACE_CONCURRENCY_CAP (value owned by 11C)
    pollIntervalMs: number;
    claimBatchSize: number;
    shutdownGraceMs: number;
  };
  retention: {
    idempotencyMs: number; // IDEMPOTENCY_RETENTION
    outboxReplayWindowMs: number; // OUTBOX_REPLAY_WINDOW
  };
  readiness: {
    requireDispatcher: boolean;
    dispatcherStaleMs: number;
  };
  secrets: { provider: 'env' };
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    // Issues name variables and rules only; they never echo values.
    super(`invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Conservative defaults for local/test only. Deployed environments must set every value. */
const DEFAULTS = {
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: '3000',
  HTTP_TRUST_PROXY: 'false',
  HTTP_BODY_LIMIT_BYTES: '1048576',
  LOG_LEVEL: 'info',
  TRACE_SAMPLE_RATIO: '1',
  DB_POOL_MAX: '10',
  DB_STATEMENT_TIMEOUT_MS: '15000',
  DB_LOCK_TIMEOUT_MS: '5000',
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '30000',
  DB_CONNECT_TIMEOUT_MS: '5000',
  JOB_LEASE_DURATION_MS: '30000',
  JOB_HEARTBEAT_INTERVAL_MS: '9000',
  JOB_BACKOFF_BASE_MS: '1000',
  JOB_BACKOFF_CAP_MS: '300000',
  JOB_MAX_ATTEMPTS: '5',
  JOB_TIMEOUT_MS: '60000',
  WORKSPACE_CONCURRENCY_CAP: '2',
  WORKER_POLL_INTERVAL_MS: '1000',
  WORKER_CLAIM_BATCH_SIZE: '10',
  WORKER_SHUTDOWN_GRACE_MS: '20000',
  IDEMPOTENCY_RETENTION_MS: '259200000',
  OUTBOX_REPLAY_WINDOW_MS: '3600000',
  READINESS_REQUIRE_DISPATCHER: 'true',
  READINESS_DISPATCHER_STALE_MS: '30000',
  SECRET_PROVIDER: 'env',
} as const;

const schema = z.object({
  APP_ENV: z.enum(APP_ENVS),
  BUILD_VERSION: z
    .string()
    .regex(/^[0-9A-Za-z.+-]{1,32}$/)
    .default('0.0.0-dev'),
  BUILD_ID: z
    .string()
    .regex(/^[0-9A-Za-z.-]{1,40}$/)
    .default('dev'),
  HTTP_HOST: z.string().min(1),
  HTTP_PORT: int(1, 65535),
  HTTP_TRUST_PROXY: bool,
  HTTP_BODY_LIMIT_BYTES: int(1024, 50 * 1024 * 1024),
  PUBLIC_BASE_URL: z.url().optional(),
  WEB_DIST_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1),
  DB_POOL_MAX: int(1, 200),
  DB_STATEMENT_TIMEOUT_MS: int(100, 600_000),
  DB_LOCK_TIMEOUT_MS: int(50, 600_000),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: int(100, 3_600_000),
  DB_CONNECT_TIMEOUT_MS: int(100, 120_000),
  JOB_LEASE_DURATION_MS: int(1000, 3_600_000),
  JOB_HEARTBEAT_INTERVAL_MS: int(100, 1_200_000),
  JOB_BACKOFF_BASE_MS: int(1, 3_600_000),
  JOB_BACKOFF_CAP_MS: int(1, 86_400_000),
  JOB_MAX_ATTEMPTS: int(1, 100),
  JOB_TIMEOUT_MS: int(100, 86_400_000),
  WORKSPACE_CONCURRENCY_CAP: int(1, 1000),
  WORKER_POLL_INTERVAL_MS: int(10, 60_000),
  WORKER_CLAIM_BATCH_SIZE: int(1, 500),
  WORKER_SHUTDOWN_GRACE_MS: int(0, 600_000),
  IDEMPOTENCY_RETENTION_MS: int(60_000, 365 * 86_400_000),
  OUTBOX_REPLAY_WINDOW_MS: int(1000, 30 * 86_400_000),
  READINESS_REQUIRE_DISPATCHER: bool,
  READINESS_DISPATCHER_STALE_MS: int(1000, 3_600_000),
  SECRET_PROVIDER: z.enum(['env']),
});

/** Variables a deployed environment must set explicitly (no silent local defaults). */
const REQUIRED_WHEN_DEPLOYED = [
  'BUILD_VERSION',
  'BUILD_ID',
  'HTTP_HOST',
  'HTTP_PORT',
  'HTTP_TRUST_PROXY',
  'PUBLIC_BASE_URL',
  'LOG_LEVEL',
  'TRACE_SAMPLE_RATIO',
] as const;

/** Values that indicate a development credential leaked into a deployed environment. */
const UNSAFE_PASSWORDS =
  /^(|password|postgres|changeme|secret|admin|dev|local|test)$|local|dev_only|example/i;

function parseDbUrl(
  identity: DbIdentity,
  raw: string,
  env: AppEnv,
  issues: string[],
): DbConnectionConfig | undefined {
  const { envVar, role } = DB_IDENTITIES[identity];
  if (raw.startsWith(SECRET_REFERENCE_PREFIX)) {
    issues.push(
      `${envVar}: secret references require a secret-store provider (not selected; DQ-28)`,
    );
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    issues.push(`${envVar}: not a valid URL`);
    return undefined;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    issues.push(`${envVar}: must use the postgres:// scheme`);
    return undefined;
  }
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (user !== role) issues.push(`${envVar}: must authenticate as role ${role}`);
  if (!database) issues.push(`${envVar}: database name is required`);
  if (DEPLOYED_ENVS.has(env)) {
    if (!new RegExp(`^pm_${env}(_[a-z0-9]{1,40})?$`).test(database)) {
      issues.push(
        `${envVar}: database name must belong to the ${env} namespace (pm_${env}[_suffix])`,
      );
    }
    const sslmode = url.searchParams.get('sslmode');
    if (sslmode === null || sslmode === 'disable' || sslmode === 'allow' || sslmode === 'prefer') {
      issues.push(`${envVar}: TLS is required (sslmode=require or verify-full)`);
    }
    const password = decodeURIComponent(url.password);
    if (password.length < 16 || UNSAFE_PASSWORDS.test(password)) {
      issues.push(`${envVar}: credential is missing, too short, or a known development value`);
    }
  }
  return {
    identity,
    role,
    url: new Secret(raw),
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database,
  };
}

export interface LoadOptions {
  service: Service;
  /** Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Directory searched for `.env` (local only). Defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Loads `.env` into process.env only for APP_ENV=local. CI and deployments must inject variables;
 * a `.env` file is never read there even if present.
 */
export function loadLocalDotEnv(cwd: string = process.cwd()): boolean {
  if (process.env.APP_ENV !== 'local') return false;
  const file = resolve(cwd, '.env');
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

export function loadServerConfig(options: LoadOptions): ServerConfig {
  const source = options.env ?? process.env;
  const issues: string[] = [];
  const appEnv = source.APP_ENV;
  const deployed = appEnv !== undefined && DEPLOYED_ENVS.has(appEnv as AppEnv);

  if (deployed) {
    for (const key of REQUIRED_WHEN_DEPLOYED) {
      if (source[key] === undefined || source[key] === '')
        issues.push(`${key}: required in ${appEnv}`);
    }
  }

  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = source[key];
    input[key] =
      value === undefined || value === ''
        ? deployed
          ? undefined
          : (DEFAULTS as Record<string, string | undefined>)[key]
        : value;
  }
  // Deployed environments still get the conservative operational defaults that are not listed as
  // required (timeouts, job parameters); they are named parameters, not promises.
  if (deployed) {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (
        input[key] === undefined &&
        !(REQUIRED_WHEN_DEPLOYED as readonly string[]).includes(key)
      ) {
        input[key] = value;
      }
    }
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join('.') || 'config'}: ${issue.message}`);
    }
    throw new ConfigError(dedupe(issues));
  }
  const c = parsed.data;
  const env = c.APP_ENV;

  if (c.JOB_HEARTBEAT_INTERVAL_MS * 3 >= c.JOB_LEASE_DURATION_MS) {
    issues.push(
      'JOB_HEARTBEAT_INTERVAL_MS: must be less than a third of JOB_LEASE_DURATION_MS (0D §7.3)',
    );
  }
  if (c.JOB_BACKOFF_CAP_MS < c.JOB_BACKOFF_BASE_MS) {
    issues.push('JOB_BACKOFF_CAP_MS: must be at least JOB_BACKOFF_BASE_MS');
  }
  if (deployed) {
    if (c.PUBLIC_BASE_URL !== undefined && !c.PUBLIC_BASE_URL.startsWith('https://')) {
      issues.push('PUBLIC_BASE_URL: must use https in deployed environments');
    }
    if (c.BUILD_ID === 'dev' || c.BUILD_VERSION.endsWith('-dev')) {
      issues.push('BUILD_ID/BUILD_VERSION: development build identifiers are not allowed');
    }
  }
  if (env === 'production' && c.LOG_LEVEL === 'debug') {
    issues.push('LOG_LEVEL: debug is not allowed in production');
  }

  const connections: Partial<Record<DbIdentity, DbConnectionConfig>> = {};
  for (const identity of IDENTITIES_BY_SERVICE[options.service]) {
    const { envVar } = DB_IDENTITIES[identity];
    const raw = source[envVar];
    if (raw === undefined || raw === '') {
      issues.push(`${envVar}: required for the ${options.service} process`);
      continue;
    }
    const conn = parseDbUrl(identity, raw, env, issues);
    if (conn) connections[identity] = conn;
  }
  // Application processes must never hold operational identities.
  if (options.service === 'api' || options.service === 'worker') {
    for (const forbidden of ['migrator', 'restore'] as const) {
      const { envVar } = DB_IDENTITIES[forbidden];
      if (source[envVar] !== undefined && source[envVar] !== '' && deployed) {
        issues.push(`${envVar}: must not be provided to the ${options.service} process`);
      }
    }
  }
  const targets = new Set(
    Object.values(connections).map((x) => `${x.host}:${x.port}/${x.database}`),
  );
  if (targets.size > 1) {
    issues.push('database URLs: all identities of one process must target the same database');
  }

  if (issues.length > 0) throw new ConfigError(dedupe(issues));

  return {
    env,
    service: options.service,
    build: { version: c.BUILD_VERSION, id: c.BUILD_ID },
    http: {
      host: c.HTTP_HOST,
      port: c.HTTP_PORT,
      trustProxy: c.HTTP_TRUST_PROXY,
      bodyLimitBytes: c.HTTP_BODY_LIMIT_BYTES,
      publicBaseUrl: c.PUBLIC_BASE_URL,
      webDistDir: c.WEB_DIST_DIR,
    },
    log: { level: c.LOG_LEVEL },
    telemetry: {
      otlpEndpoint: c.OTEL_EXPORTER_OTLP_ENDPOINT,
      traceSampleRatio: c.TRACE_SAMPLE_RATIO,
    },
    database: {
      connections,
      poolMax: c.DB_POOL_MAX,
      statementTimeoutMs: c.DB_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: c.DB_LOCK_TIMEOUT_MS,
      idleInTransactionTimeoutMs: c.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      connectTimeoutMs: c.DB_CONNECT_TIMEOUT_MS,
    },
    jobs: {
      leaseDurationMs: c.JOB_LEASE_DURATION_MS,
      heartbeatIntervalMs: c.JOB_HEARTBEAT_INTERVAL_MS,
      backoffBaseMs: c.JOB_BACKOFF_BASE_MS,
      backoffCapMs: c.JOB_BACKOFF_CAP_MS,
      maxAttempts: c.JOB_MAX_ATTEMPTS,
      timeoutMs: c.JOB_TIMEOUT_MS,
      workspaceConcurrencyCap: c.WORKSPACE_CONCURRENCY_CAP,
      pollIntervalMs: c.WORKER_POLL_INTERVAL_MS,
      claimBatchSize: c.WORKER_CLAIM_BATCH_SIZE,
      shutdownGraceMs: c.WORKER_SHUTDOWN_GRACE_MS,
    },
    retention: {
      idempotencyMs: c.IDEMPOTENCY_RETENTION_MS,
      outboxReplayWindowMs: c.OUTBOX_REPLAY_WINDOW_MS,
    },
    readiness: {
      requireDispatcher: c.READINESS_REQUIRE_DISPATCHER,
      dispatcherStaleMs: c.READINESS_DISPATCHER_STALE_MS,
    },
    secrets: { provider: c.SECRET_PROVIDER },
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Configuration dump safe for logs and diagnostics: secrets render as `[REDACTED]`. */
export function describeConfig(config: ServerConfig): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}
