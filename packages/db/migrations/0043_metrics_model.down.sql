-- Reverts 0043 (local/test only). Restores the exact 0042 catalog.
DROP FUNCTION exec_dispatch.discover_metrics_work(timestamptz, integer);
DROP TRIGGER metrics_purged ON core.record;
DROP TRIGGER metrics_removed ON work.task;
DROP TRIGGER metrics_status ON work.task;
DROP TRIGGER metrics_created ON work.task;
DROP FUNCTION metrics.record_purged();
DROP FUNCTION metrics.task_removed();
DROP FUNCTION metrics.task_changed();
DROP TABLE metrics.reconcile_state;
DROP TABLE metrics.task_status_span;
DROP SCHEMA metrics;
