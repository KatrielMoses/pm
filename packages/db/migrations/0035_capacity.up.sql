-- migrate:phase expand
-- Phase 3E (0A §5, 0B ADR-30, 0C AZ-30, 0D PL-32; ADR-0022; OD-19): working hours and weekly
-- capacity, time off and unavailable periods, brand holidays, and brand capacity reservations.
-- Working hours are local wall-clock windows in the person's own zone (identity.account.timezone),
-- evaluated per date so DST days have their real length. Reservations are planning targets that
-- warn and never block. Capacity is always computed from what the viewer may read; nothing here is
-- a cache of anyone's availability.

-- ---------------------------------------------------------------------------------------------
-- Capacity profile and working hours (personal; TIME-001)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE planning.capacity_profile (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  weekly_capacity_minutes integer,
  observe_brand_holidays boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, membership_id),
  CONSTRAINT capacity_profile_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT capacity_profile_weekly CHECK (
    weekly_capacity_minutes IS NULL OR weekly_capacity_minutes BETWEEN 0 AND 10080),
  CONSTRAINT capacity_profile_version_nonnegative CHECK (version >= 0)
);

-- One row per working window: weekday 1 (Monday) to 7 (Sunday), local minutes [start, end).
CREATE TABLE planning.availability_rule (
  workspace_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  weekday smallint NOT NULL,
  start_minute smallint NOT NULL,
  end_minute smallint NOT NULL,
  PRIMARY KEY (workspace_id, membership_id, weekday, start_minute),
  CONSTRAINT availability_rule_profile_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES planning.capacity_profile (workspace_id, membership_id) ON DELETE CASCADE,
  CONSTRAINT availability_rule_weekday CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT availability_rule_window CHECK (start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute)
);

-- No two windows of one person overlap on the same weekday.
CREATE FUNCTION planning.availability_rule_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM planning.availability_rule r
             WHERE r.workspace_id = NEW.workspace_id AND r.membership_id = NEW.membership_id
               AND r.weekday = NEW.weekday AND r.start_minute <> NEW.start_minute
               AND r.start_minute < NEW.end_minute AND NEW.start_minute < r.end_minute) THEN
    RAISE EXCEPTION 'working windows overlap' USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER availability_rule_guard BEFORE INSERT OR UPDATE ON planning.availability_rule
  FOR EACH ROW EXECUTE FUNCTION planning.availability_rule_guard();

-- ---------------------------------------------------------------------------------------------
-- Time off and unavailable periods (personal; TIME-010)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE planning.time_off (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  kind text NOT NULL,
  all_day boolean NOT NULL,
  starts_on date,
  ends_on date,
  starts_at timestamptz,
  ends_at timestamptz,
  source_tz text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT time_off_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT time_off_public_id_format CHECK (public_id ~ '^tof_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT time_off_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT time_off_kind CHECK (kind IN ('vacation', 'sick', 'personal', 'holiday', 'unavailable')),
  -- All-day periods are local dates (inclusive); timed periods are instants.
  CONSTRAINT time_off_shape CHECK (
    (all_day AND starts_on IS NOT NULL AND ends_on IS NOT NULL AND starts_on <= ends_on
      AND starts_at IS NULL AND ends_at IS NULL)
    OR (NOT all_day AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND starts_at < ends_at
      AND starts_on IS NULL AND ends_on IS NULL)),
  CONSTRAINT time_off_span CHECK (
    (all_day AND ends_on - starts_on <= 366) OR (NOT all_day AND ends_at - starts_at <= interval '31 days')),
  CONSTRAINT time_off_tz CHECK (source_tz ~ '^[A-Za-z]+(/[A-Za-z0-9_+\-]+)*$' AND char_length(source_tz) <= 64),
  CONSTRAINT time_off_label CHECK (label IS NULL OR (char_length(btrim(label)) BETWEEN 1 AND 120 AND label = btrim(label))),
  CONSTRAINT time_off_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX time_off_by_member_days ON planning.time_off (workspace_id, membership_id, starts_on, ends_on);
CREATE INDEX time_off_by_member_times ON planning.time_off (workspace_id, membership_id, starts_at, ends_at);

-- ---------------------------------------------------------------------------------------------
-- Brand holidays (OD-19: manual per brand at launch; brand-scoped)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE planning.holiday (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  day date NOT NULL,
  name text NOT NULL,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holiday_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT holiday_unique UNIQUE (workspace_id, brand_id, day),
  CONSTRAINT holiday_public_id_format CHECK (public_id ~ '^hol_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT holiday_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT holiday_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT holiday_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 120 AND name = btrim(name))
);
CREATE INDEX holiday_by_brand_day ON planning.holiday (workspace_id, brand_id, day);
CREATE INDEX holiday_by_creator ON planning.holiday (workspace_id, created_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Brand capacity reservations (brand x person; TIME-002): a weekly planning target
-- ---------------------------------------------------------------------------------------------
CREATE TABLE planning.capacity_reservation (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  minutes_per_week integer NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  set_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT capacity_reservation_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT capacity_reservation_unique UNIQUE (workspace_id, brand_id, membership_id, effective_from),
  CONSTRAINT capacity_reservation_public_id_format CHECK (public_id ~ '^rsv_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT capacity_reservation_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT capacity_reservation_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT capacity_reservation_set_by_fkey FOREIGN KEY (workspace_id, set_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT capacity_reservation_minutes CHECK (minutes_per_week BETWEEN 0 AND 10080),
  CONSTRAINT capacity_reservation_period CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT capacity_reservation_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX capacity_reservation_by_member ON planning.capacity_reservation (workspace_id, membership_id, effective_from);
CREATE INDEX capacity_reservation_by_brand ON planning.capacity_reservation (workspace_id, brand_id, membership_id);
CREATE INDEX capacity_reservation_by_set_by ON planning.capacity_reservation (workspace_id, set_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE planning.capacity_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning.capacity_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON planning.capacity_profile
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE planning.availability_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning.availability_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON planning.availability_rule
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE planning.time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning.time_off FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON planning.time_off
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE planning.holiday ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning.holiday FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON planning.holiday
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE planning.capacity_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning.capacity_reservation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON planning.capacity_reservation
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON planning.capacity_profile, planning.availability_rule, planning.time_off, planning.holiday,
  planning.capacity_reservation FROM PUBLIC;
GRANT SELECT, INSERT ON planning.capacity_profile TO app_rw;
GRANT UPDATE (weekly_capacity_minutes, observe_brand_holidays, updated_at, version) ON planning.capacity_profile TO app_rw;
GRANT SELECT, INSERT, DELETE ON planning.availability_rule TO app_rw;
GRANT SELECT, INSERT, DELETE ON planning.time_off TO app_rw;
GRANT UPDATE (kind, all_day, starts_on, ends_on, starts_at, ends_at, source_tz, label, updated_at, version)
  ON planning.time_off TO app_rw;
GRANT SELECT, INSERT, DELETE ON planning.holiday TO app_rw;
GRANT SELECT, INSERT, DELETE ON planning.capacity_reservation TO app_rw;
GRANT UPDATE (minutes_per_week, effective_to, set_by_membership_id, updated_at, version)
  ON planning.capacity_reservation TO app_rw;
-- The worker purges brand holidays and reservations with their brand and departed members' rows.
GRANT SELECT, DELETE ON planning.capacity_profile, planning.availability_rule, planning.time_off,
  planning.holiday, planning.capacity_reservation TO app_worker;
REVOKE ALL ON FUNCTION planning.availability_rule_guard() FROM PUBLIC;
