DROP FUNCTION exec_dispatch.discover_maintenance_workspaces(timestamptz, integer);
DROP FUNCTION exec_dispatch.outbox_backlog();
DROP FUNCTION exec_dispatch.claim_outbox_events(integer, integer);
DROP FUNCTION exec_dispatch.job_queue_stats();
DROP FUNCTION exec_dispatch.discover_expired_leases(integer);
DROP FUNCTION exec_dispatch.claim_jobs(text, text, integer, integer, integer);
