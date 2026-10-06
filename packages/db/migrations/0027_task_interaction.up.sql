-- migrate:phase expand
-- Phase 2D: task interaction quality (0B ADR-24, ADR-0016).
-- Task origin (closed kinds, immutable), trigger-maintained freshness (OD-17), recurring tasks on
-- the planning series, task templates, and personal reminders and snoozes. No 3C work-block or 4B
-- delivery-channel tables.

-- ---------------------------------------------------------------------------------------------
-- Task origin and recurrence identity
-- ---------------------------------------------------------------------------------------------
ALTER TABLE work.task ADD COLUMN origin_kind text NOT NULL DEFAULT 'manual';
ALTER TABLE work.task ADD COLUMN origin_ref jsonb NOT NULL DEFAULT '{}';
ALTER TABLE work.task ADD COLUMN recurrence_series_id uuid;
ALTER TABLE work.task ADD COLUMN occurrence_key text;
ALTER TABLE work.task ADD COLUMN last_meaningful_update_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE work.task ADD CONSTRAINT task_origin_known CHECK (origin_kind IN
  ('manual', 'recurring', 'template', 'intake', 'import', 'integration', 'ai_draft'));
-- Safe metadata only: an object of at most eight short public identifiers or numbers.
ALTER TABLE work.task ADD CONSTRAINT task_origin_ref_shape CHECK (jsonb_typeof(origin_ref) = 'object'
  AND pg_column_size(origin_ref) <= 1024);
ALTER TABLE work.task ADD CONSTRAINT task_occurrence_shape CHECK ((recurrence_series_id IS NULL) = (occurrence_key IS NULL)
  AND (occurrence_key IS NULL OR char_length(occurrence_key) BETWEEN 1 AND 40)
  AND (recurrence_series_id IS NULL OR origin_kind = 'recurring'));
ALTER TABLE work.task ADD CONSTRAINT task_recurrence_series_fkey FOREIGN KEY (workspace_id, recurrence_series_id)
  REFERENCES planning.recurrence_series (workspace_id, id) ON DELETE RESTRICT;
CREATE INDEX task_by_recurrence ON work.task (workspace_id, recurrence_series_id);
CREATE UNIQUE INDEX task_occurrence_unique ON work.task (workspace_id, recurrence_series_id, occurrence_key)
  WHERE recurrence_series_id IS NOT NULL;
-- Deterministic duplicate matching (normalized title within a brand, recent nonterminal tasks).
CREATE INDEX task_duplicate_probe ON work.task (workspace_id, brand_id, (lower(regexp_replace(title, '\s+', ' ', 'g'))), created_at DESC)
  WHERE status_category NOT IN ('done', 'cancelled');
-- Freshness signals scan a brand's open tasks by their last meaningful update.
CREATE INDEX task_by_freshness ON work.task (workspace_id, brand_id, last_meaningful_update_at)
  WHERE status_category IN ('planned', 'active', 'paused');

-- Origin and occurrence identity never change after insert. Grants exclude these columns too; a
-- registered data migration (run by the owner) disables this trigger inside its own transaction.
CREATE FUNCTION work.task_origin_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.origin_kind IS DISTINCT FROM OLD.origin_kind OR NEW.origin_ref IS DISTINCT FROM OLD.origin_ref
     OR NEW.recurrence_series_id IS DISTINCT FROM OLD.recurrence_series_id
     OR NEW.occurrence_key IS DISTINCT FROM OLD.occurrence_key THEN
    RAISE EXCEPTION 'task origin is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER task_origin_immutable BEFORE UPDATE OF origin_kind, origin_ref, recurrence_series_id, occurrence_key
  ON work.task FOR EACH ROW EXECUTE FUNCTION work.task_origin_immutable();

-- ---------------------------------------------------------------------------------------------
-- Freshness (OD-17). A meaningful update: title or description, status, dates, estimate, lifecycle
-- on the task row; assignees, checklist, criteria, labels, links, relationships, and custom field
-- values in content tables; or an explicit manual update (the column itself). Reads, view state,
-- favorites, recents, reminders, snoozes, rank, and priority are not meaningful.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION work.task_freshness() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.last_meaningful_update_at IS DISTINCT FROM OLD.last_meaningful_update_at THEN
    RETURN NEW;
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.description_rich IS DISTINCT FROM OLD.description_rich
     OR NEW.status_id IS DISTINCT FROM OLD.status_id
     OR NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.due_date IS DISTINCT FROM OLD.due_date
     OR NEW.deadline_date IS DISTINCT FROM OLD.deadline_date OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
     OR NEW.estimate_minutes IS DISTINCT FROM OLD.estimate_minutes
     OR NEW.remaining_estimate_minutes IS DISTINCT FROM OLD.remaining_estimate_minutes
     OR NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
    NEW.last_meaningful_update_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER task_freshness BEFORE UPDATE ON work.task
  FOR EACH ROW EXECUTE FUNCTION work.task_freshness();

