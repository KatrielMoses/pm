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
    queryConditionsMax: number;
    queryDepthMax: number;
    querySortsMax: number;
    queryValuesMax: number;
    queryGroupsMax: number;
    viewColumnsMax: number;
    savedViewsMax: number;
    viewPinsMax: number;
    exportRowsMax: number;
    totalCountCap: number;
    layoutItemsMax: number;
    workloadDaysMax: number;
    activityRecordsMax: number;
    availabilityWindowsMax: number;
    timeOffEntriesMax: number;
    brandHolidaysMax: number;
    capacityRangeDaysMax: number;
    capacityPeopleMax: number;
    timeEntryMaxHours: number;
    timeTimerMaxHours: number;
    timeReportRangeDaysMax: number;
    timeReportRowsMax: number;
    timeExportRowsMax: number;
    timeTimesheetEntriesMax: number;
    timeRunawayDiscoveryMax: number;
    timeRunawayBatchMax: number;
    todayItemsMax: number;
    todayListMax: number;
    upcomingDeadlineDays: number;
    workBlocksPerDayMax: number;
    workBlocksRangeDaysMax: number;
    blockSeriesMax: number;
    blockSeriesHorizonDays: number;
    dayCloseDiscoveryMax: number;
    dayCloseBatchMax: number;
    commentBodyMaxChars: number;
    commentEditWindowMinutes: number;
    commentMentionsMax: number;
    commentsPerRecordMax: number;
    commentRatePerMinute: number;
    commentRepliesInlineMax: number;
    followersListMax: number;
    reviewReviewersMax: number;
    notifyFanoutRecipientsMax: number;
    notifyDedupeWindowMinutes: number;
    notifyDeliveryBatchMax: number;
    notifyDeliveryMaxAttempts: number;
    notifyRetryBaseSeconds: number;
    notifyRetryMaxSeconds: number;
    notifyDigestItemsMax: number;
    notifyEmailPerHourMax: number;
    notifyRetentionDays: number;
    notifyPreferencesMax: number;
    notifyBrowserAckTtlMinutes: number;
    notifySearchQueryMax: number;
    notifyDiscoveryMax: number;
    notifyBulkStateMax: number;
    notifyDeadlinesBatchMax: number;
    notifyFactsMaxBytes: number;
    documentBodyMaxBytes: number;
    documentBlocksMax: number;
    documentBlockTextMaxChars: number;
    documentTableCellsMax: number;
    documentDepthMax: number;
    documentChildrenMax: number;
    documentTreeMax: number;
    documentVersionsMax: number;
    documentReferencesMax: number;
    documentSuggestionsOpenMax: number;
    documentExportPagesMax: number;
    documentExportMaxBytes: number;
    documentReviewHorizonDays: number;
    documentSaveRatePerMinute: number;
    liveEditingEnabled: number;
    liveSessionTtlSeconds: number;
    liveSessionsMax: number;
    liveSessionsPerMemberMax: number;
    liveOpsBatchMax: number;
    livePollWaitSeconds: number;
    liveOpLogMax: number;
    liveRatePerMinute: number;
    searchQueryMaxChars: number;
    searchTermsMax: number;
    searchPageSizeMax: number;
    searchResultsMax: number;
    searchCountMax: number;
    searchSnippetChars: number;
    searchBodyMaxChars: number;
    searchIndexBatchMax: number;
    searchIndexDiscoveryMax: number;
    searchIndexMaxAttempts: number;
    searchIndexBackoffSeconds: number;
    searchFailedRetryMinutes: number;
    searchRecentMax: number;
    searchRecentRetentionDays: number;
    searchRatePerMinute: number;
    metricsWindowDaysMax: number;
    metricsDefaultWindowDays: number;
    metricsDrillPageMax: number;
    metricsDrillResultsMax: number;
    metricsScopeTasksMax: number;
    metricsSampleMin: number;
    metricsRatePerMinute: number;
    metricsReconcileBatchMax: number;
    metricsReconcileDiscoveryMax: number;
    metricsReconcileIntervalMinutes: number;
    metricsReconcileLeaseSeconds: number;
    metricsReconcileMaxAttempts: number;
    metricsReconcileBackoffSeconds: number;
    goalsPerScopeMax: number;
    goalKeyResultsMax: number;
    goalLinksMax: number;
    goalUpdateStaleDays: number;
    goalCheckinRatePerMinute: number;
    portfoliosMax: number;
    portfolioProjectsMax: number;
    portfolioReadProjectsMax: number;
    goalsExportRowsMax: number;
    goalsRecalcBatchMax: number;
    goalsRecalcLeaseSeconds: number;
    goalsRecalcIntervalMinutes: number;
    goalsRecalcMaxAttempts: number;
    dashboardsPerScopeMax: number;
    dashboardPersonalMax: number;
    dashboardWidgetsMax: number;
    reportsPerScopeMax: number;
    reportRecipientsMax: number;
    reportSharesMax: number;
    reportExportRowsMax: number;
    reportEmailRowsMax: number;
    reportExportRatePerMinute: number;
    reportRunRetentionDays: number;
    reportBatchMax: number;
    reportLeaseSeconds: number;
    reportMaxAttempts: number;
    reportFreshnessMinutes: number;
    connectionsPerScopeMax: number;
    connectionScopesMax: number;
    syncBatchMax: number;
    syncMaxAttempts: number;
    syncBackoffSeconds: number;
    syncLeaseSeconds: number;
    syncHistoryRetentionDays: number;
    syncRatePerMinute: number;
    integrationLoopbackEnabled: boolean;
    googleCalendarLoopbackEnabled: boolean;
    calendarSyncPagesMax: number;
    calendarSyncPastDays: number;
    calendarSyncHorizonDays: number;
    calendarsPerConnectionMax: number;
    calendarOccurrencesMax: number;
    calendarEventsListMax: number;
    apiTokensPersonalMax: number;
    apiTokensServiceMax: number;
    apiReadRatePerMinute: number;
    apiWriteRatePerMinute: number;
    apiExportRatePerMinute: number;
    webhookSubscriptionsMax: number;
    webhookInboundMax: number;
    webhookMaxAttempts: number;
    webhookConcurrencyPerDestination: number;
    webhookBodyMaxBytes: number;
    webhookDeliveryRetentionDays: number;
    webhookEventTypesMax: number;
    webhookTimestampToleranceSeconds: number;
    webhookDisableThreshold: number;
    webhookResponseTimeoutMs: number;
    webhookSweepBatchMax: number;
    webhookAllowLoopback: boolean;
    mcpEnabled: boolean;
    mcpReadRatePerMinute: number;
    mcpWriteRatePerMinute: number;
    oauthClientsMax: number;
    mcpToolCallTimeoutMs: number;
    mcpToolResultMaxBytes: number;
    importRollbackPeriodMs: number;
    documentEmbedUrlMaxChars: number;
    signedUrlLifetimeSeconds: number;
    uploadSessionLifetimeSeconds: number;
    fileUploadMaxBytes: number;
    workspaceStorageQuotaBytes: number;
    fileCompareMaxBytes: number;
    fileScanMaxAttempts: number;
    fileVersionsMax: number;
    filesListMax: number;
    deliverablesPerTaskMax: number;
    fileDiscoveryMax: number;
    fileExpiryBatchMax: number;
  };
  /** Files (4E): provider-neutral object storage and malware scanning adapters. */
  files: {
    storage: FilesStorageConfig;
    scanner: FilesScannerConfig;
  };
  /** Calendar provider (6C, ADR-0037): truthfully `none` unless a deployment configures it. */
  calendar: CalendarProviderConfig;
  /** AI gateway (7A, ADR-0038): truthfully `none` unless configured; production stays disabled. */
  ai: AiConfig;
  features: {
    /** Local/test-only component harness route for reusable UI states (refused when deployed). */
    componentHarness: boolean;
  };
}

/** The Google Calendar OAuth client and endpoints; the secret never leaves `Secret`. */
export type CalendarProviderConfig =
  | { provider: 'none' }
  | {
      provider: 'google';
      clientId: string;
      clientSecret: Secret;
      redirectUri: string;
      authorizeUrl: string;
      tokenUrl: string;
      revokeUrl: string;
      apiBase: string;
      timeoutMs: number;
    };

/**
 * The AI provider transport (7A). `fixture` points the same Messages adapter at a deterministic
 * protocol fixture and is refused when deployed; `anthropic` is refused when deployed until a
 * secret store (DQ-28) and a provider/data-use approval (OD-41) exist.
 */
export type AiProviderTransportConfig =
  | { provider: 'none' }
  | {
      provider: 'fixture' | 'anthropic';
      baseUrl: string;
      apiKey: Secret | null;
      timeoutMs: number;
    };

