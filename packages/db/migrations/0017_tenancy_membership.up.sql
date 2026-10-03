-- migrate:phase expand
-- Phase 1C tenancy foundation: the workspace anchor extended in place, the canonical membership
-- table (1D extends it; never replaced), built-in role definitions, scope role assignments,
-- permission epochs, last-owner protection, and the account→workspace directory.
--
-- Authority model (0C §3-§4): a membership holds exactly one workspace role assignment (1C creates
-- only the bootstrap `owner`); brand grants are role assignments at brand scope whose role is a
-- scope level (`scope_view` … `scope_manage`). Nothing derives authority from who created a row.

-- ---------------------------------------------------------------------------------------------
-- Workspace anchor (extended in place; IDs and execution foreign keys unchanged)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE tenancy.workspace ADD COLUMN logo_file_ref text;
ALTER TABLE tenancy.workspace ADD COLUMN creation_key_hash bytea;
ALTER TABLE tenancy.workspace ADD COLUMN creation_request_hash bytea;
ALTER TABLE tenancy.workspace ADD COLUMN bootstrap_account_id uuid REFERENCES identity.account (id) ON DELETE RESTRICT;
ALTER TABLE tenancy.workspace ADD COLUMN bootstrap_membership_id uuid;
ALTER TABLE tenancy.workspace ADD CONSTRAINT workspace_logo_file_ref_format
  CHECK (logo_file_ref IS NULL OR logo_file_ref ~ '^file_[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE tenancy.workspace ADD CONSTRAINT workspace_creation_key_length
  CHECK (creation_key_hash IS NULL OR octet_length(creation_key_hash) = 32);
-- The request fingerprint of the creating call: a retry with the same key but another body is a
-- key reuse, never a silent replay (0D §8).
ALTER TABLE tenancy.workspace ADD CONSTRAINT workspace_creation_request_length
  CHECK ((creation_request_hash IS NULL) = (creation_key_hash IS NULL)
    AND (creation_request_hash IS NULL OR octet_length(creation_request_hash) = 32));
-- Idempotent creation: one workspace per (account, Idempotency-Key) digest, globally.
ALTER TABLE tenancy.workspace ADD CONSTRAINT workspace_creation_key_unique UNIQUE (creation_key_hash);
ALTER TABLE tenancy.workspace ADD CONSTRAINT workspace_bootstrap_provenance
  CHECK ((bootstrap_account_id IS NULL) = (creation_key_hash IS NULL));
COMMENT ON COLUMN tenancy.workspace.bootstrap_account_id IS 'Provenance only (who created the workspace). Never authority: authority is tenancy.membership + access.role_assignment.';

-- ---------------------------------------------------------------------------------------------
-- tenancy.membership (canonical; 1D adds invitation, suspension, removal, and management)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE tenancy.membership (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES identity.account (id) ON DELETE RESTRICT,
  kind text NOT NULL,
  state text NOT NULL,
  display_name_override text,
  invited_at timestamptz,
  joined_at timestamptz,
  suspended_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT membership_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT membership_public_id_key UNIQUE (public_id),
  CONSTRAINT membership_public_id_format CHECK (public_id ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT membership_account_unique UNIQUE (workspace_id, account_id),
  CONSTRAINT membership_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT membership_kind_known CHECK (kind IN ('member', 'guest')),
  CONSTRAINT membership_state_known CHECK (state IN ('invited', 'active', 'suspended', 'removed')),
  CONSTRAINT membership_active_joined CHECK (state NOT IN ('active', 'suspended') OR joined_at IS NOT NULL),
  CONSTRAINT membership_suspended_fields CHECK ((state = 'suspended') = (suspended_at IS NOT NULL)),
  CONSTRAINT membership_removed_fields CHECK ((state = 'removed') = (removed_at IS NOT NULL)),
  CONSTRAINT membership_display_name_length CHECK (display_name_override IS NULL OR char_length(display_name_override) BETWEEN 1 AND 120),
  CONSTRAINT membership_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX membership_by_account ON tenancy.membership (account_id, state);

ALTER TABLE tenancy.workspace ADD CONSTRAINT workspace_bootstrap_membership_fkey
  FOREIGN KEY (id, bootstrap_membership_id) REFERENCES tenancy.membership (workspace_id, id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX workspace_by_bootstrap_membership ON tenancy.workspace (id, bootstrap_membership_id);
CREATE INDEX workspace_by_bootstrap_account ON tenancy.workspace (bootstrap_account_id);

-- ---------------------------------------------------------------------------------------------
-- access.role: built-in definitions seeded per workspace (deterministic keys); custom roles (1D)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE access.role (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  key text NOT NULL,
  kind text NOT NULL,
  level text,
  builtin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT role_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT role_key_unique UNIQUE (workspace_id, key),
  CONSTRAINT role_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT role_kind_key UNIQUE (workspace_id, id, kind),
  CONSTRAINT role_kind_known CHECK (kind IN ('workspace_role', 'scope_level')),
  CONSTRAINT role_level_known CHECK (level IS NULL OR level IN ('view', 'comment', 'edit', 'manage')),
  CONSTRAINT role_scope_level CHECK ((kind = 'scope_level') = (level IS NOT NULL)),
  CONSTRAINT role_key_format CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  CONSTRAINT role_builtin_keys CHECK (NOT builtin OR key IN ('owner', 'administrator', 'member',
    'limited_member', 'read_only', 'guest', 'scope_view', 'scope_comment', 'scope_edit', 'scope_manage'))
);

-- Deterministic built-in seed for a new workspace (0C §3.1 roles; §3.2 levels).
CREATE FUNCTION access.seed_builtin_roles(p_workspace_id uuid) RETURNS void
  LANGUAGE sql
  SET search_path = pg_catalog, pg_temp
  AS $$
  INSERT INTO access.role (id, workspace_id, key, kind, level, builtin)
  SELECT uuidv7(), p_workspace_id, r.key, r.kind, r.level, true
  FROM (VALUES
    ('owner', 'workspace_role', NULL), ('administrator', 'workspace_role', NULL),
    ('member', 'workspace_role', NULL), ('limited_member', 'workspace_role', NULL),
    ('read_only', 'workspace_role', NULL), ('guest', 'workspace_role', NULL),
    ('scope_view', 'scope_level', 'view'), ('scope_comment', 'scope_level', 'comment'),
    ('scope_edit', 'scope_level', 'edit'), ('scope_manage', 'scope_level', 'manage')
  ) AS r(key, kind, level)
  ORDER BY r.key
$$;

-- ---------------------------------------------------------------------------------------------
-- access.role_assignment: workspace roles and scope grants (brand scope in 1C)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE access.role_assignment (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  principal_type text NOT NULL,
  principal_id uuid NOT NULL,
  membership_principal_id uuid GENERATED ALWAYS AS (CASE WHEN principal_type = 'membership' THEN principal_id END) STORED,
  scope_type text NOT NULL,
  scope_id uuid NOT NULL,
  brand_scope_id uuid GENERATED ALWAYS AS (CASE WHEN scope_type = 'brand' THEN scope_id END) STORED,
  role_id uuid NOT NULL,
  role_kind text NOT NULL,
  grant_source text NOT NULL,
  granted_by_membership_id uuid,
  expires_at timestamptz,
  elevated boolean NOT NULL DEFAULT false,
  elevation_reason text,
  elevation_step_up_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT role_assignment_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT role_assignment_unique UNIQUE (principal_type, principal_id, scope_type, scope_id, role_id),
  CONSTRAINT role_assignment_principal_known CHECK (principal_type IN ('membership', 'team', 'service_principal')),
  CONSTRAINT role_assignment_scope_known CHECK (scope_type IN ('workspace', 'brand', 'project', 'record')),
  CONSTRAINT role_assignment_workspace_scope CHECK (scope_type <> 'workspace' OR scope_id = workspace_id),
  CONSTRAINT role_assignment_role_matches_scope CHECK ((scope_type = 'workspace') = (role_kind = 'workspace_role')),
  CONSTRAINT role_assignment_source_known CHECK (grant_source IN ('bootstrap_owner', 'brand_creator', 'sensitivity_creator', 'assigned', 'elevation')),
  CONSTRAINT role_assignment_elevation CHECK (NOT elevated OR (expires_at IS NOT NULL AND elevation_reason IS NOT NULL)),
  CONSTRAINT role_assignment_role_fkey FOREIGN KEY (workspace_id, role_id, role_kind)
    REFERENCES access.role (workspace_id, id, kind) ON DELETE RESTRICT,
  CONSTRAINT role_assignment_membership_fkey FOREIGN KEY (workspace_id, membership_principal_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
-- One workspace role per principal.
CREATE UNIQUE INDEX role_assignment_one_workspace_role ON access.role_assignment (workspace_id, principal_type, principal_id)
  WHERE scope_type = 'workspace';
CREATE INDEX role_assignment_by_principal ON access.role_assignment (workspace_id, membership_principal_id, scope_type);
CREATE INDEX role_assignment_by_brand ON access.role_assignment (workspace_id, brand_scope_id);
CREATE INDEX role_assignment_by_role ON access.role_assignment (workspace_id, role_id, role_kind);

-- ---------------------------------------------------------------------------------------------
-- Last-owner protection (0C §3.1, AT-071): at commit, every live workspace keeps at least one
-- active membership holding the owner role. Checked on any change to memberships or assignments.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION access.assert_workspace_has_owner() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ws uuid := coalesce(OLD.workspace_id, NEW.workspace_id);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenancy.workspace w WHERE w.id = ws AND w.state IN ('active', 'read_only')) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM access.role_assignment a
    JOIN access.role r ON r.workspace_id = a.workspace_id AND r.id = a.role_id
    JOIN tenancy.membership m ON m.workspace_id = a.workspace_id AND m.id = a.membership_principal_id
    WHERE a.workspace_id = ws AND a.scope_type = 'workspace' AND r.key = 'owner' AND m.state = 'active') THEN
    RAISE EXCEPTION 'a workspace must keep at least one active owner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER role_assignment_keeps_owner AFTER UPDATE OR DELETE ON access.role_assignment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.assert_workspace_has_owner();
CREATE CONSTRAINT TRIGGER membership_keeps_owner AFTER UPDATE OR DELETE ON tenancy.membership
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.assert_workspace_has_owner();

-- A live workspace must have its bootstrap owner at commit (no ownerless workspace is ever created).
CREATE FUNCTION tenancy.assert_new_workspace_owned() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.bootstrap_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM access.role_assignment a
    JOIN access.role r ON r.workspace_id = a.workspace_id AND r.id = a.role_id
    JOIN tenancy.membership m ON m.workspace_id = a.workspace_id AND m.id = a.membership_principal_id
    WHERE a.workspace_id = NEW.id AND a.scope_type = 'workspace' AND r.key = 'owner' AND m.state = 'active'
      AND m.account_id = NEW.bootstrap_account_id) THEN
    RAISE EXCEPTION 'a new workspace must be created with its bootstrap owner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER workspace_created_with_owner AFTER INSERT ON tenancy.workspace
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenancy.assert_new_workspace_owned();

-- ---------------------------------------------------------------------------------------------
-- access.permission_epoch (0C §13.5): monotonic, bumped with every authorization change
-- ---------------------------------------------------------------------------------------------
CREATE TABLE access.permission_epoch (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  epoch_kind text NOT NULL,
  subject_id uuid,
  epoch bigint NOT NULL DEFAULT 0,
  bumped_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permission_epoch_kind_known CHECK (epoch_kind IN ('workspace', 'principal', 'agent_class')),
  CONSTRAINT permission_epoch_subject CHECK ((epoch_kind = 'workspace') = (subject_id IS NULL)),
  CONSTRAINT permission_epoch_nonnegative CHECK (epoch >= 0),
  CONSTRAINT permission_epoch_unique UNIQUE NULLS NOT DISTINCT (workspace_id, epoch_kind, subject_id)
);
CREATE FUNCTION access.permission_epoch_monotonic() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.epoch < OLD.epoch OR NEW.workspace_id <> OLD.workspace_id OR NEW.epoch_kind <> OLD.epoch_kind
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id THEN
    RAISE EXCEPTION 'permission epochs never decrease' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER permission_epoch_monotonic BEFORE UPDATE ON access.permission_epoch
  FOR EACH ROW EXECUTE FUNCTION access.permission_epoch_monotonic();

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE tenancy.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.membership
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE access.role ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.role FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access.role
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE access.role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.role_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access.role_assignment
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE access.permission_epoch ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.permission_epoch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access.permission_epoch
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON tenancy.membership, access.role, access.role_assignment, access.permission_epoch FROM PUBLIC;
GRANT SELECT, INSERT ON tenancy.membership TO app_rw;
GRANT SELECT ON tenancy.membership TO app_worker;
GRANT SELECT, INSERT ON access.role, access.role_assignment TO app_rw;
GRANT SELECT ON access.role, access.role_assignment TO app_worker;
GRANT SELECT, INSERT, UPDATE (epoch, bumped_at) ON access.permission_epoch TO app_rw;
GRANT SELECT ON access.permission_epoch TO app_worker;
-- 1C exposes no membership, role, or assignment change (1D owns them): no UPDATE/DELETE grants.
-- Workspace updates are limited to settings columns (state and provenance never change in 1C).
REVOKE UPDATE ON tenancy.workspace FROM app_rw;
GRANT UPDATE (name, logo_file_ref, timezone, locale, currency, week_start, updated_at, updated_by_actor_type,
  updated_by_actor_id, version) ON tenancy.workspace TO app_rw;
REVOKE ALL ON FUNCTION access.seed_builtin_roles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access.seed_builtin_roles(uuid) TO app_rw;
REVOKE ALL ON FUNCTION access.assert_workspace_has_owner(), tenancy.assert_new_workspace_owned(),
  access.permission_epoch_monotonic() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Account → workspace directory (definer functions owned by pm_directory). They return only the
-- calling account's own active memberships; the API passes the authenticated account id from the
-- session, never from request data. Platform scope only: no tenant rows are exposed beyond that.
-- ---------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA tenancy, exec TO pm_directory;
CREATE POLICY directory_lookup ON tenancy.membership FOR SELECT TO pm_directory USING (true);
CREATE POLICY directory_lookup ON tenancy.workspace FOR SELECT TO pm_directory USING (true);
GRANT SELECT (id, workspace_id, account_id, state, public_id) ON tenancy.membership TO pm_directory;
GRANT SELECT (id, public_id, name, state, creation_key_hash, creation_request_hash, bootstrap_account_id) ON tenancy.workspace TO pm_directory;

CREATE FUNCTION tenancy.account_workspaces(p_account_id uuid)
  RETURNS TABLE (workspace_id uuid, workspace_public_id text, name text, membership_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.id, w.public_id, w.name, m.id
  FROM tenancy.membership m JOIN tenancy.workspace w ON w.id = m.workspace_id
  WHERE exec.in_platform_scope() AND m.account_id = p_account_id AND m.state = 'active'
    AND w.state IN ('active', 'read_only')
  ORDER BY w.name, w.id
  LIMIT 200
$$;

CREATE FUNCTION tenancy.resolve_membership(p_account_id uuid, p_workspace_public_id text)
  RETURNS TABLE (workspace_id uuid, membership_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.id, m.id
  FROM tenancy.workspace w JOIN tenancy.membership m ON m.workspace_id = w.id
  WHERE exec.in_platform_scope() AND w.public_id = p_workspace_public_id AND m.account_id = p_account_id
    AND m.state = 'active' AND w.state IN ('active', 'read_only')
$$;

CREATE FUNCTION tenancy.workspace_by_creation_key(p_account_id uuid, p_key_hash bytea)
  RETURNS TABLE (workspace_id uuid, workspace_public_id text, request_hash bytea)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.id, w.public_id, w.creation_request_hash FROM tenancy.workspace w
  WHERE exec.in_platform_scope() AND w.creation_key_hash = p_key_hash AND w.bootstrap_account_id = p_account_id
$$;

REVOKE ALL ON FUNCTION tenancy.account_workspaces(uuid), tenancy.resolve_membership(uuid, text),
  tenancy.workspace_by_creation_key(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy.account_workspaces(uuid), tenancy.resolve_membership(uuid, text),
  tenancy.workspace_by_creation_key(uuid, bytea) TO app_rw;
GRANT CREATE ON SCHEMA tenancy TO pm_directory;
ALTER FUNCTION tenancy.account_workspaces(uuid) OWNER TO pm_directory;
ALTER FUNCTION tenancy.resolve_membership(uuid, text) OWNER TO pm_directory;
ALTER FUNCTION tenancy.workspace_by_creation_key(uuid, bytea) OWNER TO pm_directory;
REVOKE CREATE ON SCHEMA tenancy FROM pm_directory;
