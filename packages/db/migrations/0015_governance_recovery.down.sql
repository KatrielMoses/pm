-- Reverts 0015 (local/test only).
DROP FUNCTION exec_dispatch.discover_audit_workspaces(uuid, integer);
DROP FUNCTION exec_dispatch.purge_backlog();
DROP FUNCTION exec_dispatch.discover_purge_due(interval, integer);
REVOKE SELECT (workspace_id) ON audit.audit_event FROM pm_scheduler;
REVOKE USAGE ON SCHEMA audit FROM pm_scheduler;
DROP POLICY scheduler_discovery ON audit.audit_event;
DROP TABLE audit.buffer_verification;
DROP TABLE ops.recovery_gate;
DROP TABLE governance.retention_policy;
DROP SCHEMA governance;
