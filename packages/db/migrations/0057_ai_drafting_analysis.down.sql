-- migrate:phase contract
-- Restores the exact 0056 catalog. Analysis actions, action keys, goal and meeting sources, the
-- three added operations, and assumptions cannot be represented in 0056, so the rollback refuses
-- while any exists. Applied business records are not affected.
ALTER TABLE ai.ai_action NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_context_ref NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.proposed_change NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.change_proposal NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai.ai_action WHERE purpose = 'analysis' OR action_key IS NOT NULL)
    OR EXISTS (SELECT 1 FROM ai.ai_context_ref WHERE record_type IN ('goal', 'meeting'))
    OR EXISTS (SELECT 1 FROM ai.proposed_change WHERE op IN ('task.assign', 'label.add', 'criterion.add'))
    OR EXISTS (SELECT 1 FROM ai.change_proposal WHERE assumptions IS NOT NULL) THEN
    RAISE EXCEPTION 'AI drafting or analysis data exists; 0057 cannot be rolled back' USING ERRCODE = 'P0001';
  END IF;
END $$;
ALTER TABLE ai.change_proposal FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.proposed_change FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_context_ref FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_action FORCE ROW LEVEL SECURITY;

ALTER TABLE ai.change_proposal
  DROP CONSTRAINT change_proposal_content_shape,
  DROP CONSTRAINT change_proposal_assumptions,
  DROP COLUMN assumptions,
  ADD CONSTRAINT change_proposal_content_shape CHECK (
    (content_state = 'present' AND content_erased_at IS NULL)
    OR (content_state = 'erased' AND content_erased_at IS NOT NULL AND title IS NULL AND reject_reason IS NULL));

ALTER TABLE ai.proposed_change
  DROP CONSTRAINT proposed_change_op,
  ADD CONSTRAINT proposed_change_op CHECK (op IN ('task.create', 'task.update', 'project.create', 'project.update',
    'milestone.create', 'relation.add', 'document.replace'));

ALTER TABLE ai.ai_context_ref
  DROP CONSTRAINT ai_context_ref_type,
  DROP CONSTRAINT ai_context_ref_public_id,
  ADD CONSTRAINT ai_context_ref_type CHECK (record_type IN ('task', 'project', 'document', 'comment', 'activity')),
  ADD CONSTRAINT ai_context_ref_public_id CHECK (record_public_id ~ '^(tsk|prj|doc|cmt)_[0-9A-HJKMNP-TV-Z]{26}$'
    AND (record_type <> 'activity' OR record_public_id ~ '^tsk_'));

ALTER TABLE ai.ai_action
  DROP CONSTRAINT ai_action_choice_refs,
  DROP CONSTRAINT ai_action_key,
  DROP CONSTRAINT ai_action_retrieval_shape,
  DROP CONSTRAINT ai_action_purpose,
  DROP COLUMN choice_refs,
  DROP COLUMN input_digest,
  DROP COLUMN action_key,
  ADD CONSTRAINT ai_action_purpose CHECK (purpose IN ('test_run', 'grounded_answer', 'change_proposal')),
  ADD CONSTRAINT ai_action_retrieval_shape CHECK (
    (purpose IN ('grounded_answer', 'change_proposal')) = (retrieval_scope IS NOT NULL)
    AND (retrieval_scope IS NULL) = (manifest_digest IS NULL)
    AND (retrieval_scope IS NULL OR (jsonb_typeof(retrieval_scope) = 'object'
      AND pg_column_size(retrieval_scope) <= 4096))
    AND (manifest_digest IS NULL OR manifest_digest ~ '^[0-9a-f]{64}$'));
