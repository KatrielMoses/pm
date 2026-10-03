# Records, lifecycle, retention, and recovery (Phase 1F)

Package: `@pm/lifecycle`. Schemas: `core` (migration 0014), `governance.retention_policy` and
`ops.recovery_gate` (0015). Decisions: [ADR-0009](adr/0009-audit-lifecycle.md). Product rules:
[deletion, retention, history](../product/deletion-retention-history.md). Architecture:
[0B §8](../architecture/data/08-deletion-retention.md).

## The record envelope

`core.record` holds identity (`id`, `public_id`), `record_type`, scope (`workspace_id`, `brand_id`,
generated `scope_key`), the optional `owner_membership_id`, lifecycle state, archive and deletion
references, provenance, creation facts, and `version`.

- **Record types.** `core.record_type` is seeded with the 30 addressable 0B types and their 0D
  prefixes. The Phase 0 validator checks that the seed equals the 0B model. Test databases register
  a `test_only` type (`foundation_fixture`) in their fixtures; production migrations never do.
- **Typed tables** (later phases) share the id and reference
  `(id, workspace_id, scope_key, lifecycle_state)` with
  `ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED`. The typed row then mirrors the envelope's
  lifecycle state automatically and is checked at commit.
- **Guards** (trigger and checks):
  - identity, scope, and creation facts are immutable;
  - lifecycle transitions are allowed only as
    `active→archived|trashed`, `archived→active|trashed`, `trashed→active|archived|purged`;
  - tombstones are immutable, and only tombstones may be deleted (the final sweep);
  - every update increments `version` by exactly one;
  - per-state column checks hold (for example, tombstones hold no owner, source reference, or
    archive data).

### Follow-up constraints for later phases

`brand_id` and `owner_membership_id` are validated plain references until their tables exist.
There are deliberately no placeholder brand or member tables.

**1C** (after `tenancy.brand` exists with `UNIQUE (workspace_id, id)`), in an expand migration:

```sql
ALTER TABLE core.record ADD CONSTRAINT record_brand_fkey
  FOREIGN KEY (workspace_id, brand_id) REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE core.record VALIDATE CONSTRAINT record_brand_fkey;
-- Same for core.archive_batch (archive_batch_brand_fkey) and core.deletion_batch (deletion_batch_brand_fkey).
-- Replace BRANDS_UNTIL_1C with the real BrandPort (restore into an archived brand is blocked).
```

`audit.audit_event.brand_id` and `audit.activity_item.brand_id` stay plain forever: they record
the scope at event time and must survive brand moves and purges.

**1D:**

- add `FOREIGN KEY (workspace_id, owner_membership_id) REFERENCES access.membership (workspace_id, id)`
  on `core.record`;
- implement the policy layer that issues `PolicyDecision` for `record.archive`, `record.restore`,
  `record.trash`, `record.purge`, `trash.manage`, and `audit.view`;
- add per-record trash visibility for editors (0C §11.1).

## Policy decisions (no premature tenant endpoints)

Every lifecycle command and the trash repository require a `PolicyDecision` for the exact action,
workspace, and target. Only an issuer holding the module-private token can build one:

| Issuer | Use |
|---|---|
| 1D policy layer (future) | Real member decisions |
| `systemDecision('record.purge', …)` | The scheduled retention purge, which runs as the system |
| `@pm/lifecycle/testing` | Tests only |

A unit test enforces the boundary:

- no application source imports `@pm/lifecycle/testing`;
- the API process does not import `@pm/lifecycle`;
- no `/v1` route path contains trash, archive, restore, purge, retention, records, lifecycle, or
  tenant audit.

## State machines

**Archive** (`archive`, `unarchive`):

1. Take the tree advisory lock on the root, then lock envelopes level by level in id order
   (`FOR UPDATE`). Descendants come only from registered containment adapters; associations are
   never followed.
2. Archive the root (`self`) and its active descendants (`cascade`) as one `archive_batch`, with
   exact `archive_batch_member` rows. Descendants already archived keep their own batch.
3. `unarchive` reverses exactly that batch: the root plus that batch's cascade members. It refuses
   a cascaded member (`archived_by_container`) and an inactive container.

