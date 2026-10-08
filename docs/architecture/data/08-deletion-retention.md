# 8. Archive, deletion, recovery, retention, and purge

Input: [0A deletion-retention-history](../../product/deletion-retention-history.md). **No durations are chosen here.** Every period is read from `governance.retention_policy` (or plan data). A null period means "not decided", and the dependent job does nothing ([ADR-11](12-decisions.md#adr-11)).

## 8.1 Which data uses which removal model

| Data | Model |
|---|---|
| Addressable records (`lifecycle = full`) | Archive + trash + restore + purge through `core.record` |
| Hosted children (comments, attachments, field values, checklist items, followers, labels) | Follow their host. Comments also support author deletion (blank body, revision retained per OD-38). |
| Append-only evidence (decisions, verifications, test results, approvals) | No trash. Removed only by purge of the container (tombstone kept) or workspace deletion. Evidence locks apply. |
| Execution history, deliveries, usage | Retention purge by data class (R-EXEC, R-BILLING). No trash. |
| Personal data | Deleted with the account or membership (R-PERSONAL) |
| Ephemeral (sessions, idempotency keys, outbox, jobs, verification tokens) | TTL cleanup jobs |
| Derived projections | Rebuilt or deleted with their sources |

Soft deletion is used **only where recovery is promised**.

## 8.2 Envelope columns

`core.record`: `lifecycle_state`, `archive_cause` (`self`/`cascade`), `archive_batch_id`, `archived_at/by`, `deletion_batch_id`, `prior_lifecycle_state`, `trashed_at/by`, `purged_at`. Typed rows mirror `lifecycle_state` through the deferrable composite foreign key ([02 §2.3](02-logical-model.md#23-the-record-envelope)).

## 8.3 Archive

1. `core.archive(record)` locks the subtree (tree advisory lock + `FOR UPDATE` on envelopes), creates an `archive_batch`, and sets `lifecycle_state = 'archived'` on the root (`archive_cause = 'self'`) and on active descendants (`'cascade'`, same batch). Already-archived descendants keep their own cause and batch.
2. Restore from archive reverses only rows in **that** batch with cause `cascade`, plus the root (0A hierarchy §3.1).
3. Archived rows are read-only. Commands check `lifecycle_state = 'active'` for writes, except comments where policy allows (ST-48).

## 8.4 Trash and deletion batches

1. `core.trash(record)` creates a `deletion_batch (root_record_id, state='trashed', trashed_by, trashed_at, restore_location)` and moves the root and its contained subtree to `trashed`. It records `prior_lifecycle_state` for each row (so archived children return as archived) and sets `deletion_batch_id`. Descendants already in another batch are untouched.
2. Associations to trashed records stay stored and are hidden by the read filter (both endpoints must be `active`, or `archived` where views include archived).
3. Grants stay. Trashed records are invisible because of their state.
4. Emits `record.trashed`. Search removes entries, notifications for the subtree stop, and pending reminders and automations skip trashed targets.

## 8.5 Restore

`core.restore(batch)`:

- **Idempotent:** batch state `trashed` → `restoring` → `restored`, with the transition guarded by `UPDATE … WHERE state = 'trashed'`. Repeated calls return the existing outcome.
- **Preconditions:** the container recorded in `restore_location` is active. Otherwise the command fails with a typed reason, and the UI offers to restore the container or, for tasks, to restore as projectless in the same brand (0A, ST-46). The brand must be active.
- **Effect:** sets each row's `lifecycle_state = prior_lifecycle_state` and clears the batch fields. Emits `record.restored`. Notifications, automations, and webhooks from the original history are **not** replayed (0A deletion §2).

## 8.6 Default exclusion of deleted data

- Repository and query APIs add `lifecycle_state = 'active'` by default. Including archived data requires an explicit option, and trashed data is reachable only through the Trash query API (0C decides who sees Trash, ST-46).
- Every hot index is partial: `… WHERE lifecycle_state = 'active'` ([10 §10.5](10-postgresql-guidance.md#105-index-guidance)).
- The view engine and search add the predicate in compiled SQL. Projections (search, metrics) drop non-active records on `record.*` events.
- Lifecycle filtering is **not** done with RLS. RLS is reserved for tenant isolation, so that lifecycle tools (Trash, restore, purge) can work without bypassing security.

## 8.7 Tombstones and broken associations

On purge, the `core.record` row **remains** with `lifecycle_state = 'purged'`, `purged_at`, `record_type`, `public_id`, scope keys, and creation and deletion actors. No content is kept: titles live only in typed tables, which are deleted. Effects:

- Links to a public ID resolve to "Deleted item" (ST-41 shows not-available to everyone).
- Association rows referencing a purged record are deleted by the purge job, and the audit event records `relationship.removed_by_purge`. Mentions inside surviving text render as "Deleted item".
- Append-only rows keyed by target ID (audit, activity, usage) remain, and their content values are redacted (§8.9).
- Tombstones are kept for the audit retention period, then removed by a final sweep that writes no events.

## 8.8 Purge jobs

Purge is a durable `execution.operation` of kind `purge` per batch, driven by a scheduler that selects `deletion_batch WHERE state = 'trashed' AND trashed_at + :period <= now()`. The scheduler runs only when `TRASH_RECOVERY_PERIOD` is set (OD-34) and no `legal_hold` covers the scope. Manual permanent deletion (admins) creates the same operation immediately.

Steps (each idempotent, resumable from the operation's checkpoint):

1. Transition the batch `trashed` → `purging` (guarded update). Abort if a hold or evidence lock applies. Evidence-locked rows are excluded and kept, and the remainder proceeds.
2. Delete typed rows bottom-up per module through each module's purge hook. Hooks delete hosted children (comments, field values, followers, labels, checklist items) and association rows.
3. Enqueue object deletions as `execution.external_effect` rows (effect key = object key). An object is deleted only when no `file_version` references it.
   *Phase 4E ([ADR-34](12-decisions.md#adr-34)):* the effect key is `object:{key}` (keys carry no identifiers); the file sweep deletes the bytes idempotently and then the orphan row. Evidence-locked versions and the objects they use are skipped. No retention period is set (OD-36): files live until their host or workspace is purged.
4. Redact content values in audit and activity for the purged targets (§7.7 of [07](07-audit-provenance.md#77-redaction-and-purge-of-evidence-explicit-never-silent)).
5. Remove search documents, metric contributions (re-aggregate), notification bodies, and AI context caches.
6. Convert envelopes to tombstones and transition the batch to `purged`. Emit `record.purged`.

## 8.9 Account and workspace deletion

`governance.deletion_request` drives both workflows as state machines (`requested → grace → purging → completed | cancelled`):

| Workflow | Data effect |
|---|---|
| Workspace deletion (SEC-021) | During `WORKSPACE_DELETION_GRACE_PERIOD`, `workspace.state = 'deletion_pending'`: no member access, cancellation possible, and a full export is offered. Purging deletes all tenant schemas' rows for the workspace by module in dependency order. With partitioned tables this is a delete by `workspace_id`; the per-tenant volume is bounded. Objects are deleted via effects, and audit for the workspace is deleted with it. **`billing.billing_account`, `billing.invoice`, `billing.payment_event`, and billing-relevant `metering.usage_event` aggregates are retained** (R-BILLING, legal, OD-36). They carry `workspace_id` as a plain reference without a foreign key cascade. |
| Account deletion | Blocked while the account is the sole owner of any workspace (OD-39 safe default). Ends memberships, deletes personal-scope rows (R-PERSONAL), and pseudonymizes the account (`pseudonym`, cleared email and name) so actor references stay valid. Audit `changes` with `personal` class values about the person are redacted with audit_redaction rows. |
| Member removal | Membership `removed`, sessions revoked, record ownership reassigned by command (PERM-014). Personal-scope data is deleted after the recovery period unless exported (OD-39). |

## 8.10 Cancellation, payment failure, read-only

`billing.subscription` states drive `tenancy.workspace.state`:

- `cancelled_read_only` and `restricted` set `workspace.state = 'read_only'`.
- The central command guard rejects mutations other than export, billing recovery, and ownership/admin actions. Execution layers (AI, agents, automations, integrations, scheduled reports) refuse to start. Their schedulers check workspace state.
- Data is never deleted because of payment state alone (BILL-019).
- `read_only_ends_at` comes from `CANCELLATION_READ_ONLY_PERIOD`. When it passes, a deletion request is created automatically only if the product owner approves that path (OD-35).

## 8.11 External systems and backups

- **Integrations:** disconnect with "remove" trashes mirrored records as one deletion batch. "Retain" detaches them. Data already pushed to external systems (GitHub issues, calendar events) is **not** deleted remotely unless the user chooses that per integration. The choice is stored on the disconnect operation and audited.
- **Exports:** export files are objects with an expiry (`EXPORT_LINK_LIFETIME`) and are deleted by TTL job. Copies the customer has downloaded are outside our control (0A).
- **Backups:** purged data persists in backups until backup expiry (OD-42). A restored backup would not contain purges completed after its backup point, because their batch rows were written after the backup. Every completed purge and account/workspace deletion therefore also appends an entry to a **purge ledger held outside the database backup set**: an append-only, write-once object-storage log of IDs and scopes only, with no content. After any restore, a mandatory post-restore job replays ledger entries newer than the backup point before the database reopens. Otherwise purged data would reappear, so this is a **required** part of the restore runbook (11C).
