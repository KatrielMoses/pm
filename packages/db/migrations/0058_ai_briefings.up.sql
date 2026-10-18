-- migrate:phase expand
-- Phase 7E briefings and reviews (0B ADR-49, ADR-0042). Reconciles the 0B briefing entities: a
-- personal schedule, a recipient-specific briefing (detail of a `briefing` operation), its
-- source-linked statements, recipient-scoped corrections with a reference-only history, and (corrective
-- review 01) the complete authorization basis of statements and corrections.
-- Briefing text and correction text are content: erased on departure and retention. Builds on
-- 0053–0057; no earlier file changes.

-- ---------------------------------------------------------------------------------------------
-- A person's briefing schedule: type, scope, IANA zone, local time, weekdays, channels. Its
-- revision increases with every change; queued occurrences of an older revision are superseded.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.briefing_schedule (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  public_id text NOT NULL,
  membership_id uuid NOT NULL,
  kind text NOT NULL,
  scope jsonb NOT NULL,
  scope_key text NOT NULL,
  timezone text NOT NULL,
  local_minute integer NOT NULL,
  weekdays smallint[] NOT NULL,
  channels text[] NOT NULL DEFAULT '{in_app}',
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT briefing_schedule_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT briefing_schedule_public_id_unique UNIQUE (public_id),
  CONSTRAINT briefing_schedule_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT briefing_schedule_public_id CHECK (public_id ~ '^bsc_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT briefing_schedule_kind CHECK (kind IN ('owner_daily', 'brand_daily', 'weekly_review', 'project_status', 'release_readiness')),
  CONSTRAINT briefing_schedule_scope CHECK (jsonb_typeof(scope) = 'object' AND pg_column_size(scope) <= 1024),
  CONSTRAINT briefing_schedule_scope_key CHECK (scope_key ~ '^(workspace|brand:br_[0-9A-HJKMNP-TV-Z]{26}|project:prj_[0-9A-HJKMNP-TV-Z]{26})$'),
  CONSTRAINT briefing_schedule_timezone CHECK (char_length(timezone) BETWEEN 1 AND 64),
  CONSTRAINT briefing_schedule_minute CHECK (local_minute BETWEEN 0 AND 1439),
  CONSTRAINT briefing_schedule_weekdays CHECK (cardinality(weekdays) BETWEEN 1 AND 7
    AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  CONSTRAINT briefing_schedule_channels CHECK (cardinality(channels) BETWEEN 1 AND 2
    AND channels <@ ARRAY['in_app', 'email']::text[] AND 'in_app' = ANY (channels)),
  CONSTRAINT briefing_schedule_revision CHECK (revision >= 1)
);
CREATE INDEX briefing_schedule_by_member ON ai.briefing_schedule (workspace_id, membership_id);
CREATE INDEX briefing_schedule_due ON ai.briefing_schedule (workspace_id, next_run_at) WHERE enabled;

-- ---------------------------------------------------------------------------------------------
-- One briefing for one recipient: its `briefing` operation, frozen scope, window and cutoff, the
-- baseline it compares with, and (for a schedule) the occurrence it fulfils exactly once.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.briefing (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  public_id text NOT NULL,
  operation_id uuid NOT NULL,
  recipient_membership_id uuid NOT NULL,
  schedule_id uuid,
  schedule_revision integer,
  occurrence_key text,
  trigger text NOT NULL,
  regenerates_id uuid,
  kind text NOT NULL,
  scope jsonb NOT NULL,
  scope_key text NOT NULL,
  template_version text NOT NULL,
  timezone text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  baseline_briefing_id uuid,
  state text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  failure_code text,
  coverage jsonb,
  content_state text NOT NULL DEFAULT 'present',
  content_erased_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT briefing_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT briefing_public_id_unique UNIQUE (public_id),
  CONSTRAINT briefing_operation_unique UNIQUE (workspace_id, operation_id),
  CONSTRAINT briefing_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT briefing_recipient_fkey FOREIGN KEY (workspace_id, recipient_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT briefing_schedule_fkey FOREIGN KEY (workspace_id, schedule_id)
    REFERENCES ai.briefing_schedule (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT briefing_regenerates_fkey FOREIGN KEY (workspace_id, regenerates_id)
    REFERENCES ai.briefing (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT briefing_baseline_fkey FOREIGN KEY (workspace_id, baseline_briefing_id)
    REFERENCES ai.briefing (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT briefing_public_id CHECK (public_id ~ '^brf_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT briefing_trigger CHECK (trigger IN ('schedule', 'manual', 'regenerate')),
  CONSTRAINT briefing_occurrence CHECK ((trigger = 'schedule') = (schedule_id IS NOT NULL AND occurrence_key IS NOT NULL
    AND schedule_revision IS NOT NULL) AND (occurrence_key IS NULL OR char_length(occurrence_key) <= 200)),
  CONSTRAINT briefing_regenerates CHECK ((trigger = 'regenerate') = (regenerates_id IS NOT NULL)),
  CONSTRAINT briefing_kind CHECK (kind IN ('owner_daily', 'brand_daily', 'weekly_review', 'project_status', 'release_readiness')),
  CONSTRAINT briefing_scope CHECK (jsonb_typeof(scope) = 'object' AND pg_column_size(scope) <= 1024),
  CONSTRAINT briefing_scope_key CHECK (scope_key ~ '^(workspace|brand:br_[0-9A-HJKMNP-TV-Z]{26}|project:prj_[0-9A-HJKMNP-TV-Z]{26})$'),
  CONSTRAINT briefing_window CHECK (window_start < window_end),
  CONSTRAINT briefing_state CHECK (state IN ('queued', 'published', 'failed', 'superseded')),
  CONSTRAINT briefing_failure CHECK ((state = 'failed') = (failure_code IS NOT NULL)
    AND (failure_code IS NULL OR failure_code ~ '^[a-z_]{1,64}$')),
  CONSTRAINT briefing_published CHECK ((state = 'published') = (published_at IS NOT NULL)),
  CONSTRAINT briefing_coverage CHECK (coverage IS NULL OR (jsonb_typeof(coverage) = 'object' AND pg_column_size(coverage) <= 4096)),
  CONSTRAINT briefing_content_state CHECK (content_state IN ('present', 'erased')
    AND (content_state = 'present') = (content_erased_at IS NULL))
);
CREATE UNIQUE INDEX briefing_one_per_occurrence ON ai.briefing (workspace_id, schedule_id, occurrence_key)
  WHERE trigger = 'schedule';
CREATE INDEX briefing_by_recipient ON ai.briefing (workspace_id, recipient_membership_id, created_at DESC);
CREATE INDEX briefing_comparable ON ai.briefing (workspace_id, recipient_membership_id, kind, scope_key, window_end DESC)
  WHERE state = 'published';
CREATE INDEX briefing_pending ON ai.briefing (workspace_id, state) WHERE state = 'queued';
CREATE INDEX briefing_by_schedule ON ai.briefing (workspace_id, schedule_id);
CREATE INDEX briefing_by_regenerates ON ai.briefing (workspace_id, regenerates_id);
CREATE INDEX briefing_by_baseline ON ai.briefing (workspace_id, baseline_briefing_id);

-- ---------------------------------------------------------------------------------------------
-- Statements: section, trust kind, a stable key (for corrections), text (content), and the
-- authorized evidence references (record public ids and versions only).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.briefing_statement (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  briefing_id uuid NOT NULL,
  position integer NOT NULL,
  section text NOT NULL,
  kind text NOT NULL,
  statement_key text NOT NULL,
  text text,
  refs jsonb NOT NULL DEFAULT '[]',
  figures jsonb,
  correction_id uuid,
  CONSTRAINT briefing_statement_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT briefing_statement_position_unique UNIQUE (briefing_id, position),
  CONSTRAINT briefing_statement_briefing_fkey FOREIGN KEY (workspace_id, briefing_id)
    REFERENCES ai.briefing (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT briefing_statement_position CHECK (position BETWEEN 0 AND 999),
  CONSTRAINT briefing_statement_section CHECK (section ~ '^[a-z_]{1,40}$'),
  CONSTRAINT briefing_statement_kind CHECK (kind IN ('fact', 'calculation', 'excerpt', 'suggestion', 'unknown', 'annotation', 'unavailable')),
  CONSTRAINT briefing_statement_key CHECK (char_length(statement_key) BETWEEN 1 AND 200),
  CONSTRAINT briefing_statement_text CHECK (text IS NULL OR char_length(text) <= 2000),
  CONSTRAINT briefing_statement_refs CHECK (jsonb_typeof(refs) = 'array' AND pg_column_size(refs) <= 8192),
  CONSTRAINT briefing_statement_figures CHECK (figures IS NULL OR (jsonb_typeof(figures) = 'object' AND pg_column_size(figures) <= 2048))
);
CREATE INDEX briefing_statement_by_briefing ON ai.briefing_statement (workspace_id, briefing_id, position);

-- ---------------------------------------------------------------------------------------------
-- Corrections: a recipient-scoped annotation for one statement key in one briefing type and
-- scope, bound to the subject's version. Never an edit to the record or a global instruction.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.briefing_correction (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  public_id text NOT NULL,
  recipient_membership_id uuid NOT NULL,
  origin_briefing_id uuid NOT NULL,
  kind text NOT NULL,
  scope_key text NOT NULL,
  statement_key text NOT NULL,
  subject_public_id text,
  subject_version text,
  text text,
  state text NOT NULL DEFAULT 'proposed',
  revision integer NOT NULL DEFAULT 1,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT briefing_correction_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT briefing_correction_public_id_unique UNIQUE (public_id),
  CONSTRAINT briefing_correction_recipient_fkey FOREIGN KEY (workspace_id, recipient_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT briefing_correction_origin_fkey FOREIGN KEY (workspace_id, origin_briefing_id)
    REFERENCES ai.briefing (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT briefing_correction_public_id CHECK (public_id ~ '^bco_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT briefing_correction_kind CHECK (kind IN ('owner_daily', 'brand_daily', 'weekly_review', 'project_status', 'release_readiness')),
  CONSTRAINT briefing_correction_scope_key CHECK (scope_key ~ '^(workspace|brand:br_[0-9A-HJKMNP-TV-Z]{26}|project:prj_[0-9A-HJKMNP-TV-Z]{26})$'),
  CONSTRAINT briefing_correction_statement_key CHECK (char_length(statement_key) BETWEEN 1 AND 200),
  CONSTRAINT briefing_correction_subject CHECK ((subject_public_id IS NULL) = (subject_version IS NULL)),
  CONSTRAINT briefing_correction_state CHECK (state IN ('proposed', 'approved', 'rejected', 'superseded', 'stale', 'erased')),
  CONSTRAINT briefing_correction_text CHECK ((state = 'erased') = (text IS NULL) AND (text IS NULL OR char_length(text) BETWEEN 1 AND 1000))
);
CREATE INDEX briefing_correction_lookup ON ai.briefing_correction (workspace_id, recipient_membership_id, kind, scope_key, statement_key);
CREATE INDEX briefing_correction_origin ON ai.briefing_correction (workspace_id, origin_briefing_id);

CREATE TABLE ai.briefing_correction_event (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  correction_id uuid NOT NULL,
  kind text NOT NULL,
  revision integer NOT NULL,
  actor_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT briefing_correction_event_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT briefing_correction_event_correction_fkey FOREIGN KEY (workspace_id, correction_id)
    REFERENCES ai.briefing_correction (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT briefing_correction_event_kind CHECK (kind IN ('proposed', 'edited', 'approved', 'rejected', 'superseded', 'stale', 'erased'))
);
CREATE INDEX briefing_correction_event_by_correction ON ai.briefing_correction_event (workspace_id, correction_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Corrective review 01 (R1, R2): the complete authorization basis of every statement and of every
-- correction (record, brand, and exact-brand permission references; no content). Display, replay,
-- notification rendering, and every correction surface re-check it before showing saved content.
-- Records and brands are references (a purge leaves a tombstone, so there is no foreign key).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ai.briefing_evidence (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  briefing_id uuid,
  correction_id uuid,
  position integer,
  kind text NOT NULL,
  record_id uuid,
  brand_id uuid,
  permission text,
  CONSTRAINT briefing_evidence_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT briefing_evidence_briefing_fkey FOREIGN KEY (workspace_id, briefing_id)
    REFERENCES ai.briefing (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT briefing_evidence_correction_fkey FOREIGN KEY (workspace_id, correction_id)
    REFERENCES ai.briefing_correction (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT briefing_evidence_owner CHECK ((briefing_id IS NULL) <> (correction_id IS NULL)
    AND (briefing_id IS NULL OR position BETWEEN 0 AND 999) AND (correction_id IS NULL OR position IS NULL)),
  CONSTRAINT briefing_evidence_kind CHECK (
    (kind = 'record' AND record_id IS NOT NULL AND brand_id IS NULL AND permission IS NULL)
    OR (kind = 'brand' AND record_id IS NULL AND brand_id IS NOT NULL AND permission IS NULL)
    OR (kind = 'permission' AND record_id IS NULL AND brand_id IS NOT NULL AND permission IN ('timesheet.approve')))
);
CREATE INDEX briefing_evidence_by_briefing ON ai.briefing_evidence (workspace_id, briefing_id, position);
CREATE INDEX briefing_evidence_by_correction ON ai.briefing_evidence (workspace_id, correction_id);

-- ---------------------------------------------------------------------------------------------
-- Discovery for the briefing sweep (ids only): due schedules and queued briefings.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON ai.briefing_schedule FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, enabled, next_run_at) ON ai.briefing_schedule TO pm_scheduler;
CREATE POLICY scheduler_discovery ON ai.briefing FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, state, updated_at) ON ai.briefing TO pm_scheduler;

CREATE FUNCTION exec_dispatch.discover_briefing_work(p_now timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.workspace_id FROM (
    SELECT s.workspace_id, min(s.next_run_at) AS due FROM ai.briefing_schedule s
     WHERE s.enabled AND s.next_run_at <= p_now GROUP BY s.workspace_id
    UNION ALL
    SELECT b.workspace_id, min(b.updated_at) FROM ai.briefing b
     WHERE b.state = 'queued' GROUP BY b.workspace_id
  ) w
  GROUP BY w.workspace_id
  ORDER BY min(w.due), w.workspace_id
  LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_briefing_work(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_briefing_work(timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_briefing_work(timestamptz, integer) OWNER TO pm_scheduler;

-- Corrective review 01 (R3): configured technical retention finds briefing content on its own, so
-- a workspace with briefings and no (or only erased) AI runs is still swept. Ids only.
GRANT SELECT (content_state, created_at) ON ai.briefing TO pm_scheduler;
CREATE FUNCTION exec_dispatch.discover_briefing_retention_work(p_before timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT b.workspace_id FROM ai.briefing b
   WHERE b.content_state = 'present' AND b.created_at < p_before
   GROUP BY b.workspace_id
   ORDER BY min(b.created_at), b.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_briefing_retention_work(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_briefing_retention_work(timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_briefing_retention_work(timestamptz, integer) OWNER TO pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants. Nothing is deleted by an application role; erasure clears text.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.briefing_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.briefing_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.briefing_schedule
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.briefing ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.briefing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.briefing
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.briefing_statement ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.briefing_statement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.briefing_statement
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.briefing_correction ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.briefing_correction FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.briefing_correction
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.briefing_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.briefing_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.briefing_evidence
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE ai.briefing_correction_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.briefing_correction_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.briefing_correction_event
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON ai.briefing_schedule, ai.briefing, ai.briefing_statement, ai.briefing_correction
  TO app_rw, app_worker;
GRANT SELECT, INSERT ON ai.briefing_correction_event, ai.briefing_evidence TO app_rw, app_worker;

-- The briefing sweep composes as each recipient through the canonical readers; the timesheet
-- approval reader needs read access for the worker role (read only; no write is granted).
GRANT SELECT ON timetrack.timesheet_line TO app_worker;
