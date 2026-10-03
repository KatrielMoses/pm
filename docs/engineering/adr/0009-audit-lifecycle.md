# ADR-0009: Audit, deletion, and recovery primitives (Phase 1F) — decisions and deviations

Status: **accepted and implemented** (Phase 1F review 01). G1–G5, G7, and G8 are accepted. G6
was rejected and replaced by residual batches. No item awaits approval. Engineering detail:
[audit.md](../audit.md), [lifecycle.md](../lifecycle.md).

## Decisions inside the brief

| # | Topic | Decision | Why |
|---|---|---|---|
| F1 | Schemas | `audit` (audit_event, audit_redaction, security_event, chain_checkpoint, activity_item, buffer_verification), `core` (record_type, record, archive_batch(+member), deletion_batch(+member)), `governance.retention_policy`, `ops.recovery_gate`. Migrations 0013–0015 (expand) | 0B §7, §8, §2.3 |
| F2 | `audit_maintainer` | NOLOGIN role in the role bootstrap (1A D11 deferred it). Only `pm_owner` holds membership (SET only, for ownership transfer); no login identity can become it. It owns only the guarded `audit.redact_purged_values` | 0B §7.1, 0C §12.3 |
| F3 | Append-only | No UPDATE/DELETE/TRUNCATE grants for application roles; triggers reject every mutation for every role (owner included) except a value-only redaction by `audit_maintainer` under a transaction-local redaction operation; TRUNCATE triggers on every audit table | Brief: not application convention |
| F4 | Classified changes | Field catalogs + typed builders + material-change detection in `@pm/audit`; `audit.valid_changes` re-validates in the database (classes, digests, bounds, no secret values, no content bodies, secret-looking names) | 0B §7.3, 0D §12.1 |
| F5 | Same-transaction truth | The writer runs in the caller's transaction; any failure throws `AuditWriteError`, rolls the mutation back, counts `audit.write_failures{module}`, and logs IDs only | 0D §12.2 |
| F6 | Partition readiness | PKs include the time column (`(occurred_at, id)`, `(redacted_at, id)`, `(created_at, id)`); no FKs into audit tables; not partitioned | 0B §10.9 |
| F7 | Security events | `AuditSecurityEventSink` (account events in platform scope, tenant events in workspace scope; RLS policies are mutually exclusive); identity uses it by default | 0D §12.3, ADR-0008 B4 |
| F8 | Phase 1B handoff | Executed as ADR-0008 specifies: cutover first; idempotent, resumable, ordered batch drain keyed by original id/time; count + per-day + SHA-256 verification recorded append-only; retirement only by a later contract migration gated on `bufferRetirementReady()` | ADR-0008 |
| F9 | Lifecycle commands | archive/unarchive/trash/restore in the caller's transaction with deterministic subtree locks, exact batch membership, guarded state machines, typed failures, audit + outbox per member; restore replays nothing | 0B §8.3–§8.5 |
| F10 | Lifecycle filtering | Repository predicates, not RLS; trash only through `listTrash` with `trash.manage`; one `DELETED_ITEM` for every non-readable link | 0B §8.6, ST-41 |
| F11 | Purge | Durable `purge` operation; checkpointed steps; module hooks; object deletions enqueued as effects; guarded redaction; ledger append as an effect; batch `purged` only with a ledger acknowledgement (DB-checked); blocks recorded before anything is deleted | 0B §8.7–§8.8 |
| F12 | Retention | Nullable values only (`RETENTION_PERIODS` platform defaults + `governance.retention_policy`); NULL ⇒ the scheduler selects nothing; tombstone sweep is a disabled hook | 0B ADR-11, OD-34/36 |
| F13 | Purge ledger + recovery gate | Provider-neutral `PurgeLedger`; local file adapter refused when deployed; `ops.recovery_gate` blocks readiness and worker start until replay; replay contract implemented, automation is 11C | 0B §8.11 |
| F14 | No premature tenant endpoints | `PolicyDecision` issued only by token holders (1D policy layer, system purge, test subpath); no tenant lifecycle/audit route; confinement tests | Brief; 0C |
| F15 | Account security activity | `GET /v1/auth/security-activity`: own account-level events only; masked network; no internal IDs; account-bound encrypted cursor | Brief: the only user-facing 1F route |
| F16 | Activity projection | Outbox consumer on `core.record.*`; plain short values only; rebuildable; removed on purge. Not the final Activity product | 0B §7.2 |

