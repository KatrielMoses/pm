# Developer Brief — Phase 1F: Audit, Deletion, and Recovery Primitives

## Objective

Build the reusable historical-truth and lifecycle foundation that every later domain module will use. Implement immutable audit and security events, the addressable record envelope, archive/trash/restore batches, tombstones, retention and purge hooks, and the lossless migration of Phase 1B security events into the final audit sink.

This phase delivers infrastructure and a small working vertical slice. It must not invent project/task behavior, workspace administration, or final retention periods.

## Read first

- `FEATURES.md`, especially AUD-001 through AUD-008, SEC-020, SEC-021, SEC-023, SEC-024, DATA-012, and LA-018;
- `BUILD_ROADMAP.md`, `ROADMAP_CHECKLIST.md`, and all accepted Phase 0 contracts;
- `docs/architecture/data/07-audit-provenance.md`;
- `docs/architecture/data/08-deletion-retention.md`;
- the `audit` and `core` entities in `docs/architecture/data/generated/logical-model.md`;
- `docs/architecture/platform/12-audit-and-security-events.md`;
- `docs/product/deletion-retention-history.md`;
- `docs/architecture/access/11-trash-archive-departure.md` and the permission matrix;
- `docs/engineering/adr/0008-identity-and-sessions.md`, especially the Phase 1F security-event-buffer handoff.

Run the Phase 0 validator first and keep it green. Do not edit `BUILD_ROADMAP.md`, mark the checklist complete, choose legal/retention durations, or push/commit unless the product owner asks.

## Scope and sequencing constraints

- Phase 1C has not created brands and Phase 1D has not created memberships. Use the existing workspace anchor for tenant isolation. Keep `brand_id`, membership references, and later-domain target IDs as validated plain references where their owning table does not yet exist; add explicit follow-up constraints for the owning phase. Do not create placeholder brand/member tables.
- Authentication proves identity only. Tenant lifecycle and audit APIs must not become user-accessible until a real workspace membership and policy decision exists.
- Provide internal services, database enforcement, test fixtures, and reusable UI components now. The only user-facing route in this phase may be an account-owned security activity view, because account ownership can be established without tenant membership.
- Do not implement projects, tasks, files, comments, search, exports, legal-hold administration, account deletion, or workspace deletion end to end. Provide the contracts/hooks those phases require.

## Prescribed invariants

- A material mutation and its audit event commit in the same transaction. If the audit insert fails, the mutation fails.
- Audit/security events and redaction records are append-only. Ordinary application, worker, support, and tenant-admin paths receive no UPDATE, DELETE, or TRUNCATE capability.
- Tenant audit/core rows use database-enforced workspace existence, `FORCE ROW LEVEL SECURITY`, and the Phase 1A fail-closed transaction context. No wildcard tenant access.
- Targets have no audit foreign key: historical facts survive target purge. Tenant root foreign keys remain where required for live tenant rows.
- Secrets are never audit values. Content is represented by hash/version reference; personal values are explicitly classed for later redaction; secret values record only `changed: true`.
- Soft deletion exists only where recovery is promised. Purge is durable, resumable, idempotent, and never implied by payment failure.
- Every retention period is a named nullable policy value. Null means the dependent purge does nothing. Do not publish or hard-code a duration.
- Lifecycle filtering is implemented in repository/query policy, not RLS. RLS isolates tenants; explicit lifecycle predicates distinguish active, archived, trash, and tombstone access.

## Required database work

Add ordered expand migrations after 0012 and implement the accepted models.

### Audit schema

Create:

