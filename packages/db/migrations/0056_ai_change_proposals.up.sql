-- migrate:phase expand
-- Phase 7D change proposal protocol (0B ADR-47, ADR-0040). An AI action may produce a typed,
-- versioned change proposal. Reviewing, editing, selecting, approving, and applying it are separate
-- human steps; applying runs the ordinary domain commands in one transaction. Proposal content is
-- AI content: it lives only in these tables, renders through current authorization, and is erased
-- with the rest of the run. Builds on 0053–0055; no earlier file changes.

-- ---------------------------------------------------------------------------------------------
-- A change proposal is a third purpose of the one AI action (like a grounded answer, it records
-- its retrieval scope and confirmed manifest).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.ai_action
  DROP CONSTRAINT ai_action_purpose,
  DROP CONSTRAINT ai_action_retrieval_shape,
  ADD CONSTRAINT ai_action_purpose CHECK (purpose IN ('test_run', 'grounded_answer', 'change_proposal')),
  ADD CONSTRAINT ai_action_retrieval_shape CHECK (
    (purpose IN ('grounded_answer', 'change_proposal')) = (retrieval_scope IS NOT NULL)
    AND (retrieval_scope IS NULL) = (manifest_digest IS NULL)
    AND (retrieval_scope IS NULL OR (jsonb_typeof(retrieval_scope) = 'object'
      AND pg_column_size(retrieval_scope) <= 4096))
    AND (manifest_digest IS NULL OR manifest_digest ~ '^[0-9a-f]{64}$'));

