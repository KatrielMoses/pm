-- migrate:phase expand
-- Phase 3A (0B ADR-26, 0C AZ-26, 0D PL-28): saved views and view defaults; pin writes.
--
-- A saved view is a stored, versioned query AST plus presentation. It never grants access: running
-- one compiles the viewer's own authorization predicate (0B §4.7, 0C §8). Views are workspace-level
-- records (core.record brand is NULL; record scope is immutable), owned by the person who created
-- them. Personal views are visible only to their owner. Sharing names exactly one scope (workspace,
-- brand, or project), is revocable, and never widens record access.

CREATE TABLE views.saved_view (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  entity text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_membership_id uuid NOT NULL,
  visibility text NOT NULL DEFAULT 'personal',
  share_scope text,
  share_brand_id uuid,
  share_project_id uuid,
  schema_version integer NOT NULL DEFAULT 1,
  query jsonb NOT NULL,
  presentation jsonb NOT NULL DEFAULT '{}',
  layout text NOT NULL DEFAULT 'list',
  shared_at timestamptz,
  shared_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT saved_view_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT saved_view_scope_is_workspace CHECK (scope_key = workspace_id),
  CONSTRAINT saved_view_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saved_view_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT saved_view_share_brand_fkey FOREIGN KEY (workspace_id, share_brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT saved_view_share_project_fkey FOREIGN KEY (workspace_id, share_brand_id, share_project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT saved_view_shared_by_fkey FOREIGN KEY (workspace_id, shared_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT saved_view_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT saved_view_entity_known CHECK (entity IN ('task', 'project')),
  CONSTRAINT saved_view_layout_known CHECK (layout IN ('list')),
  CONSTRAINT saved_view_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 120 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 120)),
  CONSTRAINT saved_view_description CHECK (char_length(description) <= 1000),
  CONSTRAINT saved_view_visibility_known CHECK (visibility IN ('personal', 'shared')),
  -- Exactly one share scope for a shared view; none for a personal one.
  CONSTRAINT saved_view_share_shape CHECK (
    (visibility = 'personal' AND share_scope IS NULL AND share_brand_id IS NULL AND share_project_id IS NULL
      AND shared_at IS NULL AND shared_by_membership_id IS NULL)
    OR (visibility = 'shared' AND shared_at IS NOT NULL AND shared_by_membership_id IS NOT NULL AND (
      (share_scope = 'workspace' AND share_brand_id IS NULL AND share_project_id IS NULL)
      OR (share_scope = 'brand' AND share_brand_id IS NOT NULL AND share_project_id IS NULL)
      OR (share_scope = 'project' AND share_brand_id IS NOT NULL AND share_project_id IS NOT NULL)))),
  CONSTRAINT saved_view_schema_version_range CHECK (schema_version BETWEEN 1 AND 1000),
  -- Hard ceilings; the configured QUERY_* bounds are lower and enforced by the service.
  CONSTRAINT saved_view_query_bounded CHECK (jsonb_typeof(query) = 'object' AND octet_length(query::text) <= 32768),
  CONSTRAINT saved_view_presentation_bounded CHECK (
    jsonb_typeof(presentation) = 'object' AND octet_length(presentation::text) <= 8192),
  CONSTRAINT saved_view_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX saved_view_by_envelope ON views.saved_view (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX saved_view_by_owner ON views.saved_view (workspace_id, owner_membership_id, name, id);
CREATE INDEX saved_view_by_share_brand ON views.saved_view (workspace_id, share_brand_id);
CREATE INDEX saved_view_by_share_project ON views.saved_view (workspace_id, share_brand_id, share_project_id);
CREATE INDEX saved_view_by_shared ON views.saved_view (workspace_id, visibility, name, id);
CREATE INDEX saved_view_by_shared_by ON views.saved_view (workspace_id, shared_by_membership_id);
CREATE INDEX saved_view_by_updater ON views.saved_view (workspace_id, updated_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- views.view_default: one default view per person, brand, or project and entity
-- ---------------------------------------------------------------------------------------------
CREATE TABLE views.view_default (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  target_kind text NOT NULL,
  target_key uuid NOT NULL,
  entity text NOT NULL,
  member_id uuid,
  brand_id uuid,
  project_id uuid,
  saved_view_id uuid NOT NULL,
  set_by_membership_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, target_kind, target_key, entity),
  CONSTRAINT view_default_kind_known CHECK (target_kind IN ('member', 'brand', 'project')),
  CONSTRAINT view_default_entity_known CHECK (entity IN ('task', 'project')),
  CONSTRAINT view_default_target_shape CHECK (
    (target_kind = 'member' AND member_id IS NOT NULL AND brand_id IS NULL AND project_id IS NULL
      AND target_key = member_id)
    OR (target_kind = 'brand' AND brand_id IS NOT NULL AND member_id IS NULL AND project_id IS NULL
      AND target_key = brand_id)
    OR (target_kind = 'project' AND project_id IS NOT NULL AND brand_id IS NOT NULL AND member_id IS NULL
      AND target_key = project_id)),
  CONSTRAINT view_default_member_fkey FOREIGN KEY (workspace_id, member_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT view_default_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT view_default_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT view_default_view_fkey FOREIGN KEY (workspace_id, saved_view_id)
    REFERENCES views.saved_view (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT view_default_set_by_fkey FOREIGN KEY (workspace_id, set_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT view_default_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX view_default_by_view ON views.view_default (workspace_id, saved_view_id);
CREATE INDEX view_default_by_member ON views.view_default (workspace_id, member_id);
CREATE INDEX view_default_by_brand ON views.view_default (workspace_id, brand_id);
CREATE INDEX view_default_by_project ON views.view_default (workspace_id, brand_id, project_id);
CREATE INDEX view_default_by_set_by ON views.view_default (workspace_id, set_by_membership_id);

-- A pin targets a shared view of the pin's own scope (workspace or brand); 1E's guard keeps the
-- target a saved view, this one keeps it shared there.
CREATE FUNCTION views.view_pin_shared_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM views.saved_view v WHERE v.workspace_id = NEW.workspace_id
                 AND v.id = NEW.saved_view_id AND v.visibility = 'shared'
                 AND ((NEW.brand_id IS NULL AND v.share_scope = 'workspace')
                   OR (NEW.brand_id IS NOT NULL AND v.share_scope = 'brand' AND v.share_brand_id = NEW.brand_id))) THEN
    RAISE EXCEPTION 'a pin must target a view shared at the pin''s scope' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER view_pin_shared_guard BEFORE INSERT OR UPDATE ON views.view_pin
  FOR EACH ROW EXECUTE FUNCTION views.view_pin_shared_guard();

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE views.saved_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE views.saved_view FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON views.saved_view
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE views.view_default ENABLE ROW LEVEL SECURITY;
ALTER TABLE views.view_default FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON views.view_default
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON views.saved_view, views.view_default FROM PUBLIC;
GRANT SELECT, INSERT ON views.saved_view TO app_rw;
GRANT UPDATE (name, description, visibility, share_scope, share_brand_id, share_project_id, schema_version,
  query, presentation, layout, shared_at, shared_by_membership_id, updated_at, updated_by_membership_id, version)
  ON views.saved_view TO app_rw;
GRANT SELECT, INSERT, DELETE ON views.view_default TO app_rw;
GRANT UPDATE (saved_view_id, set_by_membership_id, updated_at, version) ON views.view_default TO app_rw;
-- Pins are written by the view engine (views.configure); 1E granted reads only.
GRANT INSERT, DELETE ON views.view_pin TO app_rw;
GRANT UPDATE (rank) ON views.view_pin TO app_rw;
-- The worker purges views with their brand or workspace and cleans departed members' defaults.
GRANT SELECT, DELETE ON views.saved_view, views.view_default TO app_worker;
GRANT DELETE ON views.view_pin TO app_worker;
REVOKE ALL ON FUNCTION views.view_pin_shared_guard() FROM PUBLIC;
