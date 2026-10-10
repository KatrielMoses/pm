-- migrate:phase expand
-- Phase 3D (0A §7, 0B §6.6, 0C AZ-27, 0D PL-29; ADR-0019): time entries and timers, timesheets with
-- per-brand approval lines, append-only approval decisions, and append-only period locks.
-- Instants are UTC; every entry also keeps its IANA zone and the local work date it counts towards.
-- Durations are whole seconds computed from UTC segment instants (DST-safe). No capacity, work
-- blocks, rollups, or export adapters (3E, 3C, 5C, 6D).

CREATE SCHEMA timetrack;
REVOKE ALL ON SCHEMA timetrack FROM PUBLIC;
GRANT USAGE ON SCHEMA timetrack TO app_rw, app_worker;

-- ---------------------------------------------------------------------------------------------
-- Time entries: manual or timer; one target (a task or a project) in the work's own brand.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE timetrack.time_entry (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  task_id uuid,
  project_id uuid,
  source text NOT NULL,
  state text NOT NULL DEFAULT 'stopped',
  started_at timestamptz,
  ended_at timestamptz,
  work_date date NOT NULL,
  tz text NOT NULL,
  duration_seconds integer NOT NULL DEFAULT 0,
  billable boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '',
  auto_stopped boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT time_entry_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT time_entry_public_id_format CHECK (public_id ~ '^te_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT time_entry_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT time_entry_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  -- The entry belongs to the brand of the work; a task moved to another brand carries its entries
  -- (the lock guard refuses the move while any of them is submitted or approved).
  CONSTRAINT time_entry_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
    REFERENCES work.task (workspace_id, brand_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT time_entry_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT time_entry_one_target CHECK (num_nonnulls(task_id, project_id) = 1),
  CONSTRAINT time_entry_source_known CHECK (source IN ('manual', 'timer')),
  CONSTRAINT time_entry_state_known CHECK (state IN ('running', 'paused', 'stopped')),
  CONSTRAINT time_entry_manual_stopped CHECK (source = 'timer' OR state = 'stopped'),
  -- Timed entries have both ends once stopped; duration-only entries have neither; a timer always
  -- has a start and has an end exactly when stopped.
  CONSTRAINT time_entry_span_shape CHECK (
    (source = 'timer' AND started_at IS NOT NULL AND (ended_at IS NOT NULL) = (state = 'stopped'))
    OR (source = 'manual' AND (started_at IS NULL) = (ended_at IS NULL))),
  CONSTRAINT time_entry_span_order CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- Never negative and at most 24 hours (the widest configurable TIME_ENTRY_MAX_HOURS). A manual
  -- entry lasts at least one second; a timer stopped in the second it started records zero.
  CONSTRAINT time_entry_duration_range CHECK (duration_seconds BETWEEN 0 AND 86400
    AND (source = 'timer' OR duration_seconds >= 1)),
  CONSTRAINT time_entry_tz_format CHECK (tz ~ '^[A-Za-z]+(/[A-Za-z0-9_+\-]+)*$' AND char_length(tz) <= 64),
  CONSTRAINT time_entry_note_text CHECK (char_length(note) <= 1000),
  CONSTRAINT time_entry_auto_stop CHECK (NOT auto_stopped OR (source = 'timer' AND state = 'stopped')),
  CONSTRAINT time_entry_version_nonnegative CHECK (version >= 0)
);
-- One live timer (running or paused) per person.
CREATE UNIQUE INDEX time_entry_one_live_timer ON timetrack.time_entry (workspace_id, membership_id)
  WHERE state IN ('running', 'paused');
-- A person's entries by day (timesheets, the period guard) and every association.
CREATE INDEX time_entry_by_member_day ON timetrack.time_entry (workspace_id, membership_id, work_date, id);
CREATE INDEX time_entry_by_brand_day ON timetrack.time_entry (workspace_id, brand_id, work_date);
CREATE INDEX time_entry_by_task ON timetrack.time_entry (workspace_id, brand_id, task_id);
CREATE INDEX time_entry_by_project ON timetrack.time_entry (workspace_id, brand_id, project_id);
CREATE INDEX time_entry_by_task_only ON timetrack.time_entry (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX time_entry_by_project_only ON timetrack.time_entry (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX time_entry_live ON timetrack.time_entry (workspace_id, state) WHERE state <> 'stopped';

-- ---------------------------------------------------------------------------------------------
-- Segments: the UTC intervals a timed entry covers (one for a manual timed entry; one per run
-- between pauses for a timer). An open segment is a running timer.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE timetrack.time_segment (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  entry_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  CONSTRAINT time_segment_entry_fkey FOREIGN KEY (workspace_id, entry_id)
    REFERENCES timetrack.time_entry (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT time_segment_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  -- Half-open [started_at, ended_at): a zero-length segment (a timer stopped in its first second)
  -- covers no time.
  CONSTRAINT time_segment_order CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- Instants are whole seconds, so totals never depend on sub-second rounding.
  CONSTRAINT time_segment_whole_seconds CHECK (started_at = date_trunc('second', started_at)
    AND (ended_at IS NULL OR ended_at = date_trunc('second', ended_at)))
);
CREATE INDEX time_segment_by_entry ON timetrack.time_segment (workspace_id, entry_id);
CREATE INDEX time_segment_by_member ON timetrack.time_segment (workspace_id, membership_id, started_at);
CREATE UNIQUE INDEX time_segment_one_open ON timetrack.time_segment (workspace_id, membership_id)
  WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Timesheets: one per person and period, spanning brands; one line per brand once submitted.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE timetrack.timesheet (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  state text NOT NULL DEFAULT 'open',
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT timesheet_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT timesheet_period_key UNIQUE (workspace_id, membership_id, period_start),
  CONSTRAINT timesheet_public_id_format CHECK (public_id ~ '^tsh_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT timesheet_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT timesheet_period_shape CHECK (period_end = period_start + 6),
  CONSTRAINT timesheet_state_known CHECK (state IN ('open', 'submitted', 'approved')),
  CONSTRAINT timesheet_submitted_at CHECK ((state = 'submitted') <= (submitted_at IS NOT NULL)),
  CONSTRAINT timesheet_version_nonnegative CHECK (version >= 0)
);

CREATE TABLE timetrack.timesheet_line (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  timesheet_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  state text NOT NULL,
  submitted_seconds integer NOT NULL,
  submitted_billable_seconds integer NOT NULL,
  submitted_entries integer NOT NULL,
  submitted_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT timesheet_line_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT timesheet_line_brand_key UNIQUE (workspace_id, timesheet_id, brand_id),
  CONSTRAINT timesheet_line_sheet_fkey FOREIGN KEY (workspace_id, timesheet_id)
    REFERENCES timetrack.timesheet (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT timesheet_line_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT timesheet_line_state_known CHECK (state IN ('pending', 'approved', 'rejected', 'withdrawn', 'unlocked')),
  CONSTRAINT timesheet_line_totals CHECK (submitted_seconds >= 0 AND submitted_billable_seconds BETWEEN 0 AND submitted_seconds
    AND submitted_entries >= 0),
  CONSTRAINT timesheet_line_hash CHECK (submitted_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT timesheet_line_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX timesheet_line_by_brand ON timetrack.timesheet_line (workspace_id, brand_id, state);

-- Approval decisions (append-only evidence, R-EVIDENCE): who decided which brand line of whose
-- period, on exactly which entries (hash and totals), and whether it was a self-approval (OD-20).
CREATE TABLE timetrack.timesheet_approval (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  timesheet_id uuid NOT NULL,
  line_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  decided_by_membership_id uuid NOT NULL,
  decision text NOT NULL,
  self_approval boolean NOT NULL,
  note_hash text,
  total_seconds integer NOT NULL,
  billable_seconds integer NOT NULL,
  entry_count integer NOT NULL,
  entries_hash text NOT NULL,
  timesheet_version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timesheet_approval_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT timesheet_approval_sheet_fkey FOREIGN KEY (workspace_id, timesheet_id)
    REFERENCES timetrack.timesheet (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT timesheet_approval_line_fkey FOREIGN KEY (workspace_id, line_id)
    REFERENCES timetrack.timesheet_line (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT timesheet_approval_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT timesheet_approval_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT timesheet_approval_decider_fkey FOREIGN KEY (workspace_id, decided_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT timesheet_approval_decision_known CHECK (decision IN ('approve', 'reject')),
  CONSTRAINT timesheet_approval_self CHECK (self_approval = (membership_id = decided_by_membership_id)),
  CONSTRAINT timesheet_approval_note_hash CHECK (note_hash IS NULL OR note_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT timesheet_approval_totals CHECK (total_seconds >= 0 AND billable_seconds BETWEEN 0 AND total_seconds
    AND entry_count >= 0),
  CONSTRAINT timesheet_approval_hash CHECK (entries_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT timesheet_approval_period CHECK (period_end = period_start + 6)
);
CREATE INDEX timesheet_approval_by_sheet ON timetrack.timesheet_approval (workspace_id, timesheet_id, created_at);
CREATE INDEX timesheet_approval_by_line ON timetrack.timesheet_approval (workspace_id, line_id);
CREATE INDEX timesheet_approval_by_brand ON timetrack.timesheet_approval (workspace_id, brand_id);
CREATE INDEX timesheet_approval_by_member ON timetrack.timesheet_approval (workspace_id, membership_id);
CREATE INDEX timesheet_approval_by_decider ON timetrack.timesheet_approval (workspace_id, decided_by_membership_id);

-- Period locks (append-only, R-EVIDENCE). The latest row for (person, brand, period) decides:
-- `lock` (written by an approval) blocks every edit; `unlock` (admin, with reason, OD-26) reopens
-- the period, and the line must be submitted and approved again.
CREATE TABLE timetrack.period_lock (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  action text NOT NULL,
  approval_id uuid,
  reason text,
  by_membership_id uuid NOT NULL,
  step_up_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT period_lock_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT period_lock_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT period_lock_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT period_lock_by_fkey FOREIGN KEY (workspace_id, by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT period_lock_approval_fkey FOREIGN KEY (workspace_id, approval_id)
    REFERENCES timetrack.timesheet_approval (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT period_lock_action_known CHECK (action IN ('lock', 'unlock')),
  CONSTRAINT period_lock_shape CHECK (
    (action = 'lock' AND approval_id IS NOT NULL AND reason IS NULL AND step_up_id IS NULL)
    OR (action = 'unlock' AND approval_id IS NULL AND reason IS NOT NULL)),
  CONSTRAINT period_lock_reason_text CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT period_lock_period CHECK (period_end = period_start + 6)
);
CREATE INDEX period_lock_by_key ON timetrack.period_lock (workspace_id, membership_id, brand_id, period_start, created_at DESC, id DESC);
CREATE INDEX period_lock_by_brand ON timetrack.period_lock (workspace_id, brand_id);
CREATE INDEX period_lock_by_by ON timetrack.period_lock (workspace_id, by_membership_id);
CREATE INDEX period_lock_by_approval ON timetrack.period_lock (workspace_id, approval_id);

-- ---------------------------------------------------------------------------------------------
-- Guards (database backstops for the service rules)
-- ---------------------------------------------------------------------------------------------

-- One serialization point per person: every entry, segment, submission, decision, and unlock for a
-- person takes this transaction lock first, so a lock check and the write it protects cannot race.
CREATE FUNCTION timetrack.lock_person(p_workspace uuid, p_membership uuid) RETURNS void
  LANGUAGE sql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT pg_advisory_xact_lock(hashtextextended('timetrack.person:' || p_workspace::text || ':' || p_membership::text, 0)) $$;

-- Is this person's day closed for edits in this brand: inside a submitted timesheet, or inside a
-- period whose latest lock row for the brand is `lock`?
CREATE FUNCTION timetrack.day_closed(p_workspace uuid, p_membership uuid, p_brand uuid, p_day date) RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM timetrack.timesheet s
                  WHERE s.workspace_id = p_workspace AND s.membership_id = p_membership
                    AND s.state = 'submitted' AND p_day BETWEEN s.period_start AND s.period_end) THEN 'submitted'
    WHEN (SELECT l.action FROM timetrack.period_lock l
           WHERE l.workspace_id = p_workspace AND l.membership_id = p_membership AND l.brand_id = p_brand
             AND p_day BETWEEN l.period_start AND l.period_end
           ORDER BY l.created_at DESC, l.id DESC LIMIT 1) = 'lock' THEN 'locked'
  END
$$;

-- Entries in a submitted or locked period cannot be created, changed, moved, or deleted. The one
-- sanctioned exception is a lifecycle purge by the worker (the entry goes with its purged work; the
-- approval keeps its own totals and hash) and an explicit workspace purge.
CREATE FUNCTION timetrack.time_entry_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  closed text;
BEGIN
  IF TG_OP = 'DELETE' AND (current_user = 'app_worker'
     OR current_setting('app.purge_workspace_id', true) = OLD.workspace_id::text) THEN
    RETURN OLD;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM timetrack.lock_person(OLD.workspace_id, OLD.membership_id);
    closed := timetrack.day_closed(OLD.workspace_id, OLD.membership_id, OLD.brand_id, OLD.work_date);
    IF closed IS NOT NULL THEN
      RAISE EXCEPTION 'time_% : this period is % for edits', closed, closed USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.public_id <> OLD.public_id
     OR NEW.membership_id <> OLD.membership_id OR NEW.source <> OLD.source OR NEW.created_at <> OLD.created_at
     OR (OLD.state = 'stopped' AND NEW.state <> 'stopped')) THEN
    RAISE EXCEPTION 'time entry identity, owner, source, and stopped state are immutable' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM timetrack.lock_person(NEW.workspace_id, NEW.membership_id);
  closed := timetrack.day_closed(NEW.workspace_id, NEW.membership_id, NEW.brand_id, NEW.work_date);
  IF closed IS NOT NULL THEN
    RAISE EXCEPTION 'time_% : this period is % for edits', closed, closed USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER time_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON timetrack.time_entry
  FOR EACH ROW EXECUTE FUNCTION timetrack.time_entry_guard();

-- No overlapping time for one person: a segment may not intersect any other segment of the same
-- person (half-open intervals; an open segment extends to infinity; a zero-length segment covers
-- nothing). Serialized per person, so concurrent writers see each other.
CREATE FUNCTION timetrack.time_segment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  e record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.entry_id <> OLD.entry_id OR NEW.membership_id <> OLD.membership_id
     OR NEW.workspace_id <> OLD.workspace_id) THEN
    RAISE EXCEPTION 'segment ownership is immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT t.membership_id, t.brand_id, t.work_date INTO e FROM timetrack.time_entry t
   WHERE t.workspace_id = NEW.workspace_id AND t.id = NEW.entry_id;
  IF e.membership_id IS DISTINCT FROM NEW.membership_id THEN
    RAISE EXCEPTION 'a segment belongs to its entry''s person' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM timetrack.lock_person(NEW.workspace_id, NEW.membership_id);
  IF timetrack.day_closed(NEW.workspace_id, NEW.membership_id, e.brand_id, e.work_date) IS NOT NULL THEN
    RAISE EXCEPTION 'time_locked : this period is closed for edits' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ended_at IS DISTINCT FROM NEW.started_at AND EXISTS (
    SELECT 1 FROM timetrack.time_segment s
     WHERE s.workspace_id = NEW.workspace_id AND s.membership_id = NEW.membership_id AND s.id <> NEW.id
       AND s.ended_at IS DISTINCT FROM s.started_at
       AND s.started_at < coalesce(NEW.ended_at, 'infinity'::timestamptz)
       AND coalesce(s.ended_at, 'infinity'::timestamptz) > NEW.started_at) THEN
    RAISE EXCEPTION 'time_overlap : this time overlaps another entry' USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER time_segment_guard BEFORE INSERT OR UPDATE ON timetrack.time_segment
  FOR EACH ROW EXECUTE FUNCTION timetrack.time_segment_guard();

-- At commit, a timed entry's duration is the sum of its closed segments (for a live timer, the time
-- before its open segment), its span starts at the first segment, a running timer has exactly one
-- open segment, and a stopped entry ends at its last segment. Duration-only entries have none.
CREATE FUNCTION timetrack.time_entry_consistency() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  t record;
  s record;
BEGIN
  SELECT * INTO t FROM timetrack.time_entry WHERE workspace_id = NEW.workspace_id AND id = NEW.id;
  IF NOT FOUND OR t.started_at IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*) AS n, count(*) FILTER (WHERE ended_at IS NULL) AS open,
         min(started_at) AS first_start, max(ended_at) AS last_end,
         coalesce(sum(extract(epoch FROM ended_at - started_at)), 0)::bigint AS seconds
    INTO s FROM timetrack.time_segment WHERE workspace_id = t.workspace_id AND entry_id = t.id;
  IF s.n = 0 OR s.first_start <> t.started_at
     OR (t.state = 'running' AND s.open <> 1) OR (t.state <> 'running' AND s.open <> 0)
     OR s.seconds <> t.duration_seconds OR (t.state = 'stopped' AND s.last_end <> t.ended_at) THEN
    RAISE EXCEPTION 'time entry % does not match its segments', t.public_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER time_entry_consistency AFTER INSERT OR UPDATE ON timetrack.time_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION timetrack.time_entry_consistency();

-- Append-only evidence (approvals and lock rows). The only sanctioned deletion is an explicit
-- workspace purge.
CREATE FUNCTION timetrack.append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.purge_workspace_id', true) = OLD.workspace_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER timesheet_approval_append_only BEFORE UPDATE OR DELETE ON timetrack.timesheet_approval
  FOR EACH ROW EXECUTE FUNCTION timetrack.append_only();
CREATE TRIGGER period_lock_append_only BEFORE UPDATE OR DELETE ON timetrack.period_lock
  FOR EACH ROW EXECUTE FUNCTION timetrack.append_only();

-- Timesheet identity and period never change; lines keep their sheet and brand.
CREATE FUNCTION timetrack.timesheet_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.public_id <> OLD.public_id OR NEW.membership_id <> OLD.membership_id
     OR NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a timesheet''s person and period are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER timesheet_guard BEFORE UPDATE ON timetrack.timesheet
  FOR EACH ROW EXECUTE FUNCTION timetrack.timesheet_guard();

-- Runaway-timer discovery for the guard job: workspaces with a running timer whose closed time plus
-- its open segment has reached the limit, longest-running first, through the payload-free
-- dispatcher (workspace ids only).
CREATE POLICY scheduler_discovery ON timetrack.time_segment FOR SELECT TO pm_scheduler USING (true);
CREATE POLICY scheduler_discovery ON timetrack.time_entry FOR SELECT TO pm_scheduler USING (true);
GRANT USAGE ON SCHEMA timetrack TO pm_scheduler;
GRANT SELECT (workspace_id, entry_id, started_at, ended_at) ON timetrack.time_segment TO pm_scheduler;
GRANT SELECT (workspace_id, id, duration_seconds) ON timetrack.time_entry TO pm_scheduler;
CREATE FUNCTION exec_dispatch.discover_runaway_timers(p_now timestamptz, p_max_seconds integer, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.workspace_id FROM timetrack.time_segment s
    JOIN timetrack.time_entry e ON e.workspace_id = s.workspace_id AND e.id = s.entry_id
   WHERE s.ended_at IS NULL
     AND s.started_at <= p_now - make_interval(secs => greatest(p_max_seconds - e.duration_seconds, 0))
   GROUP BY s.workspace_id
   ORDER BY min(s.started_at), s.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE timetrack.time_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetrack.time_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timetrack.time_entry
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE timetrack.time_segment ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetrack.time_segment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timetrack.time_segment
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE timetrack.timesheet ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetrack.timesheet FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timetrack.timesheet
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE timetrack.timesheet_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetrack.timesheet_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timetrack.timesheet_line
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE timetrack.timesheet_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetrack.timesheet_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timetrack.timesheet_approval
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE timetrack.period_lock ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetrack.period_lock FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timetrack.period_lock
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON timetrack.time_entry, timetrack.time_segment, timetrack.timesheet, timetrack.timesheet_line,
  timetrack.timesheet_approval, timetrack.period_lock FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON timetrack.time_entry TO app_rw;
GRANT UPDATE (brand_id, task_id, project_id, state, started_at, ended_at, work_date, tz, duration_seconds, billable,
  note, updated_at, version) ON timetrack.time_entry TO app_rw;
GRANT SELECT, INSERT, DELETE ON timetrack.time_segment TO app_rw;
GRANT UPDATE (started_at, ended_at) ON timetrack.time_segment TO app_rw;
GRANT SELECT, INSERT ON timetrack.timesheet TO app_rw;
GRANT UPDATE (state, submitted_at, updated_at, version) ON timetrack.timesheet TO app_rw;
GRANT SELECT, INSERT ON timetrack.timesheet_line TO app_rw;
GRANT UPDATE (state, submitted_seconds, submitted_billable_seconds, submitted_entries, submitted_hash, updated_at, version)
  ON timetrack.timesheet_line TO app_rw;
GRANT SELECT, INSERT ON timetrack.timesheet_approval, timetrack.period_lock TO app_rw;
-- The worker stops runaway timers and removes the entries of purged work.
GRANT SELECT, DELETE ON timetrack.time_entry, timetrack.time_segment TO app_worker;
GRANT UPDATE (state, ended_at, duration_seconds, auto_stopped, updated_at, version) ON timetrack.time_entry TO app_worker;
GRANT UPDATE (ended_at) ON timetrack.time_segment TO app_worker;
GRANT SELECT ON timetrack.timesheet, timetrack.period_lock TO app_worker;

REVOKE ALL ON FUNCTION timetrack.lock_person(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION timetrack.lock_person(uuid, uuid) TO app_rw, app_worker;
REVOKE ALL ON FUNCTION timetrack.day_closed(uuid, uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION timetrack.day_closed(uuid, uuid, uuid, date) TO app_rw, app_worker;
REVOKE ALL ON FUNCTION timetrack.time_entry_guard(), timetrack.time_segment_guard(), timetrack.time_entry_consistency(),
  timetrack.append_only(), timetrack.timesheet_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION exec_dispatch.discover_runaway_timers(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_runaway_timers(timestamptz, integer, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_runaway_timers(timestamptz, integer, integer) OWNER TO pm_scheduler;
