-- migrate:phase expand
-- Phase 8B agent profiles, connectors, and scoped task assignments (0B ADR-52, 0C AZ-52, 0D PL-54,
-- UXD-33, ADR-0047). Reconciles the 0B `agents` entities that configure and assign agents; it
-- creates no run, tool call, artifact, action approval, or emergency stop (8C, 8D). Builds on
-- 0001–0063; no earlier file changes.
--
-- Authorization dimensions are relational and immutable per profile revision: scope grants
-- (brands, projects, records, integrations) and tool grants (registered tool, version, class,
-- approval class). An assignment pins a profile revision and stores its own immutable revisions:
-- the goal, criteria, the explicitly chosen context references, and the resolved scope ceiling.
-- No content of a task, document, or file is copied; no secret is stored (connector secrets are
-- secret-store references).

CREATE SCHEMA agents;
REVOKE ALL ON SCHEMA agents FROM PUBLIC;
GRANT USAGE ON SCHEMA agents TO app_rw, app_worker;

-- ---------------------------------------------------------------------------------------------
-- The agent profile (core.record extension, prefix `agt`, workspace scope). An agent is never a
-- membership or an account: it acts only through the accountable owner's and the assigner's
-- current authority (0C §9.3). The draft is the editable form; revisions are immutable.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE agents.agent_profile (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  kind text NOT NULL,
  name text NOT NULL,
  purpose text,
  owner_membership_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'draft',
  active_revision_id uuid,
  activated_at timestamptz,
  draft jsonb NOT NULL,
  draft_base_revision integer,
  template_key text,
  duplicated_from_id uuid,
  suspended_reason text,
  suspended_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  updated_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT agent_profile_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_profile_scope_key UNIQUE (workspace_id, scope_key, id),
  CONSTRAINT agent_profile_scope_shape CHECK (scope_key = workspace_id),
  CONSTRAINT agent_profile_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT agent_profile_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_profile_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_profile_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_profile_duplicated_fkey FOREIGN KEY (workspace_id, duplicated_from_id)
    REFERENCES agents.agent_profile (workspace_id, id) ON DELETE SET NULL (duplicated_from_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT agent_profile_kind CHECK (kind IN ('internal', 'external')),
  CONSTRAINT agent_profile_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT agent_profile_purpose CHECK (purpose IS NULL OR char_length(purpose) <= 1000),
  CONSTRAINT agent_profile_state CHECK (state IN ('draft', 'active', 'disabled', 'suspended')),
  CONSTRAINT agent_profile_active_shape CHECK (state <> 'active' OR (active_revision_id IS NOT NULL
    AND activated_at IS NOT NULL AND suspended_reason IS NULL)),
  CONSTRAINT agent_profile_suspended_shape CHECK (
    (state = 'suspended') = (suspended_reason IS NOT NULL)
    AND (suspended_reason IS NULL) = (suspended_at IS NULL)
    AND (suspended_reason IS NULL OR suspended_reason IN ('owner_authority', 'owner_departed', 'admin'))),
  CONSTRAINT agent_profile_draft CHECK (jsonb_typeof(draft) = 'object' AND octet_length(draft::text) <= 131072),
  CONSTRAINT agent_profile_template_key CHECK (template_key IS NULL OR template_key ~ '^[a-z_]{1,40}$'),
  CONSTRAINT agent_profile_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX agent_profile_by_envelope ON agents.agent_profile (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX agent_profile_by_owner ON agents.agent_profile (workspace_id, owner_membership_id);
CREATE INDEX agent_profile_by_creator ON agents.agent_profile (workspace_id, created_by_membership_id);
CREATE INDEX agent_profile_by_updater ON agents.agent_profile (workspace_id, updated_by_membership_id);
CREATE INDEX agent_profile_by_duplicate ON agents.agent_profile (workspace_id, duplicated_from_id);

-- Immutable configuration revisions: the validated configuration (instructions, model reference,
-- limits, approval policy) and its hash. Assignments pin a revision, so editing a profile never
-- silently broadens an existing assignment.
CREATE TABLE agents.agent_profile_revision (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  profile_id uuid NOT NULL,
  revision_number integer NOT NULL,
  schema_version integer NOT NULL,
  kind text NOT NULL,
  config jsonb NOT NULL,
  config_hash text NOT NULL,
  model_key text,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_profile_revision_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_profile_revision_number_unique UNIQUE (workspace_id, profile_id, revision_number),
  CONSTRAINT agent_profile_revision_hash_unique UNIQUE (workspace_id, profile_id, config_hash),
  CONSTRAINT agent_profile_revision_profile_fkey FOREIGN KEY (workspace_id, profile_id)
    REFERENCES agents.agent_profile (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_profile_revision_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_profile_revision_number CHECK (revision_number >= 1),
  CONSTRAINT agent_profile_revision_schema CHECK (schema_version = 1),
  CONSTRAINT agent_profile_revision_kind CHECK (kind IN ('internal', 'external')),
  CONSTRAINT agent_profile_revision_config CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 65536),
  CONSTRAINT agent_profile_revision_hash CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_profile_revision_model CHECK (model_key IS NULL OR char_length(model_key) BETWEEN 1 AND 120)
);
CREATE INDEX agent_profile_revision_by_creator ON agents.agent_profile_revision (workspace_id, created_by_membership_id);
ALTER TABLE agents.agent_profile ADD CONSTRAINT agent_profile_active_revision_fkey
  FOREIGN KEY (workspace_id, active_revision_id)
  REFERENCES agents.agent_profile_revision (workspace_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX agent_profile_by_active_revision ON agents.agent_profile (workspace_id, active_revision_id);

-- Explicit scope grants of one revision. Empty means nothing (never "all"); an integration grant
-- never grants the records behind it.
CREATE TABLE agents.agent_scope_grant (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL,
  kind text NOT NULL,
  target_id uuid NOT NULL,
  CONSTRAINT agent_scope_grant_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_scope_grant_unique UNIQUE (workspace_id, revision_id, kind, target_id),
  CONSTRAINT agent_scope_grant_revision_fkey FOREIGN KEY (workspace_id, revision_id)
    REFERENCES agents.agent_profile_revision (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_scope_grant_kind CHECK (kind IN ('brand', 'project', 'record', 'integration'))
);
CREATE INDEX agent_scope_grant_by_target ON agents.agent_scope_grant (workspace_id, kind, target_id);

-- Tool grants of one revision: a registered tool at a registered version, its accepted class, and
-- an approval class that is never weaker than the class's accepted minimum.
CREATE TABLE agents.agent_tool_grant (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL,
  tool text NOT NULL,
  tool_version text NOT NULL,
  tool_class text NOT NULL,
  approval_class text NOT NULL,
  CONSTRAINT agent_tool_grant_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_tool_grant_unique UNIQUE (workspace_id, revision_id, tool),
  CONSTRAINT agent_tool_grant_revision_fkey FOREIGN KEY (workspace_id, revision_id)
    REFERENCES agents.agent_profile_revision (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_tool_grant_tool CHECK (tool ~ '^[a-z][a-z0-9_.]{2,79}$' AND tool_version ~ '^[0-9]{1,4}$'),
  CONSTRAINT agent_tool_grant_class CHECK (tool_class IN ('read_records', 'draft_content', 'create_subtasks',
    'attach_artifacts', 'update_records', 'run_tests', 'code_change', 'external_message', 'publish', 'spend',
    'access_change', 'destructive', 'production_change', 'scope_expansion')),
  CONSTRAINT agent_tool_grant_approval CHECK (approval_class IN ('none', 'low_impact_policy', 'review_required',
    'human_approval')),
  -- R3/R4 classes always need a human approval per instance (AGT-016/017).
  CONSTRAINT agent_tool_grant_high_risk CHECK (tool_class NOT IN ('external_message', 'publish', 'spend',
    'access_change', 'destructive', 'production_change', 'scope_expansion') OR approval_class = 'human_approval')
);

CREATE FUNCTION agents.revision_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent profile revisions, grants, and assignment revisions are immutable'
    USING ERRCODE = '42501';
END $$;
CREATE TRIGGER agent_profile_revision_immutable BEFORE UPDATE ON agents.agent_profile_revision
  FOR EACH ROW EXECUTE FUNCTION agents.revision_immutable();
CREATE TRIGGER agent_scope_grant_immutable BEFORE UPDATE ON agents.agent_scope_grant
  FOR EACH ROW EXECUTE FUNCTION agents.revision_immutable();
CREATE TRIGGER agent_tool_grant_immutable BEFORE UPDATE ON agents.agent_tool_grant
  FOR EACH ROW EXECUTE FUNCTION agents.revision_immutable();

-- ---------------------------------------------------------------------------------------------
-- The connector of an external profile: its kind and endpoint, a secret-store reference (never a
-- secret), the configuration version (every endpoint, secret, or protocol change bumps it), and
-- what the last test proved (bound to the configuration version it tested; synthetic when the
-- peer was the local fixture). Capabilities are metadata, not authority.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE agents.agent_connector (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  profile_id uuid NOT NULL,
  kind text NOT NULL,
  endpoint_url text NOT NULL,
  secret_ref text,
  config_version integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'configured',
  verified_version integer,
  verified_at timestamptz,
  verified_synthetic boolean NOT NULL DEFAULT false,
  capabilities jsonb,
  last_code text,
  last_tested_at timestamptz,
  disconnected_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  updated_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT agent_connector_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_connector_profile_unique UNIQUE (workspace_id, profile_id),
  CONSTRAINT agent_connector_profile_fkey FOREIGN KEY (workspace_id, profile_id)
    REFERENCES agents.agent_profile (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_connector_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_connector_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_connector_kind CHECK (kind IN ('api', 'webhook', 'mcp')),
  CONSTRAINT agent_connector_url CHECK (char_length(endpoint_url) BETWEEN 9 AND 2048
    AND endpoint_url ~ '^https?://' AND endpoint_url !~ '[[:space:]]'),
  CONSTRAINT agent_connector_secret_ref CHECK (secret_ref IS NULL OR char_length(secret_ref) BETWEEN 8 AND 240),
  CONSTRAINT agent_connector_config_version CHECK (config_version >= 1),
  CONSTRAINT agent_connector_state CHECK (state IN ('configured', 'verified', 'stale', 'revoked', 'unavailable')),
  CONSTRAINT agent_connector_verified_shape CHECK ((state = 'verified') = (verified_version IS NOT NULL
    AND verified_version = config_version)),
  CONSTRAINT agent_connector_revoked_shape CHECK ((state = 'revoked') = (disconnected_at IS NOT NULL)),
  CONSTRAINT agent_connector_revoked_secret CHECK (state <> 'revoked' OR secret_ref IS NULL),
  CONSTRAINT agent_connector_capabilities CHECK (capabilities IS NULL OR (jsonb_typeof(capabilities) = 'object'
    AND octet_length(capabilities::text) <= 16384)),
  CONSTRAINT agent_connector_code CHECK (last_code IS NULL OR last_code ~ '^[a-z_]{1,64}$'),
  CONSTRAINT agent_connector_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX agent_connector_by_creator ON agents.agent_connector (workspace_id, created_by_membership_id);
CREATE INDEX agent_connector_by_updater ON agents.agent_connector (workspace_id, updated_by_membership_id);

-- One connection test: the detail of an `agent_connector_test` operation, bound to the connector
-- configuration version it tested. A result for an older version is stale and proves nothing.
CREATE TABLE agents.agent_connector_test (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  connector_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  config_version integer NOT NULL,
  requested_by_membership_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  code text,
  synthetic boolean NOT NULL DEFAULT false,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT agent_connector_test_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_connector_test_operation_unique UNIQUE (workspace_id, operation_id),
  CONSTRAINT agent_connector_test_connector_fkey FOREIGN KEY (workspace_id, connector_id)
    REFERENCES agents.agent_connector (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_connector_test_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_connector_test_requester_fkey FOREIGN KEY (workspace_id, requested_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_connector_test_state CHECK (state IN ('queued', 'running', 'passed', 'failed', 'stale', 'refused')),
  CONSTRAINT agent_connector_test_ended CHECK ((state IN ('queued', 'running')) = (ended_at IS NULL)),
  CONSTRAINT agent_connector_test_code CHECK (code IS NULL OR code ~ '^[a-z_]{1,64}$'),
  CONSTRAINT agent_connector_test_duration CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 600000)
);
CREATE INDEX agent_connector_test_by_connector ON agents.agent_connector_test (workspace_id, connector_id, created_at DESC);
CREATE INDEX agent_connector_test_by_requester ON agents.agent_connector_test (workspace_id, requested_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Task assignments to agents, separate from human assignees. One active assignment per task and
-- profile. The row carries the assignment's state; its immutable revisions carry what was asked
-- and the resolved scope ceiling (current access only ever narrows it).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE agents.agent_assignment (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  task_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'assigned',
  current_revision_id uuid,
  assigned_by_membership_id uuid NOT NULL,
  withdrawn_by_membership_id uuid,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT agent_assignment_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_assignment_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_assignment_task_fkey FOREIGN KEY (workspace_id, task_id)
    REFERENCES work.task (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_assignment_profile_fkey FOREIGN KEY (workspace_id, profile_id)
    REFERENCES agents.agent_profile (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_assignment_assigner_fkey FOREIGN KEY (workspace_id, assigned_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_assignment_withdrawer_fkey FOREIGN KEY (workspace_id, withdrawn_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_assignment_state CHECK (state IN ('assigned', 'withdrawn')),
  CONSTRAINT agent_assignment_withdrawn_shape CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CONSTRAINT agent_assignment_version_nonnegative CHECK (version >= 0)
);
CREATE UNIQUE INDEX agent_assignment_active ON agents.agent_assignment (workspace_id, task_id, profile_id)
  WHERE state = 'assigned';
CREATE INDEX agent_assignment_by_task ON agents.agent_assignment (workspace_id, task_id, created_at);
CREATE INDEX agent_assignment_by_profile ON agents.agent_assignment (workspace_id, profile_id) WHERE state = 'assigned';
CREATE INDEX agent_assignment_by_brand ON agents.agent_assignment (workspace_id, brand_id);
CREATE INDEX agent_assignment_by_assigner ON agents.agent_assignment (workspace_id, assigned_by_membership_id);
CREATE INDEX agent_assignment_by_withdrawer ON agents.agent_assignment (workspace_id, withdrawn_by_membership_id);

CREATE TABLE agents.agent_assignment_revision (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  assignment_id uuid NOT NULL,
  revision_number integer NOT NULL,
  profile_revision_id uuid NOT NULL,
  assigner_membership_id uuid NOT NULL,
  goal text NOT NULL,
  constraints text,
  deliverable text,
  criteria jsonb NOT NULL DEFAULT '[]',
  context_refs uuid[] NOT NULL DEFAULT '{}',
  scope_brand_ids uuid[] NOT NULL DEFAULT '{}',
  scope_project_ids uuid[] NOT NULL DEFAULT '{}',
  scope_record_ids uuid[] NOT NULL DEFAULT '{}',
  scope_integration_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_assignment_revision_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_assignment_revision_number_unique UNIQUE (workspace_id, assignment_id, revision_number),
  CONSTRAINT agent_assignment_revision_assignment_fkey FOREIGN KEY (workspace_id, assignment_id)
    REFERENCES agents.agent_assignment (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_assignment_revision_profile_fkey FOREIGN KEY (workspace_id, profile_revision_id)
    REFERENCES agents.agent_profile_revision (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_assignment_revision_assigner_fkey FOREIGN KEY (workspace_id, assigner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_assignment_revision_number CHECK (revision_number >= 1),
  CONSTRAINT agent_assignment_revision_goal CHECK (char_length(btrim(goal)) BETWEEN 1 AND 4000),
  CONSTRAINT agent_assignment_revision_text CHECK ((constraints IS NULL OR char_length(constraints) <= 4000)
    AND (deliverable IS NULL OR char_length(deliverable) <= 4000)),
  CONSTRAINT agent_assignment_revision_criteria CHECK (jsonb_typeof(criteria) = 'array'
    AND jsonb_array_length(criteria) <= 50 AND octet_length(criteria::text) <= 65536),
  CONSTRAINT agent_assignment_revision_bounds CHECK (cardinality(context_refs) <= 100
    AND cardinality(scope_brand_ids) <= 500 AND cardinality(scope_project_ids) <= 500
    AND cardinality(scope_record_ids) <= 500 AND cardinality(scope_integration_ids) <= 100)
);
CREATE INDEX agent_assignment_revision_by_profile_revision ON agents.agent_assignment_revision (workspace_id, profile_revision_id);
CREATE INDEX agent_assignment_revision_by_assigner ON agents.agent_assignment_revision (workspace_id, assigner_membership_id);
CREATE TRIGGER agent_assignment_revision_immutable BEFORE UPDATE ON agents.agent_assignment_revision
  FOR EACH ROW EXECUTE FUNCTION agents.revision_immutable();
ALTER TABLE agents.agent_assignment ADD CONSTRAINT agent_assignment_current_revision_fkey
  FOREIGN KEY (workspace_id, current_revision_id)
  REFERENCES agents.agent_assignment_revision (workspace_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX agent_assignment_by_current_revision ON agents.agent_assignment (workspace_id, current_revision_id);

-- ---------------------------------------------------------------------------------------------
-- Row-level security: every table is tenant-isolated and forced, as everywhere else.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE agents.agent_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_profile
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE agents.agent_profile_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_profile_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_profile_revision
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE agents.agent_scope_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_scope_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_scope_grant
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE agents.agent_tool_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_tool_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_tool_grant
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE agents.agent_connector ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_connector FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_connector
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE agents.agent_connector_test ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_connector_test FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_connector_test
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE agents.agent_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_assignment
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE agents.agent_assignment_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_assignment_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_assignment_revision
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON agents.agent_profile, agents.agent_profile_revision, agents.agent_scope_grant,
  agents.agent_tool_grant, agents.agent_connector, agents.agent_connector_test, agents.agent_assignment,
  agents.agent_assignment_revision FROM PUBLIC;
REVOKE ALL ON FUNCTION agents.revision_immutable() FROM PUBLIC;

-- The API (configuration and assignment commands, run as the person).
GRANT SELECT, INSERT ON agents.agent_profile, agents.agent_profile_revision, agents.agent_scope_grant,
  agents.agent_tool_grant, agents.agent_connector, agents.agent_connector_test, agents.agent_assignment,
  agents.agent_assignment_revision TO app_rw;
GRANT UPDATE (name, purpose, owner_membership_id, state, active_revision_id, activated_at, draft,
  draft_base_revision, suspended_reason, suspended_at, lifecycle_state, updated_by_membership_id, updated_at,
  version) ON agents.agent_profile TO app_rw;
GRANT UPDATE (endpoint_url, secret_ref, config_version, state, verified_version, verified_at, verified_synthetic,
  capabilities, last_code, disconnected_at, updated_by_membership_id, updated_at, version)
  ON agents.agent_connector TO app_rw;
GRANT UPDATE (state, current_revision_id, withdrawn_by_membership_id, withdrawn_at, updated_at, version)
  ON agents.agent_assignment TO app_rw;
-- The worker (connector tests, lifecycle purge, departure handling).
GRANT SELECT ON agents.agent_profile, agents.agent_profile_revision, agents.agent_scope_grant,
  agents.agent_tool_grant, agents.agent_connector, agents.agent_connector_test, agents.agent_assignment,
  agents.agent_assignment_revision TO app_worker;
GRANT UPDATE (state, suspended_reason, suspended_at, lifecycle_state, updated_at, version)
  ON agents.agent_profile TO app_worker;
GRANT UPDATE (state, verified_version, verified_at, verified_synthetic, capabilities, last_code, last_tested_at,
  updated_at, version) ON agents.agent_connector TO app_worker;
GRANT UPDATE (state, code, synthetic, duration_ms, ended_at) ON agents.agent_connector_test TO app_worker;
GRANT DELETE ON agents.agent_profile, agents.agent_profile_revision, agents.agent_scope_grant,
  agents.agent_tool_grant, agents.agent_connector, agents.agent_connector_test, agents.agent_assignment,
  agents.agent_assignment_revision TO app_worker;
