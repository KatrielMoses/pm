# ADR-0020: Today and manual planning (Phase 3C)

Status: **proposed** (implemented; awaiting one clean current-head no-skip CI run on the stacked draft PR). Engineering detail: [database.md](../database.md#phase-3c-today-and-planning), [tenancy.md](../tenancy.md#phase-3c-today-and-planning), [lifecycle.md](../lifecycle.md#phase-3c-plans), [observability.md](../observability.md#planning-3c).
Extends ADR-0019 (3D) and ADR-0018 (3A); reuses ADR-0013's rule engine (2A).

Accepted sources (the Phase 3C brief's decisions, recorded before code):
- 0A: PLAN-001–009, PLAN-014–019, CAL-005, CAL-011, and CAL-013 (owned). Contributions: TSK-006, CAL-003, LA-002, and LA-003. OD-18 decided at the Phase 0 exit gate (Today in the viewer's zone; committed or block-scheduled items, with due-today items in their own section) and applied. §1, §2, and §6 of time-and-scheduling.
- 0B: ADR-28. `planning.today_commitment`, `planning.work_block`, `planning.block_series`, `planning.daily_record`.
- 0C: AZ-28 (`personal.manage_own`; no new actions). T-46, AT-162 to AT-169.
- 0D: PL-30 (`bls` prefix, resources and verbs, seven events, nine bounds, four signals, five envelopes).
- 0E: the Phase 3C implementation note in 02-information-architecture.

## Decisions

| # | Topic | Decision |
|---|---|---|
| P1 | The day | A Today day is a calendar date in the viewer's profile zone (OD-18). Its bounds are local midnight to the next local midnight as UTC instants (`planning/semantics.ts`, the 2A conversion), so DST days are 23 or 25 hours. Blocks are listed by overlap with those bounds. |
| P2 | Today's sections | Committed (manual order), Scheduled (blocks), Overdue (due before today), Due today, and Upcoming deadlines (within `UPCOMING_DEADLINE_DAYS`) are separate. The three task lists run the 3A query engine (`runQuery`: assignee = me, open categories, relative dates against the viewer's today) under the viewer's own predicate, bounded by `TODAY_LIST_MAX`; items already committed are marked, not repeated. |
| P3 | Commitments never change dates | Committing, ordering, locking, moving to another day, removing, carrying, and returning never change a task's due date, deadline, or any other field (PLAN-008). One commitment per person, day, and task; today or later only; at most `TODAY_ITEMS_MAX` a day. |
| P4 | Manual order | Commitments carry a rank; moving puts an item after a named one (or first) with `rankBetween`, renumbering evenly when there is no room. Day changes are serialized by a per-person-day lock. |
| P5 | Locks | A locked commitment or block is never reordered, moved, carried, returned, or removed by any command (PLAN-017); the only change it accepts is unlocking. Shutdown can only leave a locked item. |
| P6 | Work blocks | A block is calendar time to do work, distinct from due dates and deadlines (TSK-006): whole minutes, 5 minutes to 24 hours, the zone it was entered in, an optional task (its brand cascades with the task) or a personal name, focus and lock flags, and preparation and buffer minutes that count as occupied time (PLAN-015). At most `WORK_BLOCKS_PER_DAY_MAX` start on one day. |
| P7 | Focus protection and deadlines | No block of the same person may overlap a focus block, preparation and buffer included (PLAN-014); the service refuses with `focus_protected` and a guard trigger repeats it. Moving a block never changes the task's dates (CAL-013): the block reports `after_due_date` and `after_deadline` warnings, and the UI offers changing the due date only as a separate, explicit task edit. A focus block can be created from the task's remaining estimate or estimate (CAL-011). |
| P8 | Recurring blocks | A block series (CAL-005) uses the 2A rule engine (`composeRule`, `parseRule`, `occurrences`, `localToUtc`) in its anchor zone, so local time is stable across DST. Occurrences are blocks keyed `(series_id, occurrence_key)` generated idempotently through `BLOCK_SERIES_HORIZON_DAYS` (at creation and by the hourly `planning.block_series` job); an occurrence that would overlap a focus block is skipped and counted; counted or dated series end by themselves; ending a series removes future occurrences nobody changed or locked. |
| P9 | Shutdown and day close | Shutdown (PLAN-018) gives each open commitment one decision: carry to tomorrow, pick a later day, return to the backlog, or leave it unfinished (PLAN-016); done tasks are recorded as done. Carried work opens a `carry` commitment on the target day. Every reschedule is audited. A day that ended without a shutdown is closed by the hourly `planning.day_close` job in the owner's zone (open items: done or dropped). |
| P10 | Daily records | A record (PLAN-019) is written once per person and day: committed, done, carried, returned, and dropped counts that add up; planned minutes from estimates with unestimated items counted; block and focus minutes clipped to the day; actual seconds from 3D time entries; and an item snapshot. It is never updated; a closed day accepts no new commitments. |
| P11 | Personal and permission-safe | Plans are personal (`personal.manage_own`): no other person, owner, or administrator reads or changes them. Naming a task needs it to be readable now. After revocation, commitments drop out, blocks stay as busy time without a title or link, and records keep outcomes without naming the task. |
| P12 | Honest absences | Working hours, available time, and capacity warnings (PLAN-005–007) are 3E's: Today shows committed estimates and scheduled minutes and says available time arrives with 3E. Meetings and calendar events (PLAN-004) are 6C's. AI rescheduling is 7F's. No tables or adapters are added for them. |

## Recorded deviations and clarifications

- **Work blocks are not core records in 3C.** They keep the registered `blk_` public ID but are deleted with audit (no trash); the seeded record type stays reserved for 6C calendar sync (ADR-28).
- **Block series instead of recurrence series.** Recurring blocks need no brand; `planning.recurrence_series` requires one. The rule engine, not the series table, is shared.
- **Commitments and records have no public ID.** They are addressed by day and task (`today/{day}/items/{tsk}`, `daily-records/{day}`) and returned as non-resource envelopes with the version as the `ETag`.
- **Contributions.** CAL-003 (drag onto the calendar) is 3B's rendering over these blocks; LA-002 and LA-003 use Today for the daily plan from desktop and mobile web.
- **Worker zone access.** The worker reads only `identity.account (id, timezone)` to close days in each person's zone.

## Consequences

Migration `0033_today_planning` reverses exactly to 0032. The Today destination is live; the task page has a Plan panel; the worker runs day close and block-series generation.
