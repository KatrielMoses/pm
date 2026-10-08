-- migrate:phase expand
-- Phase 5A (0B ADR-36, 0C AZ-36, 0D PL-38; ADR-0028): permission-aware search. The index is a
-- derived projection of records the product already owns: one entry per searchable source row,
-- holding only the text a viewer of that record may read (never custom field values, never a
-- draft, never a restricted reference label). An entry grants nothing: every query joins the
-- entry to the core.record whose authority governs it and applies the one compiled visibility
-- predicate (0C 4.5) before matching, ranking, counting, faceting, and snippeting. Indexing is a
-- queue of keys (no content) written by triggers in the source's own transaction, drained by the
-- worker in bounded, retryable steps; a source row that cannot be indexed stays visible as a
-- failed task. Recent searches are personal, bounded, and erasable.

CREATE SCHEMA search;
REVOKE ALL ON SCHEMA search FROM PUBLIC;
GRANT USAGE ON SCHEMA search TO app_rw, app_worker, pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Entries. `source_kind` is the name a registered source adapter uses (the database checks only
-- its shape: a later phase registers a new adapter without a schema change). `auth_record_id` is
-- the record whose access decides who may see the entry (the host for a comment, a file, or a
-- deliverable); `context_record_id` is the record that opens it in context, shown only when the
-- viewer may also read that record.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE search.entry (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  auth_record_id uuid NOT NULL,
  context_record_id uuid,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  owner_membership_id uuid,
  source_updated_at timestamptz NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  -- ASCII punctuation separates words on both sides (the query is split by the same rule), so a
  -- file name such as `report.final.pdf` is found by `report`. Two configurations are indexed
  -- together (DQ-24): `simple` (no stemming or stop words, so any language is found, and prefixes
  -- match as the person types) and `english` (stemmed, so "running" finds "run").
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig, regexp_replace(title, '[\s!-/:-@\[-`{-~]+', ' ', 'g')), 'A') ||
    setweight(to_tsvector('english'::regconfig, regexp_replace(title, '[\s!-/:-@\[-`{-~]+', ' ', 'g')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, regexp_replace(body, '[\s!-/:-@\[-`{-~]+', ' ', 'g')), 'B') ||
    setweight(to_tsvector('english'::regconfig, regexp_replace(body, '[\s!-/:-@\[-`{-~]+', ' ', 'g')), 'B')
  ) STORED,
  CONSTRAINT entry_pkey PRIMARY KEY (workspace_id, source_kind, source_id),
  CONSTRAINT entry_auth_fkey FOREIGN KEY (workspace_id, auth_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT entry_context_fkey FOREIGN KEY (workspace_id, context_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE SET NULL (context_record_id),
  CONSTRAINT entry_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE SET NULL (owner_membership_id),
  CONSTRAINT entry_kind_shape CHECK (source_kind ~ '^[a-z][a-z_]{1,30}$'),
  CONSTRAINT entry_title_length CHECK (char_length(title) BETWEEN 1 AND 500),
  CONSTRAINT entry_body_length CHECK (char_length(body) <= 100000)
);
CREATE INDEX entry_tsv ON search.entry USING gin (tsv);
CREATE INDEX entry_by_auth ON search.entry (workspace_id, auth_record_id);
CREATE INDEX entry_by_context ON search.entry (workspace_id, context_record_id);
CREATE INDEX entry_by_owner ON search.entry (workspace_id, owner_membership_id);
COMMENT ON TABLE search.entry IS 'Derived search projection (ADR-0028). Grants nothing: every read joins the governing record and applies the compiled visibility predicate. Rebuildable from the sources at any time.';

-- ---------------------------------------------------------------------------------------------
-- The indexing queue: keys only, never content. `pending` is waiting to be indexed; `failed`
-- means the allowed attempts were used up (it is retried slowly and shown, never hidden).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE search.index_task (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  auth_record_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  failure_code text,
  CONSTRAINT index_task_pkey PRIMARY KEY (workspace_id, source_kind, source_id),
  CONSTRAINT index_task_auth_fkey FOREIGN KEY (workspace_id, auth_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT index_task_kind_shape CHECK (source_kind ~ '^[a-z][a-z_]{1,30}$'),
  CONSTRAINT index_task_state_known CHECK (state IN ('pending', 'failed')),
  CONSTRAINT index_task_attempts CHECK (attempts >= 0),
  CONSTRAINT index_task_failure_shape CHECK (
    failure_code IS NULL OR failure_code IN ('source_error', 'invalid_content', 'timeout', 'unknown_source'))
);
CREATE INDEX index_task_due ON search.index_task (next_attempt_at);
CREATE INDEX index_task_by_state ON search.index_task (workspace_id, state, next_attempt_at);
CREATE INDEX index_task_by_auth ON search.index_task (workspace_id, auth_record_id);

-- ---------------------------------------------------------------------------------------------
-- Recent searches: the person's own typed queries (personal data, never audited, never copied to
-- events). Filters name brands and projects by public identifier; they are checked again when
-- listed, so a recent search never reveals a place the person can no longer see.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE search.recent_query (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  query text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  query_key text NOT NULL,
  search_count integer NOT NULL DEFAULT 1,
  searched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recent_query_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT recent_query_key UNIQUE (workspace_id, owner_membership_id, query_key),
  CONSTRAINT recent_query_text CHECK (char_length(query) BETWEEN 1 AND 200),
  CONSTRAINT recent_query_filters CHECK (jsonb_typeof(filters) = 'object' AND octet_length(filters::text) <= 2000),
  CONSTRAINT recent_query_key_length CHECK (char_length(query_key) BETWEEN 1 AND 300),
  CONSTRAINT recent_query_count CHECK (search_count >= 1)
);
CREATE INDEX recent_query_by_owner ON search.recent_query (workspace_id, owner_membership_id, searched_at DESC);
CREATE INDEX recent_query_expiry ON search.recent_query (searched_at);

-- ---------------------------------------------------------------------------------------------
-- Triggers: a source change queues its key in the same transaction (so the change and its
-- queue entry commit together or not at all); a deleted source, and a purged record, remove the
-- entries at once. They run as the owner so every writer of a source table (API, worker,
-- lifecycle purge) is covered without a grant on the queue; they write keys and delete only.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION search.source_changed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_kind text;
  v_id uuid;
  v_auth uuid;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'task' THEN v_kind := 'task'; v_id := NEW.id; v_auth := NEW.id;
    WHEN 'project' THEN v_kind := 'project'; v_id := NEW.id; v_auth := NEW.id;
    WHEN 'milestone' THEN v_kind := 'milestone'; v_id := NEW.id; v_auth := NEW.id;
    WHEN 'decision_record' THEN v_kind := 'decision_record'; v_id := NEW.id; v_auth := NEW.id;
    WHEN 'document' THEN v_kind := 'document'; v_id := NEW.id; v_auth := NEW.id;
    WHEN 'comment' THEN v_kind := 'comment'; v_id := NEW.id; v_auth := NEW.host_record_id;
    WHEN 'file' THEN
      v_kind := 'file'; v_id := NEW.id;
      v_auth := CASE WHEN NEW.host_kind = 'workspace' THEN NEW.id ELSE NEW.host_record_id END;
    WHEN 'deliverable' THEN v_kind := 'deliverable'; v_id := NEW.id; v_auth := NEW.task_id;
    WHEN 'deliverable_version' THEN
      v_kind := 'deliverable'; v_id := NEW.deliverable_id;
      SELECT d.task_id INTO v_auth FROM files.deliverable d
       WHERE d.workspace_id = NEW.workspace_id AND d.id = NEW.deliverable_id;
    ELSE RAISE EXCEPTION 'search.source_changed: unregistered table %', TG_TABLE_NAME;
  END CASE;
  IF v_auth IS NULL THEN RETURN NULL; END IF;
  INSERT INTO search.index_task (workspace_id, source_kind, source_id, auth_record_id)
  VALUES (NEW.workspace_id, v_kind, v_id, v_auth)
  ON CONFLICT (workspace_id, source_kind, source_id) DO UPDATE
    SET auth_record_id = EXCLUDED.auth_record_id, state = 'pending', attempts = 0,
        requested_at = now(), next_attempt_at = now(), failure_code = NULL;
  RETURN NULL;
END $$;

CREATE FUNCTION search.source_removed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Every registered source table is named for its source kind.
  DELETE FROM search.entry WHERE workspace_id = OLD.workspace_id AND source_kind = TG_TABLE_NAME AND source_id = OLD.id;
  DELETE FROM search.index_task WHERE workspace_id = OLD.workspace_id AND source_kind = TG_TABLE_NAME AND source_id = OLD.id;
  RETURN NULL;
END $$;

-- A purged record leaves nothing behind: its own entry and every entry it hosts (comments, files,
-- deliverables, milestones) go in the same statement that tombstones it.
CREATE FUNCTION search.record_purged() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM search.entry WHERE workspace_id = NEW.workspace_id
    AND (auth_record_id = NEW.id OR context_record_id = NEW.id OR source_id = NEW.id);
  DELETE FROM search.index_task WHERE workspace_id = NEW.workspace_id
    AND (auth_record_id = NEW.id OR source_id = NEW.id);
  RETURN NULL;
END $$;

CREATE TRIGGER search_changed AFTER INSERT OR UPDATE OF title, description_rich ON work.task
  FOR EACH ROW EXECUTE FUNCTION search.source_changed();
CREATE TRIGGER search_changed AFTER INSERT OR UPDATE OF name, description_rich ON work.project
  FOR EACH ROW EXECUTE FUNCTION search.source_changed();
CREATE TRIGGER search_changed AFTER INSERT OR UPDATE OF name ON work.milestone
  FOR EACH ROW EXECUTE FUNCTION search.source_changed();
CREATE TRIGGER search_changed AFTER INSERT OR UPDATE OF statement, outcome ON work.decision_record
  FOR EACH ROW EXECUTE FUNCTION search.source_changed();
CREATE TRIGGER search_changed AFTER INSERT OR UPDATE OF title, current_version_id ON knowledge.document
  FOR EACH ROW EXECUTE FUNCTION search.source_changed();
CREATE TRIGGER search_changed AFTER INSERT OR UPDATE OF body_text, deleted_at ON collab.comment
  FOR EACH ROW EXECUTE FUNCTION search.source_changed();
CREATE TRIGGER search_changed AFTER INSERT OR UPDATE OF name ON files.file
  FOR EACH ROW EXECUTE FUNCTION search.source_changed();
CREATE TRIGGER search_changed AFTER INSERT OR UPDATE OF title ON files.deliverable
  FOR EACH ROW EXECUTE FUNCTION search.source_changed();
CREATE TRIGGER search_changed AFTER INSERT ON files.deliverable_version
  FOR EACH ROW EXECUTE FUNCTION search.source_changed();

CREATE TRIGGER search_removed AFTER DELETE ON work.task
  FOR EACH ROW EXECUTE FUNCTION search.source_removed();
CREATE TRIGGER search_removed AFTER DELETE ON work.project
  FOR EACH ROW EXECUTE FUNCTION search.source_removed();
CREATE TRIGGER search_removed AFTER DELETE ON work.milestone
  FOR EACH ROW EXECUTE FUNCTION search.source_removed();
CREATE TRIGGER search_removed AFTER DELETE ON work.decision_record
  FOR EACH ROW EXECUTE FUNCTION search.source_removed();
CREATE TRIGGER search_removed AFTER DELETE ON knowledge.document
  FOR EACH ROW EXECUTE FUNCTION search.source_removed();
CREATE TRIGGER search_removed AFTER DELETE ON collab.comment
  FOR EACH ROW EXECUTE FUNCTION search.source_removed();
CREATE TRIGGER search_removed AFTER DELETE ON files.file
  FOR EACH ROW EXECUTE FUNCTION search.source_removed();
CREATE TRIGGER search_removed AFTER DELETE ON files.deliverable
  FOR EACH ROW EXECUTE FUNCTION search.source_removed();

CREATE TRIGGER search_purged AFTER UPDATE OF lifecycle_state ON core.record
  FOR EACH ROW WHEN (NEW.lifecycle_state = 'purged' AND OLD.lifecycle_state <> 'purged')
  EXECUTE FUNCTION search.record_purged();

-- Existing rows are queued once, so the first worker runs index everything already there.
INSERT INTO search.index_task (workspace_id, source_kind, source_id, auth_record_id)
SELECT workspace_id, 'task', id, id FROM work.task
UNION ALL SELECT workspace_id, 'project', id, id FROM work.project
UNION ALL SELECT workspace_id, 'milestone', id, id FROM work.milestone
UNION ALL SELECT workspace_id, 'decision_record', id, id FROM work.decision_record
UNION ALL SELECT workspace_id, 'document', id, id FROM knowledge.document
UNION ALL SELECT workspace_id, 'comment', id, host_record_id FROM collab.comment WHERE deleted_at IS NULL
UNION ALL SELECT workspace_id, 'file', id, CASE WHEN host_kind = 'workspace' THEN id ELSE host_record_id END FROM files.file
UNION ALL SELECT workspace_id, 'deliverable', id, task_id FROM files.deliverable
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- Worker discovery: workspaces with queued keys that are due, or recent searches past retention.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON search.index_task FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, next_attempt_at) ON search.index_task TO pm_scheduler;
CREATE POLICY scheduler_discovery ON search.recent_query FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, searched_at) ON search.recent_query TO pm_scheduler;

