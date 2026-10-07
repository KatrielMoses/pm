-- Reverts 0032 (local/test only). Restores the exact 0031 catalog.
DROP FUNCTION exec_dispatch.discover_runaway_timers(timestamptz, integer, integer);
REVOKE SELECT (workspace_id, entry_id, started_at, ended_at) ON timetrack.time_segment FROM pm_scheduler;
REVOKE SELECT (workspace_id, id, duration_seconds) ON timetrack.time_entry FROM pm_scheduler;
REVOKE USAGE ON SCHEMA timetrack FROM pm_scheduler;
DROP TABLE timetrack.period_lock;
DROP TABLE timetrack.timesheet_approval;
DROP TABLE timetrack.timesheet_line;
DROP TABLE timetrack.timesheet;
DROP TABLE timetrack.time_segment;
DROP TABLE timetrack.time_entry;
DROP FUNCTION timetrack.timesheet_guard();
DROP FUNCTION timetrack.append_only();
DROP FUNCTION timetrack.time_entry_consistency();
DROP FUNCTION timetrack.time_segment_guard();
DROP FUNCTION timetrack.time_entry_guard();
DROP FUNCTION timetrack.day_closed(uuid, uuid, uuid, date);
DROP FUNCTION timetrack.lock_person(uuid, uuid);
DROP SCHEMA timetrack;
