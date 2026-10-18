-- migrate:phase expand
-- Phase 7F AI-assisted planning and capture (0B ADR-50, ADR-0043). Builds on 0053–0058; no earlier
-- file changes.
--   * Voice capture: an ephemeral audio upload (referenced by storage key until it is transcribed,
--     cancelled, failed, or expired) and a transcription action purpose. The transcript is AI
--     content (ai.ai_output), never stored here.
--   * Daily plans: change proposals of origin `planner` (a deterministic server planner, not a
--     model) on an exec operation of kind `plan_proposal`, five planning operations that run the
--     canonical 3C commands, a `plan` block source, and the plan's protected evidence basis.

-- ---------------------------------------------------------------------------------------------
-- Transcription is a purpose of the one AI action (budget, dispatch, history, erasure). It has no
-- retrieval scope and no action key; its output is the transcript.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.ai_action
  DROP CONSTRAINT ai_action_purpose,
  ADD CONSTRAINT ai_action_purpose CHECK (purpose IN ('test_run', 'grounded_answer', 'change_proposal', 'analysis',
    'transcription'));

-- ---------------------------------------------------------------------------------------------
-- Planner-origin proposals. An AI proposal still needs its AI action (now a guard trigger, since
-- a planner proposal has none); both reference their exec operation.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.change_proposal
  ADD COLUMN origin text NOT NULL DEFAULT 'ai_action',
  ADD COLUMN plan jsonb,
  DROP CONSTRAINT change_proposal_action_fkey,
  ADD CONSTRAINT change_proposal_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT change_proposal_origin CHECK (origin IN ('ai_action', 'planner')),
  ADD CONSTRAINT change_proposal_plan CHECK (
    ((origin = 'ai_action' AND plan IS NULL) OR (origin = 'planner' AND (plan IS NOT NULL OR content_state = 'erased')))
    AND (plan IS NULL OR (jsonb_typeof(plan) = 'object' AND pg_column_size(plan) <= 32768))),
  DROP CONSTRAINT change_proposal_content_shape,
  ADD CONSTRAINT change_proposal_content_shape CHECK (
    (content_state = 'present' AND content_erased_at IS NULL)
    OR (content_state = 'erased' AND content_erased_at IS NOT NULL AND title IS NULL AND reject_reason IS NULL
      AND assumptions IS NULL AND plan IS NULL));

CREATE FUNCTION ai.change_proposal_origin_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.origin = 'ai_action' AND NOT EXISTS (
       SELECT 1 FROM ai.ai_action a WHERE a.workspace_id = NEW.workspace_id AND a.operation_id = NEW.operation_id) THEN
    RAISE EXCEPTION 'an AI change proposal needs its AI action' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.origin = 'planner' AND NOT EXISTS (
       SELECT 1 FROM exec.operation o
        WHERE o.workspace_id = NEW.workspace_id AND o.id = NEW.operation_id AND o.kind = 'plan_proposal') THEN
    RAISE EXCEPTION 'a planner proposal needs its plan_proposal operation' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER change_proposal_origin_guard BEFORE INSERT OR UPDATE OF origin, operation_id ON ai.change_proposal
  FOR EACH ROW EXECUTE FUNCTION ai.change_proposal_origin_guard();

-- ---------------------------------------------------------------------------------------------
-- Planning operations: create, move, or remove an unlocked work block; add or remove a Today
-- commitment. Each runs the canonical 3C command at Apply. Blocks are targeted by `blk_` ids.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.proposed_change
  DROP CONSTRAINT proposed_change_op,
  ADD CONSTRAINT proposed_change_op CHECK (op IN ('task.create', 'task.update', 'project.create', 'project.update',
    'milestone.create', 'relation.add', 'document.replace', 'task.assign', 'label.add', 'criterion.add',
    'block.create', 'block.update', 'block.delete', 'commitment.add', 'commitment.remove')),
  DROP CONSTRAINT proposed_change_target,
  ADD CONSTRAINT proposed_change_target CHECK ((target_record_id IS NULL) = (target_public_id IS NULL)
    AND (target_public_id IS NULL OR target_public_id ~ '^(tsk|prj|doc|blk)_[0-9A-HJKMNP-TV-Z]{26}$'));

ALTER TABLE planning.work_block
  DROP CONSTRAINT work_block_source_known,
  ADD CONSTRAINT work_block_source_known CHECK (source IN ('manual', 'estimate', 'recurrence', 'plan'));

