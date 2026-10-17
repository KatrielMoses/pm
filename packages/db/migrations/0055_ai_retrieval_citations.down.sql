-- migrate:phase contract
-- Restores the exact 0054 catalog. Grounded-answer actions cannot be represented in 0054, so the
-- rollback refuses while any exist (erase or purge them first); manifest columns and validated
-- answers are dropped with their columns.
-- The tables force tenant row-level security even on their owner, so the check would see no rows
-- without a workspace context. As in 0041, the force is lifted for this one read inside the
-- migration transaction and set again straight after (a refusal rolls everything back).
ALTER TABLE ai.ai_action NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_context_ref NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai.ai_action WHERE purpose <> 'test_run')
     OR EXISTS (SELECT 1 FROM ai.ai_context_ref WHERE record_type NOT IN ('task', 'project')
       OR (exclusion_reason IS NOT NULL AND exclusion_reason NOT IN
         ('field_not_ai_eligible', 'data_class', 'sensitive_brand', 'out_of_scope'))) THEN
    RAISE EXCEPTION 'grounded-answer actions exist; 0055 cannot be rolled back' USING ERRCODE = 'P0001';
  END IF;
END $$;
ALTER TABLE ai.ai_context_ref FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_action FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION ai.output_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.operation_id <> OLD.operation_id
     OR NEW.dispatch_id <> OLD.dispatch_id OR NEW.created_at <> OLD.created_at
     OR NEW.completeness <> 'erased' OR NEW.content IS NOT NULL THEN
    RAISE EXCEPTION 'AI output is immutable except erasure' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE ai.ai_output
  DROP CONSTRAINT ai_output_grounding,
  DROP COLUMN grounding;

ALTER TABLE ai.ai_context_ref
  DROP CONSTRAINT ai_context_ref_one_handle,
  DROP CONSTRAINT ai_context_ref_selection,
  DROP CONSTRAINT ai_context_ref_flags,
  DROP CONSTRAINT ai_context_ref_source_version,
  DROP CONSTRAINT ai_context_ref_hash,
  DROP CONSTRAINT ai_context_ref_handle,
  DROP CONSTRAINT ai_context_ref_exclusion,
  DROP CONSTRAINT ai_context_ref_public_id,
  DROP CONSTRAINT ai_context_ref_type,
  DROP COLUMN selection,
  DROP COLUMN source_flags,
  DROP COLUMN source_version,
  DROP COLUMN content_hash,
  DROP COLUMN handle,
  ADD CONSTRAINT ai_context_ref_type CHECK (record_type IN ('task', 'project')),
  ADD CONSTRAINT ai_context_ref_public_id CHECK (record_public_id ~ '^(tsk|prj)_[0-9A-HJKMNP-TV-Z]{26}$'),
  ADD CONSTRAINT ai_context_ref_exclusion CHECK ((included) = (exclusion_reason IS NULL)
    AND (exclusion_reason IS NULL OR exclusion_reason IN ('field_not_ai_eligible', 'data_class', 'sensitive_brand', 'out_of_scope')));

ALTER TABLE ai.ai_action
  DROP CONSTRAINT ai_action_retrieval_shape,
  DROP CONSTRAINT ai_action_purpose,
  DROP COLUMN manifest_digest,
  DROP COLUMN retrieval_scope,
  ADD CONSTRAINT ai_action_purpose CHECK (purpose IN ('test_run'));
