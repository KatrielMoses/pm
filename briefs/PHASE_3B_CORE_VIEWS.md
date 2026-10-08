# Phase 3B — Core Views

Status: **Authoritative implementation brief; parallel with 3C.**

Implement the 3B-owned catalog requirements for list, board, calendar, timeline, Gantt, table, workload, milestone, portfolio, activity, time-sheet, density, and detail-preserving views. Follow `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`: branch from the accepted Phase 3D head, own all fixes, and hand back only after a clean current-head no-skip CI run passes every gate.

- Use the canonical 3A query/view engine; do not create per-view filtering, sorting, grouping, or authorization rules.
- Implement accessible responsive desktop/tablet/mobile views with permission-safe data, preserved view state, deep links, keyboard operation, 320px/200% zoom, forced colours, reduced motion, and axe coverage.
- Respect 3C time semantics for scheduled work and 3D time data for the timesheet view, without implementing 3C planning or 3E capacity. Record honest deferrals for external calendars, rollups, and adapters.
- Board drag/status changes must use canonical workflow transitions, required-field/approval gates, optimistic concurrency, audit/events, and explicit per-item failures. Never bypass permissions or silently mutate deadlines.
- Resolve any outstanding view/open decisions before implementation, update 0B/0C/0D/0E sources, ADRs, generated contracts, closure, and validators. Add exact migration rollback/reapply evidence and avoid reusing migrations `0031` or `0032`.
- Include unit, integration, authorization/isolation, concurrency, API/component, and browser tests. Do not modify roadmap/checklist/brief files in product commits. Handoff must include complete gate, scanner, PostgreSQL, image, and non-root evidence.