Archived records are read-only (`assertWritable`). Repeated or concurrent requests return the
existing batch; a second caller waits on the locks and sees the result.

**Trash and restore** (`trash`, `restore`):

- **Trash.** One `deletion_batch` covers the root and its active or archived subtree. Each
  `deletion_batch_member` keeps the prior state, depth, and record type. The restore location is
  the container, from the adapter. Members of another batch are untouched.
- **Restore.** `trashed → restoring → restored`, using guarded `UPDATE … WHERE state = …`.
  Concurrent restores return `alreadyRestored`. IDs are preserved and prior states return
  (archived children come back archived).
- **Events.** Each member gets a distinct `core.record.restored` event; nothing from the original
  history is replayed.
- **Typed failures:**
  - `container_trashed`, `container_missing`, `container_inactive`;
  - `brand_inactive` (BrandPort);
  - `recovery_expired` (the R-LIVE period is set and has passed);
  - `not_restorable`, `concurrent_change`, `not_found`.

  A failed restore leaves the batch as it was (one transaction).
- **Out of scope:** the task-specific "restore as projectless" choice waits for 2B.

**Reads** (`records.ts`):

- `getRecord` and `listRecords` default to `active`; `active_or_archived` must be requested
  explicitly.
- Trashed and purged rows are never returned. Only `listTrash`, with a `trash.manage` decision,
  enumerates batches.
- `resolveRecordLink` returns one constant `DELETED_ITEM` for purged, trashed, unknown, malformed,
  and other-tenant IDs, so a link reveals neither content nor existence.

## Purge

Purge is a durable `exec.operation` of kind `purge` (R4) with job `lifecycle.purge`, created by
`requestPurge`. That happens either manually, with a `record.purge` decision, or from the retention
scheduler as the system. It is idempotent per batch while in flight. Each step is a checkpoint and
is idempotent:

| Step | What happens |
|---|---|
| `begin` | Checks, in order: ledger available, every member type has purge hooks, no hold (HoldPort), evidence locks (adapter). A block is recorded on the batch (`block_result`: `ledger_unavailable`, `missing_purge_hook`, `hold`, `evidence_lock_all`) and nothing is deleted. Otherwise it sets `trashed → purging` and marks evidence-locked members `excluded_evidence_lock` (`evidence_lock_partial`) |
| `content` | Module hooks delete typed rows and hosted children bottom-up by depth, then association rows |
| `effects` | Object deletions are **recorded** as `exec.external_effect` (`object:<key>`, `naturally_idempotent`) for the owning module's effect worker. Nothing is deleted inline. Keys must be effect-key safe |
| `projections` | Module projection hooks, then the activity projection for the members |
| `redact` | `audit.redact_purged_values` under `app.redaction_operation_id` |
| `ledger_entry` | Builds the entry (IDs, types, times) and checkpoints it |
| ledger effect | `ledger.append(entry)` through the effect ledger (never repeated once sent). **Not complete until acknowledged**; failures retry |
| `tombstone` | Envelopes become content-free tombstones. Members are marked `purged`. Each gets a `record.purged` audit event and a `core.record.purged` outbox event. The batch moves to `purged` with `ledger_entry_id`, `ledger_acknowledged_at`, and `purged` or `purged_with_exclusions`. The database forbids `purged` without a ledger acknowledgement |

**Hook registry.** Owning modules register a `RecordTypeAdapter` per record type:
`children`, `containerOf`, `evidenceLocked`, and `purge` (`deleteContent`, plus optional
`removeAssociations`, `objectKeys`, `removeProjections`). The production registry is **empty in
1F**, so any purge blocks with `missing_purge_hook` until the owning phase registers its hooks.
Nothing pretends later modules were purged.

Evidence-locked members stay `trashed` in their terminal batch until the lock is released. Their
later purge is owned by the phase that introduces evidence locks (TEST-024/025).

## Retention (no durations)

- Values are per retention class:
  - `governance.retention_policy` per workspace (most specific row in force wins, even if NULL);
  - otherwise the platform default from `RETENTION_PERIODS` (JSON `{"R-LIVE": ms}`).
