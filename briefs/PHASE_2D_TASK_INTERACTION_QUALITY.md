# Developer Brief — Phase 2D: Task Interaction Quality

## Objective and authority

Make task work fast, reliable, recoverable, and understandable across desktop, tablet, and mobile: inline edits, bulk actions, pointer and keyboard ordering, undo, freshness/source signals, duplicate and missing-data detection, reminders, snoozing/rescheduling, recurring tasks, task templates, and predictable concurrency.

Build on accepted Phase 2C head `3a0102a`. Reuse the canonical task/project/workflow/field/relationship/permission/audit/lifecycle systems, shell/view-state primitives, outbox/jobs, and timing-safe visibility rules. Do not create parallel task mutation, status, scheduling, reminder, template, history, or authorization systems.

The [Authoritative Delivery Protocol](AUTHORITATIVE_DELIVERY_PROTOCOL.md) applies in full. This brief authorizes source reconciliation, implementation, branch/commits/draft PR, full CI, in-scope fixes, and repeated full-pipeline runs until one clean current-head no-skip run passes. No intermediate approval is needed.

Base: `phase-2c-workflows-fields` at `3a0102a`. Branch: `phase-2d-task-interaction-quality`. Draft PR base: `phase-2c-workflows-fields`.

Do not edit `BUILD_ROADMAP.md`, self-accept the ADR/checklist, begin 2E/3A, merge, or commit checklist/brief/local/report/build-output files.

## Scope

Complete: TSK-027, TSK-028, TSK-032, TSK-033, TSK-035–038, TSK-040–044, REL-001, REL-003.

Contribute only: PRJ-013 through the accepted project recurrence engine; CAL-005 for future task occurrences only; TSK-042 deterministic duplicate suggestions (AI similarity remains 7C); TSK-044 current stale/blocked/rescheduled signals (rollups remain 5C); TSK-032 durable reminder facts/outbox (channels/digests remain 4B); TSK-028 task templates (catalog/onboarding remains 10B). Followers/comments, files/documents, external connectors, agents, inbox, saved views and advanced views remain with their owning phases.

## Binding decisions

Record these as ADR-0016 and at authoritative sources before code. They are final implementation decisions.

1. **Recurring tasks:** use planning’s immutable snapshot/occurrence model and accepted project RRULE subset: daily, weekly, monthly, yearly, interval, weekday/month-day, anchor IANA zone and end condition. Copy fields, criteria, reset checklists, labels and safe links; never copy assignees, shares, history, comments, relationships, approvals, private context or unauthorized field values. Recheck create/brand/project authority per occurrence, pause on owner loss, and use the registered catch-up bound. 2D owns task-series UI/worker integration; 2A project recurrence semantics remain unchanged.
2. **Templates:** immutable versioned task templates use the 2A/2C serializer. Copy only safe fields, criteria, checklist text, labels and links. Never copy identity, assignees, shares, history, comments, relationships, approvals, live field values or recurrence. Applying requires explicit brand/project and reports omissions. 10B owns catalog management.
3. **Reminders:** personal idempotent `planning.task_reminder` keyed by account/task/due instant, states scheduled|fired|dismissed|cancelled. It never changes dates/status or grants access. Delivery is content-safe outbox; 4B owns channels/digests. Fired reminders are deduplicated.
4. **Snooze/reschedule:** snooze is personal and hides a task from that actor’s reminder/Today surfaces until an instant; it does not edit dates. Reschedule edits due date/deadline only through existing commands with explicit choice and audit. Deadline never changes implicitly. Reschedule counts exclude snooze and view-state changes.
5. **Freshness (OD-17):** meaningful update means title/description, status, assignee, start/due/deadline, estimate, criteria/checklist, label, relationship, field, link, lifecycle or manual update. It excludes reads, view state, favorites, recents, reminders and snooze. Active/blocked stale threshold is 7 calendar days; planned is 14 days; paused/cancelled/done are not stale. Repeatedly rescheduled means 3 material due/deadline edits in 14 days. Thresholds are registered bounded parameters.
6. **Signals:** blocked means paused status or authorized active incoming `blocks`; missing owner means no eligible assignee; missing date means no required due/deadline; missing criteria means unmet required criteria; missing dependency means an active incoming blocker. Signals are independent and permission filtered.
7. **Duplicates:** deterministic suggestions compare normalized title, same workspace/brand, compatible project, nonterminal lifecycle and bounded recent window. Suggestions are advisory, never automatic merges/mutations, and show only readable candidates. AI similarity is 7C.
8. **Bulk:** bulk edit/move/assign/label/schedule/delete takes a bounded explicit public-ID set. Resolve and preview all first. Safe reversible operations may report per-item outcomes; destructive operations are all-or-nothing unless the user explicitly selects partial mode and receives a complete authorized report. No silent partial mutation.
9. **Ordering:** drag is a pointer convenience over canonical rank commands. Move up/down/top/bottom and Move to… buttons/menu, keyboard controls and live announcements are always available. Compact never depends on drag.
10. **Inline edits:** use field merge/base hash and workflow evaluation. Stale input is preserved with Keep mine, Use latest or Cancel; never silently overwrite. Rich descriptions use canonical rich storage.
11. **Undo:** available for reversible local mutations for 30 seconds or until conflict. It issues an audited inverse command with a new idempotency key/version check; never deletes history, reverses external effects, restores access, or undoes sent reminders.
12. **Source:** closed source kinds are manual, recurring, intake, import, integration and ai_draft, with safe metadata/reference. Source is immutable except registered migration; no secrets/arbitrary user content. Later adapters are 2E/6A/7C.
13. **Reliability/privacy:** every mutation has saving/saved/conflict/offline/failed state; optimistic UI reconciles or visibly reverts; abort stale requests. Signals derive only from authorized facts, and counts/badges/explanations/timing cannot reveal hidden data.

