-- migrate:phase expand
-- Phase 2C (ADR-23): configurable workflows. One workflow system: workflow.workflow at a
-- workspace, brand, or project scope for one record kind; its statuses (fixed categories) and
-- transitions with required fields, confirmation, and approval policy; append-only approval
-- requests and decisions. Platform statuses stay immutable seeds and are never copied.
-- A record's status_id now references a platform status or a workflow status (trigger-checked,
-- delete-guarded); status_category stays a guarded denormalization.

-- ---------------------------------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workflow.workflow (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  project_id uuid,
  scope_kind text NOT NULL,
  record_kind text NOT NULL,
  name text NOT NULL,
  state text NOT NULL DEFAULT 'active',
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT workflow_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT workflow_public_id_format CHECK (public_id ~ '^wf_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT workflow_scope_known CHECK (scope_kind IN ('workspace', 'brand', 'project')),
  CONSTRAINT workflow_record_kind_known CHECK (record_kind IN ('project', 'task')),
  CONSTRAINT workflow_scope_shape CHECK (
    (scope_kind = 'workspace' AND brand_id IS NULL AND project_id IS NULL)
    OR (scope_kind = 'brand' AND brand_id IS NOT NULL AND project_id IS NULL)
    OR (scope_kind = 'project' AND brand_id IS NOT NULL AND project_id IS NOT NULL)),
  CONSTRAINT workflow_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT workflow_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT workflow_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT workflow_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 80)),
  CONSTRAINT workflow_state_known CHECK (state IN ('active', 'archived')),
  CONSTRAINT workflow_version_nonnegative CHECK (version >= 0)
);
-- At most one active workflow per scope and record kind.
CREATE UNIQUE INDEX workflow_one_active ON workflow.workflow (workspace_id, record_kind, scope_kind,
  coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE state = 'active';
CREATE INDEX workflow_by_scope ON workflow.workflow (workspace_id, record_kind, state, scope_kind, brand_id, project_id);
CREATE INDEX workflow_by_brand ON workflow.workflow (workspace_id, brand_id);
CREATE INDEX workflow_by_project ON workflow.workflow (workspace_id, brand_id, project_id);
CREATE INDEX workflow_by_creator ON workflow.workflow (workspace_id, created_by_membership_id);

-- The workflow that applies to a record: the most specific active scope (project → brand →
-- workspace); NULL means the platform default. A project-scope workflow applies to that project
-- (record kind project) or to its tasks (record kind task), never to child projects' tasks.
CREATE FUNCTION workflow.resolve_workflow(p_kind text, p_workspace uuid, p_brand uuid, p_project uuid)
  RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.id FROM workflow.workflow w
   WHERE w.workspace_id = p_workspace AND w.record_kind = p_kind AND w.state = 'active'
     AND ((w.scope_kind = 'project' AND w.project_id = p_project)
       OR (w.scope_kind = 'brand' AND w.brand_id = p_brand)
       OR w.scope_kind = 'workspace')
   ORDER BY CASE w.scope_kind WHEN 'project' THEN 0 WHEN 'brand' THEN 1 ELSE 2 END
   LIMIT 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Statuses: one fixed category each; renamed, recolored, and reordered without losing identity.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workflow.workflow_status (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  workflow_id uuid NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  description text,
  category text NOT NULL,
  color text NOT NULL,
  icon text,
  rank text COLLATE "C" NOT NULL,
  state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT workflow_status_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT workflow_status_workflow_key UNIQUE (workspace_id, workflow_id, id),
  CONSTRAINT workflow_status_public_id_format CHECK (public_id ~ '^sts_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT workflow_status_workflow_fkey FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES workflow.workflow (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT workflow_status_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 60 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 60)),
  CONSTRAINT workflow_status_normalized CHECK (normalized_name = lower(regexp_replace(name, '\s+', ' ', 'g'))),
  CONSTRAINT workflow_status_description_text CHECK (description IS NULL
    OR (char_length(description) BETWEEN 1 AND 500 AND tenancy.valid_plain_text(description, 500))),
  CONSTRAINT workflow_status_category_known CHECK (category IN ('planned', 'active', 'paused', 'done', 'cancelled')),
  CONSTRAINT workflow_status_color_format CHECK (color ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT workflow_status_icon_known CHECK (icon IS NULL OR icon ~ '^[a-z][a-z_]{1,30}$'),
  CONSTRAINT workflow_status_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT workflow_status_state_known CHECK (state IN ('active', 'archived')),
  CONSTRAINT workflow_status_version_nonnegative CHECK (version >= 0)
);
CREATE UNIQUE INDEX workflow_status_active_name ON workflow.workflow_status (workflow_id, normalized_name)
  WHERE state = 'active';
CREATE INDEX workflow_status_by_workflow ON workflow.workflow_status (workspace_id, workflow_id, state, rank, id);

CREATE FUNCTION workflow.workflow_status_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.category IS DISTINCT FROM OLD.category OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.public_id IS DISTINCT FROM OLD.public_id THEN
      RAISE EXCEPTION 'a status keeps its workflow and category' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- DELETE: a status in use (current or reopen target) is archived, never removed.
  IF EXISTS (SELECT 1 FROM work.task t WHERE t.workspace_id = OLD.workspace_id
               AND (t.status_id = OLD.id OR t.prior_status_id = OLD.id))
     OR EXISTS (SELECT 1 FROM work.project p WHERE p.workspace_id = OLD.workspace_id AND p.status_id = OLD.id) THEN
    RAISE EXCEPTION 'status in use' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER workflow_status_guard BEFORE UPDATE OR DELETE ON workflow.workflow_status
  FOR EACH ROW EXECUTE FUNCTION workflow.workflow_status_guard();

-- ---------------------------------------------------------------------------------------------
-- Transitions: directed edges between statuses of the same workflow.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workflow.transition (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  workflow_id uuid NOT NULL,
  from_status_id uuid NOT NULL,
  to_status_id uuid NOT NULL,
  description text,
  rank text COLLATE "C" NOT NULL,
  confirmation_tier text NOT NULL DEFAULT 'none',
  approval_policy text NOT NULL DEFAULT 'none',
  allow_self_approval boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT transition_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT transition_public_id_format CHECK (public_id ~ '^trn_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT transition_workflow_fkey FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES workflow.workflow (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT transition_from_fkey FOREIGN KEY (workspace_id, workflow_id, from_status_id)
    REFERENCES workflow.workflow_status (workspace_id, workflow_id, id) ON DELETE RESTRICT,
  CONSTRAINT transition_to_fkey FOREIGN KEY (workspace_id, workflow_id, to_status_id)
    REFERENCES workflow.workflow_status (workspace_id, workflow_id, id) ON DELETE RESTRICT,
  CONSTRAINT transition_not_self CHECK (from_status_id <> to_status_id),
  CONSTRAINT transition_description_text CHECK (description IS NULL
    OR (char_length(description) BETWEEN 1 AND 500 AND tenancy.valid_plain_text(description, 500))),
  CONSTRAINT transition_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT transition_confirmation_known CHECK (confirmation_tier IN ('none', 'confirm', 'step_up')),
  CONSTRAINT transition_approval_known CHECK (approval_policy IN ('none', 'one_manager', 'all_named_approvers')),
  CONSTRAINT transition_self_needs_policy CHECK (NOT allow_self_approval OR approval_policy <> 'none'),
  CONSTRAINT transition_state_known CHECK (state IN ('active', 'archived')),
  CONSTRAINT transition_version_nonnegative CHECK (version >= 0)
);
CREATE UNIQUE INDEX transition_active_edge ON workflow.transition (workflow_id, from_status_id, to_status_id)
  WHERE state = 'active';
CREATE INDEX transition_by_workflow ON workflow.transition (workspace_id, workflow_id, state, from_status_id, rank, id);
CREATE INDEX transition_by_from ON workflow.transition (workspace_id, workflow_id, from_status_id);
CREATE INDEX transition_by_to ON workflow.transition (workspace_id, workflow_id, to_status_id);

-- Required fields: a built-in key or (from 0026) a custom field definition.
CREATE TABLE workflow.transition_requirement (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  transition_id uuid NOT NULL,
  field_kind text NOT NULL,
  builtin_key text,
  definition_id uuid,
  allow_manager_override boolean NOT NULL DEFAULT false,
  rank text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transition_requirement_transition_fkey FOREIGN KEY (workspace_id, transition_id)
    REFERENCES workflow.transition (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT transition_requirement_kind_known CHECK (field_kind IN ('builtin', 'custom')),
  CONSTRAINT transition_requirement_shape CHECK (
    (field_kind = 'builtin' AND builtin_key IS NOT NULL AND definition_id IS NULL)
    OR (field_kind = 'custom' AND builtin_key IS NULL AND definition_id IS NOT NULL)),
  CONSTRAINT transition_requirement_builtin_known CHECK (builtin_key IS NULL OR builtin_key IN (
    'description', 'priority', 'start_date', 'due_date', 'deadline', 'estimate_minutes',
    'remaining_estimate_minutes', 'assignees', 'labels', 'expected_deliverable_type',
    'owner', 'target_date', 'health', 'budget')),
  CONSTRAINT transition_requirement_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$')
);
CREATE UNIQUE INDEX transition_requirement_builtin ON workflow.transition_requirement (transition_id, builtin_key)
  WHERE builtin_key IS NOT NULL;
CREATE UNIQUE INDEX transition_requirement_custom ON workflow.transition_requirement (transition_id, definition_id)
  WHERE definition_id IS NOT NULL;
CREATE INDEX transition_requirement_by_transition ON workflow.transition_requirement (workspace_id, transition_id, rank);
CREATE INDEX transition_requirement_by_definition ON workflow.transition_requirement (workspace_id, definition_id);

-- Named approvers (all_named_approvers). Naming someone grants no access.
CREATE TABLE workflow.transition_approver (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  transition_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  rank text COLLATE "C" NOT NULL,
  CONSTRAINT transition_approver_pkey PRIMARY KEY (transition_id, membership_id),
  CONSTRAINT transition_approver_transition_fkey FOREIGN KEY (workspace_id, transition_id)
    REFERENCES workflow.transition (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT transition_approver_membership_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT transition_approver_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$')
);
CREATE INDEX transition_approver_by_transition ON workflow.transition_approver (workspace_id, transition_id, rank);
CREATE INDEX transition_approver_by_membership ON workflow.transition_approver (workspace_id, membership_id);

-- ---------------------------------------------------------------------------------------------
-- Approvals: immutable facts bound to one transition version and one record version.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workflow.approval_request (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  transition_id uuid NOT NULL,
  transition_version bigint NOT NULL,
  record_id uuid NOT NULL,
  record_type text NOT NULL,
  record_version bigint NOT NULL,
  fingerprint text NOT NULL,
  requester_membership_id uuid NOT NULL,
  policy text NOT NULL,
  approver_membership_ids uuid[] NOT NULL DEFAULT '{}',
  allow_self_approval boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_reason text,
  CONSTRAINT approval_request_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT approval_request_public_id_format CHECK (public_id ~ '^wap_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT approval_request_transition_fkey FOREIGN KEY (workspace_id, transition_id)
    REFERENCES workflow.transition (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT approval_request_workflow_fkey FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES workflow.workflow (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT approval_request_record_fkey FOREIGN KEY (workspace_id, record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT approval_request_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT approval_request_requester_fkey FOREIGN KEY (workspace_id, requester_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT approval_request_record_type_known CHECK (record_type IN ('project', 'task')),
  CONSTRAINT approval_request_policy_known CHECK (policy IN ('one_manager', 'all_named_approvers')),
  CONSTRAINT approval_request_named_have_approvers CHECK (policy <> 'all_named_approvers'
    OR cardinality(approver_membership_ids) >= 1),
  CONSTRAINT approval_request_fingerprint_format CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT approval_request_expiry_after CHECK (expires_at > created_at),
  CONSTRAINT approval_request_closed_shape CHECK ((closed_at IS NULL) = (closed_reason IS NULL)),
  CONSTRAINT approval_request_closed_known CHECK (closed_reason IS NULL OR closed_reason IN ('applied', 'withdrawn'))
);
CREATE INDEX approval_request_by_record ON workflow.approval_request (workspace_id, record_id, created_at DESC, id);
CREATE INDEX approval_request_open ON workflow.approval_request (workspace_id, expires_at, id) WHERE closed_at IS NULL;
CREATE INDEX approval_request_by_transition ON workflow.approval_request (workspace_id, transition_id);
CREATE INDEX approval_request_by_workflow ON workflow.approval_request (workspace_id, workflow_id);
CREATE INDEX approval_request_by_requester ON workflow.approval_request (workspace_id, requester_membership_id);
CREATE INDEX approval_request_by_brand ON workflow.approval_request (workspace_id, brand_id);

CREATE TABLE workflow.approval_decision (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  approval_request_id uuid NOT NULL,
  approver_membership_id uuid NOT NULL,
  decision text NOT NULL,
  note_hash text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_decision_request_fkey FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES workflow.approval_request (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT approval_decision_approver_fkey FOREIGN KEY (workspace_id, approver_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT approval_decision_once UNIQUE (approval_request_id, approver_membership_id),
  CONSTRAINT approval_decision_known CHECK (decision IN ('approve', 'reject')),
  CONSTRAINT approval_decision_note_hash CHECK (note_hash IS NULL OR note_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX approval_decision_by_request ON workflow.approval_decision (workspace_id, approval_request_id);
CREATE INDEX approval_decision_by_approver ON workflow.approval_decision (workspace_id, approver_membership_id);

-- A request changes only by its one-time close; decisions never change. The one other write is
-- the brand root following a task moved by work.move_task_brand (recognised by its definer).
CREATE FUNCTION workflow.approval_request_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.brand_id IS DISTINCT FROM OLD.brand_id
     AND (to_jsonb(NEW) - 'brand_id') = (to_jsonb(OLD) - 'brand_id')
     AND current_user = (SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                          WHERE p.oid = 'work.move_task_brand(uuid[], uuid)'::regprocedure) THEN
    RETURN NEW;
  END IF;
  IF OLD.closed_at IS NOT NULL
     OR (to_jsonb(NEW) - 'closed_at' - 'closed_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'closed_at' - 'closed_reason') THEN
    RAISE EXCEPTION 'approval requests are immutable except their one-time close' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER approval_request_guard BEFORE UPDATE ON workflow.approval_request
  FOR EACH ROW EXECUTE FUNCTION workflow.approval_request_guard();

-- ---------------------------------------------------------------------------------------------
-- Record statuses: a platform status or a status of the workflow that applies to the record.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE work.task DROP CONSTRAINT task_status_id_fkey;
ALTER TABLE work.task DROP CONSTRAINT task_prior_status_id_fkey;
ALTER TABLE work.project DROP CONSTRAINT project_status_id_fkey;

-- The category of a status of `p_kind`, or NULL when the id is not such a status.
CREATE FUNCTION workflow.status_category(p_kind text, p_workspace uuid, p_status uuid) RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT category FROM workflow.platform_status WHERE id = p_status AND record_type = p_kind
  UNION ALL
  SELECT s.category FROM workflow.workflow_status s JOIN workflow.workflow w ON w.id = s.workflow_id
   WHERE s.id = p_status AND s.workspace_id = p_workspace AND w.record_kind = p_kind
  LIMIT 1
$$;

-- A newly chosen status must be offered by the workflow that applies now: an active status of the
-- resolved workflow, or a platform status when only the default applies. Unchanged statuses stay
-- valid after their workflow is archived or superseded, until records are migrated.
CREATE FUNCTION workflow.status_offered(p_kind text, p_workspace uuid, p_brand uuid, p_project uuid, p_status uuid)
  RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT CASE
    WHEN workflow.resolve_workflow(p_kind, p_workspace, p_brand, p_project) IS NULL THEN
      EXISTS (SELECT 1 FROM workflow.platform_status WHERE id = p_status AND record_type = p_kind)
    ELSE EXISTS (SELECT 1 FROM workflow.workflow_status s
      WHERE s.id = p_status AND s.state = 'active'
        AND s.workflow_id = workflow.resolve_workflow(p_kind, p_workspace, p_brand, p_project))
  END
$$;

CREATE OR REPLACE FUNCTION work.task_status_category() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.status_category := workflow.status_category('task', NEW.workspace_id, NEW.status_id);
  IF NEW.status_category IS NULL THEN
    RAISE EXCEPTION 'task status must be a task status' USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.status_id IS DISTINCT FROM OLD.status_id)
     AND NOT workflow.status_offered('task', NEW.workspace_id, NEW.brand_id, NEW.project_id, NEW.status_id) THEN
    RAISE EXCEPTION 'the status is not offered by the workflow that applies' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.prior_status_id IS NOT NULL
     AND coalesce(workflow.status_category('task', NEW.workspace_id, NEW.prior_status_id), 'done') IN ('done', 'cancelled') THEN
    RAISE EXCEPTION 'a reopen target must be a non-terminal task status' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION work.project_status_category() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.status_category := workflow.status_category('project', NEW.workspace_id, NEW.status_id);
  IF NEW.status_category IS NULL THEN
    RAISE EXCEPTION 'project status must be a project status' USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.status_id IS DISTINCT FROM OLD.status_id)
     AND NOT workflow.status_offered('project', NEW.workspace_id, NEW.brand_id, NEW.id, NEW.status_id) THEN
    RAISE EXCEPTION 'the status is not offered by the workflow that applies' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE workflow.workflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.workflow FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.workflow
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE workflow.workflow_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.workflow_status FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.workflow_status
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE workflow.transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.transition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.transition
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE workflow.transition_requirement ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.transition_requirement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.transition_requirement
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE workflow.transition_approver ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.transition_approver FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.transition_approver
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE workflow.approval_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.approval_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.approval_request
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE workflow.approval_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.approval_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.approval_decision
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON workflow.workflow, workflow.workflow_status, workflow.transition, workflow.transition_requirement,
  workflow.transition_approver, workflow.approval_request, workflow.approval_decision FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON workflow.workflow, workflow.workflow_status, workflow.transition,
  workflow.transition_requirement, workflow.transition_approver TO app_rw;
GRANT UPDATE (name, state, updated_at, version) ON workflow.workflow TO app_rw;
GRANT UPDATE (name, normalized_name, description, color, icon, rank, state, updated_at, version)
  ON workflow.workflow_status TO app_rw;
GRANT UPDATE (description, rank, confirmation_tier, approval_policy, allow_self_approval, state, updated_at, version)
  ON workflow.transition TO app_rw;
GRANT UPDATE (allow_manager_override, rank) ON workflow.transition_requirement TO app_rw;
GRANT UPDATE (rank) ON workflow.transition_approver TO app_rw;
-- Approval facts: append-only for the application; the one-time close is the only update.
GRANT SELECT, INSERT ON workflow.approval_request, workflow.approval_decision TO app_rw;
GRANT UPDATE (closed_at, closed_reason) ON workflow.approval_request TO app_rw;
-- A cross-brand task move carries its approval requests to the new brand (definer function).
-- The worker reads configuration and removes a purged record's approval facts.
GRANT SELECT ON workflow.workflow, workflow.workflow_status, workflow.transition, workflow.transition_requirement,
  workflow.transition_approver TO app_worker;
GRANT SELECT, DELETE ON workflow.approval_request, workflow.approval_decision TO app_worker;

REVOKE ALL ON FUNCTION workflow.resolve_workflow(text, uuid, uuid, uuid), workflow.status_category(text, uuid, uuid),
  workflow.status_offered(text, uuid, uuid, uuid, uuid), workflow.workflow_status_guard(),
  workflow.approval_request_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow.resolve_workflow(text, uuid, uuid, uuid), workflow.status_category(text, uuid, uuid),
  workflow.status_offered(text, uuid, uuid, uuid, uuid) TO app_rw, app_worker;
