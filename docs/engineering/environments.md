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
| `SECRET_VAULT` | required | required | `dev-database` (local/test only) or `none`; a KMS adapter needs approval (ADR-0008) |
| `DEV_VAULT_KEY` | with `dev-database` | with `dev-database` | base64url 32 bytes; refused in deployed modes |
| `MAIL_TRANSPORT`, `MAIL_FROM`, `MAIL_CAPTURE_DIR`, `MAIL_RETENTION_MS` | — | required / optional | `capture` (local/test only) or `none`; no vendor approved |
| `OAUTH_PROVIDERS` | optional | — | comma list; only `local` exists (local/test only) |
| `BOT_PROTECTION` | optional | — | `none` or `test` (local/test only) |
| `SESSION_*`, `EMAIL_VERIFICATION_TOKEN_MS`, `PASSWORD_RESET_TOKEN_MS`, `SIGN_IN_CONTINUATION_MS`, `OAUTH_STATE_MS`, `RESEND_COOLDOWN_MS`, `STEP_UP_*`, `ARGON2_*`, `AUTH_RESPONSE_FLOOR_MS`, `RATE_LIMIT_POLICIES`, `LEGAL_TERMS_VERSION`, `LEGAL_PRIVACY_VERSION` | optional | optional | identity operational defaults, see [identity.md](identity.md); not published promises |
| `RETENTION_PERIODS` | optional | optional | JSON `{"<retention class>": <ms>}`; **unset by default** = every period undecided, so no scheduled purge runs (1F) |
| `PURGE_LEDGER`, `PURGE_LEDGER_DIR` | — | optional | `none` (default: purge blocks before deleting) or `local` (development adapter, refused when deployed) |
| `COMPONENT_HARNESS` | optional | — | `false` by default; `true` only in local/test (renders `/_harness/lifecycle`) |

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
