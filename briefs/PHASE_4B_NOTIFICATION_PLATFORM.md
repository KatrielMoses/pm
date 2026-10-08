# Phase 4B — Notification Platform

Status: **Authoritative implementation brief.**

Implement the 4B-owned notification requirements: durable in-app notifications, preferences, quiet hours, mute scopes, deduplication, grouping, searchable history, digests, email/browser delivery, and delivery-failure handling. Follow `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`: branch from the accepted Phase 4A head, own all fixes, and hand back only after one clean current-head no-skip CI run passes every gate.

- Consume canonical 4A collaboration events and all existing event contracts through one durable outbox/notification pipeline. Never mark a notification delivered before durable provider acknowledgement; retries must be idempotent and auditable.
- Support per-account, brand, project, event, and channel preferences; quiet hours and mute scopes; digest scheduling; in-app read/unread/saved/dismissed state; grouping and deduplication. Defaults must be explicit and privacy-safe.
- Email and browser delivery are provider-neutral boundaries with failure classification, bounded retry/backoff, dead-letter/reconciliation visibility, and truthful readiness when providers are unconfigured. Do not claim delivery when only queued.
- Authorization is evaluated at event creation and again at delivery/read time. Revocation, deletion, sensitive brands, guests, hidden records, and departed members must not leak titles, actors, counts, or content through notifications, digests, previews, search, or failure messages.
- Add retention, rate, batch, payload, digest, and provider bounds through the existing contract/config system. Preserve audit/event facts without storing unnecessary sensitive content.
- Resolve any notification/open decisions before coding and update authoritative 0B/0C/0D/0E records, ADRs, generated contracts, closure, and validators. Add exact migration rollback/reapply evidence and avoid reusing migration `0036`.
- Test unit, integration, outbox/concurrency/idempotency, authorization/isolation, worker/recovery, API/component, and responsive browser/accessibility flows including offline, stale permissions, quiet hours, grouping, provider failure, keyboard-only, 320px/200% zoom, forced colours, and reduced motion.
- Do not implement documents/files (4C/4E), collaborative editing (4D), agent delivery (8B), or external connector adapters. Do not modify roadmap/checklist/brief files in product commits. Handoff must include full CI, scanners, PostgreSQL digest, production image, readiness, and non-root evidence.

