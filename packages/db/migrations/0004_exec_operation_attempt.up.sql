-- migrate:phase expand
-- Logical operations and attempts (0B §9.6, 0D §5-§7). Execution-context columns mirror the 0D
-- execution-context schema; only delegation_chain and selected_scope are JSON (validated shapes).
-- No foreign key to tenancy.workspace: execution is layer 0 and depends on no module (0B module
-- map). Tenant consistency comes from RLS WITH CHECK, the context helper's workspace check, and
-- composite (workspace_id, id) keys inside the module.

CREATE TABLE exec.operation (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  public_id text NOT NULL,
  kind text NOT NULL,
  execution_state exec.exec_state NOT NULL DEFAULT 'queued',
  terminal_reason exec.terminal_reason,
  waiting_reason exec.waiting_reason,
  outcome_detail jsonb,
  dedupe_key text,
  rerun_of_operation_id uuid,
  started_at timestamptz,
  ended_at timestamptz,
  cancel_requested_at timestamptz,
  progress_phase text,
  progress_completed bigint NOT NULL DEFAULT 0,
  progress_total bigint,
  progress_unit text,
  progress_estimated boolean NOT NULL DEFAULT false,
  -- execution context (0D §7.1)
  initiated_by_actor_type exec.actor_type NOT NULL,
  initiated_by_id uuid,
  authenticated_principal_type exec.principal_type NOT NULL,
  authenticated_principal_id uuid NOT NULL,
  effective_principal_type exec.principal_type NOT NULL,
  effective_principal_id uuid NOT NULL,
  initiating_membership_id uuid,
  delegation_chain jsonb NOT NULL,
  selected_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  workspace_epoch_at_enqueue bigint NOT NULL,
  principal_epoch_at_enqueue bigint NOT NULL,
  agent_class_epoch_at_enqueue bigint,
  risk_action_key text,
  risk_class exec.risk_class,
  approval_class text,
  approval_id uuid,
  step_up_id uuid,
  data_class_limit exec.data_class NOT NULL,
  locale text,
  timezone text,
  request_id text,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  traceparent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT operation_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT operation_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT operation_public_id_key UNIQUE (public_id),
  CONSTRAINT operation_public_id_format CHECK (public_id ~ '^op_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT operation_kind_format CHECK (kind ~ '^[a-z_]{1,64}$'),
  CONSTRAINT operation_rerun_same_workspace FOREIGN KEY (workspace_id, rerun_of_operation_id)
    REFERENCES exec.operation (workspace_id, id),
  -- 0D §6.1 schema-enforced distinctness, mirrored in storage.
  CONSTRAINT operation_terminal_reason_required CHECK (
    (execution_state IN ('failed', 'cancelled', 'skipped')) = (terminal_reason IS NOT NULL)),
  CONSTRAINT operation_waiting_reason_required CHECK (
    (execution_state = 'waiting') = (waiting_reason IS NOT NULL)),
  CONSTRAINT operation_partial_requires_result CHECK (
    execution_state <> 'partial' OR outcome_detail IS NOT NULL),
  CONSTRAINT operation_ended_iff_terminal CHECK (
    (execution_state IN ('succeeded', 'partial', 'failed', 'cancelled', 'skipped')) = (ended_at IS NOT NULL)),
  CONSTRAINT operation_outcome_detail_shape CHECK (
    outcome_detail IS NULL OR (jsonb_typeof(outcome_detail) = 'object' AND pg_column_size(outcome_detail) <= 16384)),
  CONSTRAINT operation_delegation_chain_shape CHECK (
    jsonb_typeof(delegation_chain) = 'array' AND jsonb_array_length(delegation_chain) >= 1
    AND pg_column_size(delegation_chain) <= 4096),
  CONSTRAINT operation_selected_scope_shape CHECK (
    jsonb_typeof(selected_scope) = 'object' AND pg_column_size(selected_scope) <= 16384),
  CONSTRAINT operation_epochs_nonnegative CHECK (
    workspace_epoch_at_enqueue >= 0 AND principal_epoch_at_enqueue >= 0
    AND (agent_class_epoch_at_enqueue IS NULL OR agent_class_epoch_at_enqueue >= 0)),
  CONSTRAINT operation_risk_pair CHECK ((risk_action_key IS NULL) = (risk_class IS NULL)),
  CONSTRAINT operation_progress_nonnegative CHECK (
    progress_completed >= 0 AND (progress_total IS NULL OR progress_total >= 0)),
  CONSTRAINT operation_request_id_format CHECK (request_id IS NULL OR request_id ~ '^req_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT operation_traceparent_format CHECK (traceparent IS NULL OR traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'),
  CONSTRAINT operation_dedupe_key_length CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 200),
  CONSTRAINT operation_version_nonnegative CHECK (version >= 0)
);
COMMENT ON TABLE exec.operation IS 'One logical outcome (0B §9.6). Retries add attempts, never operations; reruns are new operations.';