-- ---------------------------------------------------------------------------------------------
-- The proposal (one per generating action). Its revision increases with every edit or selection
-- change; the fingerprint binds the current revision's content and selection.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.change_proposal (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  public_id text NOT NULL,
  operation_id uuid NOT NULL,
  initiating_membership_id uuid NOT NULL,
  schema_version text NOT NULL DEFAULT 'change_proposal.v1',
  state text NOT NULL DEFAULT 'open',
  revision integer NOT NULL DEFAULT 1,
  fingerprint text NOT NULL,
  title text,
  reject_reason text,
  content_state text NOT NULL DEFAULT 'present',
  content_erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT change_proposal_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT change_proposal_public_id_unique UNIQUE (public_id),
  CONSTRAINT change_proposal_one_per_action UNIQUE (workspace_id, operation_id),
  CONSTRAINT change_proposal_action_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES ai.ai_action (workspace_id, operation_id) ON DELETE RESTRICT,
  CONSTRAINT change_proposal_member_fkey FOREIGN KEY (workspace_id, initiating_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT change_proposal_public_id CHECK (public_id ~ '^prp_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT change_proposal_schema CHECK (schema_version = 'change_proposal.v1'),
  CONSTRAINT change_proposal_state CHECK (state IN ('open', 'approved', 'applied', 'failed', 'rejected')),
  CONSTRAINT change_proposal_revision CHECK (revision BETWEEN 1 AND 1000),
  CONSTRAINT change_proposal_fingerprint CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT change_proposal_title CHECK (tenancy.valid_plain_text(title, 300)),
  CONSTRAINT change_proposal_reason CHECK (tenancy.valid_plain_text(reject_reason, 500)),
  CONSTRAINT change_proposal_content_state CHECK (content_state IN ('present', 'erased')),
  CONSTRAINT change_proposal_content_shape CHECK (
    (content_state = 'present' AND content_erased_at IS NULL)
    OR (content_state = 'erased' AND content_erased_at IS NOT NULL AND title IS NULL AND reject_reason IS NULL))
);
CREATE INDEX change_proposal_by_member ON ai.change_proposal (workspace_id, initiating_membership_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- One typed change. Targets are references (no foreign key: a purged record leaves a tombstone);
-- the proposed values (`payload`) are content and are erased with the proposal.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.proposed_change (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL,
  change_key text NOT NULL,
  position smallint NOT NULL,
  op text NOT NULL,
  temp_ref text,
  target_record_id uuid,
  target_public_id text,
  expected_version bigint,
  depends_on text[] NOT NULL DEFAULT '{}',
  payload jsonb,
  sources text[] NOT NULL DEFAULT '{}',
  selected boolean NOT NULL DEFAULT true,
  decision text NOT NULL DEFAULT 'pending',
  applied_state text NOT NULL DEFAULT 'not_applied',
  result_record_id uuid,
  result_public_id text,
  failure_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposed_change_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT proposed_change_key_unique UNIQUE (proposal_id, change_key),
  CONSTRAINT proposed_change_position_unique UNIQUE (proposal_id, position),
  CONSTRAINT proposed_change_proposal_fkey FOREIGN KEY (workspace_id, proposal_id)
    REFERENCES ai.change_proposal (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT proposed_change_key CHECK (change_key ~ '^c[0-9]{1,3}$'),
  CONSTRAINT proposed_change_position CHECK (position BETWEEN 0 AND 99),
  CONSTRAINT proposed_change_op CHECK (op IN ('task.create', 'task.update', 'project.create', 'project.update',
    'milestone.create', 'relation.add', 'document.replace')),
  CONSTRAINT proposed_change_temp_ref CHECK (temp_ref IS NULL OR temp_ref ~ '^[a-z][a-z0-9_]{0,15}$'),
  CONSTRAINT proposed_change_target CHECK ((target_record_id IS NULL) = (target_public_id IS NULL)
    AND (target_public_id IS NULL OR target_public_id ~ '^(tsk|prj|doc)_[0-9A-HJKMNP-TV-Z]{26}$')),
  CONSTRAINT proposed_change_expected_version CHECK (expected_version IS NULL OR expected_version >= 0),
  CONSTRAINT proposed_change_depends CHECK (cardinality(depends_on) <= 99 AND cardinality(sources) <= 20),
  CONSTRAINT proposed_change_payload CHECK (payload IS NULL
    OR (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 32768)),
  CONSTRAINT proposed_change_decision CHECK (decision IN ('pending', 'accepted', 'edited', 'rejected')),
  CONSTRAINT proposed_change_applied CHECK (applied_state IN ('not_applied', 'applied', 'failed', 'rolled_back', 'blocked')),
  CONSTRAINT proposed_change_result CHECK ((result_record_id IS NULL) = (result_public_id IS NULL)
    AND (result_record_id IS NULL OR applied_state = 'applied')),
  CONSTRAINT proposed_change_failure CHECK (failure_code IS NULL OR failure_code ~ '^[a-z_]{1,64}$')
);
CREATE INDEX proposed_change_by_proposal ON ai.proposed_change (workspace_id, proposal_id, position);

-- ---------------------------------------------------------------------------------------------
-- Revision and decision history: references and bounded facts only (never content).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.proposal_event (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL,
  revision integer NOT NULL,
  kind text NOT NULL,
  actor_membership_id uuid,
  change_keys text[] NOT NULL DEFAULT '{}',
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_event_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT proposal_event_proposal_fkey FOREIGN KEY (workspace_id, proposal_id)
    REFERENCES ai.change_proposal (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT proposal_event_kind CHECK (kind IN ('generated', 'edited', 'approved', 'approval_superseded',
    'rejected', 'applied', 'apply_failed', 'erased')),
  CONSTRAINT proposal_event_keys CHECK (cardinality(change_keys) <= 100),
  CONSTRAINT proposal_event_fingerprint CHECK (fingerprint ~ '^[0-9a-f]{64}$')
);
CREATE INDEX proposal_event_by_proposal ON ai.proposal_event (workspace_id, proposal_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Approval binds the approver, the exact revision, the selected changes, the content fingerprint,
-- the target versions, the effective scope (the run's scope references and the approver's
-- permission epochs), and the risk class and step-up requirement, for a bounded time. It is used
-- once (by one apply attempt). It is never an access grant.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.proposal_approval (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL,
  revision integer NOT NULL,
  approver_membership_id uuid NOT NULL,
  selected text[] NOT NULL,
  fingerprint text NOT NULL,
  target_versions jsonb NOT NULL,
  scope jsonb NOT NULL,
  risk_class text NOT NULL DEFAULT 'R1',
  step_up_required boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  CONSTRAINT proposal_approval_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT proposal_approval_proposal_fkey FOREIGN KEY (workspace_id, proposal_id)
    REFERENCES ai.change_proposal (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT proposal_approval_member_fkey FOREIGN KEY (workspace_id, approver_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT proposal_approval_state CHECK (state IN ('active', 'used', 'superseded', 'expired', 'revoked')),
  CONSTRAINT proposal_approval_selected CHECK (cardinality(selected) BETWEEN 1 AND 100),
  CONSTRAINT proposal_approval_fingerprint CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT proposal_approval_targets CHECK (jsonb_typeof(target_versions) = 'object'
    AND pg_column_size(target_versions) <= 8192),
  CONSTRAINT proposal_approval_scope CHECK (jsonb_typeof(scope) = 'object'
    AND pg_column_size(scope) <= 4096),
  CONSTRAINT proposal_approval_risk CHECK (risk_class IN ('R1', 'R2', 'R3', 'R4')),
  CONSTRAINT proposal_approval_used CHECK ((state = 'used') = (used_at IS NOT NULL)),
  CONSTRAINT proposal_approval_window CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX proposal_approval_one_active ON ai.proposal_approval (workspace_id, proposal_id)
  WHERE state = 'active';

-- ---------------------------------------------------------------------------------------------
-- Each apply attempt: its `proposal_apply` operation, the approval it used, and the outcome per
-- change (references and codes only). It outlives erasure of the proposal's content.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.proposal_application (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  revision integer NOT NULL,
  outcome text NOT NULL,
  applied_count integer NOT NULL,
  failed_count integer NOT NULL,
  results jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_application_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT proposal_application_operation_unique UNIQUE (workspace_id, operation_id),
  CONSTRAINT proposal_application_approval_unique UNIQUE (workspace_id, approval_id),
  CONSTRAINT proposal_application_proposal_fkey FOREIGN KEY (workspace_id, proposal_id)
    REFERENCES ai.change_proposal (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT proposal_application_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT proposal_application_approval_fkey FOREIGN KEY (workspace_id, approval_id)
    REFERENCES ai.proposal_approval (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT proposal_application_outcome CHECK (outcome IN ('applied', 'failed')),
  CONSTRAINT proposal_application_counts CHECK (applied_count >= 0 AND failed_count >= 0
    AND ((outcome = 'applied') = (failed_count = 0))),
  CONSTRAINT proposal_application_results CHECK (jsonb_typeof(results) = 'array'
    AND pg_column_size(results) <= 32768)
);
CREATE INDEX proposal_application_by_proposal ON ai.proposal_application (workspace_id, proposal_id);

-- ---------------------------------------------------------------------------------------------
-- Tenant isolation and grants. The API role reviews, edits, approves, and applies; the worker
-- creates proposals from completed runs and erases them (departure, retention).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.change_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.change_proposal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.change_proposal
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.proposed_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.proposed_change FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.proposed_change
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.proposal_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.proposal_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.proposal_event
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.proposal_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.proposal_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.proposal_approval
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.proposal_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.proposal_application FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.proposal_application
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON ai.change_proposal, ai.proposed_change, ai.proposal_approval TO app_rw, app_worker;
GRANT SELECT, INSERT ON ai.proposal_event, ai.proposal_application TO app_rw, app_worker;
