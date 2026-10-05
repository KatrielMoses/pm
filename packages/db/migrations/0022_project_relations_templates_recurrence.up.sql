-- migrate:phase expand
-- Phase 2A (0B ADR-21, 0C AZ-21, 0D PL-22): canonical record relationships (project dependencies),
-- project templates, and planning-owned recurrence with immutable snapshots.
--
-- Layering: relations (2) and planning (3) never reference templates (4); templates may read work.
-- The recurrence reference on work.project is validated here, by the planning-owned migration.

CREATE SCHEMA relations;
REVOKE ALL ON SCHEMA relations FROM PUBLIC;
GRANT USAGE ON SCHEMA relations TO app_rw, app_worker;
CREATE SCHEMA templates;
REVOKE ALL ON SCHEMA templates FROM PUBLIC;
GRANT USAGE ON SCHEMA templates TO app_rw, app_worker;
CREATE SCHEMA planning;
REVOKE ALL ON SCHEMA planning FROM PUBLIC;
GRANT USAGE ON SCHEMA planning TO app_rw, app_worker, pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Record relationships. Never used for authorization; both endpoints are re-authorized at every
-- display (OD-05). Cross-brand rows store both brands.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE relations.record_relationship (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  kind text NOT NULL,
  from_record_id uuid NOT NULL,
  to_record_id uuid NOT NULL,
  from_brand_id uuid NOT NULL,
  to_brand_id uuid NOT NULL,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT record_relationship_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT record_relationship_unique UNIQUE (workspace_id, from_record_id, to_record_id, kind),
  CONSTRAINT record_relationship_from_fkey FOREIGN KEY (workspace_id, from_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_relationship_to_fkey FOREIGN KEY (workspace_id, to_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_relationship_from_brand_fkey FOREIGN KEY (workspace_id, from_brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_relationship_to_brand_fkey FOREIGN KEY (workspace_id, to_brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_relationship_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_relationship_kind_known CHECK (kind IN ('blocks', 'related')),
  CONSTRAINT record_relationship_distinct CHECK (from_record_id <> to_record_id),
  CONSTRAINT record_relationship_related_ordered CHECK (kind <> 'related' OR from_record_id < to_record_id)
);
CREATE INDEX record_relationship_by_from ON relations.record_relationship (workspace_id, from_record_id, kind);
CREATE INDEX record_relationship_by_to ON relations.record_relationship (workspace_id, to_record_id, kind);
CREATE INDEX record_relationship_by_to_brand ON relations.record_relationship (workspace_id, to_brand_id);
CREATE INDEX record_relationship_by_from_brand ON relations.record_relationship (workspace_id, from_brand_id);
CREATE INDEX record_relationship_by_creator ON relations.record_relationship (workspace_id, created_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Templates (addressable; workspace or brand scope) and immutable versions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE templates.template (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  name text NOT NULL,
  target_record_type text NOT NULL,
  current_version_id uuid,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT template_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT template_scope_key CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT template_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT template_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT template_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT template_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 200 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 200)),
  CONSTRAINT template_target_known CHECK (target_record_type IN ('project')),
  CONSTRAINT template_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX template_by_envelope ON templates.template (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX template_list ON templates.template (workspace_id, scope_key, target_record_type, lifecycle_state);
CREATE INDEX template_by_brand ON templates.template (workspace_id, brand_id);
CREATE INDEX template_by_creator ON templates.template (workspace_id, created_by_membership_id);

CREATE TABLE templates.template_version (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  template_id uuid NOT NULL,
  version_number integer NOT NULL,
  schema_version smallint NOT NULL,
  content jsonb NOT NULL,
  item_count integer NOT NULL,
  created_from_record_type text,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT template_version_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT template_version_number UNIQUE (workspace_id, template_id, version_number),
  CONSTRAINT template_version_template_fkey FOREIGN KEY (workspace_id, template_id)
    REFERENCES templates.template (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT template_version_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT template_version_positive CHECK (version_number >= 1),
  CONSTRAINT template_version_schema CHECK (schema_version = 1),
  CONSTRAINT template_version_content_object CHECK (jsonb_typeof(content) = 'object'),
  -- TEMPLATE_ITEMS_MAX (0D PL-22); commands validate the exact structure first.
  CONSTRAINT template_version_items CHECK (item_count BETWEEN 1 AND 500),
  CONSTRAINT template_version_size CHECK (pg_column_size(content) <= 1048576)
);
CREATE INDEX template_version_by_template ON templates.template_version (workspace_id, template_id, version_number DESC);
CREATE INDEX template_version_by_creator ON templates.template_version (workspace_id, created_by_membership_id);
ALTER TABLE templates.template ADD CONSTRAINT template_current_version_fkey FOREIGN KEY (workspace_id, current_version_id)
  REFERENCES templates.template_version (workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX template_by_current_version ON templates.template (workspace_id, current_version_id);

-- ---------------------------------------------------------------------------------------------
-- Recurrence (planning-owned). template_payload is frozen at definition and never updated.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE planning.recurrence_series (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  target_kind text NOT NULL,
  source_record_id uuid,
  state text NOT NULL DEFAULT 'active',
  rrule text NOT NULL,
  anchor_tz text NOT NULL,
  dtstart_local timestamp NOT NULL,
  mode text NOT NULL DEFAULT 'schedule',
  template_payload jsonb NOT NULL,
  payload_item_count integer NOT NULL,
  generated_through timestamp,
  next_due_at timestamptz,
  -- Discovery fairness (oldest-waiting first): set at creation and on every worker run.
  last_run_at timestamptz NOT NULL DEFAULT now(),
  ends_at_occurrence text,
  split_from_series_id uuid,
  owner_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT recurrence_series_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT recurrence_series_public_id_format CHECK (public_id ~ '^rcs_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT recurrence_series_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT recurrence_series_source_fkey FOREIGN KEY (workspace_id, source_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT recurrence_series_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT recurrence_series_split_fkey FOREIGN KEY (workspace_id, split_from_series_id)
    REFERENCES planning.recurrence_series (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT recurrence_series_target_known CHECK (target_kind IN ('project')),
  CONSTRAINT recurrence_series_state_known CHECK (state IN ('active', 'paused')),
  CONSTRAINT recurrence_series_mode_known CHECK (mode IN ('schedule')),
  CONSTRAINT recurrence_series_rrule CHECK (rrule ~ '^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$'
    AND char_length(rrule) <= 200),
  CONSTRAINT recurrence_series_tz CHECK (char_length(anchor_tz) BETWEEN 1 AND 64),
  CONSTRAINT recurrence_series_payload_object CHECK (jsonb_typeof(template_payload) = 'object'),
  CONSTRAINT recurrence_series_payload_items CHECK (payload_item_count BETWEEN 1 AND 500),
  CONSTRAINT recurrence_series_payload_size CHECK (pg_column_size(template_payload) <= 1048576),
  CONSTRAINT recurrence_series_due_when_active CHECK (state = 'active' OR next_due_at IS NULL),
  CONSTRAINT recurrence_series_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX recurrence_series_due ON planning.recurrence_series (next_due_at, workspace_id) WHERE state = 'active';
CREATE INDEX recurrence_series_fair ON planning.recurrence_series (workspace_id, last_run_at, id) WHERE state = 'active';
CREATE INDEX recurrence_series_by_brand ON planning.recurrence_series (workspace_id, brand_id);
CREATE INDEX recurrence_series_by_source ON planning.recurrence_series (workspace_id, source_record_id);
CREATE INDEX recurrence_series_by_owner ON planning.recurrence_series (workspace_id, owner_membership_id);
CREATE INDEX recurrence_series_by_split ON planning.recurrence_series (workspace_id, split_from_series_id);

-- The snapshot is immutable once written (OD-14).
CREATE FUNCTION planning.recurrence_series_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.template_payload IS DISTINCT FROM OLD.template_payload OR NEW.payload_item_count <> OLD.payload_item_count
     OR NEW.brand_id <> OLD.brand_id OR NEW.target_kind <> OLD.target_kind OR NEW.public_id <> OLD.public_id THEN
    RAISE EXCEPTION 'a recurrence snapshot is immutable' USING ERRCODE = 'check_violation';
  END IF;
  -- The discovery-fairness stamp alone is operational and does not version the series.
  IF NEW.version <> OLD.version + 1
     AND NOT (NEW.version = OLD.version AND to_jsonb(NEW) - 'last_run_at' = to_jsonb(OLD) - 'last_run_at') THEN
    RAISE EXCEPTION 'recurrence version must advance by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER recurrence_series_guard BEFORE UPDATE ON planning.recurrence_series
  FOR EACH ROW EXECUTE FUNCTION planning.recurrence_series_guard();

-- Occurrence identity on the target table: stable keys make generation idempotent.
ALTER TABLE work.project ADD CONSTRAINT project_recurrence_series_fkey FOREIGN KEY (workspace_id, recurrence_series_id)
  REFERENCES planning.recurrence_series (workspace_id, id) ON DELETE RESTRICT;
CREATE INDEX project_by_recurrence ON work.project (workspace_id, recurrence_series_id);
CREATE UNIQUE INDEX project_occurrence_unique ON work.project (workspace_id, recurrence_series_id, occurrence_key)
  WHERE recurrence_series_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Narrow worker capabilities (no broad role_assignment write for app_worker)
-- ---------------------------------------------------------------------------------------------
-- A generated occurrence's accountable manager receives the explicit project manage grant in the
-- same transaction (0C AZ-21). Only for a project generated from a series in this workspace, only
-- for an active internal membership, and only scope_manage.
CREATE FUNCTION work.grant_occurrence_manager(p_project uuid, p_membership uuid, p_assignment uuid)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ws uuid := exec.current_workspace_id();
  role_id uuid;
BEGIN
  IF ws IS NULL OR NOT EXISTS (
    SELECT 1 FROM work.project p WHERE p.workspace_id = ws AND p.id = p_project
       AND p.recurrence_series_id IS NOT NULL AND p.owner_membership_id = p_membership) THEN
    RAISE EXCEPTION 'not a generated occurrence owned by this member' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenancy.membership m WHERE m.workspace_id = ws AND m.id = p_membership
                  AND m.kind = 'member' AND m.state = 'active') THEN
    RAISE EXCEPTION 'occurrence manager must be an active member' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT r.id INTO role_id FROM access.role r WHERE r.workspace_id = ws AND r.key = 'scope_manage';
  INSERT INTO access.role_assignment (id, workspace_id, principal_type, principal_id, scope_type, scope_id,
    role_id, role_kind, grant_source)
  VALUES (p_assignment, ws, 'membership', p_membership, 'project', p_project, role_id, 'scope_level', 'project_manager');
END
$$;

-- Purge removes a project's access rows (assignments and exact grants) once its envelope is in a
-- purge batch; the last-manager guard applies only to active projects.
CREATE FUNCTION work.remove_purged_project_access(p_project uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ws uuid := exec.current_workspace_id();
  n integer;
BEGIN
  IF ws IS NULL OR NOT EXISTS (
    SELECT 1 FROM core.record r WHERE r.workspace_id = ws AND r.id = p_project
       AND r.record_type = 'project' AND r.lifecycle_state IN ('trashed', 'purged')) THEN
    RAISE EXCEPTION 'project access can be removed only during purge' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM access.role_assignment WHERE workspace_id = ws AND scope_type = 'project' AND scope_id = p_project;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM access.record_grant WHERE workspace_id = ws AND record_id = p_project;
  RETURN n;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Due-work discovery (platform scope, identifiers only; same contract as 0015/0020)
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON planning.recurrence_series FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, state, next_due_at, last_run_at) ON planning.recurrence_series TO pm_scheduler;
CREATE FUNCTION exec_dispatch.discover_recurrence_due(p_now timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  -- Oldest-waiting first: a workspace's key is the earliest last run of its due series. Keys of
  -- waiting series never change until they run (then they move to now), so every due workspace
  -- is reached in a bounded number of runs (RECURRENCE_WORKSPACE_DISCOVERY_MAX per run).
  SELECT s.workspace_id FROM planning.recurrence_series s
   WHERE s.state = 'active' AND s.next_due_at <= p_now
   GROUP BY s.workspace_id
   ORDER BY min(s.last_run_at), s.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE relations.record_relationship ENABLE ROW LEVEL SECURITY;
ALTER TABLE relations.record_relationship FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON relations.record_relationship
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE templates.template ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates.template FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON templates.template
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE templates.template_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates.template_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON templates.template_version
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE planning.recurrence_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning.recurrence_series FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON planning.recurrence_series
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON relations.record_relationship, templates.template, templates.template_version,
  planning.recurrence_series FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON relations.record_relationship TO app_rw;
GRANT SELECT, DELETE ON relations.record_relationship TO app_worker;
GRANT SELECT, INSERT ON templates.template TO app_rw;
GRANT UPDATE (name, current_version_id, updated_at, version) ON templates.template TO app_rw;
GRANT SELECT, INSERT ON templates.template_version TO app_rw;
GRANT SELECT ON templates.template, templates.template_version TO app_worker;
GRANT SELECT, INSERT ON planning.recurrence_series TO app_rw;
GRANT UPDATE (state, owner_membership_id, generated_through, next_due_at, updated_at, version)
  ON planning.recurrence_series TO app_rw;
GRANT SELECT ON planning.recurrence_series TO app_worker;
-- The worker advances generation, pauses a series whose owner lost authority, and detaches a purged
-- source project (the frozen snapshot keeps working).
GRANT UPDATE (state, source_record_id, generated_through, next_due_at, last_run_at, updated_at, version)
  ON planning.recurrence_series TO app_worker;
GRANT DELETE ON templates.template, templates.template_version TO app_worker;

REVOKE ALL ON FUNCTION planning.recurrence_series_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.grant_occurrence_manager(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.grant_occurrence_manager(uuid, uuid, uuid) TO app_worker;
REVOKE ALL ON FUNCTION work.remove_purged_project_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.remove_purged_project_access(uuid) TO app_worker;
REVOKE ALL ON FUNCTION exec_dispatch.discover_recurrence_due(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_recurrence_due(timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_recurrence_due(timestamptz, integer) OWNER TO pm_scheduler;
