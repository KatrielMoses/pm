# Developer Brief — Phase 1A: Repository, Environments, and Delivery Pipeline

## Objective

Build the executable engineering foundation for the product described by the accepted Phase 0 architecture. At completion, the repository must run locally, pass a reproducible CI pipeline, build one deployable artifact with web/API and worker entrypoints, connect safely to PostgreSQL, apply reversible migrations, enforce a tenant-RLS skeleton, execute durable background jobs, and expose privacy-safe health and observability signals.

This is the first implementation brief. Deliver working code and automated evidence—not additional architecture-only documents.

## Read first

- `FEATURES.md`, `BUILD_ROADMAP.md`, and `ROADMAP_CHECKLIST.md`;
- `docs/architecture/PHASE_0_DECISIONS.md`;
- `docs/architecture/PHASE_0_EXIT_GATE.md`;
- `docs/architecture/RELEASE_TOPOLOGY.md`;
- all accepted Phase 0 data, authorization, platform, and UX contracts;
- especially 0B PostgreSQL guidance and concurrency/outbox contracts, 0C RLS rules, and 0D API/job/event/observability contracts.

Run `python3 docs/architecture/tools/phase0.py` before making changes. It must remain green.

Do not edit `BUILD_ROADMAP.md` or mark `ROADMAP_CHECKLIST.md` complete. Do not weaken architecture validators to accommodate implementation shortcuts.

## Prescribed implementation stack

Use this stack unless the repository already contains an equivalent accepted implementation—which it currently does not:

- TypeScript in strict mode on the active Node.js LTS release, with exact versions locked.
- `pnpm` workspaces in a single repository.
- React with Vite for the browser application.
- Fastify for the HTTP API and SSE-capable web process.
- PostgreSQL through the maintained `pg` driver and a typed query layer that does not hide SQL or RLS behavior. Prefer Kysely for typed queries; use reviewed SQL migrations for schemas, constraints, roles, RLS, functions, and indexes.
- Vitest for unit/component tests and Playwright for browser/end-to-end foundations.
- Real PostgreSQL integration tests. Use an isolated disposable database through containers; do not substitute an in-memory database for authorization, migration, locking, or job tests.
- OpenTelemetry-compatible tracing/metrics instrumentation and structured JSON logging with a content-safe logger.
- A multi-stage OCI/Docker image used for both web/API and worker entrypoints.

Do not introduce Next.js, GraphQL, Prisma-managed schema migrations, Redis, Kafka, Elasticsearch, a separate vector database, microservices, Kubernetes, or a cloud-vendor-specific application framework in this phase.

Use currently maintained stable releases at implementation time and commit the lockfile. Record exact runtime and package-manager versions in repository configuration.

## Required repository structure

Use a clear structure equivalent to:

```text
apps/
  web/                 React browser application
  api/                 Fastify web/API/SSE entrypoint
  worker/              durable job/outbox worker entrypoint
packages/
  config/              validated runtime configuration
  contracts/           generated/consumed Phase 0 contract types
  db/                  pool, transaction context, migrations, queries
  observability/       logging, tracing, metrics, redaction
  platform/            operations, jobs, outbox/inbox, idempotency
  test-support/        fixtures and disposable database helpers
docs/                  accepted architecture documentation
```

Equivalent naming is acceptable when module ownership stays obvious. Avoid circular workspace-package dependencies and avoid a generic `utils` dumping ground.

## Required work

### 1. Repository and developer workflow

- Initialize the application repository safely if it is not already a Git repository.
- Configure `pnpm` workspaces, TypeScript project references or an equivalent reliable build graph, shared lint/format/type-check rules, and deterministic scripts.
- Provide one-command workflows for install, local development, build, unit tests, integration tests, end-to-end smoke tests, all Phase 0 validators, migrations, and complete verification.
- Pin the Node and pnpm toolchain and commit the lockfile.
- Add editor-agnostic environment examples without secrets.
- Preserve all accepted architecture files and validators.
- Add an engineering README with setup, commands, architecture links, troubleshooting, and the difference between web/API and worker processes.

### 2. Minimal running product shell

Implement a deliberately small but real vertical slice:

- React application loads and displays an application-foundation screen, build/version information safe for users, API connectivity, and a generic degraded/unavailable state.
- Fastify API exposes versioned `/v1` routing and the accepted success/error envelope.
- Provide `/healthz` for process liveness and `/readyz` for dependency readiness; return no tenant, secret, build-path, database-host, or stack-trace information.
- Provide a request/correlation ID and propagate it through logs and traces.
- Serve browser and API traffic from the web/API deployable topology without creating an additional backend service.
- Add a worker entrypoint using the same built artifact and shared domain packages.

Do not implement authentication, workspaces, brands, navigation, or business features owned by later briefs.

### 3. Configuration and secrets boundary

