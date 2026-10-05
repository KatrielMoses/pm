# ADR-0014: Tasks and relationships (Phase 2B)

Status: **proposed** (implemented locally; awaiting one clean current-head no-skip CI run on the stacked draft PR). Engineering detail: [tenancy.md](../tenancy.md#phase-2b-tasks), [database.md](../database.md#phase-2b-tasks-and-relationships), [lifecycle.md](../lifecycle.md#phase-2b-task-adapter).
Extends ADR-0013 (2A), ADR-0011 (1D), ADR-0012 (1E), and ADR-0009 (1F).

Accepted sources (the Phase 2B brief's decisions, recorded before code):
- 0B: ADR-22 (`work.task` key columns, `task_assignee`, `checklist_item`, task-scoped `criteria_item`, `task_inherited_criterion`, brand-scoped `work.label` with `work.task_label`, `relations.record_link`).
- 0C: AZ-22 (task governing project, `task.override_completion`, `label.manage`, task share boundary, `record.move_brand` needs manage in both brands); T-40, AT-117 to AT-121.
- 0D: PL-24 (prefixes `chk`, `lbl`, `lnk`; events `work.task.moved`, `work.task.reopened`, `work.label.created`, `work.label.updated`; parameters `TASK_DEPTH_MAX`, `TASK_SUBTREE_MAX`, `TASK_ITEMS_MAX`, `TASK_ASSIGNEES_MAX`, `TASK_LABELS_MAX`, `BRAND_LABELS_MAX`, `TASK_ESTIMATE_MINUTES_MAX`; telemetry `work.task.moves`, `work.task.completions`).
- Product: OD-01, OD-02, OD-08, OD-09, OD-10 decided; lifecycle-and-states has the six-status task workflow.
- 0E: the Phase 2B implementation note in 02-information-architecture (task page, projectless list, honest absences).

## Context

2B adds the unit of work. It reuses the 2A project chain, visibility compiler, rank helper, structures, preview tokens, and lifecycle adapters. There is no parallel authority, status, history, or relationship store.

## Decisions

| # | Topic | Decision |
|---|---|---|
| T1 | Scope (OD-02) | Brand is mandatory and project optional. A subtask has its parent's brand and project, enforced by a composite foreign key and the deferred `task_ancestry` trigger. A cross-brand move needs `record.move_brand` with manage in both brands, a signed preview (`preview:work.task_move_brand`), confirmation, and atomic revalidation; the definer `work.move_task_brand` is the only path that changes a task's brand, and `core.record_guard` allows it only for that owner. Labels are removed (they belong to one brand); inherited criteria responses are dropped. |
| T2 | Statuses | Six immutable platform statuses seeded for `task`: Backlog, To do (planned), In progress (active), Blocked (paused), Done (done), Cancelled (cancelled). `done` is reached only through Complete. |
| T3 | Dates (OD-01) | `start_date` and `due_date` are dates; the deadline is a date or an instant with a time zone and changes only when edited directly. Scheduled time is 3C and the page says so. |
| T4 | Assignees | Active members only, at most `TASK_ASSIGNEES_MAX`, at most one primary (unique partial index). Assignment never grants access; a departing member's assignments end in the same transaction as the departure (deferred `assert_departing_assignee`). |
| T5 | Hierarchy | One parent per task; `TASK_DEPTH_MAX` 20 (root = 0) in commands, database ceiling 64. Moves take root advisory locks in a fixed order, check cycle, depth, and `TASK_SUBTREE_MAX`, then rewrite the subtree in one statement. Descendants come from a recursive walk on `parent_task_id`. |
| T6 | Checklists | Ordered, rank-keyed facts (`chk_`) bounded by `TASK_ITEMS_MAX`; toggling never changes task status. |
| T7 | Dependencies (OD-05) | `blocks` is one directed edge in `relations.record_relationship`; "blocked by" is its inverse view. `related` is symmetric and stored once (ordered endpoints). A workspace advisory lock and a recursive check refuse cycles. Display re-authorizes both endpoints and omits unreadable ones. |
| T8 | Labels | `work.label` is brand-scoped (`lbl_`, normalized unique names, `BRAND_LABELS_MAX`), attached through `work.task_label` (`TASK_LABELS_MAX`). Archived labels stay on tasks. Labels never confer authority. Managing them needs `label.manage`. |
| T9 | Description | The 2A `description_rich` contract (version 1, database check, `base_hash` merge). |
| T10 | Criteria (OD-08) | Task acceptance and definition-of-done items live in `criteria_item` with `required`. Project definition-of-done items are inherited by evaluation, never copied; per-task state (`met`, `dismissed`) is a `task_inherited_criterion` row. Completing with unmet required items needs `task.override_completion` and a reason; the reason and unmet count are audited. |
| T11 | Deliverable (OD-09) | `expected_deliverable_type` from a closed list, optional detail, and `requires_acceptance`. Files and documents are 4C/4E. |
| T12 | Estimates (OD-10) | `estimate_minutes` and `remaining_estimate_minutes`, non-negative, at most `TASK_ESTIMATE_MINUTES_MAX`. Tracked time is 3D. |
| T13 | Links | `relations.record_link` (`lnk_`): `https` URLs only (database check plus normalization), or a record target through an adapter for registered readable types. In 2B no production type is registered (`LINK_TARGET_TYPES` is empty). |
| T14 | History | A projection of the audit ledger for the task's own rows. No history table. Content fields are reported as changed without values; hidden counterparts are omitted; entries carry an opaque `key`, never an internal identifier. |
| T15 | Sharing | `task` joins the shareability registry (`read`, `comment`, `edit`). A share gives the task, its checklist, and its own criteria only. Subtasks, project context, dependencies, links, labels, assignees, history, and onward sharing are excluded (`not_found` for excluded content, `forbidden` for excluded actions on the task). |
| T16 | Completion | Complete sets `done` and `completed_at`; Reopen returns to the prior non-terminal status, otherwise To do. A parent with incomplete subtasks needs a confirmed override; completion never cascades. Project completion is readable done leaf tasks over readable non-cancelled leaf tasks (OD-13 `leaf_tasks` basis). |
| T17 | Duplicate | Copies fields, own criteria, checklist text (reset), labels, and URL links, optionally the subtree. Assignees, shares, history, comments, dependencies, related tasks, record links, acceptance facts, and recurrence are never copied, and the response lists them (`not_copied`). |
| T18 | Lifecycle | Archive, trash, restore, and purge apply to the selected task unless `include_subtasks`; batches are per node. Purge is refused while live children exist. Project lifecycle includes its tasks. |

## Recorded deviations and clarifications

| # | Item | Resolution |
|---|---|---|
| V1 | The `item=` side panel (0E) | Deferred to 3A with saved views; 2B ships the canonical task page and the project Tasks section. |
| V2 | Completing a share-only task | Refused: completion is a project-context action, so a share-only reader gets `forbidden`. |
| V3 | Record-target links | The adapter exists and is tested with a test-only type; no production type is registered until a later phase registers a readable type. |
| V4 | Rank helper | The 2A `nextRank` treated `after = null` as "append", so 2A Move up sent items to the end. `after` now means `null` = first, `'last'` = append, otherwise after that sibling; 2A callers were updated and the project phase-order test states the contract. |

## Consequences

- Every later task feature (views, bulk edit, side panel, time, files, comments, followers) composes these records and the same visibility predicate.
- Query plans at 5,000 and 50,000 tasks are tested for lists, children, assignees, labels, items, relationships, and history, for restricted and grant-heavy principals.
