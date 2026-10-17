-- migrate:phase expand
-- Phase 7B authorized retrieval and citations (0B ADR-46, ADR-0039). A grounded answer is a new
-- purpose of the one 7A AI action: its retrieval scope and context manifest are recorded as
-- references, and its validated, typed answer is stored with the output it was derived from.
-- Builds on 0053 and 0054; no earlier file changes.

-- ---------------------------------------------------------------------------------------------
-- Actions: the grounded-answer purpose, its explicit scope (public references only), and the
-- digest of the context manifest the person saw and confirmed.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.ai_action
  DROP CONSTRAINT ai_action_purpose,
  ADD COLUMN retrieval_scope jsonb,
  ADD COLUMN manifest_digest text,
  ADD CONSTRAINT ai_action_purpose CHECK (purpose IN ('test_run', 'grounded_answer')),
  ADD CONSTRAINT ai_action_retrieval_shape CHECK (
    (purpose = 'grounded_answer') = (retrieval_scope IS NOT NULL)
    AND (retrieval_scope IS NULL) = (manifest_digest IS NULL)
    AND (retrieval_scope IS NULL OR (jsonb_typeof(retrieval_scope) = 'object'
      AND pg_column_size(retrieval_scope) <= 4096))
    AND (manifest_digest IS NULL OR manifest_digest ~ '^[0-9a-f]{64}$'));

-- ---------------------------------------------------------------------------------------------
-- Context manifest entries. Each entry is a reference: the source kind and public identifier,
-- the version and a hash of exactly what was sent, its suitability flags, how it was selected,
-- and, for included sources, the server-issued citation handle (S1..S20). No source text is
-- stored here; content is re-read through current authority whenever it is needed.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.ai_context_ref
  DROP CONSTRAINT ai_context_ref_type,
  DROP CONSTRAINT ai_context_ref_public_id,
  DROP CONSTRAINT ai_context_ref_exclusion,
  ADD COLUMN handle text,
  ADD COLUMN content_hash text,
  ADD COLUMN source_version text,
  ADD COLUMN source_flags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN selection text NOT NULL DEFAULT 'explicit',
  ADD CONSTRAINT ai_context_ref_type CHECK (record_type IN ('task', 'project', 'document', 'comment', 'activity')),
  ADD CONSTRAINT ai_context_ref_public_id CHECK (record_public_id ~ '^(tsk|prj|doc|cmt)_[0-9A-HJKMNP-TV-Z]{26}$'
    AND (record_type <> 'activity' OR record_public_id ~ '^tsk_')),
  ADD CONSTRAINT ai_context_ref_exclusion CHECK ((included) = (exclusion_reason IS NULL)
    AND (exclusion_reason IS NULL OR exclusion_reason IN ('field_not_ai_eligible', 'data_class', 'sensitive_brand',
      'out_of_scope', 'user_excluded', 'needs_explicit_choice', 'brand_only_policy', 'over_limit'))),
  ADD CONSTRAINT ai_context_ref_handle CHECK (handle IS NULL OR (included AND handle ~ '^S([1-9]|1[0-9]|20)$')),
  ADD CONSTRAINT ai_context_ref_hash CHECK (content_hash IS NULL OR (included AND content_hash ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT ai_context_ref_source_version CHECK (source_version IS NULL OR char_length(source_version) BETWEEN 1 AND 80),
  ADD CONSTRAINT ai_context_ref_flags CHECK (cardinality(source_flags) <= 8 AND source_flags <@ ARRAY[
    'stale', 'draft', 'unapproved', 'approved_version_differs', 'archived', 'truncated']::text[]),
  ADD CONSTRAINT ai_context_ref_selection CHECK (selection IN ('explicit', 'scope', 'search')),
  ADD CONSTRAINT ai_context_ref_one_handle UNIQUE (operation_id, handle);

-- ---------------------------------------------------------------------------------------------
-- Outputs: the validated, typed answer (statements by kind, citations checked against the
-- manifest, and the validation result). It is content: immutable, and erased with the output.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.ai_output
  ADD COLUMN grounding jsonb,
  ADD CONSTRAINT ai_output_grounding CHECK (
    (grounding IS NULL OR (jsonb_typeof(grounding) = 'object' AND pg_column_size(grounding) <= 262144))
    AND (completeness <> 'erased' OR grounding IS NULL));

CREATE OR REPLACE FUNCTION ai.output_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.operation_id <> OLD.operation_id
     OR NEW.dispatch_id <> OLD.dispatch_id OR NEW.created_at <> OLD.created_at
     OR NEW.completeness <> 'erased' OR NEW.content IS NOT NULL OR NEW.grounding IS NOT NULL THEN
    RAISE EXCEPTION 'AI output is immutable except erasure' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
