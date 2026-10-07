# ADR-0020: Core views (Phase 3B)

Status: **proposed** (implemented; awaiting one clean current-head no-skip CI run on the stacked draft PR). Engineering detail: [database.md](../database.md#phase-3b-core-views), [tenancy.md](../tenancy.md#phase-3b-views), [observability.md](../observability.md#views-3b).
Extends ADR-0018 (3A) and ADR-0019 (3D).

Accepted sources (the Phase 3B brief, recorded before code):
- 0A: VIEW-001 to VIEW-011, VIEW-021, VIEW-023, CAL-001 to CAL-004, NAV-004, and NAV-005 (owned). Contributions: NAV-006, PRJ-019, TSK-036, TIME-009, and AUD-005. OD-12 decided (B4).
- 0B: ADR-28 (layouts on `views.saved_view`; no new tables).
- 0C: AZ-28 (no new actions). T-46, AT-162 to AT-168.
- 0D: PL-30 (layout reads, six envelopes, three bounds, one signal, public group keys).
- 0E: the Phase 3B implementation note in 02-information-architecture. RS-20, RS-32, and RS-50 to RS-55; A11Y-PA-06/07/15/16; A11Y-SR-08.

## Decisions

| # | Topic | Decision |
|---|---|---|
| B1 | One engine, many layouts | A saved view's `layout` chooses the rendering of the one 3A query result. Layouts add only display columns to the query, plus a date window for the calendar, never their own filters, sorts, groups, or authorization. Layout facts are reads over records the same compiled query returns (`compileQuery`). Each entity offers only its own layouts (a database check). |
| B2 | Board | Columns are the statuses the tasks' workflows offer (2D status options) plus the statuses shown, or priorities. "Move to…" lists the record's own allowed transitions and works without dragging; dragging is an extra. Status moves preview and apply the workflow transition with the record version. Gated moves (fields, approval, confirmation) change nothing and say why on the card, with Open. Conflicts refresh the board. Compact shows one column with a switcher. |
| B3 | Calendar | Day, week, month, and agenda (Compact: agenda, day, week; Medium month shows counts). Events are tasks by the chosen date field, their deadlines, and milestones of readable projects; each event is a button named by title, type, date, and brand. The query is narrowed to the visible window. Scheduled work blocks are 3C's and external events 6C's: CAL-003 and CAL-004 are foundations with no date mutation. Phase 3 integration review: both completed once 3C landed — each task event has **Schedule…** (keyboard dialog: day, start, minutes) creating a 3C work block, and Today resizes blocks in 15-minute steps (**Shorter**/**Longer**); still no date mutation. |
| B4 | Timeline and Gantt (OD-12) | Timeline: start-to-due (or target) bars at day, week, month, or quarter zoom, with a dates line per row. Gantt adds `blocks` arrows as text between shown items and dependency-aware rescheduling that is offered, never silent, and reported per item. "Change dates…" moves start and due together by days; deadlines never change. Baseline versus actual is deferred to 5C. |
| B5 | Workload | Person × day, week, or month: remaining (else original) estimates of open tasks by due date, per primary assignee, in one aggregate over the authorized predicate, members only, at most `WORKLOAD_DAYS_MAX` days. Unestimated counts are shown as text. Capacity and over-allocation are 3E's (`capacity: null`). |
| B6 | Projects | Portfolio groups by brand when several brands are shown, else by status, with health, target date, and OD-13 progress over readable leaf tasks. Milestones lists each returned project's milestones. |
| B7 | Activity | Audit events of returned records readable through ownership (history is outside a share), newest first, filtered by person, actor type, or action family, with a MAC-bound cursor and at most `ACTIVITY_RECORDS_MAX` records. Names and records in changes are re-authorized; unreadable field changes are dropped and empty entries omitted. Field readability uses the view level, which fails closed. |
| B8 | Timesheet | Tasks of the view × days of a week with the caller's own logged minutes (3D entries). Logging, submitting, and approving stay on the Time page (ADR-0019). |
| B9 | Detail and state | `item=` opens a detail panel over the view (pushed, so Back closes it, and Escape closes it). Compact opens the full page. The view's `q` state is untouched. Layout and options live in presentation and the URL. My Work (Assigned to me, Assigned by me) and the Calendar destination are fixed queries over the engine with their own view-state keys. Following is 4A's. |
| B10 | Public identifiers | Group keys and every layout read carry public IDs or status keys only (a correction to 3A's group keys). |

## Recorded deviations and clarifications

- **Calendar drag (CAL-003, CAL-004).** Scheduling and resizing need 3C work blocks; they are foundations (no mutation of due dates or deadlines).
- **Board order (TSK-036).** Rank order is per sibling scope, not per column, so the board keeps the engine's order. Ordering stays on the list's Move up and down (2D).
- **Following (NAV-006, 4A)** shows an honest absence.
- **Activity filters (AUD-005, 1F).** People, actor types, and action families are implemented. Agent and integration actors appear once 7A and 6A emit them.
- **Migration numbering.** 3C runs in parallel: whichever merges second renumbers its migration and ADR.

## Consequences

Migration `0033_core_view_layouts` changes constraints only and reverses exactly to 0032. The My Work and Calendar destinations are live.
