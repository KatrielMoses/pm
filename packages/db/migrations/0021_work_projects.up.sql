-- migrate:phase expand
-- Phase 2A projects (0B ADR-21, 0C AZ-21, 0D PL-22): the work and workflow schemas, project
-- structures, the immutable platform project statuses, project-scoped role assignments, and the
-- deferred last-project-manager guard.
--
-- Authority stays access.role_assignment (+ access.record_grant). Nothing here stores computed
-- authorization: owner_membership_id is responsibility, ancestry and status_category are guarded
-- denormalizations.

-- Rich text version 1 (0D PL-23, schema `rich-text`): the plain-text subset of the canonical
-- versioned envelope {type: "doc", version, content}. Paragraphs of unmarked text nodes only; no
-- other nodes, marks, or attributes; non-empty text nodes without line breaks or control characters;
-- some non-whitespace text; at most max_len code points of extracted text (paragraphs joined by a
-- line break). The service validates the same rules first (@pm/contracts/rich-text); this is the
-- database boundary.
CREATE FUNCTION tenancy.valid_rich_text(doc jsonb, max_len integer) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  p jsonb;
  t jsonb;
  line text;
  lines text[] := '{}';
  txt text;
BEGIN
  IF doc IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(doc) <> 'object' OR doc->>'type' IS DISTINCT FROM 'doc'
     OR doc->'version' IS DISTINCT FROM '1'::jsonb
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(doc) k WHERE k NOT IN ('type', 'version', 'content'))
     OR jsonb_typeof(doc->'content') IS DISTINCT FROM 'array'
     OR jsonb_array_length(doc->'content') = 0 THEN
    RETURN false;
  END IF;
  FOR p IN SELECT value FROM jsonb_array_elements(doc->'content') LOOP
    IF jsonb_typeof(p) <> 'object' OR p->>'type' IS DISTINCT FROM 'paragraph'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('type', 'content'))
       OR jsonb_typeof(p->'content') IS DISTINCT FROM 'array' THEN
      RETURN false;
    END IF;
    line := '';
    FOR t IN SELECT value FROM jsonb_array_elements(p->'content') LOOP
      IF jsonb_typeof(t) <> 'object' OR t->>'type' IS DISTINCT FROM 'text'
         OR EXISTS (SELECT 1 FROM jsonb_object_keys(t) k WHERE k NOT IN ('type', 'text'))
         OR jsonb_typeof(t->'text') IS DISTINCT FROM 'string' OR t->>'text' = ''
         OR t->>'text' ~ '[\x01-\x08\x0a-\x1f\x7f]' THEN
        RETURN false;
      END IF;
      line := line || (t->>'text');
    END LOOP;
    lines := lines || line;
  END LOOP;
  txt := array_to_string(lines, E'\n');
  RETURN txt ~ '[^[:space:]]' AND char_length(txt) <= max_len;
