# Phase 4C — Documents and Knowledge

Status: **Authoritative implementation brief; parallel with 4E.**

Implement the 4C-owned document and knowledge requirements: rich documents, nested pages, templates/types, record linking and mentions, embedded content, ownership/review state, lifecycle states, comments/suggestions integration, version history, restoration, and export. Follow `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`: branch from the accepted Phase 4B head, own all fixes, and hand back only after a clean current-head no-skip CI run passes every gate.

- Use canonical tenancy, authorization, query/views, collaboration, audit, event, notification, and lifecycle services. Document links and mentions must re-check access at read/render time and never leak inaccessible titles, IDs, embeds, comments, or history.
- Provide deterministic document versions and restoration with immutable revision/audit facts, draft/current/stale/archive states, owner/reviewer permissions, review dates, and optimistic concurrency. No silent overwrite or fabricated current state.
- Support nested pages and typed templates without creating the 10B template catalog. Link tasks/projects/brands/documents only through registered record references; prevent cycles, unauthorized backlinks, and orphaned visible references.
- Integrate 4A comments, mentions and suggestions safely. Notification delivery remains 4B-owned. Keep collaborative live editing/presence 4D-owned.
- Export is bounded, authorized, audited, and honest about unsupported embedded content. File upload/storage/previews remain 4E-owned.
- Resolve document decisions before coding; update authoritative sources, ADRs, generated contracts, closure, validators, and exact migration rollback/reapply evidence. Avoid reusing migration `0037`.
- Test unit, integration, authorization/isolation, concurrency/versioning, API/component, and responsive browser/accessibility flows at 320px/200% zoom, forced colours, reduced motion, keyboard-only, offline/recovery, guest/share-only, revocation, and restoration states.

