-- migrate:phase expand
-- Phase 1C brands: tenancy.brand as an addressable core.record extension (same id and public ID),
-- typed brand settings, the personal scope preference, and the brand foreign keys deferred by 1F.
--
-- Brand identity: for a brand, the envelope's brand_id = id and scope_key = id. Lifecycle state
-- lives in the envelope (archive/trash through Phase 1F) and is mirrored on the typed row through
-- the deferrable composite foreign key. `operational_status` is separate business metadata
-- (operating | paused | planned); it never encodes archive or trash.

-- A brand envelope is its own brand; no other record is.
ALTER TABLE core.record ADD CONSTRAINT record_brand_self
  CHECK ((record_type = 'brand') = (brand_id IS NOT NULL AND brand_id = id));

CREATE FUNCTION tenancy.valid_plain_text(v text, max_len integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT v IS NULL OR (char_length(v) <= max_len AND v !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]') $$;

CREATE TABLE tenancy.brand (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  name text NOT NULL,
  short_name text,
  logo_file_ref text,
  color text NOT NULL,
  icon text NOT NULL,
  description text,
  operational_status text NOT NULL DEFAULT 'operating',
  timezone text NOT NULL,
  is_sensitive boolean NOT NULL DEFAULT false,
  notification_content_mode text NOT NULL DEFAULT 'standard',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_membership_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT brand_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT brand_scope_is_self CHECK (scope_key = id),
  CONSTRAINT brand_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT brand_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT brand_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT brand_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 80)),
  CONSTRAINT brand_short_name_format CHECK (short_name IS NULL OR (char_length(short_name) BETWEEN 1 AND 12
    AND tenancy.valid_plain_text(short_name, 12))),
  CONSTRAINT brand_logo_file_ref_format CHECK (logo_file_ref IS NULL OR logo_file_ref ~ '^file_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT brand_color_format CHECK (color ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT brand_icon_known CHECK (icon IN ('circle', 'square', 'triangle', 'diamond', 'star', 'bolt',
    'leaf', 'globe', 'briefcase', 'rocket', 'heart', 'book')),
  CONSTRAINT brand_description_text CHECK (tenancy.valid_plain_text(description, 2000)),
  CONSTRAINT brand_status_known CHECK (operational_status IN ('operating', 'paused', 'planned')),
  CONSTRAINT brand_timezone_format CHECK (timezone ~ '^[A-Za-z]+(/[A-Za-z0-9_+\-]+)*$' AND char_length(timezone) <= 64),
  CONSTRAINT brand_notification_mode_known CHECK (notification_content_mode IN ('standard', 'minimal')),
  CONSTRAINT brand_version_nonnegative CHECK (version >= 0)
);
-- Case-insensitive name uniqueness among non-purged brands of a workspace (race-safe).
CREATE UNIQUE INDEX brand_name_unique ON tenancy.brand (workspace_id, lower(name)) WHERE lifecycle_state <> 'purged';
CREATE INDEX brand_visible ON tenancy.brand (workspace_id, lifecycle_state, is_sensitive);
CREATE INDEX brand_by_envelope ON tenancy.brand (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX brand_by_creator ON tenancy.brand (workspace_id, created_by_membership_id);
CREATE INDEX brand_by_updater ON tenancy.brand (workspace_id, updated_by_membership_id);

-- Deferred from 1F: brand references from envelopes and batches (workspace-scoped rows keep NULL).
-- Added NOT VALID, then validated (short lock; lifecycle.md follow-up constraints).
ALTER TABLE core.record ADD CONSTRAINT record_brand_fkey FOREIGN KEY (workspace_id, brand_id)
  REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE core.record VALIDATE CONSTRAINT record_brand_fkey;
ALTER TABLE core.archive_batch ADD CONSTRAINT archive_batch_brand_fkey FOREIGN KEY (workspace_id, brand_id)
  REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE core.archive_batch VALIDATE CONSTRAINT archive_batch_brand_fkey;
ALTER TABLE core.deletion_batch ADD CONSTRAINT deletion_batch_brand_fkey FOREIGN KEY (workspace_id, brand_id)
  REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE core.deletion_batch VALIDATE CONSTRAINT deletion_batch_brand_fkey;
CREATE INDEX record_by_brand ON core.record (workspace_id, brand_id) WHERE brand_id IS NOT NULL;
ALTER TABLE access.role_assignment ADD CONSTRAINT role_assignment_brand_fkey FOREIGN KEY (workspace_id, brand_scope_id)
  REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------------------------
-- Typed brand settings (WSB-010, WSB-011). Reserved namespaces for later owners stay NULL until
-- their phase adds a schema (notifications 4B, AI 7A, integrations 6A).
-- ---------------------------------------------------------------------------------------------
-- {"schema_version": 1, "days": [{"weekday": 1..7, "ranges": [{"start": "HH:MM", "end": "HH:MM"}]}]}
-- Weekdays are ISO (1 = Monday), unique; ranges sorted, non-overlapping, start < end, at most 4.
CREATE FUNCTION tenancy.valid_working_hours(v jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  AS $$
DECLARE
  d jsonb;
  r jsonb;
  seen int[] := '{}';
  prev_end text;
BEGIN
  IF jsonb_typeof(v) <> 'object' OR ARRAY(SELECT jsonb_object_keys(v) ORDER BY 1) <> ARRAY['days', 'schema_version']
     OR v->'schema_version' <> '1'::jsonb OR jsonb_typeof(v->'days') <> 'array' OR jsonb_array_length(v->'days') > 7 THEN
    RETURN false;
  END IF;
  FOR d IN SELECT value FROM jsonb_array_elements(v->'days') LOOP
    IF jsonb_typeof(d) <> 'object' OR ARRAY(SELECT jsonb_object_keys(d) ORDER BY 1) <> ARRAY['ranges', 'weekday']
       OR jsonb_typeof(d->'weekday') <> 'number' OR (d->>'weekday') !~ '^[1-7]$' OR (d->>'weekday')::int = ANY (seen)
       OR jsonb_typeof(d->'ranges') <> 'array' OR jsonb_array_length(d->'ranges') > 4 THEN
      RETURN false;
    END IF;
    seen := seen || (d->>'weekday')::int;
    prev_end := NULL;
    FOR r IN SELECT value FROM jsonb_array_elements(d->'ranges') LOOP
      IF jsonb_typeof(r) <> 'object' OR ARRAY(SELECT jsonb_object_keys(r) ORDER BY 1) <> ARRAY['end', 'start']
         OR (r->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         OR (r->>'end') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
         OR (r->>'start') >= (r->>'end') OR (prev_end IS NOT NULL AND (r->>'start') < prev_end) THEN
        RETURN false;
      END IF;
      prev_end := r->>'end';
    END LOOP;
  END LOOP;
  RETURN true;
END
$$;

-- {"schema_version": 1, "week_start": null|1..7, "show_weekends": bool, "default_view": "week"|"month"|"agenda", "label": null|text<=80}
CREATE FUNCTION tenancy.valid_calendar(v jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
  SELECT jsonb_typeof(v) = 'object'
    AND ARRAY(SELECT jsonb_object_keys(v) ORDER BY 1) = ARRAY['default_view', 'label', 'schema_version', 'show_weekends', 'week_start']
    AND v->'schema_version' = '1'::jsonb
    AND (jsonb_typeof(v->'week_start') = 'null' OR (v->>'week_start') ~ '^[1-7]$')
    AND jsonb_typeof(v->'show_weekends') = 'boolean'
    AND (v->>'default_view') IN ('week', 'month', 'agenda')
    AND (jsonb_typeof(v->'label') = 'null' OR (jsonb_typeof(v->'label') = 'string'
         AND char_length(v->>'label') BETWEEN 1 AND 80 AND tenancy.valid_plain_text(v->>'label', 80)))
  $$;

-- {"schema_version": 1, "entries": [{"kind": "goal"|"priority", "text": 1..280}]} at most 10, ordered.
CREATE FUNCTION tenancy.valid_priorities(v jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
  SELECT jsonb_typeof(v) = 'object'
    AND ARRAY(SELECT jsonb_object_keys(v) ORDER BY 1) = ARRAY['entries', 'schema_version']
    AND v->'schema_version' = '1'::jsonb
    AND jsonb_typeof(v->'entries') = 'array' AND jsonb_array_length(v->'entries') <= 10
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v->'entries') e
      WHERE jsonb_typeof(e) <> 'object'
         OR ARRAY(SELECT jsonb_object_keys(e) ORDER BY 1) <> ARRAY['kind', 'text']
         OR (e->>'kind') NOT IN ('goal', 'priority')
         OR jsonb_typeof(e->'text') <> 'string'
         OR char_length(btrim(e->>'text')) NOT BETWEEN 1 AND 280
         OR NOT tenancy.valid_plain_text(e->>'text', 280))
  $$;

CREATE TABLE tenancy.brand_setting (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  working_hours jsonb NOT NULL,
  calendar jsonb NOT NULL,
  priorities jsonb NOT NULL,
  -- Reserved namespaces (schema-versioned by their owners): 1C writes nothing here.
  notification_settings jsonb,
  ai_settings jsonb,
  integration_settings jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, brand_id),
  CONSTRAINT brand_setting_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT brand_setting_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT brand_setting_working_hours_valid CHECK (tenancy.valid_working_hours(working_hours)),
  CONSTRAINT brand_setting_calendar_valid CHECK (tenancy.valid_calendar(calendar)),
  CONSTRAINT brand_setting_priorities_valid CHECK (tenancy.valid_priorities(priorities)),
  CONSTRAINT brand_setting_reserved_unused CHECK (notification_settings IS NULL AND ai_settings IS NULL AND integration_settings IS NULL),
  CONSTRAINT brand_setting_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX brand_setting_by_updater ON tenancy.brand_setting (workspace_id, updated_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- tenancy.scope_preference: a person's last selected scope (personal; validated on every use)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE tenancy.scope_preference (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  scope_kind text NOT NULL,
  brand_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, owner_membership_id),
  CONSTRAINT scope_preference_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT scope_preference_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT scope_preference_kind_known CHECK (scope_kind IN ('brand', 'all')),
  CONSTRAINT scope_preference_brand_kind CHECK ((scope_kind = 'brand') = (brand_id IS NOT NULL))
);
CREATE INDEX scope_preference_by_brand ON tenancy.scope_preference (workspace_id, brand_id);

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE tenancy.brand ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.brand FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.brand
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE tenancy.brand_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.brand_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.brand_setting
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE tenancy.scope_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.scope_preference FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.scope_preference
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON tenancy.brand, tenancy.brand_setting, tenancy.scope_preference FROM PUBLIC;
GRANT SELECT, INSERT ON tenancy.brand TO app_rw;
GRANT UPDATE (name, short_name, logo_file_ref, color, icon, description, operational_status, timezone,
  is_sensitive, notification_content_mode, updated_at, updated_by_membership_id, version) ON tenancy.brand TO app_rw;
GRANT SELECT ON tenancy.brand TO app_worker;
GRANT SELECT, INSERT ON tenancy.brand_setting TO app_rw;
GRANT UPDATE (working_hours, calendar, priorities, updated_at, updated_by_membership_id, version) ON tenancy.brand_setting TO app_rw;
GRANT SELECT ON tenancy.brand_setting TO app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenancy.scope_preference TO app_rw;
REVOKE ALL ON FUNCTION tenancy.valid_plain_text(text, integer), tenancy.valid_working_hours(jsonb),
  tenancy.valid_calendar(jsonb), tenancy.valid_priorities(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy.valid_plain_text(text, integer), tenancy.valid_working_hours(jsonb),
  tenancy.valid_calendar(jsonb), tenancy.valid_priorities(jsonb) TO app_rw, app_worker;

-- ---------------------------------------------------------------------------------------------
-- Directory: the account's most recently selected workspace (from its own scope preferences).
-- Same contract as 0017: definer owned by pm_directory, platform scope only, own rows only.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY directory_lookup ON tenancy.scope_preference FOR SELECT TO pm_directory USING (true);
GRANT SELECT (workspace_id, owner_membership_id, updated_at) ON tenancy.scope_preference TO pm_directory;

CREATE FUNCTION tenancy.account_selected_workspace(p_account_id uuid)
  RETURNS TABLE (workspace_public_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.public_id
  FROM tenancy.scope_preference p
  JOIN tenancy.membership m ON m.workspace_id = p.workspace_id AND m.id = p.owner_membership_id
  JOIN tenancy.workspace w ON w.id = p.workspace_id
  WHERE exec.in_platform_scope() AND m.account_id = p_account_id AND m.state = 'active'
    AND w.state IN ('active', 'read_only')
  ORDER BY p.updated_at DESC, w.id
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION tenancy.account_selected_workspace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy.account_selected_workspace(uuid) TO app_rw;
GRANT CREATE ON SCHEMA tenancy TO pm_directory;
ALTER FUNCTION tenancy.account_selected_workspace(uuid) OWNER TO pm_directory;
REVOKE CREATE ON SCHEMA tenancy FROM pm_directory;
