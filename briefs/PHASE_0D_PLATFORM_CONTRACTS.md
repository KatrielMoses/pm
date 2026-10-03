# Developer Brief — Phase 0D: Platform Contracts

## Objective

Define the shared technical contracts that all later implementation phases must follow: API conventions, errors, identifiers, concurrency, idempotency, asynchronous operations, jobs, events, webhooks, realtime notices, audit, notifications, usage metering, entitlements, file access, and observability.

The goal is one coherent platform language that prevents each feature team from inventing incompatible request shapes, retry behavior, state machines, authorization context, or operational telemetry.

This is an architecture-contract brief. Produce specifications and machine-validatable schemas, not production application code.

## Read first

- `FEATURES.md`, `BUILD_ROADMAP.md`, and `ROADMAP_CHECKLIST.md`;
- all accepted files under `docs/product/`, `docs/ux/`, `docs/architecture/data/`, and `docs/architecture/access/`;
- Phase 0B questions DQ-10 through DQ-17;
- Phase 0C questions AQ-01 through AQ-05;
- the accepted rule that internal delivery is at least once, external deduplication is provider-dependent, and exactly-once external delivery is never promised.

Do not edit `BUILD_ROADMAP.md` or mark the checklist complete. If accepted contracts conflict, record the contradiction and propose the narrowest safe amendment.

## Required deliverables

Create a coherent specification set under `docs/architecture/platform/`, with a README providing reading order. Include machine-readable JSON Schemas or equivalent definitions for contract envelopes and a repeatable validator/renderer.

### 1. Contract principles and versioning

Define:

- stable opaque public identifiers and type-prefix registry;
- UTC timestamp and date-only encoding;
- currency, duration, timezone, locale, enum, and decimal conventions;
- additive versus breaking changes;
- API, event, webhook, and schema versioning;
- deprecation policy without inventing commercial support durations;
- correlation, causation, trace, operation, attempt, request, event, and idempotency identifiers;
- canonical serialization and signing rules;
- redaction and data-classification rules.

Resolve DQ-10. Keep internal UUIDv7 identifiers private; public IDs must not expose creation time, tenant identity, or counts.

### 2. HTTP/API conventions

Define resource naming, request/response envelopes, content types, validation, partial field selection where safe, filtering, sorting, expansion limits, keyset pagination, conditional requests, optimistic concurrency, bulk operations, rate-limit headers, and localization behavior.

Resolve DQ-17 with opaque keyset cursors. Counts must use the identical authorized predicate as results; estimated counts must be labeled.

Define request context derived from authenticated server state—not trusted client fields—including workspace, effective principal, initiating human, selected brand/context, delegation chain, authorization epochs, locale, and timezone.

### 3. Uniform errors and non-disclosure

Resolve AQ-01. Define a stable error envelope with machine code, safe message, field issues, retryability, correlation ID, and optional operation/approval/step-up references.

Cover at minimum: validation, unauthenticated, uniform not-found, conflict, rate-limited, idempotency conflict, approval required, step-up required, suspended, entitlement limit, usage limit, unavailable dependency, partial operation, and internal error.

Unauthorized and nonexistent resources must be indistinguishable in body, status, headers, timing expectations, and logging visible to the caller. Internal logs may retain the real cause under strict access and redaction.

### 4. Optimistic concurrency and conflict protocol

Resolve DQ-11. Define:

- row-version conditional updates;
- field-level base-value or base-hash merge requests;
- rich-text/document version conflicts;
- whole-record operations that require exact version matching;
- permission-filtered conflict payloads;
- bulk per-item results and atomic versus per-record boundaries;
- undo preconditions;
- retry guidance that never silently overwrites concurrent edits.

### 5. Idempotency and logical operations

Resolve DQ-12. Define idempotency-key syntax, principal/workspace scope, request fingerprinting, retention semantics, in-progress responses, completed-response replay, conflict behavior, and offline replay.

Distinguish request, logical operation, attempt, retry, rerun, and external effect. A retry adds an attempt to one logical operation; a rerun creates a new operation.

Do not promise exactly-once external outcomes. Define stable external effect keys, provider idempotency use, safe retry classes, unknown outcomes, reconciliation, and human-confirmation states.

### 6. Asynchronous operation contract

Define a shared operation resource for AI, agents, automations, imports, exports, synchronization, bulk edits, reports, briefings, brand moves, purge, template installation, and other long work.

Specify states, progress, attempts, partial outcomes, cancellation, pause/resume, retry/rerun, result/artifact references, errors, approvals, usage/cost, timestamps, and polling/SSE links. Progress commentary must never imply completion.

