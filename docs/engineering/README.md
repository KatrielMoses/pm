# Engineering documentation (Phases 1A, 1B, 1F, 1C, 1D, 1E, 2A)

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
| [tenancy.md](tenancy.md) | Workspaces, memberships, brands, settings, context selection, policy compiler, tenant isolation (1C); people, invitations, teams, grants, shares, previews, departure, ownership transfer (1D); application shell, scope URLs, favorites, recents, view state, preferences (1E); projects, hierarchy, project authority, sharing, structures, templates, recurrence (2A) |
| [phase1/](phase1/exit-report.md) | Phase 1 integration review: exit report, requirement closure map (`closure.json`, checked by `tools/phase1.py`), branch topology and merge order, manual smoke checklist |
| [phase2/](phase2/closure.json) | Phase 2A requirement and decision closure (`closure.json`, checked by `tools/phase2.py`) |
| [phase3/](phase3/closure-3a.json) | Phase 3A requirement and decision closure (`closure-3a.json`, checked by `tools/phase3.py`) |
| [phase3/](phase3/closure-3b.json) | Phase 3B requirement and decision closure (`closure-3b.json`, checked by `tools/phase3b.py`) |
| [phase3/](phase3/closure-3d.json) | Phase 3D requirement and decision closure (`closure-3d.json`, checked by `tools/phase3d.py`) |
| [phase3/](phase3/closure-3c.json) | Phase 3C requirement and decision closure (`closure-3c.json`, checked by `tools/phase3c.py`) |
| [phase4/](phase4/closure-4a.json) | Phase 4A requirement and decision closure (`closure-4a.json`, checked by `tools/phase4a.py`) |
| [phase4/](phase4/closure-4b.json) | Phase 4B requirement and decision closure (`closure-4b.json`, checked by `tools/phase4b.py`) |
| [phase4/](phase4/closure-4e.json) | Phase 4E requirement and decision closure (`closure-4e.json`, checked by `tools/phase4e.py`) |
| [adr/](adr/) | Implementation ADRs 0001–0025 |
