-- migrate:phase expand
-- Idempotency keys (0B §9.6, 0D §5.2) and the external-effect ledger (0D §5.4).

CREATE TABLE exec.idempotency_key (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  principal_type exec.principal_type NOT NULL,
  principal_id uuid NOT NULL,
  key text NOT NULL,
  request_fingerprint bytea NOT NULL,
  state exec.idempotency_state NOT NULL DEFAULT 'in_progress',
  operation_id uuid,
  response_status integer,
  response_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_key_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT idempotency_key_scope_key UNIQUE (workspace_id, principal_id, key),
  CONSTRAINT idempotency_key_format CHECK (key ~ '^[A-Za-z0-9_.:-]{16,128}$'),
  CONSTRAINT idempotency_key_fingerprint_sha256 CHECK (octet_length(request_fingerprint) = 32),
  CONSTRAINT idempotency_key_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT idempotency_key_response_consistency CHECK (
    (state = 'in_progress' AND response_status IS NULL)
    OR (state = 'completed' AND response_status BETWEEN 100 AND 599)
    OR (state = 'failed_deterministic' AND response_status BETWEEN 400 AND 499)),
  -- Stored references only (PC-02): never a response body.
  CONSTRAINT idempotency_key_response_ref_shape CHECK (
    response_ref IS NULL OR (jsonb_typeof(response_ref) = 'object' AND pg_column_size(response_ref) <= 4096)),
  CONSTRAINT idempotency_key_operation_same_workspace FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id)
);
COMMENT ON TABLE exec.idempotency_key IS 'Deduplicates writes per (workspace, principal, key); replay re-renders references through current authorization (PC-02).';
CREATE INDEX idempotency_key_expiry ON exec.idempotency_key (workspace_id, expires_at);

CREATE TABLE exec.external_effect (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  effect_key text NOT NULL,
  destination_class exec.effect_destination_class NOT NULL,
  state exec.effect_state NOT NULL DEFAULT 'pending',
  provider_idempotency_key text,
  external_ref text,
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempt_id uuid,
  reconciliation_decision text,
  reconciled_by_actor_type exec.actor_type,
  reconciled_by uuid,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT external_effect_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT external_effect_key_per_operation UNIQUE (operation_id, effect_key),
  CONSTRAINT external_effect_operation_same_workspace FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id),
  CONSTRAINT external_effect_key_format CHECK (effect_key ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  CONSTRAINT external_effect_attempts_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT external_effect_reconciliation_decision_known CHECK (
    reconciliation_decision IS NULL OR reconciliation_decision IN ('sent', 'retry', 'abandon')),
  CONSTRAINT external_effect_reconciliation_complete CHECK (
    (reconciliation_decision IS NULL) = (reconciled_at IS NULL)
    AND (reconciled_at IS NULL) = (reconciled_by_actor_type IS NULL)),
  CONSTRAINT external_effect_version_nonnegative CHECK (version >= 0)
);
COMMENT ON TABLE exec.external_effect IS 'Effect ledger: stable key recorded before any attempt; unknown outcomes on unsafe destinations wait for reconciliation (never exactly once).';

-- Allowed transitions (0D §5.4). Terminal: confirmed, cancelled.
--   pending -> sent | unknown | failed | cancelled
--   sent    -> confirmed | unknown
--   unknown -> sent | confirmed | failed | cancelled | pending (retry: safe classes, or human decision)
--   failed  -> pending (retry) | cancelled
CREATE FUNCTION exec.external_effect_transition_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.operation_id <> OLD.operation_id
     OR NEW.effect_key <> OLD.effect_key OR NEW.destination_class <> OLD.destination_class THEN
    RAISE EXCEPTION 'external effect identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.state = 'pending' AND NEW.state IN ('sent', 'unknown', 'failed', 'cancelled'))
    OR (OLD.state = 'sent' AND NEW.state IN ('confirmed', 'unknown'))
    OR (OLD.state = 'unknown' AND NEW.state IN ('sent', 'confirmed', 'failed', 'cancelled', 'pending'))
    OR (OLD.state = 'failed' AND NEW.state IN ('pending', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'illegal external effect transition' USING ERRCODE = '55000';
  END IF;
  -- An unknown outcome on an unsafe destination is never retried automatically: moving it back to
  -- pending requires a recorded human reconciliation decision.
  IF OLD.state = 'unknown' AND NEW.state = 'pending' AND OLD.destination_class = 'unsafe'
     AND NEW.reconciliation_decision IS DISTINCT FROM 'retry' THEN
    RAISE EXCEPTION 'unsafe effect with unknown outcome needs reconciliation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER external_effect_transition_guard BEFORE UPDATE ON exec.external_effect
  FOR EACH ROW EXECUTE FUNCTION exec.external_effect_transition_guard();

ALTER TABLE exec.idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE exec.idempotency_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exec.idempotency_key
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
CREATE POLICY scheduler_discovery ON exec.idempotency_key FOR SELECT TO pm_scheduler USING (true);

ALTER TABLE exec.external_effect ENABLE ROW LEVEL SECURITY;
ALTER TABLE exec.external_effect FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exec.external_effect
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON exec.idempotency_key TO app_rw;
GRANT SELECT, UPDATE, DELETE ON exec.idempotency_key TO app_worker;
GRANT SELECT (workspace_id, expires_at) ON exec.idempotency_key TO pm_scheduler;

GRANT SELECT, INSERT, UPDATE ON exec.external_effect TO app_worker;
GRANT SELECT ON exec.external_effect TO app_rw;
GRANT UPDATE (state, reconciliation_decision, reconciled_by_actor_type, reconciled_by, reconciled_at,
  updated_at, version) ON exec.external_effect TO app_rw;
