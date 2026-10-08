# Phase 2E — Inbox and Universal Capture

Status: **Authoritative implementation brief.**

Issuing this brief authorizes implementation under `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`. Work may begin immediately on a new branch from the accepted Phase 2D head. The developer owns implementation, tests, CI diagnosis, and all in-scope fixes. Do not hand back until one clean, current-head, no-skip CI run passes every required gate; no intermediate approval is needed.

## Scope

Implement the complete Phase 2E roadmap slice and owned catalog requirements CAP-001 through CAP-004, CAP-006, CAP-007, CAP-009 through CAP-016, plus the 2E contribution to PRJ-017 and any listed contributions in the requirement catalog. CAP-005 (voice transcription) remains owned by 7F; CAP-008 (API/webhook capture) remains owned by 6B. Do not implement those later-phase owners prematurely.

The exit experience must support first use without configuration assistance: a user can create a brand, create a useful project, capture tasks, and use a daily Inbox. Every mutation is authorized, tenant-safe, auditable, and usable on desktop, tablet, and mobile.

## Binding behavior

- Capture a task or note from every authenticated shell surface through one canonical command/API path. Preserve original captured text, source, actor, workspace/brand context, timestamps, and correlation/audit identifiers.
- Incomplete or ambiguous captures are valid Inbox items and must not require a project, brand, status, owner, or other configuration before saving. Apply the existing personal/unbranded Inbox rule until triage.
- Pasted multi-line text creates a preview of multiple candidate items before save. The user can edit, remove, or split candidates; partial failures are explicit and never silently dropped.
- Provide deterministic, versioned parsing for dates, due dates, priority, duration, recurrence, labels, brand, project, and owner. Parsing must be explainable and safe; ambiguous values require confirmation. This is not AI and must not claim AI capabilities.
- Triage can assign a brand/project and convert an Inbox item into a task, note, project, or discarded item. Enforce current permissions at preview and apply; preserve source lineage and audit the decision.
- Merge Inbox duplicates through a preview that identifies the retained record and preserved source/history. Never destroy source text or audit history; use the established reversible/deletion primitives where applicable.
- Convert notes into tasks or projects with explicit confirmation and deterministic field mapping. Preserve the originating note and provenance.
- Attach links and files through the existing attachment boundary; do not implement the 4E storage/provider phase. Unavailable storage must fail clearly without losing the capture.
- Intake-form capture must use registered provenance, abuse/rate controls, tenant and permission boundaries, and the pending OD-28 decision. If OD-28 is unresolved, record the blocker and implement only the already-authorized contract surface; do not invent anonymous-access rules.
- Email forwarding remains 6A-owned; voice capture remains 7F-owned. Preserve adapter-ready source kinds without creating those adapters.

## Required architecture and quality

- Add migrations only for 2E-owned tables/indexes/constraints; prove exact rollback to the prior boundary. Do not add 3A–3E, 4B–4E, 6A/6B, or 7F implementation tables.
- Reuse canonical task, note, project, tenancy, authorization, audit, event, attachment, and idempotency services. No parallel authorization or source-of-truth model.
- Add bounded limits for capture size, pasted lines, attachment references, parser work, triage batch size, merge size, and rate/abuse controls. Make them configurable through the existing contract system.
- Ensure constant-shape/permission-safe responses where hidden brands, projects, records, or source metadata could otherwise leak through counts, parsing, previews, timings, or errors.
- Add unit, integration, authorization/isolation, concurrency/idempotency, API, component, and responsive browser/accessibility coverage. Include keyboard-only, 320px, breakpoints, 200% zoom, forced colours, reduced motion, and offline/error recovery where capture state is at risk.
- Update 0B/0C/0D/0E source records first, ADRs/OD decisions as needed, generated contracts, closure data, and validators. Record every intentional deferral and preserve the requirement catalog's ownership.

## Delivery

- Run the full verification pipeline from a clean checkout, including containerized PostgreSQL, scanners, production-image smoke, and non-root evidence.
- Fix ordinary code, test, migration, documentation, accessibility, scanner, and CI failures yourself. Do not add skips, blind retries, weakened assertions, or inflated timeouts.
- Hand back the branch, commits, draft PR, changed-file summary, decisions/deferrals, complete gate counts, scanner results, PostgreSQL image digest, production image ID/size, and runtime non-root check only after the clean no-skip run passes.
- Do not modify `BUILD_ROADMAP.md`, `ROADMAP_CHECKLIST.md`, `briefs/`, local reports, secrets, or build output in the product commits.

