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
| `OBJECT_STORAGE` | optional | optional | `none` (default: uploads unavailable), `s3` (any S3-compatible store, SigV4) or `local` (development adapter: filesystem directory with API-signed URLs; refused when deployed) (4E) |
| `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION` | with `s3` | with `s3` | bucket name and SigV4 signing region |
| `OBJECT_STORAGE_ENDPOINT` | optional | optional | S3-compatible endpoint URL; unset = AWS `https://s3.<region>.amazonaws.com`; https only when deployed |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | optional | optional | default `false` (virtual-host addressing); `true` for path-style stores such as MinIO |
| `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY` | with `s3` | with `s3` | access key pair; the secret key is held as a redacted secret and `secretref:` values are refused (DQ-28) |
| `OBJECT_STORAGE_LOCAL_DIR` | with `local` | with `local` | directory holding local objects |
| `OBJECT_STORAGE_LOCAL_SECRET` | with `local` | with `local` | base64url, ≥ 32 bytes; HMAC key for signed `/v1/storage/local/*` URLs |
| `OBJECT_STORAGE_PUBLIC_BASE_URL` | optional | optional | base URL the local signed URLs point at; defaults to `PUBLIC_BASE_URL`, else `http://127.0.0.1:<HTTP_PORT>` |
| `MALWARE_SCANNER` | optional | optional | `none` (default: files stay unscanned), `clamav` (clamd INSTREAM over TCP) or `test-signature` (EICAR-only development adapter; refused when deployed) (4E) |
| `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS` | with `clamav` | with `clamav` | clamd TCP address; port default 3310; timeout default 30000 ms (100–600000) |
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
| `AVAILABILITY_WINDOWS_MAX` | optional | optional | default 28 (7–56); most working windows one person may define per week (0D `AVAILABILITY_WINDOWS_MAX`) |
| `TIME_OFF_ENTRIES_MAX` | optional | optional | default 500 (10–5000); most time-off entries one person may keep (0D `TIME_OFF_ENTRIES_MAX`) |
| `BRAND_HOLIDAYS_MAX` | optional | optional | default 1000 (10–10000); most holidays one brand may keep (0D `BRAND_HOLIDAYS_MAX`) |
| `CAPACITY_RANGE_DAYS_MAX` | optional | optional | default 93 (7–366); longest date range one capacity read may cover (0D `CAPACITY_RANGE_DAYS_MAX`) |
| `CAPACITY_PEOPLE_MAX` | optional | optional | default 100 (1–1000); most people one team capacity read may include (0D `CAPACITY_PEOPLE_MAX`) |
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
| `COMMENT_BODY_MAX_CHARS` | optional | optional | default 10000 (100–50000); longest comment body, in characters of extracted text (0D `COMMENT_BODY_MAX_CHARS`) |
| `COMMENT_EDIT_WINDOW_MINUTES` | optional | optional | default 1440 (5–10080); how long after posting an author may edit or delete their own comment (the OD-38 audit window); moderators are not bound by it (0D `COMMENT_EDIT_WINDOW_MINUTES`) |
| `COMMENT_MENTIONS_MAX` | optional | optional | default 20 (1–100); most mentions one comment may carry (0D `COMMENT_MENTIONS_MAX`) |
| `COMMENTS_PER_RECORD_MAX` | optional | optional | default 5000 (100–50000); most comments (roots and replies, deleted ones included) one record may hold (0D `COMMENTS_PER_RECORD_MAX`) |
| `COMMENT_RATE_PER_MINUTE` | optional | optional | default 30 (1–600); most comments, replies, and edits one person may post per minute (0D `COMMENT_RATE_PER_MINUTE`) |
| `COMMENT_REPLIES_INLINE_MAX` | optional | optional | default 20 (1–100); most replies a comment list returns inline under each thread; more are fetched by cursor (0D `COMMENT_REPLIES_INLINE_MAX`) |
| `FOLLOWERS_LIST_MAX` | optional | optional | default 200 (10–1000); most followers one record's follower list returns (0D `FOLLOWERS_LIST_MAX`) |
| `REVIEW_REVIEWERS_MAX` | optional | optional | default 10 (1–50); most reviewers one review request may name (0D `REVIEW_REVIEWERS_MAX`) |
| `NOTIFY_FANOUT_RECIPIENTS_MAX` | optional | optional | default 500 (1–5000); most recipients one event fans out to (team mentions and follower lists are cut here) (0D `NOTIFY_FANOUT_RECIPIENTS_MAX`) |
| `NOTIFY_DEDUPE_WINDOW_MINUTES` | optional | optional | default 60 (1–1440); width of the time bucket in which repeated notifications of one kind about one record from one actor collapse into one (0D `NOTIFY_DEDUPE_WINDOW_MINUTES`) |
| `NOTIFY_DELIVERY_BATCH_MAX` | optional | optional | default 100 (1–1000); most deliveries one sweep claims per workspace (0D `NOTIFY_DELIVERY_BATCH_MAX`) |
| `NOTIFY_DELIVERY_MAX_ATTEMPTS` | optional | optional | default 6 (1–20); attempts before a transient delivery failure is dead-lettered (0D `NOTIFY_DELIVERY_MAX_ATTEMPTS`) |
| `NOTIFY_RETRY_BASE_SECONDS` | optional | optional | default 60 (5–3600); first retry delay; each later attempt doubles it (0D `NOTIFY_RETRY_BASE_SECONDS`) |
| `NOTIFY_RETRY_MAX_SECONDS` | optional | optional | default 3600 (60–86400); longest retry delay (0D `NOTIFY_RETRY_MAX_SECONDS`) |
| `NOTIFY_DIGEST_ITEMS_MAX` | optional | optional | default 50 (5–200); most items one digest lists (the rest stay in the notification centre) (0D `NOTIFY_DIGEST_ITEMS_MAX`) |
| `NOTIFY_EMAIL_PER_HOUR_MAX` | optional | optional | default 20 (1–200); most immediate emails one person receives per hour; more roll into their next digest (0D `NOTIFY_EMAIL_PER_HOUR_MAX`) |
| `NOTIFY_RETENTION_DAYS` | optional | optional | default 365 (30–3650); age after which a notification that is not saved is removed with its deliveries (a technical bound, not a published retention period: OD-36) (0D `NOTIFY_RETENTION_DAYS`) |
| `NOTIFY_PREFERENCES_MAX` | optional | optional | default 200 (10–1000); most preference and mute rows one person may keep (0D `NOTIFY_PREFERENCES_MAX`) |
| `NOTIFY_BROWSER_ACK_TTL_MINUTES` | optional | optional | default 30 (1–1440); how long a browser delivery waits for the person's open browser to acknowledge it before it expires (0D `NOTIFY_BROWSER_ACK_TTL_MINUTES`) |
| `NOTIFY_SEARCH_QUERY_MAX` | optional | optional | default 100 (10–200); longest notification history search text (0D `NOTIFY_SEARCH_QUERY_MAX`) |
| `NOTIFY_DISCOVERY_MAX` | optional | optional | default 100 (1–1000); most workspaces one notification sweep examines (0D `NOTIFY_DISCOVERY_MAX`) |
| `NOTIFY_BULK_STATE_MAX` | optional | optional | default 200 (1–1000); most notifications one bulk state change names (0D `NOTIFY_BULK_STATE_MAX`) |
| `NOTIFY_DEADLINES_BATCH_MAX` | optional | optional | default 500 (10–5000); most due-soon and overdue tasks one sweep considers per workspace (0D `NOTIFY_DEADLINES_BATCH_MAX`) |
| `NOTIFY_FACTS_MAX_BYTES` | optional | optional | default 1024 (128–4096); largest facts object a notification stores (scalars only, never titles or text) (0D `NOTIFY_FACTS_MAX_BYTES`) |
| `DOCUMENT_BODY_MAX_BYTES` | optional | optional | default 262144 (4096–2000000); largest canonical content of one document version, in bytes (0D `DOCUMENT_BODY_MAX_BYTES`) |
| `DOCUMENT_BLOCKS_MAX` | optional | optional | default 2000 (10–5000); most blocks in one document (0D `DOCUMENT_BLOCKS_MAX`) |
| `DOCUMENT_BLOCK_TEXT_MAX_CHARS` | optional | optional | default 20000 (100–50000); longest text of one block (0D `DOCUMENT_BLOCK_TEXT_MAX_CHARS`) |
| `DOCUMENT_TABLE_CELLS_MAX` | optional | optional | default 1000 (4–5000); most cells in one table block (0D `DOCUMENT_TABLE_CELLS_MAX`) |
| `DOCUMENT_DEPTH_MAX` | optional | optional | default 6 (1–16); deepest page nesting (a root is depth 0) (0D `DOCUMENT_DEPTH_MAX`) |
| `DOCUMENT_CHILDREN_MAX` | optional | optional | default 200 (1–1000); most direct subpages of one page (0D `DOCUMENT_CHILDREN_MAX`) |
| `DOCUMENT_TREE_MAX` | optional | optional | default 1000 (10–5000); most pages in one page tree (0D `DOCUMENT_TREE_MAX`) |
| `DOCUMENT_VERSIONS_MAX` | optional | optional | default 1000 (10–10000); most versions one document keeps (0D `DOCUMENT_VERSIONS_MAX`) |
| `DOCUMENT_REFERENCES_MAX` | optional | optional | default 500 (10–2000); most links and mentions in one document (0D `DOCUMENT_REFERENCES_MAX`) |
| `DOCUMENT_SUGGESTIONS_OPEN_MAX` | optional | optional | default 100 (1–500); most open suggestions on one document (0D `DOCUMENT_SUGGESTIONS_OPEN_MAX`) |
| `DOCUMENT_EXPORT_PAGES_MAX` | optional | optional | default 100 (1–500); most pages one export carries (0D `DOCUMENT_EXPORT_PAGES_MAX`) |
| `DOCUMENT_EXPORT_MAX_BYTES` | optional | optional | default 5242880 (65536–52428800); largest export, in bytes (0D `DOCUMENT_EXPORT_MAX_BYTES`) |
| `DOCUMENT_REVIEW_HORIZON_DAYS` | optional | optional | default 730 (30–3650); furthest review date, in days from today (0D `DOCUMENT_REVIEW_HORIZON_DAYS`) |
| `DOCUMENT_SAVE_RATE_PER_MINUTE` | optional | optional | default 60 (1–600); most content saves one person makes per minute (0D `DOCUMENT_SAVE_RATE_PER_MINUTE`) |
| `LIVE_EDITING_ENABLED` | optional | optional | default 1 (0–1); 0 turns live editing off and every document uses versioned non-live editing (0D `LIVE_EDITING_ENABLED`) |
| `LIVE_SESSION_TTL_SECONDS` | optional | optional | default 45 (15–300); how long a live editing session lasts without a heartbeat, poll, or operation (0D `LIVE_SESSION_TTL_SECONDS`) |
| `LIVE_SESSIONS_MAX` | optional | optional | default 20 (2–100); most live sessions on one document (0D `LIVE_SESSIONS_MAX`) |
| `LIVE_SESSIONS_PER_MEMBER_MAX` | optional | optional | default 5 (1–20); most live sessions one person holds at once (0D `LIVE_SESSIONS_PER_MEMBER_MAX`) |
| `LIVE_OPS_BATCH_MAX` | optional | optional | default 50 (1–200); most operations in one live request (0D `LIVE_OPS_BATCH_MAX`) |
| `LIVE_POLL_WAIT_SECONDS` | optional | optional | default 20 (0–30); longest a live poll waits for news (0D `LIVE_POLL_WAIT_SECONDS`) |
| `LIVE_OP_LOG_MAX` | optional | optional | default 2000 (100–10000); operations kept for reconnecting editors (0D `LIVE_OP_LOG_MAX`) |
| `LIVE_RATE_PER_MINUTE` | optional | optional | default 1200 (10–6000); most live requests one person makes per minute (0D `LIVE_RATE_PER_MINUTE`) |
| `SEARCH_QUERY_MAX_CHARS` | optional | optional | default 200 (20–500); longest search query, in characters (0D `SEARCH_QUERY_MAX_CHARS`) |
| `SEARCH_TERMS_MAX` | optional | optional | default 12 (2–30); most words and phrases in one search query (0D `SEARCH_TERMS_MAX`) |
| `SEARCH_PAGE_SIZE_MAX` | optional | optional | default 50 (10–100); most results on one search page (0D `SEARCH_PAGE_SIZE_MAX`) |
| `SEARCH_RESULTS_MAX` | optional | optional | default 200 (50–1000); deepest result a search can page to (0D `SEARCH_RESULTS_MAX`) |
| `SEARCH_COUNT_MAX` | optional | optional | default 1000 (100–10000); where counts and facets stop and report "at least" (0D `SEARCH_COUNT_MAX`) |
| `SEARCH_SNIPPET_CHARS` | optional | optional | default 220 (80–500); longest result snippet, in characters (0D `SEARCH_SNIPPET_CHARS`) |
| `SEARCH_BODY_MAX_CHARS` | optional | optional | default 100000 (10000–100000); most text indexed per record, in characters (0D `SEARCH_BODY_MAX_CHARS`) |
| `SEARCH_INDEX_BATCH_MAX` | optional | optional | default 200 (10–1000); most records one worker run indexes per workspace (0D `SEARCH_INDEX_BATCH_MAX`) |
| `SEARCH_INDEX_DISCOVERY_MAX` | optional | optional | default 50 (1–500); most workspaces one indexing run visits (0D `SEARCH_INDEX_DISCOVERY_MAX`) |
| `SEARCH_INDEX_MAX_ATTEMPTS` | optional | optional | default 5 (1–20); attempts to index a record before it is reported failed (0D `SEARCH_INDEX_MAX_ATTEMPTS`) |
| `SEARCH_INDEX_BACKOFF_SECONDS` | optional | optional | default 30 (5–3600); first wait before a failed indexing attempt is retried (it doubles) (0D `SEARCH_INDEX_BACKOFF_SECONDS`) |
| `SEARCH_FAILED_RETRY_MINUTES` | optional | optional | default 360 (10–10080); how long a failed record waits between slow retries (0D `SEARCH_FAILED_RETRY_MINUTES`) |
| `SEARCH_RECENT_MAX` | optional | optional | default 25 (5–100); recent searches kept per person and workspace (0D `SEARCH_RECENT_MAX`) |
| `SEARCH_RECENT_RETENTION_DAYS` | optional | optional | default 90 (1–365); how long a recent search is kept, in days (0D `SEARCH_RECENT_RETENTION_DAYS`) |
| `SEARCH_RATE_PER_MINUTE` | optional | optional | default 120 (10–1200); most searches one person makes per minute (0D `SEARCH_RATE_PER_MINUTE`) |
| `METRICS_WINDOW_DAYS_MAX` | optional | optional | default 366 (31–1000); longest window a metric may cover, in days (0D `METRICS_WINDOW_DAYS_MAX`) |
| `METRICS_DEFAULT_WINDOW_DAYS` | optional | optional | default 30 (7–366); window a metric covers when none is given, in days (0D `METRICS_DEFAULT_WINDOW_DAYS`) |
| `METRICS_DRILL_PAGE_MAX` | optional | optional | default 100 (10–200); most records on one drill-through page (0D `METRICS_DRILL_PAGE_MAX`) |
| `METRICS_DRILL_RESULTS_MAX` | optional | optional | default 1000 (100–5000); deepest record a drill-through can page to (0D `METRICS_DRILL_RESULTS_MAX`) |
| `METRICS_SCOPE_TASKS_MAX` | optional | optional | default 20000 (1000–200000); most tasks one metric computation reads before it asks for a narrower scope (0D `METRICS_SCOPE_TASKS_MAX`) |
| `METRICS_SAMPLE_MIN` | optional | optional | default 5 (1–100); fewest records before a distribution metric is shown without a small-sample label (0D `METRICS_SAMPLE_MIN`) |
| `METRICS_RATE_PER_MINUTE` | optional | optional | default 60 (10–600); most metric requests one person makes per minute (0D `METRICS_RATE_PER_MINUTE`) |
| `METRICS_RECONCILE_BATCH_MAX` | optional | optional | default 500 (50–5000); most tasks one reconciliation step checks per workspace (0D `METRICS_RECONCILE_BATCH_MAX`) |
| `METRICS_RECONCILE_DISCOVERY_MAX` | optional | optional | default 50 (1–500); most workspaces one reconciliation run visits (0D `METRICS_RECONCILE_DISCOVERY_MAX`) |
| `METRICS_RECONCILE_INTERVAL_MINUTES` | optional | optional | default 360 (5–10080); wait between full reconciliation passes of a workspace, in minutes (0D `METRICS_RECONCILE_INTERVAL_MINUTES`) |
| `METRICS_RECONCILE_LEASE_SECONDS` | optional | optional | default 300 (30–3600); how long a worker holds a workspace's reconciliation before another may take it (0D `METRICS_RECONCILE_LEASE_SECONDS`) |
| `METRICS_RECONCILE_MAX_ATTEMPTS` | optional | optional | default 5 (1–20); failed reconciliation attempts before the workspace is reported failing (0D `METRICS_RECONCILE_MAX_ATTEMPTS`) |
| `METRICS_RECONCILE_BACKOFF_SECONDS` | optional | optional | default 60 (5–3600); first wait before a failed reconciliation is retried (it doubles) (0D `METRICS_RECONCILE_BACKOFF_SECONDS`) |
| `GOALS_PER_SCOPE_MAX` | optional | optional | default 500 (10–5000); most live goals one workspace, brand, or project scope holds (0D `GOALS_PER_SCOPE_MAX`) |
| `GOAL_KEY_RESULTS_MAX` | optional | optional | default 20 (1–50); most key results one goal holds (0D `GOAL_KEY_RESULTS_MAX`) |
| `GOAL_LINKS_MAX` | optional | optional | default 200 (10–1000); most projects and tasks one goal and its key results link (0D `GOAL_LINKS_MAX`) |
| `GOAL_UPDATE_STALE_DAYS` | optional | optional | default 14 (1–90); days without a manual check-in after which an active goal's update is stale (0D `GOAL_UPDATE_STALE_DAYS`) |
| `GOAL_CHECKIN_RATE_PER_MINUTE` | optional | optional | default 30 (1–600); most check-ins one person records per minute (0D `GOAL_CHECKIN_RATE_PER_MINUTE`) |
| `PORTFOLIOS_MAX` | optional | optional | default 100 (1–1000); most live portfolios one workspace holds (0D `PORTFOLIOS_MAX`) |
| `PORTFOLIO_PROJECTS_MAX` | optional | optional | default 200 (10–1000); most projects one portfolio names (0D `PORTFOLIO_PROJECTS_MAX`) |
| `PORTFOLIO_READ_PROJECTS_MAX` | optional | optional | default 500 (50–2000); most projects one health, dependency, or orphan read evaluates before it says it is truncated (0D `PORTFOLIO_READ_PROJECTS_MAX`) |
| `GOALS_EXPORT_ROWS_MAX` | optional | optional | default 5000 (100–50000); most rows one goal or portfolio export returns; a larger export is refused, never truncated (0D `GOALS_EXPORT_ROWS_MAX`) |
| `GOALS_RECALC_BATCH_MAX` | optional | optional | default 200 (10–2000); most goals one recalculation sweep claims per workspace (0D `GOALS_RECALC_BATCH_MAX`) |
| `GOALS_RECALC_LEASE_SECONDS` | optional | optional | default 300 (30–3600); how long a claimed goal stays leased before another sweep may reclaim it (0D `GOALS_RECALC_LEASE_SECONDS`) |
| `GOALS_RECALC_INTERVAL_MINUTES` | optional | optional | default 360 (15–1440); how often an unchanged goal's time-driven state is rechecked, and the longest retry delay (0D `GOALS_RECALC_INTERVAL_MINUTES`) |
| `GOALS_RECALC_MAX_ATTEMPTS` | optional | optional | default 5 (1–20); failed recalculations before a goal is reported as failing (0D `GOALS_RECALC_MAX_ATTEMPTS`) |
| `DASHBOARDS_PER_SCOPE_MAX` | optional | optional | default 100 (1–1000); most dashboards one workspace, brand, or project scope holds (0D `DASHBOARDS_PER_SCOPE_MAX`) |
| `DASHBOARD_PERSONAL_MAX` | optional | optional | default 20 (1–200); most personal dashboards one member holds (0D `DASHBOARD_PERSONAL_MAX`) |
| `DASHBOARD_WIDGETS_MAX` | optional | optional | default 24 (1–60); most widgets one dashboard or report holds (0D `DASHBOARD_WIDGETS_MAX`) |
| `REPORTS_PER_SCOPE_MAX` | optional | optional | default 200 (1–2000); most saved reports one scope holds (0D `REPORTS_PER_SCOPE_MAX`) |
| `REPORT_RECIPIENTS_MAX` | optional | optional | default 50 (1–500); most recipients one scheduled report names (0D `REPORT_RECIPIENTS_MAX`) |
| `REPORT_SHARES_MAX` | optional | optional | default 100 (1–1000); most active shares one report holds (0D `REPORT_SHARES_MAX`) |
| `REPORT_EXPORT_ROWS_MAX` | optional | optional | default 5000 (100–50000); most rows one report or widget export returns (0D `REPORT_EXPORT_ROWS_MAX`) |
| `REPORT_EMAIL_ROWS_MAX` | optional | optional | default 25 (5–200); most rows per widget in a scheduled report email (0D `REPORT_EMAIL_ROWS_MAX`) |
| `REPORT_EXPORT_RATE_PER_MINUTE` | optional | optional | default 20 (1–600); most report exports one member makes per minute (0D `REPORT_EXPORT_RATE_PER_MINUTE`) |
| `REPORT_RUN_RETENTION_DAYS` | optional | optional | default 90 (7–730); how long delivery run records are kept (0D `REPORT_RUN_RETENTION_DAYS`) |
| `REPORT_BATCH_MAX` | optional | optional | default 25 (1–500); most scheduled reports one sweep claims per workspace (0D `REPORT_BATCH_MAX`) |
| `REPORT_LEASE_SECONDS` | optional | optional | default 300 (30–3600); how long a claimed scheduled report stays leased before another sweep may reclaim it (0D `REPORT_LEASE_SECONDS`) |
| `REPORT_MAX_ATTEMPTS` | optional | optional | default 5 (1–20); failed delivery attempts before a scheduled occurrence is recorded as failed (0D `REPORT_MAX_ATTEMPTS`) |
| `REPORT_FRESHNESS_MINUTES` | optional | optional | default 720 (15–10080); age after which a derived source (a goal recalculation) is labelled stale on a dashboard (0D `REPORT_FRESHNESS_MINUTES`) |
| `DOCUMENT_EMBED_URL_MAX_CHARS` | optional | optional | default 2048 (128–8192); longest address of an embedded image, video, or link (0D `DOCUMENT_EMBED_URL_MAX_CHARS`) |
| `SIGNED_URL_LIFETIME` | optional | optional | default 300 (30–3600); lifetime in seconds of signed upload and download URLs; never stored, logged, or sent in notifications or exports (0D `SIGNED_URL_LIFETIME`) |
| `UPLOAD_SESSION_LIFETIME` | optional | optional | default 3600 (300–86400); lifetime in seconds of an upload session; an expired, unfinished session releases its reserved bytes and its quarantined object (0D `UPLOAD_SESSION_LIFETIME`) |
| `FILE_UPLOAD_MAX_BYTES` | optional | optional | default 104857600 (1024–5368709120); largest single upload in bytes (0D `FILE_UPLOAD_MAX_BYTES`) |
| `WORKSPACE_STORAGE_QUOTA_BYTES` | optional | optional | default 10737418240 (1048576–10995116277760); stored bytes one workspace may hold, counting bytes reserved by open upload sessions (0D `WORKSPACE_STORAGE_QUOTA_BYTES`) |
| `FILE_COMPARE_MAX_BYTES` | optional | optional | default 262144 (1024–2097152); largest text or code version compared line by line; larger versions compare by metadata (0D `FILE_COMPARE_MAX_BYTES`) |
| `FILE_SCAN_MAX_ATTEMPTS` | optional | optional | default 5 (1–20); scan attempts before a failing scan marks the object as a scan failure (downloads stay blocked) (0D `FILE_SCAN_MAX_ATTEMPTS`) |
| `FILE_VERSIONS_MAX` | optional | optional | default 100 (1–1000); most versions one file keeps (0D `FILE_VERSIONS_MAX`) |
| `FILES_LIST_MAX` | optional | optional | default 200 (10–1000); most files one record lists (0D `FILES_LIST_MAX`) |
| `DELIVERABLES_PER_TASK_MAX` | optional | optional | default 50 (1–500); most deliverables one task holds (0D `DELIVERABLES_PER_TASK_MAX`) |
| `FILE_DISCOVERY_MAX` | optional | optional | default 100 (1–1000); most workspaces one file sweep examines (0D `FILE_DISCOVERY_MAX`) |
| `FILE_EXPIRY_BATCH_MAX` | optional | optional | default 200 (10–5000); most expired upload sessions one sweep closes per workspace (0D `FILE_EXPIRY_BATCH_MAX`) |
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
