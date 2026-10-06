-- Reverts 0026 (local/test only). Restores the exact 0025 catalog.
-- The 0024 cross-brand move (no field values, attachments, or approval roots to carry).
CREATE OR REPLACE FUNCTION work.move_task_brand(p_tasks uuid[], p_brand uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ws uuid := exec.current_workspace_id();
  n integer;
BEGIN
  IF ws IS NULL OR p_brand IS NULL OR cardinality(p_tasks) = 0
     OR NOT EXISTS (SELECT 1 FROM tenancy.brand b WHERE b.workspace_id = ws AND b.id = p_brand AND b.lifecycle_state = 'active')
     OR EXISTS (SELECT 1 FROM unnest(p_tasks) AS x(id) LEFT JOIN core.record r ON r.workspace_id = ws AND r.id = x.id
                 WHERE r.id IS NULL OR r.record_type <> 'task' OR r.lifecycle_state <> 'active')
     OR EXISTS (SELECT 1 FROM unnest(p_tasks) AS x(id) LEFT JOIN work.task t ON t.workspace_id = ws AND t.id = x.id
                 WHERE t.id IS NULL OR t.brand_id <> p_brand) THEN
    RAISE EXCEPTION 'move the task rows to an active brand of this workspace first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.record SET brand_id = p_brand, version = version + 1
   WHERE workspace_id = ws AND id = ANY(p_tasks) AND brand_id <> p_brand;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Relationships keep both endpoints' brands for hidden-endpoint filtering (0B §3.5).
  UPDATE relations.record_relationship SET from_brand_id = p_brand
   WHERE workspace_id = ws AND from_record_id = ANY(p_tasks);
  UPDATE relations.record_relationship SET to_brand_id = p_brand
   WHERE workspace_id = ws AND to_record_id = ANY(p_tasks);
  RETURN n;
END
$$;

DROP TABLE access.field_policy;
DROP TABLE workflow.field_set_attachment;
DROP TABLE workflow.field_set_version;
DROP TABLE workflow.field_set;
DROP TABLE workflow.field_value;
DROP FUNCTION workflow.field_value_shape();
DROP TABLE workflow.formula_dependency;
DROP FUNCTION workflow.assert_formula_acyclic();
DROP TABLE workflow.field_option;
ALTER TABLE workflow.transition_requirement DROP CONSTRAINT transition_requirement_definition_fkey;
DROP TABLE workflow.field_definition;
DROP FUNCTION workflow.field_definition_guard();
