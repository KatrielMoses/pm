-- migrate:phase expand
-- Phase 2D: bulk task commands and undo (0B ADR-24, ADR-0016). Short-lived, actor-owned rows.

-- ---------------------------------------------------------------------------------------------
-- Bulk operations (TSK-038): preview first over a bounded explicit set, then execute once.
-- Results carry identifiers and outcome codes only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE work.bulk_operation (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  operation text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  mode text NOT NULL,
  state text NOT NULL DEFAULT 'previewed',
  item_ids uuid[] NOT NULL,
  fingerprint bytea NOT NULL,
  results jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  executed_at timestamptz,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT bulk_operation_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT bulk_operation_public_id_format CHECK (public_id ~ '^bop_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT bulk_operation_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT bulk_operation_kind_known CHECK (operation IN ('set_status', 'set_priority', 'set_due_date',
    'add_label', 'remove_label', 'archive', 'trash')),
  CONSTRAINT bulk_operation_mode_known CHECK (mode IN ('atomic', 'partial')),
  CONSTRAINT bulk_operation_state_known CHECK (state IN ('previewed', 'executed', 'expired')),
  -- The database bound is the widest configurable BULK_ITEMS_MAX.
  CONSTRAINT bulk_operation_items CHECK (cardinality(item_ids) BETWEEN 1 AND 1000),
  CONSTRAINT bulk_operation_params CHECK (jsonb_typeof(params) = 'object' AND pg_column_size(params) <= 4096),
  CONSTRAINT bulk_operation_results CHECK ((results IS NULL) = (state <> 'executed')
    AND (results IS NULL OR jsonb_typeof(results) = 'array')),
  CONSTRAINT bulk_operation_executed_at CHECK ((executed_at IS NULL) = (state <> 'executed')),
  CONSTRAINT bulk_operation_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX bulk_operation_by_owner ON work.bulk_operation (workspace_id, owner_membership_id, created_at DESC);
CREATE INDEX bulk_operation_expiry ON work.bulk_operation (expires_at);

-- ---------------------------------------------------------------------------------------------
-- Undo (TSK-043): the inverse of one reversible mutation, for its actor, within the window.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE work.undo_entry (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  command text NOT NULL,
  targets jsonb NOT NULL,
  inverse jsonb NOT NULL,
  state text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT undo_entry_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT undo_entry_public_id_format CHECK (public_id ~ '^und_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT undo_entry_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT undo_entry_command_format CHECK (command ~ '^[a-z][a-z_.]{1,62}$'),
  CONSTRAINT undo_entry_targets CHECK (jsonb_typeof(targets) = 'array' AND jsonb_array_length(targets) BETWEEN 1 AND 1000),
  CONSTRAINT undo_entry_inverse CHECK (jsonb_typeof(inverse) = 'object' AND pg_column_size(inverse) <= 262144),
  CONSTRAINT undo_entry_state_known CHECK (state IN ('available', 'applied', 'expired', 'conflicted')),
  CONSTRAINT undo_entry_closed CHECK ((closed_at IS NULL) = (state = 'available')),
  -- The database bound is the widest configurable UNDO_WINDOW_SECONDS.
  CONSTRAINT undo_entry_window CHECK (expires_at > created_at AND expires_at <= created_at + interval '300 seconds'),
  CONSTRAINT undo_entry_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX undo_entry_by_owner ON work.undo_entry (workspace_id, owner_membership_id, created_at DESC);
CREATE INDEX undo_entry_expiry ON work.undo_entry (expires_at);

-- Both are one-way: previewed → executed | expired; available → applied | expired | conflicted.
CREATE FUNCTION work.bulk_undo_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.owner_membership_id <> OLD.owner_membership_id
     OR NEW.public_id <> OLD.public_id OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> (CASE TG_TABLE_NAME WHEN 'bulk_operation' THEN 'previewed' ELSE 'available' END) THEN
    RAISE EXCEPTION '% is closed', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bulk_operation_guard BEFORE UPDATE ON work.bulk_operation
  FOR EACH ROW EXECUTE FUNCTION work.bulk_undo_guard();
CREATE TRIGGER undo_entry_guard BEFORE UPDATE ON work.undo_entry
  FOR EACH ROW EXECUTE FUNCTION work.bulk_undo_guard();

-- Ordering commands (top, bottom, move to) read a sibling list within brand, project, and parent.
CREATE INDEX task_rank_by_brand ON work.task (workspace_id, brand_id, project_id, parent_task_id, rank, id);

ALTER TABLE work.bulk_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.bulk_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.bulk_operation
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.undo_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.undo_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.undo_entry
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON work.bulk_operation, work.undo_entry FROM PUBLIC;
-- The actor's own expired rows are removed when they create new ones (bounded, owner-scoped).
GRANT SELECT, INSERT, DELETE ON work.bulk_operation, work.undo_entry TO app_rw;
GRANT UPDATE (state, results, executed_at, version) ON work.bulk_operation TO app_rw;
GRANT UPDATE (state, closed_at, version) ON work.undo_entry TO app_rw;
-- The worker deletes expired rows and rows of departed members.
GRANT SELECT, DELETE ON work.bulk_operation, work.undo_entry TO app_worker;
REVOKE ALL ON FUNCTION work.bulk_undo_guard() FROM PUBLIC;