- `audit.audit_event` with UUIDv7 identity, statement time, workspace/brand-at-event-time, action, full actor/on-behalf-of/delegation context, target record/type/public ID without target FK, validated classified changes, operation/attempt/correlation/causation fields, source/provenance, workflow revision reference, `R-AUDIT`, and tamper-evidence fields;
- `audit.audit_redaction` as an append-only explicit record of which event fields were redacted, why, who/what authorized it, operation, and time;
- `audit.security_event` supporting workspace-null account events and workspace-scoped events, accepted categories/outcomes, actor and subject, minimized network context, correlation, and `R-AUDIT`;
- `audit.activity_item` only as the rebuildable projection foundation needed to prove safe projection and later filtering. Do not build the final Activity product view.

Use database checks or validated constructors so malformed `changes` cannot store secrets, unclassified values, or unbounded JSON. Establish partition-ready indexing without premature physical partitioning unless existing migration guidance requires it.

Create the `audit_maintainer` operational role/grant boundary deferred from 1A. It must not be usable by normal API/worker connections. A guarded redaction procedure may mutate only approved value fields when both the role and transaction-local redaction operation ID are present; structural facts remain immutable. Add triggers that reject every other update/delete, including table-owner mistakes exercised by tests where practical.

Implement deterministic canonical serialization and hash chaining per the accepted partition/chain boundary. Add a verification job/command that detects missing, reordered, or altered events. Document what it detects and does not detect; do not claim cryptographic non-repudiation.

### Core record and lifecycle schema

Create:

- `core.record` with the accepted identity, public ID, record type, workspace/optional brand/scope key, optional personal owner, lifecycle, archive/deletion references, prior state, timestamps/actors, provenance, and optimistic version columns;
- `core.archive_batch` and membership information sufficient for exact cascade reversal;
- `core.deletion_batch` with root, scope, state, actor/time, restore location, member count, hold/evidence-block result, operation/checkpoint references, and terminal outcome;
- any narrowly required batch-member table if needed to restore exact prior lifecycle states safely.

Enforce unique public IDs and the composite keys later typed domain tables will reference. Use a deliberately registered test-only record type or a production-neutral `foundation_fixture` only in test schema/fixtures—do not add a fake customer-visible domain type to the canonical registry.

`brand_id` may remain a plain same-workspace value until 1C creates `tenancy.brand`; document the exact FK migration 1C must add. The workspace foreign key and RLS are required now.

## Shared command and event pipeline

Implement typed reusable services for domain modules:

- a command context containing authenticated/effective actor, on-behalf-of/delegation chain, tenant/scope, operation/attempt, correlation/causation, source, and field policy;
- an audit writer called inside the caller transaction;
- validated change builders for `plain`, `content`, `personal`, `secret`, and `credential_ref` classes;
- material-change detection so presentation-only changes produce no audit event;
- a security-event writer that supports both mutually exclusive account/platform and tenant contexts;
- an outbox hook for derived activity/projection work without weakening same-transaction audit truth;
- adapter interfaces for later modules to register lifecycle containment, purge, search/projection removal, object effects, and evidence locks.

Do not let callers supply arbitrary actor authority, workspace, class, or redaction decisions from browser input. Derive these from trusted server context and registered field catalogs.

## Phase 1B security-event handoff

Follow ADR-0008 exactly:

1. Point `SecurityEventPort` at `audit.security_event` before draining, or use a bounded dual-write cutover.
2. Copy every `identity.security_event_buffer` row idempotently using its original ID and `occurred_at`.
3. Drain in bounded ordered batches and support safe resume after interruption.
4. Verify total and per-day counts plus SHA-256 of canonical copied fields. Any mismatch stops retirement.
5. Preserve the buffer through at least the verified cutover. Remove its INSERT grants and table only in a later contract migration, not the initial expand migration.

Tests must cover rerun, interruption, concurrent new events during cutover, mismatched checksum, and zero-event cases. Identity flows must continue writing security events without knowing which sink is active.

## Lifecycle commands

Implement reusable internal commands and test them through a synthetic contained-record adapter:

### Archive and unarchive

