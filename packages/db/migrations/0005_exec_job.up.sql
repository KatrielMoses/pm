-- migrate:phase expand
-- Durable job queue (0B execution.job, 0D §7). Jobs carry a payload reference and the full
-- execution context, never large payloads. 1A supports tenant jobs only (workspace_id NOT NULL);
-- relaxing to nullable for platform jobs later is an additive change.

CREATE TABLE exec.job (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  queue text NOT NULL,
  kind text NOT NULL,
  operation_id uuid,
  state exec.job_state NOT NULL DEFAULT 'queued',
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  timeout_seconds integer NOT NULL,
  dedupe_key text,
  payload_ref text,
  -- leasing (0D §7.3)
  lease_token uuid,
  lease_owner text,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  -- step checkpoints (0D §7.6): completed steps are skipped on re-execution
  completed_steps text[] NOT NULL DEFAULT '{}',
  checkpoint jsonb,
  -- errors (0D job.schema last_error)
  last_error jsonb,
  last_error_class exec.job_error_class,
  cancel_requested_at timestamptz,
  finished_at timestamptz,
  -- execution context (0D §7.1)
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
  traceparent text,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT job_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT job_operation_same_workspace FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id),
  CONSTRAINT job_queue_format CHECK (queue ~ '^[a-z_]{1,64}$'),
  CONSTRAINT job_kind_format CHECK (kind ~ '^[a-z_.]{1,128}$'),
  CONSTRAINT job_attempts_range CHECK (attempts >= 0 AND attempts <= max_attempts),
  CONSTRAINT job_max_attempts_positive CHECK (max_attempts >= 1),
  CONSTRAINT job_timeout_positive CHECK (timeout_seconds >= 1),
  CONSTRAINT job_lease_consistency CHECK (
    (state = 'leased') = (lease_token IS NOT NULL AND lease_until IS NOT NULL AND lease_owner IS NOT NULL)),
  CONSTRAINT job_finished_iff_terminal CHECK (
    (state IN ('succeeded', 'dead', 'cancelled')) = (finished_at IS NOT NULL)),
  CONSTRAINT job_dead_has_error CHECK (state <> 'dead' OR last_error_class IS NOT NULL),
  CONSTRAINT job_last_error_shape CHECK (
    last_error IS NULL OR (jsonb_typeof(last_error) = 'object' AND pg_column_size(last_error) <= 1024)),
  CONSTRAINT job_checkpoint_shape CHECK (
    checkpoint IS NULL OR (jsonb_typeof(checkpoint) = 'object' AND pg_column_size(checkpoint) <= 4096)),
  CONSTRAINT job_completed_steps_bounded CHECK (cardinality(completed_steps) <= 256),
  CONSTRAINT job_payload_ref_length CHECK (payload_ref IS NULL OR char_length(payload_ref) <= 512),
  CONSTRAINT job_dedupe_key_length CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 200),
  CONSTRAINT job_lease_owner_format CHECK (lease_owner IS NULL OR lease_owner ~ '^wrk_[0-9a-f]{16}$'),
  CONSTRAINT job_delegation_chain_shape CHECK (
    jsonb_typeof(delegation_chain) = 'array' AND jsonb_array_length(delegation_chain) >= 1
    AND pg_column_size(delegation_chain) <= 4096),
  CONSTRAINT job_selected_scope_shape CHECK (
    jsonb_typeof(selected_scope) = 'object' AND pg_column_size(selected_scope) <= 16384),
  CONSTRAINT job_epochs_nonnegative CHECK (
    workspace_epoch_at_enqueue >= 0 AND principal_epoch_at_enqueue >= 0
    AND (agent_class_epoch_at_enqueue IS NULL OR agent_class_epoch_at_enqueue >= 0)),
  CONSTRAINT job_risk_pair CHECK ((risk_action_key IS NULL) = (risk_class IS NULL)),
  CONSTRAINT job_request_id_format CHECK (request_id IS NULL OR request_id ~ '^req_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT job_traceparent_format CHECK (traceparent IS NULL OR traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$')
);
COMMENT ON TABLE exec.job IS 'Durable job queue with leases, backoff, dead letter, and per-workspace fairness (0D §7).';

-- Duplicate-enqueue guard (0B: unique (queue, dedupe_key) while active). Scoped by workspace so
-- one tenant's key can never block or reveal another tenant's job.
CREATE UNIQUE INDEX job_active_dedupe ON exec.job (workspace_id, queue, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'leased', 'retry_scheduled');
-- Claim path (0B §10.5): due jobs per queue, and per-workspace fairness counts.
CREATE INDEX job_due ON exec.job (queue, run_at, id) WHERE state IN ('queued', 'retry_scheduled');
CREATE INDEX job_leased ON exec.job (queue, workspace_id) WHERE state = 'leased';
CREATE INDEX job_lease_expiry ON exec.job (lease_until) WHERE state = 'leased';
CREATE INDEX job_finished ON exec.job (workspace_id, finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX job_by_operation ON exec.job (workspace_id, operation_id) WHERE operation_id IS NOT NULL;

ALTER TABLE exec.job ENABLE ROW LEVEL SECURITY;
ALTER TABLE exec.job FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exec.job
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
-- Cross-tenant scheduling visibility exists only for pm_scheduler, a NOLOGIN role that owns the
-- payload-free definer functions. Column grants below limit it to scheduling columns.
CREATE POLICY scheduler_discovery ON exec.job FOR SELECT TO pm_scheduler USING (true);
CREATE POLICY scheduler_lease ON exec.job FOR UPDATE TO pm_scheduler USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON exec.job TO app_rw;
GRANT UPDATE (state, cancel_requested_at, finished_at, updated_at) ON exec.job TO app_rw;
GRANT SELECT, INSERT, DELETE ON exec.job TO app_worker;
GRANT UPDATE (state, run_at, lease_token, lease_owner, lease_until, heartbeat_at, completed_steps,
  checkpoint, last_error, last_error_class, cancel_requested_at, finished_at, updated_at)
  ON exec.job TO app_worker;
GRANT SELECT (id, workspace_id, queue, state, run_at, attempts, max_attempts, lease_token,
  lease_until, finished_at, created_at) ON exec.job TO pm_scheduler;
GRANT UPDATE (state, lease_token, lease_owner, lease_until, heartbeat_at, attempts, updated_at)
  ON exec.job TO pm_scheduler;
