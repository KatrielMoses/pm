# 6. Temporal and recurrence model

Input: [0A time-and-scheduling](../../product/time-and-scheduling.md) and [0E 08-i18n-and-time](../../ux/08-i18n-and-time.md) (display rules; storage is 0B's).

## 6.1 Storage types

| Kind of value | PostgreSQL type | Companion columns | Examples |
|---|---|---|---|
| **Instant** (a moment) | `timestamptz` (stored as UTC) | `*_tz text` (IANA name) when a person entered it in local time and the local intent matters | `created_at`, `completed_at`, work block `starts_at/ends_at` + `source_tz`, `deadline_at` + `deadline_tz`, timer start |
| **Floating calendar date** | `date` | none | `start_date`, `due_date`, `target_date`, date-only `deadline_date`, holiday date, Today `day` |
| **Floating local time** | `time` | `*_tz` when anchored | Optional `due_time` (combined with `due_date` and `due_tz` only when the user sets a time) |
| **Local date-time anchored to a zone** | `timestamp without time zone` + `*_tz` | — | Recurrence `dtstart_local` + `anchor_tz`, availability windows (`weekday`, `start_local time`, `end_local time`, `tz`) |
| **Effort** | `integer` minutes | — | `estimate_minutes`, `remaining_estimate_minutes`, `time_budget_minutes`, capacity minutes |
| **Tracked duration** | `integer` seconds | — | `time_entry.duration_seconds` |
| **Period** | `daterange` or (`period_kind`, `period_start date`) | — | Capacity reservations, timesheets, usage balances, goal periods |
| **Timezone setting** | `text` (validated IANA name) | — | `account.timezone`, `workspace.timezone`, `brand.timezone` |

Rules:

1. **Never store local times without a zone, and never store offsets instead of zone names.** Offsets break across DST, and IANA names do not.
2. **Floating dates are never converted on write.** Interpretation happens at query time with the viewer's timezone (personal surfaces) or the brand timezone (brand surfaces). Queries receive the zone as a parameter: `due_date < (now() AT TIME ZONE :tz)::date`.
3. **Deadline has exactly one form:** `CHECK (num_nonnulls(deadline_date, deadline_at) <= 1)` and `CHECK ((deadline_at IS NULL) = (deadline_tz IS NULL))`.
4. **The database clock is the authority** for system timestamps. Client-reported times (offline queue, ST-05) are kept as `client_recorded_at` for display only.
5. Timezone names are validated against `pg_timezone_names` at write time by the command. A trigger is unnecessary.

## 6.2 Due dates, deadlines, and work blocks are separate rows or columns

- `work.task` holds `start_date`, `due_date` (+ optional `due_time`/`due_tz`), `deadline_date | deadline_at+deadline_tz`, `estimate_minutes`, `remaining_estimate_minutes`, `completed_at`.
- `planning.work_block` holds the scheduled time: `starts_at`, `ends_at`, `source_tz`, `focus`, `locked`, `buffer_kind`, `source`, and an optional `task_id`. A task has **zero or many** blocks, and the scheduled effort is `sum(ends_at - starts_at)`.
- **Preserving the 0A rule:** the `planning` commands that move or resize blocks (drag, resize, calendar sync, plan acceptance, rescheduling) have **no write path** to `work.task` date columns. "Also move due date" is a separate explicit `work.update_task` command issued by the client in the same request with its own field, and changing the deadline is a third explicit command. A test in Phase 3C asserts that no planning command touches `due_date`, `deadline_*`.
- Snoozes are personal (`snoozed_until` on Inbox items and notifications; a personal `planning.snooze` row for tasks if needed) and never alter task dates.

## 6.3 Timezones in context

| Context | Source | Stored where |
|---|---|---|
| User | `identity.account.timezone`, plus `day_start_offset` (UXD-19) | Account |
| Workspace | `tenancy.workspace.timezone` | Workspace |
| Brand working calendar | `tenancy.brand.timezone` + `planning.brand_calendar` | Brand |
| Event-native | `planning.work_block.source_tz`, `integrations.calendar_event.event_tz`, `planning.recurrence_series.anchor_tz` | Row |

**Today's day key:** `today_commitment.day` = the date in the person's timezone after applying `day_start_offset` at the moment of commitment. It is stored as a floating date, so later timezone changes do not move past commitments.

## 6.4 Recurrence

| Table / column | Meaning |
|---|---|
| `planning.recurrence_series` | `target_kind` (task, project, work_block), `rrule` (validated RFC 5545 subset: FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYSETPOS, COUNT, UNTIL), `anchor_tz`, `dtstart_local`, `mode` (`schedule`/`after_completion`), `template_payload` (typed JSON per target kind), `generated_through date`, `ends_at_occurrence`, `split_from_series_id` |
| Occurrence identity | Each generated record stores `recurrence_series_id` + `occurrence_key` = the **original** local date-time (ISO string in `anchor_tz`) of that occurrence. `UNIQUE (recurrence_series_id, occurrence_key)` on each target table. |
| `planning.recurrence_exception` | `(series_id, occurrence_key)` → `skip`, `moved` (new local time), `overridden` (field values). Applies to occurrences not yet generated. |

Edits:

- **This occurrence:** edit the generated record. It becomes "detached" from series updates (`series_detached = true`). For ungenerated occurrences, write an exception.
- **This and future:** set the original series' `ends_at_occurrence` to the previous key, then create a new series with `split_from_series_id`, `dtstart_local` at this occurrence, and the edited rule or template. Already-generated future occurrences that are unstarted and not detached are re-pointed and updated, and the rest are left as they are and listed.
- **All occurrences:** update the series. Past occurrences are never rewritten (0A). Future ungenerated occurrences follow automatically, and generated unstarted, non-detached ones are updated.

Generation runs as a job with dedupe key `(series_id, generated_through)` and inserts with `ON CONFLICT (recurrence_series_id, occurrence_key) DO NOTHING`, so retries never duplicate. Evaluation happens in `anchor_tz`, and local times are stable across DST (0A example 5).

## 6.5 Availability and capacity

| Table | Key columns |
|---|---|
| `planning.availability_rule` | `membership_id`, `weekday`, `start_local`, `end_local`, `tz`, `effective_from`, `effective_to` |
| `planning.brand_calendar` | Brand working windows (same shape), timezone |
| `planning.holiday` | Scope (person via personal row, or brand via `brand_id`), `date`, `name`, `source` (manual at launch, OD-19) |
| `planning.time_off` | `membership_id`, `starts_at/ends_at` or `start_date/end_date` with `all_day`, `kind` (sensitive) |
| `integrations.calendar_event` | Busy time from external calendars (personal) |
| `planning.capacity_reservation` | `brand_id`, `membership_id`, `period_kind`, `period_start`, `minutes` or `share_bp` (basis points) — a soft target |

Available time is **computed**: availability windows minus time off, holidays, busy events, and buffers, expanded to instants in the person's timezone for the requested range. The computation is a pure function in `planning`, and the results can be cached per (person, day) and invalidated by events. Viewer-specific capacity views include only commitments the viewer can read (approved aggregate rule; see [DQ-06](13-open-questions.md#dq-06) for the free/busy contradiction).

## 6.6 Time tracking

| Rule | Mechanism |
|---|---|
| One running timer per person | `UNIQUE (membership_id) WHERE ended_at IS NULL` on `timetrack.time_entry` |
| Entry belongs to the work's brand | `brand_id NOT NULL`, composite foreign key to the task or project in the same brand; `CHECK (num_nonnulls(task_id, project_id) >= 1)` |
| Timesheet | `timetrack.timesheet (membership_id, period_start, period_end, state)`; `UNIQUE (membership_id, period_start)` |
| Per-brand approval | `timetrack.timesheet_approval` (append-only decision per timesheet × brand) |
| Locked periods | `timetrack.period_lock (brand_id, membership_id, period, locked_by_approval_id)`. Unlock is an appended `unlock` row with a reason (OD-26). Entry writes check for an active lock with `FOR SHARE` on the lock row inside the command. A constraint trigger blocks edits to entries in locked periods as a backstop. |
| Planned versus actual | Planned = estimates (or block durations, labeled). Actual = time entries. Both are aggregated per brand, project, person, and period into `insights.metric_snapshot`. |