CREATE FUNCTION exec_dispatch.discover_search_work(p_now timestamptz, p_retention_before timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.workspace_id FROM (
    SELECT t.workspace_id, min(t.next_attempt_at) AS due FROM search.index_task t
     WHERE t.next_attempt_at <= p_now
     GROUP BY t.workspace_id
    UNION ALL
    SELECT q.workspace_id, min(q.searched_at) FROM search.recent_query q
     WHERE q.searched_at < p_retention_before
     GROUP BY q.workspace_id
  ) w
  GROUP BY w.workspace_id
  ORDER BY min(w.due), w.workspace_id
  LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_search_work(timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_search_work(timestamptz, timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_search_work(timestamptz, timestamptz, integer) OWNER TO pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE search.entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE search.entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON search.entry
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE search.index_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE search.index_task FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON search.index_task
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE search.recent_query ENABLE ROW LEVEL SECURITY;
ALTER TABLE search.recent_query FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON search.recent_query
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON search.entry, search.index_task, search.recent_query FROM PUBLIC;
-- The API reads entries and queue state (search and its status); only the worker writes them.
GRANT SELECT ON search.entry, search.index_task TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON search.entry, search.index_task TO app_worker;
-- Recent searches: the person's own rows, written by the API, swept by retention in the worker.
GRANT SELECT, INSERT, UPDATE, DELETE ON search.recent_query TO app_rw;
GRANT SELECT, DELETE ON search.recent_query TO app_worker;
