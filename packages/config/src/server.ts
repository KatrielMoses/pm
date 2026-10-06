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
  identity: IdentityConfig;
  lifecycle: LifecycleConfig;
  audit: {
    /**
     * Operational warning threshold for waiting on a workspace audit-chain lock
     * (AUDIT_CHAIN_LOCK_WAIT_WARN_MS). Not a product promise; see docs/engineering/audit.md.
     */
    chainLockWaitWarnMs: number;
  };
  /** Collaboration (1D). Operational defaults from the 0D named parameters, not product promises. */
  tenancy: {
    /** INVITATION_LIFETIME */
    invitationLifetimeMs: number;
    /** OWNERSHIP_TRANSFER_LIFETIME */
    ownershipTransferLifetimeMs: number;
    /** PRINCIPAL_CONTEXT_ARRAY_MAX: above this, visibility arrays move to a temporary table. */
    principalContextArrayMax: number;
  };
  /** Personal navigation (1E). Operational defaults from the 0D named parameters. */
  views: {
    /** FAVORITES_MAX */
    favoritesMax: number;
    /** RECENT_ITEMS_MAX */
    recentItemsMax: number;
    /** RECENT_VISIT_COALESCE */
    recentVisitCoalesceMs: number;
    /** VIEW_STATE_MAX_BYTES */
    viewStateMaxBytes: number;
    /** VIEW_STATE_TTL */
    viewStateTtlMs: number;
  };
  /** Projects (2A). Bounds from the 0D named parameters (PL-22). */
  work: {
    /** PROJECT_DEPTH_MAX (root = 0); never above the database invariant ceiling of 32. */
    projectDepthMax: number;
    /** TEMPLATE_ITEMS_MAX; never above the database bound of 500. */
    templateItemsMax: number;
    /** RECURRENCE_CATCHUP_MAX: occurrences per series per run. */
    recurrenceCatchupMax: number;
    /** RECURRENCE_WORKSPACE_DISCOVERY_MAX: workspaces per recurrence job run. */
    recurrenceWorkspaceDiscoveryMax: number;
    /** RECURRENCE_SERIES_DISCOVERY_MAX: due series per workspace per run. */
    recurrenceSeriesDiscoveryMax: number;
    /** Task bounds (0D PL-24). TASK_DEPTH_MAX never exceeds the database ceiling of 64. */
    taskDepthMax: number;
    taskSubtreeMax: number;
    taskItemsMax: number;
    taskAssigneesMax: number;
    taskLabelsMax: number;
    brandLabelsMax: number;
    taskEstimateMinutesMax: number;
    /** PAGE_LIMIT_DEFAULT / PAGE_LIMIT_MAX (schema cap 200). */
    pageLimitDefault: number;
    pageLimitMax: number;
    /** Workflow and custom-field bounds (0D PL-25). */
    workflowStatusesMax: number;
    workflowTransitionsMax: number;
    transitionRequirementsMax: number;
    transitionApproversMax: number;
    approvalExpiryHours: number;
    transitionPreviewTtlSeconds: number;
    fieldDefinitionsMax: number;
    fieldOptionsMax: number;
    fieldSetsMax: number;
    fieldSetItemsMax: number;
    fieldTextMax: number;
    fieldPatternMax: number;
    formulaSourceMax: number;
    formulaAstNodesMax: number;
    formulaDepthMax: number;
    formulaRefsMax: number;
    fieldValueBulkMax: number;
    taskStaleActiveDays: number;
    taskStalePlannedDays: number;
    taskRescheduleCount: number;
    taskRescheduleWindowDays: number;
    taskRemindersMax: number;
    reminderFireBatchMax: number;
    taskSnoozeMaxDays: number;
    bulkItemsMax: number;
    bulkPreviewTtlSeconds: number;
    undoWindowSeconds: number;
    duplicateWindowDays: number;
    duplicateCandidatesMax: number;
    captureTextMax: number;
    capturePasteLinesMax: number;
    captureLinksMax: number;
    captureFilesMax: number;
    captureParseTokensMax: number;
    captureRatePerMinute: number;
    triageBatchMax: number;
    inboxMergeMax: number;
    intakeFormsMax: number;
    intakeSubmissionsPerHour: number;
  };
  features: {
    /** Local/test-only component harness route for reusable UI states (refused when deployed). */
    componentHarness: boolean;
  };
}

