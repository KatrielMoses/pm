# Phase 4D — Collaborative Editing

Status: **Authoritative implementation brief.**

Integrate accepted 4C and 4E first, reconcile their parallel migration `0038` and ADR/source identifiers without losing either feature, then implement predictable conflict handling and live collaborative editing/presence for documents. Follow `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`: own all fixes and hand back only after one clean current-head no-skip CI run passes every gate.

- Preserve 4C's immutable document versions, block IDs, canonical hashes, restore semantics, restricted-tree opaque references, comments/reviews, and authorization. Collaborative updates must never bypass the document version or permission evaluator.
- Implement a proven synchronization model with explicit session/connection lifecycle, presence expiry, offline/reconnect recovery, ordered operations, conflict detection, deterministic convergence, and safe fallback to versioned non-live editing. Do not invent an unbounded bespoke CRDT/OT protocol.
- Presence must be permission-safe and ephemeral: never disclose hidden editors, records, or content; stale sessions expire; guests/share-only users see only permitted presence. Audit durable content changes, not every cursor heartbeat.
- Suggestions, comments, mentions, review decisions, notification events, file embeds, exports, and lifecycle/purge must remain compatible with 4A, 4B, 4C, and 4E authorities. Notification delivery remains 4B-owned; file storage remains 4E-owned.
- Resolve collaboration-engine/provider and conflict/open decisions before coding. Update authoritative 0B/0C/0D/0E records, ADRs, generated contracts, closure, validators, and exact migration rollback/reapply evidence. Do not reuse migration `0038`.
- Add unit, integration, multi-client concurrency, authorization/isolation, offline/recovery, API/component, and responsive browser/accessibility tests at 320px/200% zoom, forced colours, reduced motion, keyboard-only, revoked access, stale versions, reconnect, and purge states.
- Do not implement search (5A), external collaboration providers, or later agent editing. Do not modify roadmap/checklist/brief files in product commits. Handoff must include full CI, scanners, PostgreSQL digest, production image, readiness, and non-root evidence.

