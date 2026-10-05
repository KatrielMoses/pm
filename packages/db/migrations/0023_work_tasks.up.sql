-- migrate:phase expand
-- Phase 2B tasks (0B ADR-22, 0C AZ-22, 0D PL-24): tasks as core.record extensions in one brand with
-- an optional same-brand project, guarded subtask ancestry, the immutable platform task statuses,
-- assignees (responsibility, never authority), checklists, task criteria and inherited project
-- definition-of-done responses, and brand labels.
--
-- Authority stays the 1D compiler over the project chain or the brand; nothing here stores computed
-- authorization. Ancestry and status_category are guarded denormalizations.

INSERT INTO workflow.platform_status (id, record_type, key, name, category, rank) VALUES
  ('01920000-0000-7000-8000-000000000006', 'task', 'backlog', 'Backlog', 'planned', 1),
  ('01920000-0000-7000-8000-000000000007', 'task', 'todo', 'To do', 'planned', 2),
  ('01920000-0000-7000-8000-000000000008', 'task', 'in_progress', 'In progress', 'active', 3),
  ('01920000-0000-7000-8000-000000000009', 'task', 'blocked', 'Blocked', 'paused', 4),
  ('01920000-0000-7000-8000-00000000000a', 'task', 'done', 'Done', 'done', 5),
  ('01920000-0000-7000-8000-00000000000b', 'task', 'cancelled', 'Cancelled', 'cancelled', 6);

