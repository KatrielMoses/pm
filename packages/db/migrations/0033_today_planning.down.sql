-- Reverts 0033 (local/test only). Restores the exact 0032 catalog.
REVOKE SELECT (id, timezone) ON identity.account FROM app_worker;
DROP FUNCTION exec_dispatch.discover_block_series_due(timestamp, integer);
DROP FUNCTION exec_dispatch.discover_days_to_close(date, integer);
DROP TABLE planning.daily_record;
DROP TABLE planning.today_commitment;
DROP TABLE planning.work_block;
DROP TABLE planning.block_series;
DROP FUNCTION planning.daily_record_guard();
DROP FUNCTION planning.today_commitment_guard();
DROP FUNCTION planning.work_block_guard();
