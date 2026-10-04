-- migrate:phase expand
-- Phase 1E personal navigation: account preferences, favorites, recently viewed items, per-device
-- view state, and the shared-view pin foundation (0B views module, ADR-20; 0C AZ-20).
--
-- Every row here is a hint, never authority: targets are re-authorized at display and activation.
-- Personal rows carry workspace + owner membership (0B §2.4 `personal`); the account preference is
-- account-scoped platform data because it applies before any workspace is chosen.

CREATE SCHEMA views;
REVOKE ALL ON SCHEMA views FROM PUBLIC;
GRANT USAGE ON SCHEMA views TO app_rw, app_worker, pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- identity.account_preference: one typed row per account (a missing row means the defaults)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE identity.account_preference (
  account_id uuid PRIMARY KEY REFERENCES identity.account (id) ON DELETE RESTRICT,
  theme text NOT NULL DEFAULT 'system',
  density text NOT NULL DEFAULT 'comfortable',
  motion text NOT NULL DEFAULT 'system',
  shortcuts text NOT NULL DEFAULT 'auto',
  start_destination text,
  record_open text NOT NULL DEFAULT 'panel',
  hidden_destinations text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT account_preference_theme_known CHECK (theme IN ('system', 'light', 'dark')),
  CONSTRAINT account_preference_density_known CHECK (density IN ('comfortable', 'compact')),
  CONSTRAINT account_preference_motion_known CHECK (motion IN ('system', 'reduce')),
  CONSTRAINT account_preference_shortcuts_known CHECK (shortcuts IN ('auto', 'on', 'off')),
  CONSTRAINT account_preference_record_open_known CHECK (record_open IN ('panel', 'full_page')),
  CONSTRAINT account_preference_start_format CHECK (start_destination IS NULL OR start_destination ~ '^[a-z][a-z_]{1,31}$'),
  CONSTRAINT account_preference_hidden_bounded CHECK (
    cardinality(hidden_destinations) <= 16 AND array_position(hidden_destinations, NULL) IS NULL),
  CONSTRAINT account_preference_version_nonnegative CHECK (version >= 0)
);

