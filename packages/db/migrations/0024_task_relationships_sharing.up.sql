-- migrate:phase expand
-- Phase 2B task relationships and sharing (0B ADR-22, 0C AZ-22): canonical record links (safe https
-- URLs now; record targets once their type exists), the guarded cross-brand task move, the
-- assignee departure guard, and the containment adapters the 1F lifecycle needs. Task shares use
-- the existing exact-record grants; the shareability registry is application code (one registry).

-- ---------------------------------------------------------------------------------------------
-- Record links (0B relations.record_link): URL or record targets, ordered per source record.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE relations.record_link (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  source_record_id uuid NOT NULL,
  target_kind text NOT NULL,
  url text,
  target_record_id uuid,
  title text,
  rank text COLLATE "C" NOT NULL,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT record_link_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT record_link_public_id_format CHECK (public_id ~ '^lnk_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT record_link_source_fkey FOREIGN KEY (workspace_id, source_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_link_target_fkey FOREIGN KEY (workspace_id, target_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_link_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_link_kind_known CHECK (target_kind IN ('url', 'record')),
  -- Exactly one target; URLs are normalized https only (the command normalizes first).
  CONSTRAINT record_link_target_shape CHECK (
    (target_kind = 'url' AND url IS NOT NULL AND target_record_id IS NULL
      AND url ~ '^https://[^\s/?#@]+(/[^\s]*)?$' AND char_length(url) <= 2048)
    OR (target_kind = 'record' AND target_record_id IS NOT NULL AND url IS NULL)),
  CONSTRAINT record_link_not_self CHECK (target_record_id IS DISTINCT FROM source_record_id),
  CONSTRAINT record_link_title CHECK (title IS NULL OR (char_length(btrim(title)) BETWEEN 1 AND 200
    AND title = btrim(title) AND tenancy.valid_plain_text(title, 200))),
  CONSTRAINT record_link_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT record_link_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX record_link_by_source ON relations.record_link (workspace_id, source_record_id, rank, id);
CREATE INDEX record_link_by_target ON relations.record_link (workspace_id, target_record_id);
CREATE INDEX record_link_by_creator ON relations.record_link (workspace_id, created_by_membership_id);

ALTER TABLE relations.record_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE relations.record_link FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON relations.record_link
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
REVOKE ALL ON relations.record_link FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON relations.record_link TO app_rw;
GRANT UPDATE (title, rank, updated_at, version) ON relations.record_link TO app_rw;
GRANT SELECT, DELETE ON relations.record_link TO app_worker;

-- ---------------------------------------------------------------------------------------------
-- Cross-brand task moves (OD-02). A record's brand is otherwise immutable; the only exception is a
-- task moved by work.move_task_brand, which the guard recognises by its definer identity.
-- ---------------------------------------------------------------------------------------------
-- Task-scoped rows follow their task's brand in the same statement.
ALTER TABLE work.task_assignee DROP CONSTRAINT task_assignee_task_fkey;
ALTER TABLE work.task_assignee ADD CONSTRAINT task_assignee_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
  REFERENCES work.task (workspace_id, brand_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE work.checklist_item DROP CONSTRAINT checklist_item_task_fkey;
ALTER TABLE work.checklist_item ADD CONSTRAINT checklist_item_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
  REFERENCES work.task (workspace_id, brand_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE work.criteria_item DROP CONSTRAINT criteria_item_task_fkey;
ALTER TABLE work.criteria_item ADD CONSTRAINT criteria_item_task_fkey FOREIGN KEY (workspace_id, brand_id, task_id)
  REFERENCES work.task (workspace_id, brand_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION work.move_task_brand(p_tasks uuid[], p_brand uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ws uuid := exec.current_workspace_id();
  n integer;
BEGIN
  IF ws IS NULL OR p_brand IS NULL OR cardinality(p_tasks) = 0
     OR NOT EXISTS (SELECT 1 FROM tenancy.brand b WHERE b.workspace_id = ws AND b.id = p_brand AND b.lifecycle_state = 'active')
     OR EXISTS (SELECT 1 FROM unnest(p_tasks) AS x(id) LEFT JOIN core.record r ON r.workspace_id = ws AND r.id = x.id
                 WHERE r.id IS NULL OR r.record_type <> 'task' OR r.lifecycle_state <> 'active')
     OR EXISTS (SELECT 1 FROM unnest(p_tasks) AS x(id) LEFT JOIN work.task t ON t.workspace_id = ws AND t.id = x.id
                 WHERE t.id IS NULL OR t.brand_id <> p_brand) THEN
    RAISE EXCEPTION 'move the task rows to an active brand of this workspace first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.record SET brand_id = p_brand, version = version + 1
   WHERE workspace_id = ws AND id = ANY(p_tasks) AND brand_id <> p_brand;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Relationships keep both endpoints' brands for hidden-endpoint filtering (0B §3.5).
  UPDATE relations.record_relationship SET from_brand_id = p_brand
   WHERE workspace_id = ws AND from_record_id = ANY(p_tasks);
  UPDATE relations.record_relationship SET to_brand_id = p_brand
   WHERE workspace_id = ws AND to_record_id = ANY(p_tasks);
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION work.move_task_brand(uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.move_task_brand(uuid[], uuid) TO app_rw;

CREATE OR REPLACE FUNCTION core.record_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only the final tombstone sweep (a retention hook, disabled while its period is unset).
    IF OLD.lifecycle_state <> 'purged' THEN
      RAISE EXCEPTION 'only tombstones may be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.public_id <> OLD.public_id OR NEW.record_type <> OLD.record_type
     OR NEW.workspace_id <> OLD.workspace_id
     OR NEW.created_at <> OLD.created_at OR NEW.created_by_actor_type <> OLD.created_by_actor_type
     OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id THEN
    RAISE EXCEPTION 'record identity and scope are immutable' USING ERRCODE = 'check_violation';
  END IF;
  -- Phase 2B: only work.move_task_brand (as its definer) moves a task to another brand.
  IF NEW.brand_id IS DISTINCT FROM OLD.brand_id AND NOT (
       NEW.record_type = 'task' AND OLD.brand_id IS NOT NULL AND NEW.brand_id IS NOT NULL
       AND current_user = (SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                            WHERE p.oid = 'work.move_task_brand(uuid[], uuid)'::regprocedure)) THEN
    RAISE EXCEPTION 'record identity and scope are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.lifecycle_state = 'purged' THEN
    RAISE EXCEPTION 'tombstones are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lifecycle_state <> OLD.lifecycle_state AND NOT (
       (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state IN ('archived', 'trashed'))
    OR (OLD.lifecycle_state = 'archived' AND NEW.lifecycle_state IN ('active', 'trashed'))
    OR (OLD.lifecycle_state = 'trashed' AND NEW.lifecycle_state IN ('active', 'archived', 'purged'))) THEN
    RAISE EXCEPTION 'lifecycle transition % -> % is not allowed', OLD.lifecycle_state, NEW.lifecycle_state
      USING ERRCODE = 'check_violation';
  END IF;
  -- A trashed record is only ever (re)assigned to a batch that is still trashed.
  IF NEW.lifecycle_state = 'trashed' AND NEW.deletion_batch_id IS DISTINCT FROM OLD.deletion_batch_id
     AND NOT EXISTS (SELECT 1 FROM core.deletion_batch b
                     WHERE b.workspace_id = NEW.workspace_id AND b.id = NEW.deletion_batch_id AND b.state = 'trashed') THEN
    RAISE EXCEPTION 'trashed records belong to a trashed batch' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'record version must increase by one' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Assignees never outlive membership (0C AZ-22): a removed member keeps no assignment at commit.
-- The departure hook removes them first; this is the backstop.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION work.assert_departing_assignee() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.state = 'removed' AND OLD.state <> 'removed' AND EXISTS (
      SELECT 1 FROM work.task_assignee a WHERE a.workspace_id = NEW.workspace_id AND a.membership_id = NEW.id) THEN
    RAISE EXCEPTION 'a removed member cannot remain assigned to tasks' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER task_assignee_on_membership AFTER UPDATE OF state ON tenancy.membership
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION work.assert_departing_assignee();
REVOKE ALL ON FUNCTION work.assert_departing_assignee() FROM PUBLIC;
