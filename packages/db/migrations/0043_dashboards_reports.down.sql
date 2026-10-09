-- Reverts 0043 (local/test only). Restores the exact 0042 catalog.
DROP FUNCTION exec_dispatch.discover_report_work(timestamptz, timestamptz, integer);
DROP POLICY scheduler_discovery ON insights.report_run;
REVOKE SELECT (workspace_id, created_at) ON insights.report_run FROM pm_scheduler;
DROP POLICY scheduler_discovery ON insights.report_definition;
REVOKE SELECT (workspace_id, next_run_at, claimed_until, suspended_at) ON insights.report_definition FROM pm_scheduler;
REVOKE USAGE ON SCHEMA insights FROM pm_scheduler;
DROP TABLE insights.report_run;
DROP TABLE insights.report_share;
DROP TABLE insights.report_recipient;
DROP TABLE insights.report_definition;
DROP TABLE insights.dashboard;
DROP SCHEMA insights;
