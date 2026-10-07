# Environments, configuration, and secrets

## Modes

`APP_ENV` is required and has no default: `local`, `test`, `preview`, `staging`, `production`.

| Mode | `.env` read? | Defaults | Extra rules |
|---|---|---|---|
| `local` | Yes (only mode) | Conservative local defaults | — |
| `test` | No | Same defaults | Used by automated tests and CI |
| `preview`, `staging`, `production` | No | Operational parameters only (timeouts, job parameters) | Build/HTTP/log/trace/public-URL values must be set explicitly; database names must be in the `pm_<env>[_suffix]` namespace; TLS required (`sslmode=require` or `verify-full`); development-looking or short credentials rejected; `https` public URL; no development build IDs |
| `production` | No | as above | `LOG_LEVEL=debug` rejected |

Configuration is validated at startup (`packages/config`). Any violation stops the process with a
list of rule names; values are never printed.

## Database identities

Each process receives only its own identities (0C §12.3). The startup guard additionally checks
`current_user`, that the role is not a superuser, has no `BYPASSRLS`, owns nothing, cannot act as
the owner, and that the database's recorded environment (`ops.environment_binding`) equals `APP_ENV`.

| Variable | Login role | Used by |
|---|---|---|
| `DATABASE_APP_URL` | `app_rw` | web/API |
| `DATABASE_WORKER_URL` | `app_worker` | worker (tenant work) |
| `DATABASE_DISPATCHER_URL` | `dispatcher` | worker (payload-free scheduling functions only) |
| `DATABASE_MIGRATOR_URL` | `migrator` | `migrate` command / CI deploy step only |
| `DATABASE_RESTORE_URL` | `restore_operator` | restore tooling only (break-glass) |

In deployed modes, providing `DATABASE_MIGRATOR_URL` or `DATABASE_RESTORE_URL` to the web/API or
worker process is a startup error. All identities of one process must target the same database.

## Environment-variable contract (provider-neutral)