/** Retention classes (0B vocabulary) that may carry a platform default period. */
export const RETENTION_CLASSES = [
  'R-LIVE',
  'R-EVIDENCE',
  'R-AUDIT',
  'R-EXEC',
  'R-PERSONAL',
  'R-BILLING',
  'R-DERIVED',
  'R-EPHEMERAL',
  'R-PLATFORM',
] as const;
export type RetentionClassKey = (typeof RETENTION_CLASSES)[number];

/**
 * Lifecycle settings (1F). Retention periods are product-owner decisions: unset means "not
 * decided" and every dependent purge does nothing. No duration is defaulted here.
 */
export interface LifecycleConfig {
  /** Platform default period per retention class in ms; absent = undecided (purge disabled). */
  retentionPeriodsMs: Readonly<Partial<Record<RetentionClassKey, number>>>;
  /** Purge ledger outside the database backup set. `local` is a development adapter. */
  purgeLedger: 'local' | 'none';
  purgeLedgerDir: string | undefined;
}

/** Identity and session settings (1B). Lifetimes and limits are operational defaults, not promises. */
export interface IdentityConfig {
  /** Origin used in email links and for the CSRF origin check. */
  publicOrigin: string;
  /** Origins accepted on state-changing requests (the public origin plus local dev origins). */
  allowedOrigins: readonly string[];
  /** Secure cookies; false only for explicit local/test HTTP. */
  cookieSecure: boolean;
  /** HMAC key: CSRF tokens and privacy-preserving rate-limit keys (domain-separated). */
  signingKey: Secret | undefined;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  sessionTouchMs: number;
  /** Ended sessions and their minimized device/network context are deleted after this. */
  sessionRetentionMs: number;
  emailVerificationTokenMs: number;
  passwordResetTokenMs: number;
  signInContinuationMs: number;
  oauthStateMs: number;
  resendCooldownMs: number;
  stepUpChallengeMs: number; // STEP_UP_CHALLENGE_LIFETIME
  stepUpWindowMs: number; // STEP_UP_WINDOW
  stepUpMaxAttempts: number;
  argon2: { memoryKiB: number; passes: number; parallelism: number; maxConcurrency: number };
  /** Minimum response time for enumeration-sensitive endpoints (bounded timing class). */
  responseFloorMs: number;
  /** RATE_LIMIT_POLICIES overrides (0D named parameter); code defaults otherwise. */
  rateLimitOverrides: Readonly<Record<string, { limit: number; windowMs: number }>>;
  legal: { termsVersion: string; privacyVersion: string };
  oauthProviders: readonly string[];
  botProtection: 'none' | 'test';
  mailTransport: 'capture' | 'none';
  mailCaptureDir: string | undefined;
  mailFrom: string;
  mailRetentionMs: number;
  vault: 'dev-database' | 'none';
  devVaultKey: Secret | undefined;
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
  COOKIE_SECURE: 'true',
  SESSION_IDLE_TIMEOUT_MS: String(3 * 86_400_000),
  SESSION_ABSOLUTE_TIMEOUT_MS: String(30 * 86_400_000),
  SESSION_TOUCH_INTERVAL_MS: '60000',
  SESSION_RETENTION_MS: String(30 * 86_400_000),
  EMAIL_VERIFICATION_TOKEN_MS: String(86_400_000),
  PASSWORD_RESET_TOKEN_MS: String(30 * 60_000),
  SIGN_IN_CONTINUATION_MS: String(5 * 60_000),
  OAUTH_STATE_MS: String(10 * 60_000),
  RESEND_COOLDOWN_MS: '60000',
  STEP_UP_CHALLENGE_LIFETIME_MS: String(5 * 60_000),
  STEP_UP_WINDOW_MS: String(5 * 60_000),
  STEP_UP_MAX_ATTEMPTS: '5',
  ARGON2_MEMORY_KIB: '65536',
  ARGON2_PASSES: '3',
  ARGON2_PARALLELISM: '1',
  ARGON2_MAX_CONCURRENCY: '4',
  AUTH_RESPONSE_FLOOR_MS: '400',
  LEGAL_TERMS_VERSION: 'terms-draft-1',
  LEGAL_PRIVACY_VERSION: 'privacy-draft-1',
  OAUTH_PROVIDERS: '',
  BOT_PROTECTION: 'none',
  MAIL_TRANSPORT: 'none',
  MAIL_FROM: 'PM <no-reply@localhost>',
  MAIL_RETENTION_MS: String(7 * 86_400_000),
  SECRET_VAULT: 'none',
  PURGE_LEDGER: 'none',
  COMPONENT_HARNESS: 'false',
  AUDIT_CHAIN_LOCK_WAIT_WARN_MS: '250',
  INVITATION_LIFETIME_MS: String(7 * 86_400_000),
  OWNERSHIP_TRANSFER_LIFETIME_MS: String(3 * 86_400_000),
  PRINCIPAL_CONTEXT_ARRAY_MAX: '10000',
  FAVORITES_MAX: '200',
  RECENT_ITEMS_MAX: '50',
  RECENT_VISIT_COALESCE_MS: '30000',
  VIEW_STATE_MAX_BYTES: '8192',
  VIEW_STATE_TTL_MS: String(90 * 86_400_000),
  PROJECT_DEPTH_MAX: '10',
  TEMPLATE_ITEMS_MAX: '500',
  RECURRENCE_CATCHUP_MAX: '12',
  RECURRENCE_WORKSPACE_DISCOVERY_MAX: '200',
  RECURRENCE_SERIES_DISCOVERY_MAX: '50',
  TASK_DEPTH_MAX: '20',
  TASK_SUBTREE_MAX: '500',
  TASK_ITEMS_MAX: '200',
  TASK_ASSIGNEES_MAX: '20',
  TASK_LABELS_MAX: '50',
  BRAND_LABELS_MAX: '1000',
  TASK_ESTIMATE_MINUTES_MAX: '100000',
  PAGE_LIMIT_DEFAULT: '50',
  PAGE_LIMIT_MAX: '200',
  WORKFLOW_STATUSES_MAX: '50',
  WORKFLOW_TRANSITIONS_MAX: '400',
  TRANSITION_REQUIREMENTS_MAX: '30',
  TRANSITION_APPROVERS_MAX: '10',
  APPROVAL_EXPIRY_HOURS: '168',
  TRANSITION_PREVIEW_TTL_SECONDS: '600',
  FIELD_DEFINITIONS_MAX: '200',
  FIELD_OPTIONS_MAX: '200',
  FIELD_SETS_MAX: '100',
  FIELD_SET_ITEMS_MAX: '100',
  FIELD_TEXT_MAX: '5000',
  FIELD_PATTERN_MAX: '200',
  FORMULA_SOURCE_MAX: '2000',
  FORMULA_AST_NODES_MAX: '200',
  FORMULA_DEPTH_MAX: '8',
  FORMULA_REFS_MAX: '20',
  FIELD_VALUE_BULK_MAX: '500',
  TASK_STALE_ACTIVE_DAYS: '7',
  TASK_STALE_PLANNED_DAYS: '14',
  TASK_RESCHEDULE_COUNT: '3',
  TASK_RESCHEDULE_WINDOW_DAYS: '14',
  TASK_REMINDERS_MAX: '10',
  REMINDER_FIRE_BATCH_MAX: '500',
  TASK_SNOOZE_MAX_DAYS: '365',
  BULK_ITEMS_MAX: '200',
  BULK_PREVIEW_TTL_SECONDS: '600',
  UNDO_WINDOW_SECONDS: '30',
  DUPLICATE_WINDOW_DAYS: '90',
  DUPLICATE_CANDIDATES_MAX: '5',
  CAPTURE_TEXT_MAX: '10000',
  CAPTURE_PASTE_LINES_MAX: '100',
  CAPTURE_LINKS_MAX: '10',
  CAPTURE_FILES_MAX: '10',
  CAPTURE_PARSE_TOKENS_MAX: '64',
  CAPTURE_RATE_PER_MINUTE: '60',
  TRIAGE_BATCH_MAX: '50',
  INBOX_MERGE_MAX: '20',
  INTAKE_FORMS_MAX: '50',
  INTAKE_SUBMISSIONS_PER_HOUR: '20',
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
  COOKIE_SECURE: bool,
  AUTH_SIGNING_KEY: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  SESSION_IDLE_TIMEOUT_MS: int(60_000, 90 * 86_400_000),
  SESSION_ABSOLUTE_TIMEOUT_MS: int(60_000, 400 * 86_400_000),
  SESSION_TOUCH_INTERVAL_MS: int(1000, 3_600_000),
  SESSION_RETENTION_MS: int(60_000, 400 * 86_400_000),
  EMAIL_VERIFICATION_TOKEN_MS: int(60_000, 7 * 86_400_000),
  PASSWORD_RESET_TOKEN_MS: int(60_000, 86_400_000),
  SIGN_IN_CONTINUATION_MS: int(30_000, 3_600_000),
  OAUTH_STATE_MS: int(30_000, 3_600_000),
  RESEND_COOLDOWN_MS: int(0, 3_600_000),
  STEP_UP_CHALLENGE_LIFETIME_MS: int(30_000, 3_600_000),
  STEP_UP_WINDOW_MS: int(10_000, 3_600_000),
  STEP_UP_MAX_ATTEMPTS: int(1, 20),
  ARGON2_MEMORY_KIB: int(19_456, 1_048_576),
  ARGON2_PASSES: int(1, 10),
  ARGON2_PARALLELISM: int(1, 16),
  ARGON2_MAX_CONCURRENCY: int(1, 64),
  AUTH_RESPONSE_FLOOR_MS: int(0, 5000),
  RATE_LIMIT_POLICIES: z.string().optional(),
  LEGAL_TERMS_VERSION: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
  LEGAL_PRIVACY_VERSION: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
  OAUTH_PROVIDERS: z.string().regex(/^([a-z][a-z0-9_]{1,31}(,[a-z][a-z0-9_]{1,31})*)?$/),
  BOT_PROTECTION: z.enum(['none', 'test']),
  MAIL_TRANSPORT: z.enum(['capture', 'none']),
  MAIL_CAPTURE_DIR: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(3).max(200),
  MAIL_RETENTION_MS: int(60_000, 90 * 86_400_000),
  SECRET_VAULT: z.enum(['dev-database', 'none']),
  DEV_VAULT_KEY: z.string().optional(),
  RETENTION_PERIODS: z.string().optional(),
  PURGE_LEDGER: z.enum(['local', 'none']),
  PURGE_LEDGER_DIR: z.string().min(1).optional(),
  COMPONENT_HARNESS: bool,
  AUDIT_CHAIN_LOCK_WAIT_WARN_MS: int(1, 600_000),
  INVITATION_LIFETIME_MS: int(60_000, 30 * 86_400_000),
  OWNERSHIP_TRANSFER_LIFETIME_MS: int(60_000, 30 * 86_400_000),
  PRINCIPAL_CONTEXT_ARRAY_MAX: int(1, 1_000_000),
  FAVORITES_MAX: int(1, 1000),
  RECENT_ITEMS_MAX: int(5, 200),
  RECENT_VISIT_COALESCE_MS: int(0, 3_600_000),
  VIEW_STATE_MAX_BYTES: int(1024, 16_384),
  VIEW_STATE_TTL_MS: int(86_400_000, 400 * 86_400_000),
  PROJECT_DEPTH_MAX: int(1, 32),
  TEMPLATE_ITEMS_MAX: int(1, 500),
  RECURRENCE_CATCHUP_MAX: int(1, 100),
  RECURRENCE_WORKSPACE_DISCOVERY_MAX: int(1, 1000),
  RECURRENCE_SERIES_DISCOVERY_MAX: int(1, 500),
  TASK_DEPTH_MAX: int(1, 64),
  TASK_SUBTREE_MAX: int(1, 5000),
  TASK_ITEMS_MAX: int(1, 1000),
  TASK_ASSIGNEES_MAX: int(1, 100),
  TASK_LABELS_MAX: int(1, 200),
  BRAND_LABELS_MAX: int(1, 10000),
  TASK_ESTIMATE_MINUTES_MAX: int(60, 1000000),
  PAGE_LIMIT_DEFAULT: int(1, 200),
  PAGE_LIMIT_MAX: int(1, 200),
  WORKFLOW_STATUSES_MAX: int(2, 200),
  WORKFLOW_TRANSITIONS_MAX: int(1, 2000),
  TRANSITION_REQUIREMENTS_MAX: int(1, 100),
  TRANSITION_APPROVERS_MAX: int(1, 50),
  APPROVAL_EXPIRY_HOURS: int(1, 2160),
  TRANSITION_PREVIEW_TTL_SECONDS: int(60, 3600),
  FIELD_DEFINITIONS_MAX: int(1, 1000),
  FIELD_OPTIONS_MAX: int(2, 1000),
  FIELD_SETS_MAX: int(1, 500),
  FIELD_SET_ITEMS_MAX: int(1, 500),
  FIELD_TEXT_MAX: int(1, 20000),
  FIELD_PATTERN_MAX: int(1, 1000),
  FORMULA_SOURCE_MAX: int(10, 10000),
  FORMULA_AST_NODES_MAX: int(10, 2000),
  FORMULA_DEPTH_MAX: int(1, 32),
  FORMULA_REFS_MAX: int(1, 100),
  FIELD_VALUE_BULK_MAX: int(1, 5000),
  TASK_STALE_ACTIVE_DAYS: int(1, 90),
  TASK_STALE_PLANNED_DAYS: int(1, 180),
  TASK_RESCHEDULE_COUNT: int(2, 20),
  TASK_RESCHEDULE_WINDOW_DAYS: int(1, 90),
  TASK_REMINDERS_MAX: int(1, 50),
  REMINDER_FIRE_BATCH_MAX: int(1, 5000),
  TASK_SNOOZE_MAX_DAYS: int(1, 3650),
  BULK_ITEMS_MAX: int(1, 1000),
  BULK_PREVIEW_TTL_SECONDS: int(60, 3600),
  UNDO_WINDOW_SECONDS: int(5, 300),
  DUPLICATE_WINDOW_DAYS: int(1, 365),
  DUPLICATE_CANDIDATES_MAX: int(1, 20),
  CAPTURE_TEXT_MAX: int(100, 50000),
  CAPTURE_PASTE_LINES_MAX: int(1, 500),
  CAPTURE_LINKS_MAX: int(0, 50),
  CAPTURE_FILES_MAX: int(0, 50),
  CAPTURE_PARSE_TOKENS_MAX: int(8, 256),
  CAPTURE_RATE_PER_MINUTE: int(1, 600),
  TRIAGE_BATCH_MAX: int(1, 200),
  INBOX_MERGE_MAX: int(2, 100),
  INTAKE_FORMS_MAX: int(1, 500),
  INTAKE_SUBMISSIONS_PER_HOUR: int(1, 1000),
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
  // Identity (1B) ------------------------------------------------------------------------------
  const devOnly = !deployed;
  const publicOrigin = (() => {
    const base =
      c.PUBLIC_BASE_URL ??
      (env === 'local' ? 'http://localhost:5173' : `http://127.0.0.1:${c.HTTP_PORT}`);
    return new URL(base).origin;
  })();
  const allowedOrigins = [publicOrigin];
  for (const o of (c.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    let origin: string;
    try {
      origin = new URL(o).origin;
    } catch {
      issues.push('ALLOWED_ORIGINS: entries must be absolute origins');
      continue;
    }
    if (deployed && !origin.startsWith('https://'))
      issues.push('ALLOWED_ORIGINS: https origins only in deployed environments');
    allowedOrigins.push(origin);
  }
  if (!c.COOKIE_SECURE && !devOnly)
    issues.push('COOKIE_SECURE: insecure cookies are allowed only in local and test');
  const keyBytes = (name: string, raw: string | undefined, needed: boolean): Secret | undefined => {
    if (raw === undefined || raw === '') {
      if (needed) issues.push(`${name}: required for the ${options.service} process`);
      return undefined;
    }
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.length < 32 || !/^[A-Za-z0-9_-]+$/.test(raw))
      issues.push(`${name}: must be base64url encoding of at least 32 random bytes`);
    return new Secret(raw);
  };
  const signingKey = keyBytes('AUTH_SIGNING_KEY', c.AUTH_SIGNING_KEY, options.service === 'api');
  if (c.SESSION_IDLE_TIMEOUT_MS > c.SESSION_ABSOLUTE_TIMEOUT_MS)
    issues.push('SESSION_IDLE_TIMEOUT_MS: must not exceed SESSION_ABSOLUTE_TIMEOUT_MS');
  if (c.SESSION_TOUCH_INTERVAL_MS * 2 > c.SESSION_IDLE_TIMEOUT_MS)
    issues.push('SESSION_TOUCH_INTERVAL_MS: must be well below SESSION_IDLE_TIMEOUT_MS');
  const oauthProviders = c.OAUTH_PROVIDERS ? c.OAUTH_PROVIDERS.split(',') : [];
  // Development-only adapters: never in preview/staging/production (no vendor is approved yet).
  if (deployed) {
    if (oauthProviders.includes('local'))
      issues.push(
        'OAUTH_PROVIDERS: the local test provider is not allowed in deployed environments',
      );
    if (c.MAIL_TRANSPORT === 'capture')
      issues.push(
        'MAIL_TRANSPORT: capture is a development transport; no production mail provider is approved',
      );
    if (c.SECRET_VAULT === 'dev-database')
      issues.push(
        'SECRET_VAULT: dev-database is a development store; no secret store/KMS is approved (DQ-28)',
      );
    if (c.BOT_PROTECTION === 'test')
      issues.push('BOT_PROTECTION: the test adapter is not allowed in deployed environments');
  }
  const identityServices: Service[] = ['api', 'worker'];
  if (identityServices.includes(options.service)) {
    if (c.SECRET_VAULT === 'none')
      issues.push(
        `SECRET_VAULT: a secret store is required for the ${options.service} process (identity secrets)`,
      );
    if (c.MAIL_TRANSPORT === 'none' && options.service === 'worker')
      issues.push('MAIL_TRANSPORT: a mail transport is required for the worker process');
  }
  const devVaultKey = keyBytes(
    'DEV_VAULT_KEY',
    c.DEV_VAULT_KEY,
    c.SECRET_VAULT === 'dev-database' && identityServices.includes(options.service),
  );
  let rateLimitOverrides: Record<string, { limit: number; windowMs: number }> = {};
  if (c.RATE_LIMIT_POLICIES) {
    try {
      const parsedPolicies = z
        .record(
          z.string().regex(/^[a-z_.]{1,64}$/),
          z.object({
            limit: z.number().int().min(1).max(1_000_000),
            windowMs: z.number().int().min(1000).max(86_400_000),
          }),
        )
        .parse(JSON.parse(c.RATE_LIMIT_POLICIES));
      rateLimitOverrides = parsedPolicies;
    } catch {
      issues.push('RATE_LIMIT_POLICIES: must be JSON {"policy": {"limit": n, "windowMs": n}}');
    }
  }

