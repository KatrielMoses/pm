# Phase 3 Integration Review and Exit Gate

Status: **Authoritative integration-review brief.**

Integrate accepted 3A, 3B, 3C, 3D, and 3E and prove they operate as one secure planning system. Follow `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`: fix all in-scope defects, then hand back only after one clean current-head no-skip CI run passes every gate.

- Verify migrations and generated records from `0031` through `0035`, including exact down/up boundary equivalence after the 3B/3C reconciliation. Preserve every accepted feature and decision record.
- Run end-to-end journeys across saved views, all core layouts, Today commitments/blocks, timers/time entries/timesheets, capacity, reservations, holidays, time off, and cross-brand conflicts.
- Re-run cross-role, cross-workspace/brand isolation for owner, member, manager, guest, share-only, suspended, and removed users. Hidden records, people, brands, time, capacity, groups, totals, exports, and activity must remain permission-safe.
- Test concurrency and recovery across view edits, board transitions, Today planning, timers, approvals/locks, reservations, revocation, offline recovery, worker jobs, idempotency, If-Match conflicts, audit/events, and personal-data erasure.
- Validate responsive/accessibility journeys on desktop, tablet, mobile, 320px, 200% zoom, forced colours, reduced motion, and keyboard-only operation. Confirm embedded PostgreSQL now propagates failures locally.
- Run all Phase 0–3E validators and aggregate closure. Keep 3C capacity inputs, 3E rescheduling proposals, 5C rollups, 6C calendars, 7F AI, and 4B delivery explicitly deferred.
- Do not implement Phase 4 features. Fix only integration defects, contract/validator drift, migration compatibility, security/privacy, accessibility, and UX inconsistencies required for Phase 3 acceptance.
- Run the complete CI pipeline with containerized PostgreSQL, scanners, production-image smoke, and non-root evidence. Do not modify roadmap/checklist/brief files in product commits.