-- ---------------------------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------------------------
CREATE TABLE work.task (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  project_id uuid,
  parent_task_id uuid,
  ancestor_ids uuid[] NOT NULL DEFAULT '{}',
  depth smallint NOT NULL DEFAULT 0,
  title text NOT NULL,
  description_rich jsonb,
  status_id uuid NOT NULL REFERENCES workflow.platform_status (id) ON DELETE RESTRICT,
  status_category text NOT NULL,
  prior_status_id uuid REFERENCES workflow.platform_status (id) ON DELETE RESTRICT,
  priority text NOT NULL DEFAULT 'none',
  start_date date,
  due_date date,
  deadline_date date,
  deadline_at timestamptz,
  deadline_tz text,
  estimate_minutes integer,
  remaining_estimate_minutes integer,
  completed_at timestamptz,
  completed_by_membership_id uuid,
  completion_override_reason text,
  expected_deliverable_type text,
  expected_deliverable_detail text,
  requires_acceptance boolean NOT NULL DEFAULT false,
  rank text COLLATE "C" NOT NULL,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT task_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT task_brand_key UNIQUE (workspace_id, brand_id, id),
  CONSTRAINT task_scope_is_brand CHECK (scope_key = brand_id),
  CONSTRAINT task_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT task_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  -- The project is optional and, when present, in the same workspace and brand (OD-02).
  CONSTRAINT task_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  -- Same workspace and brand; RESTRICT blocks purging a parent a live child still references.
  CONSTRAINT task_parent_fkey FOREIGN KEY (workspace_id, brand_id, parent_task_id)
    REFERENCES work.task (workspace_id, brand_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT task_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_completer_fkey FOREIGN KEY (workspace_id, completed_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  -- Corruption ceiling (0B ADR-22); commands enforce TASK_DEPTH_MAX. The root is depth 0.
  CONSTRAINT task_depth_ceiling CHECK (depth BETWEEN 0 AND 64),
  CONSTRAINT task_ancestry_length CHECK (cardinality(ancestor_ids) = depth),
  CONSTRAINT task_root_shape CHECK ((parent_task_id IS NULL) = (depth = 0)),
  CONSTRAINT task_parent_is_last_ancestor CHECK (parent_task_id IS NULL OR ancestor_ids[depth] = parent_task_id),
  CONSTRAINT task_not_own_ancestor CHECK (NOT (id = ANY (ancestor_ids))),
  CONSTRAINT task_title_text CHECK (char_length(btrim(title)) BETWEEN 1 AND 300 AND title = btrim(title)
    AND tenancy.valid_plain_text(title, 300)),
  CONSTRAINT task_description_rich CHECK (tenancy.valid_rich_text(description_rich, 20000)),
  CONSTRAINT task_category_known CHECK (status_category IN ('planned', 'active', 'paused', 'done', 'cancelled')),
  CONSTRAINT task_priority_known CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
  CONSTRAINT task_dates_ordered CHECK (start_date IS NULL OR due_date IS NULL OR due_date >= start_date),
  -- A deadline is a date or an instant with its zone, never both (OD-01).
  CONSTRAINT task_deadline_shape CHECK (NOT (deadline_date IS NOT NULL AND deadline_at IS NOT NULL)
    AND (deadline_at IS NULL) = (deadline_tz IS NULL)
    AND (deadline_tz IS NULL OR char_length(deadline_tz) BETWEEN 1 AND 64)),
  -- The database bound is the widest configurable TASK_ESTIMATE_MINUTES_MAX.
  CONSTRAINT task_estimate_range CHECK (estimate_minutes IS NULL OR estimate_minutes BETWEEN 0 AND 1000000),
  CONSTRAINT task_remaining_range CHECK (remaining_estimate_minutes IS NULL OR remaining_estimate_minutes BETWEEN 0 AND 1000000),
  CONSTRAINT task_completed_when_done CHECK ((completed_at IS NOT NULL) = (status_category = 'done')),
  CONSTRAINT task_override_when_done CHECK (completion_override_reason IS NULL OR (status_category = 'done'
    AND char_length(btrim(completion_override_reason)) BETWEEN 1 AND 500
    AND tenancy.valid_plain_text(completion_override_reason, 500))),
  CONSTRAINT task_deliverable_known CHECK (expected_deliverable_type IS NULL OR expected_deliverable_type IN
    ('document', 'file', 'url', 'pull_request', 'test_report', 'other')),
  CONSTRAINT task_deliverable_detail CHECK (expected_deliverable_detail IS NULL OR (expected_deliverable_type IS NOT NULL
    AND char_length(btrim(expected_deliverable_detail)) BETWEEN 1 AND 500
    AND tenancy.valid_plain_text(expected_deliverable_detail, 500))),
  CONSTRAINT task_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT task_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX task_by_envelope ON work.task (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX task_by_project ON work.task (workspace_id, project_id, parent_task_id, rank, id);
CREATE INDEX task_children ON work.task (workspace_id, parent_task_id, rank, id);
CREATE INDEX task_by_brand_project ON work.task (workspace_id, brand_id, project_id);
CREATE INDEX task_projectless ON work.task (workspace_id, brand_id, rank, id) WHERE project_id IS NULL;
CREATE INDEX task_by_brand_parent ON work.task (workspace_id, brand_id, parent_task_id);
CREATE INDEX task_by_creator ON work.task (workspace_id, created_by_membership_id);
CREATE INDEX task_by_updater ON work.task (workspace_id, updated_by_membership_id);
CREATE INDEX task_by_completer ON work.task (workspace_id, completed_by_membership_id);
CREATE INDEX task_by_status ON work.task (status_id);
CREATE INDEX task_by_prior_status ON work.task (prior_status_id);

-- status_category always mirrors the (immutable) category of status_id; statuses are task statuses.
CREATE FUNCTION work.task_status_category() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  SELECT s.category INTO NEW.status_category FROM workflow.platform_status s
   WHERE s.id = NEW.status_id AND s.record_type = 'task';
  IF NEW.status_category IS NULL THEN
    RAISE EXCEPTION 'task status must be a task status' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.prior_status_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workflow.platform_status s
      WHERE s.id = NEW.prior_status_id AND s.record_type = 'task' AND s.category NOT IN ('done', 'cancelled')) THEN
    RAISE EXCEPTION 'a reopen target must be a non-terminal task status' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER task_status_category BEFORE INSERT OR UPDATE OF status_id, status_category, prior_status_id ON work.task
  FOR EACH ROW EXECUTE FUNCTION work.task_status_category();

-- Ancestry is the parent's ancestry plus the parent, with the same brand and project identity (both
-- may be projectless), checked at commit so a subtree move can update every descendant at once.
CREATE FUNCTION work.assert_task_ancestry() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  cur record;
  par record;
BEGIN
  SELECT id, workspace_id, brand_id, project_id, parent_task_id, ancestor_ids INTO cur
    FROM work.task WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF cur.parent_task_id IS NULL THEN
    IF cur.ancestor_ids <> '{}'::uuid[] THEN
      RAISE EXCEPTION 'a root task has no ancestors' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  SELECT id, brand_id, project_id, ancestor_ids INTO par FROM work.task
   WHERE workspace_id = cur.workspace_id AND id = cur.parent_task_id;
  IF NOT FOUND OR par.brand_id <> cur.brand_id OR par.project_id IS DISTINCT FROM cur.project_id
     OR cur.ancestor_ids <> par.ancestor_ids || par.id THEN
    RAISE EXCEPTION 'task ancestry is inconsistent with its parent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER task_ancestry AFTER INSERT OR UPDATE OF parent_task_id, ancestor_ids, depth, project_id, brand_id
  ON work.task DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION work.assert_task_ancestry();

-- ---------------------------------------------------------------------------------------------
-- Assignees: responsibility only (0C AZ-22). Active internal members; at most one primary.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE work.task_assignee (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  task_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  rank text COLLATE "C" NOT NULL,
  assigned_by_membership_id uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_assignee_pkey PRIMARY KEY (task_id, membership_id),
  CONSTRAINT task_assignee_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
    REFERENCES work.task (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_assignee_membership_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_assignee_assigner_fkey FOREIGN KEY (workspace_id, assigned_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_assignee_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$')
);
CREATE UNIQUE INDEX task_assignee_one_primary ON work.task_assignee (task_id) WHERE is_primary;
CREATE INDEX task_assignee_by_task ON work.task_assignee (workspace_id, task_id, rank);
CREATE INDEX task_assignee_by_membership ON work.task_assignee (workspace_id, membership_id);
CREATE INDEX task_assignee_by_brand_task ON work.task_assignee (workspace_id, brand_id, task_id);
CREATE INDEX task_assignee_by_assigner ON work.task_assignee (workspace_id, assigned_by_membership_id);

CREATE FUNCTION work.assert_assignee_eligible() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenancy.membership m
      WHERE m.workspace_id = NEW.workspace_id AND m.id = NEW.membership_id
        AND m.kind = 'member' AND m.state = 'active') THEN
    RAISE EXCEPTION 'only active internal members can be assigned' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER task_assignee_eligible BEFORE INSERT OR UPDATE OF membership_id ON work.task_assignee
  FOR EACH ROW EXECUTE FUNCTION work.assert_assignee_eligible();

-- ---------------------------------------------------------------------------------------------
-- Checklists: ordered facts of a task, never tasks (no assignees, dates, or status effect).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE work.checklist_item (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  task_id uuid NOT NULL,
  text text NOT NULL,
  rank text COLLATE "C" NOT NULL,
  done boolean NOT NULL DEFAULT false,
  done_by_membership_id uuid,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT checklist_item_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT checklist_item_public_id_format CHECK (public_id ~ '^chk_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT checklist_item_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
    REFERENCES work.task (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT checklist_item_done_by_fkey FOREIGN KEY (workspace_id, done_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT checklist_item_text CHECK (char_length(btrim(text)) BETWEEN 1 AND 500 AND tenancy.valid_plain_text(text, 500)),
  CONSTRAINT checklist_item_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT checklist_item_done_shape CHECK (done = (done_at IS NOT NULL) AND (done_by_membership_id IS NULL OR done)),
  CONSTRAINT checklist_item_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX checklist_item_by_task ON work.checklist_item (workspace_id, task_id, rank, id);
CREATE INDEX checklist_item_by_brand_task ON work.checklist_item (workspace_id, brand_id, task_id);
CREATE INDEX checklist_item_by_done_by ON work.checklist_item (workspace_id, done_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Criteria: the 0B exclusive arc (project or task). Task kinds: acceptance, definition of done.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE work.criteria_item ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE work.criteria_item ADD COLUMN task_id uuid;
ALTER TABLE work.criteria_item ADD COLUMN required boolean NOT NULL DEFAULT true;
ALTER TABLE work.criteria_item DROP CONSTRAINT criteria_item_owner_kind;
ALTER TABLE work.criteria_item DROP CONSTRAINT criteria_item_kind_known;
ALTER TABLE work.criteria_item ADD CONSTRAINT criteria_item_owner_kind CHECK (owner_kind IN ('project', 'task')
  AND (owner_kind = 'project') = (project_id IS NOT NULL) AND (owner_kind = 'task') = (task_id IS NOT NULL));
ALTER TABLE work.criteria_item ADD CONSTRAINT criteria_item_kind_known CHECK (
  (owner_kind = 'project' AND kind IN ('success', 'definition_of_done'))
  OR (owner_kind = 'task' AND kind IN ('acceptance', 'definition_of_done')));
ALTER TABLE work.criteria_item ADD CONSTRAINT criteria_item_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
  REFERENCES work.task (workspace_id, brand_id, id) ON DELETE RESTRICT;
CREATE INDEX criteria_item_by_task ON work.criteria_item (workspace_id, task_id, kind, rank, id);
CREATE INDEX criteria_item_by_brand_task ON work.criteria_item (workspace_id, brand_id, task_id);

-- A task's response to an inherited project definition-of-done item: met or explicitly dismissed.
-- Inheritance is evaluated at read time; the item is never copied (0B ADR-22).
CREATE TABLE work.task_inherited_criterion (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  task_id uuid NOT NULL,
  criteria_item_id uuid NOT NULL,
  state text NOT NULL,
  by_membership_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_inherited_criterion_pkey PRIMARY KEY (task_id, criteria_item_id),
  CONSTRAINT task_inherited_criterion_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
    REFERENCES work.task (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_inherited_criterion_item_fkey FOREIGN KEY (workspace_id, criteria_item_id)
    REFERENCES work.criteria_item (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_inherited_criterion_by_fkey FOREIGN KEY (workspace_id, by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_inherited_criterion_state_known CHECK (state IN ('met', 'dismissed'))
);
CREATE INDEX task_inherited_criterion_by_task ON work.task_inherited_criterion (workspace_id, task_id);
CREATE INDEX task_inherited_criterion_by_item ON work.task_inherited_criterion (workspace_id, criteria_item_id);
CREATE INDEX task_inherited_criterion_by_brand_task ON work.task_inherited_criterion (workspace_id, brand_id, task_id);
CREATE INDEX task_inherited_criterion_by_member ON work.task_inherited_criterion (workspace_id, by_membership_id);

CREATE FUNCTION work.assert_inherited_criterion() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM work.criteria_item c JOIN work.task t
        ON t.workspace_id = c.workspace_id AND t.project_id = c.project_id
      WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.criteria_item_id AND t.id = NEW.task_id
        AND c.owner_kind = 'project' AND c.kind = 'definition_of_done') THEN
    RAISE EXCEPTION 'only the task''s project definition-of-done items are inherited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER task_inherited_criterion_shape BEFORE INSERT OR UPDATE ON work.task_inherited_criterion
  FOR EACH ROW EXECUTE FUNCTION work.assert_inherited_criterion();

-- ---------------------------------------------------------------------------------------------
-- Labels (OD-10): one brand each; applied to tasks of the same workspace and brand only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE work.label (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  color text NOT NULL,
  icon text,
  rank text COLLATE "C" NOT NULL,
  state text NOT NULL DEFAULT 'active',
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT label_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT label_brand_key UNIQUE (workspace_id, brand_id, id),
  CONSTRAINT label_name_unique UNIQUE (workspace_id, brand_id, normalized_name),
  CONSTRAINT label_public_id_format CHECK (public_id ~ '^lbl_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT label_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT label_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT label_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 60 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 60)),
  CONSTRAINT label_normalized CHECK (normalized_name = lower(regexp_replace(name, '\s+', ' ', 'g'))),
  CONSTRAINT label_color_format CHECK (color ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT label_icon_known CHECK (icon IS NULL OR icon ~ '^[a-z][a-z_]{1,30}$'),
  CONSTRAINT label_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT label_state_known CHECK (state IN ('active', 'archived')),
  CONSTRAINT label_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX label_by_brand ON work.label (workspace_id, brand_id, state, rank, id);
CREATE INDEX label_by_creator ON work.label (workspace_id, created_by_membership_id);

CREATE TABLE work.task_label (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  task_id uuid NOT NULL,
  label_id uuid NOT NULL,
  added_by_membership_id uuid,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_label_pkey PRIMARY KEY (task_id, label_id),
  CONSTRAINT task_label_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
    REFERENCES work.task (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_label_label_fkey FOREIGN KEY (workspace_id, brand_id, label_id)
    REFERENCES work.label (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_label_adder_fkey FOREIGN KEY (workspace_id, added_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX task_label_by_task ON work.task_label (workspace_id, task_id);
CREATE INDEX task_label_by_label ON work.task_label (workspace_id, label_id);
CREATE INDEX task_label_by_brand_task ON work.task_label (workspace_id, brand_id, task_id);
CREATE INDEX task_label_by_brand_label ON work.task_label (workspace_id, brand_id, label_id);
CREATE INDEX task_label_by_adder ON work.task_label (workspace_id, added_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE work.task ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.task FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.task
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.task_assignee ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.task_assignee FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.task_assignee
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.checklist_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.checklist_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.checklist_item
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.task_inherited_criterion ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.task_inherited_criterion FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.task_inherited_criterion
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.label ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.label FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.label
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE work.task_label ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.task_label FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.task_label
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON work.task, work.task_assignee, work.checklist_item, work.task_inherited_criterion, work.label,
  work.task_label FROM PUBLIC;
GRANT SELECT, INSERT ON work.task TO app_rw;
GRANT UPDATE (project_id, parent_task_id, ancestor_ids, depth, brand_id, scope_key, title, description_rich, status_id,
  status_category, prior_status_id, priority, start_date, due_date, deadline_date, deadline_at, deadline_tz,
  estimate_minutes, remaining_estimate_minutes, completed_at, completed_by_membership_id, completion_override_reason,
  expected_deliverable_type, expected_deliverable_detail, requires_acceptance, rank, updated_at,
  updated_by_membership_id, version) ON work.task TO app_rw;
GRANT SELECT, INSERT, DELETE ON work.task_assignee, work.checklist_item, work.task_inherited_criterion,
  work.task_label TO app_rw;
GRANT UPDATE (is_primary, rank) ON work.task_assignee TO app_rw;
GRANT UPDATE (text, rank, done, done_by_membership_id, done_at, updated_at, version) ON work.checklist_item TO app_rw;
GRANT UPDATE (state, by_membership_id, at) ON work.task_inherited_criterion TO app_rw;
-- A cross-brand move rewrites the brand of the task's own rows in the same transaction.
GRANT UPDATE (brand_id) ON work.task_assignee, work.checklist_item, work.task_inherited_criterion TO app_rw;
GRANT UPDATE (brand_id, project_id) ON work.criteria_item TO app_rw;
GRANT SELECT, INSERT ON work.label TO app_rw;
GRANT UPDATE (name, normalized_name, color, icon, rank, state, updated_at, version) ON work.label TO app_rw;
-- The worker reads tasks (purge hooks, rollups) and deletes contained rows during purge.
GRANT SELECT, DELETE ON work.task, work.task_assignee, work.checklist_item, work.task_inherited_criterion,
  work.label, work.task_label TO app_worker;
REVOKE ALL ON FUNCTION work.task_status_category(), work.assert_task_ancestry(), work.assert_assignee_eligible(),
  work.assert_inherited_criterion() FROM PUBLIC;
