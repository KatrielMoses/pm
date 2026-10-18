

## Phase 7E: briefings and reviews

Migration `0058_ai_briefings` (expand; exact rollback to 0057; 0B ADR-49, ADR-0042) adds five tables, all with forced row-level security and workspace-scoped foreign keys:

- `briefing_schedule` (`bsc_`): zone, local minute, ISO weekdays, channels, enabled, revision, `next_run_at`.
- `briefing` (`brf_`): the detail of a `briefing` operation; one per schedule occurrence (partial unique index on `schedule_id, occurrence_key`).
- `briefing_statement`: section, trust kind, statement key, text, evidence references, figures.
- `briefing_correction` (`bco_`) and `briefing_correction_event` (references only).
- `exec_dispatch.discover_briefing_work(now, limit)`: workspace ids with due schedules or queued briefings.

Grants: select, insert, and update on the first four for `app_rw` and `app_worker`; select and insert on the event table; no delete for any role. `app_worker` also gains select on `timetrack.timesheet_line` (the sweep composes through the timesheet approval reader). Erasure clears text, references, figures, coverage, and note text and turns a departed person's schedules off. The down migration refuses while any schedule or briefing exists, lifting forced row-level security on both tables for that one check. Workspace purge deletes `ai.briefing_correction_event`, `ai.briefing_correction`, `ai.briefing_statement`, `ai.briefing`, and `ai.briefing_schedule` before `exec.operation`.
