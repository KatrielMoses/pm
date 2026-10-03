# Engineering documentation (Phases 1A, 1B, 1F)

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
| [audit.md](audit.md) | Audit and security events (1F): classified changes, append-only enforcement, hash chain, security-event sink, 1B buffer handoff, account security activity |
| [lifecycle.md](lifecycle.md) | Records, archive/trash/restore/purge, tombstones, retention, purge ledger, recovery gate (1F) |
| [identity.md](identity.md) | Identity and sessions (1B): classification, passwords, sessions, CSRF, step-up, OAuth boundary, revocation, compromise runbook |
| [adr/](adr/) | Implementation ADRs 0001–0009 |