-- Content tables touch their task. SECURITY DEFINER so the narrow column write needs no grant on
-- the caller; it touches only an active task of the current workspace.
CREATE FUNCTION work.touch_task(p_workspace uuid, p_task uuid) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  UPDATE work.task SET last_meaningful_update_at = now()
   WHERE workspace_id = p_workspace AND p_workspace = exec.current_workspace_id() AND id = p_task
     AND lifecycle_state = 'active' AND last_meaningful_update_at < now()
$$;

CREATE FUNCTION work.task_content_touched() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  CASE TG_TABLE_NAME
    WHEN 'criteria_item' THEN
      IF r.task_id IS NOT NULL THEN PERFORM work.touch_task(r.workspace_id, r.task_id); END IF;
    WHEN 'record_link' THEN
      PERFORM work.touch_task(r.workspace_id, r.source_record_id);
    WHEN 'record_relationship' THEN
      PERFORM work.touch_task(r.workspace_id, r.from_record_id);
      PERFORM work.touch_task(r.workspace_id, r.to_record_id);
    WHEN 'field_value' THEN
      IF NOT r.computed THEN PERFORM work.touch_task(r.workspace_id, r.record_id); END IF;
    ELSE
      PERFORM work.touch_task(r.workspace_id, r.task_id);
  END CASE;
  RETURN NULL;
END
$$;
CREATE TRIGGER task_assignee_freshness AFTER INSERT OR DELETE OR UPDATE OF is_primary ON work.task_assignee
  FOR EACH ROW EXECUTE FUNCTION work.task_content_touched();
CREATE TRIGGER checklist_item_freshness AFTER INSERT OR DELETE OR UPDATE OF text, done ON work.checklist_item
  FOR EACH ROW EXECUTE FUNCTION work.task_content_touched();
CREATE TRIGGER criteria_item_freshness AFTER INSERT OR DELETE OR UPDATE OF text, kind, required, met ON work.criteria_item
  FOR EACH ROW EXECUTE FUNCTION work.task_content_touched();
CREATE TRIGGER task_inherited_criterion_freshness AFTER INSERT OR DELETE OR UPDATE OF state ON work.task_inherited_criterion
  FOR EACH ROW EXECUTE FUNCTION work.task_content_touched();
CREATE TRIGGER task_label_freshness AFTER INSERT OR DELETE ON work.task_label
  FOR EACH ROW EXECUTE FUNCTION work.task_content_touched();
CREATE TRIGGER record_link_freshness AFTER INSERT OR DELETE OR UPDATE OF title ON relations.record_link
  FOR EACH ROW EXECUTE FUNCTION work.task_content_touched();
CREATE TRIGGER record_relationship_freshness AFTER INSERT OR DELETE ON relations.record_relationship
  FOR EACH ROW EXECUTE FUNCTION work.task_content_touched();
CREATE TRIGGER field_value_freshness AFTER INSERT OR DELETE OR UPDATE OF value ON workflow.field_value
  FOR EACH ROW EXECUTE FUNCTION work.task_content_touched();

-- ---------------------------------------------------------------------------------------------
-- Recurring tasks and task templates share the 2A series and template rows.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE planning.recurrence_series ADD COLUMN project_id uuid;
ALTER TABLE planning.recurrence_series DROP CONSTRAINT recurrence_series_target_known;
ALTER TABLE planning.recurrence_series ADD CONSTRAINT recurrence_series_target_known
  CHECK (target_kind IN ('project', 'task'));
ALTER TABLE planning.recurrence_series ADD CONSTRAINT recurrence_series_project_for_tasks
  CHECK (project_id IS NULL OR target_kind = 'task');
ALTER TABLE planning.recurrence_series ADD CONSTRAINT recurrence_series_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
  REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT;
CREATE INDEX recurrence_series_by_project ON planning.recurrence_series (workspace_id, brand_id, project_id);

ALTER TABLE templates.template DROP CONSTRAINT template_target_known;
ALTER TABLE templates.template ADD CONSTRAINT template_target_known CHECK (target_record_type IN ('project', 'task'));