- Lock the containment subtree deterministically, create an archive batch, mark the root `self` and active descendants `cascade`, and leave already archived descendants tied to their original batch.
- Restore only the root and rows cascaded by that batch. Archived records are read-only except where a future policy explicitly permits an operation.
- Repeated/concurrent requests are idempotent and cannot split a subtree.

### Trash and restore

- Create one deletion batch; preserve every member's prior lifecycle state and restore location; touch containment children only, never mere associations.
- Default reads exclude trash. Only an explicit trash repository can enumerate it, and that repository still requires a future `trash.manage` policy decision.
- Restore is the guarded `trashed → restoring → restored` state machine. It preserves IDs, restores prior states, and never replays original notifications, automation, webhooks, or integrations.
- Return typed failures for missing/trashed containers, inactive brand, expired recovery eligibility, hold, evidence lock, or concurrent state change. Do not implement the task-specific “restore as projectless” choice before 2B.

### Purge and tombstones

- Use a durable `exec.operation`/job with checkpointed, idempotent module hooks and stable external-effect keys.
- Transition `trashed → purging → purged` under a guarded lock. Abort or exclude held/evidence-locked material as the accepted contract specifies; record the result explicitly.
- Delete typed content bottom-up, remove associations/projections through registered hooks, enqueue—not directly perform—object deletion effects, explicitly redact protected audit values, and retain a content-free `core.record` tombstone.
- Tombstones retain only the accepted structural fields. Links resolve to a generic deleted-item representation with no title, prior content, unauthorized scope, or existence leakage.
- A final tombstone sweep exists only as a disabled retention hook until its policy duration is set.

Do not pretend later modules have been purged. The registry must fail a purge safely if a record type has no required purge hook.

## Retention and purge-ledger foundations

- Implement typed retention policy keys/classes with nullable values and validation, but no product-owner durations.
- Schedulers enqueue nothing when the relevant value is null. Add tests proving this fail-safe behavior.
- Add a provider-neutral append-only purge-ledger interface outside the ordinary database backup boundary. Provide a deterministic local/test adapter and a deployed-mode startup/configuration guard; do not select a cloud vendor.
- A purge is not complete until its ledger entry is durably acknowledged. Ledger entries contain identifiers/scopes/times only, never customer content.
- Add a post-restore replay command contract that blocks environment reopening until newer ledger entries are re-applied. Full provider restore automation remains Phase 11C.
- Document retention, backup residuals, legal review dependencies, and the difference between trash, purge, tombstone expiry, and backup expiry.

## API and UI deliverables

- Do not expose workspace audit/trash/lifecycle APIs without membership authorization. Implement internal route/service boundaries ready for 1C/1D policy injection.
- Extend Account Security with an accessible “Security activity” view for the signed-in account. It may show only that account's safe security events: timestamp, generic action/outcome, own session/factor context, and masked device/network information. It must not expose other accounts, internal UUIDs, raw IPs, tokens, email addresses, or tenant events.
- Provide reusable accessible components/states for audit change lists, redaction markers, deleted-item tombstones, trash metadata, restore conflicts, and irreversible purge confirmation. Story/test harnesses are acceptable until tenant routes exist.
- Cover loading, empty, pagination, error, offline/retry, redacted, deleted target, and permission-unavailable states at desktop/mobile widths, keyboard-only use, reduced motion, high contrast, and 200% zoom.

## Authorization, privacy, and observability

- Account security activity is own-only. Tenant audit/trash services require an explicit policy decision object that cannot be constructed from request data; until 1D, no public tenant route may obtain one.
- Field-level display/export policy must redact unreadable values rather than leaking them through diffs, counts, filters, summaries, errors, or timing-dependent lookups.
- Add bounded metrics for audit writes/failures, chain verification, buffer-drain progress, lifecycle transitions, purge backlog, blocked purges, hook duration/failure, redactions, and ledger acknowledgements. No tenant, actor, record, email, IP, action target, or content value as a metric label.
- Propagate trace/correlation/operation context. Logs contain IDs only where allowed by the observability contract and never audit change content.
- Alert-worthy audit failure must roll back the associated mutation and emit a content-safe operational signal.

