import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadServerConfig, Secret } from '@pm/config';

const url = (role: string, db = 'pm_dev', extra = '') =>
  `postgres://${role}:pw_${role}@db.local:5432/${db}${extra}`;
const strong = (role: string, env: string) =>
  `postgres://${role}:Zq8vN3kL0pW2xR7t_${role}@db.internal:5432/pm_${env}?sslmode=verify-full`; // gitleaks:allow (synthetic)

const devKey = Buffer.alloc(32, 3).toString('base64url');
const local = {
  APP_ENV: 'local',
  DATABASE_APP_URL: url('app_rw'),
  DATABASE_WORKER_URL: url('app_worker'),
  DATABASE_DISPATCHER_URL: url('dispatcher'),
  AUTH_SIGNING_KEY: devKey,
  SECRET_VAULT: 'dev-database',
  DEV_VAULT_KEY: devKey,
  MAIL_TRANSPORT: 'capture',
};
const deployed = (env: string, overrides: Record<string, string> = {}) => ({
  APP_ENV: env,
  BUILD_VERSION: '1.2.3',
  BUILD_ID: 'a1b2c3d',
  HTTP_HOST: '0.0.0.0',
  HTTP_PORT: '3000',
  HTTP_TRUST_PROXY: 'true',
  PUBLIC_BASE_URL: 'https://app.example.test',
  LOG_LEVEL: 'info',
  TRACE_SAMPLE_RATIO: '0.1',
  DATABASE_APP_URL: strong('app_rw', env),
  DATABASE_WORKER_URL: strong('app_worker', env),
  DATABASE_DISPATCHER_URL: strong('dispatcher', env),
  ...overrides,
});
const issues = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return [...e.issues];
    throw e;
  }
  return [];
};

