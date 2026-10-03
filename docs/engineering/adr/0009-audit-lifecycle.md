# ADR-0009: Audit, deletion, and recovery primitives (Phase 1F) — decisions and deviations

Status: **proposed** (awaiting product-owner review). Items under "Needs approval" extend or
interpret an accepted Phase 0 text; everything else implements the brief and 0B §7–§8 / 0D §12 as
written. Engineering detail: [audit.md](../audit.md), [lifecycle.md](../lifecycle.md).

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

## Needs approval

| # | Topic | Accepted text | Implementation | Why | Cost to change |
|---|---|---|---|---|---|
| G1 | Change-entry digest and redaction reason | 0D `audit-event` `changes[]` had no `digest` or `reason` | **Amended at source** (PL-18): `digest` (`sha256:` of the canonical entry) and `reason` added to the 0D schema; stored events are validated against it in tests | Lets the chain cover values while explicit redaction stays verifiable | Low |
| G2 | Chain boundary | 0B §7.6: `prev_hash` "per partition" | One chain per **workspace** (no physical partitions exist). Audited writes in one workspace serialize from their audit insert to commit (advisory lock) | Strongest continuity check now; partitions are deferred (0B §10.9) | Medium: re-anchor per partition if partitioning is introduced |
| G3 | Record types as a table | 0B §2.3: `record_type` "fixed enum of the 30 addressable types" | `core.record_type` table seeded with exactly those 30 (and their 0D prefixes), validated against the 0B model by the Phase 0 validator; test databases register a `test_only` fixture type | The brief requires a test-only type without adding a customer-visible type to the canonical registry; an enum cannot hold one only in tests | Low (convert to enum + check later) |
| G4 | Non-resource set | ADR-0008 B3 closed set | Adds `security_activity` | Security events have no public IDs (0D internal schema), so the account view is not a resource collection | Low |
| G5 | Retention policy source | 0B: `source (platform_default \| plan \| workspace)` | Platform defaults live in configuration (`RETENTION_PERIODS`); table rows are `plan` or `workspace` | Platform defaults are deployment configuration, not tenant rows | Low |
| G6 | Evidence-locked members | 0B §8.8: excluded and kept, remainder proceeds | Excluded members stay `trashed` in the now-terminal batch | No evidence locks exist before TEST-024/025; their later purge belongs there | Medium |
| G7 | Workspace deletion and audit | 0B §8.9: audit for a deleted workspace is deleted with it | Not possible yet: audit DELETE is refused for every role. Workspace deletion (SEC-021) must add a guarded, audited `audit_maintainer` path in its phase | Brief: no workspace deletion in 1F; append-only must not have a backdoor | — |
| G8 | Security-event redaction | 0B: personal values redacted on account deletion | Only `audit_event` has a redaction path (purge). Security events (prefix + UA family, C3) are immutable until account deletion (OD-39) adds one | No account deletion in 1F | — |

## Product-owner decisions still open (not blockers for 1F)

`TRASH_RECOVERY_PERIOD` (OD-34), audit/tombstone retention (OD-36), backup expiry and its
disclosure (OD-42, SEC-020/028, legal review), legal holds (OD-37), purge-ledger store and object
storage vendors. None is chosen or published; every dependent job does nothing while unset.