  let retentionPeriodsMs: Partial<Record<RetentionClassKey, number>> = {};
  if (c.RETENTION_PERIODS) {
    try {
      retentionPeriodsMs = z
        .partialRecord(
          z.enum(RETENTION_CLASSES),
          z
            .number()
            .int()
            .min(60_000)
            .max(100 * 366 * 86_400_000),
        )
        .parse(JSON.parse(c.RETENTION_PERIODS));
    } catch {
      issues.push('RETENTION_PERIODS: must be JSON {"<retention class>": <milliseconds>}');
    }
  }
  if (deployed && c.PURGE_LEDGER === 'local')
    issues.push(
      'PURGE_LEDGER: the local ledger is a development adapter; no ledger store is approved',
    );
  if (c.PURGE_LEDGER === 'local' && !c.PURGE_LEDGER_DIR)
    issues.push('PURGE_LEDGER_DIR: required with the local purge ledger');
  if (deployed && c.COMPONENT_HARNESS)
    issues.push('COMPONENT_HARNESS: the component harness is allowed only in local and test');

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
    lifecycle: {
      retentionPeriodsMs,
      purgeLedger: c.PURGE_LEDGER,
      purgeLedgerDir: c.PURGE_LEDGER_DIR,
    },
    features: { componentHarness: c.COMPONENT_HARNESS },
    audit: { chainLockWaitWarnMs: c.AUDIT_CHAIN_LOCK_WAIT_WARN_MS },
    tenancy: {
      invitationLifetimeMs: c.INVITATION_LIFETIME_MS,
      ownershipTransferLifetimeMs: c.OWNERSHIP_TRANSFER_LIFETIME_MS,
      principalContextArrayMax: c.PRINCIPAL_CONTEXT_ARRAY_MAX,
    },
    views: {
      favoritesMax: c.FAVORITES_MAX,
      recentItemsMax: c.RECENT_ITEMS_MAX,
      recentVisitCoalesceMs: c.RECENT_VISIT_COALESCE_MS,
      viewStateMaxBytes: c.VIEW_STATE_MAX_BYTES,
      viewStateTtlMs: c.VIEW_STATE_TTL_MS,
    },
    work: {
      projectDepthMax: c.PROJECT_DEPTH_MAX,
      templateItemsMax: c.TEMPLATE_ITEMS_MAX,
      recurrenceCatchupMax: c.RECURRENCE_CATCHUP_MAX,
      recurrenceWorkspaceDiscoveryMax: c.RECURRENCE_WORKSPACE_DISCOVERY_MAX,
      recurrenceSeriesDiscoveryMax: c.RECURRENCE_SERIES_DISCOVERY_MAX,
      taskDepthMax: c.TASK_DEPTH_MAX,
      taskSubtreeMax: c.TASK_SUBTREE_MAX,
      taskItemsMax: c.TASK_ITEMS_MAX,
      taskAssigneesMax: c.TASK_ASSIGNEES_MAX,
      taskLabelsMax: c.TASK_LABELS_MAX,
      brandLabelsMax: c.BRAND_LABELS_MAX,
      taskEstimateMinutesMax: c.TASK_ESTIMATE_MINUTES_MAX,
      pageLimitDefault: Math.min(c.PAGE_LIMIT_DEFAULT, c.PAGE_LIMIT_MAX),
      pageLimitMax: c.PAGE_LIMIT_MAX,
      workflowStatusesMax: c.WORKFLOW_STATUSES_MAX,
      workflowTransitionsMax: c.WORKFLOW_TRANSITIONS_MAX,
      transitionRequirementsMax: c.TRANSITION_REQUIREMENTS_MAX,
      transitionApproversMax: c.TRANSITION_APPROVERS_MAX,
      approvalExpiryHours: c.APPROVAL_EXPIRY_HOURS,
      transitionPreviewTtlSeconds: c.TRANSITION_PREVIEW_TTL_SECONDS,
      fieldDefinitionsMax: c.FIELD_DEFINITIONS_MAX,
      fieldOptionsMax: c.FIELD_OPTIONS_MAX,
      fieldSetsMax: c.FIELD_SETS_MAX,
      fieldSetItemsMax: c.FIELD_SET_ITEMS_MAX,
      fieldTextMax: c.FIELD_TEXT_MAX,
      fieldPatternMax: c.FIELD_PATTERN_MAX,
      formulaSourceMax: c.FORMULA_SOURCE_MAX,
      formulaAstNodesMax: c.FORMULA_AST_NODES_MAX,
      formulaDepthMax: c.FORMULA_DEPTH_MAX,
      formulaRefsMax: c.FORMULA_REFS_MAX,
      fieldValueBulkMax: c.FIELD_VALUE_BULK_MAX,
      taskStaleActiveDays: c.TASK_STALE_ACTIVE_DAYS,
      taskStalePlannedDays: c.TASK_STALE_PLANNED_DAYS,
      taskRescheduleCount: c.TASK_RESCHEDULE_COUNT,
      taskRescheduleWindowDays: c.TASK_RESCHEDULE_WINDOW_DAYS,
      taskRemindersMax: c.TASK_REMINDERS_MAX,
      reminderFireBatchMax: c.REMINDER_FIRE_BATCH_MAX,
      taskSnoozeMaxDays: c.TASK_SNOOZE_MAX_DAYS,
      bulkItemsMax: c.BULK_ITEMS_MAX,
      bulkPreviewTtlSeconds: c.BULK_PREVIEW_TTL_SECONDS,
      undoWindowSeconds: c.UNDO_WINDOW_SECONDS,
      duplicateWindowDays: c.DUPLICATE_WINDOW_DAYS,
      duplicateCandidatesMax: c.DUPLICATE_CANDIDATES_MAX,
      captureTextMax: c.CAPTURE_TEXT_MAX,
      capturePasteLinesMax: c.CAPTURE_PASTE_LINES_MAX,
      captureLinksMax: c.CAPTURE_LINKS_MAX,
      captureFilesMax: c.CAPTURE_FILES_MAX,
      captureParseTokensMax: c.CAPTURE_PARSE_TOKENS_MAX,
      captureRatePerMinute: c.CAPTURE_RATE_PER_MINUTE,
      triageBatchMax: c.TRIAGE_BATCH_MAX,
      inboxMergeMax: c.INBOX_MERGE_MAX,
      intakeFormsMax: c.INTAKE_FORMS_MAX,
      intakeSubmissionsPerHour: c.INTAKE_SUBMISSIONS_PER_HOUR,
    },
    identity: {
      publicOrigin,
      allowedOrigins,
      cookieSecure: c.COOKIE_SECURE,
      signingKey,
      sessionIdleMs: c.SESSION_IDLE_TIMEOUT_MS,
      sessionAbsoluteMs: c.SESSION_ABSOLUTE_TIMEOUT_MS,
      sessionTouchMs: c.SESSION_TOUCH_INTERVAL_MS,
      sessionRetentionMs: c.SESSION_RETENTION_MS,
      emailVerificationTokenMs: c.EMAIL_VERIFICATION_TOKEN_MS,
      passwordResetTokenMs: c.PASSWORD_RESET_TOKEN_MS,
      signInContinuationMs: c.SIGN_IN_CONTINUATION_MS,
      oauthStateMs: c.OAUTH_STATE_MS,
      resendCooldownMs: c.RESEND_COOLDOWN_MS,
      stepUpChallengeMs: c.STEP_UP_CHALLENGE_LIFETIME_MS,
      stepUpWindowMs: c.STEP_UP_WINDOW_MS,
      stepUpMaxAttempts: c.STEP_UP_MAX_ATTEMPTS,
      argon2: {
        memoryKiB: c.ARGON2_MEMORY_KIB,
        passes: c.ARGON2_PASSES,
        parallelism: c.ARGON2_PARALLELISM,
        maxConcurrency: c.ARGON2_MAX_CONCURRENCY,
      },
      responseFloorMs: c.AUTH_RESPONSE_FLOOR_MS,
      rateLimitOverrides,
      legal: { termsVersion: c.LEGAL_TERMS_VERSION, privacyVersion: c.LEGAL_PRIVACY_VERSION },
      oauthProviders,
      botProtection: c.BOT_PROTECTION,
      mailTransport: c.MAIL_TRANSPORT,
      mailCaptureDir: c.MAIL_CAPTURE_DIR,
      mailFrom: c.MAIL_FROM,
      mailRetentionMs: c.MAIL_RETENTION_MS,
      vault: c.SECRET_VAULT,
      devVaultKey,
    },
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Configuration dump safe for logs and diagnostics: secrets render as `[REDACTED]`. */
export function describeConfig(config: ServerConfig): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}