| Variable | Web/API | Worker | Notes |
|---|---|---|---|
| `APP_ENV` | required | required | mode |
| `BUILD_VERSION`, `BUILD_ID` | required (deployed) | required (deployed) | baked into the image by build args |
| `HTTP_HOST`, `HTTP_PORT` | required (deployed) | — | image default `0.0.0.0:3000` |
| `HTTP_TRUST_PROXY` | required (deployed) | — | `true` behind the load balancer |
| `HTTP_BODY_LIMIT_BYTES` | optional | — | `payload_too_large` above it |
| `PUBLIC_BASE_URL` | required (deployed) | — | https |
| `WEB_DIST_DIR` | optional | — | image default `/app/web/dist` |
| `LOG_LEVEL` | required (deployed) | required (deployed) | `debug` not allowed in production |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional | optional | OTLP/HTTP collector; no vendor SDK |
| `TRACE_SAMPLE_RATIO` | required (deployed) | required (deployed) | head sampling, parent-based |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT_MS` | optional | optional | named implementation parameters; defaults 10 / 15 s / 5 s / 30 s / 5 s |
| `JOB_LEASE_DURATION_MS`, `JOB_HEARTBEAT_INTERVAL_MS`, `JOB_BACKOFF_BASE_MS`, `JOB_BACKOFF_CAP_MS`, `JOB_MAX_ATTEMPTS`, `JOB_TIMEOUT_MS`, `WORKSPACE_CONCURRENCY_CAP` | — | optional | 0D named parameters; defaults 30 s / 9 s / 1 s / 300 s / 5 / 60 s / 2. Heartbeat must be < lease/3 |
| `WORKER_POLL_INTERVAL_MS`, `WORKER_CLAIM_BATCH_SIZE`, `WORKER_SHUTDOWN_GRACE_MS` | — | optional | 1 s / 10 / 20 s |
| `IDEMPOTENCY_RETENTION_MS`, `OUTBOX_REPLAY_WINDOW_MS` | optional | optional | 0D parameters; defaults 72 h / 1 h |
| `READINESS_REQUIRE_DISPATCHER`, `READINESS_DISPATCHER_STALE_MS` | optional | — | default `true` / 30 s |
| `WORKER_HEALTH_FILE` | — | optional | image default `/tmp/pm-worker-health` |
| `AUTH_SIGNING_KEY` | required | — | base64url, ≥ 32 bytes; CSRF tokens and rate-limit keys (1B) |
| `ALLOWED_ORIGINS` | optional | — | extra origins besides `PUBLIC_BASE_URL`; https only when deployed |
| `COOKIE_SECURE` | optional | — | default `true`; `false` allowed only in `local`/`test` |
| `SECRET_PROVIDER` | optional | optional | `env` (the only provider); `secretref:` values are refused until a secret store is approved (DQ-28) |
| `SECRET_VAULT` | required | required | `dev-database` (local/test only) or `none`; a KMS adapter needs approval (ADR-0008) |
| `DEV_VAULT_KEY` | with `dev-database` | with `dev-database` | base64url 32 bytes; refused in deployed modes |
| `MAIL_TRANSPORT`, `MAIL_FROM`, `MAIL_CAPTURE_DIR`, `MAIL_RETENTION_MS` | — | required / optional | `capture` (local/test only) or `none`; no vendor approved |
| `OAUTH_PROVIDERS` | optional | — | comma list; only `local` exists (local/test only) |
| `BOT_PROTECTION` | optional | — | `none` or `test` (local/test only) |
| `SESSION_*`, `EMAIL_VERIFICATION_TOKEN_MS`, `PASSWORD_RESET_TOKEN_MS`, `SIGN_IN_CONTINUATION_MS`, `OAUTH_STATE_MS`, `RESEND_COOLDOWN_MS`, `STEP_UP_*`, `ARGON2_*`, `AUTH_RESPONSE_FLOOR_MS`, `RATE_LIMIT_POLICIES`, `LEGAL_TERMS_VERSION`, `LEGAL_PRIVACY_VERSION` | optional | optional | identity operational defaults, see [identity.md](identity.md); not published promises |
| `RETENTION_PERIODS` | optional | optional | JSON `{"<retention class>": <ms>}`; **unset by default** = every period undecided, so no scheduled purge runs (1F) |
| `PURGE_LEDGER`, `PURGE_LEDGER_DIR` | — | optional | `none` (default: purge blocks before deleting) or `local` (development adapter, refused when deployed) |
| `COMPONENT_HARNESS` | optional | — | `false` by default; `true` only in local/test (renders `/_harness/lifecycle`) |
| `AUDIT_CHAIN_LOCK_WAIT_WARN_MS` | optional | optional | default 250; operational warning threshold for audit-chain lock waits (not a promise; see audit.md) |
| `INVITATION_LIFETIME_MS` | optional | optional | default 7 days; how long an invitation link stays acceptable (0D `INVITATION_LIFETIME`) |
| `OWNERSHIP_TRANSFER_LIFETIME_MS` | optional | optional | default 3 days; pending ownership transfers expire after this (0D `OWNERSHIP_TRANSFER_LIFETIME`) |
| `PRINCIPAL_CONTEXT_ARRAY_MAX` | optional | optional | default 10000; visibility arrays above this use a transaction-scoped temporary table (0D `PRINCIPAL_CONTEXT_ARRAY_MAX`) |
| `FAVORITES_MAX` | optional | optional | default 200; most favorites per person per workspace (0D `FAVORITES_MAX`) |
| `RECENT_ITEMS_MAX` | optional | optional | default 50; recently viewed entries kept per person per workspace (0D `RECENT_ITEMS_MAX`) |
| `RECENT_VISIT_COALESCE_MS` | optional | optional | default 30000; repeat visits within this window are not written again (0D `RECENT_VISIT_COALESCE`) |
| `VIEW_STATE_MAX_BYTES` | optional | optional | default 8192 (1024–16384); largest stored view state per view and device (0D `VIEW_STATE_MAX_BYTES`) |
| `PROJECT_DEPTH_MAX` | optional | optional | default 10 (1–32); deepest project level a command accepts, root = 0 (0D `PROJECT_DEPTH_MAX`). The database keeps an invariant ceiling of 32 |
| `TEMPLATE_ITEMS_MAX` | optional | optional | default 500 (1–500); most items in one template version or recurrence snapshot (0D `TEMPLATE_ITEMS_MAX`) |
| `RECURRENCE_CATCHUP_MAX` | optional | optional | default 12 (1–100); most missed occurrences one series generates per worker run (0D `RECURRENCE_CATCHUP_MAX`) |
| `RECURRENCE_WORKSPACE_DISCOVERY_MAX` | optional | optional | default 200 (1–1000); most workspaces with due recurrence work one job run visits, oldest-waiting first (0D `RECURRENCE_WORKSPACE_DISCOVERY_MAX`) |
| `RECURRENCE_SERIES_DISCOVERY_MAX` | optional | optional | default 50 (1–500); most due series one run processes per workspace, oldest-waiting first (0D `RECURRENCE_SERIES_DISCOVERY_MAX`) |
| `TASK_DEPTH_MAX` | optional | optional | default 20 (1–64); deepest subtask level a command accepts, root = 0 (0D `TASK_DEPTH_MAX`). The database keeps an invariant ceiling of 64 |
| `TASK_SUBTREE_MAX` | optional | optional | default 500 (1–5000); most tasks one subtree move, lifecycle command, or duplicate touches (0D `TASK_SUBTREE_MAX`) |
| `TASK_ITEMS_MAX` | optional | optional | default 200 (1–1000); most checklist items, criteria items, or links per task, each kind counted separately (0D `TASK_ITEMS_MAX`) |
| `TASK_ASSIGNEES_MAX` | optional | optional | default 20 (1–100); most assignees on one task (0D `TASK_ASSIGNEES_MAX`) |
| `TASK_LABELS_MAX` | optional | optional | default 50 (1–200); most labels on one task (0D `TASK_LABELS_MAX`) |
| `BRAND_LABELS_MAX` | optional | optional | default 1000 (1–10000); most labels in one brand (0D `BRAND_LABELS_MAX`) |
| `TASK_ESTIMATE_MINUTES_MAX` | optional | optional | default 100000 (60–1000000); largest estimate or remaining estimate in minutes (0D `TASK_ESTIMATE_MINUTES_MAX`) |
| `PAGE_LIMIT_DEFAULT` | optional | optional | default 50 (1–200, never above `PAGE_LIMIT_MAX`); page size for task lists (0D `PAGE_LIMIT_DEFAULT`) |
| `PAGE_LIMIT_MAX` | optional | optional | default 200 (1–200); largest page for task and project lists (0D `PAGE_LIMIT_MAX`) |
| `WORKFLOW_STATUSES_MAX` | optional | optional | default 50 (2–200); most statuses in one workflow (0D `WORKFLOW_STATUSES_MAX`) |
| `WORKFLOW_TRANSITIONS_MAX` | optional | optional | default 400 (1–2000); most transitions in one workflow (0D `WORKFLOW_TRANSITIONS_MAX`) |
| `TRANSITION_REQUIREMENTS_MAX` | optional | optional | default 30 (1–100); most required fields on one transition (0D `TRANSITION_REQUIREMENTS_MAX`) |
| `TRANSITION_APPROVERS_MAX` | optional | optional | default 10 (1–50); most named approvers on one transition (0D `TRANSITION_APPROVERS_MAX`) |
| `APPROVAL_EXPIRY_HOURS` | optional | optional | default 168 (1–2160); how long an approval request stays valid (0D `APPROVAL_EXPIRY_HOURS`) |
| `TRANSITION_PREVIEW_TTL_SECONDS` | optional | optional | default 600 (60–3600); lifetime of a signed transition preview fingerprint (0D `TRANSITION_PREVIEW_TTL_SECONDS`) |
| `FIELD_DEFINITIONS_MAX` | optional | optional | default 200 (1–1000); most active field definitions at one scope (0D `FIELD_DEFINITIONS_MAX`) |
| `FIELD_OPTIONS_MAX` | optional | optional | default 200 (2–1000); most options on one select field (0D `FIELD_OPTIONS_MAX`) |
| `FIELD_SETS_MAX` | optional | optional | default 100 (1–500); most active field sets at one scope (0D `FIELD_SETS_MAX`) |
| `FIELD_SET_ITEMS_MAX` | optional | optional | default 100 (1–500); most definitions in one field set version (0D `FIELD_SET_ITEMS_MAX`) |
| `FIELD_TEXT_MAX` | optional | optional | default 5000 (1–20000); longest custom text value in characters (0D `FIELD_TEXT_MAX`) |
| `FIELD_PATTERN_MAX` | optional | optional | default 200 (1–1000); longest validation pattern in characters (0D `FIELD_PATTERN_MAX`) |
| `FORMULA_SOURCE_MAX` | optional | optional | default 2000 (10–10000); longest formula source in characters (0D `FORMULA_SOURCE_MAX`) |
| `FORMULA_AST_NODES_MAX` | optional | optional | default 200 (10–2000); most nodes in a compiled formula (0D `FORMULA_AST_NODES_MAX`) |
| `FORMULA_DEPTH_MAX` | optional | optional | default 8 (1–32); deepest formula dependency chain (0D `FORMULA_DEPTH_MAX`) |
| `FORMULA_REFS_MAX` | optional | optional | default 20 (1–100); most field references in one formula (0D `FORMULA_REFS_MAX`) |
| `FIELD_VALUE_BULK_MAX` | optional | optional | default 500 (1–5000); most records migrated by one status or option replacement command (0D `FIELD_VALUE_BULK_MAX`) |
| `TASK_STALE_ACTIVE_DAYS` | optional | optional | default 7 (1–90); days without a meaningful update before an active or blocked task is stale (OD-17) (0D `TASK_STALE_ACTIVE_DAYS`) |
| `TASK_STALE_PLANNED_DAYS` | optional | optional | default 14 (1–180); days without a meaningful update before a planned task is stale (OD-17) (0D `TASK_STALE_PLANNED_DAYS`) |
| `TASK_RESCHEDULE_COUNT` | optional | optional | default 3 (2–20); material due-date or deadline edits within the window that mark a task repeatedly rescheduled (OD-17) (0D `TASK_RESCHEDULE_COUNT`) |
| `TASK_RESCHEDULE_WINDOW_DAYS` | optional | optional | default 14 (1–90); window for counting reschedules (OD-17) (0D `TASK_RESCHEDULE_WINDOW_DAYS`) |
| `TASK_REMINDERS_MAX` | optional | optional | default 10 (1–50); most scheduled reminders one person holds on one task (0D `TASK_REMINDERS_MAX`) |
| `REMINDER_FIRE_BATCH_MAX` | optional | optional | default 500 (1–5000); most due reminders one worker run fires per workspace (0D `REMINDER_FIRE_BATCH_MAX`) |
| `TASK_SNOOZE_MAX_DAYS` | optional | optional | default 365 (1–3650); furthest a snooze may reach (0D `TASK_SNOOZE_MAX_DAYS`) |
| `BULK_ITEMS_MAX` | optional | optional | default 200 (1–1000); most tasks in one bulk command's explicit set (0D `BULK_ITEMS_MAX`) |
| `BULK_PREVIEW_TTL_SECONDS` | optional | optional | default 600 (60–3600); how long a bulk preview may be executed (0D `BULK_PREVIEW_TTL_SECONDS`) |
| `UNDO_WINDOW_SECONDS` | optional | optional | default 30 (5–300); how long a reversible task change can be undone (0D `UNDO_WINDOW_SECONDS`) |
| `DUPLICATE_WINDOW_DAYS` | optional | optional | default 90 (1–365); how far back deterministic duplicate matching looks (0D `DUPLICATE_WINDOW_DAYS`) |
| `DUPLICATE_CANDIDATES_MAX` | optional | optional | default 5 (1–20); most duplicate candidates returned (0D `DUPLICATE_CANDIDATES_MAX`) |
| `CAPTURE_TEXT_MAX` | optional | optional | default 10000 (100–50000); most characters in one capture or note body (0D `CAPTURE_TEXT_MAX`) |
| `CAPTURE_PASTE_LINES_MAX` | optional | optional | default 100 (1–500); most candidate items one paste may create (0D `CAPTURE_PASTE_LINES_MAX`) |
| `CAPTURE_LINKS_MAX` | optional | optional | default 10 (0–50); most links attached to one capture (0D `CAPTURE_LINKS_MAX`) |
| `CAPTURE_FILES_MAX` | optional | optional | default 10 (0–50); most file references attached to one capture (refused until 4E storage) (0D `CAPTURE_FILES_MAX`) |
| `CAPTURE_PARSE_TOKENS_MAX` | optional | optional | default 64 (8–256); most tokens the deterministic parser examines per line (0D `CAPTURE_PARSE_TOKENS_MAX`) |
| `CAPTURE_RATE_PER_MINUTE` | optional | optional | default 60 (1–600); most capture commands one person may run per minute (0D `CAPTURE_RATE_PER_MINUTE`) |
| `TRIAGE_BATCH_MAX` | optional | optional | default 50 (1–200); most Inbox items one triage command may change (0D `TRIAGE_BATCH_MAX`) |
| `INBOX_MERGE_MAX` | optional | optional | default 20 (2–100); most Inbox items one merge may combine (0D `INBOX_MERGE_MAX`) |
| `INTAKE_FORMS_MAX` | optional | optional | default 50 (1–500); most intake forms per brand (0D `INTAKE_FORMS_MAX`) |
| `INTAKE_SUBMISSIONS_PER_HOUR` | optional | optional | default 20 (1–1000); most submissions one person may make to one form per hour (0D `INTAKE_SUBMISSIONS_PER_HOUR`) |
| `QUERY_CONDITIONS_MAX` | optional | optional | default 40 (1–200); most conditions one view query may combine (0D `QUERY_CONDITIONS_MAX`) |
| `QUERY_DEPTH_MAX` | optional | optional | default 3 (1–6); deepest nesting of AND/OR filter groups (0D `QUERY_DEPTH_MAX`) |
| `QUERY_SORTS_MAX` | optional | optional | default 5 (1–10); most sort keys in one view query (0D `QUERY_SORTS_MAX`) |
| `QUERY_VALUES_MAX` | optional | optional | default 100 (1–500); most values one filter condition may list (0D `QUERY_VALUES_MAX`) |
| `QUERY_GROUPS_MAX` | optional | optional | default 200 (10–1000); most groups one grouped query returns (0D `QUERY_GROUPS_MAX`) |
| `VIEW_COLUMNS_MAX` | optional | optional | default 20 (1–50); most visible columns in one view (0D `VIEW_COLUMNS_MAX`) |
| `SAVED_VIEWS_MAX` | optional | optional | default 200 (1–2000); most saved views one person may own in a workspace (0D `SAVED_VIEWS_MAX`) |
| `VIEW_PINS_MAX` | optional | optional | default 20 (1–100); most views pinned into one workspace or brand navigation (0D `VIEW_PINS_MAX`) |
| `EXPORT_ROWS_MAX` | optional | optional | default 5000 (1–50000); most rows one direct view export may contain (0D `EXPORT_ROWS_MAX`) |
| `LAYOUT_ITEMS_MAX` | optional | optional | default 200 (10–1000); most records one layout read (dependencies, milestones, progress, time) may name (0D `LAYOUT_ITEMS_MAX`) |
| `WORKLOAD_DAYS_MAX` | optional | optional | default 366 (7–731); longest date range one workload grid may cover (0D `WORKLOAD_DAYS_MAX`) |
| `ACTIVITY_RECORDS_MAX` | optional | optional | default 500 (10–5000); most records whose activity one activity view reads (0D `ACTIVITY_RECORDS_MAX`) |
| `TOTAL_COUNT_CAP` | optional | optional | default 10000 (100–100000); exact totals above this are reported as capped (0D `TOTAL_COUNT_CAP`) |
| `TIME_ENTRY_MAX_HOURS` | optional | optional | default 24 (1–24); longest single time entry or timer run, in hours (0D `TIME_ENTRY_MAX_HOURS`) |
| `TIME_TIMER_MAX_HOURS` | optional | optional | default 12 (1–24); hours after which a still-running timer is stopped automatically by the timer guard (0D `TIME_TIMER_MAX_HOURS`) |
| `TIME_REPORT_RANGE_DAYS_MAX` | optional | optional | default 366 (7–1830); widest date range one time report, timesheet list, or export may cover, in days (0D `TIME_REPORT_RANGE_DAYS_MAX`) |
| `TIME_REPORT_ROWS_MAX` | optional | optional | default 500 (10–5000); most rows (groups) one planned-versus-actual report returns (0D `TIME_REPORT_ROWS_MAX`) |
| `TIME_EXPORT_ROWS_MAX` | optional | optional | default 10000 (100–50000); most time entries one direct export may contain (0D `TIME_EXPORT_ROWS_MAX`) |
| `TIME_TIMESHEET_ENTRIES_MAX` | optional | optional | default 2000 (10–10000); most time entries one person may have in one timesheet period (0D `TIME_TIMESHEET_ENTRIES_MAX`) |
| `TIME_RUNAWAY_DISCOVERY_MAX` | optional | optional | default 100 (1–1000); most workspaces one timer-guard run examines (0D `TIME_RUNAWAY_DISCOVERY_MAX`) |
| `TIME_RUNAWAY_BATCH_MAX` | optional | optional | default 200 (1–1000); most runaway timers one timer-guard run stops per workspace (0D `TIME_RUNAWAY_BATCH_MAX`) |
| `TODAY_ITEMS_MAX` | optional | optional | default 100 (1–500); most Today commitments one person may have on one day (0D `TODAY_ITEMS_MAX`) |
| `TODAY_LIST_MAX` | optional | optional | default 50 (5–200); most tasks one Today section (overdue, due today, upcoming deadlines) returns (0D `TODAY_LIST_MAX`) |
| `UPCOMING_DEADLINE_DAYS` | optional | optional | default 14 (1–90); how many days ahead Today lists upcoming deadlines (0D `UPCOMING_DEADLINE_DAYS`) |
| `WORK_BLOCKS_PER_DAY_MAX` | optional | optional | default 50 (1–200); most work blocks one person may have starting on one local day (0D `WORK_BLOCKS_PER_DAY_MAX`) |
| `WORK_BLOCKS_RANGE_DAYS_MAX` | optional | optional | default 42 (1–366); widest range of days one work-block listing may cover (0D `WORK_BLOCKS_RANGE_DAYS_MAX`) |
| `BLOCK_SERIES_MAX` | optional | optional | default 50 (1–500); most active recurring block series one person may have (0D `BLOCK_SERIES_MAX`) |
| `BLOCK_SERIES_HORIZON_DAYS` | optional | optional | default 28 (1–180); how many days ahead recurring work blocks are generated (0D `BLOCK_SERIES_HORIZON_DAYS`) |
| `DAY_CLOSE_DISCOVERY_MAX` | optional | optional | default 100 (1–1000); most workspaces one day-close or block-series run examines (0D `DAY_CLOSE_DISCOVERY_MAX`) |
| `DAY_CLOSE_BATCH_MAX` | optional | optional | default 200 (1–1000); most person-days one day-close run records per workspace (0D `DAY_CLOSE_BATCH_MAX`) |
| `VIEW_STATE_TTL_MS` | optional | optional | default 90 days; stored view state not written for this long is removed (0D `VIEW_STATE_TTL`) |

Values are configuration, not customer promises (PQ-05). The 0D parameter values above are
implementation defaults owned by 1A (`WORKSPACE_CONCURRENCY_CAP` is owned by 11C).

## Secrets boundary

- `Secret` wraps every credential; `String()`, JSON, and `util.inspect` render `[REDACTED]`; only
  `reveal()` (grep-able) returns the value. `describeConfig()` is safe to log.
- `.env` is read only in `local` mode. CI and deployments inject variables.
- `SecretProvider` is the adapter boundary for the managed secret store/KMS (DQ-28). Only the
  environment provider exists; values of the form `secretref:<name>` are rejected until a vendor is
  approved, rather than simulated.
- Images contain no `.env`, credentials, or test fixtures (checked by `scripts/image-smoke.sh`).
- `SecretVault` (1B) is the boundary for application-held secrets such as MFA seeds and in-flight
  mail tokens. Only `DevDatabaseVault` exists (AES-256-GCM in `ops.dev_secret_vault`), and every
  deployed mode refuses it at startup.

## Network contract

- Public ingress: load balancer (TLS termination) → web/API port 3000 only. `/healthz` and
  `/readyz` should be reachable only from the load balancer and monitoring (RELEASE_TOPOLOGY §4).
- Workers: no ingress. Egress to PostgreSQL and the OTLP collector (later: providers).
- PostgreSQL: private; reachable from web, worker, migrate, and restore identities only.
- Health: web/API container check `node /app/entrypoint.mjs healthcheck` (GET `/healthz`);
  worker check uses the same command (heartbeat file freshness). Load balancer readiness uses `/readyz`.
- Shutdown: `SIGTERM`. Web/API fails readiness, drains, and exits within 25 s. Worker stops claiming,
  finishes or releases leases within `WORKER_SHUTDOWN_GRACE_MS`, flushes telemetry, and exits.
  Set the orchestrator's termination grace above `WORKER_SHUTDOWN_GRACE_MS + 10 s`.

## Deployment sequence (when hosting is approved)

1. Build the image once (`docker build --build-arg BUILD_VERSION=… --build-arg BUILD_ID=<sha>`).
2. Once per database: provider admin runs `bootstrap` (or applies `packages/db/bootstrap/roles.sql`).
3. `migrate up` with the `migrator` identity (expand only). Contract migrations later with `--contract`.
4. Roll out `web` and `worker` replicas; gate traffic on `/readyz`.

Not provisioned in 1A (awaiting approval): hosting provider, first region (OD-43), CI provider,
secret store/KMS (DQ-28). GitHub Actions is configured as the default CI; `scripts/verify.sh` is the
provider-portable equivalent.
