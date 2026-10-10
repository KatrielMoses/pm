-- Reverts 0037 (local/test only). Restores the exact 0036 catalog.
DROP FUNCTION exec_dispatch.discover_notification_work(timestamptz, timestamptz, integer);
REVOKE USAGE ON SCHEMA work FROM pm_scheduler;
REVOKE SELECT (workspace_id, due_date, status_category) ON work.task FROM pm_scheduler;
DROP POLICY scheduler_discovery ON work.task;
DROP TABLE notify.delivery;
ALTER TABLE notify.notification DROP CONSTRAINT notification_digest_fkey;
DROP TABLE notify.digest;
DROP TABLE notify.notification;
DROP TABLE notify.scope_default;
DROP TABLE notify.preference;
DROP TABLE notify.profile;
DROP SCHEMA notify;
