-- migrate:phase expand
-- Phase 5B (0B ADR-36, 0C AZ-36, 0D PL-38; ADR-0028; OD-06, OD-07, OD-13): goals, key results,
-- links to projects and tasks, append-only check-ins, derived recalculation state, and portfolios.
-- Goals and portfolios are records in the core envelope (workspace-, brand-, or project-scoped).
-- Access is the placement's (workspace or brand level, the governing project chain); a goal or a
-- portfolio is never shareable and no row here copies anyone's access. Nothing stored here is a
-- number derived from linked work: progress, health, dependencies, budgets, and orphan findings
-- over work are computed for each viewer from the work that viewer may read (ADR-0028 G3).

CREATE SCHEMA goals;
REVOKE ALL ON SCHEMA goals FROM PUBLIC;
GRANT USAGE ON SCHEMA goals TO app_rw, app_worker;

-- Goal values are bounded decimals (a measurement, never currency arithmetic).
CREATE FUNCTION goals.valid_value(v numeric) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT v IS NULL OR abs(v) <= 1000000000000 $$;

-- ---------------------------------------------------------------------------------------------
-- Goals (GOAL-001, GOAL-002, GOAL-006): the envelope's typed row. `latest_*` mirror the newest
-- manual check-in so lists and sorts need no join; the check-in rows are the history.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE goals.goal (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  project_id uuid,
  title text NOT NULL,
  description text,
  owner_membership_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  period_kind text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  progress_basis text NOT NULL DEFAULT 'manual',
  unit text,
  baseline_value numeric(20, 4),
  target_value numeric(20, 4),
  current_value numeric(20, 4),
  latest_percent numeric(6, 2),
  latest_checkin_id uuid,
  latest_checkin_at timestamptz,
  latest_confidence text,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT goal_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT goal_scope_key UNIQUE (workspace_id, scope_key, id),
  CONSTRAINT goal_scope_shape CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT goal_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT goal_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT goal_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT goal_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT goal_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT goal_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT goal_project_in_brand CHECK (project_id IS NULL OR brand_id IS NOT NULL),
  CONSTRAINT goal_title_text CHECK (char_length(btrim(title)) BETWEEN 1 AND 200 AND title = btrim(title)
    AND tenancy.valid_plain_text(title, 200)),
  CONSTRAINT goal_description_text CHECK (description IS NULL OR (char_length(btrim(description)) BETWEEN 1 AND 4000
    AND tenancy.valid_plain_text(description, 4000))),
  CONSTRAINT goal_status_known CHECK (status IN ('draft', 'active', 'achieved', 'missed', 'cancelled')),
  CONSTRAINT goal_period_kind_known CHECK (period_kind IN ('quarter', 'half', 'year', 'custom')),
  CONSTRAINT goal_period_ordered CHECK (period_end >= period_start AND period_end - period_start <= 3660),
  CONSTRAINT goal_basis_known CHECK (progress_basis IN ('manual', 'key_results', 'linked_work')),
  CONSTRAINT goal_unit_text CHECK (unit IS NULL OR (char_length(btrim(unit)) BETWEEN 1 AND 30
    AND tenancy.valid_plain_text(unit, 30))),
  CONSTRAINT goal_values_bounded CHECK (goals.valid_value(baseline_value) AND goals.valid_value(target_value)
    AND goals.valid_value(current_value)),
  -- A target needs its baseline (the direction is the order of the two) and they differ.
  CONSTRAINT goal_metric_shape CHECK ((target_value IS NULL) = (baseline_value IS NULL)
    AND (target_value IS NOT NULL OR current_value IS NULL)
    AND (target_value IS NULL OR baseline_value <> target_value)),
  CONSTRAINT goal_metric_manual_only CHECK (progress_basis = 'manual' OR (target_value IS NULL AND current_value IS NULL)),
  CONSTRAINT goal_latest_percent_range CHECK (latest_percent IS NULL OR latest_percent BETWEEN 0 AND 100),
  CONSTRAINT goal_confidence_known CHECK (latest_confidence IS NULL OR latest_confidence IN ('on_track', 'at_risk', 'off_track')),
  CONSTRAINT goal_latest_shape CHECK ((latest_checkin_id IS NULL) = (latest_checkin_at IS NULL)),
  CONSTRAINT goal_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX goal_by_envelope ON goals.goal (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX goal_by_brand ON goals.goal (workspace_id, brand_id);
CREATE INDEX goal_by_project ON goals.goal (workspace_id, brand_id, project_id);
CREATE INDEX goal_by_owner ON goals.goal (workspace_id, owner_membership_id);
CREATE INDEX goal_by_creator ON goals.goal (workspace_id, created_by_membership_id);
CREATE INDEX goal_by_updater ON goals.goal (workspace_id, updated_by_membership_id);
CREATE INDEX goal_by_period ON goals.goal (workspace_id, period_start, period_end, id);
CREATE INDEX goal_by_latest_checkin ON goals.goal (workspace_id, latest_checkin_id);

-- ---------------------------------------------------------------------------------------------
-- Key results (GOAL-004): measurable targets inside one goal, in the goal's scope.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE goals.key_result (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  goal_id uuid NOT NULL,
  title text NOT NULL,
  owner_membership_id uuid NOT NULL,
  progress_basis text NOT NULL DEFAULT 'manual',
  unit text,
  baseline_value numeric(20, 4),
  target_value numeric(20, 4),
  current_value numeric(20, 4),
  latest_percent numeric(6, 2),
  latest_checkin_id uuid,
  latest_checkin_at timestamptz,
  latest_confidence text,
  rank text COLLATE "C" NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT key_result_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT key_result_goal_key UNIQUE (workspace_id, goal_id, id),
  CONSTRAINT key_result_scope_shape CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT key_result_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  -- Same workspace and scope as the goal; RESTRICT blocks purging a goal a live key result uses.
  CONSTRAINT key_result_goal_fkey FOREIGN KEY (workspace_id, scope_key, goal_id)
    REFERENCES goals.goal (workspace_id, scope_key, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT key_result_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT key_result_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT key_result_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT key_result_title_text CHECK (char_length(btrim(title)) BETWEEN 1 AND 200 AND title = btrim(title)
    AND tenancy.valid_plain_text(title, 200)),
  CONSTRAINT key_result_basis_known CHECK (progress_basis IN ('manual', 'linked_work')),
  CONSTRAINT key_result_unit_text CHECK (unit IS NULL OR (char_length(btrim(unit)) BETWEEN 1 AND 30
    AND tenancy.valid_plain_text(unit, 30))),
  CONSTRAINT key_result_values_bounded CHECK (goals.valid_value(baseline_value) AND goals.valid_value(target_value)
    AND goals.valid_value(current_value)),
  CONSTRAINT key_result_metric_shape CHECK ((target_value IS NULL) = (baseline_value IS NULL)
    AND (target_value IS NOT NULL OR current_value IS NULL)
    AND (target_value IS NULL OR baseline_value <> target_value)),
  CONSTRAINT key_result_metric_manual_only CHECK (progress_basis = 'manual' OR (target_value IS NULL AND current_value IS NULL)),
  CONSTRAINT key_result_latest_percent_range CHECK (latest_percent IS NULL OR latest_percent BETWEEN 0 AND 100),
  CONSTRAINT key_result_confidence_known CHECK (latest_confidence IS NULL OR latest_confidence IN ('on_track', 'at_risk', 'off_track')),
  CONSTRAINT key_result_latest_shape CHECK ((latest_checkin_id IS NULL) = (latest_checkin_at IS NULL)),
  CONSTRAINT key_result_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT key_result_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX key_result_by_envelope ON goals.key_result (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX key_result_by_goal ON goals.key_result (workspace_id, goal_id, rank, id);
CREATE INDEX key_result_by_scope_goal ON goals.key_result (workspace_id, scope_key, goal_id);
CREATE INDEX key_result_by_brand ON goals.key_result (workspace_id, brand_id);
CREATE INDEX key_result_by_owner ON goals.key_result (workspace_id, owner_membership_id);
CREATE INDEX key_result_by_creator ON goals.key_result (workspace_id, created_by_membership_id);
CREATE INDEX key_result_by_updater ON goals.key_result (workspace_id, updated_by_membership_id);
CREATE INDEX key_result_by_latest_checkin ON goals.key_result (workspace_id, latest_checkin_id);

-- ---------------------------------------------------------------------------------------------
-- Check-ins (GOAL-005, GOAL-006): append-only progress updates with confidence and a note. The
-- application can insert and read, never change or delete them; purge deletes through the worker.
-- A `computed` row is the rollup of a goal's manual key results; `inputs_hash` makes the same
-- inputs one row.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE goals.goal_checkin (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  goal_id uuid NOT NULL,
  key_result_id uuid,
  source text NOT NULL,
  value numeric(20, 4),
  progress_percent numeric(6, 2),
  confidence text,
  note text,
  inputs_hash text,
  author_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goal_checkin_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT goal_checkin_public_id_format CHECK (public_id ~ '^gci_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT goal_checkin_goal_fkey FOREIGN KEY (workspace_id, goal_id)
    REFERENCES goals.goal (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT goal_checkin_kr_fkey FOREIGN KEY (workspace_id, goal_id, key_result_id)
    REFERENCES goals.key_result (workspace_id, goal_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT goal_checkin_author_fkey FOREIGN KEY (workspace_id, author_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT goal_checkin_source_known CHECK (source IN ('manual', 'computed')),
  CONSTRAINT goal_checkin_source_shape CHECK (
    (source = 'manual' AND author_membership_id IS NOT NULL AND inputs_hash IS NULL)
    OR (source = 'computed' AND author_membership_id IS NULL AND inputs_hash IS NOT NULL
        AND key_result_id IS NULL AND confidence IS NULL AND note IS NULL AND value IS NULL
        AND progress_percent IS NOT NULL)),
  CONSTRAINT goal_checkin_value_bounded CHECK (goals.valid_value(value)),
  CONSTRAINT goal_checkin_percent_range CHECK (progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100),
  CONSTRAINT goal_checkin_confidence_known CHECK (confidence IS NULL OR confidence IN ('on_track', 'at_risk', 'off_track')),
  CONSTRAINT goal_checkin_note_text CHECK (note IS NULL OR (char_length(btrim(note)) BETWEEN 1 AND 2000
    AND tenancy.valid_plain_text(note, 2000))),
  CONSTRAINT goal_checkin_hash_format CHECK (inputs_hash IS NULL OR inputs_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT goal_checkin_not_empty CHECK (source = 'computed' OR value IS NOT NULL OR progress_percent IS NOT NULL
    OR confidence IS NOT NULL OR note IS NOT NULL)
);
CREATE UNIQUE INDEX goal_checkin_computed_unique ON goals.goal_checkin (workspace_id, goal_id, inputs_hash)
  WHERE source = 'computed';
CREATE INDEX goal_checkin_history ON goals.goal_checkin (workspace_id, goal_id, created_at DESC, id DESC);
CREATE INDEX goal_checkin_by_kr ON goals.goal_checkin (workspace_id, goal_id, key_result_id, created_at DESC, id DESC);
CREATE INDEX goal_checkin_by_author ON goals.goal_checkin (workspace_id, author_membership_id);

CREATE FUNCTION goals.goal_checkin_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  RAISE EXCEPTION 'goal check-ins are immutable' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER goal_checkin_immutable BEFORE UPDATE ON goals.goal_checkin
  FOR EACH ROW EXECUTE FUNCTION goals.goal_checkin_immutable();

ALTER TABLE goals.goal
  ADD CONSTRAINT goal_latest_checkin_fkey FOREIGN KEY (workspace_id, latest_checkin_id)
    REFERENCES goals.goal_checkin (workspace_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE goals.key_result
  ADD CONSTRAINT key_result_latest_checkin_fkey FOREIGN KEY (workspace_id, latest_checkin_id)
    REFERENCES goals.goal_checkin (workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------------------------
-- Links (GOAL-003): a goal or one of its key results to a project or a task. A link names work;
-- it grants nothing and implies no progress for work a viewer cannot read.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE goals.goal_link (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  goal_id uuid NOT NULL,
  key_result_id uuid,
  target_kind text NOT NULL,
  target_record_id uuid NOT NULL,
  target_brand_id uuid NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goal_link_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT goal_link_goal_fkey FOREIGN KEY (workspace_id, goal_id)
    REFERENCES goals.goal (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT goal_link_kr_fkey FOREIGN KEY (workspace_id, goal_id, key_result_id)
    REFERENCES goals.key_result (workspace_id, goal_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT goal_link_target_fkey FOREIGN KEY (workspace_id, target_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT goal_link_target_brand_fkey FOREIGN KEY (workspace_id, target_brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT goal_link_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT goal_link_kind_known CHECK (target_kind IN ('project', 'task'))
);
CREATE UNIQUE INDEX goal_link_unique ON goals.goal_link
  (workspace_id, goal_id, coalesce(key_result_id, '00000000-0000-0000-0000-000000000000'::uuid), target_record_id);
CREATE INDEX goal_link_by_goal ON goals.goal_link (workspace_id, goal_id);
CREATE INDEX goal_link_by_kr ON goals.goal_link (workspace_id, goal_id, key_result_id);
CREATE INDEX goal_link_by_target ON goals.goal_link (workspace_id, target_record_id);
CREATE INDEX goal_link_by_target_brand ON goals.goal_link (workspace_id, target_brand_id);
CREATE INDEX goal_link_by_creator ON goals.goal_link (workspace_id, created_by_membership_id);

-- The target is a project or a task of the stated brand, and a brand goal links only its own
-- brand's work (a workspace goal may link any brand's; each viewer still sees only what they read).
CREATE FUNCTION goals.assert_goal_link() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  tgt record;
  g record;
BEGIN
  SELECT record_type, brand_id INTO tgt FROM core.record
   WHERE workspace_id = NEW.workspace_id AND id = NEW.target_record_id;
  IF NOT FOUND OR tgt.record_type <> NEW.target_kind OR tgt.brand_id IS DISTINCT FROM NEW.target_brand_id THEN
    RAISE EXCEPTION 'a goal link names a project or a task and its brand' USING ERRCODE = 'check_violation';
  END IF;
  SELECT brand_id INTO g FROM goals.goal WHERE workspace_id = NEW.workspace_id AND id = NEW.goal_id;
  IF NOT FOUND OR (g.brand_id IS NOT NULL AND g.brand_id <> NEW.target_brand_id) THEN
    RAISE EXCEPTION 'a brand goal links work in its own brand' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER goal_link_integrity BEFORE INSERT ON goals.goal_link
  FOR EACH ROW EXECUTE FUNCTION goals.assert_goal_link();

-- ---------------------------------------------------------------------------------------------
-- Derived state (recalculation): viewer-neutral facts only. `rollup_percent` is set only when the
-- goal's progress comes from manual values (its own or its manual key results); a goal that
-- depends on linked work is `viewer_dependent` and stores no number. The worker claims rows with a
-- lease, so a crashed worker's rows return to the sweep when the lease lapses.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE goals.goal_state (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  goal_id uuid NOT NULL,
  rollup_percent numeric(6, 2),
  rollup_basis text NOT NULL DEFAULT 'none',
  inputs_hash text,
  update_state text NOT NULL DEFAULT 'never',
  period_state text NOT NULL DEFAULT 'current',
  dirty boolean NOT NULL DEFAULT true,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  computed_at timestamptz,
  CONSTRAINT goal_state_pkey PRIMARY KEY (workspace_id, goal_id),
  CONSTRAINT goal_state_goal_fkey FOREIGN KEY (workspace_id, goal_id)
    REFERENCES goals.goal (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT goal_state_percent_range CHECK (rollup_percent IS NULL OR rollup_percent BETWEEN 0 AND 100),
  CONSTRAINT goal_state_basis_known CHECK (rollup_basis IN ('none', 'manual', 'key_results', 'viewer_dependent')),
  CONSTRAINT goal_state_update_known CHECK (update_state IN ('never', 'fresh', 'stale')),
  CONSTRAINT goal_state_period_known CHECK (period_state IN ('upcoming', 'current', 'ended')),
  CONSTRAINT goal_state_hash_format CHECK (inputs_hash IS NULL OR inputs_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT goal_state_attempts CHECK (attempts >= 0),
  CONSTRAINT goal_state_error_code CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,40}$')
);
CREATE INDEX goal_state_due ON goals.goal_state (workspace_id, next_check_at);
CREATE INDEX goal_state_dirty ON goals.goal_state (workspace_id, goal_id) WHERE dirty;

-- ---------------------------------------------------------------------------------------------
-- Portfolios (GOAL-007, VIEW-009): a saved, named list of projects. Membership is a list of
-- project identities only; what a viewer sees of a portfolio is the members they may read.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE goals.portfolio (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  name text NOT NULL,
  description text,
  owner_membership_id uuid NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT portfolio_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT portfolio_scope_key UNIQUE (workspace_id, scope_key, id),
  CONSTRAINT portfolio_scope_shape CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT portfolio_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT portfolio_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 200 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 200)),
  CONSTRAINT portfolio_description_text CHECK (description IS NULL OR (char_length(btrim(description)) BETWEEN 1 AND 2000
    AND tenancy.valid_plain_text(description, 2000))),
  CONSTRAINT portfolio_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX portfolio_by_envelope ON goals.portfolio (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX portfolio_by_brand ON goals.portfolio (workspace_id, brand_id);
CREATE INDEX portfolio_by_owner ON goals.portfolio (workspace_id, owner_membership_id);
CREATE INDEX portfolio_by_creator ON goals.portfolio (workspace_id, created_by_membership_id);
CREATE INDEX portfolio_by_updater ON goals.portfolio (workspace_id, updated_by_membership_id);

CREATE TABLE goals.portfolio_project (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  portfolio_id uuid NOT NULL,
  project_id uuid NOT NULL,
  position integer NOT NULL,
  added_by_membership_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portfolio_project_pkey PRIMARY KEY (workspace_id, portfolio_id, project_id),
  CONSTRAINT portfolio_project_portfolio_fkey FOREIGN KEY (workspace_id, portfolio_id)
    REFERENCES goals.portfolio (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT portfolio_project_project_fkey FOREIGN KEY (workspace_id, project_id)
    REFERENCES work.project (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_project_adder_fkey FOREIGN KEY (workspace_id, added_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_project_position CHECK (position >= 0)
);
CREATE INDEX portfolio_project_by_project ON goals.portfolio_project (workspace_id, project_id);
CREATE INDEX portfolio_project_by_adder ON goals.portfolio_project (workspace_id, added_by_membership_id);
CREATE INDEX portfolio_project_order ON goals.portfolio_project (workspace_id, portfolio_id, position, project_id);

-- A brand portfolio holds only that brand's projects (a workspace portfolio may span brands).
CREATE FUNCTION goals.assert_portfolio_member() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  pf record;
  pr record;
BEGIN
  SELECT brand_id INTO pf FROM goals.portfolio WHERE workspace_id = NEW.workspace_id AND id = NEW.portfolio_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a portfolio member names a portfolio' USING ERRCODE = 'check_violation';
  END IF;
  SELECT brand_id INTO pr FROM work.project WHERE workspace_id = NEW.workspace_id AND id = NEW.project_id;
  IF NOT FOUND OR (pf.brand_id IS NOT NULL AND pf.brand_id <> pr.brand_id) THEN
    RAISE EXCEPTION 'a brand portfolio holds only its own brand''s projects' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER portfolio_member_integrity BEFORE INSERT ON goals.portfolio_project
  FOR EACH ROW EXECUTE FUNCTION goals.assert_portfolio_member();

-- ---------------------------------------------------------------------------------------------
-- Worker discovery (payload-free): workspaces with goals whose derived state is due (a change
-- sets the due time to now; a failure pushes it out).
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON goals.goal_state FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, dirty, next_check_at, claimed_until) ON goals.goal_state TO pm_scheduler;
GRANT USAGE ON SCHEMA goals TO pm_scheduler;

CREATE FUNCTION exec_dispatch.discover_goal_work(p_now timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.workspace_id FROM goals.goal_state s
   WHERE s.next_check_at <= p_now AND (s.claimed_until IS NULL OR s.claimed_until <= p_now)
   GROUP BY s.workspace_id
   ORDER BY min(s.next_check_at), s.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_goal_work(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_goal_work(timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_goal_work(timestamptz, integer) OWNER TO pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE goals.goal ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals.goal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goals.goal
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE goals.key_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals.key_result FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goals.key_result
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE goals.goal_checkin ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals.goal_checkin FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goals.goal_checkin
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE goals.goal_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals.goal_link FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goals.goal_link
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE goals.goal_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals.goal_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goals.goal_state
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE goals.portfolio ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals.portfolio FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goals.portfolio
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE goals.portfolio_project ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals.portfolio_project FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goals.portfolio_project
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON goals.goal, goals.key_result, goals.goal_checkin, goals.goal_link, goals.goal_state,
  goals.portfolio, goals.portfolio_project FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON goals.goal, goals.key_result, goals.portfolio TO app_rw;
GRANT SELECT, INSERT, DELETE ON goals.goal_link TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON goals.portfolio_project TO app_rw;
GRANT SELECT, INSERT ON goals.goal_checkin TO app_rw;
GRANT SELECT, INSERT, UPDATE ON goals.goal_state TO app_rw;
-- The worker recalculates derived state and appends computed check-ins; purge deletes through it.
GRANT SELECT, DELETE ON goals.goal, goals.key_result, goals.portfolio, goals.goal_link,
  goals.portfolio_project TO app_worker;
GRANT SELECT, INSERT, DELETE ON goals.goal_checkin TO app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON goals.goal_state TO app_worker;
