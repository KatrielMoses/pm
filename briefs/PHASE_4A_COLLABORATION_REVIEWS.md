# Phase 4A — Comments, Mentions, Following, and Reviews

Status: **Authoritative implementation brief.**

Implement the 4A-owned collaboration requirements: comments on supported records, threaded replies, mentions, reactions, following/unfollowing, permission-safe activity, review requests/approvals, delegation, and reassignment history. Follow `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`: branch from the accepted Phase 3 integration head, own all fixes, and hand back only after one clean current-head no-skip CI run passes every gate.

## Binding decisions

- Resolve and record OD-10 (watchers/followers) before coding: following is an explicit per-record subscription, never inherited from workspace/project membership or a received share; unfollow is immediate and idempotent.
- Resolve and record OD-38 before coding: authors may edit/delete only within the approved audit window; deletion is a tombstone retaining audit facts, and edits preserve an append-only revision trail. Administrators cannot silently rewrite another person's comment.
- Mentions resolve only to people/teams/agents the actor may name in that record scope. Hidden or unknown targets return the same safe result. Mention notifications are 4B-owned; 4A emits canonical events without delivery channels.
- Activity is permission-filtered at read time. Comments, reactions, reviews, delegation and reassignment never disclose inaccessible records, people, fields, or prior values.
- Review requests and approvals use explicit authority, current versions, typed outcomes, audit/events, and idempotency. Reassignment/delegation preserves ownership history and cannot bypass tenancy or role policy.

## Quality and boundaries

- Reuse canonical policy, record grants, audit, event, query/view, ID, and lifecycle services. Add exact migration rollback/reapply evidence and avoid reusing the current migration identifiers.
- Do not implement notification delivery/preferences (4B), documents (4C), collaborative editing/presence (4D), files (4E), or agent review automation (8D); expose only the contracts those phases own.
- Add unit, integration, authorization/isolation, concurrency/idempotency, API/component, and responsive browser/accessibility tests for owner/member/guest/share-only/revoked users, 320px/200% zoom, forced colours, reduced motion, keyboard-only, stale versions, and offline/recovery states.
- Update authoritative 0B/0C/0D/0E records, ADRs, generated contracts, closure, and validators. Run the complete CI pipeline with containerized PostgreSQL, scanners, production-image smoke, and non-root evidence. Do not modify roadmap/checklist/brief files in product commits.

