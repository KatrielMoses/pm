# Engineering documentation (Phase 1A)

Implementation notes for the accepted Phase 0 architecture. Where these notes and the accepted
documents in `docs/architecture/` differ, the accepted documents govern, and the difference is
recorded in [ADR-0007](adr/0007-deviations.md).

| Document | Covers |
|---|---|
| [environments.md](environments.md) | Configuration modes, environment-variable and network contract, secrets boundary, namespace isolation |
| [database.md](database.md) | Roles, RLS, tenant transactions, migrations (expand/contract, checksums), managed-provider bootstrap |
| [execution-engine.md](execution-engine.md) | Operations, attempts, jobs, outbox/inbox, idempotency, external effects, worker runtime |
| [observability.md](observability.md) | Logs, traces, metrics, redaction, health and readiness |
| [backup-and-recovery.md](backup-and-recovery.md) | Backup/restore policy foundation (no RPO/RTO promises) |
| [dependency-inventory.md](dependency-inventory.md) | Generated dependency and license inventory |
| [adr/](adr/) | Implementation ADRs 0001–0007 |
