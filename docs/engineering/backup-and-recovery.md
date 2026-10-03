# Backup and recovery policy foundation

Status: policy foundation for 1A. **No backups exist yet**: there is no hosting provider and no
deployed database. A local database volume (`.local/pg`, the Compose `pgdata` volume) is not a
backup. This document sets no RPO, RTO, retention period, or availability target; those come from
11C measurements and product-owner decisions (OD-42, OD-43, PQ-13).

## Requirements for the managed PostgreSQL service

1. **Point-in-time recovery (PITR)** on the primary: continuous WAL archiving with restore to any
   point inside the provider's retention window. Retention length is unset (OD-42).
2. Backups encrypted at rest by the provider, in the same region as the primary (single region, OD-43).
3. Backup and restore operations must be possible without the application's identities: the
   provider's administrative access plus our `restore_operator` (break-glass, two-person
   activation, audited; credentials in the secret store once DQ-28 is decided).
4. Restored databases must preserve roles, grants, RLS policies, and `FORCE ROW LEVEL SECURITY`.
   After a restore, database-level privileges are re-asserted with the bootstrap
   (`grantDatabaseAccess` / `bootstrap`), because they belong to the database object, not its contents.
5. Periodic logical exports per workspace for portability tests (0B §10.11) — later phases.

## Object storage (when files arrive, 4E)

Versioning enabled on the bucket; object-lock / retention policies that cover the backup window;
lifecycle rules for quarantine and clean areas; server-side encryption. Values unset.

## Purge ledger (0B §8.11)

- An append-only, write-once log of purged IDs and scopes (no content), stored **outside the
  database backup set** (separate object-storage bucket with object lock).
- Every completed purge and account/workspace deletion appends to it (1F/9x implement purge).
- Restoring an older backup would resurrect data purged after the backup point. Therefore the
  restore runbook **must** replay ledger entries newer than the backup point, under
  `restore_operator`, **before** the restored environment reopens to traffic.
- Outbox reconciliation after restore: events after the backup point are regenerated or ignored by
  consumer inbox dedupe (0B §10.11).

## Restore runbook skeleton (owned by 11C)

1. Freeze traffic (scale web/worker to zero; readiness fails).
2. Restore PITR to the chosen point into a **new** database in the same namespace.
3. Re-assert roles and database grants (`bootstrap`); run `migrate verify` (checksums and chain).
4. Replay the purge ledger beyond the restore point (`restore_operator`).
5. Run the authorization smoke (RLS catalog checks and cross-workspace denial tests).
6. Reopen: start workers, then web; confirm `/readyz`.

## What can be tested now vs. later

| Testable locally now (automated) | Needs the hosting provider |
|---|---|
| Migrations reproduce the full schema from empty; down/up reversibility | PITR configuration and retention |
| RLS policies, `FORCE`, roles and grants survive a template clone (restore analogue) and are re-asserted by bootstrap | Real restore drills and timings (11C, SEC-018) |
| `migrate verify` detects tampering after restore | Backup encryption, regional placement |
| Authorization tests run against a freshly provisioned database | Purge-ledger bucket with object lock |

Restore-drill automation (scheduled restore into staging, ledger replay, authorization tests,
measured RTO) is owned by **Phase 11C**.
