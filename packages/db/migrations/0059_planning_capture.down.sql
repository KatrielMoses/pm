-- migrate:phase contract
-- Restores the exact 0058 catalog. Voice captures, transcription actions, planner proposals, the
-- planning operations, plan blocks, and plan evidence cannot be represented in 0058, so the
-- rollback refuses while any exists (forced row-level security is lifted for that one check).
-- Business records are not affected.
ALTER TABLE ai.ai_action NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.change_proposal NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.proposed_change NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.briefing_evidence NO FORCE ROW LEVEL SECURITY;
ALTER TABLE planning.work_block NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capture.voice_capture NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM capture.voice_capture)
     OR EXISTS (SELECT 1 FROM ai.ai_action WHERE purpose = 'transcription')
     OR EXISTS (SELECT 1 FROM ai.change_proposal WHERE origin = 'planner')
     OR EXISTS (SELECT 1 FROM ai.proposed_change WHERE op IN ('block.create', 'block.update', 'block.delete',
       'commitment.add', 'commitment.remove') OR target_public_id LIKE 'blk\_%')
     OR EXISTS (SELECT 1 FROM ai.briefing_evidence WHERE proposal_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM planning.work_block WHERE source = 'plan') THEN
    RAISE EXCEPTION 'planning or voice capture data exists; 0059 cannot be rolled back' USING ERRCODE = 'P0001';
  END IF;
END $$;
ALTER TABLE capture.voice_capture FORCE ROW LEVEL SECURITY;
ALTER TABLE planning.work_block FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.briefing_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.proposed_change FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.change_proposal FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_action FORCE ROW LEVEL SECURITY;

DROP FUNCTION exec_dispatch.discover_plan_retention_work(timestamptz, integer);
REVOKE SELECT (workspace_id, origin, content_state, created_at) ON ai.change_proposal FROM pm_scheduler;
DROP POLICY scheduler_discovery ON ai.change_proposal;
DROP FUNCTION exec_dispatch.discover_voice_cleanup_work(timestamptz, integer);
DROP TABLE capture.voice_capture;

DROP INDEX ai.briefing_evidence_by_proposal;
ALTER TABLE ai.briefing_evidence
  DROP CONSTRAINT briefing_evidence_owner,
  DROP CONSTRAINT briefing_evidence_proposal_fkey,
  DROP COLUMN proposal_id,
  ADD CONSTRAINT briefing_evidence_owner CHECK ((briefing_id IS NULL) <> (correction_id IS NULL)
    AND (briefing_id IS NULL OR position BETWEEN 0 AND 999) AND (correction_id IS NULL OR position IS NULL));

ALTER TABLE planning.work_block
  DROP CONSTRAINT work_block_source_known,
  ADD CONSTRAINT work_block_source_known CHECK (source IN ('manual', 'estimate', 'recurrence'));

ALTER TABLE ai.proposed_change
  DROP CONSTRAINT proposed_change_op,
  ADD CONSTRAINT proposed_change_op CHECK (op IN ('task.create', 'task.update', 'project.create', 'project.update',
    'milestone.create', 'relation.add', 'document.replace', 'task.assign', 'label.add', 'criterion.add')),
  DROP CONSTRAINT proposed_change_target,
  ADD CONSTRAINT proposed_change_target CHECK ((target_record_id IS NULL) = (target_public_id IS NULL)
    AND (target_public_id IS NULL OR target_public_id ~ '^(tsk|prj|doc)_[0-9A-HJKMNP-TV-Z]{26}$'));

DROP TRIGGER change_proposal_origin_guard ON ai.change_proposal;
DROP FUNCTION ai.change_proposal_origin_guard();
ALTER TABLE ai.change_proposal
  DROP CONSTRAINT change_proposal_content_shape,
  DROP CONSTRAINT change_proposal_plan,
  DROP CONSTRAINT change_proposal_origin,
  DROP CONSTRAINT change_proposal_operation_fkey,
  DROP COLUMN plan,
  DROP COLUMN origin,
  ADD CONSTRAINT change_proposal_action_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES ai.ai_action (workspace_id, operation_id) ON DELETE RESTRICT,
  ADD CONSTRAINT change_proposal_content_shape CHECK (
    (content_state = 'present' AND content_erased_at IS NULL)
    OR (content_state = 'erased' AND content_erased_at IS NOT NULL AND title IS NULL AND reject_reason IS NULL
      AND assumptions IS NULL));

ALTER TABLE ai.ai_action
  DROP CONSTRAINT ai_action_purpose,
  ADD CONSTRAINT ai_action_purpose CHECK (purpose IN ('test_run', 'grounded_answer', 'change_proposal', 'analysis'));
