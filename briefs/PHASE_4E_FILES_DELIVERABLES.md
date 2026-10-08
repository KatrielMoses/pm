# Phase 4E — Files and Deliverables

Status: **Authoritative implementation brief; parallel with 4C.**

Implement the 4E-owned file and deliverable requirements: signed uploads/downloads, previews, metadata, versions, external links, deliverable workflow, comparisons where supported, acceptance evidence, malware scanning, quotas, authorization, retention, and deletion. Follow `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`: branch from the accepted Phase 4B head, own all fixes, and hand back only after a clean current-head no-skip CI run passes every gate.

- Use provider-neutral object storage contracts with short-lived signed URLs, bounded residual access, checksum/size/type validation, resumable or retry-safe uploads, and truthful `object_storage: not_configured` behavior. Never claim a file is stored or scanned when the provider is unavailable.
- Enforce tenant, brand, project, record-share, guest, role, sensitive-data, retention, and deletion policy at every metadata, URL, preview, download, export, and deliverable action. Hidden files must be indistinguishable from unknown files.
- Support immutable file versions, external links, draft/ready-for-review/changes-requested/accepted/rejected deliverable states, acceptance evidence, audit/events, and bounded comparisons for supported formats. Integrate 4A comments/reviews without duplicating their authority.
- Malware scanning, quarantine, retry/dead-letter, and scan-failure handling must be explicit and fail closed for downloads. Quotas and retention are configurable and observable; legal retention decisions remain documented rather than invented.
- Do not implement collaborative editing (4D), document authoring (4C), external connectors (6A/6C), or notification delivery (4B). Resolve file/security decisions, update authoritative sources/ADRs/generated contracts/closure/validators, and add exact migration rollback/reapply evidence without reusing migration `0037`.
- Test unit, integration, authorization/isolation, concurrency/idempotency, provider failure/recovery, API/component, and responsive browser/accessibility flows including 320px/200% zoom, forced colours, reduced motion, keyboard-only, revoked access, expiry, deletion, quarantine, and non-root production-image smoke.

