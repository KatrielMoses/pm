-- migrate:phase expand
-- Phase 7A (0B ADR-44, 0C AZ-44, 0D PL-46): the AI gateway, its privacy policy, durable AI
-- actions and provider dispatches, and hard spending reservations. A provider key is a vault
-- reference only. Context references point to records and never copy their content. Money is
-- exact decimal micro-dollars (six fractional digits); nothing here is a float.
-- Builds on migration 0052_webhook_delivery_controls.

CREATE SCHEMA ai;
REVOKE ALL ON SCHEMA ai FROM PUBLIC;
GRANT USAGE ON SCHEMA ai TO app_rw, app_worker;
CREATE SCHEMA metering;
REVOKE ALL ON SCHEMA metering FROM PUBLIC;
GRANT USAGE ON SCHEMA metering TO app_rw, app_worker;

-- ---------------------------------------------------------------------------------------------
-- Workspace AI policy and provider selection (AI-031, AI-032, AI-036, SEC-027). One row per
-- workspace; no row means AI is off. Training exclusion cannot be switched off while OD-41 is
-- open. A workspace key is a vault reference, never a secret.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.ai_provider_config (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  model_key text,
  key_source text NOT NULL DEFAULT 'deployment',
  workspace_key_ref text,
  workspace_key_set_at timestamptz,
  max_data_class text NOT NULL DEFAULT 'C2',
  require_training_exclusion boolean NOT NULL DEFAULT true,
  confirm_above_micros numeric(20, 6) NOT NULL DEFAULT 0,
  updated_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT ai_provider_config_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT ai_provider_config_one_per_workspace UNIQUE (workspace_id),
  CONSTRAINT ai_provider_config_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_provider_config_model_key CHECK (model_key IS NULL OR model_key ~ '^[a-z0-9_.-]{1,40}/[a-z0-9_.-]{1,80}@[0-9a-z_.-]{1,40}$'),
  CONSTRAINT ai_provider_config_enabled_model CHECK (NOT enabled OR model_key IS NOT NULL),
  CONSTRAINT ai_provider_config_key_source CHECK (key_source IN ('deployment', 'workspace')),
  CONSTRAINT ai_provider_config_key_ref CHECK (workspace_key_ref IS NULL OR (char_length(workspace_key_ref) BETWEEN 8 AND 240
    AND workspace_key_ref !~ '[[:space:]]')),
  CONSTRAINT ai_provider_config_key_shape CHECK ((workspace_key_ref IS NULL) = (workspace_key_set_at IS NULL)),
  CONSTRAINT ai_provider_config_data_class CHECK (max_data_class IN ('C0', 'C1', 'C2')),
  CONSTRAINT ai_provider_config_training_excluded CHECK (require_training_exclusion),
  CONSTRAINT ai_provider_config_confirm CHECK (confirm_above_micros >= 0 AND confirm_above_micros <= 1000000000000),
  CONSTRAINT ai_provider_config_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX ai_provider_config_by_updater ON ai.ai_provider_config (workspace_id, updated_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Brand AI profile (WSB-012). Instructions, terminology, audience, voice, and the approved-source
-- policy that later retrieval (7B) enforces. Plain text, bounded, never a secret.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.brand_ai_profile (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  instructions text NOT NULL DEFAULT '',
  terminology text NOT NULL DEFAULT '',
  audience text NOT NULL DEFAULT '',
  voice text NOT NULL DEFAULT '',
  approved_sources text NOT NULL DEFAULT 'readable',
  updated_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT brand_ai_profile_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT brand_ai_profile_one_per_brand UNIQUE (workspace_id, brand_id),
  CONSTRAINT brand_ai_profile_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT brand_ai_profile_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT brand_ai_profile_text CHECK (tenancy.valid_plain_text(instructions, 4000)
    AND tenancy.valid_plain_text(terminology, 2000) AND tenancy.valid_plain_text(audience, 1000)
    AND tenancy.valid_plain_text(voice, 1000)),
  CONSTRAINT brand_ai_profile_sources CHECK (approved_sources IN ('readable', 'brand_only')),
  CONSTRAINT brand_ai_profile_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX brand_ai_profile_by_updater ON ai.brand_ai_profile (workspace_id, updated_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- AI action (AI-026): the typed 1:1 detail of an `ai_action` operation. Immutable except the
-- content erasure columns. The price, privacy, and model snapshots are what the run was
-- authorized and estimated against; the redacted prompt is the only user content stored here.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.ai_action (
  operation_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  initiating_membership_id uuid NOT NULL,
  brand_id uuid,
  purpose text NOT NULL,
  synthetic boolean NOT NULL,
  model_key text NOT NULL,
  provider text NOT NULL,
  model_id text NOT NULL,
  registry_version text NOT NULL,
  prompt_template_version text NOT NULL,
  price_snapshot jsonb NOT NULL,
  privacy_snapshot jsonb NOT NULL,
  funding text NOT NULL,
  caller_kind text NOT NULL,
  delegation_principal_type text,
  delegation_token_id uuid,
  prompt_text text,
  redaction_count integer NOT NULL DEFAULT 0,
  max_output_tokens integer NOT NULL,
  estimated_max_micros numeric(20, 6) NOT NULL,
  rerun_of_operation_id uuid,
  content_state text NOT NULL DEFAULT 'present',
  content_erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_action_workspace_key UNIQUE (workspace_id, operation_id),
  CONSTRAINT ai_action_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_action_rerun_fkey FOREIGN KEY (workspace_id, rerun_of_operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_action_member_fkey FOREIGN KEY (workspace_id, initiating_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_action_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_action_purpose CHECK (purpose IN ('test_run')),
  CONSTRAINT ai_action_model_key CHECK (model_key ~ '^[a-z0-9_.-]{1,40}/[a-z0-9_.-]{1,80}@[0-9a-z_.-]{1,40}$'),
  CONSTRAINT ai_action_names CHECK (char_length(provider) BETWEEN 1 AND 40 AND char_length(model_id) BETWEEN 1 AND 120
    AND char_length(registry_version) BETWEEN 1 AND 40 AND char_length(prompt_template_version) BETWEEN 1 AND 40),
  CONSTRAINT ai_action_snapshots CHECK (jsonb_typeof(price_snapshot) = 'object' AND jsonb_typeof(privacy_snapshot) = 'object'
    AND pg_column_size(price_snapshot) <= 2048 AND pg_column_size(privacy_snapshot) <= 2048),
  CONSTRAINT ai_action_funding CHECK (funding IN ('platform', 'workspace_key', 'synthetic')),
  CONSTRAINT ai_action_synthetic_funding CHECK (synthetic = (funding = 'synthetic')),
  CONSTRAINT ai_action_caller CHECK (caller_kind IN ('ui', 'api', 'mcp')),
  CONSTRAINT ai_action_delegation_shape CHECK ((delegation_principal_type IS NULL) = (delegation_token_id IS NULL)
    AND (delegation_principal_type IS NULL OR delegation_principal_type IN ('api_token_personal', 'oauth_client'))),
  CONSTRAINT ai_action_prompt CHECK (tenancy.valid_plain_text(prompt_text, 8000)),
  CONSTRAINT ai_action_redactions CHECK (redaction_count BETWEEN 0 AND 10000),
  CONSTRAINT ai_action_output_bound CHECK (max_output_tokens BETWEEN 1 AND 8192),
  CONSTRAINT ai_action_estimate CHECK (estimated_max_micros >= 0),
  CONSTRAINT ai_action_content_state CHECK (content_state IN ('present', 'erased')),
  CONSTRAINT ai_action_content_shape CHECK (
    (content_state = 'present' AND content_erased_at IS NULL AND prompt_text IS NOT NULL)
    OR (content_state = 'erased' AND content_erased_at IS NOT NULL AND prompt_text IS NULL))
);
CREATE INDEX ai_action_by_member ON ai.ai_action (workspace_id, initiating_membership_id, created_at DESC);
CREATE INDEX ai_action_by_brand ON ai.ai_action (workspace_id, brand_id);
CREATE INDEX ai_action_by_rerun ON ai.ai_action (workspace_id, rerun_of_operation_id);
CREATE INDEX ai_action_by_created ON ai.ai_action (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- Context references (AI-026, SEC-027): which records and fields an action asked for, the
-- record version at request time, and whether the policy included or excluded it. A purged
-- record leaves a tombstone reference (no foreign key to the record).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.ai_context_ref (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  position smallint NOT NULL,
  record_id uuid NOT NULL,
  record_type text NOT NULL,
  record_public_id text NOT NULL,
  fields text[] NOT NULL,
  record_version bigint NOT NULL,
  included boolean NOT NULL,
  exclusion_reason text,
  CONSTRAINT ai_context_ref_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT ai_context_ref_position UNIQUE (operation_id, position),
  CONSTRAINT ai_context_ref_action_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES ai.ai_action (workspace_id, operation_id) ON DELETE RESTRICT,
  CONSTRAINT ai_context_ref_position_range CHECK (position BETWEEN 0 AND 19),
  CONSTRAINT ai_context_ref_type CHECK (record_type IN ('task', 'project')),
  CONSTRAINT ai_context_ref_public_id CHECK (record_public_id ~ '^(tsk|prj)_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT ai_context_ref_fields CHECK (cardinality(fields) BETWEEN 1 AND 8),
  CONSTRAINT ai_context_ref_version CHECK (record_version >= 0),
  CONSTRAINT ai_context_ref_exclusion CHECK ((included) = (exclusion_reason IS NULL)
    AND (exclusion_reason IS NULL OR exclusion_reason IN ('field_not_ai_eligible', 'data_class', 'sensitive_brand', 'out_of_scope')))
);
CREATE INDEX ai_context_ref_by_action ON ai.ai_context_ref (workspace_id, operation_id, position);
CREATE INDEX ai_context_ref_by_record ON ai.ai_context_ref (workspace_id, record_id);

-- ---------------------------------------------------------------------------------------------
-- Provider dispatch (AI-027, AI-028, AI-035): one row per potentially chargeable provider call,
-- written in state `dispatching` and committed before the request leaves. A row still
-- `dispatching` when a later attempt starts is a call whose outcome is unknown: it is never
-- resent and its reservation stays held until reconciled.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.ai_dispatch (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  attempt_id uuid NOT NULL REFERENCES exec.attempt (id) ON DELETE RESTRICT,
  dispatch_number smallint NOT NULL,
  state text NOT NULL DEFAULT 'dispatching',
  period_start date NOT NULL,
  input_token_bound integer NOT NULL,
  output_token_bound integer NOT NULL,
  reserved_micros numeric(20, 6) NOT NULL,
  provider_request_id text,
  stop_reason text,
  error_kind text,
  input_tokens integer,
  output_tokens integer,
  settled_micros numeric(20, 6),
  usage_basis text,
  cancel_observed boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  reconciled_by_membership_id uuid,
  reconciled_at timestamptz,
  CONSTRAINT ai_dispatch_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT ai_dispatch_number UNIQUE (operation_id, dispatch_number),
  CONSTRAINT ai_dispatch_one_per_attempt UNIQUE (attempt_id),
  CONSTRAINT ai_dispatch_action_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES ai.ai_action (workspace_id, operation_id) ON DELETE RESTRICT,
  CONSTRAINT ai_dispatch_reconciler_fkey FOREIGN KEY (workspace_id, reconciled_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_dispatch_number_range CHECK (dispatch_number BETWEEN 1 AND 50),
  CONSTRAINT ai_dispatch_state CHECK (state IN ('dispatching', 'succeeded', 'partial', 'refused', 'failed', 'unknown', 'reconciled')),
  CONSTRAINT ai_dispatch_bounds CHECK (input_token_bound >= 1 AND output_token_bound >= 1 AND reserved_micros >= 0),
  CONSTRAINT ai_dispatch_request_id CHECK (provider_request_id IS NULL OR (char_length(provider_request_id) BETWEEN 1 AND 200
    AND provider_request_id ~ '^[A-Za-z0-9_.:-]+$')),
  CONSTRAINT ai_dispatch_stop_reason CHECK (stop_reason IS NULL OR stop_reason ~ '^[a-z_]{1,40}$'),
  CONSTRAINT ai_dispatch_error_kind CHECK (error_kind IS NULL OR error_kind IN
    ('config', 'auth', 'rate', 'transient', 'invalid', 'refused', 'stream_interrupted', 'not_sent', 'outcome_unknown', 'cancelled', 'worker_lost')),
  CONSTRAINT ai_dispatch_usage CHECK ((input_tokens IS NULL OR input_tokens >= 0) AND (output_tokens IS NULL OR output_tokens >= 0)),
  CONSTRAINT ai_dispatch_usage_basis CHECK (usage_basis IS NULL OR usage_basis IN ('measured', 'not_charged', 'reported', 'reserved_bound')),
  -- A settled dispatch carries its basis; an open or unknown one carries none.
  CONSTRAINT ai_dispatch_settled_shape CHECK (
    (state IN ('dispatching', 'unknown')) = (settled_micros IS NULL AND usage_basis IS NULL)),
  CONSTRAINT ai_dispatch_settled_bound CHECK (settled_micros IS NULL OR settled_micros >= 0),
  CONSTRAINT ai_dispatch_ended_shape CHECK ((state = 'dispatching') = (ended_at IS NULL)),
  CONSTRAINT ai_dispatch_reconciled_shape CHECK (
    (state = 'reconciled') = (reconciled_at IS NOT NULL AND reconciled_by_membership_id IS NOT NULL))
);
CREATE INDEX ai_dispatch_by_action ON ai.ai_dispatch (workspace_id, operation_id, dispatch_number);
CREATE INDEX ai_dispatch_by_reconciler ON ai.ai_dispatch (workspace_id, reconciled_by_membership_id);
CREATE INDEX ai_dispatch_by_attempt ON ai.ai_dispatch (attempt_id);
CREATE INDEX ai_dispatch_open ON ai.ai_dispatch (workspace_id, state) WHERE state IN ('dispatching', 'unknown');

-- ---------------------------------------------------------------------------------------------
-- Output (AI-026, AI-029 contribution): the generated text of one dispatch, immutable. Partial
-- and truncated output is kept and labelled; it is never a successful completion.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.ai_output (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  dispatch_id uuid NOT NULL,
  completeness text NOT NULL,
  content text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_output_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT ai_output_one_per_dispatch UNIQUE (dispatch_id),
  CONSTRAINT ai_output_action_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES ai.ai_action (workspace_id, operation_id) ON DELETE RESTRICT,
  CONSTRAINT ai_output_dispatch_fkey FOREIGN KEY (workspace_id, dispatch_id)
    REFERENCES ai.ai_dispatch (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_output_completeness CHECK (completeness IN ('complete', 'truncated', 'partial', 'erased')),
  CONSTRAINT ai_output_content CHECK (tenancy.valid_plain_text(content, 40000)
    AND ((completeness = 'erased') = (content IS NULL)))
);
CREATE INDEX ai_output_by_action ON ai.ai_output (workspace_id, operation_id);
CREATE INDEX ai_output_by_dispatch ON ai.ai_output (workspace_id, dispatch_id);

-- Output is immutable: the only permitted change is erasure of its content.
CREATE FUNCTION ai.output_guard() RETURNS trigger
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
CREATE TRIGGER ai_output_immutable BEFORE UPDATE ON ai.ai_output
  FOR EACH ROW EXECUTE FUNCTION ai.output_guard();

-- ---------------------------------------------------------------------------------------------
-- Spend limits (AI-033, AI-035). A monthly allowance and a hard cap per meter. No row means the
-- deployment default, which is finite; unconfigured is never unlimited.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE metering.spend_limit (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  scope_key uuid NOT NULL,
  meter text NOT NULL,
  monthly_allowance numeric(20, 6) NOT NULL,
  hard_limit numeric(20, 6) NOT NULL,
  updated_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT spend_limit_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT spend_limit_scope_meter UNIQUE (workspace_id, scope_key, meter),
  CONSTRAINT spend_limit_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT spend_limit_workspace_scope CHECK (scope_key = workspace_id),
  CONSTRAINT spend_limit_meter CHECK (meter IN ('ai.cost', 'ai.input_tokens', 'ai.output_tokens')),
  CONSTRAINT spend_limit_amounts CHECK (monthly_allowance >= 0 AND hard_limit >= 0
    AND monthly_allowance <= hard_limit AND hard_limit <= 1000000000000),
  CONSTRAINT spend_limit_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX spend_limit_by_updater ON metering.spend_limit (workspace_id, updated_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Balances (AI-033, AI-035): one row per workspace, meter, and billing period (the calendar
-- month in the workspace timezone). Locked FOR UPDATE to reserve. Consumed usage is never
-- erased; reserved covers every held and unknown reservation of the period.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE metering.usage_balance (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  scope_key uuid NOT NULL,
  meter text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  consumed numeric(20, 6) NOT NULL DEFAULT 0,
  allowance_consumed numeric(20, 6) NOT NULL DEFAULT 0,
  reserved numeric(20, 6) NOT NULL DEFAULT 0,
  last_threshold_bp integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT usage_balance_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT usage_balance_period UNIQUE (workspace_id, scope_key, meter, period_start),
  CONSTRAINT usage_balance_workspace_scope CHECK (scope_key = workspace_id),
  CONSTRAINT usage_balance_meter CHECK (meter IN ('ai.cost', 'ai.input_tokens', 'ai.output_tokens')),
  CONSTRAINT usage_balance_month CHECK (extract(day FROM period_start) = 1
    AND period_end = (period_start + interval '1 month')::date),
  CONSTRAINT usage_balance_nonnegative CHECK (consumed >= 0 AND reserved >= 0 AND allowance_consumed >= 0
    AND allowance_consumed <= consumed),
  CONSTRAINT usage_balance_threshold CHECK (last_threshold_bp BETWEEN 0 AND 100000),
  CONSTRAINT usage_balance_version_nonnegative CHECK (version >= 0)
);

-- ---------------------------------------------------------------------------------------------
-- Reservations (AI-035, AGT-024 foundation): one per dispatch and meter, taken in the same
-- transaction that locks the balance. `held` and `unknown` count against the balance; `settled`
-- and `released` do not. A reservation settles or is released exactly once.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE metering.usage_reservation (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  dispatch_id uuid NOT NULL,
  meter text NOT NULL,
  period_start date NOT NULL,
  amount numeric(20, 6) NOT NULL,
  state text NOT NULL DEFAULT 'held',
  settled_amount numeric(20, 6),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_reservation_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT usage_reservation_dispatch_meter UNIQUE (dispatch_id, meter),
  CONSTRAINT usage_reservation_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT usage_reservation_dispatch_fkey FOREIGN KEY (workspace_id, dispatch_id)
    REFERENCES ai.ai_dispatch (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT usage_reservation_meter CHECK (meter IN ('ai.cost', 'ai.input_tokens', 'ai.output_tokens')),
  CONSTRAINT usage_reservation_amount CHECK (amount >= 0),
  CONSTRAINT usage_reservation_state CHECK (state IN ('held', 'unknown', 'settled', 'released')),
  CONSTRAINT usage_reservation_settled_shape CHECK ((state = 'settled') = (settled_amount IS NOT NULL)
    AND (settled_amount IS NULL OR settled_amount >= 0))
);
CREATE INDEX usage_reservation_by_operation ON metering.usage_reservation (workspace_id, operation_id);
CREATE INDEX usage_reservation_by_dispatch ON metering.usage_reservation (workspace_id, dispatch_id);
CREATE INDEX usage_reservation_open ON metering.usage_reservation (workspace_id, period_start, meter)
  WHERE state IN ('held', 'unknown');

-- ---------------------------------------------------------------------------------------------
-- Usage events (AI-026, AI-034, RPT-012 contribution): append-only. Attempt-level actual usage
-- with its basis. `billable` is false for every 7A event: customer billing is 10A, and
-- workspace-key usage is metered for visibility only (OD-46).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE metering.usage_event (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  meter text NOT NULL,
  quantity numeric(20, 6) NOT NULL,
  unit text NOT NULL,
  cost_micros numeric(20, 6),
  cost_basis text NOT NULL,
  funding text NOT NULL,
  billable boolean NOT NULL DEFAULT false,
  brand_id uuid,
  actor_type text NOT NULL,
  operation_id uuid NOT NULL,
  dispatch_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  period_start date NOT NULL,
  correction_of uuid,
  sequence integer NOT NULL,
  CONSTRAINT usage_event_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT usage_event_once UNIQUE (operation_id, dispatch_id, meter, sequence),
  CONSTRAINT usage_event_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT usage_event_dispatch_fkey FOREIGN KEY (workspace_id, dispatch_id)
    REFERENCES ai.ai_dispatch (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT usage_event_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT usage_event_correction_fkey FOREIGN KEY (workspace_id, correction_of)
    REFERENCES metering.usage_event (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT usage_event_meter CHECK (meter IN ('ai.cost', 'ai.input_tokens', 'ai.output_tokens')),
  CONSTRAINT usage_event_unit CHECK ((meter = 'ai.cost' AND unit = 'usd_micros') OR (meter <> 'ai.cost' AND unit = 'tokens')),
  CONSTRAINT usage_event_quantity CHECK (quantity >= 0),
  CONSTRAINT usage_event_cost CHECK ((meter = 'ai.cost') = (cost_micros IS NOT NULL) AND (cost_micros IS NULL OR cost_micros = quantity)),
  CONSTRAINT usage_event_basis CHECK (cost_basis IN ('measured', 'estimated', 'reported')),
  CONSTRAINT usage_event_funding CHECK (funding IN ('platform', 'workspace_key', 'synthetic')),
  CONSTRAINT usage_event_not_billed CHECK (NOT billable),
  CONSTRAINT usage_event_actor CHECK (actor_type IN ('ai')),
  CONSTRAINT usage_event_sequence CHECK (sequence BETWEEN 1 AND 100)
);
CREATE INDEX usage_event_by_operation ON metering.usage_event (workspace_id, operation_id);
CREATE INDEX usage_event_by_dispatch ON metering.usage_event (workspace_id, dispatch_id);
CREATE INDEX usage_event_by_brand ON metering.usage_event (workspace_id, brand_id);
CREATE INDEX usage_event_by_correction ON metering.usage_event (workspace_id, correction_of);
CREATE INDEX usage_event_by_period ON metering.usage_event (workspace_id, period_start, meter);

-- ---------------------------------------------------------------------------------------------
-- Aged AI content (payload-free discovery for the technical retention sweep; off by default
-- while OD-36 is open). Only workspace ids leave the function.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON ai.ai_action FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, created_at, content_state) ON ai.ai_action TO pm_scheduler;
GRANT USAGE ON SCHEMA ai TO pm_scheduler;

CREATE FUNCTION exec_dispatch.discover_ai_retention_work(p_before timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT a.workspace_id FROM ai.ai_action a
   WHERE a.content_state = 'present' AND a.created_at < p_before
   GROUP BY a.workspace_id
   ORDER BY min(a.created_at), a.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_ai_retention_work(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_ai_retention_work(timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_ai_retention_work(timestamptz, integer) OWNER TO pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Row-level security, then explicit grants. Usage events are append-only for both roles.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.ai_provider_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_provider_config FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.ai_provider_config
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.brand_ai_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.brand_ai_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.brand_ai_profile
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.ai_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_action FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.ai_action
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.ai_context_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_context_ref FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.ai_context_ref
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.ai_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.ai_dispatch
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.ai_output ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_output FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.ai_output
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE metering.spend_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE metering.spend_limit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metering.spend_limit
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE metering.usage_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE metering.usage_balance FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metering.usage_balance
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE metering.usage_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE metering.usage_reservation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metering.usage_reservation
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE metering.usage_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE metering.usage_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metering.usage_event
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON ai.ai_provider_config, ai.brand_ai_profile, ai.ai_action, ai.ai_context_ref, ai.ai_dispatch,
  ai.ai_output, metering.spend_limit, metering.usage_balance, metering.usage_reservation, metering.usage_event
  FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ai.ai_provider_config, ai.brand_ai_profile, metering.spend_limit TO app_rw;
GRANT SELECT ON ai.ai_provider_config, ai.brand_ai_profile, metering.spend_limit TO app_worker;
-- The API records the action and its context references, reconciles unknown dispatches, and
-- erases a departed member's content; the worker owns dispatch, reservation, and settlement.
GRANT SELECT, INSERT ON ai.ai_action, ai.ai_context_ref TO app_rw;
GRANT UPDATE (prompt_text, content_state, content_erased_at) ON ai.ai_action TO app_rw, app_worker;
GRANT DELETE ON ai.ai_context_ref TO app_rw, app_worker;
GRANT SELECT ON ai.ai_action, ai.ai_context_ref TO app_worker;
GRANT SELECT, INSERT, UPDATE ON ai.ai_dispatch, ai.ai_output, metering.usage_balance, metering.usage_reservation
  TO app_rw, app_worker;
GRANT SELECT, INSERT ON metering.usage_event TO app_rw, app_worker;