-- 0B §9.3: one non-terminal operation per (workspace, kind, dedupe_key).
CREATE UNIQUE INDEX operation_active_dedupe ON exec.operation (workspace_id, kind, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND execution_state IN ('queued', 'running', 'waiting', 'paused');
-- 0B §10.5 execution index.
CREATE INDEX operation_by_kind_state ON exec.operation (workspace_id, kind, execution_state, created_at DESC);

CREATE TABLE exec.attempt (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  public_id text NOT NULL,
  operation_id uuid NOT NULL,
  job_id uuid,
  attempt_number integer NOT NULL,
  execution_state exec.exec_state NOT NULL DEFAULT 'running',
  terminal_reason exec.terminal_reason,
  error_class exec.job_error_class,
  error_detail jsonb,
  worker_lost boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attempt_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT attempt_public_id_key UNIQUE (public_id),
  CONSTRAINT attempt_public_id_format CHECK (public_id ~ '^att_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT attempt_number_per_operation UNIQUE (operation_id, attempt_number),
  CONSTRAINT attempt_number_positive CHECK (attempt_number >= 1),
  CONSTRAINT attempt_operation_same_workspace FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id),
  CONSTRAINT attempt_state_allowed CHECK (execution_state IN ('running', 'waiting', 'succeeded', 'partial', 'failed', 'cancelled')),
  CONSTRAINT attempt_terminal_reason_required CHECK (
    (execution_state IN ('failed', 'cancelled')) = (terminal_reason IS NOT NULL)),
  CONSTRAINT attempt_ended_iff_terminal CHECK ((execution_state <> 'running') = (ended_at IS NOT NULL)),
  CONSTRAINT attempt_error_detail_shape CHECK (
    error_detail IS NULL OR (jsonb_typeof(error_detail) = 'object' AND pg_column_size(error_detail) <= 2048))
);
COMMENT ON TABLE exec.attempt IS 'One try of an operation (append-only once ended; 0B lifecycle append-only).';
CREATE INDEX attempt_by_operation ON exec.attempt (workspace_id, operation_id, attempt_number);

-- Attempts are append-only once ended: identity columns never change and ended rows are frozen.
CREATE FUNCTION exec.attempt_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attempts are append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'ended attempts are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.operation_id <> OLD.operation_id
     OR NEW.attempt_number <> OLD.attempt_number OR NEW.public_id <> OLD.public_id
     OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'attempt identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attempt_guard BEFORE UPDATE OR DELETE ON exec.attempt
  FOR EACH ROW EXECUTE FUNCTION exec.attempt_guard();

ALTER TABLE exec.operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE exec.operation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exec.operation
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

ALTER TABLE exec.attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE exec.attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exec.attempt
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

-- Operations: created by web/API and workers; state owned by the execution engine. No DELETE
-- (retention purge belongs to a later, audited maintenance role).
GRANT SELECT, INSERT ON exec.operation TO app_rw, app_worker;
GRANT UPDATE (execution_state, terminal_reason, waiting_reason, outcome_detail, started_at, ended_at,
  cancel_requested_at, progress_phase, progress_completed, progress_total, progress_unit,
  progress_estimated, approval_id, step_up_id, updated_at, version)
  ON exec.operation TO app_rw, app_worker;

GRANT SELECT ON exec.attempt TO app_rw;
GRANT SELECT, INSERT ON exec.attempt TO app_worker;
GRANT UPDATE (execution_state, terminal_reason, error_class, error_detail, worker_lost, ended_at)
  ON exec.attempt TO app_worker;
