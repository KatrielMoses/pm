-- Reverts 0022 (local/test only). Restores the exact 0021 catalog.
DROP FUNCTION exec_dispatch.discover_recurrence_due(timestamptz, integer);
REVOKE SELECT (workspace_id, state, next_due_at) ON planning.recurrence_series FROM pm_scheduler;
DROP FUNCTION work.remove_purged_project_access(uuid);
DROP FUNCTION work.grant_occurrence_manager(uuid, uuid, uuid);
DROP INDEX work.project_occurrence_unique;
DROP INDEX work.project_by_recurrence;
UPDATE work.project SET recurrence_series_id = NULL, occurrence_key = NULL WHERE recurrence_series_id IS NOT NULL;
ALTER TABLE work.project DROP CONSTRAINT project_recurrence_series_fkey;
DROP TABLE planning.recurrence_series;
DROP FUNCTION planning.recurrence_series_guard();
ALTER TABLE templates.template DROP CONSTRAINT template_current_version_fkey;
DROP TABLE templates.template_version;
DROP TABLE templates.template;
DELETE FROM core.record WHERE record_type = 'template';
DROP TABLE relations.record_relationship;
DROP SCHEMA planning;
DROP SCHEMA templates;
DROP SCHEMA relations;