- Nothing is defaulted: NULL means undecided, and the dependent job does nothing.
- **R-LIVE** is the trash recovery period (`TRASH_RECOVERY_PERIOD`, OD-34).
  `lifecycle.purge_scheduler` (every 15 min) asks the dispatcher's payload-free
  `exec_dispatch.discover_purge_due`. With no decided period it selects nothing (tested with the
  default unset, with an explicit NULL workspace value, and with a set value).
- **R-AUDIT** is the audit retention period (OD-36), which is also the tombstone horizon.
  `lifecycle.tombstone_sweep` is a disabled retention hook. While the period is unset it reports
  `disabled`. If a value is configured it still deletes nothing and reports `not_enabled`: the
  sweep's batch-history rules belong to the phase that sets the period.
- `retention.configure` (owner, step-up, non-delegable) has no write path in 1F.

### Trash, purge, tombstone expiry, and backup expiry are different things

| Level | Content | Reversible | Ends |
|---|---|---|---|
| Trash | Kept in full | Yes (restore) | When the R-LIVE period passes (if decided) or by manual permanent deletion |
| Purge | Deleted from primary storage, projections, and object storage (via effects); audit values redacted | No | — |
| Tombstone | ID, type, scope, creation and deletion facts only | No | After R-AUDIT (sweep disabled until decided) |
| Backups | Purged content may remain in backups | — | Backup expiry (OD-42), which needs legal review. Purge ledger replay prevents restored backups from resurrecting purged data |

Customer-facing retention text, legal review of backup residuals (SEC-020, SEC-028), and every
duration are product-owner decisions; none is published.

## Purge ledger and post-restore replay

- `PurgeLedger` is provider-neutral. `LocalFilePurgeLedger` is a development adapter: an
  append-only JSONL file with fsync, idempotent by `entryId`. `PURGE_LEDGER=local` is refused in
  deployed modes, and `none` makes purge block before deleting anything. Entries hold IDs, types,
  and times only, never content.
- **Restore runbook contract** (automation is Phase 11C):
  1. As `restore_operator`: `markRestored(backupPoint)`. `ops.recovery_gate` becomes
     `replay_required`, so API readiness fails (`recovery_gate: fail`) and the worker refuses to
     start.
  2. `replayPurgeLedger(backupPoint)`, as the worker identity, one workspace transaction per
     entry. It rebuilds a missing batch from the ledger facts, runs the purge hooks, redaction, and
     tombstones, and records the original ledger entry. It is idempotent: purged batches are
     skipped, and entries at or before the backup point are not replayed.
  3. `reopen()` opens the gate only when no entry remains unapplied.

## Metrics (bounded labels only)

| Metric | Labels |
|---|---|
| `lifecycle.transitions` | `transition`, `outcome` |
| `purge.backlog` (gauge) | `state` |
| `purge.blocked` | `reason` |
| `purge.hook.duration` | `hook`, `outcome` |
| `purge.hook.failures` | `hook` |
| `purge.ledger.acknowledgements` | `outcome` |
| `audit.redactions` | `reason` |
| `retention.scheduler.runs` | `policy`, `outcome` |

No metric label carries a tenant, actor, record, target, or content value.

## Reusable UI (no tenant routes yet)

`apps/web/src/ui/lifecycle.tsx` provides:

- `ChangeList` (per-class rendering and redaction markers);
- `RedactedValue`;
- `DeletedItem` (one generic representation);
- `PermissionUnavailable`;
- `TrashMetadata` (no date while the period is undecided);
- `RestoreConflict` (typed failures with next steps);
- `PurgeConfirmDialog` (states irreversibility, discloses backup residuals, requires typing
  "DELETE", focuses Cancel).

`/_harness/lifecycle` renders every state, including loading, empty, error/retry, offline, and
pagination. It appears only when the server reports `COMPONENT_HARNESS`, which is local/test only
and refused when deployed. It is covered by component tests and by Playwright with axe on desktop
and mobile, keyboard-only use, reduced motion, forced colors, and 200% zoom (reflow at half
width).
