-- Reverts 0027 (local/test only). Restores the exact 0026 catalog.
DROP FUNCTION exec_dispatch.discover_reminders_due(timestamptz, integer);
REVOKE INSERT ON workflow.field_value FROM app_worker;
REVOKE INSERT ON work.task, work.checklist_item, work.task_label, relations.record_link FROM app_worker;
REVOKE UPDATE (project_id) ON planning.recurrence_series FROM app_rw, app_worker;
REVOKE UPDATE (last_meaningful_update_at) ON work.task FROM app_rw;
REVOKE SELECT (workspace_id, state, remind_at) ON planning.task_reminder FROM pm_scheduler;
DROP TABLE planning.task_snooze;
DROP TABLE planning.task_reminder;
DROP FUNCTION planning.task_reminder_guard();

ALTER TABLE templates.template DROP CONSTRAINT template_target_known;
ALTER TABLE templates.template ADD CONSTRAINT template_target_known CHECK (target_record_type IN ('project'));

DROP INDEX planning.recurrence_series_by_project;
ALTER TABLE planning.recurrence_series DROP CONSTRAINT recurrence_series_project_fkey;
ALTER TABLE planning.recurrence_series DROP CONSTRAINT recurrence_series_project_for_tasks;
ALTER TABLE planning.recurrence_series DROP CONSTRAINT recurrence_series_target_known;
ALTER TABLE planning.recurrence_series ADD CONSTRAINT recurrence_series_target_known CHECK (target_kind IN ('project'));
ALTER TABLE planning.recurrence_series DROP COLUMN project_id;

DROP TRIGGER field_value_freshness ON workflow.field_value;
DROP TRIGGER record_relationship_freshness ON relations.record_relationship;
DROP TRIGGER record_link_freshness ON relations.record_link;
DROP TRIGGER task_label_freshness ON work.task_label;
DROP TRIGGER task_inherited_criterion_freshness ON work.task_inherited_criterion;
DROP TRIGGER criteria_item_freshness ON work.criteria_item;
DROP TRIGGER checklist_item_freshness ON work.checklist_item;
DROP TRIGGER task_assignee_freshness ON work.task_assignee;
DROP FUNCTION work.task_content_touched();
DROP FUNCTION work.touch_task(uuid, uuid);
DROP TRIGGER task_freshness ON work.task;
DROP FUNCTION work.task_freshness();
DROP TRIGGER task_origin_immutable ON work.task;
DROP FUNCTION work.task_origin_immutable();

DROP INDEX work.task_by_freshness;
DROP INDEX work.task_duplicate_probe;
DROP INDEX work.task_occurrence_unique;
DROP INDEX work.task_by_recurrence;
ALTER TABLE work.task DROP CONSTRAINT task_recurrence_series_fkey;
ALTER TABLE work.task DROP CONSTRAINT task_occurrence_shape;
ALTER TABLE work.task DROP CONSTRAINT task_origin_ref_shape;
ALTER TABLE work.task DROP CONSTRAINT task_origin_known;
ALTER TABLE work.task DROP COLUMN last_meaningful_update_at;
ALTER TABLE work.task DROP COLUMN occurrence_key;
ALTER TABLE work.task DROP COLUMN recurrence_series_id;
ALTER TABLE work.task DROP COLUMN origin_ref;
ALTER TABLE work.task DROP COLUMN origin_kind;
