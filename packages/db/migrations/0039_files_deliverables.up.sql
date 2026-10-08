-- migrate:phase expand
-- Phase 4E (0B ADR-34, 0C AZ-34, 0D PL-36; ADR-0026): stored objects (quarantined until a clean
-- scan), files with immutable versions and external links on workspace, brand, project, task, and
-- comment hosts, retry-safe upload sessions, deliverables with submitted versions reviewed through
-- 4A and evidence-locked on acceptance, and per-workspace storage usage. Rows never hold a signed
-- URL or object bytes. No documents, collaborative editing, connectors, or delivery (4C, 4D, 6x, 4B).

CREATE SCHEMA files;
REVOKE ALL ON SCHEMA files FROM PUBLIC;
GRANT USAGE ON SCHEMA files TO app_rw, app_worker;

-- ---------------------------------------------------------------------------------------------
-- Stored objects (FILE-011, FILE-012, FILE-013)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE files.file_object (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  storage_key text NOT NULL UNIQUE,
  quarantined boolean NOT NULL DEFAULT true,
  sha256 bytea NOT NULL,
  byte_size bigint NOT NULL,
  content_type text NOT NULL,
  scan_state text NOT NULL DEFAULT 'pending',
  scan_signature text,
  scan_attempts integer NOT NULL DEFAULT 0,
  scanned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_object_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT file_object_scan_state_known CHECK (scan_state IN ('pending', 'clean', 'infected', 'error')),
  CONSTRAINT file_object_key_shape CHECK (storage_key ~ '^[qo]\.[0-9a-f]{64}$'),
  CONSTRAINT file_object_sha256_length CHECK (octet_length(sha256) = 32),
  CONSTRAINT file_object_size CHECK (byte_size >= 0),
  CONSTRAINT file_object_clean_promoted CHECK (scan_state <> 'clean' OR NOT quarantined),
  CONSTRAINT file_object_key_matches CHECK ((storage_key LIKE 'q.%') = quarantined),
  CONSTRAINT file_object_signature_shape CHECK ((scan_state = 'infected') = (scan_signature IS NOT NULL)),
  CONSTRAINT file_object_scanned_shape CHECK ((scan_state = 'pending') = (scanned_at IS NULL)),
  CONSTRAINT file_object_attempts CHECK (scan_attempts >= 0),
  CONSTRAINT file_object_content_type CHECK (char_length(content_type) BETWEEN 1 AND 255)
);
CREATE INDEX file_object_by_scan ON files.file_object (workspace_id, scan_state, created_at);

