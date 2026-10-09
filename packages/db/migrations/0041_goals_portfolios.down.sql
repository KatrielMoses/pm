-- Reverts 0041 (local/test only). Restores the exact 0040 catalog.
DROP FUNCTION exec_dispatch.discover_goal_work(timestamptz, integer);
DROP POLICY scheduler_discovery ON goals.goal_state;
REVOKE SELECT (workspace_id, dirty, next_check_at, claimed_until) ON goals.goal_state FROM pm_scheduler;
REVOKE USAGE ON SCHEMA goals FROM pm_scheduler;
DROP TABLE goals.portfolio_project;
DROP FUNCTION goals.assert_portfolio_member();
DROP TABLE goals.portfolio;
DROP TABLE goals.goal_state;
DROP TABLE goals.goal_link;
DROP FUNCTION goals.assert_goal_link();
ALTER TABLE goals.goal DROP CONSTRAINT goal_latest_checkin_fkey;
ALTER TABLE goals.key_result DROP CONSTRAINT key_result_latest_checkin_fkey;
DROP TABLE goals.goal_checkin;
DROP FUNCTION goals.goal_checkin_immutable();
DROP TABLE goals.key_result;
DROP TABLE goals.goal;
DROP FUNCTION goals.valid_value(numeric);
DROP SCHEMA goals;