- Define a typed, fail-fast configuration layer with explicit local/test/preview/staging/production modes.
- Separate public browser configuration from server-only configuration.
- Reject startup when required secrets or unsafe production defaults are missing.
- Redact secrets in logs, errors, traces, test snapshots, and configuration dumps.
- Use `.env` only for local development. CI and future deployments consume injected environment/secret references.
- Define a provider adapter boundary for the future managed secret store/KMS; do not select or simulate a production vendor in application code.
- Ensure preview/staging/production namespaces cannot accidentally share credentials or database URLs.

### 4. PostgreSQL connection and transaction context

- Implement separate connection identities/configuration for ordinary app traffic, workers, migrations, and restore tooling as defined in the accepted RLS contract.
- Ordinary app and worker identities must not own tables and must not have `BYPASSRLS`.
- Provide a transaction helper that requires a validated workspace context for tenant work and uses transaction-local settings. It must set and clear context safely under pooled connections.
- Missing tenant context must fail closed.
- Provide a separate explicitly named path for platform-only, payload-free scheduling discovery; it must not expose customer rows.
- Configure statement, lock, idle-transaction, and connection timeouts through named parameters with conservative local/test defaults—not public promises.
- Ensure logs never include SQL bind values containing customer content.

### 5. Migration system and initial schemas

Create reviewed, ordered SQL migrations with checksums or an equally robust tamper-evident history. Migrations must support expand/contract deployment and execute only through the migrator identity.

Initial migrations must establish:

- required PostgreSQL extensions only when justified and documented;
- module schemas needed for the foundation, including at minimum `tenancy`, `access`, `execution`, and an operational migration namespace;
- a minimal `tenancy.workspace` anchor sufficient for foreign keys and RLS testing, designed for Phase 1C to extend without destructive replacement;
- `execution.operation`, `execution.attempt`, `execution.job`, `execution.outbox_event`, `execution.inbox_receipt`, `execution.idempotency_key`, and `execution.external_effect`, following the authoritative data model and Phase 0D schemas;
- the execution-context fields accepted during Phase 0 integration;
- appropriate primary/foreign keys, unique constraints, state checks, timestamps, versions, retry/lease/checkpoint fields, and indexes;
- application, worker, migrator, and restore role/grant foundations compatible with managed PostgreSQL environments;
- `FORCE ROW LEVEL SECURITY` and fail-closed workspace policies on every tenant execution table;
- no production seed data and no hard-coded tenant identifiers.

If a managed database cannot allow application-created roles, keep role/bootstrap SQL separate and document the required provider-level setup. Do not weaken the logical security model.

### 6. Durable job and outbox foundation

Implement the minimal reusable execution engine—not feature-specific jobs:

- transactional creation of a logical operation, job, audit-ready metadata reference, and outbox event where applicable;
- job claim with `FOR UPDATE SKIP LOCKED`, lease ownership, heartbeat, checkpoint, completion, retry scheduling, cancellation observation, and dead-letter state;
- full-jitter retry calculation based on registered error class;
- one workspace transaction per claimed tenant job;
- per-workspace concurrency/fairness foundation that cannot let one tenant monopolize workers;
- outbox dispatch with at-least-once delivery and inbox-receipt deduplication;
- idempotency-key reservation, fingerprint matching, in-progress result, and completed-reference replay hook;
- external-effect state machine and stable effect key, but no real third-party effects in this phase;
- clean shutdown that stops claims, finishes or releases leases safely, and flushes telemetry.

Use the accepted state names exactly. Do not claim exactly-once delivery.

### 7. Authorization and RLS verification fixtures

Create synthetic test fixtures for at least two workspaces and multiple principals. Prove automatically that:

- ordinary app and worker connections cannot read or write another workspace's execution rows;
- unset tenant context returns no tenant data and fails writes;
- changing workspace context cannot leak through a reused pooled connection;
- a transaction cannot insert a row with a mismatched `workspace_id`;
- migration/operational roles are not used by application code;
- payload-free scheduling discovery reveals only claimable workspace/job references permitted by its contract;
- public API responses never expose internal UUIDv7 identifiers.

These are foundation tests, not a substitute for the full Phase 1C/1D authorization suite.

### 8. Observability baseline

Implement:

- structured JSON logs with request, correlation, trace, operation, attempt, job kind, outcome, and duration fields;
- OpenTelemetry-compatible tracing for HTTP, database calls, job claims/attempts, and outbox dispatch;
- bounded metrics for request duration/count, database health, pool saturation, job states/latency, retries/dead letters, outbox backlog, and worker health;
- redaction tests for authorization headers, cookies, database URLs, secret-like keys, uploaded content, request/response bodies, and SQL parameters;
- health/readiness checks that are actionable internally but minimal publicly;
- an error-reporting adapter interface without binding the core code to one commercial vendor;
- trace and log propagation across API-to-job/outbox boundaries.

Customer content, workspace IDs, record IDs, emails, names, URLs, prompts, filenames, and other high-cardinality identifiers must not become metric labels.

### 9. Local and container environments