## Required automated tests

At minimum:

- migration up/down/checksum and constraint/index/grant tests on real PostgreSQL;
- RLS tests for two workspaces, unset/wrong/reused context, worker/app identities, platform account events, and forbidden cross-context reads/writes;
- database-level append-only tests against application, worker, support-like, maintainer, and owner/error paths;
- classified-change schema tests proving secrets/oversized/malformed changes are rejected;
- mutation rollback when audit writing fails;
- hash-chain deterministic serialization, continuity, tamper, missing-row, and concurrency tests;
- exact Phase 1B buffer cutover/drain/replay/checksum tests;
- archive/trash/restore/purge state-machine, idempotency, concurrency, containment-versus-association, prior-state, missing-container, hold/evidence-lock, and tombstone tests;
- purge-hook interruption/resume, absent-hook fail-safe, external-effect dedupe, ledger failure/retry, and null-retention no-op tests;
- tests proving normal reads exclude archived/trash as specified and tombstones reveal no content;
- account security activity ownership/non-disclosure tests;
- browser/component accessibility tests for the account activity view and reusable lifecycle states;
- redaction tests across logs, traces, metrics, errors, UI, and retained reports;
- all existing Phase 1A/1B identity, RLS, job, browser, scanning, and production-image gates.

## Non-goals

- Workspace/brand product behavior and brand switcher (1C).
- Membership roles, invitations, tenant audit permissions, or admin audit viewer (1D/10C).
- Final application navigation (1E).
- Project/task/document/file-specific lifecycle hooks; owning phases must register them.
- Final Activity product, audit export, search indexing, legal-hold UI, or retention administration.
- Account/workspace deletion execution before ownership/membership/export/billing modules exist.
- Choosing or publishing recovery, retention, backup, or grace-period durations.
- Choosing object storage, purge-ledger, KMS, or observability vendors.

## Acceptance criteria

- Material mutations cannot commit without their valid same-transaction audit events.
- Audit, redaction, and security-event storage is append-only under database enforcement and isolated correctly.
- Phase 1B events write to the final sink and the existing buffer can be drained/resumed/verified without loss or duplication.
- Record envelopes, archive, trash, restore, purge, and tombstones follow the accepted state and containment semantics under concurrency.
- Purge is durable, checkpointed, hook-driven, fail-safe, externally ledgered, and disabled when policy is unset.
- No premature tenant endpoint bypasses missing 1C/1D authorization.
- The account owner can access an accessible, privacy-safe security activity view containing only their own events.
- Phase 0 validation, generated-contract checks, all real-PostgreSQL suites, browser/accessibility tests, scans, and production-image runtime gates pass without skips.

## Required completion response

Return:

1. Outcome summary and versions/dependencies changed.
2. Every changed file and migration.
3. Implemented schemas, grants/RLS, append-only enforcement, event pipeline, and hash-chain design.
4. Phase 1B buffer cutover/drain/checksum evidence.
5. Lifecycle state machines, purge-hook registry, ledger behavior, and deliberately deferred module hooks.
6. API/UI behavior and proof that tenant endpoints remain unavailable without real policy decisions.
7. Test inventory and counts by unit, database/integration, concurrency, browser/accessibility, security, and recovery category.
8. Clean verification command, exit status, immutable CI run/commit, PostgreSQL image, production-image digest/size/non-root result, and confirmation of zero skipped gates.
9. Scan/redaction evidence and any deviation, limitation, unresolved decision, or failed gate.

Do not report Phase 1F complete if the identity buffer is merely abandoned, append-only behavior relies only on application convention, purge proceeds without registered hooks/ledger acknowledgement, a null retention value triggers deletion, or tenant APIs bypass missing membership authorization.