describe('server configuration', () => {
  it('requires an explicit environment mode', () => {
    expect(issues(() => loadServerConfig({ service: 'api', env: {} }))[0]).toMatch(/^APP_ENV/);
  });

  it('applies conservative local defaults and loads only the identities a process needs', () => {
    const c = loadServerConfig({ service: 'api', env: local });
    expect(Object.keys(c.database.connections)).toEqual(['app']);
    expect(c.jobs.heartbeatIntervalMs * 3).toBeLessThan(c.jobs.leaseDurationMs);
    const w = loadServerConfig({ service: 'worker', env: local });
    expect(Object.keys(w.database.connections).sort()).toEqual(['dispatcher', 'worker']);
  });

  it('project bounds (0D PL-22): defaults, ranges, and three distinct recurrence layers', () => {
    expect(loadServerConfig({ service: 'worker', env: local }).work).toEqual({
      projectDepthMax: 10,
      templateItemsMax: 500,
      recurrenceCatchupMax: 12,
      recurrenceWorkspaceDiscoveryMax: 200,
      recurrenceSeriesDiscoveryMax: 50,
      taskDepthMax: 20,
      taskSubtreeMax: 500,
      taskItemsMax: 200,
      taskAssigneesMax: 20,
      taskLabelsMax: 50,
      brandLabelsMax: 1000,
      taskEstimateMinutesMax: 100000,
      pageLimitDefault: 50,
      pageLimitMax: 200,
      workflowStatusesMax: 50,
      workflowTransitionsMax: 400,
      transitionRequirementsMax: 30,
      transitionApproversMax: 10,
      approvalExpiryHours: 168,
      transitionPreviewTtlSeconds: 600,
      fieldDefinitionsMax: 200,
      fieldOptionsMax: 200,
      fieldSetsMax: 100,
      fieldSetItemsMax: 100,
      fieldTextMax: 5000,
      fieldPatternMax: 200,
      formulaSourceMax: 2000,
      formulaAstNodesMax: 200,
      formulaDepthMax: 8,
      formulaRefsMax: 20,
      fieldValueBulkMax: 500,
      taskStaleActiveDays: 7,
      taskStalePlannedDays: 14,
      taskRescheduleCount: 3,
      taskRescheduleWindowDays: 14,
      taskRemindersMax: 10,
      reminderFireBatchMax: 500,
      taskSnoozeMaxDays: 365,
      bulkItemsMax: 200,
      bulkPreviewTtlSeconds: 600,
      undoWindowSeconds: 30,
      duplicateWindowDays: 90,
      duplicateCandidatesMax: 5,
      captureTextMax: 10000,
      capturePasteLinesMax: 100,
      captureLinksMax: 10,
      captureFilesMax: 10,
      captureParseTokensMax: 64,
      captureRatePerMinute: 60,
      triageBatchMax: 50,
      inboxMergeMax: 20,
      intakeFormsMax: 50,
      intakeSubmissionsPerHour: 20,
      queryConditionsMax: 40,
      queryDepthMax: 3,
      querySortsMax: 5,
      queryValuesMax: 100,
      queryGroupsMax: 200,
      viewColumnsMax: 20,
      savedViewsMax: 200,
      viewPinsMax: 20,
      exportRowsMax: 5000,
      totalCountCap: 10000,
      layoutItemsMax: 200,
      workloadDaysMax: 366,
      activityRecordsMax: 500,
      availabilityWindowsMax: 28,
      timeOffEntriesMax: 500,
      brandHolidaysMax: 1000,
      capacityRangeDaysMax: 93,
      capacityPeopleMax: 100,
      timeEntryMaxHours: 24,
      timeTimerMaxHours: 12,
      timeReportRangeDaysMax: 366,
      timeReportRowsMax: 500,
      timeExportRowsMax: 10_000,
      timeTimesheetEntriesMax: 2000,
      timeRunawayDiscoveryMax: 100,
      timeRunawayBatchMax: 200,
      todayItemsMax: 100,
      todayListMax: 50,
      upcomingDeadlineDays: 14,
      workBlocksPerDayMax: 50,
      workBlocksRangeDaysMax: 42,
      blockSeriesMax: 50,
      blockSeriesHorizonDays: 28,
      dayCloseDiscoveryMax: 100,
      dayCloseBatchMax: 200,
    });
    const set = (env: Record<string, string>) =>
      loadServerConfig({ service: 'worker', env: { ...local, ...env } });
    expect(
      set({ RECURRENCE_WORKSPACE_DISCOVERY_MAX: '1', RECURRENCE_SERIES_DISCOVERY_MAX: '1' }).work,
    ).toMatchObject({
      recurrenceWorkspaceDiscoveryMax: 1,
      recurrenceSeriesDiscoveryMax: 1,
    });
    expect(
      set({ RECURRENCE_WORKSPACE_DISCOVERY_MAX: '1000', RECURRENCE_SERIES_DISCOVERY_MAX: '500' })
        .work,
    ).toMatchObject({
      recurrenceWorkspaceDiscoveryMax: 1000,
      recurrenceSeriesDiscoveryMax: 500,
    });
    for (const [key, bad] of [
      ['RECURRENCE_WORKSPACE_DISCOVERY_MAX', '0'],
      ['RECURRENCE_WORKSPACE_DISCOVERY_MAX', '1001'],
      ['RECURRENCE_SERIES_DISCOVERY_MAX', '0'],
      ['RECURRENCE_SERIES_DISCOVERY_MAX', '501'],
      ['RECURRENCE_SERIES_DISCOVERY_MAX', '2.5'],
      // 2C bounds (0D PL-25): every range edge is refused outside its registered range.
      ['WORKFLOW_STATUSES_MAX', '1'],
      ['APPROVAL_EXPIRY_HOURS', '2161'],
      ['TRANSITION_PREVIEW_TTL_SECONDS', '59'],
      ['FIELD_TEXT_MAX', '20001'],
      ['FORMULA_DEPTH_MAX', '33'],
      ['FORMULA_AST_NODES_MAX', '9'],
      ['FIELD_VALUE_BULK_MAX', '0'],
      ['UNDO_WINDOW_SECONDS', '301'],
      ['BULK_ITEMS_MAX', '0'],
      ['TASK_STALE_ACTIVE_DAYS', '91'],
      ['CAPTURE_PASTE_LINES_MAX', '501'],
      ['INBOX_MERGE_MAX', '1'],
      ['TIME_TIMER_MAX_HOURS', '25'],
      ['TIME_EXPORT_ROWS_MAX', '99'],
      ['BLOCK_SERIES_HORIZON_DAYS', '181'],
      ['TODAY_LIST_MAX', '4'],
    ] as const)
      expect(issues(() => set({ [key]: bad })).join(' '), `${key}=${bad}`).toMatch(
        new RegExp(`^${key}`),
      );
  });

  it('rejects missing secrets and wrong identities', () => {
    expect(issues(() => loadServerConfig({ service: 'api', env: { APP_ENV: 'local' } }))).toContain(
      'DATABASE_APP_URL: required for the api process',
    );
    expect(
      issues(() =>
        loadServerConfig({ service: 'api', env: { ...local, DATABASE_APP_URL: url('migrator') } }),
      ),
    ).toContain('DATABASE_APP_URL: must authenticate as role app_rw');
    expect(
      issues(() =>
        loadServerConfig({
          service: 'worker',
          env: { ...local, DATABASE_WORKER_URL: url('app_rw') },
        }),
      ),
    ).toContain('DATABASE_WORKER_URL: must authenticate as role app_worker');
  });

  it('a complete production configuration fails only on the identity vendors not yet approved', () => {
    // No production secret store/KMS or mail provider is approved (DQ-28, roadmap): production
    // must refuse to start rather than fall back to development adapters.
    expect(
      issues(() => loadServerConfig({ service: 'worker', env: deployed('production') })),
    ).toEqual([
      'SECRET_VAULT: a secret store is required for the worker process (identity secrets)',
      'MAIL_TRANSPORT: a mail transport is required for the worker process',
    ]);
    expect(
      loadServerConfig({
        service: 'migrate',
        env: { ...deployed('production'), DATABASE_MIGRATOR_URL: strong('migrator', 'production') },
      }).env,
    ).toBe('production');
  });

  it('rejects unsafe production defaults', () => {
    const found = issues(() =>
      loadServerConfig({
        service: 'api',
        env: deployed('production', {
          DATABASE_APP_URL: 'postgres://app_rw:dev@db.internal:5432/pm_production',
          PUBLIC_BASE_URL: 'http://app.example.test',
          LOG_LEVEL: 'debug',
          BUILD_ID: 'dev',
        }),
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        'DATABASE_APP_URL: TLS is required (sslmode=require or verify-full)',
        'DATABASE_APP_URL: credential is missing, too short, or a known development value',
        'PUBLIC_BASE_URL: must use https in deployed environments',
        'LOG_LEVEL: debug is not allowed in production',
        'BUILD_ID/BUILD_VERSION: development build identifiers are not allowed',
      ]),
    );
  });

  it('requires deployed environments to set values explicitly instead of inheriting local defaults', () => {
    const { HTTP_HOST: _h, PUBLIC_BASE_URL: _p, ...rest } = deployed('staging');
    expect(issues(() => loadServerConfig({ service: 'api', env: rest }))).toEqual(
      expect.arrayContaining([
        'HTTP_HOST: required in staging',
        'PUBLIC_BASE_URL: required in staging',
      ]),
    );
  });

  it('keeps preview, staging, and production database namespaces apart', () => {
    const crossed = issues(() =>
      loadServerConfig({
        service: 'api',
        env: deployed('staging', { DATABASE_APP_URL: strong('app_rw', 'production') }),
      }),
    );
    expect(crossed).toContain(
      'DATABASE_APP_URL: database name must belong to the staging namespace (pm_staging[_suffix])',
    );
    const split = issues(() =>
      loadServerConfig({
        service: 'worker',
        env: deployed('preview', {
          DATABASE_WORKER_URL: strong('app_worker', 'preview').replace(
            'pm_preview',
            'pm_preview_pr42',
          ),
        }),
      }),
    );
    expect(split).toContain(
      'database URLs: all identities of one process must target the same database',
    );
  });

  it('never hands operational identities to application processes in deployed environments', () => {
    expect(
      issues(() =>
        loadServerConfig({
          service: 'api',
          env: deployed('production', { DATABASE_MIGRATOR_URL: strong('migrator', 'production') }),
        }),
      ),
    ).toContain('DATABASE_MIGRATOR_URL: must not be provided to the api process');
  });

  it('rejects secret-store references until a provider is selected (DQ-28)', () => {
    expect(
      issues(() =>
        loadServerConfig({
          service: 'api',
          env: { ...local, DATABASE_APP_URL: 'secretref:pm/app' },
        }),
      )[0],
    ).toMatch(/secret-store provider/);
  });

  it('validates job parameters against 0D rules', () => {
    expect(
      issues(() =>
        loadServerConfig({
          service: 'worker',
          env: { ...local, JOB_LEASE_DURATION_MS: '3000', JOB_HEARTBEAT_INTERVAL_MS: '1500' },
        }),
      ),
    ).toContain(
      'JOB_HEARTBEAT_INTERVAL_MS: must be less than a third of JOB_LEASE_DURATION_MS (0D §7.3)',
    );
  });

  it('redacts secrets in dumps, JSON, string conversion, and inspection', () => {
    const c = loadServerConfig({ service: 'worker', env: local });
    const dump = JSON.stringify(describeConfig(c));
    expect(dump).not.toContain('pw_app_worker');
    expect(dump).toContain('[REDACTED]');
    const s = new Secret('hunter2');
    expect(`${s}`).toBe('[REDACTED]');
    expect(JSON.stringify({ s })).toBe('{"s":"[REDACTED]"}');
    expect(inspect({ s })).not.toContain('hunter2');
    expect(s.reveal()).toBe('hunter2');
  });

  it('error messages never echo values', () => {
    try {
      loadServerConfig({
        service: 'api',
        env: { ...local, DATABASE_APP_URL: 'postgres://migrator:SuperSecret@h/db' }, // gitleaks:allow (synthetic)
      });
    } catch (e) {
      expect(String(e)).not.toContain('SuperSecret');
    }
  });
});