-- ---------------------------------------------------------------------------------------------
-- Files and immutable versions (FILE-001, FILE-003, FILE-004, FILE-005)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE files.file (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  host_kind text NOT NULL,
  host_record_id uuid,
  comment_id uuid,
  name text NOT NULL,
  owner_membership_id uuid NOT NULL,
  source_kind text NOT NULL,
  current_version_id uuid,
  version_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT file_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT file_record_fkey FOREIGN KEY (workspace_id, id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT file_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT file_host_fkey FOREIGN KEY (workspace_id, host_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT file_comment_fkey FOREIGN KEY (workspace_id, comment_id)
    REFERENCES collab.comment (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT file_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT file_host_kind_known CHECK (host_kind IN ('workspace', 'brand', 'project', 'task', 'comment')),
  CONSTRAINT file_host_shape CHECK (
    (host_kind = 'workspace' AND host_record_id IS NULL AND brand_id IS NULL AND comment_id IS NULL)
    OR (host_kind = 'comment' AND host_record_id IS NOT NULL AND comment_id IS NOT NULL AND brand_id IS NOT NULL)
    OR (host_kind IN ('brand', 'project', 'task') AND host_record_id IS NOT NULL AND comment_id IS NULL
        AND brand_id IS NOT NULL)),
  CONSTRAINT file_scope_key CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT file_source_known CHECK (source_kind IN ('upload', 'external')),
  CONSTRAINT file_name_shape CHECK (char_length(name) BETWEEN 1 AND 255 AND name = btrim(name)
    AND name !~ '[[:cntrl:]/\\]'),
  CONSTRAINT file_counts CHECK (version_count >= 0 AND version >= 0)
);
CREATE INDEX file_by_host ON files.file (workspace_id, host_record_id, created_at, id);
CREATE INDEX file_by_comment ON files.file (workspace_id, comment_id);
CREATE INDEX file_by_brand ON files.file (workspace_id, brand_id);
CREATE INDEX file_by_owner ON files.file (workspace_id, owner_membership_id);
CREATE INDEX file_workspace_hosted ON files.file (workspace_id, created_at, id) WHERE host_kind = 'workspace';

CREATE TABLE files.file_version (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  file_id uuid NOT NULL,
  version_number integer NOT NULL,
  file_object_id uuid,
  external_url text,
  name text NOT NULL,
  content_type text,
  byte_size bigint,
  sha256 bytea,
  preview_state text NOT NULL,
  evidence_locked boolean NOT NULL DEFAULT false,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_version_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT file_version_number_unique UNIQUE (workspace_id, file_id, version_number),
  CONSTRAINT file_version_file_fkey FOREIGN KEY (workspace_id, file_id)
    REFERENCES files.file (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT file_version_object_fkey FOREIGN KEY (workspace_id, file_object_id)
    REFERENCES files.file_object (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT file_version_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT file_version_source_shape CHECK (
    (file_object_id IS NOT NULL AND external_url IS NULL AND byte_size IS NOT NULL AND sha256 IS NOT NULL
      AND content_type IS NOT NULL)
    OR (file_object_id IS NULL AND external_url IS NOT NULL AND byte_size IS NULL AND sha256 IS NULL)),
  CONSTRAINT file_version_url_shape CHECK (external_url IS NULL
    OR (char_length(external_url) <= 2048 AND external_url ~ '^https?://[^[:space:][:cntrl:]]+$')),
  CONSTRAINT file_version_preview_known CHECK (preview_state IN ('pending', 'ready', 'unsupported', 'failed')),
  CONSTRAINT file_version_number_positive CHECK (version_number >= 1),
  CONSTRAINT file_version_name_shape CHECK (char_length(name) BETWEEN 1 AND 255)
);
CREATE INDEX file_version_by_object ON files.file_version (workspace_id, file_object_id);
CREATE INDEX file_version_by_creator ON files.file_version (workspace_id, created_by_membership_id);

ALTER TABLE files.file ADD CONSTRAINT file_current_version_fkey FOREIGN KEY (workspace_id, current_version_id)
  REFERENCES files.file_version (workspace_id, id) ON DELETE RESTRICT;
CREATE INDEX file_by_current_version ON files.file (workspace_id, current_version_id);

-- Versions are immutable; only the evidence lock may be set (never cleared) by the application.
CREATE FUNCTION files.file_version_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.file_id IS DISTINCT FROM OLD.file_id
     OR NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.file_object_id IS DISTINCT FROM OLD.file_object_id
     OR NEW.external_url IS DISTINCT FROM OLD.external_url OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.content_type IS DISTINCT FROM OLD.content_type OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR (OLD.evidence_locked AND NOT NEW.evidence_locked) THEN
    RAISE EXCEPTION 'file versions are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_version_guard BEFORE UPDATE ON files.file_version
  FOR EACH ROW EXECUTE FUNCTION files.file_version_guard();

-- ---------------------------------------------------------------------------------------------
-- Upload sessions (0D §15.1; FILE-001, FILE-010, FILE-011)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE files.upload_session (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  host_kind text NOT NULL,
  host_record_id uuid,
  comment_id uuid,
  target_file_id uuid,
  file_name text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  sha256 bytea NOT NULL,
  state text NOT NULL DEFAULT 'initiated',
  quarantine_object_key text NOT NULL UNIQUE,
  file_object_id uuid,
  file_version_id uuid,
  rejection_code text,
  expires_at timestamptz NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT upload_session_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT upload_session_public_id_format CHECK (public_id ~ '^upl_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT upload_session_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT upload_session_host_fkey FOREIGN KEY (workspace_id, host_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT upload_session_comment_fkey FOREIGN KEY (workspace_id, comment_id)
    REFERENCES collab.comment (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT upload_session_target_fkey FOREIGN KEY (workspace_id, target_file_id)
    REFERENCES files.file (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT upload_session_object_fkey FOREIGN KEY (workspace_id, file_object_id)
    REFERENCES files.file_object (workspace_id, id) ON DELETE SET NULL (file_object_id),
  CONSTRAINT upload_session_version_fkey FOREIGN KEY (workspace_id, file_version_id)
    REFERENCES files.file_version (workspace_id, id) ON DELETE SET NULL (file_version_id),
  CONSTRAINT upload_session_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT upload_session_host_kind_known CHECK (host_kind IN ('workspace', 'brand', 'project', 'task', 'comment')),
  CONSTRAINT upload_session_state_known CHECK (state IN
    ('initiated', 'uploaded', 'verifying', 'completed', 'rejected', 'expired')),
  CONSTRAINT upload_session_rejection_shape CHECK ((state = 'rejected') = (rejection_code IS NOT NULL)),
  CONSTRAINT upload_session_rejection_known CHECK (rejection_code IS NULL OR rejection_code IN
    ('checksum_mismatch', 'size_mismatch', 'type_mismatch', 'missing_object', 'infected', 'scan_failed',
     'quota_exceeded', 'host_gone')),
  -- A version only on a completed session (purge may later remove the version it produced).
  CONSTRAINT upload_session_completed_shape CHECK (state = 'completed' OR file_version_id IS NULL),
  CONSTRAINT upload_session_key_shape CHECK (quarantine_object_key ~ '^q\.[0-9a-f]{64}$'),
  CONSTRAINT upload_session_sha256_length CHECK (octet_length(sha256) = 32),
  CONSTRAINT upload_session_size CHECK (byte_size >= 0),
  CONSTRAINT upload_session_name_shape CHECK (char_length(file_name) BETWEEN 1 AND 255),
  CONSTRAINT upload_session_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX upload_session_by_state ON files.upload_session (workspace_id, state, expires_at);
CREATE INDEX upload_session_by_brand ON files.upload_session (workspace_id, brand_id);
CREATE INDEX upload_session_by_host ON files.upload_session (workspace_id, host_record_id);
CREATE INDEX upload_session_by_comment ON files.upload_session (workspace_id, comment_id);
CREATE INDEX upload_session_by_target ON files.upload_session (workspace_id, target_file_id);
CREATE INDEX upload_session_by_object ON files.upload_session (workspace_id, file_object_id);
CREATE INDEX upload_session_by_version ON files.upload_session (workspace_id, file_version_id);
CREATE INDEX upload_session_by_creator ON files.upload_session (workspace_id, created_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Deliverables (FILE-006, FILE-007, FILE-008, FILE-009, PRJ-023, TSK-022)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE files.deliverable (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  task_id uuid NOT NULL,
  title text NOT NULL,
  expected_type text NOT NULL DEFAULT 'any',
  state text NOT NULL DEFAULT 'draft',
  current_version_id uuid,
  accepted_version_id uuid,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT deliverable_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT deliverable_record_fkey FOREIGN KEY (workspace_id, id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT deliverable_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT deliverable_task_fkey FOREIGN KEY (workspace_id, task_id)
    REFERENCES work.task (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT deliverable_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT deliverable_expected_known CHECK (expected_type IN ('any', 'file', 'url')),
  CONSTRAINT deliverable_state_known CHECK (state IN
    ('draft', 'ready_for_review', 'changes_requested', 'accepted', 'rejected')),
  CONSTRAINT deliverable_accepted_shape CHECK ((state = 'accepted') = (accepted_version_id IS NOT NULL)),
  CONSTRAINT deliverable_title_shape CHECK (char_length(title) BETWEEN 1 AND 200 AND title = btrim(title)),
  CONSTRAINT deliverable_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX deliverable_by_task ON files.deliverable (workspace_id, task_id, created_at, id);
CREATE INDEX deliverable_by_brand_state ON files.deliverable (workspace_id, brand_id, state);
CREATE INDEX deliverable_by_creator ON files.deliverable (workspace_id, created_by_membership_id);

-- Acceptance evidence names the 4A decision inside the same workspace.
ALTER TABLE collab.review_decision ADD CONSTRAINT review_decision_workspace_key UNIQUE (workspace_id, id);

CREATE TABLE files.deliverable_version (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  deliverable_id uuid NOT NULL,
  version_number integer NOT NULL,
  source_kind text NOT NULL,
  file_version_id uuid,
  url text,
  content_sha256 bytea,
  note_text text,
  state text NOT NULL DEFAULT 'draft',
  review_request_id uuid,
  decided_review_decision_id uuid,
  accepted_by_membership_id uuid,
  accepted_at timestamptz,
  evidence_locked boolean NOT NULL DEFAULT false,
  submitted_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deliverable_version_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT deliverable_version_number_unique UNIQUE (workspace_id, deliverable_id, version_number),
  CONSTRAINT deliverable_version_deliverable_fkey FOREIGN KEY (workspace_id, deliverable_id)
    REFERENCES files.deliverable (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT deliverable_version_file_fkey FOREIGN KEY (workspace_id, file_version_id)
    REFERENCES files.file_version (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT deliverable_version_review_fkey FOREIGN KEY (workspace_id, review_request_id)
    REFERENCES collab.review_request (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT deliverable_version_decision_fkey FOREIGN KEY (workspace_id, decided_review_decision_id)
    REFERENCES collab.review_decision (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT deliverable_version_acceptor_fkey FOREIGN KEY (workspace_id, accepted_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT deliverable_version_submitter_fkey FOREIGN KEY (workspace_id, submitted_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT deliverable_version_source_known CHECK (source_kind IN ('file', 'url')),
  CONSTRAINT deliverable_version_source_shape CHECK (
    (source_kind = 'file' AND file_version_id IS NOT NULL AND url IS NULL)
    OR (source_kind = 'url' AND file_version_id IS NULL AND url IS NOT NULL)),
  CONSTRAINT deliverable_version_url_shape CHECK (url IS NULL
    OR (char_length(url) <= 2048 AND url ~ '^https?://[^[:space:][:cntrl:]]+$')),
  CONSTRAINT deliverable_version_state_known CHECK (state IN
    ('draft', 'ready_for_review', 'changes_requested', 'accepted', 'rejected', 'withdrawn', 'superseded')),
  CONSTRAINT deliverable_version_accepted_shape CHECK (
    (state = 'accepted') = (accepted_at IS NOT NULL AND accepted_by_membership_id IS NOT NULL
      AND decided_review_decision_id IS NOT NULL AND evidence_locked)),
  CONSTRAINT deliverable_version_sha256_length CHECK (content_sha256 IS NULL OR octet_length(content_sha256) = 32),
  CONSTRAINT deliverable_version_note CHECK (note_text IS NULL
    OR (char_length(btrim(note_text)) BETWEEN 1 AND 2000 AND note_text = btrim(note_text))),
  CONSTRAINT deliverable_version_number_positive CHECK (version_number >= 1)
);
CREATE INDEX deliverable_version_by_file ON files.deliverable_version (workspace_id, file_version_id);
CREATE INDEX deliverable_version_by_review ON files.deliverable_version (workspace_id, review_request_id);
CREATE INDEX deliverable_version_by_decision ON files.deliverable_version (workspace_id, decided_review_decision_id);
CREATE INDEX deliverable_version_by_acceptor ON files.deliverable_version (workspace_id, accepted_by_membership_id);
CREATE INDEX deliverable_version_by_submitter ON files.deliverable_version (workspace_id, submitted_by_membership_id);

ALTER TABLE files.deliverable ADD CONSTRAINT deliverable_current_version_fkey
  FOREIGN KEY (workspace_id, current_version_id)
  REFERENCES files.deliverable_version (workspace_id, id) ON DELETE RESTRICT;
ALTER TABLE files.deliverable ADD CONSTRAINT deliverable_accepted_version_fkey
  FOREIGN KEY (workspace_id, accepted_version_id)
  REFERENCES files.deliverable_version (workspace_id, id) ON DELETE RESTRICT;
CREATE INDEX deliverable_by_current_version ON files.deliverable (workspace_id, current_version_id);
CREATE INDEX deliverable_by_accepted_version ON files.deliverable (workspace_id, accepted_version_id);

-- Evidence lock (FILE-009): an accepted version never changes; only purge removes it.
CREATE FUNCTION files.deliverable_version_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.evidence_locked THEN
    RAISE EXCEPTION 'deliverable version is evidence-locked' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.deliverable_id IS DISTINCT FROM OLD.deliverable_id
     OR NEW.version_number IS DISTINCT FROM OLD.version_number OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.file_version_id IS DISTINCT FROM OLD.file_version_id OR NEW.url IS DISTINCT FROM OLD.url
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.submitted_by_membership_id IS DISTINCT FROM OLD.submitted_by_membership_id THEN
    RAISE EXCEPTION 'deliverable version content is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deliverable_version_guard BEFORE UPDATE ON files.deliverable_version
  FOR EACH ROW EXECUTE FUNCTION files.deliverable_version_guard();

-- Deliverable versions are review subjects through their deliverable (4A).
ALTER TABLE collab.review_request DROP CONSTRAINT review_request_subject_known;
ALTER TABLE collab.review_request ADD CONSTRAINT review_request_subject_known
  CHECK (subject_kind IN ('task', 'project', 'document', 'deliverable'));

-- ---------------------------------------------------------------------------------------------
-- Storage usage (FILE-010): committed bytes plus bytes reserved by open upload sessions.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE files.storage_usage (
  workspace_id uuid PRIMARY KEY REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  used_bytes bigint NOT NULL DEFAULT 0,
  reserved_bytes bigint NOT NULL DEFAULT 0,
  object_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storage_usage_nonnegative CHECK (used_bytes >= 0 AND reserved_bytes >= 0 AND object_count >= 0)
);

-- ---------------------------------------------------------------------------------------------
-- Worker discovery: expired upload sessions and object deletions recorded by purge (lifecycle
-- effects keyed `object:{storage key}`); scans are enqueued by upload completion.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON files.upload_session FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, state, expires_at) ON files.upload_session TO pm_scheduler;
GRANT USAGE ON SCHEMA files TO pm_scheduler;
CREATE POLICY scheduler_object_effects ON exec.external_effect FOR SELECT TO pm_scheduler
  USING (effect_key LIKE 'object:%');
GRANT SELECT (workspace_id, effect_key, state, created_at) ON exec.external_effect TO pm_scheduler;

CREATE FUNCTION exec_dispatch.discover_file_work(p_now timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.workspace_id FROM (
    SELECT s.workspace_id, min(s.expires_at) AS due FROM files.upload_session s
     WHERE s.state IN ('initiated', 'uploaded') AND s.expires_at <= p_now
     GROUP BY s.workspace_id
    UNION ALL
    SELECT e.workspace_id, min(e.created_at) FROM exec.external_effect e
     WHERE e.effect_key LIKE 'object:%' AND e.state IN ('pending', 'failed')
     GROUP BY e.workspace_id
  ) w
  GROUP BY w.workspace_id
  ORDER BY min(w.due), w.workspace_id
  LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_file_work(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_file_work(timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_file_work(timestamptz, integer) OWNER TO pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE files.file_object ENABLE ROW LEVEL SECURITY;
ALTER TABLE files.file_object FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON files.file_object
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE files.file ENABLE ROW LEVEL SECURITY;
ALTER TABLE files.file FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON files.file
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE files.file_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE files.file_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON files.file_version
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE files.upload_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE files.upload_session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON files.upload_session
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE files.deliverable ENABLE ROW LEVEL SECURITY;
ALTER TABLE files.deliverable FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON files.deliverable
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE files.deliverable_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE files.deliverable_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON files.deliverable_version
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE files.storage_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE files.storage_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON files.storage_usage
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON files.file_object, files.file, files.file_version, files.upload_session, files.deliverable,
  files.deliverable_version, files.storage_usage FROM PUBLIC;
GRANT SELECT ON files.file_object, files.file, files.file_version, files.upload_session, files.deliverable,
  files.deliverable_version, files.storage_usage TO app_rw;
-- The application records sessions, files, versions, and deliverables; objects change scan state
-- and leave quarantine only in the worker.
GRANT INSERT ON files.file_object, files.file, files.file_version, files.upload_session, files.deliverable,
  files.deliverable_version, files.storage_usage TO app_rw;
GRANT UPDATE (name, current_version_id, version_count, updated_at, version) ON files.file TO app_rw;
GRANT UPDATE (evidence_locked, preview_state) ON files.file_version TO app_rw;
GRANT UPDATE (state, file_object_id, file_version_id, rejection_code, updated_at, version)
  ON files.upload_session TO app_rw;
GRANT UPDATE (title, expected_type, state, current_version_id, accepted_version_id, updated_at, version)
  ON files.deliverable TO app_rw;
GRANT UPDATE (state, review_request_id, decided_review_decision_id, accepted_by_membership_id, accepted_at,
  evidence_locked, updated_at) ON files.deliverable_version TO app_rw;
GRANT UPDATE (used_bytes, reserved_bytes, object_count, updated_at) ON files.storage_usage TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON files.file_object, files.file, files.file_version, files.upload_session,
  files.deliverable, files.deliverable_version, files.storage_usage TO app_worker;
