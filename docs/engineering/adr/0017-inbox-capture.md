# ADR-0017: Inbox and universal capture (Phase 2E)

Status: **proposed** (implemented; awaiting one clean current-head no-skip CI run on the stacked draft PR). Engineering detail: [database.md](../database.md#phase-2e-capture), [tenancy.md](../tenancy.md#phase-2e-capture), [lifecycle.md](../lifecycle.md#phase-2e-capture-records), [observability.md](../observability.md#capture-2e).
Extends ADR-0016 (2D) and ADR-0013 (2A).

Accepted sources (the Phase 2E brief's decisions, recorded before code):
- 0A: OD-03 applied (personal, brand-optional Inbox items). OD-28 and OD-29 stay open, with blockers recorded.
- 0B: ADR-25. `capture.inbox_item`, `capture.note`, `capture.capture_conversion`, `capture.intake_form`, `capture.intake_submission`.
- 0C: AZ-25 (`intake.manage`, `intake.submit`; 120 actions in total). T-43, AT-138 to AT-145.
- 0D: PL-27 (six events, ten bounds, three signals, three envelopes).
- 0E: the Phase 2E implementation note in 02-information-architecture.

## Decisions

| # | Topic | Decision |
|---|---|---|
| E1 | One capture path | `POST /capture` (`CaptureService.capture`) serves every surface: the shell Capture button, the `c` shortcut, paste, and intake forms through the same insert. Each item keeps the immutable original text, source kind (`typed`, `paste`, `form`), safe source reference (an opaque paste batch or the form ID), actor, optional brand, timestamps, and correlation ID. An audit entry (content hash only) and a `capture.inbox.captured` event are written. |
| E2 | No configuration needed | Any non-empty text is a valid Inbox item: no brand, project, status, or owner is required. Items are personal (OD-03): only their owner sees or changes them, with no owner or administrator bypass. Brand context grants nothing. |
| E3 | Paste | A multi-line paste previews one candidate per line, with list markers removed. Each candidate can be edited, removed, or split before saving. Saving runs each candidate in its own savepoint and reports `saved` or `failed` with a code; failed candidates stay in the dialog. Bounded by `CAPTURE_PASTE_LINES_MAX`. |
| E4 | Deterministic parsing | Parser version 1 (`capture/parser.ts`) is rule-based and never called AI (`ai: false`). It detects dates (due or deadline), priority, duration, recurrence, labels, project, brand, and owner, each with its span, text, and rule. Ambiguous values (`3/4`, `next fri`) carry options and need a choice before they apply. Names resolve only among readable brands, projects, members, and labels. Unknown and hidden names both come back as `unresolved`, with the same statements and timing. Work is bounded by `CAPTURE_PARSE_TOKENS_MAX`. |
| E5 | Triage | Triage turns items into a task (origin `intake` with the item's public ID; parsed fields, readable labels, an owner, and a recurrence when the person may manage it; links copied), a note, or a project (PRJ-017; `work.project.intake_source_id`), or discards them. `record.create` at the destination is decided at preview and again at apply. Each item runs in a savepoint and is reported. Lineage goes to `capture.capture_conversion`, with an audit entry and a `capture.inbox.triaged` event. Bounded by `TRIAGE_BATCH_MAX`. |
| E6 | Merge | A preview names the item kept. The others become `merged` (`merged_into_id`) and keep their original text, source, and history; nothing is deleted, and merged or discarded items can be restored. Bounded by `INBOX_MERGE_MAX`. |
| E7 | Notes | A note capture creates the note at once and keeps the Inbox item as its converted source. Conversion to a task or project needs `confirm: true` and an explicit brand. Mapping: title to name; the first line of the body is parsed for dates, priority, and duration. The note remains, and the conversion is listed on it. |
| E8 | Attachments | Links (`https://` only, `CAPTURE_LINKS_MAX`) attach through `relations.record_link` and travel to the task. File references (`CAPTURE_FILES_MAX`) are refused per attachment with `storage_unavailable` (4E), and the capture is saved. |
| E9 | Intake forms | Brand-owned forms with a queue owner who can read the brand (`intake.manage` to configure). While OD-28 is open: signed-in members who can read the brand may submit (`intake.submit`); guests and non-readers get `not_found`. Rate-limited per person and form (`INTAKE_SUBMISSIONS_PER_HOUR`). A submission becomes the queue owner's Inbox item (source `form`) with an append-only receipt. The submitter gets an acknowledgement only. |
| E10 | Adapters | Email (6A, OD-29), voice (7F), and API or webhook capture (6B) keep their source kinds in the closed set; no address, transcription, or endpoint is built. |
| E11 | Bounds and abuse | Ten registered bounds are configurable. Captures are rate-limited per member (`CAPTURE_RATE_PER_MINUTE`), and refusals are `rate_limited`. Size refusals are pointer-addressed `validation_failed`. |
| E12 | Permission-safe responses | Others' items, notes, and unknown IDs are one `not_found` with the same statements and timing. Form lookups for unreadable brands match unknown forms. Responses carry public IDs only (paste batches are opaque references). |

## Recorded deviations and clarifications

- OD-28 is open, so anonymous submission, bot protection, and attachment scanning are not implemented (CAP-007 is members-only).
- OD-29 is open and email forwarding is 6A's: CAP-006 is a foundation (adapter-ready source kind) deferred to 6A.
- Ambiguous values are kept on the saved item and chosen at triage, so an ambiguous capture is never blocked.

## Consequences

Migrations `0029_capture_inbox` and `0030_intake_forms` reverse exactly to 0028. Lifecycle adapters cover inbox items, notes, and forms (brand purge and workspace deletion). The Inbox destination is live; notes and forms have routes.