Failed, cancelled, timed-out, waiting, and partial outcomes remain structurally distinct from success.

### 7. Durable jobs and execution context

Resolve DQ-14 and AQ-03. Define job states, leasing, heartbeat, timeout, backoff with jitter, retry caps, dead-letter behavior, fairness, cancellation, recovery after worker loss, and idempotent handlers.

Every job/operation carries workspace, effective principal/service principal, initiating membership where applicable, delegation chain, selected scope, authorization epochs at enqueue, risk/approval context, correlation/causation, and data-classification limits. Live authorization is rechecked before each consequential step.

Cross-workspace discovery remains payload-free; processing occurs one workspace transaction at a time with tenant RLS enforced.

### 8. Internal event contract

Resolve DQ-13. Define event naming, versioning, envelope, aggregate ordering, occurrence time versus processing time, actor and authorization context, correlation/causation, safe payloads, references, schema registry, retention, replay, consumer deduplication, and compatibility.

Internal delivery is at least once. Consumers write inbox receipts in the same transaction as their effects. Events state facts in past tense and never contain credentials or fields forbidden by classification.

Define which facts are suitable for activity, notifications, metrics, automations, indexing, and public webhooks without making the internal event bus a public API.

### 9. Webhook contracts

Define inbound and outbound envelopes, endpoint/version negotiation, HTTPS requirements, signing, timestamp tolerance, replay protection, secret rotation, retries/backoff, delivery history, disablement after persistent failure, test delivery, rate limits, and payload allow-lists.

Outbound delivery uses a stable event/effect ID. Receivers should deduplicate. Destinations supporting idempotency may receive automatic retries; unknown results at unsafe destinations wait for reconciliation rather than blind repetition.

Inbound providers use verified signatures and provider event IDs for deduplication. Invalid requests fail before tenant or resource lookup disclosures.

### 10. Live-update/SSE contract

Resolve DQ-15 and AQ-04. Define authenticated subscription scope, event IDs, reconnect/`Last-Event-ID`, heartbeat, buffering limits, authorization epoch changes, revocation, tab/device behavior, polling fallback, and graceful degradation.

Notices carry only permission-safe identifiers and versions; clients re-fetch through ordinary authorized reads. Close or invalidate streams promptly on permission epoch changes. Never push record content or hidden counts in change notices.

### 11. Authentication scopes and step-up protocol

Resolve AQ-02 and AQ-05. Define a stable scope vocabulary for personal API tokens, OAuth clients, integration connections, and run-bound external-agent credentials. Scopes limit capabilities and brand lists but never replace record authorization.

Define step-up challenges bound to session, human, action class, target scope, and short validity window. Cover re-authentication methods, replay prevention, cancellation, audit, API error/linkage, and UI continuation. Service principals cannot perform human step-up.

### 12. Audit and security-event contract

Define append-only audit and security-event envelopes, actor/delegation representation, material changes, previous/new values, field classification/redaction, immutable approvals/decisions, correlation to operations/events, export safety, explicit redaction records, and retention-policy references.

Audit writing belongs in the same domain transaction as the material change. Audit failure must fail the material change where audit is required.

### 13. Notification contract

Define canonical notification events, recipient resolution, permission recheck at fan-out and delivery, channel rendering, minimal-content mode, deduplication/grouping, quiet hours, digesting, read/saved/dismissed state, delivery attempts, preferences, and searchable history.

Revoked access suppresses pending content. A notification never becomes an alternate data-access path.

### 14. Usage, cost, limits, and entitlements

Resolve DQ-16. Define resource/meter names, measured versus estimated versus externally reported cost, numeric precision, integer money micros with ISO currency, reservation/settlement/release, hard caps, warning thresholds, usage periods, late-arriving usage, corrections, and immutable usage events.

Define plan entitlements separately from authorization: entitlements make capabilities available but never grant access to data. Server enforcement is authoritative. Expensive operations expose safe estimates before execution and cannot silently exceed hard caps.

### 15. Files, uploads, downloads, and object access

Define initiate/upload/complete flows, signed URLs, short expiry, content-length/type constraints, checksum verification, malware-scan quarantine, preview readiness, version identity, authorization recheck, range downloads, external links, retention/object deletion, and evidence immutability.

Object keys must not contain customer names or secrets. Possession of an expired or copied signed URL must not become durable authorization.

### 16. Imports, exports, and bulk-result contracts

