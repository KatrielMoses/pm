# Phase 3C — Today and Manual Planning

Status: **Authoritative implementation brief; parallel with 3B.**

Implement the 3C-owned planning and calendar requirements in the catalog: Today, overdue/upcoming separation, manual commitments and ordering, work blocks distinct from deadlines, locked focus blocks, buffers, shutdown flow, unfinished-work rescheduling, and planned-versus-completed daily records. Follow `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`: branch from the accepted Phase 3D head, own all fixes, and hand back only after a clean current-head no-skip CI run passes every gate.

- Use 3A queries and 3D estimates/time semantics; do not duplicate task, time, authorization, or view evaluators. Calendar/external-event adapters remain 6C-owned.
- Keep deadlines, scheduled work, Today commitments, and work blocks as distinct concepts. Moving a commitment must not change a deadline unless the user explicitly selects that action. Preserve locked items and audit every reschedule.
- Support deterministic ordering, preparation/buffer time, focus-block protection, daily planning/shutdown, unfinished-work rescheduling, and planned-versus-completed records with timezone/DST-safe semantics.
- Capacity-aware warnings and working hours remain 3E-owned; AI rescheduling remains 7F-owned. Record all deferrals honestly and do not add their tables or adapters.
- Add unit, integration, authorization/isolation, concurrency, timezone/DST, API/component, and responsive browser/accessibility coverage including keyboard-only, 320px/200% zoom, forced colours, reduced motion, offline/recovery, and permission revocation.
- Resolve OD-18 and any remaining planning decisions before implementation. Update authoritative sources, ADRs, generated contracts, closure, validators, and exact migration rollback/reapply tests. Do not reuse migrations `0031` or `0032`.
- Do not modify roadmap/checklist/brief files in product commits. Handoff must include complete gate, scanner, PostgreSQL, image, and non-root evidence.

