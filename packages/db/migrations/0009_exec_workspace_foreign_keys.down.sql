CREATE OR REPLACE FUNCTION exec.attempt_guard() RETURNS trigger
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
ALTER TABLE exec.external_effect DROP CONSTRAINT external_effect_workspace_fkey;
ALTER TABLE exec.idempotency_key DROP CONSTRAINT idempotency_key_workspace_fkey;
ALTER TABLE exec.inbox_receipt DROP CONSTRAINT inbox_receipt_workspace_fkey;
ALTER TABLE exec.outbox_event DROP CONSTRAINT outbox_event_workspace_fkey;
ALTER TABLE exec.job DROP CONSTRAINT job_workspace_fkey;
ALTER TABLE exec.attempt DROP CONSTRAINT attempt_workspace_fkey;
ALTER TABLE exec.operation DROP CONSTRAINT operation_workspace_fkey;
CREATE INDEX job_by_operation ON exec.job (workspace_id, operation_id) WHERE operation_id IS NOT NULL;
DROP INDEX exec.job_by_workspace_operation;
DROP INDEX exec.operation_by_rerun;
DROP INDEX exec.external_effect_by_workspace_operation;
DROP INDEX exec.idempotency_key_by_workspace_operation;
DROP INDEX exec.outbox_event_by_workspace_operation;