-- ---------------------------------------------------------------------------------------------
-- views.favorite: ordered personal favorites (fractional rank, ties by record_id)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE views.favorite (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  record_id uuid NOT NULL,
  rank text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, owner_membership_id, record_id),
  CONSTRAINT favorite_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT favorite_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT favorite_record_fkey FOREIGN KEY (workspace_id, record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX favorite_by_owner_rank ON views.favorite (workspace_id, owner_membership_id, rank, record_id);
CREATE INDEX favorite_by_record ON views.favorite (workspace_id, record_id);

-- ---------------------------------------------------------------------------------------------
-- views.recent_item: one row per owner and target (latest authorized visit), trimmed by the app
-- ---------------------------------------------------------------------------------------------
CREATE TABLE views.recent_item (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  record_id uuid NOT NULL,
  visited_at timestamptz NOT NULL DEFAULT now(),
  visit_count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, owner_membership_id, record_id),
  CONSTRAINT recent_item_visit_count_positive CHECK (visit_count >= 1),
  CONSTRAINT recent_item_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT recent_item_record_fkey FOREIGN KEY (workspace_id, record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX recent_item_by_owner_time ON views.recent_item (workspace_id, owner_membership_id, visited_at DESC, record_id);
CREATE INDEX recent_item_by_record ON views.recent_item (workspace_id, record_id);

-- ---------------------------------------------------------------------------------------------
-- views.view_state: per person, device, and registered view; bounded, versioned, expiring
-- ---------------------------------------------------------------------------------------------
CREATE TABLE views.view_state (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  device_key_hash bytea NOT NULL,
  view_key text NOT NULL,
  schema_version integer NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, owner_membership_id, device_key_hash, view_key),
  CONSTRAINT view_state_device_hash_length CHECK (octet_length(device_key_hash) = 32),
  CONSTRAINT view_state_view_key_format CHECK (
    char_length(view_key) <= 64 AND view_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'),
  CONSTRAINT view_state_schema_version_range CHECK (schema_version BETWEEN 1 AND 1000),
  -- Hard ceiling; the configured VIEW_STATE_MAX_BYTES may be lower and is enforced by the service.
  CONSTRAINT view_state_state_bounded CHECK (jsonb_typeof(state) = 'object' AND octet_length(state::text) <= 32768),
  CONSTRAINT view_state_expiry_after_write CHECK (expires_at > updated_at),
  CONSTRAINT view_state_version_nonnegative CHECK (version >= 0),
  CONSTRAINT view_state_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX view_state_by_expiry ON views.view_state (expires_at);

-- ---------------------------------------------------------------------------------------------
-- views.view_pin: shared saved views pinned into workspace or brand navigation (foundation only;
-- the view engine grants writes when shared saved views exist)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE views.view_pin (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  scope_key uuid NOT NULL,
  brand_id uuid,
  saved_view_id uuid NOT NULL,
  rank text COLLATE "C" NOT NULL,
  pinned_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, scope_key, saved_view_id),
  CONSTRAINT view_pin_scope_key CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT view_pin_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT view_pin_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT view_pin_view_fkey FOREIGN KEY (workspace_id, saved_view_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT view_pin_pinned_by_fkey FOREIGN KEY (workspace_id, pinned_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX view_pin_by_brand ON views.view_pin (workspace_id, brand_id);
CREATE INDEX view_pin_by_view ON views.view_pin (workspace_id, saved_view_id);
CREATE INDEX view_pin_by_pinned_by ON views.view_pin (workspace_id, pinned_by_membership_id);

-- A pin targets a saved view and nothing else (the type lives on core.record).
CREATE FUNCTION views.view_pin_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.record r WHERE r.workspace_id = NEW.workspace_id
                 AND r.id = NEW.saved_view_id AND r.record_type = 'saved_view') THEN
    RAISE EXCEPTION 'a view pin must target a saved view' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER view_pin_guard BEFORE INSERT OR UPDATE ON views.view_pin
  FOR EACH ROW EXECUTE FUNCTION views.view_pin_guard();

-- Departed-member personal data becomes eligible for cleanup after its retention period.
CREATE INDEX membership_removed_at ON tenancy.membership (removed_at) WHERE state = 'removed';

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE views.favorite ENABLE ROW LEVEL SECURITY;
ALTER TABLE views.favorite FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON views.favorite
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE views.recent_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE views.recent_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON views.recent_item
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE views.view_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE views.view_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON views.view_state
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE views.view_pin ENABLE ROW LEVEL SECURITY;
ALTER TABLE views.view_pin FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON views.view_pin
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON identity.account_preference, views.favorite, views.recent_item, views.view_state,
  views.view_pin FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON identity.account_preference TO app_rw;
GRANT UPDATE (theme, density, motion, shortcuts, start_destination, record_open, hidden_destinations,
  updated_at, version) ON identity.account_preference TO app_rw;
GRANT SELECT, INSERT, DELETE ON views.favorite TO app_rw;
GRANT UPDATE (rank) ON views.favorite TO app_rw;
GRANT SELECT, INSERT, DELETE ON views.recent_item TO app_rw;
GRANT UPDATE (visited_at, visit_count) ON views.recent_item TO app_rw;
GRANT SELECT, INSERT, DELETE ON views.view_state TO app_rw;
GRANT UPDATE (schema_version, state, updated_at, expires_at, version) ON views.view_state TO app_rw;
GRANT SELECT ON views.view_pin TO app_rw;
-- Worker: cleanup of expired state, departed members' personal rows, and purged targets.
GRANT SELECT, DELETE ON views.favorite, views.recent_item, views.view_state TO app_worker;
GRANT SELECT ON views.view_pin TO app_worker;
REVOKE ALL ON FUNCTION views.view_pin_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Cleanup discovery (platform scope, identifiers only; same contract as 0015)
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON views.favorite FOR SELECT TO pm_scheduler USING (true);
CREATE POLICY scheduler_discovery ON views.recent_item FOR SELECT TO pm_scheduler USING (true);
CREATE POLICY scheduler_discovery ON views.view_state FOR SELECT TO pm_scheduler USING (true);
CREATE POLICY scheduler_discovery ON tenancy.membership FOR SELECT TO pm_scheduler USING (true);
GRANT USAGE ON SCHEMA tenancy TO pm_scheduler;
GRANT SELECT (workspace_id, owner_membership_id) ON views.favorite, views.recent_item TO pm_scheduler;
GRANT SELECT (workspace_id, owner_membership_id, expires_at) ON views.view_state TO pm_scheduler;
GRANT SELECT (workspace_id, id, state, removed_at) ON tenancy.membership TO pm_scheduler;

-- Workspaces with expired view state, or with personal navigation rows owned by memberships removed
-- before `p_departed_before` (NULL: the R-PERSONAL period is undecided, so none are selected).
CREATE FUNCTION exec_dispatch.discover_views_cleanup(p_departed_before timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.workspace_id FROM (
    SELECT s.workspace_id FROM views.view_state s WHERE s.expires_at <= now()
    UNION
    SELECT m.workspace_id FROM tenancy.membership m
    WHERE p_departed_before IS NOT NULL AND m.state = 'removed' AND m.removed_at < p_departed_before
      AND (EXISTS (SELECT 1 FROM views.favorite f
                   WHERE f.workspace_id = m.workspace_id AND f.owner_membership_id = m.id)
        OR EXISTS (SELECT 1 FROM views.recent_item r
                   WHERE r.workspace_id = m.workspace_id AND r.owner_membership_id = m.id)
        OR EXISTS (SELECT 1 FROM views.view_state v
                   WHERE v.workspace_id = m.workspace_id AND v.owner_membership_id = m.id))
  ) w
  ORDER BY w.workspace_id
  LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_views_cleanup(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_views_cleanup(timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_views_cleanup(timestamptz, integer) OWNER TO pm_scheduler;