Define preview/apply separation, mapping versions, row identity, resumability, idempotency, validation issues, partial results, rollback references, source preservation, downloadable artifact expiry, authorization snapshots plus live checks, and stable record IDs/relationships.

Exports include only data authorized at materialization time and recheck access before download. Export jobs must never disclose hidden record counts in progress.

### 17. Observability and operational contracts

Define structured logs, traces, metrics, health/readiness, service-level indicators, error tracking, request/job/event correlation, tenant-safe cardinality, sampling, secret/PII redaction, security monitoring, and alert ownership.

Specify required telemetry for HTTP requests, database transactions, jobs, outbox/inbox, webhooks, SSE, uploads, integrations, AI/agents/automations, usage caps, authorization denials, and audit failures. Customer content must not be used as metric labels or ordinary log fields.

### 18. Contract catalog and validation

Provide machine-readable schemas and generated human documentation for at minimum:

- success and error envelopes;
- page/cursor response;
- concurrency conflict;
- idempotency record behavior;
- operation, attempt, job, and partial result;
- execution context;
- internal event;
- webhook delivery;
- SSE notice;
- audit/security event;
- notification;
- usage/cost/entitlement decision;
- upload session/file reference;
- approval required and step-up challenge.

The validator must check references to accepted requirement IDs, states, actor types, action/risk classes, data entities, and authorization rules; detect duplicate codes/schema IDs; validate examples; check internal links; and confirm generated files are current.

### 19. Decisions and unresolved questions

Record platform ADRs with alternatives and consequences. Explicitly resolve DQ-10 through DQ-17 and AQ-01 through AQ-05.

Maintain unresolved questions grouped into:

- matters requiring Phase 0 integration reconciliation;
- decisions safely deferred to implementation;
- legal/commercial/customer promises requiring product-owner approval.

## Prescribed decisions

- Use JSON over HTTPS for initial public APIs and webhooks; do not introduce GraphQL as a second contract surface at launch.
- Use opaque keyset cursors, never offset pagination for mutable large collections.
- Use stable opaque prefixed public IDs; never expose internal UUIDv7 keys.
- Use one safe error shape and uniform not-found behavior.
- Internal events and durable jobs are at least once with idempotent consumers/handlers.
- Exactly-once external delivery is never promised.
- SSE carries change notices, not business payloads; authorized reads fetch content.
- Server-side authorization, entitlements, budgets, and approvals are rechecked before consequential work.
- Contract payloads contain references and minimum necessary fields, not database row dumps.
- Secrets never appear in API responses, events, webhooks, logs, traces, errors, notifications, exports, or AI context.

## Non-goals

- Do not implement servers, endpoints, workers, queues, RLS, storage, integrations, or UI.
- Do not write feature-specific APIs for all 684 requirements.
- Do not choose hosting, email, payment, malware-scanning, or observability vendors.
- Do not promise uptime, retention periods, retry durations, or public compatibility windows that have not been approved.
- Do not add Kafka, Redis, GraphQL, microservices, or a separate event platform.
- Do not alter the roadmap or mark the checklist complete.

## Acceptance criteria

- DQ-10 through DQ-17 and AQ-01 through AQ-05 are explicitly resolved.
- API, error, concurrency, idempotency, operation, job, event, webhook, SSE, audit, notification, usage, entitlement, file, import/export, and observability contracts are mutually consistent.
- Every execution contract carries adequate tenant, actor, delegation, authorization, correlation, and attempt context.
- Uniform not-found behavior prevents direct and inference-based disclosure.
- Retry and external-delivery language is accurate and never promises exactly once.
- Partial, failed, cancelled, waiting, and successful work remain structurally distinct.
- Field security and data classification propagate through every envelope.
- Machine-readable schemas, examples, rendered documentation, and cross-references pass a repeatable validator.
- The contract set is concrete enough for Phase 1 developers to implement shared foundations without inventing incompatible conventions.

## Required completion response

Return:

1. Concise platform-contract summary and consequential decisions.
2. Every file created or changed.
3. Schema/catalog counts and contract families covered.
4. Resolutions for DQ-10 through DQ-17 and AQ-01 through AQ-05.
5. API/error/concurrency/idempotency summary.
6. Job/event/webhook/SSE delivery and retry semantics.
7. Authorization context, audit, notification, usage, entitlement, file, and observability summaries.
8. Validation commands and complete results.
9. Contradictions found in accepted Phase 0 contracts.
10. Open questions grouped by integration blocker, implementation deferral, or product-owner approval.

Do not merely state that the work is complete; provide reviewable evidence.