describe('identity configuration (1B)', () => {
  const key = Buffer.alloc(32, 9).toString('base64url');
  const idLocal = {
    ...local,
    AUTH_SIGNING_KEY: key,
    SECRET_VAULT: 'dev-database',
    DEV_VAULT_KEY: key,
    MAIL_TRANSPORT: 'capture',
  };

  it('requires a signing key and a secret store for identity processes', () => {
    const { AUTH_SIGNING_KEY: _k, SECRET_VAULT: _v, ...bare } = local;
    expect(issues(() => loadServerConfig({ service: 'api', env: bare }))).toEqual(
      expect.arrayContaining([
        'AUTH_SIGNING_KEY: required for the api process',
        'SECRET_VAULT: a secret store is required for the api process (identity secrets)',
      ]),
    );
    expect(loadServerConfig({ service: 'api', env: idLocal }).identity.cookieSecure).toBe(true);
    expect(
      issues(() =>
        loadServerConfig({ service: 'api', env: { ...idLocal, AUTH_SIGNING_KEY: 'short' } }),
      )[0],
    ).toMatch(/AUTH_SIGNING_KEY: must be base64url/);
  });

  it('refuses development adapters and insecure cookies in deployed environments', () => {
    const found = issues(() =>
      loadServerConfig({
        service: 'api',
        env: deployed('production', {
          AUTH_SIGNING_KEY: key,
          SECRET_VAULT: 'dev-database',
          DEV_VAULT_KEY: key,
          MAIL_TRANSPORT: 'capture',
          OAUTH_PROVIDERS: 'local',
          BOT_PROTECTION: 'test',
          COOKIE_SECURE: 'false',
        }),
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        'COOKIE_SECURE: insecure cookies are allowed only in local and test',
        'OAUTH_PROVIDERS: the local test provider is not allowed in deployed environments',
        'MAIL_TRANSPORT: capture is a development transport; no production mail provider is approved',
        'SECRET_VAULT: dev-database is a development store; no secret store/KMS is approved (DQ-28)',
        'BOT_PROTECTION: the test adapter is not allowed in deployed environments',
      ]),
    );
  });

  it('validates session timing and rate-limit overrides', () => {
    expect(
      issues(() =>
        loadServerConfig({
          service: 'api',
          env: {
            ...idLocal,
            SESSION_IDLE_TIMEOUT_MS: '7200000',
            SESSION_ABSOLUTE_TIMEOUT_MS: '3600000',
          },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        'SESSION_IDLE_TIMEOUT_MS: must not exceed SESSION_ABSOLUTE_TIMEOUT_MS',
      ]),
    );
    expect(
      issues(() =>
        loadServerConfig({ service: 'api', env: { ...idLocal, RATE_LIMIT_POLICIES: '{"x": 1}' } }),
      )[0],
    ).toMatch(/RATE_LIMIT_POLICIES/);
    const ok = loadServerConfig({
      service: 'api',
      env: { ...idLocal, RATE_LIMIT_POLICIES: '{"sign_in.email":{"limit":3,"windowMs":60000}}' },
    });
    expect(ok.identity.rateLimitOverrides).toEqual({
      'sign_in.email': { limit: 3, windowMs: 60000 },
    });
    expect(ok.identity.argon2).toEqual({
      memoryKiB: 65536,
      passes: 3,
      parallelism: 1,
      maxConcurrency: 4,
    });
  });
});

describe('lifecycle configuration (1F)', () => {
  it('leaves every retention period undecided by default and validates explicit values', () => {
    const cfg = loadServerConfig({ service: 'worker', env: local });
    expect(cfg.lifecycle).toEqual({
      retentionPeriodsMs: {},
      purgeLedger: 'none',
      purgeLedgerDir: undefined,
    });
    expect(cfg.features.componentHarness).toBe(false);
    expect(cfg.audit.chainLockWaitWarnMs).toBe(250);
    expect(
      loadServerConfig({
        service: 'worker',
        env: { ...local, AUDIT_CHAIN_LOCK_WAIT_WARN_MS: '50' },
      }).audit.chainLockWaitWarnMs,
    ).toBe(50);
    expect(
      issues(() =>
        loadServerConfig({
          service: 'worker',
          env: { ...local, AUDIT_CHAIN_LOCK_WAIT_WARN_MS: '0' },
        }),
      )[0],
    ).toMatch(/AUDIT_CHAIN_LOCK_WAIT_WARN_MS/);
    const set = loadServerConfig({
      service: 'worker',
      env: { ...local, RETENTION_PERIODS: '{"R-LIVE": 3600000}' },
    });
    expect(set.lifecycle.retentionPeriodsMs).toEqual({ 'R-LIVE': 3600000 });
    for (const bad of [
      '{"R-UNKNOWN": 3600000}',
      '{"R-LIVE": 5}',
      '{"R-LIVE": "30 days"}',
      'not json',
    ])
      expect(
        issues(() =>
          loadServerConfig({ service: 'worker', env: { ...local, RETENTION_PERIODS: bad } }),
        )[0],
        bad,
      ).toMatch(/RETENTION_PERIODS/);
  });

  it('refuses the local purge ledger and the component harness in deployed environments', () => {
    const found = issues(() =>
      loadServerConfig({
        service: 'worker',
        env: deployed('staging', {
          PURGE_LEDGER: 'local',
          PURGE_LEDGER_DIR: '/tmp/l',
          COMPONENT_HARNESS: 'true',
        }),
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        'PURGE_LEDGER: the local ledger is a development adapter; no ledger store is approved',
        'COMPONENT_HARNESS: the component harness is allowed only in local and test',
      ]),
    );
    expect(
      issues(() =>
        loadServerConfig({ service: 'worker', env: { ...local, PURGE_LEDGER: 'local' } }),
      ),
    ).toContain('PURGE_LEDGER_DIR: required with the local purge ledger');
  });
});
