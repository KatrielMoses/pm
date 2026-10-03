-- migrate:phase expand
-- Database-enforced workspace existence for every tenant execution row (1A review 01, D2
-- rejected). ON DELETE RESTRICT: a workspace cannot be deleted while execution history remains;
-- the audited workspace purge removes child rows in module order first (docs/engineering/database.md).
-- Constraints are added NOT VALID and then validated, the online-safe pattern for populated tables.
-- No initialization cycle: exec vocabularies (0001) precede tenancy.workspace (0003), which
-- precedes these constraints.

-- Supporting indexes: every foreign key has an index leading with its referencing columns.
CREATE INDEX outbox_event_by_workspace_operation ON exec.outbox_event (workspace_id, operation_id);
CREATE INDEX idempotency_key_by_workspace_operation ON exec.idempotency_key (workspace_id, operation_id);
CREATE INDEX external_effect_by_workspace_operation ON exec.external_effect (workspace_id, operation_id);
CREATE INDEX operation_by_rerun ON exec.operation (workspace_id, rerun_of_operation_id);
-- Replace the partial (operation_id IS NOT NULL) index with a full one usable by FK checks.
CREATE INDEX job_by_workspace_operation ON exec.job (workspace_id, operation_id);
DROP INDEX exec.job_by_operation;

ALTER TABLE exec.operation ADD CONSTRAINT operation_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES tenancy.workspace (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE exec.attempt ADD CONSTRAINT attempt_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES tenancy.workspace (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE exec.job ADD CONSTRAINT job_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES tenancy.workspace (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE exec.outbox_event ADD CONSTRAINT outbox_event_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES tenancy.workspace (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE exec.inbox_receipt ADD CONSTRAINT inbox_receipt_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES tenancy.workspace (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE exec.idempotency_key ADD CONSTRAINT idempotency_key_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES tenancy.workspace (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE exec.external_effect ADD CONSTRAINT external_effect_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES tenancy.workspace (id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE exec.operation VALIDATE CONSTRAINT operation_workspace_fkey;
ALTER TABLE exec.attempt VALIDATE CONSTRAINT attempt_workspace_fkey;
ALTER TABLE exec.job VALIDATE CONSTRAINT job_workspace_fkey;
ALTER TABLE exec.outbox_event VALIDATE CONSTRAINT outbox_event_workspace_fkey;
ALTER TABLE exec.inbox_receipt VALIDATE CONSTRAINT inbox_receipt_workspace_fkey;
ALTER TABLE exec.idempotency_key VALIDATE CONSTRAINT idempotency_key_workspace_fkey;
ALTER TABLE exec.external_effect VALIDATE CONSTRAINT external_effect_workspace_fkey;

-- Attempts stay append-only, with one sanctioned exception: an explicit workspace purge.
-- Deletion requires (a) DELETE privilege, which no application role holds, and (b) the
-- transaction-local purge marker naming the attempt's own workspace.
CREATE OR REPLACE FUNCTION exec.attempt_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.purge_workspace_id', true) = OLD.workspace_id::text THEN
      RETURN OLD;
    END IF;
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
