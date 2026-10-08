# Phase 3E — Capacity and Cross-Brand Conflicts

Status: **Authoritative implementation brief.**

Implement the 3E-owned catalog requirements for working hours, brand capacity reservations, founder capacity, workload/capacity, time off, cross-brand conflict warnings, and capacity-aware planning inputs. Follow `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`: first integrate the accepted 3B and 3C branches, reconcile their parallel migration/ADR collisions, then implement and hand back only after a clean current-head no-skip CI run passes every gate.

## Integration prerequisite

3B and 3C each used migration `0033` and ADR-0020 on separate branches. Merge both accepted branches, preserve both feature sets, assign the next available migration and ADR identifiers deterministically, regenerate all contracts/validators, and prove every migration boundary. Do not overwrite either branch or silently drop records.

## Scope and rules

- Define per-person working hours, weekly capacity, time off/unavailable periods, and per-brand reservations with explicit timezone/DST semantics.
- Show founder capacity across brands, over/under-allocation, workload by day/week/month, and cross-brand conflicts using only records the viewer may see. Hidden brands/tasks must not affect counts, timing, warnings, or exports.
- Warn when Today/plans exceed available capacity; provide inputs for capacity-aware rescheduling, but do not implement AI rescheduling (7F), external calendar adapters (6C), rollups (5C), or notification delivery (4B).
- Reuse canonical 3A queries, 3B layouts, 3C planning, and 3D time/estimate services. Do not create duplicate evaluators or authorization paths.
- Resolve OD-19 and any remaining capacity decisions before coding. Record safe defaults, permissions, audit/events, configurable bounds, and explicit deferrals in authoritative 0B/0C/0D/0E records, ADRs, generated contracts, closure, and validators.
- Add unit, integration, authorization/isolation, concurrency, timezone/DST, API/component, and responsive browser/accessibility coverage, including permission loss, cross-brand privacy, 320px/200% zoom, forced colours, reduced motion, and keyboard-only use.
- Add exact migration rollback/reapply evidence, scanners, production-image smoke, and non-root runtime evidence. Do not modify `BUILD_ROADMAP.md`, `ROADMAP_CHECKLIST.md`, `briefs/`, reports, secrets, or build output in product commits.

