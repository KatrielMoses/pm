# Phase 3A — Reusable Query and Saved-View Engine

Status: **Authoritative implementation brief; parallel with 3D.**

Implement the 3A-owned requirements VIEW-012–020 and VIEW-022, plus WSB-019 and all catalog contributions assigned to 3A. Follow `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`: create a separate branch from the accepted Phase 2 integration head, implement, test, fix failures, and hand back only after a clean current-head no-skip CI run passes every gate.

- Build one canonical query AST/evaluator for AND/OR filters, multi-sort, grouping, brand/project/status/priority/owner/assignee/agent/date/label/milestone/health/custom-field filters, pagination, and stable ordering. Enforce authorization before counts, groups, exports, or metadata; hidden records must not affect response shape or timing observably.
- Add personal, shared, and default views with explicit permissions, brand/project defaults, navigation pins, visible-field/column order, compact/comfortable density, exports, deep links, and preserved filters/sort/group/scroll state. Sharing is exact, revocable, and never widens record access.
- Reuse existing tenancy, policy, audit, event, ID, export, and view-state contracts. Add migrations with exact rollback/reapply evidence and bounded query/export limits; do not build 3B view implementations, 3C planning, 3D time tracking, or 6D adapter work.
- Test unit/property, SQL/query plans, authorization/isolation, concurrency/version conflicts, API/component, and Playwright/axe desktop/tablet/mobile including 320px, zoom, forced colours, reduced motion, and keyboard-only flows. Update authoritative 0B/0C/0D/0E records, ADRs, generated contracts, closure, and validators.
- Do not modify roadmap/checklist/brief files in product commits. Handoff must include complete gate evidence, scanners, PostgreSQL digest, production image ID/size, and non-root runtime evidence.

