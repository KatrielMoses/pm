-- Reverts 0025 (local/test only). Restores the exact 0024 catalog.
CREATE OR REPLACE FUNCTION work.project_status_category() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  SELECT s.category INTO NEW.status_category FROM workflow.platform_status s
   WHERE s.id = NEW.status_id AND s.record_type = 'project';
  IF NEW.status_category IS NULL THEN
    RAISE EXCEPTION 'project status must be a project status' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION work.task_status_category() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  SELECT s.category INTO NEW.status_category FROM workflow.platform_status s
   WHERE s.id = NEW.status_id AND s.record_type = 'task';
  IF NEW.status_category IS NULL THEN
    RAISE EXCEPTION 'task status must be a task status' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.prior_status_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workflow.platform_status s
      WHERE s.id = NEW.prior_status_id AND s.record_type = 'task' AND s.category NOT IN ('done', 'cancelled')) THEN
    RAISE EXCEPTION 'a reopen target must be a non-terminal task status' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE work.project ADD CONSTRAINT project_status_id_fkey FOREIGN KEY (status_id)
  REFERENCES workflow.platform_status (id) ON DELETE RESTRICT;
ALTER TABLE work.task ADD CONSTRAINT task_status_id_fkey FOREIGN KEY (status_id)
  REFERENCES workflow.platform_status (id) ON DELETE RESTRICT;
ALTER TABLE work.task ADD CONSTRAINT task_prior_status_id_fkey FOREIGN KEY (prior_status_id)
  REFERENCES workflow.platform_status (id) ON DELETE RESTRICT;

DROP FUNCTION workflow.status_offered(text, uuid, uuid, uuid, uuid);
DROP FUNCTION workflow.status_category(text, uuid, uuid);
DROP TABLE workflow.approval_decision;
DROP TABLE workflow.approval_request;
DROP FUNCTION workflow.approval_request_guard();
DROP TABLE workflow.transition_approver;
DROP TABLE workflow.transition_requirement;
DROP TABLE workflow.transition;
DROP TABLE workflow.workflow_status;
DROP FUNCTION workflow.workflow_status_guard();
DROP FUNCTION workflow.resolve_workflow(text, uuid, uuid, uuid);
DROP TABLE workflow.workflow;