-- ---------------------------------------------------------------------------------------------
-- Personal reminders (TSK-032): never change the task; firing is deduplicated by the state change.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE planning.task_reminder (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  task_id uuid NOT NULL,
  remind_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'scheduled',
  fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT task_reminder_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT task_reminder_key UNIQUE (workspace_id, owner_membership_id, task_id, remind_at),
  CONSTRAINT task_reminder_public_id_format CHECK (public_id ~ '^rem_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT task_reminder_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_reminder_task_fkey FOREIGN KEY (workspace_id, task_id)
    REFERENCES work.task (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_reminder_state_known CHECK (state IN ('scheduled', 'fired', 'dismissed', 'cancelled')),
  -- fired_at is set exactly when the reminder fired (a dismissed reminder may or may not have fired).
  CONSTRAINT task_reminder_fired_shape CHECK ((state <> 'fired' OR fired_at IS NOT NULL)
    AND (state NOT IN ('scheduled', 'cancelled') OR fired_at IS NULL)),
  CONSTRAINT task_reminder_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX task_reminder_due ON planning.task_reminder (remind_at, workspace_id) WHERE state = 'scheduled';
CREATE INDEX task_reminder_by_owner ON planning.task_reminder (workspace_id, owner_membership_id, state, remind_at);
CREATE INDEX task_reminder_by_task ON planning.task_reminder (workspace_id, task_id);

-- Only forward transitions: scheduled → fired | dismissed | cancelled, fired → dismissed.
CREATE FUNCTION planning.task_reminder_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.owner_membership_id <> OLD.owner_membership_id
     OR NEW.task_id <> OLD.task_id OR NEW.public_id <> OLD.public_id THEN
    RAISE EXCEPTION 'reminder identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'scheduled' AND NEW.state IN ('fired', 'dismissed', 'cancelled'))
    OR (OLD.state = 'fired' AND NEW.state = 'dismissed')) THEN
    RAISE EXCEPTION 'reminder state change % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.remind_at <> OLD.remind_at AND OLD.state <> 'scheduled' THEN
    RAISE EXCEPTION 'only a scheduled reminder may move' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER task_reminder_guard BEFORE UPDATE ON planning.task_reminder
  FOR EACH ROW EXECUTE FUNCTION planning.task_reminder_guard();

-- ---------------------------------------------------------------------------------------------
-- Personal snooze (TSK-033): hides a task from its owner's reminder and Today surfaces until an
-- instant. Never changes dates; not a meaningful update.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE planning.task_snooze (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  task_id uuid NOT NULL,
  until_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, owner_membership_id, task_id),
  CONSTRAINT task_snooze_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_snooze_task_fkey FOREIGN KEY (workspace_id, task_id)
    REFERENCES work.task (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_snooze_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX task_snooze_by_task ON planning.task_snooze (workspace_id, task_id);

-- ---------------------------------------------------------------------------------------------
-- Due-reminder discovery (platform scope, identifiers only; same contract as 0022)
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON planning.task_reminder FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, state, remind_at) ON planning.task_reminder TO pm_scheduler;
CREATE FUNCTION exec_dispatch.discover_reminders_due(p_now timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  -- Earliest-due first: a workspace's key is its earliest scheduled reminder, which leaves the
  -- scheduled set when fired, so every due workspace is reached in a bounded number of runs.
  SELECT r.workspace_id FROM planning.task_reminder r
   WHERE r.state = 'scheduled' AND r.remind_at <= p_now
   GROUP BY r.workspace_id
   ORDER BY min(r.remind_at), r.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE planning.task_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning.task_reminder FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON planning.task_reminder
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE planning.task_snooze ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning.task_snooze FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON planning.task_snooze
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON planning.task_reminder, planning.task_snooze FROM PUBLIC;
GRANT SELECT, INSERT ON planning.task_reminder TO app_rw;
GRANT UPDATE (remind_at, state, fired_at, updated_at, version) ON planning.task_reminder TO app_rw;
GRANT SELECT, INSERT, DELETE ON planning.task_snooze TO app_rw;
GRANT UPDATE (until_at, updated_at, version) ON planning.task_snooze TO app_rw;
-- The worker fires or cancels reminders and removes personal rows of purged tasks.
GRANT SELECT, DELETE ON planning.task_reminder, planning.task_snooze TO app_worker;
-- A reminder that falls inside its owner's snooze moves to the snooze's end.
GRANT UPDATE (remind_at, state, fired_at, updated_at, version) ON planning.task_reminder TO app_worker;
-- A manual "mark as updated" is the one direct freshness write.
GRANT UPDATE (last_meaningful_update_at) ON work.task TO app_rw;
GRANT UPDATE (project_id) ON planning.recurrence_series TO app_rw, app_worker;
-- Recurring task occurrences are generated by the worker (record.create is rechecked per step).
GRANT INSERT ON work.task, work.checklist_item, work.task_label, relations.record_link TO app_worker;
GRANT INSERT ON workflow.field_value TO app_worker;

REVOKE ALL ON FUNCTION work.task_origin_immutable(), work.task_freshness(), work.task_content_touched(),
  planning.task_reminder_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.touch_task(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.touch_task(uuid, uuid) TO app_rw, app_worker;
REVOKE ALL ON FUNCTION exec_dispatch.discover_reminders_due(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_reminders_due(timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_reminders_due(timestamptz, integer) OWNER TO pm_scheduler;
