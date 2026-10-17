-- migrate:phase expand
-- Phase 7C AI drafting and analysis (0B ADR-48, ADR-0041). Typed actions run through the one AI
-- action: analysis actions are a fourth purpose whose validated result is stored like a grounded
-- answer; drafting actions are change proposals (7D) with an action key. Goals and the caller's own
-- calendar events become manifest source kinds. Three proposal operations are added for
-- assignment, labels, and acceptance criteria, and a proposal may carry visible assumptions.
-- Builds on 0053–0056; no earlier file changes.

-- ---------------------------------------------------------------------------------------------
-- The action: purpose `analysis`, the versioned action key, the server-computed digest of the
-- exact action input the person confirmed, and the server-issued choice handles (labels and
-- members, references only) a drafting action could name.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.ai_action
  ADD COLUMN action_key text,
  ADD COLUMN input_digest text,
  ADD COLUMN choice_refs jsonb,
  DROP CONSTRAINT ai_action_purpose,
  DROP CONSTRAINT ai_action_retrieval_shape,
  ADD CONSTRAINT ai_action_purpose CHECK (purpose IN ('test_run', 'grounded_answer', 'change_proposal', 'analysis')),
  ADD CONSTRAINT ai_action_retrieval_shape CHECK (
    (purpose IN ('grounded_answer', 'change_proposal', 'analysis')) = (retrieval_scope IS NOT NULL)
    AND (retrieval_scope IS NULL) = (manifest_digest IS NULL)
    AND (retrieval_scope IS NULL OR (jsonb_typeof(retrieval_scope) = 'object'
      AND pg_column_size(retrieval_scope) <= 4096))
    AND (manifest_digest IS NULL OR manifest_digest ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT ai_action_key CHECK (
    (action_key IS NULL OR (action_key ~ '^[a-z_]{2,40}\.v[0-9]{1,3}$' AND purpose IN ('analysis', 'change_proposal')))
    AND (purpose <> 'analysis' OR action_key IS NOT NULL)
    AND (action_key IS NULL) = (input_digest IS NULL)
    AND (input_digest IS NULL OR input_digest ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT ai_action_choice_refs CHECK (choice_refs IS NULL OR (action_key IS NOT NULL
    AND jsonb_typeof(choice_refs) = 'object' AND pg_column_size(choice_refs) <= 8192));

-- ---------------------------------------------------------------------------------------------
-- Manifest entries: goals (5B) and the caller's own calendar events (6C), by public reference.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.ai_context_ref
  DROP CONSTRAINT ai_context_ref_type,
  DROP CONSTRAINT ai_context_ref_public_id,
  ADD CONSTRAINT ai_context_ref_type CHECK (record_type IN ('task', 'project', 'document', 'comment', 'activity', 'goal', 'meeting')),
  ADD CONSTRAINT ai_context_ref_public_id CHECK (record_public_id ~ '^(tsk|prj|doc|cmt|goal|cev)_[0-9A-HJKMNP-TV-Z]{26}$'
    AND (record_type <> 'activity' OR record_public_id ~ '^tsk_')
    AND (record_type <> 'goal' OR record_public_id ~ '^goal_')
    AND (record_type <> 'meeting' OR record_public_id ~ '^cev_'));

-- ---------------------------------------------------------------------------------------------
-- Proposal operations for assignment, labels, and acceptance criteria; visible assumptions.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.proposed_change
  DROP CONSTRAINT proposed_change_op,
  ADD CONSTRAINT proposed_change_op CHECK (op IN ('task.create', 'task.update', 'project.create', 'project.update',
    'milestone.create', 'relation.add', 'document.replace', 'task.assign', 'label.add', 'criterion.add'));

ALTER TABLE ai.change_proposal
  ADD COLUMN assumptions text[],
  DROP CONSTRAINT change_proposal_content_shape,
  ADD CONSTRAINT change_proposal_assumptions CHECK (assumptions IS NULL
    OR (cardinality(assumptions) <= 20 AND pg_column_size(assumptions) <= 16384)),
  ADD CONSTRAINT change_proposal_content_shape CHECK (
    (content_state = 'present' AND content_erased_at IS NULL)
    OR (content_state = 'erased' AND content_erased_at IS NOT NULL AND title IS NULL AND reject_reason IS NULL
      AND assumptions IS NULL));
