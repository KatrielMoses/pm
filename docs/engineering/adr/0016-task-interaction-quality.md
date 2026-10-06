# ADR-0016: Task interaction quality (Phase 2D)

Status: **proposed** (implemented; awaiting one clean current-head no-skip CI run on the stacked draft PR). Engineering detail: [database.md](../database.md#phase-2d-task-interaction-quality), [tenancy.md](../tenancy.md#phase-2d-task-interaction), [lifecycle.md](../lifecycle.md#phase-2d-personal-and-short-lived-rows), [observability.md](../observability.md#task-interaction-2d).
Extends ADR-0015 (2C), ADR-0014 (2B), and ADR-0013 (2A).

Accepted sources (the Phase 2D brief's decisions, recorded before code):
- 0A: OD-17 decided for tasks. Time-and-scheduling gains Reschedule, Snooze, and Recurring tasks; lifecycle-and-states gains the task signal table.
- 0B: ADR-24. Task origin, freshness, and recurrence identity; `planning.task_reminder` replaces the planned `work.reminder`; `planning.task_snooze`; `work.bulk_operation`; `work.undo_entry`.
- 0C: AZ-24 (three actions, 118 in total); T-42, AT-130 to AT-137.
- 0D: PL-26 (prefixes `rem`, `bop`, `und`; five events; twelve bounds; one job; three signals).
- 0E: the Phase 2D implementation note in 02-information-architecture.

## Decisions

| # | Topic | Decision |
|---|---|---|
| T1 | Recurring tasks | Task series reuse `planning.recurrence_series` (`target_kind = task`, optional `project_id`) with the 2A RRULE subset, anchor zone, catch-up bound (`RECURRENCE_CATCHUP_MAX`), and idempotent `(recurrence_series_id, occurrence_key)` (unique index). The frozen snapshot is a task package (T2). Each occurrence is due on its local occurrence date, with origin `recurring`. The worker rechecks `record.create` on the brand or the project chain before each run, and a series whose owner lost authority pauses (audited). Assignees, shares, history, comments, relationships, approvals, and unauthorized field values are never copied; checklists are reset. |
| T2 | Templates | Task templates are `templates.template` rows with `target_record_type = task` and immutable version rows; a new version comes from a task. Applying one needs an explicit brand (and optional project) and `record.create` there. The response is a `template_application` that reports omissions by kind (`unavailable_labels`, `unavailable_fields`, `hidden_fields`, …), never by value. Project template paths ignore task templates. |
| T3 | Reminders | `planning.task_reminder` (`rem_`) is personal: unique per (workspace, owner, task, instant); states scheduled → fired / dismissed / cancelled (guard trigger). The `work.reminders` job discovers due workspaces through a payload-free dispatcher function. It fires at most `REMINDER_FIRE_BATCH_MAX` per run with `SKIP LOCKED`, and the one-way state change deduplicates firing. A reminder on a task its owner can no longer read is cancelled silently; one inside a snooze moves to the snooze end. Firing writes a content-free `planning.task_reminder.fired` outbox fact; channels are 4B. |
| T4 | Snooze and reschedule | `planning.task_snooze` is personal and never touches dates (bounded by `TASK_SNOOZE_MAX_DAYS`). Reschedule is the ordinary field-merge edit of the due date or, separately, the deadline, with an explicit choice in the dialog and the usual audit; nothing changes the deadline implicitly. Reschedule counts come from audited `task.updated` changes, so snoozes and view state never count. |
| T5 | Freshness (OD-17) | `work.task.last_meaningful_update_at` is maintained by triggers. Title, description, status, dates, estimates, and lifecycle on the task row count, as do assignees, checklist, criteria, labels, links, relationships, and non-computed field values (a definer `work.touch_task`), and the manual "mark as updated". Rank, priority, reads, view state, favorites, recents, reminders, and snoozes do not. Stale: active after `TASK_STALE_ACTIVE_DAYS` (7), planned after `TASK_STALE_PLANNED_DAYS` (14); paused, done, and cancelled never. Repeatedly rescheduled: `TASK_RESCHEDULE_COUNT` (3) material due-date or deadline edits within `TASK_RESCHEDULE_WINDOW_DAYS` (14); setting a first date is not material. |
| T6 | Signals | Blocked, missing owner, missing date, missing criteria, and missing dependency are independent, derived in one fixed set of statements from rows filtered by the viewer's visibility predicate. Share-only readers get null for signals that depend on context a share excludes. Unreadable blockers change neither the result nor the statements (AT-131). |
| T7 | Duplicates | Deterministic: normalized title (trim, single spaces, lower case; `task_duplicate_probe` index) in the same workspace and brand, compatible project (same, or either projectless), open, created within `DUPLICATE_WINDOW_DAYS`, readable, at most `DUPLICATE_CANDIDATES_MAX`. Advisory only (AT-130). |
| T8 | Bulk | `work.bulk_operation` (`bop_`) stores a previewed explicit set (at most `BULK_ITEMS_MAX`, resolved through `loadTask`, so unreadable equals unknown, AT-132), the operation, mode, fingerprint, and expiry (`BULK_PREVIEW_TTL_SECONDS`). Execution happens once under a row lock. Safe operations (status, priority, due date, labels) default to partial mode with one savepoint per item. Destructive ones (archive, trash) default to atomic: one refused item rolls everything back and the conflict names it. Every item is reported, so there is never a silent partial mutation. |
| T9 | Ordering | `task:reorder` moves up, down, top, bottom, or to a 1-based position among readable siblings and returns an announcement. Keyboard (Alt+arrows, Alt+Home/End), buttons, and drag all call it, and compact layouts never depend on drag. |
| T10 | Inline edits | Inline edits use the field-merge `updateTask` (base or base hash, record version) and the one transition evaluator (`applyTaskChanges`). A same-field conflict returns theirs and yours, and the UI offers Keep mine (resend over the latest), Use latest, or Cancel. |
| T11 | Undo | `work.undo_entry` (`und_`) stores only the prior values of the changed fields (or the prior rank or label) for its actor, for `UNDO_WINDOW_SECONDS` (30). Applying it is an audited inverse through the same commands under the request's new idempotency key. It requires every target to be at the version the change produced; otherwise the entry closes as conflicted. Status changes into or out of done or cancelled are undone with Reopen, not here. |
| T12 | Source | `work.task.origin_kind` is one of manual, recurring, intake, import, integration, or ai_draft, with `origin_ref` holding safe public identifiers. A trigger and the grants make it immutable; a registered migration disables the trigger inside its own transaction. Task views show the kind to everyone and the identifiers to own readers. |
| T13 | Reliability and privacy | The UI shows save states (saving, saved, conflict, offline, failed). It reconciles from the server or reverts visibly, and aborts superseded reads. Signals, duplicates, bulk previews, and template applications leak nothing unreadable by content, count, error, statements, or time (shared timing harness). |

## Recorded deviations and clarifications

- Template application is not a closed origin kind, so applied tasks are `manual` with `origin_ref` naming the template and version; `core.record.source_kind` records `template`.
- Bulk status changes in the UI offer the platform statuses; the API also accepts custom workflow status keys and runs the evaluator per item.
- Board drag that changes status (TSK-036) is 3B; ordering is complete here.

## Consequences

Two migrations, `0027_task_interaction` and `0028_task_bulk_undo`, reverse exactly to 0026 and 0027. Twelve bounds are configurable (environments.md). Task capabilities gain `manage_recurrence` and `save_template`, and list rows carry their version.