-- ---------------------------------------------------------------------------------------------
-- The plan's complete authorization basis reuses the 7E evidence store (references only).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.briefing_evidence
  ADD COLUMN proposal_id uuid,
  ADD CONSTRAINT briefing_evidence_proposal_fkey FOREIGN KEY (workspace_id, proposal_id)
    REFERENCES ai.change_proposal (workspace_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT briefing_evidence_owner,
  ADD CONSTRAINT briefing_evidence_owner CHECK (
    num_nonnulls(briefing_id, correction_id, proposal_id) = 1
    AND (briefing_id IS NULL OR position BETWEEN 0 AND 999)
    AND (briefing_id IS NOT NULL OR position IS NULL));
CREATE INDEX briefing_evidence_by_proposal ON ai.briefing_evidence (workspace_id, proposal_id);

-- ---------------------------------------------------------------------------------------------
-- Voice capture: one bounded upload, ephemeral by default. The audio object exists only while
-- `storage_key` is set; it is deleted after transcription, cancellation, failure, or expiry.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE capture.voice_capture (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  public_id text NOT NULL,
  membership_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'uploaded',
  format text NOT NULL,
  byte_size integer NOT NULL,
  duration_ms integer NOT NULL,
  content_sha256 text NOT NULL,
  storage_key text,
  operation_id uuid,
  inbox_item_id uuid,
  failure_code text,
  expires_at timestamptz NOT NULL,
  discarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT voice_capture_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT voice_capture_public_id_unique UNIQUE (public_id),
  CONSTRAINT voice_capture_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT voice_capture_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT voice_capture_inbox_fkey FOREIGN KEY (workspace_id, inbox_item_id)
    REFERENCES capture.inbox_item (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT voice_capture_public_id CHECK (public_id ~ '^vcp_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT voice_capture_state CHECK (state IN ('uploaded', 'transcribing', 'transcribed', 'failed', 'cancelled',
    'expired', 'saved')),
  CONSTRAINT voice_capture_format CHECK (format IN ('audio/wav', 'audio/webm', 'audio/ogg')),
  CONSTRAINT voice_capture_bytes CHECK (byte_size BETWEEN 44 AND 104857600),
  CONSTRAINT voice_capture_duration CHECK (duration_ms BETWEEN 1 AND 3600000),
  CONSTRAINT voice_capture_sha CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT voice_capture_storage CHECK (storage_key IS NULL OR storage_key ~ '^voice/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  -- Audio is kept only before a terminal outcome; a terminal capture holds no object.
  CONSTRAINT voice_capture_ephemeral CHECK (state IN ('uploaded', 'transcribing') OR storage_key IS NULL),
  CONSTRAINT voice_capture_saved CHECK ((state = 'saved') = (inbox_item_id IS NOT NULL)),
  CONSTRAINT voice_capture_failure CHECK ((state = 'failed') = (failure_code IS NOT NULL)
    AND (failure_code IS NULL OR failure_code ~ '^[a-z_]{1,64}$'))
);
CREATE INDEX voice_capture_by_member ON capture.voice_capture (workspace_id, membership_id, created_at DESC);
CREATE INDEX voice_capture_live ON capture.voice_capture (workspace_id, expires_at) WHERE storage_key IS NOT NULL;
CREATE INDEX voice_capture_by_operation ON capture.voice_capture (workspace_id, operation_id);
CREATE INDEX voice_capture_by_inbox ON capture.voice_capture (workspace_id, inbox_item_id);

ALTER TABLE capture.voice_capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture.voice_capture FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON capture.voice_capture
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
GRANT SELECT, INSERT, UPDATE ON capture.voice_capture TO app_rw, app_worker;

-- Discovery for the voice cleanup sweep: workspaces holding audio past its expiry (ids only).
CREATE POLICY scheduler_discovery ON capture.voice_capture FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, storage_key, expires_at) ON capture.voice_capture TO pm_scheduler;
CREATE FUNCTION exec_dispatch.discover_voice_cleanup_work(p_now timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT v.workspace_id FROM capture.voice_capture v
   WHERE v.storage_key IS NOT NULL AND v.expires_at <= p_now
   GROUP BY v.workspace_id
   ORDER BY min(v.expires_at), v.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_voice_cleanup_work(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_voice_cleanup_work(timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_voice_cleanup_work(timestamptz, integer) OWNER TO pm_scheduler;

-- Discovery for configured technical retention of planner proposals (they have no AI action, so
-- the AI-run discovery cannot find them). Ids only.
CREATE POLICY scheduler_discovery ON ai.change_proposal FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, origin, content_state, created_at) ON ai.change_proposal TO pm_scheduler;
CREATE FUNCTION exec_dispatch.discover_plan_retention_work(p_before timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT c.workspace_id FROM ai.change_proposal c
   WHERE c.origin = 'planner' AND c.content_state = 'present' AND c.created_at < p_before
   GROUP BY c.workspace_id
   ORDER BY min(c.created_at), c.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_plan_retention_work(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_plan_retention_work(timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_plan_retention_work(timestamptz, integer) OWNER TO pm_scheduler;
