# Phase 3D — Time Tracking and Timesheets

Status: **Authoritative implementation brief; parallel with 3A.**

Implement TIME-003–006 and TIME-011–014, plus every catalog contribution assigned to 3D. Follow `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`: work on a separate branch from the accepted Phase 2 integration head, own all fixes, and hand back only after a clean current-head no-skip CI run passes every gate.

3A has now introduced migration `0031_saved_views` and ADR-0018. Rebase/integrate against the accepted 3A head before the final handoff. Do not reuse migration number 0031 or ADR-0018; choose the next available identifiers, regenerate contracts, and rerun every migration-boundary and validator check. The final CI head must include both branches without loss of either phase's behavior.

- Support planned effort on tasks/projects, actual manual time entries, start/pause/resume/stop timers, billable/non-billable state, remaining effort, planned-versus-actual views, timesheet submission/approval, period locking, and export.
- Define authoritative time semantics: timezone/UTC storage, DST-safe duration calculation, no negative or overlapping entries unless explicitly supported, timer recovery across refresh/offline, idempotent stop/resume, immutable audit history, and deterministic rounding. Resolve OD-26 before implementation or record a safe, explicit deferral; never invent silent locking rules.
- Enforce tenant, brand, project, task, member, guest/share, and approver permissions at read and mutation. Approved/locked entries cannot be edited or deleted; corrections use an auditable adjustment path. Totals and exports exclude inaccessible records.
- Reuse canonical policy, audit, event, idempotency, query, export, and worker contracts. Add exact migration rollback/reapply tests, bounded timer/export limits, concurrency tests, and worker/recovery tests. Do not implement 3C work blocks, 3E capacity, 5C rollups, or 6D adapters.
- Add API/unit/integration/component and responsive Playwright/axe coverage for timers, conflicts, approvals, locks, exports, timezone/DST, keyboard-only, 320px, zoom, forced colours, reduced motion, and permission revocation. Update authoritative sources, ADRs, generated contracts, closure, and validators.
- Do not modify roadmap/checklist/brief files in product commits. Handoff must include complete gate evidence, scanners, PostgreSQL digest, production image ID/size, and non-root runtime evidence.
