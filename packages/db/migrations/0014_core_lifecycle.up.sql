-- migrate:phase expand
-- Record envelope and lifecycle primitives (0B §2.3, §8; Phase 1F).
--
-- * core.record is the addressable-record supertype: identity, scope, lifecycle, provenance, and no
--   domain fields. Typed tables (later phases) share the id and reference
--   (id, workspace_id, scope_key, lifecycle_state) through a DEFERRABLE composite foreign key.
-- * brand_id and owner_membership_id are plain references until 1C (tenancy.brand) and 1D
--   (memberships) add their foreign keys; see docs/engineering/lifecycle.md.
-- * Lifecycle filtering is a repository/query concern, NOT RLS: RLS isolates tenants only.
-- * Archive and deletion batches record exact membership so reversal touches only what the
--   batch changed. Purged envelopes remain as content-free tombstones.

CREATE SCHEMA core;
COMMENT ON SCHEMA core IS 'Record envelope, lifecycle batches, and tombstones (0B module core, layer 0).';
GRANT USAGE ON SCHEMA core TO app_rw, app_worker, audit_maintainer, pm_scheduler;

CREATE TYPE core.lifecycle_state AS ENUM ('active', 'archived', 'trashed', 'purged');
CREATE TYPE core.archive_cause AS ENUM ('self', 'cascade');
CREATE TYPE core.deletion_batch_state AS ENUM ('trashed', 'restoring', 'restored', 'purging', 'purged');

-- ---------------------------------------------------------------------------------------------
-- Registered record types: the 30 addressable types of the 0B model (checked against model.json by
-- the Phase 0 integration validator). Test fixtures may register a test_only type in test
-- databases; production migrations never do.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE core.record_type (
  record_type text PRIMARY KEY,
  public_id_prefix text NOT NULL,
  owner_module text NOT NULL,
  test_only boolean NOT NULL DEFAULT false,
  CONSTRAINT record_type_format CHECK (record_type ~ '^[a-z][a-z_]{1,40}$'),
  CONSTRAINT record_type_prefix_format CHECK (public_id_prefix ~ '^[a-z]{2,5}$'),
  CONSTRAINT record_type_prefix_key UNIQUE (public_id_prefix),
  CONSTRAINT record_type_owner_format CHECK (owner_module ~ '^[a-z_]{2,40}$')
);
INSERT INTO core.record_type (record_type, public_id_prefix, owner_module) VALUES
  ('brand', 'br', 'tenancy'),
  ('team', 'team', 'tenancy'),
  ('workflow', 'wf', 'workflow'),
  ('file', 'file', 'files'),
  ('deliverable', 'dlv', 'files'),
  ('project', 'prj', 'work'),
  ('milestone', 'ms', 'work'),
  ('task', 'tsk', 'work'),
  ('decision_record', 'dec', 'work'),
  ('inbox_item', 'inb', 'capture'),
  ('note', 'note', 'capture'),
  ('intake_form', 'form', 'capture'),
  ('work_block', 'blk', 'planning'),
  ('document', 'doc', 'knowledge'),
  ('goal', 'goal', 'goals'),
  ('key_result', 'kr', 'goals'),
  ('portfolio', 'pf', 'goals'),
  ('saved_view', 'view', 'views'),
  ('dashboard', 'dash', 'insights'),
  ('report_definition', 'rpt', 'insights'),
  ('connection', 'conn', 'integrations'),
  ('webhook_subscription', 'whk', 'integrations'),
  ('test_case', 'tc', 'quality'),
  ('test_suite', 'ts', 'quality'),
  ('test_run', 'tr', 'quality'),
  ('environment', 'env', 'delivery'),
  ('release', 'rel', 'delivery'),
  ('template', 'tpl', 'templates'),
  ('automation', 'auto', 'automation'),
  ('agent_profile', 'agt', 'agents');

