-- Reverts 0016 (local/test only). Moved memberships return to the legacy exclusion outcome.
GRANT CREATE ON SCHEMA audit TO audit_maintainer;
SET LOCAL ROLE audit_maintainer;
CREATE OR REPLACE FUNCTION audit.redact_purged_values(
  p_operation_id uuid, p_batch_id uuid, p_authorized_by_type exec.actor_type,
  p_authorized_by_id uuid, p_correlation_id uuid)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ws uuid := exec.current_workspace_id();
  ev record;
  item record;
  new_changes jsonb;
  redacted text[];
  n integer := 0;
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'redaction requires a workspace context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(current_setting('app.redaction_operation_id', true), '') <> p_operation_id::text THEN
    RAISE EXCEPTION 'redaction operation is not set for this transaction' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM exec.operation o WHERE o.id = p_operation_id AND o.workspace_id = ws
                 AND o.kind = 'purge' AND o.execution_state = 'running') THEN
    RAISE EXCEPTION 'redaction requires a running purge operation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.deletion_batch b WHERE b.id = p_batch_id AND b.workspace_id = ws
                 AND b.state = 'purging' AND b.operation_id = p_operation_id) THEN
    RAISE EXCEPTION 'redaction requires a purging batch owned by the operation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR ev IN
    SELECT a.occurred_at, a.id, a.changes FROM audit.audit_event a
    WHERE a.workspace_id = ws AND a.target_record_id IN (
      SELECT m.record_id FROM core.deletion_batch_member m
      WHERE m.workspace_id = ws AND m.batch_id = p_batch_id AND m.outcome <> 'excluded_evidence_lock')
    ORDER BY a.chain_seq
    FOR UPDATE
  LOOP
    new_changes := '[]'::jsonb;
    redacted := '{}';
    FOR item IN SELECT value AS e FROM jsonb_array_elements(ev.changes) WITH ORDINALITY ORDER BY ordinality LOOP
      IF NOT (item.e ? 'redacted') AND item.e->>'class' IN ('plain', 'content', 'personal', 'credential_ref') THEN
        new_changes := new_changes || jsonb_build_array(jsonb_build_object(
          'field', item.e->'field', 'class', item.e->'class', 'digest', item.e->'digest',
          'redacted', true, 'reason', 'purge'));
        redacted := redacted || (item.e->>'field');
      ELSE
        new_changes := new_changes || jsonb_build_array(item.e);
      END IF;
    END LOOP;
    IF cardinality(redacted) > 0 THEN
      UPDATE audit.audit_event SET changes = new_changes
        WHERE occurred_at = ev.occurred_at AND id = ev.id;
      INSERT INTO audit.audit_redaction (id, workspace_id, audit_event_id, audit_event_occurred_at, fields,
        reason, authorized_by_type, authorized_by_id, operation_id, correlation_id)
      VALUES (uuidv7(), ws, ev.id, ev.occurred_at, redacted, 'purge', p_authorized_by_type,
        p_authorized_by_id, p_operation_id, p_correlation_id);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END
$$;
SET LOCAL ROLE pm_owner;
REVOKE CREATE ON SCHEMA audit FROM audit_maintainer;
REVOKE SELECT (successor_batch_id) ON core.deletion_batch_member FROM audit_maintainer;
CREATE OR REPLACE FUNCTION core.record_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only the final tombstone sweep (a retention hook, disabled while its period is unset).
    IF OLD.lifecycle_state <> 'purged' THEN
      RAISE EXCEPTION 'only tombstones may be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.public_id <> OLD.public_id OR NEW.record_type <> OLD.record_type
     OR NEW.workspace_id <> OLD.workspace_id OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
     OR NEW.created_at <> OLD.created_at OR NEW.created_by_actor_type <> OLD.created_by_actor_type
     OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id THEN
    RAISE EXCEPTION 'record identity and scope are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.lifecycle_state = 'purged' THEN
    RAISE EXCEPTION 'tombstones are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lifecycle_state <> OLD.lifecycle_state AND NOT (
       (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state IN ('archived', 'trashed'))
    OR (OLD.lifecycle_state = 'archived' AND NEW.lifecycle_state IN ('active', 'trashed'))
    OR (OLD.lifecycle_state = 'trashed' AND NEW.lifecycle_state IN ('active', 'archived', 'purged'))) THEN
    RAISE EXCEPTION 'lifecycle transition % -> % is not allowed', OLD.lifecycle_state, NEW.lifecycle_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'record version must increase by one' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE OR REPLACE FUNCTION core.deletion_batch_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.root_record_id <> OLD.root_record_id
     OR NEW.trashed_at <> OLD.trashed_at OR NEW.restore_location <> OLD.restore_location
     OR NEW.member_count <> OLD.member_count OR NEW.brand_id IS DISTINCT FROM OLD.brand_id THEN
    RAISE EXCEPTION 'deletion batch facts are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('restored', 'purged') THEN
    RAISE EXCEPTION 'deletion batch is terminal (%)', OLD.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'trashed' AND NEW.state IN ('restoring', 'purging'))
    OR (OLD.state = 'restoring' AND NEW.state IN ('restored', 'trashed'))
    OR (OLD.state = 'purging' AND NEW.state IN ('purged', 'trashed'))) THEN
    RAISE EXCEPTION 'deletion batch transition % -> % is not allowed', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'deletion batch version must increase by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE OR REPLACE FUNCTION core.batch_member_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'batch membership is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'deletion_batch_member'
     AND (to_jsonb(NEW) - 'outcome') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'outcome') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'batch membership is immutable' USING ERRCODE = 'check_violation';
END
$$;
REVOKE UPDATE (successor_batch_id) ON core.deletion_batch_member FROM app_rw, app_worker;
DROP INDEX core.deletion_batch_member_active;
ALTER TABLE core.deletion_batch_member DROP CONSTRAINT deletion_batch_member_successor_consistency;
ALTER TABLE core.deletion_batch_member DROP CONSTRAINT deletion_batch_member_outcome_known;
ALTER TABLE core.deletion_batch_member DISABLE TRIGGER deletion_batch_member_guard;
UPDATE core.deletion_batch_member SET outcome = 'excluded_evidence_lock' WHERE outcome = 'moved_to_successor';
ALTER TABLE core.deletion_batch_member ENABLE TRIGGER deletion_batch_member_guard;
ALTER TABLE core.deletion_batch_member ADD CONSTRAINT deletion_batch_member_outcome_known CHECK (outcome IN
  ('pending', 'restored', 'purged', 'excluded_evidence_lock'));
DROP INDEX core.deletion_batch_member_by_successor;
ALTER TABLE core.deletion_batch_member DROP CONSTRAINT deletion_batch_member_successor_fkey;
ALTER TABLE core.deletion_batch_member DROP COLUMN successor_batch_id;
DROP INDEX core.deletion_batch_by_split_from;
ALTER TABLE core.deletion_batch DROP CONSTRAINT deletion_batch_split_lineage;
ALTER TABLE core.deletion_batch DROP CONSTRAINT deletion_batch_split_from_fkey;
ALTER TABLE core.deletion_batch DROP COLUMN split_operation_id;
ALTER TABLE core.deletion_batch DROP COLUMN split_from_batch_id;