export interface AiConfig {
  provider: AiProviderTransportConfig;
  /** Model keys explicitly approved for customer data (OD-41); empty means none is. */
  approvedModels: readonly string[];
  /** Workspace-provided keys (OD-46): designed and tested, switched off when deployed. */
  byokEnabled: boolean;
  /** Finite defaults for a workspace with no configured limits (never unlimited). */
  defaults: {
    monthlyAllowanceMicros: string;
    hardLimitMicros: string;
    inputTokenLimit: number;
    outputTokenLimit: number;
  };
  maxOutputTokens: number;
  maxAttempts: number;
  /** USAGE_WARNING_THRESHOLDS: basis points of the hard limit at which owners are told. */
  warningThresholdsBp: readonly number[];
  /** Technical content retention for AI history; null keeps it (OD-36 undecided). */
  historyRetentionDays: number | null;
  /** Provider stream bounds: retained output, one event, and the whole response. */
  stream: { outputMaxChars: number; eventMaxBytes: number; maxBytes: number };
  /** 7B retrieval bounds: sources sent per answer and characters sent per source. */
  retrieval: { sourcesMax: number; sourceChars: number };
  /** 7D change proposals: approval validity and the size bound of one proposal. */
  proposals: { approvalHours: number; changesMax: number };
  /** 7F: the transcription transport (absent or `none` means voice transcription is unavailable). */
  transcription?: TranscriptionTransportConfig;
  /** 7F: voice capture bounds (defaults apply when absent). */
  voice?: VoiceConfig;
}

/**
 * 7F transcription transport (ADR-0043 D3): only the deterministic fixture exists, and it is refused
 * when deployed. No live speech provider is configured until privacy, secret, entitlement, and
 * cost bounds are approved.
 */
export type TranscriptionTransportConfig =
  | { provider: 'none' }
  | { provider: 'fixture'; baseUrl: string; apiKey: Secret | null; timeoutMs: number };

