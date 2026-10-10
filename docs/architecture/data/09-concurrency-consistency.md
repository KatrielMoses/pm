# 9. Concurrency, consistency, and transactional boundaries

Default: **optimistic concurrency.** Locks are used only for the named invariants in §9.3 ([ADR-12](12-decisions.md#adr-12)). Phase 0D defines public envelopes (conflict response shape, job contracts). This document defines the data foundations those contracts need.

## 9.1 Ordinary edits: field-level optimistic merge

0E requires that edits to **different** fields merge automatically and edits to the **same** field conflict (ST-06). A single row version cannot express that, so field-merge entities (`task`, `project`, custom `field_value`) use **base values**:

1. The client sends, for each changed field, `{field, base, new}`, where `base` is the value it last saw (or that field's hash for rich content), plus the row `version` it read.
2. The command loads the row `FOR UPDATE`. For each changed field: if `current == base`, apply. If `current != base` and `current == new`, it is a no-op. Otherwise it is a **conflict for that field**.
3. If any field conflicts, nothing is applied (atomic per request), and the response lists each conflicting field with `theirs` (current value, plus the last writer's actor, actor type, and time from `updated_by_*` or audit) and `yours`. Non-conflicting fields from the same request are reported as "would merge". The client retries with the chosen resolution, so no partial application leaves the user confused.
4. On success, `version = version + 1` and one audit event lists all changed fields.
5. Whole-record operations (transitions with gates, moves, archive, trash) require `expected_version` to match exactly.

`row-version` entities (documents' metadata, saved views, settings) use plain `expected_version` checks. A mismatch returns a conflict with the current row.

**Rich text and documents:** until realtime editing exists (UXD-01, OD-30), a save that sets `current_version_id` checks `base_version_id`. On mismatch, the client receives the newer version for a per-section conflict view (ST-06), and the user's content is always saved as a new `document_version` (never lost) before resolution. Phase 4D ([ADR-35](12-decisions.md#adr-35)) adds a live mode on top: the server sequences block-level operations on a draft, refuses an operation that no longer fits with the current block, and appends a version only at a checkpoint; this save path remains the fallback and the durable history. While a live session is open, a plain save is refused (`live_edit_in_progress`), and unsaved live work with nobody editing is saved as a version first.

**Goals and portfolios (Phase 5B, [ADR-37](12-decisions.md#adr-37)):** goals, key results, and portfolios are `row-version` records edited with the loaded version (a stale version is a conflict, a missing one is refused). Check-ins are append-only, and the goal's and key result's latest pointers move with the check-in in the same transaction. A background recalculation claims a goal through its state row (`FOR UPDATE SKIP LOCKED`, a lease), recomputes it in its own transaction, and appends a computed check-in only when the inputs hash changed, so an overlapping sweep or a retry appends nothing twice, and a change made while a sweep runs is never lost. Nothing derived from linked work is stored, so no figure can be older than the work it summarizes.

**Dashboards and reports (Phase 5D, [ADR-39](12-decisions.md#adr-39)):** dashboards and report definitions are `row-version` records. A delivery run is unique per occurrence and recipient, so a retried or overlapping sweep finds the existing run; a figure is never stored, so there is no read-after-write window for permission changes.

## 9.2 Inline, bulk, and offline edits

- **Inline edits** are single-field requests (§9.1).
- **Bulk edits** create one `execution.operation (kind = 'bulk_edit')` and apply per record with the same field-merge rule. Each record is its own transaction, in batches of an implementation-defined size. Items that conflict, fail validation, or are unauthorized are reported per item, and the operation ends `succeeded` or `partial`. All rows carry `operation_id`, so **bulk undo** reverts exactly those changes whose current value still equals the operation's `new`. The rest are reported as not reverted (ST-11).
- **Offline queue** (UXD-25): each queued change has a client-generated idempotency key and base values. On reconnect, changes replay in order. Conflicts surface as Conflicted, and duplicates are absorbed by the idempotency key.

## 9.3 Operations that lock or serialize

| Invariant | Mechanism |
|---|---|
| Tree structure (no cycles, depth) | `pg_advisory_xact_lock` on tree root(s), plus `FOR UPDATE` on moved rows ([04 §4.1](04-relationship-primitives.md#41-hierarchies)) |
| Dependency graph (no `blocks` cycles) | Advisory lock keyed by workspace + dependency partition during the cycle check |
| Brand move | Subtree locks, `FOR UPDATE` on envelopes, one transaction or a locked job ([03 §3.7](03-tenancy-brand-sharing.md#37-moving-a-record-to-another-brand)) |
| Archive, trash, restore, purge | `FOR UPDATE` on the batch row plus guarded state transitions |
| Review decisions | `FOR UPDATE` on `review_request`; `UNIQUE (review_request_id)` on decisions |
| Release decisions | `FOR UPDATE` on `release`; `UNIQUE (release_id, sequence)` |
| Status transition with gates | `FOR UPDATE` on the task (gates read reviews, required fields, and deliverables consistently) |
| Running timer | `UNIQUE (membership_id) WHERE ended_at IS NULL`. Start-timer stops the previous one in the same transaction. |
| Locked time periods | `FOR SHARE` on `period_lock` rows during entry writes; `FOR UPDATE` when locking or unlocking |
| Sync cursor | Compare-and-set: `UPDATE sync_checkpoint SET cursor = :new WHERE id = :id AND cursor = :old`. One sync per (connection, resource) via operation dedupe key. |
| Import | `FOR UPDATE` on the import job. Row idempotency via `UNIQUE (import_job_id, row_number)`. Duplicate-file prevention via `content_fingerprint` (DATA-008). |
| One active run per task and agent; duplicate starts (ST-65) | `UNIQUE (task_id, agent_profile_id) WHERE` non-terminal on `agent_run`. Generally, `UNIQUE (workspace_id, kind, dedupe_key)` partial on non-terminal operations. |
| Hard spend caps | `FOR UPDATE` on `metering.usage_balance` to reserve the estimated amount before start; settle or release at the terminal state |
| Recurrence generation | `ON CONFLICT (series_id, occurrence_key) DO NOTHING` |
| Comments, reviews, and following (Phase 4A) | `If-Match` row versions on comment edits. A review request is locked (`FOR UPDATE`) while a decision settles it, so concurrent deciders get one settlement and a conflict. One decision per named reviewer (unique key) and one open request per record (partial unique index). Reactions and follows are idempotent rows (`ON CONFLICT DO NOTHING`). A reply's thread is guarded by a trigger. |
| Files, uploads, and deliverables (Phase 4E) | Upload initiation locks `files.storage_usage` (`FOR UPDATE`) to reserve bytes against the quota; completion locks its session row and is idempotent (a replay returns the outcome). Versions are numbered under the file's row lock and are immutable (trigger). Renames use `If-Match`. Submitting a deliverable locks the deliverable, supersedes an open request, and opens a 4A request in one transaction; a decision settles through the 4A request lock, and a stale request is refused. Accepted versions are evidence-locked by trigger. |
| Notifications and deliveries (Phase 4B) | One notification per recipient and deduplication key (`UNIQUE`, `ON CONFLICT DO UPDATE` collapses repeats). An occasion (one reminder, one due date) is `ON CONFLICT DO NOTHING`. State changes use optional `If-Match` row versions. A delivery is claimed with a lease (`FOR UPDATE SKIP LOCKED`, `lease_until`); an expired lease is reclaimed under the same provider message id, so a crash at worst repeats one send. One digest per recipient, cadence, and period (unique key). The profile is replaced under `If-Match`. |
| Documents and versions (Phase 4C) | A content save locks the document row (`FOR UPDATE`) and names the version it loaded: a stale base is a `conflict` and nothing is overwritten. Version numbers are unique per document, and versions are immutable. Metadata (state, owner, review date, links, placement) uses `If-Match` row versions, independent of content versions. Page tree changes take an advisory lock on the tree's root so depth, breadth, and size bounds hold under concurrency. A suggestion is decided under its own row lock and applies only to a block whose hash is unchanged. |
| Capacity profile and reservations (Phase 3E) | `If-Match` row versions. `pg_advisory_xact_lock` per person for the profile and working hours, and per brand and member for reservations, so concurrent edits give one `conflict`. An overlap guard trigger covers working windows. |
| Workspace ownership transfer, subscription changes | `FOR UPDATE` on the workspace or subscription row |

Lock order (to avoid deadlocks): workspace → brand → tree root advisory locks (ascending ID) → batch → envelope rows (ascending ID) → typed rows → balances.

## 9.4 Ordering keys (drag and drop)

Manual order uses **fractional rank strings** ([ADR-09](12-decisions.md#adr-09)): `rank text COLLATE "C"`. A rank is a base-62 key between its neighbors (`between(a, b)`), generated by the server from neighbor ranks the client sends.

- **Deterministic order:** `ORDER BY rank, id`. Two concurrent inserts between the same neighbors can produce equal ranks, and the tie is broken by ID. No uniqueness constraint on rank is needed, and both moves succeed.
- **Concurrent move of the same item:** row-version check; the last writer conflicts.
- **Rebalancing:** when a rank exceeds a length threshold, a background job rewrites ranks for that container (one container per transaction) and publishes a change notice.
- Ordered contexts: tasks within project or parent (`rank_in_parent`), statuses, phases, checklist items, suite members, favorites, Today commitments (`today_commitment.rank` per person and day), board order by status column (the same rank within project and status context), release checklist, and field options.

## 9.5 Transaction boundaries for multi-record invariants

| Use case | One transaction includes |
|---|---|
| Create addressable record | Envelope + typed row + initial field values + audit event + outbox event + idempotency key row |
| Triage Inbox item | New task, note, or project (via work command) + Inbox item `converted` + audit + outbox |
| Complete task | Gate checks + status change + `completed_at` + audit + outbox (`task.completed`) |
| Accept deliverable | Review decision + deliverable version lock + review request state + audit + outbox |
| Apply AI proposal | All selected changes (atomic per apply, UXD-15) + per-change result rows + audit + outbox. Validation failure rolls back everything and records the failure per change. |
| Agent run terminal state | Operation state + attempt state + deliverable version (if returned) + usage settlement + outbox |
| Share | Grant + audit + security event + outbox |

The rule: **the domain change, its audit event, and its outbox event commit together, or not at all.**

## 9.6 Idempotency, logical operations, and attempts

| Table | Role |
|---|---|
| `execution.idempotency_key (workspace_id, principal_id, key, request_fingerprint, operation_id, response_ref, expires_at)` | `UNIQUE (workspace_id, principal_id, key)`. The same key with a different fingerprint is a conflict error. A key in progress returns "processing". A completed key returns the stored status and resource references, re-rendered through the caller's current authorization; stored response bodies are never replayed verbatim. |
| `execution.operation` | **One logical outcome.** Typed details extend it 1:1 (AI action, agent run, automation run, sync, import, export, bulk edit, brand move, purge, template installation, report run, briefing). |
| `execution.attempt` | Each try (`attempt_number`, state, error). Retry = new attempt on the same operation (ST-64). |
| `execution.external_effect` | `UNIQUE (operation_id, effect_key)`. Every attempt carries the stable key. Destinations that support idempotency may be retried; a receiver must deduplicate by the key. If the outcome is unknown and safe deduplication is unavailable, the effect becomes `unknown` and the operation moves to `waiting` for human confirmation rather than retrying automatically. |
| Natural-key dedupe | Inbound webhooks `(endpoint_id, provider_event_id)`, payment events `(provider, provider_event_id)`, external facts `(connection_id, provider_event_id)`, external identities `(connection_id, external_type, external_id)`, automation runs `(automation_id, trigger_event_id)`, recurrence `(series_id, occurrence_key)`, usage events `(operation_id, attempt_id, meter, sequence)` |

**Rerun ≠ retry.** A rerun (test rerun after a fix, briefing regeneration) creates a **new** operation with `rerun_of_operation_id`.

## 9.7 Outbox and inbox ([ADR-08](12-decisions.md#adr-08))

- **Outbox:** `execution.outbox_event` is inserted in the domain transaction. A dispatcher selects undispatched rows `ORDER BY id FOR UPDATE SKIP LOCKED LIMIT n` and delivers them to in-process consumers (search, insights, notify, activity, automation triggers, webhooks), setting `dispatched_at`. Ordering is per aggregate (consumers that need order process by `aggregate_id`). Delivery is at least once.
- **Inbox:** each consumer records `execution.inbox_receipt (consumer_name, event_id)` in the same transaction as its own writes, so redelivery is a no-op.
- **Jobs:** `execution.job` is the durable queue (roadmap principle 2). It has leases (`lease_until`), backoff, an attempt cap, and a dead-letter state (REL-005), and is fetched with `FOR UPDATE SKIP LOCKED`. **Tenant fairness** (REL-018) uses per-workspace concurrency caps: the fetch query excludes workspaces at their cap, and weighted round-robin applies per queue.
- **Change notices** (UXD-27 live updates) are an outbox consumer that publishes lightweight `{record_public_id, version}` notices to connected clients over SSE. Clients re-fetch through authorized reads, so notices never carry content.
- **Cleanup:** dispatched outbox rows are deleted after a short replay window. Inbox receipts and idempotency keys expire by TTL.

## 9.8 Read models and acceptable lag

| Read model | Fed by | Target lag (to confirm in 0D/11D) | Authorization |
|---|---|---|---|
| Search documents | Outbox | Seconds (SRCH-011 "promptly", OD-17) | Applied at query time. Projection rows hold scope keys, never ACL copies. |
| Activity items | Outbox | Seconds | Query time, both endpoints |
| Metric snapshots, rollups | Outbox + scheduled recompute | Minutes, with freshness shown (RPT-024, ST-47) | Per scope key, summed per viewer |
| Calculated field values | Dependency events | Seconds; "Calculating…" state | As the host record |
| Notification fan-out | Outbox | Seconds | Re-checked at delivery and display |
| Capacity caches | Not built in Phase 3E: capacity is computed on read (ADR-30) | None | Viewer-filtered on every read |

Authorization decisions are **never materialized into projections**. A revoked grant takes effect on the next query without reindexing.
