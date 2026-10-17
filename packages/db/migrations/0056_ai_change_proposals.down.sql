-- migrate:phase contract
-- Restores the exact 0055 catalog. Change proposals cannot be represented in 0055, so the rollback
-- refuses while any proposal or change-proposal action exists. Applied business records are not
-- affected by this rollback; they were written by the ordinary domain commands.
ALTER TABLE ai.ai_action NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.change_proposal NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai.change_proposal) OR EXISTS (SELECT 1 FROM ai.ai_action WHERE purpose = 'change_proposal') THEN
    RAISE EXCEPTION 'change proposals exist; 0056 cannot be rolled back' USING ERRCODE = 'P0001';
  END IF;
END $$;
ALTER TABLE ai.change_proposal FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_action FORCE ROW LEVEL SECURITY;

DROP TABLE ai.proposal_application;
DROP TABLE ai.proposal_approval;
DROP TABLE ai.proposal_event;
DROP TABLE ai.proposed_change;
DROP TABLE ai.change_proposal;

ALTER TABLE ai.ai_action
  DROP CONSTRAINT ai_action_retrieval_shape,
  DROP CONSTRAINT ai_action_purpose,
  ADD CONSTRAINT ai_action_purpose CHECK (purpose IN ('test_run', 'grounded_answer')),
  ADD CONSTRAINT ai_action_retrieval_shape CHECK (
    (purpose = 'grounded_answer') = (retrieval_scope IS NOT NULL)
    AND (retrieval_scope IS NULL) = (manifest_digest IS NULL)
    AND (retrieval_scope IS NULL OR (jsonb_typeof(retrieval_scope) = 'object'
      AND pg_column_size(retrieval_scope) <= 4096))
    AND (manifest_digest IS NULL OR manifest_digest ~ '^[0-9a-f]{64}$'));