/** 7F voice capture bounds: duration, bytes, formats, open uploads per person, and transcript size. */
export interface VoiceConfig {
  maxSeconds: number;
  maxBytes: number;
  formats: readonly ('audio/wav' | 'audio/webm' | 'audio/ogg')[];
  queueMax: number;
  uploadTtlSeconds: number;
  transcriptMaxChars: number;
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

/**
 * Object storage (4E). `none` disables uploads; `local` is a development adapter (filesystem
 * directory, URLs signed by the API) refused when deployed.
 */
export type FilesStorageConfig =
  | { provider: 'none' }
  | {
      provider: 's3';
      bucket: string;
      region: string;
      /** S3-compatible endpoint; undefined means AWS (`https://s3.<region>.amazonaws.com`). */
      endpoint: string | undefined;
      forcePathStyle: boolean;
      accessKeyId: string;
      secretAccessKey: Secret;
    }
  | {
      provider: 'local';
      dir: string;
      /** HMAC key for the API's signed storage URLs. */
      secret: Secret;
      /** Origin (plus optional path prefix) that signed URLs point at. */
      publicBaseUrl: string;
    };

/** Malware scanning (4E). `test-signature` is a development adapter refused when deployed. */
export type FilesScannerConfig =
  | { provider: 'none' }
  | { provider: 'clamav'; host: string; port: number; timeoutMs: number }
  | { provider: 'test-signature' };

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
  OBJECT_STORAGE: 'none',
  OBJECT_STORAGE_FORCE_PATH_STYLE: 'false',
  MALWARE_SCANNER: 'none',
  CLAMAV_PORT: '3310',
  CLAMAV_TIMEOUT_MS: '30000',
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
  QUERY_CONDITIONS_MAX: '40',
  QUERY_DEPTH_MAX: '3',
  QUERY_SORTS_MAX: '5',
  QUERY_VALUES_MAX: '100',
  QUERY_GROUPS_MAX: '200',
  VIEW_COLUMNS_MAX: '20',
  SAVED_VIEWS_MAX: '200',
  VIEW_PINS_MAX: '20',
  EXPORT_ROWS_MAX: '5000',
  TOTAL_COUNT_CAP: '10000',
  LAYOUT_ITEMS_MAX: '200',
  WORKLOAD_DAYS_MAX: '366',
  ACTIVITY_RECORDS_MAX: '500',
  AVAILABILITY_WINDOWS_MAX: '28',
  TIME_OFF_ENTRIES_MAX: '500',
  BRAND_HOLIDAYS_MAX: '1000',
  CAPACITY_RANGE_DAYS_MAX: '93',
  CAPACITY_PEOPLE_MAX: '100',
  TIME_ENTRY_MAX_HOURS: '24',
  TIME_TIMER_MAX_HOURS: '12',
  TIME_REPORT_RANGE_DAYS_MAX: '366',
  TIME_REPORT_ROWS_MAX: '500',
  TIME_EXPORT_ROWS_MAX: '10000',
  TIME_TIMESHEET_ENTRIES_MAX: '2000',
  TIME_RUNAWAY_DISCOVERY_MAX: '100',
  TIME_RUNAWAY_BATCH_MAX: '200',
  TODAY_ITEMS_MAX: '100',
  TODAY_LIST_MAX: '50',
  UPCOMING_DEADLINE_DAYS: '14',
  WORK_BLOCKS_PER_DAY_MAX: '50',
  WORK_BLOCKS_RANGE_DAYS_MAX: '42',
  BLOCK_SERIES_MAX: '50',
  BLOCK_SERIES_HORIZON_DAYS: '28',
  DAY_CLOSE_DISCOVERY_MAX: '100',
  DAY_CLOSE_BATCH_MAX: '200',
  COMMENT_BODY_MAX_CHARS: '10000',
  COMMENT_EDIT_WINDOW_MINUTES: '1440',
  COMMENT_MENTIONS_MAX: '20',
  COMMENTS_PER_RECORD_MAX: '5000',
  COMMENT_RATE_PER_MINUTE: '30',
  COMMENT_REPLIES_INLINE_MAX: '20',
  FOLLOWERS_LIST_MAX: '200',
  REVIEW_REVIEWERS_MAX: '10',
  NOTIFY_FANOUT_RECIPIENTS_MAX: '500',
  NOTIFY_DEDUPE_WINDOW_MINUTES: '60',
  NOTIFY_DELIVERY_BATCH_MAX: '100',
  NOTIFY_DELIVERY_MAX_ATTEMPTS: '6',
  NOTIFY_RETRY_BASE_SECONDS: '60',
  NOTIFY_RETRY_MAX_SECONDS: '3600',
  NOTIFY_DIGEST_ITEMS_MAX: '50',
  NOTIFY_EMAIL_PER_HOUR_MAX: '20',
  NOTIFY_RETENTION_DAYS: '365',
  NOTIFY_PREFERENCES_MAX: '200',
  NOTIFY_BROWSER_ACK_TTL_MINUTES: '30',
  NOTIFY_SEARCH_QUERY_MAX: '100',
  NOTIFY_DISCOVERY_MAX: '100',
  NOTIFY_BULK_STATE_MAX: '200',
  NOTIFY_DEADLINES_BATCH_MAX: '500',
  NOTIFY_FACTS_MAX_BYTES: '1024',
  DOCUMENT_BODY_MAX_BYTES: '262144',
  DOCUMENT_BLOCKS_MAX: '2000',
  DOCUMENT_BLOCK_TEXT_MAX_CHARS: '20000',
  DOCUMENT_TABLE_CELLS_MAX: '1000',
  DOCUMENT_DEPTH_MAX: '6',
  DOCUMENT_CHILDREN_MAX: '200',
  DOCUMENT_TREE_MAX: '1000',
  DOCUMENT_VERSIONS_MAX: '1000',
  DOCUMENT_REFERENCES_MAX: '500',
  DOCUMENT_SUGGESTIONS_OPEN_MAX: '100',
  DOCUMENT_EXPORT_PAGES_MAX: '100',
  DOCUMENT_EXPORT_MAX_BYTES: '5242880',
  DOCUMENT_REVIEW_HORIZON_DAYS: '730',
  DOCUMENT_SAVE_RATE_PER_MINUTE: '60',
  LIVE_EDITING_ENABLED: '1',
  LIVE_SESSION_TTL_SECONDS: '45',
  LIVE_SESSIONS_MAX: '20',
  LIVE_SESSIONS_PER_MEMBER_MAX: '5',
  LIVE_OPS_BATCH_MAX: '50',
  LIVE_POLL_WAIT_SECONDS: '20',
  LIVE_OP_LOG_MAX: '2000',
  LIVE_RATE_PER_MINUTE: '1200',
  SEARCH_QUERY_MAX_CHARS: '200',
  SEARCH_TERMS_MAX: '12',
  SEARCH_PAGE_SIZE_MAX: '50',
  SEARCH_RESULTS_MAX: '200',
  SEARCH_COUNT_MAX: '1000',
  SEARCH_SNIPPET_CHARS: '220',
  SEARCH_BODY_MAX_CHARS: '100000',
  SEARCH_INDEX_BATCH_MAX: '200',
  SEARCH_INDEX_DISCOVERY_MAX: '50',
  SEARCH_INDEX_MAX_ATTEMPTS: '5',
  SEARCH_INDEX_BACKOFF_SECONDS: '30',
  SEARCH_FAILED_RETRY_MINUTES: '360',
  SEARCH_RECENT_MAX: '25',
  SEARCH_RECENT_RETENTION_DAYS: '90',
  SEARCH_RATE_PER_MINUTE: '120',
  METRICS_WINDOW_DAYS_MAX: '366',
  METRICS_DEFAULT_WINDOW_DAYS: '30',
  METRICS_DRILL_PAGE_MAX: '100',
  METRICS_DRILL_RESULTS_MAX: '1000',
  METRICS_SCOPE_TASKS_MAX: '20000',
  METRICS_SAMPLE_MIN: '5',
  METRICS_RATE_PER_MINUTE: '60',
  METRICS_RECONCILE_BATCH_MAX: '500',
  METRICS_RECONCILE_DISCOVERY_MAX: '50',
  METRICS_RECONCILE_INTERVAL_MINUTES: '360',
  METRICS_RECONCILE_LEASE_SECONDS: '300',
  METRICS_RECONCILE_MAX_ATTEMPTS: '5',
  METRICS_RECONCILE_BACKOFF_SECONDS: '60',
  GOALS_PER_SCOPE_MAX: '500',
  GOAL_KEY_RESULTS_MAX: '20',
  GOAL_LINKS_MAX: '200',
  GOAL_UPDATE_STALE_DAYS: '14',
  GOAL_CHECKIN_RATE_PER_MINUTE: '30',
  PORTFOLIOS_MAX: '100',
  PORTFOLIO_PROJECTS_MAX: '200',
  PORTFOLIO_READ_PROJECTS_MAX: '500',
  GOALS_EXPORT_ROWS_MAX: '5000',
  GOALS_RECALC_BATCH_MAX: '200',
  GOALS_RECALC_LEASE_SECONDS: '300',
  GOALS_RECALC_INTERVAL_MINUTES: '360',
  GOALS_RECALC_MAX_ATTEMPTS: '5',
  DASHBOARDS_PER_SCOPE_MAX: '100',
  DASHBOARD_PERSONAL_MAX: '20',
  DASHBOARD_WIDGETS_MAX: '24',
  REPORTS_PER_SCOPE_MAX: '200',
  REPORT_RECIPIENTS_MAX: '50',
  REPORT_SHARES_MAX: '100',
  REPORT_EXPORT_ROWS_MAX: '5000',
  REPORT_EMAIL_ROWS_MAX: '25',
  REPORT_EXPORT_RATE_PER_MINUTE: '20',
  REPORT_RUN_RETENTION_DAYS: '90',
  REPORT_BATCH_MAX: '25',
  REPORT_LEASE_SECONDS: '300',
  REPORT_MAX_ATTEMPTS: '5',
  REPORT_FRESHNESS_MINUTES: '720',
  CONNECTIONS_PER_SCOPE_MAX: '50',
  CONNECTION_SCOPES_MAX: '16',
  SYNC_BATCH_MAX: '100',
  SYNC_MAX_ATTEMPTS: '5',
  SYNC_BACKOFF_SECONDS: '30',
  SYNC_LEASE_SECONDS: '120',
  SYNC_HISTORY_RETENTION_DAYS: '90',
  SYNC_RATE_PER_MINUTE: '30',
  INTEGRATION_LOOPBACK_ENABLED: 'auto',
  GOOGLE_CALENDAR_LOOPBACK_ENABLED: '0',
  GOOGLE_CALENDAR_AUTHORIZE_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
  GOOGLE_CALENDAR_TOKEN_URL: 'https://oauth2.googleapis.com/token',
  GOOGLE_CALENDAR_REVOKE_URL: 'https://oauth2.googleapis.com/revoke',
  GOOGLE_CALENDAR_API_BASE: 'https://www.googleapis.com/calendar/v3',
  GOOGLE_CALENDAR_TIMEOUT_MS: '10000',
  CALENDAR_SYNC_PAGES_MAX: '20',
  CALENDAR_SYNC_PAST_DAYS: '30',
  CALENDAR_SYNC_HORIZON_DAYS: '120',
  CALENDARS_PER_CONNECTION_MAX: '25',
  CALENDAR_OCCURRENCES_MAX: '400',
  CALENDAR_EVENTS_LIST_MAX: '500',
  API_TOKENS_PERSONAL_MAX: '25',
  API_TOKENS_SERVICE_MAX: '50',
  API_READ_RATE_PER_MINUTE: '600',
  API_WRITE_RATE_PER_MINUTE: '120',
  API_EXPORT_RATE_PER_MINUTE: '20',
  WEBHOOK_SUBSCRIPTIONS_MAX: '50',
  WEBHOOK_INBOUND_MAX: '20',
  WEBHOOK_MAX_ATTEMPTS: '8',
  WEBHOOK_CONCURRENCY_PER_DESTINATION: '4',
  WEBHOOK_BODY_MAX_BYTES: '262144',
  WEBHOOK_DELIVERY_RETENTION_DAYS: '30',
  WEBHOOK_EVENT_TYPES_MAX: '20',
  WEBHOOK_TIMESTAMP_TOLERANCE: '300',
  WEBHOOK_DISABLE_THRESHOLD: '10',
  WEBHOOK_RESPONSE_TIMEOUT: '10000',
  WEBHOOK_SWEEP_BATCH_MAX: '25',
  WEBHOOK_ALLOW_LOOPBACK: 'auto',
  MCP_ENABLED: '1',
  AI_PROVIDER: 'none',
  AI_PROVIDER_BASE_URL: 'https://api.anthropic.com',
  AI_PROVIDER_TIMEOUT_MS: '60000',
  AI_APPROVED_MODELS: '',
  AI_BYOK_ENABLED: '0',
  AI_DEFAULT_MONTHLY_ALLOWANCE_MICROS: '1000000',
  AI_DEFAULT_HARD_LIMIT_MICROS: '1000000',
  AI_DEFAULT_INPUT_TOKEN_LIMIT: '2000000',
  AI_DEFAULT_OUTPUT_TOKEN_LIMIT: '500000',
  AI_MAX_OUTPUT_TOKENS: '1024',
  AI_MAX_ATTEMPTS: '3',
  USAGE_WARNING_THRESHOLDS: '8000,10000',
  AI_OUTPUT_MAX_CHARS: '40000',
  AI_STREAM_EVENT_MAX_BYTES: '65536',
  AI_STREAM_MAX_BYTES: '4194304',
  AI_CONTEXT_SOURCES_MAX: '8',
  AI_CONTEXT_SOURCE_CHARS: '1500',
  AI_PROPOSAL_APPROVAL_HOURS: '24',
  AI_PROPOSAL_CHANGES_MAX: '25',
  TRANSCRIPTION_PROVIDER: 'none',
  TRANSCRIPTION_BASE_URL: 'http://127.0.0.1:1',
  TRANSCRIPTION_TIMEOUT_MS: '30000',
  VOICE_MAX_SECONDS: '120',
  VOICE_MAX_BYTES: '10485760',
  VOICE_FORMATS: 'audio/wav,audio/webm,audio/ogg',
  VOICE_QUEUE_MAX: '3',
  VOICE_UPLOAD_TTL_SECONDS: '900',
  VOICE_TRANSCRIPT_MAX_CHARS: '4000',
  MCP_READ_RATE_PER_MINUTE: '120',
  MCP_WRITE_RATE_PER_MINUTE: '60',
  OAUTH_CLIENTS_MAX: '20',
  MCP_TOOL_CALL_TIMEOUT_MS: '30000',
  MCP_TOOL_RESULT_MAX_BYTES: '65536',
  IMPORT_ROLLBACK_PERIOD: '604800000',
  DOCUMENT_EMBED_URL_MAX_CHARS: '2048',
  SIGNED_URL_LIFETIME: '300',
  UPLOAD_SESSION_LIFETIME: '3600',
  FILE_UPLOAD_MAX_BYTES: '104857600',
  WORKSPACE_STORAGE_QUOTA_BYTES: '10737418240',
  FILE_COMPARE_MAX_BYTES: '262144',
  FILE_SCAN_MAX_ATTEMPTS: '5',
  FILE_VERSIONS_MAX: '100',
  FILES_LIST_MAX: '200',
  DELIVERABLES_PER_TASK_MAX: '50',
  FILE_DISCOVERY_MAX: '100',
  FILE_EXPIRY_BATCH_MAX: '200',
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
  OBJECT_STORAGE: z.enum(['none', 's3', 'local']),
  OBJECT_STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .optional(),
  OBJECT_STORAGE_REGION: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .optional(),
  OBJECT_STORAGE_ENDPOINT: z.url().optional(),
  OBJECT_STORAGE_FORCE_PATH_STYLE: bool,
  OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1).max(256).optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  OBJECT_STORAGE_LOCAL_DIR: z.string().min(1).optional(),
  OBJECT_STORAGE_LOCAL_SECRET: z.string().optional(),
  OBJECT_STORAGE_PUBLIC_BASE_URL: z.url().optional(),
  MALWARE_SCANNER: z.enum(['none', 'clamav', 'test-signature']),
  CLAMAV_HOST: z.string().min(1).max(255).optional(),
  CLAMAV_PORT: int(1, 65535),
  CLAMAV_TIMEOUT_MS: int(100, 600_000),
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
  QUERY_CONDITIONS_MAX: int(1, 200),
  QUERY_DEPTH_MAX: int(1, 6),
  QUERY_SORTS_MAX: int(1, 10),
  QUERY_VALUES_MAX: int(1, 500),
  QUERY_GROUPS_MAX: int(10, 1000),
  VIEW_COLUMNS_MAX: int(1, 50),
  SAVED_VIEWS_MAX: int(1, 2000),
  VIEW_PINS_MAX: int(1, 100),
  EXPORT_ROWS_MAX: int(1, 50000),
  TOTAL_COUNT_CAP: int(100, 100000),
  LAYOUT_ITEMS_MAX: int(10, 1000),
  WORKLOAD_DAYS_MAX: int(7, 731),
  ACTIVITY_RECORDS_MAX: int(10, 5000),
  AVAILABILITY_WINDOWS_MAX: int(7, 56),
  TIME_OFF_ENTRIES_MAX: int(10, 5000),
  BRAND_HOLIDAYS_MAX: int(10, 10000),
  CAPACITY_RANGE_DAYS_MAX: int(7, 366),
  CAPACITY_PEOPLE_MAX: int(1, 1000),
  TIME_ENTRY_MAX_HOURS: int(1, 24),
  TIME_TIMER_MAX_HOURS: int(1, 24),
  TIME_REPORT_RANGE_DAYS_MAX: int(7, 1830),
  TIME_REPORT_ROWS_MAX: int(10, 5000),
  TIME_EXPORT_ROWS_MAX: int(100, 50000),
  TIME_TIMESHEET_ENTRIES_MAX: int(10, 10000),
  TIME_RUNAWAY_DISCOVERY_MAX: int(1, 1000),
  TIME_RUNAWAY_BATCH_MAX: int(1, 1000),
  TODAY_ITEMS_MAX: int(1, 500),
  TODAY_LIST_MAX: int(5, 200),
  UPCOMING_DEADLINE_DAYS: int(1, 90),
  WORK_BLOCKS_PER_DAY_MAX: int(1, 200),
  WORK_BLOCKS_RANGE_DAYS_MAX: int(1, 366),
  BLOCK_SERIES_MAX: int(1, 500),
  BLOCK_SERIES_HORIZON_DAYS: int(1, 180),
  DAY_CLOSE_DISCOVERY_MAX: int(1, 1000),
  DAY_CLOSE_BATCH_MAX: int(1, 1000),
  COMMENT_BODY_MAX_CHARS: int(100, 50000),
  COMMENT_EDIT_WINDOW_MINUTES: int(5, 10080),
  COMMENT_MENTIONS_MAX: int(1, 100),
  COMMENTS_PER_RECORD_MAX: int(100, 50000),
  COMMENT_RATE_PER_MINUTE: int(1, 600),
  COMMENT_REPLIES_INLINE_MAX: int(1, 100),
  FOLLOWERS_LIST_MAX: int(10, 1000),
  REVIEW_REVIEWERS_MAX: int(1, 50),
  NOTIFY_FANOUT_RECIPIENTS_MAX: int(1, 5000),
  NOTIFY_DEDUPE_WINDOW_MINUTES: int(1, 1440),
  NOTIFY_DELIVERY_BATCH_MAX: int(1, 1000),
  NOTIFY_DELIVERY_MAX_ATTEMPTS: int(1, 20),
  NOTIFY_RETRY_BASE_SECONDS: int(5, 3600),
  NOTIFY_RETRY_MAX_SECONDS: int(60, 86400),
  NOTIFY_DIGEST_ITEMS_MAX: int(5, 200),
  NOTIFY_EMAIL_PER_HOUR_MAX: int(1, 200),
  NOTIFY_RETENTION_DAYS: int(30, 3650),
  NOTIFY_PREFERENCES_MAX: int(10, 1000),
  NOTIFY_BROWSER_ACK_TTL_MINUTES: int(1, 1440),
  NOTIFY_SEARCH_QUERY_MAX: int(10, 200),
  NOTIFY_DISCOVERY_MAX: int(1, 1000),
  NOTIFY_BULK_STATE_MAX: int(1, 1000),
  NOTIFY_DEADLINES_BATCH_MAX: int(10, 5000),
  NOTIFY_FACTS_MAX_BYTES: int(128, 4096),
  DOCUMENT_BODY_MAX_BYTES: int(4096, 2000000),
  DOCUMENT_BLOCKS_MAX: int(10, 5000),
  DOCUMENT_BLOCK_TEXT_MAX_CHARS: int(100, 50000),
  DOCUMENT_TABLE_CELLS_MAX: int(4, 5000),
  DOCUMENT_DEPTH_MAX: int(1, 16),
  DOCUMENT_CHILDREN_MAX: int(1, 1000),
  DOCUMENT_TREE_MAX: int(10, 5000),
  DOCUMENT_VERSIONS_MAX: int(10, 10000),
  DOCUMENT_REFERENCES_MAX: int(10, 2000),
  DOCUMENT_SUGGESTIONS_OPEN_MAX: int(1, 500),
  DOCUMENT_EXPORT_PAGES_MAX: int(1, 500),
  DOCUMENT_EXPORT_MAX_BYTES: int(65536, 52428800),
  DOCUMENT_REVIEW_HORIZON_DAYS: int(30, 3650),
  DOCUMENT_SAVE_RATE_PER_MINUTE: int(1, 600),
  LIVE_EDITING_ENABLED: int(0, 1),
  LIVE_SESSION_TTL_SECONDS: int(15, 300),
  LIVE_SESSIONS_MAX: int(2, 100),
  LIVE_SESSIONS_PER_MEMBER_MAX: int(1, 20),
  LIVE_OPS_BATCH_MAX: int(1, 200),
  LIVE_POLL_WAIT_SECONDS: int(0, 30),
  LIVE_OP_LOG_MAX: int(100, 10000),
  LIVE_RATE_PER_MINUTE: int(10, 6000),
  SEARCH_QUERY_MAX_CHARS: int(20, 500),
  SEARCH_TERMS_MAX: int(2, 30),
  SEARCH_PAGE_SIZE_MAX: int(10, 100),
  SEARCH_RESULTS_MAX: int(50, 1000),
  SEARCH_COUNT_MAX: int(100, 10000),
  SEARCH_SNIPPET_CHARS: int(80, 500),
  SEARCH_BODY_MAX_CHARS: int(10000, 100000),
  SEARCH_INDEX_BATCH_MAX: int(10, 1000),
  SEARCH_INDEX_DISCOVERY_MAX: int(1, 500),
  SEARCH_INDEX_MAX_ATTEMPTS: int(1, 20),
  SEARCH_INDEX_BACKOFF_SECONDS: int(5, 3600),
  SEARCH_FAILED_RETRY_MINUTES: int(10, 10080),
  SEARCH_RECENT_MAX: int(5, 100),
  SEARCH_RECENT_RETENTION_DAYS: int(1, 365),
  SEARCH_RATE_PER_MINUTE: int(10, 1200),
  METRICS_WINDOW_DAYS_MAX: int(31, 1000),
  METRICS_DEFAULT_WINDOW_DAYS: int(7, 366),
  METRICS_DRILL_PAGE_MAX: int(10, 200),
  METRICS_DRILL_RESULTS_MAX: int(100, 5000),
  METRICS_SCOPE_TASKS_MAX: int(1000, 200000),
  METRICS_SAMPLE_MIN: int(1, 100),
  METRICS_RATE_PER_MINUTE: int(10, 600),
  METRICS_RECONCILE_BATCH_MAX: int(50, 5000),
  METRICS_RECONCILE_DISCOVERY_MAX: int(1, 500),
  METRICS_RECONCILE_INTERVAL_MINUTES: int(5, 10080),
  METRICS_RECONCILE_LEASE_SECONDS: int(30, 3600),
  METRICS_RECONCILE_MAX_ATTEMPTS: int(1, 20),
  METRICS_RECONCILE_BACKOFF_SECONDS: int(5, 3600),
  GOALS_PER_SCOPE_MAX: int(10, 5000),
  GOAL_KEY_RESULTS_MAX: int(1, 50),
  GOAL_LINKS_MAX: int(10, 1000),
  GOAL_UPDATE_STALE_DAYS: int(1, 90),
  GOAL_CHECKIN_RATE_PER_MINUTE: int(1, 600),
  PORTFOLIOS_MAX: int(1, 1000),
  PORTFOLIO_PROJECTS_MAX: int(10, 1000),
  PORTFOLIO_READ_PROJECTS_MAX: int(50, 2000),
  GOALS_EXPORT_ROWS_MAX: int(100, 50000),
  GOALS_RECALC_BATCH_MAX: int(10, 2000),
  GOALS_RECALC_LEASE_SECONDS: int(30, 3600),
  GOALS_RECALC_INTERVAL_MINUTES: int(15, 1440),
  GOALS_RECALC_MAX_ATTEMPTS: int(1, 20),
  DASHBOARDS_PER_SCOPE_MAX: int(1, 1000),
  DASHBOARD_PERSONAL_MAX: int(1, 200),
  DASHBOARD_WIDGETS_MAX: int(1, 60),
  REPORTS_PER_SCOPE_MAX: int(1, 2000),
  REPORT_RECIPIENTS_MAX: int(1, 500),
  REPORT_SHARES_MAX: int(1, 1000),
  REPORT_EXPORT_ROWS_MAX: int(100, 50000),
  REPORT_EMAIL_ROWS_MAX: int(5, 200),
  REPORT_EXPORT_RATE_PER_MINUTE: int(1, 600),
  REPORT_RUN_RETENTION_DAYS: int(7, 730),
  REPORT_BATCH_MAX: int(1, 500),
  REPORT_LEASE_SECONDS: int(30, 3600),
  REPORT_MAX_ATTEMPTS: int(1, 20),
  REPORT_FRESHNESS_MINUTES: int(15, 10080),
  CONNECTIONS_PER_SCOPE_MAX: int(1, 500),
  CONNECTION_SCOPES_MAX: int(1, 32),
  SYNC_BATCH_MAX: int(1, 500),
  SYNC_MAX_ATTEMPTS: int(1, 20),
  SYNC_BACKOFF_SECONDS: int(1, 3600),
  SYNC_LEASE_SECONDS: int(30, 3600),
  SYNC_HISTORY_RETENTION_DAYS: int(7, 730),
  SYNC_RATE_PER_MINUTE: int(1, 600),
  INTEGRATION_LOOPBACK_ENABLED: z.enum(['auto', '0', '1']),
  GOOGLE_CALENDAR_LOOPBACK_ENABLED: z.enum(['0', '1']),
  GOOGLE_CALENDAR_CLIENT_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{8,200}$/)
    .optional(),
  GOOGLE_CALENDAR_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALENDAR_REDIRECT_URI: z.url().optional(),
  GOOGLE_CALENDAR_AUTHORIZE_URL: z.url(),
  GOOGLE_CALENDAR_TOKEN_URL: z.url(),
  GOOGLE_CALENDAR_REVOKE_URL: z.url(),
  GOOGLE_CALENDAR_API_BASE: z.url(),
  GOOGLE_CALENDAR_TIMEOUT_MS: int(1000, 60_000),
  CALENDAR_SYNC_PAGES_MAX: int(1, 200),
  CALENDAR_SYNC_PAST_DAYS: int(1, 366),
  CALENDAR_SYNC_HORIZON_DAYS: int(7, 732),
  CALENDARS_PER_CONNECTION_MAX: int(1, 200),
  CALENDAR_OCCURRENCES_MAX: int(10, 5000),
  CALENDAR_EVENTS_LIST_MAX: int(10, 5000),
  API_TOKENS_PERSONAL_MAX: int(1, 500),
  API_TOKENS_SERVICE_MAX: int(1, 500),
  API_READ_RATE_PER_MINUTE: int(1, 10000),
  API_WRITE_RATE_PER_MINUTE: int(1, 5000),
  API_EXPORT_RATE_PER_MINUTE: int(1, 1000),
  WEBHOOK_SUBSCRIPTIONS_MAX: int(1, 500),
  WEBHOOK_INBOUND_MAX: int(1, 200),
  WEBHOOK_MAX_ATTEMPTS: int(1, 20),
  WEBHOOK_CONCURRENCY_PER_DESTINATION: int(1, 50),
  WEBHOOK_BODY_MAX_BYTES: int(1024, 1048576),
  WEBHOOK_DELIVERY_RETENTION_DAYS: int(1, 365),
  WEBHOOK_EVENT_TYPES_MAX: int(1, 20),
  WEBHOOK_TIMESTAMP_TOLERANCE: int(30, 900),
  WEBHOOK_DISABLE_THRESHOLD: int(1, 100),
  WEBHOOK_RESPONSE_TIMEOUT: int(1000, 30000),
  WEBHOOK_SWEEP_BATCH_MAX: int(1, 200),
  WEBHOOK_ALLOW_LOOPBACK: z.enum(['auto', '0', '1']),
  MCP_ENABLED: z.enum(['0', '1']),
  AI_PROVIDER: z.enum(['none', 'fixture', 'anthropic']),
  AI_PROVIDER_BASE_URL: z.url(),
  AI_PROVIDER_API_KEY: z.string().optional(),
  AI_PROVIDER_TIMEOUT_MS: int(1000, 300_000),
  AI_APPROVED_MODELS: z
    .string()
    .regex(
      /^([a-z0-9_.-]{1,40}\/[a-z0-9_.-]{1,80}@[0-9a-z_.-]{1,40})?(,[a-z0-9_.-]{1,40}\/[a-z0-9_.-]{1,80}@[0-9a-z_.-]{1,40})*$/,
    ),
  AI_BYOK_ENABLED: z.enum(['0', '1']),
  AI_DEFAULT_MONTHLY_ALLOWANCE_MICROS: int(0, 1_000_000_000_000),
  AI_DEFAULT_HARD_LIMIT_MICROS: int(0, 1_000_000_000_000),
  AI_DEFAULT_INPUT_TOKEN_LIMIT: int(0, 1_000_000_000_000),
  AI_DEFAULT_OUTPUT_TOKEN_LIMIT: int(0, 1_000_000_000_000),
  AI_MAX_OUTPUT_TOKENS: int(16, 8192),
  AI_MAX_ATTEMPTS: int(1, 5),
  USAGE_WARNING_THRESHOLDS: z.string().regex(/^\d{1,5}(,\d{1,5}){0,4}$/),
  AI_HISTORY_RETENTION_DAYS: int(1, 36_500).optional(),
  AI_OUTPUT_MAX_CHARS: int(256, 40_000),
  AI_STREAM_EVENT_MAX_BYTES: int(4096, 1_048_576),
  AI_STREAM_MAX_BYTES: int(65_536, 33_554_432),
  AI_CONTEXT_SOURCES_MAX: int(1, 20),
  AI_CONTEXT_SOURCE_CHARS: int(200, 6000),
  AI_PROPOSAL_APPROVAL_HOURS: int(1, 168),
  AI_PROPOSAL_CHANGES_MAX: int(1, 100),
  TRANSCRIPTION_PROVIDER: z.enum(['none', 'fixture']),
  TRANSCRIPTION_BASE_URL: z.url(),
  TRANSCRIPTION_API_KEY: z.string().optional(),
  TRANSCRIPTION_TIMEOUT_MS: int(1000, 120_000),
  VOICE_MAX_SECONDS: int(5, 600),
  VOICE_MAX_BYTES: int(1024, 104_857_600),
  VOICE_FORMATS: z.string().regex(/^audio\/(wav|webm|ogg)(,audio\/(wav|webm|ogg)){0,2}$/),
  VOICE_QUEUE_MAX: int(1, 20),
  VOICE_UPLOAD_TTL_SECONDS: int(60, 3600),
  VOICE_TRANSCRIPT_MAX_CHARS: int(200, 20_000),
  MCP_READ_RATE_PER_MINUTE: int(1, 10_000),
  MCP_WRITE_RATE_PER_MINUTE: int(1, 10_000),
  OAUTH_CLIENTS_MAX: int(1, 500),
  MCP_TOOL_CALL_TIMEOUT_MS: int(1000, 120_000),
  MCP_TOOL_RESULT_MAX_BYTES: int(1024, 1_048_576),
  IMPORT_ROLLBACK_PERIOD: int(60_000, 7_776_000_000),
  DOCUMENT_EMBED_URL_MAX_CHARS: int(128, 8192),
  SIGNED_URL_LIFETIME: int(30, 3600),
  UPLOAD_SESSION_LIFETIME: int(300, 86400),
  FILE_UPLOAD_MAX_BYTES: int(1024, 5368709120),
  WORKSPACE_STORAGE_QUOTA_BYTES: int(1048576, 10995116277760),
  FILE_COMPARE_MAX_BYTES: int(1024, 2097152),
  FILE_SCAN_MAX_ATTEMPTS: int(1, 20),
  FILE_VERSIONS_MAX: int(1, 1000),
  FILES_LIST_MAX: int(10, 1000),
  DELIVERABLES_PER_TASK_MAX: int(1, 500),
  FILE_DISCOVERY_MAX: int(1, 1000),
  FILE_EXPIRY_BATCH_MAX: int(10, 5000),
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

  // Files (4E) -----------------------------------------------------------------------------------
  let filesStorage: FilesStorageConfig = { provider: 'none' };
  if (c.OBJECT_STORAGE === 's3') {
    if (!c.OBJECT_STORAGE_BUCKET)
      issues.push('OBJECT_STORAGE_BUCKET: required with s3 object storage');
    if (!c.OBJECT_STORAGE_REGION)
      issues.push('OBJECT_STORAGE_REGION: required with s3 object storage');
    if (!c.OBJECT_STORAGE_ACCESS_KEY_ID)
      issues.push('OBJECT_STORAGE_ACCESS_KEY_ID: required with s3 object storage');
    const rawSecret = c.OBJECT_STORAGE_SECRET_ACCESS_KEY;
    if (!rawSecret)
      issues.push('OBJECT_STORAGE_SECRET_ACCESS_KEY: required with s3 object storage');
    else if (rawSecret.startsWith(SECRET_REFERENCE_PREFIX))
      issues.push(
        'OBJECT_STORAGE_SECRET_ACCESS_KEY: secret references require a secret-store provider (not selected; DQ-28)',
      );
    if (deployed && c.OBJECT_STORAGE_ENDPOINT && !c.OBJECT_STORAGE_ENDPOINT.startsWith('https://'))
      issues.push('OBJECT_STORAGE_ENDPOINT: must use https in deployed environments');
    filesStorage = {
      provider: 's3',
      bucket: c.OBJECT_STORAGE_BUCKET ?? '',
      region: c.OBJECT_STORAGE_REGION ?? '',
      endpoint: c.OBJECT_STORAGE_ENDPOINT,
      forcePathStyle: c.OBJECT_STORAGE_FORCE_PATH_STYLE,
      accessKeyId: c.OBJECT_STORAGE_ACCESS_KEY_ID ?? '',
      secretAccessKey: new Secret(rawSecret ?? ''),
    };
  } else if (c.OBJECT_STORAGE === 'local') {
    if (deployed)
      issues.push(
        'OBJECT_STORAGE: local is a development adapter; refused in deployed environments',
      );
    if (!c.OBJECT_STORAGE_LOCAL_DIR)
      issues.push('OBJECT_STORAGE_LOCAL_DIR: required with local object storage');
    const secret = keyBytes('OBJECT_STORAGE_LOCAL_SECRET', c.OBJECT_STORAGE_LOCAL_SECRET, false);
    if (!secret) issues.push('OBJECT_STORAGE_LOCAL_SECRET: required with local object storage');
    filesStorage = {
      provider: 'local',
      dir: c.OBJECT_STORAGE_LOCAL_DIR ?? '',
      secret: secret ?? new Secret(''),
      publicBaseUrl: (
        c.OBJECT_STORAGE_PUBLIC_BASE_URL ??
        c.PUBLIC_BASE_URL ??
        `http://127.0.0.1:${c.HTTP_PORT}`
      ).replace(/\/+$/, ''),
    };
  }
  // Google Calendar (6C, ADR-0037 G1): configured only when the client is fully set. Deployed
  // environments talk to HTTPS endpoints only; local and test may point at a provider fixture.
  let calendar: CalendarProviderConfig = { provider: 'none' };
  const calendarParts = [
    c.GOOGLE_CALENDAR_CLIENT_ID,
    c.GOOGLE_CALENDAR_CLIENT_SECRET,
    c.GOOGLE_CALENDAR_REDIRECT_URI,
  ];
  if (calendarParts.some(Boolean)) {
    if (!calendarParts.every(Boolean))
      issues.push(
        'GOOGLE_CALENDAR_CLIENT_ID: set the client ID, client secret, and redirect URI together',
      );
    else if (c.GOOGLE_CALENDAR_CLIENT_SECRET!.startsWith(SECRET_REFERENCE_PREFIX))
      issues.push(
        'GOOGLE_CALENDAR_CLIENT_SECRET: secret references require a secret-store provider (not selected; DQ-28)',
      );
    else {
      const urls = {
        GOOGLE_CALENDAR_REDIRECT_URI: c.GOOGLE_CALENDAR_REDIRECT_URI!,
        GOOGLE_CALENDAR_AUTHORIZE_URL: c.GOOGLE_CALENDAR_AUTHORIZE_URL,
        GOOGLE_CALENDAR_TOKEN_URL: c.GOOGLE_CALENDAR_TOKEN_URL,
        GOOGLE_CALENDAR_REVOKE_URL: c.GOOGLE_CALENDAR_REVOKE_URL,
        GOOGLE_CALENDAR_API_BASE: c.GOOGLE_CALENDAR_API_BASE,
      };
      for (const [name, url] of Object.entries(urls))
        if (!devOnly && !url.startsWith('https://'))
          issues.push(`${name}: must use https outside local and test`);
      calendar = {
        provider: 'google',
        clientId: c.GOOGLE_CALENDAR_CLIENT_ID!,
        clientSecret: new Secret(c.GOOGLE_CALENDAR_CLIENT_SECRET!),
        redirectUri: urls.GOOGLE_CALENDAR_REDIRECT_URI,
        authorizeUrl: urls.GOOGLE_CALENDAR_AUTHORIZE_URL,
        tokenUrl: urls.GOOGLE_CALENDAR_TOKEN_URL,
        revokeUrl: urls.GOOGLE_CALENDAR_REVOKE_URL,
        apiBase: urls.GOOGLE_CALENDAR_API_BASE.replace(/\/+$/, ''),
        timeoutMs: c.GOOGLE_CALENDAR_TIMEOUT_MS,
      };
    }
  }
  // AI gateway (7A, ADR-0038): disabled unless configured. Deployed environments refuse the
  // fixture, refuse a real provider until DQ-28 and OD-41 are decided, and refuse workspace keys
  // until OD-46 is decided.
  let aiProvider: AiProviderTransportConfig = { provider: 'none' };
  if (c.AI_PROVIDER !== 'none') {
    const key = c.AI_PROVIDER_API_KEY;
    if (key?.startsWith(SECRET_REFERENCE_PREFIX))
      issues.push(
        'AI_PROVIDER_API_KEY: secret references require a secret-store provider (not selected; DQ-28)',
      );
    if (deployed && c.AI_PROVIDER === 'fixture')
      issues.push('AI_PROVIDER: the protocol fixture is refused in deployed environments');
    if (deployed && c.AI_PROVIDER === 'anthropic')
      issues.push(
        'AI_PROVIDER: production AI needs an approved secret store (DQ-28) and provider data-use approval (OD-41)',
      );
    if (!devOnly && !c.AI_PROVIDER_BASE_URL.startsWith('https://'))
      issues.push('AI_PROVIDER_BASE_URL: must use https outside local and test');
    if (c.AI_PROVIDER === 'anthropic' && !key)
      issues.push('AI_PROVIDER_API_KEY: required with the anthropic provider');
    aiProvider = {
      provider: c.AI_PROVIDER,
      baseUrl: c.AI_PROVIDER_BASE_URL.replace(/\/+$/, ''),
      apiKey: key && !key.startsWith(SECRET_REFERENCE_PREFIX) ? new Secret(key) : null,
      timeoutMs: c.AI_PROVIDER_TIMEOUT_MS,
    };
  }
  if (deployed && c.AI_BYOK_ENABLED === '1')
    issues.push('AI_BYOK_ENABLED: workspace-provided AI keys stay off until OD-46 is approved');
  if (c.AI_DEFAULT_MONTHLY_ALLOWANCE_MICROS > c.AI_DEFAULT_HARD_LIMIT_MICROS)
    issues.push(
      'AI_DEFAULT_MONTHLY_ALLOWANCE_MICROS: must not exceed AI_DEFAULT_HARD_LIMIT_MICROS',
    );
  const warningThresholdsBp = c.USAGE_WARNING_THRESHOLDS.split(',').map(Number);
  if (
    warningThresholdsBp.some(
      (bp, i) => bp < 1 || bp > 10_000 || (i > 0 && bp <= warningThresholdsBp[i - 1]!),
    )
  )
    issues.push('USAGE_WARNING_THRESHOLDS: ascending basis points between 1 and 10000');
  const ai: AiConfig = {
    provider: aiProvider,
    approvedModels: c.AI_APPROVED_MODELS ? c.AI_APPROVED_MODELS.split(',') : [],
    byokEnabled: c.AI_BYOK_ENABLED === '1',
    defaults: {
      monthlyAllowanceMicros: String(c.AI_DEFAULT_MONTHLY_ALLOWANCE_MICROS),
      hardLimitMicros: String(c.AI_DEFAULT_HARD_LIMIT_MICROS),
      inputTokenLimit: c.AI_DEFAULT_INPUT_TOKEN_LIMIT,
      outputTokenLimit: c.AI_DEFAULT_OUTPUT_TOKEN_LIMIT,
    },
    maxOutputTokens: c.AI_MAX_OUTPUT_TOKENS,
    maxAttempts: c.AI_MAX_ATTEMPTS,
    warningThresholdsBp,
    historyRetentionDays: c.AI_HISTORY_RETENTION_DAYS ?? null,
    stream: {
      outputMaxChars: c.AI_OUTPUT_MAX_CHARS,
      eventMaxBytes: c.AI_STREAM_EVENT_MAX_BYTES,
      maxBytes: c.AI_STREAM_MAX_BYTES,
    },
    retrieval: {
      sourcesMax: c.AI_CONTEXT_SOURCES_MAX,
      sourceChars: c.AI_CONTEXT_SOURCE_CHARS,
    },
    proposals: {
      approvalHours: c.AI_PROPOSAL_APPROVAL_HOURS,
      changesMax: c.AI_PROPOSAL_CHANGES_MAX,
    },
    transcription:
      c.TRANSCRIPTION_PROVIDER === 'fixture'
        ? {
            provider: 'fixture',
            baseUrl: c.TRANSCRIPTION_BASE_URL.replace(/\/+$/, ''),
            apiKey: c.TRANSCRIPTION_API_KEY ? new Secret(c.TRANSCRIPTION_API_KEY) : null,
            timeoutMs: c.TRANSCRIPTION_TIMEOUT_MS,
          }
        : { provider: 'none' },
    voice: {
      maxSeconds: c.VOICE_MAX_SECONDS,
      maxBytes: c.VOICE_MAX_BYTES,
      formats: [...new Set(c.VOICE_FORMATS.split(','))] as VoiceConfig['formats'][number][],
      queueMax: c.VOICE_QUEUE_MAX,
      uploadTtlSeconds: c.VOICE_UPLOAD_TTL_SECONDS,
      transcriptMaxChars: c.VOICE_TRANSCRIPT_MAX_CHARS,
    },
  };
  // 7F: the transcription fixture is synthetic and refused when deployed; no live provider exists.
  if (deployed && c.TRANSCRIPTION_PROVIDER === 'fixture')
    issues.push('TRANSCRIPTION_PROVIDER: the transcription fixture is refused in deployed environments');
  if (c.TRANSCRIPTION_API_KEY?.startsWith(SECRET_REFERENCE_PREFIX))
    issues.push(
      'TRANSCRIPTION_API_KEY: secret references require a secret-store provider (not selected; DQ-28)',
    );
  if (c.AI_STREAM_EVENT_MAX_BYTES > c.AI_STREAM_MAX_BYTES)
    issues.push('AI_STREAM_EVENT_MAX_BYTES: must not exceed AI_STREAM_MAX_BYTES');
  let filesScanner: FilesScannerConfig = { provider: 'none' };
  if (c.MALWARE_SCANNER === 'clamav') {
    if (!c.CLAMAV_HOST) issues.push('CLAMAV_HOST: required with the clamav malware scanner');
    filesScanner = {
      provider: 'clamav',
      host: c.CLAMAV_HOST ?? '',
      port: c.CLAMAV_PORT,
      timeoutMs: c.CLAMAV_TIMEOUT_MS,
    };
  } else if (c.MALWARE_SCANNER === 'test-signature') {
    if (deployed)
      issues.push(
        'MALWARE_SCANNER: test-signature is a development adapter; refused in deployed environments',
      );
    filesScanner = { provider: 'test-signature' };
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
    lifecycle: {
      retentionPeriodsMs,
      purgeLedger: c.PURGE_LEDGER,
      purgeLedgerDir: c.PURGE_LEDGER_DIR,
    },
    files: { storage: filesStorage, scanner: filesScanner },
    calendar,
    ai,
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
      queryConditionsMax: c.QUERY_CONDITIONS_MAX,
      queryDepthMax: c.QUERY_DEPTH_MAX,
      querySortsMax: c.QUERY_SORTS_MAX,
      queryValuesMax: c.QUERY_VALUES_MAX,
      queryGroupsMax: c.QUERY_GROUPS_MAX,
      viewColumnsMax: c.VIEW_COLUMNS_MAX,
      savedViewsMax: c.SAVED_VIEWS_MAX,
      viewPinsMax: c.VIEW_PINS_MAX,
      exportRowsMax: c.EXPORT_ROWS_MAX,
      totalCountCap: c.TOTAL_COUNT_CAP,
      layoutItemsMax: c.LAYOUT_ITEMS_MAX,
      workloadDaysMax: c.WORKLOAD_DAYS_MAX,
      activityRecordsMax: c.ACTIVITY_RECORDS_MAX,
      availabilityWindowsMax: c.AVAILABILITY_WINDOWS_MAX,
      timeOffEntriesMax: c.TIME_OFF_ENTRIES_MAX,
      brandHolidaysMax: c.BRAND_HOLIDAYS_MAX,
      capacityRangeDaysMax: c.CAPACITY_RANGE_DAYS_MAX,
      capacityPeopleMax: c.CAPACITY_PEOPLE_MAX,
      timeEntryMaxHours: c.TIME_ENTRY_MAX_HOURS,
      timeTimerMaxHours: c.TIME_TIMER_MAX_HOURS,
      timeReportRangeDaysMax: c.TIME_REPORT_RANGE_DAYS_MAX,
      timeReportRowsMax: c.TIME_REPORT_ROWS_MAX,
      timeExportRowsMax: c.TIME_EXPORT_ROWS_MAX,
      timeTimesheetEntriesMax: c.TIME_TIMESHEET_ENTRIES_MAX,
      timeRunawayDiscoveryMax: c.TIME_RUNAWAY_DISCOVERY_MAX,
      timeRunawayBatchMax: c.TIME_RUNAWAY_BATCH_MAX,
      todayItemsMax: c.TODAY_ITEMS_MAX,
      todayListMax: c.TODAY_LIST_MAX,
      upcomingDeadlineDays: c.UPCOMING_DEADLINE_DAYS,
      workBlocksPerDayMax: c.WORK_BLOCKS_PER_DAY_MAX,
      workBlocksRangeDaysMax: c.WORK_BLOCKS_RANGE_DAYS_MAX,
      blockSeriesMax: c.BLOCK_SERIES_MAX,
      blockSeriesHorizonDays: c.BLOCK_SERIES_HORIZON_DAYS,
      dayCloseDiscoveryMax: c.DAY_CLOSE_DISCOVERY_MAX,
      dayCloseBatchMax: c.DAY_CLOSE_BATCH_MAX,
      commentBodyMaxChars: c.COMMENT_BODY_MAX_CHARS,
      commentEditWindowMinutes: c.COMMENT_EDIT_WINDOW_MINUTES,
      commentMentionsMax: c.COMMENT_MENTIONS_MAX,
      commentsPerRecordMax: c.COMMENTS_PER_RECORD_MAX,
      commentRatePerMinute: c.COMMENT_RATE_PER_MINUTE,
      commentRepliesInlineMax: c.COMMENT_REPLIES_INLINE_MAX,
      followersListMax: c.FOLLOWERS_LIST_MAX,
      reviewReviewersMax: c.REVIEW_REVIEWERS_MAX,
      notifyFanoutRecipientsMax: c.NOTIFY_FANOUT_RECIPIENTS_MAX,
      notifyDedupeWindowMinutes: c.NOTIFY_DEDUPE_WINDOW_MINUTES,
      notifyDeliveryBatchMax: c.NOTIFY_DELIVERY_BATCH_MAX,
      notifyDeliveryMaxAttempts: c.NOTIFY_DELIVERY_MAX_ATTEMPTS,
      notifyRetryBaseSeconds: c.NOTIFY_RETRY_BASE_SECONDS,
      notifyRetryMaxSeconds: c.NOTIFY_RETRY_MAX_SECONDS,
      notifyDigestItemsMax: c.NOTIFY_DIGEST_ITEMS_MAX,
      notifyEmailPerHourMax: c.NOTIFY_EMAIL_PER_HOUR_MAX,
      notifyRetentionDays: c.NOTIFY_RETENTION_DAYS,
      notifyPreferencesMax: c.NOTIFY_PREFERENCES_MAX,
      notifyBrowserAckTtlMinutes: c.NOTIFY_BROWSER_ACK_TTL_MINUTES,
      notifySearchQueryMax: c.NOTIFY_SEARCH_QUERY_MAX,
      notifyDiscoveryMax: c.NOTIFY_DISCOVERY_MAX,
      notifyBulkStateMax: c.NOTIFY_BULK_STATE_MAX,
      notifyDeadlinesBatchMax: c.NOTIFY_DEADLINES_BATCH_MAX,
      notifyFactsMaxBytes: c.NOTIFY_FACTS_MAX_BYTES,
      documentBodyMaxBytes: c.DOCUMENT_BODY_MAX_BYTES,
      documentBlocksMax: c.DOCUMENT_BLOCKS_MAX,
      documentBlockTextMaxChars: c.DOCUMENT_BLOCK_TEXT_MAX_CHARS,
      documentTableCellsMax: c.DOCUMENT_TABLE_CELLS_MAX,
      documentDepthMax: c.DOCUMENT_DEPTH_MAX,
      documentChildrenMax: c.DOCUMENT_CHILDREN_MAX,
      documentTreeMax: c.DOCUMENT_TREE_MAX,
      documentVersionsMax: c.DOCUMENT_VERSIONS_MAX,
      documentReferencesMax: c.DOCUMENT_REFERENCES_MAX,
      documentSuggestionsOpenMax: c.DOCUMENT_SUGGESTIONS_OPEN_MAX,
      documentExportPagesMax: c.DOCUMENT_EXPORT_PAGES_MAX,
      documentExportMaxBytes: c.DOCUMENT_EXPORT_MAX_BYTES,
      documentReviewHorizonDays: c.DOCUMENT_REVIEW_HORIZON_DAYS,
      documentSaveRatePerMinute: c.DOCUMENT_SAVE_RATE_PER_MINUTE,
      liveEditingEnabled: c.LIVE_EDITING_ENABLED,
      liveSessionTtlSeconds: c.LIVE_SESSION_TTL_SECONDS,
      liveSessionsMax: c.LIVE_SESSIONS_MAX,
      liveSessionsPerMemberMax: c.LIVE_SESSIONS_PER_MEMBER_MAX,
      liveOpsBatchMax: c.LIVE_OPS_BATCH_MAX,
      livePollWaitSeconds: c.LIVE_POLL_WAIT_SECONDS,
      liveOpLogMax: c.LIVE_OP_LOG_MAX,
      liveRatePerMinute: c.LIVE_RATE_PER_MINUTE,
      searchQueryMaxChars: c.SEARCH_QUERY_MAX_CHARS,
      searchTermsMax: c.SEARCH_TERMS_MAX,
      searchPageSizeMax: c.SEARCH_PAGE_SIZE_MAX,
      searchResultsMax: c.SEARCH_RESULTS_MAX,
      searchCountMax: c.SEARCH_COUNT_MAX,
      searchSnippetChars: c.SEARCH_SNIPPET_CHARS,
      searchBodyMaxChars: c.SEARCH_BODY_MAX_CHARS,
      searchIndexBatchMax: c.SEARCH_INDEX_BATCH_MAX,
      searchIndexDiscoveryMax: c.SEARCH_INDEX_DISCOVERY_MAX,
      searchIndexMaxAttempts: c.SEARCH_INDEX_MAX_ATTEMPTS,
      searchIndexBackoffSeconds: c.SEARCH_INDEX_BACKOFF_SECONDS,
      searchFailedRetryMinutes: c.SEARCH_FAILED_RETRY_MINUTES,
      searchRecentMax: c.SEARCH_RECENT_MAX,
      searchRecentRetentionDays: c.SEARCH_RECENT_RETENTION_DAYS,
      searchRatePerMinute: c.SEARCH_RATE_PER_MINUTE,
      metricsWindowDaysMax: c.METRICS_WINDOW_DAYS_MAX,
      metricsDefaultWindowDays: c.METRICS_DEFAULT_WINDOW_DAYS,
      metricsDrillPageMax: c.METRICS_DRILL_PAGE_MAX,
      metricsDrillResultsMax: c.METRICS_DRILL_RESULTS_MAX,
      metricsScopeTasksMax: c.METRICS_SCOPE_TASKS_MAX,
      metricsSampleMin: c.METRICS_SAMPLE_MIN,
      metricsRatePerMinute: c.METRICS_RATE_PER_MINUTE,
      metricsReconcileBatchMax: c.METRICS_RECONCILE_BATCH_MAX,
      metricsReconcileDiscoveryMax: c.METRICS_RECONCILE_DISCOVERY_MAX,
      metricsReconcileIntervalMinutes: c.METRICS_RECONCILE_INTERVAL_MINUTES,
      metricsReconcileLeaseSeconds: c.METRICS_RECONCILE_LEASE_SECONDS,
      metricsReconcileMaxAttempts: c.METRICS_RECONCILE_MAX_ATTEMPTS,
      metricsReconcileBackoffSeconds: c.METRICS_RECONCILE_BACKOFF_SECONDS,
      goalsPerScopeMax: c.GOALS_PER_SCOPE_MAX,
      goalKeyResultsMax: c.GOAL_KEY_RESULTS_MAX,
      goalLinksMax: c.GOAL_LINKS_MAX,
      goalUpdateStaleDays: c.GOAL_UPDATE_STALE_DAYS,
      goalCheckinRatePerMinute: c.GOAL_CHECKIN_RATE_PER_MINUTE,
      portfoliosMax: c.PORTFOLIOS_MAX,
      portfolioProjectsMax: c.PORTFOLIO_PROJECTS_MAX,
      portfolioReadProjectsMax: c.PORTFOLIO_READ_PROJECTS_MAX,
      goalsExportRowsMax: c.GOALS_EXPORT_ROWS_MAX,
      goalsRecalcBatchMax: c.GOALS_RECALC_BATCH_MAX,
      goalsRecalcLeaseSeconds: c.GOALS_RECALC_LEASE_SECONDS,
      goalsRecalcIntervalMinutes: c.GOALS_RECALC_INTERVAL_MINUTES,
      goalsRecalcMaxAttempts: c.GOALS_RECALC_MAX_ATTEMPTS,
      dashboardsPerScopeMax: c.DASHBOARDS_PER_SCOPE_MAX,
      dashboardPersonalMax: c.DASHBOARD_PERSONAL_MAX,
      dashboardWidgetsMax: c.DASHBOARD_WIDGETS_MAX,
      reportsPerScopeMax: c.REPORTS_PER_SCOPE_MAX,
      reportRecipientsMax: c.REPORT_RECIPIENTS_MAX,
      reportSharesMax: c.REPORT_SHARES_MAX,
      reportExportRowsMax: c.REPORT_EXPORT_ROWS_MAX,
      reportEmailRowsMax: c.REPORT_EMAIL_ROWS_MAX,
      reportExportRatePerMinute: c.REPORT_EXPORT_RATE_PER_MINUTE,
      reportRunRetentionDays: c.REPORT_RUN_RETENTION_DAYS,
      reportBatchMax: c.REPORT_BATCH_MAX,
      reportLeaseSeconds: c.REPORT_LEASE_SECONDS,
      reportMaxAttempts: c.REPORT_MAX_ATTEMPTS,
      reportFreshnessMinutes: c.REPORT_FRESHNESS_MINUTES,
      connectionsPerScopeMax: c.CONNECTIONS_PER_SCOPE_MAX,
      connectionScopesMax: c.CONNECTION_SCOPES_MAX,
      syncBatchMax: c.SYNC_BATCH_MAX,
      syncMaxAttempts: c.SYNC_MAX_ATTEMPTS,
      syncBackoffSeconds: c.SYNC_BACKOFF_SECONDS,
      syncLeaseSeconds: c.SYNC_LEASE_SECONDS,
      syncHistoryRetentionDays: c.SYNC_HISTORY_RETENTION_DAYS,
      syncRatePerMinute: c.SYNC_RATE_PER_MINUTE,
      integrationLoopbackEnabled:
        c.INTEGRATION_LOOPBACK_ENABLED === '1' ||
        (c.INTEGRATION_LOOPBACK_ENABLED === 'auto' && (env === 'local' || env === 'test')),
      googleCalendarLoopbackEnabled: c.GOOGLE_CALENDAR_LOOPBACK_ENABLED === '1',
      calendarSyncPagesMax: c.CALENDAR_SYNC_PAGES_MAX,
      calendarSyncPastDays: c.CALENDAR_SYNC_PAST_DAYS,
      calendarSyncHorizonDays: c.CALENDAR_SYNC_HORIZON_DAYS,
      calendarsPerConnectionMax: c.CALENDARS_PER_CONNECTION_MAX,
      calendarOccurrencesMax: c.CALENDAR_OCCURRENCES_MAX,
      calendarEventsListMax: c.CALENDAR_EVENTS_LIST_MAX,
      apiTokensPersonalMax: c.API_TOKENS_PERSONAL_MAX,
      apiTokensServiceMax: c.API_TOKENS_SERVICE_MAX,
      apiReadRatePerMinute: c.API_READ_RATE_PER_MINUTE,
      apiWriteRatePerMinute: c.API_WRITE_RATE_PER_MINUTE,
      apiExportRatePerMinute: c.API_EXPORT_RATE_PER_MINUTE,
      webhookSubscriptionsMax: c.WEBHOOK_SUBSCRIPTIONS_MAX,
      webhookInboundMax: c.WEBHOOK_INBOUND_MAX,
      webhookMaxAttempts: c.WEBHOOK_MAX_ATTEMPTS,
      webhookConcurrencyPerDestination: c.WEBHOOK_CONCURRENCY_PER_DESTINATION,
      webhookBodyMaxBytes: c.WEBHOOK_BODY_MAX_BYTES,
      webhookDeliveryRetentionDays: c.WEBHOOK_DELIVERY_RETENTION_DAYS,
      webhookEventTypesMax: c.WEBHOOK_EVENT_TYPES_MAX,
      webhookTimestampToleranceSeconds: c.WEBHOOK_TIMESTAMP_TOLERANCE,
      webhookDisableThreshold: c.WEBHOOK_DISABLE_THRESHOLD,
      webhookResponseTimeoutMs: c.WEBHOOK_RESPONSE_TIMEOUT,
      webhookSweepBatchMax: c.WEBHOOK_SWEEP_BATCH_MAX,
      webhookAllowLoopback:
        c.WEBHOOK_ALLOW_LOOPBACK === '1' ||
        (c.WEBHOOK_ALLOW_LOOPBACK === 'auto' && (env === 'local' || env === 'test')),
      mcpEnabled: c.MCP_ENABLED === '1',
      mcpReadRatePerMinute: c.MCP_READ_RATE_PER_MINUTE,
      mcpWriteRatePerMinute: c.MCP_WRITE_RATE_PER_MINUTE,
      oauthClientsMax: c.OAUTH_CLIENTS_MAX,
      mcpToolCallTimeoutMs: c.MCP_TOOL_CALL_TIMEOUT_MS,
      mcpToolResultMaxBytes: c.MCP_TOOL_RESULT_MAX_BYTES,
      importRollbackPeriodMs: c.IMPORT_ROLLBACK_PERIOD,
      documentEmbedUrlMaxChars: c.DOCUMENT_EMBED_URL_MAX_CHARS,
      signedUrlLifetimeSeconds: c.SIGNED_URL_LIFETIME,
      uploadSessionLifetimeSeconds: c.UPLOAD_SESSION_LIFETIME,
      fileUploadMaxBytes: c.FILE_UPLOAD_MAX_BYTES,
      workspaceStorageQuotaBytes: c.WORKSPACE_STORAGE_QUOTA_BYTES,
      fileCompareMaxBytes: c.FILE_COMPARE_MAX_BYTES,
      fileScanMaxAttempts: c.FILE_SCAN_MAX_ATTEMPTS,
      fileVersionsMax: c.FILE_VERSIONS_MAX,
      filesListMax: c.FILES_LIST_MAX,
      deliverablesPerTaskMax: c.DELIVERABLES_PER_TASK_MAX,
      fileDiscoveryMax: c.FILE_DISCOVERY_MAX,
      fileExpiryBatchMax: c.FILE_EXPIRY_BATCH_MAX,
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