- Provide a local container environment with PostgreSQL and the application entrypoints.
- Use synthetic development fixtures only.
- Build one multi-stage production image with explicit web/API and worker commands, non-root execution, minimal runtime contents, health checks, and graceful termination.
- Ensure the container contains no `.env`, development credentials, source-control metadata, test fixtures, or unnecessary build caches.
- Document the provider-neutral environment-variable and network contract required by preview, staging, and production.
- Do not provision a cloud environment until the hosting provider, first region, CI provider, and secret-store/KMS choices are approved.

### 10. CI and quality gates

Create a provider-portable verification script and, unless repository constraints require otherwise, a GitHub Actions workflow that runs:

1. clean dependency install with lockfile enforcement;
2. Phase 0 integration validator;
3. formatting/lint checks;
4. TypeScript type checks;
5. unit tests;
6. PostgreSQL migration from empty database;
7. migration consistency/checksum verification;
8. RLS/integration tests against real PostgreSQL;
9. application build;
10. API/worker smoke tests;
11. browser smoke test;
12. dependency and secret scanning using maintained tools available to the CI environment;
13. production image build and basic non-root/health inspection.

CI must not require production secrets or network access to paid services. Cache only non-sensitive dependencies. Upload sanitized test reports on failure.

### 11. Backup and recovery policy foundation

Document, without inventing RPO/RTO promises:

- managed PostgreSQL point-in-time recovery requirements;
- object-storage versioning/retention requirements;
- separation of the purge ledger from the database backup set;
- restore-operator identity and mandatory purge-ledger replay before reopening a restored environment;
- future automated restore-drill ownership in Phase 11C;
- what can be tested locally now and what requires the selected hosting provider.

Do not claim backups exist merely because a local database volume exists.

### 12. Architecture and dependency records

Add implementation ADRs covering:

- TypeScript/pnpm modular-monolith structure;
- React/Vite and Fastify split within one deployable codebase;
- typed query layer plus reviewed SQL migrations;
- single artifact with web/API and worker entrypoints;
- provider-neutral configuration and deployment boundary;
- any deviation from this brief, with evidence and migration cost.

Generate a dependency inventory/license report and document update policy. Reject dependencies that are abandoned, duplicative, or introduce infrastructure prohibited by Phase 0.

## Required security and quality constraints

- No secrets or real customer data in the repository, fixtures, logs, snapshots, images, or CI artifacts.
- No route trusts client-supplied role, plan, workspace authority, approval, actor, or tenant context.
- All tenant database work runs inside an explicit fail-closed transaction context.
- All SQL migrations are reviewable and deterministic.
- All code paths return safe Phase 0D envelopes; never expose stack traces or internal UUIDs.
- Do not weaken RLS, validator rules, or tests to make the pipeline pass.
- Avoid premature abstractions for business modules not yet implemented.
- Keep the core application usable without Redis, an external queue, object storage, AI, or integrations in local foundation tests.

## Non-goals

- User registration, sign-in, OAuth, MFA, and sessions (1B).
- Complete workspace/brand behavior or tenant UI (1C).
- Memberships, invitations, roles, full visibility compiler, and shares (1D).
- Audit/deletion product primitives beyond metadata hooks required by the execution foundation (1F).
- Product navigation and polished visual design (1E).
- Business entities such as projects, tasks, documents, integrations, AI, billing, or releases.
- Production cloud provisioning before provider/region approval.
- Full disaster-recovery execution or published SLO/RPO/RTO targets.

## Acceptance criteria

- A new developer can clone, install, start PostgreSQL, migrate, and run web/API plus worker using documented commands.
- The browser shell reaches the API and renders healthy and degraded states.
- One production image runs both entrypoints using separate commands and as a non-root user.
- Empty-database migrations succeed reproducibly and are tamper-evident.
- Execution operations/jobs/outbox/inbox/idempotency/effects use accepted state and context contracts.
- At-least-once job/outbox behavior and deduplication are tested, including worker interruption and retry.
- RLS tests prove cross-workspace denial, fail-closed unset context, and pool-context isolation.
- Logs/traces/metrics are correlated and pass redaction/cardinality tests.
- Health/readiness endpoints are useful without leaking internals.
- CI runs the full Phase 0 validator plus code, migration, RLS, smoke, scan, and image gates.
- No prohibited infrastructure or premature business feature is introduced.
- All documentation and implementation ADRs match the accepted Phase 0 architecture.

## Required completion response

Return:

1. Outcome summary and exact stack/runtime versions selected.
2. Every file created or changed, grouped by application, database, CI, container, tests, and documentation.
3. Repository/package dependency graph and deployable entrypoints.
4. Migration list and database roles/RLS policies created.
5. Job/outbox/idempotency/external-effect behaviors implemented.
6. Commands and complete results for Phase 0 validation, lint, type checks, unit tests, integration/RLS tests, browser smoke tests, build, image inspection, and security scans.
7. Redaction and observability evidence.
8. Known limitations, provider-dependent work deferred, and any accepted-contract deviation.
9. Recommended prerequisites for parallel Phase 1B and 1F work.

Do not report completion based only on scaffolding or successful compilation. Provide reviewable runtime, database-isolation, retry/deduplication, and CI evidence.
