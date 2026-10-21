-- migrate:phase expand
-- Phase 8C durable, bounded agent runs (0B ADR-53, 0C AZ-53, 0D PL-55, UXD-34, ADR-0048). Adds the
-- run detail of the `agent_run` operation, its bounded progress events, tool calls, draft
-- artifacts, run-bound credentials, and the workspace emergency stop. Builds on 0001–0064; no
-- earlier file changes.
--
-- The operation (exec.operation) is the one authority for a run's execution state; the run row
-- pins what was admitted (assignment and profile revisions, the original scope ceiling, the tools,
-- the limits, the connector or model) and counts usage. No task, document, or file content is
-- copied; artifacts are the run's own draft output. Credentials are stored as SHA-256 hashes only.
-- Nothing here approves, accepts, or completes anything (8D).

-- ---------------------------------------------------------------------------------------------
-- The run: detail of one `agent_run` operation (and of its retries, through current_operation_id).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE agents.agent_run (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  task_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  assignment_revision_id uuid NOT NULL,
  profile_revision_id uuid NOT NULL,
  kind text NOT NULL,
  instructions_hash text NOT NULL,
  initiator_membership_id uuid,
  initiator_kind text NOT NULL,
  source_ref uuid,
  assigner_membership_id uuid NOT NULL,
  owner_membership_id uuid NOT NULL,
  connector_id uuid,
  connector_config_version integer,
  model_key text,
  scope_brand_ids uuid[] NOT NULL DEFAULT '{}',
  scope_project_ids uuid[] NOT NULL DEFAULT '{}',
  scope_record_ids uuid[] NOT NULL DEFAULT '{}',
  scope_integration_ids uuid[] NOT NULL DEFAULT '{}',
  tools jsonb NOT NULL,
  limits jsonb NOT NULL,
  operation_id uuid NOT NULL,
  current_operation_id uuid NOT NULL,
  attempt_number integer NOT NULL DEFAULT 1,
  phase text NOT NULL DEFAULT 'start',
  model_operation_id uuid,
  request_key text NOT NULL,
  deadline_at timestamptz,
  tool_calls_used integer NOT NULL DEFAULT 0,
  artifacts_used integer NOT NULL DEFAULT 0,
  output_bytes_used bigint NOT NULL DEFAULT 0,
  events_used integer NOT NULL DEFAULT 0,
  event_seq bigint NOT NULL DEFAULT 0,
  measured_cost_micros bigint,
  reported_cost_micros bigint,
  reported_cost_currency text,
  pause_requested_at timestamptz,
  paused_by text,
  paused_by_membership_id uuid,
  result_status text,
  result_summary text,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT agent_run_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_run_operation_unique UNIQUE (workspace_id, operation_id),
  CONSTRAINT agent_run_current_unique UNIQUE (workspace_id, current_operation_id),
  CONSTRAINT agent_run_request_unique UNIQUE (workspace_id, request_key),
  CONSTRAINT agent_run_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_task_fkey FOREIGN KEY (workspace_id, task_id)
    REFERENCES work.task (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_profile_fkey FOREIGN KEY (workspace_id, profile_id)
    REFERENCES agents.agent_profile (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_assignment_fkey FOREIGN KEY (workspace_id, assignment_id)
    REFERENCES agents.agent_assignment (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_assignment_revision_fkey FOREIGN KEY (workspace_id, assignment_revision_id)
    REFERENCES agents.agent_assignment_revision (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_profile_revision_fkey FOREIGN KEY (workspace_id, profile_revision_id)
    REFERENCES agents.agent_profile_revision (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_initiator_fkey FOREIGN KEY (workspace_id, initiator_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_assigner_fkey FOREIGN KEY (workspace_id, assigner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_pauser_fkey FOREIGN KEY (workspace_id, paused_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_connector_fkey FOREIGN KEY (workspace_id, connector_id)
    REFERENCES agents.agent_connector (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_current_fkey FOREIGN KEY (workspace_id, current_operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_model_operation_fkey FOREIGN KEY (workspace_id, model_operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_kind CHECK (kind IN ('internal', 'external')),
  CONSTRAINT agent_run_kind_shape CHECK (
    (kind = 'external' AND connector_id IS NOT NULL AND connector_config_version IS NOT NULL AND model_key IS NULL)
    OR (kind = 'internal' AND connector_id IS NULL AND connector_config_version IS NULL)),
  CONSTRAINT agent_run_initiator_kind CHECK (initiator_kind IN ('human', 'automation')),
  CONSTRAINT agent_run_initiator_shape CHECK (
    (initiator_kind = 'human' AND initiator_membership_id IS NOT NULL AND source_ref IS NULL)
    OR (initiator_kind = 'automation' AND source_ref IS NOT NULL)),
  CONSTRAINT agent_run_instructions_hash CHECK (instructions_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_run_phase CHECK (phase IN ('start', 'awaiting_model', 'awaiting_agent', 'finished')),
  CONSTRAINT agent_run_request_key CHECK (char_length(request_key) BETWEEN 8 AND 200),
  CONSTRAINT agent_run_tools CHECK (jsonb_typeof(tools) = 'array' AND jsonb_array_length(tools) <= 50),
  CONSTRAINT agent_run_limits CHECK (jsonb_typeof(limits) = 'object' AND octet_length(limits::text) <= 4096),
  CONSTRAINT agent_run_counters CHECK (attempt_number >= 1 AND tool_calls_used >= 0 AND artifacts_used >= 0
    AND output_bytes_used >= 0 AND events_used >= 0 AND event_seq >= 0),
  CONSTRAINT agent_run_costs CHECK ((measured_cost_micros IS NULL OR measured_cost_micros >= 0)
    AND (reported_cost_micros IS NULL OR reported_cost_micros >= 0)
    AND ((reported_cost_micros IS NULL) = (reported_cost_currency IS NULL))
    AND (reported_cost_currency IS NULL OR reported_cost_currency ~ '^[A-Z]{3}$')),
  CONSTRAINT agent_run_pause_shape CHECK (paused_by IS NULL OR paused_by IN ('human', 'emergency_stop')),
  CONSTRAINT agent_run_result_status CHECK (result_status IS NULL OR result_status IN ('completed', 'failed')),
  CONSTRAINT agent_run_summary CHECK (result_summary IS NULL OR char_length(result_summary) <= 4000),
  CONSTRAINT agent_run_scope_bounds CHECK (cardinality(scope_brand_ids) <= 500
    AND cardinality(scope_project_ids) <= 500 AND cardinality(scope_record_ids) <= 500
    AND cardinality(scope_integration_ids) <= 100),
  CONSTRAINT agent_run_version_nonnegative CHECK (version >= 0)
);
-- One open run per task and agent (0B ST-65); a closed run frees the slot.
CREATE UNIQUE INDEX agent_run_open ON agents.agent_run (workspace_id, task_id, profile_id) WHERE ended_at IS NULL;
CREATE INDEX agent_run_by_task ON agents.agent_run (workspace_id, task_id, created_at DESC);
CREATE INDEX agent_run_by_profile ON agents.agent_run (workspace_id, profile_id, created_at DESC);
CREATE INDEX agent_run_active ON agents.agent_run (workspace_id) WHERE ended_at IS NULL;
CREATE INDEX agent_run_by_model_operation ON agents.agent_run (workspace_id, model_operation_id)
  WHERE model_operation_id IS NOT NULL;
CREATE INDEX agent_run_by_ended ON agents.agent_run (workspace_id, ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX agent_run_by_brand ON agents.agent_run (workspace_id, brand_id);
CREATE INDEX agent_run_by_assignment ON agents.agent_run (workspace_id, assignment_id);
CREATE INDEX agent_run_by_assignment_revision ON agents.agent_run (workspace_id, assignment_revision_id);
CREATE INDEX agent_run_by_profile_revision ON agents.agent_run (workspace_id, profile_revision_id);
CREATE INDEX agent_run_by_initiator ON agents.agent_run (workspace_id, initiator_membership_id);
CREATE INDEX agent_run_by_assigner ON agents.agent_run (workspace_id, assigner_membership_id);
CREATE INDEX agent_run_by_owner ON agents.agent_run (workspace_id, owner_membership_id);
CREATE INDEX agent_run_by_pauser ON agents.agent_run (workspace_id, paused_by_membership_id);
CREATE INDEX agent_run_by_connector ON agents.agent_run (workspace_id, connector_id);

-- ---------------------------------------------------------------------------------------------
-- Bounded progress events (per-run sequence; agent events deduplicated by their source key).
-- Commentary, progress, and acknowledgments are never completion.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE agents.agent_run_event (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  seq bigint NOT NULL,
  kind text NOT NULL,
  source text NOT NULL,
  source_key text,
  text text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_run_event_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_run_event_seq_unique UNIQUE (workspace_id, run_id, seq),
  CONSTRAINT agent_run_event_run_fkey FOREIGN KEY (workspace_id, run_id)
    REFERENCES agents.agent_run (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_event_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_event_kind CHECK (kind IN ('state', 'progress', 'commentary', 'tool_call', 'artifact',
    'result', 'refusal', 'late_result', 'stop')),
  CONSTRAINT agent_run_event_source CHECK (source IN ('agent', 'system', 'human')),
  CONSTRAINT agent_run_event_key CHECK (source_key IS NULL OR char_length(source_key) BETWEEN 1 AND 128),
  CONSTRAINT agent_run_event_text CHECK (text IS NULL OR char_length(text) <= 2000),
  CONSTRAINT agent_run_event_data CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 4096),
  CONSTRAINT agent_run_event_seq CHECK (seq >= 1)
);
CREATE UNIQUE INDEX agent_run_event_source_key ON agents.agent_run_event (workspace_id, run_id, source_key)
  WHERE source_key IS NOT NULL;
CREATE INDEX agent_run_event_by_operation ON agents.agent_run_event (workspace_id, operation_id);

-- ---------------------------------------------------------------------------------------------
-- Tool calls: one decision per (attempt operation, call key); references and digests only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE agents.agent_tool_call (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  sequence integer NOT NULL,
  call_key text NOT NULL,
  tool text NOT NULL,
  tool_version text NOT NULL,
  tool_class text,
  decision text NOT NULL,
  code text,
  target_ids uuid[] NOT NULL DEFAULT '{}',
  args_digest text NOT NULL,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_tool_call_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_tool_call_key_unique UNIQUE (workspace_id, run_id, operation_id, call_key),
  CONSTRAINT agent_tool_call_sequence_unique UNIQUE (workspace_id, run_id, sequence),
  CONSTRAINT agent_tool_call_run_fkey FOREIGN KEY (workspace_id, run_id)
    REFERENCES agents.agent_run (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_tool_call_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_tool_call_decision CHECK (decision IN ('executed', 'approval_required', 'refused',
    'unavailable', 'limit_reached')),
  CONSTRAINT agent_tool_call_shape CHECK (char_length(call_key) BETWEEN 1 AND 128
    AND char_length(tool) BETWEEN 1 AND 80 AND char_length(tool_version) BETWEEN 1 AND 8
    AND (code IS NULL OR code ~ '^[a-z_]{1,64}$') AND args_digest ~ '^[0-9a-f]{64}$'
    AND cardinality(target_ids) <= 50 AND sequence >= 1)
);
CREATE INDEX agent_tool_call_by_operation ON agents.agent_tool_call (workspace_id, operation_id);

-- ---------------------------------------------------------------------------------------------
-- Draft artifacts: the run's own output, immutable versions per artifact key, validated types.
-- An artifact is draft evidence for a person's review; it is never a deliverable acceptance.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE agents.agent_artifact (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  artifact_key text NOT NULL,
  version_number integer NOT NULL,
  title text NOT NULL,
  media_type text NOT NULL,
  content text NOT NULL,
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  producer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_artifact_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_artifact_version_unique UNIQUE (workspace_id, run_id, artifact_key, version_number),
  CONSTRAINT agent_artifact_run_fkey FOREIGN KEY (workspace_id, run_id)
    REFERENCES agents.agent_run (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_artifact_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_artifact_media_type CHECK (media_type IN ('text/markdown', 'text/plain', 'application/json')),
  CONSTRAINT agent_artifact_producer CHECK (producer IN ('internal', 'external')),
  CONSTRAINT agent_artifact_shape CHECK (char_length(artifact_key) BETWEEN 1 AND 64
    AND char_length(btrim(title)) BETWEEN 1 AND 200 AND version_number >= 1
    AND byte_size = octet_length(content) AND byte_size <= 1048576 AND sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX agent_artifact_by_operation ON agents.agent_artifact (workspace_id, operation_id);
CREATE TRIGGER agent_artifact_immutable BEFORE UPDATE ON agents.agent_artifact
  FOR EACH ROW EXECUTE FUNCTION agents.revision_immutable();

-- ---------------------------------------------------------------------------------------------
-- Run-bound credentials (0D §11): one per dispatch attempt, SHA-256 at rest, short-lived, revoked
-- on pause, cancel, a terminal state, the emergency stop, disconnect, or a new attempt.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE agents.agent_run_credential (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  token_prefix text NOT NULL,
  token_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  stop_epoch bigint NOT NULL,
  state text NOT NULL DEFAULT 'active',
  revoked_reason text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_run_credential_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_run_credential_prefix_unique UNIQUE (token_prefix),
  CONSTRAINT agent_run_credential_run_fkey FOREIGN KEY (workspace_id, run_id)
    REFERENCES agents.agent_run (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_credential_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_credential_prefix CHECK (token_prefix ~ '^par_[A-Za-z0-9]{8}$'),
  CONSTRAINT agent_run_credential_hash CHECK (octet_length(token_hash) = 32),
  CONSTRAINT agent_run_credential_state CHECK (state IN ('active', 'revoked')),
  CONSTRAINT agent_run_credential_revoked_shape CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT agent_run_credential_reason CHECK (revoked_reason IS NULL OR revoked_reason ~ '^[a-z_]{1,40}$'),
  CONSTRAINT agent_run_credential_epoch CHECK (stop_epoch >= 0)
);
CREATE INDEX agent_run_credential_by_run ON agents.agent_run_credential (workspace_id, run_id) WHERE state = 'active';
CREATE INDEX agent_run_credential_by_operation ON agents.agent_run_credential (workspace_id, operation_id);

-- ---------------------------------------------------------------------------------------------
-- The workspace emergency stop: append-only toggles; the latest row is the current state.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE agents.emergency_stop (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  action text NOT NULL,
  epoch bigint NOT NULL,
  actor_membership_id uuid NOT NULL,
  reason text,
  summary jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT emergency_stop_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT emergency_stop_epoch_unique UNIQUE (workspace_id, epoch),
  CONSTRAINT emergency_stop_actor_fkey FOREIGN KEY (workspace_id, actor_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT emergency_stop_action CHECK (action IN ('stop', 'restart')),
  CONSTRAINT emergency_stop_epoch CHECK (epoch >= 1),
  CONSTRAINT emergency_stop_reason CHECK (reason IS NULL OR char_length(reason) <= 500),
  CONSTRAINT emergency_stop_summary CHECK (jsonb_typeof(summary) = 'object' AND octet_length(summary::text) <= 4096)
);
CREATE INDEX emergency_stop_by_actor ON agents.emergency_stop (workspace_id, actor_membership_id);
CREATE TRIGGER emergency_stop_immutable BEFORE UPDATE ON agents.emergency_stop
  FOR EACH ROW EXECUTE FUNCTION agents.revision_immutable();

-- ---------------------------------------------------------------------------------------------
-- 7A: a model turn requested by an internal agent run records the `agent` caller (the gateway's
-- own availability, privacy, budget, and settlement rules are unchanged).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.ai_action DROP CONSTRAINT ai_action_caller;
ALTER TABLE ai.ai_action ADD CONSTRAINT ai_action_caller
  CHECK (caller_kind IN ('ui', 'api', 'mcp', 'automation', 'agent'));

-- ---------------------------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE agents.agent_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_run
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE agents.agent_run_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_run_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_run_event
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE agents.agent_tool_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_tool_call FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_tool_call
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE agents.agent_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_artifact FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_artifact
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE agents.agent_run_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_run_credential FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.agent_run_credential
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE agents.emergency_stop ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.emergency_stop FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents.emergency_stop
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

-- ---------------------------------------------------------------------------------------------
-- Grants. The API admits, controls, and receives callbacks; the worker executes and settles.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON agents.agent_run, agents.agent_run_event, agents.agent_tool_call, agents.agent_artifact,
  agents.agent_run_credential, agents.emergency_stop FROM PUBLIC;
GRANT SELECT, INSERT ON agents.agent_run, agents.agent_run_event, agents.agent_tool_call,
  agents.agent_artifact, agents.agent_run_credential, agents.emergency_stop TO app_rw, app_worker;
GRANT UPDATE (current_operation_id, attempt_number, phase, model_operation_id, deadline_at, tool_calls_used,
  artifacts_used, output_bytes_used, events_used, event_seq, measured_cost_micros, reported_cost_micros,
  reported_cost_currency, pause_requested_at, paused_by, paused_by_membership_id, result_status, result_summary, ended_at,
  updated_at, version) ON agents.agent_run TO app_rw, app_worker;
GRANT UPDATE (state, revoked_reason, revoked_at) ON agents.agent_run_credential TO app_rw, app_worker;
GRANT DELETE ON agents.agent_run, agents.agent_run_event, agents.agent_tool_call, agents.agent_artifact,
  agents.agent_run_credential TO app_worker;

-- ---------------------------------------------------------------------------------------------
-- Credential lookup before a workspace is known (platform scope only), like 6B tokens.
-- ---------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA agents TO pm_directory;
CREATE FUNCTION agents.resolve_run_credential(p_prefix text, p_hash bytea)
  RETURNS TABLE (
    workspace_id uuid,
    credential_id uuid,
    run_id uuid,
    operation_id uuid,
    expires_at timestamptz,
    membership_id uuid,
    account_id uuid,
    workspace_public_id text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT c.workspace_id, c.id, c.run_id, c.operation_id, c.expires_at, r.assigner_membership_id, m.account_id,
         w.public_id
    FROM agents.agent_run_credential c
    JOIN agents.agent_run r ON r.workspace_id = c.workspace_id AND r.id = c.run_id
    JOIN tenancy.membership m ON m.workspace_id = r.workspace_id AND m.id = r.assigner_membership_id
    JOIN tenancy.workspace w ON w.id = c.workspace_id
   WHERE exec.in_platform_scope()
     AND w.state = 'active'
     AND c.token_prefix = p_prefix
     AND c.token_hash = p_hash
     AND c.state = 'active'
     AND c.expires_at > now()
     AND r.ended_at IS NULL
     AND m.state = 'active'
$$;
REVOKE ALL ON FUNCTION agents.resolve_run_credential(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agents.resolve_run_credential(text, bytea) TO app_rw, app_worker;
ALTER FUNCTION agents.resolve_run_credential(text, bytea) OWNER TO pm_directory;
REVOKE CREATE ON SCHEMA agents FROM pm_directory;
GRANT USAGE ON SCHEMA agents TO pm_directory;
CREATE POLICY credential_lookup ON agents.agent_run_credential FOR SELECT TO pm_directory USING (true);
CREATE POLICY credential_lookup ON agents.agent_run FOR SELECT TO pm_directory USING (true);
GRANT SELECT (workspace_id, id, run_id, operation_id, token_prefix, token_hash, expires_at, state)
  ON agents.agent_run_credential TO pm_directory;
GRANT SELECT (workspace_id, id, assigner_membership_id, ended_at) ON agents.agent_run TO pm_directory;