-- {"container_record_id": uuid|null, "container_type": text|null}
CREATE FUNCTION core.valid_restore_location(v jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT jsonb_typeof(v) = 'object'
      AND ARRAY(SELECT jsonb_object_keys(v) ORDER BY 1) <@ ARRAY['container_record_id', 'container_type']
      AND (v->>'container_record_id' IS NULL
           OR v->>'container_record_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      AND (v->>'container_type' IS NULL OR v->>'container_type' ~ '^[a-z_]{1,64}$')
  $$;

-- ---------------------------------------------------------------------------------------------
-- Batches (created before core.record; the root foreign keys are added after it).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE core.archive_batch (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  root_record_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'archived',
  member_count integer NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  archived_by_type exec.actor_type NOT NULL,
  archived_by_id uuid,
  restored_at timestamptz,
  restored_by_type exec.actor_type,
  restored_by_id uuid,
  operation_id uuid,
  correlation_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT archive_batch_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT archive_batch_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT archive_batch_state_known CHECK (state IN ('archived', 'restored')),
  CONSTRAINT archive_batch_restored_consistency CHECK ((state = 'restored') = (restored_at IS NOT NULL AND restored_by_type IS NOT NULL)),
  CONSTRAINT archive_batch_member_count CHECK (member_count >= 1)
);

CREATE TABLE core.deletion_batch (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid GENERATED ALWAYS AS (coalesce(brand_id, workspace_id)) STORED,
  root_record_id uuid NOT NULL,
  state core.deletion_batch_state NOT NULL DEFAULT 'trashed',
  trashed_at timestamptz NOT NULL DEFAULT now(),
  trashed_by_type exec.actor_type NOT NULL,
  trashed_by_id uuid,
  -- {"container_record_id": uuid|null, "container_type": text|null}: where restore puts the root.
  restore_location jsonb NOT NULL,
  member_count integer NOT NULL,
  -- Purge-time block evaluation (holds and evidence locks), recorded explicitly.
  hold boolean NOT NULL DEFAULT false,
  evidence_locked_count integer NOT NULL DEFAULT 0,
  block_result text,
  operation_id uuid,
  restored_at timestamptz,
  restored_by_type exec.actor_type,
  restored_by_id uuid,
  purge_started_at timestamptz,
  purged_at timestamptz,
  ledger_entry_id text,
  ledger_acknowledged_at timestamptz,
  terminal_outcome text,
  correlation_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT deletion_batch_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT deletion_batch_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT deletion_batch_member_count CHECK (member_count >= 1),
  CONSTRAINT deletion_batch_restore_location CHECK (core.valid_restore_location(restore_location)),
  CONSTRAINT deletion_batch_block_result_known CHECK (block_result IS NULL OR block_result IN
    ('hold', 'evidence_lock_partial', 'evidence_lock_all', 'missing_purge_hook', 'ledger_unavailable')),
  CONSTRAINT deletion_batch_outcome_known CHECK (terminal_outcome IS NULL OR terminal_outcome IN
    ('restored', 'purged', 'purged_with_exclusions')),
  CONSTRAINT deletion_batch_terminal_consistency CHECK (
    (state = 'restored') = (terminal_outcome IS NOT DISTINCT FROM 'restored')
    AND (state = 'purged') = coalesce(terminal_outcome IN ('purged', 'purged_with_exclusions'), false)),
  CONSTRAINT deletion_batch_restored_fields CHECK ((state = 'restored') = (restored_at IS NOT NULL AND restored_by_type IS NOT NULL)),
  CONSTRAINT deletion_batch_purging_fields CHECK (state NOT IN ('purging', 'purged') OR (operation_id IS NOT NULL AND purge_started_at IS NOT NULL)),
  -- A purge is complete only once its ledger entry is durably acknowledged.
  CONSTRAINT deletion_batch_purged_fields CHECK ((state = 'purged') = (purged_at IS NOT NULL AND ledger_acknowledged_at IS NOT NULL AND ledger_entry_id IS NOT NULL)),
  CONSTRAINT deletion_batch_evidence_nonnegative CHECK (evidence_locked_count >= 0)
);
CREATE INDEX deletion_batch_by_state ON core.deletion_batch (workspace_id, state, trashed_at);

-- ---------------------------------------------------------------------------------------------
-- core.record
-- ---------------------------------------------------------------------------------------------
CREATE TABLE core.record (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  record_type text NOT NULL REFERENCES core.record_type (record_type) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid GENERATED ALWAYS AS (coalesce(brand_id, workspace_id)) STORED,
  owner_membership_id uuid,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  archive_cause core.archive_cause,
  archive_batch_id uuid,
  archived_at timestamptz,
  archived_by_type exec.actor_type,
  archived_by_id uuid,
  deletion_batch_id uuid,
  prior_lifecycle_state core.lifecycle_state,
  trashed_at timestamptz,
  trashed_by_type exec.actor_type,
  trashed_by_id uuid,
  purged_at timestamptz,
  source_kind text NOT NULL,
  source_ref text,
  template_installation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_actor_type exec.actor_type NOT NULL,
  created_by_actor_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT record_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT record_public_id_key UNIQUE (public_id),
  CONSTRAINT record_public_id_format CHECK (public_id ~ '^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- Composite keys typed tables and same-workspace references use.
  CONSTRAINT record_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT record_typed_key UNIQUE (id, workspace_id, scope_key, lifecycle_state),
  CONSTRAINT record_archive_batch_fkey FOREIGN KEY (workspace_id, archive_batch_id)
    REFERENCES core.archive_batch (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_deletion_batch_fkey FOREIGN KEY (workspace_id, deletion_batch_id)
    REFERENCES core.deletion_batch (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_source_kind_known CHECK (source_kind IN
    ('ui', 'api', 'paste', 'voice', 'email', 'form', 'webhook', 'import', 'integration', 'ai_proposal',
     'automation', 'agent', 'template', 'system')),
  CONSTRAINT record_source_ref_length CHECK (source_ref IS NULL OR char_length(source_ref) <= 200),
  CONSTRAINT record_creator_present CHECK (created_by_actor_type = 'system' OR created_by_actor_id IS NOT NULL),
  CONSTRAINT record_archive_fields CHECK (
    (archive_batch_id IS NULL) = (archive_cause IS NULL)
    AND (archive_batch_id IS NULL) = (archived_at IS NULL)
    AND (archive_batch_id IS NULL) = (archived_by_type IS NULL)),
  CONSTRAINT record_prior_state_known CHECK (prior_lifecycle_state IS NULL OR prior_lifecycle_state IN ('active', 'archived')),
  CONSTRAINT record_active_fields CHECK (lifecycle_state <> 'active' OR (
    archive_batch_id IS NULL AND deletion_batch_id IS NULL AND prior_lifecycle_state IS NULL
    AND trashed_at IS NULL AND purged_at IS NULL)),
  CONSTRAINT record_archived_fields CHECK (lifecycle_state <> 'archived' OR (
    archive_batch_id IS NOT NULL AND deletion_batch_id IS NULL AND prior_lifecycle_state IS NULL
    AND trashed_at IS NULL AND purged_at IS NULL)),
  CONSTRAINT record_trashed_fields CHECK (lifecycle_state <> 'trashed' OR (
    deletion_batch_id IS NOT NULL AND prior_lifecycle_state IS NOT NULL AND trashed_at IS NOT NULL
    AND trashed_by_type IS NOT NULL AND purged_at IS NULL
    AND (prior_lifecycle_state = 'archived') = (archive_batch_id IS NOT NULL))),
  -- Tombstones keep only structural fields: id, public_id, type, scope, creation and deletion facts.
  CONSTRAINT record_tombstone_fields CHECK (lifecycle_state <> 'purged' OR (
    purged_at IS NOT NULL AND trashed_at IS NOT NULL AND deletion_batch_id IS NOT NULL
    AND prior_lifecycle_state IS NULL AND archive_batch_id IS NULL AND owner_membership_id IS NULL
    AND source_ref IS NULL AND template_installation_id IS NULL)),
  CONSTRAINT record_version_nonnegative CHECK (version >= 0)
);
COMMENT ON TABLE core.record IS 'Addressable-record envelope (0B §2.3). Lifecycle filtering happens in repositories, not RLS. Purged rows are tombstones.';
CREATE INDEX record_active_by_type ON core.record (workspace_id, record_type) WHERE lifecycle_state = 'active';
CREATE INDEX record_by_archive_batch ON core.record (workspace_id, archive_batch_id) WHERE archive_batch_id IS NOT NULL;
CREATE INDEX record_by_deletion_batch ON core.record (workspace_id, deletion_batch_id) WHERE deletion_batch_id IS NOT NULL;

ALTER TABLE core.archive_batch ADD CONSTRAINT archive_batch_root_fkey
  FOREIGN KEY (workspace_id, root_record_id) REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT;
ALTER TABLE core.deletion_batch ADD CONSTRAINT deletion_batch_root_fkey
  FOREIGN KEY (workspace_id, root_record_id) REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT;

-- Exact batch membership (insert-only membership; per-member outcome is the only mutable column).
CREATE TABLE core.archive_batch_member (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL,
  record_id uuid NOT NULL,
  cause core.archive_cause NOT NULL,
  PRIMARY KEY (batch_id, record_id),
  CONSTRAINT archive_batch_member_batch_fkey FOREIGN KEY (workspace_id, batch_id)
    REFERENCES core.archive_batch (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT archive_batch_member_record_fkey FOREIGN KEY (workspace_id, record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE core.deletion_batch_member (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL,
  record_id uuid NOT NULL,
  record_type text NOT NULL REFERENCES core.record_type (record_type) ON DELETE RESTRICT,
  prior_lifecycle_state core.lifecycle_state NOT NULL,
  depth integer NOT NULL,
  outcome text NOT NULL DEFAULT 'pending',
  PRIMARY KEY (batch_id, record_id),
  CONSTRAINT deletion_batch_member_batch_fkey FOREIGN KEY (workspace_id, batch_id)
    REFERENCES core.deletion_batch (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT deletion_batch_member_record_fkey FOREIGN KEY (workspace_id, record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT deletion_batch_member_prior_known CHECK (prior_lifecycle_state IN ('active', 'archived')),
  CONSTRAINT deletion_batch_member_depth CHECK (depth >= 0),
  CONSTRAINT deletion_batch_member_outcome_known CHECK (outcome IN
    ('pending', 'restored', 'purged', 'excluded_evidence_lock'))
);
CREATE INDEX deletion_batch_member_by_record ON core.deletion_batch_member (workspace_id, record_id);

-- ---------------------------------------------------------------------------------------------
-- Guards: identity immutability, allowed lifecycle transitions, row-version increments, and
-- state machines for batches. Errors are check_violation so callers map them to typed failures.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION core.record_guard() RETURNS trigger
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
CREATE TRIGGER record_guard BEFORE UPDATE OR DELETE ON core.record
  FOR EACH ROW EXECUTE FUNCTION core.record_guard();

CREATE FUNCTION core.deletion_batch_guard() RETURNS trigger
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
CREATE TRIGGER deletion_batch_guard BEFORE UPDATE ON core.deletion_batch
  FOR EACH ROW EXECUTE FUNCTION core.deletion_batch_guard();

CREATE FUNCTION core.archive_batch_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.root_record_id <> OLD.root_record_id
     OR NEW.archived_at <> OLD.archived_at OR NEW.member_count <> OLD.member_count THEN
    RAISE EXCEPTION 'archive batch facts are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'restored' THEN
    RAISE EXCEPTION 'archive batch is terminal' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'archive batch version must increase by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER archive_batch_guard BEFORE UPDATE ON core.archive_batch
  FOR EACH ROW EXECUTE FUNCTION core.archive_batch_guard();

CREATE FUNCTION core.batch_member_guard() RETURNS trigger
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
CREATE TRIGGER archive_batch_member_guard BEFORE UPDATE OR DELETE ON core.archive_batch_member
  FOR EACH ROW EXECUTE FUNCTION core.batch_member_guard();
CREATE TRIGGER deletion_batch_member_guard BEFORE UPDATE OR DELETE ON core.deletion_batch_member
  FOR EACH ROW EXECUTE FUNCTION core.batch_member_guard();

-- ---------------------------------------------------------------------------------------------
-- RLS (tenant isolation only) and grants.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE core.record ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.record
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

ALTER TABLE core.archive_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.archive_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.archive_batch
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

ALTER TABLE core.archive_batch_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.archive_batch_member FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.archive_batch_member
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

ALTER TABLE core.deletion_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.deletion_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.deletion_batch
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
-- Payload-free purge discovery (exec_dispatch definer functions run as pm_scheduler).
CREATE POLICY scheduler_discovery ON core.deletion_batch FOR SELECT TO pm_scheduler USING (true);

ALTER TABLE core.deletion_batch_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.deletion_batch_member FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.deletion_batch_member
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON ALL TABLES IN SCHEMA core FROM PUBLIC;
GRANT SELECT ON core.record_type TO app_rw, app_worker, audit_maintainer;
GRANT SELECT, INSERT, UPDATE ON core.record, core.archive_batch, core.deletion_batch TO app_rw, app_worker;
GRANT SELECT, INSERT ON core.archive_batch_member TO app_rw, app_worker;
GRANT SELECT, INSERT, UPDATE (outcome) ON core.deletion_batch_member TO app_rw, app_worker;
-- Tombstone sweep only (the record guard refuses any other delete).
GRANT DELETE ON core.record TO app_worker;
GRANT SELECT (id, workspace_id, state, trashed_at, hold, operation_id) ON core.deletion_batch TO pm_scheduler;
GRANT SELECT (id, workspace_id, state, operation_id) ON core.deletion_batch TO audit_maintainer;
GRANT SELECT (workspace_id, batch_id, record_id, outcome) ON core.deletion_batch_member TO audit_maintainer;
GRANT SELECT (id, workspace_id, kind, execution_state) ON exec.operation TO audit_maintainer;
REVOKE ALL ON FUNCTION core.record_guard(), core.deletion_batch_guard(), core.archive_batch_guard(),
  core.batch_member_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION core.valid_restore_location(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.valid_restore_location(jsonb) TO app_rw, app_worker;

-- ---------------------------------------------------------------------------------------------
-- Guarded redaction procedure (0B §7.7). Runs as audit_maintainer; refuses unless:
--   * a workspace context is set and app.redaction_operation_id equals the purge operation;
--   * that operation is a running `purge` in this workspace and owns a batch in `purging`.
-- Replaces value-bearing entries of events whose target is a non-excluded batch member with a
-- redaction marker (digest kept), and records each redaction in audit.audit_redaction.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION audit.redact_purged_values(
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
-- Privileges first, then the ownership transfer (the ACL carries over; 0008 pattern).
REVOKE ALL ON FUNCTION audit.redact_purged_values(uuid, uuid, exec.actor_type, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.redact_purged_values(uuid, uuid, exec.actor_type, uuid, uuid) TO app_worker;
-- A new owner needs CREATE on the schema for the transfer only; it is revoked immediately after.
GRANT CREATE ON SCHEMA audit TO audit_maintainer;
ALTER FUNCTION audit.redact_purged_values(uuid, uuid, exec.actor_type, uuid, uuid) OWNER TO audit_maintainer;
REVOKE CREATE ON SCHEMA audit FROM audit_maintainer;
