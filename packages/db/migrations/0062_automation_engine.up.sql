-- migrate:phase expand
-- Phase 8A automation engine (0B ADR-51, 0C AZ-51, 0D PL-53, UXD-32, ADR-0046). Reconciles the 0B
-- automation entities: the `automation` record extension (accountable owner, declared scope, draft,
-- suspension), immutable revisions, runs (detail of `automation_run` operations, pinned to one
-- revision, owner and scope snapshot, deduplicated per trigger occurrence), step runs, R3 standing
-- approvals, date/schedule trigger state, and per-workspace usage counters. Extends 4B notification
-- types with `automation_notice` and 7A AI actions with the `automation` caller. Builds on 0001–0061;
-- no earlier file changes.

CREATE SCHEMA automation;
REVOKE ALL ON SCHEMA automation FROM PUBLIC;
GRANT USAGE ON SCHEMA automation TO app_rw, app_worker, pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- The automation record (core.record extension, prefix `auto`). Brand-scoped automations carry
-- their brand; workspace automations carry none and list their brands explicitly in each revision
-- (workspace scope is never all-brands authority). The draft is the editable form; revisions are
-- immutable. `trigger_event` and `active_revision_id` are the activation's denormalized matching
-- keys and `activated_at` its instant (events that happened earlier never start a run, so enabling
-- again never replays history); `active_runs` is the per-automation concurrency reservation (reserved and released once).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE automation.automation (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  name text NOT NULL,
  description text,
  owner_membership_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  active_revision_id uuid,
  trigger_kind text,
  trigger_event text,
  activated_at timestamptz,
  draft jsonb NOT NULL,
  draft_base_revision integer,
  template_key text,
  duplicated_from_id uuid,
  suspended_reason text,
  suspended_at timestamptz,
  active_runs integer NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  alerted_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  updated_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT automation_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT automation_scope_key UNIQUE (workspace_id, scope_key, id),
  CONSTRAINT automation_scope_shape CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT automation_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT automation_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_duplicated_fkey FOREIGN KEY (workspace_id, duplicated_from_id)
    REFERENCES automation.automation (workspace_id, id) ON DELETE SET NULL (duplicated_from_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT automation_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT automation_description CHECK (description IS NULL OR char_length(description) <= 1000),
  CONSTRAINT automation_draft CHECK (jsonb_typeof(draft) = 'object' AND octet_length(draft::text) <= 131072),
  CONSTRAINT automation_trigger_kind CHECK (trigger_kind IS NULL OR trigger_kind ~ '^[a-z_.]{1,40}$'),
  CONSTRAINT automation_trigger_event CHECK (trigger_event IS NULL OR trigger_event ~ '^[a-z_.]{1,80}$'),
  CONSTRAINT automation_enabled_shape CHECK (NOT enabled OR (active_revision_id IS NOT NULL
    AND trigger_kind IS NOT NULL AND activated_at IS NOT NULL AND suspended_reason IS NULL)),
  CONSTRAINT automation_template_key CHECK (template_key IS NULL OR template_key ~ '^[a-z_]{1,40}$'),
  CONSTRAINT automation_suspended_shape CHECK (
    (suspended_reason IS NULL) = (suspended_at IS NULL)
    AND (suspended_reason IS NULL OR suspended_reason IN ('owner_authority', 'owner_departed', 'admin'))),
  CONSTRAINT automation_active_runs CHECK (active_runs >= 0 AND active_runs <= 10000),
  CONSTRAINT automation_failures CHECK (consecutive_failures >= 0 AND consecutive_failures <= 100000),
  CONSTRAINT automation_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX automation_by_envelope ON automation.automation (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX automation_by_owner ON automation.automation (workspace_id, owner_membership_id);
CREATE INDEX automation_by_brand ON automation.automation (workspace_id, brand_id);
CREATE INDEX automation_by_duplicate ON automation.automation (workspace_id, duplicated_from_id);
CREATE INDEX automation_listening ON automation.automation (workspace_id, trigger_event)
  WHERE enabled AND trigger_event IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Immutable revisions: the compiled definition, its hash, the resolved declared scope (internal
-- ids), and the declared action keys and classes. No role may update or delete a revision except
-- the purge hook (delete only).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE automation.automation_revision (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  automation_id uuid NOT NULL,
  revision_number integer NOT NULL,
  schema_version integer NOT NULL,
  definition jsonb NOT NULL,
  definition_hash text NOT NULL,
  trigger_kind text NOT NULL,
  record_kind text,
  declared_brand_ids uuid[] NOT NULL,
  declared_project_ids uuid[] NOT NULL DEFAULT '{}',
  action_keys text[] NOT NULL,
  action_classes text[] NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_revision_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT automation_revision_number_unique UNIQUE (workspace_id, automation_id, revision_number),
  CONSTRAINT automation_revision_automation_fkey FOREIGN KEY (workspace_id, automation_id)
    REFERENCES automation.automation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_revision_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_revision_number CHECK (revision_number BETWEEN 1 AND 100000),
  CONSTRAINT automation_revision_schema CHECK (schema_version = 1),
  CONSTRAINT automation_revision_definition CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 131072),
  CONSTRAINT automation_revision_hash CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT automation_revision_trigger CHECK (trigger_kind ~ '^[a-z_.]{1,40}$'),
  CONSTRAINT automation_revision_record CHECK (record_kind IS NULL OR record_kind IN ('task', 'project')),
  CONSTRAINT automation_revision_brands CHECK (cardinality(declared_brand_ids) BETWEEN 1 AND 100),
  CONSTRAINT automation_revision_projects CHECK (cardinality(declared_project_ids) <= 100),
  CONSTRAINT automation_revision_actions CHECK (cardinality(action_keys) BETWEEN 1 AND 50),
  CONSTRAINT automation_revision_classes CHECK (action_classes <@ ARRAY['internal', 'ai', 'outbound', 'agent']::text[])
);
CREATE INDEX automation_revision_by_creator ON automation.automation_revision (workspace_id, created_by_membership_id);

-- Deferred (NO ACTION): a purge removes revisions and their automation in one commit.
ALTER TABLE automation.automation ADD CONSTRAINT automation_active_revision_fkey
  FOREIGN KEY (workspace_id, active_revision_id) REFERENCES automation.automation_revision (workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX automation_by_active_revision ON automation.automation (workspace_id, active_revision_id);

CREATE FUNCTION automation.revision_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'automation revisions are immutable' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER automation_revision_immutable BEFORE UPDATE ON automation.automation_revision
  FOR EACH ROW EXECUTE FUNCTION automation.revision_immutable();

-- ---------------------------------------------------------------------------------------------
-- Runs: the detail of `automation_run` operations. One run per (automation, trigger occurrence):
-- the first consumption pins the revision, owner, scope snapshot, run day and zone, and lineage;
-- redelivery and competing workers converge on the same row. A retry keeps the run and moves
-- `current_operation_id` to a rerun operation. Trigger records are references (a purged record
-- leaves a tombstone), so they carry no foreign key; the purge hook clears them. `slot_held` marks the
-- run's share of the per-automation concurrency reservation, released exactly once.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE automation.automation_run (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  automation_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  current_operation_id uuid NOT NULL,
  owner_membership_id uuid NOT NULL,
  trigger_kind text NOT NULL,
  trigger_key text NOT NULL,
  trigger_event_id uuid,
  trigger_record_id uuid,
  root_causation_id uuid,
  lineage uuid[] NOT NULL DEFAULT '{}',
  chain_depth integer NOT NULL DEFAULT 0,
  scope_snapshot jsonb NOT NULL,
  run_day date NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  reason text,
  cursor text,
  wake_at timestamptz,
  steps_executed integer NOT NULL DEFAULT 0,
  retry_count integer NOT NULL DEFAULT 0,
  usage_state text NOT NULL DEFAULT 'none',
  slot_held boolean NOT NULL DEFAULT false,
  initiated_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0,
  CONSTRAINT automation_run_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT automation_run_occurrence_unique UNIQUE (workspace_id, automation_id, trigger_key),
  CONSTRAINT automation_run_operation_unique UNIQUE (workspace_id, operation_id),
  CONSTRAINT automation_run_automation_fkey FOREIGN KEY (workspace_id, automation_id)
    REFERENCES automation.automation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_run_revision_fkey FOREIGN KEY (workspace_id, revision_id)
    REFERENCES automation.automation_revision (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_run_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_run_current_fkey FOREIGN KEY (workspace_id, current_operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_run_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_run_initiator_fkey FOREIGN KEY (workspace_id, initiated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_run_trigger_kind CHECK (trigger_kind ~ '^[a-z_.]{1,40}$'),
  CONSTRAINT automation_run_trigger_key CHECK (trigger_key ~ '^[a-z]+:[A-Za-z0-9_:.T-]{1,200}$'),
  CONSTRAINT automation_run_lineage CHECK (cardinality(lineage) <= 32 AND chain_depth BETWEEN 0 AND 32
    AND chain_depth = cardinality(lineage)),
  CONSTRAINT automation_run_snapshot CHECK (jsonb_typeof(scope_snapshot) = 'object' AND octet_length(scope_snapshot::text) <= 16384),
  CONSTRAINT automation_run_timezone CHECK (char_length(timezone) BETWEEN 1 AND 64),
  CONSTRAINT automation_run_status CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'partial',
    'failed', 'policy_rejected', 'cancelled', 'skipped')),
  CONSTRAINT automation_run_reason CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,64}$'),
  CONSTRAINT automation_run_cursor CHECK (cursor IS NULL OR cursor ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT automation_run_wake CHECK ((status = 'waiting' AND reason = 'delay') = (wake_at IS NOT NULL)),
  CONSTRAINT automation_run_counts CHECK (steps_executed BETWEEN 0 AND 100000 AND retry_count BETWEEN 0 AND 100),
  CONSTRAINT automation_run_usage CHECK (usage_state IN ('none', 'reserved', 'settled', 'released')),
  CONSTRAINT automation_run_slot CHECK (NOT slot_held OR status IN ('queued', 'running', 'waiting')),
  CONSTRAINT automation_run_ended CHECK ((status IN ('succeeded', 'partial', 'failed', 'policy_rejected',
    'cancelled', 'skipped')) = (ended_at IS NOT NULL))
);
CREATE INDEX automation_run_by_automation ON automation.automation_run (workspace_id, automation_id, created_at DESC);
CREATE INDEX automation_run_by_revision ON automation.automation_run (workspace_id, revision_id);
CREATE INDEX automation_run_by_current ON automation.automation_run (workspace_id, current_operation_id);
CREATE INDEX automation_run_by_owner ON automation.automation_run (workspace_id, owner_membership_id);
CREATE INDEX automation_run_by_initiator ON automation.automation_run (workspace_id, initiated_by_membership_id);
CREATE INDEX automation_run_by_record ON automation.automation_run (workspace_id, trigger_record_id)
  WHERE trigger_record_id IS NOT NULL;
CREATE INDEX automation_run_open ON automation.automation_run (workspace_id, automation_id)
  WHERE status IN ('queued', 'running', 'waiting');
CREATE INDEX automation_run_ended ON automation.automation_run (workspace_id, ended_at)
  WHERE ended_at IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Step runs: what ran, why, and with which bounded result. A step succeeds at most once per run
-- (retries resume failed steps, never successful predecessors). Decisions, targets, and outputs
-- are bounded references and codes: no record content, payloads, or secrets.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE automation.automation_step_run (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  node_id text NOT NULL,
  attempt integer NOT NULL,
  kind text NOT NULL,
  action_key text,
  state text NOT NULL,
  failure_class text,
  code text,
  decision jsonb,
  targets jsonb,
  output jsonb,
  logical_key text,
  operation_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT automation_step_run_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT automation_step_run_attempt_unique UNIQUE (workspace_id, run_id, node_id, attempt),
  CONSTRAINT automation_step_run_run_fkey FOREIGN KEY (workspace_id, run_id)
    REFERENCES automation.automation_run (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_step_run_operation_fkey FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_step_run_node CHECK (node_id ~ '^([a-z][a-z0-9_]{0,31}|_trigger|_conditions)$'),
  CONSTRAINT automation_step_run_attempt CHECK (attempt BETWEEN 1 AND 100),
  CONSTRAINT automation_step_run_kind CHECK (kind IN ('admission', 'conditions', 'action', 'branch', 'delay')),
  CONSTRAINT automation_step_run_action CHECK ((kind = 'action') = (action_key IS NOT NULL)
    AND (action_key IS NULL OR action_key ~ '^[a-z]+\.[a-z]+$')),
  CONSTRAINT automation_step_run_state CHECK (state IN ('succeeded', 'failed', 'refused', 'skipped',
    'waiting', 'dispatching', 'unknown', 'cancelled')),
  CONSTRAINT automation_step_run_failure CHECK (failure_class IS NULL OR failure_class IN ('policy_rejected',
    'validation_failed', 'conflict', 'not_found', 'unavailable', 'limit_exceeded', 'unknown_outcome', 'error')),
  CONSTRAINT automation_step_run_code CHECK (code IS NULL OR code ~ '^[a-z_.]{1,64}$'),
  CONSTRAINT automation_step_run_decision CHECK (decision IS NULL OR (jsonb_typeof(decision) = 'object' AND octet_length(decision::text) <= 4096)),
  CONSTRAINT automation_step_run_targets CHECK (targets IS NULL OR (jsonb_typeof(targets) = 'array' AND octet_length(targets::text) <= 8192)),
  CONSTRAINT automation_step_run_output CHECK (output IS NULL OR (jsonb_typeof(output) = 'object' AND octet_length(output::text) <= 4096)),
  CONSTRAINT automation_step_run_key CHECK (logical_key IS NULL OR logical_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT automation_step_run_ended CHECK ((state IN ('waiting', 'dispatching')) = (ended_at IS NULL))
);
CREATE UNIQUE INDEX automation_step_run_once ON automation.automation_step_run (workspace_id, run_id, node_id)
  WHERE state = 'succeeded';
CREATE INDEX automation_step_run_by_run ON automation.automation_step_run (workspace_id, run_id, started_at);
CREATE INDEX automation_step_run_by_operation ON automation.automation_step_run (workspace_id, operation_id);

-- ---------------------------------------------------------------------------------------------
-- R3 standing approvals (0C §9.4): one per outbound step of one exact revision, naming the
-- destination (and its configuration fingerprint), the payload field set, the scope hash, and the
-- action class, recorded by a human with grantable authority under step-up. Revision, destination,
-- or scope changes leave it unusable; it never replaces send-time authorization.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE automation.standing_approval (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  automation_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  node_id text NOT NULL,
  subscription_id uuid NOT NULL,
  destination_fingerprint text NOT NULL,
  field_set text[] NOT NULL,
  scope_hash text NOT NULL,
  action_class text NOT NULL,
  approved_by_membership_id uuid NOT NULL,
  step_up_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'active',
  approved_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT standing_approval_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT standing_approval_automation_fkey FOREIGN KEY (workspace_id, automation_id)
    REFERENCES automation.automation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT standing_approval_revision_fkey FOREIGN KEY (workspace_id, revision_id)
    REFERENCES automation.automation_revision (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT standing_approval_subscription_fkey FOREIGN KEY (workspace_id, subscription_id)
    REFERENCES integrations.webhook_subscription (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT standing_approval_approver_fkey FOREIGN KEY (workspace_id, approved_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT standing_approval_node CHECK (node_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT standing_approval_fingerprint CHECK (destination_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT standing_approval_scope_hash CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT standing_approval_fields CHECK (cardinality(field_set) BETWEEN 1 AND 20),
  CONSTRAINT standing_approval_class CHECK (action_class = 'outbound.webhook'),
  CONSTRAINT standing_approval_state CHECK (state IN ('active', 'revoked', 'superseded')
    AND (state = 'active') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX standing_approval_one_active ON automation.standing_approval (workspace_id, revision_id, node_id)
  WHERE state = 'active';
CREATE INDEX standing_approval_by_automation ON automation.standing_approval (workspace_id, automation_id);
CREATE INDEX standing_approval_by_subscription ON automation.standing_approval (workspace_id, subscription_id);
CREATE INDEX standing_approval_by_approver ON automation.standing_approval (workspace_id, approved_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Date and schedule trigger state: the next due instant of the active revision and the last
-- occurrence key taken (stable local keys, so a retried sweep never takes one twice).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE automation.trigger_schedule (
  automation_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL,
  kind text NOT NULL,
  next_due_at timestamptz,
  last_key text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trigger_schedule_workspace_key UNIQUE (workspace_id, automation_id),
  CONSTRAINT trigger_schedule_automation_fkey FOREIGN KEY (workspace_id, automation_id)
    REFERENCES automation.automation (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT trigger_schedule_revision_fkey FOREIGN KEY (workspace_id, revision_id)
    REFERENCES automation.automation_revision (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT trigger_schedule_kind CHECK (kind IN ('schedule', 'date')),
  CONSTRAINT trigger_schedule_last_key CHECK (last_key IS NULL OR char_length(last_key) <= 64)
);
CREATE INDEX trigger_schedule_due ON automation.trigger_schedule (workspace_id, next_due_at)
  WHERE next_due_at IS NOT NULL;
CREATE INDEX trigger_schedule_by_revision ON automation.trigger_schedule (workspace_id, revision_id);

-- ---------------------------------------------------------------------------------------------
-- Measured usage per workspace and calendar month (UTC): runs reserved at admission and settled
-- or released exactly once (guarded by the run's usage_state), executed steps counted with their
-- step, and the highest usage alert sent this period. Technical limits only; plan entitlements
-- are 10A.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE automation.usage_period (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  period_start date NOT NULL,
  runs_reserved integer NOT NULL DEFAULT 0,
  runs_settled integer NOT NULL DEFAULT 0,
  runs_released integer NOT NULL DEFAULT 0,
  steps_executed integer NOT NULL DEFAULT 0,
  alerted_bp integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_period_pkey PRIMARY KEY (workspace_id, period_start),
  CONSTRAINT usage_period_first CHECK (extract(day FROM period_start) = 1),
  CONSTRAINT usage_period_counts CHECK (runs_reserved >= 0 AND runs_settled >= 0 AND runs_released >= 0
    AND steps_executed >= 0 AND runs_settled + runs_released <= runs_reserved),
  CONSTRAINT usage_period_alerted CHECK (alerted_bp BETWEEN 0 AND 10000)
);

-- ---------------------------------------------------------------------------------------------
-- 4B: automation notices (the `notify` action) are their own notification type.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE notify.notification DROP CONSTRAINT notification_type_known;
ALTER TABLE notify.notification ADD CONSTRAINT notification_type_known CHECK (type IN
    ('assignment', 'mention', 'comment', 'review_requested', 'approval_decided', 'blocker', 'due_soon',
     'overdue', 'integration_failure', 'automation_failure', 'agent_failure', 'agent_output_ready',
     'spend_threshold', 'permission_changed', 'share_changed', 'briefing_ready', 'export_ready',
     'hidden_dependency_affects_assignee', 'automation_notice'));
ALTER TABLE notify.preference DROP CONSTRAINT preference_type_known;
ALTER TABLE notify.preference ADD CONSTRAINT preference_type_known CHECK (event_type = '*' OR event_type IN
    ('assignment', 'mention', 'comment', 'review_requested', 'approval_decided', 'blocker', 'due_soon',
     'overdue', 'integration_failure', 'automation_failure', 'agent_failure', 'agent_output_ready',
     'spend_threshold', 'permission_changed', 'share_changed', 'briefing_ready', 'export_ready',
     'hidden_dependency_affects_assignee', 'automation_notice'));
ALTER TABLE notify.scope_default DROP CONSTRAINT scope_default_type_known;
ALTER TABLE notify.scope_default ADD CONSTRAINT scope_default_type_known CHECK (event_type = '*' OR event_type IN
    ('assignment', 'mention', 'comment', 'review_requested', 'approval_decided', 'blocker', 'due_soon',
     'overdue', 'integration_failure', 'automation_failure', 'agent_failure', 'agent_output_ready',
     'spend_threshold', 'permission_changed', 'share_changed', 'briefing_ready', 'export_ready',
     'hidden_dependency_affects_assignee', 'automation_notice'));

-- ---------------------------------------------------------------------------------------------
-- 7A: an AI draft requested by an automation step records the `automation` caller (the run's
-- accountable owner is the initiating member; the gateway's own checks, budgets, and human 7D
-- review are unchanged). The worker records that action and its context references.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.ai_action DROP CONSTRAINT ai_action_caller;
ALTER TABLE ai.ai_action ADD CONSTRAINT ai_action_caller CHECK (caller_kind IN ('ui', 'api', 'mcp', 'automation'));
GRANT INSERT ON ai.ai_action, ai.ai_context_ref TO app_worker;

-- ---------------------------------------------------------------------------------------------
-- 8A automation steps run the canonical task and project commands in the worker as the automation
-- (ADR-0046 D8). Least privilege: only the columns those commands write for the supported action
-- matrix (task update/assign/move/label/schedule/archive/relate; project update/schedule/archive).
-- No brand moves (cross-brand moves stay a person's previewed command), no description, deadline,
-- estimate, acceptance, or override columns, no project access, owner, or budget columns, and no
-- access-table writes. RLS still confines every write to the run's workspace.
-- ---------------------------------------------------------------------------------------------
GRANT UPDATE (project_id, parent_task_id, ancestor_ids, depth, title, status_id, status_category, prior_status_id,
  priority, start_date, due_date, rank, updated_at, updated_by_membership_id, version)
  ON work.task TO app_worker;
GRANT INSERT ON work.task_assignee TO app_worker;
GRANT UPDATE (is_primary, rank) ON work.task_assignee TO app_worker;
GRANT INSERT ON relations.record_relationship TO app_worker;
-- A status change takes the applicable workflow row FOR SHARE (ADR-0015 lock order); a row lock
-- needs an UPDATE privilege on some column, so the worker holds it on `updated_at` only.
GRANT UPDATE (updated_at) ON workflow.workflow TO app_worker;
-- An assignment change appends its 4B/4A history fact (append-only, like every other writer).
GRANT INSERT ON collab.assignment_event TO app_worker;
GRANT UPDATE (name, status_id, status_category, priority, start_date, target_date, updated_at,
  updated_by_membership_id, version) ON work.project TO app_worker;

-- ---------------------------------------------------------------------------------------------
-- Permission epochs (0C §13.5) are bumped through one definer function that can only increment
-- the current workspace's epoch (or one principal's): canonical lifecycle commands that 8A steps
-- run in the worker invalidate cached decisions exactly as a person's do. The worker gains no
-- table write on access; a misuse can only cause extra cache invalidation.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION access.bump_permission_epoch(p_kind text, p_subject uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ws uuid := exec.current_workspace_id();
BEGIN
  IF ws IS NULL OR NOT ((p_kind = 'workspace' AND p_subject IS NULL)
      OR (p_kind = 'principal' AND p_subject IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid permission epoch bump' USING ERRCODE = '22023';
  END IF;
  INSERT INTO access.permission_epoch AS e (workspace_id, epoch_kind, subject_id, epoch)
    VALUES (ws, p_kind, p_subject, 1)
    ON CONFLICT (workspace_id, epoch_kind, subject_id)
    DO UPDATE SET epoch = e.epoch + 1, bumped_at = now();
END $$;
REVOKE ALL ON FUNCTION access.bump_permission_epoch(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access.bump_permission_epoch(text, uuid) TO app_rw, app_worker;

-- ---------------------------------------------------------------------------------------------
-- Discovery for the trigger sweep (ids only): workspaces with a due date or schedule trigger.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON automation.trigger_schedule FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, next_due_at) ON automation.trigger_schedule TO pm_scheduler;

CREATE FUNCTION exec_dispatch.discover_automation_due(p_now timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.workspace_id FROM automation.trigger_schedule s
   WHERE s.next_due_at <= p_now
   GROUP BY s.workspace_id
   ORDER BY min(s.next_due_at), s.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_automation_due(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_automation_due(timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_automation_due(timestamptz, integer) OWNER TO pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants. Configuration is written by the API; runs, steps, schedules,
-- and usage by both (manual runs and previews start in the API, triggers and steps run in the
-- worker). Nothing is deleted by an application role except the worker's purge hooks.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE automation.automation ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation.automation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation.automation
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE automation.automation_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation.automation_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation.automation_revision
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE automation.automation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation.automation_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation.automation_run
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE automation.automation_step_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation.automation_step_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation.automation_step_run
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE automation.standing_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation.standing_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation.standing_approval
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE automation.trigger_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation.trigger_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation.trigger_schedule
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE automation.usage_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation.usage_period FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation.usage_period
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON automation.automation, automation.automation_revision, automation.automation_run,
  automation.automation_step_run, automation.standing_approval, automation.trigger_schedule,
  automation.usage_period FROM PUBLIC;
REVOKE ALL ON FUNCTION automation.revision_immutable() FROM PUBLIC;

GRANT SELECT, INSERT ON automation.automation, automation.automation_revision TO app_rw;
GRANT UPDATE (name, description, owner_membership_id, enabled, active_revision_id, trigger_kind, trigger_event,
  activated_at, draft, draft_base_revision, suspended_reason, suspended_at, active_runs, consecutive_failures, alerted_at,
  lifecycle_state, updated_by_membership_id, updated_at, version) ON automation.automation TO app_rw;
GRANT SELECT ON automation.automation, automation.automation_revision TO app_worker;
GRANT UPDATE (enabled, suspended_reason, suspended_at, active_runs, consecutive_failures, alerted_at,
  trigger_kind, trigger_event, lifecycle_state, updated_at, version) ON automation.automation TO app_worker;
GRANT DELETE ON automation.automation, automation.automation_revision TO app_worker;

GRANT SELECT, INSERT, UPDATE ON automation.automation_run, automation.automation_step_run,
  automation.trigger_schedule, automation.usage_period TO app_rw, app_worker;
GRANT DELETE ON automation.automation_run, automation.automation_step_run, automation.trigger_schedule
  TO app_rw, app_worker;
GRANT SELECT, INSERT ON automation.standing_approval TO app_rw;
GRANT UPDATE (state, ended_at) ON automation.standing_approval TO app_rw, app_worker;
GRANT SELECT ON automation.standing_approval TO app_worker;
GRANT DELETE ON automation.standing_approval TO app_worker;
