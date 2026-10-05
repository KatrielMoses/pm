-- Reverts 0024 (local/test only). Restores the exact 0023 catalog.
DROP TRIGGER task_assignee_on_membership ON tenancy.membership;
DROP FUNCTION work.assert_departing_assignee();

-- The 0016 record guard (record brand fully immutable).
CREATE OR REPLACE FUNCTION core.record_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only the final tombstone sweep (a retention hook, disabled while its period is unset).
    IF OLD.lifecycle_state <> 'purged' THEN
      RAISE EXCEPTION 'only tombstones may be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.public_id <> OLD.public_id OR NEW.record_type <> OLD.record_type
     OR NEW.workspace_id <> OLD.workspace_id OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
     OR NEW.created_at <> OLD.created_at OR NEW.created_by_actor_type <> OLD.created_by_actor_type
     OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id THEN
    RAISE EXCEPTION 'record identity and scope are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.lifecycle_state = 'purged' THEN
    RAISE EXCEPTION 'tombstones are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lifecycle_state <> OLD.lifecycle_state AND NOT (
       (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state IN ('archived', 'trashed'))
    OR (OLD.lifecycle_state = 'archived' AND NEW.lifecycle_state IN ('active', 'trashed'))
    OR (OLD.lifecycle_state = 'trashed' AND NEW.lifecycle_state IN ('active', 'archived', 'purged'))) THEN
    RAISE EXCEPTION 'lifecycle transition % -> % is not allowed', OLD.lifecycle_state, NEW.lifecycle_state
      USING ERRCODE = 'check_violation';
  END IF;
  -- A trashed record is only ever (re)assigned to a batch that is still trashed.
  IF NEW.lifecycle_state = 'trashed' AND NEW.deletion_batch_id IS DISTINCT FROM OLD.deletion_batch_id
     AND NOT EXISTS (SELECT 1 FROM core.deletion_batch b
                     WHERE b.workspace_id = NEW.workspace_id AND b.id = NEW.deletion_batch_id AND b.state = 'trashed') THEN
    RAISE EXCEPTION 'trashed records belong to a trashed batch' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'record version must increase by one' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
DROP FUNCTION work.move_task_brand(uuid[], uuid);

ALTER TABLE work.criteria_item DROP CONSTRAINT criteria_item_task_fkey;
ALTER TABLE work.criteria_item ADD CONSTRAINT criteria_item_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
  REFERENCES work.task (workspace_id, brand_id, id) ON DELETE RESTRICT;
ALTER TABLE work.checklist_item DROP CONSTRAINT checklist_item_task_fkey;
ALTER TABLE work.checklist_item ADD CONSTRAINT checklist_item_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
  REFERENCES work.task (workspace_id, brand_id, id) ON DELETE RESTRICT;
ALTER TABLE work.task_assignee DROP CONSTRAINT task_assignee_task_fkey;
ALTER TABLE work.task_assignee ADD CONSTRAINT task_assignee_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
  REFERENCES work.task (workspace_id, brand_id, id) ON DELETE RESTRICT;

DROP TABLE relations.record_link;