END
$$;
REVOKE ALL ON FUNCTION tenancy.valid_rich_text(jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy.valid_rich_text(jsonb, integer) TO app_rw, app_worker;

CREATE SCHEMA workflow;
REVOKE ALL ON SCHEMA workflow FROM PUBLIC;
GRANT USAGE ON SCHEMA workflow TO app_rw, app_worker;
CREATE SCHEMA work;
REVOKE ALL ON SCHEMA work FROM PUBLIC;
GRANT USAGE ON SCHEMA work TO app_rw, app_worker;

-- Phase records become addressable (0B ADR-21). The seed repeats every addressable 0B type so the
-- Phase 0 validator compares the complete set.
INSERT INTO core.record_type (record_type, public_id_prefix, owner_module) VALUES
  ('brand', 'br', 'tenancy'),
  ('team', 'team', 'tenancy'),
  ('workflow', 'wf', 'workflow'),
  ('file', 'file', 'files'),
  ('deliverable', 'dlv', 'files'),
  ('project', 'prj', 'work'),
  ('phase', 'phs', 'work'),
  ('milestone', 'ms', 'work'),
  ('task', 'tsk', 'work'),
  ('decision_record', 'dec', 'work'),
  ('inbox_item', 'inb', 'capture'),
  ('note', 'note', 'capture'),
  ('intake_form', 'form', 'capture'),
  ('work_block', 'blk', 'planning'),
  ('document', 'doc', 'knowledge'),
  ('goal', 'goal', 'goals'),
  ('key_result', 'kr', 'goals'),
  ('portfolio', 'pf', 'goals'),
  ('saved_view', 'view', 'views'),
  ('dashboard', 'dash', 'insights'),
  ('report_definition', 'rpt', 'insights'),
  ('connection', 'conn', 'integrations'),
  ('webhook_subscription', 'whk', 'integrations'),
  ('test_case', 'tc', 'quality'),
  ('test_suite', 'ts', 'quality'),
  ('test_run', 'tr', 'quality'),
  ('environment', 'env', 'delivery'),
  ('release', 'rel', 'delivery'),
  ('template', 'tpl', 'templates'),
  ('automation', 'auto', 'automation'),
  ('agent_profile', 'agt', 'agents')
ON CONFLICT (record_type) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- Platform statuses: immutable, seeded here only; Phase 2C adds workspace workflows.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workflow.platform_status (
  id uuid PRIMARY KEY,
  record_type text NOT NULL REFERENCES core.record_type (record_type) ON DELETE RESTRICT,
  key text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  rank smallint NOT NULL,
  CONSTRAINT platform_status_key UNIQUE (record_type, key),
  CONSTRAINT platform_status_rank UNIQUE (record_type, rank),
  CONSTRAINT platform_status_key_format CHECK (key ~ '^[a-z][a-z_]{1,30}$'),
  CONSTRAINT platform_status_category_known CHECK (category IN ('planned', 'active', 'paused', 'done', 'cancelled'))
);
INSERT INTO workflow.platform_status (id, record_type, key, name, category, rank) VALUES
  ('01920000-0000-7000-8000-000000000001', 'project', 'planned', 'Planned', 'planned', 1),
  ('01920000-0000-7000-8000-000000000002', 'project', 'active', 'Active', 'active', 2),
  ('01920000-0000-7000-8000-000000000003', 'project', 'on_hold', 'On hold', 'paused', 3),
  ('01920000-0000-7000-8000-000000000004', 'project', 'completed', 'Completed', 'done', 4),
  ('01920000-0000-7000-8000-000000000005', 'project', 'cancelled', 'Cancelled', 'cancelled', 5);

-- ---------------------------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------------------------
CREATE TABLE work.project (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  parent_project_id uuid,
  ancestor_ids uuid[] NOT NULL DEFAULT '{}',
  depth smallint NOT NULL DEFAULT 0,
  name text NOT NULL,
  description_rich jsonb,
  icon text,
  color text,
  status_id uuid NOT NULL REFERENCES workflow.platform_status (id) ON DELETE RESTRICT,
  status_category text NOT NULL,
  priority text NOT NULL DEFAULT 'none',
  start_date date,
  target_date date,
  deadline_date date,
  completed_at timestamptz,
  health text,
  health_source text,
  owner_membership_id uuid NOT NULL,
  budget_amount numeric(16, 2),
  budget_currency text,
  time_budget_minutes integer,
  ai_budget_micros bigint,
  rank text COLLATE "C" NOT NULL,
  access_mode text NOT NULL DEFAULT 'inherit',
  allow_record_shares boolean NOT NULL DEFAULT false,
  recurrence_series_id uuid,
  occurrence_key text,
  intake_source_id uuid,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT project_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT project_brand_key UNIQUE (workspace_id, brand_id, id),
  CONSTRAINT project_scope_is_brand CHECK (scope_key = brand_id),
  CONSTRAINT project_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT project_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  -- Same workspace and brand; RESTRICT blocks purging a parent a live child still references.
  CONSTRAINT project_parent_fkey FOREIGN KEY (workspace_id, brand_id, parent_project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_intake_source_fkey FOREIGN KEY (workspace_id, intake_source_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  -- Corruption ceiling (0B ADR-21); commands enforce PROJECT_DEPTH_MAX. The root is depth 0.
  CONSTRAINT project_depth_ceiling CHECK (depth BETWEEN 0 AND 32),
  CONSTRAINT project_ancestry_length CHECK (cardinality(ancestor_ids) = depth),
  CONSTRAINT project_root_shape CHECK ((parent_project_id IS NULL) = (depth = 0)),
  CONSTRAINT project_parent_is_last_ancestor CHECK (parent_project_id IS NULL OR ancestor_ids[depth] = parent_project_id),
  CONSTRAINT project_not_own_ancestor CHECK (NOT (id = ANY (ancestor_ids))),
  CONSTRAINT project_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 200 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 200)),
  CONSTRAINT project_description_rich CHECK (tenancy.valid_rich_text(description_rich, 20000)),
  CONSTRAINT project_icon_known CHECK (icon IS NULL OR icon ~ '^[a-z][a-z_]{1,30}$'),
  CONSTRAINT project_color_format CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT project_category_known CHECK (status_category IN ('planned', 'active', 'paused', 'done', 'cancelled')),
  CONSTRAINT project_priority_known CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
  CONSTRAINT project_dates_ordered CHECK (start_date IS NULL OR target_date IS NULL OR target_date >= start_date),
  CONSTRAINT project_completed_when_done CHECK ((completed_at IS NOT NULL) = (status_category = 'done')),
  CONSTRAINT project_health_known CHECK (health IS NULL OR health IN ('on_track', 'at_risk', 'off_track')),
  CONSTRAINT project_health_source CHECK ((health IS NULL) = (health_source IS NULL)
    AND (health_source IS NULL OR health_source IN ('manual', 'suggested'))),
  CONSTRAINT project_budget_pair CHECK ((budget_amount IS NULL) = (budget_currency IS NULL)
    AND (budget_amount IS NULL OR budget_amount >= 0)
    AND (budget_currency IS NULL OR budget_currency ~ '^[A-Z]{3}$')),
  CONSTRAINT project_time_budget CHECK (time_budget_minutes IS NULL OR time_budget_minutes BETWEEN 0 AND 100000000),
  CONSTRAINT project_ai_budget CHECK (ai_budget_micros IS NULL OR ai_budget_micros >= 0),
  CONSTRAINT project_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT project_access_mode_known CHECK (access_mode IN ('inherit', 'restricted')),
  CONSTRAINT project_occurrence_pair CHECK ((recurrence_series_id IS NULL) = (occurrence_key IS NULL)
    AND (occurrence_key IS NULL OR char_length(occurrence_key) BETWEEN 10 AND 40)),
  CONSTRAINT project_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX project_by_envelope ON work.project (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX project_list ON work.project (workspace_id, brand_id, lifecycle_state, status_category, rank, id);
CREATE INDEX project_children ON work.project (workspace_id, parent_project_id, rank, id);
CREATE INDEX project_by_brand_parent ON work.project (workspace_id, brand_id, parent_project_id);
CREATE INDEX project_restricted ON work.project (workspace_id, id) WHERE access_mode = 'restricted';
CREATE INDEX project_by_owner ON work.project (workspace_id, owner_membership_id);
CREATE INDEX project_by_creator ON work.project (workspace_id, created_by_membership_id);
CREATE INDEX project_by_updater ON work.project (workspace_id, updated_by_membership_id);
CREATE INDEX project_by_intake_source ON work.project (workspace_id, intake_source_id);
CREATE INDEX project_by_status ON work.project (status_id);

-- status_category always mirrors the (immutable) category of status_id.
CREATE FUNCTION work.project_status_category() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  SELECT s.category INTO NEW.status_category FROM workflow.platform_status s
   WHERE s.id = NEW.status_id AND s.record_type = 'project';
  IF NEW.status_category IS NULL THEN
    RAISE EXCEPTION 'project status must be a project status' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER project_status_category BEFORE INSERT OR UPDATE OF status_id, status_category ON work.project
  FOR EACH ROW EXECUTE FUNCTION work.project_status_category();

-- Ancestry is the parent's ancestry plus the parent, checked at commit so a subtree move can update
-- every descendant in one statement (0B ADR-05, ADR-21).
CREATE FUNCTION work.assert_project_ancestry() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  cur record;
  par record;
BEGIN
  SELECT id, workspace_id, brand_id, parent_project_id, ancestor_ids, depth INTO cur
    FROM work.project WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF cur.parent_project_id IS NULL THEN
    IF cur.ancestor_ids <> '{}'::uuid[] THEN
      RAISE EXCEPTION 'a root project has no ancestors' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  SELECT id, brand_id, ancestor_ids INTO par FROM work.project
   WHERE workspace_id = cur.workspace_id AND id = cur.parent_project_id;
  IF NOT FOUND OR par.brand_id <> cur.brand_id OR cur.ancestor_ids <> par.ancestor_ids || par.id THEN
    RAISE EXCEPTION 'project ancestry is inconsistent with its parent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER project_ancestry AFTER INSERT OR UPDATE OF parent_project_id, ancestor_ids, depth
  ON work.project DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION work.assert_project_ancestry();

-- ---------------------------------------------------------------------------------------------
-- Phases and milestones (addressable core.record extensions in the project's brand)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE work.phase (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  project_id uuid NOT NULL,
  name text NOT NULL,
  rank text COLLATE "C" NOT NULL,
  start_date date,
  end_date date,
  status text NOT NULL DEFAULT 'planned',
  owner_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT phase_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT phase_project_key UNIQUE (workspace_id, project_id, id),
  CONSTRAINT phase_scope_is_brand CHECK (scope_key = brand_id),
  CONSTRAINT phase_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT phase_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT phase_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT phase_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT phase_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 120 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 120)),
  CONSTRAINT phase_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT phase_dates_ordered CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  CONSTRAINT phase_status_known CHECK (status IN ('planned', 'active', 'completed')),
  CONSTRAINT phase_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX phase_by_envelope ON work.phase (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX phase_by_project ON work.phase (workspace_id, project_id, rank, id);
CREATE INDEX phase_by_brand_project ON work.phase (workspace_id, brand_id, project_id);
CREATE INDEX phase_by_owner ON work.phase (workspace_id, owner_membership_id);
CREATE INDEX phase_by_updater ON work.phase (workspace_id, updated_by_membership_id);

CREATE TABLE work.milestone (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  project_id uuid NOT NULL,
  phase_id uuid,
  name text NOT NULL,
  rank text COLLATE "C" NOT NULL,
  due_date date,
  status text NOT NULL DEFAULT 'planned',
  reached_at timestamptz,
  owner_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT milestone_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT milestone_scope_is_brand CHECK (scope_key = brand_id),
  CONSTRAINT milestone_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT milestone_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  -- A milestone's phase belongs to the same project.
  CONSTRAINT milestone_phase_fkey FOREIGN KEY (workspace_id, project_id, phase_id)
    REFERENCES work.phase (workspace_id, project_id, id) ON DELETE RESTRICT,
  CONSTRAINT milestone_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT milestone_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT milestone_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 120 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 120)),
  CONSTRAINT milestone_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT milestone_status_known CHECK (status IN ('planned', 'reached', 'missed', 'cancelled')),
  CONSTRAINT milestone_reached_shape CHECK ((reached_at IS NOT NULL) = (status = 'reached')),
  CONSTRAINT milestone_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX milestone_by_envelope ON work.milestone (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX milestone_by_project ON work.milestone (workspace_id, project_id, rank, id);
CREATE INDEX milestone_by_brand_project ON work.milestone (workspace_id, brand_id, project_id);
CREATE INDEX milestone_by_phase ON work.milestone (workspace_id, project_id, phase_id);
CREATE INDEX milestone_by_owner ON work.milestone (workspace_id, owner_membership_id);
CREATE INDEX milestone_by_updater ON work.milestone (workspace_id, updated_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Criteria and scope items (ordered, mutable, project-contained)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE work.criteria_item (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  owner_kind text NOT NULL DEFAULT 'project',
  project_id uuid NOT NULL,
  kind text NOT NULL,
  text text NOT NULL,
  rank text COLLATE "C" NOT NULL,
  met boolean NOT NULL DEFAULT false,
  met_by_membership_id uuid,
  met_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT criteria_item_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT criteria_item_public_id_format CHECK (public_id ~ '^cri_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT criteria_item_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT criteria_item_met_by_fkey FOREIGN KEY (workspace_id, met_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  -- Task-owned criteria arrive with tasks (2B relaxes this to the 0B exclusive arc).
  CONSTRAINT criteria_item_owner_kind CHECK (owner_kind = 'project'),
  CONSTRAINT criteria_item_kind_known CHECK (kind IN ('success', 'definition_of_done')),
  CONSTRAINT criteria_item_text CHECK (char_length(btrim(text)) BETWEEN 1 AND 500 AND tenancy.valid_plain_text(text, 500)),
  CONSTRAINT criteria_item_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT criteria_item_met_shape CHECK (met = (met_at IS NOT NULL) AND (met_by_membership_id IS NULL OR met)),
  CONSTRAINT criteria_item_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX criteria_item_by_project ON work.criteria_item (workspace_id, project_id, kind, rank, id);
CREATE INDEX criteria_item_by_brand_project ON work.criteria_item (workspace_id, brand_id, project_id);
CREATE INDEX criteria_item_by_met_by ON work.criteria_item (workspace_id, met_by_membership_id);

CREATE TABLE work.scope_item (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL,
  text text NOT NULL,
  rank text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT scope_item_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT scope_item_public_id_format CHECK (public_id ~ '^sco_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT scope_item_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT scope_item_kind_known CHECK (kind IN ('scope', 'exclusion', 'risk', 'assumption', 'constraint')),
  CONSTRAINT scope_item_text CHECK (char_length(btrim(text)) BETWEEN 1 AND 1000 AND tenancy.valid_plain_text(text, 1000)),
  CONSTRAINT scope_item_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT scope_item_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX scope_item_by_project ON work.scope_item (workspace_id, project_id, kind, rank, id);
CREATE INDEX scope_item_by_brand_project ON work.scope_item (workspace_id, brand_id, project_id);

-- ---------------------------------------------------------------------------------------------
-- Project updates (append-only) and verification facts (append-only, OD-16)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE work.project_update (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  project_id uuid NOT NULL,
  body text NOT NULL,
  health text,
  source_kind text NOT NULL,
  author_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_update_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT project_update_project_key UNIQUE (workspace_id, project_id, id),
  CONSTRAINT project_update_public_id_format CHECK (public_id ~ '^pup_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT project_update_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_update_author_fkey FOREIGN KEY (workspace_id, author_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_update_body CHECK (char_length(btrim(body)) BETWEEN 1 AND 10000 AND tenancy.valid_plain_text(body, 10000)),
  CONSTRAINT project_update_health_known CHECK (health IS NULL OR health IN ('on_track', 'at_risk', 'off_track')),
  CONSTRAINT project_update_source_known CHECK (source_kind IN ('human', 'ai_draft', 'import', 'system')),
  CONSTRAINT project_update_human_author CHECK (source_kind <> 'human' OR author_membership_id IS NOT NULL)
);
CREATE INDEX project_update_by_project ON work.project_update (workspace_id, project_id, created_at DESC, id);
CREATE INDEX project_update_by_brand_project ON work.project_update (workspace_id, brand_id, project_id);
CREATE INDEX project_update_by_author ON work.project_update (workspace_id, author_membership_id);

CREATE TABLE work.project_update_verification (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  update_id uuid NOT NULL,
  project_id uuid NOT NULL,
  verifier_membership_id uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, update_id),
  CONSTRAINT project_update_verification_update_fkey FOREIGN KEY (workspace_id, project_id, update_id)
    REFERENCES work.project_update (workspace_id, project_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_update_verification_verifier_fkey FOREIGN KEY (workspace_id, verifier_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX project_update_verification_by_project ON work.project_update_verification (workspace_id, project_id, verified_at DESC);
CREATE INDEX project_update_verification_by_update ON work.project_update_verification (workspace_id, project_id, update_id);
CREATE INDEX project_update_verification_by_verifier ON work.project_update_verification (workspace_id, verifier_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Decisions and open questions (OD-15)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE work.decision_record (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  project_id uuid,
  kind text NOT NULL,
  state text NOT NULL,
  statement text NOT NULL,
  outcome text,
  owner_membership_id uuid,
  due_date date,
  decided_at timestamptz,
  resolved_at timestamptz,
  superseded_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT decision_record_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT decision_record_scope_is_brand CHECK (scope_key = brand_id),
  CONSTRAINT decision_record_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT decision_record_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT decision_record_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT decision_record_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT decision_record_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  -- Checked at statement end so a project purge deletes its decisions in one statement.
  CONSTRAINT decision_record_superseded_fkey FOREIGN KEY (workspace_id, superseded_by_id)
    REFERENCES work.decision_record (workspace_id, id),
  CONSTRAINT decision_record_kind_known CHECK (kind IN ('decision', 'open_question')),
  CONSTRAINT decision_record_state_for_kind CHECK (
    (kind = 'decision' AND state IN ('proposed', 'decided', 'superseded'))
    OR (kind = 'open_question' AND state IN ('open', 'resolved'))),
  CONSTRAINT decision_record_statement CHECK (char_length(btrim(statement)) BETWEEN 1 AND 2000
    AND tenancy.valid_plain_text(statement, 2000)),
  CONSTRAINT decision_record_outcome CHECK (tenancy.valid_plain_text(outcome, 4000)),
  CONSTRAINT decision_record_decided_shape CHECK ((decided_at IS NOT NULL) = (kind = 'decision' AND state IN ('decided', 'superseded'))),
  CONSTRAINT decision_record_resolved_shape CHECK ((resolved_at IS NOT NULL) = (kind = 'open_question' AND state = 'resolved')),
  CONSTRAINT decision_record_outcome_required CHECK (state NOT IN ('decided', 'resolved') OR outcome IS NOT NULL),
  CONSTRAINT decision_record_superseded_shape CHECK ((superseded_by_id IS NOT NULL) = (state = 'superseded')
    AND (superseded_by_id IS NULL OR superseded_by_id <> id)),
  CONSTRAINT decision_record_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX decision_record_by_envelope ON work.decision_record (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX decision_record_by_project ON work.decision_record (workspace_id, project_id, kind, state, created_at DESC);
CREATE INDEX decision_record_by_brand_project ON work.decision_record (workspace_id, brand_id, project_id);
CREATE INDEX decision_record_by_owner ON work.decision_record (workspace_id, owner_membership_id);
CREATE INDEX decision_record_by_updater ON work.decision_record (workspace_id, updated_by_membership_id);
CREATE INDEX decision_record_by_superseded ON work.decision_record (workspace_id, superseded_by_id);

-- Kind is fixed; states move forward only (decision proposed → decided → superseded; question
-- open → resolved).
CREATE FUNCTION work.decision_record_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.kind <> OLD.kind OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'decision kind and project are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'proposed' AND NEW.state = 'decided')
    OR (OLD.state = 'decided' AND NEW.state = 'superseded')
    OR (OLD.state = 'open' AND NEW.state = 'resolved')) THEN
    RAISE EXCEPTION 'decision transition % → % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER decision_record_guard BEFORE UPDATE OF kind, project_id, state ON work.decision_record
  FOR EACH ROW EXECUTE FUNCTION work.decision_record_guard();

-- ---------------------------------------------------------------------------------------------
-- Project-scoped role assignments (0C AZ-21): the only collaborator authority.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE access.role_assignment ADD COLUMN project_scope_id uuid
  GENERATED ALWAYS AS (CASE WHEN scope_type = 'project' THEN scope_id END) STORED;
ALTER TABLE access.role_assignment ADD CONSTRAINT role_assignment_project_fkey
  FOREIGN KEY (workspace_id, project_scope_id) REFERENCES work.project (workspace_id, id) ON DELETE RESTRICT;
CREATE INDEX role_assignment_by_project ON access.role_assignment (workspace_id, project_scope_id);
ALTER TABLE access.role_assignment DROP CONSTRAINT role_assignment_source_known;
ALTER TABLE access.role_assignment ADD CONSTRAINT role_assignment_source_known CHECK (grant_source IN
  ('bootstrap_owner', 'brand_creator', 'sensitivity_creator', 'assigned', 'elevation', 'project_manager'));

-- Every active project keeps an eligible manager at commit: an explicit project manage grant held
-- by a non-removed internal membership. Suspension keeps eligibility (it is temporary); removal and
-- grant deletion must hand the grant over first (departure hooks do).
CREATE FUNCTION work.project_has_manager(p_workspace uuid, p_project uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM access.role_assignment ra
      JOIN access.role r ON r.workspace_id = ra.workspace_id AND r.id = ra.role_id
      JOIN tenancy.membership m ON m.workspace_id = ra.workspace_id AND m.id = ra.membership_principal_id
     WHERE ra.workspace_id = p_workspace AND ra.scope_type = 'project' AND ra.scope_id = p_project
       AND r.key = 'scope_manage' AND ra.expires_at IS NULL
       AND m.kind = 'member' AND m.state IN ('active', 'suspended'))
$$;

CREATE FUNCTION work.assert_project_manager() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ws uuid;
  pid uuid;
  st core.lifecycle_state;
BEGIN
  IF TG_TABLE_NAME = 'project' THEN
    ws := NEW.workspace_id;
    pid := NEW.id;
  ELSE
    IF TG_OP = 'DELETE' THEN
      IF OLD.scope_type <> 'project' THEN RETURN NULL; END IF;
      ws := OLD.workspace_id;
      pid := OLD.scope_id;
    ELSE
      IF OLD.scope_type <> 'project' THEN RETURN NULL; END IF;
      ws := OLD.workspace_id;
      pid := OLD.scope_id;
    END IF;
  END IF;
  SELECT lifecycle_state INTO st FROM work.project WHERE workspace_id = ws AND id = pid;
  IF FOUND AND st = 'active' AND NOT work.project_has_manager(ws, pid) THEN
    RAISE EXCEPTION 'an active project needs at least one eligible manager' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER project_manager_on_project AFTER INSERT OR UPDATE OF lifecycle_state ON work.project
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION work.assert_project_manager();
CREATE CONSTRAINT TRIGGER project_manager_on_assignment AFTER UPDATE OR DELETE ON access.role_assignment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION work.assert_project_manager();

CREATE FUNCTION work.assert_departing_manager() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.state = 'removed' AND OLD.state <> 'removed' AND EXISTS (
    SELECT 1 FROM access.role_assignment ra JOIN work.project p
        ON p.workspace_id = ra.workspace_id AND p.id = ra.scope_id
     WHERE ra.workspace_id = NEW.workspace_id AND ra.membership_principal_id = NEW.id
       AND ra.scope_type = 'project' AND p.lifecycle_state = 'active'
       AND NOT work.project_has_manager(NEW.workspace_id, p.id)) THEN
    RAISE EXCEPTION 'a removed member cannot remain the last manager of an active project' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER project_manager_on_membership AFTER UPDATE OF state ON tenancy.membership
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION work.assert_departing_manager();

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE work.project ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.project FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.project
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.phase ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.phase FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.phase
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.milestone FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.milestone
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.criteria_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.criteria_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.criteria_item
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.scope_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.scope_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.scope_item
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.project_update ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.project_update FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.project_update
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.project_update_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.project_update_verification FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.project_update_verification
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.decision_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.decision_record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.decision_record
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON workflow.platform_status, work.project, work.phase, work.milestone, work.criteria_item,
  work.scope_item, work.project_update, work.project_update_verification, work.decision_record FROM PUBLIC;
GRANT SELECT ON workflow.platform_status TO app_rw, app_worker;
GRANT SELECT, INSERT ON work.project TO app_rw;
GRANT UPDATE (parent_project_id, ancestor_ids, depth, name, description_rich, icon, color, status_id, status_category,
  priority, start_date, target_date, deadline_date, completed_at, health, health_source, owner_membership_id,
  budget_amount, budget_currency, time_budget_minutes, ai_budget_micros, rank, access_mode, allow_record_shares,
  updated_at, updated_by_membership_id, version) ON work.project TO app_rw;
GRANT SELECT, INSERT ON work.phase, work.milestone, work.decision_record TO app_rw;
GRANT UPDATE (name, rank, start_date, end_date, status, owner_membership_id, updated_at, updated_by_membership_id,
  version) ON work.phase TO app_rw;
GRANT UPDATE (phase_id, name, rank, due_date, status, reached_at, owner_membership_id, updated_at,
  updated_by_membership_id, version) ON work.milestone TO app_rw;
GRANT UPDATE (state, statement, outcome, owner_membership_id, due_date, decided_at, resolved_at, superseded_by_id,
  updated_at, updated_by_membership_id, version) ON work.decision_record TO app_rw;
GRANT SELECT, INSERT, DELETE ON work.criteria_item, work.scope_item TO app_rw;
GRANT UPDATE (kind, text, rank, met, met_by_membership_id, met_at, updated_at, version) ON work.criteria_item TO app_rw;
GRANT UPDATE (kind, text, rank, updated_at, version) ON work.scope_item TO app_rw;
-- Append-only: no role may update these facts; only purge (the worker's lifecycle hook) removes them.
GRANT SELECT, INSERT ON work.project_update, work.project_update_verification TO app_rw;
-- The worker reads project structures (recurrence generation, purge hooks) and writes generated
-- projects and their copied structure; purge hooks delete contained rows.
GRANT SELECT ON work.project, work.phase, work.milestone, work.criteria_item, work.scope_item, work.project_update,
  work.project_update_verification, work.decision_record TO app_worker;
GRANT INSERT ON work.project, work.phase, work.milestone, work.criteria_item, work.scope_item TO app_worker;
GRANT DELETE ON work.project, work.phase, work.milestone, work.criteria_item, work.scope_item, work.project_update,
  work.project_update_verification, work.decision_record TO app_worker;
-- Purge clears a purged phase from its milestones (milestones belong to the project, not the phase).
GRANT UPDATE (phase_id, version) ON work.milestone TO app_worker;
REVOKE ALL ON FUNCTION work.project_status_category(), work.assert_project_ancestry(), work.decision_record_guard(),
  work.project_has_manager(uuid, uuid), work.assert_project_manager(), work.assert_departing_manager() FROM PUBLIC;
-- The guard triggers fire as the acting role and call this helper.
GRANT EXECUTE ON FUNCTION work.project_has_manager(uuid, uuid) TO app_rw, app_worker;