## Review dispositions (G1–G8)

| # | Topic | Disposition | Final decision |
|---|---|---|---|
| G1 | Change-entry digest and redaction reason | **Accepted; at source** | `digest` (`sha256:` of the canonical entry) and `reason` are part of the 0D `audit-event` schema (PL-18). Stored events are validated against it in tests |
| G2 | Chain boundary | **Accepted, with guardrails** | One chain per workspace for the current unpartitioned architecture. The serialization cost is measured: `audit.chain.lock_wait` separately from `audit.write.duration`, `audit.chain.lock_wait_exceeded`, and a content-free warning above `AUDIT_CHAIN_LOCK_WAIT_WARN_MS`. A delayed-holder contention test covers it. Writing rules and the Phase 11D trigger are in [audit.md](../audit.md#chain-lock-contention-accepted-tradeoff-measured) |
| G3 | Record-type registry | **Accepted** | `core.record_type`, seeded and validated exactly from the 0B catalog by the Phase 0 validator. Production roles have no write grant on it, so test-only types can be registered only by test fixtures |
| G4 | Non-resource set | **Accepted** | `security_activity` joins the closed non-resource response types |
| G5 | Platform retention defaults | **Accepted** | Nullable platform defaults come from validated configuration (`RETENTION_PERIODS`). Plan and workspace overrides are policy rows |
| G6 | Evidence-locked members | **Rejected → replaced** | Partial exclusions move into successor `trashed` batches, with lineage, inside the purge's `begin` transaction. The original batch keeps immutable history and becomes terminal only after every exclusion is owned by a retryable successor. Database invariants: one active membership per record, and no terminal batch owning trashed records (migration 0016). See [lifecycle.md](../lifecycle.md#residual-batches-partial-evidence-lock-exclusions) |
| G7 | Workspace deletion and audit | **Accepted (deferred)** | Audit stays undeletable for every role until the workspace-deletion phase adds a narrowly guarded `audit_maintainer` removal procedure |
| G8 | Security-event redaction | **Accepted (deferred)** | Security events stay immutable until account deletion adds personal-data redaction |

## Future-phase owners

- **Workspace deletion (SEC-021):** must add and test the guarded audit-removal path (an
  `audit_maintainer` procedure scoped to the deleted workspace and its deletion operation) before
  SEC-021 can pass.
- **Account deletion (OD-39):** must add security-event personal-data redaction (network prefix,
  user-agent family, and personal audit values of the person) before account deletion can pass.
- **Phase 11D:** owns the measured chain-contention re-evaluation. Contention beyond the
  documented threshold requires deterministic chain lanes or time partitions that keep
  verifiability.
- **1C / 1D / 2B / TEST-024/025:**
  - 1C: brand and membership foreign keys and the real BrandPort;
  - 1D: the policy-decision issuer and per-record trash visibility;
  - 2B: restoring a task as projectless (residual batches whose container was purged);
  - TEST-024/025: real evidence-lock adapters.

## Product-owner decisions still open (not blockers for 1F)

`TRASH_RECOVERY_PERIOD` (OD-34), audit/tombstone retention (OD-36), backup expiry and its
disclosure (OD-42, SEC-020/028, legal review), legal holds (OD-37), purge-ledger store and object
storage vendors. None is chosen or published; every dependent job does nothing while unset.
