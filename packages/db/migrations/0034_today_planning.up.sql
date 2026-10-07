-- migrate:phase expand
-- Phase 3C (0A §1–§2 and §6, 0B §6.4, 0C AZ-29, 0D PL-31; ADR-0021): personal Today commitments,
-- work blocks (distinct from due dates and deadlines), recurring blocks, and append-only daily
-- records. Every row is personal (one owner); task-linked rows carry the task's brand through the
-- task key so a task moved to another brand carries them. No working hours, capacity, calendar
-- events, or AI plans (3E, 6C, 7F).

-- ---------------------------------------------------------------------------------------------
-- Work blocks: calendar time reserved to do work (manual, from an estimate, or a series).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE planning.work_block (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  task_id uuid,
  brand_id uuid,
  title text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  source_tz text NOT NULL,
  focus boolean NOT NULL DEFAULT false,
  locked boolean NOT NULL DEFAULT false,
  prep_minutes integer NOT NULL DEFAULT 0,
  buffer_minutes integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual',
  series_id uuid,
  occurrence_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT work_block_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT work_block_public_id_format CHECK (public_id ~ '^blk_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT work_block_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_block_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
    REFERENCES work.task (workspace_id, brand_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT work_block_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_block_task_brand CHECK ((task_id IS NULL) = (brand_id IS NULL)),
  CONSTRAINT work_block_title CHECK (title IS NULL OR (char_length(btrim(title)) BETWEEN 1 AND 200 AND title = btrim(title))),
  CONSTRAINT work_block_names_work CHECK (task_id IS NOT NULL OR title IS NOT NULL),
  -- Whole minutes; at least 5 minutes and at most 24 hours.
  CONSTRAINT work_block_minutes CHECK (starts_at = date_trunc('minute', starts_at) AND ends_at = date_trunc('minute', ends_at)),
  CONSTRAINT work_block_span CHECK (ends_at - starts_at BETWEEN interval '5 minutes' AND interval '24 hours'),
  CONSTRAINT work_block_tz CHECK (source_tz ~ '^[A-Za-z]+(/[A-Za-z0-9_+\-]+)*$' AND char_length(source_tz) <= 64),
  CONSTRAINT work_block_padding CHECK (prep_minutes BETWEEN 0 AND 240 AND buffer_minutes BETWEEN 0 AND 240),
  CONSTRAINT work_block_source_known CHECK (source IN ('manual', 'estimate', 'recurrence')),
  CONSTRAINT work_block_series_shape CHECK ((source = 'recurrence') = (series_id IS NOT NULL)
    AND (series_id IS NULL) = (occurrence_key IS NULL)),
  CONSTRAINT work_block_version_nonnegative CHECK (version >= 0)
);
-- One occurrence per series and local date-time (idempotent generation).
CREATE UNIQUE INDEX work_block_occurrence ON planning.work_block (workspace_id, series_id, occurrence_key)
  WHERE series_id IS NOT NULL;
CREATE INDEX work_block_by_owner_time ON planning.work_block (workspace_id, owner_membership_id, starts_at);
CREATE INDEX work_block_by_task ON planning.work_block (workspace_id, brand_id, task_id);
CREATE INDEX work_block_by_task_only ON planning.work_block (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX work_block_by_brand ON planning.work_block (workspace_id, brand_id);
CREATE INDEX work_block_by_series ON planning.work_block (workspace_id, series_id);

-- ---------------------------------------------------------------------------------------------
-- Block series: recurring calendar work (CAL-005), evaluated by the 2A rule engine.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE planning.block_series (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  task_id uuid,
  brand_id uuid,
  title text,
  rrule text NOT NULL,
  anchor_tz text NOT NULL,
  dtstart_local timestamp NOT NULL,
  duration_minutes integer NOT NULL,
  focus boolean NOT NULL DEFAULT false,
  prep_minutes integer NOT NULL DEFAULT 0,
  buffer_minutes integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'active',
  generated_through timestamp,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT block_series_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT block_series_public_id_format CHECK (public_id ~ '^bls_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT block_series_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT block_series_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
    REFERENCES work.task (workspace_id, brand_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT block_series_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT block_series_task_brand CHECK ((task_id IS NULL) = (brand_id IS NULL)),
  CONSTRAINT block_series_title CHECK (title IS NULL OR (char_length(btrim(title)) BETWEEN 1 AND 200 AND title = btrim(title))),
  CONSTRAINT block_series_names_work CHECK (task_id IS NOT NULL OR title IS NOT NULL),
  CONSTRAINT block_series_rrule CHECK (rrule ~ '^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$'
    AND char_length(rrule) <= 200),
  CONSTRAINT block_series_tz CHECK (anchor_tz ~ '^[A-Za-z]+(/[A-Za-z0-9_+\-]+)*$' AND char_length(anchor_tz) <= 64),
  CONSTRAINT block_series_duration CHECK (duration_minutes BETWEEN 5 AND 1440),
  CONSTRAINT block_series_padding CHECK (prep_minutes BETWEEN 0 AND 240 AND buffer_minutes BETWEEN 0 AND 240),
  CONSTRAINT block_series_state_known CHECK (state IN ('active', 'ended')),
  CONSTRAINT block_series_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX block_series_by_owner ON planning.block_series (workspace_id, owner_membership_id, state);
CREATE INDEX block_series_by_task ON planning.block_series (workspace_id, brand_id, task_id);
CREATE INDEX block_series_by_task_only ON planning.block_series (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX block_series_by_brand ON planning.block_series (workspace_id, brand_id);
ALTER TABLE planning.work_block ADD CONSTRAINT work_block_series_fkey FOREIGN KEY (workspace_id, series_id)
  REFERENCES planning.block_series (workspace_id, id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------------------------
-- Today commitments: a person's choice to do a task on a day. Never changes the task's dates.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE planning.today_commitment (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  day date NOT NULL,
  task_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  rank text COLLATE "C" NOT NULL,
  locked boolean NOT NULL DEFAULT false,
  outcome text NOT NULL DEFAULT 'open',
  carried_to date,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT today_commitment_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT today_commitment_once UNIQUE (workspace_id, owner_membership_id, day, task_id),
  CONSTRAINT today_commitment_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT today_commitment_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
    REFERENCES work.task (workspace_id, brand_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT today_commitment_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT today_commitment_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT today_commitment_outcome_known CHECK (outcome IN ('open', 'done', 'carried', 'returned', 'dropped')),
  CONSTRAINT today_commitment_carried CHECK ((outcome = 'carried') = (carried_to IS NOT NULL) AND (carried_to IS NULL OR carried_to > day)),
  CONSTRAINT today_commitment_closed CHECK ((outcome = 'open') = (closed_at IS NULL)),
  CONSTRAINT today_commitment_source_known CHECK (source IN ('manual', 'plan', 'carry')),
  CONSTRAINT today_commitment_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX today_commitment_by_day ON planning.today_commitment (workspace_id, owner_membership_id, day, rank);
CREATE INDEX today_commitment_by_task ON planning.today_commitment (workspace_id, brand_id, task_id);
CREATE INDEX today_commitment_by_task_only ON planning.today_commitment (task_id);
CREATE INDEX today_commitment_by_brand ON planning.today_commitment (workspace_id, brand_id);
CREATE INDEX today_commitment_open ON planning.today_commitment (workspace_id, day) WHERE outcome = 'open';

-- ---------------------------------------------------------------------------------------------
-- Daily records: what was committed, completed, carried, returned, and dropped on a day, and
-- planned versus actual time. Written once (at shutdown or by the day-close job), never updated.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE planning.daily_record (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  day date NOT NULL,
  tz text NOT NULL,
  closed_by text NOT NULL,
  committed integer NOT NULL,
  completed integer NOT NULL,
  carried integer NOT NULL,
  returned integer NOT NULL,
  dropped integer NOT NULL,
  planned_minutes integer NOT NULL,
  unestimated integer NOT NULL,
  block_minutes integer NOT NULL,
  focus_minutes integer NOT NULL,
  actual_seconds integer NOT NULL,
  items jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_record_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT daily_record_once UNIQUE (workspace_id, owner_membership_id, day),
  CONSTRAINT daily_record_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT daily_record_closed_by CHECK (closed_by IN ('shutdown', 'auto')),
  CONSTRAINT daily_record_counts CHECK (committed >= 0 AND completed >= 0 AND carried >= 0 AND returned >= 0
    AND dropped >= 0 AND completed + carried + returned + dropped = committed),
  CONSTRAINT daily_record_time CHECK (planned_minutes >= 0 AND unestimated >= 0 AND block_minutes >= 0
    AND focus_minutes BETWEEN 0 AND block_minutes AND actual_seconds >= 0),
  CONSTRAINT daily_record_tz CHECK (tz ~ '^[A-Za-z]+(/[A-Za-z0-9_+\-]+)*$' AND char_length(tz) <= 64),
  CONSTRAINT daily_record_items CHECK (jsonb_typeof(items) = 'array' AND pg_column_size(items) <= 262144)
);

-- ---------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------

-- A focus block is protected (PLAN-014): no other block of the same person may overlap its
-- occupied time (its preparation and buffer included), and a focus block may not be placed over
-- other blocks. Serialized per person.
CREATE FUNCTION planning.work_block_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.public_id <> OLD.public_id
     OR NEW.owner_membership_id <> OLD.owner_membership_id OR NEW.source <> OLD.source
     OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.occurrence_key IS DISTINCT FROM OLD.occurrence_key
     OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'a work block''s owner, source, and series are immutable' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('planning.blocks:' || NEW.workspace_id::text || ':' || NEW.owner_membership_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM planning.work_block b
     WHERE b.workspace_id = NEW.workspace_id AND b.owner_membership_id = NEW.owner_membership_id AND b.id <> NEW.id
       AND (b.focus OR NEW.focus)
       AND b.starts_at - make_interval(mins => b.prep_minutes) < NEW.ends_at + make_interval(mins => NEW.buffer_minutes)
       AND b.ends_at + make_interval(mins => b.buffer_minutes) > NEW.starts_at - make_interval(mins => NEW.prep_minutes)) THEN
    RAISE EXCEPTION 'focus_protected : this time overlaps a focus block' USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER work_block_guard BEFORE INSERT OR UPDATE ON planning.work_block
  FOR EACH ROW EXECUTE FUNCTION planning.work_block_guard();

-- Commitments keep their owner, day, and task; a closed commitment is final.
CREATE FUNCTION planning.today_commitment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.owner_membership_id <> OLD.owner_membership_id OR NEW.day <> OLD.day
     OR NEW.task_id <> OLD.task_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a commitment''s owner, day, and task are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.outcome <> 'open' AND (NEW.outcome <> OLD.outcome OR NEW.carried_to IS DISTINCT FROM OLD.carried_to
     OR NEW.rank <> OLD.rank) THEN
    RAISE EXCEPTION 'a closed commitment is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER today_commitment_guard BEFORE UPDATE ON planning.today_commitment
  FOR EACH ROW EXECUTE FUNCTION planning.today_commitment_guard();

-- Daily records are snapshots: never updated (deletion only through personal-data erasure).
CREATE FUNCTION planning.daily_record_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  RAISE EXCEPTION 'daily records are never rewritten' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER daily_record_guard BEFORE UPDATE ON planning.daily_record
  FOR EACH ROW EXECUTE FUNCTION planning.daily_record_guard();

-- Day-close discovery for the worker: workspaces with open commitments on days before the given
-- UTC date and no record for that person and day (payload-free; workspace ids only).
CREATE POLICY scheduler_discovery ON planning.today_commitment FOR SELECT TO pm_scheduler USING (true);
CREATE POLICY scheduler_discovery ON planning.daily_record FOR SELECT TO pm_scheduler USING (true);
CREATE POLICY scheduler_discovery ON planning.block_series FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, owner_membership_id, day, outcome) ON planning.today_commitment TO pm_scheduler;
GRANT SELECT (workspace_id, owner_membership_id, day) ON planning.daily_record TO pm_scheduler;
GRANT SELECT (workspace_id, state, generated_through) ON planning.block_series TO pm_scheduler;
CREATE FUNCTION exec_dispatch.discover_days_to_close(p_before date, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT c.workspace_id FROM planning.today_commitment c
   WHERE c.day < p_before AND NOT EXISTS (
     SELECT 1 FROM planning.daily_record r
      WHERE r.workspace_id = c.workspace_id AND r.owner_membership_id = c.owner_membership_id AND r.day = c.day)
   GROUP BY c.workspace_id
   ORDER BY min(c.day), c.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
CREATE FUNCTION exec_dispatch.discover_block_series_due(p_through timestamp, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.workspace_id FROM planning.block_series s
   WHERE s.state = 'active' AND (s.generated_through IS NULL OR s.generated_through < p_through)
   GROUP BY s.workspace_id
   ORDER BY min(coalesce(s.generated_through, '-infinity'::timestamp)), s.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE planning.work_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning.work_block FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON planning.work_block
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE planning.block_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning.block_series FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON planning.block_series
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE planning.today_commitment ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning.today_commitment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON planning.today_commitment
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE planning.daily_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning.daily_record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON planning.daily_record
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON planning.work_block, planning.block_series, planning.today_commitment, planning.daily_record FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON planning.work_block TO app_rw;
GRANT UPDATE (title, starts_at, ends_at, source_tz, focus, locked, prep_minutes, buffer_minutes, updated_at, version)
  ON planning.work_block TO app_rw;
GRANT SELECT, INSERT, DELETE ON planning.block_series TO app_rw;
GRANT UPDATE (state, generated_through, updated_at, version) ON planning.block_series TO app_rw;
GRANT SELECT, INSERT, DELETE ON planning.today_commitment TO app_rw;
GRANT UPDATE (rank, locked, outcome, carried_to, closed_at, updated_at, version) ON planning.today_commitment TO app_rw;
GRANT SELECT, INSERT, DELETE ON planning.daily_record TO app_rw;
-- The worker closes past days, extends block series, and purges rows of purged tasks.
GRANT SELECT, INSERT, DELETE ON planning.work_block, planning.daily_record TO app_worker;
GRANT SELECT, DELETE ON planning.today_commitment TO app_worker;
GRANT UPDATE (outcome, closed_at, updated_at, version) ON planning.today_commitment TO app_worker;
GRANT SELECT, DELETE ON planning.block_series TO app_worker;
GRANT UPDATE (state, generated_through, updated_at, version) ON planning.block_series TO app_worker;
-- Day close evaluates each person's day in their own zone (OD-18): the zone column only.
GRANT SELECT (id, timezone) ON identity.account TO app_worker;

REVOKE ALL ON FUNCTION planning.work_block_guard(), planning.today_commitment_guard(), planning.daily_record_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION exec_dispatch.discover_days_to_close(date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_days_to_close(date, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_days_to_close(date, integer) OWNER TO pm_scheduler;
REVOKE ALL ON FUNCTION exec_dispatch.discover_block_series_due(timestamp, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_block_series_due(timestamp, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_block_series_due(timestamp, integer) OWNER TO pm_scheduler;
