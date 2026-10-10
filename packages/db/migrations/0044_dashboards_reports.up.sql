-- migrate:phase expand
-- Phase 5D (0B ADR-39, 0C AZ-39, 0D PL-41; ADR-0031): dashboards, saved reports, explicit scope-bound
-- report shares, scheduled delivery with per-recipient runs. Dashboards and report definitions are
-- records in the core envelope (placement: workspace, brand, or project). Nothing stored here is a
-- metric value: every figure is computed per viewer, from what that viewer may read, at request or
-- delivery time (ADR-0031 D3). A run row records that a delivery happened, never its content.

CREATE SCHEMA insights;
REVOKE ALL ON SCHEMA insights FROM PUBLIC;
GRANT USAGE ON SCHEMA insights TO app_rw, app_worker;

-- ---------------------------------------------------------------------------------------------
-- Dashboards (RPT-001, RPT-017, RPT-018): owner, brand, project, release, and personal.
-- `layout` holds the bounded widget list; `filters` the default filters. Both are validated by the
-- application and bounded in size here.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE insights.dashboard (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  project_id uuid,
  kind text NOT NULL,
  title text NOT NULL,
  description text,
  owner_membership_id uuid NOT NULL,
  layout jsonb NOT NULL DEFAULT '{"v":1,"widgets":[]}'::jsonb,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT dashboard_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT dashboard_scope_key UNIQUE (workspace_id, scope_key, id),
  CONSTRAINT dashboard_scope_shape CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT dashboard_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT dashboard_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT dashboard_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT dashboard_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT dashboard_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT dashboard_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT dashboard_kind_known CHECK (kind IN ('owner', 'brand', 'project', 'release', 'personal')),
  CONSTRAINT dashboard_placement_shape CHECK (
    (kind IN ('owner', 'personal') AND brand_id IS NULL AND project_id IS NULL)
    OR (kind IN ('brand', 'release') AND brand_id IS NOT NULL AND project_id IS NULL)
    OR (kind = 'project' AND brand_id IS NOT NULL AND project_id IS NOT NULL)),
  CONSTRAINT dashboard_title_text CHECK (char_length(btrim(title)) BETWEEN 1 AND 200 AND title = btrim(title)
    AND tenancy.valid_plain_text(title, 200)),
  CONSTRAINT dashboard_description_text CHECK (description IS NULL OR (char_length(btrim(description)) BETWEEN 1 AND 2000
    AND tenancy.valid_plain_text(description, 2000))),
  CONSTRAINT dashboard_layout_bounded CHECK (jsonb_typeof(layout) = 'object' AND pg_column_size(layout) <= 65536),
  CONSTRAINT dashboard_filters_bounded CHECK (jsonb_typeof(filters) = 'object' AND pg_column_size(filters) <= 8192),
  CONSTRAINT dashboard_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX dashboard_by_envelope ON insights.dashboard (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX dashboard_by_scope ON insights.dashboard (workspace_id, scope_key, kind, id);
CREATE INDEX dashboard_by_brand ON insights.dashboard (workspace_id, brand_id);
CREATE INDEX dashboard_by_project ON insights.dashboard (workspace_id, brand_id, project_id);
CREATE INDEX dashboard_by_owner ON insights.dashboard (workspace_id, owner_membership_id);
CREATE INDEX dashboard_by_creator ON insights.dashboard (workspace_id, created_by_membership_id);
CREATE INDEX dashboard_by_updater ON insights.dashboard (workspace_id, updated_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Report definitions (RPT-020, RPT-021): a saved configuration (widgets and filters) plus an
-- optional schedule. The accountable owner's authority is rechecked at every run; a run that
-- cannot be authorised suspends the schedule with a reason instead of sending anything.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE insights.report_definition (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  project_id uuid,
  title text NOT NULL,
  description text,
  owner_membership_id uuid NOT NULL,
  config jsonb NOT NULL DEFAULT '{"v":1,"widgets":[]}'::jsonb,
  schedule_frequency text,
  schedule_weekday smallint,
  schedule_monthday smallint,
  schedule_minute smallint,
  schedule_timezone text,
  next_run_at timestamptz,
  last_run_at timestamptz,
  claimed_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  suspended_reason text,
  suspended_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT report_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT report_scope_key UNIQUE (workspace_id, scope_key, id),
  CONSTRAINT report_scope_shape CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT report_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT report_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT report_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_project_in_brand CHECK (project_id IS NULL OR brand_id IS NOT NULL),
  CONSTRAINT report_title_text CHECK (char_length(btrim(title)) BETWEEN 1 AND 200 AND title = btrim(title)
    AND tenancy.valid_plain_text(title, 200)),
  CONSTRAINT report_description_text CHECK (description IS NULL OR (char_length(btrim(description)) BETWEEN 1 AND 2000
    AND tenancy.valid_plain_text(description, 2000))),
  CONSTRAINT report_config_bounded CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 65536),
  CONSTRAINT report_frequency_known CHECK (schedule_frequency IS NULL OR schedule_frequency IN ('daily', 'weekly', 'monthly')),
  -- A schedule is all of its parts or none; weekly names a weekday (1 Monday to 7 Sunday), monthly a
  -- day 1 to 28 (every month has one), and the time is minutes after local midnight.
  CONSTRAINT report_schedule_shape CHECK (
    (schedule_frequency IS NULL AND schedule_weekday IS NULL AND schedule_monthday IS NULL
       AND schedule_minute IS NULL AND schedule_timezone IS NULL AND next_run_at IS NULL)
    OR (schedule_frequency IS NOT NULL AND schedule_minute BETWEEN 0 AND 1439
       AND schedule_timezone IS NOT NULL AND char_length(schedule_timezone) <= 64
       AND (schedule_frequency = 'weekly') = (schedule_weekday IS NOT NULL)
       AND (schedule_frequency = 'monthly') = (schedule_monthday IS NOT NULL)
       AND (schedule_weekday IS NULL OR schedule_weekday BETWEEN 1 AND 7)
       AND (schedule_monthday IS NULL OR schedule_monthday BETWEEN 1 AND 28))),
  CONSTRAINT report_suspended_known CHECK (suspended_reason IS NULL OR suspended_reason IN ('owner_authority', 'owner_departed', 'admin')),
  CONSTRAINT report_suspended_shape CHECK ((suspended_reason IS NULL) = (suspended_at IS NULL)),
  CONSTRAINT report_attempts CHECK (attempts >= 0),
  CONSTRAINT report_error_code CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,40}$'),
  CONSTRAINT report_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX report_by_envelope ON insights.report_definition (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX report_by_scope ON insights.report_definition (workspace_id, scope_key, id);
CREATE INDEX report_by_brand ON insights.report_definition (workspace_id, brand_id);
CREATE INDEX report_by_project ON insights.report_definition (workspace_id, brand_id, project_id);
CREATE INDEX report_by_owner ON insights.report_definition (workspace_id, owner_membership_id);
CREATE INDEX report_by_creator ON insights.report_definition (workspace_id, created_by_membership_id);
CREATE INDEX report_by_updater ON insights.report_definition (workspace_id, updated_by_membership_id);
CREATE INDEX report_due ON insights.report_definition (workspace_id, next_run_at) WHERE next_run_at IS NOT NULL;

-- Recipients of a scheduled report: members only; each is rendered for as themselves at send time.
CREATE TABLE insights.report_recipient (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  report_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  added_by_membership_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_recipient_pkey PRIMARY KEY (workspace_id, report_id, membership_id),
  CONSTRAINT report_recipient_report_fkey FOREIGN KEY (workspace_id, report_id)
    REFERENCES insights.report_definition (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT report_recipient_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_recipient_adder_fkey FOREIGN KEY (workspace_id, added_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX report_recipient_by_member ON insights.report_recipient (workspace_id, membership_id);
CREATE INDEX report_recipient_by_adder ON insights.report_recipient (workspace_id, added_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Report shares (RPT-020): explicit, revocable, bound to the report's own scope. A share lets the
-- grantee open and run the saved definition; it grants no data. The grantee's own access, within
-- the report's scope, decides every figure and row.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE insights.report_share (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  scope_key uuid NOT NULL,
  report_id uuid NOT NULL,
  grantee_membership_id uuid NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by_membership_id uuid,
  CONSTRAINT report_share_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT report_share_public_id_format CHECK (public_id ~ '^rsh_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- Same workspace and scope as the report: a share can never name another scope.
  CONSTRAINT report_share_report_fkey FOREIGN KEY (workspace_id, scope_key, report_id)
    REFERENCES insights.report_definition (workspace_id, scope_key, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT report_share_grantee_fkey FOREIGN KEY (workspace_id, grantee_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_share_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_share_revoker_fkey FOREIGN KEY (workspace_id, revoked_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_share_revoked_shape CHECK ((revoked_at IS NULL) = (revoked_by_membership_id IS NULL)),
  CONSTRAINT report_share_expiry CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE UNIQUE INDEX report_share_active ON insights.report_share (workspace_id, report_id, grantee_membership_id)
  WHERE revoked_at IS NULL;
CREATE INDEX report_share_by_report ON insights.report_share (workspace_id, report_id);
CREATE INDEX report_share_by_scope_report ON insights.report_share (workspace_id, scope_key, report_id);
CREATE INDEX report_share_by_grantee ON insights.report_share (workspace_id, grantee_membership_id);
CREATE INDEX report_share_by_creator ON insights.report_share (workspace_id, created_by_membership_id);
CREATE INDEX report_share_by_revoker ON insights.report_share (workspace_id, revoked_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Report runs (RPT-021, RPT-022): one row per scheduled occurrence and recipient. The unique key is
-- the idempotency of delivery: a repeat of the same occurrence finds the row and does nothing.
-- Content is never stored; `content_hash` lets an operator tell a repeat from a change.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE insights.report_run (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  report_id uuid NOT NULL,
  recipient_membership_id uuid NOT NULL,
  occurrence_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  detail text,
  row_count integer,
  incomplete boolean NOT NULL DEFAULT false,
  content_hash text,
  failure_class text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT report_run_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT report_run_occurrence UNIQUE (workspace_id, report_id, recipient_membership_id, occurrence_at),
  CONSTRAINT report_run_report_fkey FOREIGN KEY (workspace_id, report_id)
    REFERENCES insights.report_definition (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT report_run_recipient_fkey FOREIGN KEY (workspace_id, recipient_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_run_state_known CHECK (state IN ('pending', 'delivered', 'empty', 'skipped', 'failed')),
  CONSTRAINT report_run_detail_code CHECK (detail IS NULL OR detail ~ '^[a-z_]{1,40}$'),
  CONSTRAINT report_run_finished_shape CHECK ((state = 'pending') = (finished_at IS NULL)),
  CONSTRAINT report_run_rows CHECK (row_count IS NULL OR row_count >= 0),
  CONSTRAINT report_run_hash_format CHECK (content_hash IS NULL OR content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT report_run_failure_known CHECK (failure_class IS NULL OR failure_class IN ('transient', 'permanent', 'rate_limited', 'unconfigured')),
  CONSTRAINT report_run_attempts CHECK (attempts >= 0)
);
CREATE INDEX report_run_by_report ON insights.report_run (workspace_id, report_id, occurrence_at DESC);
CREATE INDEX report_run_by_recipient ON insights.report_run (workspace_id, recipient_membership_id);
CREATE INDEX report_run_retention ON insights.report_run (workspace_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Worker discovery (payload-free): workspaces with a report whose schedule is due, or with runs
-- older than the retention cutoff.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON insights.report_definition FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, next_run_at, claimed_until, suspended_at) ON insights.report_definition TO pm_scheduler;
ALTER TABLE insights.report_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE insights.report_run FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduler_discovery ON insights.report_run FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, created_at) ON insights.report_run TO pm_scheduler;
GRANT USAGE ON SCHEMA insights TO pm_scheduler;

CREATE FUNCTION exec_dispatch.discover_report_work(p_now timestamptz, p_retention_before timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.workspace_id FROM (
    SELECT r.workspace_id, r.next_run_at AS due FROM insights.report_definition r
     WHERE r.next_run_at IS NOT NULL AND r.next_run_at <= p_now AND r.suspended_at IS NULL
       AND (r.claimed_until IS NULL OR r.claimed_until <= p_now)
    UNION ALL
    SELECT x.workspace_id, min(x.created_at) FROM insights.report_run x
     WHERE x.created_at < p_retention_before GROUP BY x.workspace_id
  ) w
   GROUP BY w.workspace_id
   ORDER BY min(w.due), w.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_report_work(timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_report_work(timestamptz, timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_report_work(timestamptz, timestamptz, integer) OWNER TO pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE insights.dashboard ENABLE ROW LEVEL SECURITY;
ALTER TABLE insights.dashboard FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON insights.dashboard
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE insights.report_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE insights.report_definition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON insights.report_definition
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE insights.report_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE insights.report_recipient FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON insights.report_recipient
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE insights.report_share ENABLE ROW LEVEL SECURITY;
ALTER TABLE insights.report_share FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON insights.report_share
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
CREATE POLICY tenant_isolation ON insights.report_run
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON insights.dashboard, insights.report_definition, insights.report_recipient,
  insights.report_share, insights.report_run FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON insights.dashboard, insights.report_definition, insights.report_share TO app_rw;
GRANT SELECT, INSERT, DELETE ON insights.report_recipient TO app_rw;
GRANT SELECT ON insights.report_run TO app_rw;
-- The worker advances schedules, writes runs, ages runs out, and deletes content on purge.
GRANT SELECT, UPDATE, DELETE ON insights.report_definition TO app_worker;
GRANT SELECT, DELETE ON insights.dashboard, insights.report_share TO app_worker;
GRANT SELECT, DELETE ON insights.report_recipient TO app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON insights.report_run TO app_worker;
