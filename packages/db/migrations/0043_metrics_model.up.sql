-- migrate:phase expand
-- Phase 5C (0B ADR-38, 0C AZ-38, 0D PL-40; ADR-0030): the metrics model. Almost every metric is
-- computed live from the records the product already owns, for the one person asking, so a count
-- always equals the records behind it and never lags them. What cannot be recomputed from current
-- state is how long a task spent in each status; this migration records that as an append-only
-- ledger written by a trigger in the task's own transaction. It stores a status category and two
-- timestamps per span and nothing else: no brand, project, lifecycle, or permission copy (every
-- read joins the task's core.record and applies the one compiled visibility predicate, 0C 4.5).
-- A bounded, resumable reconciliation job checks the ledger against the tasks and repairs drift
-- (a write path that bypassed the trigger, a restore); its state is visible, never hidden.

CREATE SCHEMA metrics;
REVOKE ALL ON SCHEMA metrics FROM PUBLIC;
GRANT USAGE ON SCHEMA metrics TO app_rw, app_worker, pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Status history. `recorded` spans were written as the change happened; `assumed` spans were
-- created for tasks that existed before this ledger (one span in the status they had, with the
-- completion time when they were already done), so how long they spent earlier is unknown and a
-- metric that needs it says so; `repaired` spans were written by reconciliation when the ledger
-- disagreed with the task (they start when the disagreement was found, never backdated).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE metrics.task_status_span (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  task_id uuid NOT NULL,
  seq integer NOT NULL,
  status_id uuid NOT NULL,
  status_category text NOT NULL,
  entered_at timestamptz NOT NULL,
  left_at timestamptz,
  basis text NOT NULL DEFAULT 'recorded',
  CONSTRAINT task_status_span_pkey PRIMARY KEY (workspace_id, task_id, seq),
  -- Deferred: a task and its record may be written in either order within one transaction.
  CONSTRAINT task_status_span_task_fkey FOREIGN KEY (workspace_id, task_id)
    REFERENCES core.record (workspace_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT task_status_span_seq CHECK (seq >= 1),
  CONSTRAINT task_status_span_category CHECK (status_category IN ('planned', 'active', 'paused', 'done', 'cancelled')),
  CONSTRAINT task_status_span_basis CHECK (basis IN ('recorded', 'assumed', 'repaired')),
  CONSTRAINT task_status_span_order CHECK (left_at IS NULL OR left_at >= entered_at)
);
-- One open span per task: the status the task is in now.
CREATE UNIQUE INDEX task_status_span_open ON metrics.task_status_span (workspace_id, task_id) WHERE left_at IS NULL;
CREATE INDEX task_status_span_by_entered ON metrics.task_status_span (workspace_id, status_category, entered_at);
COMMENT ON TABLE metrics.task_status_span IS 'Append-only task status history (ADR-0030). Grants nothing: every read joins the task record and applies the compiled visibility predicate.';

-- ---------------------------------------------------------------------------------------------
-- Reconciliation state, one row per workspace: when the next bounded pass is due, where a pass
-- stopped (a keyset position, so a long pass resumes instead of restarting), and why the last
-- pass failed. It holds times, counts, and a short code, never record content.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE metrics.reconcile_state (
  workspace_id uuid PRIMARY KEY REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  scan_after uuid,
  pass_started_at timestamptz,
  pass_repaired integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_code text,
  repaired_total bigint NOT NULL DEFAULT 0,
  CONSTRAINT reconcile_state_attempts CHECK (attempts >= 0),
  CONSTRAINT reconcile_state_repaired CHECK (pass_repaired >= 0 AND repaired_total >= 0),
  CONSTRAINT reconcile_state_failure_shape CHECK (failure_code IS NULL OR failure_code IN ('source_error', 'timeout'))
);
CREATE INDEX reconcile_state_due ON metrics.reconcile_state (next_run_at);

-- ---------------------------------------------------------------------------------------------
-- Triggers: a task's creation opens its first span; a change of status or status category closes
-- the open span and opens the next, in the same transaction (so the change and its history commit
-- together or not at all). They run as the owner so every writer of a task (API, worker, lifecycle,
-- import) is covered without a grant on the ledger.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION metrics.task_changed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_open metrics.task_status_span%ROWTYPE;
  v_at timestamptz := now();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO metrics.task_status_span (workspace_id, task_id, seq, status_id, status_category, entered_at, basis)
    VALUES (NEW.workspace_id, NEW.id, 1, NEW.status_id, NEW.status_category, least(NEW.created_at, v_at), 'recorded');
    INSERT INTO metrics.reconcile_state (workspace_id) VALUES (NEW.workspace_id) ON CONFLICT DO NOTHING;
    RETURN NULL;
  END IF;
  SELECT * INTO v_open FROM metrics.task_status_span
   WHERE workspace_id = NEW.workspace_id AND task_id = NEW.id AND left_at IS NULL FOR UPDATE;
  IF FOUND THEN
    IF v_open.status_id = NEW.status_id AND v_open.status_category = NEW.status_category THEN RETURN NULL; END IF;
    UPDATE metrics.task_status_span SET left_at = greatest(v_at, v_open.entered_at)
     WHERE workspace_id = NEW.workspace_id AND task_id = NEW.id AND seq = v_open.seq;
    INSERT INTO metrics.task_status_span (workspace_id, task_id, seq, status_id, status_category, entered_at, basis)
    VALUES (NEW.workspace_id, NEW.id, v_open.seq + 1, NEW.status_id, NEW.status_category, greatest(v_at, v_open.entered_at), 'recorded');
  ELSE
    INSERT INTO metrics.task_status_span (workspace_id, task_id, seq, status_id, status_category, entered_at, basis)
    SELECT NEW.workspace_id, NEW.id, COALESCE(max(seq), 0) + 1, NEW.status_id, NEW.status_category,
           greatest(v_at, COALESCE(max(left_at), v_at)), 'repaired'
      FROM metrics.task_status_span WHERE workspace_id = NEW.workspace_id AND task_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION metrics.task_removed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM metrics.task_status_span WHERE workspace_id = OLD.workspace_id AND task_id = OLD.id;
  RETURN NULL;
END $$;

-- A purged record leaves nothing behind: its history goes in the same statement that tombstones it.
CREATE FUNCTION metrics.record_purged() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM metrics.task_status_span WHERE workspace_id = NEW.workspace_id AND task_id = NEW.id;
  RETURN NULL;
END $$;

CREATE TRIGGER metrics_created AFTER INSERT ON work.task
  FOR EACH ROW EXECUTE FUNCTION metrics.task_changed();
CREATE TRIGGER metrics_status AFTER UPDATE OF status_id, status_category ON work.task
  FOR EACH ROW WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id OR OLD.status_category IS DISTINCT FROM NEW.status_category)
  EXECUTE FUNCTION metrics.task_changed();
CREATE TRIGGER metrics_removed AFTER DELETE ON work.task
  FOR EACH ROW EXECUTE FUNCTION metrics.task_removed();
CREATE TRIGGER metrics_purged AFTER UPDATE OF lifecycle_state ON core.record
  FOR EACH ROW WHEN (NEW.lifecycle_state = 'purged' AND OLD.lifecycle_state <> 'purged')
  EXECUTE FUNCTION metrics.record_purged();

-- Tasks that already exist get one assumed span in the status they have: a finished task keeps
-- its completion time, any other task is taken to have been in that status since it was created.
-- Metrics that need the time spent earlier report these tasks as incomplete instead of guessing.
-- The task table forces tenant row-level security even on its owner, so the migration role would
-- read no rows; the force is lifted for this one read inside the migration transaction and set
-- again straight after (the catalog comparison in the migration test proves it is restored). The
-- new tables have no row-level security yet at this point.
ALTER TABLE work.task NO FORCE ROW LEVEL SECURITY;
INSERT INTO metrics.task_status_span (workspace_id, task_id, seq, status_id, status_category, entered_at, basis)
SELECT t.workspace_id, t.id, 1, t.status_id, t.status_category,
       CASE WHEN t.status_category = 'done' AND t.completed_at IS NOT NULL THEN t.completed_at ELSE t.created_at END,
       'assumed'
  FROM work.task t;
INSERT INTO metrics.reconcile_state (workspace_id)
SELECT DISTINCT t.workspace_id FROM work.task t
ON CONFLICT DO NOTHING;
-- The deferred foreign key checks of the rows just written run now, before the tables are altered.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE work.task FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------
-- Worker discovery: workspaces whose reconciliation pass is due and not leased.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON metrics.reconcile_state FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, next_run_at, lease_until) ON metrics.reconcile_state TO pm_scheduler;

CREATE FUNCTION exec_dispatch.discover_metrics_work(p_now timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.workspace_id FROM metrics.reconcile_state s
   WHERE s.next_run_at <= p_now AND (s.lease_until IS NULL OR s.lease_until <= p_now)
   ORDER BY s.next_run_at, s.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_metrics_work(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_metrics_work(timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_metrics_work(timestamptz, integer) OWNER TO pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE metrics.task_status_span ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.task_status_span FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metrics.task_status_span
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE metrics.reconcile_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.reconcile_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metrics.reconcile_state
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON metrics.task_status_span, metrics.reconcile_state FROM PUBLIC;
-- The API reads history and reconciliation state, and may only ask for a pass sooner; the worker
-- writes both.
GRANT SELECT ON metrics.task_status_span, metrics.reconcile_state TO app_rw;
GRANT UPDATE (next_run_at) ON metrics.reconcile_state TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON metrics.task_status_span, metrics.reconcile_state TO app_worker;