## Data and migrations

Use exactly two migrations after 0026:

- `0027_task_interaction`: reminder/snooze/source/freshness/reschedule, duplicate support, template/recurrence extensions and indexes;
- `0028_task_bulk_undo`: bounded bulk-operation and undo/inverse-command facts plus rank support.

Both require paired down migrations and exact 0026 boundary-catalog tests. Do not introduce 3C work-block or 4B notification-channel tables. Register all bounds, events, actions, errors, jobs, prefixes, metrics and envelopes; no magic numbers.

## Authorization, API and UI

Reuse the 2B/2C task predicate, workflow evaluator, field policy, lifecycle, role caps, epochs and exact task-share boundary. Responsibility, source, reminder ownership and snooze ownership never grant access. Use public IDs, cursors, ETags, safe errors, confirmation fingerprints and per-item authorized outcomes. Audit bulk/item outcomes and interaction changes using existing hashes/redaction; never log hidden titles, IDs, reminder content, formulas or arbitrary text.

Integrate into project Tasks, task pages, projectless tasks and the shell. Provide keyboard/pointer ordering, inline edit, bulk actions, Undo toast, freshness/source badges, missing-data panel, duplicate suggestions, reminder/snooze controls and recurrence/template dialogs. Every action has non-drag and non-color alternatives. Cover loading, empty, validation, conflict, offline, archive/trash/read-only, not-found/forbidden and permission-loss states.

## Tests and final handoff

Use three workspaces/brands, all roles, guests/shares, project and projectless tasks, subtasks, dependencies, hidden fields, custom workflows, conflicts, offline transitions and concurrent actors. Prove isolation, permission parity, no signal leaks, recurrence idempotency/DST, template omission, reminder dedupe, freshness thresholds, duplicate privacy, bulk atomic/partial reporting, drag/keyboard equivalence, inline conflicts, undo expiry/conflict, source provenance and save-state recovery.

Run unit/component, real-PostgreSQL RLS/grant/concurrency/query-plan/migration, API/worker, and desktop/tablet/mobile Playwright+axe tests at 320 px, breakpoint edges, zoom, forced colors, reduced motion and keyboard-only use. Extend Phase 2 closure for every owned/contributed requirement and ADR decision.

Follow the authoritative protocol and hand back only after a clean current-head no-skip CI run passes validators, tests, scanners, licence checks, production image/readiness/web smoke, PostgreSQL digest and non-root proof. Keep the PR draft and unmerged.
